// Camera Raw develop pipeline (src/shared/pixels/develop.js): numeric checks per control.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { develop, DEVELOP_DEFAULTS, developDefaults, isNeutral, autoTone, hslRangeWeights, toLinear } from '../../src/shared/pixels/develop.js';
import { createImage, getPixel, setPixel, cloneImage } from '../../src/shared/pixels/core.js';

/** Image whose left half is dark grey and right half bright grey (two flat regions). */
function splitImage(w = 16, h = 8, dark = 40, bright = 220) {
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = x < w / 2 ? dark : bright;
    setPixel(img, x, y, [v, v, v, 1]);
  }
  return img;
}

const rgb = (img, x, y) => getPixel(img, x, y).slice(0, 3);

test('defaults are an exact no-op and keep alpha', () => {
  const img = createImage(6, 6);
  for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) setPixel(img, x, y, [x * 40, y * 40, 128, y === 0 ? 0 : 0.5]);
  const before = cloneImage(img);
  develop(img, developDefaults());
  assert.deepEqual(Array.from(img.data), Array.from(before.data));
  assert.ok(isNeutral(DEVELOP_DEFAULTS));
  assert.ok(!isNeutral({ exposure: 1 }));
  // partial params (missing nested objects) are accepted
  develop(img, { hsl: { reds: { hue: 0 } } });
  assert.deepEqual(Array.from(img.data), Array.from(before.data));
});

test('exposure +1 roughly doubles linear light', () => {
  const img = createImage(4, 4, [100, 100, 100, 1]);
  develop(img, { exposure: 1 });
  const [r] = rgb(img, 1, 1);
  const ratio = toLinear(r / 255) / toLinear(100 / 255);
  assert.ok(ratio > 1.9 && ratio < 2.1, `linear ratio ${ratio}`);
  // alpha untouched
  assert.equal(img.data[3], 255);
  // negative exposure halves it
  const img2 = createImage(2, 2, [200, 200, 200, 1]);
  develop(img2, { exposure: -1 });
  const ratio2 = toLinear(rgb(img2, 0, 0)[0] / 255) / toLinear(200 / 255);
  assert.ok(ratio2 > 0.45 && ratio2 < 0.55, `linear ratio ${ratio2}`);
});

test('temperature: positive warms (more red than blue), negative cools; tint trades green against magenta', () => {
  const warm = createImage(2, 2, [128, 128, 128, 1]);
  develop(warm, { temperature: 60 });
  const [wr, , wb] = rgb(warm, 0, 0);
  assert.ok(wr > 128 && wb < 128, `warm ${wr} ${wb}`);
  const cool = createImage(2, 2, [128, 128, 128, 1]);
  develop(cool, { temperature: -60 });
  const [cr, , cb] = rgb(cool, 0, 0);
  assert.ok(cr < 128 && cb > 128, `cool ${cr} ${cb}`);
  const magenta = createImage(2, 2, [128, 128, 128, 1]);
  develop(magenta, { tint: 60 });
  const [mr, mg, mb] = rgb(magenta, 0, 0);
  assert.ok(mg < mr && mg < mb, `tint ${mr} ${mg} ${mb}`);
});

test('highlights only affects bright pixels, shadows only dark ones', () => {
  const img = splitImage();
  develop(img, { highlights: -100 });
  assert.deepEqual(rgb(img, 2, 2), [40, 40, 40], 'dark half untouched by highlights');
  const [b] = rgb(img, 12, 2);
  assert.ok(b < 200, `bright half recovered: ${b}`);
  const img2 = splitImage();
  develop(img2, { shadows: 100 });
  assert.deepEqual(rgb(img2, 12, 2), [220, 220, 220], 'bright half untouched by shadows');
  assert.ok(rgb(img2, 2, 2)[0] > 60, `dark half lifted: ${rgb(img2, 2, 2)[0]}`);
});

