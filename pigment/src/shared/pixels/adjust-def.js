// Shared helpers for adjustment modules (adjust.js and the 0.3 table it merges, adjust-more.js).
// Pure, no DOM. Every adjustment is built with lutKind() or pixelKind() so dialogs, adjustment
// layers, smart filters and the AI assistant see one shape: { name, defaults, apply, lut? }.

import { clampRect, applyLut } from './core.js';

/** Finite number or fallback. */
export const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
export const clampNum = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
/** Rounds half up into 0..255 (Uint8ClampedArray assignment would round half to even). */
export const round8 = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : (v + 0.5) | 0);
/** Integer Rec. 601 luma of 8-bit channels. */
export const lumaInt = (r, g, b) => (0.299 * r + 0.587 * g + 0.114 * b + 0.5) | 0;
export const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export const linearToSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** Shallow merge that ignores undefined values in params (so `{ hue: undefined }` keeps the default). */
export function merge(defaults, params) {
  const out = { ...defaults };
  if (params) for (const k in params) if (params[k] !== undefined) out[k] = params[k];
  return out;
}

export const freezeDeep = (o) => {
  if (o && typeof o === 'object') {
    for (const k of Object.keys(o)) freezeDeep(o[k]);
    Object.freeze(o);
  }
  return o;
};

/** rect clipped to the image (default: the whole image). */
export const region = (img, rect) => clampRect(rect, img.width, img.height);

/**
 * Applies per-channel LUTs to RGB inside rect with plain loops (core.js applyLut walks a rect
 * through a per-pixel callback); alpha is never touched.
 */
export function applyLuts(img, lr, lg, lb, rect) {
  if (!rect) return applyLut(img, lr, lg, lb);
  const r = region(img, rect);
  if (!r.width) return img;
  const d = img.data, w = img.width;
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let i = (y * w + r.x) * 4;
    for (let x = 0; x < r.width; x++, i += 4) {
      d[i] = lr[d[i]];
      d[i + 1] = lg[d[i + 1]];
      d[i + 2] = lb[d[i + 2]];
    }
  }
  return img;
}

/**
 * Builds a LUT kind: apply() is applyLuts over lut(params) -> [lutR, lutG, lutB]. `extra` carries
 * pure metadata the renderer reads: fields (lib/form.js specs for the dialog), layer (true when the
 * kind is offered as an adjustment layer), placeholder (implementation not landed; identity, menus
 * disable it), smart (false when it cannot be a smart filter).
 */
export function lutKind(name, defaults, build, extra = {}) {
  const frozen = freezeDeep(defaults ?? {});
  const lut = (params) => build(merge(frozen, params));
  return Object.freeze({
    ...extra,
    name,
    defaults: frozen,
    lut,
    apply(img, params, rect = null) {
      const [lr, lg, lb] = lut(params);
      return applyLuts(img, lr, lg, lb, rect);
    },
  });
}

/** Builds a per-pixel kind: fn(img, mergedParams, rect) edits img in place and returns it. */
export function pixelKind(name, defaults, fn, extra = {}) {
  const frozen = freezeDeep(defaults ?? {});
  return Object.freeze({
    ...extra,
    name,
    defaults: frozen,
    apply(img, params, rect = null) {
      return fn(img, merge(frozen, params), rect);
    },
  });
}

/** A kind whose implementation has not landed yet: identity apply, flagged so menus and dialogs skip it. */
export function placeholderAdjustment(name, defaults = {}, extra = {}) {
  return pixelKind(name, defaults, (img) => img, { ...extra, placeholder: true });
}

/** Merges adjustment tables into one frozen registry; a kind defined twice is an error. */
export function mergeTables(...tables) {
  const out = {};
  for (const t of tables) {
    for (const k of Object.keys(t)) {
      if (k in out) throw new Error(`Adjustment kind defined twice: ${k}`);
      out[k] = t[k];
    }
  }
  return Object.freeze(out);
}
