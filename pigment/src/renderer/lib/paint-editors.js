// Paint editors (ARCHITECTURE.md "0.4 features", G.5; E21): the dialogs that create and edit a Paint (G.2) for
// fill layers (Layer > New Fill Layer, Layer Content Options, double-clicking a fill thumbnail) and, through
// `section`, the body of the Properties fill section.
//
// Skeleton file. The default editors are 0.3's code: solid through app.pickColor, gradient through the Gradient Fill
// form that adjust-ui.js editFillLayer showed (now writing a version 2 def), pattern through the Scale form with
// app.patterns.current() for a new layer. gradients registers 'gradient', patterns 'pattern'; the later registration
// wins. Every paint that reaches layer data has its colour references resolved (G.1).
import { formDialog } from './form.js';
import { setLayerProps } from './layer-ops.js';
import { normalizeGradient } from '../../shared/pixels/gradient-model.js';

/** type -> { label, create(app, { doc }), edit(app, layer, paint, { live }), section?(app, layer, paint, onChange), editAfterCreate? } */
const EDITORS = new Map();

/**
 * Registers the editor of a paint type; the later registration wins. `editAfterCreate: true` (an addition to G.5)
 * asks Layer > New Fill Layer to open `edit` on the new layer right after `create` returned its first paint: the
 * 0.3 Gradient Fill flow, which edits the new layer live on the canvas.
 */
export function registerPaintEditor(type, ed) {
  if (typeof type !== 'string' || !ed || typeof ed !== 'object') throw new Error('registerPaintEditor(type, editor)');
  EDITORS.set(type, ed);
}

/** The editor registered for a type, or null. */
export function paintEditor(type) {
  return EDITORS.get(type) ?? null;
}

/** A copy of paint whose gradient colour references are resolved with the current colours (G.1). */
export function resolvePaint(app, paint) {
  if (!paint || paint.type !== 'gradient') return paint;
  return { ...paint, gradient: normalizeGradient(paint.gradient, { fg: app.settings?.foreground, bg: app.settings?.background }) };
}

/** The first paint of a new fill layer (Layer > New Fill Layer), or null when the user cancelled. */
export async function createPaint(app, type, { doc = app.doc } = {}) {
  const ed = EDITORS.get(type);
  if (!ed?.create) return null;
  const paint = await ed.create(app, { doc });
  return paint ? resolvePaint(app, paint) : null;
}

/**
 * Edits a fill layer's paint ('layer:edit-fill'): the editor previews through `live(paint)` (null puts the stored
 * paint back) and returns the new paint, or null to keep the old one; a returned paint is one history entry.
 */
export async function editPaint(app, layer) {
  const d = app.doc;
  if (!d || !layer || layer.type !== 'fill') return;
  const original = layer.paint;
  const ed = EDITORS.get(original?.type);
  if (!ed?.edit) return;
  const show = (p) => {
    layer.paint = p ?? original;
    layer.touch();
    d.changed('props', { layer });
  };
  let result = null;
  try {
    result = await ed.edit(app, layer, original, { live: (p) => show(p ? resolvePaint(app, p) : null) });
  } finally {
    layer.paint = original;
    layer.touch();
  }
  if (result) setLayerProps(app, layer, { paint: resolvePaint(app, result) }, original.type === 'gradient' ? 'Edit gradient fill' : 'Edit fill');
  else d.changed('props', { layer });
}

// ---- defaults: 0.3's editors --------------------------------------------------------------------------------------

registerPaintEditor('solid', {
  label: 'Solid Color',
  async create(app) {
    const color = await app.pickColor?.(app.settings.foreground, { title: 'Solid Color Fill' });
    return color ? { type: 'solid', color } : null;
  },
  async edit(app, layer, paint, { live }) {
    const c = await app.pickColor?.(paint.color, { title: 'Solid Color Fill', live: (color) => live({ type: 'solid', color }) });
    return c && c !== paint.color ? { type: 'solid', color: c } : null;
  },
});

