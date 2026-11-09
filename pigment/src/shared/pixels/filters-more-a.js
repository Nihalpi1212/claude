// Filter menu kinds added in 0.3, part A (builder "filters-a"): the rest of Photoshop's Blur,
// Sharpen, Pixelate and Video groups plus HSB/HSL. Every entry is built with defineFilter() from
// filter-def.js and follows the conventions at the top of filters.js (rect limits writes only,
// straight alpha in and out, alpha-weighted averaging, deterministic noise per seed, nothing read
// outside the image). Ids, names and categories are final because menus, smart filters and the AI
// assistant refer to them; `fields` and `margin` are pure data lib/filter-ui.js reads.
//
// FILTERS from './filters.js' is used inside apply() only (Sharpen More is a stronger Sharpen,
// Lens Blur's grain is Add Noise): filters.js imports this table, so the modules form a cycle that
// is safe at call time only. Importers must load filters.js first (the renderer and the unit tests do).
//
// Performance notes:
// - The polygon / shape kernels (Lens Blur, Shape Blur) are convolved with row-span prefix sums:
//   O(kernel rows) per pixel whatever the width of the kernel. Radii beyond 8 px run on a box-
//   downscaled copy (factor ceil(radius / 8), also raised when the pixel budget asks for it) and
//   are sampled back bilinearly, so a 100 px blur of a 2000x1500 layer costs about as much as an
//   8 px one. Lens Blur with a depth map blurs a handful of radius levels and interpolates per pixel.
// - Shake Reduction estimates the blur trace on the sharpest 512 px tile (cepstrum of the windowed
//   luma, FFT based) and deconvolves with a Wiener filter in overlapping 256/512 px FFT tiles; two
//   colour channels share one complex FFT. A 2000x1500 layer takes a few seconds.
// - Smart Blur samples its bilateral window on a step (quality 3/2/1 px, coarser for big radii) so
//   the tap count stays bounded.

import {
  clampRect, inflateRect, cropImage, premultiply, unpremultiply, luminance,
} from './core.js';
import { rgbToHsl, hslToRgb, rgbToHsv, hsvToRgb } from './color.js';
import { num, clampNum, round8, smoothstep, DEG, TAU, region, defineFilter } from './filter-def.js';
import { FILTERS } from './filters.js';

/** @typedef {import('./core.js').ImageDataLike} ImageDataLike */
/** @typedef {import('./core.js').Rect} Rect */

// ---------------------------------------------------------------------------------------------
// Helpers (module private; filters.js keeps its own copies of the small ones)

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

/** Integer hash of three int32s (position-stable noise). */
function hash3(x, y, z) {
  let h = (Math.imul(x | 0, 0x27d4eb2d) + Math.imul(y | 0, 0x165667b1) + Math.imul(z | 0, 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
const hashUnit = (x, y, z) => hash3(x, y, z) / 4294967296;

/** Straight luma of region g as floats (transparent pixels read 0), one per pixel. */
function lumaPlane(img, g) {
  const L = new Float32Array(g.width * g.height), d = img.data, W = img.width;
  for (let y = 0, o = 0; y < g.height; y++) {
    let i = ((g.y + y) * W + g.x) * 4;
    for (let x = 0; x < g.width; x++, i += 4, o++) L[o] = d[i + 3] === 0 ? 0 : luminance(d[i], d[i + 1], d[i + 2]);
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

/** One 1-2-1 pass (horizontal then vertical) over a premultiplied float RGBA buffer, edges replicated. */
function pass121(f, t, w, h) {
  const stride = w * 4;
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    for (let x = 0; x < w; x++) {
      const i = row + x * 4, l = row + (x > 0 ? x - 1 : 0) * 4, rr = row + (x < w - 1 ? x + 1 : x) * 4;
      t[i] = 0.25 * (f[l] + f[rr]) + 0.5 * f[i];
      t[i + 1] = 0.25 * (f[l + 1] + f[rr + 1]) + 0.5 * f[i + 1];
      t[i + 2] = 0.25 * (f[l + 2] + f[rr + 2]) + 0.5 * f[i + 2];
      t[i + 3] = 0.25 * (f[l + 3] + f[rr + 3]) + 0.5 * f[i + 3];
    }
  }
  for (let y = 0; y < h; y++) {
    const row = y * stride, up = (y > 0 ? y - 1 : 0) * stride, dn = (y < h - 1 ? y + 1 : y) * stride;
    for (let i = 0; i < stride; i++) f[row + i] = 0.25 * (t[up + i] + t[dn + i]) + 0.5 * t[row + i];
  }
}

// ---------------------------------------------------------------------------------------------
// Average, Blur, Blur More

/**
 * The alpha-weighted mean colour of the whole image, written into rect (the shared rect convention:
 * geometry is the image). The filter dialog hands over the selection bounds as the image, so from the
 * menu this averages the selection, as Photoshop does.
 */
function average(img, _p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const d = img.data, W = img.width;
  let sr = 0, sg = 0, sb = 0, sa = 0;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 0) continue;
    sr += d[i] * a;
    sg += d[i + 1] * a;
    sb += d[i + 2] * a;
    sa += a;
  }
  if (sa === 0) return img;
  const R = round8(sr / sa), G = round8(sg / sa), B = round8(sb / sa);
  for (let y = r.y; y < r.y + r.height; y++) {
    for (let x = r.x, i = (y * W + r.x) * 4; x < r.x + r.width; x++, i += 4) {
      d[i] = R;
      d[i + 1] = G;
      d[i + 2] = B;
    }
  }
  return img;
}

/** passes x the separable 1-2-1 kernel, premultiplied so transparency never bleeds black. */
function blur121(img, rect, passes) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const g = grow(img, r, passes);
  const tmp = cropImage(img, g), f = premultiply(tmp), t = new Float32Array(f.length);
  for (let p = 0; p < passes; p++) pass121(f, t, g.width, g.height);
  unpremultiply(f, tmp);
  copyBack(img, tmp, g, r);
  return img;
}

// ---------------------------------------------------------------------------------------------
// Span kernels: binary kernels stored as row spans, convolved with row prefix sums

const MAX_WORK_RADIUS = 8; // kernel half-size at working resolution; bigger radii downscale first
const SPAN_BUDGET = 60e6; // pixels x kernel rows per convolution

/** Rasterises inside(u, v) (u, v in -1..1) at half-size R into row spans [x0, x1] (inclusive, relative to the centre). */
function rasterKernel(inside, R) {
  const spans = [];
  let taps = 0;
  for (let dy = -R; dy <= R; dy++) {
    const row = [];
    let start = null;
    for (let dx = -R; dx <= R + 1; dx++) {
      const on = dx <= R && inside(dx / R, dy / R);
      if (on && start === null) start = dx;
      if (!on && start !== null) {
        row.push(start, dx - 1);
        taps += dx - start;
        start = null;
      }
    }
    spans.push(Int32Array.from(row));
  }
  if (taps === 0) spans[R] = Int32Array.of(0, 0); // never an empty kernel
  return { R, spans };
}

/** Convolves a premultiplied float RGBA buffer with a span kernel (edges: taps outside the image are dropped and the mean renormalised). */
function spanConvolve(f, w, h, kernel) {
  const { R, spans } = kernel;
  const pstride = (w + 1) * 4;
  const P = new Float32Array(pstride * h);
  for (let y = 0; y < h; y++) {
    const po = y * pstride, fo = y * w * 4;
    let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
    for (let x = 0; x < w; x++) {
      const i = fo + x * 4, o = po + (x + 1) * 4;
      P[o] = a0 += f[i];
      P[o + 1] = a1 += f[i + 1];
      P[o + 2] = a2 += f[i + 2];
      P[o + 3] = a3 += f[i + 3];
    }
  }
  const out = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0, cnt = 0;
      for (let dy = -R; dy <= R; dy++) {
        let yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        const sp = spans[dy + R], po = yy * pstride;
        for (let k = 0; k < sp.length; k += 2) {
          let xa = x + sp[k], xb = x + sp[k + 1];
          if (xa < 0) xa = 0;
          if (xb >= w) xb = w - 1;
          if (xb < xa) continue;
          const ia = po + xa * 4, ib = po + (xb + 1) * 4;
          s0 += P[ib] - P[ia];
          s1 += P[ib + 1] - P[ia + 1];
          s2 += P[ib + 2] - P[ia + 2];
          s3 += P[ib + 3] - P[ia + 3];
          cnt += xb - xa + 1;
        }
      }
      const o = (y * w + x) * 4, inv = cnt > 0 ? 1 / cnt : 0;
      out[o] = s0 * inv;
      out[o + 1] = s1 * inv;
      out[o + 2] = s2 * inv;
      out[o + 3] = s3 * inv;
    }
  }
  return out;
}

