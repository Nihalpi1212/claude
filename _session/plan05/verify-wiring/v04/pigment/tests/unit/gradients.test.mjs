// gradients (0.4 package 9): the five interpolation methods and noise gradients of gradient-model.js, and the
// per-pixel renderer gradient-render.js against the reference sampler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeGradient, sampleGradient, gradientLut, gradientT, rgbToOklab, oklabToRgb, seededRandom, INTERPOLATIONS,
} from '../../src/shared/pixels/gradient-model.js';
import { renderGradient, placementT, floatLut } from '../../src/shared/pixels/gradient-render.js';

const KINDS = ['linear', 'radial', 'angle', 'reflected', 'diamond'];

const def3 = (interpolation, extra = {}) => normalizeGradient({
  gradientVersion: 2, type: 'solid', interpolation, smoothness: 0.4,
  stops: [{ pos: 0, mid: 0.5, color: '#ff2000' }, { pos: 0.35, mid: 0.3, color: '#10e040' }, { pos: 1, mid: 0.7, color: '#2020ff' }],
  opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 0.6, mid: 0.4, opacity: 0.25 }, { pos: 1, mid: 0.5, opacity: 0.9 }],
  ...extra,
});

const rgba8 = (c) => [c[0], c[1], c[2], c[3] * 255].map((v) => Math.round(v));
const maxDiff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

/** Compares a render with the reference sampler at every pixel. The renderer reads a lookup table of 4096 entries
 * (16384 for noise), so a pixel matches when it is within 1 of the reference at one of the two table positions around
 * its t (where a midpoint makes the curve vertical, t itself and its table position can be more than a level apart). */
function compare(img, g, refT, { fg, bg } = {}) {
  const def = normalizeGradient(g, { fg, bg });
  const last = def.type === 'noise' ? 16383 : 4095;
  let worst = 0, bad = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      let t = refT(x + 0.5, y + 0.5);
      t = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
      if (g.reverse) t = 1 - t;
      const o = (y * img.width + x) * 4;
      const got = [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
      const near = [Math.floor(t * last) / last, Math.ceil(t * last) / last];
      // the angle kind wraps from 1 to 0: a point on the seam may land on either end
      if (g.kind === 'angle' && (t < 2 / last || t > 1 - 2 / last)) near.push(0, 1);
      let best = Infinity;
      for (const tt of near) best = Math.min(best, maxDiff(got, rgba8(sampleGradient(def, tt))));
      worst = Math.max(worst, best);
      if (best > 1) bad++;
    }
  }
  return { worst, bad };
}

const image = (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });

test('render equals the reference sampler for every kind and method within 1 (from/to placement)', () => {
  for (const interpolation of INTERPOLATIONS) {
    for (const kind of KINDS) {
      for (const reverse of [false, true]) {
        const g = { ...def3(interpolation), kind, reverse, from: [30, 20], to: [70, 45] };
        const origin = [10, 5];
        const img = renderGradient(image(64, 48), g, { origin });
        // the reference measures in document coordinates: ctx (x, y) is document (x + 10, y + 5)
        const r = compare(img, g, (x, y) => gradientT(g, x + origin[0], y + origin[1]));
        assert.equal(r.bad, 0, `${interpolation} ${kind} reverse=${reverse}: worst ${r.worst}`);
      }
    }
  }
});

test('render equals the reference sampler for box placements (angle, scale, offset)', () => {
  const box = { x: 6, y: 4, width: 50, height: 30 };
  for (const interpolation of INTERPOLATIONS) {
    for (const kind of KINDS) {
      const g = { ...def3(interpolation), kind, angle: 35, scale: 0.8, offset: [10, -20] };
      const img = renderGradient(image(64, 40), g, { box });
      const r = compare(img, g, (x, y) => gradientT(g, x, y, box));
      assert.equal(r.bad, 0, `${interpolation} ${kind}: worst ${r.worst}`);
    }
  }
});

test('placementT matches gradientT', () => {
  const box = { x: 0, y: 0, width: 80, height: 40 };
  for (const kind of KINDS) {
    const a = { kind, from: [10, 10], to: [50, 30] };
    const b = { kind, angle: 120, scale: 1.5, offset: [5, 5] };
    const fa = placementT(a, box, [3, 4]), fb = placementT(b, box);
    for (const [x, y] of [[0, 0], [17.5, 9.5], [60, 33], [79, 1]]) {
      assert.ok(Math.abs(fa(x, y) - gradientT(a, x + 3, y + 4, box)) < 1e-12, kind);
      assert.ok(Math.abs(fb(x, y) - gradientT(b, x, y, box)) < 1e-12, kind);
    }
  }
});

