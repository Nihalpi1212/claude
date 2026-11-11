// Dialogs of Image > Mode (lib/modes.js): Bitmap, Duotone Options, Indexed Color, Color Table, Trap,
// Conditional Mode Change and the "Flatten image before mode change?" question. Each resolves with
// plain, serialisable options (they are recorded in actions and replayed without a dialog) or null.
//
// Previews never touch the document: a dialog hands the canvas view a processed copy of the composite
// to draw instead (view.postProcess, the hook Proof Colors uses) and takes it away again when it closes.
import { bridge } from '../bridge.js';
import { formDialog, debounce } from '../form.js';
import { createCanvas } from '../document.js';
import { Compositor } from '../compositor.js';
import { parseColor, rgbaToHex } from '../../../shared/pixels/color.js';
import { curveLut } from '../../../shared/pixels/adjust.js';
import { MODES, MODE_IDS, toBitmap, toGrayscale, applyDuotone, duotoneLut, normalizeDuotone, DUOTONE_PRESETS, DUOTONE_TYPES, HALFTONE_SHAPES } from '../../../shared/pixels/modes.js';
import { quantize, indicesToImage, countColors, parseAct, writeAct, macSystemPalette, windowsSystemPalette, BAYER8, hashNoise } from '../../../shared/pixels/quantize.js';

const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style') Object.assign(node.style, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
};
const hexOf = (c) => rgbaToHex([c[0], c[1], c[2], 1]);
const rgbOf = (hex) => parseColor(hex).slice(0, 3).map((v) => Math.round(v));

// ---- previews --------------------------------------------------------------------------------------------------

/** What the document shows now (the composite through its mode), as a private ImageData copy. */
export function shownImage(doc) {
  const c = doc.view?.compositor ? doc.view.compositor.composite(doc) : new Compositor().composite(doc);
  return c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, doc.width, doc.height);
}

/** The composite before the mode pass (duotone and grey documents: the pixels themselves). */
function rawImage(doc) {
  const c = new Compositor().composite(doc, { rawMode: true });
  return c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, doc.width, doc.height);
}

/** Shows a canvas in place of the document's composite until clear() is called. */
export function viewPreview(doc) {
  const view = doc.view;
  const previous = view?.postProcess ?? null;
  let shown = null;
  return {
    show(canvas) {
      if (!view) return;
      shown = canvas;
      view.postProcess = () => shown;
      view.invalidate();
    },
    clear() {
      if (!view) return;
      shown = null;
      view.postProcess = previous;
      view.invalidate();
    },
  };
}

function canvasFromImage(img) {
  const c = createCanvas(img.width, img.height);
  c.getContext('2d').putImageData(img instanceof ImageData ? img : new ImageData(img.data, img.width, img.height), 0, 0);
  return c;
}

// ---- flatten question -----------------------------------------------------------------------------------------

/** Photoshop's question for layered documents: resolves 'flatten', 'keep' or null (cancel). */
export function flattenChoice(app, modeName) {
  const content = el('div', {}, el('p', { class: 'dialog-message', textContent: 'Changing modes can affect the appearance of layers. Flatten image before mode change?' }), el('p', { class: 'muted', textContent: `Layers are converted to ${modeName} one by one when they are kept; blending them can then look different from the flattened picture.` }));
  return app.dialogs.open({ title: modeName, content, width: 440, buttons: [{ label: 'Cancel', value: null }, { label: "Don't Flatten", value: 'keep' }, { label: 'Flatten', value: 'flatten', primary: true }] });
}

// ---- Bitmap ---------------------------------------------------------------------------------------------------

/** Built-in threshold tiles for Bitmap's Custom Pattern (greys are thresholds: dark pixels turn black first). */
export const BITMAP_PATTERNS = [
  ['bayer4', 'Fine dither (4 × 4)'],
  ['lines', 'Horizontal lines'],
  ['diagonal', 'Diagonal lines'],
  ['crosshatch', 'Crosshatch'],
  ['dots', 'Dots'],
  ['bricks', 'Bricks'],
  ['noise', 'Noise'],
];

const TILES = new Map();
/** The ImageDataLike tile of a pattern id (an ImageDataLike passes through). */
export function bitmapPatternTile(pattern) {
  if (pattern && typeof pattern === 'object' && pattern.data) return pattern;
  const id = BITMAP_PATTERNS.some(([p]) => p === pattern) ? pattern : 'bayer4';
  if (TILES.has(id)) return TILES.get(id);
  const size = id === 'bayer4' ? 4 : id === 'noise' ? 32 : 8;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let v;
    const tri = (t) => 1 - Math.abs(((t % size) + size) % size / size * 2 - 1); // 0 at the line, 1 half a period away
    switch (id) {
      case 'bayer4': v = ((BAYER8[y * 8 + x] >> 2) + 0.5) / 16; break; // the top-left quarter of the 8 × 8 matrix is 4 × the 4 × 4 one
      case 'lines': v = tri(y + 0.5); break;
      case 'diagonal': v = tri(x + y + 0.5); break;
      case 'crosshatch': v = Math.min(tri(x + y + 0.5), tri(x - y + 0.5)); break;
      case 'dots': v = Math.min(1, Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size * 0.7071)); break;
      case 'bricks': v = Math.min(tri(y * 2 + 0.5), tri(x + (y >= size / 2 ? size / 2 : 0) + 0.5)); break;
      default: v = hashNoise(x, y, 11);
    }
    const i = (y * size + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = Math.round(v * 255);
    data[i + 3] = 255;
  }
  const tile = { width: size, height: size, data };
  TILES.set(id, tile);
  return tile;
}

