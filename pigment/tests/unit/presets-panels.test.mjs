// presets-panels (ARCHITECTURE.md "0.5 features", package 9): the pure helpers of lib/presets-panels-model.js and
// the kinds' data through the preset store (S10.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  unitShape, curveBounds, normalizeShapeData, definedShapeSize, dropShapeBox, stylePatternRefs, normalizeStyleData,
  resolveStyle, addStyle, enabledEffects, capturedOptions, nextPresetName, visibleToolPresets, sortedByTool, isPathValue,
} from '../../src/renderer/lib/presets-panels-model.js';

const square = (x, y, w, h) => ({ subpaths: [{ closed: true, points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] }] });

test('unitShape: a path in px becomes a 0..1 outline stretched to its box, with its px size kept', () => {
  const s = unitShape(square(40, 20, 200, 50));
  assert.deepEqual(s.path.subpaths[0].points, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);
  assert.equal(s.width, 200);
  assert.equal(s.height, 50);
  assert.equal(s.path.subpaths[0].closed, true);
  // a subpath's own keys (its path operation) are kept
  const withOp = unitShape({ subpaths: [{ ...square(0, 0, 10, 10).subpaths[0], op: 'subtract' }] });
  assert.equal(withOp.path.subpaths[0].op, 'subtract');
  // nothing to fill: a point, a horizontal line, no subpaths, not a path
  assert.equal(unitShape({ subpaths: [{ closed: false, points: [{ x: 1, y: 1 }] }] }), null);
  assert.equal(unitShape({ subpaths: [{ closed: false, points: [{ x: 0, y: 5 }, { x: 10, y: 5 }] }] }), null);
  assert.equal(unitShape({ subpaths: [] }), null);
  assert.equal(unitShape({ subpaths: [{ points: [{ x: 'a', y: 0 }] }] }), null);
});

test('curveBounds: the drawn outline, not the control points (a circle of four curves)', () => {
  // a circle of radius 50 at (100, 100) with handles at k = 0.5523: the handles reach the bounds, a bulging curve beyond
  const k = 50 * 0.5523;
  const circle = { subpaths: [{ closed: true, points: [
    { x: 150, y: 100, inX: 150, inY: 100 - k, outX: 150, outY: 100 + k },
    { x: 100, y: 150, inX: 100 + k, inY: 150, outX: 100 - k, outY: 150 },
    { x: 50, y: 100, inX: 50, inY: 100 + k, outX: 50, outY: 100 - k },
    { x: 100, y: 50, inX: 100 - k, inY: 50, outX: 100 + k, outY: 50 },
  ] }] };
  const b = curveBounds(circle);
  assert.ok(Math.abs(b.x - 50) < 1e-6 && Math.abs(b.width - 100) < 1e-6);
  // handles that overshoot: an arch whose control points rise to y = -100 peaks at y = -75
  const arch = { subpaths: [{ closed: false, points: [{ x: 0, y: 0, outX: 0, outY: -100 }, { x: 100, y: 0, inX: 100, inY: -100 }] }] };
  const ab = curveBounds(arch);
  assert.ok(Math.abs(ab.y + 75) < 1e-9, `top ${ab.y}`);
  assert.equal(ab.height, 75);
  const u = unitShape(arch);
  assert.equal(u.height, 75);
  // the anchors at the bottom, the handles above the box's top (Photoshop keeps the curve, not the handles, in the box)
  assert.deepEqual(u.path.subpaths[0].points[0], { x: 0, y: 1, outX: 0, outY: -0.33333 });
});

test('shapes data: 0.4 { path } and .csh width / height kept; Defined Size and the drop box', () => {
  const path = square(0, 0, 1, 1);
  assert.deepEqual(normalizeShapeData({ path }), { path });
  assert.deepEqual(normalizeShapeData({ path, width: 30, height: 10 }), { path, width: 30, height: 10 });
  assert.deepEqual(normalizeShapeData({ path, width: -1, height: 'x' }), { path });
  assert.equal(normalizeShapeData({ path: { subpaths: 'no' } }), null);
  assert.equal(normalizeShapeData(null), null);
  assert.equal(isPathValue(path), true);
  assert.deepEqual(definedShapeSize({ path, width: 30, height: 10 }), [30, 10]);
  assert.deepEqual(definedShapeSize({ path }), [100, 100]); // 0.4's 100 px per unit
  // a drop on a 400 x 300 document: the longer side 75 px, the shape's proportions, centred on the drop point
  assert.deepEqual(dropShapeBox({ path, width: 30, height: 10 }, { x: 200, y: 150 }, { width: 400, height: 300 }), { x: 163, y: 138, width: 75, height: 25 });
});

