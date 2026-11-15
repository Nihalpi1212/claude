// type-menu-commands (ARCHITECTURE.md "0.5 features", package 13): the coverage rasteriser and the anti-alias curves,
// glyph outlines placed like render.js draws them (a subpath per glyph contour), the warp geometry, path flattening and
// mapping, and the Warp Text dialog's values. Pure code, with the real shaper and the Liberation Sans fixture (OFL).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as hb from 'harfbuzzjs';
import * as M from '../../src/renderer/lib/type/model.js';
import { layoutContent } from '../../src/renderer/lib/type/layout.js';
import { setHarfBuzz, shapePiece } from '../../src/renderer/lib/type/shaper.js';
import { addFaces, faceFor, harfBuzzFontProvider } from '../../src/renderer/lib/type/fonts.js';
import { rasterizeCoverage, coverageCurve, alphaTable, compositeCoverage, shapeAlpha, STAGE_METHODS } from '../../src/renderer/lib/type/antialias.js';
import { layoutOutlines, flattenSubpathPoints, mappedPolygons, mapSubpath, signedArea, polygonsBounds } from '../../src/renderer/lib/type/outlines.js';
import { warpBox, warpGeometry, mappedRectBounds, dialogValues, warpFromValues, WARP_STYLE_LABELS } from '../../src/renderer/lib/type/warp-text.js';
import { identityControls } from '../../src/shared/pixels/warp.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const sum = (a) => a.reduce((s, v) => s + v, 0);
const square = (x, y, w, h, cw = true) => Float64Array.from(cw ? [x, y, x + w, y, x + w, y + h, x, y + h] : [x, y, x, y + h, x + w, y + h, x + w, y]);

// ---- the rasteriser ---------------------------------------------------------------------------------------------

test('rasterizeCoverage gives the exact covered area of each pixel', () => {
  // a 2 × 2 square offset by half a pixel: quarter, half and full pixels
  const c = rasterizeCoverage([square(1.5, 1.5, 2, 2)], 5, 5);
  assert.deepEqual(Array.from(c.slice(5, 10)).map((v) => +v.toFixed(4)), [0, 0.25, 0.5, 0.25, 0]);
  assert.deepEqual(Array.from(c.slice(10, 15)).map((v) => +v.toFixed(4)), [0, 0.5, 1, 0.5, 0]);
  assert.ok(near(sum(c), 4, 1e-5));
  // a right triangle of area 8: the diagonal pixels are half covered
  const t = rasterizeCoverage([Float64Array.from([0, 0, 4, 0, 0, 4])], 4, 4);
  assert.ok(near(sum(t), 8, 1e-5));
  assert.ok(near(t[3], 0.5, 1e-6) && near(t[0], 1, 1e-6) && near(t[15], 0, 1e-6));
  // either winding gives the same coverage
  const ccw = rasterizeCoverage([square(1.5, 1.5, 2, 2, false)], 5, 5);
  assert.deepEqual(Array.from(ccw), Array.from(c));
});

test('rasterizeCoverage: a counter wound the other way is a hole; overlaps stay full; outside the grid is clipped', () => {
  const ring = rasterizeCoverage([square(0, 0, 6, 6, true), square(2, 2, 2, 2, false)], 6, 6);
  assert.equal(ring[2 * 6 + 2], 0);
  assert.equal(ring[0], 1);
  assert.ok(near(sum(ring), 32, 1e-5));
  const overlap = rasterizeCoverage([square(0, 0, 4, 4), square(2, 0, 4, 4)], 6, 4);
  assert.ok(Array.from(overlap).every((v) => near(v, 1, 1e-6)));
  // half of the square lies left of and above the grid
  const clipped = rasterizeCoverage([square(-2, -2, 4, 4)], 4, 4);
  assert.ok(near(sum(clipped), 4, 1e-5));
  assert.deepEqual(Array.from(clipped.slice(0, 4)), [1, 1, 0, 0]);
  // a polygon right of the grid covers nothing
  assert.equal(sum(rasterizeCoverage([square(5, 0, 3, 3)], 4, 4)), 0);
});