const BITMAP_METHOD_LABELS = [['50-threshold', '50% Threshold'], ['pattern-dither', 'Pattern Dither'], ['diffusion-dither', 'Diffusion Dither'], ['halftone-screen', 'Halftone Screen…'], ['custom-pattern', 'Custom Pattern']];

/** Bitmap: output resolution and method. Resolves { method, dpi, frequency, angle, shape, pattern } or null. */
export async function bitmapDialog(app, doc, last = {}) {
  const source = shownImage(doc);
  const preview = viewPreview(doc);
  const optionsOf = (v) => {
    const o = { method: v.method, dpi: Math.round(v.dpi) };
    if (v.method === 'halftone-screen') Object.assign(o, { frequency: v.frequency, angle: v.angle, shape: v.shape });
    if (v.method === 'custom-pattern') o.pattern = v.pattern;
    return o;
  };
  const values = await formDialog(app, {
    title: 'Bitmap',
    width: 420,
    fields: [
      { type: 'section', label: 'Resolution' },
      { key: 'input', type: 'custom', render: () => el('div', { class: 'muted', textContent: `Input: ${doc.dpi} pixels/inch` }) },
      { key: 'dpi', label: 'Output', type: 'number', value: doc.dpi, min: 1, max: 9600, unit: 'pixels/inch' },
      { type: 'section', label: 'Method' },
      { key: 'method', label: 'Use', type: 'select', value: BITMAP_METHOD_LABELS.some(([m]) => m === last.method) ? last.method : '50-threshold', options: BITMAP_METHOD_LABELS, span: true },
      { key: 'frequency', label: 'Frequency', type: 'number', value: last.frequency ?? 12, min: 1, max: 999, step: 0.1, unit: 'lines/inch', when: (v) => v.method === 'halftone-screen' },
      { key: 'angle', label: 'Angle', type: 'number', value: last.angle ?? 45, min: -180, max: 180, unit: '°', when: (v) => v.method === 'halftone-screen' },
      { key: 'shape', label: 'Shape', type: 'select', value: HALFTONE_SHAPES.includes(last.shape) ? last.shape : 'round', options: HALFTONE_SHAPES.map((s) => [s, s[0].toUpperCase() + s.slice(1)]), when: (v) => v.method === 'halftone-screen' },
      { key: 'pattern', label: 'Custom pattern', type: 'select', value: BITMAP_PATTERNS.some(([p]) => p === last.pattern) ? last.pattern : 'crosshatch', options: BITMAP_PATTERNS, when: (v) => v.method === 'custom-pattern' },
    ],
    live: {
      apply(v) {
        const img = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
        const o = optionsOf(v);
        // the preview stays at the document's resolution: the screen is drawn as large as it will print
        toBitmap(img, { ...o, dpi: doc.dpi, pattern: o.method === 'custom-pattern' ? bitmapPatternTile(o.pattern) : undefined });
        preview.show(canvasFromImage(img));
      },
      revert: () => preview.clear(),
    },
  });
  preview.clear();
  return values ? optionsOf(values) : null;
}

// ---- Duotone --------------------------------------------------------------------------------------------------

const TYPE_LABELS = { monotone: 'Monotone', duotone: 'Duotone', tritone: 'Tritone', quadtone: 'Quadtone' };
const DEFAULT_INKS = [
  { name: 'Black', color: '#000000' },
  { name: 'Sepia', color: '#a8713f' },
  { name: 'Orange', color: '#e8772e' },
  { name: 'Yellow', color: '#f6d13a' },
];

function drawCurve(canvas, curve, { points = false, selected = -1 } = {}) {
  const n = canvas.width;
  const ctx = canvas.getContext('2d');
  const fg = getComputedStyle(canvas).color || '#888';
  ctx.clearRect(0, 0, n, n);
  ctx.strokeStyle = 'rgba(128,128,128,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < 4; i++) {
    ctx.moveTo((i * n) / 4 + 0.5, 0);
    ctx.lineTo((i * n) / 4 + 0.5, n);
    ctx.moveTo(0, (i * n) / 4 + 0.5);
    ctx.lineTo(n, (i * n) / 4 + 0.5);
  }
  ctx.stroke();
  const lut = curveLut(curve.map(([x, y]) => [x * 2.55, y * 2.55]));
  ctx.strokeStyle = fg;
  ctx.lineWidth = points ? 1.5 : 1.25;
  ctx.beginPath();
  for (let x = 0; x < 256; x++) {
    const px = (x / 255) * (n - 1), py = (1 - lut[x] / 255) * (n - 1);
    if (x) ctx.lineTo(px + 0.5, py + 0.5);
    else ctx.moveTo(px + 0.5, py + 0.5);
  }
  ctx.stroke();
  if (!points) return;
  curve.forEach(([x, y], i) => {
    const px = (x / 100) * (n - 1), py = (1 - y / 100) * (n - 1);
    ctx.fillStyle = i === selected ? fg : '#ffffff';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1;
    ctx.fillRect(px - 3.5, py - 3.5, 7, 7);
    ctx.strokeRect(px - 3.5, py - 3.5, 7, 7);
  });
}

