// Writes the `.pigment` fixtures of this folder with the JavaScript Pigment's own writer
// (`writePigment` in src/renderer/lib/io.js), run under Node with @napi-rs/canvas standing in
// for the browser's canvas. README.md says which checkout writes which files and how to run it.
//
//   node make-fixtures.mjs <path to a checkout's pigment/ folder> <v1|v2|v3|wip05> <output folder>
//
// The documents are built the way the app builds them: its layer classes, its Selection, its
// document store, and (for the image modes) its own pixel conversion, `convertPixels`, with the
// document fields set as `convertDocument` in lib/modes.js sets them. Nothing here writes a ZIP
// or a document.json by hand.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [appArg, set, outArg] = process.argv.slice(2);
if (!appArg || !['v1', 'v2', 'v3', 'wip05'].includes(set) || !outArg) {
  console.error('usage: node make-fixtures.mjs <checkout>/pigment <v1|v2|v3|wip05> <output folder>');
  process.exit(2);
}
const app = resolve(appArg);
const out = resolve(outArg);
mkdirSync(out, { recursive: true });

// The canvas: the writer only needs createElement('canvas'), a 2D context, toBlob and ImageData.
const napi = createRequire(join(process.cwd(), 'x.js'))('@napi-rs/canvas');
globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') throw new Error(`make-fixtures: the writer asked for <${tag}>`);
    return napi.createCanvas(1, 1);
  },
};
globalThis.ImageData ??= napi.ImageData;
// What the app's compositor draws shapes and patterns with (make-fixtures-layers.mjs).
globalThis.DOMMatrix ??= napi.DOMMatrix;
globalThis.DOMPoint ??= napi.DOMPoint;
globalThis.Path2D ??= napi.Path2D;

const lib = (p) => import(pathToFileURL(join(app, 'src', p)).href);
const io = await lib('renderer/lib/io.js');
const D = await lib('renderer/lib/document.js');
const { Selection } = await lib('renderer/lib/selection.js');
const { Document, RasterLayer, GroupLayer, createCanvas } = D;

// ---- pixels the tests know ---------------------------------------------------------------------

/** The colour of pixel (x, y) of the test pattern: opaque, every channel different. */
const patternPixel = (x, y) => [(x * 37 + 11) & 255, (y * 53 + 29) & 255, ((x + y) * 17 + 5) & 255, 255];

function canvasFrom(width, height, pixel) {
  const c = createCanvas(width, height);
  const img = new ImageData(width, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) img.data.set(pixel(x, y), (y * width + x) * 4);
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
}

function add(parent, layer) {
  parent.children.push(layer); // bottom to top, as the app keeps them
  layer.parent = parent;
  return layer;
}

function background(doc, color = [255, 255, 255, 255]) {
  return add(doc.root, new RasterLayer({ name: 'Background', canvas: canvasFrom(doc.width, doc.height, () => color), x: 0, y: 0 }));
}

/** A document-sized mask canvas: grey in RGB, opaque, as lib/layer-ops.js makes them. */
const maskCanvas = (doc, value) => canvasFrom(doc.width, doc.height, (x, y) => { const v = value(x, y); return [v, v, v, 255]; });

async function save(name, doc) {
  const bytes = await io.writePigment(doc);
  writeFileSync(join(out, `${name}.pigment`), bytes);
  console.log(`${name}.pigment  ${bytes.length} bytes`);
}

// ---- the documents -----------------------------------------------------------------------------

