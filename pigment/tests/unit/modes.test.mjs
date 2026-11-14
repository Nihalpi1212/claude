// Image modes: conversions (modes.js), quantisation (quantize.js) and the GIF codec (gif.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createImage, setPixel, getPixel, solidImage, gradientImage } from './helpers.mjs';
import {
  MODES, MODE_IDS, canConvert, conversionPath, FLATTENING_MODES, luma, toGrayscale, toBitmap, BITMAP_METHODS, HALFTONE_SHAPES,
  DUOTONE_PRESETS, normalizeDuotone, inkCoverage, duotoneLut, applyDuotone, constrainColor, constrainImage, renderMode,
  channelPlanes, splitChannels, renderMultichannel, trap, convertPixels,
} from '../../src/shared/pixels/modes.js';
import {
  quantize, remap, medianCut, colorHistogram, countColors, createMapper, buildPalette, prepareForIndex, indicesToImage,
  webPalette, macSystemPalette, windowsSystemPalette, uniformPalette, parseAct, writeAct, BAYER8, hashNoise,
} from '../../src/shared/pixels/quantize.js';
import { encodeGif, decodeGif, lzwEncode, lzwDecode, isGif, gifFrameIndices, gifFrameImage } from '../../src/shared/pixels/gif.js';
import { encodePng, decodePng, toRgba8 } from '../../src/shared/pixels/png.js';

const px = (img, x, y) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
};
const one = (rgba) => ({ width: 1, height: 1, data: Uint8ClampedArray.from(rgba) });
const blackShare = (img) => {
  let black = 0;
  for (let i = 0; i < img.data.length; i += 4) if (img.data[i] === 0) black++;
  return black / (img.width * img.height);
};
/** Deterministic colourful test image (smooth gradients, thousands of colours). */
function rainbow(w = 64, h = 48) {
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    img.data[i] = Math.round((x / (w - 1)) * 255);
    img.data[i + 1] = Math.round((y / (h - 1)) * 255);
    img.data[i + 2] = Math.round(127.5 + 127.5 * Math.sin((x + y) / 7));
    img.data[i + 3] = 255;
  }
  return img;
}
const distinct = (img) => {
  const s = new Set();
  for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 3]) s.add((img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2]);
  return s;
};

// ---- the mode table --------------------------------------------------------------------------------------------

test('MODES lists the eight modes with their channel names', () => {
  assert.deepEqual(MODE_IDS, ['bitmap', 'grayscale', 'duotone', 'indexed', 'rgb', 'cmyk', 'lab', 'multichannel']);
  assert.deepEqual(MODES.rgb.channels.map((c) => c.name), ['Red', 'Green', 'Blue']);
  assert.deepEqual(MODES.cmyk.channels.map((c) => c.name), ['Cyan', 'Magenta', 'Yellow', 'Black']);
  assert.deepEqual(MODES.lab.channels.map((c) => c.name), ['Lightness', 'a', 'b']);
  assert.deepEqual(MODES.grayscale.channels.map((c) => c.name), ['Gray']);
  assert.deepEqual(MODES.indexed.channels.map((c) => c.name), ['Index']);
  assert.equal(MODES.multichannel.channels.length, 0);
  assert.deepEqual(MODES.rgb.depths, [8, 16, 32]);
  assert.deepEqual(MODES.bitmap.depths, [1]);
  assert.deepEqual(FLATTENING_MODES, ['bitmap', 'indexed', 'multichannel']);
});

test('conversion paths follow Photoshop: bitmap only through grayscale, duotone from grayscale', () => {
  assert.equal(canConvert('rgb', 'grayscale'), true);
  assert.equal(canConvert('rgb', 'bitmap'), false);
  assert.equal(canConvert('grayscale', 'bitmap'), true);
  assert.equal(canConvert('rgb', 'duotone'), false);
  assert.equal(canConvert('rgb', 'rgb'), false);
  assert.deepEqual(conversionPath('rgb', 'bitmap'), ['rgb', 'grayscale', 'bitmap']);
  assert.deepEqual(conversionPath('rgb', 'duotone'), ['rgb', 'grayscale', 'duotone']);
  assert.deepEqual(conversionPath('bitmap', 'cmyk'), ['bitmap', 'grayscale', 'cmyk']);
  assert.deepEqual(conversionPath('lab', 'lab'), ['lab']);
  assert.equal(conversionPath('rgb', 'nope'), null);
  // every pair is reachable in at most three steps
  for (const a of MODE_IDS) for (const b of MODE_IDS) {
    const p = conversionPath(a, b);
    assert.ok(p && p.length <= 3 && p[0] === a && p[p.length - 1] === b, `${a} -> ${b}: ${p}`);
  }
});

// ---- every conversion pair on known pixels ---------------------------------------------------------------------

