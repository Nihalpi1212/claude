// guides-snapping (0.4 package 11): snap priorities and tolerance, Ctrl and `temporary`, Snap To, layer and grid
// targets, equal spacing, guide layouts, ruler conversions with an origin, smart-guide geometry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Snap, bestSnap, enabledKinds, gridLines, snapDisabled, EDGES, TOLERANCE_PX } from '../../src/renderer/lib/snap.js';
import { Rulers, parseMeasure, perUnitFor, roundForUnit, unitFromSuffix, UNITS, UNIT_NAMES } from '../../src/renderer/lib/rulers.js';
import { guideLayout, guidesFromBounds, mergeGuides, normalizeLayout, trackEdges } from '../../src/renderer/lib/guide-layout.js';
import { alignmentLines, distances, spacingTargets, spacingMarks, boxEdges } from '../../src/renderer/lib/smart-guides.js';
import { DocStore } from '../../src/renderer/lib/doc-store.js';

/** A layer as snap.js sees it: bounds(), visible, parent. */
function layer(id, x, y, width, height, extra = {}) {
  return { id, type: 'raster', visible: true, parent: null, bounds: () => ({ x, y, width, height }), ...extra };
}

function fakeDoc({ width = 400, height = 300, guides = [], layers = [], dpi = 72 } = {}) {
  const doc = { width, height, dpi, layers: () => layers, history: { push() {} }, changed() {} };
  doc.store = new DocStore(doc);
  doc.store.setRaw('guides', guides);
  Object.defineProperty(doc, 'guides', { get: () => doc.store.get('guides') });
  return doc;
}

function fakeApp(doc, settings = {}, zoom = 1) {
  const app = { settings: { snap: true, showGuides: true, showGrid: false, gridSize: 50, gridSubdivisions: 4, rulerUnit: 'px', guides: {}, ...settings }, doc, view: { zoom } };
  app.rulers = new Rulers(app);
  app.snap = new Snap(app);
  return app;
}

test('point: the nearest target in reach wins, per axis; 6 screen px of tolerance at any zoom', () => {
  const doc = fakeDoc({ guides: [{ axis: 'x', pos: 103 }, { axis: 'x', pos: 96 }, { axis: 'y', pos: 40 }] });
  const app = fakeApp(doc);
  const s = app.snap;
  // 100: the guide at 96 is 4 away, the one at 103 is 3 away
  let r = s.point({ x: 100, y: 46 }, { source: 'marquee' });
  assert.deepEqual([r.x, r.y], [103, 40]);
  assert.equal(r.snapped.x.kind, 'guide');
  // exactly 6 px reaches, 6.01 does not
  s.end();
  assert.equal(s.point({ x: 34, y: 34 }, { source: 'marquee' }).y, 40);
  s.end();
  assert.equal(s.point({ x: 30, y: 33.99 }, { source: 'marquee' }).y, 33.99);
  // at zoom 3 the reach is 2 document px
  app.view.zoom = 3;
  s.end();
  assert.equal(s.point({ x: 100.5, y: 37.9 }, { source: 'marquee' }).y, 37.9);
  assert.equal(s.point({ x: 101.5, y: 38.1 }, { source: 'marquee' }).x, 103);
  // the view passed with the call wins over app.view
  s.end();
  assert.equal(s.point({ x: 101.5, y: 38.1 }, { source: 'marquee', view: { zoom: 1 } }).y, 40);
  assert.equal(TOLERANCE_PX, 6);
});

test('ties go to guides, then the document, then layers, then the grid', () => {
  const targets = [{ pos: 10, kind: 'grid' }, { pos: 10, kind: 'layer' }, { pos: 10, kind: 'document' }, { pos: 10, kind: 'guide' }];
  assert.equal(bestSnap([12], [null], targets, 6).target.kind, 'guide');
  assert.equal(bestSnap([12], [null], targets.slice(0, 3), 6).target.kind, 'document');
  assert.equal(bestSnap([12], [null], targets.slice(0, 2), 6).target.kind, 'layer');
  // nearer beats rank
  assert.equal(bestSnap([12], [null], [{ pos: 11, kind: 'grid' }, { pos: 14, kind: 'guide' }], 6).target.kind, 'grid');
  // an edge-restricted target meets only its edge; a point never meets one
  const t = [{ pos: 50, kind: 'layer', edge: 'end' }];
  assert.equal(bestSnap([40, 45, 49], EDGES, t, 6).edge, 2);
  assert.equal(bestSnap([49, 55, 61], EDGES, t, 6), null);
  assert.equal(bestSnap([49], [null], t, 6), null);
});

