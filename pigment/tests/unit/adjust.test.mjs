import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADJUSTMENTS, ADJUSTMENT_KINDS, applyAdjustment, histogram, autoLevels, autoContrast, autoColor, levelsLut, curveLut,
} from '../../src/shared/pixels/adjust.js';
import { createImage, cloneImage, getPixel, setPixel, applyLut, luminance, randomSeeded } from '../../src/shared/pixels/core.js';
import { rgbToHsl } from '../../src/shared/pixels/color.js';
import { gradientImage, quadrantImage, solidImage, assertPixel, assertNear } from './helpers.mjs';

const EXPECTED_KINDS = [
  'brightness-contrast', 'levels', 'curves', 'exposure', 'vibrance', 'hue-saturation', 'color-balance', 'black-white',
  'photo-filter', 'channel-mixer', 'invert', 'posterize', 'threshold', 'gradient-map', 'selective-color', 'desaturate',
  'equalize', 'shadows-highlights',
];
const LUT_KINDS = ['brightness-contrast', 'levels', 'curves', 'exposure', 'invert', 'posterize'];
/** Kinds whose parameters measure a change from neutral: their defaults must be the identity. */
const IDENTITY_DEFAULTS = [
  'brightness-contrast', 'levels', 'curves', 'exposure', 'vibrance', 'hue-saturation', 'color-balance', 'photo-filter',
  'channel-mixer', 'selective-color', 'shadows-highlights',
];
/** Non-default params that visibly change a colourful image, per kind (for rect / alpha tests). */
const ACTIVE_PARAMS = {
  'brightness-contrast': { brightness: 60, contrast: 40 },
  levels: { rgb: { inBlack: 40, inWhite: 200, gamma: 1.5 } },
  curves: { rgb: [[0, 30], [128, 200], [255, 230]] },
  exposure: { exposure: 1.5 },
  vibrance: { vibrance: 80, saturation: 30 },
  'hue-saturation': { hue: 90, saturation: 40, lightness: 10 },
  'color-balance': { midtones: [60, -30, -60] },
  'black-white': {},
  'photo-filter': { density: 80 },
  'channel-mixer': { r: { r: 0, g: 0, b: 100 } },
  invert: {},
  posterize: { levels: 3 },
  threshold: { level: 100 },
  'gradient-map': { stops: [{ offset: 0, color: '#200040' }, { offset: 1, color: '#ffe080' }] },
  'selective-color': { reds: { c: -50, m: 40, y: 40, k: 20 }, neutrals: { c: 30, m: 0, y: -30, k: 0 } },
  desaturate: {},
  equalize: {},
  'shadows-highlights': { shadows: 80, highlights: 60, radius: 2 },
};

/** A deterministic colourful 8x8 image (alpha 255 unless given). */
function noiseImage(w = 8, h = 8, seed = 7, alpha = 255) {
  const img = createImage(w, h);
  const rnd = randomSeeded(seed);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = Math.floor(rnd() * 256);
    img.data[i + 1] = Math.floor(rnd() * 256);
    img.data[i + 2] = Math.floor(rnd() * 256);
    img.data[i + 3] = alpha;
  }
  return img;
}

/** Applies kind to a 1x1 image of rgba and returns the resulting pixel. */
function px(rgba, kind, params = {}) {
  const img = createImage(1, 1, rgba);
  applyAdjustment(img, kind, params);
  return getPixel(img, 0, 0);
}

const lumaOf = (p) => luminance(p[0], p[1], p[2]);

test('ADJUSTMENTS lists every kind of the contract with name, defaults and apply', () => {
  assert.deepEqual([...ADJUSTMENT_KINDS].sort(), [...EXPECTED_KINDS].sort());
  for (const kind of EXPECTED_KINDS) {
    const def = ADJUSTMENTS[kind];
    assert.equal(typeof def.name, 'string', kind);
    assert.ok(def.name.length > 0, kind);
    assert.equal(typeof def.defaults, 'object', kind);
    assert.equal(typeof def.apply, 'function', kind);
  }
  for (const kind of LUT_KINDS) {
    const luts = ADJUSTMENTS[kind].lut(ACTIVE_PARAMS[kind]);
    assert.equal(luts.length, 3, kind);
    for (const l of luts) {
      assert.ok(l instanceof Uint8ClampedArray, kind);
      assert.equal(l.length, 256, kind);
    }
    // apply() is exactly applyLut over lut(params).
    const a = noiseImage(), b = cloneImage(a);
    ADJUSTMENTS[kind].apply(a, ACTIVE_PARAMS[kind]);
    applyLut(b, ...luts);
    assert.deepEqual(a.data, b.data, kind);
  }
  assert.throws(() => applyAdjustment(createImage(1, 1), 'nope', {}), RangeError);
  assert.throws(() => applyAdjustment(createImage(1, 1), 'toString', {}), RangeError);
});

