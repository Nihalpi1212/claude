// Blur Gallery engines (src/shared/pixels/blur-gallery.js): Field Blur, Iris Blur, Tilt-Shift,
// Path Blur, Spin Blur, the bokeh and grain effects and the helpers the on-canvas session uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FILTERS, FILTER_CATEGORIES, applyFilter } from '../../src/shared/pixels/filters.js';
import { BLUR_GALLERY, BLUR_GALLERY_KINDS, scaleBlurParams, pathPolyline, irisExponent } from '../../src/shared/pixels/blur-gallery.js';
import { createImage, cloneImage } from '../../src/shared/pixels/core.js';

// ---- test images ----------------------------------------------------------------------------------------------

/** Deterministic busy image: 12 px checker blocks in red, white noise in green, a ramp in blue. */
function busyImage(w, h, seed = 7) {
  const img = createImage(w, h);
  let s = seed;
  const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      img.data[i] = ((Math.floor(x / 12) + Math.floor(y / 12)) & 1) ? 230 : 25;
      img.data[i + 1] = Math.floor(rnd() * 256);
      img.data[i + 2] = Math.round((x * 255) / (w - 1));
      img.data[i + 3] = 255;
    }
  }
  return img;
}

/** Grey image from fn(x, y) -> 0..255 (pixel centres at +0.5). */
function greyImage(w, h, fn) {
  const img = createImage(w, h);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      const v = Math.max(0, Math.min(255, Math.round(fn(x + 0.5, y + 0.5))));
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  return img;
}

const dotImage = (w, h, x, y, bg = 0, dot = 255) => {
  const img = greyImage(w, h, () => bg);
  const i = (y * w + x) * 4;
  img.data[i] = img.data[i + 1] = img.data[i + 2] = dot;
  return img;
};

const at = (img, x, y, c = 0) => img.data[(y * img.width + x) * 4 + c];

/** [max, mean] absolute difference over a rect (default: everything), all channels. */
function diff(a, b, rect = { x: 0, y: 0, width: a.width, height: a.height }) {
  let max = 0, sum = 0, n = 0;
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      for (let c = 0; c < 4; c++, n++) {
        const d = Math.abs(at(a, x, y, c) - at(b, x, y, c));
        if (d > max) max = d;
        sum += d;
      }
    }
  }
  return [max, sum / n];
}

/** Brute-force Gaussian of one pixel (edges replicated, wide support): the definition the pyramid approximates. */
function gaussAt(img, x, y, sigma, c) {
  if (sigma < 0.02) return at(img, x, y, c);
  const K = Math.ceil(4.5 * sigma), k = [];
  let sum = 0;
  for (let j = -K; j <= K; j++) sum += k[j + K] = Math.exp(-(j * j) / (2 * sigma * sigma));
  let v = 0;
  for (let j = -K; j <= K; j++) {
    const yy = Math.min(img.height - 1, Math.max(0, y + j));
    let row = 0;
    for (let i = -K; i <= K; i++) row += k[i + K] * at(img, Math.min(img.width - 1, Math.max(0, x + i)), yy, c);
    v += k[j + K] * row;
  }
  return v / (sum * sum);
}

const variance = (values) => {
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((a, b) => a + (b - m) * (b - m), 0) / values.length;
};

// ---- catalogue ------------------------------------------------------------------------------------------------

test('the five kinds are real filters with the contract parameters', () => {
  assert.deepEqual(Object.keys(BLUR_GALLERY), ['field-blur', 'iris-blur', 'tilt-shift', 'path-blur', 'spin-blur']);
  assert.deepEqual([...BLUR_GALLERY_KINDS], Object.keys(BLUR_GALLERY));
  assert.deepEqual([...FILTER_CATEGORIES.find((c) => c.id === 'blur-gallery').kinds].sort(), Object.keys(BLUR_GALLERY).sort());
  for (const k of BLUR_GALLERY_KINDS) {
    const def = FILTERS[k];
    assert.equal(def, BLUR_GALLERY[k]);
    assert.equal(def.category, 'blur-gallery');
    assert.equal(def.ui, 'custom', `${k} opens its own session`);
    assert.ok(!def.placeholder, `${k} is no longer a placeholder`);
    assert.equal(def.margin, 0);
    assert.ok(Object.isFrozen(def.defaults.noise));
    // every dialog field names a parameter that exists in the defaults
    for (const f of def.fields) {
      let v = def.defaults;
      for (const part of f.key.split('.')) v = v?.[part];
      assert.notEqual(v, undefined, `${k} field ${f.key}`);
    }
  }
  assert.deepEqual(BLUR_GALLERY['field-blur'].defaults.pins, [{ x: 0.5, y: 0.5, blur: 15 }]);
  assert.deepEqual(Object.keys(BLUR_GALLERY['iris-blur'].defaults.pins[0]), ['x', 'y', 'blur', 'rx', 'ry', 'rotation', 'roundness', 'feather']);
  assert.deepEqual(Object.keys(BLUR_GALLERY['tilt-shift'].defaults), ['pins', 'distortion', 'symmetricDistortion', 'bokeh', 'noise']);
  assert.deepEqual(Object.keys(BLUR_GALLERY['tilt-shift'].defaults.pins[0]), ['x', 'y', 'blur', 'rotation', 'focus', 'fade']);
  assert.deepEqual(Object.keys(BLUR_GALLERY['path-blur'].defaults), ['paths', 'speed', 'taper', 'centeredBlur', 'strobe', 'strobeStrength', 'strobeFlashes', 'noise']);
  assert.deepEqual(BLUR_GALLERY['path-blur'].defaults.paths[0].endSpeeds, [50, 50]);
  assert.deepEqual(Object.keys(BLUR_GALLERY['spin-blur'].defaults.pins[0]), ['x', 'y', 'angle', 'rx', 'ry', 'rotation', 'feather']);
  assert.deepEqual(BLUR_GALLERY['field-blur'].defaults.bokeh, { lightBokeh: 0, bokehColor: 0, lightRange: [191, 255] });
  assert.deepEqual(BLUR_GALLERY['field-blur'].defaults.noise, { amount: 0, size: 1, roughness: 0, color: 0, highlights: 0, distribution: 'gaussian' });
});

test('no pins, no paths, zero blur and degenerate images leave the image alone', () => {
  const src = busyImage(40, 30);
  for (const [k, p] of [
    ['field-blur', { pins: [] }], ['iris-blur', { pins: [] }], ['tilt-shift', { pins: [] }], ['spin-blur', { pins: [] }], ['path-blur', { paths: [] }],
    ['field-blur', { pins: [{ x: 0.5, y: 0.5, blur: 0 }] }], ['spin-blur', { pins: [{ x: 0.5, y: 0.5, angle: 0, rx: 0.3, ry: 0.3 }] }], ['path-blur', { speed: 0 }],
    ['path-blur', { paths: [{ points: [{ x: 0.5, y: 0.5 }], endSpeeds: [50, 50] }] }],
    ['field-blur', { pins: 'nope' }], ['path-blur', { paths: [{ points: null }] }],
  ]) assert.deepEqual(applyFilter(cloneImage(src), k, p).data, src.data, `${k} ${JSON.stringify(p)}`);
  for (const k of BLUR_GALLERY_KINDS) {
    assert.equal(applyFilter(createImage(0, 0), k).data.length, 0);
    assert.deepEqual([...applyFilter(createImage(1, 1, [10, 20, 30, 1]), k).data], [10, 20, 30, 255], k);
  }
});

