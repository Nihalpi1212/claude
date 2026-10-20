import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILTERS, FILTER_KINDS, FILTER_CATEGORIES, applyFilter } from '../../src/shared/pixels/filters.js';
import { createImage, cloneImage, getPixel, setPixel, luminance, randomSeeded, sampleBilinear } from '../../src/shared/pixels/core.js';
import { gradientImage, quadrantImage, solidImage, assertPixel, assertNear } from './helpers.mjs';

const CONTRACT_KINDS = [
  'gaussian-blur', 'box-blur', 'motion-blur', 'radial-blur', 'surface-blur',
  'sharpen', 'unsharp-mask', 'smart-sharpen', 'high-pass',
  'add-noise', 'median', 'despeckle', 'dust-scratches', 'reduce-noise',
  'mosaic', 'crystallize', 'pointillize', 'fragment',
  'twirl', 'pinch', 'spherize', 'ripple', 'wave', 'zigzag', 'polar', 'shear', 'offset',
  'emboss', 'find-edges', 'solarize', 'diffuse', 'oil-paint', 'glowing-edges',
  'clouds', 'difference-clouds', 'lens-flare', 'vignette',
  'maximum', 'minimum', 'custom', 'invert-alpha',
];

/** Deterministic colourful test image with opaque, half-transparent and transparent pixels. */
function patternImage(w, h) {
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = (x + y) % 7 === 0 ? 0 : (x * y) % 5 === 0 ? 0.5 : 1;
      setPixel(img, x, y, [(x * 37 + y * 11) % 256, (x * 13 + y * 29) % 256, (x * y * 7 + 40) % 256, a]);
    }
  }
  return img;
}

/** Image with one pixel set on a solid background. */
function dotImage(size, bg, dot, x = size >> 1, y = size >> 1) {
  const img = solidImage(size, size, bg);
  setPixel(img, x, y, dot);
  return img;
}

const channelSum = (img, c) => {
  let s = 0;
  for (let i = c; i < img.data.length; i += 4) s += img.data[i];
  return s;
};

test('catalogue: every contract kind, categories, applyFilter', () => {
  assert.deepEqual([...FILTER_KINDS].sort(), [...CONTRACT_KINDS].sort());
  const seen = [];
  assert.deepEqual(FILTER_CATEGORIES.map((c) => c.id), ['blur', 'sharpen', 'noise', 'pixelate', 'distort', 'stylize', 'render', 'other']);
  for (const cat of FILTER_CATEGORIES) {
    assert.equal(typeof cat.name, 'string');
    for (const k of cat.kinds) {
      assert.equal(FILTERS[k].category, cat.id, k);
      seen.push(k);
    }
  }
  assert.deepEqual(seen.sort(), [...CONTRACT_KINDS].sort(), 'each kind in exactly one category');
  for (const k of FILTER_KINDS) {
    const f = FILTERS[k];
    assert.equal(typeof f.name, 'string', k);
    assert.equal(typeof f.apply, 'function', k);
    assert.ok(Object.isFrozen(f.defaults), `${k} defaults frozen`);
  }
  assert.throws(() => applyFilter(createImage(2, 2), 'nope'), RangeError);
  assert.throws(() => applyFilter(createImage(2, 2), 'toString'), RangeError);
  // applyFilter merges defaults and returns the same image object
  const img = gradientImage(8, 2);
  assert.equal(applyFilter(img, 'gaussian-blur', { radius: undefined }), img);
  const viaDefaults = applyFilter(gradientImage(8, 2), 'gaussian-blur', { radius: FILTERS['gaussian-blur'].defaults.radius });
  assert.deepEqual(img.data, viaDefaults.data);
});

test('every filter runs on an 8x8 image with its defaults and keeps the size', () => {
  for (const k of FILTER_KINDS) {
    for (const make of [() => quadrantImage(8), () => patternImage(8, 8)]) {
      const img = make();
      const out = applyFilter(img, k);
      assert.equal(out, img, k);
      assert.equal(out.width, 8, k);
      assert.equal(out.height, 8, k);
      assert.equal(out.data.length, 8 * 8 * 4, k);
    }
    // degenerate images are fine too
    applyFilter(createImage(1, 1, [10, 20, 30, 1]), k);
    applyFilter(createImage(0, 0), k);
  }
});

test('rect limits writes and matches the whole-image result inside', () => {
  const rect = { x: 3, y: 2, width: 6, height: 7 };
  const params = { 'motion-blur': { angle: 30, distance: 6 }, 'radial-blur': { amount: 40 }, 'radial-blur-zoom': null, offset: { dx: 3, dy: -2 }, 'surface-blur': { radius: 3 } };
  const runs = FILTER_KINDS.map((k) => [k, params[k] || {}]);
  runs.push(['radial-blur', { amount: 60, method: 'zoom', center: { x: 0.3, y: 0.6 } }]);
  runs.push(['gaussian-blur', { radius: 24 }]); // 3-box path
  runs.push(['box-blur', { radius: 2.5 }]);
  runs.push(['add-noise', { distribution: 'gaussian', amount: 30 }]);
  runs.push(['add-noise', { monochromatic: true, amount: 30 }]);
  runs.push(['diffuse', { mode: 'anisotropic' }]);
  runs.push(['wave', { edge: 'wrap', amplitude: 3, wavelength: 7, type: 'triangle' }]);
  runs.push(['ripple', { edge: 'repeat', size: 'small' }]);
  runs.push(['polar', { toPolar: false }]);
  runs.push(['shear', { points: [[0, 0.3], [0.5, -0.2], [1, 0.1]], edge: 'wrap' }]);
  runs.push(['crystallize', { size: 3.5 }]);
  runs.push(['pointillize', { size: 3 }]);
  runs.push(['mosaic', { size: 4 }]);
  for (const [k, p] of runs) {
    const src = patternImage(14, 13);
    const full = applyFilter(cloneImage(src), k, p);
    const part = applyFilter(cloneImage(src), k, p, rect);
    for (let y = 0; y < 13; y++) {
      for (let x = 0; x < 14; x++) {
        const inside = x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
        const i = (y * 14 + x) * 4;
        for (let c = 0; c < 4; c++) {
          if (!inside) assert.equal(part.data[i + c], src.data[i + c], `${k} ${JSON.stringify(p)} wrote outside rect at ${x},${y}`);
          else assert.ok(Math.abs(part.data[i + c] - full.data[i + c]) <= 1, `${k} ${JSON.stringify(p)} at ${x},${y} c${c}: ${part.data[i + c]} vs full ${full.data[i + c]}`);
        }
      }
    }
  }
  // a rect partly outside the image is clipped, one fully outside is a no-op
  const src = patternImage(6, 6);
  const img = applyFilter(cloneImage(src), 'invert-alpha', {}, { x: 4, y: -3, width: 10, height: 5 });
  assert.equal(getPixel(img, 5, 1)[3], 1 - getPixel(src, 5, 1)[3]);
  assert.deepEqual(getPixel(img, 3, 1), getPixel(src, 3, 1));
  assert.deepEqual(applyFilter(cloneImage(src), 'gaussian-blur', {}, { x: 20, y: 20, width: 3, height: 3 }).data, src.data);
});

