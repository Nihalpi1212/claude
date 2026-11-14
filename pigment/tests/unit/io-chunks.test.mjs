// Container chunks of the 0.5 skeleton (ARCHITECTURE.md "0.5 features", S5): every kind of S5's table read and
// written on files the tests build (PNG through pixels/png.js, TIFF through pixels/tiff.js in both byte orders, PSD
// through ag-psd, JPEG and WebP byte constants, a VP8L file made VP8X); an empty patch returns the same bytes;
// malformed input never throws; providers and applyChunks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as C from '../../src/renderer/lib/io-chunks.js';
import { encodePng, decodePng } from '../../src/shared/pixels/png.js';
import { encodeTiff, decodeTiff } from '../../src/shared/pixels/tiff.js';

const require = createRequire(import.meta.url);
const { writePsdBuffer, readPsd } = require('ag-psd');

const ICC = Uint8Array.from({ length: 3000 }, (_, i) => (i * 7 + 3) & 255); // not a real profile: bytes are bytes
const BIG_ICC = Uint8Array.from({ length: 140000 }, (_, i) => (i * 13) & 255); // three APP2 segments in a JPEG
const EXIF = Uint8Array.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
const XMP = '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description dc:title="Grüße" xmlns:dc="http://purl.org/dc/elements/1.1/"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
const IPTC = Uint8Array.from([0x1c, 0x02, 0x00, 0x00, 0x02, 0x00, 0x04, 0x1c, 0x02, 0x05, 0x00, 0x05, 0x54, 0x69, 0x74, 0x6c, 0x65]);
const ALL = { icc: ICC, exif: EXIF, xmp: XMP, iptc: IPTC, resolution: { x: 300, y: 300, unit: 'in' } };

const pixels = (w, h, channels = 4) => ({ width: w, height: h, channels, depth: 8, data: Uint8ClampedArray.from({ length: w * h * channels }, (_, i) => (i * 37) & 255) });
const pick = (chunks, kinds) => Object.fromEntries(kinds.map((k) => [k, chunks[k]]));
const same = (a, b) => assert.deepEqual(Array.from(a), Array.from(b));

// a JPEG's structure: SOI, APP0 JFIF (72 dpi), a DQT, SOS with entropy-coded bytes, EOI (never decoded here)
const JPEG = Uint8Array.from([
  0xff, 0xd8,
  0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00,
  0xff, 0xdb, 0x00, 0x08, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05,
  0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0x34, 0xff, 0x00, 0x56, 0x78,
  0xff, 0xd9,
]);

// a lossless WebP (VP8L, 3 x 2, with alpha) and a lossy one (VP8 key frame, 5 x 4)
const riff = (chunks) => {
  const body = [0x57, 0x45, 0x42, 0x50];
  for (const [type, data] of chunks) {
    body.push(...[...type].map((c) => c.charCodeAt(0)), data.length & 255, (data.length >> 8) & 255, 0, 0, ...data);
    if (data.length % 2) body.push(0);
  }
  return Uint8Array.from([0x52, 0x49, 0x46, 0x46, body.length & 255, (body.length >> 8) & 255, 0, 0, ...body]);
};
const vp8lBits = (2) | ((1) << 14) | (1 << 28); // width-1 = 2, height-1 = 1, alpha used
const WEBP_L = riff([['VP8L', [0x2f, vp8lBits & 255, (vp8lBits >>> 8) & 255, (vp8lBits >>> 16) & 255, (vp8lBits >>> 24) & 255, 0x07, 0x00]]]);
const WEBP_LOSSY = riff([['VP8 ', [0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, 0x05, 0x00, 0x04, 0x00, 0x11, 0x22]]]);

const containers = async () => ({
  png: await encodePng(pixels(4, 3), { dpi: 72 }),
  tiffLE: await encodeTiff(pixels(4, 3), { dpi: 72, littleEndian: true }),
  tiffBE: await encodeTiff(pixels(4, 3, 3), { dpi: 72, littleEndian: false, compression: 'packbits' }),
  psd: new Uint8Array(writePsdBuffer({ width: 4, height: 3, children: [], imageResources: { resolutionInfo: { horizontalResolution: 72, horizontalResolutionUnit: 'PPI', widthUnit: 'Inches', verticalResolution: 72, verticalResolutionUnit: 'PPI', heightUnit: 'Inches' } } })),
  jpeg: JPEG,
  webp: WEBP_L,
});
const FORMAT = { png: 'png', tiffLE: 'tiff', tiffBE: 'tiff', psd: 'psd', jpeg: 'jpeg', webp: 'webp' };