test('contrast, whites and blacks move the ends in the right direction', () => {
  const img = splitImage();
  develop(img, { contrast: 100 });
  assert.ok(rgb(img, 2, 2)[0] < 40 && rgb(img, 12, 2)[0] > 220, 'contrast spreads');
  const flat = splitImage();
  develop(flat, { contrast: -100 });
  assert.ok(rgb(flat, 2, 2)[0] > 40 && rgb(flat, 12, 2)[0] < 220, 'negative contrast flattens');
  const w = splitImage();
  develop(w, { whites: 100 });
  assert.ok(rgb(w, 12, 2)[0] > 220, 'whites push the bright end');
  assert.ok(Math.abs(rgb(w, 2, 2)[0] - 40) <= 2, 'whites barely touch the dark end');
  const bl = splitImage();
  develop(bl, { blacks: -100 });
  assert.ok(rgb(bl, 2, 2)[0] < 40, 'blacks crush the dark end');
  assert.ok(Math.abs(rgb(bl, 12, 2)[0] - 220) <= 2, 'blacks barely touch the bright end');
});

test('HSL: a red hue shift leaves greens alone and moves reds', () => {
  const img = createImage(4, 2);
  for (let x = 0; x < 4; x++) {
    setPixel(img, x, 0, [220, 30, 30, 1]);
    setPixel(img, x, 1, [30, 200, 40, 1]);
  }
  develop(img, { hsl: { reds: { hue: 100 } } });
  assert.deepEqual(rgb(img, 1, 1), [30, 200, 40], 'green untouched');
  const [r, g] = rgb(img, 1, 0);
  assert.ok(g > 60, `red shifted towards orange/yellow: ${r} ${g}`);
  // saturation -100 on greens turns them grey, reds stay
  const img2 = createImage(2, 2);
  setPixel(img2, 0, 0, [220, 30, 30, 1]);
  setPixel(img2, 1, 0, [30, 200, 40, 1]);
  develop(img2, { hsl: { greens: { saturation: -100 } } });
  const [gr, gg, gb] = rgb(img2, 1, 0);
  assert.ok(Math.abs(gr - gg) < 4 && Math.abs(gg - gb) < 4, `green desaturated ${gr} ${gg} ${gb}`);
  assert.deepEqual(rgb(img2, 0, 0), [220, 30, 30]);
  // weights are soft: 1 at the centre, 0 at the neighbouring centre
  const w = hslRangeWeights(0);
  assert.equal(w.reds, 1);
  assert.equal(w.greens, 0);
  assert.ok(hslRangeWeights(15).reds > 0 && hslRangeWeights(15).oranges > 0);
});

test('vignette -100 darkens the corners and leaves the centre alone', () => {
  const img = createImage(32, 32, [180, 180, 180, 1]);
  develop(img, { vignette: -100 });
  assert.deepEqual(rgb(img, 16, 16), [180, 180, 180]);
  assert.ok(rgb(img, 0, 0)[0] < 120, `corner ${rgb(img, 0, 0)[0]}`);
  assert.ok(rgb(img, 31, 31)[0] < 120);
  const light = createImage(32, 32, [100, 100, 100, 1]);
  develop(light, { vignette: 100 });
  assert.deepEqual(rgb(light, 16, 16), [100, 100, 100]);
  assert.ok(rgb(light, 0, 0)[0] > 110, 'positive lightens the corners');
});

test('saturation, vibrance and dehaze', () => {
  const img = createImage(2, 2, [200, 100, 100, 1]);
  develop(img, { saturation: -100 });
  const [r, g, b] = rgb(img, 0, 0);
  assert.ok(Math.abs(r - g) < 2 && Math.abs(g - b) < 2, 'saturation -100 is grey');
  const v = createImage(2, 2, [200, 100, 100, 1]);
  develop(v, { vibrance: 100 });
  assert.ok(rgb(v, 0, 0)[0] > 200 && rgb(v, 0, 0)[1] < 100, 'vibrance boosts');
  const hazy = splitImage(16, 8, 60, 200);
  develop(hazy, { dehaze: 100 });
  assert.ok(rgb(hazy, 2, 2)[0] < 60, 'dehaze lowers the black point');
});

