// Adjustments added in 0.3 (builder "adjust-more"): Color Lookup (also an adjustment layer), HDR
// Toning, Match Color and Replace Color. Built with pixelKind() from adjust-def.js and merged into
// ADJUSTMENTS by adjust.js; same conventions (in place, rect limits writes, alpha kept).
//
// This module (and lut.js, hdr.js) deliberately imports nothing from './adjust.js': adjust.js imports
// this table, and a cycle would make the import order matter (loading this file first would read
// ADJUSTMENTS_MORE before it exists). The two pieces of adjust.js these kinds need are small and
// restated here and in hdr.js: the master Hue/Saturation shift (Replace Color) and the monotone
// curve (HDR Toning). tests/unit/adjust-more.test.mjs checks both against adjust.js.
//
//   color-lookup   { preset, lut, dither }: `lut` (a parsed table, see lut.js) wins over `preset` (a name
//                  from LUT_PRESETS or 'none'); both empty is the identity.
//   hdr-toning     see hdr.js.
//   match-color    { luminance, colorIntensity, fade, neutralize, source, target? }: Reinhard statistics
//                  transfer in Lab. `source` / `target` are { mean: [L, a, b], std: [L, a, b] }; without
//                  `target` the statistics of the edited pixels are used, without `source` nothing is
//                  transferred and only luminance, colour intensity and neutralize act.
//   replace-color  { colors, exclude?, fuzziness, localized, positions?, positionsSize?, range?, hue, saturation, lightness }:
//                  Hue/Saturation through a Color Range mask around the sampled colours.

import { pixelKind, num, clampNum, round8, region } from './adjust-def.js';
import { applyLut3d, presetLut, isLut } from './lut.js';
import { hdrToning } from './hdr.js';

/** @typedef {import('./core.js').ImageDataLike} ImageDataLike */
/** @typedef {import('./core.js').Rect} Rect */
/** @typedef {{ mean: [number, number, number], std: [number, number, number] }} LabStats */

// ---------------------------------------------------------------------------------------------
// Color Lookup

/** The table a Color Lookup parameter set resolves to, or null for the identity. */
export function colorLookupTable(params) {
  if (isLut(params?.lut)) return params.lut;
  const name = params?.preset;
  return typeof name === 'string' && name !== 'none' ? presetLut(name) : null;
}

function colorLookup(img, p, rect) {
  const lut = colorLookupTable(p);
  return lut ? applyLut3d(img, lut, { dither: !!p.dither }, rect) : img;
}

// ---------------------------------------------------------------------------------------------
// Lab helpers without per-pixel allocation (same constants as color.js rgbToLab / labToRgb, D65)

