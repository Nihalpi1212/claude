// Navigation tools: hand (pan), rotate view, zoom; and the eyedropper / colour sampler.
import { Tool } from '../tools.js';
import { flattenDocument } from '../compositor.js';
import { rgbaToHex } from '../../../shared/pixels/color.js';

export class HandTool extends Tool {
  constructor(app) {
    super(app, { id: 'hand', name: 'Hand Tool', icon: 'hand', cursor: 'grab', hint: 'Drag to scroll. Hold Space with any tool to pan temporarily. Double-click to fit the image.', options: [{ kind: 'button', key: 'fit', label: 'Fit on screen', onClick: (t) => t.app.commands.run('view:zoom-fit') }, { kind: 'button', key: 'actual', label: '100%', onClick: (t) => t.app.commands.run('view:zoom-100') }, { kind: 'button', key: 'fill', label: 'Fill screen', onClick: (t) => t.app.commands.run('view:zoom-fill') }] });
    this.last = null;
  }
  onPointerDown(p) {
    this.last = { x: p.screenX, y: p.screenY };
    this.view.setCursor('grabbing');
  }
  onPointerMove(p, dragging) {
    if (!dragging || !this.last) return;
    this.view.panBy(p.screenX - this.last.x, p.screenY - this.last.y);
    this.last = { x: p.screenX, y: p.screenY };
  }
  onPointerUp() {
    this.last = null;
    this.view?.setCursor('grab');
  }
  onDoubleClick() {
    this.view.zoomToFit();
  }
}

export class RotateViewTool extends Tool {
  constructor(app) {
    super(app, { id: 'rotate-view', name: 'Rotate View Tool', icon: 'rotate-view', cursor: 'grab', hint: 'Drag to rotate the view (the image itself is not changed). Esc or the Reset button restores it.', options: [{ kind: 'number', key: 'angle', label: 'Angle', min: -180, max: 180, default: 0, unit: '°' }, { kind: 'button', key: 'reset', label: 'Reset view', onClick: (t) => t.view?.setRotation(0) }] });
    this.start = null;
  }
  onPointerDown(p) {
    const cx = this.view.cssWidth / 2, cy = this.view.cssHeight / 2;
    this.start = { angle: Math.atan2(p.screenY - cy, p.screenX - cx), rotation: this.view.rotation };
  }
  onPointerMove(p, dragging) {
    if (!dragging || !this.start) return;
    const cx = this.view.cssWidth / 2, cy = this.view.cssHeight / 2;
    const a = Math.atan2(p.screenY - cy, p.screenX - cx);
    let deg = this.start.rotation + ((a - this.start.angle) * 180) / Math.PI;
    if (p.shift) deg = Math.round(deg / 15) * 15;
    this.view.setRotation(deg);
    this.setOpt('angle', Math.round(((this.view.rotation + 180) % 360) - 180));
  }
  onPointerUp() {
    this.start = null;
  }
  onOptionChanged(key, value) {
    if (key === 'angle') this.view?.setRotation(value);
  }
  cancel() {
    this.view?.setRotation(0);
    return true;
  }
}

export class ZoomTool extends Tool {
  constructor(app) {
    super(app, { id: 'zoom', name: 'Zoom Tool', icon: 'zoom', cursor: 'zoom-in', hint: 'Click to zoom in, Alt-click to zoom out, drag to zoom into an area.', options: [{ kind: 'segment', key: 'direction', label: '', options: [['in', 'Zoom in', 'zoom-in'], ['out', 'Zoom out', 'zoom-out']], default: 'in' }, { kind: 'button', key: 'fit', label: 'Fit on screen', onClick: (t) => t.app.commands.run('view:zoom-fit') }, { kind: 'button', key: 'actual', label: '100%', onClick: (t) => t.app.commands.run('view:zoom-100') }, { kind: 'checkbox', key: 'scrubby', label: 'Scrubby zoom', default: true }] });
    this.drag = null;
  }
  get cursorStyle() {
    return this.opt('direction') === 'out' ? 'zoom-out' : 'zoom-in';
  }
  onPointerDown(p) {
    this.drag = { start: p, last: p, moved: false, zoom: this.view.zoom };
  }
  onPointerMove(p, dragging) {
    if (!dragging || !this.drag) return;
    const dx = p.screenX - this.drag.start.screenX;
    if (Math.abs(dx) > 3) this.drag.moved = true;
    if (this.opt('scrubby') !== false && this.drag.moved) {
      this.view.setZoom(this.drag.zoom * Math.exp(dx / 120), { x: this.drag.start.screenX, y: this.drag.start.screenY });
    }
    this.drag.last = p;
  }
  onPointerUp(p) {
    const d = this.drag;
    this.drag = null;
    if (!d || p.cancelled) return;
    if (d.moved && this.opt('scrubby') !== false) return;
    if (d.moved) {
      // marquee zoom
      const x1 = Math.min(d.start.x, p.x), y1 = Math.min(d.start.y, p.y), w = Math.abs(p.x - d.start.x), h = Math.abs(p.y - d.start.y);
      if (w > 2 && h > 2) {
        const z = Math.min(this.view.cssWidth / w, this.view.cssHeight / h);
        this.view.zoom = Math.min(64, z);
        const c = this.view.toScreen(x1 + w / 2, y1 + h / 2);
        this.view.panBy(this.view.cssWidth / 2 - c.x, this.view.cssHeight / 2 - c.y);
        return;
      }
    }
    const out = this.opt('direction') === 'out' ? !p.alt : p.alt;
    this.view.zoomStep(out ? -1 : 1, { x: p.screenX, y: p.screenY });
  }
  drawOverlay(ctx, view) {
    const d = this.drag;
    if (!d || !d.moved || this.opt('scrubby') !== false) return;
    const a = view.toScreen(d.start.x, d.start.y), b = view.toScreen(d.last.x, d.last.y);
    ctx.save();
    ctx.strokeStyle = '#4f81ff';
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x, b.y - a.y);
    ctx.restore();
  }
}

