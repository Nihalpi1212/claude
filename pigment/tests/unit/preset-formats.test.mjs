// Preset files of the 0.5 skeleton (ARCHITECTURE.md "0.5 features", S10): both registries searched, file-local links
// ($presetRef), blobs to the kind blobRefs names, extraBlobs in .pigment-presets, routing by the file's kind, the
// export format order, and the .abr / .aco-.ase stubs (rule 11: their stub assertions read ABR_REAL / ACO_ASE_REAL).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PresetStore, registerPresetKind, registerPresetFormat } from '../../src/renderer/lib/presets.js';
import { normalizeBrush, blobsOf, withoutSampleData } from '../../src/renderer/lib/brush/preset.js';
import * as F from '../../src/renderer/lib/preset-formats.js';
import * as ABR from '../../src/renderer/lib/brush/abr.js';
import * as ACO from '../../src/renderer/lib/preset-files/aco-ase.js';

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// the kinds these tests need, as the skeleton registers them (preset-kinds.js is not Node-safe: it imports the tools)
registerPresetKind('brushes', { title: 'Brushes', version: 1, builtins: () => ({ presets: [] }), normalize: (d) => (isObject(d) ? withoutSampleData(normalizeBrush(d)) : null), blobs: (d) => blobsOf(d) });
registerPresetKind('patterns', { title: 'Patterns', version: 1, builtins: () => ({ presets: [] }), normalize: (d) => (isObject(d) && typeof d.blob === 'string' ? d : null), blobs: (d) => (typeof d?.blob === 'string' ? [d.blob] : []) });
registerPresetKind('tool-presets', { title: 'Tool Presets', version: 1, builtins: () => ({ presets: [] }), normalize: (d) => (isObject(d) && typeof d.tool === 'string' ? d : null) });
registerPresetKind('gradients-t', { title: 'Gradients', version: 1, builtins: () => ({ presets: [] }), normalize: (d) => (isObject(d) && Array.isArray(d.stops) ? d : null) });

/** A fake app over an in-memory preset store; installPresetFormats registers the skeleton's blob refs. */
function makeApp() {
  const files = new Map();
  const blobs = new Map();
  const backend = {
    read: (kind) => files.get(kind) ?? null,
    write: (kind, file) => (file ? files.set(kind, file) : files.delete(kind)),
    readBlob: (kind, name) => blobs.get(`${kind}/${name}`) ?? null,
    writeBlob: (kind, name, bytes) => blobs.set(`${kind}/${name}`, bytes),
    removeBlob: (kind, name) => blobs.delete(`${kind}/${name}`),
  };
  const app = { presets: new PresetStore({ backend, delay: 1 }), blobs };
  F.installPresetFormats(app);
  return app;
}

const bytesOf = (s) => new TextEncoder().encode(s);
const json = (bytes) => JSON.parse(new TextDecoder().decode(bytes));

test('a two-kind file imports linked items first, resolves $presetRef to { presetId, name }, blobs to their kinds, groups', async () => {
  const pixels = new Uint8Array([1, 2, 3]);
  const off = F.registerPresetFileFormat({
    id: 'fake-two', name: 'Fake', extensions: ['fakebr'], kinds: ['brushes', 'patterns'],
    async read() {
      return {
        // the brush comes first and names the pattern that comes after it
        items: [
          { kind: 'brushes', name: 'Textured', group: 'g1', data: { tip: { size: 30 }, texture: { enabled: true, pattern: { $presetRef: { kind: 'patterns', ref: 'p1' } } } } },
          { kind: 'patterns', ref: 'p1', name: 'Dots', data: { width: 1, height: 1, blob: 'pat-dots.png', mode: 'rgb' }, blobs: { 'pat-dots.png': pixels } },
          { kind: 'brushes', name: 'Broken link', data: { tip: { size: 5 }, texture: { enabled: true, pattern: { $presetRef: { kind: 'patterns', ref: 'none' } } } } },
          { kind: 'unknown-kind', name: 'Nope', data: {} },
        ],
        groups: [{ kind: 'brushes', id: 'g1', name: 'From the file' }],
        report: ['a line from the reader'],
      };
    },
  });
  try {
    const app = makeApp();
    assert.equal(F.presetFileFormatFor('x.FAKEBR').id, 'fake-two');
    const res = await F.importPresetBytes(app, [{ name: '/some/dir/set.fakebr', bytes: new Uint8Array(4) }]);
    assert.deepEqual(res.added, { patterns: 1, brushes: 2 });
    const dots = app.presets.list('patterns').find((p) => p.name === 'Dots');
    const textured = app.presets.list('brushes').find((p) => p.name === 'Textured');
    assert.deepEqual(textured.data.texture.pattern, { presetId: dots.id, name: 'Dots' });
    assert.equal(app.presets.list('brushes').find((p) => p.name === 'Broken link').data.texture.pattern, null);
    assert.equal(app.blobs.get('patterns/pat-dots.png'), pixels);
    const group = app.presets.groups('brushes').find((g) => g.name === 'From the file');
    assert.equal(textured.group, group.id);
    assert.ok(res.report.includes('a line from the reader'));
    assert.ok(res.report.some((l) => /does not hold/.test(l)));
    assert.ok(res.report.some((l) => /unknown-kind/.test(l)));
  } finally {
    off();
  }
});

