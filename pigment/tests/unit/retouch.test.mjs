import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dabMask, dodge, burn, sponge, blurDab, sharpenDab, smudge, heal, replaceColor } from '../../src/shared/pixels/retouch.js';
import { createImage, cloneImage, getPixel, setPixel, luminance, randomSeeded } from '../../src/shared/pixels/core.js';
import { rgbToHsl } from '../../src/shared/pixels/color.js';
import { blendPixel } from '../../src/shared/pixels/blend.js';
import { solidImage, assertPixel, assertNear } from './helpers.mjs';

const ones = (w, h) => new Float32Array(w * h).fill(1);
const lumaAt = (img, x, y) => {
  const p = getPixel(img, x, y);
  return luminance(p[0], p[1], p[2]);
};
const alphaBytes = (img) => img.data.filter((_, i) => i % 4 === 3);

/** Two vertical halves: columns < split get `left`, the rest `right`. */
function halves(w, h, left, right, split = w / 2) {
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(img, x, y, x < split ? left : right);
  return img;
}

/** Opaque RGB noise around `base` (+-amp), deterministic. */
function noiseImage(w, h, base, amp, seed = 7) {
  const rnd = randomSeeded(seed);
  const img = createImage(w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    for (let c = 0; c < 3; c++) img.data[i + c] = Math.round(base[c] + (rnd() * 2 - 1) * amp);
    img.data[i + 3] = 255;
  }
  return img;
}

function channelStats(img, rect, c) {
  let sum = 0, sum2 = 0, n = 0;
  for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
    const v = img.data[(y * img.width + x) * 4 + c];
    sum += v;
    sum2 += v * v;
    n++;
  }
  const mean = sum / n;
  return { mean, variance: sum2 / n - mean * mean };
}

test('dabMask: centre 1, corners 0, radial and symmetric', () => {
  const odd = dabMask(21, 21, 0);
  assert.equal(odd.length, 21 * 21);
  assert.equal(odd[10 * 21 + 10], 1, 'exact centre of an odd soft dab');
  for (const k of [0, 20, 20 * 21, 21 * 21 - 1]) assert.equal(odd[k], 0, `corner ${k}`);
  // monotone non-increasing from the centre along a row, and mirror-symmetric
  for (let x = 11; x < 21; x++) assert.ok(odd[10 * 21 + x] <= odd[10 * 21 + x - 1] + 1e-7);
  for (let x = 0; x < 21; x++) assertNear(odd[10 * 21 + x], odd[10 * 21 + 20 - x], 1e-6, `mirror ${x}`);
  for (let y = 0; y < 21; y++) assertNear(odd[y * 21 + 3], odd[3 * 21 + y], 1e-6, `transpose ${y}`);

  const even = dabMask(20, 20, 0.5);
  for (const [x, y] of [[9, 9], [10, 9], [9, 10], [10, 10]]) assert.equal(even[y * 20 + x], 1, `centre ${x},${y}`);
  for (const k of [0, 19, 19 * 20, 20 * 20 - 1]) assert.equal(even[k], 0);
  // hardness: inside the hard radius everything is 1, soft dabs fall off earlier
  const hard = dabMask(40, 40, 1), soft = dabMask(40, 40, 0);
  assert.equal(hard[20 * 40 + 35], 1, 'hard dab at 0.75 radius');
  assert.ok(soft[20 * 40 + 35] < 0.3, 'soft dab at 0.75 radius');
  assert.ok(hard.every((v) => v >= 0 && v <= 1));
  // ellipse fills a non-square rect; percent hardness accepted; degenerate sizes
  const ell = dabMask(30, 10, 50);
  assert.equal(ell[5 * 30 + 15], 1);
  assert.equal(ell[5 * 30 + 0] < 0.2, true);
  assert.deepEqual(Array.from(dabMask(1, 1, 0)), [1]);
  assert.equal(dabMask(0, 5).length, 0);
});

test('dodge brightens with exposure and range weighting, preserving hue', () => {
  const lo = solidImage(9, 9, [128, 128, 128, 1]), hi = solidImage(9, 9, [128, 128, 128, 1]);
  dodge(lo, null, null, { range: 'midtones', exposure: 0.2 });
  dodge(hi, null, null, { range: 'midtones', exposure: 0.6 });
  const l0 = 128, l1 = lumaAt(lo, 4, 4), l2 = lumaAt(hi, 4, 4);
  assert.ok(l1 > l0 + 10, `0.2 exposure lifts mid grey (${l1})`);
  assert.ok(l2 > l1 + 20, `more exposure lifts more (${l2} vs ${l1})`);
  assertPixel(getPixel(lo, 4, 4), [153, 153, 153, 1], 1, 'L + t (255 - L), t = 0.2 * 4l(1-l)');
  const p = getPixel(lo, 2, 7);
  assert.ok(p[0] === p[1] && p[1] === p[2], 'grey stays grey');

  // highlights barely touch near-black, shadows lift it a lot
  const dark = solidImage(4, 4, [6, 6, 6, 1]), darkS = cloneImage(dark);
  dodge(dark, null, null, { range: 'highlights', exposure: 0.5 });
  dodge(darkS, null, null, { range: 'shadows', exposure: 0.5 });
  assert.ok(lumaAt(dark, 1, 1) - 6 <= 3, `highlights on near-black: ${lumaAt(dark, 1, 1)}`);
  assert.ok(lumaAt(darkS, 1, 1) - 6 > 100, `shadows on near-black: ${lumaAt(darkS, 1, 1)}`);

  // hue preserved on a colour (including the clipped case)
  for (const c of [[180, 90, 40], [230, 30, 30], [40, 120, 200]]) {
    const img = solidImage(3, 3, [...c, 1]);
    dodge(img, null, null, { range: 'midtones', exposure: 0.8 });
    const q = getPixel(img, 1, 1);
    assert.ok(luminance(q[0], q[1], q[2]) > luminance(...c), 'brighter');
    const h0 = rgbToHsl(...c)[0], h1 = rgbToHsl(q[0], q[1], q[2])[0];
    assert.ok(Math.abs(h1 - h0) < 3, `hue ${h0} -> ${h1}`);
  }
});