// ---- field blur -----------------------------------------------------------------------------------------------

test('field blur: one pin equals a Gaussian of that radius', () => {
  const src = busyImage(300, 270); // several tiles, and several blocks of the reduced levels
  // against the Gaussian Blur filter where that one is exact (direct kernel up to 20 px)
  for (const blur of [0.6, 1.5, 2.9, 4, 7.3, 15]) {
    const mine = applyFilter(cloneImage(src), 'field-blur', { pins: [{ x: 0.3, y: 0.8, blur }] });
    const ref = applyFilter(cloneImage(src), 'gaussian-blur', { radius: blur });
    const [max, mean] = diff(mine, ref);
    assert.ok(max <= 1 && mean < 0.2, `blur ${blur}: max ${max}, mean ${mean}`);
  }
  // against the definition for a large radius (the pyramid runs on a 1/16 grid there), edges included
  const big = applyFilter(cloneImage(src), 'field-blur', { pins: [{ x: 0.5, y: 0.5, blur: 40 }] });
  for (const [x, y] of [[0, 0], [299, 0], [0, 269], [150, 135], [17, 200], [299, 269], [128, 127], [64, 255]]) {
    for (const c of [0, 1, 2]) assert.ok(Math.abs(at(big, x, y, c) - gaussAt(src, x, y, 40, c)) <= 1.2, `40 px at ${x},${y} c${c}: ${at(big, x, y, c)} vs ${gaussAt(src, x, y, 40, c)}`);
  }
  // the pin's position does not matter when there is only one, and equal pins are the same as one
  const a = applyFilter(cloneImage(src), 'field-blur', { pins: [{ x: 0.1, y: 0.1, blur: 9 }] });
  const b = applyFilter(cloneImage(src), 'field-blur', { pins: [{ x: 0.9, y: 0.6, blur: 9 }, { x: 0.2, y: 0.2, blur: 9 }] });
  assert.deepEqual(a.data, b.data);
});

test('field blur: several pins interpolate the radius by inverse distance', () => {
  const W = 260, H = 200;
  const src = busyImage(W, H);
  const pins = [{ x: 0.15, y: 0.5, blur: 0 }, { x: 0.85, y: 0.5, blur: 24 }];
  const out = applyFilter(cloneImage(src), 'field-blur', { pins });
  const radiusAt = (x, y) => {
    let sw = 0, sb = 0;
    for (const p of pins) {
      const w = 1 / ((x + 0.5 - p.x * W) ** 2 + (y + 0.5 - p.y * H) ** 2);
      sw += w;
      sb += w * p.blur;
    }
    return sb / sw;
  };
  // each pixel is the Gaussian of its own radius (two neighbouring pyramid levels mixed: a few levels of error at
  // hard edges; below one pixel the sampled reference kernel is narrower than its nominal radius, so more there)
  let max = 0, maxSmall = 0, sum = 0, n = 0;
  for (let y = 5; y < H; y += 23) {
    for (let x = 3; x < W; x += 17) {
      for (const c of [0, 2]) {
        const rad = radiusAt(x, y);
        const d = Math.abs(at(out, x, y, c) - gaussAt(src, x, y, rad, c));
        if (rad >= 1) max = Math.max(max, d);
        else maxSmall = Math.max(maxSmall, d);
        sum += d;
        n++;
      }
    }
  }
  assert.ok(max <= 5 && maxSmall <= 10 && sum / n < 1, `max ${max}, max below 1 px ${maxSmall}, mean ${sum / n}`);
  // sharp at the 0 px pin, smooth at the 24 px pin: the noise channel loses its variance along the way
  const noiseVar = (cx) => {
    const v = [];
    for (let y = 90; y < 110; y++) for (let x = cx - 10; x < cx + 10; x++) v.push(at(out, x, y, 1));
    return variance(v);
  };
  const v0 = noiseVar(39), v1 = noiseVar(75), v2 = noiseVar(221); // radii about 0, 1.4 and 24 px
  assert.ok(v0 > 2000 && v0 > v1 * 4 && v1 > v2 * 4, `variances ${v0}, ${v1}, ${v2}`);
  // the pixel under a pin has exactly that pin's radius
  assert.deepEqual([...out.data.slice((100 * W + 38) * 4, (100 * W + 39) * 4)].slice(0, 3).map((v, c) => Math.abs(v - gaussAt(src, 38, 100, radiusAt(38, 100), c)) <= 3), [true, true, true]);
});

// ---- iris blur ------------------------------------------------------------------------------------------------

test('iris blur: sharp inside the inner ring, full blur outside the ellipse, a ramp between', () => {
  const W = 240, H = 200;
  const src = busyImage(W, H);
  const pin = { x: 0.5, y: 0.5, blur: 12, rx: 0.3, ry: 0.25, rotation: 0, roundness: 0, feather: 0.5 };
  const out = applyFilter(cloneImage(src), 'iris-blur', { pins: [pin] });
  const rho = (x, y) => Math.hypot((x + 0.5 - 120) / 72, (y + 0.5 - 100) / 50);
  let inner = 0, outer = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const q = rho(x, y);
      if (q <= 0.5) {
        inner++;
        for (let c = 0; c < 4; c++) assert.equal(at(out, x, y, c), at(src, x, y, c), `inside the inner ring at ${x},${y}`);
      } else if (q >= 1 && (x * 7 + y * 13) % 97 === 0) {
        outer++;
        for (const c of [0, 1, 2]) assert.ok(Math.abs(at(out, x, y, c) - gaussAt(src, x, y, 12, c)) <= 1.5, `outside at ${x},${y} c${c}`);
      }
    }
  }
  assert.ok(inner > 2500 && outer > 200);
  // along the ramp the noise is smoothed more and more
  const ring = (lo, hi) => {
    const v = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (rho(x, y) >= lo && rho(x, y) < hi) v.push(at(out, x, y, 1));
    return variance(v);
  };
  const a = ring(0.5, 0.62), b = ring(0.7, 0.8), c = ring(0.9, 1);
  assert.ok(a > b * 2 && b > c * 2, `ramp variances ${a}, ${b}, ${c}`);
});

