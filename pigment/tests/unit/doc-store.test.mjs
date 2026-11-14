// Document store (0.4 skeleton, D) with a fake document { history: { push }, changed }.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocStore, registerCollection, collectionSpec } from '../../src/renderer/lib/doc-store.js';

function fakeDoc() {
  const entries = [];
  const events = [];
  const doc = {
    history: { push: (e) => (entries.push(e), e) },
    changed: (kind, detail = {}) => events.push({ kind, ...detail }),
  };
  return { doc, entries, events };
}

function store({ clock } = {}) {
  const f = fakeDoc();
  let t = 1000;
  const s = new DocStore(f.doc, { clock: clock ?? (() => t) });
  return { ...f, s, tick: (ms) => (t += ms) };
}

// 0.3's mapGuide (image-ops.js remapDocument), copied as the reference
function mapGuide03(g, m) {
  const point = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const dir = g.axis === 'x' ? [m[2], m[3]] : [m[0], m[1]];
  if (Math.abs(dir[0]) > 1e-9 && Math.abs(dir[1]) > 1e-9) return null;
  const p = g.axis === 'x' ? point(g.pos, 0) : point(0, g.pos);
  const axis = Math.abs(dir[0]) > Math.abs(dir[1]) ? 'y' : 'x';
  return { ...g, axis, pos: Math.round((axis === 'x' ? p[0] : p[1]) * 100) / 100 };
}

test('set / add / update / remove create one entry each; undo and redo restore', () => {
  const { s, entries, events } = store();
  assert.deepEqual(s.get('guides'), []);
  const g = s.add('guides', { axis: 'x', pos: 10 });
  assert.equal(entries.length, 1);
  assert.match(g.id, /^S/);
  assert.deepEqual(s.get('guides'), [{ id: g.id, axis: 'x', pos: 10 }]);
  s.update('guides', g.id, { pos: 20 });
  assert.equal(entries.length, 2);
  s.set('guides', [...s.get('guides'), { axis: 'y', pos: 5 }], { label: 'Two' });
  assert.equal(entries.length, 3);
  assert.equal(entries[2].label, 'Two');
  s.remove('guides', g.id);
  assert.equal(entries.length, 4);
  assert.deepEqual(s.get('guides').map((x) => [x.axis, x.pos]), [['y', 5]]);
  entries[3].undo();
  assert.deepEqual(s.get('guides').map((x) => [x.axis, x.pos]), [['x', 20], ['y', 5]]);
  entries[2].undo();
  entries[1].undo();
  assert.deepEqual(s.get('guides'), [{ id: g.id, axis: 'x', pos: 10 }]);
  entries[1].redo();
  assert.equal(s.get('guides')[0].pos, 20);
  // every change emits 'store' and, for guides, the 0.3 kind 'guides'
  assert.ok(events.some((e) => e.kind === 'store' && e.collection === 'guides'));
  assert.ok(events.some((e) => e.kind === 'guides'));
  // removing or updating an unknown id records nothing
  s.remove('guides', 'nope');
  s.update('guides', 'nope', { pos: 1 });
  assert.equal(entries.length, 4);
});

test('merge folds sets of the same collection within 1.5 s into one entry', () => {
  const { s, entries, tick } = store();
  s.set('guides', [{ axis: 'x', pos: 1 }], { merge: true });
  tick(500);
  s.set('guides', [{ axis: 'x', pos: 2 }], { merge: true });
  tick(500);
  s.set('guides', [{ axis: 'x', pos: 3 }], { merge: true });
  assert.equal(entries.length, 1);
  entries[0].undo();
  assert.deepEqual(s.get('guides'), []);
  entries[0].redo();
  assert.equal(s.get('guides')[0].pos, 3);
  tick(1600);
  s.set('guides', [{ axis: 'x', pos: 4 }], { merge: true });
  assert.equal(entries.length, 2);
  // another collection in between breaks the merge
  s.set('rulerOrigin', { x: 1, y: 1 });
  s.set('guides', [{ axis: 'x', pos: 5 }], { merge: true });
  assert.equal(entries.length, 4);
  // without merge, never merged
  s.set('guides', [{ axis: 'x', pos: 6 }]);
  assert.equal(entries.length, 5);
});

