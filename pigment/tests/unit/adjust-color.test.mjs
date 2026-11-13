// adjust-color (0.4 package 8): Hue/Saturation colour ranges, 0.3 parameters giving 0.3's pixels exactly, Black &
// White's Auto, Gradient Map's dither, Shadows/Highlights' extra controls, the three new kinds, partial repaints
// (margin and ctx.origin) matching full ones, and the adjustment preset files (.ahu, .cha, .asv, .blw).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADJUSTMENTS, applyAdjustment, adjustmentDef } from '../../src/shared/pixels/adjust.js';
import {
  ADJUSTMENTS_COLOR, HUE_BASES, DEFAULT_RANGE_BOUNDS, hueSatRanges, boundsWeight, normalizeBounds, rangeForColor, hueOf,
  addHueToRange, subtractHueFromRange, blackWhiteAuto, grainNoise, mixerTotal, PHOTO_FILTERS,
} from '../../src/shared/pixels/adjust-color.js';
import { REFERENCE_COLOR } from './adjust-color-ref.mjs';
import { isExactKind, applyAdjustmentDeep, fromCanvasData, toCanvasData } from '../../src/shared/pixels/deep.js';
import {
  readAhu, writeAhu, readCha, writeCha, readAsv, writeAsv, readBlw, writeBlw, COLOR_BUILTINS, normalizeColorPreset, ADJUSTMENT_PANEL_PRESETS,
} from '../../src/renderer/lib/adjust/color-formats.js';

const copy = (im) => ({ width: im.width, height: im.height, data: new Uint8ClampedArray(im.data) });
/** A w x h image of pseudo-random colours (some greys and some transparent pixels). */
function noise(w = 40, h = 30, seed = 11, { alpha = false } = {}) {
  let s = seed;
  const r = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) % 256);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = r();
    const grey = i % 17 === 0;
    data[i * 4] = grey ? v : r();
    data[i * 4 + 1] = grey ? v : r();
    data[i * 4 + 2] = grey ? v : r();
    data[i * 4 + 3] = alpha && i % 13 === 0 ? r() : 255;
  }
  return { width: w, height: h, data };
}
/** A smooth image (gradients and a disc): neighbourhood kinds have something to work on. */
function scene(w = 64, h = 48) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const inDisc = (x - 40) ** 2 + (y - 20) ** 2 < 150;
    data[i] = inDisc ? 220 : (x * 4) & 255;
    data[i + 1] = inDisc ? 60 : 40 + y * 3;
    data[i + 2] = inDisc ? 40 : 200 - x * 2;
    data[i + 3] = 255;
  }
  return { width: w, height: h, data };
}
const viaRef = (img, kind, params) => {
  const out = copy(img);
  REFERENCE_COLOR[kind].apply(out, params);
  return out;
};
const viaNew = (img, kind, params, rect = null, ctx = null) => {
  const out = copy(img);
  applyAdjustment(out, kind, params, rect, ctx);
  return out;
};