/** The Duotone Curve dialog of one ink: points map the grey's ink percentage (0 = white) to how much of the ink prints. */
function inkCurveDialog(app, ink) {
  let curve = ink.curve.map((p) => [...p]);
  let selected = -1;
  const N = 220;
  const canvas = el('canvas', { class: 'duotone-curve-editor curve-editor', width: N, height: N, tabIndex: 0 });
  const inIn = el('input', { class: 'input num', type: 'number', min: '0', max: '100', dataset: { key: 'curve-in' } });
  const outIn = el('input', { class: 'input num', type: 'number', min: '0', max: '100', dataset: { key: 'curve-out' } });
  const draw = () => {
    drawCurve(canvas, curve, { points: true, selected });
    const s = curve[selected];
    inIn.value = s ? String(Math.round(s[0])) : '';
    outIn.value = s ? String(Math.round(s[1])) : '';
    inIn.disabled = outIn.disabled = !s;
  };
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)), Math.max(0, Math.min(100, (1 - (e.clientY - r.top) / r.height) * 100)), e.clientX < r.left - 24 || e.clientX > r.right + 24 || e.clientY < r.top - 24 || e.clientY > r.bottom + 24];
  };
  canvas.addEventListener('pointerdown', (e) => {
    const [x, y] = pos(e);
    selected = curve.findIndex((p) => Math.abs(p[0] - x) < 4 && Math.abs(p[1] - y) < 4);
    if (selected < 0) {
      curve.push([x, y]);
      curve.sort((a, b) => a[0] - b[0]);
      selected = curve.findIndex((p) => p[0] === x && p[1] === y);
    }
    canvas.setPointerCapture(e.pointerId);
    draw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!canvas.hasPointerCapture(e.pointerId) || selected < 0) return;
    const [x, y, outside] = pos(e);
    // dragged well off the graph: the point is removed (the two ends stay)
    if (outside && curve.length > 2) {
      curve.splice(selected, 1);
      selected = -1;
      canvas.releasePointerCapture(e.pointerId);
      return draw();
    }
    const lo = selected > 0 ? curve[selected - 1][0] + 1 : 0, hi = selected < curve.length - 1 ? curve[selected + 1][0] - 1 : 100;
    curve[selected] = [Math.max(lo, Math.min(hi, x)), y];
    draw();
  });
  canvas.addEventListener('keydown', (e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected >= 0 && curve.length > 2) {
      curve.splice(selected, 1);
      selected = -1;
      draw();
      e.preventDefault();
    }
  });
  const typed = () => {
    if (selected < 0) return;
    const x = Number(inIn.value), y = Number(outIn.value);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    curve[selected] = [Math.max(0, Math.min(100, x)), Math.max(0, Math.min(100, y))];
    const p = curve[selected];
    curve.sort((a, b) => a[0] - b[0]);
    selected = curve.indexOf(p);
    draw();
  };
  inIn.addEventListener('change', typed);
  outIn.addEventListener('change', typed);
  const reset = el('button', { class: 'btn small', type: 'button', textContent: 'Reset', onclick: () => {
    curve = [[0, 0], [100, 100]];
    selected = -1;
    draw();
  } });
  const content = el('div', { class: 'duotone-curve' },
    canvas,
    el('div', { class: 'prop-row' }, el('span', { textContent: 'Grey % / Ink %' }), inIn, outIn, reset),
    el('div', { class: 'muted', textContent: 'Click to add a point, drag to shape how much ink prints for each tone, drag a point off the graph to remove it.' }));
  return app.dialogs.open({ title: `Duotone Curve — ${ink.name}`, content, width: 280, onOpen: draw, buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }] }).then((ok) => (ok ? curve.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]) : null));
}

/**
 * Duotone Options: type, up to four inks (curve, colour, name), presets. Resolves { duotone } or null.
 * The canvas previews the inks on the document's grey composite.
 */
