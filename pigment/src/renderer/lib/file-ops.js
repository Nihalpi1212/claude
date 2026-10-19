// File › Export As, Quick Export as PNG, Export Layers to Files, Document Properties.
import { bridge, joinPath, pathSep } from './bridge.js';
import { formDialog, debounce } from './form.js';
import { exportImage, baseName, SAVE_FORMATS } from './io.js';
import { createCanvas } from './document.js';
import { renderLayersFlat } from './layer-ops.js';

const formatSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function install(app) {
  const has = () => !!app.doc;

  async function exportAs(arg) {
    const d = app.doc;
    const last = app.settings.exportDefaults ?? {};
    let opts = arg && typeof arg === 'object' && arg.path ? arg : null;
    if (!opts) {
      const sizeInfo = document.createElement('div');
      sizeInfo.className = 'muted';
      sizeInfo.textContent = 'Estimating file size…';
      let token = 0;
      const estimate = debounce(async (v) => {
        const mine = ++token;
        try {
          const bytes = await exportImage(d, toExport(v), d.view.compositor);
          if (mine === token) sizeInfo.textContent = `${Math.round(v.width)} × ${Math.round(v.height)} px — about ${formatSize(bytes.length)}`;
        } catch (err) {
          if (mine === token) sizeInfo.textContent = err.message;
        }
      }, 250);
      const toExport = (v) => ({ format: v.format, quality: v.quality / 100, width: v.width, height: v.height, background: v.background === 'transparent' || (v.background === 'auto' && v.format !== 'jpeg') ? null : v.background === 'auto' ? '#ffffff' : v.color });
      const values = await formDialog(app, {
        title: 'Export As',
        fields: [
          { key: 'format', label: 'Format', type: 'select', value: last.format ?? 'png', options: [['png', 'PNG'], ['jpeg', 'JPEG'], ['webp', 'WebP']] },
          { key: 'quality', label: 'Quality', type: 'slider', value: Math.round((last.quality ?? 0.9) * 100), min: 1, max: 100, unit: '%', when: (v) => v.format !== 'png' },
          { key: 'width', label: 'Width', type: 'number', value: d.width, min: 1, max: 30000, unit: 'px' },
          { key: 'height', label: 'Height', type: 'number', value: d.height, min: 1, max: 30000, unit: 'px' },
          { key: 'scale', label: 'Scale', type: 'select', value: 1, options: [[0.25, '25%'], [0.5, '50%'], [1, '100%'], [2, '200%'], [3, '300%']] },
          { key: 'background', label: 'Background', type: 'select', value: 'auto', options: [['auto', 'Automatic (transparent, white for JPEG)'], ['transparent', 'Transparent'], ['custom', 'Color…']] },
          { key: 'color', label: 'Background color', type: 'color', value: '#ffffff', when: (v) => v.background === 'custom' },
          { key: 'info', type: 'custom', render: () => sizeInfo },
        ],
        onOpen: (dialog, form) => estimate(form.values),
        onChange: (v, key, form) => {
          if (key === 'scale') {
            form.set('width', Math.round(d.width * v.scale), { silent: true });
            form.set('height', Math.round(d.height * v.scale), { silent: true });
          } else if (key === 'width') form.set('height', Math.max(1, Math.round((v.width * d.height) / d.width)), { silent: true });
          else if (key === 'height') form.set('width', Math.max(1, Math.round((v.height * d.width) / d.height)), { silent: true });
          estimate(v);
        },
        okLabel: 'Export…',
      });
      if (!values) return;
      const info = SAVE_FORMATS[values.format];
      const dir = d.path ? d.path.slice(0, d.path.lastIndexOf(pathSep) + 1) : '';
      const path = await bridge.saveFileDialog({ title: 'Export As', defaultPath: `${dir}${baseName(d.name)}.${info.ext}`, filters: [{ name: info.name, extensions: [info.ext] }] });
      if (!path) return;
      opts = { path, ...toExport(values) };
      app.settings.exportDefaults = { ...(app.settings.exportDefaults ?? {}), format: values.format, quality: values.quality / 100 };
      app.saveSettingsSoon();
    }
    try {
      const bytes = await app.busy('Exporting…', () => exportImage(d, opts, d.view.compositor));
      await bridge.writeFile(opts.path, bytes);
      app.dialogs.toast(`Exported ${opts.path.split(/[\\/]/).pop()}`, { kind: 'success', timeout: 1800 });
    } catch (err) {
      app.reportError(err, 'Export failed');
    }
  }

  async function quickExport() {
    const d = app.doc;
    let path;
    if (d.path) path = d.path.replace(/\.[^.\\/]+$/, '') + '.png';
    else path = await bridge.saveFileDialog({ title: 'Quick Export as PNG', defaultPath: `${baseName(d.name)}.png`, filters: [{ name: 'PNG image', extensions: ['png'] }] });
    if (!path) return;
    if (d.path && path === d.path) path = path.replace(/\.png$/i, ' copy.png');
    return exportAs({ path, format: 'png' });
  }

  async function exportLayers() {
    const d = app.doc;
    const o = await formDialog(app, {
      title: 'Export Layers to Files',
      intro: 'Each top-level layer or group is exported as its own image, named after the layer.',
      fields: [
        { key: 'format', label: 'Format', type: 'select', value: 'png', options: [['png', 'PNG'], ['jpeg', 'JPEG'], ['webp', 'WebP']] },
        { key: 'visibleOnly', label: 'Visible layers only', type: 'checkbox', value: true },
        { key: 'trim', label: 'Trim to layer content', type: 'checkbox', value: false },
        { key: 'prefix', label: 'File name prefix', type: 'text', value: `${baseName(d.name)}_` },
      ],
      okLabel: 'Choose Folder…',
    });
    if (!o) return;
    const dir = await bridge.openDirectoryDialog?.({ title: 'Export layers into' });
    const folder = Array.isArray(dir) ? dir[0] : dir;
    if (!folder) return;
    const info = SAVE_FORMATS[o.format];
    const layers = d.root.children.filter((l) => (!o.visibleOnly || l.visible) && l.type !== 'adjustment');
    let n = 0;
    await app.busy('Exporting layers…', async () => {
      const used = new Set();
      for (const layer of layers.slice().reverse()) {
        const wasVisible = layer.visible;
        layer.visible = true;
        let canvas = renderLayersFlat(d, [layer]);
        layer.visible = wasVisible;
        if (o.trim) {
          const b = layer.bounds();
          const r = b && { x: Math.max(0, b.x), y: Math.max(0, b.y), width: Math.min(d.width, b.x + b.width) - Math.max(0, b.x), height: Math.min(d.height, b.y + b.height) - Math.max(0, b.y) };
          if (r && r.width > 0 && r.height > 0) {
            const c = createCanvas(r.width, r.height);
            c.getContext('2d').drawImage(canvas, -r.x, -r.y);
            canvas = c;
          }
        }
        let name = `${o.prefix}${layer.name}`.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120) || 'layer';
        while (used.has(name.toLowerCase())) name += '_';
        used.add(name.toLowerCase());
        const bytes = await exportImage(d, { format: o.format, canvas }, d.view.compositor);
        await bridge.writeFile(joinPath(folder, `${name}.${info.ext}`), bytes);
        n++;
      }
    });
    app.dialogs.toast(`Exported ${n} layer${n === 1 ? '' : 's'}`, { kind: 'success' });
  }

  async function properties() {
    const d = app.doc;
    const layers = d.layers();
    const bytes = layers.reduce((s, l) => s + (l.canvas ? l.canvas.width * l.canvas.height * 4 : 0) + (l.mask?.canvas ? d.width * d.height * 4 : 0), 0);
    const meta = d.meta ?? {};
    const o = await formDialog(app, {
      title: 'Document Properties',
      intro: [
        `${d.width} × ${d.height} px at ${d.dpi} ppi (${((d.width / d.dpi) * 2.54).toFixed(1)} × ${((d.height / d.dpi) * 2.54).toFixed(1)} cm)`,
        `${layers.length} layer${layers.length === 1 ? '' : 's'}, about ${formatSize(bytes)} of pixels in memory`,
        d.path ? d.path : 'Not saved yet',
      ].join(' · '),
      fields: [
        { key: 'title', label: 'Title', type: 'text', value: meta.title ?? '' },
        { key: 'author', label: 'Author', type: 'text', value: meta.author ?? '' },
        { key: 'description', label: 'Description', type: 'textarea', value: meta.description ?? '' },
        { key: 'copyright', label: 'Copyright', type: 'text', value: meta.copyright ?? '' },
        { key: 'dpi', label: 'Resolution (pixels/inch)', type: 'number', value: d.dpi, min: 1, max: 10000 },
      ],
      width: 520,
    });
    if (!o) return;
    const before = { meta: { ...meta }, dpi: d.dpi };
    const after = { meta: { ...meta, title: o.title, author: o.author, description: o.description, copyright: o.copyright }, dpi: o.dpi };
    const set = (v) => {
      d.meta = { ...v.meta };
      d.dpi = v.dpi;
      d.changed('props');
    };
    set(after);
    d.history.push({ label: 'Document properties', undo: () => set(before), redo: () => set(after), bytes: 0, at: Date.now() });
    d.changed('history');
  }

  app.commands.registerAll({
    'file:export': { enabled: has, run: exportAs, label: 'Export As…' },
    'file:export-quick': { enabled: has, run: quickExport, label: 'Quick Export as PNG' },
    'file:export-layers': { enabled: has, run: exportLayers, label: 'Export Layers to Files…' },
    'file:properties': { enabled: has, run: properties, label: 'Document Properties…' },
  });
}
