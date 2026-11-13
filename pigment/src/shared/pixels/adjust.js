// Adjustments. Every entry of ADJUSTMENTS edits an ImageDataLike in place inside an optional rect
// (default: the whole image) and never changes alpha. Kinds that are a pure per-channel mapping
// (brightness/contrast, levels, curves, exposure, invert, posterize) expose lut(params) ->
// [lutR, lutG, lutB] so adjustment layers can cache the tables; their apply() is exactly
// applyLut(img, ...lut(params), rect). The other kinds run per pixel with typed arrays and plain
// loops (no per-pixel closures or allocations). Nothing reads or writes outside the image, and
// no kind averages colour across pixels except shadows/highlights, whose blurred mask is built
// from alpha-weighted (premultiplied) luminance so transparent pixels never bleed black.
//
// Colour maths: 8-bit straight alpha in and out, Rec. 601 luma from core.js. "Desaturate" and
// every "saturation -100" path produce that luma, so they agree with each other exactly.

import { makeLut, applyLut, clamp255 } from './core.js';
import { num, clampNum, round8, lumaInt, srgbToLinear, linearToSrgb, merge, freezeDeep, region, applyLuts, applyLutKeepLuma, lutKind, pixelKind, mergeTables } from './adjust-def.js';
import { ADJUSTMENTS_MORE } from './adjust-more.js';
// the colour kinds (Hue/Saturation, Black & White, Photo Filter, Channel Mixer, Gradient Map, Shadows/Highlights and
// the 0.4 placeholders) live in adjust-color.js since 0.4 (owned by adjust-color; this file by adjust-tonal)
import { ADJUSTMENTS_COLOR } from './adjust-color.js';

/** @typedef {import('./core.js').ImageDataLike} ImageDataLike */
/** @typedef {import('./core.js').Rect} Rect */
/**
 * @typedef {'brightness-contrast'|'levels'|'curves'|'exposure'|'vibrance'|'hue-saturation'|
 *   'color-balance'|'black-white'|'photo-filter'|'channel-mixer'|'invert'|'posterize'|'threshold'|
 *   'gradient-map'|'selective-color'|'desaturate'|'equalize'|'shadows-highlights'|'color-lookup'|'hdr-toning'|'match-color'|'replace-color'} AdjustmentKind
 */
/** @typedef {[Uint8ClampedArray, Uint8ClampedArray, Uint8ClampedArray]} LutTriple */

// ---------------------------------------------------------------------------------------------
// Small helpers (module private)

// num, clampNum, round8, lumaInt, srgbToLinear, linearToSrgb, merge, freezeDeep, region, applyLuts, lutKind and
// pixelKind come from adjust-def.js (shared with adjust-more.js)

/** [a, b, c] of finite numbers from an array-like, else the fallback. */
function vec3(v, fallback = [0, 0, 0]) {
  if (!v || typeof v !== 'object') return fallback;
  return [num(v[0], fallback[0]), num(v[1], fallback[1]), num(v[2], fallback[2])];
}


// ---------------------------------------------------------------------------------------------
// LUT builders (exported ones are reused by the UI to draw curves / levels previews)

const DEFAULT_LEVELS = Object.freeze({ inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 });

/**
 * Photoshop Levels as a 256-entry LUT: input black/white points (0..255), midtone gamma
 * (0.01..9.99, > 1 lightens: gamma 2 maps 128 to ~181) and output black/white points.
 * inWhite <= inBlack is treated as inBlack + 1 (a hard threshold).
 * @param {{ inBlack?: number, inWhite?: number, gamma?: number, outBlack?: number, outWhite?: number }} [levels]
 * @returns {Uint8ClampedArray}
 */
