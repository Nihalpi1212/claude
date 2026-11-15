// shapes-live (ARCHITECTURE.md "0.4 features", package 13): live shape geometry (shape-geometry.js) and the shape
// functions of path-ops.js (J.5): path regeneration, corner and arrowhead geometry, the 0.3 reading table,
// mapShapeGeometry through translation, scale, rotation, skew and perspective, stroke padding and dashes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shapePath, rectPath, polygonPath, linePath, ellipsePath, roundedPolygon, clampRadii, mapLiveProps, fitAffine,
  strokeReach, arrowPx, normalizeAngle, triangleVertices, customPath,
} from '../../src/renderer/lib/shape-geometry.js';
import { normalizeShapeProps, mapShapeGeometry, shapeBounds, shapeContentBounds, dashPattern, isLiveShape, regenerateShape, livePath } from '../../src/renderer/lib/path-ops.js';

const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const pt = (p) => [Math.round(p.x * 1e4) / 1e4, Math.round(p.y * 1e4) / 1e4];
const anchors = (path, i = 0) => path.subpaths[i].points.map(pt);
const bounds = (path) => {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const sp of path.subpaths) for (const p of sp.points) {
    x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y); x2 = Math.max(x2, p.x); y2 = Math.max(y2, p.y);
  }
  return [x1, y1, x2, y2].map((v) => Math.round(v * 1e4) / 1e4);
};
const rot = (deg) => {
  const a = (deg * Math.PI) / 180;
  return [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a)];
};

test('rectangles: equal radii give 0.3\'s rectPath; per-corner radii put the arcs where they belong', () => {
  const p = { x: 10, y: 20, width: 100, height: 60, angle: 0 };
  assert.deepEqual(anchors(shapePath('rect', { ...p, radii: [0, 0, 0, 0] })), anchors(rectPath(10, 20, 100, 60)));
  assert.deepEqual(anchors(shapePath('rect', { ...p, radii: [8, 8, 8, 8] })), anchors(rectPath(10, 20, 100, 60, 8)));
  // top-left 10, bottom-right 20, the other two square: starts on the top side after the top-left arc
  const path = shapePath('rect', { ...p, radii: [10, 0, 20, 0] });
  assert.deepEqual(anchors(path), [[20, 20], [110, 20], [110, 60], [90, 80], [10, 80], [10, 30]]);
  const [first] = path.subpaths[0].points;
  assert.ok(close(first.inX, 20 - 10 * 0.5522847498307936) && close(first.inY, 20)); // kappa handle of a 90° arc
  // radii that overfill a side are scaled down together (Photoshop)
  assert.deepEqual(clampRadii(100, 60, [50, 50, 50, 50]), [30, 30, 30, 30]);
  assert.deepEqual(clampRadii(100, 60, [40, 20, 0, 0]), [40, 20, 0, 0]); // 40 + 20 fits the top, 40 the left side
  // the top asks for 100 / 120, the left side for 60 / 90: the tighter one wins for all four
  assert.deepEqual(clampRadii(100, 60, [90, 30, 0, 0]).map((r) => Math.round(r * 1000) / 1000), [60, 20, 0, 0]);
});

test('angle rotates the shape about its box centre', () => {
  const r = shapePath('rect', { x: 0, y: 0, width: 100, height: 40, angle: 90, radii: [0, 0, 0, 0] });
  assert.deepEqual(bounds(r), [30, -30, 70, 70]);
  const e = shapePath('ellipse', { x: 0, y: 0, width: 100, height: 40, angle: 90 });
  assert.deepEqual(bounds(e), [30, -30, 70, 70]);
  assert.deepEqual(anchors(shapePath('ellipse', { x: 0, y: 0, width: 100, height: 40, angle: 0 })), anchors(ellipsePath(0, 0, 100, 40)));
  assert.equal(normalizeAngle(270), -90);
  assert.equal(normalizeAngle(-180), 180);
  assert.equal(normalizeAngle(360 + 45), 45);
});

