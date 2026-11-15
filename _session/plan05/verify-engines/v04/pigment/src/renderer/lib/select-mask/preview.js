// The view modes of Select and Mask (and the Focus Area dialog's preview): while a session runs the
// canvas view draws what this class hands back instead of the plain composite (view.postProcess, the
// hook Proof Colors uses). Everything is built with canvas compositing from three document-sized
// canvases (the composite, the mask as alpha, a scratch), so switching the view or moving a slider
// costs no pixel loop; only a changed part of the mask is uploaded.
//
//   onion     the selection opaque, the rest faded by Transparency (0 = everything shown, 100 = hidden)
//   ants      the plain image with the outline of the selection (the session draws the outline)
//   overlay   a colour at Opacity over the masked (or the selected) areas
//   black     the selection over black at Opacity        white     ... over white
//   bw        the mask itself, white = selected
//   layers    the document as it would look with the selection as the layer's mask
// Show Edge replaces all of them by the image inside the refinement band, black elsewhere.
import { createCanvas } from '../document.js';
import { Compositor } from '../compositor.js';

export const VIEW_MODES = [
  ['onion', 'Onion Skin (O)'],
  ['ants', 'Marching Ants (M)'],
  ['overlay', 'Overlay (V)'],
  ['black', 'On Black (A)'],
  ['white', 'On White (T)'],
  ['bw', 'Black & White (K)'],
  ['layers', 'On Layers (Y)'],
];
export const VIEW_KEYS = { o: 'onion', m: 'ants', v: 'overlay', a: 'black', t: 'white', k: 'bw', y: 'layers' };

export class MaskPreview {
  /**
   * @param {import('../../app.js').App} app
   * @param {import('../document.js').Document} doc
   * @param {{ layer?: object | null }} [opts] layer: the layer the On Layers view masks
   */
  constructor(app, doc, { layer = null } = {}) {
    this.app = app;
    this.doc = doc;
    this.view = doc.view;
    this.layer = layer;
    const W = doc.width, H = doc.height;
    this.maskCanvas = createCanvas(W, H);
    this.maskCtx = this.maskCanvas.getContext('2d', { willReadFrequently: true });
    this.out = createCanvas(W, H);
    this.scratch = createCanvas(W, H);
    this.bandCanvas = null;
    this.settings = { view: 'onion', onion: 50, opacity: 50, color: '#ff0000', indicates: 'masked', showEdge: false, enabled: true };
    this.dirty = true;
    this.key = '';
    this.maskVersion = 0;
    this.previous = this.view.postProcess ?? null;
    this.previousHideAnts = this.view.hideAnts;
    this.view.hideAnts = true; // the document's own selection is not what is being shown
    this.view.postProcess = (composite) => this.render(composite);
    this.view.invalidate();
  }

  destroy() {
    if (!this.view) return;
    this.view.postProcess = this.previous;
    this.view.hideAnts = this.previousHideAnts;
    this.view.invalidate();
    this.view = null;
  }

  /** Changes view settings ({ view, onion, opacity, color, indicates, showEdge, enabled }). */
  set(patch) {
    Object.assign(this.settings, patch);
    this.dirty = true;
    this.view?.invalidate();
  }

  /**
   * Shows `mask` (document sized, 0..255). `rect` limits the upload to the part that changed.
   * @param {Uint8ClampedArray} mask @param {{ x: number, y: number, width: number, height: number } | null} [rect]
   */
  setMask(mask, rect = null) {
    const W = this.doc.width, H = this.doc.height;
    const x0 = rect ? Math.max(0, Math.floor(rect.x)) : 0, y0 = rect ? Math.max(0, Math.floor(rect.y)) : 0;
    const x1 = rect ? Math.min(W, Math.ceil(rect.x + rect.width)) : W, y1 = rect ? Math.min(H, Math.ceil(rect.y + rect.height)) : H;
    if (x1 <= x0 || y1 <= y0) return;
    const w = x1 - x0, h = y1 - y0;
    const img = this.maskCtx.createImageData(w, h);
    const d = img.data;
    for (let y = 0; y < h; y++) {
      let p = (y0 + y) * W + x0, i = y * w * 4;
      for (let x = 0; x < w; x++, p++, i += 4) {
        d[i] = d[i + 1] = d[i + 2] = 255;
        d[i + 3] = mask[p];
      }
    }
    this.maskCtx.putImageData(img, x0, y0);
    this.maskVersion++;
    this.dirty = true;
    this.view?.invalidate();
  }

