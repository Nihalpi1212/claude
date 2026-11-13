// 0.4 skeleton, step 4: the new layer fields (J.1) and the shape reading / mapping stubs (J.5) of path-ops.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Layer, DEFAULT_BLENDING, DEFAULT_VECTOR_MASK, isDefaultBlending, effectiveBlending } from '../../src/renderer/lib/document.js';
import { normalizeShapeProps, mapShapeGeometry, mapPathPoints } from '../../src/renderer/lib/path-ops.js';

test('blending defaults: null and partial objects equal to the defaults are default', () => {
  assert.ok(Object.isFrozen(DEFAULT_BLENDING) && Object.isFrozen(DEFAULT_BLENDING.blendIf.gray.this));
  assert.equal(isDefaultBlending(null), true);
  assert.equal(isDefaultBlending({}), true);
  assert.equal(isDefaultBlending({ knockout: 'none', channels: { r: true } }), true);
  assert.equal(isDefaultBlending({ channels: { g: false } }), false);
  assert.equal(isDefaultBlending({ blendIf: { gray: { this: [0, 0, 200, 255] } } }), false);
  assert.equal(isDefaultBlending({ interiorAsGroup: true }), false);
  assert.deepEqual(DEFAULT_BLENDING.blendIf.r, { this: [0, 0, 255, 255], under: [0, 0, 255, 255] });
});

test('effectiveBlending fills every field and never returns the stored object', () => {
  assert.equal(effectiveBlending({ blending: null }), DEFAULT_BLENDING);
  const layer = { blending: { knockout: 'deep', blendIf: { b: { under: [10, 20, 200, 255] } } } };
  const e = effectiveBlending(layer);
  assert.equal(e.knockout, 'deep');
  assert.deepEqual(e.channels, { r: true, g: true, b: true });
  assert.deepEqual(e.blendIf.b, { this: [0, 0, 255, 255], under: [10, 20, 200, 255] });
  assert.deepEqual(e.blendIf.gray, { this: [0, 0, 255, 255], under: [0, 0, 255, 255] });
  assert.equal(e.transparencyShapes, true);
  e.knockout = 'none';
  assert.equal(layer.blending.knockout, 'deep');
});

test('Layer takes vectorMask and blending; describe writes them and mask density / feather only when set', () => {
  const plain = new Layer('raster', { name: 'A' });
  assert.equal(plain.vectorMask, null);
  assert.equal(plain.blending, null);
  const d0 = plain.describe();
  assert.equal(d0.vectorMask, null);
  assert.equal(d0.blending, null);
  assert.ok(!('maskDensity' in d0) && !('maskFeather' in d0));

  const path = { subpaths: [{ closed: true, points: [{ x: 1, y: 2 }, { x: 5, y: 2 }, { x: 5, y: 9 }] }] };
  const l = new Layer('raster', { vectorMask: { path, initialFill: 'reveal' }, blending: { knockout: 'shallow' } });
  assert.deepEqual(l.vectorMask, { ...DEFAULT_VECTOR_MASK, path, initialFill: 'reveal' });
  assert.notEqual(l.vectorMask.path, path); // a copy
  l.mask = { canvas: null, enabled: true, linked: true, density: 0.5, feather: 3 };
  const d = l.describe();
  assert.deepEqual(d.vectorMask, l.vectorMask);
  assert.notEqual(d.vectorMask, l.vectorMask);
  assert.deepEqual(d.blending, { knockout: 'shallow' });
  assert.equal(d.maskDensity, 0.5);
  assert.equal(d.maskFeather, 3);
  // a blending object that equals the defaults is described as null
  l.blending = { channels: { r: true, g: true, b: true } };
  assert.equal(l.describe().blending, null);
  // round trip through the description (what layerFromDescription does)
  const back = new Layer('raster', JSON.parse(JSON.stringify(d)));
  assert.deepEqual(back.vectorMask, l.vectorMask);
  assert.deepEqual(back.blending, { knockout: 'shallow' });
});

