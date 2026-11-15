// Edge refinement for selections (builder "select-mask"): the Edge Detection and Global Refinements of
// the Select and Mask workspace, and colour decontamination. Pure, no DOM.
//
//   refineEdge(img, mask, { radius, smartRadius, smooth, feather, contrast, shift, mode, extra })
//       a new mask (0..255). Inside a band of `radius` px around the mask edge (plus any `extra`
//       painted area: the Refine Edge Brush) alpha is re-estimated from the image: a guided filter
//       fitted on the pixels outside the band ("Object Aware") blended with a projection on the local
//       foreground / background colours ("Color Aware"). Outside the band the mask is kept as it is.
//       Then the Global Refinements run on the whole mask: Smooth, Feather, Contrast, Shift Edge.
//   edgeBand(img, mask, { radius, smartRadius, extra })     the band as flags (the Show Edge view)
//   decontaminate(img, alpha, amount)                        a copy of img whose partially selected pixels
//       take the colour of the nearest solid interior pixel, weighted by how transparent they are
//   boxMean, gaussianBlur, guidedFilter, minMaxFilter        the Float32 plane primitives behind them
//
// Conventions: masks are Uint8ClampedArray(w * h) 0..255, planes are Float32Array(w * h) 0..1, images
// are straight-alpha RGBA. Nothing outside the image is read: windows are clipped at the borders (a
// selection touching the canvas edge keeps touching it after Feather, unlike Select > Modify > Feather).

import { nearestSource } from './matting.js';

/** @typedef {import('./core.js').ImageDataLike} ImageDataLike */
/** @typedef {import('./core.js').Rect} Rect */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---- plane primitives ------------------------------------------------------------------------------------------------

/**
 * Mean over a (2r + 1)² window clipped at the borders, by running sums (cost independent of r).
 * dst may be src. tmp is scratch of the same size.
 */
export function boxMean(src, w, h, r, dst = new Float32Array(w * h), tmp = new Float32Array(w * h)) {
  r = Math.max(0, Math.floor(r));
  if (r === 0) {
    if (dst !== src) dst.set(src);
    return dst;
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    const first = Math.min(r, w - 1);
    for (let x = 0; x <= first; x++) sum += src[row + x];
    for (let x = 0; x < w; x++) {
      const lo = x - r, hi = x + r;
      tmp[row + x] = sum / ((hi < w ? hi : w - 1) - (lo > 0 ? lo : 0) + 1);
      if (hi + 1 < w) sum += src[row + hi + 1];
      if (lo >= 0) sum -= src[row + lo];
    }
  }
  const sums = new Float64Array(w);
  const first = Math.min(r, h - 1);
  for (let y = 0; y <= first; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) sums[x] += tmp[row + x];
  }
  for (let y = 0; y < h; y++) {
    const inv = 1 / (Math.min(y + r, h - 1) - Math.max(y - r, 0) + 1), row = y * w;
    for (let x = 0; x < w; x++) dst[row + x] = sums[x] * inv;
    if (y + r + 1 < h) {
      const add = (y + r + 1) * w;
      for (let x = 0; x < w; x++) sums[x] += tmp[add + x];
    }
    if (y - r >= 0) {
      const sub = (y - r) * w;
      for (let x = 0; x < w; x++) sums[x] -= tmp[sub + x];
    }
  }
  return dst;
}

/**
 * Gaussian blur of a plane, in place. Small sigmas use the kernel itself (three boxes cannot be made
 * that narrow: a 1 px feather would do nothing), larger ones three box passes sized for sigma. The
 * kernel is renormalised where the border clips it.
 */
