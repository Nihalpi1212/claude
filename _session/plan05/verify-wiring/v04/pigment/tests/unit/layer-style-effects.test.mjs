// layer-style-effects (Pigment 0.4, ARCHITECTURE.md "0.4 features", J.6): contours, the new effect fields, effect
// instances, the applyStyles options interiorAsGroup / transparencyShapes / split and exact splitEffects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  applyStyles, splitEffects, stylePadding, scaleEffects, mergeStyles, STYLE_FEATURES, EFFECT_FIELD_DEFAULTS, effectDefaults,
} from '../../src/shared/pixels/styles.js';
import {
  LINEAR_CONTOUR, CONTOUR_PRESETS, normalizeContour, isLinearContour, contourLut, contourValue, lookupContour, rangeInput,
} from '../../src/shared/pixels/contour.js';
import { createImage, setPixel, getPixel } from '../../src/shared/pixels/core.js';
import { blendImages } from '../../src/shared/pixels/blend.js';

/** 40 x 32: an antialiased disc with a square beside it, coloured by position (as the 0.3 golden images). */
function shape() {
  const img = createImage(40, 32);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 40; x++) {
    const d = Math.hypot(x + 0.5 - 18, y + 0.5 - 15);
    const a = Math.max(0, Math.min(1, 9 - d + 0.5));
    const sq = x >= 24 && x < 34 && y >= 6 && y < 26 ? 1 : 0;
    const al = Math.max(a, sq);
    if (al) img.data.set([180, 60 + x * 3, 30 + y * 4, Math.round(al * 255)], (y * 40 + x) * 4);
  }
  return img;
}

function square(size = 24, x0 = 8, side = 8, rgba = [255, 0, 0, 1]) {
  const img = createImage(size, size);
  for (let y = x0; y < x0 + side; y++) for (let x = x0; x < x0 + side; x++) setPixel(img, x, y, rgba);
  return img;
}

function pattern() {
  const pat = createImage(6, 4);
  for (let i = 0; i < pat.data.length; i++) pat.data[i] = (i * 53 + 11) % 256;
  for (let i = 3; i < pat.data.length; i += 4) pat.data[i] = 255;
  return pat;
}

const at = (res, x, y) => getPixel(res.image, x - res.offsetX, y - res.offsetY);
const A = (res, x, y) => Math.round(at(res, x, y)[3] * 255);
const same = (a, b) => a.offsetX === b.offsetX && a.offsetY === b.offsetY && a.image.width === b.image.width && Buffer.compare(Buffer.from(a.image.data), Buffer.from(b.image.data)) === 0;
const hash = (r) => createHash('sha256').update(Buffer.from(r.image.data)).update(`${r.offsetX},${r.offsetY},${r.image.width}`).digest('hex').slice(0, 16);
const differs = (a, b) => !same(a, b);

// ---- contours ------------------------------------------------------------------------------------------------------

test('contour LUTs: Linear is the identity, curves pass through their points, corners bend sharply', () => {
  const lin = contourLut(LINEAR_CONTOUR, { size: 256 });
  for (let i = 0; i < 256; i++) assert.ok(Math.abs(lin[i] - i / 255) < 1e-6);
  assert.equal(contourLut(null), contourLut(LINEAR_CONTOUR), 'null reads as Linear (cached table)');
  assert.ok(isLinearContour(null) && isLinearContour(LINEAR_CONTOUR) && isLinearContour({ points: [{ x: 0, y: 0 }, { x: 0.3, y: 0.3 }, { x: 1, y: 1 }] }));
  assert.ok(!isLinearContour({ points: [{ x: 0, y: 0 }, { x: 1, y: 0.5 }] }));
  // every built-in passes through its own points, ids are unique and Linear is first
  assert.equal(CONTOUR_PRESETS[0].id, 'linear');
  assert.equal(new Set(CONTOUR_PRESETS.map((c) => c.id)).size, CONTOUR_PRESETS.length);
  for (const c of CONTOUR_PRESETS) {
    assert.deepEqual(normalizeContour(c).points, c.points.map((p) => ({ ...p })), c.id);
    for (const p of c.points) assert.ok(Math.abs(contourValue(c, p.x) - p.y) < 1e-6, `${c.id} at ${p.x}`);
  }
  // Cone: a corner at the peak (straight lines either side); Ring: the same points smooth, rounder near the top
  const cone = CONTOUR_PRESETS.find((c) => c.id === 'cone'), ring = CONTOUR_PRESETS.find((c) => c.id === 'ring');
  assert.ok(Math.abs(contourValue(cone, 0.25) - 0.5) < 1e-6);
  assert.ok(contourValue(ring, 0.25) > 0.6);
  // a natural spline through three points: symmetric
  assert.ok(Math.abs(contourValue(ring, 0.3) - contourValue(ring, 0.7)) < 1e-6);
  // values stay in 0..1 even where the spline overshoots
  for (const c of CONTOUR_PRESETS) for (const v of contourLut(c)) assert.ok(v >= 0 && v <= 1);
});

