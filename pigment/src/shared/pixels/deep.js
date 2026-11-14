// 16 and 32 bits per channel. A raster layer of a deep document keeps its real pixels in "deep
// planes" next to the 8-bit canvas everything else paints and composites (the proxy):
//
//   { type: 'u16' | 'f32', data: Uint16Array | Float32Array, width?, height? }
//
// straight (non-premultiplied) RGBA, rows top to bottom. 'u16' samples run 0..65535; 'f32' samples
// are display-referred floats where 0 is black and 1 is white, with HDR headroom above 1 (the
// proxy clamps). Photoshop's 32-bit mode is linear light; Pigment has no colour management yet, so
// f32 keeps the document's sRGB encoding: converting 8 -> 32 -> 8 is lossless and every
// adjustment means the same thing at every depth. width/height are optional on planes that are
// only walked sample by sample (layers carry them on the canvas); everything that takes a rect or
// positions one image over another needs them.
//
// The proxy is always the canonical quantisation of the planes (q8 below, no dither), so "does
// the proxy still describe these deep pixels" is a plain comparison. syncFromProxy() uses that
// to take over 8-bit edits (brush strokes, filters, transforms) without touching the pixels they
// left alone, and to put precise samples back when an undo returns the proxy to pixels that used
// to be backed by them.
//
// Adjustments: applyAdjustmentDeep() evaluates the maths of adjust.js in floating point on the
// deep samples for the kinds listed in EXACT_KINDS (per-channel curves through 65536-entry
// tables for u16, direct evaluation for f32); the others run at 8 bits and their change is
// added onto the deep samples. Pure module: typed arrays and plain loops, no DOM.

import { clampRect } from './core.js';
import { parseColor } from './color.js';
import { num, clampNum, srgbToLinear, linearToSrgb, merge } from './adjust-def.js';
import { ADJUSTMENTS } from './adjust.js';
import { normalizeGradient, gradientSampler } from './gradient-model.js';

/** @typedef {{ type: 'u16' | 'f32', data: Uint16Array | Float32Array, width?: number, height?: number }} DeepPlanes */
/** @typedef {import('./core.js').ImageDataLike} ImageDataLike */
/** @typedef {import('./core.js').Rect} Rect */

export const DEEP_TYPES = Object.freeze({ 16: 'u16', 32: 'f32' });
export const DEEP_BITS = Object.freeze({ u16: 16, f32: 32 });

/** The bits per channel a plane type stores (8 for null: a layer without deep pixels). */
export const depthOfType = (type) => DEEP_BITS[type] ?? 8;

// ---------------------------------------------------------------------------------------------
// Sample conversions

/** 16-bit sample -> 8-bit, round to nearest: floor((v + 128) / 257) === round(v / 257) for 0..65535. */
export const q8u16 = (v) => ((v + 128) / 257) | 0;
/** Float sample -> 8-bit: clamped to 0..1, round half up. NaN reads as 0. */
export const q8f32 = (v) => (v >= 1 ? 255 : v > 0 ? (v * 255 + 0.5) | 0 : 0);
/** 16-bit sample in Photoshop's 0..32768 Info panel scale. */
export const toPs16 = (v) => Math.round((v * 32768) / 65535);

const round16 = (v) => (v <= 0 ? 0 : v >= 65535 ? 65535 : (v + 0.5) | 0);

function dims(deep) {
  const n = deep.data.length >> 2;
  const width = deep.width > 0 ? deep.width : n;
  const height = deep.width > 0 ? (deep.height > 0 ? deep.height : Math.floor(n / deep.width)) : 1;
  return { width, height };
}

function region(deep, rect) {
  const { width, height } = dims(deep);
  return clampRect(rect, width, height);
}

function assertPlanes(deep) {
  if (!deep || (deep.type !== 'u16' && deep.type !== 'f32') || !deep.data) throw new TypeError('Deep planes need a type (u16 | f32) and data');
  return deep;
}

/** Empty (transparent black) planes. */
export function createDeep(width, height, type = 'u16') {
  const n = width * height * 4;
  return { type, width, height, data: type === 'f32' ? new Float32Array(n) : new Uint16Array(n) };
}

export function cloneDeep(deep) {
  return { ...deep, data: deep.data.slice() };
}

/**
 * 8-bit RGBA -> deep planes. u16 = v * 257 (so 255 -> 65535 and q8 gives v back), f32 = v / 255.
 * @param {ImageDataLike} img
 * @param {'u16' | 'f32'} [type]
 * @returns {DeepPlanes}
 */
export function fromCanvasData(img, type = 'u16') {
  const src = img.data, n = src.length;
  const out = createDeep(img.width, img.height, type);
  const d = out.data;
  if (type === 'f32') for (let i = 0; i < n; i++) d[i] = src[i] / 255;
  else for (let i = 0; i < n; i++) d[i] = src[i] * 257;
  return out;
}

/** Deterministic per-sample noise in [0, 1) (integer hash of the sample index and a seed). */
function ditherNoise(i, seed) {
  let h = (i ^ seed) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Deep planes -> the 8-bit proxy (an ImageDataLike). Without dither this is the canonical
 * quantisation (round to nearest; f32 clamped to 0..1) that syncFromProxy() compares against.
 * With dither each colour sample is rounded up with a probability equal to its fraction, so
 * a smooth 16-bit ramp becomes noise instead of bands when a document goes down to 8 bits;
 * samples an 8-bit value already describes exactly and alpha are never dithered.
 * @param {DeepPlanes} deep needs width/height unless `rect` is null and `width` is passed
 * @param {{ dither?: boolean, rect?: Rect | null, seed?: number }} [options] rect: only that part (the result is rect-sized)
 * @returns {ImageDataLike}
 */
export function toCanvasData(deep, { dither = false, rect = null, seed = 0x9e3779b9 } = {}) {
  assertPlanes(deep);
  const { width } = dims(deep);
  const r = region(deep, rect);
  const out = new Uint8ClampedArray(r.width * r.height * 4);
  const s = deep.data;
  const f32 = deep.type === 'f32';
  let o = 0;
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let i = (y * width + r.x) * 4;
    for (let x = 0; x < r.width; x++, i += 4, o += 4) {
      if (!dither) {
        if (f32) {
          out[o] = q8f32(s[i]);
          out[o + 1] = q8f32(s[i + 1]);
          out[o + 2] = q8f32(s[i + 2]);
          out[o + 3] = q8f32(s[i + 3]);
        } else {
          out[o] = q8u16(s[i]);
          out[o + 1] = q8u16(s[i + 1]);
          out[o + 2] = q8u16(s[i + 2]);
          out[o + 3] = q8u16(s[i + 3]);
        }
        continue;
      }
      for (let c = 0; c < 3; c++) {
        const v = f32 ? (s[i + c] >= 1 ? 255 : s[i + c] > 0 ? s[i + c] * 255 : 0) : s[i + c] / 257;
        const lo = Math.floor(v);
        out[o + c] = v - lo > ditherNoise(i + c, seed) ? lo + 1 : lo;
      }
      out[o + 3] = f32 ? q8f32(s[i + 3]) : q8u16(s[i + 3]);
    }
  }
  return { width: r.width, height: r.height, data: out };
}

/**
 * Converts planes to the other sample type (a copy; the same type returns a copy too).
 * u16 -> f32 is v / 65535; f32 -> u16 clamps to 0..1 and rounds.
 * @param {DeepPlanes} deep
 * @param {'u16' | 'f32'} type
 * @returns {DeepPlanes}
 */
