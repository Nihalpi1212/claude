// Gradient model (0.4 skeleton, G.1): every 0.3 shape upgrades and renders as 0.3 did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GRADIENT_DEFAULTS, normalizeGradient, isGradientV2, gradientLut, sampleGradient, gradientT,
} from '../../src/shared/pixels/gradient-model.js';
import { parseColor } from '../../src/shared/pixels/color.js';

// ---- 0.3 references, copied verbatim (adjust.js gradientLuts, styles.js gradientLut) ----------
const clampNum = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const round8 = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : (v + 0.5) | 0);
function gradientLuts03(stops, reverse) {
  let list = [];
  if (Array.isArray(stops)) {
    for (const s of stops) {
      if (!s) continue;
      const offset = Array.isArray(s) ? s[0] : s.offset ?? s.position ?? s.pos;
      const color = Array.isArray(s) ? s[1] : s.color;
      if (typeof offset !== 'number' || !Number.isFinite(offset)) continue;
      list.push({ offset: reverse ? 1 - clampNum(offset, 0, 1) : clampNum(offset, 0, 1), color: parseColor(color, [0, 0, 0, 1]) });
    }
  }
  if (!list.length) list = [{ offset: 0, color: [0, 0, 0, 1] }, { offset: 1, color: [255, 255, 255, 1] }];
  list.sort((a, b) => a.offset - b.offset);
  const lr = new Uint8ClampedArray(256), lg = new Uint8ClampedArray(256), lb = new Uint8ClampedArray(256);
  let k = 0;
  for (let v = 0; v < 256; v++) {
    const t = v / 255;
    while (k < list.length - 2 && list[k + 1].offset <= t) k++;
    const a = list[k], b = list[Math.min(k + 1, list.length - 1)];
    const span = b.offset - a.offset;
    const f = span <= 0 ? (t >= b.offset ? 1 : 0) : clampNum((t - a.offset) / span, 0, 1);
    lr[v] = round8(a.color[0] + (b.color[0] - a.color[0]) * f);
    lg[v] = round8(a.color[1] + (b.color[1] - a.color[1]) * f);
    lb[v] = round8(a.color[2] + (b.color[2] - a.color[2]) * f);
  }
  return [lr, lg, lb];
}
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const num = (v, def = 0) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : def;
};
function stylesLut03(stops) {
  const LUT_SIZE = 1024;
  let list = (Array.isArray(stops) ? stops : []).filter((s) => s && typeof s === 'object').map((s) => {
    const c = parseColor(s.color);
    const op = s.opacity === undefined ? 1 : clamp01(num(s.opacity, 1));
    return { pos: clamp01(num(s.pos ?? s.position, 0)), r: c[0], g: c[1], b: c[2], a: c[3] * op };
  });
  if (!list.length) list = [{ pos: 0, r: 0, g: 0, b: 0, a: 1 }, { pos: 1, r: 255, g: 255, b: 255, a: 1 }];
  list.sort((p, q) => p.pos - q.pos);
  const lut = new Uint8ClampedArray(LUT_SIZE * 4);
  const last = list.length - 1;
  let k = 0;
  for (let i = 0; i < LUT_SIZE; i++) {
    const t = i / (LUT_SIZE - 1);
    let s0, s1, f = 0;
    if (t <= list[0].pos) s0 = s1 = list[0];
    else if (t >= list[last].pos) s0 = s1 = list[last];
    else {
      while (k < last - 1 && list[k + 1].pos < t) k++;
      s0 = list[k];
      s1 = list[k + 1];
      f = s1.pos > s0.pos ? (t - s0.pos) / (s1.pos - s0.pos) : 1;
    }
    const p = i * 4;
    lut[p] = s0.r + (s1.r - s0.r) * f;
    lut[p + 1] = s0.g + (s1.g - s0.g) * f;
    lut[p + 2] = s0.b + (s1.b - s0.b) * f;
    lut[p + 3] = (s0.a + (s1.a - s0.a) * f) * 255;
  }
  return lut;
}
// --------------------------------------------------------------------------------------------

const SPECTRUM = [{ pos: 0, color: '#ff0000' }, { pos: 0.17, color: '#ffff00' }, { pos: 0.33, color: '#00ff00' }, { pos: 0.5, color: '#00ffff' }, { pos: 0.67, color: '#0000ff' }, { pos: 0.83, color: '#ff00ff' }, { pos: 1, color: '#ff0000' }];
const CHROME = [{ pos: 0, color: '#8ca0b4' }, { pos: 0.5, color: '#ffffff' }, { pos: 0.51, color: '#5a6b7c' }, { pos: 1, color: '#c4d4e4' }];