test('Ctrl / Cmd turn snapping off unless Ctrl summoned the tool; View > Snap off turns it off', () => {
  const doc = fakeDoc({ guides: [{ axis: 'x', pos: 50 }] });
  const app = fakeApp(doc);
  const s = app.snap;
  const p = { x: 48, y: 120 };
  assert.equal(s.point(p, { source: 'shape', pointer: { ctrl: false } }).x, 50);
  assert.equal(s.point(p, { source: 'shape', pointer: { ctrl: true } }).x, 48);
  assert.equal(s.point(p, { source: 'shape', pointer: { meta: true } }).x, 48);
  assert.equal(s.point(p, { source: 'shape', pointer: { ctrl: true, temporary: 'ctrl' } }).x, 50);
  assert.equal(s.point(p, { source: 'shape', pointer: { meta: true, temporary: 'ctrl' } }).x, 50);
  assert.equal(s.point(p, { source: 'shape', pointer: { ctrl: true, temporary: 'space' } }).x, 48);
  assert.equal(snapDisabled(app, { pointer: { ctrl: true, temporary: 'alt' } }), true);
  app.settings.snap = false;
  assert.equal(s.point(p, { source: 'shape' }).x, 48);
  assert.deepEqual(s.box({ x: 48, y: 10, width: 10, height: 10 }, { source: 'move' }), { dx: 0, dy: 0, snapped: { x: null, y: null } });
});

test('Snap To: each kind can be turned off; guides and the grid snap only while shown', () => {
  const settings = (patch, snapTo = {}) => ({ snap: true, showGuides: true, showGrid: true, guides: { snapTo: { guides: true, grid: true, layers: true, bounds: true, artboards: true, slices: true, ...snapTo } }, ...patch });
  assert.deepEqual([...enabledKinds(settings({}))].sort(), ['artboard', 'document', 'grid', 'guide', 'layer', 'pixel', 'slice']);
  assert.ok(!enabledKinds(settings({ showGuides: false })).has('guide'));
  assert.ok(!enabledKinds(settings({ showGrid: false })).has('grid'));
  assert.ok(!enabledKinds(settings({}, { layers: false })).has('layer'));
  assert.ok(!enabledKinds(settings({}, { bounds: false })).has('document'));
  // no settings.guides yet: all on (the J.7 defaults), the grid still needs to be shown
  assert.deepEqual([...enabledKinds({ showGrid: false })].sort(), ['artboard', 'document', 'guide', 'layer', 'pixel', 'slice']);

  const doc = fakeDoc({ width: 200, height: 200, guides: [{ axis: 'x', pos: 77 }] });
  const app = fakeApp(doc);
  app.settings.guides = { snapTo: { guides: false, grid: true, layers: true, bounds: true } };
  assert.equal(app.snap.point({ x: 75, y: 150 }, { source: 'pen' }).x, 75);
  app.settings.guides = { snapTo: { guides: true, bounds: false } };
  app.snap.end();
  assert.equal(app.snap.point({ x: 75, y: 3 }, { source: 'pen' }).y, 3);
  assert.equal(app.snap.point({ x: 75, y: 3 }, { source: 'pen' }).x, 77);
});

test('grid targets: Gridline Every in its unit, Subdivisions, from the ruler origin', () => {
  assert.deepEqual(gridLines(0, 25, 0, 100), [0, 25, 50, 75, 100]);
  assert.deepEqual(gridLines(10, 25, 0, 100), [10, 35, 60, 85]);
  assert.deepEqual(gridLines(-15, 25, 0, 60), [10, 35, 60]);
  assert.deepEqual(gridLines(0, 0, 0, 100), []);
  assert.deepEqual(gridLines(0, 0.001, 0, 100000), []); // too dense to list
  const doc = fakeDoc({ width: 300, height: 300 });
  const app = fakeApp(doc, { showGrid: true, gridSize: 1, gridSubdivisions: 2, guides: { gridUnit: 'in', snapTo: { bounds: false, layers: false } } });
  // 1 inch at 72 ppi, 2 subdivisions: every 36 px
  assert.equal(app.snap.point({ x: 70, y: 0 }, { source: 'marquee' }).x, 72);
  assert.equal(app.snap.point({ x: 39, y: 0 }, { source: 'marquee' }).x, 36);
  app.rulers.setOrigin(doc, { x: 10, y: 0 });
  app.snap.end();
  assert.equal(app.snap.point({ x: 44, y: 0 }, { source: 'marquee' }).x, 46);
  const r = app.snap.point({ x: 44, y: 0 }, { source: 'marquee' });
  assert.equal(r.snapped.x.kind, 'grid');
});

