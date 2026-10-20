// Shared dialogs installed last: New Document (app.newDocumentDialog), the colour picker
// (app.pickColor) and Preferences (app.preferencesDialog).
import { icon } from './icons.js';
import { bridge } from './bridge.js';
import { formDialog } from './form.js';
import { createColorWidget, normHex } from './panels/color.js';
import { parseColor, rgbaToHex, rgbToLab, labToRgb, rgbToCmyk, cmykToRgb } from '../../shared/pixels/color.js';
import { DEFAULT_SETTINGS, DEFAULT_SWATCHES } from '../../shared/defaults.js';

const MAX_SIDE = 30000;
const MAX_AREA = 250e6;

// ---- New Document -------------------------------------------------------------------------------------------
export const DOC_PRESETS = [
  { id: 'default', label: 'Default — 1920 × 1080 px', width: 1920, height: 1080, dpi: 72, unit: 'px' },
  { id: 'hd', label: 'HD — 1280 × 720 px', width: 1280, height: 720, dpi: 72, unit: 'px' },
  { id: '4k', label: '4K UHD — 3840 × 2160 px', width: 3840, height: 2160, dpi: 72, unit: 'px' },
  { id: 'letter', label: 'US Letter — 8.5 × 11 in, 300 ppi', width: 2550, height: 3300, dpi: 300, unit: 'in' },
  { id: 'legal', label: 'US Legal — 8.5 × 14 in, 300 ppi', width: 2550, height: 4200, dpi: 300, unit: 'in' },
  { id: 'a4', label: 'A4 — 210 × 297 mm, 300 ppi', width: 2480, height: 3508, dpi: 300, unit: 'mm' },
  { id: 'a5', label: 'A5 — 148 × 210 mm, 300 ppi', width: 1748, height: 2480, dpi: 300, unit: 'mm' },
  { id: 'a3', label: 'A3 — 297 × 420 mm, 300 ppi', width: 3508, height: 4961, dpi: 300, unit: 'mm' },
  { id: 'photo-4x6', label: 'Photo — 4 × 6 in, 300 ppi', width: 1200, height: 1800, dpi: 300, unit: 'in' },
  { id: 'photo-5x7', label: 'Photo — 5 × 7 in, 300 ppi', width: 1500, height: 2100, dpi: 300, unit: 'in' },
  { id: 'instagram', label: 'Instagram post — 1080 × 1080 px', width: 1080, height: 1080, dpi: 72, unit: 'px' },
  { id: 'instagram-portrait', label: 'Instagram portrait — 1080 × 1350 px', width: 1080, height: 1350, dpi: 72, unit: 'px' },
  { id: 'story', label: 'Story / Reel — 1080 × 1920 px', width: 1080, height: 1920, dpi: 72, unit: 'px' },
  { id: 'youtube', label: 'YouTube thumbnail — 1280 × 720 px', width: 1280, height: 720, dpi: 72, unit: 'px' },
  { id: 'social-cover', label: 'Social cover — 1500 × 500 px', width: 1500, height: 500, dpi: 72, unit: 'px' },
  { id: 'web-banner', label: 'Web banner — 728 × 90 px', width: 728, height: 90, dpi: 72, unit: 'px' },
  { id: 'web-rect', label: 'Web rectangle — 300 × 250 px', width: 300, height: 250, dpi: 72, unit: 'px' },
  { id: 'web-hero', label: 'Web hero — 1920 × 600 px', width: 1920, height: 600, dpi: 72, unit: 'px' },
  { id: 'icon-512', label: 'Icon — 512 × 512 px', width: 512, height: 512, dpi: 72, unit: 'px' },
  { id: 'icon-1024', label: 'App icon — 1024 × 1024 px', width: 1024, height: 1024, dpi: 72, unit: 'px' },
  { id: 'favicon', label: 'Favicon — 64 × 64 px', width: 64, height: 64, dpi: 72, unit: 'px' },
];

const UNITS = [['px', 'Pixels'], ['in', 'Inches'], ['cm', 'Centimeters'], ['mm', 'Millimeters']];
const PER_INCH = { in: 1, cm: 2.54, mm: 25.4 };