test('every kind runs with its defaults on an 8x8 image; parameter-driven defaults are the identity', () => {
  for (const kind of EXPECTED_KINDS) {
    const img = noiseImage();
    const before = cloneImage(img);
    const out = applyAdjustment(img, kind);
    assert.equal(out, img, `${kind} returns the image`);
    assert.equal(img.data.length, 8 * 8 * 4);
    for (let i = 3; i < img.data.length; i += 4) assert.equal(img.data[i], 255, `${kind} alpha`);
    if (IDENTITY_DEFAULTS.includes(kind)) assert.deepEqual(img.data, before.data, `${kind} defaults are identity`);
    // Explicit defaults, {} and undefined params all agree.
    const viaDefaults = cloneImage(before);
    ADJUSTMENTS[kind].apply(viaDefaults, ADJUSTMENTS[kind].defaults);
    assert.deepEqual(viaDefaults.data, img.data, `${kind} explicit defaults`);
    const viaEmpty = cloneImage(before);
    applyAdjustment(viaEmpty, kind, {});
    assert.deepEqual(viaEmpty.data, img.data, `${kind} empty params`);
  }
  // The defaults objects are not mutated by applying.
  const snapshot = JSON.stringify(Object.fromEntries(EXPECTED_KINDS.map((k) => [k, ADJUSTMENTS[k].defaults])));
  for (const kind of EXPECTED_KINDS) applyAdjustment(noiseImage(), kind, ACTIVE_PARAMS[kind]);
  assert.equal(JSON.stringify(Object.fromEntries(EXPECTED_KINDS.map((k) => [k, ADJUSTMENTS[k].defaults]))), snapshot);
});

test('brightness/contrast: brightness moves mid grey, contrast 0 is identity, contrast spreads tones', () => {
  const up = px([128, 128, 128, 1], 'brightness-contrast', { brightness: 50 });
  assert.ok(up[0] > 145 && up[0] < 175, `+50 -> ${up[0]}`);
  assert.equal(up[0], up[1]);
  assert.equal(up[1], up[2]);
  const down = px([128, 128, 128, 1], 'brightness-contrast', { brightness: -50 });
  assert.ok(down[0] < 112 && down[0] > 80, `-50 -> ${down[0]}`);
  // Endpoints stay fixed in the default (non-legacy) mode.
  const [lut] = ADJUSTMENTS['brightness-contrast'].lut({ brightness: 100 });
  assert.equal(lut[0], 0);
  assert.equal(lut[255], 255);
  for (let v = 1; v < 256; v++) assert.ok(lut[v] >= lut[v - 1], 'monotone');
  // Contrast 0 (with or without legacy) is exactly the identity.
  for (const legacy of [false, true]) {
    const [l] = ADJUSTMENTS['brightness-contrast'].lut({ contrast: 0, brightness: 0, legacy });
    for (let v = 0; v < 256; v++) assert.equal(l[v], v, `legacy ${legacy} v ${v}`);
  }
  const c = px([64, 128, 192, 1], 'brightness-contrast', { contrast: 50 });
  assert.ok(c[0] < 64 && c[2] > 192, `contrast spreads ${c}`);
  assertNear(c[1], 128, 1);
  const flat = px([20, 128, 240, 1], 'brightness-contrast', { contrast: -100 });
  assertPixel(flat, [128, 128, 128, 1], 1, 'contrast -100 flattens to mid grey');
  // Legacy brightness is a plain offset.
  assertPixel(px([100, 150, 250, 1], 'brightness-contrast', { brightness: 20, legacy: true }), [120, 170, 255, 1], 0);
});

test('levels: input/output points, gamma 2 on 128 gives ~181, per-channel tables', () => {
  const lut = levelsLut({ inBlack: 50, inWhite: 200 });
  assert.equal(lut[0], 0);
  assert.equal(lut[50], 0);
  assert.equal(lut[200], 255);
  assert.equal(lut[255], 255);
  assertNear(lut[125], 127.5, 1);
  const out = levelsLut({ outBlack: 20, outWhite: 220 });
  assert.equal(out[0], 20);
  assert.equal(out[255], 220);
  assertNear(out[128], 20 + (128 / 255) * 200, 1);
  assertNear(levelsLut({ gamma: 2 })[128], 181, 1);
  assert.ok(levelsLut({ gamma: 0.5 })[128] < 70, 'gamma < 1 darkens');
  // Through the registry: rgb plus a red-only table (applied before rgb).
  const img = solidImage(2, 2, [100, 100, 100, 1]);
  applyAdjustment(img, 'levels', { rgb: { gamma: 2 }, r: { inWhite: 200 } });
  const p = getPixel(img, 1, 1);
  assertNear(p[0], levelsLut({ gamma: 2 })[levelsLut({ inWhite: 200 })[100]], 0);
  assertNear(p[1], levelsLut({ gamma: 2 })[100], 0);
  assert.equal(p[1], p[2]);
  // perChannel === false ignores the per-channel tables.
  const off = px([100, 100, 100, 1], 'levels', { perChannel: false, r: { inWhite: 50 } });
  assertPixel(off, [100, 100, 100, 1], 0);
  // Degenerate input range becomes a hard threshold instead of dividing by zero.
  const hard = levelsLut({ inBlack: 128, inWhite: 128 });
  assert.equal(hard[127], 0);
  assert.equal(hard[129], 255);
});

