// The skeleton's adjust-color.js (commit fa453af: the colour kinds verbatim from 0.3), kept as the reference that
// tests/unit/adjust-color.test.mjs compares 0.3 parameters against ("old params give 0.3's pixels exactly").
// Colour adjustments (ARCHITECTURE.md "0.4 features": the skeleton moved them out of adjust.js so that adjust-tonal
// owns adjust.js and adjust-color owns this file): Hue/Saturation, Black & White, Photo Filter, Channel Mixer,
// Gradient Map and Shadows/Highlights, verbatim from 0.3, plus the 0.4 placeholders Color and Vibrance, Clarity and
// Dehaze and Grain. Same conventions as adjust.js (in place, rect limits writes, alpha kept); merged into ADJUSTMENTS
// by adjust.js.
//
// Like adjust-more.js this module imports nothing from '../../src/shared/pixels/adjust.js' (adjust.js imports this table; a cycle would
// make the import order matter). Helpers the tonal kinds share live in adjust-def.js.

import { clampRect, makeLut, clamp255 } from '../../src/shared/pixels/core.js';
import { hslToRgb, parseColor } from '../../src/shared/pixels/color.js';
import { num, clampNum, round8, lumaInt, freezeDeep, region, applyLuts, applyLutKeepLuma, pixelKind, placeholderAdjustment } from '../../src/shared/pixels/adjust-def.js';
import { normalizeGradient, sampleGradient } from '../../src/shared/pixels/gradient-model.js';

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
 * Gradient map tables: luma -> RGB through the gradient model (G.4), so a v2 def from the gradient widget renders as
 * well as 0.3's `{ stops: [{ offset, color }], reverse }` (classic interpolation: 0.3's linear ramp).
 */
function gradientLuts(p) {
  const def = normalizeGradient(p);
  const lr = new Uint8ClampedArray(256), lg = new Uint8ClampedArray(256), lb = new Uint8ClampedArray(256);
  const reverse = !!p.reverse;
  for (let v = 0; v < 256; v++) {
    const c = sampleGradient(def, reverse ? 1 - v / 255 : v / 255);
    lr[v] = round8(c[0]);
    lg[v] = round8(c[1]);
    lb[v] = round8(c[2]);
  }
  return [lr, lg, lb];
}

// ---------------------------------------------------------------------------------------------
// Per-pixel kinds

function gradientMap(img, p, rect) {
  const [lr, lg, lb] = gradientLuts(p);
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

function photoFilter(img, p, rect) {
  const [lr, lg, lb] = photoFilterLuts(p);
  return p.preserveLuminosity === false ? applyLuts(img, lr, lg, lb, rect) : applyLutKeepLuma(img, lr, lg, lb, rect);
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

/**
 * Shadows/Highlights: a blurred luma mask (three box passes of radius/2, close to a Gaussian
 * with sigma radius/2) decides how much each pixel is "shadow" ((1 - m)^2) or "highlight"
 * (m^2); shadows lifts towards white and highlights pulls towards black by up to half the
 * distance at 100. The mask is built from alpha-weighted luma divided by blurred alpha
 * (premultiplied averaging) so transparent neighbours do not darken it. Pixels outside rect
 * (but inside the image) feed the mask; only pixels inside rect change.
 */
function shadowsHighlights(img, p, rect) {
  const sh = clampNum(num(p.shadows, 0), 0, 100) / 100, hi = clampNum(num(p.highlights, 0), 0, 100) / 100;
  if (sh === 0 && hi === 0) return img;
  const rad = clampNum(Math.round(num(p.radius, 30)), 0, 1000);
  const pass = rad > 0 ? Math.max(1, Math.round(rad / 2)) : 0, support = pass * 3;
  const r = region(img, rect);
  if (!r.width) return img;
  const d = img.data, w = img.width;
  const reg = clampRect({ x: r.x - support, y: r.y - support, width: r.width + 2 * support, height: r.height + 2 * support }, img.width, img.height);
  const rw = reg.width, rh = reg.height;
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
  const tmp = new Float32Array(rw * rh);
  for (let k = 0; k < 3; k++) {
    boxBlurField(lum, rw, rh, pass, tmp);
    if (alpha) boxBlurField(alpha, rw, rh, pass, tmp);
  }
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
// The table (merged into ADJUSTMENTS by adjust.js)

/**
 * - hue-saturation, black-white, photo-filter, channel-mixer, shadows-highlights: see adjust.js's registry notes.
 * - gradient-map: a GradientDef (G.1) or 0.3's { stops: [{ offset 0..1, color }] }, plus reverse; luma picks the colour.
 * - color-vibrance, clarity-dehaze, grain: 0.4 placeholders (identity, menus disabled) until adjust-color lands.
 */
export const REFERENCE_COLOR = Object.freeze({
  'hue-saturation': pixelKind(
    'Hue/Saturation',
    freezeDeep({ hue: 0, saturation: 0, lightness: 0, colorize: false, colorizeHue: 0, colorizeSat: 25, colorizeLight: 0, range: 'master' }),
    hueSaturation,
  ),
  'black-white': pixelKind('Black & White', freezeDeep({ reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: null }), blackWhite),
  'photo-filter': pixelKind('Photo Filter', freezeDeep({ color: '#ec8a00', density: 0, preserveLuminosity: true }), photoFilter),
  'channel-mixer': pixelKind('Channel Mixer', freezeDeep({ r: { ...MIXER_IDENTITY.r }, g: { ...MIXER_IDENTITY.g }, b: { ...MIXER_IDENTITY.b }, gray: { ...MIXER_IDENTITY.gray }, monochrome: false }), channelMixer),
  'gradient-map': pixelKind('Gradient Map', freezeDeep({ stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }], reverse: false }), gradientMap),
  'shadows-highlights': pixelKind('Shadows/Highlights', freezeDeep({ shadows: 0, highlights: 0, radius: 30 }), shadowsHighlights),
  'color-vibrance': placeholderAdjustment('Color and Vibrance', {}, { layer: true }),
  'clarity-dehaze': placeholderAdjustment('Clarity and Dehaze', {}, { layer: true }),
  grain: placeholderAdjustment('Grain', {}, { layer: true }),
});