/** A raster layer away from the origin, with every layer property set to something else than the default. */
async function rasterOffset() {
  const doc = new Document({ width: 16, height: 12, dpi: 144, name: 'Raster offset' });
  background(doc);
  const paint = add(doc.root, new RasterLayer({ name: 'Paint', canvas: canvasFrom(6, 5, patternPixel), x: 3, y: 2, opacity: 0.6, fillOpacity: 0.8, blend: 'multiply' }));
  paint.locked = { pixels: true, position: false, transparency: true, all: false };
  // half transparent pure colours survive the canvas's premultiplied storage exactly
  add(doc.root, new RasterLayer({ name: 'Half', canvas: canvasFrom(4, 4, (x) => (x < 2 ? [255, 0, 0, 128] : [0, 0, 255, 0])), x: -2, y: 9, clip: true, visible: false }));
  // partly outside the canvas on the right and at the bottom
  const top = add(doc.root, new RasterLayer({ name: 'Corner', canvas: canvasFrom(4, 4, () => [0, 128, 255, 255]), x: 14, y: 10, blend: 'linear-dodge' }));
  top.locked = { pixels: false, position: true, transparency: false, all: true };
  doc.active = paint;
  await save(`${set}-raster-offset`, doc);
}

async function groups() {
  const doc = new Document({ width: 8, height: 8, name: 'Groups' });
  background(doc);
  const outer = add(doc.root, new GroupLayer({ name: 'Outer' })); // pass-through, expanded
  add(outer, new RasterLayer({ name: 'Red', canvas: canvasFrom(8, 8, () => [255, 0, 0, 255]), x: 0, y: 0 }));
  const inner = add(outer, new GroupLayer({ name: 'Inner', blend: 'normal', opacity: 0.5, expanded: false }));
  add(inner, new RasterLayer({ name: 'Green', canvas: canvasFrom(4, 4, () => [0, 255, 0, 255]), x: 2, y: 2 }));
  add(inner, new RasterLayer({ name: 'Blue', canvas: canvasFrom(2, 2, () => [0, 0, 255, 255]), x: 5, y: 5, blend: 'screen' }));
  add(outer, new GroupLayer({ name: 'Empty', blend: 'multiply', visible: false }));
  add(doc.root, new RasterLayer({ name: 'Top', canvas: canvasFrom(1, 1, () => [0, 0, 0, 255]), x: 7, y: 0 }));
  doc.active = inner;
  await save(`${set}-groups`, doc);
}

async function masks() {
  const doc = new Document({ width: 8, height: 8, name: 'Masks' });
  background(doc);
  const ramp = (x) => x * 36; // 0, 36 ... 252
  const a = add(doc.root, new RasterLayer({ name: 'Ramp mask', canvas: canvasFrom(8, 8, () => [255, 0, 0, 255]), x: 0, y: 0 }));
  a.mask = { canvas: maskCanvas(doc, ramp), enabled: true, linked: true };
  if (set !== 'v1' && set !== 'v2') Object.assign(a.mask, { density: 0.5, feather: 2.5 }); // 0.4's mask properties
  const b = add(doc.root, new RasterLayer({ name: 'Disabled unlinked mask', canvas: canvasFrom(4, 4, () => [0, 0, 255, 255]), x: 2, y: 2 }));
  b.mask = { canvas: maskCanvas(doc, (x, y) => (y < 4 ? 255 : 0)), enabled: false, linked: false };
  const g = add(doc.root, new GroupLayer({ name: 'Masked group' }));
  g.mask = { canvas: maskCanvas(doc, (x) => (x < 4 ? 0 : 255)), enabled: true, linked: true };
  add(g, new RasterLayer({ name: 'Inside', canvas: canvasFrom(8, 2, () => [0, 255, 0, 255]), x: 0, y: 6 }));
  await save(`${set}-masks`, doc);
}

async function selectionChannels() {
  const doc = new Document({ width: 8, height: 6, name: 'Selection and channels' });
  background(doc);
  const n = doc.width * doc.height;
  const sel = new Uint8ClampedArray(n);
  for (let y = 0; y < doc.height; y++) for (let x = 0; x < doc.width; x++) sel[y * doc.width + x] = x >= 2 && x < 6 && y >= 1 && y < 4 ? (x === 2 ? 128 : 255) : 0;
  doc.selection = Selection.fromMask(doc.width, doc.height, sel);
  const ch1 = new Uint8ClampedArray(n), ch2 = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) {
    ch1[i] = (i * 5) & 255;
    ch2[i] = i % doc.width < 4 ? 255 : 0;
  }
  doc.channels.push({ id: 'Ca', name: 'Alpha 1', mask: ch1 }, { id: 'Cb', name: 'Left half', mask: ch2 });
  await save(`${set}-selection-channels`, doc);
}

