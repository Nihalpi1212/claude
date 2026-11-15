// Paint renderers (ARCHITECTURE.md "0.4 features", G.3; E9): turn a Paint (G.2) into a Canvas 2D fill or stroke
// style. Fill layers, shape fills and strokes and the Gradient tool draw through paintStyle(); document.js keeps
// makePaint / makeGradient as 0.3-compatible delegates.
//
// Skeleton file. The default renderers are 0.3's code moved here from document.js (makePaint, makeGradient, the
// per-pixel diamond pattern), so 0.3 documents draw exactly as before. gradients registers 'gradient' (per pixel
// through gradient-render.js, every interpolation and noise), patterns registers 'pattern' (angle, link, origin);
// the later registration wins.
//
// Coordinates: `box` is the rectangle placement is measured against (angle, scale, offset, Align with Layer), in
// ctx space; `opts.origin` is the document position of ctx's (0, 0). Document-space `from` / `to` (fill layers, the
// Gradient tool) are mapped into ctx space by subtracting the origin. Shape paints store no from / to.
import { parseColor, rgbaToHex } from '../../shared/pixels/color.js';
import { isGradientV2, normalizeGradient, gradientSampler } from '../../shared/pixels/gradient-model.js';
import { createCanvas } from './document.js';

/** type -> fn(ctx, paint, box, opts) -> CanvasGradient | CanvasPattern | string */
const RENDERERS = new Map();

/** Registers the renderer of a paint type ('solid', 'gradient', 'pattern'); the later registration wins. */
export function registerPaintRenderer(type, fn) {
  if (typeof type !== 'string' || typeof fn !== 'function') throw new Error('registerPaintRenderer(type, fn)');
  RENDERERS.set(type, fn);
}

/** The renderer registered for a type, or null. */
export function paintRenderer(type) {
  return RENDERERS.get(type) ?? null;
}

/**
 * The fill / stroke style for `paint` in ctx. box: the placement rectangle in ctx space; opts: { origin: [x, y]
 * (document position of ctx's 0, 0; default [0, 0]), layer?, doc?, fg?, bg? }. A missing paint, an unknown type or a
 * renderer that fails gives 'transparent' (nothing drawn), as 0.3's makePaint did for what it did not know.
 */
export function paintStyle(ctx, paint, box, opts = {}) {
  if (!paint) return 'transparent';
  const fn = RENDERERS.get(paint.type);
  if (!fn) return 'transparent';
  const o = { ...opts, origin: Array.isArray(opts.origin) ? opts.origin : [0, 0] };
  try {
    return fn(ctx, paint, box, o) ?? 'transparent';
  } catch (err) {
    console.warn(`paint renderer '${paint.type}' failed`, err);
    return 'transparent';
  }
}

// ---- defaults: 0.3's code --------------------------------------------------------------------------------------

registerPaintRenderer('solid', (ctx, paint) => rgbaToHex(parseColor(paint.color), true));

registerPaintRenderer('pattern', (ctx, paint) => {
  if (!paint.pattern?.canvas) return 'transparent';
  const p = ctx.createPattern(paint.pattern.canvas, 'repeat');
  if (p && paint.pattern.scale && paint.pattern.scale !== 1) p.setTransform(new DOMMatrix().scale(paint.pattern.scale));
  return p ?? 'transparent';
});

registerPaintRenderer('gradient', (ctx, paint, box, opts) => canvasGradient(ctx, paint.gradient ?? {}, box, opts));

/**
 * 0.3's makeGradient: a Canvas gradient from `from` to `to` (document space, mapped into ctx space by the origin),
 * defaulting to the box's left -> right through its middle. 'diamond' has no Canvas gradient and is rendered per pixel
 * over the box as a pattern.
 */
