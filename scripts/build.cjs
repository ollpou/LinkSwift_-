#!/usr/bin/env node
/**
 * LinkSwift for Chrome —— 构建脚本
 *
 * 从上游 userscript（（改）网盘直链下载助手.user.js）生成扩展所需的三个产物：
 *
 *   1. src/linkswift.main.js —— 主脚本（剥离元数据 + 依赖改私有引用 + 补丁 + 包装）
 *   2. src/meta.js          —— 版本 / @resource 清单 / 网盘域名白名单
 *   3. manifest.json        —— 版本号 + content_scripts/WAR 的 matches（从 @match 生成）
 *
 * 设计原则：**fail-fast**。上游是活跃维护的项目，正则失配是升级时最可能的故障
 * 模式——任何替换未命中都直接报错退出，绝不静默产出一个坏产物。
 *
 * 用法：
 *   node scripts/build.cjs
 *   node scripts/build.cjs --allow-missing-patch=补丁名[,补丁名]   # 显式豁免某个补丁
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_SRC = path.resolve(ROOT, "..", "LinkSwift", "（改）网盘直链下载助手.user.js");

/** 上游 @resource 名 → 扩展内 vendor 文件。上游新增 @resource 时在此登记，
 *  未登记的资源会让构建失败（防止静默丢样式）。 */
const RESOURCE_FILES = {
	SwalLigt: "vendor/sweetalert2-light.min.css",
	SwalDark: "vendor/sweetalert2-dark.min.css",
};

function parseArgs(argv) {
	const out = {};
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--src") out.src = argv[++i];
		if (a === "--allow-missing-patch") out.allowMissing = (argv[++i] || "").split(",");
	}
	return out;
}

const args = parseArgs(process.argv);
const SRC = args.src ? path.resolve(args.src) : DEFAULT_SRC;
const allowMissing = new Set(args.allowMissing || []);

function die(msg) {
	console.error("[build] ✗ " + msg);
	process.exit(1);
}

/* ==================================================================== *
 * 1. 读取上游并解析元数据
 * ==================================================================== */

if (!fs.existsSync(SRC)) {
	die("找不到上游脚本：" + SRC + "\n       请先 git clone https://github.com/hmjz100/LinkSwift.git");
}

const code = fs.readFileSync(SRC, "utf8");

const metaStart = code.indexOf("// ==UserScript==");
const metaEnd = code.indexOf("// ==/UserScript==");
if (metaStart === -1 || metaEnd === -1) die("未找到 UserScript 元数据块，上游格式可能已变化。");

const metaBlock = code.slice(metaStart, metaEnd);
let body = code.slice(metaEnd + "// ==/UserScript==".length).replace(/^\s*\n/, "");

/** 从元数据块收集某指令的所有值 */
function metaValues(directive) {
	const out = [];
	// 注意：上游是 CRLF 行尾。若按 "\n" split，行尾残留 "\r"，
	// 而 (.+)$ 的 "." 不匹配 "\r"、"$" 又只认绝对末尾 → 永远失配。
	for (const line of metaBlock.split(/\r?\n/)) {
		const m = line.match(new RegExp("^//\\s*@" + directive + "\\s+(.+)$"));
		if (m) out.push(m[1].trim());
	}
	return out;
}

const version = metaValues("version")[0];
const matchList = metaValues("match");
const resourceList = metaValues("resource");

if (!version) die("元数据块里没有 @version。");
if (matchList.length === 0) die("元数据块里没有 @match。");

// M10：Chrome 扩展版本号必须是 1-4 段纯数字
if (!/^\d{1,4}(\.\d{1,4}){0,3}$/.test(version)) {
	die(`@version "${version}" 不是合法的 Chrome 扩展版本号（1-4 段数字）。`);
}

console.log(`[build] 上游版本：${version}`);
console.log(`[build] @match ${matchList.length} 条，@resource ${resourceList.length} 条`);

/* ==================================================================== *
 * 2. 依赖引用替换（fail-fast）
 * ==================================================================== */

// ---- 2a. jQuery 实参 ----
const JQ_TAIL = "})($ ?? jQuery);";
if (body.split(JQ_TAIL).length !== 2) {
	die(
		`未在上游尾部找到唯一的 "${JQ_TAIL}"。\n` +
			"       上游可能改写了 IIFE 收尾——请检查后更新 build.cjs 的替换规则。"
	);
}
body = body.replace(JQ_TAIL, "})(window.__linkSwiftJQuery || window.jQuery);");

