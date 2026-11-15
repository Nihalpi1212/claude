// Filter Gallery, part B (src/shared/pixels/gallery-sketch.js + textures.js): the Sketch, Texture and
// Distort effects and the procedural textures. Measurable properties per effect, not just "does not throw".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILTERS, GALLERY_GROUPS, applyFilter } from '../../src/shared/pixels/filters.js';
import {
  GALLERY_SKETCH, SKETCH_KINDS, TEXTURE_KINDS, DISTORT_KINDS, COLOR_KINDS, TEXTURE_FILE_KINDS,
  GLASS_PX_PER_UNIT, RIPPLE_PX_PER_UNIT, GRAIN_TYPES, PATTERN_TYPES, STROKE_DIRECTIONS,
} from '../../src/shared/pixels/gallery-sketch.js';
import { texture, relief, heightFromImage, smoothHeight, heightGradient, TEXTURE_NAMES } from '../../src/shared/pixels/textures.js';
import { createImage, setPixel } from '../../src/shared/pixels/core.js';
import { gradientImage, solidImage } from './helpers.mjs';

const FG = [200, 30, 40], BG = [240, 230, 210];
const COLORS = ['#c81e28', '#f0e6d2'];
const px = (img, x, y) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
const copy = (img) => ({ width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) });
const same = (a, b) => a.data.length === b.data.length && a.data.every((v, i) => v === b.data[i]);
const near = (a, b, tol = 2) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
const lum = (p) => (p[0] * 299 + p[1] * 587 + p[2] * 114) / 1000;
const meanLum = (img, rect = { x: 0, y: 0, width: img.width, height: img.height }) => {
  let s = 0, n = 0;
  for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
    s += lum(px(img, x, y));
    n++;
  }
  return s / n;
};
/** Fraction of pixels (optionally inside rect) that satisfy pred(rgba). */
const fraction = (img, pred, rect = { x: 0, y: 0, width: img.width, height: img.height }) => {
  let n = 0, total = 0;
  for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
    total++;
    if (pred(px(img, x, y), x, y)) n++;
  }
  return n / total;
};
/** Fraction of pixels whose colour lies (within tol) on the segment fg..bg. */
const onLine = (img, fg = FG, bg = BG, tol = 3) => fraction(img, (p) => {
  // project onto the segment and compare
  const d = [bg[0] - fg[0], bg[1] - fg[1], bg[2] - fg[2]];
  const len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  let t = ((p[0] - fg[0]) * d[0] + (p[1] - fg[1]) * d[1] + (p[2] - fg[2]) * d[2]) / len2;
  t = Math.max(0, Math.min(1, t));
  return near(p, [fg[0] + d[0] * t, fg[1] + d[1] * t, fg[2] + d[2] * t], tol);
});
const meanAbsDiff = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.data.length; i++) s += Math.abs(a.data[i] - b.data[i]);
  return s / a.data.length;
};
const grey = (w, h, v) => solidImage(w, h, [v, v, v, 1]);
/** Black band (rows y0..y1) on white. */
function band(w, h, y0, y1) {
  const img = grey(w, h, 255);
  for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) setPixel(img, x, y, [0, 0, 0, 1]);
  return img;
}
/** Left half black, right half white. */
function halves(w, h) {
  const img = grey(w, h, 255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w / 2; x++) setPixel(img, x, y, [0, 0, 0, 1]);
  return img;
}
/** A photo-like image: smooth gradients plus a bright disc and a dark box. */
function photo(w = 96, h = 72) {
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const disc = Math.hypot(x - w / 3, y - h / 2) < h / 4;
    const box = x > (w * 2) / 3 && y > h / 4 && y < (h * 3) / 4;
    setPixel(img, x, y, disc ? [235, 210, 90, 1] : box ? [30, 30, 40, 1] : [60 + (x * 150) / w, 90 + (y * 120) / h, 140, 1]);
  }
  return img;
}

// ---- registry -----------------------------------------------------------------------------------------------

