// Retouching tools: Spot Healing Brush, Healing Brush, Patch, Red Eye (J); Clone Stamp, Pattern
// Stamp (S); History Brush (Y); Background Eraser, Magic Eraser (E); Color Replacement (B);
// Blur, Sharpen, Smudge; Dodge, Burn, Sponge (O).
//
// "Dab" tools read the pixels under each dab, process them with src/shared/pixels/retouch.js and
// write them back (one undo entry per stroke through history.beginStroke/endStroke). Stamp tools
// paint through the brush engine with a sampler.
import { Tool, BRUSH_OPTIONS } from '../tools.js';
import { StrokeTool } from './paint.js';
import { createCanvas, intersectRect } from '../document.js';
import { flattenDocument } from '../compositor.js';
import { Selection } from '../selection.js';
import { parseColor } from '../../../shared/pixels/color.js';
import { floodFill } from '../../../shared/pixels/selection-ops.js';
import * as R from '../../../shared/pixels/retouch.js';

const SIZE = { kind: 'slider', key: 'size', label: 'Size', min: 1, max: 1000, step: 1, default: 40, unit: 'px' };
const HARD = { kind: 'slider', key: 'hardness', label: 'Hardness', min: 0, max: 1, step: 0.01, default: 0.5 };
const STRENGTH = (def = 0.5, label = 'Strength') => ({ kind: 'slider', key: 'strength', label, min: 0.01, max: 1, step: 0.01, default: def });
const SAMPLE_ALL = { kind: 'checkbox', key: 'sampleAll', label: 'Sample all layers', default: false };

// ---- dab helpers ------------------------------------------------------------------------------------------

const dabCache = new Map();
function fullDab(size, hardness) {
  const d = Math.max(1, Math.round(size));
  const key = `${d}|${Math.round(hardness * 100)}`;
  let m = dabCache.get(key);
  if (!m) {
    m = R.dabMask(d, d, hardness);
    if (dabCache.size > 60) dabCache.delete(dabCache.keys().next().value);
    dabCache.set(key, m);
  }
  return { mask: m, d };
}

/** Sub-mask of a d×d dab for the part (ox, oy, w, h) that lies on the canvas. */
function subDab(mask, d, ox, oy, w, h) {
  if (ox === 0 && oy === 0 && w === d && h === d) return mask;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) out.set(mask.subarray((y + oy) * d + ox, (y + oy) * d + ox + w), y * w);
  return out;
}

/** Selection coverage (0..1) for a canvas-local rect, or null when there is no selection. */
function selectionWeights(doc, rectDoc) {
  const sel = doc.selection && !doc.selection.isEmpty ? doc.selection : null;
  if (!sel) return null;
  const w = rectDoc.width, h = rectDoc.height;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = rectDoc.y + y;
    if (sy < 0 || sy >= doc.height) continue;
    for (let x = 0; x < w; x++) {
      const sx = rectDoc.x + x;
      if (sx < 0 || sx >= doc.width) continue;
      out[y * w + x] = sel.mask[sy * doc.width + sx] / 255;
    }
  }
  return out;
}

/** Base class for tools that process the pixels under each dab. */
class DabTool extends StrokeTool {
  constructor(app, def) {
    super(app, def);
    this.spacing = def.spacing ?? 0.25;
  }
  onPointerDown(p) {
    const layer = this.paintableLayer();
    if (!layer) return;
    if (this.app.ui.editingMask) {
      this.app.dialogs.toast(`${this.name} works on layer pixels, not masks`, { kind: 'error', timeout: 2000 });
      return;
    }
    if (layer.type !== 'raster') {
      this.app.rasterizePrompt(layer); // the button is up by the time it is answered: paint again
      return;
    }
    if (this.beforeStroke?.(p, layer) === false) return;
    const doc = this.doc;
    this.layer = layer;
    this.canvas = layer.canvas;
    this.ctx2 = layer.canvas.getContext('2d', { willReadFrequently: true });
    doc.history.beginStroke(layer.canvas, { label: this.name.replace(/ Tool$/, ''), layer, kind: 'pixels' });
    this.active = true;
    this.last = { x: p.x, y: p.y };
    this.carry = 0;
    this.dabAt(p.x, p.y, p);
  }
  onPointerMove(p, dragging) {
    if (!dragging || !this.active) return;
    const size = this.opt('size') ?? 40;
    const step = Math.max(1, size * this.spacing);
    const dx = p.x - this.last.x, dy = p.y - this.last.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-3) return;
    let t = step - this.carry;
    let placed = false;
    while (t <= dist) {
      this.dabAt(this.last.x + (dx * t) / dist, this.last.y + (dy * t) / dist, p);
      placed = true;
      t += step;
    }
    this.carry = placed ? dist - (t - step) : this.carry + dist;
    this.last = { x: p.x, y: p.y };
  }
  onPointerUp() {
    if (!this.active) return;
    this.active = false;
    this.doc.history.endStroke();
    this.afterStroke?.();
    this.layer = null;
  }
  cancel() {
    if (!this.active) return false;
    this.active = false;
    this.doc.history.cancelStroke();
    this.layer?.touch();
    this.doc.changed('pixels', { layer: this.layer });
    return true;
  }
  /** Processes one dab centred on document point (x, y). */
  dabAt(x, y, p) {
    const layer = this.layer;
    const size = Math.max(1, Math.round(this.opt('size') ?? 40));
    const { mask, d } = fullDab(size, this.opt('hardness') ?? 0.5);
    const lx = Math.round(x - layer.x - d / 2), ly = Math.round(y - layer.y - d / 2);
    const r = intersectRect({ x: lx, y: ly, width: d, height: d }, { x: 0, y: 0, width: this.canvas.width, height: this.canvas.height });
    if (!r) return;
    let dab = subDab(mask, d, r.x - lx, r.y - ly, r.width, r.height);
    const rectDoc = { x: r.x + layer.x, y: r.y + layer.y, width: r.width, height: r.height };
    const selW = selectionWeights(this.doc, rectDoc);
    if (selW) {
      const m = new Float32Array(dab.length);
      for (let i = 0; i < m.length; i++) m[i] = dab[i] * selW[i];
      dab = m;
    }
    const pressure = p?.pressure ?? 1;
    if (pressure < 1 && this.opt('pressureStrength') !== false) {
      const m = new Float32Array(dab.length);
      for (let i = 0; i < m.length; i++) m[i] = dab[i] * Math.max(0.05, pressure);
      dab = m;
    }
    const img = this.ctx2.getImageData(r.x, r.y, r.width, r.height);
    const full = { x: 0, y: 0, width: r.width, height: r.height };
    const changed = this.process(img, full, dab, { rectDoc, local: r, x, y });
    if (changed === false) return;
    if (layer.locked.transparency && !this.changesAlpha) {
      // retouch functions keep alpha; nothing to do
    }
    this.ctx2.putImageData(img, r.x, r.y);
    this.doc.history.touchStroke(r);
    layer.touch();
    this.doc.changed('pixels', { layer, rect: rectDoc });
  }
}