test('gaussian blur: a single bright pixel spreads symmetric mass and keeps its sum', () => {
  const sym = (img, n, c, k) => {
    const v = (x, y) => img.data[(y * n + x) * 4];
    assert.equal(v(c + k, c), v(c - k, c), `x symmetry ${k}`);
    assert.equal(v(c, c + k), v(c, c - k), `y symmetry ${k}`);
    assert.equal(v(c + k, c), v(c, c + k), `x/y symmetry ${k}`);
    assert.ok(v(c + k, c) <= v(c + k - 1, c), 'monotone fall-off');
  };
  // Small radius: the whole spread is representable in 8 bits, so the sum survives within 1%.
  const one = dotImage(21, [0, 0, 0, 1], [255, 255, 255, 1]);
  applyFilter(one, 'gaussian-blur', { radius: 0.5 });
  assert.ok(Math.abs(channelSum(one, 0) - 255) <= 255 * 0.01, `sum ${channelSum(one, 0)}`);
  assert.ok(one.data[(10 * 21 + 10) * 4] < 255 && one.data[(10 * 21 + 11) * 4] > 0, 'mass spread');
  for (let k = 1; k <= 2; k++) sym(one, 21, 10, k);
  // Wider radii: every pixel matches round(255 * G(dx) * G(dy)) of the sampled, normalised
  // Gaussian (sigma = radius, +-3 sigma); the tails below 0.5 are what 8 bits lose.
  for (const radius of [1, 2.5]) {
    const n = 41, c = 20, K = Math.ceil(3 * radius);
    const G = [];
    for (let j = -K; j <= K; j++) G.push(Math.exp(-(j * j) / (2 * radius * radius)));
    const total = G.reduce((a, b) => a + b, 0);
    const img = dotImage(n, [0, 0, 0, 1], [255, 255, 255, 1]);
    applyFilter(img, 'gaussian-blur', { radius });
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const dx = x - c, dy = y - c;
        const ideal = Math.abs(dx) <= K && Math.abs(dy) <= K ? (255 * G[dx + K] * G[dy + K]) / (total * total) : 0;
        assert.ok(Math.abs(img.data[(y * n + x) * 4] - ideal) <= 0.51, `radius ${radius} at ${dx},${dy}: ${img.data[(y * n + x) * 4]} vs ${ideal}`);
        assert.equal(img.data[(y * n + x) * 4 + 3], 255, 'opaque stays opaque');
      }
    }
    for (let k = 1; k <= 3; k++) sym(img, n, c, k);
  }
  // A bright block keeps its total within 1% for a wide direct kernel and for the 3-box path.
  for (const radius of [6, 24]) {
    const half = radius, n = 2 * (half + 4 * radius) + 1, c = n >> 1, mass = (2 * half + 1) ** 2 * 255;
    const img = solidImage(n, n, [0, 0, 0, 1]);
    for (let y = c - half; y <= c + half; y++) for (let x = c - half; x <= c + half; x++) setPixel(img, x, y, [255, 255, 255, 1]);
    applyFilter(img, 'gaussian-blur', { radius });
    const sum = channelSum(img, 0);
    assert.ok(Math.abs(sum - mass) <= mass * 0.01, `radius ${radius}: sum ${sum} vs ${mass}`);
    for (let k = 1; k <= 3; k++) sym(img, n, c, k * 4);
  }
  // the 3-box approximation and the direct kernel agree closely around the threshold
  const wide = solidImage(80, 9, [0, 0, 0, 1]);
  for (let y = 0; y < 9; y++) for (let x = 40; x < 80; x++) setPixel(wide, x, y, [255, 255, 255, 1]);
  const a = applyFilter(cloneImage(wide), 'gaussian-blur', { radius: 20 });
  const b = applyFilter(cloneImage(wide), 'gaussian-blur', { radius: 20.01 });
  for (let x = 0; x < 80; x++) assert.ok(Math.abs(a.data[(4 * 80 + x) * 4] - b.data[(4 * 80 + x) * 4]) <= 3, `box approx at x=${x}`);
});

test('blurs of a transparent-edged image do not darken the edges', () => {
  for (const [k, p] of [['gaussian-blur', { radius: 1.5 }], ['gaussian-blur', { radius: 25 }], ['box-blur', { radius: 2 }], ['motion-blur', { angle: 45, distance: 5 }], ['radial-blur', { amount: 30 }], ['radial-blur', { amount: 30, method: 'zoom' }]]) {
    const img = createImage(24, 24);
    for (let y = 4; y < 20; y++) for (let x = 4; x < 20; x++) setPixel(img, x, y, [255, 40, 0, 1]);
    applyFilter(img, k, p);
    let partial = 0;
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 24; x++) {
        const [r, g, b, a] = getPixel(img, x, y);
        if (a * 255 < 1) continue;
        if (a < 1) partial++;
        assert.ok(r >= 253 && Math.abs(g - 40) <= 2 && b <= 1, `${k} ${JSON.stringify(p)} at ${x},${y}: ${r},${g},${b},${a}`);
      }
    }
    assert.ok(partial > 0, `${k}: alpha spread`);
  }
  // quadrant image: the red corner keeps its colour next to the transparent border
  const q = applyFilter(quadrantImage(16), 'gaussian-blur', { radius: 1 });
  const corner = getPixel(q, 1, 1);
  assert.ok(corner[0] >= 254 && corner[1] <= 1 && corner[2] <= 1 && corner[3] < 1, `${corner}`);
  const border = getPixel(q, 0, 3);
  assert.ok(border[3] > 0 && border[0] >= 254, `${border}`);
});

test('box blur of a step edge gives the expected linear ramp', () => {
  const img = createImage(16, 3);
  for (let y = 0; y < 3; y++) for (let x = 0; x < 16; x++) setPixel(img, x, y, x >= 8 ? [255, 255, 255, 1] : [0, 0, 0, 1]);
  applyFilter(img, 'box-blur', { radius: 2 });
  const row = Array.from({ length: 16 }, (_, x) => img.data[(1 * 16 + x) * 4]);
  assert.deepEqual(row.slice(4, 12), [0, 0, 51, 102, 153, 204, 255, 255]);
  // a vertical step behaves the same (separable), and the result is identical in every column
  const v = createImage(3, 16);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 3; x++) setPixel(v, x, y, y >= 8 ? [255, 255, 255, 1] : [0, 0, 0, 1]);
  applyFilter(v, 'box-blur', { radius: 2 });
  assert.deepEqual(Array.from({ length: 8 }, (_, k) => v.data[((k + 4) * 3 + 2) * 4]), [0, 0, 51, 102, 153, 204, 255, 255]);
  // fractional radius: ends weighted by the fraction -> window 1 + 2 + 2 * 0.5 = 6
  const f = createImage(16, 1);
  for (let x = 0; x < 16; x++) setPixel(f, x, 0, x >= 8 ? [255, 255, 255, 1] : [0, 0, 0, 1]);
  applyFilter(f, 'box-blur', { radius: 2.5 });
  assert.equal(f.data[5 * 4], Math.round((0.5 * 255) / 6));
  assert.equal(f.data[8 * 4], Math.round((3.5 * 255) / 6));
});

test('motion blur spreads along the angle only', () => {
  const n = 25, c = 12;
  for (const [angle, horizontal] of [[0, true], [90, false], [180, true], [-90, false]]) {
    const img = dotImage(n, [0, 0, 0, 1], [255, 255, 255, 1]);
    applyFilter(img, 'motion-blur', { angle, distance: 8 });
    let along = 0;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const v = img.data[(y * n + x) * 4];
        const onLine = horizontal ? y === c : x === c;
        if (!onLine) assert.equal(v, 0, `angle ${angle}: off-line pixel ${x},${y} = ${v}`);
        else along += v;
        if (onLine && Math.abs((horizontal ? x : y) - c) > 4 + 3) assert.equal(v, 0, 'length limited to the distance (+ bilinear roll-off)');
      }
    }
    assert.ok(Math.abs(along - 255) <= 255 * 0.02, `mass ${along}`);
    const k = horizontal ? (d) => img.data[(c * n + c + d) * 4] : (d) => img.data[((c + d) * n + c) * 4];
    for (let d = 1; d <= 3; d++) assert.equal(k(d), k(-d), 'symmetric');
    assert.ok(k(3) > 15, `spread reaches 3 px: ${k(3)}`);
  }
  // 45 degrees: up-right diagonal, nothing on the other diagonal
  const img = dotImage(n, [0, 0, 0, 1], [255, 255, 255, 1]);
  applyFilter(img, 'motion-blur', { angle: 45, distance: 8 });
  assert.ok(img.data[((c - 2) * n + c + 2) * 4] > 10, 'up-right');
  assert.ok(img.data[((c + 2) * n + c - 2) * 4] > 10, 'down-left');
  assert.equal(img.data[((c - 2) * n + c - 2) * 4], 0, 'not up-left');
  assert.equal(img.data[((c + 2) * n + c + 2) * 4], 0, 'not down-right');
});

test('radial blur: spin keeps the centre, zoom keeps the rays, flat stays flat', () => {
  const flat = applyFilter(solidImage(16, 16, [90, 120, 200, 1]), 'radial-blur', { amount: 80, method: 'spin' });
  for (let i = 0; i < flat.data.length; i += 4) assertPixel([flat.data[i], flat.data[i + 1], flat.data[i + 2], flat.data[i + 3] / 255], [90, 120, 200, 1], 0);
  // A horizontal line through the centre: zoom moves pixels along the line only, spin smears it off the line.
  const line = () => {
    const img = solidImage(33, 33, [0, 0, 0, 1]);
    for (let x = 0; x < 33; x++) setPixel(img, x, 16, [255, 255, 255, 1]);
    return img;
  };
  const zoom = applyFilter(line(), 'radial-blur', { amount: 50, method: 'zoom' });
  for (let x = 0; x < 33; x++) assert.ok(zoom.data[(16 * 33 + x) * 4] >= 250, `zoom keeps the ray at ${x}`);
  assert.equal(zoom.data[(5 * 33 + 30) * 4], 0, 'zoom does not leave the ray');
  const spin = applyFilter(line(), 'radial-blur', { amount: 40, method: 'spin' });
  assert.ok(spin.data[(16 * 33 + 30) * 4] < 200, 'spin smears the far end of the line');
  assert.ok(spin.data[(14 * 33 + 30) * 4] > 10, 'spin moves mass off the line');
  assert.ok(spin.data[(16 * 33 + 16) * 4] >= 250, 'centre is unchanged');
});

