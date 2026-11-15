// Shared helpers for every pixel module. Everything here works on ImageDataLike objects
// ({ width, height, data: Uint8ClampedArray RGBA, straight alpha }) so it runs in the renderer,
// in the pixel worker and in Node tests alike. No DOM, no canvas.

/** @typedef {{ width: number, height: number, data: Uint8ClampedArray }} ImageDataLike */
/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */
/** @typedef {[number, number, number, number]} RGBA  r,g,b 0..255 and a 0..1 */

export function createImage(width, height, fill = null) {
  const w = Math.max(0, Math.floor(width)), h = Math.max(0, Math.floor(height));
  const data = new Uint8ClampedArray(w * h * 4);
  if (fill && (fill[0] || fill[1] || fill[2] || fill[3])) {
    const a = Math.round((fill[3] ?? 1) * 255);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = fill[0];
      data[i + 1] = fill[1];
      data[i + 2] = fill[2];
      data[i + 3] = a;
    }
  }
  return { width: w, height: h, data };
}

export function cloneImage(img) {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

export function isImage(img) {
  return !!img && Number.isInteger(img.width) && Number.isInteger(img.height) && img.data instanceof Uint8ClampedArray && img.data.length === img.width * img.height * 4;
}

export const emptyRect = () => ({ x: 0, y: 0, width: 0, height: 0 });
export const isEmptyRect = (r) => !r || r.width <= 0 || r.height <= 0;
export const fullRect = (img) => ({ x: 0, y: 0, width: img.width, height: img.height });

export function intersectRect(a, b) {
  if (!a || !b) return emptyRect();
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width), y2 = Math.min(a.y + a.height, b.y + b.height);
  return x2 > x1 && y2 > y1 ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } : emptyRect();
}

export function unionRect(a, b) {
  if (isEmptyRect(a)) return isEmptyRect(b) ? emptyRect() : { ...b };
  if (isEmptyRect(b)) return { ...a };
  const x1 = Math.min(a.x, b.x), y1 = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.width, b.x + b.width), y2 = Math.max(a.y + a.height, b.y + b.height);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** Clamps a rect to [0,w)x[0,h) with integer edges (floor/ceil outward, then clipped). */
export function clampRect(rect, width, height) {
  if (!rect) return { x: 0, y: 0, width, height };
  const x1 = Math.max(0, Math.floor(rect.x)), y1 = Math.max(0, Math.floor(rect.y));
  const x2 = Math.min(width, Math.ceil(rect.x + rect.width)), y2 = Math.min(height, Math.ceil(rect.y + rect.height));
  return x2 > x1 && y2 > y1 ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } : emptyRect();
}

export function inflateRect(rect, px) {
  return { x: rect.x - px, y: rect.y - px, width: rect.width + px * 2, height: rect.height + px * 2 };
}

export function cropImage(img, rect) {
  const r = clampRect(rect, img.width, img.height);
  const out = createImage(r.width, r.height);
  for (let y = 0; y < r.height; y++) {
    const src = ((r.y + y) * img.width + r.x) * 4;
    out.data.set(img.data.subarray(src, src + r.width * 4), y * r.width * 4);
  }
  return out;
}

/** Copies src over dst at (x, y) (overwrites, no blending), clipping to dst. */
export function pasteImage(dst, src, x = 0, y = 0) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const r = intersectRect({ x: x0, y: y0, width: src.width, height: src.height }, fullRect(dst));
  for (let yy = 0; yy < r.height; yy++) {
    const s = ((r.y - y0 + yy) * src.width + (r.x - x0)) * 4;
    dst.data.set(src.data.subarray(s, s + r.width * 4), ((r.y + yy) * dst.width + r.x) * 4);
  }
  return dst;
}

export const clamp255 = (n) => (n < 0 ? 0 : n > 255 ? 255 : n);
export const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);
export const lerp = (a, b, t) => a + (b - a) * t;
/** Mixes two RGBA colours (t = 0 -> c1). */
export function mix(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t), lerp(c1[3] ?? 1, c2[3] ?? 1, t)];
}

export function getPixel(img, x, y) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return [0, 0, 0, 0];
  const i = (y * img.width + x) * 4;
  const d = img.data;
  return [d[i], d[i + 1], d[i + 2], d[i + 3] / 255];
}

