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
// (no light seam along antialiased edges). The interior is rendered before the effects below it
// so the drop shadow and the outer bevel can be knocked out by it: they stay (1 - layer alpha)
// visible, which hides them under a see-through fill and varies continuously with fillOpacity.
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
//
// 0.4 (ARCHITECTURE.md "0.4 features", J.6; package layer-style-effects): the keys of INSTANCE_KEYS
// may hold several instances (an array, top first; the bottom one is drawn first), `hidden: true`
// hides every effect, and each effect takes Photoshop's further fields (contours, noise, glow
// technique and gradient fill, the Bevel & Emboss Contour and Texture, gradient and pattern
// placement, the Stroke's gradient and pattern fills: styles-more.js EFFECT_FIELD_DEFAULTS). An
// effect whose new fields hold their defaults takes 0.3's code path, so 0.3 documents render bit
// for bit as before. applyStyles also implements Blend Interior Effects as Group
// (interiorAsGroup), Transparency Shapes Layer (transparencyShapes) and `split`, and splitEffects
// returns each effect exactly as the merged render draws it.

import { createImage, pasteImage, clampRect, intersectRect, unionRect, inflateRect, isEmptyRect, fullRect, clamp01 } from './core.js';
import { parseColor } from './color.js';
import { blendImages, isBlendMode } from './blend.js';
import { normalizeGradient, gradientLut as modelGradientLut } from './gradient-model.js';
import { contourLut, lookupContour, isLinearContour, rangeInput } from './contour.js';
import {
  EFFECT_FIELD_DEFAULTS, profileMap, noiseOf, glowGradientLut, isPatternData, patternPlacement, fillPattern, patternLuma,
  gradientParam, lutIndex, effectGradientLut, noiseAt,
} from './styles-more.js';

export { EFFECT_FIELD_DEFAULTS };

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

/** Keys Photoshop allows several instances of (an array of effect objects, at most MAX_INSTANCES). */
export const INSTANCE_KEYS = Object.freeze(['dropShadow', 'innerShadow', 'colorOverlay', 'gradientOverlay', 'stroke']);
export const MAX_INSTANCES = 10;

/**
 * What styles.js implements (ARCHITECTURE.md "0.4 features", J.6): every instance of an array is
 * drawn, and the applyStyles options interiorAsGroup, transparencyShapes and split are real (the
 * skeleton shipped them false; specs of other packages that need them skip while a flag is false).
 */
export const STYLE_FEATURES = Object.freeze({ instances: true, interiorAsGroup: true, transparencyShapes: true, split: true });

/** An effect's full defaults: 0.3's DEFAULT_STYLES entry plus the 0.4 fields (for the dialog and tests). */
export function effectDefaults(key) {
  return JSON.parse(JSON.stringify({ ...DEFAULT_STYLES[key], ...EFFECT_FIELD_DEFAULTS[key] }));
}

function mergeEffect(key, p) {
  const def = DEFAULT_STYLES[key];
  const fx = { ...def };
  if (p && typeof p === 'object') {
    for (const k of Object.keys(p)) if (p[k] !== undefined) fx[k] = p[k];
  }
  if (key === 'gradientOverlay') {
    fx.stops = (Array.isArray(fx.stops) ? fx.stops : def.stops).map((s) => ({ ...s }));
    if (fx.gradient && typeof fx.gradient === 'object') fx.gradient = JSON.parse(JSON.stringify(fx.gradient));
  }
  // the 0.4 nested fields are copied one level deep (a decoded pattern inside is kept by reference)
  for (const k of ['texture', 'contourSub']) if (fx[k] && typeof fx[k] === 'object') fx[k] = { ...fx[k] };
  for (const k of ['offset', 'origin']) if (Array.isArray(fx[k])) fx[k] = [...fx[k]];
  return fx;
}

/**
 * Full style object: every effect key present, each effect's missing (or undefined) fields filled
 * from DEFAULT_STYLES. Returns fresh objects (gradient stops are copied, a pattern is kept by
 * reference); unknown top-level keys are dropped; partial is not modified. An array of instances
 * (INSTANCE_KEYS) stays an array, each element merged with the key's defaults, and `hidden` (Hide
 * All Effects) is kept.
 * @param {object | null} [partial]
 * @returns {Record<string, any>}
 */
export function mergeStyles(partial = null) {
  const src = partial && typeof partial === 'object' ? partial : {};
  const out = {};
  for (const key of EFFECT_KEYS) {
    const p = src[key];
    if (Array.isArray(p)) {
      const list = p.filter((x) => x && typeof x === 'object');
      if (INSTANCE_KEYS.includes(key) && list.length) out[key] = list.slice(0, MAX_INSTANCES).map((x) => mergeEffect(key, x));
      else out[key] = mergeEffect(key, list[0]);
    } else out[key] = mergeEffect(key, p);
  }
  if (typeof src.hidden === 'boolean') out.hidden = src.hidden;
  return out;
}

/** The instances of an effect key, top first ([] when absent). */
export function effectInstances(styles, key) {
  const v = styles && typeof styles === 'object' ? styles[key] : null;
  if (Array.isArray(v)) return v.filter((x) => x && typeof x === 'object');
  return v && typeof v === 'object' ? [v] : [];
}

/** Every effect instance in the Layer Style dialog's order: { key, index, name, fx }. */
export function effectEntries(styles) {
  const out = [];
  for (const { key, name } of STYLE_KEYS) effectInstances(styles, key).forEach((fx, index) => out.push({ key, index, name, fx }));
  return out;
}

/** Writes an array only when there is more than one instance; none removes the key. */
function storeInstances(out, key, list) {
  if (!list.length) delete out[key];
  else out[key] = list.length === 1 ? list[0] : list.slice(0, MAX_INSTANCES);
}

/**
 * A copy of styles with instance `index` of `key` patched (index === its count appends one), or
 * removed with patch null.
 */
export function setEffect(styles, key, index, patch) {
  const out = { ...(styles && typeof styles === 'object' ? styles : {}) };
  const list = effectInstances(out, key).map((fx) => ({ ...fx }));
  if (patch === null) list.splice(index, 1);
  else if (index >= list.length) list.push({ ...patch });
  else list[index] = { ...list[index], ...patch };
  storeInstances(out, key, list);
  return out;
}