async function guidesPaths() {
  const doc = new Document({ width: 32, height: 24, name: 'Guides and paths' });
  background(doc);
  const guides = [{ axis: 'x', pos: 8 }, { axis: 'y', pos: 12.5 }, { axis: 'x', pos: 20 }];
  if (set === 'v3') {
    guides[2].color = '#ff8000'; // a guide with its own colour (0.4)
    guides.push({ axis: 'y', pos: 3, artboard: 'A1' });
    doc.store.setRaw('rulerOrigin', { x: 4, y: 6 });
  }
  doc.guides = guides;
  const triangle = { closed: true, points: [{ x: 2, y: 2 }, { x: 14, y: 2 }, { x: 8, y: 12 }] };
  const curve = { closed: false, points: [{ x: 4, y: 20, outX: 8, outY: 14 }, { x: 16, y: 20, inX: 12, inY: 14, outX: 20, outY: 26 }, { x: 28, y: 20, inX: 24, inY: 26 }] };
  const hole = { closed: true, op: 'subtract', points: [{ x: 6, y: 4 }, { x: 10, y: 4 }, { x: 8, y: 8 }] };
  doc.paths = [
    { id: 'P1', name: 'Triangle with a hole', path: { subpaths: [triangle, hole] } },
    { id: 'P2', name: 'Curve', path: { subpaths: [curve] } },
  ];
  doc.workPath = { subpaths: [{ closed: true, points: [{ x: 20, y: 2 }, { x: 30, y: 2 }, { x: 30, y: 10 }, { x: 20, y: 10 }] }] };
  doc.globalLight = { angle: 45, altitude: 60 };
  await save(`${set}-guides-paths`, doc);
}

/** Layer colour labels and link sets (lib/layers-extras/tags.js keeps them in meta.layerTags) and File Info. */
async function tagsInfo() {
  const doc = new Document({ width: 8, height: 8, name: 'Tags and info' });
  background(doc);
  const names = ['Red', 'Orange', 'Yellow', 'Green', 'Blue', 'Violet', 'Gray', 'Plain'];
  const layers = names.map((name, i) => add(doc.root, new RasterLayer({ name, canvas: canvasFrom(1, 1, () => [i * 30, 0, 0, 255]), x: i, y: 0 })));
  layers.forEach((l, i) => {
    if (i < 7) l.color = names[i].toLowerCase();
  });
  layers[0].linked = 'K1';
  layers[2].linked = 'K1';
  layers[3].linked = 'K2';
  layers[7].linked = 'K2';
  layers[5].linked = 'K3'; // alone in its set: the app drops such a link when it opens the file
  const tags = await lib('renderer/lib/layers-extras/tags.js').catch(() => null);
  doc.meta = {
    title: 'A title',
    author: 'An author',
    description: 'A description\nin two lines',
    copyright: '© 2026 Somebody',
    keywords: ['one', 'two', 'three'],
    rating: 4,
    credit: 'A credit',
    source: 'A source',
    copyrightStatus: 'copyrighted',
    copyrightUrl: 'https://example.com/rights',
    url: 'https://example.com/ignored',
    // the object readExif() of lib/file-info.js makes of a photograph's EXIF block
    exif: { make: 'Camera maker', model: 'Camera model', lens: '35mm F2.8', iso: 200, exposureTime: 0.004, fNumber: 2.8, focalLength: 35, focalLength35: 52, dateTimeOriginal: '2026:01:02 03:04:05' },
  };
  if (tags?.syncTags) tags.syncTags(doc);
  else doc.meta.layerTags = Object.fromEntries(layers.filter((l) => l.color || l.linked).map((l) => [l.id, { ...(l.color ? { color: l.color } : {}), ...(l.linked ? { linked: l.linked } : {}) }]));
  await save(`${set}-tags-info`, doc);
}

