// Clipping masks in float (pixels/deep.js): opaqueDeep, cutToAlpha, cutToMask, adjustLayerDeep and clipGroupDeep,
// the 16/32-bit counterparts of lib/compositor.js clipGroup (Blend Clipped Layers as Group) and finishAdvanced
// (clipped layers cut to the base's shape) that lib/depth.js flattenDeep composites clipping masks with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDeep, cloneDeep, blendDeep, statistics, applyAdjustmentDeep, opaqueDeep, cutToAlpha, cutToMask, adjustLayerDeep, clipGroupDeep,
} from '../../src/shared/pixels/deep.js';

function rng(seed = 1) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff) / 0x80000000;
}

/** Planes from a function of (x, y) giving straight RGBA in 0..1 (u16 rounds, f32 keeps). */
function planes(type, w, h, fn) {
  const p = createDeep(w, h, type);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = fn(x, y);
    for (let c = 0; c < 4; c++) p.data[(y * w + x) * 4 + c] = type === 'u16' ? Math.round(Math.min(1, Math.max(0, v[c])) * 65535) : v[c];
  }
  return p;
}
const unit = (p, i) => (p.type === 'u16' ? p.data[i] / 65535 : p.data[i]);

test('opaqueDeep makes every pixel with any alpha opaque and keeps the colour; cutToAlpha and cutToMask multiply alpha only', () => {
  for (const type of ['u16', 'f32']) {
    const full = type === 'u16' ? 65535 : 1;
    const base = planes(type, 3, 1, (x) => [0.2, 0.4, 0.6, [0, 1 / 65535, 0.5][x]]);
    const op = opaqueDeep(base);
    assert.notEqual(op.data, base.data, 'a copy');
    assert.equal(op.data[3], 0, 'transparent stays transparent');
    assert.equal(op.data[7], full);
    assert.equal(op.data[11], full);
    assert.deepEqual(Array.from(op.data.subarray(4, 7)), Array.from(base.data.subarray(4, 7)));
    // cut back to the base: the alpha is the base's again, colour as it is
    cutToAlpha(op, base);
    assert.deepEqual(Array.from(op.data), Array.from(base.data));
  }
  // an offset shape: outside it everything goes
  const d = planes('u16', 4, 1, () => [1, 0.5, 0.25, 1]);
  const shape = planes('u16', 2, 1, (x) => [0, 0, 0, x ? 0.5 : 1]);
  cutToAlpha(d, shape, { x: 1, y: 0 });
  assert.deepEqual([d.data[3], d.data[7], d.data[11], d.data[15]], [0, 65535, 32768, 0]);
  assert.deepEqual(Array.from(d.data.subarray(8, 11)), [65535, 32768, 16384], 'colour stays (straight alpha)');
  // float alpha above 1 counts as 1
  const f = planes('f32', 1, 1, () => [0.5, 0.5, 0.5, 0.8]);
  cutToAlpha(f, planes('f32', 1, 1, () => [0, 0, 0, 3]));
  assert.ok(Math.abs(f.data[3] - 0.8) < 1e-6);
  // a mask placed on the planes (the alpha channel of an RGBA image, like flattenDeep's masks)
  const m = planes('u16', 2, 1, () => [1, 1, 1, 1]);
  cutToMask(m, { width: 2, height: 1, x: 0, y: 0, channels: 4, offset: 3, data: new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 51]) });
  assert.deepEqual([m.data[3], m.data[7]], [65535, 13107]);
});

/**
 * The model of compositor.js clipGroup in exact float: each clipped layer composites over the base's colour as if
 * the base were opaque (W3C "over" with the blend mode, the backdrop fully covered), and the result takes the
 * base's alpha.
 */
function referenceGroup(base, items) {
  const w = base.width, h = base.height;
  const out = new Float64Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    let col = [unit(base, i), unit(base, i + 1), unit(base, i + 2)];
    for (const it of items) {
      const sx = x - it.x, sy = y - it.y;
      if (sx < 0 || sy < 0 || sx >= it.src.width || sy >= it.src.height) continue;
      const j = (sy * it.src.width + sx) * 4;
      const m = it.mask ? it.mask.data[(y - it.mask.y) * it.mask.width + (x - it.mask.x)] / 255 : 1;
      const as = Math.min(1, unit(it.src, j + 3) * it.alpha * m);
      col = col.map((cb, c) => {
        const cs = unit(it.src, j + c);
        const mixed = it.mode === 'multiply' ? cs * cb : it.mode === 'screen' ? cs + cb - cs * cb : cs;
        return as * mixed + (1 - as) * cb;
      });
    }
    out.set([...col, unit(base, i + 3)], i);
  }
  return out;
}