test('curves: identity, a raised midpoint maps 128 -> 200 and stays monotone, per-channel curves', () => {
  const id = curveLut([[0, 0], [255, 255]]);
  for (let v = 0; v < 256; v++) assert.equal(id[v], v);
  assert.deepEqual(curveLut([]), id);
  assert.deepEqual(curveLut(null), id);
  const lut = curveLut([[0, 0], [128, 200], [255, 255]]);
  assert.equal(lut[0], 0);
  assert.equal(lut[128], 200);
  assert.equal(lut[255], 255);
  for (let v = 1; v < 256; v++) assert.ok(lut[v] >= lut[v - 1], `monotone at ${v}`);
  assert.ok(lut[64] > 64 && lut[64] < 200, 'smooth in between');
  // Point order and { x, y } objects do not matter.
  assert.deepEqual(curveLut([{ x: 255, y: 255 }, { x: 128, y: 200 }, { x: 0, y: 0 }]), lut);
  // Monotone cubic never overshoots between points even with a steep step.
  const step = curveLut([[0, 0], [100, 10], [110, 245], [255, 255]]);
  for (let v = 0; v < 256; v++) assert.ok(step[v] >= 0 && step[v] <= 255);
  for (let v = 1; v < 256; v++) assert.ok(step[v] >= step[v - 1], `step monotone at ${v}`);
  // Flat outside the first and last points; negative curve inverts.
  const clipped = curveLut([[50, 20], [200, 220]]);
  assert.equal(clipped[0], 20);
  assert.equal(clipped[255], 220);
  const neg = curveLut([[0, 255], [255, 0]]);
  for (let v = 0; v < 256; v++) assert.equal(neg[v], 255 - v);
  // Registry: a red-only curve leaves green and blue alone.
  const p = px([128, 128, 128, 1], 'curves', { r: [[0, 0], [128, 200], [255, 255]] });
  assertPixel(p, [200, 128, 128, 1], 0);
});

test('exposure: +1 stop roughly doubles linear light, offset and gamma behave', () => {
  const toLin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  for (const v of [30, 60, 100, 150]) {
    const out = px([v, v, v, 1], 'exposure', { exposure: 1 })[0];
    assertNear(toLin(out) / toLin(v), 2, 0.12, `v ${v} -> ${out}`);
  }
  assert.equal(px([200, 200, 200, 1], 'exposure', { exposure: 2 })[0], 255);
  const dark = px([100, 100, 100, 1], 'exposure', { exposure: -1 })[0];
  assertNear(toLin(dark) / toLin(100), 0.5, 0.05);
  assert.ok(px([100, 100, 100, 1], 'exposure', { offset: 0.1 })[0] > 100);
  assert.ok(px([100, 100, 100, 1], 'exposure', { gamma: 2 })[0] > 100, 'gamma > 1 lightens');
  assert.ok(px([100, 100, 100, 1], 'exposure', { gamma: 0.5 })[0] < 100);
  const [l] = ADJUSTMENTS.exposure.lut({});
  for (let v = 0; v < 256; v++) assert.equal(l[v], v);
});

test('hue/saturation: hue 120 turns red to green, saturation -100 equals desaturate, lightness, ranges, colorize', () => {
  assertPixel(px([255, 0, 0, 1], 'hue-saturation', { hue: 120 }), [0, 255, 0, 1], 1);
  assertPixel(px([255, 0, 0, 1], 'hue-saturation', { hue: -120 }), [0, 0, 255, 1], 1);
  assertPixel(px([255, 0, 0, 1], 'hue-saturation', { hue: 180 }), [0, 255, 255, 1], 1);
  // Saturation -100 lands exactly on the desaturate result for every pixel.
  const a = noiseImage(8, 8, 3), b = cloneImage(a);
  applyAdjustment(a, 'hue-saturation', { saturation: -100 });
  applyAdjustment(b, 'desaturate');
  assert.deepEqual(a.data, b.data);
  for (let i = 0; i < a.data.length; i += 4) {
    assert.equal(a.data[i], a.data[i + 1]);
    assert.equal(a.data[i + 1], a.data[i + 2]);
  }
  // Positive saturation increases HSL saturation; greys are untouched.
  const s0 = rgbToHsl(160, 120, 100)[1];
  const sp = px([160, 120, 100, 1], 'hue-saturation', { saturation: 50 });
  assert.ok(rgbToHsl(sp[0], sp[1], sp[2])[1] > s0 + 0.1);
  assertPixel(px([90, 90, 90, 1], 'hue-saturation', { saturation: 80, hue: 45 }), [90, 90, 90, 1], 0);
  // Lightness +100 -> white, -100 -> black, +50 halfway to white.
  assertPixel(px([40, 120, 200, 1], 'hue-saturation', { lightness: 100 }), [255, 255, 255, 1], 0);
  assertPixel(px([40, 120, 200, 1], 'hue-saturation', { lightness: -100 }), [0, 0, 0, 1], 0);
  assertPixel(px([40, 120, 200, 1], 'hue-saturation', { lightness: 50 }), [148, 188, 228, 1], 1);
  // A hue range only edits its band.
  assertPixel(px([255, 0, 0, 1], 'hue-saturation', { hue: 120, range: 'greens' }), [255, 0, 0, 1], 0);
  assertPixel(px([0, 255, 0, 1], 'hue-saturation', { hue: 120, range: 'greens' }), [0, 0, 255, 1], 1);
  assertPixel(px([128, 128, 128, 1], 'hue-saturation', { lightness: 50, range: 'reds' }), [128, 128, 128, 1], 0);
  // Colorize paints the luma with one hue.
  const col = px([128, 128, 128, 1], 'hue-saturation', { colorize: true, colorizeHue: 240, colorizeSat: 50 });
  assert.ok(col[2] > col[0] + 40 && col[2] > col[1] + 40, `colorize blue ${col}`);
  assertNear(col[0], col[1], 1);
  const hsl = rgbToHsl(col[0], col[1], col[2]);
  assertNear(hsl[0], 240, 2);
  assertNear(hsl[1], 0.5, 0.02);
});

