// Generates the test images into tests/fixtures/out (PNG via zlib, PSD via ag-psd). No canvas needed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as agpsd from 'ag-psd';

export const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'out');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Encodes RGBA pixels as a PNG. */
export function encodePng({ width, height, data }) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export function image(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(fn(x, y), (y * width + x) * 4);
  return { width, height, data };
}

export async function makeAll() {
  mkdirSync(OUT_DIR, { recursive: true });
  // 320x200 colour gradient (opaque)
  writeFileSync(join(OUT_DIR, 'gradient.png'), encodePng(image(320, 200, (x, y) => [Math.round((x / 319) * 255), Math.round((y / 199) * 255), 128, 255])));
  // 200x150 transparent background with a red square and a half-transparent blue circle
  writeFileSync(join(OUT_DIR, 'shapes.png'), encodePng(image(200, 150, (x, y) => {
    if (x >= 20 && x < 80 && y >= 20 && y < 80) return [255, 0, 0, 255];
    if ((x - 140) ** 2 + (y - 90) ** 2 < 40 ** 2) return [0, 0, 255, 128];
    return [0, 0, 0, 0];
  })));
  // layered PSD: background, a multiplied half-opacity red box and a hidden green layer
  const w = 120, h = 90;
  const psd = {
    width: w,
    height: h,
    imageData: image(w, h, () => [255, 255, 255, 255]),
    children: [
      { name: 'Background', left: 0, top: 0, imageData: image(w, h, () => [240, 240, 240, 255]) },
      { name: 'Red box', left: 10, top: 12, opacity: 0.5, blendMode: 'multiply', imageData: image(40, 30, () => [255, 0, 0, 255]) },
      { name: 'Hidden green', left: 60, top: 40, hidden: true, imageData: image(30, 20, () => [0, 200, 0, 255]) },
    ],
  };
  writeFileSync(join(OUT_DIR, 'layers.psd'), Buffer.from(agpsd.writePsdUint8Array(psd, { generateThumbnail: false })));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) makeAll().then(() => console.log(`fixtures written to ${OUT_DIR}`));