export function convertDepth(deep, type) {
  assertPlanes(deep);
  if (type !== 'u16' && type !== 'f32') throw new RangeError(`Unknown deep type: ${String(type)}`);
  const s = deep.data, n = s.length;
  if (type === deep.type) return cloneDeep(deep);
  const out = { ...deep, type, data: type === 'f32' ? new Float32Array(n) : new Uint16Array(n) };
  const d = out.data;
  if (type === 'f32') for (let i = 0; i < n; i++) d[i] = s[i] / 65535;
  else for (let i = 0; i < n; i++) d[i] = round16(s[i] * 65535);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Rect helpers (patches are rect-sized planes with their position: { x, y, width, height, type, data })

/** Copies rect (clipped to the planes) out of deep planes. */
export function extractRect(deep, rect = null) {
  const { width } = dims(deep);
  const r = region(deep, rect);
  const row = r.width * 4;
  const data = deep.type === 'f32' ? new Float32Array(row * r.height) : new Uint16Array(row * r.height);
  for (let y = 0; y < r.height; y++) {
    const s = ((r.y + y) * width + r.x) * 4;
    data.set(deep.data.subarray(s, s + row), y * row);
  }
  return { x: r.x, y: r.y, width: r.width, height: r.height, type: deep.type, data };
}

/** Writes a patch from extractRect back at its position (same sample type). */
export function writeRect(deep, patch) {
  const { width, height } = dims(deep);
  if (patch.type !== deep.type) throw new TypeError('The patch has another sample type');
  const row = patch.width * 4;
  for (let y = 0; y < patch.height; y++) {
    const dy = patch.y + y;
    if (dy < 0 || dy >= height || patch.x < 0 || patch.x + patch.width > width) continue;
    deep.data.set(patch.data.subarray(y * row, (y + 1) * row), (dy * width + patch.x) * 4);
  }
  return deep;
}

/**
 * True when some sample of the planes says more than an 8-bit value can (u16: not a multiple of
 * 257; f32: not k / 255). Planes without such samples are rebuilt exactly from the proxy, so
 * there is no point in remembering them.
 */
export function hasPrecision(deep) {
  const s = deep.data, n = s.length;
  if (deep.type === 'f32') {
    for (let i = 0; i < n; i++) {
      const v = s[i];
      if (v !== Math.fround(Math.round(v * 255) / 255)) return true;
    }
    return false;
  }
  for (let i = 0; i < n; i++) if (s[i] % 257 !== 0) return true;
  return false;
}

/**
 * Blends the samples inside rect between `before` (a patch covering rect, from extractRect) and
 * their current value by a selection: out = before + (now - before) * alpha / 255, all four
 * channels (what an edit confined to a feathered selection does at 8 bits).
 * @param {DeepPlanes} deep
 * @param {{ x: number, y: number, width: number, height: number, data: Uint16Array | Float32Array }} before
 * @param {Uint8Array | Uint8ClampedArray} alpha before.width * before.height selection values
 */
export function mixRect(deep, before, alpha) {
  const { width } = dims(deep);
  const d = deep.data, b = before.data;
  const u16 = deep.type === 'u16';
  for (let y = 0; y < before.height; y++) {
    let i = ((before.y + y) * width + before.x) * 4, j = y * before.width * 4, p = y * before.width;
    for (let x = 0; x < before.width; x++, i += 4, j += 4, p++) {
      const a = alpha[p];
      if (a === 255) continue;
      if (a === 0) {
        d[i] = b[j];
        d[i + 1] = b[j + 1];
        d[i + 2] = b[j + 2];
        d[i + 3] = b[j + 3];
        continue;
      }
      const k = a / 255;
      for (let c = 0; c < 4; c++) {
        const v = b[j + c] + (d[i + c] - b[j + c]) * k;
        d[i + c] = u16 ? round16(v) : v;
      }
    }
  }
  return deep;
}

// ---------------------------------------------------------------------------------------------
// Keeping planes in step with the 8-bit proxy

/**
 * Whether a proxy pixel that is not opaque (s0..s3) stands for the samples at a[o..o+3]. A canvas
 * stores colour multiplied by alpha at 8 bits, so what it hands back for a translucent pixel is
 * not the colour that was put there but the nearest one that survives the multiplication (and for
 * alpha 0 no colour at all). The comparison is therefore made the way the canvas stores pixels:
 * equal alpha, premultiplied colours within one step (its rounding is the browser's business).
 */
function translucentMatch(q, a, o, s0, s1, s2, s3) {
  if (q(a[o + 3]) !== s3) return false;
  if (s3 === 0) return true;
  const k = s3 / 255;
  return Math.abs(Math.round(q(a[o]) * k) - Math.round(s0 * k)) <= 1 && Math.abs(Math.round(q(a[o + 1]) * k) - Math.round(s1 * k)) <= 1 && Math.abs(Math.round(q(a[o + 2]) * k) - Math.round(s2 * k)) <= 1;
}

/**
 * Makes the planes agree with the proxy pixels in rect, changing only samples whose quantisation
 * differs from the proxy: an 8-bit edit (a brush stroke, a filter, a transform) is taken over where
 * it changed pixels and the precise samples everywhere else stay. Pixels are handled whole (all
 * four channels) so a restored pixel is never a mix of two states. Translucent pixels are compared
 * as a canvas stores them (see translucentMatch), so reading the proxy back from a canvas does not
 * count as an edit.
 *
 * `restore` is a list of patches (extractRect results, newest first) of samples these planes held
 * before: when the proxy at a pixel equals the quantisation of such a sample, the precise sample
 * comes back instead of the 8-bit value (an undo returns the proxy to pixels that used to be
 * backed by deep data). `loose` accepts a proxy that is within one 8-bit step of the planes
 * (files whose proxy was rounded another way) and reports those pixels in `loosePixels` so the
 * caller can rewrite the proxy canonically. `backup` adds `before` to the result: a copy of the whole
 * sample array as it was before the call (null when nothing changed), from which the caller keeps the
 * changed box for a later `restore`.
 *
 * @param {DeepPlanes} deep needs width/height when img is smaller than the planes
 * @param {ImageDataLike} img the proxy pixels of `rect` (rect-sized), or of the whole planes when rect is null
 * @param {{ rect?: Rect | null, restore?: Array<{ x: number, y: number, width: number, height: number, data: Uint16Array | Float32Array }>, loose?: boolean, backup?: boolean }} [options]
 * @returns {{ changed: number, restored: number, loosePixels: number, bounds: Rect | null, before?: Uint16Array | Float32Array | null }} bounds: the box of changed pixels (plane coordinates)
 */
export function syncFromProxy(deep, img, { rect = null, restore = null, loose = false, backup = false } = {}) {
  assertPlanes(deep);
  const { width } = dims(deep);
  const r = region(deep, rect);
  if (img.width !== r.width || img.height !== r.height) throw new RangeError('The proxy image does not match the rect');
  const d = deep.data, s = img.data;
  const f32 = deep.type === 'f32';
  const q = f32 ? q8f32 : q8u16;
  const patches = restore && restore.length ? restore : null;
  let changed = 0, restored = 0, loosePixels = 0;
  let before = null;
  let x1 = Infinity, y1 = Infinity, x2 = -1, y2 = -1;
  for (let y = 0; y < r.height; y++) {
    const py = r.y + y;
    let i = (py * width + r.x) * 4, j = y * r.width * 4;
    for (let x = 0; x < r.width; x++, i += 4, j += 4) {
      const s0 = s[j], s1 = s[j + 1], s2 = s[j + 2], s3 = s[j + 3];
      if (s3 === 255 ? q(d[i]) === s0 && q(d[i + 1]) === s1 && q(d[i + 2]) === s2 && q(d[i + 3]) === 255 : translucentMatch(q, d, i, s0, s1, s2, s3)) continue;
      if (loose) {
        const k = f32 ? 255 : 1 / 257;
        if (Math.abs(d[i] * k - s0) < 1 && Math.abs(d[i + 1] * k - s1) < 1 && Math.abs(d[i + 2] * k - s2) < 1 && Math.abs(d[i + 3] * k - s3) < 1) {
          loosePixels++;
          continue;
        }
      }
      const px = r.x + x;
      // the first change: nothing has been written yet, so a copy now is the state before this call
      if (backup && !before) before = d.slice();
      let hit = false;
      if (patches) {
        for (let k = 0; k < patches.length && !hit; k++) {
          const p = patches[k];
          if (px < p.x || py < p.y || px >= p.x + p.width || py >= p.y + p.height) continue;
          const o = ((py - p.y) * p.width + (px - p.x)) * 4, pd = p.data;
          if (s3 === 255 ? q(pd[o]) === s0 && q(pd[o + 1]) === s1 && q(pd[o + 2]) === s2 && q(pd[o + 3]) === 255 : translucentMatch(q, pd, o, s0, s1, s2, s3)) {
            d[i] = pd[o];
            d[i + 1] = pd[o + 1];
            d[i + 2] = pd[o + 2];
            d[i + 3] = pd[o + 3];
            hit = true;
          }
        }
      }
      if (hit) restored++;
      else if (f32) {
        d[i] = s0 / 255;
        d[i + 1] = s1 / 255;
        d[i + 2] = s2 / 255;
        d[i + 3] = s3 / 255;
      } else {
        d[i] = s0 * 257;
        d[i + 1] = s1 * 257;
        d[i + 2] = s2 * 257;
        d[i + 3] = s3 * 257;
      }
      changed++;
      if (px < x1) x1 = px;
      if (px > x2) x2 = px;
      if (py < y1) y1 = py;
      if (py > y2) y2 = py;
    }
  }
  const result = { changed, restored, loosePixels, bounds: changed ? { x: x1, y: y1, width: x2 - x1 + 1, height: y2 - y1 + 1 } : null };
  if (backup) result.before = before;
  return result;
}

// ---------------------------------------------------------------------------------------------
// LUTs

const lut16Cache = new WeakMap();

/** A 256-entry table stretched to 65536 entries by linear interpolation between its entries. */
function lut16(lut) {
  let t = lut16Cache.get(lut);
  if (t) return t;
  t = new Uint16Array(65536);
  for (let v = 0; v < 65536; v++) {
    const x = v / 257;
    const i = x >= 255 ? 254 : x | 0;
    const f = x - i;
    t[v] = round16((lut[i] + (lut[i + 1] - lut[i]) * f) * 257);
  }
  lut16Cache.set(lut, t);
  return t;
}

/**
 * Applies 8-bit per-channel tables to deep planes with linear interpolation between the table
 * entries, so a smooth 16-bit ramp stays smooth (a 256-level table would band it). f32 samples
 * are looked up through the same interpolation after clamping to 0..1. Alpha is never touched.
 * @param {DeepPlanes} deep
 * @param {[ArrayLike<number>, ArrayLike<number>, ArrayLike<number>]} luts 256-entry tables for R, G, B
 * @param {Rect | null} [rect]
 */
export function applyLutDeep(deep, luts, rect = null) {
  assertPlanes(deep);
  const { width } = dims(deep);
  const r = region(deep, rect);
  if (!r.width) return deep;
  const d = deep.data;
  if (deep.type === 'u16') {
    const tr = lut16(luts[0]), tg = luts[1] === luts[0] ? tr : lut16(luts[1]), tb = luts[2] === luts[0] ? tr : luts[2] === luts[1] ? tg : lut16(luts[2]);
    for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
      let i = (y * width + r.x) * 4;
      for (let x = 0; x < r.width; x++, i += 4) {
        d[i] = tr[d[i]];
        d[i + 1] = tg[d[i + 1]];
        d[i + 2] = tb[d[i + 2]];
      }
    }
    return deep;
  }
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let i = (y * width + r.x) * 4;
    for (let x = 0; x < r.width; x++, i += 4) {
      for (let c = 0; c < 3; c++) {
        const lut = luts[c];
        const v = d[i + c];
        const xx = v >= 1 ? 255 : v > 0 ? v * 255 : 0;
        const k = xx >= 255 ? 254 : xx | 0;
        d[i + c] = (lut[k] + (lut[k + 1] - lut[k]) * (xx - k)) / 255;
      }
    }
  }
  return deep;
}

