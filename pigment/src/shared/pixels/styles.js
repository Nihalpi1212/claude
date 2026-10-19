// Layer styles (Photoshop's Layer Style dialog) on ImageDataLike pixels: drop shadow, inner
// shadow, outer glow, inner glow, bevel & emboss, satin, colour / gradient / pattern overlay and
// stroke. Pure functions, no DOM, no canvas: runs in the renderer, the pixel worker and Node tests.
//
// How it works. Every effect starts from the layer's alpha channel (its matte): spread hardens
// it outwards and choke inwards (threshold the matte at half its peak alpha, run a Euclidean
// distance transform, keep pixels within the radius: threshold-then-blur), then a separable
// gaussian blur with sigma = size / 2.5 softens it, it is offset along the light angle, coloured,
// and blended with blendImages(). Output pixels are assembled bottom to top in Photoshop's
// stacking order (the order of the Layer Style dialog list, read from the bottom up):
//
//   drop shadow, outer glow, outer half of the bevel, outer part of the stroke,
//   the layer itself (scaled by fillOpacity), then, clipped to the layer's alpha:
//     pattern overlay, gradient overlay, colour overlay, satin, inner glow, inner shadow,
//     inner half of the bevel, inner part of the stroke.
//
// Interior effects are composited onto the layer colour first and the result is masked by the
// layer alpha afterwards (so overlays recolour antialiased edges without changing their alpha),
// and the outside stroke is sized so that stroke plus layer cover exactly the dilated shape
// (no light seam along antialiased edges).
//
// Conventions: angles are Photoshop's, in degrees counter-clockwise from 3 o'clock, naming where
// the light comes from (120 = upper left, so shadows fall down-right). Sizes, distances, spread,
// choke and soften are in pixels; opacities are 0..1; depth is a percentage. Colours are any
// string parseColor() accepts (its alpha multiplies the opacity). Straight alpha in and out.
//
// Limitation of a standalone image: effects blend with each other and with the layer, not with
// the document underneath; the compositor draws the whole result with the layer's blend mode.
//
// Every output pixel is what an unbounded canvas would show there: the work window always holds
// the layer content the pixel depends on plus the full reach of every intermediate buffer, so the
// result does not depend on pad, rect or which other effects are enabled.

import { createImage, pasteImage, clampRect, intersectRect, unionRect, inflateRect, isEmptyRect, fullRect, clamp01 } from './core.js';
import { parseColor } from './color.js';
import { blendImages, isBlendMode } from './blend.js';

/** @typedef {import('./core.js').ImageDataLike} ImageDataLike */
/** @typedef {import('./core.js').Rect} Rect */

const EFFECT_KEYS = Object.freeze([
  'dropShadow', 'innerShadow', 'outerGlow', 'innerGlow', 'bevel',
  'satin', 'colorOverlay', 'gradientOverlay', 'patternOverlay', 'stroke',
]);

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/**
 * Every effect, disabled, with Photoshop's default settings. Deeply frozen: use mergeStyles() to
 * get an editable copy.
 *  - dropShadow / innerShadow: { enabled, blend, color, opacity, angle, distance, spread (px), size (px) }
 *  - outerGlow: { enabled, blend, color, opacity, spread (px), size (px) }
 *  - innerGlow: { enabled, blend, color, opacity, source: 'edge'|'center', choke (px), size (px) }
 *  - bevel: { enabled, style: 'inner-bevel'|'outer-bevel'|'emboss'|'pillow-emboss',
 *      technique: 'smooth'|'chisel-hard', depth (%), direction: 'up'|'down', size, soften (px),
 *      angle, altitude (0..90), highlightColor, highlightOpacity, highlightBlend,
 *      shadowColor, shadowOpacity, shadowBlend }
 *  - satin: { enabled, color, opacity, blend, angle, distance, size, invert }
 *  - colorOverlay: { enabled, color, opacity, blend }
 *  - gradientOverlay: { enabled, stops: [{ pos 0..1, color, opacity? 0..1 }], kind:
 *      'linear'|'radial'|'angle'|'reflected'|'diamond', angle, scale, opacity, blend, reverse }
 *  - patternOverlay: { enabled, pattern: ImageDataLike|null (tiled from the layer origin), scale, opacity, blend }
 *  - stroke: { enabled, size (px), position: 'outside'|'inside'|'center', color, opacity, blend }
 * Shadows and the bevel also honour `useGlobalLight: true` when applyStyles() gets globalAngle /
 * globalAltitude.
 */
export const DEFAULT_STYLES = deepFreeze({
  dropShadow: { enabled: false, blend: 'multiply', color: '#000000', opacity: 0.75, angle: 120, distance: 5, spread: 0, size: 5 },
  innerShadow: { enabled: false, blend: 'multiply', color: '#000000', opacity: 0.75, angle: 120, distance: 5, spread: 0, size: 5 },
  outerGlow: { enabled: false, blend: 'screen', color: '#ffffbe', opacity: 0.75, spread: 0, size: 5 },
  innerGlow: { enabled: false, blend: 'screen', color: '#ffffbe', opacity: 0.75, source: 'edge', choke: 0, size: 5 },
  bevel: {
    enabled: false, style: 'inner-bevel', technique: 'smooth', depth: 100, direction: 'up', size: 5, soften: 0,
    angle: 120, altitude: 30,
    highlightColor: '#ffffff', highlightOpacity: 0.75, highlightBlend: 'screen',
    shadowColor: '#000000', shadowOpacity: 0.75, shadowBlend: 'multiply',
  },
  satin: { enabled: false, color: '#000000', opacity: 0.5, blend: 'multiply', angle: 19, distance: 11, size: 14, invert: true },
  colorOverlay: { enabled: false, color: '#ff0000', opacity: 1, blend: 'normal' },
  gradientOverlay: {
    enabled: false, stops: [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }],
    kind: 'linear', angle: 90, scale: 1, opacity: 1, blend: 'normal', reverse: false,
  },
  patternOverlay: { enabled: false, pattern: null, scale: 1, opacity: 1, blend: 'normal' },
  stroke: { enabled: false, size: 3, position: 'outside', color: '#000000', opacity: 1, blend: 'normal' },
});

/**
 * Effect keys with their display names, in the order of Photoshop's Layer Style dialog.
 * @type {ReadonlyArray<{ key: string, name: string }>}
 */
export const STYLE_KEYS = deepFreeze([
  { key: 'dropShadow', name: 'Drop Shadow' },
  { key: 'innerShadow', name: 'Inner Shadow' },
  { key: 'outerGlow', name: 'Outer Glow' },
  { key: 'innerGlow', name: 'Inner Glow' },
  { key: 'bevel', name: 'Bevel & Emboss' },
  { key: 'satin', name: 'Satin' },
  { key: 'colorOverlay', name: 'Color Overlay' },
  { key: 'gradientOverlay', name: 'Gradient Overlay' },
  { key: 'patternOverlay', name: 'Pattern Overlay' },
  { key: 'stroke', name: 'Stroke' },
]);

