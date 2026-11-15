// The colour pipeline of the 0.5 skeleton (ARCHITECTURE.md "0.5 features", S6): the sRGB stub answers (0.4's numbers),
// a registered engine's sync and async calls, the document profile helpers, display stages and the damage of
// Compositor.takeDamage. Rule 11: the stub's own answers are checked while colorEngine().available is false (the
// state every test process starts in until icc-engine registers from lib/color/cmm.js, which Node never loads).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../src/renderer/lib/color/pipeline.js';
import { Compositor } from '../../src/renderer/lib/compositor.js';
import { rgbToLab, labToRgb } from '../../src/shared/pixels/color.js';

const P3 = Object.freeze({ id: 'display-p3', name: 'Display P3', bytes: Uint8Array.of(1, 2, 3), colorSpace: 'rgb', wellKnown: 'display-p3', source: 'builtin' });

test('the stub engine: sRGB numbers, no conversion, nothing described (S6.1, S6.5)', async () => {
  const e = P.colorEngine();
  assert.equal(e.id, 'none');
  assert.equal(e.available, false);
  await e.ready();
  assert.equal(e.decodeConversion({ icc: Uint8Array.of(1) }, 'png'), 'default');
  assert.equal(e.displaySpace({}), 'srgb');
  assert.deepEqual(P.SRGB, { id: 'srgb', name: 'sRGB IEC61966-2.1', bytes: null, colorSpace: 'rgb', wellKnown: 'srgb', source: 'builtin' });
  assert.equal(P.workingRGB(), P.SRGB);
  assert.deepEqual(P.convertColor([10, 200, 30], P.SRGB, P3), [10, 200, 30]);
  assert.deepEqual(P.toLab([200, 100, 50], null), rgbToLab(200, 100, 50));
  assert.deepEqual(P.fromLab([60, 20, -30], null), labToRgb(60, 20, -30).map(Math.round));
  assert.equal(P.cssColor([255, 128, 0]), '#ff8000');
  assert.equal(P.describe({ profile: null, depth: 8 }), '');
  assert.equal(P.describe({ profile: P3, depth: 16 }), '');
  assert.deepEqual(P.profilesList(), [P.SRGB]);
  assert.equal(P.profileById('srgb'), P.SRGB);
  assert.equal(P.profileById('nope'), null);
  const canvas = { width: 2, height: 2 };
  assert.equal(await P.toSRGB(canvas, { profile: P3 }), canvas);
  assert.equal(await P.convertCanvas(canvas, P3, P.SRGB), canvas);
  assert.equal(P.displayCanvas(canvas, { profile: P3 }, { space: 'display-p3' }), canvas);
  assert.equal(P.displaySpaceOf({}), 'srgb');
  const view = { compositor: null };
  assert.equal(P.toDisplay(canvas, view), canvas);
});

test('assignProfile is one history entry that swaps doc.profile and says props changed', () => {
  const entries = [];
  const changes = [];
  const doc = { profile: null, history: { push: (e) => entries.push(e) }, changed: (k) => changes.push(k) };
  assert.equal(P.assignProfile(null, doc, P3, 'Assign Profile'), true);
  assert.equal(doc.profile, P3);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].label, 'Assign Profile');
  entries[0].undo();
  assert.equal(doc.profile, null);
  entries[0].redo();
  assert.equal(doc.profile, P3);
  assert.deepEqual(changes, ['props', 'props', 'props']);
  assert.equal(P.assignProfile(null, doc, P3), false); // the same profile: nothing to record
});

test('takeDamage: a token that never took gets full; then the union of what full composites changed; null for nothing', () => {
  const c = new Compositor();
  const a = {}, b = {};
  assert.equal(c.takeDamage(a), 'full');
  assert.equal(c.takeDamage(a), null);
  c.noteDamage({ x: 10, y: 10, width: 5, height: 5 });
  c.noteDamage({ x: 30, y: 0, width: 10, height: 2 });
  assert.deepEqual(c.takeDamage(a), { x: 10, y: 0, width: 30, height: 15 });
  assert.equal(c.takeDamage(a), null);
  assert.equal(c.takeDamage(b), 'full');
  c.noteDamage({ x: 0, y: 0, width: 1, height: 1 });
  c.noteDamage('full');
  assert.equal(c.takeDamage(a), 'full');
  assert.equal(c.takeDamage(b), 'full');
  // a token further behind than the log remembers converts in full
  for (let i = 0; i < 80; i++) c.noteDamage({ x: i, y: 0, width: 1, height: 1 });
  assert.equal(c.takeDamage(a), 'full');
  c.noteDamage({ x: 3, y: 4, width: 1, height: 1 });
  assert.deepEqual(c.takeDamage(a), { x: 3, y: 4, width: 1, height: 1 });
});