// ---- blur / sharpen / smudge ---------------------------------------------------------------------------------

class BlurTool extends DabTool {
  constructor(app) {
    super(app, { id: 'blur', name: 'Blur Tool', icon: 'blur', hint: 'Paint to soften detail.', options: [SIZE, HARD, STRENGTH(0.5)] });
  }
  process(img, rect, dab) {
    R.blurDab(img, rect, dab, { strength: this.opt('strength') ?? 0.5 });
  }
}

class SharpenTool extends DabTool {
  constructor(app) {
    super(app, { id: 'sharpen', name: 'Sharpen Tool', icon: 'sharpen', hint: 'Paint to increase local contrast. Go easy: repeated passes add noise.', options: [SIZE, HARD, STRENGTH(0.3)] });
  }
  process(img, rect, dab) {
    R.sharpenDab(img, rect, dab, { strength: this.opt('strength') ?? 0.3 });
  }
}

class SmudgeTool extends DabTool {
  constructor(app) {
    super(app, {
      id: 'smudge', name: 'Smudge Tool', icon: 'smudge', spacing: 0.1,
      hint: 'Drag to push paint like a finger through wet paint. Finger painting starts each stroke with the foreground colour.',
      options: [SIZE, HARD, STRENGTH(0.5), { kind: 'checkbox', key: 'fingerPainting', label: 'Finger painting', default: false }],
    });
  }
  beforeStroke() {
    this.carried = null;
  }
  process(img, rect, dab) {
    if (!this.carried && this.opt('fingerPainting')) {
      const [r, g, b] = parseColor(this.app.settings.foreground);
      const c = { width: rect.width, height: rect.height, data: new Uint8ClampedArray(rect.width * rect.height * 4) };
      for (let i = 0; i < c.data.length; i += 4) {
        c.data[i] = r;
        c.data[i + 1] = g;
        c.data[i + 2] = b;
        c.data[i + 3] = 255;
      }
      this.carried = c;
    }
    if (this.carried && (this.carried.width !== rect.width || this.carried.height !== rect.height)) this.carried = null; // clipped at an edge
    this.carried = R.smudge(img, rect, dab, this.carried, { strength: this.opt('strength') ?? 0.5 });
  }
}

// ---- dodge / burn / sponge ----------------------------------------------------------------------------------

const RANGE = { kind: 'select', key: 'range', label: 'Range', options: [['shadows', 'Shadows'], ['midtones', 'Midtones'], ['highlights', 'Highlights']], default: 'midtones' };
const EXPOSURE = { kind: 'slider', key: 'exposure', label: 'Exposure', min: 0.01, max: 1, step: 0.01, default: 0.5 };

class DodgeTool extends DabTool {
  constructor(app) {
    super(app, { id: 'dodge', name: 'Dodge Tool', icon: 'dodge', hint: 'Paint to lighten. Alt swaps to Burn.', options: [SIZE, HARD, RANGE, EXPOSURE] });
  }
  onPointerDown(p) {
    this.alt = p.alt;
    super.onPointerDown(p);
  }
  process(img, rect, dab) {
    const opts = { range: this.opt('range') ?? 'midtones', exposure: (this.opt('exposure') ?? 0.5) * 0.25 };
    (this.alt ? R.burn : R.dodge)(img, rect, dab, opts);
  }
}

class BurnTool extends DabTool {
  constructor(app) {
    super(app, { id: 'burn', name: 'Burn Tool', icon: 'burn', hint: 'Paint to darken. Alt swaps to Dodge.', options: [SIZE, HARD, RANGE, EXPOSURE] });
  }
  onPointerDown(p) {
    this.alt = p.alt;
    super.onPointerDown(p);
  }
  process(img, rect, dab) {
    const opts = { range: this.opt('range') ?? 'midtones', exposure: (this.opt('exposure') ?? 0.5) * 0.25 };
    (this.alt ? R.dodge : R.burn)(img, rect, dab, opts);
  }
}

