// Filter Gallery, part A (src/shared/pixels/gallery-artistic.js): the Artistic and Brush Strokes
// effects and the 'filter-gallery' composite. Every test pins down a measurable property of the
// look (not just "does not throw"): tone counts, edge darkening, stroke directions, noise levels,
// alpha handling, determinism per seed and rect-limited writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILTERS, GALLERY_GROUPS, applyFilter } from '../../src/shared/pixels/filters.js';
import { GALLERY_ARTISTIC, sampleImage } from '../../src/shared/pixels/gallery-artistic.js';
import { createImage, cloneImage, setPixel, getPixel, luminance } from '../../src/shared/pixels/core.js';
import { quadrantImage } from './helpers.mjs';

const KINDS = Object.keys(GALLERY_ARTISTIC).filter((k) => k !== 'filter-gallery');
const ARTISTIC = ['colored-pencil', 'cutout', 'dry-brush', 'film-grain', 'fresco', 'neon-glow', 'paint-daubs', 'palette-knife', 'plastic-wrap', 'poster-edges', 'rough-pastels', 'smudge-stick', 'sponge', 'underpainting', 'watercolor'];
const BRUSH = ['accented-edges', 'angled-strokes', 'crosshatch', 'dark-strokes', 'ink-outlines', 'spatter', 'sprayed-strokes', 'sumi-e'];

// ---- helpers ------------------------------------------------------------------------------------------------

const grey = (w, h, v) => createImage(w, h, [v, v, v, 1]);
/** Left half black, right half white (opaque). */
function stepImage(w = 40, h = 24) {
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(img, x, y, x < w / 2 ? [0, 0, 0, 1] : [255, 255, 255, 1]);
  return img;
}
/** White with a black square [x0, x1) x [y0, y1). */
function squareImage(w, h, x0, y0, x1, y1) {
  const img = createImage(w, h, [255, 255, 255, 1]);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) setPixel(img, x, y, [0, 0, 0, 1]);
  return img;
}
/** Deterministic colour noise around mid grey (opaque). */
function noisyImage(w = 40, h = 40, seed = 7) {
  const img = createImage(w, h);
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(img, x, y, [60 + rnd() * 140, 60 + rnd() * 140, 60 + rnd() * 140, 1]);
  return img;
}
const run = (kind, img, params = {}, rect = null) => applyFilter(cloneImage(img), kind, params, rect);
const lumaAt = (img, x, y) => {
  const p = getPixel(img, x, y);
  return Math.round(luminance(p[0], p[1], p[2]) * 100) / 100;
};
function meanLuma(img) {
  let sum = 0, n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    sum += luminance(img.data[i], img.data[i + 1], img.data[i + 2]);
    n++;
  }
  return sum / n;
}
function lumaStd(img) {
  const m = meanLuma(img);
  let v = 0, n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const L = luminance(img.data[i], img.data[i + 1], img.data[i + 2]);
    v += (L - m) * (L - m);
    n++;
  }
  return Math.sqrt(v / n);
}
function distinctPerChannel(img) {
  const sets = [new Set(), new Set(), new Set()];
  for (let i = 0; i < img.data.length; i += 4) for (let c = 0; c < 3; c++) sets[c].add(img.data[i + c]);
  return sets.map((s) => s.size);
}
function distinctColors(img) {
  const s = new Set();
  for (let i = 0; i < img.data.length; i += 4) s.add((img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2]);
  return s.size;
}
const same = (a, b) => a.data.every((v, i) => v === b.data[i]);
function maxDiff(a, b, rect = null) {
  let m = 0;
  const w = a.width;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < w; x++) {
    if (rect && (x < rect.x || y < rect.y || x >= rect.x + rect.width || y >= rect.y + rect.height)) continue;
    const i = (y * w + x) * 4;
    for (let c = 0; c < 4; c++) m = Math.max(m, Math.abs(a.data[i + c] - b.data[i + c]));
  }
  return m;
}
function alphaSame(a, b) {
  for (let i = 3; i < a.data.length; i += 4) if (a.data[i] !== b.data[i]) return false;
  return true;
}
/** Luma sum of darkening along a diagonal or axis from a point: direction (dx, dy), k = from..n (both ways). */
function darkeningAlong(img, cx, cy, dx, dy, n, from = 2) {
  let s = 0;
  for (let k = from; k <= n; k++) s += 255 - lumaAt(img, cx + dx * k, cy + dy * k) + (255 - lumaAt(img, cx - dx * k, cy - dy * k));
  return s;
}