// ---------------------------------------------------------------------------------------------
// Exact float adjustments. Every function below mirrors adjust.js on the 0..255 scale (so the
// formulas read the same), without the rounding to integers; the samples go in and out through
// scale factors (1/257 for u16, 255 for f32).

const DEFAULT_LEVELS = Object.freeze({ inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 });
const identity = (v) => v;
const clamp255f = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

function vec3(v, fallback = [0, 0, 0]) {
  if (!v || typeof v !== 'object') return fallback;
  return [num(v[0], fallback[0]), num(v[1], fallback[1]), num(v[2], fallback[2])];
}

/** Levels as a function of a 0..255 float (levelsLut of adjust.js without the table). */
function levelsFn(levels) {
  const p = merge(DEFAULT_LEVELS, levels);
  const inB = clampNum(num(p.inBlack, 0), 0, 255);
  let inW = clampNum(num(p.inWhite, 255), 0, 255);
  if (inW <= inB) inW = inB + 1;
  const gamma = clampNum(num(p.gamma, 1), 0.01, 9.99);
  const outB = clampNum(num(p.outBlack, 0), 0, 255), outW = clampNum(num(p.outWhite, 255), 0, 255);
  const invG = 1 / gamma, range = inW - inB, outRange = outW - outB;
  return (v) => {
    let t = (v - inB) / range;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    if (gamma !== 1) t = Math.pow(t, invG);
    return outB + t * outRange;
  };
}

function normalisePoints(points) {
  const out = [];
  if (Array.isArray(points)) {
    for (const p of points) {
      if (!p) continue;
      const x = Array.isArray(p) ? p[0] : p.x, y = Array.isArray(p) ? p[1] : p.y;
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      out.push([clampNum(x, 0, 255), clampNum(y, 0, 255)]);
    }
  }
  out.sort((a, b) => a[0] - b[0]);
  const dedup = [];
  for (const p of out) {
    if (dedup.length && dedup[dedup.length - 1][0] === p[0]) dedup[dedup.length - 1] = p;
    else dedup.push(p);
  }
  return dedup;
}

/**
 * The Curves spline as a function of a 0..255 float: the monotone cubic Hermite spline
 * (Fritsch–Carlson slopes) through the points that adjust.js curveLut samples at the 256
 * integers, here evaluated wherever it is asked. Flat outside the first and last point; fewer
 * than two distinct points give the identity.
 * @param {Array<[number, number] | { x: number, y: number }>} points
 * @returns {(v: number) => number}
 */
export function curveFn(points) {
  const pts = normalisePoints(points);
  const n = pts.length;
  if (n < 2) return identity;
  const xs = new Float64Array(n), ys = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    xs[k] = pts[k][0];
    ys[k] = pts[k][1];
  }
  const delta = new Float64Array(n - 1), m = new Float64Array(n);
  for (let k = 0; k < n - 1; k++) delta[k] = (ys[k + 1] - ys[k]) / (xs[k + 1] - xs[k]);
  m[0] = delta[0];
  m[n - 1] = delta[n - 2];
  for (let k = 1; k < n - 1; k++) m[k] = delta[k - 1] * delta[k] <= 0 ? 0 : (delta[k - 1] + delta[k]) / 2;
  for (let k = 0; k < n - 1; k++) {
    if (delta[k] === 0) {
      m[k] = 0;
      m[k + 1] = 0;
      continue;
    }
    const a = m[k] / delta[k], b = m[k + 1] / delta[k];
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      m[k] = tau * a * delta[k];
      m[k + 1] = tau * b * delta[k];
    }
  }
  return (v) => {
    if (v <= xs[0]) return ys[0];
    if (v >= xs[n - 1]) return ys[n - 1];
    // binary search for the segment (curves have a handful of points, but the function is called 65536 times)
    let lo = 0, hi = n - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (xs[mid] <= v) lo = mid;
      else hi = mid - 1;
    }
    const k = lo;
    const h = xs[k + 1] - xs[k], t = (v - xs[k]) / h, t2 = t * t, t3 = t2 * t;
    return clamp255f((2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h * m[k] + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h * m[k + 1]);
  };
}