test('layer targets: visible layers\' boxes, not the excluded ones (nor their children), not hidden ones', () => {
  const group = { id: 'G', isGroup: true, visible: true, parent: null };
  const inGroup = layer('C', 150, 150, 20, 20, { parent: group });
  const hidden = layer('H', 60, 200, 10, 10, { visible: false });
  const a = layer('A', 100, 20, 50, 40);
  const doc = fakeDoc({ width: 400, height: 300, layers: [a, hidden, group, inGroup] });
  const app = fakeApp(doc, { guides: { snapTo: { bounds: false } } });
  const s = app.snap;
  // A's left edge, centre and right edge
  assert.equal(s.point({ x: 97, y: 250 }, { source: 'shape' }).x, 100);
  assert.equal(s.point({ x: 127, y: 250 }, { source: 'shape' }).x, 125);
  assert.equal(s.point({ x: 147, y: 250 }, { source: 'shape' }).x, 150);
  assert.equal(s.point({ x: 147, y: 250 }, { source: 'shape' }).snapped.x.id, 'A');
  // a hidden layer is not a target
  assert.equal(s.point({ x: 300, y: 203 }, { source: 'shape' }).y, 203);
  // the layer being moved is excluded; a layer inside an excluded group too
  assert.equal(s.box({ x: 98, y: 200, width: 10, height: 10 }, { source: 'move', exclude: [a] }).dx, 0);
  s.end();
  assert.equal(s.box({ x: 152, y: 250, width: 10, height: 10 }, { source: 'move', exclude: [] }).dx, -2);
  s.end();
  assert.equal(s.box({ x: 172, y: 250, width: 10, height: 10 }, { source: 'move', exclude: [group] }).dx, 0);
  // boundsOf is the layer box the app uses (guides.js installs the content bounds)
  s.boundsOf = (l) => (l.id === 'A' ? { x: 110, y: 20, width: 10, height: 10 } : l.bounds());
  s.end();
  assert.equal(s.point({ x: 108, y: 250 }, { source: 'shape' }).x, 110);
});

test('box: start, centre or end meets a target; moves are rounded; axis limits a Shift-constrained drag', () => {
  const doc = fakeDoc({ width: 400, height: 300, guides: [{ axis: 'x', pos: 123.5 }, { axis: 'y', pos: 77 }] });
  const app = fakeApp(doc, { guides: { smartGuides: false } });
  const s = app.snap;
  let r = s.box({ x: 120, y: 72, width: 30, height: 30 }, { source: 'move' });
  assert.deepEqual([r.dx, r.dy], [4, 5]); // 3.5 rounded; the top edge meets 77
  r = s.box({ x: 120, y: 72, width: 30, height: 30 }, { source: 'transform' });
  assert.deepEqual([r.dx, r.dy], [3.5, 5]);
  // the centre: 100 + 15 = 115 is not near; with width 47, 100 + 23.5 meets 123.5
  r = s.box({ x: 100, y: 200, width: 47, height: 10 }, { source: 'transform' });
  assert.equal(r.dx, 0);
  assert.equal(r.snapped.x.pos, 123.5);
  r = s.box({ x: 120, y: 72, width: 30, height: 30 }, { source: 'move', axis: 'x' });
  assert.deepEqual([r.dx, r.dy], [4, 0]);
  r = s.box({ x: 120, y: 72, width: 30, height: 30 }, { source: 'move', axis: 'y' });
  assert.deepEqual([r.dx, r.dy], [0, 5]);
  // the guide being dragged is not a target of its own drag
  const id = doc.guides[0].id;
  s.end();
  assert.equal(s.point({ x: 121, y: 150 }, { source: 'guide', axis: 'x', excludeGuides: [id] }).x, 121);
  // a guide drag on 'x' never moves y
  assert.equal(s.point({ x: 121, y: 75 }, { source: 'guide', axis: 'x' }).y, 75);
});

