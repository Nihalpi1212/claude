import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLEND_MODES, CANVAS_BLEND, blendPixel, blendImages, separableLut, isBlendMode } from '../../src/shared/pixels/blend.js';
import { createImage, cloneImage, getPixel, setPixel, luminance, randomSeeded } from '../../src/shared/pixels/core.js';
import { rgbToHsv } from '../../src/shared/pixels/color.js';
import { solidImage, quadrantImage, assertPixel, assertNear } from './helpers.mjs';

const grey = (mode, s, b) => blendPixel(mode, s, s, s, b, b, b)[0];

test('separable modes match hand-computed values', () => {
  // [mode, source, backdrop, expected] — formulas on 0..255 values, rounded.
  const cases = [
    ['normal', 200, 100, 200],
    ['darken', 200, 100, 100], ['darken', 100, 200, 100],
    ['multiply', 200, 100, 78], // 200 * 100 / 255 = 78.4
    ['color-burn', 200, 100, 57], // 255 - (255 - 100) * 255 / 200 = 57.4
    ['color-burn', 100, 200, 115], // 255 - 55 * 255 / 100 = 114.75
    ['color-burn', 0, 100, 0], ['color-burn', 0, 255, 255],
    ['linear-burn', 200, 100, 45], ['linear-burn', 50, 50, 0],
    ['lighten', 200, 100, 200], ['lighten', 100, 200, 200],
    ['screen', 200, 100, 222], // 200 + 100 - 200 * 100 / 255 = 221.6
    ['screen', 0, 0, 0], ['screen', 255, 10, 255],
    ['color-dodge', 100, 100, 165], // 100 * 255 / (255 - 100) = 164.5
    ['color-dodge', 200, 100, 255], ['color-dodge', 255, 0, 0], ['color-dodge', 255, 1, 255],
    ['linear-dodge', 100, 100, 200], ['linear-dodge', 200, 100, 255],
    ['overlay', 200, 100, 157], // backdrop 100 <= 127.5 -> 2 * 100 * 200 / 255 = 156.9
    ['overlay', 100, 200, 188], // backdrop 200 > 127.5 -> screen(100, 145) = 100 + 145 - 100 * 145 / 255 = 188.1
    ['hard-light', 200, 100, 188], // source 200 > 127.5 -> screen(145, 100)
    ['hard-light', 100, 200, 157], // source 100 <= 127.5 -> 2 * 100 * 200 / 255
    ['hard-light', 127, 100, 100], // 2 * 127 * 100 / 255 = 99.6
    ['soft-light', 200, 100, 134], // b + (2s - 1)(sqrt(b) - b) in 0..1 = 0.5253
    ['soft-light', 50, 30, 14], // b - (1 - 2s) b (1 - b) = 0.0545
    ['soft-light', 128, 77, 77], // s = 0.502: barely lightens
    ['vivid-light', 200, 100, 232], // color-dodge(145, 100) = 100 * 255 / 110 = 231.8
    ['vivid-light', 100, 200, 185], // color-burn(200, 200) = 255 - 55 * 255 / 200 = 184.9
    ['linear-light', 200, 100, 245], ['linear-light', 100, 200, 145], ['linear-light', 0, 100, 0],
    ['pin-light', 200, 100, 145], // max(100, 145)
    ['pin-light', 100, 200, 200], // min(200, 200)
    ['pin-light', 20, 200, 40], // min(200, 40)
    ['hard-mix', 200, 100, 255], ['hard-mix', 100, 100, 0], ['hard-mix', 155, 100, 255], ['hard-mix', 154, 100, 0],
    ['difference', 200, 100, 100], ['difference', 100, 200, 100],
    ['exclusion', 200, 100, 143], // 300 - 2 * 200 * 100 / 255 = 143.1
    ['exclusion', 255, 255, 0], ['exclusion', 255, 0, 255],
    ['subtract', 200, 100, 0], ['subtract', 100, 200, 100],
    ['divide', 200, 100, 128], // 100 * 255 / 200 = 127.5
    ['divide', 100, 200, 255], ['divide', 0, 100, 255], ['divide', 0, 0, 0], ['divide', 255, 255, 255],
  ];
  for (const [mode, s, b, expected] of cases) assert.equal(grey(mode, s, b), expected, `${mode}(${s}, ${b})`);
  // Separable modes act per channel: a coloured pair gives the greyscale answers channel-wise.
  assert.deepEqual(blendPixel('multiply', 200, 100, 0, 100, 200, 255), [78, 78, 0]);
  assert.deepEqual(blendPixel('screen', 200, 100, 0, 100, 200, 255), [222, 222, 255]);
  assert.deepEqual(blendPixel('difference', 200, 100, 0, 100, 200, 255), [100, 100, 255]);
});

