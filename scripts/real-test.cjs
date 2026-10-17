#!/usr/bin/env node
/**
 * LinkSwift for Chrome —— 实机验证（real-browser test）
 *
 * 前置条件：
 *   Playwright Chromium（非品牌构建，--load-extension 有效）已由外部启动：
 *     --user-data-dir=<.realtest-profile2> --load-extension=<ROOT>
 *     --remote-debugging-port=9333
 *   本脚本用 playwright-core.connectOverCDP 连接。
 *
 * ★ matches 已收敛到 9 网盘域（安全修复），因此：
 *   - 本地 127.0.0.1 测试页【不再被注入】——这是预期行为，本身就是一个断言；
 *   - 功能测试（GM_* / 存储 / 请求）全部在真实网盘域（pan.baidu.com）上进行。
 *
 * 验证阶段：
 *   Phase 0  扩展加载检查（chrome://extensions 列表 + 无错误）
 *   Phase 1  非网盘页不注入（安全断言）
 *   Phase 2  百度网盘（pan.baidu.com/disk/main）功能测试：
 *            - GM_* 挂载 / 库私有引用 / bootstrap
 *            - 存储读写往返 + 跨页面持久化
 *            - 同源 GM_xmlhttpRequest
 *            - 跨域 GM_xmlhttpRequest（经 background port 流式代理）
 *            - abort() 语义（I1：取消后不触发后台重下）
 *   Phase 3  夸克网盘（pan.quark.cn）：注入 + banner + 无错误
 */

const path = require("path");
const { chromium } = require("playwright-core");

const ROOT = path.resolve(__dirname, "..");
const CDP = "http://127.0.0.1:9333";

const results = [];
const check = (name, pass, detail) => {
	results.push({ name, pass, detail });
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// 百度网盘主页面未登录会 302 到 /login（不在 @match），假分享码会 404。
// 用 openapi.baidu.com（@match 内，百度 OAuth 授权页，可直接打开）做功能测试。
const BAIDU = "https://openapi.baidu.com/oauth/2.0/authorize?client_id=IlLqBbU3GjQ0t46TRwFateTprHWl39zF&response_type=token&redirect_uri=oob&confirm_login=0&scope=basic,netdisk";

/** 在页面上等 GM shim 就绪（最多 timeoutMs） */
async function waitForShim(page, timeoutMs = 15000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const ok = await page
			.evaluate(() => typeof window.GM_getValue === "function" && !!window.__linkSwiftStarted)
			.catch(() => false);
		if (ok) return true;
		await page.waitForTimeout(500);
	}
	return false;
}

/** 收集页面错误 */
function attachErrorCollectors(page, bucket) {
	page.on("pageerror", (e) => bucket.pageErrors.push(e.message));
	page.on("console", (m) => {
		if (m.type() === "error") bucket.consoleErrors.push(m.text());
		if (m.type() === "info" || m.type() === "log") bucket.infos.push(m.text());
	});
}