test('merge with a real history stack uses history.merge and only on its own top entry', () => {
  const list = [];
  const h = {
    entries: list, index: -1,
    push(e) { list.length = this.index + 1; list.push(e); this.index = list.length - 1; return e; },
    merge(redo) { const last = list[this.index]; last.redo = redo; return last; },
  };
  let t = 0;
  const s = new DocStore({ history: h, changed() {} }, { clock: () => t });
  s.set('guides', [{ axis: 'x', pos: 1 }], { merge: true });
  h.push({ label: 'other', undo() {}, redo() {} });
  t += 100;
  s.set('guides', [{ axis: 'x', pos: 2 }], { merge: true });
  assert.equal(list.length, 3);
  t += 100;
  s.set('guides', [{ axis: 'x', pos: 3 }], { merge: true });
  assert.equal(list.length, 3);
  list[2].redo();
  assert.equal(s.get('guides')[0].pos, 3);
});

test('setRaw records nothing; ids are added; optional guide fields stored only when set', () => {
  const { s, entries } = store();
  s.setRaw('guides', [{ axis: 'x', pos: 1.5 }, { axis: 'y', pos: 2, color: '#FF0000' }, { axis: 'z', pos: 1 }, { axis: 'x', pos: NaN }, { axis: 'y', pos: 3, color: 'red', artboard: '' }]);
  assert.equal(entries.length, 0);
  const g = s.get('guides');
  assert.equal(g.length, 3);
  assert.deepEqual(Object.keys(g[0]), ['id', 'axis', 'pos']);
  assert.equal(g[0].pos, 1.5);
  assert.deepEqual(Object.keys(g[1]), ['id', 'axis', 'pos', 'color']);
  assert.equal(g[1].color, '#ff0000');
  assert.deepEqual(Object.keys(g[2]), ['id', 'axis', 'pos']);
  // existing ids are kept
  s.setRaw('guides', [{ id: 'keep', axis: 'x', pos: 1 }]);
  assert.equal(s.get('guides')[0].id, 'keep');
});

test('get is frozen: a mutation throws instead of corrupting the store', () => {
  const { s } = store();
  s.setRaw('guides', [{ axis: 'x', pos: 1 }]);
  const g = s.get('guides');
  assert.throws(() => g.push({ axis: 'x', pos: 2 }));
  assert.throws(() => { g[0].pos = 9; });
  assert.throws(() => { s.get('rulerOrigin').x = 5; });
  assert.equal(s.get('guides').length, 1);
});

test('transformAll maps guides exactly like 0.3 mapGuide and moves the ruler origin', () => {
  const guides = [{ axis: 'x', pos: 10 }, { axis: 'y', pos: 33.333 }, { axis: 'x', pos: 0 }, { axis: 'y', pos: 99 }];
  const matrices = [
    [2, 0, 0, 2, 0, 0], // Image Size 200 %
    [0.333, 0, 0, 0.5, 0, 0],
    [1, 0, 0, 1, 12.5, -7], // Canvas Size / crop offset
    [0, 1, -1, 0, 100, 0], // Rotate 90 CW
    [-1, 0, 0, 1, 50, 0], // Flip horizontal
    [0.7071, 0.7071, -0.7071, 0.7071, 0, 0], // arbitrary rotation: every guide dropped
  ];
  for (const m of matrices) {
    const { s, entries } = store();
    s.setRaw('guides', guides);
    const ids = s.get('guides').map((g) => g.id);
    s.setRaw('rulerOrigin', { x: 3, y: 4 });
    s.transformAll(m, { width: 1, height: 1 });
    const expected = guides.map((g, i) => mapGuide03({ id: ids[i], ...g }, m)).filter(Boolean);
    assert.deepEqual(s.get('guides'), expected, JSON.stringify(m));
    assert.deepEqual(s.get('rulerOrigin'), { x: m[0] * 3 + m[2] * 4 + m[4], y: m[1] * 3 + m[3] * 4 + m[5] });
    assert.equal(entries.length, 0);
  }
});