function assertLutsNear(a, b, tol, msg) {
  assert.equal(a.length, b.length, msg);
  let worst = 0, at = -1;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > worst) { worst = d; at = i; }
  }
  assert.ok(worst <= tol, `${msg}: worst difference ${worst} at ${at} (${a[at]} vs ${b[at]})`);
}

test('GRADIENT_DEFAULTS is Photoshop\'s new gradient and frozen', () => {
  assert.equal(GRADIENT_DEFAULTS.gradientVersion, 2);
  assert.equal(GRADIENT_DEFAULTS.interpolation, 'perceptual');
  assert.equal(GRADIENT_DEFAULTS.smoothness, 1);
  assert.deepEqual(GRADIENT_DEFAULTS.stops.map((s) => s.color), ['#000000', '#ffffff']);
  assert.ok(Object.isFrozen(GRADIENT_DEFAULTS.stops[0]));
  assert.ok(isGradientV2(GRADIENT_DEFAULTS));
  assert.ok(!isGradientV2({ stops: [] }));
});

test('the Gradient tool / fill layer 0.3 shape upgrades, placement kept, #rrggbbaa split into opacity', () => {
  const g = { kind: 'radial', stops: [{ pos: 0, color: '#ff000080' }, { pos: 1, color: '#00ff00' }], from: [1, 2], to: [30, 40], reverse: true };
  const n = normalizeGradient(g);
  assert.equal(n.gradientVersion, 2);
  assert.equal(n.interpolation, 'classic');
  assert.equal(n.smoothness, 0);
  assert.deepEqual(n.stops, [{ pos: 0, mid: 0.5, color: '#ff0000' }, { pos: 1, mid: 0.5, color: '#00ff00' }]);
  assert.equal(n.opacityStops.length, 2);
  assert.ok(Math.abs(n.opacityStops[0].opacity - 128 / 255) < 1e-9);
  assert.equal(n.opacityStops[1].opacity, 1);
  assert.equal(n.kind, 'radial');
  assert.deepEqual(n.from, [1, 2]);
  assert.deepEqual(n.to, [30, 40]);
  assert.equal(n.reverse, true);
  // the input is not touched
  assert.equal(g.stops[0].color, '#ff000080');
});

test('Gradient Map 0.3 shapes upgrade (offset, position, pairs) and their LUT equals 0.3 within 1', () => {
  const shapes = [
    { stops: [{ offset: 0, color: '#200040' }, { offset: 1, color: '#ffe080' }] },
    { stops: [{ position: 0.2, color: '#102030' }, { position: 0.8, color: '#f0e0d0' }] },
    { stops: [[0, '#000000'], [0.5, '#ff0000'], [1, '#ffffff']] },
    { stops: SPECTRUM.map((s) => ({ offset: s.pos, color: s.color })) },
    { stops: [] },
    {},
  ];
  for (const p of shapes) {
    for (const reverse of [false, true]) {
      // 0.3 quirk: with no valid stop it falls back to black -> white after reversing, so Reverse
      // did nothing there; the model reverses its fallback too (the kind's defaults always have stops).
      if (reverse && !p.stops?.length) continue;
      const [lr, lg, lb] = gradientLuts03(p.stops, reverse);
      const lut = gradientLut(normalizeGradient(p), { size: 256, reverse });
      const r = new Uint8ClampedArray(256), g = new Uint8ClampedArray(256), b = new Uint8ClampedArray(256);
      for (let i = 0; i < 256; i++) { r[i] = lut[i * 4]; g[i] = lut[i * 4 + 1]; b[i] = lut[i * 4 + 2]; }
      const msg = `${JSON.stringify(p)} reverse ${reverse}`;
      assertLutsNear(r, lr, 1, msg + ' r');
      assertLutsNear(g, lg, 1, msg + ' g');
      assertLutsNear(b, lb, 1, msg + ' b');
    }
  }
});

test('Gradient Overlay 0.3 shapes upgrade and their 1024 LUT equals styles.js gradientLut exactly', () => {
  const shapes = [
    [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }],
    [{ pos: 0, color: '#ff0000', opacity: 0.25 }, { pos: 0.4, color: '#00ff0080' }, { pos: 1, color: '#0000ff', opacity: 1 }],
    SPECTRUM,
    CHROME,
    [{ pos: 0.3, color: '#123456' }, { pos: 0.7, color: '#abcdef', opacity: 0 }],
    [],
  ];
  for (const stops of shapes) {
    const ref = stylesLut03(stops);
    const lut = gradientLut(normalizeGradient({ stops, kind: 'linear', angle: 90, scale: 1 }));
    assertLutsNear(lut, ref, 0, JSON.stringify(stops));
  }
});