registerPaintEditor('gradient', {
  label: 'Gradient',
  editAfterCreate: true,
  async create(app, { doc }) {
    const fg = app.settings.foreground, bg = app.settings.background;
    return { type: 'gradient', gradient: normalizeGradient({ kind: 'linear', stops: [{ pos: 0, color: fg }, { pos: 1, color: bg }], from: [0, doc.height / 2], to: [doc.width, doc.height / 2] }, { fg, bg }) };
  },
  async edit(app, layer, paint, { live }) {
    const d = app.doc;
    const g = paint.gradient ?? {};
    const def = normalizeGradient(g, { fg: app.settings.foreground, bg: app.settings.background });
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
    const colorOf = (s, fallback) => (typeof s?.color === 'string' ? s.color : fallback);
    const build = (v) => {
      const rad = (v.angle * Math.PI) / 180;
      const cx = d.width / 2 + (v.offsetX / 100) * d.width, cy = d.height / 2 + (v.offsetY / 100) * d.height;
      const half = (Math.abs(Math.cos(rad)) * d.width + Math.abs(Math.sin(rad)) * d.height) / 2 * (v.scale / 100);
      const dx = Math.cos(rad) * half, dy = -Math.sin(rad) * half;
      const radial = v.kind === 'radial' || v.kind === 'diamond' || v.kind === 'angle';
      // the first and last colour stops take the two colours and the ends, as 0.3 did; midpoints and opacity stay
      const colorStops = def.stops.map((s) => ({ ...s }));
      colorStops[0] = { ...colorStops[0], pos: 0, color: v.c0 };
      colorStops[colorStops.length - 1] = { ...colorStops[colorStops.length - 1], pos: 1, color: v.c1 };
      return {
        type: 'gradient',
        gradient: { ...def, stops: colorStops, kind: v.kind, reverse: v.reverse, from: radial ? [cx, cy] : [cx - dx, cy - dy], to: [cx + dx, cy + dy] },
      };
    };
    const o = await formDialog(app, {
      title: 'Gradient Fill',
      fields: [
        { key: 'kind', label: 'Style', type: 'select', value: g.kind ?? 'linear', options: [['linear', 'Linear'], ['radial', 'Radial'], ['angle', 'Angle'], ['reflected', 'Reflected'], ['diamond', 'Diamond']] },
        { key: 'c0', label: 'Start color', type: 'color', value: colorOf(stops[0], '#000000') },
        { key: 'c1', label: 'End color', type: 'color', value: colorOf(stops[stops.length - 1], '#ffffff') },
        { key: 'angle', label: 'Angle', type: 'slider', value: angleNow, min: -180, max: 180, unit: '°' },
        { key: 'scale', label: 'Scale', type: 'slider', value: Math.min(1000, Math.max(10, scaleNow)), min: 10, max: 1000, unit: '%' },
        { key: 'offsetX', label: 'Offset X', type: 'slider', value: Math.min(100, Math.max(-100, offXNow)), min: -100, max: 100, unit: '%' },
        { key: 'offsetY', label: 'Offset Y', type: 'slider', value: Math.min(100, Math.max(-100, offYNow)), min: -100, max: 100, unit: '%' },
        { key: 'reverse', label: 'Reverse', type: 'checkbox', value: !!g.reverse },
      ],
      live: { apply: (v) => live(build(v)), revert: () => live(null) },
    });
    return o ? build(o) : null;
  },
});

registerPaintEditor('pattern', {
  label: 'Pattern',
  async create(app) {
    const current = app.patterns?.current?.() ?? null;
    if (!current?.canvas) {
      app.dialogs.toast('Define a pattern first (Edit › Define Pattern)', { kind: 'error' });
      return null;
    }
    return { type: 'pattern', pattern: { canvas: current.canvas, scale: 1 } };
  },
  async edit(app, layer, paint, { live }) {
    const o = await formDialog(app, {
      title: 'Pattern Fill',
      fields: [{ key: 'scale', label: 'Scale', type: 'slider', value: Math.round((paint.pattern?.scale ?? 1) * 100), min: 1, max: 1000, unit: '%' }],
      live: {
        apply: (v) => live({ ...paint, pattern: { ...paint.pattern, scale: v.scale / 100 } }),
        revert: () => live(null),
      },
    });
    return o ? { ...paint, pattern: { ...paint.pattern, scale: o.scale / 100 } } : null;
  },
});