export function canvasGradient(ctx, g, box, { origin = [0, 0], fg, bg } = {}) {
  const [ox, oy] = origin;
  const from = g.from ? [g.from[0] - ox, g.from[1] - oy] : [box.x, box.y + box.height / 2];
  const to = g.to ? [g.to[0] - ox, g.to[1] - oy] : [box.x + box.width, box.y + box.height / 2];
  let grad;
  const kind = g.kind ?? 'linear';
  if (kind === 'radial' || kind === 'diamond') {
    const r = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1;
    grad = ctx.createRadialGradient(from[0], from[1], 0, from[0], from[1], r);
  } else if (kind === 'angle') {
    grad = ctx.createConicGradient(Math.atan2(to[1] - from[1], to[0] - from[0]), from[0], from[1]);
  } else if (kind === 'reflected') {
    const dx = to[0] - from[0], dy = to[1] - from[1];
    grad = ctx.createLinearGradient(from[0] - dx, from[1] - dy, to[0], to[1]);
  } else grad = ctx.createLinearGradient(from[0], from[1], to[0], to[1]);
  let list;
  if (isGradientV2(g)) {
    // already in order, hard stops as two entries at one position: reversing flips the order too
    const stops = canvasStops(g, { fg, bg });
    list = g.reverse ? stops.map((s) => ({ pos: 1 - s.pos, color: s.color })).reverse() : stops;
  } else {
    const stops = canvasStops(g).slice().sort((a, b) => a.pos - b.pos);
    list = g.reverse ? stops.map((s) => ({ pos: 1 - s.pos, color: s.color })).sort((a, b) => a.pos - b.pos) : stops;
  }
  if (kind === 'diamond') return diamondPattern(ctx, list, from, to, box);
  if (kind === 'reflected') {
    // mirror the stops around the middle
    const half = list.map((s) => ({ pos: 0.5 + s.pos / 2, color: s.color }));
    const mirrored = list.map((s) => ({ pos: 0.5 - s.pos / 2, color: s.color }));
    for (const s of [...mirrored, ...half].sort((a, b) => a.pos - b.pos)) grad.addColorStop(Math.min(1, Math.max(0, s.pos)), rgbaToHex(parseColor(s.color), true));
  } else for (const s of list) grad.addColorStop(Math.min(1, Math.max(0, s.pos)), rgbaToHex(parseColor(s.color), true));
  return grad;
}

const EPS = 1e-6;

/**
 * The colour stops a Canvas gradient interpolates linearly: a 0.3 gradient's own stops (0.3 drew them as they are),
 * or, for a version 2 def (the gradient widget, createPaint), the reference sampler read at every colour and opacity
 * stop (both sides of a hard stop) plus 32 samples per segment when a midpoint, smoothness or an interpolation other
 * than classic bends it. Colours are #rrggbbaa strings.
 */
export function canvasStops(g, { fg, bg } = {}) {
  if (!isGradientV2(g)) return g.stops?.length ? g.stops : [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }];
  const def = normalizeGradient(g, { fg, bg });
  const sample = gradientSampler(def, { fg, bg });
  const marks = [...new Set([0, 1, ...def.stops.map((s) => s.pos), ...def.opacityStops.map((s) => s.pos)].map((p) => Math.min(1, Math.max(0, p))))].sort((a, b) => a - b);
  const bent = def.type !== 'solid' || def.interpolation !== 'classic' || def.smoothness > 0 || [...def.stops, ...def.opacityStops].some((s) => Math.abs((s.mid ?? 0.5) - 0.5) > EPS);
  const out = [];
  const push = (pos, t) => {
    const [r, gg, b, a] = sample(t);
    out.push({ pos, color: rgbaToHex([Math.round(r), Math.round(gg), Math.round(b), a], true) });
  };
  for (let i = 0; i < marks.length; i++) {
    const p = marks[i];
    if (p > 0) push(p, p - EPS);
    if (p < 1) push(p, p + EPS);
    if (bent && i + 1 < marks.length) {
      const q = marks[i + 1];
      for (let k = 1; k < 32; k++) {
        const t = p + ((q - p) * k) / 32;
        push(t, t);
      }
    }
  }
  return out;
}

/** Canvas 2D has no diamond gradient: render it per pixel (L1 distance in the drag frame) as a pattern. */
function diamondPattern(ctx, stops, from, to, rect) {
  const lutCanvas = createCanvas(256, 1);
  const lctx = lutCanvas.getContext('2d');
  const lg = lctx.createLinearGradient(0, 0, 256, 0);
  for (const s of stops) lg.addColorStop(Math.min(1, Math.max(0, s.pos)), rgbaToHex(parseColor(s.color), true));
  lctx.fillStyle = lg;
  lctx.fillRect(0, 0, 256, 1);
  const lut = lctx.getImageData(0, 0, 256, 1).data;
  const w = Math.max(1, Math.ceil(rect.width)), h = Math.max(1, Math.ceil(rect.height));
  const c = createCanvas(w, h);
  const cctx = c.getContext('2d');
  const img = cctx.createImageData(w, h);
  const dx = to[0] - from[0], dy = to[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const d = img.data;
  for (let y = 0; y < h; y++) {
    const py = rect.y + y + 0.5 - from[1];
    for (let x = 0; x < w; x++) {
      const px = rect.x + x + 0.5 - from[0];
      const u = px * ux + py * uy, v = -px * uy + py * ux;
      const t = Math.min(255, Math.round(((Math.abs(u) + Math.abs(v)) / len) * 255));
      const o = (y * w + x) * 4, l = t * 4;
      d[o] = lut[l];
      d[o + 1] = lut[l + 1];
      d[o + 2] = lut[l + 2];
      d[o + 3] = lut[l + 3];
    }
  }
  cctx.putImageData(img, 0, 0);
  const pattern = ctx.createPattern(c, 'no-repeat');
  pattern.setTransform(new DOMMatrix().translate(rect.x, rect.y));
  return pattern;
}