export function levelsLut(levels) {
  const p = merge(DEFAULT_LEVELS, levels);
  const inB = clampNum(num(p.inBlack, 0), 0, 255);
  let inW = clampNum(num(p.inWhite, 255), 0, 255);
  if (inW <= inB) inW = inB + 1;
  const gamma = clampNum(num(p.gamma, 1), 0.01, 9.99);
  const outB = clampNum(num(p.outBlack, 0), 0, 255), outW = clampNum(num(p.outWhite, 255), 0, 255);
  const invG = 1 / gamma, range = inW - inB, outRange = outW - outB;
  return makeLut((v) => {
    let t = (v - inB) / range;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    if (gamma !== 1) t = Math.pow(t, invG);
    return outB + t * outRange;
  });
}

/** Sorted, de-duplicated [x, y] pairs (0..255) from [[x, y]] or [{ x, y }] input. */
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
 * Photoshop Curves as a 256-entry LUT: a monotone cubic Hermite spline (Fritsch–Carlson slopes)
 * through the given points, so the curve passes through every point and never overshoots
 * between them; flat outside the first and last point. Fewer than two distinct points gives
 * the identity, and two points give a straight line.
 * @param {Array<[number, number] | { x: number, y: number }>} points 0..255 (any order)
 * @returns {Uint8ClampedArray}
 */
export function curveLut(points) {
  const pts = normalisePoints(points);
  const n = pts.length;
  if (n < 2) return makeLut((v) => v);
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
  const lut = new Uint8ClampedArray(256);
  let k = 0;
  for (let v = 0; v < 256; v++) {
    let y;
    if (v <= xs[0]) y = ys[0];
    else if (v >= xs[n - 1]) y = ys[n - 1];
    else {
      while (k < n - 2 && xs[k + 1] <= v) k++;
      const h = xs[k + 1] - xs[k], t = (v - xs[k]) / h, t2 = t * t, t3 = t2 * t;
      y = (2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h * m[k] + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h * m[k + 1];
    }
    lut[v] = Math.round(clamp255(y));
  }
  return lut;
}

/** lut[v] = outer[inner[v]]. */
function composeLut(outer, inner) {
  const out = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) out[v] = outer[inner[v]];
  return out;
}

/** Per-channel then composite ("rgb") tables for levels and curves. */
function perChannelLuts(p, build, usePerChannel) {
  const master = build(p.rgb);
  const out = [master, master, master];
  if (usePerChannel) {
    const chans = [p.r, p.g, p.b];
    for (let c = 0; c < 3; c++) if (chans[c]) out[c] = composeLut(master, build(chans[c]));
  }
  return out;
}

function brightnessContrastLut(p) {
  const b = clampNum(num(p.brightness, 0), -150, 150), c = clampNum(num(p.contrast, 0), -100, 100);
  if (p.legacy) {
    // Legacy: brightness is a plain offset, contrast a linear scale about 128 whose slope runs
    // from 0 (-100, flat grey) through 1 (0) to vertical (+100, a threshold).
    const slope = c === 0 ? 1 : c >= 100 ? 1e6 : c <= -100 ? 0 : Math.tan(((c + 100) / 200) * (Math.PI / 2));
    return makeLut((v) => (v + b - 128) * slope + 128);
  }
  // Non-legacy (CS3+): proportional like Levels/Curves. Brightness is a gamma curve with fixed
  // endpoints that moves mid grey by ~0.6 * brightness; contrast is a tanh S-curve about mid grey
  // (slope ~3 at +100) or a linear flattening towards mid grey for negative values.
  const mid = clampNum((128 + b * 0.6) / 255, 0.02, 0.98);
  const g = b === 0 ? 1 : Math.log(mid) / Math.log(0.5);
  const a = c > 0 ? (c / 100) * 3 : 0;
  const tanhA = a ? Math.tanh(a) : 1;
  const flat = 1 + c / 100;
  return makeLut((v) => {
    let t = v / 255;
    if (g !== 1) t = Math.pow(t, g);
    if (a) t = 0.5 + (Math.tanh(a * (2 * t - 1)) / tanhA) * 0.5;
    else if (c < 0) t = 0.5 + (t - 0.5) * flat;
    return t * 255;
  });
}

