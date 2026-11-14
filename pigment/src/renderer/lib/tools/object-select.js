// Object Selection tool (wand slot): drag a rectangle or a lasso around something and the object
// inside becomes the selection. The region goes to objectSelect (src/shared/pixels/segment.js: a
// GrabCut that takes the region as probable foreground and its surroundings as background) in the
// segmentation worker, so a large layer does not freeze the window while the cut runs.
//
// Shift adds, Alt subtracts, Shift+Alt intersects (as with the marquee). Subtracting with Object
// Subtract on removes the object found inside the region; off, it removes the region as drawn.
import { Tool } from '../tools.js';
import { Selection } from '../selection.js';
import { ICON_NAMES } from '../icons.js';
import { sourceImage } from '../select-mask/output.js';
import { sampleMerged } from '../sample.js';
import { segmentEngine } from '../select-mask/engine.js';

const COMBINE_OPTION = { kind: 'segment', key: 'combine', label: '', options: [['replace', 'New selection', 'sel-new'], ['add', 'Add to selection (Shift)', 'sel-add'], ['subtract', 'Subtract (Alt)', 'sel-sub'], ['intersect', 'Intersect (Shift+Alt)', 'sel-int']], default: 'replace' };

function combineMode(tool, p) {
  if (p.shift && p.alt) return 'intersect';
  if (p.shift) return 'add';
  if (p.alt) return 'subtract';
  return tool.opt('combine') ?? 'replace';
}

/** The dashed outline every selection tool draws while dragging. */
export function strokeDashed(ctx, trace) {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#fff';
  ctx.setLineDash([]);
  ctx.beginPath();
  trace();
  ctx.stroke();
  ctx.strokeStyle = '#000';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  trace();
  ctx.stroke();
  ctx.restore();
}

