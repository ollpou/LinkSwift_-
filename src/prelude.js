/**
 * LinkSwift for Chrome —— 前置捕获（MAIN world，在 vendor 库之后、gm-shim 之前执行）
 *
 * userscript 运行在脚本管理器沙箱里，`$`、`Swal`、`md5` 是它自己作用域的变量。
 * 扩展的 world:"MAIN" 脚本与页面共享同一个全局对象——页面自己加载的 jQuery /
 * SweetAlert2 / md5 会在运行期覆盖全局名（上游代码在用户交互时才调用这些库，
 * 那时页面脚本早已执行），导致版本漂移（如页面的老版 Swal 没有 stopTimer）。
 *
 * 因此：vendor 库加载后立刻抓成私有引用，再把全局名让回给页面；
 * build.cjs 会把主脚本里的裸 `Swal` / `md5` / jQuery 实参全部改写为私有引用。
 */

(() => {
	"use strict";

	// jQuery：抓取后立即让出全局名（页面常自带 jQuery，如 pan.baidu.com）
	const jq = window.jQuery;
	if (jq) {
		window.__linkSwiftJQuery = jq;
		try {
			if (typeof jq.noConflict === "function") jq.noConflict(true);
		} catch (e) {
			console.warn("[LinkSwift] jQuery.noConflict 失败：", e);
		}
	}

	// SweetAlert2：抓取后删除全局名。
	// 上游有 21 处裸 `Swal.*` 调用，运行期才求值——若不删，页面后加载的 Swal
	// 会覆盖全局，上游就会用页面的版本（老版无 stopTimer/resumeTimer 会直接抛错）。
	if (window.Swal) {
		window.__linkSwiftSwal = window.Swal;
		try {
			delete window.Swal;
		} catch (e) {
			window.Swal = undefined;
		}
	}
	// UMD 同时注册的另一个名字，一并清理
	if (window.Sweetalert2) {
		try {
			delete window.Sweetalert2;
		} catch (e) {
			/* ignore */
		}
	}

	// js-md5：同理。上游 5 处裸 `md5()` 用于网盘 API 签名——
	// 用页面的 md5 会导致签名错误、API 鉴权失败，且只在特定站点出现，极难排查。
	if (window.md5) {
		window.__linkSwiftMd5 = window.md5;
		try {
			delete window.md5;
		} catch (e) {
			window.md5 = undefined;
		}
	}
})();