test('every mode pair converts a known pixel to known values', () => {
  const red = one([255, 0, 0, 255]);
  // what a pure red pixel is after reaching each mode from RGB
  const fromRgb = {
    grayscale: [76, 76, 76, 255], // Rec. 601: 0.299 * 255 = 76.2
    bitmap: [0, 0, 0, 255], // 76 < 128
    duotone: [76, 76, 76, 255], // pixels stay grey; the ink colours are a display matter
    indexed: [255, 0, 0, 255],
    rgb: [255, 0, 0, 255],
    cmyk: [255, 0, 0, 255], // stored pixels are untouched: channels are derived
    lab: [255, 0, 0, 255],
    multichannel: [255, 0, 0, 255],
  };
  for (const to of MODE_IDS) {
    const out = convertPixels(red, 'rgb', to, { colors: 8 });
    assert.equal(out.mode, to);
    assert.deepEqual(px(out, 0, 0), fromRgb[to], `rgb -> ${to}`);
    // and back to RGB: grey modes give their grey, the others the colour
    const back = convertPixels(out, to, 'rgb', { source: out });
    const expect = to === 'duotone' ? null : fromRgb[to];
    if (expect) assert.deepEqual(px(back, 0, 0), expect, `${to} -> rgb`);
  }
  // the input is never modified
  assert.deepEqual(px(red, 0, 0), [255, 0, 0, 255]);
  // all 64 pairs run and keep the size
  const img = rainbow(8, 6);
  for (const a of MODE_IDS) {
    const inA = convertPixels(img, 'rgb', a, { colors: 16 });
    for (const b of MODE_IDS) {
      const out = convertPixels(inA, a, b, { colors: 16, source: inA });
      assert.equal(out.mode, b);
      assert.equal(out.data.length, img.data.length, `${a} -> ${b}`);
      if (b === 'grayscale' || b === 'duotone') for (let i = 0; i < out.data.length; i += 4) assert.ok(out.data[i] === out.data[i + 1] && out.data[i + 1] === out.data[i + 2], `${a} -> ${b} is grey`);
      if (b === 'bitmap') for (let i = 0; i < out.data.length; i += 4) assert.ok((out.data[i] === 0 || out.data[i] === 255) && out.data[i] === out.data[i + 1] && out.data[i] === out.data[i + 2] && out.data[i + 3] === 255, `${a} -> bitmap is black/white`);
      if (b === 'indexed') {
        assert.ok(out.colorTable.length >= 1 && out.colorTable.length <= 16);
        const table = new Set(out.colorTable.map((c) => (c[0] << 16) | (c[1] << 8) | c[2]));
        for (const c of distinct(out)) assert.ok(table.has(c), `${a} -> indexed pixel in table`);
      }
    }
  }
});

test('grayscale: Rec. 601 luma by default, linear-light luminance on request', () => {
  assert.equal(luma(255, 0, 0), 76);
  assert.equal(luma(0, 255, 0), 150);
  assert.equal(luma(0, 0, 255), 29);
  assert.equal(luma(255, 255, 255), 255);
  const img = { width: 4, height: 1, data: Uint8ClampedArray.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 90, 90, 90, 255]) };
  toGrayscale(img);
  assert.deepEqual([...img.data], [76, 76, 76, 255, 150, 150, 150, 128, 29, 29, 29, 255, 90, 90, 90, 255]);
  // luminance: Rec. 709 in linear light, sRGB-encoded: red 0.2126 -> 127, green 0.7152 -> 220, blue 0.0722 -> 76
  const lin = { width: 3, height: 1, data: Uint8ClampedArray.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]) };
  toGrayscale(lin, { method: 'luminance' });
  assert.deepEqual([lin.data[0], lin.data[4], lin.data[8]], [127, 220, 76]);
  // rect limits writes
  const part = solidImage(4, 4, [255, 0, 0, 1]);
  toGrayscale(part, {}, { x: 1, y: 1, width: 2, height: 2 });
  assert.deepEqual(px(part, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(px(part, 1, 1), [76, 76, 76, 255]);
  assert.deepEqual(px(part, 3, 3), [255, 0, 0, 255]);
});

// ---- bitmap ----------------------------------------------------------------------------------------------------

test('bitmap 50% threshold: 127 is black, 128 is white', () => {
  const img = { width: 4, height: 1, data: Uint8ClampedArray.from([127, 127, 127, 255, 128, 128, 128, 255, 0, 0, 0, 255, 255, 255, 255, 255]) };
  const out = convertPixels(img, 'grayscale', 'bitmap', { method: '50-threshold' });
  assert.deepEqual([out.data[0], out.data[4], out.data[8], out.data[12]], [0, 255, 0, 255]);
  // a transparent pixel is paper: white, opaque
  const clear = convertPixels(one([0, 0, 0, 0]), 'grayscale', 'bitmap', {});
  assert.deepEqual(px(clear, 0, 0), [255, 255, 255, 255]);
});

test('Floyd–Steinberg on a 50% grey block gives about 50% black, and tracks other tones', () => {
  for (const [grey, share] of [[128, 0.5], [64, 0.75], [191, 0.25], [26, 0.9]]) {
    const img = solidImage(64, 64, [grey, grey, grey, 1]);
    toBitmap(img, { method: 'diffusion-dither' });
    const got = blackShare(img);
    assert.ok(Math.abs(got - share) < 0.02, `grey ${grey}: ${got} vs ${share}`);
    for (let i = 0; i < img.data.length; i += 4) assert.ok(img.data[i] === 0 || img.data[i] === 255);
  }
  // 50% grey must not come out as large runs: no row is all one colour
  const img = solidImage(32, 32, [128, 128, 128, 1]);
  toBitmap(img, { method: 'diffusion-dither' });
  for (let y = 0; y < 32; y++) {
    let b = 0;
    for (let x = 0; x < 32; x++) if (px(img, x, y)[0] === 0) b++;
    assert.ok(b > 8 && b < 24, `row ${y}: ${b}`);
  }
});