test('0.3 parameters give 0.3’s pixels exactly (Hue/Saturation master, single ranges and colorize; S/H; Gradient Map; the others)', () => {
  const img = noise(60, 40, 3, { alpha: true });
  const cases = [
    ['hue-saturation', { hue: 40, saturation: 30, lightness: -20, range: 'master' }],
    ['hue-saturation', { hue: -120, saturation: -60, lightness: 35 }],
    ['hue-saturation', { hue: 0, saturation: 100, lightness: 0 }],
    ['hue-saturation', { colorize: true, colorizeHue: 200, colorizeSat: 60, colorizeLight: -20 }],
    ...HUE_BASES.map((b, i) => ['hue-saturation', { range: b, hue: 25 * (i - 2), saturation: 40 - i * 20, lightness: i * 10 - 30 }]),
    ['shadows-highlights', { shadows: 50, highlights: 30, radius: 12 }],
    ['shadows-highlights', { shadows: 100, highlights: 0, radius: 0 }],
    ['shadows-highlights', { shadows: 20, highlights: 80 }],
    ['gradient-map', { stops: [{ offset: 0, color: '#102030' }, { offset: 0.4, color: '#ff0000' }, { offset: 1, color: '#ffffaa' }], reverse: false }],
    ['gradient-map', { stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#00ff80' }], reverse: true }],
    ['black-white', { reds: 120, yellows: -30, tint: { hue: 30, sat: 40 } }],
    ['photo-filter', { color: '#3366ff', density: 60, preserveLuminosity: false }],
    ['photo-filter', { color: '#3366ff', density: 60 }],
    ['channel-mixer', { r: { r: 50, g: 50, b: 0, constant: 10 }, b: { r: 0, g: 20, b: 80, constant: -5 } }],
    ['channel-mixer', { monochrome: true, gray: { r: 30, g: 60, b: 10, constant: 0 } }],
  ];
  for (const [kind, params] of cases) {
    assert.deepEqual(viaNew(img, kind, params).data, viaRef(img, kind, params).data, `${kind} ${JSON.stringify(params)}`);
  }
  // and with a rect
  const rect = { x: 7, y: 5, width: 30, height: 20 };
  const a = copy(img), b = copy(img);
  applyAdjustment(a, 'hue-saturation', { range: 'greens', hue: 50 }, rect);
  REFERENCE_COLOR['hue-saturation'].apply(b, { range: 'greens', hue: 50 }, rect);
  assert.deepEqual(a.data, b.data);
});

test('Hue/Saturation ranges: J.9 reading, bound weights, Master plus ranges', () => {
  // 0.3's single range reads as Master 0 plus that range with the default bounds
  assert.deepEqual(hueSatRanges({ range: 'blues', hue: 10, saturation: 20, lightness: 30 }), {
    master: { hue: 0, saturation: 0, lightness: 0 },
    ranges: [{ base: 'blues', bounds: [195, 225, 255, 285], hue: 10, saturation: 20, lightness: 30 }],
  });
  // new shape: at most one range per base, at most six, values clamped, bad bounds replaced by the defaults
  const r = hueSatRanges({ hue: 5, ranges: [{ base: 'reds', bounds: [300, 330, 20, 50], hue: 400 }, { base: 'reds', hue: 9 }, { base: 'nope' }, { base: 'cyans', bounds: [1, 2] }] });
  assert.deepEqual(r.master, { hue: 5, saturation: 0, lightness: 0 });
  assert.deepEqual(r.ranges.map((x) => [x.base, x.bounds, x.hue]), [['reds', [300, 330, 20, 50], 180], ['cyans', [135, 165, 195, 225], 0]]);
  // weights: reds' defaults (315, 345, 15, 45) - full from 345 to 15, half at 330 and 30, none at 60 or 300
  const reds = DEFAULT_RANGE_BOUNDS.reds;
  assert.deepEqual([0, 345, 15, 330, 30, 60, 300, 180].map((h) => boundsWeight(reds, h)), [1, 1, 1, 0.5, 0.5, 0, 0, 0]);
  assert.deepEqual([90, 100, 110, 140].map((h) => boundsWeight([80, 100, 120, 160], h)), [0.5, 1, 1, 0.5]);
  assert.equal(normalizeBounds([10, 5, 20, 30]), null);
  assert.deepEqual(normalizeBounds([-45, -15, 375, 405]), [315, 345, 15, 45]);
  // the new shape with one default-bounds range equals 0.3's single range exactly
  const img = noise(50, 30, 9);
  const legacy = viaNew(img, 'hue-saturation', { range: 'yellows', hue: 30, saturation: -40, lightness: 20 });
  const fresh = viaNew(img, 'hue-saturation', { range: 'master', ranges: [{ base: 'yellows', bounds: [15, 45, 75, 105], hue: 30, saturation: -40, lightness: 20 }] });
  assert.deepEqual(fresh.data, legacy.data);
  // a pure red pixel: Master +20 and Reds +40 shift it by 60 degrees (to yellow); a pure blue only by Master's 20
  const two = { width: 3, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255, 128, 128, 128, 255]) };
  applyAdjustment(two, 'hue-saturation', { hue: 20, ranges: [{ base: 'reds', bounds: [...reds], hue: 40, saturation: 0, lightness: 0 }] });
  assert.deepEqual(Array.from(two.data.slice(0, 4)), [255, 255, 0, 255]);
  assert.equal(Math.round(hueOf(Array.from(two.data.slice(4, 7)))), 260);
  assert.deepEqual(Array.from(two.data.slice(8, 11)), [128, 128, 128], 'greys belong to no range');
  // an edited range: hues inside it change, the rest stay
  const bar = { width: 360, height: 1, data: new Uint8ClampedArray(360 * 4) };
  for (let h = 0; h < 360; h++) {
    const c = h < 120 ? [255, Math.round((h / 60) * 255), 0] : [0, 0, 255];
    bar.data.set(h < 60 ? [255, Math.round((h / 60) * 255), 0, 255] : h < 120 ? [Math.round(((120 - h) / 60) * 255), 255, 0, 255] : [0, 0, 255, 255], h * 4);
    void c;
  }
  const edited = viaNew(bar, 'hue-saturation', { ranges: [{ base: 'yellows', bounds: [40, 50, 70, 80], hue: 0, saturation: 0, lightness: -100 }] });
  const at = (im, x) => Array.from(im.data.slice(x * 4, x * 4 + 3));
  assert.deepEqual(at(edited, 60), [0, 0, 0], 'full effect at 60 degrees');
  assert.deepEqual(at(edited, 20), at(bar, 20), 'outside the bounds');
  assert.deepEqual(at(edited, 100), at(bar, 100));
  // 16/32 bits: ranges go through the 8-bit path (J.9)
  assert.equal(isExactKind('hue-saturation', { range: 'reds', hue: 10 }), true);
  assert.equal(isExactKind('hue-saturation', { ranges: [{ base: 'reds', hue: 10 }] }), false);
});