// ---- 2b. Swal / md5 改私有引用（I3 修复）----
// 页面自己的 Swal/md5 会在运行期覆盖全局名；上游在用户交互时才调用这些库，
// 届时用的就是页面的版本（老版 Swal 无 stopTimer、页面的 md5 签名错误）。
// prelude.js 已在 document_start 捕获私有引用并让出全局名。
const SWAL_RE = /\bSwal\b/g;
const MD5_RE = /\bmd5\b/g;
const swalCount = (body.match(SWAL_RE) || []).length;
const md5Count = (body.match(MD5_RE) || []).length;
if (swalCount === 0) die("未在正文中找到任何 \\bSwal\\b 引用——上游可能改用了别名，请人工确认。");
if (md5Count === 0) die("未在正文中找到任何 \\bmd5\\b 引用——上游可能改用了别名，请人工确认。");
body = body.replace(SWAL_RE, "window.__linkSwiftSwal").replace(MD5_RE, "window.__linkSwiftMd5");
console.log(`[build] Swal → 私有引用：${swalCount} 处；md5 → 私有引用：${md5Count} 处`);

/* ==================================================================== *
 * 3. 适配补丁（fail-fast，可显式豁免）
 * ==================================================================== */

const PATCHES = [
	{
		name: "GM_info 兜底",
		why: "某些环境下 GM_info.script 可能不存在，原脚本直接访问 .author 会抛错",
		from: /const info = \{\s*author: GM_info\.script\?\.author,/,
		to: "const info = {\n\t\tauthor: (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.author) || 'Hmjz100',",
	},
	{
		name: "new Function CSP 兜底",
		why: "原脚本末尾用 new Function 清空控制台，CSP 严格站点会拦截并中断整个脚本",
		from: /unsafeWindow\.console\.clear = new Function\(base\.decodeBase\("([^"]+)"\)\);/,
		to: 'try { unsafeWindow.console.clear = new Function(base.decodeBase("$1")); } catch (e) { /* CSP 拦截，忽略 */ }',
	},
];

for (const p of PATCHES) {
	const hits = (body.match(new RegExp(p.from.source, p.from.flags.includes("g") ? p.from.flags : p.from.flags + "g")) || []).length;
	if (hits === 0) {
		if (allowMissing.has(p.name)) {
			console.log(`[build] 补丁「${p.name}」未命中——已按参数豁免（后果自担：${p.why}）`);
			continue;
		}
		die(
			`补丁「${p.name}」未命中上游代码。\n` +
				`       用途：${p.why}\n` +
				`       上游可能已改动相关代码。确认不需要后可用 --allow-missing-patch=${p.name} 豁免。`
		);
	}
	if (hits > 1) die(`补丁「${p.name}」命中 ${hits} 处（期望 1 处），请人工检查。`);
	body = body.replace(p.from, p.to);
	console.log(`[build] 补丁「${p.name}」：已应用`);
}

/* ==================================================================== *
 * 4. 包装主入口（fail-fast）
 * ==================================================================== */

function wrapMainEntry(src) {
	const tailMatch = src.match(/\n\}\)\(([^)]*)\);\s*$/);
	if (!tailMatch) die("无法定位 IIFE 结尾（\\n})(...);），上游结构可能已变化。");

	return (
		"// ===== 由 build.cjs 生成，请勿手工编辑 =====\n" +
		"// 上游：https://github.com/hmjz100/LinkSwift\n" +
		"// 上游版本：" + version + "\n" +
		// 刻意不写构建时间戳：产物必须可复现（同输入 → 同输出），
		// 否则 CI 的「构建一致性」检查永远失败，也无法审计产物来源。
		"(function () {\n" +
		'"use strict";\n' +
		"window.__linkSwiftMain = function () {\n" +
		src +
		"\n};\n" +
		// 关键：主脚本注册完成后主动引导。不能依赖 gm-shim 里的微任务，
		// 因为两个 content script 文件之间会跑微任务检查点，那时本文件还没执行。
		"if (typeof window.__linkSwiftBootstrap === 'function') {\n" +
		"\twindow.__linkSwiftBootstrap();\n" +
		"} else {\n" +
		"\tconsole.error('[LinkSwift] gm-shim 未就绪，无法启动');\n" +
		"}\n" +
		"})();\n"
	);
}

const wrapped = wrapMainEntry(body);

/* ==================================================================== *
 * 5. 生成 src/meta.js（ISOLATED world + background 用）
 *    并把 META 内联进 src/gm-shim.js（MAIN world 不复用 meta.js——实测
 *    Chrome 不把同一文件注入两个 world 的声明，ISOLATED 生效 MAIN 不生效）
 * ==================================================================== */

// @resource 行格式：`名字 https://...`
const resources = {};
for (const line of resourceList) {
	const m = line.match(/^(\S+)\s+(\S+)$/);
	if (!m) die("无法解析 @resource 行：" + line);
	const [, name, url] = m;
	const file = RESOURCE_FILES[name];
	if (!file) {
		die(
			`@resource "${name}"（${url}）没有对应的 vendor 映射。\n` +
				"       请先把文件下载到 vendor/ 并在 build.cjs 的 RESOURCE_FILES 登记。"
		);
	}
	if (!fs.existsSync(path.join(ROOT, file))) {
		die(`@resource "${name}" 映射的文件不存在：${file}（先跑 scripts/fetch-vendor.cjs）`);
	}
	resources[name] = file;
}

