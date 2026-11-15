# The step-4 edits, run by apply-step4.py (patch, cut and R come from there).

# ---- lib/brush.js: the facade; BrushStroke moves to lib/brush/engine.js; dabCanvas's pixel budget (S2.1, S2.8) ----
BRUSH_HEAD = '''// Brush engine facade (ARCHITECTURE.md "0.5 features", S2.1): every caller imports the engine from here. The engine
// itself (BrushStroke, traceDabs, the modifier chain, tips, reach, previews) is lib/brush/engine.js, re-exported
// below; this file keeps the dab cache (dabCanvas) and the two blend helpers the fill tools and Edit > Fill use.
import { CANVAS_BLEND, blendImages } from '../../shared/pixels/blend.js';
import { createCanvas } from './document.js';
import { parseColor } from '../../shared/pixels/color.js';

// BrushStroke, ENGINE, normalizeSample, traceDabs, registerDabModifier, dabModifiers, registerTipKind, tipOutline,
// renderTip, strokeReach, renderStrokePreview, and whatever the engine adds
export * from './brush/engine.js';

// S2.8: the cache is bounded by the pixels it holds (a 5000 px dab is 25 MP), not by a count of entries
const dabCache = new Map();
const DAB_CACHE_PIXELS = 64 * 1024 * 1024;
let dabCachePixels = 0;

/**
 * Diameter in whole pixels of the canvas for a dab of `size`: 0.4's ceiling up to 128 px (every golden dab), above that
 * the size rounded up to a 1 % step, so a pressure ramp on a large brush does not fill the cache with near-equal dabs.
 */
function dabDiameter(size) {
  const d = Math.max(1, Math.ceil(size));
  if (d <= 128) return d;
  const step = Math.log(1.01);
  return Math.max(129, Math.ceil(Math.exp(Math.ceil(Math.log(d) / step - 1e-9) * step) - 1e-9));
}

'''
patch('lib/brush.js', [
    cut('// Brush engine (see ARCHITECTURE.md "Brush engine")', '/** A soft or hard round dab canvas', BRUSH_HEAD),
    ('''  const d = Math.max(1, Math.ceil(size));
  const key = `${d}|${Math.round(hardness * 100)}|${color}|${aliased ? 'a' : 's'}`;''',
     '''  const d = dabDiameter(size);
  const key = `${d}|${Math.round(hardness * 100)}|${color}|${aliased ? 'a' : 's'}`;'''),
    ('''  if (dabCache.size > 200) dabCache.delete(dabCache.keys().next().value);
  dabCache.set(key, c);
  return c;''',
     '''  const px = c.width * c.height;
  while (dabCache.size && dabCachePixels + px > DAB_CACHE_PIXELS) {
    const [k, old] = dabCache.entries().next().value;
    dabCache.delete(k);
    dabCachePixels -= old.width * old.height;
  }
  dabCache.set(key, c);
  dabCachePixels += px;
  return c;'''),
    cut('/**\n * One brush stroke.', '/**\n * Draws a fill canvas onto ctx'),
], marker="export * from './brush/engine.js';")

