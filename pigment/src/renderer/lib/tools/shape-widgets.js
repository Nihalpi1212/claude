// Shape tool widgets (shapes-live, ARCHITECTURE.md "0.4 features", package 13): the live corner widgets on the canvas
// (drag to round every corner of a rectangle, Alt-drag one corner; the triangle's and polygon's corner radius), the
// Create dialogs a click on the canvas opens, the gear menu of the shape tools (Path Options, the drawing constraints,
// the polygon's star options, the line's arrowheads) and the Stroke Options popup (presets of the 'stroke-styles' kind,
// alignment, caps, corners, dashes, More Options…), as option kinds of the options bar (lib/fields.js widgets, H).
//
// Every change goes through the command registry: a shape is edited with 'layer:shape-properties' (lib/shape-props.js),
// tool options with app.tools.setOpt (tool options are not document state and have no history, as in 0.3).
import { registerWidget } from '../fields.js';
import { buildForm, formDialog } from '../form.js';
import { icon } from '../icons.js';
import { normalizeShapeProps, isLiveShape, regenerateShape } from '../path-ops.js';
import { triangleVertices, polygonCorners, clampRadii } from '../shape-geometry.js';

// ---- live corner widgets ------------------------------------------------------------------------------------------

const MIN_OFFSET = 14; // screen px between a square corner and its widget
const MIN_SIZE = 24; // screen px: smaller shapes show no widgets