function exposureLut(p) {
  const e = clampNum(num(p.exposure, 0), -20, 20), off = clampNum(num(p.offset, 0), -0.5, 0.5), g = clampNum(num(p.gamma, 1), 0.01, 9.99);
  const mul = Math.pow(2, e), invG = 1 / g;
  return makeLut((v) => {
    let lin = srgbToLinear(v / 255) * mul + off;
    if (lin <= 0) return 0;
    if (g !== 1) lin = Math.pow(lin, invG);
    if (lin >= 1) return 255;
    return linearToSrgb(lin) * 255;
  });
}

function posterizeLut(p) {
  const n = clampNum(Math.round(num(p.levels, 4)), 2, 255);
  return makeLut((v) => (Math.floor((v * n) / 256) * 255) / (n - 1));
}

/** Black/white point travel (fraction of the range) of a Color Balance slider at +-100. */
const CB_POINT = 0.4;

/**
 * Color Balance tables, one per channel, as a per-channel Levels: the shadows slider moves the
 * channel's black point (adding colour raises the output black, removing it raises the input
 * black), highlights moves the white point the same way (adding lowers the input white,
 * removing lowers the output white) and midtones is a gamma (2^-m, so +-100 is gamma 2 / 0.5).
 * Each step is monotone, so tones never reverse; shadows keep white, highlights keep black and
 * midtones keep both.
 */
function colorBalanceLuts(p) {
  const sh = vec3(p.shadows), mid = vec3(p.midtones), hi = vec3(p.highlights);
  const luts = [];
  for (let c = 0; c < 3; c++) {
    const s = (clampNum(sh[c], -100, 100) / 100) * CB_POINT, h = (clampNum(hi[c], -100, 100) / 100) * CB_POINT;
    const expo = Math.pow(2, -clampNum(mid[c], -100, 100) / 100);
    luts.push(makeLut((v) => {
      let t = v / 255;
      t = s >= 0 ? s + t * (1 - s) : t <= -s ? 0 : (t + s) / (1 + s);
      if (expo !== 1) t = Math.pow(t, expo);
      t = h >= 0 ? (t >= 1 - h ? 1 : t / (1 - h)) : t * (1 + h);
      return t * 255;
    }));
  }
  return luts;
}

// ---------------------------------------------------------------------------------------------
// Per-pixel kinds

/** Writes Rec. 601 luma into r, g and b. */
function desaturate(img, rect) {
  const r = region(img, rect);
  if (!r.width) return img;
  const d = img.data, w = img.width;
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let i = (y * w + r.x) * 4;
    for (let x = 0; x < r.width; x++, i += 4) {
      d[i] = d[i + 1] = d[i + 2] = round8(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    }
  }
  return img;
}

function threshold(img, p, rect) {
  const level = clampNum(Math.round(num(p.level, 128)), 1, 255);
  const r = region(img, rect);
  if (!r.width) return img;
  const d = img.data, w = img.width;
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let i = (y * w + r.x) * 4;
    for (let x = 0; x < r.width; x++, i += 4) {
      d[i] = d[i + 1] = d[i + 2] = lumaInt(d[i], d[i + 1], d[i + 2]) >= level ? 255 : 0;
    }
  }
  return img;
}

