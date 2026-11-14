// HDR Toning and exposure fusion (builder "adjust-more"). Pure, no DOM.
//
// hdrToning() is the engine of the 'hdr-toning' adjustment. Its four methods follow Photoshop's
// dialog:
//   local-adaptation       tone mapping in the log-luminance domain: an edge-preserving base layer
//                          (a guided filter, so `radius` can be hundreds of pixels at box-filter
//                          cost) is compressed towards the highlights, the detail layer (what the
//                          base leaves) is amplified by `detail`, colours keep their ratios; then
//                          exposure, gamma, shadow / highlight, vibrance / saturation and the
//                          toning curve.
//   equalize-histogram     luminance histogram equalisation (hue kept)
//   exposure-gamma         linear-light gain of 2^exposure and a power of 1/gamma
//   highlight-compression  Reinhard's curve with the brightest luminance as the white point
// The 8-bit path decodes sRGB to linear light; hdrToningFloat() takes linear float RGBA (32-bit
// layers, the result of mergeExposures) and returns 8-bit pixels.
//
// exposureFusion() is Mertens/Kautz/Van Reeth exposure fusion (contrast, saturation and
// well-exposedness weights blended through Laplacian pyramids): it picks the best exposed parts
// of a bracketed series. It produces a display-referred image, not a radiance map.
//
// Conventions: straight alpha, alpha never changes, rect limits writes only, nothing is read
// outside the image, means are alpha-weighted so transparent pixels never bleed in.

import { clampRect } from './core.js';

/** @typedef {import('./core.js').ImageDataLike} ImageDataLike */
/** @typedef {import('./core.js').Rect} Rect */

export const HDR_METHODS = Object.freeze(['local-adaptation', 'equalize-histogram', 'exposure-gamma', 'highlight-compression']);
export const HDR_DEFAULTS = Object.freeze({ method: 'local-adaptation', radius: 100, strength: 50, gamma: 1, exposure: 0, detail: 30, shadow: 0, highlight: 0, vibrance: 0, saturation: 20, curve: null });

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clampNum = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** sRGB 8-bit -> linear 0..1. */
const LIN = new Float32Array(256);
for (let v = 0; v < 256; v++) {
  const c = v / 255;
  LIN[v] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const encode = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/**
 * Linear 0..1 -> display 0..255 (floats) through an optional power, 65536 steps (0.05 of a level
 * in the darkest tones). Values above 1 are display white, so the table needs no headroom: gains
 * are applied before the lookup.
 */
const TABLE_N = 65536;
function transferTable(power = 1) {
  const t = new Float32Array(TABLE_N);
  for (let i = 0; i < TABLE_N; i++) {
    let v = i / (TABLE_N - 1);
    if (power !== 1) v = v ** power;
    t[i] = encode(v) * 255;
  }
  return t;
}
const lookup = (t, v) => t[v <= 0 ? 0 : v >= 1 ? TABLE_N - 1 : (v * (TABLE_N - 1) + 0.5) | 0];

const LOG_EPS = 1 / 256; // keeps log2 finite and stops the darkest levels from counting as stops of "detail"

// ---------------------------------------------------------------------------------------------
// Box filter and guided filter on float planes

/** Box sum of radius r (window 2r+1, zero outside) of src into dst; tmp is scratch. All w*h floats. */
function boxSum(src, dst, tmp, w, h, r) {
  const rx = Math.min(r, w), ry = Math.min(r, h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = 0; x <= rx && x < w; x++) acc += src[row + x];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc;
      const add = x + rx + 1, sub = x - rx;
      if (add < w) acc += src[row + add];
      if (sub >= 0) acc -= src[row + sub];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = 0; y <= ry && y < h; y++) acc += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = acc;
      const add = y + ry + 1, sub = y - ry;
      if (add < h) acc += tmp[add * w + x];
      if (sub >= 0) acc -= tmp[sub * w + x];
    }
  }
}

/**
 * Edge-preserving base of the plane L (the self-guided filter of He, Sun and Tang, in its "fast"
 * form: the linear coefficients are computed on a grid `s` times coarser and interpolated back).
 * weight (0..1 per pixel, or null) excludes transparent pixels from every mean.
 * @returns {Float32Array} base, same size as L
 */