test('burn darkens symmetrically to dodge', () => {
  const lo = solidImage(9, 9, [128, 128, 128, 1]), hi = solidImage(9, 9, [128, 128, 128, 1]);
  burn(lo, null, null, { range: 'midtones', exposure: 0.2 });
  burn(hi, null, null, { range: 'midtones', exposure: 0.6 });
  const l1 = lumaAt(lo, 4, 4), l2 = lumaAt(hi, 4, 4);
  assert.ok(l1 < 118 && l2 < l1 - 20, `${l1}, ${l2}`);
  assertPixel(getPixel(lo, 4, 4), [102, 102, 102, 1], 1, 'L (1 - t), t = 0.2 * 4l(1-l)');
  // mirror image of dodge: burning v equals 255 - dodging (255 - v) for greys
  for (const range of ['shadows', 'midtones', 'highlights']) {
    const a = solidImage(2, 2, [200, 200, 200, 1]), b = solidImage(2, 2, [55, 55, 55, 1]);
    burn(a, null, null, { range, exposure: 0.5 });
    dodge(b, null, null, { range: range === 'shadows' ? 'highlights' : range === 'highlights' ? 'shadows' : range, exposure: 0.5 });
    assert.ok(Math.abs(a.data[0] - (255 - b.data[0])) <= 1, `${range}: ${a.data[0]} vs ${255 - b.data[0]}`);
  }
  // shadows range barely touches near-white; hue preserved
  const white = solidImage(2, 2, [250, 250, 250, 1]);
  burn(white, null, null, { range: 'shadows', exposure: 0.5 });
  assert.ok(250 - white.data[0] <= 6, `shadows burn on near-white ${white.data[0]}`);
  const col = solidImage(2, 2, [200, 120, 60, 1]);
  burn(col, null, null, { range: 'highlights', exposure: 0.7 });
  const q = getPixel(col, 0, 0);
  assert.ok(luminance(q[0], q[1], q[2]) < luminance(200, 120, 60) - 20);
  assert.ok(Math.abs(rgbToHsl(q[0], q[1], q[2])[0] - rgbToHsl(200, 120, 60)[0]) < 3);
});

test('sponge changes saturation keeping luma', () => {
  const red = solidImage(5, 5, [255, 0, 0, 1]);
  sponge(red, null, null, { mode: 'desaturate', flow: 0.5 });
  const p = getPixel(red, 2, 2);
  assert.ok(rgbToHsl(p[0], p[1], p[2])[1] < 0.8, `saturation reduced: ${rgbToHsl(p[0], p[1], p[2])[1]}`);
  assertNear(luminance(p[0], p[1], p[2]), luminance(255, 0, 0), 2, 'luma');
  assert.ok(p[0] > p[1] && p[1] === p[2], 'still red');
  const full = solidImage(2, 2, [255, 0, 0, 1]);
  sponge(full, null, null, { mode: 'desaturate', flow: 1 });
  assertPixel(getPixel(full, 0, 0), [76, 76, 76, 1], 1, 'flow 1 -> grey of the same luma');

  const muted = solidImage(3, 3, [150, 110, 100, 1]);
  sponge(muted, null, null, { mode: 'saturate', flow: 0.8 });
  const q = getPixel(muted, 1, 1);
  assert.ok(rgbToHsl(q[0], q[1], q[2])[1] > rgbToHsl(150, 110, 100)[1] + 0.1, 'saturated');
  assertNear(luminance(q[0], q[1], q[2]), luminance(150, 110, 100), 2, 'luma kept');
  assert.ok(Math.abs(rgbToHsl(q[0], q[1], q[2])[0] - rgbToHsl(150, 110, 100)[0]) < 3, 'hue kept');
  // saturating stays in gamut: repeated dabs converge on the gamut edge with the same luma
  const vivid = solidImage(2, 2, [200, 100, 90, 1]);
  for (let n = 0; n < 10; n++) sponge(vivid, null, null, { mode: 'saturate', flow: 1 });
  const v = getPixel(vivid, 0, 0);
  assertNear(luminance(v[0], v[1], v[2]), luminance(200, 100, 90), 2);
  assert.ok(v[0] === 255 || Math.min(v[1], v[2]) === 0, `on the gamut edge: ${v}`);
  // greys have nothing to (de)saturate
  const grey = solidImage(2, 2, [90, 90, 90, 1]);
  sponge(grey, null, null, { mode: 'saturate', flow: 1 });
  assertPixel(getPixel(grey, 1, 1), [90, 90, 90, 1], 0);
});

