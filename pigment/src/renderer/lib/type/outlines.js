// Glyph outlines of a text layer (0.5, type-menu-commands; ARCHITECTURE.md "0.5 features", S11.3).
//
// The HarfBuzz engine's layout (lib/type/layout.js) gives every run its `units` (with their glyphs), its `face` and
// its `size`; fonts.js unitOutline turns one unit into PathData relative to the unit's pen start. This module places
// those outlines the way lib/type/render.js draws them (horizontal and vertical scale, a composer's glyph scale, the
// slant of faux or synthesised italic), adds underline and strikethrough as rectangles, and hands them on in two
// forms:
//   - layerOutlines(layer): per run { style, subpaths, decorations, stroke, bold } in the layer's base space, or null
//     when nothing has an outline. The Canvas fallback engine draws with fillText and has no outlines at all; a colour
//     glyph or a character drawn by the browser's fallback leaves `complete` false.
//   - outlinePath(layer, map): one PathData with a subpath per glyph contour (Create Work Path, Convert to Shape,
//     the Type Mask tools never need it), mapped point by point into document space.
// Text on a path (lib/text-path.js) gives its glyphs ({ x, y, angle, width, item }) instead of lines; their units are
// placed the same way. Stacked vertical text is drawn with fillText and has no outlines.
//
// The pure parts (placing, flattening, mapping) run in Node; paintOutlines() needs a canvas.
import { unitOutline, synthesis } from './fonts.js';
import { faceMetrics } from './shaper.js';
import { textExtensionFor } from '../document.js';
import { layoutText } from './api.js';

const SKEW = 0.2; // faux italic slant (render.js)

function allRuns(line) {
  const out = [...line.runs];
  if (line._hyphen) out.push(line._hyphen);
  if (line._marker) out.push(line._marker);
  return out;
}

/** Underline and strikethrough metrics in px (y down from the baseline), as render.js decoration() reads them. */
function decorationOf(run) {
  const rec = run.face;
  const st = run.style;
  if (!rec) return { underlinePos: st.size * 0.12, underlineSize: Math.max(1, st.size / 16), strikePos: -st.size * 0.3, strikeSize: Math.max(1, st.size / 16) };
  const m = faceMetrics(rec);
  const k = run.size / rec.upem;
  return { underlinePos: -m.underlineOffset * k, underlineSize: Math.max(1, m.underlineSize * k), strikePos: -m.strikeOffset * k, strikeSize: Math.max(1, m.strikeSize * k) };
}

/** Maps every anchor and handle of a subpath through an affine map p -> [a x + c y + e, b x + d y + f]. */
function affineSubpath(sp, m) {
  const [a, b, c, d, e, f] = m;
  const X = (x, y) => a * x + c * y + e;
  const Y = (x, y) => b * x + d * y + f;
  return {
    closed: sp.closed,
    points: sp.points.map((p) => {
      const q = { x: X(p.x, p.y), y: Y(p.x, p.y) };
      if (p.inX !== undefined) {
        q.inX = X(p.inX, p.inY);
        q.inY = Y(p.inX, p.inY);
      }
      if (p.outX !== undefined) {
        q.outX = X(p.outX, p.outY);
        q.outY = Y(p.outX, p.outY);
      }
      return q;
    }),
  };
}

/**
 * The affine placement of a unit outline (pen-relative, y down from the baseline, horizontal scale applied by
 * unitOutline) at pen (x, baseline): vertical scale sy and slant (render.js addGlyph: x' = x - slant·sx·y).
 */
const placement = (x, baseline, sx, sy, italic) => [1, 0, italic ? -SKEW * sx : 0, sy, x, baseline];

/** A rectangle as a closed subpath, wound like `like` (a glyph contour) so nonzero filling never cuts holes. */
function rectSubpath(x, y, w, h, clockwise = true) {
  const pts = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  return { closed: true, points: clockwise ? pts : pts.reverse() };
}

