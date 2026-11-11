// 16 and 32 bits per channel: deep planes (deep.js), TIFF (tiff.js) and TGA (tga.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  fromCanvasData, toCanvasData, convertDepth, createDeep, cloneDeep, extractRect, writeRect, mixRect, hasPrecision, syncFromProxy,
  applyLutDeep, applyAdjustmentDeep, applyVia8Bit, curveFn, blendDeep, resampleDeep, carryOver, statistics, EXACT_KINDS, isExactKind, q8u16, q8f32, toPs16,
} from '../../src/shared/pixels/deep.js';
import { applyAdjustment, levelsLut, curveLut, ADJUSTMENTS } from '../../src/shared/pixels/adjust.js';
import { encodePng, decodePng, toRgba16, pngInfo } from '../../src/shared/pixels/png.js';
import { encodeTiff, decodeTiff, toRgba, isTiff, tiffInfo, lzwEncode, lzwDecode, packBitsRow, unpackBits } from '../../src/shared/pixels/tiff.js';
import { encodeTga, decodeTga, isTga, tgaInfo } from '../../src/shared/pixels/tga.js';

const nodeCodecs = { deflate: async (b) => new Uint8Array(deflateSync(b)), inflate: async (b) => new Uint8Array(inflateSync(b)) };
const b64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

/** Deterministic pseudo-random numbers in [0, 1). */
function rng(seed = 1) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff) / 0x80000000;
}

