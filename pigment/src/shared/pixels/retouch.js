// Dab-sized pixel operations for the retouch tools (dodge, burn, sponge, blur, sharpen, smudge,
// healing brush, colour replacement). Every operation works in place on the pixels of `rect`
// (image coordinates; the part outside the image is ignored) weighted by a dab mask covering
// rect: a Float32Array(rect.width * rect.height) of 0..1 weights, an alpha ImageDataLike of the
// rect's size (weight = alpha / 255), or null for weight 1 everywhere. Without a rect the whole
// image is the dab. Alpha is never changed, fully transparent pixels (whose colour is undefined)
// are left alone, and wherever colours are averaged across pixels they are premultiplied by alpha
// first so transparent neighbours never bleed black. Hot loops allocate nothing per pixel: the
// working planes come from a small module-level scratch pool reused from dab to dab.
// No DOM, no canvas: this runs in the renderer, in the pixel worker and in Node tests.

import { clamp01, createImage, luminance } from './core.js';
import { parseColor } from './color.js';

/** @typedef {import('./core.js').ImageDataLike} ImageDataLike */
/** @typedef {import('./core.js').Rect} Rect */
/** @typedef {import('./core.js').RGBA} RGBA */
/** @typedef {Float32Array | ImageDataLike | null} DabMask */

// ---------------------------------------------------------------------------------------------
// Scratch pool and shared plumbing

const POOL_MAX = 1 << 22; // planes larger than this (whole-image calls) are not kept around
const pool = new Map();

/** A reusable typed array of at least n elements (contents undefined). */
function scratch(key, Type, n) {
  if (n > POOL_MAX) return new Type(n);
  let a = pool.get(key);
  if (!a || a.length < n) {
    a = new Type(Math.min(POOL_MAX, Math.max(n, a ? Math.ceil(a.length * 1.5) : 0)));
    pool.set(key, a);
  }
  return a;
}

const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(+v) ? d : +v);

/**
 * Resolves the dab rect against the image and expands the dab mask into a weight plane for the
 * visible part. Returns null when rect misses the image. `any` is false when every weight is 0.
 * Integer edges: x/y are floored, width/height rounded (the dab is indexed with that stride).
 */
function region(img, rect, dab) {
  const W = img.width, H = img.height;
  let rx = 0, ry = 0, rw = W, rh = H;
  if (rect) {
    rx = Math.floor(num(rect.x, 0));
    ry = Math.floor(num(rect.y, 0));
    rw = Math.max(0, Math.round(num(rect.width, 0)));
    rh = Math.max(0, Math.round(num(rect.height, 0)));
  }
  const x0 = Math.max(0, rx), y0 = Math.max(0, ry);
  const x1 = Math.min(W, rx + rw), y1 = Math.min(H, ry + rh);
  if (x1 <= x0 || y1 <= y0) return null;
  const w = x1 - x0, h = y1 - y0;
  const wt = scratch('wt', Float32Array, w * h);
  let any = false;
  if (!dab) {
    wt.fill(1, 0, w * h);
    any = true;
  } else {
    const isImg = !!dab.data;
    const src = isImg ? dab.data : dab;
    const dw = isImg ? dab.width : rw, dh = isImg ? dab.height : rh;
    const len = isImg ? dw * dh : src.length;
    const ox = x0 - rx, oy = y0 - ry;
    for (let j = 0, k = 0; j < h; j++) {
      const dy = oy + j;
      for (let i = 0; i < w; i++, k++) {
        const dx = ox + i;
        let v = 0;
        if (dx < dw && dy < dh) {
          const n = dy * dw + dx;
          if (n < len) v = isImg ? src[n * 4 + 3] / 255 : src[n];
        }
        if (!(v > 0)) v = 0; // also maps NaN to 0
        else {
          if (v > 1) v = 1;
          any = true;
        }
        wt[k] = v;
      }
    }
  }
  return { x0, y0, w, h, rx, ry, rw, rh, wt, any };
}

// W3C SetLum / SetSat / ClipColor in the 0..255 domain (same maths as blend.js's non-separable
// modes), writing into module variables so the loops allocate nothing.
let R = 0, G = 0, B = 0;