class SpongeTool extends DabTool {
  constructor(app) {
    super(app, {
      id: 'sponge', name: 'Sponge Tool', icon: 'sponge', hint: 'Paint to saturate or desaturate colour.',
      options: [SIZE, HARD, { kind: 'segment', key: 'mode', label: 'Mode', options: [['desaturate', 'Desaturate'], ['saturate', 'Saturate']], default: 'desaturate' }, { kind: 'slider', key: 'flow', label: 'Flow', min: 0.01, max: 1, step: 0.01, default: 0.5 }],
    });
  }
  process(img, rect, dab) {
    R.sponge(img, rect, dab, { mode: this.opt('mode') ?? 'desaturate', flow: (this.opt('flow') ?? 0.5) * 0.3 });
  }
}

// ---- colour replacement --------------------------------------------------------------------------------------

class ColorReplaceTool extends DabTool {
  constructor(app) {
    super(app, {
      id: 'color-replace', name: 'Color Replacement Tool', icon: 'brush', spacing: 0.15,
      hint: 'Paint to replace the colour under the brush centre with the foreground colour, keeping texture and shading.',
      options: [
        SIZE, HARD,
        { kind: 'select', key: 'mode', label: 'Mode', options: [['color', 'Color'], ['hue', 'Hue'], ['saturation', 'Saturation'], ['luminosity', 'Luminosity']], default: 'color' },
        { kind: 'segment', key: 'sampling', label: 'Sampling', options: [['continuous', 'Continuous'], ['once', 'Once']], default: 'continuous' },
        { kind: 'slider', key: 'tolerance', label: 'Tolerance', min: 1, max: 255, step: 1, default: 60 },
      ],
    });
  }
  beforeStroke() {
    this.sample = null;
  }
  process(img, rect, dab, info) {
    const cx = Math.min(rect.width - 1, Math.max(0, Math.round(info.x - info.rectDoc.x))), cy = Math.min(rect.height - 1, Math.max(0, Math.round(info.y - info.rectDoc.y)));
    const i = (cy * img.width + cx) * 4;
    const here = [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3] / 255];
    if (!this.sample || this.opt('sampling') !== 'once') this.sample = here;
    R.replaceColor(img, rect, dab, { color: this.app.settings.foreground, tolerance: this.opt('tolerance') ?? 60, sampleColor: this.sample, mode: this.opt('mode') ?? 'color', strength: 1 });
  }
}

// ---- background eraser ----------------------------------------------------------------------------------------

class BackgroundEraserTool extends DabTool {
  constructor(app) {
    super(app, {
      id: 'eraser-bg', name: 'Background Eraser Tool', icon: 'eraser-bg', spacing: 0.15,
      hint: 'Erases pixels similar to the colour under the brush centre, keeping edges of the foreground object.',
      options: [
        SIZE, HARD,
        { kind: 'segment', key: 'sampling', label: 'Sampling', options: [['continuous', 'Continuous'], ['once', 'Once'], ['swatch', 'Background swatch']], default: 'continuous' },
        { kind: 'slider', key: 'tolerance', label: 'Tolerance', min: 1, max: 255, step: 1, default: 50 },
        { kind: 'checkbox', key: 'protectFg', label: 'Protect foreground colour', default: false },
      ],
    });
    this.changesAlpha = true;
  }
  beforeStroke(p, layer) {
    if (layer.locked.transparency) {
      this.app.dialogs.toast('The layer has transparency locked', { kind: 'error' });
      return false;
    }
    this.sample = null;
  }
  process(img, rect, dab, info) {
    const d = img.data;
    const cx = Math.min(rect.width - 1, Math.max(0, Math.round(info.x - info.rectDoc.x))), cy = Math.min(rect.height - 1, Math.max(0, Math.round(info.y - info.rectDoc.y)));
    const mode = this.opt('sampling') ?? 'continuous';
    if (mode === 'swatch') this.sample = parseColor(this.app.settings.background);
    else if (!this.sample || mode === 'continuous') {
      const i = (cy * img.width + cx) * 4;
      if (d[i + 3] === 0 && mode === 'continuous') return false;
      this.sample = [d[i], d[i + 1], d[i + 2]];
    }
    const tol = this.opt('tolerance') ?? 50;
    const fg = this.opt('protectFg') ? parseColor(this.app.settings.foreground) : null;
    const [sr, sg, sb] = this.sample;
    for (let p = 0, i = 0; p < dab.length; p++, i += 4) {
      const w = dab[p];
      if (w <= 0 || d[i + 3] === 0) continue;
      const diff = Math.max(Math.abs(d[i] - sr), Math.abs(d[i + 1] - sg), Math.abs(d[i + 2] - sb));
      if (diff > tol) continue;
      if (fg && Math.max(Math.abs(d[i] - fg[0]), Math.abs(d[i + 1] - fg[1]), Math.abs(d[i + 2] - fg[2])) <= tol / 2) continue;
      // fade out softly near the tolerance limit
      const k = w * Math.min(1, (tol - diff) / Math.max(1, tol * 0.25));
      d[i + 3] = Math.round(d[i + 3] * (1 - k));
    }
  }
}

