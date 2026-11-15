// The on-canvas brush-resize HUD (ARCHITECTURE.md "0.5 features", S3.1; brush-painting-behaviours). While the HUD drag
// runs (lib/tools/paint-gesture.js: Alt+right-drag on Windows and Linux, Ctrl+Alt+drag on macOS) the tool's overlay
// shows the tip where the drag started, at the size being set, filled with the Brush Preview colour
// (settings.painting.cursors.previewColor) as the brush would paint it (soft as its hardness, as strong as its
// opacity), with the values beside it. The values themselves are written by the gesture through the tool's options.
import { cursorPolygons, cursorTip, tracePolygons } from './brush-cursor.js';
import { DEFAULT_SETTINGS } from '../../shared/defaults.js';

/** The label under the HUD: "Size 120 px · Hardness 80 %" (opacity instead of hardness when the HUD sets it). */
export function hudLabel(values, vertical = 'hardness') {
  const parts = [`Size ${Math.round(values.size)} px`];
  const v = values[vertical === 'opacity' ? 'opacity' : 'hardness'];
  if (Number.isFinite(v)) parts.push(`${vertical === 'opacity' ? 'Opacity' : 'Hardness'} ${Math.round(v * 100)} %`);
  return parts.join(' · ');
}

function hexRgb(hex) {
  const n = parseInt(String(hex ?? '').replace('#', '').slice(0, 6), 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [255, 0, 0];
}

/** Draws the HUD (screen px of the view's overlay). */
export function drawResizeHud(ctx, view, tool, hud) {
  const app = tool.app;
  const color = app.settings?.painting?.cursors?.previewColor ?? DEFAULT_SETTINGS.painting.cursors.previewColor;
  const [r, g, b] = hexRgb(color);
  const base = cursorTip(tool);
  const size = hud.values.size ?? base.size;
  const hardness = Number.isFinite(hud.values.hardness) ? hud.values.hardness : base.hardness ?? 1;
  const opacity = Number.isFinite(hud.values.opacity) ? hud.values.opacity : 1;
  const tip = { ...base, size, hardness };
  const c = view.toScreen(hud.at.x, hud.at.y);
  const radius = (size / 2) * (view.zoom ?? 1);
  const m = view.matrix();
  ctx.save();
  tracePolygons(ctx, cursorPolygons(tip, 'full'), hud.at, [m.a, m.b, m.c, m.d, m.e, m.f]);
  // the preview: full strength inside the hardness, fading out to the edge, at half the opacity so the image shows
  const alpha = 0.5 * opacity;
  if (radius > 0.5) {
    const grad = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, radius);
    const inner = Math.min(0.999, Math.max(0, hardness));
    grad.addColorStop(0, `rgba(${r},${g},${b},${alpha})`);
    grad.addColorStop(inner, `rgba(${r},${g},${b},${alpha})`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 1;
  ctx.stroke();
  // the values, in a small box below the circle (kept inside the view)
  const text = hudLabel(hud.values, hud.vertical);
  ctx.font = '12px system-ui, sans-serif';
  const w = ctx.measureText(text).width + 12, h = 20;
  const vw = view.cssWidth ?? Infinity, vh = view.cssHeight ?? Infinity;
  const x = Math.max(4, Math.min(vw - w - 4, c.x - w / 2));
  const y = Math.max(4, Math.min(vh - h - 4, c.y + Math.min(radius, 4000) + 10));
  ctx.fillStyle = 'rgba(30,30,30,0.85)';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 6, y + h / 2);
  ctx.restore();
}
