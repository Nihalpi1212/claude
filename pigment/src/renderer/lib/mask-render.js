// Mask render hook (ARCHITECTURE.md "0.4 features", K.1; E10). Every read that renders or bakes what a layer looks
// like through its masks goes through here: the compositor, layer-ops (apply, rasterize), depth.js (16/32-bit
// flatten), automate (Apply All Masks), ai/features (active pixels) and the PSD writer. Reads that edit, move,
// copy or display the raster mask's own pixels keep using `layer.mask.canvas`.
//
// Stub by the skeleton, exactly 0.3: 'raster' and 'all' give the raster mask's canvas when it is enabled; the vector
// mask, density and feather are ignored. masks-vector-masks replaces this file (same exports): the raster part with
// density and feather, the vector part with its density, feather and initialFill, 'all' both intersected, cached
// on (mask canvas, layer.version, parts).
import { createCanvas } from './document.js';

/** @typedef {'all' | 'raster' | 'vector'} MaskParts */

/**
 * The document-sized alpha canvas `parts` of the layer's masks make, or null when that part masks nothing.
 * @param {object} layer
 * @param {object} doc
 * @param {{ purpose?: 'composite' | 'bake', parts?: MaskParts }} [opts]
 * @returns {HTMLCanvasElement | null}
 */
export function maskCanvasFor(layer, doc, { purpose = 'composite', parts = 'all' } = {}) {
  void doc;
  void purpose;
  if (parts === 'vector') return null;
  const m = layer?.mask;
  return m?.enabled && m.canvas ? m.canvas : null;
}

/**
 * Masks `work` (a canvas whose top-left is the document point x, y) by the layer's masks; returns the masked canvas
 * (a new one) or `work` itself when nothing masks it. 0.3's destination-in step.
 */
export function applyLayerMask(work, x, y, layer, doc, { parts = 'all' } = {}) {
  const mask = maskCanvasFor(layer, doc, { purpose: 'composite', parts });
  if (!mask) return work;
  const m = createCanvas(work.width, work.height);
  const mctx = m.getContext('2d');
  mctx.drawImage(work, 0, 0);
  mctx.globalCompositeOperation = 'destination-in';
  mctx.drawImage(mask, -x, -y);
  return m;
}

/** True when `parts` of the layer's masks hide anything (the stub: an enabled raster mask). */
export function hasEffectiveMask(layer, parts = 'all') {
  if (parts === 'vector') return false;
  return !!(layer?.mask?.enabled && layer.mask.canvas);
}

/** Part of the compositor's style-cache key: changes whenever what `parts` produce could change. */
export function maskCacheKey(layer, parts = 'all') {
  return `${parts}:${hasEffectiveMask(layer, parts) ? 1 : 0}`;
}
