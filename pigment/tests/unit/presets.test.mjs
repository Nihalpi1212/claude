// Preset store core (0.4 skeleton, C) with a memory backend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PresetStore, registerPresetKind, registerPresetFormat, presetFormats } from '../../src/renderer/lib/presets.js';

function memoryBackend() {
  const files = new Map(), blobs = new Map();
  const b = {
    files, blobs, writes: 0, fail: null,
    async read(kind) { return files.has(kind) ? JSON.parse(files.get(kind)) : null; },
    async write(kind, json) {
      if (b.fail) throw Object.assign(new Error('disk full'), { code: b.fail });
      b.writes++;
      if (json === null) files.delete(kind);
      else files.set(kind, JSON.stringify(json));
    },
    async readBlob(kind, name) { return blobs.get(`${kind}/${name}`) ?? null; },
    async writeBlob(kind, name, bytes) { blobs.set(`${kind}/${name}`, new Uint8Array(bytes)); },
    async removeBlob(kind, name) { blobs.delete(`${kind}/${name}`); },
  };
  return b;
}

let builtinList = [
  { id: 'b-red', name: 'Red', group: 'g-basic', data: { v: 'red' } },
  { id: 'b-blue', name: 'Blue', group: 'g-basic', data: { v: 'blue' } },
  { id: 'b-wild', name: 'Wild', data: { v: 'wild' } },
];
registerPresetKind('test-colors', {
  title: 'Test colours',
  version: 2,
  builtins: () => ({ groups: [{ id: 'g-basic', name: 'Basic' }], presets: builtinList }),
  normalize: (data, { version }) => {
    if (!data || typeof data.v !== 'string') return null;
    const out = version < 2 ? { v: data.v.toUpperCase() } : { v: data.v };
    if (typeof data.blob === 'string') out.blob = data.blob;
    return out;
  },
  blobs: (data) => (data.blob ? [data.blob] : []),
});

const ids = (list) => list.map((p) => p.id);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function make(opts = {}) {
  const backend = opts.backend ?? memoryBackend();
  const errors = [];
  const store = new PresetStore({ backend, delay: 20, onWriteError: (err, info) => errors.push([err.code, info.kind]) });
  const events = [];
  store.addEventListener('change', (e) => events.push(e.detail));
  return { backend, store, errors, events };
}

test('built-ins are listed before and after ready(), never written until something changes', async () => {
  const { store, backend, events } = make();
  assert.deepEqual(ids(store.list('test-colors')), ['b-red', 'b-blue', 'b-wild']);
  // editing before the user's file was read would overwrite it
  assert.throws(() => store.add('test-colors', { name: 'Early', data: { v: 'e' } }), /ready/);
  await store.ready('test-colors');
  assert.deepEqual(ids(store.list('test-colors')), ['b-red', 'b-blue', 'b-wild']);
  assert.deepEqual(ids(store.list('test-colors', { group: 'g-basic' })), ['b-red', 'b-blue']);
  assert.deepEqual(ids(store.list('test-colors', { group: null })), ['b-wild']);
  assert.equal(store.get('test-colors', 'b-blue').name, 'Blue');
  assert.ok(store.get('test-colors', 'b-blue').builtin);
  await store.flush();
  assert.equal(backend.writes, 0);
  assert.equal(events[0].reason, 'load');
  assert.deepEqual(store.groups('test-colors'), [{ id: 'g-basic', name: 'Basic', parent: null, builtin: true }]);
  assert.deepEqual(store.list('unknown-kind'), []);
  store.dispose();
});