test('desaturate, invert, posterize and threshold', () => {
  const p = px([200, 100, 50, 1], 'desaturate');
  const L = Math.round(luminance(200, 100, 50));
  assertPixel(p, [L, L, L, 1], 0);
  assertPixel(px([200, 100, 50, 1], 'invert'), [55, 155, 205, 1], 0);
  // Posterize 2 levels gives only 0 and 255.
  const g = gradientImage(64, 2);
  applyAdjustment(g, 'posterize', { levels: 2 });
  const seen = new Set();
  for (let i = 0; i < g.data.length; i += 4) for (let c = 0; c < 3; c++) seen.add(g.data[i + c]);
  assert.deepEqual([...seen].sort((x, y) => x - y), [0, 255]);
  const [l4] = ADJUSTMENTS.posterize.lut({ levels: 4 });
  assert.deepEqual(new Set(l4), new Set([0, 85, 170, 255]));
  for (let v = 1; v < 256; v++) assert.ok(l4[v] >= l4[v - 1]);
  // Threshold: luma >= level -> white, otherwise black (per pixel, not per channel).
  assertPixel(px([200, 200, 200, 1], 'threshold', { level: 128 }), [255, 255, 255, 1], 0);
  assertPixel(px([100, 100, 100, 1], 'threshold', { level: 128 }), [0, 0, 0, 1], 0);
  assertPixel(px([255, 0, 0, 1], 'threshold', { level: 128 }), [0, 0, 0, 1], 0); // luma 76
  assertPixel(px([255, 0, 0, 1], 'threshold', { level: 76 }), [255, 255, 255, 1], 0);
  assertPixel(px([128, 128, 128, 1], 'threshold', { level: 128 }), [255, 255, 255, 1], 0);
});

test('color balance: warming midtones shifts red up and blue down, preserving luminosity', () => {
  const src = [128, 128, 128, 1];
  const p = px(src, 'color-balance', { midtones: [50, 0, -50] });
  assert.ok(p[0] > 140, `red up ${p}`);
  assert.ok(p[2] < 110, `blue down ${p}`);
  assertNear(lumaOf(p), lumaOf(src), 1, 'luminosity preserved');
  // Without preserve luminosity the green channel stays and luma moves.
  const q = px(src, 'color-balance', { midtones: [50, 0, -50], preserveLuminosity: false });
  assert.equal(q[1], 128);
  assert.ok(q[0] > p[0]);
  // Midtones barely touch black and white; shadows act on dark tones, highlights on light ones.
  assertPixel(px([0, 0, 0, 1], 'color-balance', { midtones: [100, 100, 100], preserveLuminosity: false }), [0, 0, 0, 1], 0);
  assertPixel(px([255, 255, 255, 1], 'color-balance', { midtones: [-100, -100, -100], preserveLuminosity: false }), [255, 255, 255, 1], 0);
  const sh = px([30, 30, 30, 1], 'color-balance', { shadows: [0, 0, 60], preserveLuminosity: false });
  const hiOnDark = px([30, 30, 30, 1], 'color-balance', { highlights: [0, 0, 60], preserveLuminosity: false });
  assert.ok(sh[2] - 30 > (hiOnDark[2] - 30) * 3, `shadows act more on darks ${sh} vs ${hiOnDark}`);
  const hl = px([220, 220, 220, 1], 'color-balance', { highlights: [-60, 0, 0], preserveLuminosity: false });
  assert.ok(hl[0] < 200, `highlights act on lights ${hl}`);
  const shOnLight = px([220, 220, 220, 1], 'color-balance', { shadows: [-60, 0, 0], preserveLuminosity: false });
  assert.ok(220 - shOnLight[0] < (220 - hl[0]) / 3, `shadows barely touch lights ${shOnLight}`);
  // Shadows keep white, highlights keep black, midtones keep both; every table is monotone.
  for (const amt of [-100, -40, 40, 100]) {
    for (const [tone, keep] of [['shadows', [255]], ['highlights', [0]], ['midtones', [0, 255]]]) {
      const img = createImage(256, 1);
      for (let x = 0; x < 256; x++) setPixel(img, x, 0, [x, x, x, 1]);
      applyAdjustment(img, 'color-balance', { [tone]: [amt, amt, amt], preserveLuminosity: false });
      for (const v of keep) assert.equal(getPixel(img, v, 0)[0], v, `${tone} ${amt} keeps ${v}`);
      for (let x = 1; x < 256; x++) assert.ok(getPixel(img, x, 0)[0] >= getPixel(img, x - 1, 0)[0], `${tone} ${amt} monotone at ${x}`);
    }
  }
  // Adding red in the shadows tints black; removing it crushes dark reds instead.
  assert.ok(px([0, 0, 0, 1], 'color-balance', { shadows: [100, 0, 0], preserveLuminosity: false })[0] > 80);
  assert.equal(px([60, 60, 60, 1], 'color-balance', { shadows: [-100, 0, 0], preserveLuminosity: false })[0], 0);
});

