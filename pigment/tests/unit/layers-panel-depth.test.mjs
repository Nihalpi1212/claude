// layers-panel-depth (package 14): the pure rules of the Layers panel (src/renderer/lib/panels/layers-model.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  THUMB_SIZES, thumbSpec, listedEffects, stylesEmpty, panelRows, dropPlacement, PLACE_MODE, clipEdge, clipCandidate,
  dragSubjects, dropRefused, transferEffects, toggleEffect, removeEffect, blendSteps, stepMode, alphaBounds, fitBox,
  sweepTargets, groupsIn,
} from '../../src/renderer/lib/panels/layers-model.js';
import { mergeStyles, effectInstances } from '../../src/shared/pixels/styles.js';

// a tiny layer tree: { id, parent, children, isGroup, expanded, styles, type, visible }
function tree(spec, parent = null) {
  const node = { id: spec.id, type: spec.children ? 'group' : spec.type ?? 'raster', isGroup: !!spec.children, expanded: spec.expanded ?? true, styles: spec.styles ?? null, visible: spec.visible ?? true, parent, filters: spec.filters };
  node.children = (spec.children ?? []).map((c) => tree(c, node));
  return node;
}
const byId = (root, id) => {
  const walk = (n) => (n.id === id ? n : n.children.map(walk).find(Boolean) ?? null);
  return walk(root);
};

test('thumbnail sizes: medium is 0.3\'s 36 x 30 in a 40 px row; unknown names fall back to medium', () => {
  assert.deepEqual(thumbSpec('medium'), { w: 36, h: 30, row: 40 });
  assert.equal(thumbSpec('nonsense'), THUMB_SIZES.medium);
  assert.equal(thumbSpec('none').w, 0);
  assert.ok(thumbSpec('large').w > thumbSpec('medium').w && thumbSpec('small').w < thumbSpec('medium').w);
});

test('listed effects: switched on, or switched off from the panel (present); the dialog\'s unused defaults are not', () => {
  const styles = mergeStyles({ dropShadow: [{ enabled: true }, { enabled: false, present: true }], stroke: { enabled: true }, outerGlow: { enabled: false } });
  const listed = listedEffects(styles).map((e) => [e.key, e.index, e.name]);
  assert.deepEqual(listed, [['dropShadow', 0, 'Drop Shadow'], ['dropShadow', 1, 'Drop Shadow'], ['stroke', 0, 'Stroke']]);
  assert.equal(stylesEmpty(mergeStyles({})), true);
  assert.equal(stylesEmpty(null), true);
  assert.deepEqual(listedEffects(undefined), []);
});

test('panel rows: top first, effects header and rows under a layer, a group\'s effects before its children', () => {
  const root = tree({ id: 'root', children: [
    { id: 'bg' },
    { id: 'g', styles: { stroke: { enabled: true } }, children: [{ id: 'a' }, { id: 'b', styles: { dropShadow: { enabled: true }, innerGlow: { enabled: true } } }] },
    { id: 'top', type: 'smart', filters: [{ kind: 'blur' }] },
  ] });
  const rows = panelRows(root).map((r) => `${r.kind}:${r.layer.id}${r.entry ? `:${r.entry.key}` : ''}@${r.depth}`);
  assert.deepEqual(rows, [
    'layer:top@0', 'filters:top@0',
    'layer:g@0', 'effects:g@0', 'effect:g:stroke@0',
    'layer:b@1', 'effects:b@1', 'effect:b:dropShadow@1', 'effect:b:innerGlow@1',
    'layer:a@1',
    'layer:bg@0',
  ]);
  // a closed effects list shows neither the header nor the effects; showEffects off drops both; a collapsed group
  // hides its children
  const closed = panelRows(root, { effectsOpen: (l) => l.id !== 'b' }).map((r) => `${r.kind}:${r.layer.id}`);
  assert.ok(closed.includes('effects:g') && !closed.some((r) => r === 'effect:b' || r === 'effects:b'));
  assert.ok(!panelRows(root, { showEffects: false }).some((r) => r.kind === 'effects' || r.kind === 'effect'));
  byId(root, 'g').expanded = false;
  assert.deepEqual(panelRows(root, { showEffects: false }).map((r) => r.layer.id), ['top', 'top', 'g', 'bg']);
  // a filter that hides a layer drops its rows
  byId(root, 'g').expanded = true;
  assert.ok(!panelRows(root, { filter: (l) => l.id !== 'g' }).some((r) => r.layer.id === 'g' || r.layer.id === 'a'));
});

test('drop placement: thirds of an expanded group go into it, halves elsewhere; the canPlace modes', () => {
  assert.equal(dropPlacement(0.2, {}), 'above');
  assert.equal(dropPlacement(0.8, {}), 'below');
  assert.equal(dropPlacement(0.85, { isGroup: true, expanded: true }), 'into');
  assert.equal(dropPlacement(0.85, { isGroup: true, expanded: false }), 'below');
  assert.equal(dropPlacement(0.5, { isGroup: true, expanded: false }), 'into');
  assert.equal(dropPlacement(0.1, { isGroup: true, expanded: true }), 'above');
  assert.deepEqual(PLACE_MODE, { into: 'inside', above: 'above', below: 'below' });
});

