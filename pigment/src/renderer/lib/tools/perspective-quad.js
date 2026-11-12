// Quad geometry of the Perspective Crop tool (lib/tools/perspective-crop.js). Pure functions on
// points ([x, y] pairs), kept apart from the tool so they run under node:test without a DOM.

export const MAX_SIDE = 30000;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Four points in any order -> [top-left, top-right, bottom-right, bottom-left] (clockwise on screen). */
export function orderQuad(points) {
  const pts = points.map((p) => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [Number(p.x), Number(p.y)]));
  const cx = pts.reduce((s, p) => s + p[0], 0) / 4, cy = pts.reduce((s, p) => s + p[1], 0) / 4;
  pts.sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  // start at the corner nearest the top-left of the quad's bounding box
  const minX = Math.min(...pts.map((p) => p[0])), minY = Math.min(...pts.map((p) => p[1]));
  let first = 0;
  for (let i = 1; i < 4; i++) if (dist(pts[i], [minX, minY]) < dist(pts[first], [minX, minY])) first = i;
  return [0, 1, 2, 3].map((i) => pts[(first + i) % 4]);
}

/** True when the ordered quad is convex and has some area (a perspective needs that). */
export function isConvexQuad(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-6) return false;
    if (sign && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  return true;
}

/** Size of the straightened rectangle when none is asked for: the longer of each pair of opposite edges. */
export function naturalSize(q) {
  return { width: Math.max(1, Math.round(Math.max(dist(q[0], q[1]), dist(q[3], q[2])))), height: Math.max(1, Math.round(Math.max(dist(q[0], q[3]), dist(q[1], q[2])))) };
}

/** Output size for the W / H options: both, one (the other keeps the quad's proportions) or neither. */
export function outputSize(q, width = 0, height = 0) {
  const n = naturalSize(q);
  let w = Number(width) > 0 ? Math.round(Number(width)) : 0, h = Number(height) > 0 ? Math.round(Number(height)) : 0;
  if (!w && !h) return n;
  if (!w) w = Math.max(1, Math.round((h * n.width) / n.height));
  if (!h) h = Math.max(1, Math.round((w * n.height) / n.width));
  return { width: Math.min(MAX_SIDE, w), height: Math.min(MAX_SIDE, h) };
}

/** A quad whose opposite sides are parallel needs no perspective: an affine matrix maps it onto the rectangle. */
export const isParallelogram = (q) => Math.hypot(q[0][0] + q[2][0] - q[1][0] - q[3][0], q[0][1] + q[2][1] - q[1][1] - q[3][1]) < 1e-6 * (1 + dist(q[0], q[2]));