// ---- registry -----------------------------------------------------------------------------------------------

test('every Artistic and Brush Strokes kind is a real gallery kind with fields and a margin', () => {
  assert.deepEqual(KINDS.sort(), [...ARTISTIC, ...BRUSH].sort());
  for (const k of KINDS) {
    const def = FILTERS[k];
    assert.equal(def.category, 'gallery', k);
    assert.equal(def.placeholder, undefined, `${k} is still a placeholder`);
    assert.equal(def.gallery, ARTISTIC.includes(k) ? 'Artistic' : 'Brush Strokes', k);
    assert.ok(Array.isArray(def.fields) && def.fields.length > 0, `${k} has fields`);
    for (const f of def.fields) assert.ok(f.key in def.defaults, `${k} field ${f.key} is a parameter`);
    const m = typeof def.margin === 'function' ? def.margin(def.defaults) : def.margin;
    assert.ok(Number.isFinite(m) && m >= 0, `${k} margin ${m}`);
  }
  const groups = Object.fromEntries(GALLERY_GROUPS.map((g) => [g.name, g.kinds]));
  assert.deepEqual([...groups.Artistic], [...ARTISTIC].sort());
  assert.deepEqual([...groups['Brush Strokes']], [...BRUSH].sort());
  const fg = FILTERS['filter-gallery'];
  assert.equal(fg.category, 'special');
  assert.equal(fg.ui, 'custom');
  assert.deepEqual(fg.defaults, { effects: [] });
});

test('every kind keeps alpha where pixels do not move, leaves transparent pixels transparent and changes something', () => {
  const src = quadrantImage(24);
  const moving = new Set(['spatter', 'sprayed-strokes', 'angled-strokes']);
  for (const k of KINDS) {
    const out = run(k, src, { seed: 3 });
    assert.ok(!same(src, out), `${k} changes the quadrant image`);
    if (moving.has(k)) continue;
    assert.ok(alphaSame(src, out), `${k} alpha`);
    // the transparent 1px border never gains colour or coverage
    for (let x = 0; x < 24; x++) {
      assert.equal(out.data[x * 4 + 3], 0, `${k} top border alpha`);
      assert.equal(out.data[((23 * 24) + x) * 4 + 3], 0, `${k} bottom border alpha`);
    }
  }
  // opaque images stay opaque for the kinds that move pixels
  const opaque = sampleImage(40, 30);
  for (const k of moving) {
    const out = run(k, opaque);
    for (let i = 3; i < out.data.length; i += 4) assert.equal(out.data[i], 255, `${k} opaque`);
  }
});

test('seeded kinds are deterministic per seed and differ between seeds', () => {
  for (const k of ['film-grain', 'sponge', 'spatter', 'sprayed-strokes']) {
    // a flat tone shows no displacement, so the kinds that move pixels get the sample landscape
    const src = k === 'spatter' || k === 'sprayed-strokes' ? sampleImage(32, 32) : grey(32, 32, 160);
    const a = run(k, src, { seed: 5 });
    const b = run(k, src, { seed: 5 });
    const c = run(k, src, { seed: 6 });
    assert.ok(same(a, b), `${k} same seed`);
    assert.ok(!same(a, c), `${k} other seed`);
  }
});