test('iris blur: rotation, roundness and several pins', () => {
  const W = 200, H = 200;
  const src = busyImage(W, H);
  const same = (out, x, y) => [0, 1, 2].every((c) => at(out, x, y, c) === at(src, x, y, c));
  // a thin horizontal ellipse rotated by 90 degrees is a thin vertical one
  const rotated = applyFilter(cloneImage(src), 'iris-blur', { pins: [{ x: 0.5, y: 0.5, blur: 10, rx: 0.4, ry: 0.08, rotation: 90, roundness: 0, feather: 0.9 }] });
  assert.ok(same(rotated, 100, 40) && same(rotated, 100, 160), 'sharp along the rotated major axis');
  assert.ok(!same(rotated, 40, 100) && !same(rotated, 160, 100), 'blurred where the unrotated ellipse would be sharp');
  // roundness 100 is nearly a rectangle: the corner region is inside; roundness -100 is a diamond: it is far outside
  const corner = [100 + 48, 100 + 48]; // u = v = 0.8 of the radii
  const mk = (roundness) => applyFilter(cloneImage(src), 'iris-blur', { pins: [{ x: 0.5, y: 0.5, blur: 10, rx: 0.3, ry: 0.3, rotation: 0, roundness, feather: 0.95 }] });
  assert.ok(same(mk(100), ...corner), 'squircle keeps the corner sharp');
  assert.ok(!same(mk(0), ...corner), 'ellipse blurs the corner');
  assert.deepEqual([0, 1, 2].map((c) => Math.abs(at(mk(-100), ...corner, c) - gaussAt(src, ...corner, 10, c)) <= 1.5), [true, true, true], 'diamond: full blur at the corner');
  assert.equal(irisExponent(0), 2);
  assert.equal(irisExponent(100), 8);
  assert.equal(irisExponent(-100), 1);
  // two pins: a pixel is as sharp as the sharper pin makes it (the minimum blur)
  const two = applyFilter(cloneImage(src), 'iris-blur', { pins: [
    { x: 0.25, y: 0.3, blur: 10, rx: 0.15, ry: 0.15, rotation: 0, roundness: 0, feather: 0.8 },
    { x: 0.75, y: 0.7, blur: 30, rx: 0.15, ry: 0.15, rotation: 0, roundness: 0, feather: 0.8 },
  ] });
  assert.ok(same(two, 50, 60) && same(two, 150, 140), 'both centres stay sharp');
  for (const c of [0, 2]) assert.ok(Math.abs(at(two, 150, 30, c) - gaussAt(src, 150, 30, 10, c)) <= 1.5, 'outside both: the smaller blur');
});

// ---- tilt-shift -----------------------------------------------------------------------------------------------

test('tilt-shift: the band stays sharp, the blur ramps linearly to full strength', () => {
  const W = 200, H = 240;
  const src = busyImage(W, H);
  const pin = { x: 0.5, y: 0.5, blur: 16, rotation: 0, focus: 0.1, fade: 0.25 };
  const out = applyFilter(cloneImage(src), 'tilt-shift', { pins: [pin] });
  // focus = 24 px either side of row 120: rows 96..143 are untouched, the centre row in particular
  for (let y = 96; y < 144; y++) assert.deepEqual(out.data.slice(y * W * 4, (y + 1) * W * 4), src.data.slice(y * W * 4, (y + 1) * W * 4), `row ${y}`);
  // beyond focus + fade (24 + 60 px) the blur is the full 16 px Gaussian, on both sides
  for (const y of [10, 30, 210, 232]) {
    for (let x = 5; x < W; x += 37) for (const c of [0, 1, 2]) assert.ok(Math.abs(at(out, x, y, c) - gaussAt(src, x, y, 16, c)) <= 1.5, `full blur at ${x},${y}`);
  }
  // half way through the fade the radius is half the blur (a linear ramp)
  let max = 0;
  for (let x = 4; x < W; x += 9) for (const c of [0, 2]) max = Math.max(max, Math.abs(at(out, x, 174, c) - gaussAt(src, x, 174, (16 * (174.5 - 120 - 24)) / 60, c)));
  assert.ok(max <= 6, `ramp error ${max}`);
  // rotation 90: the band is vertical
  const vert = applyFilter(cloneImage(src), 'tilt-shift', { pins: [{ ...pin, rotation: 90 }] });
  for (let y = 0; y < H; y += 11) for (let x = 80; x < 120; x++) assert.equal(at(vert, x, y, 1), at(src, x, y, 1));
  assert.ok(Math.abs(at(vert, 5, 120, 0) - gaussAt(src, 5, 120, 16, 0)) <= 1.5);
  // two pins: the sharper one wins
  const two = applyFilter(cloneImage(src), 'tilt-shift', { pins: [{ ...pin, y: 0.2 }, { ...pin, y: 0.8 }] });
  assert.equal(diff(two, src, { x: 0, y: 30, width: W, height: 36 })[0], 0);
  assert.equal(diff(two, src, { x: 0, y: 174, width: W, height: 36 })[0], 0);
});

test('tilt-shift distortion stretches the blur on the far side (both sides when symmetric)', () => {
  const W = 161, H = 241;
  const src = greyImage(W, H, () => 0);
  // a 9 x 9 light below the band and one above (their own spread is sqrt(80 / 12) px)
  for (const cy of [200, 40]) for (let y = cy - 4; y <= cy + 4; y++) for (let x = 76; x <= 84; x++) src.data.set([255, 255, 255, 255], (y * W + x) * 4);
  const pin = { x: 0.5, y: 0.5, blur: 8, rotation: 0, focus: 0.05, fade: 0.1 };
  const moments = (img, cx, cy) => {
    let m = 0, mxx = 0, myy = 0;
    for (let y = cy - 38; y <= cy + 38; y++) for (let x = cx - 38; x <= cx + 38; x++) {
      const v = at(img, x, y);
      m += v;
      mxx += v * (x - cx) ** 2;
      myy += v * (y - cy) ** 2;
    }
    return { m, sx: Math.sqrt(mxx / m), sy: Math.sqrt(myy / m) };
  };
  const plain = applyFilter(cloneImage(src), 'tilt-shift', { pins: [pin] });
  const far = applyFilter(cloneImage(src), 'tilt-shift', { pins: [pin], distortion: 100 });
  const along = applyFilter(cloneImage(src), 'tilt-shift', { pins: [pin], distortion: -100 });
  const both = applyFilter(cloneImage(src), 'tilt-shift', { pins: [pin], distortion: 100, symmetricDistortion: true });
  const round = Math.sqrt(64 + 80 / 12), long = Math.sqrt(64 + 80 / 12 + 0.87 * 64); // the stretch is a 9-tap Gaussian cut at 2.4 sigma
  const p = moments(plain, 80, 200);
  assert.ok(Math.abs(p.sx - round) < 0.5 && Math.abs(p.sy - round) < 0.5, `plain spot is round: ${p.sx}, ${p.sy}`);
  // positive: across the band (y), by the blur radius again
  const f = moments(far, 80, 200);
  assert.ok(Math.abs(f.sx - round) < 0.5 && Math.abs(f.sy - long) < 0.7, `stretched across the band: ${f.sx}, ${f.sy}`);
  // negative: along the band (x)
  const a = moments(along, 80, 200);
  assert.ok(Math.abs(a.sy - round) < 0.5 && Math.abs(a.sx - long) < 0.7, `stretched along the band: ${a.sx}, ${a.sy}`);
  // the near side (above the line) is the plain blur unless symmetric
  assert.equal(diff(far, plain, { x: 0, y: 0, width: W, height: 100 })[0], 0);
  const top = moments(both, 80, 40);
  assert.ok(Math.abs(top.sy - long) < 0.7 && Math.abs(top.sx - round) < 0.5, `symmetric: ${top.sx}, ${top.sy}`);
  // the stretch moves light around, it does not add or lose any
  assert.ok(Math.abs(f.m - p.m) / p.m < 0.03);
});

// ---- spin blur ------------------------------------------------------------------------------------------------

