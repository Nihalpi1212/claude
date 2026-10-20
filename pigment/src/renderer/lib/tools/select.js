// Selection tools: rectangular/elliptical marquee, single row/column, lasso (free, polygonal,
// magnetic-lite), magic wand and quick selection.
import { Tool } from '../tools.js';
import { Selection } from '../selection.js';
import { selectionOps } from '../selection.js';
import { flattenDocument } from '../compositor.js';
import { cropImage, clampRect } from '../../../shared/pixels/core.js';

const COMBINE_OPTION = { kind: 'segment', key: 'combine', label: '', options: [['replace', 'New selection', 'sel-new'], ['add', 'Add to selection (Shift)', 'sel-add'], ['subtract', 'Subtract (Alt)', 'sel-sub'], ['intersect', 'Intersect (Shift+Alt)', 'sel-int']], default: 'replace' };

function combineMode(tool, p) {
  if (p.shift && p.alt) return 'intersect';
  if (p.shift) return 'add';
  if (p.alt) return 'subtract';
  return tool.opt('combine') ?? 'replace';
}

/** Applies a new selection to the document through the history (undoable). */
export function applySelection(app, next, mode = 'replace', label = 'Selection') {
  // one implementation for tools and commands (records the previous selection for Reselect)
  app.applySelection(next, mode, label);
  app.emit('selection:changed', app.doc);
}

