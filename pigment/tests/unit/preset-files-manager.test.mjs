// preset-files-manager (ARCHITECTURE.md "0.5 features", package 10): Photoshop's preset files read and written on bytes
// these tests build (no Photoshop file is used), truncated and damaged files (never a throw), the 64 MB refusal, the
// .pigment-bundle round trip with groups, side files and settings, and Migrate Presets from a presets folder.
// Content assertions of .asl / .csh gate on psdFeatures() (psd-layers' half), those of .tpl dynamics on ABR_REAL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PresetStore, registerPresetKind } from '../../src/renderer/lib/presets.js';
import { normalizeBrush, blobsOf, withoutSampleData } from '../../src/renderer/lib/brush/preset.js';
import { normalizeGradient } from '../../src/shared/pixels/gradient-model.js';
import { encodeRgba8, decodePng, toRgba8 } from '../../src/shared/pixels/png.js';
import * as F from '../../src/renderer/lib/preset-formats.js';
import * as ACO from '../../src/renderer/lib/preset-files/aco-ase.js';
import * as PAT from '../../src/renderer/lib/preset-files/pat.js';
import * as GRD from '../../src/renderer/lib/preset-files/grd.js';
import * as CSH from '../../src/renderer/lib/preset-files/csh.js';
import * as TPL from '../../src/renderer/lib/preset-files/tpl.js';
import * as BUNDLE from '../../src/renderer/lib/preset-files/bundle.js';
import { folderBundle } from '../../src/renderer/lib/preset-files/migrate.js';
import { Writer, MAX_PRESET_FILE } from '../../src/renderer/lib/preset-files/bytes.js';
import { T, writeDescriptor } from '../../src/renderer/lib/preset-files/descriptor.js';
import { ABR_REAL } from '../../src/renderer/lib/brush/abr.js';
import { psdFeatures } from '../../src/renderer/lib/psd/registry.js';
import { readAse, readCsh, readPattern, createReader, writePattern, createWriter } from '#ag-psd';

// .asl patterns become PatternRefs through psd-layers' patternRefFromPsd, which needs a canvas: the smallest stand-in
globalThis.ImageData ??= class { constructor(d, w, h) { Object.assign(this, { data: d, width: w, height: h }); } };
globalThis.document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ({ putImageData() {} }), toDataURL: () => 'data:image/png;base64,AAAA' }) };
const ASL = await import('../../src/renderer/lib/preset-files/asl.js');

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// the kinds as the skeleton and their owners register them (preset-kinds.js is not Node-safe)
registerPresetKind('brushes', { title: 'Brushes', version: 1, builtins: () => ({ presets: [] }), normalize: (d) => (isObject(d) ? withoutSampleData(normalizeBrush(d)) : null), blobs: (d) => blobsOf(d) });
registerPresetKind('patterns', { title: 'Patterns', version: 1, builtins: () => ({ presets: [{ id: 'checkerboard', name: 'Checkerboard', data: { width: 16, height: 16, builtin: 'checkerboard', mode: 'rgb' } }] }), normalize: (d) => (isObject(d) && (typeof d.blob === 'string' || typeof d.builtin === 'string') ? d : null), blobs: (d) => (typeof d?.blob === 'string' ? [d.blob] : []) });
registerPresetKind('tool-presets', { title: 'Tool Presets', version: 1, builtins: () => ({ presets: [] }), normalize: (d) => (isObject(d) && typeof d.tool === 'string' ? d : null) });
registerPresetKind('gradients', { title: 'Gradients', version: 1, builtins: () => ({ presets: [{ id: 'bw', name: 'Black, White', data: normalizeGradient(null) }] }), normalize: (d) => (isObject(d) ? normalizeGradient(d, { keepRefs: true }) : null) });
registerPresetKind('swatches', { title: 'Swatches', version: 1, builtins: () => ({ presets: [{ id: 'default-0', name: '#ff0000', data: { color: { space: 'rgb', values: [255, 0, 0] } } }] }), normalize: (d) => (isObject(d) && isObject(d.color) ? d : null) });
registerPresetKind('shapes', { title: 'Shapes', version: 1, builtins: () => ({ presets: [] }), normalize: (d) => (isObject(d) && isObject(d.path) ? d : null) });
registerPresetKind('styles', { title: 'Styles', version: 1, builtins: () => ({ presets: [] }), normalize: (d) => (isObject(d) && isObject(d.styles) ? d : null) });

ACO.registerSwatchFormats();
PAT.registerPatFormat();
GRD.registerGrdFormat();
CSH.registerCshFormat();
// the multi-kind formats (the app is only needed for dialogs and pattern pixels of a write)
ASL.registerAslFormat(null);
TPL.registerTplFormat(null);

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
  const app = { presets: new PresetStore({ backend, delay: 1 }), blobs, files, settings: {} };
  F.installPresetFormats(app);
  return app;
}

/** A seeded generator (the damaged-file tests are reproducible). */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 4294967296);
}

