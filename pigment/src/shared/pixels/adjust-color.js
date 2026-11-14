// Colour adjustments (ARCHITECTURE.md "0.4 features": the skeleton moved them out of adjust.js so that adjust-tonal
// owns adjust.js and adjust-color owns this file): Hue/Saturation (Master and up to six colour ranges with editable
// bounds, J.9), Black & White (and its Auto), Photo Filter, Channel Mixer, Gradient Map (the gradient model with
// Reverse and Dither), Shadows/Highlights (Photoshop's "Show More Options" controls) and the 0.4 kinds Color and
// Vibrance, Clarity and Dehaze and Grain. Same conventions as adjust.js (in place, rect limits writes, alpha kept);
// merged into ADJUSTMENTS by adjust.js.
//
// 0.3's parameters give 0.3's pixels exactly: a single-range Hue/Saturation (`range` other than master) reads as
// Master 0 plus that range with Photoshop's default bounds, whose weight is computed with 0.3's own function; a
// Shadows/Highlights without the new keys, and a Gradient Map without `dither`, take 0.3's code paths
// (tests/unit/adjust-color.test.mjs compares them with the skeleton's copy, tests/unit/adjust-color-ref.mjs).
//
// Position-dependent kinds read the adjustment ctx (I.4): Grain and Gradient Map's dither seed their noise from
// document coordinates (ctx.origin + the pixel's place in img), and Clarity, Dehaze and Shadows/Highlights declare
// `margin`, so a partial repaint gives the pixels of a full one.
//
// Like adjust-more.js this module imports nothing from './adjust.js' (adjust.js imports this table; a cycle would
// make the import order matter). Helpers the tonal kinds share live in adjust-def.js.

import { clampRect, makeLut, clamp255 } from './core.js';
import { hslToRgb, parseColor } from './color.js';
import { num, clampNum, round8, lumaInt, freezeDeep, region, applyLuts, applyLutKeepLuma, pixelKind, srgbToLinear, linearToSrgb } from './adjust-def.js';
import { normalizeGradient, sampleGradient } from './gradient-model.js';

/** @typedef {import('./core.js').ImageDataLike} ImageDataLike */
/** @typedef {import('./core.js').Rect} Rect */

// ---------------------------------------------------------------------------------------------
// Helpers (module private)

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