/** A copy of styles with fn(fx, key, index) -> fx applied to every instance (other keys kept). */
export function mapEffects(styles, fn) {
  const out = { ...(styles && typeof styles === 'object' ? styles : {}) };
  for (const key of EFFECT_KEYS) {
    if (!(key in out)) continue;
    const list = effectInstances(out, key).map((fx, i) => fn({ ...fx }, key, i) ?? fx);
    if (Array.isArray(out[key])) out[key] = list;
    else if (list.length) out[key] = list[0];
  }
  return out;
}

/** Pixel fields Scale Effects scales (0.3's Image Size also scaled `width`). */
const SCALED_FIELDS = ['size', 'distance', 'spread', 'choke', 'soften', 'width'];

const scaledPair = (v, f) => (Array.isArray(v) && v.length === 2 ? [Number(v[0]) * f, Number(v[1]) * f] : v);

/**
 * Layer > Layer Style > Scale Effects and Image Size: every instance's pixel fields (size,
 * distance, spread, choke, soften), the pattern overlay's, the stroke pattern's and the bevel
 * texture's scale and their Snap to Origin offsets (document pixels), times k. Gradient scales
 * and offsets are relative to the layer and stay.
 */
export function scaleEffects(styles, k) {
  const f = Number.isFinite(k) ? k : 1;
  return mapEffects(styles, (fx, key) => {
    for (const field of SCALED_FIELDS) if (typeof fx[field] === 'number') fx[field] *= f;
    if (key === 'patternOverlay') {
      if (typeof fx.scale === 'number') fx.scale *= f;
      if (fx.origin !== undefined) fx.origin = scaledPair(fx.origin, f);
    }
    if (key === 'stroke') {
      if (typeof fx.patternScale === 'number') fx.patternScale *= f;
      if (fx.origin !== undefined) fx.origin = scaledPair(fx.origin, f);
    }
    if (fx.texture && typeof fx.texture === 'object') {
      const t = { ...fx.texture };
      if (typeof t.scale === 'number') t.scale *= f;
      if (t.origin !== undefined) t.origin = scaledPair(t.origin, f);
      fx.texture = t;
    }
    return fx;
  });
}

/** True when at least one effect of styles is enabled and they are not hidden. */
export function hasEnabledStyles(styles) {
  if (!styles || typeof styles !== 'object' || styles.hidden === true) return false;
  for (const key of EFFECT_KEYS) {
    const v = styles[key];
    if (Array.isArray(v) ? v.some((x) => x && x.enabled) : v && v.enabled) return true;
  }
  return false;
}

/** What is drawn: nothing while hidden (Hide All Effects). */
function renderable(styles) {
  if (!styles || typeof styles !== 'object') return styles;
  return styles.hidden === true ? {} : styles;
}

/** The enabled instances of key in drawing order (the bottom of the dialog's list first), with their indices. */
function drawn(s, key) {
  const v = s[key];
  const list = Array.isArray(v) ? v : v ? [v] : [];
  const out = [];
  for (let i = list.length - 1; i >= 0; i--) if (list[i] && list[i].enabled) out.push({ fx: list[i], index: i });
  return out;
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
  const s = mergeStyles(renderable(styles));
  let pad = 0;
  for (const { fx: ds } of drawn(s, 'dropShadow')) pad = Math.max(pad, nonNeg(ds.size, 5) + Math.abs(num(ds.distance, 5)) + nonNeg(ds.spread));
  for (const { fx: og } of drawn(s, 'outerGlow')) pad = Math.max(pad, nonNeg(og.size, 5) + nonNeg(og.spread));
  for (const { fx: st } of drawn(s, 'stroke')) {
    const size = nonNeg(st.size, 3);
    if (st.position === 'center') pad = Math.max(pad, size / 2);
    else if (st.position !== 'inside') pad = Math.max(pad, size);
  }
  for (const { fx: bv } of drawn(s, 'bevel')) {
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
  for (const { fx } of drawn(s, 'dropShadow')) shadow(fx, true);
  for (const { fx } of drawn(s, 'innerShadow')) shadow(fx, false);
  // a glow with the Precise technique reaches size + spread (a distance ramp instead of a blur)
  const precise = (g) => (g.technique === 'precise' ? Math.ceil(nonNeg(g.size, 5) + nonNeg(g.spread)) + 2 : 0);
  for (const { fx: g } of drawn(s, 'outerGlow')) {
    const sp = Math.max(Math.ceil(nonNeg(g.spread)) + 1 + blurReach(nonNeg(g.size, 5) / 2.5), precise(g));
    use(sp, sp, sp + 2);
  }
  for (const { fx: g } of drawn(s, 'innerGlow')) {
    const br = Math.max(blurReach(nonNeg(g.size, 5) / 2.5), precise(g));
    use(0, br + 1, Math.ceil(nonNeg(g.choke)) + br + 3);
  }
  for (const { fx: st } of drawn(s, 'satin')) {
    const br = blurReach(nonNeg(st.size, 14) / 2.5);
    use(0, br + 1, Math.ceil(Math.abs(num(st.distance, 11))) + br + 3);
  }
  for (const { fx: bv } of drawn(s, 'bevel')) {
    const sp = Math.ceil(nonNeg(bv.size, 5)) + blurReach(bevelSigma(bv)) + 3;
    use((BEVEL_STYLES[bv.style] ?? 0) === 0 ? 0 : sp, sp, sp + 2);
  }
  for (const { fx: st } of drawn(s, 'stroke')) {
    const size = nonNeg(st.size, 3), sp = Math.ceil(size) + 2;
    use(st.position === 'inside' ? 0 : Math.ceil(st.position === 'center' ? size / 2 : size) + 1, sp, sp + 2);
  }
  return { extent, support, reach: Math.max(reach, support) };
}

/**
 * Buffers for one applyStyles() call over the window win (source coordinates). cb is the whole
 * layer's content bounds and maxA its peak alpha, so results do not depend on the window.
 */
function makeContext(src, win, cb, maxA, fill, mode = {}) {
  const w = win.width, h = win.height, n = w * h;
  const A8 = new Uint8Array(n), L = new Float32Array(n);
  const I = { width: w, height: h, data: new Uint8ClampedArray(n * 4) };
  const Id = I.data, sd = src.data;
  // The interior starts as the layer colour at the fill opacity everywhere (it is clipped to the
  // layer alpha at the end). Blend Interior Effects as Group starts it opaque and fades it with the
  // fill after the grouped effects; Transparency Shapes Layer off starts it with the layer's own
  // alpha (the effects then cover the whole layer box).
  const box = !!mode.box, group = !!mode.group;
  const fillByte = Math.round((group ? 1 : fill) * 255);
  if (fillByte && !box) for (let p = 3; p < Id.length; p += 4) Id[p] = fillByte;
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
      if (box) Id[p + 3] = (a * fillByte) / 255; // a clamped array rounds to nearest
    }
  }
  const cw = intersectRect(cb, win);
  const place = mode.place ?? null;
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
    box, group,
    // the document position of the source image's (0, 0) and the document size (pattern Link with
    // Layer off, gradient Align with Layer off); without them the image is the document
    docX: place?.x ?? 0, docY: place?.y ?? 0, docW: place?.width ?? src.width, docH: place?.height ?? src.height,
    // splitEffects: every effect drawn is recorded here (null otherwise)
    record: null,
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
function composite(ctx, target, mode, opacity, rect, tag = null) {
  if (!(opacity > 0)) return;
  if (ctx.record && tag) recordEffect(ctx, target, mode, opacity, rect, tag);
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
// Effects. Each takes its effect object fx (merged with DEFAULT_STYLES; the 0.4 fields may be
// absent and then hold EFFECT_FIELD_DEFAULTS) and a tag ({ key, index }) for splitEffects.

/** A salt per effect instance, so the noise of two instances (or of a shadow and a glow) differs. */
const saltOf = (tag, k = 0) => (tag ? (EFFECT_KEYS.indexOf(tag.key) + 1) * 977 + tag.index * 131 + k * 17 : k);

/**
 * Writes an effect whose opacity profile is the matte (read at (x - dx, y - dy), inverted for
 * the inner effects) into ctx.fx inside rect, reshaped by the effect's contour (and a glow's
 * Range), with its noise, coloured by its colour or, for a glow with a gradient fill, by the
 * gradient at 1 - profile (the left end at the layer edge) with jitter. Takes fillMatte, 0.3's
 * code, when none of that is set.
 */
function drawProfile(ctx, rect, col, matte, dx, dy, invert, knock, fx, { withRange = false, gradLut = null, tag = null } = {}) {
  const map = profileMap(fx, { withRange });
  const noise = noiseOf(fx);
  if (!map && !noise && !gradLut) return fillMatte(ctx, rect, col, matte, dx, dy, invert, knock);
  const jitter = gradLut ? clamp01(num(fx.jitter, 0)) : 0;
  const salt = saltOf(tag, 1), jsalt = saltOf(tag, 2);
  const d = ctx.fx.data, w = ctx.w, h = ctx.h;
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
      if (map) v = map(v);
      if (noise && v > 0) {
        v *= 1 + noise * (2 * noiseAt(x - ctx.originX, y - ctx.originY, salt) - 1);
        if (v > 1) v = 1;
      }
      const p = i * 4;
      if (gradLut) {
        let u = 1 - v;
        if (jitter) u += jitter * (noiseAt(x - ctx.originX, y - ctx.originY, jsalt) - 0.5);
        const q = (u <= 0 ? 0 : u >= 1 ? 255 : (u * 255 + 0.5) | 0) * 4;
        d[p] = gradLut[q];
        d[p + 1] = gradLut[q + 1];
        d[p + 2] = gradLut[q + 2];
        v *= gradLut[q + 3] / 255;
      } else {
        d[p] = col[0];
        d[p + 1] = col[1];
        d[p + 2] = col[2];
      }
      if (knock) v *= knock[i];
      d[p + 3] = (v * 255 + 0.5) | 0;
    }
  }
}

