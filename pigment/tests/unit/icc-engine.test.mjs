// icc-engine (ARCHITECTURE.md "0.5 features", package 4): ICC profile parsing and writing, the generated profiles,
// and the transforms. LittleCMS runs here too (the npm module, lcms-wasm): the JavaScript kernels are checked against
// it, so the display stage and LittleCMS give the same numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as PR from '../../src/renderer/lib/color/profiles.js';
import * as T from '../../src/renderer/lib/color/transforms.js';
import { setLcms, lcms, lcmsTransform, runTransform, TYPE } from '../../src/renderer/lib/color/lcms.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LCMS_DIR = join(ROOT, 'node_modules', 'lcms-wasm', 'dist');
const hasLcms = existsSync(join(LCMS_DIR, 'lcms.wasm'));

async function withLcms() {
  if (lcms() || !hasLcms) return lcms();
  const mod = await import(join(LCMS_DIR, 'lcms.js'));
  setLcms(await mod.instantiate({ wasmBinary: readFileSync(join(LCMS_DIR, 'lcms.wasm')), print: () => {}, printErr: () => {} }));
  return lcms();
}

const rec = (id) => PR.BUILTIN_DEFS.find((d) => d.id === id) && { id, bytes: id === 'srgb' ? null : PR.builtinIcc(id), wellKnown: PR.BUILTIN_DEFS.find((d) => d.id === id).wellKnown };

test('sha1Hex matches node:crypto, also over block boundaries', () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 70000]) {
    const b = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 255);
    assert.equal(PR.sha1Hex(b), createHash('sha1').update(b).digest('hex'), `${n} bytes`);
  }
});

test('the generated profiles parse back: names, spaces, colorants, curves; the same bytes every time', () => {
  for (const def of PR.BUILTIN_DEFS) {
    const bytes = PR.builtinIcc(def.id);
    assert.deepEqual(PR.writeIcc(def), bytes, def.id);
    const p = PR.parseIcc(bytes);
    assert.equal(p.name, def.name);
    assert.equal(p.space, def.space);
    assert.equal(p.deviceClass, 'mntr');
    assert.equal(p.pcs, 'XYZ ');
    assert.equal(p.major, 4);
    assert.equal(p.lut, false);
    // the white maps to D50 (the colorants sum to the PCS white)
    if (def.space === 'rgb') {
      const { r, g, b } = p.matrix;
      for (let k = 0; k < 3; k++) assert.ok(Math.abs(r[k] + g[k] + b[k] - PR.D50[k]) < 0.0003, `${def.id} white ${k}`);
    }
    const rec = PR.profileRecord(bytes, 'builtin');
    assert.equal(rec.wellKnown, def.wellKnown);
    assert.equal(rec.colorSpace, def.space);
    assert.equal(rec.id, createHash('sha1').update(bytes).digest('hex'));
  }
  // published colorants: Display P3 red in D50 XYZ (as Apple's Display P3 profile: 0.5151, 0.2412, -0.0011)
  const p3 = PR.parseIcc(PR.builtinIcc('display-p3'));
  assert.ok(Math.abs(p3.matrix.r[0] - 0.5151) < 0.0005 && Math.abs(p3.matrix.r[1] - 0.2412) < 0.0005);
  // sRGB red (0.4360, 0.2225, 0.0139), the ICC's own published values
  const s = PR.parseIcc(PR.builtinIcc('srgb'));
  assert.ok(Math.abs(s.matrix.r[0] - 0.4360) < 0.0005 && Math.abs(s.matrix.r[1] - 0.2225) < 0.0005 && Math.abs(s.matrix.r[2] - 0.0139) < 0.0005);
});