test('black & white produces grey with the Photoshop weighting, keeps alpha, optional tint', () => {
  const img = noiseImage(8, 8, 11, 77);
  applyAdjustment(img, 'black-white');
  for (let i = 0; i < img.data.length; i += 4) {
    assert.equal(img.data[i], img.data[i + 1]);
    assert.equal(img.data[i + 1], img.data[i + 2]);
    assert.equal(img.data[i + 3], 77);
  }
  // Pure primaries / secondaries take their slider value as a percentage of 255.
  assertPixel(px([255, 0, 0, 1], 'black-white'), [102, 102, 102, 1], 0); // reds 40
  assertPixel(px([255, 255, 0, 1], 'black-white'), [153, 153, 153, 1], 0); // yellows 60
  assertPixel(px([0, 0, 255, 1], 'black-white', { blues: 100 }), [255, 255, 255, 1], 0);
  assertPixel(px([255, 255, 255, 1], 'black-white'), [255, 255, 255, 1], 0);
  assertPixel(px([77, 77, 77, 1], 'black-white', { reds: 300, blues: -200 }), [77, 77, 77, 1], 0); // greys unaffected
  // min + (mid - min) * secondary + (max - mid) * primary.
  assertPixel(px([200, 120, 40, 1], 'black-white'), [Math.round(40 + 80 * 0.6 + 80 * 0.4), Math.round(40 + 80 * 0.6 + 80 * 0.4), Math.round(40 + 80 * 0.6 + 80 * 0.4), 1], 0);
  // Tint colours the grey.
  const t = px([128, 128, 128, 1], 'black-white', { tint: { hue: 30, sat: 50 } });
  assert.ok(t[0] > t[1] && t[1] > t[2], `warm tint ${t}`);
});

test('photo filter tints towards the filter colour and keeps luminosity', () => {
  const src = [128, 128, 128, 1];
  const p = px(src, 'photo-filter', { color: '#ec8a00', density: 50 });
  assert.ok(p[0] > p[1] && p[1] > p[2], `warm ${p}`);
  assertNear(lumaOf(p), lumaOf(src), 1);
  const q = px(src, 'photo-filter', { color: [0, 0, 255], density: 100, preserveLuminosity: false });
  assertPixel(q, [0, 0, 128, 1], 0);
});

test('channel mixer: identity by default, channel swap, monochrome, constant', () => {
  assertPixel(px([10, 100, 200, 1], 'channel-mixer', { r: { r: 0, g: 0, b: 100 } }), [200, 100, 200, 1], 0);
  const mono = px([200, 100, 50, 1], 'channel-mixer', { monochrome: true, gray: { r: 100, g: 0, b: 0, constant: 0 } });
  assertPixel(mono, [200, 200, 200, 1], 0);
  const def = px([200, 100, 50, 1], 'channel-mixer', { monochrome: true });
  const v = Math.round(0.4 * 200 + 0.4 * 100 + 0.2 * 50);
  assertPixel(def, [v, v, v, 1], 0);
  const img = noiseImage();
  applyAdjustment(img, 'channel-mixer', { monochrome: true });
  for (let i = 0; i < img.data.length; i += 4) {
    assert.equal(img.data[i], img.data[i + 1]);
    assert.equal(img.data[i], img.data[i + 2]);
  }
  assertPixel(px([10, 100, 200, 1], 'channel-mixer', { g: { r: 0, g: 100, b: 0, constant: 10 } }), [10, 126, 200, 1], 0);
});

test('gradient map: black -> white on a coloured image is its luminance; stops and reverse', () => {
  const img = noiseImage(8, 8, 5);
  const ref = cloneImage(img);
  applyAdjustment(img, 'gradient-map', { stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] });
  for (let i = 0; i < img.data.length; i += 4) {
    const L = Math.round(luminance(ref.data[i], ref.data[i + 1], ref.data[i + 2]));
    assert.equal(img.data[i], L);
    assert.equal(img.data[i + 1], L);
    assert.equal(img.data[i + 2], L);
  }
  const g = gradientImage(16, 1);
  const before = cloneImage(g);
  applyAdjustment(g, 'gradient-map', {});
  assert.deepEqual(g.data, before.data, 'black->white on a grey gradient is the identity');
  applyAdjustment(g, 'gradient-map', { reverse: true });
  assertPixel(getPixel(g, 0, 0), [255, 255, 255, 1], 0);
  assertPixel(getPixel(g, 15, 0), [0, 0, 0, 1], 0);
  const three = [{ offset: 0, color: '#ff0000' }, { offset: 0.5, color: '#00ff00' }, { offset: 1, color: '#0000ff' }];
  assertPixel(px([0, 0, 0, 1], 'gradient-map', { stops: three }), [255, 0, 0, 1], 0);
  assertPixel(px([128, 128, 128, 1], 'gradient-map', { stops: three }), [0, 254, 1, 1], 1);
  assertPixel(px([255, 255, 255, 1], 'gradient-map', { stops: three }), [0, 0, 255, 1], 0);
});