test('dither stays within one level of the undithered render and is ordered (deterministic)', () => {
  const g = { ...def3('perceptual'), kind: 'linear', from: [0, 0], to: [63, 0] };
  const a = renderGradient(image(64, 8), g, { dither: false });
  const b = renderGradient(image(64, 8), g, { dither: true });
  const c = renderGradient(image(64, 8), g, { dither: true });
  let differs = false;
  for (let i = 0; i < a.data.length; i++) {
    assert.ok(Math.abs(a.data[i] - b.data[i]) <= 1);
    if (a.data[i] !== b.data[i]) differs = true;
  }
  assert.ok(differs);
  assert.deepEqual(b.data, c.data);
});

test('a shape gradient keeps its place when the stroke widens (box and origin move together)', () => {
  // the path bounds in the document: 40 x 24 at (100, 60); the render canvas grows by the stroke padding
  const bounds = { x: 100, y: 60, width: 40, height: 24 };
  const paint = { ...def3('smooth'), kind: 'radial', angle: 30, scale: 0.9, offset: [10, 0] }; // shape paints store no from / to
  const at = (pad) => {
    const origin = [bounds.x - pad, bounds.y - pad];
    const img = renderGradient(image(bounds.width + 2 * pad, bounds.height + 2 * pad), paint, { box: { x: pad, y: pad, width: bounds.width, height: bounds.height }, origin });
    return (X, Y) => {
      const o = ((Y - origin[1]) * img.width + (X - origin[0])) * 4;
      return [...img.data.slice(o, o + 4)];
    };
  };
  const thin = at(2), wide = at(12);
  for (let Y = bounds.y; Y < bounds.y + bounds.height; Y += 3) {
    for (let X = bounds.x; X < bounds.x + bounds.width; X += 3) assert.deepEqual(wide(X, Y), thin(X, Y), `${X},${Y}`);
  }
});

test('perceptual mixes in Oklab, linear in linear light, classic in sRGB', () => {
  const bw = (interpolation) => normalizeGradient({ gradientVersion: 2, interpolation, smoothness: 0, stops: [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }] });
  const classic = sampleGradient(bw('classic'), 0.5)[0];
  const linear = sampleGradient(bw('linear'), 0.5)[0];
  const perceptual = sampleGradient(bw('perceptual'), 0.5)[0];
  assert.ok(Math.abs(classic - 127.5) < 1e-9);
  assert.ok(Math.abs(linear - 187.5) < 1, `linear ${linear}`); // linear light 0.5 is sRGB 188
  assert.ok(Math.abs(perceptual - 99) < 1.5, `perceptual ${perceptual}`); // Oklab L 0.5 is linear 0.125, sRGB 99
  // Oklab round trip
  for (const c of [[0, 0, 0], [255, 255, 255], [255, 0, 0], [12, 200, 77]]) {
    const back = oklabToRgb(...rgbToOklab(...c));
    assert.ok(maxDiff(back, c) < 0.01, String(c));
  }
  // red to green through Oklab stays brighter in the middle than the sRGB mix (no muddy dip)
  const rg = (interpolation) => normalizeGradient({ gradientVersion: 2, interpolation, stops: [{ pos: 0, color: '#ff0000' }, { pos: 1, color: '#00ff00' }] });
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  assert.ok(lum(sampleGradient(rg('perceptual'), 0.5)) > lum(sampleGradient(rg('classic'), 0.5)));
  // smoothness eases only the classic method
  const s1 = { ...bw('linear'), smoothness: 1 };
  assert.deepEqual(sampleGradient(s1, 0.25), sampleGradient(bw('linear'), 0.25));
});

