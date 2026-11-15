// Optical kerning (type-character-panel, ARCHITECTURE.md "0.4 features", package 3; B.2 registerKerner). Pure: no
// DOM, so Node tests feed it synthetic outlines.
//
// Metrics kerning uses the pairs the font designer stored; optical kerning ignores them and spaces each pair of
// glyphs by their shapes, which is what Photoshop's "Optical" setting does for fonts with poor or missing kerning
// tables and for pairs of different fonts. The method is the classic profile one:
//
//   1. Each glyph's outline is cut into horizontal bands (from 1 em above the baseline to 0.3 em below it). In every
//      band the glyph's left-most and right-most ink is found (scanline intersections of the flattened outline).
//   2. Profiles are limited to a depth of `depth` em from the glyph's bounding box, and a band without ink counts as
//      that deep, so open shapes (the counter of "C", the arms of "T") do not draw neighbours in without limit.
//   3. The white between two glyphs is the average gap over the bands where either glyph has ink. The pair is moved
//      so that this average equals the target, the same average measured on the font's own "nn" and "oo" pairs
//      (the designer's straight and round spacing), so each font keeps its own colour.
//   4. The move never lets ink of the two glyphs come closer than `minGap` em in any band, and is clamped to ±`limit`
//      em.
//
// PathData (document.js): { subpaths: [{ points: [{ x, y, inX?, inY?, outX?, outY? }], closed }] }, px, y down, the
// origin at the glyph's pen position on the baseline.

const DEFAULTS = Object.freeze({ bands: 40, top: -1, bottom: 0.3, depth: 0.15, minGap: 0.02, limit: 0.25, fallbackTarget: 0.12 });

/** Flattens a PathData into polylines ([x0, y0, x1, y1, ...] per subpath); cubic segments become `steps` lines. */
export function flattenPath(path, steps = 8) {
  const out = [];
  for (const sp of path?.subpaths ?? []) {
    const pts = sp.points ?? [];
    if (!pts.length) continue;
    const line = [pts[0].x, pts[0].y];
    const seg = (a, b) => {
      const c1x = a.outX ?? a.x, c1y = a.outY ?? a.y, c2x = b.inX ?? b.x, c2y = b.inY ?? b.y;
      const curved = c1x !== a.x || c1y !== a.y || c2x !== b.x || c2y !== b.y;
      if (!curved) {
        line.push(b.x, b.y);
        return;
      }
      for (let i = 1; i <= steps; i++) {
        const t = i / steps, u = 1 - t;
        const k0 = u * u * u, k1 = 3 * u * u * t, k2 = 3 * u * t * t, k3 = t * t * t;
        line.push(k0 * a.x + k1 * c1x + k2 * c2x + k3 * b.x, k0 * a.y + k1 * c1y + k2 * c2y + k3 * b.y);
      }
    };
    for (let i = 1; i < pts.length; i++) seg(pts[i - 1], pts[i]);
    if (sp.closed !== false && pts.length > 1) seg(pts[pts.length - 1], pts[0]);
    out.push(line);
  }
  return out;
}

/**
 * The horizontal profile of an outline: for each of `bands` bands between `top` and `bottom` (em of `size`, y down),
 * the left-most and right-most ink (px; NaN where the band has none), and the bounding box in x. Null-safe: an empty
 * or missing outline gives a profile with `ink: false`.
 */
export function glyphProfile(outline, { size, bands = DEFAULTS.bands, top = DEFAULTS.top, bottom = DEFAULTS.bottom } = {}) {
  const left = new Float64Array(bands).fill(NaN);
  const right = new Float64Array(bands).fill(NaN);
  const y0 = top * size, h = ((bottom - top) * size) / bands;
  let minX = Infinity, maxX = -Infinity;
  const mark = (j, x) => {
    if (j < 0 || j >= bands) return;
    if (!(left[j] <= x)) left[j] = x;
    if (!(right[j] >= x)) right[j] = x;
  };
  for (const line of flattenPath(outline)) {
    const n = line.length / 2;
    for (let i = 0; i < n; i++) {
      const ax = line[i * 2], ay = line[i * 2 + 1];
      if (ax < minX) minX = ax;
      if (ax > maxX) maxX = ax;
      // the vertex itself (thin horizontal strokes between band centres still count)
      mark(Math.floor((ay - y0) / h), ax);
      if (i === n - 1) break;
      const bx = line[i * 2 + 2], by = line[i * 2 + 3];
      if (ay === by) continue;
      const lo = Math.min(ay, by), hi = Math.max(ay, by);
      // band centres inside [lo, hi): scanline intersections
      const j0 = Math.max(0, Math.ceil((lo - y0) / h - 0.5));
      const j1 = Math.min(bands - 1, Math.floor((hi - y0) / h - 0.5));
      for (let j = j0; j <= j1; j++) {
        const yc = y0 + (j + 0.5) * h;
        if (yc < lo || yc >= hi) continue;
        mark(j, ax + ((yc - ay) * (bx - ax)) / (by - ay));
      }
    }
  }
  let ink = false;
  for (let j = 0; j < bands; j++) if (left[j] === left[j]) ink = true;
  return { left, right, ink, minX: ink ? minX : 0, maxX: ink ? maxX : 0, bands };
}