/** Integer hash of a document position (and a salt) -> 0..1. Pure: the same pixel always gets the same value. */
function hash01(x, y, salt = 0) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(salt | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** The document position of img's (0, 0) (I.4): ctx.origin, or (0, 0) when img is the whole document. */
const originOf = (ctx) => [num(ctx?.origin?.x, 0) | 0, num(ctx?.origin?.y, 0) | 0];

function photoFilterLuts(p) {
  const col = parseColor(p.color, [236, 138, 0, 1]);
  const dens = clampNum(num(p.density, 0), 0, 100) / 100;
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

/**
 * Gradient map colours: luma -> RGB through the gradient model (G.4), so a v2 def from the gradient widget renders
 * as well as 0.3's `{ stops: [{ offset, color }], reverse }` (classic interpolation: 0.3's linear ramp). Floats (for
 * the dither) and the rounded tables (0.3's).
 */
function gradientColors(p) {
  const def = normalizeGradient(p);
  const f = new Float32Array(256 * 3);
  const reverse = !!p.reverse;
  for (let v = 0; v < 256; v++) {
    const c = sampleGradient(def, reverse ? 1 - v / 255 : v / 255);
    f[v * 3] = c[0];
    f[v * 3 + 1] = c[1];
    f[v * 3 + 2] = c[2];
  }
  return f;
}

// ---------------------------------------------------------------------------------------------
// Gradient Map

function gradientMap(img, p, rect, ctx) {
  const f = gradientColors(p);
  const r = region(img, rect);
  if (!r.width) return img;
  const d = img.data, w = img.width;
  if (!p.dither) {
    const lr = new Uint8ClampedArray(256), lg = new Uint8ClampedArray(256), lb = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) {
      lr[v] = round8(f[v * 3]);
      lg[v] = round8(f[v * 3 + 1]);
      lb[v] = round8(f[v * 3 + 2]);
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
  // Dither: up to half a level of noise before rounding hides banding; the noise belongs to the document position
  const [ox, oy] = originOf(ctx);
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let i = (y * w + r.x) * 4;
    for (let x = r.x, xe = r.x + r.width; x < xe; x++, i += 4) {
      const l = lumaInt(d[i], d[i + 1], d[i + 2]) * 3;
      const n = hash01(ox + x, oy + y, 7) - 0.5;
      d[i] = round8(f[l] + n);
      d[i + 1] = round8(f[l + 1] + n);
      d[i + 2] = round8(f[l + 2] + n);
    }
  }
  return img;
}

// ---------------------------------------------------------------------------------------------
// Hue/Saturation: Master and colour ranges (J.9)

/** The six colour ranges of Hue/Saturation, in Photoshop's order. */
export const HUE_BASES = Object.freeze(['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas']);
const HUE_RANGES = Object.freeze({ master: -1, reds: 0, yellows: 60, greens: 120, cyans: 180, blues: 240, magentas: 300 });
/** Photoshop's default bounds of each range [a, b, c, d] in degrees: full effect from b to c, fading out to a and d. */
export const DEFAULT_RANGE_BOUNDS = Object.freeze({
  reds: Object.freeze([315, 345, 15, 45]),
  yellows: Object.freeze([15, 45, 75, 105]),
  greens: Object.freeze([75, 105, 135, 165]),
  cyans: Object.freeze([135, 165, 195, 225]),
  blues: Object.freeze([195, 225, 255, 285]),
  magentas: Object.freeze([255, 285, 315, 345]),
});
export const MAX_HUE_RANGES = 6;

/** 1 within +-15 degrees of centre, 0 beyond +-45, linear in between (Photoshop's default range; 0.3's maths). */
function rangeWeight(h, centre) {
  let dh = h - centre;
  dh -= Math.floor(dh / 360) * 360; // 0..360
  if (dh > 180) dh = 360 - dh;
  return dh <= 15 ? 1 : dh >= 45 ? 0 : (45 - dh) / 30;
}

const wrap360 = (v) => {
  const x = v % 360;
  return x < 0 ? x + 360 : x;
};

/** Bounds as four numbers in 0..360, in order around the circle from a; null when they cannot be read. */
export function normalizeBounds(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const [a, b, c, d] = bounds.map(wrap360);
  // the four must follow each other going round from a (b - a, c - a, d - a increasing, under 360)
  const B = wrap360(b - a), C = wrap360(c - a), D = wrap360(d - a);
  if (!(B <= C && C <= D)) return null;
  return [a, b, c, d];
}

const isDefaultBounds = (base, b) => {
  const def = DEFAULT_RANGE_BOUNDS[base];
  return !!def && b[0] === def[0] && b[1] === def[1] && b[2] === def[2] && b[3] === def[3];
};

/** Weight 0..1 of hue h (degrees) in a range with bounds [a, b, c, d]: 0 outside a..d, 1 from b to c, linear between. */
export function boundsWeight(bounds, h) {
  const [a, b, c, d] = bounds;
  const H = wrap360(h - a), B = wrap360(b - a), C = wrap360(c - a), D = wrap360(d - a);
  if (H > D) return 0;
  if (H < B) return B > 0 ? H / B : 1;
  if (H <= C) return 1;
  return D > C ? (D - H) / (D - C) : 0;
}

/**
 * The colour ranges of Hue/Saturation params, read as J.9 says: `ranges` (at most six, one per base, values clamped),
 * or 0.3's single range (`range` other than master with the top-level values) as that range with the default bounds.
 * Returns { master: { hue, saturation, lightness }, ranges: [{ base, bounds, hue, saturation, lightness }] }.
 */
export function hueSatRanges(p) {
  const vals = (o) => ({ hue: clampNum(num(o?.hue, 0), -180, 180), saturation: clampNum(num(o?.saturation, 0), -100, 100), lightness: clampNum(num(o?.lightness, 0), -100, 100) });
  const list = Array.isArray(p?.ranges) ? p.ranges : [];
  if (!list.length && typeof p?.range === 'string' && p.range !== 'master' && HUE_RANGES[p.range] !== undefined) {
    return { master: { hue: 0, saturation: 0, lightness: 0 }, ranges: [{ base: p.range, bounds: [...DEFAULT_RANGE_BOUNDS[p.range]], ...vals(p) }] };
  }
  const ranges = [];
  const seen = new Set();
  for (const r of list) {
    if (!r || typeof r !== 'object' || !DEFAULT_RANGE_BOUNDS[r.base] || seen.has(r.base)) continue;
    seen.add(r.base);
    ranges.push({ base: r.base, bounds: normalizeBounds(r.bounds) ?? [...DEFAULT_RANGE_BOUNDS[r.base]], ...vals(r) });
    if (ranges.length >= MAX_HUE_RANGES) break;
  }
  return { master: vals(p), ranges };
}

/** HSL hue (degrees) of an 8-bit colour, or null for a grey. */
export function hueOf(rgb) {
  const [rr, gg, bb] = rgb;
  const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb), delta = max - min;
  if (delta <= 0) return null;
  if (max === rr) return ((gg - bb) / delta + (gg < bb ? 6 : 0)) * 60;
  if (max === gg) return ((bb - rr) / delta + 2) * 60;
  return ((rr - gg) / delta + 4) * 60;
}

/** The range whose default centre is nearest a colour's hue (the range eyedropper's pick), or null for a grey. */
export function rangeForColor(rgb) {
  const h = hueOf(rgb);
  if (h === null) return null;
  return HUE_BASES[Math.round(wrap360(h) / 60) % 6];
}

/**
 * The "+" range eyedropper: bounds widened so that hue h gets the full effect. The nearer end of the full-effect
 * part (b or c) moves to h, its fall-off edge (a or d) with it, so the fall-off keeps its width.
 */
export function addHueToRange(bounds, h) {
  const nb = normalizeBounds(bounds);
  if (!nb) return bounds;
  const [a, b, c, d] = nb;
  if (boundsWeight(nb, h) >= 1) return nb;
  const left = wrap360(b - h), right = wrap360(h - c);
  const full = wrap360(c - b);
  if (left <= right) {
    if (full + left + wrap360(d - c) + wrap360(b - a) >= 359) return nb;
    return [wrap360(a - left), wrap360(h), c, d];
  }
  if (full + right + wrap360(d - c) + wrap360(b - a) >= 359) return nb;
  return [a, b, wrap360(h), wrap360(d + right)];
}

/**
 * The "-" range eyedropper: bounds narrowed so that hue h is no longer affected. In the fall-off the outer edge moves
 * to h; in the full-effect part the nearer side is cut off at h (h becomes the outer edge, the fall-off keeps its
 * width where it can).
 */
export function subtractHueFromRange(bounds, h) {
  const nb = normalizeBounds(bounds);
  if (!nb) return bounds;
  const [a, b, c, d] = nb;
  const H = wrap360(h - a), B = wrap360(b - a), C = wrap360(c - a), D = wrap360(d - a);
  if (H > D) return nb; // already outside
  if (H < B) return [wrap360(h), b, c, d]; // in the left fall-off: start there
  if (H > C) return [a, b, c, wrap360(h)]; // in the right fall-off: end there
  // inside the full-effect part: the nearer side is cut off so that h becomes the outer edge (no effect there), the
  // fall-off keeping its width as far as the full-effect part allows
  if (H - B <= C - H) {
    const nb = Math.min(H + B, C);
    return [wrap360(h), wrap360(a + nb), c, d];
  }
  const nc = Math.max(H - (D - C), B);
  return [a, b, wrap360(a + nc), wrap360(h)];
}

function hueSaturation(img, p, rect) {
  const r = region(img, rect);
  if (!r.width) return img;
  const d = img.data, w = img.width;
  if (p.colorize) {
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
  const { master, ranges: all } = hueSatRanges(p);
  // ranges whose three values are zero change nothing
  const ranges = all.filter((x) => x.hue !== 0 || x.saturation !== 0 || x.lightness !== 0);
  const mHue = master.hue, mSat = master.saturation, mLight = master.lightness;
  if (mHue === 0 && mSat === 0 && mLight === 0 && !ranges.length) return img;
  const n = ranges.length;
  // per range: default bounds use 0.3's weight function (so 0.3's single-range params stay exact), edited ones the
  // trapezoid of their bounds
  const centre = new Float64Array(n), rHue = new Float64Array(n), rSat = new Float64Array(n), rLight = new Float64Array(n);
  const custom = ranges.map((x) => (isDefaultBounds(x.base, x.bounds) ? null : x.bounds));
  for (let k = 0; k < n; k++) {
    centre[k] = HUE_RANGES[ranges[k].base];
    rHue[k] = ranges[k].hue;
    rSat[k] = ranges[k].saturation / 100;
    rLight[k] = ranges[k].lightness / 100;
  }
  const wgt = new Float64Array(n);
  const mSatF = mSat / 100, mLightF = mLight / 100;
  const satTarget = (s, f) => (f > 0 ? s + (1 - s) * f : s * (1 + f));
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
      // the hue shift and lightness add up over Master and the ranges (each range by its weight); greys belong to
      // no range
      let hueShift = mHue, lightF = mLightF, any = false;
      for (let k = 0; k < n; k++) {
        const wk = delta > 0 ? (custom[k] ? boundsWeight(custom[k], h) : rangeWeight(h, centre[k])) : 0;
        wgt[k] = wk;
        if (wk !== 0) {
          any = true;
          hueShift += rHue[k] * wk;
          lightF += rLight[k] * wk;
        }
      }
      if (!any && mHue === 0 && mSat === 0 && mLight === 0) continue;
      if (hueShift !== 0 && delta > 0) {
        hslToScratch(h + hueShift, s, l);
        rr = R;
        gg = G;
        bb = B;
      }
      if (delta > 0) {
        // chroma scaled about the luma so -100 lands on exactly the desaturate result; positive values push the HSL
        // saturation towards 1 (as Photoshop does), negative scale it down. Master and each range multiply.
        // (applied whenever one of them asks, even when k comes out as 1: 0.3 did, and its pixels must not move)
        let use = mSat !== 0;
        let k = use ? 1 + (satTarget(s, mSatF) / s - 1) * 1 : 1;
        for (let j = 0; j < n; j++) {
          if (wgt[j] !== 0 && rSat[j] !== 0) {
            k *= 1 + (satTarget(s, rSat[j]) / s - 1) * wgt[j];
            use = true;
          }
        }
        if (use) {
          const L = 0.299 * rr + 0.587 * gg + 0.114 * bb;
          rr = L + (rr - L) * k;
          gg = L + (gg - L) * k;
          bb = L + (bb - L) * k;
        }
      }
      if (lightF !== 0) {
        const f = lightF > 1 ? 1 : lightF < -1 ? -1 : lightF;
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

// ---------------------------------------------------------------------------------------------
// Photo Filter, Black & White, Channel Mixer (0.3)

/** Photoshop's Photo Filter list: [id, name, colour]. */
export const PHOTO_FILTERS = Object.freeze([
  ['warming-85', 'Warming Filter (85)', '#ec8a00'],
  ['warming-lba', 'Warming Filter (LBA)', '#fa9600'],
  ['warming-81', 'Warming Filter (81)', '#ebb113'],
  ['cooling-80', 'Cooling Filter (80)', '#006dff'],
  ['cooling-lbb', 'Cooling Filter (LBB)', '#005dff'],
  ['cooling-82', 'Cooling Filter (82)', '#00b5ff'],
  ['red', 'Red', '#ea1a1a'],
  ['orange', 'Orange', '#f38417'],
  ['yellow', 'Yellow', '#f9e31c'],
  ['green', 'Green', '#19c919'],
  ['cyan', 'Cyan', '#1dcbea'],
  ['blue', 'Blue', '#1d35ea'],
  ['violet', 'Violet', '#9b1dea'],
  ['magenta', 'Magenta', '#e318e3'],
  ['sepia', 'Sepia', '#ac7a33'],
  ['deep-red', 'Deep Red', '#ff0000'],
  ['deep-blue', 'Deep Blue', '#0022cd'],
  ['deep-emerald', 'Deep Emerald', '#008c00'],
  ['deep-yellow', 'Deep Yellow', '#ffd500'],
  ['underwater', 'Underwater', '#00c1b1'],
].map((f) => Object.freeze(f)));

function photoFilter(img, p, rect) {
  const [lr, lg, lb] = photoFilterLuts(p);
  return p.preserveLuminosity === false ? applyLuts(img, lr, lg, lb, rect) : applyLutKeepLuma(img, lr, lg, lb, rect);
}

const BW_KEYS = Object.freeze(['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas']);
const BW_DEFAULTS = Object.freeze({ reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80 });

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

/**
 * Black & White's Auto: a grey mix from the image's colours that spreads their greys apart (Photoshop: "maximizes the
 * distribution of grey values"). Pixels are sorted into the six hue sectors; the sectors present keep the order of
 * their default-mix grey but get grey targets spread evenly from 15 % to 85 %, and each sector's weight is the one
 * that puts its average pixel on its target. Sectors with too few pixels keep the default weight. Pure.
 * @returns {{ reds, yellows, greens, cyans, blues, magentas }} weights in percent, -200..300
 */
export function blackWhiteAuto(img, rect = null) {
  const r = region(img, rect);
  const count = new Float64Array(6), minSum = new Float64Array(6), chromaSum = new Float64Array(6), greySum = new Float64Array(6);
  let total = 0;
  const d = img.data, w = img.width;
  const def = BW_KEYS.map((k) => BW_DEFAULTS[k] / 100);
  const step = Math.max(1, Math.floor(Math.sqrt((r.width * r.height) / 250000))); // about 250 000 samples at most
  for (let y = r.y, ye = r.y + r.height; y < ye; y += step) {
    for (let x = r.x, xe = r.x + r.width; x < xe; x += step) {
      const i = (y * w + x) * 4;
      if (d[i + 3] === 0) continue;
      const rr = d[i], gg = d[i + 1], bb = d[i + 2];
      const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
      if (max - min < 8) continue; // nearly grey: the weights do not move it
      const h = hueOf([rr, gg, bb]);
      const k = Math.round(h / 60) % 6;
      count[k]++;
      total++;
      minSum[k] += min;
      chromaSum[k] += max - min;
      greySum[k] += min + (max - min) * def[k];
    }
  }
  const out = { ...BW_DEFAULTS };
  if (!total) return out;
  const present = [];
  for (let k = 0; k < 6; k++) if (count[k] >= Math.max(4, total * 0.01)) present.push(k);
  if (!present.length) return out;
  present.sort((a, b) => greySum[a] / count[a] - greySum[b] / count[b]);
  const lo = 0.15 * 255, hi = 0.85 * 255;
  present.forEach((k, idx) => {
    const target = present.length === 1 ? (lo + hi) / 2 : lo + ((hi - lo) * idx) / (present.length - 1);
    const meanMin = minSum[k] / count[k], meanChroma = chromaSum[k] / count[k];
    const wgt = meanChroma > 0 ? ((target - meanMin) / meanChroma) * 100 : BW_DEFAULTS[BW_KEYS[k]];
    out[BW_KEYS[k]] = Math.round(clampNum(wgt, -200, 300));
  });
  return out;
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

/** The total of one Channel Mixer output (Photoshop shows it, with a warning above 100 %). */
export function mixerTotal(row) {
  const o = row && typeof row === 'object' ? row : {};
  return num(o.r, 0) + num(o.g, 0) + num(o.b, 0);
}

// ---------------------------------------------------------------------------------------------
// Neighbourhood helpers

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
  // Vertical pass row by row (cache friendly) with one running sum per column.
  const last = h - 1;
  const colSum = new Float64Array(w);
  for (let k = -rad; k <= rad; k++) {
    const row = (k < 0 ? 0 : k > last ? last : k) * w;
    for (let x = 0; x < w; x++) colSum[x] += tmp[row + x];
  }
  const inv = 1 / win;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) f[o + x] = colSum[x] * inv;
    const add = y + rad + 1, sub = y - rad;
    const ra = (add > last ? last : add) * w, rs = (sub < 0 ? 0 : sub) * w;
    for (let x = 0; x < w; x++) colSum[x] += tmp[ra + x] - tmp[rs + x];
  }
  return f;
}

/** Separable minimum filter (radius rad, edges replicated) of a w x h field, in place, using tmp. */
function minFilterField(f, w, h, rad, tmp) {
  if (rad <= 0) return f;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = Infinity;
      for (let k = x - rad < 0 ? 0 : x - rad, e = x + rad >= w ? w - 1 : x + rad; k <= e; k++) if (f[row + k] < m) m = f[row + k];
      tmp[row + x] = m;
    }
  }
  for (let y = 0; y < h; y++) {
    const y0 = y - rad < 0 ? 0 : y - rad, y1 = y + rad >= h ? h - 1 : y + rad;
    const o = y * w;
    for (let x = 0; x < w; x++) f[o + x] = tmp[y0 * w + x];
    for (let yy = y0 + 1; yy <= y1; yy++) {
      const row = yy * w;
      for (let x = 0; x < w; x++) if (tmp[row + x] < f[o + x]) f[o + x] = tmp[row + x];
    }
  }
  return f;
}