/** Every reader on cut and scrambled copies of `bytes`: never a throw, always a report or a result. */
async function neverThrows(read, bytes) {
  const rand = rng(bytes.length);
  const cuts = [0, 1, 4, 7, 12, Math.floor(bytes.length / 3), Math.floor(bytes.length / 2), bytes.length - 1];
  for (const n of cuts) {
    const res = await read(bytes.slice(0, Math.max(0, n)));
    assert.ok(res && typeof res === 'object', `cut at ${n}`);
  }
  for (let k = 0; k < 12; k++) {
    const copy = bytes.slice();
    for (let j = 0; j < 6; j++) copy[Math.floor(rand() * copy.length)] = Math.floor(rand() * 256);
    const res = await read(copy);
    assert.ok(res && typeof res === 'object');
  }
}

test('flags: the swatch file stub is replaced (ACO_ASE_REAL)', () => {
  assert.equal(ACO.ACO_ASE_REAL, true);
});

test('.ase: groups, the four colour models and the swatch types round trip; ag-psd reads what Pigment writes', async () => {
  const colors = [{ name: 'Red', color: { space: 'rgb', values: [255, 0, 0] }, type: 'global' }, { name: 'Ink', color: { space: 'cmyk', values: [10, 20, 30, 40] }, type: 'process' }];
  const groups = [{ name: 'Brand', colors: [{ name: 'Lab', color: { space: 'lab', values: [50, -20, 30] }, type: 'spot' }, { name: 'Gray', color: { space: 'gray', values: [25] }, type: 'process' }] }];
  const { bytes, report } = ACO.writeAse({ groups, colors });
  assert.deepEqual(report, []);
  const back = ACO.parseAse(bytes);
  assert.deepEqual(back.report, []);
  assert.deepEqual(back.colors.map((c) => [c.name, c.type]), [['Red', 'global'], ['Ink', 'process']]);
  assert.equal(back.groups[0].name, 'Brand');
  assert.deepEqual(back.groups[0].colors.map((c) => c.color), [{ space: 'lab', values: [50, -20, 30] }, { space: 'gray', values: [25] }]);
  assert.equal(back.all.length, 4);
  for (const [i, v] of [10, 20, 30, 40].entries()) assert.ok(Math.abs(back.colors[1].color.values[i] - v) < 1e-3);
  // ag-psd's reader (an independent implementation) agrees
  const ag = readAse(bytes);
  assert.deepEqual(ag.colors[0], { name: 'Red', color: { r: 1, g: 0, b: 0, type: 'global' } });
  assert.equal(ag.colors[2].name, 'Brand');
  assert.equal(ag.colors[2].colors[0].color.type, 'spot');
  // a file the test builds by hand: one RGB colour of type 2 (normal), as Illustrator writes them
  const name = 'From ASE';
  const blockLen = 2 + (name.length + 1) * 2 + 4 + 12 + 2;
  const ase = new Uint8Array(12 + 6 + blockLen);
  const dv = new DataView(ase.buffer);
  ase.set([65, 83, 69, 70]);
  dv.setUint16(4, 1);
  dv.setUint32(8, 1);
  dv.setUint16(12, 1);
  dv.setUint32(14, blockLen);
  dv.setUint16(18, name.length + 1);
  for (let i = 0; i < name.length; i++) dv.setUint16(20 + i * 2, name.charCodeAt(i));
  const o = 20 + (name.length + 1) * 2;
  ase.set([82, 71, 66, 32], o);
  dv.setFloat32(o + 4, 0.5);
  dv.setFloat32(o + 12, 1);
  dv.setUint16(o + 16, 2);
  const one = ACO.parseAse(ase);
  assert.deepEqual(one.colors, [{ name, color: { space: 'rgb', values: [127.5, 0, 255] }, type: 'process' }]);
  // truncated: what came before the damage, and a report
  const cut = ACO.parseAse(bytes.slice(0, 60));
  assert.equal(cut.all.length, 1);
  assert.match(cut.report[0], /truncated/);
  assert.match(ACO.parseAse(new Uint8Array([1, 2, 3, 4])).report[0], /not an Adobe Swatch Exchange file/);
  await neverThrows((b) => ACO.parseAse(b), bytes);
});