# ---- lib/tools/paint.js: gesture split, claimsPress, baseSettings from toolBrush, reach, cursor (S1.3, S3) ----
PAINT_HEAD = """// Painting tools: brush, pencil, eraser (and the shared stroke plumbing used by clone/heal/retouch).
//
// 0.5 (ARCHITECTURE.md "0.5 features", S1.3, S3): the pointer handlers go through `this.gesture`
// (lib/tools/paint-gesture.js, brush-painting-behaviours'), which calls strokeDown / strokeMove / strokeUp, 0.4's
// handler bodies; the stroke settings come from the tool's brush (lib/brush/tool-brush.js); the cursor is
// lib/brush-cursor.js'. Subclasses spread baseSettings and override keys exactly as in 0.4.
import { Tool } from '../tools.js';
import { BRUSH_OPTIONS, PAINT_BLEND_OPTIONS, PENCIL_SIZE } from '../brush/options.js';
import { BrushStroke, strokeReach } from '../brush.js';
import { toolBrush } from '../brush/tool-brush.js';
import { legacyTip } from '../brush/preset.js';
import { PaintGesture } from './paint-gesture.js';
import { drawBrushCursor, brushCursorCss } from '../brush-cursor.js';

const BLEND_OPTIONS = PAINT_BLEND_OPTIONS;

"""
PAINT_BASE = """  /**
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

"""
patch('lib/tools/paint.js', [
    cut('// Painting tools: brush, pencil, eraser', '/** Common pointer plumbing', PAINT_HEAD),
    ("""  constructor(app, def) {
    super(app, { cursor: 'none', ...def });
    this.stroke = null;
  }
  get cursorStyle() {
    return this.app.settings.cursorStyle === 'precise' ? 'crosshair' : 'none';
  }""", """  constructor(app, def) {
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
  }"""),
    ("""  ensureCoverage(layer, point) {
    if (this.app.ui.editingMask && layer.mask?.canvas) return;
    if (layer.type !== 'raster') return;
    const size = this.opt('size') ?? 24;
    const r = { x: point.x - size, y: point.y - size, width: size * 2, height: size * 2 };""", """  /** How far from the pointer this tool's stroke can put pixels (the tip size, plus what modifiers add, S2.6). */
  strokeReach() {
    const { preset, paint } = toolBrush(this.app, this.id);
    return strokeReach(preset, paint);
  }
  ensureCoverage(layer, point, reach = this.strokeReach()) {
    if (this.app.ui.editingMask && layer.mask?.canvas) return;
    if (layer.type !== 'raster') return;
    // brush (lib/brush.js): the layer grows by the stroke's reach (0.4: the tool's size)
    const size = reach;
    const r = { x: point.x - size, y: point.y - size, width: size * 2, height: size * 2 };"""),
    ("""  onPointerDown(p) {
    const layer = this.paintableLayer();
    if (!layer) return;
    if (layer.type !== 'raster' && !(this.app.ui.editingMask && layer.mask)) {
      this.app.rasterizePrompt(layer); // the button is up by the time it is answered: paint again
      return;
    }
    this.ensureCoverage(layer, p);""", """  strokeDown(p) {
    const layer = this.paintableLayer();
    if (!layer) return;
    if (layer.type !== 'raster' && !(this.app.ui.editingMask && layer.mask)) {
      this.app.rasterizePrompt(layer); // the button is up by the time it is answered: paint again
      return;
    }
    // the reach is read once per stroke: it does not change while the pointer is down
    this.reach = this.strokeReach();
    this.ensureCoverage(layer, p, this.reach);"""),
    ("""  onPointerMove(p, dragging) {
    if (dragging && this.stroke) {
      if (this.stroke.layer.type === 'raster' && !this.stroke.target.mask) {
        const before = { x: this.stroke.layer.x, y: this.stroke.layer.y, w: this.stroke.layer.canvas.width, h: this.stroke.layer.canvas.height };
        this.ensureCoverage(this.stroke.layer, p);""", """  strokeMove(p, dragging) {
    if (dragging && this.stroke) {
      if (this.stroke.layer.type === 'raster' && !this.stroke.target.mask) {
        const before = { x: this.stroke.layer.x, y: this.stroke.layer.y, w: this.stroke.layer.canvas.width, h: this.stroke.layer.canvas.height };
        this.ensureCoverage(this.stroke.layer, p, this.reach ?? this.strokeReach());"""),
    ("""  onPointerUp(p) {
    if (!this.stroke) return;
    if (p && !p.cancelled && Number.isFinite(p.x)) {
      // smoothing lags behind the pointer: finish the stroke at the release point
      const smoothing = this.stroke.s.smoothing;
      this.stroke.s.smoothing = 0;
      this.stroke.extend(p);
      this.stroke.s.smoothing = smoothing;
    }
    this.stroke.end();
    this.stroke = null;
  }""", """  strokeUp(p) {
    if (!this.stroke) return;
    // smoothing lags behind the pointer: finish the stroke at the release point
    if (p && !p.cancelled && Number.isFinite(p.x)) this.stroke.finish(p);
    this.stroke.end();
    this.stroke = null;
  }"""),
    cut("  drawOverlay(ctx, view) {\n    if (!view.pointer || this.app.settings.cursorStyle === 'precise') return;", "  /** Document position of a point given in the stroke canvas's coordinates", """  drawOverlay(ctx, view) {
    drawBrushCursor(ctx, view, this);
  }
"""),
    cut("  baseSettings(layer, target) {", "function luminanceOf(hex)", PAINT_BASE),
    cut("// migrate strokes when the layer canvas grows (new canvas + offset)", "export class BrushTool extends StrokeTool"),
    (lambda s: s.replace("""  onPointerDown(p) {
    if (p.alt) return this.app.tools.get('eyedropper')?.sampleAt(p, { setForeground: true });
    super.onPointerDown(p);
  }""", """  strokeDown(p) {
    if (p.alt) return this.app.tools.get('eyedropper')?.sampleAt(p, { setForeground: true });
    super.strokeDown(p);
  }""")),
    ("{ kind: 'slider', key: 'size', label: 'Size', min: 1, max: 500, step: 1, default: 3, unit: 'px' },", "{ ...PENCIL_SIZE },"),
], marker='this.gesture = new PaintGesture(this);')

