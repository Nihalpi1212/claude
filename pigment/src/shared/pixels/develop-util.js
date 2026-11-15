// Camera Raw helpers and constants (ARCHITECTURE.md "0.5 features", S8.1), moved verbatim from 0.4's develop.js so
// the develop stages of every package can share them. Import rule: this file imports nothing from develop*.js, so
// develop-more.js, develop-profile.js and the files they import can use it without loading develop.js (which
// imports them). develop.js re-exports what it exported in 0.4. Skeleton file; pure, no DOM.
import { randomSeeded } from './core.js';

export { randomSeeded };

export const HSL_RANGES = Object.freeze(['reds', 'oranges', 'yellows', 'greens', 'aquas', 'blues', 'purples', 'magentas']);
/** Centre hue (degrees) of each HSL range; the soft weight of a range reaches zero at its neighbours' centres. */
export const RANGE_HUES = Object.freeze({ reds: 0, oranges: 30, yellows: 60, greens: 120, aquas: 180, blues: 240, purples: 280, magentas: 320 });

export const neutralHsl = () => Object.fromEntries(HSL_RANGES.map((k) => [k, { hue: 0, saturation: 0, luminance: 0 }]));

export const DEVELOP_DEFAULTS = Object.freeze({
  temperature: 0, // -100 (blue) .. 100 (yellow)
  tint: 0, // -100 (green) .. 100 (magenta)
  exposure: 0, // -5 .. 5 EV
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  texture: 0,
  clarity: 0,
  dehaze: 0,
  vibrance: 0,
  saturation: 0,
  hsl: Object.freeze(neutralHsl()),
  sharpen: Object.freeze({ amount: 0, radius: 1, detail: 25 }),
  noise: Object.freeze({ luminance: 0, color: 0 }),
  vignette: 0, // negative darkens the corners (Lightroom convention), positive lightens them
  grain: 0,
  seed: 1,
});

export const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// sRGB <-> linear LUTs (8-bit in, float out; the way back is computed per pixel on floats)
export const TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
export const toSrgbExact = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
export const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
// the encode runs three times per pixel: an interpolated table (8192 steps, denser than 8 bits
// anywhere on the curve) replaces Math.pow with an error far below one output level
export const SRGB_STEPS = 8192;
export const TO_SRGB = new Float32Array(SRGB_STEPS + 2);
for (let i = 0; i <= SRGB_STEPS + 1; i++) TO_SRGB[i] = toSrgbExact(Math.min(1, i / SRGB_STEPS));
export const toSrgb = (v) => {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  const t = v * SRGB_STEPS;
  const i = t | 0;
  return TO_SRGB[i] + (TO_SRGB[i + 1] - TO_SRGB[i]) * (t - i);
};

export const LUMA_R = 0.2126, LUMA_G = 0.7152, LUMA_B = 0.0722;

/** Highlights pull towards grey rather than black: the headroom shrinks as L nears 1. */
export function shadowsSafe(L) {
  return 1 - L * 0.35;
}

export function luma(R, G, B, n) {
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = LUMA_R * R[i] + LUMA_G * G[i] + LUMA_B * B[i];
  return L;
}

/** Scales RGB so its luminance moves from `from` to `to` (hue preserving, clipped per channel). */
export function scaleToLuma(R, G, B, from, to, n) {
  for (let i = 0; i < n; i++) {
    const a = from[i], b = to[i];
    if (a === b) continue;
    if (a < 1e-4) {
      // black has no hue to keep: add the gain as grey
      const d = b - a;
      R[i] = clamp01(R[i] + d);
      G[i] = clamp01(G[i] + d);
      B[i] = clamp01(B[i] + d);
      continue;
    }
    const k = b / a;
    R[i] = clamp01(R[i] * k);
    G[i] = clamp01(G[i] * k);
    B[i] = clamp01(B[i] * k);
  }
}