test('Smart Guides: equal spacing is a target while moving, and alignment lines and spacing marks are drawn', () => {
  const a = layer('A', 0, 100, 40, 40), b = layer('B', 60, 100, 40, 40);
  const doc = fakeDoc({ width: 400, height: 300, layers: [a, b] });
  const app = fakeApp(doc, { guides: { snapTo: { bounds: false } } });
  const s = app.snap;
  // gap A..B is 20: a box whose left edge comes near 120 snaps to it
  const r = s.box({ x: 117, y: 105, width: 30, height: 30 }, { source: 'move' });
  assert.equal(r.dx, 3);
  assert.equal(r.snapped.x.edge, 'start');
  assert.equal(r.snapped.x.spacing.gap, 20);
  assert.ok(s.overlay.gaps.length >= 2);
  assert.deepEqual(s.overlay.gaps.map((g) => [g.from, g.to]), [[40, 60], [100, 120]]);
  // smart guides off: no spacing target
  app.settings.guides = { ...app.settings.guides, smartGuides: false };
  s.end();
  assert.equal(s.box({ x: 117, y: 105, width: 30, height: 30 }, { source: 'move' }).dx, 0);
  // alignment: a moved box whose top meets A's top gets a line through both
  app.settings.guides = { snapTo: { bounds: false } };
  s.end();
  s.box({ x: 200, y: 101, width: 20, height: 20 }, { source: 'move' });
  assert.ok(s.overlay.lines.some((l) => l.axis === 'y' && l.pos === 100 && l.from === 0 && l.to === 220));
  s.end();
  assert.equal(s.overlay, null);
});

test('smart-guide geometry: alignment lines, spacing targets, distances', () => {
  const rect = { x: 10, y: 50, width: 20, height: 10 };
  const lines = alignmentLines(rect, [{ x: 10, y: 0, width: 5, height: 5 }, { x: 100, y: 60, width: 10, height: 10 }]);
  assert.deepEqual(lines.find((l) => l.axis === 'x'), { axis: 'x', pos: 10, from: 0, to: 60 });
  assert.deepEqual(lines.find((l) => l.axis === 'y'), { axis: 'y', pos: 60, from: 10, to: 110 });
  // centred between two boxes 100 px apart (box 20 wide): its centre at the middle of the gap
  const t = spacingTargets({ x: 0, y: 0, width: 20, height: 10 }, [{ x: 0, y: 0, width: 10, height: 10 }, { x: 110, y: 0, width: 10, height: 10 }], 'x');
  const centred = t.find((x) => x.edge === 'centre');
  assert.equal(centred.pos, 60);
  assert.deepEqual(spacingMarks({ x: 50, y: 0, width: 20, height: 10 }, centred, 'x').map((g) => [g.from, g.to, g.at]), [[10, 50, 5], [70, 110, 5]]);
  // boxes in another row are not spacing neighbours
  assert.equal(spacingTargets({ x: 0, y: 100, width: 20, height: 10 }, [{ x: 0, y: 0, width: 10, height: 10 }, { x: 50, y: 0, width: 10, height: 10 }], 'x').length, 0);
  // distances: apart on x, overlapping on y
  assert.deepEqual(distances({ x: 0, y: 0, width: 10, height: 10 }, { x: 30, y: 5, width: 10, height: 10 }), [
    { axis: 'x', from: 10, to: 30, at: 7.5 }, { axis: 'y', from: 0, to: 5, at: 5 }, { axis: 'y', from: 10, to: 15, at: 5 },
  ]);
  const inCanvas = distances({ x: 10, y: 20, width: 30, height: 40 }, { x: 0, y: 0, width: 100, height: 100 });
  assert.deepEqual(inCanvas.map((g) => [g.axis, g.to - g.from]), [['x', 10], ['x', 60], ['y', 20], ['y', 40]]);
  assert.deepEqual(boxEdges({ x: 1, y: 2, width: 4, height: 6 }, 'y'), [2, 5, 8]);
});

