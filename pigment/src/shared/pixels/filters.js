// Filters (the Filter menu). FILTERS maps every kind to { name, category, defaults, apply }:
// apply(img, params, rect?) merges params over the kind's defaults, edits the ImageDataLike in
// place and returns it. FILTER_CATEGORIES lists the kinds per menu group, applyFilter() looks a
// kind up by id.
//
// Conventions shared by every kind:
// - rect (default: the whole image) only limits which pixels are written. Neighbourhoods, cell
//   grids, noise and geometry (centres, radii, wave phases) always refer to the whole image, so
//   the pixels inside rect come out as a whole-image run would produce them (within rounding)
//   and a partial repaint matches a full one. Callers that want Photoshop's "selection frames
//   the effect" geometry crop the selection bounds first. Nothing outside the image is ever read
//   or written; image edges are extended by replication (blurs, convolutions, morphology) unless
//   a distortion's edge mode says otherwise.
// - Straight alpha in and out. Whenever colours of several pixels are averaged (blurs, mosaic,
//   crystallize, fragment, despeckle, surface blur, oil paint ...) they are alpha weighted
//   (premultiplied), so transparent pixels never bleed black into their neighbours. Kinds whose
//   point is not transparency keep alpha as it is.
// - Randomised kinds are deterministic for a seed and position stable: the noise depends only on
//   (seed, x, y), whatever rect is.
// - Hot paths use typed arrays and plain loops: separable passes, running sums (box blur and the
//   3-box Gaussian), sliding histograms (median, surface blur, oil paint), van Herk/Gil-Werman
//   (maximum/minimum) and log2(N) two-tap passes for the motion and radial blurs.

import {
  clampRect, inflateRect, cropImage, pasteImage, premultiply, unpremultiply, makeLut, applyLut,
  luminance, randomSeeded, sampleBilinear,
} from './core.js';
import { parseColor } from './color.js';
import { blendImages } from './blend.js';

/** @typedef {import('./core.js').ImageDataLike} ImageDataLike */
/** @typedef {import('./core.js').Rect} Rect */
/** @typedef {'blur'|'sharpen'|'noise'|'pixelate'|'distort'|'stylize'|'render'|'other'} FilterCategory */
/**
 * @typedef {'gaussian-blur'|'box-blur'|'motion-blur'|'radial-blur'|'surface-blur'|
 *   'sharpen'|'unsharp-mask'|'smart-sharpen'|'high-pass'|
 *   'add-noise'|'median'|'despeckle'|'dust-scratches'|'reduce-noise'|
 *   'mosaic'|'crystallize'|'pointillize'|'fragment'|
 *   'twirl'|'pinch'|'spherize'|'ripple'|'wave'|'zigzag'|'polar'|'shear'|'offset'|
 *   'emboss'|'find-edges'|'solarize'|'diffuse'|'oil-paint'|'glowing-edges'|
 *   'clouds'|'difference-clouds'|'lens-flare'|'vignette'|
 *   'maximum'|'minimum'|'custom'|'invert-alpha'} FilterKind
 */
/** @typedef {{ name: string, category: FilterCategory, defaults: object, apply: (img: ImageDataLike, params?: object, rect?: Rect | null) => ImageDataLike }} FilterDef */

// ---------------------------------------------------------------------------------------------
// Small helpers (module private)