test('normalizeContour sorts, clamps, merges close points and pins the ends; rangeInput', () => {
  const c = normalizeContour({ name: 'X', points: [{ x: 0.9, y: 2 }, { x: 0.1, y: -1, corner: 1 }, { x: 0.5, y: 0.5 }, { x: 0.5004, y: 0.6 }] });
  assert.deepEqual(c, { name: 'X', points: [{ x: 0, y: 0, corner: true }, { x: 0.5004, y: 0.6, corner: false }, { x: 1, y: 1, corner: false }] });
  assert.equal(normalizeContour({ points: [{ x: 0, y: 0 }] }), null);
  assert.equal(normalizeContour('nope'), null);
  assert.equal(rangeInput(0.4, 0.5), 0.4);
  assert.equal(rangeInput(0.4, 0.25), 0.8);
  assert.equal(rangeInput(0.8, 0.25), 1);
  assert.equal(rangeInput(0.4, 1), 0.2);
});

test('anti-aliasing smooths a contour with hard steps and reads it with interpolation', () => {
  const saw = CONTOUR_PRESETS.find((c) => c.id === 'sawtooth-1');
  const hard = contourLut(saw), soft = contourLut(saw, { antiAlias: true });
  assert.notDeepEqual(Array.from(hard), Array.from(soft));
  // the drop at 0.5 is spread over a few entries
  const steepest = (lut) => Math.max(...Array.from(lut).slice(1).map((v, i) => Math.abs(v - lut[i])));
  assert.ok(steepest(soft) < steepest(hard) * 0.6);
  // nearest without anti-aliasing, linear interpolation with it
  const lut = new Float32Array([0, 1]);
  assert.equal(lookupContour(lut, 0.4, false), 0);
  assert.ok(Math.abs(lookupContour(lut, 0.4, true) - 0.4) < 1e-6);
});

// ---- 0.3 output kept -------------------------------------------------------------------------------------------------

// sha256 prefixes of 0.3's (the skeleton's) applyStyles output for these styles at fill 0.6, computed before this
// package changed styles.js
const GOLDEN = {
  shadows: ['4a8b637690f3a853', { dropShadow: { enabled: true, size: 6, distance: 4, spread: 1 }, innerShadow: { enabled: true, size: 4, distance: 3, color: '#0000ff', blend: 'normal' } }],
  glows: ['a5c70c8c9f5e7eda', { outerGlow: { enabled: true, size: 8, spread: 2 }, innerGlow: { enabled: true, size: 5, choke: 1, source: 'center' } }],
  bevel: ['b665012d8af57b5f', { bevel: { enabled: true, style: 'emboss', size: 6, soften: 1, depth: 200 } }],
  satinOverlays: ['43aa7f44700aa47e', { satin: { enabled: true }, colorOverlay: { enabled: true, color: '#00ff00', blend: 'multiply', opacity: 0.5 }, gradientOverlay: { enabled: true, kind: 'radial', scale: 0.7 } }],
  pattern: ['fb3d4ac9f327f741', { patternOverlay: { enabled: true, pattern: null, scale: 1.5, blend: 'overlay' } }],
  strokes: ['803416e80e99cc2e', { stroke: { enabled: true, size: 3, position: 'center', color: '#ff00ff' }, dropShadow: { enabled: true, distance: 6, size: 2, blend: 'normal' } }],
};

test('an effect with every new field at its default gives 0.3\'s pixels exactly', () => {
  for (const [name, [digest, st]] of Object.entries(GOLDEN)) {
    const styles = JSON.parse(JSON.stringify(st));
    if (styles.patternOverlay) styles.patternOverlay.pattern = pattern();
    const plain = applyStyles(shape(), styles, { fillOpacity: 0.6 });
    assert.equal(hash(plain), digest, `${name}: 0.3 output`);
    // the same styles with every 0.4 field written out at its default
    const full = {};
    for (const [key, fx] of Object.entries(styles)) full[key] = { ...JSON.parse(JSON.stringify(EFFECT_FIELD_DEFAULTS[key])), ...fx };
    if (full.patternOverlay) full.patternOverlay.pattern = styles.patternOverlay.pattern;
    assert.ok(same(applyStyles(shape(), full, { fillOpacity: 0.6 }), plain), `${name}: explicit defaults`);
  }
  // effectDefaults: 0.3's table plus the new fields
  assert.equal(effectDefaults('outerGlow').technique, 'softer');
  assert.equal(effectDefaults('outerGlow').size, 5);
  assert.deepEqual(effectDefaults('bevel').texture.origin, [0, 0]);
});

test('STYLE_FEATURES: instances and the three options are real', () => {
  assert.deepEqual({ ...STYLE_FEATURES }, { instances: true, interiorAsGroup: true, transparencyShapes: true, split: true });
});

