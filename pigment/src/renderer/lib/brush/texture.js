// Texture (ARCHITECTURE.md "0.5 features", S1.1, S2.4; brush-settings-panel): the brush paints through a pattern, as
// if the canvas had that relief. Two dab modifiers of the engine's chain, registered when this file loads:
//
//   - 'texture-tip' (order 500, `coverage`): Texture Each Tip on. Each dab's coverage meets the pattern with the mode
//     and a depth of its own (Depth, its control and jitter, Minimum Depth), as Photoshop does per tip.
//   - 'texture' (order 510, `buffer`): Texture Each Tip off. The accumulated stroke meets the pattern once, at Depth:
//     overlapping dabs do not build up through the low parts, and the depth controls do not apply (Photoshop greys
//     them out there).
//
// The pattern is the texture's PatternRef ({ presetId, name, dataUrl? }), else the current pattern. It is anchored at
// the document's origin, so the relief stays put under every stroke (a second stroke lines up with the first) and a
// stroke repeats with the pattern's period x Scale. The pattern's grey (Rec. 601 luma; transparent counts as white)
// is the height: white is high and takes paint, black is low and, at Depth 100 %, takes none. Invert, Brightness
// (-150..150 on 0..255) and Contrast (-50..100) shape the heights first.
//
// At stroke start the pixels are read synchronously with app.patterns.resolve (S1.1); a pattern not loaded yet turns
// Texture off for that stroke with one toast (none in previews) and asks the library for it, so the next stroke has it.
//
// The modes (c: the coverage or the stroke's alpha, h: the height, d: the depth, b = 1 - d (1 - h): the height seen
// through the depth, 1 everywhere at depth 0) are Pigment's reading of Photoshop's list: multiply c b; subtract
// c - d (1 - h); darken min(c, b); overlay of c with 0.5 + (h - 0.5) d; color dodge c / (1 - d h); color burn
// 1 - (1 - c) / b; linear burn c + b - 1; hard mix c where b >= 1 - c / 2, else 0; linear height a soft threshold of
// b against 1 - c; height a hard one. Every mode leaves the coverage unchanged at depth 0.
//
// Pure maths (Node-tested); the canvas is touched only through app.patterns.
import { registerDabModifier } from '../brush.js';
import { controlFactor } from './dynamics.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---- heights ----------------------------------------------------------------------------------------------------

/** The contrast factor of Contrast -50..100 (100: nearly two levels). */
export function contrastFactor(contrast) {
  const c = Number(contrast) || 0;
  return c >= 0 ? 1 / Math.max(0.01, 1 - c / 101) : 1 + c / 100;
}

/**
 * The pattern's heights: { width, height, data: Float32Array 0..1 } from RGBA pixels (ImageData-like), with Invert,
 * Brightness and Contrast applied.
 */
export function patternHeights(img, { invert = false, brightness = 0, contrast = 0 } = {}) {
  const { width, height, data } = img;
  const out = new Float32Array(width * height);
  const k = contrastFactor(contrast);
  const shift = (Number(brightness) || 0) / 255;
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const a = data[p + 3] / 255;
    let v = ((0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) / 255) * a + (1 - a);
    if (invert) v = 1 - v;
    v = (v + shift - 0.5) * k + 0.5;
    out[i] = clamp01(v);
  }
  return { width, height, data: out };
}

// ---- modes ------------------------------------------------------------------------------------------------------

/** One coverage value c through the texture: height h, depth d (0..1). See the file comment for the modes. */
export function textureBlend(mode, c, h, d) {
  if (!(d > 0)) return c;
  const b = 1 - d * (1 - h);
  switch (mode) {
    case 'subtract':
      return clamp01(c - d * (1 - h));
    case 'darken':
      return Math.min(c, b);
    case 'overlay': {
      const B = 0.5 + (h - 0.5) * d;
      return clamp01(c < 0.5 ? 2 * c * B : 1 - 2 * (1 - c) * (1 - B));
    }
    case 'color-dodge':
      return clamp01(c / Math.max(0.01, 1 - d * h));
    case 'color-burn':
      return b <= 0 ? 0 : clamp01(1 - (1 - c) / b);
    case 'linear-burn':
      return clamp01(c + b - 1);
    case 'hard-mix':
      return b >= 1 - c / 2 ? c : 0;
    case 'linear-height':
      return c * clamp01((b - (1 - c)) * 5 + 1);
    case 'height':
      return b >= 1 - c ? c : 0;
    case 'multiply':
    default:
      return c * b;
  }
}