/** Finite number or fallback. */
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const clampNum = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
/** Rounds half up into 0..255 (Uint8ClampedArray assignment would round half to even). */
const round8 = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : (v + 0.5) | 0);
/** Hermite smoothstep; e0 > e1 gives the falling edge. */
const smoothstep = (e0, e1, x) => {
  const t = clampNum((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

/** Shallow merge that ignores undefined values in params (so `{ radius: undefined }` keeps the default). */
function merge(defaults, params) {
  const out = { ...defaults };
  if (params) for (const k in params) if (params[k] !== undefined) out[k] = params[k];
  return out;
}

const freezeDeep = (o) => {
  if (o && typeof o === 'object') {
    for (const k of Object.keys(o)) freezeDeep(o[k]);
    Object.freeze(o);
  }
  return o;
};

const region = (img, rect) => clampRect(rect, img.width, img.height);
const isEmpty = (r) => r.width <= 0 || r.height <= 0;
/** rect inflated by px on every side, clipped to the image (the pixels a neighbourhood filter reads). */
const grow = (img, r, px) => clampRect(inflateRect(r, Math.ceil(px)), img.width, img.height);

/** Writes an r-sized RGBA buffer into img at r. */
function storeOut(img, r, out) {
  const row = r.width * 4, d = img.data, W = img.width;
  for (let y = 0; y < r.height; y++) d.set(out.subarray(y * row, (y + 1) * row), ((r.y + y) * W + r.x) * 4);
}

/** Copies the r part of tmp (an image covering region g of img) back into img. */
function copyBack(img, tmp, g, r) {
  const row = r.width * 4, W = img.width;
  for (let y = r.y; y < r.y + r.height; y++) {
    const s = ((y - g.y) * tmp.width + (r.x - g.x)) * 4;
    img.data.set(tmp.data.subarray(s, s + row), (y * W + r.x) * 4);
  }
}

/** Integer hash of three int32s (position-stable noise, cell jitter, lattice values). */
function hash3(x, y, z) {
  let h = (Math.imul(x | 0, 0x27d4eb2d) + Math.imul(y | 0, 0x165667b1) + Math.imul(z | 0, 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
const U32 = 4294967296;

/** Seed of one row's randomSeeded stream: stable per (seed, salt, y) whatever the rect is. */
const rowSeed = (seed, salt, y) => (Math.imul((seed | 0) + salt, 0x9e3779b1) ^ Math.imul(y + 1, 0x85ebca6b)) >>> 0;

/** Premultiplied luma (luma * alpha / 255) of region g, one float per pixel. */
function lumaPlane(img, g) {
  const L = new Float32Array(g.width * g.height), d = img.data, W = img.width;
  for (let y = 0, o = 0; y < g.height; y++) {
    let i = ((g.y + y) * W + g.x) * 4;
    for (let x = 0; x < g.width; x++, i += 4, o++) L[o] = (luminance(d[i], d[i + 1], d[i + 2]) * d[i + 3]) / 255;
  }
  return L;
}

/** Sobel gradient magnitude of a plane at (x, y), edges replicated; a hard 0 -> 255 step gives 255. */
function sobelMag(L, w, h, x, y) {
  const xm = x > 0 ? x - 1 : 0, xp = x < w - 1 ? x + 1 : x;
  const r0 = (y > 0 ? y - 1 : 0) * w, r1 = y * w, r2 = (y < h - 1 ? y + 1 : y) * w;
  const gx = L[r0 + xp] + 2 * L[r1 + xp] + L[r2 + xp] - (L[r0 + xm] + 2 * L[r1 + xm] + L[r2 + xm]);
  const gy = L[r2 + xm] + 2 * L[r2 + x] + L[r2 + xp] - (L[r0 + xm] + 2 * L[r0 + x] + L[r0 + xp]);
  return Math.sqrt(gx * gx + gy * gy) * 0.25;
}

/**
 * Byte indices of the neighbours (x + dx[t], y + dy[t]) clamped to the image; a fully transparent
 * neighbour is replaced by the centre pixel so alpha edges do not read as colour edges.
 */
function gather(d, W, H, x, y, dx, dy, n, taps) {
  const ci = (y * W + x) * 4;
  for (let t = 0; t < n; t++) {
    let xx = x + dx[t], yy = y + dy[t];
    xx = xx < 0 ? 0 : xx >= W ? W - 1 : xx;
    yy = yy < 0 ? 0 : yy >= H ? H - 1 : yy;
    const ni = (yy * W + xx) * 4;
    taps[t] = d[ni + 3] === 0 ? ci : ni;
  }
}

// ---------------------------------------------------------------------------------------------
// Float RGBA passes (premultiplied 0..1 buffers from core.js premultiply, w x h, edges replicated)

/** Gaussian radius (sigma) above which the 3-pass box approximation replaces the direct kernel. */
const GAUSS_DIRECT_MAX = 20;

/** Normalised sampled Gaussian, half width ceil(3 sigma). */
function gaussKernel(sigma) {
  const K = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float64Array(2 * K + 1);
  const s2 = 2 * sigma * sigma;
  let sum = 0;
  for (let j = -K; j <= K; j++) sum += k[j + K] = Math.exp(-(j * j) / s2);
  for (let j = 0; j < k.length; j++) k[j] /= sum;
  return k;
}

/** Horizontal pass of a symmetric kernel k (2K + 1 taps), edges replicated. */
function convolveH(src, dst, w, h, k, K) {
  const stride = w * 4, kc = k[K];
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    for (let x = 0; x < w; x++) {
      const ci = row + x * 4;
      let r, g, b, a;
      if (x >= K && x + K < w) {
        r = src[ci] * kc;
        g = src[ci + 1] * kc;
        b = src[ci + 2] * kc;
        a = src[ci + 3] * kc;
        for (let j = 1, lo = ci - 4, hi = ci + 4; j <= K; j++, lo -= 4, hi += 4) {
          const wt = k[K + j];
          r += (src[lo] + src[hi]) * wt;
          g += (src[lo + 1] + src[hi + 1]) * wt;
          b += (src[lo + 2] + src[hi + 2]) * wt;
          a += (src[lo + 3] + src[hi + 3]) * wt;
        }
      } else {
        r = g = b = a = 0;
        for (let j = -K; j <= K; j++) {
          let xx = x + j;
          xx = xx < 0 ? 0 : xx >= w ? w - 1 : xx;
          const i = row + xx * 4, wt = k[j + K];
          r += src[i] * wt;
          g += src[i + 1] * wt;
          b += src[i + 2] * wt;
          a += src[i + 3] * wt;
        }
      }
      dst[ci] = r;
      dst[ci + 1] = g;
      dst[ci + 2] = b;
      dst[ci + 3] = a;
    }
  }
}

/** Vertical pass of a symmetric kernel: whole rows at a time into a float64 accumulator (cache friendly). */
function convolveV(src, dst, w, h, k, K) {
  const stride = w * 4, kc = k[K], acc = new Float64Array(stride);
  for (let y = 0; y < h; y++) {
    const c = y * stride;
    for (let i = 0; i < stride; i++) acc[i] = src[c + i] * kc;
    for (let j = 1; j <= K; j++) {
      const sa = (y - j < 0 ? 0 : y - j) * stride, sb = (y + j >= h ? h - 1 : y + j) * stride, wt = k[K + j];
      for (let i = 0; i < stride; i++) acc[i] += (src[sa + i] + src[sb + i]) * wt;
    }
    for (let i = 0; i < stride; i++) dst[c + i] = acc[i];
  }
}

/** Horizontal box of fractional radius rad (weights 1 inside +-floor(rad), frac(rad) at the ends), running sums. */
function boxH(src, dst, w, h, rad) {
  const n = Math.floor(rad), f = rad - n, norm = 1 / (2 * n + 1 + 2 * f), stride = w * 4, last = w - 1;
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    let sr = 0, sg = 0, sb = 0, sa = 0;
    for (let j = -n; j <= n; j++) {
      const i = row + (j < 0 ? 0 : j > last ? last : j) * 4;
      sr += src[i];
      sg += src[i + 1];
      sb += src[i + 2];
      sa += src[i + 3];
    }
    for (let x = 0; x < w; x++) {
      const o = row + x * 4;
      const xa = x + n + 1, xr = x - n;
      const ia = row + (xa > last ? last : xa) * 4, ir = row + (xr < 0 ? 0 : xr) * 4;
      if (f > 0) {
        const xo = x - n - 1, io = row + (xo < 0 ? 0 : xo) * 4;
        dst[o] = (sr + f * (src[io] + src[ia])) * norm;
        dst[o + 1] = (sg + f * (src[io + 1] + src[ia + 1])) * norm;
        dst[o + 2] = (sb + f * (src[io + 2] + src[ia + 2])) * norm;
        dst[o + 3] = (sa + f * (src[io + 3] + src[ia + 3])) * norm;
      } else {
        dst[o] = sr * norm;
        dst[o + 1] = sg * norm;
        dst[o + 2] = sb * norm;
        dst[o + 3] = sa * norm;
      }
      sr += src[ia] - src[ir];
      sg += src[ia + 1] - src[ir + 1];
      sb += src[ia + 2] - src[ir + 2];
      sa += src[ia + 3] - src[ir + 3];
    }
  }
}

/** Vertical box (same weights as boxH), running sums per column processed row by row (cache friendly). */
function boxV(src, dst, w, h, rad) {
  const n = Math.floor(rad), f = rad - n, norm = 1 / (2 * n + 1 + 2 * f), fw = f * norm, stride = w * 4, last = h - 1;
  const acc = new Float64Array(stride);
  for (let j = -n; j <= n; j++) {
    const s = (j < 0 ? 0 : j > last ? last : j) * stride;
    for (let i = 0; i < stride; i++) acc[i] += src[s + i];
  }
  for (let y = 0; y < h; y++) {
    const o = y * stride, ya = y + n + 1, yr = y - n, yo = y - n - 1;
    const sa = (ya > last ? last : ya) * stride, sr = (yr < 0 ? 0 : yr) * stride, so = (yo < 0 ? 0 : yo) * stride;
    for (let i = 0; i < stride; i++) {
      const s = acc[i], va = src[sa + i];
      dst[o + i] = s * norm + (src[so + i] + va) * fw;
      acc[i] = s + va - src[sr + i];
    }
  }
}

/** Variance of the fractional box of radius rad used by boxH/boxV. */
function boxVariance(rad) {
  const n = Math.floor(rad), f = rad - n;
  return ((n * (n + 1) * (2 * n + 1)) / 3 + 2 * f * (n + 1) * (n + 1)) / (2 * n + 1 + 2 * f);
}

/** Fractional box radius whose 3-fold convolution has variance sigma^2 (bisection; exact, so no jumps as sigma moves). */
function boxRadiusFor(sigma) {
  const target = (sigma * sigma) / 3;
  let lo = 0, hi = 2 * sigma + 2;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (boxVariance(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Pixels a Gaussian of this sigma reads on each side. */
const gaussSupport = (sigma) =>
  sigma <= GAUSS_DIRECT_MAX ? Math.max(1, Math.ceil(3 * sigma)) : 3 * (Math.floor(boxRadiusFor(sigma)) + 2);

/** Gaussian blur of a float RGBA buffer, in place (returns it). */
function gaussianFloat(f, w, h, sigma) {
  const tmp = new Float32Array(f.length);
  if (sigma <= GAUSS_DIRECT_MAX) {
    const k = gaussKernel(sigma), K = (k.length - 1) >> 1;
    convolveH(f, tmp, w, h, k, K);
    convolveV(tmp, f, w, h, k, K);
    return f;
  }
  const rad = boxRadiusFor(sigma);
  for (let p = 0; p < 3; p++) {
    boxH(f, tmp, w, h, rad);
    boxV(tmp, f, w, h, rad);
  }
  return f;
}

/** Premultiplied Gaussian-blurred copy of the pixels around r: f covers region g (0..1 floats). */
function blurredRegion(img, r, sigma) {
  const g = grow(img, r, gaussSupport(sigma) + 1);
  const f = gaussianFloat(premultiply(cropImage(img, g)), g.width, g.height, sigma);
  return { g, f };
}

/**
 * dst(p) = (src(m1 p) + src(m2 p)) / 2 for 2x3 affine maps m1, m2: bilinear on the (premultiplied)
 * float buffer, coordinates clamped to it. The sampling is written out inline (no helper call per
 * sample: passing doubles to a non-inlined function boxes them).
 */
function affinePair(src, dst, w, h, m1, m2) {
  const xm = w - 1, ym = h - 1;
  for (let y = 0, o = 0; y < h; y++) {
    // both maps are affine: step along the row by their x columns
    let ax = m1[1] * y + m1[2], ay = m1[4] * y + m1[5], bx = m2[1] * y + m2[2], by = m2[4] * y + m2[5];
    const adx = m1[0], ady = m1[3], bdx = m2[0], bdy = m2[3];
    for (let x = 0; x < w; x++, o += 4, ax += adx, ay += ady, bx += bdx, by += bdy) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let s = 0; s < 2; s++) {
        let fx = s ? bx : ax, fy = s ? by : ay;
        if (!(fx > 0)) fx = 0;
        else if (fx > xm) fx = xm;
        if (!(fy > 0)) fy = 0;
        else if (fy > ym) fy = ym;
        const x0 = fx | 0, y0 = fy | 0, tx = fx - x0, ty = fy - y0;
        const i00 = (y0 * w + x0) * 4, dx = x0 < xm ? 4 : 0, dy = y0 < ym ? w * 4 : 0;
        const i10 = i00 + dx, i01 = i00 + dy, i11 = i01 + dx;
        const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
        r += src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11;
        g += src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
        b += src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;
        a += src[i00 + 3] * w00 + src[i10 + 3] * w10 + src[i01 + 3] * w01 + src[i11 + 3] * w11;
      }
      dst[o] = r * 0.5;
      dst[o + 1] = g * 0.5;
      dst[o + 2] = b * 0.5;
      dst[o + 3] = a * 0.5;
    }
  }
}

/**
 * affinePair for the pure translations +-(ox, oy): the bilinear weights are the same for every
 * pixel, so only the tap indices are computed (clamped to the buffer like affinePair).
 */
function translatePair(src, dst, w, h, ox, oy) {
  const stride = w * 4, xm = w - 1, ym = h - 1;
  const ax = Math.floor(ox), ay = Math.floor(oy), tx = ox - ax, ty = oy - ay;
  const bx = Math.floor(-ox), by = Math.floor(-oy), ux = -ox - bx, uy = -oy - by;
  const a00 = (1 - tx) * (1 - ty) * 0.5, a10 = tx * (1 - ty) * 0.5, a01 = (1 - tx) * ty * 0.5, a11 = tx * ty * 0.5;
  const b00 = (1 - ux) * (1 - uy) * 0.5, b10 = ux * (1 - uy) * 0.5, b01 = (1 - ux) * uy * 0.5, b11 = ux * uy * 0.5;
  // columns where all four x taps are inside the buffer
  const xlo = Math.max(0, -ax, -bx), xhi = Math.min(w, w - ax - 1, w - bx - 1);
  const cy = (v) => (v < 0 ? 0 : v > ym ? ym : v) * stride;
  for (let y = 0; y < h; y++) {
    const ra0 = cy(y + ay), ra1 = cy(y + ay + 1), rb0 = cy(y + by), rb1 = cy(y + by + 1), o = y * stride;
    for (let x = 0; x < w; x++) {
      let pa0, pa1, pb0, pb1;
      if (x >= xlo && x < xhi) {
        pa0 = (x + ax) * 4;
        pa1 = pa0 + 4;
        pb0 = (x + bx) * 4;
        pb1 = pb0 + 4;
      } else {
        const c0 = x + ax, c1 = x + bx;
        pa0 = (c0 < 0 ? 0 : c0 > xm ? xm : c0) * 4;
        pa1 = (c0 + 1 < 0 ? 0 : c0 + 1 > xm ? xm : c0 + 1) * 4;
        pb0 = (c1 < 0 ? 0 : c1 > xm ? xm : c1) * 4;
        pb1 = (c1 + 1 < 0 ? 0 : c1 + 1 > xm ? xm : c1 + 1) * 4;
      }
      const q = o + x * 4;
      for (let c = 0; c < 4; c++) {
        dst[q + c] = src[ra0 + pa0 + c] * a00 + src[ra0 + pa1 + c] * a10 + src[ra1 + pa0 + c] * a01 + src[ra1 + pa1 + c] * a11
          + src[rb0 + pb0 + c] * b00 + src[rb0 + pb1 + c] * b10 + src[rb1 + pb0 + c] * b01 + src[rb1 + pb1 + c] * b11;
      }
    }
  }
}

/** Smallest power of two >= n, within [2, cap]. */
function nextPow2(n, cap) {
  let N = 2;
  while (N < n && N < cap) N *= 2;
  return N;
}

/**
 * Applies a 2^k-tap box along a one-parameter family of affine maps as k two-tap passes: pass j
 * averages the maps at parameter +-step * 2^(j-1), and the passes compose into 2^k equally spaced
 * taps spanning the whole range. setMap(m, t) writes the map for parameter t into m.
 */
function tapPasses(f, w, h, N, step, setMap) {
  let t = new Float32Array(f.length);
  const m1 = new Float64Array(6), m2 = new Float64Array(6);
  for (let j = 0; (1 << j) < N; j++) {
    const s = step * 2 ** (j - 1);
    setMap(m1, s);
    setMap(m2, -s);
    const shift = m1[0] === 1 && m1[1] === 0 && m1[3] === 0 && m1[4] === 1 && m2[2] === -m1[2] && m2[5] === -m1[5];
    if (shift) translatePair(f, t, w, h, m1[2], m1[5]);
    else affinePair(f, t, w, h, m1, m2);
    const swap = f;
    f = t;
    t = swap;
  }
  return f;
}

// ---------------------------------------------------------------------------------------------
// Blur

function gaussianBlur(img, p, rect) {
  const r = region(img, rect);
  const sigma = clampNum(num(p.radius, 0), 0, 1000);
  if (isEmpty(r) || !(sigma > 0)) return img;
  const g = grow(img, r, gaussSupport(sigma) + 1);
  const tmp = cropImage(img, g);
  unpremultiply(gaussianFloat(premultiply(tmp), g.width, g.height, sigma), tmp);
  copyBack(img, tmp, g, r);
  return img;
}

function boxBlur(img, p, rect) {
  const r = region(img, rect);
  const rad = clampNum(num(p.radius, 0), 0, 2000);
  if (isEmpty(r) || !(rad > 0)) return img;
  const g = grow(img, r, rad + 1);
  const tmp = cropImage(img, g);
  const f = premultiply(tmp), t = new Float32Array(f.length);
  boxH(f, t, g.width, g.height, rad);
  boxV(t, f, g.width, g.height, rad);
  unpremultiply(f, tmp);
  copyBack(img, tmp, g, r);
  return img;
}

/**
 * Line kernel of length dist along (ux, uy) on a premultiplied float buffer (w x h), by shearing:
 * with the major axis the one the direction is closer to and m the minor offset per major step,
 * line j (the points (i, j + i m)) is resampled with linear interpolation across the minor axis,
 * box-filtered along the major axis (running sums, fractional ends, half length dist |u_major| / 2)
 * and scattered back to the pixel grid with the inverse interpolation. Only two 1-D linear
 * interpolations touch the cross direction, so an edge parallel to the motion stays sharp, and the
 * cost is O(w h) whatever the distance. Positions past the buffer's ends repeat the edge (across the
 * line) or the line's last sample (along it). ox, oy: image position of the buffer's first pixel, so
 * the family of lines (and with it the interpolation phases) is anchored to the image, not the
 * buffer. Returns a new buffer.
 */
function lineBlur(f, w, h, ux, uy, dist, ox, oy) {
  const horiz = Math.abs(ux) >= Math.abs(uy);
  const nMaj = horiz ? w : h, nMin = horiz ? h : w, sMaj = horiz ? 4 : w * 4, sMin = horiz ? w * 4 : 4;
  const m = horiz ? uy / ux : ux / uy, R = (dist * (horiz ? Math.abs(ux) : Math.abs(uy))) / 2;
  const n = Math.floor(R), fr = R - n, norm = 1 / (2 * n + 1 + 2 * fr), lastMaj = nMaj - 1, lastMin = nMin - 1;
  const out = new Float32Array(f.length), line = new Float32Array(nMaj * 4);
  // Major position i sits i m off the line's origin: floor fl[i] + fraction ft[i]; its output
  // (i, k) interpolates lines k - i m: j = k - c[i] with weight 1 - u[i] and j + 1 with u[i].
  const fl = new Int32Array(nMaj), ft = new Float64Array(nMaj), c = new Int32Array(nMaj), u = new Float64Array(nMaj);
  const origin = horiz ? ox : oy;
  for (let i = 0; i < nMaj; i++) {
    const o = (i + origin) * m, a = Math.floor(o), b = Math.ceil(o);
    fl[i] = a;
    ft[i] = o - a;
    c[i] = b;
    u[i] = b - o;
  }
  const cLo = Math.min(c[0], c[lastMaj]), cHi = Math.max(c[0], c[lastMaj]);
  for (let j = -cHi; j <= nMin - cLo; j++) {
    // major positions whose output lands in the buffer: 0 <= j + c[i] and j + c[i] - 1 <= lastMin
    let ia = 0, ib = lastMaj;
    if (m > 0) {
      while (ia <= lastMaj && j + c[ia] < 0) ia++;
      while (ib >= ia && j + c[ib] - 1 > lastMin) ib--;
    } else if (m < 0) {
      while (ia <= lastMaj && j + c[ia] - 1 > lastMin) ia++;
      while (ib >= ia && j + c[ib] < 0) ib--;
    }
    if (ia > ib) continue;
    // resample the line where the box reads it
    const i0 = ia - n - 1 < 0 ? 0 : ia - n - 1, i1 = ib + n + 1 > lastMaj ? lastMaj : ib + n + 1;
    for (let i = i0; i <= i1; i++) {
      let y0 = j + fl[i], y1 = y0 + 1;
      const t = ft[i];
      y0 = y0 < 0 ? 0 : y0 > lastMin ? lastMin : y0;
      y1 = y1 < 0 ? 0 : y1 > lastMin ? lastMin : y1;
      const p0 = i * sMaj + y0 * sMin, p1 = i * sMaj + y1 * sMin, q = i * 4;
      line[q] = f[p0] + (f[p1] - f[p0]) * t;
      line[q + 1] = f[p0 + 1] + (f[p1 + 1] - f[p0 + 1]) * t;
      line[q + 2] = f[p0 + 2] + (f[p1 + 2] - f[p0 + 2]) * t;
      line[q + 3] = f[p0 + 3] + (f[p1 + 3] - f[p0 + 3]) * t;
    }
    // running box along the line (reads stay in i0..i1), scattered to the two output rows
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
    for (let k = ia - n; k <= ia + n; k++) {
      const q = (k < 0 ? 0 : k > lastMaj ? lastMaj : k) * 4;
      s0 += line[q];
      s1 += line[q + 1];
      s2 += line[q + 2];
      s3 += line[q + 3];
    }
    for (let i = ia; i <= ib; i++) {
      const ko = i - n - 1, ka = i + n + 1;
      const qo = (ko < 0 ? 0 : ko) * 4, qa = (ka > lastMaj ? lastMaj : ka) * 4;
      const v0 = (s0 + fr * (line[qo] + line[qa])) * norm, v1 = (s1 + fr * (line[qo + 1] + line[qa + 1])) * norm;
      const v2 = (s2 + fr * (line[qo + 2] + line[qa + 2])) * norm, v3 = (s3 + fr * (line[qo + 3] + line[qa + 3])) * norm;
      const k1 = j + c[i], wu = u[i], w1 = 1 - wu;
      if (k1 <= lastMin) {
        const o = i * sMaj + k1 * sMin;
        out[o] += v0 * w1;
        out[o + 1] += v1 * w1;
        out[o + 2] += v2 * w1;
        out[o + 3] += v3 * w1;
      }
      if (wu > 0 && k1 >= 1) {
        const o = i * sMaj + (k1 - 1) * sMin;
        out[o] += v0 * wu;
        out[o + 1] += v1 * wu;
        out[o + 2] += v2 * wu;
        out[o + 3] += v3 * wu;
      }
      const kr = i - n, qr = (kr < 0 ? 0 : kr) * 4, qn = (ka > lastMaj ? lastMaj : ka) * 4;
      s0 += line[qn] - line[qr];
      s1 += line[qn + 1] - line[qr + 1];
      s2 += line[qn + 2] - line[qr + 2];
      s3 += line[qn + 3] - line[qr + 3];
    }
  }
  return out;
}

function motionBlur(img, p, rect) {
  const r = region(img, rect);
  const dist = clampNum(num(p.distance, 0), 0, 2000);
  if (isEmpty(r) || dist < 1) return img;
  const ang = num(p.angle, 0) * DEG;
  let ux = Math.cos(ang), uy = -Math.sin(ang); // degrees counter-clockwise from horizontal, y down
  if (Math.abs(ux) < 1e-12) ux = 0;
  if (Math.abs(uy) < 1e-12) uy = 0;
  // the kernel reaches dist / 2 along the line, plus one pixel of interpolation and the fractional end
  const g = grow(img, r, dist / 2 + 3);
  const tmp = cropImage(img, g);
  unpremultiply(lineBlur(premultiply(tmp), g.width, g.height, ux, uy, dist, g.x, g.y), tmp);
  copyBack(img, tmp, g, r);
  return img;
}

/** Log-scale span of the zoom blur at amount 100. */
const ZOOM_SPAN = 0.8;

function radialBlur(img, p, rect) {
  const r = region(img, rect);
  const amount = clampNum(num(p.amount, 0), 0, 100);
  if (isEmpty(r) || !(amount > 0)) return img;
  const zoom = p.method === 'zoom';
  const W = img.width, H = img.height, c = p.center || {};
  const cx = clampNum(num(c.x, 0.5), -2, 3) * W - 0.5, cy = clampNum(num(c.y, 0.5), -2, 3) * H - 0.5;
  const xs = [r.x, r.x + r.width - 1], ys = [r.y, r.y + r.height - 1];
  let rmax = 0;
  for (const x of xs) for (const y of ys) rmax = Math.max(rmax, Math.hypot(x - cx, y - cy));
  // spin: total arc in radians (amount = degrees); zoom: total log-scale range, symmetric about 1
  const span = zoom ? (amount / 100) * ZOOM_SPAN : amount * DEG;
  const disp = zoom ? rmax * (Math.exp(span / 2) - Math.exp(-span / 2)) : rmax * span;
  if (disp < 0.5) return img;
  const N = nextPow2(Math.ceil(disp) + 1, 8192);
  // Every pixel the rect depends on lies on the rect mapped through the parameter range.
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  const steps = zoom ? 1 : 32;
  for (let s = 0; s <= steps; s++) {
    const t = -span / 2 + (span * s) / steps;
    const ca = zoom ? Math.exp(t) : Math.cos(t), sa = zoom ? 0 : Math.sin(t);
    for (const x of xs) {
      for (const y of ys) {
        const qx = cx + ca * (x - cx) - sa * (y - cy), qy = cy + sa * (x - cx) + ca * (y - cy);
        if (qx < x1) x1 = qx;
        if (qx > x2) x2 = qx;
        if (qy < y1) y1 = qy;
        if (qy > y2) y2 = qy;
      }
    }
  }
  const margin = 2 + (zoom ? 0 : rmax * (1 - Math.cos(span / steps / 2)));
  const g = clampRect({ x: x1 - margin, y: y1 - margin, width: x2 - x1 + 2 * margin + 1, height: y2 - y1 + 2 * margin + 1 }, W, H);
  const gx = cx - g.x, gy = cy - g.y;
  const tmp = cropImage(img, g);
  const f = tapPasses(premultiply(tmp), g.width, g.height, N, span / (N - 1), zoom
    ? (m, t) => {
      const s = Math.exp(t);
      m[0] = s; m[1] = 0; m[2] = gx - s * gx;
      m[3] = 0; m[4] = s; m[5] = gy - s * gy;
    }
    : (m, t) => {
      const co = Math.cos(t), si = Math.sin(t);
      m[0] = co; m[1] = -si; m[2] = gx - co * gx + si * gy;
      m[3] = si; m[4] = co; m[5] = gy - si * gx - co * gy;
    });
  unpremultiply(f, tmp);
  copyBack(img, tmp, g, r);
  return img;
}

/** Adds (s = 1) or removes (s = -1) column x, rows y0..y1, to alpha-weighted per-channel histograms. */
function histColumn(d, W, x, y0, y1, hr, hg, hb, s) {
  const step = W * 4;
  for (let y = y0, i = (y0 * W + x) * 4; y <= y1; y++, i += step) {
    const a = d[i + 3] * s;
    if (a === 0) continue;
    hr[d[i]] += a;
    hg[d[i + 1]] += a;
    hb[d[i + 2]] += a;
  }
}

/** Surface-blur mean of one channel: values near v weighted by 1 - |b - v| / (2.5 threshold). */
function weightedMean(hist, v, span, wt) {
  const lo = v - span < 0 ? 0 : v - span, hi = v + span > 255 ? 255 : v + span;
  let sw = 0, sv = 0;
  for (let b = lo; b <= hi; b++) {
    const c = hist[b];
    if (c === 0) continue;
    const ww = c * wt[b > v ? b - v : v - b];
    sw += ww;
    sv += ww * b;
  }
  return sw > 0 ? sv / sw : v;
}

/** Photoshop-style surface blur over a square window (sliding histograms, cost independent of radius). Alpha kept. */
function surfaceBlurCore(img, r, rad, threshold) {
  const W = img.width, H = img.height, d = img.data;
  const T = 2.5 * threshold, wt = new Float64Array(256);
  let span = 0;
  for (let k = 0; k < 256; k++) {
    wt[k] = Math.max(0, 1 - k / T);
    if (wt[k] > 0) span = k;
  }
  const hr = new Int32Array(256), hg = new Int32Array(256), hb = new Int32Array(256);
  const out = new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = r.y, o = 0; y < r.y + r.height; y++) {
    const y0 = y - rad < 0 ? 0 : y - rad, y1 = y + rad >= H ? H - 1 : y + rad;
    hr.fill(0);
    hg.fill(0);
    hb.fill(0);
    for (let xx = Math.max(0, r.x - rad), xe = Math.min(W - 1, r.x + rad); xx <= xe; xx++) histColumn(d, W, xx, y0, y1, hr, hg, hb, 1);
    let i = (y * W + r.x) * 4;
    for (let x = r.x; x < r.x + r.width; x++, i += 4, o += 4) {
      out[o + 3] = d[i + 3];
      if (d[i + 3] === 0) {
        out[o] = d[i];
        out[o + 1] = d[i + 1];
        out[o + 2] = d[i + 2];
      } else {
        out[o] = round8(weightedMean(hr, d[i], span, wt));
        out[o + 1] = round8(weightedMean(hg, d[i + 1], span, wt));
        out[o + 2] = round8(weightedMean(hb, d[i + 2], span, wt));
      }
      if (x - rad >= 0) histColumn(d, W, x - rad, y0, y1, hr, hg, hb, -1);
      if (x + rad + 1 < W) histColumn(d, W, x + rad + 1, y0, y1, hr, hg, hb, 1);
    }
  }
  return out;
}

function surfaceBlur(img, p, rect) {
  const r = region(img, rect);
  const rad = Math.round(clampNum(num(p.radius, 0), 0, 100));
  if (isEmpty(r) || rad < 1) return img;
  storeOut(img, r, surfaceBlurCore(img, r, rad, clampNum(num(p.threshold, 15), 1, 255)));
  return img;
}

// ---------------------------------------------------------------------------------------------
// Sharpen

/**
 * Unsharp mask: colour += amount * (colour - gaussian(colour)) where the max channel difference
 * reaches threshold. reduceNoise (smart sharpen, 0..100) additionally scales the amount by an edge
 * weight: smoothstep of the Sobel magnitude of luma from reduceNoise / 2 over a window that widens
 * to 24 levels by reduceNoise 10, so reduceNoise 0 is exactly the plain unsharp mask. The blur is
 * premultiplied, alpha kept.
 */
function unsharp(img, rect, amount, sigma, threshold, reduceNoise) {
  const r = region(img, rect);
  if (isEmpty(r) || !(sigma > 0) || amount === 0) return img;
  const { g, f } = blurredRegion(img, r, sigma);
  const gw = g.width, gh = g.height;
  const weighted = reduceNoise !== null && reduceNoise > 0;
  const L = weighted ? lumaPlane(img, g) : null;
  const e0 = weighted ? reduceNoise * 0.5 : 0, e1 = weighted ? e0 + 2.4 * Math.min(reduceNoise, 10) : 0;
  const d = img.data, W = img.width, k = amount / 100;
  const out = new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = r.y, o = 0; y < r.y + r.height; y++) {
    let i = (y * W + r.x) * 4, fi = ((y - g.y) * gw + (r.x - g.x)) * 4;
    for (let x = r.x; x < r.x + r.width; x++, i += 4, fi += 4, o += 4) {
      const R = d[i], G = d[i + 1], B = d[i + 2], A = d[i + 3];
      out[o] = R;
      out[o + 1] = G;
      out[o + 2] = B;
      out[o + 3] = A;
      const fa = f[fi + 3];
      if (A === 0 || !(fa > 0)) continue;
      const s = 255 / fa;
      const dr = R - f[fi] * s, dg = G - f[fi + 1] * s, db = B - f[fi + 2] * s;
      if (threshold > 0 && Math.max(Math.abs(dr), Math.abs(dg), Math.abs(db)) < threshold) continue;
      const kk = L ? k * smoothstep(e0, e1, sobelMag(L, gw, gh, x - g.x, y - g.y)) : k;
      out[o] = round8(R + kk * dr);
      out[o + 1] = round8(G + kk * dg);
      out[o + 2] = round8(B + kk * db);
    }
  }
  storeOut(img, r, out);
  return img;
}

function highPass(img, p, rect) {
  const r = region(img, rect);
  const sigma = clampNum(num(p.radius, 0), 0, 1000);
  if (isEmpty(r)) return img;
  const d = img.data, W = img.width;
  if (!(sigma > 0)) {
    // radius 0: nothing passes but the mean -> flat grey
    for (let y = r.y; y < r.y + r.height; y++) {
      for (let x = r.x, i = (y * W + r.x) * 4; x < r.x + r.width; x++, i += 4) d[i] = d[i + 1] = d[i + 2] = 128;
    }
    return img;
  }
  const { g, f } = blurredRegion(img, r, sigma);
  for (let y = r.y; y < r.y + r.height; y++) {
    let i = (y * W + r.x) * 4, fi = ((y - g.y) * g.width + (r.x - g.x)) * 4;
    for (let x = r.x; x < r.x + r.width; x++, i += 4, fi += 4) {
      const fa = f[fi + 3];
      if (!(fa > 0)) continue;
      const s = 255 / fa;
      d[i] = round8(d[i] - f[fi] * s + 128);
      d[i + 1] = round8(d[i + 1] - f[fi + 1] * s + 128);
      d[i + 2] = round8(d[i + 2] - f[fi + 2] * s + 128);
    }
  }
  return img;
}

// ---------------------------------------------------------------------------------------------
// Noise

function addNoise(img, p, rect) {
  const r = region(img, rect);
  const amount = clampNum(num(p.amount, 0), 0, 400);
  if (isEmpty(r) || !(amount > 0)) return img;
  const gaussian = p.distribution === 'gaussian', mono = !!p.monochromatic, seed = num(p.seed, 1) | 0;
  // uniform: +-A; gaussian: sigma = A / 2 (Box-Muller). A is amount% of half the range.
  const A = (amount / 100) * 127.5, S = A * 0.5;
  const draws = gaussian ? (mono ? 2 : 4) : mono ? 1 : 3; // fixed per pixel -> position-stable streams
  const d = img.data, W = img.width;
  for (let y = r.y; y < r.y + r.height; y++) {
    const rnd = randomSeeded(rowSeed(seed, 0x51ed270b, y));
    for (let k = r.x * draws; k > 0; k--) rnd();
    let i = (y * W + r.x) * 4;
    for (let x = 0; x < r.width; x++, i += 4) {
      let n0, n1, n2;
      if (gaussian) {
        const m = Math.sqrt(-2 * Math.log(1 - rnd())) * S, t = TAU * rnd();
        n0 = m * Math.cos(t);
        if (mono) n1 = n2 = n0;
        else {
          n1 = m * Math.sin(t);
          n2 = Math.sqrt(-2 * Math.log(1 - rnd())) * S * Math.cos(TAU * rnd());
        }
      } else {
        n0 = (rnd() * 2 - 1) * A;
        if (mono) n1 = n2 = n0;
        else {
          n1 = (rnd() * 2 - 1) * A;
          n2 = (rnd() * 2 - 1) * A;
        }
      }
      if (d[i + 3] === 0) continue;
      d[i] = round8(d[i] + n0);
      d[i + 1] = round8(d[i + 1] + n1);
      d[i + 2] = round8(d[i + 2] + n2);
    }
  }
  return img;
}

/** Adds/removes one window column to the median histograms, keeping the "values below median" counts in step. */
function medColumn(d, W, x, y0, y1, hist, m, lt, cnt, s) {
  const step = W * 4;
  for (let y = y0, i = (y0 * W + x) * 4; y <= y1; y++, i += step) {
    const a = d[i + 3];
    hist[768 + a] += s;
    if (a < m[3]) lt[3] += s;
    cnt[1] += s;
    if (a === 0) continue; // transparent pixels have no colour to vote with
    cnt[0] += s;
    const R = d[i], G = d[i + 1], B = d[i + 2];
    hist[R] += s;
    if (R < m[0]) lt[0] += s;
    hist[256 + G] += s;
    if (G < m[1]) lt[1] += s;
    hist[512 + B] += s;
    if (B < m[2]) lt[2] += s;
  }
}

/**
 * Per-channel median over a square window (Huang's sliding histogram with median tracking). RGB
 * medians only count pixels with alpha > 0; alpha takes the median of every pixel. Returns an
 * r-sized buffer.
 */
function medianCore(img, r, rad) {
  const W = img.width, H = img.height, d = img.data;
  const hist = new Int32Array(1024), m = new Int32Array(4), lt = new Int32Array(4), cnt = new Int32Array(2);
  const out = new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = r.y, o = 0; y < r.y + r.height; y++) {
    const y0 = y - rad < 0 ? 0 : y - rad, y1 = y + rad >= H ? H - 1 : y + rad;
    hist.fill(0);
    m.fill(0);
    lt.fill(0);
    cnt.fill(0);
    for (let xx = Math.max(0, r.x - rad), xe = Math.min(W - 1, r.x + rad); xx <= xe; xx++) medColumn(d, W, xx, y0, y1, hist, m, lt, cnt, 1);
    let i = (y * W + r.x) * 4;
    for (let x = r.x; x < r.x + r.width; x++, i += 4, o += 4) {
      for (let c = 0; c < 4; c++) {
        const n = c === 3 ? cnt[1] : cnt[0];
        if (n === 0) {
          out[o + c] = d[i + c];
          continue;
        }
        const t = (n - 1) >> 1, base = c << 8;
        let mc = m[c], l = lt[c];
        while (l > t) {
          mc--;
          l -= hist[base + mc];
        }
        while (l + hist[base + mc] <= t) {
          l += hist[base + mc];
          mc++;
        }
        m[c] = mc;
        lt[c] = l;
        out[o + c] = mc;
      }
      if (x - rad >= 0) medColumn(d, W, x - rad, y0, y1, hist, m, lt, cnt, -1);
      if (x + rad + 1 < W) medColumn(d, W, x + rad + 1, y0, y1, hist, m, lt, cnt, 1);
    }
  }
  return out;
}

function median(img, p, rect) {
  const r = region(img, rect);
  const rad = Math.round(clampNum(num(p.radius, 0), 0, 500));
  if (isEmpty(r) || rad < 1) return img;
  storeOut(img, r, medianCore(img, r, rad));
  return img;
}

function dustScratches(img, p, rect) {
  const r = region(img, rect);
  const rad = Math.round(clampNum(num(p.radius, 0), 0, 500));
  if (isEmpty(r) || rad < 1) return img;
  const threshold = clampNum(num(p.threshold, 0), 0, 255);
  const med = medianCore(img, r, rad), d = img.data, W = img.width;
  for (let y = r.y, o = 0; y < r.y + r.height; y++) {
    for (let x = r.x, i = (y * W + r.x) * 4; x < r.x + r.width; x++, i += 4, o += 4) {
      const diff = Math.max(Math.abs(d[i] - med[o]), Math.abs(d[i + 1] - med[o + 1]), Math.abs(d[i + 2] - med[o + 2]), Math.abs(d[i + 3] - med[o + 3]));
      if (diff > threshold) {
        d[i] = med[o];
        d[i + 1] = med[o + 1];
        d[i + 2] = med[o + 2];
        d[i + 3] = med[o + 3];
      }
    }
  }
  return img;
}

/** Blurs (3x3 binomial, premultiplied) everywhere except where luma edges are found. Alpha kept. */
function despeckle(img, _p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const g = grow(img, r, 2), gw = g.width, gh = g.height;
  const f = premultiply(cropImage(img, g)), t = new Float32Array(f.length), k = Float64Array.of(0.25, 0.5, 0.25);
  convolveH(f, t, gw, gh, k, 1);
  convolveV(t, f, gw, gh, k, 1);
  const L = lumaPlane(img, g), d = img.data, W = img.width;
  for (let y = r.y; y < r.y + r.height; y++) {
    let i = (y * W + r.x) * 4, fi = ((y - g.y) * gw + (r.x - g.x)) * 4;
    for (let x = r.x; x < r.x + r.width; x++, i += 4, fi += 4) {
      const fa = f[fi + 3];
      if (d[i + 3] === 0 || !(fa > 0)) continue;
      const keep = smoothstep(8, 32, sobelMag(L, gw, gh, x - g.x, y - g.y)), s = (255 / fa) * (1 - keep);
      d[i] = round8(d[i] * keep + f[fi] * s);
      d[i + 1] = round8(d[i + 1] * keep + f[fi + 1] * s);
      d[i + 2] = round8(d[i + 2] * keep + f[fi + 2] * s);
    }
  }
  return img;
}

/** Edge-preserving smoothing: a surface blur whose radius and threshold grow with strength 0..10. */
function reduceNoise(img, p, rect) {
  const r = region(img, rect);
  const strength = clampNum(num(p.strength, 0), 0, 10);
  if (isEmpty(r) || !(strength > 0)) return img;
  const rad = 1 + Math.round(strength / 4);
  storeOut(img, r, surfaceBlurCore(img, r, rad, 2 + strength * 3.5));
  return img;
}

// ---------------------------------------------------------------------------------------------
// Pixelate

function mosaic(img, p, rect) {
  const r = region(img, rect);
  const s = Math.round(clampNum(num(p.size, 1), 1, 1000));
  if (isEmpty(r) || s < 2) return img;
  const d = img.data, W = img.width, H = img.height;
  const rx2 = r.x + r.width, ry2 = r.y + r.height;
  // cells are aligned to the image origin; each cell averages all of its pixels (premultiplied)
  for (let cy = Math.floor(r.y / s) * s; cy < ry2; cy += s) {
    const cy2 = Math.min(H, cy + s), wy1 = Math.max(cy, r.y), wy2 = Math.min(cy2, ry2);
    for (let cx = Math.floor(r.x / s) * s; cx < rx2; cx += s) {
      const cx2 = Math.min(W, cx + s);
      let sr = 0, sg = 0, sb = 0, sa = 0;
      for (let y = cy; y < cy2; y++) {
        for (let x = cx, i = (y * W + cx) * 4; x < cx2; x++, i += 4) {
          const a = d[i + 3];
          sr += d[i] * a;
          sg += d[i + 1] * a;
          sb += d[i + 2] * a;
          sa += a;
        }
      }
      const n = (cy2 - cy) * (cx2 - cx);
      const R = sa > 0 ? round8(sr / sa) : 0, G = sa > 0 ? round8(sg / sa) : 0, B = sa > 0 ? round8(sb / sa) : 0, A = round8(sa / n);
      const wx1 = Math.max(cx, r.x), wx2 = Math.min(cx2, rx2);
      for (let y = wy1; y < wy2; y++) {
        for (let x = wx1, i = (y * W + wx1) * 4; x < wx2; x++, i += 4) {
          d[i] = R;
          d[i + 1] = G;
          d[i + 2] = B;
          d[i + 3] = A;
        }
      }
    }
  }
  return img;
}

/**
 * Voronoi cells for crystallize/pointillize: one seed per size x size grid cell (aligned to the
 * image origin, jittered by hash3(cell, seed)), and the premultiplied colour sums of every cell
 * that a pixel of r can belong to. A pixel's own seed is closer than 2 cells, so its nearest seed
 * lies within 2 cells of it: the seeds of r's pixels lie within 2 cells of r, their members within
 * 4, and the members' nearest-seed searches read seeds within 6.
 */
function voronoi(img, r, s, seed) {
  const W = img.width, H = img.height, d = img.data;
  const ci0 = Math.floor((r.x + 0.5) / s), ci1 = Math.floor((r.x + r.width - 0.5) / s);
  const cj0 = Math.floor((r.y + 0.5) / s), cj1 = Math.floor((r.y + r.height - 0.5) / s);
  const i0 = ci0 - 6, j0 = cj0 - 6, nx = ci1 - ci0 + 13, ny = cj1 - cj0 + 13;
  const sx = new Float64Array(nx * ny), sy = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const ci = i + i0, cj = j + j0, k = j * nx + i;
      sx[k] = (ci + hash3(ci, cj, seed) / U32) * s;
      sy[k] = (cj + hash3(ci, cj, seed ^ 0x5bd1e995) / U32) * s;
    }
  }
  const grid = { s, i0, j0, nx, sx, sy, acc: new Float64Array(nx * ny * 5), d2: 0 };
  // Pixels whose own cell is within 4 cells of r's cells: every member of a seed r can use.
  const ax0 = Math.max(0, Math.floor((ci0 - 4) * s) - 1), ax1 = Math.min(W, Math.ceil((ci1 + 5) * s) + 1);
  const ay0 = Math.max(0, Math.floor((cj0 - 4) * s) - 1), ay1 = Math.min(H, Math.ceil((cj1 + 5) * s) + 1);
  const acc = grid.acc;
  for (let y = ay0; y < ay1; y++) {
    const cj = Math.floor((y + 0.5) / s);
    if (cj < cj0 - 4 || cj > cj1 + 4) continue;
    for (let x = ax0, i = (y * W + ax0) * 4; x < ax1; x++, i += 4) {
      const ci = Math.floor((x + 0.5) / s);
      if (ci < ci0 - 4 || ci > ci1 + 4) continue;
      const k = nearestSeed(grid, x + 0.5, y + 0.5) * 5, a = d[i + 3];
      acc[k] += d[i] * a;
      acc[k + 1] += d[i + 1] * a;
      acc[k + 2] += d[i + 2] * a;
      acc[k + 3] += a;
      acc[k + 4] += 1;
    }
  }
  return grid;
}