test('unsharp mask, sharpen and smart sharpen increase local contrast at an edge', () => {
  const step = () => {
    const img = createImage(20, 5);
    for (let y = 0; y < 5; y++) for (let x = 0; x < 20; x++) setPixel(img, x, y, x >= 10 ? [192, 192, 192, 1] : [64, 64, 64, 1]);
    return img;
  };
  for (const [k, p] of [['unsharp-mask', { amount: 100, radius: 1 }], ['sharpen', {}], ['smart-sharpen', { amount: 150 }]]) {
    const img = applyFilter(step(), k, p);
    const v = (x) => img.data[(2 * 20 + x) * 4];
    assert.ok(v(9) < 64, `${k}: dark side darker (${v(9)})`);
    assert.ok(v(10) > 192, `${k}: bright side brighter (${v(10)})`);
    assert.equal(v(2), 64, `${k}: flat area untouched`);
    assert.equal(v(17), 192, `${k}: flat area untouched`);
    assert.equal(img.data[(2 * 20 + 9) * 4 + 3], 255, 'alpha kept');
  }
  // threshold above the edge contrast leaves everything alone
  const img = applyFilter(step(), 'unsharp-mask', { amount: 200, radius: 1, threshold: 200 });
  assert.deepEqual(img.data, step().data);
  // amount scales the overshoot
  const a = applyFilter(step(), 'unsharp-mask', { amount: 50 }).data[(2 * 20 + 9) * 4];
  const b = applyFilter(step(), 'unsharp-mask', { amount: 200 }).data[(2 * 20 + 9) * 4];
  assert.ok(b < a && a < 64);
});

test('high pass: flat image is mid grey, edges keep detail, alpha kept', () => {
  const flat = applyFilter(solidImage(12, 12, [200, 30, 99, 0.6]), 'high-pass', { radius: 3 });
  for (let i = 0; i < flat.data.length; i += 4) {
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(flat.data[i + c] - 128) <= 1, `${flat.data[i + c]}`);
    assert.equal(flat.data[i + 3], 153);
  }
  const g = applyFilter(gradientImage(16, 4), 'high-pass', { radius: 30 });
  assert.ok(g.data[0] < 128 && g.data[15 * 4] > 128, 'dark end below, bright end above mid grey');
});

test('add noise: deterministic for a seed, mean preserving, alpha kept', () => {
  const base = () => solidImage(48, 48, [128, 100, 160, 1]);
  for (const p of [{ amount: 10 }, { amount: 10, distribution: 'gaussian' }, { amount: 10, monochromatic: true }, { amount: 10, distribution: 'gaussian', monochromatic: true }]) {
    const a = applyFilter(base(), 'add-noise', { ...p, seed: 7 });
    const b = applyFilter(base(), 'add-noise', { ...p, seed: 7 });
    const c = applyFilter(base(), 'add-noise', { ...p, seed: 8 });
    assert.deepEqual(a.data, b.data, 'same seed, same noise');
    assert.notDeepEqual(a.data, c.data, 'different seed, different noise');
    const n = 48 * 48;
    assertNear(channelSum(a, 0) / n, 128, 0.75, `${JSON.stringify(p)} mean r`);
    assertNear(channelSum(a, 1) / n, 100, 0.75, `${JSON.stringify(p)} mean g`);
    assertNear(channelSum(a, 2) / n, 160, 0.75, `${JSON.stringify(p)} mean b`);
    let changed = 0, maxDev = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      assert.equal(a.data[i + 3], 255);
      if (a.data[i] !== 128) changed++;
      maxDev = Math.max(maxDev, Math.abs(a.data[i] - 128));
      if (p.monochromatic) assert.equal(a.data[i] - 128, a.data[i + 1] - 100, 'monochromatic: same offset per channel');
    }
    assert.ok(changed > n * 0.8, 'most pixels change');
    if (!p.distribution) assert.ok(maxDev <= Math.ceil(0.1 * 127.5), `uniform stays within +-amount: ${maxDev}`);
  }
  // transparent pixels are left alone
  const t = applyFilter(createImage(4, 4), 'add-noise', { amount: 100 });
  assert.ok(t.data.every((v) => v === 0));
});

test('median removes a single outlier; dust & scratches respects its threshold', () => {
  const img = dotImage(9, [100, 150, 200, 1], [255, 0, 0, 1], 4, 4);
  applyFilter(img, 'median', { radius: 1 });
  for (let i = 0; i < img.data.length; i += 4) assertPixel([img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3] / 255], [100, 150, 200, 1], 0);
  // median of a 3x3 window is exact
  const g = createImage(3, 3);
  [10, 50, 20, 90, 30, 70, 40, 80, 60].forEach((v, k) => setPixel(g, k % 3, Math.floor(k / 3), [v, 255 - v, v, 1]));
  applyFilter(g, 'median', { radius: 1 });
  assert.equal(g.data[(1 * 3 + 1) * 4], 50);
  assert.equal(g.data[(1 * 3 + 1) * 4 + 1], 205);
  // transparent pixels do not vote with their (black) colour
  const t = solidImage(5, 5, [200, 200, 200, 1]);
  for (const [x, y] of [[1, 1], [2, 1], [3, 1], [1, 2]]) setPixel(t, x, y, [0, 0, 0, 0]);
  applyFilter(t, 'median', { radius: 1 });
  assert.equal(getPixel(t, 2, 2)[0], 200);
  // dust & scratches: threshold above the outlier's difference keeps it
  const d1 = applyFilter(dotImage(9, [100, 100, 100, 1], [140, 140, 140, 1]), 'dust-scratches', { radius: 1, threshold: 50 });
  assert.equal(getPixel(d1, 4, 4)[0], 140);
  const d2 = applyFilter(dotImage(9, [100, 100, 100, 1], [140, 140, 140, 1]), 'dust-scratches', { radius: 1, threshold: 20 });
  assert.equal(getPixel(d2, 4, 4)[0], 100);
});

test('surface blur, reduce noise and despeckle smooth noise but keep strong edges', () => {
  const noisy = () => {
    const img = createImage(20, 10);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 20; x++) {
      const base = x < 10 ? 60 : 200, n = ((x * 7 + y * 3) % 5) - 2; // +-2 texture
      setPixel(img, x, y, [base + n * 3, base + n * 3, base + n * 3, 1]);
    }
    return img;
  };
  for (const [k, p] of [['surface-blur', { radius: 3, threshold: 15 }], ['reduce-noise', { strength: 6 }], ['despeckle', {}]]) {
    const img = applyFilter(noisy(), k, p);
    const src = noisy();
    let before = 0, after = 0;
    for (let y = 0; y < 10; y++) {
      for (let x = 2; x < 8; x++) {
        before += Math.abs(src.data[(y * 20 + x) * 4] - 60);
        after += Math.abs(img.data[(y * 20 + x) * 4] - 60);
      }
    }
    assert.ok(after < before * 0.75, `${k} smooths: ${after} vs ${before}`);
    assert.ok(img.data[(5 * 20 + 9) * 4] < 80 && img.data[(5 * 20 + 10) * 4] > 180, `${k} keeps the edge`);
  }
});

test('mosaic produces constant blocks with the premultiplied block average', () => {
  const img = gradientImage(16, 8);
  const src = cloneImage(img);
  applyFilter(img, 'mosaic', { size: 4 });
  for (let by = 0; by < 8; by += 4) {
    for (let bx = 0; bx < 16; bx += 4) {
      let sum = 0;
      for (let y = by; y < by + 4; y++) for (let x = bx; x < bx + 4; x++) sum += src.data[(y * 16 + x) * 4];
      const expected = Math.round(sum / 16);
      for (let y = by; y < by + 4; y++) for (let x = bx; x < bx + 4; x++) assertPixel(getPixel(img, x, y), [expected, expected, expected, 1], 0, `block ${bx},${by}`);
    }
  }
  // a block that is half transparent keeps the opaque colour at half alpha
  const t = createImage(2, 2);
  setPixel(t, 0, 0, [255, 0, 0, 1]);
  setPixel(t, 1, 0, [255, 0, 0, 1]);
  applyFilter(t, 'mosaic', { size: 2 });
  assertPixel(getPixel(t, 1, 1), [255, 0, 0, 0.5], 1);
});