test('the anti-alias curves: None is 0 or 1 at half coverage, Sharp is steeper than Crisp, Strong is heavier', () => {
  assert.deepEqual(STAGE_METHODS, ['none', 'sharp', 'crisp', 'strong', 'windows']);
  const none = coverageCurve('none');
  assert.deepEqual([0, 0.2, 0.49, 0.5, 0.8, 1].map(none), [0, 0, 0, 1, 1, 1]);
  const sharp = coverageCurve('sharp'), crisp = coverageCurve('crisp'), strong = coverageCurve('strong'), smooth = coverageCurve('smooth');
  for (const f of [sharp, crisp, strong, smooth]) {
    assert.equal(f(0), 0);
    assert.equal(f(1), 1);
  }
  assert.ok(near(sharp(0.5), 0.5) && near(crisp(0.5), 0.5));
  assert.ok(sharp(0.3) < crisp(0.3) && sharp(0.7) > crisp(0.7));
  assert.ok(sharp(0.3) < smooth(0.3) && crisp(0.3) < smooth(0.3));
  assert.ok(strong(0.4) > smooth(0.4) && strong(0.5) > 0.5);
  assert.equal(coverageCurve('windows')(0.4), sharp(0.4));
  const table = alphaTable('none');
  assert.equal(table.length, 256);
  assert.deepEqual(new Set(table), new Set([0, 255]));
  assert.equal(table[127], 0);
  assert.equal(table[128], 255);
  const px = new Uint8ClampedArray([10, 20, 30, 100, 10, 20, 30, 200]);
  shapeAlpha(px, 'none');
  assert.deepEqual(Array.from(px), [10, 20, 30, 0, 10, 20, 30, 255]);
});

test('compositeCoverage: source over through the curve, colours kept straight', () => {
  const data = new Uint8ClampedArray(2 * 1 * 4);
  compositeCoverage(data, 2, Float32Array.from([1, 0.5]), 0, 0, 2, 1, [255, 0, 0, 1], coverageCurve('smooth'));
  assert.deepEqual(Array.from(data), [255, 0, 0, 255, 255, 0, 0, 128]);
  // blue at half over the half-covered red pixel: alpha 0.75, colour one third red
  compositeCoverage(data, 2, Float32Array.from([0, 0.5]), 0, 0, 2, 1, [0, 0, 255, 1], coverageCurve('smooth'));
  assert.deepEqual(Array.from(data.slice(4)), [85, 0, 170, 192]);
  const none = new Uint8ClampedArray(4);
  compositeCoverage(none, 1, Float32Array.from([0.49]), 0, 0, 1, 1, [0, 0, 0, 1], coverageCurve('none'));
  assert.equal(none[3], 0);
});

// ---- outlines -----------------------------------------------------------------------------------------------------

setHarfBuzz(hb);
addFaces(readFileSync(new URL('../fixtures/fonts/LiberationSans-Regular.ttf', import.meta.url)), { family: 'TMC Sans' });
const env = { faceFor, measure: (s, st, size) => s.length * size * 0.5 };
const measurer = {
  piece: (text, from, to, st, o = {}) => shapePiece(text, from, to, st, { ...env, ctxFrom: o.ctxFrom, ctxTo: o.ctxTo }),
  hyphen: (st) => shapePiece('-', 0, 1, st, env).units[0].advance,
  marker: (st, s) => shapePiece(s, 0, s.length, st, env).units.reduce((w, u) => w + u.advance, 0),
};
const greedy = {
  id: 'single',
  compose({ from, to, lineWidth, measure, breaks }) {
    const lines = [];
    let start = from, fit = null, n = 0;
    for (const at of [...breaks.map((b) => b.at), to]) {
      if (fit === null || measure(start, at) <= lineWidth(n)) {
        fit = at;
        continue;
      }
      lines.push({ from: start, to: fit, hyphen: false });
      start = fit;
      fit = at;
      n++;
    }
    lines.push({ from: start, to, hyphen: false });
    return lines;
  },
};
const spaceBreaker = (text) => [...text].flatMap((ch, i) => (ch === ' ' ? [{ at: i + 1, kind: 'space' }] : []));
const layout = (content, o = {}) => layoutContent(content, { x: 10, y: 20, width: null, height: null, engine: 'harfbuzz', measurer, composerFor: () => greedy, breaker: spaceBreaker, ...o });
const contours = (style, text) => harfBuzzFontProvider.outline(M.resolveChar(style), text).subpaths;