/** Luma (0..1) of the region reg of img, alpha-weighted, plus the alpha field (null when every pixel is opaque). */
function lumaField(img, reg) {
  const d = img.data, w = img.width, rw = reg.width, rh = reg.height;
  const lum = new Float32Array(rw * rh);
  let alpha = null, opaque = true;
  for (let y = 0; y < rh && opaque; y++) {
    for (let i = ((reg.y + y) * w + reg.x) * 4, e = i + rw * 4; i < e; i += 4) {
      if (d[i + 3] !== 255) {
        opaque = false;
        break;
      }
    }
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
  return { lum, alpha };
}

/**
 * The blurred luma mask of Shadows/Highlights for one radius over reg (three box passes of radius/2, close to a
 * Gaussian with sigma radius/2), premultiplied so transparent neighbours do not darken it. Returns a function
 * (index in reg, the pixel's own luma) -> mask 0..1.
 */
function blurredLumaMask(img, reg, rad) {
  const rw = reg.width, rh = reg.height;
  const pass = rad > 0 ? Math.max(1, Math.round(rad / 2)) : 0;
  const { lum, alpha } = lumaField(img, reg);
  const tmp = new Float32Array(rw * rh);
  for (let k = 0; k < 3; k++) {
    boxBlurField(lum, rw, rh, pass, tmp);
    if (alpha) boxBlurField(alpha, rw, rh, pass, tmp);
  }
  return { lum, alpha };
}

// ---------------------------------------------------------------------------------------------
// Shadows/Highlights

const SH_SUPPORT = (rad) => (rad > 0 ? Math.max(1, Math.round(rad / 2)) * 3 : 0);
const shRadius = (v, fallback) => clampNum(Math.round(num(v, fallback)), 0, 1000);

/** How far Shadows/Highlights reads around a pixel (the margin of I.4): the blur support of the larger radius. */
function shadowsHighlightsMargin(p) {
  const sh = clampNum(num(p?.shadows, 0), 0, 100), hi = clampNum(num(p?.highlights, 0), 0, 100);
  if (sh === 0 && hi === 0) return 0;
  const base = num(p?.radius, 30);
  return Math.max(SH_SUPPORT(shRadius(p?.shadowRadius ?? base, 30)), SH_SUPPORT(shRadius(p?.highlightRadius ?? base, 30)));
}

/**
 * Shadows/Highlights: a blurred luma mask decides how much each pixel is "shadow" or "highlight"; shadows lifts towards
 * white and highlights pulls towards black by up to half the distance at 100. Tone (tonal width, 50 = 0.3's curve)
 * sets which tones count: the shadow weight is (1 - m / t)^2 and the highlight weight (1 - (1 - m) / t)^2 with
 * t = tone / 50. Each side may have its own radius. Color corrects the saturation of what changed, Midtone changes the
 * contrast of the midtones, Black / White Clip stretch the result so that many percent of the pixels clip. Pixels
 * outside rect (but inside the image) feed the mask; only pixels inside rect change. Without the new keys (or with
 * their neutral values) the result is 0.3's exactly.
 */
function shadowsHighlights(img, p, rect) {
  const sh = clampNum(num(p.shadows, 0), 0, 100) / 100, hi = clampNum(num(p.highlights, 0), 0, 100) / 100;
  if (sh === 0 && hi === 0) return img;
  const base = num(p.radius, 30);
  const radS = shRadius(p.shadowRadius ?? base, 30), radH = shRadius(p.highlightRadius ?? base, 30);
  const toneS = clampNum(num(p.shadowTone, 50), 0, 100) / 50, toneH = clampNum(num(p.highlightTone, 50), 0, 100) / 50;
  const color = clampNum(num(p.color, 0), -100, 100) / 100, midtone = clampNum(num(p.midtone, 0), -100, 100) / 100;
  const blackClip = clampNum(num(p.blackClip, 0), 0, 50), whiteClip = clampNum(num(p.whiteClip, 0), 0, 50);
  const support = Math.max(SH_SUPPORT(radS), SH_SUPPORT(radH));
  const r = region(img, rect);
  if (!r.width) return img;
  const d = img.data, w = img.width;
  const reg = clampRect({ x: r.x - support, y: r.y - support, width: r.width + 2 * support, height: r.height + 2 * support }, img.width, img.height);
  const rw = reg.width;
  const maskS = blurredLumaMask(img, reg, radS);
  const maskH = radH === radS ? maskS : blurredLumaMask(img, reg, radH);
  const maskAt = (m, o, rr, gg, bb) => {
    let v;
    if (m.alpha) {
      const a = m.alpha[o];
      v = a > 1e-6 ? m.lum[o] / a : (0.299 * rr + 0.587 * gg + 0.114 * bb) / 255;
    } else v = m.lum[o];
    return v < 0 ? 0 : v > 1 ? 1 : v;
  };
  const sAmt = sh * 0.5, hAmt = hi * 0.5;
  const extras = color !== 0 || midtone !== 0;
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let i = (y * w + r.x) * 4, o = (y - reg.y) * rw + (r.x - reg.x);
    for (let x = 0; x < r.width; x++, i += 4, o++) {
      const rr = d[i], gg = d[i + 1], bb = d[i + 2];
      const ms = maskAt(maskS, o, rr, gg, bb);
      const mh = maskH === maskS ? ms : maskAt(maskH, o, rr, gg, bb);
      let sw, hw;
      // tone 50 keeps 0.3's exact expressions
      if (toneS === 1) sw = (1 - ms) * (1 - ms) * sAmt;
      else {
        const t = toneS > 0.01 ? 1 - ms / toneS : 0;
        sw = t > 0 ? t * t * sAmt : 0;
      }
      if (toneH === 1) hw = mh * mh * hAmt;
      else {
        const t = toneH > 0.01 ? 1 - (1 - mh) / toneH : 0;
        hw = t > 0 ? t * t * hAmt : 0;
      }
      if (sw === 0 && hw === 0 && !extras) continue;
      let nr = rr + (255 - rr) * sw - rr * hw, ng = gg + (255 - gg) * sw - gg * hw, nb = bb + (255 - bb) * sw - bb * hw;
      if (extras) {
        const L = 0.299 * nr + 0.587 * ng + 0.114 * nb;
        // Color: more (or less) saturation where the tones moved
        let k = color !== 0 ? 1 + color * (sw + hw) * 2 : 1;
        if (k < 0) k = 0;
        // Midtone contrast: a slope about mid grey, strongest for the midtones of the mask
        const mid = midtone !== 0 ? (L - 127.5) * midtone * 4 * ms * (1 - ms) : 0;
        nr = L + (nr - L) * k + mid;
        ng = L + (ng - L) * k + mid;
        nb = L + (nb - L) * k + mid;
      }
      d[i] = round8(nr);
      d[i + 1] = round8(ng);
      d[i + 2] = round8(nb);
    }
  }
  if (blackClip > 0 || whiteClip > 0) clipStretch(img, r, blackClip, whiteClip);
  return img;
}