test('range eyedroppers: the range of a colour, + widens, - narrows', () => {
  assert.equal(rangeForColor([255, 10, 10]), 'reds');
  assert.equal(rangeForColor([250, 240, 20]), 'yellows');
  assert.equal(rangeForColor([20, 200, 220]), 'cyans');
  assert.equal(rangeForColor([200, 30, 210]), 'magentas');
  assert.equal(rangeForColor([90, 90, 90]), null);
  // + : a hue left of the full part moves b (and a) to it; right of it moves c (and d)
  assert.deepEqual(addHueToRange([15, 45, 75, 105], 30), [0, 30, 75, 105]);
  assert.deepEqual(addHueToRange([15, 45, 75, 105], 90), [15, 45, 90, 120]);
  assert.deepEqual(addHueToRange([15, 45, 75, 105], 60), [15, 45, 75, 105]);
  assert.equal(boundsWeight(addHueToRange([315, 345, 15, 45], 330), 330), 1);
  // - : inside the fall-off the edge moves to it; inside the full part the nearer side is cut off past it
  assert.deepEqual(subtractHueFromRange([15, 45, 75, 105], 95), [15, 45, 75, 95]);
  assert.deepEqual(subtractHueFromRange([15, 45, 75, 105], 25), [25, 45, 75, 105]);
  const cut = subtractHueFromRange([15, 45, 75, 105], 50);
  assert.deepEqual(cut, [50, 75, 75, 105]);
  assert.equal(boundsWeight(cut, 50), 0);
  assert.equal(boundsWeight(cut, 75), 1);
  assert.deepEqual(subtractHueFromRange([15, 45, 75, 105], 70), [15, 45, 45, 70]);
  assert.deepEqual(subtractHueFromRange([15, 45, 75, 105], 200), [15, 45, 75, 105]);
});

test('Black & White Auto spreads the greys of a colourful image further than the default mix', () => {
  const img = scene(80, 60);
  const auto = blackWhiteAuto(img);
  for (const k of ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas']) {
    assert.ok(Number.isInteger(auto[k]) && auto[k] >= -200 && auto[k] <= 300, k);
  }
  const std = (im) => {
    let s = 0, s2 = 0;
    const n = im.data.length / 4;
    for (let i = 0; i < im.data.length; i += 4) {
      s += im.data[i];
      s2 += im.data[i] * im.data[i];
    }
    return Math.sqrt(s2 / n - (s / n) ** 2);
  };
  assert.ok(std(viaNew(img, 'black-white', auto)) > std(viaNew(img, 'black-white', {})), 'more spread');
  // a grey image keeps the defaults
  const grey = { width: 2, height: 1, data: new Uint8ClampedArray([10, 10, 10, 255, 200, 200, 200, 255]) };
  assert.deepEqual(blackWhiteAuto(grey), { reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80 });
});