test('every kind is registered, placeholder-free, in its gallery group, with fields for each parameter', () => {
  const all = [...SKETCH_KINDS, ...TEXTURE_KINDS, ...DISTORT_KINDS];
  assert.equal(SKETCH_KINDS.length, 14);
  assert.equal(TEXTURE_KINDS.length, 6);
  assert.equal(DISTORT_KINDS.length, 3);
  const group = (name) => GALLERY_GROUPS.find((g) => g.name === name).kinds;
  for (const k of all) {
    const def = FILTERS[k];
    assert.ok(def, k);
    assert.equal(def, GALLERY_SKETCH[k], k);
    assert.equal(def.category, 'gallery', k);
    assert.ok(!def.placeholder, `${k} still a placeholder`);
    assert.ok(Array.isArray(def.fields) && def.fields.length > 0, `${k} has fields`);
    assert.ok(group(def.gallery).includes(k), `${k} in ${def.gallery}`);
    // every field edits a parameter the defaults know, with a sane range
    for (const f of def.fields) {
      assert.ok(f.key in def.defaults, `${k}.${f.key} is a parameter`);
      if (f.type === 'slider') assert.ok(f.min < f.max && def.defaults[f.key] >= f.min && def.defaults[f.key] <= f.max, `${k}.${f.key} default in range`);
      if (f.type === 'select') assert.ok(f.options.some(([v]) => v === def.defaults[f.key]), `${k}.${f.key} default is an option`);
    }
  }
  for (const k of SKETCH_KINDS) assert.deepEqual(FILTERS[k].defaults.colors, ['#000000', '#ffffff'], `${k} colours default black on white`);
  for (const k of COLOR_KINDS) assert.equal(FILTERS[k].ui, 'custom', `${k} routes to the colour-injecting opener`);
  for (const k of TEXTURE_FILE_KINDS) assert.equal(FILTERS[k].ui, 'custom', `${k} routes to the texture-file opener`);
  assert.deepEqual(FILTERS.grain.fields.find((f) => f.key === 'grainType').options.map(([v]) => v), [...GRAIN_TYPES]);
  assert.deepEqual(FILTERS['halftone-pattern'].fields.find((f) => f.key === 'patternType').options.map(([v]) => v), [...PATTERN_TYPES]);
  assert.deepEqual(FILTERS['graphic-pen'].fields.find((f) => f.key === 'strokeDirection').options.map(([v]) => v), [...STROKE_DIRECTIONS]);
  assert.equal(GRAIN_TYPES.length, 10);
});

test('every kind keeps alpha, writes only inside rect and matches a whole-image run there', () => {
  const src = photo(64, 48);
  // a transparent hole and a half-transparent corner
  for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) setPixel(src, x, y, [0, 0, 0, 0]);
  for (let y = 0; y < 8; y++) for (let x = 40; x < 64; x++) setPixel(src, x, y, [200, 100, 50, 0.5]);
  const rect = { x: 16, y: 12, width: 24, height: 20 };
  for (const k of Object.keys(GALLERY_SKETCH)) {
    const full = applyFilter(copy(src), k, { colors: COLORS, seed: 3 });
    const part = applyFilter(copy(src), k, { colors: COLORS, seed: 3 }, rect);
    for (let y = 0; y < src.height; y++) for (let x = 0; x < src.width; x++) {
      const a = px(src, x, y), f = px(full, x, y), p = px(part, x, y);
      const inside = x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
      if (k !== 'glass' && k !== 'ocean-ripple') assert.equal(f[3], a[3], `${k} keeps alpha at ${x},${y}`);
      if (!inside) assert.deepEqual(p, a, `${k} left ${x},${y} alone`);
      else for (let c = 0; c < 4; c++) assert.ok(Math.abs(p[c] - f[c]) <= 6, `${k} partial matches full at ${x},${y}: ${p} vs ${f}`);
    }
  }
});

test('randomised kinds are deterministic for a seed and differ between seeds', () => {
  const src = photo(48, 36);
  for (const k of ['chalk-charcoal', 'graphic-pen', 'note-paper', 'reticulation', 'torn-edges', 'craquelure', 'grain', 'mosaic-tiles', 'stained-glass', 'diffuse-glow', 'glass', 'ocean-ripple']) {
    const a = applyFilter(copy(src), k, { seed: 5 }), b = applyFilter(copy(src), k, { seed: 5 }), c = applyFilter(copy(src), k, { seed: 6 });
    assert.ok(same(a, b), `${k} deterministic`);
    assert.ok(!same(a, c), `${k} seed matters`);
  }
});

// ---- Sketch -------------------------------------------------------------------------------------------------

test('bas-relief: flat areas are uniform, the slope facing the light takes the background colour', () => {
  const img = band(32, 48, 16, 32);
  const top = applyFilter(copy(img), 'bas-relief', { colors: COLORS, lightDirection: 'top', smoothness: 1, detail: 13 });
  assert.ok(onLine(top) > 0.99);
  const flat = px(top, 5, 5);
  assert.deepEqual(px(top, 20, 44), flat, 'flat areas share one tone');
  // the top edge of the band (white above, black below) slopes away from a light at the top: foreground; the bottom edge faces it: background
  const upper = lum(px(top, 16, 15)), lower = lum(px(top, 16, 32));
  assert.ok(upper < lum(flat) - 20 && lower > lum(flat) + 20, `${upper} ${lum(flat)} ${lower}`);
  const bottom = applyFilter(copy(img), 'bas-relief', { colors: COLORS, lightDirection: 'bottom', smoothness: 1, detail: 13 });
  assert.ok(lum(px(bottom, 16, 15)) > lum(px(bottom, 16, 32)), 'light from the bottom flips the shading');
});

test('chalk-charcoal: shadows go charcoal (fg), highlights chalk (bg), midtones stay 50% grey', () => {
  const dark = applyFilter(grey(32, 32, 0), 'chalk-charcoal', { colors: COLORS });
  const light = applyFilter(grey(32, 32, 255), 'chalk-charcoal', { colors: COLORS });
  const mid = applyFilter(grey(32, 32, 128), 'chalk-charcoal', { colors: COLORS });
  assert.ok(fraction(dark, (p) => near(p, FG, 60)) > 0.6);
  assert.ok(fraction(light, (p) => near(p, BG, 40)) > 0.6);
  assert.ok(fraction(mid, (p) => near(p, [128, 128, 128], 1)) === 1);
});

