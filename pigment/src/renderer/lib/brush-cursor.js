// The painting tools' cursor (ARCHITECTURE.md "0.5 features", S3.2; brush-painting-behaviours). paint.js calls
// drawBrushCursor from StrokeTool.drawOverlay and brushCursorCss for its CSS cursor; paint-keys.js registers
// cursorFilter with app.tools.setCursorFilter, so every cursor the canvas shows passes through it.
//
// Painting cursors (Preferences > Cursors and tools, settings.cursorStyle; 0.4's 'dot' reads as 'standard'):
//   - Standard: a dot at the pointer (Pigment draws no tool icons on the canvas);
//   - Precise: the crosshair;
//   - Normal Brush Tip: the tip's outline where it paints at least half strength (a soft round tip's outline is
//     smaller than its diameter, as in Photoshop);
//   - Full Size Brush Tip: the tip's whole outline.
// The tip is the tool's real one (lib/brush.js tipOutline: angle, roundness, flips, a sampled tip's contour). Caps
// Lock turns any painting cursor into the crosshair. Preferences > Cursors (settings.painting.cursors): a crosshair
// in the tip, only the crosshair while painting, Other Cursors (Precise: the crosshair for the other tools that show
// an arrow), and the colours of the brush preview (the resize HUD) and of the Pulled String leash.
import { tipOutline } from './brush.js';
import { toolBrush } from './brush/tool-brush.js';
import { DEFAULT_SETTINGS } from '../../shared/defaults.js';
import { paintKeyState } from './tools/paint-gesture.js';

const CURSOR_DEFAULTS = DEFAULT_SETTINGS.painting.cursors;
/** Below this on-screen diameter a tip outline would hide the pointer: the crosshair shows instead. */
const MIN_OUTLINE_PX = 6;
/** Tools that keep their own cursor whatever Other Cursors says (navigation, moving, typing, the paths). */
const OWN_CURSOR = new Set(['hand', 'zoom', 'rotate-view', 'move', 'type-horizontal', 'type-vertical', 'path-selection', 'direct-selection']);

/** The painting cursor style from the settings, 0.4's values read as 0.5's. */
export function paintingCursorStyle(app) {
  const v = app.settings?.cursorStyle;
  if (v === 'dot') return 'standard';
  return v === 'standard' || v === 'precise' || v === 'full' ? v : 'outline';
}

/** settings.painting.cursors with its defaults. */
export function cursorPrefs(app) {
  const c = app.settings?.painting?.cursors;
  return { ...CURSOR_DEFAULTS, ...(c && typeof c === 'object' ? c : {}) };
}

/** The painting cursor actually shown: Caps Lock turns every painting cursor into the crosshair (Photoshop). */
export function effectiveCursorStyle(app, { capsLock = paintKeyState.capsLock } = {}) {
  return capsLock ? 'precise' : paintingCursorStyle(app);
}

/** The CSS cursor over the canvas while a painting tool is active. */
export function brushCursorCss(tool) {
  return paintingCursorStyle(tool.app) === 'precise' ? 'crosshair' : 'none';
}

/**
 * Share of the radius inside which a computed tip paints at least half strength: 0.4's dab falls off with a
 * smoothstep from `hardness` to the edge, which crosses 0.5 halfway. Sampled tips' outlines are traced at half
 * coverage already.
 */
export function normalTipScale(tip) {
  if (!tip || (tip.kind && tip.kind !== 'computed')) return 1;
  const h = Math.min(1, Math.max(0, Number(tip.hardness ?? 1)));
  return (1 + h) / 2;
}

// the tool's tip, worked out again only when its settings object changes (setOpt and setToolBrush replace it)
const tipCache = new WeakMap();
const NO_SETTINGS = {};

/** The tip the cursor draws for a tool: its brush's tip with the flat keys applied (tool-brush.js toolBrush). */
export function cursorTip(tool) {
  if (typeof tool.cursorTip === 'function') {
    const own = tool.cursorTip();
    if (own) return own;
  }
  const app = tool.app;
  const key = app.settings?.tools?.[tool.id] ?? NO_SETTINGS;
  let byTool = tipCache.get(key);
  if (!byTool) tipCache.set(key, (byTool = new Map()));
  let tip = byTool.get(tool.id);
  if (!tip || tip.global !== app.settings?.brush) {
    const t = toolBrush(app, tool.id).preset.tip;
    tip = { tip: t, global: app.settings?.brush };
    byTool.set(tool.id, tip);
  }
  return tip.tip;
}

/**
 * The cursor's polygons in document px around (0, 0): the tip's outline for 'outline' and 'full', scaled for
 * Normal Brush Tip. Pure (Node-tested).
 */
