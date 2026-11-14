import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  floodFill, colorRange, maskFromAlpha, maskBounds, combineMasks, invertMask, feather, expand, contract, border, smooth,
  grow, similar, outline, rasterizePolygon, rasterizeEllipse,
} from '../../src/shared/pixels/selection-ops.js';
import { createImage, setPixel } from '../../src/shared/pixels/core.js';
import { gradientImage, quadrantImage, solidImage, assertNear } from './helpers.mjs';

/** A w x h mask with the rect [x, x + sw) x [y, y + sh) set to v. */
function rectMask(w, h, x, y, sw, sh, v = 255) {
  const m = new Uint8ClampedArray(w * h);
  for (let yy = y; yy < y + sh; yy++) m.fill(v, yy * w + x, yy * w + x + sw);
  return m;
}
const count = (m, min = 1) => m.reduce((n, v) => n + (v >= min ? 1 : 0), 0);
const total = (m) => m.reduce((s, v) => s + v, 0) / 255;
const at = (m, w, x, y) => m[y * w + x];
/** Signed shoelace area (positive = clockwise on screen, y down). */
const area = (poly) => poly.reduce((s, [x, y], i) => {
  const [nx, ny] = poly[(i + 1) % poly.length];
  return s + x * ny - nx * y;
}, 0) / 2;

test('floodFill: contiguous vs global on the quadrant image', () => {
  const img = quadrantImage(16); // red quadrant = x 1..7, y 1..7 (49 px)
  setPixel(img, 12, 12, [255, 0, 0, 1]); // a lone red pixel inside the white quadrant
  const cont = floodFill(img, 3, 3, { tolerance: 0, contiguous: true });
  assert.equal(count(cont), 49);
  assert.equal(at(cont, 16, 1, 1), 255);
  assert.equal(at(cont, 16, 7, 7), 255);
  assert.equal(at(cont, 16, 8, 3), 0, 'green is not red');
  assert.equal(at(cont, 16, 12, 12), 0, 'the lone pixel is not connected');
  assert.equal(at(cont, 16, 0, 0), 0, 'transparent border is a different colour (alpha counts)');
  const all = floodFill(img, 3, 3, { tolerance: 0, contiguous: false });
  assert.equal(count(all), 50);
  assert.equal(at(all, 16, 12, 12), 255);
  // The transparent 1px frame is one 4-connected ring of 60 pixels.
  assert.equal(count(floodFill(img, 0, 0, { tolerance: 0 })), 60);
  // Everything is within 255 of everything.
  assert.equal(count(floodFill(img, 3, 3, { tolerance: 255 })), 256);
  // Full coverage only (no antialias by default).
  assert.ok(cont.every((v) => v === 0 || v === 255));
});

test('floodFill: tolerance, antialias, rect and seed outside', () => {
  const g = gradientImage(16, 4); // columns 0, 17, 34, 51, ...
  const m = floodFill(g, 0, 2, { tolerance: 40 });
  assert.equal(count(m), 12, 'columns 0..2 on 4 rows');
  assert.equal(at(m, 16, 2, 3), 255);
  assert.equal(at(m, 16, 3, 0), 0);
  assert.equal(count(floodFill(g, 0, 0, { tolerance: 16 })), 4, 'only column 0');
  const aa = floodFill(g, 0, 0, { tolerance: 40, antialias: true });
  assert.equal(at(aa, 16, 1, 0), 255, 'distance 17 is inside the solid 75%');
  assert.ok(at(aa, 16, 2, 0) > 100 && at(aa, 16, 2, 0) < 255, `soft edge ${at(aa, 16, 2, 0)}`);
  assert.equal(at(aa, 16, 3, 0), 0);
  // A rect confines the fill; a seed outside it gives nothing.
  const rect = { x: 0, y: 1, width: 2, height: 2 };
  const r = floodFill(g, 0, 1, { tolerance: 40 }, rect);
  assert.equal(count(r), 4);
  assert.equal(at(r, 16, 0, 0), 0);
  assert.equal(at(r, 16, 2, 1), 0);
  assert.equal(count(floodFill(g, 5, 0, { tolerance: 255 }, rect)), 0);
  assert.equal(count(floodFill(g, -1, 0, { tolerance: 255 })), 0);
  assert.equal(count(floodFill(g, 16, 0, { tolerance: 255 })), 0);
  // Non-contiguous honours the rect too.
  assert.equal(count(floodFill(g, 0, 1, { tolerance: 40, contiguous: false }, rect)), 4);
});