test('both registries are searched; kind formats come first and .pigment-presets last; the typed extension picks the format', async () => {
  registerPresetFormat('gradients-t', { id: 'tgrd', name: 'Test GRD', extensions: ['.tgrd'], read: async () => ({ presets: [{ name: 'From tgrd', data: { stops: [] } }], report: [] }), write: async (presets) => bytesOf(`tgrd:${presets.length}`) });
  const offBundle = F.registerPresetFileFormat({ id: 'bundle-t', name: 'Bundle', extensions: ['tbundle'], kinds: ['*'], read: async () => ({ items: [], report: [] }), write: async () => new Uint8Array(1) });
  try {
    const list = F.presetFileFormats({ kind: 'gradients-t', write: true }).map((f) => f.id);
    assert.equal(list[0], 'tgrd');
    assert.deepEqual(list.slice(-2), ['bundle-t', 'pigment-presets']);
    assert.equal(F.presetFileFormatFor('a.tgrd').store, true);
    assert.deepEqual(F.presetFileFormatFor('a.pigment-presets').kinds, ['*']);
    assert.equal(F.presetFileFormatFor('notes.txt'), null);
    assert.equal(F.opensAsPresets('/x/a.tgrd'), true);
    assert.equal(F.opensAsPresets('/x/a.pigment-presets'), true);
    assert.equal(F.opensAsPresets('/x/a.png'), false); // an image opens, whatever preset format also reads it
    const app = makeApp();
    await app.presets.ready('gradients-t');
    const p = app.presets.add('gradients-t', { name: 'Mine', data: { stops: [] } });
    // .pigment-presets: 0.4's bytes, exactly (no extraBlobs key when there is nothing in another kind)
    const own = await F.exportPresetBytes(app, 'gradients-t', [p.id]);
    assert.equal(own.ext, 'pigment-presets');
    assert.deepEqual(own.bytes, (await app.presets.exportFile('gradients-t', [p.id], 'pigment-presets')).bytes);
    assert.equal(json(own.bytes).extraBlobs, undefined);
    const grd = await F.exportPresetBytes(app, 'gradients-t', null, 'tgrd');
    assert.deepEqual([grd.ext, new TextDecoder().decode(grd.bytes)], ['tgrd', 'tgrd:1']);
    // a store format of one kind imports through app.presets.importFile
    const res = await F.importPresetBytes(app, [{ name: 'b.tgrd', bytes: new Uint8Array(1) }]);
    assert.deepEqual(res.added, { 'gradients-t': 1 });
  } finally {
    offBundle();
  }
});