test('rect limits writes to the rect and the inside matches a whole-image run', () => {
  const src = sampleImage(64, 48);
  const rect = { x: 20, y: 12, width: 24, height: 20 };
  for (const k of KINDS) {
    const full = run(k, src, { seed: 2 });
    const part = run(k, src, { seed: 2 }, rect);
    // outside: untouched
    for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) {
      if (x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height) continue;
      const i = (y * 64 + x) * 4;
      for (let c = 0; c < 4; c++) assert.equal(part.data[i + c], src.data[i + c], `${k} outside (${x},${y})`);
    }
    // inside: the kind's margin covers its support (box-approximated blurs round a little)
    assert.ok(maxDiff(full, part, rect) <= 4, `${k} inside differs by ${maxDiff(full, part, rect)}`);
  }
});

test('filter-gallery runs its effect stack in order, skipping disabled, unknown and placeholder entries', () => {
  const src = sampleImage(40, 30);
  assert.ok(same(run('filter-gallery', src, {}), src), 'empty stack is identity');
  assert.ok(same(run('filter-gallery', src, { effects: [{ kind: 'no-such-kind' }, { kind: 'gaussian-blur', params: { radius: 5 } }] }), src), 'non-gallery and unknown kinds are skipped');
  const a = run('filter-gallery', src, { effects: [{ kind: 'poster-edges', params: {} }, { kind: 'film-grain', params: { grain: 6 } }] });
  const b = run('filter-gallery', src, { effects: [{ kind: 'film-grain', params: { grain: 6 } }, { kind: 'poster-edges', params: {} }] });
  assert.ok(!same(a, b), 'order matters');
  const manual = run('film-grain', run('poster-edges', src), { grain: 6 });
  assert.ok(same(a, manual), 'the stack equals running the kinds one after the other');
  const off = run('filter-gallery', src, { effects: [{ kind: 'poster-edges', params: {} }, { kind: 'film-grain', params: { grain: 6 }, enabled: false }] });
  assert.ok(same(off, run('poster-edges', src)), 'a disabled entry is skipped');
});

test('sampleImage is an opaque 80x60 landscape with sky and a red house', () => {
  const img = sampleImage();
  assert.equal(img.width, 80);
  assert.equal(img.height, 60);
  for (let i = 3; i < img.data.length; i += 4) assert.equal(img.data[i], 255);
  const sky = getPixel(img, 5, 5), house = getPixel(img, 20, 42);
  assert.ok(sky[2] > sky[0] && sky[2] > sky[1], 'sky is blue');
  assert.ok(house[0] > 150 && house[1] < 80, 'house is red');
});

// ---- Artistic -----------------------------------------------------------------------------------------------

test('colored-pencil: flat white becomes the paper tone, edges keep the image colour', () => {
  const paper = run('colored-pencil', grey(20, 20, 255));
  for (let i = 0; i < paper.data.length; i += 4) assert.deepEqual([paper.data[i], paper.data[i + 1], paper.data[i + 2]], [128, 128, 128]);
  const bright = run('colored-pencil', grey(20, 20, 255), { paperBrightness: 50 });
  assert.equal(bright.data[0], 255, 'paper brightness 50 is the full background colour');
  const out = run('colored-pencil', stepImage(40, 24));
  const atEdge = lumaAt(out, 19, 12), far = lumaAt(out, 36, 12);
  assert.ok(atEdge < 60, `edge pixel is drawn dark (${atEdge})`);
  assert.equal(far, 128, 'flat white far from the edge is paper');
});

test('cutout: grey tones collapse to `levels` values, hues are kept, edge simplicity smooths', () => {
  const ramp = createImage(64, 8);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 64; x++) setPixel(ramp, x, y, [x * 4, x * 4, x * 4, 1]);
  for (const levels of [2, 4, 8]) {
    const out = run('cutout', ramp, { levels, edgeSimplicity: 0 });
    for (const n of distinctPerChannel(out)) assert.ok(n <= levels, `levels ${levels}: ${n} values`);
    assert.ok(distinctPerChannel(out)[0] >= 2, 'more than one tone survives');
  }
  const colour = run('cutout', sampleImage(40, 30), { levels: 4 });
  const sky = getPixel(colour, 5, 5);
  assert.ok(sky[2] >= sky[0] && sky[2] >= sky[1], `sky stays bluish ${sky}`);
  const sharp = run('cutout', noisyImage(32, 32), { levels: 4, edgeSimplicity: 0 });
  const smooth = run('cutout', noisyImage(32, 32), { levels: 4, edgeSimplicity: 8, edgeFidelity: 1 });
  assert.ok(distinctColors(smooth) < distinctColors(sharp), 'edge simplicity merges patches');
});