function vibrance(img, p, rect) {
  const vib = clampNum(num(p.vibrance, 0), -100, 100) / 100, sat = clampNum(num(p.saturation, 0), -100, 100) / 100;
  if (vib === 0 && sat === 0) return img;
  const r = region(img, rect);
  if (!r.width) return img;
  const d = img.data, w = img.width;
  const kSat = 1 + sat;
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let i = (y * w + r.x) * 4;
    for (let x = 0; x < r.width; x++, i += 4) {
      const rr = d[i], gg = d[i + 1], bb = d[i + 2];
      const max = rr > gg ? (rr > bb ? rr : bb) : gg > bb ? gg : bb;
      const min = rr < gg ? (rr < bb ? rr : bb) : gg < bb ? gg : bb;
      const delta = max - min;
      if (delta === 0) continue; // grey stays grey
      let k = kSat;
      if (vib !== 0) {
        // HSV saturation: the less saturated, the more vibrance acts; (1 - s)^2 leaves colours
        // that are already vivid almost alone so they do not clip.
        const s = delta / max;
        let amt = vib * (1 - s) * (1 - s);
        if (vib > 0) {
          // Protect skin tones: hues within 30 degrees of orange (30) get up to half the boost.
          let h;
          if (max === rr) h = ((gg - bb) / delta + (gg < bb ? 6 : 0)) * 60;
          else if (max === gg) h = ((bb - rr) / delta + 2) * 60;
          else h = ((rr - gg) / delta + 4) * 60;
          const dh = Math.abs(h - 30);
          if (dh < 30) amt *= 1 - 0.5 * (1 - dh / 30);
        }
        k *= 1 + amt;
      }
      if (k === 1) continue;
      const L = 0.299 * rr + 0.587 * gg + 0.114 * bb;
      d[i] = round8(L + (rr - L) * k);
      d[i + 1] = round8(L + (gg - L) * k);
      d[i + 2] = round8(L + (bb - L) * k);
    }
  }
  return img;
}

function colorBalance(img, p, rect) {
  const [lr, lg, lb] = colorBalanceLuts(p);
  return p.preserveLuminosity === false ? applyLuts(img, lr, lg, lb, rect) : applyLutKeepLuma(img, lr, lg, lb, rect);
}

const SELECTIVE_RANGES = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks'];
const NO_INK = Object.freeze({ c: 0, m: 0, y: 0, k: 0 });

/** [c, m, y, k] factors (-1..1) of one selective-colour range. */
function inkRow(row) {
  const o = row && typeof row === 'object' ? row : NO_INK;
  return [clampNum(num(o.c, 0), -100, 100) / 100, clampNum(num(o.m, 0), -100, 100) / 100, clampNum(num(o.y, 0), -100, 100) / 100, clampNum(num(o.k, 0), -100, 100) / 100];
}

/**
 * Selective Color, approximated in RGB: a pixel's "ink" per channel is 1 - v/255 (cyan for red,
 * magenta for green, yellow for blue) and black is 1 - max/255. Each range's CMYK deltas are
 * weighted by how much the pixel belongs to it (reds/greens/blues by max - mid of the dominant
 * channel, yellows/cyans/magentas by mid - min, whites by 2*min - 255, blacks by 255 - 2*max,
 * neutrals by 255 - |max - 127.5| - |min - 127.5|, so pure hues, white and black are not
 * neutral). Relative mode scales a delta by the ink already present
 * (so it cannot touch pure white, like Photoshop), absolute adds it outright. Monotonic in every
 * slider.
 */
