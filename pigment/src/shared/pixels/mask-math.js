// Pure mask maths of masks-vector-masks (Pigment 0.4, ARCHITECTURE.md "0.4 features", K.1, J.1, J.3): density and
// feather of a layer mask or a vector mask, the intersection of the two parts and the vector mask's initial fill.
// No DOM: the renderer (lib/mask-render.js) reads the alpha of its canvases into these arrays and writes them back.
//
// A mask is a plane of coverage values 0..255 (255 shows the layer, 0 hides it), one per document pixel.
//   density d (0..1): what the mask hides is hidden only by d: m' = 255 - d * (255 - m)  (Photoshop's Density)
//   feather f (px):   a Gaussian blur of the mask with sigma = f / 2 (the same radius-to-sigma rule as
//                     Select > Modify > Feather); the kernel is renormalised at the document edge, so a mask that
//                     shows everything still shows everything after feathering (nothing fades in from outside)
// Feather is applied before density; density is affine, so the order changes only rounding.
import { gaussianBlur } from './matte.js';

export const MAX_FEATHER = 1000; // px, Photoshop's limit in the Properties panel

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Density as 0..1 (missing or invalid: 1, the default). */
export function maskDensity(m) {
  const d = Number(m?.density);
  return Number.isFinite(d) ? clamp(d, 0, 1) : 1;
}

/** Feather in px, 0..MAX_FEATHER (missing or invalid: 0). */
export function maskFeather(m) {
  const f = Number(m?.feather);
  return Number.isFinite(f) ? clamp(f, 0, MAX_FEATHER) : 0;
}

/** True when density and feather leave the mask as it is (the 0.3 fast path: the mask canvas itself). */
export function isPlainMask(m) {
  return maskDensity(m) >= 1 && maskFeather(m) <= 0;
}

/** Applies density to a coverage plane in place; returns it. */
export function applyDensity(alpha, density) {
  const d = clamp(Number(density), 0, 1);
  if (!(d < 1)) return alpha;
  // a lookup table: one multiply per possible value instead of per pixel
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.round(255 - d * (255 - v));
  for (let i = 0; i < alpha.length; i++) alpha[i] = lut[alpha[i]];
  return alpha;
}

/** Feathers a coverage plane (w x h) in place by `feather` px (sigma = feather / 2); returns it. */
export function featherAlpha(alpha, w, h, feather) {
  const sigma = clamp(Number(feather) || 0, 0, MAX_FEATHER) / 2;
  if (!(sigma > 0.05) || w * h !== alpha.length) return alpha;
  // nothing to blur when the plane is uniform (a Reveal All or Hide All mask): skip the passes
  const first = alpha[0];
  let uniform = true;
  for (let i = 1; i < alpha.length; i++) if (alpha[i] !== first) {
    uniform = false;
    break;
  }
  if (uniform) return alpha;
  const plane = new Float32Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) plane[i] = alpha[i];
  gaussianBlur(plane, w, h, sigma);
  for (let i = 0; i < alpha.length; i++) alpha[i] = plane[i]; // Uint8ClampedArray rounds to the nearest value
  return alpha;
}

/** Density and feather of one mask part (an object with `density` and `feather`) on a coverage plane, in place. */
export function refineMask(alpha, w, h, m) {
  featherAlpha(alpha, w, h, maskFeather(m));
  applyDensity(alpha, maskDensity(m));
  return alpha;
}

/** The intersection of two coverage planes (the layer shows where both show): a * b / 255, into `out`. */
export function intersectAlpha(a, b, out = new Uint8ClampedArray(a.length)) {
  for (let i = 0; i < a.length; i++) out[i] = (a[i] * b[i]) / 255; // the clamped array rounds to the nearest value
  return out;
}

/** The vector mask's starting coverage: 'reveal' starts visible (255), anything else hidden (0, 'hide'). */
export function initialCoverage(vm) {
  return vm?.initialFill === 'reveal' ? 255 : 0;
}

/**
 * True when the vector mask can hide anything: enabled, density above 0, and either it starts hidden ('hide': the
 * outside of the path is hidden) or a component subtracts, intersects or excludes (on 'reveal' a combined component
 * adds nothing). `subpathOp(sp)` gives a component's operation.
 */
export function vectorMaskHides(vm, subpathOp = (sp) => sp?.op ?? 'combine') {
  if (!vm || vm.enabled === false || maskDensity(vm) <= 0) return false;
  if (vm.initialFill !== 'reveal') return true;
  return (vm.path?.subpaths ?? []).some((sp) => sp?.points?.length > 1 && subpathOp(sp) !== 'combine');
}

/** True when the raster mask can hide anything: enabled, with a canvas and density above 0. */
export function rasterMaskHides(m) {
  return !!(m && m.enabled && m.canvas && maskDensity(m) > 0);
}

/** The box { x, y, width, height } of the pixels where two w x h planes differ, or null when they are equal. */
export function diffBounds(a, b, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let first = -1;
    for (let x = 0; x < w; x++) if (a[row + x] !== b[row + x]) {
      first = x;
      break;
    }
    if (first < 0) continue;
    let last = first;
    for (let x = w - 1; x > first; x--) if (a[row + x] !== b[row + x]) {
      last = x;
      break;
    }
    if (first < x0) x0 = first;
    if (last > x1) x1 = last;
    if (y < y0) y0 = y;
    y1 = y;
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** How far a change spreads under a feather of `feather` px: the reach of the blur kernel, in px. */
export function featherReach(feather) {
  const sigma = clamp(Number(feather) || 0, 0, MAX_FEATHER) / 2;
  return sigma > 0.05 ? Math.ceil(3 * sigma) + 4 : 0;
}

const growRect = (r, by, w, h) => {
  const x = Math.max(0, r.x - by), y = Math.max(0, r.y - by);
  return { x, y, width: Math.min(w, r.x + r.width + by) - x, height: Math.min(h, r.y + r.height + by) - y };
};

/**
 * The refined values (feather, then density) of the pixels a change inside `box` can reach, computed from the raw
 * plane (w x h) around them only: { rect, alpha } with alpha rect.width x rect.height. Equal to refining the whole
 * plane, within rounding: the input is the box grown by twice the kernel's reach, and only the pixels within one reach
 * (whose kernels stay inside the input, or meet the document edge as the whole-plane blur does) are returned.
 */
export function refineRegion(raw, w, h, m, box) {
  const reach = featherReach(maskFeather(m));
  const inner = growRect(box, reach, w, h);
  const outer = growRect(box, reach * 2, w, h);
  const sub = new Uint8ClampedArray(outer.width * outer.height);
  for (let y = 0; y < outer.height; y++) sub.set(raw.subarray((outer.y + y) * w + outer.x, (outer.y + y) * w + outer.x + outer.width), y * outer.width);
  refineMask(sub, outer.width, outer.height, m);
  const alpha = new Uint8ClampedArray(inner.width * inner.height);
  const dx = inner.x - outer.x, dy = inner.y - outer.y;
  for (let y = 0; y < inner.height; y++) alpha.set(sub.subarray((dy + y) * outer.width + dx, (dy + y) * outer.width + dx + inner.width), y * inner.width);
  return { rect: inner, alpha };
}
