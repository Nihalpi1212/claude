// Layer › Quick Export as PNG and Layer › Export As…: every selected layer (or group) is rendered
// alone, with its own opacity, mask and styles, trimmed to what it draws and written as one file.
import { bridge, joinPath, pathSep } from '../bridge.js';
import { formDialog } from '../form.js';
import { exportImage, SAVE_FORMATS } from '../io.js';
import { createCanvas } from '../document.js';
import { renderLayersFlat } from '../layer-ops.js';
import { contentBounds } from '../../../shared/pixels/core.js';

const flatFormats = () => Object.entries(SAVE_FORMATS).filter(([, info]) => !info.layered).map(([id, info]) => [id, info.name.replace(/ image$/, '')]);
const fileSafe = (name) => String(name).replace(/[\\/:*?"<>|]+/g, '_').replace(/^\.+/, '').trim().slice(0, 120) || 'layer';
const isVirtual = (path) => !path || path.startsWith('browser:/') || path.startsWith('download:/');

/**
 * One layer rendered by itself on a document-sized canvas, then cut down to its painted pixels.
 * Hidden layers export too (the user picked them), so the layer and the groups around it are shown
 * for the render. Returns null when the layer draws nothing inside the canvas.
 */
export function renderLayerAlone(doc, layer, { trim = true } = {}) {
  const shown = [];
  for (let l = layer; l && l !== doc.root; l = l.parent) if (!l.visible) {
    shown.push(l);
    l.visible = true;
  }
  let flat;
  try {
    flat = renderLayersFlat(doc, [layer]);
  } finally {
    for (const l of shown) l.visible = false;
  }
  const img = flat.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, flat.width, flat.height);
  const b = contentBounds(img);
  if (!b || b.width < 1 || b.height < 1) return null;
  if (!trim) return { canvas: flat, x: 0, y: 0 };
  const c = createCanvas(b.width, b.height);
  c.getContext('2d').drawImage(flat, -b.x, -b.y);
  return { canvas: c, x: b.x, y: b.y };
}

export function installExport(app) {
  const doc = () => app.doc;
  /** The selected layers, top first, without layers whose group is selected too (the group's file already holds them). */
  function targets(d) {
    const picked = d.selectedLayers();
    const list = picked.length ? picked : d.active ? [d.active] : [];
    const inside = (l) => {
      for (let p = l.parent; p; p = p.parent) if (list.includes(p)) return true;
      return false;
    };
    return list.filter((l) => l.type !== 'adjustment' && !inside(l));
  }

  async function exists(path) {
    try {
      return !!(await bridge.pathInfo(path));
    } catch {
      return false;
    }
  }

  /** Renders and writes the layers. opts: { format, folder, overwrite, ...export options }. Returns the paths written. */
  async function writeLayers(d, layers, opts) {
    const info = SAVE_FORMATS[opts.format] ?? SAVE_FORMATS.png;
    const format = SAVE_FORMATS[opts.format] ? opts.format : 'png';
    const written = [];
    let skipped = 0;
    await app.busy(layers.length > 1 ? 'Exporting layers…' : 'Exporting layer…', async () => {
      const used = new Set();
      for (const layer of layers) {
        const r = renderLayerAlone(d, layer, { trim: opts.trim !== false });
        if (!r) {
          skipped++;
          continue;
        }
        let name = fileSafe(layer.name);
        for (let n = 2; used.has(name.toLowerCase()); n++) name = `${fileSafe(layer.name)} ${n}`;
        let path = joinPath(opts.folder, `${name}.${info.ext}`);
        // files written next to the document without asking never replace something that is already there
        if (!opts.overwrite) for (let n = 2; await exists(path); n++) path = joinPath(opts.folder, `${name} (${n}).${info.ext}`);
        used.add(name.toLowerCase());
        const { folder: _folder, overwrite: _overwrite, trim: _trim, ...exportOpts } = opts;
        const scale = Number(opts.scale) > 0 ? Number(opts.scale) : 1;
        const bytes = await exportImage(d, { ...exportOpts, format, canvas: r.canvas, width: Math.max(1, Math.round(r.canvas.width * scale)), height: Math.max(1, Math.round(r.canvas.height * scale)), scale: undefined }, d.view.compositor);
        await bridge.writeFile(path, bytes);
        written.push(path);
      }
    });
    if (!written.length) app.dialogs.toast(layers.length > 1 ? 'The selected layers are empty: nothing was exported' : 'The layer is empty: nothing was exported', { kind: 'error', timeout: 2600 });
    else {
      const what = written.length === 1 ? written[0].split(/[\\/]/).pop() : `${written.length} layers`;
      app.dialogs.toast(`Exported ${what}${skipped ? ` (${skipped} empty layer${skipped === 1 ? '' : 's'} skipped)` : ''}`, { kind: 'success', timeout: 2000 });
    }
    return written;
  }

  /** The folder files go to: an explicit one, the document's own, or one the user picks. */
  async function chooseFolder(d, { title, preferDocument }) {
    if (preferDocument && !isVirtual(d.path)) return { folder: d.path.slice(0, d.path.lastIndexOf(pathSep)) || pathSep, overwrite: false };
    const picked = await bridge.openDirectoryDialog?.({ title });
    const folder = Array.isArray(picked) ? picked[0] : picked;
    if (folder) return { folder, overwrite: true };
    // the browser build has no folders: the files are handed to the browser as downloads
    if (bridge.platform === 'browser' && !window.__pigmentTest?.silent) return { folder: 'download:', overwrite: true };
    return null;
  }

  async function quickExport(arg, ctx = null) {
    const d = doc();
    const layers = targets(d);
    if (!layers.length) return ctx?.cancel();
    try {
      // actions (lib/actions.js): a recorded { folder } writes there again without asking
      const where = arg && typeof arg === 'object' && arg.folder ? { folder: arg.folder, overwrite: true } : await chooseFolder(d, { title: 'Quick Export layers into', preferDocument: true });
      if (!where) return ctx?.cancel();
      ctx?.setReplayArg({ folder: where.folder });
      return await writeLayers(d, layers, { format: 'png', ...where });
    } catch (err) {
      app.reportError(err, 'Export failed');
      return [];
    }
  }

  async function exportAs(arg, ctx = null) {
    const d = doc();
    const layers = targets(d);
    if (!layers.length) return ctx?.cancel();
    let opts = arg && typeof arg === 'object' && arg.format ? { ...arg } : null;
    if (!opts) {
      const last = app.settings.exportDefaults ?? {};
      // the same fields as File › Export As; formats registered by other modules bring their own options
      const extraFields = Object.entries(SAVE_FORMATS).flatMap(([id, info]) => (info.options ?? []).map((f) => ({ ...f, when: (v) => v.format === id && (!f.when || f.when(v)) })));
      const values = await formDialog(app, {
        title: layers.length > 1 ? `Export ${layers.length} Layers As` : `Export "${layers[0].name}" As`,
        intro: 'Each selected layer or group is exported by itself, trimmed to its content and named after the layer.',
        fields: [
          { key: 'format', label: 'Format', type: 'select', value: SAVE_FORMATS[last.format] && !SAVE_FORMATS[last.format].layered ? last.format : 'png', options: flatFormats() },
          { key: 'quality', label: 'Quality', type: 'slider', value: Math.round((last.quality ?? 0.9) * 100), min: 1, max: 100, unit: '%', when: (v) => !!SAVE_FORMATS[v.format]?.lossy },
          ...extraFields,
          { key: 'scale', label: 'Scale', type: 'select', value: 1, options: [[0.25, '25%'], [0.5, '50%'], [1, '100%'], [2, '200%'], [3, '300%']] },
          { key: 'trim', label: 'Trim to layer content', type: 'checkbox', value: true },
          { key: 'background', label: 'Background', type: 'select', value: 'auto', options: [['auto', 'Automatic (transparent, white for JPEG)'], ['transparent', 'Transparent'], ['custom', 'Color…']] },
          { key: 'color', label: 'Background color', type: 'color', value: '#ffffff', when: (v) => v.background === 'custom' },
        ],
        okLabel: 'Choose Folder…',
      });
      if (!values) return ctx?.cancel();
      const info = SAVE_FORMATS[values.format];
      const own = Object.fromEntries((info?.options ?? []).map((f) => [f.key, values[f.key]]));
      opts = {
        format: values.format,
        quality: values.quality / 100,
        scale: Number(values.scale) || 1,
        trim: !!values.trim,
        background: values.background === 'transparent' || (values.background === 'auto' && !info?.opaque && values.format !== 'jpeg') ? null : values.background === 'auto' ? '#ffffff' : values.color,
        ...own,
      };
      app.settings.exportDefaults = { ...(app.settings.exportDefaults ?? {}), format: values.format, quality: values.quality / 100 };
      app.saveSettingsSoon();
    }
    try {
      if (!opts.folder) {
        const where = await chooseFolder(d, { title: 'Export layers into', preferDocument: false });
        if (!where) return ctx?.cancel();
        opts.folder = where.folder;
      }
      ctx?.setReplayArg({ ...opts }); // actions (lib/actions.js): format, options and folder replay the export
      return await writeLayers(d, layers, { ...opts, overwrite: true });
    } catch (err) {
      app.reportError(err, 'Export failed');
      return [];
    }
  }

  const can = () => !!doc() && targets(doc()).length > 0;
  app.commands.registerAll({
    'layer:export-quick': { enabled: can, run: quickExport, label: 'Quick Export as PNG' },
    'layer:export-as': { enabled: can, run: exportAs, label: 'Export As…', dialog: true },
  });
}