/** Pixels -> value in unit at dpi. */
export function fromPx(px, unit, dpi) {
  if (unit === 'px') return px;
  return (px / dpi) * PER_INCH[unit];
}
/** Value in unit at dpi -> pixels. */
export function toPx(v, unit, dpi) {
  if (unit === 'px') return v;
  return (v / PER_INCH[unit]) * dpi;
}
function fmtUnit(v, unit) {
  if (unit === 'px') return String(Math.round(v));
  const d = unit === 'mm' ? 1 : 2;
  return String(Number(v.toFixed(d)));
}
function memoryText(w, h) {
  const bytes = w * h * 4;
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function clipboardSize(app) {
  const internal = app.clipboard?.canvas;
  if (internal?.width) return { width: internal.width, height: internal.height };
  try {
    const bytes = await Promise.race([bridge.readClipboardImage?.(), new Promise((r) => setTimeout(() => r(null), 300))]);
    if (!bytes?.length) return null;
    const bmp = await createImageBitmap(new Blob([bytes]));
    const size = { width: bmp.width, height: bmp.height };
    bmp.close?.();
    return size;
  } catch {
    return null;
  }
}

let untitledCount = 0;

function createFromOptions(app, o) {
  const width = Math.max(1, Math.min(MAX_SIDE, Math.round(Number(o.width) || 1)));
  const height = Math.max(1, Math.min(MAX_SIDE, Math.round(Number(o.height) || 1)));
  const dpi = Math.max(1, Math.min(10000, Number(o.dpi) || 72));
  let background = o.background ?? 'white';
  let backgroundColor = o.backgroundColor ?? '#ffffff';
  if (background === 'background') {
    backgroundColor = normHex(app.settings.background);
    background = 'custom';
  } else if (background === 'foreground') {
    backgroundColor = normHex(app.settings.foreground);
    background = 'custom';
  } else if (!['white', 'black', 'transparent', 'custom'].includes(background)) {
    backgroundColor = normHex(background);
    background = 'custom';
  }
  const name = (o.name ?? '').trim() || `Untitled-${++untitledCount}`;
  const m = /^Untitled-(\d+)$/.exec(name);
  if (m) untitledCount = Math.max(untitledCount, Number(m[1]));
  return app.newDocument({ width, height, dpi, name, background, backgroundColor });
}

async function newDocumentDialog(app, arg) {
  if (arg && typeof arg === 'object' && Number(arg.width) > 0 && Number(arg.height) > 0) return createFromOptions(app, arg);
  const last = { ...DEFAULT_SETTINGS.newDocPreset, ...(app.settings.newDocPreset ?? {}) };
  const clip = await clipboardSize(app);
  const presets = [...(clip ? [{ id: 'clipboard', label: `Clipboard — ${clip.width} × ${clip.height} px`, width: clip.width, height: clip.height, dpi: 72, unit: 'px' }] : []), ...DOC_PRESETS];
  const matching = presets.find((p) => p.id !== 'clipboard' && p.width === last.width && p.height === last.height && p.dpi === (last.dpi ?? 72));
  const startPreset = clip ? 'clipboard' : presets.some((p) => p.id === last.preset) ? last.preset : last.preset === 'custom' ? 'custom' : matching?.id ?? 'custom';
  const p0 = presets.find((p) => p.id === startPreset);
  const values0 = {
    preset: startPreset,
    name: `Untitled-${untitledCount + 1}`,
    width: p0?.width ?? last.width,
    height: p0?.height ?? last.height,
    dpi: p0?.dpi ?? last.dpi ?? 72,
    unit: p0?.unit ?? (UNITS.some(([u]) => u === last.unit) ? last.unit : 'px'),
    background: ['white', 'black', 'background', 'transparent', 'custom'].includes(last.background) ? last.background : 'white',
    backgroundColor: normHex(last.backgroundColor ?? '#ffffff'),
  };
  let sizeNode = null;
  let summary = null;
  // physical size in inches: typing a resolution digit by digit must not compound rounding errors
  let phys = { w: values0.width / values0.dpi, h: values0.height / values0.dpi };

  const updateSummary = (v) => {
    if (!summary) return;
    const bad = v.width > MAX_SIDE || v.height > MAX_SIDE || v.width * v.height > MAX_AREA;
    summary.classList.toggle('error', bad);
    summary.textContent = bad
      ? `Too large: at most ${MAX_SIDE.toLocaleString()} px per side and ${Math.round(MAX_AREA / 1e6)} megapixels`
      : `${v.width} × ${v.height} px · ${v.dpi} ppi · ${memoryText(v.width, v.height)} per layer`;
  };

  const fields = [
    { key: 'preset', label: 'Preset', type: 'select', span: true, options: [...presets.map((p) => [p.id, p.label]), ['custom', 'Custom']] },
    { key: 'name', label: 'Name', type: 'text', span: true, autofocus: true },
    {
      key: 'size',
      label: 'Size',
      type: 'custom',
      render: (values, _set, form) => {
        // width/height (px) and unit are not form fields of their own: seed them into the form values
        for (const k of ['width', 'height', 'unit']) if (values[k] === undefined) values[k] = values0[k];
        const wrap = document.createElement('div');
        wrap.className = 'newdoc-size';
        wrap.innerHTML = `
          <label><span class="muted">Width</span><input class="input" data-dim="width" type="number" min="0" step="any" aria-label="Width"></label>
          <button type="button" class="pbtn" data-act="swap" title="Swap width and height (orientation)">${icon('swap')}</button>
          <label><span class="muted">Height</span><input class="input" data-dim="height" type="number" min="0" step="any" aria-label="Height"></label>
          <label><span class="muted">Units</span><select class="select" data-unit aria-label="Units">${UNITS.map(([u, l]) => `<option value="${u}">${l}</option>`).join('')}</select></label>`;
        const inputs = [...wrap.querySelectorAll('[data-dim]')];
        const unit = wrap.querySelector('[data-unit]');
        const markCustom = () => {
          if (values.preset !== 'custom') form.set('preset', 'custom', { silent: true });
        };
        const show = () => {
          for (const i of inputs) if (document.activeElement !== i) i.value = fmtUnit(fromPx(values[i.dataset.dim], values.unit, values.dpi), values.unit);
          unit.value = values.unit;
        };
        for (const i of inputs) {
          i.addEventListener('input', () => {
            const n = Number(i.value);
            if (!(n > 0)) return;
            values[i.dataset.dim] = Math.max(1, Math.round(toPx(n, values.unit, values.dpi)));
            phys = { w: values.width / values.dpi, h: values.height / values.dpi };
            markCustom();
            updateSummary(values);
          });
          i.addEventListener('change', show);
        }
        unit.addEventListener('change', () => {
          values.unit = unit.value;
          show();
        });
        wrap.querySelector('[data-act="swap"]').addEventListener('click', () => {
          [values.width, values.height] = [values.height, values.width];
          phys = { w: values.width / values.dpi, h: values.height / values.dpi };
          markCustom();
          show();
          updateSummary(values);
        });
        wrap.show = show;
        sizeNode = wrap;
        show();
        return wrap;
      },
      sync: (_values, node) => node?.show?.(),
    },
    { key: 'dpi', label: 'Resolution', type: 'number', min: 1, max: 10000, step: 1, unit: 'ppi', width: 90 },
    { key: 'background', label: 'Background contents', type: 'select', options: [['white', 'White'], ['black', 'Black'], ['background', 'Background color'], ['transparent', 'Transparent'], ['custom', 'Custom color…']] },
    { key: 'backgroundColor', label: 'Custom color', type: 'color', when: (v) => v.background === 'custom' },
    {
      key: 'summary',
      type: 'custom',
      render: (values) => {
        summary = document.createElement('div');
        summary.className = 'newdoc-summary muted';
        updateSummary(values);
        return summary;
      },
    },
  ];

  const result = await formDialog(app, {
    title: 'New Document',
    fields,
    values: values0,
    okLabel: 'Create',
    width: 480,
    className: 'newdoc-dialog',
    onChange: (values, key, form) => {
      if (key === 'preset') {
        const p = presets.find((x) => x.id === values.preset);
        if (p) {
          values.width = p.width;
          values.height = p.height;
          values.unit = p.unit;
          form.set('dpi', p.dpi, { silent: true });
          phys = { w: p.width / p.dpi, h: p.height / p.dpi };
        }
        sizeNode?.show();
      } else if (key === 'dpi') {
        const dpi = Number(values.dpi) || 72;
        if (values.unit !== 'px') {
          // keep the physical size: the pixel count follows the resolution
          values.width = Math.max(1, Math.round(phys.w * dpi));
          values.height = Math.max(1, Math.round(phys.h * dpi));
        } else phys = { w: values.width / dpi, h: values.height / dpi };
        if (values.preset !== 'custom') form.set('preset', 'custom', { silent: true });
        sizeNode?.show();
      }
      updateSummary(values);
    },
    validate: (v) => {
      const ok = v.width >= 1 && v.height >= 1 && v.width <= MAX_SIDE && v.height <= MAX_SIDE && v.width * v.height <= MAX_AREA;
      if (!ok) app.dialogs.toast('The document is too large', { kind: 'error' });
      return ok;
    },
  });
  if (!result) return null;
  const opts = { width: Math.round(result.width), height: Math.round(result.height), dpi: Math.round(Number(result.dpi) || 72), background: result.background, backgroundColor: normHex(result.backgroundColor), name: result.name, unit: result.unit };
  app.saveSettingsSoon({ newDocPreset: { width: opts.width, height: opts.height, dpi: opts.dpi, background: opts.background, backgroundColor: opts.backgroundColor, unit: opts.unit, preset: result.preset === 'clipboard' ? 'custom' : result.preset, name: 'Untitled' } });
  return createFromOptions(app, opts);
}

// ---- colour picker ---------------------------------------------------------------------------------------------
function pickColor(app, initial, { title = 'Color Picker', live } = {}) {
  const start = normHex(initial ?? app.settings.foreground);
  let current = start;
  let liveRaf = 0;
  let liveHex = null;
  const pushLive = (hex) => {
    if (typeof live !== 'function') return;
    liveHex = hex;
    if (liveRaf) return;
    liveRaf = requestAnimationFrame(() => {
      liveRaf = 0;
      try {
        live(liveHex);
      } catch (err) {
        console.error(err);
      }
    });
  };

  const content = document.createElement('div');
  content.className = 'color-dialog';
  const widget = createColorWidget({
    value: start,
    large: true,
    onChange: (hex) => {
      current = hex;
      showNew();
      pushLive(hex);
    },
  });
  const side = document.createElement('div');
  side.className = 'color-dialog-side';
  side.innerHTML = `
    <div class="cp-compare" aria-label="New and current colour">
      <span class="muted">new</span>
      <div class="cp-swatches"><span class="cp-new"></span><button type="button" class="cp-old" title="Click to go back to the current colour"></button></div>
      <span class="muted">current</span>
    </div>
    <div class="color-fields cp-modes" style="grid-template-columns: repeat(4, 1fr)" aria-label="Lab and CMYK">
      <label title="Lightness (0–100)">L <input class="input" data-m="L" type="number" min="0" max="100" step="1"></label>
      <label title="a (green–red)">a <input class="input" data-m="a" type="number" min="-128" max="127" step="1"></label>
      <label title="b (blue–yellow)">b <input class="input" data-m="b" type="number" min="-128" max="127" step="1"></label>
      <label title="Cyan (%)">C <input class="input" data-m="c" type="number" min="0" max="100" step="1"></label>
      <label title="Magenta (%)">M <input class="input" data-m="m" type="number" min="0" max="100" step="1"></label>
      <label title="Yellow (%)">Y <input class="input" data-m="y" type="number" min="0" max="100" step="1"></label>
      <label title="Black (%)">K <input class="input" data-m="k" type="number" min="0" max="100" step="1"></label>
    </div>
    <div class="cp-quick-title muted">Recent and swatches</div>
    <div class="cp-quick"></div>
    <button type="button" class="btn small cp-add">${icon('plus')} Add to Swatches</button>`;
  const newSw = side.querySelector('.cp-new');
  const oldSw = side.querySelector('.cp-old');
  oldSw.style.background = start;
  // Lab and CMYK readouts/fields (lib/color-modes.js owns the maths): typing in one converts back to RGB
  const modes = Object.fromEntries([...side.querySelectorAll('[data-m]')].map((i) => [i.dataset.m, i]));
  const showModes = () => {
    const [r, g, b] = parseColor(current);
    const lab = rgbToLab(r, g, b), cmyk = rgbToCmyk(r, g, b);
    const vals = { L: lab[0], a: lab[1], b: lab[2], c: cmyk[0], m: cmyk[1], y: cmyk[2], k: cmyk[3] };
    for (const [k, input] of Object.entries(modes)) if (document.activeElement !== input) input.value = String(Math.round(vals[k]));
  };
  const commitMode = (key) => {
    const n = (k) => Number(modes[k].value);
    if (Object.values(modes).some((i) => i.value === '' || !Number.isFinite(Number(i.value)))) return;
    const rgb = 'Lab'.includes(key) ? labToRgb(n('L'), n('a'), n('b')) : cmykToRgb(n('c'), n('m'), n('y'), n('k'));
    choose(rgbaToHex(rgb.map((v) => Math.round(v))));
  };
  for (const [k, input] of Object.entries(modes)) {
    input.addEventListener('change', () => commitMode(k));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commitMode(k);
    });
  }
  const showNew = () => {
    newSw.style.background = current;
    showModes();
  };
  const choose = (hex) => {
    current = normHex(hex);
    widget.set(current);
    showNew();
    pushLive(current);
  };
  oldSw.addEventListener('click', () => choose(start));
  const quick = side.querySelector('.cp-quick');
  const recent = (app.settings.recentColors ?? []).map(normHex);
  const palette = app.settings.swatchesEdited || app.settings.swatches?.length ? app.settings.swatches : DEFAULT_SWATCHES;
  const seen = new Set();
  for (const c of [...recent, ...(palette ?? []).map((s) => normHex(typeof s === 'string' ? s : s?.color))]) {
    if (seen.has(c) || seen.size >= 30) continue;
    seen.add(c);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', () => choose(c));
    quick.appendChild(b);
  }
  side.querySelector('.cp-add').addEventListener('click', (e) => {
    const list = (app.settings.swatchesEdited || app.settings.swatches?.length ? app.settings.swatches : DEFAULT_SWATCHES).slice();
    list.push(current);
    app.saveSettingsSoon({ swatches: list, swatchesEdited: true });
    app.emit('swatches:changed', list);
    e.currentTarget.textContent = 'Added';
    e.currentTarget.disabled = true;
  });
  showNew();
  content.append(widget.element, side);

  return app.dialogs
    .open({
      title,
      content,
      width: 520,
      className: 'color-picker-dialog',
      buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }],
    })
    .then((ok) => {
      cancelAnimationFrame(liveRaf);
      liveRaf = 0;
      return ok ? normHex(current) : null;
    });
}

