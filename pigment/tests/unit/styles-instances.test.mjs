// Layer styles 0.4 skeleton (J.6): instances, hidden, helpers, applyStyles options, splitEffects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_STYLES, mergeStyles, hasEnabledStyles, stylePadding, applyStyles, effectInstances, effectEntries,
  setEffect, mapEffects, scaleEffects, splitEffects, STYLE_FEATURES, INSTANCE_KEYS,
} from '../../src/shared/pixels/styles.js';
import { createImage, setPixel, getPixel } from '../../src/shared/pixels/core.js';

function square(size = 16, x0 = 6, side = 4) {
  const img = createImage(size, size);
  for (let y = x0; y < x0 + side; y++) for (let x = x0; x < x0 + side; x++) setPixel(img, x, y, [255, 0, 0, 1]);
  return img;
}

const shadowA = { enabled: true, size: 4, distance: 3, color: '#000000' };
const shadowB = { enabled: true, size: 8, distance: 6, color: '#0000ff' };

test('STYLE_FEATURES says nothing beyond 0.3 is real yet; the instance keys', () => {
  assert.deepEqual(STYLE_FEATURES, { instances: false, interiorAsGroup: false, transparencyShapes: false, split: false });
  assert.deepEqual(INSTANCE_KEYS, ['dropShadow', 'innerShadow', 'colorOverlay', 'gradientOverlay', 'stroke']);
});

test('hasEnabledStyles honours arrays and hidden', () => {
  assert.equal(hasEnabledStyles({ dropShadow: [{ enabled: false }, { enabled: true }] }), true);
  assert.equal(hasEnabledStyles({ dropShadow: [{ enabled: false }, { enabled: false }] }), false);
  assert.equal(hasEnabledStyles({ dropShadow: [] }), false);
  assert.equal(hasEnabledStyles({ dropShadow: { enabled: true }, hidden: true }), false);
  assert.equal(hasEnabledStyles({ dropShadow: { enabled: true }, hidden: false }), true);
});

test('mergeStyles keeps hidden and two shadows as an array merged with defaults', () => {
  const m = mergeStyles({ dropShadow: [shadowA, shadowB], hidden: true });
  assert.equal(m.hidden, true);
  assert.ok(Array.isArray(m.dropShadow));
  assert.equal(m.dropShadow.length, 2);
  assert.deepEqual(m.dropShadow[0], { ...DEFAULT_STYLES.dropShadow, ...shadowA });
  assert.deepEqual(m.dropShadow[1], { ...DEFAULT_STYLES.dropShadow, ...shadowB });
  assert.deepEqual(Object.keys(m.dropShadow[0]), Object.keys(DEFAULT_STYLES.dropShadow));
  // never an object with keys '0' and '1'
  assert.ok(!('0' in m.dropShadow[0]));
  assert.deepEqual(mergeStyles(m), m);
  // no hidden in, no hidden out (0.3's key list)
  assert.deepEqual(Object.keys(mergeStyles({})), Object.keys(DEFAULT_STYLES));
  // an array on a key that has no instances reads its first element
  assert.equal(mergeStyles({ bevel: [{ enabled: true, size: 9 }] }).bevel.size, 9);
  // an empty array is the default object
  assert.deepEqual(mergeStyles({ stroke: [] }).stroke, DEFAULT_STYLES.stroke);
  // at most ten instances
  assert.equal(mergeStyles({ stroke: new Array(12).fill({ enabled: true }) }).stroke.length, 10);
});

test('effectInstances, effectEntries, setEffect, mapEffects', () => {
  const st = { dropShadow: [shadowA, shadowB], stroke: { enabled: true, size: 2 }, hidden: false };
  assert.deepEqual(effectInstances(st, 'dropShadow'), [shadowA, shadowB]);
  assert.deepEqual(effectInstances(st, 'stroke'), [st.stroke]);
  assert.deepEqual(effectInstances(st, 'satin'), []);
  assert.deepEqual(effectEntries(st).map((e) => [e.key, e.index, e.name]), [['dropShadow', 0, 'Drop Shadow'], ['dropShadow', 1, 'Drop Shadow'], ['stroke', 0, 'Stroke']]);
  const one = setEffect(st, 'dropShadow', 1, null);
  assert.deepEqual(one.dropShadow, shadowA, 'one instance is written as an object');
  const none = setEffect(one, 'dropShadow', 0, null);
  assert.ok(!('dropShadow' in none));
  const three = setEffect(st, 'dropShadow', 2, { enabled: true, size: 1 });
  assert.equal(three.dropShadow.length, 3);
  const patched = setEffect(st, 'stroke', 0, { size: 5 });
  assert.deepEqual(patched.stroke, { enabled: true, size: 5 });
  assert.equal(st.stroke.size, 2, 'input untouched');
  assert.equal(patched.hidden, false);
  const off = mapEffects(st, (fx) => ({ ...fx, enabled: false }));
  assert.equal(hasEnabledStyles(off), false);
  assert.ok(Array.isArray(off.dropShadow));
  assert.equal(off.hidden, false);
});