export function guidedBase(L, weight, w, h, radius, eps) {
  const n = w * h;
  const s = Math.max(1, Math.min(16, Math.round(radius / 4), Math.floor(Math.min(w, h) / 4) || 1));
  const cw = Math.ceil(w / s), ch = Math.ceil(h / s), cn = cw * ch;
  // coarse weighted sums
  const W = new Float32Array(cn), I = new Float32Array(cn), II = new Float32Array(cn);
  for (let y = 0; y < h; y++) {
    const cy = (y / s) | 0;
    for (let x = 0; x < w; x++) {
      const p = y * w + x, q = cy * cw + ((x / s) | 0);
      const a = weight ? weight[p] : 1;
      if (a <= 0) continue;
      const v = L[p];
      W[q] += a;
      I[q] += a * v;
      II[q] += a * v * v;
    }
  }
  const r = Math.max(1, Math.round(radius / s));
  const tmp = new Float32Array(cn), sw = new Float32Array(cn), si = new Float32Array(cn), sii = new Float32Array(cn);
  boxSum(W, sw, tmp, cw, ch, r);
  boxSum(I, si, tmp, cw, ch, r);
  boxSum(II, sii, tmp, cw, ch, r);
  // a = var / (var + eps), b = (1 - a) * mean; cells without any opaque pixel get a = 0, b = 0 and no weight
  const A = I, B = II; // reuse
  const cellW = new Float32Array(cn);
  for (let q = 0; q < cn; q++) {
    if (sw[q] <= 1e-6) {
      A[q] = 0;
      B[q] = 0;
      continue;
    }
    const mean = si[q] / sw[q];
    let variance = sii[q] / sw[q] - mean * mean;
    if (variance < 0) variance = 0;
    const a = variance / (variance + eps);
    cellW[q] = W[q] > 0 ? 1 : 0;
    A[q] = a * cellW[q];
    B[q] = (1 - a) * mean * cellW[q];
  }
  const ma = new Float32Array(cn), mb = new Float32Array(cn);
  boxSum(cellW, sw, tmp, cw, ch, r);
  boxSum(A, ma, tmp, cw, ch, r);
  boxSum(B, mb, tmp, cw, ch, r);
  for (let q = 0; q < cn; q++) {
    if (sw[q] > 0) {
      ma[q] /= sw[q];
      mb[q] /= sw[q];
    } else {
      ma[q] = 1; // nothing opaque nearby: the base is the pixel itself
      mb[q] = 0;
    }
  }
  // bilinear upsampling of the coefficients (cell centres at (c + 0.5) * s)
  const base = new Float32Array(n);
  const xi = new Int32Array(w), xf = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let t = (x + 0.5) / s - 0.5;
    if (t < 0) t = 0;
    else if (t > cw - 1) t = cw - 1;
    const i = Math.min(cw - 2 < 0 ? 0 : cw - 2, Math.floor(t));
    xi[x] = i;
    xf[x] = cw > 1 ? t - i : 0;
  }
  for (let y = 0; y < h; y++) {
    let t = (y + 0.5) / s - 0.5;
    if (t < 0) t = 0;
    else if (t > ch - 1) t = ch - 1;
    const j = Math.min(ch - 2 < 0 ? 0 : ch - 2, Math.floor(t));
    const fy = ch > 1 ? t - j : 0;
    const r0 = j * cw, r1 = (ch > 1 ? j + 1 : j) * cw;
    for (let x = 0; x < w; x++) {
      const i = xi[x], fx = xf[x], i1 = cw > 1 ? i + 1 : i;
      const a0 = ma[r0 + i] + (ma[r0 + i1] - ma[r0 + i]) * fx, a1 = ma[r1 + i] + (ma[r1 + i1] - ma[r1 + i]) * fx;
      const b0 = mb[r0 + i] + (mb[r0 + i1] - mb[r0 + i]) * fx, b1 = mb[r1 + i] + (mb[r1 + i1] - mb[r1 + i]) * fx;
      const p = y * w + x;
      base[p] = (a0 + (a1 - a0) * fy) * L[p] + (b0 + (b1 - b0) * fy);
    }
  }
  return base;
}

// ---------------------------------------------------------------------------------------------
// Tone mapping core: linear float RGB planes in, 8-bit out

