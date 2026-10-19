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

import { clampRect, makeLut, applyLut, clamp255 } from './core.js';
import { hslToRgb, parseColor } from './color.js';

/** @typedef {import('./core.js').ImageDataLike} ImageDataLike */
/** @typedef {import('./core.js').Rect} Rect */
/**
 * @typedef {'brightness-contrast'|'levels'|'curves'|'exposure'|'vibrance'|'hue-saturation'|
 *   'color-balance'|'black-white'|'photo-filter'|'channel-mixer'|'invert'|'posterize'|'threshold'|
 *   'gradient-map'|'selective-color'|'desaturate'|'equalize'|'shadows-highlights'} AdjustmentKind
 */
/** @typedef {[Uint8ClampedArray, Uint8ClampedArray, Uint8ClampedArray]} LutTriple */

// ---------------------------------------------------------------------------------------------
// Small helpers (module private)

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** Finite number or fallback. */
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const clampNum = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
/** Rounds half up into 0..255 (Uint8ClampedArray assignment would round half to even). */
const round8 = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : (v + 0.5) | 0);
/** Integer Rec. 601 luma of 8-bit channels. */
const lumaInt = (r, g, b) => (0.299 * r + 0.587 * g + 0.114 * b + 0.5) | 0;

/** Shallow merge that ignores undefined values in params (so `{ hue: undefined }` keeps the default). */
function merge(defaults, params) {
  const out = { ...defaults };
  if (params) for (const k in params) if (params[k] !== undefined) out[k] = params[k];
  return out;
}

/** [a, b, c] of finite numbers from an array-like, else the fallback. */
function vec3(v, fallback = [0, 0, 0]) {
  if (!v || typeof v !== 'object') return fallback;
  return [num(v[0], fallback[0]), num(v[1], fallback[1]), num(v[2], fallback[2])];
}

const region = (img, rect) => clampRect(rect, img.width, img.height);

// Scratch outputs of the allocation-free HSL -> RGB conversion used in per-pixel loops (same maths
// as color.js hslToRgb, which allocates a result array and is used here only to build tables).
let R = 0, G = 0, B = 0;

function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  else if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 0.5) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

/** h in degrees (any), s and l 0..1 -> R, G, B 0..255 (floats) in the module scratch. */
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

/**
 * Applies per-channel LUTs, then adds back the Rec. 601 luma the mapping removed so only the
 * colour changes (Photoshop's "preserve luminosity").
 */
function applyLutKeepLuma(img, lr, lg, lb, rect) {
  const r = region(img, rect);
  if (!r.width) return img;
  const d = img.data, w = img.width;
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let i = (y * w + r.x) * 4;
    for (let x = 0; x < r.width; x++, i += 4) {
      const r0 = d[i], g0 = d[i + 1], b0 = d[i + 2];
      const r1 = lr[r0], g1 = lg[g0], b1 = lb[b0];
      const dl = 0.299 * (r0 - r1) + 0.587 * (g0 - g1) + 0.114 * (b0 - b1);
      d[i] = round8(r1 + dl);
      d[i + 1] = round8(g1 + dl);
      d[i + 2] = round8(b1 + dl);
    }
  }
  return img;
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

/** Color Balance tables: v + shadows * ws(v) + midtones * wm(v) + highlights * wh(v) per channel. */
function colorBalanceLuts(p) {
  const sh = vec3(p.shadows), mid = vec3(p.midtones), hi = vec3(p.highlights);
  const luts = [];
  for (let c = 0; c < 3; c++) {
    const s = clampNum(sh[c], -100, 100), m = clampNum(mid[c], -100, 100), h = clampNum(hi[c], -100, 100);
    luts.push(makeLut((v) => {
      const ws = 1.075 - 1 / ((255 - v) / 16 + 1); // ~1 at black, ~0.075 at white
      const wh = 1.075 - 1 / (v / 16 + 1); // ~1 at white, ~0.075 at black
      const dm = (v - 127) / 127;
      const wm = 0.667 * (1 - dm * dm); // bell peaking at 127
      return v + s * ws + m * wm + h * wh;
    }));
  }
  return luts;
}

function photoFilterLuts(p) {
  const col = parseColor(p.color, [236, 138, 0, 1]);
  const dens = clampNum(num(p.density, 25), 0, 100) / 100;
  const luts = [];
  for (let c = 0; c < 3; c++) {
    const k = 1 - dens + (dens * clamp255(col[c])) / 255;
    luts.push(makeLut((v) => v * k));
  }
  return luts;
}