test('blurDab softens an edge symmetrically from a snapshot and skips zero weights', () => {
  const img = halves(40, 12, [0, 0, 0, 1], [255, 255, 255, 1]);
  const dab = ones(40, 12);
  for (let k = 0; k < 4 * 40; k++) dab[k] = 0; // rows 0..3 have zero weight
  const before = cloneImage(img);
  blurDab(img, { x: 0, y: 0, width: 40, height: 12 }, dab, { strength: 1, radius: 2 });
  for (let y = 4; y < 12; y++) {
    const up = img.data[(y * 40 + 19) * 4], down = 255 - img.data[(y * 40 + 20) * 4];
    assert.ok(up > 40, `dark side lifted at row ${y}: ${up}`);
    assert.ok(Math.abs(up - down) <= 1, `symmetric: +${up} vs -${down}`);
    // box radius 2 from a snapshot: x=19 averages 2 white of 5 -> 102, x=18 averages 1 -> 51
    assertNear(up, 102, 1);
    assertNear(img.data[(y * 40 + 18) * 4], 51, 1, 'no feedback smearing');
    assert.equal(img.data[(y * 40 + 10) * 4], 0, 'flat areas unchanged');
    assert.equal(img.data[(y * 40 + 30) * 4], 255);
  }
  for (let i = 0; i < 4 * 40 * 4; i++) assert.equal(img.data[i], before.data[i], 'zero-weight rows untouched');

  // strength scales the move; transparent neighbours do not bleed black into colour
  const half = halves(20, 6, [255, 0, 0, 1], [255, 255, 255, 1]);
  blurDab(half, null, null, { strength: 0.5, radius: 2 });
  assertNear(half.data[(3 * 20 + 9) * 4 + 1], 51, 1, 'half way toward the box mean');
  const edge = halves(20, 6, [255, 0, 0, 1], [0, 0, 0, 0]);
  blurDab(edge, null, null, { strength: 1, radius: 3 });
  assertPixel(getPixel(edge, 9, 3), [255, 0, 0, 1], 0, 'premultiplied mean keeps the edge red');
  assertPixel(getPixel(edge, 12, 3), [0, 0, 0, 0], 0, 'transparent pixels untouched');
});

test('sharpenDab increases edge contrast and leaves flat areas alone', () => {
  const img = halves(20, 8, [64, 64, 64, 1], [192, 192, 192, 1]);
  sharpenDab(img, null, null, { strength: 1 });
  for (let y = 0; y < 8; y++) {
    const a = img.data[(y * 20 + 9) * 4], b = img.data[(y * 20 + 10) * 4];
    assert.ok(a < 64 && b > 192, `edge row ${y}: ${a} / ${b}`);
    assertNear(64 - a, b - 192, 1, 'symmetric');
    assertNear(a, 64 - 128 / 3, 1, 'c + (c - box3x3)');
    assert.equal(img.data[(y * 20 + 3) * 4], 64);
    assert.equal(img.data[(y * 20 + 16) * 4], 192);
  }
  // a weaker dab moves less, weighted by the mask
  const soft = halves(20, 8, [64, 64, 64, 1], [192, 192, 192, 1]);
  const dab = dabMask(20, 8, 0);
  sharpenDab(soft, null, dab, { strength: 1 });
  const centre = 64 - soft.data[(4 * 20 + 9) * 4], rim = 64 - soft.data[(0 * 20 + 9) * 4];
  assert.ok(centre > 0 && centre < 64 - (64 - 128 / 3) + 1, `centre ${centre}`);
  assert.ok(rim < centre, `rim moves less than the centre: ${rim} vs ${centre}`);
});

test('smudge drags red into blue and the carried buffer picks up blue', () => {
  const img = halves(40, 10, [255, 0, 0, 1], [0, 0, 255, 1]);
  const dab = ones(10, 10);
  const before = cloneImage(img);
  let carried = smudge(img, { x: 2, y: 0, width: 10, height: 10 }, dab, null, { strength: 0.8 });
  assert.deepEqual(img.data, before.data, 'picking up does not paint');
  assert.equal(carried.width, 10);
  assertPixel(getPixel(carried, 5, 5), [255, 0, 0, 1], 0, 'picked up red');

  const rect = { x: 26, y: 0, width: 10, height: 10 };
  const same = smudge(img, rect, dab, carried, { strength: 0.8 });
  assert.equal(same, carried, 'carried updated in place');
  const p = getPixel(img, 31, 5);
  assert.ok(p[0] > 150 && p[0] > p[2], `red-ish pixel in the blue area: ${p}`);
  assertPixel(p, [204, 0, 51, 1], 1, 'mix(blue, red, 0.8)');
  const k = getPixel(carried, 5, 5);
  assert.ok(k[2] > 0 && k[0] < 255, `carried turns bluish: ${k}`);
  assertPixel(k, [204, 0, 51, 1], 1, 'mix(red, blue, 1 - 0.8)');
  assert.deepEqual(alphaBytes(img), alphaBytes(before));
  // a moving stroke: the smear fades as the finger travels through the blue
  const wide = halves(90, 10, [255, 0, 0, 1], [0, 0, 255, 1], 20);
  let c = null, prevBlue = -1;
  for (let x = 8; x <= 70; x += 3) {
    c = smudge(wide, { x, y: 0, width: 10, height: 10 }, dab, c, { strength: 0.8 });
    const b = getPixel(c, 5, 5)[2];
    assert.ok(b >= prevBlue, 'carried only gets bluer');
    prevBlue = b;
  }
  const k2 = getPixel(c, 5, 5);
  assert.ok(k2[2] > 3 * k2[0], `after the stroke carried is mostly blue: ${k2}`);
  assert.ok(getPixel(wide, 25, 5)[0] > 150, 'red dragged just past the boundary');

  // transparent pixels picked up add no black and paint nothing
  const t = halves(20, 4, [0, 0, 0, 0], [0, 200, 0, 1]);
  let c2 = smudge(t, { x: 0, y: 0, width: 6, height: 4 }, null, null, { strength: 0.5 });
  smudge(t, { x: 12, y: 0, width: 6, height: 4 }, null, c2, { strength: 0.5 });
  assertPixel(getPixel(t, 14, 2), [0, 200, 0, 1], 0, 'transparent carried does not paint');
  assertPixel(getPixel(c2, 2, 2), [0, 200, 0, 0.5], 1, 'carried colour is the green it picked up');
  // the rect may leave the image: outside parts are transparent in the carried buffer
  const c3 = smudge(t, { x: -3, y: -1, width: 6, height: 4 }, null, null, {});
  assert.equal(c3.data[3], 0);
  assert.equal(c3.width, 6);
});

