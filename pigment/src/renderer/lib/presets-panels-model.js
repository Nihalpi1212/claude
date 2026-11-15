// presets-panels' pure helpers (ARCHITECTURE.md "0.5 features", package 9; S10.5, S12.1): the data of the three
// preset kinds this package owns (`styles`, `shapes`, `tool-presets`), Define Custom Shape's 0..1 outline, the pattern
// references inside a style, and the tool preset lists. No DOM, no app: Node unit tests import this file
// (tests/unit/presets-panels.test.mjs).

export const STYLE_MIME = 'application/x-pigment-style'; // a style dragged from the Styles panel: its preset id (JSON)
export const SHAPE_MIME = 'application/x-pigment-shape'; // a shape dragged from the Shapes panel: its preset id (JSON)

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const tidy = (v) => {
  const r = Math.round(v * 1e5) / 1e5;
  return Object.is(r, -0) ? 0 : r;
};

// ---- shapes -------------------------------------------------------------------------------------------------------

/** True for a path value: { subpaths: [{ points: [{ x, y }, ...] }] } with finite coordinates. */
export function isPathValue(path) {
  if (!isObject(path) || !Array.isArray(path.subpaths)) return false;
  return path.subpaths.every((sp) => isObject(sp) && Array.isArray(sp.points) && sp.points.every((p) => isObject(p) && finite(p.x) && finite(p.y)));
}

/** The extremes of one cubic coordinate on 0 < t < 1 (the roots of its derivative). */
function cubicExtremes(p0, p1, p2, p3) {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const ts = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) ts.push(-c / b);
  } else {
    const d = b * b - 4 * a * c;
    if (d >= 0) {
      const s = Math.sqrt(d);
      ts.push((-b + s) / (2 * a), (-b - s) / (2 * a));
    }
  }
  const at = (t) => (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3 * p3;
  return ts.filter((t) => t > 0 && t < 1).map(at);
}

/**
 * The bounds of the drawn outline (curve extremes, not the control points): what a custom shape fills when it is
 * drawn into a box. null for an empty path.
 */