/**
 * Index of the seed nearest to (px, py); grid.d2 gets the squared distance. The 3x3 cells around
 * the point are searched first; seeds further out are more than one cell size away, so the outer
 * ring of the 5x5 block (which always holds the nearest seed) is only searched when the best
 * distance so far exceeds the cell size.
 */
function nearestSeed(grid, px, py) {
  const s = grid.s, nx = grid.nx, sx = grid.sx, sy = grid.sy;
  const ci = Math.floor(px / s) - grid.i0, cj = Math.floor(py / s) - grid.j0;
  let best = 0, bd = Infinity;
  for (let dj = -1; dj <= 1; dj++) {
    const row = (cj + dj) * nx + ci;
    for (let di = -1; di <= 1; di++) {
      const k = row + di, dx = sx[k] - px, dy = sy[k] - py, dd = dx * dx + dy * dy;
      if (dd < bd) {
        bd = dd;
        best = k;
      }
    }
  }
  if (bd > s * s) {
    for (let dj = -2; dj <= 2; dj++) {
      const row = (cj + dj) * nx + ci, edge = dj === -2 || dj === 2;
      for (let di = -2; di <= 2; di += edge ? 1 : 4) {
        const k = row + di, dx = sx[k] - px, dy = sy[k] - py, dd = dx * dx + dy * dy;
        if (dd < bd) {
          bd = dd;
          best = k;
        }
      }
    }
  }
  grid.d2 = bd;
  return best;
}

