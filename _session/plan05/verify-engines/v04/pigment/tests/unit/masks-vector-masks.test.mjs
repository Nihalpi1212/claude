// masks-vector-masks (Pigment 0.4, package 12): the pure mask maths of src/shared/pixels/mask-math.js (density,
// feather, the intersection of the two parts, what a vector mask hides).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDensity, featherAlpha, refineMask, intersectAlpha, maskDensity, maskFeather, isPlainMask, vectorMaskHides, rasterMaskHides, initialCoverage, MAX_FEATHER } from '../../src/shared/pixels/mask-math.js';

test('density: what the mask hides is hidden only by the density', () => {
  const a = new Uint8ClampedArray([0, 64, 128, 255]);
  applyDensity(a, 0.5);
  // m' = 255 - d (255 - m)
  assert.deepEqual([...a], [128, 160, 192, 255]);
  const z = applyDensity(new Uint8ClampedArray([0, 100, 255]), 0);
  assert.deepEqual([...z], [255, 255, 255]);
  const same = new Uint8ClampedArray([0, 7, 255]);
  assert.equal(applyDensity(same, 1), same);
  assert.deepEqual([...same], [0, 7, 255]);
});

test('density and feather read from a mask object, clamped, with the defaults', () => {
  assert.equal(maskDensity({}), 1);
  assert.equal(maskDensity({ density: 0.25 }), 0.25);
  assert.equal(maskDensity({ density: 3 }), 1);
  assert.equal(maskDensity({ density: -1 }), 0);
  assert.equal(maskDensity({ density: 'x' }), 1);
  assert.equal(maskFeather({}), 0);
  assert.equal(maskFeather({ feather: 12.5 }), 12.5);
  assert.equal(maskFeather({ feather: 1e9 }), MAX_FEATHER);
  assert.equal(isPlainMask({ density: 1, feather: 0 }), true);
  assert.equal(isPlainMask({}), true);
  assert.equal(isPlainMask({ density: 0.99 }), false);
  assert.equal(isPlainMask({ feather: 0.5 }), false);
});

test('feather blurs a hard edge symmetrically and keeps the totals; a uniform mask stays as it is', () => {
  const w = 64, h = 8;
  const a = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) for (let x = 32; x < w; x++) a[y * w + x] = 255;
  featherAlpha(a, w, h, 8); // sigma 4
  const row = [...a.slice(3 * w, 4 * w)];
  // far from the edge: unchanged
  assert.equal(row[0], 0);
  assert.equal(row[63], 255);
  // around the edge: a ramp through the middle, monotonic
  assert.ok(row[31] > 80 && row[31] < 128, `left of the edge ${row[31]}`);
  assert.ok(row[32] > 128 && row[32] < 175, `right of the edge ${row[32]}`);
  assert.ok(Math.abs(row[31] + row[32] - 255) <= 2);
  for (let x = 1; x < w; x++) assert.ok(row[x] >= row[x - 1], `monotonic at ${x}`);
  assert.ok(row[24] > 0 && row[24] < 20, `the ramp reaches about 2 sigma: ${row[24]}`);
  // the document edge does not darken a mask that shows everything
  const full = new Uint8ClampedArray(w * h).fill(255);
  featherAlpha(full, w, h, 30);
  assert.ok(full.every((v) => v === 255));
  // no feather: untouched
  const b = new Uint8ClampedArray([0, 255, 0, 255]);
  featherAlpha(b, 2, 2, 0);
  assert.deepEqual([...b], [0, 255, 0, 255]);
});

test('a one-pixel feather softens a single pixel (small sigmas use the kernel itself)', () => {
  const w = 9, h = 9;
  const a = new Uint8ClampedArray(w * h);
  a[4 * w + 4] = 255;
  featherAlpha(a, w, h, 2); // sigma 1
  assert.ok(a[4 * w + 4] < 255 && a[4 * w + 4] > 20);
  assert.ok(a[4 * w + 5] > 0 && a[4 * w + 5] < a[4 * w + 4]);
  assert.equal(a[4 * w + 5], a[4 * w + 3]);
  assert.equal(a[3 * w + 4], a[5 * w + 4]);
});

test('refineMask feathers, then applies density', () => {
  const w = 32, h = 1;
  const a = new Uint8ClampedArray(w);
  for (let x = 16; x < w; x++) a[x] = 255;
  refineMask(a, w, h, { density: 0.5, feather: 4 });
  assert.ok(a[0] >= 127 && a[0] <= 128, `hidden side at half density: ${a[0]}`);
  assert.equal(a[31], 255);
  assert.ok(a[15] > 128 && a[16] < 255);
});