/** Stretches rect of img so that blackClip % of its pixels (by luma) become black and whiteClip % white. */
function clipStretch(img, r, blackClip, whiteClip) {
  const d = img.data, w = img.width;
  const hist = new Float64Array(256);
  let n = 0;
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    for (let i = (y * w + r.x) * 4, e = i + r.width * 4; i < e; i += 4) {
      if (d[i + 3] === 0) continue;
      hist[lumaInt(d[i], d[i + 1], d[i + 2])]++;
      n++;
    }
  }
  if (!n) return;
  let lo = 0, hi = 255, acc = 0;
  const loCount = (n * blackClip) / 100, hiCount = (n * whiteClip) / 100;
  if (loCount > 0) for (lo = 0, acc = 0; lo < 255 && (acc += hist[lo]) <= loCount; lo++);
  if (hiCount > 0) for (hi = 255, acc = 0; hi > 0 && (acc += hist[hi]) <= hiCount; hi--);
  if (hi - lo < 2 || (lo === 0 && hi === 255)) return;
  const lut = makeLut((v) => ((v - lo) * 255) / (hi - lo));
  applyLuts(img, lut, lut, lut, r);
}

// ---------------------------------------------------------------------------------------------
// 0.4 kinds: Color and Vibrance, Clarity and Dehaze, Grain