test('chunkFormatFor and chunkSupport follow S5\'s table', () => {
  assert.equal(C.chunkFormatFor('photo.JPG'), 'jpeg');
  assert.equal(C.chunkFormatFor('jpeg'), 'jpeg');
  assert.equal(C.chunkFormatFor('a.tif'), 'tiff');
  assert.equal(C.chunkFormatFor('png8'), 'png');
  assert.equal(C.chunkFormatFor('png16'), 'png');
  assert.equal(C.chunkFormatFor('x.psb'), 'psd');
  assert.equal(C.chunkFormatFor('webp'), 'webp');
  assert.equal(C.chunkFormatFor('gif'), null);
  assert.equal(C.chunkFormatFor('tga'), null);
  assert.deepEqual(C.chunkSupport('png'), { read: ['icc', 'exif', 'xmp', 'iptc', 'resolution'], write: ['icc', 'exif', 'xmp', 'resolution'] });
  assert.deepEqual(C.chunkSupport('webp'), { read: ['icc', 'exif', 'xmp'], write: ['icc', 'exif', 'xmp'] });
  assert.deepEqual(C.chunkSupport('tiff').write, ['icc', 'xmp', 'iptc', 'resolution']);
  assert.deepEqual(C.chunkSupport('jpeg').write, ['icc', 'exif', 'xmp', 'iptc', 'resolution']);
  assert.deepEqual(C.chunkSupport('psd').write, ['icc', 'exif', 'xmp', 'iptc', 'resolution']);
  assert.deepEqual(C.chunkSupport('gif'), { read: [], write: [] });
});

test('every writable kind round-trips in every container, and the file still decodes', async () => {
  const files = await containers();
  for (const [name, bytes] of Object.entries(files)) {
    const format = FORMAT[name];
    const kinds = C.chunkSupport(format).write;
    const out = await C.writeChunks(bytes, format, pick(ALL, kinds));
    assert.notEqual(out, bytes, name);
    const back = await C.readChunks(out, format);
    assert.equal(back.damaged, undefined, name);
    for (const k of kinds) {
      if (k === 'xmp') assert.equal(back.xmp, XMP, `${name} xmp`);
      else if (k === 'resolution') assert.deepEqual(back.resolution, { x: 300, y: 300, unit: 'in' }, `${name} resolution`);
      else same(back[k], ALL[k]);
    }
    // nothing else changed: the pixels decode as before
    if (name === 'png') same((await decodePng(out)).data, (await decodePng(bytes)).data);
    if (name.startsWith('tiff')) same((await decodeTiff(out)).data, (await decodeTiff(bytes)).data);
    if (name === 'psd') {
      const a = readPsd(out, { skipCompositeImageData: true }), b = readPsd(bytes, { skipCompositeImageData: true });
      assert.equal(a.width, b.width);
      assert.equal(a.imageResources.resolutionInfo.horizontalResolution, 300);
      assert.equal(a.imageResources.xmpMetadata, XMP);
    }
    if (name === 'jpeg') same(out.subarray(out.length - 18), JPEG.subarray(JPEG.length - 18)); // SOS onwards untouched
    // null removes each kind again
    const removed = await C.readChunks(await C.writeChunks(out, format, Object.fromEntries(kinds.map((k) => [k, null]))), format);
    for (const k of kinds) if (k !== 'resolution' || name === 'png' || name === 'tiffLE' || name === 'tiffBE') assert.equal(removed[k], undefined, `${name} ${k} removed`);
  }
});

test('an empty patch returns the very same bytes; kinds a format cannot write are ignored', async () => {
  const files = await containers();
  for (const [name, bytes] of Object.entries(files)) {
    assert.equal(await C.writeChunks(bytes, FORMAT[name], {}), bytes, name);
    assert.equal(await C.writeChunks(bytes, FORMAT[name], { icc: undefined }), bytes, name);
  }
  assert.equal(await C.writeChunks(files.webp, 'webp', { iptc: IPTC, resolution: { x: 1, y: 1, unit: 'in' } }), files.webp);
  assert.equal(await C.writeChunks(files.png, 'png', { iptc: IPTC }), files.png);
});