# ---- lib/tools/retouch.js, adjustment-brush.js: the S3.1 renames under the inherited gesture ----
def rename_stroke_handlers(s):
    import re
    out = []
    for blk in re.split(r'(?m)^(?=class )', s):
        m = re.match(r'class (\w+) extends (\w+)', blk)
        if m and m.group(2) in ('DabTool', 'StrokeTool'):
            blk = re.sub(r'(?m)^  onPointerDown\(', '  strokeDown(', blk)
            blk = re.sub(r'(?m)^  onPointerMove\(', '  strokeMove(', blk)
            blk = re.sub(r'(?m)^  onPointerUp\(', '  strokeUp(', blk)
            blk = blk.replace('super.onPointerDown(', 'super.strokeDown(').replace('super.onPointerMove(', 'super.strokeMove(').replace('super.onPointerUp(', 'super.strokeUp(')
        out.append(blk)
    return ''.join(out)

patch('lib/tools/retouch.js', [
    ("import { Tool, BRUSH_OPTIONS } from '../tools.js';", "import { Tool, BRUSH_OPTIONS } from '../tools.js'; // BRUSH_OPTIONS: lib/brush/options.js (5000 px); SIZE below stays 1000 (S2.7)"),
    rename_stroke_handlers,
], marker='SIZE below stays 1000 (S2.7)')

patch('lib/tools/adjustment-brush.js', [
    ("  onPointerDown(p) {\n    const d = this.doc;", "  strokeDown(p) {\n    const d = this.doc;"),
    ("  onPointerUp(p) {\n    super.onPointerUp(p);", "  strokeUp(p) {\n    super.strokeUp(p);"),
], marker='  strokeDown(p) {\n    const d = this.doc;')

# ---- lib/tools/vector.js strokePathPixels: spacing and growth from the tool's brush (S2.7) ----
patch('lib/tools/vector.js', [
    ("import { BrushStroke } from '../brush.js';", "import { BrushStroke, strokeReach } from '../brush.js';\nimport { toolBrush } from '../brush/tool-brush.js';"),
    ("""  const pb = pathBounds(path);
  if (!pb) return false;
  if (!t.mask) {
    const grow = intersectRect({ x: pb.x - size, y: pb.y - size, width: pb.width + size * 2, height: pb.height + size * 2 }, doc.bounds);""",
     """  const pb = pathBounds(path);
  if (!pb) return false;
  // brush (lib/brush.js): the tool's brush gives the spacing and how far the stroke reaches (0.4: the size)
  const brush = toolBrush(app, src);
  const reach = strokeReach({ ...brush.preset, tip: { ...brush.preset.tip, size } }, brush.paint);
  if (!t.mask) {
    const grow = intersectRect({ x: pb.x - reach, y: pb.y - reach, width: pb.width + reach * 2, height: pb.height + reach * 2 }, doc.bounds);"""),
    ("    spacing: Math.min(0.12, app.settings.brush?.spacing ?? 0.12),", "    spacing: Math.min(0.12, brush.preset.tip.spacing),"),
], marker="import { toolBrush } from '../brush/tool-brush.js';")