/** 3 x 256 tables (grey -> tinted RGB) for Black & White's tint, built with color.js. */
function tintLuts(tint) {
  const hue = num(tint.hue, 42), sat = clampNum(num(tint.sat, 20), 0, 100) / 100;
  const lr = new Uint8ClampedArray(256), lg = new Uint8ClampedArray(256), lb = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    const [r, g, b] = hslToRgb(hue, sat, v / 255);
    lr[v] = round8(r);
    lg[v] = round8(g);
    lb[v] = round8(b);
  }
  return [lr, lg, lb];
}

/** Gradient map tables: luma -> RGB, linear between sorted stops ({ offset 0..1, color }). */
function gradientLuts(stops, reverse) {
  let list = [];
  if (Array.isArray(stops)) {
    for (const s of stops) {
      if (!s) continue;
      const offset = Array.isArray(s) ? s[0] : s.offset ?? s.position ?? s.pos;
      const color = Array.isArray(s) ? s[1] : s.color;
      if (typeof offset !== 'number' || !Number.isFinite(offset)) continue;
      list.push({ offset: reverse ? 1 - clampNum(offset, 0, 1) : clampNum(offset, 0, 1), color: parseColor(color, [0, 0, 0, 1]) });
    }
  }
  if (!list.length) list = [{ offset: 0, color: [0, 0, 0, 1] }, { offset: 1, color: [255, 255, 255, 1] }];
  list.sort((a, b) => a.offset - b.offset);
  const lr = new Uint8ClampedArray(256), lg = new Uint8ClampedArray(256), lb = new Uint8ClampedArray(256);
  let k = 0;
  for (let v = 0; v < 256; v++) {
    const t = v / 255;
    while (k < list.length - 2 && list[k + 1].offset <= t) k++;
    const a = list[k], b = list[Math.min(k + 1, list.length - 1)];
    const span = b.offset - a.offset;
    const f = span <= 0 ? (t >= b.offset ? 1 : 0) : clampNum((t - a.offset) / span, 0, 1);
    lr[v] = round8(a.color[0] + (b.color[0] - a.color[0]) * f);
    lg[v] = round8(a.color[1] + (b.color[1] - a.color[1]) * f);
    lb[v] = round8(a.color[2] + (b.color[2] - a.color[2]) * f);
  }
  return [lr, lg, lb];
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

function gradientMap(img, p, rect) {
  const [lr, lg, lb] = gradientLuts(p.stops, !!p.reverse);
  const r = region(img, rect);
  if (!r.width) return img;
  const d = img.data, w = img.width;
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let i = (y * w + r.x) * 4;
    for (let x = 0; x < r.width; x++, i += 4) {
      const l = lumaInt(d[i], d[i + 1], d[i + 2]);
      d[i] = lr[l];
      d[i + 1] = lg[l];
      d[i + 2] = lb[l];
    }
  }
  return img;
}

const HUE_RANGES = Object.freeze({ master: -1, reds: 0, yellows: 60, greens: 120, cyans: 180, blues: 240, magentas: 300 });

/** 1 within +-15 degrees of centre, 0 beyond +-45, linear in between (Photoshop's default range). */
function rangeWeight(h, centre) {
  let dh = h - centre;
  dh -= Math.floor(dh / 360) * 360; // 0..360
  if (dh > 180) dh = 360 - dh;
  return dh <= 15 ? 1 : dh >= 45 ? 0 : (45 - dh) / 30;
}