test('the eight 0.3 tool presets upgrade; fgbg and fgt become refs that resolve', () => {
  const fgbg = normalizeGradient({ stops: 'fgbg' }, { fg: '#112233', bg: '#445566' });
  assert.deepEqual(fgbg.stops.map((s) => s.color), ['#112233', '#445566']);
  const fgt = normalizeGradient({ stops: 'fgt' }, { fg: '#112233', bg: '#445566' });
  assert.deepEqual(fgt.stops.map((s) => s.color), ['#112233', '#112233']);
  assert.deepEqual(fgt.opacityStops.map((s) => s.opacity), [1, 0]);
  // without colours: fg is black, bg is white
  const plain = normalizeGradient({ stops: 'fgbg' });
  assert.deepEqual(plain.stops.map((s) => s.color), ['#000000', '#ffffff']);
  // presets keep the refs on request
  const kept = normalizeGradient({ stops: 'fgbg' }, { keepRefs: true });
  assert.deepEqual(kept.stops.map((s) => s.color), [{ ref: 'fg' }, { ref: 'bg' }]);
  for (const stops of [SPECTRUM, CHROME]) {
    const lut = gradientLut(normalizeGradient({ stops }));
    assertLutsNear(lut, stylesLut03(stops), 0, 'preset');
  }
});

test('a v2 preset with refs resolved with { fg, bg } holds only hex colours', () => {
  const def = {
    gradientVersion: 2, type: 'solid', interpolation: 'classic', smoothness: 0,
    stops: [{ pos: 0, mid: 0.5, color: { ref: 'fg' } }, { pos: 0.5, mid: 0.3, color: '#FF8800' }, { pos: 1, mid: 0.5, color: { ref: 'bg' } }],
    opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 1 }],
  };
  const n = normalizeGradient(def, { fg: '#0a0b0c', bg: [250, 251, 252, 1] });
  assert.deepEqual(n.stops.map((s) => s.color), ['#0a0b0c', '#ff8800', '#fafbfc']);
  for (const s of n.stops) assert.equal(typeof s.color, 'string');
  const none = normalizeGradient(def);
  assert.deepEqual(none.stops.map((s) => s.color), ['#000000', '#ff8800', '#ffffff']);
  // sampleGradient resolves refs the same way
  assert.deepEqual(sampleGradient(def, 0, { fg: '#0a0b0c' }).slice(0, 3), [10, 11, 12]);
  assert.deepEqual(sampleGradient(def, 1).slice(0, 3), [255, 255, 255]);
});

test('normalizeGradient never throws and cleans bad values', () => {
  for (const bad of [null, undefined, 42, 'x', [], { stops: 'nope' }, { gradientVersion: 2, stops: 'x', opacityStops: null }]) {
    const n = normalizeGradient(bad);
    assert.equal(n.gradientVersion, 2);
    assert.ok(n.stops.length >= 2 && n.opacityStops.length >= 2);
  }
  const n = normalizeGradient({ gradientVersion: 2, interpolation: 'weird', smoothness: 7, stops: [{ pos: 2, mid: 0, color: '#abc' }, { pos: -1, mid: 1, color: 'red' }], opacityStops: [{ pos: 0.5, opacity: 3 }] });
  assert.equal(n.interpolation, 'perceptual');
  assert.equal(n.smoothness, 1);
  assert.deepEqual(n.stops, [{ pos: 0, mid: 0.95, color: '#ff0000' }, { pos: 1, mid: 0.05, color: '#aabbcc' }]);
  assert.deepEqual(n.opacityStops, [{ pos: 0.5, mid: 0.5, opacity: 1 }]);
});

test('midpoints bend the segment that ends at the stop; smoothness eases it', () => {
  const def = (mid, smoothness = 0) => ({
    gradientVersion: 2, type: 'solid', interpolation: 'classic', smoothness,
    stops: [{ pos: 0, mid: 0.5, color: '#000000' }, { pos: 1, mid, color: '#ffffff' }],
    opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 1 }],
  });
  // at t = mid the colour is half way
  for (const mid of [0.2, 0.5, 0.8]) assert.ok(Math.abs(sampleGradient(def(mid), mid)[0] - 127.5) < 1e-6, `mid ${mid}`);
  // a low midpoint brightens early
  assert.ok(sampleGradient(def(0.25), 0.4)[0] > sampleGradient(def(0.5), 0.4)[0]);
  // smoothness 1: smoothstep (u = 0.25 -> 0.15625)
  assert.ok(Math.abs(sampleGradient(def(0.5, 1), 0.25)[0] - 255 * 0.15625) < 1e-6);
  // half smoothness: half way between linear and smoothstep
  assert.ok(Math.abs(sampleGradient(def(0.5, 0.5), 0.25)[0] - 255 * (0.25 + 0.15625) / 2) < 1e-6);
});

