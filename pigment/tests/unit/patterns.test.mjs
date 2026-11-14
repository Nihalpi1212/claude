// patterns (0.4 package 10): scripted pattern placement (deterministic per seed, the geometry of each script), the
// recolouring of copies and the built-in patterns (seamless, deterministic).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCRIPTS, scriptPlacements, recolorTile, symmetryOps, MAX_COPIES } from '../../src/renderer/lib/scripted-patterns.js';
import { BUILTIN_PATTERNS, builtinPattern, patternBuiltins } from '../../src/renderer/lib/pattern-builtins.js';

const AREA = { x: 10, y: 20, width: 300, height: 200 };
const TILE = { width: 20, height: 10 };
const opts = (id, extra = {}) => ({ area: AREA, tile: TILE, options: { seed: 42, colorRandom: 50, brightRandom: 50, ...extra }, paths: [{ closed: false, points: [[0, 100], [400, 100]] }] });

test('every script places the same copies for the same seed, and others for another seed', () => {
  for (const s of SCRIPTS) {
    const a = scriptPlacements(s.id, opts(s.id));
    const b = scriptPlacements(s.id, opts(s.id));
    assert.ok(a.length > 0, `${s.id} places copies`);
    assert.deepEqual(a, b, `${s.id} is deterministic`);
    const c = scriptPlacements(s.id, opts(s.id, { seed: 43 }));
    // the colour variation always depends on the seed; Random Fill's positions too
    assert.notDeepEqual(a.map((p) => [p.hue, p.bright]), c.map((p) => [p.hue, p.bright]), `${s.id} varies with the seed`);
    for (const p of a) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.angle) && p.scale > 0, `${s.id} gives finite copies`);
      assert.ok(Math.abs(p.hue) <= 90 + 1e-9 && Math.abs(p.bright) <= 0.375 + 1e-9, `${s.id} keeps the randomness in range`);
    }
  }
  const r1 = scriptPlacements('random-fill', opts('random-fill'));
  const r2 = scriptPlacements('random-fill', opts('random-fill', { seed: 7 }));
  assert.notDeepEqual(r1.map((p) => [p.x, p.y]), r2.map((p) => [p.x, p.y]));
});

test('without randomness the copies keep their colours; changing one slider does not reshuffle the positions', () => {
  const plain = scriptPlacements('random-fill', { area: AREA, tile: TILE, options: { seed: 5, colorRandom: 0, brightRandom: 0 } });
  assert.ok(plain.every((p) => p.hue === 0 && p.bright === 0));
  const tinted = scriptPlacements('random-fill', { area: AREA, tile: TILE, options: { seed: 5, colorRandom: 80, brightRandom: 0 } });
  assert.deepEqual(plain.map((p) => [p.x, p.y, p.scale, p.angle]), tinted.map((p) => [p.x, p.y, p.scale, p.angle]));
});

test('Brick Fill: rows one tile apart, odd rows offset by the offset fraction, the area covered', () => {
  const ps = scriptPlacements('brick-fill', { area: { x: 0, y: 0, width: 100, height: 40 }, tile: TILE, options: { seed: 1, offset: 50, spacing: 0 } });
  const rows = [...new Set(ps.map((p) => p.y))].sort((a, b) => a - b);
  assert.deepEqual(rows, [5, 15, 25, 35]);
  const xsOf = (y) => ps.filter((p) => p.y === y).map((p) => p.x).sort((a, b) => a - b);
  assert.deepEqual(xsOf(5).slice(0, 3), [10, 30, 50]);
  assert.deepEqual(xsOf(15).slice(0, 3), [0, 20, 40]); // half a brick to the left
  // the copies cover the area: every column centre within half a tile of a copy
  for (const y of rows) assert.ok(Math.min(...xsOf(y)) - 10 <= 0 && Math.max(...xsOf(y)) + 10 >= 100);
  // spacing and scale grow the step
  const wide = scriptPlacements('brick-fill', { area: { x: 0, y: 0, width: 100, height: 10 }, tile: TILE, options: { seed: 1, spacing: 10, scale: 200 } });
  const xs = wide.filter((p) => p.y === wide[0].y).map((p) => p.x);
  assert.equal(xs[1] - xs[0], 50);
  assert.ok(wide.every((p) => p.scale === 2));
});