const LIN = new Float32Array(256);
for (let v = 0; v < 256; v++) {
  const c = v / 255;
  LIN[v] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
/** linear 0..1 -> sRGB 0..255 (floats), 65536 steps: at most 0.03 of a level off in the darkest tones. */
let ENC = null;
function encodeTable() {
  if (!ENC) {
    ENC = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) {
      const c = i / 65535;
      ENC[i] = (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255;
    }
  }
  return ENC;
}
const Xn = 0.95047, Zn = 1.08883;
const fLab = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
const fInv = (t) => (t > 0.206893 ? t * t * t : (t - 16 / 116) / 7.787);
let LL = 0, LA = 0, LB = 0; // scratch outputs of toLab()

function toLab(r, g, b) {
  const R = LIN[r], G = LIN[g], B = LIN[b];
  const fx = fLab((R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / Xn);
  const fy = fLab(R * 0.2126729 + G * 0.7151522 + B * 0.072175);
  const fz = fLab((R * 0.0193339 + G * 0.119192 + B * 0.9503041) / Zn);
  LL = 116 * fy - 16;
  LA = 500 * (fx - fy);
  LB = 200 * (fy - fz);
}

/**
 * Mean and standard deviation of L, a and b over the pixels of img inside rect, weighted by alpha
 * and by `mask` (Uint8ClampedArray w*h, e.g. a selection) when given. Null when nothing has weight.
 * @param {ImageDataLike} img @param {Rect | null} [rect] @param {Uint8ClampedArray | null} [mask]
 * @returns {LabStats | null}
 */
export function labStatistics(img, rect = null, mask = null) {
  const r = region(img, rect);
  if (!r.width) return null;
  const d = img.data, w = img.width;
  let sw = 0, s0 = 0, s1 = 0, s2 = 0, q0 = 0, q1 = 0, q2 = 0;
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let p = y * w + r.x, i = p * 4;
    for (let x = 0; x < r.width; x++, p++, i += 4) {
      let a = d[i + 3];
      if (mask) a = (a * mask[p]) / 255;
      if (a <= 0) continue;
      toLab(d[i], d[i + 1], d[i + 2]);
      sw += a;
      s0 += a * LL;
      s1 += a * LA;
      s2 += a * LB;
      q0 += a * LL * LL;
      q1 += a * LA * LA;
      q2 += a * LB * LB;
    }
  }
  if (sw <= 0) return null;
  const mean = [s0 / sw, s1 / sw, s2 / sw];
  const sd = (q, m) => Math.sqrt(Math.max(0, q / sw - m * m));
  return { mean, std: [sd(q0, mean[0]), sd(q1, mean[1]), sd(q2, mean[2])] };
}

/** A usable { mean, std } or null. */
function stats(v) {
  if (!v || typeof v !== 'object' || !v.mean || !v.std) return null;
  const out = { mean: [0, 0, 0], std: [0, 0, 0] };
  for (let k = 0; k < 3; k++) {
    out.mean[k] = Number(v.mean[k]);
    out.std[k] = Number(v.std[k]);
    if (!Number.isFinite(out.mean[k]) || !Number.isFinite(out.std[k]) || out.std[k] < 0) return null;
  }
  return out;
}

function matchColor(img, p, rect) {
  const r = region(img, rect);
  if (!r.width) return img;
  const lum = clampNum(num(p.luminance, 100), 0, 200) / 100, ci = clampNum(num(p.colorIntensity, 100), 0, 200) / 100;
  const keep = clampNum(num(p.fade, 0), 0, 100) / 100, neutral = !!p.neutralize;
  const src = stats(p.source);
  if (keep >= 1 || (!src && lum === 1 && ci === 1 && !neutral)) return img;
  const tgt = stats(p.target) ?? labStatistics(img, r);
  if (!tgt) return img;
  const from = src ?? tgt;
  // per channel: (v - targetMean) * (sourceStd / targetStd) + sourceMean; a flat target channel keeps its spread
  const k0 = tgt.std[0] > 1e-3 ? Math.min(20, from.std[0] / tgt.std[0]) : 1;
  const k1 = tgt.std[1] > 1e-3 ? Math.min(20, from.std[1] / tgt.std[1]) : 1;
  const k2 = tgt.std[2] > 1e-3 ? Math.min(20, from.std[2] / tgt.std[2]) : 1;
  const m0 = from.mean[0], m1 = neutral ? 0 : from.mean[1], m2 = neutral ? 0 : from.mean[2];
  const t0 = tgt.mean[0], t1 = tgt.mean[1], t2 = tgt.mean[2];
  const enc = encodeTable();
  const d = img.data, w = img.width, amount = 1 - keep;
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let i = (y * w + r.x) * 4;
    for (let x = 0; x < r.width; x++, i += 4) {
      if (d[i + 3] === 0) continue;
      toLab(d[i], d[i + 1], d[i + 2]);
      const L = ((LL - t0) * k0 + m0) * lum, A = ((LA - t1) * k1 + m1) * ci, B = ((LB - t2) * k2 + m2) * ci;
      const fy = (L + 16) / 116;
      const X = fInv(fy + A / 500) * Xn, Y = fInv(fy), Z = fInv(fy - B / 200) * Zn;
      let R = X * 3.2404542 + Y * -1.5371385 + Z * -0.4985314;
      let G = X * -0.969266 + Y * 1.8760108 + Z * 0.041556;
      let Bl = X * 0.0556434 + Y * -0.2040259 + Z * 1.0572252;
      R = enc[R <= 0 ? 0 : R >= 1 ? 65535 : (R * 65535 + 0.5) | 0];
      G = enc[G <= 0 ? 0 : G >= 1 ? 65535 : (G * 65535 + 0.5) | 0];
      Bl = enc[Bl <= 0 ? 0 : Bl >= 1 ? 65535 : (Bl * 65535 + 0.5) | 0];
      d[i] += (R - d[i]) * amount;
      d[i + 1] += (G - d[i + 1]) * amount;
      d[i + 2] += (Bl - d[i + 2]) * amount;
    }
  }
  return img;
}

// ---------------------------------------------------------------------------------------------
// Replace Color