export function cursorPolygons(tip, style) {
  const polys = tipOutline(tip, { size: tip.size, angle: tip.angle ?? 0, roundness: tip.roundness ?? 1, flipX: !!tip.flipX, flipY: !!tip.flipY });
  const k = style === 'outline' ? normalTipScale(tip) : 1;
  return k === 1 ? polys : polys.map((poly) => poly.map(([x, y]) => [x * k, y * k]));
}

/** The view's document-to-screen matrix as six numbers (zoom, pan and the view's rotation). */
function viewMatrix(view) {
  const m = typeof view.matrix === 'function' ? view.matrix() : null;
  if (m) return [m.a, m.b, m.c, m.d, m.e, m.f];
  const z = view.zoom ?? 1;
  const o = view.toScreen(0, 0);
  return [z, 0, 0, z, o.x, o.y];
}

function crosshair(ctx, x, y, r = 5) {
  ctx.beginPath();
  ctx.moveTo(x - r, y);
  ctx.lineTo(x + r, y);
  ctx.moveTo(x, y - r);
  ctx.lineTo(x, y + r);
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** Traces polygons (document px around `at`) through the view matrix. */
export function tracePolygons(ctx, polys, at, m) {
  const [a, b, c, d, e, f] = m;
  ctx.beginPath();
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const x = at.x + poly[i][0], y = at.y + poly[i][1];
      const sx = a * x + c * y + e, sy = b * x + d * y + f;
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.closePath();
  }
}

/** The Pulled String leash: from the brush to the pointer (document px, stroke.leash), in the leash colour. */
function drawLeash(ctx, view, leash, color) {
  const a = view.toScreen(leash.from.x, leash.from.y), b = view.toScreen(leash.to.x, leash.to.y);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(a.x, a.y, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

/** Draws the brush cursor at the pointer (screen px of the view's overlay). */
export function drawBrushCursor(ctx, view, tool) {
  const app = tool.app;
  const prefs = cursorPrefs(app);
  const leash = tool.stroke?.leash;
  if (leash?.from && leash?.to) {
    ctx.save();
    drawLeash(ctx, view, leash, prefs.leashColor || CURSOR_DEFAULTS.leashColor);
    ctx.restore();
  }
  if (!view.pointer) return;
  const style = effectiveCursorStyle(app);
  const p = view.toScreen(view.pointer.x, view.pointer.y);
  const painting = !!(tool.stroke || tool.active);
  // Shift held between strokes: where a click would draw the straight line from the last stroke's end
  const last = !painting && paintKeyState.shift ? tool.gesture?.lastPoint?.() : null;
  if (last) {
    const a = view.toScreen(last.x, last.y);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(p.x, p.y);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.lineDashOffset = 4;
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.stroke();
    ctx.restore();
  }
  // Precise: the CSS crosshair (brushCursorCss, or the cursor filter for Caps Lock) is the whole cursor
  if (style === 'precise') return;
  ctx.save();
  ctx.lineWidth = 1;
  if (painting && prefs.crosshairWhilePainting) {
    crosshair(ctx, p.x, p.y);
    ctx.restore();
    return;
  }
  if (style === 'standard') {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.restore();
    return;
  }
  const tip = cursorTip(tool);
  const shown = tip.size * normalTipScale(style === 'outline' ? tip : null) * (view.zoom ?? 1);
  if (!(shown >= MIN_OUTLINE_PX)) {
    crosshair(ctx, p.x, p.y);
    ctx.restore();
    return;
  }
  tracePolygons(ctx, cursorPolygons(tip, style), view.pointer, viewMatrix(view));
  // a dark ring under a light one keeps the outline visible on any image
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 1;
  ctx.stroke();
  if (prefs.crosshairInTip) crosshair(ctx, p.x, p.y, 4);
  ctx.restore();
}

/** True for a tool that draws the brush cursor (a StrokeTool, or a temporary tool's adapter over one). */
export function drawsBrushCursor(tool) {
  const t = tool?.temporary ? tool.tool : tool;
  return !!t?.gesture && typeof t.strokeDown === 'function';
}

/**
 * The cursor filter (app.tools.setCursorFilter, S3.2): Caps Lock gives the painting tools the crosshair; Other Cursors
 * set to Precise gives the crosshair to the other tools whose cursor is the plain arrow.
 */
export function cursorFilter(app, css, { tool } = {}) {
  if (!tool) return css;
  if (drawsBrushCursor(tool)) {
    if (paintKeyState.capsLock && css === 'none') return 'crosshair';
    return css;
  }
  const id = tool.temporary ? tool.tool?.id : tool.id;
  if (cursorPrefs(app).other === 'precise' && css === 'default' && !OWN_CURSOR.has(id)) return 'crosshair';
  return css;
}