function randomImage(w, h, seed = 3) {
  const rnd = rng(seed);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = rnd() * 256;
    data[i * 4 + 1] = rnd() * 256;
    data[i * 4 + 2] = rnd() * 256;
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

/** Every 16-bit grey value once: a 65536 x 1 opaque ramp. */
function ramp16() {
  const deep = createDeep(65536, 1, 'u16');
  for (let v = 0; v < 65536; v++) {
    deep.data[v * 4] = deep.data[v * 4 + 1] = deep.data[v * 4 + 2] = v;
    deep.data[v * 4 + 3] = 65535;
  }
  return deep;
}

/** Largest step between neighbours and the number of distinct values of channel c of a one-row ramp. */
function rampShape(deep, c = 0) {
  let maxStep = 0, decreasing = 0;
  const seen = new Set();
  for (let i = 0; i < deep.width; i++) {
    const v = deep.data[i * 4 + c];
    seen.add(v);
    if (i) {
      const step = v - deep.data[(i - 1) * 4 + c];
      if (Math.abs(step) > maxStep) maxStep = Math.abs(step);
      if (step < 0) decreasing++;
    }
  }
  return { maxStep, distinct: seen.size, decreasing };
}

// ---- planes ----------------------------------------------------------------------------------

test('8-bit pixels go to 16 and 32 bits and back unchanged; rounding is to nearest', () => {
  const img = randomImage(31, 17);
  img.data[3] = 0;
  img.data[7] = 128;
  for (const type of ['u16', 'f32']) {
    const deep = fromCanvasData(img, type);
    assert.equal(deep.type, type);
    assert.equal(deep.data.length, img.data.length);
    assert.deepEqual(Array.from(toCanvasData(deep).data), Array.from(img.data));
  }
  assert.equal(fromCanvasData({ width: 1, height: 1, data: new Uint8ClampedArray([255, 0, 1, 255]) }, 'u16').data[0], 65535);
  assert.equal(fromCanvasData({ width: 1, height: 1, data: new Uint8ClampedArray([255, 0, 1, 255]) }, 'u16').data[2], 257);
  assert.deepEqual([q8u16(0), q8u16(128), q8u16(129), q8u16(65535), q8u16(65407), q8u16(65406)], [0, 0, 1, 255, 255, 254]);
  assert.deepEqual([q8f32(-1), q8f32(0.5), q8f32(1), q8f32(7.5), q8f32(NaN)], [0, 128, 255, 255, 0]);
  assert.deepEqual([toPs16(0), toPs16(65535), toPs16(32768)], [0, 32768, 16384]);
});

test('convertDepth: u16 -> f32 -> u16 is exact, f32 above white clamps on the way down', () => {
  const deep = ramp16();
  const f = convertDepth(deep, 'f32');
  assert.equal(f.type, 'f32');
  assert.ok(Math.abs(f.data[32768 * 4] - 32768 / 65535) < 1e-7);
  const back = convertDepth(f, 'u16');
  for (let v = 0; v < 65536; v += 1) assert.equal(back.data[v * 4], v);
  const hdr = { type: 'f32', width: 1, height: 1, data: new Float32Array([2.5, -0.3, 0.5, 1]) };
  assert.deepEqual(Array.from(convertDepth(hdr, 'u16').data), [65535, 0, 32768, 65535]);
  assert.deepEqual(Array.from(toCanvasData(hdr).data), [255, 0, 128, 255]);
  assert.throws(() => convertDepth(deep, 'u8'), RangeError);
});

test('dithered 16 -> 8 keeps the mean of in-between values and never touches exact ones or alpha', () => {
  const w = 200, h = 100;
  const deep = createDeep(w, h, 'u16');
  for (let i = 0; i < w * h; i++) {
    deep.data[i * 4] = Math.round(100.25 * 257); // a quarter of the way from 100 to 101
    deep.data[i * 4 + 1] = 77 * 257; // exactly 77
    deep.data[i * 4 + 2] = Math.round(10.5 * 257);
    deep.data[i * 4 + 3] = Math.round(200.5 * 257);
  }
  const plain = toCanvasData(deep);
  assert.equal(plain.data[0], 100);
  const out = toCanvasData(deep, { dither: true });
  let sumR = 0, sumB = 0;
  for (let i = 0; i < w * h; i++) {
    const r = out.data[i * 4], b = out.data[i * 4 + 2];
    assert.ok(r === 100 || r === 101, `red ${r}`);
    assert.ok(b === 10 || b === 11, `blue ${b}`);
    assert.equal(out.data[i * 4 + 1], 77);
    assert.equal(out.data[i * 4 + 3], plain.data[i * 4 + 3]);
    sumR += r;
    sumB += b;
  }
  assert.ok(Math.abs(sumR / (w * h) - 100.25) < 0.02, `mean red ${sumR / (w * h)}`);
  assert.ok(Math.abs(sumB / (w * h) - 10.5) < 0.02, `mean blue ${sumB / (w * h)}`);
  // deterministic: the same planes dither the same way
  assert.deepEqual(Array.from(toCanvasData(deep, { dither: true }).data.subarray(0, 400)), Array.from(out.data.subarray(0, 400)));
});

test('extractRect / writeRect / mixRect / hasPrecision', () => {
  const deep = createDeep(8, 6, 'u16');
  for (let i = 0; i < deep.data.length; i++) deep.data[i] = i * 100;
  const patch = extractRect(deep, { x: 2, y: 1, width: 3, height: 2 });
  assert.deepEqual([patch.x, patch.y, patch.width, patch.height, patch.data.length], [2, 1, 3, 2, 24]);
  assert.equal(patch.data[0], (1 * 8 + 2) * 4 * 100);
  const changed = cloneDeep(deep);
  changed.data.fill(0);
  writeRect(changed, patch);
  assert.equal(changed.data[(1 * 8 + 2) * 4], patch.data[0]);
  assert.equal(changed.data[(1 * 8 + 1) * 4], 0);
  // half-selected pixel lands half way between before and now
  const now = cloneDeep(deep);
  for (let i = 0; i < now.data.length; i++) now.data[i] = 60000;
  mixRect(now, patch, new Uint8ClampedArray([0, 255, 128, 0, 0, 0]));
  const at = (x, y) => now.data[(y * 8 + x) * 4];
  assert.equal(at(2, 1), patch.data[0]);
  assert.equal(at(3, 1), 60000);
  assert.equal(at(4, 1), Math.round(patch.data[8] + (60000 - patch.data[8]) * (128 / 255)));
  assert.equal(at(1, 1), 60000, 'outside the patch nothing moves');
  assert.equal(hasPrecision(fromCanvasData(randomImage(4, 4), 'u16')), false);
  assert.equal(hasPrecision(fromCanvasData(randomImage(4, 4), 'f32')), false);
  assert.equal(hasPrecision(deep), true);
  assert.equal(hasPrecision({ type: 'f32', data: new Float32Array([0.5, 1, 0, 1]) }), true);
});

test('syncFromProxy takes over 8-bit edits, leaves precise samples alone and restores them on undo', () => {
  const w = 16, h = 8;
  const deep = createDeep(w, h, 'u16');
  for (let i = 0; i < w * h; i++) {
    deep.data[i * 4] = 20000 + i * 13;
    deep.data[i * 4 + 1] = 30000 + i * 7;
    deep.data[i * 4 + 2] = 40000 + i;
    deep.data[i * 4 + 3] = 65535;
  }
  const original = cloneDeep(deep);
  const proxy = toCanvasData(deep);
  assert.deepEqual(syncFromProxy(deep, proxy), { changed: 0, restored: 0, loosePixels: 0, bounds: null });
  // a "brush stroke": three pixels painted pure red at 8 bits
  const painted = { width: w, height: h, data: proxy.data.slice() };
  for (const p of [18, 19, 35]) painted.data.set([255, 0, 0, 255], p * 4);
  const stash = extractRect(deep);
  const res = syncFromProxy(deep, painted);
  assert.equal(res.changed, 3);
  assert.deepEqual(res.bounds, { x: 2, y: 1, width: 2, height: 2 });
  assert.deepEqual(Array.from(deep.data.subarray(18 * 4, 18 * 4 + 4)), [65535, 0, 0, 65535]);
  assert.equal(deep.data[17 * 4], original.data[17 * 4], 'untouched neighbours keep their 16-bit values');
  assert.deepEqual(Array.from(toCanvasData(deep).data), Array.from(painted.data));
  // undo: the proxy is the old one again; with the stash the exact samples come back, without it 8-bit ones
  const noStash = cloneDeep(deep);
  const undo = syncFromProxy(deep, proxy, { restore: [stash] });
  assert.equal(undo.restored, 3);
  assert.deepEqual(Array.from(deep.data), Array.from(original.data));
  syncFromProxy(noStash, proxy);
  assert.equal(noStash.data[18 * 4], proxy.data[18 * 4] * 257);
  // a rect-sized proxy only looks at its rect
  const part = { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(9) };
  const r2 = syncFromProxy(deep, part, { rect: { x: 4, y: 4, width: 2, height: 2 } });
  assert.equal(r2.changed, 4);
  assert.equal(deep.data[(4 * w + 4) * 4], 9 * 257);
  assert.equal(deep.data[(4 * w + 3) * 4], original.data[(4 * w + 3) * 4]);
  // loose: a proxy rounded the other way (within one step) is accepted and counted, real differences are not
  const f = { type: 'f32', width: 2, height: 1, data: new Float32Array([0.5039, 0.2, 0.2, 1, 0.9, 0.9, 0.9, 1]) };
  const up = { width: 2, height: 1, data: new Uint8ClampedArray([129, 51, 51, 255, 10, 10, 10, 255]) }; // 0.5039 * 255 = 128.49 -> 128, the proxy says 129
  const lr = syncFromProxy(f, up, { loose: true });
  assert.deepEqual([lr.loosePixels, lr.changed], [1, 1]);
  assert.ok(Math.abs(f.data[0] - 0.5039) < 1e-6);
  assert.ok(Math.abs(f.data[4] - 10 / 255) < 1e-6);
});

test('syncFromProxy: translucent pixels read back from a canvas are not edits; resampleDeep averages and interpolates', () => {
  // a canvas stores premultiplied 8-bit colour: (200, 100, 50) at alpha 10 comes back as (204, 102, 51)
  const deep = { type: 'u16', width: 3, height: 1, data: new Uint16Array([51400, 25700, 12850, 2570, 40000, 30000, 20000, 0, 3007, 13003, 12345, 30000]) };
  const before = Array.from(deep.data);
  const canvasSays = { width: 3, height: 1, data: new Uint8ClampedArray([204, 102, 51, 10, 0, 0, 0, 0, 13, 51, 48, 117]) };
  const same = syncFromProxy(deep, canvasSays, { backup: true });
  assert.deepEqual([same.changed, same.before], [0, null]);
  assert.deepEqual(Array.from(deep.data), before);
  // a real edit of a translucent pixel (another alpha, or a colour further away than the canvas rounding) is taken over
  const edited = { width: 3, height: 1, data: new Uint8ClampedArray([204, 102, 51, 11, 0, 0, 0, 0, 200, 51, 48, 117]) };
  const res = syncFromProxy(deep, edited, { backup: true });
  assert.equal(res.changed, 2);
  assert.deepEqual(Array.from(res.before), before, 'the backup is the state before the call');
  assert.deepEqual(Array.from(deep.data), [204 * 257, 102 * 257, 51 * 257, 11 * 257, 40000, 30000, 20000, 0, 200 * 257, 51 * 257, 48 * 257, 117 * 257]);

  // halving a 4 x 2 image averages 2 x 2 blocks at full precision (transparent pixels carry no colour)
  const src = createDeep(4, 2, 'u16');
  const px = [[1000, 0, 0, 65535], [2001, 0, 0, 65535], [60000, 0, 0, 65535], [9, 9, 9, 0], [3000, 0, 0, 65535], [4000, 0, 0, 65535], [60000, 0, 0, 65535], [9, 9, 9, 0]];
  px.forEach((p, i) => src.data.set(p, i * 4));
  const half = resampleDeep(src, 2, 1);
  assert.deepEqual([half.width, half.height, half.type], [2, 1, 'u16']);
  assert.equal(half.data[0], Math.round((1000 + 2001 + 3000 + 4000) / 4));
  assert.equal(half.data[3], 65535);
  assert.equal(half.data[4], 60000, 'the transparent half of the block adds no colour');
  assert.ok(Math.abs(half.data[7] - 32768) <= 1);
  // doubling a ramp interpolates between samples: 16-bit in-between values appear
  const ramp = createDeep(3, 1, 'u16');
  [0, 30000, 60000].forEach((v, i) => ramp.data.set([v, v, v, 65535], i * 4));
  const big = resampleDeep(ramp, 6, 1);
  const reds = Array.from({ length: 6 }, (_, i) => big.data[i * 4]);
  assert.deepEqual(reds, [0, 7500, 22500, 37500, 52500, 60000]);
  // float planes keep values above white; the same size is a copy
  const f = { type: 'f32', width: 2, height: 1, data: new Float32Array([3, 1, 0, 1, 1, 1, 0, 1]) };
  const one = resampleDeep(f, 1, 1);
  assert.deepEqual(Array.from(one.data), [2, 1, 0, 1]);
  const copy = resampleDeep(f, 2, 1);
  assert.notEqual(copy.data, f.data);
  assert.deepEqual(Array.from(copy.data), Array.from(f.data));
});

test('carryOver moves deep samples to a cropped, grown, flipped or turned canvas and nowhere they do not belong', () => {
  const W = 40, H = 30;
  const old = createDeep(W, H, 'u16');
  const rnd = rng(21);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) old.data.set([x * 1500 + Math.floor(rnd() * 250), y * 2000 + 77, 20000 + x * y, x === 5 ? 20000 : 65535], (y * W + x) * 4);
  const proxy = toCanvasData(old);
  const at = (planes, x, y) => Array.from(planes.data.subarray((y * planes.width + x) * 4, (y * planes.width + x) * 4 + 4));
  const oldAt = (x, y) => Array.from(old.data.subarray((y * W + x) * 4, (y * W + x) * 4 + 4));
  /** A new w x h image whose pixel (x, y) is the old proxy's pixel at src(x, y), or `fill` outside it. */
  const remap = (w, h, src, fill = [0, 0, 0, 0]) => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const [ox, oy] = src(x, y);
      data.set(ox >= 0 && oy >= 0 && ox < W && oy < H ? proxy.data.subarray((oy * W + ox) * 4, (oy * W + ox) * 4 + 4) : fill, (y * w + x) * 4);
    }
    return { width: w, height: h, data };
  };
  // a crop, found without any hint
  const crop = carryOver(remap(20, 12, (x, y) => [x + 7, y + 9]), old);
  assert.deepEqual([crop.how, crop.carried, crop.planes.type, crop.planes.width], ['offset', 240, 'u16', 20]);
  assert.deepEqual(at(crop.planes, 3, 4), oldAt(10, 13));
  // a canvas that grew around the old one (transparent margin), with the document-position hint and without
  const grown = remap(50, 36, (x, y) => [x - 6, y - 4]);
  for (const hint of [{ dx: 6, dy: 4 }, {}]) {
    const g = carryOver(grown, old, hint);
    assert.equal(g.carried, W * H);
    assert.deepEqual(at(g.planes, 16, 14), oldAt(10, 10));
    assert.deepEqual(at(g.planes, 2, 2), [0, 0, 0, 0]);
  }
  // flips and quarter turns
  const cases = [
    ['flip-h', W, H, (x, y) => [W - 1 - x, y]], ['flip-v', W, H, (x, y) => [x, H - 1 - y]], ['rotate-180', W, H, (x, y) => [W - 1 - x, H - 1 - y]],
    ['rotate-90', H, W, (x, y) => [y, H - 1 - x]], ['rotate--90', H, W, (x, y) => [W - 1 - y, x]],
  ];
  for (const [name, w, h, src] of cases) {
    const r = carryOver(remap(w, h, src), old, { dx: 0, dy: 0 });
    assert.deepEqual([r.how, r.carried], [name, W * H], name);
    const [ox, oy] = src(3, 8);
    assert.deepEqual(at(r.planes, 3, 8), oldAt(ox, oy), name);
  }
  // the same canvas with a painted stripe: untouched pixels keep their samples, painted ones take the proxy
  const painted = remap(W, H, (x, y) => [x, y]);
  for (let x = 0; x < W; x++) painted.data.set([255, 0, 0, 255], (10 * W + x) * 4);
  const p = carryOver(painted, old, { dx: 0, dy: 0 });
  assert.equal(p.carried, W * (H - 1));
  assert.deepEqual(at(p.planes, 4, 10), [65535, 0, 0, 65535]);
  assert.deepEqual(at(p.planes, 4, 11), oldAt(4, 11));
  // unrelated pixels: nothing is carried, the planes are the proxy's; a float target converts on the way
  const noise = { width: 20, height: 20, data: new Uint8ClampedArray(1600).map(() => rnd() * 256) };
  const none = carryOver(noise, old);
  assert.deepEqual([none.how, none.carried], [null, 0]);
  assert.equal(none.planes.data[0], noise.data[0] * 257);
  const f = carryOver(remap(20, 12, (x, y) => [x + 7, y + 9]), old, { type: 'f32' });
  assert.equal(f.planes.type, 'f32');
  assert.ok(Math.abs(f.planes.data[0] - old.data[(9 * W + 7) * 4] / 65535) < 1e-7);
});

