import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as W from '../../src/shared/pixels/warp.js';
import * as tf from '../../src/shared/pixels/transform.js';
import { createImage, getPixel, setPixel, meanAbsDiff, contentBounds, pasteImage } from '../../src/shared/pixels/core.js';
import { quadrantImage, gradientImage, assertPixel, assertNear } from './helpers.mjs';

const full = (img) => ({ x: 0, y: 0, width: img.width, height: img.height });

/** Red rectangle on a transparent canvas. */
function rectImage(w, h, r) {
  const img = createImage(w, h);
  for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) setPixel(img, x, y, [255, 0, 0, 1]);
  return img;
}

test('identity mesh returns the input (1 cell and 4x4 cells, every interpolation)', () => {
  const img = quadrantImage(16);
  for (const cells of [1, 4]) {
    const grid = W.regularGrid(full(img), cells, cells);
    for (const interp of ['nearest', 'bilinear', 'bicubic']) {
      const r = W.meshWarp(img, grid, grid, { interp });
      assert.deepEqual([r.x, r.y, r.image.width, r.image.height], [0, 0, 16, 16], `${cells} ${interp}`);
      assert.equal(meanAbsDiff(r.image, img), 0, `${cells} cells ${interp}`);
    }
  }
  assert.throws(() => W.meshWarp(img, W.regularGrid(full(img), 2, 2), W.regularGrid(full(img), 3, 3)), /differ/);
  assert.throws(() => W.meshWarp(img, { cols: 1, rows: 1, points: [[0, 0]] }, { cols: 1, rows: 1, points: [[0, 0]] }), /expected 4/);
});

test('a translated mesh moves the pixels and reports the moved bounds', () => {
  const img = quadrantImage(16);
  const src = W.regularGrid(full(img), 3, 2);
  const dst = W.mapGrid(src, ([x, y]) => [x + 3, y + 2]);
  const r = W.meshWarp(img, src, dst, { interp: 'bilinear' });
  assert.deepEqual([r.x, r.y, r.image.width, r.image.height], [3, 2, 16, 16]);
  assert.equal(meanAbsDiff(r.image, img), 0);
  // a half-pixel move blends neighbours
  const half = W.meshWarp(img, src, W.mapGrid(src, ([x, y]) => [x + 0.5, y]), { interp: 'bilinear' });
  assert.deepEqual([half.x, half.image.width], [0, 17]);
  const edge = getPixel(half.image, 1, 4); // half red (x = 1), half transparent border (x = 0)
  assertNear(edge[3], 0.5, 0.02);
  assertNear(edge[0], 255, 1);
  // clip limits the output
  const clipped = W.meshWarp(img, src, dst, { clip: { x: 0, y: 0, width: 10, height: 10 } });
  assert.deepEqual([clipped.x, clipped.y, clipped.image.width, clipped.image.height], [3, 2, 7, 8]);
});

test('a scaled mesh resamples like transform.resample', () => {
  const img = gradientImage(16, 16);
  const src = W.regularGrid(full(img), 2, 2);
  const dst = W.mapGrid(src, ([x, y]) => [x * 2, y * 1.5]);
  const r = W.meshWarp(img, src, dst, { interp: 'bilinear' });
  const ref = tf.resample(img, [2, 0, 0, 1.5, 0, 0], { x: 0, y: 0, width: 32, height: 24 }, { quality: 'bilinear' });
  assert.deepEqual([r.image.width, r.image.height], [32, 24]);
  assert.ok(meanAbsDiff(r.image, ref) < 0.5, `diff ${meanAbsDiff(r.image, ref)}`);
});

test('Bézier bulge moves the middle of the top edge more than its ends', () => {
  const img = rectImage(64, 40, { x: 2, y: 10, width: 60, height: 20 });
  const rect = full(img);
  const controls = W.identityControls(rect);
  // lift the two inner control points of the top row
  controls[1][1] -= 12;
  controls[2][1] -= 12;
  assertNear(W.bezierPoint(controls, 0.5, 0)[1], -9, 1e-9); // 3/4 of the control displacement at u = 0.5
  assertNear(W.bezierPoint(controls, 0, 0)[1], 0, 1e-9);
  const r = W.bezierWarp(img, rect, controls, { subdivisions: 16, interp: 'bilinear' });
  assert.equal(r.y, -9);
  const top = (x) => {
    for (let y = 0; y < r.image.height; y++) if (getPixel(r.image, x, y)[3] > 0.5) return y + r.y;
    return null;
  };
  // the rectangle's top sits at v = 0.25 of the patch, where the lift is (0.75)³ · 9 ≈ 3.8 px
  const centre = top(32), left = top(3), right = top(60);
  assert.ok(centre >= 5 && centre <= 7, `centre top ${centre}`);
  assert.ok(left >= 9 && left <= 11, `left top ${left}`);
  assert.ok(right >= 9 && right <= 11, `right top ${right}`);
  assert.ok(centre < left && centre < right);
  // identity controls reproduce the image
  const same = W.bezierWarp(img, rect, W.identityControls(rect), { subdivisions: 8 });
  assert.equal(meanAbsDiff(same.image, img), 0);
  assert.throws(() => W.bezierWarp(img, rect, controls.slice(0, 15)), /16 control points/);
});