test('.aco: versions 1 and 2 built by hand (RGB, HSB, CMYK, Lab, Grayscale, a Pantone colour), names, round trip', () => {
  const recs = [[0, [65535, 32768, 0, 0], 'Orange'], [1, [0, 65535, 65535, 0], 'HSB Red'], [2, [65535, 0, 65535, 0], 'Magenta Ink'], [7, [5000, (-2000) & 0xffff, 3000, 0], 'Lab'], [8, [2500, 0, 0, 0], 'Quarter'], [3, [12, 0, 0, 0], 'PMS']];
  const w = new Writer();
  for (const version of [1, 2]) {
    w.u16(version);
    w.u16(recs.length);
    for (const [space, words, name] of recs) {
      w.u16(space);
      for (const x of words) w.u16(x);
      if (version === 2) w.ustr(name);
    }
  }
  const res = ACO.parseAco(w.done());
  assert.deepEqual(res.colors.map((c) => c.name), ['Orange', 'HSB Red', 'Magenta Ink', 'Lab', 'Quarter']);
  assert.deepEqual(res.colors[0].color, { space: 'rgb', values: [255, 127.5019, 0] });
  assert.deepEqual(res.colors[1].color, { space: 'rgb', values: [255, 0, 0] });
  assert.deepEqual(res.colors[2].color, { space: 'cmyk', values: [0, 100, 0, 100] });
  assert.deepEqual(res.colors[3].color, { space: 'lab', values: [50, -20, 30] });
  assert.deepEqual(res.colors[4].color, { space: 'gray', values: [25] });
  assert.match(res.report.join('\n'), /1 Pantone colour-book colours was skipped/);
  // version 1 alone: colours named by their hex
  const v1 = ACO.parseAco(w.done().slice(0, 4 + recs.length * 10));
  assert.equal(v1.colors[0].name, '#ff8000');
  // the writer: version 1 then version 2, which Pigment reads back with names
  const out = ACO.writeAco({ colors: res.colors });
  const again = ACO.parseAco(out.bytes);
  assert.deepEqual(again.colors.map((c) => [c.name, c.color.space]), res.colors.map((c) => [c.name, c.color.space]));
  assert.deepEqual(again.colors[2].color.values, [0, 100, 0, 100]);
  assert.match(ACO.parseAco(new Uint8Array([0, 9])).report[0], /not a Photoshop swatches/);
});

test('swatch files through the store: a group named after the file, ASE groups inside it, export by group', async () => {
  const app = makeApp();
  await app.presets.ready('swatches');
  const { bytes } = ACO.writeAse({ colors: [{ name: 'Loose', color: { space: 'rgb', values: [1, 2, 3] } }], groups: [{ name: 'Inner', colors: [{ name: 'In', color: { space: 'rgb', values: [4, 5, 6] } }] }] });
  const res = await F.importPresetBytes(app, [{ name: 'Brand Colours.ase', bytes }]);
  assert.deepEqual(res.added, { swatches: 2 });
  const groups = app.presets.groups('swatches');
  const file = groups.find((g) => g.name === 'Brand Colours');
  assert.ok(file);
  assert.equal(groups.find((g) => g.name === 'Inner').parent, file.id);
  // .aco export through the store writes every colour; .ase keeps the groups
  const loose = app.presets.list('swatches').filter((p) => p.name === 'Loose' || p.name === 'In').map((p) => p.id);
  const aco = await F.exportPresetBytes(app, 'swatches', loose, 'aco');
  assert.equal(aco.ext, 'aco');
  assert.deepEqual(ACO.parseAco(aco.bytes).colors.map((c) => c.name).sort(), ['In', 'Loose']);
  const ase = await F.exportPresetBytes(app, 'swatches', loose, 'ase');
  assert.deepEqual(ACO.parseAse(ase.bytes).groups.map((g) => g.name).sort(), ['Brand Colours', 'Inner']);
});

