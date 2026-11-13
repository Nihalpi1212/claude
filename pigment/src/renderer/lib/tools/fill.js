// Gradient tool (gradients package; the Paint Bucket moved to lib/tools/bucket.js, owned by patterns).
//
// Two modes, as in Photoshop: Classic paints the gradient into the pixels of the active layer (or its mask), as 0.3
// did; Gradient makes a Gradient Fill layer (through 'layer:new-fill') and edits it on the canvas afterwards (live
// gradients): drag the end points or the line, drag a colour stop along the line, click the line to add a stop, drag
// a stop away from the line or press Delete to remove it, double-click a stop to change its colour. Dragging again
// with a Gradient Fill layer active redraws that layer's gradient.
//
// Options: the gradient (the `gradient` widget with its preset picker and Gradient Editor; tool options may keep
// { ref } stops, G.1), the style, Method (in the widget), blend mode and opacity (Classic), Reverse, Dither,
// Transparency. The 0.3 option `preset` (an index into GRADIENT_PRESETS) is read as the preset id it names.
import { Tool } from '../tools.js';
import { createCanvas } from '../document.js';
import { BLEND_MODES } from '../document.js';
import { drawBlended, drawOnMask } from '../brush.js';
import { paintStyle } from '../paint.js';
import { setLayerProps } from '../layer-ops.js';
import { normalizeGradient, sampleGradient } from '../../../shared/pixels/gradient-model.js';
import { rgbaToHex, parseColor } from '../../../shared/pixels/color.js';
import { registerGradientKind, legacyPresetId, GRADIENT_KIND } from '../gradient-presets.js';
import '../gradient-widget.js'; // registers the `gradient` widget (the options bar builds it)
import { installGradientPaint, canvasCanDraw, draft } from '../gradient-paint.js';
import { appColors } from '../gradient-picker.js';

export const BLEND_OPTIONS = BLEND_MODES.filter(Boolean).filter(([id]) => id !== 'dissolve').map(([id, label]) => [id, label]);

/** 0.3's eight presets (lib/preset-kinds.js and lib/gradient-presets.js build the built-in presets from them). */
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

/** 0.3's stop list of a preset with fg / bg filled in (kept for 0.3 callers). */
export function resolveStops(preset, fg, bg) {
  if (preset.stops === 'fgbg') return [{ pos: 0, color: fg }, { pos: 1, color: bg }];
  if (preset.stops === 'fgt') return [{ pos: 0, color: fg }, { pos: 1, color: fg + '00' }];
  return preset.stops;
}

const DEFAULT_PRESET = 'foreground-to-background';
const HIT = 8; // screen px around a handle
const AWAY = 28; // screen px a stop is dragged off the line to delete it

/** A Gradient Fill layer whose gradient has document end points (what the on-canvas widget edits). */
export const isLiveGradient = (layer) => layer?.type === 'fill' && layer.paint?.type === 'gradient' && Array.isArray(layer.paint.gradient?.from) && Array.isArray(layer.paint.gradient?.to);

export class GradientTool extends Tool {
  constructor(app) {
    const tool = () => this;
    super(app, {
      id: 'gradient',
      name: 'Gradient Tool',
      icon: 'gradient',
      cursor: 'crosshair',
      hint: 'Drag to draw a gradient (Shift constrains the angle). In Gradient mode it makes a Gradient Fill layer you can keep editing on the canvas.',
      paints: true,
      options: [
        { kind: 'select', key: 'mode', label: '', options: [['gradient', 'Gradient'], ['classic', 'Classic']], default: 'classic' },
        // without a stored gradient the option reads as its preset's (a getter: the presets load after the tools)
        { kind: 'gradient', key: 'gradient', label: '', placement: false, keepRefs: true, compact: true, method: true, preview: false, onPick: (p) => this.setOpt('preset', p.id), get default() { return tool().presetGradient(); } },
        { kind: 'hidden', key: 'preset', default: DEFAULT_PRESET },
        { kind: 'segment', key: 'kind', label: '', options: [['linear', 'Linear', 'grad-linear'], ['radial', 'Radial', 'grad-radial'], ['angle', 'Angle', 'grad-angle'], ['reflected', 'Reflected', 'grad-reflected'], ['diamond', 'Diamond', 'grad-diamond']], default: 'linear' },
        { kind: 'select', key: 'blend', label: 'Mode', options: BLEND_OPTIONS, default: 'normal', when: (t) => t.mode() === 'classic' },
        { kind: 'slider', key: 'opacity', label: 'Opacity', min: 0.01, max: 1, step: 0.01, default: 1, when: (t) => t.mode() === 'classic' },
        { kind: 'checkbox', key: 'reverse', label: 'Reverse', default: false },
        { kind: 'checkbox', key: 'dither', label: 'Dither', default: true },
        { kind: 'checkbox', key: 'transparency', label: 'Transparency', default: true },
      ],
    });
    this.drag = null;
    this.edit = null; // a drag of the on-canvas widget
    this.selStop = -1; // the selected colour stop of the live gradient
  }

