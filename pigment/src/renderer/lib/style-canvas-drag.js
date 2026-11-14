// Layer Style: drag in the document to position an effect while the dialog is open (Photoshop's "drag in the image to
// move the shadow"): Drop Shadow and Inner Shadow take their angle and distance from the drag, Satin its angle and
// distance, Gradient Overlay its offset, Pattern Overlay and the Bevel & Emboss Texture their Snap to Origin offset.
// Uses the canvas capture of ARCHITECTURE.md "0.4 features", I.3 (E14): the dialog lets the canvas through
// (setCanvasThrough) while such an effect's page is shown, and a capture handler takes the drags.
//
//   armStyleDrag(app, dialogEl, { page() -> { key, fx } | null, update(patch), layer }) -> { refresh(), release() }
//   dragPatch(key, fx, start, delta, box) -> patch   (pure: the effect fields a drag by delta gives)
import { contentBounds } from '../../shared/pixels/core.js';

export const DRAGGABLE = new Set(['dropShadow', 'innerShadow', 'satin', 'gradientOverlay', 'patternOverlay', 'bevel-texture']);

const RAD = Math.PI / 180;
const round1 = (v) => Math.round(v * 10) / 10;
const pair = (v) => (Array.isArray(v) && v.length === 2 ? [Number(v[0]) || 0, Number(v[1]) || 0] : [0, 0]);

/**
 * The fields a drag by delta (document px) gives, from the effect as it was when the drag started. Shadows: their
 * offset vector moves with the pointer (Photoshop's angle names where the light comes from, so the shadow falls the
 * other way). Satin: its offset vector. Gradient Overlay: the offset in percent of the layer's box. Patterns: the
 * Snap to Origin offset in px.
 */
export function dragPatch(key, fx, delta, box = null) {
  if (key === 'dropShadow' || key === 'innerShadow') {
    const a = (Number(fx.angle) || 0) * RAD, d = Number(fx.distance) || 0;
    const vx = -Math.cos(a) * d + delta.x, vy = Math.sin(a) * d + delta.y;
    const dist = Math.round(Math.hypot(vx, vy));
    const patch = { distance: Math.min(30000, dist) };
    if (dist > 0) patch.angle = Math.round(Math.atan2(vy, -vx) / RAD);
    // the drag sets this effect's own angle (Photoshop moves the global light instead; see docs/0.4)
    if (fx.useGlobalLight) patch.useGlobalLight = false;
    return patch;
  }
  if (key === 'satin') {
    const a = (Number(fx.angle) || 0) * RAD, d = Number(fx.distance) || 0;
    const vx = Math.cos(a) * d + delta.x, vy = -Math.sin(a) * d + delta.y;
    const dist = Math.max(1, Math.round(Math.hypot(vx, vy)));
    return { distance: dist, angle: Math.round(Math.atan2(-vy, vx) / RAD) };
  }
  if (key === 'gradientOverlay') {
    const o = pair(fx.offset), w = Math.max(1, box?.width ?? 100), h = Math.max(1, box?.height ?? 100);
    return { offset: [round1(o[0] + (delta.x / w) * 100), round1(o[1] + (delta.y / h) * 100)] };
  }
  if (key === 'patternOverlay') {
    const o = pair(fx.origin);
    return { origin: [Math.round(o[0] + delta.x), Math.round(o[1] + delta.y)] };
  }
  if (key === 'bevel-texture') {
    const o = pair(fx.texture?.origin);
    return { texture: { ...(fx.texture ?? {}), origin: [Math.round(o[0] + delta.x), Math.round(o[1] + delta.y)] } };
  }
  return {};
}

/** The layer's content box in document space (Gradient Overlay measures its offset against it). */
function layerBox(app, layer) {
  try {
    const src = layer.type === 'raster' ? { canvas: layer.canvas, x: layer.x, y: layer.y } : layer.render?.();
    if (!src?.canvas) return layer.bounds?.() ?? null;
    const c = src.canvas;
    const img = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
    const b = contentBounds(img);
    return b ? { x: b.x + src.x, y: b.y + src.y, width: b.width, height: b.height } : null;
  } catch {
    return layer.bounds?.() ?? null;
  }
}

export function armStyleDrag(app, dialogEl, { page, update, layer }) {
  let release = null;
  let drag = null;
  const handler = {
    id: 'layer-style-drag',
    cursor: 'move',
    down(p) {
      const cur = page();
      if (!cur || !DRAGGABLE.has(cur.key)) return;
      drag = { key: cur.key, fx: JSON.parse(JSON.stringify(cur.fx, (k, v) => (k === 'pattern' && v && typeof v === 'object' && v.data ? undefined : v))), x: p.x, y: p.y, box: cur.key === 'gradientOverlay' ? layerBox(app, layer) : null };
    },
    move(p, view, dragging) {
      if (!drag || !dragging) return;
      update(drag.key, dragPatch(drag.key, drag.fx, { x: p.x - drag.x, y: p.y - drag.y }, drag.box));
    },
    up(p) {
      if (!drag) return;
      update(drag.key, dragPatch(drag.key, drag.fx, { x: p.x - drag.x, y: p.y - drag.y }, drag.box), { done: true });
      drag = null;
    },
  };
  const refresh = () => {
    const cur = page();
    const on = !!cur && DRAGGABLE.has(cur.key);
    if (on && !release) {
      app.dialogs.setCanvasThrough?.(dialogEl, true);
      release = app.canvasCapture?.push(handler) ?? null;
    } else if (!on && release) {
      release();
      release = null;
      app.dialogs.setCanvasThrough?.(dialogEl, false);
    }
  };
  return {
    refresh,
    release() {
      if (release) release();
      release = null;
      app.dialogs.setCanvasThrough?.(dialogEl, false);
    },
  };
}