test('.pat: RGB with transparency, Grayscale and Indexed records built by hand, ag-psd interop, the store read', async () => {
  const w = 5, h = 3;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([i * 10, 255 - i, i % 2 ? 0 : 200, i === 4 ? 128 : 255], i * 4);
  const png = await encodeRgba8({ width: w, height: h, data });
  const blobs = { 'a.png': png };
  const { bytes, report } = await PAT.writePatFile([{ name: 'Test', data: { width: w, height: h, blob: 'a.png' } }, { name: 'Checker', data: { builtin: 'checkerboard', width: 16, height: 16 } }, { name: 'Gone', data: { blob: 'x.png' } }], { readBlob: (n) => blobs[n] });
  assert.match(report[0], /"Gone": its pixels are missing/);
  const back = await PAT.readPatFile(bytes, { name: 'Mine.pat' });
  assert.deepEqual(back.report, []);
  assert.deepEqual(back.groups, [{ id: 'file', name: 'Mine' }]);
  assert.deepEqual(back.presets.map((p) => [p.name, p.data.width, p.data.height, p.group]), [['Test', 5, 3, 'file'], ['Checker', 16, 16, 'file']]);
  const px = toRgba8(await decodePng(back.blobs[back.presets[0].data.blob]));
  assert.deepEqual(Array.from(px.data), Array.from(data));
  // ag-psd reads a record Pigment writes (it drops the alpha), Pigment reads one ag-psd writes (alpha kept)
  const o = new Writer();
  PAT.writePatternList(o, [{ name: 'X', id: 'abc', width: w, height: h, data }]);
  const list = o.done();
  const ag = readPattern(createReader(list.buffer, list.byteOffset, list.byteLength));
  assert.deepEqual([ag.name, ag.id, ag.bounds.w, ag.bounds.h, ag.data[4]], ['X', 'abc', 5, 3, 10]);
  const aw = createWriter(4096);
  writePattern(aw, { name: 'Y', id: 'z', x: 0, y: 0, bounds: { x: 0, y: 0, w, h }, data: new Uint8Array(data.buffer) });
  const fromAg = PAT.readPatternList(new Uint8Array(aw.buffer, 0, aw.offset));
  assert.deepEqual(Array.from(fromAg.patterns[0].data), Array.from(data));
  // Grayscale (mode 1) and Indexed (mode 2), raw channels, written here byte by byte
  const record = (mode, plane, palette = null) => {
    const r = new Writer();
    r.u32(1);
    r.u32(mode);
    r.i16(2);
    r.i16(2);
    r.ustr(mode === 1 ? 'Grey' : 'Indexed');
    r.pascal('id', 1);
    if (palette) {
      r.bytes(palette);
      r.zeros(4);
    }
    r.u32(3);
    const vmal = r.lengthField();
    for (const v of [0, 0, 2, 2, 1]) r.u32(v);
    r.u32(1);
    const len = r.lengthField();
    for (const v of [8, 0, 0, 2, 2]) r.u32(v);
    r.u16(8);
    r.u8(0);
    r.bytes(plane);
    len();
    r.u32(0);
    r.u32(0);
    vmal();
    return r.done();
  };
  const pal = new Uint8Array(768);
  pal.set([10, 20, 30], 3);
  const file = new Writer();
  file.sig('8BPT');
  file.u16(1);
  file.u32(2);
  file.bytes(record(1, new Uint8Array([0, 85, 170, 255])));
  file.bytes(record(2, new Uint8Array([1, 0, 1, 0]), pal));
  const two = await PAT.readPatFile(file.done(), { name: 'Hand.pat' });
  assert.deepEqual(two.report, []);
  const grey = toRgba8(await decodePng(two.blobs[two.presets[0].data.blob]));
  assert.deepEqual(Array.from(grey.data.slice(4, 8)), [85, 85, 85, 255]);
  const idx = toRgba8(await decodePng(two.blobs[two.presets[1].data.blob]));
  assert.deepEqual(Array.from(idx.data.slice(0, 8)), [10, 20, 30, 255, 0, 0, 0, 255]);
  // truncated and damaged
  assert.match((await PAT.readPatFile(bytes.slice(0, 100))).report[0], /truncated/);
  await neverThrows((b) => PAT.readPatFile(b), bytes);
});

test('.grd: solid (midpoints, transparency, Foreground stops, smoothness, method) and noise gradients round trip', async () => {
  const sunset = { gradientVersion: 2, type: 'solid', interpolation: 'perceptual', smoothness: 0.5, stops: [{ pos: 0, mid: 0.5, color: '#ff8000' }, { pos: 0.25, mid: 0.3, color: { ref: 'fg' } }, { pos: 1, mid: 0.5, color: '#102030' }], opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.7, opacity: 0.25 }] };
  const noise = { gradientVersion: 2, type: 'noise', noise: { roughness: 0.75, model: 'hsb', min: [0, 0.1, 0.2], max: [1, 0.9, 0.8], restrict: true, transparency: false, seed: 42 } };
  const stripes = { gradientVersion: 2, type: 'solid', interpolation: 'stripes', stops: [{ pos: 0, mid: 0.5, color: '#000000' }, { pos: 1, mid: 0.5, color: '#ffffff' }] };
  const { bytes, report } = GRD.writeGrdFile([{ name: 'Sunset', data: sunset }, { name: 'Noisy', data: noise }, { name: 'Bars', data: stripes }]);
  assert.match(report[0], /Stripes method is written as Classic/);
  const back = await GRD.readGrdFile(bytes, { name: 'Mine.grd' });
  assert.deepEqual(back.report, []);
  assert.deepEqual(back.presets.map((p) => p.name), ['Sunset', 'Noisy', 'Bars']);
  assert.deepEqual(back.presets[0].data, normalizeGradient(sunset, { keepRefs: true }));
  assert.deepEqual(back.presets[1].data.noise, noise.noise);
  assert.equal(back.presets[2].data.interpolation, 'classic');
  // a file whose descriptor the test writes as Photoshop does: no method key (read as Classic), an HSB colour, a
  // background stop, 'Intr' 4096
  const stop = (clr, type, at) => T.obj('Clrt', { 'Clr ': clr, Type: T.enm('Clry', type), Lctn: T.long(at), Mdpn: T.long(50) });
  const ps = new Writer();
  ps.sig('8BGR');
  ps.u16(5);
  writeDescriptor(ps, T.obj('null', { GrdL: T.list([T.obj('Grdn', { Grad: T.obj('Grdn', {
    'Nm  ': T.text('$$$/DefaultGradient/Name=Violet, Orange'), GrdF: T.enm('GrdF', 'CstS'), Intr: T.doub(4096),
    Clrs: T.list([stop(T.obj('HSBC', { 'H   ': T.ang(0), Strt: T.doub(100), Brgh: T.doub(100) }), 'UsrS', 0), stop(T.obj('RGBC', { 'Rd  ': T.doub(0), 'Grn ': T.doub(0), 'Bl  ': T.doub(0) }), 'BckC', 4096)]),
    Trns: T.list([T.obj('TrnS', { Opct: T.pct(1), Lctn: T.long(0), Mdpn: T.long(50) }), T.obj('TrnS', { Opct: T.pct(0.5), Lctn: T.long(4096), Mdpn: T.long(50) })]),
  }) })]) }));
  const ph = await GRD.readGrdFile(ps.done(), { name: 'Photoshop.grd' });
  assert.equal(ph.presets[0].name, 'Violet, Orange');
  assert.deepEqual(ph.presets[0].data.stops.map((s) => s.color), ['#ff0000', { ref: 'bg' }]);
  assert.equal(ph.presets[0].data.interpolation, 'classic');
  assert.deepEqual(ph.presets[0].data.opacityStops.map((s) => s.opacity), [1, 0.5]);
  assert.match(ph.report.join('\n'), /converted to RGB/);
  // version 3 and damage
  const v3 = new Uint8Array([56, 66, 71, 82, 0, 3, 0, 0]);
  assert.match((await GRD.readGrdFile(v3)).report[0], /Photoshop 5/);
  assert.match((await GRD.readGrdFile(bytes.slice(0, 60))).report[0], /truncated or damaged/);
  await neverThrows((b) => GRD.readGrdFile(b), bytes);
});

