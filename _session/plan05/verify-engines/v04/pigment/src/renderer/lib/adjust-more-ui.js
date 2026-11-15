// Renderer side of the 0.3 adjustments group (builder "adjust-more"):
//   - custom editors (app.adjustEditors) for Color Lookup, HDR Toning, Match Color and Replace Color; the
//     Image > Adjustments dialogs and the Properties panel (Color Lookup layers) build them through
//     buildAdjustmentEditor()
//   - Image > Apply Image and Calculations (src/shared/pixels/channel-math.js)
//   - Layer > Matting (matting.js), File > Export > Color Lookup Tables (lut.js) and
//     File > Automate > Merge to HDR (hdr.js exposure fusion)
// Pixel edits go through the pixel-edit sessions of adjust-ui.js, so the selection limit, previews,
// undo, Fade and the actions recorder behave like every other adjustment.
import { ADJUSTMENTS, applyAdjustment } from '../../shared/pixels/adjust.js';
import { labStatistics, replaceColorMask } from '../../shared/pixels/adjust-more.js';
import { parseLut, compactLut, resampleLut, writeCube, write3dl, isLut, LUT_PRESET_NAMES } from '../../shared/pixels/lut.js';
import { exposureFusion, estimateExposures } from '../../shared/pixels/hdr.js';
import { defringe, removeMatte, decontaminate } from '../../shared/pixels/matting.js';
import { applyImage, calculations, extractChannel } from '../../shared/pixels/channel-math.js';
import { BLEND_MODES, Document, RasterLayer, createCanvas } from './document.js';
import { buildForm, formDialog, frameThrottle } from './form.js';
import { buildAdjustmentEditor, beginPixelEdit, pixelEditDialog, processed } from './adjust-ui.js';
import { flattenDocument, flattenStored } from './compositor.js';
import { renderLayersFlat } from './layer-ops.js';
import { bridge } from './bridge.js';
import { openDocument } from './io.js';
import { Selection } from './selection.js';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const LUT_FILTERS = [{ name: 'Color lookup tables', extensions: ['cube', '3dl', 'look', 'csp'] }];
/** Loaded tables above this grid size are resampled: params travel through JSON (layers, history, .pigment). */
const MAX_STORED_LUT = 65;

// ---- small DOM helpers --------------------------------------------------------------------------------------

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A labelled row (label on the left, controls on the right). */
function row(label, ...controls) {
  const r = el('div', 'prop-row');
  r.append(el('span', '', label), ...controls);
  return r;
}

function selectEl(key, options, value) {
  const s = el('select', 'select');
  s.dataset.key = key;
  fillSelect(s, options, value);
  return s;
}

/** Replaces the options of a select ([value, label] pairs) and keeps `value` when it is still offered. */
function fillSelect(select, options, value) {
  select.replaceChildren();
  for (const [v, l] of options) select.add(new Option(l, String(v)));
  const has = options.some(([v]) => String(v) === String(value));
  select.value = String(has ? value : options[0]?.[0] ?? '');
  return select.value;
}

function checkboxEl(key, label, checked) {
  const wrap = el('label', 'checkbox');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = !!checked;
  input.dataset.key = key;
  wrap.append(input, document.createTextNode(label));
  return { wrap, input };
}

/** A block line for controls that would otherwise flow inline (checkboxes). */
function line(...nodes) {
  const d = el('div');
  d.style.margin = '4px 0';
  d.append(...nodes);
  return d;
}

function buttonEl(act, label) {
  const b = el('button', 'btn small', label);
  b.type = 'button';
  b.dataset.act = act;
  return b;
}

const imageDataOf = (canvas) => canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
const fileName = (path) => String(path ?? '').split(/[\\/]/).pop();

async function pickFile(opts) {
  const paths = await bridge.openFileDialog(opts);
  return Array.isArray(paths) ? paths[0] ?? null : paths ?? null;
}

// ---- reading documents, layers and channels -----------------------------------------------------------------

/** Layers a dialog can read pixels from (top first): everything that draws, no groups or adjustments. */
const readableLayers = (doc) => doc.layers().filter((l) => !l.isGroup && l.type !== 'adjustment' && !l.preview && !l.quickMask).reverse();

/** The pixels of one layer on a document-sized canvas: its own pixels, without its opacity, blend mode or mask. */
function layerCanvas(doc, layer) {
  if (layer.type === 'raster') {
    const c = createCanvas(doc.width, doc.height);
    c.getContext('2d').drawImage(layer.canvas, layer.x, layer.y);
    return c;
  }
  if (typeof layer.render === 'function') {
    const r = layer.render();
    if (r?.canvas) {
      const c = createCanvas(doc.width, doc.height);
      c.getContext('2d').drawImage(r.canvas, r.x ?? 0, r.y ?? 0);
      return c;
    }
  }
  return renderLayersFlat(doc, [layer]);
}

/**
 * Document-sized ImageData of 'merged' (the visible composite) or of one layer (by id). `stored` reads the
 * composite without the image mode's display pass: for pixels that go back into the same document (duotone inks
 * would otherwise be applied to them twice).
 */
function readImage(doc, layerId, { stored = false } = {}) {
  const layer = layerId && layerId !== 'merged' ? doc.find(layerId) : null;
  return imageDataOf(layer ? layerCanvas(doc, layer) : (stored ? flattenStored : flattenDocument)(doc, doc.view?.compositor));
}