test('dry-brush and fresco smooth detail; fresco darkens', () => {
  const noisy = noisyImage(40, 40);
  const dry = run('dry-brush', noisy);
  assert.ok(lumaStd(dry) < lumaStd(noisy) * 0.8, `dry brush std ${lumaStd(dry)} vs ${lumaStd(noisy)}`);
  const flat = run('dry-brush', grey(24, 24, 150));
  assert.ok(maxDiff(flat, grey(24, 24, 150)) <= 12, 'flat areas only get a light texture');
  const fr = run('fresco', noisy);
  assert.ok(lumaStd(fr) < lumaStd(noisy) * 0.8, 'fresco smooths');
  assert.ok(meanLuma(fr) < meanLuma(noisy) - 10, `fresco darkens (${meanLuma(fr)} vs ${meanLuma(noisy)})`);
});

test('film-grain: grain 0 is identity, noise grows with grain, highlights get lighter only inside the highlight area', () => {
  const flat = grey(64, 64, 128);
  assert.ok(same(run('film-grain', flat, { grain: 0 }), flat));
  const g4 = lumaStd(run('film-grain', flat, { grain: 4 })), g8 = lumaStd(run('film-grain', flat, { grain: 8 }));
  assert.ok(Math.abs(g4 - 10) < 1.5, `grain 4 ≈ 10 levels of noise (${g4})`);
  assert.ok(Math.abs(g8 - 20) < 2.5, `grain 8 ≈ 20 levels (${g8})`);
  const hi = run('film-grain', grey(16, 16, 240), { grain: 0, highlightArea: 20, intensity: 10 });
  assert.ok(meanLuma(hi) > 245, `highlights lighten (${meanLuma(hi)})`);
  const lo = run('film-grain', grey(16, 16, 50), { grain: 0, highlightArea: 20, intensity: 10 });
  assert.ok(same(lo, grey(16, 16, 50)), 'shadows are left alone');
});

test('neon-glow: brightness 0 maps luma onto the two colours, the glow colour tints the band', () => {
  const ramp = createImage(32, 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 32; x++) setPixel(ramp, x, y, [x * 8, x * 8, x * 8, 1]);
  const mono = run('neon-glow', ramp, { glowBrightness: 0 });
  for (let x = 1; x < 31; x++) {
    const p = getPixel(mono, x, 2), q = getPixel(mono, x + 1, 2);
    assert.equal(p[0], p[1]);
    assert.equal(p[1], p[2]);
    assert.ok(q[0] >= p[0], 'monotone in luma');
  }
  const glow = run('neon-glow', grey(8, 8, 128), { glowSize: 0, glowBrightness: 50, glowColor: '#0000ff' });
  const p = getPixel(glow, 4, 4);
  assert.ok(p[2] > p[0] + 60, `mid grey takes the blue glow ${p}`);
  const none = run('neon-glow', grey(8, 8, 128), { glowSize: 0, glowBrightness: 0, glowColor: '#0000ff' });
  assert.deepEqual(getPixel(none, 4, 4).slice(0, 3), [128, 128, 128]);
});

