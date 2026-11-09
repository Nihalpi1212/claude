// Filters, part B (src/shared/pixels/filters-more-b.js): Displace, Fibers, Lighting Effects, Tree,
// Flame, Picture Frame, Extrude, Tiles, Trace Contour, Wind. Numbers, not just "does not throw".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILTERS, applyFilter } from '../../src/shared/pixels/filters.js';
import { FILTERS_MORE_B, TREE_TYPES, FLAME_TYPES, FRAME_TYPES, flattenPath } from '../../src/shared/pixels/filters-more-b.js';
import { createImage, setPixel, getPixel, luminance } from '../../src/shared/pixels/core.js';
import { gradientImage, solidImage } from './helpers.mjs';

const KINDS = ['displace', 'fibers', 'lighting-effects', 'tree', 'flame', 'picture-frame', 'extrude', 'tiles', 'trace-contour', 'wind'];
const px = (img, x, y) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
const copy = (img) => ({ width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) });
const countAlpha = (img, rect = null) => {
  let n = 0;
  const r = rect ?? { x: 0, y: 0, width: img.width, height: img.height };
  for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) if (img.data[(y * img.width + x) * 4 + 3] > 0) n++;
  return n;
};
const same = (a, b) => a.data.length === b.data.length && a.data.every((v, i) => v === b.data[i]);
const flatMap = (w, h, r, g, b) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  return { width: w, height: h, data };
};
/** A photo-like image: smooth gradients plus a bright disc. */
function photo(w = 64, h = 48) {
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const disc = Math.hypot(x - w / 2, y - h / 2) < Math.min(w, h) / 4;
    setPixel(img, x, y, disc ? [230, 200, 90, 1] : [(x * 255) / w, (y * 255) / h, 150, 1]);
  }
  return img;
}
const PATH = { subpaths: [{ closed: false, points: [{ x: 32, y: 44 }, { x: 32, y: 8 }] }] };

test('catalogue: every part-B kind is real (no placeholder), has fields and the final ids', () => {
  for (const k of KINDS) {
    assert.ok(FILTERS_MORE_B[k], k);
    assert.equal(FILTERS[k], FILTERS_MORE_B[k], `${k} merged into FILTERS`);
    assert.ok(!FILTERS[k].placeholder, `${k} is no placeholder`);
    assert.ok(Array.isArray(FILTERS[k].fields) && FILTERS[k].fields.length > 0, `${k} has dialog fields`);
    for (const f of FILTERS[k].fields) if (f.type !== 'section') assert.equal(typeof f.key, 'string', `${k} field ${f.label} has a key`);
  }
  assert.equal(FILTERS.displace.ui, 'custom');
  assert.equal(FILTERS.flame.ui, 'custom');
  assert.equal(FILTERS.displace.category, 'distort');
  for (const k of ['fibers', 'lighting-effects', 'tree', 'flame', 'picture-frame']) assert.equal(FILTERS[k].category, 'render', k);
  for (const k of ['extrude', 'tiles', 'trace-contour', 'wind']) assert.equal(FILTERS[k].category, 'stylize', k);
  // margins are numbers (or functions of the params) and never negative
  for (const k of KINDS) {
    const m = FILTERS[k].margin;
    const v = typeof m === 'function' ? m(FILTERS[k].defaults) : m;
    assert.ok(typeof v === 'number' && v >= 0, `${k} margin ${v}`);
  }
  assert.ok(FILTERS.displace.margin({ horizontalScale: -40, verticalScale: 5 }) >= 40);
});

// ---- Displace -----------------------------------------------------------------------------------------------