test('charcoal: white gives the background, black the foreground, the balance shifts the dark fraction', () => {
  assert.equal(fraction(applyFilter(grey(16, 16, 255), 'charcoal', { colors: COLORS }), (p) => near(p, BG, 1)), 1);
  assert.equal(fraction(applyFilter(grey(16, 16, 0), 'charcoal', { colors: COLORS }), (p) => near(p, FG, 1)), 1);
  const g = gradientImage(64, 16);
  const darkFrac = (balance) => fraction(applyFilter(copy(g), 'charcoal', { colors: COLORS, lightDarkBalance: balance }), (p) => lum(p) < lum(BG) - 30);
  assert.ok(darkFrac(100) > darkFrac(50) + 0.1 && darkFrac(50) > darkFrac(0) + 0.1, `${darkFrac(0)} ${darkFrac(50)} ${darkFrac(100)}`);
});

test('chrome is grey and not flat', () => {
  const out = applyFilter(photo(), 'chrome', { colors: COLORS });
  assert.equal(fraction(out, (p) => p[0] === p[1] && p[1] === p[2]), 1);
  let min = 255, max = 0;
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
    const v = px(out, x, y)[0];
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  assert.ok(max - min > 100);
});

test('conte-crayon: dark areas take the foreground, light the background, the paper texture lights it', () => {
  const dark = applyFilter(grey(32, 32, 0), 'conte-crayon', { colors: COLORS, foregroundLevel: 15, backgroundLevel: 15, relief: 0 });
  const light = applyFilter(grey(32, 32, 255), 'conte-crayon', { colors: COLORS, foregroundLevel: 15, backgroundLevel: 15, relief: 0 });
  assert.ok(fraction(dark, (p) => near(p, FG, 1)) > 0.9);
  assert.ok(fraction(light, (p) => near(p, BG, 1)) > 0.9);
  // the default levels (11 / 7) cover less: the highlights sit between the grey paper and the background colour
  const weak = applyFilter(grey(32, 32, 255), 'conte-crayon', { colors: COLORS, relief: 0 });
  assert.equal(fraction(weak, (p) => p[0] > 128 && p[0] < BG[0] && p[2] > 128 && p[2] <= BG[2]), 1);
  // relief 0 makes a flat colour; relief 30 shades it by the sandstone texture
  const flat = applyFilter(grey(32, 32, 0), 'conte-crayon', { colors: COLORS, relief: 0 });
  const textured = applyFilter(grey(32, 32, 0), 'conte-crayon', { colors: COLORS, relief: 30 });
  assert.ok(meanAbsDiff(flat, textured) > 2);
});

test('graphic-pen: two tones, strokes run along the chosen direction, balance sets the ink', () => {
  const out = applyFilter(grey(64, 64, 128), 'graphic-pen', { colors: COLORS, strokeDirection: 'horizontal' });
  assert.equal(fraction(out, (p) => near(p, FG, 1) || near(p, BG, 1)), 1);
  const sameRight = fraction(out, (p, x, y) => x < 63 && near(p, px(out, x + 1, y), 1), { x: 0, y: 0, width: 63, height: 64 });
  const sameDown = fraction(out, (p, x, y) => y < 63 && near(p, px(out, x, y + 1), 1), { x: 0, y: 0, width: 64, height: 63 });
  assert.ok(sameRight > sameDown + 0.15, `horizontal strokes: ${sameRight} vs ${sameDown}`);
  const vert = applyFilter(grey(64, 64, 128), 'graphic-pen', { colors: COLORS, strokeDirection: 'vertical' });
  const vRight = fraction(vert, (p, x, y) => x < 63 && near(p, px(vert, x + 1, y), 1), { x: 0, y: 0, width: 63, height: 64 });
  const vDown = fraction(vert, (p, x, y) => y < 63 && near(p, px(vert, x, y + 1), 1), { x: 0, y: 0, width: 64, height: 63 });
  assert.ok(vDown > vRight + 0.15);
  const ink = (b) => fraction(applyFilter(grey(64, 64, 128), 'graphic-pen', { colors: COLORS, lightDarkBalance: b }), (p) => near(p, FG, 1));
  assert.ok(ink(90) > ink(50) + 0.2 && ink(50) > ink(10) + 0.2);
});

test('halftone-pattern: line screens are horizontal and periodic, dots cover about the tone', () => {
  const size = 2, cell = 3 + size * 2;
  const line = applyFilter(grey(40, 40, 128), 'halftone-pattern', { colors: COLORS, patternType: 'line', size, contrast: 50 });
  for (let y = 0; y < 40; y++) for (let x = 1; x < 40; x++) assert.deepEqual(px(line, x, y), px(line, 0, y), 'rows are uniform');
  for (let y = 0; y + cell < 40; y++) assert.deepEqual(px(line, 0, y + cell), px(line, 0, y), `period ${cell}`);
  const distinct = new Set();
  for (let y = 0; y < cell; y++) distinct.add(px(line, 0, y).join());
  assert.ok(distinct.size >= 2, 'a period holds both tones');
  // a 25% grey (dark) dot screen is mostly foreground, a 75% grey mostly background
  const dark = fraction(applyFilter(grey(40, 40, 64), 'halftone-pattern', { colors: COLORS, patternType: 'dot', size, contrast: 50 }), (p) => near(p, FG, 1));
  const light = fraction(applyFilter(grey(40, 40, 192), 'halftone-pattern', { colors: COLORS, patternType: 'dot', size, contrast: 50 }), (p) => near(p, FG, 1));
  assert.ok(dark > 0.55 && light < 0.45, `${dark} ${light}`);
  const circle = applyFilter(grey(40, 40, 128), 'halftone-pattern', { colors: COLORS, patternType: 'circle', size });
  assert.ok(onLine(circle) > 0.99);
});

