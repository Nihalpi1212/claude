import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_STYLES, STYLE_KEYS, mergeStyles, stylePadding, applyStyles, hasEnabledStyles } from '../../src/shared/pixels/styles.js';
import { createImage, setPixel, getPixel, luminance, randomSeeded } from '../../src/shared/pixels/core.js';
import { assertPixel } from './helpers.mjs';

const RED = [255, 0, 0, 1];
const BLUE = '#0000ff';

/** size x size transparent image with an opaque square [x0, x0 + side) x [x0, x0 + side). */
function square(size = 12, x0 = 4, side = 4, rgba = RED) {
  const img = createImage(size, size);
  for (let y = x0; y < x0 + side; y++) for (let x = x0; x < x0 + side; x++) setPixel(img, x, y, rgba);
  return img;
}

/** Pixel of a styled result at source coordinates (x, y). */
const at = (res, x, y) => getPixel(res.image, x - res.offsetX, y - res.offsetY);
const alphaAt = (res, x, y) => Math.round(at(res, x, y)[3] * 255);
const inSquare = (x, y, x0 = 4, side = 4) => x >= x0 && x < x0 + side && y >= x0 && y < x0 + side;

/** Calls fn(x, y, rgba) for every output pixel, in source coordinates. */
function eachOut(res, fn) {
  for (let oy = 0; oy < res.image.height; oy++) for (let ox = 0; ox < res.image.width; ox++) fn(ox + res.offsetX, oy + res.offsetY, getPixel(res.image, ox, oy));
}

test('DEFAULT_STYLES and STYLE_KEYS describe every effect, disabled, with Photoshop defaults', () => {
  assert.equal(STYLE_KEYS.length, 10);
  assert.deepEqual(STYLE_KEYS.map((k) => k.key), Object.keys(DEFAULT_STYLES));
  assert.equal(STYLE_KEYS.find((k) => k.key === 'bevel').name, 'Bevel & Emboss');
  for (const { key, name } of STYLE_KEYS) {
    assert.equal(typeof name, 'string');
    assert.equal(DEFAULT_STYLES[key].enabled, false, key);
  }
  assert.ok(Object.isFrozen(DEFAULT_STYLES) && Object.isFrozen(DEFAULT_STYLES.dropShadow) && Object.isFrozen(DEFAULT_STYLES.gradientOverlay.stops[0]));
  assert.deepEqual(DEFAULT_STYLES.dropShadow, { enabled: false, blend: 'multiply', color: '#000000', opacity: 0.75, angle: 120, distance: 5, spread: 0, size: 5 });
  assert.deepEqual(DEFAULT_STYLES.innerShadow, { ...DEFAULT_STYLES.dropShadow });
  assert.deepEqual(DEFAULT_STYLES.outerGlow, { enabled: false, blend: 'screen', color: '#ffffbe', opacity: 0.75, spread: 0, size: 5 });
  assert.equal(DEFAULT_STYLES.innerGlow.source, 'edge');
  assert.equal(DEFAULT_STYLES.innerGlow.choke, 0);
  const bv = DEFAULT_STYLES.bevel;
  assert.deepEqual([bv.style, bv.depth, bv.direction, bv.size, bv.soften, bv.angle, bv.altitude], ['inner-bevel', 100, 'up', 5, 0, 120, 30]);
  assert.deepEqual([bv.highlightColor, bv.highlightOpacity, bv.highlightBlend, bv.shadowColor, bv.shadowOpacity, bv.shadowBlend], ['#ffffff', 0.75, 'screen', '#000000', 0.75, 'multiply']);
  assert.deepEqual(DEFAULT_STYLES.satin, { enabled: false, color: '#000000', opacity: 0.5, blend: 'multiply', angle: 19, distance: 11, size: 14, invert: true });
  assert.deepEqual(DEFAULT_STYLES.colorOverlay, { enabled: false, color: '#ff0000', opacity: 1, blend: 'normal' });
  assert.deepEqual(DEFAULT_STYLES.gradientOverlay.stops, [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }]);
  assert.deepEqual([DEFAULT_STYLES.gradientOverlay.kind, DEFAULT_STYLES.gradientOverlay.angle, DEFAULT_STYLES.gradientOverlay.reverse], ['linear', 90, false]);
  assert.equal(DEFAULT_STYLES.patternOverlay.pattern, null);
  assert.deepEqual(DEFAULT_STYLES.stroke, { enabled: false, size: 3, position: 'outside', color: '#000000', opacity: 1, blend: 'normal' });
});

test('mergeStyles fills defaults and returns fresh objects', () => {
  assert.deepEqual(mergeStyles(), DEFAULT_STYLES);
  assert.deepEqual(mergeStyles(null), DEFAULT_STYLES);
  const pattern = createImage(2, 2, [1, 2, 3, 1]);
  const partial = { dropShadow: { enabled: true, size: 9, distance: undefined }, patternOverlay: { pattern }, bogus: { enabled: true } };
  const m = mergeStyles(partial);
  assert.deepEqual(m.dropShadow, { ...DEFAULT_STYLES.dropShadow, enabled: true, size: 9 });
  assert.equal(m.dropShadow.distance, 5, 'undefined fields keep the default');
  assert.equal(m.patternOverlay.pattern, pattern, 'patterns are kept by reference');
  assert.equal(m.bogus, undefined);
  assert.deepEqual(Object.keys(m), Object.keys(DEFAULT_STYLES));
  assert.deepEqual(m.stroke, DEFAULT_STYLES.stroke);
  assert.deepEqual(partial.dropShadow, { enabled: true, size: 9, distance: undefined }, 'input untouched');
  // fresh, mutable copies
  m.stroke.size = 40;
  m.gradientOverlay.stops[0].color = '#123456';
  assert.equal(DEFAULT_STYLES.stroke.size, 3);
  assert.equal(DEFAULT_STYLES.gradientOverlay.stops[0].color, '#000000');
  const stops = [{ pos: 0.2, color: '#ff0000' }];
  const g = mergeStyles({ gradientOverlay: { stops } }).gradientOverlay;
  assert.deepEqual(g.stops, stops);
  assert.notEqual(g.stops, stops);
  // merging a merged object is a no-op
  assert.deepEqual(mergeStyles(m), m);
  assert.equal(hasEnabledStyles(m), true);
  assert.equal(hasEnabledStyles(DEFAULT_STYLES), false);
  assert.equal(hasEnabledStyles(null), false);
});