test('add / update / remove / move keep order; built-ins become modified or hidden', async () => {
  const { store, backend, events } = make();
  await store.ready('test-colors');
  const a = store.add('test-colors', { name: 'Mine', data: { v: 'mine' } });
  assert.match(a.id, /^u-/);
  assert.equal(a.builtin, false);
  assert.throws(() => store.add('test-colors', { name: 'Bad', data: { nope: 1 } }));
  assert.deepEqual(ids(store.list('test-colors')), ['b-red', 'b-blue', 'b-wild', a.id]);
  const m = store.update('test-colors', 'b-blue', { name: 'Navy', data: { v: 'navy' } });
  assert.equal(m.builtin, true);
  assert.equal(m.modified, true);
  assert.equal(store.get('test-colors', 'b-blue').name, 'Navy');
  store.update('test-colors', a.id, { name: 'Mine 2' });
  store.remove('test-colors', 'b-red');
  assert.deepEqual(ids(store.list('test-colors')), ['b-blue', 'b-wild', a.id]);
  store.move('test-colors', a.id, { group: 'g-basic', index: 0 });
  assert.deepEqual(ids(store.list('test-colors', { group: 'g-basic' })), [a.id, 'b-blue']);
  store.move('test-colors', 'b-wild', { index: 0 });
  assert.deepEqual(ids(store.list('test-colors', { group: null })), ['b-wild']);
  assert.deepEqual(events.slice(1).map((e) => e.reason), ['add', 'update', 'update', 'remove', 'move', 'move']);
  await store.flush();
  const file = JSON.parse(backend.files.get('test-colors'));
  assert.equal(file.format, 'pigment-presets');
  assert.equal(file.kind, 'test-colors');
  assert.equal(file.kindVersion, 2);
  assert.deepEqual(file.hidden, ['b-red']);
  // built-ins as refs, the modified one in full
  assert.deepEqual(file.items.map((it) => it.ref ?? it.id), [a.id, 'b-blue', 'b-wild']);
  assert.ok(file.items.some((it) => it.ref === 'b-wild'));
  assert.equal(file.items.find((it) => it.id === 'b-blue').modified, true);
  // a second store reads the same state back
  const again = new PresetStore({ backend });
  await again.ready('test-colors');
  assert.deepEqual(ids(again.list('test-colors')), [a.id, 'b-blue', 'b-wild']);
  assert.equal(again.get('test-colors', 'b-blue').name, 'Navy');
  assert.equal(again.get('test-colors', a.id).name, 'Mine 2');
  store.dispose();
  again.dispose();
});

test('groups: add, rename (built-in too), remove with and without keeping presets; reset', async () => {
  const { store, backend } = make();
  await store.ready('test-colors');
  const g = store.addGroup('test-colors', { name: 'Mine' });
  const p = store.add('test-colors', { name: 'P', data: { v: 'p' }, group: g.id });
  store.renameGroup('test-colors', 'g-basic', 'Basics');
  assert.deepEqual(store.groups('test-colors').map((x) => [x.id, x.name]), [['g-basic', 'Basics'], [g.id, 'Mine']]);
  store.removeGroup('test-colors', g.id, { keepPresets: true });
  assert.equal(store.get('test-colors', p.id).group, null);
  store.removeGroup('test-colors', 'g-basic');
  assert.deepEqual(ids(store.list('test-colors')), ['b-wild', p.id]);
  assert.deepEqual(store.groups('test-colors'), []);
  await store.flush();
  assert.ok(backend.files.has('test-colors'));
  store.reset('test-colors');
  await wait(5);
  assert.ok(!backend.files.has('test-colors'));
  assert.deepEqual(ids(store.list('test-colors')), ['b-red', 'b-blue', 'b-wild']);
  assert.equal(store.groups('test-colors')[0].name, 'Basic');
  store.dispose();
});

test('new built-ins are appended to their group on load; kind version upgrades user data', async () => {
  const backend = memoryBackend();
  backend.files.set('test-colors', JSON.stringify({
    format: 'pigment-presets', version: 1, kind: 'test-colors', kindVersion: 1,
    groups: [], hidden: [],
    items: [{ ref: 'b-blue' }, { id: 'u-old', name: 'Old', group: null, data: { v: 'old' }, builtin: false }, { ref: 'b-red' }, { id: 'u-bad', name: 'Bad', data: {} }],
  }));
  const saved = builtinList;
  builtinList = [...saved, { id: 'b-green', name: 'Green', group: 'g-basic', data: { v: 'green' } }];
  registerPresetKind('test-colors', { title: 'Test colours', version: 2, builtins: () => ({ groups: [{ id: 'g-basic', name: 'Basic' }], presets: builtinList }), normalize: (d, { version }) => (d && typeof d.v === 'string' ? (version < 2 ? { v: d.v.toUpperCase() } : { v: d.v }) : null) });
  try {
    const store = new PresetStore({ backend, delay: 20 });
    await store.ready('test-colors');
    // order kept; each new built-in goes after the last member of its group (b-wild has none: after u-old)
    assert.deepEqual(ids(store.list('test-colors')), ['b-blue', 'u-old', 'b-wild', 'b-red', 'b-green']);
    assert.deepEqual(store.get('test-colors', 'u-old').data, { v: 'OLD' });
    assert.equal(store.get('test-colors', 'u-bad'), null);
    store.dispose();
  } finally {
    builtinList = saved;
    registerPresetKind('test-colors', { title: 'Test colours', version: 2, builtins: () => ({ groups: [{ id: 'g-basic', name: 'Basic' }], presets: builtinList }), normalize: (d) => (d && typeof d.v === 'string' ? { v: d.v, ...(d.blob ? { blob: d.blob } : {}) } : null), blobs: (data) => (data.blob ? [data.blob] : []) });
  }
});

