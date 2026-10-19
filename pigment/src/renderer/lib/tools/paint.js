// Painting tools: brush, pencil, eraser (and the shared stroke plumbing used by clone/heal/retouch).
import { Tool, BRUSH_OPTIONS } from '../tools.js';
import { BrushStroke } from '../brush.js';
import { BLEND_MODES } from '../document.js';

const BLEND_OPTIONS = BLEND_MODES.filter(Boolean).filter(([id]) => id !== 'dissolve').map(([id, label]) => [id, label]);

/** Common pointer plumbing for dab-based tools. Subclasses implement strokeSettings(point). */
export class StrokeTool extends Tool {
  constructor(app, def) {
    super(app, { cursor: 'none', ...def });
    this.stroke = null;
  }
  get cursorStyle() {
    return this.app.settings.cursorStyle === 'precise' ? 'crosshair' : 'none';
  }
  /** Target canvas: the active layer's mask when mask editing is on, else the layer canvas. */
  strokeTarget(layer) {
    if (this.app.ui.editingMask && layer.mask?.canvas) return { canvas: layer.mask.canvas, x: 0, y: 0, mask: true };
    return { canvas: layer.canvas, x: layer.x, y: layer.y, mask: false };
  }
  ensureCoverage(layer, point) {
    if (this.app.ui.editingMask && layer.mask?.canvas) return;
    if (layer.type !== 'raster') return;
    const size = this.opt('size') ?? 24;
    const r = { x: point.x - size, y: point.y - size, width: size * 2, height: size * 2 };
    // keep painting inside the document bounds only (layers never need to exceed the canvas)
    const d = this.doc.bounds;
    const clipped = { x: Math.max(d.x, r.x), y: Math.max(d.y, r.y), width: Math.min(d.x + d.width, r.x + r.width) - Math.max(d.x, r.x), height: Math.min(d.y + d.height, r.y + r.height) - Math.max(d.y, r.y) };
    if (clipped.width > 0 && clipped.height > 0) layer.ensureCovers(clipped);
  }
  onPointerDown(p) {
    const layer = this.paintableLayer();
    if (!layer) return;
    if (layer.type !== 'raster' && !(this.app.ui.editingMask && layer.mask)) {
      this.app.rasterizePrompt(layer).then((ok) => ok && this.onPointerDown(p));
      return;
    }
    this.ensureCoverage(layer, p);
    const target = this.strokeTarget(layer);
    const settings = this.strokeSettings(p, layer, target);
    if (!settings) return;
    this.stroke = new BrushStroke({ target, layer, settings, selection: this.doc.selection?.isEmpty === false ? this.doc.selection : null, history: this.doc.history, onDirty: (rect) => this.view?.invalidate(rect) });
    this.stroke.begin(p);
  }
  onPointerMove(p, dragging) {
    if (dragging && this.stroke) {
      if (this.stroke.layer.type === 'raster' && !this.stroke.target.mask) {
        const before = { x: this.stroke.layer.x, y: this.stroke.layer.y, w: this.stroke.layer.canvas.width, h: this.stroke.layer.canvas.height };
        this.ensureCoverage(this.stroke.layer, p);
        const l = this.stroke.layer;
        if (l.canvas !== this.stroke.canvas) {
          // the layer canvas grew: migrate the stroke buffers to the new geometry
          this.stroke.migrate({ canvas: l.canvas, x: l.x, y: l.y }, before);
        }
      }
      this.stroke.extend(p);
    }
  }
  onPointerUp() {
    if (!this.stroke) return;
    this.stroke.end();
    this.stroke = null;
  }
  cancel() {
    if (this.stroke) {
      this.stroke.cancel();
      this.stroke = null;
      return true;
    }
    return false;
  }
  drawOverlay(ctx, view) {
    if (!view.pointer || this.app.settings.cursorStyle === 'precise') return;
    const size = (this.opt('size') ?? 24) * view.zoom;
    const p = view.toScreen(view.pointer.x, view.pointer.y);
    ctx.save();
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (this.app.settings.cursorStyle === 'dot' || size < 4) {
      ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
      ctx.fillStyle = '#000';
      ctx.fill();
    } else {
      ctx.arc(p.x, p.y, size / 2, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, p.y, size / 2 + 1, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.stroke();
    }
    ctx.restore();
  }
  baseSettings(layer, target) {
    const s = this.app.settings;
    const maskValue = this.app.ui.editingMask ? luminanceOf(s.foreground) : 1;
    return {
      size: this.opt('size') ?? 24,
      hardness: this.opt('hardness') ?? 0.8,
      opacity: this.opt('opacity') ?? 1,
      flow: this.opt('flow') ?? 1,
      smoothing: this.opt('smoothing') ?? 0.2,
      spacing: s.brush?.spacing ?? 0.12,
      pressureSize: this.opt('pressureSize') ?? true,
      pressureOpacity: this.opt('pressureOpacity') ?? false,
      blend: this.opt('blend') ?? 'normal',
      color: s.foreground,
      mode: target.mask ? 'mask' : 'paint',
      maskValue,
      lockTransparency: !target.mask && (layer.locked.transparency || this.opt('lockAlpha')),
    };
  }
}

function luminanceOf(hex) {
  const n = parseInt(String(hex).slice(1, 7), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

// migrate strokes when the layer canvas grows (new canvas + offset)
BrushStroke.prototype.migrate = function migrate(target, before) {
  const dx = before.x - target.x, dy = before.y - target.y; // old canvas origin inside the new canvas
  const grow = (old) => {
    const c = document.createElement('canvas');
    c.width = target.canvas.width;
    c.height = target.canvas.height;
    c.getContext('2d').drawImage(old, dx, dy);
    return c;
  };
  this.buffer = grow(this.buffer);
  this.bctx = this.buffer.getContext('2d');
  this.backup = grow(this.backup);
  if (this.history.stroke) {
    this.history.stroke.canvas = target.canvas;
    this.history.stroke.backup = this.backup;
  }
  if (this.last) {
    this.last.x += dx;
    this.last.y += dy;
  }
  if (this.smoothed) {
    this.smoothed.x += dx;
    this.smoothed.y += dy;
  }
  const shift = (r) => (r ? { x: r.x + dx, y: r.y + dy, width: r.width, height: r.height } : r);
  this.dirty = shift(this.dirty);
  this.frameDirty = shift(this.frameDirty);
  this.canvas = target.canvas;
  this.target = target;
};

export class BrushTool extends StrokeTool {
  constructor(app) {
    super(app, {
      id: 'brush',
      name: 'Brush Tool',
      icon: 'brush',
      hint: 'Paint with the foreground colour. [ and ] change the size, Shift+[ ] the hardness. Alt-click samples a colour.',
      options: [...BRUSH_OPTIONS, { kind: 'select', key: 'blend', label: 'Mode', options: BLEND_OPTIONS, default: 'normal' }, { kind: 'checkbox', key: 'lockAlpha', label: 'Lock alpha', default: false }],
    });
  }
  onPointerDown(p) {
    if (p.alt) return this.app.tools.get('eyedropper')?.sampleAt(p, { setForeground: true });
    super.onPointerDown(p);
  }
  strokeSettings(p, layer, target) {
    return { ...this.baseSettings(layer, target), label: 'Brush' };
  }
}

export class PencilTool extends StrokeTool {
  constructor(app) {
    super(app, {
      id: 'pencil',
      name: 'Pencil Tool',
      icon: 'pencil',
      hint: 'Hard-edged, aliased strokes in the foreground colour.',
      options: [
        { kind: 'slider', key: 'size', label: 'Size', min: 1, max: 500, step: 1, default: 3, unit: 'px' },
        { kind: 'slider', key: 'opacity', label: 'Opacity', min: 0.01, max: 1, step: 0.01, default: 1 },
        { kind: 'select', key: 'blend', label: 'Mode', options: BLEND_OPTIONS, default: 'normal' },
        { kind: 'checkbox', key: 'autoErase', label: 'Auto erase', default: false },
      ],
    });
  }
  onPointerDown(p) {
    if (p.alt) return this.app.tools.get('eyedropper')?.sampleAt(p, { setForeground: true });
    super.onPointerDown(p);
  }
  strokeSettings(p, layer, target) {
    const base = this.baseSettings(layer, target);
    let color = base.color;
    if (this.opt('autoErase') && layer.type === 'raster' && !target.mask) {
      const px = layer.ctx.getImageData(Math.floor(p.x - layer.x), Math.floor(p.y - layer.y), 1, 1).data;
      const fg = parseInt(this.app.settings.foreground.slice(1, 7), 16);
      if (px[3] > 0 && ((px[0] << 16) | (px[1] << 8) | px[2]) === fg) color = this.app.settings.background;
    }
    return { ...base, color, hardness: 1, flow: 1, smoothing: 0, antialias: false, pressureSize: false, label: 'Pencil' };
  }
}

export class EraserTool extends StrokeTool {
  constructor(app) {
    super(app, {
      id: 'eraser',
      name: 'Eraser Tool',
      icon: 'eraser',
      hint: 'Erase to transparency (or to the background colour on a locked background layer).',
      options: [
        ...BRUSH_OPTIONS.filter((o) => o.key !== 'pressureOpacity'),
        { kind: 'select', key: 'mode', label: 'Mode', options: [['brush', 'Brush'], ['pencil', 'Pencil'], ['block', 'Block']], default: 'brush' },
        { kind: 'checkbox', key: 'eraseToHistory', label: 'Erase to original', default: false },
      ],
    });
  }
  strokeSettings(p, layer, target) {
    const base = this.baseSettings(layer, target);
    const mode = this.opt('mode');
    const s = { ...base, label: 'Eraser' };
    if (target.mask) {
      s.mode = 'mask';
      s.maskValue = 0; // erasing a mask paints black (hide)
      return s;
    }
    if (layer.locked.transparency || this.opt('eraseToBackground')) {
      s.mode = 'paint';
      s.color = this.app.settings.background;
      s.blend = 'normal';
    } else s.mode = 'erase';
    if (mode === 'pencil' || mode === 'block') Object.assign(s, { hardness: 1, antialias: false, flow: 1, smoothing: 0 });
    if (mode === 'block') Object.assign(s, { size: 16, pressureSize: false });
    return s;
  }
}

export function install(app) {
  const t = app.tools;
  t.register(new BrushTool(app), 'brush');
  t.register(new PencilTool(app), 'brush');
  t.register(new EraserTool(app), 'eraser');
}
