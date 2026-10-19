// Brush engine (see ARCHITECTURE.md "Brush engine"): dabs along a smoothed path into a stroke
// buffer, composited onto the target with opacity/flow/blend, clipped by the selection.
import { CANVAS_BLEND } from '../../shared/pixels/blend.js';
import { createCanvas } from './document.js';
import { parseColor, rgbaToHex } from '../../shared/pixels/color.js';

const dabCache = new Map();

/** A soft or hard round dab canvas of the given diameter (cached). */
export function dabCanvas(size, hardness, color = '#000000') {
  const d = Math.max(1, Math.ceil(size));
  const key = `${d}|${Math.round(hardness * 100)}|${color}`;
  let c = dabCache.get(key);
  if (c) return c;
  const pad = 1;
  c = createCanvas(d + pad * 2, d + pad * 2);
  const ctx = c.getContext('2d');
  const r = d / 2;
  const cx = r + pad, cy = r + pad;
  const [cr, cg, cb] = parseColor(color);
  const rgb = `${Math.round(cr)},${Math.round(cg)},${Math.round(cb)}`;
  if (d <= 2) {
    ctx.fillStyle = `rgb(${rgb})`;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  } else {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    const inner = Math.min(0.999, Math.max(0, hardness));
    // soft falloff: alpha 1 until inner radius, then smoothstep to 0 at the edge
    g.addColorStop(0, `rgba(${rgb},1)`);
    g.addColorStop(inner, `rgba(${rgb},1)`);
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const pos = inner + (1 - inner) * t;
      const a = 1 - (t * t * (3 - 2 * t));
      g.addColorStop(Math.min(1, pos), `rgba(${rgb},${a.toFixed(4)})`);
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);
  }
  if (dabCache.size > 200) dabCache.delete(dabCache.keys().next().value);
  dabCache.set(key, c);
  return c;
}

/**
 * One brush stroke.
 * target: { canvas, x, y } (document offset of the canvas), layer (for history/touch),
 * settings: { size, hardness, opacity, flow, spacing, smoothing, angle, roundness, pressureSize, pressureOpacity, blend, color, mode: 'paint'|'erase'|'mask', maskValue, antialias }
 */
export class BrushStroke {
  constructor({ target, layer, settings, selection = null, history, onDirty }) {
    this.target = target;
    this.layer = layer;
    this.s = { spacing: 0.12, smoothing: 0.2, blend: 'normal', mode: 'paint', antialias: true, ...settings };
    this.selection = selection;
    this.history = history;
    this.onDirty = onDirty;
    this.canvas = target.canvas;
    this.buffer = createCanvas(this.canvas.width, this.canvas.height);
    this.bctx = this.buffer.getContext('2d');
    this.backup = history.beginStroke(this.canvas, { label: settings.label ?? 'Brush', layer, kind: target.mask ? 'mask' : 'pixels' }).backup;
    this.last = null; // last dab position (canvas coords)
    this.smoothed = null;
    this.distance = 0;
    this.dirty = null;
    this.frameDirty = null;
    this.rafPending = false;
    this.ended = false;
    this.dabs = 0;
  }

  get composite() {
    const { mode, blend } = this.s;
    if (mode === 'erase') return 'destination-out';
    if (mode === 'mask') return this.s.maskValue >= 0.5 ? 'source-over' : 'destination-out';
    return CANVAS_BLEND[blend] ?? 'source-over';
  }

  /** Converts a document point to canvas-local coordinates. */
  local(p) {
    return { x: p.x - this.target.x, y: p.y - this.target.y, pressure: p.pressure ?? 1 };
  }

  begin(point) {
    const p = this.local(point);
    this.smoothed = { x: p.x, y: p.y };
    this.last = { x: p.x, y: p.y, pressure: p.pressure };
    this.dab(p.x, p.y, p.pressure);
    this.schedule();
  }

  extend(point) {
    if (this.ended) return;
    const raw = this.local(point);
    const k = 1 - Math.min(0.95, Math.max(0, this.s.smoothing));
    this.smoothed = { x: this.smoothed.x + (raw.x - this.smoothed.x) * k, y: this.smoothed.y + (raw.y - this.smoothed.y) * k };
    const p = { x: this.smoothed.x, y: this.smoothed.y, pressure: raw.pressure };
    const size = this.effectiveSize(p.pressure);
    const step = Math.max(0.5, size * this.s.spacing);
    let dx = p.x - this.last.x, dy = p.y - this.last.y;
    let dist = Math.hypot(dx, dy);
    if (dist < 1e-3) return;
    const nx = dx / dist, ny = dy / dist;
    let travelled = 0;
    // place dabs every `step` along the segment, carrying the leftover from the previous segment
    let first = step - this.distance;
    if (first <= 0) first = step;
    for (let t = first; t <= dist; t += step) {
      const u = t / dist;
      const pr = this.last.pressure + (p.pressure - this.last.pressure) * u;
      this.dab(this.last.x + nx * t, this.last.y + ny * t, pr);
      travelled = t;
    }
    this.distance = dist - travelled;
    this.last = { x: p.x, y: p.y, pressure: p.pressure };
    this.schedule();
  }