test('crystallize, pointillize and fragment', () => {
  const src = gradientImage(32, 32);
  const a = applyFilter(cloneImage(src), 'crystallize', { size: 6, seed: 3 });
  const b = applyFilter(cloneImage(src), 'crystallize', { size: 6, seed: 3 });
  const c = applyFilter(cloneImage(src), 'crystallize', { size: 6, seed: 4 });
  assert.deepEqual(a.data, b.data);
  assert.notDeepEqual(a.data, c.data);
  const colours = new Set();
  for (let i = 0; i < a.data.length; i += 4) colours.add(a.data[i]);
  assert.ok(colours.size > 10 && colours.size < 60, `few flat cells: ${colours.size}`);
  // a flat image stays flat (cell average of one colour)
  const flat = applyFilter(solidImage(16, 16, [10, 200, 30, 1]), 'crystallize', { size: 5 });
  for (let i = 0; i < flat.data.length; i += 4) assertPixel([flat.data[i], flat.data[i + 1], flat.data[i + 2], flat.data[i + 3] / 255], [10, 200, 30, 1], 0);
  // pointillize: dots of the image colour on a white background
  const p = applyFilter(solidImage(32, 32, [0, 0, 255, 1]), 'pointillize', { size: 8, seed: 2 });
  let white = 0, blue = 0;
  for (let i = 0; i < p.data.length; i += 4) {
    const px = [p.data[i], p.data[i + 1], p.data[i + 2]];
    if (px[0] === 255 && px[1] === 255 && px[2] === 255) white++;
    else if (px[0] === 0 && px[1] === 0 && px[2] === 255) blue++;
  }
  assert.equal(white + blue, 32 * 32);
  assert.ok(white > 50 && blue > 300, `${white} white, ${blue} blue`);
  // fragment: average of the four (+-4, +-4) copies
  const fimg = dotImage(17, [0, 0, 0, 1], [200, 200, 200, 1], 8, 8);
  applyFilter(fimg, 'fragment');
  for (const [x, y] of [[4, 4], [12, 4], [4, 12], [12, 12]]) assert.equal(getPixel(fimg, x, y)[0], 50);
  assert.equal(getPixel(fimg, 8, 8)[0], 0);
});

test('distortions with zero strength are the identity; twirl/pinch/spherize move pixels', () => {
  const src = quadrantImage(16);
  for (const [k, p] of [['twirl', { angle: 0 }], ['pinch', { amount: 0 }], ['spherize', { amount: 0 }], ['zigzag', { amount: 0 }], ['ripple', { amount: 0 }], ['wave', { amplitude: 0 }], ['shear', {}], ['offset', { dx: 0, dy: 0 }]]) {
    assert.deepEqual(applyFilter(cloneImage(src), k, p).data, src.data, k);
  }
  const g = gradientImage(32, 32);
  for (const [k, p] of [['twirl', { angle: 90 }], ['pinch', { amount: 80 }], ['spherize', { amount: 80 }], ['zigzag', { amount: 50 }]]) {
    const out = applyFilter(cloneImage(g), k, p);
    assert.notDeepEqual(out.data, g.data, k);
    // the image corners are outside the effect circle/ellipse and stay put
    assert.deepEqual(getPixel(out, 0, 0), getPixel(g, 0, 0), `${k} corner`);
    assert.deepEqual(getPixel(out, 31, 31), getPixel(g, 31, 31), `${k} corner`);
  }
  // twirl by 180 degrees turns the centre pixel's neighbourhood around: left of centre becomes bright
  const tw = applyFilter(gradientImage(33, 33), 'twirl', { angle: 180 });
  assert.ok(getPixel(tw, 15, 16)[0] > getPixel(tw, 17, 16)[0]);
  // pinch pulls content towards the centre: the pixel right of centre samples further right
  const pn = applyFilter(gradientImage(33, 33), 'pinch', { amount: 60 });
  assert.ok(getPixel(pn, 20, 16)[0] > getPixel(gradientImage(33, 33), 20, 16)[0]);
  const sp = applyFilter(gradientImage(33, 33), 'spherize', { amount: 60 });
  assert.ok(getPixel(sp, 20, 16)[0] < getPixel(gradientImage(33, 33), 20, 16)[0], 'spherize magnifies the centre');
});

test('offset shifts pixels exactly (wrap, transparent, repeat)', () => {
  const src = createImage(4, 3);
  for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) setPixel(src, x, y, [x * 60, y * 100, 7, 1]);
  const w = applyFilter(cloneImage(src), 'offset', { dx: 1, dy: 2, wrap: true });
  for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) assert.deepEqual(getPixel(w, x, y), getPixel(src, (x + 3) % 4, (y + 1) % 3), `${x},${y}`);
  const n = applyFilter(cloneImage(src), 'offset', { dx: -5, dy: 7, wrap: true }); // multiple turns
  for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) assert.deepEqual(getPixel(n, x, y), getPixel(src, (x + 5) % 4, (((y - 7) % 3) + 3) % 3));
  const t = applyFilter(cloneImage(src), 'offset', { dx: 1, dy: 0, wrap: false });
  assert.deepEqual(getPixel(t, 0, 1), [0, 0, 0, 0]);
  assert.deepEqual(getPixel(t, 3, 1), getPixel(src, 2, 1));
  const r = applyFilter(cloneImage(src), 'offset', { dx: 2, dy: 0, wrap: false, edge: 'repeat' });
  assert.deepEqual(getPixel(r, 1, 2), getPixel(src, 0, 2));
});

test('wave, ripple and shear edge modes; polar round trip', () => {
  const src = gradientImage(16, 16);
  // wrap: a shift by exactly one wavelength-free square wave of amplitude 4 (rows) samples wrapped pixels
  const sq = applyFilter(cloneImage(src), 'wave', { amplitude: 4, wavelength: 1000, type: 'square', edge: 'wrap' });
  // rows y < 500 -> dx = +4 (sample to the right), columns -> dy = +4 (rows do not change a horizontal gradient)
  for (let x = 0; x < 16; x++) assert.deepEqual(getPixel(sq, x, 5), getPixel(src, (x + 4) % 16, 9));
  const tr = applyFilter(cloneImage(src), 'wave', { amplitude: 4, wavelength: 1000, type: 'square' });
  assert.equal(getPixel(tr, 13, 5)[3], 0, 'transparent edge');
  const rp = applyFilter(cloneImage(src), 'wave', { amplitude: 4, wavelength: 1000, type: 'square', edge: 'repeat' });
  assert.deepEqual(getPixel(rp, 13, 5), getPixel(src, 15, 9), 'repeat edge');
  // shear: a constant dx = 0.25 moves every row right by width / 8 = 2 px
  const sh = applyFilter(cloneImage(src), 'shear', { points: [[0, 0.25], [1, 0.25]], edge: 'wrap' });
  for (let x = 0; x < 16; x++) assert.deepEqual(getPixel(sh, x, 3), getPixel(src, (x + 14) % 16, 3));
  // ripple displaces but keeps the image opaque with repeat
  const ri = applyFilter(cloneImage(src), 'ripple', { amount: 300, edge: 'repeat' });
  assert.notDeepEqual(ri.data, src.data);
  for (let i = 3; i < ri.data.length; i += 4) assert.equal(ri.data[i], 255);
  // polar: to polar and back again approximately restores the image away from the centre/seam
  const img = gradientImage(64, 64);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) setPixel(img, x, y, [x * 4, y * 4, 128, 1]);
  const back = applyFilter(applyFilter(cloneImage(img), 'polar', { toPolar: true }), 'polar', { toPolar: false });
  let err = 0, count = 0;
  for (let y = 16; y < 48; y++) for (let x = 8; x < 56; x++) {
    err += Math.abs(back.data[(y * 64 + x) * 4 + 1] - img.data[(y * 64 + x) * 4 + 1]);
    count++;
  }
  assert.ok(err / count < 6, `polar round trip error ${err / count}`);
  // to polar: the source's top row lands in the centre
  const top = createImage(16, 16);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) setPixel(top, x, y, y < 4 ? [255, 0, 0, 1] : [0, 0, 255, 1]);
  const pol = applyFilter(top, 'polar', { toPolar: true });
  assert.deepEqual(getPixel(pol, 8, 8), [255, 0, 0, 1], 'centre comes from the top rows');
  assert.deepEqual(getPixel(pol, 8, 13), [0, 0, 255, 1], 'outer ring from the lower rows');
  assert.equal(getPixel(pol, 0, 0)[3], 0, 'outside the ellipse is transparent');
});