/** Pulls a colour whose luma is l back into 0..255 without changing its luma or hue. */
function clipColor(r, g, b, l) {
  const n = r < g ? (r < b ? r : b) : g < b ? g : b;
  const x = r > g ? (r > b ? r : b) : g > b ? g : b;
  if (n < 0 && l - n > 0) {
    const k = l / (l - n);
    r = l + (r - l) * k;
    g = l + (g - l) * k;
    b = l + (b - l) * k;
  }
  if (x > 255 && x - l > 0) {
    const k = (255 - l) / (x - l);
    r = l + (r - l) * k;
    g = l + (g - l) * k;
    b = l + (b - l) * k;
  }
  R = r;
  G = g;
  B = b;
}

/** Shifts the colour to luma l (hue kept), then clips into gamut. */
function setLum(r, g, b, l) {
  const d = l - luminance(r, g, b);
  clipColor(r + d, g + d, b + d, l);
}

/** Rescales the colour so max - min = s with min at 0 (hue kept); greys become black. */
function setSat(r, g, b, s) {
  const max = r > g ? (r > b ? r : b) : g > b ? g : b;
  const min = r < g ? (r < b ? r : b) : g < b ? g : b;
  if (max > min) {
    const mid = ((r + g + b - max - min - min) * s) / (max - min);
    R = r === max ? s : r === min ? 0 : mid;
    G = g === max ? s : g === min ? 0 : mid;
    B = b === max ? s : b === min ? 0 : mid;
  } else R = G = B = 0;
}

/**
 * Box mean around every pixel of the w×h block at (x0, y0) of an RGBA buffer d (W×H), computed
 * with premultiplied sums (colour weighted by alpha) so the result is the straight colour of the
 * visible neighbours. Windows are (2r+1)² clipped to the block grown by r (margin = true, clamped
 * to the image) or to the block itself, so nothing outside the image is read. Two separable
 * running-sum passes. Writes rgb triples into out[(j * w + i) * 3]; the red slot is -1 when the
 * window holds no alpha at all.
 */
