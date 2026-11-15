// Live shape geometry (shapes-live, ARCHITECTURE.md "0.4 features", J.5): the paths of the parametric shapes
// (rectangles with per-corner radii, ellipses, triangles, polygons and stars with smoothing, lines with arrowheads,
// custom shapes in their box), all of them rotated by `angle` about the box centre, and the mapping of the live
// parameters through an affine transform (rotation into `angle`, scale into the sizes and radii; a skew is refused so
// the caller turns the shape into a plain path).
//
// Pure: no DOM, no app. tools/vector.js re-exports the 0.3 builders (rectPath, ellipsePath, polygonPath, linePath,
// customPath, CUSTOM_SHAPES, ...) from here, so their 0.3 output is unchanged.
//
// Paths are { subpaths: [{ closed, points: [{ x, y, inX?, inY?, outX?, outY? }], op? }] } in document coordinates.

export const KAPPA = 0.5522847498307936;
const EPS = 1e-9;

// ---- path basics (moved from tools/vector.js, unchanged) ---------------------------------------------------------

export function clonePath(path) {
  // `op` (path operation, see lib/path-ops.js) rides along; combine is the default and stays implicit
  return { subpaths: (path?.subpaths ?? []).map((sp) => ({ closed: !!sp.closed, points: sp.points.map((p) => ({ ...p })), ...(sp.op && sp.op !== 'combine' ? { op: sp.op } : {}) })) };
}

export function isEmptyPath(path) {
  return !path?.subpaths?.some((sp) => sp.points.length > 0);
}

const hasIn = (p) => p.inX !== undefined && p.inY !== undefined;
const hasOut = (p) => p.outX !== undefined && p.outY !== undefined;
const isLine = (a, b) => !hasOut(a) && !hasIn(b);
const segCtrl = (a, b) => [a.x, a.y, a.outX ?? a.x, a.outY ?? a.y, b.inX ?? b.x, b.inY ?? b.y, b.x, b.y];

function cubicAt(c, t) {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, cc = 3 * u * t * t, d = t * t * t;
  return [a * c[0] + b * c[2] + cc * c[4] + d * c[6], a * c[1] + b * c[3] + cc * c[5] + d * c[7]];
}

export function segmentCount(sp) {
  return sp.closed ? sp.points.length : Math.max(0, sp.points.length - 1);
}

/** Polyline of one subpath; `tol` is the maximum chord deviation in document pixels. */
export function flattenSubpath(sp, tol = 0.5) {
  const pts = sp.points;
  if (!pts.length) return [];
  const out = [[pts[0].x, pts[0].y]];
  const n = pts.length;
  for (let i = 0; i < segmentCount(sp); i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    if (isLine(a, b)) {
      out.push([b.x, b.y]);
      continue;
    }
    const c = segCtrl(a, b);
    const ddx = Math.max(Math.abs(c[0] - 2 * c[2] + c[4]), Math.abs(c[2] - 2 * c[4] + c[6]));
    const ddy = Math.max(Math.abs(c[1] - 2 * c[3] + c[5]), Math.abs(c[3] - 2 * c[5] + c[7]));
    const steps = Math.min(400, Math.max(2, Math.ceil(Math.sqrt((6 * Math.hypot(ddx, ddy)) / (8 * tol)))));
    for (let k = 1; k <= steps; k++) out.push(cubicAt(c, k / steps));
  }
  if (sp.closed && out.length > 1) {
    const f = out[0], l = out[out.length - 1];
    if (Math.abs(f[0] - l[0]) < 1e-9 && Math.abs(f[1] - l[1]) < 1e-9) out.pop();
  }
  return out;
}

export function flattenPath(path, tol = 0.5) {
  return (path?.subpaths ?? []).map((sp) => ({ closed: sp.closed, points: flattenSubpath(sp, tol) })).filter((p) => p.points.length);
}

export function signedArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Reverses a subpath's direction (anchors in reverse order, in/out handles swapped). */
export function reverseSubpath(sp) {
  const pts = sp.points.slice().reverse().map((p) => {
    const q = { x: p.x, y: p.y };
    if (hasOut(p)) {
      q.inX = p.outX;
      q.inY = p.outY;
    }
    if (hasIn(p)) {
      q.outX = p.inX;
      q.outY = p.inY;
    }
    return q;
  });
  if (sp.closed && pts.length > 1) pts.unshift(pts.pop()); // keep the same first anchor
  return { closed: sp.closed, points: pts };
}