export function applyLumaCurve(R, G, B, n, curve) {
  for (let i = 0; i < n; i++) {
    const L = LUMA_R * R[i] + LUMA_G * G[i] + LUMA_B * B[i];
    const t = L * 1024;
    const i0 = t | 0, f = t - i0;
    const L2 = i0 >= 1024 ? curve[1024] : curve[i0] + (curve[i0 + 1] - curve[i0]) * f;
    if (L2 === L) continue;
    if (L < 1e-4) {
      const d = L2 - L;
      R[i] = clamp01(R[i] + d);
      G[i] = clamp01(G[i] + d);
      B[i] = clamp01(B[i] + d);
      continue;
    }
    const k = L2 / L;
    R[i] = clamp01(R[i] * k);
    G[i] = clamp01(G[i] * k);
    B[i] = clamp01(B[i] * k);
  }
}

/**
 * Unsharp mask on a float channel: out = src + amount * (src - blur(src)), with an optional
 * threshold under which (flat) differences are ignored. Negative amounts soften (clarity < 0).
 */
/**
 * Texture: boosts (or, negative, smooths) fine and medium detail. The weight falls off for large
 * differences, so strong edges are left to Clarity and are not haloed.
 */
export function textureContrast(src, out, w, h, sigma, amount) {
  const blur = gaussianBlurFloat(src, w, h, sigma);
  for (let i = 0; i < src.length; i++) {
    const d = src[i] - blur[i];
    const q = d / 0.08;
    out[i] = clamp01(src[i] + amount * d / (1 + q * q));
  }
  return out;
}

export function localContrast(src, out, w, h, sigma, amount, threshold) {
  const blur = gaussianBlurFloat(src, w, h, sigma);
  for (let i = 0; i < src.length; i++) {
    let d = src[i] - blur[i];
    if (threshold > 0) {
      const a = Math.abs(d);
      if (a < threshold) {
        d = 0;
      } else d = Math.sign(d) * (a - threshold);
    }
    out[i] = clamp01(src[i] + amount * d);
  }
  return out;
}

/**
 * Separable Gaussian blur of a single float channel (edge pixels repeat). Returns a new array.
 * Above sigma 4 three running-sum box blurs approximate the kernel in O(n) regardless of radius,
 * which keeps clarity on large images interactive.
 */
export function gaussianBlurFloat(src, w, h, sigma) {
  if (sigma > 4) return boxGaussian(src, w, h, sigma);
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    k[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma));
    sum += k[i + radius];
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let j = -radius; j <= radius; j++) {
        let xx = x + j;
        if (xx < 0) xx = 0;
        else if (xx >= w) xx = w - 1;
        acc += src[row + xx] * k[j + radius];
      }
      tmp[row + x] = acc;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let acc = 0;
      for (let j = -radius; j <= radius; j++) {
        let yy = y + j;
        if (yy < 0) yy = 0;
        else if (yy >= h) yy = h - 1;
        acc += tmp[yy * w + x] * k[j + radius];
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

/** Three box blurs of the "ideal averaging filter" width for sigma (Wells / Kovesi). */
export function boxGaussian(src, w, h, sigma) {
  const ideal = Math.sqrt((12 * sigma * sigma) / 3 + 1);
  let wl = Math.floor(ideal);
  if (wl % 2 === 0) wl--;
  const rad = (wl - 1) / 2;
  let a = new Float32Array(src), b = new Float32Array(src.length);
  for (let pass = 0; pass < 3; pass++) {
    boxBlurH(a, b, w, h, rad);
    boxBlurV(b, a, w, h, rad);
  }
  return a;
}

export function boxBlurH(src, dst, w, h, r) {
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const first = src[row], last = src[row + w - 1];
    let acc = (r + 1) * first;
    for (let j = 0; j < r; j++) acc += src[row + Math.min(j, w - 1)];
    for (let x = 0; x < w; x++) {
      const add = x + r < w ? src[row + x + r] : last;
      const sub = x - r - 1 >= 0 ? src[row + x - r - 1] : first;
      acc += add - sub;
      dst[row + x] = acc * norm;
    }
  }
}