/** Box-downscales a float RGBA buffer by an integer factor s (partial border cells average what they cover). */
function downscale(f, w, h, s) {
  const w2 = Math.ceil(w / s), h2 = Math.ceil(h / s), out = new Float32Array(w2 * h2 * 4);
  for (let y2 = 0; y2 < h2; y2++) {
    const y0 = y2 * s, y1 = Math.min(h, y0 + s);
    for (let x2 = 0; x2 < w2; x2++) {
      const x0 = x2 * s, x1 = Math.min(w, x0 + s);
      let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0, i = (y * w + x0) * 4; x < x1; x++, i += 4) {
          a0 += f[i];
          a1 += f[i + 1];
          a2 += f[i + 2];
          a3 += f[i + 3];
        }
      }
      const inv = 1 / ((y1 - y0) * (x1 - x0)), o = (y2 * w2 + x2) * 4;
      out[o] = a0 * inv;
      out[o + 1] = a1 * inv;
      out[o + 2] = a2 * inv;
      out[o + 3] = a3 * inv;
    }
  }
  return { f: out, w: w2, h: h2 };
}

/** Bilinear sample of a reduced buffer (scale s) at full-resolution pixel (x, y) into dst[o..o+3]. */
function sampleReduced(level, x, y, dst, o) {
  const { f, w, h, s } = level;
  if (s === 1) {
    const i = (y * w + x) * 4;
    dst[o] = f[i];
    dst[o + 1] = f[i + 1];
    dst[o + 2] = f[i + 2];
    dst[o + 3] = f[i + 3];
    return;
  }
  let fx = (x + 0.5) / s - 0.5, fy = (y + 0.5) / s - 0.5;
  fx = fx < 0 ? 0 : fx > w - 1 ? w - 1 : fx;
  fy = fy < 0 ? 0 : fy > h - 1 ? h - 1 : fy;
  const x0 = fx | 0, y0 = fy | 0, x1 = x0 < w - 1 ? x0 + 1 : x0, y1 = y0 < h - 1 ? y0 + 1 : y0;
  const tx = fx - x0, ty = fy - y0;
  const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4, i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
  const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
  for (let c = 0; c < 4; c++) dst[o + c] = f[i00 + c] * w00 + f[i10 + c] * w10 + f[i01 + c] * w01 + f[i11 + c] * w11;
}

/** Working scale for a kernel of the given radius on a w x h buffer. */
function workScale(w, h, radius) {
  let s = Math.max(1, Math.ceil(radius / MAX_WORK_RADIUS));
  while ((w / s) * (h / s) * (2 * (radius / s) + 1) > SPAN_BUDGET) s++;
  return s;
}

/** Blurs a premultiplied float buffer with the shape at the given radius; returns a reduced level { f, w, h, s }. */
function kernelBlurLevel(f, w, h, radius, inside) {
  const s = workScale(w, h, radius);
  const Rw = Math.max(1, Math.round(radius / s));
  const k = rasterKernel(inside, Rw);
  if (s === 1) return { f: spanConvolve(f, w, h, k), w, h, s: 1 };
  const d = downscale(f, w, h, s);
  return { f: spanConvolve(d.f, d.w, d.h, k), w: d.w, h: d.h, s };
}

/** Expands a level to a full-resolution float buffer. */
function expandLevel(level, w, h) {
  if (level.s === 1) return level.f;
  const out = new Float32Array(w * h * 4);
  for (let y = 0, o = 0; y < h; y++) for (let x = 0; x < w; x++, o += 4) sampleReduced(level, x, y, out, o);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Shape Blur

const starRadius = (() => {
  // boundary radius of a 5-point star (outer 1, inner 0.45) as a function of the angle from an outer vertex
  const n = 5, ri = 0.45, ax = 1, ay = 0, bx = ri * Math.cos(Math.PI / n), by = ri * Math.sin(Math.PI / n);
  const ex = bx - ax, ey = by - ay, cAB = ex * ay - ey * ax;
  return (phi) => {
    const den = ex * Math.sin(phi) - ey * Math.cos(phi);
    return Math.abs(den) < 1e-9 ? 1 : cAB / den;
  };
})();

/**
 * The built-in Shape Blur kernels: { id, name, inside(u, v) } with u, v in -1..1 (y down). The dialog lists
 * them in this order; `inside` is pure so the kernel can be rasterised at any radius.
 */
export const SHAPE_BLUR_SHAPES = Object.freeze([
  { id: 'circle', name: 'Circle', inside: (u, v) => u * u + v * v <= 1 },
  { id: 'square', name: 'Square', inside: (u, v) => Math.abs(u) <= 1 && Math.abs(v) <= 1 },
  { id: 'triangle', name: 'Triangle', inside: (u, v) => v >= -1 && v <= 1 && Math.abs(u) <= (v + 1) / 2 },
  { id: 'diamond', name: 'Diamond', inside: (u, v) => Math.abs(u) + Math.abs(v) <= 1 },
  {
    id: 'star',
    name: 'Star',
    inside: (u, v) => {
      const r = Math.hypot(u, v);
      if (r > 1) return false;
      if (r === 0) return true;
      // angle from the nearest outer vertex (vertices at -90 deg + k 72 deg), folded into 0..36 deg
      const sector = TAU / 5;
      let a = Math.atan2(v, u) + Math.PI / 2;
      a = ((a % sector) + sector) % sector;
      if (a > sector / 2) a = sector - a;
      return r <= starRadius(a);
    },
  },
  {
    id: 'heart',
    name: 'Heart',
    inside: (u, v) => {
      const x = u * 1.25, y = 0.15 - 1.15 * v, q = x * x + y * y - 1;
      return q * q * q - x * x * y * y * y <= 0;
    },
  },
  { id: 'arrow', name: 'Arrow', inside: (u, v) => (u <= 0.2 && u >= -1 && Math.abs(v) <= 0.3) || (u > 0.2 && u <= 1 && Math.abs(v) <= (1 - u) / 0.8) },
  { id: 'cross', name: 'Cross', inside: (u, v) => (Math.abs(u) <= 0.33 && Math.abs(v) <= 1) || (Math.abs(v) <= 0.33 && Math.abs(u) <= 1) },
  { id: 'hexagon', name: 'Hexagon', inside: (u, v) => Math.abs(v) <= 0.8660254 && 0.8660254 * Math.abs(u) + 0.5 * Math.abs(v) <= 0.8660254 },
  {
    id: 'ring',
    name: 'Ring',
    inside: (u, v) => {
      const r = u * u + v * v;
      return r <= 1 && r >= 0.3025;
    },
  },
].map((s) => Object.freeze(s)));

const shapeById = (id) => SHAPE_BLUR_SHAPES.find((s) => s.id === id) ?? SHAPE_BLUR_SHAPES[0];

function shapeBlur(img, p, rect) {
  const r = region(img, rect);
  const radius = Math.round(clampNum(num(p.radius, 5), 1, 1000));
  if (isEmpty(r)) return img;
  const g = grow(img, r, radius + 1);
  const tmp = cropImage(img, g), f = premultiply(tmp);
  const level = kernelBlurLevel(f, g.width, g.height, radius, shapeById(p.shape).inside);
  unpremultiply(expandLevel(level, g.width, g.height), tmp);
  copyBack(img, tmp, g, r);
  return img;
}

// ---------------------------------------------------------------------------------------------
// Lens Blur

const APERTURE_SIDES = { triangle: 3, square: 4, pentagon: 5, hexagon: 6, heptagon: 7, octagon: 8 };

/** Polygonal aperture with `sides` blades, curvature 0 (straight) .. 1 (a circle), rotated by rotation degrees. */
function apertureInside(sides, curvature, rotation) {
  const apothem = Math.cos(Math.PI / sides), sector = TAU / sides, rot = rotation * DEG, half = sector / 2;
  return (u, v) => {
    const rr = Math.sqrt(u * u + v * v);
    if (rr > 1) return false;
    if (rr === 0) return true;
    let a = Math.atan2(v, u) - rot;
    a = ((a % sector) + sector + half) % sector - half; // angle to the nearest edge normal
    const dPoly = (rr * Math.cos(a)) / apothem; // 1 on the polygon's edge
    return dPoly + (rr - dPoly) * curvature <= 1;
  };
}

/**
 * Premultiplied copy with highlights (luma above threshold) boosted by up to 26x: a clipped point light is
 * really far brighter than 255, and only that excess survives the averaging as a visible bokeh disc.
 */
function boostHighlights(f, tmp, threshold, brightness) {
  const out = new Float32Array(f), d = tmp.data, gain = 0.25 * brightness;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const l = luminance(d[i], d[i + 1], d[i + 2]);
    if (l < threshold - 8) continue;
    const k = 1 + gain * smoothstep(threshold - 8, threshold + 8, l);
    out[i] *= k;
    out[i + 1] *= k;
    out[i + 2] *= k;
  }
  return out;
}