  effectiveSize(pressure) {
    const base = this.s.size;
    if (this.s.pressureSize && pressure !== undefined && pressure !== 1) return Math.max(1, base * Math.max(0.05, pressure));
    return base;
  }

  dab(x, y, pressure = 1) {
    const size = this.effectiveSize(pressure);
    let flow = this.s.flow;
    if (this.s.pressureOpacity && pressure !== undefined) flow *= Math.max(0.05, pressure);
    const color = this.s.mode === 'mask' ? '#ffffff' : this.s.mode === 'erase' ? '#000000' : rgbaToHex(parseColor(this.s.color));
    const ctx = this.bctx;
    const half = size / 2;
    const rx = this.s.roundness && this.s.roundness < 1 ? this.s.roundness : 1;
    ctx.save();
    ctx.globalAlpha = flow;
    ctx.globalCompositeOperation = 'source-over';
    if (this.s.sampler) {
      // clone/heal/pattern: the sampler paints the dab area, masked by a dab shape
      const dab = dabCanvas(size, this.s.hardness, '#000000');
      const tmp = createCanvas(dab.width, dab.height);
      const tctx = tmp.getContext('2d');
      this.s.sampler(tctx, x - half - 1, y - half - 1, tmp.width, tmp.height, { x, y, size });
      tctx.globalCompositeOperation = 'destination-in';
      tctx.drawImage(dab, 0, 0);
      ctx.drawImage(tmp, Math.round(x - half - 1), Math.round(y - half - 1));
    } else {
      const dab = dabCanvas(size, this.s.antialias === false ? 1 : this.s.hardness, color);
      ctx.imageSmoothingEnabled = this.s.antialias !== false;
      if (this.s.angle || rx !== 1) {
        ctx.translate(x, y);
        ctx.rotate(((this.s.angle ?? 0) * Math.PI) / 180);
        ctx.scale(1, rx);
        ctx.drawImage(dab, -dab.width / 2, -dab.height / 2);
      } else if (this.s.antialias === false) {
        ctx.drawImage(dab, Math.round(x - dab.width / 2), Math.round(y - dab.height / 2));
      } else ctx.drawImage(dab, x - dab.width / 2, y - dab.height / 2);
    }
    ctx.restore();
    const r = { x: Math.floor(x - half - 2), y: Math.floor(y - half - 2), width: Math.ceil(size) + 5, height: Math.ceil(size) + 5 };
    this.dirty = this.dirty ? union(this.dirty, r) : r;
    this.frameDirty = this.frameDirty ? union(this.frameDirty, r) : r;
    this.dabs++;
  }

  schedule() {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this.flush();
    });
  }

  /** Repaints the dirty part of the target: restore backup, then composite the buffer with opacity/blend. */
  flush(all = false) {
    const r = all ? this.dirty : this.frameDirty;
    this.frameDirty = null;
    if (!r) return;
    const rect = clip(r, this.canvas.width, this.canvas.height);
    if (!rect) return;
    const ctx = this.canvas.getContext('2d');
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.clip();
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(this.backup, rect.x, rect.y, rect.width, rect.height, rect.x, rect.y, rect.width, rect.height);
    ctx.globalCompositeOperation = this.composite;
    ctx.globalAlpha = this.s.opacity;
    let src = this.buffer;
    if (this.selection) {
      const tmp = createCanvas(rect.width, rect.height);
      const tctx = tmp.getContext('2d');
      tctx.drawImage(this.buffer, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
      tctx.globalCompositeOperation = 'destination-in';
      tctx.drawImage(this.selection.toCanvas(), -(rect.x + this.target.x), -(rect.y + this.target.y));
      ctx.drawImage(tmp, rect.x, rect.y);
    } else ctx.drawImage(src, rect.x, rect.y, rect.width, rect.height, rect.x, rect.y, rect.width, rect.height);
    if (this.s.lockTransparency) {
      ctx.globalCompositeOperation = 'destination-in';
      ctx.globalAlpha = 1;
      ctx.drawImage(this.backup, rect.x, rect.y, rect.width, rect.height, rect.x, rect.y, rect.width, rect.height);
    }
    ctx.restore();
    this.layer?.touch();
    this.onDirty?.({ x: rect.x + this.target.x, y: rect.y + this.target.y, width: rect.width, height: rect.height });
  }

  end() {
    if (this.ended) return null;
    this.ended = true;
    this.flush(true);
    return this.history.endStroke(this.dirty);
  }

  cancel() {
    if (this.ended) return;
    this.ended = true;
    this.history.cancelStroke();
  }
}

function union(a, b) {
  const x1 = Math.min(a.x, b.x), y1 = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.width, b.x + b.width), y2 = Math.max(a.y + a.height, b.y + b.height);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}
function clip(r, w, h) {
  const x1 = Math.max(0, r.x), y1 = Math.max(0, r.y), x2 = Math.min(w, r.x + r.width), y2 = Math.min(h, r.y + r.height);
  return x2 > x1 && y2 > y1 ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } : null;
}