const LUMA_R = 0.2126, LUMA_G = 0.7152, LUMA_B = 0.0722;
const TO_LINEAR = (() => {
  const t = new Float32Array(256);
  for (let v = 0; v < 256; v++) t[v] = srgbToLinear(v / 255);
  return t;
})();

/**
 * Color and Vibrance (Camera Raw's Color panel as an adjustment layer): Temperature and Tint as white-balance gains in
 * linear light (normalised so a mid grey keeps its luminance; Camera Raw's maths, develop.js), then Vibrance and
 * Saturation as the Vibrance adjustment does them.
 */
function colorVibrance(img, p, rect) {
  const temp = clampNum(num(p.temperature, 0), -100, 100) / 100, tint = clampNum(num(p.tint, 0), -100, 100) / 100;
  const vib = clampNum(num(p.vibrance, 0), -100, 100) / 100, sat = clampNum(num(p.saturation, 0), -100, 100) / 100;
  if (!temp && !tint && !vib && !sat) return img;
  const r = region(img, rect);
  if (!r.width) return img;
  let luts = null;
  if (temp || tint) {
    let gr = 1 + 0.3 * temp, gb = 1 - 0.3 * temp, gg = 1 - 0.2 * tint;
    if (tint) {
      gr *= 1 + 0.1 * tint;
      gb *= 1 + 0.1 * tint;
    }
    const lum = LUMA_R * gr + LUMA_G * gg + LUMA_B * gb;
    luts = [gr / lum, gg / lum, gb / lum].map((g) => makeLut((v) => linearToSrgb(Math.min(1, TO_LINEAR[v] * g)) * 255));
  }
  const d = img.data, w = img.width;
  const kSat = 1 + sat;
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let i = (y * w + r.x) * 4;
    for (let x = 0; x < r.width; x++, i += 4) {
      let rr = d[i], gg = d[i + 1], bb = d[i + 2];
      if (luts) {
        rr = luts[0][rr];
        gg = luts[1][gg];
        bb = luts[2][bb];
      }
      const max = rr > gg ? (rr > bb ? rr : bb) : gg > bb ? gg : bb;
      const min = rr < gg ? (rr < bb ? rr : bb) : gg < bb ? gg : bb;
      const delta = max - min;
      let k = kSat;
      if (delta > 0 && vib !== 0) {
        // the less saturated, the more vibrance acts; skin tones (near orange) get half the boost
        const s = delta / max;
        let amt = vib * (1 - s) * (1 - s);
        if (vib > 0) {
          const h = max === rr ? ((gg - bb) / delta + (gg < bb ? 6 : 0)) * 60 : max === gg ? ((bb - rr) / delta + 2) * 60 : ((rr - gg) / delta + 4) * 60;
          const dh = Math.abs(h - 30);
          if (dh < 30) amt *= 1 - 0.5 * (1 - dh / 30);
        }
        k *= 1 + amt;
      }
      if (delta > 0 && k !== 1) {
        const L = 0.299 * rr + 0.587 * gg + 0.114 * bb;
        d[i] = round8(L + (rr - L) * k);
        d[i + 1] = round8(L + (gg - L) * k);
        d[i + 2] = round8(L + (bb - L) * k);
      } else {
        d[i] = rr;
        d[i + 1] = gg;
        d[i + 2] = bb;
      }
    }
  }
  return img;
}