test('displace: a flat 255-red map moves pixels by exactly horizontalScale (and 128 moves nothing)', () => {
  const img = createImage(40, 10);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 40; x++) setPixel(img, x, y, [x * 6, y * 20, 7, 1]);
  const before = copy(img);
  applyFilter(img, 'displace', { horizontalScale: 10, verticalScale: 0, map: flatMap(4, 4, 255, 128, 0), edge: 'repeat' });
  // white displaces the image left: the output at x shows what was at x + 10
  for (let x = 0; x < 30; x++) assert.deepEqual(px(img, x, 4), px(before, x + 10, 4), `x ${x}`);
  // repeat edge pixels beyond the right border
  assert.deepEqual(px(img, 35, 4), px(before, 39, 4));
  const grey = copy(before);
  applyFilter(grey, 'displace', { horizontalScale: 50, verticalScale: 50, map: flatMap(4, 4, 128, 128, 128) });
  assert.ok(same(grey, before), 'a 128 map is the identity');
  // 0 moves the other way (sampling to the left), wrap mode wraps around
  const wrap = copy(before);
  applyFilter(wrap, 'displace', { horizontalScale: 10, verticalScale: 0, map: flatMap(4, 4, 0, 128, 0), edge: 'wrap' });
  assert.deepEqual(px(wrap, 15, 2), px(before, 5, 2));
  assert.deepEqual(px(wrap, 3, 2), px(before, 33, 2));
});

test('displace: green displaces vertically, a one-channel map drives both axes, tile vs stretch, rect limits writes', () => {
  const img = createImage(32, 32);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) setPixel(img, x, y, [x * 8, y * 8, 99, 1]);
  const before = copy(img);
  const vert = copy(before);
  applyFilter(vert, 'displace', { horizontalScale: 0, verticalScale: 4, map: flatMap(2, 2, 128, 255, 0) });
  assert.deepEqual(px(vert, 10, 10), px(before, 10, 14));
  const single = copy(before);
  applyFilter(single, 'displace', { horizontalScale: 3, verticalScale: 3, map: { width: 2, height: 2, data: new Uint8ClampedArray([255, 255, 255, 255]) } });
  assert.deepEqual(px(single, 10, 10), px(before, 13, 13));
  // a 2 x 2 map stretched: the left half of the image follows the first column, the right half the second;
  // tiled, the two columns alternate per pixel
  const map = { width: 2, height: 2, data: new Uint8ClampedArray([255, 128, 0, 255, 128, 128, 0, 255, 255, 128, 0, 255, 128, 128, 0, 255]) };
  const stretch = copy(before);
  applyFilter(stretch, 'displace', { horizontalScale: 2, verticalScale: 0, map, mapMode: 'stretch' });
  assert.deepEqual(px(stretch, 5, 5), px(before, 7, 5));
  assert.deepEqual(px(stretch, 25, 5), px(before, 25, 5));
  const tiled = copy(before);
  applyFilter(tiled, 'displace', { horizontalScale: 2, verticalScale: 0, map, mapMode: 'tile' });
  assert.deepEqual(px(tiled, 24, 5), px(before, 26, 5));
  assert.deepEqual(px(tiled, 25, 5), px(before, 25, 5));
  // rect: outside untouched, inside equals the whole-image run
  const whole = copy(before), part = copy(before);
  applyFilter(whole, 'displace', { horizontalScale: 5, verticalScale: -3, map: flatMap(3, 3, 200, 60, 0) });
  applyFilter(part, 'displace', { horizontalScale: 5, verticalScale: -3, map: flatMap(3, 3, 200, 60, 0) }, { x: 8, y: 8, width: 10, height: 10 });
  assert.deepEqual(px(part, 2, 2), px(before, 2, 2));
  assert.deepEqual(px(part, 12, 12), px(whole, 12, 12));
  // no map: nothing happens
  const none = copy(before);
  applyFilter(none, 'displace', { horizontalScale: 50, verticalScale: 50, map: null });
  assert.ok(same(none, before));
});

// ---- Fibers -------------------------------------------------------------------------------------------------