// ---- adjustments -----------------------------------------------------------------------------

test('16-bit Levels on a 16-bit ramp has no 8-bit banding', () => {
  const params = { rgb: { inBlack: 20, inWhite: 235, gamma: 1, outBlack: 0, outWhite: 255 } };
  const deep = ramp16();
  assert.deepEqual(applyAdjustmentDeep(deep, 'levels', params), { exact: true });
  const shape = rampShape(deep);
  // the stretch has a slope of 255 / 215 = 1.19: neighbours differ by at most 2 of 65535
  assert.ok(shape.maxStep <= 2, `largest step ${shape.maxStep}`);
  assert.equal(shape.decreasing, 0);
  assert.ok(shape.distinct > 50000, `${shape.distinct} distinct output levels`);
  assert.equal(deep.data[20 * 257 * 4], 0);
  assert.equal(deep.data[235 * 257 * 4], 65535);
  // exact against the formula for every input
  for (let v = 0; v < 65536; v += 97) {
    const t = Math.min(1, Math.max(0, (v / 257 - 20) / 215));
    assert.equal(deep.data[v * 4], Math.round(t * 65535), `input ${v}`);
  }
  assert.equal(deep.data[1000 * 4 + 3], 65535, 'alpha is never touched');
  // the same edit at 8 bits, scaled up, has the banding this is about: 256 levels and steps of ~300
  const banded = fromCanvasData(applyAdjustment(toCanvasData(ramp16()), 'levels', params), 'u16');
  const bandedShape = rampShape(banded);
  assert.ok(bandedShape.distinct <= 256);
  assert.ok(bandedShape.maxStep >= 257);
  // with a gamma the curve is steep near black but still monotone and smooth where the slope is moderate
  const g = ramp16();
  applyAdjustmentDeep(g, 'levels', { rgb: { inBlack: 0, inWhite: 255, gamma: 2.2, outBlack: 0, outWhite: 255 } });
  assert.equal(rampShape(g).decreasing, 0);
  for (let v = 20000; v < 65535; v++) assert.ok(g.data[(v + 1) * 4] - g.data[v * 4] <= 2);
  assert.ok(Math.abs(g.data[32768 * 4] / 65535 - Math.pow(32768 / 65535, 1 / 2.2)) < 1e-4);
});

test('per-channel Levels apply the channel table before the composite one, like the 8-bit kind', () => {
  const params = { rgb: { inBlack: 10, inWhite: 240, gamma: 1.3, outBlack: 5, outWhite: 250 }, r: { inBlack: 30, inWhite: 200, gamma: 0.8, outBlack: 0, outWhite: 255 } };
  const img = randomImage(64, 64, 9);
  const ref = applyAdjustment({ width: 64, height: 64, data: img.data.slice() }, 'levels', params);
  const deep = fromCanvasData(img, 'u16');
  applyAdjustmentDeep(deep, 'levels', params);
  const out = toCanvasData(deep);
  for (let i = 0; i < out.data.length; i++) assert.ok(Math.abs(out.data[i] - ref.data[i]) <= 2, `sample ${i}: ${out.data[i]} vs ${ref.data[i]}`);
});

test('applyLutDeep interpolates an 8-bit table: smooth on a 16-bit ramp, equal to the table at 8-bit values', () => {
  const lut = levelsLut({ inBlack: 20, inWhite: 235 });
  const deep = ramp16();
  applyLutDeep(deep, [lut, lut, lut]);
  const shape = rampShape(deep);
  assert.ok(shape.maxStep <= 2, `largest step ${shape.maxStep}`);
  assert.ok(shape.distinct > 30000);
  for (let k = 0; k < 256; k++) assert.equal(deep.data[k * 257 * 4], lut[k] * 257, `table entry ${k}`);
  // float planes: same interpolation, clamped input
  const f = { type: 'f32', width: 3, height: 1, data: new Float32Array([0.5, 0.5, 0.5, 1, -1, 2, 20.5 / 255, 0.25, 0, 0, 0, 0]) };
  applyLutDeep(f, [lut, lut, lut]);
  assert.ok(Math.abs(f.data[0] - ((127.5 - 20) / 215)) < 0.003);
  assert.equal(f.data[4], 0);
  assert.equal(f.data[5], 1);
  assert.ok(f.data[6] > 0 && f.data[6] < 1 / 255, 'half way between table entries 20 (0) and 21 (1)');
  assert.equal(f.data[7], 0.25, 'alpha stays');
  // a rect limits the edit
  const part = ramp16();
  applyLutDeep(part, [lut, lut, lut], { x: 100, y: 0, width: 50, height: 1 });
  assert.equal(part.data[99 * 4], 99);
  assert.equal(part.data[150 * 4], 150);
  assert.equal(part.data[120 * 4], 0);
});

