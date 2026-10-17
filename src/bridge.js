/**
 * LinkSwift for Chrome —— ISOLATED world 桥接层
 *
 * 在页面「隔离世界」中运行，独占扩展 API（chrome.storage / chrome.runtime /
 * 剪贴板 / 跨域请求），通过 window.postMessage 与 MAIN world 的 GM_* 兼容层通信。
 *
 * 为什么需要它：
 *   1. MV3 的 world:"MAIN" 内容脚本能直接访问页面对象（unsafeWindow / 页面 JS 变量），
 *      但**拿不到任何 chrome.* API**；
 *   2. GM_setValue 是**同步**语义，而 chrome.storage 是**异步**的。因此这里维护一份
 *      内存镜像，首次加载时从 storage 全量预取，之后 setValue 同步写镜像、异步落盘。
 *
 * 消息协议（MAIN -> ISOLATED）：
 *   请求   { channel: "linkswift-gm", id, method, args }
 *   回复   { channel: "linkswift-gm-reply", id, ok, value?, error? }
 *   推送   { channel: "linkswift-gm-progress" | "-headers", id, ... }   （流式请求）
 *          { channel: "linkswift-gm-store", updates }                    （存储同步）
 *   反向   { channel: "linkswift-gm-menu", index, title }                （菜单点击）
 *
 * 安全说明：
 *   本层与页面同 window，postMessage 无法区分消息来自 gm-shim 还是页面脚本——
 *   这是「MAIN world 与页面同权」的固有限制。缓解措施：
 *   - xmlHttpRequestStream 只接受 http/https URL；
 *   - 真正的特权边界在 background 的 sender.origin 白名单（见 src/background.js）。
 */

