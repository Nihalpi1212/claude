// Paint bucket and gradient tools.
import { Tool } from '../tools.js';
import { Selection } from '../selection.js';
import { selectionOps } from '../selection.js';
import { flattenDocument } from '../compositor.js';
import { createCanvas, makeGradient } from '../document.js';
import { BLEND_MODES } from '../document.js';
import { drawBlended, drawOnMask } from '../brush.js';

const BLEND_OPTIONS = BLEND_MODES.filter(Boolean).filter(([id]) => id !== 'dissolve').map(([id, label]) => [id, label]);

export const GRADIENT_PRESETS = [
  { name: 'Foreground to background', stops: 'fgbg' },
  { name: 'Foreground to transparent', stops: 'fgt' },
  { name: 'Black to white', stops: [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }] },
  { name: 'Spectrum', stops: [{ pos: 0, color: '#ff0000' }, { pos: 0.17, color: '#ffff00' }, { pos: 0.33, color: '#00ff00' }, { pos: 0.5, color: '#00ffff' }, { pos: 0.67, color: '#0000ff' }, { pos: 0.83, color: '#ff00ff' }, { pos: 1, color: '#ff0000' }] },
  { name: 'Sunset', stops: [{ pos: 0, color: '#2b1055' }, { pos: 0.5, color: '#ff7e5f' }, { pos: 1, color: '#feb47b' }] },
  { name: 'Ocean', stops: [{ pos: 0, color: '#003973' }, { pos: 1, color: '#e5e5be' }] },
  { name: 'Copper', stops: [{ pos: 0, color: '#97451f' }, { pos: 0.5, color: '#ffd1a3' }, { pos: 1, color: '#6b2d0f' }] },
  { name: 'Chrome', stops: [{ pos: 0, color: '#8ca0b4' }, { pos: 0.5, color: '#ffffff' }, { pos: 0.51, color: '#5a6b7c' }, { pos: 1, color: '#c4d4e4' }] },
];

export function resolveStops(preset, fg, bg) {
  if (preset.stops === 'fgbg') return [{ pos: 0, color: fg }, { pos: 1, color: bg }];
  if (preset.stops === 'fgt') return [{ pos: 0, color: fg }, { pos: 1, color: fg + '00' }];
  return preset.stops;
}