test('guide layouts: columns share the width, fixed widths, centred, margins, rows, no doubled guides', () => {
  const doc = { width: 400, height: 300 };
  // 4 columns, gutter 20: each (400 - 60) / 4 = 85
  assert.deepEqual(guideLayout({ columns: { enabled: true, number: 4, gutter: 20 } }, doc).map((g) => g.pos), [0, 85, 105, 190, 210, 295, 315, 400]);
  // no gutter: shared edges give one guide
  assert.deepEqual(guideLayout({ columns: { enabled: true, number: 4, gutter: 0 } }, doc).map((g) => g.pos), [0, 100, 200, 300, 400]);
  // fixed width 50, 3 columns, gutter 10, centred: total 170, starts at 115
  assert.deepEqual(guideLayout({ columns: { enabled: true, number: 3, width: 50, gutter: 10 }, center: true }, doc).map((g) => g.pos), [115, 165, 175, 225, 235, 285]);
  // the same from the left margin
  assert.deepEqual(guideLayout({ columns: { enabled: true, number: 3, width: 50, gutter: 10 }, margin: { enabled: true, left: 20, right: 20, top: 10, bottom: 10 } }, doc), [
    ...[20, 70, 80, 130, 140, 190, 380].map((pos) => ({ axis: 'x', pos })),
    { axis: 'y', pos: 10 }, { axis: 'y', pos: 290 },
  ]);
  // rows from the top margin; 3 rows over 300 - 2 * 10 with a 10 gutter: (280 - 20) / 3
  const rows = guideLayout({ rows: { enabled: true, number: 3, gutter: 10 }, margin: { enabled: true, top: 10, bottom: 10 } }, doc).filter((g) => g.axis === 'y').map((g) => g.pos);
  assert.deepEqual(rows, [10, 96.67, 106.67, 193.33, 203.33, 290]);
  // nothing enabled: nothing; columns that do not fit: none
  assert.deepEqual(guideLayout({}, doc), []);
  assert.deepEqual(trackEdges(0, 10, 4, null, 5), []);
  assert.deepEqual(normalizeLayout({ columns: { enabled: 1, number: '2.6', width: '', gutter: -3 } }).columns, { enabled: true, number: 3, width: null, gutter: 0 });
  // New Guides From Shape: edges and centres
  assert.deepEqual(guidesFromBounds({ x: 10, y: 20, width: 30, height: 40 }), [
    { axis: 'x', pos: 10 }, { axis: 'x', pos: 25 }, { axis: 'x', pos: 40 }, { axis: 'y', pos: 20 }, { axis: 'y', pos: 40 }, { axis: 'y', pos: 60 },
  ]);
  assert.deepEqual(mergeGuides([{ id: 'a', axis: 'x', pos: 10 }], [{ axis: 'x', pos: 10.001 }, { axis: 'y', pos: 10 }]), [{ id: 'a', axis: 'x', pos: 10 }, { axis: 'y', pos: 10 }]);
});