test('clarity, texture and sharpen change edges only; noise reduction smooths', () => {
  const img = splitImage(32, 8, 80, 180);
  develop(img, { clarity: 100 });
  assert.ok(Math.abs(rgb(img, 1, 4)[0] - 80) <= 1, 'far from the edge: flat area unchanged');
  assert.ok(rgb(img, 15, 4)[0] < 80 && rgb(img, 16, 4)[0] > 180, 'edge contrast increased');
  const sh = splitImage(32, 8, 80, 180);
  develop(sh, { sharpen: { amount: 150, radius: 1, detail: 100 } });
  assert.ok(rgb(sh, 15, 4)[0] < 80 && rgb(sh, 16, 4)[0] > 180, 'sharpen halo at the edge');
  assert.deepEqual(rgb(sh, 2, 4), [80, 80, 80]);
  // noise reduction: a salt pixel in a flat area is pulled towards its neighbours
  const noisy = createImage(9, 9, [100, 100, 100, 1]);
  setPixel(noisy, 4, 4, [130, 100, 100, 1]);
  develop(noisy, { noise: { luminance: 100, color: 100 } });
  const [nr] = rgb(noisy, 4, 4);
  assert.ok(nr < 125 && nr >= 100, `denoised ${nr}`);
});

test('grain is deterministic for a seed and only exists where requested', () => {
  const a = createImage(16, 16, [128, 128, 128, 1]);
  const b = createImage(16, 16, [128, 128, 128, 1]);
  develop(a, { grain: 80, seed: 7 });
  develop(b, { grain: 80, seed: 7 });
  assert.deepEqual(Array.from(a.data), Array.from(b.data));
  let differs = 0;
  for (let i = 0; i < a.data.length; i += 4) if (a.data[i] !== 128) differs++;
  assert.ok(differs > 100, 'grain changed most pixels');
  const c = createImage(16, 16, [128, 128, 128, 1]);
  develop(c, { grain: 80, seed: 8 });
  assert.notDeepEqual(Array.from(a.data), Array.from(c.data));
});

test('rect limits the edit', () => {
  const img = createImage(8, 8, [100, 100, 100, 1]);
  develop(img, { exposure: 1 }, { x: 4, y: 0, width: 4, height: 8 });
  assert.deepEqual(rgb(img, 1, 1), [100, 100, 100]);
  assert.ok(rgb(img, 6, 1)[0] > 130);
});

test('autoTone derives a sensible patch from the histogram', () => {
  const img = splitImage(16, 8, 60, 160);
  const p = autoTone(img);
  assert.ok(p.blacks < 0, 'dark end is pushed down');
  assert.ok(p.whites > 0, 'bright end is pushed up');
  assert.ok(typeof p.exposure === 'number' && Math.abs(p.exposure) <= 1.5);
  const already = createImage(8, 8);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) setPixel(already, x, y, [Math.round((x * 255) / 7), Math.round((x * 255) / 7), Math.round((x * 255) / 7), 1]);
  const q = autoTone(already);
  assert.equal(q.blacks, 0);
  assert.equal(q.whites, 0);
  assert.deepEqual(autoTone(createImage(4, 4)), {});
});

test('texture boosts (+) and smooths (-) fine detail that clarity-sized thresholds would ignore; flat areas stay put', () => {
  const noisy = (amp) => {
    const img = createImage(64, 64, [128, 128, 128, 1]);
    let seed = 1;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const v = 128 + Math.round(((seed / 2147483648) * 2 - 1) * amp);
      setPixel(img, x, y, [v, v, v, 1]);
    }
    return img;
  };
  const spread = (img) => {
    let s = 0, s2 = 0, n = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      s += img.data[i];
      s2 += img.data[i] * img.data[i];
      n++;
    }
    return Math.sqrt(s2 / n - (s / n) ** 2);
  };
  for (const amp of [8, 20]) {
    const base = spread(noisy(amp));
    const up = noisy(amp);
    develop(up, { texture: 100 });
    const down = noisy(amp);
    develop(down, { texture: -100 });
    assert.ok(spread(up) > base * 1.15, `texture +100 on ±${amp}: ${spread(up)} vs ${base}`);
    assert.ok(spread(down) < base * 0.85, `texture -100 on ±${amp}: ${spread(down)} vs ${base}`);
  }
  const flat = createImage(16, 16, [90, 90, 90, 1]);
  develop(flat, { texture: 100 });
  assert.deepEqual(rgb(flat, 8, 8), [90, 90, 90]);
});