test('spin blur leaves a radial pattern alone and smooths a tangential one by the arc', () => {
  const N = 201, c = 100.5;
  const pin = { x: 0.5, y: 0.5, angle: 15, rx: 0.45, ry: 0.45, rotation: 0, feather: 1 };
  // rings: the value depends on the distance from the pin only
  const rings = greyImage(N, N, (x, y) => 128 + 100 * Math.sin(Math.hypot(x - c, y - c) / 5));
  const ringsOut = applyFilter(cloneImage(rings), 'spin-blur', { pins: [pin] });
  const [rmax, rmean] = diff(ringsOut, rings);
  assert.ok(rmax <= 3 && rmean < 0.5, `rings changed by max ${rmax}, mean ${rmean}`);
  // spokes: 12 periods per turn; averaging over 15 degrees leaves sin(k a / 2) / (k a / 2) = 2 / pi of the amplitude
  const spokes = greyImage(N, N, (x, y) => 128 + 100 * Math.sin(12 * Math.atan2(y - c, x - c)));
  const out = applyFilter(cloneImage(spokes), 'spin-blur', { pins: [pin] });
  const amplitude = (img, radius) => {
    let lo = 255, hi = 0;
    for (let k = 0; k < 720; k++) {
      const t = (k / 720) * 2 * Math.PI;
      const v = at(img, Math.floor(c + radius * Math.cos(t)), Math.floor(c + radius * Math.sin(t)));
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    return (hi - lo) / 2;
  };
  for (const radius of [40, 60, 80]) {
    const ratio = amplitude(out, radius) / amplitude(spokes, radius);
    assert.ok(Math.abs(ratio - 2 / Math.PI) < 0.05, `radius ${radius}: amplitude ratio ${ratio}`);
  }
  // 30 degrees is a whole period: the spokes vanish
  const flat = applyFilter(cloneImage(spokes), 'spin-blur', { pins: [{ ...pin, angle: 30 }] });
  assert.ok(amplitude(flat, 60) < 4, `whole period: ${amplitude(flat, 60)}`);
  // nothing outside the ellipse (radius 0.45 * 201 = 90.45 px) is touched
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (Math.hypot(x + 0.5 - c, y + 0.5 - c) >= 90.45) assert.equal(at(out, x, y), at(spokes, x, y), `outside at ${x},${y}`);
});

test('spin blur: feather fades the angle towards the edge, ellipses spin along themselves, strobe adds sharp copies', () => {
  const N = 201, c = 100.5;
  const spokes = greyImage(N, N, (x, y) => 128 + 100 * Math.sin(12 * Math.atan2(y - c, x - c)));
  const amplitude = (img, radius) => {
    let lo = 255, hi = 0;
    for (let k = 0; k < 720; k++) {
      const t = (k / 720) * 2 * Math.PI;
      const v = at(img, Math.floor(c + radius * Math.cos(t)), Math.floor(c + radius * Math.sin(t)));
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    return (hi - lo) / 2;
  };
  // full strength inside feather * radius (45 px), fading to nothing at the ellipse (90 px)
  const out = applyFilter(cloneImage(spokes), 'spin-blur', { pins: [{ x: 0.5, y: 0.5, angle: 30, rx: 0.45, ry: 0.45, rotation: 0, feather: 0.5 }] });
  const a30 = amplitude(out, 30), a65 = amplitude(out, 65), a85 = amplitude(out, 85), a0 = amplitude(spokes, 65);
  assert.ok(a30 < 6, `inside the full-strength area: ${a30}`);
  assert.ok(a65 > 15 && a65 < a85 && a85 > a0 * 0.85, `fading: ${a65} < ${a85} (source ${a0})`);
  // an ellipse spins along itself: elliptical rings stay, the circular rings of the same image do not
  const ell = greyImage(N, N, (x, y) => 128 + 100 * Math.sin(Math.hypot((x - c) / 2, y - c) / 3));
  const ellPin = { x: 0.5, y: 0.5, angle: 40, rx: 0.48, ry: 0.24, rotation: 0, feather: 1 };
  assert.ok(diff(applyFilter(cloneImage(ell), 'spin-blur', { pins: [ellPin] }), ell)[1] < 1.2);
  const circ = greyImage(N, N, (x, y) => 128 + 100 * Math.sin(Math.hypot(x - c, y - c) / 3));
  assert.ok(diff(applyFilter(cloneImage(circ), 'spin-blur', { pins: [ellPin] }), circ)[1] > 4);
  // strobe at full strength with 3 flashes: three sharp copies of a dot at -a/2, 0, +a/2 (a = 60 degrees, radius 50)
  const dot = dotImage(N, N, 150, 100, 0, 255);
  for (const [dx, dy] of [[0, 1], [1, 0], [1, 1], [0, -1], [-1, 0]]) dot.data.fill(255, ((100 + dy) * N + 150 + dx) * 4, ((100 + dy) * N + 150 + dx) * 4 + 3);
  const strobe = applyFilter(cloneImage(dot), 'spin-blur', { pins: [{ x: 0.5, y: 0.5, angle: 60, rx: 0.45, ry: 0.45, rotation: 0, feather: 1 }], strobe: true, strobeStrength: 100, strobeFlashes: 3 });
  const peak = (img, deg) => {
    const t = (deg * Math.PI) / 180;
    let best = 0;
    const px = Math.round(c - 0.5 + 50 * Math.cos(t)), py = Math.round(c - 0.5 + 50 * Math.sin(t));
    for (let y = py - 1; y <= py + 1; y++) for (let x = px - 1; x <= px + 1; x++) best = Math.max(best, at(img, x, y));
    return best;
  };
  assert.ok(peak(strobe, 0) > 70 && peak(strobe, 30) > 55 && peak(strobe, -30) > 55, `flashes ${peak(strobe, -30)}, ${peak(strobe, 0)}, ${peak(strobe, 30)}`);
  assert.ok(peak(strobe, 15) < 12 && peak(strobe, -15) < 12, `dark between the flashes: ${peak(strobe, 15)}`);
  const smooth = applyFilter(cloneImage(dot), 'spin-blur', { pins: [{ x: 0.5, y: 0.5, angle: 60, rx: 0.45, ry: 0.45, rotation: 0, feather: 1 }] });
  assert.ok(Math.abs(peak(smooth, 15) - peak(smooth, -15)) < 6 && peak(smooth, 15) > 4 && peak(smooth, 0) < 40, 'without strobe the dot is an even arc');
});

// ---- path blur ------------------------------------------------------------------------------------------------

test('path blur smears an impulse along the path tangent only', () => {
  const W = 121, H = 81;
  const src = dotImage(W, H, 60, 40, 0, 255);
  const line = (points, extra = {}) => ({ paths: [{ points, endSpeeds: [40, 40] }], speed: 50, ...extra }); // 20 px
  const stats = (img) => {
    let m = 0, mx = 0, my = 0, xx = 0, yy = 0, xy = 0, minX = W, maxX = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const v = at(img, x, y);
      if (!v) continue;
      m += v;
      mx += v * x;
      my += v * y;
      if (v >= 3) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
      }
    }
    mx /= m;
    my /= m;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const v = at(img, x, y);
      xx += v * (x - mx) ** 2;
      yy += v * (y - my) ** 2;
      xy += v * (x - mx) * (y - my);
    }
    const angle = (0.5 * Math.atan2(2 * xy, xx - yy) * 180) / Math.PI;
    const tr = (xx + yy) / m, det = (xx * yy - xy * xy) / (m * m), root = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
    return { m, mx, my, minX, maxX, angle, major: Math.sqrt(tr / 2 + root), minor: Math.sqrt(Math.max(0, tr / 2 - root)) };
  };
  // horizontal path: everything stays in the impulse's row, spread evenly over 20 px around it
  const h = applyFilter(cloneImage(src), 'path-blur', line([{ x: 0.2, y: 0.3 }, { x: 0.8, y: 0.3 }]));
  for (let y = 0; y < H; y++) if (y !== 40) for (let x = 0; x < W; x++) assert.equal(at(h, x, y), 0, `row ${y} stays black`);
  const hs = stats(h);
  assert.ok(Math.abs(hs.m - 255) < 8, `the light is kept: ${hs.m}`);
  assert.ok(Math.abs(hs.mx - 60) < 0.3 && hs.minX >= 48 && hs.minX <= 51 && hs.maxX >= 69 && hs.maxX <= 72, `centred 20 px: ${hs.minX}..${hs.maxX}, mean ${hs.mx}`);
  assert.ok(Math.abs(hs.major - 20 / Math.sqrt(12)) < 0.6, `a box of 20 px: sigma ${hs.major}`);
  for (let x = 53; x <= 67; x++) assert.ok(Math.abs(at(h, x, 40) - 255 / 20) <= 3, `even weight at ${x}: ${at(h, x, 40)}`);
  // vertical path: the impulse's column
  const v = applyFilter(cloneImage(src), 'path-blur', line([{ x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }]));
  for (let x = 0; x < W; x++) if (x !== 60) for (let y = 0; y < H; y++) assert.equal(at(v, x, y), 0);
  // a diagonal path: the smear lies along the path direction and is about a pixel wide across it
  const dg = applyFilter(cloneImage(src), 'path-blur', line([{ x: 0.1, y: 0.1 }, { x: 0.1 + 60 / W, y: 0.1 + 30 / H }]));
  const ds = stats(dg);
  assert.ok(Math.abs(ds.angle - (Math.atan2(30, 60) * 180) / Math.PI) < 1.5, `direction ${ds.angle}`);
  assert.ok(ds.minor < 0.75 && Math.abs(ds.major - 20 / Math.sqrt(12)) < 0.7, `major ${ds.major}, minor ${ds.minor}`);
  // not centred: the smear trails from the impulse in the direction of the path (and the other way for a reversed path)
  const fwd = stats(applyFilter(cloneImage(src), 'path-blur', line([{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }], { centeredBlur: false })));
  assert.ok(fwd.minX >= 59 && fwd.maxX >= 78 && fwd.maxX <= 82 && Math.abs(fwd.mx - 70) < 1, `forward: ${fwd.minX}..${fwd.maxX}`);
  const back = stats(applyFilter(cloneImage(src), 'path-blur', line([{ x: 0.8, y: 0.5 }, { x: 0.2, y: 0.5 }], { centeredBlur: false })));
  assert.ok(back.maxX <= 61 && back.minX >= 38 && back.minX <= 42, `backward: ${back.minX}..${back.maxX}`);
  // taper pulls the weight towards the middle
  const tap = applyFilter(cloneImage(src), 'path-blur', line([{ x: 0.2, y: 0.3 }, { x: 0.8, y: 0.3 }], { taper: 100 }));
  assert.ok(at(tap, 60, 40) > at(h, 60, 40) * 1.5 && at(tap, 52, 40) < at(h, 52, 40) * 0.5, `taper: centre ${at(tap, 60, 40)}, end ${at(tap, 52, 40)}`);
  assert.ok(stats(tap).major < hs.major * 0.8);
});