test('opacity stops interpolate separately from colour stops', () => {
  const def = {
    gradientVersion: 2, type: 'solid', interpolation: 'classic', smoothness: 0,
    stops: [{ pos: 0, mid: 0.5, color: '#ff0000' }, { pos: 1, mid: 0.5, color: '#0000ff' }],
    opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 0.5, mid: 0.5, opacity: 0 }, { pos: 1, mid: 0.5, opacity: 1 }],
  };
  const mid = sampleGradient(def, 0.5);
  assert.deepEqual(mid.map((v) => Math.round(v * 100) / 100), [127.5, 0, 127.5, 0]);
  const q = sampleGradient(def, 0.25);
  assert.ok(Math.abs(q[3] - 0.5) < 1e-9);
  assert.ok(Math.abs(q[0] - 191.25) < 1e-9);
  const lut = gradientLut(def, { size: 3 });
  assert.deepEqual([...lut], [255, 0, 0, 255, 128, 0, 128, 0, 0, 0, 255, 255]);
  const rev = gradientLut(def, { size: 3, reverse: true });
  assert.deepEqual([...rev.slice(0, 4)], [0, 0, 255, 255]);
});

// The skeleton's stub drew every interpolation as classic and noise as a min-to-max ramp. The gradients package
// replaced both (G.1; tests/unit/gradients.test.mjs covers what they draw), so only the shape is pinned here.
test('other interpolations and noise keep their settings and the classic ends', () => {
  const base = normalizeGradient({ stops: [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }] });
  for (const interpolation of ['perceptual', 'linear', 'smooth', 'stripes']) {
    const def = normalizeGradient({ ...base, interpolation });
    assert.equal(def.interpolation, interpolation);
    const lut = gradientLut(def, { size: 16 });
    assert.equal(lut.length, 16 * 4, interpolation);
    // every method passes through its stops: black at the start, white at the end
    assert.deepEqual([...lut.slice(0, 3)], [0, 0, 0], interpolation);
    assert.deepEqual([...lut.slice(-4, -1)], [255, 255, 255], interpolation);
  }
  const noise = normalizeGradient({ gradientVersion: 2, type: 'noise', noise: { model: 'rgb', min: [0, 0.5, 1], max: [1, 0.5, 0] } });
  assert.equal(noise.type, 'noise');
  const sample = sampleGradient(noise, 0.5);
  assert.equal(sample.length, 4);
  assert.ok(sample.every(Number.isFinite));
});

test('gradientT: from/to geometry of the five kinds (0.3 Canvas fill-layer and tool shapes)', () => {
  const pl = (kind) => ({ kind, from: [10, 10], to: [30, 10] });
  const box = { x: 0, y: 0, width: 100, height: 100 };
  assert.equal(gradientT(pl('linear'), 20, 50, box), 0.5);
  assert.equal(gradientT(pl('linear'), 0, 10, box), -0.5);
  assert.equal(gradientT(pl('reflected'), 0, 10, box), 0.5);
  assert.equal(gradientT(pl('radial'), 10, 30, box), 1);
  assert.equal(gradientT(pl('diamond'), 20, 20, box), 1);
  assert.equal(gradientT(pl('diamond'), 15, 10, box), 0.25);
  // angle: clockwise (y down) from the direction of `to`
  assert.equal(gradientT(pl('angle'), 20, 10, box), 0);
  assert.ok(Math.abs(gradientT(pl('angle'), 10, 20, box) - 0.25) < 1e-12);
  assert.ok(Math.abs(gradientT(pl('angle'), 0, 10, box) - 0.5) < 1e-12);
  assert.equal(gradientT({ kind: 'shape-burst' }, 1, 1, box), 0);
});

test('gradientT: box geometry of the five kinds equals 0.3\'s Gradient Overlay', () => {
  const box = { x: 0, y: 0, width: 40, height: 20 };
  // linear at 90 deg runs bottom (0) to top (1)
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} vs ${b}`);
  near(gradientT({ kind: 'linear', angle: 90 }, 20, 20, box), 0);
  near(gradientT({ kind: 'linear', angle: 90 }, 20, 0, box), 1);
  near(gradientT({ kind: 'linear', angle: 0 }, 0, 10, box), 0);
  near(gradientT({ kind: 'linear', angle: 0, scale: 0.5 }, 10, 10, box), 0);
  near(gradientT({ kind: 'reflected', angle: 0 }, 0, 10, box), 1);
  near(gradientT({ kind: 'radial' }, 40, 10, box), 1);
  near(gradientT({ kind: 'diamond', angle: 0 }, 30, 15, box), 0.75);
  near(gradientT({ kind: 'angle', angle: 0 }, 30, 10, box), 0);
  assert.ok(Math.abs(gradientT({ kind: 'angle', angle: 0 }, 20, 0, box) - 0.25) < 1e-12);
  // offset moves the centre by a percent of the box
  near(gradientT({ kind: 'radial', offset: [50, 0] }, 40, 10, box), 0);
});
