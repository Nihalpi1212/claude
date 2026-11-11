// Edit > Content-Aware Scale (builder "content-aware-lens"): resizes the pixels of the active raster layer by
// seam carving (src/shared/pixels/seam-carve.js) instead of stretching them, so flat areas give way and
// detail keeps its shape.
//
// It is an on-canvas session in the manner of Free Transform (lib/image-ops.js TransformTool): a box with
// corner and edge handles around the layer's pixels (or around the selection: then only the selected pixels
// are scaled, cut out as a floating piece, and everything outside the selection stays where it is, like
// Photoshop), an options bar (Amount, Protect, Protect skin tones, W, H), Enter applies, Escape cancels.
//
// What makes the drag interactive is the seam map: the order in which seams go is computed once per axis and
// any size is then a lookup (createContentAwareScaler). Large layers preview on a reduced copy whose maps are
// built in slices of a frame's budget while the pointer moves; applying runs the full-size layer under
// app.busy and records one history entry through history.replaceCanvas.
import { Tool } from './tools.js';
import { createCanvas, copyCanvas, intersectRect, unionRect } from './document.js';
import { Selection } from './selection.js';
import { contentRect, dataCanvas, canvasData } from './image-ops.js';
import { icon } from './icons.js';
import { bridge } from './bridge.js';
import { createContentAwareScaler } from '../../shared/pixels/seam-carve.js';

const TOOL_ID = 'content-aware-scale';
const LABEL = 'Content-Aware Scale';
/** Pixels of the copy the preview carves; pieces clearly larger than this preview on a reduced copy. */
const PREVIEW_PIXELS = 360000;
/** Pieces up to this size are applied without the busy state (their maps take a few dozen milliseconds). */
const SYNC_PIXELS = 400000;
/** A seam map needs about 25 bytes per pixel and two are held: beyond this the layer is refused. */
const MAX_PIXELS = 24e6;
/** The box cannot grow beyond this side length or this many pixels (a typo in W must not allocate gigabytes). */
const MAX_SIDE = 16384, MAX_RESULT_PIXELS = 64e6;
/** Map building per frame while previewing (ms). */
const FRAME_BUDGET = 14;
const HANDLE_IDS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const LOCAL = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };
const CURSOR = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', move: 'move' };

/** Commands that may run while the box is up (looking around; Enter and Escape reach the tool). */
const SAFE_COMMANDS = /^(view:(?!next-tab|prev-tab)|window:|help:|app:escape$|app:enter$)/;

/** Width and height limited to what a layer canvas can sensibly hold (the width gives way last). */
function limitSize(w, h) {
  let width = Math.max(1, Math.min(MAX_SIDE, Math.round(w))), height = Math.max(1, Math.min(MAX_SIDE, Math.round(h)));
  if (width * height > MAX_RESULT_PIXELS) height = Math.max(1, Math.floor(MAX_RESULT_PIXELS / width));
  return { width, height };
}

/** The alpha channel of a canvas (a layer mask keeps its values there). */
function canvasAlpha(canvas) {
  const d = canvasData(canvas).data;
  const out = new Uint8ClampedArray(canvas.width * canvas.height);
  for (let i = 0, j = 3; i < out.length; i++, j += 4) out[i] = d[j];
  return out;
}

const sameRect = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** The part of a document-sized mask under rect, as a rect-sized mask (outside the document: 0). */
function cropMask(mask, docW, docH, rect) {
  const out = new Uint8ClampedArray(rect.width * rect.height);
  for (let y = 0; y < rect.height; y++) {
    const sy = rect.y + y;
    if (sy < 0 || sy >= docH) continue;
    for (let x = 0; x < rect.width; x++) {
      const sx = rect.x + x;
      if (sx >= 0 && sx < docW) out[y * rect.width + x] = mask[sy * docW + sx];
    }
  }
  return out;
}