// ---- 0.3 and later: bit depth and image modes ----------------------------------------------------

async function deep(type) {
  const { createDeep } = await lib('shared/pixels/deep.js');
  const bits = type === 'u16' ? 16 : 32;
  const doc = new Document({ width: 8, height: 4, name: `Deep ${bits}`, depth: bits });
  // values an 8-bit file cannot hold: the proxy canvas is their rounding, as lib/depth.js keeps it
  const sample = (x, y, c) => (type === 'u16' ? (x * 8000 + y * 300 + c * 77 + 1) & 65535 : x / 7 + y * 0.001 + c * 0.0001 + (x === 7 && c === 0 ? 1.5 : 0));
  const make = (name, w, h, lx, ly, alpha) => {
    const planes = createDeep(w, h, type);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) planes.data[i + c] = sample(x, y, c);
      planes.data[i + 3] = alpha(x, y);
    }
    const q = (v) => (type === 'u16' ? Math.floor((v + 128) / 257) : v >= 1 ? 255 : v > 0 ? Math.floor(v * 255 + 0.5) : 0);
    const canvas = canvasFrom(w, h, (x, y) => [0, 1, 2, 3].map((c) => q(planes.data[(y * w + x) * 4 + c])));
    return add(doc.root, new RasterLayer({ name, canvas, x: lx, y: ly, deep: { type, data: planes.data } }));
  };
  const one = type === 'u16' ? 65535 : 1;
  make('Deep background', 8, 4, 0, 0, () => one);
  make('Deep offset', 3, 2, 4, 1, (x) => (x === 0 ? one / 2 : one));
  // a layer of the same document without deep pixels (pasted from an 8-bit source before lib/depth.js caught up)
  add(doc.root, new RasterLayer({ name: 'Proxy only', canvas: canvasFrom(2, 2, () => [10, 20, 30, 255]), x: 0, y: 2 }));
  await save(`${set}-deep-${type}`, doc);
}

/** One background layer converted from RGB by the app's pixel conversion, with the fields convertDocument sets. */
async function mode(to, options = {}) {
  const M = await lib('shared/pixels/modes.js');
  const doc = new Document({ width: 8, height: 8, name: `Mode ${to}` });
  const src = canvasFrom(8, 8, (x, y) => (to === 'indexed' ? [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]][(x >> 1) % 4].concat(x === 7 && y === 7 ? 0 : 255) : [x * 36, y * 36, (x + y) * 18, 255]));
  const layer = add(doc.root, new RasterLayer({ name: 'Background', canvas: src, x: 0, y: 0 }));
  const image = (c) => c.getContext('2d').getImageData(0, 0, c.width, c.height);
  const state = { colorTable: null, transparentIndex: -1, duotone: null, multichannel: null };
  const chain = M.conversionPath('rgb', to);
  for (let i = 1; i < chain.length; i++) {
    const step = chain[i];
    const opts = { ...(step === to ? options : {}), source: { ...state } };
    if (step === 'duotone') {
      state.duotone = M.normalizeDuotone(opts.duotone ?? M.DUOTONE_PRESETS[1]);
      opts.duotone = state.duotone;
    }
    const res = M.convertPixels(image(layer.canvas), chain[i - 1], step, opts);
    const c = createCanvas(res.width, res.height);
    c.getContext('2d').putImageData(new ImageData(res.data instanceof Uint8ClampedArray ? res.data : new Uint8ClampedArray(res.data), res.width, res.height), 0, 0);
    layer.canvas = c;
    const extra = {};
    if (res.colorTable) {
      state.colorTable = res.colorTable.map((e) => [e[0], e[1], e[2]]);
      if (res.transparentIndex >= 0) extra.transparentIndex = res.transparentIndex;
      state.transparentIndex = res.transparentIndex ?? -1;
    }
    if (res.channels) {
      // Multichannel: the inks become spot channels; their flags travel in meta.imageMode (lib/modes.js)
      const spots = {};
      doc.channels = res.channels.map((c, k) => {
        const ch = { id: `C${k + 1}`, name: c.name, mask: c.data, spot: { key: c.key, color: c.color } };
        spots[ch.id] = { key: c.key, color: c.color };
        return ch;
      });
      extra.multichannel = { source: res.multichannel.source, duotone: res.multichannel.duotone ?? null, spots };
    }
    doc.mode = step;
    doc.colorTable = step === 'indexed' ? state.colorTable : null;
    doc.duotone = step === 'duotone' ? state.duotone : null;
    doc.meta = Object.keys(extra).length ? { imageMode: extra } : {};
  }
  if (to === 'multichannel') {
    // a saved alpha channel next to the inks
    const alpha = new Uint8ClampedArray(64);
    for (let i = 0; i < 64; i++) alpha[i] = i * 4;
    doc.channels.push({ id: 'Ca', name: 'Alpha 1', mask: alpha });
  }
  await save(`${set}-mode-${to}`, doc);
}