/** Clarity's blur: three box passes of this radius (about a Gaussian of sigma 14 px). */
const CLARITY_PASS = 8;
/** Dehaze's dark channel: a minimum over this radius, then smoothed by three box passes of DEHAZE_PASS. */
const DEHAZE_MIN = 4;
const DEHAZE_PASS = 6;

function clarityDehazeMargin(p) {
  const c = clampNum(num(p?.clarity, 0), -100, 100), dz = clampNum(num(p?.dehaze, 0), -100, 100);
  return Math.max(c ? CLARITY_PASS * 3 : 0, dz > 0 ? DEHAZE_MIN + DEHAZE_PASS * 3 : 0);
}

/**
 * Clarity and Dehaze. Clarity adds (or, negative, removes) local contrast in the midtones: the luma's difference from
 * its blur, weighted towards the midtones, added back to every channel. Dehaze removes haze with the dark channel
 * prior (the smoothed local minimum of the channels estimates how much white haze a pixel holds; the haze is
 * subtracted and the rest stretched), and adds a uniform haze when negative. The haze colour is fixed (white), not
 * measured over the image, so a partial repaint matches a full one; both read a fixed neighbourhood (`margin`).
 */
function clarityDehaze(img, p, rect) {
  const clarity = clampNum(num(p.clarity, 0), -100, 100) / 100, dehaze = clampNum(num(p.dehaze, 0), -100, 100) / 100;
  if (!clarity && !dehaze) return img;
  const r = region(img, rect);
  if (!r.width) return img;
  const support = clarityDehazeMargin(p);
  const reg = clampRect({ x: r.x - support, y: r.y - support, width: r.width + 2 * support, height: r.height + 2 * support }, img.width, img.height);
  const rw = reg.width, rh = reg.height;
  const d = img.data, w = img.width;
  // dehaze first (it reads the original), clarity on its result (inside rect only; its blur sees the original
  // neighbourhood, which keeps both passes independent of the rect)
  let trans = null;
  if (dehaze > 0) {
    const dark = new Float32Array(rw * rh), tmp = new Float32Array(rw * rh);
    for (let y = 0; y < rh; y++) {
      let i = ((reg.y + y) * w + reg.x) * 4, o = y * rw;
      for (let x = 0; x < rw; x++, i += 4, o++) dark[o] = Math.min(d[i], d[i + 1], d[i + 2]) / 255;
    }
    minFilterField(dark, rw, rh, DEHAZE_MIN, tmp);
    for (let k = 0; k < 3; k++) boxBlurField(dark, rw, rh, DEHAZE_PASS, tmp);
    trans = dark; // becomes the transmission below
    const omega = 0.75 * dehaze;
    for (let o = 0; o < trans.length; o++) trans[o] = Math.max(0.2, 1 - omega * trans[o]);
  }
  let blur = null;
  if (clarity) {
    blur = lumaField(img, reg).lum; // alpha-weighted; transparent areas stay transparent anyway
    const tmp = new Float32Array(rw * rh);
    for (let k = 0; k < 3; k++) boxBlurField(blur, rw, rh, CLARITY_PASS, tmp);
  }
  const haze = dehaze < 0 ? -dehaze * 0.35 : 0;
  const satK = 1 + 0.2 * dehaze;
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let i = (y * w + r.x) * 4, o = (y - reg.y) * rw + (r.x - reg.x);
    for (let x = 0; x < r.width; x++, i += 4, o++) {
      let rr = d[i], gg = d[i + 1], bb = d[i + 2];
      if (blur) {
        const a = d[i + 3] / 255;
        const L = (0.299 * rr + 0.587 * gg + 0.114 * bb) / 255;
        const Lb = a > 0 ? blur[o] : L;
        const mw = 1 - (2 * L - 1) * (2 * L - 1); // midtones
        const delta = clarity * 0.8 * (L * a - Lb) * (0.25 + 0.75 * mw) * 255;
        rr += delta;
        gg += delta;
        bb += delta;
      }
      if (trans) {
        const t = trans[o];
        rr = (rr - 255 * (1 - t)) / t;
        gg = (gg - 255 * (1 - t)) / t;
        bb = (bb - 255 * (1 - t)) / t;
      } else if (haze) {
        rr = rr * (1 - haze) + 255 * haze;
        gg = gg * (1 - haze) + 255 * haze;
        bb = bb * (1 - haze) + 255 * haze;
      }
      if (dehaze) {
        const L = 0.299 * rr + 0.587 * gg + 0.114 * bb;
        rr = L + (rr - L) * satK;
        gg = L + (gg - L) * satK;
        bb = L + (bb - L) * satK;
      }
      d[i] = round8(rr);
      d[i + 1] = round8(gg);
      d[i + 2] = round8(bb);
    }
  }
  return img;
}

