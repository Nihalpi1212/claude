// The painting tools' cursor (ARCHITECTURE.md "0.5 features", S3.2). brush-painting-behaviours' file; this is the
// skeleton's stub: 0.4's StrokeTool.drawOverlay and cursorStyle moved from tools/paint.js. The Preferences'
// cursorStyle offers 'standard' | 'precise' | 'outline' | 'full' (0.4's 'dot' reads as 'standard'): the stub draws
// 'standard' as 0.4's dot and 'full' as the outline. The package draws the real tip (tipOutline), the crosshair and the
// leash (stroke.leash), and registers the cursor filter (app.tools.setCursorFilter) for Other Cursors and Caps Lock.

/** The painting cursor style from the settings, 0.4's values read as 0.5's. */
export function paintingCursorStyle(app) {
  const v = app.settings?.cursorStyle;
  if (v === 'dot') return 'standard';
  return v === 'standard' || v === 'precise' || v === 'full' ? v : 'outline';
}

/** The CSS cursor over the canvas while a painting tool is active. */
export function brushCursorCss(tool) {
  return paintingCursorStyle(tool.app) === 'precise' ? 'crosshair' : 'none';
}

/** Draws the brush cursor at the pointer (screen px of the view's overlay). */
export function drawBrushCursor(ctx, view, tool) {
  const style = paintingCursorStyle(tool.app);
  if (!view.pointer || style === 'precise') return;
  const size = (tool.opt('size') ?? 24) * view.zoom;
  const p = view.toScreen(view.pointer.x, view.pointer.y);
  ctx.save();
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (style === 'standard' || size < 4) {
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