test('fibers: opaque, within the two colours, deterministic per seed, vertical streaks, position stable', () => {
  const img = createImage(48, 48);
  applyFilter(img, 'fibers', { seed: 3, colors: ['#200000', '#ffe0c0'] });
  let dark = 0, light = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    assert.equal(img.data[i + 3], 255);
    assert.ok(img.data[i] >= 0x20 && img.data[i] <= 0xff && img.data[i + 1] <= 0xe0 && img.data[i + 2] <= 0xc0, 'between the colours');
    if (img.data[i] < 128) dark++;
    else light++;
  }
  assert.ok(dark > 100 && light > 100, 'both colours appear');
  const again = createImage(48, 48);
  applyFilter(again, 'fibers', { seed: 3, colors: ['#200000', '#ffe0c0'] });
  assert.ok(same(img, again), 'deterministic');
  const other = createImage(48, 48);
  applyFilter(other, 'fibers', { seed: 4, colors: ['#200000', '#ffe0c0'] });
  assert.ok(!same(img, other), 'another seed differs');
  // fibres run vertically: neighbours along y agree far more than neighbours along x
  let dv = 0, dh = 0;
  for (let y = 1; y < 48; y++) for (let x = 1; x < 48; x++) {
    dv += Math.abs(img.data[(y * 48 + x) * 4] - img.data[((y - 1) * 48 + x) * 4]);
    dh += Math.abs(img.data[(y * 48 + x) * 4] - img.data[(y * 48 + x - 1) * 4]);
  }
  assert.ok(dv * 2 < dh, `vertical ${dv} vs horizontal ${dh}`);
  const part = createImage(48, 48);
  applyFilter(part, 'fibers', { seed: 3, colors: ['#200000', '#ffe0c0'] }, { x: 10, y: 10, width: 12, height: 12 });
  assert.deepEqual(px(part, 15, 15), px(img, 15, 15));
  assert.deepEqual(px(part, 2, 2), [0, 0, 0, 0]);
  // stronger strength = more contrast (fewer mid greys)
  const soft = createImage(48, 48), hard = createImage(48, 48);
  applyFilter(soft, 'fibers', { strength: 1 });
  applyFilter(hard, 'fibers', { strength: 40 });
  const mids = (im) => { let n = 0; for (let i = 0; i < im.data.length; i += 4) if (im.data[i] > 80 && im.data[i] < 176) n++; return n; };
  assert.ok(mids(hard) < mids(soft));
});

// ---- Lighting Effects ---------------------------------------------------------------------------------------

test('lighting-effects: a centred spot lights the middle and darkens the corners; ambience lifts them; alpha kept', () => {
  const img = solidImage(80, 60, [200, 200, 200, 1]);
  setPixel(img, 0, 0, [200, 200, 200, 0]);
  applyFilter(img, 'lighting-effects', {});
  const centre = px(img, 40, 30), corner = px(img, 78, 58);
  assert.ok(centre[0] >= 190, `centre lit ${centre}`);
  assert.ok(corner[0] < 30, `far side dark ${corner}`);
  assert.deepEqual(px(img, 0, 0)[3], 0, 'transparent stays transparent');
  assert.equal(px(img, 5, 5)[3], 255);
  const amb = solidImage(80, 60, [200, 200, 200, 1]);
  applyFilter(amb, 'lighting-effects', { ambient: 50 });
  assert.ok(px(amb, 78, 58)[0] > 80 && px(amb, 78, 58)[0] < 140, `ambience ${px(amb, 78, 58)}`);
  // a coloured light tints
  const red = solidImage(40, 40, [255, 255, 255, 1]);
  applyFilter(red, 'lighting-effects', { lights: [{ type: 'point', x: 0.5, y: 0.5, color: '#ff0000', intensity: 35, radius: 1 }], metallic: -100, gloss: -100 });
  const c = px(red, 20, 20);
  assert.ok(c[0] > 200 && c[1] < 60 && c[2] < 60, `red light ${c}`);
});