test('Alt-click between rows: the edge band and the layer it clips', () => {
  assert.equal(clipEdge(2, 40), 'top');
  assert.equal(clipEdge(38, 40), 'bottom');
  assert.equal(clipEdge(20, 40), null);
  assert.equal(clipEdge(1, 0), null);
  const root = tree({ id: 'root', children: [{ id: 'bg' }, { id: 'g', children: [{ id: 'in1' }, { id: 'in2' }] }, { id: 'c' }, { id: 'd' }] });
  const rows = panelRows(root); // d, c, g, in2, in1, bg
  const at = (id) => rows.findIndex((r) => r.layer.id === id && r.kind === 'layer');
  // the line between d and c clips d onto c, from either side of it
  assert.equal(clipCandidate(rows, at('d'), 'bottom')?.id, 'd');
  assert.equal(clipCandidate(rows, at('c'), 'top')?.id, 'd');
  // c over the group g: c clips onto g (its stack neighbour)
  assert.equal(clipCandidate(rows, at('c'), 'bottom')?.id, 'c');
  // the line between g and its first child row: not a stack pair
  assert.equal(clipCandidate(rows, at('g'), 'bottom'), null);
  assert.equal(clipCandidate(rows, at('in2'), 'bottom')?.id, 'in2');
  // the line under in1 (the group's bottom) leads to bg, outside the group
  assert.equal(clipCandidate(rows, at('in1'), 'bottom'), null);
  assert.equal(clipCandidate(rows, at('bg'), 'bottom'), null);
  assert.equal(clipCandidate(rows, at('d'), 'top'), null);
});

test('drag subjects: the selection when the row is selected, without children of a selected group', () => {
  const root = tree({ id: 'root', children: [{ id: 'bg' }, { id: 'g', children: [{ id: 'in' }] }, { id: 'c' }] });
  const [bg, g, inner, c] = ['bg', 'g', 'in', 'c'].map((id) => byId(root, id));
  const order = [bg, g, inner, c];
  assert.deepEqual(dragSubjects(c, new Set([bg])), [c]);
  assert.deepEqual(dragSubjects(c, new Set([c, inner, g]), order).map((l) => l.id), ['g', 'c']);
  assert.equal(dropRefused([g], inner), true);
  assert.equal(dropRefused([g], g), true);
  assert.equal(dropRefused([c], g), false);
});

test('effect rows dropped on another layer: one effect moves or copies; instances stack on top, others replace', () => {
  const src = { dropShadow: [{ enabled: true, distance: 9 }, { enabled: true, distance: 2 }], outerGlow: { enabled: true, size: 7 } };
  const dst = mergeStyles({ dropShadow: { enabled: true, distance: 30 }, outerGlow: { enabled: true, size: 1 } });
  // move the second shadow: the source keeps one, the target has two (the moved one on top)
  let r = transferEffects(src, dst, { key: 'dropShadow', index: 1 }, false);
  assert.deepEqual(effectInstances(r.source, 'dropShadow').map((fx) => fx.distance), [9]);
  assert.deepEqual(effectInstances(r.target, 'dropShadow').map((fx) => fx.distance), [2, 30]);
  // copy the glow: the target's glow is replaced, the source unchanged (same object)
  r = transferEffects(src, dst, { key: 'outerGlow', index: 0 }, true);
  assert.equal(r.source, src);
  assert.equal(effectInstances(r.target, 'outerGlow')[0].size, 7);
  assert.equal(effectInstances(r.target, 'outerGlow').length, 1);
  // moving the only effect of a layer leaves it with no styles
  r = transferEffects({ stroke: { enabled: true, size: 4 } }, null, { key: 'stroke', index: 0 });
  assert.equal(r.source, null);
  assert.equal(effectInstances(r.target, 'stroke')[0].size, 4);
  // the dialog's unused (switched-off) default is not kept beside the moved instance
  r = transferEffects(src, mergeStyles({}), { key: 'dropShadow', index: 0 });
  assert.equal(effectInstances(r.target, 'dropShadow').length, 1);
  // the whole block replaces the target's effects and keeps Hide All Effects
  r = transferEffects({ ...src, hidden: true }, dst, null, false);
  assert.equal(r.source, null);
  assert.equal(r.target.hidden, true);
  assert.deepEqual(effectInstances(r.target, 'dropShadow').map((fx) => fx.distance), [9, 2]);
  // the moved objects are copies
  assert.notEqual(effectInstances(r.target, 'outerGlow')[0], src.outerGlow);
  // an index that does not exist changes nothing
  r = transferEffects(src, dst, { key: 'stroke', index: 0 });
  assert.equal(r.source, src);
  assert.equal(r.target, dst);
});

