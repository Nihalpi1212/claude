// The Gradient Map interpolation method through PSD: the grdm handler fix bundled into the vendored ag-psd
// (scripts/vendor-entries/ag-psd-grdm.js) and lib/io.js adjustmentToPsd / adjustmentFromPsd, which write and read
// Photoshop's 4-character codes (Gcls, Perc, 'Lnr ', Smoo) and keep files without a method (Classic) readable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { grdmPatched, patchGrdm, GRDM_METHOD_CODES } from '../../scripts/vendor-entries/ag-psd-grdm.js';
import { adjustmentToPsd, adjustmentFromPsd } from '../../src/renderer/lib/io.js';

const require = createRequire(import.meta.url);
const { writePsdBuffer, readPsd } = require('ag-psd');

const def = (interpolation, extra = {}) => ({
  gradientVersion: 2, type: 'solid', interpolation, smoothness: 1, reverse: false, dither: false,
  stops: [{ pos: 0, mid: 0.5, color: '#102030' }, { pos: 0.4, mid: 0.5, color: '#f0a000' }, { pos: 1, mid: 0.5, color: '#ffffff' }],
  opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 1 }],
  ...extra,
});
const psdWith = (adjustment) => writePsdBuffer({ width: 4, height: 4, children: [{ name: 'Gradient Map', adjustment }] });
const readBack = (buf) => readPsd(buf, { skipThumbnail: true, skipLayerImageData: true, skipCompositeImageData: true }).children[0].adjustment;
/** The grdm block's version and the 4 bytes after Reverse and Dither (the method code in version 3). */
function grdmBytes(buf) {
  const at = buf.indexOf('grdm') + 8; // key, then the 4-byte block length
  return { version: buf.readUInt16BE(at), code: buf.subarray(at + 4, at + 8).toString('latin1') };
}

test('the grdm fix is applied to ag-psd, once', () => {
  assert.equal(grdmPatched, true);
  assert.equal(patchGrdm(), true, 'applying it again changes nothing');
  assert.equal(patchGrdm({}), false, 'a registry without a grdm handler is left alone');
  assert.deepEqual(GRDM_METHOD_CODES, { classic: 'Gcls', perceptual: 'Perc', linear: 'Lnr ', smooth: 'Smoo' });
});

test('Classic, Perceptual, Linear and Smooth Gradient Maps are written with Photoshop codes and read back', () => {
  const codes = { classic: 'Gcls', perceptual: 'Perc', linear: 'Lnr ', smooth: 'Smoo' };
  for (const [interpolation, code] of Object.entries(codes)) {
    const adj = adjustmentToPsd('gradient-map', def(interpolation, { reverse: true }));
    assert.equal(adj.methodCode, code);
    const buf = psdWith(adj);
    assert.deepEqual(grdmBytes(buf), { version: 3, code }, interpolation);
    const raw = readBack(buf);
    assert.equal(raw.methodCode, code);
    assert.equal(raw.method, interpolation);
    // everything after the code is where it was: name, stops, reverse
    assert.equal(raw.name, 'Gradient');
    assert.equal(raw.reverse, true);
    assert.equal(raw.colorStops.length, 3);
    const back = adjustmentFromPsd(raw);
    assert.equal(back.kind, 'gradient-map');
    assert.equal(back.params.interpolation, interpolation);
    assert.deepEqual(back.params.stops.map((s) => Math.round(s.pos * 1000) / 1000), [0, 0.4, 1]);
    assert.equal(back.params.reverse, true);
  }
  // a smoothness-0 Perceptual map is not mistaken for a 0.3 linear map (which would be Classic)
  const p0 = adjustmentFromPsd(readBack(psdWith(adjustmentToPsd('gradient-map', def('perceptual', { smoothness: 0 })))));
  assert.equal(p0.params.gradientVersion, 2);
  assert.equal(p0.params.interpolation, 'perceptual');
  // Stripes has no code in the file format Pigment knows: it is written as Classic, the nearest
  assert.equal(adjustmentToPsd('gradient-map', def('stripes')).methodCode, 'Gcls');
  // 0.3 stops are Classic
  const old = adjustmentToPsd('gradient-map', { stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] });
  assert.equal(grdmBytes(psdWith(old)).code, 'Gcls');
});

test('files without a method (version 1: older Pigment, Photoshop before CC) and unknown codes open as Classic', () => {
  // what Pigment wrote before: no method field, a version 1 block
  const legacy = { ...adjustmentToPsd('gradient-map', def('perceptual')) };
  delete legacy.methodCode;
  const buf = psdWith(legacy);
  assert.equal(grdmBytes(buf).version, 1);
  const raw = readBack(buf);
  assert.equal(raw.methodCode, undefined);
  assert.equal(raw.method, undefined, 'not Perceptual, which the unfixed reader made of every file');
  assert.equal(adjustmentFromPsd(raw).params.interpolation, 'classic');
  // an unfixed ag-psd hands `method: 'perceptual'` for any code: only methodCode is trusted
  assert.equal(adjustmentFromPsd({ ...raw, method: 'perceptual' }).params.interpolation, 'classic');
  // a code Pigment does not know is kept raw and opens as Classic
  const odd = readBack(psdWith({ ...legacy, methodCode: 'Strp' }));
  assert.equal(odd.methodCode, 'Strp');
  assert.equal(adjustmentFromPsd(odd).params.interpolation, 'classic');
});