/** Crystallize (dot = 0) or pointillize (dot = radius of the dots, white elsewhere). */
function cells(img, r, size, seed, dot) {
  const grid = voronoi(img, r, size, seed), acc = grid.acc, d = img.data, W = img.width, dot2 = dot * dot;
  for (let y = r.y; y < r.y + r.height; y++) {
    for (let x = r.x, i = (y * W + r.x) * 4; x < r.x + r.width; x++, i += 4) {
      const k = nearestSeed(grid, x + 0.5, y + 0.5) * 5;
      if (dot > 0 && grid.d2 > dot2) {
        d[i] = d[i + 1] = d[i + 2] = 255; // background (alpha kept)
        continue;
      }
      const sa = acc[k + 3];
      d[i] = sa > 0 ? round8(acc[k] / sa) : 0;
      d[i + 1] = sa > 0 ? round8(acc[k + 1] / sa) : 0;
      d[i + 2] = sa > 0 ? round8(acc[k + 2] / sa) : 0;
      d[i + 3] = round8(sa / acc[k + 4]);
    }
  }
  return img;
}

function crystallize(img, p, rect) {
  const r = region(img, rect);
  const size = clampNum(num(p.size, 10), 2, 1000);
  if (isEmpty(r)) return img;
  return cells(img, r, size, num(p.seed, 1) | 0, 0);
}

