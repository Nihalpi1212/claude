// The brush engine's dab trace against 0.4's recording (ARCHITECTURE.md "0.5 features", S2.3, rule 11; skeleton
// step 4). traceDabs must return 0.4's dabs exactly for 0.4's settings, whatever engine is in place; the modifier
// chain's `sample` and `buffer` stages are checked on the pure parts here (the painted ones in brush-golden.spec.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { traceDabs, normalizeSample, registerDabModifier, dabModifiers, strokeReach, tipOutline, runBufferModifiers, ENGINE } from '../../src/renderer/lib/brush.js';
import { normalizeBrush, brushFromLegacy } from '../../src/renderer/lib/brush/preset.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'brush-golden');
const CASES = JSON.parse(readFileSync(join(DIR, 'cases.json'), 'utf8')).cases;
const DABS = JSON.parse(readFileSync(join(DIR, 'dabs.json'), 'utf8'));

const pick = (d) => ({ x: d.x, y: d.y, size: d.size, flow: d.flow, pressure: d.pressure });

test('traceDabs returns 0.4\'s dabs exactly for every golden case (legacy settings)', () => {
  assert.equal(CASES.length, 15);
  for (const c of CASES) {
    const got = traceDabs(c.samples, c.settings);
    assert.equal(got.length, DABS[c.id].length, `${c.id}: dab count`);
    assert.deepEqual(got.map(pick), DABS[c.id], c.id);
  }
});

test('traceDabs gives the same dabs for the preset form (sections off) as for the legacy form', () => {
  for (const c of CASES) {
    const { size, hardness, spacing, angle, roundness, ...paint } = c.settings;
    const preset = normalizeBrush({ ...brushFromLegacy({ size, hardness, spacing, angle, roundness }), tool: null });
    const got = traceDabs(c.samples, { ...paint, preset });
    assert.deepEqual(got.map(pick), DABS[c.id], c.id);
  }
});

test('dabs carry the S2.3 fields', () => {
  const c = CASES.find((x) => x.id === 'angle-roundness');
  const [d0, d1] = traceDabs(c.samples, c.settings);
  for (const k of ['x', 'y', 'size', 'angle', 'roundness', 'flipX', 'flipY', 'opacity', 'flow', 'color', 'tip', 'index', 't', 'sample', 'direction', 'seed']) assert.ok(k in d0, k);
  assert.equal(d0.angle, 45);
  assert.equal(d0.roundness, 0.3);
  assert.deepEqual(d0.color, [0xd0, 0x20, 0x40]);
  assert.equal(d0.index, 0);
  assert.equal(d1.index, 1);
  assert.equal(d0.t, 0);
  assert.ok(d1.t > 0);
  assert.equal(d0.sample.pointerType, 'mouse');
});

test('a sample stage sees every input sample (begin, each extend, the finish), in order; { break } starts a sub-path', () => {
  const c = CASES.find((x) => x.id === 'hard-line');
  const seen = [];
  const off = registerDabModifier({ id: 'test-sample', order: 50, enabled: () => true, sample: (s) => (seen.push([s.x, s.y]), s) });
  try {
    traceDabs(c.samples, c.settings);
    assert.deepEqual(seen, [...c.samples, c.samples[c.samples.length - 1]].map((s) => [s.x, s.y]));
    // a sample stage may move the samples: the dabs follow
    const shifted = registerDabModifier({ id: 'test-sample', order: 50, enabled: () => true, sample: (s) => ({ ...s, y: s.y + 10 }) });
    const moved = traceDabs(c.samples, c.settings);
    assert.ok(moved.every((d, i) => Math.abs(d.y - (DABS['hard-line'][i].y + 10)) < 1e-9));
    shifted();
  } finally {
    off();
  }
  assert.equal(dabModifiers().some((m) => m.id === 'test-sample'), false);
  // two sub-paths: each begins with a dab at its first sample, without smoothing from the previous one
  const sub = traceDabs([{ x: 0, y: 0 }, { x: 50, y: 0 }, { break: true }, { x: 0, y: 40 }, { x: 50, y: 40 }], { size: 10, hardness: 1, smoothing: 0, flow: 1 });
  const second = sub.findIndex((d) => d.y === 40);
  assert.ok(second > 0);
  assert.deepEqual([sub[second].x, sub[second].y], [0, 40]);
  assert.ok(sub.slice(second).every((d) => d.y === 40));
});