test('path blur: speed scales the length, end speeds vary it, the direction follows the nearest part of a curve', () => {
  const W = 201, H = 101;
  const lengthAt = (params, x, y) => {
    const out = applyFilter(dotImage(W, H, x, y, 0, 255), 'path-blur', params);
    let lo = W, hi = -1;
    for (let xx = 0; xx < W; xx++) if (at(out, xx, y) >= 2) {
      lo = Math.min(lo, xx);
      hi = Math.max(hi, xx);
    }
    return hi - lo + 1;
  };
  const straight = (speed, endSpeeds) => ({ paths: [{ points: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }], endSpeeds }], speed });
  const l25 = lengthAt(straight(25, [80, 80]), 100, 50), l50 = lengthAt(straight(50, [80, 80]), 100, 50), l100 = lengthAt(straight(100, [80, 80]), 100, 50);
  assert.ok(Math.abs(l25 - 21) <= 2 && Math.abs(l50 - 41) <= 2 && Math.abs(l100 - 81) <= 3, `lengths ${l25}, ${l50}, ${l100}`);
  // end speeds 10 -> 90 px along the path (x 20..181): every pixel p averages over its own length L(p) = 10 + (p - 20) / 2,
  // so an impulse at x reaches the pixels with |p - x| <= L(p) / 2: from x / 1.25 to x / 0.75
  const ramp = straight(100, [10, 90]);
  const a = lengthAt(ramp, 30, 50), b = lengthAt(ramp, 100, 50), c = lengthAt(ramp, 140, 50);
  assert.ok(Math.abs(a - 17) <= 3 && Math.abs(b - 54) <= 3 && Math.abs(c - 75) <= 4, `ramp lengths ${a}, ${b}, ${c}`);
  // beyond the ends the nearest point is the end itself
  assert.ok(Math.abs(lengthAt(ramp, 6, 20) - 11) <= 3);
  // an L-shaped curve (three points: a spline through them): horizontal smear under the first leg, vertical beside the second
  const curve = { paths: [{ points: [{ x: 0.1, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.9 }], endSpeeds: [30, 30] }], speed: 100 };
  const spread = (x, y) => {
    const out = applyFilter(dotImage(W, H, x, y, 0, 255), 'path-blur', curve);
    let m = 0, xx = 0, yy = 0;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const v = at(out, i, j);
      m += v;
      xx += v * (i - x) ** 2;
      yy += v * (j - y) ** 2;
    }
    return [Math.sqrt(xx / m), Math.sqrt(yy / m)];
  };
  const [hx, hy] = spread(60, 30), [vx, vy] = spread(150, 70);
  assert.ok(hx > 6 && hy < hx / 3, `near the horizontal leg: ${hx}, ${hy}`);
  assert.ok(vy > 6 && vx < vy / 3, `near the vertical leg: ${vx}, ${vy}`);
  // the polyline helper: straight for two points, through every point for more
  assert.deepEqual(pathPolyline([{ x: 1, y: 2 }, { x: 5, y: 6 }]), [{ x: 1, y: 2 }, { x: 5, y: 6 }]);
  const poly = pathPolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
  assert.equal(poly.length, 33);
  assert.deepEqual([poly[0], poly[16], poly[32]], [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
  assert.deepEqual(pathPolyline([{ x: 1, y: 1 }, null, { x: NaN, y: 0 }]), [{ x: 1, y: 1 }]);
});