test('.csh: shapes round trip through ag-psd\'s readCsh, with their proportions and subpath operations', async () => {
  const tri = { subpaths: [{ closed: true, points: [{ x: 0.5, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1, inX: 0.1, inY: 0.9, outX: -0.1, outY: 1.1 }] }, { closed: true, op: 'subtract', points: [{ x: 0.4, y: 0.5 }, { x: 0.6, y: 0.5 }, { x: 0.5, y: 0.7 }] }] };
  const { bytes, report } = CSH.writeCshFile([{ name: 'Tri', data: { path: tri, width: 200, height: 100 } }, { name: 'Square', data: { path: tri } }, { name: 'None', data: {} }]);
  assert.match(report[0], /"None" has no outline/);
  assert.deepEqual(readCsh(bytes).shapes.map((s) => [s.name, s.width, s.height, s.paths.length]), [['Tri', 200, 100, 2], ['Square', 100, 100, 2]]);
  const back = await CSH.readCshFile(bytes, { name: 'Mine.csh' });
  if (psdFeatures().vectorMasks) {
    assert.deepEqual(back.report, []);
    assert.deepEqual(back.presets.map((p) => [p.name, p.data.width, p.data.height]), [['Tri', 200, 100], ['Square', 100, 100]]);
    assert.deepEqual(back.presets[0].data.path, tri);
  } else {
    // psd-layers' pathFromPsd stub reads no outline
    assert.match(back.report[0], /once PSD vector masks/);
  }
  const cut = await CSH.readCshFile(bytes.slice(0, bytes.length - 30), { name: 'Cut.csh' });
  assert.match(cut.report.join('\n'), /damaged after 1 shape/);
  if (psdFeatures().vectorMasks) assert.equal(cut.presets.length, 1);
  await neverThrows((b) => CSH.readCshFile(b), bytes);
});

test('.asl: styles with their patterns ($presetRef), blending options and names round trip through psd-layers\' mappers', async () => {
  const w = 4, h = 4;
  const pix = new Uint8ClampedArray(w * h * 4).fill(200);
  const styles = {
    dropShadow: { enabled: true, blend: 'multiply', color: '#102030', opacity: 0.6, angle: 120, distance: 7, spread: 2, size: 9 },
    stroke: { enabled: true, size: 3, position: 'outside', blend: 'normal', opacity: 1, color: '#ff0000', fill: 'color' },
    patternOverlay: { enabled: true, blend: 'normal', opacity: 1, pattern: { presetId: 'pp1', name: 'Dots' }, scale: 1, angle: 0, link: true, origin: [0, 0] },
  };
  const { bytes, report } = await ASL.writeAslFile([{ name: 'Shadowy', data: { styles, blending: { knockout: 'shallow', interiorAsGroup: true } } }], { patternPixels: async (ref) => (ref.presetId === 'pp1' ? { width: w, height: h, data: pix } : null) });
  const back = await ASL.readAslFile(bytes, { name: 'Mine.asl' });
  const style = back.items.find((it) => it.kind === 'styles');
  assert.equal(style.name, 'Shadowy');
  assert.deepEqual(back.groups, [{ kind: 'styles', id: 'file', name: 'Mine' }]);
  assert.deepEqual(style.data.blending, { interiorAsGroup: true, knockout: 'shallow' });
  if (psdFeatures().effects) {
    assert.deepEqual(report, []);
    assert.deepEqual(back.report, []);
    assert.deepEqual(Object.keys(style.data.styles).sort(), ['dropShadow', 'patternOverlay', 'stroke']);
    assert.equal(style.data.styles.dropShadow.distance, 7);
    assert.equal(style.data.styles.stroke.color, '#ff0000');
    const pattern = back.items.find((it) => it.kind === 'patterns');
    assert.equal(pattern.name, 'Dots');
    assert.deepEqual(style.data.styles.patternOverlay.pattern, { $presetRef: { kind: 'patterns', ref: pattern.ref } });
    // through the importer: the pattern is added first and the style holds { presetId, name }
    const app = makeApp();
    const res = await F.importPresetBytes(app, [{ name: 'Mine.asl', bytes }]);
    assert.deepEqual(res.added, { patterns: 1, styles: 1 });
    const stored = app.presets.list('styles')[0];
    const pat = app.presets.list('patterns').find((p) => p.name === 'Dots');
    assert.deepEqual(stored.data.styles.patternOverlay.pattern, { presetId: pat.id, name: 'Dots' });
    const px = toRgba8(await decodePng(app.blobs.get(`patterns/${pat.data.blob}`)));
    assert.deepEqual(Array.from(px.data.slice(0, 4)), [200, 200, 200, 200]);
  } else {
    // psd-layers' stub reads no effects: the names and groups come in, the effects are reported
    assert.match(back.report.join('\n'), /once PSD layer effects/);
  }
  assert.match((await ASL.readAslFile(new Uint8Array(20), { name: 'x.asl' })).report[0], /not a Photoshop styles/);
  await neverThrows((b) => ASL.readAslFile(b), bytes);
});