test('soft-light and the light modes follow the W3C / Photoshop formulas across the range', () => {
  const D = (b) => (b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b));
  const softLight = (s, b) => (s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * (D(b) - b));
  const burn = (s, b) => (b === 1 ? 1 : s === 0 ? 0 : 1 - Math.min(1, (1 - b) / s));
  const dodge = (s, b) => (b === 0 ? 0 : s === 1 ? 1 : Math.min(1, b / (1 - s)));
  const vivid = (s, b) => (s <= 0.5 ? burn(2 * s, b) : dodge(2 * s - 1, b));
  const hardLight = (s, b) => (s <= 0.5 ? 2 * s * b : b + (2 * s - 1) - b * (2 * s - 1));
  for (let s = 0; s <= 255; s += 15) {
    for (let b = 0; b <= 255; b += 15) {
      const S = s / 255, B = b / 255;
      assertNear(grey('soft-light', s, b), softLight(S, B) * 255, 0.51, `soft-light(${s}, ${b})`);
      assertNear(grey('vivid-light', s, b), vivid(S, B) * 255, 0.51, `vivid-light(${s}, ${b})`);
      assertNear(grey('hard-light', s, b), hardLight(S, B) * 255, 0.51, `hard-light(${s}, ${b})`);
      assertNear(grey('overlay', s, b), hardLight(B, S) * 255, 0.51, `overlay(${s}, ${b})`);
    }
  }
  // Soft light with a 50% grey source is the identity; hard light with 50% grey is too.
  for (const b of [0, 17, 100, 200, 255]) {
    assertNear(grey('soft-light', 127.5, b), b, 0.51);
    assertNear(grey('hard-light', 127.5, b), b, 0.51);
  }
});

test('non-separable modes: luminosity, color, hue, saturation, darker/lighter colour', () => {
  // Luminosity of grey 128 over red keeps red's hue and takes the grey's luma.
  const lum = blendPixel('luminosity', 128, 128, 128, 255, 0, 0);
  assert.deepEqual(lum, [255, 74, 74]);
  assertNear(rgbToHsv(...lum)[0], 0, 1e-9, 'hue stays red');
  assertNear(luminance(...lum), 128, 1);
  // Color: red over grey 128 is the same colour (red's hue + saturation, grey's luma).
  assert.deepEqual(blendPixel('color', 255, 0, 0, 128, 128, 128), [255, 74, 74]);
  // Hue: blue over red -> blue hue with red's saturation (full) and luma (76).
  const hue = blendPixel('hue', 0, 0, 255, 255, 0, 0);
  assert.deepEqual(hue, [53, 53, 255]);
  assertNear(rgbToHsv(...hue)[0], 240, 1e-9);
  assertNear(luminance(...hue), luminance(255, 0, 0), 1);
  // Hue of a grey source is undefined: the result is a grey with the backdrop's luma.
  assert.deepEqual(blendPixel('hue', 90, 90, 90, 255, 0, 0), [76, 76, 76]);
  // Saturation: a grey source desaturates the backdrop to its luma; a saturated source saturates it.
  assert.deepEqual(blendPixel('saturation', 128, 128, 128, 255, 0, 0), [76, 76, 76]);
  const sat = blendPixel('saturation', 255, 0, 0, 128, 64, 64);
  assert.equal(sat[0], 255);
  assert.equal(sat[1], sat[2]);
  assert.ok(sat[1] < 20, `saturated: ${sat}`);
  assertNear(luminance(...sat), luminance(128, 64, 64), 1);
  // SetLum clipping keeps every channel inside 0..255 for extreme pairs.
  for (const [s, b] of [[[255, 255, 0], [0, 0, 40]], [[0, 0, 0], [255, 255, 255]], [[255, 0, 255], [0, 255, 0]], [[1, 2, 3], [250, 10, 240]]]) {
    for (const mode of ['hue', 'saturation', 'color', 'luminosity']) {
      const out = blendPixel(mode, ...s, ...b);
      for (const v of out) assert.ok(Number.isInteger(v) && v >= 0 && v <= 255, `${mode} ${s} over ${b} -> ${out}`);
    }
    assertNear(luminance(...blendPixel('luminosity', ...s, ...b)), luminance(...s), 1.5, 'luminosity keeps source luma');
    assertNear(luminance(...blendPixel('color', ...s, ...b)), luminance(...b), 1.5, 'color keeps backdrop luma');
  }
  // Darker/lighter colour pick a whole colour by luma, never mix channels.
  assert.deepEqual(blendPixel('darker-color', 0, 0, 255, 255, 0, 0), [0, 0, 255]);
  assert.deepEqual(blendPixel('lighter-color', 0, 0, 255, 255, 0, 0), [255, 0, 0]);
  // luma(10, 250, 10) = 151 < 200: the green is the darker colour even though one channel is brighter.
  assert.deepEqual(blendPixel('darker-color', 10, 250, 10, 200, 200, 200), [10, 250, 10]);
  assert.deepEqual(blendPixel('lighter-color', 10, 250, 10, 200, 200, 200), [200, 200, 200]);
});