test('emboss of a flat image is flat grey with alpha kept; relief follows the light', () => {
  const img = applyFilter(solidImage(10, 10, [200, 50, 90, 0.4]), 'emboss', { angle: 135, height: 3, amount: 250 });
  for (let i = 0; i < img.data.length; i += 4) assert.deepEqual([...img.data.subarray(i, i + 4)], [128, 128, 128, 102]);
  // a bright square lit from the left: its left edge is bright, its right edge dark
  const sq = solidImage(20, 20, [0, 0, 0, 1]);
  for (let y = 6; y < 14; y++) for (let x = 6; x < 14; x++) setPixel(sq, x, y, [255, 255, 255, 1]);
  applyFilter(sq, 'emboss', { angle: 180, height: 2, amount: 100 });
  assert.ok(getPixel(sq, 6, 10)[0] > 200, `left edge ${getPixel(sq, 6, 10)}`);
  assert.ok(getPixel(sq, 13, 10)[0] < 60, `right edge ${getPixel(sq, 13, 10)}`);
  assert.equal(getPixel(sq, 10, 10)[0], 128, 'flat inside');
  const p = getPixel(sq, 3, 3);
  assert.ok(p[0] === p[1] && p[1] === p[2], 'grey');
});

test('find edges: flat is white, a step is a dark line; glowing edges is the bright inverse', () => {
  const flat = applyFilter(solidImage(8, 8, [30, 140, 250, 0.5]), 'find-edges');
  for (let i = 0; i < flat.data.length; i += 4) assert.deepEqual([...flat.data.subarray(i, i + 4)], [255, 255, 255, 128]);
  const step = () => {
    const img = createImage(12, 6);
    for (let y = 0; y < 6; y++) for (let x = 0; x < 12; x++) setPixel(img, x, y, x >= 6 ? [255, 255, 255, 1] : [0, 0, 0, 1]);
    return img;
  };
  const e = applyFilter(step(), 'find-edges');
  assert.equal(getPixel(e, 5, 3)[0], 0, 'full step -> black');
  assert.equal(getPixel(e, 2, 3)[0], 255);
  assert.equal(getPixel(e, 9, 3)[0], 255);
  const g = applyFilter(step(), 'glowing-edges', { width: 2, brightness: 6 });
  assert.equal(getPixel(g, 5, 3)[0], 255, 'edge glows');
  assert.equal(getPixel(g, 2, 3)[0], 0, 'black elsewhere');
  // a transparent neighbour is not an edge
  const t = solidImage(6, 6, [100, 100, 100, 1]);
  setPixel(t, 3, 3, [0, 0, 0, 0]);
  const te = applyFilter(t, 'find-edges');
  assert.equal(getPixel(te, 2, 2)[0], 255);
});

test('solarize and invert alpha give exact values', () => {
  const img = createImage(6, 1);
  [0, 100, 127, 128, 200, 255].forEach((v, x) => setPixel(img, x, 0, [v, 255 - v, v, (x * 50) / 255]));
  const s = applyFilter(cloneImage(img), 'solarize');
  assert.deepEqual(Array.from({ length: 6 }, (_, x) => s.data[x * 4]), [0, 100, 127, 127, 55, 0]);
  assert.deepEqual(Array.from({ length: 6 }, (_, x) => s.data[x * 4 + 1]), [0, 100, 127, 127, 55, 0]); // 255 - v
  assert.deepEqual(Array.from({ length: 6 }, (_, x) => s.data[x * 4 + 3]), [0, 50, 100, 150, 200, 250], 'solarize keeps alpha');
  const a = applyFilter(cloneImage(img), 'invert-alpha');
  assert.deepEqual(Array.from({ length: 6 }, (_, x) => a.data[x * 4 + 3]), [255, 205, 155, 105, 55, 5]);
  for (let x = 0; x < 6; x++) assert.deepEqual([...a.data.subarray(x * 4, x * 4 + 3)], [...img.data.subarray(x * 4, x * 4 + 3)]);
  assert.deepEqual(applyFilter(a, 'invert-alpha').data, img.data, 'involution');
});

test('diffuse is seeded, moves pixels only between neighbours, darken/lighten modes', () => {
  const src = patternImage(16, 16);
  const a = applyFilter(cloneImage(src), 'diffuse', { seed: 5 });
  assert.deepEqual(a.data, applyFilter(cloneImage(src), 'diffuse', { seed: 5 }).data);
  assert.notDeepEqual(a.data, applyFilter(cloneImage(src), 'diffuse', { seed: 6 }).data);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const px = getPixel(a, x, y);
      let found = false;
      for (let dy = -1; dy <= 1 && !found; dy++) for (let dx = -1; dx <= 1 && !found; dx++) {
        const q = getPixel(src, Math.min(15, Math.max(0, x + dx)), Math.min(15, Math.max(0, y + dy)));
        found = q.every((v, c) => v === px[c]);
      }
      assert.ok(found, `pixel ${x},${y} comes from a neighbour`);
    }
  }
  const g = gradientImage(16, 4);
  const dk = applyFilter(cloneImage(g), 'diffuse', { mode: 'darken' });
  const lt = applyFilter(cloneImage(g), 'diffuse', { mode: 'lighten' });
  for (let i = 0; i < g.data.length; i += 4) {
    assert.ok(dk.data[i] <= g.data[i]);
    assert.ok(lt.data[i] >= g.data[i]);
  }
});

test('oil paint: flat stays flat, output colours come from the image', () => {
  const flat = applyFilter(solidImage(10, 10, [12, 34, 56, 1]), 'oil-paint', { radius: 3, levels: 10 });
  for (let i = 0; i < flat.data.length; i += 4) assert.deepEqual([...flat.data.subarray(i, i + 4)], [12, 34, 56, 255]);
  const q = applyFilter(quadrantImage(16), 'oil-paint', { radius: 2, levels: 20 });
  const px = getPixel(q, 4, 4);
  assertPixel(px, [255, 0, 0, 1], 0, 'inside the red quadrant');
});

test('clouds: deterministic for a seed, uses the colours, opaque; difference clouds', () => {
  const run = (seed, scale = 16, colors = ['#000000', '#ffffff']) => applyFilter(createImage(40, 30), 'clouds', { seed, scale, colors });
  const a = run(1), b = run(1), c = run(2);
  assert.deepEqual(a.data, b.data);
  assert.notDeepEqual(a.data, c.data);
  let lo = 255, hi = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    assert.equal(a.data[i + 3], 255);
    assert.equal(a.data[i], a.data[i + 1]);
    lo = Math.min(lo, a.data[i]);
    hi = Math.max(hi, a.data[i]);
  }
  assert.ok(hi - lo > 100, `contrast ${lo}..${hi}`);
  // neighbouring pixels are similar (smooth noise), far pixels are not all equal
  let jump = 0;
  for (let x = 1; x < 40; x++) jump = Math.max(jump, Math.abs(a.data[(10 * 40 + x) * 4] - a.data[(10 * 40 + x - 1) * 4]));
  assert.ok(jump < 60, `smooth: ${jump}`);
  // colours: every pixel lies between fg and bg
  const col = run(3, 16, ['#ff0000', '#0000ff']);
  for (let i = 0; i < col.data.length; i += 4) {
    assert.equal(col.data[i + 1], 0);
    assert.ok(Math.abs(col.data[i] + col.data[i + 2] - 255) <= 1);
  }
  const fgbg = applyFilter(createImage(40, 30), 'clouds', { seed: 3, scale: 16, fg: '#ff0000', bg: '#0000ff' });
  assert.deepEqual(fgbg.data, col.data, 'fg/bg override colors');
  // difference clouds over black = clouds; over white = inverted clouds
  const black = applyFilter(solidImage(40, 30, [0, 0, 0, 1]), 'difference-clouds', { seed: 1, scale: 16 });
  assert.deepEqual(black.data, a.data);
  const white = applyFilter(solidImage(40, 30, [255, 255, 255, 1]), 'difference-clouds', { seed: 1, scale: 16 });
  for (let i = 0; i < white.data.length; i += 4) assert.equal(white.data[i], 255 - a.data[i]);
});

test('lens flare brightens around its centre more than far away', () => {
  const img = applyFilter(solidImage(64, 48, [20, 20, 20, 1]), 'lens-flare', { center: { x: 0.25, y: 0.25 }, brightness: 100 });
  const at = (x, y) => luminance(...getPixel(img, x, y).slice(0, 3));
  assert.ok(at(16, 12) > 240, `centre ${at(16, 12)}`);
  assert.ok(at(60, 46) < at(30, 20), 'falls off');
  for (let i = 3; i < img.data.length; i += 4) assert.equal(img.data[i], 255);
  const dim = applyFilter(solidImage(64, 48, [20, 20, 20, 1]), 'lens-flare', { center: { x: 0.25, y: 0.25 }, brightness: 30 });
  assert.ok(luminance(...getPixel(dim, 24, 12).slice(0, 3)) < at(24, 12));
});