/**
 * The average gap (px) between glyph `a` set at the origin with advance `advance` and glyph `b` after it, over the
 * bands where either has ink, with profiles limited to `depth` px from each bounding box; and the smallest raw gap
 * (px) over the bands where both have ink (Infinity when there is none).
 */
export function pairGap(a, b, advance, depthPx) {
  let sum = 0, count = 0, closest = Infinity;
  const n = Math.min(a.bands, b.bands);
  const rLimit = a.maxX - depthPx, lLimit = b.minX + depthPx;
  for (let j = 0; j < n; j++) {
    const ra = a.right[j], lb = b.left[j];
    const hasA = ra === ra, hasB = lb === lb;
    if (!hasA && !hasB) continue;
    const r = hasA ? Math.max(ra, rLimit) : rLimit;
    const l = hasB ? Math.min(lb, lLimit) : lLimit;
    sum += advance + l - r;
    count++;
    if (hasA && hasB) closest = Math.min(closest, advance + lb - ra);
  }
  if (!count) return { mean: NaN, closest };
  return { mean: sum / count, closest };
}

/**
 * The target gap (px) of a font at a size: the mean gap of its "nn" and "oo" pairs (`refs`: [{ outline, advance }]
 * for the glyphs n and o, either may be missing), else `fallbackTarget` em.
 */
export function referenceTarget(refs, { size, depth = DEFAULTS.depth, fallbackTarget = DEFAULTS.fallbackTarget, bands, top, bottom } = {}) {
  const gaps = [];
  for (const r of refs ?? []) {
    if (!r?.outline || !(r.advance > 0)) continue;
    const p = glyphProfile(r.outline, { size, bands, top, bottom });
    if (!p.ink) continue;
    const g = pairGap(p, p, r.advance, depth * size).mean;
    if (Number.isFinite(g)) gaps.push(g);
  }
  if (!gaps.length) return fallbackTarget * size;
  return gaps.reduce((s, g) => s + g, 0) / gaps.length;
}

/**
 * Optical kerning of a sequence of shaping units: `units` [{ outline: PathData | null, advance: px }] in logical
 * order, `size` the drawn size in px, `em` the size the result is measured in (the run's nominal size; super- and
 * subscript draw smaller), `target` the gap to reach in px (referenceTarget). Returns the extra advance after each
 * unit in 1/1000 em of `em`, rounded to whole units as Photoshop shows them (0 after the last unit, and next to a
 * unit without ink, such as a space).
 */
export function opticalKerning(units, { size, em = size, target, depth = DEFAULTS.depth, minGap = DEFAULTS.minGap, limit = DEFAULTS.limit, bands, top, bottom, profileOf } = {}) {
  const out = new Array(units.length).fill(0);
  if (!(size > 0) || !(em > 0) || units.length < 2) return out;
  const goal = Number.isFinite(target) ? target : DEFAULTS.fallbackTarget * size;
  const prof = units.map((u) => (u?.outline ? (profileOf ? profileOf(u) : glyphProfile(u.outline, { size, bands, top, bottom })) : null));
  for (let k = 0; k < units.length - 1; k++) {
    const a = prof[k], b = prof[k + 1];
    if (!a?.ink || !b?.ink) continue;
    const { mean, closest } = pairGap(a, b, units[k].advance, depth * size);
    if (!Number.isFinite(mean)) continue;
    let s = goal - mean;
    if (Number.isFinite(closest)) s = Math.max(s, minGap * size - closest);
    s = Math.max(-limit * size, Math.min(limit * size, s));
    const v = Math.round((s / em) * 1000);
    out[k] = v === 0 ? 0 : v; // no -0
  }
  return out;
}

export const OPTICAL_DEFAULTS = DEFAULTS;
