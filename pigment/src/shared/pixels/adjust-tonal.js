// Tonal adjustments of 0.4 (adjust-tonal, ARCHITECTURE.md "0.4 features", package 7, J.9): the Levels and Curves
// tables in every channel space, drawn (pencil) curves, the Auto algorithms of Photoshop's Auto Color Correction
// Options, the black / grey / white point eyedroppers, the clipping display, and the histograms they read. Pure: typed
// arrays and plain loops, no DOM. adjust.js builds the `levels` and `curves` kinds from it.
//
// Channel spaces (J.9). Levels and Curves params carry `space: 'rgb' | 'gray' | 'cmyk' | 'lab'` (absent = 'rgb', 0.3's
// shape). Each space has a composite key and channel keys:
//   rgb  -> rgb, r, g, b        (0.3: the channel table first, then the composite one)
//   gray -> gray                (applied to r, g and b alike: exact for grey pixels)
//   cmyk -> cmyk, c, m, y, k    (a channel value is the ink's brightness, 255 = no ink, as Photoshop shows a CMYK
//                                channel; converted with color.js rgbToCmyk / cmykToRgb, the app's naive GCR)
//   lab  -> l, a, b             (no composite; L* 0..100 -> 0..255, a* and b* -128..127 -> 0..255)
// A Levels channel is { inBlack, inWhite, gamma, outBlack, outWhite }; a Curves channel is 0.3's [[in, out], ...] or
// { table: number[256] } (pencil mode). null or absent means the identity.

import { makeLut, clamp255 } from './core.js';
import { num, clampNum, round8, lumaInt, srgbToLinear, linearToSrgb, merge, region, applyLuts } from './adjust-def.js';
import { parseColor } from './color.js';

// ---------------------------------------------------------------------------------------------
// Tables

export const DEFAULT_LEVELS = Object.freeze({ inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 });

/**
 * Photoshop Levels as a 256-entry LUT: input black/white points (0..255), midtone gamma
 * (0.01..9.99, > 1 lightens: gamma 2 maps 128 to ~181) and output black/white points.
 * inWhite <= inBlack is treated as inBlack + 1 (a hard threshold).
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
export function normalisePoints(points) {
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

/** True when a Curves channel is a drawn (pencil) curve: { table: number[256] }. */
export const isTable = (ch) => !!ch && typeof ch === 'object' && !Array.isArray(ch) && Array.isArray(ch.table) && ch.table.length === 256;

/** A drawn curve's table as a LUT (values rounded and clamped; a malformed table is the identity). */
export function tableLut(ch) {
  if (!isTable(ch)) return makeLut((v) => v);
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.round(clamp255(num(ch.table[v], v)));
  return lut;
}

/** The LUT of one Curves channel: points or a table. */
export const curveChannelLut = (ch) => (isTable(ch) ? tableLut(ch) : curveLut(ch));

/** lut[v] = outer[inner[v]]. */
export function composeLut(outer, inner) {
  const out = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) out[v] = outer[inner[v]];
  return out;
}

export function isIdentityLut(lut) {
  for (let v = 0; v < 256; v++) if (lut[v] !== v) return false;
  return true;
}

/** Points that the monotone spline turns back into (nearly) the drawn table: Photoshop converts a pencil curve so. */
export function pointsFromTable(ch, count = 9) {
  const lut = tableLut(ch);
  const n = Math.max(2, Math.min(19, Math.round(count)));
  const pts = [];
  for (let i = 0; i < n; i++) {
    const x = Math.round((i * 255) / (n - 1));
    pts.push([x, lut[x]]);
  }
  return pts;
}

/** A pencil table from a curve's points (switching to pencil mode keeps the curve). */
export function tableFromPoints(points) {
  return { table: Array.from(curveLut(points)) };
}

/** Photoshop's Smooth (pencil mode): one pass of a 9-tap moving average; the end values stay. */
export function smoothTable(ch, radius = 4) {
  const lut = tableLut(ch);
  const out = new Array(256);
  out[0] = lut[0];
  out[255] = lut[255];
  for (let v = 1; v < 255; v++) {
    let sum = 0, n = 0;
    for (let k = -radius; k <= radius; k++) {
      const i = v + k;
      if (i < 0 || i > 255) continue;
      sum += lut[i];
      n++;
    }
    out[v] = Math.round(sum / n);
  }
  return { table: out };
}

/** Draws a pencil stroke from (x0, y0) to (x1, y1) into a table (input along x); returns a new channel. */
export function drawTable(ch, x0, y0, x1, y1) {
  const t = isTable(ch) ? ch.table.slice() : Array.from(curveLut(Array.isArray(ch) ? ch : null));
  let ax = Math.round(clampNum(x0, 0, 255)), bx = Math.round(clampNum(x1, 0, 255));
  let ay = clampNum(y0, 0, 255), by = clampNum(y1, 0, 255);
  if (ax > bx) [ax, bx, ay, by] = [bx, ax, by, ay];
  for (let x = ax; x <= bx; x++) t[x] = Math.round(bx === ax ? by : ay + ((by - ay) * (x - ax)) / (bx - ax));
  return { table: t };
}