test('MLS with one pin translates everything', () => {
  const img = quadrantImage(16);
  const pins = [{ from: [5, 5], to: [8, 7] }];
  for (const kind of ['rigid', 'similarity', 'affine']) {
    const p = W.mlsPoint(pins, [1, 1], { kind });
    assertNear(p[0], 4);
    assertNear(p[1], 3);
    const r = W.mlsWarp(img, pins, { kind, step: 4 });
    assert.deepEqual([r.x, r.y, r.image.width, r.image.height], [3, 2, 16, 16], kind);
    assert.equal(meanAbsDiff(r.image, img), 0, kind);
  }
  assert.deepEqual(W.mlsPoint([], [3, 4]), [3, 4]);
});

test('two pins with a rigid motion: rigid MLS keeps distances and reproduces the rotation', () => {
  // 90° clockwise about (8, 8): (x, y) -> (16 - y, x)
  const rot = ([x, y]) => [16 - y, x];
  const pins = [{ from: [4, 4], to: rot([4, 4]) }, { from: [12, 4], to: rot([12, 4]) }];
  const samples = [[2, 10], [8, 8], [14, 14], [0, 0], [16, 16], [7, 1]];
  const mapped = samples.map((p) => W.mlsPoint(pins, p, { kind: 'rigid' }));
  for (let i = 0; i < samples.length; i++) {
    const e = rot(samples[i]);
    assertNear(mapped[i][0], e[0], 1e-6, `x of ${samples[i]}`);
    assertNear(mapped[i][1], e[1], 1e-6, `y of ${samples[i]}`);
    for (let j = 0; j < i; j++) {
      const d0 = Math.hypot(samples[i][0] - samples[j][0], samples[i][1] - samples[j][1]);
      const d1 = Math.hypot(mapped[i][0] - mapped[j][0], mapped[i][1] - mapped[j][1]);
      assertNear(d1, d0, 1e-6, 'distance');
    }
  }
  // similarity reproduces it too; the warped image equals an exact 90° rotation
  const sim = W.mlsPoint(pins, [2, 10], { kind: 'similarity' });
  assertNear(sim[0], 6, 1e-6);
  assertNear(sim[1], 2, 1e-6);
  const img = quadrantImage(16);
  const r = W.mlsWarp(img, pins, { kind: 'rigid', step: 2 });
  assert.deepEqual([r.x, r.y, r.image.width, r.image.height], [0, 0, 16, 16]);
  assert.ok(meanAbsDiff(r.image, tf.rotate90(img)) < 0.5, `diff ${meanAbsDiff(r.image, tf.rotate90(img))}`);
  // stretching two pins apart (rigid) leaves the fixed pin's neighbourhood in place and moves the other side
  const stretch = [{ from: [20, 50], to: [20, 50] }, { from: [180, 50], to: [280, 50] }];
  const nearA = W.mlsPoint(stretch, [22, 50], { kind: 'rigid' });
  assertNear(nearA[0], 22, 0.5);
  assertNear(nearA[1], 50, 1e-6);
  const nearB = W.mlsPoint(stretch, [178, 50], { kind: 'rigid' });
  assertNear(nearB[0], 278, 0.5);
  // affine with 3 pins is exact for an affine map
  const aff = ([x, y]) => [2 * x + 0.5 * y + 3, 1.5 * y - 0.25 * x + 1];
  const apins = [[2, 3], [10, 4], [5, 12]].map((p) => ({ from: p, to: aff(p) }));
  const a = W.mlsPoint(apins, [7, 7], { kind: 'affine' });
  const ea = aff([7, 7]);
  assertNear(a[0], ea[0], 1e-6);
  assertNear(a[1], ea[1], 1e-6);
});

