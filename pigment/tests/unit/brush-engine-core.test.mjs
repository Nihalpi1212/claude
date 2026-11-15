// brush-engine-core (ARCHITECTURE.md "0.5 features", package 1): the pure parts of the engine — placement, smoothing
// modes, build-up, the dynamics of Shape Dynamics, Scattering, Color Dynamics and Transfer with every control, seeded
// jitter, the opacity ceiling, Dissolve's noise, tip outlines, and Define Brush Preset's coverage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { traceDabs, strokeReach, tipOutline, registerDabModifier, ENGINE, BUILD_UP_INTERVAL } from '../../src/renderer/lib/brush.js';
import { normalizeBrush } from '../../src/renderer/lib/brush/preset.js';
import { controlFactor, controlAngle, tiltAmount, rgbToHsb, hsbToRgb } from '../../src/renderer/lib/brush/dynamics.js';
import { accumulateCeiling, dissolveNoise, LEASH_PX } from '../../src/renderer/lib/brush/stroke.js';
import { traceContours } from '../../src/renderer/lib/brush/tips.js';
import { PAINT_BLEND_OPTIONS, BRUSH_SIZE } from '../../src/renderer/lib/brush/options.js';
import { coverageOf, coverageBounds } from '../../src/renderer/lib/brush/define.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'brush-golden');
const CASES = JSON.parse(readFileSync(join(DIR, 'cases.json'), 'utf8')).cases;
const DABS = JSON.parse(readFileSync(join(DIR, 'dabs.json'), 'utf8'));

const line = (n = 11, step = 10, extra = {}) => Array.from({ length: n }, (_, i) => ({ x: 10 + i * step, y: 50, ...extra }));
const paint = { opacity: 1, flow: 1, smoothing: 0, pressureSize: false, pressureOpacity: false, color: '#ff0000', background: '#0000ff', mode: 'paint', blend: 'normal' };
const brush = (sections, tip = {}) => normalizeBrush({ tip: { size: 20, hardness: 1, spacing: 0.25, ...tip }, ...sections });
const trace = (preset, samples = line(), more = {}, opts = {}) => traceDabs(samples, { ...paint, ...more, preset }, opts);
const control = (type, fadeSteps = 25) => ({ type, fadeSteps });

test('the engine has landed: every feature flag, and its own sections listed', () => {
  assert.notEqual(ENGINE.id, 'classic-0.4');
  for (const k of ['dynamics', 'sampledTips', 'buildUp', 'smoothingModes', 'smoothCurves', 'tilt']) assert.equal(ENGINE.features[k], true, k);
  assert.deepEqual([...ENGINE.features.modifiersFor], ['shapeDynamics', 'scattering', 'colorDynamics', 'transfer']);
});

test('0.4\'s dabs exactly, also with every engine modifier registered (sections off)', () => {
  for (const c of CASES) {
    const got = traceDabs(c.samples, c.settings).map((d) => ({ x: d.x, y: d.y, size: d.size, flow: d.flow, pressure: d.pressure }));
    assert.deepEqual(got, DABS[c.id], c.id);
  }
});

test('controls: each type gives its factor and angle on synthetic samples', () => {
  const s = { pressure: 0.25, tiltX: 0, tiltY: 0, altitude: Math.PI / 4, azimuth: Math.PI / 2, twist: 90, tangentialPressure: 0.5 };
  assert.equal(controlFactor(control('off'), { sample: s }), 1);
  assert.equal(controlFactor(control('fade', 10), { index: 0 }), 1);
  assert.equal(controlFactor(control('fade', 10), { index: 5 }), 0.5);
  assert.equal(controlFactor(control('fade', 10), { index: 12 }), 0);
  assert.equal(controlFactor(control('pen-pressure'), { sample: s }), 0.25);
  assert.equal(tiltAmount(s), 0.5);
  assert.equal(controlFactor(control('pen-tilt'), { sample: s }), 0.5);
  assert.equal(controlFactor(control('stylus-wheel'), { sample: s }), 0.75);
  assert.equal(controlFactor(control('rotation'), { sample: s }), 0.25);
  assert.equal(controlFactor(control('direction'), { sample: s }), 1);
  // angles
  assert.equal(controlAngle(control('off'), { sample: s, direction: 30 }), 0);
  assert.equal(controlAngle(control('direction'), { sample: s, direction: 30 }), 30);
  assert.equal(controlAngle(control('initial-direction'), { sample: s, direction: 30, initial: { direction: 10, twist: 5 } }), 10);
  assert.equal(controlAngle(control('rotation'), { sample: s }), 90);
  assert.equal(controlAngle(control('initial-rotation'), { sample: s, initial: { direction: 10, twist: 5 } }), 5);
  assert.ok(Math.abs(controlAngle(control('pen-tilt'), { sample: s }) - 90) < 1e-9);
  assert.equal(controlAngle(control('pen-pressure'), { sample: s }), 270);
  // a mouse sample gives the pen controls their neutral value
  const mouse = { pressure: 1, tiltX: 0, tiltY: 0, altitude: Math.PI / 2, azimuth: 0, twist: 0, tangentialPressure: 0 };
  assert.deepEqual(['pen-pressure', 'pen-tilt'].map((t) => controlFactor(control(t), { sample: mouse })), [1, 1]);
});