test('Curves are the exact spline: analytic lines to the last bit, the 8-bit table at its 256 nodes', () => {
  // straight lines have a closed form: identity, inversion, half range
  const id = ramp16();
  applyAdjustmentDeep(id, 'curves', { rgb: [[0, 0], [255, 255]] });
  const inv = ramp16();
  applyAdjustmentDeep(inv, 'curves', { rgb: [[0, 255], [255, 0]] });
  const half = ramp16();
  applyAdjustmentDeep(half, 'curves', { rgb: [[0, 0], [255, 128]] });
  for (let v = 0; v < 65536; v++) {
    assert.equal(id.data[v * 4], v);
    assert.equal(inv.data[v * 4], 65535 - v);
    assert.ok(Math.abs(half.data[v * 4] - (v * 128) / 255) <= 0.5 + 1e-6, `half at ${v}: ${half.data[v * 4]}`);
  }
  // an S-curve: at every 8-bit node the float spline rounds to the 8-bit table; between nodes it is smooth
  const points = [[0, 0], [64, 40], [128, 150], [200, 215], [255, 255]];
  const lut = curveLut(points);
  const fn = curveFn(points);
  const deep = ramp16();
  assert.deepEqual(applyAdjustmentDeep(deep, 'curves', { rgb: points }), { exact: true });
  for (let k = 0; k < 256; k++) {
    assert.ok(Math.abs(fn(k) - lut[k]) <= 0.5 + 1e-9, `node ${k}: ${fn(k)} vs ${lut[k]}`);
    assert.equal(deep.data[k * 257 * 4], Math.round(fn(k) * 257));
  }
  for (const [x, y] of points) assert.equal(deep.data[x * 257 * 4], y * 257, 'the curve passes through its points');
  // a float reference between the nodes: cubic Hermite of the segment 64..128 evaluated by hand at 96.5
  const m1 = ((40 - 0) / 64 + (150 - 40) / 64) / 2, m2 = ((150 - 40) / 64 + (215 - 150) / 72) / 2;
  const t = (96.5 - 64) / 64, h = 64;
  const ref = (2 * t ** 3 - 3 * t ** 2 + 1) * 40 + (t ** 3 - 2 * t ** 2 + t) * h * m1 + (-2 * t ** 3 + 3 * t ** 2) * 150 + (t ** 3 - t ** 2) * h * m2;
  assert.ok(Math.abs(fn(96.5) - ref) < 1e-9, `${fn(96.5)} vs ${ref}`);
  const v = Math.round(96.5 * 257);
  assert.ok(Math.abs(deep.data[v * 4] - fn(v / 257) * 257) <= 0.5 + 1e-6);
  const shape = rampShape(deep);
  assert.equal(shape.decreasing, 0);
  assert.ok(shape.maxStep <= 3, `largest step ${shape.maxStep}`);
  assert.ok(shape.distinct > 40000);
  // channel curves run before the composite curve
  const two = ramp16();
  applyAdjustmentDeep(two, 'curves', { rgb: [[0, 0], [255, 128]], g: [[0, 255], [255, 0]] });
  assert.ok(Math.abs(two.data[1000 * 4 + 1] - ((65535 - 1000) * 128) / 255) <= 1);
  assert.ok(Math.abs(two.data[1000 * 4] - (1000 * 128) / 255) <= 1);
});

const PARAMS = {
  'brightness-contrast': { brightness: 40, contrast: 30 },
  levels: { rgb: { inBlack: 20, inWhite: 230, gamma: 1.4, outBlack: 5, outWhite: 250 } },
  curves: { rgb: [[0, 0], [64, 40], [128, 150], [255, 255]], g: [[0, 20], [255, 230]] },
  exposure: { exposure: 0.7, offset: 0.02, gamma: 1.2 },
  invert: {},
  posterize: { levels: 5 },
  'color-balance': { shadows: [20, -10, 5], midtones: [-30, 10, 40], highlights: [10, 0, -20] },
  'photo-filter': { density: 40 },
  desaturate: {},
  threshold: { level: 100 },
  'gradient-map': { stops: [{ offset: 0, color: '#102030' }, { offset: 0.5, color: '#c08040' }, { offset: 1, color: '#ffffee' }] },
  vibrance: { vibrance: 60, saturation: -20 },
  'hue-saturation': { hue: 40, saturation: 30, lightness: -10 },
  'black-white': { tint: { hue: 30, sat: 40 } },
  'channel-mixer': { r: { r: 80, g: 30, b: -10, constant: 5 } },
};

test('every exact kind agrees with the 8-bit adjustment on 8-bit input, at 16 and at 32 bits', () => {
  assert.deepEqual([...EXACT_KINDS].sort(), Object.keys(PARAMS).sort());
  const img = randomImage(96, 64, 5);
  for (const kind of EXACT_KINDS) {
    assert.ok(isExactKind(kind));
    const ref = applyAdjustment({ width: img.width, height: img.height, data: img.data.slice() }, kind, PARAMS[kind]);
    for (const type of ['u16', 'f32']) {
      const deep = fromCanvasData(img, type);
      assert.deepEqual(applyAdjustmentDeep(deep, kind, PARAMS[kind]), { exact: true }, kind);
      const out = toCanvasData(deep);
      let worst = 0;
      for (let i = 0; i < out.data.length; i++) worst = Math.max(worst, Math.abs(out.data[i] - ref.data[i]));
      // the 8-bit kinds round once or twice on the way (tables, then luma); the float ones do not
      assert.ok(worst <= 2, `${kind} ${type}: differs by ${worst}`);
    }
  }
  // more variants of the per-pixel kinds
  const more = [
    ['hue-saturation', { colorize: true, colorizeHue: 200, colorizeSat: 60, colorizeLight: 20 }],
    ['hue-saturation', { hue: -60, saturation: -40, range: 'reds' }],
    ['hue-saturation', { lightness: 35 }],
    ['vibrance', { vibrance: -50 }],
    ['channel-mixer', { monochrome: true, gray: { r: 30, g: 59, b: 11, constant: 0 } }],
    ['black-white', { reds: 120, blues: -50 }],
    ['brightness-contrast', { brightness: -30, contrast: -40, legacy: true }],
    ['color-balance', { midtones: [40, 0, -40], preserveLuminosity: false }],
    ['gradient-map', { reverse: true }],
  ];
  for (const [kind, params] of more) {
    const ref = applyAdjustment({ width: img.width, height: img.height, data: img.data.slice() }, kind, params);
    const deep = fromCanvasData(img, 'u16');
    applyAdjustmentDeep(deep, kind, params);
    const out = toCanvasData(deep);
    let worst = 0;
    for (let i = 0; i < out.data.length; i++) worst = Math.max(worst, Math.abs(out.data[i] - ref.data[i]));
    assert.ok(worst <= 2, `${kind} ${JSON.stringify(params)}: differs by ${worst}`);
  }
});

test('exact kinds keep 16-bit precision: desaturate, invert and the mixer on values no 8-bit pixel has', () => {
  const deep = { type: 'u16', width: 2, height: 1, data: new Uint16Array([12345, 23456, 34567, 65535, 1001, 1002, 1003, 30000]) };
  const d = cloneDeep(deep);
  applyAdjustmentDeep(d, 'desaturate');
  const l = Math.round(0.299 * 12345 + 0.587 * 23456 + 0.114 * 34567);
  assert.deepEqual(Array.from(d.data.subarray(0, 4)), [l, l, l, 65535]);
  const i = cloneDeep(deep);
  applyAdjustmentDeep(i, 'invert');
  assert.deepEqual(Array.from(i.data), [65535 - 12345, 65535 - 23456, 65535 - 34567, 65535, 64534, 64533, 64532, 30000]);
  const m = cloneDeep(deep);
  applyAdjustmentDeep(m, 'channel-mixer', { r: { r: 50, g: 50, b: 0, constant: 0 } });
  assert.equal(m.data[0], Math.round((12345 + 23456) / 2));
  assert.equal(m.data[1], 23456);
  // a rect limits the edit to its pixels
  const r = cloneDeep(deep);
  applyAdjustmentDeep(r, 'invert', {}, { x: 1, y: 0, width: 1, height: 1 });
  assert.deepEqual(Array.from(r.data.subarray(0, 5)), [12345, 23456, 34567, 65535, 64534]);
  assert.throws(() => applyAdjustmentDeep(deep, 'no-such-kind'), RangeError);
});