function boxMean(d, W, H, x0, y0, w, h, r, out, margin) {
  const sx0 = margin ? Math.max(0, x0 - r) : x0, sx1 = margin ? Math.min(W, x0 + w + r) : x0 + w;
  const sy0 = margin ? Math.max(0, y0 - r) : y0, sy1 = margin ? Math.min(H, y0 + h + r) : y0 + h;
  const stride = w * 4;
  const hb = scratch('boxH', Float64Array, (sy1 - sy0) * stride);
  const xEnd = x0 + w;
  // Horizontal pass: every source row, target columns only.
  for (let yy = sy0; yy < sy1; yy++) {
    const row = yy * W * 4;
    let sr = 0, sg = 0, sb = 0, sa = 0;
    const a1 = Math.min(sx1 - 1, x0 + r);
    for (let xx = Math.max(sx0, x0 - r); xx <= a1; xx++) {
      const i = row + xx * 4, a = d[i + 3];
      sr += d[i] * a;
      sg += d[i + 1] * a;
      sb += d[i + 2] * a;
      sa += a;
    }
    let o = (yy - sy0) * stride;
    for (let x = x0; x < xEnd; x++, o += 4) {
      hb[o] = sr;
      hb[o + 1] = sg;
      hb[o + 2] = sb;
      hb[o + 3] = sa;
      const xa = x + r + 1, xr = x - r;
      if (xa < sx1) {
        const i = row + xa * 4, a = d[i + 3];
        sr += d[i] * a;
        sg += d[i + 1] * a;
        sb += d[i + 2] * a;
        sa += a;
      }
      if (xr >= sx0) {
        const i = row + xr * 4, a = d[i + 3];
        sr -= d[i] * a;
        sg -= d[i + 1] * a;
        sb -= d[i + 2] * a;
        sa -= a;
      }
    }
  }
  // Vertical pass: running column sums, row by row (cache friendly).
  const acc = scratch('boxV', Float64Array, stride);
  acc.fill(0, 0, stride);
  const b1 = Math.min(sy1 - 1, y0 + r);
  for (let yy = Math.max(sy0, y0 - r); yy <= b1; yy++) {
    const s = (yy - sy0) * stride;
    for (let i = 0; i < stride; i++) acc[i] += hb[s + i];
  }
  const yEnd = y0 + h;
  for (let y = y0; y < yEnd; y++) {
    let o = (y - y0) * w * 3;
    for (let i = 0; i < stride; i += 4, o += 3) {
      const a = acc[i + 3];
      if (a > 0) {
        out[o] = acc[i] / a;
        out[o + 1] = acc[i + 1] / a;
        out[o + 2] = acc[i + 2] / a;
      } else out[o] = -1;
    }
    const ya = y + r + 1, yr = y - r;
    if (ya < sy1) {
      const s = (ya - sy0) * stride;
      for (let i = 0; i < stride; i++) acc[i] += hb[s + i];
    }
    if (yr >= sy0) {
      const s = (yr - sy0) * stride;
      for (let i = 0; i < stride; i++) acc[i] -= hb[s + i];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Dab mask

/**
 * Round soft dab mask (an ellipse filling width×height): weight 1 inside the hard radius
 * (hardness × radius), then a smoothstep falloff to 0 at the edge. hardness is 0..1 (values above
 * 1 are read as percent); hardness 1 still gets a one-pixel anti-aliased rim.
 * @param {number} width
 * @param {number} [height=width]
 * @param {number} [hardness=1]
 * @returns {Float32Array} width * height weights, row-major
 */
export function dabMask(width, height = width, hardness = 1) {
  const w = Math.max(0, Math.round(num(width, 0))), h = Math.max(0, Math.round(num(height, w)));
  const out = new Float32Array(w * h);
  if (!w || !h) return out;
  let hd = num(hardness, 1);
  if (hd > 1) hd /= 100;
  hd = clamp01(hd);
  const rx = w / 2, ry = h / 2;
  const aa = 1 / Math.max(1, Math.min(rx, ry));
  const inner = Math.max(0, Math.min(hd, 1 - aa));
  const span = 1 - inner;
  for (let y = 0, k = 0; y < h; y++) {
    const ny = (y + 0.5 - ry) / ry, ny2 = ny * ny;
    for (let x = 0; x < w; x++, k++) {
      const nx = (x + 0.5 - rx) / rx;
      const dd = Math.sqrt(nx * nx + ny2);
      if (dd <= inner) out[k] = 1;
      else if (dd < 1) {
        const t = (dd - inner) / span;
        out[k] = 1 - t * t * (3 - 2 * t);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Dodge / burn / sponge

const RANGES = { shadows: 0, midtones: 1, highlights: 2 };

function tone(img, rect, dab, opts, lighten) {
  const g = region(img, rect, dab);
  if (!g || !g.any) return img;
  const o = opts || {};
  const ex = clamp01(num(o.exposure, 0.5));
  if (ex <= 0) return img;
  const range = RANGES[o.range] ?? 1;
  const d = img.data, W = img.width, { x0, y0, w, h, wt } = g;
  for (let j = 0, k = 0; j < h; j++) {
    let i = ((y0 + j) * W + x0) * 4;
    for (let c = 0; c < w; c++, k++, i += 4) {
      const m = wt[k];
      if (m <= 0 || d[i + 3] === 0) continue;
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      const L = 0.299 * r + 0.587 * gg + 0.114 * b, l = L / 255;
      const rw = range === 0 ? 1 - l : range === 2 ? l : 4 * l * (1 - l);
      const t = ex * m * rw;
      if (t <= 0) continue;
      const Lt = lighten ? L + t * (255 - L) : L - t * L;
      const dl = Lt - L;
      clipColor(r + dl, gg + dl, b + dl, Lt);
      d[i] = R;
      d[i + 1] = G;
      d[i + 2] = B;
    }
  }
  return img;
}

/**
 * Dodge: lightens each pixel's luma toward white, L' = L + t (255 - L) with
 * t = exposure × dab × range weight (shadows 1 - l, midtones 4 l (1 - l), highlights l, l = L/255),
 * shifting all channels equally and clipping with W3C ClipColor so the hue is preserved.
 * @param {ImageDataLike} img modified in place
 * @param {Rect | null} rect dab rect in image coordinates (default: whole image)
 * @param {DabMask} dab
 * @param {{ range?: 'shadows'|'midtones'|'highlights', exposure?: number }} [opts] exposure 0..1 (default 0.5)
 * @returns {ImageDataLike} img
 */
export function dodge(img, rect, dab, opts = {}) {
  return tone(img, rect, dab, opts, true);
}

/**
 * Burn: the mirror of dodge, darkening luma toward black, L' = L (1 - t), with the same range
 * weights and hue-preserving channel shift.
 * @param {ImageDataLike} img modified in place
 * @param {Rect | null} rect
 * @param {DabMask} dab
 * @param {{ range?: 'shadows'|'midtones'|'highlights', exposure?: number }} [opts] exposure 0..1 (default 0.5)
 * @returns {ImageDataLike} img
 */
export function burn(img, rect, dab, opts = {}) {
  return tone(img, rect, dab, opts, false);
}

/**
 * Sponge: scales each pixel's chroma around its luma, c' = L + (c - L) f with
 * f = 1 - flow × dab (desaturate) or 1 + flow × dab limited to the gamut (saturate), so HSL
 * saturation moves while Rec. 601 luma and hue stay put.
 * @param {ImageDataLike} img modified in place
 * @param {Rect | null} rect
 * @param {DabMask} dab
 * @param {{ mode?: 'saturate'|'desaturate', flow?: number }} [opts] flow 0..1 (default 0.5), mode default 'desaturate'
 * @returns {ImageDataLike} img
 */
export function sponge(img, rect, dab, opts = {}) {
  const g = region(img, rect, dab);
  if (!g || !g.any) return img;
  const o = opts || {};
  const flow = clamp01(num(o.flow, 0.5));
  if (flow <= 0) return img;
  const saturate = o.mode === 'saturate';
  const d = img.data, W = img.width, { x0, y0, w, h, wt } = g;
  for (let j = 0, k = 0; j < h; j++) {
    let i = ((y0 + j) * W + x0) * 4;
    for (let c = 0; c < w; c++, k++, i += 4) {
      const m = wt[k];
      if (m <= 0 || d[i + 3] === 0) continue;
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      if (r === gg && gg === b) continue; // grey: no chroma to scale
      const L = 0.299 * r + 0.587 * gg + 0.114 * b;
      const dr = r - L, dg = gg - L, db = b - L;
      let f;
      if (saturate) {
        f = 1 + flow * m;
        // largest scale that keeps every channel inside 0..255 (luma stays exact)
        const mx = dr > dg ? (dr > db ? dr : db) : dg > db ? dg : db;
        const mn = dr < dg ? (dr < db ? dr : db) : dg < db ? dg : db;
        if (mx > 0 && (255 - L) / mx < f) f = (255 - L) / mx;
        if (mn < 0 && L / -mn < f) f = L / -mn;
        if (f <= 1) continue;
      } else f = 1 - flow * m;
      d[i] = L + dr * f;
      d[i + 1] = L + dg * f;
      d[i + 2] = L + db * f;
    }
  }
  return img;
}

// ---------------------------------------------------------------------------------------------
// Blur / sharpen

/** Default blur-tool box radius for a dab: grows gently with the dab size (1..8 px). */
const blurRadiusFor = (g) => Math.max(1, Math.min(8, Math.round(Math.min(g.rw, g.rh) / 24)));

/**
 * Blur tool dab: blends each pixel toward the box average of its neighbourhood, by
 * strength × dab. The averages come from a snapshot of the rect (plus `radius` pixels around it,
 * inside the image) taken before anything is written, so one dab never smears its own output.
 * Colours are averaged premultiplied (transparent neighbours do not darken edges).
 * @param {ImageDataLike} img modified in place
 * @param {Rect | null} rect
 * @param {DabMask} dab
 * @param {{ strength?: number, radius?: number }} [opts] strength 0..1 (default 0.5); radius in px (default: dab size / 24, 1..8)
 * @returns {ImageDataLike} img
 */
export function blurDab(img, rect, dab, opts = {}) {
  const g = region(img, rect, dab);
  if (!g || !g.any) return img;
  const o = opts || {};
  const s = clamp01(num(o.strength, 0.5));
  if (s <= 0) return img;
  const rad = Math.max(1, Math.round(num(o.radius, blurRadiusFor(g))));
  const d = img.data, W = img.width, { x0, y0, w, h, wt } = g;
  const mean = boxMean(d, W, img.height, x0, y0, w, h, rad, scratch('mean', Float32Array, w * h * 3), true);
  for (let j = 0, k = 0; j < h; j++) {
    let i = ((y0 + j) * W + x0) * 4;
    for (let c = 0; c < w; c++, k++, i += 4) {
      const m = wt[k];
      if (m <= 0 || d[i + 3] === 0) continue;
      const q = k * 3, mr = mean[q];
      if (mr < 0) continue;
      const t = s * m;
      d[i] += (mr - d[i]) * t;
      d[i + 1] += (mean[q + 1] - d[i + 1]) * t;
      d[i + 2] += (mean[q + 2] - d[i + 2]) * t;
    }
  }
  return img;
}

/**
 * Sharpen tool dab, unsharp-mask style: c' = c + strength × dab × (c - boxMean(c)), with the
 * box mean (radius 1 by default) taken from a premultiplied snapshot of the rect, clamped to 0..255.
 * @param {ImageDataLike} img modified in place
 * @param {Rect | null} rect
 * @param {DabMask} dab
 * @param {{ strength?: number, radius?: number }} [opts] strength 0..1 (default 0.5); radius px (default 1)
 * @returns {ImageDataLike} img
 */
export function sharpenDab(img, rect, dab, opts = {}) {
  const g = region(img, rect, dab);
  if (!g || !g.any) return img;
  const o = opts || {};
  const s = clamp01(num(o.strength, 0.5));
  if (s <= 0) return img;
  const rad = Math.max(1, Math.round(num(o.radius, 1)));
  const d = img.data, W = img.width, { x0, y0, w, h, wt } = g;
  const mean = boxMean(d, W, img.height, x0, y0, w, h, rad, scratch('mean', Float32Array, w * h * 3), true);
  for (let j = 0, k = 0; j < h; j++) {
    let i = ((y0 + j) * W + x0) * 4;
    for (let c = 0; c < w; c++, k++, i += 4) {
      const m = wt[k];
      if (m <= 0 || d[i + 3] === 0) continue;
      const q = k * 3;
      if (mean[q] < 0) continue;
      const t = s * m;
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      d[i] = r + (r - mean[q]) * t;
      d[i + 1] = gg + (gg - mean[q + 1]) * t;
      d[i + 2] = b + (b - mean[q + 2]) * t;
    }
  }
  return img;
}

// ---------------------------------------------------------------------------------------------
// Smudge

/**
 * Smudge tool dab. `carried` is the rect-sized buffer of pixels the finger drags along (pixel
 * (i, j) sits over image pixel (rect.x + i, rect.y + j)). When carried is null (start of a stroke)
 * or its size no longer matches the rect, the current pixels under the rect are picked up
 * (transparent where the rect leaves the image) and returned without painting. Otherwise each
 * pixel is first painted with the carried colour, c' = mix(c, carried, strength × dab × carriedAlpha),
 * then the carried pixel picks up the current (pre-dab) pixel:
 * carried' = mix(carried, c, (1 - strength) × dab), premultiplied so transparent pixels add no
 * colour (carried alpha follows the mix and scales how much it paints). Image alpha never changes.
 * @param {ImageDataLike} img modified in place
 * @param {Rect | null} rect
 * @param {DabMask} dab
 * @param {ImageDataLike | null} carried updated in place when its size matches rect
 * @param {{ strength?: number }} [opts] strength 0..1 (default 0.5)
 * @returns {ImageDataLike} the carried buffer for the next dab
 */
export function smudge(img, rect, dab, carried, opts = {}) {
  const g = region(img, rect, dab);
  const rw = rect ? Math.max(0, Math.round(num(rect.width, 0))) : img.width;
  const rh = rect ? Math.max(0, Math.round(num(rect.height, 0))) : img.height;
  const fresh = !carried || !carried.data || carried.width !== rw || carried.height !== rh;
  if (fresh) {
    const out = createImage(rw, rh);
    if (g) {
      const W = img.width, { x0, y0, w, h, rx, ry } = g;
      for (let j = 0; j < h; j++) {
        const s = ((y0 + j) * W + x0) * 4;
        out.data.set(img.data.subarray(s, s + w * 4), ((y0 - ry + j) * rw + (x0 - rx)) * 4);
      }
    }
    return out;
  }
  if (!g || !g.any) return carried;
  const s = clamp01(num((opts || {}).strength, 0.5));
  const u = 1 - s;
  const d = img.data, kd = carried.data, W = img.width, { x0, y0, w, h, rx, ry, wt } = g;
  for (let j = 0, k = 0; j < h; j++) {
    let i = ((y0 + j) * W + x0) * 4;
    let ci = ((y0 - ry + j) * rw + (x0 - rx)) * 4;
    for (let c = 0; c < w; c++, k++, i += 4, ci += 4) {
      const m = wt[k];
      if (m <= 0) continue;
      const r = d[i], gg = d[i + 1], b = d[i + 2], a = d[i + 3];
      const kr = kd[ci], kg = kd[ci + 1], kb = kd[ci + 2], ka = kd[ci + 3];
      if (a > 0 && ka > 0 && s > 0) {
        const t = (s * m * ka) / 255;
        d[i] = r + (kr - r) * t;
        d[i + 1] = gg + (kg - gg) * t;
        d[i + 2] = b + (kb - b) * t;
      }
      const p = u * m;
      if (p > 0) {
        const wk = ka * (1 - p), wc = a * p, na = wk + wc;
        if (na > 0) {
          kd[ci] = (kr * wk + r * wc) / na;
          kd[ci + 1] = (kg * wk + gg * wc) / na;
          kd[ci + 2] = (kb * wk + b * wc) / na;
        }
        kd[ci + 3] = na;
      }
    }
  }
  return carried;
}

// ---------------------------------------------------------------------------------------------
// Healing brush

/**
 * Healing brush dab: copies the texture of `source` (a rect-sized sample taken elsewhere;
 * pixel (i, j) lands on image pixel (rect.x + i, rect.y + j)) with its colour matched to the
 * destination: target = blur(dest) + (source - blur(source)), where blur is a premultiplied box
 * mean of radius max(2, rect.width / 8) over the respective rect (the destination's may look
 * `radius` pixels past the rect, inside the image). Each pixel moves toward the target by
 * dab × strength, clamped to 0..255; alpha is unchanged and transparent source pixels add no texture.
 * @param {ImageDataLike} img modified in place
 * @param {Rect | null} rect
 * @param {DabMask} dab
 * @param {ImageDataLike} source
 * @param {{ radius?: number, strength?: number }} [opts] strength 0..1 (default 1)
 * @returns {ImageDataLike} img
 */
export function heal(img, rect, dab, source, opts = {}) {
  const g = region(img, rect, dab);
  if (!g || !g.any || !source || !source.data) return img;
  const o = opts || {};
  const str = clamp01(num(o.strength, 1));
  if (str <= 0) return img;
  const { x0, y0, w, h, rx, ry, rw, wt } = g;
  const rad = Math.max(1, Math.round(num(o.radius, Math.max(2, rw / 8))));
  const d = img.data, W = img.width;
  const dm = boxMean(d, W, img.height, x0, y0, w, h, rad, scratch('mean', Float32Array, w * h * 3), true);
  // The part of the source that lies under the visible part of the dab.
  const sd = source.data, SW = source.width, SH = source.height;
  const ox = x0 - rx, oy = y0 - ry;
  const sw = Math.max(0, Math.min(w, SW - ox)), sh = Math.max(0, Math.min(h, SH - oy));
  const sm = sw && sh ? boxMean(sd, SW, SH, ox, oy, sw, sh, rad, scratch('mean2', Float32Array, sw * sh * 3), true) : null;
  for (let j = 0, k = 0; j < h; j++) {
    let i = ((y0 + j) * W + x0) * 4;
    const srow = j < sh;
    for (let c = 0; c < w; c++, k++, i += 4) {
      const m = wt[k] * str;
      if (m <= 0 || d[i + 3] === 0) continue;
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      const q = k * 3;
      let tr = r, tg = gg, tb = b;
      if (dm[q] >= 0) {
        tr = dm[q];
        tg = dm[q + 1];
        tb = dm[q + 2];
      }
      if (srow && c < sw) {
        const si = ((oy + j) * SW + ox + c) * 4, sq = (j * sw + c) * 3, sa = sd[si + 3];
        if (sa > 0 && sm[sq] >= 0) {
          const f = sa / 255;
          tr += (sd[si] - sm[sq]) * f;
          tg += (sd[si + 1] - sm[sq + 1]) * f;
          tb += (sd[si + 2] - sm[sq + 2]) * f;
        }
      }
      d[i] = r + (tr - r) * m;
      d[i + 1] = gg + (tg - gg) * m;
      d[i + 2] = b + (tb - b) * m;
    }
  }
  return img;
}

// ---------------------------------------------------------------------------------------------
// Colour replacement

const REPLACE_MODES = { hue: 0, saturation: 1, color: 2, luminosity: 3 };

/**
 * Colour replacement tool dab: pixels whose colour is within `tolerance` of `sampleColor`
 * (largest channel difference, as the magic wand measures it) are blended toward `color` using
 * the W3C non-separable mode `mode` (`color` = replacement hue + saturation with the pixel's luma,
 * `hue`, `saturation`, `luminosity`), by dab × strength. Pixels outside the tolerance and
 * alpha are untouched. Without sampleColor the pixel under the centre of rect is sampled.
 * @param {ImageDataLike} img modified in place
 * @param {Rect | null} rect
 * @param {DabMask} dab
 * @param {{ color?: RGBA | string, tolerance?: number, sampleColor?: RGBA | string, mode?: 'hue'|'saturation'|'color'|'luminosity', strength?: number }} [opts]
 *   color default black, tolerance 0..255 (default 32), mode default 'color', strength 0..1 (default 1)
 * @returns {ImageDataLike} img
 */
export function replaceColor(img, rect, dab, opts = {}) {
  const g = region(img, rect, dab);
  if (!g || !g.any) return img;
  const o = opts || {};
  const str = clamp01(num(o.strength, 1));
  if (str <= 0) return img;
  const d = img.data, W = img.width, { x0, y0, w, h, rx, ry, rw, rh, wt } = g;
  const col = parseColor(o.color ?? [0, 0, 0, 1]);
  const cr = col[0], cg = col[1], cb = col[2];
  let sr, sg, sb;
  if (o.sampleColor != null) [sr, sg, sb] = parseColor(o.sampleColor);
  else {
    const cx = Math.min(x0 + w - 1, Math.max(x0, rx + (rw >> 1)));
    const cy = Math.min(y0 + h - 1, Math.max(y0, ry + (rh >> 1)));
    const ci = (cy * W + cx) * 4;
    sr = d[ci];
    sg = d[ci + 1];
    sb = d[ci + 2];
  }
  let tol = num(o.tolerance, 32);
  tol = tol < 0 ? 0 : tol > 255 ? 255 : tol;
  const mode = REPLACE_MODES[o.mode] ?? 2;
  const cL = luminance(cr, cg, cb);
  const cS = Math.max(cr, cg, cb) - Math.min(cr, cg, cb);
  for (let j = 0, k = 0; j < h; j++) {
    let i = ((y0 + j) * W + x0) * 4;
    for (let c = 0; c < w; c++, k++, i += 4) {
      const m = wt[k] * str;
      if (m <= 0 || d[i + 3] === 0) continue;
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      const dr = r > sr ? r - sr : sr - r, dg = gg > sg ? gg - sg : sg - gg, db = b > sb ? b - sb : sb - b;
      if (dr > tol || dg > tol || db > tol) continue;
      const L = 0.299 * r + 0.587 * gg + 0.114 * b;
      if (mode === 2) setLum(cr, cg, cb, L);
      else if (mode === 0) {
        const max = r > gg ? (r > b ? r : b) : gg > b ? gg : b;
        const min = r < gg ? (r < b ? r : b) : gg < b ? gg : b;
        setSat(cr, cg, cb, max - min);
        setLum(R, G, B, L);
      } else if (mode === 1) {
        setSat(r, gg, b, cS);
        setLum(R, G, B, L);
      } else setLum(r, gg, b, cL);
      d[i] = r + (R - r) * m;
      d[i + 1] = gg + (G - gg) * m;
      d[i + 2] = b + (B - b) * m;
    }
  }
  return img;
}
