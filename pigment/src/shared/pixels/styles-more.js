// The 0.4 effect fields of layer styles (ARCHITECTURE.md "0.4 features", J.6): contours, noise, glow technique and
// gradient fills, pattern placement (angle, Link with Layer, Snap to Origin), gradient placement (offset, Align with
// Layer, dither, Shape Burst for the Stroke) and the Bevel & Emboss Texture. Helpers for styles.js; pure, no DOM.
//
// Every field here has a default that keeps 0.3's pixels: styles.js takes its 0.3 code path whenever an effect uses
// only defaults, so documents made before 0.4 render bit for bit as they did.
import { normalizeGradient, gradientLut } from './gradient-model.js';
import { contourLut, lookupContour, isLinearContour, rangeInput } from './contour.js';

/**
 * The fields 0.4 adds to each effect, with the defaults that give 0.3's output (DEFAULT_STYLES stays 0.3's table, so
 * mergeStyles' result keeps 0.3's keys; readers fall back to these).
 */
export const EFFECT_FIELD_DEFAULTS = Object.freeze({
  dropShadow: Object.freeze({ contour: null, antiAlias: false, noise: 0, knocksOut: true }),
  innerShadow: Object.freeze({ contour: null, antiAlias: false, noise: 0 }),
  outerGlow: Object.freeze({ technique: 'softer', contour: null, antiAlias: false, range: 0.5, jitter: 0, noise: 0, fill: 'color', gradient: null }),
  innerGlow: Object.freeze({ technique: 'softer', contour: null, antiAlias: false, range: 0.5, jitter: 0, noise: 0, fill: 'color', gradient: null }),
  bevel: Object.freeze({
    glossContour: null, antiAlias: false,
    contourSub: Object.freeze({ enabled: false, contour: null, antiAlias: false, range: 0.5 }),
    texture: Object.freeze({ enabled: false, pattern: null, scale: 1, depth: 1, invert: false, link: true, origin: Object.freeze([0, 0]) }),
  }),
  satin: Object.freeze({ contour: null, antiAlias: false }),
  colorOverlay: Object.freeze({}),
  gradientOverlay: Object.freeze({ gradient: null, offset: Object.freeze([0, 0]), align: true, dither: false }),
  patternOverlay: Object.freeze({ angle: 0, link: true, origin: Object.freeze([0, 0]) }),
  stroke: Object.freeze({
    fill: 'color', gradient: null, kind: 'linear', angle: 90, scale: 1, offset: Object.freeze([0, 0]), align: true, reverse: false, dither: false,
    pattern: null, patternScale: 1, patternAngle: 0, link: true, origin: Object.freeze([0, 0]),
  }),
});

const num = (v, def = 0) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : def;
};
const RAD = Math.PI / 180;

/** Uniform [0, 1) hash noise for a source pixel and a salt: the same wherever the work window lies. */
export function noiseAt(x, y, salt) {
  let v = Math.imul(x | 0, 0x2c1b3c6d) ^ Math.imul(y | 0, 0x297a2d39) ^ Math.imul((salt | 0) + 7, 0x9e3779b1);
  v = Math.imul(v ^ (v >>> 16), 0x7feb352d);
  v = Math.imul(v ^ (v >>> 15), 0x846ca68b);
  return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
}

/** Below this an effect's opacity profile is ramped to 0, so a contour that starts above 0 cannot fill the window. */
const EPS = 1 / 255;

/**
 * How an effect's opacity profile v (0..1) is reshaped: a contour (with a glow's or the bevel contour's Range) and
 * noise. Null when the effect keeps 0.3's profile. The returned map(v) is continuous at 0 (a profile of 0 stays 0).
 */
export function profileMap(fx, { withRange = false } = {}) {
  const range = withRange ? num(fx.range, 0.5) : 0.5;
  const linear = isLinearContour(fx.contour);
  const ranged = withRange && Math.abs(range - 0.5) > 1e-9;
  if (linear && !ranged) return null;
  const aa = !!fx.antiAlias;
  const lut = linear ? null : contourLut(fx.contour, { size: 256, antiAlias: aa });
  const f = (v) => {
    const t = ranged ? rangeInput(v, range) : v;
    return lut ? lookupContour(lut, t, aa) : t;
  };
  const atEps = f(EPS);
  return (v) => (v >= EPS ? f(v) : (v <= 0 ? 0 : (atEps * v) / EPS));
}

