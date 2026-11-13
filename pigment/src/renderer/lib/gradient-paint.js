// Gradient paints (gradients package; ARCHITECTURE.md "0.4 features", G.3, G.5, L.9): the 'gradient' paint renderer,
// the 'gradient' paint editor of fill layers (New Fill Layer > Gradient, Layer Content Options, the Properties fill
// section) and the drop handler of application/x-pigment-gradient (a preset dragged from a panel onto the canvas or a
// layer row makes a Gradient Fill layer).
//
// Rendering: a classic solid gradient without dither stays a Canvas gradient (lib/paint.js canvasGradient: 0.3's
// output, GPU-fast); every other def (perceptual, linear, smooth and stripes methods, noise, dither) is rendered per
// pixel through src/shared/pixels/gradient-render.js over the part of the context's canvas that can be painted, and
// returned as a pattern.
import { registerPaintRenderer, canvasGradient } from './paint.js';
import { registerPaintEditor, resolvePaint } from './paint-editors.js';
import { formDialog } from './form.js';
import { normalizeGradient, isGradientV2 } from '../../shared/pixels/gradient-model.js';
import { renderGradient } from '../../shared/pixels/gradient-render.js';
import { STYLE_LABELS, gradientWidget } from './gradient-widget.js';
import { appColors, GRADIENT_MIME } from './gradient-picker.js';
import { defOnly } from './gradient-editor.js';
import { numericField } from './numeric-field.js';

const MAX_PIXELS = 64e6; // a per-pixel render larger than this falls back to the Canvas gradient

/** True when a Canvas gradient shows the def exactly: 0.3 shapes and classic solid v2 defs without dither. */
export function canvasCanDraw(g) {
  if (!isGradientV2(g)) return true; // 0.3 shapes are classic ramps (0.3 drew fill layers without dither)
  return g.type !== 'noise' && g.interpolation === 'classic' && !g.dither;
}

/**
 * The 'gradient' paint renderer (G.3): (ctx, paint, box, { origin, fg, bg }) -> fill style.
 */
export function gradientPaintStyle(ctx, paint, box, opts = {}) {
  let g = paint?.gradient ?? {};
  const ends = Array.isArray(g.from) && Array.isArray(g.to);
  // a paint with neither end points nor box placement (0.3's shapes) draws as 0.3's makeGradient did: left to right
  // across the box (radial and diamond from its left middle)
  const legacy = !ends && g.angle === undefined && g.scale === undefined && g.offset === undefined;
  // a draft (a drag of the on-canvas widget) is drawn as a Canvas gradient through samples of the model
  // (canvasStops): a few ms instead of a per-pixel render; the committed paint has no `_draft` and renders in full
  if (g._draft && ends) return canvasGradient(ctx, g, box, opts);
  if (legacy && canvasCanDraw(g)) return canvasGradient(ctx, g, box, opts);
  // without end points (shape paints, G.3) placement is relative to the box; a paint without an angle runs left to
  // right (the effects' default of 90° does not apply to paints)
  if (!ends && g.angle === undefined) g = { ...g, angle: 0 };
  if (canvasCanDraw(g)) {
    if (ends) return canvasGradient(ctx, g, box, opts);
    const fromTo = boxEnds(g, box, opts.origin ?? [0, 0]);
    // the box geometry of 'angle' turns the other way round than a conic gradient: that one is drawn per pixel
    if (fromTo) return canvasGradient(ctx, { ...g, ...fromTo }, box, opts);
  }
  // the region ctx can paint, in its user space: the canvas through the inverse of the current transform
  const canvas = ctx.canvas;
  const m = ctx.getTransform?.() ?? new DOMMatrix();
  const inv = m.inverse();
  const pts = [[0, 0], [canvas.width, 0], [0, canvas.height], [canvas.width, canvas.height]].map(([x, y]) => inv.transformPoint(new DOMPoint(x, y)));
  const x0 = Math.floor(Math.min(...pts.map((p) => p.x))), y0 = Math.floor(Math.min(...pts.map((p) => p.y)));
  const x1 = Math.ceil(Math.max(...pts.map((p) => p.x))), y1 = Math.ceil(Math.max(...pts.map((p) => p.y)));
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
  if (!Number.isFinite(w * h) || w * h > MAX_PIXELS) return canvasGradient(ctx, g, box, opts);
  const img = new ImageData(w, h);
  renderGradient(img, g, { box, origin: opts.origin ?? [0, 0], at: [x0, y0], fg: opts.fg, bg: opts.bg });
  const tile = document.createElement('canvas');
  tile.width = w;
  tile.height = h;
  tile.getContext('2d').putImageData(img, 0, 0);
  const pattern = ctx.createPattern(tile, 'no-repeat');
  pattern.setTransform(new DOMMatrix().translate(x0, y0));
  return pattern;
}