function pointillize(img, p, rect) {
  const r = region(img, rect);
  const size = clampNum(num(p.size, 5), 2, 1000);
  if (isEmpty(r)) return img;
  return cells(img, r, size, num(p.seed, 1) | 0, size * 0.5);
}

const FRAGMENT_DX = Int32Array.of(-4, 4, -4, 4), FRAGMENT_DY = Int32Array.of(-4, -4, 4, 4);

function fragment(img, _p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const d = img.data, W = img.width, H = img.height, out = new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = r.y, o = 0; y < r.y + r.height; y++) {
    for (let x = r.x; x < r.x + r.width; x++, o += 4) {
      let sr = 0, sg = 0, sb = 0, sa = 0;
      for (let t = 0; t < 4; t++) {
        let xx = x + FRAGMENT_DX[t], yy = y + FRAGMENT_DY[t];
        xx = xx < 0 ? 0 : xx >= W ? W - 1 : xx;
        yy = yy < 0 ? 0 : yy >= H ? H - 1 : yy;
        const i = (yy * W + xx) * 4, a = d[i + 3];
        sr += d[i] * a;
        sg += d[i + 1] * a;
        sb += d[i + 2] * a;
        sa += a;
      }
      if (sa > 0) {
        out[o] = round8(sr / sa);
        out[o + 1] = round8(sg / sa);
        out[o + 2] = round8(sb / sa);
      }
      out[o + 3] = round8(sa / 4);
    }
  }
  storeOut(img, r, out);
  return img;
}

// ---------------------------------------------------------------------------------------------
// Distort: inverse mapping (output pixel centre -> source position) with bilinear sampling. The
// edge mode decides what a source position outside the image yields: 'transparent' (default),
// 'repeat' (edge pixels) or 'wrap' (tiles).

const EDGE_TRANSPARENT = 0, EDGE_REPEAT = 1, EDGE_WRAP = 2;
const edgeMode = (v) => (v === 'repeat' ? EDGE_REPEAT : v === 'wrap' ? EDGE_WRAP : EDGE_TRANSPARENT);
const SMP = [0, 0, 0, 0];

/** Bilinear sample at pixel-index coordinates with a per-axis edge mode (straight alpha in out). */
function sampleEdge(img, fx, fy, mx, my, out) {
  const w = img.width, h = img.height;
  if (mx === EDGE_REPEAT) fx = fx < 0 ? 0 : fx > w - 1 ? w - 1 : fx;
  if (my === EDGE_REPEAT) fy = fy < 0 ? 0 : fy > h - 1 ? h - 1 : fy;
  if (mx !== EDGE_WRAP && my !== EDGE_WRAP) return sampleBilinear(img, fx, fy, out);
  out[0] = out[1] = out[2] = out[3] = 0;
  if (mx === EDGE_WRAP) {
    fx %= w;
    if (fx < 0) fx += w;
  } else if (fx <= -1 || fx >= w) return out;
  if (my === EDGE_WRAP) {
    fy %= h;
    if (fy < 0) fy += h;
  } else if (fy <= -1 || fy >= h) return out;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0, d = img.data;
  let r = 0, g = 0, b = 0, a = 0;
  for (let j = 0; j < 2; j++) {
    let yy = y0 + j;
    if (my === EDGE_WRAP) {
      if (yy >= h) yy -= h;
    } else if (yy < 0 || yy >= h) continue;
    const wy = j ? ty : 1 - ty;
    for (let i = 0; i < 2; i++) {
      let xx = x0 + i;
      if (mx === EDGE_WRAP) {
        if (xx >= w) xx -= w;
      } else if (xx < 0 || xx >= w) continue;
      const wgt = wy * (i ? tx : 1 - tx);
      if (!wgt) continue;
      const q = (yy * w + xx) * 4, pa = (d[q + 3] / 255) * wgt;
      r += d[q] * pa;
      g += d[q + 1] * pa;
      b += d[q + 2] * pa;
      a += pa;
    }
  }
  if (a > 0) {
    out[0] = r / a;
    out[1] = g / a;
    out[2] = b / a;
    out[3] = a * 255;
  }
  return out;
}

/** Stores the current sample into out[o..o+3]. */
function putSample(out, o) {
  out[o] = round8(SMP[0]);
  out[o + 1] = round8(SMP[1]);
  out[o + 2] = round8(SMP[2]);
  out[o + 3] = round8(SMP[3]);
}

function twirl(img, p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const A = clampNum(num(p.angle, 0), -3600, 3600) * DEG, mode = edgeMode(p.edge);
  const W = img.width, H = img.height, cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2;
  const out = new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = r.y, o = 0; y < r.y + r.height; y++) {
    const py = y + 0.5 - cy;
    for (let x = r.x; x < r.x + r.width; x++, o += 4) {
      const px = x + 0.5 - cx, dist = Math.sqrt(px * px + py * py);
      let sx = px, sy = py;
      if (dist < R && A !== 0) {
        const t = 1 - dist / R, th = -A * t * t, c = Math.cos(th), s = Math.sin(th);
        sx = px * c - py * s;
        sy = px * s + py * c;
      }
      sampleEdge(img, sx + cx - 0.5, sy + cy - 0.5, mode, mode, SMP);
      putSample(out, o);
    }
  }
  storeOut(img, r, out);
  return img;
}

/** Shared loop of pinch and spherize: radial remap inside the ellipse inscribed in the image. */
function ellipseRemap(img, r, mode, kind, a) {
  const W = img.width, H = img.height, cx = W / 2, cy = H / 2, ax = W / 2, ay = H / 2;
  const out = new Uint8ClampedArray(r.width * r.height * 4), absA = Math.abs(a);
  for (let y = r.y, o = 0; y < r.y + r.height; y++) {
    const py = y + 0.5 - cy, v = py / ay;
    for (let x = r.x; x < r.x + r.width; x++, o += 4) {
      const px = x + 0.5 - cx, u = px / ax, rr = Math.sqrt(u * u + v * v);
      let k = 1;
      if (rr < 1 && rr > 0 && a !== 0) {
        if (kind === 0) k = Math.pow(Math.sin((Math.PI / 2) * rr), -a); // pinch
        else {
          const target = a > 0 ? Math.asin(rr) / (Math.PI / 2) : Math.sin((Math.PI / 2) * rr); // spherize
          k = (rr + absA * (target - rr)) / rr;
        }
      }
      sampleEdge(img, px * k + cx - 0.5, py * k + cy - 0.5, mode, mode, SMP);
      putSample(out, o);
    }
  }
  storeOut(img, r, out);
  return img;
}

function pinch(img, p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  // 0.85 keeps the centre of a 100% pinch from collapsing into a singular point
  return ellipseRemap(img, r, edgeMode(p.edge), 0, (clampNum(num(p.amount, 0), -100, 100) / 100) * 0.85);
}

function spherize(img, p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  return ellipseRemap(img, r, edgeMode(p.edge), 1, clampNum(num(p.amount, 0), -100, 100) / 100);
}

/** Shared loop of ripple and wave: dx depends on the row, dy on the column. */
function axisRemap(img, r, mode, rowDx, colDy) {
  const out = new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = r.y, o = 0; y < r.y + r.height; y++) {
    const dx = rowDx[y - r.y];
    for (let x = r.x; x < r.x + r.width; x++, o += 4) {
      sampleEdge(img, x + dx, y + colDy[x - r.x], mode, mode, SMP);
      putSample(out, o);
    }
  }
  storeOut(img, r, out);
  return img;
}

const RIPPLE_WAVELENGTH = { small: 6, medium: 12, large: 24 };

function ripple(img, p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const lam = RIPPLE_WAVELENGTH[p.size] || RIPPLE_WAVELENGTH.medium;
  const A = (clampNum(num(p.amount, 0), -999, 999) / 100) * lam * 0.3;
  const rowDx = new Float64Array(r.height), colDy = new Float64Array(r.width);
  for (let y = 0; y < r.height; y++) rowDx[y] = A * Math.sin((TAU * (r.y + y + 0.5)) / lam);
  for (let x = 0; x < r.width; x++) colDy[x] = A * Math.sin((TAU * (r.x + x + 0.5)) / lam + 1.3);
  return axisRemap(img, r, edgeMode(p.edge), rowDx, colDy);
}

/** Periodic wave of period 1 in -1..1 with the phase of sin(2 pi t). */
function waveShape(type, t) {
  const s = Math.sin(TAU * t);
  if (type === 'square') return s > 1e-12 ? 1 : s < -1e-12 ? -1 : 0;
  if (type === 'triangle') return (2 / Math.PI) * Math.asin(clampNum(s, -1, 1));
  return s;
}

function wave(img, p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const amp = clampNum(num(p.amplitude, 0), -10000, 10000), lam = clampNum(num(p.wavelength, 120), 1, 100000);
  const type = p.type === 'triangle' || p.type === 'square' ? p.type : 'sine';
  const rowDx = new Float64Array(r.height), colDy = new Float64Array(r.width);
  for (let y = 0; y < r.height; y++) rowDx[y] = amp * waveShape(type, (r.y + y + 0.5) / lam);
  for (let x = 0; x < r.width; x++) colDy[x] = amp * waveShape(type, (r.x + x + 0.5) / lam);
  return axisRemap(img, r, edgeMode(p.edge), rowDx, colDy);
}

function zigzag(img, p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const amount = clampNum(num(p.amount, 0), -100, 100) / 100, ridges = clampNum(num(p.ridges, 5), 1, 50), mode = edgeMode(p.edge);
  const W = img.width, H = img.height, cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2;
  const amp = amount * (R / ridges) * 0.5; // pond ripples: radial displacement fading to 0 at the rim
  const out = new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = r.y, o = 0; y < r.y + r.height; y++) {
    const py = y + 0.5 - cy;
    for (let x = r.x; x < r.x + r.width; x++, o += 4) {
      const px = x + 0.5 - cx, dist = Math.sqrt(px * px + py * py);
      let k = 1;
      if (dist < R && dist > 0 && amp !== 0) {
        const t = dist / R, fade = (1 - t) * (1 - t);
        k = (dist + amp * Math.sin(TAU * ridges * t) * fade) / dist;
      }
      sampleEdge(img, px * k + cx - 0.5, py * k + cy - 0.5, mode, mode, SMP);
      putSample(out, o);
    }
  }
  storeOut(img, r, out);
  return img;
}