function normalise(params) {
  const p = { ...HDR_DEFAULTS, ...(params ?? {}) };
  return {
    method: HDR_METHODS.includes(p.method) ? p.method : 'local-adaptation',
    radius: clampNum(num(p.radius, 100), 1, 500),
    strength: clampNum(num(p.strength, 50), 0, 100),
    gamma: clampNum(num(p.gamma, 1), 0.1, 10),
    exposure: clampNum(num(p.exposure, 0), -20, 20),
    detail: clampNum(num(p.detail, 30), -300, 300),
    shadow: clampNum(num(p.shadow, 0), -100, 100),
    highlight: clampNum(num(p.highlight, 0), -100, 100),
    vibrance: clampNum(num(p.vibrance, 0), -100, 100),
    saturation: clampNum(num(p.saturation, 0), -100, 100),
    curve: Array.isArray(p.curve) && p.curve.length >= 2 ? p.curve : null,
  };
}

/**
 * Toning curve as a 256-entry table: a monotone cubic through the points (Fritsch-Carlson slopes),
 * flat outside the first and last point; the same curve as adjust.js curveLut() (restated here so
 * this module does not import adjust.js, see adjust-more.js).
 * @param {Array<[number, number]>} points 0..255, any order
 */
export function toneCurve(points) {
  const pts = [];
  for (const p of Array.isArray(points) ? points : []) {
    const x = Array.isArray(p) ? p[0] : p?.x, y = Array.isArray(p) ? p[1] : p?.y;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    pts.push([clampNum(x, 0, 255), clampNum(y, 0, 255)]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  const xs = [], ys = [];
  for (const p of pts) {
    if (xs.length && xs[xs.length - 1] === p[0]) ys[ys.length - 1] = p[1];
    else {
      xs.push(p[0]);
      ys.push(p[1]);
    }
  }
  const n = xs.length;
  const lut = new Uint8ClampedArray(256);
  if (n < 2) {
    for (let v = 0; v < 256; v++) lut[v] = v;
    return lut;
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
    lut[v] = Math.round(y < 0 ? 0 : y > 255 ? 255 : y);
  }
  return lut;
}

/**
 * Shadow / highlight tone curve on display luma 0..1 as a 1025-entry table. Shadow moves the lower
 * tones (L ± L(1-L)³), highlight the upper ones (L ± (1-L)L³); both stay monotonic at ±100.
 */
function shadowHighlightTable(shadow, highlight) {
  const t = new Float32Array(1025);
  const s = shadow / 100, hl = highlight / 100;
  for (let i = 0; i <= 1024; i++) {
    const l = i / 1024;
    t[i] = l + s * l * (1 - l) ** 3 + hl * (1 - l) * l ** 3;
  }
  return t;
}

/**
 * @param {Float32Array} lin linear RGB, 3 floats per pixel (w*h*3)
 * @param {Float32Array | null} alpha coverage 0..1 per pixel (null: opaque)
 * @param {Uint8ClampedArray} out RGBA 8-bit target (alpha is left alone)
 */
function toneMap(lin, alpha, w, h, params, rect, out) {
  const p = normalise(params);
  const r = clampRect(rect, w, h);
  if (r.width <= 0 || r.height <= 0) return;
  const n = w * h;
  const x0 = r.x, x1 = r.x + r.width, y0 = r.y, y1 = r.y + r.height;

  if (p.method === 'exposure-gamma') {
    const t = transferTable(1 / p.gamma), g = 2 ** p.exposure;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const q = y * w + x, i = q * 3, o = q * 4;
      out[o] = lookup(t, lin[i] * g);
      out[o + 1] = lookup(t, lin[i + 1] * g);
      out[o + 2] = lookup(t, lin[i + 2] * g);
    }
    return;
  }

  if (p.method === 'highlight-compression') {
    // Reinhard with a white point: Y' = Y (1 + Y / w²) / (1 + Y) maps the brightest luminance w to 1
    const g = 2 ** p.exposure;
    let white = 0;
    for (let q = 0, i = 0; q < n; q++, i += 3) {
      if (alpha && alpha[q] <= 0) continue;
      const Y = 0.2126 * lin[i] + 0.7152 * lin[i + 1] + 0.0722 * lin[i + 2];
      if (Y > white) white = Y;
    }
    white *= g;
    if (!(white > 1e-6)) white = 1;
    const t = transferTable();
    const w2 = white * white;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const q = y * w + x, i = q * 3, o = q * 4;
      const R = lin[i] * g, G = lin[i + 1] * g, B = lin[i + 2] * g;
      const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      const k = (1 + Y / w2) / (1 + Y);
      out[o] = lookup(t, R * k);
      out[o + 1] = lookup(t, G * k);
      out[o + 2] = lookup(t, B * k);
    }
    return;
  }

  if (p.method === 'equalize-histogram') {
    // histogram of display luma over the whole image (4096 bins), mapping through its cumulative sum
    const BINS = 4096;
    const t = transferTable();
    const hist = new Float64Array(BINS);
    let total = 0;
    const lum = new Float32Array(n);
    for (let q = 0, i = 0; q < n; q++, i += 3) {
      const l = (0.299 * lookup(t, lin[i]) + 0.587 * lookup(t, lin[i + 1]) + 0.114 * lookup(t, lin[i + 2])) / 255;
      lum[q] = l;
      const a = alpha ? alpha[q] : 1;
      if (a <= 0) continue;
      hist[Math.min(BINS - 1, (l * (BINS - 1) + 0.5) | 0)] += a;
      total += a;
    }
    if (total <= 0) return;
    const map = new Float32Array(BINS);
    let cum = 0, first = -1;
    for (let b = 0; b < BINS; b++) {
      if (hist[b] > 0 && first < 0) first = hist[b];
      cum += hist[b];
      // the darkest occupied bin maps to 0 and the brightest to 1 (as Equalize does)
      map[b] = total - first > 0 ? Math.max(0, (cum - first) / (total - first)) : b / (BINS - 1);
    }
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const q = y * w + x, i = q * 3, o = q * 4;
      const l = lum[q];
      const target = map[Math.min(BINS - 1, (l * (BINS - 1) + 0.5) | 0)];
      const R = lookup(t, lin[i]), G = lookup(t, lin[i + 1]), B = lookup(t, lin[i + 2]);
      if (l > 1e-4) {
        const k = target / l;
        out[o] = R * k;
        out[o + 1] = G * k;
        out[o + 2] = B * k;
      } else out[o] = out[o + 1] = out[o + 2] = target * 255;
    }
    return;
  }

  // ---- local adaptation ----
  const L = new Float32Array(n);
  for (let q = 0, i = 0; q < n; q++, i += 3) L[q] = Math.log2(0.2126 * lin[i] + 0.7152 * lin[i + 1] + 0.0722 * lin[i + 2] + LOG_EPS);
  // strength = how many stops apart two tones must be before they count as different regions
  const thr = 0.1 + 2.9 * (p.strength / 100);
  const base = guidedBase(L, alpha, w, h, p.radius, thr * thr);
  let pivot = -Infinity;
  for (let q = 0; q < n; q++) if ((!alpha || alpha[q] > 0) && base[q] > pivot) pivot = base[q];
  if (!Number.isFinite(pivot)) pivot = 0;
  const compress = 1 - 0.35 * (p.strength / 100); // the base keeps this share of its range below the brightest region
  const detailGain = Math.max(0, 1 + p.detail / 100);
  const transfer = transferTable(1 / p.gamma), gain = 2 ** p.exposure;
  const tone = p.shadow !== 0 || p.highlight !== 0 ? shadowHighlightTable(p.shadow, p.highlight) : null;
  const sat = 1 + p.saturation / 100, vib = p.vibrance / 100;
  const colour = sat !== 1 || vib !== 0;
  const curve = p.curve ? toneCurve(p.curve) : null;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const q = y * w + x, i = q * 3, o = q * 4;
    const b = base[q];
    const Lout = pivot + (b - pivot) * compress + (L[q] - b) * detailGain;
    const k = Math.exp((Lout - L[q]) * Math.LN2); // 2^x; exp is several times faster than ** in a hot loop
    // the LOG_EPS offset rides along so black scales like its neighbours instead of staying at zero
    let R = lookup(transfer, ((lin[i] + LOG_EPS) * k - LOG_EPS) * gain);
    let G = lookup(transfer, ((lin[i + 1] + LOG_EPS) * k - LOG_EPS) * gain);
    let B = lookup(transfer, ((lin[i + 2] + LOG_EPS) * k - LOG_EPS) * gain);
    if (tone) {
      const l = (0.299 * R + 0.587 * G + 0.114 * B) / 255;
      const f = l * 1024, j = f | 0;
      const l2 = j >= 1024 ? tone[1024] : tone[j] + (tone[j + 1] - tone[j]) * (f - j);
      if (l > 1e-4) {
        const s = l2 / l;
        R *= s;
        G *= s;
        B *= s;
      } else R = G = B = l2 * 255;
    }
    if (colour) {
      const l = 0.299 * R + 0.587 * G + 0.114 * B;
      let s = sat;
      if (vib !== 0) {
        const mx = R > G ? (R > B ? R : B) : G > B ? G : B, mn = R < G ? (R < B ? R : B) : G < B ? G : B;
        s *= 1 + vib * (1 - (mx - mn) / 255); // vibrance spares what is already saturated
      }
      R = l + (R - l) * s;
      G = l + (G - l) * s;
      B = l + (B - l) * s;
    }
    if (curve) {
      R = curve[R <= 0 ? 0 : R >= 255 ? 255 : (R + 0.5) | 0];
      G = curve[G <= 0 ? 0 : G >= 255 ? 255 : (G + 0.5) | 0];
      B = curve[B <= 0 ? 0 : B >= 255 ? 255 : (B + 0.5) | 0];
    }
    out[o] = R;
    out[o + 1] = G;
    out[o + 2] = B;
  }
}