export function boxBlurV(src, dst, w, h, r) {
  const norm = 1 / (2 * r + 1);
  for (let x = 0; x < w; x++) {
    const first = src[x], last = src[(h - 1) * w + x];
    let acc = (r + 1) * first;
    for (let j = 0; j < r; j++) acc += src[Math.min(j, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      const add = y + r < h ? src[(y + r) * w + x] : last;
      const sub = y - r - 1 >= 0 ? src[(y - r - 1) * w + x] : first;
      acc += add - sub;
      dst[y * w + x] = acc * norm;
    }
  }
}

/**
 * Saturation and vibrance: chroma is scaled around the luminance. Vibrance scales muted colours
 * more than vivid ones (and never over-saturates), saturation scales every colour alike.
 */
export function saturate(R, G, B, n, saturation, vibrance) {
  for (let i = 0; i < n; i++) {
    const r = R[i], g = G[i], b = B[i];
    const L = LUMA_R * r + LUMA_G * g + LUMA_B * b;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = mx > 0 ? (mx - mn) / mx : 0;
    let k = 1 + saturation;
    if (vibrance) k *= vibrance > 0 ? 1 + vibrance * (1 - sat) * (1 - sat) : 1 + vibrance * 0.8;
    if (k === 1) continue;
    R[i] = clamp01(L + (r - L) * k);
    G[i] = clamp01(L + (g - L) * k);
    B[i] = clamp01(L + (b - L) * k);
  }
}

/** Soft weight of a hue (degrees) for each range: 1 at the centre, 0 at the neighbours' centres. */
export function hslRangeWeights(hue) {
  const out = {};
  for (let r = 0; r < HSL_RANGES.length; r++) {
    const name = HSL_RANGES[r];
    const c = RANGE_HUES[name];
    const prev = RANGE_HUES[HSL_RANGES[(r + HSL_RANGES.length - 1) % HSL_RANGES.length]];
    const next = RANGE_HUES[HSL_RANGES[(r + 1) % HSL_RANGES.length]];
    let d = ((hue - c) % 360 + 540) % 360 - 180; // signed distance in -180..180
    let span = d < 0 ? ((c - prev) % 360 + 360) % 360 : ((next - c) % 360 + 360) % 360;
    const t = Math.abs(d) / span;
    out[name] = t >= 1 ? 0 : 1 - t * t * (3 - 2 * t);
  }
  return out;
}

let WEIGHT_TABLE = null; // [hue half-degree][range] weights, built once
export function weightTable() {
  if (WEIGHT_TABLE) return WEIGHT_TABLE;
  WEIGHT_TABLE = new Float32Array(720 * HSL_RANGES.length);
  for (let i = 0; i < 720; i++) {
    const w = hslRangeWeights(i / 2);
    for (let r = 0; r < HSL_RANGES.length; r++) WEIGHT_TABLE[i * HSL_RANGES.length + r] = w[HSL_RANGES[r]];
  }
  return WEIGHT_TABLE;
}

export function applyHsl(R, G, B, n, hsl) {
  // precompute which ranges are active and their amounts
  const active = [];
  HSL_RANGES.forEach((k, r) => {
    const dh = clamp(num(hsl[k].hue), -100, 100) * 0.3, ds = clamp(num(hsl[k].saturation), -100, 100) / 100, dl = clamp(num(hsl[k].luminance), -100, 100) / 100;
    if (dh || ds || dl) active.push({ r, dh, ds, dl });
  });
  const table = weightTable();
  const rangeCount = HSL_RANGES.length;
  for (let i = 0; i < n; i++) {
    const r = R[i], g = G[i], b = B[i];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const chroma = mx - mn;
    if (chroma < 0.02) continue; // greys have no hue to adjust
    let hue;
    if (mx === r) hue = ((g - b) / chroma) % 6;
    else if (mx === g) hue = (b - r) / chroma + 2;
    else hue = (r - g) / chroma + 4;
    hue = (hue * 60 + 360) % 360;
    const l = (mx + mn) / 2;
    const s = chroma / (1 - Math.abs(2 * l - 1));
    const row = (Math.round(hue * 2) % 720) * rangeCount;
    let dh = 0, ds = 0, dl = 0;
    for (const a of active) {
      const wgt = table[row + a.r];
      if (!wgt) continue;
      dh += wgt * a.dh; // ±100 = ±30°, like Camera Raw
      ds += wgt * a.ds;
      dl += wgt * a.dl;
    }
    if (!dh && !ds && !dl) continue;
    // fade the effect in for weakly saturated colours so near-greys do not pick up a cast
    const strength = smoothstep(0.02, 0.15, chroma);
    const h2 = (hue + dh * strength + 360) % 360;
    const s2 = clamp01(s * (1 + ds * strength));
    let l2 = l;
    if (dl) l2 = dl > 0 ? l + (1 - l) * dl * 0.5 * strength : l + l * dl * 0.5 * strength;
    const [nr, ng, nb] = hslToRgb01(h2, s2, l2);
    R[i] = nr;
    G[i] = ng;
    B[i] = nb;
  }
}

export function hslToRgb01(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [clamp01(r + m), clamp01(g + m), clamp01(b + m)];
}

/**
 * Noise reduction. Luminance: a bilateral-style filter (5x5 window, range weight on the luminance
 * difference) that keeps edges while smoothing flat areas; colour: a Gaussian blur of the two
 * chroma channels, since colour noise is low frequency and the eye hardly notices chroma blur.
 */
export function denoise(R, G, B, w, h, lumAmount, colorAmount) {
  const n = w * h;
  const Y = new Float32Array(n), Cb = new Float32Array(n), Cr = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = R[i], g = G[i], b = B[i];
    Y[i] = LUMA_R * r + LUMA_G * g + LUMA_B * b;
    Cb[i] = b - Y[i];
    Cr[i] = r - Y[i];
  }
  let Y2 = Y;
  if (lumAmount) {
    Y2 = new Float32Array(n);
    const sigmaR = 0.02 + 0.12 * lumAmount;
    const rad = lumAmount > 0.5 ? 3 : 2;
    const sigmaS = rad / 1.5;
    const spatial = [];
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) spatial.push(Math.exp(-(dx * dx + dy * dy) / (2 * sigmaS * sigmaS)));
    // range weight exp(-d² / 2σ²) tabulated over |d| in 0..1 (1024 steps)
    const RANGE_STEPS = 1024;
    const range = new Float32Array(RANGE_STEPS + 1);
    for (let i = 0; i <= RANGE_STEPS; i++) {
      const d = i / RANGE_STEPS;
      range[i] = Math.exp(-(d * d) / (2 * sigmaR * sigmaR));
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const c = Y[i];
        let acc = 0, wsum = 0, k = 0;
        for (let dy = -rad; dy <= rad; dy++) {
          let yy = y + dy;
          if (yy < 0) yy = 0;
          else if (yy >= h) yy = h - 1;
          for (let dx = -rad; dx <= rad; dx++, k++) {
            let xx = x + dx;
            if (xx < 0) xx = 0;
            else if (xx >= w) xx = w - 1;
            const v = Y[yy * w + xx];
            const d = v > c ? v - c : c - v;
            const wgt = spatial[k] * range[(d * RANGE_STEPS) | 0];
            acc += v * wgt;
            wsum += wgt;
          }
        }
        Y2[i] = c + (acc / wsum - c) * Math.min(1, lumAmount * 1.5);
      }
    }
  }
  let Cb2 = Cb, Cr2 = Cr;
  if (colorAmount) {
    const sigma = 0.5 + colorAmount * 4;
    const bb = gaussianBlurFloat(Cb, w, h, sigma), br = gaussianBlurFloat(Cr, w, h, sigma);
    Cb2 = new Float32Array(n);
    Cr2 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      Cb2[i] = Cb[i] + (bb[i] - Cb[i]) * colorAmount;
      Cr2[i] = Cr[i] + (br[i] - Cr[i]) * colorAmount;
    }
  }
  for (let i = 0; i < n; i++) {
    const y = Y2[i];
    const r = y + Cr2[i], b = y + Cb2[i];
    const g = (y - LUMA_R * r - LUMA_B * b) / LUMA_G;
    R[i] = clamp01(r);
    G[i] = clamp01(g);
    B[i] = clamp01(b);
  }
}
