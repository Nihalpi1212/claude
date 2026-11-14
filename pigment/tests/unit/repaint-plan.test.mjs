// build-repaint-speed: what a repaint of the view must redo (src/renderer/lib/repaint-plan.js). The compositor's
// equality with a fresh composite is checked in the browser (tests/e2e/repaint-speed.spec.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL, diffPlans, samePrefix, unionRect, intersectRect, outerRect } from '../../src/renderer/lib/repaint-plan.js';

const unit = (id, box, extra = {}) => ({ id, pkey: `p${id}`, vkey: `v${id}`, box, ...extra });
const plan = (units, global = 'g') => ({ global, units });
const box = (x, y, width, height) => ({ x, y, width, height });

test('nothing that draws changed: the last composite stands', () => {
  const a = plan([unit('a', box(0, 0, 10, 10)), unit('b', ALL)]);
  const b = plan([unit('a', box(0, 0, 10, 10)), unit('b', ALL)]);
  assert.deepEqual(diffPlans(a, b), { kind: 'same' });
});

test('no earlier composite, or a document-wide change (size, mode, global light): everything is redrawn', () => {
  const b = plan([unit('a', box(0, 0, 10, 10))]);
  assert.deepEqual(diffPlans(null, b), { kind: 'full', from: 0 });
  assert.deepEqual(diffPlans(plan(b.units, 'other'), b), { kind: 'full', from: 0 });
});

test('a changed layer repaints the union of its old and new boxes, and names the lowest changed unit', () => {
  const a = plan([unit('bg', box(0, 0, 100, 100)), unit('t', box(10, 10, 20, 20)), unit('s', box(60, 60, 10, 10))]);
  const b = plan([a.units[0], { ...a.units[1], pkey: 'moved', box: box(30, 10, 20, 20) }, a.units[2]]);
  assert.deepEqual(diffPlans(a, b), { kind: 'region', rect: box(10, 10, 40, 20), from: 1 });
  // two changed units: one region holding both
  const c = plan([a.units[0], { ...a.units[1], vkey: 'touched' }, { ...a.units[2], pkey: 'x' }]);
  assert.deepEqual(diffPlans(a, c), { kind: 'region', rect: box(10, 10, 60, 60), from: 1 });
});

test('a change to an adjustment layer (or a group holding one) is not confined: full from that unit', () => {
  const a = plan([unit('bg', box(0, 0, 100, 100)), unit('adj', ALL), unit('t', box(0, 0, 5, 5))]);
  const b = plan([a.units[0], { ...a.units[1], pkey: 'curve moved' }, a.units[2]]);
  assert.deepEqual(diffPlans(a, b), { kind: 'full', from: 1 });
  // a layer that becomes an "ALL" unit (a group that now holds an adjustment) too
  const c = plan([a.units[0], a.units[1], { ...a.units[2], pkey: 'q', box: ALL }]);
  assert.deepEqual(diffPlans(a, c), { kind: 'full', from: 2 });
});

test('a layer that draws nothing before or after (hidden) repaints only the other box', () => {
  const a = plan([unit('bg', box(0, 0, 100, 100)), unit('t', null)]);
  const b = plan([a.units[0], { ...a.units[1], pkey: 'shown', box: box(5, 5, 10, 10) }]);
  assert.deepEqual(diffPlans(a, b), { kind: 'region', rect: box(5, 5, 10, 10), from: 1 });
  // hidden and still hidden but touched: nothing to draw
  const c = plan([a.units[0], { ...a.units[1], vkey: 'touched' }]);
  assert.deepEqual(diffPlans(a, c), { kind: 'same' });
});

test('a layer added, deleted or moved in the stack: full from the first unit that differs', () => {
  const a = plan([unit('bg', box(0, 0, 9, 9)), unit('x', box(0, 0, 9, 9)), unit('y', box(0, 0, 9, 9))]);
  assert.deepEqual(diffPlans(a, plan([a.units[0], unit('new', box(0, 0, 1, 1)), ...a.units.slice(1)])), { kind: 'full', from: 1 });
  assert.deepEqual(diffPlans(a, plan([a.units[0], a.units[2]])), { kind: 'full', from: 1 });
  assert.deepEqual(diffPlans(a, plan([a.units[0], a.units[2], a.units[1]])), { kind: 'full', from: 1 });
  // added on top: the units below all match
  assert.deepEqual(diffPlans(a, plan([...a.units, unit('top', box(0, 0, 1, 1))])), { kind: 'full', from: 3 });
});

test('brush hints: a touched layer repaints the dabs only, an empty hint (the end of a stroke) repaints nothing', () => {
  const a = plan([unit('bg', box(0, 0, 100, 100)), unit('adj', ALL)]);
  const dab = box(40, 40, 8, 8);
  assert.deepEqual(diffPlans(a, plan([{ ...a.units[0], vkey: 'v2', hint: dab }, a.units[1]])), { kind: 'region', rect: dab, from: 0 });
  assert.deepEqual(diffPlans(a, plan([{ ...a.units[0], vkey: 'v2', hint: box(0, 0, 0, 0) }, a.units[1]])), { kind: 'same' });
  // a hint covers a mask dab on an adjustment layer too (its box is ALL)
  assert.deepEqual(diffPlans(a, plan([a.units[0], { ...a.units[1], vkey: 'v2', hint: dab }])), { kind: 'region', rect: dab, from: 1 });
  // a property change is never covered by a hint
  assert.deepEqual(diffPlans(a, plan([{ ...a.units[0], pkey: 'opacity', vkey: 'v2', hint: dab }, a.units[1]])), { kind: 'region', rect: box(0, 0, 100, 100), from: 0 });
});

test('samePrefix: a cached composite of the first units holds while those units are unchanged', () => {
  const p = plan([unit('a', null), unit('b', null), unit('c', null)]);
  const keys = { global: 'g', units: p.units.slice(0, 2) };
  assert.equal(samePrefix(keys, p, 2), true);
  assert.equal(samePrefix(keys, plan([p.units[0], p.units[1], { ...p.units[2], pkey: 'x' }]), 2), true);
  assert.equal(samePrefix(keys, plan([p.units[0], { ...p.units[1], vkey: 'x' }, p.units[2]]), 2), false);
  assert.equal(samePrefix(keys, plan(p.units, 'h'), 2), false);
  assert.equal(samePrefix(keys, plan(p.units.slice(0, 1)), 2), false);
  assert.equal(samePrefix(null, p, 2), false);
});

test('rect helpers', () => {
  assert.deepEqual(unionRect(null, box(1, 2, 3, 4)), box(1, 2, 3, 4));
  assert.deepEqual(unionRect(box(0, 0, 1, 1), box(0, 0, 0, 0)), box(0, 0, 1, 1));
  assert.deepEqual(unionRect(box(0, 0, 2, 2), box(5, 5, 1, 1)), box(0, 0, 6, 6));
  assert.equal(unionRect(ALL, null), null);
  assert.deepEqual(intersectRect(box(0, 0, 10, 10), box(5, 5, 10, 10)), box(5, 5, 5, 5));
  assert.equal(intersectRect(box(0, 0, 1, 1), box(2, 2, 1, 1)), null);
  assert.deepEqual(outerRect(box(0.5, 1.2, 2, 2.1)), box(0, 1, 3, 3));
});