test('a tool preset\'s tip travels in extraBlobs and lands in `brushes`; a .pigment-presets file routes by its kind', async () => {
  const tip = new Uint8Array([9, 8, 7]);
  const src = makeApp();
  await src.presets.ready('tool-presets');
  const brush = withoutSampleData(normalizeBrush({ tip: { kind: 'sampled', size: 40, sample: { blob: 'tip-abc.png', hash: 'abc', width: 1, height: 1 } } }));
  src.presets.add('tool-presets', { name: 'Chalk Brush', data: { tool: 'brush', options: { opacity: 0.5 }, brush } });
  await src.presets.writeBlob('brushes', 'tip-abc.png', tip);
  assert.deepEqual(F.blobRefs('tool-presets', { tool: 'brush', brush }), [{ kind: 'brushes', name: 'tip-abc.png' }]);
  const out = await F.exportPresetBytes(src, 'tool-presets', null);
  const file = json(out.bytes);
  assert.equal(file.kind, 'tool-presets');
  assert.deepEqual(Object.keys(file.extraBlobs.brushes), ['tip-abc.png']);

  const dst = makeApp();
  // `kinds` prefers formats of those kinds; a .pigment-presets file still goes to the kind it names
  const res = await F.importPresetBytes(dst, [{ name: 'chalk.pigment-presets', bytes: out.bytes }], { kinds: ['patterns'] });
  assert.deepEqual(res.added, { 'tool-presets': 1 });
  assert.deepEqual([...dst.blobs.get('brushes/tip-abc.png')], [...tip]);
  assert.equal(dst.presets.list('tool-presets')[0].data.brush.tip.sample.blob, 'tip-abc.png');
});

test('malformed preset files never throw: each gives a report line', async () => {
  const app = makeApp();
  const throwing = F.registerPresetFileFormat({ id: 'throws', extensions: ['boom'], kinds: ['brushes'], read: async () => { throw new Error('truncated'); } });
  try {
    const res = await F.importPresetBytes(app, [
      { name: 'a.pigment-presets', bytes: bytesOf('{not json') },
      { name: 'b.pigment-presets', bytes: bytesOf(JSON.stringify({ format: 'pigment-presets', kind: 'no-such-kind', items: [] })) },
      { name: 'c.boom', bytes: new Uint8Array(0) },
      { name: 'd.unknown', bytes: new Uint8Array(0) },
    ]);
    assert.deepEqual(res.added, {});
    assert.equal(res.report.length, 4);
    assert.ok(res.report[2].includes('truncated'));
  } finally {
    throwing();
  }
  assert.deepEqual(F.BUNDLE_SETTINGS, ['tools', 'brushes', 'painting', 'colorUI', 'typeFonts', 'keymap']);
});

test('the .abr stub maps the tip through brushFromLegacy and names a sampled tip by its SHA-1 (gated on ABR_REAL)', () => {
  const alpha = new Uint8Array([0, 64, 128, 255, 255, 128]);
  const r = ABR.brushFromAgPsd({ name: 'Chalk', shape: { type: 'sampled', size: 36, angle: 30, roundness: 0.5, spacing: 0.3, spacingOn: true, flipX: true, flipY: false, sampledData: 's1' }, transfer: {} }, new Map([['s1', { width: 3, height: 2, alpha }]]));
  assert.equal(r.preset.tip.kind, 'sampled');
  assert.equal(r.preset.tip.size, 36);
  const [name] = Object.keys(r.blobs);
  assert.equal(name, r.preset.tip.sample.blob);
  assert.equal(`tip-${createHash('sha1').update(r.blobs[name]).digest('hex')}.png`, name);
  assert.deepEqual([r.preset.tip.sample.width, r.preset.tip.sample.height], [3, 2]);
  if (!ABR.ABR_REAL) {
    // the stub: angle, roundness, spacing and the flip are kept; Transfer is reported, not mapped
    assert.deepEqual([r.preset.tip.angle, r.preset.tip.roundness, r.preset.tip.spacing, r.preset.tip.flipX], [30, 0.5, 0.3, true]);
    assert.ok(r.report.some((l) => /Transfer/.test(l)));
    assert.equal(r.preset.transfer.enabled, false);
  }
  const computed = ABR.brushFromAgPsd({ name: 'Hard', shape: { type: 'computed', size: 12, hardness: 1, angle: 0, roundness: 1, spacing: 0.25, spacingOn: false } });
  assert.deepEqual([computed.preset.tip.kind, computed.preset.tip.size, computed.preset.tip.hardness, computed.preset.tip.spacingOn], ['computed', 12, 1, false]);
  assert.deepEqual(computed.blobs, {});
  // the swatch file stub (gated on ACO_ASE_REAL): empty results with a report line, never a throw
  if (!ACO.ACO_ASE_REAL) {
    for (const parse of [ACO.parseAse, ACO.parseAco]) {
      const res = parse(new Uint8Array([1, 2, 3]));
      assert.deepEqual([res.groups, res.colors, res.report.length], [[], [], 1]);
    }
    assert.equal(ACO.writeAse({ colors: [] }).bytes.length, 0);
  }
});