test('a full instance list loses its top instance to a dropped one', () => {
  const full = { stroke: Array.from({ length: 10 }, (_, i) => ({ enabled: true, size: i + 1 })) };
  const r = transferEffects({ stroke: { enabled: true, size: 99 } }, full, { key: 'stroke', index: 0 }, true);
  const sizes = effectInstances(r.target, 'stroke').map((fx) => fx.size);
  assert.equal(sizes.length, 10);
  assert.equal(sizes[0], 99);
  assert.equal(sizes[1], 2);
});

test('the effect eye keeps the row listed; Delete removes it; removing the last effect drops the styles', () => {
  const styles = { dropShadow: [{ enabled: true }, { enabled: true, distance: 3 }] };
  const off = toggleEffect(styles, 'dropShadow', 1);
  assert.deepEqual(effectInstances(off, 'dropShadow').map((fx) => [fx.enabled, fx.present]), [[true, undefined], [false, true]]);
  assert.equal(listedEffects(off).length, 2);
  const on = toggleEffect(off, 'dropShadow', 1);
  assert.equal(effectInstances(on, 'dropShadow')[1].enabled, true);
  assert.equal(toggleEffect(styles, 'dropShadow', 0, true).dropShadow[0].enabled, true);
  assert.equal(toggleEffect(styles, 'stroke', 0), styles);
  const one = removeEffect(styles, 'dropShadow', 0);
  assert.deepEqual(effectInstances(one, 'dropShadow').map((fx) => fx.distance), [3]);
  assert.equal(removeEffect({ stroke: { enabled: true } }, 'stroke', 0), null);
  assert.equal(removeEffect(styles, 'stroke', 0), styles);
});

test('blend steps: separators dropped, Pass Through first for groups; stepping stops at the ends', () => {
  const modes = [['normal', 'Normal'], ['dissolve', 'Dissolve'], null, ['darken', 'Darken'], ['multiply', 'Multiply']];
  assert.deepEqual(blendSteps(modes), ['normal', 'dissolve', 'darken', 'multiply']);
  const g = blendSteps(modes, true);
  assert.equal(g[0], 'pass-through');
  assert.equal(stepMode(g, 'normal', -1), 'pass-through');
  assert.equal(stepMode(g, 'pass-through', -1), 'pass-through');
  assert.equal(stepMode(g, 'multiply', 1), 'multiply');
  assert.equal(stepMode(g, 'dissolve', 1), 'darken');
  assert.equal(stepMode(g, 'unknown', 1), 'pass-through');
});

test('alpha bounds and the fitted thumbnail box', () => {
  const w = 8, h = 6;
  const data = new Uint8ClampedArray(w * h * 4);
  assert.equal(alphaBounds(data, w, h), null);
  const set = (x, y) => (data[(y * w + x) * 4 + 3] = 255);
  set(2, 1);
  set(5, 4);
  assert.deepEqual(alphaBounds(data, w, h), { x: 2, y: 1, w: 4, h: 4 });
  data[(0 * w + 7) * 4 + 3] = 3;
  assert.deepEqual(alphaBounds(data, w, h, 5), { x: 2, y: 1, w: 4, h: 4 });
  assert.deepEqual(alphaBounds(data, w, h), { x: 2, y: 0, w: 6, h: 5 });
  assert.deepEqual(fitBox(200, 100, 36, 30), { w: 36, h: 18, scale: 0.18 });
  assert.deepEqual(fitBox(100, 400, 36, 30), { w: 8, h: 30, scale: 0.075 });
  assert.equal(fitBox(0, 0, 36, 30).w, 36);
});

test('alpha bounds of a 2000 x 1500 layer take well under the thumbnail delay', () => {
  const w = 2000, h = 1500;
  const data = new Uint8ClampedArray(w * h * 4);
  data[(700 * w + 900) * 4 + 3] = 255;
  const t = performance.now();
  const b = alphaBounds(data, w, h);
  const ms = performance.now() - t;
  assert.deepEqual(b, { x: 900, y: 700, w: 1, h: 1 });
  assert.ok(ms < 200, `alphaBounds took ${ms.toFixed(1)} ms`);
});

test('eye sweep: each layer once, only those not already in the state; every group of a tree', () => {
  const a = { visible: true }, b = { visible: false }, c = { visible: true };
  assert.deepEqual(sweepTargets([a, b, a, c, null], false), [a, c]);
  assert.deepEqual(sweepTargets([a, b, c], true), [b]);
  const root = tree({ id: 'root', children: [{ id: 'g1', children: [{ id: 'g2', children: [{ id: 'x' }] }] }, { id: 'y' }, { id: 'g3', children: [] }] });
  assert.deepEqual(groupsIn(root).map((g) => g.id), ['g1', 'g2', 'g3']);
});