export function gaussianBlur(plane, w, h, sigma, tmp = new Float32Array(w * h)) {
  if (!(sigma > 0.05)) return plane;
  if (sigma < 2.5) {
    const r = Math.max(1, Math.ceil(sigma * 3)), k = new Float32Array(r + 1);
    for (let i = 0; i <= r; i++) k[i] = Math.exp(-(i * i) / (2 * sigma * sigma));
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let sum = plane[row + x] * k[0], norm = k[0];
        for (let i = 1; i <= r; i++) {
          if (x - i >= 0) (sum += plane[row + x - i] * k[i]), (norm += k[i]);
          if (x + i < w) (sum += plane[row + x + i] * k[i]), (norm += k[i]);
        }
        tmp[row + x] = sum / norm;
      }
    }
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let sum = tmp[row + x] * k[0], norm = k[0];
        for (let i = 1; i <= r; i++) {
          if (y - i >= 0) (sum += tmp[row + x - i * w] * k[i]), (norm += k[i]);
          if (y + i < h) (sum += tmp[row + x + i * w] * k[i]), (norm += k[i]);
        }
        plane[row + x] = sum / norm;
      }
    }
    return plane;
  }
  // box widths whose three-fold convolution has the variance of the Gaussian (Kovesi's "fast almost-Gaussian")
  const ideal = Math.sqrt((12 * sigma * sigma) / 3 + 1);
  let wl = Math.floor(ideal);
  if (wl % 2 === 0) wl--;
  const m = Math.round((12 * sigma * sigma - 3 * wl * wl - 12 * wl - 9) / (-4 * wl - 4));
  for (let i = 0; i < 3; i++) boxMean(plane, w, h, ((i < m ? wl : wl + 2) - 1) / 2, plane, tmp);
  return plane;
}

/** Grey erosion (max = false) or dilation (max = true) with a (2r + 1)² square, separable, cost independent of r. */
export function minMaxFilter(src, w, h, r, max, dst = new Float32Array(w * h)) {
  r = Math.max(0, Math.floor(r));
  if (r === 0) {
    if (dst !== src) dst.set(src);
    return dst;
  }
  const tmp = new Float32Array(w * h);
  const line = new Float32Array(Math.max(w, h)), out = new Float32Array(Math.max(w, h));
  const idx = new Int32Array(Math.max(w, h));
  // monotonic-wedge sliding extremum over a 1D line
  const run = (n) => {
    let head = 0, tail = 0;
    for (let i = 0; i < n + r; i++) {
      if (i < n) {
        const v = line[i];
        while (tail > head && (max ? line[idx[tail - 1]] <= v : line[idx[tail - 1]] >= v)) tail--;
        idx[tail++] = i;
      }
      const c = i - r; // the window centred on c is [c - r, c + r] and is complete once i reaches c + r
      if (c >= 0) {
        while (idx[head] < c - r) head++;
        out[c] = line[idx[head]];
      }
    }
  };
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) line[x] = src[row + x];
    run(w);
    for (let x = 0; x < w; x++) tmp[row + x] = out[x];
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) line[y] = tmp[y * w + x];
    run(h);
    for (let y = 0; y < h; y++) dst[y * w + x] = out[y];
  }
  return dst;
}

/** Bilinear sample of a reduced plane (sw x sh, block size s) at full-resolution pixel (x, y) of the region. */
function sampleUp(plane, sw, sh, s, x, y) {
  if (s === 1) return plane[y * sw + x];
  const fx = (x + 0.5) / s - 0.5, fy = (y + 0.5) / s - 0.5;
  let x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  let x1 = x0 + 1, y1 = y0 + 1;
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  if (x1 > sw - 1) x1 = sw - 1;
  if (y1 > sh - 1) y1 = sh - 1;
  if (x0 > sw - 1) x0 = sw - 1;
  if (y0 > sh - 1) y0 = sh - 1;
  const a = plane[y0 * sw + x0], b = plane[y0 * sw + x1], c = plane[y1 * sw + x0], d = plane[y1 * sw + x1];
  return a + (b - a) * tx + (c + (d - c) * tx - a - (b - a) * tx) * ty;
}

/**
 * Reduces a region of the image (and of the planes given) by averaging s x s blocks.
 * @returns {{ sw: number, sh: number, r: Float32Array, g: Float32Array, b: Float32Array, planes: Float32Array[] }} colours 0..1
 */