function selectiveColor(img, p, rect) {
  const rows = SELECTIVE_RANGES.map((name) => inkRow(p[name]));
  let any = false;
  for (const row of rows) for (const v of row) if (v !== 0) any = true;
  if (!any) return img;
  const relative = p.relative !== false;
  // Primary rows indexed by the max channel, secondary rows by the min channel.
  const prim = [rows[0], rows[2], rows[4]], sec = [rows[3], rows[5], rows[1]];
  const whites = rows[6], neutrals = rows[7], blacks = rows[8];
  const r = region(img, rect);
  if (!r.width) return img;
  const d = img.data, w = img.width;
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let i = (y * w + r.x) * 4;
    for (let x = 0; x < r.width; x++, i += 4) {
      const rr = d[i], gg = d[i + 1], bb = d[i + 2];
      let maxI, minI, max, mid, min;
      if (rr >= gg) {
        if (gg >= bb) { maxI = 0; minI = 2; max = rr; mid = gg; min = bb; }
        else if (rr >= bb) { maxI = 0; minI = 1; max = rr; mid = bb; min = gg; }
        else { maxI = 2; minI = 1; max = bb; mid = rr; min = gg; }
      } else if (rr >= bb) { maxI = 1; minI = 2; max = gg; mid = rr; min = bb; }
      else if (gg >= bb) { maxI = 1; minI = 0; max = gg; mid = bb; min = rr; }
      else { maxI = 2; minI = 0; max = bb; mid = gg; min = rr; }
      const wp = (max - mid) / 255, ws = (mid - min) / 255;
      const ww = min > 127 ? (2 * min - 255) / 255 : 0;
      const wb = max < 128 ? (255 - 2 * max) / 255 : 0;
      const dmax = max - 127.5, dmin = min - 127.5;
      const wn = (255 - (dmax < 0 ? -dmax : dmax) - (dmin < 0 ? -dmin : dmin)) / 255;
      const P = prim[maxI], S = sec[minI];
      const ac = wp * P[0] + ws * S[0] + ww * whites[0] + wn * neutrals[0] + wb * blacks[0];
      const am = wp * P[1] + ws * S[1] + ww * whites[1] + wn * neutrals[1] + wb * blacks[1];
      const ay = wp * P[2] + ws * S[2] + ww * whites[2] + wn * neutrals[2] + wb * blacks[2];
      const ak = wp * P[3] + ws * S[3] + ww * whites[3] + wn * neutrals[3] + wb * blacks[3];
      const kInk = relative ? 1 - max / 255 : 1;
      const dk = ak * kInk * 255;
      const cInk = 1 - rr / 255, mInk = 1 - gg / 255, yInk = 1 - bb / 255;
      d[i] = round8(rr - ac * (relative ? cInk : 1) * 255 - dk);
      d[i + 1] = round8(gg - am * (relative ? mInk : 1) * 255 - dk);
      d[i + 2] = round8(bb - ay * (relative ? yInk : 1) * 255 - dk);
    }
  }
  return img;
}

function equalize(img, rect) {
  const r = region(img, rect);
  if (!r.width) return img;
  const d = img.data, w = img.width;
  const hist = new Uint32Array(256);
  let count = 0;
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let i = (y * w + r.x) * 4;
    for (let x = 0; x < r.width; x++, i += 4) {
      if (d[i + 3] === 0) continue;
      hist[lumaInt(d[i], d[i + 1], d[i + 2])]++;
      count++;
    }
  }
  if (!count) return img;
  const map = new Uint8ClampedArray(256);
  let cum = 0, cmin = -1;
  for (let v = 0; v < 256; v++) {
    cum += hist[v];
    if (cmin < 0 && cum > 0) cmin = cum;
    map[v] = cum <= 0 ? 0 : count === cmin ? v : Math.round(((cum - cmin) / (count - cmin)) * 255);
  }
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let i = (y * w + r.x) * 4;
    for (let x = 0; x < r.width; x++, i += 4) {
      const l = lumaInt(d[i], d[i + 1], d[i + 2]);
      const nl = map[l];
      if (nl === l) continue;
      if (l === 0) {
        d[i] = d[i + 1] = d[i + 2] = nl;
      } else {
        const k = nl / l; // keeps hue and saturation, moves luma to its equalised value
        d[i] = round8(d[i] * k);
        d[i + 1] = round8(d[i + 1] * k);
        d[i + 2] = round8(d[i + 2] * k);
      }
    }
  }
  return img;
}

// ---------------------------------------------------------------------------------------------
// The registry


