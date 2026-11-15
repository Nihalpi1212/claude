// Painting tools: brush, pencil, eraser (and the shared stroke plumbing used by clone/heal/retouch).
//
// 0.5 (ARCHITECTURE.md "0.5 features", S1.3, S3): the pointer handlers go through `this.gesture`
// (lib/tools/paint-gesture.js, brush-painting-behaviours'), which calls strokeDown / strokeMove / strokeUp, 0.4's
// handler bodies; the stroke settings come from the tool's brush (lib/brush/tool-brush.js); the cursor is
// lib/brush-cursor.js'. Subclasses spread baseSettings and override keys exactly as in 0.4.
//
// brush-painting-behaviours: strokeDown(p, { erase }) paints with the tool's own brush as an eraser (the held tilde,
// for the tools with tildeErases); Left / Right arrows turn the tip by 1 degree (Shift: 15); Escape and the overlay
// ask the gesture first (the resize HUD).
import { Tool } from '../tools.js';
import { BRUSH_OPTIONS, PAINT_BLEND_OPTIONS, PENCIL_SIZE } from '../brush/options.js';
import { BrushStroke, strokeReach } from '../brush.js';
import { toolBrush, supportsBrush } from '../brush/tool-brush.js';
import { legacyTip } from '../brush/preset.js';
import { PaintGesture } from './paint-gesture.js';
import { drawBrushCursor, brushCursorCss } from '../brush-cursor.js';

const BLEND_OPTIONS = PAINT_BLEND_OPTIONS;

/** Common pointer plumbing for dab-based tools. Subclasses implement strokeSettings(point). */
export class StrokeTool extends Tool {
  constructor(app, def) {
    super(app, { cursor: 'none', ...def });
    this.stroke = null;
    this.gesture = new PaintGesture(this);
  }
  get cursorStyle() {
    return brushCursorCss(this);
  }
  // S3.1: the gesture layer owns the pointer; 0.4's handler bodies are strokeDown / strokeMove / strokeUp
  claimsPress(p) {
    return this.gesture.claims(p);
  }
  onPointerDown(p) {
    this.gesture.down(p);
  }
  onPointerMove(p, dragging) {
    this.gesture.move(p, dragging);
  }
  onPointerUp(p) {
    this.gesture.up(p);
  }
  onContextMenu(p) {
    return this.gesture.contextDown(p);
  }
  /** Keys while the tool is active (shortcuts.js asks first): the gesture's (Escape ends a HUD), the tip's angle. */
  onKeyDown(e) {
    if (this.gesture.key?.(e)) return true;
    return rotateTipKey(this, e);
  }
  /** Target canvas: the active layer's mask when mask editing is on, else the layer canvas. */
  strokeTarget(layer) {
    if (this.app.ui.editingMask && layer.mask?.canvas) return { canvas: layer.mask.canvas, x: 0, y: 0, mask: true };
    return { canvas: layer.canvas, x: layer.x, y: layer.y, mask: false };
  }
  /** How far from the pointer this tool's stroke can put pixels (the tip size, plus what modifiers add, S2.6). */
  strokeReach() {
    const { preset, paint } = toolBrush(this.app, this.id);
    return strokeReach(preset, paint);
  }
  ensureCoverage(layer, point, reach = this.strokeReach()) {
    if (this.app.ui.editingMask && layer.mask?.canvas) return;
    if (layer.type !== 'raster') return;
    // brush (lib/brush.js): the layer grows by the stroke's reach (0.4: the tool's size)
    const size = reach;
    const r = { x: point.x - size, y: point.y - size, width: size * 2, height: size * 2 };
    // keep painting inside the document bounds only (layers never need to exceed the canvas)
    const d = this.doc.bounds;
    const clipped = { x: Math.max(d.x, r.x), y: Math.max(d.y, r.y), width: Math.min(d.x + d.width, r.x + r.width) - Math.max(d.x, r.x), height: Math.min(d.y + d.height, r.y + r.height) - Math.max(d.y, r.y) };
    if (clipped.width > 0 && clipped.height > 0) layer.ensureCovers(clipped);
  }
  strokeDown(p, opts = {}) {
    const layer = this.paintableLayer();
    if (!layer) return;
    if (layer.type !== 'raster' && !(this.app.ui.editingMask && layer.mask)) {
      this.app.rasterizePrompt(layer); // the button is up by the time it is answered: paint again
      return;
    }
    // the reach is read once per stroke: it does not change while the pointer is down
    this.reach = this.strokeReach();
    this.ensureCoverage(layer, p, this.reach);
    const target = this.strokeTarget(layer);
    const settings = this.strokeSettings(p, layer, target);
    if (!settings) return;
    // the held tilde: this tool's brush erases (as the Eraser tool does: to the background colour where the layer
    // keeps its transparency, hiding on a mask)
    if (opts.erase) Object.assign(settings, eraseSettings(this.app, layer, target));
    this.stroke = new BrushStroke({ target, layer, settings, selection: this.doc.selection?.isEmpty === false ? this.doc.selection : null, history: this.doc.history, onDirty: (rect, layer) => this.view?.invalidate(rect, layer) });
    this.stroke.begin(p);
  }
  strokeMove(p, dragging) {
    if (dragging && this.stroke) {
      if (this.stroke.layer.type === 'raster' && !this.stroke.target.mask) {
        const before = { x: this.stroke.layer.x, y: this.stroke.layer.y, w: this.stroke.layer.canvas.width, h: this.stroke.layer.canvas.height };
        this.ensureCoverage(this.stroke.layer, p, this.reach ?? this.strokeReach());
        const l = this.stroke.layer;
        if (l.canvas !== this.stroke.canvas) {
          // the layer canvas grew: migrate the stroke buffers to the new geometry
          this.stroke.migrate({ canvas: l.canvas, x: l.x, y: l.y }, before);
        }
      }
      this.stroke.extend(p);
    }
  }
  strokeUp(p) {
    if (!this.stroke) return;
    // smoothing lags behind the pointer: finish the stroke at the release point
    if (p && !p.cancelled && Number.isFinite(p.x)) this.stroke.finish(p);
    this.stroke.end();
    this.stroke = null;
  }
  cancel() {
    if (this.gesture.cancel()) return true;
    if (this.stroke) {
      this.stroke.cancel();
      this.stroke = null;
      return true;
    }
    return false;
  }
  drawOverlay(ctx, view) {
    if (this.gesture.drawOverlay?.(ctx, view)) return;
    drawBrushCursor(ctx, view, this);
  }
  /** Document position of a point given in the stroke canvas's coordinates (the canvas grows during a stroke). */
  docPoint(lx, ly, fallback) {
    const t = this.stroke?.target ?? fallback;
    return [lx + t.x, ly + t.y];
  }
  /**
   * 0.4's flat stroke settings, built from the tool's brush (S1.3): the tip keys, the ToolPaint fields, the preset.
   * Subclasses spread it and override keys as in 0.4; the flat keys win over the preset (S2.2). brush
   * (lib/brush/tool-brush.js)
   */
  baseSettings(layer, target) {
    const s = this.app.settings;
    const maskValue = this.app.ui.editingMask ? luminanceOf(s.foreground) : 1;
    const { preset, paint } = toolBrush(this.app, this.id);
    return {
      ...legacyTip(preset),
      ...paint,
      preset,
      color: s.foreground,
      background: s.background,
      mode: target.mask ? 'mask' : 'paint',
      maskValue,
      lockTransparency: !target.mask && (layer.locked.transparency || this.opt('lockAlpha')),
      antialias: true,
      view: this.view,
    };
  }
}