function hueSaturation(img, p, rect) {
  const hue = clampNum(num(p.hue, 0), -180, 180), sat = clampNum(num(p.saturation, 0), -100, 100), light = clampNum(num(p.lightness, 0), -100, 100);
  const colorize = !!p.colorize;
  const centre = colorize ? -1 : HUE_RANGES[p.range] ?? -1;
  const r = region(img, rect);
  if (!r.width) return img;
  const d = img.data, w = img.width;
  if (colorize) {
    const ch = num(p.colorizeHue, 0), cs = clampNum(num(p.colorizeSat, 25), 0, 100) / 100, cl = clampNum(num(p.colorizeLight, 0), -100, 100) / 100;
    // 256 greys -> colourised RGB; the pixel's luma picks the entry.
    const lr = new Uint8ClampedArray(256), lg = new Uint8ClampedArray(256), lb = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) {
      let l = v / 255;
      l = cl > 0 ? l + (1 - l) * cl : l * (1 + cl);
      hslToScratch(ch, cs, l);
      lr[v] = round8(R);
      lg[v] = round8(G);
      lb[v] = round8(B);
    }
    for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
      let i = (y * w + r.x) * 4;
      for (let x = 0; x < r.width; x++, i += 4) {
        const l = lumaInt(d[i], d[i + 1], d[i + 2]);
        d[i] = lr[l];
        d[i + 1] = lg[l];
        d[i + 2] = lb[l];
      }
    }
    return img;
  }
  if (hue === 0 && sat === 0 && light === 0) return img;
  const satF = sat / 100, lightF = light / 100;
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let i = (y * w + r.x) * 4;
    for (let x = 0; x < r.width; x++, i += 4) {
      let rr = d[i], gg = d[i + 1], bb = d[i + 2];
      // HSL of the pixel (h 0..360, s and l 0..1), no allocation.
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
      if (wgt === 0) continue;
      if (hue !== 0 && delta > 0) {
        hslToScratch(h + hue * wgt, s, l);
        rr = R;
        gg = G;
        bb = B;
      }
      if (sat !== 0 && delta > 0) {
        // Scale chroma about the luma so -100 lands on exactly the desaturate result; positive
        // values push the HSL saturation towards 1 (as Photoshop does), negative scale it down.
        const target = satF > 0 ? s + (1 - s) * satF : s * (1 + satF);
        const k = 1 + (target / s - 1) * wgt;
        const L = 0.299 * rr + 0.587 * gg + 0.114 * bb;
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
      d[i] = round8(rr);
      d[i + 1] = round8(gg);
      d[i + 2] = round8(bb);
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
        const s = delta / max; // HSV saturation: the less saturated, the more vibrance acts
        let amt = vib * (1 - s);
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
  return p.preserveLuminosity === false ? applyLut(img, lr, lg, lb, rect) : applyLutKeepLuma(img, lr, lg, lb, rect);
}

function photoFilter(img, p, rect) {
  const [lr, lg, lb] = photoFilterLuts(p);
  return p.preserveLuminosity === false ? applyLut(img, lr, lg, lb, rect) : applyLutKeepLuma(img, lr, lg, lb, rect);
}

function blackWhite(img, p, rect) {
  const wR = clampNum(num(p.reds, 40), -200, 300) / 100, wY = clampNum(num(p.yellows, 60), -200, 300) / 100, wG = clampNum(num(p.greens, 40), -200, 300) / 100;
  const wC = clampNum(num(p.cyans, 60), -200, 300) / 100, wB = clampNum(num(p.blues, 20), -200, 300) / 100, wM = clampNum(num(p.magentas, 80), -200, 300) / 100;
  const tint = p.tint && typeof p.tint === 'object' ? tintLuts(p.tint) : null;
  const r = region(img, rect);
  if (!r.width) return img;
  const d = img.data, w = img.width;
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let i = (y * w + r.x) * 4;
    for (let x = 0; x < r.width; x++, i += 4) {
      const rr = d[i], gg = d[i + 1], bb = d[i + 2];
      // pixel = min * white + (mid - min) * secondary + (max - mid) * primary, each weighted.
      let grey;
      if (rr >= gg) {
        if (gg >= bb) grey = bb + (gg - bb) * wY + (rr - gg) * wR;
        else if (rr >= bb) grey = gg + (bb - gg) * wM + (rr - bb) * wR;
        else grey = gg + (rr - gg) * wM + (bb - rr) * wB;
      } else if (rr >= bb) grey = bb + (rr - bb) * wY + (gg - rr) * wG;
      else if (gg >= bb) grey = rr + (bb - rr) * wC + (gg - bb) * wG;
      else grey = rr + (gg - rr) * wC + (bb - gg) * wB;
      const v = round8(grey);
      if (tint) {
        d[i] = tint[0][v];
        d[i + 1] = tint[1][v];
        d[i + 2] = tint[2][v];
      } else d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  return img;
}

const MIXER_IDENTITY = Object.freeze({
  r: Object.freeze({ r: 100, g: 0, b: 0, constant: 0 }),
  g: Object.freeze({ r: 0, g: 100, b: 0, constant: 0 }),
  b: Object.freeze({ r: 0, g: 0, b: 100, constant: 0 }),
  gray: Object.freeze({ r: 40, g: 40, b: 20, constant: 0 }),
});

/** [r, g, b, constant] coefficients of one output channel: percentages -> factors, constant -> 8-bit offset. */
function mixerRow(row, fallback) {
  const o = row && typeof row === 'object' ? row : fallback;
  return [
    clampNum(num(o.r, fallback.r), -200, 200) / 100,
    clampNum(num(o.g, fallback.g), -200, 200) / 100,
    clampNum(num(o.b, fallback.b), -200, 200) / 100,
    (clampNum(num(o.constant, fallback.constant), -200, 200) / 100) * 255,
  ];
}

function channelMixer(img, p, rect) {
  const r = region(img, rect);
  if (!r.width) return img;
  const d = img.data, w = img.width;
  if (p.monochrome) {
    const [kr, kg, kb, kc] = mixerRow(p.gray ?? p.r, MIXER_IDENTITY.gray);
    for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
      let i = (y * w + r.x) * 4;
      for (let x = 0; x < r.width; x++, i += 4) {
        d[i] = d[i + 1] = d[i + 2] = round8(kr * d[i] + kg * d[i + 1] + kb * d[i + 2] + kc);
      }
    }
    return img;
  }
  const [rr, rg, rb, rc] = mixerRow(p.r, MIXER_IDENTITY.r);
  const [gr, gg, gb, gc] = mixerRow(p.g, MIXER_IDENTITY.g);
  const [br, bg, bb, bc] = mixerRow(p.b, MIXER_IDENTITY.b);
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let i = (y * w + r.x) * 4;
    for (let x = 0; x < r.width; x++, i += 4) {
      const sr = d[i], sg = d[i + 1], sb = d[i + 2];
      d[i] = round8(rr * sr + rg * sg + rb * sb + rc);
      d[i + 1] = round8(gr * sr + gg * sg + gb * sb + gc);
      d[i + 2] = round8(br * sr + bg * sg + bb * sb + bc);
    }
  }
  return img;
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
 * neutrals by 255 - |max + min - 255|). Relative mode scales a delta by the ink already present
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
      const dn = max + min - 255;
      const wn = (255 - (dn < 0 ? -dn : dn)) / 255;
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

