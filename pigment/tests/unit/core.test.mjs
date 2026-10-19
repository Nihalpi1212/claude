import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../../src/shared/pixels/core.js';
import * as color from '../../src/shared/pixels/color.js';
import { gradientImage, quadrantImage, assertPixel, assertNear } from './helpers.mjs';

test('rect helpers', () => {
  assert.deepEqual(core.intersectRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }), { x: 5, y: 5, width: 5, height: 5 });
  assert.ok(core.isEmptyRect(core.intersectRect({ x: 0, y: 0, width: 5, height: 5 }, { x: 5, y: 0, width: 5, height: 5 })));
  assert.deepEqual(core.unionRect({ x: 0, y: 0, width: 2, height: 2 }, { x: 5, y: 5, width: 1, height: 1 }), { x: 0, y: 0, width: 6, height: 6 });
  assert.deepEqual(core.clampRect({ x: -3.5, y: 2.2, width: 4, height: 100 }, 10, 10), { x: 0, y: 2, width: 1, height: 8 });
  assert.deepEqual(core.clampRect(null, 3, 4), { x: 0, y: 0, width: 3, height: 4 });
});

test('image creation, crop, paste, pixels and LUTs', () => {
  const img = core.createImage(4, 3, [10, 20, 30, 0.5]);
  assertPixel(core.getPixel(img, 3, 2), [10, 20, 30, 0.5]);
  assertPixel(core.getPixel(img, 4, 2), [0, 0, 0, 0]);
  core.setPixel(img, 1, 1, [255, 0, 0, 1]);
  const crop = core.cropImage(img, { x: 1, y: 1, width: 2, height: 2 });
  assert.equal(crop.width, 2);
  assertPixel(core.getPixel(crop, 0, 0), [255, 0, 0, 1]);
  const dst = core.createImage(5, 5);
  core.pasteImage(dst, crop, 4, 4);
  assertPixel(core.getPixel(dst, 4, 4), [255, 0, 0, 1]);
  assertPixel(core.getPixel(dst, 3, 3), [0, 0, 0, 0]);
  const g = gradientImage(8, 1);
  core.applyLut(g, core.makeLut((v) => 255 - v));
  assertPixel(core.getPixel(g, 0, 0), [255, 255, 255, 1]);
  assertPixel(core.getPixel(g, 7, 0), [0, 0, 0, 1]);
  let n = 0;
  core.forEachPixel(g, { x: 2, y: 0, width: 3, height: 1 }, () => n++);
  assert.equal(n, 3);
  assert.deepEqual(core.contentBounds(quadrantImage(8)), { x: 1, y: 1, width: 6, height: 6 });
  assert.equal(core.contentBounds(core.createImage(3, 3)), null);
});

test('bilinear sampling and premultiplication', () => {
  const g = gradientImage(3, 1); // 0, 128, 255
  const mid = core.sampleBilinear(g, 0.5, 0);
  assertNear(mid[0], 64, 1);
  const edge = core.sampleBilinear(g, -0.5, 0);
  assertNear(edge[3], 127.5, 1);
  const img = core.createImage(1, 1, [200, 100, 50, 0.5]);
  const f = core.premultiply(img);
  assertNear(f[0], (200 / 255) * (128 / 255), 1e-6); // alpha 0.5 is stored as 128
  core.unpremultiply(f, img);
  assertPixel(core.getPixel(img, 0, 0), [200, 100, 50, 0.5]);
  const rnd = core.randomSeeded(42);
  const a = rnd(), b = core.randomSeeded(42)();
  assert.equal(a, b);
  assert.ok(a >= 0 && a < 1);
});

test('colour conversions round-trip', () => {
  for (const [r, g, b] of [[255, 0, 0], [0, 128, 255], [120, 200, 40], [17, 17, 17], [255, 255, 255], [0, 0, 0]]) {
    const hsl = color.rgbToHsl(r, g, b);
    assertPixel([...color.hslToRgb(...hsl), 1], [r, g, b, 1], 1, 'hsl');
    const hsv = color.rgbToHsv(r, g, b);
    assertPixel([...color.hsvToRgb(...hsv), 1], [r, g, b, 1], 1, 'hsv');
    const lab = color.rgbToLab(r, g, b);
    assertPixel([...color.labToRgb(...lab), 1], [r, g, b, 1], 1, 'lab');
  }
  assertNear(color.rgbToHsl(0, 0, 255)[0], 240);
  assertNear(color.rgbToLab(255, 255, 255)[0], 100, 0.01);
  assert.deepEqual(color.parseColor('#f0a'), [255, 0, 170, 1]);
  assertPixel(color.parseColor('#ff00aa80'), [255, 0, 170, 128 / 255], 0.01);
  assert.deepEqual(color.parseColor('rgb(1, 2, 3)'), [1, 2, 3, 1]);
  assert.deepEqual(color.parseColor('rgba(1 2 3 / 50%)'), [1, 2, 3, 0.5]);
  assert.equal(color.rgbaToHex([255, 0, 170, 0.5], true), '#ff00aa80');
  assert.equal(color.rgbaToHex([255, 0, 170, 0.5]), '#ff00aa');
  assert.equal(color.contrastColor('#ffff00'), '#000000');
  assert.equal(color.colorDistance(10, 20, 30, 15, 2, 30), 18);
});