/** Noise amount of an effect (0..1): 0 keeps 0.3's output. */
export const noiseOf = (fx) => {
  const n = num(fx.noise, 0);
  return n <= 0 ? 0 : n >= 1 ? 1 : n;
};

/**
 * A glow's gradient as a LUT of 256 straight RGBA entries, or null for the colour fill. A glow with fill 'gradient'
 * and no gradient uses Photoshop's default: the glow colour to transparent.
 */
export function glowGradientLut(fx, color) {
  if (fx.fill !== 'gradient') return null;
  const g = fx.gradient && typeof fx.gradient === 'object'
    ? fx.gradient
    : { stops: [{ pos: 0, color: color ?? '#ffffbe', opacity: 1 }, { pos: 1, color: color ?? '#ffffbe', opacity: 0 }] };
  return gradientLut(normalizeGradient(g), { size: 256, reverse: !!fx.reverse });
}

// ---- patterns ------------------------------------------------------------------------------------------------------

/** True when pat is usable pixel data (decoded by lib/style-prepare.js in the app). */
export const isPatternData = (pat) => !!pat && pat.width >= 1 && pat.height >= 1 && !!pat.data && pat.data.length >= pat.width * pat.height * 4;

/**
 * Where a pattern lies, in the work window's coordinates: its tile (0, 0) sits at (ax, ay), it is rotated by
 * `angle` degrees counter-clockwise (Photoshop's convention) about that point and scaled by `scale`.
 * link (Link with Layer, default) anchors the tile at the image's top-left (0.3's anchor), link false at the
 * document's origin (`docOrigin`, the document position of the image's top-left); `origin` (Snap to Origin's offset,
 * document px) moves it from there.
 */
export function patternPlacement({ link, origin, angle, scale }, ctx) {
  const o = Array.isArray(origin) ? origin : [0, 0];
  const anchorX = link === false ? -ctx.docX : 0, anchorY = link === false ? -ctx.docY : 0;
  return {
    ax: ctx.originX + anchorX + num(o[0], 0),
    ay: ctx.originY + anchorY + num(o[1], 0),
    angle: num(angle, 0),
    scale: Math.min(100, Math.max(0.01, num(scale, 1))),
  };
}

const mod = (v, m) => ((v % m) + m) % m;

/**
 * Writes the pattern's colours into the RGBA buffer d (row width w) over rect (window coordinates). 0.3's code for an
 * unrotated pattern (exact tiling at 100 %, bilinear and wrapping otherwise), plus rotation.
 */
export function fillPattern(d, w, rect, pat, pl) {
  const pw = pat.width | 0, ph = pat.height | 0, pd = pat.data;
  const { ax, ay, scale } = pl;
  const rot = Math.abs(pl.angle % 360) > 1e-9;
  const x1 = rect.x + rect.width, y1 = rect.y + rect.height;
  if (!rot && Math.abs(scale - 1) < 1e-9 && Number.isInteger(ax) && Number.isInteger(ay)) {
    for (let y = rect.y; y < y1; y++) {
      const prow = mod(y - ay, ph) * pw;
      let u = mod(rect.x - ax, pw);
      for (let x = rect.x, p = (y * w + rect.x) * 4; x < x1; x++, p += 4) {
        const q = (prow + u) * 4;
        d[p] = pd[q];
        d[p + 1] = pd[q + 1];
        d[p + 2] = pd[q + 2];
        d[p + 3] = pd[q + 3];
        if (++u === pw) u = 0;
      }
    }
    return;
  }
  // bilinear, wrapping, premultiplied so transparent pattern pixels do not darken edges
  const c = Math.cos(pl.angle * RAD), s = Math.sin(pl.angle * RAD);
  for (let y = rect.y; y < y1; y++) {
    const dy = y + 0.5 - ay;
    for (let x = rect.x, p = (y * w + rect.x) * 4; x < x1; x++, p += 4) {
      const dx = x + 0.5 - ax;
      // the inverse of a visual counter-clockwise rotation in y-down coordinates
      const fu = (rot ? c * dx - s * dy : dx) / scale - 0.5;
      const fv = (rot ? s * dx + c * dy : dy) / scale - 0.5;
      const x0 = Math.floor(fu), tx = fu - x0;
      const y0 = Math.floor(fv), ty = fv - y0;
      const c0 = mod(x0, pw), c1 = c0 + 1 === pw ? 0 : c0 + 1;
      const r0 = mod(y0, ph) * pw, r1 = mod(y0 + 1, ph) * pw;
      let r = 0, g = 0, b = 0, aa = 0;
      for (let k = 0; k < 4; k++) {
        const q = ((k < 2 ? r0 : r1) + (k & 1 ? c1 : c0)) * 4;
        const wgt = (k & 1 ? tx : 1 - tx) * (k < 2 ? 1 - ty : ty);
        const pa = pd[q + 3] * wgt;
        r += pd[q] * pa;
        g += pd[q + 1] * pa;
        b += pd[q + 2] * pa;
        aa += pa;
      }
      if (aa > 0) {
        d[p] = r / aa;
        d[p + 1] = g / aa;
        d[p + 2] = b / aa;
        d[p + 3] = aa;
      } else d[p] = d[p + 1] = d[p + 2] = d[p + 3] = 0;
    }
  }
}

