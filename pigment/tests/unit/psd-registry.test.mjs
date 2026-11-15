// The PSD mapper registries of the 0.5 skeleton (ARCHITECTURE.md "0.5 features", S4): order, the builtin rule,
// claims, notices (0.4's texts), the merged feature flags, the Node-safe imports (io.js with every mapper loaded) and
// the ag-psd internals entry behind '#ag-psd'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// the guard of S4.1: io.js imports lib/psd/index.js, which loads the registry, the built-ins and every mapper file
const io = await import('../../src/renderer/lib/io.js');
const R = await import('../../src/renderer/lib/psd/registry.js');
const { createReport } = await import('../../src/renderer/lib/psd/report.js');
const PSD_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'renderer', 'lib', 'psd');

test('every lib/psd file imports in Node; io.js keeps 0.4\'s PSD exports', async () => {
  for (const f of readdirSync(PSD_DIR).filter((n) => n.endsWith('.js'))) await import(pathToFileURL(join(PSD_DIR, f)).href);
  for (const name of ['readPsdDocument', 'writePsdDocument', 'adjustmentToPsd', 'adjustmentFromPsd', 'blendIfToPsd', 'blendIfFromPsd', 'psdExpressible', 'cssFamilyFromPsFont']) assert.equal(typeof io[name], 'function', name);
  assert.equal(typeof io.PSD_TEXT_KEYS, 'object');
  assert.equal(io.cssFamilyFromPsFont('Arial-BoldMT'), 'Arial');
});

test('the built-in and stub mappers are registered in S4.3\'s order', () => {
  assert.deepEqual(R.psdLayerKinds().map((k) => [k.id, k.order]), [['group', 100], ['adjustment', 200], ['text', 400], ['raster', 900]]);
  const aspects = R.psdAspects().map((a) => a.id);
  assert.deepEqual(aspects, ['common', 'adjustment-placeholder', 'blend-if', 'raster-mask', 'notices']);
  assert.deepEqual(R.psdResources().map((r) => [r.id, r.order]), [['resolution', 100], ['guides', 200], ['composite', 900]]);
  // read: the first kind whose test passes builds the layer
  const first = (pl) => R.psdLayerKinds().find((k) => !k.test || k.test(pl, {})).id;
  assert.equal(first({ children: [] }), 'group');
  assert.equal(first({ adjustment: { type: 'invert' } }), 'adjustment');
  assert.equal(first({ text: { text: 'Hi' } }), 'text');
  assert.equal(first({ left: 0, top: 0 }), 'raster');
});

test('the same id: the later registration wins; a builtin never replaces an earlier one; unregistering removes it', () => {
  const off1 = R.registerPsdLayerKind({ id: 'test-kind', order: 350, test: () => false, label: 'package' });
  const off2 = R.registerPsdLayerKind({ id: 'test-kind', order: 360, test: () => false, label: 'builtin' }, { builtin: true });
  let k = R.psdLayerKinds().find((x) => x.id === 'test-kind');
  assert.equal(k.label, 'package');
  off2();
  R.registerPsdLayerKind({ id: 'test-kind', order: 340, test: () => false, label: 'later' });
  k = R.psdLayerKinds().find((x) => x.id === 'test-kind');
  assert.equal(k.label, 'later');
  assert.deepEqual(R.psdLayerKinds().map((x) => x.id).slice(0, 4), ['group', 'adjustment', 'test-kind', 'text']);
  R.psdLayerKinds().find((x) => x.id === 'test-kind');
  off1(); // the first registration was replaced: removing it is a no-op
  assert.ok(R.psdLayerKinds().some((x) => x.id === 'test-kind'));
  R.registerPsdLayerKind({ id: 'test-kind', order: 340, test: () => false })();
  assert.ok(!R.psdLayerKinds().some((x) => x.id === 'test-kind'));
  assert.throws(() => R.registerPsdAspect({ id: 'x' }), /order/);
  assert.throws(() => R.registerPsdResource({ order: 1 }), /id/);
});