test('stylePadding: max over enabled effects that reach outside the layer', () => {
  assert.equal(stylePadding(null), 0);
  assert.equal(stylePadding({}), 0);
  assert.equal(stylePadding(DEFAULT_STYLES), 0);
  assert.equal(stylePadding({ dropShadow: { enabled: false, size: 50 } }), 0);
  assert.equal(stylePadding({ dropShadow: { enabled: true } }), 10); // 5 + 5 + 0
  assert.equal(stylePadding({ dropShadow: { enabled: true, size: 10 } }), 15);
  assert.equal(stylePadding({ dropShadow: { enabled: true, size: 20 } }), 25);
  assert.equal(stylePadding({ dropShadow: { enabled: true, size: 2, distance: -7, spread: 3 } }), 12);
  assert.equal(stylePadding({ dropShadow: { enabled: true, size: 2.2, distance: 0 } }), 3, 'rounded up');
  assert.equal(stylePadding({ outerGlow: { enabled: true, size: 8, spread: 2 } }), 10);
  assert.equal(stylePadding({ stroke: { enabled: true } }), 3);
  assert.equal(stylePadding({ stroke: { enabled: true, position: 'inside', size: 9 } }), 0);
  assert.equal(stylePadding({ stroke: { enabled: true, position: 'center', size: 3 } }), 2);
  assert.equal(stylePadding({ bevel: { enabled: true, size: 6 } }), 0, 'inner bevel stays inside');
  assert.equal(stylePadding({ bevel: { enabled: true, size: 6, style: 'outer-bevel' } }), 6);
  assert.equal(stylePadding({ bevel: { enabled: true, size: 6, style: 'emboss' } }), 3);
  for (const key of ['innerShadow', 'innerGlow', 'satin', 'colorOverlay', 'gradientOverlay', 'patternOverlay']) {
    assert.equal(stylePadding({ [key]: { enabled: true, size: 30, distance: 30 } }), 0, key);
  }
  assert.equal(stylePadding({ dropShadow: { enabled: true, size: 1, distance: 1 }, outerGlow: { enabled: true, size: 7 }, stroke: { enabled: true, size: 4 } }), 7);
});

test('all effects disabled returns an identical image with pad 0', () => {
  const img = square();
  for (const styles of [null, {}, DEFAULT_STYLES, { dropShadow: { enabled: false, size: 20 } }]) {
    const res = applyStyles(img, styles);
    assert.equal(res.offsetX, 0);
    assert.equal(res.offsetY, 0);
    assert.equal(res.image.width, 12);
    assert.equal(res.image.height, 12);
    assert.deepEqual(res.image.data, img.data);
    assert.notEqual(res.image.data, img.data, 'a copy');
  }
  // an explicit pad still grows the output
  const padded = applyStyles(img, null, { pad: 3 });
  assert.deepEqual([padded.image.width, padded.image.height, padded.offsetX, padded.offsetY], [18, 18, -3, -3]);
  eachOut(padded, (x, y, p) => assertPixel(p, getPixel(img, x, y), 0, `${x},${y}`));
  // a fully transparent layer stays transparent
  const empty = applyStyles(createImage(5, 5), { dropShadow: { enabled: true }, stroke: { enabled: true } });
  assert.equal(empty.image.width, 5 + 2 * 10);
  assert.ok(empty.image.data.every((v) => v === 0));
});

test('drop shadow: offset down-right along the light angle, nothing up-left, output grows by 2 * pad', () => {
  const img = square();
  const res = applyStyles(img, { dropShadow: { enabled: true, distance: 2, size: 0 } });
  assert.equal(stylePadding({ dropShadow: { enabled: true, distance: 2, size: 0 } }), 2);
  assert.deepEqual([res.image.width, res.image.height, res.offsetX, res.offsetY], [16, 16, -2, -2]);
  // angle 120, distance 2 -> shadow shifted by (+1, +2) (rounded)
  let shadow = 0;
  eachOut(res, (x, y, p) => {
    if (inSquare(x, y)) return assertPixel(p, RED, 0, `layer ${x},${y}`);
    const inShadow = x >= 5 && x < 9 && y >= 6 && y < 10;
    if (inShadow) {
      assertPixel(p, [0, 0, 0, 0.75], 1, `shadow ${x},${y}`);
      shadow++;
    } else assert.equal(p[3], 0, `transparent ${x},${y}`);
    if (x < 4 || y < 4) assert.equal(p[3], 0, `nothing up-left ${x},${y}`);
  });
  assert.equal(shadow, 16 - 6);

  // blurred: the shadow's alpha-weighted centre lies down-right of the square's centre
  const soft = applyStyles(img, { dropShadow: { enabled: true, distance: 4, size: 4 } });
  let sx = 0, sy = 0, sw = 0;
  eachOut(soft, (x, y, p) => {
    if (inSquare(x, y)) return;
    sx += (x + 0.5) * p[3];
    sy += (y + 0.5) * p[3];
    sw += p[3];
  });
  assert.ok(sw > 0);
  assert.ok(sx / sw > 7 && sy / sw > 7, `centroid ${sx / sw}, ${sy / sw}`);
  assert.ok(alphaAt(soft, 9, 9) > alphaAt(soft, 2, 2));

  // the light angle turns the shadow: 0 = light from the right, shadow to the left
  const left = applyStyles(img, { dropShadow: { enabled: true, angle: 0, distance: 3, size: 0 } });
  assert.ok(alphaAt(left, 2, 5) > 0);
  assert.equal(alphaAt(left, 9, 5), 0);
  // useGlobalLight takes the document angle when the caller provides it
  const global = applyStyles(img, { dropShadow: { enabled: true, useGlobalLight: true, distance: 2, size: 0 } }, { globalAngle: -60 });
  assert.ok(alphaAt(global, 3, 2) > 0, 'light from lower right: shadow up-left');
  assert.equal(alphaAt(global, 8, 9), 0);
});