/** Per-channel functions for levels and curves: the channel's own curve first, then the composite one. */
function perChannelFns(p, build, usePerChannel) {
  const master = build(p.rgb);
  const out = [master, master, master];
  if (usePerChannel) {
    const chans = [p.r, p.g, p.b];
    for (let c = 0; c < 3; c++) {
      if (!chans[c]) continue;
      const own = build(chans[c]);
      // the 8-bit tables clamp between the two steps (they are tables); do the same so both depths agree
      out[c] = (v) => master(clamp255f(own(v)));
    }
  }
  return out;
}

function brightnessContrastFn(p) {
  const b = clampNum(num(p.brightness, 0), -150, 150), c = clampNum(num(p.contrast, 0), -100, 100);
  if (p.legacy) {
    const slope = c === 0 ? 1 : c >= 100 ? 1e6 : c <= -100 ? 0 : Math.tan(((c + 100) / 200) * (Math.PI / 2));
    return (v) => (v + b - 128) * slope + 128;
  }
  const mid = clampNum((128 + b * 0.6) / 255, 0.02, 0.98);
  const g = b === 0 ? 1 : Math.log(mid) / Math.log(0.5);
  const a = c > 0 ? (c / 100) * 3 : 0;
  const tanhA = a ? Math.tanh(a) : 1;
  const flat = 1 + c / 100;
  return (v) => {
    let t = v / 255;
    // the curve is defined on 0..1; HDR samples above white keep their distance to it
    const over = t > 1 ? t - 1 : 0;
    if (over) t = 1;
    else if (t < 0) t = 0;
    if (g !== 1) t = Math.pow(t, g);
    if (a) t = 0.5 + (Math.tanh(a * (2 * t - 1)) / tanhA) * 0.5;
    else if (c < 0) t = 0.5 + (t - 0.5) * flat;
    return (t + over) * 255;
  };
}

/** Exposure on a 0..255 float; `hdr` keeps results above white (f32) instead of clipping them. */
function exposureFn(p, hdr) {
  const e = clampNum(num(p.exposure, 0), -20, 20), off = clampNum(num(p.offset, 0), -0.5, 0.5), g = clampNum(num(p.gamma, 1), 0.01, 9.99);
  const mul = Math.pow(2, e), invG = 1 / g;
  return (v) => {
    let lin = srgbToLinear(v / 255) * mul + off;
    if (lin <= 0) return 0;
    if (g !== 1) lin = Math.pow(lin, invG);
    if (lin >= 1 && !hdr) return 255;
    return linearToSrgb(lin) * 255;
  };
}

function posterizeFn(p) {
  const n = clampNum(Math.round(num(p.levels, 4)), 2, 255);
  return (v) => {
    const k = Math.floor((clamp255f(v) * n) / 256);
    return ((k > n - 1 ? n - 1 : k) * 255) / (n - 1);
  };
}

const CB_POINT = 0.4;

function colorBalanceFns(p) {
  const sh = vec3(p.shadows), mid = vec3(p.midtones), hi = vec3(p.highlights);
  const fns = [];
  for (let c = 0; c < 3; c++) {
    const s = (clampNum(sh[c], -100, 100) / 100) * CB_POINT, h = (clampNum(hi[c], -100, 100) / 100) * CB_POINT;
    const expo = Math.pow(2, -clampNum(mid[c], -100, 100) / 100);
    fns.push((v) => {
      let t = v / 255;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      t = s >= 0 ? s + t * (1 - s) : t <= -s ? 0 : (t + s) / (1 + s);
      if (expo !== 1) t = Math.pow(t, expo);
      t = h >= 0 ? (t >= 1 - h ? 1 : t / (1 - h)) : t * (1 + h);
      return t * 255;
    });
  }
  return fns;
}

function photoFilterFns(p) {
  const col = parseColor(p.color, [236, 138, 0, 1]);
  const dens = clampNum(num(p.density, 0), 0, 100) / 100;
  const fns = [];
  for (let c = 0; c < 3; c++) {
    const k = 1 - dens + (dens * clamp255f(col[c])) / 255;
    fns.push((v) => v * k);
  }
  return fns;
}

/**
 * Per-channel kinds: [fnR, fnG, fnB] on 0..255 floats plus keepLuma (the Rec. 601 luma the
 * mapping removed is added back: Color Balance and Photo Filter's "preserve luminosity").
 */
const CHANNEL_KINDS = {
  'brightness-contrast': (p) => {
    const f = brightnessContrastFn(p);
    return { fns: [f, f, f] };
  },
  levels: (p) => ({ fns: perChannelFns(p, levelsFn, p.perChannel !== false) }),
  curves: (p) => ({ fns: perChannelFns(p, curveFn, true) }),
  exposure: (p, hdr) => {
    const f = exposureFn(p, hdr);
    return { fns: [f, f, f] };
  },
  invert: () => {
    const f = (v) => 255 - v;
    return { fns: [f, f, f] };
  },
  posterize: (p) => {
    const f = posterizeFn(p);
    return { fns: [f, f, f] };
  },
  'color-balance': (p) => ({ fns: colorBalanceFns(p), keepLuma: p.preserveLuminosity !== false }),
  'photo-filter': (p) => ({ fns: photoFilterFns(p), keepLuma: p.preserveLuminosity !== false }),
};

// Outputs of the per-pixel functions (no allocation in the loops).
let R = 0, G = 0, B = 0;

