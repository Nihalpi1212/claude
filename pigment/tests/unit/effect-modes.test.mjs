// Effect blend modes against the backdrop (Pigment 0.4, the hunt's deferred design item): applyStyles' split gives
// the exterior effects one by one with their own modes, and compositeAdvanced composites them in Photoshop's order
// (each exterior effect onto the backdrop in its mode, then the content in the layer's mode, the layer's opacity
// fading all of it as one). These are the numbers the compositor's per-pixel path and its Canvas path both follow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyStyles, exteriorBlends, interiorBlends, splitsInterior } from '../../src/shared/pixels/styles.js';
import { compositeAdvanced, fadeFrom } from '../../src/shared/pixels/blend-if.js';
import { blendImages } from '../../src/shared/pixels/blend.js';
import { createImage, setPixel } from '../../src/shared/pixels/core.js';

const px = (img, x, y) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

/** w x h image filled with rgba (alpha 0..1). */
function solid(w, h, rgba) {
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(img, x, y, rgba);
  return img;
}

/** A layer: an opaque orange square of side s at (m, m) on a transparent w x w canvas. */
function square(w = 40, m = 10, s = 20, rgba = [255, 136, 0, 1]) {
  const img = createImage(w, w);
  for (let y = m; y < m + s; y++) for (let x = m; x < m + s; x++) setPixel(img, x, y, rgba);
  return img;
}

/** The split render placed over a backdrop of the output's size: { dst, layer, parts } ready for compositeAdvanced. */
function stacked(img, styles, backdrop, opts = {}) {
  const out = applyStyles(img, styles, { ...opts, split: true });
  const W = out.image.width, H = out.image.height;
  const dst = solid(W, H, backdrop);
  const parts = out.parts.map((p) => {
    const full = createImage(W, H);
    for (let y = 0; y < p.image.height; y++) {
      const s = y * p.image.width * 4;
      full.data.set(p.image.data.subarray(s, s + p.image.width * 4), ((p.y + y) * W + p.x) * 4);
    }
    return { image: full, blend: p.blend, opacity: p.opacity };
  });
  return { out, dst, parts, ox: -out.offsetX, oy: -out.offsetY };
}

// a hard drop shadow straight down by 15 px: its pixels below the square are shadow alone
const hardShadow = (patch) => ({ dropShadow: { enabled: true, distance: 15, angle: 90, size: 0, spread: 0, opacity: 1, ...patch } });

test('a red Multiply drop shadow over grey multiplies with the grey, where the merged render drew it as Normal', () => {
  const img = square();
  const { out, dst, parts, ox, oy } = stacked(img, hardShadow({ color: '#ff0000', blend: 'multiply' }), [128, 128, 128, 1]);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].blend, 'multiply');
  compositeAdvanced({ dst, layer: out.layer, parts, mode: 'normal', opacity: 1 });
  // (20, 38) in the layer: under the square's shadow, below the square
  assert.deepEqual(px(dst, ox + 20, oy + 38), [128, 0, 0, 255]);
  // the square itself is the layer's colour (its shadow is knocked out under it)
  assert.deepEqual(px(dst, ox + 20, oy + 20), [255, 136, 0, 255]);
  // the merged image (what a render against transparency gives) holds the shadow as plain red: drawn with Normal
  // over the grey it would give (255, 0, 0)
  const merged = solid(out.image.width, out.image.height, [128, 128, 128, 1]);
  blendImages('normal', out.image, merged, 1);
  assert.deepEqual(px(merged, ox + 20, oy + 38), [255, 0, 0, 255]);
});

test('a Screen outer glow over white is invisible; over black it shows', () => {
  const img = square();
  const glow = { outerGlow: { enabled: true, color: '#ffff00', blend: 'screen', opacity: 1, size: 6, spread: 50 } };
  const white = stacked(img, glow, [255, 255, 255, 1]);
  assert.deepEqual(white.parts.map((p) => p.blend), ['screen']);
  compositeAdvanced({ dst: white.dst, layer: white.out.layer, parts: white.parts, mode: 'normal', opacity: 1 });
  for (let y = 0; y < white.dst.height; y++) {
    for (let x = 0; x < white.dst.width; x++) {
      const inSquare = x >= white.ox + 10 && x < white.ox + 30 && y >= white.oy + 10 && y < white.oy + 30;
      if (!inSquare) assert.deepEqual(px(white.dst, x, y), [255, 255, 255, 255], `(${x}, ${y})`);
    }
  }
  const black = stacked(img, glow, [0, 0, 0, 1]);
  compositeAdvanced({ dst: black.dst, layer: black.out.layer, parts: black.parts, mode: 'normal', opacity: 1 });
  assert.deepEqual(px(black.dst, black.ox + 8, black.oy + 20), [255, 255, 0, 255]);
});