test('outer glow: coloured pixels all around, alpha decreasing with distance, no black fringe', () => {
  const res = applyStyles(square(), { outerGlow: { enabled: true } });
  assert.deepEqual([res.image.width, res.offsetX], [22, -5]);
  // the four sides, walking away from the edge
  const sides = [[(d) => [3 - d, 5]], [(d) => [8 + d, 6]], [(d) => [5, 3 - d]], [(d) => [6, 8 + d]]];
  for (const [pos] of sides) {
    let prev = 256;
    for (let d = 0; d < 4; d++) {
      const a = alphaAt(res, ...pos(d));
      assert.ok(a > 0 && a < prev, `alpha ${a} at distance ${d + 1} (prev ${prev})`);
      prev = a;
    }
  }
  assert.equal(alphaAt(res, 3, 5), alphaAt(res, 8, 5), 'symmetric');
  eachOut(res, (x, y, p) => {
    if (inSquare(x, y)) assertPixel(p, RED, 0);
    else if (p[3] > 0) assertPixel([p[0], p[1], p[2], 1], [255, 255, 190, 1], 0, `glow colour ${x},${y}`);
  });
  // spread hardens the glow: more alpha right at the edge
  const spread = applyStyles(square(), { outerGlow: { enabled: true, spread: 2 } });
  assert.ok(alphaAt(spread, 3, 5) > alphaAt(res, 3, 5));
  assert.equal(spread.offsetX, -7);
});

test('inner shadow and inner glow only change pixels inside the layer alpha', () => {
  const img = square();
  const shadow = applyStyles(img, { innerShadow: { enabled: true, distance: 2, size: 0 } });
  assert.deepEqual([shadow.image.width, shadow.offsetX], [12, 0]);
  eachOut(shadow, (x, y, p) => {
    if (!inSquare(x, y)) assert.deepEqual(p, [0, 0, 0, 0], `outside ${x},${y}`);
    else assert.equal(p[3], 1);
  });
  // light from the upper left: the shadow hugs the top and left inner edges
  assertPixel(at(shadow, 4, 4), [64, 0, 0, 1], 1, 'top-left in shadow');
  assertPixel(at(shadow, 7, 4), [64, 0, 0, 1], 1, 'top edge in shadow');
  assertPixel(at(shadow, 4, 7), [64, 0, 0, 1], 1, 'left edge in shadow');
  assertPixel(at(shadow, 7, 7), RED, 0, 'bottom-right lit');
  assertPixel(at(shadow, 6, 6), RED, 0);

  const glow = applyStyles(img, { innerGlow: { enabled: true } });
  assert.equal(glow.image.width, 12);
  eachOut(glow, (x, y, p) => {
    if (!inSquare(x, y)) assert.deepEqual(p, [0, 0, 0, 0], `outside ${x},${y}`);
    else {
      assert.equal(p[3], 1);
      assert.equal(p[0], 255);
      assert.ok(p[1] > 0, 'screen with pale yellow lightens');
    }
  });
  assert.ok(at(glow, 4, 4)[1] > at(glow, 4, 5)[1] && at(glow, 4, 5)[1] > at(glow, 5, 5)[1], 'edge glows most');

  // far from the edge nothing changes; 'center' glows from the middle instead
  const big = square(16, 2, 12);
  const edge = applyStyles(big, { innerGlow: { enabled: true, size: 2 } });
  assertPixel(at(edge, 8, 8), RED, 0);
  assert.ok(at(edge, 2, 8)[1] > 30 && at(edge, 2, 8)[1] > at(edge, 3, 8)[1]);
  const center = applyStyles(big, { innerGlow: { enabled: true, size: 2, source: 'center' } });
  assert.ok(at(center, 8, 8)[1] > 150);
  assert.ok(at(center, 2, 8)[1] < at(center, 8, 8)[1]);
  // choke makes the edge glow solid deeper inside
  const choked = applyStyles(big, { innerGlow: { enabled: true, size: 2, choke: 3 } });
  assert.ok(at(choked, 4, 8)[1] > at(edge, 4, 8)[1]);
});

test('stroke outside size 1 adds exactly a 1px ring of the stroke colour', () => {
  const res = applyStyles(square(), { stroke: { enabled: true, size: 1, color: BLUE } });
  assert.deepEqual([res.image.width, res.image.height, res.offsetX, res.offsetY], [14, 14, -1, -1]);
  let ring = 0;
  eachOut(res, (x, y, p) => {
    if (inSquare(x, y)) return assertPixel(p, RED, 0, `layer ${x},${y}`);
    const axisRing = (x >= 4 && x < 8 && (y === 3 || y === 8)) || (y >= 4 && y < 8 && (x === 3 || x === 8));
    const corner = (x === 3 || x === 8) && (y === 3 || y === 8);
    if (axisRing) {
      assertPixel(p, [0, 0, 255, 1], 0, `ring ${x},${y}`);
      ring++;
    } else if (corner) {
      assert.ok(p[3] > 0.3 && p[3] < 1, `antialiased corner ${p}`);
      assert.deepEqual(p.slice(0, 3), [0, 0, 255]);
    } else assert.equal(p[3], 0, `beyond the ring ${x},${y}`);
  });
  assert.equal(ring, 16);
  let opaqueBlue = 0;
  eachOut(res, (x, y, p) => { if (p[2] === 255 && p[3] === 1) opaqueBlue++; });
  assert.equal(opaqueBlue, 16);

  // size 2: two full rings on the axes
  const thick = applyStyles(square(), { stroke: { enabled: true, size: 2, color: BLUE } });
  assertPixel(at(thick, 2, 5), [0, 0, 255, 1], 0);
  assertPixel(at(thick, 9, 5), [0, 0, 255, 1], 0);
  assert.equal(alphaAt(thick, 1, 5), 0);
});

test('stroke inside keeps the outer size but recolours the border; center straddles the edge', () => {
  const inside = applyStyles(square(), { stroke: { enabled: true, size: 1, position: 'inside', color: BLUE } });
  assert.deepEqual([inside.image.width, inside.offsetX], [12, 0]);
  let border = 0;
  eachOut(inside, (x, y, p) => {
    if (!inSquare(x, y)) return assert.equal(p[3], 0, `outside ${x},${y}`);
    if (inSquare(x, y, 5, 2)) assertPixel(p, RED, 0, `core ${x},${y}`);
    else {
      assertPixel(p, [0, 0, 255, 1], 0, `border ${x},${y}`);
      border++;
    }
  });
  assert.equal(border, 12);

  const center = applyStyles(square(), { stroke: { enabled: true, size: 2, position: 'center', color: BLUE } });
  assert.deepEqual([center.image.width, center.offsetX], [14, -1]);
  assertPixel(at(center, 3, 5), [0, 0, 255, 1], 0, 'outer half');
  assertPixel(at(center, 4, 5), [0, 0, 255, 1], 0, 'inner half');
  assertPixel(at(center, 5, 5), RED, 0, 'core');
  assert.equal(alphaAt(center, 2, 5), 0);

  // stroke opacity and blend apply to the ring only
  const faint = applyStyles(square(), { stroke: { enabled: true, size: 1, color: BLUE, opacity: 0.5 } });
  assertPixel(at(faint, 3, 5), [0, 0, 255, 0.5], 1);
  assertPixel(at(faint, 4, 5), RED, 0);
});