test('rulers: units, the origin from the document store, lengths without it, parse and format', () => {
  const doc = fakeDoc({ width: 400, height: 200, dpi: 144 });
  const app = { settings: { rulerUnit: 'px', gridSize: 2, gridSubdivisions: 4, guides: { gridUnit: 'cm' } } };
  const r = new Rulers(app);
  assert.deepEqual(r.origin(doc), { x: 0, y: 0 });
  assert.equal(r.setOrigin(doc, { x: 50, y: 20 }), true);
  assert.equal(r.setOrigin(doc, { x: 50, y: 20 }), false); // unchanged: no entry
  assert.deepEqual(r.origin(doc), { x: 50, y: 20 });
  assert.equal(r.toRuler(doc, 'x', 150), 100);
  assert.equal(r.toRuler(doc, 'y', 10), -10);
  assert.equal(r.toRuler(doc, 'x', 150, { length: true }), 150);
  assert.equal(r.fromRuler(doc, 'x', 100), 150);
  app.settings.rulerUnit = 'in';
  assert.equal(r.toRuler(doc, 'x', 194), 1); // (194 - 50) / 144
  assert.equal(r.format(doc, 'x', 194), '1 in');
  assert.equal(r.format(doc, 'y', 92, { length: true }), '0.639 in');
  app.settings.rulerUnit = 'percent';
  assert.equal(r.format(doc, 'x', 250), '50 %');
  assert.equal(r.format(doc, 'y', 120), '50 %');
  app.settings.rulerUnit = 'cm';
  assert.ok(Math.abs(r.parse(doc, 'x', '2.54') - (144 + 50)) < 1e-9);
  assert.equal(r.parse(doc, 'x', '100 px'), 150);
  assert.equal(r.parse(doc, 'x', '1in', { length: true }), 144);
  assert.equal(r.parse(doc, 'y', '50%'), 120);
  assert.equal(r.parse(doc, 'x', 'abc'), null);
  app.settings.rulerUnit = 'nonsense';
  assert.equal(r.unit(doc), 'px');
  // the grid: 2 cm at 144 ppi, 4 subdivisions, from the origin
  const g = r.grid(doc, 'x');
  assert.ok(Math.abs(g.major - (2 * 144) / 2.54) < 1e-9);
  assert.ok(Math.abs(g.minor - g.major / 4) < 1e-9);
  assert.equal(g.origin, 50);
  assert.equal(r.resetOrigin(doc), true);
  assert.deepEqual(r.origin(doc), { x: 0, y: 0 });
  // pure helpers
  assert.equal(perUnitFor('pt', { dpi: 0 }, 'x'), 1);
  assert.equal(perUnitFor('mm', { dpi: 254 }, 'x'), 10);
  assert.deepEqual(parseMeasure(' 2,5 cm '), { value: 2.5, unit: 'cm' });
  assert.deepEqual(parseMeasure('40'), { value: 40, unit: null });
  assert.deepEqual(parseMeasure('-3"'), { value: -3, unit: 'in' });
  assert.equal(parseMeasure('3 furlongs'), null);
  assert.equal(parseMeasure(''), null);
  assert.equal(unitFromSuffix('Points'), 'pt');
  assert.equal(roundForUnit(1.23456, 'cm'), 1.235);
  assert.equal(roundForUnit(-0.001, 'px'), 0);
});

test('the ruler origin moves with the image (Image Size, crop) and is one undoable entry', () => {
  const pushed = [];
  const doc = { width: 100, height: 100, history: { push: (e) => pushed.push(e) }, changed() {} };
  doc.store = new DocStore(doc);
  const r = new Rulers({ settings: {} });
  r.setOrigin(doc, { x: 10, y: 20 });
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].label, 'Ruler Origin');
  doc.store.transformAll([2, 0, 0, 2, -5, 0], { width: 200, height: 200 });
  assert.deepEqual(r.origin(doc), { x: 15, y: 40 });
  pushed[0].undo();
  assert.deepEqual(r.origin(doc), { x: 0, y: 0 });
  // the untouched origin stays on the corner (Canvas Size, Rotate Arbitrary)
  doc.store.transformAll([0.98, 0.17, -0.17, 0.98, 30, 12], { width: 150, height: 150 });
  assert.deepEqual(r.origin(doc), { x: 0, y: 0 });
});

test('the rulers have Picas (1 pc = 12 pt): a unit, a typed suffix and a readout', () => {
  // hunt5 canvas-vector: view:ruler-unit 'pica' was ignored and '1pc' did not parse
  assert.ok(UNITS.includes('pica'));
  assert.equal(UNIT_NAMES.pica, 'Picas');
  assert.equal(perUnitFor('pica', { dpi: 72 }, 'x'), 12);
  assert.equal(perUnitFor('pica', { dpi: 300 }, 'y'), 50);
  for (const t of ['pc', 'pica', 'Picas']) assert.equal(unitFromSuffix(t), 'pica');
  assert.deepEqual(parseMeasure('1.5pc'), { value: 1.5, unit: 'pica' });
  const doc = { width: 600, height: 600, dpi: 72, history: { push() {} }, changed() {} };
  doc.store = new DocStore(doc);
  const r = new Rulers({ settings: { rulerUnit: 'pica' } });
  assert.equal(r.unit(doc), 'pica');
  assert.equal(r.parse(doc, 'x', '2'), 24);
  assert.equal(r.parse(doc, 'x', '1 pica'), 12);
  assert.equal(r.format(doc, 'x', 30), '2.5 pc');
});