/** Makes a closed subpath run clockwise on screen (positive area with y down). */
export function clockwise(sp) {
  return signedArea(flattenSubpath(sp, 1)) < 0 ? reverseSubpath(sp) : sp;
}

/** Maps every anchor and handle of `path` in place through fn(x, y) -> [x, y]; returns the path. */
export function mapPoints(path, fn) {
  for (const sp of path.subpaths) {
    for (const p of sp.points) {
      [p.x, p.y] = fn(p.x, p.y);
      if (hasIn(p)) [p.inX, p.inY] = fn(p.inX, p.inY);
      if (hasOut(p)) [p.outX, p.outY] = fn(p.outX, p.outY);
    }
  }
  return path;
}

// ---- 0.3 builders (unchanged output; closed subpaths run clockwise on screen) ---------------------------------------

export function rectPath(x, y, w, h, r = 0) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (r <= 0.01) return { subpaths: [{ closed: true, points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] }] };
  const k = r * KAPPA;
  const pts = [
    { x: x + r, y, inX: x + r - k, inY: y },
    { x: x + w - r, y, outX: x + w - r + k, outY: y },
    { x: x + w, y: y + r, inX: x + w, inY: y + r - k },
    { x: x + w, y: y + h - r, outX: x + w, outY: y + h - r + k },
    { x: x + w - r, y: y + h, inX: x + w - r + k, inY: y + h },
    { x: x + r, y: y + h, outX: x + r - k, outY: y + h },
    { x, y: y + h - r, inX: x, inY: y + h - r + k },
    { x, y: y + r, outX: x, outY: y + r - k },
  ];
  return { subpaths: [{ closed: true, points: mergeDuplicates(pts) }] };
}

/** Merges consecutive anchors at the same place (a radius that eats a whole side), the last one with the first too. */
function mergeDuplicates(pts) {
  const merged = [];
  for (const p of pts) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-6 && Math.abs(last.y - p.y) < 1e-6) Object.assign(last, hasOut(p) ? { outX: p.outX, outY: p.outY } : {});
    else merged.push(p);
  }
  const f = merged[0], l = merged[merged.length - 1];
  if (merged.length > 1 && Math.abs(f.x - l.x) < 1e-6 && Math.abs(f.y - l.y) < 1e-6) {
    merged.pop();
    if (hasOut(l)) Object.assign(f, { outX: l.outX, outY: l.outY });
    if (hasIn(l) && !hasIn(f)) Object.assign(f, { inX: l.inX, inY: l.inY });
  }
  return merged;
}

export function ellipsePath(x, y, w, h) {
  const rx = w / 2, ry = h / 2, cx = x + rx, cy = y + ry, kx = rx * KAPPA, ky = ry * KAPPA;
  return {
    subpaths: [{
      closed: true,
      points: [
        { x: cx, y: cy - ry, inX: cx - kx, inY: cy - ry, outX: cx + kx, outY: cy - ry },
        { x: cx + rx, y: cy, inX: cx + rx, inY: cy - ky, outX: cx + rx, outY: cy + ky },
        { x: cx, y: cy + ry, inX: cx + kx, inY: cy + ry, outX: cx - kx, outY: cy + ry },
        { x: cx - rx, y: cy, inX: cx - rx, inY: cy + ky, outX: cx - rx, outY: cy - ky },
      ],
    }],
  };
}

/** The anchors of a regular polygon or star in its box (first vertex at the top), as 0.3 placed them. */
function polygonVertices(x, y, w, h, sides, inner) {
  const n = Math.max(3, Math.min(100, Math.round(sides)));
  const rx = w / 2, ry = h / 2, cx = x + rx, cy = y + ry;
  const star = inner !== null;
  const count = star ? n * 2 : n;
  const pts = [];
  for (let k = 0; k < count; k++) {
    const a = -Math.PI / 2 + (k * Math.PI * 2) / count;
    const f = star && k % 2 ? inner : 1;
    pts.push({ x: cx + Math.cos(a) * rx * f, y: cy + Math.sin(a) * ry * f, outer: !(star && k % 2) });
  }
  return pts;
}