test('parseIcc refuses what is not a profile and reads v2 desc and curv tags', () => {
  assert.equal(PR.parseIcc(null), null);
  assert.equal(PR.parseIcc(Uint8Array.from({ length: 700 }, (_, i) => (i * 11 + 5) & 255)), null);
  const good = PR.builtinIcc('adobe-rgb');
  assert.equal(PR.parseIcc(good.slice(0, 200)), null); // cut short: the size says more
  // a v2 profile: 'desc' textDescription, 'text' copyright and a 'curv' gamma
  const v2 = PR.writeIcc({ ...PR.BUILTIN_DEFS[2], name: 'Old Style', legacy: true });
  const p = PR.parseIcc(v2);
  assert.equal(p.major, 2);
  assert.equal(p.name, 'Old Style');
  assert.equal(p.copyright, 'No copyright, use freely');
  assert.equal(p.curves[0].kind, 'gamma');
  assert.ok(Math.abs(p.curves[0].g - 563 / 256) < 1e-4);
  assert.equal(PR.profileRecord(v2).wellKnown, 'adobe-rgb'); // a renamed Adobe RGB is still Adobe RGB
  // sRGB written with another curve encoding (a 1024-entry table) is still sRGB
  const table = { kind: 'table', t: Float64Array.from({ length: 1024 }, (_, i) => PR.evalCurve(PR.BUILTIN_DEFS[0].trc, i / 1023)) };
  const viaTable = PR.writeIcc({ ...PR.BUILTIN_DEFS[0], trc: table, name: 'sRGB table' });
  assert.equal(PR.parseIcc(viaTable).curves[0].kind, 'table');
  assert.equal(PR.profileRecord(viaTable).wellKnown, 'srgb');
  // a profile with a size field shorter than the bytes it came in keeps only its own bytes (and their SHA-1)
  const padded = new Uint8Array(good.length + 10);
  padded.set(good);
  assert.equal(PR.profileRecord(padded).bytes.length, good.length);
  assert.equal(PR.profileRecord(padded).id, PR.profileRecord(good).id);
});

test('curves: the sRGB curve and its inverse round-trip every 8-bit level', () => {
  const c = PR.BUILTIN_DEFS[0].trc;
  for (let v = 0; v < 256; v++) assert.equal(Math.round(PR.invertCurve(c, PR.evalCurve(c, v / 255)) * 255), v);
  assert.ok(Math.abs(PR.evalCurve(c, 0.5) - 0.214) < 0.001);
});

test('JS kernels: identities cost nothing; sRGB to sRGB variants is the identity', () => {
  assert.equal(T.makeTransform(null, rec('srgb')).identity, true);
  assert.equal(T.makeTransform(rec('display-p3'), rec('display-p3')).identity, true);
  const variant = PR.profileRecord(PR.writeIcc({ ...PR.BUILTIN_DEFS[0], name: 'Camera sRGB' }));
  assert.equal(variant.wellKnown, 'srgb');
  assert.equal(T.makeTransform(variant, null).identity, true);
  const p3 = T.makeTransform(rec('display-p3'), null);
  assert.equal(p3.identity, false);
  assert.equal(p3.kind, 'js');
  // Display P3 red is outside sRGB: it clips to sRGB red; P3 white and black stay
  const px = Uint8ClampedArray.of(255, 0, 0, 200, 255, 255, 255, 255, 0, 0, 0, 0);
  p3.apply(px, px, 3);
  assert.deepEqual([...px], [255, 0, 0, 200, 255, 255, 255, 255, 0, 0, 0, 0]);
  // a mid P3 grey stays grey; sRGB orange in P3 numbers is less saturated
  assert.deepEqual(T.convertRgb([128, 128, 128], rec('display-p3'), null), [128, 128, 128]);
  const orange = T.convertRgb([255, 128, 0], null, rec('display-p3'));
  assert.ok(orange[0] < 255 && orange[1] > 128 && orange[2] > 0, JSON.stringify(orange));
  // back in sRGB within the one level P3's 8-bit numbers can lose
  T.convertRgb(orange, rec('display-p3'), null).forEach((v, i) => assert.ok(Math.abs(v - [255, 128, 0][i]) <= 1));
});