test('paint-daubs: brush size smooths, sharpness restores edge contrast, sparkle adds bright specks', () => {
  const noisy = noisyImage(40, 40);
  const soft = run('paint-daubs', noisy, { brushSize: 8, sharpness: 0 });
  assert.ok(lumaStd(soft) < lumaStd(noisy) * 0.8, 'daubs smooth noise');
  // sharpening the daubs brings local contrast back: the spread of the smoothed noise grows
  const dull = run('paint-daubs', noisy, { brushSize: 4, sharpness: 0 }), crisp = run('paint-daubs', noisy, { brushSize: 4, sharpness: 40 });
  assert.ok(lumaStd(crisp) > lumaStd(dull) * 1.1, `sharpness adds contrast (${lumaStd(crisp)} vs ${lumaStd(dull)})`);
  const sparkle = run('paint-daubs', grey(40, 40, 100), { brushSize: 2, sharpness: 0, brushType: 'sparkle' });
  let specks = 0;
  for (let i = 0; i < sparkle.data.length; i += 4) if (sparkle.data[i] > 150) specks++;
  assert.ok(specks > 5 && specks < 200, `sparkle specks ${specks}`);
});

test('palette-knife: flattens colour and softness smooths the result', () => {
  const noisy = noisyImage(40, 40);
  const knife = run('palette-knife', noisy, { strokeSize: 25, strokeDetail: 3, softness: 0 });
  assert.ok(lumaStd(knife) < lumaStd(noisy) * 0.7, `flatter tones (${lumaStd(knife)} vs ${lumaStd(noisy)})`);
  assert.ok(distinctColors(knife) < distinctColors(noisy), 'fewer colours');
  const hard = run('palette-knife', stepImage(40, 20), { strokeSize: 10, softness: 0 }), soft = run('palette-knife', stepImage(40, 20), { strokeSize: 10, softness: 10 });
  const slope = (img) => lumaAt(img, 21, 10) - lumaAt(img, 18, 10);
  assert.ok(slope(soft) < slope(hard), `softness blurs the edge (${slope(soft)} vs ${slope(hard)})`);
});

test('plastic-wrap: flat areas are untouched, edges get specular highlights', () => {
  const flat = grey(24, 24, 90);
  assert.ok(same(run('plastic-wrap', flat), flat));
  const src = squareImage(40, 40, 12, 12, 28, 28);
  const out = run('plastic-wrap', src, { highlightStrength: 20 });
  let brighter = 0;
  for (let i = 0; i < out.data.length; i += 4) if (out.data[i] > src.data[i]) brighter++;
  assert.ok(brighter > 20, `highlight pixels ${brighter}`);
  for (let i = 0; i < out.data.length; i += 4) assert.ok(out.data[i] >= src.data[i], 'never darkens');
});

test('poster-edges: posterizes to posterization + 2 levels and darkens the edges', () => {
  const ramp = createImage(64, 8);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 64; x++) setPixel(ramp, x, y, [x * 4, x * 4, x * 4, 1]);
  const flat = run('poster-edges', grey(16, 16, 200), { posterization: 2 });
  assert.equal(distinctPerChannel(flat)[0], 1);
  const src = stepImage(40, 20);
  const out = run('poster-edges', src, { edgeThickness: 2, edgeIntensity: 5, posterization: 2 });
  assert.ok(lumaAt(out, 20, 10) < 80, `edge pixel is dark (${lumaAt(out, 20, 10)})`);
  assert.equal(lumaAt(out, 36, 10), 255, 'flat white stays white');
  const weak = run('poster-edges', src, { edgeThickness: 2, edgeIntensity: 0, posterization: 2 });
  assert.ok(lumaAt(weak, 20, 10) > lumaAt(out, 20, 10), 'edge intensity deepens the line');
  const thick = run('poster-edges', src, { edgeThickness: 10, edgeIntensity: 5, posterization: 2 });
  assert.ok(lumaAt(thick, 25, 10) < lumaAt(out, 25, 10), 'thickness widens the line');
});