function lensBlur(img, p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const radius = clampNum(num(p.radius, 15), 0, 100);
  const noise = clampNum(num(p.noise, 0), 0, 100);
  if (radius > 0) {
    const g = grow(img, r, radius + 1);
    const tmp = cropImage(img, g), W = g.width, H = g.height;
    const f = premultiply(tmp);
    const inside = apertureInside(APERTURE_SIDES[p.shape] ?? 6, clampNum(num(p.bladeCurvature, 0), 0, 100) / 100, num(p.rotation, 0));
    const brightness = clampNum(num(p.brightness, 0), 0, 100), threshold = clampNum(num(p.threshold, 255), 0, 255);
    const src = brightness > 0 && threshold < 255 ? boostHighlights(f, tmp, threshold, brightness) : f;
    const depth = p.depthMap && p.depthMap.length === img.width * img.height ? p.depthMap : null;
    let out;
    if (!depth) out = expandLevel(kernelBlurLevel(src, W, H, radius, inside), W, H);
    else {
      // a few blur levels, interpolated per pixel by |depth - focal distance|
      const K = radius < 10 ? 3 : 5, focal = clampNum(num(p.focalDistance, 0), 0, 255), invert = !!p.invert;
      const levels = [{ f, w: W, h: H, s: 1 }];
      for (let k = 1; k <= K; k++) levels.push(kernelBlurLevel(src, W, H, (radius * k) / K, inside));
      out = new Float32Array(W * H * 4);
      const a = new Float32Array(4), b = new Float32Array(4), IW = img.width;
      for (let y = 0, o = 0; y < H; y++) {
        for (let x = 0; x < W; x++, o += 4) {
          let dv = depth[(g.y + y) * IW + g.x + x];
          if (invert) dv = 255 - dv;
          const t = (Math.abs(dv - focal) / 255) * K, lo = Math.min(K - 1, t | 0), hi = lo + 1, u = Math.min(1, t - lo);
          sampleReduced(levels[lo], x, y, a, 0);
          sampleReduced(levels[hi], x, y, b, 0);
          out[o] = a[0] + (b[0] - a[0]) * u;
          out[o + 1] = a[1] + (b[1] - a[1]) * u;
          out[o + 2] = a[2] + (b[2] - a[2]) * u;
          out[o + 3] = a[3] + (b[3] - a[3]) * u;
        }
      }
    }
    unpremultiply(out, tmp);
    copyBack(img, tmp, g, r);
  }
  // Photoshop adds the grain after the blur so bokeh stays clean; 100 here is about +-32 levels
  if (noise > 0) FILTERS['add-noise'].apply(img, { amount: noise / 4, distribution: p.distribution === 'gaussian' ? 'gaussian' : 'uniform', monochromatic: !!p.monochromatic, seed: 7 }, r);
  return img;
}

// ---------------------------------------------------------------------------------------------
// Smart Blur (bilateral)

const QUALITY_STEP = { low: 3, medium: 2, high: 1 };

/** Bilateral mean over region g: straight colours weighted by alpha and 1 - maxDiff / T; returns a g-sized RGBA buffer. */
function bilateral(img, g, radius, T, step) {
  const R = Math.max(1, Math.round(radius));
  const dxs = [], dys = [];
  for (let dy = -R; dy <= R; dy += step) for (let dx = -R; dx <= R; dx += step) if (dx * dx + dy * dy <= (R + 0.5) * (R + 0.5)) {
    dxs.push(dx);
    dys.push(dy);
  }
  const n = dxs.length, DX = Int32Array.from(dxs), DY = Int32Array.from(dys);
  const d = img.data, W = img.width, H = img.height, out = new Uint8ClampedArray(g.width * g.height * 4), invT = 1 / T;
  for (let y = g.y, o = 0; y < g.y + g.height; y++) {
    for (let x = g.x, i = (y * W + g.x) * 4; x < g.x + g.width; x++, i += 4, o += 4) {
      const R0 = d[i], G0 = d[i + 1], B0 = d[i + 2], A0 = d[i + 3];
      out[o + 3] = A0;
      if (A0 === 0) {
        out[o] = R0;
        out[o + 1] = G0;
        out[o + 2] = B0;
        continue;
      }
      let sr = 0, sg = 0, sb = 0, sw = 0;
      for (let t = 0; t < n; t++) {
        let xx = x + DX[t], yy = y + DY[t];
        xx = xx < 0 ? 0 : xx >= W ? W - 1 : xx;
        yy = yy < 0 ? 0 : yy >= H ? H - 1 : yy;
        const j = (yy * W + xx) * 4, a = d[j + 3];
        if (a === 0) continue;
        const dr = Math.abs(d[j] - R0), dg = Math.abs(d[j + 1] - G0), db = Math.abs(d[j + 2] - B0);
        const m = dr > dg ? (dr > db ? dr : db) : dg > db ? dg : db;
        const wt = (1 - m * invT) * a;
        if (wt <= 0) continue;
        sr += d[j] * wt;
        sg += d[j + 1] * wt;
        sb += d[j + 2] * wt;
        sw += wt;
      }
      out[o] = round8(sr / sw);
      out[o + 1] = round8(sg / sw);
      out[o + 2] = round8(sb / sw);
    }
  }
  return out;
}

function smartBlur(img, p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const radius = clampNum(num(p.radius, 3), 0.1, 100), threshold = clampNum(num(p.threshold, 25), 0.1, 100);
  const step = Math.max(QUALITY_STEP[p.quality] ?? 2, Math.ceil(radius / 4)); // bounded tap count for big radii
  const T = threshold * 2.55, mode = p.mode ?? 'normal';
  if (mode === 'normal') {
    storeOut(img, r, bilateral(img, r, radius, T, step));
    return img;
  }
  // edges: Sobel of the blurred luma above the threshold, so noise below it never reads as an edge
  const g = grow(img, r, 1), b = bilateral(img, g, radius, T, step), gw = g.width, gh = g.height;
  const L = new Float32Array(gw * gh);
  for (let i = 0, o = 0; i < b.length; i += 4, o++) L[o] = luminance(b[i], b[i + 1], b[i + 2]);
  const edgeT = T * 0.4, out = new Uint8ClampedArray(r.width * r.height * 4), d = img.data, W = img.width;
  for (let y = r.y, o = 0; y < r.y + r.height; y++) {
    for (let x = r.x, i = (y * W + r.x) * 4; x < r.x + r.width; x++, i += 4, o += 4) {
      const edge = sobelMag(L, gw, gh, x - g.x, y - g.y) >= edgeT;
      const bi = ((y - g.y) * gw + (x - g.x)) * 4;
      if (mode === 'edge-only') out[o] = out[o + 1] = out[o + 2] = edge ? 255 : 0;
      else if (edge) out[o] = out[o + 1] = out[o + 2] = 255;
      else {
        out[o] = b[bi];
        out[o + 1] = b[bi + 1];
        out[o + 2] = b[bi + 2];
      }
      out[o + 3] = d[i + 3];
    }
  }
  storeOut(img, r, out);
  return img;
}

// ---------------------------------------------------------------------------------------------
// Sharpen Edges, Sharpen More

const EDGE_LO = 12, EDGE_HI = 28; // Sobel luma magnitude (levels) where sharpening fades in

function sharpenEdges(img, _p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const g = grow(img, r, 2), tmp = cropImage(img, g), gw = g.width, gh = g.height;
  const f = premultiply(tmp), t = new Float32Array(f.length);
  pass121(f, t, gw, gh); // f is now the 1-2-1 blur (premultiplied)
  const L = lumaPlane(img, g), d = img.data, W = img.width;
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
      const k = 1.5 * smoothstep(EDGE_LO, EDGE_HI, sobelMag(L, gw, gh, x - g.x, y - g.y));
      if (k === 0) continue;
      const s = 255 / fa;
      out[o] = round8(R + k * (R - f[fi] * s));
      out[o + 1] = round8(G + k * (G - f[fi + 1] * s));
      out[o + 2] = round8(B + k * (B - f[fi + 2] * s));
    }
  }
  storeOut(img, r, out);
  return img;
}