export function polygonPath(x, y, w, h, sides = 5, star = false, inset = 50) {
  const inner = star ? Math.max(0.01, Math.min(0.99, 1 - inset / 100)) : null;
  return { subpaths: [{ closed: true, points: polygonVertices(x, y, w, h, sides, inner).map((p) => ({ x: p.x, y: p.y })) }] };
}

/** 0.3's Line tool: a body of `weight` and triangular heads of max(6 px, 5 x weight). */
export function linePath(x1, y1, x2, y2, weight = 2, arrowStart = false, arrowEnd = false) {
  const head = Math.max(6, weight * 5);
  const arrow = (on) => (on ? { w: head, l: head, c: 0 } : null);
  return lineWithArrows(x1, y1, x2, y2, weight, arrow(arrowStart), arrow(arrowEnd));
}

/** A line body and arrowheads ({ w, l, c } in px and percent concavity, or null) as closed clockwise subpaths. */
function lineWithArrows(x1, y1, x2, y2, weight, start, end) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 1e-6) return { subpaths: [] };
  const ux = (x2 - x1) / len, uy = (y2 - y1) / len, nx = -uy, ny = ux;
  const w = Math.max(0.5, weight) / 2;
  let ax = x1, ay = y1, bx = x2, by = y2;
  const subpaths = [];
  const head = (tx, ty, dirX, dirY, a) => {
    const baseX = tx - dirX * a.l, baseY = ty - dirY * a.l;
    const pts = [{ x: tx, y: ty }, { x: baseX + (nx * a.w) / 2, y: baseY + (ny * a.w) / 2 }];
    // concavity moves the middle of the base towards the tip (positive) or away from it (negative)
    if (Math.abs(a.c) > EPS) {
      const back = a.l * (1 - a.c / 100);
      pts.push({ x: tx - dirX * back, y: ty - dirY * back });
    }
    pts.push({ x: baseX - (nx * a.w) / 2, y: baseY - (ny * a.w) / 2 });
    return clockwise({ closed: true, points: pts });
  };
  // the body stops inside the head (0.3: 90 % of its length), never in the notch of a concave head
  const inset = (a) => 0.9 * a.l * Math.min(1, 1 - a.c / 100);
  if (end && len > end.l) {
    subpaths.push(head(x2, y2, ux, uy, end));
    bx = x2 - ux * inset(end);
    by = y2 - uy * inset(end);
  }
  if (start && len > start.l) {
    subpaths.push(head(x1, y1, -ux, -uy, start));
    ax = x1 + ux * inset(start);
    ay = y1 + uy * inset(start);
  }
  subpaths.unshift(clockwise({ closed: true, points: [{ x: ax + nx * w, y: ay + ny * w }, { x: bx + nx * w, y: by + ny * w }, { x: bx - nx * w, y: by - ny * w }, { x: ax - nx * w, y: ay - ny * w }] }));
  return { subpaths };
}

