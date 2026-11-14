// Contours (Photoshop's Contour Editor and contour presets, ARCHITECTURE.md "0.4 features", J.6): a curve from
// 0..1 to 0..1 that reshapes how an effect fades. Shadows, glows and satin map their opacity profile through it, the
// Bevel & Emboss Contour sub-effect reshapes the bevel's height profile and the Gloss Contour reshapes its lighting.
// Pure, no DOM: runs in the renderer, the pixel worker and Node tests.
//
//   Contour = { name?: string, points: { x, y, corner: boolean }[] }   x, y in 0..1, sorted by x, first x = 0, last x = 1
//
// The curve passes through every point. Between corner points (the two end points always act as ends) the points are
// joined by a natural cubic spline, as in Curves; a corner point breaks the spline, so the curve has a sharp bend
// there. Values are clamped to 0..1. A LUT of `size` entries samples the curve; with anti-aliasing the LUT is
// smoothed a little and read with linear interpolation (Photoshop's "Anti-aliased" box softens the hard steps of
// contours like Rounded Steps and Sawtooth), without it the nearest entry is read.

export const LINEAR_CONTOUR = Object.freeze({ name: 'Linear', points: Object.freeze([Object.freeze({ x: 0, y: 0, corner: false }), Object.freeze({ x: 1, y: 1, corner: false })]) });

const P = (x, y, corner = false) => ({ x, y, corner });

/**
 * Photoshop's built-in contours (the default set of the contour picker), as close as their published shapes allow.
 * Ids are stable across releases (the preset store refers to them); 'linear' is the skeleton's built-in.
 */
export const CONTOUR_PRESETS = Object.freeze([
  { id: 'linear', name: 'Linear', points: [P(0, 0), P(1, 1)] },
  { id: 'cone', name: 'Cone', points: [P(0, 0), P(0.5, 1, true), P(1, 0)] },
  { id: 'cone-inverted', name: 'Cone - Inverted', points: [P(0, 1), P(0.5, 0, true), P(1, 1)] },
  { id: 'cove-deep', name: 'Cove - Deep', points: [P(0, 0), P(0.6, 0.12), P(1, 1)] },
  { id: 'cove-shallow', name: 'Cove - Shallow', points: [P(0, 0), P(0.55, 0.3), P(1, 1)] },
  { id: 'gaussian', name: 'Gaussian', points: [P(0, 0), P(0.25, 0.07), P(0.5, 0.5), P(0.75, 0.93), P(1, 1)] },
  { id: 'half-round', name: 'Half Round', points: [P(0, 0), P(0.13, 0.5), P(0.5, 0.87), P(1, 1)] },
  { id: 'ring', name: 'Ring', points: [P(0, 0), P(0.5, 1), P(1, 0)] },
  { id: 'ring-double', name: 'Ring - Double', points: [P(0, 0), P(0.25, 1), P(0.5, 0), P(0.75, 1), P(1, 0)] },
  { id: 'rolling-slope-descending', name: 'Rolling Slope - Descending', points: [P(0, 1), P(0.3, 0.62), P(0.6, 0.55), P(1, 0)] },
  { id: 'rounded-steps', name: 'Rounded Steps', points: [P(0, 0), P(0.2, 0.04), P(0.3, 0.33), P(0.45, 0.37), P(0.55, 0.63), P(0.7, 0.67), P(0.8, 0.96), P(1, 1)] },
  { id: 'sawtooth-1', name: 'Sawtooth 1', points: [P(0, 0), P(0.49, 1, true), P(0.51, 0, true), P(1, 1)] },
].map((c) => Object.freeze({ ...c, points: Object.freeze(c.points.map((p) => Object.freeze(p))) })));

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const finite = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * A valid Contour from anything (null for nothing usable): points clamped to 0..1, sorted by x, points closer than
 * 1/1000 in x merged (the later wins), the first moved to x = 0 and the last to x = 1, `corner` a boolean. A name
 * that is a string is kept.
 */
export function normalizeContour(c) {
  if (!c || typeof c !== 'object' || !Array.isArray(c.points)) return null;
  const pts = c.points
    .filter((p) => p && typeof p === 'object' && Number.isFinite(p.x) && Number.isFinite(p.y))
    .map((p) => ({ x: clamp01(p.x), y: clamp01(p.y), corner: !!p.corner }))
    .sort((a, b) => a.x - b.x);
  const out = [];
  for (const p of pts) {
    if (out.length && p.x - out[out.length - 1].x < 1e-3) out[out.length - 1] = p;
    else out.push(p);
  }
  if (out.length < 2) return null;
  out[0] = { ...out[0], x: 0 };
  out[out.length - 1] = { ...out[out.length - 1], x: 1 };
  const res = { points: out };
  if (typeof c.name === 'string') res.name = c.name;
  return res;
}

/** True for no contour and for any contour whose points all lie on y = x (the spline through them is the line). */
export function isLinearContour(c) {
  if (!c || !Array.isArray(c.points) || c.points.length < 2) return true;
  return c.points.every((p) => p && Math.abs(finite(p.y, 0) - finite(p.x, 0)) < 1e-6);
}

