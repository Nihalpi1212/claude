// Camera Raw develop stages of the 0.5 skeleton (ARCHITECTURE.md "0.5 features", S8.1): the stage loop equals 0.4's
// develop() (tests/unit/fixtures/develop-04.mjs, frozen by step 0) on random images for every control; order; the
// builtin rule; owned keys and defaults; the process version; the import rule; mapToSource without resample stages.
//
// Rule 11: a comparison with 0.4 runs for a control only while the stage that owns it is still the skeleton's builtin
// (isBuiltinStage); a package that re-registers it is checked for neutral identity only.

// the import rule: develop-more.js (camera-raw-panels) loads first, without develop.js, and must not throw
await import('../../src/shared/pixels/develop-more.js');
await import('../../src/shared/pixels/develop-profile.js');

import { test } from 'node:test';
import assert from 'node:assert/strict';

const D = await import('../../src/shared/pixels/develop.js');
const S = await import('../../src/shared/pixels/develop-stages.js');
const U = await import('../../src/shared/pixels/develop-util.js');
const OLD = await import('./fixtures/develop-04.mjs');

/** A random RGBA image (seeded), with some fully and some partly transparent pixels. */
function randomImage(w, h, seed) {
  let s = seed >>> 0 || 1;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rnd() * 256;
    data[i + 1] = rnd() * 256;
    data[i + 2] = rnd() * 256;
    data[i + 3] = rnd() < 0.1 ? 0 : rnd() < 0.2 ? rnd() * 256 : 255;
  }
  return { width: w, height: h, data };
}
const copy = (img) => ({ width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) });

// every control of 0.4, with the stage that owns it, at a non-neutral value (and some at both signs or clamped)
const CASES = [
  ['white-balance', { temperature: 40 }], ['white-balance', { temperature: -70, tint: 30 }], ['white-balance', { tint: -100 }],
  ['exposure', { exposure: 1.3 }], ['exposure', { exposure: -2 }], ['exposure', { exposure: 9 }],
  ['tone', { contrast: 50 }], ['tone', { contrast: -40 }], ['tone', { highlights: -60 }], ['tone', { shadows: 70 }], ['tone', { whites: 30, blacks: -45 }],
  ['texture-clarity', { texture: 60 }], ['texture-clarity', { clarity: -50 }], ['texture-clarity', { texture: -30, clarity: 80 }],
  ['dehaze', { dehaze: 50 }], ['dehaze', { dehaze: -40 }],
  ['vibrance-saturation', { vibrance: 70 }], ['vibrance-saturation', { saturation: -60 }], ['vibrance-saturation', { vibrance: -20, saturation: 30 }],
  ['hsl', { hsl: { reds: { hue: 40 } } }], ['hsl', { hsl: { blues: { saturation: -70, luminance: 30 }, greens: { luminance: -50 } } }],
  ['noise', { noise: { luminance: 40 } }], ['noise', { noise: { luminance: 80, color: 50 } }],
  ['sharpen', { sharpen: { amount: 90 } }], ['sharpen', { sharpen: { amount: 120, radius: 2.2, detail: 60 } }],
  ['vignette', { vignette: -50 }], ['vignette', { vignette: 70 }],
  ['grain', { grain: 40, seed: 7 }], ['grain', { grain: -5 }],
];
const ALL = { temperature: 15, tint: -10, exposure: 0.4, contrast: 20, highlights: -30, shadows: 25, whites: 10, blacks: -10, texture: 15, clarity: 20, dehaze: 10, vibrance: 25, saturation: -10, hsl: { oranges: { hue: -20, saturation: 15 } }, sharpen: { amount: 40 }, noise: { luminance: 20, color: 30 }, vignette: -25, grain: 20, seed: 3 };

test('the stage loop equals 0.4\'s develop() on random images for every control, also with a rect', () => {
  for (const [i, [stage, params]] of CASES.entries()) {
    if (!S.isBuiltinStage(stage)) continue;
    for (const [w, h] of [[23, 17], [64, 9]]) {
      const img = randomImage(w, h, 11 + i * 7 + w);
      const a = copy(img), b = copy(img);
      D.develop(a, params);
      OLD.develop(b, params);
      assert.deepEqual(a.data, b.data, `${stage} ${JSON.stringify(params)} ${w}x${h}`);
      const rect = { x: 3, y: 2, width: w - 6, height: h - 3 };
      const c = copy(img), d = copy(img);
      D.develop(c, params, rect);
      OLD.develop(d, params, rect);
      assert.deepEqual(c.data, d.data, `${stage} with a rect`);
    }
  }
  const builtins = ['white-balance', 'exposure', 'tone', 'texture-clarity', 'dehaze', 'vibrance-saturation', 'hsl', 'noise', 'sharpen', 'vignette', 'grain'];
  if (builtins.every(S.isBuiltinStage)) {
    const img = randomImage(41, 29, 5);
    const a = copy(img), b = copy(img);
    D.develop(a, ALL);
    OLD.develop(b, ALL);
    assert.deepEqual(a.data, b.data, 'every control at once');
  }
});

