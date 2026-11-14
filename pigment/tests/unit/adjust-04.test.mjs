// 0.4 skeleton, step 6: the colour kinds split into adjust-color.js, the placeholders, Gradient Map through the
// gradient model, the adjustment ctx (I.4), deep.js asking deepExact, and the K.1 mask stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ADJUSTMENTS, ADJUSTMENT_KINDS, applyAdjustment } from '../../src/shared/pixels/adjust.js';
import { ADJUSTMENTS_COLOR } from '../../src/shared/pixels/adjust-color.js';
import { pixelKind, lutKind } from '../../src/shared/pixels/adjust-def.js';
import { applyAdjustmentDeep, isExactKind, fromCanvasData, toCanvasData } from '../../src/shared/pixels/deep.js';
import { maskCanvasFor, hasEffectiveMask, maskCacheKey } from '../../src/renderer/lib/mask-render.js';

const COLOR_KINDS = ['hue-saturation', 'black-white', 'photo-filter', 'channel-mixer', 'gradient-map', 'shadows-highlights'];

test('the colour kinds live in adjust-color.js, which imports nothing from adjust.js', () => {
  for (const k of COLOR_KINDS) {
    assert.ok(ADJUSTMENTS_COLOR[k], k);
    assert.equal(ADJUSTMENTS[k], ADJUSTMENTS_COLOR[k], `${k} is merged into ADJUSTMENTS`);
  }
  const src = fs.readFileSync(new URL('../../src/shared/pixels/adjust-color.js', import.meta.url), 'utf8');
  assert.ok(!/^import .* from '\.\/adjust\.js'/m.test(src));
  const tonal = fs.readFileSync(new URL('../../src/shared/pixels/adjust.js', import.meta.url), 'utf8');
  for (const fn of ['function hueSaturation', 'function blackWhite', 'function gradientMap', 'function shadowsHighlights', 'function channelMixer', 'function photoFilter(']) assert.ok(!tonal.includes(fn), `${fn} moved out`);
});

// adjust-color replaces these placeholders with real kinds (I.2), so the test holds before and after it lands: each
// kind is an adjustment-layer kind with its name, and while it is still a placeholder it applies as the identity.
test('the 0.4 adjustment kinds are registered as adjustment-layer kinds; a placeholder applies as the identity', () => {
  for (const [k, name] of [['color-vibrance', 'Color and Vibrance'], ['clarity-dehaze', 'Clarity and Dehaze'], ['grain', 'Grain']]) {
    assert.ok(ADJUSTMENT_KINDS.includes(k), k);
    assert.equal(ADJUSTMENTS[k].name, name);
    assert.equal(ADJUSTMENTS[k].layer, true);
    if (!ADJUSTMENTS[k].placeholder) continue; // the real kind has its own tests (tests/unit/adjust-color.test.mjs)
    const img = { width: 1, height: 1, data: new Uint8ClampedArray([10, 20, 30, 255]) };
    applyAdjustment(img, k, {});
    assert.deepEqual([...img.data], [10, 20, 30, 255]);
  }
});

const grey = (v) => ({ width: 1, height: 1, data: new Uint8ClampedArray([v, v, v, 255]) });

test('Gradient Map reads a v2 gradient def as well as 0.3 stops', () => {
  const old = { stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }] };
  const v2 = {
    gradientVersion: 2, type: 'solid', interpolation: 'classic', smoothness: 0,
    stops: [{ pos: 0, mid: 0.5, color: '#ff0000' }, { pos: 1, mid: 0.5, color: '#0000ff' }],
    opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 1 }],
  };
  for (const v of [0, 64, 128, 200, 255]) {
    const a = grey(v), b = grey(v);
    applyAdjustment(a, 'gradient-map', old);
    applyAdjustment(b, 'gradient-map', v2);
    assert.deepEqual([...b.data], [...a.data], `luma ${v}`);
  }
  // reverse
  const r = grey(0);
  applyAdjustment(r, 'gradient-map', { ...v2, reverse: true });
  assert.deepEqual([...r.data], [0, 0, 255, 255]);
  // a hard stop (two stops at one position) and a midpoint
  const hard = { ...v2, stops: [{ pos: 0, mid: 0.5, color: '#000000' }, { pos: 0.5, mid: 0.5, color: '#000000' }, { pos: 0.5, mid: 0.5, color: '#ffffff' }, { pos: 1, mid: 0.5, color: '#ffffff' }] };
  const lo = grey(100), hi = grey(160);
  applyAdjustment(lo, 'gradient-map', hard);
  applyAdjustment(hi, 'gradient-map', hard);
  assert.equal(lo.data[0], 0);
  assert.equal(hi.data[0], 255);
});

