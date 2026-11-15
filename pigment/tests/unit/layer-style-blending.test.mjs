// layer-style-blending (Pigment 0.4, package 5): Blend If ranges with split points, channel flags, knockout
// arithmetic on ImageData, the mask parts around the effects, and the per-pixel compositing step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRange, isFullRange, rangeWeight, rangeLut, isDefaultBlendIf, grayOf, blendIfWeights, restrictsChannels,
  restrictChannels, knockoutInto, maskPartsAround, alphaBox, compositeAdvanced, FULL_RANGE,
} from '../../src/shared/pixels/blend-if.js';
import { blendImages } from '../../src/shared/pixels/blend.js';
import { createImage, setPixel } from '../../src/shared/pixels/core.js';

const px = (img, x, y) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
const row = (values) => {
  const img = createImage(values.length, 1);
  values.forEach((v, x) => setPixel(img, x, 0, Array.isArray(v) ? v : [v, v, v, 1]));
  return img;
};

test('normalizeRange: clamps, rounds, orders the halves and keeps the sliders from crossing', () => {
  assert.deepEqual(normalizeRange(undefined), [0, 0, 255, 255]);
  assert.deepEqual(normalizeRange([0, 0, 255]), [0, 0, 255, 255]);
  assert.deepEqual(normalizeRange([-5, 20.4, 300, 260]), [0, 20, 255, 255]);
  assert.deepEqual(normalizeRange([80, 40, 250, 200]), [40, 80, 200, 250]);
  assert.deepEqual(normalizeRange([120, 200, 100, 150]), [100, 150, 100, 150]);
  assert.equal(isFullRange(FULL_RANGE), true);
  assert.equal(isFullRange([0, 1, 255, 255]), false);
});

test('rangeWeight: hard cuts keep their own value, split sliders ramp linearly between the halves', () => {
  // unsplit black at 50: 0..49 hidden, 50 shown
  const hard = [50, 50, 200, 200];
  assert.equal(rangeWeight(49, hard), 0);
  assert.equal(rangeWeight(50, hard), 1);
  assert.equal(rangeWeight(200, hard), 1);
  assert.equal(rangeWeight(201, hard), 0);
  // split black 50/100, white 200/250
  const split = [50, 100, 200, 250];
  assert.equal(rangeWeight(40, split), 0);
  assert.equal(rangeWeight(50, split), 0);
  assert.equal(rangeWeight(75, split), 0.5);
  assert.equal(rangeWeight(100, split), 1);
  assert.equal(rangeWeight(150, split), 1);
  assert.equal(rangeWeight(225, split), 0.5);
  assert.equal(rangeWeight(250, split), 0);
  assert.equal(rangeWeight(251, split), 0);
  // the default shows everything
  for (const v of [0, 1, 128, 254, 255]) assert.equal(rangeWeight(v, [0, 0, 255, 255]), 1);
  const lut = rangeLut([0, 100, 255, 255]);
  assert.equal(lut.length, 256);
  assert.ok(Math.abs(lut[25] - 0.25) < 1e-6);
  assert.equal(lut[255], 1);
});

test('isDefaultBlendIf and blendIfWeights: This Layer reads the layer, Underlying Layer the backdrop, channels multiply', () => {
  assert.equal(isDefaultBlendIf(null), true);
  assert.equal(isDefaultBlendIf({ gray: { this: [0, 0, 255, 255], under: [0, 0, 255, 255] } }), true);
  assert.equal(isDefaultBlendIf({ r: { this: [10, 10, 255, 255] } }), false);
  assert.equal(grayOf(255, 255, 255), 255);
  assert.equal(grayOf(255, 0, 0), 76);
  const src = row([0, 64, 128, 255]);
  assert.equal(blendIfWeights(src, null, {}), null);
  // This Layer gray: black split 0/128 (a ramp), so 0 -> 0, 64 -> 0.5, 128 and up -> 1
  const w = blendIfWeights(src, null, { gray: { this: [0, 128, 255, 255] } });
  assert.deepEqual(Array.from(w), [0, 0.5, 1, 1]);
  // Underlying Layer red: white at 100 (hard): an under pixel with red 200 hides the layer
  const under = row([[200, 0, 0, 1], [50, 0, 0, 1], [200, 0, 0, 1], [50, 0, 0, 1]]);
  const w2 = blendIfWeights(src, under, { r: { under: [0, 0, 100, 100] }, gray: { this: [0, 128, 255, 255] } });
  assert.deepEqual(Array.from(w2), [0, 0.5, 0, 1]);
  // the green channel of the layer
  const g = row([[0, 10, 0, 1], [0, 200, 0, 1]]);
  assert.deepEqual(Array.from(blendIfWeights(g, null, { g: { this: [100, 100, 255, 255] } })), [0, 1]);
});