function reduceRegion(img, rect, s, planes) {
  const { x: x0, y: y0, width: cw, height: ch } = rect;
  const W = img.width, d = img.data;
  const sw = Math.ceil(cw / s), sh = Math.ceil(ch / s), n = sw * sh;
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
  const outs = planes.map(() => new Float32Array(n));
  for (let sy = 0; sy < sh; sy++) {
    const ya = sy * s, yb = Math.min(ch, ya + s);
    for (let sx = 0; sx < sw; sx++) {
      const xa = sx * s, xb = Math.min(cw, xa + s);
      let sr = 0, sg = 0, sb = 0;
      const o = sy * sw + sx;
      for (let y = ya; y < yb; y++) {
        let p = (y0 + y) * W + x0 + xa, i = p * 4;
        for (let x = xa; x < xb; x++, p++, i += 4) {
          sr += d[i];
          sg += d[i + 1];
          sb += d[i + 2];
          for (let k = 0; k < planes.length; k++) outs[k][o] += planes[k][p];
        }
      }
      const inv = 1 / ((yb - ya) * (xb - xa));
      r[o] = (sr * inv) / 255;
      g[o] = (sg * inv) / 255;
      b[o] = (sb * inv) / 255;
      for (let k = 0; k < planes.length; k++) outs[k][o] *= inv;
    }
  }
  return { sw, sh, r, g, b, planes: outs };
}

/**
 * Guided filter with the image's colour as guide (He, Sun, Tang), in its fast form: the linear
 * coefficients are computed on a copy reduced by `subsample` and applied to the full-size guide.
 * `weights` (0..1 per pixel) limit the fit to trusted pixels: the model alpha = a . colour + b is
 * learned where the mask is known and evaluated everywhere.
 * @param {ImageDataLike} img guide
 * @param {Float32Array} p plane to filter (0..1), image sized
 * @param {{ radius: number, eps?: number, subsample?: number, weights?: Float32Array | null, rect?: Rect | null, only?: Uint8Array | null }} opts
 *   only: flags of the pixels whose result is wanted (the others keep p)
 * @returns {Float32Array} a new image-sized plane: the filtered values inside rect, p outside
 */