// Photoshop's Sharpen More is about three Sharpens: the same radius-1 unsharp mask at 3x the amount
const sharpenMore = (img, _p, rect) => FILTERS.sharpen.apply(img, { amount: 150 }, rect);

// ---------------------------------------------------------------------------------------------
// FFT (radix-2, complex, in place) for Shake Reduction

const PLANS = new Map();
function fftPlan(n) {
  let p = PLANS.get(n);
  if (p) return p;
  const bits = Math.round(Math.log2(n)), rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let rv = 0, x = i;
    for (let b = 0; b < bits; b++) {
      rv = (rv << 1) | (x & 1);
      x >>= 1;
    }
    rev[i] = rv;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((TAU * i) / n);
    sin[i] = Math.sin((TAU * i) / n);
  }
  p = { rev, cos, sin };
  PLANS.set(n, p);
  return p;
}

function fft1(re, im, n, inverse, p) {
  const rev = p.rev;
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  const sgn = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0, t = 0; k < half; k++, t += step) {
        const wr = p.cos[t], wi = sgn * p.sin[t], a = start + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
  if (inverse) {
    const inv = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= inv;
      im[i] *= inv;
    }
  }
}

/** In-place 2-D FFT of an n x n complex array (row-major Float64Arrays). */
function fft2(re, im, n, inverse) {
  const p = fftPlan(n), tr = new Float64Array(n), ti = new Float64Array(n);
  for (let y = 0; y < n; y++) {
    const o = y * n;
    tr.set(re.subarray(o, o + n));
    ti.set(im.subarray(o, o + n));
    fft1(tr, ti, n, inverse, p);
    re.set(tr, o);
    im.set(ti, o);
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0, i = x; y < n; y++, i += n) {
      tr[y] = re[i];
      ti[y] = im[i];
    }
    fft1(tr, ti, n, inverse, p);
    for (let y = 0, i = x; y < n; y++, i += n) {
      re[i] = tr[y];
      im[i] = ti[y];
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Shake Reduction

const SHAKE_TILE_MAX = 512, SHAKE_TILE_MIN = 32, SHAKE_SIGNIFICANCE = 6, SHAKE_LEAD = 1.35, SHAKE_ANISOTROPY = 1.6;

/** Anti-aliased, normalised line kernel of the given length (px) and angle (deg), centred. */
function lineKernel(length, angle) {
  const half = Math.ceil(length / 2) + 1, size = 2 * half + 1, data = new Float32Array(size * size);
  const ux = Math.cos(angle * DEG), uy = Math.sin(angle * DEG), L2 = length / 2;
  let sum = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x - half, py = y - half, along = px * ux + py * uy, across = Math.abs(-px * uy + py * ux);
      const wAcross = clampNum(1 - across, 0, 1), wAlong = clampNum(L2 - Math.abs(along) + 0.5, 0, 1);
      sum += data[y * size + x] = wAcross * wAlong;
    }
  }
  if (sum <= 0) {
    data[half * size + half] = 1;
    sum = 1;
  }
  for (let i = 0; i < data.length; i++) data[i] /= sum;
  return { size, half, data };
}

/**
 * Estimates the camera-shake blur of an image from the cepstrum of its sharpest tiles: a motion of
 * L px puts a negative spike at quefrency L along the motion direction. Returns { detected, length,
 * angle, kernel: { size, half, data }, tile } (an identity kernel when nothing significant is found).
 * Exported for tests and for callers that want to show the trace.
 */
export function estimateShakeKernel(img, { traceBounds = 41, rect = null } = {}) {
  const g = region(img, rect), none = { detected: false, length: 0, angle: 0, kernel: lineKernel(0, 0), tile: null };
  if (isEmpty(g)) return none;
  let N = SHAKE_TILE_MAX;
  while (N > Math.min(g.width, g.height)) N >>= 1;
  if (N < SHAKE_TILE_MIN) return none;
  const L = lumaPlane(img, g), gw = g.width, gh = g.height;
  // candidate tiles on a half-tile grid, ranked by gradient energy (the sharpest regions carry the cleanest cepstrum)
  const cands = [];
  const stride = Math.max(1, N >> 1);
  for (let ty = 0; ty + N <= gh; ty += stride) {
    for (let tx = 0; tx + N <= gw; tx += stride) {
      let e = 0;
      for (let y = ty; y < ty + N - 1; y += 2) {
        for (let x = tx, i = y * gw + tx; x < tx + N - 1; x += 2, i += 2) e += Math.abs(L[i + 1] - L[i]) + Math.abs(L[i + gw] - L[i]);
      }
      cands.push({ tx, ty, e });
    }
  }
  if (!cands.length) cands.push({ tx: 0, ty: 0, e: 0 });
  cands.sort((a, b) => b.e - a.e);
  const useN = Math.min(3, cands.length);
  const cep = new Float64Array(N * N), re = new Float64Array(N * N), im = new Float64Array(N * N);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((TAU * (i + 0.5)) / N);
  for (let c = 0; c < useN; c++) {
    const { tx, ty } = cands[c];
    let mean = 0;
    for (let y = 0; y < N; y++) for (let x = 0, i = (ty + y) * gw + tx; x < N; x++, i++) mean += L[i];
    mean /= N * N;
    for (let y = 0; y < N; y++) for (let x = 0, i = (ty + y) * gw + tx, o = y * N; x < N; x++, i++, o++) re[o] = (L[i] - mean) * win[x] * win[y];
    im.fill(0);
    fft2(re, im, N, false);
    let maxP = 0;
    for (let i = 0; i < re.length; i++) {
      const pw = re[i] * re[i] + im[i] * im[i];
      re[i] = pw;
      if (pw > maxP) maxP = pw;
    }
    const eps = maxP * 1e-9 + 1e-12;
    for (let i = 0; i < re.length; i++) re[i] = Math.log(re[i] + eps);
    im.fill(0);
    fft2(re, im, N, true);
    for (let i = 0; i < re.length; i++) cep[i] += re[i] / useN;
  }
  // the strongest negative spike in the annulus 3 <= |q| <= traceBounds (symmetric: search the upper half plane);
  // median / MAD statistics, because image structure gives the cepstrum heavy tails that would swamp a mean / sd test
  const maxQ = Math.min(clampNum(num(traceBounds, 41), 10, 199), (N >> 1) - 2), maxQ2 = maxQ * maxQ;
  const vals = [], qxs = [], qys = [];
  for (let qy = 0; qy <= maxQ; qy++) {
    for (let qx = -maxQ; qx <= maxQ; qx++) {
      if (qy === 0 && qx <= 0) continue;
      const q2 = qx * qx + qy * qy;
      if (q2 < 9 || q2 > maxQ2) continue;
      vals.push(cep[qy * N + ((qx + N) % N)]);
      qxs.push(qx);
      qys.push(qy);
    }
  }
  const cnt = vals.length;
  if (cnt < 8) return none;
  let bi = 0;
  for (let k = 1; k < cnt; k++) if (vals[k] < vals[bi]) bi = k;
  const best = vals[bi], bx = qxs[bi], by = qys[bi];
  const sorted = Float64Array.from(vals).sort(), median = sorted[cnt >> 1];
  const dev = Float64Array.from(vals, (v) => Math.abs(v - median)).sort(), mad = dev[cnt >> 1] * 1.4826 || 1e-12;
  // the runner-up spike at least 3 px away from the winner: a real trace stands clear of the rest
  // (the cepstrum is symmetric, so near the qy = 0 axis the winner's mirror shows up too: skip it as well)
  let second = Infinity;
  for (let k = 0; k < cnt; k++) {
    const dx = qxs[k] - bx, dy = qys[k] - by, mx = qxs[k] + bx, my = qys[k] + by;
    if (dx * dx + dy * dy >= 9 && mx * mx + my * my >= 9 && vals[k] < second) second = vals[k];
  }
  const significance = (median - best) / mad, lead = second < median ? (median - best) / (median - second) : Infinity;
  // a linear blur flattens gradients along the motion: without that anisotropy the spike is image structure, not shake
  const angle = Math.atan2(by, bx) / DEG, ux = Math.cos(angle * DEG), uy = Math.sin(angle * DEG);
  let along = 0, across = 0;
  {
    const { tx, ty } = cands[0];
    for (let y = ty + 1; y < ty + N - 1; y++) {
      for (let x = tx + 1, i = y * gw + tx + 1; x < tx + N - 1; x++, i++) {
        const gx = L[i + 1] - L[i - 1], gy = L[i + gw] - L[i - gw];
        const ga = gx * ux + gy * uy, gc = -gx * uy + gy * ux;
        along += ga * ga; // energy, not magnitude: a ramp keeps a step's total rise, not its energy
        across += gc * gc;
      }
    }
  }
  const anisotropy = along > 0 ? across / along : Infinity;
  if (significance < SHAKE_SIGNIFICANCE || lead < SHAKE_LEAD || anisotropy < SHAKE_ANISOTROPY) return { ...none, tile: cands[0] };
  // sub-pixel refinement along the dominant axis (parabola through the spike and its neighbours)
  let length = Math.sqrt(bx * bx + by * by);
  const at = (qx, qy) => cep[((qy + N) % N) * N + ((qx + N) % N)];
  const ax = Math.abs(bx) >= Math.abs(by) ? Math.sign(bx) || 1 : 0, ay = ax === 0 ? 1 : 0;
  const vm = at(bx - ax, by - ay), v0 = best, vp = at(bx + ax, by + ay), den = vm - 2 * v0 + vp;
  if (den > 1e-12) {
    const off = clampNum((0.5 * (vm - vp)) / den, -0.5, 0.5);
    length = Math.sqrt((bx + off * ax) ** 2 + (by + off * ay) ** 2);
  }
  return { detected: true, length, angle, kernel: lineKernel(length, angle), tile: cands[0] };
}