test('.tpl: tool presets with a sampled, textured brush, a type preset, and a preset Photoshop-shaped (no Pigment data)', async () => {
  const w = 6, h = 4;
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) d.set([i * 10, i * 10, i * 10, 255], i * 4);
  const tipPng = await encodeRgba8({ width: w, height: h, data: d });
  const pat = { width: 2, height: 2, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 255]) };
  const brush = normalizeBrush({ tip: { kind: 'sampled', size: 30, sample: { blob: 'tip-abc.png', hash: 'abc', width: w, height: h } }, shapeDynamics: { enabled: true, sizeJitter: 0.4, sizeControl: { type: 'pen-pressure', fadeSteps: 25 } }, texture: { enabled: true, pattern: { presetId: 'pat1', name: 'P' }, scale: 0.5 } });
  const presets = [
    { name: 'Soft brush', data: { tool: 'brush', options: { opacity: 0.5, flow: 0.8, blend: 'multiply' }, brush } },
    { name: 'Big title', data: { tool: 'type', options: { orientationToggle: false }, type: { char: { fontFamily: 'Georgia', size: 72, color: '#336699' }, para: { align: 'center' } }, color: '#ff0000' } },
    { name: 'Not one', data: { options: {} } },
  ];
  const { bytes, report } = await TPL.writeTplFile(presets, { readBlob: (k, n) => (k === 'brushes' && n === 'tip-abc.png' ? tipPng : null), patternPixels: async (id) => (id === 'pat1' ? { name: 'P', ...pat } : null) });
  assert.deepEqual(report, ['"Not one" is not a tool preset and was left out']);
  const back = await TPL.readTplFile(bytes, { name: 'My.tpl' });
  assert.deepEqual(back.groups, [{ kind: 'tool-presets', id: 'file', name: 'My' }]);
  const soft = back.items.find((i) => i.name === 'Soft brush');
  const title = back.items.find((i) => i.name === 'Big title');
  const pattern = back.items.find((i) => i.kind === 'patterns');
  assert.deepEqual(soft.data.options, { opacity: 0.5, flow: 0.8, blend: 'multiply' });
  assert.equal(soft.data.brush.tip.kind, 'sampled');
  const [tipBlob] = Object.keys(soft.blobs);
  assert.equal(soft.data.brush.tip.sample.blob, tipBlob);
  const tip = toRgba8(await decodePng(soft.blobs[tipBlob]));
  assert.deepEqual([tip.width, tip.height, tip.data[4 * 5]], [6, 4, 50]);
  assert.deepEqual(title.data, { tool: 'type', options: { orientationToggle: false }, type: presets[1].data.type, color: '#ff0000' });
  if (ABR_REAL) {
    // brush-settings-panel's mapping: the dynamics and the texture come back (the texture names the file's pattern)
    assert.equal(soft.data.brush.shapeDynamics.sizeJitter, 0.4);
    assert.equal(soft.data.brush.shapeDynamics.sizeControl.type, 'pen-pressure');
    assert.equal(soft.data.brush.texture.enabled, true);
    assert.deepEqual(soft.data.brush.texture.pattern, { $presetRef: { kind: 'patterns', ref: pattern.ref } });
  }
  // through the importer: the tip goes to `brushes` (blobRefs), the pattern to `patterns`, the presets to their kind
  const app = makeApp();
  const res = await F.importPresetBytes(app, [{ name: 'My.tpl', bytes }]);
  assert.deepEqual(res.added, { patterns: 1, 'tool-presets': 2 });
  assert.ok(app.blobs.has(`brushes/${tipBlob}`));
  // a preset as Photoshop's own keys give it: a Pencil class with opacity and mode, a type tool with a text style
  const o = new Writer();
  o.sig('8BTP');
  o.u16(1);
  o.u16(2);
  o.sig('8BIM');
  o.sig('desc');
  const len = o.lengthField();
  writeDescriptor(o, T.obj('null', { Prst: T.list([
    T.obj('toolPreset', { 'Nm  ': T.text('Pencil 50%'), Tool: T.obj('pencilTool', { Opct: T.long(50), 'Md  ': T.enm('BlnM', 'Mltp') }) }),
    T.obj('toolPreset', { 'Nm  ': T.text('Caption'), Tool: T.obj('typeCreateOrEditTool', { TxtS: T.obj('TxtS', { fontPostScriptName: T.text('Georgia-Bold'), 'Sz  ': T.pnt(18), 'Clr ': T.obj('RGBC', { 'Rd  ': T.doub(255), 'Grn ': T.doub(0), 'Bl  ': T.doub(0) }) }) }) }),
    T.obj('toolPreset', { 'Nm  ': T.text('3D thing'), Tool: T.obj('threeDRotateTool', {}) }),
  ]) }));
  len();
  const ps = await TPL.readTplFile(o.done(), { name: 'Photoshop.tpl' });
  assert.deepEqual(ps.items.map((i) => [i.name, i.data.tool]), [['Pencil 50%', 'pencil'], ['Caption', 'type']]);
  assert.deepEqual(ps.items[0].data.options, { opacity: 0.5, blend: 'multiply' });
  assert.deepEqual(ps.items[1].data.type, { char: { postScriptName: 'Georgia-Bold', size: 18, color: '#ff0000' }, para: {} });
  assert.match(ps.report.join('\n'), /"3D thing" is a preset of a tool Pigment does not have/);
  assert.match((await TPL.readTplFile(new Uint8Array(12))).report[0], /not a Photoshop tool presets/);
  await neverThrows((b) => TPL.readTplFile(b), bytes);
});