// ---- healing brush / spot healing ----------------------------------------------------------------------------

function regionFrom(source, sx, sy, w, h) {
  // source: { canvas, x, y } in document space; returns ImageData w×h starting at document (sx, sy)
  const c = createCanvas(w, h);
  c.getContext('2d').drawImage(source.canvas, Math.round(sx - source.x), Math.round(sy - source.y), w, h, 0, 0, w, h);
  return c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h);
}

class HealingBrushTool extends DabTool {
  constructor(app) {
    super(app, {
      id: 'heal', name: 'Healing Brush Tool', icon: 'heal', spacing: 0.2,
      hint: 'Alt-click to set the source, then paint: texture comes from the source, colour and shading from the destination.',
      options: [SIZE, HARD, { kind: 'checkbox', key: 'aligned', label: 'Aligned', default: true }, SAMPLE_ALL],
    });
    this.source = null; // { x, y } document point
    this.offset = null;
  }
  onPointerDown(p) {
    if (p.alt) {
      this.source = { x: p.x, y: p.y };
      this.offset = null;
      this.app.dialogs.toast('Source set', { timeout: 900 });
      this.view?.invalidate();
      return;
    }
    if (!this.source) {
      this.app.dialogs.toast('Alt-click (Option-click) to set a source point first', { kind: 'error', timeout: 2200 });
      return;
    }
    if (!this.offset || !this.opt('aligned')) this.offset = { x: this.source.x - p.x, y: this.source.y - p.y };
    super.onPointerDown(p);
  }
  beforeStroke(p, layer) {
    this.src = this.opt('sampleAll') ? { canvas: flattenDocument(this.doc, this.doc.view.compositor), x: 0, y: 0 } : { canvas: copyOf(layer.canvas), x: layer.x, y: layer.y };
  }
  process(img, rect, dab, info) {
    const source = regionFrom(this.src, info.rectDoc.x + this.offset.x, info.rectDoc.y + this.offset.y, rect.width, rect.height);
    R.heal(img, rect, dab, source, { strength: 1 });
  }
  drawOverlay(ctx, view) {
    super.drawOverlay(ctx, view);
    drawSourceMark(ctx, view, this.active && this.offset && view.pointer ? { x: view.pointer.x + this.offset.x, y: view.pointer.y + this.offset.y } : this.source);
  }
}

function copyOf(canvas) {
  const c = createCanvas(canvas.width, canvas.height);
  c.getContext('2d').drawImage(canvas, 0, 0);
  return c;
}

