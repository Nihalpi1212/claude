// Writes js-cases.txt beside this file: Pigment 0.4's own Color and Vibrance, Clarity and Dehaze and
// Grain results on a small synthetic image, for `adjust_extra/tests.rs` to compare the Rust port with.
// README.md names the commit the functions come from.
//
//   node make-cases.mjs <path to a checkout's pigment/ folder> <output folder>
//
// applyAdjustment and grainNoise are imported from src/shared/pixels/adjust.js and adjust-color.js
// (pure, no DOM).
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [appArg, outArg] = process.argv.slice(2);
if (!appArg || !outArg) {
  console.error('usage: node make-cases.mjs <checkout>/pigment <output folder>');
  process.exit(2);
}
const app = resolve(appArg);
const adjust = await import(pathToFileURL(join(app, 'src/shared/pixels/adjust.js')).href);
const color = await import(pathToFileURL(join(app, 'src/shared/pixels/adjust-color.js')).href);

// The image `tests.rs` builds the same way: 32 x 24, opaque, busy enough for Clarity's blur.
const W = 32, H = 24;
function image() {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      data[i] = (x * 37 + y * 11) & 255;
      data[i + 1] = (x * 5 + y * 23 + 40) & 255;
      data[i + 2] = ((x ^ y) * 9) & 255;
      data[i + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}
const hex = (d) => Buffer.from(d).toString('hex');

const cases = [
  ['clarity-dehaze', { clarity: 60, dehaze: 0 }],
  ['clarity-dehaze', { clarity: -50, dehaze: 0 }],
  ['clarity-dehaze', { clarity: 0, dehaze: 50 }],
  ['clarity-dehaze', { clarity: 40, dehaze: -40 }],
  ['grain', { amount: 50, size: 25, roughness: 50 }, { origin: { x: 100, y: 37 } }],
  ['grain', { amount: 80, size: 0, roughness: 0 }],
  ['grain', { amount: 30, size: 100, roughness: 100 }, { origin: { x: -7, y: 3 } }],
  ['color-vibrance', { temperature: 50, tint: 0 }],
  ['color-vibrance', { temperature: -30, tint: 40 }],
].map(([kind, params, ctx = null]) => {
  const img = image();
  adjust.applyAdjustment(img, kind, params, null, ctx);
  return { kind, params, origin: ctx ? [ctx.origin.x, ctx.origin.y] : [0, 0], out: hex(img.data) };
});

const noise = [];
for (const [x, y, cell, rough] of [[0, 0, 1, 0], [5, 9, 1, 0.5], [-3, 17, 2.5625, 0], [100, -40, 2.5625, 0.5], [12345, 678, 7.25, 1], [-999, -999, 3, 0.25]]) {
  noise.push({ x, y, cell, roughness: rough, value: color.grainNoise(x, y, cell, rough) });
}

// Plain lines (compose has no JSON reader): `input <hex>`, `case <kind> <key=value,...> <origin x,y> <hex>`,
// `noise <x> <y> <cell> <roughness> <value>`.
const lines = [`size ${W} ${H}`, `input ${hex(image().data)}`];
for (const c of cases) lines.push(`case ${c.kind} ${Object.entries(c.params).map(([k, v]) => `${k}=${v}`).join(',')} ${c.origin.join(',')} ${c.out}`);
for (const n of noise) lines.push(`noise ${n.x} ${n.y} ${n.cell} ${n.roughness} ${n.value}`);
writeFileSync(join(resolve(outArg), 'js-cases.txt'), lines.join('\n') + '\n');
