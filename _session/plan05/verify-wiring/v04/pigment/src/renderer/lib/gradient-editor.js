// The Gradient Editor (gradients package, ARCHITECTURE.md "0.4 features", package 9): Photoshop's dialog. Presets
// (the `gradients` kind of the preset store, in groups), Name and New, Gradient Type (Solid / Noise), Smoothness and
// the interpolation Method, the ramp with opacity stops above and colour stops below (click to add, drag to move, drag
// away to delete, midpoint diamonds between the selected stop and its neighbours), the Stops fields, the noise
// settings (roughness, colour model, channel ranges, Restrict Colors, Add Transparency, Randomize), and Import… /
// Export… / Save through the preset store's formats.
//
//   openGradientEditor(app, { value, keepRefs = false, title, presetId, onPreview(def) }) -> Promise<GradientDef | null>
//
// `keepRefs` (tool options and presets, the places where { ref } stops may stay, G.1): stops can be the Foreground or
// Background colour and the result keeps the references; otherwise every colour is resolved. Placement fields of
// `value` are not edited here and are not part of the result (the caller keeps them).
import { normalizeGradient, gradientLut, sampleGradient, INTERPOLATIONS, PLACEMENT_KEYS } from '../../shared/pixels/gradient-model.js';
import { presetFormats } from './presets.js';
import { numericField } from './numeric-field.js';
import { bridge } from './bridge.js';
import { GRADIENT_KIND } from './gradient-presets.js';
import { gradientPicker, appColors, editPresets } from './gradient-picker.js';
import { parseColor, rgbaToHex } from '../../shared/pixels/color.js';

export const METHOD_LABELS = { perceptual: 'Perceptual', linear: 'Linear', classic: 'Classic', smooth: 'Smooth', stripes: 'Stripes' };
const MODEL_CHANNELS = { rgb: ['R', 'G', 'B'], hsb: ['H', 'S', 'B'], lab: ['L', 'a', 'b'] };
const DRAG_OFF = 24; // px a stop is dragged away from its row to delete it

const el = (tag, className, text) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pct = (v) => Math.round(v * 1000) / 10;
const isRef = (c) => !!c && typeof c === 'object' && (c.ref === 'fg' || c.ref === 'bg');

/** The def without placement fields (what the editor edits). */
export function defOnly(g) {
  const out = { ...g };
  for (const k of PLACEMENT_KEYS) delete out[k];
  return out;
}

/** Straight-alpha ramp of a def into a canvas, over a checkerboard. */
export function drawRamp(canvas, def, colors) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const cell = 6;
  for (let y = 0; y < h; y += cell) for (let x = 0; x < w; x += cell) {
    ctx.fillStyle = ((x / cell + y / cell) & 1) ? '#c8c8c8' : '#ffffff';
    ctx.fillRect(x, y, cell, cell);
  }
  const lut = gradientLut(def, { ...colors, size: w });
  for (let x = 0; x < w; x++) {
    ctx.fillStyle = `rgba(${lut[x * 4]},${lut[x * 4 + 1]},${lut[x * 4 + 2]},${(lut[x * 4 + 3] / 255).toFixed(3)})`;
    ctx.fillRect(x, 0, 1, h);
  }
}

/**
 * Opens the Gradient Editor.
 * @returns {Promise<object | null>} the edited GradientDef (no placement), or null when cancelled
 */
