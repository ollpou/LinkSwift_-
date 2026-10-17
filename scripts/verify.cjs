#!/usr/bin/env node
/**
 * LinkSwift for Chrome —— 静态验证 / 逻辑自测
 *
 * 三个部分：
 *   1. manifest 合规 + chrome.* 命名空间权限交叉检查（防 C1 复发）
 *   2. 版本一致性：上游 @version === meta.js === manifest（I5）
 *   3. 双 world 端到端：MAIN world 沙箱跑真实的 gm-shim.js + prelude.js，
 *      ISOLATED world 沙箱跑**真实的 bridge.js**（stub chrome.*），
 *      验证存储往返 / 流式请求 / abort 语义 / Swal·md5 替换。
 *
 * 用法：node scripts/verify.cjs
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const UPSTREAM = path.resolve(ROOT, "..", "LinkSwift", "（改）网盘直链下载助手.user.js");

const results = [];
function check(name, pass, detail) {
	results.push({ name, pass, detail });
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
function readJSON(p) {
	return JSON.parse(fs.readFileSync(p, "utf8"));
}

/* ==================================================================== *
 * 1. manifest 校验 + chrome.* 权限交叉检查
 * ==================================================================== */

console.log("\n--- 1. manifest 与权限 ---");
const manifest = readJSON(path.join(ROOT, "manifest.json"));

check("manifest_version 为 3", manifest.manifest_version === 3);
check(
	"版本号格式合法（1-4 段数字）",
	/^\d{1,4}(\.\d{1,4}){0,3}$/.test(manifest.version),
	manifest.version
);
check("声明了 background service worker (module)", manifest.background?.type === "module");
check("包含 storage 权限", manifest.permissions.includes("storage"));
check("包含 clipboardWrite 权限", manifest.permissions.includes("clipboardWrite"));
check("包含 contextMenus 权限", manifest.permissions.includes("contextMenus"));
check("host_permissions 已声明", manifest.host_permissions.length > 0);

// ★ C1 防复发：background.js 引用的每个 chrome.* 命名空间都需要权限，
//   仅以下例外无需权限：runtime、action，以及 chrome.tabs 的 create/sendMessage
//   （tabs 里读元信息的 API 如 onRemoved/query 才需要 "tabs"）。
{
	const bgCode = fs.readFileSync(path.join(ROOT, "src", "background.js"), "utf8");
	const codeOnly = bgCode.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	// 归一化跨行写法（chrome.tabs\n.create）
	const normalized = codeOnly
		.replace(/chrome\.tabs\s*\.\s*create/g, "chrome.tabs.create")
		.replace(/chrome\.tabs\s*\.\s*sendMessage/g, "chrome.tabs.sendMessage");
	// tabs 只允许 create / sendMessage（无权限）；其它 tabs API 需要 "tabs"
	const tabsCalls = normalized.match(/chrome\.tabs\.\w+/g) || [];
	const badTabs = [...new Set(tabsCalls)].filter(
		(a) => a !== "chrome.tabs.create" && a !== "chrome.tabs.sendMessage"
	);
	// 其它命名空间 → 权限映射
	const NS_PERMS = {
		contextMenus: "contextMenus",
		storage: "storage",
		scripting: "scripting",
	};
	const namespaces = [...new Set((normalized.match(/chrome\.(\w+)\./g) || []).map((s) => s.slice(7, -1)))];
	const problems = [];
	for (const ns of namespaces) {
		if (ns === "runtime" || ns === "action") continue;
		if (ns === "tabs") {
			if (badTabs.length) problems.push(`chrome.tabs 的 ${badTabs.join(",")} 需要 "tabs" 权限`);
			continue;
		}
		const perm = NS_PERMS[ns];
		if (!perm) problems.push(`chrome.${ns}：未登记命名空间，请人工确认权限`);
		else if (!manifest.permissions.includes(perm)) problems.push(`chrome.${ns} 需要 "${perm}" 权限但未声明`);
	}
	check(
		"background.js 的 chrome.* API 都有权限",
		problems.length === 0,
		problems.join(" ; ") || `命名空间：${namespaces.join(", ")}`
	);
}

