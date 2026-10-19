import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as tf from '../../src/shared/pixels/transform.js';
import { createImage, getPixel, setPixel, cloneImage, meanAbsDiff } from '../../src/shared/pixels/core.js';
import { quadrantImage, gradientImage, assertPixel, assertNear } from './helpers.mjs';

const full = (img) => ({ x: 0, y: 0, width: img.width, height: img.height });

test('matrix helpers', () => {
  const m = tf.matrixFrom({ translate: [10, 5], scale: 2, rotate: Math.PI / 2, origin: [1, 1] });
  const inv = tf.invertMatrix(m);
  const id = tf.multiplyMatrix(m, inv);
  for (let i = 0; i < 6; i++) assertNear(id[i], tf.IDENTITY[i], 1e-9);
  const [x, y] = tf.applyMatrix(m, 1, 1);
  assertNear(x, 11);
  assertNear(y, 6);
  assert.throws(() => tf.invertMatrix([0, 0, 0, 0, 1, 1]), /inverted/);
  assert.deepEqual(tf.transformBounds([0, 1, -1, 0, 0, 0], { x: 0, y: 0, width: 10, height: 4 }), { x: -4, y: 0, width: 4, height: 10 });
});

test('identity and integer translation resample exactly', () => {
  const img = quadrantImage(8);
  for (const q of ['nearest', 'bilinear', 'bicubic']) {
    const same = tf.resample(img, tf.IDENTITY, full(img), { quality: q });
    assert.equal(meanAbsDiff(same, img), 0, q);
  }
  const moved = tf.resample(img, [1, 0, 0, 1, 2, 1], full(img), { quality: 'bilinear' });
  assertPixel(getPixel(moved, 3, 2), getPixel(img, 1, 1));
  assertPixel(getPixel(moved, 1, 0), [0, 0, 0, 0]);
});

test('scale 2x nearest doubles pixels; rotate via resample matches rotate90', () => {
  const img = quadrantImage(4);
  const big = tf.resample(img, [2, 0, 0, 2, 0, 0], { x: 0, y: 0, width: 8, height: 8 }, { quality: 'nearest' });
  assertPixel(getPixel(big, 2, 2), getPixel(img, 1, 1));
  assertPixel(getPixel(big, 3, 3), getPixel(img, 1, 1));
  const src = quadrantImage(8);
  // 90° clockwise about the origin then moved back into view: x' = h - y, y' = x
  const rot = tf.resample(src, [0, 1, -1, 0, src.height, 0], full(src), { quality: 'nearest' });
  assert.equal(meanAbsDiff(rot, tf.rotate90(src)), 0);
});

test('exact rotations and flips', () => {
  const img = createImage(3, 2);
  setPixel(img, 0, 0, [255, 0, 0, 1]);
  setPixel(img, 2, 1, [0, 0, 255, 1]);
  const r90 = tf.rotate90(img);
  assert.deepEqual([r90.width, r90.height], [2, 3]);
  assertPixel(getPixel(r90, 1, 0), [255, 0, 0, 1]);
  assertPixel(getPixel(r90, 0, 2), [0, 0, 255, 1]);
  assert.equal(meanAbsDiff(tf.rotate270(tf.rotate90(img)), img), 0);
  assert.equal(meanAbsDiff(tf.rotate90(tf.rotate90(img)), tf.rotate180(img)), 0);
  assertPixel(getPixel(tf.flipH(img), 2, 0), [255, 0, 0, 1]);
  assertPixel(getPixel(tf.flipV(img), 0, 1), [255, 0, 0, 1]);
});

test('resize: area averaging, solid colours stay solid, no dark fringes at transparent borders', () => {
  const checker = createImage(8, 8);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) setPixel(checker, x, y, (x + y) % 2 ? [255, 255, 255, 1] : [0, 0, 0, 1]);
  const grey = tf.resize(checker, 4, 4, { method: 'area' });
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) assertNear(getPixel(grey, x, y)[0], 127.5, 1);
  const solid = createImage(10, 7, [40, 120, 200, 1]);
  for (const method of ['nearest', 'bilinear', 'bicubic', 'lanczos', 'area']) {
    for (const [w, h] of [[23, 15], [4, 3]]) {
      const r = tf.resize(solid, w, h, { method });
      assert.deepEqual([r.width, r.height], [w, h]);
      for (const [x, y] of [[0, 0], [w - 1, h - 1], [Math.floor(w / 2), Math.floor(h / 2)]]) assertPixel(getPixel(r, x, y), [40, 120, 200, 1], 1, `${method} ${w}x${h}`);
    }
  }
  // red square with a transparent border: edge pixels keep red, only alpha falls off
  const sq = createImage(10, 10);
  for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) setPixel(sq, x, y, [255, 0, 0, 1]);
  const up = tf.resize(sq, 20, 20, { method: 'bicubic' });
  const edge = getPixel(up, 3, 10);
  assert.ok(edge[3] > 0 && edge[3] < 1, 'partially transparent edge');
  assertNear(edge[0], 255, 2);
  assert.ok(edge[1] < 3 && edge[2] < 3);
});

test('perspective: identity quad and shrinking', () => {
  const img = gradientImage(16, 16);
  const q = [[0, 0], [16, 0], [16, 16], [0, 16]];
  const same = tf.perspective(img, q, q, full(img));
  assert.ok(meanAbsDiff(same, img) < 0.5);
  const small = tf.perspective(img, q, [[4, 4], [12, 4], [12, 12], [4, 12]], full(img));
  assert.deepEqual(tf.contentBounds(small), { x: 4, y: 4, width: 8, height: 8 });
  const H = tf.homography(q, [[0, 0], [10, 2], [12, 12], [1, 9]]);
  const [x, y] = tf.applyHomography(H, 16, 16);
  assertNear(x, 12, 1e-6);
  assertNear(y, 12, 1e-6);
  const back = tf.applyHomography(tf.invertHomography(H), 12, 12);
  assertNear(back[0], 16, 1e-6);
  assert.throws(() => tf.homography(q, [[0, 0], [1, 1], [2, 2], [3, 3]]), /degenerate/);
});

test('resample performance on a 1024 square image', () => {
  const img = createImage(1024, 1024, [10, 20, 30, 1]);
  const t0 = performance.now();
  tf.resample(img, tf.matrixFrom({ rotate: 0.3, origin: [512, 512] }), full(img), { quality: 'bilinear' });
  tf.resize(img, 700, 700, { method: 'bicubic' });
  assert.ok(performance.now() - t0 < 4000, `took ${performance.now() - t0} ms`);
  void cloneImage;
});
