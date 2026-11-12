// What a mask made by Select Subject / Sky / Focus Area / Select and Mask becomes: a selection, a
// layer mask, a new layer (with or without a mask) or a new document — always one history entry in
// the document it changes. Also the pixels those features look at.
import { Document, RasterLayer, createCanvas } from '../document.js';
import { flattenStored } from '../compositor.js';
import { Selection, selectionOps } from '../selection.js';
import { structural, setLayerProps, cloneLayer } from '../layer-ops.js';

/** Output To choices, in Photoshop's order. `pixels` marks the ones Decontaminate Colors can apply to. */
export const OUTPUTS = [
  ['selection', 'Selection'],
  ['mask', 'Layer Mask'],
  ['layer', 'New Layer'],
  ['layer-mask', 'New Layer with Layer Mask'],
  ['document', 'New Document'],
  ['document-mask', 'New Document with Layer Mask'],
];
export const PIXEL_OUTPUTS = new Set(['layer', 'layer-mask', 'document', 'document-mask']);
export const isOutput = (v) => OUTPUTS.some(([id]) => id === v);

/** True when the layer has pixels of its own to look at (groups and adjustment layers do not). */
const hasOwnPixels = (layer) => !!layer && !layer.isGroup && (layer.type === 'raster' || typeof layer.render === 'function');

/**
 * The pixels a selection is made from, document sized: the active layer in place, or the composite
 * when `sampleAll` is set or the layer has no pixels of its own (a group, an adjustment layer).
 * @returns {{ img: ImageData, layer: object | null, merged: boolean } | null}
 */
export function sourceImage(app, { sampleAll = false } = {}) {
  const doc = app.doc;
  if (!doc) return null;
  const layer = doc.active;
  const W = doc.width, H = doc.height;
  if (sampleAll || !hasOwnPixels(layer)) {
    // the pixels may become a new layer or document in the same image mode: stored pixels, not the inks shown
    const flat = flattenStored(doc, doc.view.compositor);
    return { img: flat.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H), layer, merged: true };
  }
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const src = layer.type === 'raster' ? { canvas: layer.canvas, x: layer.x, y: layer.y } : layer.render();
  if (src?.canvas) ctx.drawImage(src.canvas, src.x, src.y);
  return { img: ctx.getImageData(0, 0, W, H), layer, merged: false };
}

/** White canvas whose alpha is the mask (what a layer mask and destination-in clipping use). */
export function maskCanvas(mask, width, height) {
  const c = createCanvas(width, height);
  const ctx = c.getContext('2d');
  const out = ctx.createImageData(width, height);
  const d = out.data;
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    d[i] = d[i + 1] = d[i + 2] = 255;
    d[i + 3] = mask[p];
  }
  ctx.putImageData(out, 0, 0);
  return c;
}

/** The alpha of a layer mask as a selection mask (document sized). */
export function maskOfLayer(doc, layer) {
  const out = new Uint8ClampedArray(doc.width * doc.height);
  if (!layer?.mask?.canvas) return out;
  const c = layer.mask.canvas;
  const w = Math.min(doc.width, c.width), h = Math.min(doc.height, c.height);
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * doc.width + x] = d[(y * w + x) * 4 + 3];
  return out;
}

/**
 * Colours computed for a new layer (decontaminated edges) snapped to what the document's image mode
 * can hold (grey, black / white, the colour table), as every pixel edit is.
 */
export function constrainPixels(app, doc, layer, data) {
  if (!app.pixelConstraint) return data;
  const out = app.pixelConstraint(doc, { width: doc.width, height: doc.height, data }, layer);
  return out?.data ?? data;
}

const isEmpty = (mask) => {
  for (let p = 0; p < mask.length; p++) if (mask[p]) return false;
  return true;
};

/**
 * Applies a finished mask.
 * @param {import('../../app.js').App} app
 * @param {{ mask: Uint8ClampedArray, output?: string, label?: string, source?: { img: ImageData, merged: boolean } | null,
 *   pixels?: Uint8ClampedArray | null }} o
 *   source: the pixels the mask was made on (taken from the active layer when omitted); pixels: RGBA to
 *   use instead of the source's (the decontaminated copy), same size
 * @returns {{ output: string, layer?: object, doc?: object } | null} null when there was nothing to do
 */