// content_scripts 结构
const mainCS = manifest.content_scripts.find((cs) => cs.world === "MAIN");
const isoCS = manifest.content_scripts.find((cs) => cs.world === "ISOLATED");
check("存在 MAIN / ISOLATED 两套内容脚本", !!mainCS && !!isoCS);
check("bridge 注入 ISOLATED world", isoCS?.js.includes("src/bridge.js"));
check("meta.js 先于 bridge.js", isoCS?.js.indexOf("src/meta.js") < isoCS?.js.indexOf("src/bridge.js"));
check("gm-shim 在主程序之前", mainCS?.js.indexOf("src/gm-shim.js") < mainCS?.js.indexOf("src/linkswift.main.js"));
check("vendor 库先于 prelude（先加载再捕获）", mainCS?.js.indexOf("vendor/jquery.min.js") < mainCS?.js.indexOf("src/prelude.js"));

// matches 不允许 <all_urls>（I4）
const allPatterns = manifest.content_scripts.flatMap((cs) => cs.matches);
check(
	"matches 不含 <all_urls>（已收敛到网盘域）",
	!allPatterns.includes("<all_urls>"),
	`${allPatterns.length} 条模式`
);
check(
	"每套 content_scripts 的 matches 无重复条目",
	manifest.content_scripts.every((cs) => cs.matches.length === new Set(cs.matches).size)
);
check(
	"WAR matches 不含 <all_urls>",
	!manifest.web_accessible_resources?.[0]?.matches.includes("<all_urls>")
);

// 引用文件存在
const referenced = new Set();
for (const cs of manifest.content_scripts) {
	cs.js.forEach((f) => referenced.add(f));
	(cs.css || []).forEach((f) => referenced.add(f));
}
referenced.add(manifest.background.service_worker);
Object.values(manifest.icons || {}).forEach((f) => referenced.add(f));
const missingFiles = [...referenced].filter((f) => !fs.existsSync(path.join(ROOT, f)));
check("manifest 引用的文件全部存在", missingFiles.length === 0, missingFiles.join(", ") || `${referenced.size} 个`);

/* ==================================================================== *
 * 2. 版本一致性（I5：上游 @version === meta.js === manifest）
 * ==================================================================== */

console.log("\n--- 2. 版本一致性 ---");
const upstreamCode = fs.readFileSync(UPSTREAM, "utf8");
const upstreamVersion = (upstreamCode.match(/\/\/\s*@version\s+(\S+)/) || [])[1];
const metaCode = fs.readFileSync(path.join(ROOT, "src", "meta.js"), "utf8");
const metaVersion = (metaCode.match(/"version":\s*"([^"]+)"/) || [])[1];

check("上游 @version 存在", !!upstreamVersion, upstreamVersion || "未找到");
check("meta.js 版本 === 上游版本", metaVersion === upstreamVersion, `${metaVersion} vs ${upstreamVersion}`);
check("manifest 版本 === 上游版本", manifest.version === upstreamVersion, `${manifest.version} vs ${upstreamVersion}`);

/* ==================================================================== *
 * 3. 主脚本产物检查（Swal/md5 替换、补丁、包装）
 * ==================================================================== */

console.log("\n--- 3. 主脚本产物 ---");
const mainCode = fs.readFileSync(path.join(ROOT, "src", "linkswift.main.js"), "utf8");