(() => {
	"use strict";

	// 防止同一 frame 被重复注入（扩展重载时）
	if (window.__linkswiftBridgeInstalled) return;
	window.__linkswiftBridgeInstalled = true;

	const NS = "linkswift";
	const CHANNEL = "linkswift-gm";
	const isTopFrame = window.top === window;
	/** 上游元数据（资源清单等），由 build.cjs 生成的 src/meta.js 提供 */
	const META = globalThis.__linkSwiftMeta || { resources: {} };

	/* ================================================================== *
	 * 1. 存储：内存镜像 + chrome.storage.local
	 * ================================================================== */

	/** @type {Map<string, any>} */
	const memory = new Map();
	/** 存储就绪前发生的写入 */
	const pendingWrites = new Map();
	let storageReady = false;
	let readyResolve;
	const readyPromise = new Promise((r) => (readyResolve = r));

	async function hydrate() {
		try {
			const all = await chrome.storage.local.get(null);
			for (const [key, value] of Object.entries(all)) {
				if (key.startsWith(NS + ":")) memory.set(key.slice(NS.length + 1), value);
			}
		} catch (e) {
			console.error("[LinkSwift/bridge] 读取存储失败：", e);
		}
		// 预取期间产生的写入优先级更高
		for (const [k, v] of pendingWrites) memory.set(k, v);
		pendingWrites.clear();
		storageReady = true;
		readyResolve();
	}

	hydrate();

	function persist(key) {
		const storageKey = NS + ":" + key;
		try {
			if (memory.has(key)) {
				chrome.storage.local.set({ [storageKey]: memory.get(key) }).catch((e) => {
					console.error("[LinkSwift/bridge] 写入存储失败：", key, e);
				});
			} else {
				chrome.storage.local.remove(storageKey).catch(() => {});
			}
		} catch (e) {
			console.error("[LinkSwift/bridge] 写入存储异常：", key, e);
		}
	}

	/** 存储变更广播：其它 frame 写入时，本 frame 的 MAIN world 镜像同步更新（M8） */
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== "local") return;
		const updates = {};
		for (const [k, change] of Object.entries(changes)) {
			if (!k.startsWith(NS + ":")) continue;
			const shortKey = k.slice(NS.length + 1);
			memory.set(shortKey, change.newValue);
			updates[shortKey] = change.newValue;
		}
		if (Object.keys(updates).length > 0) {
			window.postMessage({ channel: CHANNEL + "-store", updates }, "*");
		}
	});

	/* ================================================================== *
	 * 2. 剪贴板
	 * ================================================================== */

	async function writeClipboard(text) {
		text = typeof text === "string" ? text : String(text);
		// 优先扩展 API（不受「必须用户手势」限制）
		try {
			if (navigator.clipboard && navigator.clipboard.writeText) {
				await navigator.clipboard.writeText(text);
				return true;
			}
		} catch {
			/* 回退 */
		}
		try {
			const ta = document.createElement("textarea");
			ta.value = text;
			ta.setAttribute("readonly", "");
			ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0;";
			(document.body || document.documentElement).appendChild(ta);
			ta.select();
			ta.setSelectionRange(0, ta.value.length);
			const ok = document.execCommand("copy");
			ta.remove();
			return ok;
		} catch (e) {
			console.error("[LinkSwift/bridge] 复制失败：", e);
			return false;
		}
	}

	/* ================================================================== *
	 * 3. 跨域流式请求（bridge → background 的 port 长连接，C3 修复）
	 * ================================================================== *
	 * GM_xmlhttpRequest 的回调是函数，不能跨 world 序列化，所以：
	 *   - 进度/响应头事件由 bridge 以 -progress / -headers postMessage 推回 MAIN；
	 *   - 最终结果经正常 RPC 回复（-reply）返回；
	 *   - abortStream 断开 port，background 侧 AbortController 随之中止。
	 */

	/** RPC id -> 进行中的 port（用于 abort） */
	const streamPorts = new Map();

	function safeUrl(url) {
		if (typeof url !== "string") return null;
		try {
			const u = new URL(url, location.href);
			if (u.protocol !== "http:" && u.protocol !== "https:") return null;
			return u.href;
		} catch {
			return null;
		}
	}

	function startStreamRequest(id, details) {
		const url = safeUrl(details.url);
		if (!url) {
			window.postMessage(
				{ channel: CHANNEL + "-reply", id, ok: false, error: "非法 URL（仅支持 http/https）" },
				"*"
			);
			return;
		}

		const port = chrome.runtime.connect({ name: "linkswift-fetch" });
		let settled = false;

		const finish = (ok, value, error) => {
			if (settled) return;
			settled = true;
			streamPorts.delete(id);
			try {
				port.disconnect();
			} catch {
				/* ignore */
			}
			window.postMessage({ channel: CHANNEL + "-reply", id, ok, value, error }, "*");
		};

		port.onDisconnect.addListener(() => {
			// 正常 finish 后的 disconnect 无需处理；未完成即断开 = 出错或被 abort
			finish(false, undefined, "aborted");
		});

		port.onMessage.addListener((msg) => {
			if (!msg || typeof msg !== "object") return;
			switch (msg.type) {
				case "headers":
					window.postMessage(
						{
							channel: CHANNEL + "-headers",
							id,
							status: msg.status,
							statusText: msg.statusText,
							responseHeaders: msg.responseHeaders,
							finalUrl: msg.finalUrl,
						},
						"*"
					);
					break;
				case "progress":
					window.postMessage(
						{
							channel: CHANNEL + "-progress",
							id,
							loaded: msg.loaded,
							total: msg.total,
							lengthComputable: msg.lengthComputable,
							status: msg.status,
						},
						"*"
					);
					break;
				case "done":
					finish(true, msg.data);
					break;
				case "error":
					finish(false, undefined, msg.error || "后台请求失败");
					break;
			}
		});

		streamPorts.set(id, port);

		port.postMessage({
			type: "start",
			payload: {
				url,
				method: details.method || "GET",
				headers: details.headers || {},
				body: details.data,
				responseType: details.responseType || "text",
			},
		});
	}

	function abortStreamRequest(id) {
		const port = streamPorts.get(id);
		if (!port) return;
		streamPorts.delete(id);
		try {
			port.disconnect();
		} catch {
			/* ignore */
		}
		// background 的 port.onDisconnect 会触发 AbortController.abort()
	}

	/* ================================================================== *
	 * 4. 资源文本（@resource，清单来自构建生成的 meta）
	 * ================================================================== */

	const resourceCache = new Map();

	async function getResourceText(name) {
		if (resourceCache.has(name)) return resourceCache.get(name);
		const rel = (META.resources || {})[name];
		if (!rel) return "";
		try {
			const url = chrome.runtime.getURL(rel);
			const text = await (await fetch(url)).text();
			resourceCache.set(name, text);
			return text;
		} catch (e) {
			console.error("[LinkSwift/bridge] 读取资源失败：", name, e);
			return "";
		}
	}

	/* ================================================================== *
	 * 5. 消息处理（MAIN world 的 RPC）
	 * ================================================================== */

	let menuTitles = [];

	window.addEventListener("message", async (event) => {
		if (event.source !== window) return;
		const msg = event.data;
		if (!msg || msg.channel !== CHANNEL || typeof msg.id !== "number") return;

		const { id, method, args = [] } = msg;
		let ok = true;
		let value;
		let error;

		try {
			switch (method) {
				case "listValues":
					await readyPromise;
					value = Object.fromEntries(memory);
					break;

				case "getValue":
					await readyPromise;
					value = memory.has(args[0]) ? memory.get(args[0]) : args[1];
					break;

				case "setValue":
					await readyPromise;
					memory.set(args[0], args[1]);
					persist(args[0]);
					break;

				case "deleteValue":
					await readyPromise;
					memory.delete(args[0]);
					persist(args[0]);
					break;

				case "setClipboard":
					value = await writeClipboard(args[0]);
					break;

				case "openInTab":
					// 统一走 background 的 chrome.tabs.create（不受弹窗拦截约束）
					await chrome.runtime.sendMessage({
						type: "linkswift:openTab",
						payload: { url: args[0], active: !!(args[1] && args[1].active) },
					});
					value = true;
					break;

				case "xmlHttpRequestStream":
					startStreamRequest(id, args[0] || {});
					// 该方法由 finish() 异步回复，这里直接返回不重复回执
					return;

				case "abortStream":
					abortStreamRequest(args[0]);
					value = true;
					break;

				case "getResourceText":
					value = await getResourceText(args[0]);
					break;

				case "syncMenus":
					menuTitles = Array.isArray(args[0]) ? args[0] : [];
					if (isTopFrame) {
						chrome.runtime
							.sendMessage({ type: "linkswift:syncMenus", payload: { menus: menuTitles } })
							.catch(() => {});
					}
					break;

				default:
					ok = false;
					error = "未知方法：" + method;
			}
		} catch (e) {
			ok = false;
			error = (e && (e.stack || e.message)) || String(e);
		}

		window.postMessage({ channel: CHANNEL + "-reply", id, ok, value, error }, "*");
	});

	/* ================================================================== *
	 * 6. 来自 background 的消息（菜单点击 / ping）
	 * ================================================================== */

	chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
		if (!msg || typeof msg !== "object") return;

		if (msg.type === "linkswift:menuCommand") {
			window.postMessage({ channel: CHANNEL + "-menu", index: msg.index, title: msg.title }, "*");
			sendResponse({ ok: true });
			return true;
		}

		if (msg.type === "linkswift:ping") {
			sendResponse({ ok: true, menus: menuTitles.length, top: isTopFrame });
			return true;
		}
	});
})();