test('files over 64 MB are refused with a message by every reader, before reading', async () => {
  const big = new Uint8Array(MAX_PRESET_FILE + 1);
  assert.match(ACO.parseAse(big).report[0], /over 64 MB/);
  assert.match(ACO.parseAco(big).report[0], /over 64 MB/);
  for (const read of [PAT.readPatFile, GRD.readGrdFile, CSH.readCshFile, BUNDLE.readBundle]) assert.match((await read(big)).report[0], /over 64 MB/);
  for (const read of [ASL.readAslFile, TPL.readTplFile]) assert.match((await read(big)).report[0], /over 64 MB/);
});

test('.pigment-bundle: presets, groups and side files of every kind, settings; a second import adds nothing', async () => {
  const app = makeApp();
  for (const k of ['gradients', 'patterns', 'brushes', 'swatches']) await app.presets.ready(k);
  const group = app.presets.addGroup('gradients', { name: 'Mine' });
  app.presets.add('gradients', { name: 'Red fade', group: group.id, data: { stops: [{ pos: 0, color: '#ff0000' }, { pos: 1, color: '#ff000000' }] } });
  app.presets.update('gradients', 'bw', { name: 'Black to White' });
  await app.presets.writeBlob('patterns', 'p-own.png', new Uint8Array([1, 2, 3]));
  app.presets.add('patterns', { name: 'Own', data: { width: 1, height: 1, blob: 'p-own.png', mode: 'rgb' } });
  const hash = 'a'.repeat(40);
  await app.presets.writeBlob('brushes', `tip-${hash}.png`, new Uint8Array([9, 9]));
  app.presets.add('brushes', { name: 'Sampled', data: { tip: { kind: 'sampled', size: 20, sample: { blob: `tip-${hash}.png`, hash, width: 1, height: 1 } } } });
  const settings = { tools: { brush: { size: 33 } }, keymap: { v: 1 }, theme: 'dark' };
  const bytes = await BUNDLE.writeBundle({ list: (k) => app.presets.list(k), groups: (k) => app.presets.groups(k), readBlob: (k, n) => app.presets.readBlob(k, n) }, { kinds: ['gradients', 'patterns', 'brushes', 'swatches'], settings });
  const parsed = await BUNDLE.readBundle(bytes);
  assert.deepEqual(parsed.report, []);
  // the user's presets and the changed built-in; no unchanged built-in, no swatches (none of the user's)
  assert.deepEqual(Object.keys(parsed.kinds).sort(), ['brushes', 'gradients', 'patterns']);
  assert.deepEqual(parsed.kinds.gradients.items.map((i) => i.name), ['Black to White', 'Red fade']);
  assert.deepEqual(parsed.settings, { tools: { brush: { size: 33 } }, keymap: { v: 1 } });
  assert.deepEqual(BUNDLE.bundleSettingsPatch(parsed.settings), { tools: { brush: { size: 33 } }, keymap: { v: 1 } });
  // into another library through the registered format (registered for that library: it skips what it holds)
  const other = makeApp();
  const off = BUNDLE.registerBundleFormat(other);
  try {
    const res = await F.importPresetBytes(other, [{ name: 'Mine.pigment-bundle', bytes }]);
    assert.deepEqual(res.added, { gradients: 2, patterns: 1, brushes: 1 });
    const red = other.presets.list('gradients').find((p) => p.name === 'Red fade');
    assert.equal(other.presets.groups('gradients').find((g) => g.id === red.group).name, 'Mine');
    // a pattern's pixel file gets a fresh name; a content-hashed tip keeps its own
    const own = other.presets.list('patterns').find((p) => p.name === 'Own');
    assert.notEqual(own.data.blob, 'p-own.png');
    assert.deepEqual(Array.from(other.blobs.get(`patterns/${own.data.blob}`)), [1, 2, 3]);
    assert.ok(other.blobs.has(`brushes/tip-${hash}.png`));
    // the same bundle again: every preset is already there
    const again = await F.importPresetBytes(other, [{ name: 'Mine.pigment-bundle', bytes }]);
    assert.deepEqual(again.added, {});
    assert.match(again.report.join('\n'), /4 presets were already in the library/);
    assert.equal(other.presets.groups('gradients').filter((g) => g.name === 'Mine').length, 1);
    // only some kinds (the import dialog's choice)
    const third = makeApp();
    BUNDLE.registerBundleFormat(third);
    const some = await BUNDLE.withBundleKinds(['patterns'], () => F.importPresetBytes(third, [{ name: 'x.pigment-bundle', bytes }]));
    assert.deepEqual(some.added, { patterns: 1 });
  } finally {
    off();
  }
  assert.match((await BUNDLE.readBundle(new Uint8Array([1, 2, 3]))).report[0], /not a Pigment bundle/);
  await neverThrows((b) => BUNDLE.readBundle(b), bytes);
});