/** Channels offered for a document / layer pair; `colour` adds the composite RGB entry (Apply Image). */
function channelOptions(doc, layerId, { colour = false } = {}) {
  const out = [];
  if (colour) out.push(['rgb', 'RGB']);
  out.push(['gray', 'Gray'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue'], ['a', 'Transparency']);
  const layer = layerId && layerId !== 'merged' ? doc.find(layerId) : null;
  if (layer?.mask) out.push(['mask', 'Layer Mask']);
  if (doc.selection && !doc.selection.isEmpty) out.push(['selection', 'Selection']);
  for (const c of doc.channels) out.push([`alpha:${c.id}`, c.name]);
  return out;
}

/**
 * One channel of a document / layer as a grey plane (doc.width * doc.height). `getImage(doc, layerId)`
 * supplies (and caches) the pixels for the colour channels.
 */
function readChannel(doc, layerId, channel, getImage) {
  const n = doc.width * doc.height;
  if (channel === 'selection') return doc.selection && !doc.selection.isEmpty ? new Uint8ClampedArray(doc.selection.mask) : new Uint8ClampedArray(n);
  if (typeof channel === 'string' && channel.startsWith('alpha:')) {
    const ch = doc.channels.find((c) => `alpha:${c.id}` === channel);
    return ch ? new Uint8ClampedArray(ch.mask) : new Uint8ClampedArray(n);
  }
  if (channel === 'mask') {
    const layer = doc.find(layerId);
    if (!layer?.mask) return new Uint8ClampedArray(n).fill(255);
    const c = createCanvas(doc.width, doc.height);
    c.getContext('2d').drawImage(layer.mask.canvas, 0, 0);
    return extractChannel(imageDataOf(c), 'a');
  }
  return extractChannel(getImage(doc, layerId), channel === 'rgb' ? 'gray' : channel);
}

/** The part of a document-sized RGBA image or grey plane that covers `rect` (document coordinates); outside is empty. */
function cropRgba(img, rect) {
  if (rect.x === 0 && rect.y === 0 && rect.width === img.width && rect.height === img.height) return img;
  const out = new Uint8ClampedArray(rect.width * rect.height * 4);
  const x0 = Math.max(0, rect.x), x1 = Math.min(img.width, rect.x + rect.width);
  for (let y = Math.max(0, rect.y), ye = Math.min(img.height, rect.y + rect.height); y < ye && x1 > x0; y++) {
    out.set(img.data.subarray((y * img.width + x0) * 4, (y * img.width + x1) * 4), ((y - rect.y) * rect.width + (x0 - rect.x)) * 4);
  }
  return { width: rect.width, height: rect.height, data: out };
}

function cropPlane(plane, width, height, rect) {
  if (rect.x === 0 && rect.y === 0 && rect.width === width && rect.height === height) return plane;
  const out = new Uint8ClampedArray(rect.width * rect.height);
  const x0 = Math.max(0, rect.x), x1 = Math.min(width, rect.x + rect.width);
  for (let y = Math.max(0, rect.y), ye = Math.min(height, rect.y + rect.height); y < ye && x1 > x0; y++) {
    out.set(plane.subarray(y * width + x0, y * width + x1), (y - rect.y) * rect.width + (x0 - rect.x));
  }
  return out;
}

/** A grey plane as an opaque RGBA image (the form applyImage takes for single-channel sources). */
function planeImage(plane, width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0, i = 0; p < plane.length; p++, i += 4) {
    data[i] = data[i + 1] = data[i + 2] = plane[p];
    data[i + 3] = 255;
  }
  return { width, height, data };
}

const BLEND_OPTIONS = [...BLEND_MODES.filter(Boolean).map(([v, l]) => [v, l]), ['add', 'Add']];
const usesScale = (blend) => blend === 'add' || blend === 'subtract';

// ---- Color Lookup editor --------------------------------------------------------------------------------------

function colorLookupEditor(app) {
  return (kind, params, onChange) => {
    const p = { preset: params?.preset ?? 'none', lut: isLut(params?.lut) ? params.lut : null, dither: !!params?.dither };
    const root = el('div', 'color-lookup-editor');
    const select = el('select', 'select');
    select.dataset.key = 'preset';
    const info = el('p', 'muted');
    info.style.margin = '2px 0 6px';
    info.dataset.role = 'lut-info';
    const describe = () => {
      if (p.lut) info.textContent = `${p.lut.title || 'Loaded table'}: ${p.lut.type === '3d' ? `3D, ${p.lut.size} grid points` : `1D, ${p.lut.size} steps`}`;
      else info.textContent = p.preset && p.preset !== 'none' ? 'Built-in preset (an approximation generated in Pigment)' : 'No lookup: the image is unchanged';
    };
    const fill = () => {
      const options = [['none', 'None']];
      if (p.lut) options.push(['__custom', `File: ${p.lut.title || 'loaded table'}`]);
      for (const name of LUT_PRESET_NAMES) options.push([name, name]);
      fillSelect(select, options, p.lut ? '__custom' : p.preset);
      describe();
    };
    const emit = () => onChange({ preset: p.preset, lut: p.lut, dither: p.dither });
    select.addEventListener('change', () => {
      if (select.value === '__custom') return;
      p.preset = select.value;
      p.lut = null; // a preset replaces the loaded table
      fill();
      emit();
    });
    const load = buttonEl('load-lut', 'Load 3D LUT…');
    load.title = 'Load a .cube, .3dl, .look or .csp lookup table';
    load.addEventListener('click', async () => {
      try {
        const path = await pickFile({ title: 'Load 3D LUT', filters: LUT_FILTERS });
        if (!path) return;
        const bytes = await bridge.readFile(path);
        let lut = parseLut(bytes, fileName(path));
        if (lut.type === '3d' && lut.size > MAX_STORED_LUT) lut = { ...resampleLut(lut, MAX_STORED_LUT), title: lut.title };
        p.lut = compactLut(lut);
        p.preset = 'none';
        fill();
        emit();
      } catch (err) {
        app.reportError(err, 'Could not load the lookup table');
      }
    });
    const dither = checkboxEl('dither', 'Dither', p.dither);
    dither.wrap.title = 'Adds a little noise before rounding to hide banding in smooth gradients';
    dither.input.addEventListener('change', () => {
      p.dither = dither.input.checked;
      emit();
    });
    root.append(row('3DLUT', select), info, row('', load), line(dither.wrap));
    fill();
    return { element: root };
  };
}

// ---- HDR Toning editor ----------------------------------------------------------------------------------------

const HDR_METHOD_OPTIONS = [['local-adaptation', 'Local Adaptation'], ['equalize-histogram', 'Equalize Histogram'], ['exposure-gamma', 'Exposure and Gamma'], ['highlight-compression', 'Highlight Compression']];
const isIdentityCurve = (pts) => !Array.isArray(pts) || pts.length < 2 || (pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 255 && pts[1][1] === 255);

function hdrToningEditor(kind, params, onChange, { app = null } = {}) {
  const defaults = ADJUSTMENTS['hdr-toning'].defaults;
  let curve = isIdentityCurve(params?.curve) ? null : clone(params.curve);
  let curveEd = null;
  const local = (v) => v.method === 'local-adaptation';
  const S = (key, label, min, max, step, extra = {}) => ({ key, label, type: 'slider', min, max, step, ...extra });
  let form = null;
  const emit = () => {
    const v = form.values;
    onChange({ method: v.method, radius: v.radius, strength: v.strength, gamma: v.gamma, exposure: v.exposure, detail: v.detail, shadow: v.shadow, highlight: v.highlight, vibrance: v.vibrance, saturation: v.saturation, curve: curve ? clone(curve) : null });
  };
  const fields = [
    { key: 'method', label: 'Method', type: 'select', options: HDR_METHOD_OPTIONS, span: true },
    { type: 'section', label: 'Edge glow', when: local },
    S('radius', 'Radius', 1, 500, 1, { unit: 'px', when: local }),
    S('strength', 'Strength', 0, 100, 1, { when: local }),
    { type: 'section', label: 'Tone and detail', when: (v) => v.method !== 'equalize-histogram' },
    S('gamma', 'Gamma', 0.1, 10, 0.01, { when: (v) => local(v) || v.method === 'exposure-gamma' }),
    S('exposure', 'Exposure', -20, 20, 0.05, { when: (v) => v.method !== 'equalize-histogram' }),
    S('detail', 'Detail', -300, 300, 1, { unit: '%', when: local }),
    { type: 'section', label: 'Advanced', when: local },
    S('shadow', 'Shadow', -100, 100, 1, { unit: '%', when: local }),
    S('highlight', 'Highlight', -100, 100, 1, { unit: '%', when: local }),
    S('vibrance', 'Vibrance', -100, 100, 1, { unit: '%', when: local }),
    S('saturation', 'Saturation', -100, 100, 1, { unit: '%', when: local }),
    { type: 'section', label: 'Toning curve', when: local },
    {
      type: 'custom',
      when: local,
      render: () => {
        const ed = buildAdjustmentEditor('curves', { rgb: curve ?? [[0, 0], [255, 255]] }, (c) => {
          curve = isIdentityCurve(c.rgb) ? null : c.rgb;
          emit();
        }, { app });
        curveEd = ed;
        // one curve for all channels: the channel chooser of the Curves editor does not apply here
        const top = ed.element.querySelector('.prop-row');
        const channel = top?.querySelector('select');
        if (channel) channel.hidden = true;
        const label = top?.querySelector('span');
        if (label) label.textContent = 'Curve';
        ed.element.dataset.role = 'hdr-curve';
        // the dialog is already tall: a smaller curve box (the editor maps pointer positions by its on-screen size)
        const box = ed.element.querySelector('canvas.curve-editor');
        if (box) box.style.cssText = 'width:176px;height:176px';
        return ed.element;
      },
    },
    { type: 'custom', when: (v) => v.method === 'equalize-histogram', render: () => el('p', 'muted', 'Spreads the luminance histogram evenly. This method has no settings.') },
  ];
  const values = {};
  for (const f of fields) if (f.key) values[f.key] = params?.[f.key] ?? defaults[f.key];
  form = buildForm(fields, { values, onChange: emit });
  return {
    element: form.element,
    form,
    // presets (adjust-color: the frame's preset menu) and Reset update the dialog in place
    setParams(next) {
      const p = { ...defaults, ...(next ?? {}) };
      for (const f of fields) if (f.key) form.set(f.key, p[f.key], { silent: true });
      curve = isIdentityCurve(p.curve) ? null : clone(p.curve);
      curveEd?.setParams?.({ rgb: curve ?? [[0, 0], [255, 255]] });
    },
  };
}

// ---- Match Color editor ---------------------------------------------------------------------------------------

const validStats = (s) => !!s && Array.isArray(s.mean) && Array.isArray(s.std) && s.mean.length === 3 && s.std.length === 3 && [...s.mean, ...s.std].every((v) => typeof v === 'number' && Number.isFinite(v));
const roundStats = (s) => (s ? { mean: s.mean.map((v) => Math.round(v * 1000) / 1000), std: s.std.map((v) => Math.round(v * 1000) / 1000) } : null);

function matchColorEditor(app) {
  return (kind, params, onChange) => {
    const target = app.doc;
    const layer = target?.active ?? null;
    const p = {
      luminance: params?.luminance ?? 100,
      colorIntensity: params?.colorIntensity ?? 100,
      fade: params?.fade ?? 0,
      neutralize: !!params?.neutralize,
    };
    // Snapshots taken before the dialog previews anything on the layer: the target's own pixels (its statistics
    // with and without the selection) and this document's composite (so "Merged" of the same document is the
    // original, not the preview).
    const targetSel = target?.selection && !target.selection.isEmpty ? target.selection : null;
    let layerShot = null, mergedShot = null;
    if (layer?.type === 'raster' && !app.ui.editingMask) layerShot = imageDataOf(layerCanvas(target, layer));
    if (target) {
      try {
        mergedShot = imageDataOf(flattenDocument(target, target.view?.compositor));
      } catch {
        mergedShot = null;
      }
    }
    const targetStats = { sel: null, all: null };
    if (targetSel && layerShot) {
      targetStats.sel = roundStats(labStatistics(layerShot, null, targetSel.mask));
      targetStats.all = roundStats(labStatistics(layerShot));
    }
    let loaded = null; // statistics read from a file
    let source = null; // { mean, std } currently in use
    const state = { doc: 'none', layer: 'merged', useSourceSel: true, useTargetSel: true };

    const root = el('div', 'match-color-editor');
    const form = buildForm(
      [
        { type: 'section', label: 'Image options' },
        { key: 'luminance', label: 'Luminance', type: 'slider', min: 1, max: 200, step: 1 },
        { key: 'colorIntensity', label: 'Color intensity', type: 'slider', min: 1, max: 200, step: 1 },
        { key: 'fade', label: 'Fade', type: 'slider', min: 0, max: 100, step: 1 },
        { key: 'neutralize', label: 'Neutralize', type: 'checkbox' },
      ],
      {
        values: p,
        onChange: (v) => {
          Object.assign(p, { luminance: v.luminance, colorIntensity: v.colorIntensity, fade: v.fade, neutralize: !!v.neutralize });
          emit();
        },
      },
    );
    root.appendChild(form.element);
    const stats = el('div', 'dialog-form');
    stats.style.marginTop = '8px';
    stats.appendChild(el('div', 'section', 'Image statistics'));
    root.appendChild(stats);
    const box = el('div', 'span-all');
    stats.appendChild(box);

    const useTarget = checkboxEl('useTargetSelection', 'Use selection in target to calculate adjustment', true);
    const useSource = checkboxEl('useSourceSelection', 'Use selection in source to calculate colors', true);
    const docSelect = el('select', 'select');
    docSelect.dataset.key = 'source';
    const layerSelect = el('select', 'select');
    layerSelect.dataset.key = 'sourceLayer';
    const status = el('p', 'muted');
    status.dataset.role = 'match-status';
    status.style.margin = '4px 0';
    const loadBtn = buttonEl('load-statistics', 'Load Statistics…');
    const saveBtn = buttonEl('save-statistics', 'Save Statistics…');
    const buttons = el('div', 'prop-row');
    buttons.append(loadBtn, saveBtn);
    box.append(line(useTarget.wrap), line(useSource.wrap), row('Source', docSelect), row('Layer', layerSelect), status, buttons);

    const docs = () => app.docs.list();
    const sourceDoc = () => docs().find((d) => d.id === state.doc) ?? null;

    function fillDocs() {
      const options = [['none', 'None']];
      for (const d of docs()) options.push([d.id, d === target ? `${d.name} (this document)` : d.name]);
      if (loaded) options.push(['__loaded', `Statistics: ${loaded.name || 'loaded file'}`]);
      state.doc = fillSelect(docSelect, options, state.doc);
    }
    function fillLayers() {
      const d = sourceDoc();
      const options = d ? [['merged', 'Merged'], ...readableLayers(d).map((l) => [l.id, l.name])] : [['merged', 'Merged']];
      state.layer = fillSelect(layerSelect, options, state.layer);
      layerSelect.disabled = !d;
    }
    function refreshFlags() {
      const d = sourceDoc();
      useSource.input.disabled = !(d?.selection && !d.selection.isEmpty);
      useTarget.input.disabled = !targetSel || !layerShot;
      saveBtn.disabled = !source;
    }

    /** Statistics of the chosen source document / layer (null for None). */
    function computeSource() {
      if (state.doc === '__loaded') return loaded ? { mean: loaded.mean, std: loaded.std } : null;
      const d = sourceDoc();
      if (!d) return null;
      let img;
      if (d === target && state.layer === 'merged' && mergedShot) img = mergedShot;
      else if (d === target && layer && state.layer === layer.id && layerShot) img = layerShot;
      else img = readImage(d, state.layer);
      const mask = state.useSourceSel && d.selection && !d.selection.isEmpty ? d.selection.mask : null;
      return roundStats(labStatistics(img, null, mask));
    }

    function emit() {
      const out = { luminance: p.luminance, colorIntensity: p.colorIntensity, fade: p.fade, neutralize: p.neutralize, source: source ? clone(source) : null };
      // with a selection the target statistics are explicit: the selected pixels, or the whole layer when the box is off
      if (targetSel && layerShot) {
        const t = state.useTargetSel ? targetStats.sel : targetStats.all;
        if (t) out.target = clone(t);
      }
      onChange(out);
    }
    function update() {
      try {
        source = computeSource();
      } catch (err) {
        source = null;
        app.reportError(err, 'Could not read the source');
      }
      const f = (v) => v.toFixed(1);
      status.textContent = source ? `Source statistics: L ${f(source.mean[0])} ± ${f(source.std[0])}, a ${f(source.mean[1])} ± ${f(source.std[1])}, b ${f(source.mean[2])} ± ${f(source.std[2])}` : 'No source: only the image options apply';
      refreshFlags();
      emit();
    }

    docSelect.addEventListener('change', () => {
      state.doc = docSelect.value;
      state.layer = 'merged';
      fillLayers();
      update();
    });
    layerSelect.addEventListener('change', () => {
      state.layer = layerSelect.value;
      update();
    });
    useSource.input.addEventListener('change', () => {
      state.useSourceSel = useSource.input.checked;
      update();
    });
    useTarget.input.addEventListener('change', () => {
      state.useTargetSel = useTarget.input.checked;
      emit();
    });
    saveBtn.addEventListener('click', async () => {
      if (!source) return;
      try {
        const d = sourceDoc();
        const path = await bridge.saveFileDialog({ title: 'Save Statistics', defaultPath: `${d?.name ?? loaded?.name ?? 'match-color'} statistics.json`, filters: [{ name: 'Match Color statistics', extensions: ['json'] }] });
        if (!path) return;
        const body = { format: 'pigment-match-color-statistics', version: 1, name: d?.name ?? loaded?.name ?? '', mean: source.mean, std: source.std };
        await bridge.writeFile(path, new TextEncoder().encode(JSON.stringify(body, null, 2)));
        app.dialogs.toast('Statistics saved');
      } catch (err) {
        app.reportError(err, 'Could not save the statistics');
      }
    });
    loadBtn.addEventListener('click', async () => {
      try {
        const path = await pickFile({ title: 'Load Statistics', filters: [{ name: 'Match Color statistics', extensions: ['json'] }] });
        if (!path) return;
        const data = JSON.parse(new TextDecoder().decode(await bridge.readFile(path)));
        if (!validStats(data)) throw new Error('The file holds no Match Color statistics');
        loaded = { name: data.name || fileName(path).replace(/\.[^.]+$/, ''), mean: data.mean.slice(0, 3), std: data.std.slice(0, 3) };
        state.doc = '__loaded';
        fillDocs();
        fillLayers();
        update();
      } catch (err) {
        app.reportError(err, 'Could not load the statistics');
      }
    });

    fillDocs();
    fillLayers();
    refreshFlags();
    // every dialog starts without a source (the remembered sliders are kept): emit once so stale statistics from
    // the last use never reach the preview
    update();
    return { element: root };
  };
}

// ---- Replace Color editor -------------------------------------------------------------------------------------

const PREVIEW_MAX = 280;
const hex = (c) => '#' + [c[0], c[1], c[2]].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

function replaceColorEditor(app) {
  return (kind, params, onChange, { source = null } = {}) => {
    const defaults = ADJUSTMENTS['replace-color'].defaults;
    const list = (v) => (Array.isArray(v) ? v.filter((c) => Array.isArray(c) && c.length >= 3).map((c) => [+c[0], +c[1], +c[2]]) : []);
    const p = {
      colors: list(params?.colors),
      exclude: list(params?.exclude),
      fuzziness: params?.fuzziness ?? defaults.fuzziness,
      localized: !!params?.localized,
      positions: [], // sampled positions belong to the image they were clicked in
      range: params?.range ?? 50,
      hue: params?.hue ?? 0,
      saturation: params?.saturation ?? 0,
      lightness: params?.lightness ?? 0,
    };
    let tool = 'sample', view = 'selection';
    const root = el('div', 'replace-color-editor');

    // preview of the session base (downscaled); clicks sample the full-resolution pixels
    const scale = source ? Math.min(1, PREVIEW_MAX / Math.max(source.width, source.height)) : 1;
    const pw = source ? Math.max(1, Math.round(source.width * scale)) : PREVIEW_MAX, ph = source ? Math.max(1, Math.round(source.height * scale)) : 120;
    const canvas = el('canvas');
    canvas.width = pw;
    canvas.height = ph;
    canvas.dataset.role = 'replace-preview';
    canvas.style.cssText = 'display:block;margin:0 auto 6px;max-width:100%;border:1px solid var(--border);cursor:crosshair;background:repeating-conic-gradient(#cccccc 0% 25%, #ffffff 0% 50%) 50% / 12px 12px';
    let small = null;
    if (source) {
      const full = createCanvas(source.width, source.height);
      full.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(source.data), source.width, source.height), 0, 0);
      const sc = createCanvas(pw, ph);
      sc.getContext('2d').drawImage(full, 0, 0, pw, ph);
      small = imageDataOf(sc);
    }

    const tools = el('div', 'opt-segment');
    tools.setAttribute('role', 'radiogroup');
    const toolButtons = {};
    for (const [id, label, title] of [['sample', 'Sample', 'Eyedropper: click the preview to pick the colour to replace'], ['add', 'Add +', 'Add to sample (Shift-click)'], ['subtract', 'Subtract −', 'Subtract from sample (Alt-click)']]) {
      const b = el('button', 'seg-button', label);
      b.type = 'button';
      b.title = title;
      b.dataset.tool = id;
      b.addEventListener('click', () => {
        tool = id;
        syncTools();
      });
      toolButtons[id] = b;
      tools.appendChild(b);
    }
    const syncTools = () => {
      for (const [id, b] of Object.entries(toolButtons)) b.setAttribute('aria-pressed', String(id === tool));
    };
    const views = selectEl('view', [['selection', 'Selection'], ['image', 'Image']], view);
    views.style.cssText = 'flex:0 0 120px;width:120px;margin-left:auto';
    tools.style.flex = 'none';
    views.title = 'Show the selection mask or the image in the preview';
    const top = el('div', 'prop-row');
    top.append(tools, views);

    const colorSwatch = el('span'), resultSwatch = el('span');
    for (const s of [colorSwatch, resultSwatch]) s.style.cssText = 'display:inline-block;width:44px;height:22px;border:1px solid var(--border);border-radius:4px;vertical-align:middle';
    colorSwatch.dataset.role = 'replace-color';
    resultSwatch.dataset.role = 'replace-result';
    const swatches = el('div', 'prop-row');
    swatches.append(el('span', '', 'Color'), colorSwatch, el('span', 'muted', '→ Result'), resultSwatch);

    const S = (key, label, min, max, extra = {}) => ({ key, label, type: 'slider', min, max, step: 1, ...extra });
    const form = buildForm(
      [
        S('fuzziness', 'Fuzziness', 0, 200),
        { key: 'localized', label: 'Localized color clusters', type: 'checkbox' },
        S('range', 'Range', 1, 100, { unit: '%', when: (v) => !!v.localized }),
        { type: 'section', label: 'Replacement' },
        S('hue', 'Hue', -180, 180),
        S('saturation', 'Saturation', -100, 100),
        S('lightness', 'Lightness', -100, 100),
      ],
      {
        values: p,
        onChange: (v) => {
          Object.assign(p, { fuzziness: v.fuzziness, localized: !!v.localized, range: v.range, hue: v.hue, saturation: v.saturation, lightness: v.lightness });
          changed();
        },
      },
    );
    root.append(top, canvas, swatches, form.element);

    const current = () => ({ colors: clone(p.colors), exclude: clone(p.exclude), fuzziness: p.fuzziness, localized: p.localized, positions: clone(p.positions), positionsSize: source ? [source.width, source.height] : null, range: p.range, hue: p.hue, saturation: p.saturation, lightness: p.lightness });

    const draw = frameThrottle(() => {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, pw, ph);
      if (!small) return;
      if (view === 'image') {
        ctx.putImageData(new ImageData(new Uint8ClampedArray(small.data), pw, ph), 0, 0);
        return;
      }
      const mask = replaceColorMask(small, current()); // positionsSize scales the sampled positions to the reduced preview
      const out = new ImageData(pw, ph);
      for (let q = 0, i = 0; q < mask.length; q++, i += 4) {
        out.data[i] = out.data[i + 1] = out.data[i + 2] = mask[q];
        out.data[i + 3] = 255;
      }
      ctx.putImageData(out, 0, 0);
    });
    function swatch() {
      const c = p.colors[p.colors.length - 1] ?? null;
      colorSwatch.style.background = c ? hex(c) : 'transparent';
      colorSwatch.dataset.color = c ? hex(c) : '';
      if (!c) {
        resultSwatch.style.background = 'transparent';
        resultSwatch.dataset.color = '';
        return;
      }
      const one = { width: 1, height: 1, data: new Uint8ClampedArray([c[0], c[1], c[2], 255]) };
      applyAdjustment(one, 'hue-saturation', { hue: p.hue, saturation: p.saturation, lightness: p.lightness });
      resultSwatch.style.background = hex(one.data);
      resultSwatch.dataset.color = hex(one.data);
    }
    function changed() {
      swatch();
      draw();
      onChange(current());
    }

    canvas.addEventListener('pointerdown', (e) => {
      if (!source) return;
      const r = canvas.getBoundingClientRect();
      const x = Math.max(0, Math.min(source.width - 1, Math.floor(((e.clientX - r.left) / r.width) * source.width)));
      const y = Math.max(0, Math.min(source.height - 1, Math.floor(((e.clientY - r.top) / r.height) * source.height)));
      const i = (y * source.width + x) * 4;
      if (source.data[i + 3] === 0) return; // nothing to sample on transparency
      const c = [source.data[i], source.data[i + 1], source.data[i + 2]];
      const same = (a) => a[0] === c[0] && a[1] === c[1] && a[2] === c[2];
      const mode = e.altKey ? 'subtract' : e.shiftKey ? 'add' : tool;
      if (mode === 'subtract') {
        p.colors = p.colors.filter((a) => !same(a));
        if (!p.exclude.some(same)) p.exclude.push(c);
      } else {
        if (mode === 'sample') {
          p.colors = [];
          p.exclude = [];
          p.positions = [];
        }
        p.exclude = p.exclude.filter((a) => !same(a));
        if (!p.colors.some(same)) p.colors.push(c);
        p.positions.push([x, y]);
      }
      e.preventDefault();
      changed();
    });
    views.addEventListener('change', () => {
      view = views.value;
      draw();
    });
    syncTools();
    swatch();
    draw();
    return { element: root };
  };
}