function dropShadow(ctx, fx, opts, tag) {
  const col = parseColor(fx.color), alpha = effectAlpha(fx, col, 0.75);
  if (alpha <= 0) return;
  const base = dilateAlpha(ctx, nonNeg(fx.spread));
  const matte = gaussianBlur(base, ctx.w, ctx.h, nonNeg(fx.size, 5) / 2.5);
  const [dx, dy] = shadowOffset(lightAngle(fx, opts), num(fx.distance, 5));
  // "Layer knocks out drop shadow": only visible where the interior is more see-through than the layer.
  drawProfile(ctx, ctx.full, col, matte, dx, dy, false, fx.knocksOut === false ? null : knockout(ctx), fx, { tag });
  composite(ctx, ctx.B, fx.blend, alpha, null, tag);
}

/**
 * The Precise technique of the glows: a ramp over the exact distance to the layer edge instead of
 * a blur (sharp corners stay sharp). Outer: 1 within `spread` of the edge, 0 at spread + size.
 * Inner: 0 within `choke` of the edge rising to 1 at choke + size (inverted for an Edge source,
 * like the blurred matte).
 */
function preciseMatte(ctx, fx, outer) {
  const { n } = ctx;
  const size = Math.max(1, nonNeg(fx.size, 5));
  const inside = insideMask(ctx);
  const out = new Float32Array(n);
  if (outer) {
    const dO = distOut(ctx), sp = nonNeg(fx.spread), L = ctx.L;
    for (let i = 0; i < n; i++) {
      if (inside[i]) out[i] = 1;
      else {
        const v = 1 - (Math.sqrt(dO[i]) - 1 - sp) / size;
        out[i] = v >= 1 ? 1 : v > L[i] ? v : L[i];
      }
    }
  } else {
    const dI = distIn(ctx), ch = nonNeg(fx.choke);
    for (let i = 0; i < n; i++) {
      if (!inside[i]) continue;
      const v = (Math.sqrt(dI[i]) - 1 - ch) / size;
      out[i] = v <= 0 ? 0 : v >= 1 ? 1 : v;
    }
  }
  return out;
}

function outerGlow(ctx, fx, tag) {
  const col = parseColor(fx.color), alpha = effectAlpha(fx, col, 0.75);
  if (alpha <= 0) return;
  let matte;
  if (fx.technique === 'precise') matte = preciseMatte(ctx, fx, true);
  else {
    const base = dilateAlpha(ctx, nonNeg(fx.spread));
    matte = gaussianBlur(base, ctx.w, ctx.h, nonNeg(fx.size, 5) / 2.5);
  }
  drawProfile(ctx, ctx.full, col, matte, 0, 0, false, null, fx, { withRange: true, gradLut: glowGradientLut(fx, fx.color), tag });
  composite(ctx, ctx.B, fx.blend, fx.fill === 'gradient' ? clamp01(num(fx.opacity, 0.75)) : alpha, null, tag);
}

