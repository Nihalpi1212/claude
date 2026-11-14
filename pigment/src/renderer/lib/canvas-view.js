// The viewport (see ARCHITECTURE.md "Canvas view"): draws the composite with zoom/pan/rotation,
// checkerboard, selection ants, guides, grid, pixel grid, rulers and the active tool's overlay, and
// routes pointer events to the tool. One instance per open document; app.view is the active one.
import { Compositor } from './compositor.js';
import { intersectRect } from './document.js';
import { paintMaskView } from './mask-view.js';
import { guideSettings, guideColor, selectedGuides } from './guides.js';
import { UNITS, UNIT_NAMES } from './rulers.js';

const ZOOM_STEPS = [0.01, 0.02, 0.03, 0.05, 0.0667, 0.08, 0.1, 0.125, 0.167, 0.2, 0.25, 0.333, 0.5, 0.667, 1, 1.5, 2, 3, 4, 5, 6, 8, 12, 16, 24, 32, 48, 64];
export const MIN_ZOOM = 0.01, MAX_ZOOM = 64;
const RULER_SIZE = 20;

export class CanvasView {
  /**
   * @param {import('../app.js').App} app
   * @param {import('./document.js').Document} doc
   * @param {HTMLElement} host
   */
  constructor(app, doc, host) {
    this.app = app;
    this.doc = doc;
    this.host = host;
    this.compositor = new Compositor();
    this.zoom = 1;
    this.panX = 0; // screen position (CSS px, in the canvas area) of document (0,0)
    this.panY = 0;
    this.rotation = 0; // degrees, view only
    this.dpr = window.devicePixelRatio || 1;
    this.antsOffset = 0;
    this.dirty = true;
    this.raf = 0;
    this.pointer = null; // last pointer position in doc coords
    this.maskView = false; // show the active layer mask as a grayscale channel
    this.quickMask = null;
    this.spaceHeld = false;
    this.tempTool = null;
    // guides-snapping: selected guide ids (view state, the Move tool selects), the New Guide Layout preview, a guide
    // dragged from a ruler (guideDrag), guides moved with the Move tool (guideMove), the ruler corner drag (originDrag)
    this.selectedGuides = new Set();
    this.guidePreview = null;
    this.guidePreviewClears = false;
    this.guideDrag = null;
    this.guideMove = null;
    this.originDrag = null;
    this.overlayFns = new Set();
    this.cssWidth = 1;
    this.cssHeight = 1;

    this.el = document.createElement('div');
    this.el.className = 'canvas-view';
    this.el.innerHTML = `<canvas class="ruler ruler-h"></canvas><canvas class="ruler ruler-v"></canvas><div class="ruler-corner"></div><div class="canvas-area"><canvas class="view" tabindex="0"></canvas></div>`;
    this.area = this.el.querySelector('.canvas-area');
    this.canvas = this.el.querySelector('canvas.view');
    this.rulerH = this.el.querySelector('.ruler-h');
    this.rulerV = this.el.querySelector('.ruler-v');
    this.ctx = this.canvas.getContext('2d');
    host.appendChild(this.el);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.area);
    this.#bindPointer();
    this.unsubscribe = doc.onChange((e) => {
      if (e.kind === 'canvas') this.compositor.invalidate();
      this.invalidate();
    });
    // snap (lib/snap.js): a tool change ends whatever gesture showed smart-guide overlays
    this.offToolChanged = app.on?.('tool:changed', () => app.snap?.end());
    this.checker = null;
    this.resize();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.unsubscribe?.();
    this.offToolChanged?.();
    this.el.remove();
  }

  // ---- geometry ------------------------------------------------------------------------------------------------

  get rulersVisible() {
    return this.app.settings.showRulers !== false;
  }

  resize() {
    const r = this.area.getBoundingClientRect();
    // hidden frames have no size yet: fit once they are shown
    if (r.width < 2 || r.height < 2) return;
    this.cssWidth = Math.max(1, Math.floor(r.width));
    this.cssHeight = Math.max(1, Math.floor(r.height));
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.cssWidth * this.dpr);
    this.canvas.height = Math.round(this.cssHeight * this.dpr);
    this.canvas.style.width = `${this.cssWidth}px`;
    this.canvas.style.height = `${this.cssHeight}px`;
    this.el.classList.toggle('no-rulers', !this.rulersVisible);
    if (!this.fitted) {
      this.fitted = true;
      this.zoomToFit();
    } else this.invalidate();
  }

  /** The view transform (doc -> screen CSS px) as a DOMMatrix. */
  matrix() {
    const m = new DOMMatrix();
    m.translateSelf(this.panX, this.panY);
    if (this.rotation) m.rotateSelf(this.rotation);
    m.scaleSelf(this.zoom, this.zoom);
    return m;
  }

  toScreen(x, y) {
    const p = this.matrix().transformPoint(new DOMPoint(x, y));
    return { x: p.x, y: p.y };
  }

  toDoc(sx, sy) {
    const p = this.matrix().inverse().transformPoint(new DOMPoint(sx, sy));
    return { x: p.x, y: p.y };
  }

  /** Document rect visible on screen (axis-aligned in doc space). */
  visibleRect() {
    const corners = [this.toDoc(0, 0), this.toDoc(this.cssWidth, 0), this.toDoc(0, this.cssHeight), this.toDoc(this.cssWidth, this.cssHeight)];
    const xs = corners.map((c) => c.x), ys = corners.map((c) => c.y);
    const r = { x: Math.floor(Math.min(...xs)), y: Math.floor(Math.min(...ys)) };
    r.width = Math.ceil(Math.max(...xs)) - r.x;
    r.height = Math.ceil(Math.max(...ys)) - r.y;
    return intersectRect(r, this.doc.bounds);
  }

  setZoom(zoom, anchor = null, { animate = false } = {}) {
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    const a = anchor ?? { x: this.cssWidth / 2, y: this.cssHeight / 2 };
    const before = this.toDoc(a.x, a.y);
    this.zoom = z;
    const after = this.toScreen(before.x, before.y);
    this.panX += a.x - after.x;
    this.panY += a.y - after.y;
    void animate;
    this.clampPan();
    this.invalidate();
    this.app.emit('view:changed', { view: this, zoom: this.zoom });
  }

  zoomStep(direction, anchor) {
    const z = this.zoom;
    let next;
    if (direction > 0) next = ZOOM_STEPS.find((s) => s > z + 1e-6) ?? MAX_ZOOM;
    else next = [...ZOOM_STEPS].reverse().find((s) => s < z - 1e-6) ?? MIN_ZOOM;
    this.setZoom(next, anchor);
  }

  zoomToFit(padding = 24) {
    const w = this.cssWidth - padding * 2, h = this.cssHeight - padding * 2;
    const z = Math.min(w / this.doc.width, h / this.doc.height, MAX_ZOOM);
    this.zoom = Math.max(MIN_ZOOM, z);
    this.rotation = 0;
    this.center();
  }

  zoomToFill() {
    const z = Math.max(this.cssWidth / this.doc.width, this.cssHeight / this.doc.height);
    this.zoom = Math.min(MAX_ZOOM, z);
    this.center();
  }

  center() {
    const w = this.doc.width * this.zoom, h = this.doc.height * this.zoom;
    this.panX = Math.round((this.cssWidth - w) / 2);
    this.panY = Math.round((this.cssHeight - h) / 2);
    this.invalidate();
    this.app.emit('view:changed', { view: this, zoom: this.zoom });
  }

  panBy(dx, dy) {
    this.panX += dx;
    this.panY += dy;
    this.clampPan();
    this.invalidate();
    this.app.emit('view:changed', { view: this, zoom: this.zoom });
  }

  /** Keeps at least a sliver of the document on screen. */
  clampPan() {
    const margin = 40;
    const W = this.doc.width, H = this.doc.height;
    // screen box of the (possibly rotated) document
    const pts = [[0, 0], [W, 0], [0, H], [W, H]].map(([x, y]) => this.toScreen(x, y));
    const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
    if (maxX < margin) this.panX += margin - maxX;
    else if (minX > this.cssWidth - margin) this.panX -= minX - (this.cssWidth - margin);
    if (maxY < margin) this.panY += margin - maxY;
    else if (minY > this.cssHeight - margin) this.panY -= minY - (this.cssHeight - margin);
  }

  setRotation(deg) {
    const center = this.toDoc(this.cssWidth / 2, this.cssHeight / 2);
    this.rotation = ((deg % 360) + 360) % 360;
    const after = this.toScreen(center.x, center.y);
    this.panX += this.cssWidth / 2 - after.x;
    this.panY += this.cssHeight / 2 - after.y;
    this.invalidate();
    this.app.emit('view:changed', { view: this, zoom: this.zoom });
  }

  // ---- rendering -----------------------------------------------------------------------------------------------

  invalidate() {
    this.dirty = true;
    if (!this.raf) this.raf = requestAnimationFrame(() => this.paint());
  }

  /** Adds an overlay painter fn(ctx, view) in screen CSS pixels; returns an unsubscribe function. */
  addOverlay(fn) {
    this.overlayFns.add(fn);
    this.invalidate();
    return () => {
      this.overlayFns.delete(fn);
      this.invalidate();
    };
  }

  checkerPattern() {
    const s = this.app.settings;
    const size = Math.max(2, s.checkerboardSize ?? 8);
    const key = `${size}|${s.checkerboardLight}|${s.checkerboardDark}`;
    if (this.checker?.key === key) return this.checker.pattern;
    const c = document.createElement('canvas');
    c.width = c.height = size * 2;
    const x = c.getContext('2d');
    x.fillStyle = s.checkerboardLight ?? '#fff';
    x.fillRect(0, 0, size * 2, size * 2);
    x.fillStyle = s.checkerboardDark ?? '#ccc';
    x.fillRect(0, 0, size, size);
    x.fillRect(size, size, size, size);
    this.checker = { key, pattern: this.ctx.createPattern(c, 'repeat') };
    return this.checker.pattern;
  }

  paint() {
    this.raf = 0;
    if (!this.dirty && !this.doc.selection) return;
    this.dirty = false;
    const ctx = this.ctx;
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
    const m = this.matrix();
    ctx.save();
    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    // checkerboard under the document
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, this.doc.width, this.doc.height);
    ctx.clip();
    ctx.fillStyle = this.checkerPattern();
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
    ctx.restore();
    const composite = this.compositor.composite(this.doc);
    ctx.imageSmoothingEnabled = this.zoom < 4;
    ctx.imageSmoothingQuality = 'high';
    // colour proofing (lib/color-modes.js) may hand back a processed copy to draw instead of the composite
    const shown = (this.postProcess && this.postProcess(composite, this)) || composite;
    ctx.drawImage(shown, 0, 0);
    // the mask channel view and the red overlay: lib/mask-view.js (K.1b, masks-vector-masks)
    paintMaskView(ctx, this, this.doc.active);
    ctx.restore(); // clip
    // view underlays (app.viewUnderlays, L.5): document space, after the composite, before the grid, unclipped
    for (const fn of this.app.viewUnderlays ?? []) {
      ctx.save();
      try {
        fn(ctx, this);
      } catch (err) {
        console.warn('view underlay failed', err);
      }
      ctx.restore();
    }
    this.paintGrid(ctx);
    ctx.restore(); // view transform

    // document edge shadow
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const tl = this.toScreen(0, 0), br = this.toScreen(this.doc.width, this.doc.height);
    if (!this.rotation) {
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(tl.x) - 0.5, Math.round(tl.y) - 0.5, Math.round(br.x - tl.x) + 1, Math.round(br.y - tl.y) + 1);
    }
    ctx.restore();

    this.paintSelection(ctx);
    this.paintGuides(ctx);
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const tool = this.app.tools?.active;
    try {
      tool?.drawOverlay?.(ctx, this);
      for (const fn of this.overlayFns) fn(ctx, this);
      this.app.snap?.drawOverlay?.(ctx, this); // smart guides and Ctrl-hover distances (lib/snap.js)
      this.paintOriginDrag(ctx);
      this.app.canvasCapture?.top()?.overlay?.(ctx, this); // canvas capture (lib/canvas-capture.js, I.3)
    } catch (err) {
      console.warn('overlay failed', err);
    }
    ctx.restore();
    this.paintRulers();
    if (this.doc.selection && !this.doc.selection.isEmpty && this.app.settings.showSelectionEdges !== false && !this.hideAnts) {
      // keep the ants marching
      this.antsOffset = (this.antsOffset + 0.5) % 8;
      this.raf = requestAnimationFrame(() => {
        this.dirty = true;
        this.paint();
      });
    }
  }

  paintGrid(ctx) {
    const s = this.app.settings;
    if (s.showGrid) this.paintLayoutGrid(ctx);
    if (s.pixelGrid !== false && this.zoom >= 8) {
      const vis = this.visibleRect();
      if (!vis) return;
      ctx.save();
      ctx.lineWidth = 1 / this.zoom;
      ctx.strokeStyle = 'rgba(0,0,0,0.18)';
      ctx.beginPath();
      for (let x = vis.x; x <= vis.x + vis.width; x++) {
        ctx.moveTo(x, vis.y);
        ctx.lineTo(x, vis.y + vis.height);
      }
      for (let y = vis.y; y <= vis.y + vis.height; y++) {
        ctx.moveTo(vis.x, y);
        ctx.lineTo(vis.x + vis.width, y);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  /**
   * View > Show > Grid (document space): Gridline Every in its unit, Subdivisions as fainter lines, from the ruler
   * origin, in the preference colour and style (lines, dashed lines, dots). Only the visible part is drawn; lines
   * closer than 4 screen px are left out.
   */
  paintLayoutGrid(ctx) {
    const r = this.app.rulers;
    const vis = this.visibleRect();
    if (!r?.grid || !vis) return;
    const gs = guideSettings(this.app);
    const gx = r.grid(this.doc, 'x'), gy = r.grid(this.doc, 'y');
    if (!(gx.major > 0) || !(gy.major > 0)) return;
    const lines = (g, from, to, step) => {
      const out = [];
      if (!(step * this.zoom >= 4)) return out;
      for (let k = Math.ceil((from - g.origin) / step - 1e-9); out.length < 5000; k++) {
        const v = g.origin + k * step;
        if (v > to + 1e-9) break;
        out.push(v);
      }
      return out;
    };
    const x0 = vis.x, x1 = vis.x + vis.width, y0 = vis.y, y1 = vis.y + vis.height;
    const minorOn = gx.subdivisions > 1;
    ctx.save();
    ctx.strokeStyle = gs.gridColor || '#508cff';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 1 / this.zoom;
    if (gs.gridStyle === 'dashed') ctx.setLineDash([3 / this.zoom, 3 / this.zoom]);
    const passes = [...(minorOn ? [{ sx: gx.minor, sy: gy.minor, alpha: 0.2 }] : []), { sx: gx.major, sy: gy.major, alpha: 0.55 }];
    for (const { sx, sy, alpha } of passes) {
      const xs = lines(gx, x0, x1, sx), ys = lines(gy, y0, y1, sy);
      if (!xs.length && !ys.length) continue;
      ctx.globalAlpha = alpha;
      if (gs.gridStyle === 'dots') {
        // a dot on each crossing (capped: a dense grid at low zoom draws its major crossings only)
        if (xs.length * ys.length > 40000) continue;
        const d = 1.5 / this.zoom;
        for (const x of xs) for (const y of ys) ctx.fillRect(x - d / 2, y - d / 2, d, d);
        continue;
      }
      ctx.beginPath();
      for (const x of xs) {
        ctx.moveTo(x, y0);
        ctx.lineTo(x, y1);
      }
      for (const y of ys) {
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  paintSelection(ctx) {
    const sel = this.doc.selection;
    if (!sel || sel.isEmpty || this.app.settings.showSelectionEdges === false || this.hideAnts) return;
    const m = this.matrix();
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    const path = sel.path2d();
    ctx.lineWidth = 1 / this.zoom;
    ctx.strokeStyle = '#ffffff';
    ctx.setLineDash([]);
    ctx.stroke(path);
    ctx.strokeStyle = '#000000';
    ctx.setLineDash([4 / this.zoom, 4 / this.zoom]);
    ctx.lineDashOffset = -this.antsOffset / this.zoom;
    ctx.stroke(path);
    ctx.restore();
  }

  /**
   * Guides in screen space: each in its own colour (else the preference colour) and the preference style; selected
   * guides wider; the New Guide Layout preview dashed; a guide being dragged from a ruler or moved with the Move tool
   * where the pointer is (faint while it would be deleted).
   */
  paintGuides(ctx) {
    const s = this.app.settings;
    const shown = s.showGuides !== false;
    const preview = this.guidePreview;
    const drag = this.guideDrag;
    const move = this.guideMove;
    if (!shown && !preview && !drag?.active) return;
    const gs = guideSettings(this.app);
    let list = shown ? this.doc.guides : [];
    if (preview && this.guidePreviewClears) list = list.filter((g) => g.artboard);
    const moving = move ? new Set(move.ids) : null;
    const selected = this.selectedGuides?.size ? new Set(selectedGuides(this).map((g) => g.id)) : null;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const stroke = (g, { width = 1, alpha = 1, dashed = gs.style === 'dashed' } = {}) => {
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = guideColor(this.app, g);
      ctx.lineWidth = width;
      ctx.setLineDash(dashed ? [4, 3] : []);
      ctx.beginPath();
      this.guideLine(ctx, g);
      ctx.stroke();
    };
    for (const g of list) {
      if (moving?.has(g.id)) continue;
      if (selected?.has(g.id)) {
        // a selected guide: a wide pale band under the line
        stroke(g, { width: 5, alpha: 0.35, dashed: false });
        stroke(g, { width: 1 });
      } else stroke(g);
    }
    for (const g of preview ?? []) stroke(g, { dashed: true, alpha: 0.9 });
    if (move) {
      for (const id of move.ids) {
        const g = this.doc.guides.find((x) => x.id === id);
        if (g) stroke({ ...g, pos: g.pos + move.delta }, { width: selected?.has(id) ? 2 : 1, alpha: move.outside ? 0.35 : 1 });
      }
    }
    if (drag?.active) stroke({ axis: drag.axis, pos: drag.pos }, { alpha: 1 });
    ctx.restore();
  }

  /** Adds the screen-space line of a guide (through the view's rotation) to the current path. */
  guideLine(ctx, g) {
    const a = g.axis === 'x' ? this.toScreen(g.pos, 0) : this.toScreen(0, g.pos);
    const b = g.axis === 'x' ? this.toScreen(g.pos, this.doc.height) : this.toScreen(this.doc.width, g.pos);
    if (!this.rotation) {
      if (g.axis === 'x') {
        ctx.moveTo(Math.round(a.x) + 0.5, 0);
        ctx.lineTo(Math.round(a.x) + 0.5, this.cssHeight);
      } else {
        ctx.moveTo(0, Math.round(a.y) + 0.5);
        ctx.lineTo(this.cssWidth, Math.round(a.y) + 0.5);
      }
      return;
    }
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    const reach = (this.cssWidth + this.cssHeight) * 2;
    ctx.moveTo(a.x - ux * reach, a.y - uy * reach);
    ctx.lineTo(a.x + ux * reach, a.y + uy * reach);
  }

  /** The ruler of an axis: document px per unit, the labelled step and the minor step (units), the origin. */
  rulerScale(horizontal) {
    const r = this.app.rulers;
    const axis = horizontal ? 'x' : 'y';
    const unit = r ? r.unit(this.doc) : 'px';
    const perUnit = r ? r.perUnit(this.doc, axis) : 1;
    const pxPerUnit = perUnit * this.zoom;
    // choose a tick step so labels are >= 50px apart
    const candidates = unit === 'px' ? [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] : [0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];
    const major = candidates.find((s) => s * pxPerUnit >= 50) ?? candidates[candidates.length - 1];
    const minor = major / (major % 5 === 0 || major >= 1 ? 5 : 2);
    const origin = r ? r.origin(this.doc)[axis] : 0;
    return { unit, perUnit, pxPerUnit, major, minor, origin };
  }

  /** Rulers in the current unit, counted from the ruler origin, with the pointer marked. */
  paintRulers() {
    if (!this.rulersVisible) return;
    const dpr = this.dpr;
    const style = getComputedStyle(this.el);
    const bg = style.getPropertyValue('--bg-elevated') || '#eee';
    const fg = style.getPropertyValue('--fg-muted') || '#666';
    const draw = (canvas, horizontal) => {
      const length = horizontal ? this.cssWidth : this.cssHeight;
      canvas.width = Math.round((horizontal ? length : RULER_SIZE) * dpr);
      canvas.height = Math.round((horizontal ? RULER_SIZE : length) * dpr);
      canvas.style.width = `${horizontal ? length : RULER_SIZE}px`;
      canvas.style.height = `${horizontal ? RULER_SIZE : length}px`;
      const c = canvas.getContext('2d');
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.fillStyle = bg;
      c.fillRect(0, 0, horizontal ? length : RULER_SIZE, horizontal ? RULER_SIZE : length);
      c.fillStyle = fg;
      c.strokeStyle = fg;
      c.font = '9px system-ui, sans-serif';
      c.textBaseline = 'top';
      const { pxPerUnit, major, minor, origin: o } = this.rulerScale(horizontal);
      const zero = horizontal ? this.toScreen(o, 0).x : this.toScreen(0, o).y;
      const start = Math.floor((0 - zero) / pxPerUnit / minor) * minor;
      const end = (length - zero) / pxPerUnit;
      c.beginPath();
      for (let i = 0, u = start; u <= end && i < 4000; i++, u = start + i * minor) {
        const pos = Math.round(zero + u * pxPerUnit) + 0.5;
        const isMajor = Math.abs(u / major - Math.round(u / major)) < 1e-6;
        const len = isMajor ? RULER_SIZE : RULER_SIZE * 0.35;
        if (horizontal) {
          c.moveTo(pos, RULER_SIZE - len);
          c.lineTo(pos, RULER_SIZE);
        } else {
          c.moveTo(RULER_SIZE - len, pos);
          c.lineTo(RULER_SIZE, pos);
        }
        if (isMajor) {
          const v = Math.round(u * 100) / 100;
          const label = String(Object.is(v, -0) ? 0 : v);
          if (horizontal) c.fillText(label, pos + 2, 1);
          else {
            c.save();
            c.translate(2, pos + 2);
            c.rotate(-Math.PI / 2);
            c.textAlign = 'right';
            c.fillText(label, 0, 0);
            c.restore();
          }
        }
      }
      c.stroke();
      // cursor marker
      if (this.pointer) {
        const p = this.toScreen(this.pointer.x, this.pointer.y);
        c.strokeStyle = '#4f81ff';
        c.beginPath();
        if (horizontal) {
          c.moveTo(Math.round(p.x) + 0.5, 0);
          c.lineTo(Math.round(p.x) + 0.5, RULER_SIZE);
        } else {
          c.moveTo(0, Math.round(p.y) + 0.5);
          c.lineTo(RULER_SIZE, Math.round(p.y) + 0.5);
        }
        c.stroke();
      }
    };
    draw(this.rulerH, true);
    draw(this.rulerV, false);
  }

  /** The crosshair of a ruler-corner drag (screen space): where the new ruler origin goes. */
  paintOriginDrag(ctx) {
    const o = this.originDrag;
    if (!o?.active) return;
    const p = this.toScreen(o.x, o.y);
    ctx.save();
    ctx.strokeStyle = '#000000';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(p.x) + 0.5, 0);
    ctx.lineTo(Math.round(p.x) + 0.5, this.cssHeight);
    ctx.moveTo(0, Math.round(p.y) + 0.5);
    ctx.lineTo(this.cssWidth, Math.round(p.y) + 0.5);
    ctx.stroke();
    ctx.strokeStyle = '#ffffff';
    ctx.lineDashOffset = 3;
    ctx.stroke();
    ctx.restore();
  }

  /** The ruler's context menu: the units, and Reset Ruler Origin. */
  rulerMenu(e) {
    e.preventDefault();
    const app = this.app;
    const unit = app.rulers?.unit(this.doc) ?? 'px';
    const run = (id, arg) => app.commands.run(id, arg, 'panel');
    app.dialogs.popover(e.currentTarget, [
      ...UNITS.map((u) => ({ label: UNIT_NAMES[u], checked: u === unit, onSelect: () => run('view:ruler-unit', u) })),
      { type: 'separator' },
      { label: 'Reset Ruler Origin', disabled: !app.commands.isEnabled('view:ruler-origin-reset'), onSelect: () => run('view:ruler-origin-reset') },
    ], { at: { x: e.clientX, y: e.clientY } });
  }

  // ---- pointer routing -----------------------------------------------------------------------------------------

  #bindPointer() {
    const canvas = this.canvas;
    const norm = (e) => {
      const r = canvas.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const d = this.toDoc(sx, sy);
      // temporary: the modifier that summoned a temporary tool (view.tempToolVia, set with view.tempTool by
      // conventions' temp-tools.js), so snap.js does not read that held Ctrl as "do not snap" (F)
      return { x: d.x, y: d.y, screenX: sx, screenY: sy, pressure: e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 1, tiltX: e.tiltX, tiltY: e.tiltY, buttons: e.buttons, button: e.button, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, pointerType: e.pointerType, temporary: this.tempTool ? this.tempToolVia ?? null : null, original: e };
    };
    let dragging = false;
    let handDrag = null;
    let capturing = null; // the canvas-capture handler that took the current drag (lib/canvas-capture.js, I.3)
    const currentTool = () => this.tempTool ?? this.app.tools?.active;
    const capture = () => this.app.canvasCapture?.top() ?? null;
    const overCanvas = (e) => {
      const r = canvas.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    };
    const eventDoc = (e) => {
      const r = canvas.getBoundingClientRect();
      return this.toDoc(e.clientX - r.left, e.clientY - r.top);
    };
    // dragging out of a ruler creates a guide (released over the canvas) at the pointer position; Alt makes it the
    // other orientation, Shift puts it on a ruler tick (else it snaps like any guide drag)
    for (const [ruler, rulerAxis] of [[this.rulerH, 'y'], [this.rulerV, 'x']]) {
      const place = (e) => {
        const axis = e.altKey ? (rulerAxis === 'x' ? 'y' : 'x') : rulerAxis;
        const d = eventDoc(e);
        let pos;
        if (e.shiftKey) {
          const sc = this.rulerScale(axis === 'x');
          const step = sc.minor * sc.perUnit;
          pos = sc.origin + Math.round((d[axis] - sc.origin) / step) * step;
        } else {
          // snap (lib/snap.js): a guide dragged from a ruler snaps along its own axis
          const s = this.app.snap?.point(d, { source: 'guide', axis, pointer: { x: d.x, y: d.y, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, temporary: null }, view: this }) ?? d;
          pos = s[axis];
        }
        return { axis, pos: Math.round(pos * 100) / 100 };
      };
      ruler.style.cursor = rulerAxis === 'y' ? 'row-resize' : 'col-resize';
      ruler.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        ruler.setPointerCapture(e.pointerId);
        this.guideDrag = { ruler: rulerAxis, ...place(e), active: false };
        e.preventDefault();
      });
      ruler.addEventListener('pointermove', (e) => {
        if (!this.guideDrag || this.guideDrag.ruler !== rulerAxis) return;
        Object.assign(this.guideDrag, place(e), { active: overCanvas(e) });
        this.invalidate();
      });
      const finish = (e) => {
        const g = this.guideDrag;
        if (!g || g.ruler !== rulerAxis) return;
        this.guideDrag = null;
        const over = e.type === 'pointerup' && overCanvas(e);
        if (over) {
          const { axis, pos } = place(e);
          this.app.commands.run('view:new-guide', { axis, pos }, 'panel');
        }
        this.app.snap?.end();
        this.invalidate();
      };
      ruler.addEventListener('pointerup', finish);
      ruler.addEventListener('pointercancel', finish);
      ruler.addEventListener('contextmenu', (e) => this.rulerMenu(e));
    }
    // the ruler corner: drag to move the ruler origin (where both rulers read 0), double-click to put it back
    const corner = this.el.querySelector('.ruler-corner');
    if (corner) {
      corner.title = 'Drag to set the ruler origin; double-click to reset it';
      const placeOrigin = (e) => {
        const d = eventDoc(e);
        // snap (lib/snap.js): the origin snaps like a guide does, on both axes
        const s = e.shiftKey ? { x: Math.round(d.x), y: Math.round(d.y) } : this.app.snap?.point(d, { source: 'guide', pointer: { x: d.x, y: d.y, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, temporary: null }, view: this }) ?? d;
        return { x: Math.round(s.x * 100) / 100, y: Math.round(s.y * 100) / 100 };
      };
      corner.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        corner.setPointerCapture(e.pointerId);
        this.originDrag = { ...placeOrigin(e), active: false };
        e.preventDefault();
      });
      corner.addEventListener('pointermove', (e) => {
        if (!this.originDrag) return;
        Object.assign(this.originDrag, placeOrigin(e), { active: overCanvas(e) });
        this.invalidate();
      });
      const done = (e) => {
        const o = this.originDrag;
        if (!o) return;
        this.originDrag = null;
        if (e.type === 'pointerup' && overCanvas(e)) this.app.commands.run('view:ruler-origin', placeOrigin(e), 'panel');
        this.app.snap?.end();
        this.invalidate();
      };
      corner.addEventListener('pointerup', done);
      corner.addEventListener('pointercancel', done);
      corner.addEventListener('dblclick', () => this.app.commands.run('view:ruler-origin-reset', undefined, 'panel'));
      corner.addEventListener('contextmenu', (e) => this.rulerMenu(e));
    }
    canvas.addEventListener('pointerdown', (e) => {
      canvas.focus({ preventScroll: true });
      const p = norm(e);
      this.pointer = { x: p.x, y: p.y };
      if (e.button === 1 || this.spaceHeld || (e.button === 0 && e.altKey && e.ctrlKey && false)) {
        handDrag = { x: e.clientX, y: e.clientY };
        canvas.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }
      if (e.button !== 0 && e.button !== 2) return;
      // a canvas-capture handler (an armed eyedropper, a dialog letting the canvas through) takes the click before
      // the active tool; panning stays first
      const cap = e.button === 0 ? capture() : null;
      if (cap) {
        capturing = cap;
        dragging = true;
        canvas.setPointerCapture(e.pointerId);
        e.preventDefault();
        try {
          cap.down(p, this);
        } catch (err) {
          console.warn('canvas capture failed', err);
        }
        this.invalidate();
        return;
      }
      dragging = true;
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      if (e.button === 2) {
        currentTool()?.onContextMenu?.(p);
        return;
      }
      currentTool()?.onPointerDown?.(p);
      this.invalidate();
    });
    canvas.addEventListener('pointermove', (e) => {
      const events = typeof e.getCoalescedEvents === 'function' && dragging ? e.getCoalescedEvents() : [e];
      for (const ce of events.length ? events : [e]) {
        const p = norm(ce);
        this.pointer = { x: p.x, y: p.y };
        if (handDrag) {
          this.panBy(ce.clientX - handDrag.x, ce.clientY - handDrag.y);
          handDrag = { x: ce.clientX, y: ce.clientY };
          continue;
        }
        const cap = capturing ?? capture();
        if (cap) {
          cap.move?.(p, this, dragging);
          continue;
        }
        currentTool()?.onPointerMove?.(p, dragging);
      }
      this.app.emit('pointer:moved', { view: this, x: this.pointer.x, y: this.pointer.y });
      this.invalidate();
    });
    const up = (e) => {
      const p = norm(e);
      if (handDrag) {
        handDrag = null;
        return;
      }
      if (!dragging) return;
      dragging = false;
      if (capturing) {
        const cap = capturing;
        capturing = null;
        cap.up?.(p, this);
        this.invalidate();
        return;
      }
      if (e.button === 2) return;
      currentTool()?.onPointerUp?.(p);
      this.app.snap?.end(); // snap (lib/snap.js): the gesture is over
      this.invalidate();
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', (e) => {
      if (dragging) {
        dragging = false;
        if (capturing) {
          const cap = capturing;
          capturing = null;
          cap.up?.({ ...norm(e), cancelled: true }, this);
        } else {
          currentTool()?.onPointerCancel?.(norm(e));
          this.app.snap?.end(); // snap (lib/snap.js)
        }
      }
      handDrag = null;
    });
    canvas.addEventListener('pointerleave', () => {
      if (!dragging) {
        this.pointer = null;
        this.invalidate();
      }
    });
    canvas.addEventListener('dblclick', (e) => {
      if (capture()) return; // a captured canvas: the tool never sees the double-click
      currentTool()?.onDoubleClick?.(norm(e));
    });
    // drop (E25): in-app drags (a gradient or a pattern from a panel) dropped on the canvas
    canvas.addEventListener('dragover', (e) => {
      if (this.app.dropHandlerFor?.(e.dataTransfer, 'canvas')) e.preventDefault(); // drop (E25)
    });
    canvas.addEventListener('drop', (e) => {
      const found = this.app.dropHandlerFor?.(e.dataTransfer, 'canvas'); // drop (E25)
      if (!found) return;
      e.preventDefault();
      e.stopPropagation();
      const r = canvas.getBoundingClientRect();
      const d = this.toDoc(e.clientX - r.left, e.clientY - r.top);
      found.handler.canvas(e.dataTransfer.getData(found.mime), { x: d.x, y: d.y }, e);
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const r = canvas.getBoundingClientRect();
        const anchor = { x: e.clientX - r.left, y: e.clientY - r.top };
        const zoomGesture = e.ctrlKey || e.metaKey || this.app.settings.zoomWithWheel;
        if (zoomGesture) {
          const factor = Math.exp(-e.deltaY * (e.ctrlKey && Math.abs(e.deltaY) < 20 ? 0.01 : 0.0015));
          this.setZoom(this.zoom * factor, anchor);
        } else if (e.shiftKey) this.panBy(-e.deltaY, -e.deltaX);
        else this.panBy(-e.deltaX, -e.deltaY);
      },
      { passive: false }
    );
    // touch pinch
    let pinch = null;
    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) pinch = { d: dist(e.touches), c: mid(e.touches, canvas), zoom: this.zoom };
    }, { passive: true });
    canvas.addEventListener('touchmove', (e) => {
      if (pinch && e.touches.length === 2) {
        e.preventDefault();
        const d = dist(e.touches);
        this.setZoom((pinch.zoom * d) / pinch.d, mid(e.touches, canvas));
      }
    }, { passive: false });
    canvas.addEventListener('touchend', () => (pinch = null));
  }

  setCursor(cursor) {
    this.canvas.style.cursor = cursor || 'default';
  }
}

function dist(t) {
  return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
}
function mid(t, canvas) {
  const r = canvas.getBoundingClientRect();
  return { x: (t[0].clientX + t[1].clientX) / 2 - r.left, y: (t[0].clientY + t[1].clientY) / 2 - r.top };
}

export { ZOOM_STEPS };