test('heal copies source texture with destination colour', () => {
  const dest = solidImage(48, 48, [128, 128, 128, 1]);
  const rect = { x: 8, y: 8, width: 32, height: 32 };
  const source = noiseImage(32, 32, [90, 90, 90], 40);
  const srcStats = channelStats(source, { x: 0, y: 0, width: 32, height: 32 }, 0);
  const before = cloneImage(dest);
  heal(dest, rect, ones(32, 32), source);
  for (let c = 0; c < 3; c++) {
    const st = channelStats(dest, rect, c);
    assertNear(st.mean, 128, 2, `channel ${c} mean stays the destination's`);
    assert.ok(st.variance > 0.6 * srcStats.variance, `texture copied: ${st.variance} vs ${srcStats.variance}`);
  }
  assert.equal(dest.data[(4 * 48 + 4) * 4], 128, 'outside the rect untouched');
  assert.equal(dest.data[(44 * 48 + 20) * 4], 128);
  assert.deepEqual(alphaBytes(dest), alphaBytes(before));

  // colour matched on a coloured destination, texture amplitude follows the dab
  const red = solidImage(40, 40, [200, 60, 50, 1]);
  const r2 = { x: 4, y: 4, width: 32, height: 32 };
  heal(red, r2, ones(32, 32), source);
  const rs = [0, 1, 2].map((c) => channelStats(red, r2, c));
  assertNear(rs[0].mean, 200, 2);
  assertNear(rs[1].mean, 60, 2);
  assertNear(rs[2].mean, 50, 2);
  const flatSrc = solidImage(32, 32, [10, 240, 10, 1]);
  const keep = solidImage(40, 40, [200, 60, 50, 1]);
  heal(keep, r2, dabMask(32, 32, 0.3), flatSrc);
  assert.deepEqual(keep.data, solidImage(40, 40, [200, 60, 50, 1]).data, 'flat source adds nothing, whatever its colour');
});

test('replaceColor swaps colour within tolerance, keeps luma and far colours', () => {
  const img = halves(10, 4, [255, 0, 0, 1], [0, 0, 255, 1]);
  setPixel(img, 1, 1, [230, 20, 10, 1]);
  replaceColor(img, null, null, { color: '#00ff00', tolerance: 40, sampleColor: [255, 0, 0, 1], mode: 'color' });
  const p = getPixel(img, 2, 2);
  assert.ok(p[1] > 100 && p[0] < 10 && p[2] < 10, `red became green: ${p}`);
  assertNear(luminance(p[0], p[1], p[2]), luminance(255, 0, 0), 2, 'luma kept');
  const q = getPixel(img, 1, 1);
  assert.ok(q[1] > q[0], 'near-red within tolerance changes too');
  assertNear(luminance(q[0], q[1], q[2]), luminance(230, 20, 10), 2);
  assertPixel(getPixel(img, 7, 2), [0, 0, 255, 1], 0, 'blue is far: unchanged');

  // modes
  const dark = solidImage(2, 2, [128, 0, 0, 1]);
  replaceColor(dark, null, null, { color: [0, 255, 0, 1], tolerance: 10, mode: 'hue' });
  const d = getPixel(dark, 0, 0);
  assert.ok(d[1] > d[0] && d[1] > d[2], `hue mode turns it green: ${d}`);
  assertNear(luminance(d[0], d[1], d[2]), luminance(128, 0, 0), 2);
  const sat = solidImage(2, 2, [255, 0, 0, 1]);
  replaceColor(sat, null, null, { color: '#808080', tolerance: 10, mode: 'saturation' });
  const s = getPixel(sat, 0, 0);
  assert.ok(s[0] === s[1] && s[1] === s[2], `saturation from grey -> grey: ${s}`);
  const lum = solidImage(2, 2, [255, 0, 0, 1]);
  replaceColor(lum, null, null, { color: '#a0a0a0', tolerance: 10, mode: 'luminosity' });
  const l = getPixel(lum, 0, 0);
  assertNear(luminance(l[0], l[1], l[2]), 160, 2, 'luminosity mode takes the colour\'s luma');
  assert.ok(l[0] > l[1] && l[1] === l[2], `still red: ${l}`);

  // default sample = the pixel under the dab centre; dab weight scales the change
  const two = halves(10, 4, [255, 0, 0, 1], [0, 0, 255, 1]);
  replaceColor(two, { x: 5, y: 0, width: 5, height: 4 }, null, { color: '#ffff00', tolerance: 5 });
  assert.ok(getPixel(two, 7, 2)[0] > 0, 'blue under the centre got sampled and replaced');
  assertPixel(getPixel(two, 2, 2), [255, 0, 0, 1], 0, 'outside the rect unchanged');
  const halfW = solidImage(2, 2, [255, 0, 0, 1]);
  replaceColor(halfW, null, new Float32Array([0.5, 0.5, 0.5, 0.5]), { color: '#00ff00', tolerance: 10 });
  assertPixel(getPixel(halfW, 0, 0), [128, 65, 0, 1], 1, 'half weight = half way to (0,130,0)');
});