test('Shape Dynamics: size control and Minimum Diameter, jitter, angle, roundness, flips, Tilt Scale', () => {
  // size by pen pressure, mapped to [Minimum Diameter, 1]
  const pressure = [0, 0.5, 1].map((p) => ({ x: 10, y: 50, pressure: p }));
  const sized = (sd, more) => trace(brush({ shapeDynamics: { enabled: true, ...sd } }), [pressure[0], { x: 30, y: 50, pressure: 0.5 }, { x: 50, y: 50, pressure: 1 }], more, { finish: false });
  const d = sized({ sizeControl: control('pen-pressure'), minimumDiameter: 0.2 });
  assert.equal(d[0].size, 20 * 0.2);
  assert.ok(d.every((x) => x.size >= 4 - 1e-9 && x.size <= 20 + 1e-9));
  assert.ok(Math.abs(d[d.length - 1].size - 20) < 1.2);
  // with Pressure for Size on, the pressure scales the size once (0.4's placement), not twice
  const over = sized({ sizeControl: control('pen-pressure'), minimumDiameter: 0 }, { pressureSize: true });
  const plain = trace(brush({}), [pressure[0], { x: 30, y: 50, pressure: 0.5 }, { x: 50, y: 50, pressure: 1 }], { pressureSize: true }, { finish: false });
  assert.deepEqual(over.map((x) => x.size), plain.map((x) => x.size));
  // jitter only shrinks, never below the minimum
  const j = trace(brush({ shapeDynamics: { enabled: true, sizeJitter: 1, minimumDiameter: 0.5 } }), line(30));
  assert.ok(j.every((x) => x.size >= 10 - 1e-9 && x.size <= 20 + 1e-9));
  assert.ok(new Set(j.map((x) => x.size.toFixed(3))).size > 5);
  // angle follows the direction of travel; a vertical stroke turns the tip by 90 degrees
  const up = Array.from({ length: 8 }, (_, i) => ({ x: 50, y: 10 + i * 10 }));
  const dir = trace(brush({ shapeDynamics: { enabled: true, angleControl: control('direction') } }, { angle: 10 }), up);
  assert.ok(dir.slice(1).every((x) => Math.abs(x.angle - 100) < 1e-9));
  // angle jitter stays within +-180 x jitter around the tip's angle
  const aj = trace(brush({ shapeDynamics: { enabled: true, angleJitter: 0.25 } }), line(30));
  assert.ok(aj.every((x) => Math.abs(x.angle) <= 45 + 1e-9));
  assert.ok(new Set(aj.map((x) => Math.round(x.angle))).size > 5);
  // roundness: jitter squashes down to Minimum Roundness
  const rj = trace(brush({ shapeDynamics: { enabled: true, roundnessJitter: 1, minimumRoundness: 0.3 } }), line(30));
  assert.ok(rj.every((x) => x.roundness >= 0.3 - 1e-9 && x.roundness <= 1));
  assert.ok(rj.some((x) => x.roundness < 0.9));
  // flip jitter flips some dabs
  const fj = trace(brush({ shapeDynamics: { enabled: true, flipXJitter: true } }), line(30));
  assert.ok(fj.some((x) => x.flipX) && fj.some((x) => !x.flipX));
  // pen tilt as the size control: Tilt Scale squashes the tip as the pen leans
  const tilted = trace(brush({ shapeDynamics: { enabled: true, sizeControl: control('pen-tilt'), tiltScale: 1 } }), line(4, 10, { tiltX: 60, pointerType: 'pen' }));
  assert.ok(tilted.every((x) => x.roundness < 1 && x.size < 20));
  // the barrel rotation turns the tip
  const twisted = trace(brush({ shapeDynamics: { enabled: true, angleControl: control('rotation') } }), line(4, 10, { twist: 45, pointerType: 'pen' }));
  assert.ok(twisted.every((x) => x.angle === 45));
  // Brush Projection: a leaning pen squashes and turns the tip
  const proj = trace(brush({ shapeDynamics: { enabled: true, brushProjection: true } }), line(4, 10, { tiltX: 0, tiltY: 45, pointerType: 'pen' }));
  assert.ok(proj.every((x) => x.roundness < 0.75 && Math.abs(x.angle - 90) < 1e-6));
});