export function openGradientEditor(app, { value = null, keepRefs = false, title = 'Gradient Editor', presetId = null, onPreview = null } = {}) {
  const colors = () => appColors(app);
  const norm = (v) => (keepRefs ? normalizeGradient(defOnly(v ?? {}), { keepRefs: true }) : normalizeGradient(defOnly(v ?? {}), colors()));
  let g = norm(value);
  let sel = { kind: 'color', stop: g.stops[0] };
  let selectedPreset = presetId;
  let name = presetId ? app.presets?.get(GRADIENT_KIND, presetId)?.name ?? 'Custom' : 'Custom';

  const root = el('div', 'gradient-editor');
  root.tabIndex = -1;
  const main = el('div', 'ge-main');
  const side = el('div', 'ge-side');
  root.append(main, side);

  // ---- presets -----------------------------------------------------------------------------------------------------
  const presetsBox = el('div', 'ge-presets');
  const picker = gradientPicker(app, {
    selected: presetId,
    size: 28,
    onPick(p) {
      g = norm(p.data);
      selectedPreset = p.id;
      name = p.name;
      sel = { kind: 'color', stop: g.stops[0] };
      changed();
    },
  });
  presetsBox.append(el('div', 'ge-label', 'Presets'), picker.element);
  main.appendChild(presetsBox);

  // ---- name + New -----------------------------------------------------------------------------------------------------
  const nameRow = el('div', 'ge-row');
  const nameInput = el('input', 'input ge-name');
  nameInput.type = 'text';
  nameInput.dataset.key = 'name';
  nameInput.addEventListener('input', () => (name = nameInput.value));
  const newBtn = el('button', 'btn small', 'New');
  newBtn.type = 'button';
  newBtn.dataset.act = 'new';
  newBtn.title = 'Add this gradient to the presets';
  newBtn.addEventListener('click', () => addPreset());
  nameRow.append(el('span', 'ge-label', 'Name'), nameInput, newBtn);
  main.appendChild(nameRow);

  // ---- type, smoothness, method ---------------------------------------------------------------------------------------
  const typeRow = el('div', 'ge-row');
  const typeSel = el('select', 'select');
  typeSel.dataset.key = 'type';
  for (const [v, l] of [['solid', 'Solid'], ['noise', 'Noise']]) typeSel.add(new Option(l, v));
  typeSel.addEventListener('change', () => {
    g = normalizeGradient({ ...g, type: typeSel.value }, { keepRefs: true });
    sel = { kind: 'color', stop: g.stops[0] };
    changed();
  });
  const methodSel = el('select', 'select');
  methodSel.dataset.key = 'interpolation';
  for (const m of INTERPOLATIONS) methodSel.add(new Option(METHOD_LABELS[m], m));
  methodSel.addEventListener('change', () => {
    g = { ...g, interpolation: methodSel.value };
    changed();
  });
  const smooth = numericField({ key: 'smoothness', min: 0, max: 100, step: 1, unit: '%', width: 56, onChange: (v) => {
    g = { ...g, smoothness: clamp(v, 0, 100) / 100 };
    changed();
  } });
  typeRow.append(el('span', 'ge-label', 'Gradient Type'), typeSel);
  const solidRow = el('div', 'ge-row ge-solid-only');
  solidRow.append(el('span', 'ge-label', 'Method'), methodSel, el('span', 'ge-label', 'Smoothness'), smooth.element);
  main.append(typeRow, solidRow);

  // ---- the ramp and its stops ---------------------------------------------------------------------------------------
  const rampBox = el('div', 'ge-ramp-box ge-solid-only');
  const opacityRow = el('div', 'ge-stop-row ge-opacity-row');
  opacityRow.dataset.row = 'opacity';
  opacityRow.title = 'Click to add an opacity stop';
  const ramp = el('canvas', 'ge-ramp');
  ramp.width = 400;
  ramp.height = 28;
  const colorRow = el('div', 'ge-stop-row ge-color-row');
  colorRow.dataset.row = 'color';
  colorRow.title = 'Click to add a colour stop';
  rampBox.append(opacityRow, ramp, colorRow);
  main.appendChild(rampBox);
  const noisePreview = el('canvas', 'ge-ramp ge-noise-only');
  noisePreview.width = 400;
  noisePreview.height = 28;
  main.appendChild(noisePreview);

  // ---- stops fields ---------------------------------------------------------------------------------------------------
  const stopsBox = el('fieldset', 'ge-stops ge-solid-only');
  stopsBox.appendChild(el('legend', '', 'Stops'));
  const opRow = el('div', 'ge-row');
  const opVal = numericField({ key: 'stop-opacity', min: 0, max: 100, step: 1, unit: '%', width: 56, onChange: (v) => {
    if (sel.kind !== 'opacity') return;
    sel.stop.opacity = clamp(v, 0, 100) / 100;
    changed();
  } });
  const opLoc = numericField({ key: 'stop-opacity-location', min: 0, max: 100, step: 0.1, unit: '%', width: 56, onChange: (v) => {
    if (sel.kind !== 'opacity') return;
    sel.stop.pos = clamp(v, 0, 100) / 100;
    sortStops();
    changed();
  } });
  const opDel = el('button', 'btn small', 'Delete');
  opDel.type = 'button';
  opDel.dataset.act = 'delete-opacity';
  opDel.addEventListener('click', () => sel.kind === 'opacity' && removeStop('opacity', sel.stop));
  opRow.append(el('span', 'ge-label', 'Opacity'), opVal.element, el('span', 'ge-label', 'Location'), opLoc.element, opDel);
  const colRow = el('div', 'ge-row');
  const colBtn = el('button', 'ge-color-chip');
  colBtn.type = 'button';
  colBtn.dataset.act = 'stop-color';
  colBtn.title = 'Choose the stop colour';
  colBtn.addEventListener('click', () => pickStopColor());
  const colRef = el('select', 'select ge-color-ref');
  colRef.dataset.key = 'stop-color-ref';
  for (const [v, l] of [['', 'Custom'], ['fg', 'Foreground'], ['bg', 'Background']]) colRef.add(new Option(l, v));
  colRef.hidden = !keepRefs;
  colRef.addEventListener('change', () => {
    if (sel.kind !== 'color') return;
    if (colRef.value) sel.stop.color = { ref: colRef.value };
    else sel.stop.color = rgbaToHex(parseColor(stopHex(sel.stop)));
    changed();
  });
  const colLoc = numericField({ key: 'stop-color-location', min: 0, max: 100, step: 0.1, unit: '%', width: 56, onChange: (v) => {
    if (sel.kind !== 'color') return;
    sel.stop.pos = clamp(v, 0, 100) / 100;
    sortStops();
    changed();
  } });
  const colDel = el('button', 'btn small', 'Delete');
  colDel.type = 'button';
  colDel.dataset.act = 'delete-color';
  colDel.addEventListener('click', () => sel.kind === 'color' && removeStop('color', sel.stop));
  colRow.append(el('span', 'ge-label', 'Color'), colBtn, colRef, el('span', 'ge-label', 'Location'), colLoc.element, colDel);
  stopsBox.append(opRow, colRow);
  main.appendChild(stopsBox);

  // ---- noise ----------------------------------------------------------------------------------------------------------
  const noiseBox = el('fieldset', 'ge-noise ge-noise-only');
  noiseBox.appendChild(el('legend', '', 'Noise'));
  const rough = numericField({ key: 'roughness', min: 0, max: 100, step: 1, unit: '%', width: 56, onChange: (v) => setNoise({ roughness: clamp(v, 0, 100) / 100 }) });
  const modelSel = el('select', 'select');
  modelSel.dataset.key = 'model';
  for (const [v, l] of [['rgb', 'RGB'], ['hsb', 'HSB'], ['lab', 'LAB']]) modelSel.add(new Option(l, v));
  modelSel.addEventListener('change', () => setNoise({ model: modelSel.value }));
  const nRow = el('div', 'ge-row');
  nRow.append(el('span', 'ge-label', 'Roughness'), rough.element, el('span', 'ge-label', 'Color Model'), modelSel);
  noiseBox.appendChild(nRow);
  const ranges = [0, 1, 2].map((c) => {
    const r = el('div', 'ge-row ge-range');
    const label = el('span', 'ge-label ge-channel');
    const min = numericField({ key: `min-${c}`, min: 0, max: 100, step: 1, width: 52, onChange: (v) => setRange(c, 'min', v) });
    const max = numericField({ key: `max-${c}`, min: 0, max: 100, step: 1, width: 52, onChange: (v) => setRange(c, 'max', v) });
    r.append(label, min.element, el('span', 'muted', 'to'), max.element);
    noiseBox.appendChild(r);
    return { label, min, max };
  });
  const flags = el('div', 'ge-row');
  const restrict = el('label', 'checkbox');
  const restrictCb = el('input');
  restrictCb.type = 'checkbox';
  restrictCb.dataset.key = 'restrict';
  restrictCb.addEventListener('change', () => setNoise({ restrict: restrictCb.checked }));
  restrict.append(restrictCb, document.createTextNode(' Restrict Colors'));
  const transp = el('label', 'checkbox');
  const transpCb = el('input');
  transpCb.type = 'checkbox';
  transpCb.dataset.key = 'transparency';
  transpCb.addEventListener('change', () => setNoise({ transparency: transpCb.checked }));
  transp.append(transpCb, document.createTextNode(' Add Transparency'));
  const randomize = el('button', 'btn small', 'Randomize');
  randomize.type = 'button';
  randomize.dataset.act = 'randomize';
  randomize.addEventListener('click', () => setNoise({ seed: (Math.random() * 0x7fffffff) | 0 }));
  flags.append(restrict, transp, randomize);
  noiseBox.appendChild(flags);
  main.appendChild(noiseBox);

  // ---- side buttons ---------------------------------------------------------------------------------------------------
  const sideBtn = (label, act, title, fn) => {
    const b = el('button', 'btn', label);
    b.type = 'button';
    b.dataset.act = act;
    b.title = title;
    b.addEventListener('click', fn);
    side.appendChild(b);
    return b;
  };
  sideBtn('Import…', 'import', 'Add the gradients of a presets file', () => importPresets(app));
  sideBtn('Export…', 'export', 'Save the selected gradient (or all of them) to a presets file', () => exportPresets(app, selectedPreset ? [selectedPreset] : null));
  sideBtn('Save', 'save', 'Store this gradient in the selected preset (or as a new one)', () => savePreset());

  // ---- state helpers --------------------------------------------------------------------------------------------------
  function stopHex(s) {
    if (isRef(s.color)) return s.color.ref === 'fg' ? colors().fg : colors().bg;
    return typeof s.color === 'string' ? s.color : '#000000';
  }
  function sortStops() {
    g.stops.sort((a, b) => a.pos - b.pos);
    g.opacityStops.sort((a, b) => a.pos - b.pos);
  }
  function removeStop(kind, stop) {
    const list = kind === 'color' ? g.stops : g.opacityStops;
    if (list.length <= 2) {
      app.dialogs.toast('A gradient needs at least two stops of each kind', { kind: 'info', timeout: 2200 });
      return false;
    }
    list.splice(list.indexOf(stop), 1);
    sel = { kind, stop: list[0] };
    changed();
    return true;
  }
  function setNoise(patch) {
    g = { ...g, noise: { ...g.noise, ...patch } };
    changed();
  }
  function setRange(c, key, v) {
    const arr = [...g.noise[key]];
    arr[c] = clamp(v, 0, 100) / 100;
    setNoise({ [key]: arr });
  }
  async function pickStopColor() {
    if (sel.kind !== 'color') return;
    const stop = sel.stop;
    const hex = await app.pickColor?.(stopHex(stop), { title: 'Color Picker (Stop Color)' });
    if (!hex) return;
    stop.color = rgbaToHex(parseColor(hex));
    changed();
  }
  function current() {
    return keepRefs ? normalizeGradient(g, { keepRefs: true }) : normalizeGradient(g, colors());
  }
  async function addPreset() {
    const n = (nameInput.value || 'Custom').trim();
    const group = selectedPreset ? app.presets.get(GRADIENT_KIND, selectedPreset)?.group ?? null : null;
    const p = await editPresets(app, (s) => s.add(GRADIENT_KIND, { name: n, data: current(), group }));
    selectedPreset = p.id;
    name = p.name;
    picker.select(p.id);
  }
  async function savePreset() {
    if (!selectedPreset || !app.presets.get(GRADIENT_KIND, selectedPreset)) return addPreset();
    await editPresets(app, (s) => s.update(GRADIENT_KIND, selectedPreset, { name: (nameInput.value || name).trim(), data: current() }));
    app.dialogs.toast('Saved the gradient preset', { kind: 'success', timeout: 1600 });
  }

  // ---- stop markers and their drags -----------------------------------------------------------------------------------
  function marker(kind, stop) {
    const m = el('div', `ge-stop ge-${kind}-stop`);
    m.style.left = `${stop.pos * 100}%`;
    m.dataset.index = String((kind === 'color' ? g.stops : g.opacityStops).indexOf(stop));
    m.setAttribute('aria-selected', String(sel.stop === stop));
    const fill = kind === 'color' ? stopHex(stop) : `rgb(${Math.round(255 * (1 - stop.opacity))},${Math.round(255 * (1 - stop.opacity))},${Math.round(255 * (1 - stop.opacity))})`;
    m.style.setProperty('--stop', fill);
    if (kind === 'color' && isRef(stop.color)) m.classList.add(`ge-ref-${stop.color.ref}`);
    m.addEventListener('pointerdown', (e) => startStopDrag(e, kind, stop));
    if (kind === 'color') m.addEventListener('dblclick', () => pickStopColor());
    return m;
  }
  function midMarker(kind, s0, s1) {
    const d = el('div', 'ge-mid');
    d.style.left = `${(s0.pos + (s1.pos - s0.pos) * (s1.mid ?? 0.5)) * 100}%`;
    d.title = 'Drag to move the midpoint';
    d.dataset.kind = kind;
    d.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = rampBox.getBoundingClientRect();
      // the markers are rebuilt on every change: the drag listens on the window
      windowDrag((ev) => {
        const t = clamp((ev.clientX - rect.left) / rect.width, 0, 1);
        const span = s1.pos - s0.pos;
        if (span <= 0) return;
        s1.mid = clamp((t - s0.pos) / span, 0.05, 0.95);
        changed();
      });
    });
    return d;
  }
  function startStopDrag(e, kind, stop) {
    e.preventDefault();
    e.stopPropagation();
    root.focus({ preventScroll: true }); // Delete removes the selected stop
    sel = { kind, stop };
    changed();
    const row = kind === 'color' ? colorRow : opacityRow;
    const rect = row.getBoundingClientRect();
    const list = kind === 'color' ? g.stops : g.opacityStops;
    let away = false;
    windowDrag((ev) => {
      stop.pos = clamp((ev.clientX - rect.left) / rect.width, 0, 1);
      const dy = ev.clientY < rect.top ? rect.top - ev.clientY : ev.clientY > rect.bottom ? ev.clientY - rect.bottom : 0;
      away = dy > DRAG_OFF && list.length > 2;
      sortStops();
      changed({ hide: away ? stop : null });
    }, () => {
      if (away) removeStop(kind, stop);
      else changed();
    });
  }
  /** A pointer drag followed on the window (the markers under the pointer are rebuilt while it moves). */
  function windowDrag(move, end) {
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      end?.();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }
  for (const [row, kind] of [[colorRow, 'color'], [opacityRow, 'opacity']]) {
    row.addEventListener('pointerdown', (e) => {
      if (e.target !== row) return;
      const rect = row.getBoundingClientRect();
      const t = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      const c = sampleGradient(g, t, colors());
      let stop;
      if (kind === 'color') {
        stop = { pos: t, mid: 0.5, color: rgbaToHex([Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), 1]) };
        g.stops.push(stop);
      } else {
        stop = { pos: t, mid: 0.5, opacity: Math.round(c[3] * 100) / 100 };
        g.opacityStops.push(stop);
      }
      sortStops();
      startStopDrag(e, kind, stop);
    });
  }

  // ---- render ---------------------------------------------------------------------------------------------------------
  let lastPreview = 0;
  function changed({ hide = null } = {}) {
    const noise = g.type === 'noise';
    for (const n of root.querySelectorAll('.ge-solid-only')) n.hidden = noise;
    for (const n of root.querySelectorAll('.ge-noise-only')) n.hidden = !noise;
    if (document.activeElement !== nameInput) nameInput.value = name;
    typeSel.value = g.type;
    methodSel.value = g.interpolation;
    smooth.set(Math.round(g.smoothness * 100));
    smooth.setDisabled(g.interpolation !== 'classic');
    const shown = { ...g, stops: g.stops.filter((s) => s !== hide), opacityStops: g.opacityStops.filter((s) => s !== hide) };
    drawRamp(noise ? noisePreview : ramp, normalizeGradient(shown, { keepRefs: true }), colors());
    // markers
    const cm = g.stops.filter((s) => s !== hide).map((s) => marker('color', s));
    const om = g.opacityStops.filter((s) => s !== hide).map((s) => marker('opacity', s));
    const mids = [];
    const list = sel.kind === 'color' ? g.stops : g.opacityStops;
    const i = list.indexOf(sel.stop);
    if (i > 0) mids.push(midMarker(sel.kind, list[i - 1], list[i]));
    if (i >= 0 && i < list.length - 1) mids.push(midMarker(sel.kind, list[i], list[i + 1]));
    colorRow.replaceChildren(...cm, ...(sel.kind === 'color' ? mids : []));
    opacityRow.replaceChildren(...om, ...(sel.kind === 'opacity' ? mids : []));
    // stop fields
    const isOp = sel.kind === 'opacity', isCol = sel.kind === 'color';
    opVal.setDisabled(!isOp);
    opLoc.setDisabled(!isOp);
    opDel.disabled = !isOp;
    colLoc.setDisabled(!isCol);
    colDel.disabled = !isCol;
    colBtn.disabled = !isCol || isRef(sel.stop?.color);
    colRef.disabled = !isCol;
    if (isOp) {
      opVal.set(Math.round(sel.stop.opacity * 100));
      opLoc.set(pct(sel.stop.pos));
    }
    if (isCol) {
      colLoc.set(pct(sel.stop.pos));
      colBtn.style.background = stopHex(sel.stop);
      colRef.value = isRef(sel.stop.color) ? sel.stop.color.ref : '';
    }
    // noise fields
    if (noise && g.noise) {
      rough.set(Math.round(g.noise.roughness * 100));
      modelSel.value = g.noise.model;
      ranges.forEach((r, c) => {
        r.label.textContent = MODEL_CHANNELS[g.noise.model][c];
        r.min.set(Math.round(g.noise.min[c] * 100));
        r.max.set(Math.round(g.noise.max[c] * 100));
      });
      restrictCb.checked = !!g.noise.restrict;
      transpCb.checked = !!g.noise.transparency;
    }
    // live preview on the canvas, at most once per frame
    if (onPreview && !lastPreview) {
      lastPreview = requestAnimationFrame(() => {
        lastPreview = 0;
        onPreview(current());
      });
    }
  }

  changed();
  root.addEventListener('keydown', (e) => {
    // Delete removes the selected stop (not while typing in a field)
    if ((e.key === 'Delete' || e.key === 'Backspace') && !e.target.closest('input, select, textarea')) {
      e.preventDefault();
      removeStop(sel.kind, sel.stop);
    }
  });

  return app.dialogs.open({
    title,
    content: root,
    width: 640,
    className: 'gradient-editor-dialog',
    buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: 'ok', primary: true }],
  }).then((v) => {
    cancelAnimationFrame(lastPreview);
    picker.destroy();
    return v === 'ok' ? current() : null;
  });
}

