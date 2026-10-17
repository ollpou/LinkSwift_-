#!/usr/bin/env node
/**
 * LinkSwift for Chrome —— 下载第三方依赖并打补丁
 *
 * 1. 从 unpkg 拉取上游 @require 声明的库到 vendor/（本地化，符合 MV3 CSP）；
 * 2. 对 sweetalert2.min.js 打「确保 <head> 存在」补丁：
 *    content script 的 document_start 早于 head 解析，而 Swal 顶层执行
 *    document.getElementsByTagName("head")[0].appendChild(...) 会抛 TypeError
 *    并中断库加载（document_start 时 documentElement 必在，手动补建 head 即可，
 *    解析器随后会复用它）。
 *
 * 用法：node scripts/fetch-vendor.cjs
 */

const fs = require("fs");
const path = require("path");

const FILES = [
	["https://unpkg.com/jquery@3.6.0/dist/jquery.min.js", "vendor/jquery.min.js"],
	["https://unpkg.com/sweetalert2@11.4.8/dist/sweetalert2.min.js", "vendor/sweetalert2.min.js"],
	["https://unpkg.com/sweetalert2@11.4.8/dist/sweetalert2.min.css", "vendor/sweetalert2-light.min.css"],
	["https://unpkg.com/@sweetalert2/theme-dark@5.0.26/dark.min.css", "vendor/sweetalert2-dark.min.css"],
	["https://unpkg.com/js-md5@0.7.3/build/md5.min.js", "vendor/md5.min.js"],
];

/** @resource 名 → 本地 vendor 文件（上游元数据里的资源名是 SwalLigt/SwalDark） */
const RESOURCE_FILES = {
	SwalLigt: "vendor/sweetalert2-light.min.css",
	SwalDark: "vendor/sweetalert2-dark.min.css",
};

const SWAL_HEAD_PATCH = `/* LinkSwift-Chrome patch: ensure <head> exists before SweetAlert2 toplevel.
   At document_start the parser hasn't reached <head> yet, but documentElement
   is guaranteed; create it ourselves — the HTML parser will then reuse it. */
(function ensureHead() {
  if (document.head || document.getElementsByTagName("head").length) return;
  try { document.documentElement.appendChild(document.createElement("head")); } catch (e) {}
})();
`;

(async () => {
	let failed = 0;

	for (const [url, out] of FILES) {
		try {
			const r = await fetch(url);
			if (!r.ok) throw new Error("HTTP " + r.status);
			let text = await r.text();
			if (out.endsWith("sweetalert2.min.js")) {
				if (!text.includes("LinkSwift-Chrome patch")) {
					text = SWAL_HEAD_PATCH + text;
					console.log("       已打 head 时序补丁");
				}
			}
			fs.mkdirSync(path.dirname(out), { recursive: true });
			fs.writeFileSync(out, text, "utf8");
			console.log("OK  " + out + "  " + text.length + " bytes");
		} catch (e) {
			console.log("ERR " + out + "  " + e.message);
			failed++;
		}
	}

	// 校验 @resource 映射的文件都存在
	for (const [name, file] of Object.entries(RESOURCE_FILES)) {
		if (!fs.existsSync(file)) {
			console.log("ERR @resource " + name + " 对应文件缺失: " + file);
			failed++;
		}
	}

	if (failed) {
		console.log("\n" + failed + " 项失败");
		process.exit(1);
	}
	console.log("\n全部依赖就绪。");
})();