/** Signed area of a subpath's anchor polygon (positive: clockwise on a y-down canvas). */
export function signedArea(sp) {
  const p = sp.points;
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/** The outlines of one run's units (each placed by `placeUnit(u)` → affine), with `complete` false for a unit without. */
function runUnits(run, gs, placeUnit, out) {
  const st = run.style;
  const syn = run.face ? synthesis(run.face, st) : { bold: false, italic: false };
  const sx = (run.scaleX ?? 1) * gs, sy = run.scaleY ?? 1;
  const italic = !!st.fauxItalic || syn.italic;
  const subpaths = [];
  let complete = true;
  for (const u of run.units ?? []) {
    if (u.kind === 'glyphs' && run.face) {
      // a composer's glyph scale spreads the glyph offsets as render.js does (g.x × gs)
      const unit = gs === 1 ? u : { ...u, glyphs: u.glyphs.map((g) => ({ ...g, x: g.x * gs })) };
      const p = unitOutline(run.face, unit, sx);
      if (!p) continue;
      const m = placeUnit(u, sx, sy, italic);
      for (const sp of p.subpaths) subpaths.push(affineSubpath(sp, m));
    } else if (u.str && /\S/.test(u.str)) complete = false; // a colour glyph or text the browser draws
  }
  out.complete &&= complete;
  return { style: st, subpaths, bold: !!st.fauxBold || syn.bold, stroke: st.stroke && st.stroke.width > 0 ? { width: st.stroke.width, color: st.stroke.color ?? '#000' } : null };
}

/**
 * The outlines of a laid-out straight text (HarfBuzz layout) in base space: { complete, runs: [{ style, subpaths,
 * decorations, stroke, bold }] }, or null when the layout has no outlines (the Canvas engine).
 */
export function layoutOutlines(lay) {
  if (!lay || lay.engine !== 'harfbuzz' || !Array.isArray(lay.lines)) return null;
  const out = { complete: true, runs: [] };
  let any = false;
  for (const line of lay.lines) {
    if (!line.visible) continue;
    for (const run of allRuns(line)) {
      const gs = run === line._hyphen || run === line._marker ? 1 : line._glyphScale ?? 1;
      if (!run.face) {
        // tabs and forced breaks are faceless runs with nothing to draw; any other faceless run is drawn by the browser
        if ((run.units ?? []).length) out.complete = false;
        continue;
      }
      const r = runUnits(run, gs, (u, sx, sy, italic) => placement(u.x, run.baseline, sx, sy, italic), out);
      const st = run.style;
      r.decorations = [];
      if ((st.underline || st.strike) && run.advance > 0) {
        const d = decorationOf(run);
        const cw = r.subpaths.length ? signedArea(r.subpaths[0]) >= 0 : true;
        if (st.underline) r.decorations.push(rectSubpath(run.x, run.baseline + d.underlinePos, run.advance, d.underlineSize, cw));
        if (st.strike) r.decorations.push(rectSubpath(run.x, run.baseline + d.strikePos, run.advance, d.strikeSize, cw));
      }
      if (r.subpaths.length || r.decorations.length) any = true;
      out.runs.push(r);
    }
  }
  return any ? out : null;
}

/** The outlines of text on a path (lib/text-path.js glyphs, each a unit placed by translate, rotate, half-width). */
function pathOutlines(lay) {
  if (!Array.isArray(lay?.glyphs)) return null;
  const out = { complete: true, runs: [] };
  let any = false;
  for (const g of lay.glyphs) {
    if (g.hidden || !g.ch?.trim()) continue;
    const item = g.item;
    if (!item?.unit || !item.run?.face) {
      out.complete = false;
      continue;
    }
    const run = item.run;
    const c = Math.cos(g.angle || 0), s = Math.sin(g.angle || 0);
    // translate(g.x, g.y) · rotate(angle) · translate(-width / 2, 0) · placement at the origin
    const place = (u, sx, sy, italic) => {
      const p = placement(-g.width / 2, 0, sx, sy, italic);
      return [c * p[0] - s * p[1], s * p[0] + c * p[1], c * p[2] - s * p[3], s * p[2] + c * p[3], g.x + c * p[4] - s * p[5], g.y + s * p[4] + c * p[5]];
    };
    const r = runUnits({ ...run, units: [item.unit] }, 1, place, out);
    r.decorations = [];
    const st = run.style;
    const w = item.unit.advance - (item.unit.trk ?? 0);
    if ((st.underline || st.strike) && w > 0) {
      const d = decorationOf(run);
      const cw = r.subpaths.length ? signedArea(r.subpaths[0]) >= 0 : true;
      const m = [c, s, -s, c, g.x - c * (g.width / 2), g.y - s * (g.width / 2)];
      if (st.underline) r.decorations.push(affineSubpath(rectSubpath(0, d.underlinePos, w, d.underlineSize, cw), m));
      if (st.strike) r.decorations.push(affineSubpath(rectSubpath(0, d.strikePos, w, d.strikeSize, cw), m));
    }
    if (r.subpaths.length || r.decorations.length) any = true;
    out.runs.push(r);
  }
  return any ? out : null;
}

/** The outlines a text layer displays, in its base space (before `layer.transform`), or null (see layoutOutlines). */
export function layerOutlines(layer) {
  if (layer?.type !== 'text') return null;
  const lay = layoutText(layer);
  if (textExtensionFor(layer)) return pathOutlines(lay);
  return layoutOutlines(lay);
}

// ---- flattening and mapping ---------------------------------------------------------------------------------------

/**
 * Flattens a subpath into a closed polygon [x0, y0, x1, y1, ...] (Float64Array): cubic segments into chords within
 * `tol` px, and every piece cut to at most `maxSeg` px so that a non-linear map (a warp) bends straight edges too.
 */
export function flattenSubpathPoints(sp, tol = 0.2, maxSeg = Infinity) {
  const pts = sp.points;
  const out = [];
  if (!pts?.length) return new Float64Array(0);
  out.push(pts[0].x, pts[0].y);
  const n = pts.length;
  const segs = sp.closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const curved = a.outX !== undefined || b.inX !== undefined;
    if (!curved) {
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const k = Number.isFinite(maxSeg) ? Math.max(1, Math.ceil(len / maxSeg)) : 1;
      for (let j = 1; j <= k; j++) out.push(a.x + ((b.x - a.x) * j) / k, a.y + ((b.y - a.y) * j) / k);
      continue;
    }
    const x0 = a.x, y0 = a.y, x1 = a.outX ?? a.x, y1 = a.outY ?? a.y, x2 = b.inX ?? b.x, y2 = b.inY ?? b.y, x3 = b.x, y3 = b.y;
    // the second differences bound the chord error: n ≥ sqrt(0.75 · D / tol)
    const dd = Math.max(Math.hypot(x0 - 2 * x1 + x2, y0 - 2 * y1 + y2), Math.hypot(x1 - 2 * x2 + x3, y1 - 2 * y2 + y3));
    let k = Math.max(1, Math.ceil(Math.sqrt((0.75 * dd) / Math.max(1e-3, tol))));
    if (Number.isFinite(maxSeg)) k = Math.max(k, Math.ceil((Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2)) / maxSeg));
    k = Math.min(k, 256);
    for (let j = 1; j <= k; j++) {
      const t = j / k, s = 1 - t;
      const w0 = s * s * s, w1 = 3 * t * s * s, w2 = 3 * t * t * s, w3 = t * t * t;
      out.push(w0 * x0 + w1 * x1 + w2 * x2 + w3 * x3, w0 * y0 + w1 * y1 + w2 * y2 + w3 * y3);
    }
  }
  // a closed polygon: the last point repeats the first only when the subpath said so
  if (out.length >= 4 && Math.abs(out[out.length - 2] - out[0]) < 1e-9 && Math.abs(out[out.length - 1] - out[1]) < 1e-9) out.length -= 2;
  return Float64Array.from(out);
}