test('perspective mesh matches the homography of pixels/transform.js', () => {
  const img = gradientImage(64, 64);
  const srcQuad = [[0, 0], [64, 0], [64, 64], [0, 64]];
  const dstQuad = [[10, 4], [58, 0], [62, 60], [2, 56]];
  const mesh = W.perspectiveMesh([{ src: srcQuad, dst: dstQuad }], { subdivisions: 16 });
  assert.equal(mesh.src.length, 1);
  assert.equal(mesh.dst[0].points.length, 17 * 17);
  // grid points are exact pre-images under the homography
  const H = tf.homography(srcQuad, dstQuad);
  for (let i = 0; i < mesh.src[0].points.length; i += 23) {
    const s = mesh.src[0].points[i], d = mesh.dst[0].points[i];
    const m = tf.applyHomography(H, s[0], s[1]);
    assertNear(m[0], d[0], 1e-6);
    assertNear(m[1], d[1], 1e-6);
  }
  const r = W.meshWarp(img, mesh.src, mesh.dst, { interp: 'bilinear' });
  const ref = tf.perspective(img, srcQuad, dstQuad, full(img), { quality: 'bilinear' });
  // the output is bounded by the destination quad (x 2..62, y 0..60)
  assert.deepEqual([r.x, r.y, r.image.width, r.image.height], [2, 0, 60, 60]);
  const placed = pasteImage(createImage(64, 64), r.image, r.x, r.y);
  // the homography reference feathers the quad outline (bilinear at the source border) while the mesh
  // has hard edges, so compare where both are fully opaque
  let sum = 0, n = 0;
  for (let i = 0; i < placed.data.length; i += 4) {
    if (placed.data[i + 3] !== 255 || ref.data[i + 3] !== 255) continue;
    for (let k = 0; k < 3; k++) sum += Math.abs(placed.data[i + k] - ref.data[i + k]);
    n += 3;
  }
  assert.ok(n > 2500 * 3, `interior pixels ${n / 3}`);
  assert.ok(sum / n < 1, `mean interior diff ${sum / n}`);
  assertPixel(getPixel(placed, 32, 32), getPixel(ref, 32, 32), 3);
  assertPixel(getPixel(placed, 12, 6), getPixel(ref, 12, 6), 3);
  const cb = contentBounds(placed), rb = contentBounds(ref);
  assert.ok(Math.abs(cb.x - rb.x) <= 1 && Math.abs(cb.y - rb.y) <= 1 && Math.abs(cb.width - rb.width) <= 1 && Math.abs(cb.height - rb.height) <= 1, `bounds ${JSON.stringify(cb)} vs ${JSON.stringify(rb)}`);
  // two quads sharing an edge produce no crack along it
  const two = W.perspectiveWarp(rectImage(64, 64, { x: 0, y: 0, width: 64, height: 64 }), [
    { src: [[0, 0], [32, 0], [32, 64], [0, 64]], dst: [[0, 0], [32, 0], [32, 64], [0, 64]] },
    { src: [[32, 0], [64, 0], [64, 64], [32, 64]], dst: [[32, 0], [60, 8], [60, 56], [32, 64]] },
  ], { subdivisions: 8 });
  for (let y = 1; y < 63; y++) assert.equal(getPixel(two.image, 32 - two.x, y - two.y)[3], 1, `seam at y=${y}`);
  assert.equal(getPixel(two.image, 1, 1)[3], 1);
  assert.equal(getPixel(two.image, 62, 2)[3], 0);
});

test('a 2000x2000 layer warps quickly enough (bicubic Bézier, MLS, perspective)', () => {
  const img = createImage(2000, 2000, [10, 20, 30, 1]);
  const rect = full(img);
  const controls = W.identityControls(rect);
  controls[5][0] += 150;
  controls[10][1] -= 200;
  let t0 = performance.now();
  const b = W.bezierWarp(img, rect, controls, { subdivisions: 32, interp: 'bicubic' });
  const tb = performance.now() - t0;
  assert.ok(b.image.width >= 2000 && b.image.height >= 2000);
  t0 = performance.now();
  const m = W.mlsWarp(img, [{ from: [500, 500], to: [520, 540] }, { from: [1500, 1500], to: [1500, 1500] }, { from: [1500, 500], to: [1450, 520] }], { kind: 'rigid', step: 4, interp: 'bilinear' });
  const tm = performance.now() - t0;
  assert.ok(m.image.width >= 1900);
  t0 = performance.now();
  const p = W.perspectiveWarp(img, [{ src: [[0, 0], [2000, 0], [2000, 2000], [0, 2000]], dst: [[100, 0], [1900, 100], [2000, 2000], [0, 1900]] }], { interp: 'bilinear' });
  const tp = performance.now() - t0;
  assert.ok(p.image.width >= 1900);
  assert.ok(tb < 8000 && tm < 8000 && tp < 8000, `bezier ${tb | 0} ms, mls ${tm | 0} ms, perspective ${tp | 0} ms`);
});