  mode() {
    return this.opt('mode') === 'gradient' ? 'gradient' : 'classic';
  }

  /** The preset id of the tool's gradient (0.3 stored an index). */
  presetId() {
    const p = this.opt('preset');
    return legacyPresetId(p) ?? (typeof p === 'string' && p ? p : DEFAULT_PRESET);
  }

  /** The tool's gradient as stored (a def that may keep { ref } stops): the option, else its preset's data. */
  currentGradient() {
    const g = this.app.settings.tools?.gradient?.gradient;
    return g && typeof g === 'object' ? g : this.presetGradient();
  }

  /** The data of the tool's preset (0.3's preset list until the preset store exists). */
  presetGradient() {
    const preset = this.app.presets?.get(GRADIENT_KIND, this.presetId());
    if (preset) return preset.data;
    const legacy = GRADIENT_PRESETS[Number(this.opt('preset'))] ?? GRADIENT_PRESETS[0];
    return normalizeGradient({ stops: legacy.stops }, { keepRefs: true });
  }

  /** The def to draw with: references resolved, Transparency applied. */
  drawDef() {
    const def = normalizeGradient(this.currentGradient(), appColors(this.app));
    if (this.opt('transparency') === false) def.opacityStops = def.opacityStops.map((s) => ({ ...s, opacity: 1 }));
    return def;
  }

  /** 0.3's stop list of the current gradient (kept for 0.3 callers). */
  stops() {
    const def = this.drawDef();
    return def.stops.map((s) => ({ pos: s.pos, color: s.color }));
  }

  onOptionChanged(key) {
    if (key === 'mode') this.app.tools.renderOptions();
    if (key === 'gradient' || key === 'mode') this.view?.invalidate();
  }

  activate() {
    this.selStop = -1;
  }

  // ---- pointer ---------------------------------------------------------------------------------------------------------

  onPointerDown(p) {
    const layer = this.doc?.active;
    if (this.mode() === 'gradient') {
      if (isLiveGradient(layer) && !layer.locked?.all) {
        const hit = this.hitWidget(layer, p);
        if (hit) {
          const sp = this.app.snap?.point(p, { source: 'gradient', pointer: p, view: this.view }) ?? p; // snap (lib/snap.js)
          this.edit = { ...hit, layer, original: layer.paint, start: { x: sp.x, y: sp.y }, moved: false, away: false };
          if (hit.type === 'stop') this.selStop = hit.index;
          return;
        }
      }
      if (!this.doc) return;
      const sp = this.app.snap?.point(p, { source: 'gradient', pointer: p, view: this.view }) ?? p; // snap (lib/snap.js)
      this.drag = { from: { x: sp.x, y: sp.y }, to: { x: sp.x, y: sp.y }, layer, live: true };
      return;
    }
    const target = this.paintableLayer();
    if (!target) return;
    if (target.type !== 'raster' && !(this.app.ui.editingMask && target.mask)) {
      this.app.rasterizePrompt(target); // a gradient is a drag: start it again once rasterized
      return;
    }
    const sp = this.app.snap?.point(p, { source: 'gradient', pointer: p, view: this.view }) ?? p; // snap (lib/snap.js)
    this.drag = { from: { x: sp.x, y: sp.y }, to: { x: sp.x, y: sp.y }, layer: target };
  }

  onPointerMove(p, dragging) {
    if (!dragging) return;
    if (this.edit) return this.moveWidget(p);
    if (!this.drag) return;
    const sp = this.app.snap?.point(p, { source: 'gradient', pointer: p, view: this.view }) ?? p; // snap (lib/snap.js)
    let to = { x: sp.x, y: sp.y };
    if (p.shift) {
      const dx = to.x - this.drag.from.x, dy = to.y - this.drag.from.y;
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      to = { x: this.drag.from.x + Math.cos(ang) * len, y: this.drag.from.y + Math.sin(ang) * len };
    }
    this.drag.to = to;
  }