/**
 * The pattern column (row) of every pixel of a run: n pixels starting at `start` (document px of the first pixel's
 * left edge), `step` document px each, through a pattern of `period` px shown at `scale`.
 */
function patternIndices(n, start, step, period, scale) {
  const out = new Int32Array(n);
  const s = scale > 0 ? scale : 1;
  for (let i = 0; i < n; i++) {
    const p = Math.floor((start + (i + 0.5) * step) / s);
    out[i] = ((p % period) + period) % period;
  }
  return out;
}

/**
 * Texture on a coverage mask (S2.4 `coverage`: { data, width, height, x, y, scale }; one mask pixel per 1/scale
 * stroke-canvas px). ox, oy: the stroke canvas's document offset; heights from patternHeights; scale: the texture's.
 */
export function applyTextureToMask(mask, heights, { ox = 0, oy = 0, scale = 1, mode = 'multiply', depth = 1 } = {}) {
  if (!(depth > 0)) return mask;
  const ms = mask.scale > 0 ? mask.scale : 1;
  const cols = patternIndices(mask.width, ox + mask.x, 1 / ms, heights.width, scale);
  const rows = patternIndices(mask.height, oy + mask.y, 1 / ms, heights.height, scale);
  const { data } = mask;
  const hd = heights.data, hw = heights.width;
  for (let j = 0, k = 0; j < mask.height; j++) {
    const base = rows[j] * hw;
    for (let i = 0; i < mask.width; i++, k++) {
      const c = data[k];
      if (c > 0) data[k] = textureBlend(mode, c, hd[base + cols[i]], depth);
    }
  }
  return mask;
}

/**
 * Texture on the accumulated stroke (S2.4 `buffer`: straight RGBA of `rect` in stroke-canvas px; only A changes).
 */
export function applyTextureToBuffer(img, rect, heights, { ox = 0, oy = 0, scale = 1, mode = 'multiply', depth = 1 } = {}) {
  if (!(depth > 0)) return img;
  const cols = patternIndices(img.width, ox + rect.x, 1, heights.width, scale);
  const rows = patternIndices(img.height, oy + rect.y, 1, heights.height, scale);
  const { data } = img;
  const hw = heights.width;
  // a large rect (a big brush's frame) reads a table of every height level x alpha: one lookup per pixel
  if (img.width * img.height > 65536) {
    const q = quantized(heights);
    const lut = blendTable(mode, depth);
    for (let j = 0, p = 3; j < img.height; j++) {
      const base = rows[j] * hw;
      for (let i = 0; i < img.width; i++, p += 4) {
        const a = data[p];
        if (a) data[p] = lut[(q[base + cols[i]] << 8) | a];
      }
    }
    return img;
  }
  const hd = heights.data;
  for (let j = 0, p = 3; j < img.height; j++) {
    const base = rows[j] * hw;
    for (let i = 0; i < img.width; i++, p += 4) {
      const a = data[p];
      if (a) data[p] = Math.round(textureBlend(mode, a / 255, hd[base + cols[i]], depth) * 255);
    }
  }
  return img;
}

const quantCache = new WeakMap();
/** The heights as 8-bit levels (cached on the heights object). */
function quantized(heights) {
  let q = quantCache.get(heights);
  if (!q) {
    q = new Uint8Array(heights.data.length);
    for (let i = 0; i < q.length; i++) q[i] = Math.round(heights.data[i] * 255);
    quantCache.set(heights, q);
  }
  return q;
}

const tables = new Map();
/** textureBlend over every (height level, alpha) pair as 8-bit results, cached per mode and depth. */
function blendTable(mode, depth) {
  const key = `${mode}|${depth}`;
  let t = tables.get(key);
  if (!t) {
    t = new Uint8Array(65536);
    for (let h = 0; h < 256; h++) for (let a = 0; a < 256; a++) t[(h << 8) | a] = Math.round(textureBlend(mode, a / 255, h / 255, depth) * 255);
    tables.set(key, t);
    while (tables.size > 8) tables.delete(tables.keys().next().value);
  }
  return t;
}

/**
 * The depth of one dab with Texture Each Tip (0..1): Depth through its control (mapped to [Minimum Depth, 1]) and its
 * jitter (which never goes below Minimum Depth x Depth). `rnd` is the stroke's seeded random.
 */
