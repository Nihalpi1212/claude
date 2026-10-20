import test from 'node:test';
import assert from 'node:assert/strict';
import { inpaint } from '../../src/shared/pixels/inpaint.js';

function image(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(fn(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
}
function rectMask(w, h, r) {
  const m = new Uint8Array(w * h);
  for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) m[y * w + x] = 255;
  return m;
}

test('a flat image is filled with its colour', () => {
  const img = image(80, 60, () => [40, 120, 200, 255]);
  const hole = { x: 30, y: 20, width: 20, height: 15 };
  for (let y = hole.y; y < hole.y + hole.height; y++) for (let x = hole.x; x < hole.x + hole.width; x++) img.data.set([255, 0, 0, 255], (y * 80 + x) * 4);
  inpaint(img, rectMask(80, 60, hole));
  for (let i = 0; i < img.data.length; i += 4) assert.deepEqual(Array.from(img.data.slice(i, i + 4)).map((v) => Math.round(v / 2)), [20, 60, 100, 128]);
});

test('stripes continue through the hole and pixels outside it are untouched', () => {
  const stripe = (y) => (Math.floor(y / 4) % 2 ? [230, 230, 230, 255] : [20, 20, 20, 255]);
  const img = image(120, 120, (x, y) => stripe(y));
  const orig = new Uint8ClampedArray(img.data);
  const hole = { x: 45, y: 45, width: 30, height: 30 };
  for (let y = hole.y; y < hole.y + hole.height; y++) for (let x = hole.x; x < hole.x + hole.width; x++) img.data.set([255, 0, 0, 255], (y * 120 + x) * 4);
  const mask = rectMask(120, 120, hole);
  inpaint(img, mask, { seed: 3 });
  let good = 0, total = 0;
  for (let y = hole.y; y < hole.y + hole.height; y++) {
    for (let x = hole.x; x < hole.x + hole.width; x++) {
      const i = (y * 120 + x) * 4;
      // any red left means the hole was not filled
      assert.ok(Math.abs(img.data[i] - img.data[i + 1]) < 40, `pixel ${x},${y} still red-ish`);
      total++;
      if (Math.abs(img.data[i] - stripe(y)[0]) < 60) good++;
    }
  }
  assert.ok(good / total > 0.8, `stripes continue: ${good}/${total}`);
  for (let i = 0; i < mask.length; i++) if (!mask[i]) assert.equal(img.data[i * 4], orig[i * 4]);
});

test('an empty mask changes nothing and a full mask (nothing to copy from) is left alone', () => {
  const img = image(20, 20, (x, y) => [x * 10, y * 10, 0, 255]);
  const copy = new Uint8ClampedArray(img.data);
  inpaint(img, new Uint8Array(400));
  assert.deepEqual(img.data, copy);
  inpaint(img, new Uint8Array(400).fill(255));
  assert.deepEqual(img.data, copy);
});

test('fills a 60px hole in a 400x300 textured image in reasonable time', () => {
  const img = image(400, 300, (x, y) => [(x * 7 + y * 3) % 256, (x * 3) % 256, (y * 5) % 256, 255]);
  const t0 = performance.now();
  inpaint(img, rectMask(400, 300, { x: 170, y: 120, width: 60, height: 60 }));
  const ms = performance.now() - t0;
  assert.ok(ms < 8000, `took ${ms} ms`);
});