// ---------------------------------------------------------------------------------------------
// Spaces

/** The channel spaces (J.9): composite key (null: none), channel keys and their menu names. */
export const TONAL_SPACES = Object.freeze({
  rgb: Object.freeze({ composite: 'rgb', channels: Object.freeze(['r', 'g', 'b']), label: 'RGB', names: Object.freeze({ rgb: 'RGB', r: 'Red', g: 'Green', b: 'Blue' }) }),
  gray: Object.freeze({ composite: 'gray', channels: Object.freeze([]), label: 'Gray', names: Object.freeze({ gray: 'Gray' }) }),
  cmyk: Object.freeze({ composite: 'cmyk', channels: Object.freeze(['c', 'm', 'y', 'k']), label: 'CMYK', names: Object.freeze({ cmyk: 'CMYK', c: 'Cyan', m: 'Magenta', y: 'Yellow', k: 'Black' }) }),
  lab: Object.freeze({ composite: null, channels: Object.freeze(['l', 'a', 'b']), label: 'Lab', names: Object.freeze({ l: 'Lightness', a: 'a', b: 'b' }) }),
});

/** The space of Levels / Curves params ('rgb' when absent or unknown). */
export const tonalSpace = (params) => (params && Object.prototype.hasOwnProperty.call(TONAL_SPACES, params.space) ? params.space : 'rgb');

/** The channel space a document mode edits in (Photoshop's channel menu follows the mode). */
export function spaceForMode(mode) {
  if (mode === 'grayscale' || mode === 'duotone' || mode === 'bitmap') return 'gray';
  if (mode === 'cmyk') return 'cmyk';
  if (mode === 'lab') return 'lab';
  return 'rgb';
}

/** Every key of a space: the composite first (when it has one), then the channels. */
export function spaceKeys(space) {
  const s = TONAL_SPACES[space] ?? TONAL_SPACES.rgb;
  return [...(s.composite ? [s.composite] : []), ...s.channels];
}

const ALL_TONAL_KEYS = ['rgb', 'r', 'g', 'b', 'gray', 'cmyk', 'c', 'm', 'y', 'k', 'l', 'a'];

/** True when the params change nothing in their space (every channel null or the identity). */
export function isIdentityTonal(kind, params) {
  const { luts } = tonalLuts(kind, params);
  return luts.every(isIdentityLut);
}

/**
 * The same adjustment expressed in another space: the composite goes to the composite (Lab's L channel takes a
 * composite, and a Lab composite-less set gives its L to the other composite), the channels by position. Used when a
 * preset made in one mode is picked in another.
 */
export function remapTonalSpace(kind, params, space) {
  const from = tonalSpace(params);
  if (from === space) return { ...params, space };
  const fk = spaceKeys(from), tk = spaceKeys(space);
  const out = {};
  for (const [k, v] of Object.entries(params ?? {})) if (!ALL_TONAL_KEYS.includes(k) && k !== 'space') out[k] = v;
  for (let i = 0; i < tk.length; i++) out[tk[i]] = fk[i] !== undefined && params?.[fk[i]] != null ? JSON.parse(JSON.stringify(params[fk[i]])) : null;
  out.space = space;
  if (kind === 'levels' && TONAL_SPACES[space].composite && !out[TONAL_SPACES[space].composite]) out[TONAL_SPACES[space].composite] = { ...DEFAULT_LEVELS };
  if (kind === 'curves' && TONAL_SPACES[space].composite && !out[TONAL_SPACES[space].composite]) out[TONAL_SPACES[space].composite] = [[0, 0], [255, 255]];
  return out;
}

/**
 * The final tables of Levels or Curves params in their space: { space, keys (the space's channel keys, the gray
 * space's one key), luts (one per key, the channel's own table then the composite one) }.
 */
export function tonalLuts(kind, params) {
  const p = params ?? {};
  const space = tonalSpace(p);
  const s = TONAL_SPACES[space];
  const build = kind === 'curves' ? curveChannelLut : levelsLut;
  const master = s.composite && p[s.composite] ? build(p[s.composite]) : makeLut((v) => v);
  if (!s.channels.length) return { space, keys: [s.composite], luts: [master] };
  // 0.3's Levels flag: perChannel === false ignores the r / g / b tables
  const usePerChannel = kind === 'curves' || space !== 'rgb' || p.perChannel !== false;
  const luts = s.channels.map((k) => (usePerChannel && p[k] ? composeLut(master, build(p[k])) : master));
  return { space, keys: [...s.channels], luts };
}

/** Linear interpolation into a LUT at a fractional 0..255 input. */
const lutAt = (lut, v) => {
  if (v <= 0) return lut[0];
  if (v >= 255) return lut[255];
  const i = v | 0, f = v - i;
  return f ? lut[i] + (lut[i + 1] - lut[i]) * f : lut[i];
};

