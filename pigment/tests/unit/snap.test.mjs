// Snap hook (0.4, F). The skeleton's stub reproduced 0.3's MoveTool.snapDelta for 'move' and was the identity for every
// other source; guides-snapping replaced it with "the nearest target within reach, for every source". These tests hold
// for the landed rules; tests/unit/guides-snapping.test.mjs covers the kinds, priorities and providers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Snap, installSnap, snapDisabled } from '../../src/renderer/lib/snap.js';

// 0.3's MoveTool.snapDelta / snapDelta2 (tools/move.js), copied as the reference
function snapDelta03(doc, zoom, first, b, dx, dy) {
  const tol = 6 / zoom;
  const targetsX = [0, doc.width / 2, doc.width, ...doc.guides.filter((g) => g.axis === 'x').map((g) => g.pos)];
  const targetsY = [0, doc.height / 2, doc.height, ...doc.guides.filter((g) => g.axis === 'y').map((g) => g.pos)];
  const edgesX = [first.x + dx, first.x + dx + b.width / 2, first.x + dx + b.width];
  const edgesY = [first.y + dy, first.y + dy + b.height / 2, first.y + dy + b.height];
  const snap2 = (dx2, dy2) => {
    for (const e of edgesY) for (const t of targetsY) if (Math.abs(e - t) <= tol) return [dx2, dy2 + Math.round(t - e)];
    return [dx2, dy2];
  };
  for (const e of edgesX) for (const t of targetsX) if (Math.abs(e - t) <= tol) return snap2(dx + Math.round(t - e), dy);
  return snap2(dx, dy);
}

function fakeApp(doc, zoom = 1, snap = true) {
  return { settings: { snap }, doc, view: { zoom } };
}

test('box({ source: "move" }) snaps exactly where 0.3 found a target in reach, to the nearest one, on whole pixels', () => {
  const docs = [
    { width: 400, height: 300, guides: [] },
    { width: 400, height: 300, guides: [{ id: 'a', axis: 'x', pos: 123.5 }, { id: 'b', axis: 'y', pos: 77 }, { id: 'c', axis: 'x', pos: 250 }] },
    { width: 1000, height: 50, guides: [{ id: 'd', axis: 'y', pos: 25.25 }] },
  ];
  const layers = [
    { first: { x: 10, y: 10 }, b: { width: 40, height: 30 } },
    { first: { x: -5, y: 3 }, b: { width: 101, height: 57 } },
    { first: { x: 200, y: 140 }, b: { width: 0.5, height: 7 } },
  ];
  // the deltas that put an edge (start, centre, end) on a target, nearest first
  const deltas = (start, size, targets, tol) => {
    const out = [];
    for (const e of [start, start + size / 2, start + size]) for (const t of targets) if (Math.abs(t - e) <= tol) out.push(t - e);
    return out;
  };
  let checked = 0, snappedCount = 0;
  for (const doc of docs) {
    for (const zoom of [0.25, 1, 3]) {
      const snap = new Snap(fakeApp(doc, zoom));
      const tol = 6 / zoom;
      const tx = [0, doc.width / 2, doc.width, ...doc.guides.filter((g) => g.axis === 'x').map((g) => g.pos)];
      const ty = [0, doc.height / 2, doc.height, ...doc.guides.filter((g) => g.axis === 'y').map((g) => g.pos)];
      for (const { first, b } of layers) {
        for (let dx = -40; dx <= 420; dx += 7) {
          for (let dy = -30; dy <= 320; dy += 11) {
            const ref = snapDelta03(doc, zoom, first, b, dx, dy);
            const r = snap.box({ x: first.x + dx, y: first.y + dy, width: b.width, height: b.height }, { source: 'move' });
            const where = `doc ${doc.width} zoom ${zoom} d ${dx},${dy}`;
            for (const [axis, d, start, size, targets, refD] of [['x', r.dx, first.x + dx, b.width, tx, ref[0] - dx], ['y', r.dy, first.y + dy, b.height, ty, ref[1] - dy]]) {
              const cands = deltas(start, size, targets, tol);
              // snaps exactly when 0.3 did (0.3 snapped on an axis when any edge was in reach)
              assert.equal(cands.length > 0, refD !== 0 || cands.some((c) => Math.round(c) === 0), `${where} ${axis}`);
              if (!cands.length) { assert.equal(d, 0, `${where} ${axis}`); continue; }
              const best = Math.min(...cands.map(Math.abs));
              assert.ok(cands.some((c) => Math.abs(Math.abs(c) - best) < 1e-9 && Math.round(c) === d), `${where} ${axis}: ${d} is not a nearest delta`);
              assert.equal(Number.isInteger(d), true);
            }
            if (r.dx || r.dy) snappedCount++;
            checked++;
          }
        }
      }
    }
  }
  assert.ok(checked > 1000 && snappedCount > 100, `${checked} cases, ${snappedCount} snapped`);
});