test('Cross Weave turns every other copy a quarter, like a checkerboard', () => {
  const ps = scriptPlacements('cross-weave', { area: { x: 0, y: 0, width: 80, height: 80 }, tile: { width: 20, height: 20 }, options: { seed: 1 } });
  assert.equal(ps.length, 16);
  for (const p of ps) {
    const i = Math.round((p.x - 10) / 20), j = Math.round((p.y - 10) / 20);
    assert.equal(p.angle, (i + j) % 2 ? 90 : 0);
  }
});

test('Random Fill: the density sets the count, scales stay in range, positions inside the area', () => {
  const area = { x: 0, y: 0, width: 200, height: 100 };
  const ps = scriptPlacements('random-fill', { area, tile: TILE, options: { seed: 3, density: 2, minScale: 50, maxScale: 150, rotate: false } });
  assert.equal(ps.length, Math.round((2 * 200 * 100) / (20 * 10 * 1)));
  assert.ok(ps.every((p) => p.scale >= 0.5 && p.scale <= 1.5 && p.angle === 0 && p.x >= 0 && p.x <= 200 && p.y >= 0 && p.y <= 100));
  const huge = scriptPlacements('random-fill', { area: { x: 0, y: 0, width: 1e5, height: 1e5 }, tile: { width: 1, height: 1 }, options: { seed: 3, density: 10 } });
  assert.equal(huge.length, MAX_COPIES);
});

test('Spiral: copies on an Archimedean spiral from the centre, farther with each turn', () => {
  const area = { x: 0, y: 0, width: 200, height: 200 };
  const ps = scriptPlacements('spiral', { area, tile: { width: 10, height: 10 }, options: { seed: 1 } });
  assert.ok(ps.length > 20);
  assert.deepEqual([ps[0].x, ps[0].y], [100, 100]);
  const r = ps.map((p) => Math.hypot(p.x - 100, p.y - 100));
  for (let i = 1; i < r.length; i++) assert.ok(r[i] >= r[i - 1] - 1e-9, 'the radius never shrinks');
  assert.ok(r[r.length - 1] >= 100, 'the spiral reaches the corners');
  // neighbouring copies sit about one copy apart
  for (let i = 5; i < 20; i++) {
    const d = Math.hypot(ps[i].x - ps[i - 1].x, ps[i].y - ps[i - 1].y);
    assert.ok(d > 5 && d < 15, `step ${i}: ${d}`);
  }
});

test('Place Along Path: copies along the path, turned to its direction, spacing adjusted to fit', () => {
  const paths = [{ closed: false, points: [[0, 50], [100, 50], [100, 150]] }];
  const ps = scriptPlacements('place-along-path', { area: AREA, tile: { width: 20, height: 10 }, options: { seed: 1, fit: true }, paths });
  assert.deepEqual([ps[0].x, ps[0].y], [0, 50]);
  const last = ps[ps.length - 1];
  assert.ok(Math.abs(last.x - 100) < 1e-6 && Math.abs(last.y - 150) < 1e-6, 'with Adjust spacing to fit the last copy ends on the path end');
  assert.ok(ps.filter((p) => p.y === 50 && p.x < 100).every((p) => p.angle === 0));
  assert.ok(ps.filter((p) => p.x === 100 && p.y > 50).every((p) => Math.abs(p.angle - 90) < 1e-9));
  // a distance moves the copies off the path; Alternate puts every other copy on the other side
  const off = scriptPlacements('place-along-path', { area: AREA, tile: { width: 20, height: 10 }, options: { seed: 1, distance: 10, alignment: 'alternate', fit: false }, paths: [{ closed: false, points: [[0, 0], [100, 0]] }] });
  assert.deepEqual(off.slice(0, 4).map((p) => p.y), [10, -10, 10, -10]);
  assert.deepEqual(scriptPlacements('place-along-path', { area: AREA, tile: TILE, options: {}, paths: [] }), []);
});

