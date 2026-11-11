// The Select and Mask workspace (Select > Select and Mask…, Ctrl+Alt+R).
//
// The session is a hidden tool, like Free Transform and the Blur Gallery: while it runs it is the
// active tool, so the canvas view hands it the pointer and the keys and draws its overlay. The
// toolbox and the panel dock give way to the workspace's own tool strip (Quick Selection, Refine
// Edge Brush, Brush, Object Selection, Lasso, Polygonal Lasso, Hand, Zoom) and its Properties panel
// (View Mode, Refine Mode, Edge Detection, Global Refinements, Output Settings).
//
// State of a session:
//   base     the selection the tools edit (starts as the document's selection, or the layer's mask)
//   extra    what the Refine Edge Brush painted: unknown area the matting re-estimates
//   refined  refineEdge(image, base, settings) — what the view shows and OK outputs; null while the
//            settings change nothing (then base is shown as it is)
// Refining runs in the segmentation worker (engine.js), latest request wins, so sliders and brushes
// stay live on large layers; while a stroke is drawn the unrefined base is shown where it changed.
// The document is not touched until OK: the view shows the session's mask through view.postProcess
// (preview.js). OK waits for the refinement to be current and outputs once (output.js: one history
// entry), Cancel leaves no trace. Other commands are refused while the workspace is open; Undo and
// Redo step through the session's own strokes.
import { Tool } from '../tools.js';
import { buildForm } from '../form.js';
import { icon } from '../icons.js';
import { createCanvas } from '../document.js';
import { bridge } from '../bridge.js';
import { selectionOps, Selection } from '../selection.js';
import { cropImage, clampRect } from '../../../shared/pixels/core.js';
import { MaskPreview, VIEW_MODES, VIEW_KEYS } from './preview.js';
import { sourceImage, outputMask, maskOfLayer, constrainPixels, OUTPUTS, PIXEL_OUTPUTS, isOutput } from './output.js';
import { strokeDashed, dragRect } from '../tools/object-select.js';

export const TOOL_ID = 'select-mask';
const LABEL = 'Select and Mask';
const UNDO_LIMIT = 40;
const UNDO_BYTES = 192 * 1024 * 1024; // memory the workspace's own undo steps may hold
const HIT = 8; // screen px around the first point of a polygon that closes it

/** Commands that may run while the workspace is open (they do not touch the document). */
const SAFE_COMMANDS = /^(view:(?!next-tab|prev-tab)|help:|app:escape$|app:enter$)/;

/** Edge Detection, Global Refinements and Output Settings: what OK applies and an action replays. */
export const REFINE_DEFAULTS = Object.freeze({ mode: 'color', radius: 0, smartRadius: false, smooth: 0, feather: 0, contrast: 0, shift: 0, decontaminate: false, amount: 100, output: 'selection' });
const REFINE_RANGES = { radius: [0, 250], smooth: [0, 100], feather: [0, 100], contrast: [0, 100], shift: [-100, 100], amount: [0, 100] };

/** Remembered between sessions (settings.tools['select-mask']): the view and the tools. */
const PREF_DEFAULTS = Object.freeze({
  view: 'onion', onion: 50, opacity_overlay: 50, opacity_black: 100, opacity_white: 100, color: '#ff0000', indicates: 'masked',
  tool: 'quick', mode: 'add', quickSize: 40, refineSize: 40, brushSize: 30, brushHardness: 1, objectMode: 'rect', sampleAll: false,
});

const svg = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
const SUB_TOOLS = [
  { id: 'quick', name: 'Quick Selection Tool', key: 'W', icon: icon('quick-select'), hint: 'Paint over an area to add it to the selection; Alt removes.' },
  { id: 'refine', name: 'Refine Edge Brush Tool', key: 'R', icon: svg('<path d="M10 13.5 18 5.5a2 2 0 0 1 3 3l-8 8"/><path d="M10 13.5c-1.6 0-3 1.3-3 3 0 1.2-.8 2-2.4 2 1.6.9 5.6 1.2 6.8-.8.7-1.2.6-2.6-.4-4.2z"/><path d="M3 7c1-1 2-1 3 0s2 1 3 0M3 11c1-1 2-1 3 0" stroke-dasharray="1.5 1.5"/>'), hint: 'Paint along soft edges (hair, fur) to have them re-estimated from the image; Alt restores the original edge.' },
  { id: 'brush', name: 'Brush Tool', key: 'B', icon: icon('brush'), hint: 'Paint to add to the selection by hand; Alt removes.' },
  { id: 'object', name: 'Object Selection Tool', key: 'W', icon: svg('<rect x="3" y="3" width="13" height="13" stroke-dasharray="3 2"/><path d="m11 10 9 4-4 1.5-1.5 4.5z" fill="currentColor"/>'), hint: 'Drag a rectangle or a lasso around an object to add it; Alt removes the object inside.' },
  { id: 'lasso', name: 'Lasso Tool', key: 'L', icon: icon('lasso'), hint: 'Draw a freehand outline to add it; Alt removes.' },
  { id: 'polygon', name: 'Polygonal Lasso Tool', key: 'L', icon: icon('lasso-poly'), hint: 'Click corner points; double-click, Enter or a click on the first point closes the outline. Alt at the first click removes.' },
  { id: 'hand', name: 'Hand Tool', key: 'H', icon: icon('hand'), hint: 'Drag to move the view (or hold Space with any tool).' },
  { id: 'zoom', name: 'Zoom Tool', key: 'Z', icon: icon('zoom'), hint: 'Click to zoom in, Alt-click to zoom out.' },
];
const BRUSH_TOOLS = { quick: 'quickSize', refine: 'refineSize', brush: 'brushSize' };
const EDIT_TOOLS = new Set(['quick', 'refine', 'brush', 'object', 'lasso', 'polygon']);

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
/** True when a plane holds a value of at least `min` (a plain loop: these planes have millions of entries). */
function holds(plane, min = 1) {
  for (let p = 0; p < plane.length; p++) if (plane[p] >= min) return true;
  return false;
}
const union = (a, b) => {
  if (!a) return b ? { ...b } : null;
  if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
};

/** A complete, valid copy of refinement settings (an action's or a caller's may be partial). */
export function normaliseRefine(p = {}) {
  const out = { ...REFINE_DEFAULTS };
  for (const [k, [lo, hi]] of Object.entries(REFINE_RANGES)) if (Number.isFinite(+p[k]) && p[k] !== null && p[k] !== '') out[k] = clamp(+p[k], lo, hi);
  if (p.mode === 'object' || p.mode === 'color') out.mode = p.mode;
  out.smartRadius = !!p.smartRadius;
  out.decontaminate = !!p.decontaminate;
  if (isOutput(p.output)) out.output = p.output;
  // decontaminated colours need pixels to live in: a selection or a mask alone cannot hold them
  if (out.decontaminate && !PIXEL_OUTPUTS.has(out.output)) out.output = 'layer-mask';
  return out;
}

