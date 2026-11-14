// Mask view hook (ARCHITECTURE.md "0.4 features", K.1b; E10b), owned by masks-vector-masks. CanvasView.paint calls
// paintMaskView where 0.3 drew the mask channel and the red overlay; the Layers panel row draws the vector mask
// thumbnail with vectorMaskThumb (L.15).
//
// View modes:
//   mask alone   view.maskView (Alt-click the mask thumbnail, layer:mask-toggle-view): the layer mask in grey levels,
//                with its density and feather (what it does to the layer)
//   overlay      app.ui.showMaskOverlay (layer:mask-overlay, \): the rubylith over what the targeted mask hides,
//                in the colour and opacity of settings.masks; the layer mask when the layer has one, else the vector
//                mask
// The vector mask's outline is drawn by the path tools (it is a path target, L.4).
import { createCanvas } from './document.js';
import { mapPathPoints } from './path-ops.js';
import { maskCanvasFor, renderVectorMask } from './mask-render.js';

const DEFAULT_COLOR = '#ff0000';
const DEFAULT_OPACITY = 0.5;
const HEX = /^#[0-9a-f]{6}$/i;

function overlayOf(app) {
  const m = app?.settings?.masks ?? {};
  const color = typeof m.overlayColor === 'string' && HEX.test(m.overlayColor) ? m.overlayColor : DEFAULT_COLOR;
  const o = Number(m.overlayOpacity);
  return { color, opacity: Number.isFinite(o) ? Math.min(1, Math.max(0, o)) : DEFAULT_OPACITY };
}

/** The mask the views show for a layer: its layer mask as it acts (density, feather), else its vector mask. */
function viewedMask(layer, doc, { rasterOnly = false } = {}) {
  if (layer?.mask?.canvas) {
    // a disabled layer mask still shows its pixels (0.3): the view is how the user sees what they paint
    return layer.mask.enabled ? maskCanvasFor(layer, doc, { purpose: 'composite', parts: 'raster' }) ?? layer.mask.canvas : layer.mask.canvas;
  }
  if (rasterOnly || !layer?.vectorMask) return null;
  if (layer.vectorMask.enabled !== false) return maskCanvasFor(layer, doc, { purpose: 'composite', parts: 'vector' }); // mask (K.1)
  // a disabled vector mask is shown as if enabled, through a stand-in kept per layer so the render cache holds
  let s = standIns.get(layer);
  if (!s || s.vm !== layer.vectorMask) standIns.set(layer, (s = { vm: layer.vectorMask, obj: { vectorMask: { ...layer.vectorMask, enabled: true }, version: 0 } }));
  s.obj.version = layer.version;
  return maskCanvasFor(s.obj, doc, { purpose: 'composite', parts: 'vector' }); // mask (K.1)
}
const standIns = new WeakMap(); // layer -> { vm, obj }

// the tinted overlay, rebuilt only when the mask, its layer's version or the colour changes (paint runs every frame)
let tint = null; // { mask, version, color, canvas }

function overlayCanvas(mask, version, color, doc) {
  if (tint && tint.mask === mask && tint.version === version && tint.color === color && tint.canvas.width === doc.width && tint.canvas.height === doc.height) return tint.canvas;
  const c = tint?.canvas?.width === doc.width && tint.canvas.height === doc.height ? tint.canvas : createCanvas(doc.width, doc.height);
  const ctx = c.getContext('2d');
  ctx.save();
  ctx.globalCompositeOperation = 'copy';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(mask, 0, 0);
  ctx.restore();
  tint = { mask, version, color, canvas: c };
  return c;
}

/**
 * Draws the active layer's mask view into ctx (document space, clipped to the document). Returns true when it drew
 * something.
 */
export function paintMaskView(ctx, view, layer) {
  const doc = view.doc;
  if (view.maskView && layer?.mask?.canvas) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, doc.width, doc.height);
    ctx.drawImage(viewedMask(layer, doc, { rasterOnly: true }) ?? layer.mask.canvas, 0, 0);
    return true;
  }
  if (view.app?.ui?.showMaskOverlay && (layer?.mask?.canvas || layer?.vectorMask)) {
    const { color, opacity } = overlayOf(view.app);
    const mask = viewedMask(layer, doc);
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.globalCompositeOperation = 'source-over';
    // a vector mask that hides nothing (Reveal All) has no canvas: nothing to tint
    if (mask) ctx.drawImage(overlayCanvas(mask, layer.version, color, doc), 0, 0);
    ctx.restore();
    return true;
  }
  return false;
}

/**
 * The Layers panel thumbnail of a layer's vector mask: w x h, the document scaled to fit, white where the mask
 * shows the layer and grey where it hides it (initialFill and the components' operations honoured; density and
 * feather are not drawn at this size).
 */
export function vectorMaskThumb(layer, w, h, doc = null) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  const vm = layer?.vectorMask;
  if (!vm) return c;
  const dw = doc?.width ?? w, dh = doc?.height ?? h;
  const s = Math.min(w / dw, h / dh);
  const ox = (w - dw * s) / 2, oy = (h - dh * s) / 2;
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, w, h);
  const path = mapPathPoints(vm.path ?? { subpaths: [] }, (x, y) => [x * s + ox, y * s + oy]);
  const area = renderVectorMask({ ...vm, path, density: 1, feather: 0 }, w, h);
  ctx.drawImage(area, 0, 0);
  return c;
}