test('rough-pastels: no strokes and no relief is identity, relief textures flat areas, a texture image tiles', () => {
  const flat = grey(32, 32, 150);
  assert.ok(same(run('rough-pastels', flat, { strokeLength: 0, relief: 0 }), flat));
  const tex = run('rough-pastels', flat, { strokeLength: 0, relief: 20, texture: 'canvas' });
  assert.ok(lumaStd(tex) > 2, `canvas relief shows (${lumaStd(tex)})`);
  assert.ok(Math.abs(meanLuma(tex) - 150) < 10, 'relief lighting keeps the mean tone');
  const checker = createImage(2, 2);
  setPixel(checker, 0, 0, [255, 255, 255, 1]);
  setPixel(checker, 1, 1, [255, 255, 255, 1]);
  setPixel(checker, 1, 0, [0, 0, 0, 1]);
  setPixel(checker, 0, 1, [0, 0, 0, 1]);
  const tiled = run('rough-pastels', flat, { strokeLength: 0, relief: 30, textureImage: checker, scaling: 100 });
  // a 2x2 texture gives a result that repeats every 2 px
  assert.ok(!same(tiled, flat));
  for (let y = 4; y < 28; y++) for (let x = 4; x < 28; x++) assert.equal(lumaAt(tiled, x, y), lumaAt(tiled, x + 2, y), `period at ${x},${y}`);
  const strokes = run('rough-pastels', squareImage(40, 40, 15, 15, 25, 25), { strokeLength: 20, relief: 0, strokeDetail: 1 });
  assert.ok(lumaAt(strokes, 20, 20) > 0, 'strokes drag light into the square');
});

test('smudge-stick: dark tones smear diagonally into light neighbours, highlights lighten', () => {
  const src = squareImage(40, 40, 15, 15, 25, 25);
  const out = run('smudge-stick', src, { strokeLength: 4 });
  const d1 = darkeningAlong(out, 20, 20, 1, 1, 8) + darkeningAlong(out, 20, 20, 1, -1, 8);
  assert.ok(d1 > 0, 'the square smears along a diagonal');
  assert.equal(lumaAt(out, 2, 2), 255, 'far corners stay white');
  assert.equal(lumaAt(out, 37, 37), 255, 'far corners stay white');
  let anyDarker = false;
  for (let k = 1; k <= 6 && !anyDarker; k++) anyDarker = lumaAt(out, 25 + k, 25 + k) < 255 || lumaAt(out, 14 - k, 14 - k) < 255 || lumaAt(out, 25 + k, 14 - k) < 255 || lumaAt(out, 14 - k, 25 + k) < 255;
  assert.ok(anyDarker, 'pixels diagonally outside the square darken');
  const hi = run('smudge-stick', grey(16, 16, 240), { strokeLength: 0, highlightArea: 20, intensity: 10 });
  assert.ok(meanLuma(hi) > 245);
});

test('sponge: definition 0 is identity, blotches darken a flat tone, smoothness softens them', () => {
  const flat = grey(48, 48, 200);
  assert.ok(same(run('sponge', flat, { definition: 0 }), flat));
  const out = run('sponge', flat, { definition: 12 });
  assert.ok(lumaStd(out) > 3, `blotches (${lumaStd(out)})`);
  for (let i = 0; i < out.data.length; i += 4) assert.ok(out.data[i] <= 200, 'only darkens');
  const strong = run('sponge', flat, { definition: 25 });
  assert.ok(lumaStd(strong) > lumaStd(out), 'definition deepens the blotches');
});

test('underpainting: blurs the edge and textures by coverage', () => {
  const flat = grey(32, 32, 150);
  assert.ok(same(run('underpainting', flat, { textureCoverage: 0 }), flat), 'coverage 0 hides the texture');
  const tex = run('underpainting', flat, { textureCoverage: 40, relief: 10 });
  assert.ok(lumaStd(tex) > 1, `texture shows (${lumaStd(tex)})`);
  const edge = run('underpainting', stepImage(40, 20), { brushSize: 20, textureCoverage: 0 });
  assert.ok(lumaAt(edge, 18, 10) > 10 && lumaAt(edge, 21, 10) < 245, 'the edge is softened');
});

