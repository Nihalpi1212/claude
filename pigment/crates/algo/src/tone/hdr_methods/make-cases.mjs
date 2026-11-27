// Writes js-cases.json beside this file: Pigment 0.4's own HDR Toning results for the methods other
// than Local Adaptation, on a small synthetic image, for `hdr_methods/tests.rs` to compare the Rust
// port with. README.md names the commit the function comes from.
//
//   node make-cases.mjs <path to a checkout's pigment/ folder> <output folder>
//
// hdrToning is imported from src/shared/pixels/hdr.js (pure, no DOM).
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [appArg, outArg] = process.argv.slice(2);
if (!appArg || !outArg) {
  console.error('usage: node make-cases.mjs <checkout>/pigment <output folder>');
  process.exit(2);
}
const { hdrToning } = await import(pathToFileURL(join(resolve(appArg), 'src/shared/pixels/hdr.js')).href);

// mulberry32: a fixed sequence, so the image is the same on every run.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const W = 16, H = 12;
const r = rng(7);
const input = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = (y * W + x) * 4;
  if (y < 4) {
    // a grey ramp, then a warm ramp
    const v = Math.round((x / (W - 1)) * 255);
    input.set(y < 2 ? [v, v, v] : [v, Math.round(v * 0.7), Math.round(v * 0.4)], i);
  } else {
    // random colours, mostly dark (a skewed histogram), a few bright
    const k = r() < 0.8 ? 0.35 : 1;
    input.set([r() * 255 * k, r() * 255 * k, r() * 255 * k].map(Math.round), i);
  }
  input[i + 3] = y === H - 1 && x % 3 === 0 ? 128 : 255;
}
const hex = (d) => Array.from(d, (v) => v.toString(16).padStart(2, '0')).join('');
const cases = [
  ['exposure-gamma', { exposure: 0.7, gamma: 1.4 }],
  ['exposure-gamma', { exposure: -1, gamma: 0.6 }],
  ['highlight-compression', { exposure: 0 }],
  ['highlight-compression', { exposure: 1.5 }],
  ['equalize-histogram', {}],
].map(([method, params]) => {
  const img = { width: W, height: H, data: input.slice() };
  hdrToning(img, { method, ...params });
  return { method, params, output: hex(img.data) };
});
writeFileSync(join(resolve(outArg), 'js-cases.json'), `${JSON.stringify({ width: W, height: H, input: hex(input), cases }, null, 1)}\n`);