test('outside stroke leaves no seam on antialiased edges and ignores a see-through fill', () => {
  const img = square();
  for (let y = 4; y < 8; y++) setPixel(img, 8, y, [255, 0, 0, 0.5]); // half-covered column on the right edge
  const res = applyStyles(img, { stroke: { enabled: true, size: 2, color: BLUE } });
  // stroke + layer cover the antialiased pixel completely, mixing both colours
  const p = at(res, 8, 5);
  assert.equal(p[3], 1);
  assert.ok(p[0] > 100 && p[2] > 100, `mixed ${p}`);
  assertPixel(at(res, 9, 5), [0, 0, 255, 1], 0);

  const hollow = applyStyles(square(), { stroke: { enabled: true, size: 1, color: BLUE } }, { fillOpacity: 0 });
  assertPixel(at(hollow, 3, 5), [0, 0, 255, 1], 0, 'ring stays');
  assert.equal(alphaAt(hollow, 5, 5), 0, 'interior shows nothing');
});

test('colour overlay replaces the colour but keeps alpha', () => {
  const img = square();
  setPixel(img, 4, 4, [255, 0, 0, 0.5]);
  const res = applyStyles(img, { colorOverlay: { enabled: true, color: BLUE } });
  assert.equal(res.image.width, 12);
  eachOut(res, (x, y, p) => {
    const src = getPixel(img, x, y);
    assert.equal(p[3], src[3], `alpha ${x},${y}`);
    if (src[3] > 0) assert.deepEqual(p.slice(0, 3), [0, 0, 255]);
  });
  const half = applyStyles(img, { colorOverlay: { enabled: true, color: BLUE, opacity: 0.5 } });
  assertPixel(at(half, 5, 5), [128, 0, 128, 1], 1);
  const multiply = applyStyles(img, { colorOverlay: { enabled: true, color: '#808080', blend: 'multiply' } });
  assertPixel(at(multiply, 5, 5), [128, 0, 0, 1], 1);
  // fill opacity 0 hides the layer's own pixels, not the overlay
  const fill0 = applyStyles(img, { colorOverlay: { enabled: true, color: BLUE } }, { fillOpacity: 0 });
  assertPixel(at(fill0, 5, 5), [0, 0, 255, 1], 0);
  assertPixel(at(fill0, 4, 4), [0, 0, 255, 0.5], 1);
  const fillHalf = applyStyles(img, null, { fillOpacity: 0.5 });
  assertPixel(at(fillHalf, 5, 5), [255, 0, 0, 0.5], 1);
  assert.equal(applyStyles(img, null, { fillOpacity: 0 }).image.data.every((v) => v === 0), true);
});

test('gradient overlay follows angle, kind and reverse', () => {
  const img = square();
  const res = applyStyles(img, { gradientOverlay: { enabled: true, angle: 0 } });
  for (let y = 4; y < 8; y++) {
    const row = [4, 5, 6, 7].map((x) => at(res, x, y));
    for (const p of row) assert.equal(p[3], 1);
    assert.deepEqual(row.map((p) => p[0]), [32, 96, 159, 223], 'black to white, left to right');
    for (const p of row) assert.ok(p[0] === p[1] && p[1] === p[2], 'grey');
  }
  assert.equal(alphaAt(res, 3, 5), 0);
  const reversed = applyStyles(img, { gradientOverlay: { enabled: true, angle: 0, reverse: true } });
  assert.ok(at(reversed, 4, 5)[0] > at(reversed, 7, 5)[0]);
  const up = applyStyles(img, { gradientOverlay: { enabled: true } }); // angle 90: from the bottom (first stop) to the top
  assert.ok(at(up, 5, 4)[0] > at(up, 5, 7)[0]);
  assert.equal(at(up, 4, 5)[0], at(up, 7, 5)[0]);
  const radial = applyStyles(square(16, 2, 12), { gradientOverlay: { enabled: true, kind: 'radial' } });
  // centre at (8, 8), radius 6: pixel (7, 7) is 0.7 px from the centre -> t = 0.12
  assert.ok(at(radial, 7, 7)[0] < 40 && at(radial, 2, 2)[0] === 255);
  assert.equal(at(radial, 7, 7)[0], at(radial, 8, 8)[0], 'symmetric about the centre');
  const reflected = applyStyles(square(16, 2, 12), { gradientOverlay: { enabled: true, kind: 'reflected', angle: 0 } });
  assert.ok(at(reflected, 7, 7)[0] < 40 && at(reflected, 2, 7)[0] > 200 && at(reflected, 13, 7)[0] > 200);
  assert.equal(at(reflected, 7, 7)[0], at(reflected, 8, 7)[0]);
  for (const kind of ['angle', 'diamond']) {
    const r = applyStyles(square(16, 2, 12), { gradientOverlay: { enabled: true, kind } });
    assert.ok(new Set([2, 5, 8, 11].map((x) => at(r, x, 3)[0])).size > 1, kind);
  }
  // stop opacity fades the overlay; colours interpolate between stops
  const stops = [{ pos: 0, color: '#0000ff', opacity: 0 }, { pos: 1, color: '#0000ff', opacity: 0 }];
  assertPixel(at(applyStyles(img, { gradientOverlay: { enabled: true, stops } }), 5, 5), RED, 0);
  const three = applyStyles(square(16, 0, 16), { gradientOverlay: { enabled: true, angle: 0, stops: [{ pos: 0, color: '#ff0000' }, { pos: 0.5, color: '#00ff00' }, { pos: 1, color: '#0000ff' }] } });
  assert.ok(at(three, 0, 0)[0] > 200 && at(three, 8, 0)[1] > 200 && at(three, 15, 0)[2] > 200);
});