/**
 * Document-space from / to that make a Canvas gradient follow the box placement of gradient-model.js gradientT (angle,
 * scale, offset), or null for the 'angle' kind. Linear: the span through the moved centre; reflected, radial and
 * diamond: from the centre to its reach.
 */
export function boxEnds(g, box, origin = [0, 0]) {
  const kind = g.kind ?? 'linear';
  if (kind === 'angle' || kind === 'shape-burst') return null;
  const off = Array.isArray(g.offset) ? g.offset : [0, 0];
  const cx = box.x + box.width / 2 + ((off[0] ?? 0) / 100) * box.width + origin[0];
  const cy = box.y + box.height / 2 + ((off[1] ?? 0) / 100) * box.height + origin[1];
  const a = ((g.angle ?? 90) * Math.PI) / 180;
  const ux = Math.cos(a), uy = -Math.sin(a);
  const scale = Math.max(0.01, g.scale ?? 1);
  const len = Math.max(1e-6, (Math.abs(box.width * ux) + Math.abs(box.height * uy)) * scale);
  const rad = Math.max(1e-6, (Math.max(box.width, box.height) / 2) * scale);
  if (kind === 'linear') return { from: [cx - (ux * len) / 2, cy - (uy * len) / 2], to: [cx + (ux * len) / 2, cy + (uy * len) / 2] };
  const reach = kind === 'reflected' ? len / 2 : rad;
  return { from: [cx, cy], to: [cx + ux * reach, cy + uy * reach] };
}

// ---- fill-layer placement: from / to <-> angle, scale, offset ------------------------------------------------------------
// Fill layers store document-space `from` / `to` (G.1; Free Transform, Canvas Size and moves map them). Their dialog and
// Properties section show Photoshop's Angle, Scale and Offset, measured against the document: the gradient's centre
// is offset from the document's centre (percent of the document), and at 100 % a linear gradient spans the document
// along its angle.

const isCentred = (kind) => kind === 'radial' || kind === 'diamond' || kind === 'angle';

/** Angle (degrees, counter-clockwise), scale (%), offset (% of the document) of a fill gradient's from / to. */
export function fillPlacement(g, doc) {
  const radial = isCentred(g?.kind);
  if (!g?.from || !g?.to) return { angle: 0, scale: 100, offsetX: 0, offsetY: 0 };
  const vx = (g.to[0] - g.from[0]) / (radial ? 1 : 2), vy = (g.to[1] - g.from[1]) / (radial ? 1 : 2);
  const rad = Math.atan2(-vy, vx);
  const half0 = (Math.abs(Math.cos(rad)) * doc.width + Math.abs(Math.sin(rad)) * doc.height) / 2 || 1;
  const cx = radial ? g.from[0] : (g.from[0] + g.to[0]) / 2, cy = radial ? g.from[1] : (g.from[1] + g.to[1]) / 2;
  return {
    angle: Math.round((rad * 180) / Math.PI * 10) / 10,
    scale: Math.round((Math.hypot(vx, vy) / half0) * 1000) / 10,
    offsetX: Math.round(((cx - doc.width / 2) / doc.width) * 1000) / 10,
    offsetY: Math.round(((cy - doc.height / 2) / doc.height) * 1000) / 10,
  };
}

/** from / to for a kind, angle, scale and offset (the inverse of fillPlacement). */
export function fillEnds({ kind = 'linear', angle = 0, scale = 100, offsetX = 0, offsetY = 0 }, doc) {
  const rad = (angle * Math.PI) / 180;
  const cx = doc.width / 2 + (offsetX / 100) * doc.width, cy = doc.height / 2 + (offsetY / 100) * doc.height;
  const half = ((Math.abs(Math.cos(rad)) * doc.width + Math.abs(Math.sin(rad)) * doc.height) / 2) * (scale / 100);
  const dx = Math.cos(rad) * half, dy = -Math.sin(rad) * half;
  return isCentred(kind) ? { from: [cx, cy], to: [cx + dx, cy + dy] } : { from: [cx - dx, cy - dy], to: [cx + dx, cy + dy] };
}

