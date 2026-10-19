// Edit and Select menu commands: clipboard, clear, fill, stroke, define pattern, place images,
// selection commands (all, none, reselect, inverse, modify, colour range, grow, similar, from layer,
// save/load channels) and quick mask.
import { bridge } from './bridge.js';
import { RasterLayer, createCanvas, copyCanvas, intersectRect } from './document.js';
import { Selection, selectionOps } from './selection.js';
import { flattenDocument } from './compositor.js';
import { structural, nextLayerName } from './layer-ops.js';
import { decodeImage, baseName, OPEN_FILTERS } from './io.js';
import { CANVAS_BLEND } from '../../shared/pixels/blend.js';
import { BLEND_MODES } from './document.js';
import { formDialog } from './form.js';

export function install(app) {
  const has = () => !!app.doc;
  const hasSel = () => !!app.doc?.selection && !app.doc.selection.isEmpty;
  const doc = () => app.doc;
  const isTextTarget = () => {
    const el = document.activeElement;
    return !!el && ((el.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'color'].includes(el.type)) || el.tagName === 'TEXTAREA' || el.isContentEditable);
  };

  /** Target canvas for pixel edits: the mask when editing a mask, else the raster layer (document offset). */
  function pixelTarget({ quiet = false } = {}) {
    const d = doc();
    const layer = d?.active;
    if (!layer) return null;
    if (app.ui.editingMask && layer.mask) return { layer, canvas: layer.mask.canvas, x: 0, y: 0, mask: true };
    if (layer.type !== 'raster') {
      if (!quiet) app.rasterizePrompt(layer);
      return null;
    }
    if (layer.locked.all || layer.locked.pixels) {
      if (!quiet) app.dialogs.toast(`"${layer.name}" is locked`, { kind: 'error' });
      return null;
    }
    return { layer, canvas: layer.canvas, x: layer.x, y: layer.y, mask: false };
  }

  // ---- clipboard ------------------------------------------------------------------------------------------
  /** Pixels of the active layer (or the merged image) inside the selection, as { canvas, x, y }. */
  function copyPixels(merged) {
    const d = doc();
    const sel = hasSel() ? d.selection : null;
    const area = sel ? sel.bounds : d.bounds;
    let src, sx = 0, sy = 0;
    if (merged) src = flattenDocument(d, d.view.compositor);
    else {
      const layer = d.active;
      if (!layer || layer.isGroup || layer.type === 'adjustment') return null;
      if (app.ui.editingMask && layer.mask) src = layer.mask.canvas;
      else if (layer.type === 'raster') {
        src = layer.canvas;
        sx = layer.x;
        sy = layer.y;
      } else {
        const r = layer.render();
        src = r.canvas;
        sx = r.x;
        sy = r.y;
      }
    }
    const canvas = createCanvas(area.width, area.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(src, sx - area.x, sy - area.y);
    if (sel) {
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(sel.toCanvas(), -area.x, -area.y);
    }
    return { canvas, x: area.x, y: area.y };
  }

  async function toSystemClipboard(canvas) {
    try {
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        return;
      }
    } catch {
      /* fall back to the bridge */
    }
    try {
      bridge.writeClipboardImage(canvas.toDataURL('image/png'));
    } catch {
      /* ignore */
    }
  }

  async function fromSystemClipboard() {
    try {
      const bytes = await bridge.readClipboardImage?.();
      if (bytes?.length) return decodeImage(bytes, 'clipboard.png');
    } catch {
      /* ignore */
    }
    try {
      const items = await navigator.clipboard?.read?.();
      for (const item of items ?? []) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) {
          const blob = await item.getType(type);
          return decodeImage(new Uint8Array(await blob.arrayBuffer()), `clipboard.${type.split('/')[1]}`);
        }
      }
    } catch {
      /* permission denied or empty */
    }
    return null;
  }

  async function copy({ merged = false, cut = false } = {}) {
    const d = doc();
    const data = copyPixels(merged);
    if (!data) return app.dialogs.toast('Nothing to copy on this layer', { kind: 'error' });
    app.clipboard = { ...data, docId: d.id, at: Date.now() };
    await toSystemClipboard(data.canvas);
    if (cut) clearPixels('Cut');
  }

  function clearPixels(label = 'Clear') {
    const d = doc();
    const t = pixelTarget();
    if (!t) return;
    const sel = hasSel() ? d.selection : Selection.all(d.width, d.height);
    const b = sel.bounds;
    const local = { x: b.x - t.x, y: b.y - t.y, width: b.width, height: b.height };
    d.history.pixels(label, t.canvas, local, (ctx) => {
      ctx.save();
      if (t.mask) {
        // clearing a mask hides (black)
        ctx.globalCompositeOperation = 'destination-out';
        ctx.drawImage(sel.toCanvas(), 0, 0);
      } else if (t.layer.locked.transparency) {
        ctx.globalCompositeOperation = 'source-atop';
        const fill = createCanvas(b.width, b.height);
        const fctx = fill.getContext('2d');
        fctx.fillStyle = app.settings.background;
        fctx.fillRect(0, 0, b.width, b.height);
        fctx.globalCompositeOperation = 'destination-in';
        fctx.drawImage(sel.toCanvas(), -b.x, -b.y);
        ctx.drawImage(fill, local.x, local.y);
      } else {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.drawImage(sel.toCanvas(), -t.x, -t.y);
      }
      ctx.restore();
    }, { layer: t.layer, kind: t.mask ? 'mask' : 'pixels' });
  }

  async function paste({ inPlace = false, into = false } = {}) {
    const d = doc();
    let canvas, x, y;
    const system = await fromSystemClipboard();
    const internal = app.clipboard;
    // prefer our own clipboard when the system one holds the same image we copied (keeps the position)
    if (internal && (!system || (system.width === internal.canvas.width && system.height === internal.canvas.height && Date.now() - internal.at < 10 * 60 * 1000))) {
      canvas = copyCanvas(internal.canvas);
      x = internal.x;
      y = internal.y;
    } else if (system) {
      canvas = system;
      x = 0;
      y = 0;
    } else return app.dialogs.toast('The clipboard holds no image', { kind: 'error' });
    if (!d) {
      const nd = app.newDocument({ width: canvas.width, height: canvas.height, name: 'Pasted image', background: 'transparent' });
      const layer = nd.active;
      layer.canvas = canvas;
      layer.touch();
      nd.changed('pixels', { layer });
      nd.history.markSaved();
      return;
    }
    if (!inPlace || !internal || system && canvas === system) {
      // centre in the view (or the selection when pasting into it)
      const area = hasSel() ? d.selection.bounds : visibleCenterRect(d, canvas);
      x = Math.round(area.x + (area.width - canvas.width) / 2);
      y = Math.round(area.y + (area.height - canvas.height) / 2);
    }
    const layer = new RasterLayer({ name: nextLayerName(d), canvas, x, y });
    if (into && hasSel()) layer.mask = { canvas: copyCanvas(d.selection.toCanvas()), enabled: true, linked: false };
    structural(app, into ? 'Paste into' : 'Paste', () => {
      d.add(layer);
      d.setActive(layer);
    });
    if (into) app.applySelection(null, 'replace', 'Deselect');
    app.setEditingMask(false);
  }

  function visibleCenterRect(d, canvas) {
    const v = d.view?.visibleRect();
    if (v && (canvas.width <= d.width || canvas.height <= d.height)) return v;
    return d.bounds;
  }

  // ---- fill / stroke --------------------------------------------------------------------------------------
  const BLEND_OPTIONS = BLEND_MODES.filter(Boolean);

  async function fillDialog(arg) {
    const t = pixelTarget();
    if (!t) return;
    let opts = arg && typeof arg === 'object' ? arg : null;
    if (!opts) {
      opts = await formDialog(app, {
        title: 'Fill',
        okLabel: 'OK',
        fields: [
          { key: 'use', label: 'Contents', type: 'select', value: 'foreground', options: [['foreground', 'Foreground Color'], ['background', 'Background Color'], ['color', 'Color…'], ['pattern', 'Pattern'], ['black', 'Black'], ['grey', '50% Gray'], ['white', 'White'], ['history', 'History (last saved state)']] },
          { key: 'color', label: 'Color', type: 'color', value: app.settings.foreground, when: (v) => v.use === 'color' },
          { key: 'blend', label: 'Mode', type: 'select', value: 'normal', options: BLEND_OPTIONS },
          { key: 'opacity', label: 'Opacity', type: 'slider', value: 100, min: 1, max: 100, unit: '%' },
          { key: 'preserve', label: 'Preserve transparency', type: 'checkbox', value: !!t.layer.locked.transparency },
        ],
      });
      if (!opts) return;
    }
    const d = doc();
    const sel = hasSel() ? d.selection : null;
    const area = sel ? sel.bounds : d.bounds;
    if (!t.mask) t.layer.ensureCovers(area);
    const target = t.mask ? t : { ...t, canvas: t.layer.canvas, x: t.layer.x, y: t.layer.y };
    const fill = createCanvas(area.width, area.height);
    const fctx = fill.getContext('2d');
    const use = opts.use ?? 'foreground';
    if (use === 'pattern') {
      if (!app.currentPattern) return app.dialogs.toast('Define a pattern first (Edit › Define Pattern)', { kind: 'error' });
      fctx.translate(-area.x, -area.y);
      fctx.fillStyle = fctx.createPattern(app.currentPattern, 'repeat');
      fctx.fillRect(area.x, area.y, area.width, area.height);
      fctx.setTransform(1, 0, 0, 1, 0, 0);
    } else if (use === 'history') {
      const snap = d.history.savedSnapshot?.() ?? null;
      if (!snap) return app.dialogs.toast('No saved state to fill from', { kind: 'error' });
      fctx.drawImage(snap, -area.x, -area.y);
    } else {
      fctx.fillStyle = { foreground: app.settings.foreground, background: app.settings.background, color: opts.color, black: '#000000', grey: '#808080', white: '#ffffff' }[use] ?? app.settings.foreground;
      fctx.fillRect(0, 0, area.width, area.height);
    }
    if (sel) {
      fctx.globalCompositeOperation = 'destination-in';
      fctx.drawImage(sel.toCanvas(), -area.x, -area.y);
    }
    const local = { x: area.x - target.x, y: area.y - target.y, width: area.width, height: area.height };
    d.history.pixels('Fill', target.canvas, local, (ctx) => {
      ctx.save();
      ctx.globalAlpha = (opts.opacity ?? 100) / 100;
      ctx.globalCompositeOperation = opts.preserve && !t.mask ? 'source-atop' : CANVAS_BLEND[opts.blend ?? 'normal'] ?? 'source-over';
      ctx.drawImage(fill, local.x, local.y);
      ctx.restore();
    }, { layer: t.layer, kind: t.mask ? 'mask' : 'pixels' });
  }

  async function strokeDialog() {
    const d = doc();
    if (!hasSel()) return app.dialogs.toast('Make a selection to stroke', { kind: 'error' });
    const t = pixelTarget();
    if (!t) return;
    const opts = await formDialog(app, {
      title: 'Stroke',
      fields: [
        { key: 'width', label: 'Width', type: 'number', value: 3, min: 1, max: 250, unit: 'px' },
        { key: 'color', label: 'Color', type: 'color', value: app.settings.foreground },
        { key: 'location', label: 'Location', type: 'segment', value: 'center', options: [['inside', 'Inside'], ['center', 'Center'], ['outside', 'Outside']] },
        { key: 'blend', label: 'Mode', type: 'select', value: 'normal', options: BLEND_OPTIONS },
        { key: 'opacity', label: 'Opacity', type: 'slider', value: 100, min: 1, max: 100, unit: '%' },
      ],
    });
    if (!opts) return;
    const sel = d.selection;
    const w = opts.width;
    const inner = opts.location === 'inside' ? w : opts.location === 'center' ? w / 2 : 0;
    const outer = opts.location === 'outside' ? w : opts.location === 'center' ? w / 2 : 0;
    const grown = outer > 0 ? sel.expand(Math.ceil(outer)) : sel;
    const shrunk = inner > 0 ? sel.contract(Math.ceil(inner)) : sel;
    const ring = new Selection(d.width, d.height, selectionOps.combineMasks(grown.mask, shrunk.mask, 'subtract'));
    const b = ring.bounds;
    if (!b) return;
    if (!t.mask) t.layer.ensureCovers(b);
    const target = t.mask ? t : { ...t, canvas: t.layer.canvas, x: t.layer.x, y: t.layer.y };
    const fill = createCanvas(b.width, b.height);
    const fctx = fill.getContext('2d');
    fctx.fillStyle = opts.color;
    fctx.fillRect(0, 0, b.width, b.height);
    fctx.globalCompositeOperation = 'destination-in';
    fctx.drawImage(ring.toCanvas(), -b.x, -b.y);
    const local = { x: b.x - target.x, y: b.y - target.y, width: b.width, height: b.height };
    d.history.pixels('Stroke', target.canvas, local, (ctx) => {
      ctx.save();
      ctx.globalAlpha = opts.opacity / 100;
      ctx.globalCompositeOperation = CANVAS_BLEND[opts.blend] ?? 'source-over';
      ctx.drawImage(fill, local.x, local.y);
      ctx.restore();
    }, { layer: t.layer, kind: t.mask ? 'mask' : 'pixels' });
  }

  // ---- place --------------------------------------------------------------------------------------------------
  async function place(pathArg) {
    const d = doc();
    if (!d) return;
    let path = pathArg;
    if (!path) {
      [path] = await bridge.openFileDialog({ filters: OPEN_FILTERS, title: 'Place' });
      if (!path) return;
    }
    try {
      if (window.__pigmentTest?.pending?.[path]) await window.__pigmentTest.pending[path];
      const bytes = await bridge.readFile(path);
      const canvas = await decodeImage(bytes, path);
      let c = canvas;
      // fit inside the canvas when larger, like Photoshop's Place
      const scale = Math.min(1, d.width / canvas.width, d.height / canvas.height);
      if (scale < 1) {
        c = createCanvas(Math.round(canvas.width * scale), Math.round(canvas.height * scale));
        const ctx = c.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(canvas, 0, 0, c.width, c.height);
      }
      const layer = new RasterLayer({ name: baseName(path), canvas: c, x: Math.round((d.width - c.width) / 2), y: Math.round((d.height - c.height) / 2) });
      structural(app, 'Place', () => {
        d.add(layer);
        d.setActive(layer);
      });
      app.setEditingMask(false);
      app.tools.activate('move');
    } catch (err) {
      app.reportError(err, 'Could not place the image');
    }
  }

  // ---- selection commands ----------------------------------------------------------------------------------------
  async function modify(kind) {
    const d = doc();
    if (!hasSel()) return;
    const labels = { border: 'Border', smooth: 'Smooth', expand: 'Expand', contract: 'Contract', feather: 'Feather' };
    const v = await app.dialogs.prompt(`${labels[kind]} by (pixels)`, { title: `${labels[kind]} Selection`, type: 'number', value: kind === 'feather' ? '5' : '2', min: 1, max: 500 });
    if (v === null) return;
    const n = Math.max(0.1, Number(v) || 1);
    const s = d.selection;
    const next = kind === 'feather' ? s.feather(n) : kind === 'expand' ? s.expand(Math.round(n)) : kind === 'contract' ? s.contract(Math.round(n)) : kind === 'border' ? s.border(Math.round(n)) : s.smooth(Math.round(n));
    app.applySelection(next, 'replace', `${labels[kind]} selection`);
  }

  async function colorRange() {
    const d = doc();
    const img = flattenDocument(d, d.view.compositor).getContext('2d', { willReadFrequently: true }).getImageData(0, 0, d.width, d.height);
    const opts = await formDialog(app, {
      title: 'Color Range',
      fields: [
        { key: 'select', label: 'Select', type: 'select', value: 'sampled', options: [['sampled', 'Foreground color'], ['reds', 'Reds'], ['yellows', 'Yellows'], ['greens', 'Greens'], ['cyans', 'Cyans'], ['blues', 'Blues'], ['magentas', 'Magentas'], ['highlights', 'Highlights'], ['midtones', 'Midtones'], ['shadows', 'Shadows']] },
        { key: 'color', label: 'Color', type: 'color', value: app.settings.foreground, when: (v) => v.select === 'sampled' },
        { key: 'fuzziness', label: 'Fuzziness', type: 'slider', value: 40, min: 0, max: 200 },
        { key: 'invert', label: 'Invert', type: 'checkbox', value: false },
      ],
      preview: (values) => {
        const mask = rangeMask(img, values);
        const c = createCanvas(d.width, d.height);
        const ctx = c.getContext('2d');
        const out = ctx.createImageData(d.width, d.height);
        for (let i = 0; i < mask.length; i++) {
          const v = values.invert ? 255 - mask[i] : mask[i];
          out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v;
          out.data[i * 4 + 3] = 255;
        }
        ctx.putImageData(out, 0, 0);
        return c;
      },
    });
    if (!opts) return;
    let mask = rangeMask(img, opts);
    if (opts.invert) mask = selectionOps.invertMask(mask);
    app.applySelection(Selection.fromMask(d.width, d.height, mask), 'replace', 'Color range');
  }

  function rangeMask(img, opts) {
    const presets = { reds: '#ff0000', yellows: '#ffff00', greens: '#00ff00', cyans: '#00ffff', blues: '#0000ff', magentas: '#ff00ff' };
    if (opts.select === 'highlights' || opts.select === 'midtones' || opts.select === 'shadows') {
      const m = new Uint8ClampedArray(img.width * img.height);
      const d = img.data;
      for (let i = 0; i < m.length; i++) {
        const l = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
        const w = opts.select === 'highlights' ? smooth(0.55, 0.8, l) : opts.select === 'shadows' ? 1 - smooth(0.2, 0.45, l) : 1 - Math.min(1, Math.abs(l - 0.5) * 3);
        m[i] = Math.round(w * 255);
      }
      return m;
    }
    const hex = opts.select === 'sampled' ? opts.color : presets[opts.select];
    const n = parseInt(hex.slice(1, 7), 16);
    return selectionOps.colorRange(img, [[(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]], { fuzziness: opts.fuzziness });
  }
  const smooth = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };

  function layerAlphaSelection(layer) {
    const d = doc();
    const c = createCanvas(d.width, d.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const src = layer.type === 'raster' ? { canvas: layer.canvas, x: layer.x, y: layer.y } : layer.render?.();
    if (src) ctx.drawImage(src.canvas, src.x, src.y);
    const img = ctx.getImageData(0, 0, d.width, d.height);
    return Selection.fromMask(d.width, d.height, selectionOps.maskFromAlpha(img));
  }

  // ---- quick mask ---------------------------------------------------------------------------------------------------
  let quickMask = null; // { layer, previousActive }
  function toggleQuickMask() {
    const d = doc();
    if (!d) return;
    if (!quickMask) {
      // a hidden greyscale layer (white = selected) that the paint tools edit; the view shows the
      // unselected area as a red overlay, like Photoshop's rubylith
      const c = createCanvas(d.width, d.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, d.width, d.height);
      if (hasSel()) ctx.drawImage(d.selection.toCanvas(), 0, 0);
      else {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, d.width, d.height);
      }
      const layer = new RasterLayer({ name: 'Quick Mask', canvas: c, x: 0, y: 0, visible: false });
      layer.quickMask = true;
      layer.locked.position = true;
      const view = d.view;
      let tint = null, tintVersion = -1;
      const overlay = view.addOverlay((octx, v) => {
        if (!tint || tintVersion !== layer.version) {
          tint = createCanvas(d.width, d.height);
          const t = tint.getContext('2d');
          t.fillStyle = '#ff0000';
          t.fillRect(0, 0, d.width, d.height);
          t.globalCompositeOperation = 'screen';
          t.drawImage(layer.canvas, 0, 0);
          tintVersion = layer.version;
        }
        const m = v.matrix();
        octx.save();
        octx.setTransform(v.dpr * m.a, v.dpr * m.b, v.dpr * m.c, v.dpr * m.d, v.dpr * m.e, v.dpr * m.f);
        octx.globalCompositeOperation = 'multiply';
        octx.globalAlpha = 0.5;
        octx.imageSmoothingEnabled = v.zoom < 1;
        octx.drawImage(tint, 0, 0);
        octx.restore();
      });
      quickMask = { layer, previous: d.active, overlay, selection: d.selection };
      view.quickMask = layer;
      d.add(layer, d.root, d.root.children.length);
      d.setActive(layer);
      view.hideAnts = true;
      app.statusbar.set('target', 'Quick Mask: paint with black to remove from the selection, white to add. Press Q to finish.');
      app.dialogs.toast('Quick Mask on: paint to edit the selection, then press Q', { timeout: 2500 });
      if (!app.tools.active?.strokeSettings) app.tools.activate('brush');
    } else {
      const { layer, previous, overlay } = quickMask;
      quickMask = null;
      overlay();
      d.view.quickMask = null;
      d.view.hideAnts = false;
      const img = layer.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, d.width, d.height);
      const mask = new Uint8ClampedArray(d.width * d.height);
      for (let i = 0; i < mask.length; i++) {
        const j = i * 4;
        mask[i] = Math.round(((0.299 * img.data[j] + 0.587 * img.data[j + 1] + 0.114 * img.data[j + 2]) * img.data[j + 3]) / 255);
      }
      if (layer.parent?.children.includes(layer)) d.remove(layer);
      if (previous && previous.parent) d.setActive(previous);
      app.statusbar.clear('target');
      const sel = Selection.fromMask(d.width, d.height, mask);
      app.applySelection(sel.isEmpty ? null : sel, 'replace', 'Quick mask');
    }
    app.commands.invalidate();
  }

  app.commands.registerAll({
    'edit:cut': {
      run: () => {
        if (isTextTarget()) return bridge.nativeEdit('cut');
        if (has()) return copy({ cut: true });
      },
    },
    'edit:copy': {
      run: () => {
        if (isTextTarget()) return bridge.nativeEdit('copy');
        if (has()) return copy();
      },
    },
    'edit:copy-merged': { enabled: has, run: () => copy({ merged: true }) },
    'edit:paste': {
      run: () => {
        if (isTextTarget()) return bridge.nativeEdit('paste');
        return paste();
      },
    },
    'edit:paste-in-place': { run: () => paste({ inPlace: true }) },
    'edit:paste-into': { enabled: hasSel, run: () => paste({ into: true }) },
    'edit:clear': {
      enabled: has,
      run: () => {
        if (isTextTarget()) return bridge.nativeEdit('delete');
        if (app.tools?.active?.deleteSelection?.()) return;
        if (!hasSel()) {
          // Delete without a selection deletes the layer (like Photoshop's Layers panel)
          return app.commands.run('layer:delete', undefined, 'api');
        }
        clearPixels();
      },
    },
    'edit:fill': { enabled: has, run: (arg) => fillDialog(arg) },
    'edit:fill-foreground': { enabled: has, run: () => fillDialog({ use: 'foreground', opacity: 100, blend: 'normal', preserve: false }) },
    'edit:fill-background': { enabled: has, run: () => fillDialog({ use: 'background', opacity: 100, blend: 'normal', preserve: false }) },
    'edit:stroke': { enabled: hasSel, run: () => strokeDialog() },
    'edit:define-pattern': {
      enabled: has,
      run: () => {
        const data = copyPixels(true);
        if (!data) return;
        app.currentPattern = data.canvas;
        app.patterns = [...(app.patterns ?? []), data.canvas].slice(-24);
        app.dialogs.toast(`Pattern defined (${data.canvas.width} × ${data.canvas.height})`, { kind: 'success', timeout: 1800 });
      },
    },
    'file:place': { enabled: has, run: (path) => place(typeof path === 'string' ? path : null) },
    'file:import-image': { enabled: has, run: () => place(null) },

    'select:all': {
      enabled: has,
      run: () => {
        if (isTextTarget()) return bridge.nativeEdit('selectAll');
        const d = doc();
        app.applySelection(Selection.all(d.width, d.height), 'replace', 'Select all');
      },
    },
    'edit:select-all': { run: () => app.commands.run('select:all', undefined, 'api') },
    'select:none': { enabled: hasSel, run: () => app.applySelection(null, 'replace', 'Deselect') },
    'select:reselect': {
      enabled: () => !!app.doc?.savedSelection,
      run: () => app.applySelection(doc().savedSelection.clone(), 'replace', 'Reselect'),
    },
    'select:inverse': { enabled: has, run: () => app.applySelection(hasSel() ? doc().selection.invert() : Selection.all(doc().width, doc().height), 'replace', 'Inverse') },
    'select:modify': { enabled: hasSel, run: (kind) => modify(kind) },
    'select:feather': { enabled: hasSel, run: () => modify('feather') },
    'select:expand': { enabled: hasSel, run: () => modify('expand') },
    'select:contract': { enabled: hasSel, run: () => modify('contract') },
    'select:border': { enabled: hasSel, run: () => modify('border') },
    'select:smooth': { enabled: hasSel, run: () => modify('smooth') },
    'select:color-range': { enabled: has, run: () => colorRange() },
    'select:grow': {
      enabled: hasSel,
      run: () => {
        const d = doc();
        const img = flattenDocument(d, d.view.compositor).getContext('2d', { willReadFrequently: true }).getImageData(0, 0, d.width, d.height);
        const tol = app.tools.opt('wand', 'tolerance') ?? 32;
        app.applySelection(Selection.fromMask(d.width, d.height, selectionOps.grow(img, d.selection.mask, { tolerance: tol })), 'replace', 'Grow');
      },
    },
    'select:similar': {
      enabled: hasSel,
      run: () => {
        const d = doc();
        const img = flattenDocument(d, d.view.compositor).getContext('2d', { willReadFrequently: true }).getImageData(0, 0, d.width, d.height);
        const tol = app.tools.opt('wand', 'tolerance') ?? 32;
        app.applySelection(Selection.fromMask(d.width, d.height, selectionOps.similar(img, d.selection.mask, { tolerance: tol })), 'replace', 'Similar');
      },
    },
    'select:from-layer': {
      enabled: () => !!app.doc?.active && !app.doc.active.isGroup,
      run: (id) => {
        const d = doc();
        const layer = (typeof id === 'string' && d.find(id)) || d.active;
        app.applySelection(layerAlphaSelection(layer), 'replace', 'Select layer pixels');
      },
    },
    'select:save': {
      enabled: hasSel,
      run: async () => {
        const d = doc();
        const name = await app.dialogs.prompt('Channel name', { title: 'Save Selection', value: `Alpha ${d.channels.length + 1}` });
        if (!name) return;
        const ch = { id: `C${Date.now().toString(36)}`, name, mask: new Uint8ClampedArray(d.selection.mask) };
        const before = d.channels.slice();
        const set = (list) => {
          d.channels = list.slice();
          d.changed('channels');
          app.emit('channels:changed', d);
        };
        set([...before, ch]);
        d.history.push({ label: 'Save selection', undo: () => set(before), redo: () => set([...before, ch]), bytes: ch.mask.length, at: Date.now() });
      },
    },
    'select:load': {
      enabled: () => !!app.doc?.channels.length,
      run: async (id) => {
        const d = doc();
        let ch = d.channels.find((c) => c.id === id);
        if (!ch) {
          const opts = await formDialog(app, {
            title: 'Load Selection',
            fields: [
              { key: 'channel', label: 'Channel', type: 'select', value: d.channels[0].id, options: d.channels.map((c) => [c.id, c.name]) },
              { key: 'invert', label: 'Invert', type: 'checkbox', value: false },
              { key: 'mode', label: 'Operation', type: 'select', value: 'replace', options: [['replace', 'New selection'], ['add', 'Add to selection'], ['subtract', 'Subtract from selection'], ['intersect', 'Intersect with selection']] },
            ],
          });
          if (!opts) return;
          ch = d.channels.find((c) => c.id === opts.channel);
          let sel = Selection.fromMask(d.width, d.height, new Uint8ClampedArray(ch.mask));
          if (opts.invert) sel = sel.invert();
          return app.applySelection(sel, opts.mode, 'Load selection');
        }
        app.applySelection(Selection.fromMask(d.width, d.height, new Uint8ClampedArray(ch.mask)), 'replace', 'Load selection');
      },
    },
    'select:quick-mask': { enabled: has, checked: () => !!quickMask, run: () => toggleQuickMask() },
    'select:transform': { enabled: hasSel, run: () => app.commands.run('edit:free-transform', { selectionOnly: true }, 'api') },
  });

  // Q toggles quick mask (plain key, renderer only)
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'q' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable || el.closest?.('.dialog-backdrop'))) return;
    if (!app.doc) return;
    e.preventDefault();
    app.commands.run('select:quick-mask', undefined, 'key');
  });

  app.pixelTarget = pixelTarget;
  app.layerAlphaSelection = layerAlphaSelection;
  void intersectRect;
}