/** A w x h mask sampled down to nw x nh (the strongest value of each block, so thin protection survives). */
function reduceMask(mask, w, h, nw, nh) {
  const out = new Uint8ClampedArray(nw * nh);
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor((y * h) / nh), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / nh));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor((x * w) / nw), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / nw));
      let m = 0;
      for (let yy = y0; yy < y1 && yy < h; yy++) for (let xx = x0; xx < x1 && xx < w; xx++) if (mask[yy * w + xx] > m) m = mask[yy * w + xx];
      out[y * nw + x] = m;
    }
  }
  return out;
}

class ContentAwareScaleTool extends Tool {
  constructor(app) {
    super(app, {
      id: TOOL_ID,
      name: LABEL,
      icon: 'transform',
      cursor: 'default',
      hint: 'Drag a handle to scale: flat areas give way first (Shift keeps proportions, Alt scales from the centre). Enter applies, Esc cancels.',
      options: [],
    });
    this.session = null;
  }

  canStart() {
    const d = this.app.doc;
    return !!d && !this.session && d.active?.type === 'raster';
  }

  /** Starts a session on the active raster layer. Returns true when it started. */
  start() {
    const app = this.app, d = app.doc;
    if (!d || this.session) return false;
    app.tools.active?.commit?.();
    const layer = d.active;
    const fail = (message) => {
      app.dialogs.toast(message, { kind: 'error' });
      return false;
    };
    if (!layer) return fail('Select a layer to scale');
    // text, shapes and smart objects have no pixels of their own to carve
    if (layer.type !== 'raster') return fail(layer.isGroup ? 'Select a layer inside the group to scale' : 'Content-Aware Scale needs a pixel layer: rasterize this layer first');
    if (layer.locked.all || layer.locked.pixels || layer.locked.position) return fail(`"${layer.name}" is locked`);
    const sel = d.selection && !d.selection.isEmpty ? d.selection : null;
    const box = sel ? intersectRect(sel.bounds, layer.bounds()) : contentRect(layer);
    if (!box || box.width < 1 || box.height < 1) return fail(sel ? 'The selected area is empty on this layer' : 'The layer is empty');
    if (box.width * box.height > MAX_PIXELS) return fail(`Content-Aware Scale works on up to ${Math.round(MAX_PIXELS / 1e6)} megapixels: select a smaller area`);
    // the pixels to scale: the layer's content, or the selected part of it cut out as a floating piece
    const pieceCanvas = createCanvas(box.width, box.height);
    const pctx = pieceCanvas.getContext('2d', { willReadFrequently: true });
    pctx.drawImage(layer.canvas, layer.x - box.x, layer.y - box.y);
    let erased = null, selAlpha = null;
    if (sel) {
      const selCanvas = sel.toCanvas();
      pctx.globalCompositeOperation = 'destination-in';
      pctx.drawImage(selCanvas, -box.x, -box.y);
      pctx.globalCompositeOperation = 'source-over';
      erased = copyCanvas(layer.canvas);
      const ectx = erased.getContext('2d');
      ectx.globalCompositeOperation = 'destination-out';
      ectx.drawImage(selCanvas, -layer.x, -layer.y);
      ectx.globalCompositeOperation = 'source-over';
      selAlpha = cropMask(sel.mask, d.width, d.height, box);
    }
    const piece = canvasData(pieceCanvas);
    let any = false;
    for (let i = 3; i < piece.data.length; i += 4) if (piece.data[i]) {
      any = true;
      break;
    }
    if (!any) return fail('The selected area is empty on this layer');
    const s = {
      doc: d, layer, box, rect: { ...box }, piece, pieceCanvas, erased, selection: sel, selAlpha,
      orig: { canvas: layer.canvas, x: layer.x, y: layer.y },
      amount: 100, protectId: '', skin: false,
      full: null, pv: null, pvScale: 1, pvCanvas: null, pvKey: '', shown: false, applying: false, raf: 0, resolve: null, ended: null,
    };
    // made before anything can end the session, so every way out resolves it: with what was applied, or null
    s.ended = new Promise((resolve) => {
      s.resolve = resolve;
    });
    // layers clearly larger than the preview size are carved on a reduced copy while the session runs
    if (box.width * box.height > PREVIEW_PIXELS * 1.3) {
      const f = Math.sqrt(PREVIEW_PIXELS / (box.width * box.height));
      const small = createCanvas(Math.max(1, Math.round(box.width * f)), Math.max(1, Math.round(box.height * f)));
      const sctx = small.getContext('2d', { willReadFrequently: true });
      sctx.imageSmoothingQuality = 'high';
      sctx.drawImage(pieceCanvas, 0, 0, small.width, small.height);
      s.small = sctx.getImageData(0, 0, small.width, small.height);
    }
    this.session = s;
    this.buildScalers();
    this.returnTo = app.tools.active && app.tools.active !== this ? app.tools.active.id : 'move';
    s.hideAnts = d.view.hideAnts;
    d.view.hideAnts = true; // the outline marks where the pixels were, not where they are going
    // the toolbox is inert until the box is applied or cancelled (commands are refused meanwhile, see install)
    const toolbox = document.getElementById('toolbox');
    if (toolbox) {
      s.toolbox = { el: toolbox, pointerEvents: toolbox.style.pointerEvents, opacity: toolbox.style.opacity };
      toolbox.style.pointerEvents = 'none';
      toolbox.style.opacity = '0.45';
    }
    app.tools.tools.set(TOOL_ID, this); // registered only while a session runs: it is not a toolbox tool
    app.tools.activate(TOOL_ID);
    s.offChange = d.onChange((e) => {
      // undo, redo or a change of the layer tree behind the session's back: nothing may stay half applied
      if ((e.kind === 'history' || e.kind === 'tree') && !this.committing && this.session === s && !s.applying) this.cancel();
    });
    s.offDoc = app.on('doc:activated', (other) => {
      if (this.session === s && other !== s.doc) this.cancel();
    });
    this.syncBar();
    app.view?.invalidate();
    return true;
  }