export async function duotoneDialog(app, doc, { duotone = null, title = 'Duotone Options' } = {}) {
  const start = normalizeDuotone(duotone ?? DUOTONE_PRESETS.find((p) => p.id === 'sepia'));
  // four slots are kept so switching the type back and forth does not lose an ink
  const inks = [0, 1, 2, 3].map((i) => ({ ...(start.inks[i] ?? { ...DEFAULT_INKS[i], curve: [[0, 0], [100, 100]] }) }));
  let type = start.type;
  let previewOn = app.settings.dialogPreview !== false;
  const count = () => DUOTONE_TYPES.indexOf(type) + 1;
  const current = () => normalizeDuotone({ type, inks: inks.slice(0, count()) });

  const grey = rawImage(doc);
  toGrayscale(grey);
  const preview = viewPreview(doc);
  let closed = false;
  const refreshView = debounce(() => {
    if (closed) return;
    if (!previewOn) return preview.clear();
    const img = new ImageData(new Uint8ClampedArray(grey.data), grey.width, grey.height);
    applyDuotone(img, duotoneLut(current()));
    preview.show(canvasFromImage(img));
  }, 30);

  const presetSel = el('select', { class: 'select', dataset: { key: 'preset' } }, el('option', { value: 'custom', textContent: 'Custom' }), DUOTONE_PRESETS.map((p) => el('option', { value: p.id, textContent: p.name })));
  const typeSel = el('select', { class: 'select', dataset: { key: 'type' } }, DUOTONE_TYPES.map((t) => el('option', { value: t, textContent: TYPE_LABELS[t] })));
  const bar = el('canvas', { class: 'duotone-bar', width: 256, height: 1 });
  const rows = inks.map((ink, i) => {
    const curveBtn = el('canvas', { class: 'duotone-curve-thumb', width: 36, height: 36, title: 'Edit the ink curve', tabIndex: 0, role: 'button', dataset: { act: 'curve', ink: String(i) } });
    const swatch = el('button', { class: 'duotone-swatch', type: 'button', title: 'Choose the ink colour', dataset: { act: 'color', ink: String(i) } });
    const name = el('input', { class: 'input', value: ink.name, spellcheck: false, dataset: { key: `ink-name-${i}` } });
    const editCurve = async () => {
      const curve = await inkCurveDialog(app, ink);
      if (!curve) return;
      ink.curve = curve;
      presetSel.value = 'custom';
      sync();
    };
    curveBtn.addEventListener('click', editCurve);
    curveBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        editCurve();
      }
    });
    swatch.addEventListener('click', async () => {
      const c = await app.pickColor(ink.color, { title: `Ink ${i + 1} Color` });
      if (!c) return;
      ink.color = c;
      presetSel.value = 'custom';
      sync();
    });
    name.addEventListener('input', () => {
      ink.name = name.value;
      presetSel.value = 'custom';
    });
    return { row: el('div', { class: 'duotone-ink', dataset: { ink: String(i) } }, el('span', { class: 'duotone-ink-label', textContent: `Ink ${i + 1}:` }), curveBtn, swatch, name), curveBtn, swatch, name };
  });

  function sync() {
    typeSel.value = type;
    rows.forEach((r, i) => {
      const on = i < count();
      r.row.classList.toggle('off', !on);
      r.name.disabled = r.swatch.disabled = !on;
      r.name.value = inks[i].name;
      r.swatch.style.background = inks[i].color;
      drawCurve(r.curveBtn, inks[i].curve);
    });
    const lut = duotoneLut(current());
    const img = new ImageData(256, 1);
    for (let x = 0; x < 256; x++) {
      img.data[x * 4] = lut[x * 3];
      img.data[x * 4 + 1] = lut[x * 3 + 1];
      img.data[x * 4 + 2] = lut[x * 3 + 2];
      img.data[x * 4 + 3] = 255;
    }
    bar.getContext('2d').putImageData(img, 0, 0);
    refreshView();
  }
  typeSel.addEventListener('change', () => {
    type = typeSel.value;
    presetSel.value = 'custom';
    sync();
  });
  presetSel.addEventListener('change', () => {
    const p = DUOTONE_PRESETS.find((x) => x.id === presetSel.value);
    if (!p) return;
    const n = normalizeDuotone(p);
    type = n.type;
    n.inks.forEach((k, i) => (inks[i] = { ...k, curve: k.curve.map((pt) => [...pt]) }));
    sync();
  });
  const match = DUOTONE_PRESETS.find((p) => JSON.stringify(normalizeDuotone(p)) === JSON.stringify(start));
  presetSel.value = match?.id ?? 'custom';

  const pv = el('input', { type: 'checkbox', checked: previewOn, dataset: { key: '__preview' } });
  pv.addEventListener('change', () => {
    previewOn = pv.checked;
    app.settings.dialogPreview = previewOn;
    app.saveSettingsSoon();
    refreshView();
  });
  const content = el('div', { class: 'duotone-dialog' },
    el('div', { class: 'prop-row' }, el('span', { textContent: 'Preset' }), presetSel),
    el('div', { class: 'prop-row' }, el('span', { textContent: 'Type' }), typeSel),
    rows.map((r) => r.row),
    el('div', { class: 'prop-row' }, el('button', { class: 'btn small', type: 'button', disabled: true, textContent: 'Overprint Colors…', title: 'Pigment overprints inks multiplicatively; custom overprint colours are not supported' })),
    bar,
    el('label', { class: 'checkbox' }, pv, 'Preview'));
  const ok = await app.dialogs.open({ title, content, width: 400, className: 'duotone-options', onOpen: sync, buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }] });
  closed = true;
  preview.clear();
  return ok ? { duotone: current() } : null;
}

