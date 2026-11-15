// Per-pixel gradient renderer (gradients package, ARCHITECTURE.md "0.4 features", G.1 and G.3). Pure, no DOM: the
// 'gradient' paint renderer (lib/gradient-paint.js) draws through it whatever a Canvas gradient cannot show (the
// perceptual, linear, smooth and stripes methods, noise gradients, dither), and Node tests compare it with the
// reference sampler of gradient-model.js.
//
// Geometry is gradient-model.js gradientT's, inlined per kind:
//  - with `from` / `to` (document coordinates; fill layers and the Gradient tool) the point is measured from `from`
//    in units of |to - from|;
//  - otherwise (shapes, Gradient Overlay) placement is relative to `box`: its centre moved by `offset` (percent of
//    the box), `angle` degrees counter-clockwise from 3 o'clock, `scale` a fraction.
// Coordinates: the target's pixel (i, j) has its centre at (at[0] + i + 0.5, at[1] + j + 0.5) in "ctx space", the
// space `box` is given in; `origin` is the document position of ctx space's (0, 0), so document `from` / `to` map to
// ctx space by subtracting it (G.3). Because shape paints store no from / to, a shape's gradient stays on the shape
// when its render canvas grows (a wider stroke) or moves: only `box` and `origin` change, together.
import { normalizeGradient, gradientSampler, GRADIENT_KINDS } from './gradient-model.js';

const TAU = Math.PI * 2;
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// 4 x 4 Bayer thresholds, centred on zero (-0.47 .. 0.47): ordered dither of less than half a level, so a dithered
// render stays within one level of the undithered one
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16 - 0.5);

/**
 * A float lookup table of the gradient: `size` entries of r, g, b, a, all 0..255 and unrounded (entry i is
 * t = i / (size - 1)). Reverse is not applied here.
 * @param {any} def any gradient shape (normalised here; { ref } stops resolve with fg / bg)
 * @param {{ fg?: any, bg?: any, size?: number }} [opts]
 */
export function floatLut(def, { fg, bg, size = 4096 } = {}) {
  const n = Math.max(2, Math.floor(size));
  const sample = gradientSampler(def, { fg, bg });
  const lut = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const c = sample(i / (n - 1));
    lut[i * 4] = c[0];
    lut[i * 4 + 1] = c[1];
    lut[i * 4 + 2] = c[2];
    lut[i * 4 + 3] = c[3] * 255;
  }
  return lut;
}

/**
 * The function (x, y) -> t (unclamped, un-reversed) of a placement for points in ctx space. Same numbers as
 * gradient-model.js gradientT(placement, x + origin.x, y + origin.y) for from / to placements, and as
 * gradientT(placement, x, y, box) for box placements.
 * @param {object} pl placement (G.1)
 * @param {{ x: number, y: number, width: number, height: number }} box in ctx space
 * @param {[number, number]} [origin] document position of ctx space's (0, 0)
 */