test('colorRange: soft falloff between fuzziness/2 and fuzziness, scaled by alpha', () => {
  const g = gradientImage(256, 1); // pixel x has value x
  const m = colorRange(g, [[0, 0, 0, 1]], { fuzziness: 40 });
  for (let x = 0; x <= 20; x++) assert.equal(m[x], 255, `x=${x}`);
  assert.equal(m[30], 128); // halfway down the ramp
  assertNear(m[25], 191, 1);
  for (let x = 40; x < 256; x++) assert.equal(m[x], 0, `x=${x}`);
  for (let x = 1; x < 256; x++) assert.ok(m[x] <= m[x - 1], 'monotone falloff');
  // Several colours: nearest wins; CSS strings accepted.
  const two = colorRange(g, ['#000000', [255, 255, 255, 1]], { fuzziness: 20 });
  assert.equal(two[0], 255);
  assert.equal(two[255], 255);
  assert.equal(two[128], 0);
  // Fuzziness 0 matches the exact colour only.
  const exact = colorRange(g, [[100, 100, 100]], { fuzziness: 0 });
  assert.equal(count(exact), 1);
  assert.equal(exact[100], 255);
  // Alpha scales coverage; transparent pixels are never selected.
  const img = solidImage(3, 1, [10, 20, 30, 1]);
  setPixel(img, 1, 0, [10, 20, 30, 128 / 255]);
  setPixel(img, 2, 0, [10, 20, 30, 0]);
  assert.deepEqual(Array.from(colorRange(img, [[10, 20, 30, 1]], { fuzziness: 10 })), [255, 128, 0]);
  // Rect: nothing outside is selected.
  const r = colorRange(g, [[0, 0, 0, 1]], { fuzziness: 40 }, { x: 10, y: 0, width: 5, height: 1 });
  assert.equal(count(r), 5);
  assert.equal(r[5], 0);
});

test('maskFromAlpha and maskBounds', () => {
  const img = quadrantImage(16);
  const m = maskFromAlpha(img);
  assert.equal(count(m), 14 * 14);
  assert.equal(m[0], 0);
  assert.equal(at(m, 16, 1, 1), 255);
  assert.deepEqual(maskBounds(m, 16, 16), { x: 1, y: 1, width: 14, height: 14 });
  const part = maskFromAlpha(img, { x: 4, y: 4, width: 3, height: 2 });
  assert.equal(count(part), 6);
  assert.deepEqual(maskBounds(part, 16, 16), { x: 4, y: 4, width: 3, height: 2 });

  const s = new Uint8ClampedArray(10 * 10);
  assert.equal(maskBounds(s, 10, 10), null);
  s[3 * 10 + 2] = 1; // (2, 3), any coverage counts
  s[7 * 10 + 5] = 200; // (5, 7)
  assert.deepEqual(maskBounds(s, 10, 10), { x: 2, y: 3, width: 4, height: 5 });
  assert.deepEqual(maskBounds(s, 10, 10, { x: 4, y: 0, width: 6, height: 10 }), { x: 5, y: 7, width: 1, height: 1 });
  assert.equal(maskBounds(s, 10, 10, { x: 6, y: 0, width: 4, height: 10 }), null);
});

