// Snap hook (ARCHITECTURE.md "0.4 features", F; E12): every pointer gesture that places something asks app.snap
// where it lands, through the calls marked `// snap (lib/snap.js)` in the tools. Owned by guides-snapping.
//
// Targets come from providers (registerTargets): 'document' (edges and centre), 'guides', 'grid' (every gridline and
// subdivision, from the ruler origin) and 'layer' (the content bounds of the other visible layers: edges and centres);
// artboards and slices register theirs later. View > Snap To decides which kinds count (settings.guides.snapTo), and
// guides and the grid snap only while they are shown, as in Photoshop.
//
// The answer is the nearest target within 6 screen pixels (6 / zoom document px), per axis; at the same distance a
// guide wins over the document bounds, then artboards, slices, layers and the grid. box() tries the start, centre and
// end of the box. Nothing snaps when settings.snap === false, or while Ctrl / Cmd is held (pointer.ctrl or
// pointer.meta), except when that modifier summoned a temporary tool (pointer.temporary === 'ctrl'). Call sites never
// compute this themselves.
//
// Smart Guides (View > Show > Smart Guides, settings.guides.smartGuides): while a box moves ('move', 'transform') the
// lines it aligns on and equal-spacing marks are drawn (lib/smart-guides.js), and equal spacing is a snap target too;
// a point that snaps to a layer edge shows the line it met. canvas-view.js paints the overlay through drawOverlay()
// and calls end() when a gesture ends, which clears it.
import { alignmentLines, boxEdges, spacingTargets, spacingMarks, distances, drawSmartOverlay } from './smart-guides.js';

/** @typedef {{ pos: number, kind: 'document' | 'guide' | 'grid' | 'layer' | 'artboard' | 'slice' | 'pixel', id?: string, edge?: 'start' | 'centre' | 'end' }} SnapTarget */
/** @typedef {{ source: string, pointer?: object, exclude?: object[], excludeGuides?: string[], axis?: 'x' | 'y', view?: object }} SnapOpts */

export const TOLERANCE_PX = 6; // screen pixels
export const EDGES = ['start', 'centre', 'end'];
/** The View > Snap To key of each target kind. */
export const KIND_SETTING = { guide: 'guides', grid: 'grid', layer: 'layers', document: 'bounds', artboard: 'artboards', slice: 'slices' };
/** At the same distance the lower rank wins. */
export const KIND_RANK = { guide: 0, document: 1, artboard: 2, slice: 3, layer: 4, grid: 5, pixel: 6 };
export const SNAP_TO_KEYS = ['guides', 'grid', 'layers', 'bounds', 'artboards', 'slices'];
const SNAP_TO_DEFAULT = { guides: true, grid: true, layers: true, bounds: true, artboards: true, slices: true };
/** Sources that move a box: they get alignment lines, spacing marks and spacing targets. */
const MOVING = new Set(['move', 'transform']);
const CACHE_MS = 1500;
const MAX_GRID_LINES = 4000;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const rank = (t) => KIND_RANK[t?.kind] ?? 9;

/** True when this gesture must not snap (settings or the pointer's modifiers). */
export function snapDisabled(app, opts = {}) {
  if (app?.settings?.snap === false) return true;
  const p = opts.pointer;
  if (p && (p.ctrl || p.meta) && p.temporary !== 'ctrl') return true;
  return false;
}

/** The View > Snap To state: settings.guides.snapTo over the defaults (all on). */
export function snapToState(settings) {
  return { ...SNAP_TO_DEFAULT, ...(settings?.guides?.snapTo ?? {}) };
}

/** The target kinds that count now: Snap To, with guides only while shown and the grid only while shown. */
export function enabledKinds(settings) {
  const s = settings ?? {};
  const to = snapToState(s);
  const kinds = new Set(['pixel']);
  if (to.guides && s.showGuides !== false) kinds.add('guide');
  if (to.grid && s.showGrid) kinds.add('grid');
  if (to.layers) kinds.add('layer');
  if (to.bounds) kinds.add('document');
  if (to.artboards) kinds.add('artboard');
  if (to.slices) kinds.add('slice');
  return kinds;
}