function drawSourceMark(ctx, view, pt) {
  if (!pt) return;
  const s = view.toScreen(pt.x, pt.y);
  ctx.save();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(s.x - 7, s.y);
  ctx.lineTo(s.x + 7, s.y);
  ctx.moveTo(s.x, s.y - 7);
  ctx.lineTo(s.x, s.y + 7);
  ctx.stroke();
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

class SpotHealingTool extends DabTool {
  constructor(app) {
    super(app, {
      id: 'spot-heal', name: 'Spot Healing Brush Tool', icon: 'spot-heal', spacing: 0.25,
      hint: 'Paint over spots and blemishes: they are replaced with texture from around them when you release the mouse.',
      options: [{ ...SIZE, default: 30 }, { ...HARD, default: 0.3 }, { kind: 'segment', key: 'type', label: 'Type', options: [['content-aware', 'Content-Aware'], ['proximity', 'Proximity Match']], default: 'content-aware' }, SAMPLE_ALL],
    });
  }
  get contentAware() {
    return (this.opt('type') ?? 'content-aware') === 'content-aware' && !!this.app.contentAwareFill;
  }
  onPointerDown(p) {
    if (!this.contentAware) return super.onPointerDown(p);
    const layer = this.paintableLayer();
    if (!layer) return;
    if (this.app.ui.editingMask) return this.app.dialogs.toast('Spot healing works on layer pixels, not masks', { kind: 'error', timeout: 2000 });
    if (layer.type !== 'raster') {
      this.app.rasterizePrompt(layer); // the button is up by the time it is answered: paint again
      return;
    }
    const d = this.doc;
    this.caMask = new Uint8Array(d.width * d.height);
    this.caPts = [[p.x, p.y]];
    this.stamp(p.x, p.y);
    this.view.invalidate();
  }
  stamp(cx, cy) {
    const d = this.doc;
    const r = Math.max(1, (this.opt('size') ?? 30) / 2);
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(d.width - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(d.height - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) this.caMask[y * d.width + x] = 255;
  }
  onPointerMove(p, dragging) {
    if (!this.caMask) return super.onPointerMove(p, dragging);
    if (!dragging) return;
    const [lx, ly] = this.caPts[this.caPts.length - 1];
    const step = Math.max(1, (this.opt('size') ?? 30) / 4);
    const dist = Math.hypot(p.x - lx, p.y - ly);
    for (let t = step; t <= dist; t += step) this.stamp(lx + ((p.x - lx) * t) / dist, ly + ((p.y - ly) * t) / dist);
    this.stamp(p.x, p.y);
    this.caPts.push([p.x, p.y]);
    this.view.invalidate();
  }
  onPointerUp() {
    if (!this.caMask) return super.onPointerUp();
    const d = this.doc;
    const mask = this.caMask;
    this.caMask = null;
    this.caPts = null;
    const sel = d.selection && !d.selection.isEmpty ? d.selection : null;
    if (sel) for (let i = 0; i < mask.length; i++) if (mask[i] && sel.mask[i] < 128) mask[i] = 0;
    this.view.invalidate();
    this.app.contentAwareFill(mask, { label: 'Spot Healing' });
  }
  cancel() {
    if (this.caMask) {
      this.caMask = null;
      this.caPts = null;
      this.view.invalidate();
      return true;
    }
    return super.cancel();
  }
  drawOverlay(ctx, view) {
    if (this.caPts?.length) {
      ctx.save();
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(1, (this.opt('size') ?? 30) * view.zoom);
      ctx.beginPath();
      this.caPts.forEach(([x, y], i) => {
        const s = view.toScreen(x, y);
        if (i) ctx.lineTo(s.x, s.y);
        else ctx.moveTo(s.x, s.y);
      });
      if (this.caPts.length === 1) {
        const s = view.toScreen(this.caPts[0][0], this.caPts[0][1]);
        ctx.lineTo(s.x + 0.01, s.y);
      }
      ctx.stroke();
      ctx.restore();
    }
    super.drawOverlay(ctx, view);
  }
  beforeStroke(p, layer) {
    this.src = this.opt('sampleAll') ? { canvas: flattenDocument(this.doc, this.doc.view.compositor), x: 0, y: 0 } : { canvas: copyOf(layer.canvas), x: layer.x, y: layer.y };
  }
  process(img, rect, dab, info) {
    const w = rect.width, h = rect.height;
    // try candidate patches around the dab; pick the one whose border best matches the destination's
    const ring = ringStats(img, dab);
    let best = null;
    const dist = Math.max(w, h) * 1.25;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const ox = Math.round(Math.cos(a) * dist), oy = Math.round(Math.sin(a) * dist);
      const sx = info.rectDoc.x + ox, sy = info.rectDoc.y + oy;
      if (sx < this.src.x || sy < this.src.y || sx + w > this.src.x + this.src.canvas.width || sy + h > this.src.y + this.src.canvas.height) continue;
      const cand = regionFrom(this.src, sx, sy, w, h);
      const st = ringStats(cand, dab);
      if (st.alpha < 0.5) continue;
      const score = Math.abs(st.mean[0] - ring.mean[0]) + Math.abs(st.mean[1] - ring.mean[1]) + Math.abs(st.mean[2] - ring.mean[2]) + st.variance * 0.02;
      if (!best || score < best.score) best = { score, cand };
    }
    if (!best) return false;
    R.heal(img, rect, dab, best.cand, { strength: 1 });
  }
}

/** Mean colour of the dab's outer ring (weights 0.05..0.5) and the variance of luma inside. */
function ringStats(img, dab) {
  const d = img.data;
  const mean = [0, 0, 0];
  let n = 0, alpha = 0, sum = 0, sum2 = 0, m = 0;
  for (let p = 0, i = 0; p < dab.length; p++, i += 4) {
    const w = dab[p];
    if (w > 0.02 && w < 0.6) {
      mean[0] += d[i];
      mean[1] += d[i + 1];
      mean[2] += d[i + 2];
      alpha += d[i + 3] / 255;
      n++;
    }
    const l = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
    sum += l;
    sum2 += l * l;
    m++;
  }
  if (n) {
    mean[0] /= n;
    mean[1] /= n;
    mean[2] /= n;
    alpha /= n;
  } else alpha = 1;
  const mu = m ? sum / m : 0;
  return { mean, alpha, variance: m ? sum2 / m - mu * mu : 0 };
}

// ---- patch tool -----------------------------------------------------------------------------------------------

class PatchTool extends Tool {
  constructor(app) {
    super(app, {
      id: 'patch', name: 'Patch Tool', icon: 'patch', cursor: 'crosshair',
      hint: 'Draw around the area to fix (or use any selection), then drag the selection onto clean texture to patch it.',
      options: [{ kind: 'segment', key: 'mode', label: 'Patch', options: [['source', 'Source'], ['destination', 'Destination']], default: 'source' }],
    });
  }
  onPointerDown(p) {
    const doc = this.doc;
    const sel = doc.selection && !doc.selection.isEmpty ? doc.selection : null;
    if (sel && sel.at?.(Math.floor(p.x), Math.floor(p.y))) {
      this.drag = { start: p, dx: 0, dy: 0 };
      return;
    }
    this.lasso = [[p.x, p.y]];
  }
  onPointerMove(p, dragging) {
    if (!dragging) return;
    if (this.drag) {
      this.drag.dx = p.x - this.drag.start.x;
      this.drag.dy = p.y - this.drag.start.y;
      this.view.invalidate();
    } else if (this.lasso) {
      const last = this.lasso[this.lasso.length - 1];
      if (Math.hypot(p.x - last[0], p.y - last[1]) * this.view.zoom > 2) this.lasso.push([p.x, p.y]);
      this.view.invalidate();
    }
  }
  onPointerUp() {
    const doc = this.doc;
    if (this.lasso) {
      const pts = this.lasso;
      this.lasso = null;
      if (pts.length > 2) this.app.applySelection(Selection.fromPolygon(doc.width, doc.height, pts.map(([x, y]) => ({ x, y }))), 'replace', 'Patch selection');
      this.view.invalidate();
      return;
    }
    if (!this.drag) return;
    const { dx, dy } = this.drag;
    this.drag = null;
    this.view.invalidate();
    if (Math.hypot(dx, dy) < 1) return;
    this.applyPatch(Math.round(dx), Math.round(dy));
  }
  applyPatch(dx, dy) {
    const doc = this.doc;
    const layer = this.paintableLayer();
    if (!layer) return;
    if (layer.type !== 'raster') return this.app.rasterizePrompt(layer);
    const sel = doc.selection;
    const b = sel.bounds;
    const sourceMode = (this.opt('mode') ?? 'source') === 'source';
    // source mode: the selected area is replaced by texture from where it was dragged to;
    // destination mode: the selected texture is healed into the drop location
    const dest = sourceMode ? b : { x: b.x + dx, y: b.y + dy, width: b.width, height: b.height };
    const from = sourceMode ? { x: b.x + dx, y: b.y + dy } : { x: b.x, y: b.y };
    const local = intersectRect({ x: dest.x - layer.x, y: dest.y - layer.y, width: dest.width, height: dest.height }, { x: 0, y: 0, width: layer.canvas.width, height: layer.canvas.height });
    if (!local) return;
    const rectDoc = { x: local.x + layer.x, y: local.y + layer.y, width: local.width, height: local.height };
    const weights = new Float32Array(local.width * local.height);
    for (let y = 0; y < local.height; y++) {
      for (let x = 0; x < local.width; x++) {
        // the selection shape, moved with the destination
        const sx = rectDoc.x + x - (sourceMode ? 0 : dx), sy = rectDoc.y + y - (sourceMode ? 0 : dy);
        if (sx < 0 || sy < 0 || sx >= doc.width || sy >= doc.height) continue;
        weights[y * local.width + x] = sel.mask[sy * doc.width + sx] / 255;
      }
    }
    const src = { canvas: copyOf(layer.canvas), x: layer.x, y: layer.y };
    const source = regionFrom(src, from.x + (rectDoc.x - dest.x), from.y + (rectDoc.y - dest.y), local.width, local.height);
    doc.history.pixels('Patch', layer.canvas, local, (ctx) => {
      const img = ctx.getImageData(local.x, local.y, local.width, local.height);
      R.heal(img, { x: 0, y: 0, width: local.width, height: local.height }, weights, source, { strength: 1, radius: Math.max(3, Math.round(Math.min(local.width, local.height) / 10)) });
      ctx.putImageData(img, local.x, local.y);
    }, { layer });
    if (!sourceMode) this.app.applySelection(sel.resized ? sel.resized(doc.width, doc.height, dx, dy) : sel, 'replace', 'Move selection');
  }
  drawOverlay(ctx, view) {
    ctx.save();
    if (this.lasso?.length > 1) {
      ctx.strokeStyle = '#000';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      this.lasso.forEach(([x, y], i) => {
        const s = view.toScreen(x, y);
        i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y);
      });
      ctx.stroke();
    }
    if (this.drag && this.doc.selection) {
      const b = this.doc.selection.bounds;
      const a = view.toScreen(b.x + this.drag.dx, b.y + this.drag.dy), c = view.toScreen(b.x + b.width + this.drag.dx, b.y + b.height + this.drag.dy);
      ctx.strokeStyle = '#2f80ff';
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(a.x, a.y, c.x - a.x, c.y - a.y);
    }
    ctx.restore();
  }
}