function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  else if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 0.5) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToScratch(h, s, l) {
  if (s <= 0) {
    R = G = B = l * 255;
    return;
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  let H = h / 360;
  H -= Math.floor(H);
  R = hue2rgb(p, q, H + 1 / 3) * 255;
  G = hue2rgb(p, q, H) * 255;
  B = hue2rgb(p, q, H - 1 / 3) * 255;
}

const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

const HUE_RANGES = Object.freeze({ master: -1, reds: 0, yellows: 60, greens: 120, cyans: 180, blues: 240, magentas: 300 });

function rangeWeight(h, centre) {
  let dh = h - centre;
  dh -= Math.floor(dh / 360) * 360;
  if (dh > 180) dh = 360 - dh;
  return dh <= 15 ? 1 : dh >= 45 ? 0 : (45 - dh) / 30;
}

const MIXER_IDENTITY = Object.freeze({
  r: Object.freeze({ r: 100, g: 0, b: 0, constant: 0 }),
  g: Object.freeze({ r: 0, g: 100, b: 0, constant: 0 }),
  b: Object.freeze({ r: 0, g: 0, b: 100, constant: 0 }),
  gray: Object.freeze({ r: 40, g: 40, b: 20, constant: 0 }),
});

function mixerRow(row, fallback) {
  const o = row && typeof row === 'object' ? row : fallback;
  return [
    clampNum(num(o.r, fallback.r), -200, 200) / 100,
    clampNum(num(o.g, fallback.g), -200, 200) / 100,
    clampNum(num(o.b, fallback.b), -200, 200) / 100,
    (clampNum(num(o.constant, fallback.constant), -200, 200) / 100) * 255,
  ];
}

/**
 * Per-pixel kinds: a factory (params) -> fn(r, g, b) on 0..255 floats that leaves its result in
 * the module's R, G, B (or null when the parameters are the identity).
 */
const PIXEL_KINDS = {
  desaturate: () => (r, g, b) => {
    R = G = B = luma(r, g, b);
  },
  threshold: (p) => {
    // the 8-bit kind compares the rounded luma with the level, i.e. luma >= level - 0.5
    const level = clampNum(Math.round(num(p.level, 128)), 1, 255) - 0.5;
    return (r, g, b) => {
      R = G = B = luma(r, g, b) >= level ? 255 : 0;
    };
  },
  'gradient-map': (p) => {
    // through the gradient model (G.4, J.9): a v2 def stays exact at 16 and 32 bits like 0.3's stops
    const sample = gradientSampler(normalizeGradient(p));
    const reverse = !!p.reverse;
    return (r, g, b) => {
      const t = clampNum(luma(r, g, b) / 255, 0, 1);
      const c = sample(reverse ? 1 - t : t);
      R = c[0];
      G = c[1];
      B = c[2];
    };
  },
  vibrance: (p) => {
    const vib = clampNum(num(p.vibrance, 0), -100, 100) / 100, sat = clampNum(num(p.saturation, 0), -100, 100) / 100;
    if (vib === 0 && sat === 0) return null;
    const kSat = 1 + sat;
    return (rr, gg, bb) => {
      R = rr;
      G = gg;
      B = bb;
      const max = rr > gg ? (rr > bb ? rr : bb) : gg > bb ? gg : bb;
      const min = rr < gg ? (rr < bb ? rr : bb) : gg < bb ? gg : bb;
      const delta = max - min;
      if (delta === 0) return;
      let k = kSat;
      if (vib !== 0) {
        const s = delta / max;
        let amt = vib * (1 - s) * (1 - s);
        if (vib > 0) {
          let h;
          if (max === rr) h = ((gg - bb) / delta + (gg < bb ? 6 : 0)) * 60;
          else if (max === gg) h = ((bb - rr) / delta + 2) * 60;
          else h = ((rr - gg) / delta + 4) * 60;
          const dh = Math.abs(h - 30);
          if (dh < 30) amt *= 1 - 0.5 * (1 - dh / 30);
        }
        k *= 1 + amt;
      }
      if (k === 1) return;
      const L = luma(rr, gg, bb);
      R = L + (rr - L) * k;
      G = L + (gg - L) * k;
      B = L + (bb - L) * k;
    };
  },
  'hue-saturation': (p) => {
    const hue = clampNum(num(p.hue, 0), -180, 180), sat = clampNum(num(p.saturation, 0), -100, 100), light = clampNum(num(p.lightness, 0), -100, 100);
    if (p.colorize) {
      const ch = num(p.colorizeHue, 0), cs = clampNum(num(p.colorizeSat, 25), 0, 100) / 100, cl = clampNum(num(p.colorizeLight, 0), -100, 100) / 100;
      return (r, g, b) => {
        let l = clampNum(luma(r, g, b) / 255, 0, 1);
        l = cl > 0 ? l + (1 - l) * cl : l * (1 + cl);
        hslToScratch(ch, cs, l);
      };
    }
    if (hue === 0 && sat === 0 && light === 0) return null;
    const centre = HUE_RANGES[p.range] ?? -1;
    const satF = sat / 100, lightF = light / 100;
    return (r0, g0, b0) => {
      let rr = r0, gg = g0, bb = b0;
      const max = rr > gg ? (rr > bb ? rr : bb) : gg > bb ? gg : bb;
      const min = rr < gg ? (rr < bb ? rr : bb) : gg < bb ? gg : bb;
      const l = (max + min) / 510;
      const delta = max - min;
      let s = 0, h = 0;
      if (delta > 0) {
        s = l > 0.5 ? delta / (510 - max - min) : delta / (max + min);
        if (max === rr) h = ((gg - bb) / delta + (gg < bb ? 6 : 0)) * 60;
        else if (max === gg) h = ((bb - rr) / delta + 2) * 60;
        else h = ((rr - gg) / delta + 4) * 60;
      }
      const wgt = centre < 0 ? 1 : delta > 0 ? rangeWeight(h, centre) : 0;
      if (wgt !== 0) {
        if (hue !== 0 && delta > 0) {
          hslToScratch(h + hue * wgt, s, l);
          rr = R;
          gg = G;
          bb = B;
        }
        if (sat !== 0 && delta > 0 && s > 0) {
          const target = satF > 0 ? s + (1 - s) * satF : s * (1 + satF);
          const k = 1 + (target / s - 1) * wgt;
          const L = luma(rr, gg, bb);
          rr = L + (rr - L) * k;
          gg = L + (gg - L) * k;
          bb = L + (bb - L) * k;
        }
        if (light !== 0) {
          const f = lightF * wgt;
          if (f > 0) {
            rr += (255 - rr) * f;
            gg += (255 - gg) * f;
            bb += (255 - bb) * f;
          } else {
            rr *= 1 + f;
            gg *= 1 + f;
            bb *= 1 + f;
          }
        }
      }
      R = rr;
      G = gg;
      B = bb;
    };
  },
  'black-white': (p) => {
    const wR = clampNum(num(p.reds, 40), -200, 300) / 100, wY = clampNum(num(p.yellows, 60), -200, 300) / 100, wG = clampNum(num(p.greens, 40), -200, 300) / 100;
    const wC = clampNum(num(p.cyans, 60), -200, 300) / 100, wB = clampNum(num(p.blues, 20), -200, 300) / 100, wM = clampNum(num(p.magentas, 80), -200, 300) / 100;
    const tint = p.tint && typeof p.tint === 'object' ? { hue: num(p.tint.hue, 42), sat: clampNum(num(p.tint.sat, 20), 0, 100) / 100 } : null;
    return (rr, gg, bb) => {
      let grey;
      if (rr >= gg) {
        if (gg >= bb) grey = bb + (gg - bb) * wY + (rr - gg) * wR;
        else if (rr >= bb) grey = gg + (bb - gg) * wM + (rr - bb) * wR;
        else grey = gg + (rr - gg) * wM + (bb - rr) * wB;
      } else if (rr >= bb) grey = bb + (rr - bb) * wY + (gg - rr) * wG;
      else if (gg >= bb) grey = rr + (bb - rr) * wC + (gg - bb) * wG;
      else grey = rr + (gg - rr) * wC + (bb - gg) * wB;
      if (tint) hslToScratch(tint.hue, tint.sat, clampNum(grey / 255, 0, 1));
      else R = G = B = grey;
    };
  },
  'channel-mixer': (p) => {
    if (p.monochrome) {
      const [kr, kg, kb, kc] = mixerRow(p.gray ?? p.r, MIXER_IDENTITY.gray);
      return (r, g, b) => {
        R = G = B = kr * r + kg * g + kb * b + kc;
      };
    }
    const [rr, rg, rb, rc] = mixerRow(p.r, MIXER_IDENTITY.r);
    const [gr, gg, gb, gc] = mixerRow(p.g, MIXER_IDENTITY.g);
    const [br, bg, bb, bc] = mixerRow(p.b, MIXER_IDENTITY.b);
    return (r, g, b) => {
      R = rr * r + rg * g + rb * b + rc;
      G = gr * r + gg * g + gb * b + gc;
      B = br * r + bg * g + bb * b + bc;
    };
  },
};

/** Kinds applyAdjustmentDeep evaluates in floating point on the deep samples. */
export const EXACT_KINDS = Object.freeze([...Object.keys(CHANNEL_KINDS), ...Object.keys(PIXEL_KINDS)]);

/** True when the kind has an exact deep implementation (the others go through 8 bits). */
/**
 * True when applyAdjustmentDeep evaluates this kind with these params in floating point: a kind with float maths
 * whose registry entry does not refuse the params (`deepExact(params) === false`: shapes the float code does not
 * know, such as Hue/Saturation ranges or Curves in Lab; I.4, J.9).
 */
export function isExactKind(kind, params = {}) {
  if (!Object.prototype.hasOwnProperty.call(CHANNEL_KINDS, kind) && !Object.prototype.hasOwnProperty.call(PIXEL_KINDS, kind)) return false;
  const def = Object.prototype.hasOwnProperty.call(ADJUSTMENTS, kind) ? ADJUSTMENTS[kind] : null;
  return deepExactFor(def, params ?? {});
}
const deepExactFor = (def, params) => (typeof def?.deepExact === 'function' ? def.deepExact(merge(def.defaults, params)) !== false : true);

/**
 * Whether a kind's 8-bit table (`def.lut`) is its whole effect on a deep image. Levels and Curves in the CMYK or Lab
 * space (J.9) convert per pixel: their table is the grey axis only, exact just for neutral pixels, so they take the
 * 8-bit fallback instead.
 */
export function lutCovers(kind, params = {}) {
  const def = Object.prototype.hasOwnProperty.call(ADJUSTMENTS, kind) ? ADJUSTMENTS[kind] : null;
  if (typeof def?.lut !== 'function') return false;
  return !((kind === 'levels' || kind === 'curves') && (params?.space === 'cmyk' || params?.space === 'lab'));
}

function applyChannelFns(deep, r, { fns, keepLuma }) {
  const { width } = dims(deep);
  const d = deep.data;
  if (deep.type === 'u16') {
    // one evaluation per possible sample: exact for every 16-bit input
    const tables = [];
    for (let c = 0; c < 3; c++) {
      const same = c > 0 ? fns.indexOf(fns[c]) : -1;
      if (same >= 0 && same < c) {
        tables.push(tables[same]);
        continue;
      }
      const fn = fns[c];
      if (keepLuma) {
        const t = new Float32Array(65536);
        for (let v = 0; v < 65536; v++) t[v] = clamp255f(fn(v / 257));
        tables.push(t);
      } else {
        const t = new Uint16Array(65536);
        for (let v = 0; v < 65536; v++) t[v] = round16(fn(v / 257) * 257);
        tables.push(t);
      }
    }
    const [tr, tg, tb] = tables;
    for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
      let i = (y * width + r.x) * 4;
      for (let x = 0; x < r.width; x++, i += 4) {
        if (!keepLuma) {
          d[i] = tr[d[i]];
          d[i + 1] = tg[d[i + 1]];
          d[i + 2] = tb[d[i + 2]];
          continue;
        }
        const r0 = d[i] / 257, g0 = d[i + 1] / 257, b0 = d[i + 2] / 257;
        const r1 = tr[d[i]], g1 = tg[d[i + 1]], b1 = tb[d[i + 2]];
        const dl = 0.299 * (r0 - r1) + 0.587 * (g0 - g1) + 0.114 * (b0 - b1);
        d[i] = round16((r1 + dl) * 257);
        d[i + 1] = round16((g1 + dl) * 257);
        d[i + 2] = round16((b1 + dl) * 257);
      }
    }
    return;
  }
  const [fr, fg, fb] = fns;
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let i = (y * width + r.x) * 4;
    for (let x = 0; x < r.width; x++, i += 4) {
      const r0 = d[i] * 255, g0 = d[i + 1] * 255, b0 = d[i + 2] * 255;
      let r1 = fr(r0), g1 = fg(g0), b1 = fb(b0);
      if (keepLuma) {
        const dl = 0.299 * (r0 - r1) + 0.587 * (g0 - g1) + 0.114 * (b0 - b1);
        r1 += dl;
        g1 += dl;
        b1 += dl;
      }
      d[i] = r1 > 0 ? r1 / 255 : 0;
      d[i + 1] = g1 > 0 ? g1 / 255 : 0;
      d[i + 2] = b1 > 0 ? b1 / 255 : 0;
    }
  }
}