// 从 @match 提取 host → 精确域名 / 后缀域名（sender 白名单用）
const exactHosts = [];
const suffixHosts = [];
for (const pattern of matchList) {
	const m = pattern.match(/^\*:\/\/([^/]+)/);
	if (!m) die("无法从 @match 提取 host：" + pattern);
	const host = m[1];
	if (host.startsWith("*.")) {
		const bare = host.slice(2);
		if (!suffixHosts.includes(bare)) suffixHosts.push(bare);
	} else if (!exactHosts.includes(host)) {
		exactHosts.push(host);
	}
}

const metaJs =
	"// ===== 由 build.cjs 生成，勿手改 =====\n" +
	"// 上游 @version / @resource / @match 的单一事实来源。\n" +
	"// background 的 sender 白名单与 bridge 的资源清单都从这里读。\n" +
	"/* eslint-disable */\n" +
	"globalThis.__linkSwiftMeta = " +
	JSON.stringify(
		{
			version,
			resources,
			origins: exactHosts,
			suffixes: suffixHosts,
		},
		null,
		"\t"
	) +
	";\n" +
	'globalThis.__linkSwiftMetaLoaded = true;\n';

/* ==================================================================== *
 * 6. 写出产物 + 再生成 manifest
 * ==================================================================== */

fs.mkdirSync(path.join(ROOT, "src"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "src", "linkswift.main.js"), wrapped, "utf8");
fs.writeFileSync(path.join(ROOT, "src", "meta.js"), metaJs, "utf8");
console.log(`[build] src/linkswift.main.js  ${wrapped.length} 字节`);
console.log(`[build] src/meta.js           ${metaJs.length} 字节`);

// 把 META 内联进 gm-shim.js（幂等：用 BEGIN/END 哨兵定位，每次构建都能重写）
const shimPath = path.join(ROOT, "src", "gm-shim.js");
let shimSrc = fs.readFileSync(shimPath, "utf8");
const META_BEGIN = "/* __LINKSWIFT_META_BEGIN__ */";
const META_END = "/* __LINKSWIFT_META_END__ */";
const beginIdx = shimSrc.indexOf(META_BEGIN);
const endIdx = shimSrc.indexOf(META_END);
if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
	die(
		"gm-shim.js 里的 __LINKSWIFT_META_BEGIN__ / __LINKSWIFT_META_END__ 哨兵未找到。\n" +
			"       请检查 const META = ... 一行的哨兵注释是否被删改。"
	);
}
const metaLiteral = JSON.stringify(
	{ version, resources, origins: exactHosts, suffixes: suffixHosts },
	null,
	"\t"
);
shimSrc =
	shimSrc.slice(0, beginIdx) +
	META_BEGIN +
	" " +
	metaLiteral +
	" " +
	META_END +
	shimSrc.slice(endIdx + META_END.length);
fs.writeFileSync(shimPath, shimSrc, "utf8");
console.log(`[build] src/gm-shim.js        META 已内联（幂等，${metaLiteral.length} 字节）`);

const manifestPath = path.join(ROOT, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.version = version;
// content_scripts 的 matches 直接沿用上游 @match（含路径限定，与上游行为一致）。
// 去重：上游 @match 有重复条目（如 disk/timeline* 写了两次），Chrome 会拒绝重复模式。
const uniqueMatches = [...new Set(matchList)];
for (const cs of manifest.content_scripts || []) {
	cs.matches = uniqueMatches.slice();
}
// WAR（CSS/图标）按 host 放宽到全路径
const warPatterns = [];
for (const h of [...exactHosts, ...suffixHosts.map((s) => "*." + s)]) {
	const p = "*://" + h + "/*";
	if (!warPatterns.includes(p)) warPatterns.push(p);
}
if (manifest.web_accessible_resources?.[0]) {
	manifest.web_accessible_resources[0].matches = warPatterns;
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log(`[build] manifest.json 版本 → ${version}，matches → ${matchList.length} 条`);

// 引用文件存在性最终检查（含新生成的 meta.js）
const referenced = new Set(["src/meta.js"]);
for (const cs of manifest.content_scripts || []) (cs.js || []).forEach((f) => referenced.add(f));
referenced.add(manifest.background.service_worker);
Object.values(manifest.icons || {}).forEach((f) => referenced.add(f));
const missingFiles = [...referenced].filter((f) => !fs.existsSync(path.join(ROOT, f)));
if (missingFiles.length) die("manifest 引用的文件缺失：" + missingFiles.join(", "));

console.log("[build] 完成。");