// ---- red eye --------------------------------------------------------------------------------------------------

class RedEyeTool extends Tool {
  constructor(app) {
    super(app, {
      id: 'red-eye', name: 'Red Eye Tool', icon: 'eyedropper', cursor: 'crosshair',
      hint: 'Click a red pupil (or drag a box around the eye) to remove red eye.',
      options: [
        { kind: 'slider', key: 'pupil', label: 'Pupil size', min: 1, max: 100, step: 1, default: 50, unit: '%' },
        { kind: 'slider', key: 'darken', label: 'Darken amount', min: 1, max: 100, step: 1, default: 50, unit: '%' },
      ],
    });
  }
  onPointerDown(p) {
    this.start = p;
    this.box = null;
  }
  onPointerMove(p, dragging) {
    if (!dragging || !this.start) return;
    this.box = { x: Math.min(p.x, this.start.x), y: Math.min(p.y, this.start.y), width: Math.abs(p.x - this.start.x), height: Math.abs(p.y - this.start.y) };
    this.view.invalidate();
  }
  onPointerUp(p) {
    if (!this.start) return;
    const r = this.box && this.box.width > 4 ? this.box : { x: p.x - 30, y: p.y - 30, width: 60, height: 60 };
    this.start = null;
    this.box = null;
    this.view.invalidate();
    const layer = this.paintableLayer();
    if (!layer) return;
    if (layer.type !== 'raster') return this.app.rasterizePrompt(layer);
    const local = intersectRect({ x: Math.round(r.x - layer.x), y: Math.round(r.y - layer.y), width: Math.round(r.width), height: Math.round(r.height) }, { x: 0, y: 0, width: layer.canvas.width, height: layer.canvas.height });
    if (!local) return;
    const darken = (this.opt('darken') ?? 50) / 100, pupil = (this.opt('pupil') ?? 50) / 100;
    let changed = 0;
    this.doc.history.pixels('Red eye', layer.canvas, local, (ctx) => {
      const img = ctx.getImageData(local.x, local.y, local.width, local.height);
      const d = img.data;
      const cx = local.width / 2, cy = local.height / 2, rad = (Math.min(local.width, local.height) / 2) * (0.5 + pupil * 0.5);
      for (let y = 0; y < local.height; y++) {
        for (let x = 0; x < local.width; x++) {
          const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
          if (dist > rad) continue;
          const i = (y * local.width + x) * 4;
          const red = d[i], other = (d[i + 1] + d[i + 2]) / 2;
          const redness = red - other;
          if (redness < 30 || red < 60) continue;
          const k = Math.min(1, (redness - 30) / 60) * (dist > rad * 0.8 ? (rad - dist) / (rad * 0.2) : 1);
          const target = other * (1 - darken * 0.6);
          d[i] = red + (target - red) * k;
          d[i + 1] = d[i + 1] + (target - d[i + 1]) * k * 0.5;
          d[i + 2] = d[i + 2] + (target - d[i + 2]) * k * 0.5;
          changed++;
        }
      }
      ctx.putImageData(img, local.x, local.y);
    }, { layer });
    if (!changed) this.app.dialogs.toast('No red pupil found there', { timeout: 1500 });
  }
  drawOverlay(ctx, view) {
    if (!this.box) return;
    const a = view.toScreen(this.box.x, this.box.y), c = view.toScreen(this.box.x + this.box.width, this.box.y + this.box.height);
    ctx.save();
    ctx.strokeStyle = '#2f80ff';
    ctx.strokeRect(a.x, a.y, c.x - a.x, c.y - a.y);
    ctx.restore();
  }
}