test('Scattering: count dabs per placed dab, scatter across the path (both axes), reach grows the layer', () => {
  const placed = trace(brush({}), line()).length;
  const four = trace(brush({ scattering: { enabled: true, count: 4 } }), line());
  assert.equal(four.length, placed * 4);
  const sc = trace(brush({ scattering: { enabled: true, scatter: 2 } }), line());
  assert.equal(sc.length, placed);
  assert.ok(sc.every((d) => Math.abs(d.y - 50) <= 2 * 20 + 1e-9));
  assert.ok(sc.some((d) => Math.abs(d.y - 50) > 5));
  const plain = trace(brush({}), line());
  // across only: the x positions are those of the placed dabs
  assert.deepEqual(sc.map((d) => d.x.toFixed(6)), plain.map((d) => d.x.toFixed(6)));
  const both = trace(brush({ scattering: { enabled: true, scatter: 2, bothAxes: true } }), line());
  assert.ok(both.some((d, i) => Math.abs(d.x - plain[i].x) > 1));
  // count jitter varies the count between 1 and count
  const cj = trace(brush({ scattering: { enabled: true, count: 8, countJitter: 1 } }), line(30));
  assert.ok(cj.length > trace(brush({}), line(30)).length && cj.length < trace(brush({}), line(30)).length * 8);
  // reach: the tip size plus scatter x size
  assert.equal(strokeReach(brush({ scattering: { enabled: true, scatter: 3 } }), paint), 20 + 60);
  assert.equal(strokeReach(brush({ scattering: { enabled: false, scatter: 3 } }), paint), 20);
});

test('Color Dynamics: foreground/background jitter and control, HSB jitter, purity, per tip or per stroke', () => {
  const fb = trace(brush({ colorDynamics: { enabled: true, fbJitter: 1 } }), line(30));
  // between red and blue: no green, red and blue sum to 255 (give or take rounding)
  assert.ok(fb.every((d) => d.color[1] === 0 && Math.abs(d.color[0] + d.color[2] - 255) <= 2));
  assert.ok(new Set(fb.map((d) => d.color.join())).size > 5);
  // by pen pressure: full pressure is the foreground, none the background
  const byPressure = trace(brush({ colorDynamics: { enabled: true, fbControl: control('pen-pressure') } }), [{ x: 10, y: 50, pressure: 1 }, { x: 60, y: 50, pressure: 0 }], {}, { finish: false });
  assert.deepEqual(byPressure[0].color, [255, 0, 0]);
  assert.deepEqual(byPressure[byPressure.length - 1].color.map((v) => Math.round(v / 10)), [0, 0, 26]);
  const hue = trace(brush({ colorDynamics: { enabled: true, hueJitter: 0.5 } }), line(30));
  assert.ok(new Set(hue.map((d) => d.color.join())).size > 5);
  // purity -1: grey
  const grey = trace(brush({ colorDynamics: { enabled: true, purity: -1 } }), line(3));
  assert.ok(grey.every((d) => d.color[0] === d.color[1] && d.color[1] === d.color[2]));
  // Apply Per Tip off: one colour for the stroke
  const once = trace(brush({ colorDynamics: { enabled: true, perTip: false, hueJitter: 1 } }), line(30));
  assert.equal(new Set(once.map((d) => d.color.join())).size, 1);
  // an eraser's dabs have no colour to vary
  const erase = trace(brush({ colorDynamics: { enabled: true, hueJitter: 1 } }), line(5), { mode: 'erase' });
  assert.ok(erase.every((d) => d.color.join() === '0,0,0'));
  // HSB round trip
  for (const c of [[255, 0, 0], [12, 200, 99], [128, 128, 128]]) assert.deepEqual(hsbToRgb(rgbToHsb(c)), c);
});