test('pattern dither, halftone screen and custom pattern keep the tone', () => {
  assert.deepEqual(BITMAP_METHODS, ['50-threshold', 'pattern-dither', 'diffusion-dither', 'halftone-screen', 'custom-pattern']);
  // Bayer: exact on an 8x8 tile for every multiple of 1/64
  assert.equal(new Set(BAYER8).size, 64);
  for (const grey of [0, 64, 128, 191, 255]) {
    const img = solidImage(64, 64, [grey, grey, grey, 1]);
    toBitmap(img, { method: 'pattern-dither' });
    assert.ok(Math.abs(blackShare(img) - (1 - grey / 255)) < 0.01, `pattern ${grey}: ${blackShare(img)}`);
  }
  for (const shape of HALFTONE_SHAPES) for (const grey of [64, 128, 200]) {
    const img = solidImage(120, 120, [grey, grey, grey, 1]);
    toBitmap(img, { method: 'halftone-screen', frequency: 6, angle: 45, shape, dpi: 72 });
    assert.ok(Math.abs(blackShare(img) - (1 - grey / 255)) < 0.06, `${shape} ${grey}: ${blackShare(img)}`);
  }
  // white stays white and black stays black under every method
  for (const method of BITMAP_METHODS) {
    const w = solidImage(16, 16, [255, 255, 255, 1]), k = solidImage(16, 16, [0, 0, 0, 1]);
    const pattern = gradientImage(4, 4);
    toBitmap(w, { method, pattern });
    toBitmap(k, { method, pattern });
    assert.equal(blackShare(w), 0, `${method} white`);
    assert.equal(blackShare(k), 1, `${method} black`);
  }
  // custom pattern: a 2x1 tile [black, white] thresholds at ~0 and ~255 -> mid grey gives alternating columns
  const tile = { width: 2, height: 1, data: Uint8ClampedArray.from([0, 0, 0, 255, 255, 255, 255, 255]) };
  const img = solidImage(8, 2, [128, 128, 128, 1]);
  toBitmap(img, { method: 'custom-pattern', pattern: tile });
  assert.deepEqual([px(img, 0, 0)[0], px(img, 1, 0)[0], px(img, 2, 0)[0], px(img, 3, 0)[0]], [255, 0, 255, 0]);
  // a halftone at 0 degrees repeats with the cell size
  const h = solidImage(40, 40, [100, 100, 100, 1]);
  toBitmap(h, { method: 'halftone-screen', frequency: 9, angle: 0, shape: 'round', dpi: 72 }); // cell = 8 px
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) assert.equal(px(h, x, y)[0], px(h, x + 8, y + 8)[0]);
});

// ---- duotone ---------------------------------------------------------------------------------------------------

test('duotone LUT: black is the darkest ink mix, white is paper, curves shape the tones', () => {
  const sepia = { type: 'duotone', inks: [{ name: 'Black', color: '#000000', curve: [[0, 0], [100, 100]] }, { name: 'Sepia', color: '#a8713f', curve: [[0, 0], [100, 100]] }] };
  const lut = duotoneLut(sepia);
  assert.equal(lut.length, 768);
  assert.deepEqual([lut[0], lut[1], lut[2]], [0, 0, 0]); // black ink at 100% covers everything
  assert.deepEqual([lut[765], lut[766], lut[767]], [255, 255, 255]);
  // two coloured inks: black is the product of the ink colours (multiplicative overprint)
  const two = { type: 'duotone', inks: [{ name: 'A', color: [255, 128, 0] }, { name: 'B', color: [128, 255, 64] }] };
  const l2 = duotoneLut(two);
  assert.deepEqual([l2[0], l2[1], l2[2]], [128, 128, 0]); // 255*128/255, 128*255/255, 0*64/255
  // the darkest entry of the LUT is grey 0, and the LUT never gets darker as the grey gets lighter
  for (let v = 1; v < 256; v++) for (let c = 0; c < 3; c++) assert.ok(l2[v * 3 + c] >= l2[(v - 1) * 3 + c], `monotone at ${v}`);
  // a monotone with one ink: mid grey is half ink on paper
  const mono = duotoneLut({ type: 'monotone', inks: [{ name: 'Blue', color: [0, 0, 255] }] });
  assert.deepEqual([mono[0], mono[1], mono[2]], [0, 0, 255]);
  const mid = [mono[128 * 3], mono[128 * 3 + 1], mono[128 * 3 + 2]];
  assert.ok(Math.abs(mid[0] - 128) <= 1 && Math.abs(mid[1] - 128) <= 1 && mid[2] === 255, `mid ${mid}`);
  // curves: an ink whose curve is flat zero prints nothing
  const off = duotoneLut({ type: 'duotone', inks: [{ name: 'Black', color: '#000000' }, { name: 'Red', color: '#ff0000', curve: [[0, 0], [100, 0]] }] });
  assert.deepEqual([off[128 * 3], off[128 * 3 + 1], off[128 * 3 + 2]], [128, 128, 128]);
  // inkCoverage: 0 = black = full coverage with a straight curve
  const cover = inkCoverage([[0, 0], [100, 100]]);
  assert.ok(Math.abs(cover[0] - 1) < 1e-6 && Math.abs(cover[255]) < 1e-6 && Math.abs(cover[128] - 127 / 255) < 0.01);
  // `only` prints a subset of the inks
  const onlyB = duotoneLut(two, [1]);
  assert.deepEqual([onlyB[0], onlyB[1], onlyB[2]], [128, 255, 64]);
});

test('duotone conversion keeps grey pixels and renders through the inks', () => {
  const grey = gradientImage(16, 2);
  const out = convertPixels(grey, 'grayscale', 'duotone', { duotone: DUOTONE_PRESETS.find((p) => p.id === 'sepia') });
  assert.equal(out.duotone.type, 'duotone');
  assert.equal(out.duotone.inks.length, 2);
  assert.deepEqual([...out.data], [...grey.data]);
  const shown = { width: out.width, height: out.height, data: new Uint8ClampedArray(out.data) };
  renderMode(shown, 'duotone', { duotone: out.duotone });
  const mid = px(shown, 8, 0);
  assert.ok(mid[0] > mid[1] && mid[1] > mid[2], `sepia mid tone is warm: ${mid}`);
  assert.deepEqual(px(shown, 15, 0), [255, 255, 255, 255]);
  // duotone -> rgb bakes the ink colours into the pixels
  const rgb = convertPixels(out, 'duotone', 'rgb', { source: { duotone: out.duotone } });
  assert.deepEqual([...rgb.data], [...shown.data]);
  // duotone -> grayscale keeps the greys
  const back = convertPixels(out, 'duotone', 'grayscale', { source: { duotone: out.duotone } });
  assert.deepEqual([...back.data], [...grey.data]);
  // applyDuotone with a LUT equals renderMode
  const again = { width: out.width, height: out.height, data: new Uint8ClampedArray(out.data) };
  applyDuotone(again, duotoneLut(out.duotone));
  assert.deepEqual([...again.data], [...shown.data]);
});