export function guidedFilter(img, p, { radius, eps = 4e-4, subsample = 1, weights = null, rect = null, only = null }) {
  const W = img.width, H = img.height, d = img.data;
  const out = new Float32Array(p);
  const roi = rect ? clipRect(rect, W, H) : { x: 0, y: 0, width: W, height: H };
  if (roi.width <= 0 || roi.height <= 0) return out;
  const s = Math.max(1, Math.floor(subsample));
  const red = reduceRegion(img, roi, s, weights ? [p, weights] : [p]);
  const { sw, sh, r: R, g: G, b: B } = red;
  const n = sw * sh, rr = Math.max(1, Math.round(radius / s));
  const P = red.planes[0], Wt = weights ? red.planes[1] : null;
  const tmp = new Float32Array(n);
  /** Weighted window mean of f * g (g optional). */
  const mean = (f, g = null) => {
    const m = new Float32Array(n);
    if (Wt) for (let i = 0; i < n; i++) m[i] = Wt[i] * f[i] * (g ? g[i] : 1);
    else if (g) for (let i = 0; i < n; i++) m[i] = f[i] * g[i];
    else m.set(f);
    return boxMean(m, sw, sh, rr, m, tmp);
  };
  let norm = null, plain = null;
  if (Wt) {
    norm = boxMean(Wt, sw, sh, rr, new Float32Array(n), tmp);
    plain = boxMean(P, sw, sh, rr, new Float32Array(n), tmp); // where nothing is trusted the window mean of p stands in
  }
  const div = (m) => {
    if (norm) for (let i = 0; i < n; i++) m[i] = norm[i] > 1e-6 ? m[i] / norm[i] : 0;
    return m;
  };
  const mR = div(mean(R)), mG = div(mean(G)), mB = div(mean(B)), mP = div(mean(P));
  const cR = div(mean(R, P)), cG = div(mean(G, P)), cB = div(mean(B, P));
  const vRR = div(mean(R, R)), vRG = div(mean(R, G)), vRB = div(mean(R, B)), vGG = div(mean(G, G)), vGB = div(mean(G, B)), vBB = div(mean(B, B));
  // a = (Sigma + eps I)^-1 cov(I, p), b = mean(p) - a . mean(I); written over cR, cG, cB and mP
  for (let i = 0; i < n; i++) {
    if (norm && norm[i] <= 1e-6) {
      cR[i] = cG[i] = cB[i] = 0;
      mP[i] = plain[i];
      continue;
    }
    const mr = mR[i], mg = mG[i], mb = mB[i], mp = mP[i];
    const kr = cR[i] - mr * mp, kg = cG[i] - mg * mp, kb = cB[i] - mb * mp;
    const a11 = vRR[i] - mr * mr + eps, a12 = vRG[i] - mr * mg, a13 = vRB[i] - mr * mb;
    const a22 = vGG[i] - mg * mg + eps, a23 = vGB[i] - mg * mb, a33 = vBB[i] - mb * mb + eps;
    const i11 = a22 * a33 - a23 * a23, i12 = a13 * a23 - a12 * a33, i13 = a12 * a23 - a13 * a22;
    const det = a11 * i11 + a12 * i12 + a13 * i13;
    if (!(Math.abs(det) > 1e-20)) {
      cR[i] = cG[i] = cB[i] = 0;
      continue;
    }
    const i22 = a11 * a33 - a13 * a13, i23 = a12 * a13 - a11 * a23, i33 = a11 * a22 - a12 * a12;
    const ar = (i11 * kr + i12 * kg + i13 * kb) / det, ag = (i12 * kr + i22 * kg + i23 * kb) / det, ab = (i13 * kr + i23 * kg + i33 * kb) / det;
    cR[i] = ar;
    cG[i] = ag;
    cB[i] = ab;
    mP[i] = mp - ar * mr - ag * mg - ab * mb;
  }
  boxMean(cR, sw, sh, rr, cR, tmp);
  boxMean(cG, sw, sh, rr, cG, tmp);
  boxMean(cB, sw, sh, rr, cB, tmp);
  boxMean(mP, sw, sh, rr, mP, tmp);
  for (let y = 0; y < roi.height; y++) {
    let o = (roi.y + y) * W + roi.x, i = o * 4;
    for (let x = 0; x < roi.width; x++, o++, i += 4) {
      if (only && !only[o]) continue;
      const q = (sampleUp(cR, sw, sh, s, x, y) * d[i] + sampleUp(cG, sw, sh, s, x, y) * d[i + 1] + sampleUp(cB, sw, sh, s, x, y) * d[i + 2]) / 255 + sampleUp(mP, sw, sh, s, x, y);
      out[o] = clamp01(q);
    }
  }
  return out;
}

function clipRect(r, w, h) {
  const x = Math.max(0, Math.floor(r.x)), y = Math.max(0, Math.floor(r.y));
  return { x, y, width: Math.min(w, Math.ceil(r.x + r.width)) - x, height: Math.min(h, Math.ceil(r.y + r.height)) - y };
}

// ---- edge detection --------------------------------------------------------------------------------------------------

/**
 * Chamfer (1, sqrt 2) distance of every pixel centre to the mask edge (the 128 level), capped at `cap`.
 * Pixels next to a pixel of the other side are at 0.5.
 */
function edgeDistance(mask, w, h, cap) {
  const n = w * h, dist = new Float32Array(n).fill(cap + 1);
  let any = false;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x, v = mask[p] >= 128;
      if ((x > 0 && mask[p - 1] >= 128 !== v) || (x < w - 1 && mask[p + 1] >= 128 !== v) || (y > 0 && mask[p - w] >= 128 !== v) || (y < h - 1 && mask[p + w] >= 128 !== v)) {
        dist[p] = 0.5;
        any = true;
      }
    }
  }
  if (!any) return { dist, any };
  const D = Math.SQRT2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      let v = dist[p];
      if (x > 0 && dist[p - 1] + 1 < v) v = dist[p - 1] + 1;
      if (y > 0) {
        if (dist[p - w] + 1 < v) v = dist[p - w] + 1;
        if (x > 0 && dist[p - w - 1] + D < v) v = dist[p - w - 1] + D;
        if (x < w - 1 && dist[p - w + 1] + D < v) v = dist[p - w + 1] + D;
      }
      dist[p] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const p = y * w + x;
      let v = dist[p];
      if (x < w - 1 && dist[p + 1] + 1 < v) v = dist[p + 1] + 1;
      if (y < h - 1) {
        if (dist[p + w] + 1 < v) v = dist[p + w] + 1;
        if (x < w - 1 && dist[p + w + 1] + D < v) v = dist[p + w + 1] + D;
        if (x > 0 && dist[p + w - 1] + D < v) v = dist[p + w - 1] + D;
      }
      dist[p] = v;
    }
  }
  return { dist, any };
}