test('channel flags: a switched-off channel keeps the backdrop (premultiplied over transparency)', () => {
  assert.equal(restrictsChannels(null), false);
  assert.equal(restrictsChannels({ r: true, g: true, b: true }), false);
  assert.equal(restrictsChannels({ g: false }), true);
  // opaque grey backdrop, a red layer drawn Normal over it with G and B off: only red changes
  const before = row([[100, 100, 100, 1]]);
  const out = row([[255, 0, 0, 1]]);
  restrictChannels(out, before, { r: true, g: false, b: false });
  assert.deepEqual(px(out, 0, 0), [255, 100, 100, 255]);
  // over transparency the switched-off channel stays 0
  const t0 = row([[0, 0, 0, 0]]);
  const t1 = row([[255, 255, 0, 1]]);
  restrictChannels(t1, t0, { g: false });
  assert.deepEqual(px(t1, 0, 0), [255, 0, 0, 255]);
  // half-transparent backdrop under an opaque result: the premultiplied value is kept
  const h0 = row([[200, 200, 200, 0.5]]);
  const h1 = row([[0, 0, 0, 1]]);
  restrictChannels(h1, h0, { b: false });
  assert.deepEqual(px(h1, 0, 0), [0, 0, 100, 255]);
});

test('knockout arithmetic: the shape alpha times the opacity lerps towards the knockout backdrop', () => {
  const dst = row([[0, 0, 255, 1], [0, 0, 255, 1], [0, 0, 255, 1], [0, 0, 255, 1]]);
  const knock = row([[255, 255, 255, 1], [255, 255, 255, 1], [255, 255, 255, 1], [255, 255, 255, 1]]);
  knockoutInto(dst, knock, new Uint8ClampedArray([0, 255, 128, 255]), 1);
  assert.deepEqual(px(dst, 0, 0), [0, 0, 255, 255]);
  assert.deepEqual(px(dst, 1, 0), [255, 255, 255, 255]);
  assert.deepEqual(px(dst, 2, 0), [128, 128, 255, 255]);
  // to transparency (no Background): full shape clears, half shape halves the alpha and keeps the colour
  const d2 = row([[10, 20, 30, 1], [10, 20, 30, 1]]);
  knockoutInto(d2, null, new Uint8ClampedArray([255, 255]), 0.5);
  assert.deepEqual(px(d2, 0, 0), [10, 20, 30, 128]);
  const d3 = row([[10, 20, 30, 1]]);
  knockoutInto(d3, null, new Uint8ClampedArray([255]), 1);
  assert.deepEqual(px(d3, 0, 0), [0, 0, 0, 0]);
});

test('maskPartsAround: the parts split of the two Hides Effects boxes', () => {
  assert.deepEqual(maskPartsAround(null), { before: 'all', after: null });
  assert.deepEqual(maskPartsAround({ maskHidesEffects: false, vectorMaskHidesEffects: false }), { before: 'all', after: null });
  assert.deepEqual(maskPartsAround({ maskHidesEffects: true, vectorMaskHidesEffects: true }), { before: null, after: 'all' });
  assert.deepEqual(maskPartsAround({ maskHidesEffects: true }), { before: 'vector', after: 'raster' });
  assert.deepEqual(maskPartsAround({ vectorMaskHidesEffects: true }), { before: 'raster', after: 'vector' });
});