test('normalizeShapeProps reads every 0.3 shape (J.5 table)', () => {
  assert.deepEqual(normalizeShapeProps({ shapeKind: 'rect', shapeProps: { x: 1, y: 2, width: 30, height: 20, radius: 4 } }),
    { kind: 'rect', props: { x: 1, y: 2, width: 30, height: 20, angle: 0, radii: [4, 4, 4, 4] } });
  assert.deepEqual(normalizeShapeProps({ shapeKind: 'ellipse', shapeProps: { x: 0, y: 0, width: 8, height: 6 } }),
    { kind: 'ellipse', props: { x: 0, y: 0, width: 8, height: 6, angle: 0 } });
  const star = normalizeShapeProps({ shapeKind: 'polygon', shapeProps: { x: 0, y: 0, width: 10, height: 10, sides: 6, star: true, inset: 30 } });
  assert.deepEqual(star, { kind: 'polygon', props: { x: 0, y: 0, width: 10, height: 10, angle: 0, sides: 6, starRatio: 70, smoothCorners: false, smoothIndents: false, cornerRadius: 0 } });
  assert.equal(normalizeShapeProps({ shapeKind: 'polygon', shapeProps: { sides: 5, star: false, inset: 30 } }).props.starRatio, 100);
  assert.deepEqual(normalizeShapeProps({ shapeKind: 'line', shapeProps: { x1: 0, y1: 1, x2: 9, y2: 1, weight: 2, arrowStart: true, arrowEnd: false } }),
    { kind: 'line', props: { x1: 0, y1: 1, x2: 9, y2: 1, weight: 2, arrowStart: { width: 500, length: 500, concavity: 0 }, arrowEnd: null } });
  assert.equal(normalizeShapeProps({ shapeKind: 'path', shapeProps: { custom: 'heart' } }).kind, 'path');
  assert.equal(normalizeShapeProps({}).kind, 'path');
  // 0.4 values pass through
  assert.deepEqual(normalizeShapeProps({ shapeKind: 'rect', shapeProps: { x: 0, y: 0, width: 1, height: 1, angle: 30, radii: [1, 2, 3, 4] } }).props.radii, [1, 2, 3, 4]);
});

test('mapShapeGeometry stub: path mapped, props shifted only by a translation, document-space paints mapped', () => {
  const layer = {
    shapeKind: 'rect',
    shapeProps: { x: 10, y: 20, width: 5, height: 5, radius: 0 },
    path: { subpaths: [{ closed: true, points: [{ x: 10, y: 20, outX: 11, outY: 20 }, { x: 15, y: 20 }, { x: 15, y: 25, inX: 15, inY: 24 }] }] },
    fill: { type: 'gradient', gradient: { kind: 'linear', from: [0, 0], to: [10, 0] } },
    stroke: { width: 2, paint: { type: 'solid', color: '#000000' } },
  };
  const move = mapShapeGeometry(layer, (x, y) => [x + 3, y - 2], { matrix: [1, 0, 0, 1, 3, -2] });
  assert.deepEqual(move.shapeProps, { x: 13, y: 18, width: 5, height: 5, radius: 0 });
  assert.equal(move.shapeKind, 'rect');
  assert.deepEqual(move.path.subpaths[0].points[0], { x: 13, y: 18, outX: 14, outY: 18 });
  assert.deepEqual(move.path.subpaths[0].points[2], { x: 18, y: 23, inX: 18, inY: 22 });
  assert.deepEqual(move.fill.gradient.from, [3, -2]);
  assert.equal(move.stroke, undefined); // a solid stroke has nothing to map
  assert.deepEqual(layer.shapeProps.x, 10); // the input is not changed
  const scale = mapShapeGeometry(layer, (x, y) => [x * 2, y * 2], { matrix: [2, 0, 0, 2, 0, 0] });
  assert.deepEqual(scale.shapeProps, layer.shapeProps); // 0.3: display only
  assert.notEqual(scale.shapeProps, layer.shapeProps);
  assert.deepEqual(scale.path.subpaths[0].points[1], { x: 30, y: 40 });
  assert.deepEqual(mapPathPoints({ subpaths: [] }, (x, y) => [x, y]), { subpaths: [] });
});