/** Minimal SVG path parser (absolute M, L, C, Z) into Pigment path data. */
export function parseSvgPath(d) {
  const tokens = String(d).match(/[MLCZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  const subpaths = [];
  let sp = null, cmd = null;
  const num = () => Number(tokens.shift());
  while (tokens.length) {
    if (/^[MLCZ]$/i.test(tokens[0])) cmd = tokens.shift().toUpperCase();
    if (cmd === 'M') {
      sp = { closed: false, points: [{ x: num(), y: num() }] };
      subpaths.push(sp);
      cmd = 'L';
    } else if (cmd === 'L') sp.points.push({ x: num(), y: num() });
    else if (cmd === 'C') {
      const last = sp.points[sp.points.length - 1];
      last.outX = num();
      last.outY = num();
      const inX = num(), inY = num();
      sp.points.push({ x: num(), y: num(), inX, inY });
    } else if (cmd === 'Z') {
      sp.closed = true;
      const f = sp.points[0], l = sp.points[sp.points.length - 1];
      if (sp.points.length > 1 && Math.abs(f.x - l.x) < 1e-6 && Math.abs(f.y - l.y) < 1e-6) {
        sp.points.pop();
        if (hasIn(l)) Object.assign(f, { inX: l.inX, inY: l.inY });
      }
      cmd = null;
    } else tokens.shift();
  }
  return { subpaths };
}

/** Built-in custom shapes, drawn in a 100 × 100 box. */
export const CUSTOM_SHAPES = {
  heart: { name: 'Heart', d: 'M50 92 C35 80 0 58 0 30 C0 12 13 2 28 2 C39 2 46 9 50 17 C54 9 61 2 72 2 C87 2 100 12 100 30 C100 58 65 80 50 92 Z' },
  arrow: { name: 'Arrow', d: 'M0 30 L55 30 L55 5 L100 50 L55 95 L55 70 L0 70 Z' },
  star5: { name: 'Star (5 points)', build: () => polygonPath(0, 0, 100, 100, 5, true, 61.8) },
  check: { name: 'Check mark', d: 'M4 52 L18 38 L38 58 L82 14 L96 28 L38 86 Z' },
  bubble: { name: 'Speech bubble', d: 'M15 4 L85 4 C93 4 100 11 100 19 L100 56 C100 64 93 71 85 71 L46 71 L24 94 L28 71 L15 71 C7 71 0 64 0 56 L0 19 C0 11 7 4 15 4 Z' },
  plus: { name: 'Plus', d: 'M35 0 L65 0 L65 35 L100 35 L100 65 L65 65 L65 100 L35 100 L35 65 L0 65 L0 35 L35 35 Z' },
  bolt: { name: 'Lightning bolt', d: 'M60 0 L14 56 L45 56 L36 100 L86 38 L55 38 L68 0 Z' },
  drop: { name: 'Drop', d: 'M50 0 C50 0 88 42 88 64 C88 85 71 100 50 100 C29 100 12 85 12 64 C12 42 50 0 50 0 Z' },
};

export function customPath(name, x, y, w, h) {
  const def = CUSTOM_SHAPES[name] ?? CUSTOM_SHAPES.heart;
  const base = def.build ? def.build() : parseSvgPath(def.d);
  const path = clonePath(base);
  path.subpaths = path.subpaths.map(clockwise);
  return mapPoints(path, (px, py) => [x + (px / 100) * w, y + (py / 100) * h]);
}

// ---- rounded corners -------------------------------------------------------------------------------------------

/**
 * A closed subpath through `verts` ({ x, y, r, maxD? }) with each corner rounded by a circular arc of radius r
 * tangent to both sides (one cubic per arc). The tangent distance is clamped to `maxD` (default: half the shorter
 * side, so neighbouring arcs can meet but never overlap); r = Infinity rounds as far as the clamp allows.
 */
export function roundedPolygon(verts) {
  const n = verts.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const V = verts[i], A = verts[(i - 1 + n) % n], B = verts[(i + 1) % n];
    let r = V.r > 0 ? V.r : 0;
    const ax = A.x - V.x, ay = A.y - V.y, bx = B.x - V.x, by = B.y - V.y;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (!(r > 0) || la < EPS || lb < EPS) {
      out.push({ x: V.x, y: V.y });
      continue;
    }
    const u1x = ax / la, u1y = ay / la, u2x = bx / lb, u2y = by / lb;
    const theta = Math.acos(Math.max(-1, Math.min(1, u1x * u2x + u1y * u2y))); // the interior angle
    if (theta < 1e-6 || Math.PI - theta < 1e-6) {
      out.push({ x: V.x, y: V.y });
      continue;
    }
    const tanHalf = Math.tan(theta / 2);
    let d = r / tanHalf;
    const maxD = Number.isFinite(V.maxD) ? V.maxD : Math.min(la, lb) / 2;
    if (d > maxD) {
      d = maxD;
      r = d * tanHalf;
    }
    if (d < EPS) {
      out.push({ x: V.x, y: V.y });
      continue;
    }
    const hl = (4 / 3) * Math.tan((Math.PI - theta) / 4) * r;
    const t1x = V.x + u1x * d, t1y = V.y + u1y * d, t2x = V.x + u2x * d, t2y = V.y + u2y * d;
    out.push({ x: t1x, y: t1y, outX: t1x - u1x * hl, outY: t1y - u1y * hl });
    out.push({ x: t2x, y: t2y, inX: t2x - u2x * hl, inY: t2y - u2y * hl });
  }
  // arcs that meet on a side share an anchor: one smooth point
  const merged = [];
  const same = (p, q) => Math.abs(p.x - q.x) < 1e-6 && Math.abs(p.y - q.y) < 1e-6;
  const join = (p, q) => {
    if (hasIn(q) && !hasIn(p)) Object.assign(p, { inX: q.inX, inY: q.inY });
    if (hasOut(q) && !hasOut(p)) Object.assign(p, { outX: q.outX, outY: q.outY });
  };
  for (const p of out) {
    const last = merged[merged.length - 1];
    if (last && same(last, p)) join(last, p);
    else merged.push(p);
  }
  if (merged.length > 1 && same(merged[0], merged[merged.length - 1])) join(merged[0], merged.pop());
  return { closed: true, points: merged };
}

/** Photoshop's clamp of rectangle radii: all four scaled down together until no side is overfull. */
export function clampRadii(w, h, radii) {
  const [tl, tr, br, bl] = radii.map((r) => Math.max(0, Number(r) || 0));
  let f = 1;
  const fit = (side, a, b) => {
    if (a + b > side && a + b > 0) f = Math.min(f, side / (a + b));
  };
  fit(w, tl, tr);
  fit(w, bl, br);
  fit(h, tl, bl);
  fit(h, tr, br);
  return [tl * f, tr * f, br * f, bl * f];
}

// ---- live shapes -----------------------------------------------------------------------------------------------

const num = (v, d = 0) => (Number.isFinite(v) ? v : d);

/** Rotates a path in place by `deg` degrees (clockwise on screen) about (cx, cy). */
export function rotatePath(path, cx, cy, deg) {
  if (!deg || Math.abs(deg) < 1e-12) return path;
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return mapPoints(path, (x, y) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c]);
}