// ---- magic eraser -----------------------------------------------------------------------------------------------

class MagicEraserTool extends Tool {
  constructor(app) {
    super(app, {
      id: 'eraser-magic', name: 'Magic Eraser Tool', icon: 'eraser-magic', cursor: 'crosshair',
      hint: 'Click to erase all similar pixels (contiguous by default).',
      options: [
        { kind: 'slider', key: 'tolerance', label: 'Tolerance', min: 0, max: 255, step: 1, default: 32 },
        { kind: 'checkbox', key: 'antialias', label: 'Anti-alias', default: true },
        { kind: 'checkbox', key: 'contiguous', label: 'Contiguous', default: true },
        { kind: 'checkbox', key: 'sampleAll', label: 'Sample all layers', default: false },
        { kind: 'slider', key: 'opacity', label: 'Opacity', min: 0.01, max: 1, step: 0.01, default: 1 },
      ],
    });
  }
  onPointerDown(p) {
    const doc = this.doc;
    const layer = this.paintableLayer();
    if (!layer) return;
    if (layer.type !== 'raster') return this.app.rasterizePrompt(layer);
    if (layer.locked.transparency) return this.app.dialogs.toast('The layer has transparency locked', { kind: 'error' });
    const sampleAll = this.opt('sampleAll');
    const src = sampleAll ? flattenDocument(doc, doc.view.compositor) : layer.canvas;
    const ox = sampleAll ? 0 : layer.x, oy = sampleAll ? 0 : layer.y;
    const sx = Math.floor(p.x - ox), sy = Math.floor(p.y - oy);
    if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) return;
    const img = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, src.width, src.height);
    const mask = floodFill(img, sx, sy, { tolerance: this.opt('tolerance') ?? 32, contiguous: this.opt('contiguous') !== false, antialias: this.opt('antialias') !== false });
    const sel = doc.selection && !doc.selection.isEmpty ? doc.selection : null;
    const opacity = this.opt('opacity') ?? 1;
    const W = layer.canvas.width, H = layer.canvas.height;
    let any = false;
    doc.history.pixels('Magic eraser', layer.canvas, { x: 0, y: 0, width: W, height: H }, (ctx) => {
      const data = ctx.getImageData(0, 0, W, H);
      const d = data.data;
      for (let y = 0; y < H; y++) {
        const my = y + layer.y - oy;
        if (my < 0 || my >= src.height) continue;
        for (let x = 0; x < W; x++) {
          const mx = x + layer.x - ox;
          if (mx < 0 || mx >= src.width) continue;
          let m = mask[my * src.width + mx] / 255;
          if (!m) continue;
          if (sel) {
            const dx = x + layer.x, dy = y + layer.y;
            m *= dx >= 0 && dy >= 0 && dx < doc.width && dy < doc.height ? sel.mask[dy * doc.width + dx] / 255 : 0;
          }
          const i = (y * W + x) * 4 + 3;
          if (d[i] && m) {
            d[i] = Math.round(d[i] * (1 - m * opacity));
            any = true;
          }
        }
      }
      ctx.putImageData(data, 0, 0);
    }, { layer });
    if (!any) this.app.dialogs.toast('Nothing to erase there', { timeout: 1200 });
  }
}

// ---- stamps (brush engine with a sampler) --------------------------------------------------------------------

