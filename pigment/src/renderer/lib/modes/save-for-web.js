// File > Export > Save for Web (Legacy): a 2-up dialog showing the original next to the optimised
// file exactly as it will decode, with its size and download time, for GIF, JPEG, PNG-8, PNG-24 and
// WebP. The optimised bytes shown are the bytes Save… writes.
import { bridge } from '../bridge.js';
import { buildForm, debounce } from '../form.js';
import { createCanvas } from '../document.js';
import { exportImage, decodeImage, baseName } from '../io.js';
import { indicesToImage } from '../../../shared/pixels/quantize.js';
import { indexedFields, indexedOptions } from './dialogs.js';
import { exportCanvas, quantizeForExport, gifBytes, png8Bytes } from './formats.js';

const FORMATS = [['gif', 'GIF'], ['jpeg', 'JPEG'], ['png8', 'PNG-8'], ['png24', 'PNG-24'], ['webp', 'WebP']];
const EXT = { gif: 'gif', jpeg: 'jpg', png8: 'png', png24: 'png', webp: 'webp' };
const NAMES = Object.fromEntries(FORMATS);
const indexed = (f) => f === 'gif' || f === 'png8';
const formatSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(2)}M` : n >= 1024 ? `${(n / 1024).toFixed(n < 10240 ? 2 : 1)}K` : `${n} bytes`);
/** Download time the way the Save for Web status line gives it: whole seconds, at least 1. */
const seconds = (bytes, bitsPerSecond) => Math.max(1, Math.ceil((bytes * 8) / bitsPerSecond));

const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
};

/**
 * Encodes the document with Save for Web settings.
 * @param {{ format, width?, height?, quality?, transparency?, matte?, palette?, colors?, forced?, dither?, ditherAmount?, preserveExactColors?, custom? }} s
 * @returns {Promise<{ bytes: Uint8Array, preview: HTMLCanvasElement, palette: number[][]|null, transparentIndex: number }>}
 */
export async function encodeForWeb(app, doc, s, cache = null) {
  const width = Math.max(1, Math.round(s.width ?? doc.width)), height = Math.max(1, Math.round(s.height ?? doc.height));
  if (indexed(s.format)) {
    let img = cache?.key === `${width}x${height}` ? cache.img : null;
    if (!img) {
      const canvas = exportCanvas(doc, { width, height }, doc.view?.compositor);
      img = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height);
      if (cache) Object.assign(cache, { key: `${width}x${height}`, img });
    }
    const q = quantizeForExport(img, s, { doc, resized: true });
    const bytes = s.format === 'gif' ? gifBytes(q, width, height) : await png8Bytes(q, width, height, { dpi: doc.dpi });
    const shown = indicesToImage(q.indices, q.palette, width, height, q.transparentIndex);
    const preview = createCanvas(width, height);
    preview.getContext('2d').putImageData(new ImageData(shown.data, width, height), 0, 0);
    return { bytes, preview, palette: q.palette, transparentIndex: q.transparentIndex };
  }
  const format = s.format === 'png24' ? 'png' : s.format;
  // JPEG has no transparency; PNG-24 and WebP are matted only when transparency is switched off
  const background = format === 'jpeg' || s.transparency === false ? s.matte ?? '#ffffff' : null;
  const bytes = await exportImage(doc, { format, quality: Math.max(0.01, Math.min(1, (s.quality ?? 80) / 100)), width, height, background }, doc.view?.compositor);
  // what a browser will show: the file decoded again
  const preview = await decodeImage(bytes, `x.${EXT[s.format]}`);
  return { bytes, preview, palette: null, transparentIndex: -1 };
}

function settingsOf(app, v) {
  const s = { format: v.format, width: Math.round(v.width), height: Math.round(v.height) };
  if (indexed(v.format)) Object.assign(s, indexedOptions(app, v));
  else {
    s.quality = Math.round(v.quality);
    s.transparency = v.format === 'jpeg' ? false : !!v.transparency;
    s.matte = v.matteColor24;
  }
  return s;
}

/** file:save-for-web. arg { path, format, ... } writes without the dialog. */
export async function saveForWeb(app, arg, ctx = null) {
  const doc = app.doc;
  if (!doc) return ctx?.cancel();
  if (arg && typeof arg === 'object' && typeof arg.path === 'string' && NAMES[arg.format]) {
    try {
      const { bytes } = await app.busy('Save for Web…', () => encodeForWeb(app, doc, arg));
      await bridge.writeFile(arg.path, bytes);
      app.dialogs.toast(`Saved ${arg.path.split(/[\\/]/).pop()}`, { kind: 'success', timeout: 1600 });
      return true;
    } catch (err) {
      ctx?.cancel();
      app.reportError(err, 'Save for Web failed');
      return false;
    }
  }

  const last = app.settings.saveForWeb ?? {};
  const tableState = { custom: last.custom ?? null };
  const when = (test, f) => ({ ...f, when: (v) => test(v) && (!f.when || f.when(v)) });
  const info = { original: el('div', { class: 'sfw-info' }), optimized: el('div', { class: 'sfw-info', dataset: { role: 'optimized-info' } }) };
  const canvases = { original: el('canvas', { class: 'sfw-canvas' }), optimized: el('canvas', { class: 'sfw-canvas', dataset: { role: 'optimized' } }) };
  const table = el('div', { class: 'sfw-table', 'aria-label': 'Color table' });
  const cache = {};
  let current = null; // { bytes, settings }
  let token = 0;
  let closed = false;
  let zoom = 'fit';

  const draw = (canvas, source) => {
    canvas.width = source.width;
    canvas.height = source.height;
    canvas.getContext('2d').drawImage(source, 0, 0);
    applyZoom();
  };
  function applyZoom() {
    for (const c of Object.values(canvases)) {
      c.classList.toggle('fit', zoom === 'fit');
      c.style.width = zoom === 'fit' ? '' : `${c.width * Number(zoom)}px`;
      c.style.height = zoom === 'fit' ? '' : `${c.height * Number(zoom)}px`;
    }
  }

  const update = debounce(async (v) => {
    if (closed) return;
    const mine = ++token;
    const s = settingsOf(app, v);
    info.optimized.textContent = 'Optimizing…';
    try {
      const result = await encodeForWeb(app, doc, s, cache);
      if (mine !== token || closed) return;
      current = { bytes: result.bytes, settings: s };
      draw(canvases.optimized, result.preview);
      const n = result.bytes.length;
      const detail = indexed(s.format)
        ? `${result.palette.length - (result.transparentIndex >= 0 ? 1 : 0)} colors${result.transparentIndex >= 0 ? ' + transparency' : ''}, ${s.dither === 'none' ? 'no dither' : `${s.ditherAmount}% ${s.dither} dither`}`
        : s.format === 'png24' ? 'lossless' : `quality ${s.quality}`;
      info.optimized.replaceChildren(
        el('div', { textContent: `${NAMES[s.format]} — ${formatSize(n)}`, dataset: { role: 'optimized-size', bytes: String(n) } }),
        el('div', { textContent: `${seconds(n, 56600)} sec @ 56.6 Kbps · ${seconds(n, 2000000)} sec @ 2 Mbps (DSL)` }),
        el('div', { textContent: `${s.width} × ${s.height} px, ${detail}` }));
      table.replaceChildren(...(result.palette ?? []).map((c, i) => el('span', { class: 'sfw-swatch' + (i === result.transparentIndex ? ' transparent' : ''), title: `${i}: ${c.join(', ')}`, style: `background: rgb(${c.join(',')})` })));
      table.hidden = !result.palette;
    } catch (err) {
      if (mine !== token) return;
      current = null;
      info.optimized.textContent = err?.message ?? String(err);
    }
  }, 140);

  const ratio = doc.height / doc.width;
  const form = buildForm([
    { key: 'format', label: 'Format', type: 'select', value: NAMES[last.format] ? last.format : 'gif', options: FORMATS },
    ...indexedFields(app, { palette: 'selective', ...last }, tableState).map((f) => when((v) => indexed(v.format), f)),
    when((v) => v.format === 'jpeg' || v.format === 'webp', { key: 'quality', label: 'Quality', type: 'slider', value: Number.isFinite(last.quality) ? last.quality : 80, min: 1, max: 100, unit: '%' }),
    when((v) => v.format === 'png24' || v.format === 'webp', { key: 'transparency24', label: 'Transparency', type: 'checkbox', value: last.transparency !== false }),
    when((v) => v.format === 'jpeg' || ((v.format === 'png24' || v.format === 'webp') && !v.transparency24), { key: 'matteColor24', label: 'Matte', type: 'color', value: typeof last.matte === 'string' ? last.matte : '#ffffff' }),
    { key: 'srgb', label: 'Convert to sRGB', type: 'checkbox', value: true, help: 'Pigment documents are sRGB already: nothing is converted' },
    { type: 'section', label: 'Image Size' },
    { key: 'width', label: 'W', type: 'number', value: doc.width, min: 1, max: 30000, unit: 'px' },
    { key: 'height', label: 'H', type: 'number', value: doc.height, min: 1, max: 30000, unit: 'px' },
    { key: 'percent', label: 'Percent', type: 'number', value: 100, min: 1, max: 1000, unit: '%' },
    { type: 'section', label: 'Preview' },
    { key: 'zoom', label: 'Zoom', type: 'select', value: 'fit', options: [['fit', 'Fit'], ['1', '100%'], ['2', '200%'], ['4', '400%']] },
  ], {
    onChange: (v, key) => {
      if (key === 'percent') {
        form.set('width', Math.max(1, Math.round((doc.width * v.percent) / 100)), { silent: true });
        form.set('height', Math.max(1, Math.round((doc.height * v.percent) / 100)), { silent: true });
      } else if (key === 'width') {
        form.set('height', Math.max(1, Math.round(v.width * ratio)), { silent: true });
        form.set('percent', Math.max(1, Math.round((v.width / doc.width) * 100)), { silent: true });
      } else if (key === 'height') {
        form.set('width', Math.max(1, Math.round(v.height / ratio)), { silent: true });
        form.set('percent', Math.max(1, Math.round((v.height / doc.height) * 100)), { silent: true });
      } else if (key === 'palette') {
        if (v.palette === 'web') form.set('colors', 216, { silent: true });
        if (v.palette === 'system-mac' || v.palette === 'system-win') form.set('colors', 256, { silent: true });
      } else if (key === 'zoom') {
        zoom = v.zoom;
        return applyZoom();
      }
      if (key === 'srgb') return;
      update(normalise(form.values));
    },
  });
  // PNG-24 and WebP have their own transparency switch; the quantize fields own `transparency` for GIF and PNG-8
  const normalise = (v) => ({ ...v, transparency: indexed(v.format) ? v.transparency : v.transparency24 });

  // the original, drawn once: what the document shows now
  const original = exportCanvas(doc, {}, doc.view?.compositor);
  info.original.replaceChildren(el('div', { textContent: `Original: "${doc.name}"` }), el('div', { textContent: `${doc.width} × ${doc.height} px — ${formatSize(doc.width * doc.height * 4)} uncompressed` }));

  const panes = ['original', 'optimized'].map((id) => {
    const scroller = el('div', { class: 'sfw-scroller' }, canvases[id]);
    return { id, scroller, node: el('div', { class: 'sfw-pane', dataset: { pane: id } }, el('div', { class: 'sfw-pane-title', textContent: id === 'original' ? 'Original' : 'Optimized' }), scroller, info[id]) };
  });
  // the two views scroll together, like the 2-Up tab
  let syncing = false;
  for (const p of panes) p.scroller.addEventListener('scroll', () => {
    if (syncing) return;
    syncing = true;
    for (const o of panes) if (o !== p) {
      o.scroller.scrollLeft = p.scroller.scrollLeft;
      o.scroller.scrollTop = p.scroller.scrollTop;
    }
    syncing = false;
  });
  const content = el('div', { class: 'sfw' }, el('div', { class: 'sfw-views' }, panes.map((p) => p.node)), el('div', { class: 'sfw-side' }, form.element, table));

  let savedPath = null;
  const result = await app.dialogs.open({
    title: 'Save for Web',
    content,
    width: 980,
    className: 'save-for-web',
    buttons: [{ label: 'Cancel', value: null }, { label: 'Done', value: 'done' }, { label: 'Save…', value: 'save', primary: true }],
    onOpen: () => {
      draw(canvases.original, original);
      update.flush(normalise(form.values));
    },
    validate: async (value) => {
      if (value !== 'save') return true;
      // Save writes what the preview shows: wait for a pending optimisation
      const wanted = JSON.stringify(settingsOf(app, normalise(form.values)));
      if (!current || JSON.stringify(current.settings) !== wanted) {
        try {
          const s = settingsOf(app, normalise(form.values));
          token++;
          const r = await app.busy('Optimizing…', () => encodeForWeb(app, doc, s, cache));
          current = { bytes: r.bytes, settings: s };
        } catch (err) {
          app.reportError(err, 'Save for Web failed');
          return false;
        }
      }
      const ext = EXT[current.settings.format];
      const dir = doc.path && !/^(browser|download):/.test(doc.path) ? doc.path.replace(/[^\\/]+$/, '') : '';
      const path = await bridge.saveFileDialog({ title: 'Save Optimized As', defaultPath: `${dir}${baseName(doc.name)}.${ext}`, filters: [{ name: `${NAMES[current.settings.format]} image`, extensions: [ext] }] });
      if (!path) return false;
      try {
        await bridge.writeFile(path, current.bytes);
        savedPath = path;
        return true;
      } catch (err) {
        app.reportError(err, 'Could not save');
        return false;
      }
    },
  });
  closed = true;
  if (!result) return ctx?.cancel();
  // Done and Save both remember the settings (not the size: that belongs to this document)
  const s = settingsOf(app, normalise(form.values));
  const remembered = { ...s };
  delete remembered.width;
  delete remembered.height;
  app.settings.saveForWeb = remembered;
  app.saveSettingsSoon();
  if (result !== 'save' || !savedPath) return ctx?.cancel();
  app.dialogs.toast(`Saved ${savedPath.split(/[\\/]/).pop()} (${formatSize(current.bytes.length)})`, { kind: 'success', timeout: 2200 });
  ctx?.setReplayArg({ path: savedPath, ...current.settings });
  return true;
}