test('stripes do not blend: each segment switches at its midpoint; smooth passes through the stops without overshoot', () => {
  const g = normalizeGradient({
    gradientVersion: 2, interpolation: 'stripes',
    stops: [{ pos: 0, mid: 0.5, color: '#ff0000' }, { pos: 0.5, mid: 0.25, color: '#00ff00' }, { pos: 1, mid: 0.5, color: '#0000ff' }],
    opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 0.2 }],
  });
  assert.deepEqual(rgba8(sampleGradient(g, 0.1)), [255, 0, 0, 255]);
  assert.deepEqual(rgba8(sampleGradient(g, 0.13)), [0, 255, 0, 255]); // past the midpoint at 0.125
  assert.deepEqual(rgba8(sampleGradient(g, 0.74)), [0, 255, 0, 51]); // the opacity switches at its own midpoint (0.5)
  assert.deepEqual(rgba8(sampleGradient(g, 0.76)), [0, 0, 255, 51]);
  assert.equal(rgba8(sampleGradient(g, 0.49))[3], 255);
  assert.equal(rgba8(sampleGradient(g, 0.51))[3], 51);
  const lut = gradientLut(g, { size: 256 });
  const colours = new Set();
  for (let i = 0; i < 256; i++) colours.add(`${lut[i * 4]},${lut[i * 4 + 1]},${lut[i * 4 + 2]}`);
  assert.equal(colours.size, 3);

  const sm = normalizeGradient({ gradientVersion: 2, interpolation: 'smooth', stops: [{ pos: 0, color: '#000000' }, { pos: 0.3, color: '#808080' }, { pos: 1, color: '#ffffff' }] });
  assert.ok(maxDiff(rgba8(sampleGradient(sm, 0.3)), [128, 128, 128, 255]) <= 1);
  let prev = -1;
  for (let i = 0; i <= 100; i++) {
    const v = sampleGradient(sm, i / 100)[0];
    assert.ok(v >= prev - 1e-9, `monotone at ${i}`);
    prev = v;
  }
});

test('noise gradients are deterministic per seed and honour the ranges, Restrict Colors and Add Transparency', () => {
  const noise = (n) => normalizeGradient({ gradientVersion: 2, type: 'noise', noise: { roughness: 0.6, model: 'rgb', seed: 7, ...n } });
  const a = gradientLut(noise({}), { size: 256 });
  assert.deepEqual(gradientLut(noise({}), { size: 256 }), a);
  assert.deepEqual(floatLut(noise({}), { size: 64 }), floatLut(noise({}), { size: 64 }));
  assert.notDeepEqual(gradientLut(noise({ seed: 8 }), { size: 256 }), a);
  // a different roughness gives a different walk
  assert.notDeepEqual(gradientLut(noise({ roughness: 0.1 }), { size: 256 }), a);
  // without Add Transparency every entry is opaque; with it, alpha varies
  for (let i = 3; i < a.length; i += 4) assert.equal(a[i], 255);
  const tr = gradientLut(noise({ transparency: true }), { size: 256 });
  assert.ok(new Set(Array.from({ length: 256 }, (_, i) => tr[i * 4 + 3])).size > 10);
  // ranges: red fixed at 0.5, green within 0.2..0.4, blue full range
  const r = gradientLut(noise({ min: [0.5, 0.2, 0], max: [0.5, 0.4, 1] }), { size: 256 });
  for (let i = 0; i < 256; i++) {
    assert.ok(Math.abs(r[i * 4] - 127.5) <= 0.5);
    assert.ok(r[i * 4 + 1] >= 50 && r[i * 4 + 1] <= 103);
  }
  // Restrict Colors keeps the saturation under 85 %
  const rs = gradientLut(noise({ restrict: true, roughness: 1, seed: 3 }), { size: 256 });
  for (let i = 0; i < 256; i++) {
    const c = [rs[i * 4], rs[i * 4 + 1], rs[i * 4 + 2]];
    const max = Math.max(...c), min = Math.min(...c);
    assert.ok(max === 0 || (max - min) / max <= 0.86, `entry ${i}`);
  }
  // HSB and Lab models stay in gamut
  for (const model of ['hsb', 'lab']) {
    const m = gradientLut(noise({ model }), { size: 64 });
    assert.equal(m.length, 256);
  }
  // the generator itself
  const g1 = seededRandom(42), g2 = seededRandom(42);
  for (let i = 0; i < 5; i++) assert.equal(g1(), g2());
});

test('noise renders per pixel like the sampler', () => {
  const g = { ...normalizeGradient({ gradientVersion: 2, type: 'noise', noise: { roughness: 0.9, model: 'hsb', seed: 11, transparency: true } }), kind: 'linear', from: [0, 0], to: [99, 0] };
  const img = renderGradient(image(100, 2), g);
  const r = compare(img, g, (x, y) => gradientT(g, x, y));
  assert.equal(r.bad, 0, `worst ${r.worst}`);
});

test('colour references resolve with fg / bg in the renderer', () => {
  const g = { ...normalizeGradient({ stops: 'fgbg' }, { keepRefs: true }), kind: 'linear', from: [0.5, 0], to: [9.5, 0] };
  const img = renderGradient(image(10, 1), g, { fg: '#ff0000', bg: '#0000ff' });
  assert.deepEqual([...img.data.slice(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...img.data.slice(36, 40)], [0, 0, 255, 255]);
});