/**
 * A direct-mapped cache of rgb -> rgb for the spaces that convert per pixel (CMYK, Lab): photographs repeat colours
 * a lot, and the conversions are dozens of operations each.
 */
function rgbMemo(fn) {
  const SIZE = 1 << 16, MASK = SIZE - 1;
  const keys = new Int32Array(SIZE).fill(-1), vals = new Int32Array(SIZE);
  return (r, g, b) => {
    const key = (r << 16) | (g << 8) | b;
    const h = (Math.imul(key, 0x9e3779b1) >>> 16) & MASK;
    if (keys[h] === key) return vals[h];
    const v = fn(r, g, b);
    keys[h] = key;
    vals[h] = v;
    return v;
  };
}

/** rgb (0..255 ints) -> the channel values of a space (0..255 floats), written into out. */
function toSpace(space, r, g, b, out) {
  if (space === 'cmyk') {
    const R = r / 255, G = g / 255, B = b / 255;
    const max = R > G ? (R > B ? R : B) : G > B ? G : B;
    const k = 1 - max;
    if (max <= 1e-9) {
      out[0] = out[1] = out[2] = 255;
      out[3] = 0;
      return out;
    }
    // brightness of each ink: 255 * (1 - ink)
    out[0] = 255 * (1 - (1 - R - k) / max);
    out[1] = 255 * (1 - (1 - G - k) / max);
    out[2] = 255 * (1 - (1 - B - k) / max);
    out[3] = 255 * max;
    return out;
  }
  // color.js rgbToLab inlined with a linearisation table (this runs per pixel)
  const R = TO_LINEAR[r], G = TO_LINEAR[g], B = TO_LINEAR[b];
  const fx = fLab((R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / XN);
  const fy = fLab(R * 0.2126729 + G * 0.7151522 + B * 0.072175);
  const fz = fLab((R * 0.0193339 + G * 0.119192 + B * 0.9503041) / ZN);
  out[0] = clampNum((116 * fy - 16) * 2.55, 0, 255);
  out[1] = clampNum(500 * (fx - fy) + 128, 0, 255);
  out[2] = clampNum(200 * (fy - fz) + 128, 0, 255);
  return out;
}

/** The channel values of a space back to rgb floats (0..255), written into out. */
function fromSpace(space, v, out) {
  if (space === 'cmyk') {
    const K = clampNum(v[3] / 255, 0, 1); // 1 - black ink
    out[0] = clampNum(v[0], 0, 255) * K;
    out[1] = clampNum(v[1], 0, 255) * K;
    out[2] = clampNum(v[2], 0, 255) * K;
    return out;
  }
  // color.js labToRgb inlined with a table for the sRGB encoding
  const fy = (v[0] / 2.55 + 16) / 116, fx = fy + (v[1] - 128) / 500, fz = fy - (v[2] - 128) / 200;
  const X = fInv(fx) * XN, Y = fInv(fy), Z = fInv(fz) * ZN;
  out[0] = toSrgb255(X * 3.2404542 + Y * -1.5371385 + Z * -0.4985314);
  out[1] = toSrgb255(X * -0.969266 + Y * 1.8760108 + Z * 0.041556);
  out[2] = toSrgb255(X * 0.0556434 + Y * -0.2040259 + Z * 1.0572252);
  return out;
}

const XN = 0.95047, ZN = 1.08883;
const fLab = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
const fInv = (t) => (t > 0.206893 ? t * t * t : (t - 16 / 116) / 7.787);
const TO_LINEAR = Float64Array.from({ length: 256 }, (_, v) => srgbToLinear(v / 255));
// linear light (0..1) -> sRGB 0..255, by a 4096-step table with interpolation (well under half a level off)
const SRGB_STEPS = 4096;
const TO_SRGB = Float64Array.from({ length: SRGB_STEPS + 1 }, (_, i) => linearToSrgb(i / SRGB_STEPS) * 255);
function toSrgb255(lin) {
  if (!(lin > 0)) return 0;
  if (lin >= 1) return 255;
  const f = lin * SRGB_STEPS, i = f | 0;
  return TO_SRGB[i] + (TO_SRGB[i + 1] - TO_SRGB[i]) * (f - i);
}

/** Applies Levels or Curves params in place inside rect (any space). Alpha is never changed. */
export function applyTonal(kind, img, params, rect = null) {
  const { space, luts } = tonalLuts(kind, params);
  if (space === 'rgb') return applyLuts(img, luts[0], luts[1], luts[2], rect);
  if (space === 'gray') return isIdentityLut(luts[0]) ? img : applyLuts(img, luts[0], luts[0], luts[0], rect);
  const ident = luts.map(isIdentityLut);
  if (ident.every(Boolean)) return img;
  const tmp = new Float64Array(4), back = new Float64Array(3);
  const map = rgbMemo((r, g, b) => {
    toSpace(space, r, g, b, tmp);
    for (let c = 0; c < luts.length; c++) if (!ident[c]) tmp[c] = lutAt(luts[c], tmp[c]);
    fromSpace(space, tmp, back);
    return (round8(back[0]) << 16) | (round8(back[1]) << 8) | round8(back[2]);
  });
  const r = region(img, rect);
  if (!r.width) return img;
  const d = img.data, w = img.width;
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let i = (y * w + r.x) * 4;
    for (let x = 0; x < r.width; x++, i += 4) {
      const v = map(d[i], d[i + 1], d[i + 2]);
      d[i] = v >>> 16;
      d[i + 1] = (v >>> 8) & 255;
      d[i + 2] = v & 255;
    }
  }
  return img;
}