function innerShadow(ctx, fx, opts, tag) {
  const col = parseColor(fx.color), alpha = effectAlpha(fx, col, 0.75);
  if (alpha <= 0) return;
  // The shadow of the surroundings: the inverted (choked) matte, blurred and offset.
  const base = erodeAlpha(ctx, nonNeg(fx.spread));
  const matte = gaussianBlur(base, ctx.w, ctx.h, nonNeg(fx.size, 5) / 2.5);
  const [dx, dy] = shadowOffset(lightAngle(fx, opts), num(fx.distance, 5));
  drawProfile(ctx, ctx.cb, col, matte, dx, dy, true, null, fx, { tag });
  composite(ctx, ctx.I, fx.blend, alpha, ctx.cb, tag);
}

function innerGlow(ctx, fx, tag) {
  const col = parseColor(fx.color), alpha = effectAlpha(fx, col, 0.75);
  if (alpha <= 0) return;
  let matte;
  if (fx.technique === 'precise') matte = preciseMatte(ctx, fx, false);
  else {
    const base = erodeAlpha(ctx, nonNeg(fx.choke));
    matte = gaussianBlur(base, ctx.w, ctx.h, nonNeg(fx.size, 5) / 2.5);
  }
  drawProfile(ctx, ctx.cb, col, matte, 0, 0, fx.source !== 'center', null, fx, { withRange: true, gradLut: glowGradientLut(fx, fx.color), tag });
  composite(ctx, ctx.I, fx.blend, fx.fill === 'gradient' ? clamp01(num(fx.opacity, 0.75)) : alpha, ctx.cb, tag);
}

function satin(ctx, fx, tag) {
  const col = parseColor(fx.color), alpha = effectAlpha(fx, col, 0.5);
  if (alpha <= 0) return;
  const { w, h, cb } = ctx;
  const bl = gaussianBlur(ctx.L, w, h, nonNeg(fx.size, 14) / 2.5);
  const a = num(fx.angle, 19) * RAD, dist = num(fx.distance, 11);
  const ox = roundSym(Math.cos(a) * dist), oy = roundSym(-Math.sin(a) * dist);
  const invert = fx.invert !== false;
  // 0.4: the contour reshapes the satin's profile (the difference of the two offset copies) before Invert
  const map = profileMap(fx);
  const d = ctx.fx.data, r = col[0], g = col[1], b = col[2];
  for (let y = cb.y; y < cb.y + cb.height; y++) {
    const y1 = y + oy, y2 = y - oy;
    const ok1 = y1 >= 0 && y1 < h, ok2 = y2 >= 0 && y2 < h;
    for (let x = cb.x; x < cb.x + cb.width; x++) {
      const x1 = x + ox, x2 = x - ox;
      const v1 = ok1 && x1 >= 0 && x1 < w ? bl[y1 * w + x1] : 0;
      const v2 = ok2 && x2 >= 0 && x2 < w ? bl[y2 * w + x2] : 0;
      let v = v1 > v2 ? v1 - v2 : v2 - v1;
      if (map) v = map(v);
      if (invert) v = 1 - v;
      const p = (y * w + x) * 4;
      d[p] = r;
      d[p + 1] = g;
      d[p + 2] = b;
      d[p + 3] = v * 255;
    }
  }
  composite(ctx, ctx.I, fx.blend, alpha, cb, tag);
}

function colorOverlay(ctx, fx, tag) {
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
  composite(ctx, ctx.I, fx.blend, alpha, cb, tag);
}

const LUT_SIZE = 1024;

/** The box a gradient spans: the layer's content box (Align with Layer, default) or the document. */
function gradientBox(ctx, fx) {
  if (fx.align !== false) return ctx.gb;
  return { x: ctx.originX - ctx.docX, y: ctx.originY - ctx.docY, width: ctx.docW, height: ctx.docH };
}

/**
 * Fills ctx.fx inside rect with an effect's gradient (Gradient Overlay, or the Stroke's gradient
 * fill): 0.3's geometry and table, plus offset, Align with Layer, dither and Shape Burst.
 */
function fillGradient(ctx, rect, fx, burst = null, tag = null) {
  const lut = effectGradientLut(fx, LUT_SIZE);
  const t = gradientParam(fx, gradientBox(ctx, fx), burst);
  const reverse = !!fx.reverse, dither = !!fx.dither, salt = saltOf(tag, 3);
  const { w } = ctx, d = ctx.fx.data, top = LUT_SIZE - 1;
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x, i = y * w + rect.x, p = i * 4; x < rect.x + rect.width; x++, i++, p += 4) {
      const q = lutIndex(t(x, y, i), top, reverse, dither ? noiseAt(x - ctx.originX, y - ctx.originY, salt) : null) * 4;
      d[p] = lut[q];
      d[p + 1] = lut[q + 1];
      d[p + 2] = lut[q + 2];
      d[p + 3] = lut[q + 3];
    }
  }
}

function gradientOverlay(ctx, fx, tag) {
  const alpha = clamp01(num(fx.opacity, 1));
  if (alpha <= 0) return;
  // through the gradient model (a v2 `gradient` def, else 0.3's stops, which upgrade to the same table)
  fillGradient(ctx, ctx.cb, fx, null, tag);
  composite(ctx, ctx.I, fx.blend, alpha, ctx.cb, tag);
}

function patternOverlay(ctx, fx, tag) {
  const pat = fx.pattern;
  const alpha = clamp01(num(fx.opacity, 1));
  if (alpha <= 0 || !isPatternData(pat)) return;
  // 0.3 tiles from the image's top-left (Link with Layer); 0.4 adds the angle, the document anchor
  // and the Snap to Origin offset
  fillPattern(ctx.fx.data, ctx.w, ctx.cb, pat, patternPlacement({ link: fx.link, origin: fx.origin, angle: fx.angle, scale: fx.scale }, ctx));
  composite(ctx, ctx.I, fx.blend, alpha, ctx.cb, tag);
}

const BEVEL_STYLES = { 'inner-bevel': 0, 'outer-bevel': 1, emboss: 2, 'pillow-emboss': 3 };

/** Blur applied to a bevel's height map: a little for 'smooth' (less for 'chisel-soft'), plus soften. */
const bevelSigma = (fx) => Math.hypot(fx.technique === 'chisel-hard' ? 0 : fx.technique === 'chisel-soft' ? 0.4 : 0.75, nonNeg(fx.soften) / 2.5);