/** The options refineEdge takes for these settings (extra: the Refine Edge Brush's area). */
export function refineOptions(p, extra = null, extraRadius = 0) {
  return { radius: p.radius, smartRadius: p.smartRadius, smooth: p.smooth, feather: p.feather, contrast: p.contrast, shift: p.shift, mode: p.mode, extra, extraRadius };
}
export const changesMask = (p, extraAny = false) => extraAny || p.radius > 0 || p.smooth > 0 || p.feather > 0 || p.contrast > 0 || p.shift !== 0;

function cropPlane(src, r, W) {
  const out = new src.constructor(r.width * r.height);
  for (let y = 0; y < r.height; y++) out.set(src.subarray((r.y + y) * W + r.x, (r.y + y) * W + r.x + r.width), y * r.width);
  return out;
}
function pastePlane(dst, data, r, W) {
  for (let y = 0; y < r.height; y++) dst.set(data.subarray(y * r.width, (y + 1) * r.width), (r.y + y) * W + r.x);
}

/**
 * Stamps a round dab into a plane with max (add) or min (remove), so overlapping dabs of one stroke
 * never build up beyond the brush's own profile. Returns the rect it touched.
 */
function stamp(plane, W, H, cx, cy, r, hardness, add) {
  const x0 = Math.max(0, Math.floor(cx - r - 1)), y0 = Math.max(0, Math.floor(cy - r - 1));
  const x1 = Math.min(W, Math.ceil(cx + r + 1)), y1 = Math.min(H, Math.ceil(cy + r + 1));
  if (x1 <= x0 || y1 <= y0) return null;
  const ramp = r * (1 - hardness) + 1; // from full inside the hard core to nothing half a pixel past the rim
  for (let y = y0; y < y1; y++) {
    const dy = y + 0.5 - cy;
    for (let x = x0; x < x1; x++) {
      const dx = x + 0.5 - cx, d = Math.sqrt(dx * dx + dy * dy);
      const c = (r + 0.5 - d) / ramp;
      if (c <= 0) continue;
      const v = c >= 1 ? 255 : Math.round(c * 255), p = y * W + x;
      if (add) {
        if (plane[p] < v) plane[p] = v;
      } else if (plane[p] > 255 - v) plane[p] = 255 - v;
    }
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export class SelectMaskTool extends Tool {
  /** @param {import('../../app.js').App} app @param {import('./engine.js').SegmentEngine} engine */
  constructor(app, engine) {
    super(app, { id: TOOL_ID, name: LABEL, icon: 'mask', hint: '', options: [] });
    this.engine = engine;
    this.session = null;
    this.ending = false;
    this.cursor = () => this.subCursor();
    const sub = (ids) => (t) => !!t.session && ids.includes(t.session.tool);
    // drawn by the options bar; the hidden ones only carry defaults for what the panel remembers
    this.options = [
      { kind: 'segment', key: 'mode', label: '', options: [['add', 'Add to selection', 'sel-add'], ['subtract', 'Subtract from selection (Alt)', 'sel-sub']], default: PREF_DEFAULTS.mode, when: sub([...EDIT_TOOLS]) },
      { kind: 'slider', key: 'quickSize', label: 'Size', min: 1, max: 500, step: 1, default: PREF_DEFAULTS.quickSize, unit: 'px', when: sub(['quick']) },
      { kind: 'slider', key: 'refineSize', label: 'Size', min: 1, max: 500, step: 1, default: PREF_DEFAULTS.refineSize, unit: 'px', when: sub(['refine']) },
      { kind: 'slider', key: 'brushSize', label: 'Size', min: 1, max: 500, step: 1, default: PREF_DEFAULTS.brushSize, unit: 'px', when: sub(['brush']) },
      { kind: 'slider', key: 'brushHardness', label: 'Hardness', min: 0, max: 1, step: 0.01, default: PREF_DEFAULTS.brushHardness, when: sub(['brush']) },
      { kind: 'segment', key: 'objectMode', label: 'Mode', options: [['rect', 'Rectangle', 'marquee-rect'], ['lasso', 'Lasso', 'lasso']], default: PREF_DEFAULTS.objectMode, when: sub(['object']) },
      { kind: 'checkbox', key: 'sampleAll', label: 'Sample All Layers', default: PREF_DEFAULTS.sampleAll, when: (t) => !!t.session },
      { kind: 'button', key: 'subject', label: 'Select Subject', onClick: (t) => t.selectSubject(), when: (t) => !!t.session },
    ];
  }

  // ---- preferences ----------------------------------------------------------------------------------------------

  pref(key) {
    const stored = this.app.settings.tools?.[TOOL_ID];
    const v = stored && key in stored ? stored[key] : undefined;
    const def = PREF_DEFAULTS[key];
    return v === undefined || v === null || typeof v !== typeof def ? def : v;
  }
  setPref(key, value) {
    this.app.tools.setOpt(TOOL_ID, key, value, { silent: true });
  }
  /** What the preview needs for the current view. */
  viewSettings() {
    const s = this.session, view = this.pref('view');
    return { view, onion: this.pref('onion'), opacity: view === 'overlay' || view === 'black' || view === 'white' ? this.pref(`opacity_${view}`) : 100, color: this.pref('color'), indicates: this.pref('indicates'), showEdge: !!s?.showEdge, enabled: !s?.previewOff };
  }

  // ---- lifecycle --------------------------------------------------------------------------------------------------

  canOpen() {
    return !!this.app.doc && !this.session;
  }

  /**
   * Opens the workspace. Resolves with what OK produced ({ output, layer?, doc?, params }) or null (Cancel).
   * @param {{ mask?: Uint8ClampedArray, params?: object }} [opts] mask: start from this selection (Focus Area hands
   *   its result over); params: refinement settings to start with
   */
  open(opts = {}) {
    const app = this.app, doc = app.doc;
    if (!doc) return Promise.resolve(null);
    if (this.session) {
      app.dialogs.toast('Select and Mask is already open', { kind: 'error' });
      return Promise.resolve(null);
    }
    const W = doc.width, H = doc.height, layer = doc.active;
    const hasSel = !!doc.selection && !doc.selection.isEmpty;
    const fromMask = !(opts.mask?.length === W * H) && !hasSel && !!layer?.mask?.canvas;
    const given = opts.mask?.length === W * H ? opts.mask : null;
    const base = given ? new Uint8ClampedArray(given) : hasSel ? new Uint8ClampedArray(doc.selection.mask) : fromMask ? maskOfLayer(doc, layer) : new Uint8ClampedArray(W * H);
    const params = normaliseRefine({ ...(opts.params ?? {}) });
    // a layer whose mask is being refined gets the result back as its mask unless told otherwise
    if (fromMask && !opts.params?.output) params.output = 'mask';
    if (!layer) params.output = 'selection';
    const src = sourceImage(app, { sampleAll: this.pref('sampleAll') });
    const s = {
      doc, layer, W, H, src, key: this.engine.addImage(src.img), base, extra: new Uint8Array(W * H), extraAny: false, extraRadius: 0,
      refined: null, shown: base, outline: null, params, start: { base: new Uint8ClampedArray(base), params: { ...params } },
      tool: SUB_TOOLS.some((t) => t.id === this.pref('tool')) ? this.pref('tool') : 'quick',
      undo: [], redo: [], stroke: null, lasso: null, drag: null, working: null, showEdge: false, showOriginal: false, previewOff: false,
      refine: { running: false, queued: false, stale: false, timer: 0, waiters: [], ms: 0, count: 0 },
      applying: false, resolve: null, panel: null, strip: null, form: null, antsTimer: 0,
    };
    const done = new Promise((resolve) => {
      s.resolve = resolve;
    });
    this.session = s;
    this.returnTo = app.tools.active && app.tools.active !== this ? app.tools.active.id : 'move';
    s.preview = new MaskPreview(app, doc, { layer });
    s.preview.set(this.viewSettings());
    s.preview.setMask(base);
    const appEl = document.getElementById('app');
    s.panelsWereHidden = !!appEl?.classList.contains('panels-hidden');
    appEl?.classList.remove('panels-hidden'); // the workspace brings its own panels
    this.buildUi();
    document.body.classList.add('select-mask-active');
    app.tools.tools.set(TOOL_ID, this); // registered only while the workspace is open: it is not a toolbox tool
    app.tools.activate(TOOL_ID);
    s.offDoc = app.on('doc:activated', (d) => {
      if (this.session === s && d !== s.doc) this.cancel({ force: true });
    });
    this.syncAnts();
    if (changesMask(params)) this.scheduleRefine(0);
    this.status();
    requestAnimationFrame(() => doc.view?.resize());
    return done;
  }

  activate() {
    this.hint = SUB_TOOLS.find((t) => t.id === this.session?.tool)?.hint ?? '';
  }

  deactivate() {
    // another tool or document took over behind the workspace's back: nothing may stay half open
    if (!this.session || this.ending) return;
    this.finish(null, { switchBack: false });
    // a document switch re-activates whatever tool is current: the closed workspace must not stay in hand
    queueMicrotask(() => {
      if (!this.session && this.app.tools.active === this) this.app.tools.activate(this.app.tools.get(this.returnTo) ? this.returnTo : 'move');
    });
  }

  /** Escape: an outline being drawn is dropped first, then the workspace closes without changes. */
  cancel({ force = false } = {}) {
    const s = this.session;
    if (!s) return false;
    if (!force && (s.lasso || s.drag || s.stroke)) {
      this.abortGesture();
      return true;
    }
    if (s.applying && !force) return true;
    this.finish(null);
    return true;
  }

  /** Enter and OK. */
  commit() {
    const s = this.session;
    if (!s) return false;
    if (s.lasso?.polygon) {
      this.closeLasso();
      return true;
    }
    if (s.applying) return true;
    s.applying = true;
    this.status();
    this.apply().catch((err) => {
      this.app.reportError(err, `${LABEL} failed`);
      if (this.session === s) this.finish(null);
    });
    return true;
  }

  async apply() {
    const s = this.session, app = this.app;
    this.abortGesture();
    await this.idle();
    if (this.session !== s) return;
    const params = normaliseRefine(s.params);
    const mask = new Uint8ClampedArray(s.refined ?? s.base);
    let pixels = null;
    if (params.decontaminate && PIXEL_OUTPUTS.has(params.output)) {
      const res = await app.busy('Decontaminating colours…', () => this.engine.run('decontaminate', s.key, { alpha: mask, amount: params.amount / 100 }));
      if (this.session !== s) return;
      pixels = constrainPixels(app, s.doc, s.layer, res.data);
    }
    const src = s.src;
    // the workspace is gone before the document changes: a new document as output activates another view
    this.finish(undefined, { resolve: false });
    let result = null;
    try {
      result = outputMask(app, { mask, output: params.output, label: LABEL, source: src, pixels });
    } catch (err) {
      app.reportError(err, `${LABEL} failed`);
    }
    s.resolve?.(result ? { ...result, params } : null);
  }

  /** Closes the workspace. `result` resolves open(); with resolve: false the caller resolves it. */
  finish(result, { switchBack = true, resolve = true } = {}) {
    const s = this.session;
    if (!s) return;
    const app = this.app;
    this.session = null;
    clearTimeout(s.refine.timer);
    clearInterval(s.antsTimer);
    for (const w of s.refine.waiters.splice(0)) w();
    s.offDoc?.();
    s.preview.destroy();
    s.panel?.remove();
    s.strip?.remove();
    this.engine.dropImage(s.key);
    document.body.classList.remove('select-mask-active');
    if (s.panelsWereHidden) document.getElementById('app')?.classList.add('panels-hidden');
    this.ending = true;
    try {
      if (switchBack && app.tools.active === this) app.tools.activate(app.tools.get(this.returnTo) ? this.returnTo : 'move');
    } finally {
      this.ending = false;
      app.tools.tools.delete(TOOL_ID);
    }
    app.commands.invalidate();
    requestAnimationFrame(() => s.doc.view?.resize());
    s.doc.view?.invalidate();
    if (resolve) s.resolve?.(result ?? null);
  }

  // ---- refinement -------------------------------------------------------------------------------------------------

  needsRefine() {
    const s = this.session;
    return changesMask(s.params, s.extraAny);
  }

  /** The mask on screen: the refined one, or the base while nothing refines it or Show Original is on. */
  show(rect = null) {
    const s = this.session;
    const mask = s.showOriginal || !s.refined ? s.base : s.refined;
    s.shown = mask;
    s.outline = null;
    s.preview.setMask(mask, rect);
  }

  /** The base changed in `rect` (a stroke, a lasso, an object): show it now, refine it shortly. */
  changed(rect = null) {
    const s = this.session;
    this.refreshExtra(rect);
    if (this.needsRefine()) {
      // until the refined edge is back, the changed part shows the plain base
      if (s.refined && rect && !s.showOriginal) {
        const r = clampRect(rect, s.W, s.H);
        if (r.width > 0) pastePlane(s.refined, cropPlane(s.base, r, s.W), r, s.W);
      }
      this.show(rect);
      this.scheduleRefine(s.stroke ? 180 : 0);
    } else {
      // nothing refines the base any more (the last painted edge was undone): the whole view goes back to it
      const wasRefined = !!s.refined;
      s.refined = null;
      this.show(wasRefined ? null : rect);
      if (s.showEdge) this.scheduleRefine(0);
    }
    this.status();
  }

  scheduleRefine(delay = 60) {
    const s = this.session;
    if (!s) return;
    s.refine.stale = true;
    clearTimeout(s.refine.timer);
    s.refine.timer = setTimeout(() => {
      s.refine.timer = 0;
      if (this.session === s) this.refineLoop();
    }, delay);
    this.status();
  }

  async refineLoop() {
    const s = this.session, r = s.refine;
    if (r.running) {
      r.queued = true;
      return;
    }
    r.running = true;
    try {
      do {
        r.queued = false;
        if (this.needsRefine()) {
          const key = s.key;
          let res;
          try {
            res = await this.engine.run('refine', key, { mask: s.base, options: refineOptions(s.params, s.extraAny ? s.extra : null, s.extraRadius) });
          } catch (err) {
            // Sample All Layers swapped the image under a refinement in flight: run it again on the new one
            if (this.session === s && key !== s.key) {
              r.queued = true;
              continue;
            }
            throw err;
          }
          if (this.session !== s) return;
          r.ms = res.ms;
          r.count++;
          // a newer request is waiting: its result replaces this one in a moment, but showing this one keeps a dragged slider live
          s.refined = res.mask;
        } else s.refined = null;
        if (!s.stroke) this.show();
        if (s.showEdge && !r.queued) {
          const band = await this.engine.run('band', s.key, { mask: s.base, options: { radius: s.params.radius, smartRadius: s.params.smartRadius, extra: s.extraAny ? s.extra : null } });
          if (this.session !== s) return;
          s.preview.setBand(band.band);
        }
      } while (r.queued);
    } catch (err) {
      this.app.reportError(err, 'Refining the edge failed');
    } finally {
      r.running = false;
      if (this.session === s && !r.timer) {
        r.stale = false;
        for (const w of r.waiters.splice(0)) w();
        this.status();
      }
    }
  }

  /** Resolves once the shown mask is the refinement of the current base and settings. */
  idle() {
    const s = this.session;
    if (!s) return Promise.resolve();
    const r = s.refine;
    if (r.timer) {
      clearTimeout(r.timer);
      r.timer = 0;
      this.refineLoop();
    }
    if (!r.stale && !r.running) return Promise.resolve();
    return new Promise((resolve) => r.waiters.push(resolve));
  }

  // ---- edits (each one undoable inside the workspace) -----------------------------------------------------------------

  /** Copies of the planes before a change; end(rect) records what changed inside rect. */
  begin() {
    const s = this.session;
    return { base: new Uint8ClampedArray(s.base), extra: new Uint8Array(s.extra), extraAny: s.extraAny, extraRadius: s.extraRadius };
  }

  end(before, rect, label) {
    const s = this.session;
    const r = rect ? clampRect(rect, s.W, s.H) : null;
    if (!r || r.width <= 0) return;
    // the Refine Edge Brush's plane is recorded only while there is something painted in it
    const withExtra = before.extraAny || s.extraAny;
    const entry = {
      label, rect: r,
      base: [cropPlane(before.base, r, s.W), cropPlane(s.base, r, s.W)],
      extra: withExtra ? [cropPlane(before.extra, r, s.W), cropPlane(s.extra, r, s.W)] : null,
      flags: [{ extraAny: before.extraAny, extraRadius: before.extraRadius }, { extraAny: s.extraAny, extraRadius: s.extraRadius }],
    };
    entry.bytes = r.width * r.height * (withExtra ? 4 : 2);
    s.undo.push(entry);
    s.redo.length = 0;
    // oldest steps go first once the strokes hold too much memory (whole-image steps of a large document are big)
    let bytes = s.undo.reduce((n, e) => n + e.bytes, 0);
    while (s.undo.length > 1 && (s.undo.length > UNDO_LIMIT || bytes > UNDO_BYTES)) bytes -= s.undo.shift().bytes;
    this.changed(r);
  }

  step(from, to, which) {
    const s = this.session;
    if (!s || s.stroke || s.applying) return false;
    const e = from.pop();
    if (!e) return false;
    pastePlane(s.base, e.base[which], e.rect, s.W);
    if (e.extra) pastePlane(s.extra, e.extra[which], e.rect, s.W);
    s.extraAny = e.flags[which].extraAny;
    s.extraRadius = e.flags[which].extraRadius;
    to.push(e);
    this.changed(e.rect);
    return true;
  }
  undo() {
    return this.session ? this.step(this.session.undo, this.session.redo, 0) : false;
  }
  redo() {
    return this.session ? this.step(this.session.redo, this.session.undo, 1) : false;
  }

  /** Replaces the whole base through fn(base) (Clear, Invert, Select All, Select Subject). */
  replaceAll(label, fn) {
    const s = this.session;
    if (!s || s.applying) return;
    this.abortGesture();
    const before = this.begin();
    fn(s.base, s);
    this.end(before, { x: 0, y: 0, width: s.W, height: s.H }, label);
  }
  clear() {
    this.replaceAll('Clear Selection', (base, s) => {
      base.fill(0);
      s.extra.fill(0);
      s.extraAny = false;
      s.extraRadius = 0;
    });
  }
  invert() {
    this.replaceAll('Invert', (base) => {
      for (let p = 0; p < base.length; p++) base[p] = 255 - base[p];
    });
  }
  selectAll() {
    this.replaceAll('Select All', (base) => base.fill(255));
  }

  /** Reset: the selection and the settings the workspace opened with; the strokes can still be undone. */
  reset() {
    const s = this.session;
    if (!s || s.applying) return;
    this.replaceAll('Reset', (base) => {
      base.set(s.start.base);
      s.extra.fill(0);
      s.extraAny = false;
      s.extraRadius = 0;
    });
    Object.assign(s.params, s.start.params);
    s.showEdge = false;
    s.showOriginal = false;
    s.preview.set(this.viewSettings());
    this.syncForm();
    this.scheduleRefine(0);
  }

  /** The Select Subject button: the subject of the layer replaces the selection. */
  async selectSubject() {
    const s = this.session;
    if (!s || s.working || s.applying) return;
    this.abortGesture();
    s.working = { x: 0, y: 0, width: s.W, height: s.H };
    try {
      const res = await this.app.busy('Select Subject…', () => this.engine.run('subject', s.key, {}));
      if (this.session !== s) return;
      if (!holds(res.mask)) this.app.dialogs.toast('No subject stands out in this layer', { timeout: 2500 });
      else this.replaceAll('Select Subject', (base) => base.set(res.mask));
    } catch (err) {
      this.app.reportError(err, 'Select Subject failed');
    } finally {
      s.working = null;
      s.doc.view?.invalidate();
    }
  }

  /** Sample All Layers changed: the tools and the matting look at the other pixels from now on. */
  resample() {
    const s = this.session;
    if (!s) return;
    const src = sourceImage(this.app, { sampleAll: this.pref('sampleAll') });
    this.engine.dropImage(s.key);
    s.src = src;
    s.key = this.engine.addImage(src.img);
    this.scheduleRefine(0);
  }

  // ---- tools --------------------------------------------------------------------------------------------------------

  setTool(id) {
    const s = this.session;
    if (!s || !SUB_TOOLS.some((t) => t.id === id) || s.tool === id) return;
    this.abortGesture();
    s.tool = id;
    this.setPref('tool', id);
    this.hint = SUB_TOOLS.find((t) => t.id === id).hint;
    for (const b of s.strip.querySelectorAll('[data-tool]')) {
      b.classList.toggle('active', b.dataset.tool === id);
      b.setAttribute('aria-pressed', String(b.dataset.tool === id));
    }
    this.app.tools.renderOptions();
    this.app.tools.updateCursor();
    this.app.statusbar.set('hint', this.hint);
    this.view?.invalidate();
  }

  subCursor() {
    const s = this.session;
    if (!s) return 'default';
    if (s.tool === 'hand') return s.drag?.pan ? 'grabbing' : 'grab';
    if (s.tool === 'zoom') return 'zoom-in';
    return 'crosshair';
  }

  /** Alt flips the options bar's add / subtract for one gesture. */
  subtracting(p) {
    return (this.pref('mode') === 'subtract') !== !!p.alt;
  }

  onOptionChanged(key) {
    if (key === 'sampleAll') this.resample();
    // sizes and modes decide which controls and which cursor ring are shown
    if (key === 'objectMode' || key === 'mode') this.view?.invalidate();
  }

  abortGesture() {
    const s = this.session;
    if (!s) return;
    if (s.stroke) {
      // a stroke in flight is taken back whole
      s.base.set(s.stroke.before.base);
      s.extra.set(s.stroke.before.extra);
      s.extraAny = s.stroke.before.extraAny;
      s.extraRadius = s.stroke.before.extraRadius;
      const rect = s.stroke.rect;
      s.stroke = null;
      if (rect) this.changed(rect);
    }
    s.lasso = null;
    s.drag = null;
    this.view?.invalidate();
  }

  onPointerDown(p) {
    const s = this.session;
    if (!s || s.applying || s.working) return;
    const tool = s.tool;
    if (tool === 'hand') {
      s.drag = { pan: true, x: p.screenX, y: p.screenY };
      this.app.tools.updateCursor();
    } else if (tool === 'zoom') {
      s.drag = { zoom: true, out: !!p.alt };
    } else if (tool === 'quick' || tool === 'refine' || tool === 'brush') {
      s.stroke = { tool, subtract: this.subtracting(p), before: this.begin(), rect: null, last: null, grown: tool === 'quick' ? new Uint8Array(s.W * s.H) : null };
      this.paint(p.x, p.y);
    } else if (tool === 'object') {
      s.drag = { object: true, lasso: this.pref('objectMode') === 'lasso', subtract: this.subtracting(p), start: { x: p.x, y: p.y }, current: { x: p.x, y: p.y }, points: [[p.x, p.y]], moved: false };
    } else if (tool === 'lasso') {
      s.lasso = { polygon: false, subtract: this.subtracting(p), points: [[p.x, p.y]], hover: null };
    } else if (tool === 'polygon') {
      if (!s.lasso) s.lasso = { polygon: true, subtract: this.subtracting(p), points: [[p.x, p.y]], hover: null };
      else {
        const [fx, fy] = s.lasso.points[0];
        if (s.lasso.points.length > 2 && Math.hypot(p.x - fx, p.y - fy) * this.view.zoom < HIT) this.closeLasso();
        else s.lasso.points.push([p.x, p.y]);
      }
    }
  }

  onPointerMove(p, dragging) {
    const s = this.session;
    if (!s) return;
    if (s.drag?.pan && dragging) {
      this.view.panBy(p.screenX - s.drag.x, p.screenY - s.drag.y);
      s.drag.x = p.screenX;
      s.drag.y = p.screenY;
    } else if (s.stroke && dragging) this.paint(p.x, p.y);
    else if (s.drag?.object && dragging) {
      const d = s.drag;
      d.current = { x: p.x, y: p.y };
      d.moved = true;
      const last = d.points[d.points.length - 1];
      if (d.lasso && Math.hypot(p.x - last[0], p.y - last[1]) * this.view.zoom >= 1.5) d.points.push([p.x, p.y]);
    } else if (s.lasso && !s.lasso.polygon && dragging) s.lasso.points.push([p.x, p.y]);
    else if (s.lasso?.polygon) s.lasso.hover = [p.x, p.y];
  }

  onPointerUp(p) {
    const s = this.session;
    if (!s) return;
    if (p.cancelled) return this.abortGesture();
    if (s.drag?.pan) {
      s.drag = null;
      this.app.tools.updateCursor();
    } else if (s.drag?.zoom) {
      const out = s.drag.out;
      s.drag = null;
      this.view.zoomStep(out ? -1 : 1, { x: p.screenX, y: p.screenY });
    } else if (s.stroke) {
      const st = s.stroke;
      s.stroke = null;
      if (st.tool === 'refine') {
        // erasing may have removed the last of the painted area
        if (st.subtract) s.extraAny = holds(s.extra, 128);
        else if (st.rect) {
          s.extraAny = true;
          s.extraRadius = Math.max(s.extraRadius, this.pref('refineSize') / 2);
        }
      }
      this.end(st.before, st.rect, SUB_TOOLS.find((t) => t.id === st.tool).name.replace(/ Tool$/, ''));
    } else if (s.drag?.object) {
      const d = s.drag;
      s.drag = null;
      const region = d.lasso ? (d.points.length >= 3 ? d.points : null) : dragRect(d.start, d.current, s.doc);
      if (d.moved && region && (Array.isArray(region) || (region.width >= 2 && region.height >= 2))) this.objectSelect(region, d.subtract);
    } else if (s.lasso && !s.lasso.polygon) {
      s.lasso.points.push([p.x, p.y]);
      this.closeLasso();
    }
  }

  onDoubleClick() {
    if (this.session?.lasso?.polygon) this.closeLasso();
  }

  /** One sample of a brush stroke: dabs from the previous sample to (x, y). */
  paint(x, y) {
    const s = this.session, st = s.stroke;
    const size = this.pref(BRUSH_TOOLS[st.tool]), r = Math.max(0.5, size / 2);
    const from = st.last ?? { x, y };
    const dist = Math.hypot(x - from.x, y - from.y);
    const spacing = st.tool === 'quick' ? Math.max(2, r * 0.6) : Math.max(1, r * 0.25);
    const steps = st.last ? Math.floor(dist / spacing) : 1;
    let rect = null;
    for (let i = 1; i <= steps; i++) {
      const t = st.last ? (i * spacing) / dist : 0;
      const px = from.x + (x - from.x) * t, py = from.y + (y - from.y) * t;
      if (st.tool === 'brush') rect = union(rect, stamp(s.base, s.W, s.H, px, py, r, clamp(this.pref('brushHardness'), 0, 1), !st.subtract));
      else if (st.tool === 'refine') rect = union(rect, stamp(s.extra, s.W, s.H, px, py, r, 1, !st.subtract));
      else rect = union(rect, this.quickDab(px, py, r, st));
      st.last = { x: px, y: py };
    }
    if (!rect) return;
    st.rect = union(st.rect, rect);
    if (st.tool === 'refine') {
      // the painted area shows as it is being painted, the matting follows once the stroke ends
      if (!st.subtract) s.extraAny = true;
      this.refreshExtra(rect);
      this.view.invalidate();
    } else this.changed(rect);
  }

  /**
   * Quick Selection at one point: the area of similar colour around the brush (flooded from a few
   * seeds inside it, within a window so one dab never takes the whole image) joins or leaves the selection.
   */
  quickDab(x, y, r, st) {
    const s = this.session, W = s.W, H = s.H, img = s.src.img;
    const cx = Math.floor(x), cy = Math.floor(y);
    if (cx < 0 || cy < 0 || cx >= W || cy >= H) return null;
    const tol = this.app.tools.opt('quick-select', 'tolerance') ?? 32;
    const reach = Math.min(r * 3, r + 160);
    const win = clampRect({ x: Math.floor(x - reach), y: Math.floor(y - reach), width: Math.ceil(reach * 2), height: Math.ceil(reach * 2) }, W, H);
    if (win.width <= 0) return null;
    const sub = cropImage(img, win);
    const seeds = [[x, y], [x - r / 2, y], [x + r / 2, y], [x, y - r / 2], [x, y + r / 2]].map(([sx, sy]) => [Math.round(sx), Math.round(sy)]);
    const apply = (p, v) => {
      if (!v) return;
      st.grown[p] = 255;
      if (st.subtract) {
        if (s.base[p] > 255 - v) s.base[p] = 255 - v;
      } else if (s.base[p] < v) s.base[p] = v;
    };
    // a seed on ground this stroke already took has nothing new to find, unless the brush has travelled:
    // then its window reaches further than the one the area was flooded in
    const travelled = !st.flooded || Math.hypot(x - st.flooded.x, y - st.flooded.y) >= reach * 0.25;
    for (let k = 0; k < seeds.length; k++) {
      const [sx, sy] = seeds[k];
      if (sx < win.x || sy < win.y || sx >= win.x + win.width || sy >= win.y + win.height) continue;
      if (st.grown[sy * W + sx] && !(k === 0 && travelled)) continue;
      if (k === 0) st.flooded = { x, y };
      const m = selectionOps.floodFill(sub, sx - win.x, sy - win.y, { tolerance: tol, contiguous: true, antialias: false });
      for (let yy = 0; yy < win.height; yy++) {
        const row = (win.y + yy) * W + win.x, srow = yy * win.width;
        for (let xx = 0; xx < win.width; xx++) apply(row + xx, m[srow + xx]);
      }
    }
    // the brush disc itself, where it is close in colour to its centre
    const d = img.data, c0 = (cy * W + cx) * 4;
    for (let yy = Math.max(0, Math.floor(y - r)); yy < Math.min(H, y + r); yy++) {
      for (let xx = Math.max(0, Math.floor(x - r)); xx < Math.min(W, x + r); xx++) {
        if ((xx - x) ** 2 + (yy - y) ** 2 > r * r) continue;
        const i = (yy * W + xx) * 4;
        if (Math.max(Math.abs(d[i] - d[c0]), Math.abs(d[i + 1] - d[c0 + 1]), Math.abs(d[i + 2] - d[c0 + 2]), Math.abs(d[i + 3] - d[c0 + 3])) <= tol) apply(yy * W + xx, 255);
      }
    }
    return win;
  }

  /** Lasso and Polygonal Lasso: the outline joins or leaves the selection. */
  closeLasso() {
    const s = this.session, l = s.lasso;
    s.lasso = null;
    this.view.invalidate();
    if (!l || l.points.length < 3) return;
    const before = this.begin();
    const m = selectionOps.rasterizePolygon(l.points, s.W, s.H, { antialias: true });
    const b = selectionOps.maskBounds(m, s.W, s.H);
    if (!b) return;
    for (let y = b.y; y < b.y + b.height; y++) {
      for (let p = y * s.W + b.x, e = p + b.width; p < e; p++) {
        const v = m[p];
        if (!v) continue;
        if (l.subtract) {
          if (s.base[p] > 255 - v) s.base[p] = 255 - v;
        } else if (s.base[p] < v) s.base[p] = v;
      }
    }
    this.end(before, b, l.polygon ? 'Polygonal Lasso' : 'Lasso');
  }

  /** Object Selection inside the workspace: the object in the region joins (or leaves) the selection. */
  async objectSelect(region, subtract = false) {
    const s = this.session;
    if (!s || s.working || s.applying) return;
    s.working = region;
    this.view.invalidate();
    try {
      const res = await this.app.busy('Finding the object…', () => this.engine.run('object', s.key, { region }));
      if (this.session !== s) return;
      const m = res.mask, b = selectionOps.maskBounds(m, s.W, s.H);
      if (!b) {
        this.app.dialogs.toast('No object found in that area', { timeout: 2500 });
        return;
      }
      const before = this.begin();
      for (let y = b.y; y < b.y + b.height; y++) {
        for (let p = y * s.W + b.x, e = p + b.width; p < e; p++) {
          const v = m[p];
          if (!v) continue;
          if (subtract) {
            if (s.base[p] > 255 - v) s.base[p] = 255 - v;
          } else if (s.base[p] < v) s.base[p] = v;
        }
      }
      this.end(before, b, 'Object Selection');
    } catch (err) {
      this.app.reportError(err, 'Object Selection failed');
    } finally {
      s.working = null;
      s.doc.view?.invalidate();
    }
  }

  // ---- keys ---------------------------------------------------------------------------------------------------------

  onKeyDown(e) {
    const s = this.session;
    if (!s) return false;
    if (e.ctrlKey || e.metaKey) return false; // through the guarded command table: Undo / Redo step the workspace's strokes
    const inPanel = e.target?.closest?.('.sm-panel');
    if (e.key === 'Enter') {
      if (inPanel && e.target.tagName === 'BUTTON') e.target.click();
      else this.commit();
      return true;
    }
    if (e.key === 'Escape') return this.cancel();
    if (e.key === 'Tab') {
      // Tab would hide the panels (and this workspace with them): inside the panel it moves the focus instead
      if (inPanel) {
        const list = [...inPanel.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')].filter((x) => x.offsetParent !== null);
        const i = list.indexOf(e.target);
        if (list.length) list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length].focus();
      }
      return true;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      if (s.lasso?.polygon) {
        s.lasso.points.pop();
        if (!s.lasso.points.length) s.lasso = null;
        this.view.invalidate();
      }
      return true;
    }
    if (e.altKey) return true;
    const k = e.key.toLowerCase();
    if (k === '[' || k === ']') {
      const key = BRUSH_TOOLS[s.tool];
      if (key) {
        const v = this.pref(key), stepBy = v < 10 ? 1 : v < 50 ? 5 : v < 100 ? 10 : 25;
        this.app.tools.setOpt(TOOL_ID, key, clamp(v + (k === ']' ? stepBy : -stepBy), 1, 500));
      }
    } else if (k === 'f') {
      const i = VIEW_MODES.findIndex(([id]) => id === this.pref('view'));
      this.setParam('view', VIEW_MODES[(i + (e.shiftKey ? VIEW_MODES.length - 1 : 1)) % VIEW_MODES.length][0]);
    } else if (k === 'x') {
      s.previewOff = !s.previewOff;
      s.preview.set(this.viewSettings());
      this.status();
    } else if (k === 'p') this.setParam('showOriginal', !s.showOriginal);
    else if (k === 'j') this.setParam('showEdge', !s.showEdge);
    else if (VIEW_KEYS[k]) this.setParam('view', VIEW_KEYS[k]);
    else {
      // W and L switch between the two tools that share the letter
      const hits = SUB_TOOLS.filter((t) => t.key.toLowerCase() === k);
      if (hits.length) this.setTool(hits[(hits.findIndex((t) => t.id === s.tool) + 1) % hits.length].id);
    }
    // every other plain key is swallowed: tool shortcuts must not end the workspace
    return true;
  }

  // ---- overlay ------------------------------------------------------------------------------------------------------

  /** Marching Ants needs the outline to move: repaint a few times a second while that view is on. */
  syncAnts() {
    const s = this.session;
    clearInterval(s.antsTimer);
    s.antsTimer = 0;
    if (this.pref('view') === 'ants' && !s.showEdge && !s.previewOff) s.antsTimer = setInterval(() => s.doc.view?.invalidate(), 90);
  }

  drawOverlay(ctx, view) {
    const s = this.session;
    if (!s) return;
    const m = view.matrix();
    if (this.pref('view') === 'ants' && !s.showEdge && !s.previewOff) {
      s.outline ??= Selection.fromMask(s.W, s.H, s.shown).path2d();
      ctx.save();
      ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
      ctx.lineWidth = 1 / view.zoom;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke(s.outline);
      ctx.strokeStyle = '#000000';
      ctx.setLineDash([4 / view.zoom, 4 / view.zoom]);
      ctx.lineDashOffset = -((performance.now() / 60) % 8) / view.zoom;
      ctx.stroke(s.outline);
      ctx.restore();
    }
    // the area of the Refine Edge Brush, while that tool is in hand
    if (s.tool === 'refine' && s.extraCanvas && !s.showEdge) {
      ctx.save();
      ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
      ctx.globalAlpha = 0.28;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(s.extraCanvas, 0, 0);
      ctx.restore();
    }
    const l = s.lasso;
    if (l?.points.length) {
      strokeDashed(ctx, () => {
        l.points.forEach(([x, y], i) => {
          const q = view.toScreen(x, y);
          if (i) ctx.lineTo(q.x, q.y);
          else ctx.moveTo(q.x, q.y);
        });
        if (l.polygon && l.hover) {
          const q = view.toScreen(l.hover[0], l.hover[1]);
          ctx.lineTo(q.x, q.y);
        }
      });
      if (l.polygon) {
        const q = view.toScreen(l.points[0][0], l.points[0][1]);
        ctx.save();
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#000';
        ctx.beginPath();
        ctx.arc(q.x, q.y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }
    const d = s.drag?.object && s.drag.moved ? s.drag : null;
    const region = d ? (d.lasso ? d.points : dragRect(d.start, d.current, s.doc)) : s.working;
    if (region) {
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
    const sizeKey = BRUSH_TOOLS[s.tool];
    if (sizeKey && view.pointer) {
      const q = view.toScreen(view.pointer.x, view.pointer.y), r = Math.max(1, (this.pref(sizeKey) * view.zoom) / 2);
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      ctx.arc(q.x, q.y, r + 1, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,0.9)';
      ctx.beginPath();
      ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  /** Uploads the Refine Edge Brush's area inside rect to the green tint drawn over the view while the brush is in hand. */
  refreshExtra(rect = null) {
    const s = this.session;
    if (!s.extraCanvas) {
      if (!s.extraAny) return;
      s.extraCanvas = createCanvas(s.W, s.H);
      rect = null;
    }
    const r = clampRect(rect ?? { x: 0, y: 0, width: s.W, height: s.H }, s.W, s.H);
    if (r.width <= 0) return;
    const ctx = s.extraCanvas.getContext('2d');
    const img = ctx.createImageData(r.width, r.height), d = img.data;
    for (let y = 0; y < r.height; y++) {
      let p = (r.y + y) * s.W + r.x, i = y * r.width * 4;
      for (let x = 0; x < r.width; x++, p++, i += 4) {
        if (s.extra[p] < 128) continue;
        d[i] = 40;
        d[i + 1] = 220;
        d[i + 2] = 90;
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, r.x, r.y);
  }

  // ---- panel and tool strip ---------------------------------------------------------------------------------------------

  /** The panel's values: view preferences, session toggles and the refinement settings in one object. */
  formValues() {
    const s = this.session, view = this.pref('view');
    return {
      view, onion: this.pref('onion'), opacity: this.pref(`opacity_${view === 'black' || view === 'white' ? view : 'overlay'}`), color: this.pref('color'), indicates: this.pref('indicates'),
      showEdge: s.showEdge, showOriginal: s.showOriginal, ...s.params,
    };
  }

  syncForm() {
    const s = this.session;
    if (!s?.form) return;
    const values = this.formValues();
    for (const [k, v] of Object.entries(values)) if (k in s.form.values && s.form.values[k] !== v) s.form.set(k, v, { silent: true });
  }

  /** One setting of the panel changed (by the form, a key or the test API). */
  setParam(key, value) {
    const s = this.session;
    if (!s || s.applying) return;
    const p = s.params;
    if (key === 'view' || key === 'onion' || key === 'color' || key === 'indicates' || key === 'opacity') {
      if (key === 'view' && !VIEW_MODES.some(([id]) => id === value)) return;
      const view = this.pref('view');
      this.setPref(key === 'opacity' ? `opacity_${view === 'black' || view === 'white' ? view : 'overlay'}` : key, value);
      s.previewOff = false;
      s.preview.set(this.viewSettings());
      this.syncAnts();
    } else if (key === 'showEdge') {
      s.showEdge = !!value;
      if (!s.showEdge) s.preview.setBand(null);
      s.preview.set(this.viewSettings());
      this.syncAnts();
      if (s.showEdge) this.scheduleRefine(0);
    } else if (key === 'showOriginal') {
      s.showOriginal = !!value;
      this.show();
    } else if (key in REFINE_DEFAULTS) {
      const next = normaliseRefine({ ...p, [key]: value });
      // a selection or a mask cannot hold decontaminated colours: picking one of them switches the option off
      if (key === 'output' && !PIXEL_OUTPUTS.has(value) && isOutput(value)) {
        next.decontaminate = false;
        next.output = value;
      }
      const refines = ['mode', 'radius', 'smartRadius', 'smooth', 'feather', 'contrast', 'shift'].some((k) => next[k] !== p[k]);
      Object.assign(p, next);
      if (refines) this.scheduleRefine(60);
    } else return;
    this.syncForm();
    this.status();
    this.view?.invalidate();
  }

  buildUi() {
    const s = this.session;
    // tool strip, where the toolbox normally is
    const strip = document.createElement('aside');
    strip.className = 'sm-tools';
    strip.setAttribute('role', 'toolbar');
    strip.setAttribute('aria-label', `${LABEL} tools`);
    strip.setAttribute('aria-orientation', 'vertical');
    for (const t of SUB_TOOLS) {
      if (t.id === 'hand') strip.appendChild(Object.assign(document.createElement('div'), { className: 'tool-separator' }));
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tool-button';
      b.dataset.tool = t.id;
      b.title = `${t.name} (${t.key})`;
      b.setAttribute('aria-label', t.name);
      b.setAttribute('aria-pressed', String(t.id === s.tool));
      b.classList.toggle('active', t.id === s.tool);
      b.innerHTML = `<span class="tool-icon">${t.icon}</span>`;
      b.addEventListener('click', () => {
        this.setTool(t.id);
        b.blur();
      });
      strip.appendChild(b);
    }
    s.strip = strip;

    // Properties panel, where the panel dock normally is
    const el = document.createElement('aside');
    el.className = 'sm-panel';
    el.setAttribute('aria-label', `${LABEL} properties`);
    el.innerHTML = `
      <header class="sm-head"><span class="sm-title">${LABEL}</span><button type="button" class="btn small" data-action="reset" title="Back to the selection and the settings the workspace opened with">Reset</button></header>
      <div class="sm-body"></div>
      <p class="sm-status muted" aria-live="polite"></p>
      <footer class="sm-foot">
        <span class="sm-spacer"></span>
        <button type="button" class="btn" data-action="cancel">Cancel</button>
        <button type="button" class="btn primary" data-action="ok">OK</button>
      </footer>`;
    const buttons = () => {
      const row = document.createElement('div');
      row.className = 'sm-buttons';
      row.innerHTML = `<button type="button" class="btn small" data-action="clear">Clear Selection</button><button type="button" class="btn small" data-action="invert">Invert</button>`;
      return row;
    };
    const tinted = (v) => v.view === 'overlay' || v.view === 'black' || v.view === 'white';
    const fields = [
      { type: 'section', label: 'View Mode' },
      { key: 'view', label: 'View', type: 'select', options: VIEW_MODES },
      { key: 'onion', label: 'Transparency', type: 'slider', min: 0, max: 100, step: 1, unit: '%', when: (v) => v.view === 'onion' },
      { key: 'opacity', label: 'Opacity', type: 'slider', min: 0, max: 100, step: 1, unit: '%', when: tinted },
      { key: 'color', label: 'Color', type: 'color', when: (v) => v.view === 'overlay' },
      { key: 'indicates', label: 'Indicates', type: 'select', options: [['masked', 'Masked Areas'], ['selected', 'Selected Areas']], when: (v) => v.view === 'overlay' },
      { key: 'showEdge', label: 'Show Edge (J)', type: 'checkbox' },
      { key: 'showOriginal', label: 'Show Original (P)', type: 'checkbox' },
      { type: 'section', label: 'Refine Mode' },
      { key: 'mode', label: '', type: 'segment', options: [['color', 'Color Aware'], ['object', 'Object Aware']], span: true },
      { type: 'section', label: 'Edge Detection' },
      { key: 'radius', label: 'Radius', type: 'slider', min: 0, max: 250, step: 1, unit: 'px' },
      { key: 'smartRadius', label: 'Smart Radius', type: 'checkbox' },
      { type: 'section', label: 'Global Refinements' },
      { key: 'smooth', label: 'Smooth', type: 'slider', min: 0, max: 100, step: 1, unit: '\u00a0' }, // the blank unit keeps the number boxes in one column
      { key: 'feather', label: 'Feather', type: 'slider', min: 0, max: 100, step: 0.1, unit: 'px' },
      { key: 'contrast', label: 'Contrast', type: 'slider', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'shift', label: 'Shift Edge', type: 'slider', min: -100, max: 100, step: 1, unit: '%' },
      { type: 'custom', render: buttons },
      { type: 'section', label: 'Output Settings' },
      { key: 'decontaminate', label: 'Decontaminate Colors', type: 'checkbox' },
      { key: 'amount', label: 'Amount', type: 'slider', min: 0, max: 100, step: 1, unit: '%', when: (v) => !!v.decontaminate },
      { key: 'output', label: 'Output To', type: 'select', options: s.layer ? OUTPUTS : OUTPUTS.slice(0, 1) },
    ];
    s.form = buildForm(fields, { values: this.formValues(), onChange: (values, key) => this.setParam(key, values[key]) });
    el.querySelector('.sm-body').appendChild(s.form.element);
    el.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (!action || this.session !== s) return;
      e.target.closest('button')?.blur();
      if (action === 'ok') this.commit();
      else if (action === 'cancel') this.cancel({ force: true });
      else if (action === 'reset') this.reset();
      else if (action === 'clear') this.clear();
      else if (action === 'invert') this.invert();
    });
    // a dropdown keeps the keyboard while it has the focus: once a choice is made, Enter applies again
    el.addEventListener('change', (e) => {
      if (e.target.tagName === 'SELECT') e.target.blur();
    });
    // Enter or Escape in a number field confirms the field and hands the keys back to the canvas
    el.addEventListener('keydown', (e) => {
      if (e.target.tagName !== 'INPUT' || e.target.type !== 'number' || (e.key !== 'Enter' && e.key !== 'Escape')) return;
      e.preventDefault();
      e.stopPropagation();
      e.target.blur();
      s.doc.view?.canvas.focus({ preventScroll: true });
    });
    s.panel = el;
    const main = document.getElementById('main');
    main.insertBefore(strip, document.getElementById('canvas-host'));
    main.appendChild(el);
  }

  /** The two ways out sit in the options bar too, like Free Transform's. */
  renderOptions(bar) {
    if (!this.session) return;
    const spacer = document.createElement('span');
    spacer.className = 'sm-bar-spacer';
    bar.appendChild(spacer);
    const mk = (label, iconName, action, primary) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn small${primary ? ' primary' : ''}`;
      b.dataset.action = action;
      b.innerHTML = `${icon(iconName)}<span>${label}</span>`;
      b.addEventListener('click', () => (action === 'ok' ? this.commit() : this.cancel({ force: true })));
      bar.appendChild(b);
    };
    mk('Cancel', 'close', 'cancel', false);
    mk('OK', 'check', 'ok', true);
  }

  /** The line above OK: what the workspace is doing and how long the last refinement took. */
  status() {
    const s = this.session;
    const el = s?.panel?.querySelector('.sm-status');
    if (!el) return;
    const r = s.refine;
    let text;
    if (s.applying) text = 'Applying…';
    else if (r.stale || r.running) text = 'Refining the edge…';
    else if (s.previewOff) text = 'Preview off (X)';
    else if (s.refined) text = `Edge refined in ${Math.max(1, Math.round(r.ms))} ms${this.engine.mode === 'worker' ? '' : ' (no worker)'}`;
    else text = holds(s.base) ? 'Selection shown as it is: Edge Detection and Global Refinements are off' : 'Nothing is selected yet: paint with the Quick Selection tool or press Select Subject';
    el.textContent = text;
    for (const b of s.panel.querySelectorAll('.sm-foot button, [data-action="reset"]')) b.disabled = s.applying;
  }
}

/**
 * Installs the workspace: the session tool, the guard that keeps other commands away while it is
 * open, and app.selectMask.
 */
export function installWorkspace(app, engine) {
  const tool = new SelectMaskTool(app, engine);

  // The workspace owns the document like a modal dialog would. Undo and Redo step through its own
  // strokes; Select All / Deselect / Inverse act on its selection; everything else waits.
  const run = app.commands.run.bind(app.commands);
  let warned = 0;
  app.commands.run = (id, arg, source) => {
    if (tool.session && !tool.ending && !SAFE_COMMANDS.test(id)) {
      if (id === 'edit:undo' || id === 'edit:step-backward') tool.undo();
      else if (id === 'edit:redo' || id === 'edit:step-forward') tool.redo();
      else if (id === 'select:all') tool.selectAll();
      else if (id === 'select:none') tool.clear();
      else if (id === 'select:inverse') tool.invert();
      else if (source !== 'api' && performance.now() - warned > 2500) {
        warned = performance.now();
        app.dialogs.toast(`Finish ${LABEL} first: Enter applies it, Esc cancels`, { timeout: 2200 });
      }
      return undefined;
    }
    return run(id, arg, source);
  };

  // closing the window asks about unsaved documents: the workspace must be gone before anything is saved
  bridge.on?.('before-close', () => tool.cancel({ force: true }));
  return tool;
}