test('a Normal shadow under 50 % layer opacity: one fade of shadow and layer together, which the merged image drawn at 50 % matches', () => {
  const img = square();
  const { out, dst, parts, ox, oy } = stacked(img, hardShadow({ color: '#000000', blend: 'normal', opacity: 0.8 }), [200, 200, 200, 1]);
  compositeAdvanced({ dst, layer: out.layer, parts, mode: 'normal', opacity: 0.5 });
  // shadow alone: 200 -> 200 * 0.2 = 40 at full opacity, halfway back to 200 at 50 %
  assert.deepEqual(px(dst, ox + 20, oy + 38), [120, 120, 120, 255]);
  // the square: the shadow is knocked out under it, so the orange fades towards the grey only
  assert.deepEqual(px(dst, ox + 20, oy + 20), [228, 168, 100, 255]);
  // Normal over Normal is one source-over: the compositor's fast path (the merged image at the layer's opacity)
  const fast = solid(out.image.width, out.image.height, [200, 200, 200, 1]);
  blendImages('normal', out.image, fast, 0.5);
  for (let i = 0; i < fast.data.length; i++) assert.ok(Math.abs(fast.data[i] - dst.data[i]) <= 1, `byte ${i}`);
});

test('Fill 0 % with a Multiply drop shadow: the layer draws nothing, the shadow shows outside it only', () => {
  const img = square();
  const { out, dst, parts, ox, oy } = stacked(img, hardShadow({ color: '#ff0000', blend: 'multiply', distance: 5 }), [128, 128, 128, 1], { fillOpacity: 0 });
  // the content is fully transparent
  for (let p = 3; p < out.layer.data.length; p += 4) assert.equal(out.layer.data[p], 0);
  compositeAdvanced({ dst, layer: out.layer, parts, mode: 'multiply', opacity: 1 });
  // where the square was, the shadow is knocked out: the backdrop
  assert.deepEqual(px(dst, ox + 20, oy + 25), [128, 128, 128, 255]);
  // below the square, the shadow multiplies with the grey
  assert.deepEqual(px(dst, ox + 20, oy + 32), [128, 0, 0, 255]);
});

test('a Multiply layer with a Normal stroke: the stroke stays Normal while the content multiplies', () => {
  const img = square();
  const styles = { stroke: { enabled: true, size: 3, position: 'outside', color: '#0000ff', blend: 'normal' } };
  const { out, dst, parts, ox, oy } = stacked(img, styles, [128, 128, 128, 1]);
  assert.deepEqual(parts.map((p) => p.blend), ['normal']);
  compositeAdvanced({ dst, layer: out.layer, parts, mode: 'multiply', opacity: 1 });
  assert.deepEqual(px(dst, ox + 8, oy + 20), [0, 0, 255, 255]);
  assert.deepEqual(px(dst, ox + 20, oy + 20), [128, 68, 0, 255]);
});