test('normalizeDuotone fills in a complete description', () => {
  const d = normalizeDuotone({ type: 'tritone', inks: [{ color: '#f00' }] });
  assert.equal(d.type, 'tritone');
  assert.equal(d.inks.length, 3);
  assert.equal(d.inks[0].color, '#ff0000');
  assert.equal(d.inks[0].name, 'Black');
  assert.deepEqual(d.inks[1].curve, [[0, 0], [100, 100]]);
  assert.equal(normalizeDuotone(null).type, 'monotone');
  assert.equal(normalizeDuotone({ inks: [{}, {}] }).type, 'duotone');
  for (const p of DUOTONE_PRESETS) {
    const n = normalizeDuotone(p);
    assert.equal(n.type, p.type);
    assert.equal(n.inks.length, p.inks.length);
  }
});

// ---- constraints -----------------------------------------------------------------------------------------------

test('constrainColor and constrainImage keep colours inside a mode', () => {
  assert.deepEqual(constrainColor('grayscale', [255, 0, 0]), [76, 76, 76]);
  assert.deepEqual(constrainColor('duotone', [0, 255, 0]), [150, 150, 150]);
  assert.deepEqual(constrainColor('bitmap', [255, 0, 0]), [0, 0, 0]);
  assert.deepEqual(constrainColor('bitmap', [0, 255, 0]), [255, 255, 255]);
  assert.deepEqual(constrainColor('rgb', [12, 34, 56]), [12, 34, 56]);
  assert.deepEqual(constrainColor('cmyk', [12, 34, 56]), [12, 34, 56]);
  const table = [[255, 0, 0], [0, 0, 255], [255, 255, 255], [0, 0, 0]];
  assert.deepEqual(constrainColor('indexed', [200, 30, 40], table), [255, 0, 0]);
  assert.deepEqual(constrainColor('indexed', [10, 20, 200], table), [0, 0, 255]);
  assert.deepEqual(constrainColor('indexed', [240, 240, 240], table), [255, 255, 255]);
  // the transparent entry is never chosen
  assert.notDeepEqual(constrainColor('indexed', [250, 250, 250], table, 2), [255, 255, 255]);

  const img = { width: 3, height: 1, data: Uint8ClampedArray.from([200, 30, 40, 255, 10, 20, 200, 100, 30, 30, 30, 0]) };
  const idx = { width: 3, height: 1, data: new Uint8ClampedArray(img.data) };
  constrainImage('indexed', idx, table);
  assert.deepEqual([...idx.data], [255, 0, 0, 255, 0, 0, 255, 100, 0, 0, 0, 0]); // alpha kept
  const g = { width: 3, height: 1, data: new Uint8ClampedArray(img.data) };
  constrainImage('grayscale', g);
  assert.deepEqual([...g.data.slice(0, 8)], [82, 82, 82, 255, 38, 38, 38, 100]);
  const b = { width: 3, height: 1, data: new Uint8ClampedArray(img.data) };
  constrainImage('bitmap', b);
  assert.deepEqual([...b.data.slice(0, 8)], [0, 0, 0, 255, 0, 0, 0, 100]);
  const r = { width: 3, height: 1, data: new Uint8ClampedArray(img.data) };
  constrainImage('rgb', r);
  assert.deepEqual([...r.data], [...img.data]);
  // rect
  const big = solidImage(4, 4, [200, 30, 40, 1]);
  constrainImage('indexed', big, table, { x: 0, y: 0, width: 2, height: 4 });
  assert.deepEqual(px(big, 1, 3), [255, 0, 0, 255]);
  assert.deepEqual(px(big, 2, 3), [200, 30, 40, 255]);
});

test('renderMode: what each mode shows', () => {
  const img = () => ({ width: 2, height: 1, data: Uint8ClampedArray.from([255, 0, 0, 255, 250, 250, 250, 90]) });
  const g = renderMode(img(), 'grayscale');
  assert.deepEqual([...g.data], [76, 76, 76, 255, 250, 250, 250, 90]);
  const b = renderMode(img(), 'bitmap');
  assert.deepEqual([...b.data], [0, 0, 0, 255, 255, 255, 255, 90]);
  const i = renderMode(img(), 'indexed', { colorTable: [[255, 10, 10], [255, 255, 255]] });
  assert.deepEqual([...i.data], [255, 10, 10, 255, 255, 255, 255, 0]); // alpha is all or nothing
  const r = renderMode(img(), 'rgb');
  assert.deepEqual([...r.data], [...img().data]);
  const l = renderMode(img(), 'lab');
  assert.deepEqual([...l.data], [...img().data]);
});

// ---- channels --------------------------------------------------------------------------------------------------

