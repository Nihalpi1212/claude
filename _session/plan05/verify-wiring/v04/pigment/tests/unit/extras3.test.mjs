// Layer / Select / File extras: the pure parts. Quad geometry of the Perspective Crop tool and the
// File Info helpers (keywords, XMP packet, EXIF camera data), plus the check the contract asks for:
// ag-psd keeps imageResources.xmpMetadata through a write and a read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { orderQuad, isConvexQuad, naturalSize, outputSize, isParallelogram, MAX_SIDE } from '../../src/renderer/lib/tools/perspective-quad.js';
import { parseKeywords, normaliseInfo, hasInfo, xmpPacket, parseXmp, findXmp, injectPsdXmp, readExif, describeExif } from '../../src/renderer/lib/file-info.js';
import * as T from '../../src/shared/pixels/transform.js';

const require = createRequire(import.meta.url);

// ---- quad geometry --------------------------------------------------------------------------------------------

test('orderQuad sorts four points clockwise from the top-left, whatever order they were clicked in', () => {
  const want = [[100, 80], [320, 60], [300, 220], [90, 240]];
  assert.deepEqual(orderQuad([[300, 220], [100, 80], [320, 60], [90, 240]]), want);
  assert.deepEqual(orderQuad([[90, 240], [300, 220], [320, 60], [100, 80]]), want);
  assert.deepEqual(orderQuad(want), want);
  // objects with x / y work too
  assert.deepEqual(orderQuad([{ x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 0 }]), [[0, 0], [10, 0], [10, 10], [0, 10]]);
});

test('isConvexQuad accepts convex quads and refuses dented, crossed and flat ones', () => {
  assert.equal(isConvexQuad([[0, 0], [10, 0], [10, 10], [0, 10]]), true);
  assert.equal(isConvexQuad([[100, 60], [300, 90], [330, 250], [70, 220]]), true);
  assert.equal(isConvexQuad([[0, 0], [10, 0], [3, 3], [0, 10]]), false); // a corner points inwards
  assert.equal(isConvexQuad([[0, 0], [10, 10], [10, 0], [0, 10]]), false); // edges cross
  assert.equal(isConvexQuad([[0, 0], [5, 0], [10, 0], [0, 10]]), false); // three corners in a line
});

test('naturalSize takes the longer of opposite edges; outputSize honours W and H and keeps proportions with one of them', () => {
  const q = [[0, 0], [200, 0], [180, 100], [20, 100]];
  assert.deepEqual(naturalSize(q), { width: 200, height: Math.round(Math.hypot(20, 100)) });
  assert.deepEqual(naturalSize([[0, 0], [300, 0], [300, 150], [0, 150]]), { width: 300, height: 150 });
  const rect = [[0, 0], [300, 0], [300, 150], [0, 150]];
  assert.deepEqual(outputSize(rect), { width: 300, height: 150 });
  assert.deepEqual(outputSize(rect, 200, 150), { width: 200, height: 150 });
  assert.deepEqual(outputSize(rect, 600, 0), { width: 600, height: 300 });
  assert.deepEqual(outputSize(rect, 0, 50), { width: 100, height: 50 });
  assert.deepEqual(outputSize(rect, 1e9, 10), { width: MAX_SIDE, height: 10 });
  assert.deepEqual(outputSize(rect, 'abc', -4), { width: 300, height: 150 });
});

test('isParallelogram tells boxes and sheared boxes from real perspectives', () => {
  assert.equal(isParallelogram([[100, 50], [300, 50], [300, 250], [100, 250]]), true);
  assert.equal(isParallelogram([[60, 40], [340, 70], [330, 260], [50, 230]]), true); // sheared and rotated, still affine
  assert.equal(isParallelogram([[100, 60], [300, 90], [330, 250], [70, 220]]), false);
});

test('the homography of an ordered quad sends its corners to the rectangle and its diagonal crossing to the centre', () => {
  const q = orderQuad([[330, 250], [100, 60], [70, 220], [300, 90]]);
  const { width: W, height: H } = outputSize(q, 200, 150);
  const Hf = T.homography(q, [[0, 0], [W, 0], [W, H], [0, H]]);
  const corners = q.map(([x, y]) => T.applyHomography(Hf, x, y));
  [[0, 0], [200, 0], [200, 150], [0, 150]].forEach((want, i) => {
    assert.ok(Math.abs(corners[i][0] - want[0]) < 1e-6 && Math.abs(corners[i][1] - want[1]) < 1e-6, `corner ${i}: ${corners[i]}`);
  });
  const [a, b, c, e] = q;
  const den = (a[0] - c[0]) * (b[1] - e[1]) - (a[1] - c[1]) * (b[0] - e[0]);
  const t = ((a[0] - b[0]) * (b[1] - e[1]) - (a[1] - b[1]) * (b[0] - e[0])) / den;
  const centre = T.applyHomography(Hf, a[0] + t * (c[0] - a[0]), a[1] + t * (c[1] - a[1]));
  assert.ok(Math.abs(centre[0] - 100) < 1e-6 && Math.abs(centre[1] - 75) < 1e-6, `centre: ${centre}`);
});