test('32-bit Exposure keeps highlights above white: +2 stops then -2 stops is the original; 16 bits clip', () => {
  const values = [0.1, 0.4, 0.75, 0.95];
  const f = { type: 'f32', width: 4, height: 1, data: new Float32Array(values.flatMap((v) => [v, v, v, 1])) };
  applyAdjustmentDeep(f, 'exposure', { exposure: 2 });
  assert.ok(f.data[8] > 1.3, `0.75 two stops up is ${f.data[8]}`);
  assert.equal(toCanvasData(f).data[8], 255, 'the proxy clamps');
  applyAdjustmentDeep(f, 'exposure', { exposure: -2 });
  values.forEach((v, k) => assert.ok(Math.abs(f.data[k * 4] - v) < 1e-5, `${v} came back as ${f.data[k * 4]}`));
  const u = { type: 'u16', width: 1, height: 1, data: new Uint16Array([49151, 49151, 49151, 65535]) };
  applyAdjustmentDeep(u, 'exposure', { exposure: 2 });
  assert.equal(u.data[0], 65535);
  applyAdjustmentDeep(u, 'exposure', { exposure: -2 });
  assert.ok(u.data[0] < 40000, 'the clipped highlight is gone at 16 bits');
});

test('kinds without a float implementation run at 8 bits and add their change onto the deep samples', () => {
  assert.equal(isExactKind('selective-color'), false);
  const w = 32, h = 8;
  const deep = createDeep(w, h, 'u16');
  for (let i = 0; i < w * h; i++) {
    const red = i % w < 16;
    deep.data[i * 4] = red ? 60000 + i : 30000 + i;
    deep.data[i * 4 + 1] = red ? 5000 + i : 30100 + i;
    deep.data[i * 4 + 2] = red ? 5100 : 30200;
    deep.data[i * 4 + 3] = 65535;
  }
  const before = cloneDeep(deep);
  const params = { reds: { c: 0, m: -60, y: 0, k: 0 } };
  const ref = applyAdjustment(toCanvasData(before), 'selective-color', params);
  assert.deepEqual(applyAdjustmentDeep(deep, 'selective-color', params), { exact: false });
  assert.deepEqual(Array.from(toCanvasData(deep).data), Array.from(ref.data), 'the proxy of the result is the 8-bit result');
  let moved = 0;
  for (let i = 0; i < w * h; i++) {
    if (i % w >= 16) {
      // greys are not "reds": untouched, with their 16-bit values
      assert.equal(deep.data[i * 4 + 1], before.data[i * 4 + 1]);
    } else if (deep.data[i * 4 + 1] !== before.data[i * 4 + 1]) {
      moved++;
      assert.equal((deep.data[i * 4 + 1] - before.data[i * 4 + 1]) % 257, 0, 'the change is a whole number of 8-bit steps');
    }
  }
  assert.ok(moved > 100);
  // applyVia8Bit with any 8-bit operation
  const g = { type: 'u16', width: 1, height: 1, data: new Uint16Array([1000, 2000, 3000, 65535]) };
  applyVia8Bit(g, (img) => {
    img.data[0] += 10;
  });
  assert.deepEqual(Array.from(g.data), [1000 + 2570, 2000, 3000, 65535]);
  // every registered kind runs on deep planes and reports honestly
  for (const kind of Object.keys(ADJUSTMENTS)) {
    if (ADJUSTMENTS[kind].placeholder) continue;
    const d = fromCanvasData(randomImage(8, 8, 2), 'u16');
    assert.equal(applyAdjustmentDeep(d, kind).exact, isExactKind(kind), kind);
  }
});

// ---- compositing and statistics --------------------------------------------------------------

test('blendDeep composites in float: opacity, multiply, screen, masks, transparent backdrops', () => {
  const solid = (type, w, h, rgba) => {
    const d = createDeep(w, h, type);
    for (let i = 0; i < w * h; i++) d.data.set(rgba, i * 4);
    return d;
  };
  // 50% white over black: 32767.5 -> 32768 (an 8-bit composite gives 128 * 257 = 32896)
  const dst = solid('u16', 4, 2, [0, 0, 0, 65535]);
  blendDeep(dst, solid('u16', 4, 2, [65535, 65535, 65535, 65535]), { alpha: 0.5 });
  assert.deepEqual(Array.from(dst.data.subarray(0, 4)), [32768, 32768, 32768, 65535]);
  // multiply and screen of two 16-bit values
  const a = 40000, b = 50000;
  const mul = solid('u16', 1, 1, [a, a, a, 65535]);
  blendDeep(mul, solid('u16', 1, 1, [b, b, b, 65535]), { mode: 'multiply' });
  assert.equal(mul.data[0], Math.round((a * b) / 65535));
  const scr = solid('u16', 1, 1, [a, a, a, 65535]);
  blendDeep(scr, solid('u16', 1, 1, [b, b, b, 65535]), { mode: 'screen' });
  assert.equal(scr.data[0], Math.round(65535 - ((65535 - a) * (65535 - b)) / 65535));
  // over a transparent backdrop the source colour and alpha come through; multiply has nothing to multiply with
  const clear = createDeep(2, 1, 'u16');
  blendDeep(clear, solid('u16', 2, 1, [1234, 2345, 3456, 30000]), { mode: 'multiply' });
  assert.deepEqual(Array.from(clear.data.subarray(0, 4)), [1234, 2345, 3456, 30000]);
  // straight-alpha "over" with two partial alphas
  const half = solid('u16', 1, 1, [65535, 0, 0, 32768]);
  blendDeep(half, solid('u16', 1, 1, [0, 0, 65535, 32768]));
  const as = 32768 / 65535, ao = as + as * (1 - as);
  assert.ok(Math.abs(half.data[3] - ao * 65535) <= 1);
  assert.ok(Math.abs(half.data[2] - (as / ao) * 65535) <= 1);
  assert.ok(Math.abs(half.data[0] - (((1 - as) * as) / ao) * 65535) <= 1);
  // offset, clipping and a mask (the alpha channel of an RGBA image placed at an offset)
  const big = solid('u16', 6, 4, [0, 0, 0, 65535]);
  const mask = { width: 2, height: 2, x: 4, y: 2, channels: 4, offset: 3, data: new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 128, 0, 0, 0, 255]) };
  blendDeep(big, solid('u16', 4, 4, [65535, 65535, 65535, 65535]), { x: 3, y: 1, mask });
  const at = (x, y) => big.data[(y * 6 + x) * 4];
  assert.equal(at(4, 2), 65535);
  assert.equal(at(5, 2), 0, 'mask alpha 0 hides the source');
  assert.equal(at(4, 3), Math.round((128 / 255) * 65535));
  assert.equal(at(3, 1), 0, 'outside the mask the source is hidden');
  assert.equal(at(2, 2), 0);
  // mixed sample types: float source over a 16-bit backdrop, HDR clipped on the way in
  const mixed = solid('u16', 1, 1, [0, 0, 0, 65535]);
  blendDeep(mixed, solid('f32', 1, 1, [0.25, 2, 0.5, 1]));
  assert.deepEqual(Array.from(mixed.data), [16384, 65535, 32768, 65535]);
  const fl = solid('f32', 1, 1, [0.2, 0.2, 0.2, 1]);
  blendDeep(fl, solid('f32', 1, 1, [3, 0.5, 0, 1]), { alpha: 0.5 });
  assert.ok(Math.abs(fl.data[0] - 1.6) < 1e-6, 'float backdrops keep values above white');
  assert.throws(() => blendDeep(dst, dst, { mode: 'overlay' }), RangeError);
});

