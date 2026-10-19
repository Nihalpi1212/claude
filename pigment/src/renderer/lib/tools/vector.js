// Vector tools (see ARCHITECTURE.md "Tools"): the shape tools (rectangle, rounded rectangle, ellipse,
// polygon/star, line, custom shape), the pen family (pen, freeform pen, add/delete anchor point,
// convert point), path selection and direct selection; the work path (doc.workPath) and the path
// commands (path:make-selection, path:fill, path:stroke, path:from-selection, path:save, path:new,
// path:delete, path:rename, path:select).
//
// Paths are { subpaths: [{ closed, points: [{ x, y, inX?, inY?, outX?, outY? }] }] } in absolute
// document coordinates (lib/document.js). A "path target" is where an edit goes: the work path, a
// saved path (doc.paths) or a shape layer's path. Gestures edit a draft copy (previewed live) and
// record one history entry when they end. Saved paths and the work path are treated as immutable
// values: every change replaces the object, so history entries can keep plain references.
import { Tool } from '../tools.js';
import { ShapeLayer, pathToPath2D, pathBounds, createCanvas, measureContext, newId, intersectRect } from '../document.js';
import { structural, setLayerProps, nextLayerName } from '../layer-ops.js';
import { Selection } from '../selection.js';
import { BrushStroke } from '../brush.js';
import { formDialog } from '../form.js';
import { parseColor } from '../../../shared/pixels/color.js';

const ACCENT = '#1e88ff';
const KAPPA = 0.5522847498307936;
const EMPTY = Object.freeze({ subpaths: Object.freeze([]) });

// ---- path geometry ------------------------------------------------------------------------------------------

export function clonePath(path) {
  return { subpaths: (path?.subpaths ?? []).map((sp) => ({ closed: !!sp.closed, points: sp.points.map((p) => ({ ...p })) })) };
}

export function isEmptyPath(path) {
  return !path?.subpaths?.some((sp) => sp.points.length > 0);
}

const hasIn = (p) => p.inX !== undefined && p.inY !== undefined;
const hasOut = (p) => p.outX !== undefined && p.outY !== undefined;
const isLine = (a, b) => !hasOut(a) && !hasIn(b);
const segCtrl = (a, b) => [a.x, a.y, a.outX ?? a.x, a.outY ?? a.y, b.inX ?? b.x, b.inY ?? b.y, b.x, b.y];
const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

function cubicAt(c, t) {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, cc = 3 * u * t * t, d = t * t * t;
  return [a * c[0] + b * c[2] + cc * c[4] + d * c[6], a * c[1] + b * c[3] + cc * c[5] + d * c[7]];
}

function segmentCount(sp) {
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

function signedArea(poly) {
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
function clockwise(sp) {
  return signedArea(flattenSubpath(sp, 1)) < 0 ? reverseSubpath(sp) : sp;
}

function mapPoints(path, fn) {
  for (const sp of path.subpaths) for (const p of sp.points) mapPoint(p, fn);
  return path;
}

function mapPoint(p, fn) {
  [p.x, p.y] = fn(p.x, p.y);
  if (hasIn(p)) [p.inX, p.inY] = fn(p.inX, p.inY);
  if (hasOut(p)) [p.outX, p.outY] = fn(p.outX, p.outY);
}

function translatePoint(p, dx, dy) {
  p.x += dx;
  p.y += dy;
  if (hasIn(p)) {
    p.inX += dx;
    p.inY += dy;
  }
  if (hasOut(p)) {
    p.outX += dx;
    p.outY += dy;
  }
}

/** Closest point of a segment to (x, y): { t, d, x, y }. */
function nearestOnSegment(a, b, x, y) {
  const c = segCtrl(a, b);
  if (isLine(a, b)) {
    const dx = c[6] - c[0], dy = c[7] - c[1];
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((x - c[0]) * dx + (y - c[1]) * dy) / len)) : 0;
    const px = c[0] + dx * t, py = c[1] + dy * t;
    return { t, d: Math.hypot(px - x, py - y), x: px, y: py };
  }
  const N = 40;
  let best = 0, bestD = Infinity;
  for (let k = 0; k <= N; k++) {
    const p = cubicAt(c, k / N);
    const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  let lo = Math.max(0, (best - 1) / N), hi = Math.min(1, (best + 1) / N);
  const dist = (t) => {
    const p = cubicAt(c, t);
    return (p[0] - x) ** 2 + (p[1] - y) ** 2;
  };
  for (let k = 0; k < 24; k++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (dist(m1) < dist(m2)) hi = m2;
    else lo = m1;
  }
  const t = (lo + hi) / 2;
  const p = cubicAt(c, t);
  return { t, d: Math.hypot(p[0] - x, p[1] - y), x: p[0], y: p[1] };
}

export function hitAnchor(path, x, y, tol) {
  let best = null;
  path.subpaths.forEach((sp, s) => sp.points.forEach((p, i) => {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= tol && (!best || d < best.d)) best = { sp: s, i, d };
  }));
  return best;
}

function hitHandle(path, x, y, tol, filter = () => true) {
  let best = null;
  path.subpaths.forEach((sp, s) => sp.points.forEach((p, i) => {
    if (!filter(s, i)) return;
    for (const side of ['in', 'out']) {
      if (side === 'in' ? !hasIn(p) : !hasOut(p)) continue;
      const hx = p[`${side}X`], hy = p[`${side}Y`];
      if (Math.hypot(hx - p.x, hy - p.y) < 1e-6) continue;
      const d = Math.hypot(hx - x, hy - y);
      if (d <= tol && (!best || d < best.d)) best = { sp: s, i, side, d };
    }
  }));
  return best;
}

export function hitSegment(path, x, y, tol) {
  let best = null;
  path.subpaths.forEach((sp, s) => {
    const n = sp.points.length;
    for (let i = 0; i < segmentCount(sp); i++) {
      const r = nearestOnSegment(sp.points[i], sp.points[(i + 1) % n], x, y);
      if (r.d <= tol && (!best || r.d < best.d)) best = { sp: s, i, t: r.t, d: r.d, x: r.x, y: r.y };
    }
  });
  return best;
}

/** Index of the subpath under (x, y): inside its fill or near its outline. */
function hitSubpath(path, x, y, tol) {
  const seg = hitSegment(path, x, y, tol);
  if (seg) return seg.sp;
  const ctx = measureContext();
  for (let s = path.subpaths.length - 1; s >= 0; s--) {
    const sp = path.subpaths[s];
    if (sp.points.length < 3) continue;
    if (ctx.isPointInPath(pathToPath2D({ subpaths: [sp] }), x, y, 'nonzero')) return s;
  }
  return -1;
}

/** Splits segment i of sp at t (de Casteljau); returns the index of the new anchor. */
export function splitSegment(sp, i, t) {
  const n = sp.points.length;
  const a = sp.points[i], b = sp.points[(i + 1) % n];
  let np;
  if (isLine(a, b)) np = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  else {
    const c = segCtrl(a, b);
    const p0 = [c[0], c[1]], p1 = [c[2], c[3]], p2 = [c[4], c[5]], p3 = [c[6], c[7]];
    const p01 = lerp2(p0, p1, t), p12 = lerp2(p1, p2, t), p23 = lerp2(p2, p3, t);
    const p012 = lerp2(p01, p12, t), p123 = lerp2(p12, p23, t), m = lerp2(p012, p123, t);
    if (hasOut(a)) [a.outX, a.outY] = p01;
    if (hasIn(b)) [b.inX, b.inY] = p23;
    np = { x: m[0], y: m[1], inX: p012[0], inY: p012[1], outX: p123[0], outY: p123[1] };
  }
  sp.points.splice(i + 1, 0, np);
  return i + 1;
}

/** Removes anchor i; subpaths left with fewer than two anchors are dropped. */
export function deleteAnchor(path, s, i) {
  const sp = path.subpaths[s];
  sp.points.splice(i, 1);
  if (sp.points.length < 2) path.subpaths.splice(s, 1);
  return path;
}