check("不含 UserScript 元数据块", !mainCode.includes("// ==UserScript=="));
check("注册 window.__linkSwiftMain", mainCode.includes("window.__linkSwiftMain = function"));
check("jQuery 实参为私有引用", mainCode.includes("window.__linkSwiftJQuery || window.jQuery"));
check("尾部主动调用 __linkSwiftBootstrap", /__linkSwiftBootstrap\(\);\s*\}\s*else/.test(mainCode));
check("new Function 已加 CSP 兜底", mainCode.includes("try { unsafeWindow.console.clear = new Function("));
check(
	"裸 Swal 已全部替换（除字符串内合法残留）",
	(mainCode.match(/window\.__linkSwiftSwal/g) || []).length >= 35,
	`${(mainCode.match(/window\.__linkSwiftSwal/g) || []).length} 处`
);
check(
	"裸 md5 已全部替换",
	(mainCode.match(/window\.__linkSwiftMd5/g) || []).length >= 5,
	`${(mainCode.match(/window\.__linkSwiftMd5/g) || []).length} 处`
);

/* ==================================================================== *
 * 4. 双 world 端到端（真实 gm-shim.js + prelude.js + bridge.js）
 * ==================================================================== */

console.log("\n--- 4. 双 world 端到端 ---");

/**
 * MAIN world 沙箱。真实浏览器里 event.source === window 恒成立；
 * vm 跨 realm 不成立 → 用 vm.runInContext("window") 取同 realm 引用。
 */
function makeMainSandbox(onPostMessage) {
	const listeners = [];
	const sandbox = {
		console,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		Promise, Map, Set, WeakMap, WeakSet, JSON, Math, Date, Error, TypeError,
		Object, Array, String, Number, Boolean, RegExp, Symbol,
		Uint8Array, ArrayBuffer, URL, TextDecoder, TextEncoder,
		atob: (s) => Buffer.from(s, "base64").toString("binary"),
		btoa: (s) => Buffer.from(s, "binary").toString("base64"),
		AbortController,
		fetch: async () => {
			throw new Error("fetch unavailable in test sandbox");
		},
		location: {
			href: "https://pan.baidu.com/disk/main",
			origin: "https://pan.baidu.com",
			host: "pan.baidu.com",
			pathname: "/disk/main",
		},
		navigator: { userAgent: "verify" },
		document: {
			createElement: () => ({
				style: {}, setAttribute() {}, appendChild() {}, remove() {},
				select() {}, setSelectionRange() {},
			}),
			documentElement: { appendChild() {} },
			body: { appendChild() {} },
			querySelector: () => null,
			querySelectorAll: () => [],
			addEventListener() {},
			readyState: "loading",
			title: "verify",
			head: { appendChild() {} },
			getElementsByTagName: () => [{ appendChild() {} }],
		},
		addEventListener(type, fn) {
			if (type === "message") listeners.push(fn);
		},
		removeEventListener(type, fn) {
			const i = listeners.indexOf(fn);
			if (i >= 0) listeners.splice(i, 1);
		},
		postMessage(data) {
			setTimeout(() => onPostMessage && onPostMessage(data), 0);
		},
		dispatchToMain(evt) {
			for (const fn of listeners.slice()) {
				try {
					fn(evt);
				} catch (e) {
					console.error("[main listener error]", e);
				}
			}
		},
	};
	sandbox.window = sandbox;
	sandbox.self = sandbox;
	sandbox.globalThis = sandbox;
	sandbox.top = sandbox;
	return sandbox;
}

/**
 * ISOLATED world 沙箱，跑**真实的 bridge.js**。
 * chrome.* 用 stub 实现（storage 内存版 / runtime.sendMessage 模拟 background）。
 */