test('split parts in order onto transparency and the layer over them with Normal give the merged image', () => {
  const img = square(48, 12, 24);
  const styles = {
    dropShadow: { enabled: true, distance: 6, size: 4, blend: 'multiply', opacity: 0.7 },
    outerGlow: { enabled: true, size: 5, blend: 'screen', color: '#ffff80' },
    stroke: { enabled: true, size: 2, position: 'center', color: '#202080', blend: 'overlay' },
    bevel: { enabled: true, style: 'emboss', size: 4 },
    innerShadow: { enabled: true, distance: 3, size: 2 },
  };
  const out = applyStyles(img, styles, { split: true });
  const plain = applyStyles(img, styles);
  assert.deepEqual(Array.from(out.image.data), Array.from(plain.image.data), 'the merged image is unchanged by split');
  // drop shadow, outer glow, the emboss's outer highlights and shadows, the outer half of the stroke
  assert.deepEqual(out.parts.map((p) => p.key + (p.part ? `:${p.part}` : '')), ['dropShadow', 'outerGlow', 'bevel:outer-highlight', 'bevel:outer-shadow', 'stroke:outer']);
  assert.deepEqual(out.parts.map((p) => p.blend), ['multiply', 'screen', 'screen', 'multiply', 'overlay']);
  const W = out.image.width, H = out.image.height;
  const acc = createImage(W, H);
  out.parts.forEach((p, i) => {
    const full = createImage(W, H);
    for (let y = 0; y < p.image.height; y++) full.data.set(p.image.data.subarray(y * p.image.width * 4, (y + 1) * p.image.width * 4), ((p.y + y) * W + p.x) * 4);
    // over transparency every mode gives the source: the first part is copied, as applyStyles does
    if (i === 0) for (let q = 0; q < full.data.length; q += 4) full.data[q + 3] = Math.round(full.data[q + 3] * p.opacity);
    blendImages(i === 0 ? 'normal' : p.blend, full, acc, i === 0 ? 1 : p.opacity);
  });
  blendImages('normal', out.layer, acc, 1);
  for (let i = 0; i < acc.data.length; i++) assert.ok(Math.abs(acc.data[i] - out.image.data[i]) <= 1, `byte ${i}: ${acc.data[i]} vs ${out.image.data[i]}`);
});

test('exteriorBlends lists the modes of the effects drawn outside the layer, bottom first', () => {
  assert.deepEqual(exteriorBlends(null), []);
  assert.deepEqual(exteriorBlends({ colorOverlay: { enabled: true }, innerGlow: { enabled: true }, satin: { enabled: true } }), []);
  assert.deepEqual(exteriorBlends({ stroke: { enabled: true, position: 'inside' }, bevel: { enabled: true } }), [], 'an inside stroke and an inner bevel are interior');
  assert.deepEqual(exteriorBlends({ dropShadow: { enabled: true } }), ['multiply'], "Photoshop's default drop shadow multiplies");
  assert.deepEqual(exteriorBlends({ outerGlow: { enabled: true }, stroke: { enabled: true, position: 'center' } }), ['screen', 'normal']);
  assert.deepEqual(exteriorBlends({ bevel: { enabled: true, style: 'outer-bevel' } }), ['screen', 'multiply']);
  assert.deepEqual(exteriorBlends({ dropShadow: { enabled: true, opacity: 0 } }), [], 'an invisible effect draws nothing');
  assert.deepEqual(exteriorBlends({ dropShadow: { enabled: true }, hidden: true }), [], 'Hide All Effects');
  assert.deepEqual(exteriorBlends({ dropShadow: [{ enabled: true, blend: 'normal' }, { enabled: true, blend: 'screen' }] }), ['screen', 'normal'], 'instances: the bottom one first');
});

test('knockout comes between the exterior effects and the layer; the opacity fades it all as one', () => {
  const W = 3;
  const dst = solid(W, 1, [0, 0, 255, 1]);
  const shadow = solid(W, 1, [0, 0, 0, 1]);
  const layer = createImage(W, 1); // fill 0: the content draws nothing
  const white = solid(W, 1, [255, 255, 255, 1]);
  compositeAdvanced({ dst, layer, parts: [{ image: shadow, blend: 'normal', opacity: 1 }], knock: white, shape: new Uint8ClampedArray([255, 0, 0]), knockout: 'deep', opacity: 0.5 });
  // knocked out to white, then halfway back to the blue backdrop
  assert.deepEqual(px(dst, 0, 0), [128, 128, 255, 255]);
  // outside the shape: the black shadow, halfway back to blue
  assert.deepEqual(px(dst, 1, 0), [0, 0, 128, 255]);
});

test('fadeFrom lerps premultiplied: a transparent side gives no colour', () => {
  const before = createImage(2, 1);
  setPixel(before, 1, 0, [0, 0, 255, 1]);
  const dst = createImage(2, 1);
  setPixel(dst, 0, 0, [255, 0, 0, 1]);
  setPixel(dst, 1, 0, [255, 0, 0, 1]);
  fadeFrom(dst, before, 0.25);
  assert.deepEqual(px(dst, 0, 0), [255, 0, 0, 64]);
  assert.deepEqual(px(dst, 1, 0), [64, 0, 191, 255]);
});