test('an all-zero dab changes nothing, and alpha is never touched', () => {
  const base = noiseImage(16, 16, [150, 100, 80], 60, 11);
  for (let i = 3; i < base.data.length; i += 16) base.data[i] = 100; // some partial alpha
  for (let x = 0; x < 16; x++) base.data[x * 4 + 3] = 0; // and a transparent row
  const zero = new Float32Array(16 * 16);
  const src = noiseImage(16, 16, [120, 120, 120], 50);
  const ops = [
    (img, dab) => dodge(img, null, dab, { range: 'midtones', exposure: 1 }),
    (img, dab) => burn(img, null, dab, { range: 'shadows', exposure: 1 }),
    (img, dab) => sponge(img, null, dab, { mode: 'desaturate', flow: 1 }),
    (img, dab) => sponge(img, null, dab, { mode: 'saturate', flow: 1 }),
    (img, dab) => blurDab(img, null, dab, { strength: 1 }),
    (img, dab) => sharpenDab(img, null, dab, { strength: 1 }),
    (img, dab) => heal(img, null, dab, src),
    (img, dab) => replaceColor(img, null, dab, { color: '#00ff00', tolerance: 255, sampleColor: '#ff0000', mode: 'color' }),
    (img, dab) => {
      const carried = smudge(img, { x: 0, y: 0, width: 16, height: 16 }, dab, null, {});
      const k = cloneImage(carried);
      // move the carried pixels one quadrant over so a real dab would paint something
      const shifted = createImage(16, 16);
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) setPixel(shifted, x, y, getPixel(k, (x + 8) % 16, y));
      smudge(img, { x: 0, y: 0, width: 16, height: 16 }, dab, shifted, { strength: 1 });
    },
  ];
  ops.forEach((op, n) => {
    const a = cloneImage(base);
    op(a, zero);
    assert.deepEqual(a.data, base.data, `op ${n} with an all-zero dab`);
    const b = cloneImage(base);
    op(b, null);
    assert.deepEqual(alphaBytes(b), alphaBytes(base), `op ${n} keeps alpha`);
    assert.notDeepEqual(b.data, base.data, `op ${n} does something with a full dab`);
  });
});

test('rects are clamped to the image and the dab is indexed from the rect origin', () => {
  const img = solidImage(10, 10, [128, 128, 128, 1]);
  const dab = new Float32Array(8 * 8);
  dab[3 * 8 + 4] = 1; // dab pixel (4, 3) -> image pixel (-4 + 4, -2 + 3) = (0, 1)
  dab[0] = 1; // (-4, -2): outside, ignored
  dodge(img, { x: -4, y: -2, width: 8, height: 8 }, dab, { exposure: 1 });
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
    const v = img.data[(y * 10 + x) * 4];
    if (x === 0 && y === 1) assert.ok(v > 200, 'the one weighted pixel inside the image');
    else assert.equal(v, 128, `${x},${y}`);
  }
  // completely outside: no-op; alpha ImageData dab masks work too
  const before = cloneImage(img);
  burn(img, { x: 20, y: 20, width: 5, height: 5 }, null, { exposure: 1 });
  blurDab(img, { x: -9, y: 0, width: 9, height: 10 }, null, { strength: 1 });
  assert.deepEqual(img.data, before.data);
  const alphaDab = createImage(4, 4);
  alphaDab.data[(1 * 4 + 2) * 4 + 3] = 255; // (2, 1)
  const img2 = solidImage(10, 10, [128, 128, 128, 1]);
  burn(img2, { x: 6, y: 6, width: 4, height: 4 }, alphaDab, { exposure: 1 });
  assert.ok(img2.data[(7 * 10 + 8) * 4] < 20);
  assert.equal(img2.data[(7 * 10 + 7) * 4], 128);
  // dabs that run past the right/bottom edges stay inside
  const img3 = solidImage(10, 10, [128, 128, 128, 1]);
  sharpenDab(img3, { x: 7, y: 7, width: 6, height: 6 }, null, { strength: 1 });
  heal(img3, { x: 7, y: 7, width: 6, height: 6 }, null, noiseImage(6, 6, [128, 128, 128], 30));
  assert.equal(img3.data.length, 400);
  assert.equal(img3.data[(6 * 10 + 6) * 4], 128);
});

test('200 px dabs are fast enough for interactive strokes', () => {
  const img = noiseImage(1024, 1024, [128, 128, 128], 60);
  const dab = dabMask(200, 200, 0.5);
  const rect = { x: 400, y: 400, width: 200, height: 200 };
  const src = noiseImage(200, 200, [100, 100, 100], 40, 3);
  let carried = null;
  const ops = {
    dodge: () => dodge(img, rect, dab, { exposure: 0.1 }),
    burn: () => burn(img, rect, dab, { exposure: 0.1 }),
    sponge: () => sponge(img, rect, dab, { flow: 0.1, mode: 'saturate' }),
    blur: () => blurDab(img, rect, dab, { strength: 0.3 }),
    sharpen: () => sharpenDab(img, rect, dab, { strength: 0.3 }),
    smudge: () => { carried = smudge(img, rect, dab, carried, { strength: 0.5 }); },
    heal: () => heal(img, rect, dab, src),
    replace: () => replaceColor(img, rect, dab, { color: '#00ff00', tolerance: 60, sampleColor: '#808080' }),
  };
  for (const [name, fn] of Object.entries(ops)) {
    fn();
    const n = 10, t0 = performance.now();
    for (let k = 0; k < n; k++) fn();
    const ms = (performance.now() - t0) / n;
    assert.ok(ms < 16, `${name}: ${ms.toFixed(2)} ms per 200 px dab`);
  }
});