test('channelPlanes: red is CMYK 0/100/100/0, RGB and Lab planes hold known values', () => {
  const red = one([255, 0, 0, 255]);
  const cmyk = channelPlanes(red, 'cmyk');
  assert.deepEqual(cmyk.map((p) => p.name), ['Cyan', 'Magenta', 'Yellow', 'Black']);
  // planes are drawn as ink: 255 = none, 0 = solid -> coverage % = (255 - v) / 2.55
  const pct = cmyk.map((p) => Math.round((255 - p.data[0]) / 2.55));
  assert.deepEqual(pct, [0, 100, 100, 0]);
  assert.ok(cmyk.every((p) => p.ink));
  const dark = channelPlanes(one([0, 0, 0, 255]), 'cmyk').map((p) => Math.round((255 - p.data[0]) / 2.55));
  assert.deepEqual(dark, [0, 0, 0, 100]);
  const teal = channelPlanes(one([0, 128, 128, 255]), 'cmyk').map((p) => Math.round((255 - p.data[0]) / 2.55));
  assert.deepEqual(teal, [100, 0, 0, 50]);
  // transparent = bare paper
  assert.deepEqual(channelPlanes(one([0, 0, 0, 0]), 'cmyk').map((p) => p.data[0]), [255, 255, 255, 255]);

  const rgb = channelPlanes(one([200, 100, 50, 255]), 'rgb');
  assert.deepEqual(rgb.map((p) => [p.name, p.data[0]]), [['Red', 200], ['Green', 100], ['Blue', 50]]);
  assert.deepEqual(channelPlanes(one([200, 100, 50, 128]), 'rgb').map((p) => p.data[0]), [100, 50, 25]);

  const lab = channelPlanes(red, 'lab');
  assert.deepEqual(lab.map((p) => p.name), ['Lightness', 'a', 'b']);
  // red: L 53.2, a 80.1, b 67.2 -> L*2.55 = 136, a+128 = 208, b+128 = 195
  assert.ok(Math.abs(lab[0].data[0] - 136) <= 1 && Math.abs(lab[1].data[0] - 208) <= 1 && Math.abs(lab[2].data[0] - 195) <= 1, `${lab.map((p) => p.data[0])}`);
  const white = channelPlanes(one([255, 255, 255, 255]), 'lab').map((p) => p.data[0]);
  assert.deepEqual(white, [255, 128, 128]);

  for (const mode of ['grayscale', 'bitmap', 'duotone', 'indexed']) {
    const planes = channelPlanes(one([255, 0, 0, 255]), mode);
    assert.equal(planes.length, 1);
    assert.equal(planes[0].data[0], 76);
  }
  assert.equal(channelPlanes(red, 'multichannel').length, 0);
});

test('multichannel: splitting into spot channels and rendering what remains', () => {
  const img = one([200, 100, 50, 255]);
  const rgb = splitChannels(img, 'rgb');
  assert.deepEqual(rgb.map((c) => [c.key, c.name, c.data[0]]), [['c', 'Cyan', 200], ['m', 'Magenta', 100], ['y', 'Yellow', 50]]);
  const cmyk = splitChannels(img, 'cmyk');
  assert.deepEqual(cmyk.map((c) => c.name), ['Cyan', 'Magenta', 'Yellow', 'Black']);
  assert.deepEqual(cmyk.map((c) => c.data[0]), [255, 128, 64, 200]); // M 50%, Y 75%, K = 1 - 200/255
  const grey = splitChannels(one([90, 90, 90, 255]), 'grayscale');
  assert.deepEqual(grey.map((c) => [c.name, c.data[0]]), [['Black', 90]]);
  const lab = splitChannels(img, 'lab');
  assert.deepEqual(lab.map((c) => c.name), ['Alpha 1', 'Alpha 2', 'Alpha 3']);

  const out = convertPixels(img, 'rgb', 'multichannel');
  assert.equal(out.channels.length, 3);
  assert.deepEqual(out.multichannel.keys, ['c', 'm', 'y']);
  assert.equal(out.multichannel.source, 'rgb');
  // all channels present: unchanged; without Magenta the green channel is paper white
  const full = renderMultichannel(one([200, 100, 50, 255]), out.multichannel);
  assert.deepEqual(px(full, 0, 0), [200, 100, 50, 255]);
  const noM = renderMultichannel(one([200, 100, 50, 255]), { source: 'rgb', keys: ['c', 'y'] });
  assert.deepEqual(px(noM, 0, 0), [200, 255, 50, 255]);
  const noK = renderMultichannel(one([100, 50, 25, 255]), { source: 'cmyk', keys: ['c', 'm', 'y'] });
  assert.deepEqual(px(noK, 0, 0), [255, 128, 64, 255]); // the black that darkened it is gone
  // duotone source: one channel per ink through its curve
  const duo = normalizeDuotone(DUOTONE_PRESETS.find((p) => p.id === 'sepia'));
  const fromDuo = convertPixels(one([0, 0, 0, 255]), 'duotone', 'multichannel', { source: { duotone: duo } });
  assert.deepEqual(fromDuo.channels.map((c) => c.name), ['Black', 'Sepia']);
  assert.deepEqual(fromDuo.channels.map((c) => c.data[0]), [0, 0]); // both inks solid at black
});

test('trap spreads the lighter ink under the darker one at colour boundaries only', () => {
  // left half yellow (light), right half blue (dark): C100 M100 Y0
  const w = 12, h = 6;
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(img, x, y, x < 6 ? [255, 255, 0, 1] : [0, 0, 255, 1]);
  const out = { width: w, height: h, data: new Uint8ClampedArray(img.data) };
  trap(out, { width: 2 });
  // yellow side untouched
  for (let x = 0; x < 6; x++) assert.deepEqual(px(out, x, 2), [255, 255, 0, 255], `x=${x}`);
  // the two blue columns next to the boundary gained yellow ink: C100 M100 Y100 = black
  assert.deepEqual(px(out, 6, 2), [0, 0, 0, 255]);
  assert.deepEqual(px(out, 7, 2), [0, 0, 0, 255]);
  // beyond the trap width nothing changed
  for (let x = 8; x < w; x++) assert.deepEqual(px(out, x, 2), [0, 0, 255, 255], `x=${x}`);
  // width 1 traps one column
  const one1 = { width: w, height: h, data: new Uint8ClampedArray(img.data) };
  trap(one1, { width: 1 });
  assert.deepEqual(px(one1, 6, 3), [0, 0, 0, 255]);
  assert.deepEqual(px(one1, 7, 3), [0, 0, 255, 255]);
  // a flat image has no boundaries
  const flat = solidImage(6, 6, [10, 120, 200, 1]);
  const before = new Uint8ClampedArray(flat.data);
  trap(flat, { width: 3 });
  assert.deepEqual([...flat.data], [...before]);
});

// ---- quantisation ----------------------------------------------------------------------------------------------