/** Polygons (flattened, then mapped point by point through `map(x, y) → [x, y]`) of a list of subpaths. */
export function mappedPolygons(subpaths, map = null, { tol = 0.2, maxSeg = Infinity } = {}) {
  const polys = [];
  for (const sp of subpaths) {
    const p = flattenSubpathPoints(sp, tol, map ? maxSeg : Infinity);
    if (p.length < 6) continue;
    if (map) {
      for (let i = 0; i < p.length; i += 2) {
        const q = map(p[i], p[i + 1]);
        p[i] = q[0];
        p[i + 1] = q[1];
      }
    }
    polys.push(p);
  }
  return polys;
}

/** De Casteljau split of a cubic at t: [[p0, l1, l2, m], [m, r1, r2, p3]] as [x, y] pairs. */
function splitCubic(p0, p1, p2, p3, t) {
  const lerp = (a, b) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const a = lerp(p0, p1), b = lerp(p1, p2), c = lerp(p2, p3);
  const d = lerp(a, b), e = lerp(b, c);
  const m = lerp(d, e);
  return [[p0, a, d, m], [m, e, c, p3]];
}

/**
 * A subpath mapped into another space keeping its curves: an affine map moves anchors and handles exactly; a
 * non-linear one (warp) maps each segment cut into pieces of at most `maxSeg` px, anchor and handles alike, which is
 * close for short pieces. Straight segments are cut too, so a warp bends them.
 */