// ---- Import / Export through the preset store's formats (C) --------------------------------------------------------------

/** Import…: adds the gradients of a presets file (any format registered for the kind) in a group of their own. */
export async function importPresets(app, path = null) {
  const formats = presetFormats(GRADIENT_KIND);
  let file = path;
  if (!file) {
    const picked = await bridge.openFileDialog({ title: 'Import Gradients', filters: [{ name: 'Gradient presets', extensions: [...new Set(formats.flatMap((f) => f.extensions ?? []))].map((e) => e.replace(/^\./, '')) }] });
    file = Array.isArray(picked) ? picked[0] : picked;
  }
  if (!file) return null;
  try {
    const bytes = await bridge.readFile(file);
    const res = await app.presets.importFile(GRADIENT_KIND, bytes, { name: String(file).split(/[\\/]/).pop() });
    if (res.report?.length) app.dialogs.toast(res.report.join(' · '), { kind: res.added.length ? 'info' : 'error', timeout: 5000 });
    if (res.added.length) app.dialogs.toast(`Imported ${res.added.length} gradient${res.added.length === 1 ? '' : 's'}`, { kind: 'success', timeout: 2200 });
    return res;
  } catch (err) {
    app.reportError?.(err, 'Could not import the gradients');
    return null;
  }
}

/** Export…: the given presets (all when ids is null) as a .pigment-presets file. */
export async function exportPresets(app, ids = null, path = null) {
  const fmt = presetFormats(GRADIENT_KIND).find((f) => f.write) ?? null;
  if (!fmt) return null;
  const target = path ?? await bridge.saveFileDialog({ title: 'Export Gradients', defaultPath: `Gradients.${fmt.extensions[0]}`, filters: [{ name: fmt.name, extensions: fmt.extensions }] });
  if (!target) return null;
  try {
    const { bytes, ext } = await app.presets.exportFile(GRADIENT_KIND, ids, fmt.id);
    const file = new RegExp(`\\.${ext}$`, 'i').test(target) ? target : `${target}.${ext}`;
    await bridge.writeFile(file, bytes);
    app.dialogs.toast('Exported the gradients', { kind: 'success', timeout: 1800 });
    return file;
  } catch (err) {
    app.reportError?.(err, 'Could not export the gradients');
    return null;
  }
}