test('combineMasks: pixel counts per mode, soft coverage, rect', () => {
  const a = rectMask(10, 10, 0, 0, 6, 6); // 36
  const b = rectMask(10, 10, 3, 3, 6, 6); // 36, overlap 3x3 = 9
  assert.equal(count(combineMasks(a, b, 'replace')), 36);
  assert.deepEqual(combineMasks(a, b, 'replace'), b);
  assert.equal(count(combineMasks(a, b, 'add')), 63);
  assert.equal(count(combineMasks(a, b, 'subtract')), 27);
  assert.equal(count(combineMasks(a, b, 'intersect')), 9);
  assert.equal(at(combineMasks(a, b, 'subtract'), 10, 4, 4), 0);
  assert.equal(at(combineMasks(a, b, 'subtract'), 10, 1, 1), 255);
  assert.throws(() => combineMasks(a, b, 'xor'), RangeError);
  // Inputs untouched.
  assert.equal(count(a), 36);
  assert.equal(count(b), 36);
  // Soft coverage: max / min.
  const sa = new Uint8ClampedArray([100, 200, 0]), sb = new Uint8ClampedArray([150, 50, 255]);
  assert.deepEqual(Array.from(combineMasks(sa, sb, 'add')), [150, 200, 255]);
  assert.deepEqual(Array.from(combineMasks(sa, sb, 'intersect')), [100, 50, 0]);
  assert.deepEqual(Array.from(combineMasks(sa, sb, 'subtract')), [100, 200, 0]);
  // Rect: only pixels inside are combined, the others keep a.
  const r = combineMasks(a, b, 'add', 10, 10, { x: 5, y: 5, width: 5, height: 5 });
  assert.equal(count(r), 36 - 1 + 16); // a outside the rect (35) + a|b inside it ([5,9)^2 = 16)
  assert.equal(at(r, 10, 8, 8), 255);
  assert.equal(at(r, 10, 8, 3), 0, 'outside the rect: a only');
});

test('invertMask (whole and rect)', () => {
  const a = rectMask(10, 10, 0, 0, 6, 6);
  const inv = invertMask(a);
  assert.equal(count(inv), 64);
  assert.equal(at(inv, 10, 9, 9), 255);
  assert.deepEqual(invertMask(inv), a);
  assert.deepEqual(Array.from(invertMask(new Uint8ClampedArray([0, 55, 255]))), [255, 200, 0]);
  const part = invertMask(a, 10, 10, { x: 0, y: 0, width: 10, height: 1 });
  assert.equal(count(part), 36 - 6 + 4);
  assert.equal(at(part, 10, 0, 1), 255, 'below the rect: copied');
  assert.equal(at(part, 10, 0, 0), 0);
});

test('feather: in place, preserves the total, softens edges like a gaussian', () => {
  const m = rectMask(64, 64, 22, 22, 20, 20);
  const ret = feather(m, 64, 64, 6);
  assert.equal(ret, m, 'works in place and returns the same array');
  assertNear(total(m), 400, 4, 'total coverage');
  assert.equal(at(m, 64, 32, 32), 255, 'centre stays selected');
  assert.equal(at(m, 64, 2, 2), 0, 'far away stays unselected');
  const inside = at(m, 64, 22, 32), outside = at(m, 64, 21, 32);
  assert.ok(inside < 255 && inside > 127, `inside edge ${inside}`);
  assert.ok(outside > 0 && outside < 128, `outside edge ${outside}`);
  assertNear(inside + outside, 255, 2, 'symmetric about the edge');
  for (let x = 14; x < 32; x++) assert.ok(at(m, 64, x, 32) >= at(m, 64, x - 1, 32), 'monotone ramp');

  // Step-edge profile against the gaussian CDF (sigma = radius / 2).
  const half = rectMask(64, 64, 32, 0, 32, 64);
  feather(half, 64, 64, 8);
  const sigma = 4;
  const erf = (x) => {
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-x * x);
    return x >= 0 ? y : -y;
  };
  for (let x = 20; x < 44; x++) {
    const expected = 255 * 0.5 * (1 + erf((x + 0.5 - 32) / (sigma * Math.SQRT2)));
    assertNear(at(half, 64, x, 32), expected, 3, `profile at x=${x}`);
  }

  // Outside the canvas counts as unselected: a full selection fades at the edges.
  const full = feather(new Uint8ClampedArray(32 * 32).fill(255), 32, 32, 4);
  assert.ok(full[0] < 128 && full[0] > 0, `corner ${full[0]}`);
  assert.equal(at(full, 32, 16, 16), 255);

  // Radius 0 leaves the mask alone; a rect limits the pixels rewritten.
  const z = rectMask(16, 16, 4, 4, 8, 8);
  assert.deepEqual(feather(new Uint8ClampedArray(z), 16, 16, 0), z);
  const part = new Uint8ClampedArray(z);
  feather(part, 16, 16, 4, { x: 0, y: 0, width: 8, height: 16 });
  for (let y = 0; y < 16; y++) for (let x = 8; x < 16; x++) assert.equal(at(part, 16, x, y), at(z, 16, x, y));
  assert.ok(at(part, 16, 4, 4) < 255 && at(part, 16, 3, 4) > 0, 'left half softened');
  // A rect gives the same values inside it as a full feather.
  const fullF = feather(new Uint8ClampedArray(z), 16, 16, 4);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) assert.equal(at(part, 16, x, y), at(fullF, 16, x, y));
});