test('inner bevel makes the side facing the light lighter and the opposite side darker', () => {
  const img = square(16, 4, 8);
  const res = applyStyles(img, { bevel: { enabled: true, size: 3 } });
  assert.deepEqual([res.image.width, res.offsetX], [16, 0]);
  const lum = (p) => luminance(p[0], p[1], p[2]);
  const base = luminance(255, 0, 0);
  const left = at(res, 4, 7), right = at(res, 11, 7), top = at(res, 7, 4), bottom = at(res, 7, 11);
  assert.ok(lum(left) > base + 10, `left ${left}`);
  assert.ok(lum(top) > base + 10, `top ${top}`);
  assert.ok(lum(right) < base - 10, `right ${right}`);
  assert.ok(lum(bottom) < base - 10, `bottom ${bottom}`);
  assert.equal(right[1], 0, 'shadow side gets no highlight');
  eachOut(res, (x, y, p) => assert.equal(p[3], getPixel(img, x, y)[3], `alpha ${x},${y}`));
  // direction 'down' swaps the lit side
  const down = applyStyles(img, { bevel: { enabled: true, size: 3, direction: 'down' } });
  assert.ok(lum(at(down, 4, 7)) < base && lum(at(down, 11, 7)) > base);
  // more depth = stronger shading
  const deep = applyStyles(img, { bevel: { enabled: true, size: 3, depth: 300 } });
  assert.ok(lum(at(deep, 11, 7)) <= lum(right));
  // light from the right (angle 0) lights the right side
  const fromRight = applyStyles(img, { bevel: { enabled: true, size: 3, angle: 0 } });
  assert.ok(lum(at(fromRight, 11, 7)) > base && lum(at(fromRight, 4, 7)) < base);
  for (const technique of ['chisel-hard']) {
    const r = applyStyles(img, { bevel: { enabled: true, size: 3, technique, soften: 2 } });
    assert.ok(lum(at(r, 4, 7)) > base && lum(at(r, 11, 7)) < base, technique);
  }
});

test('outer bevel, emboss and pillow emboss shade outside the layer', () => {
  const img = square(16, 4, 8);
  const outer = applyStyles(img, { bevel: { enabled: true, size: 3, style: 'outer-bevel' } });
  assert.deepEqual([outer.image.width, outer.offsetX], [22, -3]);
  for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) assertPixel(at(outer, x, y), RED, 0, 'layer untouched');
  const ul = at(outer, 2, 7), lr = at(outer, 13, 7);
  assert.ok(ul[3] > 0 && ul[0] === 255 && ul[1] === 255 && ul[2] === 255, `highlight outside upper-left ${ul}`);
  assert.ok(lr[3] > 0 && lr[0] === 0 && lr[1] === 0 && lr[2] === 0, `shadow outside lower-right ${lr}`);
  for (const style of ['emboss', 'pillow-emboss']) {
    const r = applyStyles(img, { bevel: { enabled: true, size: 4, style } });
    assert.equal(r.offsetX, -2, style);
    let outside = 0, changedInside = 0;
    eachOut(r, (x, y, p) => {
      if (inSquare(x, y, 4, 8)) { if (p[1] > 0 || p[0] < 255) changedInside++; } else if (p[3] > 0) outside++;
    });
    assert.ok(outside > 0 && changedInside > 0, `${style}: ${outside} outside, ${changedInside} inside`);
  }
  // pillow emboss: the inner slope is lit on the left like an inner bevel, the outer slope the other way
  const pillow = applyStyles(img, { bevel: { enabled: true, size: 4, style: 'pillow-emboss' } });
  assert.ok(at(pillow, 4, 7)[1] > 0);
  const pl = at(pillow, 3, 7);
  assert.ok(pl[3] > 0 && pl[0] === 0, `outside the left edge is in shadow ${pl}`);
});

test('satin changes only pixels inside the layer', () => {
  const img = square(16, 2, 12);
  const res = applyStyles(img, { satin: { enabled: true } });
  assert.equal(res.image.width, 16);
  let changed = 0;
  eachOut(res, (x, y, p) => {
    if (!inSquare(x, y, 2, 12)) return assert.deepEqual(p, [0, 0, 0, 0]);
    assert.equal(p[3], 1);
    if (p[0] < 255) changed++;
  });
  assert.ok(changed > 50);
  const plain = applyStyles(img, { satin: { enabled: true, invert: false } });
  assert.ok(at(plain, 7, 7)[0] !== at(res, 7, 7)[0]);
});

test('pattern overlay tiles the pattern from the layer origin', () => {
  const pattern = createImage(2, 2);
  setPixel(pattern, 0, 0, [0, 0, 0, 1]);
  setPixel(pattern, 1, 0, [255, 255, 255, 1]);
  setPixel(pattern, 0, 1, [255, 255, 255, 1]);
  setPixel(pattern, 1, 1, [0, 0, 0, 1]);
  const img = square();
  const res = applyStyles(img, { patternOverlay: { enabled: true, pattern } });
  for (let y = 4; y < 8; y++) for (let x = 4; x < 8; x++) {
    const v = (x + y) % 2 ? 255 : 0;
    assertPixel(at(res, x, y), [v, v, v, 1], 0, `${x},${y}`);
  }
  assert.equal(alphaAt(res, 3, 3), 0);
  const scaled = applyStyles(img, { patternOverlay: { enabled: true, pattern, scale: 2, opacity: 0.5 } });
  for (let y = 4; y < 8; y++) for (let x = 4; x < 8; x++) assert.equal(at(scaled, x, y)[3], 1);
  // no pattern: nothing to draw
  assert.deepEqual(applyStyles(img, { patternOverlay: { enabled: true } }).image.data, img.data);
});

test('rect option styles part of the image; a small pad clips instead of failing', () => {
  const img = square();
  const styles = { dropShadow: { enabled: true, distance: 2, size: 2 }, stroke: { enabled: true, size: 1 } };
  const full = applyStyles(img, styles);
  const part = applyStyles(img, styles, { rect: { x: 4, y: 4, width: 4, height: 4 } });
  const pad = stylePadding(styles);
  assert.deepEqual([part.image.width, part.image.height, part.offsetX, part.offsetY], [4 + 2 * pad, 4 + 2 * pad, 4 - pad, 4 - pad]);
  eachOut(part, (x, y, p) => assertPixel(p, at(full, x, y), 0, `${x},${y}`));
  const clipped = applyStyles(img, styles, { pad: 0 });
  assert.deepEqual([clipped.image.width, clipped.offsetX], [12, 0]);
  eachOut(clipped, (x, y, p) => assertPixel(p, at(full, x, y), 0, `clipped ${x},${y}`));
});