/**
 * The pattern's luminance (0..1, transparent pixels count as black, Photoshop reads a texture's grey levels) over the
 * whole w x h window: the Bevel & Emboss Texture's height.
 */
export function patternLuma(pat, pl, w, h) {
  const buf = new Uint8ClampedArray(w * h * 4);
  fillPattern(buf, w, { x: 0, y: 0, width: w, height: h }, pat, pl);
  const out = new Float32Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = ((0.299 * buf[p] + 0.587 * buf[p + 1] + 0.114 * buf[p + 2]) * buf[p + 3]) / (255 * 255);
  return out;
}

// ---- gradients -----------------------------------------------------------------------------------------------------

const KINDS = { linear: 0, reflected: 1, radial: 2, diamond: 3, angle: 4, 'shape-burst': 5 };

/**
 * The gradient parameter t of window pixel (x, y) for Gradient Overlay and the Stroke's gradient fill: 0.3's Gradient
 * Overlay geometry (the box is the layer's content box, or the document with Align with Layer off), moved by `offset`
 * (percent of the box). Shape Burst (Stroke only) reads `burst(i)`, the 0..1 position across the stroke.
 * Returns (x, y, i) => t (not clamped, not reversed).
 */
export function gradientParam(fx, box, burst = null) {
  const kind = KINDS[fx.kind] ?? 0;
  const a = num(fx.angle, 90) * RAD;
  const ux = Math.cos(a), uy = -Math.sin(a);
  const vx = -uy, vy = ux;
  const scale = Math.max(0.01, num(fx.scale, 1));
  const off = Array.isArray(fx.offset) ? fx.offset : [0, 0];
  const cx = box.x + box.width / 2 + (num(off[0], 0) / 100) * box.width;
  const cy = box.y + box.height / 2 + (num(off[1], 0) / 100) * box.height;
  const len = Math.max(1e-6, (Math.abs(box.width * ux) + Math.abs(box.height * uy)) * scale);
  const rad = Math.max(1e-6, (Math.max(box.width, box.height) / 2) * scale);
  const TWO_PI = Math.PI * 2;
  if (kind === 5) return (x, y, i) => (burst ? burst(i) : 0);
  return (x, y) => {
    const px = x + 0.5 - cx, py = y + 0.5 - cy;
    if (kind === 0) return 0.5 + (px * ux + py * uy) / len;
    if (kind === 1) return Math.abs(px * ux + py * uy) / (len / 2);
    if (kind === 2) return Math.sqrt(px * px + py * py) / rad;
    if (kind === 3) return (Math.abs(px * ux + py * uy) + Math.abs(px * vx + py * vy)) / rad;
    const t = (Math.atan2(-py, px) - a) / TWO_PI;
    return t - Math.floor(t);
  };
}

/** A LUT index of t for a table of `top` + 1 entries, with dithering by up to one entry when dither is on. */
export function lutIndex(t, top, reverse, ditherNoise) {
  if (reverse) t = 1 - t;
  if (ditherNoise !== null) t += ((ditherNoise - 0.5) * 2) / top;
  return t <= 0 ? 0 : t >= 1 ? top : (t * top + 0.5) | 0;
}

/** Gradient def of an effect (v2 `gradient`, else 0.3's `stops`), as a straight RGBA LUT of `size` entries. */
export function effectGradientLut(fx, size) {
  const g = fx.gradient && typeof fx.gradient === 'object' ? fx.gradient : { stops: Array.isArray(fx.stops) ? fx.stops : [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }] };
  return gradientLut(normalizeGradient(g), { size });
}