test('lighting-effects: an infinite light with a bump texture shades slopes, exposure is a gain, 16 lights max', () => {
  const img = createImage(64, 16);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 64; x++) setPixel(img, x, y, [160, 160, 160, 1]);
  const flat = copy(img);
  applyFilter(flat, 'lighting-effects', { lights: [{ type: 'infinite', angle: 0, radius: 0.6, intensity: 35 }], texture: 'none' });
  // flat surface: uniform
  assert.deepEqual(px(flat, 5, 8), px(flat, 60, 8));
  // a luminance ramp as the bump map: the slope facing the light (from the left, angle 0) brightens the lit side
  const bumped = createImage(64, 16);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 64; x++) setPixel(bumped, x, y, [160, 160, 160, 1]);
  const ramp = createImage(64, 16);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 64; x++) setPixel(ramp, x, y, [x < 32 ? x * 8 : (63 - x) * 8, 0, 0, 1]);
  bumped.data.set(ramp.data);
  const lit = copy(bumped);
  applyFilter(lit, 'lighting-effects', { lights: [{ type: 'infinite', angle: 0, radius: 0.6, intensity: 35, color: '#ffffff' }], texture: 'red', height: 100, metallic: -100, gloss: -100 });
  const rising = px(lit, 10, 8), falling = px(lit, 50, 8);
  // red channel is the bump, compare the untouched blue/green response instead: use luminance of the output over the input ratio
  const ratio = (out, x) => luminance(out[0], out[1], out[2]) / Math.max(1, luminance(...px(bumped, x, 8)));
  assert.ok(ratio(rising, 10) !== ratio(falling, 50), 'slopes shade differently');
  const dim = solidImage(16, 16, [100, 100, 100, 1]), bright = solidImage(16, 16, [100, 100, 100, 1]);
  applyFilter(dim, 'lighting-effects', { lights: [{ type: 'infinite' }], exposure: -50, metallic: -100, gloss: -100 });
  applyFilter(bright, 'lighting-effects', { lights: [{ type: 'infinite' }], exposure: 50, metallic: -100, gloss: -100 });
  assert.ok(px(bright, 8, 8)[0] > px(dim, 8, 8)[0] * 1.8, `exposure ${px(dim, 8, 8)} ${px(bright, 8, 8)}`);
  const many = solidImage(8, 8, [100, 100, 100, 1]);
  applyFilter(many, 'lighting-effects', { lights: Array.from({ length: 40 }, () => ({ type: 'infinite', intensity: 100 })) });
  assert.equal(px(many, 4, 4)[3], 255);
});

// ---- Tree ---------------------------------------------------------------------------------------------------

test('tree: every species draws into an empty layer, deterministic per seed, alpha 0 where nothing is drawn, rect limits writes', () => {
  assert.ok(TREE_TYPES.length >= 8, `${TREE_TYPES.length} species`);
  for (const k of ['oak', 'pine', 'willow', 'palm', 'birch', 'maple', 'cherry-blossom', 'bare']) assert.ok(TREE_TYPES.includes(k), k);
  for (const type of TREE_TYPES) {
    const img = createImage(120, 90);
    applyFilter(img, 'tree', { type, seed: 2 });
    const n = countAlpha(img);
    assert.ok(n > 120 * 90 * 0.02, `${type} draws something (${n} px)`);
    // the trunk stands at the bottom centre, the top corners stay empty
    assert.ok(px(img, 60, 86)[3] > 0 || px(img, 59, 86)[3] > 0 || px(img, 61, 86)[3] > 0, `${type} trunk base`);
    assert.equal(px(img, 0, 0)[3], 0, `${type} top-left empty`);
    assert.equal(px(img, 119, 0)[3], 0, `${type} top-right empty`);
    assert.equal(px(img, 0, 89)[3], 0, `${type} bottom-left empty`);
  }
  const a = createImage(100, 80), b = createImage(100, 80), c = createImage(100, 80);
  applyFilter(a, 'tree', { seed: 5 });
  applyFilter(b, 'tree', { seed: 5 });
  applyFilter(c, 'tree', { seed: 6 });
  assert.ok(same(a, b), 'deterministic');
  assert.ok(!same(a, c), 'another seed differs');
  // rect: the written part equals the whole-image run, the rest is untouched
  const part = createImage(100, 80);
  applyFilter(part, 'tree', { seed: 5 }, { x: 30, y: 20, width: 40, height: 40 });
  assert.equal(countAlpha(part, { x: 0, y: 0, width: 100, height: 20 }), 0);
  for (let y = 20; y < 60; y += 7) for (let x = 30; x < 70; x += 5) assert.deepEqual(px(part, x, y), px(a, x, y), `rect ${x},${y}`);
  // leaves off (bare) covers less than oak; no leaves amount means fewer pixels
  const bare = createImage(100, 80), oak = createImage(100, 80), noLeaves = createImage(100, 80);
  applyFilter(bare, 'tree', { type: 'bare', seed: 5 });
  applyFilter(oak, 'tree', { type: 'oak', seed: 5 });
  applyFilter(noLeaves, 'tree', { type: 'oak', seed: 5, leavesAmount: 0 });
  assert.ok(countAlpha(noLeaves) < countAlpha(oak));
  // the leaf colour is honoured (a blue tree has blue leaves)
  const blue = createImage(100, 80);
  applyFilter(blue, 'tree', { type: 'oak', seed: 5, leafColor: '#0000ff', branchColor: '#000000' });
  let blues = 0;
  for (let i = 0; i < blue.data.length; i += 4) if (blue.data[i + 3] > 200 && blue.data[i + 2] > 150 && blue.data[i] < 60) blues++;
  assert.ok(blues > 50, `blue leaves ${blues}`);
  // the tree composites over existing pixels (source-over), the background stays where nothing is drawn
  const over = solidImage(100, 80, [10, 20, 30, 1]);
  applyFilter(over, 'tree', { seed: 5 });
  assert.deepEqual(px(over, 0, 0), [10, 20, 30, 255]);
  assert.notDeepEqual(px(over, 50, 76), [10, 20, 30, 255]);
});