export class MarqueeTool extends Tool {
  constructor(app, shape = 'rect') {
    const names = { rect: 'Rectangular Marquee Tool', ellipse: 'Elliptical Marquee Tool', row: 'Single Row Marquee Tool', column: 'Single Column Marquee Tool' };
    const icons = { rect: 'marquee-rect', ellipse: 'marquee-ellipse', row: 'marquee-row', column: 'marquee-column' };
    super(app, {
      id: `marquee-${shape}`,
      name: names[shape],
      icon: icons[shape],
      cursor: 'crosshair',
      hint: 'Drag to select. Shift adds, Alt subtracts, Shift+Alt intersects. Hold Shift while dragging for a square/circle, Alt to draw from the centre.',
      options: [
        COMBINE_OPTION,
        { kind: 'number', key: 'feather', label: 'Feather', min: 0, max: 250, step: 0.5, default: 0, unit: 'px' },
        { kind: 'checkbox', key: 'antialias', label: 'Anti-alias', default: true },
        { kind: 'select', key: 'style', label: 'Style', options: [['normal', 'Normal'], ['ratio', 'Fixed ratio'], ['size', 'Fixed size']], default: 'normal' },
        { kind: 'number', key: 'fixedW', label: 'W', min: 1, max: 30000, default: 100, when: (t) => t.opt('style') !== 'normal' },
        { kind: 'number', key: 'fixedH', label: 'H', min: 1, max: 30000, default: 100, when: (t) => t.opt('style') !== 'normal' },
      ],
    });
    this.shape = shape;
    this.drag = null;
  }
  onPointerDown(p) {
    if (this.shape === 'row' || this.shape === 'column') {
      const doc = this.doc;
      const rect = this.shape === 'row' ? { x: 0, y: Math.floor(p.y), width: doc.width, height: 1 } : { x: Math.floor(p.x), y: 0, width: 1, height: doc.height };
      applySelection(this.app, Selection.fromRect(doc.width, doc.height, rect), combineMode(this, p), 'Marquee');
      return;
    }
    // with a selection, Shift/Alt held at mouse-down only choose the combine mode; pressed later
    // (or without a selection) they constrain to a square / draw from the centre
    const hasSel = !!this.doc.selection && !this.doc.selection.isEmpty;
    this.drag = { start: { x: p.x, y: p.y }, current: { x: p.x, y: p.y }, mode: combineMode(this, p), fromCenter: p.alt && !p.shift && !hasSel, square: p.shift && !hasSel, latch: { shift: p.shift && hasSel, alt: p.alt && hasSel }, moved: false };
    if (this.opt('style') === 'size') {
      this.drag.current = { x: p.x + this.opt('fixedW'), y: p.y + this.opt('fixedH') };
      this.drag.moved = true;
    }
  }
  onPointerMove(p, dragging) {
    if (!dragging || !this.drag) return;
    if (this.opt('style') === 'size') {
      this.drag.start = { x: p.x, y: p.y };
      this.drag.current = { x: p.x + this.opt('fixedW'), y: p.y + this.opt('fixedH') };
      return;
    }
    this.drag.current = { x: p.x, y: p.y };
    this.drag.moved = true;
    const latch = this.drag.latch;
    if (!p.shift) latch.shift = false;
    if (!p.alt) latch.alt = false;
    this.drag.square = p.shift && !latch.shift;
    this.drag.fromCenter = p.alt && !latch.alt;
  }
  rect() {
    const d = this.drag;
    if (!d) return null;
    let x1 = d.start.x, y1 = d.start.y, x2 = d.current.x, y2 = d.current.y;
    let w = x2 - x1, h = y2 - y1;
    if (this.opt('style') === 'ratio') {
      const ratio = (this.opt('fixedW') || 1) / (this.opt('fixedH') || 1);
      const sign = Math.sign(h) || 1;
      h = (Math.abs(w) / ratio) * sign;
    } else if (d.square) {
      const m = Math.max(Math.abs(w), Math.abs(h));
      w = Math.sign(w || 1) * m;
      h = Math.sign(h || 1) * m;
    }
    if (d.fromCenter) {
      x1 -= w;
      y1 -= h;
      w *= 2;
      h *= 2;
    }
    const r = { x: Math.min(x1, x1 + w), y: Math.min(y1, y1 + h), width: Math.abs(w), height: Math.abs(h) };
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  }
  onPointerUp(p) {
    const d = this.drag;
    this.drag = null;
    if (!d || p.cancelled) return;
    const r = this.rect.call({ drag: d, opt: this.opt.bind(this) });
    const doc = this.doc;
    if (!d.moved || r.width < 1 || r.height < 1) {
      if (d.mode === 'replace' && doc.selection) applySelection(this.app, null, 'replace', 'Deselect');
      return;
    }
    let sel = this.shape === 'ellipse' ? Selection.fromEllipse(doc.width, doc.height, r, { antialias: this.opt('antialias') !== false }) : Selection.fromRect(doc.width, doc.height, r);
    const feather = this.opt('feather');
    if (feather > 0) sel = sel.feather(feather);
    applySelection(this.app, sel, d.mode, this.shape === 'ellipse' ? 'Elliptical marquee' : 'Rectangular marquee');
    this.app.statusbar.set('hint', `Selection ${r.width} × ${r.height} px`);
  }
  cancel() {
    if (this.drag) {
      this.drag = null;
      return true;
    }
    return false;
  }
  drawOverlay(ctx, view) {
    const r = this.rect();
    if (!r || !this.drag?.moved) return;
    const a = view.toScreen(r.x, r.y), b = view.toScreen(r.x + r.width, r.y + r.height);
    ctx.save();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    const draw = () => {
      ctx.beginPath();
      if (this.shape === 'ellipse') ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
      else ctx.rect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(b.x - a.x), Math.round(b.y - a.y));
      ctx.stroke();
    };
    draw();
    ctx.strokeStyle = '#000';
    ctx.setLineDash([4, 4]);
    draw();
    ctx.restore();
    ctx.save();
    ctx.font = '11px system-ui';
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    const label = `${r.width} × ${r.height}`;
    ctx.fillRect(b.x + 8, b.y + 8, ctx.measureText(label).width + 8, 16);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, b.x + 12, b.y + 20);
    ctx.restore();
  }
}