test('expand and contract by 1: documented disc shape', () => {
  const sq = rectMask(11, 11, 4, 4, 3, 3);
  const e = expand(sq, 11, 11, 1);
  assert.notEqual(e, sq);
  assert.equal(count(e), 21, '5x5 minus its 4 corners');
  for (const [x, y] of [[3, 3], [7, 3], [3, 7], [7, 7]]) assert.equal(at(e, 11, x, y), 0, `corner ${x},${y}`);
  for (const [x, y] of [[3, 4], [5, 3], [7, 6], [5, 7]]) assert.equal(at(e, 11, x, y), 255, `edge ${x},${y}`);
  assert.equal(at(e, 11, 2, 5), 0);
  assert.equal(count(sq), 9, 'input untouched');

  const big = rectMask(11, 11, 3, 3, 5, 5);
  const c = contract(big, 11, 11, 1);
  assert.equal(count(c), 9);
  assert.deepEqual(maskBounds(c, 11, 11), { x: 4, y: 4, width: 3, height: 3 });
  assert.deepEqual(contract(expand(sq, 11, 11, 1), 11, 11, 1), sq, 'closing a square gives the square back');

  // Disc of radius 2 around one pixel: dx^2 + dy^2 <= 4 -> 13 pixels; same shape on the soft path.
  const dot = new Uint8ClampedArray(81);
  dot[40] = 255;
  assert.equal(count(expand(dot, 9, 9, 2)), 13);
  const softDot = new Uint8ClampedArray(81);
  softDot[40] = 200;
  const sd = expand(softDot, 9, 9, 2);
  assert.equal(count(sd), 13);
  assert.ok(sd.every((v) => v === 0 || v === 200), 'max filter keeps the coverage level');
  // Radius 1.5 includes the diagonals (2 <= 2.25): a full 3x3.
  assert.equal(count(expand(dot, 9, 9, 1.5)), 9);
  // Less than 1 px is a copy.
  assert.deepEqual(expand(sq, 11, 11, 0.5), sq);
  assert.deepEqual(contract(sq, 11, 11, 0), sq);
});

test('expand/contract: soft edges, canvas bounds, rect, binary vs soft paths agree', () => {
  // Contracting a full selection keeps it full (edge pixels replicated).
  const full = new Uint8ClampedArray(100).fill(255);
  assert.equal(count(contract(full, 10, 10, 3), 255), 100);
  // A soft edge moves outward unchanged.
  const soft = new Uint8ClampedArray(10);
  soft.set([0, 0, 0, 0, 100, 255, 255, 255, 255, 255]);
  assert.deepEqual(Array.from(expand(soft, 10, 1, 2)), [0, 0, 100, 255, 255, 255, 255, 255, 255, 255]);
  assert.deepEqual(Array.from(contract(soft, 10, 1, 2)), [0, 0, 0, 0, 0, 0, 100, 255, 255, 255]);
  // Rect: only pixels inside it change.
  const sq = rectMask(11, 11, 4, 4, 3, 3);
  const er = expand(sq, 11, 11, 1, { x: 0, y: 0, width: 11, height: 5 });
  assert.equal(count(er), 9 + 3 + 2, 'top row grows (3) and the sides of row 4 (2)');
  assert.equal(at(er, 11, 5, 7), 0, 'below the rect: unchanged');
  // The binary (distance transform) path and the soft (max filter) path give the same shape.
  const w = 40, h = 30;
  const bin = new Uint8ClampedArray(w * h);
  let seed = 12345;
  for (let i = 0; i < bin.length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    if (seed % 23 === 0) bin[i] = 255;
  }
  const grey = bin.map((v) => (v ? 200 : 0));
  for (const r of [1, 2, 3.5, 6]) {
    const eb = expand(bin, w, h, r), eg = expand(grey, w, h, r);
    for (let i = 0; i < eb.length; i++) assert.equal(eg[i], eb[i] ? 200 : 0, `expand r=${r} at ${i}`);
    const cb = contract(invertMask(bin), w, h, r), cg = contract(invertMask(grey), w, h, r);
    for (let i = 0; i < cb.length; i++) assert.equal(cg[i], cb[i] === 255 ? 255 : 55, `contract r=${r} at ${i}`);
  }
});

