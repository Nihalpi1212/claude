// shapes-live (package 13, ARCHITECTURE.md "0.4 features", Packages; J.5): live shape properties. This is the
// package's MODULES entry; it installs
//   - 'layer:shape-properties' (new id): every edit of a shape's live parameters, fill and stroke (the Properties
//     section, the options bar, the corner widgets, Paste Shape Attributes) as one undoable entry on every shape layer
//     it names, the path regenerated from the parameters;
//   - 'layer:copy-shape-attributes' / 'layer:paste-shape-attributes' (M.7): fill and stroke from one shape to the
//     selected shapes;
//   - the 'stroke-styles' preset kind with its thumbnail (C), the Properties 'shape' section (L.1, lib/properties/shape.js),
//   - the hooks path-ops.js renders through: custom shapes from the 'shapes' presets, decoded pattern paints.
// The shape tools themselves (Triangle, polygon and line options, Create dialogs, the gear menu) live in
// tools/vector.js and tools/shape-widgets.js; the fill / stroke popups and the `paint` widget in shape-paint-ui.js.
import { setLayersProps } from './layer-ops.js';
import { registerPresetKind } from './presets.js';
import { shapeChangePatch, setCustomShapeResolver, setShapePatternListener, isLiveShape, normalizeShapeProps } from './path-ops.js';
import { readyPaint } from './shape-paint-ui.js';
import { makeShapeSection, shapeLiveSection } from './properties/shape.js';
import { STROKE_KIND } from './tools/shape-widgets.js';

export { isLiveShape, normalizeShapeProps };

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const LABELS = { props: 'Shape Properties', fill: 'Shape Fill', stroke: 'Shape Stroke' };

// ---- stroke styles (C) ---------------------------------------------------------------------------------------------

export const STROKE_BUILTINS = Object.freeze([
  { id: 'solid', name: 'Solid', data: { dash: [], cap: 'butt', join: 'miter', align: 'center' } },
  { id: 'dashed', name: 'Dashed', data: { dash: [4, 2], cap: 'butt', join: 'miter', align: 'center' } },
  { id: 'dotted', name: 'Dotted', data: { dash: [0, 2], cap: 'round', join: 'round', align: 'center' } },
]);

/** A stroke style as stored: dashes in stroke widths (non-negative, an even count), cap, join, align; null if invalid. */
export function normalizeStrokeStyle(data) {
  if (!isObject(data) || !Array.isArray(data.dash)) return null;
  let dash = data.dash.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v >= 0);
  if (dash.length % 2) dash = [...dash, ...dash];
  if (!dash.some((v) => v > 0)) dash = [];
  return {
    dash,
    cap: ['butt', 'round', 'square'].includes(data.cap) ? data.cap : 'butt',
    join: ['miter', 'round', 'bevel'].includes(data.join) ? data.join : 'miter',
    align: ['inside', 'center', 'outside'].includes(data.align) ? data.align : 'center',
  };
}

function strokeThumbnail(preset, size = 48) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = Math.max(8, Math.round(size / 4));
  const ctx = c.getContext('2d');
  const d = normalizeStrokeStyle(preset?.data ?? preset) ?? { dash: [], cap: 'butt' };
  const w = Math.max(2, Math.round(c.height / 3));
  ctx.lineWidth = w;
  ctx.lineCap = d.cap;
  ctx.setLineDash(d.dash.map((v, i) => (i % 2 === 0 && v === 0 && d.cap !== 'butt' ? 0.001 : v * w)));
  ctx.strokeStyle = '#000';
  ctx.beginPath();
  ctx.moveTo(w, c.height / 2);
  ctx.lineTo(c.width - w, c.height / 2);
  ctx.stroke();
  return c;
}

export function registerStrokeStyles() {
  registerPresetKind(STROKE_KIND, {
    title: 'Stroke Styles',
    version: 1,
    builtins: () => ({ presets: STROKE_BUILTINS.map((p) => ({ id: p.id, name: p.name, data: { ...p.data, dash: p.data.dash.slice() } })) }),
    normalize: (data) => normalizeStrokeStyle(data),
    thumbnail: strokeThumbnail,
  });
}

// ---- layer:shape-properties --------------------------------------------------------------------------------------

/** The shape layers a shape command acts on: `ids`, `id`, else the selected shape layers, else the active one. */
export function shapeTargets(app, arg = {}) {
  const doc = app.doc;
  if (!doc) return [];
  const pick = (l) => (l?.type === 'shape' ? l : null);
  if (Array.isArray(arg.ids)) return arg.ids.map((id) => pick(doc.find(id))).filter(Boolean);
  if (typeof arg.id === 'string') return [pick(doc.find(arg.id))].filter(Boolean);
  const sel = [...(doc.selected ?? [])].filter((l) => l.type === 'shape');
  if (sel.length) return sel;
  return [pick(doc.active)].filter(Boolean);
}

/** The change of a command argument with its paints made ready for layer data (refs resolved, pattern pixels kept). */
function readyChange(app, arg) {
  const out = {};
  if (isObject(arg.props)) out.props = { ...arg.props };
  if ('fill' in arg) out.fill = arg.fill ? readyPaint(app, arg.fill) : null;
  if ('stroke' in arg) {
    if (arg.stroke === null) out.stroke = null;
    else if (isObject(arg.stroke)) {
      out.stroke = { ...arg.stroke };
      if ('paint' in arg.stroke) out.stroke.paint = arg.stroke.paint ? readyPaint(app, arg.stroke.paint) : null;
      if (out.stroke.paint === null) {
        // a stroke paint of None is no stroke
        out.stroke = null;
      }
    }
  }
  return out;
}