test('the PNG reader and writer: iCCP replaces sRGB, gAMA and cHRM; pHYs per metre; ImageMagick\'s IPTC profile', async () => {
  const { crc32 } = await import('../../src/shared/zip.js');
  const { zlibCodecs } = await import('../../src/shared/pixels/png.js');
  const base = await encodePng(pixels(2, 2), { dpi: 72 });
  const chunk = (type, data) => {
    const body = Uint8Array.from([...[...type].map((c) => c.charCodeAt(0)), ...data]);
    const c = crc32(body);
    return [data.length >>> 24, (data.length >>> 16) & 255, (data.length >>> 8) & 255, data.length & 255, ...body, c >>> 24, (c >>> 16) & 255, (c >>> 8) & 255, c & 255];
  };
  const hex = Array.from(IPTC, (v) => v.toString(16).padStart(2, '0')).join('');
  const text = `\niptc\n${String(IPTC.length).padStart(8)}\n${hex}\n`;
  const ztxt = [...'Raw profile type iptc'].map((c) => c.charCodeAt(0)).concat([0, 0], Array.from(await zlibCodecs.deflate(new TextEncoder().encode(text))));
  // after IHDR (8 + 25 bytes): sRGB, gAMA and the IPTC zTXt
  const withMore = Uint8Array.from([...base.subarray(0, 33), ...chunk('sRGB', [0]), ...chunk('gAMA', [0, 0, 0xb1, 0x8f]), ...chunk('zTXt', ztxt), ...base.subarray(33)]);
  const before = await C.readChunks(withMore, 'png');
  same(before.iptc, IPTC);
  assert.deepEqual(before.resolution, { x: 72, y: 72, unit: 'in' });
  assert.equal(before.icc, undefined);
  const tagged = await C.writeChunks(withMore, 'png', { icc: ICC });
  const types = [];
  for (let i = 8; i < tagged.length;) {
    const len = (tagged[i] << 24) | (tagged[i + 1] << 16) | (tagged[i + 2] << 8) | tagged[i + 3];
    types.push(String.fromCharCode(...tagged.subarray(i + 4, i + 8)));
    i += 12 + len;
  }
  assert.deepEqual(types.slice(0, 2), ['IHDR', 'iCCP']);
  assert.ok(!types.includes('sRGB') && !types.includes('gAMA'));
  assert.ok(types.includes('zTXt') && types.includes('pHYs'));
  same((await C.readChunks(tagged, 'png')).icc, ICC);
  assert.deepEqual((await C.readChunks(await C.writeChunks(base, 'png', { resolution: { x: 118.11, y: 118.11, unit: 'cm' } }), 'png')).resolution, { x: 300, y: 300, unit: 'in' });
});

test('a JPEG profile over 65 519 bytes is split into numbered APP2 segments and read back whole', async () => {
  const out = await C.writeChunks(JPEG, 'jpeg', { icc: BIG_ICC });
  let n = 0;
  for (let i = 2; i < out.length - 1; i++) if (out[i] === 0xff && out[i + 1] === 0xe2) n++;
  assert.equal(n, 3);
  same((await C.readChunks(out, 'jpeg')).icc, BIG_ICC);
  // the JFIF density is the resolution; replacing it edits APP0 in place
  assert.deepEqual((await C.readChunks(JPEG, 'jpeg')).resolution, { x: 72, y: 72, unit: 'in' });
  const cm = await C.writeChunks(JPEG, 'jpeg', { resolution: { x: 118, y: 118, unit: 'cm' } });
  assert.equal(cm.length, JPEG.length);
  assert.deepEqual((await C.readChunks(cm, 'jpeg')).resolution, { x: 118, y: 118, unit: 'cm' });
});

test('a simple WebP that gains a chunk becomes VP8X with the canvas size and flags; a lossy one too', async () => {
  for (const [file, w, h, alpha] of [[WEBP_L, 3, 2, true], [WEBP_LOSSY, 5, 4, false]]) {
    const out = await C.writeChunks(file, 'webp', { icc: ICC, xmp: XMP });
    assert.equal(String.fromCharCode(...out.subarray(12, 16)), 'VP8X');
    const flags = out[20];
    assert.equal(!!(flags & 0x20), true);
    assert.equal(!!(flags & 0x04), true);
    assert.equal(!!(flags & 0x08), false);
    assert.equal(!!(flags & 0x10), alpha);
    const cw = (out[24] | (out[25] << 8) | (out[26] << 16)) + 1, ch = (out[27] | (out[28] << 8) | (out[29] << 16)) + 1;
    assert.deepEqual([cw, ch], [w, h]);
    // RIFF size covers the file; ICCP right after VP8X, the image chunk kept, XMP at the end
    assert.equal(out[4] | (out[5] << 8) | (out[6] << 16) | (out[7] << 24), out.length - 8);
    assert.equal(String.fromCharCode(...out.subarray(30, 34)), 'ICCP');
    const back = await C.readChunks(out, 'webp');
    same(back.icc, ICC);
    assert.equal(back.xmp, XMP);
    // removing the profile clears its flag
    const plain = await C.writeChunks(out, 'webp', { icc: null });
    assert.equal(!!(plain[20] & 0x20), false);
    assert.equal((await C.readChunks(plain, 'webp')).icc, undefined);
  }
});

