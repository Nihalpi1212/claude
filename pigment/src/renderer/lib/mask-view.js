// Mask view hook (ARCHITECTURE.md "0.4 features", K.1b; E10b). CanvasView.paint calls paintMaskView where 0.3 drew
// the mask channel (Alt-click on the mask thumbnail: view.maskView) and the red mask overlay
// (app.ui.showMaskOverlay); the Layers panel row draws the vector mask thumbnail with vectorMaskThumb (L.15).
//
// Stub by the skeleton: 0.3's code, moved from canvas-view.js; the thumbnail is the vector mask's path filled grey on
// white, honouring initialFill. masks-vector-masks replaces this file (same exports): density, feather, the overlay
// colour and opacity of its preferences, the vector mask outline.
import { createCanvas } from './document.js';
import { drawPathArea } from './path-ops.js';

/**
 * Draws the active layer's mask view into ctx (document space, clipped to the document). Returns true when it drew
 * something.
 */
export function paintMaskView(ctx, view, layer) {
  const doc = view.doc;
  if (view.maskView && layer?.mask?.canvas) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, doc.width, doc.height);
    ctx.drawImage(layer.mask.canvas, 0, 0);
    return true;
  }
  if (layer?.mask?.canvas && view.app.ui?.showMaskOverlay) {
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.globalCompositeOperation = 'source-over';
    const inv = document.createElement('canvas');
    inv.width = doc.width;
    inv.height = doc.height;
    const ictx = inv.getContext('2d');
    ictx.fillStyle = '#ff0000';
    ictx.fillRect(0, 0, inv.width, inv.height);
    ictx.globalCompositeOperation = 'destination-out';
    ictx.drawImage(layer.mask.canvas, 0, 0);
    ctx.drawImage(inv, 0, 0);
    ctx.restore();
    return true;
  }
  return false;
}

/**
 * The Layers panel thumbnail of a layer's vector mask: w x h, the document scaled to fit, white where the mask
 * shows the layer and grey where it hides it (initialFill 'reveal' starts white, 'hide' grey).
 */
export function vectorMaskThumb(layer, w, h, doc = null) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  const vm = layer?.vectorMask;
  if (!vm) return c;
  const dw = doc?.width ?? w, dh = doc?.height ?? h;
  const s = Math.min(w / dw, h / dh);
  const ox = (w - dw * s) / 2, oy = (h - dh * s) / 2;
  const reveal = vm.initialFill === 'reveal';
  ctx.fillStyle = reveal ? '#ffffff' : '#808080';
  ctx.fillRect(0, 0, w, h);
  const area = createCanvas(w, h);
  const actx = area.getContext('2d');
  actx.setTransform(s, 0, 0, s, ox, oy);
  drawPathArea(actx, vm.path ?? { subpaths: [] });
  actx.setTransform(1, 0, 0, 1, 0, 0);
  // inside the path: shown (white) on a hidden start, hidden (grey) on a revealed one
  actx.globalCompositeOperation = 'source-in';
  actx.fillStyle = reveal ? '#808080' : '#ffffff';
  actx.fillRect(0, 0, w, h);
  ctx.drawImage(area, 0, 0);
  return c;
}