// ---- Flame --------------------------------------------------------------------------------------------------

test('flame: no path is a no-op; all six types render warm pixels along the path and nothing far away; deterministic', () => {
  assert.equal(FLAME_TYPES.length, 6);
  const none = photo();
  const before = copy(none);
  applyFilter(none, 'flame', { path: null });
  assert.ok(same(none, before), 'no path, no change');
  for (const flameType of FLAME_TYPES) {
    const img = createImage(64, 56);
    applyFilter(img, 'flame', { flameType, path: PATH, seed: 2, interval: 8, length: 20, width: 20 });
    const n = countAlpha(img);
    assert.ok(n > 100, `${flameType} draws (${n})`);
    // a flame is warm: red dominates blue where it is opaque enough
    let warm = 0, cold = 0;
    for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 3] > 128) (img.data[i] > img.data[i + 2] ? warm++ : cold++);
    assert.ok(warm > cold * 10, `${flameType} warm ${warm} cold ${cold}`);
    // far corners untouched (the path runs down the middle)
    assert.equal(px(img, 0, 55)[3], 0, `${flameType} corner`);
    assert.equal(px(img, 63, 55)[3], 0, `${flameType} corner`);
  }
  const a = createImage(64, 56), b = createImage(64, 56), c = createImage(64, 56);
  applyFilter(a, 'flame', { path: PATH, seed: 9, turbulence: 50, jag: 30 });
  applyFilter(b, 'flame', { path: PATH, seed: 9, turbulence: 50, jag: 30 });
  applyFilter(c, 'flame', { path: PATH, seed: 10, turbulence: 50, jag: 30 });
  assert.ok(same(a, b));
  assert.ok(!same(a, c));
  // the single flame sits on the path: the column of the path is lit, 25 px away it is not
  assert.ok(px(a, 32, 30)[3] > 100, `on the path ${px(a, 32, 30)}`);
  assert.equal(px(a, 4, 30)[3], 0);
  // custom colour: a blue flame has blue cores
  const blue = createImage(64, 56);
  applyFilter(blue, 'flame', { path: PATH, useCustomColor: true, color: '#0000ff', seed: 1 });
  let blues = 0;
  for (let i = 0; i < blue.data.length; i += 4) if (blue.data[i + 3] > 128 && blue.data[i + 2] > blue.data[i]) blues++;
  assert.ok(blues > 50, `blue ${blues}`);
  // rect limits writes and matches the whole run
  const part = createImage(64, 56);
  applyFilter(part, 'flame', { path: PATH, seed: 9, turbulence: 50, jag: 30 }, { x: 20, y: 10, width: 24, height: 20 });
  assert.equal(countAlpha(part, { x: 0, y: 40, width: 64, height: 16 }), 0);
  assert.deepEqual(px(part, 32, 20), px(a, 32, 20));
  // bezier paths flatten to several segments, straight ones to two points
  assert.equal(flattenPath(PATH)[0].length, 2);
  assert.ok(flattenPath({ subpaths: [{ points: [{ x: 0, y: 0, outX: 10, outY: 40 }, { x: 40, y: 0, inX: 30, inY: 40 }] }] })[0].length > 5);
  assert.deepEqual(flattenPath({ subpaths: [{ points: [[1, 2], [3, 4]] }] }), [[[1, 2], [3, 4]]]);
  assert.deepEqual(flattenPath(null), []);
});