/** The Texture sub-effect's strength: slope per unit of luminance change per pixel at 100 % depth. */
const TEXTURE_SLOPE = 4;

/**
 * Highlight and shadow mattes of a bevel: a height map from the signed distance to the
 * thresholded edge (profile per style, smoothstep for 'smooth'), lightly blurred (plus soften),
 * lit by a directional light (angle, altitude) with the depth scaling the slopes. The height is
 * stored relative to its value far outside the layer (so it is 0 there and the zero-padded blur
 * cannot invent an edge at the window border); only its gradient matters.
 * 0.4: the Contour sub-effect reshapes the profile (with its Range), the Texture sub-effect adds
 * the pattern's luminance as bumps inside the layer, and the Gloss Contour reshapes the lighting
 * around the flat level (so flat areas stay unlit).
 */
function bevelMaps(ctx, fx, opts) {
  const size = nonNeg(fx.size, 5), depth = nonNeg(fx.depth, 100) / 100;
  if (size <= 0 || depth <= 0) return null;
  const style = BEVEL_STYLES[fx.style] ?? 0;
  const smooth = fx.technique !== 'chisel-hard' && fx.technique !== 'chisel-soft';
  const down = fx.direction === 'down';
  const { w, h, n, A8 } = ctx;
  const inside = insideMask(ctx), dI = distIn(ctx), dO = distOut(ctx);
  const H = new Float32Array(n);
  const half = size / 2;
  const tFar = style === 3 ? 1 : 0; // the profile's value far outside (pillow emboss rises outwards)
  // pixel centres sit at |sd| >= 0.5, so a pillow narrower than 1px a side would be flat
  const pillowHalf = half > 1 ? half : 1;
  const cs = fx.contourSub && typeof fx.contourSub === 'object' && fx.contourSub.enabled ? fx.contourSub : null;
  const csMap = cs ? profileMap({ contour: cs.contour, antiAlias: cs.antiAlias, range: cs.range }, { withRange: true }) : null;
  const csFar = csMap ? csMap(tFar) : tFar;
  for (let i = 0; i < n; i++) {
    const sd = inside[i] ? Math.sqrt(dI[i]) - 0.5 : 0.5 - Math.sqrt(dO[i]);
    let t;
    if (style === 0) t = sd / size;
    else if (style === 1) t = (sd + size) / size;
    else if (style === 2) t = (sd + half) / size;
    else t = (sd < 0 ? -sd : sd) / pillowHalf;
    t = t <= 0 ? 0 : t >= 1 ? 1 : t;
    if (smooth) t = t * t * (3 - 2 * t);
    if (csMap) H[i] = down ? csFar - csMap(t) : csMap(t) - csFar;
    else H[i] = down ? tFar - t : t - tFar;
  }
  const Hb = gaussianBlur(H, w, h, bevelSigma(fx));
  const angle = lightAngle(fx, opts) * RAD;
  const alt = Math.min(90, Math.max(0, fx.useGlobalLight && Number.isFinite(opts.globalAltitude) ? opts.globalAltitude : num(fx.altitude, 30))) * RAD;
  const lx = Math.cos(angle) * Math.cos(alt), ly = -Math.sin(angle) * Math.cos(alt), lz = Math.sin(alt);
  const hiDen = 1 - lz, shDen = Math.max(lz, 1e-3);
  const k = size * depth;
  // Texture: the pattern's luminance as a second height field, inside the layer only
  const tex = fx.texture && typeof fx.texture === 'object' && fx.texture.enabled && isPatternData(fx.texture.pattern) ? fx.texture : null;
  let T = null, kt = 0;
  if (tex) {
    T = patternLuma(tex.pattern, patternPlacement({ link: tex.link, origin: tex.origin, angle: 0, scale: tex.scale }, ctx), w, h);
    kt = TEXTURE_SLOPE * Math.max(-10, Math.min(10, num(tex.depth, 1))) * (tex.invert ? -1 : 1) * (down ? -1 : 1);
  }
  // Gloss Contour: shading s (-1..1) -> 2 * gloss((s + 1) / 2) - 1, shifted so the flat level stays at lz
  const glossLinear = isLinearContour(fx.glossContour);
  const glossLut = glossLinear ? null : contourLut(fx.glossContour, { size: 256, antiAlias: !!fx.antiAlias });
  const gloss = (v) => 2 * lookupContour(glossLut, (v + 1) / 2, !!fx.antiAlias) - 1;
  const glossShift = glossLinear ? 0 : lz - gloss(lz);
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
      let tx = 0, ty = 0;
      if (T && A8[i]) {
        const wgt = ctx.L[i] * kt;
        tx = (T[x < w - 1 ? i + 1 : i] - T[x > 0 ? i - 1 : i]) * 0.5 * wgt;
        ty = (T[dn + x] - T[up + x]) * 0.5 * wgt;
      }
      if (gx === 0 && gy === 0 && tx === 0 && ty === 0) continue;
      let fade = 1;
      if (!A8[i]) {
        fade = lim - Math.sqrt(dO[i]);
        if (fade <= 0) continue;
        if (fade > 1) fade = 1;
      }
      const nx = -k * gx - tx, ny = -k * gy - ty;
      let shade = (nx * lx + ny * ly + lz) / Math.sqrt(nx * nx + ny * ny + 1);
      if (glossLut) shade = gloss(shade) + glossShift;
      if (shade > lz) {
        if (hiDen > 1e-6) hl[i] = Math.min(1, (shade - lz) / hiDen) * fade;
      } else if (shade < lz) sh[i] = Math.min(1, (lz - shade) / shDen) * fade;
    }
  }
  return { hl, sh, inner: style !== 1, outer: style !== 0 };
}

function bevelPart(ctx, fx, maps, outer, tag) {
  const target = outer ? ctx.B : ctx.I;
  const rect = outer ? ctx.full : ctx.cb;
  const knock = outer ? knockout(ctx) : null;
  const where = outer ? 'outer' : 'inner';
  const hc = parseColor(fx.highlightColor), ha = effectAlpha({ opacity: fx.highlightOpacity }, hc, 0.75);
  if (ha > 0) {
    fillMatte(ctx, rect, hc, maps.hl, 0, 0, false, knock);
    composite(ctx, target, fx.highlightBlend || 'screen', ha, rect, tag && { ...tag, part: `${where}-highlight` });
  }
  const sc = parseColor(fx.shadowColor), sa = effectAlpha({ opacity: fx.shadowOpacity }, sc, 0.75);
  if (sa > 0) {
    fillMatte(ctx, rect, sc, maps.sh, 0, 0, false, knock);
    composite(ctx, target, fx.shadowBlend || 'multiply', sa, rect, tag && { ...tag, part: `${where}-shadow` });
  }
}