/**
 * [lutR, lutG, lutB] of Levels or Curves params: exact in RGB and Gray; in CMYK and Lab, the tables the grey axis
 * takes (each grey through the space and back), exact for neutral pixels only. deep.js reads them as `lut`.
 */
export function tonalRgbLuts(kind, params) {
  const t = tonalLuts(kind, params);
  if (t.space === 'rgb') return t.luts;
  if (t.space === 'gray') return [t.luts[0], t.luts[0], t.luts[0]];
  const img = { width: 256, height: 1, data: new Uint8ClampedArray(256 * 4) };
  for (let v = 0; v < 256; v++) img.data.set([v, v, v, 255], v * 4);
  applyTonal(kind, img, params);
  const out = [new Uint8ClampedArray(256), new Uint8ClampedArray(256), new Uint8ClampedArray(256)];
  for (let v = 0; v < 256; v++) for (let c = 0; c < 3; c++) out[c][v] = img.data[v * 4 + c];
  return out;
}

/** deep.js may evaluate these params in float (I.4, J.9): RGB only, and no drawn curve. */
export function tonalDeepExact(kind, params) {
  if (tonalSpace(params) !== 'rgb') return false;
  if (kind === 'curves') for (const k of ['rgb', 'r', 'g', 'b']) if (isTable(params?.[k])) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Clipping display (Levels Alt-drag, Curves Show Clipping)

/**
 * Turns img (the pixels before the adjustment) into Photoshop's clipping display for the params: 'shadows' paints
 * white where nothing clips to black and shows each clipped channel (black where all clip); 'highlights' paints black
 * where nothing clips to white and the clipped channels in their colour (white where all clip). A channel clips when its
 * table maps the value onto the table's end value. Spaces without colour channels show grey levels by how many
 * channels clip.
 */
export function clippingView(img, kind, params, which = 'shadows', rect = null) {
  const { space, luts } = tonalLuts(kind, params);
  const lo = which !== 'highlights';
  const clipped = luts.map((lut) => {
    const end = lo ? lut[0] : lut[255];
    const out = new Uint8Array(256);
    for (let v = 0; v < 256; v++) out[v] = lo ? (lut[v] <= end ? 1 : 0) : lut[v] >= end ? 1 : 0;
    return out;
  });
  const r = region(img, rect);
  if (!r.width) return img;
  const d = img.data, w = img.width;
  const tmp = new Float64Array(4);
  const n = luts.length;
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let i = (y * w + r.x) * 4;
    for (let x = 0; x < r.width; x++, i += 4) {
      if (space === 'rgb') {
        for (let c = 0; c < 3; c++) {
          const hit = clipped[c][d[i + c]];
          d[i + c] = lo ? (hit ? 0 : 255) : hit ? 255 : 0;
        }
        continue;
      }
      let count = 0;
      if (space === 'gray') count = clipped[0][lumaInt(d[i], d[i + 1], d[i + 2])];
      else {
        toSpace(space, d[i], d[i + 1], d[i + 2], tmp);
        for (let c = 0; c < n; c++) count += clipped[c][Math.round(tmp[c])];
      }
      const k = count / (space === 'gray' ? 1 : n);
      const v = lo ? Math.round(255 * (1 - k)) : Math.round(255 * k);
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  return img;
}

// ---------------------------------------------------------------------------------------------
// Histograms

/**
 * Luma and r / g / b histograms of img inside rect; with `weights` (one byte per img pixel, a selection mask), only
 * pixels whose weight is at least 128 count. Transparent pixels never count.
 */
export function weightedHistogram(img, rect = null, weights = null) {
  const r = region(img, rect);
  const hr = new Uint32Array(256), hg = new Uint32Array(256), hb = new Uint32Array(256), hl = new Uint32Array(256);
  let count = 0;
  const d = img.data, w = img.width;
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let i = (y * w + r.x) * 4, p = y * w + r.x;
    for (let x = 0; x < r.width; x++, i += 4, p++) {
      if (d[i + 3] === 0 || (weights && weights[p] < 128)) continue;
      hr[d[i]]++;
      hg[d[i + 1]]++;
      hb[d[i + 2]]++;
      hl[lumaInt(d[i], d[i + 1], d[i + 2])]++;
      count++;
    }
  }
  return { r: hr, g: hg, b: hb, l: hl, count };
}

// ---------------------------------------------------------------------------------------------
// Auto (Auto Color Correction Options)

/**
 * Photoshop's Auto Color Correction Options: the algorithm ('brightness' Enhance Brightness and Contrast, 'mono'
 * Enhance Monochromatic Contrast, 'perChannel' Enhance Per Channel Contrast, 'darkLight' Find Dark & Light Colors),
 * Snap Neutral Midtones, the clipping percentages and the target colours.
 */
export const AUTO_DEFAULTS = Object.freeze({ algorithm: 'perChannel', snap: false, shadowClip: 0.1, highlightClip: 0.1, shadowColor: '#000000', midColor: '#808080', highlightColor: '#ffffff' });
export const AUTO_ALGORITHMS = Object.freeze([
  ['brightness', 'Enhance Brightness and Contrast'],
  ['mono', 'Enhance Monochromatic Contrast'],
  ['perChannel', 'Enhance Per Channel Contrast'],
  ['darkLight', 'Find Dark & Light Colors'],
]);

/** Options merged over the defaults, clamped (clip 0..9.99 %, as Photoshop's fields). */
export function autoOptions(opts) {
  const o = merge(AUTO_DEFAULTS, opts ?? {});
  return {
    algorithm: AUTO_ALGORITHMS.some(([k]) => k === o.algorithm) ? o.algorithm : AUTO_DEFAULTS.algorithm,
    snap: !!o.snap,
    shadowClip: clampNum(num(o.shadowClip, 0.1), 0, 9.99),
    highlightClip: clampNum(num(o.highlightClip, 0.1), 0, 9.99),
    shadowColor: typeof o.shadowColor === 'string' ? o.shadowColor : AUTO_DEFAULTS.shadowColor,
    midColor: typeof o.midColor === 'string' ? o.midColor : AUTO_DEFAULTS.midColor,
    highlightColor: typeof o.highlightColor === 'string' ? o.highlightColor : AUTO_DEFAULTS.highlightColor,
  };
}

const rgbOf = (c, fb) => {
  const v = parseColor(c, [...fb, 1]);
  return [clamp255(Math.round(v[0])), clamp255(Math.round(v[1])), clamp255(Math.round(v[2]))];
};

/** [lo, hi] of a histogram clipping lowPct / highPct percent of count at each end (null when flat). */
function clipRange(hist, count, lowPct, highPct) {
  const nLo = (count * lowPct) / 100, nHi = (count * highPct) / 100;
  let lo = 0, hi = 255, cum = 0;
  for (let v = 0; v < 256; v++) {
    cum += hist[v];
    if (cum > nLo) {
      lo = v;
      break;
    }
  }
  cum = 0;
  for (let v = 255; v >= 0; v--) {
    cum += hist[v];
    if (cum > nHi) {
      hi = v;
      break;
    }
  }
  return hi > lo + 1 ? [lo, hi] : null;
}

const levelsOf = (lo, hi, outB, outW, gamma = 1) => ({ inBlack: lo, inWhite: hi, gamma: Math.round(gamma * 100) / 100, outBlack: outB, outWhite: outW });
const isNeutral = (c) => c[0] === c[1] && c[1] === c[2];

/** Gamma that maps input s (after the black / white points) to target out (0.1..9.99; 1 when undefined). */
export function gammaFor(s, lvl, target) {
  const range = lvl.inWhite - lvl.inBlack, outRange = lvl.outWhite - lvl.outBlack;
  if (range <= 0 || outRange === 0) return 1;
  const t = (s - lvl.inBlack) / range, u = (target - lvl.outBlack) / outRange;
  if (!(t > 0.002 && t < 0.998 && u > 0.002 && u < 0.998)) return 1;
  return clampNum(Math.log(t) / Math.log(u), 0.1, 9.99);
}

/**
 * Levels params (RGB space) that Photoshop's Auto would set for img inside rect with the given options (weights: a
 * selection mask, as weightedHistogram). Neutral black / white targets with a single stretch go into the composite
 * (rgb); anything per channel goes into r / g / b.
 */
export function autoLevelsParams(img, options = null, rect = null, weights = null) {
  const o = autoOptions(options);
  const h = weightedHistogram(img, rect, weights);
  const out = { space: 'rgb', perChannel: true, rgb: { ...DEFAULT_LEVELS }, r: null, g: null, b: null };
  if (!h.count) return out;
  const sh = rgbOf(o.shadowColor, [0, 0, 0]), mid = rgbOf(o.midColor, [128, 128, 128]), hi = rgbOf(o.highlightColor, [255, 255, 255]);
  const neutralEnds = sh.every((v) => v === 0) && hi.every((v) => v === 255);
  const chans = [h.r, h.g, h.b];
  let per = null; // [lo, hi] per channel, or null
  if (o.algorithm === 'mono' || o.algorithm === 'brightness') {
    const lv = clipRange(h.l, h.count, o.shadowClip, o.highlightClip) ?? [0, 255];
    per = [lv, lv, lv];
    if (o.algorithm === 'brightness') {
      // Enhance Brightness and Contrast: the monochromatic stretch, then a gamma that brings the median luma to the
      // middle (limited to 0.5..2 so it never looks forced)
      let cum = 0, median = 128;
      for (let v = 0; v < 256; v++) if ((cum += h.l[v]) >= h.count / 2) {
        median = v;
        break;
      }
      const stretched = levelsOf(lv[0], lv[1], 0, 255);
      const g = clampNum(gammaFor(median, stretched, 128), 0.5, 2);
      if (neutralEnds && !o.snap) {
        out.rgb = levelsOf(lv[0], lv[1], 0, 255, g);
        return out;
      }
      per = per.map((x) => [...x, g]);
    }
  } else if (o.algorithm === 'perChannel') {
    per = chans.map((hist) => clipRange(hist, h.count, o.shadowClip, o.highlightClip) ?? [0, 255]);
  } else {
    per = darkLightColors(img, rect, weights, h, o);
  }
  if (neutralEnds && !o.snap && o.algorithm === 'mono') {
    out.rgb = levelsOf(per[0][0], per[0][1], 0, 255);
    return out;
  }
  const keys = ['r', 'g', 'b'];
  for (let c = 0; c < 3; c++) out[keys[c]] = levelsOf(per[c][0], per[c][1], sh[c], hi[c], per[c][2] ?? 1);
  if (o.snap) {
    // Snap Neutral Midtones: the average of the nearly neutral midtones becomes neutral (the target midtone colour;
    // with the default grey target, the colour's own brightness, so only the cast goes)
    const s = neutralSample(img, rect, weights);
    if (s) {
      const mapped = keys.map((k, c) => levelsLut(out[k])[s[c]]);
      const t = isNeutral(mid) ? Array(3).fill((mapped[0] * 299 + mapped[1] * 587 + mapped[2] * 114) / 1000) : mid;
      for (let c = 0; c < 3; c++) {
        const lv = { ...out[keys[c]], gamma: 1 };
        out[keys[c]] = { ...lv, gamma: Math.round(gammaFor(s[c], lv, t[c]) * 100) / 100 };
      }
    }
  }
  return out;
}

/** Find Dark & Light Colors: per channel, the average colour of the darkest and of the lightest clip-percent pixels. */
function darkLightColors(img, rect, weights, h, o) {
  const lv = clipRange(h.l, h.count, Math.max(o.shadowClip, 0.01), Math.max(o.highlightClip, 0.01)) ?? [0, 255];
  const r = region(img, rect);
  const d = img.data, w = img.width;
  const dark = [0, 0, 0], light = [0, 0, 0];
  let nd = 0, nl = 0;
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let i = (y * w + r.x) * 4, p = y * w + r.x;
    for (let x = 0; x < r.width; x++, i += 4, p++) {
      if (d[i + 3] === 0 || (weights && weights[p] < 128)) continue;
      const l = lumaInt(d[i], d[i + 1], d[i + 2]);
      if (l <= lv[0]) {
        dark[0] += d[i];
        dark[1] += d[i + 1];
        dark[2] += d[i + 2];
        nd++;
      }
      if (l >= lv[1]) {
        light[0] += d[i];
        light[1] += d[i + 1];
        light[2] += d[i + 2];
        nl++;
      }
    }
  }
  return [0, 1, 2].map((c) => {
    const lo = nd ? Math.round(dark[c] / nd) : 0, hi = nl ? Math.round(light[c] / nl) : 255;
    return hi > lo + 1 ? [lo, hi] : [0, 255];
  });
}