/** Separable box blur (radius rad, edges replicated) of a w x h Float32 field, in place, using tmp. */
function boxBlurField(f, w, h, rad, tmp) {
  if (rad <= 0) return f;
  const win = 2 * rad + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w, last = w - 1;
    let sum = 0;
    for (let k = -rad; k <= rad; k++) sum += f[row + (k < 0 ? 0 : k > last ? last : k)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / win;
      const add = x + rad + 1, sub = x - rad;
      sum += f[row + (add > last ? last : add)] - f[row + (sub < 0 ? 0 : sub)];
    }
  }
  for (let x = 0; x < w; x++) {
    const last = h - 1;
    let sum = 0;
    for (let k = -rad; k <= rad; k++) sum += tmp[(k < 0 ? 0 : k > last ? last : k) * w + x];
    for (let y = 0; y < h; y++) {
      f[y * w + x] = sum / win;
      const add = y + rad + 1, sub = y - rad;
      sum += tmp[(add > last ? last : add) * w + x] - tmp[(sub < 0 ? 0 : sub) * w + x];
    }
  }
  return f;
}

/**
 * Shadows/Highlights: a box-blurred luma mask (radius px) decides how much each pixel is
 * "shadow" ((1 - m)^2) or "highlight" (m^2); shadows lifts towards white and highlights pulls
 * towards black by up to half the distance at 100. The mask is built from alpha-weighted luma
 * divided by blurred alpha (premultiplied averaging) so transparent neighbours do not darken it.
 */