test('statistics: min, max, mean, deviation and the number of levels in use', () => {
  const ramp = ramp16();
  const s = statistics(ramp);
  assert.equal(s.count, 65536);
  assert.deepEqual([s.channels[0].min, s.channels[0].max, s.channels[0].distinct], [0, 65535, 65536]);
  assert.ok(Math.abs(s.channels[0].mean - 32767.5) < 1e-6);
  assert.ok(Math.abs(s.channels[0].stdDev - 65536 / Math.sqrt(12)) < 1);
  assert.equal(s.channels[3].distinct, 1);
  // a ramp that went through 8 bits uses 256 levels
  const through8 = fromCanvasData(toCanvasData(ramp), 'u16');
  assert.equal(statistics(through8).channels[0].distinct, 256);
  // transparent pixels do not count; rect limits; float planes report no level count
  const f = { type: 'f32', width: 3, height: 1, data: new Float32Array([0.5, 0.5, 0.5, 1, 9, 9, 9, 0, 1.5, 0.25, 0, 0.5]) };
  const fs = statistics(f);
  assert.equal(fs.count, 2);
  assert.deepEqual([fs.channels[0].min, fs.channels[0].max, fs.channels[0].distinct], [0.5, 1.5, null]);
  assert.equal(statistics(f, { x: 0, y: 0, width: 1, height: 1 }).count, 1);
  assert.equal(statistics(createDeep(2, 2, 'u16')).count, 0);
});

// ---- PNG 16 ----------------------------------------------------------------------------------

test('PNG 16 export: encodePng of the planes decodes to the same 16-bit samples', async () => {
  const w = 40, h = 13;
  const deep = createDeep(w, h, 'u16');
  const rnd = rng(11);
  for (let i = 0; i < deep.data.length; i++) deep.data[i] = i % 4 === 3 ? (i % 12 === 3 ? 30000 : 65535) : rnd() * 65536;
  for (const codecs of [{}, nodeCodecs]) {
    const bytes = await encodePng({ width: w, height: h, channels: 4, depth: 16, data: deep.data }, { dpi: 300, ...codecs });
    assert.deepEqual(pngInfo(bytes), { width: w, height: h, bitDepth: 16, colorType: 6, interlace: 0 });
    const dec = await decodePng(bytes, codecs);
    assert.equal(dec.dpi, 300);
    const back = toRgba16(dec);
    assert.deepEqual(Array.from(back.data), Array.from(deep.data));
  }
  // an adjusted ramp survives the file: more than 256 levels come back
  const ramp = createDeep(4096, 1, 'u16');
  for (let x = 0; x < 4096; x++) ramp.data.set([x * 16, x * 16, x * 16, 65535], x * 4);
  applyAdjustmentDeep(ramp, 'curves', { rgb: [[0, 0], [128, 160], [255, 255]] });
  const back = toRgba16(await decodePng(await encodePng({ width: 4096, height: 1, channels: 4, depth: 16, data: ramp.data })));
  assert.deepEqual(Array.from(back.data), Array.from(ramp.data));
  assert.ok(new Set(back.data).size > 3000);
});

// ---- TIFF ------------------------------------------------------------------------------------

function planes(w, h, channels, depth, seed = 1) {
  const rnd = rng(seed);
  const n = w * h * channels;
  const data = depth === 8 ? new Uint8ClampedArray(n) : depth === 16 ? new Uint16Array(n) : new Float32Array(n);
  // smooth with a little noise, so the predictor and the dictionary both have something to do
  for (let i = 0; i < n; i++) {
    const p = Math.floor(i / channels), c = i % channels;
    const base = ((p % w) * 3 + Math.floor(p / w) * 5 + c * 40) % 256;
    data[i] = depth === 8 ? base : depth === 16 ? Math.min(65535, base * 257 + Math.floor(rnd() * 200)) : (base + rnd()) / 128;
  }
  return { width: w, height: h, channels, depth, data };
}

test('LZW: the specification example, long inputs that fill the table, empty input', () => {
  // TIFF 6.0 section 13: the bytes 7 7 7 8 8 7 7 6 6 become the codes 256 7 258 8 8 258 6 6 257 at 9 bits
  const codes = [256, 7, 258, 8, 8, 258, 6, 6, 257];
  const bits = codes.map((c) => c.toString(2).padStart(9, '0')).join('');
  const expected = (bits + '0'.repeat((8 - (bits.length % 8)) % 8)).match(/.{8}/g).map((b) => parseInt(b, 2));
  const src = new Uint8Array([7, 7, 7, 8, 8, 7, 7, 6, 6]);
  assert.deepEqual(Array.from(lzwEncode(src)), expected);
  assert.deepEqual(Array.from(lzwDecode(new Uint8Array(expected), 9)), Array.from(src));
  const rnd = rng(4);
  for (const kind of ['random', 'smooth', 'zeros']) {
    const n = 200000;
    const data = new Uint8Array(n);
    for (let i = 0; i < n; i++) data[i] = kind === 'random' ? rnd() * 256 : kind === 'smooth' ? (i >> 6) & 255 : 0;
    const enc = lzwEncode(data);
    if (kind !== 'random') assert.ok(enc.length < n / 4, `${kind} compresses (${enc.length})`);
    const dec = lzwDecode(enc, n);
    assert.ok(dec.every((v, i) => v === data[i]), kind);
  }
  assert.deepEqual(Array.from(lzwDecode(lzwEncode(new Uint8Array(0)), 0)), []);
  assert.deepEqual(Array.from(lzwDecode(lzwEncode(new Uint8Array([42])), 1)), [42]);
});

test('PackBits: the Apple technical note example and round trips', () => {
  const unpacked = [0xaa, 0xaa, 0xaa, 0x80, 0x00, 0x2a, 0xaa, 0xaa, 0xaa, 0xaa, 0x80, 0x00, 0x2a, 0x22, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa];
  const packed = [0xfe, 0xaa, 0x02, 0x80, 0x00, 0x2a, 0xfd, 0xaa, 0x03, 0x80, 0x00, 0x2a, 0x22, 0xf7, 0xaa];
  assert.deepEqual(Array.from(unpackBits(new Uint8Array(packed), 24)), unpacked);
  assert.deepEqual(packBitsRow(new Uint8Array(unpacked)), packed);
  const rnd = rng(8);
  for (const span of [1, 2, 3, 40, 300]) {
    const row = new Uint8Array(1500);
    for (let i = 0; i < row.length; i++) row[i] = span === 1 ? rnd() * 256 : Math.floor(i / span) * 7;
    const p = Uint8Array.from(packBitsRow(row));
    assert.deepEqual(Array.from(unpackBits(p, row.length)), Array.from(row), `runs of ${span}`);
    if (span >= 40) assert.ok(p.length < row.length / 5);
  }
});

test('TIFF round trips: 8 and 16 bits, LZW and PackBits, big and little endian', async () => {
  for (const depth of [8, 16]) {
    for (const channels of [1, 2, 3, 4]) {
      for (const compression of ['lzw', 'packbits']) {
        for (const littleEndian of [true, false]) {
          const img = planes(67, 301, channels, depth, depth + channels);
          const bytes = await encodeTiff(img, { compression, littleEndian, dpi: 300 });
          const label = `${depth}-bit ${channels}ch ${compression} ${littleEndian ? 'II' : 'MM'}`;
          assert.ok(isTiff(bytes), label);
          assert.equal(bytes[0], littleEndian ? 0x49 : 0x4d);
          assert.deepEqual(tiffInfo(bytes), { width: 67, height: 301, bitDepth: depth, samples: channels, compression, littleEndian, float: false }, label);
          const back = await decodeTiff(bytes);
          assert.deepEqual([back.width, back.height, back.channels, back.depth, back.dpi, back.pages], [67, 301, channels, depth, 300, 1], label);
          assert.ok(back.data.length === img.data.length && back.data.every((v, i) => v === img.data[i]), `${label}: pixels`);
          if (compression === 'lzw' && depth === 8) assert.ok(bytes.length < img.data.byteLength * 0.5, `${label}: ${bytes.length} bytes of ${img.data.byteLength}`);
        }
      }
    }
  }
});