test('note-paper: two sheets (fg below, bg on top) and a relief at the step', () => {
  const img = halves(40, 24);
  const flat = applyFilter(copy(img), 'note-paper', { colors: COLORS, graininess: 0, relief: 0 });
  assert.equal(fraction(flat, (p) => near(p, FG, 1) || near(p, BG, 1)), 1);
  assert.ok(near(px(flat, 4, 12), FG, 1) && near(px(flat, 36, 12), BG, 1));
  const embossed = applyFilter(copy(img), 'note-paper', { colors: COLORS, graininess: 0, relief: 20 });
  assert.ok(near(px(embossed, 4, 12), FG, 1) && near(px(embossed, 36, 12), BG, 1), 'far from the step nothing changes');
  assert.ok(!near(px(embossed, 20, 12), px(flat, 20, 12), 8) || !near(px(embossed, 19, 12), px(flat, 19, 12), 8), 'the step is shaded');
});

test('photocopy: white stays paper, a large dark area is copied mostly around its edges', () => {
  assert.equal(fraction(applyFilter(grey(16, 16, 255), 'photocopy', { colors: COLORS }), (p) => near(p, BG, 1)), 1);
  const img = grey(80, 80, 255);
  for (let y = 10; y < 70; y++) for (let x = 10; x < 70; x++) setPixel(img, x, y, [0, 0, 0, 1]);
  const out = applyFilter(img, 'photocopy', { colors: COLORS, detail: 20, darkness: 8 });
  const edge = lum(px(out, 11, 40)), centre = lum(px(out, 40, 40));
  assert.ok(edge < lum(BG) - 40, `the edge is inked (${edge})`);
  assert.ok(centre > edge + 30, `the middle is lighter than the edge (${centre} vs ${edge})`);
  assert.ok(onLine(out) > 0.99);
});

test('plaster: flat areas are uniform, the light direction flips the shading at a step', () => {
  const img = band(32, 48, 16, 32);
  const top = applyFilter(copy(img), 'plaster', { colors: COLORS, lightDirection: 'top', smoothness: 2 });
  assert.deepEqual(px(top, 5, 4), px(top, 25, 4));
  const upper = lum(px(top, 16, 15)) - lum(px(top, 16, 10)), lower = lum(px(top, 16, 32)) - lum(px(top, 16, 40));
  const bottom = applyFilter(copy(img), 'plaster', { colors: COLORS, lightDirection: 'bottom', smoothness: 2 });
  const upperB = lum(px(bottom, 16, 15)) - lum(px(bottom, 16, 10)), lowerB = lum(px(bottom, 16, 32)) - lum(px(bottom, 16, 40));
  assert.ok(Math.sign(upper) !== Math.sign(upperB) && Math.sign(lower) !== Math.sign(lowerB), `${upper} ${lower} / ${upperB} ${lowerB}`);
  assert.ok(Math.abs(upper) > 5 && Math.abs(lower) > 5);
});

test('reticulation: shadows clump into the foreground, highlights stay background, the grain is two-tone', () => {
  const dark = applyFilter(grey(40, 40, 0), 'reticulation', { colors: COLORS });
  const light = applyFilter(grey(40, 40, 255), 'reticulation', { colors: COLORS });
  const mid = applyFilter(grey(40, 40, 140), 'reticulation', { colors: COLORS });
  assert.ok(fraction(dark, (p) => near(p, FG, 1)) > 0.95);
  assert.ok(fraction(light, (p) => near(p, BG, 1)) > 0.95);
  const f = fraction(mid, (p) => near(p, FG, 1));
  assert.ok(f > 0.1 && f < 0.9, `midtones are grainy (${f})`);
  assert.equal(fraction(mid, (p) => near(p, FG, 1) || near(p, BG, 1)), 1);
});

test('stamp is two-tone: the threshold follows the balance, smoothness rounds the shapes', () => {
  const out = applyFilter(photo(), 'stamp', { colors: COLORS });
  assert.equal(fraction(out, (p) => near(p, FG, 0) || near(p, BG, 0)), 1);
  const g = gradientImage(100, 4);
  const at = (b) => fraction(applyFilter(copy(g), 'stamp', { colors: COLORS, lightDarkBalance: b, smoothness: 1 }), (p) => near(p, FG, 0));
  assert.ok(Math.abs(at(25) - 0.5) < 0.06 && Math.abs(at(10) - 0.2) < 0.06 && Math.abs(at(40) - 0.8) < 0.06, `${at(10)} ${at(25)} ${at(40)}`);
  // a 1 px speck vanishes at high smoothness
  const speck = grey(40, 40, 255);
  setPixel(speck, 20, 20, [0, 0, 0, 1]);
  assert.equal(fraction(applyFilter(speck, 'stamp', { colors: COLORS, smoothness: 20 }), (p) => near(p, BG, 0)), 1);
});