export function rectShapePath(p) {
  const x = num(p.x), y = num(p.y), w = Math.max(0, num(p.width)), h = Math.max(0, num(p.height));
  const radii = clampRadii(w, h, Array.isArray(p.radii) ? p.radii : [0, 0, 0, 0]);
  let path;
  if (radii.every((r) => Math.abs(r - radii[0]) < 1e-9)) path = rectPath(x, y, w, h, radii[0]);
  else {
    const sp = roundedPolygon([
      { x, y, r: radii[0], maxD: Infinity },
      { x: x + w, y, r: radii[1], maxD: Infinity },
      { x: x + w, y: y + h, r: radii[2], maxD: Infinity },
      { x, y: y + h, r: radii[3], maxD: Infinity },
    ]);
    // start on the top side, as rectPath does (the top-left arc's second anchor)
    if (radii[0] > 0.01 && sp.points.length > 1) sp.points.push(sp.points.shift());
    path = { subpaths: [sp] };
  }
  return rotatePath(path, x + w / 2, y + h / 2, num(p.angle));
}

export function ellipseShapePath(p) {
  const x = num(p.x), y = num(p.y), w = Math.max(0, num(p.width)), h = Math.max(0, num(p.height));
  return rotatePath(ellipsePath(x, y, w, h), x + w / 2, y + h / 2, num(p.angle));
}