test('watercolor: smooths washes, pools dark pigment along edges, never brightens overall', () => {
  const noisy = noisyImage(40, 40);
  const out = run('watercolor', noisy);
  assert.ok(lumaStd(out) < lumaStd(noisy) * 0.8, 'washes are smooth');
  assert.ok(meanLuma(out) <= meanLuma(noisy) + 0.5, 'no brightening');
  const edge = run('watercolor', stepImage(40, 20), { shadowIntensity: 10 });
  assert.ok(lumaAt(edge, 21, 10) < 200, `pigment pools at the edge (${lumaAt(edge, 21, 10)})`);
  assert.ok(lumaAt(edge, 36, 10) >= 250, 'the paper texture only mottles flat white a little');
});

// ---- Brush Strokes ------------------------------------------------------------------------------------------

test('accented-edges: low brightness inks the edges, high brightness chalks them, the middle is identity', () => {
  const src = stepImage(40, 20);
  const dark = run('accented-edges', src, { edgeBrightness: 0 }), light = run('accented-edges', src, { edgeBrightness: 50 });
  assert.ok(lumaAt(dark, 21, 10) < 128, `ink (${lumaAt(dark, 21, 10)})`);
  assert.ok(lumaAt(light, 18, 10) > 128, `chalk (${lumaAt(light, 18, 10)})`);
  assert.ok(same(run('accented-edges', src, { edgeBrightness: 25 }), src));
  assert.equal(lumaAt(dark, 36, 10), 255, 'flat areas untouched');
});

test('angled-strokes: strokes run along one diagonal for light tones and the other for dark tones', () => {
  const src = squareImage(41, 41, 19, 19, 22, 22);
  const a = run('angled-strokes', src, { directionBalance: 100, strokeLength: 12, sharpness: 0 });
  const b = run('angled-strokes', src, { directionBalance: 0, strokeLength: 12, sharpness: 0 });
  const d1 = (img) => darkeningAlong(img, 20, 20, 1, -1, 8), d2 = (img) => darkeningAlong(img, 20, 20, 1, 1, 8);
  const axis = (img) => darkeningAlong(img, 20, 20, 1, 0, 8) + darkeningAlong(img, 20, 20, 0, 1, 8);
  assert.ok(d1(a) > 100 || d2(a) > 100, 'balance 100 smears along a diagonal');
  const aDiag = d1(a) > d2(a) ? 1 : 2, bDiag = d1(b) > d2(b) ? 1 : 2;
  assert.notEqual(aDiag, bDiag, 'balance 0 uses the other diagonal');
  assert.ok(Math.max(d1(a), d2(a)) > 5 * Math.min(d1(a), d2(a)), `one diagonal dominates (${d1(a)} vs ${d2(a)})`);
  assert.ok(axis(a) < 0.4 * Math.max(d1(a), d2(a)), `little smear along the axes (${axis(a)} vs ${Math.max(d1(a), d2(a))})`);
});

test('crosshatch: diagonal strokes darken around edges, flat areas are untouched', () => {
  const flat = grey(24, 24, 180);
  assert.ok(same(run('crosshatch', flat), flat));
  const src = squareImage(50, 50, 20, 20, 30, 30);
  const out = run('crosshatch', src, { strokeLength: 9, sharpness: 0, strength: 2 });
  assert.ok(lumaAt(out, 33, 17) < 250, `strokes reach diagonally from the corner (${lumaAt(out, 33, 17)})`);
  assert.equal(lumaAt(out, 45, 5), 255, 'far pixels are untouched');
  assert.equal(lumaAt(out, 25, 2), 255, 'far pixels are untouched');
});