test('border: band straddling the edge', () => {
  const sq = rectMask(15, 15, 5, 5, 5, 5);
  const b2 = border(sq, 15, 15, 2); // expand 1 (45 px) minus contract 1 (9 px)
  assert.equal(count(b2), 36);
  assert.equal(at(b2, 15, 5, 5), 255, 'old corner is on the band');
  assert.equal(at(b2, 15, 4, 6), 255, 'just outside');
  assert.equal(at(b2, 15, 7, 7), 0, 'centre is not');
  assert.equal(at(b2, 15, 4, 4), 0, 'disc corners are cut');
  const b1 = border(sq, 15, 15, 1); // the 1px ring just outside
  assert.equal(count(b1), 45 - 25);
  assert.equal(at(b1, 15, 5, 5), 0);
  assert.equal(count(border(sq, 15, 15, 0)), 0);
  // Soft coverage is the difference of the two.
  const soft = rectMask(15, 15, 5, 5, 5, 5, 128);
  assert.ok(border(soft, 15, 15, 2).every((v) => v === 0 || v === 128));
});

test('smooth: removes specks and holes, keeps straight edges', () => {
  const m = rectMask(30, 30, 5, 5, 20, 20);
  m[2 * 30 + 2] = 255; // stray pixel
  m[15 * 30 + 15] = 0; // pin hole
  const s = smooth(m, 30, 30, 2);
  assert.equal(at(s, 30, 2, 2), 0, 'speck gone');
  assert.equal(at(s, 30, 15, 15), 255, 'hole filled');
  for (let y = 8; y < 22; y++) {
    assert.equal(at(s, 30, 5, y), 255, 'edge pixel kept');
    assert.equal(at(s, 30, 4, y), 0, 'outside stays out');
  }
  assert.equal(at(s, 30, 5, 5), 0, 'corners round off');
  assert.equal(at(s, 30, 6, 6), 255);
  assert.equal(count(m), 400, 'input untouched');
  assert.deepEqual(smooth(m, 30, 30, 0), m);
  // Rect: outside is copied.
  const r = smooth(m, 30, 30, 2, { x: 10, y: 10, width: 10, height: 10 });
  assert.equal(at(r, 30, 2, 2), 255);
  assert.equal(at(r, 30, 15, 15), 255);
});

test('grow and similar', () => {
  const img = quadrantImage(16);
  setPixel(img, 12, 12, [255, 0, 0, 1]);
  setPixel(img, 4, 4, [250, 6, 2, 1]); // near-red inside the red quadrant
  const seed = new Uint8ClampedArray(256);
  seed[3 * 16 + 3] = 255;
  const g = grow(img, seed, { tolerance: 8 });
  assert.equal(count(g), 49, 'the red quadrant (including the near-red pixel)');
  assert.equal(at(g, 16, 12, 12), 0, 'not connected');
  assert.equal(count(grow(img, seed, { tolerance: 0 })), 48, 'near-red is beyond tolerance 0');
  const s = similar(img, seed, { tolerance: 8 });
  assert.equal(count(s), 50);
  assert.equal(at(s, 16, 12, 12), 255);
  assert.equal(count(seed), 1, 'input untouched');
  assert.equal(count(grow(img, new Uint8ClampedArray(256))), 0, 'empty selection stays empty');
});