test('everything at once: deterministic, layer pixels intact under interior-free effects, large sizes', () => {
  // soft-edged disc
  const img = createImage(40, 40);
  for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) {
    const a = Math.min(1, Math.max(0, 12 - Math.hypot(x + 0.5 - 20, y + 0.5 - 20) + 0.5));
    if (a > 0) setPixel(img, x, y, [30, 120, 220, a]);
  }
  const styles = {};
  for (const { key } of STYLE_KEYS) styles[key] = { enabled: true };
  styles.patternOverlay.pattern = createImage(3, 3, [200, 10, 10, 1]);
  styles.patternOverlay.opacity = 0.3;
  styles.gradientOverlay.opacity = 0.4;
  styles.colorOverlay.opacity = 0.2;
  const a = applyStyles(img, styles), b = applyStyles(img, styles);
  assert.deepEqual(a.image.data, b.image.data);
  assert.equal(a.image.width, 40 + 2 * stylePadding(styles));
  assert.ok(a.image.data.some((v, i) => i % 4 === 3 && v > 0 && v < 255));
  // the layer's own pixels are unchanged by below-the-layer effects
  const below = applyStyles(img, { dropShadow: { enabled: true }, outerGlow: { enabled: true } });
  for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) {
    const src = getPixel(img, x, y);
    if (src[3] === 1) assertPixel(at(below, x, y), src, 0);
  }
  // large blur (box approximation): symmetric and decreasing
  const big = applyStyles(square(12, 4, 4), { dropShadow: { enabled: true, distance: 0, size: 30 } });
  assert.equal(big.offsetX, -30);
  for (const d of [1, 5, 10, 20]) assert.equal(alphaAt(big, 3 - d + 1, 5), alphaAt(big, 8 + d - 1, 5), `symmetric at ${d}`);
  assert.ok(alphaAt(big, 2, 5) > alphaAt(big, -8, 5) && alphaAt(big, -8, 5) > alphaAt(big, -20, 5));
  // invalid values fall back instead of throwing
  const odd = applyStyles(square(), { dropShadow: { enabled: true, blend: 'nope', size: 'x', distance: NaN, color: 'bogus' } });
  assert.equal(odd.image.width, 12 + 2 * 10);
});

// ---------------------------------------------------------------------------------------------
// Regression tests (review): results must not depend on the work window, and edge cases.

/** Largest per-channel difference (alpha in 0..255) between two results over source rect [x0, x1) x [y0, y1). */
function maxDiffOver(a, b, x0, y0, x1, y1) {
  let m = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const p = at(a, x, y), q = at(b, x, y);
    for (let c = 0; c < 4; c++) m = Math.max(m, Math.abs((c === 3 ? 255 : 1) * (p[c] - q[c])));
  }
  return m;
}

test('interior effects do not depend on the padding or on other enabled effects', () => {
  const img = square(40, 12, 16);
  const cases = [
    ['satin', {}],
    ['innerShadow', { distance: 8, size: 10 }],
    ['innerGlow', { size: 20 }], // box-blur path
    ['bevel', { size: 10, direction: 'down' }],
    ['bevel', { size: 10, soften: 8 }],
  ];
  for (const [key, fx] of cases) {
    const alone = applyStyles(img, { [key]: { enabled: true, ...fx } });
    const padded = applyStyles(img, { [key]: { enabled: true, ...fx } }, { pad: 30 });
    const withShadow = applyStyles(img, { [key]: { enabled: true, ...fx }, dropShadow: { enabled: true, size: 40 } });
    assert.equal(maxDiffOver(alone, padded, 0, 0, 40, 40), 0, `${key} ${JSON.stringify(fx)} vs pad 30`);
    // the layer is opaque, so its interior hides the shadow: pixels must be identical
    assert.equal(maxDiffOver(alone, withShadow, 12, 12, 28, 28), 0, `${key} ${JSON.stringify(fx)} vs + drop shadow`);
  }
});

test('outer bevel, emboss and pillow emboss: no shading far from the layer, nothing clipped by stylePadding', () => {
  const img = square(40, 12, 16);
  for (const fx of [{ style: 'outer-bevel', direction: 'down' }, { style: 'pillow-emboss' }, { style: 'emboss', direction: 'down' }]) {
    const r = applyStyles(img, { bevel: { enabled: true, size: 6, ...fx } }, { pad: 20 });
    eachOut(r, (x, y, p) => {
      const dist = Math.max(12 - x, x - 27, 12 - y, y - 27);
      if (dist > 8) assert.equal(p[3], 0, `${JSON.stringify(fx)} stray shading at ${x},${y}`);
    });
  }
  // content touching the image edges: whatever lies beyond stylePadding would be cut off hard
  const full = createImage(20, 20, [255, 0, 0, 1]);
  for (const style of ['outer-bevel', 'emboss', 'pillow-emboss']) for (const technique of ['smooth', 'chisel-hard']) for (const [size, soften] of [[1, 0], [6, 0], [6, 4], [15, 0]]) {
    const styles = { bevel: { enabled: true, style, technique, size, soften, depth: 300 } };
    const pad = stylePadding(styles);
    const r = applyStyles(full, styles, { pad: pad + 10 });
    let beyond = 0;
    eachOut(r, (x, y, p) => { if ((x < -pad || y < -pad || x >= 20 + pad || y >= 20 + pad) && p[3] > 0) beyond++; });
    assert.equal(beyond, 0, `${style} ${technique} size ${size} soften ${soften}: ${beyond} pixels beyond pad ${pad}`);
    assert.ok(alphaAt(r, -1, 10) > 0, `${style} shades outside`);
  }
});