// ---- new fields --------------------------------------------------------------------------------------------------------

const shadow = { enabled: true, size: 6, distance: 0, opacity: 1, blend: 'normal', color: '#000000' };

test('shadow contour maps the opacity profile through the curve', () => {
  const img = square(40, 14, 12);
  const lin = applyStyles(img, { dropShadow: shadow });
  const cove = CONTOUR_PRESETS.find((c) => c.id === 'cove-deep');
  const cv = applyStyles(img, { dropShadow: { ...shadow, contour: cove } });
  const lut = contourLut(cove);
  let checked = 0;
  for (let x = 26; x < 34; x++) {
    const v = A(lin, x, 20) / 255;
    if (v < 0.02) continue;
    const want = Math.round(lookupContour(lut, v, false) * 255);
    assert.ok(Math.abs(A(cv, x, 20) - want) <= 2, `x ${x}: ${A(cv, x, 20)} vs ${want}`);
    checked++;
  }
  assert.ok(checked >= 3);
  // far from the layer the shadow is still empty (a contour never fills the window)
  const inv = applyStyles(img, { dropShadow: { ...shadow, contour: CONTOUR_PRESETS.find((c) => c.id === 'cone-inverted') } });
  assert.equal(A(inv, 0, 0), 0);
  // Linear written out is 0.3's shadow
  assert.ok(same(applyStyles(img, { dropShadow: { ...shadow, contour: LINEAR_CONTOUR, antiAlias: true } }), lin));
  // anti-aliasing changes a stepped contour's shadow
  const steps = CONTOUR_PRESETS.find((c) => c.id === 'rounded-steps');
  assert.ok(differs(applyStyles(img, { dropShadow: { ...shadow, contour: steps } }), applyStyles(img, { dropShadow: { ...shadow, contour: steps, antiAlias: true } })));
});

test('noise grains the shadow, keeps its average and does not depend on pad or rect', () => {
  const img = square(40, 14, 12);
  const plain = applyStyles(img, { dropShadow: shadow });
  const noisy = applyStyles(img, { dropShadow: { ...shadow, noise: 0.5 } });
  assert.ok(differs(plain, noisy));
  let s0 = 0, s1 = 0, changed = 0;
  for (let i = 3; i < plain.image.data.length; i += 4) {
    s0 += plain.image.data[i];
    s1 += noisy.image.data[i];
    if (plain.image.data[i] !== noisy.image.data[i]) changed++;
  }
  assert.ok(Math.abs(s1 - s0) / s0 < 0.03, `${s0} ${s1}`);
  assert.ok(changed > 100);
  // deterministic and window-independent
  const cropped = applyStyles(img, { dropShadow: { ...shadow, noise: 0.5 } }, { rect: { x: 10, y: 10, width: 8, height: 8 }, pad: 3 });
  for (let y = 7; y < 21; y++) for (let x = 7; x < 21; x++) assert.deepEqual(at(cropped, x, y), at(noisy, x, y));
});

test('Layer Knocks Out Drop Shadow off shows the shadow under a see-through fill', () => {
  const img = square(40, 14, 12);
  const st = { dropShadow: { ...shadow, distance: 2 } };
  const on = applyStyles(img, st, { fillOpacity: 0.3 });
  const off = applyStyles(img, { dropShadow: { ...st.dropShadow, knocksOut: false } }, { fillOpacity: 0.3 });
  // inside the layer the shadow shows through the 30 % fill only when it is not knocked out
  const inOn = at(on, 20, 20), inOff = at(off, 20, 20);
  assert.ok(inOff[3] > inOn[3] + 0.3, `${inOn} ${inOff}`);
  // outside, the same shadow
  assert.deepEqual(at(on, 28, 28), at(off, 28, 28));
});