function applyPixelFn(deep, r, fn) {
  const { width } = dims(deep);
  const d = deep.data;
  const u16 = deep.type === 'u16';
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let i = (y * width + r.x) * 4;
    for (let x = 0; x < r.width; x++, i += 4) {
      if (u16) {
        fn(d[i] / 257, d[i + 1] / 257, d[i + 2] / 257);
        d[i] = round16(R * 257);
        d[i + 1] = round16(G * 257);
        d[i + 2] = round16(B * 257);
      } else {
        fn(d[i] * 255, d[i + 1] * 255, d[i + 2] * 255);
        d[i] = R > 0 ? R / 255 : 0;
        d[i + 1] = G > 0 ? G / 255 : 0;
        d[i + 2] = B > 0 ? B / 255 : 0;
      }
    }
  }
}

/**
 * Runs an 8-bit operation on the quantised pixels of rect and adds what it changed onto the deep
 * samples: out = deep + (after8 - before8) in 8-bit steps. Pixels the operation leaves alone
 * keep their precise samples, and the proxy of the result is exactly the 8-bit result.
 * @param {DeepPlanes} deep
 * @param {(img: ImageDataLike) => void} op edits the rect-sized 8-bit image in place
 * @param {Rect | null} [rect]
 */
export function applyVia8Bit(deep, op, rect = null) {
  assertPlanes(deep);
  const { width } = dims(deep);
  const r = region(deep, rect);
  if (!r.width) return deep;
  const before = toCanvasData(deep, { rect: r });
  const after = { width: before.width, height: before.height, data: before.data.slice() };
  op(after);
  const d = deep.data, a = after.data, b = before.data;
  const u16 = deep.type === 'u16';
  for (let y = 0; y < r.height; y++) {
    let i = ((r.y + y) * width + r.x) * 4, j = y * r.width * 4;
    for (let x = 0; x < r.width; x++, i += 4, j += 4) {
      for (let c = 0; c < 4; c++) {
        const delta = a[j + c] - b[j + c];
        if (!delta) continue;
        if (u16) d[i + c] = round16(d[i + c] + delta * 257);
        else {
          // an f32 sample outside 0..1 has no 8-bit neighbourhood: it takes the 8-bit result
          const v = d[i + c];
          d[i + c] = v > 1 || v < 0 ? a[j + c] / 255 : Math.min(1, Math.max(0, v + delta / 255));
        }
      }
    }
  }
  return deep;
}

/**
 * Applies an adjustment kind of adjust.js to deep planes in place inside rect; alpha is never
 * changed. Kinds in EXACT_KINDS are evaluated in floating point on the deep samples (u16: every
 * one of the 65536 inputs is mapped exactly; f32: per sample, and Exposure keeps values above
 * white). Other kinds with a lut() go through applyLutDeep (smooth, but only as precise as
 * the 256-entry table) and the rest through applyVia8Bit; both report exact: false.
 * @param {DeepPlanes} deep needs width/height when rect is given
 * @param {string} kind
 * @param {object} [params] merged over the kind's defaults
 * @param {Rect | null} [rect]
 * @returns {{ exact: boolean }}
 */
export function applyAdjustmentDeep(deep, kind, params = {}, rect = null, ctx = null) {
  assertPlanes(deep);
  const def = Object.prototype.hasOwnProperty.call(ADJUSTMENTS, kind) ? ADJUSTMENTS[kind] : null;
  if (!def) throw new RangeError(`Unknown adjustment: ${String(kind)}`);
  const r = region(deep, rect);
  if (!r.width) return { exact: isExactKind(kind, params) };
  const p = merge(def.defaults, params);
  // the kind's own verdict first (deepExact, I.4): float code written for 0.3's params must not run on new shapes
  const exactOk = deepExactFor(def, params ?? {});
  if (exactOk && Object.prototype.hasOwnProperty.call(CHANNEL_KINDS, kind)) {
    applyChannelFns(deep, r, CHANNEL_KINDS[kind](p, deep.type === 'f32'));
    return { exact: true };
  }
  if (exactOk && Object.prototype.hasOwnProperty.call(PIXEL_KINDS, kind)) {
    const fn = PIXEL_KINDS[kind](p);
    if (fn) applyPixelFn(deep, r, fn);
    return { exact: true };
  }
  if (lutCovers(kind, params)) {
    applyLutDeep(deep, def.lut(params), r);
    return { exact: false };
  }
  // the 8-bit fallback sees the rect only: its ctx origin moves to the rect's corner (I.4)
  const subCtx = ctx ? { ...ctx, origin: { x: (ctx.origin?.x ?? 0) + r.x, y: (ctx.origin?.y ?? 0) + r.y } } : r.x || r.y ? { origin: { x: r.x, y: r.y }, docWidth: dims(deep).width, docHeight: dims(deep).height, scale: 1 } : null;
  applyVia8Bit(deep, (img) => def.apply(img, params, null, subCtx), r);
  return { exact: false };
}

// ---------------------------------------------------------------------------------------------
// Compositing and statistics

/** Blend modes blendDeep computes in float (the rest of the 27 composite at 8 bits). */
export const DEEP_BLEND_MODES = Object.freeze(['normal', 'multiply', 'screen']);