test('vibrance boosts muted colours more than saturated ones, protects skin and leaves greys alone', () => {
  const muted = [110, 130, 150, 1], vivid = [30, 30, 230, 1];
  const sat = (p) => rgbToHsl(p[0], p[1], p[2])[1];
  const m = px(muted, 'vibrance', { vibrance: 80 });
  const v = px(vivid, 'vibrance', { vibrance: 80 });
  assert.ok(sat(m) - sat(muted) > 0.04, `muted gains ${m}`);
  assert.ok(sat(m) - sat(muted) > 3 * (sat(v) - sat(vivid)), `muted gains more ${m} ${v}`);
  assertPixel(v, vivid, 3, 'vivid colours barely move');
  // A skin tone gets less boost than a blue of the same saturation and lightness.
  const skin = [150, 120, 110, 1], cool = [110, 120, 150, 1];
  const ds = sat(px(skin, 'vibrance', { vibrance: 100 })) - sat(skin), dc = sat(px(cool, 'vibrance', { vibrance: 100 })) - sat(cool);
  assert.ok(ds > 0 && ds < dc * 0.85, `skin ${ds} vs cool ${dc}`);
  assertPixel(px([100, 100, 100, 1], 'vibrance', { vibrance: 100, saturation: 100 }), [100, 100, 100, 1], 0);
  const des = px([200, 100, 50, 1], 'vibrance', { saturation: -100 });
  const L = Math.round(luminance(200, 100, 50));
  assertPixel(des, [L, L, L, 1], 0);
  assert.ok(sat(px(muted, 'vibrance', { vibrance: -80 })) < sat(muted));
});

test('selective color: ranges, relative vs absolute, neutrals spare pure hues', () => {
  // Absolute -100 cyan in reds raises red on a red pixel.
  const r = px([200, 50, 50, 1], 'selective-color', { reds: { c: -100, m: 0, y: 0, k: 0 }, relative: false });
  assert.ok(r[0] > 240, `${r}`);
  assert.equal(r[1], 50);
  // Reds edits do not touch greys or blues.
  assertPixel(px([128, 128, 128, 1], 'selective-color', { reds: { c: 100, m: 100, y: 100, k: 100 } }), [128, 128, 128, 1], 0);
  assertPixel(px([0, 0, 255, 1], 'selective-color', { reds: { c: 100, m: 100, y: 100, k: 100 }, relative: false }), [0, 0, 255, 1], 0);
  // Neutrals act on greys but not on pure hues, white or black.
  const n = px([128, 128, 128, 1], 'selective-color', { neutrals: { c: 30, m: 0, y: 0, k: 0 }, relative: false });
  assert.ok(n[0] < 100 && n[1] === 128 && n[2] === 128, `${n}`);
  for (const c of [[255, 0, 0, 1], [0, 255, 0, 1], [255, 255, 0, 1], [255, 255, 255, 1], [0, 0, 0, 1]]) {
    assertPixel(px(c, 'selective-color', { neutrals: { c: 100, m: 100, y: 100, k: 100 }, relative: false }), c, 0, 'neutrals on pure colours');
  }
  // Relative mode cannot change pure white; absolute can.
  assertPixel(px([255, 255, 255, 1], 'selective-color', { whites: { c: 50, m: 0, y: 0, k: 0 } }), [255, 255, 255, 1], 0);
  assert.ok(px([255, 255, 255, 1], 'selective-color', { whites: { c: 50, m: 0, y: 0, k: 0 }, relative: false })[0] < 200);
  // Blacks darken shadows.
  assert.ok(px([40, 40, 40, 1], 'selective-color', { blacks: { c: 0, m: 0, y: 0, k: 50 } })[0] < 40);
});

test('equalize spreads a low-contrast gradient across the range', () => {
  const img = createImage(64, 1);
  for (let x = 0; x < 64; x++) setPixel(img, x, 0, [100 + Math.floor(x / 2), 100 + Math.floor(x / 2), 100 + Math.floor(x / 2), 1]);
  applyAdjustment(img, 'equalize');
  const first = getPixel(img, 0, 0)[0], last = getPixel(img, 63, 0)[0];
  assert.ok(first <= 10, `dark end ${first}`);
  assert.equal(last, 255);
  for (let x = 1; x < 64; x++) assert.ok(getPixel(img, x, 0)[0] >= getPixel(img, x - 1, 0)[0], 'monotone');
  // A flat image stays put.
  const flat = solidImage(4, 4, [90, 90, 90, 1]);
  applyAdjustment(flat, 'equalize');
  assertPixel(getPixel(flat, 2, 2), [90, 90, 90, 1], 0);
});