test('outline: square, ring, diagonal pixels, canvas edge', () => {
  assert.deepEqual(outline(rectMask(4, 4, 1, 1, 2, 2), 4, 4), [[[1, 1], [3, 1], [3, 3], [1, 3]]]);
  // Ring: an outer loop (clockwise) and a hole (counter-clockwise).
  const ring = rectMask(7, 7, 1, 1, 5, 5);
  ring[3 * 7 + 3] = 0;
  const loops = outline(ring, 7, 7);
  assert.equal(loops.length, 2);
  const areas = loops.map(area).sort((p, q) => q - p);
  assert.deepEqual(areas, [25, -1]);
  assert.equal(areas[0] + areas[1], count(ring), 'signed areas add up to the pixel count');
  // Diagonal neighbours are separate loops (4-connectivity).
  const diag = new Uint8ClampedArray(9);
  diag[0] = diag[4] = 255;
  assert.equal(outline(diag, 3, 3).length, 2);
  // A selection touching the canvas closes along the edge.
  assert.deepEqual(outline(new Uint8ClampedArray(6).fill(255), 3, 2), [[[0, 0], [3, 0], [3, 2], [0, 2]]]);
  // Threshold.
  const soft = new Uint8ClampedArray([0, 100, 200, 0]);
  assert.equal(outline(soft, 4, 1).length, 1);
  assert.deepEqual(outline(soft, 4, 1)[0], [[2, 0], [3, 0], [3, 1], [2, 1]]);
  assert.deepEqual(outline(soft, 4, 1, 50)[0], [[1, 0], [3, 0], [3, 1], [1, 1]]);
  assert.deepEqual(outline(new Uint8ClampedArray(16), 4, 4), []);
  // Rect: pixels outside count as unselected.
  assert.deepEqual(outline(new Uint8ClampedArray(16).fill(255), 4, 4, 128, { x: 1, y: 1, width: 2, height: 1 }), [[[1, 1], [3, 1], [3, 2], [1, 2]]]);
});

test('outline -> rasterizePolygon round-trips a complex mask exactly', () => {
  const w = 48, h = 40;
  const m = new Uint8ClampedArray(w * h);
  let seed = 99;
  for (let i = 0; i < m.length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    if ((seed >>> 8) % 3 === 0) m[i] = 255;
  }
  const loops = outline(m, w, h);
  assert.ok(loops.length > 20);
  for (const l of loops) for (let i = 0; i < l.length; i++) {
    const [ax, ay] = l[i], [bx, by] = l[(i + 1) % l.length];
    assert.ok(ax === bx || ay === by, 'axis-aligned edges between pixel corners');
  }
  assert.deepEqual(rasterizePolygon(loops, w, h, { antialias: false }), m);
  assert.deepEqual(rasterizePolygon(loops, w, h, { antialias: true }), m, 'pixel-aligned edges have exact coverage');
});

test('rasterizePolygon: triangle area, input forms, even-odd holes, clip', () => {
  const tri = [[2.5, 3], [58, 9.25], [21, 50.5]];
  const analytic = Math.abs(area(tri));
  const aa = rasterizePolygon(tri, 64, 64, { antialias: true });
  assertNear(total(aa), analytic, analytic * 0.01, 'antialiased area within 1%');
  assert.ok(aa.some((v) => v > 0 && v < 255), 'soft edge pixels');
  const hard = rasterizePolygon(tri, 64, 64, { antialias: false });
  assertNear(total(hard), analytic, analytic * 0.03, 'aliased area within 3%');
  assert.ok(hard.every((v) => v === 0 || v === 255));
  // Flat arrays and {x, y} points give the same mask; winding direction does not matter.
  assert.deepEqual(rasterizePolygon(tri.flat(), 64, 64), aa);
  assert.deepEqual(rasterizePolygon(tri.map(([x, y]) => ({ x, y })), 64, 64), aa);
  assert.deepEqual(rasterizePolygon([...tri].reverse(), 64, 64), aa);
  assert.deepEqual(rasterizePolygon([tri.flat()], 64, 64), aa, 'list of flat polygons');
  // A square with a square hole (even-odd).
  const outer = [[2, 2], [12, 2], [12, 12], [2, 12]], hole = [[5, 5], [9, 5], [9, 9], [5, 9]];
  const donut = rasterizePolygon([outer, hole], 16, 16);
  assert.equal(count(donut, 255), 100 - 16);
  assert.equal(at(donut, 16, 6, 6), 0);
  // Half-covered pixels.
  const halfPx = rasterizePolygon([[0, 0], [2.5, 0], [2.5, 1], [0, 1]], 4, 1);
  assert.deepEqual(Array.from(halfPx), [255, 255, 128, 0]);
  // Clip rect and off-canvas geometry.
  const clipped = rasterizePolygon(outer, 16, 16, {}, { x: 0, y: 0, width: 7, height: 16 });
  assert.equal(count(clipped, 255), 50);
  const off = rasterizePolygon([[-10, -10], [30, -10], [30, 30], [-10, 30]], 8, 8);
  assert.equal(count(off, 255), 64);
  assert.equal(count(rasterizePolygon([[1, 1], [5, 1]], 8, 8)), 0, 'degenerate');
  assert.equal(count(rasterizePolygon([], 8, 8)), 0);
});