test('blendPixel: aliases, rounding, unknown modes', () => {
  assert.deepEqual(blendPixel('dissolve', 1, 2, 3, 200, 200, 200), [1, 2, 3]);
  assert.deepEqual(blendPixel('pass-through', 1, 2, 3, 200, 200, 200), [1, 2, 3]);
  assert.deepEqual(blendPixel('normal', 0.4, 1.5, 254.6, 0, 0, 0), [0, 2, 255]);
  assert.throws(() => blendPixel('nope', 0, 0, 0, 0, 0, 0), RangeError);
  assert.throws(() => blendImages('nope', createImage(1, 1), createImage(1, 1)), RangeError);
  assert.ok(isBlendMode('vivid-light') && isBlendMode('pass-through') && !isBlendMode('lighter'));
  assert.equal(separableLut('normal'), null);
  assert.equal(separableLut('hue'), null);
  const lut = separableLut('multiply');
  assert.equal(lut.length, 65536);
  assert.equal(lut[(200 << 8) | 100], 78);
  assert.equal(separableLut('multiply'), lut, 'cached');
});

test('blendImages alpha maths (straight alpha, source-over around the blend)', () => {
  // 50% opacity over an opaque backdrop: halfway between backdrop and source.
  let dst = solidImage(2, 2, [100, 100, 100, 1]);
  blendImages('normal', solidImage(2, 2, [200, 100, 50, 1]), dst, 0.5);
  assertPixel(getPixel(dst, 1, 1), [150, 100, 75, 1]);
  // Same through the source's own alpha instead of opacity.
  dst = solidImage(2, 2, [100, 100, 100, 1]);
  blendImages('normal', solidImage(2, 2, [200, 100, 50, 0.5]), dst, 1);
  assertPixel(getPixel(dst, 0, 0), [150, 100, 75, 1], 1);
  // Opacity multiplies the source alpha: 0.5 * 0.5.
  dst = solidImage(1, 1, [0, 0, 0, 1]);
  blendImages('normal', solidImage(1, 1, [255, 255, 255, 0.5]), dst, 0.5);
  assertPixel(getPixel(dst, 0, 0), [64, 64, 64, 1], 1);
  // A transparent source (with garbage RGB) leaves dst unchanged, opaque or not.
  for (const d of [[10, 20, 30, 1], [10, 20, 30, 0.4], [10, 20, 30, 0]]) {
    dst = solidImage(3, 1, d);
    const before = cloneImage(dst);
    blendImages('multiply', solidImage(3, 1, [255, 255, 255, 0]), dst, 1);
    assert.deepEqual(dst.data, before.data, `transparent src over ${d}`);
  }
  // Opacity 0 is a no-op too.
  dst = solidImage(1, 1, [10, 20, 30, 1]);
  blendImages('normal', solidImage(1, 1, [255, 255, 255, 1]), dst, 0);
  assertPixel(getPixel(dst, 0, 0), [10, 20, 30, 1], 0);
  // Source over a transparent dst gives the source (no black bleeding from dst's RGB).
  dst = solidImage(1, 1, [0, 0, 0, 0]);
  blendImages('normal', solidImage(1, 1, [200, 100, 50, 1]), dst, 1);
  assertPixel(getPixel(dst, 0, 0), [200, 100, 50, 1], 0);
  dst = solidImage(1, 1, [9, 9, 9, 0]);
  blendImages('multiply', solidImage(1, 1, [200, 100, 50, 0.5]), dst, 0.5);
  assertPixel(getPixel(dst, 0, 0), [200, 100, 50, 0.25], 1);
  // Semi-transparent over semi-transparent: ao = 0.75, colour = (0.5 Cs + 0.25 Cb) / 0.75.
  dst = solidImage(1, 1, [0, 0, 255, 0.5]);
  blendImages('normal', solidImage(1, 1, [255, 0, 0, 0.5]), dst, 1);
  assertPixel(getPixel(dst, 0, 0), [170, 0, 85, 0.75], 1);
  // The blend only applies where the backdrop has coverage: multiply at half source alpha over opaque grey.
  dst = solidImage(1, 1, [100, 100, 100, 1]);
  blendImages('multiply', solidImage(1, 1, [200, 200, 200, 0.5]), dst, 1);
  assertPixel(getPixel(dst, 0, 0), [89, 89, 89, 1], 1); // 100 + 0.5 * (78.4 - 100) = 89.2
  // ... and over a half-transparent backdrop the uncovered part shows the source colour.
  // sa = 1, da = 0.5: Co = 0.5 * Cs + 0.5 * B = 0.5 * 200 + 0.5 * 78.4 = 139.2, ao = 1.
  dst = solidImage(1, 1, [100, 100, 100, 0.5]);
  blendImages('multiply', solidImage(1, 1, [200, 200, 200, 1]), dst, 1);
  assertPixel(getPixel(dst, 0, 0), [139, 139, 139, 1], 1);
  // Opaque over opaque never changes alpha and equals blendPixel exactly.
  dst = solidImage(1, 1, [100, 200, 50, 1]);
  blendImages('luminosity', solidImage(1, 1, [128, 128, 128, 1]), dst, 1);
  assertPixel(getPixel(dst, 0, 0), [...blendPixel('luminosity', 128, 128, 128, 100, 200, 50), 1], 0);
});