# ---- lib/panels/brushes.js: the hook removed, the preview through the engine, per-tool spacing, picks via setToolBrush ----
BRUSHES_HEAD = """// Brushes panel (top group): brush tip presets (built-in + settings.brushPresets), sliders for
// size / hardness / spacing / angle / roundness / flow and a live stroke preview. Everything applies
// to the active painting tool (or the last one used). Also provides app.brushPicker.show(anchor, tool),
// the popover behind the options bar's brush button.
//
// brush-settings-panel's file (ARCHITECTURE.md "0.5 features"); the skeleton landed first: the tool's brush is
// lib/brush/tool-brush.js (S1.3): size, hardness, angle, roundness and the per-tool flat spacing are tool settings,
// a pick goes through setToolBrush (so the tool remembers which preset it came from), and the stroke preview is the
// engine's renderStrokePreview (S2.6). 0.4's angle/roundness hook on StrokeTool is gone: baseSettings passes them.
import { icon } from '../icons.js';
import { dabCanvas, renderStrokePreview } from '../brush.js';
import { StrokeTool } from '../tools/paint.js';
import { toolBrush, setToolBrush } from '../brush/tool-brush.js';
import { brushFromLegacy } from '../brush/preset.js';

"""
BRUSHES_STROKE = """/** Sample stroke (an S curve) painted by the engine itself (renderStrokePreview), at flow, shown at opacity. */
function drawStroke(canvas, s) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = Math.max(10, canvas.clientWidth || 260);
  const w = Math.max(10, Math.round(cssW * dpr));
  const h = Math.round(64 * dpr);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const preset = brushFromLegacy({ size: Math.max(1, Math.min(s.size, 44)), hardness: s.hardness, spacing: s.spacing ?? 0.12, angle: s.angle ?? 0, roundness: s.roundness ?? 1 });
  const stroke = renderStrokePreview(preset, { flow: Math.max(0.01, s.flow ?? 1), opacity: Math.max(0.01, s.opacity ?? 1) }, { width: w / dpr, height: 64, scale: dpr, color: themeInk() });
  ctx.drawImage(stroke, 0, 0);
}

"""
patch('lib/panels/brushes.js', [
    cut('// Brushes panel (top group)', 'export const BUILTIN_BRUSHES', BRUSHES_HEAD),
    cut('// ---- engine hook: pass angle/roundness tool options', '// ---- drawing helpers'),
    cut('/** Sample stroke (an S curve) painted like the engine', '// ---- values ----', BRUSHES_STROKE),
    ("""  const get = (tool, key) => {
    if (!tool) return DEFAULTS[key];
    if (key === 'spacing') return app.settings.brush?.spacing ?? DEFAULTS.spacing;""", """  const get = (tool, key) => {
    if (!tool) return DEFAULTS[key];
    if (key === 'spacing') return toolBrush(app, tool.id).preset.tip.spacing; // brush (lib/brush/tool-brush.js)"""),
    ("""    if (key === 'spacing') {
      app.saveSettingsSoon({ brush: { ...(app.settings.brush ?? {}), spacing: value } });
      app.emit('tool:options', { tool: tool.id, key, value });
      return;
    }""", """    if (key === 'spacing') {
      // brush (lib/brush/tool-brush.js): the tool's own flat spacing (0.4: one settings.brush.spacing for every tool)
      app.tools.setOpt(tool.id, 'spacing', Math.max(0.01, Math.min(10, value)));
      return;
    }"""),
    ("""  const applyPreset = (preset, tool = target()) => {
    if (!tool) return;
    set(tool, 'size', preset.size);
    set(tool, 'hardness', preset.hardness ?? DEFAULTS.hardness);
    set(tool, 'flow', preset.flow ?? 1);
    set(tool, 'spacing', preset.spacing ?? DEFAULTS.spacing);
    set(tool, 'angle', preset.angle ?? 0);
    set(tool, 'roundness', preset.roundness ?? 1);
    app.emit('brush:preset', { tool: tool.id, preset });
  };""", """  const applyPreset = (preset, tool = target()) => {
    if (!tool) return;
    // brush (lib/brush/tool-brush.js): one write of the tool's brush, its flat keys and the preset id (S1.3); a
    // 0.4 preset's flow is its tool flow
    setToolBrush(app, tool.id, brushFromLegacy(preset), { presetId: preset.id ?? null });
    app.emit('brush:preset', { tool: tool.id, preset });
  };"""),
    ("  installTipHook();\n", ""),
], marker='renderStrokePreview')