export class LassoTool extends Tool {
  constructor(app, kind = 'free') {
    const names = { free: 'Lasso Tool', polygon: 'Polygonal Lasso Tool', magnetic: 'Magnetic Lasso Tool' };
    super(app, {
      id: `lasso-${kind}`,
      name: names[kind],
      icon: kind === 'free' ? 'lasso' : kind === 'polygon' ? 'lasso-poly' : 'lasso-magnetic',
      cursor: 'crosshair',
      hint: kind === 'free' ? 'Drag a freehand outline; release to close it.' : kind === 'polygon' ? 'Click to add points, double-click or click the first point to close, Backspace removes the last point.' : 'Click to start, move along an edge; the outline snaps to contrast. Double-click to close.',
      options: [COMBINE_OPTION, { kind: 'number', key: 'feather', label: 'Feather', min: 0, max: 250, step: 0.5, default: 0, unit: 'px' }, { kind: 'checkbox', key: 'antialias', label: 'Anti-alias', default: true }, ...(kind === 'magnetic' ? [{ kind: 'number', key: 'width', label: 'Width', min: 1, max: 256, default: 10, unit: 'px' }, { kind: 'number', key: 'contrast', label: 'Contrast', min: 1, max: 100, default: 10, unit: '%' }, { kind: 'number', key: 'frequency', label: 'Frequency', min: 0, max: 100, default: 57 }] : [])],
    });
    this.kind = kind;
    this.points = null;
    this.mode = 'replace';
    this.hover = null;
  }
  onPointerDown(p) {
    if (this.kind === 'free') {
      this.points = [{ x: p.x, y: p.y }];
      this.mode = combineMode(this, p);
      return;
    }
    if (!this.points) {
      this.points = [{ x: p.x, y: p.y }];
      this.mode = combineMode(this, p);
      this.edgeMap = this.kind === 'magnetic' ? this.computeEdges() : null;
      return;
    }
    const first = this.points[0];
    const near = this.view ? Math.hypot(p.x - first.x, p.y - first.y) * this.view.zoom < 8 : false;
    if (near && this.points.length > 2) return this.finish();
    this.points.push(this.kind === 'magnetic' ? this.snap({ x: p.x, y: p.y }) : { x: p.x, y: p.y });
  }
  onPointerMove(p, dragging) {
    if (this.kind === 'free') {
      if (dragging && this.points) this.points.push({ x: p.x, y: p.y });
      return;
    }
    if (this.points) {
      this.hover = { x: p.x, y: p.y };
      if (this.kind === 'magnetic' && dragging === false && this.points.length) {
        const last = this.points[this.points.length - 1];
        const step = Math.max(2, 100 / (this.opt('frequency') || 50) * 2);
        if (Math.hypot(p.x - last.x, p.y - last.y) > step) this.points.push(this.snap({ x: p.x, y: p.y }));
      }
    }
  }
  onPointerUp(p) {
    if (this.kind === 'free' && this.points && !p.cancelled) {
      this.points.push({ x: p.x, y: p.y });
      this.finish();
    }
  }
  onDoubleClick() {
    if (this.kind !== 'free' && this.points) this.finish();
  }
  onKeyDown(e) {
    if (e.key === 'Backspace' && this.points && this.kind !== 'free') {
      this.points.pop();
      if (!this.points.length) this.points = null;
      return true;
    }
    return false;
  }
  commit() {
    if (this.points && this.kind !== 'free') {
      this.finish();
      return true;
    }
    return false;
  }
  cancel() {
    if (this.points) {
      this.points = null;
      this.hover = null;
      return true;
    }
    return false;
  }
  finish() {
    const pts = this.points;
    this.points = null;
    this.hover = null;
    const doc = this.doc;
    if (!pts || pts.length < 3) {
      if (this.mode === 'replace' && doc.selection) applySelection(this.app, null, 'replace', 'Deselect');
      return;
    }
    let sel = Selection.fromPolygon(doc.width, doc.height, pts.map((q) => [q.x, q.y]), { antialias: this.opt('antialias') !== false });
    const feather = this.opt('feather');
    if (feather > 0) sel = sel.feather(feather);
    applySelection(this.app, sel, this.mode, 'Lasso');
  }
  computeEdges() {
    // gradient magnitude of the flattened image, used to snap magnetic points
    const canvas = flattenDocument(this.doc, this.view.compositor);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const { width, height } = canvas;
    const d = ctx.getImageData(0, 0, width, height).data;
    const lum = new Float32Array(width * height);
    for (let i = 0, j = 0; i < lum.length; i++, j += 4) lum[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    const mag = new Float32Array(width * height);
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx = lum[i + 1] - lum[i - 1], gy = lum[i + width] - lum[i - width];
      mag[i] = Math.hypot(gx, gy);
    }
    return { mag, width, height };
  }
  snap(p) {
    const e = this.edgeMap;
    if (!e) return p;
    const w = Math.max(1, this.opt('width') ?? 10);
    const threshold = ((this.opt('contrast') ?? 10) / 100) * 255;
    let best = null, bestScore = -1;
    const cx = Math.round(p.x), cy = Math.round(p.y);
    for (let dy = -w; dy <= w; dy++) for (let dx = -w; dx <= w; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= e.width || y >= e.height || dx * dx + dy * dy > w * w) continue;
      const m = e.mag[y * e.width + x];
      if (m < threshold) continue;
      const score = m - Math.hypot(dx, dy) * 2;
      if (score > bestScore) {
        bestScore = score;
        best = { x: x + 0.5, y: y + 0.5 };
      }
    }
    return best ?? p;
  }
  drawOverlay(ctx, view) {
    if (!this.points?.length) return;
    ctx.save();
    ctx.lineWidth = 1;
    const pts = this.points.map((q) => view.toScreen(q.x, q.y));
    const draw = () => {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (const q of pts.slice(1)) ctx.lineTo(q.x, q.y);
      if (this.hover && this.kind !== 'free') {
        const h = view.toScreen(this.hover.x, this.hover.y);
        ctx.lineTo(h.x, h.y);
      }
      ctx.stroke();
    };
    ctx.strokeStyle = '#fff';
    ctx.setLineDash([]);
    draw();
    ctx.strokeStyle = '#000';
    ctx.setLineDash([4, 4]);
    draw();
    if (this.kind !== 'free') {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#000';
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }
}