test('path blur: strobe flashes and several paths', () => {
  const W = 161, H = 61;
  const src = dotImage(W, H, 80, 30, 0, 255);
  const base = { paths: [{ points: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }], endSpeeds: [60, 60] }], speed: 100 };
  // full strobe, 4 flashes: four sharp copies 20 px apart over the 60 px kernel, a quarter of the light each
  const out = applyFilter(cloneImage(src), 'path-blur', { ...base, strobe: true, strobeStrength: 100, strobeFlashes: 4 });
  for (const x of [50, 70, 90, 110]) assert.ok(Math.abs(at(out, x, 30) - 64) <= 3, `flash at ${x}: ${at(out, x, 30)}`);
  for (const x of [60, 80, 100]) assert.equal(at(out, x, 30), 0, `dark between flashes at ${x}`);
  // half strength: the flashes sit on half of the continuous blur
  const half = applyFilter(cloneImage(src), 'path-blur', { ...base, strobe: true, strobeStrength: 50, strobeFlashes: 4 });
  assert.ok(Math.abs(at(half, 60, 30) - 255 / 60 / 2) <= 2 && Math.abs(at(half, 70, 30) - (32 + 255 / 120)) <= 3);
  // one flash is the sharp image itself
  const one = applyFilter(cloneImage(src), 'path-blur', { ...base, strobe: true, strobeStrength: 100, strobeFlashes: 1 });
  assert.equal(diff(one, src)[0], 0);
  // two paths: each rules its own neighbourhood (horizontal on top, vertical at the bottom right)
  const two = { paths: [{ points: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }], endSpeeds: [30, 30] }, { points: [{ x: 0.9, y: 0.6 }, { x: 0.9, y: 0.95 }], endSpeeds: [30, 30] }], speed: 100 };
  const top = applyFilter(dotImage(W, H, 60, 8, 0, 255), 'path-blur', two), right = applyFilter(dotImage(W, H, 143, 45, 0, 255), 'path-blur', two);
  assert.ok(at(top, 70, 8) > 4 && at(top, 60, 14) === 0, 'horizontal near the first path');
  assert.ok(at(right, 143, 52) > 4 && at(right, 150, 45) <= 1, 'vertical near the second path');
});

// ---- effects --------------------------------------------------------------------------------------------------

test('bokeh boosts the highlights inside the light range before the blur', () => {
  const W = 120, H = 120;
  const src = greyImage(W, H, () => 40);
  for (let y = 58; y < 62; y++) for (let x = 58; x < 62; x++) src.data.set([250, 240, 200, 255], (y * W + x) * 4); // a warm light
  const blur = { pins: [{ x: 0.5, y: 0.5, blur: 6 }] };
  const plain = applyFilter(cloneImage(src), 'field-blur', blur);
  const boosted = applyFilter(cloneImage(src), 'field-blur', { ...blur, bokeh: { lightBokeh: 100, bokehColor: 0, lightRange: [191, 255] } });
  const half = applyFilter(cloneImage(src), 'field-blur', { ...blur, bokeh: { lightBokeh: 50, bokehColor: 0, lightRange: [191, 255] } });
  const excess = (img) => {
    let s = 0;
    for (let i = 0; i < img.data.length; i += 4) s += img.data[i] - 40;
    return s;
  };
  // the light carries 6x (gain 1 + 5) of what it had: the blurred spot holds that much more light
  const e0 = excess(plain), e1 = excess(boosted), e5 = excess(half);
  assert.ok(Math.abs(e0 - 16 * 210) < 150, `plain keeps the light: ${e0}`);
  assert.ok(e1 > e0 * 5 && e1 < e0 * 7.5, `boosted: ${e1} vs ${e0}`);
  assert.ok(e5 > e0 * 2.8 && e5 < e1 * 0.75, `half way: ${e5}`);
  assert.ok(at(boosted, 60, 60) > at(plain, 60, 60) * 2);
  // a light below the range is not boosted; a range that includes it boosts it
  const dim = greyImage(W, H, () => 40);
  for (let y = 58; y < 62; y++) for (let x = 58; x < 62; x++) dim.data.set([150, 150, 150, 255], (y * W + x) * 4);
  assert.deepEqual(applyFilter(cloneImage(dim), 'field-blur', { ...blur, bokeh: { lightBokeh: 100, bokehColor: 0, lightRange: [191, 255] } }).data, applyFilter(cloneImage(dim), 'field-blur', blur).data);
  assert.ok(excess(applyFilter(cloneImage(dim), 'field-blur', { ...blur, bokeh: { lightBokeh: 100, bokehColor: 0, lightRange: [100, 255] } })) > excess(applyFilter(cloneImage(dim), 'field-blur', blur)) * 4);
  // and one above a narrowed range is left out
  assert.deepEqual(applyFilter(cloneImage(src), 'field-blur', { ...blur, bokeh: { lightBokeh: 100, bokehColor: 0, lightRange: [100, 180] } }).data, plain.data);
  // bokeh colour saturates the boosted light: the warm spot gets warmer (more red over blue)
  const tint = (img) => (at(img, 60, 66, 0) - 40) / Math.max(1, at(img, 60, 66, 2) - 40);
  const colourful = applyFilter(cloneImage(src), 'field-blur', { ...blur, bokeh: { lightBokeh: 30, bokehColor: 100, lightRange: [191, 255] } });
  const neutral = applyFilter(cloneImage(src), 'field-blur', { ...blur, bokeh: { lightBokeh: 30, bokehColor: 0, lightRange: [191, 255] } });
  assert.ok(tint(colourful) > tint(neutral) * 1.15, `tint ${tint(colourful)} vs ${tint(neutral)}`);
  // sharp pixels are never boosted: inside an iris nothing changes
  const iris = applyFilter(cloneImage(src), 'iris-blur', { pins: [{ x: 0.5, y: 0.5, blur: 6, rx: 0.3, ry: 0.3, rotation: 0, roundness: 0, feather: 0.6 }], bokeh: { lightBokeh: 100, bokehColor: 50, lightRange: [191, 255] } });
  assert.equal(diff(iris, src, { x: 50, y: 50, width: 20, height: 20 })[0], 0);
});