  /** (Re)creates the scalers for the session's protection settings: maps are built lazily, so this is cheap. */
  buildScalers() {
    const s = this.session;
    const channel = s.protectId ? s.doc.channels.find((c) => c.id === s.protectId) : null;
    const protect = channel ? cropMask(channel.mask, s.doc.width, s.doc.height, s.box) : null;
    s.full = createContentAwareScaler(s.piece, { protect, skin: s.skin });
    if (s.small) {
      s.pvScale = s.small.width / s.box.width;
      s.pv = createContentAwareScaler(s.small, { protect: protect ? reduceMask(protect, s.box.width, s.box.height, s.small.width, s.small.height) : null, skin: s.skin });
    } else {
      s.pvScale = 1;
      s.pv = s.full;
    }
    s.pvKey = '';
  }

  activate() {
    this.app.view?.setCursor('default');
  }

  deactivate() {
    // another tool was chosen while the box is up: the scale is applied, as Free Transform does
    if (this.session && !this.ending && !this.session.applying) this.commit({ switchBack: false });
  }

  get changed() {
    const s = this.session;
    return !!s && !sameRect(s.rect, s.box);
  }

  // -- preview -------------------------------------------------------------------------------------------------

  scheduleUpdate() {
    const s = this.session;
    if (!s || s.raf) return;
    s.raf = requestAnimationFrame(() => {
      s.raf = 0;
      if (this.session === s && !s.applying) this.update();
    });
  }

  /** Shows the layer with the piece carved to the box (on the preview copy; a slice of map building per frame). */
  update() {
    const s = this.session;
    if (!s) return;
    this.syncBar();
    this.app.view?.invalidate();
    if (!this.changed) {
      if (s.shown) this.restore();
      return;
    }
    // Only the seam part of the change is computed here (Amount of the way to the box, at most twice the
    // size); the plain scaling that makes up the rest is the stretch show() draws with anyway.
    const k = s.amount / 100, bw = s.pv.width, bh = s.pv.height;
    const pw = Math.max(1, Math.min(bw * 2, Math.round(bw + (s.rect.width * s.pvScale - bw) * k)));
    const ph = Math.max(1, Math.min(bh * 2, Math.round(bh + (s.rect.height * s.pvScale - bh) * k)));
    const key = `${pw}x${ph}`;
    if (key !== s.pvKey) {
      if (s.pv.prepare(pw, ph, 100, FRAME_BUDGET)) {
        s.pvCanvas = dataCanvas(s.pv.scale(pw, ph, 100));
        s.pvKey = key;
      } else this.scheduleUpdate(); // the maps are not there yet: meanwhile the last result is stretched
    }
    this.show(s.pvCanvas ?? s.pieceCanvas, s.rect);
  }