test('glows: Precise is a distance ramp, Range rescales the contour input, gradient fill with jitter', () => {
  const img = square(48, 18, 12);
  const g = { enabled: true, size: 8, spread: 0, opacity: 1, blend: 'normal', color: '#ff0000' };
  const precise = applyStyles(img, { outerGlow: { ...g, technique: 'precise' } });
  // pixel centres 1..8 px from the edge: 1 - (d - 1) / 8
  for (let d = 1; d <= 9; d++) assert.ok(Math.abs(A(precise, 29 + d, 24) - Math.round(Math.max(0, 1 - (d - 1) / 8) * 255)) <= 1, `d ${d}`);
  // the corner stays sharp: at the diagonal the distance is Euclidean
  assert.ok(Math.abs(A(precise, 33, 33) - Math.round((1 - (Math.hypot(4, 4) - 1) / 8) * 255)) <= 2);
  const softer = applyStyles(img, { outerGlow: g });
  assert.ok(differs(precise, softer));
  // Range 25 % with Linear: the profile doubled (clamped)
  const ranged = applyStyles(img, { outerGlow: { ...g, range: 0.25 } });
  for (const x of [31, 33, 35]) assert.ok(Math.abs(A(ranged, x, 24) - Math.min(255, 2 * A(softer, x, 24))) <= 2, `x ${x}`);
  // gradient fill: the gradient's left colour at the edge, its right colour further out
  const grad = { gradientVersion: 2, type: 'solid', interpolation: 'classic', smoothness: 0, stops: [{ pos: 0, mid: 0.5, color: '#00ff00' }, { pos: 1, mid: 0.5, color: '#0000ff' }], opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 1 }] };
  const gf = applyStyles(img, { outerGlow: { ...g, technique: 'precise', fill: 'gradient', gradient: grad } });
  const near = at(gf, 30, 24), far = at(gf, 36, 24);
  assert.ok(near[1] > 200 && near[2] < 60, `near ${near}`);
  assert.ok(far[2] > far[1], `far ${far}`);
  const jit = applyStyles(img, { outerGlow: { ...g, technique: 'precise', fill: 'gradient', gradient: grad, jitter: 0.5 } });
  assert.ok(differs(jit, gf));
  // jitter without a gradient fill changes nothing
  assert.ok(same(applyStyles(img, { outerGlow: { ...g, jitter: 0.5 } }), softer));
  // the default gradient (the glow colour to transparent) without a stored gradient
  const def = applyStyles(img, { outerGlow: { ...g, fill: 'gradient' } });
  assert.deepEqual(at(def, 31, 24).slice(0, 3), [255, 0, 0]);
  // inner glow, Precise, Edge source: the first pixel inside is full, the ramp goes inwards
  const ig = applyStyles(img, { innerGlow: { enabled: true, size: 4, choke: 0, opacity: 1, blend: 'normal', color: '#0000ff', technique: 'precise' } });
  assert.deepEqual(at(ig, 18, 24), [0, 0, 255, 1]);
  assert.ok(at(ig, 20, 24)[2] < at(ig, 19, 24)[2]);
  assert.ok(stylePadding({ outerGlow: { ...g, technique: 'precise' } }) === 8);
});

test('bevel: Contour and Gloss Contour reshape the shading, Texture adds bumps inside, chisel soft', () => {
  const img = square(48, 12, 24, [128, 128, 128, 1]);
  const bv = { enabled: true, size: 6, depth: 100 };
  const base = applyStyles(img, { bevel: bv });
  const ring = CONTOUR_PRESETS.find((c) => c.id === 'ring');
  const contoured = applyStyles(img, { bevel: { ...bv, contourSub: { enabled: true, contour: ring, range: 0.5 } } });
  assert.ok(differs(base, contoured));
  // the sub-effect switched off is ignored
  assert.ok(same(applyStyles(img, { bevel: { ...bv, contourSub: { enabled: false, contour: ring } } }), base));
  const glossy = applyStyles(img, { bevel: { ...bv, glossContour: ring } });
  assert.ok(differs(base, glossy));
  // flat interior stays as it was under a gloss contour
  assert.deepEqual(at(glossy, 24, 24), at(base, 24, 24));
  // Texture: a striped pattern gives highlights and shadows in the flat middle
  const stripes = createImage(4, 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) setPixel(stripes, x, y, x < 2 ? [255, 255, 255, 1] : [0, 0, 0, 1]);
  const tex = { enabled: true, pattern: stripes, scale: 1, depth: 1 };
  const textured = applyStyles(img, { bevel: { ...bv, texture: tex } });
  const mid = [];
  for (let x = 20; x < 28; x++) mid.push(at(textured, x, 24)[0]);
  assert.ok(Math.max(...mid) > 140 && Math.min(...mid) < 116, `${mid}`);
  assert.deepEqual(at(base, 22, 24), [128, 128, 128, 1]);
  // depth 0 and a disabled texture are no texture; invert swaps lit and shaded stripes
  assert.ok(same(applyStyles(img, { bevel: { ...bv, texture: { ...tex, depth: 0 } } }), base));
  assert.ok(same(applyStyles(img, { bevel: { ...bv, texture: { ...tex, enabled: false } } }), base));
  const inverted = applyStyles(img, { bevel: { ...bv, texture: { ...tex, invert: true } } });
  const brighter = (r, x) => at(r, x, 24)[0] > 128;
  const flips = mid.map((_, i) => brighter(textured, 20 + i) !== brighter(inverted, 20 + i) || at(textured, 20 + i, 24)[0] === 128);
  assert.ok(flips.every(Boolean));
  // chisel soft is its own technique
  const soft = applyStyles(img, { bevel: { ...bv, technique: 'chisel-soft' } });
  assert.ok(differs(soft, base) && differs(soft, applyStyles(img, { bevel: { ...bv, technique: 'chisel-hard' } })));
});