// noise-to-signal presets: measured on synthetic shakes, below ~1e-2 the restored ringing costs more than the
// recovered detail gains, so 'auto' never goes under it
const NOISE_K = { low: 5e-3, medium: 1.5e-2, high: 5e-2 };
const CLS_A = 1, CLS_B = 4;

/** Wiener noise-to-signal constant: a preset, or 'auto' from the median absolute 3x3 residual of the luma. */
function noiseConstant(img, g, sourceNoise) {
  if (typeof sourceNoise === 'number' && sourceNoise > 0) return sourceNoise; // an explicit noise-to-signal ratio
  if (sourceNoise in NOISE_K) return NOISE_K[sourceNoise];
  const L = lumaPlane(img, g), w = g.width, h = g.height, n = Math.min(4096, (w - 2) * (h - 2));
  if (n <= 0) return NOISE_K.low;
  const res = new Float32Array(n), step = Math.max(1, Math.floor(((w - 2) * (h - 2)) / n));
  for (let k = 0, q = 0; k < n; k++, q += step) {
    const y = 1 + Math.floor(q / (w - 2)), x = 1 + (q % (w - 2)), i = y * w + x;
    const nb = (L[i - 1] + L[i + 1] + L[i - w] + L[i + w] + L[i - w - 1] + L[i - w + 1] + L[i + w - 1] + L[i + w + 1]) / 8;
    res[k] = Math.abs(L[i] - nb);
  }
  res.sort();
  const sigma = (res[n >> 1] * 1.4826) / 255;
  return clampNum(sigma * sigma * 16, 1.2e-2, 5e-2);
}

/**
 * Wiener deconvolution of the straight RGB of img inside r with `kernel`, in overlapping FFT tiles
 * (the pad holds real neighbouring pixels, so the circular wrap only touches discarded borders).
 * Two channels ride one complex FFT (the filter is real, so re/im come back as the two results).
 * Returns an r-sized Float32Array RGB (0..1), alpha untouched.
 */
function wienerDeconvolve(img, r, kernel, K) {
  const pad = kernel.half + 8;
  let N = 128;
  while (N < 4 * pad || N < 256) N <<= 1;
  const core = N - 2 * pad, overlap = Math.min(8, core >> 2), step = core - overlap;
  // the filter W = conj(H) / (|H|^2 + K) for the kernel centred on (0, 0) with wrap
  const hr = new Float64Array(N * N), hi = new Float64Array(N * N);
  for (let y = 0; y < kernel.size; y++) {
    for (let x = 0; x < kernel.size; x++) {
      const v = kernel.data[y * kernel.size + x];
      if (v === 0) continue;
      hr[(((y - kernel.half) % N) + N) % N * N + ((((x - kernel.half) % N) + N) % N)] += v;
    }
  }
  fft2(hr, hi, N, false);
  // constrained least squares: the regulariser grows with |Laplacian|^2, so the high frequencies near the
  // kernel's spectral zeros (where plain Wiener rings in stripes) are damped harder than the low ones
  const lap = new Float64Array(N);
  for (let i = 0; i < N; i++) lap[i] = 2 - 2 * Math.cos((TAU * i) / N);
  for (let v = 0, i = 0; v < N; v++) {
    for (let u = 0; u < N; u++, i++) {
      const P = (lap[u] + lap[v]) / 8, den = hr[i] * hr[i] + hi[i] * hi[i] + K * (CLS_A + CLS_B * P * P);
      hr[i] /= den;
      hi[i] = -hi[i] / den;
    }
  }
  const d = img.data, W = img.width, H = img.height;
  const out = new Float32Array(r.width * r.height * 3), wsum = new Float32Array(r.width * r.height);
  const re = new Float64Array(N * N), im = new Float64Array(N * N);
  const ramp = (t) => (overlap > 0 ? clampNum((t + 1) / (overlap + 1), 0, 1) : 1);
  const gatherAndFilter = (tx, ty, ca, cb) => {
    for (let y = 0; y < N; y++) {
      let yy = ty - pad + y;
      yy = yy < 0 ? 0 : yy >= H ? H - 1 : yy;
      for (let x = 0, o = y * N; x < N; x++, o++) {
        let xx = tx - pad + x;
        xx = xx < 0 ? 0 : xx >= W ? W - 1 : xx;
        const i = (yy * W + xx) * 4;
        re[o] = d[i + ca] / 255;
        im[o] = cb < 0 ? 0 : d[i + cb] / 255;
      }
    }
    fft2(re, im, N, false);
    for (let i = 0; i < re.length; i++) {
      const a = re[i], b = im[i];
      re[i] = a * hr[i] - b * hi[i];
      im[i] = a * hi[i] + b * hr[i];
    }
    fft2(re, im, N, true);
  };
  for (let ty = r.y; ty < r.y + r.height; ty += step) {
    for (let tx = r.x; tx < r.x + r.width; tx += step) {
      const x0 = tx, x1 = Math.min(r.x + r.width, tx + core), y0 = ty, y1 = Math.min(r.y + r.height, ty + core);
      for (let pass = 0; pass < 2; pass++) {
        const ca = pass === 0 ? 0 : 2, cb = pass === 0 ? 1 : -1;
        gatherAndFilter(tx, ty, ca, cb);
        for (let y = y0; y < y1; y++) {
          const wy = Math.min(ramp(y - ty), ramp(ty + core - 1 - y));
          for (let x = x0; x < x1; x++) {
            const wt = wy * Math.min(ramp(x - tx), ramp(tx + core - 1 - x));
            const o = (y - r.y) * r.width + (x - r.x), ti = (y - ty + pad) * N + (x - tx + pad);
            out[o * 3 + ca] += re[ti] * wt;
            if (cb >= 0) out[o * 3 + cb] += im[ti] * wt;
            if (pass === 0) wsum[o] += wt;
          }
        }
      }
    }
  }
  for (let o = 0; o < wsum.length; o++) {
    const inv = wsum[o] > 0 ? 1 / wsum[o] : 0;
    out[o * 3] *= inv;
    out[o * 3 + 1] *= inv;
    out[o * 3 + 2] *= inv;
  }
  return out;
}