/** CMYK and Lab documents: the app kept RGB pixels and a mode flag. */
async function modeFlag(to) {
  const doc = new Document({ width: 4, height: 4, name: `Mode ${to}`, mode: to });
  add(doc.root, new RasterLayer({ name: 'Background', canvas: canvasFrom(4, 4, patternPixel), x: 0, y: 0 }));
  await save(`${set}-mode-${to}`, doc);
}

// ---- the unfinished 0.5 (never released): a document profile ---------------------------------------

/**
 * A profile described in document.json with its bytes in profile.icc, and one described only (a built-in the
 * reader finds by its id). The records are what lib/color/cmm.js makes of the built-in definitions.
 */
async function profile() {
  const { BUILTIN_DEFS, builtinIcc } = await lib('renderer/lib/color/profiles.js');
  const def = BUILTIN_DEFS.find((d) => d.id === 'display-p3');
  const p3 = { id: def.id, name: def.name, bytes: builtinIcc(def.id), colorSpace: def.space, wellKnown: def.wellKnown, source: 'builtin' };
  const doc = new Document({ width: 4, height: 4, name: 'Profile' });
  background(doc, [200, 100, 50, 255]);
  doc.profile = p3;
  await save(`${set}-profile`, doc);
  const adobe = BUILTIN_DEFS.find((d) => d.id === 'adobe-rgb');
  const doc2 = new Document({ width: 4, height: 4, name: 'Profile by id' });
  background(doc2, [200, 100, 50, 255]);
  doc2.profile = { id: adobe.id, name: adobe.name, bytes: null, colorSpace: adobe.space, wellKnown: adobe.wellKnown, source: 'builtin' };
  await save(`${set}-profile-id-only`, doc2);
}

// ---- which checkout writes what ------------------------------------------------------------------

if (set === 'wip05') await profile();
else {
  await rasterOffset();
  await groups();
  await masks();
  await selectionChannels();
  await guidesPaths();
  await tagsInfo();
  if (set !== 'v1') {
    await deep('u16');
    await deep('f32');
    await mode('grayscale');
    await mode('indexed', { colors: 8, palette: 'exact', transparency: true, dither: 'none' });
    await mode('duotone');
    await mode('bitmap', { method: '50-threshold' });
    await mode('multichannel');
    await modeFlag('cmyk');
    await modeFlag('lab');
  }
  // adjustment, fill and shape layers, vector masks, layer styles, advanced blending
  const { default: layerFixtures } = await import('./make-fixtures-layers.mjs');
  await layerFixtures({ set, lib, out, io, D, add, canvasFrom, background, save });
}