function strokeRadii(fx) {
  const size = nonNeg(fx.size, 3);
  if (fx.position === 'inside') return [size, 0];
  if (fx.position === 'center') return [size / 2, size / 2];
  return [0, size];
}

/**
 * The Stroke's gradient or pattern fill over rect, written into ctx.fx (null for a colour fill).
 * Returns true when ctx.fx holds the paint (the stroke then scales its alpha by the ring).
 */
function strokePaint(ctx, fx, rect, rIn, rOut, tag) {
  if (fx.fill === 'gradient') {
    let burst = null;
    if (fx.kind === 'shape-burst') {
      // Shape Burst: 0 at the stroke's inner edge, 1 at its outer edge
      const inside = insideMask(ctx), dI = distIn(ctx), dO = distOut(ctx), span = Math.max(1e-6, rIn + rOut);
      burst = (i) => {
        const sd = inside[i] ? 0.5 - Math.sqrt(dI[i]) : Math.sqrt(dO[i]) - 0.5;
        const t = (sd + rIn) / span;
        return t <= 0 ? 0 : t >= 1 ? 1 : t;
      };
    }
    fillGradient(ctx, rect, fx, burst, tag);
    return true;
  }
  if (fx.fill === 'pattern' && isPatternData(fx.pattern)) {
    fillPattern(ctx.fx.data, ctx.w, rect, fx.pattern, patternPlacement({ link: fx.link, origin: fx.origin, angle: fx.patternAngle, scale: fx.patternScale }, ctx));
    return true;
  }
  return false;
}

const strokeAlpha = (fx, col) => (fx.fill === 'gradient' || fx.fill === 'pattern' ? clamp01(num(fx.opacity, 1)) : effectAlpha(fx, col, 1));

/** Inside part of a stroke: recolours the band within r pixels of the edge (clipped later). */
function strokeInner(ctx, fx, r, rOut, tag) {
  const col = parseColor(fx.color), alpha = strokeAlpha(fx, col);
  if (alpha <= 0) return;
  const inside = insideMask(ctx), dI = distIn(ctx);
  const { cb, w } = ctx, d = ctx.fx.data;
  const painted = strokePaint(ctx, fx, cb, r, rOut, tag);
  for (let y = cb.y; y < cb.y + cb.height; y++) {
    for (let x = cb.x, i = y * w + cb.x; x < cb.x + cb.width; x++, i++) {
      let v = 1;
      if (inside[i]) {
        const e = Math.sqrt(dI[i]) - r;
        v = e <= 0 ? 1 : e >= 1 ? 0 : 1 - e;
      }
      const p = i * 4;
      if (painted) d[p + 3] = (v * d[p + 3]);
      else {
        d[p] = col[0];
        d[p + 1] = col[1];
        d[p + 2] = col[2];
        d[p + 3] = v * 255;
      }
    }
  }
  composite(ctx, ctx.I, fx.blend, alpha, cb, tag && { ...tag, part: 'inner' });
}

/**
 * Outside part of a stroke: the ring between the layer edge and r pixels out, drawn under the
 * finished interior. Its alpha is raised by 1 / (1 - interior alpha) so ring + layer cover
 * exactly the dilated shape (antialiased edges get no seam, a see-through fill shows no stroke).
 */
function strokeOuter(ctx, fx, r, rIn, tag) {
  const col = parseColor(fx.color), alpha = strokeAlpha(fx, col);
  if (alpha <= 0) return;
  const inside = insideMask(ctx), dO = distOut(ctx), dI = distIn(ctx);
  const { n, L } = ctx, Id = ctx.I.data, d = ctx.fx.data;
  const painted = strokePaint(ctx, fx, ctx.full, rIn, r, tag);
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
    if (painted) d[p + 3] = v * d[p + 3];
    else {
      d[p] = col[0];
      d[p + 1] = col[1];
      d[p + 2] = col[2];
      d[p + 3] = v * 255;
    }
  }
  composite(ctx, ctx.B, fx.blend, alpha, null, tag && { ...tag, part: 'outer' });
}

// ---------------------------------------------------------------------------------------------
// splitEffects' recorder: each effect's own pixels as they are blended.

function recordEffect(ctx, target, mode, opacity, rect, tag) {
  const r = rect || ctx.full;
  const data = new Uint8ClampedArray(r.width * r.height * 4);
  const s = ctx.fx.data, w = ctx.w;
  for (let y = 0; y < r.height; y++) {
    const o = ((r.y + y) * w + r.x) * 4;
    data.set(s.subarray(o, o + r.width * 4), y * r.width * 4);
  }
  ctx.record.push({ ...tag, below: target === ctx.B, rect: { ...r }, data, blend: blendOf(mode), opacity });
}

/** Grouped interior effects (Blend Interior Effects as Group) are faded with the fill here. */
function fadeInterior(ctx) {
  const Id = ctx.I.data, f = ctx.fill;
  for (let p = 3; p < Id.length; p += 4) Id[p] = Id[p] * f;
}

/**
 * Draws every enabled effect of the merged styles s into ctx: the interior (layer colour and the
 * effects clipped to it, bottom to top), the clip, then what lies below the layer.
 */