test('Transfer: the opacity ceiling and the flow, by jitter and control with their minimums', () => {
  const oj = trace(brush({ transfer: { enabled: true, opacityJitter: 1 } }), line(30));
  assert.ok(oj.every((d) => d.opacity >= 0 && d.opacity <= 1 && d.flow === 1));
  assert.ok(oj.some((d) => d.opacity < 0.5));
  const oc = trace(brush({ transfer: { enabled: true, opacityControl: control('pen-pressure'), minimumOpacity: 0.4 } }), [{ x: 10, y: 50, pressure: 0 }, { x: 60, y: 50, pressure: 1 }], {}, { finish: false });
  assert.equal(oc[0].opacity, 0.4);
  assert.ok(Math.abs(oc[oc.length - 1].opacity - 1) < 0.15);
  const fc = trace(brush({ transfer: { enabled: true, flowControl: control('fade', 4), minimumFlow: 0.25 } }), line(8));
  assert.deepEqual(fc.slice(0, 5).map((d) => d.flow), [1, 0.8125, 0.625, 0.4375, 0.25]);
  // with Pressure for Opacity on, the flow follows the pressure once (0.4's), not twice
  const once = trace(brush({ transfer: { enabled: true, flowControl: control('pen-pressure') } }), [{ x: 10, y: 50, pressure: 0.5 }, { x: 40, y: 50, pressure: 0.5 }], { pressureOpacity: true });
  assert.ok(once.every((d) => d.flow === 0.5));
});

test('seeded jitter: the same seed repeats the dabs, another seed does not', () => {
  const preset = brush({ shapeDynamics: { enabled: true, sizeJitter: 1, angleJitter: 1 }, scattering: { enabled: true, scatter: 1, count: 3, countJitter: 0.5 }, colorDynamics: { enabled: true, hueJitter: 1 }, transfer: { enabled: true, opacityJitter: 1, flowJitter: 1 } });
  const key = (ds) => JSON.stringify(ds.map((d) => [d.x, d.y, d.size, d.angle, d.color, d.opacity, d.flow]));
  assert.equal(key(trace(preset, line(), {}, { seed: 7 })), key(trace(preset, line(), {}, { seed: 7 })));
  assert.notEqual(key(trace(preset, line(), {}, { seed: 7 })), key(trace(preset, line(), {}, { seed: 8 })));
  assert.equal(key(trace(preset, line(), { seed: 7 })), key(trace(preset, line(), {}, { seed: 7 })));
});

test('build-up with fake times: dabs at the resting position every BUILD_UP_INTERVAL ms, a burst capped', () => {
  const preset = brush({ buildUp: true });
  const base = trace(preset, [{ x: 20, y: 20, time: 0 }], {}, { finish: false });
  assert.equal(base.length, 1);
  const rest = trace(preset, [{ x: 20, y: 20, time: 0 }, { tick: BUILD_UP_INTERVAL * 3 + 1 }], {}, { finish: false });
  assert.equal(rest.length, 4);
  assert.ok(rest.every((d) => d.x === 20 && d.y === 20));
  assert.deepEqual(rest.map((d) => Math.round(d.t)), [0, 33, 67, 100]);
  // after a long stall a tick catches up at most 8 dabs
  const stall = trace(preset, [{ x: 20, y: 20, time: 0 }, { tick: 10000 }, { tick: 10000 + BUILD_UP_INTERVAL - 1 }], {}, { finish: false });
  assert.equal(stall.length, 1 + 8);
  // without build-up a tick places nothing
  assert.equal(trace(brush({}), [{ x: 20, y: 20, time: 0 }, { tick: 1000 }], {}, { finish: false }).length, 1);
});