test('noise adds deterministic grain where the image was blurred', () => {
  const W = 160, H = 120;
  const src = greyImage(W, H, () => 100);
  const iris = (noise) => ({ pins: [{ x: 0.5, y: 0.5, blur: 8, rx: 0.25, ry: 0.25, rotation: 0, roundness: 0, feather: 0.8 }], noise });
  const mono = { amount: 50, size: 1, roughness: 0, color: 0, highlights: 100, distribution: 'uniform' };
  const out = applyFilter(cloneImage(src), 'iris-blur', iris(mono));
  // nothing in the sharp area, grain outside, bounded by amount (50 % of 64 levels) for the uniform distribution
  assert.equal(diff(out, src, { x: 70, y: 50, width: 20, height: 20 })[0], 0);
  const samples = [];
  for (let y = 0; y < 20; y++) for (let x = 0; x < W; x++) {
    samples.push(at(out, x, y) - 100);
    assert.equal(at(out, x, y, 0), at(out, x, y, 1));
    assert.equal(at(out, x, y, 1), at(out, x, y, 2), 'monochromatic');
    assert.equal(at(out, x, y, 3), 255);
  }
  assert.ok(Math.max(...samples.map(Math.abs)) <= 32, 'bounded');
  const sd = Math.sqrt(variance(samples));
  assert.ok(Math.abs(sd - 32 / Math.sqrt(3)) < 1.5, `uniform sd ${sd}`);
  assert.ok(Math.abs(samples.reduce((a, b) => a + b, 0) / samples.length) < 1.2, 'zero mean');
  // deterministic, seedable, and the same whatever rect is
  assert.deepEqual(applyFilter(cloneImage(src), 'iris-blur', iris(mono)).data, out.data);
  assert.notDeepEqual(applyFilter(cloneImage(src), 'iris-blur', iris({ ...mono, seed: 5 })).data, out.data);
  const part = applyFilter(cloneImage(src), 'iris-blur', iris(mono), { x: 3, y: 2, width: 40, height: 9 });
  assert.equal(diff(part, out, { x: 3, y: 2, width: 40, height: 9 })[0], 0);
  assert.equal(at(part, 50, 5), 100);
  // gaussian: sigma is half the amplitude; amount scales it
  const g = applyFilter(cloneImage(src), 'iris-blur', iris({ ...mono, distribution: 'gaussian' }));
  const gs = [];
  for (let y = 0; y < 20; y++) for (let x = 0; x < W; x++) gs.push(at(g, x, y) - 100);
  assert.ok(Math.abs(Math.sqrt(variance(gs)) - 16) < 1.5, `gaussian sd ${Math.sqrt(variance(gs))}`);
  const weak = applyFilter(cloneImage(src), 'iris-blur', iris({ ...mono, amount: 10 }));
  const ws = [];
  for (let y = 0; y < 20; y++) for (let x = 0; x < W; x++) ws.push(at(weak, x, y) - 100);
  assert.ok(Math.abs(Math.sqrt(variance(ws)) - 6.4 / Math.sqrt(3)) < 0.6);
  // colour 100: the channels are independent
  const col = applyFilter(cloneImage(src), 'iris-blur', iris({ ...mono, color: 100 }));
  let same = 0, n = 0, cov = 0;
  for (let y = 0; y < 20; y++) for (let x = 0; x < W; x++, n++) {
    if (at(col, x, y, 0) === at(col, x, y, 1)) same++;
    cov += (at(col, x, y, 0) - 100) * (at(col, x, y, 1) - 100);
  }
  assert.ok(same / n < 0.1 && Math.abs(cov / n) < 25, `colour grain: ${same / n} equal, covariance ${cov / n}`);
  // size: neighbouring pixels of coarse grain are correlated
  const coarse = applyFilter(cloneImage(src), 'iris-blur', iris({ ...mono, size: 6 }));
  const corr = (img) => {
    let a = 0, b = 0;
    for (let y = 0; y < 20; y++) for (let x = 0; x < W - 1; x++) {
      a += (at(img, x, y) - 100) * (at(img, x + 1, y) - 100);
      b += (at(img, x, y) - 100) ** 2;
    }
    return a / b;
  };
  assert.ok(corr(coarse) > 0.8 && Math.abs(corr(out)) < 0.1, `correlation ${corr(coarse)} vs ${corr(out)}`);
  // roughness makes the grain patchy: its local strength varies
  const rough = applyFilter(cloneImage(src), 'iris-blur', iris({ ...mono, roughness: 100 }));
  const patch = (img, x0) => {
    const v = [];
    for (let y = 2; y < 18; y++) for (let x = x0; x < x0 + 16; x++) v.push(at(img, x, y) - 100);
    return variance(v);
  };
  const spreadOf = (img) => {
    const v = [];
    for (let x0 = 0; x0 + 16 <= W; x0 += 16) v.push(patch(img, x0));
    return Math.max(...v) / Math.min(...v);
  };
  assert.ok(spreadOf(rough) > spreadOf(out) * 1.8, `patchiness ${spreadOf(rough)} vs ${spreadOf(out)}`);
  // highlights 0 keeps the grain out of the highlights
  const bright = greyImage(W, H, (x) => (x < 80 ? 60 : 250));
  const lit = applyFilter(cloneImage(bright), 'field-blur', { pins: [{ x: 0.5, y: 0.5, blur: 0.8 }], noise: { ...mono, highlights: 0 } });
  const sdOf = (img, x0, base) => {
    const v = [];
    for (let y = 0; y < H; y++) for (let x = x0; x < x0 + 40; x++) v.push(at(img, x, y) - base);
    return Math.sqrt(variance(v));
  };
  assert.ok(sdOf(lit, 10, 60) > 10 && sdOf(lit, 110, 250) < 1.5, `shadows ${sdOf(lit, 10, 60)}, highlights ${sdOf(lit, 110, 250)}`);
  // spin and path blur take the same grain, only where they blur
  const spun = applyFilter(cloneImage(src), 'spin-blur', { pins: [{ x: 0.5, y: 0.5, angle: 20, rx: 0.2, ry: 0.2, rotation: 0, feather: 1 }], noise: mono });
  assert.ok(sdOf(spun, 60, 100) > 3 && diff(spun, src, { x: 0, y: 0, width: 40, height: H })[0] === 0);
  const moved = applyFilter(cloneImage(src), 'path-blur', { noise: mono });
  assert.ok(Math.abs(sdOf(moved, 10, 100) - 32 / Math.sqrt(3)) < 2);
});

// ---- alpha, rect, scaling ---------------------------------------------------------------------------------------

test('transparent pixels do not bleed colour and alpha is blurred like the colour', () => {
  const W = 80, H = 60;
  const src = createImage(W, H); // transparent black
  for (let y = 20; y < 40; y++) for (let x = 25; x < 55; x++) src.data.set([220, 30, 10, 255], (y * W + x) * 4);
  for (const [k, p] of [
    ['field-blur', { pins: [{ x: 0.5, y: 0.5, blur: 5 }] }],
    ['field-blur', { pins: [{ x: 0.2, y: 0.5, blur: 2 }, { x: 0.8, y: 0.5, blur: 9 }] }],
    ['iris-blur', { pins: [{ x: 0.5, y: 0.5, blur: 6, rx: 0.1, ry: 0.1, rotation: 0, roundness: 0, feather: 0.5 }] }],
    ['tilt-shift', { pins: [{ x: 0.5, y: 0.5, blur: 6, rotation: 0, focus: 0.05, fade: 0.1 }], distortion: 50, symmetricDistortion: true }],
    ['spin-blur', { pins: [{ x: 0.5, y: 0.5, angle: 40, rx: 0.5, ry: 0.5, rotation: 0, feather: 1 }] }],
    ['path-blur', { speed: 100 }],
  ]) {
    const out = applyFilter(cloneImage(src), k, p);
    let soft = 0;
    for (let i = 0; i < out.data.length; i += 4) {
      const a = out.data[i + 3];
      if (a === 0) continue;
      if (a < 250) soft++;
      // the square's colour wherever anything is visible (a nearly transparent pixel has few levels left)
      if (a >= 24) assert.ok(Math.abs(out.data[i] - 220) <= 4 && Math.abs(out.data[i + 1] - 30) <= 4 && Math.abs(out.data[i + 2] - 10) <= 4, `${k}: colour ${out.data.slice(i, i + 4)}`);
    }
    assert.ok(soft > 60, `${k}: the edge is soft (${soft} partly transparent pixels)`);
  }
  // a fully transparent image stays empty
  assert.ok(applyFilter(createImage(30, 30), 'field-blur', { pins: [{ x: 0.2, y: 0.2, blur: 3 }, { x: 0.7, y: 0.7, blur: 12 }] }).data.every((v) => v === 0));
});