test('styles data: pattern references keep { presetId, name } in the store; a reference without a preset keeps its pixels', () => {
  const data = {
    styles: {
      patternOverlay: { enabled: true, pattern: { presetId: 'p1', name: 'Rust', dataUrl: 'data:image/png;base64,AAAA' } },
      bevel: { enabled: true, texture: { enabled: true, pattern: { name: 'Own', dataUrl: 'data:image/png;base64,BBBB' } } },
      stroke: [{ enabled: true, fill: 'pattern', pattern: { presetId: 'p2', name: 'Burlap' } }, { enabled: true, size: 2 }],
    },
    blending: { knockout: 'shallow' },
    opacity: 0.5,
  };
  const n = normalizeStyleData(data);
  assert.deepEqual(n.styles.patternOverlay.pattern, { presetId: 'p1', name: 'Rust' });
  assert.equal(n.styles.bevel.texture.pattern.dataUrl, 'data:image/png;base64,BBBB');
  assert.deepEqual(n.blending, { knockout: 'shallow' });
  assert.equal(n.opacity, 0.5);
  assert.equal(normalizeStyleData({ styles: 3 }), null);
  assert.equal(normalizeStyleData({ styles: {}, opacity: 7 }).opacity, undefined);
  // the owners: the overlay, the bevel's Texture (not the whole bevel), the first stroke instance
  const refs = stylePatternRefs(n.styles);
  assert.equal(refs.length, 3);
  assert.equal(refs[0].owner, n.styles.patternOverlay);
  assert.equal(refs[1].owner, n.styles.bevel.texture);
  assert.equal(refs[2].owner, n.styles.stroke[0]);
});

test('resolveStyle: references get their pixels; a missing pattern turns its effect off, named once', () => {
  const styles = {
    patternOverlay: { enabled: true, pattern: { presetId: 'p1', name: 'Rust' } },
    stroke: [{ enabled: true, fill: 'pattern', pattern: { presetId: 'gone', name: 'Gone' } }, { enabled: true, fill: 'pattern', pattern: { presetId: 'gone', name: 'Gone' } }],
    bevel: { enabled: true, texture: { enabled: true, pattern: { name: 'Own', dataUrl: 'data:x' } } },
  };
  const resolved = new Map([['p1', { presetId: 'p1', name: 'Rust', dataUrl: 'data:rust' }], ['gone', null]]);
  const r = resolveStyle(styles, resolved);
  assert.deepEqual(r.styles.patternOverlay.pattern, { presetId: 'p1', name: 'Rust', dataUrl: 'data:rust' });
  assert.equal(r.styles.stroke[0].enabled, false);
  assert.equal(r.styles.stroke[1].enabled, false);
  assert.equal(r.styles.bevel.enabled, true);
  assert.equal(r.styles.bevel.texture.enabled, true);
  assert.deepEqual(r.missing, ['Gone']);
  // the input is not changed
  assert.equal(styles.stroke[0].enabled, true);
  assert.equal(styles.patternOverlay.pattern.dataUrl, undefined);
});

test('addStyle: the keys a style turns on replace the layer\'s; the others stay', () => {
  const layer = { dropShadow: { enabled: true, distance: 5 }, stroke: { enabled: true, size: 1 }, hidden: true };
  const style = { stroke: [{ enabled: true, size: 4 }, { enabled: true, size: 8 }], colorOverlay: { enabled: false } };
  assert.deepEqual(addStyle(layer, style), { dropShadow: { enabled: true, distance: 5 }, stroke: [{ enabled: true, size: 4 }, { enabled: true, size: 8 }] });
  assert.deepEqual(enabledEffects(style), ['stroke']);
  assert.deepEqual(addStyle(null, { dropShadow: { enabled: true } }), { dropShadow: { enabled: true } });
});

test('tool presets: every shown option at its value, never `brush`; names; Current Tool Only; Sort by Tool', () => {
  const specs = [{ key: 'size', kind: 'slider', default: 24 }, { key: 'mode', kind: 'select', default: 'normal' }, { key: 'go', kind: 'button' }, { key: 'brush', kind: 'brush' }];
  const stored = { size: 40, brush: { tip: {} }, brushPresetId: 'soft', smoothingOptions: { mode: 'average' } };
  const opt = (k) => (k in stored ? stored[k] : specs.find((s) => s.key === k)?.default);
  assert.deepEqual(capturedOptions(specs, stored, opt), { size: 40, mode: 'normal', brushPresetId: 'soft', smoothingOptions: { mode: 'average' } });
  assert.equal(nextPresetName('Brush Tool', ['Brush Tool 1', 'Brush Tool 3']), 'Brush Tool 2');
  const list = [{ id: 'a', data: { tool: 'eraser' } }, { id: 'b', data: { tool: 'brush' } }, { id: 'c', data: { tool: 'nope' } }, { id: 'd', data: { tool: 'brush' } }];
  assert.deepEqual(visibleToolPresets(list, 'brush', true).map((p) => p.id), ['b', 'd']);
  assert.deepEqual(visibleToolPresets(list, 'brush', false).map((p) => p.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(sortedByTool(list, ['move', 'brush', 'eraser']), ['b', 'd', 'a', 'c']);
});
