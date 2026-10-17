/**
 * LinkSwift for Chrome —— GM_* 兼容层（MAIN world）
 *
 * 在真正的 LinkSwift 脚本之前执行，把 userscript 依赖的 Greasemonkey API 补出来，
 * 让原脚本**一行不改**就能跑。
 *
 * 为什么必须在 MAIN world：
 *   LinkSwift 大量用 unsafeWindow 读取页面自身的 JS 变量（百度的 locals、
 *   夸克的 factStat 等），这些只存在于 MAIN world。而 MV3 的 world:"MAIN"
 *   内容脚本**拿不到任何 chrome.* API**，所以存储/剪贴板/跨域这些能力
 *   必须通过 window.postMessage 转发给 bridge.js（ISOLATED world）。
 *
 * 关键设计：
 *   1. 同步存储镜像 —— GM_getValue 在原脚本里是同步调用，而跨 world 通信是异步的，
 *      所以启动前先全量预取到 Map，之后读 Map、写 Map 并异步落盘；
 *      bridge 广播的 -store 事件会增量同步其它 frame 的写入。
 *   2. 请求双路径 —— GM_xmlhttpRequest 的回调是函数，无法跨 world 序列化：
 *      同源请求用页面 fetch 直发（拿得到流式进度）；
 *      跨域直链走 bridge→background 的 port 流式转发（同样有进度，见 C3 修复）。
 *      响应头到达即触发 onreadystatechange(readyState=2)，
 *      支持上游 base.head 的「拿响应头即 abort」快速路径（见 I2 修复）。
 *
 * 安全边界（重要）：
 *   本通道与页面脚本同 world，无法做密码学校验——页面脚本理论上能伪造/嗅探
 *   postMessage。唯一可信特权边界在 background 的 sender.origin 白名单校验，
 *   见 src/background.js 与 README「安全模型」。
 */