/**
 * Applies a shape change to the target layers as one history entry (merged into the previous one with `merge`, as a
 * slider drag): { id? | ids?, props?, fill?, stroke?, label?, merge? }. Locked layers are left out with a message.
 * Returns the layers changed.
 */
export function applyShapeChange(app, arg = {}) {
  const doc = app.doc;
  if (!doc || !isObject(arg)) return [];
  const change = readyChange(app, arg);
  const geometry = !!change.props;
  const targets = shapeTargets(app, arg);
  const locked = targets.filter((l) => l.locked?.all || (geometry && l.locked?.position));
  if (locked.length) app.dialogs?.toast?.(`"${locked[0].name}" is locked`, { kind: 'error', timeout: 1800 });
  const layers = targets.filter((l) => !locked.includes(l));
  const patches = new Map();
  for (const l of layers) {
    const p = shapeChangePatch(l, change);
    if (p) patches.set(l, p);
  }
  if (!patches.size) return [];
  const label = typeof arg.label === 'string' ? arg.label : change.props ? LABELS.props : 'fill' in change ? LABELS.fill : LABELS.stroke;
  setLayersProps(app, [...patches.keys()], (l) => patches.get(l), label, { merge: !!arg.merge });
  return [...patches.keys()];
}

// ---- Copy / Paste Shape Attributes ----------------------------------------------------------------------------------

let copied = null; // { fill, stroke } of the last Copy Shape Attributes (canvases by reference)

const copyPaint = (p) => (p ? { ...p, ...(p.gradient ? { gradient: JSON.parse(JSON.stringify(p.gradient)) } : {}), ...(p.pattern ? { pattern: { ...p.pattern } } : {}) } : null);
const copyStroke = (s) => (s ? { ...s, dash: Array.isArray(s.dash) ? s.dash.slice() : [], ...(s.paint ? { paint: copyPaint(s.paint) } : {}) } : null);

/** What Copy Shape Attributes copied (fill and stroke with every stroke option), or null. */
export function copiedShapeAttributes() {
  return copied ? { fill: copyPaint(copied.fill), stroke: copyStroke(copied.stroke) } : null;
}

function copyAttributes(app) {
  const layer = app.doc?.active;
  if (layer?.type !== 'shape') return app.dialogs.toast('Select a shape layer first', { kind: 'error' });
  copied = { fill: copyPaint(readyPaint(app, layer.fill)), stroke: layer.stroke ? copyStroke({ ...layer.stroke, ...(layer.stroke.paint ? { paint: readyPaint(app, layer.stroke.paint) } : {}) }) : null };
  app.commands.invalidate();
}

function pasteAttributes(app, arg) {
  const attrs = isObject(arg) && ('fill' in arg || 'stroke' in arg) ? arg : copiedShapeAttributes();
  if (!attrs) return app.dialogs.toast('Copy the attributes of a shape first', { kind: 'error' });
  // the whole stroke is replaced: start it from nothing so no option of the old stroke survives
  const targets = shapeTargets(app, isObject(arg) ? arg : {});
  if (!targets.length) return app.dialogs.toast('Select a shape layer first', { kind: 'error' });
  const doc = app.doc;
  doc.history.group('Paste Shape Attributes', () => {
    applyShapeChange(app, { ids: targets.map((l) => l.id), fill: attrs.fill ?? null, stroke: null, label: 'Paste Shape Attributes' });
    if (attrs.stroke) applyShapeChange(app, { ids: targets.map((l) => l.id), stroke: attrs.stroke, label: 'Paste Shape Attributes' });
  });
}

// ---- install --------------------------------------------------------------------------------------------------------

export function install(app) {
  registerStrokeStyles();
  // custom shapes regenerate from the 'shapes' presets (0.3's built-ins when a preset is missing)
  setCustomShapeResolver((id) => {
    const data = id ? app.presets?.get?.('shapes', id)?.data : null;
    return data?.path && Array.isArray(data.path.subpaths) ? data.path : null;
  });
  // a pattern paint read back from JSON decodes its pixels once: the layer then redraws
  setShapePatternListener((layer) => {
    for (const doc of app.docs?.list?.() ?? [app.doc]) if (doc?.find?.(layer.id) === layer) doc.changed('pixels', { layer });
    app.view?.invalidate();
  });

  const hasShape = () => shapeTargets(app).length > 0;
  app.commands.registerAll({
    'layer:shape-properties': {
      enabled: hasShape,
      label: 'Shape Properties',
      run: (arg, ctx) => {
        // an action replays the edit on the shape that is active then: the recorded argument names no layer
        if (isObject(arg) && ('id' in arg || 'ids' in arg)) {
          const { id, ids, ...rest } = arg;
          void id;
          void ids;
          ctx?.setReplayArg?.(rest);
        }
        return applyShapeChange(app, arg ?? {});
      },
    },
    'layer:copy-shape-attributes': { enabled: () => app.doc?.active?.type === 'shape', label: 'Copy Shape Attributes', run: () => copyAttributes(app) },
    'layer:paste-shape-attributes': { enabled: () => !!copied && hasShape(), label: 'Paste Shape Attributes', run: (arg) => pasteAttributes(app, arg) },
  });

  // the Properties section: registered before the panel's built-ins, so it is this one that shows (L.1)
  app.properties?.registerSection(makeShapeSection());
  app.properties?.registerSection(shapeLiveSection);
}