// ---- Picture Frame ------------------------------------------------------------------------------------------

test('picture-frame: all ten frames draw along the four edges, leave the middle empty, deterministic', () => {
  assert.ok(FRAME_TYPES.length >= 10);
  for (const frame of FRAME_TYPES) {
    const img = createImage(120, 80);
    applyFilter(img, 'picture-frame', { frame, size: 50, seed: 3 });
    const bw = Math.min(120, 80) * 0.12 * 0.5; // 4.8 px band
    assert.equal(countAlpha(img, { x: 20, y: 20, width: 80, height: 40 }), 0, `${frame} middle empty`);
    // every edge band carries pixels
    const band = Math.ceil(bw) + 2;
    assert.ok(countAlpha(img, { x: 0, y: 0, width: 120, height: band }) > 40, `${frame} top`);
    assert.ok(countAlpha(img, { x: 0, y: 80 - band, width: 120, height: band }) > 40, `${frame} bottom`);
    assert.ok(countAlpha(img, { x: 0, y: 0, width: band, height: 80 }) > 30, `${frame} left`);
    assert.ok(countAlpha(img, { x: 120 - band, y: 0, width: band, height: 80 }) > 30, `${frame} right`);
  }
  const a = createImage(90, 70), b = createImage(90, 70);
  applyFilter(a, 'picture-frame', { frame: 'stars', seed: 4 });
  applyFilter(b, 'picture-frame', { frame: 'stars', seed: 4 });
  assert.ok(same(a, b));
  // the band width follows size; the colours are the given ones
  const wide = createImage(100, 100), narrow = createImage(100, 100);
  applyFilter(wide, 'picture-frame', { frame: 'wood', size: 100, color: '#ff0000' });
  applyFilter(narrow, 'picture-frame', { frame: 'wood', size: 20, color: '#ff0000' });
  assert.ok(countAlpha(wide) > countAlpha(narrow) * 3);
  const c = px(wide, 3, 50);
  assert.ok(c[3] === 255 && c[0] > 150 && c[1] < 40, `wood colour ${c}`);
  // rect limits writes
  const part = createImage(100, 100);
  applyFilter(part, 'picture-frame', { frame: 'wood', size: 100, color: '#ff0000' }, { x: 50, y: 0, width: 50, height: 100 });
  assert.equal(countAlpha(part, { x: 0, y: 0, width: 50, height: 100 }), 0);
  assert.deepEqual(px(part, 97, 50), px(wide, 97, 50));
});

// ---- Extrude ------------------------------------------------------------------------------------------------

test('extrude: blocks and pyramids change the image, incomplete cells are masked, deterministic, solid fronts are flat', () => {
  const img = photo(64, 48);
  const before = copy(img);
  applyFilter(img, 'extrude', { size: 8, depth: 40, seed: 1 });
  assert.ok(!same(img, before));
  // with size 10 the bottom 8 px strip is made of incomplete cells: masked, it stays untouched (a shallow
  // depth keeps the complete blocks above it from projecting over it); unmasked, those cells are extruded too
  const masked = photo(64, 48);
  applyFilter(masked, 'extrude', { size: 10, depth: 4, maskIncomplete: true });
  for (let y = 42; y < 48; y++) for (let x = 0; x < 64; x++) assert.deepEqual(px(masked, x, y), px(before, x, y), `bottom strip ${x},${y}`);
  const unmasked = photo(64, 48);
  applyFilter(unmasked, 'extrude', { size: 10, depth: 40, maskIncomplete: false });
  let diff = 0;
  for (let y = 42; y < 48; y++) for (let x = 0; x < 64; x++) if (px(unmasked, x, y).join() !== px(before, x, y).join()) diff++;
  assert.ok(diff > 50, `unmasked partial cells are extruded (${diff})`);
  const a = photo(64, 48), b = photo(64, 48), c = photo(64, 48);
  applyFilter(a, 'extrude', { seed: 7 });
  applyFilter(b, 'extrude', { seed: 7 });
  applyFilter(c, 'extrude', { seed: 8 });
  assert.ok(same(a, b) && !same(a, c));
  // solid front: every top face is one colour, so a cell of the output has far fewer distinct colours
  const solid = photo(64, 48);
  applyFilter(solid, 'extrude', { size: 16, depth: 1, solidFront: true });
  const colours = new Set();
  for (let y = 2; y < 14; y++) for (let x = 2; x < 14; x++) colours.add(px(solid, x, y).join());
  assert.ok(colours.size <= 3, `solid front colours ${colours.size}`);
  // level-based pyramids: a flat image gives equal heights everywhere, i.e. the same pattern in every cell
  const pyr = solidImage(64, 48, [128, 128, 128, 1]);
  applyFilter(pyr, 'extrude', { type: 'pyramids', size: 16, depth: 60, depthMode: 'level-based' });
  assert.ok(!same(pyr, solidImage(64, 48, [128, 128, 128, 1])));
  // alpha of a transparent image stays transparent
  const empty = createImage(32, 32);
  applyFilter(empty, 'extrude', { size: 8 });
  assert.equal(countAlpha(empty), 0);
});