test('scaleEffects scales every instance\'s pixel fields, pattern and texture scale', () => {
  const st = {
    dropShadow: [shadowA, shadowB],
    innerGlow: { enabled: true, size: 6, choke: 2 },
    bevel: { enabled: true, size: 10, soften: 2, texture: { enabled: true, scale: 1 } },
    patternOverlay: { enabled: true, scale: 0.5 },
    stroke: { enabled: true, size: 3 },
    gradientOverlay: { enabled: true, scale: 1 },
    hidden: true,
  };
  const k = scaleEffects(st, 0.5);
  assert.deepEqual(k.dropShadow.map((s) => [s.size, s.distance]), [[2, 1.5], [4, 3]]);
  assert.deepEqual([k.innerGlow.size, k.innerGlow.choke], [3, 1]);
  assert.deepEqual([k.bevel.size, k.bevel.soften, k.bevel.texture.scale], [5, 1, 0.5]);
  assert.equal(k.patternOverlay.scale, 0.25);
  assert.equal(k.stroke.size, 1.5);
  assert.equal(k.gradientOverlay.scale, 1, 'a gradient scale is relative to the layer');
  assert.equal(k.hidden, true);
  assert.equal(st.dropShadow[0].size, 4, 'input untouched');
  // through mergeStyles too
  const merged = scaleEffects(mergeStyles({ dropShadow: [shadowA, shadowB] }), 2);
  assert.deepEqual(merged.dropShadow.map((s) => s.size), [8, 16]);
});

test('stylePadding and applyStyles draw the first enabled instance and nothing while hidden', () => {
  const img = square();
  const arr = { dropShadow: [{ ...shadowA, enabled: false }, shadowB, shadowA] };
  assert.equal(stylePadding(arr), stylePadding({ dropShadow: shadowB }));
  const a = applyStyles(img, arr);
  const b = applyStyles(img, { dropShadow: shadowB });
  assert.deepEqual(a.image.data, b.image.data);
  assert.equal(stylePadding({ dropShadow: shadowB, hidden: true }), 0);
  const h = applyStyles(img, { dropShadow: shadowB, hidden: true });
  const plain = applyStyles(img, null);
  assert.deepEqual(h.image.data, plain.image.data);
  assert.deepEqual([h.offsetX, h.offsetY], [0, 0]);
});

test('applyStyles accepts the 0.4 option names; split returns the merged image as the layer', () => {
  const img = square();
  const st = { dropShadow: shadowB, colorOverlay: { enabled: true, color: '#00ff00' } };
  const base = applyStyles(img, st);
  const withOpts = applyStyles(img, st, { interiorAsGroup: true, transparencyShapes: false });
  assert.deepEqual(withOpts.image.data, base.image.data);
  const split = applyStyles(img, st, { split: true });
  assert.equal(split.below, null);
  assert.equal(split.above, null);
  assert.deepEqual(split.layer.data, base.image.data);
  assert.deepEqual([split.offsetX, split.offsetY], [base.offsetX, base.offsetY]);
});

test('splitEffects: exterior below (bottom instance first), interior clipped above, in stacking order', () => {
  const img = square();
  const st = {
    dropShadow: [shadowA, { ...shadowB, opacity: 0.4, blend: 'multiply' }],
    outerGlow: { enabled: true },
    colorOverlay: { enabled: true, color: '#00ff00', blend: 'screen' },
    innerShadow: { enabled: true },
    stroke: [{ enabled: true, position: 'inside', size: 1 }, { enabled: true, position: 'outside', size: 2 }],
    satin: { enabled: false },
  };
  const parts = splitEffects(img, st);
  assert.deepEqual(parts.map((p) => [p.key, p.index, p.clip]), [
    ['dropShadow', 1, false], ['dropShadow', 0, false], ['outerGlow', 0, false], ['stroke', 1, false],
    ['colorOverlay', 0, true], ['innerShadow', 0, true], ['stroke', 0, true],
  ]);
  const ds = parts[0];
  assert.equal(ds.blend, 'multiply');
  assert.equal(ds.opacity, 0.4);
  // an exterior effect alone equals applyStyles with only that effect at full opacity on a zero fill
  const ref = applyStyles(img, { dropShadow: { ...shadowB, opacity: 1, blend: 'normal' } }, { fillOpacity: 0 });
  assert.deepEqual(ds.image.data, ref.image.data);
  assert.deepEqual([ds.x, ds.y], [ref.offsetX, ref.offsetY]);
  // the overlay is clipped to the layer and holds its colour
  const co = parts.find((p) => p.key === 'colorOverlay');
  const at = (p, x, y) => getPixel(p.image, x - p.x, y - p.y);
  assert.deepEqual(at(co, 7, 7).slice(0, 3), [0, 255, 0]);
  assert.equal(at(co, 1, 1)[3], 0);
  assert.deepEqual(splitEffects(img, { ...st, hidden: true }), []);
  assert.deepEqual(splitEffects(img, null), []);
});

test('Gradient Overlay reads a v2 gradient def when the effect has one', () => {
  const img = square();
  const v03 = applyStyles(img, { gradientOverlay: { enabled: true, angle: 0, stops: [{ pos: 0, color: '#ff0000' }, { pos: 1, color: '#0000ff' }] } });
  const v2 = applyStyles(img, {
    gradientOverlay: {
      enabled: true, angle: 0,
      gradient: { gradientVersion: 2, type: 'solid', interpolation: 'classic', smoothness: 0, stops: [{ pos: 0, mid: 0.5, color: '#ff0000' }, { pos: 1, mid: 0.5, color: '#0000ff' }], opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 1 }] },
    },
  });
  assert.deepEqual(v2.image.data, v03.image.data);
});