test('alphaBox: the box of the non-transparent pixels', () => {
  const img = createImage(10, 8);
  assert.equal(alphaBox(img), null);
  setPixel(img, 2, 3, [0, 0, 0, 0.1]);
  setPixel(img, 7, 5, [0, 0, 0, 1]);
  assert.deepEqual(alphaBox(img), { x: 2, y: 3, width: 6, height: 3 });
});

test('compositeAdvanced: with nothing set it is blendImages; knockout at fill 0 shows the knockout backdrop', () => {
  const base = () => row([[0, 0, 255, 1], [0, 0, 255, 1], [0, 0, 255, 1]]);
  const layer = row([[255, 0, 0, 1], [255, 0, 0, 0.5], [0, 0, 0, 0]]);
  for (const mode of ['normal', 'multiply', 'screen', 'difference', 'color']) {
    const a = compositeAdvanced({ dst: base(), layer, mode, opacity: 0.8 });
    const b = blendImages(mode, layer, base(), 0.8);
    assert.deepEqual(Array.from(a.data), Array.from(b.data), mode);
  }
  // knockout: the layer's shape is fully opaque, its fill 0 (the layer image is transparent): white shows
  const empty = row([[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
  const white = row([[255, 255, 255, 1], [255, 255, 255, 1], [255, 255, 255, 1]]);
  const out = compositeAdvanced({ dst: base(), layer: empty, knock: white, shape: new Uint8ClampedArray([255, 0, 255]), knockout: 'deep' });
  assert.deepEqual(px(out, 0, 0), [255, 255, 255, 255]);
  assert.deepEqual(px(out, 1, 0), [0, 0, 255, 255]);
  // knockout none ignores the shape
  const none = compositeAdvanced({ dst: base(), layer: empty, knock: white, shape: new Uint8ClampedArray([255, 255, 255]), knockout: 'none' });
  assert.deepEqual(px(none, 0, 0), [0, 0, 255, 255]);
});

test('compositeAdvanced: Blend If hides dark layer pixels; channels keep the backdrop; below blends first', () => {
  const dst = row([[0, 0, 255, 1], [0, 0, 255, 1]]);
  const layer = row([[20, 20, 20, 1], [240, 240, 240, 1]]);
  compositeAdvanced({ dst, layer, blendIf: { gray: { this: [128, 128, 255, 255] } } });
  assert.deepEqual(px(dst, 0, 0), [0, 0, 255, 255]);
  assert.deepEqual(px(dst, 1, 0), [240, 240, 240, 255]);
  // Underlying Layer: the backdrop's blue 255 is above white 200 -> hidden
  const d2 = row([[0, 0, 255, 1], [0, 0, 100, 1]]);
  compositeAdvanced({ dst: d2, layer: row([[255, 0, 0, 1], [255, 0, 0, 1]]), blendIf: { b: { under: [0, 0, 200, 200] } } });
  assert.deepEqual(px(d2, 0, 0), [0, 0, 255, 255]);
  assert.deepEqual(px(d2, 1, 0), [255, 0, 0, 255]);
  // channels: only green written
  const d3 = row([[10, 20, 30, 1]]);
  compositeAdvanced({ dst: d3, layer: row([[200, 200, 200, 1]]), channels: { r: false, g: true, b: false } });
  assert.deepEqual(px(d3, 0, 0), [10, 200, 30, 255]);
  // below (exterior effects) is not weighted by Blend If: a black shadow pixel stays while the dark layer pixel goes
  const d4 = row([[255, 255, 255, 1], [255, 255, 255, 1]]);
  const below = row([[0, 0, 0, 1], [0, 0, 0, 0]]);
  compositeAdvanced({ dst: d4, below, layer: row([[0, 0, 0, 0], [10, 10, 10, 1]]), blendIf: { gray: { this: [50, 50, 255, 255] } } });
  assert.deepEqual(px(d4, 0, 0), [0, 0, 0, 255]);
  assert.deepEqual(px(d4, 1, 0), [255, 255, 255, 255]);
});