function render(ctx, s, o) {
  const tag = (key, index) => ({ key, index });
  const bevel = drawn(s, 'bevel')[0] ?? null;
  const maps = bevel ? bevelMaps(ctx, bevel.fx, o) : null;

  // The layer and the effects clipped to it, bottom to top. The first five are the effects Blend
  // Interior Effects as Group fades with the fill.
  for (const { fx, index } of drawn(s, 'patternOverlay')) patternOverlay(ctx, fx, tag('patternOverlay', index));
  for (const { fx, index } of drawn(s, 'gradientOverlay')) gradientOverlay(ctx, fx, tag('gradientOverlay', index));
  for (const { fx, index } of drawn(s, 'colorOverlay')) colorOverlay(ctx, fx, tag('colorOverlay', index));
  for (const { fx, index } of drawn(s, 'satin')) satin(ctx, fx, tag('satin', index));
  for (const { fx, index } of drawn(s, 'innerGlow')) innerGlow(ctx, fx, tag('innerGlow', index));
  if (ctx.group) fadeInterior(ctx);
  for (const { fx, index } of drawn(s, 'innerShadow')) innerShadow(ctx, fx, o, tag('innerShadow', index));
  if (maps && maps.inner) bevelPart(ctx, bevel.fx, maps, false, tag('bevel', bevel.index));
  const strokes = drawn(s, 'stroke').map((e) => ({ ...e, radii: strokeRadii(e.fx) }));
  for (const { fx, index, radii } of strokes) if (radii[0] > 0) strokeInner(ctx, fx, radii[0], radii[1], tag('stroke', index));

  // Clip the interior to the layer alpha (Transparency Shapes Layer off: to the layer box, where
  // the interior already holds the layer's own alpha).
  const Id = ctx.I.data, A8 = ctx.A8;
  if (!ctx.box) {
    for (let i = 0, p = 0; i < ctx.n; i++, p += 4) {
      const a = ((Id[p + 3] * A8[i]) / 255 + 0.5) | 0;
      if (a) Id[p + 3] = a;
      else Id[p] = Id[p + 1] = Id[p + 2] = Id[p + 3] = 0;
    }
  } else {
    const { cb, w, h } = ctx;
    for (let y = 0; y < h; y++) {
      const inRow = y >= cb.y && y < cb.y + cb.height;
      for (let x = 0, p = y * w * 4; x < w; x++, p += 4) {
        if (inRow && x >= cb.x && x < cb.x + cb.width) continue;
        Id[p] = Id[p + 1] = Id[p + 2] = Id[p + 3] = 0;
      }
    }
  }

  // Below the layer, bottom to top (drawn once the interior is known, for the knock-out).
  for (const { fx, index } of drawn(s, 'dropShadow')) dropShadow(ctx, fx, o, tag('dropShadow', index));
  for (const { fx, index } of drawn(s, 'outerGlow')) outerGlow(ctx, fx, tag('outerGlow', index));
  if (maps && maps.outer) bevelPart(ctx, bevel.fx, maps, true, tag('bevel', bevel.index));
  for (const { fx, index, radii } of strokes) if (radii[1] > 0) strokeOuter(ctx, fx, radii[1], radii[0], tag('stroke', index));
}

/** Copies rect of src into dst at (dx, dy) (rect inside src, destination inside dst). */
function copyRect(src, rect, dst, dx, dy) {
  for (let y = 0; y < rect.height; y++) {
    const s = ((rect.y + y) * src.width + rect.x) * 4;
    dst.data.set(src.data.subarray(s, s + rect.width * 4), ((dy + y) * dst.width + dx) * 4);
  }
}

/**
 * Where the image lies in the document: opts.origin ([x, y], the document position of the
 * image's (0, 0)) with opts.docWidth / docHeight, else `_place` ({ x, y, width, height }) that
 * lib/style-prepare.js puts on the styles it prepares, else the image is the document.
 */
function placeOf(styles, o) {
  if (Array.isArray(o.origin) && o.origin.length === 2) {
    return { x: num(o.origin[0], 0), y: num(o.origin[1], 0), width: num(o.docWidth, NaN), height: num(o.docHeight, NaN) };
  }
  const p = styles && typeof styles === 'object' ? styles._place : null;
  return p && typeof p === 'object' ? { x: num(p.x, 0), y: num(p.y, 0), width: num(p.width, NaN), height: num(p.height, NaN) } : null;
}

/**
 * The work of applyStyles: returns the output geometry and, when there is something to draw, the
 * rendered context. Shared by applyStyles (merged or split) and splitEffects (recorded).
 */
