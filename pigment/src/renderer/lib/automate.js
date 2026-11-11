// File > Automate and File > Scripts.
//
// - Batch… and Image Processor… (automate/batch.js) run an action / a resize-and-save over a folder of
//   images or the open documents; Contact Sheet… (automate/contact-sheet.js) lays thumbnails out on new
//   documents.
// - Fit Image… scales the image to fit a box through image:size.
// - Crop and Straighten Photos separates the photos of a scan into documents (automate/scan.js finds them).
// - Delete All Empty Layers, Flatten All Layer Effects and Flatten All Masks each change the whole layer
//   tree in one undoable step.
// Every command with a dialog accepts its settings as the argument and reports them through
// ctx.setReplayArg, so actions record and replay it without the dialog.
import { createCanvas, copyCanvas, canvasIsBlank, Document, RasterLayer } from './document.js';
import { flattenDocument } from './compositor.js';
import { structural, rasterizeLayer } from './layer-ops.js';
import { formDialog } from './form.js';
import { baseName } from './io.js';
import { fitSize } from './automate/naming.js';
import { findPhotos, isWholeImage } from './automate/scan.js';
import { batchCommand, imageProcessorCommand } from './automate/batch.js';
import { contactSheetCommand } from './automate/contact-sheet.js';

/** Photos are looked for on a copy no larger than this (the result is scaled back): the search is O(pixels). */
const SCAN_MAX = 1400;