test('satin contour reshapes the satin', () => {
  const img = shape();
  const st = { enabled: true, opacity: 1, blend: 'normal' };
  const a = applyStyles(img, { satin: st });
  const b = applyStyles(img, { satin: { ...st, contour: CONTOUR_PRESETS.find((c) => c.id === 'gaussian') } });
  assert.ok(differs(a, b));
});

const BW = { gradientVersion: 2, type: 'solid', interpolation: 'classic', smoothness: 0, stops: [{ pos: 0, mid: 0.5, color: '#000000' }, { pos: 1, mid: 0.5, color: '#ffffff' }], opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 1 }] };

test('gradient overlay: offset moves the gradient, Align with Layer off spans the document, dither', () => {
  const img = createImage(40, 10);
  for (let y = 0; y < 10; y++) for (let x = 10; x < 30; x++) setPixel(img, x, y, [255, 0, 0, 1]);
  const go = { enabled: true, gradient: BW, angle: 0, kind: 'linear' };
  const base = applyStyles(img, { gradientOverlay: go });
  const moved = applyStyles(img, { gradientOverlay: { ...go, offset: [25, 0] } });
  // 25 % of the 20 px box: the value at x + 5 is the old value at x
  for (let x = 12; x < 22; x++) assert.deepEqual(at(moved, x + 5, 5), at(base, x, 5));
  // Align with Layer off: the gradient spans the document (here 100 px wide, the image at x 30)
  const docGrad = applyStyles(img, { gradientOverlay: { ...go, align: false } }, { origin: [30, 0], docWidth: 100, docHeight: 10 });
  // document x of image x 20 is 50, the middle of the document gradient; aligned, the box is the 20 px layer
  const lin = (px, len) => Math.round((0.5 + px / len) * 255);
  assert.ok(Math.abs(at(docGrad, 20, 5)[0] - lin(0.5, 100)) <= 2, `${at(docGrad, 20, 5)}`);
  assert.ok(Math.abs(at(base, 20, 5)[0] - lin(0.5, 20)) <= 2);
  assert.ok(Math.abs(at(docGrad, 10, 5)[0] - lin(-9.5, 100)) <= 2, `${at(docGrad, 10, 5)}`);
  // the styles' _place (from lib/style-prepare.js) does the same
  assert.ok(same(applyStyles(img, { gradientOverlay: { ...go, align: false }, _place: { x: 30, y: 0, width: 100, height: 10 } }), docGrad));
  // dither: some pixels move by at most a couple of levels
  const dith = applyStyles(img, { gradientOverlay: { ...go, dither: true } });
  let moved1 = 0;
  for (let i = 0; i < dith.image.data.length; i += 4) {
    const d = Math.abs(dith.image.data[i] - base.image.data[i]);
    assert.ok(d <= 2);
    if (d) moved1++;
  }
  assert.ok(moved1 > 10);
});

test('pattern overlay: angle rotates, Snap to Origin offsets, Link with Layer off anchors to the document', () => {
  const pat = pattern();
  const img = createImage(30, 30);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
  const po = { enabled: true, pattern: pat };
  const base = applyStyles(img, { patternOverlay: po });
  const off = applyStyles(img, { patternOverlay: { ...po, origin: [2, 1] } });
  for (let y = 1; y < 25; y++) for (let x = 2; x < 25; x++) assert.deepEqual(at(off, x, y), at(base, x - 2, y - 1));
  // the document anchor: the image lies at (3, 0), so the tiles shift by -3 px
  const doc = applyStyles(img, { patternOverlay: { ...po, link: false } }, { origin: [3, 0] });
  for (let x = 0; x < 20; x++) assert.deepEqual(at(doc, x, 4), at(base, x + 3, 4));
  // link true ignores the image's position
  assert.ok(same(applyStyles(img, { patternOverlay: { ...po, link: true } }, { origin: [3, 0] }), base));
  // 90 degrees counter-clockwise: the pattern's x axis points up
  const rot = applyStyles(img, { patternOverlay: { ...po, angle: 90 } });
  assert.ok(differs(rot, base));
  // a pattern column read along y: pattern pixel (u, v) lands at (v, -u) (mod the tile)
  const P = (u, v) => getPixel(pat, ((u % 6) + 6) % 6, ((v % 4) + 4) % 4);
  for (let y = 5; y < 15; y++) {
    const got = at(rot, 2, y);
    const want = P(-y - 1, 2);
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(got[c] - want[c]) <= 2, `y ${y}: ${got} vs ${want}`);
  }
});