test('shadows/highlights lifts darks, pulls down lights, and ignores transparent neighbours', () => {
  const img = gradientImage(32, 4);
  const before = cloneImage(img);
  applyAdjustment(img, 'shadows-highlights', { shadows: 60, highlights: 60, radius: 0 });
  const dark = getPixel(img, 4, 1)[0], darkBefore = getPixel(before, 4, 1)[0];
  const light = getPixel(img, 28, 1)[0], lightBefore = getPixel(before, 28, 1)[0];
  assert.ok(dark > darkBefore + 20, `${darkBefore} -> ${dark}`);
  assert.ok(light < lightBefore - 20, `${lightBefore} -> ${light}`);
  // Transparent black next to an opaque grey must not darken the mask (premultiplied averaging):
  // the edge column then gets exactly the same edit as the interior.
  const half = createImage(16, 8);
  for (let y = 0; y < 8; y++) for (let x = 8; x < 16; x++) setPixel(half, x, y, [70, 70, 70, 1]);
  applyAdjustment(half, 'shadows-highlights', { shadows: 100, radius: 4 });
  const edge = getPixel(half, 8, 4), inner = getPixel(half, 15, 4);
  assert.ok(inner[0] > 70, 'lifted');
  assertPixel(edge, inner, 0, 'edge matches interior');
  assert.equal(getPixel(half, 3, 3)[3], 0, 'transparent stays transparent');
  // The blurred mask is separable and symmetric: a transposed image gives the transposed result.
  const rows = createImage(5, 16), cols = createImage(16, 5);
  for (let a = 0; a < 16; a++) for (let b = 0; b < 5; b++) {
    const v = a < 8 ? 40 : 200, c = [v, (v + b * 9) & 255, 255 - v, 1];
    setPixel(rows, b, a, c);
    setPixel(cols, a, b, c);
  }
  const params = { shadows: 70, highlights: 50, radius: 5 };
  applyAdjustment(rows, 'shadows-highlights', params);
  applyAdjustment(cols, 'shadows-highlights', params);
  for (let a = 0; a < 16; a++) for (let b = 0; b < 5; b++) assert.deepEqual(getPixel(rows, b, a), getPixel(cols, a, b), `transpose ${a},${b}`);
  // A dark pixel next to the bright half sees a brighter blurred mask, so it is lifted less.
  assert.ok(getPixel(rows, 2, 7)[0] < getPixel(rows, 2, 0)[0], 'mask is blurred across the boundary');
  // Highlights alone leave dark tones nearly unchanged; shadows alone leave light tones.
  const g2 = gradientImage(32, 1);
  applyAdjustment(g2, 'shadows-highlights', { shadows: 0, highlights: 100, radius: 0 });
  assert.ok(Math.abs(getPixel(g2, 2, 0)[0] - getPixel(before, 2, 0)[0]) <= 2);
  const g3 = gradientImage(32, 1);
  applyAdjustment(g3, 'shadows-highlights', { shadows: 100, highlights: 0, radius: 0 });
  assert.ok(Math.abs(getPixel(g3, 30, 0)[0] - getPixel(before, 30, 0)[0]) <= 2);
});

test('histogram counts channels and luma of non-transparent pixels in rect', () => {
  const img = quadrantImage(8); // 6x6 opaque inside a transparent border: 9 px each of R, B, G, W
  const h = histogram(img);
  assert.equal(h.count, 36);
  for (const ch of [h.r, h.g, h.b, h.l]) {
    assert.ok(ch instanceof Uint32Array);
    assert.equal(ch.length, 256);
    assert.equal(ch.reduce((a, b) => a + b, 0), 36);
  }
  assert.equal(h.r[255], 18); // red + white
  assert.equal(h.r[0], 18);
  assert.equal(h.g[255], 18);
  assert.equal(h.b[255], 18);
  assert.equal(h.l[255], 9);
  assert.equal(h.l[Math.round(luminance(255, 0, 0))], 9);
  assert.equal(h.l[Math.round(luminance(0, 255, 0))], 9);
  assert.equal(h.l[Math.round(luminance(0, 0, 255))], 9);
  const part = histogram(img, { x: 0, y: 0, width: 4, height: 4 });
  assert.equal(part.count, 9);
  assert.equal(part.r[255], 9);
  const out = histogram(img, { x: 20, y: 20, width: 5, height: 5 });
  assert.equal(out.count, 0);
});

test('autoLevels stretches a low-contrast gradient to near 0..255; autoContrast and autoColor', () => {
  const img = createImage(64, 2);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 64; x++) setPixel(img, x, y, [100 + x, 90 + x, 110 + x, 1]);
  const contrast = cloneImage(img);
  autoLevels(img, { clip: 0.1 });
  const lo = getPixel(img, 0, 0), hi = getPixel(img, 63, 0);
  for (let c = 0; c < 3; c++) {
    assert.ok(lo[c] <= 5, `low end ${lo}`);
    assert.ok(hi[c] >= 250, `high end ${hi}`);
  }
  for (let x = 1; x < 64; x++) assert.ok(getPixel(img, x, 0)[0] >= getPixel(img, x - 1, 0)[0]);
  // autoContrast: one table for all channels from luma, so channel order is kept.
  autoContrast(contrast);
  const cl = getPixel(contrast, 0, 0), ch = getPixel(contrast, 63, 0);
  assert.ok(cl[1] < 10 && ch[2] > 245, `${cl} ${ch}`);
  assert.ok(ch[2] >= ch[0] && ch[0] >= ch[1], 'relationship kept');
  // autoColor: a cast image ends up with nearly equal channel means.
  const cast = createImage(32, 2);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 32; x++) setPixel(cast, x, y, [x * 6, x * 5, Math.min(255, 40 + x * 7), 1]);
  autoColor(cast);
  const hs = histogram(cast);
  const mean = (hist) => hist.reduce((a, n, v) => a + n * v, 0) / hs.count;
  const ms = [mean(hs.r), mean(hs.g), mean(hs.b)];
  assert.ok(Math.max(...ms) - Math.min(...ms) < 12, `means ${ms}`);
  // Flat and empty images are left alone.
  const flat = solidImage(4, 4, [90, 90, 90, 1]);
  autoLevels(flat);
  autoContrast(flat);
  assertPixel(getPixel(flat, 1, 1), [90, 90, 90, 1], 0);
  const empty = createImage(4, 4);
  autoColor(empty);
  assert.ok(empty.data.every((v) => v === 0));
});