export function install(app) {
  const has = () => !!app.doc;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // ---- Fit Image ----------------------------------------------------------------------------------------------
  async function fitImage(arg, ctx) {
    const d = app.doc;
    if (!d) return ctx?.cancel();
    let o = arg && typeof arg === 'object' ? arg : null;
    if (!o) {
      const last = app.settings.fitImage ?? {};
      o = await formDialog(app, {
        title: 'Fit Image',
        intro: `Scales the image to fit inside this box, keeping its proportions. Current size: ${d.width} × ${d.height} px.`,
        fields: [
          { type: 'section', label: 'Constrain Within' },
          { key: 'width', label: 'Width', type: 'number', value: last.width ?? d.width, min: 1, max: 30000, unit: 'px' },
          { key: 'height', label: 'Height', type: 'number', value: last.height ?? d.height, min: 1, max: 30000, unit: 'px' },
          { key: 'dontEnlarge', label: 'Don’t Enlarge', type: 'checkbox', value: !!last.dontEnlarge },
        ],
        width: 380,
      });
      if (!o) return ctx?.cancel();
      app.saveSettingsSoon({ fitImage: { width: o.width, height: o.height, dontEnlarge: !!o.dontEnlarge } });
    }
    const box = { width: Math.round(Number(o.width)), height: Math.round(Number(o.height)), dontEnlarge: !!o.dontEnlarge };
    if (!(box.width >= 1) || !(box.height >= 1)) {
      ctx?.cancel();
      return app.dialogs.toast('Fit Image needs a width and a height of at least 1 pixel', { kind: 'error' });
    }
    ctx?.setReplayArg(box);
    const fit = fitSize(d.width, d.height, box.width, box.height, { enlarge: !box.dontEnlarge });
    if (fit.width === d.width && fit.height === d.height) return { width: d.width, height: d.height, changed: false };
    await app.commands.run('image:size', { width: fit.width, height: fit.height, method: app.settings.resampleMethod ?? 'bicubic' }, 'api');
    return { width: app.doc?.width, height: app.doc?.height, changed: true };
  }

  // ---- Crop and Straighten Photos -----------------------------------------------------------------------------
  async function cropAndStraighten(arg) {
    const d = app.doc;
    if (!d) return null;
    app.tools.active?.commit?.();
    const made = await app.busy('Looking for photos…', async () => {
      const flat = flattenDocument(d, d.view.compositor);
      const k = Math.min(1, SCAN_MAX / Math.max(flat.width, flat.height));
      const small = createCanvas(Math.max(1, Math.round(flat.width * k)), Math.max(1, Math.round(flat.height * k)));
      const sctx = small.getContext('2d', { willReadFrequently: true });
      sctx.imageSmoothingQuality = 'medium';
      sctx.drawImage(flat, 0, 0, small.width, small.height);
      const img = sctx.getImageData(0, 0, small.width, small.height);
      const photos = findPhotos(img, { tolerance: Number(arg?.tolerance) || 24, minSide: Math.max(8, 24 * k) });
      if (!photos.length || isWholeImage(photos, small.width, small.height)) return [];
      const docs = [];
      const stem = baseName(d.name);
      photos.forEach((p, i) => {
        // back to full resolution; one pixel is shaved off each side so the bed never shows at the edges
        const w = Math.max(1, Math.round(p.width / k) - (p.angle ? 2 : 0)), h = Math.max(1, Math.round(p.height / k) - (p.angle ? 2 : 0));
        const cx = p.center[0] / k, cy = p.center[1] / k;
        const canvas = createCanvas(w, h);
        const ctx = canvas.getContext('2d');
        if (p.angle) {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.translate(w / 2, h / 2);
          ctx.rotate((-p.angle * Math.PI) / 180);
          ctx.drawImage(flat, -cx, -cy);
        } else ctx.drawImage(flat, -Math.round(cx - w / 2), -Math.round(cy - h / 2));
        const copy = new Document({ width: w, height: h, dpi: d.dpi, name: `${stem} copy${i ? ` ${i + 1}` : ''}` });
        const layer = new RasterLayer({ name: 'Background', canvas });
        layer.parent = copy.root;
        copy.root.children.push(layer);
        copy.active = layer;
        copy.selected = new Set([layer]);
        docs.push(copy);
      });
      return docs;
    });
    if (!made.length) {
      app.dialogs.toast('No separate photos were found. Crop and Straighten needs photos on a plain background with a gap between them.', { kind: 'info', timeout: 5000 });
      return { photos: 0 };
    }
    for (const copy of made) {
      app.docs.add(copy);
      copy.history.markSaved();
      copy.history.savedIndex = -2; // never saved: closing asks
    }
    app.syncUiState();
    app.dialogs.toast(`${plural(made.length, 'photo')} cropped into new documents`, { kind: 'success', timeout: 2500 });
    return { photos: made.length, sizes: made.map((c) => [c.width, c.height]) };
  }

  // ---- layer scripts ------------------------------------------------------------------------------------------
  function deleteEmptyLayers() {
    const d = app.doc;
    if (!d) return 0;
    app.tools.active?.commit?.();
    const empty = d.layers().filter((l) => l.type === 'raster' && canvasIsBlank(l.canvas));
    // a document keeps at least one layer
    const others = d.layers().filter((l) => !empty.includes(l) && !l.isGroup);
    if (!others.length && empty.length) empty.shift();
    if (!empty.length) {
      app.dialogs.toast('There are no empty layers', { timeout: 1800 });
      return 0;
    }
    structural(app, 'Delete all empty layers', () => {
      for (const l of empty) if (l.parent) d.remove(l);
      if (!d.active || !d.find(d.active.id)) d.setActive(d.layers().filter((l) => !l.isGroup).pop() ?? d.layers().pop() ?? null);
    });
    app.setEditingMask(false);
    app.dialogs.toast(`Deleted ${plural(empty.length, 'empty layer')}`, { kind: 'success', timeout: 1800 });
    return empty.length;
  }

  const styled = (l) => !!l.styles && Object.values(l.styles).some((s) => s?.enabled);

  function flattenEffects() {
    const d = app.doc;
    if (!d) return 0;
    app.tools.active?.commit?.();
    const layers = d.layers().filter((l) => styled(l) && !l.isGroup);
    if (!layers.length) {
      app.dialogs.toast('No layer has effects', { timeout: 1800 });
      return 0;
    }
    // rendered before the tree changes: each layer's effects are baked as they look now
    const baked = layers.map((l) => [l, rasterizeLayer(l, d, { bakeStyles: true })]).filter(([, r]) => r);
    structural(app, 'Flatten all layer effects', () => {
      for (const [layer, r] of baked) {
        const parent = layer.parent, i = parent.children.indexOf(layer);
        const active = d.active === layer;
        d.remove(layer);
        d.add(r, parent, i);
        if (active) d.setActive(r);
      }
    });
    app.dialogs.toast(`Flattened the effects of ${plural(baked.length, 'layer')}`, { kind: 'success', timeout: 1800 });
    return baked.length;
  }

  function flattenMasks() {
    const d = app.doc;
    if (!d) return 0;
    app.tools.active?.commit?.();
    const layers = d.layers().filter((l) => l.type === 'raster' && l.mask?.canvas);
    if (!layers.length) {
      app.dialogs.toast('No pixel layer has a mask', { timeout: 1800 });
      return 0;
    }
    // what Layer > Layer Mask > Apply does, for every masked pixel layer, as one history entry
    const changes = layers.map((layer) => {
      const canvas = copyCanvas(layer.canvas);
      const ctx = canvas.getContext('2d');
      if (layer.mask.enabled !== false) {
        ctx.globalCompositeOperation = 'destination-in';
        ctx.drawImage(layer.mask.canvas, -layer.x, -layer.y);
      }
      return { layer, before: { canvas: layer.canvas, mask: layer.mask }, after: { canvas, mask: null } };
    });
    const apply = (key) => {
      for (const c of changes) {
        c.layer.canvas = c[key].canvas;
        c.layer.mask = c[key].mask;
        c.layer.touch();
      }
      d.changed('props');
    };
    apply('after');
    d.history.push({ label: 'Flatten all masks', undo: () => apply('before'), redo: () => apply('after'), bytes: changes.reduce((n, c) => n + c.after.canvas.width * c.after.canvas.height * 4, 0), at: Date.now() });
    d.changed('history');
    app.setEditingMask(false);
    app.dialogs.toast(`Applied the masks of ${plural(layers.length, 'layer')}`, { kind: 'success', timeout: 1800 });
    return layers.length;
  }

  app.commands.registerAll({
    'file:automate-batch': { label: 'Batch…', dialog: true, enabled: () => !app.actions?.playing, run: (arg, ctx) => batchCommand(app, arg, ctx) },
    'file:script-image-processor': { label: 'Image Processor…', dialog: true, enabled: () => !app.actions?.playing, run: (arg, ctx) => imageProcessorCommand(app, arg, ctx) },
    'file:automate-contact-sheet': { label: 'Contact Sheet…', dialog: true, run: (arg, ctx) => contactSheetCommand(app, arg, ctx) },
    'file:automate-fit-image': { label: 'Fit Image…', dialog: true, enabled: has, run: fitImage },
    'file:automate-crop-straighten': { label: 'Crop and Straighten Photos', enabled: has, run: cropAndStraighten },
    'file:script-delete-empty-layers': { label: 'Delete All Empty Layers', enabled: has, run: deleteEmptyLayers },
    'file:script-flatten-effects': { label: 'Flatten All Layer Effects', enabled: has, run: flattenEffects },
    'file:script-flatten-masks': { label: 'Flatten All Masks', enabled: has, run: flattenMasks },
  });
}