test('clipGroupDeep composites the clipped layers on the base as Blend Clipped Layers as Group does, to within one 16-bit step', () => {
  const rnd = rng(7);
  const w = 12, h = 9;
  for (const type of ['u16', 'f32']) {
    // a base with a soft edge and translucent pixels, clipped layers in the three float modes, offsets and a mask
    const base = planes(type, w, h, (x, y) => [rnd(), rnd(), rnd(), x === 0 ? 0 : x === 1 ? 0.02 : rnd()]);
    const mask = { width: w + 2, height: h + 2, x: -1, y: -1, channels: 1, offset: 0, data: new Uint8ClampedArray((w + 2) * (h + 2)).map(() => (rnd() * 256) | 0) };
    const items = [
      { src: planes(type, 8, 6, () => [rnd(), rnd(), rnd(), rnd()]), x: 3, y: 2, alpha: 0.7, mode: 'normal' },
      { src: planes(type, w, h, () => [rnd(), rnd(), rnd(), 1]), x: 0, y: 0, alpha: 0.5, mode: 'multiply', mask },
      { src: planes(type, 20, 20, () => [rnd(), rnd(), rnd(), rnd()]), x: -4, y: -5, alpha: 1, mode: 'screen' },
    ];
    const keep = cloneDeep(base);
    const got = clipGroupDeep(base, items);
    assert.deepEqual(Array.from(base.data), Array.from(keep.data), 'the base is left as it is');
    assert.equal(got.width, w);
    const ref = referenceGroup(base, items);
    const tol = type === 'u16' ? 3 / 65535 : 1e-5; // one rounding per clipped layer at 16 bits
    for (let i = 0; i < ref.length; i++) {
      if (i % 4 !== 3 && ref[i - (i % 4) + 3] === 0) continue; // colour under no coverage
      assert.ok(Math.abs(unit(got, i) - ref[i]) <= tol, `${type} sample ${i}: ${unit(got, i)} vs ${ref[i]}`);
    }
    // the clipped layers never reach past the base: transparent stays transparent
    for (let y = 0; y < h; y++) assert.equal(got.data[(y * w) * 4 + 3], 0);
  }
});

test('a clipping group keeps the 16-bit precision of its layers (no 8-bit step in between)', () => {
  // a 4096-step 16-bit ramp as the base, a clipped Multiply layer at 50 %: far more than 256 levels come out
  const w = 4096;
  const base = planes('u16', w, 1, (x) => [x / (w - 1), 0.5, 1 - x / (w - 1), 1]);
  const clip = planes('u16', w, 1, () => [0.8, 0.8, 0.8, 1]);
  const out = clipGroupDeep(base, [{ src: clip, alpha: 0.5, mode: 'multiply' }]);
  assert.ok(statistics(out).channels[0].distinct > 3000, `${statistics(out).channels[0].distinct} levels`);
  // and drawn onto a backdrop with the base's opacity it still has them
  const acc = planes('u16', w, 1, () => [0, 0, 0, 1]);
  blendDeep(acc, out, { alpha: 0.75 });
  assert.ok(statistics(acc).channels[0].distinct > 2500);
  // a clipped layer at 0 % (or fully transparent) leaves the base exactly as it was
  const same = clipGroupDeep(base, [{ src: clip, alpha: 0 }]);
  assert.deepEqual(Array.from(same.data), Array.from(base.data));
  // float: values above white survive the group
  const hdr = planes('f32', 2, 1, () => [3, 0.5, 0.25, 1]);
  const g = clipGroupDeep(hdr, [{ src: planes('f32', 2, 1, () => [0.5, 0.5, 0.5, 1]), alpha: 1, mode: 'multiply' }]);
  assert.ok(Math.abs(g.data[0] - 1.5) < 1e-6);
});

test('adjustLayerDeep: opacity, mask and the base shape limit an adjustment layer; clipped adjustments act on the group only', () => {
  const w = 4, h = 1;
  const grey = () => planes('u16', w, h, () => [0.25, 0.25, 0.25, 1]);
  // without anything partial: the plain adjustment
  const all = adjustLayerDeep(grey(), 'invert');
  const plain = grey();
  applyAdjustmentDeep(plain, 'invert');
  assert.deepEqual(Array.from(all.data), Array.from(plain.data));
  assert.equal(all.data[0], 65535 - Math.round(0.25 * 65535));
  // a shape (the base of a clipping mask that does not blend its layers as a group) at an offset, a mask, opacity
  const shape = planes('u16', 2, 1, (x) => [0, 0, 0, x ? 0.5 : 1]);
  const mask = { width: w, height: h, x: 0, y: 0, channels: 1, offset: 0, data: new Uint8ClampedArray([255, 255, 255, 0]) };
  const d = adjustLayerDeep(grey(), 'invert', {}, { opacity: 0.5, mask, shape: { planes: shape, x: 1, y: 0 } });
  const lo = Math.round(0.25 * 65535), hi = 65535 - lo;
  assert.equal(d.data[0], lo, 'outside the shape nothing changes');
  assert.ok(Math.abs(d.data[4] - (lo + (hi - lo) * 0.5)) <= 1, 'opacity 50 %');
  assert.ok(Math.abs(d.data[8] - (lo + (hi - lo) * 0.25)) <= 1, 'opacity 50 % x half-covered shape');
  assert.equal(d.data[12], lo, 'outside the shape (and the mask)');
  // inside a group: the clipped adjustment changes the base's colour, the alpha stays the base's
  const base = planes('u16', 2, 1, (x) => [0.25, 0.25, 0.25, x ? 0.4 : 0]);
  const g = clipGroupDeep(base, [{ adjust: 'invert', opacity: 1 }]);
  assert.equal(g.data[4], hi);
  assert.equal(g.data[7], Math.round(0.4 * 65535));
  assert.equal(g.data[3], 0);
});