// ---- regression tests from the adversarial review -------------------------------------------

test('dabMask: the centre weighs 1 for even and tiny sizes at any hardness', () => {
  for (const hd of [0, 0.5, 1]) {
    for (const n of [2, 4, 20, 64]) {
      const m = dabMask(n, n, hd), c = n / 2;
      for (const [x, y] of [[c - 1, c - 1], [c, c - 1], [c - 1, c], [c, c]]) assert.equal(m[y * n + x], 1, `${n}px hardness ${hd} centre ${x},${y}`);
      if (n >= 4) for (const k of [0, n - 1, n * (n - 1), n * n - 1]) assert.equal(m[k], 0, `${n}px corner`);
    }
  }
  // a 2 px brush covers its four pixels fully instead of 21 %, hard or soft; 2x1 and 1x2 too
  assert.deepEqual(Array.from(dabMask(2, 2, 1)), [1, 1, 1, 1]);
  assert.deepEqual(Array.from(dabMask(2, 2, 0)), [1, 1, 1, 1]);
  assert.deepEqual(Array.from(dabMask(2, 1, 0)), [1, 1]);
  assert.deepEqual(Array.from(dabMask(1, 2, 0)), [1, 1]);
  // the soft falloff is still a falloff
  const soft = dabMask(4, 4, 0);
  assert.ok(soft[1] > 0 && soft[1] < 0.5, `4px soft edge ${soft[1]}`);
});

test('heal leaves pixels alone where the source is transparent or missing', () => {
  const textured = () => noiseImage(16, 16, [120, 140, 160], 50, 5);
  // fully transparent source (e.g. a sample taken off the canvas): no change at all, not a blur
  const a = textured(), a0 = cloneImage(a);
  heal(a, null, null, createImage(16, 16));
  assert.deepEqual(a.data, a0.data, 'transparent source');
  // a source smaller than the rect only heals the part it covers
  const b = textured(), b0 = cloneImage(b);
  heal(b, null, null, solidImage(8, 6, [10, 10, 10, 1]));
  let changedInside = 0;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const i = (y * 16 + x) * 4;
    const same = b.data[i] === b0.data[i] && b.data[i + 1] === b0.data[i + 1] && b.data[i + 2] === b0.data[i + 2];
    if (x >= 8 || y >= 6) assert.ok(same, `uncovered pixel ${x},${y} changed`);
    else if (!same) changedInside++;
  }
  assert.ok(changedInside > 30, `covered part is healed (${changedInside})`);
  // half-transparent source heals half way
  const flat = () => solidImage(20, 20, [100, 100, 100, 1]);
  const src = noiseImage(20, 20, [90, 90, 90], 60, 9);
  const half = cloneImage(src);
  for (let i = 3; i < half.data.length; i += 4) half.data[i] = 128;
  const full = flat(), part = flat();
  heal(full, null, null, src);
  heal(part, null, null, half);
  for (let i = 0; i < full.data.length; i += 4) {
    assertNear(part.data[i] - 100, ((full.data[i] - 100) * 128) / 255, 1, `pixel ${i / 4}`);
  }
});

test('heal source pixel (i, j) lands on image pixel (rect.x + i, rect.y + j), also when clipped', () => {
  const img = solidImage(12, 12, [100, 100, 100, 1]);
  const src = solidImage(10, 10, [50, 50, 50, 1]);
  setPixel(src, 5, 4, [250, 250, 250, 1]); // one bright texel
  heal(img, { x: -3, y: -2, width: 10, height: 10 }, null, src, { radius: 2 });
  let best = [-1, -1, -1];
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) if (img.data[(y * 12 + x) * 4] > best[0]) best = [img.data[(y * 12 + x) * 4], x, y];
  assert.deepEqual(best.slice(1), [2, 2], 'texel at (-3 + 5, -2 + 4)');
  assert.ok(best[0] > 250, `the texel's contrast over its blur is added: ${best[0]}`);
  assert.equal(img.data[(11 * 12 + 11) * 4], 100, 'outside the rect untouched');
});

test('smudge keeps the carried colour at full precision so long smears fade out', () => {
  const W = 400, img = halves(W, 10, [255, 0, 0, 1], [0, 0, 255, 1], 20);
  const dab = dabMask(10, 10, 0.5);
  let c = null;
  for (let x = 8; x <= 380; x++) c = smudge(img, { x, y: 0, width: 10, height: 10 }, dab, c, { strength: 0.8 });
  // 8-bit rounding of the carried buffer on every dab left (10, 0, 245) carried and painted (20, 0, 235) here
  assertPixel(getPixel(c, 5, 5), [0, 0, 255, 1], 1, 'carried converged on blue');
  assertPixel(getPixel(img, 370, 5), [0, 0, 255, 1], 1, 'no endless red tint along the stroke');
  assert.ok(getPixel(img, 30, 5)[0] > 100, 'red is still dragged into the blue near the boundary');

  // the bytes stay the rounded state, and bytes the caller rewrites are honoured
  const t = solidImage(10, 4, [0, 0, 255, 1]);
  const k = smudge(t, { x: 0, y: 0, width: 4, height: 4 }, null, null);
  smudge(t, { x: 4, y: 0, width: 4, height: 4 }, null, k, { strength: 0.5 });
  for (let i = 0; i < k.data.length; i += 4) k.data.set([0, 255, 0, 255], i); // finger-paint green
  smudge(t, { x: 6, y: 0, width: 4, height: 4 }, null, k, { strength: 1 });
  assertPixel(getPixel(t, 8, 2), [0, 255, 0, 1], 0, 'rewritten carried bytes paint');
});