test('median cut of a 4-colour image returns those 4 colours exactly', () => {
  const colours = [[255, 0, 0], [0, 200, 30], [10, 20, 240], [250, 250, 250]];
  const img = createImage(16, 16);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) setPixel(img, x, y, [...colours[(x < 8 ? 0 : 1) + (y < 8 ? 0 : 2)], 1]);
  for (const palette of ['adaptive', 'perceptual', 'selective', 'exact']) {
    const q = quantize(img, { colors: 4, palette, dither: 'none' });
    assert.equal(q.palette.length, 4, palette);
    assert.equal(q.transparentIndex, -1);
    const got = q.palette.map((c) => c.join(',')).sort();
    const want = (palette === 'selective' ? [[255, 0, 0], [0, 200, 30], [10, 20, 240], [255, 255, 255]] : colours).map((c) => c.join(',')).sort();
    assert.deepEqual(got, want, palette);
    if (palette === 'selective') continue;
    // and every pixel maps to its own colour
    const back = indicesToImage(q.indices, q.palette, 16, 16, q.transparentIndex);
    assert.deepEqual([...back.data], [...img.data], palette);
  }
  // asking for more colours than the image has still returns exactly its colours
  const q = quantize(img, { colors: 256, palette: 'adaptive' });
  assert.equal(q.palette.length, 4);
  // medianCut directly: two clusters -> two means
  const hist = colorHistogram({ width: 4, height: 1, data: Uint8ClampedArray.from([10, 10, 10, 255, 20, 20, 20, 255, 200, 200, 200, 255, 220, 220, 220, 255]) });
  assert.equal(hist.n, 4);
  assert.deepEqual(medianCut(hist, 2).map((c) => c[0]).sort((a, b) => a - b), [15, 210]);
});

test('quantize reduces a colourful image to the requested number of colours with low error', () => {
  const img = rainbow(64, 48);
  assert.ok(countColors(img, 256) > 256);
  for (const colors of [2, 4, 16, 64, 256]) {
    const q = quantize(img, { colors, palette: 'adaptive', dither: 'none' });
    assert.ok(q.palette.length <= colors && q.palette.length >= Math.min(colors, 2), `${colors}: ${q.palette.length}`);
    assert.equal(q.indices.length, 64 * 48);
    assert.ok(q.indices.every((k) => k < q.palette.length));
  }
  const err = (q) => {
    const back = indicesToImage(q.indices, q.palette, 64, 48);
    let e = 0;
    for (let i = 0; i < img.data.length; i += 4) for (let c = 0; c < 3; c++) e += (img.data[i + c] - back.data[i + c]) ** 2;
    return Math.sqrt(e / (64 * 48 * 3));
  };
  const e16 = err(quantize(img, { colors: 16 })), e256 = err(quantize(img, { colors: 256 }));
  assert.ok(e256 < 9, `rms with 256 colours: ${e256}`);
  assert.ok(e16 < 40 && e16 > e256, `rms with 16 colours: ${e16}`);
  // perceptual differs from adaptive but is in the same quality class
  const ep = err(quantize(img, { colors: 256, palette: 'perceptual' }));
  assert.ok(ep < 12, `perceptual rms ${ep}`);
  // deterministic
  const a = quantize(img, { colors: 32, dither: 'diffusion' }), b = quantize(img, { colors: 32, dither: 'diffusion' });
  assert.deepEqual(a.palette, b.palette);
  assert.deepEqual([...a.indices], [...b.indices]);
});

test('fixed palettes: web, system, uniform, custom and forced colours', () => {
  const web = webPalette();
  assert.equal(web.length, 216);
  assert.deepEqual(web[0], [255, 255, 255]);
  assert.deepEqual(web[215], [0, 0, 0]);
  assert.ok(web.every((c) => c.every((v) => v % 51 === 0)));
  assert.equal(macSystemPalette().length, 256);
  assert.deepEqual(macSystemPalette()[255], [0, 0, 0]);
  assert.equal(new Set(macSystemPalette().map((c) => c.join())).size, 256);
  assert.equal(windowsSystemPalette().length, 256);
  assert.equal(new Set(windowsSystemPalette().map((c) => c.join())).size, 256);
  assert.equal(uniformPalette(256).length, 216);
  assert.equal(uniformPalette(27).length, 27);
  assert.equal(uniformPalette(8).length, 8);
  assert.deepEqual(uniformPalette(2), [[0, 0, 0], [255, 255, 255]]);

  const img = rainbow(32, 32);
  const qWeb = quantize(img, { palette: 'web', colors: 256 });
  assert.ok(qWeb.palette.every((c) => c.every((v) => v % 51 === 0)));
  const qCustom = quantize(img, { palette: 'custom', custom: [[0, 0, 0], [255, 255, 255], '#ff0000'] });
  assert.deepEqual(qCustom.palette, [[0, 0, 0], [255, 255, 255], [255, 0, 0]]);
  // a fixed palette larger than the colour count keeps the entries the image uses most
  const two = createImage(8, 8, [255, 0, 0, 1]);
  setPixel(two, 0, 0, [0, 0, 255, 1]);
  const qTrim = quantize(two, { palette: 'web', colors: 2 });
  assert.deepEqual(qTrim.palette.map((c) => c.join()).sort(), ['0,0,255', '255,0,0']);
  // forced colours come first in an adaptive palette
  const qBw = quantize(img, { colors: 16, forced: 'black-white' });
  assert.deepEqual(qBw.palette.slice(0, 2), [[0, 0, 0], [255, 255, 255]]);
  assert.equal(qBw.palette.length, 16);
  const qPrim = quantize(img, { colors: 16, forced: 'primaries' });
  assert.deepEqual(qPrim.palette.slice(0, 8).map((c) => c.join()).sort(), ['0,0,0', '0,0,255', '0,255,0', '0,255,255', '255,0,0', '255,0,255', '255,255,0', '255,255,255']);
});