/**
 * Every adjustment kind, keyed by its id: { name, defaults, apply(img, params, rect?), lut?(params) }.
 * apply() merges params over defaults, edits img in place inside rect (default: whole image) and
 * returns img; alpha is never changed. Kinds with lut() are pure per-channel mappings whose
 * tables adjustment layers can cache and reapply with core.js applyLut.
 *
 * - brightness-contrast { brightness -150..150, contrast -100..100, legacy? }: legacy = offset and
 *   linear scale about 128; otherwise a gamma-like brightness curve and a tanh contrast S-curve
 *   with fixed endpoints (Photoshop CS3+ behaviour, approximated).
 * - levels { perChannel?, rgb, r?, g?, b? } each { inBlack, inWhite, gamma, outBlack, outWhite }:
 *   r/g/b tables (used when given, unless perChannel === false) are applied before rgb.
 * - curves { rgb: [[x, y]...], r?, g?, b? }: monotone cubic through the points; r/g/b before rgb.
 * - exposure { exposure -20..20 (stops, linear light), offset -0.5..0.5 (linear), gamma 0.01..9.99 (> 1 lightens) }.
 * - vibrance { vibrance -100..100 (boosts muted colours most, protects skin), saturation -100..100 }: chroma about luma.
 * - hue-saturation { hue, saturation, lightness, colorize?, colorizeHue, colorizeSat, colorizeLight, range }:
 *   hue shift via HSL; saturation scales chroma about luma (-100 == desaturate, +100 pushes HSL
 *   saturation to 1); lightness blends towards white/black; range limits the edit to a hue band
 *   (full within 15 degrees of the band centre, fading out by 45); colorize paints luma with one hue.
 * - color-balance { shadows, midtones, highlights: [cyanRed, magentaGreen, yellowBlue] -100..100, preserveLuminosity }:
 *   per-channel black point / gamma / white point (see colorBalanceLuts); preserveLuminosity
 *   (default) restores each pixel's Rec. 601 luma.
 * - black-white { reds, yellows, greens, cyans, blues, magentas (percent), tint?: { hue, sat } | null }:
 *   Photoshop's min + (mid - min) * secondary + (max - mid) * primary weighting.
 * - photo-filter { color, density 0..100, preserveLuminosity }: multiplies by the filter colour at density
 *   (density defaults to 0 so a new adjustment starts neutral; Photoshop's dialog suggests 25).
 * - channel-mixer { r, g, b: { r, g, b, constant } percent, monochrome, gray }: monochrome uses the gray row (or r when absent).
 * - invert, desaturate (Rec. 601 luma), equalize (luma histogram equalisation, hue kept): no params.
 * - posterize { levels 2..255 }, threshold { level 1..255 } (luma >= level -> white).
 * - gradient-map { stops: [{ offset 0..1, color }], reverse }: luma picks the gradient colour.
 * - selective-color { reds..magentas, whites, neutrals, blacks: { c, m, y, k } -100..100, relative }: see selectiveColor.
 * - shadows-highlights { shadows 0..100, highlights 0..100, radius px }: see shadowsHighlights (amounts
 *   default to 0, i.e. neutral; Photoshop's dialog suggests shadows 35).
 * Defaults of every parameter-driven kind are the identity; invert, posterize, threshold,
 * gradient-map, black-white, desaturate and equalize change the image by definition.
 * @type {Readonly<Record<AdjustmentKind, { name: string, defaults: object, apply: (img: ImageDataLike, params?: object, rect?: Rect | null) => ImageDataLike, lut?: (params?: object) => LutTriple }>>}
 */
const BUILTIN_ADJUSTMENTS = Object.freeze({
  'brightness-contrast': lutKind('Brightness/Contrast', freezeDeep({ brightness: 0, contrast: 0, legacy: false }), (p) => {
    const l = brightnessContrastLut(p);
    return [l, l, l];
  }),
  levels: lutKind('Levels', freezeDeep({ perChannel: true, rgb: { ...DEFAULT_LEVELS }, r: null, g: null, b: null }), (p) =>
    perChannelLuts(p, levelsLut, p.perChannel !== false)),
  curves: lutKind('Curves', freezeDeep({ rgb: [[0, 0], [255, 255]], r: null, g: null, b: null }), (p) => perChannelLuts(p, curveLut, true)),
  exposure: lutKind('Exposure', freezeDeep({ exposure: 0, offset: 0, gamma: 1 }), (p) => {
    const l = exposureLut(p);
    return [l, l, l];
  }),
  vibrance: pixelKind('Vibrance', freezeDeep({ vibrance: 0, saturation: 0 }), vibrance),
  'color-balance': pixelKind('Color Balance', freezeDeep({ shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0], preserveLuminosity: true }), colorBalance),
  invert: lutKind('Invert', freezeDeep({}), () => {
    const l = makeLut((v) => 255 - v);
    return [l, l, l];
  }),
  posterize: lutKind('Posterize', freezeDeep({ levels: 4 }), (p) => {
    const l = posterizeLut(p);
    return [l, l, l];
  }),
  threshold: pixelKind('Threshold', freezeDeep({ level: 128 }), threshold),
  'selective-color': pixelKind(
    'Selective Color',
    freezeDeep(Object.fromEntries([...SELECTIVE_RANGES.map((k) => [k, { c: 0, m: 0, y: 0, k: 0 }]), ['relative', true]])),
    selectiveColor,
  ),
  desaturate: pixelKind('Desaturate', freezeDeep({}), (img, _p, rect) => desaturate(img, rect)),
  equalize: pixelKind('Equalize', freezeDeep({}), (img, _p, rect) => equalize(img, rect)),
});