/** A fill paint from a def (any shape) and placement values, colour references resolved. */
export function fillPaint(app, def, v, doc) {
  return resolvePaint(app, { type: 'gradient', gradient: { ...normalizeGradient(defOnly(def ?? {}), appColors(app)), kind: v.kind ?? 'linear', reverse: !!v.reverse, dither: !!v.dither, ...fillEnds(v, doc) } });
}

/** The Gradient Tool's current gradient (tools/fill.js), resolved; fg -> bg when the tool is missing. */
export function toolGradient(app) {
  const tool = app.tools?.tools?.get?.('gradient');
  const g = tool?.currentGradient?.() ?? { stops: 'fgbg' };
  return normalizeGradient(g, appColors(app));
}

// ---- the paint editor (G.5) -------------------------------------------------------------------------------------------------

const KINDS = ['linear', 'radial', 'angle', 'reflected', 'diamond'];

function fillFields(g, doc) {
  const pl = fillPlacement(g, doc);
  return [
    // the widget carries the def and its Method menu; style, angle, scale and offset become from / to
    { key: 'gradient', label: 'Gradient', type: 'gradient', placement: false, method: true, value: defOnly(g) },
    { key: 'kind', label: 'Style', type: 'select', value: g.kind ?? 'linear', options: KINDS.map((k) => [k, STYLE_LABELS[k]]) },
    { key: 'angle', label: 'Angle', type: 'slider', value: pl.angle, min: -180, max: 180, step: 0.1, unit: '°' },
    { key: 'scale', label: 'Scale', type: 'slider', value: Math.min(1000, Math.max(10, pl.scale)), min: 10, max: 1000, unit: '%' },
    { key: 'offsetX', label: 'Offset X', type: 'slider', value: Math.min(100, Math.max(-100, pl.offsetX)), min: -100, max: 100, step: 0.1, unit: '%' },
    { key: 'offsetY', label: 'Offset Y', type: 'slider', value: Math.min(100, Math.max(-100, pl.offsetY)), min: -100, max: 100, step: 0.1, unit: '%' },
    { key: 'reverse', label: 'Reverse', type: 'checkbox', value: !!g.reverse },
    { key: 'dither', label: 'Dither', type: 'checkbox', value: !!g.dither },
  ];
}

/** A preview copy of a gradient paint (see gradientPaintStyle); never stored: the callers put the original back. */
export function draft(paint) {
  return paint?.type === 'gradient' ? { ...paint, gradient: { ...paint.gradient, _draft: true } } : paint;
}

/** The Gradient Fill dialog: live on the layer while it is open. */
export async function editGradientFill(app, layer, paint, { live, title = 'Gradient Fill' } = {}) {
  const doc = app.doc;
  const g = normalizeGradient(paint?.gradient ?? {}, appColors(app));
  const values = await formDialog(app, {
    title,
    fields: fillFields(g, doc),
    width: 460,
    className: 'gradient-fill-dialog',
    live: { apply: (v) => live?.(fillPaint(app, v.gradient, v, doc)), revert: () => live?.(null) },
  });
  return values ? fillPaint(app, values.gradient, values, doc) : null;
}