/**
 * HDR Toning's prepare hook (I.2; adjust-color moved it here from 0.3's command wrapper, rule 3): a layered document is
 * flattened first, after a confirmation, or silently when an action replays the step with its settings.
 */
async function hdrPrepare(app, arg) {
  const d = app.doc;
  const layered = d && (d.root.children.length !== 1 || d.root.children[0].type !== 'raster');
  if (!layered) return true;
  const replay = !!arg && typeof arg === 'object';
  const ok = replay || (await app.dialogs.confirm('HDR Toning works on a flattened image. Flatten the document?', { title: 'HDR Toning', detail: 'All layers are merged into one. You can undo this.', okLabel: 'Flatten' }));
  if (!ok) return false;
  await app.commands.run('image:flatten', undefined, 'api');
  return true;
}

// ---- install ------------------------------------------------------------------------------------------------

export function install(app) {
  const hasDoc = () => !!app.doc;
  const settingsOf = (key) => (app.settings[key] && typeof app.settings[key] === 'object' ? app.settings[key] : (app.settings[key] = {}));

  if (app.adjustEditors?.register) {
    app.adjustEditors.register('color-lookup', { editor: colorLookupEditor(app), width: 420 });
    // HDR Toning works on the flattened image (as in Photoshop): its prepare hook (I.2) flattens a layered document
    // first, after a confirmation (silently when an action replays it); false cancels the command
    app.adjustEditors.register('hdr-toning', { editor: hdrToningEditor, width: 480, prepare: hdrPrepare });
    app.adjustEditors.register('match-color', { editor: matchColorEditor(app), width: 460 });
    app.adjustEditors.register('replace-color', {
      editor: replaceColorEditor(app),
      width: 440,
      // like Photoshop, the first use starts from the foreground colour
      start: () => {
        const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(app.settings.foreground ?? '');
        return { ...clone(ADJUSTMENTS['replace-color'].defaults), colors: m ? [[parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]] : [] };
      },
    });
  }

  // The adjustment dialogs remember their last parameters in the settings. A loaded lookup table (hundreds of
  // kilobytes of numbers) and statistics of another image do not belong there: keep the small values only.
  app.on('command:done', ({ id }) => {
    const last = app.settings.adjustLast;
    if (!last) return;
    if (id === 'image:adjust-color-lookup' && last['color-lookup']?.lut) last['color-lookup'] = { ...last['color-lookup'], lut: null };
    if (id === 'image:adjust-match-color' && last['match-color'] && (last['match-color'].source || last['match-color'].target)) {
      const { target, ...rest } = last['match-color'];
      void target;
      last['match-color'] = { ...rest, source: null };
    }
  });

  // ---- Apply Image ------------------------------------------------------------------------------------------

  const sameSizeDocs = (d) => app.docs.list().filter((o) => o.width === d.width && o.height === d.height);
  const docByRef = (ref, fallback) => (ref && ref !== 'current' ? app.docs.list().find((o) => o.id === ref) : null) ?? fallback;

  /** Resolves the sources named by Apply Image parameters to pixels of the session region (cached per choice). */
  function applyImageRunner(target, session) {
    const images = new Map(), planes = new Map();
    const getImage = (doc, layerId) => {
      const key = `${doc.id}|${layerId}`;
      if (!images.has(key)) {
        // reading this document while the preview is on the layer would feed the preview back in
        if (doc === target) session.restore?.();
        images.set(key, readImage(doc, layerId, { stored: doc === target }));
      }
      return images.get(key);
    };
    const getPlane = (doc, layerId, channel) => {
      const key = `${doc.id}|${layerId}|${channel}`;
      if (!planes.has(key)) {
        if (doc === target) session.restore?.();
        planes.set(key, cropPlane(readChannel(doc, layerId, channel, getImage), doc.width, doc.height, session.rect));
      }
      return planes.get(key);
    };
    const crops = new Map();
    return (img, p) => {
      const doc = docByRef(p.source, target);
      const layerId = p.layer && p.layer !== 'merged' && doc.find(p.layer) ? p.layer : 'merged';
      let source, channel = p.channel ?? 'rgb';
      if (channel === 'rgb') {
        const key = `${doc.id}|${layerId}`;
        if (!crops.has(key)) crops.set(key, cropRgba(getImage(doc, layerId), session.rect));
        source = crops.get(key);
      } else {
        source = planeImage(getPlane(doc, layerId, channel), img.width, img.height);
        channel = 'r';
      }
      let mask = null;
      if (p.mask) {
        const md = docByRef(p.mask.source, target);
        const ml = p.mask.layer && p.mask.layer !== 'merged' && md.find(p.mask.layer) ? p.mask.layer : 'merged';
        mask = { data: getPlane(md, ml, p.mask.channel ?? 'gray'), invert: !!p.mask.invert };
      }
      applyImage(img, source, { channel, invert: !!p.invert, blend: p.blend ?? 'multiply', opacity: p.opacity ?? 100, preserveTransparency: !!p.preserveTransparency, scale: p.scale ?? 1, offset: p.offset ?? 0, mask });
    };
  }

  const APPLY_DEFAULTS = { source: 'current', layer: 'merged', channel: 'rgb', invert: false, blend: 'multiply', opacity: 100, preserveTransparency: false, scale: 1, offset: 0, mask: null };

  /** The rows that pick a document, a layer and a channel (shared by Apply Image and Calculations). */
  function sourcePicker(target, value, { prefix, colour = false, onChange }) {
    const state = { source: value.source ?? 'current', layer: value.layer ?? 'merged', channel: value.channel ?? (colour ? 'rgb' : 'gray'), invert: !!value.invert };
    const docSel = el('select', 'select'), layerSel = el('select', 'select'), chanSel = el('select', 'select');
    docSel.dataset.key = `${prefix}.source`;
    layerSel.dataset.key = `${prefix}.layer`;
    chanSel.dataset.key = `${prefix}.channel`;
    const inv = checkboxEl(`${prefix}.invert`, 'Invert', state.invert);
    const doc = () => docByRef(state.source, target);
    const fill = () => {
      const docs = sameSizeDocs(target);
      state.source = fillSelect(docSel, docs.map((d) => [d === target ? 'current' : d.id, d === target ? `${d.name} (this document)` : d.name]), state.source);
      state.layer = fillSelect(layerSel, [['merged', 'Merged'], ...readableLayers(doc()).map((l) => [l.id, l.name])], state.layer);
      state.channel = fillSelect(chanSel, channelOptions(doc(), state.layer, { colour }), state.channel);
    };
    const fire = () => onChange({ ...state });
    docSel.addEventListener('change', () => {
      state.source = docSel.value;
      state.layer = 'merged';
      fill();
      fire();
    });
    layerSel.addEventListener('change', () => {
      state.layer = layerSel.value;
      fill();
      fire();
    });
    chanSel.addEventListener('change', () => {
      state.channel = chanSel.value;
      fire();
    });
    inv.input.addEventListener('change', () => {
      state.invert = inv.input.checked;
      fire();
    });
    fill();
    const channelRow = row('Channel', chanSel, inv.wrap);
    return { rows: [row('Source', docSel), row('Layer', layerSel), channelRow], state };
  }

  /** Blending rows: mode, opacity and (Add / Subtract) scale and offset. */
  function blendRows(value, onChange) {
    const state = { blend: value.blend ?? 'multiply', opacity: value.opacity ?? 100, scale: value.scale ?? 1, offset: value.offset ?? 0 };
    const form = buildForm(
      [
        { key: 'blend', label: 'Blending', type: 'select', options: BLEND_OPTIONS },
        { key: 'opacity', label: 'Opacity', type: 'slider', min: 0, max: 100, step: 1, unit: '%' },
        { key: 'scale', label: 'Scale', type: 'number', min: 1, max: 2, step: 0.001, when: (v) => usesScale(v.blend) },
        { key: 'offset', label: 'Offset', type: 'number', min: -255, max: 255, step: 1, when: (v) => usesScale(v.blend) },
      ],
      {
        values: state,
        onChange: (v) => {
          Object.assign(state, { blend: v.blend, opacity: v.opacity, scale: v.scale, offset: v.offset });
          onChange({ ...state });
        },
      },
    );
    return { element: form.element, state };
  }

  async function applyImageCommand(arg, ctx) {
    const d = app.doc;
    if (!d) return ctx?.cancel();
    if (arg && typeof arg === 'object') {
      // replay (actions, scripts): no dialog
      const session = beginPixelEdit(app, { label: 'Apply Image' });
      if (!session) return ctx?.cancel();
      try {
        const run = applyImageRunner(d, session);
        const p = { ...APPLY_DEFAULTS, ...arg };
        session.commit('Apply Image', processed(session, (img) => run(img, p)), { applyImage: clone(p) });
      } catch (err) {
        session.cancel();
        app.reportError(err, 'Apply Image failed');
        ctx?.cancel();
      }
      return;
    }
    const start = { ...APPLY_DEFAULTS, ...(app.settings.applyImage && typeof app.settings.applyImage === 'object' ? app.settings.applyImage : {}), source: 'current', layer: 'merged', mask: null };
    let runner = null;
    const used = await pixelEditDialog(app, {
      title: 'Apply Image',
      params: start,
      width: 440,
      meta: (p) => ({ applyImage: clone(p) }),
      editor: (onChange, session) => {
        runner = applyImageRunner(d, session);
        const p = { ...start };
        const emit = () => onChange({ ...p, mask: p.mask ? { ...p.mask } : null });
        const root = el('div', 'apply-image-editor');
        const target = el('p', 'muted', `Target: ${d.name} (${app.ui.editingMask && d.active?.mask ? 'layer mask of ' : ''}${d.active?.name ?? 'layer'})`);
        target.style.margin = '0 0 8px';
        const src = sourcePicker(d, p, { prefix: 'src', colour: true, onChange: (s) => (Object.assign(p, { source: s.source, layer: s.layer, channel: s.channel, invert: s.invert }), emit()) });
        Object.assign(p, { source: src.state.source, layer: src.state.layer, channel: src.state.channel });
        const blend = blendRows(p, (b) => (Object.assign(p, b), emit()));
        const keep = checkboxEl('preserveTransparency', 'Preserve transparency', p.preserveTransparency);
        keep.input.addEventListener('change', () => {
          p.preserveTransparency = keep.input.checked;
          emit();
        });
        const useMask = checkboxEl('useMask', 'Mask…', false);
        const maskBox = el('div');
        maskBox.hidden = true;
        maskBox.style.cssText = 'margin:4px 0 0 18px';
        let maskState = { source: 'current', layer: 'merged', channel: 'gray', invert: false };
        const maskPick = sourcePicker(d, maskState, { prefix: 'mask', onChange: (s) => ((maskState = s), (p.mask = { ...s }), emit()) });
        maskState = { ...maskPick.state };
        maskBox.append(...maskPick.rows);
        useMask.input.addEventListener('change', () => {
          maskBox.hidden = !useMask.input.checked;
          p.mask = useMask.input.checked ? { ...maskState } : null;
          emit();
        });
        root.append(target, ...src.rows, blend.element, line(keep.wrap), line(useMask.wrap), maskBox);
        return { element: root };
      },
      run: (img, p) => runner(img, p),
    });
    if (used) {
      const { mask, ...rest } = used;
      void mask;
      app.saveSettingsSoon({ applyImage: { blend: rest.blend, opacity: rest.opacity, scale: rest.scale, offset: rest.offset, preserveTransparency: rest.preserveTransparency } });
      ctx?.setReplayArg(clone(used));
    } else ctx?.cancel();
  }

  // ---- Calculations ---------------------------------------------------------------------------------------------

  const CALC_DEFAULTS = {
    a: { source: 'current', layer: 'merged', channel: 'gray', invert: false },
    b: { source: 'current', layer: 'merged', channel: 'gray', invert: false },
    blend: 'multiply', opacity: 100, scale: 1, offset: 0, mask: null, result: 'new-channel',
  };

  function calculate(d, p, cache = { images: new Map() }) {
    const getImage = (doc, layerId) => {
      const key = `${doc.id}|${layerId}`;
      if (!cache.images.has(key)) cache.images.set(key, readImage(doc, layerId));
      return cache.images.get(key);
    };
    const plane = (s) => {
      const doc = docByRef(s?.source, d);
      const layerId = s?.layer && s.layer !== 'merged' && doc.find(s.layer) ? s.layer : 'merged';
      return { width: d.width, height: d.height, data: readChannel(doc, layerId, s?.channel ?? 'gray', getImage) };
    };
    const mask = p.mask ? { data: plane(p.mask).data, invert: !!p.mask.invert } : null;
    return calculations(plane(p.a), plane(p.b), { blend: p.blend, opacity: p.opacity, invertA: !!p.a?.invert, invertB: !!p.b?.invert, scale: p.scale, offset: p.offset, mask });
  }

  function deliverCalculation(d, mask, result) {
    if (result === 'selection') {
      app.applySelection(Selection.fromMask(d.width, d.height, mask), 'replace', 'Calculations');
      return;
    }
    if (result === 'new-document') {
      const doc = new Document({ width: d.width, height: d.height, dpi: d.dpi, name: 'Untitled (Calculations)', mode: 'grayscale' });
      const layer = new RasterLayer({ name: 'Background', width: d.width, height: d.height });
      const img = new ImageData(d.width, d.height);
      for (let q = 0, i = 0; q < mask.length; q++, i += 4) {
        img.data[i] = img.data[i + 1] = img.data[i + 2] = mask[q];
        img.data[i + 3] = 255;
      }
      layer.canvas.getContext('2d').putImageData(img, 0, 0);
      layer.parent = doc.root;
      doc.root.children.push(layer);
      doc.active = layer;
      doc.selected.add(layer);
      app.docs.add(doc);
      return;
    }
    // new alpha channel, undoable like Select > Save Selection
    const before = d.channels.slice();
    const ch = { id: `C${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: `Alpha ${d.channels.length + 1}`, mask };
    const set = (listNow) => {
      d.channels = listNow.slice();
      d.changed('channels');
      app.emit('channels:changed', d);
    };
    set([...before, ch]);
    d.history.push({ label: 'Calculations', undo: () => set(before), redo: () => set([...before, ch]), bytes: mask.length, at: Date.now() });
    d.changed('history');
  }

  async function calculationsCommand(arg, ctx) {
    const d = app.doc;
    if (!d) return ctx?.cancel();
    let p;
    if (arg && typeof arg === 'object') p = { ...CALC_DEFAULTS, ...arg, a: { ...CALC_DEFAULTS.a, ...(arg.a ?? {}) }, b: { ...CALC_DEFAULTS.b, ...(arg.b ?? {}) } };
    else {
      const saved = app.settings.calculations && typeof app.settings.calculations === 'object' ? app.settings.calculations : {};
      p = { ...clone(CALC_DEFAULTS), blend: saved.blend ?? 'multiply', opacity: saved.opacity ?? 100, scale: saved.scale ?? 1, offset: saved.offset ?? 0, result: saved.result ?? 'new-channel' };
      const cache = { images: new Map() };
      const root = el('div', 'calculations-editor');
      const scaleK = Math.min(1, 220 / Math.max(d.width, d.height));
      const preview = el('canvas');
      preview.width = Math.max(1, Math.round(d.width * scaleK));
      preview.height = Math.max(1, Math.round(d.height * scaleK));
      preview.dataset.role = 'calc-preview';
      preview.style.cssText = 'display:block;margin:0 auto 8px;border:1px solid var(--border);max-width:100%';
      const full = createCanvas(d.width, d.height);
      const draw = frameThrottle(() => {
        try {
          const mask = calculate(d, p, cache);
          const img = new ImageData(d.width, d.height);
          for (let q = 0, i = 0; q < mask.length; q++, i += 4) {
            img.data[i] = img.data[i + 1] = img.data[i + 2] = mask[q];
            img.data[i + 3] = 255;
          }
          full.getContext('2d').putImageData(img, 0, 0);
          const ctx2 = preview.getContext('2d');
          ctx2.clearRect(0, 0, preview.width, preview.height);
          ctx2.drawImage(full, 0, 0, preview.width, preview.height);
        } catch (err) {
          console.error(err);
        }
      });
      const head = (text) => {
        const h = el('div', 'section', text);
        h.style.cssText = 'font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:var(--fg-muted);border-bottom:1px solid var(--border);padding-bottom:3px;margin:8px 0 4px';
        return h;
      };
      const a = sourcePicker(d, p.a, { prefix: 'a', onChange: (s) => ((p.a = s), draw()) });
      const b = sourcePicker(d, p.b, { prefix: 'b', onChange: (s) => ((p.b = s), draw()) });
      p.a = { ...a.state };
      p.b = { ...b.state };
      const blend = blendRows(p, (v) => (Object.assign(p, v), draw()));
      const useMask = checkboxEl('useMask', 'Mask…', false);
      const maskBox = el('div');
      maskBox.hidden = true;
      maskBox.style.cssText = 'margin:4px 0 0 18px';
      let maskState = { source: 'current', layer: 'merged', channel: 'gray', invert: false };
      const maskPick = sourcePicker(d, maskState, { prefix: 'mask', onChange: (s) => ((maskState = s), (p.mask = { ...s }), draw()) });
      maskState = { ...maskPick.state };
      maskBox.append(...maskPick.rows);
      useMask.input.addEventListener('change', () => {
        maskBox.hidden = !useMask.input.checked;
        p.mask = useMask.input.checked ? { ...maskState } : null;
        draw();
      });
      const resultSel = selectEl('result', [['new-channel', 'New Channel'], ['new-document', 'New Document'], ['selection', 'Selection']], p.result);
      resultSel.addEventListener('change', () => (p.result = resultSel.value));
      root.append(preview, head('Source 1'), ...a.rows, head('Source 2'), ...b.rows, head('Blending'), blend.element, line(useMask.wrap), maskBox, head('Result'), row('Result', resultSel));
      const ok = await app.dialogs.open({ title: 'Calculations', content: root, width: 440, buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }], onOpen: () => draw() });
      draw.cancel();
      if (!ok) return ctx?.cancel();
      app.saveSettingsSoon({ calculations: { blend: p.blend, opacity: p.opacity, scale: p.scale, offset: p.offset, result: p.result } });
    }
    try {
      const mask = await app.busy('Calculations…', async () => calculate(d, p));
      deliverCalculation(d, mask, p.result ?? 'new-channel');
      ctx?.setReplayArg(clone(p));
    } catch (err) {
      app.reportError(err, 'Calculations failed');
      ctx?.cancel();
    }
  }

  // ---- Matting ------------------------------------------------------------------------------------------------

  const MATTING = {
    defringe: { label: 'Defringe', run: (img, o) => defringe(img, o.width ?? 1) },
    'remove-black': { label: 'Remove Black Matte', run: (img) => removeMatte(img, 'black') },
    'remove-white': { label: 'Remove White Matte', run: (img) => removeMatte(img, 'white') },
    decontaminate: { label: 'Color Decontaminate', run: (img, o) => decontaminate(img, o.amount ?? 100) },
  };

  /**
   * Defringe on a session image. A layer has no pixels beyond its canvas, so where the canvas ends inside the
   * document that end is an edge like any other: the image is padded with transparency on those sides (the
   * pixel module itself treats the image border as "more of the same").
   */
  function defringeInSession(session, img, o) {
    const d = app.doc, loc = session.local, rc = session.rect, cv = session.target.canvas;
    const pad = Math.round(o.width ?? 1) + 1;
    const left = loc.x === 0 && rc.x > 0 ? pad : 0, top = loc.y === 0 && rc.y > 0 ? pad : 0;
    const right = loc.x + loc.width === cv.width && rc.x + rc.width < d.width ? pad : 0, bottom = loc.y + loc.height === cv.height && rc.y + rc.height < d.height ? pad : 0;
    if (!left && !top && !right && !bottom) return defringe(img, o.width ?? 1);
    const big = { width: img.width + left + right, height: img.height + top + bottom, data: null };
    big.data = new Uint8ClampedArray(big.width * big.height * 4);
    for (let y = 0; y < img.height; y++) big.data.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), ((y + top) * big.width + left) * 4);
    defringe(big, o.width ?? 1);
    for (let y = 0; y < img.height; y++) img.data.set(big.data.subarray(((y + top) * big.width + left) * 4, ((y + top) * big.width + left + img.width) * 4), y * img.width * 4);
    return img;
  }

  async function mattingCommand(arg, ctx) {
    const o = arg && typeof arg === 'object' ? { ...arg } : { op: arg };
    const def = MATTING[o.op];
    if (!def) {
      ctx?.cancel();
      return app.dialogs.toast('Choose a matting command from Layer > Matting', { kind: 'error' });
    }
    if (app.ui.editingMask) {
      ctx?.cancel();
      return app.dialogs.toast('Matting works on layer pixels, not on a mask', { kind: 'error' });
    }
    const remembered = settingsOf('matting');
    if (o.op === 'defringe' && typeof o.width !== 'number') {
      const v = await formDialog(app, { title: 'Defringe', width: 320, fields: [{ key: 'width', label: 'Width', type: 'number', min: 1, max: 200, step: 1, unit: 'px', value: remembered.width ?? 1 }] });
      if (!v) return ctx?.cancel();
      o.width = Math.max(1, Math.min(200, Math.round(v.width)));
      remembered.width = o.width;
      app.saveSettingsSoon();
    }
    if (o.op === 'decontaminate' && typeof o.amount !== 'number') {
      const v = await formDialog(app, { title: 'Color Decontaminate', width: 360, fields: [{ key: 'amount', label: 'Amount', type: 'slider', min: 0, max: 100, step: 1, unit: '%', value: remembered.amount ?? 100 }] });
      if (!v) return ctx?.cancel();
      o.amount = v.amount;
      remembered.amount = o.amount;
      app.saveSettingsSoon();
    }
    // the fringe of a selection border is not the fringe of the layer: the session still limits the result to the
    // selection, but the edge is found on the layer's own transparency
    const session = beginPixelEdit(app, { label: def.label, margin: o.op === 'defringe' ? o.width + 2 : 2 });
    if (!session) return ctx?.cancel();
    try {
      const img = await app.busy(`${def.label}…`, async () => processed(session, (x) => (o.op === 'defringe' ? defringeInSession(session, x, o) : def.run(x, o))));
      session.commit(def.label, img, { matting: clone(o) });
      ctx?.setReplayArg(clone(o));
    } catch (err) {
      session.cancel();
      app.reportError(err, `${def.label} failed`);
      ctx?.cancel();
    }
  }

  // ---- Export Color Lookup Tables ---------------------------------------------------------------------------

  /** The adjustment layers a lookup export bakes, bottom to top: the stack clipped to the active layer, else every visible one. */
  function lutLayers(d) {
    const a = d.active;
    if (a && a.type !== 'adjustment' && a.parent) {
      const kids = a.parent.children, i = kids.indexOf(a);
      const clipped = [];
      for (let j = i + 1; j < kids.length && kids[j].clip; j++) if (kids[j].type === 'adjustment' && kids[j].visible) clipped.push(kids[j]);
      if (clipped.length) return clipped;
    }
    const hidden = (l) => {
      for (let q = l; q && q !== d.root; q = q.parent) if (!q.visible) return true;
      return false;
    };
    return d.layers().filter((l) => l.type === 'adjustment' && !hidden(l));
  }

  /** Pushes an N³ lattice through the layers' adjustments (opacity honoured; masks and blend modes are not colour maps). */
  function bakeLut(layers, size, title) {
    const n = size, count = n * n * n;
    const img = { width: n * n, height: n, data: new Uint8ClampedArray(count * 4) };
    const d = img.data;
    for (let b = 0, i = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++, i += 4) {
      d[i] = (r * 255) / (n - 1);
      d[i + 1] = (g * 255) / (n - 1);
      d[i + 2] = (b * 255) / (n - 1);
      d[i + 3] = 255;
    }
    for (const l of layers) {
      const opacity = Math.max(0, Math.min(1, l.opacity ?? 1));
      if (opacity <= 0 || !ADJUSTMENTS[l.kind]) continue;
      // dither is noise for pictures, not part of the colour mapping
      const params = l.kind === 'color-lookup' ? { ...l.params, dither: false } : l.params;
      if (opacity >= 1) applyAdjustment(img, l.kind, params);
      else {
        const copy = { width: img.width, height: img.height, data: new Uint8ClampedArray(d) };
        applyAdjustment(copy, l.kind, params);
        for (let i = 0; i < d.length; i += 4) {
          d[i] += (copy.data[i] - d[i]) * opacity;
          d[i + 1] += (copy.data[i + 1] - d[i + 1]) * opacity;
          d[i + 2] += (copy.data[i + 2] - d[i + 2]) * opacity;
        }
      }
    }
    const data = new Float32Array(count * 3);
    for (let p = 0, i = 0, o = 0; p < count; p++, i += 4, o += 3) {
      data[o] = d[i] / 255;
      data[o + 1] = d[i + 1] / 255;
      data[o + 2] = d[i + 2] / 255;
    }
    return { type: '3d', size: n, data, title };
  }

  async function exportLutsCommand(arg, ctx) {
    const d = app.doc;
    if (!d) return ctx?.cancel();
    const layers = lutLayers(d);
    if (!layers.length) {
      ctx?.cancel();
      return app.dialogs.toast('Color Lookup Tables are built from adjustment layers: add at least one first', { kind: 'error' });
    }
    let o = arg && typeof arg === 'object' ? { ...arg } : null;
    if (!o) {
      const saved = settingsOf('exportLuts');
      const v = await formDialog(app, {
        title: 'Export Color Lookup Tables',
        width: 420,
        intro: `Bakes ${layers.length === 1 ? `the adjustment layer "${layers[0].name}"` : `${layers.length} adjustment layers`} into a lookup table. Layer masks and blend modes are not part of a colour table and are ignored.`,
        fields: [
          { key: 'title', label: 'Description', type: 'text', value: d.name.replace(/\.[^.]+$/, ''), span: true },
          { key: 'size', label: 'Grid points', type: 'select', value: saved.size ?? 32, options: [[16, '16 (small)'], [32, '32 (medium)'], [64, '64 (high)']] },
          { type: 'section', label: 'Formats' },
          { key: 'cube', label: 'CUBE (.cube)', type: 'checkbox', value: saved.cube ?? true },
          { key: 'threedl', label: '3DL (.3dl)', type: 'checkbox', value: saved.threedl ?? true },
        ],
        validate: (x) => {
          if (x.cube || x.threedl) return true;
          app.dialogs.toast('Choose at least one format', { kind: 'error' });
          return false;
        },
      });
      if (!v) return ctx?.cancel();
      o = { title: String(v.title ?? '').trim(), size: Number(v.size) || 32, cube: !!v.cube, threedl: !!v.threedl };
      Object.assign(saved, { size: o.size, cube: o.cube, threedl: o.threedl });
      app.saveSettingsSoon();
    }
    const size = [16, 32, 64].includes(Number(o.size)) ? Number(o.size) : 32;
    const formats = [o.cube !== false ? 'cube' : null, o.threedl ? '3dl' : null].filter(Boolean);
    if (!formats.length) formats.push('cube');
    let path = typeof o.path === 'string' && o.path ? o.path : null;
    if (!path) {
      path = await bridge.saveFileDialog({ title: 'Export Color Lookup Tables', defaultPath: `${(o.title || d.name).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\.[^.]+$/, '') || 'lookup'}.${formats[0]}`, filters: [{ name: 'Color lookup tables', extensions: ['cube', '3dl'] }] });
      if (!path) return ctx?.cancel();
    }
    const base = path.replace(/\.(cube|3dl)$/i, '');
    try {
      const written = await app.busy('Exporting lookup tables…', async () => {
        const lut = bakeLut(layers, size, o.title || d.name);
        const out = [];
        for (const f of formats) {
          const text = f === 'cube' ? writeCube(lut) : write3dl(lut);
          await bridge.writeFile(`${base}.${f}`, new TextEncoder().encode(text));
          out.push(`${base}.${f}`);
        }
        return out;
      });
      app.dialogs.toast(`Exported ${written.map(fileName).join(' and ')}`);
      ctx?.setReplayArg({ title: o.title ?? '', size, cube: formats.includes('cube'), threedl: formats.includes('3dl') });
      return written;
    } catch (err) {
      app.reportError(err, 'Could not export the lookup tables');
      ctx?.cancel();
    }
  }

  // ---- Merge to HDR -------------------------------------------------------------------------------------------

  async function mergeHdrCommand(arg, ctx) {
    const open = app.docs.list();
    const canAlign = typeof app.alignBlend?.alignImages === 'function';
    let o = arg && typeof arg === 'object' ? { ...arg } : null;
    if (!o) {
      const fields = [
        { key: 'source', label: 'Use', type: 'segment', value: open.length >= 2 ? 'documents' : 'files', options: [['documents', 'Open documents'], ['files', 'Files…']], span: true },
        ...open.map((d) => ({ key: `doc:${d.id}`, label: `${d.name} (${d.width} × ${d.height})`, type: 'checkbox', value: true, span: true, when: (v) => v.source === 'documents' })),
      ];
      if (!open.length) fields.push({ type: 'custom', when: (v) => v.source === 'documents', render: () => el('p', 'muted', 'No documents are open: choose Files… to pick the exposures.') });
      if (canAlign) fields.push({ key: 'align', label: 'Attempt to automatically align source images', type: 'checkbox', value: true, span: true });
      fields.push({ key: 'removeGhosts', label: 'Remove ghosts (needs three or more exposures)', type: 'checkbox', value: false, span: true });
      const v = await formDialog(app, {
        title: 'Merge to HDR',
        width: 460,
        okLabel: 'Merge',
        intro: `Blends the best exposed parts of each frame (exposure fusion) into a new ${app.deep ? '16-bit' : '8-bit'} document and opens HDR Toning on it. This is not a 32-bit radiance map.`,
        fields,
      });
      if (!v) return ctx?.cancel();
      o = { source: v.source, align: !!v.align, removeGhosts: !!v.removeGhosts };
      if (v.source === 'documents') o.documents = open.filter((d) => v[`doc:${d.id}`]).map((d) => d.id);
    }
    try {
      let frames = []; // { name, canvas }
      if (o.source === 'files') {
        let paths = Array.isArray(o.paths) ? o.paths : null;
        if (!paths) paths = await bridge.openFileDialog({ title: 'Merge to HDR: choose the exposures', multiple: true });
        if (!Array.isArray(paths) || !paths.length) return ctx?.cancel();
        o.paths = paths;
        frames = await app.busy('Opening exposures…', async () => {
          const out = [];
          for (const path of paths) {
            const name = fileName(path);
            const doc = await openDocument(await bridge.readFile(path), { name, path });
            out.push({ name, canvas: flattenDocument(doc) });
          }
          return out;
        });
      } else {
        const ids = Array.isArray(o.documents) ? o.documents : open.map((d) => d.id);
        frames = open.filter((d) => ids.includes(d.id)).map((d) => ({ name: d.name, canvas: flattenDocument(d, d.view?.compositor) }));
      }
      if (frames.length < 2) {
        ctx?.cancel();
        return app.dialogs.toast('Merge to HDR needs at least two exposures of the same scene', { kind: 'error' });
      }
      const w = frames[0].canvas.width, h = frames[0].canvas.height;
      const resized = frames.some((f) => f.canvas.width !== w || f.canvas.height !== h);
      const result = await app.busy('Merging exposures…', async () => {
        let images = frames.map((f) => {
          if (f.canvas.width === w && f.canvas.height === h) return imageDataOf(f.canvas);
          const c = createCanvas(w, h);
          c.getContext('2d').drawImage(f.canvas, 0, 0, w, h);
          return imageDataOf(c);
        });
        if (o.align && canAlign) {
          try {
            const aligned = await app.alignBlend.alignImages(images);
            if (Array.isArray(aligned) && aligned.length === images.length && aligned.every((a) => a?.width === w && a?.height === h && a.data?.length === w * h * 4)) images = aligned;
          } catch (err) {
            console.warn('Merge to HDR: alignment failed, merging unaligned', err);
          }
        }
        const exposures = estimateExposures(images);
        // with 16 Bits/Channel support present (lib/depth.js installs app.deep) the fusion keeps its fractions
        const fused = exposureFusion(images, { removeGhosts: !!o.removeGhosts, depth: app.deep ? 16 : 8 });
        if (!(fused.data instanceof Uint16Array)) return { image: fused, deep: null, exposures };
        const proxy = new Uint8ClampedArray(fused.data.length);
        for (let i = 0; i < proxy.length; i++) proxy[i] = Math.floor((fused.data[i] + 128) / 257);
        return { image: { width: w, height: h, data: proxy }, deep: { type: 'u16', data: fused.data }, exposures };
      });
      const doc = new Document({ width: w, height: h, dpi: 72, name: 'Merged HDR', depth: result.deep ? 16 : 8 });
      const layer = new RasterLayer({ name: 'Background', width: w, height: h, deep: result.deep });
      layer.canvas.getContext('2d').putImageData(new ImageData(result.image.data, w, h), 0, 0);
      layer.parent = doc.root;
      doc.root.children.push(layer);
      doc.active = layer;
      doc.selected.add(layer);
      app.docs.add(doc);
      const ev = result.exposures.order.map((i) => `${result.exposures.ev[i] >= 0 ? '+' : ''}${result.exposures.ev[i].toFixed(1)}`).join(', ');
      app.dialogs.toast(`Merged ${frames.length} exposures (estimated EV ${ev})${resized ? '; frames of another size were scaled to the first one' : ''}`);
      ctx?.setReplayArg({ ...clone(o), toning: false });
      if (o.toning !== false) app.commands.run('image:adjust-hdr-toning', undefined, 'api');
      return doc;
    } catch (err) {
      app.reportError(err, 'Merge to HDR failed');
      ctx?.cancel();
    }
  }

  app.commands.registerAll({
    'image:apply-image': { enabled: () => !!app.doc?.active, run: applyImageCommand, label: 'Apply Image…', dialog: true },
    'image:calculations': { enabled: hasDoc, run: calculationsCommand, label: 'Calculations…', dialog: true },
    'layer:matting': { enabled: () => app.doc?.active?.type === 'raster', run: mattingCommand, label: 'Matting' },
    'file:export-luts': { enabled: hasDoc, run: exportLutsCommand, label: 'Color Lookup Tables…', dialog: true },
    'file:automate-merge-hdr': { run: mergeHdrCommand, label: 'Merge to HDR…', dialog: true },
  });
}