/**
 * HDR Toning of an 8-bit image, in place (alpha untouched); returns img.
 * @param {ImageDataLike} img
 * @param {object} [params] see HDR_DEFAULTS
 * @param {Rect | null} [rect]
 */
export function hdrToning(img, params = {}, rect = null) {
  const w = img.width, h = img.height, d = img.data, n = w * h;
  if (!n) return img;
  const lin = new Float32Array(n * 3);
  let alpha = null;
  for (let q = 0, i = 0, o = 0; q < n; q++, i += 4, o += 3) {
    lin[o] = LIN[d[i]];
    lin[o + 1] = LIN[d[i + 1]];
    lin[o + 2] = LIN[d[i + 2]];
    if (d[i + 3] !== 255) {
      if (!alpha) alpha = new Float32Array(n).fill(1);
      alpha[q] = d[i + 3] / 255;
    }
  }
  toneMap(lin, alpha, w, h, params, rect, d);
  return img;
}

/**
 * HDR Toning of linear float pixels (a 32-bit layer or a merged radiance estimate): src.data is
 * RGBA Float32Array with linear RGB (1.0 = display white, values above are kept until the tone
 * curve) and alpha 0..1. Returns a new 8-bit image.
 * @param {{ width: number, height: number, data: Float32Array }} src
 * @param {object} [params]
 * @returns {ImageDataLike}
 */