test('auto functions honour rect', () => {
  const before = createImage(16, 2);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 16; x++) setPixel(before, x, y, [100 + x, 100 + x, 100 + x, 1]);
  const rect = { x: 0, y: 0, width: 8, height: 1 };
  for (const fn of [autoLevels, autoContrast, autoColor]) {
    const t = cloneImage(before);
    fn(t, { clip: 0 }, rect);
    assert.equal(getPixel(t, 0, 0)[0], 0, fn.name);
    assert.equal(getPixel(t, 7, 0)[0], 255, fn.name);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 16; x++) {
      if (y < 1 && x < 8) continue;
      assert.deepEqual(getPixel(t, x, y), getPixel(before, x, y), `${fn.name} outside rect ${x},${y}`);
    }
  }
});

test('rect limits every kind: pixels outside are untouched, nothing outside the image is written', () => {
  const rect = { x: 2, y: 3, width: 4, height: 3 };
  for (const kind of EXPECTED_KINDS) {
    const img = noiseImage(10, 9, 21);
    const before = cloneImage(img);
    applyAdjustment(img, kind, ACTIVE_PARAMS[kind], rect);
    let changedInside = 0;
    for (let y = 0; y < 9; y++) for (let x = 0; x < 10; x++) {
      const i = (y * 10 + x) * 4;
      const inside = x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
      const same = img.data[i] === before.data[i] && img.data[i + 1] === before.data[i + 1] && img.data[i + 2] === before.data[i + 2] && img.data[i + 3] === before.data[i + 3];
      if (!inside) assert.ok(same, `${kind} changed outside rect at ${x},${y}`);
      else if (!same) changedInside++;
    }
    assert.ok(changedInside > 0, `${kind} changed nothing inside rect`);
    // Rects that hang off the image (or miss it) are clipped, never overflow.
    const edge = noiseImage(6, 6, 9);
    applyAdjustment(edge, kind, ACTIVE_PARAMS[kind], { x: -3, y: 4, width: 20, height: 20 });
    assert.equal(edge.data.length, 6 * 6 * 4);
    const miss = noiseImage(6, 6, 9), missBefore = cloneImage(miss);
    applyAdjustment(miss, kind, ACTIVE_PARAMS[kind], { x: 10, y: 10, width: 4, height: 4 });
    assert.deepEqual(miss.data, missBefore.data, `${kind} rect outside image`);
  }
});

test('inside rect, every kind (except equalize, which analyses the rect) matches the whole-image result', () => {
  const rect = { x: 9, y: 7, width: 6, height: 5 };
  for (const kind of EXPECTED_KINDS) {
    if (kind === 'equalize') continue;
    const params = kind === 'shadows-highlights' ? { shadows: 80, highlights: 60, radius: 4 } : ACTIVE_PARAMS[kind];
    const whole = noiseImage(24, 20, 17), part = cloneImage(whole);
    applyAdjustment(whole, kind, params);
    applyAdjustment(part, kind, params, rect);
    for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
      assert.deepEqual(getPixel(part, x, y), getPixel(whole, x, y), `${kind} at ${x},${y}`);
    }
  }
});

test('alpha is never changed, including fully transparent pixels', () => {
  for (const kind of EXPECTED_KINDS) {
    const img = noiseImage(8, 8, 33);
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = (i >> 2) % 3 === 0 ? 0 : (i * 7) & 255;
    const alphas = img.data.filter((_, i) => i % 4 === 3);
    applyAdjustment(img, kind, ACTIVE_PARAMS[kind]);
    assert.deepEqual(img.data.filter((_, i) => i % 4 === 3), alphas, kind);
  }
});

test('adjustments are deterministic and work on 1x1 and empty images', () => {
  for (const kind of EXPECTED_KINDS) {
    const a = noiseImage(8, 8, 4), b = noiseImage(8, 8, 4);
    applyAdjustment(a, kind, ACTIVE_PARAMS[kind]);
    applyAdjustment(b, kind, ACTIVE_PARAMS[kind]);
    assert.deepEqual(a.data, b.data, kind);
    applyAdjustment(createImage(1, 1, [10, 20, 30, 1]), kind, ACTIVE_PARAMS[kind]);
    applyAdjustment(createImage(0, 0), kind, ACTIVE_PARAMS[kind]);
  }
  assert.equal(histogram(createImage(0, 0)).count, 0);
});