/** The average colour of the nearly neutral midtones of img (null when there are too few), else null. */
function neutralSample(img, rect, weights) {
  const r = region(img, rect);
  const d = img.data, w = img.width;
  let sr = 0, sg = 0, sb = 0, n = 0, all = 0, ar = 0, ag = 0, ab = 0;
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let i = (y * w + r.x) * 4, p = y * w + r.x;
    for (let x = 0; x < r.width; x++, i += 4, p++) {
      if (d[i + 3] === 0 || (weights && weights[p] < 128)) continue;
      const R = d[i], G = d[i + 1], B = d[i + 2];
      all++;
      ar += R;
      ag += G;
      ab += B;
      const max = R > G ? (R > B ? R : B) : G > B ? G : B, min = R < G ? (R < B ? R : B) : G < B ? G : B;
      const l = lumaInt(R, G, B);
      if (max - min < 48 && l > 40 && l < 215) {
        sr += R;
        sg += G;
        sb += B;
        n++;
      }
    }
  }
  if (!all) return null;
  if (n >= Math.max(1, all * 0.001)) return [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)];
  return [Math.round(ar / all), Math.round(ag / all), Math.round(ab / all)];
}

/** Levels params in any space from the RGB Auto result: RGB keeps them, other spaces take the luma stretch. */
export function autoTonalParams(kind, img, options = null, space = 'rgb', rect = null, weights = null) {
  let lv;
  if (space === 'rgb') lv = autoLevelsParams(img, options, rect, weights);
  else {
    const mono = autoLevelsParams(img, { ...autoOptions(options), algorithm: 'mono', snap: false, shadowColor: '#000000', highlightColor: '#ffffff' }, rect, weights);
    const base = mono.rgb;
    if (space === 'gray') lv = { space, gray: base };
    else if (space === 'cmyk') lv = { space, cmyk: base, c: null, m: null, y: null, k: null };
    else lv = { space, l: base, a: null, b: null };
  }
  if (kind !== 'curves') return lv;
  const out = { space: tonalSpace(lv) };
  for (const k of spaceKeys(out.space)) out[k] = lv[k] ? curvePointsFromLevels(lv[k]) : TONAL_SPACES[out.space].composite === k ? [[0, 0], [255, 255]] : null;
  return out;
}