(() => {
	"use strict";

	const CHANNEL = "linkswift-gm";
	/* 上游元数据（版本/资源清单）。
	 *
	 * 为什么内联而不是读 src/meta.js：实测 Chrome 不会把同一文件同时注入
	 * ISOLATED 与 MAIN 两个 world 的 content_scripts 声明（ISOLATED 生效、
	 * MAIN 不生效），故 build.cjs 在构建时把 META 直接写进本文件。
	 *
	 * ↓ 下面 BEGIN/END 之间的内容由 build.cjs 自动生成，请勿手改 ↓ */
	const META = globalThis.__linkSwiftMeta || /* __LINKSWIFT_META_BEGIN__ */ {
	"version": "1.1.4",
	"resources": {
		"SwalLigt": "vendor/sweetalert2-light.min.css",
		"SwalDark": "vendor/sweetalert2-dark.min.css"
	},
	"origins": [
		"pan.baidu.com",
		"yun.baidu.com",
		"openapi.baidu.com",
		"www.aliyundrive.com",
		"www.alipan.com",
		"yun.139.com",
		"caiyun.139.com",
		"cloud.189.cn",
		"pan.xunlei.com",
		"www.guangyapan.com",
		"pan.quark.cn",
		"drive.uc.cn"
	],
	"suffixes": [
		"123pan.com",
		"123pan.cn",
		"123684.com",
		"123865.com",
		"123952.com",
		"123912.com"
	]
} /* __LINKSWIFT_META_END__ */

	/* ================================================================== *
	 * 1. 同步存储镜像
	 * ================================================================== */

	/** @type {Map<string, any>} */
	const store = new Map();

	/** 请求序号 -> { resolve, reject, timer } */
	const pending = new Map();
	let seq = 0;

	/**
	 * 发 RPC 到 ISOLATED world。
	 * @param {string} method
	 * @param {any[]} args
	 * @param {number} timeoutMs 0 表示不限时（流式下载可能很久）
	 */
	function call(method, args = [], timeoutMs = 15000) {
		const id = ++seq;
		const p = new Promise((resolve, reject) => {
			const entry = { resolve, reject, timer: null };
			if (timeoutMs > 0) {
				entry.timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error("[LinkSwift] RPC 超时：" + method));
				}, timeoutMs);
			}
			pending.set(id, entry);
			window.postMessage({ channel: CHANNEL, id, method, args }, "*");
		});
		return p;
	}

	/** 返回带 id 的 RPC（流式请求需要用 id 匹配进度事件） */
	function callWithId(method, args = [], timeoutMs = 0) {
		const id = ++seq;
		const p = new Promise((resolve, reject) => {
			const entry = { resolve, reject, timer: null };
			if (timeoutMs > 0) {
				entry.timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error("[LinkSwift] RPC 超时：" + method));
				}, timeoutMs);
			}
			pending.set(id, entry);
			window.postMessage({ channel: CHANNEL, id, method, args }, "*");
		});
		return { id, promise: p };
	}

	/** 监听 ISOLATED world 的回复 / 进度事件 / 菜单命令 / 存储同步 */
	window.addEventListener("message", (event) => {
		if (event.source !== window) return;
		const msg = event.data;
		if (!msg) return;

		// RPC 回复
		if (msg.channel === CHANNEL + "-reply" && typeof msg.id === "number") {
			const entry = pending.get(msg.id);
			if (!entry) return;
			pending.delete(msg.id);
			if (entry.timer) clearTimeout(entry.timer);
			if (msg.ok) entry.resolve(msg.value);
			else entry.reject(new Error(msg.error || "GM 调用失败"));
			return;
		}

		// 菜单命令回调
		if (msg.channel === CHANNEL + "-menu") {
			const fn = menuCallbacks[msg.index];
			if (typeof fn === "function") {
				try {
					fn();
				} catch (e) {
					console.error("[LinkSwift] 菜单命令执行失败：", e);
				}
			}
			return;
		}

		// 其它 frame 的存储变更同步（M8）
		if (msg.channel === CHANNEL + "-store" && msg.updates && typeof msg.updates === "object") {
			for (const [k, v] of Object.entries(msg.updates)) {
				if (v === undefined || v === null) store.delete(k);
				else store.set(k, v);
			}
		}
	});

	async function hydrateStore() {
		try {
			const all = await call("listValues", [], 10000);
			if (all && typeof all === "object") {
				for (const [k, v] of Object.entries(all)) store.set(k, v);
			}
		} catch (e) {
			console.warn("[LinkSwift] 存储预取失败，将使用空配置：", e);
		}
		// 兜底：上游 main.init() 末尾会同步读 setting_init.version（M9），
		// hydrate 失败时给它一个最小可用值，避免整个脚本静默死亡
		if (!store.has("setting_init")) {
			store.set("setting_init", { version: "0.0.0" });
		}
	}

	/* ================================================================== *
	 * 2. 存储 API（同步语义）
	 * ================================================================== */

	function GM_getValue(key, defaultValue) {
		if (store.has(key)) return store.get(key);
		return defaultValue;
	}

	function GM_setValue(key, value) {
		store.set(key, value);
		call("setValue", [key, value]).catch((e) => console.error("[LinkSwift] 保存失败：", e));
	}

	function GM_deleteValue(key) {
		store.delete(key);
		call("deleteValue", [key]).catch((e) => console.error("[LinkSwift] 删除失败：", e));
	}

	function GM_listValues() {
		return Array.from(store.keys());
	}

	function GM_setClipboard(text, info) {
		call("setClipboard", [text, info]).catch((e) =>
			console.error("[LinkSwift] 复制到剪贴板失败：", e)
		);
	}

	/**
	 * GM_openInTab(url, options)
	 * 统一经 background 的 chrome.tabs.create 打开（不受弹窗拦截约束，M7），
	 * options.active 透传（M5）。
	 */
	function GM_openInTab(url, options) {
		call("openInTab", [url, { active: !(options && options.active === false) }]).catch((e) =>
			console.error("[LinkSwift] 打开标签页失败：", e)
		);
		return null;
	}

	/* ================================================================== *
	 * 3. @resource 文本（从 meta 清单预载，不再硬编码资源名）
	 * ================================================================== */

	const resourceTexts = Object.create(null);

	function GM_getResourceText(name) {
		return resourceTexts[name] || "";
	}

	async function preloadResources() {
		for (const name of Object.keys(META.resources || {})) {
			try {
				resourceTexts[name] = (await call("getResourceText", [name], 10000)) || "";
			} catch {
				resourceTexts[name] = "";
				console.warn("[LinkSwift] 资源预载失败：", name);
			}
		}
	}

	/* ================================================================== *
	 * 4. 菜单命令
	 * ================================================================== */

	const menuCallbacks = [];
	const menuTitles = [];

	function GM_registerMenuCommand(title, fn) {
		menuCallbacks.push(fn);
		menuTitles.push(title);
		call("syncMenus", [menuTitles.slice()]).catch(() => {});
	}

	/** 供 bridge ping 查询：当前页面是否注册了菜单 */
	// （bridge 侧通过 syncMenus 已知菜单数量，无需额外查询）

	/* ================================================================== *
	 * 5. GM_xmlhttpRequest
	 * ================================================================== *
	 * 原脚本用到的特性：
	 *   - onloadstart / onprogress / onload / onerror / onabort 回调
	 *   - onreadystatechange 的 readyState===2（响应头到达，上游 base.head 的
	 *     「拿头即 abort」快速路径）与 ===4（完成）
	 *   - responseType: text | json | blob | arraybuffer
	 *   - 返回值上的 .abort() 与 .getAllResponseHeaders()
	 *   - res.responseHeaders（"Key: Value\r\n" 字符串）/
	 *     res.response / res.responseText / res.status / res.finalUrl
	 *   - onprogress 的 loaded 是**累计值**（上游做 delta 累加速度）
	 */

	/** 把 Headers 对象转成 GM 风格的 "Key: Value\r\n" 字符串 */
	function headersToString(headers) {
		const lines = [];
		try {
			headers.forEach((value, key) => lines.push(key + ": " + value));
		} catch {
			/* ignore */
		}
		return lines.join("\r\n");
	}

	/** 判断是否同源（同源请求直接用页面 fetch，最省事） */
	function isSameOrigin(url) {
		try {
			const u = new URL(url, location.href);
			return u.origin === location.origin;
		} catch {
			return false;
		}
	}

	function base64ToArrayBuffer(b64) {
		if (!b64) return new ArrayBuffer(0);
		const bin = atob(b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return bytes.buffer;
	}

	/**
	 * 本地直发（页面 fetch）。
	 * 关键时序：fetch 的 Promise 在**响应头到达时** resolve——先触发
	 * onreadystatechange(readyState=2)，再读 body。上游 base.head 在
	 * readyState 2 里调 request.abort()，会经 AbortController 取消 body 读取。
	 */
	async function requestLocal(details, signal, onProgress, handle) {
		const responseType = details.responseType || "text";
		const init = {
			method: (details.method || "GET").toUpperCase(),
			headers: details.headers || {},
			// GM 语义：anonymous=true 时不带凭据；上游所有调用点都传 anonymous:false
			credentials: details.anonymous ? "omit" : "include",
			signal,
		};
		if (details.data !== undefined && init.method !== "GET" && init.method !== "HEAD") {
			init.body = details.data;
		}

		const res = await fetch(details.url, init);

		const headerSnapshot = {
			readyState: 2,
			status: res.status,
			statusText: res.statusText,
			responseHeaders: headersToString(res.headers),
			response: "",
			responseText: "",
			finalUrl: res.url || details.url,
		};
		// 上游 base.head 的快速路径：readyState 2 时 abort 并 resolve
		try {
			details.onreadystatechange?.(headerSnapshot);
		} catch (e) {
			console.error("[LinkSwift] onreadystatechange 异常：", e);
		}
		if (handle.aborted) {
			const err = new Error("aborted");
			err.name = "AbortError";
			throw err;
		}

		const contentType = res.headers.get("content-type") || "";
		let response;
		let responseText;

		if (responseType === "arraybuffer" || responseType === "blob") {
			if (onProgress && res.body && res.body.getReader) {
				const total = parseInt(res.headers.get("content-length") || "0", 10);
				const reader = res.body.getReader();
				const chunks = [];
				let loaded = 0;
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					chunks.push(value);
					loaded += value.length;
					onProgress({ loaded, total: total || loaded, lengthComputable: total > 0 });
				}
				const merged = new Uint8Array(loaded);
				let offset = 0;
				for (const c of chunks) {
					merged.set(c, offset);
					offset += c.length;
				}
				if (responseType === "blob") {
					response = new Blob([merged], { type: contentType });
				} else {
					response = merged.buffer;
				}
			} else {
				const buf = await res.arrayBuffer();
				if (onProgress)
					onProgress({ loaded: buf.byteLength, total: buf.byteLength, lengthComputable: true });
				response = responseType === "blob" ? new Blob([buf], { type: contentType }) : buf;
			}
		} else {
			responseText = await res.text();
			if (responseType === "json") {
				try {
					response = JSON.parse(responseText);
				} catch {
					response = null;
				}
			} else {
				response = responseText;
			}
		}

		return {
			readyState: 4,
			status: res.status,
			statusText: res.statusText,
			responseHeaders: headerSnapshot.responseHeaders,
			responseText,
			response,
			finalUrl: headerSnapshot.finalUrl,
		};
	}

	/**
	 * 跨域路径：bridge → background 的 port 流式转发（C3 修复）。
	 * 经 -headers / -progress 事件拿响应头时机与进度，不再「一次性等完整响应」。
	 * 返回 { promise, abort } —— abort 经 bridge 断开 port，background 侧
	 * AbortController 随之中止，不再有「取消后后台仍完整下载」的问题（I1）。
	 */
	function requestViaBackground(details, onProgress) {
		let resolveFn;
		let rejectFn;
		const promise = new Promise((res, rej) => {
			resolveFn = res;
			rejectFn = rej;
		});

		// 只发可结构化克隆的字段（回调函数不能过 postMessage）
		const clean = {
			url: details.url,
			method: (details.method || "GET").toUpperCase(),
			headers: details.headers || {},
			data: typeof details.data === "string" ? details.data : undefined,
			responseType: details.responseType || "text",
		};

		const { id, promise: rpc } = callWithId("xmlHttpRequestStream", [clean], 0);

		const evtHandler = (event) => {
			if (event.source !== window) return;
			const msg = event.data;
			if (!msg) return;
			if (msg.id !== id) return;
			if (msg.channel === CHANNEL + "-progress") {
				onProgress?.({
					loaded: msg.loaded,
					total: msg.total,
					lengthComputable: msg.lengthComputable,
					readyState: 3,
					status: msg.status || 200,
				});
			} else if (msg.channel === CHANNEL + "-headers") {
				try {
					details.onreadystatechange?.({
						readyState: 2,
						status: msg.status,
						statusText: msg.statusText,
						responseHeaders: msg.responseHeaders || "",
						response: "",
						responseText: "",
						finalUrl: msg.finalUrl,
					});
				} catch (e) {
					console.error("[LinkSwift] onreadystatechange 异常：", e);
				}
			}
		};
		window.addEventListener("message", evtHandler);

		rpc
			.then((data) => {
				window.removeEventListener("message", evtHandler);
				resolveFn(assembleBackgroundResponse(details, data));
			})
			.catch((e) => {
				window.removeEventListener("message", evtHandler);
				rejectFn(e);
			});

		return {
			promise,
			abort() {
				call("abortStream", [id]).catch(() => {});
			},
		};
	}

	/** 把 background 回传的纯数据组装成 GM 响应对象 */
	function assembleBackgroundResponse(details, d) {
		if (!d) throw new Error("后台请求失败");
		const out = {
			readyState: 4,
			status: d.status,
			statusText: d.statusText,
			responseHeaders: d.responseHeaders || "",
			responseText: d.responseText,
			response: undefined,
			finalUrl: d.finalUrl || details.url,
		};

		const rt = details.responseType || "text";
		if (rt === "json") {
			try {
				out.response = JSON.parse(d.responseText);
			} catch {
				out.response = null;
			}
		} else if (rt === "arraybuffer") {
			out.response = base64ToArrayBuffer(d.responseBase64 || "");
		} else if (rt === "blob") {
			out.response = new Blob([base64ToArrayBuffer(d.responseBase64 || "")], {
				type: d.contentType || "application/octet-stream",
			});
		} else {
			out.response = d.responseText;
		}
		return out;
	}

	function GM_xmlhttpRequest(details) {
		const controller = new AbortController();
		// 保存最近一次响应头，供 getAllResponseHeaders() 兜底读取
		let lastResponseHeaders = "";
		// background 流式路径的 abort 句柄（启动后赋值）
		let bgAbort = null;

		const handle = {
			aborted: false,
			readyState: 0,
			abort() {
				this.aborted = true;
				if (bgAbort) bgAbort();
				try {
					controller.abort();
				} catch {
					/* ignore */
				}
			},
			getAllResponseHeaders() {
				return lastResponseHeaders;
			},
		};

		let timeoutTimer;
		if (details.timeout > 0) {
			timeoutTimer = setTimeout(() => handle.abort(), details.timeout);
		}

		const onProgress = (p) => {
			if (handle.aborted) return;
			try {
				details.onprogress?.({
					loaded: p.loaded,
					total: p.total,
					lengthComputable: p.lengthComputable,
					readyState: 3,
					status: p.status || 200,
				});
			} catch (e) {
				console.error("[LinkSwift] onprogress 异常：", e);
			}
		};

		(async () => {
			try {
				details.onloadstart?.({ readyState: 1, status: 0, statusText: "" });

				let res;
				if (isSameOrigin(details.url)) {
					try {
						res = await requestLocal(details, controller.signal, onProgress, handle);
					} catch (e) {
						// 用户主动取消：绝不回退后台重下（I1 修复）
						if (handle.aborted) throw e;
						// 同源但失败（少见），再试后台
						const bg = requestViaBackground(details, onProgress);
						bgAbort = bg.abort;
						res = await bg.promise;
					}
				} else {
					// 跨域：先试页面 fetch（有些站点已配好 CORS），失败再走后台
					try {
						res = await requestLocal(details, controller.signal, onProgress, handle);
					} catch (e) {
						if (handle.aborted) throw e;
						const bg = requestViaBackground(details, onProgress);
						bgAbort = bg.abort;
						res = await bg.promise;
					}
				}

				if (handle.aborted) {
					details.onabort?.({ readyState: 4, status: 0, statusText: "abort" });
					return;
				}

				handle.readyState = 4;
				lastResponseHeaders = res.responseHeaders || "";
				details.onreadystatechange?.(res);
				details.onload?.(res);
			} catch (e) {
				if (handle.aborted) {
					details.onabort?.({ readyState: 4, status: 0, statusText: "abort" });
					return;
				}
				console.error("[LinkSwift] 请求失败：", details.url, e);
				try {
					details.onerror?.({ error: e.message || String(e), status: 0, statusText: "error" });
				} catch (err) {
					console.error("[LinkSwift] onerror 异常：", err);
				}
			} finally {
				if (timeoutTimer) clearTimeout(timeoutTimer);
			}
		})();

		return handle;
	}

	/* ================================================================== *
	 * 6. GM_info（版本来自构建生成的 meta，与上游/manifest 三处一致，I5 修复）
	 * ================================================================== */

	const GM_info = {
		script: {
			name: "LinkSwift",
			namespace: "github.com/hmjz100",
			version: META.version,
			description:
				"一个基于 JavaScript 的网盘文件下载地址获取工具，支持九大网盘（Chrome 扩展版）",
			author: "Hmjz100、油小猴",
			icon: "",
		},
		scriptHandler: "LinkSwift Chrome Extension",
		version: META.version,
	};

	/* ================================================================== *
	 * 7. 挂载到全局
	 * ================================================================== */

	// MAIN world 下 unsafeWindow 就是 window 自身
	if (typeof window.unsafeWindow === "undefined") window.unsafeWindow = window;

	window.GM_getValue = GM_getValue;
	window.GM_setValue = GM_setValue;
	window.GM_deleteValue = GM_deleteValue;
	window.GM_listValues = GM_listValues;
	window.GM_setClipboard = GM_setClipboard;
	window.GM_openInTab = GM_openInTab;
	window.GM_getResourceText = GM_getResourceText;
	window.GM_registerMenuCommand = GM_registerMenuCommand;
	window.GM_xmlhttpRequest = GM_xmlhttpRequest;
	window.GM_info = GM_info;

	window.GM = window.GM || {};
	window.GM.getValue = GM_getValue;
	window.GM.setValue = GM_setValue;
	window.GM.deleteValue = GM_deleteValue;
	window.GM.listValues = GM_listValues;
	window.GM.setClipboard = GM_setClipboard;
	window.GM.openInTab = GM_openInTab;
	window.GM.getResourceText = GM_getResourceText;
	window.GM.registerMenuCommand = GM_registerMenuCommand;
	window.GM.xmlHttpRequest = GM_xmlhttpRequest;
	window.GM.info = GM_info;

	/* ================================================================== *
	 * 8. 启动
	 * ================================================================== */

	window.__linkSwiftBootstrap = async () => {
		// 只允许启动一次（防止主脚本与兜底路径重复调用）
		if (window.__linkSwiftStarted) return;
		window.__linkSwiftStarted = true;

		await hydrateStore();
		await preloadResources();
		try {
			if (typeof window.__linkSwiftMain === "function") {
				window.__linkSwiftMain();
			} else {
				console.error("[LinkSwift] 主脚本未加载");
			}
		} catch (e) {
			console.error("[LinkSwift] 主脚本启动失败：", e);
		}
	};

	/*
	 * 启动顺序说明：
	 *   本文件与 linkswift.main.js 是 manifest 里**先后两个独立的脚本文件**。
	 *   Chrome 会在每个脚本执行完后跑一次微任务检查点，所以这里若用
	 *   `Promise.resolve().then(...)` 引导，微任务会在主脚本加载**之前**就执行，
	 *   此时 window.__linkSwiftMain 还不存在 —— 启动会静默失败。
	 *
	 *   因此由主脚本在末尾主动调用 window.__linkSwiftBootstrap()（见 build.cjs），
	 *   这里只保留一个兜底：若主脚本先于本文件执行（理论上不会），
	 *   则在定义完 bootstrap 后补一次调用。
	 */
	if (typeof window.__linkSwiftMain === "function") {
		window.__linkSwiftBootstrap();
	}
})();