  onPointerUp(p) {
    if (this.edit) return this.endWidget(p);
    const d = this.drag;
    this.drag = null;
    if (!d || p.cancelled) return;
    if (d.live) return this.liveGradient(d);
    const doc = this.doc;
    const layer = d.layer;
    const mask = this.app.ui.editingMask && layer.mask?.canvas;
    const sel = doc.selection && !doc.selection.isEmpty ? doc.selection : null;
    const area = sel ? sel.bounds : doc.bounds;
    if (!mask) layer.ensureCovers(area); // may replace layer.canvas: build the target after it
    const target = mask ? { canvas: layer.mask.canvas, x: 0, y: 0 } : { canvas: layer.canvas, x: layer.x, y: layer.y };
    const local = { x: area.x - target.x, y: area.y - target.y, width: area.width, height: area.height };
    const g = { ...this.drawDef(), kind: this.opt('kind') ?? 'linear', from: [d.from.x, d.from.y], to: [d.to.x, d.to.y], reverse: !!this.opt('reverse') };
    if (Math.hypot(d.to.x - d.from.x, d.to.y - d.from.y) < 1) g.to = [d.from.x + 1, d.from.y];
    const wantDither = this.opt('dither') !== false;
    // a Canvas gradient (classic) gets 0.3's ordered dither afterwards; the per-pixel methods dither as they render
    const canvasOk = canvasCanDraw(g);
    if (!canvasOk) g.dither = wantDither;
    doc.history.pixels('Gradient', target.canvas, local, (ctx) => {
      const fill = createCanvas(area.width, area.height);
      const fctx = fill.getContext('2d');
      fctx.translate(-area.x, -area.y);
      fctx.fillStyle = paintStyle(fctx, { type: 'gradient', gradient: g }, area, { origin: [0, 0] });
      fctx.fillRect(area.x, area.y, area.width, area.height);
      fctx.setTransform(1, 0, 0, 1, 0, 0);
      if (wantDither && canvasOk) dither(fill);
      if (sel) {
        fctx.globalCompositeOperation = 'destination-in';
        fctx.drawImage(sel.toCanvas(), -area.x, -area.y);
      }
      if (mask) drawOnMask(ctx, fill, local.x, local.y, this.opt('opacity') ?? 1);
      else drawBlended(ctx, fill, local.x, local.y, this.opt('blend') ?? 'normal', this.opt('opacity') ?? 1, { lockTransparency: !!layer.locked.transparency });
    }, { layer, kind: mask ? 'mask' : 'pixels' });
  }

  /** Gradient mode: a new Gradient Fill layer, or the active one redrawn. */
  async liveGradient(d) {
    if (Math.hypot(d.to.x - d.from.x, d.to.y - d.from.y) < 2) return;
    const gradient = { ...this.drawDef(), kind: this.opt('kind') ?? 'linear', reverse: !!this.opt('reverse'), dither: this.opt('dither') !== false, from: [d.from.x, d.from.y], to: [d.to.x, d.to.y] };
    const paint = { type: 'gradient', gradient };
    const layer = this.doc.active;
    if (isLiveGradient(layer) && layer === d.layer && !layer.locked?.all) {
      setLayerProps(this.app, layer, { paint }, 'Edit gradient');
      return;
    }
    this.selStop = -1;
    await this.app.commands.run('layer:new-fill', { kind: 'gradient', paint }, 'api');
  }

  // ---- the on-canvas widget ---------------------------------------------------------------------------------------------

  /** Stop positions along from -> to (reverse flips them). */
  stopPoints(g) {
    const [fx, fy] = g.from, [tx, ty] = g.to;
    return g.stops.map((s, i) => {
      const t = g.reverse ? 1 - s.pos : s.pos;
      return { index: i, x: fx + (tx - fx) * t, y: fy + (ty - fy) * t, color: s.color };
    });
  }