/** Curve points equivalent to a Levels channel: the black and white points and, for a gamma, the midpoint of its curve. */
export function curvePointsFromLevels(lvl) {
  const l = merge(DEFAULT_LEVELS, lvl);
  const pts = [[Math.round(l.inBlack), Math.round(l.outBlack)], [Math.round(l.inWhite), Math.round(l.outWhite)]];
  if (l.gamma !== 1 && l.inWhite - l.inBlack > 4) {
    const x = Math.round((l.inBlack + l.inWhite) / 2);
    const t = (x - l.inBlack) / (l.inWhite - l.inBlack);
    pts.splice(1, 0, [x, Math.round(l.outBlack + Math.pow(t, 1 / l.gamma) * (l.outWhite - l.outBlack))]);
  }
  // the curve is flat outside its first and last point, as Levels is outside its input range
  return pts;
}

// ---------------------------------------------------------------------------------------------
// Eyedroppers

/** A sampled colour as the channel values of a space (0..255 each; gray: [luma]). */
export function sampleInSpace(space, rgba) {
  const [r, g, b] = rgba;
  if (space === 'rgb') return [r, g, b];
  if (space === 'gray') return [lumaInt(r, g, b)];
  return Array.from(toSpace(space, r, g, b, new Float64Array(4))).slice(0, space === 'cmyk' ? 4 : 3).map(Math.round);
}