test('JS kernels equal LittleCMS 8-bit transforms for matrix/TRC pairs, and Lab equals LittleCMS Lab', { skip: !hasLcms && 'lcms-wasm is not installed' }, async () => {
  const L = await withLcms();
  assert.ok(L);
  const n = 1 << 18;
  const src = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < src.length; i++) src[i] = (Math.imul(i, 2654435761) >>> 13) & 255;
  const pairs = [['display-p3', 'srgb'], ['srgb', 'display-p3'], ['adobe-rgb', 'srgb'], ['prophoto', 'display-p3'], ['srgb', 'adobe-rgb']];
  for (const [a, b] of pairs) {
    const js = T.makeTransform(rec(a), rec(b));
    assert.equal(js.kind, 'js');
    const out = new Uint8ClampedArray(n * 4);
    js.apply(src, out, n);
    const h = lcmsTransform(rec(a), rec(b), { intent: 'perceptual', bpc: true, inFmt: TYPE.RGBA_8 });
    assert.ok(h, `${a}>${b} transform`);
    const ref = new Uint8ClampedArray(n * 4);
    runTransform(h, src, ref, n, 4, 4);
    let worst = 0;
    for (let i = 0; i < out.length; i++) worst = Math.max(worst, Math.abs(out[i] - ref[i]));
    assert.ok(worst <= 1, `${a} > ${b}: worst ${worst}`);
  }
  // Lab D50 through the JS model and through LittleCMS's Lab profile
  for (const id of ['srgb', 'display-p3', 'adobe-rgb']) {
    for (const rgb of [[255, 0, 0], [12, 200, 90], [128, 128, 128], [0, 0, 0], [255, 255, 255]]) {
      const lab = T.rgbToLab(rgb, rec(id));
      const h = lcmsTransform(rec(id), { id: 'lab-d50' }, { intent: 'relative', bpc: false, inFmt: TYPE.RGB_8, outFmt: TYPE.LAB_DBL });
      const ref = new Float64Array(3);
      runTransform(h, Uint8Array.from(rgb), ref, 1, 3, 24);
      for (let k = 0; k < 3; k++) assert.ok(Math.abs(lab[k] - ref[k]) < 0.05, `${id} ${rgb} Lab ${k}: ${lab[k]} vs ${ref[k]}`);
      const back = T.labToRgb(lab, rec(id)).map(Math.round);
      assert.deepEqual(back, rgb);
    }
  }
});

test('Gray profiles: the tone curve is applied to each channel, as LittleCMS converts a grey', { skip: !hasLcms && 'lcms-wasm is not installed' }, async () => {
  await withLcms();
  const gray = rec('gray-gamma-2.2');
  const t = T.makeTransform(gray, null);
  assert.equal(t.kind, 'js');
  const px = new Uint8ClampedArray(256 * 4);
  for (let v = 0; v < 256; v++) px.set([v, v, 255 - v, 255], v * 4);
  const out = new Uint8ClampedArray(px.length);
  t.apply(px, out, 256);
  // LittleCMS: GRAY_8 in the Gray profile to RGB_8 sRGB, every level
  const h = lcmsTransform(gray, null, { intent: 'relative', bpc: false, inFmt: TYPE.GRAY_8, outFmt: TYPE.RGB_8 });
  const ref = new Uint8Array(256 * 3);
  runTransform(h, Uint8Array.from({ length: 256 }, (_, i) => i), ref, 256, 1, 3);
  for (let v = 0; v < 256; v++) {
    assert.ok(Math.abs(out[v * 4] - ref[v * 3 + 1]) <= 1, `level ${v}: ${out[v * 4]} vs ${ref[v * 3 + 1]}`);
    assert.equal(out[v * 4 + 2], out[(255 - v) * 4]); // the blue channel is its own tone
  }
  // a mid grey of gamma 2.2 is a little lighter in sRGB
  assert.ok(out[128 * 4] > 128 && out[128 * 4] < 140);
});

test('LittleCMS converts what the JS kernels do not: 16-bit pixels', { skip: !hasLcms && 'lcms-wasm is not installed' }, async () => {
  await withLcms();
  const t = T.makeTransform(rec('display-p3'), null, { format: 'rgba16' });
  assert.equal(t.kind, 'lcms');
  const px = Uint16Array.of(65535, 0, 0, 65535, 32768, 32768, 32768, 1000);
  t.apply(px, px, 2);
  assert.equal(px[0], 65535);
  assert.equal(px[3], 65535);
  assert.ok(Math.abs(px[4] - 32768) < 40 && px[7] === 1000);
});