/**
 * Smart Radius: how much of the radius each place gets (0.3..1). A clean step edge concentrates the
 * gradient in a line through the window (sparse: mean² / mean of squares is about 2 / window side), soft
 * edges and hair spread it; places without any image structure get the narrow band too, since matting
 * could only blur the mask there.
 */
function smartFactor(img, w, h, radius) {
  const n = w * h, d = img.data;
  const lum = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) lum[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  const g = new Float32Array(n), g2 = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const gx = lum[x < w - 1 ? p + 1 : p] - lum[x > 0 ? p - 1 : p], gy = lum[y < h - 1 ? p + w : p] - lum[y > 0 ? p - w : p];
      const m = Math.sqrt(gx * gx + gy * gy) * 0.5;
      g[p] = m;
      g2[p] = m * m;
    }
  }
  const r = Math.max(2, Math.round(radius)), side = 2 * r + 1, tmp = new Float32Array(n);
  boxMean(g, w, h, r, g, tmp);
  boxMean(g2, w, h, r, g2, tmp);
  for (let p = 0; p < n; p++) {
    const m2 = g2[p];
    const spread = m2 > 1e-6 ? (g[p] * g[p]) / m2 : 0; // 2 / side for one hard edge, towards 1 for texture
    const soft = clamp01(((spread * side) / 2 - 1.2) / 2.5) * clamp01(m2 / 4);
    g[p] = 0.3 + 0.7 * soft;
  }
  return g;
}

/**
 * The band the Edge Detection works in: pixels within `radius` px of the mask edge (less where
 * Smart Radius finds a hard edge) and every pixel of `extra` (>= 128).
 * @returns {{ band: Uint8Array, bounds: Rect | null, count: number }}
 */
export function edgeBand(img, mask, { radius = 0, smartRadius = false, extra = null } = {}) {
  const w = img.width, h = img.height, n = w * h;
  const band = new Uint8Array(n);
  let x0 = w, y0 = h, x1 = -1, y1 = -1, count = 0;
  const mark = (p, x, y) => {
    band[p] = 1;
    count++;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  };
  if (radius > 0) {
    const { dist, any } = edgeDistance(mask, w, h, radius);
    if (any) {
      const factor = smartRadius ? smartFactor(img, w, h, radius) : null;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (dist[p] <= (factor ? Math.max(1, radius * factor[p]) : radius)) mark(p, x, y);
      }
    }
  }
  if (extra) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    if (!band[p] && extra[p] >= 128) mark(p, x, y);
  }
  return { band, count, bounds: count ? { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 } : null };
}

/**
 * Projection of every band pixel on the line between the local foreground and background colours
 * (means of the trusted selected / unselected pixels in the window). Returns alpha and a confidence
 * (0 where the two colours are too close, or one of them is missing, to tell anything).
 */
function colorAlpha(img, roi, s, radius, fgW, bgW) {
  const red = reduceRegion(img, roi, s, [fgW, bgW]);
  const { sw, sh, r: R, g: G, b: B } = red, n = sw * sh;
  const [F, K] = red.planes;
  const rr = Math.max(1, Math.round(radius / s)), tmp = new Float32Array(n);
  const wmean = (c, wt) => {
    const m = new Float32Array(n);
    for (let i = 0; i < n; i++) m[i] = c[i] * wt[i];
    return boxMean(m, sw, sh, rr, m, tmp);
  };
  const fr = wmean(R, F), fg = wmean(G, F), fb = wmean(B, F), br = wmean(R, K), bg = wmean(G, K), bb = wmean(B, K);
  const fn = boxMean(F, sw, sh, rr, new Float32Array(n), tmp), bn = boxMean(K, sw, sh, rr, new Float32Array(n), tmp);
  for (let i = 0; i < n; i++) {
    const a = fn[i] > 1e-5 ? 1 / fn[i] : 0, b = bn[i] > 1e-5 ? 1 / bn[i] : 0;
    fr[i] *= a;
    fg[i] *= a;
    fb[i] *= a;
    br[i] *= b;
    bg[i] *= b;
    bb[i] *= b;
  }
  return { sw, sh, s, fr, fg, fb, br, bg, bb, fn, bn };
}