export class BucketTool extends Tool {
  constructor(app) {
    super(app, {
      id: 'bucket',
      name: 'Paint Bucket Tool',
      icon: 'bucket',
      cursor: 'crosshair',
      hint: 'Click to fill similar pixels with the foreground colour (Alt: background colour).',
      options: [
        { kind: 'select', key: 'source', label: 'Fill', options: [['foreground', 'Foreground colour'], ['pattern', 'Pattern']], default: 'foreground' },
        { kind: 'select', key: 'blend', label: 'Mode', options: BLEND_OPTIONS, default: 'normal' },
        { kind: 'slider', key: 'opacity', label: 'Opacity', min: 0.01, max: 1, step: 0.01, default: 1 },
        { kind: 'number', key: 'tolerance', label: 'Tolerance', min: 0, max: 255, default: 32 },
        { kind: 'checkbox', key: 'antialias', label: 'Anti-alias', default: true },
        { kind: 'checkbox', key: 'contiguous', label: 'Contiguous', default: true },
        { kind: 'checkbox', key: 'sampleMerged', label: 'All layers', default: false },
      ],
    });
  }
  onPointerDown(p) {
    const doc = this.doc;
    const layer = this.paintableLayer();
    if (!layer) return;
    if (layer.type !== 'raster' && !(this.app.ui.editingMask && layer.mask)) {
      this.app.rasterizePrompt(layer).then((ok) => ok && this.onPointerDown(p));
      return;
    }
    const x = Math.floor(p.x), y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
    // sample image (merged or the layer in document space)
    let img;
    const mask = this.app.ui.editingMask && layer.mask?.canvas;
    if (mask) img = layer.mask.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, doc.width, doc.height);
    else if (this.opt('sampleMerged')) img = flattenDocument(doc, this.view.compositor).getContext('2d', { willReadFrequently: true }).getImageData(0, 0, doc.width, doc.height);
    else {
      const tmp = createCanvas(doc.width, doc.height);
      tmp.getContext('2d').drawImage(layer.canvas, layer.x, layer.y);
      img = tmp.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, doc.width, doc.height);
    }
    let region = selectionOps.floodFill(img, x, y, { tolerance: this.opt('tolerance') ?? 32, contiguous: this.opt('contiguous') !== false, antialias: this.opt('antialias') !== false });
    if (doc.selection && !doc.selection.isEmpty) region = selectionOps.combineMasks(region, doc.selection.mask, 'intersect');
    const sel = Selection.fromMask(doc.width, doc.height, region);
    const b = sel.bounds;
    if (!b) return;
    const color = p.alt ? this.app.settings.background : this.app.settings.foreground;
    if (!mask) layer.ensureCovers(b); // may replace layer.canvas: build the target after it
    const target = mask ? { canvas: layer.mask.canvas, x: 0, y: 0 } : { canvas: layer.canvas, x: layer.x, y: layer.y };
    const local = { x: b.x - target.x, y: b.y - target.y, width: b.width, height: b.height };
    doc.history.pixels('Paint bucket', target.canvas, local, (ctx) => {
      const fillCanvas = createCanvas(b.width, b.height);
      const fctx = fillCanvas.getContext('2d');
      if (this.opt('source') === 'pattern' && this.app.currentPattern) {
        fctx.fillStyle = fctx.createPattern(this.app.currentPattern, 'repeat');
      } else fctx.fillStyle = color;
      fctx.fillRect(0, 0, b.width, b.height);
      fctx.globalCompositeOperation = 'destination-in';
      fctx.drawImage(sel.toCanvas(), -b.x, -b.y);
      if (mask) drawOnMask(ctx, fillCanvas, local.x, local.y, this.opt('opacity') ?? 1);
      else drawBlended(ctx, fillCanvas, local.x, local.y, this.opt('blend') ?? 'normal', this.opt('opacity') ?? 1, { lockTransparency: !!layer.locked.transparency });
    }, { layer, kind: mask ? 'mask' : 'pixels' });
  }
}