export function hdrToningFloat(src, params = {}) {
  const w = src.width, h = src.height, n = w * h, s = src.data;
  const out = new Uint8ClampedArray(n * 4);
  const lin = new Float32Array(n * 3);
  let alpha = null;
  for (let q = 0, i = 0, o = 0; q < n; q++, i += 4, o += 3) {
    lin[o] = s[i] > 0 ? s[i] : 0;
    lin[o + 1] = s[i + 1] > 0 ? s[i + 1] : 0;
    lin[o + 2] = s[i + 2] > 0 ? s[i + 2] : 0;
    const a = s[i + 3];
    out[i + 3] = a * 255;
    if (a < 1) {
      if (!alpha) alpha = new Float32Array(n).fill(1);
      alpha[q] = a > 0 ? a : 0;
    }
  }
  toneMap(lin, alpha, w, h, params, null, out);
  return { width: w, height: h, data: out };
}

// ---------------------------------------------------------------------------------------------
// Bracketed exposures: relative exposure estimate and Mertens fusion

/** Mean linear luminance of the opaque pixels of an 8-bit image (0..1). */
function meanLuminance(img) {
  const d = img.data;
  let sum = 0, cnt = 0;
  const step = Math.max(1, Math.floor((img.width * img.height) / 200000)) * 4;
  for (let i = 0; i < d.length; i += step) {
    if (!d[i + 3]) continue;
    sum += 0.2126 * LIN[d[i]] + 0.7152 * LIN[d[i + 1]] + 0.0722 * LIN[d[i + 2]];
    cnt++;
  }
  return cnt ? sum / cnt : 0;
}