test('vignette darkens corners more than the centre', () => {
  for (const roundness of [-100, 0, 100]) {
    const img = applyFilter(solidImage(40, 24, [200, 200, 200, 1]), 'vignette', { amount: -60, size: 0.3, roundness });
    const centre = getPixel(img, 20, 12)[0], edge = getPixel(img, 0, 12)[0], corner = getPixel(img, 0, 0)[0];
    assert.equal(centre, 200, 'centre untouched');
    assert.ok(corner < edge && edge < centre, `roundness ${roundness}: ${corner} < ${edge} < ${centre}`);
    assertNear(corner, 200 * 0.4, 6, 'corner gets the full amount');
    assert.equal(getPixel(img, 0, 0)[3], 1, 'alpha kept');
  }
  const light = applyFilter(solidImage(20, 20, [100, 100, 100, 1]), 'vignette', { amount: 50, size: 0.2 });
  assert.ok(getPixel(light, 0, 0)[0] > 150 && getPixel(light, 10, 10)[0] === 100, 'positive amount lightens');
  assert.ok(FILTERS.vignette.defaults.amount < 0, 'default darkens');
});

test('maximum and minimum grow and shrink a single pixel', () => {
  const max = applyFilter(dotImage(7, [0, 0, 0, 1], [255, 255, 255, 1]), 'maximum', { radius: 1 });
  const min = applyFilter(dotImage(7, [0, 0, 0, 1], [255, 255, 255, 1]), 'minimum', { radius: 1 });
  const minDark = applyFilter(dotImage(7, [255, 255, 255, 1], [0, 0, 0, 1]), 'minimum', { radius: 2 });
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      const near1 = Math.abs(x - 3) <= 1 && Math.abs(y - 3) <= 1, near2 = Math.abs(x - 3) <= 2 && Math.abs(y - 3) <= 2;
      assert.equal(getPixel(max, x, y)[0], near1 ? 255 : 0, `max ${x},${y}`);
      assert.equal(getPixel(min, x, y)[0], 0, `min ${x},${y}`);
      assert.equal(getPixel(minDark, x, y)[0], near2 ? 0 : 255, `min dark ${x},${y}`);
    }
  }
  // per channel and at the image border (clipped window)
  const c = createImage(4, 1);
  [[10, 200, 0], [50, 20, 0], [30, 40, 9], [0, 0, 0]].forEach((v, x) => setPixel(c, x, 0, [...v, 1]));
  applyFilter(c, 'maximum', { radius: 1 });
  assert.deepEqual([0, 1, 2, 3].map((x) => getPixel(c, x, 0).slice(0, 3)), [[50, 200, 0], [50, 200, 9], [50, 40, 9], [30, 40, 9]]);
  // transparent pixels neither vote nor change
  const t = solidImage(3, 1, [100, 100, 100, 1]);
  setPixel(t, 0, 0, [255, 255, 255, 0]);
  applyFilter(t, 'maximum', { radius: 1 });
  assert.deepEqual(getPixel(t, 1, 0), [100, 100, 100, 1]);
  assert.deepEqual(getPixel(t, 0, 0), [255, 255, 255, 0]);
});

test('custom kernel: identity, scale/offset, 5x5, validation', () => {
  const src = patternImage(9, 7);
  const id3 = applyFilter(cloneImage(src), 'custom', { kernel: [0, 0, 0, 0, 1, 0, 0, 0, 0], scale: 1, offset: 0 });
  assert.deepEqual(id3.data, src.data);
  const id5 = new Array(25).fill(0);
  id5[12] = 1;
  assert.deepEqual(applyFilter(cloneImage(src), 'custom', { kernel: id5 }).data, src.data);
  const so = applyFilter(solidImage(3, 3, [100, 50, 10, 1]), 'custom', { kernel: [0, 0, 0, 0, 2, 0, 0, 0, 0], scale: 4, offset: 20 });
  assertPixel(getPixel(so, 1, 1), [70, 45, 25, 1], 0);
  // a box kernel with scale 9 averages; a shift kernel moves the image by one pixel (edge replicated)
  const g = gradientImage(9, 3);
  const shift = applyFilter(cloneImage(g), 'custom', { kernel: [0, 0, 0, 0, 0, 1, 0, 0, 0] });
  for (let x = 0; x < 9; x++) assert.equal(getPixel(shift, x, 1)[0], getPixel(g, Math.min(8, x + 1), 1)[0]);
  const box = applyFilter(solidImage(5, 5, [90, 90, 90, 1]), 'custom', { kernel: new Array(9).fill(1), scale: 9 });
  assert.equal(getPixel(box, 2, 2)[0], 90);
  assert.throws(() => applyFilter(createImage(2, 2), 'custom', { kernel: [1, 2, 3] }), RangeError);
});

// ---------------------------------------------------------------------------------------------
// Review regressions: brute-force references and the bugs they caught

/** Antialiased grey image (8 x 8 supersampling) of inside(x, y), coordinates about the image centre. */
function aaImage(w, h, inside) {
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) if (inside(x + (i + 0.5) / 8 - w / 2, y + (j + 0.5) / 8 - h / 2)) s++;
      const v = Math.round((s / 64) * 255);
      setPixel(img, x, y, [v, v, v, 1]);
    }
  }
  return img;
}

/** Textured test image: checkerboard red, ramps in green and blue, a transparent corner when holed. */
function textureImage(w, h, holed = false) {
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = holed && x > w * 0.8 && y > h * 0.75 ? 0 : 1;
      setPixel(img, x, y, [((x >> 3) + (y >> 3)) % 2 ? 230 : 20, (x * 5 + y * 3) % 256, Math.round(Math.sin(x / 3) * Math.cos(y / 4) * 120 + 128), a]);
    }
  }
  return img;
}

/** Mean and max |a - b| over the colour channels of pixels inside [x0, x1) x [y0, y1) where keep(i) holds. */
function diffStats(a, b, x0 = 0, y0 = 0, x1 = a.width, y1 = a.height, keep = () => true) {
  let max = 0, sum = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * a.width + x) * 4;
      if (!keep(i)) continue;
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(a.data[i + c] - b.data[i + c]);
        max = Math.max(max, d);
        sum += d;
        n++;
      }
    }
  }
  return { max, mean: sum / n };
}

/** Rect run equals the whole-image run exactly inside rect and leaves the outside alone. */
function assertRectMatches(src, kind, params, rect) {
  const full = applyFilter(cloneImage(src), kind, params);
  const part = applyFilter(cloneImage(src), kind, params, rect);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const inside = x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
      const i = (y * src.width + x) * 4;
      for (let c = 0; c < 4; c++) {
        const want = inside ? full.data[i + c] : src.data[i + c];
        assert.equal(part.data[i + c], want, `${kind} ${JSON.stringify(params)} at ${x},${y} c${c}`);
      }
    }
  }
}

test('smart sharpen: reduceNoise 0 is exactly unsharp mask, reduceNoise spares low-contrast noise only', () => {
  const noisy = () => {
    const rnd = randomSeeded(11), img = createImage(40, 20);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 40; x++) {
      const v = (x < 20 ? 100 : 180) + Math.round((rnd() - 0.5) * 12);
      setPixel(img, x, y, [v, v, v, 1]);
    }
    return img;
  };
  const plain = applyFilter(noisy(), 'smart-sharpen', { amount: 100, radius: 1, reduceNoise: 0 });
  assert.deepEqual(plain.data, applyFilter(noisy(), 'unsharp-mask', { amount: 100, radius: 1, threshold: 0 }).data);
  const src = noisy(), reduced = applyFilter(noisy(), 'smart-sharpen', { amount: 100, radius: 1, reduceNoise: 60 });
  const flat = (img) => diffStats(img, src, 3, 2, 15, 18).mean;
  assert.ok(flat(plain) > 2, `plain sharpening amplifies the noise (${flat(plain)})`);
  assert.ok(flat(reduced) < flat(plain) * 0.25, `reduceNoise leaves the noise alone (${flat(reduced)} vs ${flat(plain)})`);
  for (let y = 2; y < 18; y++) {
    assert.ok(reduced.data[(y * 40 + 19) * 4] < src.data[(y * 40 + 19) * 4], 'edge still sharpened (dark side)');
    assert.ok(reduced.data[(y * 40 + 20) * 4] > src.data[(y * 40 + 20) * 4], 'edge still sharpened (bright side)');
  }
});