test('rasterizeEllipse: area within 2% of analytic, symmetric, clip', () => {
  const rect = { x: 10.3, y: 5.7, width: 40, height: 25 };
  const analytic = Math.PI * 20 * 12.5;
  const aa = rasterizeEllipse(rect, 64, 40);
  assertNear(total(aa), analytic, analytic * 0.02, 'antialiased');
  assertNear(total(aa), analytic, analytic * 0.002, 'antialiased (tight)');
  const hard = rasterizeEllipse(rect, 64, 40, { antialias: false });
  assertNear(total(hard), analytic, analytic * 0.02, 'aliased');
  assert.ok(hard.every((v) => v === 0 || v === 255));
  // A circle centred on a pixel corner is symmetric.
  const c = rasterizeEllipse({ x: 2, y: 2, width: 12, height: 12 }, 16, 16);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    assert.equal(at(c, 16, x, y), at(c, 16, 15 - x, y), 'mirror x');
    assert.equal(at(c, 16, x, y), at(c, 16, x, 15 - y), 'mirror y');
    assertNear(at(c, 16, x, y), at(c, 16, y, x), 2, 'mirror diagonal (rows are supersampled, columns exact)');
  }
  assert.equal(at(c, 16, 8, 8), 255);
  assert.equal(at(c, 16, 0, 0), 0);
  // A rect dragged backwards is the same ellipse.
  assert.deepEqual(rasterizeEllipse({ x: 50.3, y: 30.7, width: -40, height: -25 }, 64, 40), aa);
  // Clip and partly off-canvas.
  const clipped = rasterizeEllipse(rect, 64, 40, {}, { x: 0, y: 0, width: 30, height: 40 });
  assert.ok(clipped.every((v, i) => (i % 64 < 30 ? v === aa[i] : v === 0)));
  const off = rasterizeEllipse({ x: -8, y: -8, width: 16, height: 16 }, 16, 16);
  assertNear(total(off), Math.PI * 64 / 4, 1);
  assert.equal(count(rasterizeEllipse({ x: 0, y: 0, width: 0, height: 5 }, 8, 8)), 0);
});

test('performance: floodFill and feather on 2000 x 2000 finish in under 2 s', () => {
  const W = 2000, H = 2000;
  const img = createImage(W, H, [40, 80, 120, 1]);
  // A serpentine maze of walls forces the scanline fill to change direction often.
  for (let y = 100; y < H; y += 200) for (let x = 0; x < W - 50; x++) setPixel(img, Math.floor(y / 200) % 2 ? x + 50 : x, y, [255, 255, 255, 1]);
  let t0 = performance.now();
  const m = floodFill(img, 10, 10, { tolerance: 20, contiguous: true, antialias: true });
  const tFill = performance.now() - t0;
  assert.equal(count(m), W * H - 10 * (W - 50));
  assert.ok(tFill < 2000, `floodFill took ${tFill.toFixed(0)} ms`);

  const mask = rectMask(W, H, 300, 300, 1400, 1400);
  for (const radius of [4, 250]) {
    const copy = new Uint8ClampedArray(mask);
    t0 = performance.now();
    feather(copy, W, H, radius);
    const tFeather = performance.now() - t0;
    assert.ok(tFeather < 2000, `feather(${radius}) took ${tFeather.toFixed(0)} ms`);
    assertNear(total(copy), 1400 * 1400, 1400 * 1400 * 0.005, `feather(${radius}) total`);
  }
});