test('transparency, matte and the transparent index', () => {
  const img = createImage(4, 1);
  setPixel(img, 0, 0, [255, 0, 0, 1]);
  setPixel(img, 1, 0, [0, 0, 255, 0.2]); // under 50%: transparent
  setPixel(img, 2, 0, [0, 0, 255, 200 / 255]); // over 50%: opaque (matted when there is a matte)
  // pixel 3 stays fully transparent
  const q = quantize(img, { colors: 8, transparency: true });
  assert.ok(q.transparentIndex >= 0);
  assert.equal(q.indices[1], q.transparentIndex);
  assert.equal(q.indices[3], q.transparentIndex);
  assert.notEqual(q.indices[0], q.transparentIndex);
  assert.deepEqual(q.palette[q.indices[0]], [255, 0, 0]);
  assert.deepEqual(q.palette[q.indices[2]], [0, 0, 255]);
  // no transparency: everything is blended with the matte (white by default)
  const flat = quantize(img, { colors: 8, transparency: false });
  assert.equal(flat.transparentIndex, -1);
  assert.deepEqual(flat.palette[flat.indices[3]], [255, 255, 255]);
  assert.deepEqual(flat.palette[flat.indices[1]], [204, 204, 255]);
  const matte = quantize(img, { colors: 8, transparency: false, matte: '#000000' });
  assert.deepEqual(matte.palette[matte.indices[3]], [0, 0, 0]);
  // transparency + matte: semi-transparent opaque-enough pixels are matted
  const both = quantize(img, { colors: 8, transparency: true, matte: [0, 255, 0] });
  assert.deepEqual(both.palette[both.indices[2]], [0, 55, 200]);
  assert.equal(both.indices[3], both.transparentIndex);
  const prepared = prepareForIndex(img, { transparency: true });
  assert.equal(prepared.hasTransparency, true);
  assert.equal(prepared.data[7], 0);
  assert.equal(prepared.data[11], 255);
});