test('the defaults are an exact no-op; 0.4\'s exports keep their meaning', () => {
  const img = randomImage(12, 12, 99);
  const a = copy(img);
  D.develop(a, D.developDefaults());
  assert.deepEqual(a.data, img.data);
  assert.ok(D.isNeutral(D.DEVELOP_DEFAULTS));
  assert.ok(D.isNeutral(D.developDefaults()));
  assert.ok(!D.isNeutral({ exposure: 1 }));
  for (const k of Object.keys(OLD.DEVELOP_DEFAULTS)) assert.deepEqual(D.developDefaults()[k], OLD.developDefaults()[k], k);
  // 0.4's keys first, in 0.4's order
  assert.deepEqual(Object.keys(D.developDefaults()).slice(0, Object.keys(OLD.DEVELOP_DEFAULTS).length), Object.keys(OLD.DEVELOP_DEFAULTS));
  assert.deepEqual(D.normalizeParams({ hsl: { reds: { hue: 5 } }, sharpen: { amount: 3 } }).hsl.reds, { hue: 5, saturation: 0, luminance: 0 });
  assert.deepEqual(D.normalizeParams({ sharpen: { amount: 3 } }).sharpen, { amount: 3, radius: 1, detail: 25 });
  assert.equal(D.normalizeParams({ custom: 4 }).custom, 4, 'unknown keys stay');
  assert.equal(D.toSrgb(0.5), OLD.toSrgb(0.5));
  assert.equal(D.toLinear(0.5), OLD.toLinear(0.5));
  assert.deepEqual(D.hslRangeWeights(15), OLD.hslRangeWeights(15));
  assert.deepEqual(D.autoTone(randomImage(20, 20, 4)), OLD.autoTone(randomImage(20, 20, 4)));
  assert.deepEqual(D.HSL_RANGES, OLD.HSL_RANGES);
});

test('stages run resample, linear, perceptual, then by order; the builtin rule; owned keys and defaults', () => {
  const ids = S.developStages().map((s) => s.id);
  for (const [a, b] of [['white-balance', 'exposure'], ['exposure', 'tone'], ['tone', 'texture-clarity'], ['dehaze', 'vibrance-saturation'], ['hsl', 'treatment'], ['noise', 'sharpen'], ['vignette', 'grain']]) assert.ok(ids.indexOf(a) < ids.indexOf(b), `${a} before ${b}`);
  // every stage's declared keys are in its defaults, and every default key has one owner
  const owners = new Map();
  for (const s of S.developStages()) {
    if (!s.params) continue;
    const def = s.params.defaults();
    for (const k of s.params.keys) {
      assert.ok(k in def, `${s.id} declares ${k}`);
      assert.ok(!owners.has(k), `${k} owned twice (${owners.get(k)}, ${s.id})`);
      owners.set(k, s.id);
    }
  }
  for (const k of Object.keys(D.developDefaults())) assert.ok(owners.has(k), `${k} has an owner`);
  if (S.isBuiltinStage('treatment')) assert.equal(D.developDefaults().treatment, 'color');

  const seen = [];
  const plain = (id, order, space) => ({ id, order, space, neutral: (p) => !p.probe, apply: () => seen.push(id) });
  const offs = [
    S.registerDevelopStage(plain('t-late', 999, 'perceptual')),
    S.registerDevelopStage(plain('t-lin', 150, 'linear')),
    S.registerDevelopStage(plain('t-res', 70, 'resample')),
    S.registerDevelopStage(plain('t-early', 301, 'perceptual')),
  ];
  try {
    D.develop(randomImage(4, 4, 1), { probe: 1 });
    assert.deepEqual(seen, ['t-res', 't-lin', 't-early', 't-late']);
    // the builtin rule: a builtin never replaces an earlier registration; a later non-builtin does
    const keep = S.developStages().find((s) => s.id === 't-lin');
    S.registerDevelopStage({ ...plain('t-lin', 1, 'linear'), marker: 'builtin' }, { builtin: true });
    assert.equal(S.developStages().find((s) => s.id === 't-lin'), keep);
    offs.push(S.registerDevelopStage({ ...plain('t-lin', 160, 'linear'), marker: 'later' }));
    assert.equal(S.developStages().find((s) => s.id === 't-lin').marker, 'later');
  } finally {
    for (const off of offs) off();
  }
  assert.ok(!S.developStages().some((s) => s.id.startsWith('t-')));
  assert.throws(() => S.registerDevelopStage({ id: 'x', space: 'other', neutral: () => true, apply() {} }));
});