/** Second derivatives of the natural cubic spline through xs, ys (tridiagonal solve). */
function splineM(xs, ys) {
  const n = xs.length;
  const m = new Float64Array(n);
  if (n < 3) return m;
  const a = new Float64Array(n), b = new Float64Array(n), c = new Float64Array(n), r = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) {
    const h0 = xs[i] - xs[i - 1], h1 = xs[i + 1] - xs[i];
    a[i] = h0 / 6;
    b[i] = (h0 + h1) / 3;
    c[i] = h1 / 6;
    r[i] = (ys[i + 1] - ys[i]) / h1 - (ys[i] - ys[i - 1]) / h0;
  }
  // forward sweep over rows 1..n-2 (m[0] = m[n-1] = 0)
  for (let i = 2; i < n - 1; i++) {
    const w = a[i] / b[i - 1];
    b[i] -= w * c[i - 1];
    r[i] -= w * r[i - 1];
  }
  for (let i = n - 2; i >= 1; i--) m[i] = (r[i] - c[i] * m[i + 1]) / b[i];
  return m;
}

/** Evaluates the contour at x (0..1), clamped to 0..1. */
export function contourValue(contour, x) {
  const c = normalizeContour(contour) ?? LINEAR_CONTOUR;
  return evalSegments(segmentsOf(c), clamp01(x));
}

/** The contour split into spline segments at its corner points. */
function segmentsOf(c) {
  const pts = c.points;
  const segs = [];
  let start = 0;
  for (let i = 1; i < pts.length; i++) {
    if (i === pts.length - 1 || pts[i].corner) {
      const part = pts.slice(start, i + 1);
      const xs = part.map((p) => p.x), ys = part.map((p) => p.y);
      segs.push({ x0: xs[0], x1: xs[xs.length - 1], xs, ys, m: splineM(xs, ys) });
      start = i;
    }
  }
  return segs;
}

function evalSegments(segs, x) {
  let s = segs[segs.length - 1];
  for (const seg of segs) {
    if (x <= seg.x1) {
      s = seg;
      break;
    }
  }
  const { xs, ys, m } = s;
  let k = 0;
  while (k < xs.length - 2 && x > xs[k + 1]) k++;
  const h = xs[k + 1] - xs[k];
  if (!(h > 0)) return clamp01(ys[k + 1]);
  const A = (xs[k + 1] - x) / h, B = (x - xs[k]) / h;
  const y = A * ys[k] + B * ys[k + 1] + ((A * A * A - A) * m[k] + (B * B * B - B) * m[k + 1]) * (h * h) / 6;
  return clamp01(y);
}

const LUT_CACHE = new Map();

/**
 * The contour sampled at `size` evenly spaced inputs (entry i is the value at i / (size - 1)), as a Float32Array of
 * 0..1 values. With antiAlias the table is smoothed by two box passes of about 1 % of the range each. Cached (the
 * cache holds the last 64 tables). A null or invalid contour is Linear.
 */
export function contourLut(contour, { size = 256, antiAlias = false } = {}) {
  const c = normalizeContour(contour) ?? LINEAR_CONTOUR;
  const key = `${size}|${antiAlias ? 1 : 0}|${c.points.map((p) => `${p.x},${p.y},${p.corner ? 1 : 0}`).join(';')}`;
  let lut = LUT_CACHE.get(key);
  if (lut) return lut;
  const segs = segmentsOf(c);
  lut = new Float32Array(size);
  for (let i = 0; i < size; i++) lut[i] = evalSegments(segs, size > 1 ? i / (size - 1) : 0);
  if (antiAlias && size > 8) {
    const r = Math.max(1, Math.round(size / 100));
    for (let pass = 0; pass < 2; pass++) {
      const copy = Float32Array.from(lut);
      for (let i = 0; i < size; i++) {
        let s = 0, n = 0;
        for (let j = i - r; j <= i + r; j++) {
          // mirror at the ends, so the end values stay where the curve puts them
          const q = j < 0 ? -j : j >= size ? 2 * (size - 1) - j : j;
          s += copy[q];
          n++;
        }
        lut[i] = s / n;
      }
    }
  }
  if (LUT_CACHE.size >= 64) LUT_CACHE.delete(LUT_CACHE.keys().next().value);
  LUT_CACHE.set(key, lut);
  return lut;
}

/**
 * Reads a contour LUT at v (0..1): linear interpolation with anti-aliasing, the nearest entry without (a contour
 * with hard steps then keeps them).
 */
export function lookupContour(lut, v, antiAlias) {
  const top = lut.length - 1;
  const f = (v <= 0 ? 0 : v >= 1 ? 1 : v) * top;
  if (!antiAlias) return lut[(f + 0.5) | 0];
  const i = f | 0;
  if (i >= top) return lut[top];
  const t = f - i;
  return lut[i] + (lut[i + 1] - lut[i]) * t;
}

/**
 * Glows' and the Bevel Contour's Range (0..1, default 0.5): which part of the effect the contour spans. The input is
 * scaled by 0.5 / range, so 50 % uses the whole contour over the whole effect, a lower range runs through the contour
 * over the outer part of the effect (and holds its end value inside), a higher range uses only its first part.
 */
export function rangeInput(v, range) {
  const r = Number.isFinite(range) && range > 0.005 ? range : 0.005;
  const t = (v * 0.5) / r;
  return t >= 1 ? 1 : t;
}

/** A Contour's points as a 0..1 polyline of n samples (thumbnails, the editor's curve). */
export function contourPolyline(contour, n = 64) {
  const lut = contourLut(contour, { size: n });
  return Array.from(lut, (y, i) => [i / (n - 1), y]);
}