test('display stages: in order, inactive ones skipped; the composite gets the view\'s damage, other inputs are scratch', () => {
  const comp = new Compositor();
  const composite = { id: 'composite' };
  comp.full = { canvas: composite };
  const view = { compositor: comp };
  const calls = [];
  const offA = P.registerDisplayStage({ id: 'b-stage', order: 900, active: () => true, apply: (c, v, info) => (calls.push(['b', c.id, info]), { id: `b(${c.id})` }) });
  const offB = P.registerDisplayStage({ id: 'a-stage', order: 100, active: () => true, apply: (c, v, info) => (calls.push(['a', c.id, info]), { id: `a(${c.id})` }) });
  const offC = P.registerDisplayStage({ id: 'off', order: 500, active: () => false, apply: () => assert.fail('inactive') });
  assert.deepEqual(P.displayStages().map((s) => s.id), ['a-stage', 'off', 'b-stage']);
  assert.equal(P.toDisplay(composite, view).id, 'b(a(composite))');
  assert.deepEqual(calls[0], ['a', 'composite', { damage: 'full', scratch: false, source: 'composite' }]);
  assert.equal(calls[1][2].damage, 'full'); // both stages see the same damage
  comp.noteDamage({ x: 1, y: 2, width: 3, height: 4 });
  P.toDisplay(composite, view);
  assert.deepEqual(calls[2][2], { damage: { x: 1, y: 2, width: 3, height: 4 }, scratch: false, source: 'composite' });
  P.toDisplay(composite, view);
  assert.equal(calls[4][2].damage, null);
  // a postProcess output and a gesture preview frame: converted whole, not kept
  P.toDisplay({ id: 'proof' }, view);
  assert.deepEqual(calls[6][2], { damage: 'full', scratch: true, source: 'processed' });
  P.toDisplay(composite, view, { preview: true });
  assert.deepEqual(calls[8][2], { damage: 'full', scratch: true, source: 'preview' });
  offA();
  offB();
  offC();
  assert.equal(P.toDisplay(composite, view), composite);
});

test('a registered engine answers the sync calls once ready; until then the sRGB stub answers', async () => {
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  const engine = {
    id: 'fake', available: true, ready: () => ready,
    parse: (bytes) => (bytes?.[0] === 1 ? P3 : null),
    builtins: () => [P.SRGB, P3],
    profiles: async () => [P.SRGB, P3, { id: 'user-1', name: 'My Monitor', bytes: Uint8Array.of(9), colorSpace: 'rgb', wellKnown: null, source: 'system' }],
    transform: (from, to) => ({ identity: false, apply(src, dst, n) { for (let i = 0; i < n * 4; i += 4) { dst[i] = src[i] ^ 1; dst[i + 1] = src[i + 1]; dst[i + 2] = src[i + 2]; dst[i + 3] = src[i + 3]; } }, from, to }),
    decodeConversion: (chunks) => (chunks.icc ? 'none' : 'default'),
    adoptOnOpen() {},
    displaySpace: () => 'display-p3',
  };
  const emitted = [];
  P.attachColorPipeline({ emit: (e) => emitted.push(e), docs: { list: () => [] } });
  P.setColorEngine(engine);
  assert.equal(P.colorEngine(), engine);
  // before ready(): the stub's answers
  assert.deepEqual(P.convertColor([10, 20, 30], P.SRGB, P3), [10, 20, 30]);
  assert.equal(P.displaySpaceOf({}), 'srgb');
  resolveReady();
  await ready;
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(emitted, ['color:display-changed']);
  assert.deepEqual(P.convertColor([10, 20, 30], P.SRGB, P3), [11, 20, 30]);
  assert.deepEqual(P.convertColor([10, 20, 30], P3, P3), [10, 20, 30]); // the same profile: no transform
  assert.equal(P.displaySpaceOf({}), 'display-p3');
  assert.equal(P.describe({ profile: null, depth: 8 }), 'Untagged RGB');
  assert.equal(P.describe({ profile: P3, depth: 16 }), 'Display P3 (16bpc)');
  assert.deepEqual(P.profilesList().map((p) => p.id), ['srgb', 'display-p3']);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(P.profilesList().map((p) => p.id), ['srgb', 'display-p3', 'user-1']); // OS profiles once listed
  assert.equal(P.profileById('user-1').name, 'My Monitor');
  assert.equal(P.cssColor([1, 2, 3]), '#010203'); // an engine without cssColor: hex
});