export class EyedropperTool extends Tool {
  constructor(app) {
    super(app, {
      id: 'eyedropper',
      name: 'Eyedropper Tool',
      icon: 'eyedropper',
      cursor: 'crosshair',
      hint: 'Click to set the foreground colour, Alt-click for the background colour.',
      options: [
        { kind: 'select', key: 'sample', label: 'Sample size', options: [['1', 'Point sample'], ['3', '3 × 3 average'], ['5', '5 × 5 average'], ['11', '11 × 11 average'], ['31', '31 × 31 average']], default: '3' },
        { kind: 'select', key: 'source', label: 'Sample', options: [['merged', 'All layers'], ['layer', 'Current layer']], default: 'merged' },
        { kind: 'checkbox', key: 'showRing', label: 'Show sampling ring', default: true },
      ],
    });
    this.ring = null;
  }
  /** Average colour under a document point. Returns [r,g,b,a(0..1)]. */
  sampleAt(p, { setForeground = true, setBackground = false } = {}) {
    const doc = this.doc;
    if (!doc) return null;
    const n = Number(this.opt('sample') ?? 3);
    const half = Math.floor(n / 2);
    let canvas, ox = 0, oy = 0;
    if (this.opt('source') === 'layer' && doc.active && !doc.active.isGroup) {
      const src = doc.active.type === 'raster' ? { canvas: doc.active.canvas, x: doc.active.x, y: doc.active.y } : doc.active.render?.();
      if (!src) return null;
      canvas = src.canvas;
      ox = src.x;
      oy = src.y;
    } else canvas = flattenDocument(doc, this.view.compositor);
    const x = Math.floor(p.x) - ox - half, y = Math.floor(p.y) - oy - half;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const x1 = Math.max(0, x), y1 = Math.max(0, y), x2 = Math.min(canvas.width, x + n), y2 = Math.min(canvas.height, y + n);
    if (x2 <= x1 || y2 <= y1) return null;
    const d = ctx.getImageData(x1, y1, x2 - x1, y2 - y1).data;
    let r = 0, g = 0, b = 0, a = 0, w = 0;
    for (let i = 0; i < d.length; i += 4) {
      const al = d[i + 3] / 255;
      r += d[i] * al;
      g += d[i + 1] * al;
      b += d[i + 2] * al;
      a += al;
      w++;
    }
    if (!w) return null;
    const color = a > 0 ? [r / a, g / a, b / a, a / w] : [0, 0, 0, 0];
    const hex = rgbaToHex(color);
    // the ring shows the colour before this drag started next to the sampled one
    const previous = this.ring?.previous ?? (setBackground ? this.app.settings.background : this.app.settings.foreground);
    if (setBackground) this.app.setColors({ background: hex });
    else if (setForeground) this.app.setColors({ foreground: hex });
    this.ring = { color: hex, previous };
    this.app.statusbar.set('hint', `${hex}  R ${Math.round(color[0])} G ${Math.round(color[1])} B ${Math.round(color[2])}`);
    return color;
  }
  onPointerDown(p) {
    this.sampleAt(p, { setForeground: !p.alt, setBackground: p.alt });
  }
  onPointerMove(p, dragging) {
    if (dragging) this.sampleAt(p, { setForeground: !p.alt, setBackground: p.alt });
  }
  onPointerUp() {
    this.ring = null;
  }
  drawOverlay(ctx, view) {
    if (!this.ring || !view.pointer || this.opt('showRing') === false) return;
    const p = view.toScreen(view.pointer.x, view.pointer.y);
    ctx.save();
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 40, Math.PI, Math.PI * 2);
    ctx.strokeStyle = this.ring.color;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 40, 0, Math.PI);
    ctx.strokeStyle = this.ring.previous;
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 47, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 33, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