function shakeReduction(img, p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const traceBounds = clampNum(num(p.traceBounds, 41), 10, 199);
  const smoothing = clampNum(num(p.smoothing, 30), 0, 100), suppression = clampNum(num(p.artifactSuppression, 30), 0, 100);
  const est = estimateShakeKernel(img, { traceBounds, rect: grow(img, r, traceBounds) });
  if (!est.detected) return img; // a sharp image has nothing to deconvolve
  const K = noiseConstant(img, grow(img, r, 8), p.sourceNoise ?? 'auto');
  const rgb = wienerDeconvolve(img, r, est.kernel, K);
  const d = img.data, W = img.width, out = new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = r.y, o = 0, q = 0; y < r.y + r.height; y++) {
    for (let x = r.x, i = (y * W + r.x) * 4; x < r.x + r.width; x++, i += 4, o += 4, q += 3) {
      out[o] = round8(rgb[q] * 255);
      out[o + 1] = round8(rgb[q + 1] * 255);
      out[o + 2] = round8(rgb[q + 2] * 255);
      out[o + 3] = d[i + 3];
    }
  }
  // the original stays available for the blends below: work on a copy of the region
  const result = { width: r.width, height: r.height, data: out };
  if (smoothing > 0) {
    // ringing damper: a small bilateral pass whose colour threshold grows with the setting
    const b = bilateral(result, { x: 0, y: 0, width: r.width, height: r.height }, 1 + smoothing / 50, 2 + smoothing * 0.25, 1);
    result.data = b;
  }
  if (suppression > 0) {
    // where the original is flat (low local deviation) the deconvolution only adds artefacts: fade it out there;
    // the luma is 3x3-smoothed first so pixel noise does not pass for texture
    const g = grow(img, r, 3), gw = g.width, gh = g.height, vT = 1 + suppression * 0.12;
    const L0 = lumaPlane(img, g), L = new Float32Array(L0.length);
    for (let y = 0; y < gh; y++) {
      const y0 = y > 0 ? y - 1 : 0, y1 = y < gh - 1 ? y + 1 : y;
      for (let x = 0; x < gw; x++) {
        const x0 = x > 0 ? x - 1 : 0, x1 = x < gw - 1 ? x + 1 : x;
        L[y * gw + x] = (L0[y0 * gw + x0] + L0[y0 * gw + x] + L0[y0 * gw + x1] + L0[y * gw + x0] + L0[y * gw + x] + L0[y * gw + x1] + L0[y1 * gw + x0] + L0[y1 * gw + x] + L0[y1 * gw + x1]) / 9;
      }
    }
    const res = result.data;
    for (let y = r.y, o = 0; y < r.y + r.height; y++) {
      for (let x = r.x, i = (y * W + r.x) * 4; x < r.x + r.width; x++, i += 4, o += 4) {
        const cx = x - g.x, cy = y - g.y;
        let s = 0, s2 = 0, n = 0;
        for (let dy = -2; dy <= 2; dy++) {
          const yy = cy + dy;
          if (yy < 0 || yy >= gh) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const xx = cx + dx;
            if (xx < 0 || xx >= gw) continue;
            const v = L[yy * gw + xx];
            s += v;
            s2 += v * v;
            n++;
          }
        }
        const m = s / n, sd = Math.sqrt(Math.max(0, s2 / n - m * m)), w = smoothstep(0, vT, sd);
        if (w >= 1) continue;
        res[o] = round8(d[i] + (res[o] - d[i]) * w);
        res[o + 1] = round8(d[i + 1] + (res[o + 1] - d[i + 1]) * w);
        res[o + 2] = round8(d[i + 2] + (res[o + 2] - d[i + 2]) * w);
      }
    }
  }
  storeOut(img, r, result.data);
  return img;
}

// ---------------------------------------------------------------------------------------------
// Color Halftone, Facet, Mezzotint

function colorHalftone(img, p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const R = Math.round(clampNum(num(p.radius, 8), 4, 127)), S = 2 * R;
  const anglesIn = Array.isArray(p.angles) ? p.angles : [108, 162, 90, 45];
  const cosA = [], sinA = [];
  for (let c = 0; c < 4; c++) {
    const a = num(anglesIn[c], [108, 162, 90, 45][c]) * DEG;
    cosA.push(Math.cos(a));
    sinA.push(Math.sin(a));
  }
  const W = img.width, H = img.height, d = img.data, cx = W / 2, cy = H / 2;
  // cell grids per ink: the whole footprint of every cell a dot near r can come from lies within 3 cells of r
  const g = grow(img, r, 3 * S);
  const grids = [];
  for (let c = 0; c < 4; c++) {
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [px, py] of [[g.x, g.y], [g.x + g.width, g.y], [g.x, g.y + g.height], [g.x + g.width, g.y + g.height]]) {
      const u = (px - cx) * cosA[c] + (py - cy) * sinA[c], v = -(px - cx) * sinA[c] + (py - cy) * cosA[c];
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const cu0 = Math.floor(u0 / S) - 1, cv0 = Math.floor(v0 / S) - 1, nu = Math.floor(u1 / S) - cu0 + 2, nv = Math.floor(v1 / S) - cv0 + 2;
    grids.push({ cu0, cv0, nu, nv, sum: new Float64Array(nu * nv), cnt: new Float64Array(nu * nv) });
  }
  const ink = new Float64Array(4);
  const toCmyk = (i) => {
    const Rv = d[i] / 255, Gv = d[i + 1] / 255, Bv = d[i + 2] / 255, k = 1 - Math.max(Rv, Gv, Bv);
    if (k >= 1 - 1e-9) {
      ink[0] = ink[1] = ink[2] = 0;
      ink[3] = 1;
      return;
    }
    const inv = 1 / (1 - k);
    ink[0] = (1 - Rv - k) * inv;
    ink[1] = (1 - Gv - k) * inv;
    ink[2] = (1 - Bv - k) * inv;
    ink[3] = k;
  };
  for (let y = g.y; y < g.y + g.height; y++) {
    for (let x = g.x, i = (y * W + g.x) * 4; x < g.x + g.width; x++, i += 4) {
      const a = d[i + 3] / 255;
      if (a === 0) continue;
      toCmyk(i);
      const px = x + 0.5 - cx, py = y + 0.5 - cy;
      for (let c = 0; c < 4; c++) {
        const gr = grids[c], u = px * cosA[c] + py * sinA[c], v = -px * sinA[c] + py * cosA[c];
        const cu = Math.floor(u / S) - gr.cu0, cv = Math.floor(v / S) - gr.cv0;
        if (cu < 0 || cv < 0 || cu >= gr.nu || cv >= gr.nv) continue;
        const ci = cv * gr.nu + cu;
        gr.sum[ci] += ink[c] * a;
        gr.cnt[ci] += a;
      }
    }
  }
  const out = new Uint8ClampedArray(r.width * r.height * 4), invPi = 1 / Math.PI;
  for (let y = r.y, o = 0; y < r.y + r.height; y++) {
    for (let x = r.x, i = (y * W + r.x) * 4; x < r.x + r.width; x++, i += 4, o += 4) {
      const px = x + 0.5 - cx, py = y + 0.5 - cy;
      for (let c = 0; c < 4; c++) {
        const gr = grids[c], u = px * cosA[c] + py * sinA[c], v = -px * sinA[c] + py * cosA[c];
        const cu = Math.floor(u / S), cv = Math.floor(v / S);
        let cover = 0;
        for (let dv = -1; dv <= 1; dv++) {
          for (let du = -1; du <= 1; du++) {
            const iu = cu + du - gr.cu0, iv = cv + dv - gr.cv0;
            if (iu < 0 || iv < 0 || iu >= gr.nu || iv >= gr.nv) continue;
            const ci = iv * gr.nu + iu, n = gr.cnt[ci];
            if (n === 0) continue;
            const mean = gr.sum[ci] / n;
            if (mean <= 0) continue;
            const rad = S * Math.sqrt(mean * invPi); // dot area = coverage x cell area
            const ccx = (cu + du + 0.5) * S, ccy = (cv + dv + 0.5) * S;
            const dist = Math.sqrt((u - ccx) * (u - ccx) + (v - ccy) * (v - ccy));
            const cov = clampNum(rad - dist + 0.5, 0, 1);
            if (cov > cover) cover = cov;
          }
        }
        ink[c] = cover;
      }
      const kk = 1 - ink[3];
      out[o] = round8(255 * (1 - ink[0]) * kk);
      out[o + 1] = round8(255 * (1 - ink[1]) * kk);
      out[o + 2] = round8(255 * (1 - ink[2]) * kk);
      out[o + 3] = d[i + 3];
    }
  }
  storeOut(img, r, out);
  return img;
}

const FACET_DX = Int32Array.of(-1, 0, 1, -1, 0, 1, -1, 0, 1), FACET_DY = Int32Array.of(-1, -1, -1, 0, 0, 0, 1, 1, 1);