const MODE_COLOR_WEIGHT = { color: 0.75, object: 0.25 };

/** Edge Detection: alpha inside the band from the image, the mask elsewhere. Returns a plane 0..1. */
function detectEdge(img, mask, opts) {
  const w = img.width, h = img.height, n = w * h;
  const alpha = new Float32Array(n);
  for (let p = 0; p < n; p++) alpha[p] = mask[p] / 255;
  const radius = Math.max(0, +opts.radius || 0);
  const { band, bounds } = edgeBand(img, mask, { radius, smartRadius: opts.smartRadius, extra: opts.extra });
  if (!bounds) return alpha;
  // the window must reach trusted pixels from anywhere in the band, painted areas included
  const win = Math.max(2, Math.round(Math.max(radius, +opts.extraRadius || 0) * 1.5));
  const roi = clipRect({ x: bounds.x - win - 1, y: bounds.y - win - 1, width: bounds.width + 2 * win + 2, height: bounds.height + 2 * win + 2 }, w, h);
  const p = new Float32Array(n), trust = new Float32Array(n), fgW = new Float32Array(n), bgW = new Float32Array(n);
  for (let y = roi.y; y < roi.y + roi.height; y++) {
    for (let x = roi.x; x < roi.x + roi.width; x++) {
      const i = y * w + x, a = alpha[i];
      if (band[i]) {
        p[i] = a >= 0.5 ? 1 : 0;
        trust[i] = 0.02; // a little weight keeps the fit defined where the whole window is band
      } else {
        p[i] = a;
        trust[i] = 1;
        if (a >= 0.99) fgW[i] = 1;
        else if (a <= 0.01) bgW[i] = 1;
      }
    }
  }
  const s = win >= 24 ? 4 : win >= 6 ? 2 : 1;
  const q = guidedFilter(img, p, { radius: win, eps: opts.eps ?? 4e-4, subsample: s, weights: trust, rect: roi, only: band });
  const wc = MODE_COLOR_WEIGHT[opts.mode] ?? MODE_COLOR_WEIGHT.object;
  const c = wc > 0 ? colorAlpha(img, roi, s, win, fgW, bgW) : null;
  const d = img.data;
  for (let y = bounds.y; y < bounds.y + bounds.height; y++) {
    for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
      const i = y * w + x;
      if (!band[i]) continue;
      let a = q[i];
      if (c) {
        const rx = x - roi.x, ry = y - roi.y;
        const fn = sampleUp(c.fn, c.sw, c.sh, s, rx, ry), bn = sampleUp(c.bn, c.sw, c.sh, s, rx, ry);
        if (fn > 0.01 && bn > 0.01) {
          const fr = sampleUp(c.fr, c.sw, c.sh, s, rx, ry), fg = sampleUp(c.fg, c.sw, c.sh, s, rx, ry), fb = sampleUp(c.fb, c.sw, c.sh, s, rx, ry);
          const br = sampleUp(c.br, c.sw, c.sh, s, rx, ry), bg = sampleUp(c.bg, c.sw, c.sh, s, rx, ry), bb = sampleUp(c.bb, c.sw, c.sh, s, rx, ry);
          const dr = fr - br, dg = fg - bg, db = fb - bb, len = dr * dr + dg * dg + db * db;
          const j = i * 4;
          const proj = clamp01(((d[j] / 255 - br) * dr + (d[j + 1] / 255 - bg) * dg + (d[j + 2] / 255 - bb) * db) / (len + 1e-6));
          const conf = len / (len + 0.01); // colours 0.1 apart (of 1.73) are trusted by half
          a += (proj - a) * wc * conf;
        }
      }
      alpha[i] = clamp01(a);
    }
  }
  return alpha;
}