/** Brute-force premultiplied box mean over the window clipped to [bx0, bx1) x [by0, by1). */
function naiveMean(img, x, y, r, bx0, bx1, by0, by1) {
  let sr = 0, sg = 0, sb = 0, sa = 0;
  for (let yy = Math.max(by0, y - r); yy <= Math.min(by1 - 1, y + r); yy++)
    for (let xx = Math.max(bx0, x - r); xx <= Math.min(bx1 - 1, x + r); xx++) {
      const i = (yy * img.width + xx) * 4, a = img.data[i + 3];
      sr += img.data[i] * a;
      sg += img.data[i + 1] * a;
      sb += img.data[i + 2] * a;
      sa += a;
    }
  return sa > 0 ? [sr / sa, sg / sa, sb / sa] : null;
}

function randomCase(rnd, n) {
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const W = ri(1, 21), H = ri(1, 21);
  const img = createImage(W, H);
  for (let i = 0; i < img.data.length; i++) img.data[i] = (i & 3) !== 3 ? ri(0, 255) : n % 3 === 0 ? 255 : rnd() < 0.3 ? 0 : ri(1, 255);
  const rect = { x: ri(-7, W), y: ri(-7, H), width: ri(1, 18), height: ri(1, 18) };
  const dab = new Float32Array(rect.width * rect.height).map(() => (rnd() < 0.2 ? 0 : rnd() * 1.2));
  return { W, H, img, rect, dab, ri };
}

test('blurDab / sharpenDab / heal match a brute-force reference on clipped rects, odd sizes and alpha', () => {
  const rnd = randomSeeded(2024);
  for (let n = 0; n < 150; n++) {
    const { W, H, img, rect, dab, ri } = randomCase(rnd, n);
    const rad = ri(1, 5), s = rnd();
    const x0 = Math.max(0, rect.x), y0 = Math.max(0, rect.y), x1 = Math.min(W, rect.x + rect.width), y1 = Math.min(H, rect.y + rect.height);
    const weight = (x, y) => Math.min(1, dab[(y - rect.y) * rect.width + (x - rect.x)]);
    const win = [Math.max(0, x0 - rad), Math.min(W, x1 + rad), Math.max(0, y0 - rad), Math.min(H, y1 + rad)];
    for (const sharpen of [false, true]) {
      const got = cloneImage(img), want = cloneImage(img);
      (sharpen ? sharpenDab : blurDab)(got, rect, dab, { strength: s, radius: rad });
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * W + x) * 4, m = weight(x, y);
        if (!(m > 0) || img.data[i + 3] === 0) continue;
        const mean = naiveMean(img, x, y, rad, ...win);
        for (let c = 0; c < 3; c++) want.data[i + c] = img.data[i + c] + (sharpen ? img.data[i + c] - mean[c] : mean[c] - img.data[i + c]) * s * m;
      }
      for (let i = 0; i < got.data.length; i++) assert.ok(Math.abs(got.data[i] - want.data[i]) <= 1, `${sharpen ? 'sharpen' : 'blur'} case ${n} byte ${i}: ${got.data[i]} vs ${want.data[i]}`);
    }
    // heal with a source that may be smaller or larger than the rect and partly transparent
    const src = createImage(Math.max(1, rect.width + ri(-3, 3)), Math.max(1, rect.height + ri(-3, 3)));
    for (let i = 0; i < src.data.length; i++) src.data[i] = (i & 3) !== 3 ? ri(0, 255) : rnd() < 0.25 ? 0 : ri(1, 255);
    const got = cloneImage(img), want = cloneImage(img);
    heal(got, rect, dab, src, { radius: rad, strength: s });
    const ox = x0 - rect.x, oy = y0 - rect.y;
    const sw = Math.min(x1 - x0, src.width - ox), sh = Math.min(y1 - y0, src.height - oy);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const sx = x - rect.x, sy = y - rect.y;
      if (sx - ox >= sw || sy - oy >= sh) continue;
      const i = (y * W + x) * 4, si = (sy * src.width + sx) * 4;
      const m = weight(x, y) * s * (src.data[si + 3] / 255);
      if (!(m > 0) || img.data[i + 3] === 0) continue;
      const dm = naiveMean(img, x, y, rad, ...win);
      const sm = naiveMean(src, sx, sy, rad, Math.max(0, ox - rad), Math.min(src.width, ox + sw + rad), Math.max(0, oy - rad), Math.min(src.height, oy + sh + rad));
      for (let c = 0; c < 3; c++) want.data[i + c] = img.data[i + c] + (dm[c] + src.data[si + c] - sm[c] - img.data[i + c]) * m;
    }
    for (let i = 0; i < got.data.length; i++) assert.ok(Math.abs(got.data[i] - want.data[i]) <= 1, `heal case ${n} byte ${i}: ${got.data[i]} vs ${want.data[i]}`);
  }
});