function facet(img, _p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const d = img.data, W = img.width, H = img.height, out = new Uint8ClampedArray(r.width * r.height * 4);
  const keys = new Int32Array(9), idx = new Int32Array(9);
  for (let y = r.y, o = 0; y < r.y + r.height; y++) {
    for (let x = r.x, i = (y * W + r.x) * 4; x < r.x + r.width; x++, i += 4, o += 4) {
      out[o + 3] = d[i + 3];
      if (d[i + 3] === 0) {
        out[o] = d[i];
        out[o + 1] = d[i + 1];
        out[o + 2] = d[i + 2];
        continue;
      }
      let n = 0;
      for (let t = 0; t < 9; t++) {
        let xx = x + FACET_DX[t], yy = y + FACET_DY[t];
        xx = xx < 0 ? 0 : xx >= W ? W - 1 : xx;
        yy = yy < 0 ? 0 : yy >= H ? H - 1 : yy;
        const j = (yy * W + xx) * 4;
        if (d[j + 3] === 0) continue;
        // 5 levels per channel (51.2 wide) -> 125 bins
        keys[n] = ((d[j] / 51.2) | 0) * 25 + ((d[j + 1] / 51.2) | 0) * 5 + ((d[j + 2] / 51.2) | 0);
        idx[n] = j;
        n++;
      }
      // the most common bin (ties: the first one met, which scans top-left first)
      let bestKey = keys[0], bestCount = 0;
      for (let a = 0; a < n; a++) {
        let c = 0;
        for (let b = 0; b < n; b++) if (keys[b] === keys[a]) c++;
        if (c > bestCount) {
          bestCount = c;
          bestKey = keys[a];
        }
      }
      let sr = 0, sg = 0, sb = 0, sa = 0;
      for (let t = 0; t < n; t++) {
        if (keys[t] !== bestKey) continue;
        const j = idx[t], a = d[j + 3];
        sr += d[j] * a;
        sg += d[j + 1] * a;
        sb += d[j + 2] * a;
        sa += a;
      }
      out[o] = round8(sr / sa);
      out[o + 1] = round8(sg / sa);
      out[o + 2] = round8(sb / sa);
    }
  }
  storeOut(img, r, out);
  return img;
}

/** Photoshop's ten Mezzotint patterns: dots are cells, lines are horizontal runs, strokes are runs in slightly sloped 3-row bands. */
const MEZZOTINT_TYPES = Object.freeze({
  'fine-dots': { cell: 1 }, 'medium-dots': { cell: 2 }, 'grainy-dots': { cell: 3 }, 'coarse-dots': { cell: 4 },
  'short-lines': { len: 4 }, 'medium-lines': { len: 8 }, 'long-lines': { len: 16 },
  'short-strokes': { len: 6, stroke: true }, 'medium-strokes': { len: 12, stroke: true }, 'long-strokes': { len: 24, stroke: true },
});

function mezzotint(img, p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const t = MEZZOTINT_TYPES[p.type] ?? MEZZOTINT_TYPES['medium-dots'], seed = num(p.seed, 1) | 0;
  const d = img.data, W = img.width;
  for (let y = r.y; y < r.y + r.height; y++) {
    for (let x = r.x, i = (y * W + r.x) * 4; x < r.x + r.width; x++, i += 4) {
      if (d[i + 3] === 0) continue;
      let th;
      if (t.cell) th = hashUnit(Math.floor(x / t.cell), Math.floor(y / t.cell), seed);
      else if (!t.stroke) {
        // runs of len px per row, each row's grid shifted by a random phase
        const phase = hash3(y, 0x5137, seed) % t.len;
        th = hashUnit(Math.floor((x + phase) / t.len), y, seed + 1);
      } else {
        // 3-row bands whose runs drift by -1, 0 or +1 px per row, so strokes lean a little
        const band = Math.floor(y / 3), slope = (hash3(band, 0x2b31, seed) % 3) - 1, phase = hash3(band, 0x7a19, seed) % t.len;
        th = hashUnit(Math.floor((x + slope * (y - band * 3) + phase) / t.len), y, seed + 2);
      }
      // one threshold for the three channels: greys stay black or white, colours turn into saturated primaries
      const T = th * 255;
      d[i] = d[i] > T ? 255 : 0;
      d[i + 1] = d[i + 1] > T ? 255 : 0;
      d[i + 2] = d[i + 2] > T ? 255 : 0;
    }
  }
  return img;
}

// ---------------------------------------------------------------------------------------------
// De-Interlace, NTSC Colors

function deInterlace(img, p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const odd = p.eliminate !== 'even', interp = p.method !== 'duplication';
  const d = img.data, W = img.width, H = img.height, row = r.width * 4;
  for (let y = r.y; y < r.y + r.height; y++) {
    if ((y & 1) !== (odd ? 1 : 0)) continue; // a kept row
    const up = y - 1 >= 0 ? y - 1 : y + 1 < H ? y + 1 : -1, dn = y + 1 < H ? y + 1 : y - 1 >= 0 ? y - 1 : -1;
    if (up < 0) continue; // a 1 px tall image has no other field
    const dst = (y * W + r.x) * 4, su = (up * W + r.x) * 4, sd = (dn * W + r.x) * 4;
    if (!interp || up === dn) {
      d.copyWithin(dst, su, su + row);
      continue;
    }
    for (let k = 0; k < row; k += 4) {
      const a0 = d[su + k + 3], a1 = d[sd + k + 3], sa = a0 + a1;
      if (sa === 0) {
        d[dst + k] = round8((d[su + k] + d[sd + k]) / 2);
        d[dst + k + 1] = round8((d[su + k + 1] + d[sd + k + 1]) / 2);
        d[dst + k + 2] = round8((d[su + k + 2] + d[sd + k + 2]) / 2);
      } else {
        d[dst + k] = round8((d[su + k] * a0 + d[sd + k] * a1) / sa);
        d[dst + k + 1] = round8((d[su + k + 1] * a0 + d[sd + k + 1] * a1) / sa);
        d[dst + k + 2] = round8((d[su + k + 2] * a0 + d[sd + k + 2] * a1) / sa);
      }
      d[dst + k + 3] = round8(sa / 2);
    }
  }
  return img;
}

const NTSC_Y_MIN = 16 / 255, NTSC_Y_MAX = 235 / 255;

function ntscColors(img, _p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const d = img.data, W = img.width;
  for (let y = r.y; y < r.y + r.height; y++) {
    for (let x = r.x, i = (y * W + r.x) * 4; x < r.x + r.width; x++, i += 4) {
      const R = d[i] / 255, G = d[i + 1] / 255, B = d[i + 2] / 255;
      let Y = 0.299 * R + 0.587 * G + 0.114 * B, I = 0.596 * R - 0.274 * G - 0.322 * B, Q = 0.211 * R - 0.523 * G + 0.312 * B;
      Y = clampNum(Y, NTSC_Y_MIN, NTSC_Y_MAX);
      // the composite signal must stay within -20 .. 120 IRE: chroma amplitude limited by the luma headroom
      const C = Math.sqrt(I * I + Q * Q), cMax = Math.min(1.2 - Y, Y + 0.2);
      if (C > cMax) {
        const s = cMax / C;
        I *= s;
        Q *= s;
      }
      d[i] = round8((Y + 0.956 * I + 0.621 * Q) * 255);
      d[i + 1] = round8((Y - 0.272 * I - 0.647 * Q) * 255);
      d[i + 2] = round8((Y - 1.106 * I + 1.703 * Q) * 255);
    }
  }
  return img;
}

// ---------------------------------------------------------------------------------------------
// HSB/HSL

const SPACES = ['rgb', 'hsb', 'hsl'];

function hsbHsl(img, p, rect) {
  const r = region(img, rect);
  const from = SPACES.includes(p.from) ? p.from : 'rgb', to = SPACES.includes(p.to) ? p.to : 'hsb';
  if (isEmpty(r) || from === to) return img;
  const d = img.data, W = img.width;
  for (let y = r.y; y < r.y + r.height; y++) {
    for (let x = r.x, i = (y * W + r.x) * 4; x < r.x + r.width; x++, i += 4) {
      // the stored triple is read as `from` (hue 0..255 -> 0..360, the others 0..255 -> 0..1) ...
      let rgb;
      if (from === 'rgb') rgb = [d[i], d[i + 1], d[i + 2]];
      else if (from === 'hsb') rgb = hsvToRgb((d[i] / 255) * 360, d[i + 1] / 255, d[i + 2] / 255);
      else rgb = hslToRgb((d[i] / 255) * 360, d[i + 1] / 255, d[i + 2] / 255);
      // ... and written back as `to` in the same encoding
      let o;
      if (to === 'rgb') o = rgb;
      else {
        const c = to === 'hsb' ? rgbToHsv(rgb[0], rgb[1], rgb[2]) : rgbToHsl(rgb[0], rgb[1], rgb[2]);
        o = [(c[0] / 360) * 255, c[1] * 255, c[2] * 255];
      }
      d[i] = round8(o[0]);
      d[i + 1] = round8(o[1]);
      d[i + 2] = round8(o[2]);
    }
  }
  return img;
}

// ---------------------------------------------------------------------------------------------
// Dialog fields (lib/form.js specs; keys are parameter paths) and the table

