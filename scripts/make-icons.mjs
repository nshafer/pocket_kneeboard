// Draws the toolbar icon (a clipboard with a form on it) as PNGs in public/icon/.
// Run: node scripts/make-icons.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** Signed distance to a rounded box, in a 0..1 square. */
const rbox = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};

// Shapes painted in order: [distance fn, colour].
const shapes = [
  [(x, y) => rbox(x, y, 0.5, 0.54, 0.4, 0.45, 0.07), hex('#6b5440')], // board
  [(x, y) => rbox(x, y, 0.5, 0.57, 0.31, 0.36, 0.02), hex('#f5f1e4')], // paper
  [(x, y) => rbox(x, y, 0.5, 0.36, 0.25, 0.022, 0.01), hex('#1f2a44')], // header bar
  [(x, y) => rbox(x, y, 0.5, 0.5, 0.24, 0.016, 0.01), hex('#1d3c9c')], // pen lines
  [(x, y) => rbox(x, y, 0.46, 0.62, 0.2, 0.016, 0.01), hex('#1d3c9c')],
  [(x, y) => rbox(x, y, 0.5, 0.74, 0.24, 0.016, 0.01), hex('#1d3c9c')],
  [(x, y) => Math.hypot(x - 0.7, y - 0.83) - 0.055, hex('#b4271f')], // bubble
  [(x, y) => rbox(x, y, 0.5, 0.14, 0.2, 0.08, 0.04), hex('#b9bcc2')], // clip
  [(x, y) => rbox(x, y, 0.5, 0.11, 0.08, 0.03, 0.02), hex('#6b5440')],
];

function png(size) {
  const ss = 4;
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = [0];
    for (let px = 0; px < size; px++) {
      let [r, g, b, a] = [0, 0, 0, 0];
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          let c = null;
          for (const [d, col] of shapes) if (d(x, y) <= 0) c = col;
          if (c) (r += c[0]), (g += c[1]), (b += c[2]), (a += 255);
        }
      const n = ss * ss;
      const k = a ? (n * 255) / a : 0;
      row.push(Math.round((r / n) * k), Math.round((g / n) * k), Math.round((b / n) * k), Math.round(a / n));
    }
    rows.push(Buffer.from(row));
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

mkdirSync('public/icon', { recursive: true });
for (const s of [16, 32, 48, 128]) writeFileSync(`public/icon/${s}.png`, png(s));
console.log('icons written');