/** What a stroke changes to erase with the tool's own brush (the held tilde). */
function eraseSettings(app, layer, target) {
  if (target.mask) return { mode: 'mask', maskValue: 0, blend: 'normal' };
  if (layer.locked?.transparency) return { mode: 'paint', color: app.settings.background, blend: 'normal' };
  return { mode: 'erase', blend: 'normal' };
}

/** Left / Right arrow: the tip turns 1 degree (Shift: 15), clockwise with Right; tools with a full brush only. */
function rotateTipKey(tool, e) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return false;
  if (e.ctrlKey || e.metaKey || e.altKey || supportsBrush(tool) !== 'full') return false;
  if (e.repeat && tool.stroke) return true;
  const step = (e.shiftKey ? 15 : 1) * (e.key === 'ArrowRight' ? 1 : -1);
  const angle = Number(tool.opt('angle') ?? toolBrush(tool.app, tool.id).preset.tip.angle) || 0;
  tool.setOpt('angle', wrapAngle(angle + step));
  return true;
}

/** An angle in -180..180 (the BrushPreset range). */
export function wrapAngle(a) {
  let v = ((((a + 180) % 360) + 360) % 360) - 180;
  if (v === -180 && a > 0) v = 180;
  return Math.round(v * 1000) / 1000;
}

function luminanceOf(hex) {
  const n = parseInt(String(hex).slice(1, 7), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

export class BrushTool extends StrokeTool {
  constructor(app) {
    super(app, {
      id: 'brush',
      name: 'Brush Tool',
      icon: 'brush',
      hint: 'Paint with the foreground colour. [ and ] change the size, Shift+[ ] the hardness. Alt-click samples a colour.',
      options: [...BRUSH_OPTIONS, { kind: 'select', key: 'blend', label: 'Mode', options: BLEND_OPTIONS, default: 'normal' }, { kind: 'checkbox', key: 'lockAlpha', label: 'Lock alpha', default: false }],
    });
    this.tildeErases = true;
  }
  strokeDown(p, opts) {
    if (p.alt) return this.app.tools.get('eyedropper')?.sampleAt(p, { setForeground: true });
    super.strokeDown(p, opts);
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
        { ...PENCIL_SIZE },
        { kind: 'slider', key: 'opacity', label: 'Opacity', min: 0.01, max: 1, step: 0.01, default: 1 },
        { kind: 'select', key: 'blend', label: 'Mode', options: BLEND_OPTIONS, default: 'normal' },
        { kind: 'checkbox', key: 'autoErase', label: 'Auto erase', default: false },
      ],
    });
    this.tildeErases = true;
  }
  strokeDown(p, opts) {
    if (p.alt) return this.app.tools.get('eyedropper')?.sampleAt(p, { setForeground: true });
    super.strokeDown(p, opts);
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
  /** Block mode erases with a 16 px hard dab whatever the brush: the cursor shows that. */
  cursorTip() {
    if (this.opt('mode') !== 'block') return null;
    return { kind: 'computed', size: 16, hardness: 1, angle: 0, roundness: 1, flipX: false, flipY: false };
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
    const snap = this.opt('eraseToHistory') ? this.doc.history.savedSnapshot?.() : null;
    if (snap && snap.width === this.doc.width && snap.height === this.doc.height) {
      // erase to the image as it was when opened or last saved
      s.mode = 'paint';
      s.blend = 'normal';
      s.sampler = (tctx, lx, ly, w, h) => {
        const [dx, dy] = this.docPoint(lx, ly, target);
        tctx.drawImage(snap, Math.round(dx), Math.round(dy), w, h, 0, 0, w, h);
      };
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