export class WandTool extends Tool {
  constructor(app, kind = 'wand') {
    super(app, {
      id: kind === 'wand' ? 'wand' : 'quick-select',
      name: kind === 'wand' ? 'Magic Wand Tool' : 'Quick Selection Tool',
      icon: kind === 'wand' ? 'wand' : 'quick-select',
      cursor: 'crosshair',
      hint: kind === 'wand' ? 'Click a colour to select similar pixels. Shift adds, Alt subtracts.' : 'Paint over an area to select it; Alt paints to remove.',
      options: [
        COMBINE_OPTION,
        { kind: 'number', key: 'tolerance', label: 'Tolerance', min: 0, max: 255, default: 32 },
        { kind: 'checkbox', key: 'antialias', label: 'Anti-alias', default: true },
        { kind: 'checkbox', key: 'contiguous', label: 'Contiguous', default: true },
        { kind: 'checkbox', key: 'sampleMerged', label: 'Sample all layers', default: false },
        ...(kind === 'quick' ? [{ kind: 'slider', key: 'size', label: 'Size', min: 1, max: 500, default: 30, unit: 'px' }] : []),
      ],
    });
    this.kind = kind;
    this.stroke = null;
  }
  sourceImage() {
    const doc = this.doc;
    if (this.opt('sampleMerged') || !doc.active || doc.active.isGroup) {
      const c = flattenDocument(doc, this.view.compositor);
      return c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, doc.width, doc.height);
    }
    const layer = doc.active;
    const img = new ImageData(doc.width, doc.height);
    const src = layer.type === 'raster' ? { canvas: layer.canvas, x: layer.x, y: layer.y } : layer.render?.();
    if (src) {
      const tmp = document.createElement('canvas');
      tmp.width = doc.width;
      tmp.height = doc.height;
      const tctx = tmp.getContext('2d', { willReadFrequently: true });
      tctx.drawImage(src.canvas, src.x, src.y);
      return tctx.getImageData(0, 0, doc.width, doc.height);
    }
    return img;
  }
  onPointerDown(p) {
    const doc = this.doc;
    const x = Math.floor(p.x), y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
    const img = this.sourceImage();
    const mode = combineMode(this, p);
    if (this.kind === 'wand') {
      const mask = selectionOps.floodFill(img, x, y, { tolerance: this.opt('tolerance') ?? 32, contiguous: this.opt('contiguous') !== false, antialias: this.opt('antialias') !== false });
      applySelection(this.app, Selection.fromMask(doc.width, doc.height, mask), mode, 'Magic wand');
      return;
    }
    this.stroke = { img, mode: p.alt ? 'subtract' : mode === 'replace' ? 'add' : mode, mask: new Uint8ClampedArray(doc.width * doc.height), replace: mode === 'replace' && !p.alt };
    this.paintQuick(x, y);
  }
  paintQuick(x, y) {
    const s = this.stroke;
    const doc = this.doc;
    const size = this.opt('size') ?? 30;
    const r = Math.max(1, size / 2);
    const tol = this.opt('tolerance') ?? 32;
    // flood from a few seed points inside the brush circle, limited to a window around it
    const seeds = [[x, y], [x - r / 2, y], [x + r / 2, y], [x, y - r / 2], [x, y + r / 2]].map(([sx, sy]) => [Math.round(sx), Math.round(sy)]).filter(([sx, sy]) => sx >= 0 && sy >= 0 && sx < doc.width && sy < doc.height);
    // flood within a window around the brush so one click never grabs the whole image
    const win = clampRect({ x: Math.floor(x - r * 3), y: Math.floor(y - r * 3), width: Math.ceil(r * 6), height: Math.ceil(r * 6) }, doc.width, doc.height);
    const sub = cropImage(s.img, win);
    for (const [sx, sy] of seeds) {
      if (s.mask[sy * doc.width + sx] || sx < win.x || sy < win.y || sx >= win.x + win.width || sy >= win.y + win.height) continue;
      const m = selectionOps.floodFill(sub, sx - win.x, sy - win.y, { tolerance: tol, contiguous: true, antialias: false });
      for (let yy = 0; yy < win.height; yy++) {
        const row = (win.y + yy) * doc.width + win.x, srow = yy * win.width;
        for (let xx = 0; xx < win.width; xx++) if (m[srow + xx] > s.mask[row + xx]) s.mask[row + xx] = m[srow + xx];
      }
    }
    // include the brush disc itself, but only pixels close in colour to the one under the centre
    const img = s.img.data, W = doc.width;
    const c0 = (y * W + x) * 4;
    const near = (i) => Math.max(Math.abs(img[i] - img[c0]), Math.abs(img[i + 1] - img[c0 + 1]), Math.abs(img[i + 2] - img[c0 + 2]), Math.abs(img[i + 3] - img[c0 + 3])) <= tol;
    for (let yy = Math.max(0, Math.floor(y - r)); yy < Math.min(doc.height, y + r); yy++) {
      for (let xx = Math.max(0, Math.floor(x - r)); xx < Math.min(W, x + r); xx++) {
        if ((xx - x) ** 2 + (yy - y) ** 2 <= r * r && near((yy * W + xx) * 4)) s.mask[yy * W + xx] = 255;
      }
    }
    this.preview = Selection.fromMask(doc.width, doc.height, s.mask);
  }
  onPointerMove(p, dragging) {
    if (dragging && this.stroke) this.paintQuick(Math.floor(p.x), Math.floor(p.y));
  }
  onPointerUp(p) {
    const s = this.stroke;
    this.stroke = null;
    this.preview = null;
    if (!s || p.cancelled) return;
    const doc = this.doc;
    const sel = Selection.fromMask(doc.width, doc.height, s.mask);
    applySelection(this.app, sel, s.replace && !(doc.selection && !doc.selection.isEmpty) ? 'replace' : s.mode, 'Quick selection');
  }
  drawOverlay(ctx, view) {
    if (this.kind !== 'quick') return;
    if (this.preview) {
      const m = view.matrix();
      ctx.save();
      ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
      ctx.strokeStyle = '#4f81ff';
      ctx.lineWidth = 1 / view.zoom;
      ctx.stroke(this.preview.path2d());
      ctx.restore();
    }
    if (view.pointer) {
      const p = view.toScreen(view.pointer.x, view.pointer.y);
      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, ((this.opt('size') ?? 30) * view.zoom) / 2, 0, Math.PI * 2);
      ctx.strokeStyle = '#000';
      ctx.stroke();
      ctx.restore();
    }
  }
}

export function install(app) {
  const t = app.tools;
  t.register(new MarqueeTool(app, 'rect'), 'marquee');
  t.register(new MarqueeTool(app, 'ellipse'), 'marquee');
  t.register(new MarqueeTool(app, 'row'), 'marquee');
  t.register(new MarqueeTool(app, 'column'), 'marquee');
  t.register(new LassoTool(app, 'free'), 'lasso');
  t.register(new LassoTool(app, 'polygon'), 'lasso');
  t.register(new LassoTool(app, 'magnetic'), 'lasso');
  t.register(new WandTool(app, 'quick'), 'wand');
  t.register(new WandTool(app, 'wand'), 'wand');
}
