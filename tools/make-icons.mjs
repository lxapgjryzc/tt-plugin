// Generates icons/{16,32,48,128}.png: a dark rounded square with two pips. No dependencies.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function png(size, px) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) px(x + 0.5, y + 0.5).forEach((v, i) => { raw[y * (size * 4 + 1) + 1 + x * 4 + i] = v; });
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const clamp = (v) => Math.max(0, Math.min(1, v));
for (const size of [16, 32, 48, 128]) {
  const s = size / 128;
  const buf = png(size, (x, y) => {
    const u = x / s, v = y / s; // 128-space
    // rounded square, radius 28
    const r = 28, cx = Math.min(Math.max(u, r + 4), 124 - r), cy = Math.min(Math.max(v, r + 4), 124 - r);
    const dSq = Math.hypot(u - cx, v - cy) - r;
    const aSq = clamp(0.5 - dSq * s);
    // two pips: left filled, right ring
    const d1 = Math.hypot(u - 44, v - 64) - 18;
    const d2 = Math.abs(Math.hypot(u - 84, v - 64) - 14) - 5;
    const aPip = Math.max(clamp(0.5 - d1 * s), clamp(0.5 - d2 * s));
    const bg = [28, 28, 28], fg = [250, 250, 249];
    const col = bg.map((b, i) => Math.round(b + (fg[i] - b) * aPip));
    return [...col, Math.round(255 * aSq)];
  });
  writeFileSync(new URL(`../extension/icons/${size}.png`, import.meta.url), buf);
}