/**
 * The registry: the built-in kinds above merged with adjust-more.js (Color Lookup, HDR Toning, Match Color,
 * Replace Color). Entries may carry pure metadata read by the renderer: fields (dialog field specs), layer
 * (offered as an adjustment layer), placeholder (not implemented yet), smart (false: no smart filter).
 */
export const ADJUSTMENTS = mergeTables(BUILTIN_ADJUSTMENTS, ADJUSTMENTS_COLOR, ADJUSTMENTS_MORE);

/** Every kind id (registry order). @type {readonly string[]} */
export const ADJUSTMENT_KINDS = Object.freeze(Object.keys(ADJUSTMENTS));

/**
 * Applies one adjustment in place and returns img. Throws a RangeError for an unknown kind.
 * @param {ImageDataLike} img
 * @param {AdjustmentKind} kind
 * @param {object} [params] merged over the kind's defaults
 * @param {Rect | null} [rect] default: the whole image
 * @param {{ origin: { x: number, y: number }, docWidth: number, docHeight: number, scale: number } | null} [ctx] where img
 *   sits in the document (I.4; null: img is the whole document at its origin); kinds that depend on position read it
 */
export function applyAdjustment(img, kind, params = {}, rect = null, ctx = null) {
  const def = adjustmentDef(kind);
  if (!def) throw new RangeError(`Unknown adjustment: ${String(kind)}`);
  return def.apply(img, params, rect, ctx);
}

// Kinds registered at run time by tests only (the skeleton smoke spec's margin check needs a kind that declares
// `margin`, and the registry is a frozen table). Modules never register here: a kind lives in its package's table.
const TEST_KINDS = new Map();

/** Registers (def) or removes (null) a test-only kind; an id of the registry cannot be replaced. */
export function registerTestAdjustment(kind, def) {
  if (Object.prototype.hasOwnProperty.call(ADJUSTMENTS, kind)) throw new Error(`Adjustment kind exists: ${kind}`);
  if (def) TEST_KINDS.set(kind, def);
  else TEST_KINDS.delete(kind);
}

/** The definition of a kind (the registry first, then test kinds), or null. Readers of `margin` use it too. */
export function adjustmentDef(kind) {
  return Object.prototype.hasOwnProperty.call(ADJUSTMENTS, kind) ? ADJUSTMENTS[kind] : TEST_KINDS.get(kind) ?? null;
}

/**
 * Per-channel and luma histograms of the pixels in rect. Fully transparent pixels are skipped
 * (they have no colour), so count is the number of pixels that contributed.
 * @param {ImageDataLike} img
 * @param {Rect | null} [rect]
 * @returns {{ r: Uint32Array, g: Uint32Array, b: Uint32Array, l: Uint32Array, count: number }}
 */
export function histogram(img, rect = null) {
  const r = region(img, rect);
  const hr = new Uint32Array(256), hg = new Uint32Array(256), hb = new Uint32Array(256), hl = new Uint32Array(256);
  let count = 0;
  const d = img.data, w = img.width;
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let i = (y * w + r.x) * 4;
    for (let x = 0; x < r.width; x++, i += 4) {
      if (d[i + 3] === 0) continue;
      hr[d[i]]++;
      hg[d[i + 1]]++;
      hb[d[i + 2]]++;
      hl[lumaInt(d[i], d[i + 1], d[i + 2])]++;
      count++;
    }
  }
  return { r: hr, g: hg, b: hb, l: hl, count };
}