test('a disabled modifier costs nothing and changes nothing; a geometry modifier may make several dabs', () => {
  const c = CASES.find((x) => x.id === 'spacing-0.5');
  let calls = 0;
  const off = registerDabModifier({ id: 'test-off', order: 200, enabled: () => false, geometry: () => void calls++ });
  const two = registerDabModifier({ id: 'test-two', order: 210, enabled: (preset) => preset.scattering.enabled, geometry: (d) => [d, { ...d, y: d.y + 5 }] });
  try {
    assert.deepEqual(traceDabs(c.samples, c.settings).map(pick), DABS[c.id]);
    assert.equal(calls, 0);
    const preset = normalizeBrush({ tip: { size: 24, hardness: 0.9, spacing: 0.5 }, scattering: { enabled: true } });
    const { size, hardness, spacing, ...paint } = c.settings;
    const got = traceDabs(c.samples, { ...paint, preset });
    assert.equal(got.length, DABS[c.id].length * 2);
  } finally {
    off();
    two();
  }
});

test('a buffer modifier that halves A halves the alpha handed on (runBufferModifiers)', () => {
  const data = new Uint8ClampedArray([10, 20, 30, 200, 0, 0, 0, 0, 255, 255, 255, 255]);
  const img = { width: 3, height: 1, data };
  const mod = { id: 'test-half', order: 700, enabled: () => true, buffer: (im) => { for (let i = 3; i < im.data.length; i += 4) im.data[i] = Math.round(im.data[i] / 2); } };
  runBufferModifiers(img, { x: 0, y: 0, width: 3, height: 1 }, [{ mod, state: undefined }], {});
  assert.deepEqual([...data], [10, 20, 30, 100, 0, 0, 0, 0, 255, 255, 255, 128]);
});

test('strokeReach: the tip size (0.4\'s growth margin) plus every enabled modifier\'s reach', () => {
  const preset = normalizeBrush({ tip: { size: 40 } });
  assert.equal(strokeReach(preset, {}), 40);
  const off = registerDabModifier({ id: 'test-reach', order: 250, enabled: () => true, reach: () => 300 });
  const no = registerDabModifier({ id: 'test-noreach', order: 260, enabled: () => false, reach: () => 1000 });
  try {
    assert.equal(strokeReach(preset, {}), 340);
  } finally {
    off();
    no();
  }
  assert.equal(strokeReach(preset, {}), 40);
});

test('normalizeSample fills a partial sample; time grows 1 ms per px travelled', () => {
  const a = normalizeSample({ x: 3, y: 4 });
  assert.deepEqual([a.pressure, a.tiltX, a.tiltY, a.twist, a.tangentialPressure, a.pointerType, a.time, a.eraser, a.barrel], [1, 0, 0, 0, 0, 'mouse', 0, false, false]);
  assert.equal(a.altitude, Math.PI / 2);
  const b = normalizeSample({ x: 6, y: 8, pressure: 0.5 }, a);
  assert.equal(b.time, 5);
  assert.equal(b.pressure, 0.5);
  assert.equal(normalizeSample({ x: 0, y: 0, time: 1234 }, b).time, 1234);
  const pen = normalizeSample({ x: 0, y: 0, tiltX: 45, tiltY: 0, pointerType: 'pen' });
  assert.ok(Math.abs(pen.altitude - Math.PI / 4) < 1e-9);
  assert.equal(pen.azimuth, 0);
});

test('tipOutline: the stub engine\'s ellipse; ENGINE describes the engine in place', () => {
  const [poly] = tipOutline({ size: 40 }, { size: 40, angle: 0, roundness: 0.5 });
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  assert.ok(Math.abs(Math.max(...xs) - 20) < 1e-9);
  assert.ok(Math.abs(Math.max(...ys) - 10) < 0.5);
  const [rot] = tipOutline({ size: 40 }, { size: 40, angle: 90, roundness: 0.5 });
  assert.ok(Math.abs(Math.max(...rot.map((p) => p[1])) - 20) < 1e-9);
  assert.equal(typeof ENGINE.id, 'string');
  assert.equal(typeof ENGINE.version, 'number');
  for (const k of ['dynamics', 'sampledTips', 'buildUp', 'smoothingModes', 'smoothCurves', 'tilt', 'modifiersFor']) assert.ok(k in ENGINE.features, k);
  // rule 11: the stub's own description only while it is in place
  if (ENGINE.id === 'classic-0.4') {
    assert.deepEqual(ENGINE.features, { dynamics: false, sampledTips: false, buildUp: false, smoothingModes: false, smoothCurves: false, tilt: false, modifiersFor: [] });
  } else assert.ok(Object.entries(ENGINE.features).filter(([k]) => k !== 'modifiersFor').every(([, v]) => v === true));
});