/** The compositor's partial repaint (I.4): the rect grown by the kind's margin, cropped, applied with its ctx. */
function partial(img, kind, params, rect) {
  const m = adjustmentDef(kind).margin?.(params) ?? 0;
  const gx = Math.max(0, rect.x - m), gy = Math.max(0, rect.y - m);
  const gw = Math.min(img.width, rect.x + rect.width + m) - gx, gh = Math.min(img.height, rect.y + rect.height + m) - gy;
  const crop = { width: gw, height: gh, data: new Uint8ClampedArray(gw * gh * 4) };
  for (let y = 0; y < gh; y++) crop.data.set(img.data.subarray(((gy + y) * img.width + gx) * 4, ((gy + y) * img.width + gx + gw) * 4), y * gw * 4);
  applyAdjustment(crop, kind, params, null, { origin: { x: gx, y: gy }, docWidth: img.width, docHeight: img.height, scale: 1 });
  const out = [];
  for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
    const i = ((y - gy) * gw + (x - gx)) * 4;
    out.push(crop.data[i], crop.data[i + 1], crop.data[i + 2], crop.data[i + 3]);
  }
  return out;
}
const sub = (img, rect) => {
  const out = [];
  for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) out.push(...img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
  return out;
};

test('partial repaints match full ones: Grain (ctx.origin), Clarity, Dehaze and Shadows/Highlights (margin), dithered Gradient Map', () => {
  const img = scene(90, 70);
  const cases = [
    ['grain', { amount: 60, size: 40, roughness: 30 }],
    ['grain', { amount: 100, size: 0, roughness: 100 }],
    ['clarity-dehaze', { clarity: 70, dehaze: 0 }],
    ['clarity-dehaze', { clarity: -50, dehaze: 60 }],
    ['clarity-dehaze', { clarity: 0, dehaze: -40 }],
    ['shadows-highlights', { shadows: 60, highlights: 40, shadowRadius: 20, highlightRadius: 6 }],
    ['gradient-map', { stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#3060ff' }], dither: true }],
  ];
  for (const [kind, params] of cases) {
    const full = viaNew(img, kind, params);
    assert.notDeepEqual(full.data, img.data, `${kind} changes something`);
    for (const rect of [{ x: 30, y: 20, width: 25, height: 18 }, { x: 0, y: 0, width: 12, height: 70 }, { x: 70, y: 50, width: 20, height: 20 }]) {
      assert.deepEqual(partial(img, kind, params, rect), sub(full, rect), `${kind} ${JSON.stringify(params)} ${JSON.stringify(rect)}`);
    }
  }
  assert.equal(adjustmentDef('grain').margin, undefined);
  assert.equal(adjustmentDef('clarity-dehaze').margin({ clarity: 0, dehaze: 0 }), 0);
  assert.ok(adjustmentDef('clarity-dehaze').margin({ clarity: 10 }) > 0);
  assert.ok(adjustmentDef('shadows-highlights').margin({ shadows: 10, radius: 30 }) >= 30);
  assert.equal(adjustmentDef('shadows-highlights').margin({ shadows: 0, highlights: 0 }), 0);
  // grain stays put: the noise is a function of the document position
  assert.equal(grainNoise(10, 20, 2.5, 0.3), grainNoise(10, 20, 2.5, 0.3));
  assert.notEqual(grainNoise(10, 20, 2.5, 0.3), grainNoise(11, 20, 2.5, 0.3));
});

test('the new kinds: Color and Vibrance, Clarity and Dehaze, Grain', () => {
  for (const k of ['color-vibrance', 'clarity-dehaze', 'grain']) {
    assert.equal(ADJUSTMENTS[k].placeholder, undefined, `${k} is no placeholder`);
    assert.equal(ADJUSTMENTS[k].layer, true);
    const img = scene(20, 10);
    assert.deepEqual(viaNew(img, k, {}).data, img.data, `${k} defaults are the identity`);
  }
  const grey = { width: 1, height: 1, data: new Uint8ClampedArray([128, 128, 128, 255]) };
  const warm = viaNew(grey, 'color-vibrance', { temperature: 60 });
  assert.ok(warm.data[0] > 135 && warm.data[2] < 120, `warmer: ${Array.from(warm.data)}`);
  const lum = 0.2126 * warm.data[0] + 0.7152 * warm.data[1] + 0.0722 * warm.data[2];
  assert.ok(Math.abs(lum - 128) < 6, 'a mid grey keeps about its brightness');
  const tinted = viaNew(grey, 'color-vibrance', { tint: 60 });
  assert.ok(tinted.data[1] < 128 && tinted.data[0] > 128, 'tint + is magenta');
  const muted = { width: 1, height: 1, data: new Uint8ClampedArray([150, 120, 110, 255]) };
  const vib = viaNew(muted, 'color-vibrance', { vibrance: 80 });
  assert.ok(vib.data[0] - vib.data[2] > 40, 'vibrance saturates a muted colour');
  assert.deepEqual(Array.from(viaNew(muted, 'color-vibrance', { saturation: -100 }).data.slice(0, 3)), [128, 128, 128].map(() => Math.round(0.299 * 150 + 0.587 * 120 + 0.114 * 110)));
  // clarity: more local contrast across an edge; dehaze: darker darks, more contrast
  const edge = { width: 40, height: 4, data: new Uint8ClampedArray(160 * 4) };
  for (let i = 0; i < 160; i++) edge.data.set((i % 40) < 20 ? [100, 100, 100, 255] : [150, 150, 150, 255], i * 4);
  const cl = viaNew(edge, 'clarity-dehaze', { clarity: 100 });
  assert.ok(cl.data[(1 * 40 + 18) * 4] < 100 && cl.data[(1 * 40 + 21) * 4] > 150, 'edge contrast grows');
  assert.equal(cl.data[(1 * 40 + 0) * 4], 100, 'far from the edge nothing moves');
  const hazy = { width: 30, height: 30, data: new Uint8ClampedArray(900 * 4) };
  for (let i = 0; i < 900; i++) hazy.data.set([150 + (i % 30), 160, 170, 255], i * 4);
  const dz = viaNew(hazy, 'clarity-dehaze', { dehaze: 80 });
  assert.ok(dz.data[0] < 150, 'dehaze darkens a hazy image');
  const added = viaNew(hazy, 'clarity-dehaze', { dehaze: -80 });
  assert.ok(added.data[0] > 150, 'negative dehaze adds haze');
  // grain: amount 0 is nothing, otherwise noise of about the size asked for, mean kept
  const flat = { width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4).fill(128) };
  const g = viaNew(flat, 'grain', { amount: 80, size: 25, roughness: 50 });
  let sum = 0, dev = 0;
  for (let i = 0; i < g.data.length; i += 4) {
    sum += g.data[i];
    dev += Math.abs(g.data[i] - 128);
  }
  assert.ok(Math.abs(sum / 4096 - 128) < 3, 'mean kept');
  assert.ok(dev / 4096 > 4, 'visible grain');
  assert.equal(g.data[3], 128, 'alpha untouched');
});

test('Shadows/Highlights: tone 50 and neutral extras are 0.3; tone, radius, colour, midtone and clipping act', () => {
  const img = scene(64, 48);
  const base = { shadows: 50, highlights: 40, radius: 10 };
  const ref = viaRef(img, 'shadows-highlights', base);
  assert.deepEqual(viaNew(img, 'shadows-highlights', { ...base, shadowTone: 50, highlightTone: 50, shadowRadius: 10, highlightRadius: 10, color: 0, midtone: 0, blackClip: 0, whiteClip: 0 }).data, ref.data);
  const lumAt = (im, x, y) => {
    const i = (y * im.width + x) * 4;
    return 0.299 * im.data[i] + 0.587 * im.data[i + 1] + 0.114 * im.data[i + 2];
  };
  // a narrower shadow tone lifts the dark-ish pixels less
  const narrow = viaNew(img, 'shadows-highlights', { ...base, highlights: 0, shadowTone: 10 });
  const wide = viaNew(img, 'shadows-highlights', { ...base, highlights: 0, shadowTone: 90 });
  assert.ok(lumAt(narrow, 30, 25) < lumAt(wide, 30, 25));
  // colour correction saturates the changed areas
  const sat = (im, x, y) => {
    const i = (y * im.width + x) * 4;
    return Math.max(im.data[i], im.data[i + 1], im.data[i + 2]) - Math.min(im.data[i], im.data[i + 1], im.data[i + 2]);
  };
  assert.ok(sat(viaNew(img, 'shadows-highlights', { ...base, color: 80 }), 5, 5) > sat(viaNew(img, 'shadows-highlights', base), 5, 5));
  // clipping stretches
  const clipped = viaNew(img, 'shadows-highlights', { ...base, blackClip: 5, whiteClip: 5 });
  const plainSH = viaNew(img, 'shadows-highlights', base);
  const lumRange = (im) => {
    let lo = 255, hi = 0;
    for (let i = 0; i < im.data.length; i += 4) {
      const l = 0.299 * im.data[i] + 0.587 * im.data[i + 1] + 0.114 * im.data[i + 2];
      lo = Math.min(lo, l);
      hi = Math.max(hi, l);
    }
    return [lo, hi];
  };
  assert.ok(lumRange(clipped)[0] < lumRange(plainSH)[0] && lumRange(clipped)[1] > lumRange(plainSH)[1], 'the tones are stretched');
  // a midtone contrast change moves midtones
  assert.notDeepEqual(viaNew(img, 'shadows-highlights', { ...base, midtone: 60 }).data, viaNew(img, 'shadows-highlights', base).data);
});

test('Gradient Map: dither stays within a level of the plain map; 16 bits stay exact', () => {
  const img = scene(50, 30);
  const g = { gradientVersion: 2, type: 'solid', interpolation: 'perceptual', smoothness: 1, stops: [{ pos: 0, mid: 0.5, color: '#200040' }, { pos: 1, mid: 0.5, color: '#ffd080' }], opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 1 }] };
  const plain = viaNew(img, 'gradient-map', g);
  const dith = viaNew(img, 'gradient-map', { ...g, dither: true });
  let diff = 0;
  for (let i = 0; i < plain.data.length; i++) {
    assert.ok(Math.abs(plain.data[i] - dith.data[i]) <= 1, `index ${i}`);
    diff += plain.data[i] !== dith.data[i];
  }
  assert.ok(diff > 0, 'the dither moves some values');
  assert.equal(isExactKind('gradient-map', { ...g, dither: true }), true);
  const deep = fromCanvasData(img, "u16");
  assert.equal(applyAdjustmentDeep(deep, 'gradient-map', g).exact, true);
  const back = toCanvasData(deep);
  for (let i = 0; i < back.length; i++) assert.ok(Math.abs(back[i] - plain.data[i]) <= 1);
});