test('per-pixel ops index the dab from the rect origin and clip exactly (Float32 and alpha-image dabs)', () => {
  const ops = [
    (im, r, d) => dodge(im, r, d, { range: 'shadows', exposure: 0.7 }),
    (im, r, d) => burn(im, r, d, { range: 'highlights', exposure: 0.9 }),
    (im, r, d) => sponge(im, r, d, { mode: 'saturate', flow: 0.6 }),
    (im, r, d) => sponge(im, r, d, { mode: 'desaturate', flow: 0.6 }),
    (im, r, d) => replaceColor(im, r, d, { color: '#3a9f20', sampleColor: [128, 128, 128, 1], tolerance: 90, mode: 'hue', strength: 0.8 }),
  ];
  const rnd = randomSeeded(31);
  for (let n = 0; n < 120; n++) {
    const { W, H, img, rect, dab: fl } = randomCase(rnd, n);
    let dab = fl;
    if (n % 2) {
      dab = createImage(rect.width, rect.height);
      for (let k = 0; k < fl.length; k++) fl[k] = (dab.data[k * 4 + 3] = Math.round(Math.min(1, fl[k]) * 255)) / 255;
    }
    ops.forEach((op, o) => {
      const got = cloneImage(img), want = cloneImage(img);
      op(got, rect, dab);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const dx = x - rect.x, dy = y - rect.y;
        if (dx < 0 || dy < 0 || dx >= rect.width || dy >= rect.height) continue;
        const one = { width: 1, height: 1, data: want.data.subarray((y * W + x) * 4, (y * W + x) * 4 + 4) };
        op(one, null, new Float32Array([fl[dy * rect.width + dx]]));
      }
      assert.deepEqual(got.data, want.data, `op ${o} case ${n}`);
    });
  }
});

test('replaceColor modes are exactly the W3C hue/saturation/color/luminosity blends of blend.js', () => {
  const rnd = randomSeeded(5);
  for (let n = 0; n < 400; n++) {
    const p = [0, 0, 0].map(() => Math.floor(rnd() * 256)), c = [0, 0, 0].map(() => Math.floor(rnd() * 256));
    for (const mode of ['hue', 'saturation', 'color', 'luminosity']) {
      const img = solidImage(1, 1, [...p, 1]);
      replaceColor(img, null, null, { color: [...c, 1], tolerance: 255, sampleColor: [0, 0, 0, 1], mode });
      const e = blendPixel(mode, c[0], c[1], c[2], p[0], p[1], p[2]);
      for (let k = 0; k < 3; k++) assert.ok(Math.abs(img.data[k] - e[k]) <= 0.5 + 1e-9, `${mode} ${p} <- ${c}: ${Array.from(img.data)} vs ${e}`);
    }
  }
});

test('1x1 images, empty images and rects in every op', () => {
  const px = () => solidImage(1, 1, [100, 50, 20, 1]);
  const a = px();
  dodge(a, null, null, { range: 'shadows', exposure: 1 });
  const L = luminance(100, 50, 20), Lt = L + (1 - L / 255) * (255 - L);
  assertNear(luminance(a.data[0], a.data[1], a.data[2]), Lt, 1, '1x1 dodge');
  for (const op of [
    (im) => burn(im, null, null, {}), (im) => sponge(im, null, null, {}), (im) => blurDab(im, null, null, { radius: 8 }),
    (im) => sharpenDab(im, null, null, { radius: 3 }), (im) => heal(im, null, null, px()), (im) => replaceColor(im, null, null, {}),
    (im) => smudge(im, null, null, smudge(im, null, null, null), {}),
  ]) {
    const im = px();
    op(im);
    assert.equal(im.data[3], 255);
    op(createImage(0, 0));
    const e = px();
    op(e, { x: 0, y: 0, width: 0, height: 0 });
  }
  // blur / sharpen / heal of a lone pixel: its own mean, so no change
  const b = px();
  blurDab(b, null, null, { strength: 1, radius: 5 });
  sharpenDab(b, null, null, { strength: 1, radius: 5 });
  heal(b, null, null, solidImage(1, 1, [0, 255, 0, 1]));
  assertPixel(getPixel(b, 0, 0), [100, 50, 20, 1], 0);
  assert.equal(smudge(createImage(0, 0), null, null, null).width, 0);
});

test('every op on a whole 1024x1024 image stays well under 1.5 s', () => {
  const img = noiseImage(1024, 1024, [128, 128, 128], 100, 4);
  const src = noiseImage(1024, 1024, [100, 120, 140], 60, 8);
  const ops = {
    dabMask: () => dabMask(1024, 1024, 0.5),
    dodge: () => dodge(img, null, null, { exposure: 0.2 }),
    burn: () => burn(img, null, null, { exposure: 0.2 }),
    sponge: () => sponge(img, null, null, { mode: 'saturate', flow: 0.3 }),
    blur: () => blurDab(img, null, null, { strength: 0.5, radius: 200 }),
    sharpen: () => sharpenDab(img, null, null, { strength: 0.5, radius: 50 }),
    smudge: () => smudge(img, null, null, src, { strength: 0.5 }),
    heal: () => heal(img, null, null, src),
    replace: () => replaceColor(img, null, null, { color: '#00ff00', tolerance: 120, sampleColor: '#808080' }),
  };
  for (const [name, fn] of Object.entries(ops)) {
    const t0 = performance.now();
    fn();
    const ms = performance.now() - t0;
    assert.ok(ms < 1500, `${name}: ${ms.toFixed(0)} ms on 1024x1024`);
  }
});