class CloneStampTool extends StrokeTool {
  constructor(app) {
    super(app, {
      id: 'clone', name: 'Clone Stamp Tool', icon: 'clone',
      hint: 'Alt-click (Option-click) to set the source, then paint to copy pixels from it.',
      options: [...BRUSH_OPTIONS, { kind: 'checkbox', key: 'aligned', label: 'Aligned', default: true }, SAMPLE_ALL],
    });
    this.source = null;
    this.offset = null;
  }
  onPointerDown(p) {
    if (p.alt) {
      this.source = { x: p.x, y: p.y };
      this.offset = null;
      this.app.dialogs.toast('Clone source set', { timeout: 900 });
      this.view?.invalidate();
      return;
    }
    if (!this.source) {
      this.app.dialogs.toast('Alt-click (Option-click) to set a clone source first', { kind: 'error', timeout: 2200 });
      return;
    }
    if (!this.offset || !this.opt('aligned')) this.offset = { x: this.source.x - p.x, y: this.source.y - p.y };
    super.onPointerDown(p);
  }
  strokeSettings(p, layer, target) {
    const doc = this.doc;
    const all = this.opt('sampleAll');
    const comp = all ? flattenDocument(doc, doc.view.compositor) : null;
    const snapshot = all ? null : copyOf(target.canvas);
    const off = this.offset;
    return {
      ...this.baseSettings(layer, target),
      label: 'Clone stamp',
      sampler: (tctx, lx, ly, w, h) => {
        // lx/ly are relative to the stroke canvas, which moves when the stroke grows the layer
        const [dx, dy] = this.docPoint(lx, ly, target);
        if (all) tctx.drawImage(comp, Math.round(dx + off.x), Math.round(dy + off.y), w, h, 0, 0, w, h);
        else tctx.drawImage(snapshot, Math.round(dx - target.x + off.x), Math.round(dy - target.y + off.y), w, h, 0, 0, w, h);
      },
    };
  }
  drawOverlay(ctx, view) {
    super.drawOverlay(ctx, view);
    drawSourceMark(ctx, view, this.stroke && this.offset && view.pointer ? { x: view.pointer.x + this.offset.x, y: view.pointer.y + this.offset.y } : this.source);
  }
}

class PatternStampTool extends StrokeTool {
  constructor(app) {
    super(app, {
      id: 'pattern-stamp', name: 'Pattern Stamp Tool', icon: 'pattern-stamp',
      hint: 'Paints with the current pattern (Edit › Define Pattern).',
      options: [...BRUSH_OPTIONS, { kind: 'checkbox', key: 'aligned', label: 'Aligned', default: true }],
    });
  }
  onPointerDown(p) {
    if (!this.app.currentPattern) {
      this.app.dialogs.toast('Define a pattern first (Edit › Define Pattern)', { kind: 'error' });
      return;
    }
    this.strokeOrigin = this.opt('aligned') !== false ? { x: 0, y: 0 } : { x: p.x, y: p.y };
    super.onPointerDown(p);
  }
  strokeSettings(p, layer, target) {
    const pat = this.app.currentPattern;
    const origin = this.strokeOrigin;
    return {
      ...this.baseSettings(layer, target),
      label: 'Pattern stamp',
      sampler: (tctx, lx, ly, w, h) => {
        tctx.save();
        const [dx, dy] = this.docPoint(lx, ly, target);
        const ox = dx - origin.x, oy = dy - origin.y;
        tctx.translate(-ox, -oy);
        tctx.fillStyle = tctx.createPattern(pat, 'repeat');
        tctx.fillRect(ox, oy, w, h);
        tctx.restore();
      },
    };
  }
}

class HistoryBrushTool extends StrokeTool {
  constructor(app) {
    super(app, {
      id: 'history-brush', name: 'History Brush Tool', icon: 'history',
      hint: 'Paints back the image as it was when the document was opened or last saved.',
      options: [...BRUSH_OPTIONS],
    });
  }
  onPointerDown(p) {
    const snap = this.doc?.history.savedSnapshot?.();
    if (!snap) {
      this.app.dialogs.toast('Nothing to paint from yet: save or reopen the document first', { kind: 'error', timeout: 2400 });
      return;
    }
    if (snap.width !== this.doc.width || snap.height !== this.doc.height) {
      this.app.dialogs.toast('The canvas size changed since the saved state', { kind: 'error' });
      return;
    }
    super.onPointerDown(p);
  }
  strokeSettings(p, layer, target) {
    const snap = this.doc.history.savedSnapshot();
    return {
      ...this.baseSettings(layer, target),
      label: 'History brush',
      sampler: (tctx, lx, ly, w, h) => {
        const [dx, dy] = this.docPoint(lx, ly, target);
        tctx.drawImage(snap, Math.round(dx), Math.round(dy), w, h, 0, 0, w, h);
      },
    };
  }
}

export function install(app) {
  const t = app.tools;
  t.register(new SpotHealingTool(app), 'heal');
  t.register(new HealingBrushTool(app), 'heal');
  t.register(new PatchTool(app), 'heal');
  t.register(new RedEyeTool(app), 'heal');
  t.register(new ColorReplaceTool(app), 'brush');
  t.register(new CloneStampTool(app), 'clone');
  t.register(new PatternStampTool(app), 'clone');
  t.register(new HistoryBrushTool(app), 'history');
  t.register(new BackgroundEraserTool(app), 'eraser');
  t.register(new MagicEraserTool(app), 'eraser');
  t.register(new BlurTool(app), 'blur');
  t.register(new SharpenTool(app), 'blur');
  t.register(new SmudgeTool(app), 'blur');
  t.register(new DodgeTool(app), 'retouch');
  t.register(new BurnTool(app), 'retouch');
  t.register(new SpongeTool(app), 'retouch');
  t.renderToolbox();
}