test('sub-paths, Spacing off and the sample stage', () => {
  const sub = trace(brush({}), [{ x: 0, y: 0 }, { x: 50, y: 0 }, { break: true }, { x: 0, y: 40 }, { x: 50, y: 40 }]);
  const second = sub.findIndex((d) => d.y === 40);
  assert.deepEqual([sub[second].x, sub[second].y, sub[second].direction], [0, 40, 0]);
  // Spacing off: one dab per sample that moved
  const off = trace(brush({}, { spacingOn: false }), line(6, 3), {}, { finish: false });
  assert.equal(off.length, 6);
  // a sample stage that lowers the pressure reaches the size through Pressure for Size
  const lighter = registerDabModifier({ id: 'test-pose', order: 50, enabled: () => true, sample: (s) => ({ ...s, pressure: 0.5 }) });
  try {
    const dabs = trace(brush({}), line(), { pressureSize: true });
    assert.ok(dabs.every((d) => d.size === 10));
  } finally {
    lighter();
  }
});

test('smoothing modes: 0.4\'s average, Pulled String with its leash and Catch-up on Stroke End, Stroke Catch-up', () => {
  const s = 0.5, R = s * LEASH_PX;
  const pts = Array.from({ length: 11 }, (_, i) => ({ x: i * 10, y: 0 }));
  const pulled = (opts) => trace(brush({}), pts, { smoothing: s, smoothingOptions: { mode: 'pulled-string', ...opts } });
  // the brush stays put until the pointer is a leash away; the stroke ends a leash short of the release
  const a = pulled({});
  assert.equal(a[0].x, 0);
  assert.ok(a.slice(1).every((d) => d.x >= 0 && d.x <= 100 - R + 1e-6));
  assert.ok(Math.abs(a[a.length - 1].x - (100 - R)) <= 5);
  // Catch-up on Stroke End: to the release point
  const b = pulled({ catchUpOnEnd: true });
  assert.ok(b[b.length - 1].x > 95);
  // zoom: Adjust for Zoom measures the leash in screen px
  const zoomed = traceDabs(pts, { ...paint, smoothing: s, smoothingOptions: { mode: 'pulled-string' }, preset: brush({}) }, { zoom: 2 });
  assert.ok(zoomed[zoomed.length - 1].x > a[a.length - 1].x);
  // average mode (0.4's): the brush lags, the release catches up
  const avg = trace(brush({}), pts, { smoothing: s });
  assert.ok(avg[avg.length - 1].x > 95);
  // Stroke Catch-up: a resting pointer pulls the brush along
  const resting = [{ x: 0, y: 0, time: 0 }, { x: 100, y: 0, time: 1 }, { tick: 20 }, { tick: 40 }, { tick: 60 }];
  const noCatch = trace(brush({}), resting, { smoothing: 0.9 }, { finish: false });
  const caught = trace(brush({}), resting, { smoothing: 0.9, smoothingOptions: { mode: 'average', catchUp: true } }, { finish: false });
  assert.ok(caught[caught.length - 1].x > noCatch[noCatch.length - 1].x + 10);
});

test('smoothCurves: the path between samples is a curve, not a corner', () => {
  const corner = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }];
  const straight = trace(brush({}), corner);
  const curved = trace(brush({ smoothCurves: true }), corner);
  // the straight path passes the corner; the curve cuts inside it
  const near = (ds) => Math.min(...ds.map((d) => Math.hypot(d.x - 50, d.y)));
  assert.ok(near(straight) < 1);
  assert.ok(near(curved) > 5);
  // and still ends at the release point
  const last = curved[curved.length - 1];
  assert.ok(Math.hypot(last.x - 50, last.y - 50) < 6);
});

test('accumulateCeiling: full opacity is source-over at coverage x flow; a ceiling caps the alpha', () => {
  const dst = new Uint8ClampedArray([0, 0, 0, 0, 255, 255, 255, 128]);
  const src = new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255]);
  accumulateCeiling(dst, src, 1, 0.5);
  // over transparent: the source at half alpha; over half white: 128 + 0.5 * 127
  assert.deepEqual([...dst.slice(0, 4)], [255, 0, 0, 128]);
  assert.equal(dst[7], Math.round((128 / 255 + (1 - 128 / 255) * 0.5) * 255));
  const capped = new Uint8ClampedArray([0, 0, 0, 0]);
  for (let i = 0; i < 50; i++) accumulateCeiling(capped, new Uint8ClampedArray([0, 0, 255, 255]), 0.4, 0.5);
  assert.ok(Math.abs(capped[3] - 102) <= 1);
  // a dab below what is there adds nothing
  const above = new Uint8ClampedArray([9, 9, 9, 200]);
  accumulateCeiling(above, new Uint8ClampedArray([255, 255, 255, 255]), 0.5, 1);
  assert.deepEqual([...above], [9, 9, 9, 200]);
});