  /** The refinement band (flags per pixel) for Show Edge; null drops it. */
  setBand(band) {
    if (!band) this.bandCanvas = null;
    else {
      const W = this.doc.width, H = this.doc.height;
      this.bandCanvas ??= createCanvas(W, H);
      const ctx = this.bandCanvas.getContext('2d');
      const img = ctx.createImageData(W, H);
      const d = img.data;
      for (let p = 0, i = 0; p < band.length; p++, i += 4) {
        d[i] = d[i + 1] = d[i + 2] = 255;
        d[i + 3] = band[p] ? 255 : 0;
      }
      ctx.putImageData(img, 0, 0);
    }
    this.dirty = true;
    this.view?.invalidate();
  }

  /** `colour` where the mask is (keep = 'in') or is not (keep = 'out'), in the scratch canvas. */
  tint(colour, keep, maskSource = this.maskCanvas) {
    const W = this.doc.width, H = this.doc.height;
    const ctx = this.scratch.getContext('2d');
    ctx.globalCompositeOperation = 'copy';
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = keep === 'in' ? 'destination-in' : 'destination-out';
    ctx.drawImage(maskSource, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    return this.scratch;
  }

  /** The composite inside `maskSource`, in the scratch canvas. */
  cut(composite, maskSource = this.maskCanvas) {
    const ctx = this.scratch.getContext('2d');
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(composite, 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(maskSource, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    return this.scratch;
  }

  /** view.postProcess: the canvas to draw instead of the composite (null = the composite itself). */
  render(composite) {
    const s = this.settings, doc = this.doc;
    if (!s.enabled || (s.view === 'ants' && !s.showEdge)) return null;
    const key = `${doc.version}|${doc.root.version}|${composite.width}x${composite.height}`;
    if (!this.dirty && key === this.key) return this.out;
    const W = doc.width, H = doc.height;
    const ctx = this.out.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, W, H);
    const opacity = Math.max(0, Math.min(1, s.opacity / 100));
    if (s.showEdge) {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, W, H);
      if (this.bandCanvas) ctx.drawImage(this.cut(composite, this.bandCanvas), 0, 0);
    } else if (s.view === 'onion') {
      ctx.globalAlpha = 1 - Math.max(0, Math.min(1, s.onion / 100));
      ctx.drawImage(composite, 0, 0);
      ctx.globalAlpha = 1;
      ctx.drawImage(this.cut(composite), 0, 0);
    } else if (s.view === 'overlay' || s.view === 'black' || s.view === 'white') {
      ctx.drawImage(composite, 0, 0);
      const colour = s.view === 'overlay' ? s.color : s.view === 'black' ? '#000000' : '#ffffff';
      const keep = s.view === 'overlay' && s.indicates === 'selected' ? 'in' : 'out';
      ctx.globalAlpha = opacity;
      ctx.drawImage(this.tint(colour, keep), 0, 0);
      ctx.globalAlpha = 1;
    } else if (s.view === 'bw') {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, W, H);
      ctx.drawImage(this.maskCanvas, 0, 0);
    } else if (s.view === 'layers') {
      ctx.drawImage(this.onLayers() ?? this.cut(composite), 0, 0);
    } else ctx.drawImage(composite, 0, 0);
    this.dirty = false;
    this.key = key;
    return this.out;
  }

  /**
   * The document with the shown mask standing in for the layer's mask. A throw-away compositor renders
   * it (no cache can remember the borrowed mask) and the layer gets its own mask back before anything
   * else can look.
   */
  onLayers() {
    const layer = this.layer;
    if (!layer || !this.doc.layers().includes(layer)) return null;
    const own = layer.mask;
    layer.mask = { canvas: this.maskCanvas, enabled: true, linked: true };
    try {
      return new Compositor().composite(this.doc);
    } finally {
      layer.mask = own;
    }
  }
}