/**
 * Relative exposure of same-sized images of one scene, without EXIF: the images are ordered by
 * mean luminance and each neighbouring pair gives the median ratio of corresponding linear
 * luminances where both are well exposed (the ratio of the means when no such pixels exist).
 * @param {ImageDataLike[]} images
 * @returns {{ gains: number[], ev: number[], order: number[] }} gain relative to the darkest image
 *   (1 for it), ev = log2(gain), order = indices from darkest to brightest
 */
export function estimateExposures(images) {
  const count = images.length;
  const means = images.map(meanLuminance);
  const order = images.map((_, i) => i).sort((a, b) => means[a] - means[b]);
  const gains = new Array(count).fill(1);
  for (let k = 1; k < count; k++) {
    const A = images[order[k - 1]], B = images[order[k]];
    const a = A.data, b = B.data;
    const n = Math.min(a.length, b.length);
    const step = Math.max(1, Math.floor(n / 4 / 200000)) * 4;
    const ratios = [];
    for (let i = 0; i < n; i += step) {
      if (!a[i + 3] || !b[i + 3]) continue;
      const ya = 0.2126 * LIN[a[i]] + 0.7152 * LIN[a[i + 1]] + 0.0722 * LIN[a[i + 2]];
      const yb = 0.2126 * LIN[b[i]] + 0.7152 * LIN[b[i + 1]] + 0.0722 * LIN[b[i + 2]];
      if (ya > 0.02 && ya < 0.85 && yb > 0.02 && yb < 0.85) ratios.push(yb / ya);
    }
    let ratio;
    if (ratios.length >= 16) {
      ratios.sort((p, q) => p - q);
      ratio = ratios[ratios.length >> 1];
    } else ratio = means[order[k - 1]] > 1e-6 ? means[order[k]] / means[order[k - 1]] : 1;
    gains[order[k]] = gains[order[k - 1]] * Math.max(1e-3, ratio);
  }
  return { gains, ev: gains.map((g) => Math.log2(g)), order };
}

const K5 = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];

/** Blur with the 5-tap binomial kernel and halve (edges replicate). Returns { data, w, h }. */
function pyrDown(src, w, h) {
  const nw = (w + 1) >> 1, nh = (h + 1) >> 1;
  const tmp = new Float32Array(nw * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < nw; x++) {
      const cx = x * 2;
      let acc = 0;
      for (let k = -2; k <= 2; k++) {
        let sx = cx + k;
        if (sx < 0) sx = 0;
        else if (sx >= w) sx = w - 1;
        acc += src[row + sx] * K5[k + 2];
      }
      tmp[y * nw + x] = acc;
    }
  }
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const cy = y * 2;
    for (let x = 0; x < nw; x++) {
      let acc = 0;
      for (let k = -2; k <= 2; k++) {
        let sy = cy + k;
        if (sy < 0) sy = 0;
        else if (sy >= h) sy = h - 1;
        acc += tmp[sy * nw + x] * K5[k + 2];
      }
      out[y * nw + x] = acc;
    }
  }
  return { data: out, w: nw, h: nh };
}