  /**
   * What is under the pointer: an end point, a colour stop, the line, or null. The end points come first (the first
   * and last stops sit on them: dragging there moves the end; `stopsOnly` finds the stop, for a double-click).
   */
  hitWidget(layer, p, { stopsOnly = false } = {}) {
    const g = layer.paint.gradient;
    const z = this.view?.zoom ?? 1;
    const tol = HIT / z;
    const near = (x, y) => Math.hypot(p.x - x, p.y - y) <= tol;
    if (!stopsOnly) {
      if (near(g.to[0], g.to[1])) return { type: 'to' };
      if (near(g.from[0], g.from[1])) return { type: 'from' };
    }
    let best = null;
    for (const s of this.stopPoints(g)) {
      const d = Math.hypot(p.x - s.x, p.y - s.y);
      if (d <= tol && (!best || d < best.d)) best = { type: 'stop', index: s.index, d };
    }
    if (best) return { type: 'stop', index: best.index };
    if (stopsOnly) return null;
    const [fx, fy] = g.from, [tx, ty] = g.to;
    const dx = tx - fx, dy = ty - fy;
    const l2 = dx * dx + dy * dy || 1;
    const t = ((p.x - fx) * dx + (p.y - fy) * dy) / l2;
    if (t > 0 && t < 1 && Math.abs((p.x - fx) * dy - (p.y - fy) * dx) / Math.sqrt(l2) <= tol) return { type: 'line', t };
    return null;
  }

  moveWidget(p) {
    const e = this.edit;
    const sp = this.app.snap?.point(p, { source: 'gradient', pointer: p, view: this.view }) ?? p; // snap (lib/snap.js)
    const g0 = e.original.gradient;
    const dx = sp.x - e.start.x, dy = sp.y - e.start.y;
    if (!e.moved && Math.hypot(dx, dy) * (this.view?.zoom ?? 1) < 3) return;
    e.moved = true;
    let g = { ...g0 };
    if (e.type === 'from') g.from = [sp.x, sp.y];
    else if (e.type === 'to') g.to = [sp.x, sp.y];
    else if (e.type === 'line') {
      g.from = [g0.from[0] + dx, g0.from[1] + dy];
      g.to = [g0.to[0] + dx, g0.to[1] + dy];
    } else if (e.type === 'stop') {
      const [fx, fy] = g0.from, [tx, ty] = g0.to;
      const vx = tx - fx, vy = ty - fy;
      const l2 = vx * vx + vy * vy || 1;
      let t = Math.min(1, Math.max(0, ((p.x - fx) * vx + (p.y - fy) * vy) / l2));
      const off = Math.abs((p.x - fx) * vy - (p.y - fy) * vx) / Math.sqrt(l2);
      e.away = off * (this.view?.zoom ?? 1) > AWAY && g0.stops.length > 2;
      if (g0.reverse) t = 1 - t;
      const stops = g0.stops.map((s, i) => (i === e.index ? { ...s, pos: t } : { ...s }));
      g = { ...g0, stops: e.away ? stops.filter((_, i) => i !== e.index) : stops };
    }
    if (p.shift && (e.type === 'from' || e.type === 'to')) {
      // Shift constrains the line to 45° steps around the other end
      const [ax, ay] = e.type === 'to' ? g.from : g.to;
      const [bx, by] = e.type === 'to' ? g.to : g.from;
      const ang = Math.round(Math.atan2(by - ay, bx - ax) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(bx - ax, by - ay);
      const q = [ax + Math.cos(ang) * len, ay + Math.sin(ang) * len];
      if (e.type === 'to') g.to = q;
      else g.from = q;
    }
    // a draft while dragging (a Canvas gradient through samples of the model); the release renders in full
    this.preview(e.layer, draft({ ...e.original, gradient: g }));
  }

  preview(layer, paint) {
    layer.paint = paint;
    layer.touch();
    this.doc.changed('props', { layer });
  }

  endWidget(p) {
    const e = this.edit;
    this.edit = null;
    const layer = e.layer;
    const after = { ...layer.paint, gradient: { ...layer.paint.gradient } };
    delete after.gradient._draft;
    this.preview(layer, e.original);
    if (p.cancelled) return;
    let paint = after;
    if (!e.moved && e.type === 'line') {
      // a click on the line adds a colour stop there, in the colour the gradient has at that point
      const g = e.original.gradient;
      const pos = g.reverse ? 1 - e.t : e.t;
      const c = sampleGradient(g, pos);
      const stops = [...g.stops.map((s) => ({ ...s })), { pos, mid: 0.5, color: rgbaToHex([Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), 1]) }].sort((a, b) => a.pos - b.pos);
      paint = { ...e.original, gradient: { ...g, stops } };
      this.selStop = stops.findIndex((s) => s.pos === pos);
    } else if (!e.moved) return;
    if (e.type === 'stop') {
      // keep the stop list sorted; the moved stop stays selected
      const moved = paint.gradient.stops[e.index];
      const stops = paint.gradient.stops.slice().sort((a, b) => a.pos - b.pos);
      paint = { ...paint, gradient: { ...paint.gradient, stops } };
      this.selStop = e.away ? -1 : stops.indexOf(moved);
    }
    setLayerProps(this.app, layer, { paint }, e.type === 'stop' && e.away ? 'Delete gradient stop' : 'Edit gradient');
  }