const colourList = (v) => (Array.isArray(v) ? v.filter((c) => Array.isArray(c) && c.length >= 3 && c.slice(0, 3).every((n) => Number.isFinite(+n))).map((c) => [+c[0], +c[1], +c[2]]) : []);

/**
 * Colour Range coverage without the alpha weighting of selection-ops.js colorRange(): 255 while the
 * largest channel difference to the nearest of `colors` is at most fuzziness / 2, fading linearly to
 * 0 at `fuzziness`. A half-transparent pixel of a sampled colour is fully covered (its colour is
 * replaced, its alpha stays); fully transparent pixels have no colour and are never covered.
 */
function rangeCoverage(img, colors, fuzziness, r, out) {
  const d = img.data, w = img.width, n = colors.length;
  const half = fuzziness / 2;
  const lut = new Uint8ClampedArray(256);
  for (let dist = 0; dist < 256; dist++) lut[dist] = fuzziness <= 0 ? (dist === 0 ? 255 : 0) : dist <= half ? 255 : dist >= fuzziness ? 0 : (255 * (fuzziness - dist)) / half;
  const cs = new Int32Array(n * 3);
  for (let k = 0; k < n; k++) {
    cs[k * 3] = Math.round(colors[k][0]);
    cs[k * 3 + 1] = Math.round(colors[k][1]);
    cs[k * 3 + 2] = Math.round(colors[k][2]);
  }
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let q = y * w + r.x, i = q * 4;
    for (let x = 0; x < r.width; x++, q++, i += 4) {
      if (d[i + 3] === 0) continue;
      const pr = d[i], pg = d[i + 1], pb = d[i + 2];
      let best = 255;
      for (let k = 0; k < cs.length; k += 3) {
        let m = pr - cs[k];
        if (m < 0) m = -m;
        let t = pg - cs[k + 1];
        if (t < 0) t = -t;
        if (t > m) m = t;
        t = pb - cs[k + 2];
        if (t < 0) t = -t;
        if (t > m) m = t;
        if (m < best) best = m;
      }
      out[q] = lut[best];
    }
  }
  return out;
}

/**
 * The selection Replace Color works through (0..255 per pixel, w*h): Color Range coverage around
 * `colors` (255 within fuzziness/2, fading to 0 at fuzziness; not weighted by alpha, see
 * rangeCoverage), minus the coverage of `exclude` (the subtract eyedropper), and with `localized`
 * weighted by the distance to the nearest sampled position (full within half of `range` % of the
 * longer image side, none beyond it).
 * @param {ImageDataLike} img @param {object} p @param {Rect | null} [rect] @returns {Uint8ClampedArray}
 */
export function replaceColorMask(img, p, rect = null) {
  const w = img.width, h = img.height;
  const colors = colourList(p?.colors);
  const mask = new Uint8ClampedArray(w * h);
  const r = region(img, rect);
  if (!colors.length || !r.width) return mask;
  const fuzziness = clampNum(num(p.fuzziness, 40), 0, 200);
  rangeCoverage(img, colors, fuzziness, r, mask);
  const exclude = colourList(p.exclude);
  if (exclude.length) {
    const ex = rangeCoverage(img, exclude, fuzziness, r, new Uint8ClampedArray(w * h));
    for (let i = 0; i < mask.length; i++) if (ex[i]) mask[i] = Math.min(mask[i], 255 - ex[i]);
  }
  const pos = p.localized && Array.isArray(p.positions) ? p.positions.filter((q) => Array.isArray(q) && Number.isFinite(+q[0]) && Number.isFinite(+q[1])) : [];
  if (pos.length && r.width) {
    // positions are pixels of the image they were sampled in; positionsSize ([w, h] of that image) lets them follow
    // an image of another size (a smart filter edited on a reduced preview, a replay on another layer)
    const from = Array.isArray(p.positionsSize) && p.positionsSize[0] > 0 && p.positionsSize[1] > 0 ? p.positionsSize : null;
    const sx = from ? w / from[0] : 1, sy = from ? h / from[1] : 1;
    for (let k = 0; k < pos.length; k++) pos[k] = [pos[k][0] * sx, pos[k][1] * sy];
    const radius = Math.max(1, (clampNum(num(p.range, 50), 1, 100) / 100) * Math.max(w, h));
    const inner = radius / 2, r2 = radius * radius, i2 = inner * inner;
    for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
      let i = y * w + r.x;
      for (let x = r.x, xe = r.x + r.width; x < xe; x++, i++) {
        if (!mask[i]) continue;
        let best = Infinity;
        for (let k = 0; k < pos.length; k++) {
          const dx = x - pos[k][0], dy = y - pos[k][1], dd = dx * dx + dy * dy;
          if (dd < best) best = dd;
        }
        if (best <= i2) continue;
        mask[i] = best >= r2 ? 0 : mask[i] * ((radius - Math.sqrt(best)) / (radius - inner));
      }
    }
  }
  return mask;
}