# ---- lib/preset-kinds.js: registerPresetKinds05 with `brushes` (S1.2, S10.5) ----
PK05 = """
/**
 * The preset kinds of 0.5 (ARCHITECTURE.md "0.5 features", S10.5), registered with registerPresetKinds04() in
 * start(). Their owners re-register them with their full definitions. Step 4 of the skeleton registers `brushes`;
 * step 10 adds the others.
 */
export function registerPresetKinds05() {
  registerPresetKind('brushes', {
    title: 'Brushes',
    version: 1,
    // 0.4's Brushes panel presets under their 0.4 ids (a preset's flow is its tool flow, S1.1)
    builtins: () => ({ presets: BUILTIN_BRUSHES.map((b) => ({ id: b.id, name: b.name, data: withoutSampleData(brushFromLegacy(b)) })) }),
    normalize: (data) => (isObject(data) ? withoutSampleData(normalizeBrush(data)) : null),
    blobs: (data) => blobsOf(data),
  });
}
"""
patch('lib/preset-kinds.js', [
    ("import { CUSTOM_SHAPES, customPath } from './tools/vector.js';\n", "import { CUSTOM_SHAPES, customPath } from './tools/vector.js';\nimport { BUILTIN_BRUSHES } from './panels/brushes.js';\nimport { normalizeBrush, brushFromLegacy, blobsOf, withoutSampleData } from './brush/preset.js';\n"),
    (lambda s: s.rstrip('\n') + '\n' + PK05),
], marker='export function registerPresetKinds05()')