/**
 * The nearest target within `tol` of any of `edges` (names[i] is the edge's name; a target with `edge` meets only the
 * edge of that name, so points (name null) never meet one). Ties go to the lower KIND_RANK, then the earlier edge.
 * Returns { target, edge, delta, d } or null.
 */
export function bestSnap(edges, names, targets, tol) {
  let best = null;
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    for (const t of targets) {
      if (t.edge && t.edge !== names[i]) continue;
      const d = Math.abs(t.pos - e);
      if (!(d <= tol)) continue;
      if (!best || d < best.d - 1e-9 || (Math.abs(d - best.d) <= 1e-9 && rank(t) < rank(best.target))) best = { target: t, edge: i, delta: t.pos - e, d };
    }
  }
  return best;
}

/** Gridline positions every `step` from `origin` that fall inside [from, to] (at most `max`). */
export function gridLines(origin, step, from, to, max = MAX_GRID_LINES) {
  if (!(step > 0) || !(to >= from)) return [];
  // too dense to be useful (or to list): every whole pixel is then as good as a gridline
  if ((to - from) / step > max) return [];
  const out = [];
  for (let k = Math.ceil((from - origin) / step - 1e-9); ; k++) {
    const v = origin + k * step;
    if (v > to + 1e-9) break;
    out.push(Math.round(v * 1000) / 1000);
  }
  return out;
}

/** The grid of a document without app.rulers (unit tests): settings.gridSize px, Subdivisions, origin 0. */
function plainGrid(settings) {
  const major = Math.max(0, Number(settings?.gridSize) || 0);
  const subdivisions = Math.max(1, Math.round(Number(settings?.gridSubdivisions) || 1));
  return { major, minor: major / subdivisions, subdivisions, origin: 0 };
}

function visibleChain(l) {
  for (let p = l; p; p = p.parent) if (p.visible === false) return false;
  return true;
}

function excludedChain(l, ex) {
  for (let p = l; p; p = p.parent) if (ex.has(p)) return true;
  return false;
}

export class Snap {
  constructor(app) {
    this.app = app;
    this.providers = new Map();
    this.cache = null;
    this.overlay = null;
    // the box a layer target uses; guides.js installs the content bounds (lib/properties/ui.js layerContentBounds)
    this.boundsOf = (layer) => layer.bounds?.() ?? null;
    this.registerTargets('document', (doc, q) => (q?.kinds && !q.kinds.has('document') ? null : {
      x: [{ pos: 0, kind: 'document' }, { pos: doc.width / 2, kind: 'document' }, { pos: doc.width, kind: 'document' }],
      y: [{ pos: 0, kind: 'document' }, { pos: doc.height / 2, kind: 'document' }, { pos: doc.height, kind: 'document' }],
    }));
    this.registerTargets('guides', (doc, q) => {
      const skip = new Set(q?.excludeGuides ?? []);
      const out = { x: [], y: [] };
      for (const g of doc.guides ?? []) if (!skip.has(g.id)) out[g.axis === 'y' ? 'y' : 'x'].push({ pos: g.pos, kind: 'guide', id: g.id });
      return out;
    });
    this.registerTargets('grid', (doc, q) => {
      if (q?.kinds && !q.kinds.has('grid')) return null;
      const r = this.app.rulers;
      const out = { x: [], y: [] };
      for (const axis of ['x', 'y']) {
        const g = r?.grid ? r.grid(doc, axis) : plainGrid(this.app.settings);
        out[axis] = gridLines(g.origin, g.minor, 0, axis === 'x' ? doc.width : doc.height).map((pos) => ({ pos, kind: 'grid' }));
      }
      return out;
    });
    this.registerTargets('layer', (doc, q) => {
      if (q?.kinds && !q.kinds.has('layer')) return null;
      const boxes = q?.boxes ?? this.layerBoxes(doc, q?.exclude);
      const out = { x: [], y: [] };
      for (const b of boxes) {
        for (const pos of boxEdges(b, 'x')) out.x.push({ pos, kind: 'layer', id: b.id });
        for (const pos of boxEdges(b, 'y')) out.y.push({ pos, kind: 'layer', id: b.id });
      }
      return out;
    });
  }

