import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, inflateSync } from 'node:zlib';
import { decodePng, encodePng, encodeRgba8, toRgba8, toRgba16, fromRgba8, pngInfo, isPng, readChunks } from '../../src/shared/pixels/png.js';
import { encodePng as fixturePng } from '../fixtures/make-fixtures.mjs';

const nodeCodecs = { deflate: async (b) => new Uint8Array(deflateSync(b)), inflate: async (b) => new Uint8Array(inflateSync(b)) };

function rgba(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(fn(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
}

test('8-bit RGBA round trip, adaptive filters, with the stream codecs and with node zlib', async () => {
  const img = rgba(37, 23, (x, y) => [x * 6, y * 11, (x * y) & 255, x % 5 === 0 ? 0 : 255]);
  for (const codecs of [{}, nodeCodecs]) {
    const bytes = await encodePng(fromRgba8(img, 4), codecs);
    assert.ok(isPng(bytes));
    assert.deepEqual(pngInfo(bytes), { width: 37, height: 23, bitDepth: 8, colorType: 6, interlace: 0 });
    const back = toRgba8(await decodePng(bytes, codecs));
    assert.deepEqual(Array.from(back.data), Array.from(img.data));
  }
});

test('encodeRgba8 drops alpha when every pixel is opaque and decodes to the same pixels', async () => {
  const img = rgba(9, 4, (x, y) => [x * 20, 255 - y * 50, 7, 255]);
  const bytes = await encodeRgba8(img, { dpi: 300, text: { Software: 'Pigment' } });
  assert.equal(pngInfo(bytes).colorType, 2);
  const dec = await decodePng(bytes);
  assert.equal(dec.dpi, 300);
  assert.equal(dec.text.Software, 'Pigment');
  assert.deepEqual(Array.from(toRgba8(dec).data), Array.from(img.data));
});

test('16-bit RGBA and greyscale round trips keep every sample', async () => {
  const w = 12, h = 7;
  const data = new Uint16Array(w * h * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 2654435761) >>> 16;
  const bytes = await encodePng({ width: w, height: h, channels: 4, depth: 16, data });
  assert.equal(pngInfo(bytes).bitDepth, 16);
  const dec = await decodePng(bytes);
  assert.equal(dec.depth, 16);
  assert.deepEqual(Array.from(dec.data), Array.from(data));
  // greyscale 16 -> rgba16 expansion and rgba8 rounding
  const g = new Uint16Array([0, 65535, 32768, 257]);
  const gb = await encodePng({ width: 2, height: 2, channels: 1, depth: 16, data: g });
  const gd = await decodePng(gb);
  assert.deepEqual(Array.from(toRgba16(gd).data), [0, 0, 0, 65535, 65535, 65535, 65535, 65535, 32768, 32768, 32768, 65535, 257, 257, 257, 65535]);
  assert.deepEqual(Array.from(toRgba8(gd).data), [0, 0, 0, 255, 255, 255, 255, 255, 128, 128, 128, 255, 1, 1, 1, 255]);
});

test('palette images with tRNS, and colour-key transparency on grey and RGB', async () => {
  const palette = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30]);
  const transparency = new Uint8Array([255, 128, 255, 0]);
  const idx = new Uint8ClampedArray([0, 1, 2, 3, 3, 2, 1, 0]);
  const bytes = await encodePng({ width: 4, height: 2, channels: 1, depth: 8, data: idx, palette, transparency }, { indexed: true });
  assert.equal(pngInfo(bytes).colorType, 3);
  const dec = await decodePng(bytes);
  assert.deepEqual(Array.from(dec.palette), Array.from(palette));
  assert.deepEqual(Array.from(dec.transparency), Array.from(transparency));
  const px = toRgba8(dec).data;
  assert.deepEqual(Array.from(px.subarray(0, 16)), [255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 10, 20, 30, 0]);
  // a hand-made grey image with a tRNS colour key: value 7 is transparent
  const chunksOf = (b) => readChunks(b);
  const greyBytes = await encodePng({ width: 3, height: 1, channels: 1, depth: 8, data: new Uint8ClampedArray([7, 8, 9]) });
  const chunks = chunksOf(greyBytes);
  const trns = new Uint8Array(12 + 2);
  const dv = new DataView(trns.buffer);
  dv.setUint32(0, 2);
  trns.set([0x74, 0x52, 0x4e, 0x53], 4);
  trns.set([0, 7], 8);
  const { crc32 } = await import('../../src/shared/zip.js');
  dv.setUint32(10, crc32(trns.subarray(4, 10)));
  // splice tRNS after IHDR
  const ihdrEnd = 8 + 12 + 13;
  const withKey = new Uint8Array(greyBytes.length + trns.length);
  withKey.set(greyBytes.subarray(0, ihdrEnd), 0);
  withKey.set(trns, ihdrEnd);
  withKey.set(greyBytes.subarray(ihdrEnd), ihdrEnd + trns.length);
  const keyed = await decodePng(withKey);
  assert.deepEqual(keyed.transparency, [7]);
  assert.deepEqual(Array.from(toRgba8(keyed).data), [7, 7, 7, 0, 8, 8, 8, 255, 9, 9, 9, 255]);
  void chunks;
});

test('Adam7 interlaced files decode (encoded interlaced here) and sub-byte depths scale to 8 bits', async () => {
  const img = rgba(19, 13, (x, y) => [x * 13, y * 19, (x + y) * 7, 255]);
  const bytes = await encodePng(fromRgba8(img, 3), { interlace: true });
  assert.equal(pngInfo(bytes).interlace, 1);
  assert.deepEqual(Array.from(toRgba8(await decodePng(bytes)).data), Array.from(img.data));
  // 1-bit greyscale written by hand: rows of 10 pixels = 2 bytes each (packed MSB first), filter 0
  const rows = [0b10101010, 0b11000000, 0b01010101, 0b00000000];
  const raw = new Uint8Array([0, rows[0], rows[1], 0, rows[2], rows[3]]);
  const zipped = new Uint8Array(deflateSync(raw));
  const { crc32 } = await import('../../src/shared/zip.js');
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    out.set([...type].map((c) => c.charCodeAt(0)), 4);
    out.set(data, 8);
    v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 10);
  new DataView(ihdr.buffer).setUint32(4, 2);
  ihdr[8] = 1;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zipped), chunk('IEND', new Uint8Array(0))];
  const file = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    file.set(p, o);
    o += p.length;
  }
  const dec = await decodePng(file);
  assert.equal(dec.bitDepth, 1);
  assert.deepEqual(Array.from(dec.data), [255, 0, 255, 0, 255, 0, 255, 0, 255, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 0]);
});

test('reads the PNGs the fixture generator writes (an independent encoder) and rejects corrupt files', async () => {
  const w = 20, h = 5;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 37) & 255;
  const bytes = new Uint8Array(fixturePng({ width: w, height: h, data }));
  const dec = await decodePng(bytes);
  assert.deepEqual(Array.from(toRgba8(dec).data), Array.from(data));
  const bad = bytes.slice();
  bad[40] ^= 1;
  await assert.rejects(decodePng(bad), /CRC|filter|truncated|invalid/);
  assert.throws(() => pngInfo(new Uint8Array([1, 2, 3])), /Not a PNG/);
});