// ---- Indexed Color --------------------------------------------------------------------------------------------

const PALETTE_LABELS = [['exact', 'Exact'], ['system-mac', 'System (Mac OS)'], ['system-win', 'System (Windows)'], ['web', 'Web'], ['uniform', 'Uniform'], ['perceptual', 'Local (Perceptual)'], ['selective', 'Local (Selective)'], ['adaptive', 'Local (Adaptive)'], ['custom', 'Custom…']];
const FORCED_LABELS = [['none', 'None'], ['black-white', 'Black and White'], ['primaries', 'Primaries'], ['web', 'Web']];
const DITHER_LABELS = [['none', 'None'], ['diffusion', 'Diffusion'], ['pattern', 'Pattern'], ['noise', 'Noise']];
const MATTE_LABELS = [['none', 'None'], ['foreground', 'Foreground Color'], ['background', 'Background Color'], ['white', 'White'], ['black', 'Black'], ['gray', '50% Gray'], ['custom', 'Custom…']];

function matteColor(app, kind, custom) {
  switch (kind) {
    case 'foreground': return rgbaToHex([...parseColor(app.settings.foreground ?? '#000000').slice(0, 3), 1]);
    case 'background': return rgbaToHex([...parseColor(app.settings.background ?? '#ffffff').slice(0, 3), 1]);
    case 'white': return '#ffffff';
    case 'black': return '#000000';
    case 'gray': return '#808080';
    case 'custom': return custom ?? '#ffffff';
    default: return null;
  }
}

/** Quantize options from form values (shared with Save for Web). */
export function indexedOptions(app, v) {
  const o = {
    palette: v.palette,
    colors: Math.round(v.colors),
    forced: v.forced,
    transparency: !!v.transparency,
    matte: matteColor(app, v.matteKind, v.matteColor),
    matteKind: v.matteKind,
    dither: v.dither,
    ditherAmount: v.ditherAmount,
    preserveExactColors: !!v.preserveExactColors,
  };
  if (v.palette === 'custom') o.custom = (v.custom ?? []).map((c) => [c[0], c[1], c[2]]);
  return o;
}

/** Form fields of the quantize options (Indexed Color and Save for Web share them). `state.custom` holds the custom table. */
export function indexedFields(app, last = {}, state = {}) {
  const fixed = (v) => ['exact', 'system-mac', 'system-win', 'web', 'custom'].includes(v.palette);
  return [
    { key: 'palette', label: 'Palette', type: 'select', value: PALETTE_LABELS.some(([p]) => p === last.palette) ? last.palette : 'adaptive', options: PALETTE_LABELS },
    { key: 'colors', label: 'Colors', type: 'number', value: Math.max(2, Math.min(256, Math.round(Number(last.colors) || 256))), min: 2, max: 256, disabled: (v) => v.palette === 'exact' || v.palette === 'custom' },
    { key: 'forced', label: 'Forced', type: 'select', value: FORCED_LABELS.some(([p]) => p === last.forced) ? last.forced : 'none', options: FORCED_LABELS, disabled: fixed },
    { key: 'transparency', label: 'Transparency', type: 'checkbox', value: last.transparency !== false },
    { key: 'matteKind', label: 'Matte', type: 'select', value: MATTE_LABELS.some(([p]) => p === last.matteKind) ? last.matteKind : 'none', options: MATTE_LABELS },
    { key: 'matteColor', label: 'Matte color', type: 'color', value: typeof last.matte === 'string' && last.matteKind === 'custom' ? last.matte : '#ffffff', when: (v) => v.matteKind === 'custom' },
    { key: 'dither', label: 'Dither', type: 'select', value: DITHER_LABELS.some(([p]) => p === last.dither) ? last.dither : 'diffusion', options: DITHER_LABELS },
    { key: 'ditherAmount', label: 'Amount', type: 'slider', value: Number.isFinite(last.ditherAmount) ? last.ditherAmount : 75, min: 1, max: 100, unit: '%', when: (v) => v.dither !== 'none' },
    { key: 'preserveExactColors', label: 'Preserve exact colors', type: 'checkbox', value: !!last.preserveExactColors, when: (v) => v.dither !== 'none' },
    { key: 'custom', type: 'custom', when: (v) => v.palette === 'custom', render: (values, set) => {
      values.custom = state.custom ?? last.custom ?? null;
      const info = el('span', { class: 'muted', textContent: values.custom ? `${values.custom.length} colors` : 'No table yet' });
      const edit = el('button', { class: 'btn small', type: 'button', textContent: 'Edit Table…', dataset: { act: 'edit-table' }, onclick: async () => {
        const result = await colorTableDialog(app, { table: values.custom ?? state.suggest?.() ?? [[0, 0, 0], [255, 255, 255]], transparentIndex: -1, title: 'Custom Color Table', allowTransparency: false });
        if (!result) return;
        state.custom = result.table;
        info.textContent = `${result.table.length} colors`;
        set('custom', result.table);
      } });
      return el('div', { class: 'prop-row' }, edit, info);
    } },
  ];
}