function shadowsHighlights(img, p, rect) {
  const sh = clampNum(num(p.shadows, 35), 0, 100) / 100, hi = clampNum(num(p.highlights, 0), 0, 100) / 100;
  if (sh === 0 && hi === 0) return img;
  const rad = clampNum(Math.round(num(p.radius, 30)), 0, 1000);
  const r = region(img, rect);
  if (!r.width) return img;
  const d = img.data, w = img.width;
  const reg = clampRect({ x: r.x - rad, y: r.y - rad, width: r.width + 2 * rad, height: r.height + 2 * rad }, img.width, img.height);
  const rw = reg.width, rh = reg.height;
  const lum = new Float32Array(rw * rh);
  let alpha = null, opaque = true;
  for (let y = 0; y < rh; y++) {
    let i = ((reg.y + y) * w + reg.x) * 4, o = y * rw;
    for (let x = 0; x < rw; x++, i += 4, o++) {
      if (d[i + 3] !== 255) {
        opaque = false;
        break;
      }
    }
    if (!opaque) break;
  }
  if (!opaque) alpha = new Float32Array(rw * rh);
  for (let y = 0; y < rh; y++) {
    let i = ((reg.y + y) * w + reg.x) * 4, o = y * rw;
    for (let x = 0; x < rw; x++, i += 4, o++) {
      const a = d[i + 3] / 255;
      lum[o] = ((0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255) * a;
      if (alpha) alpha[o] = a;
    }
  }
  const tmp = new Float32Array(rw * rh);
  boxBlurField(lum, rw, rh, rad, tmp);
  if (alpha) boxBlurField(alpha, rw, rh, rad, tmp);
  const sAmt = sh * 0.5, hAmt = hi * 0.5;
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let i = (y * w + r.x) * 4, o = (y - reg.y) * rw + (r.x - reg.x);
    for (let x = 0; x < r.width; x++, i += 4, o++) {
      const rr = d[i], gg = d[i + 1], bb = d[i + 2];
      let m;
      if (alpha) {
        const a = alpha[o];
        m = a > 1e-6 ? lum[o] / a : (0.299 * rr + 0.587 * gg + 0.114 * bb) / 255;
      } else m = lum[o];
      m = m < 0 ? 0 : m > 1 ? 1 : m;
      const sw = (1 - m) * (1 - m) * sAmt, hw = m * m * hAmt;
      if (sw === 0 && hw === 0) continue;
      d[i] = round8(rr + (255 - rr) * sw - rr * hw);
      d[i + 1] = round8(gg + (255 - gg) * sw - gg * hw);
      d[i + 2] = round8(bb + (255 - bb) * sw - bb * hw);
    }
  }
  return img;
}

// ---------------------------------------------------------------------------------------------
// The registry

/** Builds a LUT kind: apply() is applyLut over lut(params). */
function lutKind(name, defaults, build) {
  const lut = (params) => build(merge(defaults, params));
  return Object.freeze({
    name,
    defaults,
    lut,
    apply(img, params, rect = null) {
      const [lr, lg, lb] = lut(params);
      return applyLut(img, lr, lg, lb, rect);
    },
  });
}

/** Builds a per-pixel kind. */
function pixelKind(name, defaults, fn) {
  return Object.freeze({
    name,
    defaults,
    apply(img, params, rect = null) {
      return fn(img, merge(defaults, params), rect);
    },
  });
}

const freezeDeep = (o) => {
  if (o && typeof o === 'object') {
    for (const k of Object.keys(o)) freezeDeep(o[k]);
    Object.freeze(o);
  }
  return o;
};

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
 * - color-balance { shadows, midtones, highlights: [cyanRed, magentaGreen, yellowBlue] -100..100, preserveLuminosity }.
 * - black-white { reds, yellows, greens, cyans, blues, magentas (percent), tint?: { hue, sat } | null }:
 *   Photoshop's min + (mid - min) * secondary + (max - mid) * primary weighting.
 * - photo-filter { color, density 0..100, preserveLuminosity }: multiplies by the filter colour at density.
 * - channel-mixer { r, g, b: { r, g, b, constant } percent, monochrome, gray }: monochrome uses the gray row (or r when absent).
 * - invert, desaturate (Rec. 601 luma), equalize (luma histogram equalisation, hue kept): no params.
 * - posterize { levels 2..255 }, threshold { level 1..255 } (luma >= level -> white).
 * - gradient-map { stops: [{ offset 0..1, color }], reverse }: luma picks the gradient colour.
 * - selective-color { reds..magentas, whites, neutrals, blacks: { c, m, y, k } -100..100, relative }: see selectiveColor.
 * - shadows-highlights { shadows 0..100, highlights 0..100, radius px }: see shadowsHighlights.
 * @type {Readonly<Record<AdjustmentKind, { name: string, defaults: object, apply: (img: ImageDataLike, params?: object, rect?: Rect | null) => ImageDataLike, lut?: (params?: object) => LutTriple }>>}
 */