/** Rotates (x, y) by the props' angle about the box centre. */
function rotator(p) {
  const a = ((Number(p.angle) || 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
  return (x, y) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c];
}

/**
 * The corners of the active live shape that carry a widget: { layer, kind, props, corners: [{ index, x, y, bx, by,
 * half, maxR, r }] } in document space (bx, by: the unit bisector into the shape; half: sin of half the interior
 * angle; r: the radius shown), or null.
 */
export function cornerFrame(app) {
  const doc = app.doc;
  const layer = doc?.active;
  if (!layer || layer.type !== 'shape' || !layer.visible || layer.locked?.all || layer.locked?.position || !isLiveShape(layer)) return null;
  const { kind, props } = normalizeShapeProps(layer);
  if (!['rect', 'triangle', 'polygon'].includes(kind)) return null;
  let verts, radii;
  if (kind === 'rect') {
    verts = [[props.x, props.y], [props.x + props.width, props.y], [props.x + props.width, props.y + props.height], [props.x, props.y + props.height]];
    radii = clampRadii(props.width, props.height, props.radii);
  } else if (kind === 'triangle') {
    verts = triangleVertices(props).map((v) => [v.x, v.y]);
    radii = verts.map(() => Math.max(0, props.radius || 0));
  } else {
    verts = polygonCorners(props).map((v) => [v.x, v.y]);
    radii = verts.map(() => Math.max(0, props.cornerRadius || 0));
  }
  const rot = rotator(props);
  const pts = verts.map(([x, y]) => rot(x, y));
  const n = pts.length;
  const corners = [];
  // a polygon shows one widget, on its first (top) corner, as Photoshop does
  const indices = kind === 'polygon' ? [0] : pts.map((_, i) => i);
  for (const i of indices) {
    const V = pts[i], A = pts[(i - 1 + n) % n], B = pts[(i + 1) % n];
    const la = Math.hypot(A[0] - V[0], A[1] - V[1]), lb = Math.hypot(B[0] - V[0], B[1] - V[1]);
    if (la < 1e-6 || lb < 1e-6) continue;
    const ux = (A[0] - V[0]) / la + (B[0] - V[0]) / lb, uy = (A[1] - V[1]) / la + (B[1] - V[1]) / lb;
    const ul = Math.hypot(ux, uy);
    if (ul < 1e-6) continue;
    const theta = Math.acos(Math.max(-1, Math.min(1, ((A[0] - V[0]) * (B[0] - V[0]) + (A[1] - V[1]) * (B[1] - V[1])) / (la * lb))));
    const half = Math.sin(theta / 2);
    const maxR = kind === 'rect' ? Math.min(props.width, props.height) / 2 : (Math.min(la, lb) / 2) * Math.tan(theta / 2);
    corners.push({ index: i, x: V[0], y: V[1], bx: ux / ul, by: uy / ul, half, maxR, r: Math.min(radii[i], maxR) });
  }
  return { layer, kind, props, corners };
}

/** Screen position of a corner's widget: at the arc centre, or MIN_OFFSET screen px in for a square corner. */
function widgetPoint(view, c) {
  const s = Math.max(c.r / Math.max(1e-6, c.half), MIN_OFFSET / view.zoom);
  return view.toScreen(c.x + c.bx * s, c.y + c.by * s);
}

function shown(app, view, frame) {
  if (!frame || view?.doc !== app.doc) return false;
  const p = frame.props;
  const w = frame.kind === 'line' ? 0 : Math.min(p.width, p.height) * view.zoom;
  return w >= MIN_SIZE;
}

/** The corner widget under the pointer (document point p), or null. */
export function cornerWidgetAt(app, view, p) {
  const frame = cornerFrame(app);
  if (!view || !shown(app, view, frame)) return null;
  const q = view.toScreen(p.x, p.y);
  for (const c of frame.corners) {
    const w = widgetPoint(view, c);
    if (Math.hypot(w.x - q.x, w.y - q.y) <= 6) return { frame, corner: c };
  }
  return null;
}

/** Draws the corner widgets of the active live shape (small circles with a dot, Photoshop's look). */
export function drawCornerWidgets(ctx, view, app) {
  const frame = cornerFrame(app);
  if (!shown(app, view, frame)) return;
  ctx.save();
  for (const c of frame.corners) {
    const w = widgetPoint(view, c);
    ctx.beginPath();
    ctx.arc(w.x, w.y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#1e88ff';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(w.x, w.y, 1.5, 0, Math.PI * 2);
    ctx.fillStyle = '#1e88ff';
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Starts dragging a corner widget: { move(p), end(), cancel() }. The radius follows the pointer along the corner's
 * bisector; every corner changes together, or only the dragged one with Alt (rectangles). The drag previews on the
 * layer and ends with one 'layer:shape-properties' entry.
 */
export function beginCornerDrag(app, { frame, corner }) {
  const { layer, kind, props } = frame;
  const doc = app.doc;
  const original = { path: layer.path, shapeKind: layer.shapeKind, shapeProps: layer.shapeProps };
  let patch = null;
  const radiusAt = (q) => {
    const t = (q.x - corner.x) * corner.bx + (q.y - corner.y) * corner.by;
    return Math.round(Math.max(0, Math.min(corner.maxR, t * corner.half)) * 100) / 100;
  };
  const patchFor = (r, alone) => {
    if (kind === 'rect') {
      const radii = alone ? clampRadii(props.width, props.height, props.radii).map((v, i) => (i === corner.index ? r : Math.round(v * 100) / 100)) : [r, r, r, r];
      return { radii };
    }
    return kind === 'triangle' ? { radius: r } : { cornerRadius: r };
  };
  const show = (pp) => {
    const g = regenerateShape({ ...layer, ...original }, pp);
    if (!g) return;
    Object.assign(layer, g);
    layer.touch();
    doc.changed('pixels', { layer });
  };
  const restore = () => {
    Object.assign(layer, original);
    layer.touch();
    doc.changed('pixels', { layer });
  };
  return {
    move(q) {
      patch = patchFor(radiusAt(q), !!q.alt);
      show(patch);
    },
    end() {
      restore();
      if (patch) app.commands.run('layer:shape-properties', { id: layer.id, props: patch, label: 'Corner Radius' }, 'tool');
    },
    cancel: restore,
  };
}

// ---- Create dialogs ---------------------------------------------------------------------------------------------

/**
 * The Create dialog of a shape tool clicked on the canvas at `at` (Photoshop's Create Rectangle / Ellipse / Triangle /
 * Polygon / Custom Shape): resolves { box, props } (the parameters that differ from the tool's options) or null. The
 * values it asks for become the tool's options, as in Photoshop.
 */
export async function createShapeDialog(tool, at) {
  const app = tool.app;
  const shape = tool.shape;
  const opt = (k, d) => tool.opt(k) ?? d;
  const size = app.settings.shapes?.createSize ?? {};
  const w0 = Number(size.width) || 100, h0 = Number(size.height) || 100;
  const fields = [
    { key: 'width', label: 'Width', type: 'number', value: w0, min: 1, max: 30000, unit: 'px' },
    { key: 'height', label: 'Height', type: 'number', value: h0, min: 1, max: 30000, unit: 'px' },
  ];
  const r0 = Number(opt('radius', shape === 'rrect' ? 16 : 0));
  if (shape === 'rect' || shape === 'rrect') {
    fields.push(
      { key: 'linked', label: 'Same radius for every corner', type: 'checkbox', value: true },
      { key: 'radiusTL', label: 'Top left radius', type: 'number', value: r0, min: 0, max: 5000, unit: 'px' },
      { key: 'radiusTR', label: 'Top right radius', type: 'number', value: r0, min: 0, max: 5000, unit: 'px' },
      { key: 'radiusBR', label: 'Bottom right radius', type: 'number', value: r0, min: 0, max: 5000, unit: 'px' },
      { key: 'radiusBL', label: 'Bottom left radius', type: 'number', value: r0, min: 0, max: 5000, unit: 'px' },
    );
  } else if (shape === 'triangle') {
    fields.push(
      { key: 'equilateral', label: 'Equilateral', type: 'checkbox', value: false },
      { key: 'radius', label: 'Corner radius', type: 'number', value: r0, min: 0, max: 5000, unit: 'px' },
    );
  } else if (shape === 'polygon') {
    fields.push(
      { key: 'symmetric', label: 'Symmetric', type: 'checkbox', value: true },
      { key: 'sides', label: 'Number of sides', type: 'number', value: Number(opt('sides', 5)), min: 3, max: 100 },
      { key: 'cornerRadius', label: 'Corner radius', type: 'number', value: Number(opt('cornerRadius', 0)), min: 0, max: 5000, unit: 'px' },
      { key: 'starRatio', label: 'Star ratio', type: 'slider', value: tool.starRatio(), min: 1, max: 100, unit: '%' },
      { key: 'smoothIndents', label: 'Smooth star indents', type: 'checkbox', value: !!opt('smoothIndents', false) },
      { key: 'smoothCorners', label: 'Smooth corners', type: 'checkbox', value: !!opt('smoothCorners', false) },
    );
  }
  fields.push({ key: 'center', label: 'From centre', type: 'checkbox', value: false });
  const RADII = ['radiusTL', 'radiusTR', 'radiusBR', 'radiusBL'];
  const v = await formDialog(app, {
    title: tool.def.title,
    fields,
    onChange: (values, key, form) => {
      if (!form) return;
      // linked radii follow the one typed; Equilateral and Symmetric keep the height to the width
      if (values.linked && RADII.includes(key)) for (const k of RADII) if (k !== key) form.set(k, values[key], { silent: true });
      if ((key === 'width' || key === 'equilateral') && values.equilateral) form.set('height', Math.round(Number(values.width) * (Math.sqrt(3) / 2) * 100) / 100, { silent: true });
      if ((key === 'width' || key === 'symmetric') && values.symmetric && shape === 'polygon') form.set('height', values.width, { silent: true });
    },
  });
  if (!v || !tool.doc) return null;
  const w = Math.max(1, Number(v.width)), h = Math.max(1, Number(v.height));
  app.saveSettingsSoon?.({ shapes: { ...(app.settings.shapes ?? {}), createSize: { width: w, height: h } } });
  const over = {};
  if (shape === 'rect' || shape === 'rrect') {
    over.radii = RADII.map((k) => Math.max(0, Number(v[k]) || 0));
    if (over.radii.every((r) => r === over.radii[0])) tool.setOpt('radius', over.radii[0]);
  } else if (shape === 'triangle') {
    over.radius = Math.max(0, Number(v.radius) || 0);
    tool.setOpt('radius', over.radius);
  } else if (shape === 'polygon') {
    Object.assign(over, { sides: Math.max(3, Math.min(100, Math.round(Number(v.sides) || 5))), cornerRadius: Math.max(0, Number(v.cornerRadius) || 0), starRatio: Math.max(1, Math.min(100, Number(v.starRatio) || 100)), smoothIndents: !!v.smoothIndents, smoothCorners: !!v.smoothCorners });
    for (const k of ['sides', 'cornerRadius', 'starRatio', 'smoothIndents', 'smoothCorners']) tool.setOpt(k, over[k]);
  }
  const box = { x: v.center ? at.x - w / 2 : at.x, y: v.center ? at.y - h / 2 : at.y, width: w, height: h };
  if (tool.opt('alignEdges') !== false) {
    box.x = Math.round(box.x);
    box.y = Math.round(box.y);
  }
  return { box, props: over };
}

// ---- options-bar popups --------------------------------------------------------------------------------------------

const el = (tag, className, text) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** Opens `content` in a popover under `anchor` that stays open while it is used. */
function popup(app, anchor, content, className) {
  const pop = app.dialogs.popover(anchor, [{ type: 'custom', element: content }], { align: 'left', closeOnSelect: false });
  pop?.classList.add('sl-popover', className);
  return pop;
}

/** The gear menu of a shape tool: Path Options, constraints, the polygon's and the line's own options. */
export function geometryFields(tool) {
  const shape = tool.shape;
  const s = tool.app.settings.shapes ?? {};
  const fields = [
    { type: 'section', label: 'Path Options' },
    { key: 'pathThickness', label: 'Thickness', type: 'number', value: Number.isFinite(s.pathThickness) ? s.pathThickness : 1, min: 1, max: 10, unit: 'px' },
    { key: 'pathColor', label: 'Color', type: 'color', value: s.pathColor ?? '#1e88ff' },
  ];
  if (shape === 'line') {
    fields.push(
      { type: 'section', label: 'Arrowheads' },
      { key: 'arrowStart', label: 'Start', type: 'checkbox', value: !!tool.opt('arrowStart') },
      { key: 'arrowEnd', label: 'End', type: 'checkbox', value: !!tool.opt('arrowEnd') },
      { key: 'arrowWidth', label: 'Width', type: 'number', value: Number(tool.opt('arrowWidth') ?? 500), min: 10, max: 5000, unit: '%' },
      { key: 'arrowLength', label: 'Length', type: 'number', value: Number(tool.opt('arrowLength') ?? 1000), min: 10, max: 5000, unit: '%' },
      { key: 'arrowConcavity', label: 'Concavity', type: 'number', value: Number(tool.opt('arrowConcavity') ?? 0), min: -50, max: 50, unit: '%' },
    );
    return fields;
  }
  const square = shape === 'ellipse' ? 'Circle' : 'Square';
  const choices = shape === 'custom'
    ? [['none', 'Unconstrained'], ['defined-proportions', 'Defined Proportions'], ['defined-size', 'Defined Size'], ['fixed', 'Fixed Size'], ['proportional', 'Proportional']]
    : [['none', 'Unconstrained'], ['square', square], ['fixed', 'Fixed Size'], ['proportional', 'Proportional']];
  fields.push(
    { type: 'section', label: 'Constraints' },
    { key: 'constrain', label: 'Draw', type: 'select', value: tool.opt('constrain') ?? 'none', options: choices },
    { key: 'fixedW', label: 'W', type: 'number', value: Number(tool.opt('fixedW') ?? 100), min: 1, max: 30000, unit: 'px', when: (v) => v.constrain === 'fixed' },
    { key: 'fixedH', label: 'H', type: 'number', value: Number(tool.opt('fixedH') ?? 100), min: 1, max: 30000, unit: 'px', when: (v) => v.constrain === 'fixed' },
    { key: 'propW', label: 'W', type: 'number', value: Number(tool.opt('propW') ?? 1), min: 0.01, max: 1000, step: 0.01, when: (v) => v.constrain === 'proportional' },
    { key: 'propH', label: 'H', type: 'number', value: Number(tool.opt('propH') ?? 1), min: 0.01, max: 1000, step: 0.01, when: (v) => v.constrain === 'proportional' },
    { key: 'fromCenter', label: 'From Center', type: 'checkbox', value: !!tool.opt('fromCenter') },
  );
  if (shape === 'polygon') {
    fields.push(
      { type: 'section', label: 'Star Options' },
      { key: 'starRatio', label: 'Star ratio', type: 'number', value: tool.starRatio(), min: 1, max: 100, unit: '%' },
      { key: 'smoothIndents', label: 'Smooth Star Indents', type: 'checkbox', value: !!tool.opt('smoothIndents') },
      { key: 'smoothCorners', label: 'Smooth Corners', type: 'checkbox', value: !!tool.opt('smoothCorners') },
    );
  }
  return fields;
}

/** Applies a gear-menu value: Path Options go to settings.shapes, the rest to the tool's options. */
export function applyGeometryValue(tool, key, value) {
  const app = tool.app;
  if (key === 'pathThickness' || key === 'pathColor') {
    const v = key === 'pathThickness' ? Math.max(1, Math.min(10, Number(value) || 1)) : value;
    app.saveSettingsSoon({ shapes: { ...(app.settings.shapes ?? {}), [key]: v } });
    app.view?.invalidate();
    return;
  }
  tool.setOpt(key, typeof tool.opt(key) === 'number' || /^(arrow(Width|Length|Concavity)|fixed[WH]|prop[WH]|starRatio)$/.test(key) ? Number(value) : value);
}

registerWidget('shape-geometry', (spec, { app }) => {
  const b = el('button', 'btn small sl-gear');
  b.type = 'button';
  b.title = 'Path options and geometry options';
  b.innerHTML = icon('settings');
  b.addEventListener('click', () => {
    const tool = app.tools.active;
    if (!tool?.shape) return;
    const form = buildForm(geometryFields(tool), { app, onChange: (values, key) => applyGeometryValue(tool, key, values[key]) });
    const box = el('div', 'sl-geometry');
    box.appendChild(form.element);
    popup(app, b, box, 'sl-geometry-pop');
  });
  return { element: b, get: () => null, set() {}, setDisabled: (d) => (b.disabled = !!d), destroy: () => b.remove() };
});

// ---- Stroke Options ---------------------------------------------------------------------------------------------------

export const STROKE_KIND = 'stroke-styles';
const ALIGN_OPTIONS = [['inside', 'Inside'], ['center', 'Center'], ['outside', 'Outside']];
const CAP_OPTIONS = [['butt', 'Butt'], ['round', 'Round'], ['square', 'Square']];
const JOIN_OPTIONS = [['miter', 'Miter'], ['round', 'Round'], ['bevel', 'Bevel']];

/** A small SVG line showing a dash pattern (in stroke widths) with its caps. */
export function strokePreviewSvg({ dash = [], cap = 'butt' } = {}, { width = 90, weight = 3 } = {}) {
  const d = (Array.isArray(dash) ? dash : []).map((v) => (v === 0 && cap !== 'butt' ? 0.01 : v) * weight).join(' ');
  return `<svg class="sl-stroke-svg" width="${width}" height="12" viewBox="0 0 ${width} 12" aria-hidden="true"><line x1="${weight}" y1="6" x2="${width - weight}" y2="6" stroke="currentColor" stroke-width="${weight}" stroke-linecap="${cap}"${d ? ` stroke-dasharray="${d}"` : ''}/></svg>`;
}

const sameDash = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

/**
 * The Stroke Options panel: presets, Align, Caps, Corners, More Options… and Save Preset…. `get()` gives the current
 * { align, cap, join, dash }, `set(patch)` applies a change; used by the options bar and the Properties panel.
 */
export function strokeOptionsPanel(app, { get, set }) {
  const box = el('div', 'sl-stroke-options');
  const list = el('div', 'sl-stroke-presets');
  box.appendChild(list);
  const renderPresets = () => {
    const cur = get();
    list.replaceChildren();
    for (const p of app.presets?.list?.(STROKE_KIND) ?? []) {
      const row = el('button', 'sl-stroke-preset');
      row.type = 'button';
      row.dataset.presetId = p.id;
      row.title = p.name;
      row.innerHTML = strokePreviewSvg(p.data);
      row.setAttribute('aria-pressed', String(sameDash(p.data.dash, cur.dash) && (p.data.cap ?? 'butt') === (cur.cap ?? 'butt')));
      row.addEventListener('click', () => {
        const d = p.data;
        set({ dash: (d.dash ?? []).slice(), cap: d.cap ?? 'butt', join: d.join ?? 'miter', align: d.align ?? 'center' });
        renderPresets();
        sync();
      });
      list.appendChild(row);
    }
  };
  const selects = {};
  const grid = el('div', 'sl-stroke-grid');
  for (const [key, label, options] of [['align', 'Align', ALIGN_OPTIONS], ['cap', 'Caps', CAP_OPTIONS], ['join', 'Corners', JOIN_OPTIONS]]) {
    const l = el('label', 'sl-stroke-field');
    l.appendChild(el('span', 'muted', label));
    const s = el('select', 'select');
    s.dataset.key = `stroke-${key}`;
    for (const [v, t] of options) s.appendChild(Object.assign(el('option', '', t), { value: v }));
    s.addEventListener('change', () => {
      set({ [key]: s.value });
      renderPresets();
    });
    selects[key] = s;
    l.appendChild(s);
    grid.appendChild(l);
  }
  box.appendChild(grid);
  const sync = () => {
    const cur = get();
    selects.align.value = cur.align ?? 'center';
    selects.cap.value = cur.cap ?? 'butt';
    selects.join.value = cur.join ?? 'miter';
  };
  const acts = el('div', 'sl-stroke-actions');
  const more = el('button', 'btn small', 'More Options…');
  more.type = 'button';
  more.dataset.act = 'stroke-more';
  more.addEventListener('click', async () => {
    app.dialogs.closePopover();
    const next = await strokeDialog(app, get());
    if (next) set(next);
  });
  const save = el('button', 'btn small', 'Save Preset…');
  save.type = 'button';
  save.dataset.act = 'stroke-save';
  save.addEventListener('click', async () => {
    app.dialogs.closePopover();
    await saveStrokePreset(app, get());
  });
  acts.append(more, save);
  box.appendChild(acts);
  renderPresets();
  sync();
  return box;
}

/** The Stroke dialog of More Options…: preset, alignment, caps, corners and up to three dash / gap pairs. */
export async function strokeDialog(app, cur) {
  const dash = Array.isArray(cur.dash) ? cur.dash : [];
  const pair = (i) => [dash[i * 2] ?? (i === 0 ? 4 : 0), dash[i * 2 + 1] ?? (i === 0 ? 2 : 0)];
  const fields = [
    { key: 'align', label: 'Align', type: 'select', value: cur.align ?? 'center', options: ALIGN_OPTIONS },
    { key: 'cap', label: 'Caps', type: 'select', value: cur.cap ?? 'butt', options: CAP_OPTIONS },
    { key: 'join', label: 'Corners', type: 'select', value: cur.join ?? 'miter', options: JOIN_OPTIONS },
    { key: 'dashed', label: 'Dashed line', type: 'checkbox', value: dash.length > 0 },
  ];
  for (let i = 0; i < 3; i++) {
    const [d, g] = pair(i);
    fields.push(
      { key: `dash${i}`, label: `Dash ${i + 1}`, type: 'number', value: d, min: 0, max: 1000, step: 0.5, when: (v) => v.dashed },
      { key: `gap${i}`, label: `Gap ${i + 1}`, type: 'number', value: g, min: 0, max: 1000, step: 0.5, when: (v) => v.dashed },
    );
  }
  const v = await formDialog(app, { title: 'Stroke', fields, intro: 'Dashes and gaps are in stroke widths.' });
  if (!v) return null;
  let list = [];
  if (v.dashed) {
    for (let i = 0; i < 3; i++) {
      const d = Math.max(0, Number(v[`dash${i}`]) || 0), g = Math.max(0, Number(v[`gap${i}`]) || 0);
      if (d > 0 || g > 0) list.push(d, g);
    }
    if (!list.some((x) => x > 0)) list = [];
  }
  return { align: v.align, cap: v.cap, join: v.join, dash: list };
}

/** Save Preset… of the Stroke Options popup: names the current stroke style and adds it to the 'stroke-styles' kind. */
export async function saveStrokePreset(app, cur, name = null) {
  if (!app.presets) return null;
  const n = name ?? (await app.dialogs.prompt('Name', { title: 'New Stroke Preset', value: 'Stroke Preset' }));
  if (!n?.trim()) return null;
  await app.presets.ready(STROKE_KIND);
  return app.presets.add(STROKE_KIND, { name: n.trim(), data: { dash: (cur.dash ?? []).slice(), cap: cur.cap ?? 'butt', join: cur.join ?? 'miter', align: cur.align ?? 'center' } });
}

/** The tool options the Stroke Options popup of the options bar edits. */
const TOOL_STROKE_KEYS = { align: 'strokeAlign', cap: 'strokeCap', join: 'strokeJoin', dash: 'strokeDash' };

registerWidget('stroke-options', (spec, { app }) => {
  const b = el('button', 'btn small sl-stroke-button');
  b.type = 'button';
  b.title = 'Set shape stroke type';
  const paint = () => {
    const tool = app.tools.active;
    b.innerHTML = `${strokePreviewSvg({ dash: tool?.opt('strokeDash') ?? [], cap: tool?.opt('strokeCap') ?? 'butt' }, { width: 40, weight: 2 })}${icon('chevron-down')}`;
  };
  paint();
  b.addEventListener('click', () => {
    const tool = app.tools.active;
    if (!tool) return;
    const get = () => ({ align: tool.opt('strokeAlign') ?? 'center', cap: tool.opt('strokeCap') ?? 'butt', join: tool.opt('strokeJoin') ?? 'miter', dash: tool.opt('strokeDash') ?? [] });
    const set = (patch) => {
      for (const [k, v] of Object.entries(patch)) if (TOOL_STROKE_KEYS[k]) tool.setOpt(TOOL_STROKE_KEYS[k], Array.isArray(v) ? v.slice() : v);
      paint();
    };
    popup(app, b, strokeOptionsPanel(app, { get, set }), 'sl-stroke-pop');
  });
  return { element: b, get: () => null, set: () => paint(), setDisabled: (d) => (b.disabled = !!d), destroy: () => b.remove() };
});