test('TIFF round trips: uncompressed, Deflate, no predictor, 32-bit float, several strips', async () => {
  for (const [depth, channels, opts] of [
    [8, 3, { compression: 'none' }], [16, 4, { compression: 'none', littleEndian: false }], [8, 4, { compression: 'deflate' }],
    [16, 3, { compression: 'deflate', littleEndian: false }], [16, 3, { compression: 'lzw', predictor: false }],
    [32, 3, { compression: 'lzw' }], [32, 4, { compression: 'deflate', littleEndian: false }], [32, 1, { compression: 'none' }],
  ]) {
    const img = planes(300, 220, channels, depth, 3);
    for (const codecs of [{}, nodeCodecs]) {
      const bytes = await encodeTiff(img, { ...opts, ...codecs });
      const back = await decodeTiff(bytes, codecs);
      const label = `${depth}-bit ${channels}ch ${JSON.stringify(opts)}`;
      assert.deepEqual([back.width, back.height, back.channels, back.depth, back.float], [300, 220, channels, depth, depth === 32], label);
      assert.ok(back.data.every((v, i) => v === img.data[i]), `${label}: pixels`);
    }
  }
  // 300 x 220 RGB at 16 bits is 396 KB: more than one 64 KB strip, each compressed on its own
  const big = await encodeTiff(planes(300, 220, 3, 16), { compression: 'none' });
  assert.ok(big.length > 300 * 220 * 6);
  await assert.rejects(() => encodeTiff({ width: 0, height: 1, channels: 3, depth: 8, data: new Uint8Array(0) }));
  await assert.rejects(() => encodeTiff(planes(2, 2, 3, 8), { compression: 'jpeg' }));
  await assert.rejects(() => decodeTiff(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /Not a TIFF/);
  assert.equal(isTiff(new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0])), true);
  assert.equal(isTiff(new Uint8Array([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8])), true);
  assert.equal(isTiff(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), false);
});

test('toRgba expands grey and RGB planes at their own depth', () => {
  const g = toRgba({ width: 2, height: 1, channels: 2, depth: 16, data: new Uint16Array([1000, 65535, 2000, 300]) });
  assert.deepEqual(Array.from(g.data), [1000, 1000, 1000, 65535, 2000, 2000, 2000, 300]);
  const c = toRgba({ width: 1, height: 1, channels: 3, depth: 32, data: new Float32Array([0.25, 1.5, 0]) });
  assert.deepEqual(Array.from(c.data), [0.25, 1.5, 0, 1]);
  const b = toRgba({ width: 1, height: 1, channels: 1, depth: 8, data: new Uint8ClampedArray([7]) });
  assert.deepEqual(Array.from(b.data), [7, 7, 7, 255]);
});

// Files written by other programs (ImageMagick 6 and Pillow), 20 x 18 pixels each.
const IM_BE_LZW_PRED_PLANAR_TILED = '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';
const IM_FLOAT_ZIP_PRED3 = 'SUkqAEYEAAB42qXVcUhbRxzA8fccWNj9lDS43KGriKwigrmWURhqQnBM1m0dU7bVlRnEwqDFllcZjBX/SOcfc2BmnVrB2pnpGsRmIu6fS7KyOOxgYxQcbamUwVlakP5RtBSpRd3uZ9KNJG/BXI/3ni/6x/m5d+8bw+P1mIYaO5d/h5l+yR7b6py/uK++sSbAWTOnvJRxSisZY7SYMqBOYEBcAEBgZxCSulc3lwDOTzS5AgGHIa0KaUkLD5+lhsAjJCwheoXtYEIkWu+U/TQ/bXC6yBkfpW7GJimlrJ9RQgeBAoyQtBmfnWMAe+s93gJdb/zK/va6qjNudthNOUNvOVMTFzHldaC3JHPG5L8RA3IudP9WYra6XVrvPUl5W9G7gN4IeodssFEhjgtR4V/vWY6FVzn9bQYn5YyOU0ZZkFLCBoASGM5c4eSSRwHMBo/XzHSZWeiMsWkYBepHfbzWOFjZzlljDU7KKStlLkoBvcXodWbOqM4uAhaQrm97LhjSl5BWwJHyWlZv6vkKPEI23hUhAuo46XxgzE0uczo/nfKO0hGcVHn70TuY7SWPANbU0eD1mka+3q3kr7uvHVrk5X5O66qYm1E3Vbu5BL0UaBF6HWkzJs0bBAqBdLzcfLRCtirvbDVin6B3KOVdQG/ExvtYbWYRla9NtSzy8TZOY2Fc5BncVMM4KSMsiN6BtBVOzr4BsAfg7v96zQx8lnfTiC96Jnip8h6sZGqRa5SXOtXLy1zqJSIMoNjG6yFwA7r8o4L6pKW80odeB3pDiO1NPV+7YeDzXUl8EYxN8FG/m81NoncavYPoHcFJlbffxnsV4CZ51ObxenO8vLm8W8Zft1/v5+wjFaty3FdVGCsHekvQq7pRlOlVN2cBwrDRdvvv1ZC0VpW3Fb3V6I2gdyjlXbDx9uE2f5w4MPSdg9MlFatx9IYxVgMYq2GMFSMQTFvh5P1TgMtkw5/bmyNWxpa5KZv04gyeY66v/tCLszACH4+9oRdncnXpebxlK2/pxRnOtrxfFtGLs+ib/fKVz/XiTJ7+meXdbZyNbbP+4bt6cYZLh7/5NagXZ8HkXOQHvTiTsd/z96birLxH1lv04gyxxgOfndKLszjuaP50WS/OJPqLvXcXcTYKzLbtD/XiDFbd9eojenEWAV9nQ4lenGEt7nn2fZRvnA3T7Cw8phdnKHy1c6lWL84iYfW+8KZenGHPXA5v7lipP3cX+/XiDDf4i8NFenEWAfn92916cYab/Hm8fS916MUZwu6pDx7qxVmE5M8/zurFGS5nePOIs7pc3PeJXpzhPG9yXdeLs0jIO2X39OIMe/P1/hdndbmy/4RenMk5fv/WjF6cRYVc72F6cQbTzru7OKsP8dpTenEmXbznwtd6cVbvr/PBO3pxhjW3d+f7SCPO6sO1Q2f04kw6ePPR03pxjko51RLQizPc5f8AA10w/wATAAABAwABAAAAFAAAAAEBAwABAAAAEgAAAAIBAwADAAAAMAUAAAMBAwABAAAACAAAAAYBAwABAAAAAgAAAAoBAwABAAAAAQAAABEBBAABAAAACAAAABIBAwABAAAAAQAAABUBAwABAAAAAwAAABYBAwABAAAAEgAAABcBBAABAAAAPQQAABwBAwABAAAAAQAAACkBAwACAAAAAAABAD0BAwABAAAAAwAAAD4BBQACAAAAhAUAAD8BBQAGAAAAVAUAAFMBAwADAAAANgUAAFQBCwADAAAAPAUAAFUBCwADAAAASAUAAAAAAAAgACAAIAADAAMAAwAAAAAAAAAAAAAAAAAAAIA/AACAPwAAgD+F61EAAACAAMP1qAAAAAACzcxMAAAAAAHNzEwAAACAAM3MTAAAAAACj8L1AAAAABA3GqAAAAAAAiuHCgAAACAA';
const PIL_BILEVEL_PACKBITS = 'SUkqAFAAAAACHHHAAhxxwAIcccAC444wAuOOMALjjjACHHHAAhxxwAIcccAC444wAuOOMALjjjACHHHAAhxxwAIcccAC444wAuOOMALjjjAJAAABAwABAAAAFAAAAAEBAwABAAAAEgAAAAIBAwABAAAAAQAAAAMBAwABAAAABYAAAAYBAwABAAAAAQAAABEBBAABAAAACAAAABYBAwABAAAAEgAAABcBBAABAAAASAAAABwBAwABAAAAAQAAAAAAAAA=';
const PIL_PALETTE_LZW = 'SUkqAFwAAACAACBQOCAGDQeEQSFACEQ0AwuCw6DxCBxKJxSGRaHxiNRuKR2MRmLSGOgKTSeUAOVSuWSiXAKWTEBy+UzKVzSTzabziYTqZzyfT+cUGeT2dUWgwEAKAAABAwABAAAAFAAAAAEBAwABAAAAEgAAAAIBAwABAAAACAAAAAMBAwABAAAABQAAAAYBAwABAAAAAwAAABEBBAABAAAACAAAABYBAwABAAAAEgAAABcBBAABAAAAVAAAABwBAwABAAAAAQAAAEABAwAAAwAA2gAAAAAAAAAA/wAAAAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const PIL_TGA_RLE = 'AAAKAAAAAAAAAAAAFAASABgAg8juAIPI7jyDyO54g8jutIPI7vCDyOAAg8jgPIPI4HiDyOC0g8jg8IPI0gCDyNI8g8jSeIPI0rSDyNLwg8jEAIPIxDyDyMR4g8jEtIPIxPCDyLYAg8i2PIPItniDyLa0g8i28IPIqACDyKg8g8ioeIPIqLSDyKjwg8iaAIPImjyDyJp4g8iatIPImvCDyIwAg8iMPIPIjHiDyIy0g8iM8IPIfgCDyH48g8h+eIPIfrSDyH7wg8hwAIPIcDyDyHB4g8hwtIPIcPCDyGIAg8hiPIPIYniDyGK0g8hi8IPIVACDyFQ8g8hUeIPIVLSDyFTwg8hGAIPIRjyDyEZ4g8hGtIPIRvCDyDgAg8g4PIPIOHiDyDi0g8g48IPIKgCDyCo8g8gqeIPIKrSDyCrwg8gcAIPIHDyDyBx4g8gctIPIHPCDyA4Ag8gOPIPIDniDyA60g8gO8IPIAACDyAA8g8gAeIPIALSDyADwAAAAAAAAAABUUlVFVklTSU9OLVhGSUxFLgA=';

