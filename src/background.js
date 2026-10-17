/**
 * LinkSwift for Chrome —— background service worker (MV3)
 *
 * 职责：
 *   1. 跨域流式 fetch 代理（content script 的 fetch 受页面 CORS 限制，
 *      这里持有 host_permissions 的完整网络权限；经 port 长连接逐块转发进度）；
 *   2. 打开标签页（不受弹窗拦截约束）；
 *   3. 右键菜单（removeAll + 全量重建，SW 重启也无状态残留）。
 *
 * ★ 安全模型（本扩展唯一的可信特权边界）：
 *   MAIN world 的 postMessage 通道与页面脚本同权，恶意脚本可以伪造 bridge 的
 *   RPC（比如让它带着用户 Cookie 请求任意网盘 API）。因此**所有来自 content
 *   script 的消息都要校验 sender.origin 命中网盘域名白名单**——白名单由
 *   build.cjs 从上游 @match 生成（src/meta.js）。网盘页面内的恶意脚本
 *   （XSS / 第三方脚本）仍在信任边界内，这是与 Tampermonkey 等脚本管理器
 *   相同的信任模型；但任意其它网站无法触达本层。
 */

/* ==================================================================== *
 * 0. 域名白名单（构建生成的 src/meta.js，service worker 里直接 import）
 * ==================================================================== */

import "./meta.js";

const META = globalThis.__linkSwiftMeta || { origins: [], suffixes: [] };

/** 校验消息来源是否在网盘域名白名单内 */
function isAllowedSender(sender) {
	if (!sender) return false;
	const origin = sender.origin || (sender.url ? safeOrigin(sender.url) : null);
	if (!origin) return false;
	if ((META.origins || []).includes(origin)) return true;
	const host = origin.replace(/^https?:\/\//, "");
	return (META.suffixes || []).some((suffix) => host === suffix || host.endsWith("." + suffix));
}

function safeOrigin(url) {
	try {
		return new URL(url).origin;
	} catch {
		return null;
	}
}

/* ==================================================================== *
 * 1. 流式跨域请求（port 协议）
 * ==================================================================== *
 * bridge 经 chrome.runtime.connect({name:"linkswift-fetch"}) 建立长连接：
 *   bridge -> bg   { type:"start", payload:{url,method,headers,body,responseType} }
 *   bg -> bridge   { type:"headers", status, statusText, responseHeaders, finalUrl, total }
 *                  { type:"progress", loaded, total, lengthComputable }
 *                  { type:"done", data:{status,statusText,responseHeaders,
 *                           responseText|responseBase64,contentType,finalUrl} }
 *                  { type:"error", error }
 * bridge 断开 port（用户 abort）→ bg 的 onDisconnect 触发 AbortController.abort()
 */

function arrayBufferToBase64(buf) {
	const bytes = new Uint8Array(buf);
	let binary = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

function headersToString(headers) {
	const lines = [];
	try {
		headers.forEach((value, key) => lines.push(key + ": " + value));
	} catch {
		/* ignore */
	}
	return lines.join("\r\n");
}

chrome.runtime.onConnect.addListener((port) => {
	if (port.name !== "linkswift-fetch") return;
	if (!isAllowedSender(port.sender)) {
		console.warn(
			"[LinkSwift/bg] 拒绝 fetch port：sender 不在白名单",
			"sender.origin =", port.sender?.origin,
			"sender.url =", port.sender?.url,
			"白名单 origins =", META.origins,
			"白名单 suffixes =", META.suffixes,
			"META 已加载 =", !!globalThis.__linkSwiftMeta
		);
		try {
			port.disconnect();
		} catch {
			/* ignore */
		}
		return;
	}
	port.onMessage.addListener((msg) => {
		if (!msg || msg.type !== "start") return;
		streamFetch(port, msg.payload || {}).catch((e) => {
			console.error("[LinkSwift/bg] streamFetch 异常：", e);
		});
	});
});

/** postMessage 包装：port 已断开时静默失败（abort 竞态） */
function post(port, msg) {
	try {
		port.postMessage(msg);
		return true;
	} catch {
		return false;
	}
}

async function streamFetch(port, payload) {
	const { url, method = "GET", headers = {}, body, responseType = "text" } = payload;

	const controller = new AbortController();
	// bridge 主动断开 = 用户 abort
	port.onDisconnect.addListener(() => controller.abort());

	const init = {
		method,
		headers: { ...headers },
		credentials: "include",
		redirect: "follow",
		signal: controller.signal,
	};

	// fetch 不允许设置 Referer 头，映射到 init.referrer（直链 CDN 有时校验它）
	if (init.headers["Referer"] || init.headers["referer"]) {
		init.referrer = init.headers["Referer"] || init.headers["referer"];
		delete init.headers["Referer"];
		delete init.headers["referer"];
	}

	if (body !== undefined && body !== null && method !== "GET" && method !== "HEAD") {
		init.body = typeof body === "string" ? body : JSON.stringify(body);
	}

	const response = await fetch(url, init);

	const total = parseInt(response.headers.get("content-length") || "0", 10);
	const headerInfo = {
		status: response.status,
		statusText: response.statusText,
		responseHeaders: headersToString(response.headers),
		contentType: response.headers.get("content-type") || "",
		finalUrl: response.url || url,
		total,
	};

	// 响应头事件（触发 MAIN world 的 onreadystatechange readyState=2，
	// 支持上游 base.head 的「拿头即 abort」快速路径）
	if (!post(port, { type: "headers", ...headerInfo })) return;

	const wantsBinary = responseType === "arraybuffer" || responseType === "blob";
	let loaded = 0;
	let lastPost = 0;
	const chunks = [];

	if (response.body && response.body.getReader) {
		const reader = response.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (wantsBinary) chunks.push(value);
			loaded += value.length;
			// 进度节流：100ms 一次，避免高频 postMessage 淹没通道
			const now = Date.now();
			if (now - lastPost > 100) {
				lastPost = now;
				if (!post(port, { type: "progress", loaded, total, lengthComputable: total > 0, status: response.status })) return;
			}
		}
	} else {
		// 无流式 body（如某些 204/HEAD）
		const buf = await response.arrayBuffer();
		loaded = buf.byteLength;
		if (wantsBinary) chunks.push(new Uint8Array(buf));
	}

	// 最终进度（保证 UI 能到满格）
	post(port, { type: "progress", loaded, total, lengthComputable: total > 0, status: response.status });

	const data = { ...headerInfo, responseText: "", responseBase64: "" };
	if (wantsBinary) {
		const merged = new Uint8Array(loaded);
		let offset = 0;
		for (const c of chunks) {
			merged.set(c, offset);
			offset += c.length;
		}
		data.responseBase64 = arrayBufferToBase64(merged.buffer);
	} else {
		// 用自己解码避免站点错误声明 charset 导致乱码
		let textBuf;
		if (chunks.length) {
			const merged = new Uint8Array(loaded);
			let offset = 0;
			for (const c of chunks) {
				merged.set(c, offset);
				offset += c.length;
			}
			textBuf = merged.buffer;
		} else {
			textBuf = new ArrayBuffer(0);
		}
		data.responseText = new TextDecoder("utf-8").decode(textBuf);
	}

	post(port, { type: "done", data });
}

/* ==================================================================== *
 * 2. 普通消息路由（均校验 sender 白名单）
 * ==================================================================== */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;

	// 特权边界：非网盘页面的消息一律拒答
	if (!isAllowedSender(sender)) {
		sendResponse({ ok: false, error: "sender not allowed" });
		return true;
	}

	if (msg.type === "linkswift:openTab") {
		const url = msg.payload && msg.payload.url;
		if (typeof url === "string" && /^https?:/i.test(url)) {
			chrome.tabs
				.create({ url, active: msg.payload.active !== false })
				.catch((e) => console.warn("[LinkSwift/bg] 打开标签页失败：", e));
		}
		sendResponse({ ok: true });
		return true;
	}

	if (msg.type === "linkswift:syncMenus") {
		syncMenus((msg.payload && msg.payload.menus) || []);
		sendResponse({ ok: true });
		return true;
	}

	if (msg.type === "linkswift:ping") {
		sendResponse({ ok: true });
		return true;
	}

	if (msg.type === "linkswift:pageReady") {
		sendResponse({ ok: true });
		return true;
	}
});