// ---- global refinements ---------------------------------------------------------------------------------------------

/** Bounds of the pixels that are not flat 0 or 1 surrounded by the same value, inflated by pad. */
function edgeBounds(alpha, w, h, pad) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const v = alpha[row + x];
      if ((v > 0 && v < 1) || (x < w - 1 && alpha[row + x + 1] !== v) || (y < h - 1 && alpha[row + x + w] !== v)) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return clipRect({ x: x0 - pad, y: y0 - pad, width: x1 - x0 + 2 + 2 * pad, height: y1 - y0 + 2 + 2 * pad }, w, h);
}

/** The Contrast curve: a logistic through (0, 0), (0.5, 0.5), (1, 1), steeper with c (0..1). */
function contrastLut(c) {
  const lut = new Float32Array(1025);
  const k = (24 * c) / (1.02 - c);
  const lo = 1 / (1 + Math.exp(k / 2)), hi = 1 / (1 + Math.exp(-k / 2));
  for (let i = 0; i <= 1024; i++) {
    const a = i / 1024;
    lut[i] = k < 1e-3 ? a : (1 / (1 + Math.exp(-k * (a - 0.5))) - lo) / (hi - lo);
  }
  return lut;
}

/**
 * Smooth, Feather, Contrast and Shift Edge on a plane (0..1), in place, in Photoshop's order.
 * @param {{ smooth?: number, feather?: number, contrast?: number, shift?: number, band?: number }} opts
 *   smooth 0..100, feather px, contrast 0..100 %, shift -100..100 % of the band (max of band, feather, 3 px)
 */
export function globalRefine(alpha, w, h, { smooth = 0, feather = 0, contrast = 0, shift = 0, band = 0 } = {}) {
  smooth = Math.max(0, Math.min(100, +smooth || 0));
  feather = Math.max(0, +feather || 0);
  contrast = Math.max(0, Math.min(100, +contrast || 0));
  shift = Math.max(-100, Math.min(100, +shift || 0));
  if (!smooth && !feather && !contrast && !shift) return alpha;
  const shiftPx = (Math.abs(shift) / 100) * Math.max(band, feather, 3);
  const smoothSigma = smooth ? 0.5 + (smooth / 100) * 4 : 0;
  const pad = Math.ceil(3 * smoothSigma + 3 * (feather / 2) + shiftPx + 4);
  const roi = edgeBounds(alpha, w, h, pad);
  if (!roi) return alpha;
  const cw = roi.width, ch = roi.height, m = cw * ch;
  let a = new Float32Array(m);
  for (let y = 0; y < ch; y++) a.set(alpha.subarray((roi.y + y) * w + roi.x, (roi.y + y) * w + roi.x + cw), y * cw);
  const tmp = new Float32Array(m);
  if (smooth) {
    // open then close removes spurs and pits smaller than the element, the blur rounds what is left and the
    // gain puts the edge back to about a pixel wide (Smooth straightens the outline, it does not feather)
    const rm = Math.round(smooth / 40);
    if (rm >= 1) {
      a = minMaxFilter(minMaxFilter(a, cw, ch, rm, false), cw, ch, rm, true);
      a = minMaxFilter(minMaxFilter(a, cw, ch, rm, true), cw, ch, rm, false);
    }
    gaussianBlur(a, cw, ch, smoothSigma, tmp);
    const gain = 1 + 1.6 * smoothSigma;
    for (let i = 0; i < m; i++) a[i] = clamp01((a[i] - 0.5) * gain + 0.5);
  }
  if (feather) gaussianBlur(a, cw, ch, feather / 2, tmp);
  if (contrast) {
    const lut = contrastLut(contrast / 100);
    for (let i = 0; i < m; i++) a[i] = lut[Math.round(clamp01(a[i]) * 1024)];
  }
  if (shiftPx > 0) {
    // a fractional shift mixes the two whole-pixel results on either side of it
    const lo = Math.floor(shiftPx), t = shiftPx - lo, grow = shift > 0;
    const base = lo ? minMaxFilter(a, cw, ch, lo, grow) : a;
    if (t > 1e-3) {
      const next = minMaxFilter(a, cw, ch, lo + 1, grow);
      for (let i = 0; i < m; i++) next[i] = base[i] + (next[i] - base[i]) * t;
      a = next;
    } else a = base;
  }
  for (let y = 0; y < ch; y++) alpha.set(a.subarray(y * cw, (y + 1) * cw), (roi.y + y) * w + roi.x);
  return alpha;
}

