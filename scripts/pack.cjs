#!/usr/bin/env node
/**
 * LinkSwift for Chrome —— 打包脚本
 *
 * 生成可直接分发的 zip（用于上传 Chrome Web Store 或分享给他人手动加载）。
 * 自动排除：node_modules、测试产物、脚本源码（只保留运行所需文件）。
 *
 * 用法：node scripts/pack.cjs
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");

/** 打包时要包含的路径（白名单，避免误带开发文件） */
const INCLUDE = [
	"manifest.json",
	"LICENSE",
	"README.md",
	"src/prelude.js",
	"src/gm-shim.js",
	"src/linkswift.main.js",
	"src/bridge.js",
	"src/meta.js",
	"src/background.js",
	"vendor/jquery.min.js",
	"vendor/sweetalert2.min.js",
	"vendor/sweetalert2-light.min.css",
	"vendor/sweetalert2-dark.min.css",
	"vendor/md5.min.js",
	"icons/icon16.png",
	"icons/icon32.png",
	"icons/icon48.png",
	"icons/icon128.png",
];

/* ------------------------------------------------------------------ *
 * 极简 ZIP 写入器（store + deflate，无第三方依赖）
 * ------------------------------------------------------------------ */

function crc32(buf) {
	let crc = 0xffffffff;
	for (let i = 0; i < buf.length; i++) {
		crc ^= buf[i];
		for (let k = 0; k < 8; k++) {
			crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function dosTime(d) {
	const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
	const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
	return { time, date };
}

/**
 * @param {Array<{name: string, data: Buffer}>} files
 * @returns {Buffer}
 */
function makeZip(files) {
	const localParts = [];
	const centralParts = [];
	let offset = 0;

	for (const f of files) {
		const nameBuf = Buffer.from(f.name, "utf8");
		const crc = crc32(f.data);
		const compressed = zlib.deflateRawSync(f.data, { level: 9 });
		// 只有在压缩确实更小时才用 deflate
		const useDeflate = compressed.length < f.data.length;
		const payload = useDeflate ? compressed : f.data;
		const method = useDeflate ? 8 : 0;
		const { time, date } = dosTime(new Date());

		// ---- local file header ----
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt16LE(0x0800, 6); // UTF-8 flag
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(time, 10);
		local.writeUInt16LE(date, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(payload.length, 18);
		local.writeUInt32LE(f.data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		local.writeUInt16LE(0, 28);

		localParts.push(local, nameBuf, payload);

		// ---- central directory ----
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4); // version made by
		central.writeUInt16LE(20, 6); // version needed
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt16LE(time, 12);
		central.writeUInt16LE(date, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(payload.length, 20);
		central.writeUInt32LE(f.data.length, 24);
		central.writeUInt16LE(nameBuf.length, 28);
		central.writeUInt16LE(0, 30); // extra len
		central.writeUInt16LE(0, 32); // comment len
		central.writeUInt16LE(0, 34); // disk
		central.writeUInt16LE(0, 36); // internal attrs
		central.writeUInt32LE(0, 38); // external attrs
		central.writeUInt32LE(offset, 42);

		centralParts.push(central, nameBuf);

		offset += local.length + nameBuf.length + payload.length;
	}

	const centralBuf = Buffer.concat(centralParts);
	const localBuf = Buffer.concat(localParts);

	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(files.length, 8);
	eocd.writeUInt16LE(files.length, 10);
	eocd.writeUInt32LE(centralBuf.length, 12);
	eocd.writeUInt32LE(localBuf.length, 16);
	eocd.writeUInt16LE(0, 20);

	return Buffer.concat([localBuf, centralBuf, eocd]);
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

function main() {
	const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
	const version = manifest.version;

	const files = [];
	const missing = [];

	for (const rel of INCLUDE) {
		const abs = path.join(ROOT, rel);
		if (!fs.existsSync(abs)) {
			missing.push(rel);
			continue;
		}
		files.push({ name: rel, data: fs.readFileSync(abs) });
	}

	if (missing.length) {
		console.error("[pack] 以下文件缺失，无法打包：");
		missing.forEach((m) => console.error("   - " + m));
		process.exit(1);
	}

	fs.mkdirSync(DIST, { recursive: true });
	const outName = `LinkSwift-Chrome-v${version}.zip`;
	const outPath = path.join(DIST, outName);

	const zip = makeZip(files);
	fs.writeFileSync(outPath, zip);

	const totalRaw = files.reduce((s, f) => s + f.data.length, 0);
	console.log(`[pack] 文件数：${files.length}`);
	console.log(`[pack] 原始大小：${(totalRaw / 1024).toFixed(1)} KB`);
	console.log(`[pack] 压缩后：${(zip.length / 1024).toFixed(1)} KB`);
	console.log(`[pack] 输出：${outPath}`);
}

main();