function polar(img, p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const toPolar = p.toPolar !== false, mode = edgeMode(p.edge);
  const W = img.width, H = img.height, cx = W / 2, cy = H / 2;
  const out = new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = r.y, o = 0; y < r.y + r.height; y++) {
    const py = y + 0.5;
    for (let x = r.x; x < r.x + r.width; x++, o += 4) {
      const px = x + 0.5;
      if (toPolar) {
        // the source's top row becomes the centre, its bottom row the inscribed ellipse; x is the angle (clockwise from 12 o'clock)
        const u = (px - cx) / (W / 2), v = (py - cy) / (H / 2);
        let th = Math.atan2(u, -v);
        if (th < 0) th += TAU;
        sampleEdge(img, (th / TAU) * W - 0.5, Math.sqrt(u * u + v * v) * H - 0.5, EDGE_WRAP, mode, SMP);
      } else {
        const th = (px / W) * TAU, rho = py / H;
        sampleEdge(img, cx + rho * Math.sin(th) * (W / 2) - 0.5, cy - rho * Math.cos(th) * (H / 2) - 0.5, mode, mode, SMP);
      }
      putSample(out, o);
    }
  }
  storeOut(img, r, out);
  return img;
}

function shear(img, p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const pts = (Array.isArray(p.points) ? p.points : [])
    .filter((q) => q && Number.isFinite(q[0]) && Number.isFinite(q[1]))
    .map((q) => [clampNum(q[0], 0, 1), clampNum(q[1], -1, 1)])
    .sort((a, b) => a[0] - b[0]);
  const W = img.width, H = img.height;
  const rowDx = new Float64Array(r.height), colDy = new Float64Array(r.width);
  if (pts.length) {
    for (let y = 0; y < r.height; y++) {
      const t = (r.y + y + 0.5) / H;
      let v;
      if (t <= pts[0][0]) v = pts[0][1];
      else if (t >= pts[pts.length - 1][0]) v = pts[pts.length - 1][1];
      else {
        let k = 1;
        while (pts[k][0] < t) k++;
        const [y0, v0] = pts[k - 1], [y1, v1] = pts[k];
        v = y1 > y0 ? v0 + ((v1 - v0) * (t - y0)) / (y1 - y0) : v1;
      }
      rowDx[y] = (-v * W) / 2; // dx = 1 moves the row right by half the width
    }
  }
  return axisRemap(img, r, edgeMode(p.edge), rowDx, colDy);
}

function offset(img, p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const W = img.width, H = img.height, d = img.data;
  const dx = Math.round(num(p.dx, 0)), dy = Math.round(num(p.dy, 0));
  const mode = p.wrap ? EDGE_WRAP : edgeMode(p.edge);
  const out = new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = r.y, o = 0; y < r.y + r.height; y++) {
    let sy = y - dy;
    if (mode === EDGE_WRAP) sy = ((sy % H) + H) % H;
    else if (mode === EDGE_REPEAT) sy = sy < 0 ? 0 : sy >= H ? H - 1 : sy;
    for (let x = r.x; x < r.x + r.width; x++, o += 4) {
      let sx = x - dx;
      if (mode === EDGE_WRAP) sx = ((sx % W) + W) % W;
      else if (mode === EDGE_REPEAT) sx = sx < 0 ? 0 : sx >= W ? W - 1 : sx;
      if (sx < 0 || sx >= W || sy < 0 || sy >= H) continue; // transparent
      const i = (sy * W + sx) * 4;
      out[o] = d[i];
      out[o + 1] = d[i + 1];
      out[o + 2] = d[i + 2];
      out[o + 3] = d[i + 3];
    }
  }
  storeOut(img, r, out);
  return img;
}

// ---------------------------------------------------------------------------------------------
// Stylize

function emboss(img, p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const ang = num(p.angle, 135) * DEG, height = clampNum(num(p.height, 3), 1, 100), amt = clampNum(num(p.amount, 100), 0, 500) / 100;
  // samples height px apart along the light direction (counter-clockwise from 3 o'clock, y down)
  const ux = (Math.cos(ang) * height) / 2, uy = (-Math.sin(ang) * height) / 2;
  const d = img.data, W = img.width, out = new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = r.y, o = 0; y < r.y + r.height; y++) {
    for (let x = r.x, i = (y * W + r.x) * 4; x < r.x + r.width; x++, i += 4, o += 4) {
      const lc = luminance(d[i], d[i + 1], d[i + 2]);
      sampleEdge(img, x - ux, y - uy, EDGE_REPEAT, EDGE_REPEAT, SMP);
      const away = SMP[3] > 0 ? luminance(SMP[0], SMP[1], SMP[2]) : lc;
      sampleEdge(img, x + ux, y + uy, EDGE_REPEAT, EDGE_REPEAT, SMP);
      const toward = SMP[3] > 0 ? luminance(SMP[0], SMP[1], SMP[2]) : lc;
      out[o] = out[o + 1] = out[o + 2] = round8(128 + (away - toward) * amt);
      out[o + 3] = d[i + 3];
    }
  }
  storeOut(img, r, out);
  return img;
}

/**
 * Per-channel Sobel with taps `spacing` px apart (transparent neighbours count as the centre).
 * invert: 255 - magnitude (find edges, dark lines on white); otherwise magnitude * gain (glowing edges). Alpha kept.
 */
function sobelFilter(img, rect, spacing, gain, invert) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const s = spacing;
  const dx = Int32Array.of(-s, 0, s, -s, s, -s, 0, s), dy = Int32Array.of(-s, -s, -s, 0, 0, s, s, s);
  const taps = new Int32Array(8), d = img.data, W = img.width, H = img.height;
  const out = new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = r.y, o = 0; y < r.y + r.height; y++) {
    for (let x = r.x, i = (y * W + r.x) * 4; x < r.x + r.width; x++, i += 4, o += 4) {
      gather(d, W, H, x, y, dx, dy, 8, taps);
      for (let c = 0; c < 3; c++) {
        const t0 = d[taps[0] + c], t1 = d[taps[1] + c], t2 = d[taps[2] + c], t3 = d[taps[3] + c];
        const t4 = d[taps[4] + c], t5 = d[taps[5] + c], t6 = d[taps[6] + c], t7 = d[taps[7] + c];
        const gx = t2 + 2 * t4 + t7 - (t0 + 2 * t3 + t5), gy = t5 + 2 * t6 + t7 - (t0 + 2 * t1 + t2);
        const mag = Math.sqrt(gx * gx + gy * gy) * 0.25;
        out[o + c] = invert ? round8(255 - mag * gain) : round8(mag * gain);
      }
      out[o + 3] = d[i + 3];
    }
  }
  storeOut(img, r, out);
  return img;
}

const SOLARIZE_LUT = makeLut((v) => (v > 127 ? 255 - v : v));

const DIFFUSE_DX = Int32Array.of(-1, 0, 1, -1, 1, -1, 0, 1), DIFFUSE_DY = Int32Array.of(-1, -1, -1, 0, 0, 1, 1, 1);

function diffuse(img, p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const m = p.mode;
  const mode = m === 'darken' || m === 'darken-only' ? 1 : m === 'lighten' || m === 'lighten-only' ? 2 : m === 'anisotropic' ? 3 : 0;
  const seed = num(p.seed, 1) | 0, d = img.data, W = img.width, H = img.height;
  const out = new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = r.y, o = 0; y < r.y + r.height; y++) {
    const rnd = randomSeeded(rowSeed(seed, 0x2545f491, y));
    for (let k = r.x; k > 0; k--) rnd();
    for (let x = r.x; x < r.x + r.width; x++, o += 4) {
      const ci = (y * W + x) * 4;
      const k = (rnd() * 8) | 0;
      let src = ci;
      if (mode === 3) {
        // anisotropic: move towards the neighbour that changes least
        const lc = luminance(d[ci], d[ci + 1], d[ci + 2]);
        let best = Infinity;
        for (let t = 0; t < 8; t++) {
          const xx = x + DIFFUSE_DX[t], yy = y + DIFFUSE_DY[t];
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const ni = (yy * W + xx) * 4, diff = Math.abs(luminance(d[ni], d[ni + 1], d[ni + 2]) - lc);
          if (diff < best) {
            best = diff;
            src = ni;
          }
        }
      } else {
        let xx = x + DIFFUSE_DX[k], yy = y + DIFFUSE_DY[k];
        xx = xx < 0 ? 0 : xx >= W ? W - 1 : xx;
        yy = yy < 0 ? 0 : yy >= H ? H - 1 : yy;
        const ni = (yy * W + xx) * 4;
        if (mode === 0) src = ni;
        else {
          const ln = luminance(d[ni], d[ni + 1], d[ni + 2]), lc = luminance(d[ci], d[ci + 1], d[ci + 2]);
          if (mode === 1 ? ln < lc : ln > lc) src = ni;
        }
      }
      out[o] = d[src];
      out[o + 1] = d[src + 1];
      out[o + 2] = d[src + 2];
      out[o + 3] = d[src + 3];
    }
  }
  storeOut(img, r, out);
  return img;
}

/** Adds/removes one window column to the oil-paint intensity bins (alpha-weighted counts and colour sums). */
function oilColumn(d, W, x, y0, y1, bins, g, cnt, sums, s) {
  const step = W * 4;
  for (let y = y0, i = (y0 * W + x) * 4; y <= y1; y++, i += step) {
    const a = d[i + 3] * s;
    if (a === 0) continue;
    const b = bins[(y - g.y) * g.width + (x - g.x)];
    cnt[b] += a;
    sums[b * 3] += d[i] * a;
    sums[b * 3 + 1] += d[i + 1] * a;
    sums[b * 3 + 2] += d[i + 2] * a;
  }
}

function oilPaint(img, p, rect) {
  const r = region(img, rect);
  const rad = Math.round(clampNum(num(p.radius, 4), 0, 100));
  if (isEmpty(r) || rad < 1) return img;
  const levels = Math.round(clampNum(num(p.levels, 20), 2, 256));
  const W = img.width, H = img.height, d = img.data, g = grow(img, r, rad);
  const bins = new Uint8Array(g.width * g.height);
  for (let y = 0, o = 0; y < g.height; y++) {
    for (let x = 0, i = ((g.y + y) * W + g.x) * 4; x < g.width; x++, i += 4, o++) {
      bins[o] = (((luminance(d[i], d[i + 1], d[i + 2]) + 0.5) | 0) * levels) >> 8;
    }
  }
  const cnt = new Int32Array(levels), sums = new Float64Array(levels * 3);
  const out = new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = r.y, o = 0; y < r.y + r.height; y++) {
    const y0 = y - rad < 0 ? 0 : y - rad, y1 = y + rad >= H ? H - 1 : y + rad;
    cnt.fill(0);
    sums.fill(0);
    for (let xx = Math.max(0, r.x - rad), xe = Math.min(W - 1, r.x + rad); xx <= xe; xx++) oilColumn(d, W, xx, y0, y1, bins, g, cnt, sums, 1);
    for (let x = r.x, i = (y * W + r.x) * 4; x < r.x + r.width; x++, i += 4, o += 4) {
      let best = 0;
      for (let b = 1; b < levels; b++) if (cnt[b] > cnt[best]) best = b;
      const c = cnt[best];
      if (c > 0) {
        out[o] = round8(sums[best * 3] / c);
        out[o + 1] = round8(sums[best * 3 + 1] / c);
        out[o + 2] = round8(sums[best * 3 + 2] / c);
      } else {
        out[o] = d[i];
        out[o + 1] = d[i + 1];
        out[o + 2] = d[i + 2];
      }
      out[o + 3] = d[i + 3];
      if (x - rad >= 0) oilColumn(d, W, x - rad, y0, y1, bins, g, cnt, sums, -1);
      if (x + rad + 1 < W) oilColumn(d, W, x + rad + 1, y0, y1, bins, g, cnt, sums, 1);
    }
  }
  storeOut(img, r, out);
  return img;
}

// ---------------------------------------------------------------------------------------------
// Render

/** Value-noise contrast stretch: fractal sums cluster around 0.5. */
const CLOUD_CONTRAST = 2;

/**
 * Fractal value noise for rect r in absolute image coordinates: octave o has wavelength
 * scale / 2^o (down to ~1 px) and amplitude 1 / 2^o, lattice values hash3(ix, iy, seed, o),
 * smoothstep interpolation. Returns an r-sized RGBA buffer blending c0 (t = 0) to c1 (t = 1).
 */