test('the adjustment ctx reaches the kind (I.4): pixelKind fn gets it, lutKind ignores it', () => {
  let seen = 'unset';
  const k = pixelKind('Probe', {}, (img, p, rect, ctx) => {
    seen = ctx;
    return img;
  });
  const ctx = { origin: { x: 5, y: 7 }, docWidth: 100, docHeight: 50, scale: 1 };
  k.apply(grey(1), {}, null, ctx);
  assert.equal(seen, ctx);
  k.apply(grey(1), {});
  assert.equal(seen, null);
  const l = lutKind('Lut', {}, () => [new Uint8ClampedArray(256), new Uint8ClampedArray(256), new Uint8ClampedArray(256)]);
  const img = grey(9);
  l.apply(img, {}, null, ctx);
  assert.equal(img.data[0], 0);
});

test('deep.js: isExactKind takes the params; Gradient Map with a v2 def stays exact at 16 bits', () => {
  assert.equal(isExactKind('curves', {}), true);
  assert.equal(isExactKind('gradient-map', { stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }] }), true);
  assert.equal(isExactKind('selective-color', {}), false);
  assert.equal(isExactKind('no-such-kind', {}), false);
  const v2 = {
    gradientVersion: 2, type: 'solid', interpolation: 'classic', smoothness: 0,
    stops: [{ pos: 0, mid: 0.5, color: '#102030' }, { pos: 1, mid: 0.5, color: '#f0e0d0' }],
    opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 1 }],
  };
  const img = { width: 4, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255, 60, 60, 60, 255, 128, 128, 128, 255, 255, 255, 255, 255]) };
  const deep = { ...fromCanvasData(img, 'u16'), width: 4, height: 1 };
  const r = applyAdjustmentDeep(deep, 'gradient-map', v2);
  assert.equal(r.exact, true);
  const eight = { width: 4, height: 1, data: new Uint8ClampedArray(img.data) };
  applyAdjustment(eight, 'gradient-map', v2);
  const back = toCanvasData(deep);
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(back.data[i] - eight.data[i]) <= 1, `sample ${i}`);
});

test('K.1: the raster mask when enabled, nothing for a Reveal All vector mask with no path', () => {
  // A vector mask with no path and initialFill 'reveal' shows everything (J.1), so only the raster part counts.
  // (Without initialFill an empty vector mask is Hide All and hides the layer: masks-vector-masks.)
  const canvas = { width: 2, height: 2 };
  const on = { mask: { canvas, enabled: true }, vectorMask: { path: { subpaths: [] }, initialFill: 'reveal', enabled: true } };
  const off = { mask: { canvas, enabled: false } };
  assert.equal(maskCanvasFor(on, null), canvas);
  assert.equal(maskCanvasFor(on, null, { parts: 'raster', purpose: 'bake' }), canvas);
  assert.equal(maskCanvasFor(on, null, { parts: 'vector' }), null);
  assert.equal(maskCanvasFor(off, null), null);
  assert.equal(hasEffectiveMask(on), true);
  assert.equal(hasEffectiveMask(on, 'vector'), false);
  assert.equal(hasEffectiveMask(off), false);
  assert.equal(hasEffectiveMask({}), false);
  assert.notEqual(maskCacheKey(on), maskCacheKey(off));
});