export class GradientTool extends Tool {
  constructor(app) {
    super(app, {
      id: 'gradient',
      name: 'Gradient Tool',
      icon: 'gradient',
      cursor: 'crosshair',
      hint: 'Drag to draw a gradient from the foreground to the background colour (Shift constrains the angle).',
      options: [
        { kind: 'select', key: 'preset', label: 'Gradient', options: GRADIENT_PRESETS.map((g, i) => [String(i), g.name]), default: '0' },
        { kind: 'segment', key: 'kind', label: '', options: [['linear', 'Linear', 'grad-linear'], ['radial', 'Radial', 'grad-radial'], ['angle', 'Angle', 'grad-angle'], ['reflected', 'Reflected', 'grad-reflected'], ['diamond', 'Diamond', 'grad-diamond']], default: 'linear' },
        { kind: 'select', key: 'blend', label: 'Mode', options: BLEND_OPTIONS, default: 'normal' },
        { kind: 'slider', key: 'opacity', label: 'Opacity', min: 0.01, max: 1, step: 0.01, default: 1 },
        { kind: 'checkbox', key: 'reverse', label: 'Reverse', default: false },
        { kind: 'checkbox', key: 'dither', label: 'Dither', default: true },
        { kind: 'checkbox', key: 'transparency', label: 'Transparency', default: true },
      ],
    });
    this.drag = null;
  }
  stops() {
    const preset = GRADIENT_PRESETS[Number(this.opt('preset') ?? 0)] ?? GRADIENT_PRESETS[0];
    let stops = resolveStops(preset, this.app.settings.foreground, this.app.settings.background);
    if (this.opt('transparency') === false) stops = stops.map((s) => ({ pos: s.pos, color: s.color.slice(0, 7) }));
    return stops;
  }
  onPointerDown(p) {
    const layer = this.paintableLayer();
    if (!layer) return;
    if (layer.type !== 'raster' && !(this.app.ui.editingMask && layer.mask)) {
      this.app.rasterizePrompt(layer); // a gradient is a drag: start it again once rasterized
      return;
    }
    this.drag = { from: { x: p.x, y: p.y }, to: { x: p.x, y: p.y }, layer };
  }
  onPointerMove(p, dragging) {
    if (!dragging || !this.drag) return;
    let to = { x: p.x, y: p.y };
    if (p.shift) {
      const dx = to.x - this.drag.from.x, dy = to.y - this.drag.from.y;
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      to = { x: this.drag.from.x + Math.cos(ang) * len, y: this.drag.from.y + Math.sin(ang) * len };
    }
    this.drag.to = to;
  }
  onPointerUp(p) {
    const d = this.drag;
    this.drag = null;
    if (!d || p.cancelled) return;
    const doc = this.doc;
    const layer = d.layer;
    const mask = this.app.ui.editingMask && layer.mask?.canvas;
    const sel = doc.selection && !doc.selection.isEmpty ? doc.selection : null;
    const area = sel ? sel.bounds : doc.bounds;
    if (!mask) layer.ensureCovers(area); // may replace layer.canvas: build the target after it
    const target = mask ? { canvas: layer.mask.canvas, x: 0, y: 0 } : { canvas: layer.canvas, x: layer.x, y: layer.y };
    const local = { x: area.x - target.x, y: area.y - target.y, width: area.width, height: area.height };
    const g = { kind: this.opt('kind') ?? 'linear', stops: this.stops(), from: [d.from.x, d.from.y], to: [d.to.x, d.to.y], reverse: !!this.opt('reverse') };
    if (Math.hypot(d.to.x - d.from.x, d.to.y - d.from.y) < 1) g.to = [d.from.x + 1, d.from.y];
    doc.history.pixels('Gradient', target.canvas, local, (ctx) => {
      const fill = createCanvas(area.width, area.height);
      const fctx = fill.getContext('2d');
      fctx.translate(-area.x, -area.y);
      fctx.fillStyle = makeGradient(fctx, g, area);
      fctx.fillRect(area.x, area.y, area.width, area.height);
      fctx.setTransform(1, 0, 0, 1, 0, 0);
      if (this.opt('dither') !== false) dither(fill);
      if (sel) {
        fctx.globalCompositeOperation = 'destination-in';
        fctx.drawImage(sel.toCanvas(), -area.x, -area.y);
      }
      if (mask) drawOnMask(ctx, fill, local.x, local.y, this.opt('opacity') ?? 1);
      else drawBlended(ctx, fill, local.x, local.y, this.opt('blend') ?? 'normal', this.opt('opacity') ?? 1, { lockTransparency: !!layer.locked.transparency });
    }, { layer, kind: mask ? 'mask' : 'pixels' });
  }
  cancel() {
    if (this.drag) {
      this.drag = null;
      return true;
    }
    return false;
  }
  drawOverlay(ctx, view) {
    if (!this.drag) return;
    const a = view.toScreen(this.drag.from.x, this.drag.from.y), b = view.toScreen(this.drag.to.x, this.drag.to.y);
    ctx.save();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }
}

/** Adds ±1 ordered noise to break 8-bit banding. */
function dither(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const w = canvas.width;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const x = p % w, y = (p / w) | 0;
    const n = (((x & 1) + ((y & 1) << 1)) % 4) - 1.5; // -1.5..1.5
    d[i] = Math.min(255, Math.max(0, d[i] + n));
    d[i + 1] = Math.min(255, Math.max(0, d[i + 1] + n));
    d[i + 2] = Math.min(255, Math.max(0, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
}

export function install(app) {
  app.tools.register(new GradientTool(app), 'fill');
  app.tools.register(new BucketTool(app), 'fill');
}