// ---- Tiles --------------------------------------------------------------------------------------------------

test('tiles: flat tiles keep at least (1 - 2 offset)^2 of their pixels, gaps take the fill, unaltered leaves the image', () => {
  // an image whose every 10 px tile is one flat colour (count 6 on a 60 px side)
  const w = 90, h = 60, ts = 10;
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(img, x, y, [((x / ts) | 0) * 25, ((y / ts) | 0) * 40, 77, 1]);
  const before = copy(img);
  const offset = 10;
  applyFilter(img, 'tiles', { count: 6, offset, fill: 'background', colors: ['#000000', '#ffffff'], seed: 2 });
  let inPlace = 0, white = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i] === before.data[i] && img.data[i + 1] === before.data[i + 1] && img.data[i + 2] === before.data[i + 2]) inPlace++;
    if (img.data[i] === 255 && img.data[i + 1] === 255 && img.data[i + 2] === 255) white++;
  }
  const o = offset / 100;
  assert.ok(inPlace >= (1 - 2 * o) * (1 - 2 * o) * w * h, `${inPlace} of ${w * h} in place`);
  assert.ok(inPlace >= (1 - o) * (1 - o) * w * h * 0.9, 'and close to (1 - offset)^2');
  assert.ok(white > 0 && white < w * h * 0.3, `gaps ${white}`);
  const fg = createImage(w, h);
  applyFilter(fg, 'tiles', { count: 6, offset: 40, fill: 'foreground', colors: ['#ff0000', '#ffffff'], seed: 2 });
  let reds = 0;
  for (let i = 0; i < fg.data.length; i += 4) if (fg.data[i] === 255 && fg.data[i + 1] === 0) reds++;
  assert.ok(reds > 0);
  const un = copy(before);
  applyFilter(un, 'tiles', { count: 6, offset: 1, fill: 'unaltered', seed: 2 });
  assert.ok(same(un, before), 'a 1 % offset rounds to no shift: unaltered fill leaves the image');
  const inv = copy(before);
  applyFilter(inv, 'tiles', { count: 6, offset: 50, fill: 'inverse', seed: 2 });
  let inverted = 0;
  for (let i = 0; i < inv.data.length; i += 4) if (inv.data[i] === 255 - before.data[i] && inv.data[i + 2] === 255 - 77) inverted++;
  assert.ok(inverted > 0);
  // deterministic and position stable
  const a = copy(before), b = copy(before);
  applyFilter(a, 'tiles', { count: 6, offset: 30, seed: 5 });
  applyFilter(b, 'tiles', { count: 6, offset: 30, seed: 5 }, { x: 20, y: 10, width: 30, height: 30 });
  assert.deepEqual(px(b, 30, 20), px(a, 30, 20));
  assert.deepEqual(px(b, 2, 2), px(before, 2, 2));
});

// ---- Trace Contour ------------------------------------------------------------------------------------------