/** Places a cropped part ({ image, x, y } in the output) on a transparent image of the output's size. */
function placed(p, W, H) {
  const full = createImage(W, H);
  for (let y = 0; y < p.image.height; y++) {
    const s = y * p.image.width * 4;
    full.data.set(p.image.data.subarray(s, s + p.image.width * 4), ((p.y + y) * W + p.x) * 4);
  }
  return { image: full, blend: p.blend, opacity: p.opacity };
}

test('Blend Interior Effects as Group off: a Normal Color Overlay on a Multiply layer is not multiplied; on, it is', () => {
  // Photoshop's Blending Options: the option "applies the blending mode of the layer to layer effects that modify
  // opaque pixels" such as Color Overlay; off (the default), the layer's mode applies to its content only
  const img = square(40, 10, 20, [255, 255, 255, 1]);
  const styles = { colorOverlay: { enabled: true, color: '#ff0000', blend: 'normal', opacity: 1 } };
  for (const fill of [1, 0.5]) {
    const out = applyStyles(img, styles, { split: true, interior: true, fillOpacity: fill });
    const W = out.image.width, H = out.image.height;
    assert.equal(out.inner.length, 1);
    assert.equal(out.inner[0].key, 'colorOverlay');
    // the content alone: white at the fill, no overlay in it
    assert.deepEqual(px(out.layer, 20, 20), [255, 255, 255, Math.round(255 * fill)]);
    const dst = solid(W, H, [128, 128, 128, 1]);
    compositeAdvanced({ dst, layer: out.layer, inner: out.inner.map((p) => placed(p, W, H)), mode: 'multiply', opacity: 1 });
    assert.deepEqual(px(dst, 20, 20), [255, 0, 0, 255], `fill ${fill}`);
    // the merged render (the option on) is the overlay multiplied as part of the layer
    const merged = applyStyles(img, styles, { interiorAsGroup: true, fillOpacity: fill });
    const on = solid(W, H, [128, 128, 128, 1]);
    blendImages('multiply', merged.image, on, 1);
    assert.deepEqual(px(on, 20, 20), fill === 1 ? [128, 0, 0, 255] : [128, 64, 64, 255]);
  }
  // interior is ignored with the option on (the effects stay in the layer)
  assert.equal(applyStyles(img, styles, { split: true, interior: true, interiorAsGroup: true }).inner, null);
});

test('Fill 0 % with an Overlay gradient blends the gradient with the image below; interior parts are cut to the shape', () => {
  const img = square(40, 10, 20, [0, 0, 0, 1]);
  const styles = { colorOverlay: { enabled: true, color: '#ffffff', blend: 'overlay', opacity: 1 } };
  const out = applyStyles(img, styles, { split: true, interior: true, fillOpacity: 0 });
  const W = out.image.width, H = out.image.height;
  const dst = solid(W, H, [200, 100, 50, 1]);
  compositeAdvanced({ dst, layer: out.layer, inner: out.inner.map((p) => placed(p, W, H)), mode: 'normal', opacity: 1 });
  // white in Overlay over (200, 100, 50): 2·b where b is below the middle, else white: (255, 200, 100); the merged
  // render drew the overlay against the empty content, which shows it as plain white
  assert.deepEqual(px(dst, 20, 20), [255, 200, 100, 255]);
  // outside the shape nothing changes
  assert.deepEqual(px(dst, 5, 5), [200, 100, 50, 255]);
  assert.equal(px(out.inner[0].image, 0, 0)[3], 255);
  assert.ok(out.inner[0].image.width <= 20 && out.inner[0].image.height <= 20);
});

test('interiorBlends and splitsInterior: which layers draw their interior effects apart', () => {
  const overlay = { colorOverlay: { enabled: true, color: '#ff0000', blend: 'normal' } };
  assert.deepEqual(interiorBlends(overlay), ['normal']);
  assert.deepEqual(interiorBlends({ innerShadow: { enabled: true }, bevel: { enabled: true, style: 'outer-bevel' } }), ['multiply']);
  assert.deepEqual(interiorBlends({ bevel: { enabled: true, style: 'inner-bevel' }, stroke: { enabled: true, position: 'center' } }), ['screen', 'multiply', 'normal']);
  assert.equal(splitsInterior(overlay, { mode: 'multiply' }), true);
  assert.equal(splitsInterior(overlay, { mode: 'multiply', interiorAsGroup: true }), false);
  assert.equal(splitsInterior(overlay, { mode: 'normal', fillOpacity: 0.5 }), false);
  assert.equal(splitsInterior({ innerShadow: { enabled: true, color: '#3050a0' } }, { mode: 'normal', fillOpacity: 0.5 }), true);
  // a black Multiply inner shadow draws as Normal: no need to split at a reduced fill
  assert.equal(splitsInterior({ innerShadow: { enabled: true } }, { mode: 'normal', fillOpacity: 0.5 }), false);
  assert.equal(splitsInterior({ dropShadow: { enabled: true } }, { mode: 'multiply' }), false);
});