export function setPixel(img, x, y, rgba) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  img.data[i] = rgba[0];
  img.data[i + 1] = rgba[1];
  img.data[i + 2] = rgba[2];
  img.data[i + 3] = Math.round((rgba[3] ?? 1) * 255);
}

/** Calls fn(index, x, y) for every pixel in rect (index points at the R byte). */
export function forEachPixel(img, rect, fn) {
  const r = clampRect(rect, img.width, img.height);
  for (let y = r.y; y < r.y + r.height; y++) {
    let i = (y * img.width + r.x) * 4;
    for (let x = r.x; x < r.x + r.width; x++, i += 4) fn(i, x, y);
  }
}

/** Builds a 256-entry lookup table from fn(v) (values are clamped and rounded). */
export function makeLut(fn) {
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.round(fn(v));
  return lut;
}

export const identityLut = () => makeLut((v) => v);

/** Applies per-channel LUTs to the RGB channels inside rect; alpha is never touched. */
export function applyLut(img, lutR, lutG = lutR, lutB = lutR, rect = null) {
  const d = img.data;
  if (!rect) {
    for (let i = 0; i < d.length; i += 4) {
      d[i] = lutR[d[i]];
      d[i + 1] = lutG[d[i + 1]];
      d[i + 2] = lutB[d[i + 2]];
    }
    return img;
  }
  forEachPixel(img, rect, (i) => {
    d[i] = lutR[d[i]];
    d[i + 1] = lutG[d[i + 1]];
    d[i + 2] = lutB[d[i + 2]];
  });
  return img;
}

/** Rec. 601 luma, 0..255. */
export const luminance = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

/** Premultiplies RGB by alpha into a Float32Array [r,g,b,a]*n (0..1), for correct filtering of transparent pixels. */
export function premultiply(img) {
  const d = img.data;
  const out = new Float32Array(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    out[i] = (d[i] / 255) * a;
    out[i + 1] = (d[i + 1] / 255) * a;
    out[i + 2] = (d[i + 2] / 255) * a;
    out[i + 3] = a;
  }
  return out;
}

/** Inverse of premultiply: writes straight-alpha 8-bit values into img.data. */
export function unpremultiply(float, img) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = float[i + 3];
    if (a <= 0) {
      d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0;
      continue;
    }
    d[i] = clamp255((float[i] / a) * 255);
    d[i + 1] = clamp255((float[i + 1] / a) * 255);
    d[i + 2] = clamp255((float[i + 2] / a) * 255);
    d[i + 3] = clamp255(a * 255);
  }
  return img;
}

/** Deterministic PRNG (mulberry32) so noise-based operations are reproducible in tests. */
export function randomSeeded(seed = 1) {
  let a = seed >>> 0 || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Samples img at a fractional position with bilinear interpolation (straight alpha); out of range -> transparent. */
export function sampleBilinear(img, fx, fy, out = [0, 0, 0, 0]) {
  const w = img.width, h = img.height;
  if (fx <= -1 || fy <= -1 || fx >= w || fy >= h) {
    out[0] = out[1] = out[2] = out[3] = 0;
    return out;
  }
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const d = img.data;
  let r = 0, g = 0, b = 0, a = 0;
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
      const pa = (d[p + 3] / 255) * wgt;
      r += d[p] * pa;
      g += d[p + 1] * pa;
      b += d[p + 2] * pa;
      a += pa;
    }
  }
  if (a > 0) {
    out[0] = r / a;
    out[1] = g / a;
    out[2] = b / a;
    out[3] = a * 255;
  } else out[0] = out[1] = out[2] = out[3] = 0;
  return out;
}

/** Bounding box of pixels with alpha > threshold, or null when fully transparent. */
export function contentBounds(img, threshold = 0) {
  const { width, height, data } = img;
  let x1 = width, y1 = height, x2 = -1, y2 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > threshold) {
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
      }
    }
  }
  return x2 < 0 ? null : { x: x1, y: y1, width: x2 - x1 + 1, height: y2 - y1 + 1 };
}

/** Mean difference per channel between two images (tests). */
export function meanAbsDiff(a, b) {
  let sum = 0;
  for (let i = 0; i < a.data.length; i++) sum += Math.abs(a.data[i] - b.data[i]);
  return sum / a.data.length;
}