test('the two parts intersect: the layer shows where both show', () => {
  const r = new Uint8ClampedArray([255, 255, 128, 0]);
  const v = new Uint8ClampedArray([255, 128, 128, 255]);
  assert.deepEqual([...intersectAlpha(r, v)], [255, 128, 64, 0]);
});

test('what hides: a raster mask enabled with density, a vector mask by its initial fill and operations', () => {
  const canvas = {};
  assert.equal(rasterMaskHides({ canvas, enabled: true }), true);
  assert.equal(rasterMaskHides({ canvas, enabled: false }), false);
  assert.equal(rasterMaskHides({ canvas, enabled: true, density: 0 }), false);
  assert.equal(rasterMaskHides(null), false);
  const sq = { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], closed: true };
  // Hide All (an empty path that starts hidden) hides everything; Reveal All hides nothing
  assert.equal(vectorMaskHides({ path: { subpaths: [] }, initialFill: 'hide' }), true);
  assert.equal(vectorMaskHides({ path: { subpaths: [] }, initialFill: 'reveal' }), false);
  // on a revealed start only subtract / intersect / exclude components hide anything
  assert.equal(vectorMaskHides({ path: { subpaths: [sq] }, initialFill: 'reveal' }), false);
  assert.equal(vectorMaskHides({ path: { subpaths: [{ ...sq, op: 'subtract' }] }, initialFill: 'reveal' }), true);
  assert.equal(vectorMaskHides({ path: { subpaths: [sq] }, initialFill: 'hide', enabled: false }), false);
  assert.equal(vectorMaskHides({ path: { subpaths: [sq] }, initialFill: 'hide', density: 0 }), false);
  assert.equal(vectorMaskHides(null), false);
  assert.equal(initialCoverage({ initialFill: 'reveal' }), 255);
  assert.equal(initialCoverage({ initialFill: 'hide' }), 0);
  assert.equal(initialCoverage({}), 0);
});

test('a 2000 x 1500 feather of 50 px runs well under a second', () => {
  const w = 2000, h = 1500;
  const a = new Uint8ClampedArray(w * h);
  for (let y = 300; y < 1200; y++) a.fill(255, y * w + 400, y * w + 1600);
  const t0 = performance.now();
  refineMask(a, w, h, { feather: 50, density: 0.8 });
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `${ms.toFixed(0)} ms`);
});

test('a painted change refines only the region it reaches, with the same values as the whole plane', async () => {
  const { diffBounds, refineRegion, featherReach } = await import('../../src/shared/pixels/mask-math.js');
  const w = 300, h = 200;
  const raw = new Uint8ClampedArray(w * h);
  for (let y = 40; y < 160; y++) raw.fill(255, y * w + 60, y * w + 240);
  const m = { feather: 12, density: 0.7 };
  const before = refineMask(raw.slice(), w, h, m);
  // paint a dab of white near the left edge of the document
  const painted = raw.slice();
  for (let y = 90; y < 100; y++) painted.fill(255, y * w + 2, y * w + 14);
  const box = diffBounds(raw, painted, w, h);
  assert.deepEqual(box, { x: 2, y: 90, width: 12, height: 10 });
  assert.equal(diffBounds(raw, raw.slice(), w, h), null);
  const full = refineMask(painted.slice(), w, h, m);
  const { rect, alpha } = refineRegion(painted, w, h, m, box);
  const reach = featherReach(12);
  assert.deepEqual(rect, { x: 0, y: 90 - reach, width: 14 + reach, height: 10 + reach * 2 });
  // the incremental update: the old refined plane with the region replaced equals the whole refine (within 1)
  const merged = before.slice();
  for (let y = 0; y < rect.height; y++) merged.set(alpha.subarray(y * rect.width, (y + 1) * rect.width), (rect.y + y) * w + rect.x);
  let worst = 0;
  for (let i = 0; i < full.length; i++) worst = Math.max(worst, Math.abs(full[i] - merged[i]));
  assert.ok(worst <= 1, `largest difference ${worst}`);
  // density only: the region is the box itself
  assert.deepEqual(refineRegion(painted, w, h, { density: 0.5 }, box).rect, box);
});