export function curveBounds(path) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  const add = (x, y) => {
    if (x < x1) x1 = x;
    if (x > x2) x2 = x;
    if (y < y1) y1 = y;
    if (y > y2) y2 = y;
  };
  for (const sp of path?.subpaths ?? []) {
    const pts = sp.points ?? [];
    const n = pts.length;
    if (!n) continue;
    for (const p of pts) add(p.x, p.y);
    const segs = sp.closed === false ? n - 1 : n;
    for (let i = 0; i < segs && n > 1; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const ax = a.outX ?? a.x, ay = a.outY ?? a.y, bx = b.inX ?? b.x, by = b.inY ?? b.y;
      if (ax === a.x && ay === a.y && bx === b.x && by === b.y) continue; // a straight segment
      for (const x of cubicExtremes(a.x, ax, bx, b.x)) add(x, a.y);
      for (const y of cubicExtremes(a.y, ay, by, b.y)) add(a.x, y);
    }
  }
  return x1 === Infinity ? null : { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/**
 * Define Custom Shape (S10.5): a path in document px as a `shapes` preset's data, { path (in a 0..1 box, stretched to
 * fill it both ways, as the built-ins are), width, height (the outline's size in px: Defined Size and Defined
 * Proportions, as .csh keeps them) }. null when the outline has no area (a single point or a straight line).
 * Open subpaths are kept open (Photoshop closes them when it fills them; so does Pigment).
 */
export function unitShape(path) {
  if (!isPathValue(path)) return null;
  const subpaths = path.subpaths.filter((sp) => sp.points.length > 0);
  if (!subpaths.length) return null;
  const b = curveBounds({ subpaths });
  if (!b || !(b.width > 1e-6) || !(b.height > 1e-6)) return null;
  const mx = (x) => tidy((x - b.x) / b.width);
  const my = (y) => tidy((y - b.y) / b.height);
  const out = subpaths.map((sp) => {
    const next = { ...clone(sp), points: [] };
    for (const p of sp.points) {
      const q = { ...clone(p), x: mx(p.x), y: my(p.y) };
      if (finite(p.inX) && finite(p.inY)) [q.inX, q.inY] = [mx(p.inX), my(p.inY)];
      if (finite(p.outX) && finite(p.outY)) [q.outX, q.outY] = [mx(p.outX), my(p.outY)];
      next.points.push(q);
    }
    return next;
  });
  return { path: { subpaths: out }, width: tidy(b.width), height: tidy(b.height) };
}

/** A `shapes` preset's data: 0.4's { path } (0..1) plus the optional width / height (Defined Size / Proportions). */
export function normalizeShapeData(data) {
  if (!isObject(data) || !isPathValue(data.path)) return null;
  const out = { ...data, path: data.path };
  for (const k of ['width', 'height']) {
    if (!(finite(data[k]) && data[k] > 0)) delete out[k];
  }
  return out;
}

/**
 * Defined Size of a custom shape in px ([width, height]): the size it was defined at when the preset says, else
 * 100 px per unit of its outline's 0..1 box (0.4's rule for the built-ins).
 */
export function definedShapeSize(data, unitBounds = null) {
  if (finite(data?.width) && finite(data?.height) && data.width > 0 && data.height > 0) return [data.width, data.height];
  const b = unitBounds ?? (data?.path ? curveBounds(data.path) : null) ?? { width: 1, height: 1 };
  return [Math.max(1e-3, b.width) * 100, Math.max(1e-3, b.height) * 100];
}

/** The box a dropped shape gets: its own proportions, the longer side a quarter of the document's shorter side. */
export function dropShapeBox(data, at, doc) {
  const [w0, h0] = definedShapeSize(data);
  const side = Math.max(8, Math.min(1000, Math.round(Math.min(doc.width, doc.height) / 4)));
  const k = side / Math.max(w0, h0);
  const width = Math.max(1, Math.round(w0 * k)), height = Math.max(1, Math.round(h0 * k));
  return { x: Math.round(at.x - width / 2), y: Math.round(at.y - height / 2), width, height };
}

// ---- styles -------------------------------------------------------------------------------------------------------

/** A PatternRef as styles hold one (L.6, S10.5): { presetId, name } in the store, with dataUrl on layers. */
export const isPatternRef = (v) => isObject(v) && (typeof v.presetId === 'string' || typeof v.dataUrl === 'string') && !('styles' in v);

/**
 * Every pattern reference inside a style's effects: [{ ref, owner }] where `owner` is the nearest object holding the
 * reference that has an `enabled` flag (the Pattern Overlay or Stroke instance, the Bevel's Texture), which is what a
 * missing pattern turns off. Instances may be arrays (several Drop Shadows...).
 */
export function stylePatternRefs(styles) {
  const out = [];
  const walk = (v, owner) => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x, owner);
      return;
    }
    if (!isObject(v)) return;
    if (isPatternRef(v)) {
      out.push({ ref: v, owner });
      return;
    }
    const own = 'enabled' in v ? v : owner;
    for (const x of Object.values(v)) walk(x, own);
  };
  walk(styles, null);
  return out;
}

/**
 * A `styles` preset's data (S10.5): { styles, blending?: the advanced options (layer.blending) | null, opacity?,
 * fillOpacity?, blend? (the layer's own, when New Style included the blending options) }. Pattern references are kept
 * as { presetId, name }: a reference that names a preset loses its pixels (the `patterns` kind has them); one
 * without a preset keeps its dataUrl so the style still draws.
 */
export function normalizeStyleData(data) {
  if (!isObject(data) || !isObject(data.styles)) return null;
  const out = clone(data);
  for (const { ref } of stylePatternRefs(out.styles)) {
    if (typeof ref.presetId === 'string' && ref.presetId) delete ref.dataUrl;
  }
  if ('blending' in out && out.blending !== null && !isObject(out.blending)) delete out.blending;
  if ('opacity' in out && !(finite(out.opacity) && out.opacity >= 0 && out.opacity <= 1)) delete out.opacity;
  if ('fillOpacity' in out && !(finite(out.fillOpacity) && out.fillOpacity >= 0 && out.fillOpacity <= 1)) delete out.fillOpacity;
  if ('blend' in out && typeof out.blend !== 'string') delete out.blend;
  return out;
}

