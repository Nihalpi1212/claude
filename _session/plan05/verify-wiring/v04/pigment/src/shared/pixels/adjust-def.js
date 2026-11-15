// Shared helpers for adjustment modules (adjust.js and the 0.3 table it merges, adjust-more.js).
// Pure, no DOM. Every adjustment is built with lutKind() or pixelKind() so dialogs, adjustment
// layers, smart filters and the AI assistant see one shape: { name, defaults, apply, lut? }.
//
// Registry fields (0.4, ARCHITECTURE.md "0.4 features", I.4), all optional except apply:
//  - apply(img, params, rect = null, ctx = null): ctx = { origin: { x, y } (document position of
//    img's (0, 0)), docWidth, docHeight, scale: 1 }; null means origin (0, 0) and img is the whole
//    document. Kinds whose output depends on where a pixel is (Grain seeds its noise from document
//    coordinates) read ctx; the others ignore it. lutKind / pixelKind pass it on (pixelKind's fn
//    gets it as its fourth argument).
//  - margin(params) -> px: how far around each pixel the kind reads (Clarity, Dehaze,
//    Shadows/Highlights); the compositor grows partial repaints by it so they match full ones.
//    No 0.3 kind declares it.
//  - deepExact(params) -> boolean: false makes deep.js use its 8-bit fallback for these params
//    (its float code knows only 0.3's parameter shapes). Absent means true.
// They are passed in `extra` (lutKind(name, defaults, build, { margin, deepExact })).

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
 * Applies per-channel LUTs, then adds back the Rec. 601 luma the mapping removed so only the
 * colour changes (Photoshop's "preserve luminosity").
 */
export function applyLutKeepLuma(img, lr, lg, lb, rect) {
  const r = region(img, rect);
  if (!r.width) return img;
  const d = img.data, w = img.width;
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let i = (y * w + r.x) * 4;
    for (let x = 0; x < r.width; x++, i += 4) {
      const r0 = d[i], g0 = d[i + 1], b0 = d[i + 2];
      const r1 = lr[r0], g1 = lg[g0], b1 = lb[b0];
      const dl = 0.299 * (r0 - r1) + 0.587 * (g0 - g1) + 0.114 * (b0 - b1);
      d[i] = round8(r1 + dl);
      d[i + 1] = round8(g1 + dl);
      d[i + 2] = round8(b1 + dl);
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
    // ctx (I.4) is accepted and unused: a LUT does not depend on where a pixel is
    apply(img, params, rect = null, ctx = null) {
      void ctx;
      const [lr, lg, lb] = lut(params);
      return applyLuts(img, lr, lg, lb, rect);
    },
  });
}

/** Builds a per-pixel kind: fn(img, mergedParams, rect, ctx) edits img in place and returns it. */
export function pixelKind(name, defaults, fn, extra = {}) {
  const frozen = freezeDeep(defaults ?? {});
  return Object.freeze({
    ...extra,
    name,
    defaults: frozen,
    apply(img, params, rect = null, ctx = null) {
      return fn(img, merge(frozen, params), rect, ctx);
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
