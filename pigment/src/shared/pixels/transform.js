// Geometric transforms on ImageDataLike: affine and perspective resampling, high-quality resize,
// exact 90° rotations and flips, matrix helpers. Interpolation is done on premultiplied colour so
// transparent pixels never bleed dark fringes.
import { createImage, contentBounds } from './core.js';

/** Matrix [a, b, c, d, e, f]: x' = a*x + c*y + e, y' = b*x + d*y + f (Canvas/DOMMatrix order). */
export const IDENTITY = [1, 0, 0, 1, 0, 0];

export function multiplyMatrix(m, n) {
  // m ∘ n: apply n first, then m
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}

export function invertMatrix(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) throw new Error('The transform cannot be inverted (zero scale)');
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export function applyMatrix(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/**
 * Builds a matrix from parts applied around an origin: scale, then skew (radians), then rotate
 * (radians), then translate. { translate: [x,y], scale: [sx,sy] | s, rotate, skew: [kx,ky], origin: [ox,oy] }
 */
export function matrixFrom({ translate = [0, 0], scale = [1, 1], rotate = 0, skew = [0, 0], origin = [0, 0] } = {}) {
  const [sx, sy] = Array.isArray(scale) ? scale : [scale, scale];
  const [ox, oy] = origin;
  let m = [1, 0, 0, 1, -ox, -oy];
  m = multiplyMatrix([sx, 0, 0, sy, 0, 0], m);
  m = multiplyMatrix([1, Math.tan(skew[1]), Math.tan(skew[0]), 1, 0, 0], m);
  const cos = Math.cos(rotate), sin = Math.sin(rotate);
  m = multiplyMatrix([cos, sin, -sin, cos, 0, 0], m);
  m = multiplyMatrix([1, 0, 0, 1, ox + translate[0], oy + translate[1]], m);
  return m;
}

/** Axis-aligned bounds of a transformed rect. */
export function transformBounds(m, rect) {
  const pts = [[rect.x, rect.y], [rect.x + rect.width, rect.y], [rect.x, rect.y + rect.height], [rect.x + rect.width, rect.y + rect.height]].map(([x, y]) => applyMatrix(m, x, y));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x = Math.floor(Math.min(...xs) + 1e-9), y = Math.floor(Math.min(...ys) + 1e-9);
  return { x, y, width: Math.ceil(Math.max(...xs) - 1e-9) - x, height: Math.ceil(Math.max(...ys) - 1e-9) - y };
}

// ---- samplers on premultiplied float data -------------------------------------------------------------

function toPremultipliedFloat(img) {
  const d = img.data;
  const f = new Float32Array(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    f[i] = d[i] * a;
    f[i + 1] = d[i + 1] * a;
    f[i + 2] = d[i + 2] * a;
    f[i + 3] = d[i + 3];
  }
  return f;
}

function writePremultiplied(out, o, r, g, b, a) {
  if (a <= 0.5) {
    out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
    return;
  }
  const k = 255 / a;
  out[o] = r * k;
  out[o + 1] = g * k;
  out[o + 2] = b * k;
  out[o + 3] = a;
}

const cubic = (x) => {
  // Catmull-Rom (a = -0.5)
  const ax = Math.abs(x);
  if (ax < 1) return 1.5 * ax * ax * ax - 2.5 * ax * ax + 1;
  if (ax < 2) return -0.5 * ax * ax * ax + 2.5 * ax * ax - 4 * ax + 2;
  return 0;
};

/** Samples premultiplied float data at a source position (pixel centres at +0.5). */
function makeSampler(img, quality) {
  const w = img.width, h = img.height;
  const f = toPremultipliedFloat(img);
  const acc = [0, 0, 0, 0];
  if (quality === 'nearest') {
    return (sx, sy) => {
      const x = Math.floor(sx), y = Math.floor(sy);
      if (x < 0 || y < 0 || x >= w || y >= h) return null;
      const i = (y * w + x) * 4;
      acc[0] = f[i];
      acc[1] = f[i + 1];
      acc[2] = f[i + 2];
      acc[3] = f[i + 3];
      return acc;
    };
  }
  if (quality === 'bicubic') {
    return (sx, sy) => {
      const fx = sx - 0.5, fy = sy - 0.5;
      if (fx <= -2 || fy <= -2 || fx >= w + 1 || fy >= h + 1) return null;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      acc[0] = acc[1] = acc[2] = acc[3] = 0;
      let wsum = 0;
      for (let j = -1; j <= 2; j++) {
        const yy = y0 + j;
        const wy = cubic(fy - yy);
        if (!wy) continue;
        const cy = yy < 0 ? 0 : yy >= h ? h - 1 : yy;
        const outY = yy < 0 || yy >= h;
        for (let i = -1; i <= 2; i++) {
          const xx = x0 + i;
          const wx = cubic(fx - xx);
          if (!wx) continue;
          const wgt = wx * wy;
          wsum += wgt;
          if (outY || xx < 0 || xx >= w) continue; // outside contributes transparent
          const p = (cy * w + xx) * 4;
          acc[0] += f[p] * wgt;
          acc[1] += f[p + 1] * wgt;
          acc[2] += f[p + 2] * wgt;
          acc[3] += f[p + 3] * wgt;
        }
      }
      if (wsum && Math.abs(wsum - 1) > 1e-6) for (let k = 0; k < 4; k++) acc[k] /= wsum;
      return acc;
    };
  }
  // bilinear
  return (sx, sy) => {
    const fx = sx - 0.5, fy = sy - 0.5;
    if (fx <= -1 || fy <= -1 || fx >= w || fy >= h) return null;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    acc[0] = acc[1] = acc[2] = acc[3] = 0;
    for (let j = 0; j < 2; j++) {
      const yy = y0 + j;
      if (yy < 0 || yy >= h) continue;
      const wy = j ? ty : 1 - ty;
      for (let i = 0; i < 2; i++) {
        const xx = x0 + i;
        if (xx < 0 || xx >= w) continue;
        const wgt = wy * (i ? tx : 1 - tx);
        if (!wgt) continue;
        const p = (yy * w + xx) * 4;
        acc[0] += f[p] * wgt;
        acc[1] += f[p + 1] * wgt;
        acc[2] += f[p + 2] * wgt;
        acc[3] += f[p + 3] * wgt;
      }
    }
    return acc;
  };
}

/**
 * Resamples img through an affine matrix (source -> destination) into a new image covering
 * outRect (destination coordinates). Inverse mapping: each destination pixel centre is mapped
 * back into the source and sampled.
 */
export function resample(img, matrix, outRect, { quality = 'bilinear' } = {}) {
  const inv = invertMatrix(matrix);
  const out = createImage(outRect.width, outRect.height);
  const od = out.data;
  const sample = makeSampler(img, quality);
  // exact integer translations/flips are a plain copy
  for (let y = 0; y < outRect.height; y++) {
    const dy = outRect.y + y + 0.5;
    for (let x = 0; x < outRect.width; x++) {
      const dx = outRect.x + x + 0.5;
      const sx = inv[0] * dx + inv[2] * dy + inv[4];
      const sy = inv[1] * dx + inv[3] * dy + inv[5];
      const s = sample(sx, sy);
      if (!s) continue;
      writePremultiplied(od, (y * outRect.width + x) * 4, s[0], s[1], s[2], s[3]);
    }
  }
  return out;
}

/** Solves the homography mapping 4 source points to 4 destination points. Returns 3x3 row-major. */
export function homography(src, dst) {
  // unknowns h0..h7 (h8 = 1): dx = (h0 x + h1 y + h2) / (h6 x + h7 y + 1), dy = (h3 x + h4 y + h5) / (...)
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(A, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) throw new Error('The corner points are degenerate (three in a line)');
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      if (!f) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export function invertHomography(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error('The perspective cannot be inverted');
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

export function applyHomography(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/**
 * Perspective warp: maps the source quad (4 points in img coordinates, clockwise from top-left)
 * onto the destination quad, producing an image covering outRect (destination coordinates).
 */
export function perspective(img, srcQuad, dstQuad, outRect, { quality = 'bilinear' } = {}) {
  const Hinv = homography(dstQuad, srcQuad); // destination -> source
  const out = createImage(outRect.width, outRect.height);
  const od = out.data;
  const sample = makeSampler(img, quality);
  for (let y = 0; y < outRect.height; y++) {
    const dy = outRect.y + y + 0.5;
    for (let x = 0; x < outRect.width; x++) {
      const dx = outRect.x + x + 0.5;
      const w = Hinv[6] * dx + Hinv[7] * dy + Hinv[8];
      if (w <= 0) continue;
      const sx = (Hinv[0] * dx + Hinv[1] * dy + Hinv[2]) / w;
      const sy = (Hinv[3] * dx + Hinv[4] * dy + Hinv[5]) / w;
      const s = sample(sx, sy);
      if (!s) continue;
      writePremultiplied(od, (y * outRect.width + x) * 4, s[0], s[1], s[2], s[3]);
    }
  }
  return out;
}

// ---- resize ---------------------------------------------------------------------------------------------------

const KERNELS = {
  nearest: { support: 0.5, fn: (x) => (x >= -0.5 && x < 0.5 ? 1 : 0) },
  bilinear: { support: 1, fn: (x) => Math.max(0, 1 - Math.abs(x)) },
  bicubic: { support: 2, fn: cubic },
  lanczos: { support: 3, fn: (x) => (x === 0 ? 1 : Math.abs(x) >= 3 ? 0 : (3 * Math.sin(Math.PI * x) * Math.sin((Math.PI * x) / 3)) / (Math.PI * Math.PI * x * x)) },
};

/** Precomputes 1-D filter weights for scaling `src` samples to `dst` samples. */
function weights(src, dst, method) {
  const scale = dst / src;
  const list = new Array(dst);
  if (method === 'area' || (method !== 'nearest' && scale < 1 && method === 'area')) {
    for (let i = 0; i < dst; i++) {
      const a = i / scale, b = (i + 1) / scale;
      const start = Math.floor(a), end = Math.min(src, Math.ceil(b));
      const idx = [], w = [];
      for (let j = start; j < end; j++) {
        const overlap = Math.min(b, j + 1) - Math.max(a, j);
        if (overlap > 0) {
          idx.push(j);
          w.push(overlap);
        }
      }
      list[i] = normalize(idx, w);
    }
    return list;
  }
  if (method === 'nearest') {
    for (let i = 0; i < dst; i++) list[i] = { idx: [Math.min(src - 1, Math.floor((i + 0.5) / scale))], w: [1] };
    return list;
  }
  const k = KERNELS[method] ?? KERNELS.bilinear;
  const filterScale = Math.max(1, 1 / scale); // widen the kernel when downscaling (anti-aliasing)
  const support = k.support * filterScale;
  for (let i = 0; i < dst; i++) {
    const center = (i + 0.5) / scale;
    const start = Math.max(0, Math.floor(center - support)), end = Math.min(src, Math.ceil(center + support));
    const idx = [], w = [];
    for (let j = start; j < end; j++) {
      const wt = k.fn((j + 0.5 - center) / filterScale);
      if (wt) {
        idx.push(j);
        w.push(wt);
      }
    }
    if (!idx.length) {
      idx.push(Math.min(src - 1, Math.max(0, Math.floor(center))));
      w.push(1);
    }
    list[i] = normalize(idx, w);
  }
  return list;
}

function normalize(idx, w) {
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  return { idx, w: w.map((x) => x / sum) };
}

/**
 * Resizes an image (separable, premultiplied). method: nearest | bilinear | bicubic | lanczos | area.
 * 'area' averages exactly the source pixels each destination pixel covers (best for downscaling).
 */
export function resize(img, newW, newH, { method = 'bicubic' } = {}) {
  const W = Math.max(1, Math.round(newW)), H = Math.max(1, Math.round(newH));
  const sw = img.width, sh = img.height;
  if (W === sw && H === sh) return { width: sw, height: sh, data: new Uint8ClampedArray(img.data) };
  const f = toPremultipliedFloat(img);
  const wx = weights(sw, W, method), wy = weights(sh, H, method);
  // horizontal pass: sh x W
  const tmp = new Float32Array(sh * W * 4);
  for (let y = 0; y < sh; y++) {
    const row = y * sw * 4;
    for (let x = 0; x < W; x++) {
      const { idx, w } = wx[x];
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < idx.length; k++) {
        const p = row + idx[k] * 4, wt = w[k];
        r += f[p] * wt;
        g += f[p + 1] * wt;
        b += f[p + 2] * wt;
        a += f[p + 3] * wt;
      }
      const o = (y * W + x) * 4;
      tmp[o] = r;
      tmp[o + 1] = g;
      tmp[o + 2] = b;
      tmp[o + 3] = a;
    }
  }
  const out = createImage(W, H);
  const od = out.data;
  for (let y = 0; y < H; y++) {
    const { idx, w } = wy[y];
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < idx.length; k++) {
        const p = (idx[k] * W + x) * 4, wt = w[k];
        r += tmp[p] * wt;
        g += tmp[p + 1] * wt;
        b += tmp[p + 2] * wt;
        a += tmp[p + 3] * wt;
      }
      writePremultiplied(od, (y * W + x) * 4, r, g, b, Math.min(255, Math.max(0, a)));
    }
  }
  return out;
}

// ---- exact pixel moves ------------------------------------------------------------------------------------------

function remap(img, W, H, srcIndex) {
  const out = createImage(W, H);
  const s = new Uint32Array(img.data.buffer, img.data.byteOffset, img.width * img.height);
  const o = new Uint32Array(out.data.buffer);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) o[y * W + x] = s[srcIndex(x, y)];
  return out;
}

/** 90° clockwise. */
export const rotate90 = (img) => remap(img, img.height, img.width, (x, y) => (img.height - 1 - x) * img.width + y);
export const rotate180 = (img) => remap(img, img.width, img.height, (x, y) => (img.height - 1 - y) * img.width + (img.width - 1 - x));
/** 90° counter-clockwise. */
export const rotate270 = (img) => remap(img, img.height, img.width, (x, y) => x * img.width + (img.width - 1 - y));
export const flipH = (img) => remap(img, img.width, img.height, (x, y) => y * img.width + (img.width - 1 - x));
export const flipV = (img) => remap(img, img.width, img.height, (x, y) => (img.height - 1 - y) * img.width + x);

export { contentBounds };