export const ADJUSTMENTS = Object.freeze({
  'brightness-contrast': lutKind('Brightness/Contrast', freezeDeep({ brightness: 0, contrast: 0, legacy: false }), (p) => {
    const l = brightnessContrastLut(p);
    return [l, l, l];
  }),
  levels: lutKind('Levels', freezeDeep({ perChannel: false, rgb: { ...DEFAULT_LEVELS }, r: null, g: null, b: null }), (p) =>
    perChannelLuts(p, levelsLut, p.perChannel !== false)),
  curves: lutKind('Curves', freezeDeep({ rgb: [[0, 0], [255, 255]], r: null, g: null, b: null }), (p) => perChannelLuts(p, curveLut, true)),
  exposure: lutKind('Exposure', freezeDeep({ exposure: 0, offset: 0, gamma: 1 }), (p) => {
    const l = exposureLut(p);
    return [l, l, l];
  }),
  vibrance: pixelKind('Vibrance', freezeDeep({ vibrance: 0, saturation: 0 }), vibrance),
  'hue-saturation': pixelKind(
    'Hue/Saturation',
    freezeDeep({ hue: 0, saturation: 0, lightness: 0, colorize: false, colorizeHue: 0, colorizeSat: 25, colorizeLight: 0, range: 'master' }),
    hueSaturation,
  ),
  'color-balance': pixelKind('Color Balance', freezeDeep({ shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0], preserveLuminosity: true }), colorBalance),
  'black-white': pixelKind('Black & White', freezeDeep({ reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: null }), blackWhite),
  'photo-filter': pixelKind('Photo Filter', freezeDeep({ color: '#ec8a00', density: 25, preserveLuminosity: true }), photoFilter),
  'channel-mixer': pixelKind('Channel Mixer', freezeDeep({ r: { ...MIXER_IDENTITY.r }, g: { ...MIXER_IDENTITY.g }, b: { ...MIXER_IDENTITY.b }, gray: { ...MIXER_IDENTITY.gray }, monochrome: false }), channelMixer),
  invert: lutKind('Invert', freezeDeep({}), () => {
    const l = makeLut((v) => 255 - v);
    return [l, l, l];
  }),
  posterize: lutKind('Posterize', freezeDeep({ levels: 4 }), (p) => {
    const l = posterizeLut(p);
    return [l, l, l];
  }),
  threshold: pixelKind('Threshold', freezeDeep({ level: 128 }), threshold),
  'gradient-map': pixelKind('Gradient Map', freezeDeep({ stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }], reverse: false }), gradientMap),
  'selective-color': pixelKind(
    'Selective Color',
    freezeDeep(Object.fromEntries([...SELECTIVE_RANGES.map((k) => [k, { c: 0, m: 0, y: 0, k: 0 }]), ['relative', true]])),
    selectiveColor,
  ),
  desaturate: pixelKind('Desaturate', freezeDeep({}), (img, _p, rect) => desaturate(img, rect)),
  equalize: pixelKind('Equalize', freezeDeep({}), (img, _p, rect) => equalize(img, rect)),
  'shadows-highlights': pixelKind('Shadows/Highlights', freezeDeep({ shadows: 35, highlights: 0, radius: 30 }), shadowsHighlights),
});

/** Every kind id, in menu order. @type {readonly AdjustmentKind[]} */
export const ADJUSTMENT_KINDS = Object.freeze(Object.keys(ADJUSTMENTS));

/**
 * Applies one adjustment in place and returns img. Throws a RangeError for an unknown kind.
 * @param {ImageDataLike} img
 * @param {AdjustmentKind} kind
 * @param {object} [params] merged over the kind's defaults
 * @param {Rect | null} [rect] default: the whole image
 */
export function applyAdjustment(img, kind, params = {}, rect = null) {
  const def = Object.prototype.hasOwnProperty.call(ADJUSTMENTS, kind) ? ADJUSTMENTS[kind] : null;
  if (!def) throw new RangeError(`Unknown adjustment: ${String(kind)}`);
  return def.apply(img, params, rect);
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
  return applyLut(img, luts[0], luts[1], luts[2], rect);
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
  return applyLut(img, l, l, l, rect);
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
  return applyLut(img, luts[0], luts[1], luts[2], rect);
}