test('the notices aspect counts what no mapper claimed: a notice disappears exactly when a mapper claims the feature', () => {
  const notices = R.psdAspects().find((a) => a.id === 'notices');
  const run = (layer, parts = []) => {
    const report = createReport();
    notices.write(layer, {}, { report, claimed: (l, p) => parts.includes(p), asShown: () => true });
    return { styled: report.count('styled'), text: report.count('pixel-text') };
  };
  const styled = { type: 'raster', styles: { dropShadow: { enabled: true } }, blending: null };
  assert.deepEqual(run(styled), { styled: 1, text: 0 });
  assert.deepEqual(run(styled, ['effects']), { styled: 0, text: 0 });
  const knockout = { type: 'raster', styles: null, blending: { knockout: 'deep' } };
  assert.deepEqual(run(knockout), { styled: 1, text: 0 });
  assert.deepEqual(run(knockout, ['advanced-blending']), { styled: 0, text: 0 });
  // Blend If alone is written by the built-in blend-if aspect: no notice
  assert.deepEqual(run({ type: 'raster', blending: { blendIf: { gray: { this: [0, 0, 200, 255], under: [0, 0, 255, 255] } } } }), { styled: 0, text: 0 });
  const text = { type: 'text', font: { color: '#000000' }, pathText: null };
  assert.deepEqual(run(text), { styled: 0, text: 1 });
  assert.deepEqual(run(text, ['text']), { styled: 0, text: 0 });
});

test('the built-in notices keep 0.4\'s texts; open notices are lines of their own', () => {
  const report = createReport();
  report.add('styled');
  report.add('no-psd-adjustment', 'Gradient Fill');
  report.add('no-psd-adjustment', 'Gradient Fill');
  report.add('pixel-text');
  report.add('guides-origin', { lost: 1, origin: true });
  report.add('unknown-code');
  assert.deepEqual(report.lines('save'), [
    '1 layer with layer effects or Blending Options was saved without them: PSD files from Pigment do not keep effects yet',
    '2 adjustment layers (Gradient Fill) have no PSD equivalent and were saved as hidden empty layers, without their settings',
    'PSD does not keep 1 guide outside the canvas or the ruler origin: they were not saved',
    '1 text layer with formatting PSD text cannot hold yet was saved as pixels',
  ]);
  assert.deepEqual(report.notices('save').map((n) => n.timeout), [4000, 5000, 4000, 4000]);
  const two = createReport();
  two.add('other-space');
  two.add('other-space');
  two.add('colorized');
  assert.deepEqual(two.lines(), [
    '2 Levels or Curves layers in a Gray, CMYK or Lab channel space were saved without their settings: PSD keeps RGB channels only',
    '1 Hue/Saturation layer set to Colorize was saved without Colorize',
  ]);
  R.registerPsdNotice('test-dropped', { when: 'open', text: (n, d) => `${n} layer effect${n === 1 ? '' : 's'} Pigment does not have ${n === 1 ? 'was' : 'were'} dropped: ${d.join(', ')}` });
  const open = createReport();
  open.add('test-dropped', 'Outer Glow (contour)');
  open.add('test-dropped', 'Satin');
  open.add('styled');
  assert.deepEqual(open.lines('open'), ['2 layer effects Pigment does not have were dropped: Outer Glow (contour), Satin']);
  assert.equal(open.lines('save').length, 1);
  // the same code again: the later wins, a builtin does not replace
  R.registerPsdNotice('test-dropped', { when: 'open', text: () => 'builtin' }, { builtin: true });
  assert.notEqual(open.lines('open')[0], 'builtin');
});

test('psdFeatures merges the mapper files\' PSD_FEATURES: a flag is true when any file says so', () => {
  const f = R.psdFeatures();
  for (const k of ['effects', 'advancedBlending', 'vectorMasks', 'shapes', 'fills', 'tags', 'globalLight', 'textRuns']) assert.equal(typeof f[k], 'boolean', k);
  const before = f.testFlag;
  R.registerPsdFeatures({ testFlag: false });
  R.registerPsdFeatures({ testFlag: true });
  R.registerPsdFeatures({ testFlag: false });
  assert.equal(before, undefined);
  assert.equal(R.psdFeatures().testFlag, true);
});