test('rect selects an output region that matches the whole-image result, even through the content', () => {
  const img = square(30, 6, 18);
  for (let x = 6; x < 24; x++) setPixel(img, x, 23, [255, 0, 0, 0.5]); // antialiased bottom row
  const pattern = createImage(3, 2, [20, 200, 90, 0.8]);
  const all = {
    dropShadow: { enabled: true, distance: 4, size: 6 }, outerGlow: { enabled: true, size: 4 }, stroke: { enabled: true, size: 2 },
    bevel: { enabled: true, size: 4, style: 'emboss' }, satin: { enabled: true }, innerGlow: { enabled: true, size: 6 },
    innerShadow: { enabled: true, size: 3 }, gradientOverlay: { enabled: true, angle: 30, opacity: 0.5 }, patternOverlay: { enabled: true, pattern, opacity: 0.5 },
  };
  const full = applyStyles(img, all, { fillOpacity: 0.7 });
  for (const rect of [{ x: 0, y: 0, width: 15, height: 30 }, { x: 10, y: 12, width: 4, height: 5 }, { x: 22, y: 20, width: 8, height: 10 }]) {
    for (const pad of [0, 2, stylePadding(all)]) {
      const part = applyStyles(img, all, { fillOpacity: 0.7, rect, pad });
      assert.deepEqual([part.image.width, part.image.height, part.offsetX, part.offsetY], [rect.width + 2 * pad, rect.height + 2 * pad, rect.x - pad, rect.y - pad]);
      eachOut(part, (x, y, p) => assertPixel(p, at(full, x, y), 0, `rect ${JSON.stringify(rect)} pad ${pad} at ${x},${y}`));
    }
  }
  // the cut is not an edge: no stroke appears where the rect slices the layer
  const cut = applyStyles(img, { stroke: { enabled: true, size: 2, color: BLUE } }, { rect: { x: 0, y: 0, width: 15, height: 30 } });
  assertPixel(at(cut, 14, 12), RED, 0);
  assertPixel(at(cut, 16, 12), RED, 0, 'layer pixels beyond the rect still show inside the padding');
  // a rect outside the image selects nothing
  const none = applyStyles(img, all, { rect: { x: 100, y: 100, width: 5, height: 5 } });
  assert.ok(none.image.data.every((v) => v === 0));
});

test('a smaller pad only crops: layer touching the image edge, shadows pointing out of it', () => {
  const img = square(16, 0, 8);
  const styles = { dropShadow: { enabled: true, angle: 180, distance: 4, size: 6 }, innerShadow: { enabled: true, angle: 0, distance: 3, size: 4 }, satin: { enabled: true, size: 6 } };
  const full = applyStyles(img, styles);
  for (const pad of [0, 1, 3]) {
    const clipped = applyStyles(img, styles, { pad });
    eachOut(clipped, (x, y, p) => assertPixel(p, at(full, x, y), 0, `pad ${pad} at ${x},${y}`));
  }
  // the shadow reaches the image's left edge (light from the right): the clipped output keeps it
  assert.ok(alphaAt(applyStyles(img, styles, { pad: 0 }), 9, 2) > 0);
});

test('drop shadow knock-out is continuous in the fill and follows coverage at antialiased edges', () => {
  const img = square(20, 6, 8);
  for (let y = 6; y < 14; y++) setPixel(img, 14, y, [255, 0, 0, 0.5]);
  const ds = { dropShadow: { enabled: true, distance: 0, size: 4 } };
  const one = applyStyles(img, ds);
  let worst = 0;
  eachOut(one, (x, y, p) => {
    const q = at(applyStyles(img, ds, { fillOpacity: 0.99 }), x, y);
    for (let c = 0; c < 4; c++) worst = Math.max(worst, Math.abs((c === 3 ? 255 : 1) * (p[c] - q[c])));
  });
  assert.ok(worst <= 3, `fill 0.99 vs 1 differ by ${worst}`);
  // fill 0: no shadow under the opaque part; under a half-covered pixel exactly the uncovered half shows
  const f0 = applyStyles(img, ds, { fillOpacity: 0 });
  assert.equal(alphaAt(f0, 10, 10), 0);
  const halfCovered = alphaAt(f0, 14, 9) / 255;
  const shadowThere = alphaAt(applyStyles(createImage(20, 20), ds, { pad: 7 }), 14, 9); // sanity: empty layer, no shadow
  assert.equal(shadowThere, 0);
  assert.ok(halfCovered > 0.1 && halfCovered < 0.3, `edge ${halfCovered}`);
  // fill 0 with an opaque colour overlay looks exactly like fill 1 with it
  const ov = { ...ds, colorOverlay: { enabled: true, color: '#ff0000' } };
  assert.deepEqual(applyStyles(img, ov, { fillOpacity: 0 }).image.data, applyStyles(img, ov).image.data);
});

test('shadow offsets are mirror images for opposite angles', () => {
  const img = square(20, 8, 4);
  for (const [a, d] of [[120, 5], [45, 3], [30, 7], [0, 2.5]]) {
    const p = applyStyles(img, { dropShadow: { enabled: true, angle: a, distance: d, size: 0 } });
    const q = applyStyles(img, { dropShadow: { enabled: true, angle: a + 180, distance: d, size: 0 } });
    // the square spans [8, 12): x -> 19 - x mirrors it onto itself
    for (let y = -6; y < 26; y++) for (let x = -6; x < 26; x++) assert.equal(alphaAt(p, x, y), alphaAt(q, 19 - x, 19 - y), `angle ${a} distance ${d} at ${x},${y}`);
  }
});

test('spread / choke of 0+ is continuous with 0 on antialiased edges', () => {
  const disc = createImage(30, 30);
  for (let y = 0; y < 30; y++) for (let x = 0; x < 30; x++) {
    const a = Math.min(1, Math.max(0, 9 - Math.hypot(x + 0.5 - 15, y + 0.5 - 15) + 0.5));
    if (a > 0) setPixel(disc, x, y, [30, 120, 220, a]);
  }
  for (const [key, field] of [['innerShadow', 'spread'], ['innerGlow', 'choke'], ['dropShadow', 'spread'], ['outerGlow', 'spread']]) {
    const a = applyStyles(disc, { [key]: { enabled: true, size: 3, [field]: 0 } }, { pad: 10 });
    const b = applyStyles(disc, { [key]: { enabled: true, size: 3, [field]: 0.001 } }, { pad: 10 });
    assert.ok(maxDiffOver(a, b, -10, -10, 40, 40) <= 1, key);
  }
});