test('TIFF: IFD0 is rebuilt at the end of the file in both byte orders; the next-IFD pointer is kept', async () => {
  const files = await containers();
  for (const file of [files.tiffLE, files.tiffBE]) {
    const out = await C.writeChunks(file, 'tiff', { icc: ICC, xmp: XMP });
    same(out.subarray(8, file.length), file.subarray(8));
    const le = out[0] === 0x49;
    const u32 = (i) => (le ? (out[i] | (out[i + 1] << 8) | (out[i + 2] << 16) | (out[i + 3] << 24)) >>> 0 : ((out[i] << 24) | (out[i + 1] << 16) | (out[i + 2] << 8) | out[i + 3]) >>> 0);
    const u16 = (i) => (le ? out[i] | (out[i + 1] << 8) : (out[i] << 8) | out[i + 1]);
    const at = u32(4);
    assert.ok(at >= file.length);
    const n = u16(at);
    const tags = Array.from({ length: n }, (_, k) => u16(at + 2 + k * 12));
    assert.deepEqual(tags, [...tags].sort((a, b) => a - b));
    assert.ok(tags.includes(34675) && tags.includes(700));
    assert.equal(u32(at + 2 + n * 12), 0);
    same((await decodeTiff(out)).data, (await decodeTiff(file)).data);
    assert.deepEqual((await C.readChunks(out, 'tiff')).resolution, { x: 72, y: 72, unit: 'in' });
  }
});

test('malformed and truncated input never throws from readChunks', async () => {
  const files = await containers();
  const bad = [new Uint8Array(0), Uint8Array.of(1, 2, 3), Uint8Array.of(0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0, 0, 0, 0, 0, 0)];
  for (const [name, bytes] of Object.entries(files)) {
    bad.push(bytes.subarray(0, Math.floor(bytes.length / 2)));
    const flipped = new Uint8Array(bytes);
    flipped[Math.min(40, flipped.length - 1)] ^= 0xff;
    bad.push(flipped);
    void name;
  }
  for (const b of bad) for (const f of ['jpeg', 'png', 'webp', 'tiff', 'psd', 'gif']) {
    const r = await C.readChunks(b, f);
    assert.equal(typeof r, 'object');
  }
  assert.deepEqual(await C.readChunks(files.png.subarray(0, 20), 'png'), { damaged: true });
  await assert.rejects(() => C.writeChunks(files.png.subarray(0, 20), 'png', { icc: ICC }));
});

test('providers in order, a later one overriding a kind; applyChunks leaves bytes alone without one', async () => {
  const files = await containers();
  const doc = { profile: null };
  assert.equal(await C.applyChunks(doc, files.png, 'png', { purpose: 'save' }), files.png);
  const seen = [];
  const off1 = C.registerChunkProvider({ id: 'a', order: 100, kinds: ['icc', 'xmp'], provide: (d, info) => (seen.push(info), { icc: ICC, xmp: 'first', exif: EXIF }) });
  const off2 = C.registerChunkProvider({ id: 'b', order: 200, kinds: ['xmp'], provide: () => ({ xmp: XMP }) });
  assert.deepEqual(Object.keys(C.chunksFor(doc, { format: 'png', purpose: 'export' })), ['icc', 'xmp']);
  const out = await C.applyChunks(doc, files.png, 'image.png', { purpose: 'copy', opts: { quality: 1 } });
  assert.deepEqual(seen.at(-1), { format: 'png', purpose: 'copy', opts: { quality: 1 } });
  const back = await C.readChunks(out, 'png');
  same(back.icc, ICC);
  assert.equal(back.xmp, XMP);
  assert.equal(back.exif, undefined); // not one of provider a's kinds
  const gif = Uint8Array.of(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0x3b);
  assert.equal(await C.applyChunks(doc, gif, 'gif'), gif);
  off1();
  off2();
  assert.equal(C.chunkProviders().length, 0);
});