test('a stage sees the process version (absent = 1), the rect and the document size; params defaults and normalize', () => {
  let ctx = null;
  const off = S.registerDevelopStage({
    id: 't-version', order: 900, space: 'perceptual',
    params: { keys: ['tVersion'], defaults: () => ({ tVersion: { amount: 0, mode: 'a' } }), normalize: (p) => ({ tVersion: { amount: 0, mode: 'a', ...(p.tVersion ?? {}) } }) },
    neutral: (p) => !p.tVersion.amount,
    apply: (planes, p, c) => { ctx = { ...c, mode: p.tVersion.mode, w: planes.w, h: planes.h }; },
  });
  try {
    assert.deepEqual(D.developDefaults().tVersion, { amount: 0, mode: 'a' });
    assert.deepEqual(D.normalizeParams({ tVersion: { amount: 2 } }).tVersion, { amount: 2, mode: 'a' });
    D.develop(randomImage(10, 8, 2), { tVersion: { amount: 1 } }, { x: 2, y: 1, width: 5, height: 4 });
    assert.equal(ctx.processVersion, 1);
    assert.deepEqual(ctx.rect, { x: 2, y: 1, width: 5, height: 4 });
    assert.equal(ctx.docWidth, 10);
    assert.equal(ctx.docHeight, 8);
    assert.equal(ctx.w, 5);
    assert.equal(ctx.mode, 'a');
    D.develop(randomImage(4, 4, 2), { tVersion: { amount: 1 }, processVersion: 2 });
    assert.equal(ctx.processVersion, 2);
  } finally {
    off();
  }
});

test('mapToSource is the identity without resample stages; a resample stage maps, writes alpha and sets the margin', () => {
  assert.deepEqual(S.mapToSource({ x: 12.5, y: 3 }, D.developDefaults(), { docWidth: 100, docHeight: 50 }), { x: 12.5, y: 3 });
  assert.deepEqual(S.mapToSource({ x: 7, y: 9 }, { exposure: 2, vignette: 30 }), { x: 7, y: 9 });
  assert.equal(S.developMargin(D.developDefaults()), 0);
  if (S.isBuiltinStage('sharpen')) assert.equal(S.developMargin({ sharpen: { amount: 50 } }), 48);
  const off = S.registerDevelopStage({
    id: 't-shift', order: 60, space: 'resample',
    neutral: (p) => !p.tShift,
    margin: () => Infinity,
    mapPoint: (pt, p, ctx, dir) => ({ x: pt.x + (dir === 'inverse' ? -p.tShift : p.tShift), y: pt.y }),
    // shifts the planes right by tShift px; the uncovered column becomes transparent
    apply({ R, G, B, A, w, h }, p) {
      const out = { R: new Float32Array(R.length), G: new Float32Array(R.length), B: new Float32Array(R.length), A: new Float32Array(R.length), w, h };
      for (let y = 0; y < h; y++) for (let x = p.tShift; x < w; x++) {
        const i = y * w + x, j = y * w + x - p.tShift;
        out.R[i] = R[j];
        out.G[i] = G[j];
        out.B[i] = B[j];
        out.A[i] = A[j];
      }
      return out;
    },
  });
  try {
    assert.deepEqual(S.mapToSource({ x: 7, y: 9 }, { tShift: 2 }), { x: 5, y: 9 });
    assert.equal(S.developMargin({ tShift: 1 }), Infinity);
    const img = { width: 3, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255]) };
    D.develop(img, { tShift: 1 });
    assert.deepEqual(Array.from(img.data), [0, 0, 0, 0, 255, 0, 0, 255, 0, 255, 0, 128]);
  } finally {
    off();
  }
});

test('treatment bw mixes 0.3\'s Black & White default greys; the builtins carry xmp names for 0.4\'s fields', () => {
  if (S.isBuiltinStage('treatment')) {
    const img = { width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]) };
    D.develop(img, { treatment: 'bw' });
    // pure red: 40 % of white in 0.3's mix (grey 102 as sRGB numbers), pure blue: 20 % (51)
    assert.deepEqual(Array.from(img.data), [102, 102, 102, 255, 51, 51, 51, 255]);
    assert.ok(D.isNeutral({ treatment: 'color' }));
    assert.ok(!D.isNeutral({ treatment: 'bw' }));
  }
  const names = Object.assign({}, ...S.developStages().map((s) => Object.fromEntries(Object.entries(s.xmp ?? {}).map(([k, v]) => [k, v.name]))));
  if (S.isBuiltinStage('white-balance')) assert.equal(names.temperature, 'crs:IncrementalTemperature');
  if (S.isBuiltinStage('exposure')) assert.equal(names.exposure, 'crs:Exposure2012');
  if (S.isBuiltinStage('hsl')) assert.equal(names['hsl.reds.hue'], 'crs:HueAdjustmentRed');
  if (S.isBuiltinStage('grain')) assert.equal(names.grain, 'crs:GrainAmount');
  // develop-util.js holds 0.4's helpers and imports nothing from develop*.js
  assert.equal(typeof U.gaussianBlurFloat, 'function');
  assert.equal(U.TO_LINEAR.length, 256);
});