test('torn-edges: the edge wanders from row to row, far from it the paper is solid', () => {
  const out = applyFilter(halves(64, 48), 'torn-edges', { colors: COLORS, contrast: 25 });
  assert.ok(onLine(out) > 0.99);
  assert.ok(near(px(out, 2, 24), FG, 2) && near(px(out, 61, 24), BG, 2));
  const crossings = [];
  for (let y = 0; y < 48; y++) {
    let x = 0;
    while (x < 63 && lum(px(out, x, y)) < (lum(FG) + lum(BG)) / 2) x++;
    crossings.push(x);
  }
  const mean = crossings.reduce((a, b) => a + b, 0) / crossings.length;
  const std = Math.sqrt(crossings.reduce((a, b) => a + (b - mean) ** 2, 0) / crossings.length);
  assert.ok(std > 1, `the tear is ragged (std ${std})`);
  assert.ok(Math.abs(mean - 32) < 8, `around the real edge (${mean})`);
});

test('water-paper keeps colours, bleeds along the fibres and follows brightness', () => {
  const img = band(16, 64, 0, 32); // black top, white bottom
  const short = applyFilter(copy(img), 'water-paper', { fiberLength: 4, brightness: 50, contrast: 50 });
  const long = applyFilter(copy(img), 'water-paper', { fiberLength: 30, brightness: 50, contrast: 50 });
  const width = (out) => {
    let n = 0;
    for (let y = 0; y < 64; y++) {
      const v = px(out, 8, y)[0];
      if (v > 30 && v < 225) n++;
    }
    return n;
  };
  assert.ok(width(short) >= 2 && width(long) > width(short) + 8, `${width(short)} ${width(long)}`);
  const colour = applyFilter(solidImage(16, 16, [200, 40, 40, 1]), 'water-paper', {});
  const c = px(colour, 8, 8);
  assert.ok(c[0] > c[1] + 60 && c[0] > c[2] + 60, 'red stays red');
  const dim = meanLum(applyFilter(grey(16, 16, 128), 'water-paper', { brightness: 0 })), bright = meanLum(applyFilter(grey(16, 16, 128), 'water-paper', { brightness: 100 }));
  assert.ok(bright > dim + 60);
});

// ---- Texture ------------------------------------------------------------------------------------------------

test('craquelure: a network of cracks, lighter or darker as asked, sparser with the spacing', () => {
  const base = grey(96, 96, 128);
  const light = applyFilter(copy(base), 'craquelure', { crackBrightness: 10, crackDepth: 0, crackSpacing: 15 });
  const dark = applyFilter(copy(base), 'craquelure', { crackBrightness: 0, crackDepth: 0, crackSpacing: 15 });
  const changed = (out) => fraction(out, (p) => Math.abs(p[0] - 128) > 4);
  assert.ok(changed(light) > 0.03 && changed(light) < 0.6, `${changed(light)}`);
  assert.ok(fraction(light, (p) => p[0] > 132) > 0.03 && fraction(light, (p) => p[0] < 124) === 0, 'bright cracks');
  assert.ok(fraction(dark, (p) => p[0] < 124) > 0.03 && fraction(dark, (p) => p[0] > 132) === 0, 'dark cracks');
  const sparse = applyFilter(copy(base), 'craquelure', { crackBrightness: 10, crackDepth: 0, crackSpacing: 40 });
  assert.ok(changed(sparse) < changed(light) * 0.8);
});

test('grain adds noise with the requested intensity; the types differ in structure', () => {
  const base = grey(64, 64, 128);
  const std = (out) => {
    let s = 0, n = 0;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      s += (px(out, x, y)[0] - 128) ** 2;
      n++;
    }
    return Math.sqrt(s / n);
  };
  const s0 = std(applyFilter(copy(base), 'grain', { intensity: 0 }));
  const s20 = std(applyFilter(copy(base), 'grain', { intensity: 20 }));
  const s40 = std(applyFilter(copy(base), 'grain', { intensity: 40 }));
  assert.equal(s0, 0);
  assert.ok(s20 > 8 && Math.abs(s40 / s20 - 2) < 0.2, `${s20} ${s40}`);
  assert.ok(Math.abs(meanLum(applyFilter(copy(base), 'grain', { intensity: 40, contrast: 50 })) - 128) < 2, 'contrast 50 keeps the mean');
  const mono = applyFilter(copy(base), 'grain', { intensity: 40, grainType: 'regular' });
  assert.equal(fraction(mono, (p) => p[0] === p[1] && p[1] === p[2]), 1, 'regular grain is monochrome');
  const speckle = applyFilter(copy(base), 'grain', { intensity: 40, grainType: 'speckle' });
  assert.ok(fraction(speckle, (p) => p[0] !== p[1] || p[1] !== p[2]) > 0.1, 'speckle is coloured');
  const sprinkles = applyFilter(copy(base), 'grain', { intensity: 40, grainType: 'sprinkles' });
  assert.ok(fraction(sprinkles, (p) => p[0] === 128) > 0.5 && fraction(sprinkles, (p) => p[0] > 200) > 0.05);
  const horizontal = applyFilter(copy(base), 'grain', { intensity: 40, grainType: 'horizontal' });
  const corr = (out, dx, dy) => {
    let s = 0, n = 0;
    for (let y = 0; y < 64 - dy; y++) for (let x = 0; x < 64 - dx; x++) {
      s += (px(out, x, y)[0] - 128) * (px(out, x + dx, y + dy)[0] - 128);
      n++;
    }
    return s / n;
  };
  assert.ok(corr(horizontal, 1, 0) > corr(horizontal, 0, 1) + 50, 'horizontal grain correlates along rows');
  for (const t of GRAIN_TYPES) assert.ok(std(applyFilter(copy(base), 'grain', { intensity: 60, grainType: t })) > 3, t);
});