/**
 * Full style object: every effect key present, each effect's missing (or undefined) fields filled
 * from DEFAULT_STYLES. Returns fresh objects (gradient stops are copied, a pattern is kept by
 * reference); unknown top-level keys are dropped; partial is not modified.
 * @param {object | null} [partial]
 * @returns {Record<string, any>}
 */
export function mergeStyles(partial = null) {
  const src = partial && typeof partial === 'object' ? partial : {};
  const out = {};
  for (const key of EFFECT_KEYS) {
    const def = DEFAULT_STYLES[key];
    const fx = { ...def };
    const p = src[key];
    if (p && typeof p === 'object') {
      for (const k of Object.keys(p)) if (p[k] !== undefined) fx[k] = p[k];
    }
    if (key === 'gradientOverlay') fx.stops = (Array.isArray(fx.stops) ? fx.stops : def.stops).map((s) => ({ ...s }));
    out[key] = fx;
  }
  return out;
}

/** True when at least one effect of styles is enabled. */
export function hasEnabledStyles(styles) {
  if (!styles || typeof styles !== 'object') return false;
  for (const key of EFFECT_KEYS) if (styles[key] && styles[key].enabled) return true;
  return false;
}

const num = (v, def = 0) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : def;
};
const nonNeg = (v, def = 0) => Math.max(0, num(v, def));
const blendOf = (mode) => (isBlendMode(mode) ? mode : 'normal');
const RAD = Math.PI / 180;

/**
 * Pixels the styled output must grow by on each side so nothing is clipped: the maximum over the
 * enabled effects of drop shadow size + |distance| + spread, outer glow size + spread, outside
 * stroke size (half of it for a centred stroke) and outer bevel size (half of it for emboss and
 * pillow emboss) plus soften. Interior effects need none. Integer, 0 when nothing reaches outside.
 * @param {object | null} styles partial or full styles
 * @returns {number}
 */
export function stylePadding(styles) {
  if (!hasEnabledStyles(styles)) return 0;
  const s = mergeStyles(styles);
  let pad = 0;
  const ds = s.dropShadow;
  if (ds.enabled) pad = Math.max(pad, nonNeg(ds.size, 5) + Math.abs(num(ds.distance, 5)) + nonNeg(ds.spread));
  const og = s.outerGlow;
  if (og.enabled) pad = Math.max(pad, nonNeg(og.size, 5) + nonNeg(og.spread));
  const st = s.stroke;
  if (st.enabled) {
    const size = nonNeg(st.size, 3);
    if (st.position === 'center') pad = Math.max(pad, size / 2);
    else if (st.position !== 'inside') pad = Math.max(pad, size);
  }
  const bv = s.bevel;
  if (bv.enabled) {
    const size = nonNeg(bv.size, 5), soften = nonNeg(bv.soften);
    if (bv.style === 'outer-bevel') pad = Math.max(pad, size + soften);
    else if (bv.style === 'emboss' || bv.style === 'pillow-emboss') pad = Math.max(pad, size / 2 + soften);
  }
  return Math.ceil(pad);
}

// ---------------------------------------------------------------------------------------------
// Alpha-matte primitives on Float32Array(w * h) values 0..1. Everything outside the array is 0.

/** Box radii whose three passes approximate a gaussian of the given sigma (Kutskir). */
function boxRadii(sigma) {
  const n = 3;
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  const radii = [];
  for (let i = 0; i < n; i++) radii.push(((i < m ? wl : wu) - 1) / 2);
  return radii;
}

/**
 * Horizontal kernel pass. Skips the zero runs at both ends of each row and records in ext the
 * [x0, x1) span of each output row that can be non-zero (used by convolveV).
 */
function convolveH(src, dst, w, h, k, r, ext) {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let a = 0;
    while (a < w && src[row + a] === 0) a++;
    if (a === w) {
      dst.fill(0, row, row + w);
      ext[2 * y] = ext[2 * y + 1] = 0;
      continue;
    }
    let b = w - 1;
    while (src[row + b] === 0) b--;
    const x0 = a - r > 0 ? a - r : 0, x1 = b + r + 1 < w ? b + r + 1 : w;
    dst.fill(0, row, row + x0);
    dst.fill(0, row + x1, row + w);
    for (let x = x0; x < x1; x++) {
      const j0 = x - r < a ? a - x : -r, j1 = x + r > b ? b - x : r;
      let acc = 0;
      for (let j = j0; j <= j1; j++) acc += k[j + r] * src[row + x + j];
      dst[row + x] = acc;
    }
    ext[2 * y] = x0;
    ext[2 * y + 1] = x1;
  }
}

/**
 * Vertical kernel pass. Each output row only spans the union of the ext spans of the rows it
 * reads (convolveH wrote zeros everywhere else, so reading inside the union is safe).
 */
function convolveV(src, dst, w, h, k, r, ext) {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const ja = y < r ? -y : -r, jb = y + r >= h ? h - 1 - y : r;
    let x0 = w, x1 = 0;
    for (let j = ja; j <= jb; j++) {
      const e = 2 * (y + j);
      if (ext[e] < ext[e + 1]) {
        if (ext[e] < x0) x0 = ext[e];
        if (ext[e + 1] > x1) x1 = ext[e + 1];
      }
    }
    if (x0 >= x1) {
      dst.fill(0, row, row + w);
      continue;
    }
    dst.fill(0, row, row + x0);
    dst.fill(0, row + x1, row + w);
    const base = (y + ja) * w, k0 = ja + r, taps = jb - ja + 1;
    for (let x = x0; x < x1; x++) {
      let acc = 0;
      for (let j = 0, q = base + x; j < taps; j++, q += w) acc += k[k0 + j] * src[q];
      dst[row + x] = acc;
    }
  }
}

function boxH(src, dst, w, h, r) {
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = 0; x <= r && x < w; x++) sum += src[row + x];
    for (let x = 0; x < w; x++) {
      dst[row + x] = sum * inv;
      const add = x + r + 1, rem = x - r;
      if (add < w) sum += src[row + add];
      if (rem >= 0) sum -= src[row + rem];
    }
  }
}

function boxV(src, dst, w, h, r, sums) {
  const inv = 1 / (2 * r + 1);
  sums.fill(0);
  for (let y = 0; y <= r && y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) sums[x] += src[row + x];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) dst[row + x] = sums[x] * inv;
    const add = y + r + 1, rem = y - r;
    if (add < h) {
      const ar = add * w;
      for (let x = 0; x < w; x++) sums[x] += src[ar + x];
    }
    if (rem >= 0) {
      const rr = rem * w;
      for (let x = 0; x < w; x++) sums[x] -= src[rr + x];
    }
  }
}

/**
 * Separable gaussian blur with transparent (zero) surroundings. Exact kernel up to sigma 4, three
 * running-sum box passes above that (O(1) per pixel whatever the size). Returns src itself when
 * sigma is negligible, otherwise a new array; src is never modified.
 */