test('stroke: gradient fill (Shape Burst across the band) and pattern fill', () => {
  const img = square(40, 12, 16);
  const grad = { gradientVersion: 2, type: 'solid', interpolation: 'classic', smoothness: 0, stops: [{ pos: 0, mid: 0.5, color: '#ff0000' }, { pos: 1, mid: 0.5, color: '#0000ff' }], opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 1 }] };
  const st = { enabled: true, size: 6, position: 'outside', opacity: 1, blend: 'normal', fill: 'gradient', gradient: grad, kind: 'shape-burst' };
  const r = applyStyles(img, { stroke: st });
  const inner = at(r, 28, 20), outer = at(r, 33, 20);
  assert.ok(inner[0] > 180 && inner[2] < 80, `inner ${inner}`);
  assert.ok(outer[2] > 180 && outer[0] < 80, `outer ${outer}`);
  // the coverage is the colour stroke's
  const col = applyStyles(img, { stroke: { ...st, fill: 'color', color: '#00ff00' } });
  for (let x = 26; x < 36; x++) assert.equal(A(r, x, 20), A(col, x, 20));
  // a linear gradient across the layer box
  const lin = applyStyles(img, { stroke: { ...st, kind: 'linear', angle: 0, position: 'inside' } });
  assert.ok(at(lin, 12, 20)[0] > at(lin, 27, 20)[0]);
  // pattern fill
  const pat = applyStyles(img, { stroke: { ...st, fill: 'pattern', pattern: pattern(), position: 'center' } });
  const colours = new Set();
  for (let x = 6; x < 15; x++) colours.add(at(pat, x, 20).slice(0, 3).join());
  assert.ok(colours.size > 2);
  // a pattern fill without pixels draws nothing but the colour stroke's coverage stays empty of colour
  assert.ok(stylePadding({ stroke: st }) === 6);
});

// ---- instances ---------------------------------------------------------------------------------------------------------

test('two drop shadows: both are drawn, the bottom of the list first', () => {
  const img = square(48, 18, 8);
  const a = { ...shadow, size: 0, distance: 6, angle: 90, color: '#ff0000' };
  const b = { ...shadow, size: 0, distance: 6, angle: 135, color: '#0000ff' };
  const two = applyStyles(img, { dropShadow: [a, b] });
  // a falls 6 px down (light from above), b 4 px down and right
  assert.deepEqual(at(two, 19, 30), [255, 0, 0, 1]);
  assert.deepEqual(at(two, 28, 23), [0, 0, 255, 1]);
  // where they overlap outside the layer the top instance (a, index 0) wins
  assert.deepEqual(at(two, 23, 28), [255, 0, 0, 1]);
  const swapped = applyStyles(img, { dropShadow: [b, a] });
  assert.deepEqual(at(swapped, 23, 28), [0, 0, 255, 1]);
  // a disabled instance is skipped; padding covers every instance
  assert.ok(same(applyStyles(img, { dropShadow: [a, { ...b, enabled: false }] }), applyStyles(img, { dropShadow: a })));
  assert.equal(stylePadding({ dropShadow: [{ ...a, distance: 2 }, { ...b, distance: 9 }] }), 9);
  // strokes: an inner and an outer stroke together
  const strokes = applyStyles(img, { stroke: [{ enabled: true, size: 2, position: 'inside', color: '#00ff00' }, { enabled: true, size: 2, position: 'outside', color: '#0000ff' }] });
  assert.deepEqual(at(strokes, 18, 20), [0, 255, 0, 1]);
  assert.deepEqual(at(strokes, 17, 20), [0, 0, 255, 1]);
});

// ---- applyStyles options ------------------------------------------------------------------------------------------------

test('interiorAsGroup fades the overlays with the fill; transparencyShapes off covers the layer box', () => {
  const img = square();
  const co = { colorOverlay: { enabled: true, color: '#00ff00' } };
  const plain = applyStyles(img, co, { fillOpacity: 0.5 });
  assert.deepEqual(at(plain, 10, 10), [0, 255, 0, 1]);
  const grouped = applyStyles(img, co, { fillOpacity: 0.5, interiorAsGroup: true });
  assert.ok(Math.abs(A(grouped, 10, 10) - 128) <= 1);
  assert.deepEqual(at(grouped, 10, 10).slice(0, 3), [0, 255, 0]);
  // at full fill the option changes nothing
  assert.ok(same(applyStyles(img, co, { interiorAsGroup: true }), applyStyles(img, co)));
  // an inner shadow is not part of the group
  const sh = { innerShadow: { enabled: true, size: 0, distance: 2, angle: 90, opacity: 1, blend: 'normal' } };
  assert.ok(same(applyStyles(img, sh, { fillOpacity: 0.5, interiorAsGroup: true }), applyStyles(img, sh, { fillOpacity: 0.5 })));
  // a ring: transparent in its middle
  const ring = square(24, 6, 12);
  for (let y = 10; y < 14; y++) for (let x = 10; x < 14; x++) setPixel(ring, x, y, [0, 0, 0, 0]);
  const shaped = applyStyles(ring, co);
  assert.equal(A(shaped, 12, 12), 0);
  const boxed = applyStyles(ring, co, { transparencyShapes: false });
  assert.deepEqual(at(boxed, 12, 12), [0, 255, 0, 1]);
  assert.deepEqual(at(boxed, 7, 7), [0, 255, 0, 1]);
  assert.equal(A(boxed, 3, 3), 0, 'outside the content box');
  // without interior effects the layer keeps its own transparency
  assert.ok(same(applyStyles(ring, { dropShadow: shadow }, { transparencyShapes: false }), applyStyles(ring, { dropShadow: shadow })));
});