test('Dissolve noise is stable per pixel and seed and spread evenly', () => {
  assert.equal(dissolveNoise(10, 20, 3), dissolveNoise(10, 20, 3));
  assert.notEqual(dissolveNoise(10, 20, 3), dissolveNoise(10, 20, 4));
  let below = 0;
  for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) below += dissolveNoise(x, y, 1) < 0.3 ? 1 : 0;
  assert.ok(Math.abs(below / 10000 - 0.3) < 0.02);
});

test('tip outlines: the computed ellipse, a traced contour, a sampled tip\'s box until decoded', () => {
  const [ell] = tipOutline({ kind: 'computed', size: 40 }, { size: 40, roundness: 0.5, angle: 0 });
  assert.ok(Math.abs(Math.max(...ell.map((p) => p[0])) - 20) < 1e-9);
  // a 4 x 4 square of pixels 1..4 in a 6 x 6 grid: one closed contour along its edges (pixel-edge coordinates)
  const v = new Float32Array(36);
  for (let y = 1; y <= 4; y++) for (let x = 1; x <= 4; x++) v[y * 6 + x] = 1;
  const polys = traceContours(v, 6, 6, 0.5);
  assert.equal(polys.length, 1);
  const xs = polys[0].map((p) => p[0]), ys = polys[0].map((p) => p[1]);
  assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [1, 5, 1, 5]);
  // a ring: an outer and an inner contour
  const ring = new Float32Array(49);
  for (let y = 1; y <= 5; y++) for (let x = 1; x <= 5; x++) ring[y * 7 + x] = x === 3 && y === 3 ? 0 : 1;
  assert.equal(traceContours(ring, 7, 7, 0.5).length, 2);
  // not decoded (Node): the sample's box, the longer side the size
  const [box] = tipOutline({ kind: 'sampled', size: 50, sample: { blob: 'tip-x.png', hash: 'x', width: 100, height: 50 } }, { size: 50 });
  assert.deepEqual(box.map((p) => p.map((n) => Math.round(n * 2) / 2)), [[-25, -12.5], [25, -12.5], [25, 12.5], [-25, 12.5]]);
});

test('Define Brush Preset: dark pixels paint, white and transparent ones do not; the coverage is cropped', () => {
  // 4 x 2: black, white, transparent black, mid grey / then a black pixel at the far right of row 2
  const rgba = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 0, 128, 128, 128, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
  const cov = coverageOf(rgba, 4, 2);
  assert.deepEqual([...cov], [255, 0, 0, 127, 0, 0, 0, 255]);
  const masked = coverageOf(rgba, 4, 2, new Uint8Array([255, 255, 255, 0, 255, 255, 255, 128]));
  assert.deepEqual([...masked], [255, 0, 0, 0, 0, 0, 0, 128]);
  assert.deepEqual(coverageBounds(cov, 4, 2), { x: 0, y: 0, width: 4, height: 2 });
  assert.deepEqual(coverageBounds(new Uint8Array([0, 0, 0, 9, 0, 0]), 3, 2), { x: 0, y: 1, width: 1, height: 1 });
  assert.equal(coverageBounds(new Uint8Array(6), 3, 2), null);
});

test('options: the Mode menu has Dissolve, Behind and Clear after Normal; sizes reach 5000 px', () => {
  assert.deepEqual(PAINT_BLEND_OPTIONS.slice(0, 5).map(([id]) => id), ['normal', 'dissolve', 'behind', 'clear', 'darken']);
  assert.equal(new Set(PAINT_BLEND_OPTIONS.map(([id]) => id)).size, PAINT_BLEND_OPTIONS.length);
  assert.equal(BRUSH_SIZE.max, 5000);
});
