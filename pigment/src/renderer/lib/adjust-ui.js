// Image › Adjustments: dialogs with live preview on the canvas, Levels/Curves editors, auto tone,
// Fade, adjustment-layer editors (shared with the Properties panel) and fill-layer editing.
// Destructive edits run through a "pixel edit session" (also used by filter-ui.js) that limits
// the change to the selection, previews in place and records one undo entry.
import { ADJUSTMENTS, ADJUSTMENT_KINDS, applyAdjustment, histogram, autoLevels, autoContrast, autoColor, curveLut, levelsLut } from '../../shared/pixels/adjust.js';
import { CANVAS_BLEND, blendImages } from '../../shared/pixels/blend.js';
import { BLEND_MODES, createCanvas, intersectRect } from './document.js';
import { buildForm, formDialog, frameThrottle } from './form.js';
import { flattenDocument } from './compositor.js';
import { setLayerProps } from './layer-ops.js';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export const ADJUSTMENT_ICONS = {
  'brightness-contrast': 'adjust', levels: 'adjust', curves: 'adjust', exposure: 'adjust', vibrance: 'color', 'hue-saturation': 'color',
  'color-balance': 'color', 'black-white': 'adjust', 'photo-filter': 'color', 'channel-mixer': 'channels', invert: 'adjust',
  posterize: 'adjust', threshold: 'adjust', 'gradient-map': 'gradient', 'selective-color': 'color', desaturate: 'adjust',
  equalize: 'adjust', 'shadows-highlights': 'adjust',
};

/** Kinds that make sense as adjustment layers (Photoshop's list). */
export const LAYER_KINDS = ['brightness-contrast', 'levels', 'curves', 'exposure', 'vibrance', 'hue-saturation', 'color-balance', 'black-white', 'photo-filter', 'channel-mixer', 'invert', 'posterize', 'threshold', 'gradient-map', 'selective-color'];
/** Destructive-only kinds (no adjustment layer). */
const DIRECT_ONLY = ['desaturate', 'equalize', 'shadows-highlights'];
const NO_PARAMS = new Set(['invert', 'desaturate', 'equalize']);
/** Where Photoshop's dialogs start (the engine's defaults are the identity). */
const START_VALUES = { 'photo-filter': { density: 25 }, 'shadows-highlights': { shadows: 35 } };
const startParams = (kind) => ({ ...clone(ADJUSTMENTS[kind].defaults), ...(START_VALUES[kind] ?? {}) });

// ---- path helpers --------------------------------------------------------------------------------------------

export function getPath(obj, path) {
  let v = obj;
  for (const k of path.split('.')) {
    if (v === null || v === undefined) return undefined;
    v = v[k];
  }
  return v;
}

export function setPath(obj, path, value) {
  const keys = path.split('.');
  let v = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (v[k] === null || v[k] === undefined || typeof v[k] !== 'object') v[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    v = v[k];
  }
  v[keys[keys.length - 1]] = value;
}

// ---- generic field specs ------------------------------------------------------------------------------------

const S = (key, label, min, max, step = 1, extra = {}) => ({ key, label, type: 'slider', min, max, step, ...extra });
const CB = (key, label, extra = {}) => ({ key, label, type: 'checkbox', ...extra });

const HUE_RANGES = [['master', 'Master'], ['reds', 'Reds'], ['yellows', 'Yellows'], ['greens', 'Greens'], ['cyans', 'Cyans'], ['blues', 'Blues'], ['magentas', 'Magentas']];
const SEL_RANGES = [['reds', 'Reds'], ['yellows', 'Yellows'], ['greens', 'Greens'], ['cyans', 'Cyans'], ['blues', 'Blues'], ['magentas', 'Magentas'], ['whites', 'Whites'], ['neutrals', 'Neutrals'], ['blacks', 'Blacks']];
const TONES = [['shadows', 'Shadows'], ['midtones', 'Midtones'], ['highlights', 'Highlights']];

