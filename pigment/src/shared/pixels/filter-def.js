// Shared helpers for filter modules (filters.js and the 0.3 tables it merges: filters-more-a/b.js,
// blur-gallery.js, gallery-artistic.js, gallery-sketch.js). Pure, no DOM. A filter definition is
// what the Filter menu, the filter dialog (lib/filter-ui.js), smart filters and the AI assistant
// consume, so every table uses defineFilter() and nothing else builds one by hand.

import { clampRect } from './core.js';

/** Finite number or fallback. */
export const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
export const clampNum = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
/** Rounds half up into 0..255 (Uint8ClampedArray assignment would round half to even). */
export const round8 = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : (v + 0.5) | 0);
/** Hermite smoothstep; e0 > e1 gives the falling edge. */
export const smoothstep = (e0, e1, x) => {
  const t = clampNum((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const DEG = Math.PI / 180;
export const TAU = Math.PI * 2;

/** Shallow merge that ignores undefined values in params (so `{ radius: undefined }` keeps the default). */
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
export const isEmptyRegion = (r) => r.width <= 0 || r.height <= 0;

/**
 * Builds a filter definition. apply() merges params over the frozen defaults, edits img in place
 * inside rect (default: the whole image) and returns it. `extra` carries the optional UI and menu
 * metadata the renderer reads (all pure data):
 * - fields: lib/form.js field specs for the dialog (keys are parameter paths); none = applies directly
 * - margin: px the filter reads around each pixel (number or (params) => number), so a selection edge blends
 * - direct: true when the kind applies without a dialog even though it has fields
 * - ui: 'custom' when a renderer module opens its own session (app.filterEditor.register(kind, { open }))
 * - gallery: 'Artistic' | 'Brush Strokes' | 'Distort' | 'Sketch' | 'Stylize' | 'Texture' for Filter Gallery kinds (category 'gallery')
 * - placeholder: true for a kind whose implementation has not landed (identity apply; menus disable it)
 * - smart: false when the kind cannot be a smart filter (default true)
 */
export function defineFilter(name, category, defaults, fn, extra = {}) {
  const frozen = freezeDeep(defaults ?? {});
  return Object.freeze({
    ...extra,
    name,
    category,
    defaults: frozen,
    apply(img, params, rect = null) {
      return fn(img, merge(frozen, params), rect);
    },
  });
}

/** A kind whose implementation has not landed yet: identity apply, flagged so menus and dialogs skip it. */
export function placeholderFilter(name, category, defaults = {}, extra = {}) {
  return defineFilter(name, category, defaults, (img) => img, { ...extra, placeholder: true });
}

/** Merges filter tables into one frozen registry; a kind defined twice is an error (ownership is per table). */
export function mergeTables(...tables) {
  const out = {};
  for (const t of tables) {
    for (const k of Object.keys(t)) {
      if (k in out) throw new Error(`Filter kind defined twice: ${k}`);
      out[k] = t[k];
    }
  }
  return Object.freeze(out);
}