export function mapSubpath(sp, map, { affine = false, maxSeg = 6 } = {}) {
  if (affine) {
    const P = (x, y) => map(x, y);
    return {
      closed: sp.closed,
      points: sp.points.map((p) => {
        const [x, y] = P(p.x, p.y);
        const q = { x, y };
        if (p.inX !== undefined) [q.inX, q.inY] = P(p.inX, p.inY);
        if (p.outX !== undefined) [q.outX, q.outY] = P(p.outX, p.outY);
        return q;
      }),
    };
  }
  const pts = sp.points;
  const n = pts.length;
  const segs = sp.closed ? n : n - 1;
  const out = [];
  const anchor = (x, y) => {
    const [mx, my] = map(x, y);
    const q = { x: mx, y: my };
    out.push(q);
    return q;
  };
  let cur = anchor(pts[0].x, pts[0].y);
  for (let i = 0; i < segs; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const p0 = [a.x, a.y], p1 = [a.outX ?? a.x, a.outY ?? a.y], p2 = [b.inX ?? b.x, b.inY ?? b.y], p3 = [b.x, b.y];
    const curved = a.outX !== undefined || b.inX !== undefined;
    const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) + Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
    const k = Math.max(1, Math.min(64, Math.ceil(len / maxSeg)));
    let rest = [p0, p1, p2, p3];
    for (let j = 0; j < k; j++) {
      let piece;
      if (j === k - 1) piece = rest;
      else {
        [piece, rest] = splitCubic(rest[0], rest[1], rest[2], rest[3], 1 / (k - j));
      }
      const last = sp.closed && i === segs - 1 && j === k - 1;
      const end = last ? out[0] : null;
      if (curved) {
        [cur.outX, cur.outY] = map(piece[1][0], piece[1][1]);
        const q = end ?? anchor(piece[3][0], piece[3][1]);
        [q.inX, q.inY] = map(piece[2][0], piece[2][1]);
        cur = q;
      } else cur = end ?? anchor(piece[3][0], piece[3][1]);
    }
  }
  return { closed: sp.closed, points: out };
}

const isAffineIdentity = (m) => !m || (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0);

/**
 * One PathData of every glyph contour (and the underline / strikethrough rectangles) of a text layer in document
 * space: the warp's map (`geometry`, base space) first, then the layer's transform matrix. Null when the layer has
 * no outlines; `complete` false when some character had none (left out).
 */
export function outlinePath(layer, { geometry = null } = {}) {
  const ol = layerOutlines(layer);
  if (!ol) return null;
  const m = layer.transform && !isAffineIdentity(layer.transform) ? layer.transform : null;
  const affine = m ? (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]] : (x, y) => [x, y];
  const subpaths = [];
  for (const r of ol.runs) {
    for (const sp of [...r.subpaths, ...r.decorations]) {
      if (sp.points.length < 2) continue;
      if (geometry) subpaths.push(mapSubpath(sp, (x, y) => {
        const p = geometry.mapPoint(x, y);
        return affine(p[0], p[1]);
      }));
      else subpaths.push(m ? mapSubpath(sp, affine, { affine: true }) : affineSubpath(sp, [1, 0, 0, 1, 0, 0]));
    }
  }
  return { path: { subpaths }, complete: ol.complete };
}

/** Bounds { x1, y1, x2, y2 } of polygons, or null. */
export function polygonsBounds(polys) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const p of polys) {
    for (let i = 0; i < p.length; i += 2) {
      const x = p[i], y = p[i + 1];
      if (x < x1) x1 = x;
      if (x > x2) x2 = x;
      if (y < y1) y1 = y;
      if (y > y2) y2 = y;
    }
  }
  return x1 === Infinity ? null : { x1, y1, x2, y2 };
}

/**
 * Draws outline runs with Canvas 2D (smooth anti-aliasing) as render.js draws them: stroke under the fill, faux bold
 * as a stroke of size / 30, then the fill and the decorations. `map(x, y)` takes base space to the canvas (offset
 * included); `scale` sizes the strokes. Browser only.
 */
export function paintOutlines(ctx, ol, map, { scale = 1, tol = 0.2, maxSeg = Infinity, colorOf } = {}) {
  const toPath = (polys) => {
    const p = new Path2D();
    for (const poly of polys) {
      p.moveTo(poly[0], poly[1]);
      for (let i = 2; i < poly.length; i += 2) p.lineTo(poly[i], poly[i + 1]);
      p.closePath();
    }
    return p;
  };
  for (const r of ol.runs) {
    const fill = colorOf(r.style);
    const glyphs = toPath(mappedPolygons(r.subpaths, map, { tol, maxSeg }));
    ctx.save();
    ctx.lineJoin = 'round';
    if (r.stroke) {
      ctx.lineWidth = r.stroke.width * scale;
      ctx.strokeStyle = r.stroke.color;
      ctx.stroke(glyphs);
    }
    if (r.bold) {
      ctx.lineWidth = (r.style.size / 30) * scale;
      ctx.strokeStyle = fill;
      ctx.stroke(glyphs);
    }
    ctx.fillStyle = fill;
    ctx.fill(glyphs);
    // decorations apart: a rectangle crossing a descender must not cancel it under the nonzero rule
    if (r.decorations.length) ctx.fill(toPath(mappedPolygons(r.decorations, map, { tol, maxSeg })));
    ctx.restore();
  }
}