/** Indexed Color: palette, colours, forced colours, transparency, matte, dither. Resolves quantize options or null. */
export async function indexedDialog(app, doc, last = {}) {
  const source = shownImage(doc);
  const distinct = countColors(source, 256);
  const preview = viewPreview(doc);
  const info = el('div', { class: 'muted indexed-info', textContent: '' });
  // a custom table starts from the image's own best 256 colours
  const state = { custom: last.custom ?? null, suggest: () => quantize(source, { colors: 256, palette: 'adaptive', transparency: false }).palette };
  const start = { ...last };
  // an image that already has few colours keeps them exactly, as Photoshop proposes; one with more cannot
  if (distinct <= 256 && !['custom', 'web', 'system-mac', 'system-win', 'uniform'].includes(start.palette)) start.palette = 'exact';
  else if (start.palette === 'exact') start.palette = 'adaptive';
  let closed = false, wanted = false;
  const run = debounce((v) => {
    if (closed || !wanted) return; // a pending preview must not come back after the dialog is gone or Preview was unticked
    try {
      const q = quantize(source, indexedOptions(app, v));
      info.textContent = `${q.palette.length - (q.transparentIndex >= 0 ? 1 : 0)} colors${q.transparentIndex >= 0 ? ' + transparency' : ''}${distinct <= 256 ? ` (the image has ${distinct})` : ''}`;
      const img = indicesToImage(q.indices, q.palette, source.width, source.height, q.transparentIndex);
      preview.show(canvasFromImage(img));
    } catch (err) {
      info.textContent = err.message;
    }
  }, source.width * source.height > 600000 ? 220 : 60);
  const values = await formDialog(app, {
    title: 'Indexed Color',
    width: 460,
    fields: [...indexedFields(app, start, state), { key: 'info', type: 'custom', render: () => info }],
    onChange: (v, key, form) => {
      if (key === 'palette') {
        if (v.palette === 'exact' && distinct > 256) {
          app.dialogs.toast('The image has more than 256 colors: an adaptive palette is used instead', { kind: 'info', timeout: 2600 });
          form.set('palette', 'adaptive', { silent: true });
        }
        if (v.palette === 'web') form.set('colors', 216, { silent: true });
        if (v.palette === 'system-mac' || v.palette === 'system-win') form.set('colors', 256, { silent: true });
      }
    },
    live: {
      apply: (v) => {
        wanted = true;
        run(v);
      },
      revert: () => {
        wanted = false;
        preview.clear();
      },
    },
  });
  closed = true;
  preview.clear();
  if (!values) return null;
  const options = indexedOptions(app, values);
  if (options.palette === 'custom' && !options.custom?.length) options.custom = state.suggest();
  return options;
}

// ---- Color Table ----------------------------------------------------------------------------------------------

const TABLE_PRESETS = [['custom', 'Custom'], ['black-body', 'Black Body'], ['grayscale', 'Grayscale'], ['spectrum', 'Spectrum'], ['system-mac', 'System (Mac OS)'], ['system-win', 'System (Windows)']];

function presetTable(id) {
  if (id === 'system-mac') return macSystemPalette();
  if (id === 'system-win') return windowsSystemPalette();
  const out = [];
  for (let i = 0; i < 256; i++) {
    if (id === 'grayscale') out.push([i, i, i]);
    else if (id === 'black-body') {
      // black → red → yellow → white, the colours of a heated black body
      const t = i / 255;
      out.push([Math.round(Math.min(1, t * 3) * 255), Math.round(Math.min(1, Math.max(0, t * 3 - 1)) * 255), Math.round(Math.min(1, Math.max(0, t * 3 - 2)) * 255)]);
    } else {
      const h = (i / 256) * 6, f = h - Math.floor(h), q = Math.round((1 - f) * 255), t = Math.round(f * 255);
      out.push([[255, t, 0], [q, 255, 0], [0, 255, t], [0, q, 255], [t, 0, 255], [255, 0, q]][Math.floor(h) % 6]);
    }
  }
  return out;
}

/**
 * The Color Table editor: a 16 × 16 grid of the table's entries. Click a swatch to change it, drag over a range
 * to fill it with a gradient between two picked colours, click with the eyedropper to make an entry transparent,
 * load and save Adobe .act files. Resolves { table: [[r, g, b], ...], transparentIndex } or null.
 */