  /** Adds (or replaces: the later registration wins) a target provider. */
  registerTargets(id, provider) {
    this.providers.set(id, provider);
    this.cache = null;
  }

  /** Every provider's targets, unfiltered. */
  targets(doc, query) {
    const out = { x: [], y: [] };
    for (const provider of this.providers.values()) {
      let t;
      try {
        t = provider(doc, query);
      } catch {
        t = null;
      }
      if (t?.x) out.x.push(...t.x);
      if (t?.y) out.y.push(...t.y);
    }
    return out;
  }

  /** The content boxes of the visible layers a gesture may snap to (not those in `exclude`, nor inside them). */
  layerBoxes(doc, exclude = []) {
    const ex = new Set(exclude ?? []);
    const out = [];
    const list = typeof doc?.layers === 'function' ? doc.layers() : [];
    for (const l of list) {
      if (!l || l.isGroup || l.type === 'adjustment' || !visibleChain(l) || excludedChain(l, ex)) continue;
      if (this.app.isolationHides?.(l, doc)) continue;
      let b = null;
      try {
        b = this.boundsOf(l);
      } catch {
        b = null;
      }
      if (!b || !(b.width > 0) || !(b.height > 0)) continue;
      out.push({ x: b.x, y: b.y, width: b.width, height: b.height, id: l.id });
    }
    return out;
  }

  /** The targets of a gesture, filtered by Snap To; kept until end() (or 1.5 s without a call). */
  targetsFor(doc, opts = {}) {
    const s = this.app.settings ?? {};
    const kinds = enabledKinds(s);
    const exclude = opts.exclude ?? [];
    const key = [
      opts.source, exclude.map((l) => l?.id ?? '?').join(','), (opts.excludeGuides ?? []).join(','), [...kinds].join(','),
      s.gridSize, s.gridSubdivisions, s.guides?.gridUnit,
    ].join('|');
    const t = now();
    const c = this.cache;
    if (c && c.doc === doc && c.key === key && c.guides === doc.guides && c.origin === doc.store?.get?.('rulerOrigin') && t - c.at < CACHE_MS) {
      c.at = t;
      return c;
    }
    const query = { source: opts.source, exclude, excludeGuides: opts.excludeGuides ?? [], axis: opts.axis ?? null, kinds };
    query.boxes = kinds.has('layer') ? this.layerBoxes(doc, exclude) : [];
    const all = this.targets(doc, query);
    const keep = (x) => !x.kind || kinds.has(x.kind) || !(x.kind in KIND_RANK);
    this.cache = { doc, key, at: t, guides: doc.guides, origin: doc.store?.get?.('rulerOrigin'), x: all.x.filter(keep), y: all.y.filter(keep), boxes: query.boxes };
    return this.cache;
  }

  tolerance(opts) {
    const zoom = opts.view?.zoom ?? this.app?.view?.zoom ?? 1;
    return TOLERANCE_PX / (zoom > 0 ? zoom : 1);
  }

  smartOn() {
    return this.app.settings?.guides?.smartGuides !== false;
  }

  /** The point where p lands: each axis (only `axis` when given) moves onto the nearest target in reach. */
  point(p, opts = {}) {
    const out = { x: p?.x, y: p?.y, snapped: { x: null, y: null } };
    if (!p || snapDisabled(this.app, opts)) return this.clearOverlay(out);
    const doc = this.app?.doc;
    if (!doc) return out;
    const tol = this.tolerance(opts);
    const t = this.targetsFor(doc, opts);
    if (opts.axis !== 'y') {
      const b = bestSnap([p.x], [null], t.x, tol);
      if (b) {
        out.x = b.target.pos;
        out.snapped.x = b.target;
      }
    }
    if (opts.axis !== 'x') {
      const b = bestSnap([p.y], [null], t.y, tol);
      if (b) {
        out.y = b.target.pos;
        out.snapped.y = b.target;
      }
    }
    if (this.smartOn() && t.boxes.length) {
      // the layer edge a point met, drawn through the point and the layers on it
      const pt = { x: out.x, y: out.y, width: 0, height: 0 };
      const lines = [];
      for (const axis of ['x', 'y']) {
        const s = out.snapped[axis];
        if (s?.kind !== 'layer') continue;
        const on = t.boxes.filter((b) => boxEdges(b, axis).some((e) => Math.abs(e - s.pos) < 1e-6));
        lines.push(...alignmentLines(pt, on).filter((l) => l.axis === axis));
      }
      this.setOverlay(doc, lines.length ? { lines, gaps: [] } : null);
    }
    return out;
  }