/* ==================================================================== *
 * 3. 右键菜单（removeAll + 全量重建，SW 重启无状态残留）
 * ==================================================================== */

let syncSeq = 0;

function syncMenus(menus) {
	const mySeq = ++syncSeq;
	// 先清空再重建：幂等、不怕 SW 重启、不怕菜单 id 冲突
	chrome.contextMenus.removeAll(() => {
		// 竞态保护：重建期间又来了新 sync，旧回调放弃
		if (mySeq !== syncSeq) return;

		if (!menus.length) return;
		chrome.contextMenus.create(
			{
				id: "linkswift-root",
				title: "LinkSwift",
				contexts: ["page", "frame", "selection", "link"],
			},
			() => void chrome.runtime.lastError
		);
		menus.forEach((title, index) => {
			chrome.contextMenus.create(
				{
					id: "linkswift-cmd-" + index,
					parentId: "linkswift-root",
					title: title || `命令 ${index + 1}`,
					contexts: ["page", "frame", "selection", "link"],
				},
				() => void chrome.runtime.lastError
			);
		});
	});
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
	if (typeof info.menuItemId !== "string" || !info.menuItemId.startsWith("linkswift-cmd-")) return;
	const index = parseInt(info.menuItemId.replace("linkswift-cmd-", ""), 10);
	if (!Number.isFinite(index)) return;
	if (typeof tab?.id !== "number") return;

	chrome.tabs
		.sendMessage(tab.id, { type: "linkswift:menuCommand", index }, { frameId: 0 })
		.catch((e) => console.warn("[LinkSwift/bg] 转发菜单命令失败：", e));
});

/* ==================================================================== *
 * 4. 生命周期
 * ==================================================================== */

chrome.runtime.onInstalled.addListener(() => {
	// 装载/更新时清掉旧菜单（页面重新 sync 前，菜单暂空）
	chrome.contextMenus.removeAll(() => {});
});

// 点击扩展图标：先 ping 判断页面是否注册了菜单（M4——
// 避免在「已注入但无菜单」的页面上静默无反应）
chrome.action.onClicked.addListener(async (tab) => {
	if (typeof tab?.id !== "number") return;
	try {
		const res = await chrome.tabs.sendMessage(tab.id, { type: "linkswift:ping" }, { frameId: 0 });
		if (res && res.ok && res.menus > 0) {
			await chrome.tabs.sendMessage(
				tab.id,
				{ type: "linkswift:menuCommand", index: 0 },
				{ frameId: 0 }
			);
			return;
		}
		// 已注入但无菜单（如非网盘功能页）——无操作是合理行为，不打扰
	} catch {
		// 页面没有注入（chrome:// 页、其它站点）——提示用户
		try {
			await chrome.scripting.executeScript({
				target: { tabId: tab.id },
				func: () => {
					alert("LinkSwift：请先打开受支持的网盘页面。");
				},
			});
		} catch {
			/* ignore */
		}
	}
});
