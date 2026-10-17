const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// 用 node 直接生成 PNG：先写一个最小 BMP 再转？改用 Playwright 截图最稳。
// 这里改用纯 JS 生成 PNG（无第三方库）：手写 PNG 编码器
const zlib = require('zlib');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, pixelFn) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y, size);
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 设计：紫蓝渐变圆角方块 + 白色向下箭头（贴合 LinkSwift 的云+下载语义）
function pixel(x, y, size) {
  const cx = size / 2, cy = size / 2;
  const r = size * 0.46;
  // 圆角方形遮罩
  const pad = size * 0.06;
  const qx = Math.abs(x - cx) / (size / 2 - pad);
  const qy = Math.abs(y - cy) / (size / 2 - pad);
  const k = 4;
  const d = Math.pow(qx, k) + Math.pow(qy, k);
  if (d > 1) return [0, 0, 0, 0];

  // 渐变背景 #A099F0 -> #574AB8
  const t = (x + y) / (2 * size);
  let R = Math.round(0xA0 + (0x57 - 0xA0) * t);
  let G = Math.round(0x99 + (0x4A - 0x99) * t);
  let B = Math.round(0xF0 + (0xB8 - 0xF0) * t);

  // 白色向下箭头
  const ax = Math.abs(x - cx) / size;
  const ay = (y - cy) / size;
  const shaftW = 0.085;
  let arrow = false;
  if (ay > -0.20 && ay < 0.10 && ax < shaftW) arrow = true;             // 竖杆
  if (ay >= 0.08 && ay < 0.26) {                                        // 箭头三角
    const half = 0.20 * (1 - (ay - 0.08) / 0.18);
    if (ax < half) arrow = true;
  }
  if (ay > 0.26 && ay < 0.33 && ax < 0.26) arrow = true;                 // 底部横线
  if (arrow) return [255, 255, 255, 255];
  return [R, G, B, 255];
}

for (const s of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join('icons', `icon${s}.png`), png(s, pixel));
  console.log('generated icons/icon' + s + '.png');
}