  /**
   * The offset to add to rect so its start, centre or end meets a target (per axis; only `axis` when given). Moves
   * ('move') are rounded to whole pixels, as layers sit on whole pixels.
   */
  box(rect, opts = {}) {
    const out = { dx: 0, dy: 0, snapped: { x: null, y: null } };
    if (!rect || snapDisabled(this.app, opts)) return this.clearOverlay(out);
    const doc = this.app?.doc;
    if (!doc) return out;
    const tol = this.tolerance(opts);
    const t = this.targetsFor(doc, opts);
    const smart = this.smartOn() && MOVING.has(opts.source);
    const spacing = { x: [], y: [] };
    for (const axis of ['x', 'y']) {
      if (opts.axis && opts.axis !== axis) continue;
      if (smart && t.boxes.length) spacing[axis] = spacingTargets(rect, t.boxes, axis);
      const b = bestSnap(boxEdges(rect, axis), EDGES, spacing[axis].length ? t[axis].concat(spacing[axis]) : t[axis], tol);
      if (!b) continue;
      out[axis === 'x' ? 'dx' : 'dy'] = opts.source === 'move' ? Math.round(b.delta) : b.delta;
      out.snapped[axis] = b.target;
    }
    if (smart) {
      const moved = { x: rect.x + out.dx, y: rect.y + out.dy, width: rect.width, height: rect.height };
      const page = { x: 0, y: 0, width: doc.width, height: doc.height };
      const lines = alignmentLines(moved, [...t.boxes, page]);
      // the equal spacing the box ends on, whichever target it snapped to (the canvas centre may win a tie)
      const gaps = [];
      for (const axis of ['x', 'y']) {
        const edges = boxEdges(moved, axis);
        const hit = spacing[axis].find((st) => Math.abs(edges[EDGES.indexOf(st.edge)] - st.pos) < 0.5);
        if (hit) gaps.push(...spacingMarks(moved, hit, axis));
      }
      this.setOverlay(doc, lines.length || gaps.length ? { lines, gaps } : null);
    }
    return out;
  }

  /** Ctrl/Cmd-hover with the Move tool: the distances between box a (the selection) and b (under the pointer). */
  measure(a, b, { view } = {}) {
    const doc = this.app?.doc;
    if (!doc || !a || !b) return this.setOverlay(doc, null);
    this.setOverlay(doc, { lines: [], gaps: distances(a, b), measure: true });
    (view ?? this.app.view)?.invalidate?.();
  }

  setOverlay(doc, overlay) {
    const had = !!this.overlay;
    this.overlay = overlay ? { ...overlay, doc } : null;
    if (had && !overlay) this.app?.view?.invalidate?.();
  }

  clearOverlay(result) {
    if (this.overlay) this.setOverlay(null, null);
    return result;
  }

  /** Paints the smart-guide overlay of the gesture in progress (canvas-view.js, screen space). */
  drawOverlay(ctx, view) {
    const o = this.overlay;
    if (!o || o.doc !== view.doc) return;
    const s = this.app.settings ?? {};
    if (!o.measure && s.guides?.smartGuides === false) return;
    const r = this.app.rulers;
    drawSmartOverlay(ctx, view, o, {
      color: s.guides?.smartColor ?? '#ff00ff',
      format: (axis, v) => (r ? r.format(view.doc, axis, v, { length: true }) : `${Math.round(v)} px`),
    });
  }

  /** A gesture ended (canvas-view.js calls it): the overlay goes away and the targets are read afresh next time. */
  end() {
    this.cache = null;
    if (this.overlay) {
      this.overlay = null;
      this.app?.view?.invalidate?.();
    }
  }
}

/** Creates app.snap (app.js start() calls it before MODULES). */
export function installSnap(app) {
  app.snap = new Snap(app);
  return app.snap;
}