function fieldSpecs(kind, params) {
  switch (kind) {
    case 'brightness-contrast':
      return [S('brightness', 'Brightness', -150, 150), S('contrast', 'Contrast', -100, 100), CB('legacy', 'Use legacy')];
    case 'exposure':
      return [S('exposure', 'Exposure', -20, 20, 0.01), S('offset', 'Offset', -0.5, 0.5, 0.0001), S('gamma', 'Gamma correction', 0.01, 9.99, 0.01)];
    case 'vibrance':
      return [S('vibrance', 'Vibrance', -100, 100), S('saturation', 'Saturation', -100, 100)];
    case 'hue-saturation': {
      const off = (v) => !v.colorize, on = (v) => !!v.colorize;
      return [
        { key: 'range', label: 'Range', type: 'select', options: HUE_RANGES, when: off },
        S('hue', 'Hue', -180, 180, 1, { when: off }),
        S('saturation', 'Saturation', -100, 100, 1, { when: off }),
        S('lightness', 'Lightness', -100, 100, 1, { when: off }),
        CB('colorize', 'Colorize'),
        S('colorizeHue', 'Hue', 0, 360, 1, { when: on }),
        S('colorizeSat', 'Saturation', 0, 100, 1, { when: on }),
        S('colorizeLight', 'Lightness', -100, 100, 1, { when: on }),
      ];
    }
    case 'color-balance': {
      const out = [{ key: '__tone', label: 'Tone', type: 'segment', options: TONES, value: 'midtones', span: true }];
      for (const [t] of TONES) {
        const when = (v) => v.__tone === t;
        out.push(S(`${t}.0`, 'Cyan ↔ Red', -100, 100, 1, { when }), S(`${t}.1`, 'Magenta ↔ Green', -100, 100, 1, { when }), S(`${t}.2`, 'Yellow ↔ Blue', -100, 100, 1, { when }));
      }
      out.push(CB('preserveLuminosity', 'Preserve luminosity'));
      return out;
    }
    case 'black-white': {
      const tint = (v) => !!v.__tint;
      return [
        S('reds', 'Reds', -200, 300), S('yellows', 'Yellows', -200, 300), S('greens', 'Greens', -200, 300),
        S('cyans', 'Cyans', -200, 300), S('blues', 'Blues', -200, 300), S('magentas', 'Magentas', -200, 300),
        CB('__tint', 'Tint', { value: !!params.tint }),
        S('tint.hue', 'Hue', 0, 360, 1, { when: tint, value: params.tint?.hue ?? 42 }),
        S('tint.sat', 'Saturation', 0, 100, 1, { when: tint, value: params.tint?.sat ?? 20 }),
      ];
    }
    case 'photo-filter':
      return [{ key: 'color', label: 'Filter color', type: 'color' }, S('density', 'Density', 0, 100), CB('preserveLuminosity', 'Preserve luminosity')];
    case 'channel-mixer': {
      const out = [CB('monochrome', 'Monochrome'), { key: '__out', label: 'Output channel', type: 'select', value: 'r', options: [['r', 'Red'], ['g', 'Green'], ['b', 'Blue']], when: (v) => !v.monochrome }];
      for (const o of ['r', 'g', 'b', 'gray']) {
        const when = o === 'gray' ? (v) => !!v.monochrome : (v) => !v.monochrome && v.__out === o;
        out.push(S(`${o}.r`, 'Red', -200, 200, 1, { when }), S(`${o}.g`, 'Green', -200, 200, 1, { when }), S(`${o}.b`, 'Blue', -200, 200, 1, { when }), S(`${o}.constant`, 'Constant', -200, 200, 1, { when }));
      }
      return out;
    }
    case 'posterize':
      return [S('levels', 'Levels', 2, 255)];
    case 'threshold':
      return [S('level', 'Threshold level', 1, 255)];
    case 'gradient-map': {
      const n = Math.max(2, params.stops?.length ?? 2);
      return [{ key: 'stops.0.color', label: 'Shadows', type: 'color' }, { key: `stops.${n - 1}.color`, label: 'Highlights', type: 'color' }, CB('reverse', 'Reverse')];
    }
    case 'selective-color': {
      const out = [{ key: '__range', label: 'Colors', type: 'select', value: 'reds', options: SEL_RANGES, span: true }];
      for (const [r] of SEL_RANGES) {
        const when = (v) => v.__range === r;
        out.push(S(`${r}.c`, 'Cyan', -100, 100, 1, { when }), S(`${r}.m`, 'Magenta', -100, 100, 1, { when }), S(`${r}.y`, 'Yellow', -100, 100, 1, { when }), S(`${r}.k`, 'Black', -100, 100, 1, { when }));
      }
      out.push({ key: 'relative', label: 'Method', type: 'segment', options: [[true, 'Relative'], [false, 'Absolute']] });
      return out;
    }
    case 'shadows-highlights':
      return [S('shadows', 'Shadows amount', 0, 100), S('highlights', 'Highlights amount', 0, 100), S('radius', 'Tonal width (radius)', 0, 250)];
    default:
      return [];
  }
}

/** Values for buildForm from params (paths), with defaults filled in. */
function formValues(kind, params, fields) {
  const def = ADJUSTMENTS[kind]?.defaults ?? {};
  const v = {};
  for (const f of fields) {
    if (!f.key) continue;
    if (f.key.startsWith('__')) v[f.key] = f.value;
    else {
      const x = getPath(params, f.key);
      v[f.key] = x ?? getPath(def, f.key) ?? f.value ?? (f.type === 'checkbox' ? false : f.type === 'color' ? '#000000' : 0);
    }
  }
  return v;
}

function paramsFromForm(kind, base, values, fields) {
  const p = clone(base) ?? {};
  for (const f of fields) {
    if (!f.key || f.key.startsWith('__')) continue;
    if (kind === 'black-white' && f.key.startsWith('tint.')) continue;
    setPath(p, f.key, values[f.key]);
  }
  if (kind === 'black-white') p.tint = values.__tint ? { hue: values['tint.hue'] ?? 42, sat: values['tint.sat'] ?? 20 } : null;
  if (kind === 'channel-mixer' && p.monochrome && !p.gray) p.gray = { r: 40, g: 40, b: 20, constant: 0 };
  return p;
}

// ---- histogram drawing -------------------------------------------------------------------------------------

function drawHistogram(canvas, hist, channel = 'l') {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const data = hist?.[channel];
  if (!data) return;
  let max = 0;
  const sorted = Array.from(data).sort((a, b) => b - a);
  max = sorted[2] || sorted[0] || 1; // ignore a couple of spikes
  ctx.fillStyle = { r: 'rgba(220,60,60,0.8)', g: 'rgba(60,170,60,0.8)', b: 'rgba(60,100,230,0.8)', l: 'rgba(140,140,140,0.85)' }[channel];
  for (let i = 0; i < 256; i++) {
    const v = Math.min(1, data[i] / max);
    const x = (i / 256) * w;
    ctx.fillRect(x, h - v * h, Math.ceil(w / 256), v * h);
  }
}