test('remap: nearest entry, diffusion dither keeps the average tone, pattern and noise dither mix entries', () => {
  const bw = [[0, 0, 0], [255, 255, 255]];
  const grey = solidImage(64, 64, [128, 128, 128, 1]);
  const none = remap(grey, bw, { dither: 'none' });
  assert.ok(none.every((k) => k === 1)); // 128 is nearer white
  for (const dither of ['diffusion', 'pattern', 'noise']) {
    const idx = remap(grey, bw, { dither, ditherAmount: 100 });
    const white = idx.reduce((n, k) => n + k, 0) / idx.length;
    assert.ok(Math.abs(white - 128 / 255) < 0.04, `${dither}: ${white}`);
  }
  // amount 0 switches dithering off
  assert.deepEqual([...remap(grey, bw, { dither: 'diffusion', ditherAmount: 0 })], [...none]);
  // preserveExactColors: palette colours stay themselves under dithering
  const img = createImage(8, 8, [128, 128, 128, 1]);
  for (let x = 0; x < 8; x++) setPixel(img, x, 0, [255, 255, 255, 1]);
  const kept = remap(img, bw, { dither: 'diffusion', preserveExactColors: true });
  for (let x = 0; x < 8; x++) assert.equal(kept[x], 1);
  // the mapper is exact against brute force for a large palette
  const pal = webPalette();
  const mapper = createMapper(pal);
  for (let t = 0; t < 500; t++) {
    const r = Math.floor(hashNoise(t, 1) * 256), g = Math.floor(hashNoise(t, 2) * 256), b = Math.floor(hashNoise(t, 3) * 256);
    let best = 0, bd = Infinity;
    pal.forEach((c, i) => {
      const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    const got = mapper.nearest(r, g, b);
    const gd = (pal[got][0] - r) ** 2 + (pal[got][1] - g) ** 2 + (pal[got][2] - b) ** 2;
    assert.equal(gd, bd, `${r},${g},${b}: ${got} vs ${best}`);
  }
  assert.equal(createMapper(pal, 0).nearest(255, 255, 255) !== 0, true);
  assert.equal(buildPalette(prepareForIndex(grey), { colors: 4 }).length, 1);
});

test('.act colour tables round trip', () => {
  const pal = [[1, 2, 3], [250, 128, 0], [0, 0, 0]];
  const bytes = writeAct(pal, 2);
  assert.equal(bytes.length, 772);
  assert.deepEqual(parseAct(bytes), { palette: pal, transparentIndex: 2 });
  assert.deepEqual(parseAct(writeAct(pal)).transparentIndex, -1);
  // a bare 768-byte table has 256 entries
  const bare = new Uint8Array(768);
  bare[3] = 9;
  const p = parseAct(bare);
  assert.equal(p.palette.length, 256);
  assert.deepEqual(p.palette[1], [9, 0, 0]);
  assert.throws(() => parseAct(new Uint8Array(5)));
});

// ---- GIF -------------------------------------------------------------------------------------------------------

test('LZW round trips random, flat and long data', () => {
  for (const [n, bits, gen] of [
    [1, 2, () => 3],
    [5000, 8, (i) => Math.floor(hashNoise(i, 7) * 256)],
    [70000, 8, () => 5], // flat: long strings, table reset
    [40000, 4, (i) => (i * 7 + (i >> 3)) & 15],
    [300000, 8, (i) => Math.floor(hashNoise(i, 9) * 200)], // forces several clear codes
    [0, 2, () => 0],
  ]) {
    const data = Uint8Array.from({ length: n }, (_, i) => gen(i));
    const sink = lzwEncode(data, bits);
    const packed = sink.done();
    // strip the sub-block framing
    const raw = [];
    for (let p = 0; p < packed.length; ) {
      const len = packed[p++];
      if (!len) break;
      for (let k = 0; k < len; k++) raw.push(packed[p + k]);
      p += len;
    }
    const back = lzwDecode(Uint8Array.from(raw), bits, n);
    assert.equal(back.length, n);
    for (let i = 0; i < n; i++) if (back[i] !== data[i]) assert.fail(`n=${n} differs at ${i}: ${back[i]} vs ${data[i]}`);
  }
});

test('GIF round trip restores indices, palette and transparency', () => {
  const w = 37, h = 23;
  const palette = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [9, 8, 7]];
  const indices = Uint8Array.from({ length: w * h }, (_, i) => (i * 3 + (i >> 4)) % 5);
  const bytes = encodeGif([{ indices, palette, transparentIndex: 4, delay: 0 }], w, h);
  assert.equal(isGif(bytes), true);
  assert.equal(String.fromCharCode(...bytes.subarray(0, 6)), 'GIF89a');
  assert.equal(bytes[bytes.length - 1], 0x3b);
  const gif = decodeGif(bytes);
  assert.equal(gif.width, w);
  assert.equal(gif.height, h);
  assert.equal(gif.frames.length, 1);
  const f = gif.frames[0];
  assert.deepEqual([...f.indices], [...indices]);
  assert.deepEqual(f.palette.slice(0, 5), palette);
  assert.equal(f.palette.length, 8); // tables are powers of two
  assert.equal(f.transparentIndex, 4);
  assert.equal(gifFrameIndices(gif, 0), f.indices);
  const rgba = gifFrameImage(gif, 0);
  assert.deepEqual([...rgba.data.slice(0, 4)], [255, 0, 0, 255]);
  const firstClear = indices.indexOf(4);
  assert.equal(rgba.data[firstClear * 4 + 3], 0);

  // 256 colours, a noisy photo-like image, no transparency
  const img = rainbow(80, 60);
  const q = quantize(img, { colors: 256, dither: 'diffusion' });
  const g2 = decodeGif(encodeGif([{ indices: q.indices, palette: q.palette, transparentIndex: q.transparentIndex }], 80, 60));
  assert.deepEqual([...g2.frames[0].indices], [...q.indices]);
  assert.deepEqual(g2.frames[0].palette.slice(0, q.palette.length), q.palette);
  assert.equal(g2.frames[0].transparentIndex, -1);

  // two colours (the smallest table) and a 1x1 image
  const tiny = decodeGif(encodeGif([{ indices: Uint8Array.from([1]), palette: [[0, 0, 0], [255, 255, 255]] }], 1, 1));
  assert.deepEqual([...tiny.frames[0].indices], [1]);
  assert.deepEqual(tiny.frames[0].palette, [[0, 0, 0], [255, 255, 255]]);

  // several frames with delays and a loop count (0.5 animation)
  const a = new Uint8Array(16).fill(0), b = new Uint8Array(16).fill(1);
  const anim = decodeGif(encodeGif([{ indices: a, palette, delay: 100 }, { indices: b, palette: [[1, 1, 1], [2, 2, 2]], delay: 250 }], 4, 4, { loop: 0 }));
  assert.equal(anim.frames.length, 2);
  assert.equal(anim.loop, 0);
  assert.deepEqual(anim.frames.map((fr) => fr.delay), [100, 250]);
  assert.deepEqual(anim.frames[1].palette, [[1, 1, 1], [2, 2, 2]]);
  assert.deepEqual([...anim.frames[1].indices], [...b]);
  assert.equal(decodeGif(encodeGif([{ indices: a, palette }, { indices: b, palette }], 4, 4), { firstFrameOnly: true }).frames.length, 1);

  assert.throws(() => decodeGif(Uint8Array.from([1, 2, 3])), /not a GIF/);
  assert.throws(() => encodeGif([], 1, 1));
});

test('decodeGif reads an interlaced GIF87a written by hand', () => {
  // 4x4, 2 colours, interlaced; rows 0..3 = indices 0,1,0,1 per row pattern by row number parity
  const rows = [[0, 0, 0, 0], [1, 1, 1, 1], [0, 1, 0, 1], [1, 0, 1, 0]];
  const order = [0, 2, 1, 3]; // interlace passes for 4 rows: 0 | (none at 4) | 2 | 1, 3
  const stream = Uint8Array.from(order.flatMap((r) => rows[r]));
  const sink = lzwEncode(stream, 2);
  const data = sink.done();
  const head = [...'GIF87a'].map((c) => c.charCodeAt(0));
  const bytes = Uint8Array.from([...head, 4, 0, 4, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255, 0x2c, 0, 0, 0, 0, 4, 0, 4, 0, 0x40, 2, ...data, 0x3b]);
  const gif = decodeGif(bytes);
  assert.equal(gif.frames[0].interlaced, true);
  assert.deepEqual([...gif.frames[0].indices], rows.flat());
  assert.deepEqual(gif.frames[0].palette, [[0, 0, 0], [255, 255, 255]]);
});

test('PNG-8: a quantised image survives encodePng indexed and decodes to the same colours', async () => {
  const img = rainbow(40, 30);
  img.data[3] = 0; // one transparent pixel
  const q = quantize(img, { colors: 32, dither: 'none' });
  const palette = new Uint8Array(q.palette.length * 3);
  q.palette.forEach((c, i) => palette.set(c, i * 3));
  const transparency = new Uint8Array(q.palette.length).fill(255);
  if (q.transparentIndex >= 0) transparency[q.transparentIndex] = 0;
  const bytes = await encodePng({ width: 40, height: 30, channels: 1, depth: 8, data: q.indices, palette, transparency }, { indexed: true });
  const dec = await decodePng(bytes);
  assert.equal(dec.colorType, 3);
  const rgba = toRgba8(dec);
  const want = indicesToImage(q.indices, q.palette, 40, 30, q.transparentIndex);
  assert.equal(rgba.data[3], 0);
  for (let i = 4; i < want.data.length; i++) if (rgba.data[i] !== want.data[i]) assert.fail(`PNG-8 differs at ${i}`);
  assert.ok(distinct(rgba).size <= 31);
});