/**
 * Grain's noise at a document position, -1..1: value noise on a lattice of `cell` px (smooth, film-like clumps) mixed
 * with per-pixel noise by roughness. Triangular distribution (sum of two hashes). Pure.
 */
export function grainNoise(X, Y, cell, roughness) {
  const tri = (x, y, salt) => hash01(x, y, salt) + hash01(x, y, salt + 101) - 1;
  let smooth;
  if (cell <= 1) smooth = tri(X, Y, 1);
  else {
    const gx = X / cell, gy = Y / cell;
    const ix = Math.floor(gx), iy = Math.floor(gy);
    let fx = gx - ix, fy = gy - iy;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    const a = tri(ix, iy, 1), b = tri(ix + 1, iy, 1), c = tri(ix, iy + 1, 1), e = tri(ix + 1, iy + 1, 1);
    smooth = (a + (b - a) * fx) * (1 - fy) + (c + (e - c) * fx) * fy;
    smooth *= 1.6; // interpolation flattens the amplitude
  }
  if (roughness <= 0) return smooth;
  return smooth * (1 - roughness) + tri(X, Y, 3) * roughness;
}

/**
 * Grain (Camera Raw's grain as an adjustment layer): Amount, Size (the grain's clump size) and Roughness (how
 * irregular it is). The noise is a function of the document position (ctx.origin, I.4), so the grain stays put and a
 * partial repaint matches a full one; it is weaker in the deep shadows and highlights, like film.
 */