  async onDoubleClick(p) {
    if (this.mode() !== 'gradient') return;
    const layer = this.doc?.active;
    if (!isLiveGradient(layer)) return;
    const hit = this.hitWidget(layer, p, { stopsOnly: true });
    if (hit?.type !== 'stop') return;
    const g = layer.paint.gradient;
    const stop = g.stops[hit.index];
    const hex = await this.app.pickColor?.(typeof stop.color === 'string' ? stop.color : '#000000', { title: 'Color Picker (Stop Color)' });
    if (!hex || layer.paint.gradient !== g) return;
    const stops = g.stops.map((s, i) => (i === hit.index ? { ...s, color: rgbaToHex(parseColor(hex)) } : s));
    setLayerProps(this.app, layer, { paint: { ...layer.paint, gradient: { ...g, stops } } }, 'Edit gradient');
  }

  onKeyDown(e) {
    if (this.mode() !== 'gradient' || this.selStop < 0 || (e.key !== 'Delete' && e.key !== 'Backspace')) return false;
    const layer = this.doc?.active;
    if (!isLiveGradient(layer)) return false;
    const g = layer.paint.gradient;
    if (g.stops.length <= 2 || !g.stops[this.selStop]) return false;
    const stops = g.stops.filter((_, i) => i !== this.selStop);
    this.selStop = -1;
    setLayerProps(this.app, layer, { paint: { ...layer.paint, gradient: { ...g, stops } } }, 'Delete gradient stop');
    return true;
  }

  cancel() {
    if (this.edit) {
      this.preview(this.edit.layer, this.edit.original);
      this.edit = null;
      return true;
    }
    if (this.drag) {
      this.drag = null;
      return true;
    }
    return false;
  }

  drawOverlay(ctx, view) {
    if (this.drag) {
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
      return;
    }
    const layer = this.doc?.active;
    if (this.mode() !== 'gradient' || !isLiveGradient(layer) || !layer.visible) return;
    const g = layer.paint.gradient;
    const a = view.toScreen(g.from[0], g.from[1]), b = view.toScreen(g.to[0], g.to[1]);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.stroke();
    // end points: the start a filled circle, the end a ring
    for (const [pt, filled] of [[a, true], [b, false]]) {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = filled ? '#fff' : 'rgba(0,0,0,0.35)';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#000';
      ctx.stroke();
    }
    // colour stops: squares in their colour on the line
    for (const s of this.stopPoints(g)) {
      const q = view.toScreen(s.x, s.y);
      ctx.fillStyle = typeof s.color === 'string' ? s.color : '#000';
      ctx.fillRect(q.x - 5, q.y - 5, 10, 10);
      ctx.lineWidth = s.index === this.selStop ? 2.5 : 1.5;
      ctx.strokeStyle = s.index === this.selStop ? '#1e90ff' : '#fff';
      ctx.strokeRect(q.x - 5, q.y - 5, 10, 10);
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#000';
      ctx.strokeRect(q.x - 6.5, q.y - 6.5, 13, 13);
    }
    ctx.restore();
  }
}

/** Adds ±1 ordered noise to break 8-bit banding (0.3's dither of Canvas gradients). */
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
  // the gradients preset kind with its groups (replaces the skeleton's registration; user entries are kept)
  registerGradientKind();
  installGradientPaint(app);
  const tool = new GradientTool(app);
  // 0.3 stored the preset as an index: keep the preset it named
  const legacy = legacyPresetId(app.settings.tools?.gradient?.preset);
  if (legacy) app.tools.setOpt('gradient', 'preset', legacy, { silent: true });
  app.tools.register(tool, 'fill');
}