export function placementT(pl = {}, box = { x: 0, y: 0, width: 1, height: 1 }, origin = [0, 0]) {
  const kind = GRADIENT_KINDS.includes(pl.kind) ? pl.kind : 'linear';
  if (kind === 'shape-burst') return () => 0;
  if (Array.isArray(pl.from) && Array.isArray(pl.to)) {
    const fx = num(pl.from[0], 0) - origin[0], fy = num(pl.from[1], 0) - origin[1];
    const dx = num(pl.to[0], 0) - origin[0] - fx, dy = num(pl.to[1], 0) - origin[1] - fy;
    const len = Math.hypot(dx, dy) || 1;
    const l2 = len * len;
    const ux = dx / len, uy = dy / len;
    if (kind === 'linear') return (x, y) => ((x - fx) * dx + (y - fy) * dy) / l2;
    if (kind === 'reflected') return (x, y) => Math.abs((x - fx) * dx + (y - fy) * dy) / l2;
    if (kind === 'radial') return (x, y) => { const px = x - fx, py = y - fy; return Math.sqrt(px * px + py * py) / len; };
    if (kind === 'diamond') {
      return (x, y) => {
        const px = x - fx, py = y - fy;
        return (Math.abs(px * ux + py * uy) + Math.abs(-px * uy + py * ux)) / len;
      };
    }
    const a0 = Math.atan2(dy, dx);
    return (x, y) => {
      const t = (Math.atan2(y - fy, x - fx) - a0) / TAU;
      return t - Math.floor(t);
    };
  }
  const b = box;
  const off = Array.isArray(pl.offset) ? pl.offset : [0, 0];
  const cx = b.x + b.width / 2 + (num(off[0], 0) / 100) * b.width;
  const cy = b.y + b.height / 2 + (num(off[1], 0) / 100) * b.height;
  const a = (num(pl.angle, 90) * Math.PI) / 180;
  const ux = Math.cos(a), uy = -Math.sin(a);
  const vx = -uy, vy = ux;
  const scale = Math.max(0.01, num(pl.scale, 1));
  const len = Math.max(1e-6, (Math.abs(b.width * ux) + Math.abs(b.height * uy)) * scale);
  const rad = Math.max(1e-6, (Math.max(b.width, b.height) / 2) * scale);
  if (kind === 'linear') return (x, y) => 0.5 + ((x - cx) * ux + (y - cy) * uy) / len;
  if (kind === 'reflected') return (x, y) => Math.abs((x - cx) * ux + (y - cy) * uy) / (len / 2);
  if (kind === 'radial') return (x, y) => { const px = x - cx, py = y - cy; return Math.sqrt(px * px + py * py) / rad; };
  if (kind === 'diamond') {
    return (x, y) => {
      const px = x - cx, py = y - cy;
      return (Math.abs(px * ux + py * uy) + Math.abs(px * vx + py * vy)) / rad;
    };
  }
  return (x, y) => {
    const t = (Math.atan2(-(y - cy), x - cx) - a) / TAU;
    return t - Math.floor(t);
  };
}

/**
 * Renders a gradient into an RGBA image (straight alpha), every pixel.
 * @param {{ data: Uint8ClampedArray | Uint8Array, width: number, height: number }} img the target (ImageData works)
 * @param {object} gradient GradientDef & GradientPlacement (any 0.3 shape too)
 * @param {{ box?: object, origin?: [number, number], at?: [number, number], fg?: any, bg?: any, dither?: boolean,
 *   reverse?: boolean, lut?: Float32Array, lutSize?: number }} [opts] `at`: the ctx-space position of the image's
 *   pixel (0, 0) (default [0, 0]); `dither` and `reverse` default to the gradient's own flags.
 * @returns the image
 */
export function renderGradient(img, gradient, opts = {}) {
  const g = gradient ?? {};
  const w = img.width, h = img.height;
  // a clamped view rounds to the nearest level on assignment (Uint8ClampedArray semantics) and never wraps
  const out = img.data instanceof Uint8ClampedArray ? img.data : new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length);
  const box = opts.box ?? { x: 0, y: 0, width: w, height: h };
  const origin = Array.isArray(opts.origin) ? opts.origin : [0, 0];
  const at = Array.isArray(opts.at) ? opts.at : [0, 0];
  const reverse = opts.reverse ?? !!g.reverse;
  const dither = opts.dither ?? !!g.dither;
  const def = normalizeGradient(g, { fg: opts.fg, bg: opts.bg });
  // a rough noise gradient changes fast: a finer table keeps it within a level of the sampler
  const lut = opts.lut ?? floatLut(def, { size: opts.lutSize ?? (def.type === 'noise' ? 16384 : 4096) });
  const last = lut.length / 4 - 1;
  const tf = placementT(g, box, origin);
  // dither thresholds follow the document grid, so two renders of one gradient line up
  const ox = Math.round(at[0] + origin[0]), oy = Math.round(at[1] + origin[1]);
  let o = 0;
  for (let j = 0; j < h; j++) {
    const y = at[1] + j + 0.5;
    const row = ((((j + oy) % 4) + 4) % 4) * 4;
    for (let i = 0; i < w; i++, o += 4) {
      let t = tf(at[0] + i + 0.5, y);
      if (!(t > 0)) t = 0; // NaN too
      else if (t > 1) t = 1;
      if (reverse) t = 1 - t;
      const k = ((t * last + 0.5) | 0) * 4;
      if (dither) {
        const d = BAYER[row + ((((i + ox) % 4) + 4) % 4)];
        out[o] = lut[k] + d;
        out[o + 1] = lut[k + 1] + d;
        out[o + 2] = lut[k + 2] + d;
        out[o + 3] = lut[k + 3];
      } else {
        out[o] = lut[k];
        out[o + 1] = lut[k + 1];
        out[o + 2] = lut[k + 2];
        out[o + 3] = lut[k + 3];
      }
    }
  }
  return img;
}