function grain(img, p, rect, ctx) {
  const amount = clampNum(num(p.amount, 0), 0, 100) / 100;
  if (!amount) return img;
  const size = clampNum(num(p.size, 25), 0, 100), roughness = clampNum(num(p.roughness, 50), 0, 100) / 100;
  const r = region(img, rect);
  if (!r.width) return img;
  const cell = 1 + size / 16;
  const amp = amount * 0.18 * 255;
  const [ox, oy] = originOf(ctx);
  const d = img.data, w = img.width;
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let i = (y * w + r.x) * 4;
    for (let x = r.x, xe = r.x + r.width; x < xe; x++, i += 4) {
      const rr = d[i], gg = d[i + 1], bb = d[i + 2];
      const L = (0.299 * rr + 0.587 * gg + 0.114 * bb) / 255;
      const k = grainNoise(ox + x, oy + y, cell, roughness) * amp * (0.4 + 0.6 * Math.sin(Math.PI * L));
      d[i] = round8(rr + k);
      d[i + 1] = round8(gg + k);
      d[i + 2] = round8(bb + k);
    }
  }
  return img;
}

// ---------------------------------------------------------------------------------------------
// The table (merged into ADJUSTMENTS by adjust.js)

const S = (key, label, min, max, step = 1, extra = {}) => ({ key, label, type: 'slider', min, max, step, ...extra });

/**
 * - hue-saturation: Master (top-level hue, saturation, lightness, colorize*) plus `ranges` (J.9); 0.3's `range`.
 * - black-white, photo-filter, channel-mixer: 0.3's parameters.
 * - gradient-map: a GradientDef (G.1) or 0.3's { stops: [{ offset 0..1, color }] }, plus reverse and dither.
 * - shadows-highlights: 0.3's shadows, highlights, radius plus the Show More Options keys.
 * - color-vibrance, clarity-dehaze, grain: the 0.4 kinds, adjustment layers.
 */
export const ADJUSTMENTS_COLOR = Object.freeze({
  'hue-saturation': pixelKind(
    'Hue/Saturation',
    freezeDeep({ hue: 0, saturation: 0, lightness: 0, colorize: false, colorizeHue: 0, colorizeSat: 25, colorizeLight: 0, range: 'master', ranges: [] }),
    hueSaturation,
    // deep.js's float code knows 0.3's single range only (J.9)
    { deepExact: (p) => !(Array.isArray(p?.ranges) && p.ranges.length > 0) },
  ),
  'black-white': pixelKind('Black & White', freezeDeep({ reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: null }), blackWhite),
  'photo-filter': pixelKind('Photo Filter', freezeDeep({ color: '#ec8a00', density: 0, preserveLuminosity: true }), photoFilter),
  'channel-mixer': pixelKind('Channel Mixer', freezeDeep({ r: { ...MIXER_IDENTITY.r }, g: { ...MIXER_IDENTITY.g }, b: { ...MIXER_IDENTITY.b }, gray: { ...MIXER_IDENTITY.gray }, monochrome: false }), channelMixer),
  // deep.js evaluates the model in float (the dither only hides 8-bit banding)
  'gradient-map': pixelKind('Gradient Map', freezeDeep({ stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }], reverse: false, dither: false }), gradientMap),
  'shadows-highlights': pixelKind(
    'Shadows/Highlights',
    freezeDeep({ shadows: 0, highlights: 0, radius: 30, shadowTone: 50, highlightTone: 50, shadowRadius: null, highlightRadius: null, color: 0, midtone: 0, blackClip: 0, whiteClip: 0 }),
    shadowsHighlights,
    { margin: shadowsHighlightsMargin },
  ),
  'color-vibrance': pixelKind('Color and Vibrance', freezeDeep({ temperature: 0, tint: 0, vibrance: 0, saturation: 0 }), colorVibrance, {
    layer: true,
    fields: [S('temperature', 'Temperature', -100, 100), S('tint', 'Tint', -100, 100), S('vibrance', 'Vibrance', -100, 100), S('saturation', 'Saturation', -100, 100)],
  }),
  'clarity-dehaze': pixelKind('Clarity and Dehaze', freezeDeep({ clarity: 0, dehaze: 0 }), clarityDehaze, {
    layer: true,
    margin: clarityDehazeMargin,
    fields: [S('clarity', 'Clarity', -100, 100), S('dehaze', 'Dehaze', -100, 100)],
  }),
  grain: pixelKind('Grain', freezeDeep({ amount: 0, size: 25, roughness: 50 }), grain, {
    layer: true,
    fields: [S('amount', 'Amount', 0, 100), S('size', 'Size', 0, 100), S('roughness', 'Roughness', 0, 100)],
  }),
});