/** The corner anchors of a triangle (an isosceles triangle in its box, apex at the top), clockwise. */
export function triangleVertices(p) {
  const x = num(p.x), y = num(p.y), w = num(p.width), h = num(p.height);
  return [{ x: x + w / 2, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

export function triangleShapePath(p) {
  const x = num(p.x), y = num(p.y), w = num(p.width), h = num(p.height);
  const r = Math.max(0, num(p.radius));
  const sp = roundedPolygon(triangleVertices(p).map((v) => ({ ...v, r })));
  return rotatePath({ subpaths: [sp] }, x + w / 2, y + h / 2, num(p.angle));
}

/** The anchors of a live polygon or star with the radius each corner is rounded by (outer and inner corners). */
export function polygonCorners(p) {
  const x = num(p.x), y = num(p.y), w = num(p.width), h = num(p.height);
  const ratio = num(p.starRatio, 100);
  const inner = ratio < 100 ? Math.max(0.01, Math.min(0.99, ratio / 100)) : null;
  const cr = Math.max(0, num(p.cornerRadius));
  return polygonVertices(x, y, w, h, num(p.sides, 5), inner).map((v) => ({
    x: v.x,
    y: v.y,
    outer: v.outer,
    // Smooth Corners / Smooth Indents round as far as the sides allow; otherwise the corner radius
    r: v.outer ? (p.smoothCorners ? Infinity : cr) : (p.smoothIndents ? Infinity : cr),
  }));
}

export function polygonShapePath(p) {
  const x = num(p.x), y = num(p.y), w = num(p.width), h = num(p.height);
  const corners = polygonCorners(p);
  const sp = corners.some((c) => c.r > 0) ? roundedPolygon(corners) : { closed: true, points: corners.map((c) => ({ x: c.x, y: c.y })) };
  return rotatePath({ subpaths: [sp] }, x + w / 2, y + h / 2, num(p.angle));
}

/** Arrowhead in px from its percent-of-weight form ({ width, length, concavity }), or null. */
export function arrowPx(a, weight) {
  if (!a || typeof a !== 'object') return null;
  const wt = Math.max(0.5, num(weight, 1));
  return { w: (Math.max(0, num(a.width, 500)) / 100) * wt, l: (Math.max(0, num(a.length, 500)) / 100) * wt, c: Math.max(-50, Math.min(50, num(a.concavity))) };
}

export function lineShapePath(p) {
  const weight = num(p.weight, 1);
  return lineWithArrows(num(p.x1), num(p.y1), num(p.x2), num(p.y2), weight, arrowPx(p.arrowStart, weight), arrowPx(p.arrowEnd, weight));
}

/** A custom shape: `unit` is its path in a 0..1 box (the 'shapes' preset data), placed in the box and rotated. */
export function customShapePath(p, unit) {
  const x = num(p.x), y = num(p.y), w = num(p.width), h = num(p.height);
  const src = unit && Array.isArray(unit.subpaths) ? unit : customPath(p.shape in CUSTOM_SHAPES ? p.shape : 'heart', 0, 0, 1, 1);
  const path = mapPoints(clonePath(src), (px, py) => [x + px * w, y + py * h]);
  return rotatePath(path, x + w / 2, y + h / 2, num(p.angle));
}

/**
 * The path of a live shape from its parameters (normalised, J.5), or null for kind 'path'. `customPathOf(id)` gives
 * the 0..1 path of a 'shapes' preset (custom shapes fall back to CUSTOM_SHAPES).
 */
export function shapePath(kind, props, { customPathOf = null } = {}) {
  const p = props ?? {};
  let path;
  switch (kind) {
    case 'rect': path = rectShapePath(p); break;
    case 'ellipse': path = ellipseShapePath(p); break;
    case 'triangle': path = triangleShapePath(p); break;
    case 'polygon': path = polygonShapePath(p); break;
    case 'line': path = lineShapePath(p); break;
    case 'custom': path = customShapePath(p, customPathOf?.(p.shape) ?? null); break;
    default: return null;
  }
  // stored coordinates without floating noise (1e-6 px)
  return mapPoints(path, (x, y) => [tidy(x), tidy(y)]);
}

// ---- mapping live parameters through an affine transform ---------------------------------------------------------

/** Rounds away floating noise (1e-6 px) so that a rotation by 0 or a scale by 1 gives the exact numbers back. */
export const tidy = (v) => {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
};

/** Angle in (-180, 180]. */
export function normalizeAngle(deg) {
  let a = ((deg % 360) + 360) % 360;
  if (a > 180) a -= 360;
  return tidy(a);
}

const BOX_KINDS = new Set(['rect', 'ellipse', 'triangle', 'polygon', 'custom']);

/**
 * The live parameters of a normalised shape after the affine matrix m = [a, b, c, d, e, f] (x' = a x + c y + e,
 * y' = b x + d y + f), or null when the result is not that kind of shape any more (a skew, a flip of a custom shape,
 * a collapse to zero size). Rotation goes into `angle`, scale into the box size; radii scale by the smaller factor
 * so corners stay circular; a flip mirrors the box (rectangle corners swap sides).
 */
export function mapLiveProps(kind, props, m) {
  const [a, b, c, d, e, f] = m;
  const apply = (x, y) => [a * x + c * y + e, b * x + d * y + f];
  const det = a * d - b * c;
  if (kind === 'line') {
    const [x1, y1] = apply(num(props.x1), num(props.y1));
    const [x2, y2] = apply(num(props.x2), num(props.y2));
    const dx = num(props.x2) - num(props.x1), dy = num(props.y2) - num(props.y1);
    const len = Math.hypot(dx, dy);
    let k = Math.sqrt(Math.abs(det));
    if (len > EPS) {
      const ux = dx / len, uy = dy / len;
      const along = Math.hypot(a * ux + c * uy, b * ux + d * uy);
      // the distance between the mapped sides of the body: |det| / |M u|
      if (along > EPS) k = Math.abs(det) / along;
    }
    if (!(k > EPS)) return null;
    return { ...props, x1: tidy(x1), y1: tidy(y1), x2: tidy(x2), y2: tidy(y2), weight: tidy(num(props.weight, 1) * k) };
  }
  if (!BOX_KINDS.has(kind)) return null;
  const w = num(props.width), h = num(props.height);
  const th = (num(props.angle) * Math.PI) / 180;
  const cs = Math.cos(th), sn = Math.sin(th);
  // the shape's own axes after the transform: A = M R(angle)
  let c1x = a * cs + c * sn, c1y = b * cs + d * sn;
  const c2x = -a * sn + c * cs, c2y = -b * sn + d * cs;
  const flip = det < 0;
  if (flip) {
    if (kind === 'custom') return null; // a custom shape is not symmetric: mirrored it is a plain path
    // mirrored in its own frame: A F with F = diag(-1, 1)
    c1x = -c1x;
    c1y = -c1y;
  }
  const sx = Math.hypot(c1x, c1y), sy = Math.hypot(c2x, c2y);
  if (sx < EPS || sy < EPS) return null;
  if (Math.abs(c1x * c2x + c1y * c2y) > 1e-6 * sx * sy) return null; // skew
  const angle = normalizeAngle((Math.atan2(c1y, c1x) * 180) / Math.PI);
  const [cx, cy] = apply(num(props.x) + w / 2, num(props.y) + h / 2);
  const nw = w * sx, nh = h * sy;
  const out = { ...props, x: tidy(cx - nw / 2), y: tidy(cy - nh / 2), width: tidy(nw), height: tidy(nh), angle };
  const k = Math.min(sx, sy);
  if (kind === 'rect') {
    const r = (Array.isArray(props.radii) ? props.radii : [0, 0, 0, 0]).map((v) => tidy(num(v) * k));
    out.radii = flip ? [r[1], r[0], r[3], r[2]] : r;
  } else if (kind === 'triangle') out.radius = tidy(num(props.radius) * k);
  else if (kind === 'polygon') out.cornerRadius = tidy(num(props.cornerRadius) * k);
  return out;
}

/**
 * The affine matrix that pointFn applies, fitted on three points of `box` and checked on a fourth and the centre;
 * null when pointFn is not affine there (perspective).
 */
export function fitAffine(pointFn, box) {
  const x0 = box.x, y0 = box.y, w = Math.max(1, box.width), h = Math.max(1, box.height);
  const p00 = pointFn(x0, y0), p10 = pointFn(x0 + w, y0), p01 = pointFn(x0, y0 + h);
  const a = (p10[0] - p00[0]) / w, b = (p10[1] - p00[1]) / w, c = (p01[0] - p00[0]) / h, d = (p01[1] - p00[1]) / h;
  const e = p00[0] - a * x0 - c * y0, f = p00[1] - b * x0 - d * y0;
  const m = [a, b, c, d, e, f];
  const tol = 1e-6 * Math.max(1, Math.hypot(w, h));
  for (const [px, py] of [[x0 + w, y0 + h], [x0 + w / 2, y0 + h / 2]]) {
    const q = pointFn(px, py);
    if (Math.abs(a * px + c * py + e - q[0]) > tol || Math.abs(b * px + d * py + f - q[1]) > tol) return null;
  }
  return m;
}

// ---- stroke extent ------------------------------------------------------------------------------------------------

/**
 * How far a stroke reaches outside the path outline (px, before anti-aliasing): half the width for a centred stroke,
 * the width outside, nothing inside; a miter join reaches miterLimit times that, a square cap of a dash or open end
 * √2 times.
 */
export function strokeReach(stroke) {
  const w = num(stroke?.width);
  if (!(w > 0)) return 0;
  const align = stroke.align === 'inside' || stroke.align === 'outside' ? stroke.align : 'center';
  const half = align === 'inside' ? 0 : align === 'outside' ? w : w / 2;
  const join = stroke.join ?? 'miter';
  const limit = Math.max(1, num(stroke.miterLimit, 4));
  return Math.max(join === 'miter' ? half * limit : half, stroke.cap === 'square' ? half * Math.SQRT2 : half);
}