const hue2rgb = (p, q, t) => {
  if (t < 0) t += 1;
  else if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 0.5) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
};

function replaceColor(img, p, rect) {
  const r = region(img, rect);
  if (!r.width) return img;
  const hue = clampNum(num(p.hue, 0), -180, 180), sat = clampNum(num(p.saturation, 0), -100, 100), light = clampNum(num(p.lightness, 0), -100, 100);
  if (hue === 0 && sat === 0 && light === 0) return img;
  const mask = replaceColorMask(img, p, r);
  const d = img.data, w = img.width;
  const satF = sat / 100, lightF = light / 100;
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let q = y * w + r.x, i = q * 4;
    for (let x = 0; x < r.width; x++, q++, i += 4) {
      const m = mask[q];
      if (!m) continue;
      // Hue/Saturation, master range: the same maths as adjust.js hueSaturation()
      let rr = d[i], gg = d[i + 1], bb = d[i + 2];
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
      if (hue !== 0 && delta > 0) {
        const qq = l < 0.5 ? l * (1 + s) : l + s - l * s, pp = 2 * l - qq;
        let H = (h + hue) / 360;
        H -= Math.floor(H);
        rr = hue2rgb(pp, qq, H + 1 / 3) * 255;
        gg = hue2rgb(pp, qq, H) * 255;
        bb = hue2rgb(pp, qq, H - 1 / 3) * 255;
      }
      if (sat !== 0 && delta > 0) {
        // chroma scaled about the luma: -100 is exactly Desaturate, positive values push the HSL saturation towards 1
        const target = satF > 0 ? s + (1 - s) * satF : s * (1 + satF);
        const k = target / s;
        const L = 0.299 * rr + 0.587 * gg + 0.114 * bb;
        rr = L + (rr - L) * k;
        gg = L + (gg - L) * k;
        bb = L + (bb - L) * k;
      }
      if (light !== 0) {
        if (lightF > 0) {
          rr += (255 - rr) * lightF;
          gg += (255 - gg) * lightF;
          bb += (255 - bb) * lightF;
        } else {
          rr *= 1 + lightF;
          gg *= 1 + lightF;
          bb *= 1 + lightF;
        }
      }
      rr = round8(rr);
      gg = round8(gg);
      bb = round8(bb);
      if (m === 255) {
        d[i] = rr;
        d[i + 1] = gg;
        d[i + 2] = bb;
      } else {
        const t = m / 255;
        d[i] += (rr - d[i]) * t;
        d[i + 1] += (gg - d[i + 1]) * t;
        d[i + 2] += (bb - d[i + 2]) * t;
      }
    }
  }
  return img;
}

// ---------------------------------------------------------------------------------------------

export const ADJUSTMENTS_MORE = Object.freeze({
  // lut: a parsed table { type: '3d', size, data: number[] (r fastest, 0..1 RGB triples) } or { type: '1d', size, data }; preset names map to tables built in code
  'color-lookup': pixelKind('Color Lookup', { preset: 'none', lut: null, dither: false }, colorLookup, { layer: true }),
  'hdr-toning': pixelKind('HDR Toning', { method: 'local-adaptation', radius: 100, strength: 50, gamma: 1, exposure: 0, detail: 30, shadow: 0, highlight: 0, vibrance: 0, saturation: 20, curve: null }, hdrToning, { smart: false }),
  // source: Lab statistics of the source pixels { mean: [L, a, b], std: [L, a, b] } computed by the dialog from a layer, document or selection
  'match-color': pixelKind('Match Color', { luminance: 100, colorIntensity: 100, fade: 0, neutralize: false, source: null }, matchColor, { smart: false }),
  'replace-color': pixelKind('Replace Color', { colors: [], fuzziness: 40, localized: false, hue: 0, saturation: 0, lightness: 0 }, replaceColor),
});