test('adoption: decodeConversion is "none" exactly when the profile is adopted; sRGB, CMYK and junk keep 0.4', async () => {
  const DP = await import('../../src/renderer/lib/color/doc-profile.js');
  const P3 = PR.builtinIcc('display-p3');
  const SRGB_VARIANT = PR.writeIcc({ ...PR.BUILTIN_DEFS[0], name: 'sRGB (camera)', legacy: true });
  // a CMYK header on otherwise valid bytes: Pigment does not use it yet
  const cmyk = PR.builtinIcc('adobe-rgb').slice();
  cmyk.set([0x43, 0x4d, 0x59, 0x4b], 16);
  assert.equal(DP.decodeConversion({}), 'default');
  assert.equal(DP.decodeConversion({ icc: P3 }), 'none');
  assert.equal(DP.decodeConversion({ icc: PR.builtinIcc('gray-gamma-2.2') }), 'none');
  assert.equal(DP.decodeConversion({ icc: SRGB_VARIANT }), 'default');
  assert.equal(DP.decodeConversion({ icc: cmyk }), 'default');
  assert.equal(DP.decodeConversion({ icc: Uint8Array.of(1, 2, 3) }), 'default');
  const doc = (mode = 'rgb') => ({ profile: null, mode, openNotices: undefined });
  let d = doc();
  DP.adoptOnOpen(d, { chunks: { icc: P3 }, conv: 'none' });
  assert.equal(d.profile.name, 'Display P3');
  d = doc();
  DP.adoptOnOpen(d, { chunks: { icc: P3 }, conv: 'default' }); // converted by the decoder: nothing to adopt
  assert.equal(d.profile, null);
  d = doc();
  DP.adoptOnOpen(d, { chunks: { icc: SRGB_VARIANT }, conv: 'default' });
  assert.equal(d.profile.id, 'srgb');
  assert.equal(d.profile.bytes, null);
  d = doc();
  DP.adoptOnOpen(d, { chunks: { icc: cmyk }, conv: 'default' });
  assert.equal(d.profile, null);
  assert.match(d.openNotices[0], /CMYK profile .* was not used/);
  d = doc('bitmap');
  DP.adoptOnOpen(d, { chunks: { icc: P3 }, conv: 'none' });
  assert.equal(d.profile, null);
  // resolve maps a record to the engine's own (a built-in for the built-in's bytes)
  d = doc();
  DP.adoptOnOpen(d, { chunks: { icc: P3 }, conv: 'none' }, { resolve: (r) => ({ ...r, id: 'display-p3' }) });
  assert.equal(d.profile.id, 'display-p3');
});

test('the icc provider: the profile bytes, nothing for untagged, sRGB, Convert to sRGB or embedProfile false; Gray as RGB', async () => {
  const DP = await import('../../src/renderer/lib/color/doc-profile.js');
  const p3 = PR.profileRecord(PR.builtinIcc('display-p3'), 'builtin');
  assert.equal(DP.embeddedBytes({ profile: null }), null);
  assert.equal(DP.embeddedBytes({ profile: { id: 'srgb', bytes: null, colorSpace: 'rgb' } }), null);
  assert.equal(DP.embeddedBytes({ profile: p3 }), p3.bytes);
  assert.equal(DP.embeddedBytes({ profile: p3 }, { convertTo: 'srgb' }), null);
  assert.equal(DP.embeddedBytes({ profile: p3 }, { embedProfile: false }), null);
  const gray = PR.profileRecord(PR.builtinIcc('gray-gamma-2.2'), 'builtin');
  const rgb = PR.parseIcc(DP.embeddedBytes({ profile: gray }));
  assert.equal(rgb.space, 'rgb');
  assert.equal(rgb.name, 'Gray Gamma 2.2 (RGB)');
  assert.ok(Math.abs(rgb.curves[0].g - 2.2) < 1e-3);
  // the same bytes every time (the file is byte-stable)
  assert.deepEqual(DP.embeddedBytes({ profile: gray }), DP.embeddedBytes({ profile: gray }));
  const { chunksFor } = await import('../../src/renderer/lib/io-chunks.js');
  const off = DP.installChunkProvider();
  assert.deepEqual(chunksFor({ profile: null }, { format: 'png', purpose: 'save', opts: {} }), {});
  assert.equal(chunksFor({ profile: p3 }, { format: 'png', purpose: 'save', opts: {} }).icc, p3.bytes);
  off();
});