// ---- preferences ---------------------------------------------------------------------------------------------
const PREF_KEYS = ['theme', 'zoomWithWheel', 'rulerUnit', 'historyLimit', 'historyMemoryMB', 'checkerboardSize', 'checkerboardLight', 'checkerboardDark', 'gridSize', 'pixelGrid', 'showSelectionEdges', 'cursorStyle', 'resampleMethod', 'transformInterpolation', 'transformProportional', 'transformScalesStrokes', 'placeAsSmart'];

/**
 * app.saveSettings() replaces app.settings with what the store returns, which drops changes still
 * queued by saveSettingsSoon() (written 400 ms later). Send them along with the patch.
 */
async function saveSettingsNow(app, patch) {
  const queued = app.pendingSettings && Object.keys(app.pendingSettings).length ? app.pendingSettings : null;
  if (queued) {
    clearTimeout(app.saveTimer);
    app.pendingSettings = {};
  }
  await app.saveSettings(queued ? { ...queued, ...patch } : patch);
}

function applyRuntimeSettings(app) {
  const s = app.settings;
  for (const d of app.docs?.list() ?? []) {
    if (d.history) {
      d.history.limit = Math.max(1, Number(s.historyLimit) || 100);
      d.history.memoryLimit = Math.max(16, Number(s.historyMemoryMB) || 512) * 1024 * 1024;
      const before = d.history.entries.length;
      d.history.trim();
      if (d.history.entries.length !== before) d.history.onChange();
    }
    d.view?.invalidate();
  }
  app.tools?.updateCursor();
  app.commands.invalidate();
  app.syncUiState();
}