test('triangles: an isosceles triangle in its box, corners rounded by tangent arcs', () => {
  assert.deepEqual(triangleVertices({ x: 0, y: 0, width: 100, height: 80 }), [{ x: 50, y: 0 }, { x: 100, y: 80 }, { x: 0, y: 80 }]);
  assert.deepEqual(anchors(shapePath('triangle', { x: 0, y: 0, width: 100, height: 80, angle: 0, radius: 0 })), [[50, 0], [100, 80], [0, 80]]);
  const t = shapePath('triangle', { x: 0, y: 0, width: 100, height: 80, angle: 0, radius: 5 });
  assert.equal(t.subpaths[0].points.length, 6);
  // the bottom-right corner (interior angle atan(80/50)): both tangent points sit at r / tan(θ/2) from the corner
  const theta = Math.atan2(80, 50);
  const d = 5 / Math.tan(theta / 2);
  const [, , , t2] = t.subpaths[0].points; // after the bottom-right arc: on the bottom side
  assert.ok(close(t2.x, 100 - d, 1e-5) && close(t2.y, 80, 1e-5));
  // every arc point lies at the radius from the arc centre
  const cx = 100 - d, cy = 80 - 5;
  assert.ok(close(Math.hypot(t2.x - cx, t2.y - cy), 5, 1e-5));
  // a huge radius is clamped to half the shortest side: arcs meet, never cross
  const big = shapePath('triangle', { x: 0, y: 0, width: 100, height: 80, angle: 0, radius: 1e6 });
  // the arcs meet on the two equal sides (one smooth anchor each); the base keeps a short straight piece
  assert.equal(big.subpaths[0].points.length, 4);
  assert.deepEqual(big.subpaths[0].points.map(pt).slice(0, 2), [[25, 40], [75, 40]]);
});

test('polygons and stars: 0.3\'s vertices, star ratio, smooth corners and indents, corner radius', () => {
  const base = { x: 0, y: 0, width: 100, height: 100, angle: 0, sides: 6, smoothCorners: false, smoothIndents: false, cornerRadius: 0 };
  assert.deepEqual(anchors(shapePath('polygon', { ...base, starRatio: 100 })), anchors(polygonPath(0, 0, 100, 100, 6)));
  assert.deepEqual(anchors(shapePath('polygon', { ...base, starRatio: 40 })), anchors(polygonPath(0, 0, 100, 100, 6, true, 60)));
  // smooth corners: arcs as wide as the sides allow, meeting on each side's midpoint
  const smooth = shapePath('polygon', { ...base, sides: 4, starRatio: 100, smoothCorners: true });
  const pts = smooth.subpaths[0].points;
  assert.equal(pts.length, 4);
  assert.ok(pts.every((p) => p.inX !== undefined && p.outX !== undefined));
  assert.deepEqual(pts.map(pt), [[25, 25], [75, 25], [75, 75], [25, 75]]);
  // a star with smooth indents only rounds the inner corners
  const star = shapePath('polygon', { ...base, sides: 5, starRatio: 50, smoothIndents: true });
  assert.equal(star.subpaths[0].points.filter((p) => p.inX === undefined && p.outX === undefined).length, 5); // the five tips stay sharp
  const r = shapePath('polygon', { ...base, sides: 6, starRatio: 100, cornerRadius: 4 });
  assert.equal(r.subpaths[0].points.length, 12);
});

test('roundedPolygon: a right angle gets the kappa arc of a quarter circle', () => {
  const sp = roundedPolygon([{ x: 0, y: 0, r: 10 }, { x: 100, y: 0, r: 0 }, { x: 100, y: 100, r: 0 }, { x: 0, y: 100, r: 0 }]);
  assert.deepEqual(sp.points.map(pt), [[0, 10], [10, 0], [100, 0], [100, 100], [0, 100]]);
  assert.ok(close(sp.points[0].outY, 10 - 10 * 0.5522847498307936));
  assert.ok(close(sp.points[1].inX, 10 - 10 * 0.5522847498307936));
});