test('describe: Untagged RGB, the profile name, the depth when not 8 bits, nothing for Bitmap', async () => {
  const DP = await import('../../src/renderer/lib/color/doc-profile.js');
  assert.equal(DP.describeProfile({ profile: null, depth: 8 }), 'Untagged RGB');
  assert.equal(DP.describeProfile({ profile: { name: 'Display P3' }, depth: 16 }), 'Display P3 (16bpc)');
  assert.equal(DP.describeProfile({ profile: { name: 'Display P3' }, depth: 8 }), 'Display P3');
  assert.equal(DP.describeProfile({ profile: null, depth: 8, mode: 'bitmap' }), '');
  const list = [{ colorSpace: 'rgb' }, { colorSpace: 'gray' }, { colorSpace: 'cmyk' }];
  assert.equal(DP.assignable(list, { mode: 'rgb' }).length, 1);
  assert.equal(DP.assignable(list, { mode: 'grayscale' }).length, 2);
});

test('the engine (S6.1): built-ins, parse to the built-in of its bytes, displaySpace by profile and setting, cssColor', async () => {
  const { createEngine } = await import('../../src/renderer/lib/color/cmm.js');
  const { ProfileLibrary } = await import('../../src/renderer/lib/color/library.js');
  const settings = { colorManagement: { display: 'auto' } };
  const app = { settings };
  const e = createEngine({ app, library: new ProfileLibrary(app, []) });
  assert.equal(e.available, true);
  assert.deepEqual(e.builtins().map((p) => p.id), ['srgb', 'display-p3', 'adobe-rgb', 'prophoto', 'gray-gamma-2.2']);
  assert.equal(e.builtins()[0].bytes, null);
  assert.equal(e.parse(PR.builtinIcc('prophoto')).id, 'prophoto');
  const other = e.parse(PR.writeIcc({ ...PR.BUILTIN_DEFS[1], name: 'P3 elsewhere', legacy: true }));
  assert.match(other.id, /^[0-9a-f]{40}$/);
  assert.equal(e.profileById(other.id), other); // remembered for profileById (a recorded Assign Profile)
  assert.equal(e.parse(Uint8Array.of(1, 2, 3)), null);
  const view = (profile) => ({ doc: { profile } });
  const p3 = e.profileById('display-p3');
  // no P3 screen in Node: sRGB; forced by the setting: Display P3, but never for sRGB, untagged or Gray documents
  assert.equal(e.displaySpace(view(p3)), 'srgb');
  settings.colorManagement.display = 'display-p3';
  assert.equal(e.displaySpace(view(p3)), 'display-p3');
  assert.equal(e.displaySpace(view(null)), 'srgb');
  assert.equal(e.displaySpace(view(e.profileById('gray-gamma-2.2'))), 'srgb');
  assert.equal(e.cssColor([255, 0, 0], p3), 'color(display-p3 1.0000 0.0000 0.0000)'); // outside sRGB, on a P3 display
  settings.colorManagement.display = 'srgb';
  assert.equal(e.displaySpace(view(p3)), 'srgb');
  assert.equal(e.cssColor([255, 0, 0], p3), '#ff0000');
  assert.equal(e.cssColor([12, 34, 56], null), '#0c2238');
  assert.equal(e.describe({ profile: p3, depth: 32 }), 'Display P3 (32bpc)');
  // Lab D50 of sRGB white
  const lab = e.toLab([255, 255, 255], null);
  assert.ok(Math.abs(lab[0] - 100) < 0.01 && Math.abs(lab[1]) < 0.05 && Math.abs(lab[2]) < 0.05);
});