const clampLevels = (l) => {
  const o = merge(DEFAULT_LEVELS, l);
  o.inBlack = clampNum(Math.round(o.inBlack), 0, 253);
  o.inWhite = clampNum(Math.round(o.inWhite), o.inBlack + 2, 255);
  return o;
};

/**
 * Levels after a black ('black'), grey ('gray') or white ('white') point eyedropper click on a pixel (rgba, before
 * the adjustment). Black and white move each channel's input point to the sample (output: the target colour's
 * channel); grey sets each channel's gamma so the sample becomes neutral (with the default grey target it keeps the
 * sample's brightness). Gray documents have no grey eyedropper (Photoshop's); Lab's black / white act on Lightness
 * and its grey on a and b; CMYK's grey on the three colour inks.
 */
export function levelsEyedropper(params, which, rgba, options = null) {
  const space = tonalSpace(params);
  const o = autoOptions(options);
  const p = JSON.parse(JSON.stringify(params ?? {}));
  p.space = space;
  const s = sampleInSpace(space, rgba);
  const sh = rgbOf(o.shadowColor, [0, 0, 0]), mid = rgbOf(o.midColor, [128, 128, 128]), hi = rgbOf(o.highlightColor, [255, 255, 255]);
  const keys = space === 'gray' ? ['gray'] : TONAL_SPACES[space].channels;
  const targetIn = (rgb) => sampleInSpace(space, rgb);
  if (which === 'black' || which === 'white') {
    const tgt = targetIn(which === 'black' ? sh : hi);
    const use = space === 'lab' ? ['l'] : keys;
    for (const k of use) {
      const c = keys.indexOf(k);
      const cur = merge(DEFAULT_LEVELS, p[k]);
      if (which === 'black') {
        cur.inBlack = s[c];
        cur.outBlack = Math.round(tgt[c]);
      } else {
        cur.inWhite = s[c];
        cur.outWhite = Math.round(tgt[c]);
      }
      if (which === 'black' && cur.inWhite <= cur.inBlack + 1) cur.inWhite = Math.min(255, cur.inBlack + 2);
      if (which === 'white' && cur.inWhite <= cur.inBlack + 1) cur.inBlack = Math.max(0, cur.inWhite - 2);
      p[k] = clampLevels(cur);
    }
  } else if (which === 'gray' && space !== 'gray') {
    const use = space === 'lab' ? ['a', 'b'] : space === 'cmyk' ? ['c', 'm', 'y'] : keys;
    const vals = use.map((k) => s[keys.indexOf(k)]);
    let target;
    if (space === 'lab') target = [128, 128];
    else if (isNeutral(mid)) {
      const mapped = use.map((k, i) => levelsLut({ ...merge(DEFAULT_LEVELS, p[k]), gamma: 1 })[vals[i]]);
      const m = space === 'rgb' ? (mapped[0] * 299 + mapped[1] * 587 + mapped[2] * 114) / 1000 : (mapped[0] + mapped[1] + mapped[2]) / 3;
      target = use.map(() => m);
    } else target = targetIn(mid);
    use.forEach((k, i) => {
      const cur = { ...merge(DEFAULT_LEVELS, p[k]), gamma: 1 };
      p[k] = { ...cur, gamma: Math.round(gammaFor(vals[i], cur, target[i]) * 100) / 100 };
    });
  }
  if (space === 'rgb') p.perChannel = true;
  return p;
}

