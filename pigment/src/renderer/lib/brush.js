// Brush engine facade (ARCHITECTURE.md "0.5 features", S2.1): every caller imports the engine from here. The engine
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
export function dabDiameter(size) {
  const d = Math.max(1, Math.ceil(size));
  if (d <= 128) return d;
  const step = Math.log(1.01);
  return Math.max(129, Math.ceil(Math.exp(Math.ceil(Math.log(d) / step - 1e-9) * step) - 1e-9));
}

/**
 * The side (px) a dab canvas for `size` is drawn at: 0.4's ceil(size) plus the 1 px padding on each side. Above 128 px
 * dabCanvas returns the larger canvas of its 1 % step, and every caller scales it to this side, so a dab keeps 0.4's
 * extent and stays inside the dirty rect worked out from `size`.
 */
export function dabDrawSide(size) {
  return Math.max(1, Math.ceil(size)) + 2;
}

/** A soft or hard round dab canvas of the given diameter (cached; may be larger than asked: draw it at dabDrawSide). */
export function dabCanvas(size, hardness, color = '#000000', { aliased = false } = {}) {
  const d = dabDiameter(size);
  const key = `${d}|${Math.round(hardness * 100)}|${color}|${aliased ? 'a' : 's'}`;
  let c = dabCache.get(key);
  if (c) return c;
  const pad = 1;
  c = createCanvas(d + pad * 2, d + pad * 2);
  const ctx = c.getContext('2d');
  const r = d / 2;
  const cx = r + pad, cy = r + pad;
  const [cr, cg, cb] = parseColor(color);
  const rgb = `${Math.round(cr)},${Math.round(cg)},${Math.round(cb)}`;
  if (aliased) {
    // pencil: whole pixels only, by pixel centre (pixel art needs fully opaque pixels at every size)
    ctx.fillStyle = `rgb(${rgb})`;
    for (let py = 0; py < d; py++) for (let px = 0; px < d; px++) if ((px + 0.5 - r) ** 2 + (py + 0.5 - r) ** 2 <= r * r) ctx.fillRect(px + pad, py + pad, 1, 1);
  } else if (d <= 2) {
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
  const px = c.width * c.height;
  while (dabCache.size && dabCachePixels + px > DAB_CACHE_PIXELS) {
    const [k, old] = dabCache.entries().next().value;
    dabCache.delete(k);
    dabCachePixels -= old.width * old.height;
  }
  dabCache.set(key, c);
  dabCachePixels += px;
  return c;
}

/**
 * Draws a fill canvas onto ctx at (x, y) with a Photoshop blend mode and opacity, per pixel when
 * Canvas 2D has no equivalent. lockTransparency keeps the target's alpha.
 */
export function drawBlended(ctx, fill, x, y, blend = 'normal', opacity = 1, { lockTransparency = false } = {}) {
  const op = CANVAS_BLEND[blend];
  ctx.save();
  if (!op && blend !== 'normal' && blend !== 'pass-through') {
    const w = fill.width, h = fill.height;
    const cw = ctx.canvas.width, ch = ctx.canvas.height;
    const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(cw, x + w), y1 = Math.min(ch, y + h);
    if (x1 > x0 && y1 > y0) {
      const dst = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
      const srcData = fill.getContext('2d', { willReadFrequently: true }).getImageData(x0 - x, y0 - y, x1 - x0, y1 - y0);
      const backAlpha = lockTransparency ? new Uint8ClampedArray(dst.data) : null;
      blendImages(blend, { width: x1 - x0, height: y1 - y0, data: srcData.data }, { width: x1 - x0, height: y1 - y0, data: dst.data }, opacity);
      if (backAlpha) for (let i = 3; i < dst.data.length; i += 4) dst.data[i] = backAlpha[i];
      ctx.putImageData(dst, x0, y0);
    }
  } else {
    ctx.globalAlpha = opacity;
    ctx.globalCompositeOperation = lockTransparency ? 'source-atop' : op ?? 'source-over';
    ctx.drawImage(fill, x, y);
  }
  ctx.restore();
}

/**
 * Paints a fill onto a layer mask at (x, y): the fill's grey level becomes the mask value where it
 * covers, new = old * (1 - c) + grey * c with c = fill alpha * opacity (black hides, white reveals).
 */
export function drawOnMask(ctx, fill, x, y, opacity = 1) {
  const w = fill.width, h = fill.height;
  const cw = ctx.canvas.width, ch = ctx.canvas.height;
  const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(cw, x + w), y1 = Math.min(ch, y + h);
  if (x1 <= x0 || y1 <= y0) return;
  const dst = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
  const src = fill.getContext('2d', { willReadFrequently: true }).getImageData(x0 - x, y0 - y, x1 - x0, y1 - y0).data;
  const d = dst.data;
  for (let i = 0; i < d.length; i += 4) {
    const c = (src[i + 3] / 255) * opacity;
    if (c <= 0) continue;
    const grey = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
    d[i] = d[i + 1] = d[i + 2] = 255;
    d[i + 3] = Math.round(d[i + 3] * (1 - c) + grey * c);
  }
  ctx.putImageData(dst, x0, y0);
}