test('layoutOutlines: a subpath per glyph contour, placed where render.js draws the glyphs', () => {
  const st = { fontFamily: 'TMC Sans', size: 100 };
  const lay = layout(M.fromPlain('Hob', st));
  const ol = layoutOutlines(lay);
  assert.equal(ol.complete, true);
  const subs = ol.runs.flatMap((r) => r.subpaths);
  // H 1, o 2, b 2 contours
  assert.equal(subs.length, 5);
  assert.equal(subs.length, contours(st, 'Hob').length);
  // the provider sets the same glyphs from (0, 0) on the baseline: ours are moved to the run's pen and baseline
  const run = lay.lines[0].runs[0];
  const ours = polygonsBounds(mappedPolygons(subs));
  const theirs = polygonsBounds(mappedPolygons(contours(st, 'Hob')));
  assert.ok(near(ours.x1, theirs.x1 + run.x, 1e-6) && near(ours.y1, theirs.y1 + run.baseline, 1e-6));
  assert.ok(near(ours.x2, theirs.x2 + run.x, 1e-6) && near(ours.y2, theirs.y2 + run.baseline, 1e-6));
  // H sits on the baseline and reaches its cap height (0.688 em for Liberation Sans)
  const h = polygonsBounds(mappedPolygons([subs[0]]));
  assert.ok(near(h.y2, run.baseline, 0.5) && near(run.baseline - h.y1, 68.8, 0.6));
  // the Canvas engine's layout has no outlines
  assert.equal(layoutOutlines({ ...lay, engine: 'canvas' }), null);
});

test('layoutOutlines: scale, faux italic slant and underline follow the style', () => {
  const plain = layoutOutlines(layout(M.fromPlain('l', { fontFamily: 'TMC Sans', size: 100 })));
  const wide = layoutOutlines(layout(M.fromPlain('l', { fontFamily: 'TMC Sans', size: 100, scaleX: 200, scaleY: 50 })));
  const bp = polygonsBounds(mappedPolygons(plain.runs[0].subpaths)), bw = polygonsBounds(mappedPolygons(wide.runs[0].subpaths));
  assert.ok(near(bw.x2 - bw.x1, (bp.x2 - bp.x1) * 2, 1e-6));
  assert.ok(near(bw.y2 - bw.y1, (bp.y2 - bp.y1) / 2, 1e-6));
  // faux italic leans right by 0.2 of the height above the baseline: the top moves, the baseline stays
  const it = layoutOutlines(layout(M.fromPlain('l', { fontFamily: 'TMC Sans', size: 100, fauxItalic: true })));
  const bi = polygonsBounds(mappedPolygons(it.runs[0].subpaths));
  const baseline = layout(M.fromPlain('l', { fontFamily: 'TMC Sans', size: 100 })).lines[0].runs[0].baseline;
  assert.ok(near(bi.x2 - bp.x2, (baseline - bp.y1) * 0.2, 1e-6));
  assert.ok(near(bi.x1, bp.x1, 1e-6) && near(bi.y1, bp.y1, 1e-6));
  // underline: one more closed rectangle, wound like the glyph's outer contour
  const u = layoutOutlines(layout(M.fromPlain('l', { fontFamily: 'TMC Sans', size: 100, underline: true })));
  assert.equal(u.runs[0].decorations.length, 1);
  const deco = u.runs[0].decorations[0];
  assert.equal(deco.points.length, 4);
  assert.equal(Math.sign(signedArea(deco)), Math.sign(signedArea(u.runs[0].subpaths[0])));
});

test('flattenSubpathPoints keeps chords within tolerance; mapSubpath keeps curves exact under an affine map', () => {
  // a quarter circle as one cubic (k = 0.5523): every chord point lies near radius 100
  const k = 0.5523 * 100;
  const arc = { closed: false, points: [{ x: 100, y: 0, outX: 100, outY: k }, { x: 0, y: 100, inX: k, inY: 100 }] };
  const p = flattenSubpathPoints(arc, 0.1);
  assert.ok(p.length / 2 >= 8);
  for (let i = 0; i < p.length; i += 2) assert.ok(Math.abs(Math.hypot(p[i], p[i + 1]) - 100) < 0.1);
  // a long straight edge is cut for a non-linear map
  const line = { closed: false, points: [{ x: 0, y: 0 }, { x: 30, y: 0 }] };
  assert.equal(flattenSubpathPoints(line, 0.2, 3).length / 2, 11);
  const m = mapSubpath(arc, (x, y) => [2 * x + 5, 3 * y - 1], { affine: true });
  assert.deepEqual(m.points[0], { x: 205, y: -1, outX: 205, outY: 3 * k - 1 });
  // a non-linear map: pieces of at most maxSeg, the ends land on the mapped ends
  const bent = mapSubpath(arc, (x, y) => [x + y * y * 0.001, y], { maxSeg: 10 });
  assert.ok(bent.points.length > 10);
  assert.deepEqual([bent.points[0].x, bent.points[0].y], [100, 0]);
  const last = bent.points[bent.points.length - 1];
  assert.ok(near(last.x, 10, 1e-9) && near(last.y, 100, 1e-9));
  // a closed contour closes on its first anchor
  const sq = { closed: true, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] };
  const sqm = mapSubpath(sq, (x, y) => [x, y], { maxSeg: 5 });
  assert.equal(sqm.closed, true);
  assert.equal(sqm.points.length, 8);
});