test('mosaic-tiles: the grout is lighter than the chips and the chips keep the image', () => {
  const out = applyFilter(grey(96, 96, 128), 'mosaic-tiles', { tileSize: 12, groutWidth: 3, lightenGrout: 9 });
  const grout = fraction(out, (p) => p[0] > 150), kept = fraction(out, (p) => Math.abs(p[0] - 128) <= 2);
  assert.ok(grout > 0.08 && grout < 0.6, `grout ${grout}`);
  assert.ok(kept > 0.3, `chips keep the tone ${kept}`);
  assert.equal(fraction(out, (p) => p[0] < 90), 0, 'nothing goes very dark with light grout');
  const big = fraction(applyFilter(grey(96, 96, 128), 'mosaic-tiles', { tileSize: 40, groutWidth: 3, lightenGrout: 9 }), (p) => p[0] > 150);
  assert.ok(big < grout * 0.7, 'bigger tiles mean less grout');
  const darkGrout = applyFilter(grey(48, 48, 128), 'mosaic-tiles', { lightenGrout: 0 });
  assert.ok(fraction(darkGrout, (p) => p[0] < 100) > 0.05, 'lighten 0 leaves dark grout');
});

test('patchwork: squares of the cell mean, bevelled by the relief', () => {
  const g = gradientImage(64, 16);
  const flat = applyFilter(copy(g), 'patchwork', { squareSize: 4, relief: 0 });
  const cell = 2 + 4 * 1.5; // 8 px
  for (let cx = 0; cx < 64 / cell; cx++) {
    const v = px(flat, cx * cell, 0)[0];
    let mean = 0;
    for (let x = 0; x < cell; x++) mean += px(g, cx * cell + x, 0)[0];
    mean /= cell;
    assert.ok(Math.abs(v - mean) <= 1, `cell ${cx}: ${v} vs ${mean}`);
    for (let y = 0; y < 16; y++) for (let x = 0; x < cell; x++) assert.equal(px(flat, cx * cell + x, y)[0], v);
  }
  const bevel = applyFilter(copy(g), 'patchwork', { squareSize: 4, relief: 25 });
  // the border column facing a darker (lower) neighbour on the left is lit, the interior is the mean
  assert.ok(px(bevel, 16, 8)[0] > px(bevel, 19, 8)[0] + 3, 'left border lit');
  assert.ok(px(bevel, 23, 8)[0] < px(bevel, 19, 8)[0] - 3, 'right border in shadow');
  assert.equal(px(bevel, 19, 8)[0], px(flat, 19, 8)[0]);
});

test('stained-glass: flat cells, leading in the border colour, light from behind brightens the centre', () => {
  const out = applyFilter(photo(96, 72), 'stained-glass', { cellSize: 8, borderThickness: 3, lightIntensity: 0, borderColor: '#c81e28' });
  const leading = fraction(out, (p) => near(p, FG, 0));
  assert.ok(leading > 0.05 && leading < 0.6, `leading ${leading}`);
  const colours = new Set();
  for (let y = 0; y < 72; y++) for (let x = 0; x < 96; x++) colours.add(px(out, x, y).join());
  assert.ok(colours.size < 120, `few flat cells (${colours.size})`);
  const lit = applyFilter(grey(96, 72, 128), 'stained-glass', { cellSize: 8, borderThickness: 2, lightIntensity: 10 });
  const centre = px(lit, 48, 36), corner = px(lit, 2, 2);
  const notLeading = (p) => !near(p, [0, 0, 0], 0);
  assert.ok(!notLeading(centre) || !notLeading(corner) || centre[0] > corner[0] + 20, `${centre} ${corner}`);
  assert.ok(fraction(lit, (p) => notLeading(p) && p[0] > 140, { x: 40, y: 28, width: 16, height: 16 }) > 0.3, 'the middle glows');
});