function run(img, styles, o, record = null) {
  const s = mergeStyles(renderable(styles));
  const need = stylePadding(s);
  const pad = Math.max(0, Math.floor(num(o.pad, need)));
  const r = o.rect ? clampRect(o.rect, img.width, img.height) : fullRect(img);
  const W = r.width + pad * 2, H = r.height + pad * 2;
  const offsetX = r.x - pad, offsetY = r.y - pad;
  const fill = clamp01(num(o.fillOpacity, 1));
  const geom = { W, H, offsetX, offsetY, fill };
  if (!hasEnabledStyles(s) && fill >= 1) return { ...geom, plain: true };
  const stats = isEmptyRect(r) ? null : alphaStats(img); // a rect outside img selects nothing
  if (!stats) return geom;
  const cb = stats.cb;
  const { extent, support, reach } = styleMargins(s);
  // R: the output pixels that can be non-zero (source coordinates). The window adds the content
  // they depend on (reach) wherever intermediate buffers can be non-zero (support).
  const R = intersectRect({ x: offsetX, y: offsetY, width: W, height: H }, inflateRect(cb, extent));
  if (isEmptyRect(R)) return geom;
  const win = unionRect(intersectRect(inflateRect(R, reach), inflateRect(cb, support)), R);
  const place = placeOf(styles, o);
  const ctx = makeContext(img, win, cb, stats.maxA, fill, {
    box: o.transparencyShapes === false,
    group: !!o.interiorAsGroup && fill < 1,
    place: place && { x: place.x, y: place.y, width: Number.isFinite(place.width) ? place.width : img.width, height: Number.isFinite(place.height) ? place.height : img.height },
  });
  ctx.record = record;
  render(ctx, s, o);
  return { ...geom, ctx, R, win };
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
 * @param {{ pad?: number, rect?: Rect, fillOpacity?: number, globalAngle?: number, globalAltitude?: number,
 *   interiorAsGroup?: boolean, transparencyShapes?: boolean, split?: boolean,
 *   origin?: [number, number], docWidth?: number, docHeight?: number }} [opts]
 *   pad: border to add (default stylePadding(styles)); a smaller pad clips the effects.
 *   rect: output region of img (clipped to it, default the whole image): the output covers the
 *     rect grown by pad, offsets rect.x - pad, rect.y - pad, and matches the whole-image result
 *     there (layer pixels outside the rect still cast their effects into it, as in filters.js).
 *   fillOpacity: Photoshop's Fill (0..1, default 1): fades the layer's own pixels but not its
 *     effects (a 0 fill with a stroke or overlay keeps only the effect).
 *   globalAngle / globalAltitude: used by effects that set useGlobalLight: true.
 *   interiorAsGroup (Blend Interior Effects as Group): inner glow, satin and the three overlays
 *     are blended into the layer at full fill and faded with it as a group.
 *   transparencyShapes (Transparency Shapes Layer, default true): false lets the interior effects
 *     cover the layer's whole content box instead of its alpha.
 *   split: returns { below, layer, above, offsetX, offsetY } instead: the effects drawn under the
 *     layer (exterior effects, null when none), the layer with its interior effects, and what is
 *     drawn over it (always null here: every effect lies below the layer or inside it). `layer`
 *     drawn with Normal over `below` gives the merged image exactly.
 *   origin, docWidth, docHeight: the document position of img's (0, 0) and the document size,
 *     for Link with Layer off (patterns) and Align with Layer off (gradients); without them the
 *     `_place` that lib/style-prepare.js adds to the styles, else img is the document.
 * Styles may hold arrays of instances (all drawn, the bottom one first) and `hidden: true` (no effect).
 * @returns {{ image: ImageDataLike, offsetX: number, offsetY: number }}
 */
export function applyStyles(img, styles, opts = {}) {
  const o = opts || {};
  const res = run(img, styles, o);
  const { W, H, offsetX, offsetY } = res;
  const out = createImage(W, H);
  if (res.plain) pasteImage(out, img, -offsetX, -offsetY);
  if (!res.ctx) return o.split ? { below: null, layer: out, above: null, offsetX, offsetY } : { image: out, offsetX, offsetY };
  const { ctx, R, win } = res;
  const crop = { x: R.x - win.x, y: R.y - win.y, width: R.width, height: R.height };
  if (o.split) {
    copyRect(ctx.I, crop, out, R.x - offsetX, R.y - offsetY);
    let below = null;
    if (!ctx.bEmpty) {
      below = createImage(W, H);
      copyRect(ctx.B, crop, below, R.x - offsetX, R.y - offsetY);
    }
    return { below, layer: out, above: null, offsetX, offsetY };
  }
  // Nothing below the layer: the clipped interior is the result (what blendImages would produce).
  let img2 = ctx.I;
  if (!ctx.bEmpty) {
    blendImages('normal', ctx.I, ctx.B, 1, ctx.cb);
    img2 = ctx.B;
  }
  copyRect(img2, crop, out, R.x - offsetX, R.y - offsetY);
  return { image: out, offsetX, offsetY };
}

const PART_NAMES = {
  dropShadow: 'Drop Shadow', innerShadow: 'Inner Shadow', outerGlow: 'Outer Glow', innerGlow: 'Inner Glow',
  satin: 'Satin', colorOverlay: 'Color Fill', gradientOverlay: 'Gradient Fill', patternOverlay: 'Pattern Fill',
};
const BEVEL_PART_NAMES = {
  'inner-highlight': 'Inner Bevel Highlights', 'inner-shadow': 'Inner Bevel Shadows',
  'outer-highlight': 'Outer Bevel Highlights', 'outer-shadow': 'Outer Bevel Shadows',
};

/**
 * Layer > Layer Style > Create Layers: every enabled effect instance as its own image, in stacking
 * order, bottom first: exterior effects (drop shadow, outer glow, the outer half of a bevel, the
 * outer part of a stroke) below the layer (clip: false), interior effects (overlays, satin, inner
 * glow, inner shadow, the inner half of a bevel, the inner part of a stroke) clipped above it
 * (clip: true). A bevel gives its highlights and its shadows apart (`part`), and a centred or
 * emboss effect gives both its parts. Each image is the effect exactly as the merged render draws
 * it (the drop shadow already knocked out by the layer), at full opacity, cropped to its pixels;
 * its blend mode and opacity are returned beside it. x, y place the image relative to img's
 * top-left; `name` is Photoshop's name for the layer it makes.
 *
 * Exact: blending the below parts in order onto a transparent image (the first one copied at its
 * opacity, as applyStyles does), the interior parts in order onto the layer at its fill, clipping
 * that to the layer alpha and drawing it with Normal on top gives applyStyles' image (dissolve
 * aside: its speckles are drawn again by whoever blends the part).
 * @returns {{ key: string, index: number, part?: string, name: string, image: ImageDataLike, x: number, y: number, blend: string, opacity: number, clip: boolean }[]}
 */
export function splitEffects(img, styles, opts = {}) {
  if (!hasEnabledStyles(styles)) return [];
  const record = [];
  const res = run(img, styles, { ...(opts || {}), split: false }, record);
  if (!res.ctx) return [];
  const { R, win } = res;
  const parts = [...record.filter((e) => e.below), ...record.filter((e) => !e.below)];
  const out = [];
  for (const e of parts) {
    // the part's pixels inside the output region, cropped to where it is not transparent
    const x0 = Math.max(e.rect.x, R.x - win.x), y0 = Math.max(e.rect.y, R.y - win.y);
    const x1 = Math.min(e.rect.x + e.rect.width, R.x - win.x + R.width), y1 = Math.min(e.rect.y + e.rect.height, R.y - win.y + R.height);
    let bx0 = Infinity, by0 = Infinity, bx1 = -1, by1 = -1;
    for (let y = y0; y < y1; y++) {
      for (let x = x0, p = ((y - e.rect.y) * e.rect.width + (x0 - e.rect.x)) * 4 + 3; x < x1; x++, p += 4) {
        if (!e.data[p]) continue;
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        by1 = y;
      }
    }
    if (bx1 < 0) continue;
    const image = createImage(bx1 - bx0 + 1, by1 - by0 + 1);
    for (let y = by0; y <= by1; y++) {
      const s = ((y - e.rect.y) * e.rect.width + (bx0 - e.rect.x)) * 4;
      image.data.set(e.data.subarray(s, s + image.width * 4), (y - by0) * image.width * 4);
    }
    const stroke = e.key === 'stroke';
    const name = e.key === 'bevel' ? BEVEL_PART_NAMES[e.part] : stroke ? (e.part === 'inner' ? 'Inner Stroke' : 'Outer Stroke') : PART_NAMES[e.key];
    const item = { key: e.key, index: e.index, name, image, x: bx0 + win.x, y: by0 + win.y, blend: e.blend, opacity: e.opacity, clip: !e.below };
    if (e.part) item.part = e.part;
    out.push(item);
  }
  return out;
}