/**
 * Composites src over dst in floating point, in place in dst (straight alpha, the W3C
 * compositing formula): the flatten behind the 16-bit exports. src is placed at (x, y) of dst
 * and clipped to it; both need width/height. The two may have different sample types.
 * @param {DeepPlanes} dst
 * @param {DeepPlanes} src
 * @param {{ alpha?: number, mode?: 'normal'|'multiply'|'screen', x?: number, y?: number,
 *   mask?: { data: ArrayLike<number>, width: number, height: number, x?: number, y?: number, channels?: number, offset?: number } | null }} [options]
 *   alpha: layer opacity 0..1; mask: 0..255 coverage positioned in dst coordinates (channels/offset pick the
 *   sample when the mask is an RGBA image: channels 4, offset 3 reads its alpha); outside the mask the source is hidden
 */
export function blendDeep(dst, src, { alpha = 1, mode = 'normal', x = 0, y = 0, mask = null } = {}) {
  assertPlanes(dst);
  assertPlanes(src);
  if (!DEEP_BLEND_MODES.includes(mode)) throw new RangeError(`blendDeep cannot do ${String(mode)}`);
  const dw = dst.width, dh = dst.height, sw = src.width, sh = src.height;
  if (!(dw > 0 && dh > 0 && sw > 0 && sh > 0)) throw new TypeError('blendDeep needs planes with a width and a height');
  const x1 = Math.max(0, x), y1 = Math.max(0, y), x2 = Math.min(dw, x + sw), y2 = Math.min(dh, y + sh);
  if (x2 <= x1 || y2 <= y1 || !(alpha > 0)) return dst;
  const d = dst.data, s = src.data;
  const dk = dst.type === 'u16' ? 1 / 65535 : 1, sk = src.type === 'u16' ? 1 / 65535 : 1;
  const out16 = dst.type === 'u16';
  const mch = mask?.channels ?? 1, moff = mask?.offset ?? 0, mx = mask?.x ?? 0, my = mask?.y ?? 0;
  for (let py = y1; py < y2; py++) {
    let di = (py * dw + x1) * 4, si = ((py - y) * sw + (x1 - x)) * 4;
    for (let px = x1; px < x2; px++, di += 4, si += 4) {
      let as = s[si + 3] * sk * alpha;
      if (mask) {
        const ux = px - mx, uy = py - my;
        as *= ux >= 0 && uy >= 0 && ux < mask.width && uy < mask.height ? mask.data[(uy * mask.width + ux) * mch + moff] / 255 : 0;
      }
      if (!(as > 0)) continue;
      if (as > 1) as = 1;
      const ab = Math.min(1, d[di + 3] * dk);
      const ao = as + ab * (1 - as);
      for (let c = 0; c < 3; c++) {
        const cs = s[si + c] * sk, cb = d[di + c] * dk;
        let mixed = cs;
        if (mode !== 'normal' && ab > 0) {
          const bl = mode === 'multiply' ? cs * cb : cs + cb - cs * cb;
          mixed = (1 - ab) * cs + ab * bl;
        }
        const co = (as * mixed + (1 - as) * ab * cb) / ao;
        d[di + c] = out16 ? round16(co * 65535) : co;
      }
      d[di + 3] = out16 ? round16(ao * 65535) : ao;
    }
  }
  return dst;
}

/**
 * Per-channel statistics of the pixels in rect that are not fully transparent, in the planes' own
 * units (0..65535 or float): min, max, mean, standard deviation and, for u16, the number of
 * distinct values (a 16-bit ramp that went through 8 bits has at most 256).
 * @param {DeepPlanes} deep
 * @param {Rect | null} [rect]
 * @returns {{ type: 'u16'|'f32', count: number, channels: Array<{ min: number, max: number, mean: number, stdDev: number, distinct: number | null }> }} channels: R, G, B, A
 */
export function statistics(deep, rect = null) {
  assertPlanes(deep);
  const { width } = dims(deep);
  const r = region(deep, rect);
  const d = deep.data;
  const u16 = deep.type === 'u16';
  const min = [Infinity, Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity, -Infinity];
  const sum = [0, 0, 0, 0], sq = [0, 0, 0, 0];
  const seen = u16 ? [new Uint8Array(65536), new Uint8Array(65536), new Uint8Array(65536), new Uint8Array(65536)] : null;
  let count = 0;
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let i = (y * width + r.x) * 4;
    for (let x = 0; x < r.width; x++, i += 4) {
      if (!(d[i + 3] > 0)) continue;
      count++;
      for (let c = 0; c < 4; c++) {
        const v = d[i + c];
        if (v < min[c]) min[c] = v;
        if (v > max[c]) max[c] = v;
        sum[c] += v;
        sq[c] += v * v;
        if (seen) seen[c][v] = 1;
      }
    }
  }
  const channels = [];
  for (let c = 0; c < 4; c++) {
    const mean = count ? sum[c] / count : 0;
    let distinct = null;
    if (seen) {
      distinct = 0;
      for (let v = 0; v < 65536; v++) distinct += seen[c][v];
    }
    channels.push({ min: count ? min[c] : 0, max: count ? max[c] : 0, mean, stdDev: count ? Math.sqrt(Math.max(0, sq[c] / count - mean * mean)) : 0, distinct });
  }
  return { type: deep.type, count, channels };
}

/** One axis of resampleDeep: src (n samples per line of `count` lines, 4 channels) -> dst with m samples per line. */
function resampleAxis(src, n, m, count, horizontal) {
  const dst = new Float32Array(m * count * 4);
  const scale = n / m;
  // per output sample: first source index, then weights
  for (let o = 0; o < m; o++) {
    let i0, weights;
    if (scale > 1) {
      // shrinking: average the source span, edge samples weighted by how much of them the span covers
      const a = o * scale, b = (o + 1) * scale;
      i0 = Math.floor(a);
      const i1 = Math.min(n - 1, Math.ceil(b) - 1);
      weights = new Float64Array(i1 - i0 + 1);
      for (let i = i0; i <= i1; i++) weights[i - i0] = (Math.min(b, i + 1) - Math.max(a, i)) / scale;
    } else {
      // growing (or same size): linear interpolation between the two nearest samples
      const x = Math.min(n - 1, Math.max(0, (o + 0.5) * scale - 0.5));
      i0 = Math.min(n - 1, Math.floor(x));
      const f = x - i0;
      weights = i0 + 1 < n && f > 0 ? Float64Array.of(1 - f, f) : Float64Array.of(1);
    }
    for (let line = 0; line < count; line++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < weights.length; k++) {
        const s = (horizontal ? line * n + i0 + k : (i0 + k) * count + line) * 4;
        const w = weights[k];
        r += src[s] * w;
        g += src[s + 1] * w;
        b += src[s + 2] * w;
        a += src[s + 3] * w;
      }
      const d = (horizontal ? line * m + o : o * count + line) * 4;
      dst[d] = r;
      dst[d + 1] = g;
      dst[d + 2] = b;
      dst[d + 3] = a;
    }
  }
  return dst;
}

/**
 * Resizes planes in floating point (exports at another size): area averaging when shrinking,
 * linear interpolation when growing, on premultiplied samples so transparent pixels do not
 * bleed their colour. Returns new planes of the same type.
 * @param {DeepPlanes} deep needs width/height
 * @param {number} width
 * @param {number} height
 * @returns {DeepPlanes}
 */
