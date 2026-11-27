// Writes js-source.json (a small synthetic 8-bit image, as RGBA hex) and js-statistics.json (the file the
// JavaScript Pigment 0.4's Match Color › Save Statistics… writes for it) beside this file, for
// `match_statistics/tests.rs`. README.md names the commit the functions come from.
//
//   node make-fixture.mjs <path to a checkout's pigment/ folder> <output folder>
//
// labStatistics is imported from src/shared/pixels/adjust-more.js (pure, no DOM); the rounding and the file's
// body are matchColorEditor's (src/renderer/lib/adjust-more-ui.js `roundStats` and the Save button), restated
// here because that module needs the app's DOM.
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [appArg, outArg] = process.argv.slice(2);
if (!appArg || !outArg) {
  console.error('usage: node make-fixture.mjs <checkout>/pigment <output folder>');
  process.exit(2);
}
const { labStatistics } = await import(pathToFileURL(join(resolve(appArg), 'src/shared/pixels/adjust-more.js')).href);

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
const W = 12, H = 10;
const r = rng(11);
const data = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = (y * W + x) * 4;
  // a saturated sunset, oranges darkening downwards, so the two apps' white points tell apart
  const k = 1 - (y / H) * 0.5;
  const base = [235 * k, 120 * k, 40 * k];
  data.set(base.map((v) => Math.max(0, Math.min(255, Math.round(v + (r() - 0.5) * 40)))), i);
  data[i + 3] = 255;
}
const img = { width: W, height: H, data };
const s = labStatistics(img);
const roundStats = (s) => ({ mean: s.mean.map((v) => Math.round(v * 1000) / 1000), std: s.std.map((v) => Math.round(v * 1000) / 1000) });
const source = roundStats(s);
const body = { format: 'pigment-match-color-statistics', version: 1, name: 'Sunset', mean: source.mean, std: source.std };
const out = resolve(outArg);
writeFileSync(join(out, 'js-statistics.json'), JSON.stringify(body, null, 2));
const hex = Array.from(data, (v) => v.toString(16).padStart(2, '0')).join('');
writeFileSync(join(out, 'js-source.json'), `${JSON.stringify({ width: W, height: H, rgba: hex })}\n`);