function gaussianBlur(src, w, h, sigma) {
  if (!(sigma >= 0.2) || !w || !h) return src;
  const n = w * h;
  const a = new Float32Array(n), b = new Float32Array(n);
  if (sigma <= 4) {
    const r = Math.ceil(sigma * 3);
    const k = new Float32Array(2 * r + 1);
    let sum = 0;
    for (let j = -r; j <= r; j++) sum += k[j + r] = Math.exp(-(j * j) / (2 * sigma * sigma));
    for (let j = 0; j < k.length; j++) k[j] /= sum;
    const ext = new Int32Array(2 * h);
    convolveH(src, a, w, h, k, r, ext);
    convolveV(a, b, w, h, k, r, ext);
    return b;
  }
  const sums = new Float64Array(w);
  let from = src;
  for (const r of boxRadii(sigma)) {
    boxH(from, a, w, h, r);
    boxV(a, b, w, h, r, sums);
    from = b;
  }
  return b;
}

/** How far (pixels) gaussianBlur(sigma) spreads non-zero values beyond its input's support. */
function blurReach(sigma) {
  if (!(sigma >= 0.2)) return 0;
  if (sigma <= 4) return Math.ceil(sigma * 3);
  let s = 0;
  for (const r of boxRadii(sigma)) s += r;
  return s;
}

const EDT_INF = 1e20;