# ---- lib/canvas-view.js: samples, button 5, press claims, right-button drags, the cursor filter (S2.5, S3.2, S3.3) ----
NORM_NEW = """    // S2.5: every routed pointer event becomes a PointerSample (pen data, the eraser end, Caps Lock, the time)
    const norm = (e) => {
      const r = canvas.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const d = this.toDoc(sx, sy);
      const pen = e.pointerType === 'pen';
      // temporary: the modifier that summoned a temporary tool (view.tempToolVia, set with view.tempTool by
      // conventions' temp-tools.js), so snap.js does not read that held Ctrl as "do not snap" (F)
      return normalizeSample({
        x: d.x, y: d.y, screenX: sx, screenY: sy,
        pressure: pen && e.pressure > 0 ? e.pressure : 1,
        tiltX: e.tiltX ?? 0, tiltY: e.tiltY ?? 0, twist: e.twist ?? 0, tangentialPressure: e.tangentialPressure ?? 0,
        altitude: Number.isFinite(e.altitudeAngle) ? e.altitudeAngle : undefined, azimuth: Number.isFinite(e.azimuthAngle) ? e.azimuthAngle : undefined,
        pointerType: e.pointerType || 'mouse',
        // the pen's eraser end (button 5 / buttons 32); the side button held during tip contact
        eraser: pen && (e.button === 5 || (e.buttons & 32) !== 0),
        barrel: pen && (e.buttons & 1) !== 0 && (e.buttons & 2) !== 0,
        buttons: e.buttons, button: e.button, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey,
        capsLock: !!e.getModifierState?.('CapsLock'),
        time: e.timeStamp,
        temporary: this.tempTool ? this.tempToolVia ?? null : null,
        original: e,
      });
    };
"""
DOWN_NEW = """      // button 5: the pen's eraser end, a primary press (S2.5)
      const primary = e.button === 0 || e.button === 5;
      if (!primary && e.button !== 2) return;
      // a canvas-capture handler (an armed eyedropper, a dialog letting the canvas through) takes the click before
      // the active tool; panning stays first
      const cap = primary ? capture() : null;
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
      // S3.3 press claims: while a temporary tool is up, the active tool may take the press (a painting gesture such
      // as Alt+right-drag); the temporary tool ends and the whole press goes to the active tool
      if (this.tempTool && this.app.tools?.active?.claimsPress?.(p) === true) this.app.tempTools?.clear();
      dragging = true;
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      if (e.button === 2) {
        const tool = currentTool();
        // S3.3: a tool whose onContextMenu returns true takes the right-button drag
        contextDrag = tool?.onContextMenu?.(p) === true ? tool : null;
        return;
      }
      currentTool()?.onPointerDown?.(p);
      this.invalidate();
    });
"""
patch('lib/canvas-view.js', [
    ("import { UNITS, UNIT_NAMES } from './rulers.js';\n", "import { UNITS, UNIT_NAMES } from './rulers.js';\nimport { normalizeSample } from './brush.js';\n"),
    cut("    const norm = (e) => {", "    let dragging = false;\n    let handDrag = null;", NORM_NEW),
    ("""    let dragging = false;
    let handDrag = null;""", """    let dragging = false;
    let handDrag = null;
    let contextDrag = null; // S3.3: the tool whose onContextMenu took a right-button drag"""),
    cut("      if (e.button !== 0 && e.button !== 2) return;", "    canvas.addEventListener('pointermove', (e) => {", DOWN_NEW),
    ("""        const cap = capturing ?? capture();
        if (cap) {
          cap.move?.(p, this, dragging);
          continue;
        }
        currentTool()?.onPointerMove?.(p, dragging);""", """        const cap = capturing ?? capture();
        if (cap) {
          cap.move?.(p, this, dragging);
          continue;
        }
        if (contextDrag) {
          contextDrag.onPointerMove?.(p, true);
          continue;
        }
        currentTool()?.onPointerMove?.(p, dragging);"""),
    ("""      if (e.button === 2) return;
      currentTool()?.onPointerUp?.(p);""", """      if (contextDrag) {
        const tool = contextDrag;
        contextDrag = null;
        tool.onPointerUp?.({ ...p, button: 2 });
        this.app.snap?.end(); // snap (lib/snap.js)
        this.invalidate();
        return;
      }
      if (e.button === 2) return;
      currentTool()?.onPointerUp?.(p);"""),
    ("""        } else {
          currentTool()?.onPointerCancel?.(norm(e));
          this.app.snap?.end(); // snap (lib/snap.js)
        }
      }
      handDrag = null;""", """        } else {
          const tool = contextDrag ?? currentTool();
          tool?.onPointerCancel?.(norm(e));
          this.app.snap?.end(); // snap (lib/snap.js)
        }
      }
      contextDrag = null;
      handDrag = null;"""),
    ("""  setCursor(cursor) {
    this.canvas.style.cursor = cursor || 'default';
  }""", """  /** Every cursor goes through the toolbox's cursor filter (S3.2: Other Cursors, Caps Lock), whoever sets it. */
  setCursor(cursor) {
    let css = cursor || 'default';
    const filter = this.app.tools?.cursorFilter;
    if (filter) {
      try {
        css = filter(css, { tool: this.tempTool ?? this.app.tools?.active ?? null, view: this }) || css;
      } catch (err) {
        console.warn('cursor filter failed', err);
      }
    }
    this.canvas.style.cursor = css;
  }"""),
], marker='let contextDrag = null;')