test('lines: weight, arrowheads in percent of the weight, concavity; 0.3 lines unchanged', () => {
  // 0.3's head (5 x weight from 1.2 px up) equals { width: 500, length: 500, concavity: 0 }
  const old = linePath(0, 0, 100, 0, 2, false, true);
  const live = shapePath('line', { x1: 0, y1: 0, x2: 100, y2: 0, weight: 2, arrowStart: null, arrowEnd: { width: 500, length: 500, concavity: 0 } });
  assert.deepEqual(live.subpaths.map((sp) => sp.points.map(pt)), old.subpaths.map((sp) => sp.points.map(pt)));
  assert.deepEqual(arrowPx({ width: 300, length: 400, concavity: 10 }, 2), { w: 6, l: 8, c: 10 });
  const a = shapePath('line', { x1: 0, y1: 0, x2: 100, y2: 0, weight: 2, arrowStart: null, arrowEnd: { width: 300, length: 400, concavity: 0 } });
  assert.equal(a.subpaths.length, 2);
  assert.deepEqual(bounds({ subpaths: [a.subpaths[1]] }), [92, -3, 100, 3]); // tip at the end, base 8 px back, 6 px wide
  assert.deepEqual(bounds({ subpaths: [a.subpaths[0]] }), [0, -1, 92.8, 1]); // the body stops 90 % into the head
  const c = shapePath('line', { x1: 0, y1: 0, x2: 100, y2: 0, weight: 2, arrowStart: null, arrowEnd: { width: 300, length: 400, concavity: 25 } });
  const head = c.subpaths[1].points.map(pt);
  assert.equal(head.length, 4);
  assert.ok(head.some(([x, y]) => x === 94 && y === 0)); // the notch: 75 % of the length from the tip
  assert.deepEqual(bounds({ subpaths: [c.subpaths[0]] }), [0, -1, 94.6, 1]); // 0.9 x 6 px from the tip
  // both ends
  const both = shapePath('line', { x1: 0, y1: 0, x2: 100, y2: 0, weight: 4, arrowStart: { width: 200, length: 200, concavity: 0 }, arrowEnd: { width: 200, length: 200, concavity: 0 } });
  assert.equal(both.subpaths.length, 3);
  assert.deepEqual(bounds(both), [0, -4, 100, 4]);
  // a line shorter than its head draws no head (0.3)
  assert.equal(shapePath('line', { x1: 0, y1: 0, x2: 5, y2: 0, weight: 2, arrowEnd: { width: 500, length: 500, concavity: 0 } }).subpaths.length, 1);
});

test('normalizeShapeProps: every row of the 0.3 reading table', () => {
  assert.deepEqual(normalizeShapeProps({ shapeKind: 'rect', shapeProps: { x: 1, y: 2, width: 30, height: 20, radius: 4 } }),
    { kind: 'rect', props: { x: 1, y: 2, width: 30, height: 20, angle: 0, radii: [4, 4, 4, 4] } });
  assert.deepEqual(normalizeShapeProps({ shapeKind: 'rect', shapeProps: { x: 1, y: 2, width: 30, height: 20, radius: 0 } }).props.radii, [0, 0, 0, 0]);
  assert.deepEqual(normalizeShapeProps({ shapeKind: 'ellipse', shapeProps: { x: 0, y: 0, width: 8, height: 6 } }),
    { kind: 'ellipse', props: { x: 0, y: 0, width: 8, height: 6, angle: 0 } });
  assert.deepEqual(normalizeShapeProps({ shapeKind: 'polygon', shapeProps: { x: 0, y: 0, width: 10, height: 10, sides: 6, star: true, inset: 30 } }).props,
    { x: 0, y: 0, width: 10, height: 10, angle: 0, sides: 6, starRatio: 70, smoothCorners: false, smoothIndents: false, cornerRadius: 0 });
  assert.equal(normalizeShapeProps({ shapeKind: 'polygon', shapeProps: { x: 0, y: 0, width: 10, height: 10, sides: 5, star: false, inset: 30 } }).props.starRatio, 100);
  assert.deepEqual(normalizeShapeProps({ shapeKind: 'line', shapeProps: { x1: 0, y1: 1, x2: 9, y2: 1, weight: 2, arrowStart: true, arrowEnd: false } }).props,
    { x1: 0, y1: 1, x2: 9, y2: 1, weight: 2, arrowStart: { width: 500, length: 500, concavity: 0 }, arrowEnd: null });
  for (const props of [{ custom: 'heart', x: 0, y: 0, width: 10, height: 10 }, { x: 0 }, {}]) assert.equal(normalizeShapeProps({ shapeKind: 'path', shapeProps: props }).kind, 'path');
  assert.equal(normalizeShapeProps({}).kind, 'path');
  // a 0.3 shape regenerates the path 0.3 drew for it
  assert.deepEqual(anchors(livePath('rect', { x: 1, y: 2, width: 30, height: 20, radius: 4 })), anchors(rectPath(1, 2, 30, 20, 4)));
  assert.deepEqual(anchors(livePath('polygon', { x: 0, y: 0, width: 10, height: 10, sides: 6, star: true, inset: 30 })), anchors(polygonPath(0, 0, 10, 10, 6, true, 30)));
  assert.equal(isLiveShape({ type: 'shape', shapeKind: 'rect', shapeProps: {} }), true);
  assert.equal(isLiveShape({ type: 'shape', shapeKind: 'path', shapeProps: { custom: 'heart' } }), false);
  assert.equal(isLiveShape({ type: 'raster' }), false);
});