export function colorTableDialog(app, { table = [], transparentIndex = -1, title = 'Color Table', allowTransparency = true } = {}) {
  let colors = table.slice(0, 256).map((c) => [c[0], c[1], c[2]]);
  let ti = transparentIndex >= 0 && transparentIndex < colors.length ? transparentIndex : -1;
  let picking = false; // the transparency eyedropper
  let dragFrom = -1, dragTo = -1;
  const grid = el('div', { class: 'ct-grid', role: 'grid', 'aria-label': 'Color table' });
  const info = el('div', { class: 'muted ct-info', textContent: '' });
  const presetSel = el('select', { class: 'select', dataset: { key: 'ct-preset' } }, TABLE_PRESETS.map(([v, l]) => el('option', { value: v, textContent: l })));
  const dropper = el('button', { class: 'btn small ct-dropper', type: 'button', textContent: 'Transparency', title: 'Click, then click a color to make it transparent (click the transparent color again to clear)', dataset: { act: 'transparency' }, 'aria-pressed': 'false' });
  const cells = [];
  for (let i = 0; i < 256; i++) {
    const cell = el('button', { class: 'ct-cell', type: 'button', dataset: { index: String(i) } });
    cells.push(cell);
    grid.appendChild(cell);
  }
  const describe = (i) => (i >= 0 && i < colors.length ? `Index ${i}: ${hexOf(colors[i])}  (${colors[i].join(', ')})${i === ti ? ' — transparent' : ''}` : `${colors.length} colors${ti >= 0 ? `, index ${ti} is transparent` : ''}`);
  function sync() {
    const lo = Math.min(dragFrom, dragTo), hi = Math.max(dragFrom, dragTo);
    cells.forEach((cell, i) => {
      const filled = i < colors.length;
      cell.classList.toggle('filled', filled);
      cell.classList.toggle('transparent', i === ti);
      cell.classList.toggle('in-range', dragFrom >= 0 && i >= lo && i <= hi && lo !== hi);
      cell.style.background = filled ? hexOf(colors[i]) : '';
      cell.title = filled ? describe(i) : i === colors.length ? 'Add a color' : '';
      cell.disabled = i > colors.length || (i === colors.length && colors.length >= 256);
    });
    info.textContent = describe(-1);
    dropper.setAttribute('aria-pressed', String(picking));
    grid.classList.toggle('picking', picking);
  }
  const edited = () => {
    presetSel.value = 'custom';
    sync();
  };
  async function editOne(i) {
    const c = await app.pickColor(i < colors.length ? hexOf(colors[i]) : '#808080', { title: i < colors.length ? `Color ${i}` : 'New Color' });
    if (!c) return;
    colors[i] = rgbOf(c);
    edited();
  }
  async function fillRange(a, b) {
    const first = await app.pickColor(hexOf(colors[a]), { title: 'Select first color' });
    if (!first) return;
    const last = await app.pickColor(hexOf(colors[b]), { title: 'Select last color' });
    if (!last) return;
    const c0 = rgbOf(first), c1 = rgbOf(last);
    for (let i = a; i <= b; i++) {
      const t = (i - a) / (b - a);
      colors[i] = [0, 1, 2].map((k) => Math.round(c0[k] + (c1[k] - c0[k]) * t));
    }
    edited();
  }
  const indexAt = (e) => {
    const t = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.ct-cell');
    return t && grid.contains(t) ? Number(t.dataset.index) : -1;
  };
  grid.addEventListener('pointerdown', (e) => {
    const i = indexAt(e);
    if (i < 0 || i > colors.length || e.button !== 0) return;
    dragFrom = dragTo = i;
    grid.setPointerCapture(e.pointerId);
  });
  grid.addEventListener('pointermove', (e) => {
    const i = indexAt(e);
    if (i >= 0 && i < colors.length) info.textContent = describe(i);
    if (dragFrom < 0 || !grid.hasPointerCapture(e.pointerId)) return;
    if (i >= 0 && i < colors.length && i !== dragTo && dragFrom < colors.length) {
      dragTo = i;
      sync();
    }
  });
  grid.addEventListener('pointerup', (e) => {
    if (dragFrom < 0) return;
    if (grid.hasPointerCapture(e.pointerId)) grid.releasePointerCapture(e.pointerId);
    const a = Math.min(dragFrom, dragTo), b = Math.max(dragFrom, dragTo);
    dragFrom = dragTo = -1;
    sync();
    if (a !== b) return void fillRange(a, b);
    if (picking && a < colors.length) {
      ti = ti === a ? -1 : a;
      picking = false;
      return edited();
    }
    editOne(a);
  });
  grid.addEventListener('pointerleave', () => (info.textContent = describe(-1)));
  // keyboard: Enter/Space on a focused swatch edits it (pointer events cover the mouse)
  grid.addEventListener('keydown', (e) => {
    const i = Number(e.target?.dataset?.index);
    if ((e.key === 'Enter' || e.key === ' ') && Number.isInteger(i) && i <= colors.length) {
      e.preventDefault();
      if (picking && i < colors.length) {
        ti = ti === i ? -1 : i;
        picking = false;
        edited();
      } else editOne(i);
    }
  });
  dropper.addEventListener('click', () => {
    picking = !picking;
    sync();
  });
  presetSel.addEventListener('change', () => {
    if (presetSel.value === 'custom') return;
    colors = presetTable(presetSel.value);
    ti = -1;
    sync();
  });
  const load = el('button', { class: 'btn small', type: 'button', textContent: 'Load…', dataset: { act: 'load' }, onclick: async () => {
    try {
      const paths = await bridge.openFileDialog({ title: 'Load Color Table', filters: [{ name: 'Color tables', extensions: ['act'] }, { name: 'All files', extensions: ['*'] }] });
      const path = Array.isArray(paths) ? paths[0] : paths;
      if (!path) return;
      // the browser bridge reads a picked file asynchronously (lib/documents.js waits the same way)
      if (window.__pigmentTest?.pending?.[path]) await window.__pigmentTest.pending[path];
      const parsed = parseAct(await bridge.readFile(path));
      colors = parsed.palette;
      ti = allowTransparency ? parsed.transparentIndex : -1;
      edited();
    } catch (err) {
      app.reportError(err, 'Could not load the color table');
    }
  } });
  const save = el('button', { class: 'btn small', type: 'button', textContent: 'Save…', dataset: { act: 'save' }, onclick: async () => {
    try {
      const path = await bridge.saveFileDialog({ title: 'Save Color Table', defaultPath: 'Color Table.act', filters: [{ name: 'Color tables', extensions: ['act'] }] });
      if (!path) return;
      await bridge.writeFile(/\.act$/i.test(path) ? path : `${path}.act`, writeAct(colors, ti));
      app.dialogs.toast('Color table saved', { kind: 'success', timeout: 1600 });
    } catch (err) {
      app.reportError(err, 'Could not save the color table');
    }
  } });
  const content = el('div', { class: 'ct-dialog' },
    el('div', { class: 'prop-row' }, el('span', { textContent: 'Table' }), presetSel),
    grid,
    info,
    el('div', { class: 'ct-actions' }, allowTransparency ? dropper : null, el('span', { style: { flex: '1' } }), load, save),
    el('div', { class: 'muted', textContent: 'Click a color to change it; drag across colors to fill the range with a gradient between two colors.' }));
  return app.dialogs.open({ title, content, width: 380, className: 'color-table-dialog', onOpen: sync, buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }] }).then((ok) => (ok ? { table: colors.map((c) => [c[0], c[1], c[2]]), transparentIndex: ti } : null));
}