export class ColorSamplerTool extends Tool {
  constructor(app) {
    super(app, { id: 'color-sampler', name: 'Color Sampler Tool', icon: 'color-sampler', cursor: 'crosshair', hint: 'Click to place up to 8 colour samplers; their values show in the Info panel. Alt-click a sampler to remove it.', options: [{ kind: 'button', key: 'clear', label: 'Clear samplers', onClick: (t) => { t.doc.samplers = []; t.view?.invalidate(); t.app.emit('samplers:changed', t.doc); } }] });
  }
  onPointerDown(p) {
    const doc = this.doc;
    doc.samplers ??= [];
    const hit = doc.samplers.findIndex((s) => Math.hypot(s.x - p.x, s.y - p.y) * this.view.zoom < 10);
    if (hit >= 0) {
      if (p.alt) doc.samplers.splice(hit, 1);
      else this.dragIndex = hit;
    } else if (doc.samplers.length < 8) doc.samplers.push({ x: Math.floor(p.x), y: Math.floor(p.y) });
    this.app.emit('samplers:changed', doc);
  }
  onPointerMove(p, dragging) {
    if (dragging && this.dragIndex !== undefined && this.dragIndex !== null) {
      this.doc.samplers[this.dragIndex] = { x: Math.floor(p.x), y: Math.floor(p.y) };
      this.app.emit('samplers:changed', this.doc);
    }
  }
  onPointerUp() {
    this.dragIndex = null;
  }
  drawOverlay(ctx, view) {
    for (const [i, s] of (this.doc?.samplers ?? []).entries()) {
      const p = view.toScreen(s.x + 0.5, s.y + 0.5);
      ctx.save();
      ctx.strokeStyle = '#000';
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#000';
      ctx.font = '10px system-ui';
      ctx.fillText(String(i + 1), p.x + 8, p.y + 4);
      ctx.restore();
    }
  }
}

export class RulerTool extends Tool {
  constructor(app) {
    super(app, { id: 'ruler', name: 'Ruler Tool', icon: 'ruler', cursor: 'crosshair', hint: 'Drag to measure a distance and angle.', options: [{ kind: 'button', key: 'straighten', label: 'Straighten layer', onClick: (t) => t.straighten() }, { kind: 'button', key: 'clear', label: 'Clear', onClick: (t) => { t.line = null; t.view?.invalidate(); } }] });
    this.line = null;
  }
  onPointerDown(p) {
    this.line = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
  }
  onPointerMove(p, dragging) {
    if (!dragging || !this.line) return;
    this.line.x2 = p.x;
    this.line.y2 = p.y;
    const dx = this.line.x2 - this.line.x1, dy = this.line.y2 - this.line.y1;
    this.app.statusbar.set('hint', `Length ${Math.hypot(dx, dy).toFixed(1)} px   Angle ${((Math.atan2(-dy, dx) * 180) / Math.PI).toFixed(1)}°   ΔX ${dx.toFixed(0)}  ΔY ${dy.toFixed(0)}`);
  }
  straighten() {
    if (!this.line) return;
    const dx = this.line.x2 - this.line.x1, dy = this.line.y2 - this.line.y1;
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    this.app.commands.run('image:rotate', { angle: -angle, layerOnly: true });
  }
  drawOverlay(ctx, view) {
    if (!this.line) return;
    const a = view.toScreen(this.line.x1, this.line.y1), b = view.toScreen(this.line.x2, this.line.y2);
    ctx.save();
    ctx.strokeStyle = '#4f81ff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    for (const q of [a, b]) {
      ctx.beginPath();
      ctx.arc(q.x, q.y, 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
}

export function install(app) {
  const t = app.tools;
  t.register(new EyedropperTool(app), 'eyedropper');
  t.register(new ColorSamplerTool(app), 'eyedropper');
  t.register(new RulerTool(app), 'eyedropper');
  t.register(new HandTool(app), 'hand');
  t.register(new RotateViewTool(app), 'hand');
  t.register(new ZoomTool(app), 'zoom');
}