test('rect limits the writes and gives the whole-image result inside', () => {
  const W = 150, H = 140;
  const src = busyImage(W, H);
  for (let i = 3; i < src.data.length; i += 4 * 7) src.data[i] = 120; // some translucent pixels
  const noise = { amount: 30, size: 3, roughness: 40, color: 60, highlights: 30, distribution: 'gaussian' };
  const bokeh = { lightBokeh: 60, bokehColor: 40, lightRange: [150, 255] };
  const rect = { x: 21, y: 100, width: 118, height: 33 }; // crosses tile borders
  for (const [k, p] of [
    ['field-blur', { pins: [{ x: 0.1, y: 0.9, blur: 1 }, { x: 0.8, y: 0.2, blur: 37 }, { x: 0.5, y: 0.7, blur: 6 }], bokeh, noise }],
    ['field-blur', { pins: [{ x: 0.5, y: 0.5, blur: 11 }], bokeh, noise }],
    ['iris-blur', { pins: [{ x: 0.4, y: 0.7, blur: 20, rx: 0.3, ry: 0.2, rotation: 25, roundness: 40, feather: 0.3 }, { x: 0.9, y: 0.9, blur: 5, rx: 0.1, ry: 0.1, rotation: 0, roundness: -50, feather: 0.5 }], bokeh, noise }],
    ['tilt-shift', { pins: [{ x: 0.5, y: 0.6, blur: 14, rotation: 20, focus: 0.08, fade: 0.2 }], distortion: 70, symmetricDistortion: false, bokeh, noise }],
    ['tilt-shift', { pins: [{ x: 0.5, y: 0.6, blur: 14, rotation: -30, focus: 0.08, fade: 0.2 }, { x: 0.2, y: 0.9, blur: 30, rotation: 80, focus: 0.02, fade: 0.5 }], distortion: -60, symmetricDistortion: true, noise }],
    ['spin-blur', { pins: [{ x: 0.4, y: 0.8, angle: 50, rx: 0.4, ry: 0.3, rotation: 30, feather: 0.4 }, { x: 0.6, y: 0.7, angle: 120, rx: 0.2, ry: 0.3, rotation: 0, feather: 0.9 }], strobe: true, strobeStrength: 40, strobeFlashes: 3, noise }],
    ['path-blur', { paths: [{ points: [{ x: 0.1, y: 0.2 }, { x: 0.5, y: 0.9 }, { x: 0.9, y: 0.6 }], endSpeeds: [10, 60] }, { points: [{ x: 0.9, y: 0.1 }, { x: 0.6, y: 0.3 }], endSpeeds: [30, 0] }], speed: 80, taper: 40, centeredBlur: false, strobe: true, strobeStrength: 30, strobeFlashes: 5, noise }],
  ]) {
    const full = applyFilter(cloneImage(src), k, p);
    const part = applyFilter(cloneImage(src), k, p, rect);
    assert.ok(diff(full, src)[1] > 1, `${k} does something`);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const inside = x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
        for (let c = 0; c < 4; c++) {
          if (inside) assert.equal(at(part, x, y, c), at(full, x, y, c), `${k} inside at ${x},${y} c${c}`);
          else assert.equal(at(part, x, y, c), at(src, x, y, c), `${k} outside at ${x},${y} c${c}`);
        }
      }
    }
    // running it again gives the same pixels (no hidden state)
    assert.deepEqual(applyFilter(cloneImage(src), k, p).data, full.data, `${k} repeatable`);
  }
});

test('scaleBlurParams: the reduced preview shows what the full-size run produces', () => {
  const params = { pins: [{ x: 0.25, y: 0.5, blur: 4 }, { x: 0.75, y: 0.5, blur: 20 }], noise: { amount: 0, size: 3 } };
  const scaled = scaleBlurParams('field-blur', params, 0.5);
  assert.deepEqual(scaled.pins, [{ x: 0.25, y: 0.5, blur: 2 }, { x: 0.75, y: 0.5, blur: 10 }]);
  assert.equal(scaled.noise.size, 1.5);
  assert.deepEqual(params.pins[1], { x: 0.75, y: 0.5, blur: 20 }, 'the input is not modified');
  assert.deepEqual(scaleBlurParams('path-blur', { paths: [{ points: [{ x: 0.1, y: 0.2 }], endSpeeds: [50, 80] }], speed: 50 }, 0.25).paths[0], { points: [{ x: 0.1, y: 0.2 }], endSpeeds: [12.5, 20] });
  assert.deepEqual(scaleBlurParams('spin-blur', { pins: [{ x: 0.5, y: 0.5, angle: 15, rx: 0.3, ry: 0.3 }] }, 0.5).pins[0], { x: 0.5, y: 0.5, angle: 15, rx: 0.3, ry: 0.3 });
  assert.deepEqual(scaleBlurParams('field-blur', params, 1), params);
  assert.equal(scaleBlurParams('field-blur', { noise: { size: 1 } }, 0.25).noise.size, 1);
  // a smooth image blurred at full size and reduced equals the reduced image blurred with the scaled params
  const W = 240, H = 160;
  const smooth = (w, h) => greyImage(w, h, (x, y) => 128 + 70 * Math.sin((x / w) * 14) * Math.cos((y / h) * 9) + 40 * Math.sin((x / w) * 40));
  const reduce = (img) => {
    const out = createImage(img.width / 2, img.height / 2);
    for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) for (let c = 0; c < 4; c++) {
      out.data[(y * out.width + x) * 4 + c] = Math.round((at(img, 2 * x, 2 * y, c) + at(img, 2 * x + 1, 2 * y, c) + at(img, 2 * x, 2 * y + 1, c) + at(img, 2 * x + 1, 2 * y + 1, c)) / 4);
    }
    return out;
  };
  for (const [k, p] of [
    ['field-blur', params],
    ['iris-blur', { pins: [{ x: 0.5, y: 0.5, blur: 16, rx: 0.3, ry: 0.3, rotation: 0, roundness: 0, feather: 0.4 }] }],
    ['tilt-shift', { pins: [{ x: 0.5, y: 0.5, blur: 16, rotation: 10, focus: 0.1, fade: 0.2 }] }],
    ['path-blur', { paths: [{ points: [{ x: 0.2, y: 0.3 }, { x: 0.8, y: 0.6 }], endSpeeds: [30, 60] }], speed: 80 }],
    ['spin-blur', { pins: [{ x: 0.5, y: 0.5, angle: 30, rx: 0.3, ry: 0.4, rotation: 0, feather: 0.5 }] }],
  ]) {
    const full = reduce(applyFilter(smooth(W, H), k, p));
    const preview = applyFilter(reduce(smooth(W, H)), k, scaleBlurParams(k, p, 0.5));
    const [max, mean] = diff(full, preview);
    assert.ok(mean < 1.2 && max <= 14, `${k}: preview differs by max ${max}, mean ${mean}`);
  }
});

test('a 1000 x 750 layer with pins all over finishes quickly and has no tile seams', () => {
  const W = 1000, H = 750;
  const src = greyImage(W, H, (x, y) => 128 + 90 * Math.sin(x / 9) * Math.sin(y / 7));
  const t0 = performance.now();
  const out = applyFilter(cloneImage(src), 'field-blur', { pins: [{ x: 0.1, y: 0.2, blur: 0 }, { x: 0.9, y: 0.8, blur: 60 }, { x: 0.5, y: 0.5, blur: 8 }] });
  const ms = performance.now() - t0;
  assert.ok(ms < 4000, `took ${ms} ms`);
  // the result is smooth across tile borders (multiples of 128): no jump larger than inside the tiles
  let seam = 0, inner = 0;
  for (let y = 300; y < 750; y += 3) {
    for (const x of [384, 512, 640, 768]) seam = Math.max(seam, Math.abs(at(out, x, y) - at(out, x - 1, y)));
    for (const x of [400, 530, 660, 790]) inner = Math.max(inner, Math.abs(at(out, x, y) - at(out, x - 1, y)));
  }
  assert.ok(seam <= inner + 2, `seam ${seam} vs inner ${inner}`);
});