// ---- Trap, Conditional Mode Change ----------------------------------------------------------------------------

/** Trap: width in pixels, points or millimetres. Resolves { width: pixels } or null. */
export async function trapDialog(app, { width = 1, dpi = 72 } = {}) {
  const perUnit = { px: 1, pt: dpi / 72, mm: dpi / 25.4 };
  const v = await formDialog(app, {
    title: 'Trap',
    width: 340,
    intro: 'Spreads lighter inks under darker ones where two colors meet, so a press that misregisters shows no white gap.',
    fields: [
      { key: 'width', label: 'Width', type: 'number', value: width, min: 0.1, max: 10, step: 0.1 },
      { key: 'unit', label: 'Units', type: 'select', value: 'px', options: [['px', 'Pixels'], ['pt', 'Points'], ['mm', 'Millimeters']] },
    ],
  });
  if (!v) return null;
  return { width: Math.max(1, Math.min(10, Math.round(v.width * perUnit[v.unit]))) };
}

/** Conditional Mode Change: the modes to convert from and the mode to convert to. Resolves { sources, target } or null. */
export async function conditionalDialog(app, { current = 'rgb', sources = null, target = null } = {}) {
  const on = new Set(Array.isArray(sources) && sources.length ? sources : [current]);
  let form = null;
  const setAll = (value) => {
    for (const m of MODE_IDS) form?.set(`src-${m}`, value, { silent: true });
  };
  const v = await formDialog(app, {
    title: 'Conditional Mode Change',
    width: 420,
    intro: 'Converts the document only when it is in one of the source modes (useful in actions and Batch). The conversion uses the last options of the target mode and asks nothing.',
    fields: [
      { type: 'section', label: 'Source Mode' },
      ...MODE_IDS.map((m) => ({ key: `src-${m}`, label: MODES[m].name, type: 'checkbox', value: on.has(m) })),
      { key: 'buttons', type: 'custom', render: () => el('div', { class: 'prop-row' }, el('button', { class: 'btn small', type: 'button', textContent: 'All', dataset: { act: 'all' }, onclick: () => setAll(true) }), el('button', { class: 'btn small', type: 'button', textContent: 'None', dataset: { act: 'none' }, onclick: () => setAll(false) })) },
      { type: 'section', label: 'Target Mode' },
      { key: 'target', label: 'Mode', type: 'select', value: MODES[target] ? target : current === 'rgb' ? 'grayscale' : 'rgb', options: MODE_IDS.map((m) => [m, MODES[m].name]), span: true },
    ],
    onOpen: (dialog, f) => (form = f),
  });
  if (!v) return null;
  return { sources: MODE_IDS.filter((m) => v[`src-${m}`]), target: v.target };
}