test('texturizer: the relief follows the texture, a loaded textureImage replaces it, invert flips the shading', () => {
  const base = grey(48, 48, 128);
  const canvas = applyFilter(copy(base), 'texturizer', { texture: 'canvas', relief: 20 });
  const brick = applyFilter(copy(base), 'texturizer', { texture: 'brick', relief: 20 });
  assert.ok(meanAbsDiff(base, canvas) > 2 && !same(canvas, brick));
  assert.ok(same(applyFilter(copy(base), 'texturizer', { texture: 'canvas', relief: 0 }), base), 'relief 0 is identity');
  // a flat texture file lights nothing; a striped one shades at its stripes
  const flat = { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(255) };
  assert.ok(same(applyFilter(copy(base), 'texturizer', { texture: 'canvas', relief: 30, textureImage: flat }), base));
  const stripes = { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) };
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const v = x < 4 ? 0 : 255, i = (y * 8 + x) * 4;
    stripes.data[i] = stripes.data[i + 1] = stripes.data[i + 2] = v;
    stripes.data[i + 3] = 255;
  }
  const striped = applyFilter(copy(base), 'texturizer', { texture: 'canvas', relief: 30, lightDirection: 'left', textureImage: stripes });
  const inverted = applyFilter(copy(base), 'texturizer', { texture: 'canvas', relief: 30, lightDirection: 'left', textureImage: stripes, invert: true });
  // the step up at x = 4 (tiled every 8 px) rises to the right, so its face points left, towards the light: lit; inverted it is a drop, shaded
  assert.ok(px(striped, 4, 10)[0] > 128 && px(inverted, 4, 10)[0] < 128, `${px(striped, 4, 10)} ${px(inverted, 4, 10)}`);
  assert.equal(px(striped, 2, 10)[0], 128, 'flat parts of the texture leave the pixel alone');
  assert.equal(px(striped, 12, 10)[0], px(striped, 4, 10)[0], 'the texture tiles');
});

// ---- Distort ------------------------------------------------------------------------------------------------

test('diffuse-glow lightens the highlights only', () => {
  const img = grey(64, 32, 40);
  for (let y = 0; y < 32; y++) for (let x = 40; x < 64; x++) setPixel(img, x, y, [230, 230, 230, 1]);
  const out = applyFilter(copy(img), 'diffuse-glow', { graininess: 0, glowAmount: 10, clearAmount: 15, glowColor: '#ffffff' });
  assert.deepEqual(px(out, 5, 16), [40, 40, 40, 255], 'dark far from the highlight is untouched');
  assert.ok(px(out, 55, 16)[0] > 236, `the highlight glows (${px(out, 55, 16)})`);
  assert.ok(same(applyFilter(grey(16, 16, 128), 'diffuse-glow', { clearAmount: 15 }), grey(16, 16, 128)), 'midtones are left alone');
  const grainy = applyFilter(copy(img), 'diffuse-glow', { graininess: 10, glowAmount: 10, clearAmount: 15 });
  assert.ok(meanAbsDiff(grainy, out) > 1, 'graininess speckles the glow');
  const tinted = applyFilter(copy(img), 'diffuse-glow', { graininess: 0, glowAmount: 20, clearAmount: 10, glowColor: '#ff0000' });
  const t = px(tinted, 55, 16);
  assert.ok(t[0] > t[1] + 5, 'the glow takes the glow colour');
});

test('glass displaces by at most GLASS_PX_PER_UNIT * distortion px and distortion 0 is identity', () => {
  // red encodes the x coordinate (x / 2) against a constant green, so the R/G ratio tells where a
  // pixel was sampled from even after the glass surface sheen scales both channels
  const w = 256, h = 32;
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(img, x, y, [x >> 1, 128, 128, 1]);
  const where = (p) => (p[0] / Math.max(1, p[1])) * 256;
  for (const distortion of [2, 5, 12]) {
    for (const tex of ['frosted', 'blocks', 'canvas', 'tiny-lens']) {
      const out = applyFilter(copy(img), 'glass', { distortion, smoothness: 1, texture: tex });
      let maxShift = 0;
      for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) maxShift = Math.max(maxShift, Math.abs(where(px(out, x, y)) - x));
      assert.ok(maxShift <= GLASS_PX_PER_UNIT * distortion + 3, `${tex} at ${distortion}: shift ${maxShift}`);
      assert.ok(maxShift >= Math.min(3, distortion), `${tex} at ${distortion} moves pixels (${maxShift})`);
    }
  }
  const still = applyFilter(copy(img), 'glass', { distortion: 0 });
  let stillShift = 0;
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) stillShift = Math.max(stillShift, Math.abs(where(px(still, x, y)) - x));
  assert.ok(stillShift <= 3, `distortion 0 moves nothing (${stillShift})`);
  const smooth = applyFilter(copy(img), 'glass', { distortion: 8, smoothness: 15, texture: 'frosted' });
  const rough = applyFilter(copy(img), 'glass', { distortion: 8, smoothness: 1, texture: 'frosted' });
  assert.ok(meanAbsDiff(smooth, img) < meanAbsDiff(rough, img), 'smoothness calms the refraction');
});