test('Migrate Presets: an older Pigment\'s presets folder (kind files, side files, a settings folder) becomes a bundle', async () => {
  const old = makeApp();
  await old.presets.ready('gradients');
  await old.presets.ready('patterns');
  old.presets.add('gradients', { name: 'Old gradient', data: { stops: [{ pos: 0, color: '#00ff00' }, { pos: 1, color: '#0000ff' }] } });
  await old.presets.writeBlob('patterns', 'p-old.png', new Uint8Array([7, 7]));
  old.presets.add('patterns', { name: 'Old pattern', data: { width: 1, height: 1, blob: 'p-old.png', mode: 'rgb' } });
  await old.presets.flush();
  // the folder as the main process keeps it: <dir>/presets/<kind>.json and <dir>/presets/<kind>/<blob>
  const fs = new Map();
  for (const [kind, json] of old.files) fs.set(`/old/presets/${kind}.json`, new TextEncoder().encode(JSON.stringify(json)));
  for (const [key, b] of old.blobs) fs.set(`/old/presets/${key}`, b);
  const bridge = {
    readFile: async (p) => {
      if (!fs.has(p)) throw new Error(`No such file: ${p}`);
      return fs.get(p);
    },
    listDir: async (dir) => {
      if (dir === '/old') return [{ name: 'presets', isDir: true }, { name: 'settings.json', isDir: false }];
      const names = new Set([...fs.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1).split('/')[0]));
      return [...names].map((name) => ({ name, isDir: !name.endsWith('.json') }));
    },
  };
  const { bytes, found, report } = await folderBundle(bridge, '/old', ['gradients', 'patterns', 'swatches']);
  assert.equal(found, 2);
  assert.deepEqual(report, []);
  const off = BUNDLE.registerBundleFormat(null);
  try {
    const app = makeApp();
    const res = await F.importPresetBytes(app, [{ name: 'old.pigment-bundle', bytes }]);
    assert.deepEqual(res.added, { gradients: 1, patterns: 1 });
    const p = app.presets.list('patterns').find((x) => x.name === 'Old pattern');
    assert.deepEqual(Array.from(app.blobs.get(`patterns/${p.data.blob}`)), [7, 7]);
  } finally {
    off();
  }
});

test('the formats register where S10.1 says: one-kind formats in 0.4\'s registry, .asl .tpl and the bundle in 0.5\'s', () => {
  const offB = BUNDLE.registerBundleFormat(null);
  try {
    const of = (ext) => F.presetFileFormatFor(`x.${ext}`);
    assert.deepEqual(['pat', 'grd', 'ase', 'aco', 'csh'].map((e) => [of(e).id, of(e).store, of(e).kinds[0]]), [['pat', true, 'patterns'], ['grd', true, 'gradients'], ['ase', true, 'swatches'], ['aco', true, 'swatches'], ['csh', true, 'shapes']]);
    assert.deepEqual([of('asl').kinds, of('tpl').kinds, of('pigment-bundle').kinds], [['styles', 'patterns'], ['tool-presets', 'brushes', 'patterns'], ['*']]);
    // Export for a kind lists .pigment-presets first (0.4's default), then its Photoshop format
    const grd = F.presetFileFormats({ kind: 'gradients', write: true }).map((f) => f.id);
    assert.ok(grd.includes('grd') && grd.includes('pigment-presets'));
    assert.ok(F.opensAsPresets('/x/Set.grd') && F.opensAsPresets('a.ASE') && F.opensAsPresets('b.pigment-bundle'));
    assert.ok(!F.opensAsPresets('photo.png'));
  } finally {
    offB();
  }
});