/**
 * Refine Edge: Edge Detection in the band, then the Global Refinements.
 * @param {ImageDataLike} img the pixels the selection was made on
 * @param {Uint8ClampedArray} mask w*h, 0..255
 * @param {{ radius?: number, smartRadius?: boolean, smooth?: number, feather?: number, contrast?: number, shift?: number,
 *   mode?: 'object' | 'color', extra?: Uint8Array | Uint8ClampedArray | null, extraRadius?: number }} [opts]
 *   radius px (0 = no edge detection), mode: which estimate leads inside the band, extra: painted unknown
 *   area (the Refine Edge Brush) with extraRadius = half its widest stroke
 * @returns {Uint8ClampedArray} a new mask
 */
export function refineEdge(img, mask, opts = {}) {
  const w = img.width, h = img.height;
  const radius = Math.max(0, +opts.radius || 0);
  const alpha = radius > 0 || opts.extra ? detectEdge(img, mask, opts) : Float32Array.from(mask, (v) => v / 255);
  globalRefine(alpha, w, h, { smooth: opts.smooth, feather: opts.feather, contrast: opts.contrast, shift: opts.shift, band: radius });
  const out = new Uint8ClampedArray(w * h);
  for (let p = 0; p < out.length; p++) out[p] = alpha[p] * 255; // the clamped array rounds
  return out;
}

// ---- colour decontamination -----------------------------------------------------------------------------------------

/**
 * Decontaminate Colors: partially selected pixels carry some of the background's colour; each takes
 * the colour of the nearest solid interior pixel instead, by amount * (1 - alpha²) (fully for the most
 * transparent ones, hardly at all for nearly opaque ones). Alpha and unselected pixels are untouched.
 * @param {ImageDataLike} img
 * @param {Uint8ClampedArray} alpha w*h selection, 0..255
 * @param {number} [amount=1] 0..1
 * @returns {ImageDataLike} a new image
 */
export function decontaminate(img, alpha, amount = 1) {
  const w = img.width, h = img.height, n = w * h;
  const out = { width: w, height: h, data: new Uint8ClampedArray(img.data) };
  const amt = clamp01(+amount || 0);
  if (!n || amt <= 0) return out;
  // interior = solid pixels with solid 4-neighbours two deep (the rim next to the soft edge may be tinted already)
  const solid = new Uint8Array(n);
  let soft = false;
  for (let p = 0; p < n; p++) {
    if (alpha[p] >= 250) solid[p] = 1;
    else if (alpha[p] > 0) soft = true;
  }
  if (!soft) return out;
  let interior = solid;
  for (let pass = 0; pass < 2; pass++) {
    const next = new Uint8Array(n);
    let some = false;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!interior[p]) continue;
      if ((x > 0 && !interior[p - 1]) || (x < w - 1 && !interior[p + 1]) || (y > 0 && !interior[p - w]) || (y < h - 1 && !interior[p + w])) continue;
      next[p] = 1;
      some = true;
    }
    if (!some) break; // thinner than the erosion: the solid pixels themselves are the best there is
    interior = next;
  }
  const near = nearestSource(interior, w, h).index;
  const d = img.data, o = out.data;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const a = alpha[p];
    if (a === 0 || a >= 250) continue;
    const s = near[p];
    if (s < 0) continue;
    const f = a / 255, t = amt * (1 - f * f), j = s * 4;
    o[i] = d[i] + (d[j] - d[i]) * t;
    o[i + 1] = d[i + 1] + (d[j + 1] - d[i + 1]) * t;
    o[i + 2] = d[i + 2] + (d[j + 2] - d[i + 2]) * t;
  }
  return out;
}