test('ocean-ripple moves pixels within RIPPLE_PX_PER_UNIT * magnitude and magnitude 0 is identity', () => {
  const w = 128, h = 64;
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(img, x, y, [x, y * 3, 128, 1]);
  const out = applyFilter(copy(img), 'ocean-ripple', { rippleSize: 5, rippleMagnitude: 9 });
  assert.ok(meanAbsDiff(out, img) > 1, 'pixels move');
  let maxShift = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) maxShift = Math.max(maxShift, Math.abs(px(out, x, y)[0] - x));
  assert.ok(maxShift <= RIPPLE_PX_PER_UNIT * 9 + 1 && maxShift >= 3, `shift ${maxShift}`);
  assert.ok(same(applyFilter(copy(img), 'ocean-ripple', { rippleMagnitude: 0 }), img));
});

// ---- textures -----------------------------------------------------------------------------------------------

test('textures: deterministic, full of contrast, the brick courses are periodic, scaling changes the size', () => {
  for (const name of TEXTURE_NAMES) {
    const a = texture(name, 64, 48, { seed: 2 }), b = texture(name, 64, 48, { seed: 2 });
    assert.equal(a.length, 64 * 48);
    assert.deepEqual(a, b, `${name} deterministic`);
    let min = 255, max = 0, sum = 0;
    for (const v of a) {
      min = Math.min(min, v);
      max = Math.max(max, v);
      sum += v;
    }
    assert.ok(max - min > 60, `${name} has relief (${min}..${max})`);
    assert.ok(sum / a.length > 40 && sum / a.length < 215, `${name} mean ${sum / a.length}`);
  }
  for (const name of ['canvas', 'burlap', 'sandstone', 'frosted', 'blocks', 'brick']) {
    assert.notDeepEqual(texture(name, 32, 32, { seed: 1 }), texture(name, 32, 32, { seed: 2 }), `${name} follows the seed`);
  }
  // brick: mortar rows every 14 px at 100% (dark), every 28 px at 200%
  const brick = texture('brick', 64, 64, {});
  const rowMean = (map, w, y) => map.subarray(y * w, (y + 1) * w).reduce((s, v) => s + v, 0) / w;
  assert.ok(rowMean(brick, 64, 14) < rowMean(brick, 64, 7) - 40 && rowMean(brick, 64, 28) < rowMean(brick, 64, 21) - 40);
  const big = texture('brick', 64, 64, { scaling: 200 });
  assert.ok(rowMean(big, 64, 28) < rowMean(big, 64, 14) - 40, 'scaling 200 doubles the course height');
  // tiny lens: bumps repeat every 8 px
  const lens = texture('tiny-lens', 32, 32, {});
  for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) assert.equal(lens[(y + 8) * 32 + x + 8], lens[y * 32 + x]);
});

test('relief lights the slope facing the light, heightFromImage tiles a file, smoothHeight flattens, heightGradient slopes', () => {
  const img = grey(16, 8, 128);
  const ramp = new Uint8ClampedArray(16 * 8);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) ramp[y * 16 + x] = x * 17; // rising to the right
  const fromLeft = relief(copy(img), ramp, { relief: 25, lightDirection: 'left' });
  const fromRight = relief(copy(img), ramp, { relief: 25, lightDirection: 'right' });
  // a ramp rising to the right faces left (its normal points left): lit by a light from the left, shaded from the right
  assert.ok(px(fromLeft, 8, 4)[0] > 128 && px(fromRight, 8, 4)[0] < 128, 'the slope facing the light is lit');
  const inverted = relief(copy(img), ramp, { relief: 25, lightDirection: 'left', invert: true });
  assert.equal(inverted.data[8 * 4], fromRight.data[8 * 4]);
  const rectOnly = relief(copy(img), ramp, { relief: 25, lightDirection: 'left', rect: { x: 0, y: 0, width: 8, height: 8 } });
  assert.equal(px(rectOnly, 12, 4)[0], 128);
  assert.equal(px(rectOnly, 4, 4)[0], px(fromLeft, 4, 4)[0]);
  const tile = { width: 4, height: 2, data: new Uint8ClampedArray(4 * 2 * 4) };
  for (let i = 0; i < 8; i++) {
    tile.data[i * 4] = tile.data[i * 4 + 1] = tile.data[i * 4 + 2] = (i % 4) * 80;
    tile.data[i * 4 + 3] = 255;
  }
  const h = heightFromImage(tile, 10, 5, { scaling: 100 });
  assert.deepEqual(Array.from(h.subarray(0, 10)), [0, 80, 160, 240, 0, 80, 160, 160, 240, 0].map((v, i) => [0, 80, 160, 240][i % 4]));
  const h2 = heightFromImage(tile, 8, 2, { scaling: 200 });
  assert.deepEqual(Array.from(h2.subarray(0, 8)), [0, 0, 80, 80, 160, 160, 240, 240]);
  const noisy = texture('frosted', 32, 32, {});
  const before = noisy.reduce((s, v) => s + Math.abs(v - 128), 0);
  const smoothed = smoothHeight(Uint8ClampedArray.from(noisy), 32, 32, 3);
  assert.ok(smoothed.reduce((s, v) => s + Math.abs(v - 128), 0) < before * 0.6);
  const g = heightGradient(ramp, 16, 8, 8, 4);
  assert.ok(Math.abs(g[0] - 17 / 255) < 1e-6 && g[1] === 0);
});