test('split parts recomposite to the merged image', () => {
  const img = shape();
  const st = {
    dropShadow: [{ enabled: true, distance: 4, size: 3 }, { enabled: true, distance: 3, angle: 0, color: '#0000ff', blend: 'screen' }],
    outerGlow: { enabled: true, size: 5 },
    bevel: { enabled: true, style: 'emboss', size: 4 },
    colorOverlay: { enabled: true, color: '#00ff00', blend: 'multiply', opacity: 0.6 },
    stroke: { enabled: true, size: 2, position: 'center' },
  };
  for (const fillOpacity of [1, 0.4]) {
    const merged = applyStyles(img, st, { fillOpacity });
    const split = applyStyles(img, st, { fillOpacity, split: true });
    assert.equal(split.above, null);
    assert.deepEqual([split.offsetX, split.offsetY, split.layer.width], [merged.offsetX, merged.offsetY, merged.image.width]);
    const re = { width: split.below.width, height: split.below.height, data: new Uint8ClampedArray(split.below.data) };
    blendImages('normal', split.layer, re, 1, null);
    assert.deepEqual(Buffer.from(re.data), Buffer.from(merged.image.data), `fill ${fillOpacity}`);
  }
  // nothing below: below is null and the layer is the merged image
  const inner = applyStyles(img, { colorOverlay: { enabled: true } }, { split: true });
  assert.equal(inner.below, null);
  assert.deepEqual(inner.layer.data, applyStyles(img, { colorOverlay: { enabled: true } }).image.data);
});

/** Recomposites splitEffects' parts the way the merged render draws them (see splitEffects). */
function recomposite(img, styles, fill, parts, merged) {
  const { offsetX: ox, offsetY: oy } = merged;
  const W = merged.image.width, H = merged.image.height;
  const place = (p) => {
    const full = createImage(W, H);
    for (let y = 0; y < p.image.height; y++) for (let x = 0; x < p.image.width; x++) {
      const tx = p.x - ox + x, ty = p.y - oy + y;
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
      full.data.set(p.image.data.subarray((y * p.image.width + x) * 4, (y * p.image.width + x) * 4 + 4), (ty * W + tx) * 4);
    }
    return full;
  };
  const B = createImage(W, H);
  let empty = true;
  for (const p of parts.filter((q) => !q.clip)) {
    const src = place(p);
    if (empty) {
      for (let i = 0; i < src.data.length; i += 4) {
        const a = (src.data[i + 3] * p.opacity + 0.5) | 0;
        if (a) B.data.set([src.data[i], src.data[i + 1], src.data[i + 2], a], i);
      }
      empty = false;
    } else blendImages(p.blend, src, B, p.opacity, null);
  }
  // the interior: the layer colour at the fill everywhere, the clipped parts blended on, clipped to the alpha
  const I = createImage(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx = x + ox, sy = y + oy, i = (y * W + x) * 4;
    I.data[i + 3] = Math.round(fill * 255);
    if (sx >= 0 && sy >= 0 && sx < img.width && sy < img.height && img.data[(sy * img.width + sx) * 4 + 3]) I.data.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 3), i);
  }
  for (const p of parts.filter((q) => q.clip)) blendImages(p.blend, place(p), I, p.opacity, null);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx = x + ox, sy = y + oy, i = (y * W + x) * 4;
    const a8 = sx >= 0 && sy >= 0 && sx < img.width && sy < img.height ? img.data[(sy * img.width + sx) * 4 + 3] : 0;
    const a = ((I.data[i + 3] * a8) / 255 + 0.5) | 0;
    if (a) I.data[i + 3] = a;
    else I.data.fill(0, i, i + 4);
  }
  if (empty) return I;
  blendImages('normal', I, B, 1, null);
  return B;
}