// ---- Warp Text ----------------------------------------------------------------------------------------------------

const identity = (rect) => identityControls(rect);
const lift = (rect, style, bend) => identityControls(rect).map(([x, y], i) => [x, y - ((i % 4 === 1 || i % 4 === 2) ? bend : 0)]);

test('warpGeometry: identity controls map every point to itself; Vertical transposes the box', () => {
  const box = { x: 10, y: 20, width: 200, height: 50 };
  const g = warpGeometry(box, { style: 'arc', bend: 50 }, identity);
  for (const [x, y] of [[10, 20], [110, 45], [210, 70], [0, 0]]) {
    const [mx, my] = g.mapPoint(x, y);
    assert.ok(near(mx, x, 1e-9) && near(my, y, 1e-9));
  }
  // a test patch that lifts the middle columns: the box's top centre rises by 3/4 of the lift (Bernstein weights)
  const h = warpGeometry(box, { style: 'arc', bend: 40 }, lift);
  assert.ok(near(h.mapPoint(110, 20)[1], 20 - 30, 1e-9));
  assert.ok(near(h.mapPoint(10, 20)[1], 20, 1e-9));
  // vertical: the same lift moves points along x, in the middle rows
  const v = warpGeometry(box, { style: 'arc', bend: 40, horizontal: false }, lift);
  const [vx, vy] = v.mapPoint(10, 45);
  assert.ok(near(vx, 10 - 30, 1e-9) && near(vy, 45, 1e-9));
  // the distortions are swapped for a vertical warp
  const seen = [];
  warpGeometry(box, { style: 'flag', bend: 10, hDistort: 20, vDistort: -30, horizontal: false }, (r, s, b, hd, vd) => {
    seen.push([r, s, b, hd, vd]);
    return identityControls(r);
  });
  assert.deepEqual(seen[0], [{ x: 20, y: 10, width: 50, height: 200 }, 'flag', 10, -30, 20]);
  assert.equal(warpGeometry(box, { style: 'none' }, identity), null);
  assert.equal(warpGeometry({ ...box, width: 0 }, { style: 'arc' }, identity), null);
});

test('warpBox: the frame of paragraph text, the lines of point text; mappedRectBounds covers the mapped grid', () => {
  const lay = layout(M.fromPlain('Ab\nLonger line', { fontFamily: 'TMC Sans', size: 40 }));
  const b = warpBox({ x: 10, y: 20, width: null }, lay);
  const widest = Math.max(...lay.lines.map((l) => l.width));
  assert.ok(near(b.width, widest, 1e-9) && near(b.x, 10, 1e-9));
  assert.ok(near(b.y, lay.lines[0].top, 1e-9) && near(b.y + b.height, lay.lines[1].top + lay.lines[1].height, 1e-9));
  const para = layout(M.fromPlain('Ab', { fontFamily: 'TMC Sans', size: 40 }), { width: 300, height: 120 });
  assert.deepEqual(warpBox({ x: 5, y: 6, width: 300 }, para), { x: 5, y: 6, width: 300, height: 120 });
  assert.equal(warpBox({ x: 0, y: 0, width: null }, layout(M.fromPlain('', { fontFamily: 'TMC Sans', size: 40 }))), null);
  const g = warpGeometry({ x: 0, y: 0, width: 100, height: 20 }, { style: 'arc', bend: 40 }, lift);
  const mb = mappedRectBounds({ x: 0, y: 0, width: 100, height: 20 }, g);
  assert.ok(mb.y <= -30 && mb.y + mb.height >= 20 && mb.x <= 0 && mb.x + mb.width >= 100);
});

test('the Warp Text dialog values: defaults, a layer\'s warp, None', () => {
  assert.deepEqual(dialogValues(null), { style: 'none', horizontal: 'horizontal', bend: 50, hDistort: 0, vDistort: 0 });
  assert.deepEqual(dialogValues({ style: 'flag', horizontal: false, bend: -20, hDistort: 5, vDistort: 7 }), { style: 'flag', horizontal: 'vertical', bend: -20, hDistort: 5, vDistort: 7 });
  assert.deepEqual(warpFromValues({ style: 'wave', horizontal: 'vertical', bend: '30', hDistort: 0, vDistort: 140 }), { style: 'wave', horizontal: false, bend: 30, hDistort: 0, vDistort: 100 });
  assert.equal(warpFromValues({ style: 'none', bend: 50 }), null);
  assert.deepEqual(Object.keys(WARP_STYLE_LABELS), [...M.WARP_STYLES]);
});