function renderClouds(r, seed, scale, c0, c1) {
  const octaves = [];
  let total = 0;
  for (let o = 0, lam = scale, amp = 1; o < 12 && lam >= 1; o++, lam /= 2, amp /= 2) {
    const ix0 = Math.floor((r.x + 0.5) / lam), n = Math.floor((r.x + r.width - 0.5) / lam) - ix0 + 2;
    const colIx = new Int32Array(r.width), colT = new Float32Array(r.width);
    for (let x = 0; x < r.width; x++) {
      const fx = (r.x + x + 0.5) / lam, ix = Math.floor(fx), t = fx - ix;
      colIx[x] = ix - ix0;
      colT[x] = t * t * (3 - 2 * t);
    }
    octaves.push({ lam, amp, ix0, n, colIx, colT, salt: (seed + Math.imul(o + 1, 0x632be5ab)) | 0, iy: NaN, a: new Float32Array(n), b: new Float32Array(n) });
    total += amp;
  }
  const acc = new Float32Array(r.width), out = new Uint8ClampedArray(r.width * r.height * 4);
  const dr = c1[0] - c0[0], dg = c1[1] - c0[1], db = c1[2] - c0[2], a0 = c0[3] * 255, da = (c1[3] - c0[3]) * 255;
  for (let y = 0, o = 0; y < r.height; y++) {
    acc.fill(0);
    for (const oc of octaves) {
      const fy = (r.y + y + 0.5) / oc.lam, iy = Math.floor(fy), t = fy - iy, ty = t * t * (3 - 2 * t);
      if (iy !== oc.iy) {
        oc.iy = iy;
        for (let c = 0; c < oc.n; c++) {
          oc.a[c] = hash3(oc.ix0 + c, iy, oc.salt) / U32;
          oc.b[c] = hash3(oc.ix0 + c, iy + 1, oc.salt) / U32;
        }
      }
      const A = oc.a, B = oc.b, colIx = oc.colIx, colT = oc.colT, amp = oc.amp;
      for (let x = 0; x < r.width; x++) {
        const ix = colIx[x], tx = colT[x];
        const top = A[ix] + (A[ix + 1] - A[ix]) * tx, bot = B[ix] + (B[ix + 1] - B[ix]) * tx;
        acc[x] += amp * (top + (bot - top) * ty);
      }
    }
    for (let x = 0; x < r.width; x++, o += 4) {
      const t = clampNum((acc[x] / total - 0.5) * CLOUD_CONTRAST + 0.5, 0, 1);
      out[o] = round8(c0[0] + dr * t);
      out[o + 1] = round8(c0[1] + dg * t);
      out[o + 2] = round8(c0[2] + db * t);
      out[o + 3] = round8(a0 + da * t);
    }
  }
  return out;
}

/** [fg, bg] RGBA colours of the clouds params (colors: [fg, bg], fg/bg override). */
function cloudColors(p) {
  const cs = Array.isArray(p.colors) ? p.colors : [];
  return [parseColor(p.fg ?? cs[0] ?? '#000000', [0, 0, 0, 1]), parseColor(p.bg ?? cs[1] ?? '#ffffff', [255, 255, 255, 1])];
}

function clouds(img, p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const [c0, c1] = cloudColors(p);
  storeOut(img, r, renderClouds(r, num(p.seed, 1) | 0, clampNum(num(p.scale, 128), 1, 100000), c0, c1));
  return img;
}

function differenceClouds(img, p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const [c0, c1] = cloudColors(p);
  const cloudImg = { width: r.width, height: r.height, data: renderClouds(r, num(p.seed, 1) | 0, clampNum(num(p.scale, 128), 1, 100000), c0, c1) };
  const dst = cropImage(img, r);
  blendImages('difference', cloudImg, dst, 1);
  pasteImage(img, dst, r.x, r.y);
  return img;
}

// Lens-flare ghosts: [position along flare -> image centre (0 = flare, 1 = centre), radius / diagonal, intensity, r, g, b]
const FLARE_GHOSTS = [
  [0.45, 0.022, 0.2, 0.55, 0.8, 1],
  [0.8, 0.04, 0.12, 1, 0.65, 0.35],
  [1.3, 0.06, 0.09, 0.45, 1, 0.6],
  [1.75, 0.03, 0.16, 0.85, 0.5, 1],
];

function lensFlare(img, p, rect) {
  const r = region(img, rect);
  const k = clampNum(num(p.brightness, 100), 0, 300) / 100;
  if (isEmpty(r) || !(k > 0)) return img;
  const W = img.width, H = img.height, c = p.center || {}, D = Math.hypot(W, H);
  const fx = clampNum(num(c.x, 0.5), -2, 3) * W, fy = clampNum(num(c.y, 0.5), -2, 3) * H;
  const core2 = 2 * (0.03 * D) ** 2, halo = 0.12 * D, ringR = 0.11 * D, ringW = 0.007 * D;
  const ng = FLARE_GHOSTS.length, gx = new Float64Array(ng), gy = new Float64Array(ng), gr = new Float64Array(ng);
  for (let q = 0; q < ng; q++) {
    gx[q] = fx + FLARE_GHOSTS[q][0] * (W / 2 - fx);
    gy[q] = fy + FLARE_GHOSTS[q][0] * (H / 2 - fy);
    gr[q] = FLARE_GHOSTS[q][1] * D;
  }
  const d = img.data, s = 255 * k;
  for (let y = r.y; y < r.y + r.height; y++) {
    for (let x = r.x, i = (y * W + r.x) * 4; x < r.x + r.width; x++, i += 4) {
      const dx = x + 0.5 - fx, dy = y + 0.5 - fy, d2 = dx * dx + dy * dy, dist = Math.sqrt(d2);
      const glow = Math.exp(-d2 / core2) + 0.3 * Math.exp(-dist / halo);
      const rt = (dist - ringR) / ringW, ring = 0.22 * Math.exp(-rt * rt);
      let R = glow + ring, G = glow * 0.95 + ring * 0.75, B = glow * 0.85 + ring * 0.45;
      for (let q = 0; q < ng; q++) {
        const ex = x + 0.5 - gx[q], ey = y + 0.5 - gy[q], gd = Math.sqrt(ex * ex + ey * ey);
        if (gd >= gr[q]) continue;
        const e = FLARE_GHOSTS[q][2] * smoothstep(gr[q], gr[q] * 0.7, gd);
        R += e * FLARE_GHOSTS[q][3];
        G += e * FLARE_GHOSTS[q][4];
        B += e * FLARE_GHOSTS[q][5];
      }
      d[i] = round8(d[i] + R * s);
      d[i + 1] = round8(d[i + 1] + G * s);
      d[i + 2] = round8(d[i + 2] + B * s);
    }
  }
  return img;
}

function vignette(img, p, rect) {
  const r = region(img, rect);
  const amount = clampNum(num(p.amount, 0), -100, 100) / 100;
  if (isEmpty(r) || amount === 0) return img;
  const size = clampNum(num(p.size, 0.5), 0, 1), roundness = clampNum(num(p.roundness, 0), -100, 100) / 100;
  const W = img.width, H = img.height, cx = W / 2, cy = H / 2;
  // roundness 0: ellipse fitted to the image; +100: circle of equal area; -100: rounded rectangle (superellipse ^8)
  const m = Math.sqrt(W * H) / 2, t = Math.max(0, roundness);
  const ax = W / 2 + (m - W / 2) * t, ay = H / 2 + (m - H / 2) * t, pe = roundness < 0 ? 2 - roundness * 6 : 2;
  const cu = new Float64Array(r.width), rv = new Float64Array(r.height);
  for (let x = 0; x < r.width; x++) cu[x] = Math.abs((r.x + x + 0.5 - cx) / ax) ** pe;
  for (let y = 0; y < r.height; y++) rv[y] = Math.abs((r.y + y + 0.5 - cy) / ay) ** pe;
  const dc = ((W / 2 / ax) ** pe + (H / 2 / ay) ** pe) ** (1 / pe); // corner distance -> 1
  const e1 = Math.max(1, size + 0.01), d = img.data;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0, i = ((r.y + y) * W + r.x) * 4; x < r.width; x++, i += 4) {
      const s = cu[x] + rv[y], dist = (pe === 2 ? Math.sqrt(s) : s ** (1 / pe)) / dc;
      const f = amount * smoothstep(size, e1, dist);
      if (f === 0) continue;
      for (let c = 0; c < 3; c++) d[i + c] = round8(f < 0 ? d[i + c] * (1 + f) : d[i + c] + (255 - d[i + c]) * f);
    }
  }
  return img;
}

// ---------------------------------------------------------------------------------------------
// Other

/** One line of the van Herk/Gil-Werman running max/min (window 2 rad + 1, edges as clipped windows). */
function vhgwLine(src, s0, ss, n, rad, isMax, dst, d0, ds, G, Hh, neutral) {
  const k = 2 * rad + 1, m = n + 2 * rad;
  for (let b = 0; b < m; b += k) {
    const end = b + k < m ? b + k : m;
    let acc = neutral;
    for (let e = b; e < end; e++) {
      const xi = e - rad, v = xi >= 0 && xi < n ? src[s0 + xi * ss] : neutral;
      if (isMax ? v > acc : v < acc) acc = v;
      G[e] = acc;
    }
    acc = neutral;
    for (let e = end - 1; e >= b; e--) {
      const xi = e - rad, v = xi >= 0 && xi < n ? src[s0 + xi * ss] : neutral;
      if (isMax ? v > acc : v < acc) acc = v;
      Hh[e] = acc;
    }
  }
  for (let x = 0; x < n; x++) {
    const a = Hh[x], c = G[x + 2 * rad];
    dst[d0 + x * ds] = isMax ? (a > c ? a : c) : a < c ? a : c;
  }
}

/** Maximum / minimum of each colour channel over a square window; transparent pixels do not vote, alpha kept. */
function morphology(img, p, rect, isMax) {
  const r = region(img, rect);
  const rad = Math.round(clampNum(num(p.radius, 1), 0, 500));
  if (isEmpty(r) || rad < 1) return img;
  const g = grow(img, r, rad), gw = g.width, gh = g.height, W = img.width, d = img.data;
  const neutral = isMax ? 0 : 255;
  const A = new Uint8Array(gw * gh * 3), B = new Uint8Array(gw * gh * 3);
  for (let y = 0, o = 0; y < gh; y++) {
    for (let x = 0, i = ((g.y + y) * W + g.x) * 4; x < gw; x++, i += 4, o += 3) {
      if (d[i + 3] === 0) A[o] = A[o + 1] = A[o + 2] = neutral;
      else {
        A[o] = d[i];
        A[o + 1] = d[i + 1];
        A[o + 2] = d[i + 2];
      }
    }
  }
  const len = Math.max(gw, gh) + 2 * rad, G = new Uint8Array(len), Hh = new Uint8Array(len), row = gw * 3;
  for (let y = 0; y < gh; y++) for (let c = 0; c < 3; c++) vhgwLine(A, y * row + c, 3, gw, rad, isMax, B, y * row + c, 3, G, Hh, neutral);
  for (let x = 0; x < gw; x++) for (let c = 0; c < 3; c++) vhgwLine(B, x * 3 + c, row, gh, rad, isMax, A, x * 3 + c, row, G, Hh, neutral);
  for (let y = r.y; y < r.y + r.height; y++) {
    let o = ((y - g.y) * gw + (r.x - g.x)) * 3;
    for (let x = r.x, i = (y * W + r.x) * 4; x < r.x + r.width; x++, i += 4, o += 3) {
      if (d[i + 3] === 0) continue;
      d[i] = A[o];
      d[i + 1] = A[o + 1];
      d[i + 2] = A[o + 2];
    }
  }
  return img;
}

function custom(img, p, rect) {
  const k = p.kernel;
  const n = k && typeof k.length === 'number' ? k.length : 0;
  if (n !== 9 && n !== 25) throw new RangeError('custom filter kernel must have 9 (3x3) or 25 (5x5) entries');
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const size = n === 25 ? 5 : 3, half = size >> 1;
  const scale = num(p.scale, 1) || 1, off = num(p.offset, 0);
  // only the non-zero taps are visited
  const wts = [], dxs = [], dys = [];
  for (let t = 0; t < n; t++) {
    const v = num(k[t], 0);
    if (v === 0) continue;
    wts.push(v / scale);
    dxs.push((t % size) - half);
    dys.push(Math.floor(t / size) - half);
  }
  const nt = wts.length, kw = Float64Array.from(wts), dx = Int32Array.from(dxs), dy = Int32Array.from(dys), taps = new Int32Array(Math.max(1, nt));
  const d = img.data, W = img.width, H = img.height, out = new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = r.y, o = 0; y < r.y + r.height; y++) {
    for (let x = r.x, i = (y * W + r.x) * 4; x < r.x + r.width; x++, i += 4, o += 4) {
      gather(d, W, H, x, y, dx, dy, nt, taps);
      let sr = off, sg = off, sb = off;
      for (let t = 0; t < nt; t++) {
        const q = taps[t], wt = kw[t];
        sr += d[q] * wt;
        sg += d[q + 1] * wt;
        sb += d[q + 2] * wt;
      }
      out[o] = round8(sr);
      out[o + 1] = round8(sg);
      out[o + 2] = round8(sb);
      out[o + 3] = d[i + 3];
    }
  }
  storeOut(img, r, out);
  return img;
}