test('splitEffects: exact parts in stacking order (exterior bottom first, interior clipped above)', () => {
  const img = shape();
  const st = {
    dropShadow: [{ enabled: true, distance: 4, size: 3 }, { enabled: true, distance: 3, angle: 0, color: '#0000ff', blend: 'screen', opacity: 0.5 }],
    outerGlow: { enabled: true, size: 5 },
    innerShadow: { enabled: true, size: 2 },
    bevel: { enabled: true, style: 'emboss', size: 4 },
    colorOverlay: { enabled: true, color: '#00ff00', blend: 'multiply', opacity: 0.6 },
    stroke: [{ enabled: true, size: 2, position: 'center' }, { enabled: true, size: 1, position: 'outside', color: '#ff0000' }],
    satin: { enabled: false },
  };
  const parts = splitEffects(img, st, { fillOpacity: 0.7 });
  assert.deepEqual(parts.map((p) => [p.key, p.index, p.part ?? '', p.clip]), [
    ['dropShadow', 1, '', false], ['dropShadow', 0, '', false], ['outerGlow', 0, '', false],
    ['bevel', 0, 'outer-highlight', false], ['bevel', 0, 'outer-shadow', false],
    ['stroke', 1, 'outer', false], ['stroke', 0, 'outer', false],
    ['colorOverlay', 0, '', true], ['innerShadow', 0, '', true],
    ['bevel', 0, 'inner-highlight', true], ['bevel', 0, 'inner-shadow', true], ['stroke', 0, 'inner', true],
  ]);
  assert.deepEqual(parts.map((p) => p.name).slice(0, 4), ['Drop Shadow', 'Drop Shadow', 'Outer Glow', 'Outer Bevel Highlights']);
  assert.equal(parts[0].blend, 'screen');
  assert.equal(parts[0].opacity, 0.5);
  const merged = applyStyles(img, st, { fillOpacity: 0.7 });
  const re = recomposite(img, st, 0.7, parts, merged);
  assert.deepEqual(Buffer.from(re.data), Buffer.from(merged.image.data));
  // each part is cropped to its pixels
  for (const p of parts) assert.ok(p.image.width <= merged.image.width && p.image.height <= merged.image.height);
  assert.deepEqual(splitEffects(img, { ...st, hidden: true }), []);
});

test('scaleEffects scales the new pixel fields; gradient placement stays', () => {
  const st = {
    patternOverlay: { enabled: true, scale: 1, origin: [10, 4] },
    stroke: { enabled: true, size: 4, patternScale: 2, origin: [2, 2], scale: 1.5, offset: [10, 0] },
    bevel: { enabled: true, size: 4, texture: { enabled: true, scale: 1, origin: [4, 8] } },
    gradientOverlay: { enabled: true, offset: [20, 10], scale: 1 },
  };
  const k = scaleEffects(st, 0.5);
  assert.deepEqual(k.patternOverlay.origin, [5, 2]);
  assert.deepEqual([k.stroke.size, k.stroke.patternScale, k.stroke.scale], [2, 1, 1.5]);
  assert.deepEqual(k.stroke.origin, [1, 1]);
  assert.deepEqual(k.stroke.offset, [10, 0]);
  assert.deepEqual([k.bevel.texture.scale, k.bevel.texture.origin], [0.5, [2, 4]]);
  assert.deepEqual(k.gradientOverlay.offset, [20, 10]);
  // mergeStyles copies the nested fields
  const m = mergeStyles(st);
  m.bevel.texture.scale = 9;
  m.patternOverlay.origin[0] = 99;
  assert.equal(st.bevel.texture.scale, 1);
  assert.equal(st.patternOverlay.origin[0], 10);
});

test('dragging in the document: the patch puts the effect where the pointer moved it', async () => {
  const { dragPatch } = await import('../../src/renderer/lib/style-canvas-drag.js');
  const RAD = Math.PI / 180;
  // a shadow's offset vector moves with the pointer
  const fx = { angle: 120, distance: 10, useGlobalLight: true };
  const p = dragPatch('dropShadow', fx, { x: 6, y: -4 });
  const before = [-Math.cos(120 * RAD) * 10, Math.sin(120 * RAD) * 10];
  const after = [-Math.cos(p.angle * RAD) * p.distance, Math.sin(p.angle * RAD) * p.distance];
  assert.ok(Math.abs(after[0] - (before[0] + 6)) < 1 && Math.abs(after[1] - (before[1] - 4)) < 1, `${after} ${before}`);
  assert.equal(p.useGlobalLight, false);
  // a drag down-right from no offset: light from the upper left
  assert.deepEqual(dragPatch('innerShadow', { angle: 0, distance: 0 }, { x: 10, y: 10 }), { distance: 14, angle: 135 });
  // satin: its own convention (the offset is +cos, -sin)
  const s = dragPatch('satin', { angle: 0, distance: 5 }, { x: 0, y: -5 });
  assert.deepEqual(s, { distance: 7, angle: 45 });
  // overlays and the texture
  assert.deepEqual(dragPatch('gradientOverlay', { offset: [10, 0] }, { x: 20, y: 10 }, { width: 200, height: 100 }), { offset: [20, 10] });
  assert.deepEqual(dragPatch('patternOverlay', {}, { x: 3.4, y: -2 }), { origin: [3, -2] });
  assert.deepEqual(dragPatch('bevel-texture', { texture: { enabled: true, origin: [1, 1] } }, { x: 2, y: 2 }), { texture: { enabled: true, origin: [3, 3] } });
  assert.deepEqual(dragPatch('stroke', {}, { x: 1, y: 1 }), {});
});