# ---- lib/tools.js: BRUSH_OPTIONS re-exported, the cursor filter, the brush button through renderButton (S12.1) ----
patch('lib/tools.js', [
    (lambda s: s[:s.index('/** Shared option specs. */')] + """// Shared option specs: lib/brush/options.js (brush-engine-core's, S12.1) holds them; re-exported for 0.4's importers.
export { BRUSH_OPTIONS, BRUSH_SIZE, PAINT_BLEND_OPTIONS } from './brush/options.js';
"""),
    ("""    this.optionsBar = document.getElementById('options-bar');
    this.optionsControls = new Map();""", """    this.optionsBar = document.getElementById('options-bar');
    this.optionsControls = new Map();
    this.cursorFilter = null; // S3.2: applied by CanvasView.setCursor to every cursor"""),
    ("""  updateCursor() {
    this.app.view?.setCursor(this.active?.cursorStyle);
  }""", """  updateCursor() {
    this.app.view?.setCursor(this.active?.cursorStyle);
  }

  /**
   * S3.2: one filter (the later wins) through which CanvasView.setCursor passes every cursor, fn(css, { tool, view }) →
   * css: Other Cursors (Precise) and Caps Lock (brush-painting-behaviours). null removes it.
   */
  setCursorFilter(fn) {
    this.cursorFilter = typeof fn === 'function' ? fn : null;
    this.updateCursor();
  }"""),
    ("""      case 'brush': {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn small opt-brush';
        const render = () => {""", """      case 'brush': {
        // the Brushes panel's picker draws the button when it can (app.brushPicker.renderButton, brush-settings-panel);
        // else 0.4's button
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn small opt-brush';
        if (typeof this.app.brushPicker?.renderButton === 'function') {
          const render = () => this.app.brushPicker.renderButton(b, tool);
          render();
          b.addEventListener('click', () => this.app.brushPicker?.show(b, tool));
          wrap.appendChild(b);
          control = { button: b, render };
          break;
        }
        const render = () => {"""),
], marker='setCursorFilter(fn)')

# ---- lib/extras.js: the built-in `tools` section's cursorStyle values (S3.2) ----
patch('lib/extras.js', [
    ("""      if ('checkerboardSize' in values) values.checkerboardSize = Number(values.checkerboardSize);
      return values;""", """      if ('checkerboardSize' in values) values.checkerboardSize = Number(values.checkerboardSize);
      if (values.cursorStyle === 'dot') values.cursorStyle = 'standard'; // 0.4's Dot is 0.5's Standard (S3.2)
      return values;"""),
    ("""    { key: 'cursorStyle', label: 'Painting cursor', type: 'select', options: [['outline', 'Brush outline'], ['precise', 'Precise (crosshair)'], ['dot', 'Dot']] },""", """    // S3.2: Photoshop's four painting cursors (lib/brush-cursor.js draws them)
    { key: 'cursorStyle', label: 'Painting cursor', type: 'select', options: [['standard', 'Standard'], ['precise', 'Precise'], ['outline', 'Normal Brush Tip'], ['full', 'Full Size Brush Tip']] },"""),
], marker="0.4's Dot is 0.5's Standard")

# ---- app.js: registerPresetKinds05, installToolBrush before MODULES, the 5000 px cap (S1.3, S2.8) ----
patch('app.js', [
    ("import { PresetStore } from './lib/presets.js';\n", "import { PresetStore } from './lib/presets.js';\nimport { installToolBrush } from './lib/brush/tool-brush.js';\nimport { BRUSH_SIZE } from './lib/brush/options.js';\n"),
    ("""    (await import('./lib/preset-kinds.js')).registerPresetKinds04();""", """    const kinds = await import('./lib/preset-kinds.js');
    kinds.registerPresetKinds04();
    kinds.registerPresetKinds05(); // 0.5 (S10.5): `brushes` (step 4 of the skeleton) and the other 0.5 kinds"""),
    ("""  app.presets.addEventListener('change', (e) => app.emit('presets:changed', e.detail));
""", """  app.presets.addEventListener('change', (e) => app.emit('presets:changed', e.detail));
  // 0.5 (S1.3): each painting tool's brush, the `brushes` migration and tool:brush-preset
  installToolBrush(app);
"""),
    ("""      tool.setOpt('size', Math.max(1, Math.min(2500, v + dir * step)));""", """      // 5000 px (S2.8), or the tool's own cap (the DabTools stop at 1000 px until 0.7, S2.7)
      const max = Math.min(BRUSH_SIZE.max, tool.options.find((o) => o.key === 'size')?.max ?? BRUSH_SIZE.max);
      tool.setOpt('size', Math.max(1, Math.min(max, v + dir * step)));"""),
], marker='installToolBrush(app);')