/**
 * Applying a style (layer:style-preset): `resolved` maps a presetId to its full PatternRef (with dataUrl) or null when
 * that pattern is gone. Returns { styles, missing: [name] }: the style's effects with every reference replaced by its
 * full form, and the effects whose pattern is missing turned off (named in `missing`, once each). A reference that
 * already carries pixels (dataUrl) without a preset is kept as it is.
 */
export function resolveStyle(styles, resolved) {
  const out = clone(styles ?? {});
  const missing = [];
  for (const { ref, owner } of stylePatternRefs(out)) {
    const full = typeof ref.presetId === 'string' && ref.presetId ? resolved.get(ref.presetId) ?? null : null;
    if (full?.dataUrl) {
      Object.assign(ref, { dataUrl: full.dataUrl, presetId: ref.presetId, name: full.name ?? ref.name });
      continue;
    }
    if (typeof ref.dataUrl === 'string' && ref.dataUrl) continue; // pixels of its own
    if (owner) owner.enabled = false;
    const name = ref.name || 'Pattern';
    if (!missing.includes(name)) missing.push(name);
  }
  return { styles: out, missing };
}

/**
 * Shift-click in the Styles panel: the style's effects added to the layer's. A key the style turns on replaces the
 * layer's instances of that key; every other key of the layer stays (Photoshop's "add to the current effects").
 */
export function addStyle(current, styles) {
  const out = clone(isObject(current) ? current : {});
  for (const [k, v] of Object.entries(styles ?? {})) {
    if (k === 'hidden' || k.startsWith('_')) continue;
    const list = Array.isArray(v) ? v : [v];
    if (list.some((fx) => isObject(fx) && fx.enabled)) out[k] = clone(v);
  }
  if (out.hidden) delete out.hidden;
  return out;
}

/** The effect keys a style turns on, in its own order (the thumbnails' tooltips, tests). */
export function enabledEffects(styles) {
  return Object.entries(styles ?? {}).filter(([k, v]) => k !== 'hidden' && (Array.isArray(v) ? v : [v]).some((fx) => isObject(fx) && fx.enabled)).map(([k]) => k);
}

// ---- tool presets -------------------------------------------------------------------------------------------------

/**
 * What a tool preset keeps of a tool's options: every option the tool shows, at its current value (defaults
 * included, so applying the preset sets all of them, as Photoshop's do), plus whatever else is stored for it; never
 * `brush` (the preset's own `brush` holds it, S10.5).
 */
export function capturedOptions(specs, stored, opt) {
  const out = {};
  for (const s of specs ?? []) {
    if (!s || typeof s.key !== 'string' || s.kind === 'button' || s.kind === 'label') continue;
    const v = opt(s.key);
    if (v !== undefined) out[s.key] = clone(v);
  }
  for (const [k, v] of Object.entries(isObject(stored) ? stored : {})) {
    if (k === 'brush' || v === undefined) continue;
    out[k] = clone(v);
  }
  delete out.brush;
  return out;
}

/** "Brush Tool 1", "Brush Tool 2"...: the first free name for a new tool preset of a tool. */
export function nextPresetName(base, names) {
  const used = new Set(names ?? []);
  for (let i = 1; ; i++) if (!used.has(`${base} ${i}`)) return `${base} ${i}`;
}

/** The tool presets a list shows: those of `toolId` only with Current Tool Only, else all. */
export function visibleToolPresets(list, toolId, currentOnly) {
  return (list ?? []).filter((p) => !currentOnly || p?.data?.tool === toolId);
}

/** Sort by Tool: presets in toolbox order (`order`: tool ids), each tool's in their own order; unknown tools last. Returns ids. */
export function sortedByTool(list, order) {
  const rank = (id) => {
    const i = (order ?? []).indexOf(id);
    return i < 0 ? Infinity : i;
  };
  return (list ?? []).map((p, i) => ({ p, i })).sort((a, b) => rank(a.p.data?.tool) - rank(b.p.data?.tool) || a.i - b.i).map(({ p }) => p.id);
}