test('ag-psd options pass through the registered hooks, in order', () => {
  assert.deepEqual(R.psdOptions('write', { generateThumbnail: true, noBackground: true }), { generateThumbnail: true, noBackground: true });
  const off = R.registerPsdOptions({ write: (o) => ({ ...o, compress: true }), read: (o) => ({ ...o, useImageData: false }) });
  assert.deepEqual(R.psdOptions('write', { generateThumbnail: true }), { generateThumbnail: true, compress: true });
  assert.deepEqual(R.psdOptions('read', { skipThumbnail: true }), { skipThumbnail: true, useImageData: false });
  off();
  assert.deepEqual(R.psdOptions('read', { skipThumbnail: true }), { skipThumbnail: true });
});

test('#ag-psd loads the bundle entry with every fix and every internal of S4.5', async () => {
  const ag = await import('#ag-psd');
  for (const name of ['readPsd', 'writePsd', 'writePsdUint8Array', 'initializeCanvas', 'readAbr', 'readCsh', 'readAse', 'readPattern', 'writePattern', 'createReader', 'createWriter', 'readVersionAndDescriptor', 'writeVersionAndDescriptor', 'parseEffects', 'serializeEffects', 'parseVectorContent', 'parseBrushDescriptor']) assert.equal(typeof ag[name], 'function', name);
  assert.equal(ag.grdmPatched, true);
  assert.equal(ag.fixesPatched.grdm, true);
  assert.equal(typeof ag.fixesPatched.layers, 'boolean');
  assert.equal(typeof ag.fixesPatched.text, 'boolean');
  // parseBrushDescriptor reads a computed tip as readAbr does
  const b = ag.parseBrushDescriptor({ 'Nm  ': 'Hard', Brsh: { _classID: 'computedBrush', Dmtr: { units: 'Pixels', value: 30 }, Angl: { units: 'Angle', value: 45 }, Rndn: { units: 'Percent', value: 50 }, Intr: true, Spcn: { units: 'Percent', value: 25 }, Hrdn: { units: 'Percent', value: 100 }, flipX: false, flipY: false }, Spcn: { units: 'Percent', value: 25 }, Wtdg: false, Nose: false, useBrushSize: true });
  assert.equal(b.name, 'Hard');
  assert.deepEqual({ ...b.shape }, { type: 'computed', size: 30, angle: 45, roundness: 0.5, spacingOn: true, spacing: 0.25, flipX: false, flipY: false, hardness: 1 });
});

test('convert.js: a Lab colour goes through fromLab (no longer black or white); blend names round-trip', async () => {
  const C = await import('../../src/renderer/lib/psd/convert.js');
  assert.equal(C.rgbFromPsd({ l: 53.24, a: 80.09, b: 67.2 }), '#ff0000');
  assert.equal(C.rgbFromPsd({ l: 50, a: 0, b: 0 }), '#777777');
  assert.equal(C.rgbFromPsd({ r: 10, g: 20, b: 30 }), '#0a141e');
  assert.equal(C.rgbFromPsd(null, '#123456'), '#123456');
  for (const m of ['normal', 'multiply', 'color-burn', 'pass-through', 'linear-light']) assert.equal(C.psdBlend(C.toPsdBlend(m)), m);
  // gradients both ways (0.4's Gradient Map mapping)
  const g = C.gradientToPsd({ stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ff0000' }] });
  assert.equal(g.methodCode, 'Gcls');
  assert.deepEqual(C.gradientFromPsd(g), { stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ff0000' }], reverse: false, dither: false });
  // patterns: pixels to PatternInfo and back
  const data = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]);
  const info = C.patternToPsd({ name: 'Two', width: 2, height: 1, data });
  assert.deepEqual(info.bounds, { x: 0, y: 0, w: 2, h: 1 });
  assert.match(info.id, /^pigment-[0-9a-f]{16}$/);
  assert.deepEqual(Array.from(C.patternFromPsd(info).data), Array.from(data));
  assert.equal(C.patternToPsd({ name: 'Two', width: 2, height: 1, data }).id, info.id);
});