test('Symmetry Fill: the copies of each cell follow the group', () => {
  assert.equal(symmetryOps('rotate-90').copies.length, 4);
  assert.equal(symmetryOps('rotate-60').copies.length, 6);
  assert.equal(symmetryOps('kaleidoscope').copies.length, 8);
  const ps = scriptPlacements('symmetry-fill', { area: { x: 0, y: 0, width: 40, height: 40 }, tile: { width: 10, height: 10 }, options: { seed: 1, symmetry: 'rotate-90' } });
  // around each cell centre the four copies sit at the same distance, a quarter turn apart
  const cell = ps.slice(0, 4);
  const cx = cell.reduce((s, p) => s + p.x, 0) / 4, cy = cell.reduce((s, p) => s + p.y, 0) / 4;
  const d = cell.map((p) => Math.hypot(p.x - cx, p.y - cy));
  assert.ok(d.every((v) => Math.abs(v - d[0]) < 1e-9));
  assert.deepEqual(cell.map((p) => p.angle), [0, 90, 180, 270]);
  const mirror = scriptPlacements('symmetry-fill', { area: { x: 0, y: 0, width: 40, height: 40 }, tile: { width: 10, height: 10 }, options: { seed: 1, symmetry: 'mirror' } });
  assert.deepEqual(mirror.slice(0, 2).map((p) => p.flipX), [false, true]);
});

test('recolorTile keeps grey and alpha under a hue turn, and brightness moves towards white or black', () => {
  const tile = { width: 2, height: 1, data: new Uint8ClampedArray([128, 128, 128, 200, 255, 0, 0, 255]) };
  const turned = recolorTile(tile, 120, 0);
  assert.deepEqual(Array.from(turned.data.slice(0, 4)), [128, 128, 128, 200]);
  assert.ok(turned.data[5] > turned.data[4], 'red turns towards green');
  assert.deepEqual(Array.from(recolorTile(tile, 0, 0.5).data.slice(0, 3)), [192, 192, 192]);
  assert.deepEqual(Array.from(recolorTile(tile, 0, -0.5).data.slice(0, 3)), [64, 64, 64]);
  assert.deepEqual(Array.from(tile.data), [128, 128, 128, 200, 255, 0, 0, 255], 'the source is not changed');
});

test('built-in patterns: deterministic, opaque, the size their presets say, and seamless', () => {
  const { presets, groups } = patternBuiltins();
  assert.equal(presets.length, BUILTIN_PATTERNS.length);
  assert.ok(presets.every((p) => groups.some((g) => g.id === p.group)));
  for (const [id, , , w, h] of BUILTIN_PATTERNS) {
    const a = builtinPattern(id), b = builtinPattern(id);
    assert.equal(a.width, w);
    assert.equal(a.height, h);
    assert.deepEqual(a.data, b.data, `${id} is deterministic`);
    for (let i = 3; i < a.data.length; i += 4) assert.equal(a.data[i], 255);
    // seamless: the jump across the tile's wrap edge is no bigger than the largest jump inside the tile
    const px = (x, y, c) => a.data[(y * w + x) * 4 + c];
    let inside = 0, across = 0;
    for (let y = 0; y < h; y++) for (let c = 0; c < 3; c++) {
      for (let x = 1; x < w; x++) inside = Math.max(inside, Math.abs(px(x, y, c) - px(x - 1, y, c)));
      across = Math.max(across, Math.abs(px(0, y, c) - px(w - 1, y, c)));
    }
    for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
      for (let y = 1; y < h; y++) inside = Math.max(inside, Math.abs(px(x, y, c) - px(x, y - 1, c)));
      across = Math.max(across, Math.abs(px(x, 0, c) - px(x, h - 1, c)));
    }
    assert.ok(across <= inside, `${id} tiles without a seam (${across} > ${inside})`);
  }
  assert.equal(builtinPattern('nope'), null);
});
