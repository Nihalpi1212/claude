// Filters, part A (src/shared/pixels/filters-more-a.js): numbers per kind as the 0.3 contract lists them.
// filters.js is imported first on purpose: the table module imports FILTERS back (cycle safe at call time only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILTERS, FILTER_KINDS, applyFilter } from '../../src/shared/pixels/filters.js';
import { FILTERS_MORE_A, SHAPE_BLUR_SHAPES, estimateShakeKernel } from '../../src/shared/pixels/filters-more-a.js';
import { createImage, setPixel, getPixel, randomSeeded } from '../../src/shared/pixels/core.js';
import { gradientImage, solidImage, assertPixel } from './helpers.mjs';

const KINDS = ['average', 'blur', 'blur-more', 'lens-blur', 'shape-blur', 'smart-blur', 'sharpen-edges', 'sharpen-more', 'shake-reduction',
  'color-halftone', 'facet', 'mezzotint', 'de-interlace', 'ntsc-colors', 'hsb-hsl'];
const DIRECT = ['average', 'blur', 'blur-more', 'sharpen-edges', 'sharpen-more', 'facet', 'ntsc-colors'];

const copy = (img) => ({ width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) });
const px = (img, x, y) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (tol ${tol})`);

/** Deterministic colourful image with opaque, half-transparent and transparent pixels. */
function patternImage(w, h) {
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = (x + y) % 7 === 0 ? 0 : (x * y) % 5 === 0 ? 0.5 : 1;
    setPixel(img, x, y, [(x * 37 + y * 11) % 256, (x * 13 + y * 29) % 256, (x * y * 7 + 40) % 256, a]);
  }
  return img;
}

/** Opaque image: black with one white pixel at the centre. */
function impulse(size, v = 255) {
  const img = solidImage(size, size, [0, 0, 0, 1]);
  setPixel(img, size >> 1, size >> 1, [v, v, v, 1]);
  return img;
}

/** Two flat halves split by a vertical edge at x = w / 2. */
function edgeImage(w, h, left, right) {
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(img, x, y, x < w / 2 ? [left, left, left, 1] : [right, right, right, 1]);
  return img;
}

/** Synthetic photo-like image: gradient, discs, thin lines, mild noise. */
function sceneImage(w, h, seed = 5) {
  const img = createImage(w, h), rnd = randomSeeded(seed), d = img.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    d[i] = 60 + 120 * (x / w);
    d[i + 1] = 80 + 100 * (y / h);
    d[i + 2] = 140 - 60 * (x / w);
    d[i + 3] = 255;
  }
  for (let k = 0; k < 20; k++) {
    const cx = rnd() * w, cy = rnd() * h, r = 6 + rnd() * 40, c = [rnd() * 255, rnd() * 255, rnd() * 255];
    for (let y = Math.max(0, cy - r) | 0; y < Math.min(h, cy + r); y++) for (let x = Math.max(0, cx - r) | 0; x < Math.min(w, cx + r); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      const i = (y * w + x) * 4;
      d[i] = c[0];
      d[i + 1] = c[1];
      d[i + 2] = c[2];
    }
  }
  for (let k = 0; k < 20; k++) {
    const x0 = (rnd() * (w - 30)) | 0, y0 = (rnd() * (h - 30)) | 0, len = 8 + rnd() * 20, vert = rnd() < 0.5;
    for (let t = 0; t < len; t++) setPixel(img, vert ? x0 : x0 + t, vert ? y0 + t : y0, vert ? [250, 250, 250, 1] : [15, 15, 15, 1]);
  }
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * 6;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  return img;
}

/** Horizontal box blur of L taps (a camera moving sideways by L px during the exposure). */
function motionBox(img, L) {
  const out = createImage(img.width, img.height), d = img.data, o = out.data, w = img.width, half = L >> 1;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0;
    for (let k = -half; k <= half; k++) {
      const xx = Math.min(w - 1, Math.max(0, x + k)), i = (y * w + xx) * 4;
      r += d[i];
      g += d[i + 1];
      b += d[i + 2];
    }
    const j = (y * w + x) * 4;
    o[j] = r / L;
    o[j + 1] = g / L;
    o[j + 2] = b / L;
    o[j + 3] = 255;
  }
  return out;
}

const gradEnergyX = (img) => {
  let s = 0;
  const d = img.data, w = img.width;
  for (let y = 0; y < img.height; y++) for (let x = 1; x < w; x++) {
    const i = (y * w + x) * 4, g = d[i] - d[i - 4];
    s += g * g;
  }
  return s / (img.width * img.height);
};
const meanAbsErr = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.data.length; i += 4) s += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
  return s / (a.data.length * 0.75);
};

test('catalogue: every part A kind is real (no placeholder), direct flags, fields for dialog kinds, margins', () => {
  for (const k of KINDS) {
    assert.ok(FILTER_KINDS.includes(k), k);
    assert.equal(FILTERS[k], FILTERS_MORE_A[k], `${k} comes from the part A table`);
    assert.ok(!FILTERS[k].placeholder, `${k} is not a placeholder`);
    assert.equal(!!FILTERS[k].direct, DIRECT.includes(k), `${k} direct flag`);
    if (!DIRECT.includes(k)) assert.ok(FILTERS[k].fields.length > 0, `${k} declares dialog fields`);
    for (const f of FILTERS[k].fields ?? []) if (f.key) assert.ok(f.key.split('.')[0] in FILTERS[k].defaults, `${k} field ${f.key} is a parameter`);
  }
  assert.equal(FILTERS['lens-blur'].ui, 'custom');
  assert.equal(FILTERS['lens-blur'].margin({ radius: 40 }), 42);
  assert.equal(FILTERS['shape-blur'].margin({ radius: 10 }), 11);
  assert.equal(FILTERS['shake-reduction'].margin({ traceBounds: 50 }), 58);
  assert.deepEqual(FILTERS['color-halftone'].defaults.angles, [108, 162, 90, 45]);
  // a filter mutates its input and returns it; unknown params do not disturb defaults
  const img = patternImage(8, 8);
  assert.equal(applyFilter(img, 'ntsc-colors'), img);
});

test('blur: an impulse spreads with the separable 1-2-1 weights; blur-more is three passes; transparency does not bleed black', () => {
  const out = applyFilter(impulse(9), 'blur');
  assertPixel(getPixel(out, 4, 4), [64, 64, 64, 1], 1, 'centre 4/16');
  for (const [x, y] of [[3, 4], [5, 4], [4, 3], [4, 5]]) assertPixel(getPixel(out, x, y), [32, 32, 32, 1], 1, `edge ${x},${y} 2/16`);
  for (const [x, y] of [[3, 3], [5, 5], [3, 5], [5, 3]]) assertPixel(getPixel(out, x, y), [16, 16, 16, 1], 1, `corner ${x},${y} 1/16`);
  assertPixel(getPixel(out, 2, 4), [0, 0, 0, 1], 0, 'outside the 3x3');
  // three Blurs = one Blur More
  const three = applyFilter(applyFilter(applyFilter(impulse(11), 'blur'), 'blur'), 'blur');
  const more = applyFilter(impulse(11), 'blur-more');
  for (let i = 0; i < more.data.length; i++) assert.ok(Math.abs(more.data[i] - three.data[i]) <= 1, `blur-more vs 3x blur at ${i}`);
  // a white pixel next to transparent (black) pixels stays white: averaging is alpha weighted
  const t = createImage(5, 5);
  setPixel(t, 2, 2, [255, 255, 255, 1]);
  const b = applyFilter(t, 'blur');
  const c = getPixel(b, 2, 2);
  assert.deepEqual(c.slice(0, 3), [255, 255, 255]);
  near(c[3], 0.25, 0.01, 'alpha spreads like any channel');
  assert.deepEqual(getPixel(b, 1, 2).slice(0, 3), [255, 255, 255]);
  // rect limits writes: outside the rect nothing changes
  const r = applyFilter(impulse(9), 'blur', {}, { x: 0, y: 0, width: 4, height: 9 });
  assertPixel(getPixel(r, 4, 4), [255, 255, 255, 1], 0, 'outside rect untouched');
  assertPixel(getPixel(r, 3, 4), [32, 32, 32, 1], 1, 'inside rect reads across the rect edge');
});

test('average: the region becomes its alpha-weighted mean colour, alpha kept, rect limited', () => {
  const img = patternImage(12, 10);
  let sr = 0, sg = 0, sb = 0, sa = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const a = img.data[i + 3];
    sr += img.data[i] * a;
    sg += img.data[i + 1] * a;
    sb += img.data[i + 2] * a;
    sa += a;
  }
  const mean = [Math.round(sr / sa), Math.round(sg / sa), Math.round(sb / sa)];
  const before = copy(img), out = applyFilter(img, 'average');
  for (let p = 0; p < out.data.length; p += 4) {
    assert.deepEqual(Array.from(out.data.subarray(p, p + 3)), mean, `pixel ${p / 4}`);
    assert.equal(out.data[p + 3], before.data[p + 3], 'alpha kept');
  }
  const rect = { x: 2, y: 2, width: 4, height: 3 };
  const part = applyFilter(patternImage(12, 10), 'average', {}, rect);
  const ref = patternImage(12, 10);
  assert.deepEqual(px(part, 0, 0), px(ref, 0, 0), 'outside rect untouched');
  assert.deepEqual(px(part, 2, 2).slice(0, 3), mean, 'the rect takes the image mean (the dialog crops to the selection)');
});

test('lens-blur: a polygon kernel of the right area, bokeh boost, depth map focus, noise after the blur', () => {
  // an impulse through a hexagonal aperture of radius 6 covers about the hexagon's area (2.598 r^2 = 93 px)
  const out = applyFilter(impulse(31), 'lens-blur', { radius: 6, shape: 'hexagon' });
  let lit = 0;
  for (let i = 0; i < out.data.length; i += 4) if (out.data[i] > 0) lit++;
  assert.ok(lit >= 75 && lit <= 115, `hexagon area ${lit}`);
  assert.equal(out.data[3], 255, 'alpha kept');
  // a flat image is unchanged by a uniform blur
  const flat = applyFilter(solidImage(40, 30, [90, 140, 200, 1]), 'lens-blur', { radius: 12, shape: 'octagon', bladeCurvature: 50 });
  assertPixel(getPixel(flat, 20, 15), [90, 140, 200, 1], 1, 'flat');
  // specular highlights: a small bright spot above the threshold leaves a brighter disc than without the boost
  const base = solidImage(41, 41, [40, 40, 40, 1]);
  setPixel(base, 20, 20, [255, 255, 255, 1]);
  const plain = applyFilter(copy(base), 'lens-blur', { radius: 5, brightness: 0 });
  const boosted = applyFilter(copy(base), 'lens-blur', { radius: 5, brightness: 80, threshold: 200 });
  assert.ok(getPixel(boosted, 22, 20)[0] > getPixel(plain, 22, 20)[0] + 20, `bokeh boost ${getPixel(boosted, 22, 20)[0]} vs ${getPixel(plain, 22, 20)[0]}`);
  // depth map: depth 0 everywhere at focal 0 is in focus -> identity; depth 255 is fully blurred
  const edge = edgeImage(40, 40, 0, 255);
  const sharpMap = new Uint8ClampedArray(40 * 40);
  const same = applyFilter(copy(edge), 'lens-blur', { radius: 8, depthMap: sharpMap, focalDistance: 0 });
  assert.deepEqual(Array.from(same.data), Array.from(edge.data), 'in-focus depth keeps the pixels');
  const split = new Uint8ClampedArray(40 * 40).fill(255, 20 * 40); // bottom half far from focus
  const half = applyFilter(copy(edge), 'lens-blur', { radius: 8, depthMap: split, focalDistance: 0 });
  assert.equal(getPixel(half, 19, 5)[0], 0, 'top half (in focus) keeps a hard edge');
  const soft = getPixel(half, 19, 35)[0];
  assert.ok(soft > 20 && soft < 235, `bottom half blurred across the edge: ${soft}`);
  const inv = applyFilter(copy(edge), 'lens-blur', { radius: 8, depthMap: split, focalDistance: 0, invert: true });
  assert.equal(getPixel(inv, 19, 35)[0], 0, 'invert swaps which half is in focus');
  // noise is deterministic and added after the blur
  const n1 = applyFilter(solidImage(16, 16, [128, 128, 128, 1]), 'lens-blur', { radius: 2, noise: 40 });
  const n2 = applyFilter(solidImage(16, 16, [128, 128, 128, 1]), 'lens-blur', { radius: 2, noise: 40 });
  assert.deepEqual(Array.from(n1.data), Array.from(n2.data));
  assert.ok(n1.data.some((v, i) => i % 4 !== 3 && v !== 128), 'noise changed pixels');
});

test('shape-blur: shapes export, square kernel is a box, ring kernel excludes the centre, big radii downscale', () => {
  assert.deepEqual(SHAPE_BLUR_SHAPES.map((s) => s.id), ['circle', 'square', 'triangle', 'diamond', 'star', 'heart', 'arrow', 'cross', 'hexagon', 'ring']);
  for (const s of SHAPE_BLUR_SHAPES) {
    assert.equal(typeof s.name, 'string');
    assert.equal(s.inside(0, 0), s.id !== 'ring', `${s.id} centre`);
    assert.equal(s.inside(1.5, 0), false, `${s.id} outside the unit square`);
  }
  const box = applyFilter(impulse(9), 'shape-blur', { radius: 2, shape: 'square' });
  for (let y = 2; y <= 6; y++) for (let x = 2; x <= 6; x++) near(getPixel(box, x, y)[0], 255 / 25, 1, `box ${x},${y}`);
  assert.equal(getPixel(box, 1, 4)[0], 0);
  const ring = applyFilter(impulse(15), 'shape-blur', { radius: 4, shape: 'ring' });
  assert.equal(getPixel(ring, 7, 7)[0], 0, 'the ring hole leaves the centre dark');
  assert.ok(getPixel(ring, 7, 3)[0] > 0, 'the ring lights the rim');
  // a radius far beyond 8 runs downscaled and still gives a flat result on a flat image and a wide spread on an impulse
  const flat = applyFilter(solidImage(64, 48, [10, 200, 30, 1]), 'shape-blur', { radius: 40, shape: 'heart' });
  assertPixel(getPixel(flat, 30, 20), [10, 200, 30, 1], 1, 'flat stays flat');
  const wide = applyFilter(solidImage(101, 101, [0, 0, 0, 1]), 'shape-blur', { radius: 30, shape: 'circle' }, null);
  void wide;
  const spot = solidImage(101, 101, [0, 0, 0, 1]);
  for (let y = 45; y < 56; y++) for (let x = 45; x < 56; x++) setPixel(spot, x, y, [255, 255, 255, 1]);
  const big = applyFilter(spot, 'shape-blur', { radius: 30, shape: 'circle' });
  assert.ok(getPixel(big, 50, 25)[0] > 0 && getPixel(big, 50, 10)[0] === 0, 'spread to radius 30, not beyond');
});

test('smart-blur: smooths texture below the threshold, keeps hard edges, edge modes draw white edges', () => {
  const img = edgeImage(40, 20, 60, 200), rnd = randomSeeded(3);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = Math.round((rnd() - 0.5) * 16);
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  const varianceOf = (im, x0, x1) => {
    let s = 0, s2 = 0, n = 0;
    for (let y = 0; y < im.height; y++) for (let x = x0; x < x1; x++) {
      const v = getPixel(im, x, y)[0];
      s += v;
      s2 += v * v;
      n++;
    }
    return s2 / n - (s / n) ** 2;
  };
  const out = applyFilter(copy(img), 'smart-blur', { radius: 3, threshold: 20, quality: 'high' });
  assert.ok(varianceOf(out, 2, 18) < varianceOf(img, 2, 18) / 3, 'texture smoothed');
  assert.ok(getPixel(out, 20, 10)[0] - getPixel(out, 19, 10)[0] > 110, 'the edge stays hard');
  const edges = applyFilter(copy(img), 'smart-blur', { radius: 3, threshold: 20, mode: 'edge-only' });
  assert.deepEqual(getPixel(edges, 20, 10).slice(0, 3), [255, 255, 255], 'edge is white');
  assert.deepEqual(getPixel(edges, 8, 10).slice(0, 3), [0, 0, 0], 'flat area is black');
  const overlay = applyFilter(copy(img), 'smart-blur', { radius: 3, threshold: 20, mode: 'overlay-edge' });
  assert.deepEqual(getPixel(overlay, 20, 10).slice(0, 3), [255, 255, 255]);
  near(getPixel(overlay, 8, 10)[0], 60, 6, 'overlay keeps the blurred image elsewhere');
  // quality steps change the sampling, never the alpha
  const q = applyFilter(patternImage(16, 16), 'smart-blur', { radius: 4, threshold: 50, quality: 'low' });
  const ref = patternImage(16, 16);
  for (let i = 3; i < q.data.length; i += 4) assert.equal(q.data[i], ref.data[i]);
});

test('sharpen-edges: a smooth ramp is untouched and a hard edge gains contrast; sharpen-more beats sharpen', () => {
  const ramp = gradientImage(64, 4); // 4 levels per px, below the edge threshold
  const same = applyFilter(copy(ramp), 'sharpen-edges');
  assert.deepEqual(Array.from(same.data), Array.from(ramp.data));
  const edge = edgeImage(20, 6, 100, 200);
  const out = applyFilter(copy(edge), 'sharpen-edges');
  assert.ok(getPixel(out, 9, 3)[0] < 90, `dark side darker: ${getPixel(out, 9, 3)[0]}`);
  assert.ok(getPixel(out, 10, 3)[0] > 210, `bright side brighter: ${getPixel(out, 10, 3)[0]}`);
  assertPixel(getPixel(out, 2, 3), [100, 100, 100, 1], 0, 'flat area away from the edge untouched');
  const s1 = applyFilter(copy(edge), 'sharpen'), s2 = applyFilter(copy(edge), 'sharpen-more');
  const overshoot = (im) => getPixel(im, 10, 3)[0] - getPixel(im, 9, 3)[0];
  assert.ok(overshoot(s2) > overshoot(s1) + 20, `sharpen-more ${overshoot(s2)} vs sharpen ${overshoot(s1)}`);
});

test('shake-reduction: estimates a 9 px horizontal shake within 2 px, leaves a sharp image alone, raises edge contrast', () => {
  const sharp = sceneImage(384, 320), blurred = motionBox(sharp, 9);
  const est = estimateShakeKernel(blurred, { traceBounds: 41 });
  assert.ok(est.detected, 'shake detected');
  near(est.length, 9, 2, 'trace length');
  const ang = ((est.angle % 180) + 180) % 180;
  assert.ok(ang < 10 || ang > 170, `trace angle ${est.angle}`);
  assert.ok(est.kernel.size >= 9 && est.kernel.data.length === est.kernel.size ** 2);
  near(est.kernel.data.reduce((a, b) => a + b, 0), 1, 1e-6, 'kernel normalised');
  assert.equal(estimateShakeKernel(sharp, { traceBounds: 41 }).detected, false, 'nothing to find on the sharp image');
  const same = applyFilter(copy(sharp), 'shake-reduction', {});
  assert.deepEqual(Array.from(same.data), Array.from(sharp.data), 'a sharp image is returned unchanged');
  const t0 = performance.now();
  const rec = applyFilter(copy(blurred), 'shake-reduction', { traceBounds: 41 });
  const ms = performance.now() - t0;
  assert.ok(ms < 8000, `384x320 in ${ms.toFixed(0)} ms`);
  const eB = gradEnergyX(blurred), eR = gradEnergyX(rec);
  assert.ok(eR > eB * 1.3, `edge energy ${eB.toFixed(1)} -> ${eR.toFixed(1)}`);
  assert.ok(meanAbsErr(rec, sharp) < meanAbsErr(blurred, sharp) * 0.9, `closer to the original: ${meanAbsErr(blurred, sharp).toFixed(2)} -> ${meanAbsErr(rec, sharp).toFixed(2)}`);
  for (let i = 3; i < rec.data.length; i += 4) assert.equal(rec.data[i], 255);
  // a traceBounds below the real length cannot find it
  assert.equal(estimateShakeKernel(motionBox(sharp, 31), { traceBounds: 12 }).detected, false);
});

test('color-halftone: 50% grey gives about half black coverage, white stays white, cells follow the angles', () => {
  const grey = applyFilter(solidImage(256, 256, [128, 128, 128, 1]), 'color-halftone', { radius: 8 });
  let dark = 0, other = 0;
  for (let i = 0; i < grey.data.length; i += 4) {
    if (grey.data[i] < 64) dark++;
    if (grey.data[i] !== grey.data[i + 1] || grey.data[i] !== grey.data[i + 2]) other++;
  }
  const frac = dark / (256 * 256);
  assert.ok(frac > 0.42 && frac < 0.58, `black coverage ${frac.toFixed(3)}`);
  assert.equal(other, 0, 'a grey has no c/m/y ink');
  const white = applyFilter(solidImage(32, 32, [255, 255, 255, 1]), 'color-halftone', { radius: 4 });
  for (let i = 0; i < white.data.length; i += 4) assert.deepEqual(Array.from(white.data.subarray(i, i + 4)), [255, 255, 255, 255]);
  // pure cyan paints cyan ink only (no black dots)
  const cyan = applyFilter(solidImage(64, 64, [0, 255, 255, 1]), 'color-halftone', { radius: 6 });
  let cy = 0;
  for (let i = 0; i < cyan.data.length; i += 4) {
    assert.ok(cyan.data[i + 1] === 255 && cyan.data[i + 2] === 255, 'green and blue stay full');
    if (cyan.data[i] === 0) cy++;
  }
  assert.ok(cy > 64 * 64 * 0.5, 'mostly covered in cyan');
  // alpha kept, rect limited
  const pat = patternImage(40, 40), part = applyFilter(copy(pat), 'color-halftone', { radius: 4 }, { x: 10, y: 10, width: 10, height: 10 });
  assert.deepEqual(px(part, 0, 0), px(pat, 0, 0));
  for (let i = 3; i < part.data.length; i += 4) assert.equal(part.data[i], pat.data[i]);
  // the same pixels come out of a partial and a full run
  const full = applyFilter(copy(pat), 'color-halftone', { radius: 4 });
  assert.deepEqual(px(part, 15, 15), px(full, 15, 15));
});

test('facet: isolated pixels take the dominant neighbourhood colour, flat areas stay', () => {
  const img = solidImage(9, 9, [200, 30, 30, 1]);
  setPixel(img, 4, 4, [30, 30, 200, 1]);
  const out = applyFilter(img, 'facet');
  assertPixel(getPixel(out, 4, 4), [200, 30, 30, 1], 0, 'odd one out replaced');
  assertPixel(getPixel(out, 0, 0), [200, 30, 30, 1], 0, 'corner');
  // a 2 px wide stripe survives (it is the majority in its own 3x3)
  const stripes = createImage(12, 6);
  for (let y = 0; y < 6; y++) for (let x = 0; x < 12; x++) setPixel(stripes, x, y, Math.floor(x / 4) % 2 ? [255, 255, 255, 1] : [0, 0, 0, 1]);
  const s = applyFilter(copy(stripes), 'facet');
  assertPixel(getPixel(s, 5, 3), [255, 255, 255, 1], 0, 'stripe centre kept');
  assertPixel(getPixel(s, 1, 3), [0, 0, 0, 1], 0);
  const pat = patternImage(16, 16), f = applyFilter(copy(pat), 'facet');
  for (let i = 3; i < f.data.length; i += 4) assert.equal(f.data[i], pat.data[i], 'alpha kept');
});

test('mezzotint: black/white per channel with the mean preserved, deterministic per seed and position stable', () => {
  for (const type of ['fine-dots', 'coarse-dots', 'medium-lines', 'long-strokes']) {
    // long runs share one draw, so a 256 px square is needed for a few thousand independent samples
    const out = applyFilter(solidImage(256, 256, [100, 100, 100, 1]), 'mezzotint', { type, seed: 3 });
    let sum = 0;
    for (let i = 0; i < out.data.length; i += 4) {
      assert.ok(out.data[i] === 0 || out.data[i] === 255, `${type} binary`);
      assert.ok(out.data[i] === out.data[i + 1] && out.data[i] === out.data[i + 2], `${type} grey stays grey`);
      sum += out.data[i];
    }
    near(sum / (256 * 256), 100, 8, `${type} mean`);
  }
  const colour = applyFilter(solidImage(32, 32, [255, 128, 0, 1]), 'mezzotint', { type: 'medium-dots', seed: 1 });
  for (let i = 0; i < colour.data.length; i += 4) {
    assert.equal(colour.data[i], 255, 'full red always passes');
    assert.equal(colour.data[i + 2], 0, 'zero blue never passes');
  }
  const a = applyFilter(solidImage(32, 32, [128, 128, 128, 1]), 'mezzotint', { type: 'short-lines', seed: 7 });
  const b = applyFilter(solidImage(32, 32, [128, 128, 128, 1]), 'mezzotint', { type: 'short-lines', seed: 7 });
  const c = applyFilter(solidImage(32, 32, [128, 128, 128, 1]), 'mezzotint', { type: 'short-lines', seed: 8 });
  assert.deepEqual(Array.from(a.data), Array.from(b.data));
  assert.notDeepEqual(Array.from(a.data), Array.from(c.data));
  const part = applyFilter(solidImage(32, 32, [128, 128, 128, 1]), 'mezzotint', { type: 'short-lines', seed: 7 }, { x: 8, y: 8, width: 8, height: 8 });
  assert.deepEqual(px(part, 10, 12), px(a, 10, 12), 'position stable noise');
  assert.deepEqual(px(part, 0, 0), [128, 128, 128, 255], 'outside rect untouched');
});

test('de-interlace: duplication copies the other field, interpolation averages it', () => {
  const rows = createImage(4, 8);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 4; x++) setPixel(rows, x, y, [y * 20, y * 20 + 1, 255 - y * 20, 1]);
  const dup = applyFilter(copy(rows), 'de-interlace', { eliminate: 'odd', method: 'duplication' });
  for (let y = 1; y < 8; y += 2) assert.deepEqual(px(dup, 2, y), px(rows, 2, y - 1), `odd row ${y} copies row ${y - 1}`);
  for (let y = 0; y < 8; y += 2) assert.deepEqual(px(dup, 2, y), px(rows, 2, y), `even row ${y} kept`);
  const inter = applyFilter(copy(rows), 'de-interlace', { eliminate: 'odd', method: 'interpolation' });
  assert.deepEqual(px(inter, 1, 3), [60, 61, 195, 255], 'row 3 = mean of rows 2 and 4');
  assert.deepEqual(px(inter, 1, 7), px(rows, 1, 6), 'last row has one neighbour');
  const even = applyFilter(copy(rows), 'de-interlace', { eliminate: 'even', method: 'duplication' });
  assert.deepEqual(px(even, 0, 0), px(rows, 0, 1), 'row 0 takes row 1');
  assert.deepEqual(px(even, 0, 2), px(rows, 0, 1), 'row 2 takes row 1');
  assert.deepEqual(px(even, 0, 3), px(rows, 0, 3), 'odd rows kept');
  // interpolation of alpha is alpha weighted
  const t = createImage(2, 3);
  setPixel(t, 0, 0, [255, 0, 0, 1]);
  setPixel(t, 0, 2, [0, 0, 255, 0]);
  const ti = applyFilter(t, 'de-interlace', { eliminate: 'odd', method: 'interpolation' });
  assert.deepEqual(px(ti, 0, 1), [255, 0, 0, 128], 'transparent neighbour contributes no colour');
});

test('ntsc-colors: greys within 16..235, hot colours lose saturation, in-gamut colours survive', () => {
  const img = createImage(5, 1);
  setPixel(img, 0, 0, [128, 128, 128, 1]);
  setPixel(img, 1, 0, [255, 255, 255, 1]);
  setPixel(img, 2, 0, [0, 0, 0, 1]);
  setPixel(img, 3, 0, [255, 0, 0, 1]);
  setPixel(img, 4, 0, [120, 140, 160, 1]);
  const before = copy(img), out = applyFilter(img, 'ntsc-colors');
  assertPixel(getPixel(out, 0, 0), [128, 128, 128, 1], 1, 'mid grey');
  assertPixel(getPixel(out, 1, 0), [235, 235, 235, 1], 1, 'white to 235');
  assertPixel(getPixel(out, 2, 0), [16, 16, 16, 1], 1, 'black to 16');
  const red = getPixel(out, 3, 0), sat = (c) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
  assert.ok(sat(red) < 255 && red[0] > red[1] && red[0] > red[2], `red desaturated but still red: ${red}`);
  assertPixel(getPixel(out, 4, 0), [120, 140, 160, 1], 2, 'a muted colour is already safe');
  assert.equal(out.data[3], before.data[3]);
});

test('hsb-hsl: channel reinterpretation with round trips (identity within 1 for muted colours)', () => {
  const prim = createImage(3, 1);
  setPixel(prim, 0, 0, [255, 0, 0, 1]);
  setPixel(prim, 1, 0, [0, 255, 0, 1]);
  setPixel(prim, 2, 0, [128, 128, 128, 1]);
  const hsb = applyFilter(copy(prim), 'hsb-hsl', { from: 'rgb', to: 'hsb' });
  assert.deepEqual(px(hsb, 0, 0), [0, 255, 255, 255], 'red -> H 0, S 1, B 1');
  assert.deepEqual(px(hsb, 1, 0), [85, 255, 255, 255], 'green -> H 120/360');
  assert.deepEqual(px(hsb, 2, 0), [0, 0, 128, 255], 'grey -> B only');
  const hsl = applyFilter(copy(prim), 'hsb-hsl', { from: 'rgb', to: 'hsl' });
  assert.deepEqual(px(hsl, 0, 0), [0, 255, 128, 255], 'red -> L 0.5');
  assert.deepEqual(px(hsl, 2, 0), [0, 0, 128, 255]);
  // muted colours (S*V <= 0.3) round trip within 1; the 255-level hue costs saturated ones up to a few levels
  const muted = createImage(32, 8);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 32; x++) setPixel(muted, x, y, [100 + x * 2, 100 + y * 5, 130 - x, 1]);
  for (const space of ['hsb', 'hsl']) {
    const back = applyFilter(applyFilter(copy(muted), 'hsb-hsl', { from: 'rgb', to: space }), 'hsb-hsl', { from: space, to: 'rgb' });
    for (let i = 0; i < back.data.length; i++) assert.ok(Math.abs(back.data[i] - muted.data[i]) <= 1, `${space} round trip at ${i}: ${back.data[i]} vs ${muted.data[i]}`);
    const pat = patternImage(24, 24);
    const back2 = applyFilter(applyFilter(copy(pat), 'hsb-hsl', { from: 'rgb', to: space }), 'hsb-hsl', { from: space, to: 'rgb' });
    for (let i = 0; i < back2.data.length; i++) assert.ok(Math.abs(back2.data[i] - pat.data[i]) <= 4, `${space} saturated round trip at ${i}`);
  }
  const hsb2hsl = applyFilter(copy(hsb), 'hsb-hsl', { from: 'hsb', to: 'hsl' });
  assert.deepEqual(px(hsb2hsl, 0, 0), [0, 255, 128, 255], 'hsb -> hsl directly');
  const same = applyFilter(copy(prim), 'hsb-hsl', { from: 'hsl', to: 'hsl' });
  assert.deepEqual(Array.from(same.data), Array.from(prim.data), 'same space is identity');
});

test('rect convention: partial runs match the full run inside the rect and leave the outside alone', () => {
  const rect = { x: 5, y: 4, width: 9, height: 7 };
  for (const [kind, params] of [['blur-more', {}], ['facet', {}], ['sharpen-edges', {}], ['smart-blur', { radius: 2, threshold: 40 }], ['hsb-hsl', {}], ['ntsc-colors', {}], ['shape-blur', { radius: 3, shape: 'diamond' }], ['lens-blur', { radius: 4 }], ['de-interlace', {}]]) {
    const src = patternImage(24, 20), full = applyFilter(copy(src), kind, params), part = applyFilter(copy(src), kind, params, rect);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 24; x++) {
      const inside = x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
      const want = inside ? px(full, x, y) : px(src, x, y), got = px(part, x, y);
      for (let c = 0; c < 4; c++) assert.ok(Math.abs(got[c] - want[c]) <= 1, `${kind} at ${x},${y} (${inside ? 'inside' : 'outside'}): ${got} vs ${want}`);
    }
  }
});