test('dark-strokes: intensities 0 is identity, darks get darker and lights lighter around the balance', () => {
  const src = sampleImage(40, 30);
  assert.ok(same(run('dark-strokes', src, { blackIntensity: 0, whiteIntensity: 0 }), src));
  const out = run('dark-strokes', src, { balance: 5, blackIntensity: 10, whiteIntensity: 10 });
  let darker = 0, lighter = 0;
  for (let i = 0; i < src.data.length; i += 4) {
    const L0 = luminance(src.data[i], src.data[i + 1], src.data[i + 2]), L1 = luminance(out.data[i], out.data[i + 1], out.data[i + 2]);
    if (L0 < 100 && L1 < L0 - 2) darker++;
    if (L0 > 160 && L1 > L0 + 2) lighter++;
  }
  assert.ok(darker > 20, `shadows deepen (${darker})`);
  assert.ok(lighter > 20, `highlights lift (${lighter})`);
});

test('ink-outlines: edges get dark ink lines, flat areas lighten by the light intensity', () => {
  const flat = grey(20, 20, 120);
  assert.ok(same(run('ink-outlines', flat, { lightIntensity: 0 }), flat));
  const lit = run('ink-outlines', flat, { lightIntensity: 50 });
  assert.ok(lumaAt(lit, 10, 10) > 140, `flat tone lifts (${lumaAt(lit, 10, 10)})`);
  const out = run('ink-outlines', stepImage(40, 20), { strokeLength: 4, darkIntensity: 50, lightIntensity: 0 });
  assert.ok(lumaAt(out, 21, 10) < 100, `ink at the edge (${lumaAt(out, 21, 10)})`);
  assert.equal(lumaAt(out, 36, 10), 255);
});

test('spatter: radius 0 is identity, pixels move at most the spray radius', () => {
  const src = stepImage(60, 30);
  assert.ok(same(run('spatter', src, { sprayRadius: 0 }), src));
  const out = run('spatter', src, { sprayRadius: 10, smoothness: 5 });
  let changedNear = 0;
  for (let y = 0; y < 30; y++) for (let x = 0; x < 60; x++) {
    const d = lumaAt(out, x, y) !== lumaAt(src, x, y);
    if (Math.abs(x - 30) > 11) assert.ok(!d, `far pixel (${x},${y}) moved`);
    else if (d) changedNear++;
  }
  assert.ok(changedNear > 40, `edge pixels scatter (${changedNear})`);
  for (let i = 3; i < out.data.length; i += 4) assert.equal(out.data[i], 255);
});

test('sprayed-strokes: strokes follow the chosen direction', () => {
  const src = squareImage(41, 41, 19, 19, 22, 22);
  const h = run('sprayed-strokes', src, { sprayRadius: 0, strokeLength: 10, strokeDirection: 'horizontal' });
  const v = run('sprayed-strokes', src, { sprayRadius: 0, strokeLength: 10, strokeDirection: 'vertical' });
  assert.ok(darkeningAlong(h, 20, 20, 1, 0, 6) > 100 && darkeningAlong(h, 20, 20, 0, 1, 6) < 10, 'horizontal smears the row only');
  assert.ok(darkeningAlong(v, 20, 20, 0, 1, 6) > 100 && darkeningAlong(v, 20, 20, 1, 0, 6) < 10, 'vertical smears the column only');
  const sprayed = run('sprayed-strokes', stepImage(60, 30), { sprayRadius: 8, strokeLength: 0 });
  assert.ok(!same(sprayed, stepImage(60, 30)), 'the spray scatters');
});

test('sumi-e: ink bleeds outwards from dark strokes, paper stays white, contrast rises', () => {
  const src = squareImage(40, 40, 15, 15, 25, 25);
  const out = run('sumi-e', src, { strokeWidth: 12, strokePressure: 2, contrast: 16 });
  assert.ok(lumaAt(out, 26, 20) < 200, `ink bleeds past the edge (${lumaAt(out, 26, 20)})`);
  assert.equal(lumaAt(out, 3, 3), 255, 'paper stays white');
  const soft = noisyImage(40, 40);
  assert.ok(lumaStd(run('sumi-e', soft, { contrast: 40 })) > lumaStd(run('sumi-e', soft, { contrast: 0 })), 'contrast parameter adds contrast');
});