test('Photo Filter list, Channel Mixer total', () => {
  assert.equal(PHOTO_FILTERS.length, 20);
  assert.deepEqual(PHOTO_FILTERS[0], ['warming-85', 'Warming Filter (85)', '#ec8a00']);
  assert.equal(ADJUSTMENTS_COLOR['photo-filter'].defaults.color, PHOTO_FILTERS[0][2]);
  assert.equal(mixerTotal({ r: 40, g: 40, b: 20, constant: 50 }), 100);
});

test('preset files: .ahu, .cha, .asv and .blw round trips and Photoshop’s byte layouts', () => {
  // Hue/Saturation: 100 bytes, version 2, Master then the six ranges in Photoshop's order
  const hs = { hue: 10, saturation: -20, lightness: 5, colorize: false, colorizeHue: 200, colorizeSat: 40, colorizeLight: -10, range: 'master', ranges: [{ base: 'yellows', bounds: [20, 50, 70, 100], hue: 30, saturation: 15, lightness: -5 }] };
  const ahu = writeAhu(hs);
  assert.equal(ahu.length, 100);
  const dv = new DataView(ahu.buffer, ahu.byteOffset);
  assert.equal(dv.getUint16(0), 2);
  assert.equal(dv.getInt16(10), 10, 'master hue');
  assert.equal(dv.getInt16(16 + 14 + 0), 20, 'yellows begin ramp');
  const back = readAhu(ahu);
  assert.deepEqual(back.params.ranges, hs.ranges);
  assert.deepEqual([back.params.hue, back.params.saturation, back.params.lightness, back.params.colorize, back.params.colorizeHue, back.params.colorizeSat, back.params.colorizeLight], [10, -20, 5, false, 200, 40, -10]);
  assert.throws(() => readAhu(new Uint8Array(10)));
  // Channel Mixer
  const cm = { monochrome: false, r: { r: 80, g: 20, b: 0, constant: 5 }, g: { r: 0, g: 100, b: 0, constant: 0 }, b: { r: -10, g: 0, b: 110, constant: -3 }, gray: { r: 40, g: 40, b: 20, constant: 0 } };
  assert.deepEqual(readCha(writeCha(cm)).params, cm);
  const mono = { ...cm, monochrome: true, gray: { r: 30, g: 60, b: 10, constant: 2 } };
  assert.deepEqual(readCha(writeCha(mono)).params.gray, mono.gray);
  assert.equal(readCha(writeCha(mono)).params.monochrome, true);
  // Selective Color: 84 bytes, version 1, method, ten records of CMYK
  const sc = { relative: false, reds: { c: 10, m: -20, y: 30, k: 0 }, neutrals: { c: 0, m: 0, y: -15, k: 5 } };
  const asv = writeAsv(sc);
  assert.equal(asv.length, 84);
  const scBack = readAsv(asv).params;
  assert.equal(scBack.relative, false);
  assert.deepEqual(scBack.reds, sc.reds);
  assert.deepEqual(scBack.neutrals, sc.neutrals);
  assert.deepEqual(scBack.blues, { c: 0, m: 0, y: 0, k: 0 });
  // Black & White: a descriptor with the six weights, tint and its colour
  const bw = { reds: -40, yellows: 235, greens: 144, cyans: -68, blues: -3, magentas: -107, tint: { hue: 30, sat: 25 } };
  const blwBack = readBlw(writeBlw(bw)).params;
  for (const k of ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas']) assert.equal(blwBack[k], bw[k], k);
  assert.ok(Math.abs(blwBack.tint.hue - 30) <= 1 && Math.abs(blwBack.tint.sat - 25) <= 1, JSON.stringify(blwBack.tint));
  assert.equal(readBlw(writeBlw({ ...bw, tint: null })).params.tint, null);
  assert.throws(() => readBlw(new TextEncoder().encode('not a preset')));
});

test('built-in presets are valid params of their kinds; the Adjustments panel presets name real kinds', () => {
  for (const [kind, list] of Object.entries(COLOR_BUILTINS)) {
    assert.ok(ADJUSTMENTS[kind], kind);
    const ids = new Set();
    for (const p of list) {
      assert.ok(!ids.has(p.id), `${kind}: ${p.id} once`);
      ids.add(p.id);
      assert.deepEqual(normalizeColorPreset(kind, p.data), p.data, `${kind} ${p.id} is normal`);
      const img = scene(8, 8);
      applyAdjustment(img, kind, p.data);
    }
  }
  assert.ok(COLOR_BUILTINS['hue-saturation'].some((p) => p.name === 'Sepia'));
  assert.ok(COLOR_BUILTINS['black-white'].some((p) => p.name === 'Infrared'));
  assert.equal(normalizeColorPreset('hue-saturation', 'junk'), null);
  for (const group of ADJUSTMENT_PANEL_PRESETS) {
    assert.ok(group.name && group.presets.length);
    for (const p of group.presets) for (const l of p.layers) assert.ok(ADJUSTMENTS[l.kind] && !ADJUSTMENTS[l.kind].placeholder, `${p.name}: ${l.kind}`);
  }
});