// ---- File Info ----------------------------------------------------------------------------------------------

test('parseKeywords splits on semicolons, commas and lines, trims, and drops duplicates whatever their case', () => {
  assert.deepEqual(parseKeywords('harbour; boats, Harbour ;dawn\n fog '), ['harbour', 'boats', 'dawn', 'fog']);
  assert.deepEqual(parseKeywords(['a', ' a ', 'B', '', null]), ['a', 'B']);
  assert.deepEqual(parseKeywords(undefined), []);
});

test('normaliseInfo cleans the fields and hasInfo knows an empty record', () => {
  const m = normaliseInfo({ title: '  T ', rating: 9, keywords: 'x; y', copyrightStatus: 'nonsense', description: 'two\nlines\n\n' });
  assert.equal(m.title, 'T');
  assert.equal(m.rating, 5);
  assert.deepEqual(m.keywords, ['x', 'y']);
  assert.equal(m.copyrightStatus, 'unknown');
  assert.equal(m.description, 'two\nlines');
  assert.equal(normaliseInfo({ rating: -3 }).rating, 0);
  assert.equal(normaliseInfo({ rating: 'x' }).rating, 0);
  assert.equal(hasInfo({}), false);
  assert.equal(hasInfo({ exif: { iso: 100 }, layerTags: {} }), false);
  assert.equal(hasInfo({ rating: 1 }), true);
  assert.equal(hasInfo({ copyrightStatus: 'public' }), true);
  assert.equal(xmpPacket({}), '');
});

const META = { title: 'Harbour <at> dawn', author: 'A. Painter & Son', description: 'Boats, "gulls"\nand fog', copyright: '© 2026 A. Painter', keywords: ['harbour', 'boats & nets', 'dawn'], rating: 4, credit: 'Studio North', source: 'Scan', copyrightStatus: 'copyrighted', copyrightUrl: 'https://example.com/rights?a=1&b=2' };

test('xmpPacket writes a well-formed packet and parseXmp reads every field back', () => {
  const packet = xmpPacket(META);
  assert.ok(packet.startsWith('<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>'));
  assert.ok(packet.endsWith('<?xpacket end="w"?>'));
  assert.ok(packet.includes('<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Harbour &lt;at&gt; dawn</rdf:li></rdf:Alt></dc:title>'));
  assert.ok(packet.includes('<dc:subject><rdf:Bag><rdf:li>harbour</rdf:li><rdf:li>boats &amp; nets</rdf:li><rdf:li>dawn</rdf:li></rdf:Bag></dc:subject>'));
  assert.ok(packet.includes('<xmp:Rating>4</xmp:Rating>'));
  assert.ok(packet.includes('<xmpRights:Marked>True</xmpRights:Marked>'));
  // no raw ampersand or angle bracket of the content survives unescaped
  assert.equal(/&(?!amp;|lt;|gt;|quot;)/.test(packet), false);
  assert.deepEqual(parseXmp(packet), META);
  // only what is set is written, and read
  const small = xmpPacket({ keywords: 'one', copyrightStatus: 'public' });
  assert.equal(small.includes('dc:title'), false);
  assert.equal(small.includes('xmp:Rating'), false);
  assert.deepEqual(parseXmp(small), { keywords: ['one'], copyrightStatus: 'public' });
  assert.deepEqual(parseXmp('not xml'), {});
  assert.deepEqual(parseXmp(null), {});
});