export function tipDepth(tx, dab, rnd) {
  let k = 1;
  const control = tx.depthControl;
  if (control && control.type !== 'off') k = tx.minimumDepth + (1 - tx.minimumDepth) * controlFactor(control, { index: dab?.index ?? 0, sample: dab?.sample ?? null });
  if (tx.depthJitter > 0) k = Math.max(tx.minimumDepth, k * (1 - tx.depthJitter * rnd()));
  return clamp01(tx.depth * k);
}

// ---- the pattern of a stroke --------------------------------------------------------------------------------------

// heights by pattern and shaping (a stroke and every preview redraw would otherwise recompute them)
const heightCache = new Map();
const HEIGHT_CACHE_SIZE = 16;

function refKey(ref) {
  return ref?.presetId ? `id:${ref.presetId}` : ref?.dataUrl ? `url:${ref.dataUrl.length}:${ref.dataUrl.slice(-64)}` : '';
}

/**
 * The texture's heights for a stroke, or null when its pattern has no pixels yet (asked for, so a later stroke has
 * them). A texture without a pattern uses the current pattern (Photoshop always shows one).
 */
export function strokeHeights(tx, patterns) {
  if (!patterns) return null;
  let ref = tx.pattern;
  if (!ref) {
    const id = patterns.currentId?.() ?? patterns.current?.()?.id ?? null;
    ref = id ? { presetId: id } : null;
  }
  if (!ref) return null;
  const key = `${refKey(ref)}|${tx.invert ? 1 : 0}|${tx.brightness}|${tx.contrast}`;
  const hit = heightCache.get(key);
  if (hit) return hit;
  let img = null;
  try {
    img = patterns.resolve?.(ref, () => {}) ?? null;
  } catch {
    img = null;
  }
  if (!img?.data?.length || !img.width || !img.height) {
    if (ref.presetId) Promise.resolve(patterns.get?.(ref.presetId)).catch(() => {});
    return null;
  }
  const h = patternHeights(img, tx);
  heightCache.set(key, h);
  while (heightCache.size > HEIGHT_CACHE_SIZE) heightCache.delete(heightCache.keys().next().value);
  return h;
}

function beginTexture(ctx) {
  const tx = ctx.preset.texture;
  const heights = strokeHeights(tx, ctx.patterns);
  // a stroke on a layer warns once; a preview stays quiet (it redraws on every change)
  if (!heights && ctx.layer) ctx.app?.dialogs?.toast?.('The brush texture\'s pattern is not loaded yet: this stroke has no texture', { timeout: 2000 });
  return { heights, rnd: ctx.random('texture'), n: 0 };
}

const offset = (ctx) => ({ ox: ctx.stroke?.target?.x ?? 0, oy: ctx.stroke?.target?.y ?? 0 });

export const textureTip = {
  id: 'texture-tip',
  order: 500,
  enabled: (preset) => !!preset?.texture?.enabled && !!preset.texture.eachTip,
  begin: beginTexture,
  coverage(mask, dab, state, ctx) {
    if (!state?.heights) return;
    const tx = ctx.preset.texture;
    // a stroke without a geometry stage hands dabs without their index and sample: count them, read the stroke's
    // latest sample (the pen controls of the depth)
    const at = { index: Number.isFinite(dab.index) ? dab.index : state.n++, sample: dab.sample ?? ctx.stroke?.current ?? null };
    applyTextureToMask(mask, state.heights, { ...offset(ctx), scale: tx.scale, mode: tx.mode, depth: tipDepth(tx, at, state.rnd) });
  },
  reach: () => 0,
};

export const textureStroke = {
  id: 'texture',
  order: 510,
  enabled: (preset) => !!preset?.texture?.enabled && !preset.texture.eachTip,
  begin: beginTexture,
  buffer(img, rect, state, ctx) {
    if (!state?.heights) return;
    const tx = ctx.preset.texture;
    applyTextureToBuffer(img, rect, state.heights, { ...offset(ctx), scale: tx.scale, mode: tx.mode, depth: tx.depth });
  },
  reach: () => 0,
};

export const TEXTURE_MODIFIERS = Object.freeze([textureTip, textureStroke]);

for (const mod of TEXTURE_MODIFIERS) registerDabModifier(mod);