function invertAlpha(img, _p, rect) {
  const r = region(img, rect), d = img.data, W = img.width;
  for (let y = r.y; y < r.y + r.height; y++) {
    for (let x = r.x, i = (y * W + r.x) * 4 + 3; x < r.x + r.width; x++, i += 4) d[i] = 255 - d[i];
  }
  return img;
}

// ---------------------------------------------------------------------------------------------
// Catalogue

function kind(name, category, defaults, fn) {
  const frozen = freezeDeep(defaults);
  return Object.freeze({
    name,
    category,
    defaults: frozen,
    apply(img, params, rect = null) {
      return fn(img, merge(frozen, params), rect);
    },
  });
}

/**
 * Every filter kind, keyed by id: { name, category, defaults, apply(img, params?, rect?) }.
 * apply() merges params over defaults, edits img in place inside rect (default: whole image) and
 * returns it. Parameters (units in brackets):
 *
 * blur
 * - gaussian-blur { radius 0.1..1000 (sigma, px) }: separable, premultiplied, kernel +-3 sigma;
 *   radius > 20 uses three exact-variance box passes (running sums).
 * - box-blur { radius px (fractional ok) }: (2 radius + 1)^2 average.
 * - motion-blur { angle deg (counter-clockwise from horizontal), distance px }: line kernel of length distance.
 * - radial-blur { amount 0..100, method 'spin'|'zoom', center {x, y} 0..1 }: spin arc = amount degrees,
 *   zoom scales the image by e^(+-0.4 amount / 100) about the centre.
 * - surface-blur { radius px, threshold 1..255 }: Photoshop's 1 - |dv| / (2.5 threshold) weights; alpha kept.
 * sharpen (colour only, alpha kept)
 * - sharpen { amount % }: unsharp mask radius 1.
 * - unsharp-mask { amount %, radius px, threshold 0..255 }.
 * - smart-sharpen { amount %, radius px, reduceNoise 0..100 }: unsharp mask weighted by edge strength.
 * - high-pass { radius px }: colour - gaussian + 128.
 * noise
 * - add-noise { amount 0..400 %, distribution 'uniform'|'gaussian', monochromatic, seed }.
 * - median { radius px }, dust-scratches { radius px, threshold 0..255 }: median (alpha included);
 *   dust & scratches only replaces pixels that differ from the median by more than threshold.
 * - despeckle {}: 3x3 blur except on edges. reduce-noise { strength 0..10 }: edge-preserving surface blur.
 * pixelate
 * - mosaic { size px }: cells aligned to the image origin. crystallize { size px, seed }: Voronoi
 *   cells averaged. pointillize { size px, seed }: cell-coloured dots on white. fragment {}: average of
 *   four copies offset by (+-4, +-4).
 * distort (every kind also takes edge 'transparent'|'repeat'|'wrap', default 'transparent')
 * - twirl { angle deg }: rotation falling off as (1 - d / R)^2 inside the inscribed circle.
 * - pinch { amount -100..100 }, spherize { amount -100..100 }: inside the inscribed ellipse.
 * - ripple { amount -999..999, size 'small'|'medium'|'large' }. wave { amplitude px, wavelength px,
 *   type 'sine'|'triangle'|'square' }. zigzag { amount -100..100, ridges } (pond ripples).
 * - polar { toPolar }: rectangular -> polar (true) or back (false).
 * - shear { points: [[y 0..1, dx -1..1], ...] }: rows move right by dx * width / 2, linear between points.
 * - offset { dx px, dy px, wrap }: integer shift; wrap tiles, otherwise edge applies.
 * stylize
 * - emboss { angle deg, height px, amount 0..500 % }: grey relief, alpha kept.
 * - find-edges {}: per-channel Sobel, dark edges on white. solarize {}: v > 127 -> 255 - v.
 * - diffuse { mode 'normal'|'darken'|'lighten'|'anisotropic', seed }: pixels swap with a random neighbour.
 * - oil-paint { radius px, levels 2..256 }: most common intensity bin of the window, averaged.
 * - glowing-edges { width px, brightness 0..20 }: bright Sobel edges on black.
 * render
 * - clouds { seed, scale px (largest feature), colors: [fg, bg] '#rrggbb' (fg/bg also accepted) }: opaque.
 * - difference-clouds: clouds composited with 'difference' over the image.
 * - lens-flare { center {x, y} 0..1, brightness 0..300 % }: additive glow, ring and ghosts.
 * - vignette { amount -100..100 (negative darkens), size 0..1 (where the falloff starts), roundness -100..100 }.
 * other
 * - maximum / minimum { radius px }: square window per colour channel, alpha kept.
 * - custom { kernel: 9 or 25 numbers (row-major), scale, offset }: sum(kernel * pixel) / scale + offset.
 * - invert-alpha {}: alpha -> 255 - alpha.
 * @type {Readonly<Record<FilterKind, FilterDef>>}
 */
export const FILTERS = Object.freeze({
  // blur
  'gaussian-blur': kind('Gaussian Blur', 'blur', { radius: 2 }, gaussianBlur),
  'box-blur': kind('Box Blur', 'blur', { radius: 3 }, boxBlur),
  'motion-blur': kind('Motion Blur', 'blur', { angle: 0, distance: 10 }, motionBlur),
  'radial-blur': kind('Radial Blur', 'blur', { amount: 10, method: 'spin', center: { x: 0.5, y: 0.5 } }, radialBlur),
  'surface-blur': kind('Surface Blur', 'blur', { radius: 5, threshold: 15 }, surfaceBlur),
  // sharpen
  sharpen: kind('Sharpen', 'sharpen', { amount: 50 }, (img, p, rect) => unsharp(img, rect, clampNum(num(p.amount, 50), 0, 500), 1, 0, null)),
  'unsharp-mask': kind('Unsharp Mask', 'sharpen', { amount: 100, radius: 1, threshold: 0 }, (img, p, rect) =>
    unsharp(img, rect, clampNum(num(p.amount, 100), 0, 500), clampNum(num(p.radius, 1), 0, 1000), clampNum(num(p.threshold, 0), 0, 255), null)),
  'smart-sharpen': kind('Smart Sharpen', 'sharpen', { amount: 100, radius: 1, reduceNoise: 10 }, (img, p, rect) =>
    unsharp(img, rect, clampNum(num(p.amount, 100), 0, 500), clampNum(num(p.radius, 1), 0, 1000), 0, clampNum(num(p.reduceNoise, 10), 0, 100))),
  'high-pass': kind('High Pass', 'sharpen', { radius: 10 }, highPass),
  // noise
  'add-noise': kind('Add Noise', 'noise', { amount: 12.5, distribution: 'uniform', monochromatic: false, seed: 1 }, addNoise),
  median: kind('Median', 'noise', { radius: 1 }, median),
  despeckle: kind('Despeckle', 'noise', {}, despeckle),
  'dust-scratches': kind('Dust & Scratches', 'noise', { radius: 1, threshold: 0 }, dustScratches),
  'reduce-noise': kind('Reduce Noise', 'noise', { strength: 6 }, reduceNoise),
  // pixelate
  mosaic: kind('Mosaic', 'pixelate', { size: 10 }, mosaic),
  crystallize: kind('Crystallize', 'pixelate', { size: 10, seed: 1 }, crystallize),
  pointillize: kind('Pointillize', 'pixelate', { size: 5, seed: 1 }, pointillize),
  fragment: kind('Fragment', 'pixelate', {}, fragment),
  // distort
  twirl: kind('Twirl', 'distort', { angle: 50, edge: 'transparent' }, twirl),
  pinch: kind('Pinch', 'distort', { amount: 50, edge: 'transparent' }, pinch),
  spherize: kind('Spherize', 'distort', { amount: 100, edge: 'transparent' }, spherize),
  ripple: kind('Ripple', 'distort', { amount: 100, size: 'medium', edge: 'transparent' }, ripple),
  wave: kind('Wave', 'distort', { amplitude: 10, wavelength: 120, type: 'sine', edge: 'transparent' }, wave),
  zigzag: kind('ZigZag', 'distort', { amount: 10, ridges: 5, edge: 'transparent' }, zigzag),
  polar: kind('Polar Coordinates', 'distort', { toPolar: true, edge: 'transparent' }, polar),
  shear: kind('Shear', 'distort', { points: [[0, 0], [1, 0]], edge: 'transparent' }, shear),
  offset: kind('Offset', 'distort', { dx: 0, dy: 0, wrap: true, edge: 'transparent' }, offset),
  // stylize
  emboss: kind('Emboss', 'stylize', { angle: 135, height: 3, amount: 100 }, emboss),
  'find-edges': kind('Find Edges', 'stylize', {}, (img, _p, rect) => sobelFilter(img, rect, 1, 1, true)),
  solarize: kind('Solarize', 'stylize', {}, (img, _p, rect) => applyLut(img, SOLARIZE_LUT, SOLARIZE_LUT, SOLARIZE_LUT, rect)),
  diffuse: kind('Diffuse', 'stylize', { mode: 'normal', seed: 1 }, diffuse),
  'oil-paint': kind('Oil Paint', 'stylize', { radius: 4, levels: 20 }, oilPaint),
  'glowing-edges': kind('Glowing Edges', 'stylize', { width: 2, brightness: 6 }, (img, p, rect) =>
    sobelFilter(img, rect, Math.max(1, Math.round(clampNum(num(p.width, 2), 1, 100) / 2)), clampNum(num(p.brightness, 6), 0, 20) / 4, false)),
  // render
  clouds: kind('Clouds', 'render', { seed: 1, scale: 128, colors: ['#000000', '#ffffff'] }, clouds),
  'difference-clouds': kind('Difference Clouds', 'render', { seed: 1, scale: 128, colors: ['#000000', '#ffffff'] }, differenceClouds),
  'lens-flare': kind('Lens Flare', 'render', { center: { x: 0.35, y: 0.35 }, brightness: 100 }, lensFlare),
  vignette: kind('Vignette', 'render', { amount: -50, size: 0.5, roundness: 0 }, vignette),
  // other
  maximum: kind('Maximum', 'other', { radius: 1 }, (img, p, rect) => morphology(img, p, rect, true)),
  minimum: kind('Minimum', 'other', { radius: 1 }, (img, p, rect) => morphology(img, p, rect, false)),
  custom: kind('Custom', 'other', { kernel: [0, -1, 0, -1, 5, -1, 0, -1, 0], scale: 1, offset: 0 }, custom),
  'invert-alpha': kind('Invert Alpha', 'other', {}, invertAlpha),
});

/** Every kind id, in menu order. @type {readonly FilterKind[]} */
export const FILTER_KINDS = Object.freeze(Object.keys(FILTERS));

const CATEGORY_NAMES = [
  ['blur', 'Blur'], ['sharpen', 'Sharpen'], ['noise', 'Noise'], ['pixelate', 'Pixelate'],
  ['distort', 'Distort'], ['stylize', 'Stylize'], ['render', 'Render'], ['other', 'Other'],
];

/**
 * Filter menu groups in order: { id, name, kinds } (kinds in menu order). Every kind appears once.
 * @type {ReadonlyArray<Readonly<{ id: FilterCategory, name: string, kinds: readonly FilterKind[] }>>}
 */
export const FILTER_CATEGORIES = Object.freeze(CATEGORY_NAMES.map(([id, name]) =>
  Object.freeze({ id, name, kinds: Object.freeze(FILTER_KINDS.filter((k) => FILTERS[k].category === id)) })));

/**
 * Applies one filter in place and returns img. params are merged over the kind's defaults.
 * Throws a RangeError for an unknown kind (or a malformed custom kernel).
 * @param {ImageDataLike} img
 * @param {FilterKind} kind
 * @param {object} [params]
 * @param {Rect | null} [rect] default: the whole image
 * @returns {ImageDataLike}
 */
export function applyFilter(img, kind, params = {}, rect = null) {
  const def = Object.prototype.hasOwnProperty.call(FILTERS, kind) ? FILTERS[kind] : null;
  if (!def) throw new RangeError(`Unknown filter: ${String(kind)}`);
  return def.apply(img, params, rect);
}