test('writes are debounced per kind; flush writes at once', async () => {
  const { store, backend } = make();
  await store.ready('test-colors');
  store.add('test-colors', { name: 'A', data: { v: 'a' } });
  store.add('test-colors', { name: 'B', data: { v: 'b' } });
  store.add('test-colors', { name: 'C', data: { v: 'c' } });
  assert.equal(backend.writes, 0);
  await wait(60);
  assert.equal(backend.writes, 1);
  store.add('test-colors', { name: 'D', data: { v: 'd' } });
  await store.flush();
  assert.equal(backend.writes, 2);
  assert.equal(JSON.parse(backend.files.get('test-colors')).items.length, 7);
  store.dispose();
});

test('a corrupt file reads as the built-ins and is not overwritten until something changes', async () => {
  const backend = memoryBackend();
  backend.read = async () => ({ format: 'something else', junk: true });
  const store = new PresetStore({ backend, delay: 10 });
  await store.ready('test-colors');
  assert.deepEqual(ids(store.list('test-colors')), ['b-red', 'b-blue', 'b-wild']);
  await store.flush();
  assert.equal(backend.writes, 0);
  const throwing = memoryBackend();
  throwing.read = async () => { throw new Error('unreadable'); };
  const s2 = new PresetStore({ backend: throwing });
  await s2.ready('test-colors');
  assert.equal(s2.list('test-colors').length, 3);
  store.dispose();
  s2.dispose();
});

test('a failing backend calls onWriteError and keeps the memory state', async () => {
  const { store, backend, errors } = make();
  await store.ready('test-colors');
  backend.fail = 'quota';
  const p = store.add('test-colors', { name: 'Kept', data: { v: 'kept' } });
  await store.flush();
  assert.deepEqual(errors, [['quota', 'test-colors']]);
  assert.equal(store.get('test-colors', p.id).name, 'Kept');
  // the change is still pending: once the backend works again a flush writes it
  backend.fail = null;
  await store.flush();
  assert.ok(JSON.parse(backend.files.get('test-colors')).items.some((it) => it.id === p.id));
  store.dispose();
});

test('the pigment-presets format round trips presets, groups and blobs', async () => {
  const { store } = make();
  await store.ready('test-colors');
  assert.ok(presetFormats('test-colors').some((f) => f.id === 'pigment-presets'));
  const g = store.addGroup('test-colors', { name: 'Textures' });
  await store.writeBlob('test-colors', 'u1.png', new Uint8Array([1, 2, 3, 250]));
  const p = store.add('test-colors', { name: 'With blob', data: { v: 'tex', blob: 'u1.png' }, group: g.id });
  const { bytes, ext } = await store.exportFile('test-colors', [p.id, 'b-red'], 'pigment-presets');
  assert.equal(ext, 'pigment-presets');
  const other = make();
  await other.store.ready('test-colors');
  const res = await other.store.importFile('test-colors', bytes, { name: 'mine.pigment-presets' });
  assert.deepEqual(res.report, []);
  // exported in list order
  assert.deepEqual(res.added.map((x) => x.name), ['Red', 'With blob']);
  assert.equal(other.store.groups('test-colors').find((x) => x.id === res.added[1].group).name, 'Textures');
  assert.deepEqual([...(await other.store.readBlob('test-colors', 'u1.png'))], [1, 2, 3, 250]);
  assert.ok(res.added.every((x) => !x.builtin && x.id.startsWith('u-')));
  // an unknown extension and an unreadable file are reported, nothing added
  const none = await other.store.importFile('test-colors', bytes, { name: 'x.grd' });
  assert.equal(none.added.length, 0);
  assert.ok(none.report[0].includes('.grd'));
  const broken = await other.store.importFile('test-colors', new TextEncoder().encode('{nope'), { name: 'x.pigment-presets' });
  assert.equal(broken.added.length, 0);
  assert.ok(broken.report.length);
  await assert.rejects(store.writeBlob('test-colors', '../evil', new Uint8Array(1)));
  store.dispose();
  other.store.dispose();
});

test('kind-specific formats are offered next to the built-in one', () => {
  registerPresetFormat('test-colors', { id: 'tcf', name: 'Test format', extensions: ['tcf'], read: async () => ({ presets: [], report: [] }) });
  assert.deepEqual(presetFormats('test-colors').map((f) => f.id), ['tcf', 'pigment-presets']);
  assert.deepEqual(presetFormats('other-kind').map((f) => f.id), ['pigment-presets']);
});