test('satin: inverted darkens the far interior by exactly its opacity, plain leaves it, symmetric', () => {
  const big = square(80, 10, 60);
  assertPixel(at(applyStyles(big, { satin: { enabled: true } }), 40, 40), [128, 0, 0, 1], 1, 'multiply black at 50%');
  assertPixel(at(applyStyles(big, { satin: { enabled: true, invert: false } }), 40, 40), RED, 0);
  const s0 = applyStyles(big, { satin: { enabled: true, angle: 0 } });
  for (let y = 10; y < 70; y += 3) for (let x = 10; x < 70; x++) assert.equal(at(s0, x, y)[0], at(s0, 79 - x, y)[0], `${x},${y}`);
  const near = at(s0, 12, 40)[0], far = at(s0, 40, 40)[0];
  assert.ok(near > far, `edges lighter than the middle when inverted: ${near} vs ${far}`);
});

test('pattern overlay scale stretches the tile', () => {
  const pattern = createImage(2, 1);
  setPixel(pattern, 0, 0, [0, 0, 0, 1]);
  setPixel(pattern, 1, 0, [255, 255, 255, 1]);
  const img = square(24, 0, 24);
  const r = applyStyles(img, { patternOverlay: { enabled: true, pattern, scale: 2 } });
  const row = Array.from({ length: 24 }, (_, x) => at(r, x, 5)[0]);
  for (let x = 0; x + 4 < 24; x++) assert.equal(row[x], row[x + 4], `period 4 at ${x}`);
  assert.ok(Math.abs(row[0] - row[2]) > 100, `half a period apart differ: ${row.slice(0, 4)}`);
});

test('random styles: deterministic, rect and pad only crop, nothing beyond stylePadding', () => {
  const rnd = randomSeeded(7);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const px = (res, x, y) => {
    const X = x - res.offsetX, Y = y - res.offsetY;
    if (X < 0 || Y < 0 || X >= res.image.width || Y >= res.image.height) return null;
    const i = (Y * res.image.width + X) * 4;
    return res.image.data.subarray(i, i + 4);
  };
  for (let iter = 0; iter < 60; iter++) {
    const w = 1 + Math.floor(rnd() * 12), h = 1 + Math.floor(rnd() * 12);
    const img = createImage(w, h);
    for (let i = 0; i < w * h; i++) {
      if (rnd() < 0.5) img.data.set([Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256), rnd() < 0.5 ? 255 : Math.floor(rnd() * 256)], i * 4);
    }
    const styles = {};
    for (const { key } of STYLE_KEYS) {
      if (rnd() < 0.35) {
        styles[key] = {
          enabled: true, size: Math.floor(rnd() * 12), distance: Math.floor(rnd() * 8) - 2, spread: rnd() < 0.3 ? 2 : 0, choke: rnd() < 0.3 ? 1.5 : 0,
          angle: Math.floor(rnd() * 360), soften: rnd() < 0.3 ? 3 : 0, style: pick(['inner-bevel', 'outer-bevel', 'emboss', 'pillow-emboss']),
          direction: pick(['up', 'down']), position: pick(['outside', 'inside', 'center']), blend: pick(['normal', 'multiply', 'screen', 'overlay', 'color', 'dissolve']),
          kind: pick(['linear', 'radial', 'angle', 'reflected', 'diamond']), invert: rnd() < 0.5, source: pick(['edge', 'center']),
          technique: pick(['smooth', 'chisel-hard']), scale: pick([1, 1.5, 0.5]),
        };
      }
    }
    if (styles.patternOverlay) styles.patternOverlay.pattern = createImage(3, 2, [200, 30, 90, 0.7]);
    const fillOpacity = pick([1, 1, 0.5, 0]);
    const label = `iter ${iter} ${w}x${h} ${Object.keys(styles)} fill ${fillOpacity}`;
    const full = applyStyles(img, styles, { fillOpacity });
    assert.deepEqual(applyStyles(img, styles, { fillOpacity }).image.data, full.image.data, `${label}: deterministic`);
    const big = applyStyles(img, styles, { fillOpacity, pad: stylePadding(styles) + 7 });
    const rx = Math.floor(rnd() * w), ry = Math.floor(rnd() * h);
    const rect = { x: rx, y: ry, width: 1 + Math.floor(rnd() * (w - rx)), height: 1 + Math.floor(rnd() * (h - ry)) };
    const part = applyStyles(img, styles, { fillOpacity, rect, pad: Math.floor(rnd() * 4) });
    for (const other of [big, part]) {
      for (let Y = 0; Y < other.image.height; Y++) for (let X = 0; X < other.image.width; X++) {
        const x = X + other.offsetX, y = Y + other.offsetY;
        const p = px(other, x, y), q = px(full, x, y);
        if (!q) {
          assert.ok(other === part || p[3] <= 1, `${label}: alpha ${p[3]} beyond stylePadding at ${x},${y}`);
          continue;
        }
        assert.deepEqual([...p], [...q], `${label}: ${other === big ? 'big pad' : `rect ${JSON.stringify(rect)}`} differs at ${x},${y}`);
      }
    }
  }
});

test('dissolve effects: fully opaque speckles at the effect alpha, stable whatever the pad or rect', () => {
  const img = square(30, 10, 10);
  const styles = { dropShadow: { enabled: true, blend: 'dissolve', distance: 0, size: 8, opacity: 1 }, innerGlow: { enabled: true, blend: 'dissolve', size: 4 } };
  const full = applyStyles(img, styles);
  let partial = 0, kept = 0, smooth = 0;
  const ref = applyStyles(img, { dropShadow: { ...styles.dropShadow, blend: 'normal' } });
  eachOut(full, (x, y, p) => {
    if (inSquare(x, y, 10, 10)) return;
    if (p[3] > 0 && p[3] < 1) partial++;
    if (p[3] === 1) kept++;
    smooth += at(ref, x, y)[3];
  });
  assert.equal(partial, 0, 'dissolve pixels are all-or-nothing');
  assert.ok(Math.abs(kept - smooth) < smooth * 0.15, `kept ${kept} vs expected ${smooth.toFixed(1)}`);
  for (const opts of [{ pad: 3 }, { pad: 20 }, { rect: { x: 5, y: 12, width: 10, height: 9 } }]) {
    const other = applyStyles(img, styles, opts);
    eachOut(other, (x, y, p) => {
      const X = x - full.offsetX, Y = y - full.offsetY;
      if (X < 0 || Y < 0 || X >= full.image.width || Y >= full.image.height) return; // beyond stylePadding
      assertPixel(p, getPixel(full.image, X, Y), 0, `${JSON.stringify(opts)} at ${x},${y}`);
    });
  }
});