test('crystallize: every pixel belongs to its nearest seed (exact Voronoi cells)', () => {
  // The seed lattice of filters.js, copied: one seed per size x size cell, jittered by a hash.
  const hash3 = (x, y, z) => {
    let h = (Math.imul(x | 0, 0x27d4eb2d) + Math.imul(y | 0, 0x165667b1) + Math.imul(z | 0, 0x9e3779b1)) | 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
  };
  const reference = (src, s, seed) => {
    const W = src.width, H = src.height, d = src.data, owner = new Array(W * H), sums = new Map();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const px = x + 0.5, py = y + 0.5, ci = Math.floor(px / s), cj = Math.floor(py / s);
        let best = '', bd = Infinity;
        for (let j = cj - 3; j <= cj + 3; j++) {
          for (let i = ci - 3; i <= ci + 3; i++) {
            const sx = (i + hash3(i, j, seed) / 4294967296) * s, sy = (j + hash3(i, j, seed ^ 0x5bd1e995) / 4294967296) * s;
            const dd = (sx - px) ** 2 + (sy - py) ** 2;
            if (dd < bd) [bd, best] = [dd, `${i},${j}`];
          }
        }
        owner[y * W + x] = best;
        const k = (y * W + x) * 4, a = d[k + 3], e = sums.get(best) || [0, 0, 0, 0, 0];
        e[0] += d[k] * a;
        e[1] += d[k + 1] * a;
        e[2] += d[k + 2] * a;
        e[3] += a;
        e[4]++;
        sums.set(best, e);
      }
    }
    const out = createImage(W, H);
    for (let q = 0; q < W * H; q++) {
      const e = sums.get(owner[q]), k = q * 4;
      for (let c = 0; c < 3; c++) out.data[k + c] = e[3] ? Math.round(e[c] / e[3]) : 0;
      out.data[k + 3] = Math.round(e[3] / e[4]);
    }
    return out;
  };
  const coords = (holes) => {
    const img = createImage(40, 40);
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) setPixel(img, x, y, [x * 6, y * 6, 100, holes && (x * y) % 7 === 0 ? 0 : 1]);
    return img;
  };
  // (7.5, 371) has a pixel whose nearest seed lies two cells away (a 3x3 search got it wrong)
  for (const [size, seed, holes] of [[7.5, 371, false], [4, 5, true], [10, 2, true], [3, 9, false]]) {
    const src = coords(holes), got = applyFilter(cloneImage(src), 'crystallize', { size, seed }), want = reference(src, size, seed);
    for (let i = 0; i < got.data.length; i++) assert.ok(Math.abs(got.data[i] - want.data[i]) <= 1, `size ${size} seed ${seed} at pixel ${i >> 2} c${i & 3}: ${got.data[i]} vs ${want.data[i]}`);
  }
});

test('motion blur: a sharp line kernel at any angle, close to a brute-force segment average', () => {
  // an antialiased edge parallel to the motion survives (the bilinear-pass version softened it by ~1 px)
  for (const angle of [10, 30, 63]) {
    const a = angle * Math.PI / 180, nx = Math.sin(a), ny = Math.cos(a);
    const edge = aaImage(120, 120, (x, y) => x * nx + y * ny > 0);
    const s = diffStats(applyFilter(cloneImage(edge), 'motion-blur', { angle, distance: 20 }), edge, 30, 30, 90, 90);
    assert.ok(s.mean < 1.1 && s.max < 58, `angle ${angle}: edge softened, mean ${s.mean} max ${s.max}`);
  }
  // brute force: mean of bilinear samples along the centred segment of length distance
  const src = textureImage(64, 56);
  for (const [angle, distance] of [[0, 9], [17, 12], [45, 15], [-60, 21], [100, 10]]) {
    const a = angle * Math.PI / 180, ux = Math.cos(a), uy = -Math.sin(a), N = Math.ceil(4 * distance) + 2, want = cloneImage(src), smp = [0, 0, 0, 0];
    for (let y = 0; y < 56; y++) {
      for (let x = 0; x < 64; x++) {
        const acc = [0, 0, 0];
        for (let k = 0; k < N; k++) {
          const t = -distance / 2 + (distance * k) / (N - 1);
          sampleBilinear(src, Math.min(63, Math.max(0, x + t * ux)), Math.min(55, Math.max(0, y + t * uy)), smp);
          for (let c = 0; c < 3; c++) acc[c] += smp[c];
        }
        for (let c = 0; c < 3; c++) want.data[(y * 64 + x) * 4 + c] = Math.round(acc[c] / N);
      }
    }
    const m = Math.ceil(distance / 2) + 2;
    const s = diffStats(applyFilter(cloneImage(src), 'motion-blur', { angle, distance }), want, m, m, 64 - m, 56 - m);
    assert.ok(s.mean < 1.6 && s.max < 25, `angle ${angle} distance ${distance}: mean ${s.mean} max ${s.max}`);
  }
  // the family of sheared lines is anchored to the image, so any rect gives the whole-image pixels
  const big = textureImage(211, 157, true);
  assertRectMatches(big, 'motion-blur', { angle: 23, distance: 90 }, { x: 61, y: 47, width: 83, height: 59 });
  assertRectMatches(big, 'motion-blur', { angle: 77, distance: 41 }, { x: 140, y: 3, width: 60, height: 100 });
});

test('radial blur: matches a brute-force arc / scale average, keeps circles sharp, rect independent', () => {
  const reference = (img, amount, method, center) => {
    const W = img.width, H = img.height, cx = center.x * W - 0.5, cy = center.y * H - 0.5, zoom = method === 'zoom';
    const span = zoom ? (amount / 100) * 0.8 : (amount * Math.PI) / 180, out = cloneImage(img), smp = [0, 0, 0, 0];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const N = Math.max(2, Math.ceil(3 * Math.hypot(x - cx, y - cy) * span) + 2), acc = [0, 0, 0, 0];
        for (let k = 0; k < N; k++) {
          const t = -span / 2 + (span * k) / (N - 1), c = Math.cos(t), s = Math.sin(t), e = Math.exp(t);
          const fx = zoom ? cx + e * (x - cx) : cx + c * (x - cx) - s * (y - cy), fy = zoom ? cy + e * (y - cy) : cy + s * (x - cx) + c * (y - cy);
          sampleBilinear(img, Math.min(W - 1, Math.max(0, fx)), Math.min(H - 1, Math.max(0, fy)), smp);
          const a = smp[3] / 255;
          for (let q = 0; q < 3; q++) acc[q] += smp[q] * a;
          acc[3] += a;
        }
        const i = (y * W + x) * 4;
        for (let q = 0; q < 3; q++) out.data[i + q] = acc[3] > 0 ? Math.round(acc[q] / acc[3]) : 0;
        out.data[i + 3] = Math.round((acc[3] / N) * 255);
      }
    }
    return out;
  };
  const src = textureImage(64, 48, true);
  for (const [amount, method, center] of [[20, 'spin', { x: 0.5, y: 0.5 }], [60, 'spin', { x: 0.3, y: 0.7 }], [100, 'spin', { x: 1.2, y: -0.3 }], [30, 'zoom', { x: 0.5, y: 0.5 }], [100, 'zoom', { x: 0.2, y: 0.6 }], [70, 'zoom', { x: -0.5, y: 1.5 }]]) {
    const got = applyFilter(cloneImage(src), 'radial-blur', { amount, method, center }), want = reference(src, amount, method, center);
    let amax = 0, asum = 0;
    for (let i = 3; i < got.data.length; i += 4) {
      amax = Math.max(amax, Math.abs(got.data[i] - want.data[i]));
      asum += Math.abs(got.data[i] - want.data[i]);
    }
    assert.ok(amax <= 12 && asum / (64 * 48) < 0.5, `${method} ${amount} alpha: max ${amax} mean ${asum / (64 * 48)}`);
    const s = diffStats(got, want, 0, 0, 64, 48, (i) => want.data[i + 3] >= 8);
    assert.ok(s.mean < 1.5, `${method} ${amount} ${JSON.stringify(center)}: mean ${s.mean} (max ${s.max})`);
  }
  // spin moves along circles about the centre: a centred disc keeps its antialiased edge
  const disc = aaImage(120, 120, (x, y) => x * x + y * y < 40 * 40);
  for (const amount of [10, 100]) {
    const s = diffStats(applyFilter(cloneImage(disc), 'radial-blur', { amount }), disc);
    assert.ok(s.mean < 0.85 && s.max < 60, `spin ${amount}: disc edge softened, mean ${s.mean} max ${s.max}`);
  }
  // the polar grid does not depend on the rect
  const big = textureImage(211, 157, true);
  assertRectMatches(big, 'radial-blur', { amount: 100, method: 'zoom', center: { x: 0.2, y: 0.7 } }, { x: 61, y: 47, width: 83, height: 59 });
  assertRectMatches(big, 'radial-blur', { amount: 70, center: { x: 0.45, y: 0.55 } }, { x: 61, y: 47, width: 83, height: 59 });
  assertRectMatches(big, 'radial-blur', { amount: 35, center: { x: 1.4, y: -0.2 } }, { x: 0, y: 100, width: 50, height: 57 });
});