async function preferencesDialog(app) {
  const s = app.settings;
  const values = Object.fromEntries(PREF_KEYS.map((k) => [k, s[k] ?? DEFAULT_SETTINGS[k]]));
  values.checkerboardLight = normHex(values.checkerboardLight);
  values.checkerboardDark = normHex(values.checkerboardDark);
  const fields = [
    { type: 'section', label: 'Interface' },
    { key: 'theme', label: 'Theme', type: 'select', options: [['system', 'Match the system'], ['light', 'Light'], ['dark', 'Dark']] },
    { key: 'rulerUnit', label: 'Ruler units', type: 'select', options: [['px', 'Pixels'], ['in', 'Inches'], ['cm', 'Centimeters'], ['mm', 'Millimeters'], ['pt', 'Points'], ['percent', 'Percent']] },
    { key: 'zoomWithWheel', label: 'Zoom with the scroll wheel (Ctrl/Cmd + wheel always zooms)', type: 'checkbox', span: true },
    { type: 'section', label: 'Cursors and tools' },
    { key: 'cursorStyle', label: 'Painting cursor', type: 'select', options: [['outline', 'Brush outline'], ['precise', 'Precise (crosshair)'], ['dot', 'Dot']] },
    { key: 'transformInterpolation', label: 'Transform interpolation', type: 'select', options: [['bicubic', 'Bicubic'], ['bilinear', 'Bilinear'], ['nearest', 'Nearest neighbor']] },
    { key: 'resampleMethod', label: 'Image Size resampling', type: 'select', options: [['bicubic', 'Bicubic (smooth gradients)'], ['lanczos', 'Lanczos (sharper)'], ['bilinear', 'Bilinear'], ['area', 'Area average (reduction)'], ['nearest', 'Nearest neighbor (hard edges)']] },
    { key: 'transformProportional', label: 'Keep proportions while transforming (Shift releases)', type: 'checkbox', span: true },
    { key: 'transformScalesStrokes', label: 'Scale shape strokes with transforms', type: 'checkbox', span: true },
    { key: 'placeAsSmart', label: 'Place files as smart objects', type: 'checkbox', span: true },
    { type: 'section', label: 'Canvas' },
    { key: 'checkerboardSize', label: 'Transparency grid size', type: 'select', options: [[4, 'Small'], [8, 'Medium'], [16, 'Large']] },
    { key: 'gridSize', label: 'Grid spacing', type: 'number', min: 2, max: 2000, unit: 'px' },
    { key: 'checkerboardLight', label: 'Grid colour (light)', type: 'color' },
    { key: 'checkerboardDark', label: 'Grid colour (dark)', type: 'color' },
    { key: 'pixelGrid', label: 'Show the pixel grid at high zoom', type: 'checkbox', span: true },
    { key: 'showSelectionEdges', label: 'Show selection edges (marching ants)', type: 'checkbox', span: true },
    { type: 'section', label: 'Performance' },
    { key: 'historyLimit', label: 'History states', type: 'number', min: 1, max: 1000, help: 'Older states are dropped first' },
    { key: 'historyMemoryMB', label: 'History memory', type: 'number', min: 64, max: 16384, unit: 'MB', help: 'Per document' },
  ];
  if (![4, 8, 16].includes(Number(values.checkerboardSize))) fields.find((f) => f.key === 'checkerboardSize').options.push([Number(values.checkerboardSize), `${values.checkerboardSize} px`]);
  values.checkerboardSize = Number(values.checkerboardSize);
  const result = await formDialog(app, {
    title: 'Preferences',
    fields,
    values,
    width: 560,
    className: 'prefs-dialog',
    okLabel: 'Save',
    buttons: [{ label: 'Reset All Settings…', value: 'reset-all', danger: true }, { label: 'Cancel', value: null }, { label: 'Save', value: true, primary: true }],
    onOpen: (dialog) => dialog.querySelector('.dialog-buttons [data-value="reset-all"]')?.classList.add('left'),
  });
  if (!result) return false;
  if (result.__button === 'reset-all') return resetAllSettings(app);
  const patch = {};
  for (const k of PREF_KEYS) {
    let v = result[k];
    if (typeof DEFAULT_SETTINGS[k] === 'number') v = Number(v);
    if (typeof DEFAULT_SETTINGS[k] === 'number' && !Number.isFinite(v)) continue;
    if (k === 'checkerboardLight' || k === 'checkerboardDark') v = normHex(v);
    if (v !== s[k]) patch[k] = v;
  }
  if (Object.keys(patch).length) {
    await saveSettingsNow(app, patch);
    applyRuntimeSettings(app);
    app.dialogs.toast('Preferences saved', { kind: 'success', timeout: 1500 });
  }
  return true;
}

async function resetAllSettings(app) {
  const ok = await app.dialogs.confirm('Reset every preference, tool option, swatch, brush preset and the panel layout to the defaults?', { title: 'Reset All Settings', okLabel: 'Reset', danger: true, detail: 'Open documents and the recent files list are kept.' });
  if (!ok) return false;
  const keep = new Set(['lastSession', 'windowBounds', 'tourSeen']);
  const patch = {};
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (keep.has(k)) continue;
    patch[k] = Array.isArray(v) ? v.slice() : v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
  }
  await saveSettingsNow(app, patch);
  app.panels?.reset();
  app.tools?.renderOptions();
  app.setColors({ foreground: DEFAULT_SETTINGS.foreground, background: DEFAULT_SETTINGS.background });
  applyRuntimeSettings(app);
  app.emit('swatches:changed', []);
  app.dialogs.toast('All settings were reset', { kind: 'success', timeout: 2000 });
  return true;
}

export function install(app) {
  app.newDocumentDialog = (arg) => newDocumentDialog(app, arg);
  app.pickColor = (initial, opts) => pickColor(app, initial, opts);
  app.preferencesDialog = () => preferencesDialog(app);
}