export function outputMask(app, { mask, output = 'selection', label = 'Select and Mask', source = null, pixels = null }) {
  const doc = app.doc;
  if (!doc) return null;
  const W = doc.width, H = doc.height;
  if (mask.length !== W * H) throw new Error('The mask does not fit the document');
  const layer = doc.active;
  const hadSelection = !!doc.selection && !doc.selection.isEmpty;

  if (output === 'selection' || !layer) {
    const empty = isEmpty(mask);
    if (empty && !hadSelection) {
      app.dialogs.toast('Nothing is selected', { timeout: 2200 });
      return null;
    }
    app.applySelection(empty ? null : Selection.fromMask(W, H, mask), 'replace', label);
    return { output: 'selection' };
  }

  if (output === 'mask') {
    const next = { ...(layer.mask ?? {}), canvas: maskCanvas(mask, W, H), enabled: true, linked: layer.mask?.linked ?? true };
    doc.history.group(label, () => {
      setLayerProps(app, layer, { mask: next }, label);
      // the selection became the mask (Photoshop drops it too)
      if (hadSelection) app.applySelection(null, 'replace', 'Deselect');
    });
    app.syncUiState();
    return { output, layer };
  }

  // the outputs below copy pixels: the layer's own (or the composite's when all layers were sampled)
  const src = source ?? sourceImage(app);
  const rgba = pixels ?? src.img.data;
  const full = () => {
    const c = createCanvas(W, H);
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), W, H), 0, 0);
    return c;
  };
  /** The selected pixels alone, trimmed to the mask's bounds. */
  const cutOut = () => {
    const b = selectionOps.maskBounds(mask, W, H) ?? { x: 0, y: 0, width: 1, height: 1 };
    const c = full();
    const ctx = c.getContext('2d');
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(maskCanvas(mask, W, H), 0, 0);
    const out = createCanvas(b.width, b.height);
    out.getContext('2d').drawImage(c, -b.x, -b.y);
    return { canvas: out, x: b.x, y: b.y };
  };
  /** A copy of the whole layer (pixels outside the canvas included) carrying the mask. */
  const maskedCopy = (name) => {
    let copy;
    if (!src.merged && layer.type === 'raster') {
      copy = cloneLayer(layer, { name });
      // the decontaminated pixels replace the part of the layer inside the canvas
      if (pixels) copy.canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), W, H), -copy.x, -copy.y);
      copy.clip = false;
    } else copy = new RasterLayer({ name, canvas: full(), x: 0, y: 0 });
    copy.visible = true;
    copy.mask = { canvas: maskCanvas(mask, W, H), enabled: true, linked: true };
    return copy;
  };
  const baseName = src.merged ? 'Merged' : layer.name;

  if (output === 'layer' || output === 'layer-mask') {
    const copy = output === 'layer' ? new RasterLayer({ name: `${baseName} copy`, ...cutOut() }) : maskedCopy(`${baseName} copy`);
    const parent = layer.parent ?? doc.root;
    doc.history.group(label, () => {
      // the original would show through the cut-out: Photoshop hides it (a merged copy hides nothing)
      if (!src.merged && layer.visible) setLayerProps(app, layer, { visible: false }, 'Hide layer');
      structural(app, 'New layer', () => {
        doc.add(copy, parent, parent.children.indexOf(layer) + 1);
        doc.setActive(copy);
      }, doc, { bytes: copy.canvas.width * copy.canvas.height * 4 });
    });
    app.syncUiState();
    return { output, layer: copy };
  }

  if (output === 'document' || output === 'document-mask') {
    const copy = new Document({
      width: W,
      height: H,
      dpi: doc.dpi,
      name: `${doc.name.replace(/\.[^.]+$/, '')} copy`,
      mode: doc.mode ?? 'rgb',
      depth: doc.depth ?? 8,
      colorTable: doc.colorTable ? doc.colorTable.map((c) => [...c]) : null,
      duotone: doc.duotone ? JSON.parse(JSON.stringify(doc.duotone)) : null,
    });
    const l = output === 'document' ? new RasterLayer({ name: 'Layer 1', ...cutOut() }) : maskedCopy(baseName);
    l.opacity = 1;
    l.blend = 'normal';
    l.parent = copy.root;
    copy.root.children.push(l);
    copy.active = l;
    copy.selected = new Set([l]);
    copy.meta = { ...(doc.meta ?? {}) };
    // a Multichannel image is shown through its spot channels (meta.imageMode names them by id): without them the
    // copy would print no ink at all and show white
    copy.channels = doc.channels.filter((c) => c.spot).map((c) => ({ ...c, spot: { ...c.spot }, mask: new Uint8ClampedArray(c.mask) }));
    app.docs.add(copy);
    copy.history.markSaved();
    copy.history.savedIndex = -2; // never saved: closing asks
    app.syncUiState();
    return { output, doc: copy, layer: l };
  }
  throw new Error(`Unknown output: ${output}`);
}