const rectLayer = (props, extra = {}) => ({ shapeKind: 'rect', shapeProps: props, path: shapePath('rect', normalizeShapeProps({ shapeKind: 'rect', shapeProps: props }).props), ...extra });
const affine = (m) => (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

test('mapShapeGeometry: a translation shifts the stored numbers and the path', () => {
  const layer = rectLayer({ x: 10, y: 20, width: 50, height: 30, radius: 5 });
  const m = [1, 0, 0, 1, 7, -3];
  const g = mapShapeGeometry(layer, affine(m), { matrix: m });
  assert.equal(g.shapeKind, 'rect');
  assert.deepEqual(g.shapeProps, { x: 17, y: 17, width: 50, height: 30, radius: 5 }); // the 0.3 form is kept
  assert.deepEqual(anchors(g.path), anchors(rectPath(17, 17, 50, 30, 5)));
  assert.equal(layer.shapeProps.x, 10);
});

test('mapShapeGeometry: scale goes into the box and the radii, the path is regenerated', () => {
  const layer = rectLayer({ x: 10, y: 20, width: 50, height: 30, angle: 0, radii: [4, 0, 4, 0] });
  const m = [2, 0, 0, 3, 0, 0];
  const g = mapShapeGeometry(layer, affine(m), { matrix: m });
  assert.equal(g.shapeKind, 'rect');
  assert.deepEqual(g.shapeProps, { x: 20, y: 60, width: 100, height: 90, angle: 0, radii: [8, 0, 8, 0] });
  assert.deepEqual(anchors(g.path), anchors(shapePath('rect', g.shapeProps)));
  // a mirror swaps the rectangle's corners left and right
  const flip = [-1, 0, 0, 1, 100, 0];
  const f = mapShapeGeometry(layer, affine(flip), { matrix: flip });
  assert.equal(f.shapeKind, 'rect');
  assert.deepEqual(f.shapeProps.radii, [0, 4, 0, 4]);
  assert.deepEqual([f.shapeProps.x, f.shapeProps.width], [40, 50]);
  assert.equal(f.shapeProps.angle, 0);
  // the line's weight scales with the distance between its sides
  const line = { shapeKind: 'line', shapeProps: { x1: 0, y1: 0, x2: 10, y2: 0, weight: 2, arrowStart: false, arrowEnd: true }, path: linePath(0, 0, 10, 0, 2, false, true) };
  const lm = [3, 0, 0, 2, 1, 1];
  const lg = mapShapeGeometry(line, affine(lm), { matrix: lm });
  assert.equal(lg.shapeKind, 'line');
  assert.deepEqual([lg.shapeProps.x1, lg.shapeProps.y1, lg.shapeProps.x2, lg.shapeProps.y2, lg.shapeProps.weight], [1, 1, 31, 1, 4]);
  assert.deepEqual(lg.shapeProps.arrowEnd, { width: 500, length: 500, concavity: 0 });
});

test('mapShapeGeometry: rotation goes into angle about the mapped centre', () => {
  const layer = rectLayer({ x: 0, y: 0, width: 100, height: 40, angle: 0, radii: [6, 6, 6, 6] });
  // 90° about (50, 20)
  const [a, b, c, d] = rot(90);
  const m = [a, b, c, d, 50 - (a * 50 + c * 20), 20 - (b * 50 + d * 20)];
  const g = mapShapeGeometry(layer, affine(m), { matrix: m });
  assert.equal(g.shapeKind, 'rect');
  assert.deepEqual(g.shapeProps, { x: 0, y: 0, width: 100, height: 40, angle: 90, radii: [6, 6, 6, 6] });
  // the regenerated path is the mapped path
  const mapped = layer.path.subpaths[0].points.map((p) => affine(m)(p.x, p.y).map((v) => Math.round(v * 1e4) / 1e4));
  assert.deepEqual(anchors(g.path), mapped);
  // rotation then a uniform scale on an already rotated shape
  const m2 = [2 * rot(30)[0], 2 * rot(30)[1], 2 * rot(30)[2], 2 * rot(30)[3], 0, 0];
  const g2 = mapShapeGeometry({ ...layer, shapeProps: g.shapeProps, path: g.path }, affine(m2), { matrix: m2 });
  assert.equal(g2.shapeProps.angle, 120);
  assert.deepEqual([g2.shapeProps.width, g2.shapeProps.height, g2.shapeProps.radii[0]], [200, 80, 12]);
  // a polygon and an ellipse rotate too; a non-uniform scale of a rotated shape is a skew: a path
  const poly = { shapeKind: 'polygon', shapeProps: { x: 0, y: 0, width: 50, height: 50, sides: 5, star: false }, path: polygonPath(0, 0, 50, 50, 5) };
  assert.equal(mapShapeGeometry(poly, affine(m), { matrix: m }).shapeKind, 'polygon');
  const skewed = mapShapeGeometry({ ...layer, shapeProps: g.shapeProps, path: g.path }, affine([1, 0, 0, 2, 0, 0]), { matrix: [1, 0, 0, 2, 0, 0] });
  assert.equal(skewed.shapeKind, 'rect'); // 90° rotated rect, axis scale: still a rectangle (width scales by 2)
  const g45 = mapShapeGeometry({ ...layer, shapeProps: { ...g.shapeProps, angle: 45 }, path: g.path }, affine([1, 0, 0, 2, 0, 0]), { matrix: [1, 0, 0, 2, 0, 0] });
  assert.equal(g45.shapeKind, 'path');
});

test('mapShapeGeometry: skew and perspective turn a live shape into a path', () => {
  const layer = rectLayer({ x: 0, y: 0, width: 100, height: 40, angle: 0, radii: [0, 0, 0, 0] });
  const skew = [1, 0, 0.5, 1, 0, 0];
  const s = mapShapeGeometry(layer, affine(skew), { matrix: skew });
  assert.equal(s.shapeKind, 'path');
  assert.deepEqual(anchors(s.path), [[0, 0], [100, 0], [120, 40], [20, 40]]);
  // a homography: fitted on the path's corners; perspective is not affine
  const persp = (x, y) => [x / (1 + y / 200), y / (1 + y / 200)];
  assert.equal(mapShapeGeometry(layer, persp, { homography: [1, 0, 0, 0, 1, 0, 0, 1 / 200, 1] }).shapeKind, 'path');
  // a homography that is affine keeps the shape live
  const scale = (x, y) => [x * 2, y * 2];
  const h = mapShapeGeometry(layer, scale, { homography: [2, 0, 0, 0, 2, 0, 0, 0, 1] });
  assert.equal(h.shapeKind, 'rect');
  assert.equal(h.shapeProps.width, 200);
  assert.deepEqual(fitAffine(scale, { x: 0, y: 0, width: 10, height: 10 }), [2, 0, 0, 2, 0, 0]);
  assert.equal(fitAffine(persp, { x: 0, y: 0, width: 100, height: 100 }), null);
  // a mirrored custom shape is a path (custom shapes are not symmetric)
  const custom = { shapeKind: 'custom', shapeProps: { x: 0, y: 0, width: 10, height: 10, angle: 0, shape: 'heart' }, path: customPath('heart', 0, 0, 10, 10) };
  assert.equal(mapShapeGeometry(custom, affine([-1, 0, 0, 1, 10, 0]), { matrix: [-1, 0, 0, 1, 10, 0] }).shapeKind, 'path');
  const cs = mapShapeGeometry(custom, affine([2, 0, 0, 2, 0, 0]), { matrix: [2, 0, 0, 2, 0, 0] });
  assert.equal(cs.shapeKind, 'custom');
  assert.equal(cs.shapeProps.width, 20);
  // mapLiveProps refuses a collapse to zero size
  assert.equal(mapLiveProps('ellipse', { x: 0, y: 0, width: 10, height: 10, angle: 0 }, [0, 0, 0, 1, 0, 0]), null);
});

test('regenerateShape: patching the parameters rebuilds the path; a reshaped path is not live', () => {
  const layer = rectLayer({ x: 0, y: 0, width: 40, height: 40, radius: 0 });
  const r = regenerateShape(layer, { radii: [10, 10, 10, 10] });
  assert.equal(r.shapeKind, 'rect');
  assert.deepEqual(anchors(r.path), anchors(rectPath(0, 0, 40, 40, 10)));
  assert.equal(regenerateShape({ shapeKind: 'path', path: layer.path }), null);
});

test('shapeBounds pads for the stroke alignment, miters and caps; dashes are in stroke widths', () => {
  const path = rectPath(10, 10, 100, 50);
  const b = (stroke) => shapeBounds({ path, stroke });
  assert.deepEqual(b(null), { x: 9, y: 9, width: 103, height: 53 });
  assert.deepEqual(b({ width: 10, align: 'inside', join: 'round' }), { x: 9, y: 9, width: 103, height: 53 });
  assert.deepEqual(b({ width: 10, align: 'center', join: 'round' }), { x: 4, y: 4, width: 113, height: 63 });
  assert.deepEqual(b({ width: 10, align: 'outside', join: 'round' }), { x: -1, y: -1, width: 123, height: 73 });
  assert.equal(strokeReach({ width: 10, align: 'center', join: 'miter', miterLimit: 4 }), 20);
  assert.equal(strokeReach({ width: 10, align: 'center', join: 'bevel', cap: 'square' }), 5 * Math.SQRT2);
  assert.equal(strokeReach({ width: 0 }), 0);
  assert.equal(shapeBounds({ path, stroke: { width: 10, paint: null } }).x, 9); // a stroke without paint draws nothing
  assert.deepEqual(dashPattern({ width: 4, dash: [4, 2] }), [16, 8]);
  assert.deepEqual(dashPattern({ width: 4, dash: [] }), []);
  assert.deepEqual(dashPattern({ width: 4, dash: [0, 2], cap: 'round' }), [0.001, 8]);
  assert.equal(shapeBounds({ path: { subpaths: [] } }), null);
});

test('shapeContentBounds is the drawn box (path plus the stroke outside it), without the render padding', () => {
  // hunt5 canvas-vector: Align, Free Transform, quick Rotate/Flip and Reveal All used the padded shapeBounds, so a
  // shape aligned 1 to 2 px off and every rotate or flip moved it by a pixel
  const path = rectPath(50, 50, 150, 100);
  assert.deepEqual(shapeContentBounds({ path }), { x: 50, y: 50, width: 150, height: 100 });
  assert.deepEqual(shapeBounds({ path }), { x: 49, y: 49, width: 153, height: 103 }); // the render box stays padded
  const b = (stroke) => shapeContentBounds({ path, stroke });
  assert.deepEqual(b({ width: 4, color: '#000', align: 'center' }), { x: 48, y: 48, width: 154, height: 104 });
  assert.deepEqual(b({ width: 4, color: '#000', align: 'outside', join: 'miter', miterLimit: 10 }), { x: 46, y: 46, width: 158, height: 108 });
  assert.deepEqual(b({ width: 4, color: '#000', align: 'inside' }), { x: 50, y: 50, width: 150, height: 100 });
  assert.deepEqual(b({ width: 4, paint: null }), { x: 50, y: 50, width: 150, height: 100 }); // no stroke drawn
  // fractional geometry stays fractional, so the centre (the quick Rotate/Flip pivot) is the shape's own centre
  assert.deepEqual(shapeContentBounds({ path: rectPath(10.5, 20.25, 30, 40) }), { x: 10.5, y: 20.25, width: 30, height: 40 });
  assert.equal(shapeContentBounds({ path: { subpaths: [] } }), null);
});