/** Curve points with the point at x replaced by [x, y] (points within 3 levels of x go). */
function withPoint(points, x, y, mode) {
  let pts = normalisePoints(points?.length ? points : [[0, 0], [255, 255]]);
  if (mode === 'black') pts = pts.filter(([px]) => px > x);
  else if (mode === 'white') pts = pts.filter(([px]) => px < x);
  else pts = pts.filter(([px]) => Math.abs(px - x) > 3);
  pts.push([x, y]);
  if (mode === 'black' && !pts.some(([px]) => px > x)) pts.push([255, 255]);
  if (mode === 'white' && !pts.some(([px]) => px < x)) pts.push([0, 0]);
  return normalisePoints(pts).map(([a, b]) => [Math.round(a), Math.round(b)]);
}

/**
 * Curves after an eyedropper click (as levelsEyedropper): black and white move each channel's end point to the
 * sample; grey adds a point on each channel that makes the sample neutral. A drawn channel becomes points first.
 */
export function curvesEyedropper(params, which, rgba, options = null) {
  const space = tonalSpace(params);
  const o = autoOptions(options);
  const p = JSON.parse(JSON.stringify(params ?? {}));
  p.space = space;
  const s = sampleInSpace(space, rgba);
  const keys = space === 'gray' ? ['gray'] : TONAL_SPACES[space].channels;
  const sh = rgbOf(o.shadowColor, [0, 0, 0]), mid = rgbOf(o.midColor, [128, 128, 128]), hi = rgbOf(o.highlightColor, [255, 255, 255]);
  const pointsOf = (k) => (isTable(p[k]) ? pointsFromTable(p[k]) : p[k]);
  if (which === 'black' || which === 'white') {
    const tgt = sampleInSpace(space, which === 'black' ? sh : hi);
    for (const k of space === 'lab' ? ['l'] : keys) {
      const c = keys.indexOf(k);
      p[k] = withPoint(pointsOf(k), s[c], Math.round(tgt[c]), which);
    }
  } else if (which === 'gray' && space !== 'gray') {
    const use = space === 'lab' ? ['a', 'b'] : space === 'cmyk' ? ['c', 'm', 'y'] : keys;
    const vals = use.map((k) => s[keys.indexOf(k)]);
    let target;
    if (space === 'lab') target = [128, 128];
    else if (isNeutral(mid)) {
      const m = space === 'rgb' ? (vals[0] * 299 + vals[1] * 587 + vals[2] * 114) / 1000 : (vals[0] + vals[1] + vals[2]) / 3;
      target = use.map(() => m);
    } else target = sampleInSpace(space, mid);
    use.forEach((k, i) => {
      p[k] = withPoint(pointsOf(k), vals[i], Math.round(target[i]), 'gray');
    });
  }
  return p;
}

/**
 * Exposure after an eyedropper click: black sets Offset so the sample becomes black, white sets Exposure so it
 * becomes white, grey sets Exposure so it becomes middle grey (linear 0.214, sRGB 128). Reads the sample's luma.
 */
export function exposureEyedropper(params, which, rgba) {
  const p = { exposure: 0, offset: 0, gamma: 1, ...(params ?? {}) };
  const lin = srgbToLinear(lumaInt(rgba[0], rgba[1], rgba[2]) / 255);
  const mul = Math.pow(2, clampNum(num(p.exposure, 0), -20, 20));
  if (which === 'black') p.offset = Math.round(clampNum(-lin * mul, -0.5, 0.5) * 10000) / 10000;
  else if (lin > 1e-6) {
    const target = which === 'white' ? 1 : srgbToLinear(128 / 255);
    const want = target - num(p.offset, 0);
    if (want > 0) p.exposure = Math.round(clampNum(Math.log2(want / lin), -20, 20) * 100) / 100;
  }
  return p;
}