test('box reports what it snapped to; excludeGuides drops a guide; view zoom wins over app.view', () => {
  const doc = { width: 100, height: 100, guides: [{ id: 'g1', axis: 'x', pos: 30 }] };
  const snap = new Snap(fakeApp(doc, 1));
  const r = snap.box({ x: 28, y: 3, width: 10, height: 10 }, { source: 'move' });
  assert.deepEqual([r.dx, r.dy], [2, -3]);
  assert.deepEqual(r.snapped.x, { pos: 30, kind: 'guide', id: 'g1' });
  assert.deepEqual(r.snapped.y, { pos: 0, kind: 'document' });
  const ex = snap.box({ x: 28, y: 20, width: 10, height: 10 }, { source: 'move', excludeGuides: ['g1'] });
  assert.equal(ex.dx, 0);
  // at zoom 4 the tolerance is 1.5 document pixels
  const far = snap.box({ x: 28, y: 20, width: 10, height: 10 }, { source: 'move', view: { zoom: 4 } });
  assert.equal(far.dx, 0);
});

test('every placing source snaps the same way; only "move" rounds to whole pixels', () => {
  const doc = { width: 100, height: 100, guides: [{ id: 'g', axis: 'x', pos: 50 }] };
  const snap = new Snap(fakeApp(doc));
  for (const source of ['marquee', 'crop', 'perspective-crop', 'shape', 'pen', 'path', 'transform', 'guide', 'type-box', 'gradient', 'slice']) {
    assert.deepEqual(snap.box({ x: 49, y: 1, width: 10, height: 10 }, { source }), { dx: 1, dy: -1, snapped: { x: { pos: 50, kind: 'guide', id: 'g' }, y: { pos: 0, kind: 'document' } } }, source);
    assert.deepEqual(snap.point({ x: 49.5, y: 0.5 }, { source }), { x: 50, y: 0, snapped: { x: { pos: 50, kind: 'guide', id: 'g' }, y: { pos: 0, kind: 'document' } } }, source);
  }
  assert.equal(snap.box({ x: 49.6, y: 30, width: 10, height: 10 }, { source: 'shape' }).dx, 50 - 49.6);
  assert.equal(snap.box({ x: 49.6, y: 30, width: 10, height: 10 }, { source: 'move' }).dx, 0);
  assert.doesNotThrow(() => snap.end());
});

test('Ctrl / Cmd disables snapping, except Ctrl that summoned a temporary tool; settings.snap false disables', () => {
  const doc = { width: 100, height: 100, guides: [] };
  const app = fakeApp(doc);
  const snap = new Snap(app);
  const rect = { x: 2, y: 50, width: 10, height: 10 };
  assert.equal(snap.box(rect, { source: 'move' }).dx, -2);
  assert.equal(snap.box(rect, { source: 'move', pointer: { ctrl: true } }).dx, 0);
  assert.equal(snap.box(rect, { source: 'move', pointer: { meta: true } }).dx, 0);
  assert.equal(snap.box(rect, { source: 'move', pointer: { ctrl: true, temporary: 'ctrl' } }).dx, -2);
  assert.equal(snap.box(rect, { source: 'move', pointer: { ctrl: true, temporary: 'alt' } }).dx, 0);
  assert.equal(snapDisabled(app, { pointer: { meta: true, temporary: 'ctrl' } }), false);
  app.settings.snap = false;
  assert.equal(snap.box(rect, { source: 'move' }).dx, 0);
});

test('registerTargets adds a provider (the later registration of an id wins); installSnap sets app.snap', () => {
  const doc = { width: 100, height: 100, guides: [] };
  const app = fakeApp(doc);
  const snap = installSnap(app);
  assert.equal(app.snap, snap);
  snap.registerTargets('test', () => ({ x: [{ pos: 20, kind: 'layer', id: 'L1' }], y: [] }));
  assert.equal(snap.box({ x: 18, y: 20, width: 10, height: 10 }, { source: 'move' }).dx, 2);
  snap.registerTargets('test', () => ({ x: [], y: [] }));
  assert.equal(snap.box({ x: 18, y: 20, width: 10, height: 10 }, { source: 'move' }).dx, 0);
});