test('snapshot / restore and clone', () => {
  const { s, doc } = store();
  s.setRaw('guides', [{ axis: 'x', pos: 1 }]);
  const snap = s.snapshot();
  s.setRaw('guides', []);
  s.setRaw('rulerOrigin', { x: 5, y: 5 });
  s.restore(snap);
  assert.equal(s.get('guides').length, 1);
  assert.deepEqual(s.get('rulerOrigin'), { x: 0, y: 0 });
  const other = fakeDoc();
  const c = s.clone(other.doc);
  assert.equal(c.doc, other.doc);
  c.setRaw('guides', []);
  assert.equal(s.get('guides').length, 1);
  assert.equal(c.get('guides').length, 0);
  void doc;
});

test('toJSON / fromJSON round trip; the version 2 migration adds ids', () => {
  const { s } = store();
  s.setRaw('guides', [{ axis: 'x', pos: 1, color: '#00ff00' }, { axis: 'y', pos: 2 }]);
  s.setRaw('rulerOrigin', { x: 7, y: 8 });
  const json = JSON.parse(JSON.stringify(s.toJSON()));
  assert.deepEqual(json.guides.v, 1);
  assert.equal(json.guides.data.length, 2);
  assert.deepEqual(json.rulerOrigin, { v: 1, data: { x: 7, y: 8 } });
  const back = DocStore.fromJSON(fakeDoc().doc, json, { guides: [{ axis: 'x', pos: 99 }] });
  assert.deepEqual(back.get('guides'), s.get('guides'));
  assert.deepEqual(back.get('rulerOrigin'), { x: 7, y: 8 });
  // version 2: no store, the top-level guides array
  const v2 = DocStore.fromJSON(fakeDoc().doc, undefined, { guides: [{ axis: 'x', pos: 5 }, { axis: 'y', pos: 6 }] });
  assert.deepEqual(v2.get('guides').map(({ axis, pos }) => ({ axis, pos })), [{ axis: 'x', pos: 5 }, { axis: 'y', pos: 6 }]);
  assert.ok(v2.get('guides').every((g) => typeof g.id === 'string' && g.id));
  assert.deepEqual(DocStore.fromJSON(fakeDoc().doc, null, {}).get('guides'), []);
});

test('an unregistered collection survives toJSON, clone, snapshot and transformAll, and a later registration takes it over', () => {
  const json = { guides: { v: 1, data: [] }, comps04test: { v: 3, data: [{ name: 'A', layers: [1, 2] }] } };
  const { doc } = fakeDoc();
  const s = DocStore.fromJSON(doc, JSON.parse(JSON.stringify(json)));
  assert.deepEqual(s.toJSON().comps04test, json.comps04test);
  const snap = s.snapshot();
  s.transformAll([2, 0, 0, 2, 0, 0], {});
  s.restore(snap);
  assert.deepEqual(s.toJSON().comps04test, json.comps04test);
  const c = s.clone(fakeDoc().doc);
  assert.deepEqual(c.toJSON().comps04test, json.comps04test);
  assert.equal(collectionSpec('comps04test'), null);
  let readArgs = null;
  registerCollection('comps04test', {
    kind: 'list', version: 3, initial: () => [],
    normalize: (x) => (x && typeof x.name === 'string' ? { ...x } : null),
    read: (data, info) => ((readArgs = info), data),
  });
  const comps = c.get('comps04test');
  assert.deepEqual(readArgs, { version: 3 });
  assert.equal(comps.length, 1);
  assert.equal(comps[0].name, 'A');
  assert.ok(comps[0].id);
  assert.equal(c.toJSON().comps04test.v, 3);
});

test('a collection with save: false is never written', () => {
  registerCollection('scratch04test', { kind: 'value', version: 1, save: false, initial: () => 0, normalize: (v) => (typeof v === 'number' ? v : null) });
  const { s } = store();
  s.setRaw('scratch04test', 5);
  assert.equal(s.get('scratch04test'), 5);
  assert.ok(!('scratch04test' in s.toJSON()));
});