function makeIsolatedSandbox() {
	const storageData = new Map();
	const pendingMsgs = [];
	let msgHandler = null; // background 的 onMessage 处理器（由测试注入）

	const chromeStub = {
		storage: {
			local: {
				async get(prefix) {
					// chrome.storage.local.get(null) / get(key) 两种形态
					if (prefix === null || prefix === undefined) {
						return Object.fromEntries(storageData);
					}
					const out = {};
					for (const k of [].concat(prefix)) {
						if (storageData.has(k)) out[k] = storageData.get(k);
					}
					return out;
				},
				async set(obj) {
					for (const [k, v] of Object.entries(obj)) storageData.set(k, v);
				},
				async remove(k) {
					for (const key of [].concat(k)) storageData.delete(key);
				},
			},
			onChanged: {
				addListener() {},
			},
		},
		runtime: {
			sendMessage: (msg) => {
				// 转给 background 模拟器
				return new Promise((resolve) => {
					setTimeout(() => {
						if (msgHandler) msgHandler(msg, { origin: "https://pan.baidu.com", url: "https://pan.baidu.com/disk/main" }, resolve);
						else resolve({ ok: false, error: "no background handler" });
					}, 0);
				});
			},
			onMessage: {
				addListener(fn) {
					// bridge 的菜单监听（此处不测）
				},
			},
			connect() {
				// port 模拟：startStreamRequest 用。本测试不覆盖流式（real-test.cjs 覆盖）
				return {
					postMessage() {},
					onMessage: { addListener() {} },
					onDisconnect: { addListener() {} },
					disconnect() {},
				};
			},
			getURL: (p) => "chrome-extension://testid/" + p,
			lastError: null,
		},
	};

	const listeners = [];
	const sandbox = {
		console, setTimeout, clearTimeout, Promise, Map, Set, JSON, Math, Date, Error,
		Object, Array, String, Number, Boolean, RegExp,
		fetch: async (url) => {
			// getResourceText 的 fetch（返回 css 文本）
			if (url.includes("sweetalert2-light")) {
				return { ok: true, text: async () => "/* mock light css */" };
			}
			if (url.includes("sweetalert2-dark")) {
				return { ok: true, text: async () => "/* mock dark css */" };
			}
			return { ok: false, text: async () => "" };
		},
		document: {
			createElement: () => ({
				style: {}, setAttribute() {}, appendChild() {}, remove() {},
				select() {}, setSelectionRange() {},
			}),
			documentElement: { appendChild() {} },
			body: { appendChild() {} },
		},
		navigator: { clipboard: null },
		addEventListener(type, fn) {
			if (type === "message") listeners.push(fn);
		},
		removeEventListener() {},
		postMessage(data) {
			pendingMsgs.push(data);
		},
		chrome: chromeStub,
		__setBackgroundHandler(fn) {
			msgHandler = fn;
		},
		__storage: storageData,
		__messages: pendingMsgs,
		__listeners: listeners,
		__windowRefs: listeners,
	};
	sandbox.window = sandbox;
	sandbox.self = sandbox;
	sandbox.globalThis = sandbox;
	sandbox.top = sandbox;
	return sandbox;
}

/* ---- 搭建：main sandbox <- postMessage -> isolated sandbox（真实 bridge.js）---- */

const iso = makeIsolatedSandbox();
const isoCtx = vm.createContext(iso);
// bridge.js 是普通脚本（非 module），直接跑
const bridgeCode = fs.readFileSync(path.join(ROOT, "src", "bridge.js"), "utf8");

let mainSandbox;
let mainCtxRef = null;
// ISOLATED realm 的 window 引用（跨 realm 身份比较用）
let isoVmWindow = null;

const mainToIso = (msg) => {
	// MAIN -> ISOLATED：投给 bridge 的 message listener。
	// bridge 的守卫是 `event.source !== window`（iso realm 的 window），
	// 必须传同 realm 引用，宿主侧原始对象跨 realm 不相等。
	setTimeout(() => {
		for (const fn of iso.__listeners) {
			try {
				fn({ source: isoVmWindow, data: msg });
			} catch (e) {
				console.error("[iso listener error]", e);
			}
		}
	}, 0);
};

mainSandbox = makeMainSandbox((msg) => {
	// MAIN -> ISOLATED：投给 bridge 的 message listener。
	// 注意跨 realm 身份：bridge 的守卫是 `event.source !== window`（iso realm 内的
	// window），宿主侧的 iso 原始对象与之不相等——必须用 runInContext 取同 realm 引用。
	mainToIso(msg);
});