/** [lo, hi] input levels that clip clipPct percent of count at each end of hist, or null when flat. */
function clipLevels(hist, count, clipPct) {
  const clipN = (count * clampNum(num(clipPct, 0.1), 0, 49)) / 100;
  let lo = 0, hi = 255, cum = 0;
  for (let v = 0; v < 256; v++) {
    cum += hist[v];
    if (cum > clipN) {
      lo = v;
      break;
    }
  }
  cum = 0;
  for (let v = 255; v >= 0; v--) {
    cum += hist[v];
    if (cum > clipN) {
      hi = v;
      break;
    }
  }
  return hi > lo ? [lo, hi] : null;
}

/**
 * Auto Levels (Photoshop "Enhance Per Channel Contrast"): stretches each channel so that clip
 * percent of its pixels clip at each end. Colour casts may change since channels move independently.
 * @param {ImageDataLike} img
 * @param {{ clip?: number }} [options] clip in percent per side, default 0.1
 * @param {Rect | null} [rect] analysed and edited region
 */
export function autoLevels(img, { clip = 0.1 } = {}, rect = null) {
  const h = histogram(img, rect);
  if (!h.count) return img;
  const luts = [h.r, h.g, h.b].map((hist) => {
    const lv = clipLevels(hist, h.count, clip);
    return lv ? levelsLut({ inBlack: lv[0], inWhite: lv[1] }) : makeLut((v) => v);
  });
  return applyLuts(img, luts[0], luts[1], luts[2], rect);
}

/**
 * Auto Contrast (Photoshop "Enhance Monochromatic Contrast"): one stretch for all channels from
 * the luma histogram, so colours keep their relationships.
 * @param {ImageDataLike} img
 * @param {{ clip?: number }} [options] clip in percent per side, default 0.1
 * @param {Rect | null} [rect]
 */
export function autoContrast(img, { clip = 0.1 } = {}, rect = null) {
  const h = histogram(img, rect);
  if (!h.count) return img;
  const lv = clipLevels(h.l, h.count, clip);
  if (!lv) return img;
  const l = levelsLut({ inBlack: lv[0], inWhite: lv[1] });
  return applyLuts(img, l, l, l, rect);
}

/**
 * Auto Color (Photoshop "Find Dark & Light Colors" + "Snap Neutral Midtones"): stretches each
 * channel like autoLevels, then applies a per-channel gamma (0.5..2) that moves every channel's
 * mean towards the common mean, removing a midtone colour cast.
 * @param {ImageDataLike} img
 * @param {{ clip?: number }} [options] clip in percent per side, default 0.1
 * @param {Rect | null} [rect]
 */
export function autoColor(img, { clip = 0.1 } = {}, rect = null) {
  const h = histogram(img, rect);
  if (!h.count) return img;
  const hists = [h.r, h.g, h.b];
  const levels = hists.map((hist) => clipLevels(hist, h.count, clip) || [0, 255]);
  const stretched = levels.map((lv) => levelsLut({ inBlack: lv[0], inWhite: lv[1] }));
  const means = stretched.map((lut, c) => {
    let sum = 0;
    for (let v = 0; v < 256; v++) sum += lut[v] * hists[c][v];
    return sum / h.count;
  });
  const target = (means[0] + means[1] + means[2]) / 3;
  const luts = levels.map((lv, c) => {
    const m = means[c];
    let gamma = 1;
    if (m > 1 && m < 254 && target > 1 && target < 254) gamma = clampNum(Math.log(m / 255) / Math.log(target / 255), 0.5, 2);
    return levelsLut({ inBlack: lv[0], inWhite: lv[1], gamma });
  });
  return applyLuts(img, luts[0], luts[1], luts[2], rect);
}