test('reads TIFF files from other programs: big-endian planar tiles with the predictor, float with predictor 3, bilevel, palette', async () => {
  const want16 = (x, y, c) => (x * 3000 + y * 500 + c * 7000) % 65536;
  const a = await decodeTiff(b64(IM_BE_LZW_PRED_PLANAR_TILED));
  assert.deepEqual([a.width, a.height, a.channels, a.depth, a.littleEndian, a.compression], [20, 18, 3, 16, false, 'lzw']);
  for (let y = 0; y < 18; y++) for (let x = 0; x < 20; x++) for (let c = 0; c < 3; c++) assert.equal(a.data[(y * 20 + x) * 3 + c], want16(x, y, c), `tiled ${x},${y},${c}`);
  const f = await decodeTiff(b64(IM_FLOAT_ZIP_PRED3));
  assert.deepEqual([f.channels, f.depth, f.float, f.compression], [3, 32, true, 'deflate']);
  for (let y = 0; y < 18; y++) for (let x = 0; x < 20; x++) for (let c = 0; c < 3; c++) assert.ok(Math.abs(f.data[(y * 20 + x) * 3 + c] - want16(x, y, c) / 65535) < 1e-6, `float ${x},${y},${c}`);
  const bw = await decodeTiff(b64(PIL_BILEVEL_PACKBITS));
  assert.deepEqual([bw.channels, bw.depth, bw.bitDepth, bw.compression], [1, 8, 1, 'packbits']);
  for (let y = 0; y < 18; y++) for (let x = 0; x < 20; x++) assert.equal(bw.data[y * 20 + x], (Math.floor(x / 3) + Math.floor(y / 3)) % 2 ? 255 : 0, `bilevel ${x},${y}`);
  const p = await decodeTiff(b64(PIL_PALETTE_LZW));
  assert.deepEqual([p.channels, p.depth, p.photometric], [3, 8, 3]);
  const pal = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
  for (let y = 0; y < 18; y++) for (let x = 0; x < 20; x++) assert.deepEqual(Array.from(p.data.subarray((y * 20 + x) * 3, (y * 20 + x) * 3 + 3)), pal[(x < 10 ? 0 : 1) + (y < 9 ? 0 : 2)]);
});

// ---- TGA -------------------------------------------------------------------------------------

test('TGA round trips (raw and RLE, 24 and 32 bits) and a bottom-up RLE file from Pillow', () => {
  const w = 50, h = 20;
  const rnd = rng(6);
  const img = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  for (let i = 0; i < w * h; i++) img.data.set([i % w < 25 ? 200 : rnd() * 256, 10, i & 255, i % 7 ? 255 : 100], i * 4);
  for (const rle of [true, false]) {
    for (const alpha of [true, false, 'auto']) {
      const bytes = encodeTga(img, { rle, alpha });
      assert.ok(isTga(bytes));
      assert.deepEqual(tgaInfo(bytes), { width: w, height: h, bitsPerPixel: alpha === false ? 24 : 32, type: 2, rle });
      const back = decodeTga(bytes);
      assert.deepEqual([back.width, back.height, back.hasAlpha], [w, h, alpha !== false]);
      for (let i = 0; i < img.data.length; i++) assert.equal(back.data[i], alpha === false && i % 4 === 3 ? 255 : img.data[i], `sample ${i}`);
    }
  }
  // opaque images drop the alpha channel on 'auto', and long runs compress
  const flat = { width: 300, height: 10, data: new Uint8ClampedArray(12000).fill(255) };
  const packed = encodeTga(flat);
  assert.equal(tgaInfo(packed).bitsPerPixel, 24);
  assert.ok(packed.length < 300);
  assert.ok(decodeTga(packed).data.every((v) => v === 255));
  const pil = decodeTga(b64(PIL_TGA_RLE));
  assert.deepEqual([pil.width, pil.height, pil.rle, pil.bitsPerPixel], [20, 18, true, 24]);
  for (let y = 0; y < 18; y++) for (let x = 0; x < 20; x++) assert.deepEqual(Array.from(pil.data.subarray((y * 20 + x) * 4, (y * 20 + x) * 4 + 4)), [(x >> 2) * 60, y * 14, 200, 255], `pillow ${x},${y}`);
  // a hand-made colour-mapped file: two entries (BGR), 2 x 1 pixels, bottom-left origin; and 16-bit 5-5-5 pixels
  const mapped = new Uint8Array([0, 1, 1, 0, 0, 2, 0, 24, 0, 0, 0, 0, 2, 0, 1, 0, 8, 0, /* map */ 0, 0, 255, 255, 0, 0, /* pixels */ 1, 0]);
  assert.deepEqual(Array.from(decodeTga(mapped).data), [0, 0, 255, 255, 255, 0, 0, 255]);
  const hi = new Uint8Array([0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 16, 0x20, 0x00, 0x7c]); // 0x7c00 = red 31
  assert.deepEqual(Array.from(decodeTga(hi).data), [255, 0, 0, 255]);
  assert.equal(isTga(new Uint8Array(18)), false);
  assert.throws(() => decodeTga(new Uint8Array([1, 2, 3])));
});