export function resampleDeep(deep, width, height) {
  assertPlanes(deep);
  const sw = deep.width, sh = deep.height;
  if (!(sw > 0 && sh > 0)) throw new TypeError('resampleDeep needs planes with a width and a height');
  const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
  if (w === sw && h === sh) return cloneDeep(deep);
  const k = deep.type === 'u16' ? 1 / 65535 : 1;
  const s = deep.data;
  let work = new Float32Array(sw * sh * 4);
  for (let i = 0; i < work.length; i += 4) {
    const a = s[i + 3] * k;
    work[i] = s[i] * k * a;
    work[i + 1] = s[i + 1] * k * a;
    work[i + 2] = s[i + 2] * k * a;
    work[i + 3] = a;
  }
  if (w !== sw) work = resampleAxis(work, sw, w, sh, true);
  if (h !== sh) work = resampleAxis(work, sh, h, w, false);
  const out = createDeep(w, h, deep.type);
  const d = out.data;
  const u16 = deep.type === 'u16';
  for (let i = 0; i < work.length; i += 4) {
    const a = work[i + 3];
    if (!(a > 0)) continue;
    for (let c = 0; c < 3; c++) {
      const v = work[i + c] / a;
      d[i + c] = u16 ? round16(v * 65535) : v;
    }
    d[i + 3] = u16 ? round16(a * 65535) : a;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Carrying deep pixels over to a new canvas

/** Whether proxy pixel j of img8 is what a canvas shows for the (already quantised) pixel i of old8. */
function proxyPixelMatches(a, i, b, j) {
  const alpha = a[i + 3];
  if (alpha !== b[j + 3]) return false;
  if (alpha === 255) return a[i] === b[j] && a[i + 1] === b[j + 1] && a[i + 2] === b[j + 2];
  if (alpha === 0) return true;
  const k = alpha / 255;
  return Math.abs(Math.round(a[i] * k) - Math.round(b[j] * k)) <= 1 && Math.abs(Math.round(a[i + 1] * k) - Math.round(b[j + 1] * k)) <= 1 && Math.abs(Math.round(a[i + 2] * k) - Math.round(b[j + 2] * k)) <= 1;
}

/**
 * The row (or column) of an image with the most colour changes, i.e. the most recognisable one,
 * looking at up to 16 of them: { index, density } with density = changes per pixel.
 */
function busiestLine(img, vertical) {
  const { width: w, height: h, data: d } = img;
  const lines = vertical ? w : h, length = vertical ? h : w;
  const hop = (vertical ? w : 1) * 4;
  let best = 0, bestScore = -1;
  const step = Math.max(1, Math.floor(lines / 16));
  for (let l = Math.floor(step / 2); l < lines; l += step) {
    let score = 0;
    let i = (vertical ? l : l * w) * 4 + hop;
    for (let k = 1; k < length; k++, i += hop) if (d[i] !== d[i - hop] || d[i + 1] !== d[i - hop + 1] || d[i + 2] !== d[i - hop + 2] || d[i + 3] !== d[i - hop + 3]) score++;
    if (score > bestScore) {
      bestScore = score;
      best = l;
    }
  }
  return { index: best, density: length > 1 ? bestScore / (length - 1) : 0 };
}

/**
 * Where the small image sits inside the big one: { x, y } of its top-left corner, or null. One
 * row (or, with `vertical`, one column) of the small image is looked for in every position of the
 * big one; comparisons stop at the first differing pixel and `budget` bounds the work on images
 * that repeat themselves.
 */
function findInside(small, big, vertical, budget = 4e7) {
  const sw = small.width, sh = small.height, bw = big.width, bh = big.height;
  if (sw > bw || sh > bh) return null;
  const line = busiestLine(small, vertical).index;
  const s = small.data, b = big.data;
  const length = vertical ? sh : sw;
  const sHop = (vertical ? sw : 1) * 4, bHop = (vertical ? bw : 1) * 4;
  const s0 = (vertical ? line : line * sw) * 4;
  let work = 0;
  // (px, py): where the first pixel of the probe line would be in the big image
  const x0 = vertical ? line : 0, x1 = vertical ? bw - sw + line : bw - sw;
  const y0 = vertical ? 0 : line, y1 = vertical ? bh - sh : bh - sh + line;
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      let i = s0, j = (py * bw + px) * 4, n = 0;
      while (n < length && proxyPixelMatches(s, i, b, j)) {
        n++;
        i += sHop;
        j += bHop;
      }
      work += n + 1;
      if (n === length) return vertical ? { x: px - line, y: py } : { x: px, y: py - line };
      if (work > budget) return null;
    }
  }
  return null;
}

/**
 * Deep planes for a new canvas whose pixels came from a canvas that had deep planes: a crop, a
 * canvas that grew (a layer extended under a brush, Canvas Size), a flip or a quarter-turn move
 * pixels without changing them, so their precise samples can move along instead of being rebuilt
 * from the 8-bit proxy. The arrangement is found from the pixels themselves: the hinted offset
 * (same document position), then flips and quarter turns when the sizes allow, then a search
 * for one image inside the other. Whatever is tried, a sample is only carried to a pixel whose
 * proxy it quantises to, so a wrong guess cannot put wrong pixels anywhere; everything else
 * starts from the proxy.
 * @param {ImageDataLike} img the new canvas's pixels
 * @param {DeepPlanes} old the planes of the old canvas (width/height required)
 * @param {{ dx?: number, dy?: number, type?: 'u16'|'f32' }} [hint] dx, dy: position of the old canvas's corner in the new canvas
 * @returns {{ planes: DeepPlanes, carried: number, how: string | null }} carried: pixels that kept their deep samples
 */
export function carryOver(img, old, { dx = null, dy = null, type = old.type } = {}) {
  assertPlanes(old);
  const source = old.type === type ? old : convertDepth(old, type);
  const w = img.width, h = img.height, ow = old.width, oh = old.height;
  const planes = fromCanvasData(img, type);
  if (!(ow > 0 && oh > 0) || old.data.length !== ow * oh * 4) return { planes, carried: 0, how: null };
  const old8 = toCanvasData(source);
  const a = old8.data, b = img.data;
  // each candidate maps a pixel of the new canvas to one of the old canvas (or outside it)
  const offset = (ox, oy) => (x, y) => [x - ox, y - oy];
  const candidates = [];
  if (Number.isFinite(dx) && Number.isFinite(dy)) candidates.push(['offset', offset(Math.round(dx), Math.round(dy))]);
  if (w === ow && h === oh) {
    if (!(dx === 0 && dy === 0)) candidates.push(['offset', offset(0, 0)]);
    candidates.push(['flip-h', (x, y) => [ow - 1 - x, y]], ['flip-v', (x, y) => [x, oh - 1 - y]], ['rotate-180', (x, y) => [ow - 1 - x, oh - 1 - y]]);
  }
  if (w === oh && h === ow) {
    candidates.push(['rotate-90', (x, y) => [y, oh - 1 - x]], ['rotate--90', (x, y) => [ow - 1 - y, x]], ['transpose', (x, y) => [y, x]], ['transverse', (x, y) => [ow - 1 - y, oh - 1 - x]]);
  }
  // crop: the new canvas inside the old one; growth: the old canvas inside the new one. The probe is a row or a
  // column, whichever is more recognisable (a vertical gradient has identical rows); the other is the second try
  const columnFirst = busiestLine(img, true).density > busiestLine(img, false).density;
  for (const vertical of [columnFirst, !columnFirst]) {
    candidates.push(['search', () => {
      const found = findInside(img, old8, vertical);
      return found ? offset(-found.x, -found.y) : null;
    }], ['search', () => {
      const found = findInside(old8, img, vertical);
      return found ? offset(found.x, found.y) : null;
    }]);
  }
  const samples = Math.min(4096, w * h);
  const stride = Math.max(1, Math.floor((w * h) / samples));
  for (let [how, map] of candidates) {
    if (how === 'search') {
      map = map();
      if (!map) continue;
      how = 'offset';
    }
    let inside = 0, hits = 0;
    for (let p = Math.floor(stride / 2); p < w * h; p += stride) {
      const o = map(p % w, Math.floor(p / w));
      if (o[0] < 0 || o[1] < 0 || o[0] >= ow || o[1] >= oh) continue;
      inside++;
      if (proxyPixelMatches(a, (o[1] * ow + o[0]) * 4, b, p * 4)) hits++;
    }
    if (!inside || hits < inside * 0.9) continue;
    const s = source.data, d = planes.data;
    let carried = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = map(x, y);
        if (o[0] < 0 || o[1] < 0 || o[0] >= ow || o[1] >= oh) continue;
        const i = (o[1] * ow + o[0]) * 4, j = (y * w + x) * 4;
        if (!proxyPixelMatches(a, i, b, j)) continue;
        d[j] = s[i];
        d[j + 1] = s[i + 1];
        d[j + 2] = s[i + 2];
        d[j + 3] = s[i + 3];
        carried++;
      }
    }
    return { planes, carried, how };
  }
  return { planes, carried: 0, how: null };
}
