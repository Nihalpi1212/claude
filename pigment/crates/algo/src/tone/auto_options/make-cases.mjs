// Writes js-cases.json beside this file: Pigment 0.4's own Auto results (Auto Color Correction
// Options) on small synthetic images, for `auto_options/tests.rs` to compare the Rust port with.
// README.md names the commit the functions come from.
//
//   node make-cases.mjs <path to a checkout's pigment/ folder> <output folder>
//
// autoLevelsParams and autoTonalParams are imported from src/shared/pixels/adjust-tonal.js (pure,
// no DOM). autoBrightnessContrast lives in src/renderer/lib/adjust/simple-editors.js, which imports
// the app's form code, so its source is read out of the file and evaluated on its own.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [appArg, outArg] = process.argv.slice(2);
if (!appArg || !outArg) {
  console.error('usage: node make-cases.mjs <checkout>/pigment <output folder>');
  process.exit(2);
}
const app = resolve(appArg);
const tonal = await import(pathToFileURL(join(app, 'src/shared/pixels/adjust-tonal.js')).href);
const simple = readFileSync(join(app, 'src/renderer/lib/adjust/simple-editors.js'), 'utf8');
const body = simple.slice(simple.indexOf('export function autoBrightnessContrast'), simple.indexOf('export function brightnessContrastEditor'));
const autoBrightnessContrast = new Function('weightedHistogram', `${body.replace('export ', '')}; return autoBrightnessContrast;`)(tonal.weightedHistogram);

// mulberry32: a fixed sequence, so the images are the same on every run.
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
const W = 24, H = 24;
function image(seed, fn) {
  const r = rng(seed);
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [R, G, B, A = 255] = fn(x, y, () => r() * 2 - 1);
    const i = (y * W + x) * 4;
    data[i] = Math.round(R);
    data[i + 1] = Math.round(G);
    data[i + 2] = Math.round(B);
    data[i + 3] = A;
  }
  return { width: W, height: H, data };
}
const hex = (img) => Buffer.from(img.data).toString('hex');

const images = {
  // a warm, low-contrast gradient (about 60..170)
  lowContrast: image(1, (x, y, n) => [80 + x * 3 + n() * 6, 70 + y * 3 + n() * 6, 60 + (x + y) * 1.5 + n() * 6]),
  // a blue cast over a full grey ramp
  cast: image(2, (x, y, n) => {
    const v = 20 + ((x + y * W) / (W * H)) * 215 + n() * 8;
    return [v * 0.85, v * 0.95, Math.min(255, v * 1.1 + 12)];
  }),
  // a dark image (about 5..90)
  dark: image(3, (x, y, n) => [10 + x * 2.5 + n() * 4, 8 + y * 2.8 + n() * 4, 12 + (x + y) * 1.2 + n() * 4]),
  // already spans 0..255 in every channel
  full: image(4, (x, y) => {
    const v = ((x + y * W) / (W * H - 1)) * 255;
    return [v, v, v];
  }),
  // lowContrast with a transparent band (transparent pixels never count)
  holes: image(5, (x, y, n) => (y % 6 === 0 ? [255, 0, 0, 0] : [90 + x * 2 + n() * 5, 85 + y * 2 + n() * 5, 70 + x + n() * 5])),
};

const levelsCases = [
  ['perChannel', 'lowContrast', {}],
  ['mono', 'lowContrast', { algorithm: 'mono' }],
  ['darkLight', 'cast', { algorithm: 'darkLight' }],
  ['darkLight snap', 'cast', { algorithm: 'darkLight', snap: true }],
  ['brightness', 'dark', { algorithm: 'brightness' }],
  ['targets and clips', 'cast', { algorithm: 'perChannel', snap: true, shadowClip: 2, highlightClip: 1.5, shadowColor: '#141e28', midColor: '#8c8080', highlightColor: '#f5ebe1' }],
  ['mono clip 0', 'lowContrast', { algorithm: 'mono', shadowClip: 0, highlightClip: 0 }],
  ['mono clip 2', 'lowContrast', { algorithm: 'mono', shadowClip: 2, highlightClip: 2 }],
  ['brightness snap', 'holes', { algorithm: 'brightness', snap: true }],
  ['mono snap', 'cast', { algorithm: 'mono', snap: true }],
  ['full perChannel', 'full', {}],
  ['clamped options', 'lowContrast', { algorithm: 'nope', shadowClip: 50, highlightClip: -3 }],
];
const curvesCases = [
  ['perChannel curves', 'lowContrast', {}, 'rgb'],
  ['brightness curves', 'dark', { algorithm: 'brightness' }, 'rgb'],
  ['darkLight gray', 'cast', { algorithm: 'darkLight' }, 'gray'],
];
const out = {
  images: Object.fromEntries(Object.entries(images).map(([k, img]) => [k, { width: img.width, height: img.height, rgba: hex(img) }])),
  levels: levelsCases.map(([name, img, options]) => ({ name, image: img, options, result: tonal.autoLevelsParams(images[img], options) })),
  curves: curvesCases.map(([name, img, options, space]) => ({ name, image: img, options, space, result: tonal.autoTonalParams(space === 'gray' ? 'levels' : 'curves', images[img], options, space) })),
  brightnessContrast: ['dark', 'lowContrast', 'full', 'holes'].map((img) => ({ image: img, result: autoBrightnessContrast(images[img]) })),
  defaults: tonal.AUTO_DEFAULTS,
  clamped: tonal.autoOptions({ algorithm: 'nope', shadowClip: 50, highlightClip: -3 }),
};
writeFileSync(join(resolve(outArg), 'js-cases.json'), JSON.stringify(out, null, 1) + '\n');