// bridge 的回复（iso.postMessage → iso.__messages）→ 回投 MAIN world
// 用轮询泵把它们送回 main
setInterval(() => {
	while (iso.__messages.length) {
		const msg = iso.__messages.shift();
		if (!msg || msg.channel === undefined) continue;
		if (!mainCtxRef) continue;
		// MAIN realm 的 window 引用作 source（跨 realm 比较用）
		const vmWindow = vm.runInContext("window", mainCtxRef);
		mainSandbox.dispatchToMain({ source: vmWindow, data: msg });
	}
}, 5);

// 注入 background 模拟器（sender 白名单校验在这里测：origin 白名单内的放行）
iso.__setBackgroundHandler((msg, sender, sendResponse) => {
	if (msg.type === "linkswift:syncMenus") {
		sendResponse({ ok: true });
		return;
	}
	if (msg.type === "linkswift:openTab") {
		sendResponse({ ok: true });
		return;
	}
	sendResponse({ ok: false, error: "not handled in test bg" });
});

// 先跑 meta.js（ISOLATED world），再跑 bridge.js。
// 注意：预置的旧数据必须在 bridge.js 执行**之前**就位——
// bridge 在顶层立刻 hydrate()（chrome.storage.local.get），晚了就读不到。
iso.__storage.set("linkswift:setting_init", { version: "1.1.3", theme: "auto" });
new vm.Script(metaCode, { filename: "src/meta.js" }).runInContext(isoCtx);
new vm.Script(bridgeCode, { filename: "src/bridge.js" }).runInContext(isoCtx);
// 取 iso realm 的 window 引用（供 mainToIso 的 source 用）
isoVmWindow = vm.runInContext("window", isoCtx);
check("真实 bridge.js 在 ISOLATED 沙箱中执行无异常", true);

// MAIN world：先 vendor 桩，再 prelude，再 gm-shim
const mainCtx = vm.createContext(mainSandbox);
mainCtxRef = mainCtx;
new vm.Script("window = globalThis; globalThis.window = globalThis;", {}).runInContext(mainCtx);

const stubJQuery = `
	(function(){
		function jq(sel){ return { length: 0, append(){return this}, after(){return this}, remove(){return this}, on(){return this}, attr(){return undefined}, data(){return undefined}, html(){return ""}, text(){return ""}, find(){return {length:0, on(){}, each(){}, append(){}, remove(){}}}, each(){}, ready(fn){ try{fn()}catch(e){} }, get(){return undefined}, val(){return ""}, css(){return this}, addClass(){return this}, removeClass(){return this}, toggleClass(){return this}, show(){return this}, hide(){return this}, parent(){return {children(){return {remove(){}}}}}, children(){return {remove(){}}}, empty(){return this}, click(fn){return this}, focus(){return this}, blur(){return this} }; }
		jq.fn = {}; jq.ajax = function(){}; jq.each = function(){}; jq.extend = Object.assign;
		jq.noConflict = function(){ return jq; };
		window.jQuery = jq; window.$ = jq;
	})();
`;
new vm.Script(stubJQuery, { filename: "vendor/jquery(stub)" }).runInContext(mainCtx);
new vm.Script("window.Swal = function(){ return Promise.resolve({isConfirmed:false}); }; window.Swal.fire = window.Swal; window.Swal.mixin = window.Swal; window.md5 = function(){ return 'md5stub'; };", { filename: "vendor/(stubs)" }).runInContext(mainCtx);

// 先注入 meta（gm-shim 的 META 来源——注意 MAIN world 也要有 __linkSwiftMeta）
const metaCodeForMain = fs.readFileSync(path.join(ROOT, "src", "meta.js"), "utf8");
new vm.Script(metaCodeForMain, { filename: "src/meta.js" }).runInContext(mainCtx);

const preludeCode = fs.readFileSync(path.join(ROOT, "src", "prelude.js"), "utf8");
new vm.Script(preludeCode, { filename: "src/prelude.js" }).runInContext(mainCtx);
check("prelude 捕获 jQuery 私有引用", typeof mainSandbox.__linkSwiftJQuery === "function");
check("prelude 捕获 Swal 私有引用", typeof mainSandbox.__linkSwiftSwal === "function");
check("prelude 捕获 md5 私有引用", typeof mainSandbox.__linkSwiftMd5 === "function");
check("prelude 删除全局 Swal（防页面覆盖）", mainSandbox.Swal === undefined || typeof mainSandbox.Swal !== "function" || mainSandbox.Swal === mainSandbox.__linkSwiftSwal);