/** The body of the Properties fill section (L.1): the widget, style, angle, scale, method, reverse and dither, live. */
export function gradientFillSection(app, layer, paint, onChange) {
  const doc = app.doc;
  const g = normalizeGradient(paint?.gradient ?? {}, appColors(app));
  const v = { ...fillPlacement(g, doc), kind: g.kind ?? 'linear', reverse: !!g.reverse, dither: !!g.dither };
  let def = g;
  const box = document.createElement('div');
  box.className = 'gradient-fill-section';
  // a field that reports the same value again (a number input's change on blur) adds no history entry
  const commit = () => {
    const next = fillPaint(app, def, v, doc);
    if (JSON.stringify(next) !== JSON.stringify(layer.paint)) onChange(next);
  };
  const row = (label, control, key) => {
    const r = document.createElement('div');
    r.className = 'prop-row';
    if (key) r.dataset.key = key;
    const l = document.createElement('span');
    l.textContent = label;
    r.append(l, control);
    box.appendChild(r);
  };
  // the Gradient Editor previews on the canvas through onInput (no history); OK commits through onChange
  const widget = gradientWidget({ placement: false, method: true, compact: true }, {
    app,
    value: defOnly(def),
    onInput: (next) => {
      layer.paint = fillPaint(app, next, v, doc);
      layer.touch();
      doc.changed('preview', { layer }); // a kind the panels ignore: the canvas repaints, the section stays
    },
    onChange: (next) => {
      def = next;
      commit();
    },
  });
  row('Gradient', widget.element, 'gradient');
  const style = document.createElement('select');
  style.className = 'select';
  style.dataset.key = 'kind';
  for (const k of KINDS) style.add(new Option(STYLE_LABELS[k], k));
  style.value = v.kind;
  style.addEventListener('change', () => {
    v.kind = style.value;
    commit();
  });
  row('Style', style, 'kind');
  const num = (key, label, min, max, unit, step = 1) => {
    const f = numericField({ key, min, max, step, unit, width: 60, value: v[key], onChange: (n) => {
      v[key] = n;
      commit();
    } });
    row(label, f.element, key);
  };
  num('angle', 'Angle', -180, 180, '°', 0.1);
  num('scale', 'Scale', 10, 1000, '%');
  num('offsetX', 'Offset X', -100, 100, '%', 0.1);
  num('offsetY', 'Offset Y', -100, 100, '%', 0.1);
  const flags = document.createElement('div');
  flags.className = 'prop-row gradient-fill-flags';
  for (const [key, label] of [['reverse', 'Reverse'], ['dither', 'Dither']]) {
    const l = document.createElement('label');
    l.className = 'checkbox';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.key = key;
    cb.checked = !!v[key];
    cb.addEventListener('change', () => {
      v[key] = cb.checked;
      commit();
    });
    l.append(cb, document.createTextNode(` ${label}`));
    flags.appendChild(l);
  }
  box.appendChild(flags);
  return box;
}

// ---- drop handler (L.9) -----------------------------------------------------------------------------------------------------

/** A Gradient Fill layer from a dropped gradient, above `target` (or the active layer). */
export async function dropGradient(app, data, target = null) {
  const doc = app.doc;
  if (!doc) return;
  let def;
  try {
    def = JSON.parse(data);
  } catch {
    return;
  }
  if (target) doc.setActive(target);
  const v = { kind: def.kind ?? 'linear', reverse: !!def.reverse, dither: !!def.dither, angle: 0, scale: 100, offsetX: 0, offsetY: 0 };
  const paint = def.from && def.to
    ? resolvePaint(app, { type: 'gradient', gradient: { ...normalizeGradient(def, appColors(app)) } })
    : fillPaint(app, def, v, doc);
  await app.commands.run('layer:new-fill', { kind: 'gradient', paint }, 'api');
}

export function installGradientPaint(app) {
  registerPaintRenderer('gradient', (ctx, paint, box, opts) => gradientPaintStyle(ctx, paint, box, opts));
  registerPaintEditor('gradient', {
    label: 'Gradient',
    // New Fill Layer > Gradient: the tool's current gradient left to right, then the Gradient Fill dialog live on the
    // new layer (0.3's flow, which shows the result on the canvas while the dialog is open)
    editAfterCreate: true,
    async create(app2, { doc }) {
      const tool = app2.tools?.tools?.get?.('gradient');
      const kind = tool?.opt?.('kind') ?? 'linear';
      return fillPaint(app2, toolGradient(app2), { kind, reverse: !!tool?.opt?.('reverse'), angle: 0, scale: 100, offsetX: 0, offsetY: 0 }, doc);
    },
    edit: (app2, layer, paint, { live }) => editGradientFill(app2, layer, paint, { live }),
    section: (app2, layer, paint, onChange) => gradientFillSection(app2, layer, paint, onChange),
  });
  app.registerDropHandler?.(GRADIENT_MIME, {
    canvas: (data) => dropGradient(app, data),
    layer: (data, layer) => dropGradient(app, data, layer),
  });
}