test('blendImages agrees with blendPixel for every mode on opaque pixels', () => {
  const rnd = randomSeeded(7);
  const w = 16, h = 4;
  const src = createImage(w, h), dst0 = createImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    setPixel(src, x, y, [Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256), 1]);
    setPixel(dst0, x, y, [Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256), 1]);
  }
  setPixel(src, 0, 0, [0, 255, 128, 1]);
  setPixel(dst0, 0, 0, [255, 0, 128, 1]);
  for (const mode of BLEND_MODES) {
    if (mode === 'dissolve') continue;
    const dst = cloneImage(dst0);
    blendImages(mode, src, dst, 1);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const s = getPixel(src, x, y), b = getPixel(dst0, x, y);
      assertPixel(getPixel(dst, x, y), [...blendPixel(mode, s[0], s[1], s[2], b[0], b[1], b[2]), 1], 0, `${mode} at ${x},${y}`);
    }
  }
});

test('blendImages honours rect and never touches pixels outside it or the images', () => {
  const dst = quadrantImage(8);
  const before = cloneImage(dst);
  const src = solidImage(8, 8, [255, 255, 255, 1]);
  // A rect hanging off the top-left edge is clamped.
  blendImages('difference', src, dst, 1, { x: -5, y: -5, width: 7, height: 8 });
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const b = getPixel(before, x, y), a = getPixel(dst, x, y);
    if (x < 2 && y < 3) {
      if (b[3] === 0) assertPixel(a, [255, 255, 255, 1], 0, `transparent border at ${x},${y} takes the source`);
      else assertPixel(a, [255 - b[0], 255 - b[1], 255 - b[2], 1], 0, `inverted at ${x},${y}`);
    } else assertPixel(a, b, 0, `untouched at ${x},${y}`);
  }
  // A rect completely outside is a no-op, as is an empty one.
  const dst2 = cloneImage(before);
  blendImages('normal', src, dst2, 1, { x: 8, y: 0, width: 4, height: 4 });
  blendImages('normal', src, dst2, 1, { x: 1, y: 1, width: 0, height: 5 });
  assert.deepEqual(dst2.data, before.data);
  // Images of different sizes only touch the overlap (the contract says same size; be safe anyway).
  const small = solidImage(3, 2, [0, 0, 0, 1]);
  const big = solidImage(5, 5, [200, 200, 200, 1]);
  blendImages('normal', small, big, 1);
  assertPixel(getPixel(big, 2, 1), [0, 0, 0, 1], 0);
  assertPixel(getPixel(big, 3, 1), [200, 200, 200, 1], 0);
  assertPixel(getPixel(big, 2, 2), [200, 200, 200, 1], 0);
  const tiny = solidImage(2, 2, [200, 200, 200, 1]);
  blendImages('normal', big, tiny, 1, { x: 0, y: 0, width: 5, height: 5 });
  assertPixel(getPixel(tiny, 1, 1), [0, 0, 0, 1], 0);
  assert.equal(tiny.data.length, 16);
});