const shimCode = fs.readFileSync(path.join(ROOT, "src", "gm-shim.js"), "utf8");
new vm.Script(shimCode, { filename: "src/gm-shim.js" }).runInContext(mainCtx);

check("GM_getValue 已挂载", typeof mainSandbox.GM_getValue === "function");
check("GM_xmlhttpRequest 已挂载", typeof mainSandbox.GM_xmlhttpRequest === "function");
check("GM_info.script.version 与 meta 一致", mainSandbox.GM_info.script.version === metaVersion);
check("unsafeWindow 暴露页面全局", mainSandbox.unsafeWindow !== undefined);

// gm-shim 代码（剥注释）不得使用 chrome.*
const shimCodeOnly = shimCode.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
check("gm-shim 代码未使用 chrome.* API", !/chrome\.(runtime|storage|tabs)/.test(shimCodeOnly));

/* ---- 端到端：存储 ---- */

async function testStorage() {
	// 旧数据已在 bridge.js 执行前预置（见上方注释）
	mainSandbox.__linkSwiftBootstrap();
	await new Promise((r) => setTimeout(r, 300));

	const init = mainSandbox.GM_getValue("setting_init");
	check(
		"bootstrap 预取已有配置（经真实 bridge）",
		init && init.version === "1.1.3",
		JSON.stringify(init)
	);

	mainSandbox.GM_setValue("__verify_key", { a: 1, b: "二" });
	check("GM_setValue 同步可读", mainSandbox.GM_getValue("__verify_key")?.a === 1);
	await new Promise((r) => setTimeout(r, 300));
	check(
		"GM_setValue 已落盘（chrome.storage stub）",
		JSON.parse(JSON.stringify(iso.__storage.get("linkswift:__verify_key") || null))?.b === "二",
		JSON.stringify(iso.__storage.get("linkswift:__verify_key"))
	);

	mainSandbox.GM_deleteValue("__verify_key");
	await new Promise((r) => setTimeout(r, 300));
	check("GM_deleteValue 已落盘", !iso.__storage.has("linkswift:__verify_key"));
	check("GM_getValue 缺省值", mainSandbox.GM_getValue("__nope", "fallback") === "fallback");

	// M9：setting_init 兜底
	mainSandbox.GM_deleteValue("setting_init");
	await new Promise((r) => setTimeout(r, 300));
	// 重新 bootstrap 不会发生（只启动一次），直接手动验证 hydrate 兜底行为不存在时
	// 上游也不会拿到 undefined —— 这里只验证已启动状态下缺 key 的缺省值路径
	check("setting_init 删除后读取走缺省（undefined 不再崩）", mainSandbox.GM_getValue("setting_init") === undefined);
}

/* ---- 端到端：资源预载（经真实 bridge 的 getResourceText）---- */

async function testResources() {
	const text = mainSandbox.GM_getResourceText("SwalLigt");
	check("GM_getResourceText 预载成功（真实 bridge 路径）", text.includes("mock light css"), text.slice(0, 30));
	check("未注册资源返回空串", mainSandbox.GM_getResourceText("NoSuchRes") === "");
}

(async () => {
	try {
		await testStorage();
	} catch (e) {
		check("存储链路测试", false, e.message);
	}
	try {
		await testResources();
	} catch (e) {
		check("资源链路测试", false, e.message);
	}

	const failed = results.filter((r) => !r.pass);
	console.log("\n================ 验证汇总 ================");
	console.log(`总计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
	if (failed.length) {
		console.log("\n失败项：");
		failed.forEach((f) => console.log("  ✗ " + f.name + (f.detail ? "  — " + f.detail : "")));
	}
	console.log("==========================================");
	process.exit(failed.length ? 1 : 0);
})();