test('median and dust & scratches match a brute-force window median at every radius', () => {
  const rnd = randomSeeded(21);
  const make = (w, h, opaque) => {
    const img = createImage(w, h);
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = Math.floor(((i >> 2) % w) * 9 + rnd() * 60) & 255;
      img.data[i + 1] = Math.floor(rnd() * 256);
      img.data[i + 2] = rnd() < 0.5 ? 10 : 240;
      const q = rnd();
      img.data[i + 3] = opaque ? 255 : q < 0.2 ? 0 : q < 0.4 ? Math.floor(rnd() * 255) : 255;
    }
    return img;
  };
  const reference = (img, rad) => {
    const { width: W, height: H, data: d } = img, out = new Uint8ClampedArray(d.length);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const vals = [[], [], [], []];
        for (let yy = Math.max(0, y - rad); yy <= Math.min(H - 1, y + rad); yy++) {
          for (let xx = Math.max(0, x - rad); xx <= Math.min(W - 1, x + rad); xx++) {
            const i = (yy * W + xx) * 4;
            vals[3].push(d[i + 3]);
            if (d[i + 3] > 0) for (let c = 0; c < 3; c++) vals[c].push(d[i + c]);
          }
        }
        const o = (y * W + x) * 4;
        for (let c = 0; c < 4; c++) {
          const v = vals[c].sort((a, b) => a - b);
          out[o + c] = v.length ? v[(v.length - 1) >> 1] : d[o + c];
        }
      }
    }
    return out;
  };
  // radii on both sides of the switch to the constant-time algorithm, windows clipped by the image
  for (const [w, h, opaque] of [[23, 17, false], [19, 21, true], [1, 9, false]]) {
    const src = make(w, h, opaque);
    for (const rad of [1, 2, 5, 9, 10, 12, 30]) {
      const want = reference(src, rad);
      assert.deepEqual(applyFilter(cloneImage(src), 'median', { radius: rad }).data, want, `median ${w}x${h} radius ${rad}`);
      for (const rect of [{ x: 3, y: 2, width: 9, height: 11 }, { x: w - 1, y: 0, width: 1, height: h }]) {
        const part = applyFilter(cloneImage(src), 'median', { radius: rad }, rect);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const inside = x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height, i = (y * w + x) * 4;
            for (let c = 0; c < 4; c++) assert.equal(part.data[i + c], inside ? want[i + c] : src.data[i + c], `median rect radius ${rad} at ${x},${y}`);
          }
        }
      }
      // dust & scratches: the median where any channel differs from it by more than threshold
      const ds = applyFilter(cloneImage(src), 'dust-scratches', { radius: rad, threshold: 40 }).data;
      for (let i = 0; i < ds.length; i += 4) {
        const far = [0, 1, 2, 3].some((c) => Math.abs(src.data[i + c] - want[i + c]) > 40);
        for (let c = 0; c < 4; c++) assert.equal(ds[i + c], far ? want[i + c] : src.data[i + c], `dust & scratches radius ${rad}`);
      }
    }
  }
});

test('gaussian blur: the opaque RGB-only path matches the premultiplied RGBA path', () => {
  const rnd = randomSeeded(5), opaque = createImage(48, 36);
  for (let i = 0; i < opaque.data.length; i++) opaque.data[i] = (i & 3) === 3 ? 255 : Math.floor(rnd() * 256);
  for (const radius of [0.8, 3, 12]) {
    const a = applyFilter(cloneImage(opaque), 'gaussian-blur', { radius });
    const general = cloneImage(opaque);
    general.data[3] = 254; // one non-opaque pixel in the corner forces the RGBA path
    const b = applyFilter(general, 'gaussian-blur', { radius });
    const reach = Math.ceil(3 * radius) + 1;
    for (let y = 0; y < 36; y++) {
      for (let x = 0; x < 48; x++) {
        const i = (y * 48 + x) * 4;
        assert.equal(a.data[i + 3], 255, 'opaque stays exactly opaque');
        if (x <= reach && y <= reach) continue;
        for (let c = 0; c < 4; c++) assert.ok(Math.abs(a.data[i + c] - b.data[i + c]) <= 1, `radius ${radius} at ${x},${y} c${c}: ${a.data[i + c]} vs ${b.data[i + c]}`);
      }
    }
  }
});

test('surface blur, oil paint, maximum and minimum match brute-force definitions (with alpha)', () => {
  const rnd = randomSeeded(8), W = 21, H = 15, src = createImage(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const q = rnd();
    setPixel(src, x, y, [(x * 11 + Math.floor(rnd() * 40)) % 256, Math.floor(rnd() * 256), y * 15, q < 0.15 ? 0 : q < 0.3 ? 0.5 : 1]);
  }
  const d = src.data, at = (x, y) => (y * W + x) * 4;
  const window = (x, y, rad, fn) => {
    for (let yy = Math.max(0, y - rad); yy <= Math.min(H - 1, y + rad); yy++) for (let xx = Math.max(0, x - rad); xx <= Math.min(W - 1, x + rad); xx++) fn(at(xx, yy));
  };
  // surface blur: alpha-weighted mean of the window values v_q with weight max(0, 1 - |v_q - v| / (2.5 threshold))
  for (const [radius, threshold] of [[2, 15], [4, 60]]) {
    const got = applyFilter(cloneImage(src), 'surface-blur', { radius, threshold }).data;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = at(x, y);
      assert.equal(got[i + 3], d[i + 3], 'surface blur keeps alpha');
      if (d[i + 3] === 0) continue;
      for (let c = 0; c < 3; c++) {
        let sw = 0, sv = 0;
        window(x, y, radius, (j) => {
          const wt = d[j + 3] * Math.max(0, 1 - Math.abs(d[j + c] - d[i + c]) / (2.5 * threshold));
          sw += wt;
          sv += wt * d[j + c];
        });
        assert.ok(Math.abs(got[i + c] - sv / sw) <= 0.5 + 1e-9, `surface blur ${radius}/${threshold} at ${x},${y} c${c}: ${got[i + c]} vs ${sv / sw}`);
      }
    }
  }
  // oil paint: the (alpha-weighted) most common luminance bin of the window, lowest bin on ties, averaged
  for (const [radius, levels] of [[1, 8], [3, 20]]) {
    const got = applyFilter(cloneImage(src), 'oil-paint', { radius, levels }).data;
    const bin = (j) => (Math.floor(luminance(d[j], d[j + 1], d[j + 2]) + 0.5) * levels) >> 8;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const cnt = new Array(levels).fill(0), sums = Array.from({ length: levels }, () => [0, 0, 0]), i = at(x, y);
      window(x, y, radius, (j) => {
        const b = bin(j), a = d[j + 3];
        cnt[b] += a;
        for (let c = 0; c < 3; c++) sums[b][c] += d[j + c] * a;
      });
      const best = cnt.indexOf(Math.max(...cnt));
      for (let c = 0; c < 3; c++) assert.equal(got[i + c], cnt[best] ? Math.round(sums[best][c] / cnt[best]) : d[i + c], `oil paint ${radius}/${levels} at ${x},${y}`);
      assert.equal(got[i + 3], d[i + 3]);
    }
  }
  // maximum / minimum: per channel over the window's non-transparent pixels; transparent pixels unchanged
  for (const [kind, radius] of [['maximum', 2], ['minimum', 3], ['maximum', 9]]) {
    const got = applyFilter(cloneImage(src), kind, { radius }).data;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = at(x, y);
      if (d[i + 3] === 0) {
        assert.deepEqual([...got.subarray(i, i + 4)], [...d.subarray(i, i + 4)], `${kind}: transparent pixel untouched`);
        continue;
      }
      for (let c = 0; c < 3; c++) {
        let v = kind === 'maximum' ? 0 : 255;
        window(x, y, radius, (j) => {
          if (d[j + 3] > 0) v = kind === 'maximum' ? Math.max(v, d[j + c]) : Math.min(v, d[j + c]);
        });
        assert.equal(got[i + c], v, `${kind} ${radius} at ${x},${y} c${c}`);
      }
      assert.equal(got[i + 3], d[i + 3]);
    }
  }
});