test('parseXmp reads the attribute form Adobe applications write', () => {
  const adobe = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/" xmlns:dc="http://purl.org/dc/elements/1.1/"
      xmp:Rating="3" photoshop:Credit="Wire &amp; Co" photoshop:Source="Agency" xmpRights:Marked="False" xmpRights:WebStatement="https://example.org">
      <dc:creator><rdf:Seq><rdf:li>Ann</rdf:li><rdf:li>Bob</rdf:li></rdf:Seq></dc:creator>
      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Caf&#233; &#x2713;</rdf:li></rdf:Alt></dc:title>
    </rdf:Description></rdf:RDF></x:xmpmeta>`;
  assert.deepEqual(parseXmp(adobe), { title: 'Café ✓', author: 'Ann; Bob', rating: 3, credit: 'Wire & Co', source: 'Agency', copyrightStatus: 'public', copyrightUrl: 'https://example.org' });
});

test('findXmp digs the packet out of surrounding bytes', () => {
  const packet = xmpPacket({ title: 'Ünïcode ✓' });
  const text = new TextEncoder().encode(packet);
  const bytes = new Uint8Array(300 + text.length + 50);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37) & 0xff;
  bytes[5] = 0x3c; // a stray "<" before the packet must not confuse the search
  bytes.set(text, 300);
  const found = findXmp(bytes);
  assert.ok(found.startsWith('<x:xmpmeta') && found.endsWith('</x:xmpmeta>'));
  assert.deepEqual(parseXmp(found), { title: 'Ünïcode ✓' });
  assert.equal(findXmp(new Uint8Array(64)), '');
});

test('ag-psd keeps imageResources.xmpMetadata through a PSD write and read (what the PSD export relies on)', () => {
  const { writePsdBuffer, readPsd } = require('ag-psd');
  const packet = xmpPacket(META);
  const psd = { width: 2, height: 2, channels: 4, imageData: { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(255) }, children: [], imageResources: { xmpMetadata: packet, resolutionInfo: { horizontalResolution: 72, horizontalResolutionUnit: 'PPI', widthUnit: 'Inches', verticalResolution: 72, verticalResolutionUnit: 'PPI', heightUnit: 'Inches' } } };
  const bytes = new Uint8Array(writePsdBuffer(psd, {}));
  const back = readPsd(bytes, { skipCompositeImageData: true, skipLayerImageData: true, skipThumbnail: true });
  assert.equal(back.imageResources.xmpMetadata, packet);
  assert.deepEqual(parseXmp(back.imageResources.xmpMetadata), META);
  // and the packet can be found in the raw PSD bytes without a PSD parser (how File Info reads it on open)
  assert.deepEqual(parseXmp(findXmp(bytes)), META);
});

test('injectPsdXmp adds the packet to a PSD that has none, and ag-psd reads it back with everything else intact', () => {
  const { writePsdBuffer, readPsd, initializeCanvas } = require('ag-psd');
  // no canvas in Node: layer pixels are read into plain ImageData-like objects
  initializeCanvas(() => {
    throw new Error('no canvas in this test');
  }, (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }));
  const pixels = new Uint8ClampedArray(4 * 3 * 4);
  for (let i = 0; i < pixels.length; i++) pixels[i] = i % 4 === 3 ? 255 : (i * 23) & 255;
  const layer = { name: 'Layer 1', left: 0, top: 0, right: 4, bottom: 3, imageData: { width: 4, height: 3, data: pixels.slice() } };
  for (const resources of [{ resolutionInfo: { horizontalResolution: 300, horizontalResolutionUnit: 'PPI', widthUnit: 'Inches', verticalResolution: 300, verticalResolutionUnit: 'PPI', heightUnit: 'Inches' } }, undefined]) {
    const plain = new Uint8Array(writePsdBuffer({ width: 4, height: 3, channels: 4, imageData: { width: 4, height: 3, data: pixels.slice() }, children: [layer], imageResources: resources }, {}));
    const packet = xmpPacket(META);
    const stamped = injectPsdXmp(plain, packet);
    assert.notEqual(stamped, plain);
    assert.equal(stamped.length, plain.length + 12 + ((new TextEncoder().encode(packet).length + 1) & ~1));
    const back = readPsd(stamped, { useImageData: true, skipThumbnail: true });
    assert.equal(back.imageResources.xmpMetadata, packet);
    assert.equal(back.width, 4);
    assert.equal(back.children.length, 1);
    assert.equal(back.children[0].name, 'Layer 1');
    assert.deepEqual(Array.from(back.children[0].imageData.data), Array.from(pixels));
    if (resources) assert.equal(back.imageResources.resolutionInfo.horizontalResolution, 300);
    // a PSD that already carries a packet is left alone, byte for byte; so is anything that is not a PSD
    assert.equal(injectPsdXmp(stamped, xmpPacket({ title: 'Other' })), stamped);
  }
  const png = new Uint8Array(64).fill(7);
  assert.equal(injectPsdXmp(png, 'x'), png);
  assert.equal(injectPsdXmp(new Uint8Array([0x38, 0x42, 0x50, 0x53]), 'x').length, 4);
});

/** A JPEG whose only content is an Exif segment (byte order `le`): enough for the camera data reader. */
function jpegWithExif(le) {
  const tiff = [];
  const u16 = (v) => (le ? [v & 255, v >> 8] : [v >> 8, v & 255]);
  const u32 = (v) => (le ? [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255] : [(v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255]);
  const ascii = (s) => [...s].map((c) => c.charCodeAt(0)).concat(0);
  // layout: header(8) | IFD0 (2 + 4*12 + 4 = 54) @8 | Exif IFD (2 + 7*12 + 4 = 90) @62 | data @152
  const data = [];
  const dataAt = 152;
  const put = (bytes) => {
    const at = dataAt + data.length;
    data.push(...bytes);
    if (data.length % 2) data.push(0);
    return at;
  };
  const entry = (tag, type, count, value) => [...u16(tag), ...u16(type), ...u32(count), ...value];
  const inline16 = (v) => [...u16(v), 0, 0];
  const make = ascii('Canon'), model = ascii('Canon EOS R5'), date = ascii('2026:03:14 08:15:00'), lens = ascii('RF 50mm F1.8');
  const ifd0 = [
    entry(0x010f, 2, make.length, u32(put(make))),
    entry(0x0110, 2, model.length, u32(put(model))),
    entry(0x0112, 3, 1, inline16(1)),
    entry(0x8769, 4, 1, u32(62)),
  ];
  const exif = [
    entry(0x829a, 5, 1, u32(put([...u32(1), ...u32(250)]))),
    entry(0x829d, 5, 1, u32(put([...u32(28), ...u32(10)]))),
    entry(0x8827, 3, 1, inline16(400)),
    entry(0x9003, 2, date.length, u32(put(date))),
    entry(0x9209, 3, 1, inline16(16)),
    entry(0x920a, 5, 1, u32(put([...u32(50), ...u32(1)]))),
    entry(0xa434, 2, lens.length, u32(put(lens))),
  ];
  tiff.push(...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8));
  tiff.push(...u16(ifd0.length), ...ifd0.flat(), ...u32(0));
  tiff.push(...u16(exif.length), ...exif.flat(), ...u32(0));
  assert.equal(tiff.length, dataAt);
  tiff.push(...data);
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const len = body.length + 2;
  // SOI, a JFIF segment the reader has to step over, the Exif segment, EOI
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0x4a, 0x46, 0xff, 0xe1, len >> 8, len & 255, ...body, 0xff, 0xd9]);
}

test('readExif reads camera data from both byte orders and describeExif words it', () => {
  for (const le of [true, false]) {
    const exif = readExif(jpegWithExif(le));
    assert.equal(exif.make, 'Canon');
    assert.equal(exif.model, 'Canon EOS R5');
    assert.equal(exif.lens, 'RF 50mm F1.8');
    assert.equal(exif.iso, 400);
    assert.equal(exif.flash, 16);
    assert.ok(Math.abs(exif.exposureTime - 1 / 250) < 1e-9);
    assert.ok(Math.abs(exif.fNumber - 2.8) < 1e-9);
    assert.equal(exif.focalLength, 50);
    assert.equal(exif.dateTimeOriginal, '2026:03:14 08:15:00');
    assert.deepEqual(describeExif(exif), [
      ['Camera', 'Canon EOS R5'],
      ['Lens', 'RF 50mm F1.8'],
      ['Exposure', '1/250 s at f/2.8'],
      ['ISO', '400'],
      ['Focal length', '50 mm'],
      ['Flash', 'Did not fire'],
      ['Date taken', '2026-03-14 08:15:00'],
    ]);
  }
  // not a photograph, a truncated file, garbage: no camera data, no exception
  assert.equal(readExif(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])), null);
  assert.equal(readExif(jpegWithExif(true).subarray(0, 40)), null);
  assert.equal(readExif(new Uint8Array(0)), null);
  assert.deepEqual(describeExif(null), []);
  assert.deepEqual(describeExif({ make: 'NIKON', model: 'Z 8', exposureTime: 2, fNumber: 11, focalLength: 24, focalLength35: 36, flash: 1 }), [['Camera', 'NIKON Z 8'], ['Exposure', '2 s at f/11'], ['Focal length', '24 mm (36 mm in 35 mm film)'], ['Flash', 'Fired']]);
});