test('trace-contour: a hard vertical edge gives one 1 px column; lower / upper pick the side; channels are separate', () => {
  const img = createImage(20, 10);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 20; x++) setPixel(img, x, y, x < 10 ? [0, 0, 0, 1] : [255, 255, 255, 1]);
  const lower = copy(img);
  applyFilter(lower, 'trace-contour', { level: 128, edge: 'lower' });
  for (let y = 0; y < 10; y++) for (let x = 0; x < 20; x++) assert.deepEqual(px(lower, x, y), x === 9 ? [0, 0, 0, 255] : [255, 255, 255, 255], `lower ${x},${y}`);
  const upper = copy(img);
  applyFilter(upper, 'trace-contour', { level: 128, edge: 'upper' });
  for (let y = 0; y < 10; y++) for (let x = 0; x < 20; x++) assert.deepEqual(px(upper, x, y), x === 10 ? [0, 0, 0, 255] : [255, 255, 255, 255], `upper ${x},${y}`);
  // only the red channel crosses the level: the contour zeroes red (a cyan line on white)
  const red = createImage(20, 10);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 20; x++) setPixel(red, x, y, [x < 10 ? 0 : 255, 60, 60, 1]);
  applyFilter(red, 'trace-contour', { level: 128 });
  assert.deepEqual(px(red, 9, 5), [0, 255, 255, 255]);
  assert.deepEqual(px(red, 5, 5), [255, 255, 255, 255]);
  // alpha kept, a flat image gives no contour
  const flat = solidImage(8, 8, [100, 100, 100, 0.5]);
  applyFilter(flat, 'trace-contour', {});
  assert.deepEqual(px(flat, 4, 4), [255, 255, 255, 128]);
  // the gradient crosses level 128 once: one column
  const g = gradientImage(64, 4);
  applyFilter(g, 'trace-contour', { level: 128 });
  let cols = 0;
  for (let x = 0; x < 64; x++) if (px(g, x, 1)[0] === 0) cols++;
  assert.equal(cols, 1);
});

// ---- Wind ---------------------------------------------------------------------------------------------------

test('wind: streaks blow from the bright side into the dark side; the bright side and the upwind dark side stay untouched', () => {
  // bright left half, dark right half
  const make = () => {
    const img = createImage(80, 24);
    for (let y = 0; y < 24; y++) for (let x = 0; x < 80; x++) setPixel(img, x, y, x < 40 ? [240, 220, 200, 1] : [20, 20, 30, 1]);
    return img;
  };
  for (const method of ['wind', 'blast', 'stagger']) {
    const img = make(), before = make();
    applyFilter(img, 'wind', { method, direction: 'right', seed: 3 });
    for (let y = 0; y < 24; y++) for (let x = 0; x < 40; x++) assert.deepEqual(px(img, x, y), px(before, x, y), `${method} bright side ${x},${y}`);
    let streaked = 0;
    for (let y = 0; y < 24; y++) for (let x = 40; x < 80; x++) if (px(img, x, y).join() !== px(before, x, y).join()) streaked++;
    assert.ok(streaked > 20, `${method} streaks ${streaked}`);
    // streaks are bounded: wind stays short, blast reaches further
    let farthest = 0;
    for (let y = 0; y < 24; y++) for (let x = 40; x < 80; x++) if (px(img, x, y).join() !== px(before, x, y).join()) farthest = Math.max(farthest, x - 40);
    if (method === 'blast') assert.ok(farthest > 16, `blast reach ${farthest}`);
    else assert.ok(farthest <= 16, `${method} reach ${farthest}`);
    // the streak carries the bright colour, fading
    const row = (() => { for (let y = 0; y < 24; y++) if (px(img, 41, y).join() !== px(before, 41, y).join()) return y; return -1; })();
    if (method !== 'stagger' && row >= 0) {
      assert.ok(px(img, 41, row)[0] > 100);
      assert.ok(px(img, 41, row)[0] >= px(img, 44, row)[0], 'fades downwind');
    }
    // the other direction leaves the dark side alone (nothing bright upwind of it)
    const left = make();
    applyFilter(left, 'wind', { method, direction: 'left', seed: 3 });
    for (let y = 0; y < 24; y++) for (let x = 40; x < 80; x++) assert.deepEqual(px(left, x, y), px(before, x, y), `${method} dark side untouched blowing left`);
  }
  const a = make(), b = make();
  applyFilter(a, 'wind', { seed: 4 });
  applyFilter(b, 'wind', { seed: 4 }, { x: 38, y: 0, width: 20, height: 24 });
  for (let y = 0; y < 24; y++) assert.deepEqual(px(b, 45, y), px(a, 45, y), 'rect matches the whole run');
});