const S = (key, label, min, max, step = 1, extra = {}) => ({ key, label, type: 'slider', min, max, step, ...extra });
const SEED = { key: 'seed', label: 'Seed', type: 'number', min: 0, max: 99999 };

const LENS_BLUR_FIELDS = [
  { key: 'source', label: 'Depth map source', type: 'select', options: [['none', 'None'], ['transparency', 'Layer transparency'], ['mask', 'Layer mask'], ['alpha', 'Alpha channel']] },
  S('focalDistance', 'Blur focal distance', 0, 255),
  { key: 'invert', label: 'Invert depth map', type: 'checkbox' },
  { type: 'section', label: 'Iris' },
  { key: 'shape', label: 'Shape', type: 'select', options: Object.keys(APERTURE_SIDES).map((k) => [k, k[0].toUpperCase() + k.slice(1) + ` (${APERTURE_SIDES[k]})`]) },
  S('radius', 'Radius', 0, 100),
  S('bladeCurvature', 'Blade curvature', 0, 100),
  S('rotation', 'Rotation', 0, 360, 1, { unit: '°' }),
  { type: 'section', label: 'Specular highlights' },
  S('brightness', 'Brightness', 0, 100),
  S('threshold', 'Threshold', 0, 255),
  { type: 'section', label: 'Noise' },
  S('noise', 'Amount', 0, 100),
  { key: 'distribution', label: 'Distribution', type: 'segment', options: [['uniform', 'Uniform'], ['gaussian', 'Gaussian']] },
  { key: 'monochromatic', label: 'Monochromatic', type: 'checkbox' },
];

const SHAPE_BLUR_FIELDS = [
  S('radius', 'Radius', 1, 1000, 1, { unit: 'px' }),
  { key: 'shape', label: 'Shape', type: 'select', options: SHAPE_BLUR_SHAPES.map((s) => [s.id, s.name]) },
];

const SMART_BLUR_FIELDS = [
  S('radius', 'Radius', 0.1, 100, 0.1, { unit: 'px' }),
  S('threshold', 'Threshold', 0.1, 100, 0.1),
  { key: 'quality', label: 'Quality', type: 'segment', options: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] },
  { key: 'mode', label: 'Mode', type: 'select', options: [['normal', 'Normal'], ['edge-only', 'Edge Only'], ['overlay-edge', 'Overlay Edge']] },
];

const SHAKE_FIELDS = [
  S('traceBounds', 'Blur trace bounds', 10, 199, 1, { unit: 'px' }),
  { key: 'sourceNoise', label: 'Source noise', type: 'select', options: [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] },
  S('smoothing', 'Smoothing', 0, 100, 1, { unit: '%' }),
  S('artifactSuppression', 'Artifact suppression', 0, 100, 1, { unit: '%' }),
];

const HALFTONE_FIELDS = [
  S('radius', 'Max. radius', 4, 127, 1, { unit: 'px' }),
  { key: 'angles.0', label: 'Channel 1 (cyan)', type: 'number', min: -360, max: 360, unit: '°' },
  { key: 'angles.1', label: 'Channel 2 (magenta)', type: 'number', min: -360, max: 360, unit: '°' },
  { key: 'angles.2', label: 'Channel 3 (yellow)', type: 'number', min: -360, max: 360, unit: '°' },
  { key: 'angles.3', label: 'Channel 4 (black)', type: 'number', min: -360, max: 360, unit: '°' },
];

const MEZZOTINT_FIELDS = [
  { key: 'type', label: 'Type', type: 'select', options: Object.keys(MEZZOTINT_TYPES).map((k) => [k, k.replace('-', ' ').replace(/\b\w/g, (c) => c.toUpperCase())]) },
  SEED,
];

const DEINTERLACE_FIELDS = [
  { key: 'eliminate', label: 'Eliminate', type: 'segment', options: [['odd', 'Odd fields'], ['even', 'Even fields']] },
  { key: 'method', label: 'Create new fields by', type: 'segment', options: [['duplication', 'Duplication'], ['interpolation', 'Interpolation']] },
];

const SPACE_OPTIONS = [['rgb', 'RGB'], ['hsb', 'HSB'], ['hsl', 'HSL']];
const HSB_HSL_FIELDS = [
  { key: 'from', label: 'Input mode', type: 'segment', options: SPACE_OPTIONS },
  { key: 'to', label: 'Output mode', type: 'segment', options: SPACE_OPTIONS },
];

/**
 * Part A of the 0.3 Filter menu kinds (see the contract in ARCHITECTURE.md "Filters, part A"):
 * blur: average {}, blur {}, blur-more {}, lens-blur { radius, shape, bladeCurvature, rotation, brightness, threshold,
 *   noise, distribution, monochromatic, source, depthMap, focalDistance, invert } (ui 'custom': lib/filters-a-ui.js
 *   supplies the depth map; without one the whole region blurs at `radius`), shape-blur { radius, shape },
 *   smart-blur { radius, threshold, quality, mode };
 * sharpen: sharpen-edges {}, sharpen-more {}, shake-reduction { traceBounds, sourceNoise, smoothing, artifactSuppression };
 * pixelate: color-halftone { radius, angles }, facet {}, mezzotint { type, seed };
 * video: de-interlace { eliminate, method }, ntsc-colors {}; other: hsb-hsl { from, to }.
 */
export const FILTERS_MORE_A = Object.freeze({
  // blur
  average: defineFilter('Average', 'blur', {}, average, { direct: true }),
  blur: defineFilter('Blur', 'blur', {}, (img, _p, rect) => blur121(img, rect, 1), { direct: true, margin: 1 }),
  'blur-more': defineFilter('Blur More', 'blur', {}, (img, _p, rect) => blur121(img, rect, 3), { direct: true, margin: 3 }),
  'lens-blur': defineFilter('Lens Blur', 'blur',
    { radius: 15, shape: 'hexagon', bladeCurvature: 0, rotation: 0, brightness: 0, threshold: 255, noise: 0, distribution: 'uniform', monochromatic: false, source: 'none', depthMap: null, focalDistance: 0, invert: false },
    lensBlur, { ui: 'custom', fields: LENS_BLUR_FIELDS, margin: (p) => clampNum(num(p.radius, 15), 0, 100) + 2 }),
  'shape-blur': defineFilter('Shape Blur', 'blur', { radius: 5, shape: 'circle' }, shapeBlur, { fields: SHAPE_BLUR_FIELDS, margin: (p) => clampNum(num(p.radius, 5), 1, 1000) + 1 }),
  'smart-blur': defineFilter('Smart Blur', 'blur', { radius: 3, threshold: 25, quality: 'medium', mode: 'normal' }, smartBlur, { fields: SMART_BLUR_FIELDS, margin: (p) => clampNum(num(p.radius, 3), 0, 100) + 2 }),
  // sharpen
  'sharpen-edges': defineFilter('Sharpen Edges', 'sharpen', {}, sharpenEdges, { direct: true, margin: 3 }),
  'sharpen-more': defineFilter('Sharpen More', 'sharpen', {}, sharpenMore, { direct: true, margin: 4 }),
  'shake-reduction': defineFilter('Shake Reduction', 'sharpen', { traceBounds: 41, sourceNoise: 'auto', smoothing: 30, artifactSuppression: 30 }, shakeReduction,
    { fields: SHAKE_FIELDS, margin: (p) => clampNum(num(p.traceBounds, 41), 10, 199) + 8 }),
  // pixelate
  'color-halftone': defineFilter('Color Halftone', 'pixelate', { radius: 8, angles: [108, 162, 90, 45] }, colorHalftone, { fields: HALFTONE_FIELDS, margin: (p) => clampNum(num(p.radius, 8), 4, 127) * 6 }),
  facet: defineFilter('Facet', 'pixelate', {}, facet, { direct: true, margin: 1 }),
  mezzotint: defineFilter('Mezzotint', 'pixelate', { type: 'medium-dots', seed: 1 }, mezzotint, { fields: MEZZOTINT_FIELDS }),
  // video
  'de-interlace': defineFilter('De-Interlace', 'video', { eliminate: 'odd', method: 'interpolation' }, deInterlace, { fields: DEINTERLACE_FIELDS, margin: 1 }),
  'ntsc-colors': defineFilter('NTSC Colors', 'video', {}, ntscColors, { direct: true }),
  // other
  'hsb-hsl': defineFilter('HSB/HSL', 'other', { from: 'rgb', to: 'hsb' }, hsbHsl, { fields: HSB_HSL_FIELDS }),
});
