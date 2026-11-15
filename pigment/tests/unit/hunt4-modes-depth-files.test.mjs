// Regression tests from the 0.3.1 cross-feature hunt, area "modes, depth, files": the pure decoders refuse
// files that lost part of their picture (they used to open as partly blank images) and files whose size fields
// are impossible for their byte count (they used to allocate hundreds of megabytes and block for seconds).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeTiff, decodeTiff, unpackBits, lzwDecode as tiffLzwDecode, lzwEncode as tiffLzwEncode } from '../../src/shared/pixels/tiff.js';
import { encodeTga, decodeTga } from '../../src/shared/pixels/tga.js';
import { encodeGif, decodeGif, lzwDecode as gifLzwDecode } from '../../src/shared/pixels/gif.js';

const W = 23, H = 17;
const rgba = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37 + (i >> 3)) & 255;
const rgba16 = new Uint16Array(W * H * 4);
for (let i = 0; i < rgba16.length; i++) rgba16[i] = (i * 3701 + 17) & 65535;
const COMPRESSIONS = ['none', 'lzw', 'packbits', 'deflate'];

/** Rewrites the value of one tag of a little-endian TIFF's first directory as a LONG. */
function patchTag(bytes, tag, value) {
  const out = bytes.slice();
  const dv = new DataView(out.buffer);
  assert.equal(String.fromCharCode(out[0], out[1]), 'II', 'the encoder writes little-endian files');
  const ifd = dv.getUint32(4, true);
  const count = dv.getUint16(ifd, true);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (dv.getUint16(e, true) !== tag) continue;
    dv.setUint16(e + 2, 4, true);
    dv.setUint32(e + 4, 1, true);
    dv.setUint32(e + 8, value, true);
    return out;
  }
  throw new Error(`tag ${tag} not found`);
}

test('TIFF: an image size the file could never hold is refused at once, for every compression', async () => {
  for (const compression of COMPRESSIONS) {
    const good = await encodeTiff({ width: W, height: H, channels: 4, depth: 8, data: new Uint8Array(rgba.buffer) }, { compression });
    assert.equal((await decodeTiff(good)).width, W);
    // 10 million pixels wide (what a one-byte mutation of the width field gave the fuzzer), then 200 000 rows
    for (const [tag, value] of [[256, 10616855], [257, 200000]]) {
      const bad = patchTag(good, tag, value);
      const t0 = Date.now();
      await assert.rejects(decodeTiff(bad), /truncated or damaged|too large/, `${compression} tag ${tag}`);
      assert.ok(Date.now() - t0 < 1000, `${compression}: refused without decoding (${Date.now() - t0} ms)`);
    }
    // larger than any canvas: refused whatever the file holds
    await assert.rejects(decodeTiff(patchTag(patchTag(good, 256, 40000), 257, 40000)), /too large to open \(40000 × 40000 pixels\)/);
  }
});

test('TIFF: a truncated file never decodes to a partly blank image', async () => {
  for (const compression of COMPRESSIONS) {
    for (const [depth, data] of [[8, new Uint8Array(rgba.buffer)], [16, rgba16]]) {
      const bytes = await encodeTiff({ width: W, height: H, channels: 4, depth, data }, { compression });
      const full = await decodeTiff(bytes);
      for (let n = 0; n < bytes.length; n += 7) {
        let dec = null;
        try {
          dec = await decodeTiff(bytes.slice(0, n));
        } catch (err) {
          assert.ok(err instanceof Error && !(err instanceof RangeError) && !(err instanceof TypeError), `${compression}/${depth} cut at ${n}: a plain Error (${err?.constructor?.name}: ${err?.message})`);
          continue;
        }
        // only the trailing bytes nothing depends on may go missing
        assert.deepEqual(Array.from(dec.data), Array.from(full.data), `${compression}/${depth} cut at ${n} decoded to other pixels`);
      }
    }
  }
});

test('TIFF: strict PackBits and LZW report a stream that ends early; the lenient form still zero-fills', () => {
  const row = Uint8Array.from({ length: 64 }, (_, i) => (i * 7) & 255);
  const lzw = tiffLzwEncode(row);
  assert.deepEqual(Array.from(tiffLzwDecode(lzw, 64, { strict: true })), Array.from(row));
  assert.throws(() => tiffLzwDecode(lzw.subarray(0, lzw.length >> 1), 64, { strict: true }), /truncated or damaged/);
  assert.equal(tiffLzwDecode(lzw.subarray(0, lzw.length >> 1), 64).length, 64);
  const packed = Uint8Array.from([2, 1, 2, 3, 0xfe, 9]); // three literals, then 9 three times
  assert.deepEqual(Array.from(unpackBits(packed, 6, { strict: true })), [1, 2, 3, 9, 9, 9]);
  assert.throws(() => unpackBits(packed.subarray(0, 3), 6, { strict: true }), /truncated or damaged/);
  assert.throws(() => unpackBits(packed.subarray(0, 5), 6, { strict: true }), /truncated or damaged/); // the run lost its value
  assert.deepEqual(Array.from(unpackBits(packed.subarray(0, 3), 6)), [1, 2, 0, 0, 0, 0]);
});

test('TGA: truncated files are refused, raw and run-length encoded', () => {
  for (const rle of [false, true]) {
    const bytes = encodeTga({ width: W, height: H, data: rgba }, { rle });
    const full = decodeTga(bytes);
    assert.equal(full.width, W);
    // the pixel data ends where the TGA 2.0 footer (26 bytes) begins
    for (const n of [19, 40, bytes.length >> 2, bytes.length >> 1, bytes.length - 40]) {
      assert.throws(() => decodeTga(bytes.slice(0, n)), /TGA file is truncated/, `rle=${rle} cut at ${n}`);
    }
    // the footer is optional
    assert.deepEqual(Array.from(decodeTga(bytes.slice(0, bytes.length - 26)).data), Array.from(full.data));
  }
  // a run-length header that claims far more pixels than the file could hold
  const tiny = encodeTga({ width: 4, height: 4, data: new Uint8ClampedArray(64).fill(200) }, { rle: true });
  const huge = tiny.slice();
  huge[12] = huge[13] = huge[14] = huge[15] = 255; // 65535 x 65535
  assert.throws(() => decodeTga(huge), /TGA file is truncated/);
});

test('GIF: a truncated frame is refused instead of being padded with index 0', () => {
  const indices = new Uint8Array(W * H);
  for (let i = 0; i < indices.length; i++) indices[i] = (i * 7) % 5;
  const palette = [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]];
  const bytes = encodeGif([{ indices, palette, transparentIndex: -1, delay: 0 }], W, H);
  assert.deepEqual(Array.from(decodeGif(bytes).frames[0].indices), Array.from(indices));
  for (const n of [bytes.length >> 1, Math.floor(bytes.length * 0.9)]) assert.throws(() => decodeGif(bytes.slice(0, n)), /GIF file is truncated/, `cut at ${n}`);
  // the decoder itself stays lenient unless asked (other callers read partial streams)
  const data = Uint8Array.from([0x8c, 0x2d]); // two bytes of a 4-colour stream
  assert.equal(gifLzwDecode(data, 2, 100).length, 100);
  assert.throws(() => gifLzwDecode(data, 2, 100, { strict: true }), /truncated/);
});