test('dissolve drops whole pixels proportionally to alpha, deterministically', () => {
  const w = 64, h = 64;
  const run = (alpha, opacity, seed, rect = null) => {
    const dst = solidImage(w, h, [255, 255, 255, 1]);
    blendImages('dissolve', solidImage(w, h, [255, 0, 0, alpha]), dst, opacity, rect, seed);
    return dst;
  };
  const count = (img) => {
    let red = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      const r = img.data[i], g = img.data[i + 1];
      assert.ok((r === 255 && g === 0) || (r === 255 && g === 255), 'kept pixels are fully opaque source, others untouched');
      assert.equal(img.data[i + 3], 255);
      if (g === 0) red++;
    }
    return red / (w * h);
  };
  assertNear(count(run(0.5, 1, 1)), 0.5, 0.05, 'half alpha keeps about half');
  assertNear(count(run(1, 0.25, 1)), 0.25, 0.05, 'opacity scales the probability');
  assertNear(count(run(0.8, 0.5, 3)), 0.4, 0.05, 'alpha and opacity multiply');
  assert.equal(count(run(1, 1, 1)), 1, 'fully opaque keeps everything');
  assert.equal(count(run(0, 1, 1)), 0, 'transparent keeps nothing');
  // Same seed -> same pattern; another seed -> another pattern.
  const a = run(0.5, 1, 11), b = run(0.5, 1, 11), c = run(0.5, 1, 12);
  assert.deepEqual(a.data, b.data);
  assert.notDeepEqual(a.data, c.data);
  // The pattern depends only on (seed, x, y): a partial repaint matches the full one inside its rect.
  const rect = { x: 13, y: 7, width: 20, height: 30 };
  const partial = run(0.5, 1, 11, rect);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const inside = x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
    assertPixel(getPixel(partial, x, y), inside ? getPixel(a, x, y) : [255, 255, 255, 1], 0, `dissolve at ${x},${y}`);
  }
  // Kept pixels land at full source alpha even over a transparent backdrop; dropped ones stay clear.
  const clear = createImage(w, h);
  blendImages('dissolve', solidImage(w, h, [0, 255, 0, 0.5]), clear, 1, null, 5);
  let kept = 0;
  for (let i = 0; i < clear.data.length; i += 4) {
    if (clear.data[i + 3] === 255) { kept++; assert.equal(clear.data[i + 1], 255); } else assert.equal(clear.data[i + 3], 0);
  }
  assertNear(kept / (w * h), 0.5, 0.05);
});

test('CANVAS_BLEND covers every mode with the Canvas 2D names', () => {
  for (const mode of BLEND_MODES) assert.ok(Object.prototype.hasOwnProperty.call(CANVAS_BLEND, mode), `CANVAS_BLEND lacks ${mode}`);
  assert.ok(Object.prototype.hasOwnProperty.call(CANVAS_BLEND, 'pass-through'));
  assert.equal(BLEND_MODES.length, 27);
  assert.equal(new Set(BLEND_MODES).size, 27);
  const expected = {
    normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten',
    'color-dodge': 'color-dodge', 'color-burn': 'color-burn', 'hard-light': 'hard-light', 'soft-light': 'soft-light',
    difference: 'difference', exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity',
    'pass-through': 'source-over',
  };
  for (const mode of Object.keys(CANVAS_BLEND)) {
    assert.equal(CANVAS_BLEND[mode], expected[mode] ?? null, `CANVAS_BLEND.${mode}`);
    assert.ok(isBlendMode(mode), `${mode} is accepted by blendPixel`);
  }
  assert.equal(Object.keys(CANVAS_BLEND).length, 28);
  assert.ok(Object.isFrozen(CANVAS_BLEND) && Object.isFrozen(BLEND_MODES));
});