/** Rectangle between two points, rounded to whole pixels and clipped to the document. */
export function dragRect(a, b, doc) {
  const x0 = Math.max(0, Math.round(Math.min(a.x, b.x))), y0 = Math.max(0, Math.round(Math.min(a.y, b.y)));
  const x1 = Math.min(doc.width, Math.round(Math.max(a.x, b.x))), y1 = Math.min(doc.height, Math.round(Math.max(a.y, b.y)));
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

export class ObjectSelectTool extends Tool {
  constructor(app) {
    super(app, {
      id: 'object-select',
      name: 'Object Selection Tool',
      // icons.js has no drawing for this tool yet; it is picked up as soon as one named 'object-select' exists
      icon: ICON_NAMES.includes('object-select') ? 'object-select' : 'smart',
      cursor: 'crosshair',
      hint: 'Drag a rectangle or a lasso around an object to select it. Shift adds, Alt subtracts, Shift+Alt intersects.',
      options: [
        COMBINE_OPTION,
        { kind: 'segment', key: 'mode', label: 'Mode', options: [['rect', 'Rectangle', 'marquee-rect'], ['lasso', 'Lasso', 'lasso']], default: 'rect' },
        { kind: 'checkbox', key: 'sampleMerged', label: 'Sample All Layers', default: false },
        { kind: 'checkbox', key: 'objectSubtract', label: 'Object Subtract', default: true },
        { kind: 'checkbox', key: 'hardEdge', label: 'Hard Edge', default: false },
      ],
    });
    this.drag = null; // { mode, start, current, points } while the region is drawn
    this.working = null; // the region being segmented (shown until the result is in)
    this.lastMs = 0;
  }

  onPointerDown(p) {
    if (this.working) return;
    this.drag = { mode: combineMode(this, p), lasso: this.opt('mode') === 'lasso', start: { x: p.x, y: p.y }, current: { x: p.x, y: p.y }, points: [[p.x, p.y]], moved: false };
  }

  onPointerMove(p, dragging) {
    const d = this.drag;
    if (!dragging || !d) return;
    d.current = { x: p.x, y: p.y };
    d.moved = true;
    if (d.lasso) {
      const last = d.points[d.points.length - 1];
      // a point per screen pixel or so is plenty for the polygon
      if (Math.hypot(p.x - last[0], p.y - last[1]) * (this.view?.zoom ?? 1) >= 1.5) d.points.push([p.x, p.y]);
    }
  }

  onPointerUp(p) {
    const d = this.drag;
    this.drag = null;
    if (!d || p.cancelled) return;
    const doc = this.doc;
    let region = null;
    if (d.lasso) {
      if (d.points.length >= 3) region = d.points;
    } else {
      const r = dragRect(d.start, d.current, doc);
      if (r.width >= 2 && r.height >= 2) region = r;
    }
    if (!d.moved || !region) {
      // a click outside any drag deselects, like the marquee
      if (d.mode === 'replace' && doc.selection && !doc.selection.isEmpty) this.app.applySelection(null, 'replace', 'Deselect');
      return;
    }
    this.select(region, d.mode).catch((err) => this.app.reportError(err, 'Object Selection failed'));
  }

  cancel() {
    if (!this.drag) return false;
    this.drag = null;
    return true;
  }

  /** The region as a plain selection (what Alt removes when Object Subtract is off). */
  plain(region, doc) {
    return Array.isArray(region) ? Selection.fromPolygon(doc.width, doc.height, region) : Selection.fromRect(doc.width, doc.height, region);
  }

  /**
   * Finds the object in the region and combines it with the selection.
   * @param {{ x: number, y: number, width: number, height: number } | Array<[number, number]>} region
   * @param {'replace' | 'add' | 'subtract' | 'intersect'} [mode]
   */
  async select(region, mode = 'replace') {
    const app = this.app, doc = this.doc;
    if (!doc || this.working) return;
    if (mode === 'subtract' && this.opt('objectSubtract') === false) {
      app.applySelection(this.plain(region, doc), 'subtract', 'Object selection');
      return;
    }
    // sample (lib/sample.js): Sample All Layers reads the stored merged image, as select-mask/output.js did
    const src = this.opt('sampleMerged')
      ? { img: sampleMerged(app, doc, { stored: true }).getContext('2d', { willReadFrequently: true }).getImageData(0, 0, doc.width, doc.height), layer: doc.active, merged: true }
      : sourceImage(app, { sampleAll: false });
    this.working = region;
    this.view?.invalidate();
    let result;
    try {
      result = await app.busy('Finding the object…', () => segmentEngine().once('object', src.img, { region, hardEdge: !!this.opt('hardEdge') }));
    } finally {
      this.working = null;
      doc.view?.invalidate();
    }
    this.lastMs = result.ms;
    // the document may have been closed or switched while the cut ran
    if (app.doc !== doc || doc.width * doc.height !== result.mask.length) return;
    const sel = Selection.fromMask(doc.width, doc.height, result.mask);
    if (sel.isEmpty) {
      app.dialogs.toast('No object found in that area', { timeout: 2500 });
      return;
    }
    app.applySelection(sel, mode, 'Object selection');
    const b = sel.bounds;
    app.statusbar.set('hint', `Object ${b.width} × ${b.height} px (${Math.round(result.ms)} ms)`);
  }

  drawOverlay(ctx, view) {
    const d = this.drag;
    const region = d?.moved ? (d.lasso ? d.points : dragRect(d.start, d.current, this.doc)) : this.working;
    if (!region) return;
    if (Array.isArray(region)) {
      strokeDashed(ctx, () => {
        region.forEach(([x, y], i) => {
          const q = view.toScreen(x, y);
          if (i) ctx.lineTo(q.x, q.y);
          else ctx.moveTo(q.x, q.y);
        });
        if (!d) ctx.closePath();
      });
    } else {
      const a = view.toScreen(region.x, region.y), b = view.toScreen(region.x + region.width, region.y + region.height);
      strokeDashed(ctx, () => ctx.rect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(b.x - a.x), Math.round(b.y - a.y)));
    }
  }
}

/** Adds the tool to the wand slot (called by lib/select-mask.js, which app.js already loads). */
export function registerObjectSelect(app) {
  if (app.tools.get('object-select')) return app.tools.get('object-select');
  return app.tools.register(new ObjectSelectTool(app), 'wand');
}
