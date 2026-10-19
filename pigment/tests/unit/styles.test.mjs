import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_STYLES, STYLE_KEYS, mergeStyles, stylePadding, applyStyles, hasEnabledStyles } from '../../src/shared/pixels/styles.js';
import { createImage, setPixel, getPixel, luminance } from '../../src/shared/pixels/core.js';
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
