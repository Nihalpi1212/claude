// Snap hook (ARCHITECTURE.md "0.4 features", F): every pointer gesture that places something asks
// app.snap where it lands. Skeleton stub; owned by guides-snapping, which replaces this file and
// keeps its exports (installSnap, the app.snap API).
//
// Stub behaviour: box() with source 'move' is exactly 0.3's MoveTool.snapDelta (document left,
// centre and right / top, middle and bottom, and the guides; x first, then y; offsets rounded;
// `axis` is not applied, as 0.3 snapped Shift-constrained moves on both axes); every other call
// returns its input unchanged, so no 0.3 behaviour changes.
//
// Snapping is off when settings.snap === false, or while Ctrl / Cmd is held (pointer.ctrl or
// pointer.meta), except when that modifier summoned a temporary tool (pointer.temporary === 'ctrl').
// Call sites never compute this themselves.

/** @typedef {{ pos: number, kind: 'document' | 'guide' | 'grid' | 'layer' | 'artboard' | 'slice' | 'pixel', id?: string }} SnapTarget */
/** @typedef {{ source: string, pointer?: object, exclude?: object[], excludeGuides?: string[], axis?: 'x' | 'y', view?: object }} SnapOpts */

export const TOLERANCE_PX = 6; // screen pixels

/** True when this gesture must not snap (settings or the pointer's modifiers). */
export function snapDisabled(app, opts = {}) {
  if (app?.settings?.snap === false) return true;
  const p = opts.pointer;
  if (p && (p.ctrl || p.meta) && p.temporary !== 'ctrl') return true;
  return false;
}

export class Snap {
  constructor(app) {
    this.app = app;
    this.providers = new Map();
    this.registerTargets('document', (doc) => ({
      x: [{ pos: 0, kind: 'document' }, { pos: doc.width / 2, kind: 'document' }, { pos: doc.width, kind: 'document' }],
      y: [{ pos: 0, kind: 'document' }, { pos: doc.height / 2, kind: 'document' }, { pos: doc.height, kind: 'document' }],
    }));
    this.registerTargets('guides', (doc, q) => {
      const skip = new Set(q?.excludeGuides ?? []);
      const out = { x: [], y: [] };
      for (const g of doc.guides ?? []) if (!skip.has(g.id)) out[g.axis === 'y' ? 'y' : 'x'].push({ pos: g.pos, kind: 'guide', id: g.id });
      return out;
    });
  }

  /** Adds (or replaces: the later registration wins) a target provider. */
  registerTargets(id, provider) {
    this.providers.set(id, provider);
  }

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

  /** The point where p lands. Stub: p itself. */
  point(p, opts = {}) {
    void opts;
    return { x: p.x, y: p.y, snapped: { x: null, y: null } };
  }

  /**
   * The offset to add to rect so one of its edges or its centre meets a target. Stub: 0.3's Move
   * tool snapping for source 'move', { dx: 0, dy: 0 } otherwise.
   */
  box(rect, opts = {}) {
    const none = { dx: 0, dy: 0, snapped: { x: null, y: null } };
    if (opts.source !== 'move' || !rect || snapDisabled(this.app, opts)) return none;
    const doc = this.app?.doc;
    if (!doc) return none;
    const zoom = opts.view?.zoom ?? this.app?.view?.zoom ?? 1;
    const tol = TOLERANCE_PX / zoom;
    const t = this.targets(doc, { source: opts.source, exclude: opts.exclude ?? [], excludeGuides: opts.excludeGuides ?? [], axis: opts.axis ?? null });
    const edgesX = [rect.x, rect.x + rect.width / 2, rect.x + rect.width];
    const edgesY = [rect.y, rect.y + rect.height / 2, rect.y + rect.height];
    const out = { dx: 0, dy: 0, snapped: { x: null, y: null } };
    find: for (const e of edgesX) {
      for (const target of t.x) {
        if (Math.abs(e - target.pos) <= tol) {
          out.dx = Math.round(target.pos - e);
          out.snapped.x = target;
          break find;
        }
      }
    }
    find: for (const e of edgesY) {
      for (const target of t.y) {
        if (Math.abs(e - target.pos) <= tol) {
          out.dy = Math.round(target.pos - e);
          out.snapped.y = target;
          break find;
        }
      }
    }
    return out;
  }

  /** A gesture ended (canvas-view.js calls it): overlays go away. Stub: nothing to clear. */
  end() {}
}

/** Creates app.snap (app.js start() calls it before MODULES). */
export function installSnap(app) {
  app.snap = new Snap(app);
  return app.snap;
}