/** Upsamples a (ceil(w/2) x ceil(h/2)) plane to w x h with the matching binomial interpolation. */
function pyrUp(src, sw, sh, w, h) {
  const tmp = new Float32Array(w * sh);
  for (let y = 0; y < sh; y++) {
    const row = y * sw;
    for (let x = 0; x < w; x++) {
      const c = x >> 1;
      if (x & 1) {
        const c1 = c + 1 < sw ? c + 1 : sw - 1;
        tmp[y * w + x] = (src[row + c] + src[row + c1]) * 0.5;
      } else {
        const c0 = c > 0 ? c - 1 : 0, c1 = c + 1 < sw ? c + 1 : sw - 1;
        tmp[y * w + x] = src[row + c0] * 0.125 + src[row + c] * 0.75 + src[row + c1] * 0.125;
      }
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const c = y >> 1;
    if (y & 1) {
      const c1 = c + 1 < sh ? c + 1 : sh - 1;
      for (let x = 0; x < w; x++) out[y * w + x] = (tmp[c * w + x] + tmp[c1 * w + x]) * 0.5;
    } else {
      const c0 = c > 0 ? c - 1 : 0, c1 = c + 1 < sh ? c + 1 : sh - 1;
      for (let x = 0; x < w; x++) out[y * w + x] = tmp[c0 * w + x] * 0.125 + tmp[c * w + x] * 0.75 + tmp[c1 * w + x] * 0.125;
    }
  }
  return out;
}

/**
 * Exposure fusion (Mertens et al.): every image gets a per-pixel weight from its local contrast
 * (Laplacian of the grey image), saturation (standard deviation of R, G, B) and well-exposedness
 * (a Gaussian around mid grey per channel); the normalised weights blend the images' Laplacian
 * pyramids so the transitions stay seamless. All images must have the same size.
 *
 * removeGhosts: each image's linear luminance is divided by its estimated exposure gain; a sample
 * that is well exposed but more than about half a stop away from the per-pixel median of those
 * normalised values (something moved between the frames) loses its weight.
 *
 * The result is display-referred (0..255 sRGB): the best exposed version of every region, not a
 * radiance map. The blend itself runs in floats, so two other outputs keep what 8 bits would round
 * away: `depth: 16` returns { width, height, data: Uint16Array RGBA } (sRGB-encoded, 0..65535, the
 * layout of RasterLayer.deep 'u16') and `float: true` returns { width, height, data: Float32Array
 * RGBA } with linear RGB (the fusion result sRGB-decoded) and alpha 0..1.
 * @param {ImageDataLike[]} images
 * @param {{ contrast?: number, saturation?: number, exposedness?: number, removeGhosts?: boolean, float?: boolean, depth?: 8 | 16 }} [options] weight exponents (default 1)
 */
export function exposureFusion(images, { contrast = 1, saturation = 1, exposedness = 1, removeGhosts = false, float = false, depth = 8 } = {}) {
  if (!images?.length) throw new Error('exposureFusion needs at least one image');
  const w = images[0].width, h = images[0].height, n = w * h;
  for (const im of images) if (im.width !== w || im.height !== h) throw new Error('exposureFusion: all images must have the same size');
  const count = images.length;
  // ---- weights ----
  const weights = images.map(() => new Float32Array(n));
  const grey = new Float32Array(n);
  for (let k = 0; k < count; k++) {
    const d = images[k].data, W = weights[k];
    for (let q = 0, i = 0; q < n; q++, i += 4) grey[q] = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
    for (let y = 0; y < h; y++) {
      const ym = y > 0 ? y - 1 : 0, yp = y < h - 1 ? y + 1 : h - 1;
      for (let x = 0; x < w; x++) {
        const q = y * w + x, i = q * 4;
        const a = d[i + 3] / 255;
        if (a <= 0) continue;
        const xm = x > 0 ? x - 1 : 0, xp = x < w - 1 ? x + 1 : w - 1;
        const lap = Math.abs(grey[y * w + xm] + grey[y * w + xp] + grey[ym * w + x] + grey[yp * w + x] - 4 * grey[q]);
        const R = d[i] / 255, G = d[i + 1] / 255, B = d[i + 2] / 255;
        const mu = (R + G + B) / 3;
        const sd = Math.sqrt(((R - mu) ** 2 + (G - mu) ** 2 + (B - mu) ** 2) / 3);
        const e = Math.exp(-((R - 0.5) ** 2 + (G - 0.5) ** 2 + (B - 0.5) ** 2) / 0.08); // sigma 0.2 per channel
        let v = 1;
        if (contrast) v *= (lap + 1e-3) ** contrast; // the offsets keep flat or grey regions in play
        if (saturation) v *= (sd + 1e-2) ** saturation;
        if (exposedness) v *= (e + 1e-4) ** exposedness;
        W[q] = v * a + 1e-12;
      }
    }
  }
  if (removeGhosts && count >= 3) {
    const { gains } = estimateExposures(images);
    const vals = new Float64Array(count), sorted = new Float64Array(count);
    const ok = new Uint8Array(count);
    for (let q = 0, i = 0; q < n; q++, i += 4) {
      let m = 0;
      for (let k = 0; k < count; k++) {
        const d = images[k].data;
        const Y = 0.2126 * LIN[d[i]] + 0.7152 * LIN[d[i + 1]] + 0.0722 * LIN[d[i + 2]];
        ok[k] = d[i + 3] > 0 && Y > 0.02 && Y < 0.9 ? 1 : 0;
        vals[k] = Y / gains[k];
        if (ok[k]) sorted[m++] = vals[k];
      }
      if (m < 2) continue;
      const part = sorted.subarray(0, m).sort();
      const med = m & 1 ? part[m >> 1] : (part[(m >> 1) - 1] + part[m >> 1]) / 2;
      for (let k = 0; k < count; k++) {
        if (!ok[k]) continue;
        const dev = Math.log2((vals[k] + 1e-4) / (med + 1e-4));
        weights[k][q] *= Math.exp(-(dev * dev) / 0.25) + 1e-6;
      }
    }
  }
  // normalise
  for (let q = 0; q < n; q++) {
    let sum = 0;
    for (let k = 0; k < count; k++) sum += weights[k][q];
    if (sum <= 0) {
      for (let k = 0; k < count; k++) weights[k][q] = 1 / count;
    } else for (let k = 0; k < count; k++) weights[k][q] /= sum;
  }
  // ---- pyramid blend ----
  let levels = 1;
  for (let s = Math.min(w, h); s >= 8 && levels < 9; s = (s + 1) >> 1) levels++;
  const sizes = [[w, h]];
  for (let l = 1; l < levels; l++) sizes.push([(sizes[l - 1][0] + 1) >> 1, (sizes[l - 1][1] + 1) >> 1]);
  const acc = [0, 1, 2].map(() => sizes.map(([lw, lh]) => new Float32Array(lw * lh)));
  const plane = new Float32Array(n);
  for (let k = 0; k < count; k++) {
    const d = images[k].data;
    // Gaussian pyramid of the weight
    const wp = [weights[k]];
    for (let l = 1; l < levels; l++) wp.push(pyrDown(wp[l - 1], sizes[l - 1][0], sizes[l - 1][1]).data);
    for (let c = 0; c < 3; c++) {
      for (let q = 0, i = c; q < n; q++, i += 4) plane[q] = d[i];
      let cur = plane;
      for (let l = 0; l < levels; l++) {
        const [lw, lh] = sizes[l];
        const target = acc[c][l], wl = wp[l];
        if (l === levels - 1) {
          for (let q = 0; q < cur.length; q++) target[q] += cur[q] * wl[q];
        } else {
          const down = pyrDown(cur, lw, lh).data;
          const up = pyrUp(down, sizes[l + 1][0], sizes[l + 1][1], lw, lh);
          for (let q = 0; q < cur.length; q++) target[q] += (cur[q] - up[q]) * wl[q];
          cur = down;
        }
      }
    }
    weights[k] = null; // free as we go
  }
  // collapse
  const result = [0, 1, 2].map((c) => {
    let cur = acc[c][levels - 1];
    for (let l = levels - 2; l >= 0; l--) {
      const up = pyrUp(cur, sizes[l + 1][0], sizes[l + 1][1], sizes[l][0], sizes[l][1]);
      const lap = acc[c][l];
      for (let q = 0; q < up.length; q++) up[q] += lap[q];
      cur = up;
    }
    return cur;
  });
  // alpha: opaque wherever any input is
  const alpha = new Uint8ClampedArray(n);
  for (const im of images) for (let q = 0, i = 3; q < n; q++, i += 4) if (im.data[i] > alpha[q]) alpha[q] = im.data[i];
  if (float) {
    const data = new Float32Array(n * 4);
    for (let q = 0, i = 0; q < n; q++, i += 4) {
      for (let c = 0; c < 3; c++) {
        const v = clampNum(result[c][q], 0, 255) / 255;
        data[i + c] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      }
      data[i + 3] = alpha[q] / 255;
    }
    return { width: w, height: h, data };
  }
  if (depth === 16) {
    const data = new Uint16Array(n * 4);
    for (let q = 0, i = 0; q < n; q++, i += 4) {
      for (let c = 0; c < 3; c++) data[i + c] = Math.round(clampNum(result[c][q], 0, 255) * 257);
      data[i + 3] = alpha[q] * 257;
    }
    return { width: w, height: h, data };
  }
  const data = new Uint8ClampedArray(n * 4);
  for (let q = 0, i = 0; q < n; q++, i += 4) {
    data[i] = result[0][q];
    data[i + 1] = result[1][q];
    data[i + 2] = result[2][q];
    data[i + 3] = alpha[q];
  }
  return { width: w, height: h, data };
}