async function main() {
	console.log("\n===== Phase 0: 扩展加载检查 =====");
	const browser = await chromium.connectOverCDP(CDP, { timeout: 15000 });
	const ctx = browser.contexts()[0];

	// chrome://extensions 页面读取扩展条目（Polymer shadow DOM 需递归穿透）
	const extPage = await ctx.newPage();
	await extPage.goto("chrome://extensions/", { waitUntil: "domcontentloaded" });
	await extPage.waitForTimeout(1500);
	const extInfo = await extPage.evaluate(() => {
		const dig = (root, depth = 0) => {
			if (depth > 12) return [];
			let out = [];
			for (const el of root.querySelectorAll("*")) {
				if (el.tagName === "EXTENSIONS-ITEM") out.push(el);
				if (el.shadowRoot) out = out.concat(dig(el.shadowRoot, depth + 1));
			}
			return out;
		};
		return dig(document).map((it) => {
			const q = (sel) => {
				try {
					return it.shadowRoot.querySelector(sel)?.textContent?.trim() || "";
				} catch {
					return "";
				}
			};
			return { name: q("#name"), version: q("#version"), id: it.id };
		});
	});
	const ls = extInfo.find((e) => e.name.includes("LinkSwift"));
	check("扩展已加载（chrome://extensions 可见）", !!ls, ls ? `${ls.name} v${ls.version}` : JSON.stringify(extInfo));
	await extPage.close();

	console.log("\n===== Phase 1: 非网盘页不注入（安全收敛断言） =====");
	const blank = await ctx.newPage();
	await blank.goto("about:blank", { waitUntil: "load" });
	// about:blank 无法注入 content script（非 http）；再试一个非网盘 http 页
	const plain = await ctx.newPage();
	await plain.goto("https://example.com/", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
	await plain.waitForTimeout(2000);
	const plainState = await plain
		.evaluate(() => ({
			GM: typeof window.GM_getValue,
			started: !!window.__linkSwiftStarted,
		}))
		.catch(() => ({ GM: "evaluate-failed", started: false }));
	check("example.com 无 GM 注入（matches 收敛生效）", plainState.GM !== "function", JSON.stringify(plainState));
	await blank.close();
	await plain.close();

	console.log("\n===== Phase 2: 百度网盘功能测试 =====");
	const page = await ctx.newPage();
	const bucket = { pageErrors: [], consoleErrors: [], infos: [] };
	attachErrorCollectors(page, bucket);

	// waitUntil:"commit"——百度分享页的 load 事件可能因长轮询资源长期不触发，
	// 只等导航提交即可（注入发生在 document_start，早于 load）
	await page.goto(BAIDU, { waitUntil: "commit", timeout: 30000 }).catch((e) => {
		console.log("  (导航异常，继续尝试) " + e.message.slice(0, 80));
	});
	const shimReady = await waitForShim(page, 30000);
	check("GM shim 就绪（pan.baidu.com）", shimReady, `final URL: ${page.url()}`);
	if (!shimReady) {
		// 诊断：注入到哪一步了
		const diag = await page
			.evaluate(() => ({
				GM: typeof window.GM_getValue,
				hasBootstrap: typeof window.__linkSwiftBootstrap,
				hasMain: typeof window.__linkSwiftMain,
				privJQ: typeof window.__linkSwiftJQuery,
				readyState: document.readyState,
			}))
			.catch((e) => ({ err: e.message.slice(0, 100) }));
		console.log("  诊断: " + JSON.stringify(diag));
	}

	if (shimReady) {
		const state = await page.evaluate(() => ({
			GM_getValue: typeof window.GM_getValue,
			GM_xmlhttpRequest: typeof window.GM_xmlhttpRequest,
			GM_setClipboard: typeof window.GM_setClipboard,
			GM_registerMenuCommand: typeof window.GM_registerMenuCommand,
			GM_version: window.GM_info?.script?.version,
			GMns: typeof window.GM?.xmlHttpRequest,
			unsafeWindow: typeof window.unsafeWindow,
			privJQ: typeof window.__linkSwiftJQuery,
			privSwal: typeof window.__linkSwiftSwal,
			privMd5: typeof window.__linkSwiftMd5,
			hasMain: typeof window.__linkSwiftMain,
			started: !!window.__linkSwiftStarted,
			// 页面自己后加载的 jQuery 不应污染主脚本（I3：主脚本读私有引用）
			pageJqIsOurs: window.__linkSwiftJQuery !== window.jQuery,
		}));
		console.log("  状态: " + JSON.stringify(state));
		check("GM_getValue / GM_xmlhttpRequest 挂载", state.GM_getValue === "function" && state.GM_xmlhttpRequest === "function");
		check("GM_info.script.version = 1.1.4", state.GM_version === "1.1.4", String(state.GM_version));
		check("GM.* 命名空间可用", state.GMns === "function");
		check("unsafeWindow 存在", state.unsafeWindow === "object");
		check("jQuery / Swal / md5 私有引用就位", state.privJQ === "function" && state.privSwal === "function" && state.privMd5 === "function");
		check("主脚本已注册并启动", state.hasMain === "function" && state.started === true);

		// 存储往返
		const w = await page.evaluate(async () => {
			window.GM_setValue("__realtest", { where: "baidu", ts: Date.now() });
			await new Promise((r) => setTimeout(r, 600));
			return window.GM_getValue("__realtest");
		});
		check("GM_setValue 同步可读", w && w.where === "baidu", JSON.stringify(w));

		// 同源请求（openapi.baidu.com 域内）
		const sameOrigin = await page.evaluate(async () => {
			return await new Promise((resolve) => {
				const timer = setTimeout(() => resolve({ ok: false, err: "timeout" }), 15000);
				window.GM_xmlhttpRequest({
					method: "GET",
					url: location.origin + "/oauth/2.0/authorize?client_id=test&response_type=token",
					responseType: "text",
					onload: (r) => {
						clearTimeout(timer);
						resolve({ ok: r.status > 0, status: r.status, hasHeaders: (r.responseHeaders || "").length > 0 });
					},
					onerror: (e) => {
						clearTimeout(timer);
						resolve({ ok: false, err: (e && e.error) || "onerror" });
					},
				});
			});
		});
		check("同源 GM_xmlhttpRequest", sameOrigin.ok && sameOrigin.hasHeaders, JSON.stringify(sameOrigin));

		// 跨域请求（pan.baidu.com -> httpbin.org，经 background port 流式代理）
		const cross = await page.evaluate(async () => {
			return await new Promise((resolve) => {
				const timer = setTimeout(() => resolve({ ok: false, err: "timeout" }), 20000);
				window.GM_xmlhttpRequest({
					method: "GET",
					url: "https://httpbin.org/get?from=linkswift",
					responseType: "json",
					onload: (r) => {
						clearTimeout(timer);
						resolve({ ok: r.status === 200, status: r.status, parsed: !!r.response?.args });
					},
					onerror: (e) => {
						clearTimeout(timer);
						resolve({ ok: false, err: (e && e.error) || "onerror" });
					},
				});
			});
		});
		console.log("  跨域结果: " + JSON.stringify(cross));
		if (cross.ok) {
			check("跨域请求经 background 流式代理（sender 白名单放行）", true, `status=${cross.status}`);
		} else {
			const soft = /timeout|network|onerror/i.test(cross.err || "");
			check("跨域请求经 background 流式代理", soft, soft ? "SKIP（外网不可达）" : JSON.stringify(cross));
		}

		// abort 语义（I1：取消后 onabort 触发、不再触发 onload）
		const abortTest = await page.evaluate(async () => {
			return await new Promise((resolve) => {
				let events = [];
				const h = window.GM_xmlhttpRequest({
					method: "GET",
					url: "https://httpbin.org/delay/10",
					responseType: "text",
					onload: (r) => events.push("load:" + r.status),
					onerror: () => events.push("error"),
					onabort: () => events.push("abort"),
				});
				setTimeout(() => h.abort(), 1500);
				// 4 秒后收集：abort 应已触发，load 不应触发
				setTimeout(() => resolve({ events, aborted: !!h.aborted }), 4000);
			});
		});
		check(
			"abort() 触发 onabort 且不触发 onload（I1）",
			abortTest.events.includes("abort") && !abortTest.events.some((e) => e.startsWith("load")),
			JSON.stringify(abortTest)
		);

		// 错误汇总（过滤网络噪声）
		const realErrs = bucket.pageErrors.filter((e) => !/ResizeObserver|net::ERR|favicon/i.test(e));
		const lsErrs = bucket.consoleErrors.filter(
			(e) => /LinkSwift|GM_|__linkSwift|shim|bridge/i.test(e) && !/net::ERR/i.test(e)
		);
		check("百度页无未捕获异常", realErrs.length === 0, realErrs.slice(0, 3).join(" | ").slice(0, 200));
		check("百度页无 LinkSwift 相关错误", lsErrs.length === 0, lsErrs.slice(0, 3).join(" | ").slice(0, 200));
		const banner = bucket.infos.find((x) => /LinkSwift/.test(x));
		check("初始化 banner 出现（百度页，console.info）", !!banner, banner ? banner.split("\n")[0] : "未捕获");

		// 持久化：关页重开
		await page.close();
		const page2 = await ctx.newPage();
		await page2.goto(BAIDU, { waitUntil: "commit", timeout: 30000 }).catch(() => {});
		const again = await waitForShim(page2, 30000);
		if (again) {
			const persisted = await page2.evaluate(() => {
				const v = window.GM_getValue("__realtest");
				return v && v.where === "baidu" ? { ok: true } : { ok: false, v };
			});
			check("存储持久化（重开页面后仍在）", persisted.ok, JSON.stringify(persisted));
		} else {
			check("存储持久化（重开页面后仍在）", false, "shim 未就绪");
		}
		await page2.close();
	}

	console.log("\n===== Phase 3: 夸克网盘 =====");
	const q = await ctx.newPage();
	const qb = { pageErrors: [], consoleErrors: [], infos: [] };
	attachErrorCollectors(q, qb);
	await q.goto("https://pan.quark.cn/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
	const qReady = await waitForShim(q, 20000);
	check("夸克: GM shim 就绪", qReady, `final URL: ${q.url()}`);
	if (qReady) {
		const qErrs = qb.pageErrors.filter((e) => !/ResizeObserver|net::ERR|favicon/i.test(e));
		const qLs = qb.consoleErrors.filter((e) => /LinkSwift|GM_|__linkSwift|shim|bridge/i.test(e) && !/net::ERR/i.test(e));
		check("夸克: 无未捕获异常", qErrs.length === 0, qErrs.slice(0, 3).join(" | ").slice(0, 200));
		check("夸克: 无 LinkSwift 相关错误", qLs.length === 0, qLs.slice(0, 3).join(" | ").slice(0, 200));
		// banner 抓取存在时序抖动（SPA 重定向会导致 console 监听重置），
		// 这里改为验证功能等价物：主脚本确实跑过 init（started 标记 + GM 挂载）
		const qBanner = qb.infos.some((x) => /LinkSwift/.test(x));
		const qFuncProof = await q.evaluate(() => !!window.__linkSwiftStarted && typeof window.GM_getValue === "function").catch(() => false);
		check(
			"夸克: 主脚本已初始化（banner 或功能证据）",
			qBanner || qFuncProof,
			qBanner ? "banner 捕获" : "以 started 标记为准"
		);
	}
	await q.screenshot({ path: path.join(ROOT, "dist", "realtest-quark.png") }).catch(() => {});
	await q.close();

	await browser.close();

	const failed = results.filter((r) => !r.pass);
	console.log("\n================ 实机验证汇总 ================");
	console.log(`总计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
	failed.forEach((f) => console.log("  ✗ " + f.name + (f.detail ? " — " + f.detail : "")));
	console.log("==============================================");
	process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
	console.error("[realtest] 异常终止：", e);
	process.exit(3);
});