  /** The layer's pixels with `src` drawn into rect: { canvas, x, y } (what the preview shows and what is committed). */
  compose(src, rect) {
    const s = this.session;
    const b = s.erased ? unionRect({ x: s.orig.x, y: s.orig.y, width: s.erased.width, height: s.erased.height }, rect) : { ...rect };
    const c = createCanvas(b.width, b.height);
    const ctx = c.getContext('2d');
    if (s.erased) ctx.drawImage(s.erased, s.orig.x - b.x, s.orig.y - b.y);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, rect.x - b.x, rect.y - b.y, rect.width, rect.height);
    return { canvas: c, x: b.x, y: b.y };
  }

  show(src, rect) {
    const s = this.session;
    const r = this.compose(src, rect);
    s.layer.canvas = r.canvas;
    s.layer.x = r.x;
    s.layer.y = r.y;
    s.layer.touch();
    s.shown = true;
    s.doc.changed('pixels', { layer: s.layer });
  }

  /** Puts the layer's own canvas back (the preview replaced it). */
  restore() {
    const s = this.session;
    if (!s || !s.shown) return;
    s.layer.canvas = s.orig.canvas;
    s.layer.x = s.orig.x;
    s.layer.y = s.orig.y;
    s.layer.touch();
    s.shown = false;
    s.doc.changed('pixels', { layer: s.layer });
  }

  // -- ending --------------------------------------------------------------------------------------------------

  /** Escape. */
  cancel() {
    if (!this.session) return false;
    if (this.session.applying) return true; // the apply is on its way: it ends the session
    this.finish();
    return true;
  }

  /** Enter and the Apply button. */
  commit({ switchBack = true } = {}) {
    const s = this.session;
    if (!s) return false;
    if (s.applying) return true;
    s.applying = true;
    s.done = this.apply(switchBack).catch((err) => {
      this.app.reportError(err, `${LABEL} failed`);
      if (this.session === s) this.finish({ switchBack });
    });
    return true;
  }

  async apply(switchBack) {
    const s = this.session, app = this.app, d = s.doc;
    cancelAnimationFrame(s.raf);
    s.raf = 0;
    if (!this.changed) return this.finish({ switchBack });
    const { width: tw, height: th } = s.rect;
    // a linked layer mask goes with the whole layer's pixels through the same seams (Free Transform takes it along too);
    // with a selection only the selected pixels move, and the mask stays as it is
    const maskCanvas = !s.selection && s.layer.mask?.canvas && s.layer.mask.linked !== false ? s.layer.mask.canvas : null;
    const work = () => ({
      image: s.full.scale(tw, th, s.amount),
      mask: s.selAlpha ? s.full.scaleMask(s.selAlpha, tw, th, s.amount) : null,
      layerMask: maskCanvas ? s.full.scaleMask(cropMask(canvasAlpha(maskCanvas), maskCanvas.width, maskCanvas.height, s.box), tw, th, s.amount) : null,
    });
    const result = Math.max(s.box.width * s.box.height, tw * th) > SYNC_PIXELS ? await app.busy(`${LABEL}…`, async () => work()) : work();
    if (this.session !== s) return;
    const out = this.compose(dataCanvas(result.image), s.rect);
    this.restore();
    this.committing = true;
    try {
      d.history.group(LABEL, () => {
        d.history.replaceCanvas(LABEL, s.layer, () => out);
        if (maskCanvas && result.layerMask) {
          // the mask outside the old box stays; the old box takes the mask's background value, the carved piece lands in the new box
          const c = createCanvas(maskCanvas.width, maskCanvas.height);
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(maskCanvas, 0, 0);
          ctx.clearRect(s.box.x, s.box.y, s.box.width, s.box.height);
          const bg = maskCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, 1, 1).data[3];
          if (bg > 0) {
            ctx.fillStyle = `rgba(255,255,255,${bg / 255})`;
            ctx.fillRect(s.box.x, s.box.y, s.box.width, s.box.height);
          }
          const img = new ImageData(tw, th);
          for (let i = 0, p = 0; i < result.layerMask.length; i++, p += 4) {
            img.data[p] = img.data[p + 1] = img.data[p + 2] = 255;
            img.data[p + 3] = result.layerMask[i];
          }
          ctx.putImageData(img, s.rect.x, s.rect.y);
          const layer = s.layer, before = layer.mask, after = { ...before, canvas: c };
          const set = (v) => {
            layer.mask = v;
            layer.touch();
            d.changed('pixels', { layer });
          };
          set(after);
          d.history.push({ label: 'Transform mask', undo: () => set(before), redo: () => set(after), bytes: c.width * c.height * 4, at: Date.now() });
        }
        if (s.selection && result.mask) {
          // the selection follows its pixels through the same seams
          const mask = new Uint8ClampedArray(d.width * d.height);
          for (let y = 0; y < th; y++) {
            const dy = s.rect.y + y;
            if (dy < 0 || dy >= d.height) continue;
            for (let x = 0; x < tw; x++) {
              const dx = s.rect.x + x;
              if (dx >= 0 && dx < d.width) mask[dy * d.width + dx] = result.mask[y * tw + x];
            }
          }
          const before = d.selection, next = Selection.fromMask(d.width, d.height, mask);
          const after = next.isEmpty ? null : next;
          const set = (v) => {
            d.selection = v;
            d.changed('selection');
          };
          set(after);
          d.history.push({ label: 'Transform selection', undo: () => set(before), redo: () => set(after), bytes: 0, at: Date.now() });
        }
      });
    } finally {
      this.committing = false;
    }
    s.committed = true;
    // what re-runs this scale without the box (actions): sizes in percent, so it fits other layers too
    const channel = s.protectId ? d.channels.find((c) => c.id === s.protectId) : null;
    s.result = {
      width: (tw / s.box.width) * 100, height: (th / s.box.height) * 100, unit: 'percent',
      dx: s.rect.x - s.box.x, dy: s.rect.y - s.box.y, amount: s.amount, protect: channel ? channel.name : '', skin: s.skin,
    };
    this.finish({ switchBack });
  }

  /** Ends the session; unless it committed, the layer is as it was. */
  finish({ switchBack = true } = {}) {
    const s = this.session;
    if (!s) return;
    const app = this.app;
    cancelAnimationFrame(s.raf);
    if (!s.committed) this.restore();
    this.session = null;
    this.drag = null;
    s.offChange?.();
    s.offDoc?.();
    if (s.toolbox) {
      s.toolbox.el.style.pointerEvents = s.toolbox.pointerEvents;
      s.toolbox.el.style.opacity = s.toolbox.opacity;
    }
    if (s.doc.view) s.doc.view.hideAnts = s.hideAnts;
    this.ending = true;
    try {
      if (switchBack && app.tools.active === this) app.tools.activate(app.tools.get(this.returnTo) ? this.returnTo : 'move');
    } finally {
      this.ending = false;
      app.tools.tools.delete(TOOL_ID);
    }
    app.statusbar?.set('hint', app.tools.active?.hint ?? '');
    app.commands.invalidate();
    app.syncUiState?.();
    app.view?.invalidate();
    s.resolve?.(s.committed ? s.result : null);
  }

  // -- interaction ---------------------------------------------------------------------------------------------

  handlePoints() {
    const r = this.session.rect;
    const out = {};
    for (const id of HANDLE_IDS) {
      const p = this.view.toScreen(r.x + LOCAL[id][0] * r.width, r.y + LOCAL[id][1] * r.height);
      out[id] = [p.x, p.y];
    }
    return out;
  }

  hit(p) {
    const s = this.session;
    if (!s) return null;
    const hp = this.handlePoints();
    for (const id of HANDLE_IDS) if (Math.hypot(hp[id][0] - p.screenX, hp[id][1] - p.screenY) < 8) return id;
    const r = s.rect;
    if (p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height) return 'move';
    return null;
  }

  onPointerDown(p) {
    const s = this.session;
    if (!s || s.applying) return;
    const h = this.hit(p);
    this.drag = h ? { handle: h, start: p, rect: { ...s.rect } } : null;
  }

  onPointerMove(p, dragging) {
    const s = this.session;
    if (!s || s.applying) return;
    if (!dragging || !this.drag) {
      this.view.setCursor(CURSOR[this.hit(p)] ?? 'default');
      return;
    }
    const dr = this.drag, r0 = dr.rect;
    const dx = p.x - dr.start.x, dy = p.y - dr.start.y;
    if (dr.handle === 'move') {
      let mx = dx, my = dy;
      if (p.shift) Math.abs(dx) > Math.abs(dy) ? (my = 0) : (mx = 0);
      s.rect = { ...r0, x: Math.round(r0.x + mx), y: Math.round(r0.y + my) };
    } else {
      const [hx, hy] = LOCAL[dr.handle];
      // scale factors of the dragged edges about the opposite edge (Alt: about the centre)
      const span = p.alt ? 0.5 : 1;
      let sx = hx === 0.5 ? 1 : (r0.width * span + (hx === 1 ? dx : -dx)) / (r0.width * span);
      let sy = hy === 0.5 ? 1 : (r0.height * span + (hy === 1 ? dy : -dy)) / (r0.height * span);
      if (p.shift) {
        // proportional: an edge handle takes the other axis along, a corner follows the larger change
        if (hx === 0.5) sx = sy;
        else if (hy === 0.5) sy = sx;
        else sx = sy = Math.abs(sx - 1) > Math.abs(sy - 1) ? sx : sy;
      }
      const { width: w, height: h } = limitSize(r0.width * Math.max(0, sx), r0.height * Math.max(0, sy));
      // the anchor stays put: the opposite edge, or the centre (Alt, and the free axis of a proportional edge drag)
      const ax = p.alt || hx === 0.5 ? 0.5 : 1 - hx, ay = p.alt || hy === 0.5 ? 0.5 : 1 - hy;
      s.rect = { x: Math.round(r0.x + ax * (r0.width - w)), y: Math.round(r0.y + ay * (r0.height - h)), width: w, height: h };
    }
    this.scheduleUpdate();
  }

  onPointerUp() {
    this.drag = null;
  }

  onDoubleClick(p) {
    if (this.hit(p) === 'move') this.commit();
  }

  onKeyDown(e) {
    const s = this.session;
    if (!s) return false;
    const step = e.shiftKey ? 10 : 1;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      if (!s.applying) {
        s.rect = { ...s.rect, x: s.rect.x + moves[e.key][0], y: s.rect.y + moves[e.key][1] };
        this.update();
      }
      return true;
    }
    if (e.key === 'Enter') {
      this.commit();
      return true;
    }
    if (e.key === 'Escape' || (e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey))) {
      // undo while the box is up cancels the scale, like Free Transform
      this.cancel();
      return true;
    }
    // Delete must not reach the layer while it is being scaled
    if (e.key === 'Delete' || e.key === 'Backspace') return true;
    return false;
  }

  drawOverlay(ctx, view) {
    const s = this.session;
    if (!s) return;
    const r = s.rect;
    const a = view.toScreen(r.x, r.y), b = view.toScreen(r.x + r.width, r.y + r.height);
    ctx.save();
    ctx.strokeStyle = '#2f80ff';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(b.x - a.x), Math.round(b.y - a.y));
    const hp = this.handlePoints();
    ctx.fillStyle = '#ffffff';
    for (const id of HANDLE_IDS) {
      const [x, y] = hp[id];
      ctx.fillRect(Math.round(x) - 4, Math.round(y) - 4, 8, 8);
      ctx.strokeRect(Math.round(x) - 3.5, Math.round(y) - 3.5, 7, 7);
    }
    ctx.restore();
  }

  // -- options bar ---------------------------------------------------------------------------------------------

  /** Sets the box size (px) keeping its top-left corner, as the W and H fields do. */
  setSize(width, height) {
    const s = this.session;
    if (!s || s.applying) return;
    s.rect = { ...s.rect, ...limitSize(Number.isFinite(width) ? width : s.rect.width, Number.isFinite(height) ? height : s.rect.height) };
    this.update();
  }

  /** Moves the box by whole pixels. */
  moveBy(dx, dy) {
    const s = this.session;
    if (!s || s.applying) return;
    s.rect = { ...s.rect, x: s.rect.x + Math.round(dx), y: s.rect.y + Math.round(dy) };
    this.update();
  }

  setOption(key, value) {
    const s = this.session;
    if (!s || s.applying) return;
    if (key === 'amount') s.amount = Math.max(0, Math.min(100, Number(value) || 0));
    else if (key === 'protect') {
      // a channel id (the options bar) or a channel name (a recorded action)
      s.protectId = (s.doc.channels.find((c) => c.id === value) ?? s.doc.channels.find((c) => value && c.name === value))?.id ?? '';
      if (this.fields?.protect) this.fields.protect.value = s.protectId;
      this.buildScalers();
    } else if (key === 'skin') {
      s.skin = !!value;
      if (this.fields?.skin) this.fields.skin.checked = s.skin;
      this.buildScalers();
    }
    this.update();
  }

  renderOptions(bar) {
    const s = this.session;
    if (!s) return;
    this.fields = {};
    const number = (key, label, unit, { min, max } = {}, onCommit) => {
      const wrap = document.createElement('label');
      wrap.className = 'opt opt-number';
      const l = document.createElement('span');
      l.className = 'opt-label';
      l.textContent = label;
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'input';
      input.step = '1';
      if (min !== undefined) input.min = String(min);
      if (max !== undefined) input.max = String(max);
      input.dataset.key = key;
      input.addEventListener('change', () => {
        const v = Number(input.value);
        if (Number.isFinite(v)) onCommit(v);
        this.syncBar();
      });
      // Enter in a field commits the field, not the whole scale
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.stopPropagation();
          input.blur();
        }
      });
      wrap.append(l, input);
      if (unit) {
        const u = document.createElement('span');
        u.className = 'opt-unit';
        u.textContent = unit;
        wrap.appendChild(u);
      }
      bar.appendChild(wrap);
      this.fields[key] = input;
    };
    number('amount', 'Amount', '%', { min: 0, max: 100 }, (v) => this.setOption('amount', v));

    const protect = document.createElement('label');
    protect.className = 'opt opt-select';
    protect.title = 'An alpha channel whose white areas are kept from being carved';
    const pl = document.createElement('span');
    pl.className = 'opt-label';
    pl.textContent = 'Protect';
    const select = document.createElement('select');
    select.className = 'select';
    select.dataset.key = 'protect';
    select.add(new Option('None', ''));
    for (const c of s.doc.channels) select.add(new Option(c.name, c.id));
    select.value = s.protectId;
    select.addEventListener('change', () => this.setOption('protect', select.value));
    protect.append(pl, select);
    bar.appendChild(protect);
    this.fields.protect = select;

    const skin = document.createElement('label');
    skin.className = 'opt opt-checkbox';
    skin.title = 'Keeps areas with skin tones from being carved';
    const skinInput = document.createElement('input');
    skinInput.type = 'checkbox';
    skinInput.dataset.key = 'skin';
    skinInput.checked = s.skin;
    skinInput.addEventListener('change', () => this.setOption('skin', skinInput.checked));
    skin.append(skinInput, document.createTextNode(' Protect skin tones'));
    bar.appendChild(skin);
    this.fields.skin = skinInput;

    number('w', 'W', 'px', { min: 1 }, (v) => this.setSize(v, NaN));
    number('h', 'H', 'px', { min: 1 }, (v) => this.setSize(NaN, v));

    const button = (label, iconName, action, fn, primary) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn small${primary ? ' primary' : ''}`;
      b.dataset.action = action;
      b.innerHTML = `${icon(iconName)}<span>${label}</span>`;
      b.addEventListener('click', fn);
      bar.appendChild(b);
    };
    button('Cancel', 'close', 'cancel', () => this.cancel());
    button('Apply', 'check', 'apply', () => this.commit(), true);
    this.syncBar();
  }

  syncBar() {
    const s = this.session;
    if (!s) return;
    const set = (k, v) => {
      const f = this.fields?.[k];
      if (f && document.activeElement !== f) f.value = String(v);
    };
    set('amount', s.amount);
    set('w', s.rect.width);
    set('h', s.rect.height);
    this.app.statusbar?.set('hint', `W ${s.rect.width} px (${Math.round((s.rect.width / s.box.width) * 100)}%)  H ${s.rect.height} px (${Math.round((s.rect.height / s.box.height) * 100)}%)`);
  }
}

export function install(app) {
  const tool = new ContentAwareScaleTool(app);
  /** Hooks for other modules and tests: the session tool (tool.session while the box is up, tool.setSize, tool.setOption). */
  app.contentAwareScale = tool;

  // While the box is up the layer shows a preview, so the session owns the document like a modal dialog
  // would: commands that could change it (or the tool, the layer, the tab) are refused with a hint, undo and
  // redo cancel the scale as they do for Free Transform. (lib/blur-gallery-ui.js guards its sessions the same way.)
  const run = app.commands.run.bind(app.commands);
  let warned = 0;
  app.commands.run = (id, arg, source) => {
    if (tool.session && !tool.ending && !tool.committing && !SAFE_COMMANDS.test(id)) {
      if (/^edit:(undo|redo|step-backward|step-forward)$/.test(id)) tool.cancel();
      else if (source !== 'api' && performance.now() - warned > 2500) {
        warned = performance.now();
        app.dialogs.toast(`Finish ${LABEL} first: Enter applies it, Esc cancels`, { timeout: 2200 });
      }
      return undefined;
    }
    return run(id, arg, source);
  };
  // closing the window asks about unsaved documents: the preview must be off the layer before anything is saved
  bridge.on?.('before-close', () => tool.cancel());

  app.commands.registerAll({
    'edit:content-aware-scale': {
      enabled: () => !!app.doc?.active && !tool.session,
      label: LABEL,
      dialog: true,
      /**
       * Without an argument the box comes up and the command resolves when it is applied or cancelled. With
       * { width, height, unit: 'px' | 'percent', dx, dy, amount, protect, skin } (actions, scripts) the scale
       * applies at once. Resolves with the applied values (in percent) or null.
       */
      run: (arg, ctx) => {
        if (!tool.start()) {
          ctx?.cancel();
          return null;
        }
        const s = tool.session;
        if (arg && typeof arg === 'object' && (Number.isFinite(arg.width) || Number.isFinite(arg.height))) {
          if (arg.amount !== undefined) tool.setOption('amount', arg.amount);
          if (arg.protect !== undefined) tool.setOption('protect', arg.protect);
          if (arg.skin !== undefined) tool.setOption('skin', arg.skin);
          const size = (v, full) => (Number.isFinite(v) ? (arg.unit === 'percent' ? (full * v) / 100 : v) : NaN);
          tool.setSize(size(arg.width, s.box.width), size(arg.height, s.box.height));
          if (Number.isFinite(arg.dx) || Number.isFinite(arg.dy)) tool.moveBy(arg.dx || 0, arg.dy || 0);
          tool.commit();
        }
        return s.ended.then((used) => {
          if (used) ctx?.setReplayArg(used);
          else ctx?.cancel();
          return used;
        });
      },
    },
  });
}