/** Felzenszwalb-Huttenlocher 1D squared distance transform of f (length n) into d. */
function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    const fq = f[q] + q * q;
    let vk = v[k];
    let s = (fq - (f[vk] + vk * vk)) / (2 * (q - vk));
    while (s <= z[k]) {
      k--;
      vk = v[k];
      s = (fq - (f[vk] + vk * vk)) / (2 * (q - vk));
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/**
 * Exact squared Euclidean distance from every pixel to the nearest seed pixel (seed[i] = 1).
 * With borderSeeds, everything outside the w x h area counts as a seed too.
 */
function squaredDistance(seed, w, h, borderSeeds) {
  const out = new Float32Array(w * h);
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    let any = false;
    for (let y = 0, i = x; y < h; y++, i += w) {
      if (seed[i]) {
        f[y] = 0;
        any = true;
      } else f[y] = EDT_INF;
    }
    if (any) edt1d(f, h, d, v, z);
    for (let y = 0, i = x; y < h; y++, i += w) {
      let val = any ? d[y] : EDT_INF;
      if (borderSeeds) {
        const m = y + 1 < h - y ? y + 1 : h - y;
        if (m * m < val) val = m * m;
      }
      out[i] = val;
    }
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let any = false;
    for (let x = 0; x < w; x++) {
      const val = out[row + x];
      f[x] = val;
      if (val < EDT_INF) any = true;
    }
    if (!any) continue;
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) {
      let val = d[x];
      if (borderSeeds) {
        const m = x + 1 < w - x ? x + 1 : w - x;
        if (m * m < val) val = m * m;
      }
      out[row + x] = val;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Working context: everything happens in a window (in source-image coordinates, possibly larger
// than the image) around the layer content, so the cost follows the content, not the canvas.

/** Content bounds (alpha > 0) and peak alpha of the whole image in one pass, or null when empty. */
function alphaStats(img) {
  const { width, height, data } = img;
  let x1 = width, y1 = height, x2 = -1, y2 = -1, maxA = 0;
  for (let y = 0; y < height; y++) {
    let p = y * width * 4 + 3, any = false;
    for (let x = 0; x < width; x++, p += 4) {
      const a = data[p];
      if (!a) continue;
      if (!any) {
        any = true;
        if (x < x1) x1 = x;
      }
      if (x > x2) x2 = x;
      if (a > maxA) maxA = a;
    }
    if (any) {
      if (y < y1) y1 = y;
      y2 = y;
    }
  }
  return x2 < 0 ? null : { cb: { x: x1, y: y1, width: x2 - x1 + 1, height: y2 - y1 + 1 }, maxA };
}

/**
 * Margins of the enabled effects, in whole pixels:
 *  - extent: how far beyond the content the output can be non-zero;
 *  - support: how far beyond the content any intermediate buffer (dilated / blurred mattes, bevel
 *    height map, stroke ring) can be non-zero, so a window this much larger loses nothing;
 *  - reach: how far from a pixel the content it depends on can lie (window cut through content).
 */
function styleMargins(s) {
  let extent = 0, support = 0, reach = 0;
  const use = (e, sp, re) => {
    if (e > extent) extent = e;
    if (sp > support) support = sp;
    if (re > reach) reach = re;
  };
  const shadow = (fx, outside) => {
    const br = blurReach(nonNeg(fx.size, 5) / 2.5), sp = Math.ceil(nonNeg(fx.spread)) + 1;
    const off = Math.ceil(Math.abs(num(fx.distance, 5))) + 1;
    use(outside ? sp + br + off : 0, outside ? sp + br : br + 1, sp + br + off + 2);
  };
  if (s.dropShadow.enabled) shadow(s.dropShadow, true);
  if (s.innerShadow.enabled) shadow(s.innerShadow, false);
  if (s.outerGlow.enabled) {
    const g = s.outerGlow, sp = Math.ceil(nonNeg(g.spread)) + 1 + blurReach(nonNeg(g.size, 5) / 2.5);
    use(sp, sp, sp + 2);
  }
  if (s.innerGlow.enabled) {
    const g = s.innerGlow, br = blurReach(nonNeg(g.size, 5) / 2.5);
    use(0, br + 1, Math.ceil(nonNeg(g.choke)) + br + 3);
  }
  if (s.satin.enabled) {
    const st = s.satin, br = blurReach(nonNeg(st.size, 14) / 2.5);
    use(0, br + 1, Math.ceil(Math.abs(num(st.distance, 11))) + br + 3);
  }
  if (s.bevel.enabled) {
    const bv = s.bevel, sp = Math.ceil(nonNeg(bv.size, 5)) + blurReach(bevelSigma(bv)) + 3;
    use((BEVEL_STYLES[bv.style] ?? 0) === 0 ? 0 : sp, sp, sp + 2);
  }
  if (s.stroke.enabled) {
    const st = s.stroke, size = nonNeg(st.size, 3), sp = Math.ceil(size) + 2;
    use(st.position === 'inside' ? 0 : Math.ceil(st.position === 'center' ? size / 2 : size) + 1, sp, sp + 2);
  }
  return { extent, support, reach: Math.max(reach, support) };
}

/**
 * Buffers for one applyStyles() call over the window win (source coordinates). cb is the whole
 * layer's content bounds and maxA its peak alpha, so results do not depend on the window.
 */
function makeContext(src, win, cb, maxA, fill) {
  const w = win.width, h = win.height, n = w * h;
  const A8 = new Uint8Array(n), L = new Float32Array(n);
  const I = { width: w, height: h, data: new Uint8ClampedArray(n * 4) };
  const Id = I.data, sd = src.data;
  const fillByte = Math.round(fill * 255);
  if (fillByte) for (let p = 3; p < Id.length; p += 4) Id[p] = fillByte;
  const sx0 = Math.max(0, win.x), sx1 = Math.min(src.width, win.x + w);
  const sy0 = Math.max(0, win.y), sy1 = Math.min(src.height, win.y + h);
  for (let sy = sy0; sy < sy1; sy++) {
    let si = (sy * src.width + sx0) * 4;
    let wi = (sy - win.y) * w + (sx0 - win.x);
    for (let sx = sx0; sx < sx1; sx++, si += 4, wi++) {
      const a = sd[si + 3];
      if (!a) continue;
      A8[wi] = a;
      L[wi] = a / 255;
      const p = wi * 4;
      Id[p] = sd[si];
      Id[p + 1] = sd[si + 1];
      Id[p + 2] = sd[si + 2];
    }
  }
  const cw = intersectRect(cb, win);
  return {
    w, h, n, A8, L, I,
    B: { width: w, height: h, data: new Uint8ClampedArray(n * 4) },
    fx: { width: w, height: h, data: new Uint8ClampedArray(n * 4) },
    full: { x: 0, y: 0, width: w, height: h },
    // content inside the window (where interior effects are evaluated) and the whole content box
    // (gradient geometry), both in window coordinates
    cb: { x: cw.x - win.x, y: cw.y - win.y, width: cw.width, height: cw.height },
    gb: { x: cb.x - win.x, y: cb.y - win.y, width: cb.width, height: cb.height },
    thr: Math.max(1, Math.ceil(maxA / 2)),
    fill, originX: -win.x, originY: -win.y,
    bEmpty: true, dissolveSalt: 0,
    inside: null, dOut: null, dIn: null, knock: null,
  };
}

/**
 * Per-pixel factor for effects drawn under the layer ("layer knocks out drop shadow"): with the
 * finished interior alpha ia over them, (1 - a) / (1 - ia) leaves them exactly (1 - a) visible,
 * a being the layer alpha. That hides them under a see-through fill (fill 0 -> ia = 0) and is 1
 * where the interior is as opaque as the layer (fill 1), so it varies continuously with the fill.
 */
function knockout(ctx) {
  if (!ctx.knock) {
    const { n, A8 } = ctx, Id = ctx.I.data;
    const K = new Float32Array(n);
    for (let i = 0, p = 3; i < n; i++, p += 4) {
      const a = A8[i], ia = Id[p];
      K[i] = !a ? 1 : ia >= 255 ? 0 : (255 - a) / (255 - ia);
    }
    ctx.knock = K;
  }
  return ctx.knock;
}

/** 1 where the alpha reaches half the layer's peak alpha: the thresholded matte. */
function insideMask(ctx) {
  if (!ctx.inside) {
    const m = new Uint8Array(ctx.n), A8 = ctx.A8, thr = ctx.thr;
    for (let i = 0; i < ctx.n; i++) m[i] = A8[i] >= thr ? 1 : 0;
    ctx.inside = m;
  }
  return ctx.inside;
}

/** Squared distance to the nearest inside pixel (0 inside). */
function distOut(ctx) {
  if (!ctx.dOut) ctx.dOut = squaredDistance(insideMask(ctx), ctx.w, ctx.h, false);
  return ctx.dOut;
}

/** Squared distance to the nearest outside pixel, the area beyond the window counting as outside (0 outside). */
function distIn(ctx) {
  if (!ctx.dIn) {
    const inside = insideMask(ctx);
    const outside = new Uint8Array(ctx.n);
    for (let i = 0; i < ctx.n; i++) outside[i] = inside[i] ? 0 : 1;
    ctx.dIn = squaredDistance(outside, ctx.w, ctx.h, true);
  }
  return ctx.dIn;
}

/** Layer alpha spread outwards by r pixels (antialiased), never below the original alpha. */
function dilateAlpha(ctx, r) {
  const { n, L } = ctx;
  if (!(r > 0)) return L;
  const inside = insideMask(ctx), dO = distOut(ctx);
  const out = new Float32Array(n);
  const ri = r < 1 ? r : 1;
  for (let i = 0; i < n; i++) {
    const l = L[i];
    if (inside[i]) out[i] = l + (1 - l) * ri;
    else {
      const v = r + 1 - Math.sqrt(dO[i]);
      out[i] = v >= 1 ? 1 : v > l ? v : l;
    }
  }
  return out;
}

/**
 * Layer alpha choked inwards by r pixels (antialiased). Edge pixels below the matte threshold
 * fade with the first pixel of the inside, so a choke of 0+ is continuous with no choke.
 */
function erodeAlpha(ctx, r) {
  const { n, L } = ctx;
  if (!(r > 0)) return L;
  const inside = insideMask(ctx), dI = distIn(ctx);
  const out = new Float32Array(n);
  const fringe = r < 1 ? 1 - r : 0;
  for (let i = 0; i < n; i++) {
    if (!inside[i]) {
      if (fringe) out[i] = L[i] * fringe;
      continue;
    }
    const v = Math.sqrt(dI[i]) - r;
    out[i] = v >= 1 ? L[i] : v > 0 ? L[i] * v : 0;
  }
  return out;
}

/**
 * Writes colour (r, g, b) with alpha = matte into ctx.fx inside rect. The matte is read at
 * (x - dx, y - dy) (0 outside the window), optionally inverted, optionally multiplied by the
 * per-pixel factor knock.
 */
function fillMatte(ctx, rect, col, matte, dx, dy, invert, knock) {
  const d = ctx.fx.data, w = ctx.w, h = ctx.h;
  const r = col[0], g = col[1], b = col[2];
  const x1 = rect.x + rect.width, y1 = rect.y + rect.height;
  for (let y = rect.y; y < y1; y++) {
    const sy = y - dy;
    const rowOk = sy >= 0 && sy < h;
    const srow = sy * w - dx;
    let i = y * w + rect.x;
    for (let x = rect.x; x < x1; x++, i++) {
      const sx = x - dx;
      let v = rowOk && sx >= 0 && sx < w ? matte[srow + x] : 0;
      if (invert) v = 1 - v;
      if (knock) v *= knock[i];
      const p = i * 4;
      d[p] = r;
      d[p + 1] = g;
      d[p + 2] = b;
      d[p + 3] = (v * 255 + 0.5) | 0;
    }
  }
}

/** Uniform [0, 1) hash noise for source pixel (x, y) and a salt: independent of the work window. */
function hashNoise(x, y, salt) {
  let v = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(salt + 1, 0x9e3779b1);
  v = Math.imul(v ^ (v >>> 15), 0x85ebca6b);
  v = Math.imul(v ^ (v >>> 13), 0xc2b2ae35);
  return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
}

/**
 * Blends ctx.fx onto target inside rect with the effect's blend mode and opacity. The first
 * effect drawn into the (still transparent) below-layer buffer is copied instead: over a
 * transparent backdrop every mode yields the source colour at alpha * opacity. 'dissolve' keeps
 * each effect pixel fully opaque with probability alpha * opacity (noise keyed on source
 * coordinates, so it does not move with pad / rect) and then draws it normally.
 */
function composite(ctx, target, mode, opacity, rect) {
  if (!(opacity > 0)) return;
  let m = blendOf(mode);
  if (m === 'dissolve') {
    const s = ctx.fx.data, w = ctx.w, r = rect || ctx.full, op = opacity > 1 ? 1 : opacity;
    const salt = ctx.dissolveSalt++;
    for (let y = r.y; y < r.y + r.height; y++) {
      for (let x = r.x, p = (y * w + r.x) * 4 + 3; x < r.x + r.width; x++, p += 4) {
        const sa = (s[p] / 255) * op;
        s[p] = sa > 0 && hashNoise(x - ctx.originX, y - ctx.originY, salt) < sa ? 255 : 0;
      }
    }
    m = 'normal';
    opacity = 1;
  }
  if (target === ctx.B && ctx.bEmpty) {
    const s = ctx.fx.data, d = target.data, w = ctx.w;
    const r = rect || ctx.full;
    for (let y = r.y; y < r.y + r.height; y++) {
      for (let p = (y * w + r.x) * 4, e = p + r.width * 4; p < e; p += 4) {
        const a = (s[p + 3] * opacity + 0.5) | 0;
        if (!a) continue;
        d[p] = s[p];
        d[p + 1] = s[p + 1];
        d[p + 2] = s[p + 2];
        d[p + 3] = a;
      }
    }
  } else blendImages(m, ctx.fx, target, opacity, rect);
  if (target === ctx.B) ctx.bEmpty = false;
}

const effectAlpha = (fx, col, def) => clamp01(num(fx.opacity, def)) * col[3];

function lightAngle(fx, opts) {
  return fx.useGlobalLight && Number.isFinite(opts.globalAngle) ? opts.globalAngle : num(fx.angle, 120);
}

/**
 * Rounds half away from zero after snapping float noise (cos(120 deg) * 5 is 2.4999999999999990),
 * so opposite angles give mirror-image offsets.
 */
function roundSym(v) {
  const a = Math.round(Math.round(Math.abs(v) * 1e6) / 1e6);
  return v < 0 && a ? -a : a;
}

/** Integer shadow offset for Photoshop's light angle: the shadow falls away from the light. */
function shadowOffset(angle, distance) {
  const a = angle * RAD;
  return [roundSym(-Math.cos(a) * distance), roundSym(Math.sin(a) * distance)];
}

// ---------------------------------------------------------------------------------------------
// Effects.

function dropShadow(ctx, fx, opts) {
  const col = parseColor(fx.color), alpha = effectAlpha(fx, col, 0.75);
  if (alpha <= 0) return;
  const base = dilateAlpha(ctx, nonNeg(fx.spread));
  const matte = gaussianBlur(base, ctx.w, ctx.h, nonNeg(fx.size, 5) / 2.5);
  const [dx, dy] = shadowOffset(lightAngle(fx, opts), num(fx.distance, 5));
  // "Layer knocks out drop shadow": only visible where the interior is more see-through than the layer.
  fillMatte(ctx, ctx.full, col, matte, dx, dy, false, knockout(ctx));
  composite(ctx, ctx.B, fx.blend, alpha, null);
}

function outerGlow(ctx, fx) {
  const col = parseColor(fx.color), alpha = effectAlpha(fx, col, 0.75);
  if (alpha <= 0) return;
  const base = dilateAlpha(ctx, nonNeg(fx.spread));
  const matte = gaussianBlur(base, ctx.w, ctx.h, nonNeg(fx.size, 5) / 2.5);
  fillMatte(ctx, ctx.full, col, matte, 0, 0, false, null);
  composite(ctx, ctx.B, fx.blend, alpha, null);
}

function innerShadow(ctx, fx, opts) {
  const col = parseColor(fx.color), alpha = effectAlpha(fx, col, 0.75);
  if (alpha <= 0) return;
  // The shadow of the surroundings: the inverted (choked) matte, blurred and offset.
  const base = erodeAlpha(ctx, nonNeg(fx.spread));
  const matte = gaussianBlur(base, ctx.w, ctx.h, nonNeg(fx.size, 5) / 2.5);
  const [dx, dy] = shadowOffset(lightAngle(fx, opts), num(fx.distance, 5));
  fillMatte(ctx, ctx.cb, col, matte, dx, dy, true, null);
  composite(ctx, ctx.I, fx.blend, alpha, ctx.cb);
}

function innerGlow(ctx, fx) {
  const col = parseColor(fx.color), alpha = effectAlpha(fx, col, 0.75);
  if (alpha <= 0) return;
  const base = erodeAlpha(ctx, nonNeg(fx.choke));
  const matte = gaussianBlur(base, ctx.w, ctx.h, nonNeg(fx.size, 5) / 2.5);
  fillMatte(ctx, ctx.cb, col, matte, 0, 0, fx.source !== 'center', null);
  composite(ctx, ctx.I, fx.blend, alpha, ctx.cb);
}

function satin(ctx, fx) {
  const col = parseColor(fx.color), alpha = effectAlpha(fx, col, 0.5);
  if (alpha <= 0) return;
  const { w, h, cb } = ctx;
  const bl = gaussianBlur(ctx.L, w, h, nonNeg(fx.size, 14) / 2.5);
  const a = num(fx.angle, 19) * RAD, dist = num(fx.distance, 11);
  const ox = roundSym(Math.cos(a) * dist), oy = roundSym(-Math.sin(a) * dist);
  const invert = fx.invert !== false;
  const d = ctx.fx.data, r = col[0], g = col[1], b = col[2];
  for (let y = cb.y; y < cb.y + cb.height; y++) {
    const y1 = y + oy, y2 = y - oy;
    const ok1 = y1 >= 0 && y1 < h, ok2 = y2 >= 0 && y2 < h;
    for (let x = cb.x; x < cb.x + cb.width; x++) {
      const x1 = x + ox, x2 = x - ox;
      const v1 = ok1 && x1 >= 0 && x1 < w ? bl[y1 * w + x1] : 0;
      const v2 = ok2 && x2 >= 0 && x2 < w ? bl[y2 * w + x2] : 0;
      let v = v1 > v2 ? v1 - v2 : v2 - v1;
      if (invert) v = 1 - v;
      const p = (y * w + x) * 4;
      d[p] = r;
      d[p + 1] = g;
      d[p + 2] = b;
      d[p + 3] = v * 255;
    }
  }
  composite(ctx, ctx.I, fx.blend, alpha, cb);
}

function colorOverlay(ctx, fx) {
  const col = parseColor(fx.color), alpha = effectAlpha(fx, col, 1);
  if (alpha <= 0) return;
  const { cb, w } = ctx, d = ctx.fx.data;
  for (let y = cb.y; y < cb.y + cb.height; y++) {
    for (let x = cb.x, p = (y * w + cb.x) * 4; x < cb.x + cb.width; x++, p += 4) {
      d[p] = col[0];
      d[p + 1] = col[1];
      d[p + 2] = col[2];
      d[p + 3] = 255;
    }
  }
  composite(ctx, ctx.I, fx.blend, alpha, cb);
}

const LUT_SIZE = 1024;

/** 1024-entry straight RGBA lookup of a gradient (colour and opacity interpolated independently). */
function gradientLut(stops) {
  let list = (Array.isArray(stops) ? stops : []).filter((s) => s && typeof s === 'object').map((s) => {
    const c = parseColor(s.color);
    const op = s.opacity === undefined ? 1 : clamp01(num(s.opacity, 1));
    return { pos: clamp01(num(s.pos ?? s.position, 0)), r: c[0], g: c[1], b: c[2], a: c[3] * op };
  });
  if (!list.length) list = [{ pos: 0, r: 0, g: 0, b: 0, a: 1 }, { pos: 1, r: 255, g: 255, b: 255, a: 1 }];
  list.sort((p, q) => p.pos - q.pos);
  const lut = new Uint8ClampedArray(LUT_SIZE * 4);
  const last = list.length - 1;
  let k = 0;
  for (let i = 0; i < LUT_SIZE; i++) {
    const t = i / (LUT_SIZE - 1);
    let s0, s1, f = 0;
    if (t <= list[0].pos) s0 = s1 = list[0];
    else if (t >= list[last].pos) s0 = s1 = list[last];
    else {
      // list[k].pos < t < list[last].pos here, and t only grows, so k only moves forward
      while (k < last - 1 && list[k + 1].pos < t) k++;
      s0 = list[k];
      s1 = list[k + 1];
      f = s1.pos > s0.pos ? (t - s0.pos) / (s1.pos - s0.pos) : 1;
    }
    const p = i * 4;
    lut[p] = s0.r + (s1.r - s0.r) * f;
    lut[p + 1] = s0.g + (s1.g - s0.g) * f;
    lut[p + 2] = s0.b + (s1.b - s0.b) * f;
    lut[p + 3] = (s0.a + (s1.a - s0.a) * f) * 255;
  }
  return lut;
}

const GRADIENT_KINDS = { linear: 0, reflected: 1, radial: 2, diamond: 3, angle: 4 };

function gradientOverlay(ctx, fx) {
  const alpha = clamp01(num(fx.opacity, 1));
  if (alpha <= 0) return;
  const lut = gradientLut(fx.stops);
  const { cb, w } = ctx, d = ctx.fx.data;
  const kind = GRADIENT_KINDS[fx.kind] ?? 0;
  const a = num(fx.angle, 90) * RAD;
  const ux = Math.cos(a), uy = -Math.sin(a); // gradient direction in y-down coordinates
  const vx = -uy, vy = ux;
  const scale = Math.max(0.01, num(fx.scale, 1));
  const reverse = !!fx.reverse;
  const gb = ctx.gb;
  const cx = gb.x + gb.width / 2, cy = gb.y + gb.height / 2;
  // Aligned with the layer: a linear gradient spans the content box along its direction.
  const len = Math.max(1e-6, (Math.abs(gb.width * ux) + Math.abs(gb.height * uy)) * scale);
  const rad = Math.max(1e-6, (Math.max(gb.width, gb.height) / 2) * scale);
  const TWO_PI = Math.PI * 2, top = LUT_SIZE - 1;
  for (let y = cb.y; y < cb.y + cb.height; y++) {
    const py = y + 0.5 - cy;
    for (let x = cb.x, p = (y * w + cb.x) * 4; x < cb.x + cb.width; x++, p += 4) {
      const px = x + 0.5 - cx;
      let t;
      if (kind === 0) t = 0.5 + (px * ux + py * uy) / len;
      else if (kind === 1) t = Math.abs(px * ux + py * uy) / (len / 2);
      else if (kind === 2) t = Math.sqrt(px * px + py * py) / rad;
      else if (kind === 3) t = (Math.abs(px * ux + py * uy) + Math.abs(px * vx + py * vy)) / rad;
      else {
        t = (Math.atan2(-py, px) - a) / TWO_PI;
        t -= Math.floor(t);
      }
      if (reverse) t = 1 - t;
      const q = (t <= 0 ? 0 : t >= 1 ? top : (t * top + 0.5) | 0) * 4;
      d[p] = lut[q];
      d[p + 1] = lut[q + 1];
      d[p + 2] = lut[q + 2];
      d[p + 3] = lut[q + 3];
    }
  }
  composite(ctx, ctx.I, fx.blend, alpha, cb);
}

function patternOverlay(ctx, fx) {
  const pat = fx.pattern;
  const alpha = clamp01(num(fx.opacity, 1));
  if (alpha <= 0 || !pat || !(pat.width >= 1) || !(pat.height >= 1) || !pat.data || pat.data.length < pat.width * pat.height * 4) return;
  const { cb, w, originX, originY } = ctx, d = ctx.fx.data;
  const pw = pat.width | 0, ph = pat.height | 0, pd = pat.data;
  const scale = Math.min(100, Math.max(0.01, num(fx.scale, 1)));
  const mod = (v, m) => ((v % m) + m) % m;
  if (Math.abs(scale - 1) < 1e-9) {
    for (let y = cb.y; y < cb.y + cb.height; y++) {
      const prow = mod(y - originY, ph) * pw;
      let u = mod(cb.x - originX, pw);
      for (let x = cb.x, p = (y * w + cb.x) * 4; x < cb.x + cb.width; x++, p += 4) {
        const q = (prow + u) * 4;
        d[p] = pd[q];
        d[p + 1] = pd[q + 1];
        d[p + 2] = pd[q + 2];
        d[p + 3] = pd[q + 3];
        if (++u === pw) u = 0;
      }
    }
  } else {
    // Bilinear, wrapping, premultiplied so transparent pattern pixels do not darken edges.
    for (let y = cb.y; y < cb.y + cb.height; y++) {
      const fv = (y + 0.5 - originY) / scale - 0.5;
      const y0 = Math.floor(fv), ty = fv - y0;
      const r0 = mod(y0, ph) * pw, r1 = mod(y0 + 1, ph) * pw;
      for (let x = cb.x, p = (y * w + cb.x) * 4; x < cb.x + cb.width; x++, p += 4) {
        const fu = (x + 0.5 - originX) / scale - 0.5;
        const x0 = Math.floor(fu), tx = fu - x0;
        const c0 = mod(x0, pw), c1 = c0 + 1 === pw ? 0 : c0 + 1;
        let r = 0, g = 0, b = 0, aa = 0;
        for (let k = 0; k < 4; k++) {
          const q = ((k < 2 ? r0 : r1) + (k & 1 ? c1 : c0)) * 4;
          const wgt = (k & 1 ? tx : 1 - tx) * (k < 2 ? 1 - ty : ty);
          const pa = pd[q + 3] * wgt;
          r += pd[q] * pa;
          g += pd[q + 1] * pa;
          b += pd[q + 2] * pa;
          aa += pa;
        }
        if (aa > 0) {
          d[p] = r / aa;
          d[p + 1] = g / aa;
          d[p + 2] = b / aa;
          d[p + 3] = aa;
        } else d[p] = d[p + 1] = d[p + 2] = d[p + 3] = 0;
      }
    }
  }
  composite(ctx, ctx.I, fx.blend, alpha, cb);
}

const BEVEL_STYLES = { 'inner-bevel': 0, 'outer-bevel': 1, emboss: 2, 'pillow-emboss': 3 };

/** Blur applied to a bevel's height map: a little for 'smooth', plus soften. */
const bevelSigma = (fx) => Math.hypot(fx.technique !== 'chisel-hard' ? 0.75 : 0, nonNeg(fx.soften) / 2.5);

/**
 * Highlight and shadow mattes of a bevel: a height map from the signed distance to the
 * thresholded edge (profile per style, smoothstep for 'smooth'), lightly blurred (plus soften),
 * lit by a directional light (angle, altitude) with the depth scaling the slopes. The height is
 * stored relative to its value far outside the layer (so it is 0 there and the zero-padded blur
 * cannot invent an edge at the window border); only its gradient matters.
 */
function bevelMaps(ctx, fx, opts) {
  const size = nonNeg(fx.size, 5), depth = nonNeg(fx.depth, 100) / 100;
  if (size <= 0 || depth <= 0) return null;
  const style = BEVEL_STYLES[fx.style] ?? 0;
  const smooth = fx.technique !== 'chisel-hard';
  const down = fx.direction === 'down';
  const { w, h, n, A8 } = ctx;
  const inside = insideMask(ctx), dI = distIn(ctx), dO = distOut(ctx);
  const H = new Float32Array(n);
  const half = size / 2;
  const tFar = style === 3 ? 1 : 0; // the profile's value far outside (pillow emboss rises outwards)
  // pixel centres sit at |sd| >= 0.5, so a pillow narrower than 1px a side would be flat
  const pillowHalf = half > 1 ? half : 1;
  for (let i = 0; i < n; i++) {
    const sd = inside[i] ? Math.sqrt(dI[i]) - 0.5 : 0.5 - Math.sqrt(dO[i]);
    let t;
    if (style === 0) t = sd / size;
    else if (style === 1) t = (sd + size) / size;
    else if (style === 2) t = (sd + half) / size;
    else t = (sd < 0 ? -sd : sd) / pillowHalf;
    t = t <= 0 ? 0 : t >= 1 ? 1 : t;
    if (smooth) t = t * t * (3 - 2 * t);
    H[i] = down ? tFar - t : t - tFar;
  }
  const Hb = gaussianBlur(H, w, h, bevelSigma(fx));
  const angle = lightAngle(fx, opts) * RAD;
  const alt = Math.min(90, Math.max(0, fx.useGlobalLight && Number.isFinite(opts.globalAltitude) ? opts.globalAltitude : num(fx.altitude, 30))) * RAD;
  const lx = Math.cos(angle) * Math.cos(alt), ly = -Math.sin(angle) * Math.cos(alt), lz = Math.sin(alt);
  const hiDen = 1 - lz, shDen = Math.max(lz, 1e-3);
  const k = size * depth;
  const hl = new Float32Array(n), sh = new Float32Array(n);
  // Outside the layer the shading ends (1px antialiased fade) at the nominal extent, size (half
  // of it for emboss and pillow emboss) plus soften, which is what stylePadding() pads for: the
  // central differences and the blur would otherwise leak a few pixels past it and get clipped.
  const lim = style === 0 ? 0 : (style === 1 ? size : half) + nonNeg(fx.soften) + 1;
  for (let y = 0; y < h; y++) {
    const up = (y > 0 ? y - 1 : 0) * w, dn = (y < h - 1 ? y + 1 : h - 1) * w;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const gx = (Hb[x < w - 1 ? i + 1 : i] - Hb[x > 0 ? i - 1 : i]) * 0.5;
      const gy = (Hb[dn + x] - Hb[up + x]) * 0.5;
      if (gx === 0 && gy === 0) continue;
      let fade = 1;
      if (!A8[i]) {
        fade = lim - Math.sqrt(dO[i]);
        if (fade <= 0) continue;
        if (fade > 1) fade = 1;
      }
      const nx = -k * gx, ny = -k * gy;
      const shade = (nx * lx + ny * ly + lz) / Math.sqrt(nx * nx + ny * ny + 1);
      if (shade > lz) {
        if (hiDen > 1e-6) hl[i] = Math.min(1, (shade - lz) / hiDen) * fade;
      } else if (shade < lz) sh[i] = Math.min(1, (lz - shade) / shDen) * fade;
    }
  }
  return { hl, sh, inner: style !== 1, outer: style !== 0 };
}

function bevelPart(ctx, fx, maps, outer) {
  const target = outer ? ctx.B : ctx.I;
  const rect = outer ? ctx.full : ctx.cb;
  const knock = outer ? knockout(ctx) : null;
  const hc = parseColor(fx.highlightColor), ha = effectAlpha({ opacity: fx.highlightOpacity }, hc, 0.75);
  if (ha > 0) {
    fillMatte(ctx, rect, hc, maps.hl, 0, 0, false, knock);
    composite(ctx, target, fx.highlightBlend || 'screen', ha, rect);
  }
  const sc = parseColor(fx.shadowColor), sa = effectAlpha({ opacity: fx.shadowOpacity }, sc, 0.75);
  if (sa > 0) {
    fillMatte(ctx, rect, sc, maps.sh, 0, 0, false, knock);
    composite(ctx, target, fx.shadowBlend || 'multiply', sa, rect);
  }
}

function strokeRadii(fx) {
  const size = nonNeg(fx.size, 3);
  if (fx.position === 'inside') return [size, 0];
  if (fx.position === 'center') return [size / 2, size / 2];
  return [0, size];
}

/** Inside part of a stroke: recolours the band within r pixels of the edge (clipped later). */
function strokeInner(ctx, fx, r) {
  const col = parseColor(fx.color), alpha = effectAlpha(fx, col, 1);
  if (alpha <= 0) return;
  const inside = insideMask(ctx), dI = distIn(ctx);
  const { cb, w } = ctx, d = ctx.fx.data;
  for (let y = cb.y; y < cb.y + cb.height; y++) {
    for (let x = cb.x, i = y * w + cb.x; x < cb.x + cb.width; x++, i++) {
      let v = 1;
      if (inside[i]) {
        const e = Math.sqrt(dI[i]) - r;
        v = e <= 0 ? 1 : e >= 1 ? 0 : 1 - e;
      }
      const p = i * 4;
      d[p] = col[0];
      d[p + 1] = col[1];
      d[p + 2] = col[2];
      d[p + 3] = v * 255;
    }
  }
  composite(ctx, ctx.I, fx.blend, alpha, cb);
}

/**
 * Outside part of a stroke: the ring between the layer edge and r pixels out, drawn under the
 * finished interior. Its alpha is raised by 1 / (1 - interior alpha) so ring + layer cover
 * exactly the dilated shape (antialiased edges get no seam, a see-through fill shows no stroke).
 */
function strokeOuter(ctx, fx, r) {
  const col = parseColor(fx.color), alpha = effectAlpha(fx, col, 1);
  if (alpha <= 0) return;
  const inside = insideMask(ctx), dO = distOut(ctx), dI = distIn(ctx);
  const { n, L } = ctx, Id = ctx.I.data, d = ctx.fx.data;
  const ri = r < 1 ? r : 1;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const l = L[i];
    let ring;
    if (inside[i]) ring = dI[i] <= 2 ? (1 - l) * ri : 0; // edge pixels fill their antialiasing gap
    else {
      const v = r + 1 - Math.sqrt(dO[i]);
      const D = v >= 1 ? 1 : v > 0 ? v : 0;
      ring = D > l ? D - l : 0;
    }
    let v = 0;
    if (ring > 0) {
      const den = 1 - Id[p + 3] / 255;
      v = den > 1e-6 ? (ring >= den ? 1 : ring / den) : 0;
    }
    d[p] = col[0];
    d[p + 1] = col[1];
    d[p + 2] = col[2];
    d[p + 3] = v * 255;
  }
  composite(ctx, ctx.B, fx.blend, alpha, null);
}

/** Copies rect of src into dst at (dx, dy) (rect inside src, destination inside dst). */
function copyRect(src, rect, dst, dx, dy) {
  for (let y = 0; y < rect.height; y++) {
    const s = ((rect.y + y) * src.width + rect.x) * 4;
    dst.data.set(src.data.subarray(s, s + rect.width * 4), ((dy + y) * dst.width + dx) * 4);
  }
}

/**
 * Renders the enabled layer effects of styles around img.
 *
 * The output is (width + 2 * pad) x (height + 2 * pad) with the layer drawn at (pad, pad);
 * offsetX / offsetY are where its top-left lands relative to the input (-pad, -pad), so the
 * caller draws it at (layer.x + offsetX, layer.y + offsetY). Every output pixel is what an
 * unbounded canvas would show at that position: a smaller pad or a rect only crops the result,
 * it never changes the pixels that remain. With nothing enabled (and full fill opacity) it
 * returns a copy of img padded by pad (pad defaults to 0 then). Deterministic.
 *
 * @param {ImageDataLike} img layer pixels, straight alpha; not modified
 * @param {object | null} styles partial styles (see DEFAULT_STYLES); missing fields use defaults
 * @param {{ pad?: number, rect?: Rect, fillOpacity?: number, globalAngle?: number, globalAltitude?: number }} [opts]
 *   pad: border to add (default stylePadding(styles)); a smaller pad clips the effects.
 *   rect: output region of img (clipped to it, default the whole image): the output covers the
 *     rect grown by pad, offsets rect.x - pad, rect.y - pad, and matches the whole-image result
 *     there (layer pixels outside the rect still cast their effects into it, as in filters.js).
 *   fillOpacity: Photoshop's Fill (0..1, default 1): fades the layer's own pixels but not its
 *     effects (a 0 fill with a stroke or overlay keeps only the effect).
 *   globalAngle / globalAltitude: used by effects that set useGlobalLight: true.
 * @returns {{ image: ImageDataLike, offsetX: number, offsetY: number }}
 */
export function applyStyles(img, styles, opts = {}) {
  const o = opts || {};
  const s = mergeStyles(styles);
  const need = stylePadding(s);
  const pad = Math.max(0, Math.floor(num(o.pad, need)));
  const r = o.rect ? clampRect(o.rect, img.width, img.height) : fullRect(img);
  const W = r.width + pad * 2, H = r.height + pad * 2;
  const offsetX = r.x - pad, offsetY = r.y - pad;
  const out = createImage(W, H);
  const fill = clamp01(num(o.fillOpacity, 1));
  if (!hasEnabledStyles(s) && fill >= 1) {
    pasteImage(out, img, -offsetX, -offsetY);
    return { image: out, offsetX, offsetY };
  }
  const stats = isEmptyRect(r) ? null : alphaStats(img); // a rect outside img selects nothing
  if (!stats) return { image: out, offsetX, offsetY };
  const cb = stats.cb;
  const { extent, support, reach } = styleMargins(s);
  // R: the output pixels that can be non-zero (source coordinates). The window adds the content
  // they depend on (reach) wherever intermediate buffers can be non-zero (support).
  const R = intersectRect({ x: offsetX, y: offsetY, width: W, height: H }, inflateRect(cb, extent));
  if (isEmptyRect(R)) return { image: out, offsetX, offsetY };
  const win = unionRect(intersectRect(inflateRect(R, reach), inflateRect(cb, support)), R);
  const ctx = makeContext(img, win, cb, stats.maxA, fill);
  const maps = s.bevel.enabled ? bevelMaps(ctx, s.bevel, o) : null;

  // The layer and the effects clipped to it, bottom to top.
  if (s.patternOverlay.enabled) patternOverlay(ctx, s.patternOverlay);
  if (s.gradientOverlay.enabled) gradientOverlay(ctx, s.gradientOverlay);
  if (s.colorOverlay.enabled) colorOverlay(ctx, s.colorOverlay);
  if (s.satin.enabled) satin(ctx, s.satin);
  if (s.innerGlow.enabled) innerGlow(ctx, s.innerGlow);
  if (s.innerShadow.enabled) innerShadow(ctx, s.innerShadow, o);
  if (maps && maps.inner) bevelPart(ctx, s.bevel, maps, false);
  const [strokeIn, strokeOut] = s.stroke.enabled ? strokeRadii(s.stroke) : [0, 0];
  if (strokeIn > 0) strokeInner(ctx, s.stroke, strokeIn);

  // Clip the interior to the layer alpha.
  const Id = ctx.I.data, A8 = ctx.A8;
  for (let i = 0, p = 0; i < ctx.n; i++, p += 4) {
    const a = ((Id[p + 3] * A8[i]) / 255 + 0.5) | 0;
    if (a) Id[p + 3] = a;
    else Id[p] = Id[p + 1] = Id[p + 2] = Id[p + 3] = 0;
  }

  // Below the layer, bottom to top (drawn once the interior is known, for the knock-out).
  if (s.dropShadow.enabled) dropShadow(ctx, s.dropShadow, o);
  if (s.outerGlow.enabled) outerGlow(ctx, s.outerGlow);
  if (maps && maps.outer) bevelPart(ctx, s.bevel, maps, true);
  if (strokeOut > 0) strokeOuter(ctx, s.stroke, strokeOut);

  // Nothing below the layer: the clipped interior is the result (what blendImages would produce).
  let res = ctx.I;
  if (!ctx.bEmpty) {
    blendImages('normal', ctx.I, ctx.B, 1, ctx.cb);
    res = ctx.B;
  }
  copyRect(res, { x: R.x - win.x, y: R.y - win.y, width: R.width, height: R.height }, out, R.x - offsetX, R.y - offsetY);
  return { image: out, offsetX, offsetY };
}