// Ramer–Douglas–Peucker on [x, y] points.
export function simplify(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = len ? Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / len : Math.hypot(pts[i][0] - ax, pts[i][1] - ay);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function simplifyClosed(pts, tol) {
  if (pts.length < 4) return pts.slice();
  let far = 0, farD = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const a = simplify(pts.slice(0, far + 1), tol);
  const b = simplify([...pts.slice(far), pts[0]], tol);
  return [...a, ...b.slice(1, -1)];
}

/** Turns a polyline into a subpath with smooth handles (corners sharper than cornerDeg stay corners). */
export function smoothSubpath(pts, closed, cornerDeg = 75) {
  const n = pts.length;
  const out = pts.map(([x, y]) => ({ x, y }));
  for (let i = 0; i < n; i++) {
    const prev = closed ? pts[(i - 1 + n) % n] : pts[i - 1];
    const next = closed ? pts[(i + 1) % n] : pts[i + 1];
    if (!prev || !next) continue;
    const [x, y] = pts[i];
    const l1 = Math.hypot(x - prev[0], y - prev[1]), l2 = Math.hypot(next[0] - x, next[1] - y);
    if (l1 < 1e-6 || l2 < 1e-6) continue;
    const cos = ((x - prev[0]) * (next[0] - x) + (y - prev[1]) * (next[1] - y)) / (l1 * l2);
    if ((Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI > cornerDeg) continue;
    let tx = next[0] - prev[0], ty = next[1] - prev[1];
    const tl = Math.hypot(tx, ty);
    if (tl < 1e-6) continue;
    tx /= tl;
    ty /= tl;
    Object.assign(out[i], { inX: x - (tx * l1) / 3, inY: y - (ty * l1) / 3, outX: x + (tx * l2) / 3, outY: y + (ty * l2) / 3 });
  }
  return { closed, points: out };
}

// ---- shape builders (closed subpaths run clockwise on screen) -----------------------------------------------

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
  // corners whose radius eats the whole side leave duplicate anchors: merge them
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
  }
  return { subpaths: [{ closed: true, points: merged }] };
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

export function polygonPath(x, y, w, h, sides = 5, star = false, inset = 50) {
  const n = Math.max(3, Math.min(100, Math.round(sides)));
  const rx = w / 2, ry = h / 2, cx = x + rx, cy = y + ry;
  const inner = Math.max(0.01, Math.min(0.99, 1 - inset / 100));
  const pts = [];
  const count = star ? n * 2 : n;
  for (let k = 0; k < count; k++) {
    const a = -Math.PI / 2 + (k * Math.PI * 2) / count;
    const f = star && k % 2 ? inner : 1;
    pts.push({ x: cx + Math.cos(a) * rx * f, y: cy + Math.sin(a) * ry * f });
  }
  return { subpaths: [{ closed: true, points: pts }] };
}

export function linePath(x1, y1, x2, y2, weight = 2, arrowStart = false, arrowEnd = false) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 1e-6) return { subpaths: [] };
  const ux = (x2 - x1) / len, uy = (y2 - y1) / len, nx = -uy, ny = ux;
  const w = Math.max(0.5, weight) / 2;
  const head = Math.max(6, weight * 5);
  let ax = x1, ay = y1, bx = x2, by = y2;
  const subpaths = [];
  const tri = (tx, ty, dirX, dirY) => {
    const baseX = tx - dirX * head, baseY = ty - dirY * head;
    return clockwise({ closed: true, points: [{ x: tx, y: ty }, { x: baseX + nx * head / 2, y: baseY + ny * head / 2 }, { x: baseX - nx * head / 2, y: baseY - ny * head / 2 }] });
  };
  if (arrowEnd && len > head) {
    subpaths.push(tri(x2, y2, ux, uy));
    bx = x2 - ux * head * 0.9;
    by = y2 - uy * head * 0.9;
  }
  if (arrowStart && len > head) {
    subpaths.push(tri(x1, y1, -ux, -uy));
    ax = x1 + ux * head * 0.9;
    ay = y1 + uy * head * 0.9;
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

// ---- targets ------------------------------------------------------------------------------------------------

const state = {
  preview: null, // { key, path } draft drawn instead of a work/saved path during a gesture
  sel: { key: null, subpaths: new Set(), anchors: new Set() }, // path selection / direct selection
};

function clearSel() {
  state.sel = { key: null, subpaths: new Set(), anchors: new Set() };
}

/** Records a change of doc.workPath and/or doc.paths as one history entry. */
export function recordPaths(doc, label, next) {
  const before = { workPath: doc.workPath ?? null, paths: doc.paths.slice() };
  const after = { workPath: 'workPath' in next ? next.workPath : before.workPath, paths: next.paths ? next.paths.slice() : before.paths };
  const apply = (s) => {
    doc.workPath = s.workPath;
    doc.paths = s.paths.slice();
    doc.changed('paths');
  };
  apply(after);
  doc.history.push({ label, undo: () => apply(before), redo: () => apply(after), bytes: 0, at: Date.now() });
}

export function workTarget(doc) {
  return {
    kind: 'work',
    key: 'work',
    label: 'Work Path',
    doc,
    get: () => doc.workPath ?? EMPTY,
    valid: () => true,
    commit: (path, label) => recordPaths(doc, label, { workPath: clonePath(path) }),
  };
}

export function savedTarget(doc, id) {
  const entry = () => doc.paths.find((p) => p.id === id);
  return {
    kind: 'saved',
    key: `saved:${id}`,
    id,
    doc,
    get label() {
      return entry()?.name ?? 'Path';
    },
    get: () => entry()?.path ?? EMPTY,
    valid: () => !!entry(),
    commit: (path, label) => recordPaths(doc, label, { paths: doc.paths.map((p) => (p.id === id ? { ...p, path: clonePath(path) } : p)) }),
  };
}

export function shapeTarget(app, layer) {
  return {
    kind: 'shape',
    key: `shape:${layer.id}`,
    layer,
    doc: app.doc,
    get label() {
      return `${layer.name} Shape Path`;
    },
    get: () => layer.path ?? EMPTY,
    valid: () => !!layer.parent,
    commit: (path, label, extra = {}) => setLayerProps(app, layer, { path: clonePath(path), ...extra }, label),
  };
}

/** The path chosen in the Paths panel (app.ui.activePath) for the current document, or null. */
export function activePathTarget(app) {
  const doc = app.doc;
  const ap = app.ui.activePath;
  if (!doc || !ap || ap.doc !== doc.id) return null;
  if (ap.kind === 'work') return workTarget(doc);
  if (ap.kind === 'saved') {
    const t = savedTarget(doc, ap.id);
    return t.valid() ? t : null;
  }
  if (ap.kind === 'shape') {
    const l = doc.find(ap.layerId);
    return l?.type === 'shape' && l === doc.active ? shapeTarget(app, l) : null;
  }
  return null;
}

/** Selects a path in the Paths panel: null | { kind: 'work' } | { kind: 'saved', id } | { kind: 'shape', layerId }. */
export function setActivePath(app, ap) {
  app.ui.activePath = ap && app.doc ? { kind: ap.kind, id: ap.id, layerId: ap.layerId, doc: app.doc.id } : null;
  app.emit('path:selected', app.ui.activePath);
  app.view?.invalidate();
  app.commands.invalidate();
}

/** Paths shown (and editable) by the vector tools: active shape layer, chosen path, work path. */
export function visibleTargets(app) {
  const doc = app.doc;
  if (!doc) return [];
  const out = [];
  const seen = new Set();
  const add = (t) => {
    if (t && !seen.has(t.key)) {
      seen.add(t.key);
      out.push(t);
    }
  };
  if (doc.active?.type === 'shape') add(shapeTarget(app, doc.active));
  add(activePathTarget(app));
  if (doc.workPath && !isEmptyPath(doc.workPath)) add(workTarget(doc));
  return out;
}

/** The path the path commands act on: the chosen path, else the work path, else the active shape. */
export function currentPathTarget(app) {
  const doc = app.doc;
  if (!doc) return null;
  const ap = activePathTarget(app);
  if (ap && !isEmptyPath(ap.get())) return ap;
  if (doc.workPath && !isEmptyPath(doc.workPath)) return workTarget(doc);
  if (doc.active?.type === 'shape' && !isEmptyPath(doc.active.path)) return shapeTarget(app, doc.active);
  return null;
}

const pathOf = (t) => (state.preview?.key === t.key ? state.preview.path : t.get());

function startPreview(target) {
  return { original: target.get() };
}

function showPreview(app, target, draft) {
  if (target.kind === 'shape') {
    target.layer.path = draft;
    target.layer.touch();
    app.doc.changed('pixels', { layer: target.layer });
  } else {
    state.preview = { key: target.key, path: draft };
    app.view?.invalidate();
  }
}

function endPreview(app, target, original) {
  if (target.kind === 'shape') {
    target.layer.path = original;
    target.layer.touch();
    app.doc.changed('pixels', { layer: target.layer });
  } else if (state.preview?.key === target.key) state.preview = null;
  app.view?.invalidate();
}

function samePath(a, b) {
  return JSON.stringify(a?.subpaths ?? []) === JSON.stringify(b?.subpaths ?? []);
}

function editable(app, target) {
  if (target.kind === 'shape' && (target.layer.locked.all || target.layer.locked.position)) {
    app.dialogs.toast(`"${target.layer.name}" is locked`, { kind: 'error', timeout: 1800 });
    return false;
  }
  return true;
}

/** Commits a draft to its target with one history entry (shape layers become plain paths after anchor edits). */
function commitDraft(app, target, original, draft, label, { reshaped = true } = {}) {
  endPreview(app, target, original);
  if (samePath(original, draft)) return false;
  if (target.kind === 'shape') {
    const extra = reshaped ? { shapeKind: 'path' } : {};
    if (!reshaped) extra.shapeProps = offsetShapeProps(target.layer.shapeProps, draft, original);
    target.commit(draft, label, extra);
  } else target.commit(draft, label);
  return true;
}

/** Moves the numeric coordinates of shapeProps by the offset between two otherwise identical paths. */
function offsetShapeProps(props, draft, original) {
  const a = original.subpaths[0]?.points[0], b = draft.subpaths[0]?.points[0];
  if (!props || !a || !b || draft.subpaths.length !== original.subpaths.length) return props ?? {};
  const dx = b.x - a.x, dy = b.y - a.y;
  const out = { ...props };
  for (const k of ['x', 'x1', 'x2', 'cx']) if (typeof out[k] === 'number') out[k] += dx;
  for (const k of ['y', 'y1', 'y2', 'cy']) if (typeof out[k] === 'number') out[k] += dy;
  return out;
}

// ---- styles and layer creation ------------------------------------------------------------------------------

function shapeStyle(tool) {
  const app = tool.app;
  const fill = tool.opt('fillOn') !== false ? { type: 'solid', color: app.settings.foreground } : null;
  const stroke = tool.opt('strokeOn') ? { color: tool.opt('strokeColor') ?? '#000000', width: Number(tool.opt('strokeWidth') ?? 3), align: tool.opt('strokeAlign') ?? 'center', dash: [], join: 'miter', cap: 'butt' } : null;
  return { fill: fill ?? (stroke ? null : { type: 'solid', color: app.settings.foreground }), stroke };
}

function createShapeLayer(app, path, { name, label, style, kind = 'path', props = {} }) {
  const doc = app.doc;
  const layer = new ShapeLayer({ name: nextLayerName(doc, name), path: clonePath(path), fill: style.fill, stroke: style.stroke, shapeKind: kind, shapeProps: props });
  // the Move tool keeps a shape's offset in x/y (see report): start them at 0
  layer.x = 0;
  layer.y = 0;
  structural(app, label, () => {
    doc.add(layer);
    doc.setActive(layer);
  });
  return layer;
}

/** Raster target for pixel operations (active raster layer or the mask being edited), or null. */
function pixelTarget(app, retry) {
  const doc = app.doc;
  const layer = doc?.active;
  if (!layer) {
    app.dialogs.toast('Select a layer first', { kind: 'error', timeout: 1800 });
    return null;
  }
  if (app.ui.editingMask && layer.mask?.canvas) return { layer, canvas: layer.mask.canvas, x: 0, y: 0, mask: true };
  if (layer.type !== 'raster') {
    if (app.rasterizePrompt) app.rasterizePrompt(layer).then((ok) => ok && retry?.());
    else app.dialogs.toast('Select a pixel layer', { kind: 'error', timeout: 1800 });
    return null;
  }
  if (layer.locked.all || layer.locked.pixels) {
    app.dialogs.toast(`"${layer.name}" is locked`, { kind: 'error', timeout: 1800 });
    return null;
  }
  return { layer, canvas: layer.canvas, x: layer.x, y: layer.y, mask: false };
}

function luminance(hex) {
  const [r, g, b] = parseColor(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** Fills a path into the active raster layer (or mask), clipped by the selection: one history entry. */
export function fillPathPixels(app, path, { label = 'Fill Path', color, opacity = 1, antialias = true, feather = 0, rule = 'nonzero', retry } = {}) {
  const doc = app.doc;
  const t = pixelTarget(app, retry);
  if (!t) return false;
  const pb = pathBounds(path);
  if (!pb) return false;
  const pad = Math.ceil(feather * 2) + 2;
  const area = intersectRect({ x: Math.floor(pb.x) - pad, y: Math.floor(pb.y) - pad, width: Math.ceil(pb.width) + pad * 2 + 1, height: Math.ceil(pb.height) + pad * 2 + 1 }, doc.bounds);
  if (!area) return false;
  const fill = createCanvas(area.width, area.height);
  const fctx = fill.getContext('2d', { willReadFrequently: true });
  const paint = color ?? app.settings.foreground;
  fctx.fillStyle = t.mask ? '#ffffff' : paint;
  if (feather > 0) fctx.filter = `blur(${feather / 2}px)`;
  fctx.fill(pathToPath2D(path, -area.x, -area.y), rule);
  fctx.filter = 'none';
  if (!antialias) hardenAlpha(fctx, area.width, area.height);
  const sel = doc.selection && !doc.selection.isEmpty ? doc.selection : null;
  if (sel) {
    fctx.globalCompositeOperation = 'destination-in';
    fctx.drawImage(sel.toCanvas(), -area.x, -area.y);
  }
  if (!t.mask) t.layer.ensureCovers(area);
  const target = t.mask ? t : { canvas: t.layer.canvas, x: t.layer.x, y: t.layer.y };
  const local = { x: area.x - target.x, y: area.y - target.y, width: area.width, height: area.height };
  doc.history.pixels(label, target.canvas, local, (ctx) => {
    ctx.save();
    ctx.globalAlpha = opacity;
    if (t.mask) ctx.globalCompositeOperation = luminance(paint) >= 0.5 ? 'source-over' : 'destination-out';
    else if (t.layer.locked.transparency) ctx.globalCompositeOperation = 'source-atop';
    ctx.drawImage(fill, local.x, local.y);
    ctx.restore();
  }, { layer: t.layer, kind: t.mask ? 'mask' : 'pixels' });
  return true;
}

function hardenAlpha(ctx, w, h) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= 128 ? 255 : 0;
  ctx.putImageData(img, 0, 0);
}

/** Strokes a path with the brush engine (current Brush tool size/hardness, foreground colour). */
export function strokePathPixels(app, path, { tool = 'brush', simulatePressure = false, retry } = {}) {
  const doc = app.doc;
  const t = pixelTarget(app, retry);
  if (!t) return false;
  const src = app.tools.get(tool) ? tool : 'brush';
  const opt = (k, d) => app.tools.opt(src, k) ?? d;
  const size = Math.max(1, Number(opt('size', 24)));
  const pb = pathBounds(path);
  if (!pb) return false;
  if (!t.mask) {
    const grow = intersectRect({ x: pb.x - size, y: pb.y - size, width: pb.width + size * 2, height: pb.height + size * 2 }, doc.bounds);
    if (grow) t.layer.ensureCovers({ x: Math.floor(grow.x), y: Math.floor(grow.y), width: Math.ceil(grow.width) + 1, height: Math.ceil(grow.height) + 1 });
  }
  const target = t.mask ? { canvas: t.layer.mask.canvas, x: 0, y: 0, mask: true } : { canvas: t.layer.canvas, x: t.layer.x, y: t.layer.y, mask: false };
  const settings = {
    size,
    hardness: src === 'pencil' ? 1 : Number(opt('hardness', 0.8)),
    opacity: Number(opt('opacity', 1)),
    flow: Number(opt('flow', 1)),
    spacing: Math.min(0.12, app.settings.brush?.spacing ?? 0.12),
    smoothing: 0,
    pressureSize: simulatePressure,
    pressureOpacity: false,
    blend: opt('blend', 'normal'),
    color: app.settings.foreground,
    mode: target.mask ? 'mask' : src === 'eraser' ? 'erase' : 'paint',
    maskValue: luminance(app.settings.foreground),
    antialias: src !== 'pencil',
    lockTransparency: !target.mask && t.layer.locked.transparency,
    label: 'Stroke Path',
  };
  const stroke = new BrushStroke({ target, layer: t.layer, settings, selection: doc.selection && !doc.selection.isEmpty ? doc.selection : null, history: doc.history, onDirty: () => app.view?.invalidate() });
  for (const poly of flattenPath(path, 0.25)) {
    const pts = poly.closed ? [...poly.points, poly.points[0]] : poly.points;
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    let run = 0;
    const pressure = (s) => (simulatePressure && total > 0 ? Math.max(0.05, Math.sin((Math.PI * s) / total)) : 1);
    stroke.begin({ x: pts[0][0], y: pts[0][1], pressure: pressure(0) });
    for (let i = 1; i < pts.length; i++) {
      run += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      stroke.extend({ x: pts[i][0], y: pts[i][1], pressure: pressure(run) });
    }
  }
  stroke.end();
  return true;
}

/** Coverage mask (document size) of a path. */
export function pathMask(doc, path, { antialias = true, rule = 'nonzero' } = {}) {
  const c = createCanvas(doc.width, doc.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fill(pathToPath2D(path), rule);
  const d = ctx.getImageData(0, 0, doc.width, doc.height).data;
  const mask = new Uint8ClampedArray(doc.width * doc.height);
  for (let i = 0, j = 3; i < mask.length; i++, j += 4) mask[i] = antialias ? d[j] : d[j] >= 128 ? 255 : 0;
  return mask;
}

/** Traces selection outlines into a smooth path (tolerance in pixels, like Photoshop's Make Work Path). */
export function pathFromSelectionMask(selection, tolerance = 2) {
  const subpaths = [];
  for (const poly of selection.outline()) {
    if (poly.length < 3) continue;
    const pts = simplifyClosed(poly, Math.max(0.5, tolerance));
    if (pts.length < 3) continue;
    subpaths.push(smoothSubpath(pts, true, tolerance >= 1.5 ? 60 : 30));
  }
  return { subpaths };
}

// ---- overlay drawing ----------------------------------------------------------------------------------------

function addPath(ctx, path, m) {
  const T = (x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
  for (const sp of path.subpaths) {
    const pts = sp.points;
    if (!pts.length) continue;
    ctx.moveTo(...T(pts[0].x, pts[0].y));
    for (let i = 0; i < segmentCount(sp); i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (isLine(a, b)) ctx.lineTo(...T(b.x, b.y));
      else {
        const c = segCtrl(a, b);
        ctx.bezierCurveTo(...T(c[2], c[3]), ...T(c[4], c[5]), ...T(c[6], c[7]));
      }
    }
    if (sp.closed) ctx.closePath();
  }
}

function strokeOutline(ctx, path, m, { width = 1, color = ACCENT, halo = true } = {}) {
  ctx.beginPath();
  addPath(ctx, path, m);
  if (halo) {
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = width + 2;
    ctx.stroke();
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function fillPreview(ctx, path, m, style, zoom) {
  if (style.fill) {
    ctx.beginPath();
    addPath(ctx, path, m);
    ctx.fillStyle = style.fill.color ?? '#000';
    ctx.fill('nonzero');
  }
  if (style.stroke?.width > 0) {
    ctx.beginPath();
    addPath(ctx, path, m);
    ctx.strokeStyle = style.stroke.color ?? '#000';
    ctx.lineWidth = style.stroke.width * zoom;
    ctx.stroke();
  }
}

function drawAnchor(ctx, x, y, selected) {
  ctx.fillStyle = selected ? ACCENT : '#ffffff';
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1;
  ctx.fillRect(Math.round(x) - 3, Math.round(y) - 3, 7, 7);
  ctx.strokeRect(Math.round(x) - 3.5, Math.round(y) - 3.5, 8, 8);
}

function drawHandles(ctx, p, m) {
  const T = (x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
  const [ax, ay] = T(p.x, p.y);
  for (const side of ['in', 'out']) {
    if (side === 'in' ? !hasIn(p) : !hasOut(p)) continue;
    const [hx, hy] = T(p[`${side}X`], p[`${side}Y`]);
    if (Math.hypot(hx - ax, hy - ay) < 0.5) continue;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(hx, hy);
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(hx, hy, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = ACCENT;
    ctx.fill();
  }
}

/**
 * Draws the visible paths. spec: { anchors: 'none'|'all'|'selected-subpaths', handles: 'none'|'selected'|'all' }.
 */
function drawTargets(ctx, view, app, spec = {}) {
  const m = view.matrix();
  ctx.save();
  for (const t of visibleTargets(app)) {
    const path = pathOf(t);
    if (isEmptyPath(path)) continue;
    strokeOutline(ctx, path, m);
    const sel = state.sel.key === t.key ? state.sel : null;
    path.subpaths.forEach((sp, s) => {
      const subSelected = sel?.subpaths.has(s);
      const showAnchors = spec.anchors === 'all' || (spec.anchors === 'selected-subpaths' && subSelected);
      sp.points.forEach((p, i) => {
        const anchorSelected = !!sel?.anchors.has(`${s}:${i}`);
        if (spec.handles === 'all' || (spec.handles === 'selected' && anchorSelected)) drawHandles(ctx, p, m);
      });
      if (!showAnchors) return;
      sp.points.forEach((p, i) => {
        const q = view.toScreen(p.x, p.y);
        drawAnchor(ctx, q.x, q.y, spec.anchors === 'selected-subpaths' ? true : !!sel?.anchors.has(`${s}:${i}`));
      });
    });
  }
  ctx.restore();
}

/** Thin outline of the path chosen in the Paths panel, for when no vector tool is active. */
function drawChosenPath(ctx, view, app) {
  if (app.tools.active?.isVector || view.doc !== app.doc) return;
  const t = activePathTarget(app);
  if (!t || t.kind === 'shape') return;
  const path = t.get();
  if (isEmptyPath(path)) return;
  ctx.save();
  strokeOutline(ctx, path, view.matrix(), { halo: false });
  ctx.restore();
}

function snap45(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const a = Math.atan2(dy, dx);
  const s = Math.round(a / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(dx, dy) * Math.cos(a - s);
  return { x: from.x + Math.cos(s) * len, y: from.y + Math.sin(s) * len };
}

// ---- tool base ----------------------------------------------------------------------------------------------

const MODE_SHAPE_PATH = [['shape', 'Shape'], ['path', 'Path']];
const isShapeMode = (t) => t.opt('mode') === 'shape';
const STYLE_OPTIONS = [
  { kind: 'checkbox', key: 'fillOn', label: 'Fill (foreground)', default: true, when: isShapeMode },
  { kind: 'checkbox', key: 'strokeOn', label: 'Stroke', default: false, when: isShapeMode },
  { kind: 'color', key: 'strokeColor', label: '', default: '#000000', when: (t) => isShapeMode(t) && !!t.opt('strokeOn') },
  { kind: 'number', key: 'strokeWidth', label: '', min: 0.5, max: 288, step: 0.5, default: 3, unit: 'px', when: (t) => isShapeMode(t) && !!t.opt('strokeOn') },
  { kind: 'select', key: 'strokeAlign', label: '', options: [['inside', 'Inside'], ['center', 'Center'], ['outside', 'Outside']], default: 'center', when: (t) => isShapeMode(t) && !!t.opt('strokeOn') },
];
const SHARED_KEYS = new Set(['fillOn', 'strokeOn', 'strokeColor', 'strokeWidth', 'strokeAlign']);
const RERENDER_KEYS = new Set(['mode', 'strokeOn', 'star', 'shape']);
const PATH_BUTTONS = [
  { kind: 'button', key: 'makeSel', label: 'Selection', icon: 'marquee-rect', onClick: (t) => t.app.commands.run('path:make-selection', undefined, 'toolbar') },
  { kind: 'button', key: 'fillPath', label: 'Fill', icon: 'fill', onClick: (t) => t.app.commands.run('path:fill', {}, 'toolbar') },
  { kind: 'button', key: 'strokePath', label: 'Stroke', icon: 'brush', onClick: (t) => t.app.commands.run('path:stroke', {}, 'toolbar') },
];

class VectorTool extends Tool {
  constructor(app, def) {
    super(app, { cursor: 'crosshair', ...def });
    this.isVector = true;
  }
  activate() {
    this.syncStyleFromLayer();
  }
  onOptionChanged(key, value) {
    if (SHARED_KEYS.has(key)) {
      for (const t of this.app.tools.tools.values()) if (t !== this && t.isVector && t.options.some((o) => o.key === key)) this.app.tools.setOpt(t.id, key, value, { silent: true });
      this.applyStyleToLayer(key);
    }
    if (RERENDER_KEYS.has(key)) this.app.tools.renderOptions();
  }
  /** Changing fill/stroke options restyles the selected shape layer (as in Photoshop). */
  applyStyleToLayer(key) {
    const layer = this.doc?.active;
    if (!layer || layer.type !== 'shape' || layer.locked.all || !isShapeMode(this)) return;
    const style = shapeStyle(this);
    const patch = {};
    if (key === 'fillOn') patch.fill = this.opt('fillOn') !== false ? layer.fill ?? style.fill ?? { type: 'solid', color: this.app.settings.foreground } : null;
    else patch.stroke = style.stroke ? { ...(layer.stroke ?? {}), ...style.stroke, dash: layer.stroke?.dash ?? [] } : null;
    setLayerProps(this.app, layer, patch, 'Shape Style', { merge: true });
  }
  /** Shows the active shape layer's fill/stroke in the options bar. */
  syncStyleFromLayer() {
    const layer = this.doc?.active;
    if (!layer || layer.type !== 'shape' || !this.options.some((o) => o.key === 'fillOn')) return;
    const tm = this.app.tools;
    const set = (k, v) => tm.setOpt(this.id, k, v, { silent: true });
    set('fillOn', !!layer.fill);
    set('strokeOn', !!layer.stroke);
    if (layer.stroke) {
      if (typeof layer.stroke.color === 'string') set('strokeColor', layer.stroke.color.slice(0, 7));
      set('strokeWidth', layer.stroke.width);
      set('strokeAlign', layer.stroke.align ?? 'center');
    }
    if (tm.active === this) tm.renderOptions();
  }
  /** Where a new path drawn with this tool goes: null means "a new shape layer". */
  drawTarget() {
    const doc = this.doc;
    if (this.opt('mode') === 'shape') {
      if (this.opt('combine') === 'add' && doc.active?.type === 'shape' && !doc.active.locked.all) return shapeTarget(this.app, doc.active);
      return null;
    }
    const ap = activePathTarget(this.app);
    if (ap) return ap;
    return workTarget(doc);
  }
  /** Adds a finished subpath to the drawing target (one history entry). */
  commitNewSubpath(target, draft, label, { name = 'Shape', kind = 'path', props = {} } = {}) {
    if (!target) {
      createShapeLayer(this.app, draft, { name, label, style: shapeStyle(this), kind, props });
      return;
    }
    target.commit(draft, label, target.kind === 'shape' ? { shapeKind: 'path' } : undefined);
    if (target.kind === 'work' && activePathTarget(this.app)?.key !== 'work') setActivePath(this.app, { kind: 'work' });
  }
  drawOverlay(ctx, view) {
    drawTargets(ctx, view, this.app, this.overlaySpec?.() ?? {});
  }
}

// ---- shape tools ----------------------------------------------------------------------------------------------

const SHAPE_DEFS = {
  rect: { name: 'Rectangle Tool', icon: 'shape-rect', layer: 'Rectangle', kind: 'rect', title: 'Create Rectangle' },
  rrect: { name: 'Rounded Rectangle Tool', icon: 'shape-rrect', layer: 'Rounded Rectangle', kind: 'rect', title: 'Create Rounded Rectangle' },
  ellipse: { name: 'Ellipse Tool', icon: 'shape-ellipse', layer: 'Ellipse', kind: 'ellipse', title: 'Create Ellipse' },
  polygon: { name: 'Polygon Tool', icon: 'shape-polygon', layer: 'Polygon', kind: 'polygon', title: 'Create Polygon' },
  line: { name: 'Line Tool', icon: 'shape-line', layer: 'Line', kind: 'line', title: 'Create Line' },
  custom: { name: 'Custom Shape Tool', icon: 'shape-custom', layer: 'Shape', kind: 'path', title: 'Create Custom Shape' },
};

export class ShapeTool extends VectorTool {
  constructor(app, shape) {
    const def = SHAPE_DEFS[shape];
    const extra = {
      rect: [],
      rrect: [{ kind: 'number', key: 'radius', label: 'Radius', min: 0, max: 5000, default: 16, unit: 'px' }],
      ellipse: [],
      polygon: [
        { kind: 'number', key: 'sides', label: 'Sides', min: 3, max: 100, default: 5 },
        { kind: 'checkbox', key: 'star', label: 'Star', default: false },
        { kind: 'number', key: 'inset', label: 'Indent', min: 1, max: 99, default: 50, unit: '%', when: (t) => !!t.opt('star') },
      ],
      line: [
        { kind: 'number', key: 'weight', label: 'Weight', min: 0.5, max: 1000, step: 0.5, default: 2, unit: 'px' },
        { kind: 'checkbox', key: 'arrowStart', label: 'Arrow start', default: false },
        { kind: 'checkbox', key: 'arrowEnd', label: 'Arrow end', default: false },
      ],
      custom: [{ kind: 'select', key: 'shape', label: 'Shape', options: Object.entries(CUSTOM_SHAPES).map(([k, v]) => [k, v.name]), default: 'heart' }],
    }[shape];
    super(app, {
      id: `shape-${shape}`,
      name: def.name,
      icon: def.icon,
      hint: shape === 'line' ? 'Drag to draw a line; Shift constrains to 45°, Alt draws from the centre.' : 'Drag to draw; Shift keeps proportions, Alt draws from the centre. Click without dragging to enter a size.',
      options: [
        { kind: 'select', key: 'mode', label: '', options: [...MODE_SHAPE_PATH, ['pixels', 'Pixels']], default: 'shape' },
        ...STYLE_OPTIONS,
        { kind: 'checkbox', key: 'antialias', label: 'Anti-alias', default: true, when: (t) => t.opt('mode') === 'pixels' },
        ...extra,
        { kind: 'checkbox', key: 'alignEdges', label: 'Align edges', default: true, when: () => shape !== 'line' },
      ],
    });
    this.shape = shape;
    this.def = def;
    this.drag = null;
  }
  onPointerDown(p) {
    this.drag = { start: { x: p.x, y: p.y }, current: { x: p.x, y: p.y }, shift: p.shift, alt: p.alt, moved: false };
  }
  onPointerMove(p, dragging) {
    if (!dragging || !this.drag) return;
    const d = this.drag;
    d.current = { x: p.x, y: p.y };
    d.shift = p.shift;
    d.alt = p.alt;
    if (Math.hypot(p.x - d.start.x, p.y - d.start.y) * this.view.zoom >= 3) d.moved = true;
  }
  onPointerUp(p) {
    const d = this.drag;
    this.drag = null;
    if (!d || p.cancelled) return;
    if (!d.moved) {
      if (this.shape !== 'line') this.sizeDialog(d.start);
      return;
    }
    const g = this.geometry(d);
    if (g) this.create(g);
  }
  cancel() {
    if (this.drag) {
      this.drag = null;
      return true;
    }
    return false;
  }
  box(d) {
    let w = d.current.x - d.start.x, h = d.current.y - d.start.y;
    if (d.shift) {
      const m = Math.max(Math.abs(w), Math.abs(h));
      w = (Math.sign(w) || 1) * m;
      h = (Math.sign(h) || 1) * m;
    }
    let x = d.start.x, y = d.start.y;
    if (d.alt) {
      x -= w;
      y -= h;
      w *= 2;
      h *= 2;
    }
    const r = { x: Math.min(x, x + w), y: Math.min(y, y + h), width: Math.abs(w), height: Math.abs(h) };
    if (this.opt('alignEdges') !== false) {
      const x2 = Math.round(r.x + r.width), y2 = Math.round(r.y + r.height);
      r.x = Math.round(r.x);
      r.y = Math.round(r.y);
      r.width = x2 - r.x;
      r.height = y2 - r.y;
    }
    return r;
  }
  /** { path, props } for the current drag. */
  geometry(d) {
    if (this.shape === 'line') {
      let a = d.start, b = d.current;
      if (d.shift) b = snap45(a, b);
      if (d.alt) a = { x: 2 * a.x - b.x, y: 2 * a.y - b.y };
      const weight = Number(this.opt('weight') ?? 2);
      const path = linePath(a.x, a.y, b.x, b.y, weight, !!this.opt('arrowStart'), !!this.opt('arrowEnd'));
      return isEmptyPath(path) ? null : { path, props: { x1: a.x, y1: a.y, x2: b.x, y2: b.y, weight, arrowStart: !!this.opt('arrowStart'), arrowEnd: !!this.opt('arrowEnd') } };
    }
    const r = this.box(d);
    if (r.width < 1 || r.height < 1) return null;
    return this.build(r);
  }
  build(r) {
    const { x, y, width: w, height: h } = r;
    switch (this.shape) {
      case 'rect':
        return { path: rectPath(x, y, w, h), props: { x, y, width: w, height: h, radius: 0 } };
      case 'rrect': {
        const radius = Number(this.opt('radius') ?? 16);
        return { path: rectPath(x, y, w, h, radius), props: { x, y, width: w, height: h, radius } };
      }
      case 'ellipse':
        return { path: ellipsePath(x, y, w, h), props: { x, y, width: w, height: h } };
      case 'polygon': {
        const sides = Number(this.opt('sides') ?? 5), star = !!this.opt('star'), inset = Number(this.opt('inset') ?? 50);
        return { path: polygonPath(x, y, w, h, sides, star, inset), props: { x, y, width: w, height: h, sides, star, inset } };
      }
      case 'custom': {
        const name = this.opt('shape') ?? 'heart';
        return { path: customPath(name, x, y, w, h), props: { custom: name, x, y, width: w, height: h } };
      }
      default:
        return null;
    }
  }
  create({ path, props }) {
    const mode = this.opt('mode') ?? 'shape';
    const label = this.def.name;
    if (mode === 'pixels') {
      fillPathPixels(this.app, path, { label, antialias: this.opt('antialias') !== false, retry: () => this.create({ path, props }) });
      return;
    }
    if (mode === 'path') {
      const target = this.drawTarget();
      const draft = clonePath(pathOf(target));
      draft.subpaths.push(...clonePath(path).subpaths);
      this.commitNewSubpath(target, draft, label);
      return;
    }
    createShapeLayer(this.app, path, { name: this.def.layer, label, style: shapeStyle(this), kind: this.def.kind, props });
  }
  async sizeDialog(at) {
    const fields = [
      { key: 'width', label: 'Width', type: 'number', value: 100, min: 1, max: 30000, unit: 'px' },
      { key: 'height', label: 'Height', type: 'number', value: 100, min: 1, max: 30000, unit: 'px' },
    ];
    if (this.shape === 'rrect') fields.push({ key: 'radius', label: 'Radius', type: 'number', value: Number(this.opt('radius') ?? 16), min: 0, max: 5000, unit: 'px' });
    if (this.shape === 'polygon') fields.push({ key: 'sides', label: 'Sides', type: 'number', value: Number(this.opt('sides') ?? 5), min: 3, max: 100 });
    fields.push({ key: 'center', label: 'From centre', type: 'checkbox', value: false });
    const v = await formDialog(this.app, { title: this.def.title, fields });
    if (!v || !this.doc) return;
    if (v.radius !== undefined) this.setOpt('radius', Number(v.radius));
    if (v.sides !== undefined) this.setOpt('sides', Number(v.sides));
    const w = Math.max(1, Number(v.width)), h = Math.max(1, Number(v.height));
    const r = { x: v.center ? at.x - w / 2 : at.x, y: v.center ? at.y - h / 2 : at.y, width: w, height: h };
    if (this.opt('alignEdges') !== false) {
      r.x = Math.round(r.x);
      r.y = Math.round(r.y);
    }
    const g = this.build(r);
    if (g) this.create(g);
  }
  drawOverlay(ctx, view) {
    drawTargets(ctx, view, this.app, {});
    const d = this.drag;
    if (!d?.moved) return;
    const g = this.geometry(d);
    if (!g) return;
    const m = view.matrix();
    ctx.save();
    const mode = this.opt('mode') ?? 'shape';
    if (mode === 'shape') {
      ctx.globalAlpha = 0.85;
      fillPreview(ctx, g.path, m, shapeStyle(this), view.zoom);
      ctx.globalAlpha = 1;
    } else if (mode === 'pixels') {
      ctx.globalAlpha = 0.85;
      fillPreview(ctx, g.path, m, { fill: { color: this.app.settings.foreground } }, view.zoom);
      ctx.globalAlpha = 1;
    }
    strokeOutline(ctx, g.path, m);
    const b = pathBounds(g.path);
    if (b) {
      const label = this.shape === 'line' ? `${Math.round(Math.hypot(g.props.x2 - g.props.x1, g.props.y2 - g.props.y1))} px` : `${Math.round(b.width)} × ${Math.round(b.height)}`;
      const q = view.toScreen(d.current.x, d.current.y);
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(q.x + 10, q.y + 10, ctx.measureText(label).width + 8, 16);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, q.x + 14, q.y + 22);
    }
    ctx.restore();
  }
}

// ---- pen tools ----------------------------------------------------------------------------------------------

export class PenTool extends VectorTool {
  constructor(app) {
    super(app, {
      id: 'pen-tool',
      name: 'Pen Tool',
      icon: 'pen',
      cursor: 'crosshair',
      hint: 'Click to add corner points, drag for smooth points; click the first point to close. Enter or Esc finishes, Backspace removes the last point. Shift constrains to 45°.',
      options: [
        { kind: 'select', key: 'mode', label: '', options: MODE_SHAPE_PATH, default: 'path' },
        { kind: 'select', key: 'combine', label: '', options: [['new', 'New layer'], ['add', 'Add to shape']], default: 'new', when: isShapeMode },
        ...STYLE_OPTIONS,
        { kind: 'checkbox', key: 'autoAddDelete', label: 'Auto add/delete', default: true },
      ],
    });
    this.draw = null;
    this.hover = null;
  }
  get tol() {
    return 7 / (this.view?.zoom ?? 1);
  }
  overlaySpec() {
    return { anchors: 'all', handles: 'none' };
  }
  onPointerDown(p) {
    const tol = this.tol;
    if (this.draw) {
      const d = this.draw;
      const sp = d.draft.subpaths[d.sp];
      const first = sp.points[0], last = sp.points[sp.points.length - 1];
      if (sp.points.length >= 2 && Math.hypot(first.x - p.x, first.y - p.y) <= tol) {
        sp.closed = true;
        d.drag = { index: 0, moved: false, closing: true };
        this.preview();
        return;
      }
      let q = { x: p.x, y: p.y };
      if (p.shift) q = snap45(last, q);
      sp.points.push({ x: q.x, y: q.y });
      d.drag = { index: sp.points.length - 1, moved: false };
      this.preview();
      return;
    }
    if (this.opt('autoAddDelete') !== false) {
      for (const t of visibleTargets(this.app)) {
        const path = t.get();
        const a = hitAnchor(path, p.x, p.y, tol);
        if (a) {
          if (!editable(this.app, t)) return;
          const sp = path.subpaths[a.sp];
          if (!sp.closed && (a.i === 0 || a.i === sp.points.length - 1)) return this.resume(t, a);
          const draft = deleteAnchor(clonePath(path), a.sp, a.i);
          commitDraft(this.app, t, path, draft, 'Delete Anchor Point');
          return;
        }
        const s = hitSegment(path, p.x, p.y, tol);
        if (s) {
          if (!editable(this.app, t)) return;
          const draft = clonePath(path);
          splitSegment(draft.subpaths[s.sp], s.i, s.t);
          commitDraft(this.app, t, path, draft, 'Add Anchor Point');
          return;
        }
      }
    }
    this.start(p);
  }
  start(p) {
    const target = this.drawTarget();
    if (target && !editable(this.app, target)) return;
    const original = target ? target.get() : EMPTY;
    const draft = clonePath(original);
    draft.subpaths.push({ closed: false, points: [{ x: p.x, y: p.y }] });
    this.draw = { target, original, draft, sp: draft.subpaths.length - 1, drag: { index: 0, moved: false } };
    this.preview();
  }
  resume(target, a) {
    const original = target.get();
    const draft = clonePath(original);
    let sp = draft.subpaths[a.sp];
    if (a.i === 0 && sp.points.length > 1) {
      sp = reverseSubpath(sp);
      draft.subpaths[a.sp] = sp;
    }
    this.draw = { target, original, draft, sp: a.sp, drag: null, resumed: true };
    this.preview();
  }
  preview() {
    const d = this.draw;
    if (d?.target) showPreview(this.app, d.target, d.draft);
    else this.view?.invalidate();
  }
  onPointerMove(p, dragging) {
    this.hover = { x: p.x, y: p.y, shift: p.shift };
    const d = this.draw;
    if (!dragging || !d?.drag) return;
    const sp = d.draft.subpaths[d.sp];
    const pt = sp.points[d.drag.index];
    let h = { x: p.x, y: p.y };
    if (p.shift) h = snap45(pt, h);
    if (!d.drag.moved && Math.hypot(h.x - pt.x, h.y - pt.y) * this.view.zoom < 3) return;
    d.drag.moved = true;
    if (d.drag.closing) {
      // closing drag shapes the segment arriving at the first anchor
      pt.inX = 2 * pt.x - h.x;
      pt.inY = 2 * pt.y - h.y;
      if (!p.alt) {
        pt.outX = h.x;
        pt.outY = h.y;
      }
    } else {
      pt.outX = h.x;
      pt.outY = h.y;
      if (!p.alt) {
        pt.inX = 2 * pt.x - h.x;
        pt.inY = 2 * pt.y - h.y;
      }
    }
    this.preview();
  }
  onPointerUp() {
    const d = this.draw;
    if (!d) return;
    const closing = d.drag?.closing;
    d.drag = null;
    if (closing) this.finish();
  }
  finish() {
    const d = this.draw;
    this.draw = null;
    this.hover = null;
    if (!d) return;
    const sp = d.draft.subpaths[d.sp];
    if (sp && sp.points.length < 2) d.draft.subpaths.splice(d.sp, 1);
    if (d.target) {
      endPreview(this.app, d.target, d.original);
      if (samePath(d.original, d.draft)) return;
      this.commitNewSubpath(d.target, d.draft, 'Pen Tool');
    } else {
      this.view?.invalidate();
      if (isEmptyPath(d.draft)) return;
      this.commitNewSubpath(null, d.draft, 'Pen Tool');
    }
  }
  /** Escape/Enter finish the path; Backspace removes the last anchor. */
  onKeyDown(e) {
    if (!this.draw) return false;
    if (e.key === 'Escape' || e.key === 'Enter') {
      this.finish();
      return true;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      this.removeLast();
      return true;
    }
    return false;
  }
  removeLast() {
    const d = this.draw;
    const sp = d.draft.subpaths[d.sp];
    sp.closed = false;
    sp.points.pop();
    if (!sp.points.length) {
      d.draft.subpaths.splice(d.sp, 1);
      if (d.target) endPreview(this.app, d.target, d.original);
      this.draw = null;
      this.view?.invalidate();
      return;
    }
    this.preview();
  }
  /** Undo while drawing removes the last anchor (Escape is handled in onKeyDown and finishes). */
  cancel() {
    if (!this.draw) return false;
    this.removeLast();
    return true;
  }
  commit() {
    if (!this.draw) return false;
    this.finish();
    return true;
  }
  deactivate() {
    if (this.draw) this.finish();
  }
  drawOverlay(ctx, view) {
    drawTargets(ctx, view, this.app, this.overlaySpec());
    const d = this.draw;
    if (!d) return;
    const m = view.matrix();
    ctx.save();
    if (!d.target && isShapeMode(this)) {
      ctx.globalAlpha = 0.85;
      fillPreview(ctx, d.draft, m, shapeStyle(this), view.zoom);
      ctx.globalAlpha = 1;
    }
    const sp = d.draft.subpaths[d.sp];
    if (sp) {
      strokeOutline(ctx, { subpaths: [sp] }, m);
      const last = sp.points[sp.points.length - 1];
      // rubber band from the last anchor to the pointer
      if (this.hover && !d.drag && !sp.closed) {
        let h = this.hover;
        if (h.shift) h = snap45(last, h);
        const band = { subpaths: [{ closed: false, points: [{ ...last, inX: undefined, inY: undefined }, { x: h.x, y: h.y }] }] };
        ctx.setLineDash([4, 3]);
        strokeOutline(ctx, band, m, { halo: false });
        ctx.setLineDash([]);
      }
      drawHandles(ctx, last, m);
      if (sp.points.length > 1) drawHandles(ctx, sp.points[sp.points.length - 2], m);
      sp.points.forEach((p, i) => {
        const q = view.toScreen(p.x, p.y);
        drawAnchor(ctx, q.x, q.y, i === sp.points.length - 1);
      });
      if (this.hover && sp.points.length >= 2 && !sp.closed) {
        const f = sp.points[0];
        if (Math.hypot(f.x - this.hover.x, f.y - this.hover.y) <= this.tol) {
          const q = view.toScreen(f.x, f.y);
          ctx.beginPath();
          ctx.arc(q.x, q.y, 7, 0, Math.PI * 2);
          ctx.strokeStyle = ACCENT;
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }
}

export class FreeformPenTool extends VectorTool {
  constructor(app) {
    super(app, {
      id: 'pen-free',
      name: 'Freeform Pen Tool',
      icon: 'pen-free',
      cursor: 'crosshair',
      hint: 'Drag to draw a path freehand; it is simplified and smoothed when you release. End near the start to close it.',
      options: [
        { kind: 'select', key: 'mode', label: '', options: MODE_SHAPE_PATH, default: 'path' },
        { kind: 'select', key: 'combine', label: '', options: [['new', 'New layer'], ['add', 'Add to shape']], default: 'new', when: isShapeMode },
        ...STYLE_OPTIONS,
        { kind: 'number', key: 'fit', label: 'Curve fit', min: 0.5, max: 10, step: 0.5, default: 2, unit: 'px' },
      ],
    });
    this.stroke = null;
  }
  overlaySpec() {
    return { anchors: 'none' };
  }
  onPointerDown(p) {
    const target = this.drawTarget();
    if (target && !editable(this.app, target)) return;
    this.stroke = { target, pts: [[p.x, p.y]] };
  }
  onPointerMove(p, dragging) {
    const s = this.stroke;
    if (!dragging || !s) return;
    const last = s.pts[s.pts.length - 1];
    if (Math.hypot(p.x - last[0], p.y - last[1]) * this.view.zoom >= 1.5) s.pts.push([p.x, p.y]);
  }
  onPointerUp(p) {
    const s = this.stroke;
    this.stroke = null;
    if (!s || p.cancelled) return;
    s.pts.push([p.x, p.y]);
    const zoom = this.view.zoom;
    const tol = Math.max(0.5, Number(this.opt('fit') ?? 2)) / zoom;
    let pts = s.pts.filter((q, i) => i === 0 || Math.hypot(q[0] - s.pts[i - 1][0], q[1] - s.pts[i - 1][1]) > 1e-6);
    if (pts.length < 2) return;
    const f = pts[0], l = pts[pts.length - 1];
    let closed = false;
    if (pts.length > 3 && Math.hypot(f[0] - l[0], f[1] - l[1]) * zoom < 12) {
      closed = true;
      pts = pts.slice(0, -1);
    }
    pts = closed ? simplifyClosed(pts, tol) : simplify(pts, tol);
    if (pts.length < 2) return;
    const sp = smoothSubpath(pts, closed && pts.length > 2);
    const draft = clonePath(s.target ? s.target.get() : EMPTY);
    draft.subpaths.push(sp);
    this.commitNewSubpath(s.target, draft, 'Freeform Pen Tool');
  }
  cancel() {
    if (this.stroke) {
      this.stroke = null;
      return true;
    }
    return false;
  }
  drawOverlay(ctx, view) {
    drawTargets(ctx, view, this.app, {});
    const s = this.stroke;
    if (!s || s.pts.length < 2) return;
    ctx.save();
    ctx.beginPath();
    s.pts.forEach(([x, y], i) => {
      const q = view.toScreen(x, y);
      if (i) ctx.lineTo(q.x, q.y);
      else ctx.moveTo(q.x, q.y);
    });
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }
}

/** Shared drag of one anchor (and its handles) or one handle in a draft. */
class AnchorEditTool extends VectorTool {
  constructor(app, def) {
    super(app, def);
    this.drag = null;
  }
  get tol() {
    return 7 / (this.view?.zoom ?? 1);
  }
  beginDrag(target, extra) {
    const original = target.get();
    this.drag = { target, original, draft: clonePath(original), moved: false, ...extra };
    return this.drag;
  }
  endDrag(label, opts) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    commitDraft(this.app, d.target, d.original, d.draft, label, opts);
  }
  cancel() {
    if (!this.drag) return false;
    endPreview(this.app, this.drag.target, this.drag.original);
    this.drag = null;
    return true;
  }
  deactivate() {
    this.cancel();
  }
}

export class AddAnchorTool extends AnchorEditTool {
  constructor(app) {
    super(app, { id: 'pen-add', name: 'Add Anchor Point Tool', icon: 'pen-add', hint: 'Click a path segment to add an anchor point; drag to shape it.', options: [] });
  }
  overlaySpec() {
    return { anchors: 'all' };
  }
  onPointerDown(p) {
    for (const t of visibleTargets(this.app)) {
      const s = hitSegment(t.get(), p.x, p.y, this.tol);
      if (!s) continue;
      if (!editable(this.app, t)) return;
      const d = this.beginDrag(t, { start: { x: p.x, y: p.y } });
      d.index = splitSegment(d.draft.subpaths[s.sp], s.i, s.t);
      d.sp = s.sp;
      d.base = { ...d.draft.subpaths[s.sp].points[d.index] };
      showPreview(this.app, t, d.draft);
      return;
    }
  }
  onPointerMove(p, dragging) {
    const d = this.drag;
    if (!dragging || !d) return;
    const pt = d.draft.subpaths[d.sp].points[d.index];
    Object.assign(pt, d.base);
    translatePoint(pt, p.x - d.start.x, p.y - d.start.y);
    d.moved = true;
    showPreview(this.app, d.target, d.draft);
  }
  onPointerUp() {
    this.endDrag('Add Anchor Point');
  }
}

export class DeleteAnchorTool extends VectorTool {
  constructor(app) {
    super(app, { id: 'pen-delete', name: 'Delete Anchor Point Tool', icon: 'pen-delete', hint: 'Click an anchor point to delete it.', options: [] });
  }
  overlaySpec() {
    return { anchors: 'all' };
  }
  onPointerDown(p) {
    const tol = 7 / this.view.zoom;
    for (const t of visibleTargets(this.app)) {
      const path = t.get();
      const a = hitAnchor(path, p.x, p.y, tol);
      if (!a) continue;
      if (!editable(this.app, t)) return;
      commitDraft(this.app, t, path, deleteAnchor(clonePath(path), a.sp, a.i), 'Delete Anchor Point');
      return;
    }
  }
}

export class ConvertPointTool extends AnchorEditTool {
  constructor(app) {
    super(app, { id: 'pen-convert', name: 'Convert Point Tool', icon: 'pen-convert', cursor: 'default', hint: 'Click a smooth point to make it a corner; drag from a point to pull out handles; drag a handle to move it independently.', options: [] });
  }
  overlaySpec() {
    return { anchors: 'all', handles: 'all' };
  }
  onPointerDown(p) {
    const tol = this.tol;
    for (const t of visibleTargets(this.app)) {
      const path = t.get();
      const h = hitHandle(path, p.x, p.y, tol);
      if (h) {
        if (!editable(this.app, t)) return;
        this.beginDrag(t, { kind: 'handle', sp: h.sp, i: h.i, side: h.side });
        return;
      }
      const a = hitAnchor(path, p.x, p.y, tol);
      if (a) {
        if (!editable(this.app, t)) return;
        const pt = path.subpaths[a.sp].points[a.i];
        this.beginDrag(t, { kind: 'anchor', sp: a.sp, i: a.i, had: hasIn(pt) || hasOut(pt) });
        return;
      }
    }
  }
  onPointerMove(p, dragging) {
    const d = this.drag;
    if (!dragging || !d) return;
    const pt = d.draft.subpaths[d.sp].points[d.i];
    let h = { x: p.x, y: p.y };
    if (p.shift) h = snap45(pt, h);
    if (d.kind === 'handle') {
      pt[`${d.side}X`] = h.x;
      pt[`${d.side}Y`] = h.y;
    } else {
      if (!d.moved && Math.hypot(h.x - pt.x, h.y - pt.y) * this.view.zoom < 3) return;
      Object.assign(pt, { outX: h.x, outY: h.y, inX: 2 * pt.x - h.x, inY: 2 * pt.y - h.y });
    }
    d.moved = true;
    showPreview(this.app, d.target, d.draft);
  }
  onPointerUp() {
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'anchor' && !d.moved && d.had) {
      const pt = d.draft.subpaths[d.sp].points[d.i];
      delete pt.inX;
      delete pt.inY;
      delete pt.outX;
      delete pt.outY;
    }
    this.endDrag('Convert Point');
  }
}

// ---- path selection / direct selection ------------------------------------------------------------------------

function targetByKey(app, key) {
  return visibleTargets(app).find((t) => t.key === key) ?? null;
}

/** Topmost visible shape layer (other than those already visible as targets) with a subpath under p. */
function shapeLayerAt(app, p, tol) {
  const doc = app.doc;
  for (const l of doc.layers().slice().reverse()) {
    if (l.type !== 'shape' || !l.visible || l === doc.active) continue;
    const s = hitSubpath(l.path, p.x, p.y, tol);
    if (s >= 0) return { layer: l, sp: s };
  }
  return null;
}

class SelectionToolBase extends AnchorEditTool {
  onKeyDown(e) {
    const sel = state.sel;
    const t = sel.key ? targetByKey(this.app, sel.key) : null;
    if (!t || this.drag) return false;
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[e.key]) {
      if (!editable(this.app, t)) return true;
      const k = e.shiftKey ? 10 : 1;
      const [dx, dy] = arrows[e.key].map((v) => v * k);
      const original = t.get();
      const draft = clonePath(original);
      this.moveSelection(draft, original, dx, dy);
      commitDraft(this.app, t, original, draft, 'Nudge', { reshaped: this.reshapes });
      return true;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!editable(this.app, t)) return true;
      const original = t.get();
      const draft = this.deleteSelection(clonePath(original));
      if (draft) {
        commitDraft(this.app, t, original, draft, this.reshapes ? 'Delete Anchor Point' : 'Delete Path');
        clearSel();
      }
      return true;
    }
    return false;
  }
  cancel() {
    if (super.cancel()) return true;
    if (state.sel.key) {
      clearSel();
      this.view?.invalidate();
      return true;
    }
    return false;
  }
}

export class PathSelectionTool extends SelectionToolBase {
  constructor(app) {
    super(app, {
      id: 'path-selection',
      name: 'Path Selection Tool',
      icon: 'path-select',
      cursor: 'default',
      hint: 'Click a path to select it and drag to move it (Shift adds, Alt-drag duplicates). Arrow keys nudge, Delete removes.',
      options: [...PATH_BUTTONS],
    });
    this.reshapes = false;
  }
  overlaySpec() {
    return { anchors: 'selected-subpaths' };
  }
  moveSelection(draft, original, dx, dy) {
    for (const s of state.sel.subpaths) {
      const sp = draft.subpaths[s];
      if (!sp) continue;
      original.subpaths[s].points.forEach((o, i) => {
        Object.assign(sp.points[i], o);
        translatePoint(sp.points[i], dx, dy);
      });
    }
  }
  deleteSelection(draft) {
    const idx = [...state.sel.subpaths].sort((a, b) => b - a);
    if (!idx.length) return null;
    for (const s of idx) draft.subpaths.splice(s, 1);
    return draft;
  }
  onPointerDown(p) {
    const tol = 6 / this.view.zoom;
    let hit = null;
    for (const t of visibleTargets(this.app)) {
      const s = hitSubpath(t.get(), p.x, p.y, tol);
      if (s >= 0) {
        hit = { target: t, sp: s };
        break;
      }
    }
    if (!hit) {
      const other = shapeLayerAt(this.app, p, tol);
      if (other) {
        this.doc.setActive(other.layer);
        hit = { target: shapeTarget(this.app, other.layer), sp: other.sp };
      }
    }
    if (!hit) {
      if (!p.shift) clearSel();
      this.view.invalidate();
      return;
    }
    const sel = state.sel.key === hit.target.key ? state.sel : { key: hit.target.key, subpaths: new Set(), anchors: new Set() };
    if (p.shift) {
      if (sel.subpaths.has(hit.sp)) sel.subpaths.delete(hit.sp);
      else sel.subpaths.add(hit.sp);
    } else if (!sel.subpaths.has(hit.sp)) {
      sel.subpaths = new Set([hit.sp]);
    }
    sel.anchors = new Set();
    state.sel = sel;
    if (!sel.subpaths.size || !editable(this.app, hit.target)) return;
    this.beginDrag(hit.target, { start: { x: p.x, y: p.y }, duplicate: p.alt });
  }
  onPointerMove(p, dragging) {
    const d = this.drag;
    if (!dragging || !d) return;
    let dx = p.x - d.start.x, dy = p.y - d.start.y;
    if (!d.moved && Math.hypot(dx, dy) * this.view.zoom < 2) return;
    if (p.shift) {
      const q = snap45(d.start, p);
      dx = q.x - d.start.x;
      dy = q.y - d.start.y;
    }
    if (!d.moved && d.duplicate) {
      // Alt-drag: move copies of the selected subpaths
      const copies = [...state.sel.subpaths].sort((a, b) => a - b).map((s) => clonePath({ subpaths: [d.original.subpaths[s]] }).subpaths[0]);
      const base = d.draft.subpaths.length;
      d.draft.subpaths.push(...copies);
      d.original = { subpaths: [...d.original.subpaths, ...copies.map((c) => clonePath({ subpaths: [c] }).subpaths[0])] };
      d.realOriginal = d.target.get();
      state.sel.subpaths = new Set(copies.map((_, k) => base + k));
    }
    d.moved = true;
    this.moveSelection(d.draft, d.original, dx, dy);
    showPreview(this.app, d.target, d.draft);
  }
  onPointerUp(p) {
    const d = this.drag;
    if (!d) return;
    if (p.cancelled || !d.moved) {
      this.cancel();
      return;
    }
    if (d.realOriginal) d.original = d.realOriginal;
    this.endDrag(d.duplicate ? 'Duplicate Path' : 'Move Path', { reshaped: !!d.duplicate });
  }
}

export class DirectSelectionTool extends SelectionToolBase {
  constructor(app) {
    super(app, {
      id: 'direct-selection',
      name: 'Direct Selection Tool',
      icon: 'direct-select',
      cursor: 'default',
      hint: 'Click or drag around anchor points to select them, drag to move them or their handles (Alt-drag a handle to break the symmetry). Drag a curve to reshape it.',
      options: [...PATH_BUTTONS],
    });
    this.reshapes = true;
    this.marquee = null;
  }
  overlaySpec() {
    return { anchors: 'all', handles: 'selected' };
  }
  moveSelection(draft, original, dx, dy) {
    for (const key of state.sel.anchors) {
      const [s, i] = key.split(':').map(Number);
      const o = original.subpaths[s]?.points[i];
      const pt = draft.subpaths[s]?.points[i];
      if (!o || !pt) continue;
      Object.assign(pt, o);
      translatePoint(pt, dx, dy);
    }
  }
  deleteSelection(draft) {
    const keys = [...state.sel.anchors].map((k) => k.split(':').map(Number)).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    if (!keys.length) return null;
    for (const [s, i] of keys) if (draft.subpaths[s]?.points[i]) deleteAnchor(draft, s, i);
    return draft;
  }
  onPointerDown(p) {
    const tol = 7 / this.view.zoom;
    const targets = visibleTargets(this.app);
    // 1. handles of selected anchors
    const selTarget = state.sel.key ? targets.find((t) => t.key === state.sel.key) : null;
    if (selTarget) {
      const h = hitHandle(selTarget.get(), p.x, p.y, tol, (s, i) => state.sel.anchors.has(`${s}:${i}`));
      if (h) {
        if (!editable(this.app, selTarget)) return;
        const o = selTarget.get().subpaths[h.sp].points[h.i];
        const other = h.side === 'in' ? 'out' : 'in';
        const collinear = (other === 'in' ? hasIn(o) : hasOut(o)) && isCollinear(o);
        this.beginDrag(selTarget, { kind: 'handle', sp: h.sp, i: h.i, side: h.side, collinear });
        return;
      }
    }
    // 2. anchors
    for (const t of targets) {
      const a = hitAnchor(t.get(), p.x, p.y, tol);
      if (!a) continue;
      const key = `${a.sp}:${a.i}`;
      if (state.sel.key !== t.key) state.sel = { key: t.key, subpaths: new Set(), anchors: new Set() };
      if (p.shift) {
        if (state.sel.anchors.has(key)) state.sel.anchors.delete(key);
        else state.sel.anchors.add(key);
      } else if (!state.sel.anchors.has(key)) state.sel.anchors = new Set([key]);
      this.view.invalidate();
      if (!state.sel.anchors.size || !editable(this.app, t)) return;
      this.beginDrag(t, { kind: 'anchors', start: { x: p.x, y: p.y } });
      return;
    }
    // 3. segments: straight ones move with both anchors, curves reshape
    for (const t of targets) {
      const s = hitSegment(t.get(), p.x, p.y, tol);
      if (!s) continue;
      const sp = t.get().subpaths[s.sp];
      const j = (s.i + 1) % sp.points.length;
      state.sel = { key: t.key, subpaths: new Set(), anchors: new Set([`${s.sp}:${s.i}`, `${s.sp}:${j}`]) };
      this.view.invalidate();
      if (!editable(this.app, t)) return;
      if (isLine(sp.points[s.i], sp.points[j])) this.beginDrag(t, { kind: 'anchors', start: { x: p.x, y: p.y } });
      else this.beginDrag(t, { kind: 'curve', sp: s.sp, i: s.i, j, t: Math.max(0.1, Math.min(0.9, s.t)), start: { x: p.x, y: p.y } });
      return;
    }
    // 4. another shape layer's path
    const other = shapeLayerAt(this.app, p, tol);
    if (other) {
      this.doc.setActive(other.layer);
      state.sel = { key: `shape:${other.layer.id}`, subpaths: new Set(), anchors: new Set() };
      this.view.invalidate();
      return;
    }
    // 5. rubber band
    if (!p.shift) clearSel();
    this.marquee = { start: { x: p.x, y: p.y }, current: { x: p.x, y: p.y }, add: p.shift };
    this.view.invalidate();
  }
  onPointerMove(p, dragging) {
    if (!dragging) return;
    if (this.marquee) {
      this.marquee.current = { x: p.x, y: p.y };
      return;
    }
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'handle') {
      const pt = d.draft.subpaths[d.sp].points[d.i];
      let h = { x: p.x, y: p.y };
      if (p.shift) h = snap45(pt, h);
      pt[`${d.side}X`] = h.x;
      pt[`${d.side}Y`] = h.y;
      if (d.collinear && !p.alt) {
        const other = d.side === 'in' ? 'out' : 'in';
        const o = d.original.subpaths[d.sp].points[d.i];
        const len = Math.hypot(o[`${other}X`] - o.x, o[`${other}Y`] - o.y);
        const vx = h.x - pt.x, vy = h.y - pt.y, vl = Math.hypot(vx, vy);
        if (vl > 1e-6) {
          pt[`${other}X`] = pt.x - (vx / vl) * len;
          pt[`${other}Y`] = pt.y - (vy / vl) * len;
        }
      } else if (d.collinear) {
        const other = d.side === 'in' ? 'out' : 'in';
        const o = d.original.subpaths[d.sp].points[d.i];
        pt[`${other}X`] = o[`${other}X`];
        pt[`${other}Y`] = o[`${other}Y`];
      }
      d.moved = true;
      showPreview(this.app, d.target, d.draft);
      return;
    }
    let dx = p.x - d.start.x, dy = p.y - d.start.y;
    if (!d.moved && Math.hypot(dx, dy) * this.view.zoom < 2) return;
    if (p.shift && d.kind === 'anchors') {
      const q = snap45(d.start, p);
      dx = q.x - d.start.x;
      dy = q.y - d.start.y;
    }
    d.moved = true;
    if (d.kind === 'anchors') this.moveSelection(d.draft, d.original, dx, dy);
    else if (d.kind === 'curve') reshapeCurve(d, dx, dy);
    showPreview(this.app, d.target, d.draft);
  }
  onPointerUp(p) {
    if (this.marquee) {
      const m = this.marquee;
      this.marquee = null;
      const x1 = Math.min(m.start.x, m.current.x), x2 = Math.max(m.start.x, m.current.x);
      const y1 = Math.min(m.start.y, m.current.y), y2 = Math.max(m.start.y, m.current.y);
      if (x2 - x1 > 0 || y2 - y1 > 0) {
        for (const t of visibleTargets(this.app)) {
          const keys = [];
          t.get().subpaths.forEach((sp, s) => sp.points.forEach((q, i) => {
            if (q.x >= x1 && q.x <= x2 && q.y >= y1 && q.y <= y2) keys.push(`${s}:${i}`);
          }));
          if (!keys.length) continue;
          if (!(m.add && state.sel.key === t.key)) state.sel = { key: t.key, subpaths: new Set(), anchors: new Set() };
          for (const k of keys) state.sel.anchors.add(k);
          break;
        }
      }
      this.view.invalidate();
      return;
    }
    const d = this.drag;
    if (!d) return;
    if (p.cancelled || !d.moved) {
      this.cancel();
      if (!p.cancelled && state.sel.key) this.view.invalidate();
      return;
    }
    this.endDrag(d.kind === 'handle' ? 'Edit Handle' : d.kind === 'curve' ? 'Reshape Path' : 'Move Anchor Points');
  }
  cancel() {
    if (this.marquee) {
      this.marquee = null;
      return true;
    }
    return super.cancel();
  }
  drawOverlay(ctx, view) {
    super.drawOverlay(ctx, view);
    if (!this.marquee) return;
    const a = view.toScreen(this.marquee.start.x, this.marquee.start.y), b = view.toScreen(this.marquee.current.x, this.marquee.current.y);
    ctx.save();
    ctx.strokeStyle = ACCENT;
    ctx.fillStyle = 'rgba(30,136,255,0.08)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.strokeRect(Math.min(a.x, b.x) + 0.5, Math.min(a.y, b.y) + 0.5, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.restore();
  }
}

function isCollinear(p) {
  if (!hasIn(p) || !hasOut(p)) return false;
  const ax = p.inX - p.x, ay = p.inY - p.y, bx = p.outX - p.x, by = p.outY - p.y;
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la < 1e-6 || lb < 1e-6) return true;
  return (ax * bx + ay * by) / (la * lb) < -0.996; // within ~5° of opposite
}

/** Drags a cubic segment through the grabbed point by moving its two handles (Inkscape's weighting). */
function reshapeCurve(d, dx, dy) {
  const t = d.t;
  let w;
  if (t <= 1 / 6) w = 0;
  else if (t <= 0.5) w = Math.pow((6 * t - 1) / 2, 3) / 2;
  else if (t <= 5 / 6) w = (1 - Math.pow((6 * (1 - t) - 1) / 2, 3)) / 2 + 0.5;
  else w = 1;
  const f0 = (1 - w) / (3 * t * (1 - t) * (1 - t)), f1 = w / (3 * t * t * (1 - t));
  const oa = d.original.subpaths[d.sp].points[d.i], ob = d.original.subpaths[d.sp].points[d.j];
  const a = d.draft.subpaths[d.sp].points[d.i], b = d.draft.subpaths[d.sp].points[d.j];
  a.outX = (oa.outX ?? oa.x) + dx * f0;
  a.outY = (oa.outY ?? oa.y) + dy * f0;
  b.inX = (ob.inX ?? ob.x) + dx * f1;
  b.inY = (ob.inY ?? ob.y) + dy * f1;
}

// ---- commands -----------------------------------------------------------------------------------------------

function nextPathName(doc) {
  const used = new Set(doc.paths.map((p) => p.name));
  for (let i = 1; ; i++) if (!used.has(`Path ${i}`)) return `Path ${i}`;
}

const OP_OPTIONS = [['replace', 'New Selection'], ['add', 'Add to Selection'], ['subtract', 'Subtract from Selection'], ['intersect', 'Intersect with Selection']];

async function makeSelection(app, arg) {
  const doc = app.doc;
  const t = currentPathTarget(app);
  if (!t) return app.dialogs.toast('There is no path to load as a selection', { kind: 'error' });
  let opts = arg && typeof arg === 'object' ? { feather: 0, antialias: true, op: 'replace', rule: 'nonzero', ...arg } : null;
  if (!opts) {
    const hasSel = doc.selection && !doc.selection.isEmpty;
    opts = await formDialog(app, {
      title: 'Make Selection',
      fields: [
        { key: 'feather', label: 'Feather radius', type: 'number', value: 0, min: 0, max: 250, step: 0.5, unit: 'px' },
        { key: 'antialias', label: 'Anti-aliased', type: 'checkbox', value: true },
        { key: 'op', label: 'Operation', type: 'select', value: 'replace', options: hasSel ? OP_OPTIONS : OP_OPTIONS.slice(0, 1) },
        { key: 'rule', label: 'Overlapping subpaths', type: 'select', value: 'nonzero', options: [['nonzero', 'Combine (non-zero)'], ['evenodd', 'Exclude overlap (even-odd)']] },
      ],
    });
    if (!opts || app.doc !== doc) return;
  }
  let sel = Selection.fromMask(doc.width, doc.height, pathMask(doc, t.get(), { antialias: opts.antialias !== false, rule: opts.rule === 'evenodd' ? 'evenodd' : 'nonzero' }));
  const feather = Number(opts.feather) || 0;
  if (feather > 0) sel = sel.feather(feather);
  app.applySelection(sel, opts.op ?? 'replace', 'Make Selection');
}

async function fillPathCommand(app, arg) {
  const doc = app.doc;
  const t = currentPathTarget(app);
  if (!t) return app.dialogs.toast('There is no path to fill', { kind: 'error' });
  let opts = arg && typeof arg === 'object' ? arg : null;
  if (!opts) {
    opts = await formDialog(app, {
      title: 'Fill Path',
      fields: [
        { key: 'use', label: 'Contents', type: 'select', value: 'foreground', options: [['foreground', 'Foreground Color'], ['background', 'Background Color'], ['color', 'Color…'], ['black', 'Black'], ['white', 'White'], ['grey', '50% Gray']] },
        { key: 'color', label: 'Color', type: 'color', value: app.settings.foreground, when: (v) => v.use === 'color' },
        { key: 'opacity', label: 'Opacity', type: 'slider', value: 100, min: 1, max: 100, unit: '%' },
        { key: 'feather', label: 'Feather radius', type: 'number', value: 0, min: 0, max: 250, step: 0.5, unit: 'px' },
        { key: 'antialias', label: 'Anti-aliased', type: 'checkbox', value: true },
      ],
    });
    if (!opts || app.doc !== doc) return;
  }
  const use = opts.use ?? 'foreground';
  const color = opts.color && use === 'color' ? opts.color : { foreground: app.settings.foreground, background: app.settings.background, black: '#000000', white: '#ffffff', grey: '#808080' }[use] ?? app.settings.foreground;
  fillPathPixels(app, t.get(), { label: 'Fill Path', color, opacity: (opts.opacity ?? 100) / 100, feather: Number(opts.feather) || 0, antialias: opts.antialias !== false, retry: () => fillPathCommand(app, opts) });
}

async function strokePathCommand(app, arg) {
  const doc = app.doc;
  const t = currentPathTarget(app);
  if (!t) return app.dialogs.toast('There is no path to stroke', { kind: 'error' });
  let opts = arg && typeof arg === 'object' ? arg : null;
  if (!opts) {
    opts = await formDialog(app, {
      title: 'Stroke Path',
      fields: [
        { key: 'tool', label: 'Tool', type: 'select', value: 'brush', options: [['brush', 'Brush'], ['pencil', 'Pencil'], ['eraser', 'Eraser']] },
        { key: 'simulatePressure', label: 'Simulate pressure', type: 'checkbox', value: false },
      ],
    });
    if (!opts || app.doc !== doc) return;
  }
  strokePathPixels(app, t.get(), { tool: opts.tool ?? 'brush', simulatePressure: !!opts.simulatePressure, retry: () => strokePathCommand(app, opts) });
}

async function pathFromSelection(app, arg) {
  const doc = app.doc;
  if (!doc.selection || doc.selection.isEmpty) return app.dialogs.toast('Make a selection first', { kind: 'error' });
  let tolerance = arg && typeof arg === 'object' ? arg.tolerance ?? 2 : null;
  if (tolerance === null) {
    const v = await formDialog(app, { title: 'Make Work Path', fields: [{ key: 'tolerance', label: 'Tolerance', type: 'number', value: 2, min: 0.5, max: 10, step: 0.5, unit: 'px' }] });
    if (!v || app.doc !== doc) return;
    tolerance = Number(v.tolerance) || 2;
  }
  const path = pathFromSelectionMask(doc.selection, tolerance);
  if (isEmptyPath(path)) return app.dialogs.toast('The selection is too small to make a path', { kind: 'error' });
  recordPaths(doc, 'Make Work Path', { workPath: path });
  setActivePath(app, { kind: 'work' });
}

async function savePath(app, arg) {
  const doc = app.doc;
  if (!doc.workPath || isEmptyPath(doc.workPath)) return app.dialogs.toast('There is no work path to save', { kind: 'error' });
  let name = typeof arg === 'string' ? arg : arg?.name;
  if (!name) {
    name = await app.dialogs.prompt('Name', { title: 'Save Path', value: nextPathName(doc) });
    if (!name?.trim() || app.doc !== doc) return;
  }
  const id = newId('P');
  recordPaths(doc, 'Save Path', { paths: [...doc.paths, { id, name: name.trim(), path: clonePath(doc.workPath) }], workPath: null });
  setActivePath(app, { kind: 'saved', id });
}

function newPath(app, arg) {
  const doc = app.doc;
  const name = (typeof arg === 'string' ? arg : arg?.name) || nextPathName(doc);
  const id = newId('P');
  recordPaths(doc, 'New Path', { paths: [...doc.paths, { id, name, path: { subpaths: [] } }] });
  setActivePath(app, { kind: 'saved', id });
  return id;
}

function deletableTarget(app) {
  const t = activePathTarget(app);
  if (t?.kind === 'saved' || (t?.kind === 'work' && app.doc.workPath)) return t;
  if (!t && app.doc?.workPath && !isEmptyPath(app.doc.workPath)) return workTarget(app.doc);
  return null;
}

function deletePath(app) {
  const doc = app.doc;
  const t = deletableTarget(app);
  if (!t) return app.dialogs.toast('Select a saved path or the work path to delete', { kind: 'error' });
  if (t.kind === 'saved') recordPaths(doc, 'Delete Path', { paths: doc.paths.filter((p) => p.id !== t.id) });
  else recordPaths(doc, 'Delete Work Path', { workPath: null });
  setActivePath(app, null);
  clearSel();
}

function renamePath(app, { id, name } = {}) {
  const doc = app.doc;
  if (!doc || !name?.trim() || !doc.paths.some((p) => p.id === id)) return;
  recordPaths(doc, 'Rename Path', { paths: doc.paths.map((p) => (p.id === id ? { ...p, name: name.trim() } : p)) });
}

// ---- install ------------------------------------------------------------------------------------------------

export function install(app) {
  app.ui.activePath ??= null;
  const t = app.tools;
  t.register(new PenTool(app), 'pen');
  t.register(new FreeformPenTool(app), 'pen');
  t.register(new AddAnchorTool(app), 'pen');
  t.register(new DeleteAnchorTool(app), 'pen');
  t.register(new ConvertPointTool(app), 'pen');
  t.register(new PathSelectionTool(app), 'path-select');
  t.register(new DirectSelectionTool(app), 'path-select');
  for (const s of ['rect', 'rrect', 'ellipse', 'polygon', 'line', 'custom']) t.register(new ShapeTool(app, s), 'shape');
  // Photoshop order: Pen, Type, Path Selection, Shape (text.js registers its slot first)
  const slots = t.slots;
  const pi = slots.findIndex((s) => s.id === 'pen'), ti = slots.findIndex((s) => s.id === 'text');
  if (ti >= 0 && pi > ti && !t.toolboxBuilt) slots.splice(ti, 0, ...slots.splice(pi, 1));

  const has = () => !!app.doc;
  const hasPath = () => !!currentPathTarget(app);
  app.commands.registerAll({
    'path:make-selection': { enabled: hasPath, label: 'Make Selection…', run: (arg) => makeSelection(app, arg) },
    'path:fill': { enabled: hasPath, label: 'Fill Path…', run: (arg) => fillPathCommand(app, arg) },
    'path:stroke': { enabled: hasPath, label: 'Stroke Path…', run: (arg) => strokePathCommand(app, arg) },
    'path:from-selection': { enabled: () => !!app.doc?.selection && !app.doc.selection.isEmpty, label: 'Make Work Path…', run: (arg) => pathFromSelection(app, arg) },
    'path:save': { enabled: () => !!app.doc?.workPath && !isEmptyPath(app.doc.workPath), label: 'Save Path…', run: (arg) => savePath(app, arg) },
    'path:new': { enabled: has, label: 'New Path', run: (arg) => newPath(app, arg) },
    'path:delete': { enabled: () => !!app.doc && !!deletableTarget(app), label: 'Delete Path', run: () => deletePath(app) },
    'path:rename': { enabled: has, run: (arg) => renamePath(app, arg) },
    'path:select': { enabled: has, run: (arg) => setActivePath(app, arg ?? null) },
  });

  const attach = (doc) => {
    if (!doc?.view || doc.view.__pathOverlay) return;
    doc.view.__pathOverlay = doc.view.addOverlay((ctx, view) => drawChosenPath(ctx, view, app));
  };
  app.on('doc:opened', attach);
  app.on('doc:activated', (doc) => {
    attach(doc);
    clearSel();
    state.preview = null;
  });
  app.on('layer:activated', ({ doc, layer }) => {
    const ap = app.ui.activePath;
    if (ap?.kind === 'shape' && ap.layerId !== layer?.id) setActivePath(app, null);
    if (state.sel.key?.startsWith('shape:') && state.sel.key !== `shape:${layer?.id}`) clearSel();
    const tool = app.tools.active;
    if (tool?.isVector && doc === app.doc) tool.syncStyleFromLayer?.();
  });
  app.on('doc:change', (e) => {
    if (e.kind === 'history' || e.kind === 'paths' || e.kind === 'tree') {
      // keep the path selection pointing at existing subpaths/anchors
      const t = state.sel.key ? targetByKey(app, state.sel.key) : null;
      if (state.sel.key && !t) clearSel();
      else if (t) {
        const path = t.get();
        for (const s of [...state.sel.subpaths]) if (!path.subpaths[s]) state.sel.subpaths.delete(s);
        for (const k of [...state.sel.anchors]) {
          const [s, i] = k.split(':').map(Number);
          if (!path.subpaths[s]?.points[i]) state.sel.anchors.delete(k);
        }
      }
    }
  });
  for (const doc of app.docs?.list?.() ?? []) attach(doc);
}