function sourceHistogram(source) {
  if (!source) return null;
  try {
    return histogram(source);
  } catch {
    return null;
  }
}

// ---- Levels editor ---------------------------------------------------------------------------------------------

const LEVEL_DEFAULT = { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 };

function levelsEditor(params, onChange, source) {
  const p = clone(params);
  p.rgb = { ...LEVEL_DEFAULT, ...(p.rgb ?? {}) };
  const hist = sourceHistogram(source);
  const el = document.createElement('div');
  el.className = 'levels-editor';
  let channel = 'rgb';
  const form = () => {
    const lv = { ...LEVEL_DEFAULT, ...(p[channel] ?? {}) };
    return lv;
  };
  const top = document.createElement('div');
  top.className = 'prop-row';
  top.innerHTML = '<span>Channel</span>';
  const sel = document.createElement('select');
  sel.className = 'select';
  for (const [v, l] of [['rgb', 'RGB'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue']]) sel.add(new Option(l, v));
  top.appendChild(sel);
  const auto = document.createElement('button');
  auto.type = 'button';
  auto.className = 'btn small';
  auto.textContent = 'Auto';
  top.appendChild(auto);
  el.appendChild(top);
  const canvas = document.createElement('canvas');
  canvas.className = 'histogram';
  canvas.width = 256;
  canvas.height = 80;
  el.appendChild(canvas);
  const grid = document.createElement('div');
  el.appendChild(grid);
  let ui = null;
  const rebuild = () => {
    drawHistogram(canvas, hist, channel === 'rgb' ? 'l' : channel);
    const lv = form();
    ui = buildForm(
      [
        { type: 'section', label: 'Input levels' },
        S('inBlack', 'Shadows', 0, 253),
        S('gamma', 'Midtones (gamma)', 0.1, 9.99, 0.01),
        S('inWhite', 'Highlights', 2, 255),
        { type: 'section', label: 'Output levels' },
        S('outBlack', 'Black', 0, 255),
        S('outWhite', 'White', 0, 255),
      ],
      {
        values: lv,
        onChange: (v) => {
          if (v.inWhite <= v.inBlack + 1) v.inWhite = Math.min(255, v.inBlack + 2);
          p[channel] = { inBlack: v.inBlack, inWhite: v.inWhite, gamma: v.gamma, outBlack: v.outBlack, outWhite: v.outWhite };
          if (channel !== 'rgb') p.perChannel = true;
          onChange(clone(p));
        },
      },
    );
    grid.replaceChildren(ui.element);
  };
  sel.addEventListener('change', () => {
    channel = sel.value;
    rebuild();
  });
  auto.addEventListener('click', () => {
    if (!hist) return;
    const clip = (h) => {
      const n = hist.count * 0.001;
      let lo = 0, hi = 255, cum = 0;
      for (let i = 0; i < 256; i++) if ((cum += h[i]) > n) {
        lo = i;
        break;
      }
      cum = 0;
      for (let i = 255; i >= 0; i--) if ((cum += h[i]) > n) {
        hi = i;
        break;
      }
      return hi > lo ? { ...LEVEL_DEFAULT, inBlack: lo, inWhite: hi } : { ...LEVEL_DEFAULT };
    };
    p.rgb = { ...LEVEL_DEFAULT };
    p.r = clip(hist.r);
    p.g = clip(hist.g);
    p.b = clip(hist.b);
    p.perChannel = true;
    rebuild();
    onChange(clone(p));
  });
  rebuild();
  return { element: el };
}

// ---- Curves editor --------------------------------------------------------------------------------------------

const CURVE_PRESETS = {
  linear: [[0, 0], [255, 255]],
  contrast: [[0, 0], [64, 48], [192, 208], [255, 255]],
  'strong-contrast': [[0, 0], [64, 32], [192, 224], [255, 255]],
  lighter: [[0, 0], [128, 160], [255, 255]],
  darker: [[0, 0], [128, 96], [255, 255]],
  negative: [[0, 255], [255, 0]],
};

function curvesEditor(params, onChange, source) {
  const p = clone(params);
  p.rgb = p.rgb?.length ? p.rgb : [[0, 0], [255, 255]];
  const hist = sourceHistogram(source);
  let channel = 'rgb';
  let selected = -1;
  const el = document.createElement('div');
  el.className = 'curves-editor';
  const top = document.createElement('div');
  top.className = 'prop-row';
  top.innerHTML = '<span>Channel</span>';
  const sel = document.createElement('select');
  sel.className = 'select';
  for (const [v, l] of [['rgb', 'RGB'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue']]) sel.add(new Option(l, v));
  top.appendChild(sel);
  const preset = document.createElement('select');
  preset.className = 'select';
  preset.add(new Option('Preset…', ''));
  for (const [k, l] of [['linear', 'Linear'], ['contrast', 'Medium contrast'], ['strong-contrast', 'Strong contrast'], ['lighter', 'Lighter'], ['darker', 'Darker'], ['negative', 'Negative']]) preset.add(new Option(l, k));
  top.appendChild(preset);
  el.appendChild(top);
  const canvas = document.createElement('canvas');
  canvas.className = 'curve-editor';
  canvas.width = 256;
  canvas.height = 256;
  canvas.tabIndex = 0;
  el.appendChild(canvas);
  const info = document.createElement('div');
  info.className = 'prop-row';
  info.innerHTML = '<span>Input / Output</span>';
  const inIn = document.createElement('input');
  inIn.className = 'input num';
  inIn.type = 'number';
  inIn.min = '0';
  inIn.max = '255';
  const outIn = inIn.cloneNode();
  info.append(inIn, outIn);
  el.appendChild(info);
  const hint = document.createElement('div');
  hint.className = 'muted';
  hint.style.fontSize = '11px';
  hint.textContent = 'Click to add a point, drag to shape the curve, drag a point off the graph (or press Delete) to remove it.';
  el.appendChild(hint);

  const pts = () => {
    if (!p[channel]?.length) p[channel] = [[0, 0], [255, 255]];
    return p[channel];
  };
  const emit = () => onChange(clone(p));
  const draw = () => {
    const ctx = canvas.getContext('2d');
    const css = getComputedStyle(canvas);
    const fg = css.color || '#ddd';
    ctx.clearRect(0, 0, 256, 256);
    if (hist) {
      const tmp = document.createElement('canvas');
      tmp.width = 256;
      tmp.height = 256;
      drawHistogram(tmp, hist, channel === 'rgb' ? 'l' : channel);
      ctx.globalAlpha = 0.35;
      ctx.drawImage(tmp, 0, 0);
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = 'rgba(128,128,128,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 4; i++) {
      ctx.moveTo(i * 64 + 0.5, 0);
      ctx.lineTo(i * 64 + 0.5, 256);
      ctx.moveTo(0, i * 64 + 0.5);
      ctx.lineTo(256, i * 64 + 0.5);
    }
    ctx.moveTo(0, 256);
    ctx.lineTo(256, 0);
    ctx.stroke();
    const lut = curveLut(pts());
    ctx.strokeStyle = { rgb: fg, r: '#e04040', g: '#30b040', b: '#3070f0' }[channel];
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = 0; x < 256; x++) {
      const y = 255 - lut[x];
      if (x) ctx.lineTo(x + 0.5, y + 0.5);
      else ctx.moveTo(0.5, y + 0.5);
    }
    ctx.stroke();
    pts().forEach(([x, y], i) => {
      ctx.fillStyle = i === selected ? ctx.strokeStyle : '#ffffff';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.fillRect(x - 3.5, 255 - y - 3.5, 7, 7);
      ctx.strokeRect(x - 3.5, 255 - y - 3.5, 7, 7);
    });
    const s = pts()[selected];
    inIn.value = s ? String(Math.round(s[0])) : '';
    outIn.value = s ? String(Math.round(s[1])) : '';
  };
  const toLocal = (e) => {
    const r = canvas.getBoundingClientRect();
    return [Math.max(0, Math.min(255, ((e.clientX - r.left) / r.width) * 256)), Math.max(0, Math.min(255, 255 - ((e.clientY - r.top) / r.height) * 256))];
  };
  let dragging = false;
  canvas.addEventListener('pointerdown', (e) => {
    const [x, y] = toLocal(e);
    const list = pts();
    let idx = list.findIndex(([px, py]) => Math.hypot(px - x, py - y) < 8);
    if (idx < 0) {
      list.push([Math.round(x), Math.round(y)]);
      list.sort((a, b) => a[0] - b[0]);
      idx = list.findIndex(([px, py]) => px === Math.round(x) && py === Math.round(y));
      emit();
    }
    selected = idx;
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    draw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging || selected < 0) return;
    const list = pts();
    const r = canvas.getBoundingClientRect();
    const outside = e.clientY < r.top - 20 || e.clientY > r.bottom + 20 || e.clientX < r.left - 20 || e.clientX > r.right + 20;
    if (outside && list.length > 2) {
      list.splice(selected, 1);
      selected = -1;
      dragging = false;
      draw();
      emit();
      return;
    }
    let [x, y] = toLocal(e);
    const prev = list[selected - 1], next = list[selected + 1];
    if (prev) x = Math.max(prev[0] + 1, x);
    if (next) x = Math.min(next[0] - 1, x);
    list[selected] = [Math.round(x), Math.round(y)];
    draw();
    emit();
  });
  canvas.addEventListener('pointerup', () => (dragging = false));
  canvas.addEventListener('keydown', (e) => {
    const list = pts();
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected >= 0 && list.length > 2) {
      list.splice(selected, 1);
      selected = -1;
      e.preventDefault();
      e.stopPropagation();
      draw();
      emit();
    }
  });
  const numEdit = () => {
    const list = pts();
    if (selected < 0) return;
    const x = Math.max(0, Math.min(255, Number(inIn.value))), y = Math.max(0, Math.min(255, Number(outIn.value)));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    list[selected] = [x, y];
    list.sort((a, b) => a[0] - b[0]);
    selected = list.findIndex((q) => q[0] === x && q[1] === y);
    draw();
    emit();
  };
  inIn.addEventListener('change', numEdit);
  outIn.addEventListener('change', numEdit);
  sel.addEventListener('change', () => {
    channel = sel.value;
    selected = -1;
    draw();
  });
  preset.addEventListener('change', () => {
    if (!preset.value) return;
    p[channel] = clone(CURVE_PRESETS[preset.value]);
    preset.value = '';
    selected = -1;
    draw();
    emit();
  });
  requestAnimationFrame(draw);
  draw();
  return { element: el };
}

/**
 * Editor element for an adjustment's parameters. onChange(params) fires on every edit.
 * source: ImageDataLike used for histograms (Levels, Curves).
 */
export function buildAdjustmentEditor(kind, params, onChange, { source = null } = {}) {
  const base = { ...clone(ADJUSTMENTS[kind]?.defaults ?? {}), ...clone(params ?? {}) };
  if (kind === 'levels') return levelsEditor(base, onChange, source);
  if (kind === 'curves') return curvesEditor(base, onChange, source);
  const fields = fieldSpecs(kind, base);
  if (!fields.length) {
    const el = document.createElement('p');
    el.className = 'muted';
    el.textContent = 'This adjustment has no settings.';
    return { element: el };
  }
  let current = base;
  const form = buildForm(fields, {
    values: formValues(kind, base, fields),
    onChange: (values) => {
      current = paramsFromForm(kind, current, values, fields);
      onChange(clone(current));
    },
  });
  return { element: form.element, form };
}

// ---- pixel edit sessions ------------------------------------------------------------------------------------

/**
 * Starts a destructive edit of the active pixels (layer or mask) limited to the selection.
 * Returns { base, rect, show(img), commit(label), cancel() } or null. `base` is an ImageDataLike
 * copy of the affected region (colour for layers, grey for masks); show() previews a processed
 * copy of base in place.
 */
export function beginPixelEdit(app, { quiet = false, label = 'Edit', margin = 0 } = {}) {
  const d = app.doc;
  if (!d) return null;
  const t = app.pixelTarget?.({ quiet });
  if (!t) return null;
  const canvas = t.canvas;
  const sel = d.selection && !d.selection.isEmpty ? d.selection : null;
  const layerRect = { x: t.x, y: t.y, width: canvas.width, height: canvas.height };
  // neighbourhood filters read a margin around the selection so its edges blend with the surroundings
  const selRect = sel && margin > 0 ? { x: sel.bounds.x - margin, y: sel.bounds.y - margin, width: sel.bounds.width + margin * 2, height: sel.bounds.height + margin * 2 } : sel?.bounds;
  const docRect = sel ? intersectRect(selRect, layerRect) : layerRect;
  if (!docRect) {
    if (!quiet) app.dialogs.toast('The selected area is empty on this layer', { kind: 'error' });
    return null;
  }
  const local = { x: docRect.x - t.x, y: docRect.y - t.y, width: docRect.width, height: docRect.height };
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const original = ctx.getImageData(local.x, local.y, local.width, local.height);
  // selection alpha for the region
  let selAlpha = null;
  if (sel) {
    selAlpha = new Uint8ClampedArray(local.width * local.height);
    for (let y = 0; y < local.height; y++) {
      const sy = docRect.y + y;
      if (sy < 0 || sy >= d.height) continue;
      for (let x = 0; x < local.width; x++) {
        const sx = docRect.x + x;
        if (sx < 0 || sx >= d.width) continue;
        selAlpha[y * local.width + x] = sel.mask[sy * d.width + sx];
      }
    }
  }
  const isMask = !!t.mask;
  // masks are edited as grey images (alpha -> grey)
  const toWork = (img) => {
    const data = new Uint8ClampedArray(img.data);
    if (isMask) for (let i = 0; i < data.length; i += 4) {
      data[i] = data[i + 1] = data[i + 2] = data[i + 3];
      data[i + 3] = 255;
    }
    return { width: img.width, height: img.height, data };
  };
  const base = toWork(original);
  let shown = false;
  const compose = (img) => {
    const out = new ImageData(local.width, local.height);
    const o = out.data, src = original.data, res = img.data;
    for (let i = 0, p = 0; i < o.length; i += 4, p++) {
      let r, g, b, a;
      if (isMask) {
        const grey = (res[i] * 299 + res[i + 1] * 587 + res[i + 2] * 114) / 1000;
        r = g = b = 255;
        a = grey;
      } else {
        r = res[i];
        g = res[i + 1];
        b = res[i + 2];
        a = res[i + 3];
      }
      if (selAlpha) {
        const k = selAlpha[p] / 255;
        o[i] = src[i] + (r - src[i]) * k;
        o[i + 1] = src[i + 1] + (g - src[i + 1]) * k;
        o[i + 2] = src[i + 2] + (b - src[i + 2]) * k;
        o[i + 3] = src[i + 3] + (a - src[i + 3]) * k;
      } else {
        o[i] = r;
        o[i + 1] = g;
        o[i + 2] = b;
        o[i + 3] = a;
      }
    }
    return out;
  };
  const session = {
    target: t,
    base,
    rect: docRect,
    local,
    show(img) {
      ctx.putImageData(compose(img), local.x, local.y);
      shown = true;
      t.layer.touch();
      d.changed(isMask ? 'mask' : 'pixels', { layer: t.layer, rect: docRect });
    },
    restore() {
      if (!shown) return;
      ctx.putImageData(original, local.x, local.y);
      shown = false;
      t.layer.touch();
      d.changed(isMask ? 'mask' : 'pixels', { layer: t.layer, rect: docRect });
    },
    cancel() {
      session.restore();
    },
    /** Records the current (shown) state as one undo entry; img (optional) is applied first. */
    commit(entryLabel = label, img = null) {
      if (img) session.show(img);
      if (!shown) return null;
      const after = ctx.getImageData(local.x, local.y, local.width, local.height);
      const apply = (data) => {
        canvas.getContext('2d').putImageData(data, local.x, local.y);
        t.layer.touch();
        d.changed(isMask ? 'mask' : 'pixels', { layer: t.layer, rect: docRect });
      };
      const entry = { label: entryLabel, undo: () => apply(original), redo: () => apply(after), bytes: original.data.length * 2, at: Date.now() };
      d.history.push(entry);
      d.changed('history');
      app.lastPixelEdit = { doc: d, entry, label: entryLabel, canvas, local, original, after, layer: t.layer, isMask };
      app.commands.invalidate();
      return after;
    },
  };
  return session;
}

/** Runs fn(img) on a copy of the session base and returns it. */
export function processed(session, fn) {
  const img = { width: session.base.width, height: session.base.height, data: new Uint8ClampedArray(session.base.data) };
  fn(img);
  return img;
}

/**
 * Generic dialog driving a pixel edit: editor(onChange) -> { element }, run(img, params) edits img in place.
 * Resolves with the params (committed) or null.
 */
export async function pixelEditDialog(app, { title, label = title, params, editor, run, width = 420, extraButtons, margin = 0 }) {
  const session = beginPixelEdit(app, { label, margin });
  if (!session) return null;
  let current = params;
  let preview = app.settings.dialogPreview !== false;
  let done = false;
  const refresh = frameThrottle(() => {
    if (done) return;
    if (!preview) return session.restore();
    try {
      session.show(processed(session, (img) => run(img, current)));
    } catch (err) {
      console.error(err);
    }
  });
  const ed = editor((p) => {
    current = p;
    refresh();
  }, session);
  const content = document.createElement('div');
  content.appendChild(ed.element);
  const pv = document.createElement('label');
  pv.className = 'checkbox';
  const pvInput = document.createElement('input');
  pvInput.type = 'checkbox';
  pvInput.checked = preview;
  pvInput.dataset.key = '__preview';
  pvInput.addEventListener('change', () => {
    preview = pvInput.checked;
    app.settings.dialogPreview = preview;
    app.saveSettingsSoon();
    refresh();
  });
  pv.append(pvInput, document.createTextNode('Preview'));
  content.appendChild(pv);
  const result = await app.dialogs.open({
    title,
    content,
    width,
    buttons: [...(extraButtons ?? []), { label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }],
    onOpen: () => refresh(),
  });
  done = true;
  refresh.cancel();
  if (!result) {
    session.cancel();
    return null;
  }
  try {
    const img = await app.busy(`${title}…`, async () => processed(session, (x) => run(x, current)));
    session.commit(label, img);
  } catch (err) {
    session.cancel();
    app.reportError(err, `${title} failed`);
    return null;
  }
  return current;
}

// ---- install --------------------------------------------------------------------------------------------------

export function install(app) {
  const has = () => !!app.doc?.active;
  app.adjustments = Object.fromEntries(ADJUSTMENT_KINDS.map((k) => [k, { name: ADJUSTMENTS[k].name, defaults: startParams(k) }]));
  app.buildAdjustmentEditor = buildAdjustmentEditor;
  app.beginPixelEdit = (opts) => beginPixelEdit(app, opts);
  app.pixelEditDialog = (opts) => pixelEditDialog(app, opts);

  const lastParams = () => (app.settings.adjustLast ??= {});

  async function adjust(kind, arg) {
    const def = ADJUSTMENTS[kind];
    if (!def) return;
    const d = app.doc;
    // smart objects (lib/smart-object.js): an adjustment on a smart layer becomes a smart filter, not a pixel edit
    if (app.smartFilters?.intercept(d?.active, `adjust:${kind}`, arg && typeof arg === 'object' ? arg : null, def.name)) return;
    if (d?.active?.type === 'adjustment' && !app.ui.editingMask) {
      return app.dialogs.toast('Select a pixel layer (or add an adjustment layer from the Layers panel)', { kind: 'error' });
    }
    if (NO_PARAMS.has(kind) || (arg && typeof arg === 'object')) {
      const session = beginPixelEdit(app, { label: def.name });
      if (!session) return;
      const img = processed(session, (x) => applyAdjustment(x, kind, arg && typeof arg === 'object' ? arg : {}));
      session.commit(def.name, img);
      return;
    }
    const start = clone(lastParams()[kind] ?? startParams(kind));
    const used = await pixelEditDialog(app, {
      title: def.name,
      params: start,
      width: kind === 'curves' ? 320 : 420,
      editor: (onChange, session) => buildAdjustmentEditor(kind, start, onChange, { source: session.base }),
      run: (img, params) => applyAdjustment(img, kind, params),
    });
    if (used) {
      lastParams()[kind] = used;
      app.saveSettingsSoon();
    }
  }

  function auto(kind) {
    const fn = { tone: autoLevels, contrast: autoContrast, color: autoColor }[kind];
    const label = { tone: 'Auto Tone', contrast: 'Auto Contrast', color: 'Auto Color' }[kind];
    const session = beginPixelEdit(app, { label });
    if (!session) return;
    session.commit(label, processed(session, (img) => fn(img, { clip: 0.1 })));
  }

  /** Fade applies only while the last pixel edit is the current history state (not after undo + a new action). */
  function canFade() {
    const e = app.lastPixelEdit, d = app.doc;
    return !!e && !!d && e.doc === d && d.history.entries[d.history.index] === e.entry;
  }

  async function fade() {
    const e = app.lastPixelEdit;
    const d = app.doc;
    if (!canFade()) return app.dialogs.toast('Nothing to fade', { kind: 'error' });
    const render = (opacity, mode) => {
      const w = e.local.width, h = e.local.height;
      if (mode === 'normal') {
        // straight interpolation between before and after (alpha included)
        const A = e.original.data, B = e.after.data;
        const img = new ImageData(w, h);
        for (let i = 0; i < A.length; i++) img.data[i] = A[i] + (B[i] - A[i]) * opacity;
        return img;
      }
      if (!CANVAS_BLEND[mode]) {
        // modes Canvas 2D lacks (vivid light, hard mix, subtract, ...): blend in JS, keep the original alpha
        const dst = { width: w, height: h, data: new Uint8ClampedArray(e.original.data) };
        blendImages(mode, { width: w, height: h, data: e.after.data }, dst, opacity);
        for (let i = 3; i < dst.data.length; i += 4) dst.data[i] = e.original.data[i];
        return new ImageData(dst.data, w, h);
      }
      const a = createCanvas(w, h), b = createCanvas(w, h);
      a.getContext('2d').putImageData(e.original, 0, 0);
      b.getContext('2d').putImageData(e.after, 0, 0);
      const out = createCanvas(w, h);
      const ctx = out.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(a, 0, 0);
      ctx.globalAlpha = opacity;
      ctx.globalCompositeOperation = CANVAS_BLEND[mode] ?? 'source-over';
      ctx.drawImage(b, 0, 0);
      // keep the original alpha
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(a, 0, 0);
      return ctx.getImageData(0, 0, w, h);
    };
    const put = (data) => {
      e.canvas.getContext('2d').putImageData(data, e.local.x, e.local.y);
      e.layer.touch();
      d.changed('pixels', { layer: e.layer });
    };
    const opts = await formDialog(app, {
      title: `Fade ${e.label}`,
      fields: [
        { key: 'opacity', label: 'Opacity', type: 'slider', value: 100, min: 0, max: 100, unit: '%' },
        { key: 'mode', label: 'Mode', type: 'select', value: 'normal', options: BLEND_MODES.filter(Boolean).filter(([v]) => v !== 'pass-through') },
      ],
      live: {
        apply: (v) => put(render(v.opacity / 100, v.mode)),
        revert: () => put(e.after),
      },
    });
    if (!opts) return;
    const result = render(opts.opacity / 100, opts.mode);
    put(result);
    d.history.push({ label: `Fade ${e.label}`, undo: () => put(e.after), redo: () => put(result), bytes: result.data.length, at: Date.now() });
    d.changed('history');
  }

  async function editAdjustmentLayer(id) {
    const d = app.doc;
    const layer = (typeof id === 'string' && d.find(id)) || d.active;
    if (!layer || layer.type !== 'adjustment') return;
    if (app.panels?.panels?.has('properties')) {
      d.setActive(layer);
      app.panels.show('properties', { reveal: true });
      return;
    }
    // fallback: modal editor
    const before = clone(layer.params);
    const source = adjustmentSource(app, layer);
    const ed = buildAdjustmentEditor(layer.kind, layer.params, (p) => {
      layer.params = p;
      layer.touch();
      d.changed('props', { layer });
    }, { source });
    const ok = await app.dialogs.open({ title: layer.name, content: ed.element, buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }] });
    const after = clone(layer.params);
    layer.params = before;
    if (ok) setLayerProps(app, layer, { params: after }, `Edit ${layer.name}`);
    else {
      layer.touch();
      d.changed('props', { layer });
    }
  }

  async function editFillLayer(id) {
    const d = app.doc;
    const layer = (typeof id === 'string' && d.find(id)) || d.active;
    if (!layer || layer.type !== 'fill') return;
    const paint = layer.paint;
    if (paint.type === 'solid') {
      const c = await app.pickColor?.(paint.color, { title: 'Solid Color Fill', live: (color) => {
        layer.paint = { type: 'solid', color };
        layer.touch();
        d.changed('props', { layer });
      } });
      layer.paint = paint;
      layer.touch();
      if (c && c !== paint.color) setLayerProps(app, layer, { paint: { type: 'solid', color: c } }, 'Edit fill');
      else d.changed('props', { layer });
      return;
    }
    if (paint.type === 'pattern') {
      const o = await formDialog(app, {
        title: 'Pattern Fill',
        fields: [{ key: 'scale', label: 'Scale', type: 'slider', value: Math.round((paint.pattern?.scale ?? 1) * 100), min: 1, max: 1000, unit: '%' }],
        live: {
          apply: (v) => {
            layer.paint = { ...paint, pattern: { ...paint.pattern, scale: v.scale / 100 } };
            layer.touch();
            d.changed('props', { layer });
          },
          revert: () => {
            layer.paint = paint;
            layer.touch();
            d.changed('props', { layer });
          },
        },
      });
      if (o) setLayerProps(app, layer, { paint: { ...paint, pattern: { ...paint.pattern, scale: o.scale / 100 } } }, 'Edit fill');
      return;
    }
    // gradient
    const g = paint.gradient ?? {};
    const stops = g.stops ?? [];
    // read angle, scale and offset back from the stored end points (inverse of build() below)
    const radialNow = g.kind === 'radial' || g.kind === 'diamond' || g.kind === 'angle';
    let angleNow = 0, scaleNow = 100, offXNow = 0, offYNow = 0;
    if (g.from && g.to) {
      const vx = (g.to[0] - g.from[0]) / (radialNow ? 1 : 2), vy = (g.to[1] - g.from[1]) / (radialNow ? 1 : 2);
      const rad = Math.atan2(-vy, vx);
      angleNow = Math.round((rad * 180) / Math.PI);
      const half0 = (Math.abs(Math.cos(rad)) * d.width + Math.abs(Math.sin(rad)) * d.height) / 2 || 1;
      scaleNow = Math.round((Math.hypot(vx, vy) / half0) * 100);
      const cx = radialNow ? g.from[0] : (g.from[0] + g.to[0]) / 2, cy = radialNow ? g.from[1] : (g.from[1] + g.to[1]) / 2;
      offXNow = Math.round(((cx - d.width / 2) / d.width) * 100);
      offYNow = Math.round(((cy - d.height / 2) / d.height) * 100);
    }
    const build = (v) => {
      const rad = (v.angle * Math.PI) / 180;
      const cx = d.width / 2 + (v.offsetX / 100) * d.width, cy = d.height / 2 + (v.offsetY / 100) * d.height;
      const half = (Math.abs(Math.cos(rad)) * d.width + Math.abs(Math.sin(rad)) * d.height) / 2 * (v.scale / 100);
      const dx = Math.cos(rad) * half, dy = -Math.sin(rad) * half;
      const radial = v.kind === 'radial' || v.kind === 'diamond' || v.kind === 'angle';
      return {
        type: 'gradient',
        gradient: {
          kind: v.kind,
          stops: [{ pos: 0, color: v.c0 }, ...stops.slice(1, -1), { pos: 1, color: v.c1 }],
          reverse: v.reverse,
          from: radial ? [cx, cy] : [cx - dx, cy - dy],
          to: [cx + dx, cy + dy],
        },
      };
    };
    const o = await formDialog(app, {
      title: 'Gradient Fill',
      fields: [
        { key: 'kind', label: 'Style', type: 'select', value: g.kind ?? 'linear', options: [['linear', 'Linear'], ['radial', 'Radial'], ['angle', 'Angle'], ['reflected', 'Reflected'], ['diamond', 'Diamond']] },
        { key: 'c0', label: 'Start color', type: 'color', value: stops[0]?.color ?? '#000000' },
        { key: 'c1', label: 'End color', type: 'color', value: stops[stops.length - 1]?.color ?? '#ffffff' },
        { key: 'angle', label: 'Angle', type: 'slider', value: angleNow, min: -180, max: 180, unit: '°' },
        { key: 'scale', label: 'Scale', type: 'slider', value: Math.min(1000, Math.max(10, scaleNow)), min: 10, max: 1000, unit: '%' },
        { key: 'offsetX', label: 'Offset X', type: 'slider', value: Math.min(100, Math.max(-100, offXNow)), min: -100, max: 100, unit: '%' },
        { key: 'offsetY', label: 'Offset Y', type: 'slider', value: Math.min(100, Math.max(-100, offYNow)), min: -100, max: 100, unit: '%' },
        { key: 'reverse', label: 'Reverse', type: 'checkbox', value: !!g.reverse },
      ],
      live: {
        apply: (v) => {
          layer.paint = build(v);
          layer.touch();
          d.changed('props', { layer });
        },
        revert: () => {
          layer.paint = paint;
          layer.touch();
          d.changed('props', { layer });
        },
      },
    });
    if (o) setLayerProps(app, layer, { paint: build(o) }, 'Edit gradient fill');
  }

  app.adjustmentLayerMenu = () => [
    { type: 'title', label: 'Fill' },
    { label: 'Solid Color…', icon: 'fill', onSelect: () => app.commands.run('layer:new-fill', 'solid', 'panel') },
    { label: 'Gradient…', icon: 'gradient', onSelect: () => app.commands.run('layer:new-fill', 'gradient', 'panel') },
    { label: 'Pattern…', icon: 'pattern-stamp', onSelect: () => app.commands.run('layer:new-fill', 'pattern', 'panel') },
    { type: 'separator' },
    { type: 'title', label: 'Adjustment' },
    ...LAYER_KINDS.map((k) => ({ label: `${ADJUSTMENTS[k].name}…`, icon: ADJUSTMENT_ICONS[k] ?? 'adjust', onSelect: () => app.commands.run('layer:new-adjustment', k, 'panel') })),
  ];

  const cmds = {
    'image:adjust': { enabled: has, run: (kind) => adjust(kind) },
    'image:auto-tone': { enabled: has, run: () => auto('tone'), label: 'Auto Tone' },
    'image:auto-contrast': { enabled: has, run: () => auto('contrast'), label: 'Auto Contrast' },
    'image:auto-color': { enabled: has, run: () => auto('color'), label: 'Auto Color' },
    'edit:fade': { enabled: () => canFade(), run: fade, label: 'Fade…' },
    'layer:edit-adjustment': { enabled: () => app.doc?.active?.type === 'adjustment', run: editAdjustmentLayer },
    'layer:edit-fill': { enabled: () => app.doc?.active?.type === 'fill', run: editFillLayer },
  };
  for (const k of ADJUSTMENT_KINDS) cmds[`image:adjust-${k}`] = { enabled: has, run: (arg) => adjust(k, arg), label: `${ADJUSTMENTS[k].name}${NO_PARAMS.has(k) ? '' : '…'}` };
  app.commands.registerAll(cmds);
  void DIRECT_ONLY;
  void levelsLut;
}

/** Composite of everything below an adjustment layer (for its histogram). */
export function adjustmentSource(app, layer) {
  const d = app.doc;
  try {
    const skip = new Set();
    let found = false;
    for (const l of d.layers()) {
      if (l === layer) found = true;
      if (found) skip.add(l);
    }
    const c = d.view.compositor.composite(d, { skip });
    const small = createCanvas(Math.min(512, d.width), Math.max(1, Math.round((Math.min(512, d.width) / d.width) * d.height)));
    small.getContext('2d').drawImage(c, 0, 0, small.width, small.height);
    return small.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, small.width, small.height);
  } catch {
    const flat = flattenDocument(d);
    return flat.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, flat.width, flat.height);
  }
}