test('exteriorBlends asDrawn: a black Multiply shadow and a white Screen glow draw as Normal, coloured ones do not', () => {
  const st = {
    dropShadow: { enabled: true, color: '#000000', blend: 'multiply' },
    outerGlow: { enabled: true, color: '#ffffff', blend: 'screen' },
    stroke: { enabled: true, position: 'outside', color: '#000000', blend: 'darken' },
  };
  assert.deepEqual(exteriorBlends(st), ['multiply', 'screen', 'darken']);
  assert.deepEqual(exteriorBlends(st, { asDrawn: true }), ['normal', 'normal', 'normal']);
  // Photoshop's default glow is pale yellow: Screen stays Screen; a gradient glow has no single colour
  assert.deepEqual(exteriorBlends({ outerGlow: { enabled: true } }, { asDrawn: true }), ['screen']);
  assert.deepEqual(exteriorBlends({ outerGlow: { enabled: true, color: '#ffffff', fill: 'gradient' } }, { asDrawn: true }), ['screen']);
  assert.deepEqual(exteriorBlends({ dropShadow: { enabled: true, color: '#200000' } }, { asDrawn: true }), ['multiply']);
  // the default bevel's highlight is white Screen and its shadow black Multiply: Normal both
  assert.deepEqual(exteriorBlends({ bevel: { enabled: true, style: 'outer-bevel' } }, { asDrawn: true }), ['normal', 'normal']);
  // and the same picture: black Multiply over grey equals black Normal at the same alpha
  const a = solid(4, 1, [128, 128, 128, 1]), b = solid(4, 1, [128, 128, 128, 1]);
  const shadow = solid(4, 1, [0, 0, 0, 0.6]);
  blendImages('multiply', shadow, a, 0.75);
  blendImages('normal', shadow, b, 0.75);
  assert.deepEqual(Array.from(a.data), Array.from(b.data));
});

test('merged exterior effects (`below`) without knockout keep the order of 0.3: it and the layer each at the opacity', () => {
  const img = square();
  const st = hardShadow({ color: '#000000', blend: 'normal', opacity: 0.75 });
  const out = applyStyles(img, st, { split: true });
  const W = out.image.width, H = out.image.height;
  const blendIf = { gray: { this: [0, 0, 255, 255], under: [0, 40, 255, 255] } };
  for (const opacity of [1, 0.6]) {
    const dst = solid(W, H, [90, 160, 220, 1]);
    compositeAdvanced({ dst, layer: out.layer, below: out.below, blendIf, mode: 'normal', opacity });
    // by hand, as 0.3 did it
    const ref = solid(W, H, [90, 160, 220, 1]);
    blendImages('normal', out.below, ref, opacity, null, 1);
    const before = solid(W, H, [90, 160, 220, 1]);
    const merged = { width: W, height: H, data: new Uint8ClampedArray(out.layer.data) };
    compositeAdvanced({ dst: before, layer: null, blendIf, mode: 'normal', opacity: 1 });
    const only = solid(W, H, [90, 160, 220, 1]);
    blendImages('normal', out.below, only, opacity, null, 1);
    const layerOnly = solid(W, H, [90, 160, 220, 1]);
    compositeAdvanced({ dst: layerOnly, layer: merged, blendIf, mode: 'normal', opacity });
    // the layer's pixels are where the shadow is knocked out: the two steps do not overlap there
    assert.deepEqual(px(dst, -out.offsetX + 20, -out.offsetY + 20), px(layerOnly, -out.offsetX + 20, -out.offsetY + 20));
    assert.deepEqual(px(dst, -out.offsetX + 20, -out.offsetY + 38), px(only, -out.offsetX + 20, -out.offsetY + 38));
  }
});
