// Regression tests from the 0.3.1 cross-feature hunt, area "layers, automation": the pure parts. An action
// file can only hold what a user could have recorded (no Purge, Quit, Undo… steps), within size limits, and
// without "__proto__" keys in step arguments; a JPEG written by the Image Processor carries the File Info.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../src/renderer/lib/actions/model.js';
import { injectJpegXmp, findXmp, parseXmp, xmpPacket } from '../../src/renderer/lib/file-info.js';

const file = (sets) => JSON.stringify({ format: M.FILE_FORMAT, version: M.FILE_VERSION, sets });
const oneAction = (steps, name = 'A') => [{ name: 'Set', actions: [{ name, steps }] }];

test('steps that run commands recording never records are left out of loaded and stored sets', () => {
  const hostile = [
    { command: 'edit:purge', arg: { what: 'all', confirm: false }, label: 'Blur' },
    { command: 'actions:clear', arg: { force: true }, label: 'Sharpen' },
    { command: 'file:quit', label: 'Levels' },
    { command: 'edit:undo', label: 'Curves' },
    { command: 'file:clear-recent' },
    { command: 'edit:preferences' },
    { command: 'ai:accounts' },
    { command: 'window:panel-layers' },
    { command: 'edit:purge', menuItem: 'edit:purge', label: 'Invert' },
    { command: 'image:adjust-invert', menuItem: 'file:quit', label: 'Invert' }, // the menu item is what would run
    { command: 'image:adjust-invert', label: 'Invert' },
    { command: 'actions:play', arg: { action: 'Other' } },
    { command: 'view:new-guide', arg: { axis: 'x', pos: 5 } },
  ];
  const report = {};
  const sets = M.parseActionsFile(file(oneAction(hostile)), report);
  assert.deepEqual(sets[0].actions[0].steps.map((s) => s.command), ['image:adjust-invert', 'actions:play', 'view:new-guide']);
  assert.equal(report.refused, 10);
  // the same cleaning applies to what the settings hold (a set stored by an earlier version)
  assert.deepEqual(M.normalizeSets(oneAction(hostile))[0].actions[0].steps.map((s) => s.command), ['image:adjust-invert', 'actions:play', 'view:new-guide']);
  // every step kept is one that recording would have accepted
  for (const s of sets[0].actions[0].steps) assert.equal(M.isIgnoredCommand(s.command), false);
});

test('"__proto__", "constructor" and "prototype" keys never survive in a step argument', () => {
  const text = '{"format":"pigment-actions","version":1,"sets":[{"name":"S","actions":[{"name":"A","steps":[{"command":"select:from-layer","arg":{"__proto__":{"polluted":5},"constructor":{"prototype":{"polluted":6}},"type":"name","list":[{"__proto__":{"x":1},"ok":2}]}}]}]}]}';
  const arg = M.parseActionsFile(text)[0].actions[0].steps[0].arg;
  assert.deepEqual(Object.keys(arg).sort(), ['list', 'type']);
  assert.equal(Object.hasOwn(arg, '__proto__'), false);
  assert.equal(Object.getPrototypeOf(arg), Object.prototype);
  assert.deepEqual(Object.keys(arg.list[0]), ['ok']);
  // copying it onto another object changes nothing but the plain fields
  const target = Object.assign({ on: false }, arg);
  assert.equal(target.polluted, undefined);
  assert.equal(Object.getPrototypeOf(target), Object.prototype);
  // cloneData is what the step editor and Duplicate use
  const copy = M.cloneData(JSON.parse('{"a":1,"__proto__":{"b":2},"deep":{"constructor":3,"c":4}}'));
  assert.deepEqual(copy, { a: 1, deep: { c: 4 } });
  assert.equal(copy.b, undefined);
  assert.equal(({}).polluted, undefined);
});

test('an actions file above the limits is refused with a reason; names and labels are clipped', () => {
  // a step argument above what recording stores
  const big = 'x'.repeat(M.MAX_ARG_BYTES + 10);
  assert.throws(() => M.parseActionsFile(file(oneAction([{ command: 'filter:gaussian-blur', arg: { text: big } }]))), /more than 256 KB of settings/);
  // too many steps
  const many = Array.from({ length: M.MAX_ITEMS + 1 }, () => ({ command: 'image:adjust-invert' }));
  assert.throws(() => M.parseActionsFile(file(oneAction(many))), /more than 5000 actions and steps/);
  // too many actions count as well (the panel draws a row for each)
  const actions = Array.from({ length: M.MAX_ITEMS + 1 }, (_, i) => ({ name: `A${i}`, steps: [] }));
  assert.throws(() => M.parseActionsFile(file([{ name: 'S', actions }])), /more than 5000 actions and steps/);
  // many medium-sized arguments add up
  const medium = Array.from({ length: 12 }, () => ({ command: 'filter:gaussian-blur', arg: { text: 'y'.repeat(100_000) } }));
  assert.throws(() => M.parseActionsFile(file(oneAction(medium))), /more than 1 MB of actions/);
  // the raw file size is checked before anything is parsed
  assert.throws(() => M.parseActionsFile(' '.repeat(M.MAX_FILE_BYTES + 1)), /too large/);
  assert.throws(() => M.parseActionsFile(new Uint8Array(M.MAX_FILE_BYTES + 1)), /too large/);
  // long names and labels are cut, not refused
  const long = 'n'.repeat(5000);
  const [set] = M.parseActionsFile(file([{ name: long, actions: [{ name: long, steps: [{ command: 'image:adjust-invert', label: long }, { stop: { message: long } }] }] }]));
  assert.equal(set.name.length, M.MAX_NAME_LENGTH);
  assert.equal(set.actions[0].name.length, M.MAX_NAME_LENGTH);
  assert.equal(set.actions[0].steps[0].label.length, M.MAX_NAME_LENGTH);
  assert.equal(set.actions[0].steps[1].stop.message.length, M.MAX_MESSAGE_LENGTH);
  // limitError is what Load Actions asks about the whole panel
  assert.equal(M.limitError(M.normalizeSets(oneAction([{ command: 'image:adjust-invert' }]))), null);
  assert.match(M.limitError([{ actions: [{ steps: new Array(M.MAX_ITEMS) }] }]), /more than 5000/);
  // an ordinary file still loads, and a recorded selection of the largest size recording allows fits
  const ok = M.parseActionsFile(file(oneAction([{ command: 'actions:set-selection', arg: { mask: 'z'.repeat(M.MAX_ARG_BYTES - 100) } }])));
  assert.equal(ok[0].actions[0].steps.length, 1);
});

test('a Close step keeps the answer to "Save changes?" through a file round trip', () => {
  const sets = [M.makeSet('S', [M.makeAction('A', [M.makeStep('file:close', { save: false }, 'Close: don’t save')])])];
  const back = M.parseActionsFile(M.serializeSets(sets));
  assert.deepEqual(back[0].actions[0].steps[0].arg, { save: false });
  assert.equal(M.recordDecision({ id: 'file:close', arg: { save: true }, source: 'menu', cancelled: false, replayable: true }).record, true);
});

test('a multi-layer pick is a plain-data step argument that round-trips', () => {
  const arg = { name: 'B', index: 2, also: [{ name: 'A', index: 1 }] };
  const d = M.recordDecision({ id: 'actions:select-layer', arg, source: 'panel', cancelled: false, replayable: true });
  assert.equal(d.record, true);
  const back = M.parseActionsFile(M.serializeSets([M.makeSet('S', [M.makeAction('A', [d.step])])]));
  assert.deepEqual(back[0].actions[0].steps[0].arg, arg);
});

test('injectJpegXmp adds the File Info packet behind the JFIF header and leaves other bytes alone', () => {
  // SOI, APP0 (JFIF, 16 bytes), a quantisation table marker, EOI
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xdb, 0x00, 0x02, 0xff, 0xd9]);
  const packet = xmpPacket({ title: 'T & <x>', copyright: 'IP (c) Me', keywords: ['a', 'b c'] });
  const out = injectJpegXmp(jpeg, packet);
  assert.notEqual(out, jpeg);
  // the segment sits right after APP0 and states its own length
  assert.deepEqual([...out.subarray(0, 20)], [...jpeg.subarray(0, 20)]);
  assert.deepEqual([out[20], out[21]], [0xff, 0xe1]);
  const length = (out[22] << 8) | out[23];
  assert.equal(out.length, jpeg.length + 2 + length);
  assert.equal(new TextDecoder().decode(out.subarray(24, 24 + 29)), 'http://ns.adobe.com/xap/1.0/\0');
  assert.deepEqual([...out.subarray(20 + 2 + length)], [...jpeg.subarray(20)]);
  const info = parseXmp(findXmp(out));
  assert.equal(info.title, 'T & <x>');
  assert.equal(info.copyright, 'IP (c) Me');
  assert.deepEqual(info.keywords, ['a', 'b c']);
  // already stamped, not a JPEG, no packet, or a packet too large for one segment: the same array comes back
  assert.equal(injectJpegXmp(out, packet), out);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  assert.equal(injectJpegXmp(png, packet), png);
  assert.equal(injectJpegXmp(jpeg, ''), jpeg);
  assert.equal(injectJpegXmp(jpeg, `<x:xmpmeta>${'k'.repeat(70_000)}</x:xmpmeta>`), jpeg);
});

// ---- review of the hunt fixes -----------------------------------------------------------------------------------

test('Save Actions writes a file that Load Actions accepts for any set the panel holds (long selection runs)', () => {
  // eight recorded selections of about 26 600 run numbers each: within MAX_ARG_BYTES per step and MAX_SETS_BYTES in
  // all, but one indented line per number would make the file several times MAX_FILE_BYTES
  const runs = Array.from({ length: 26_602 }, (_, i) => (i % 2 ? (i * 7) % 300 : (i * 13) % 256));
  const steps = [];
  for (let i = 0; i < 8; i++) {
    steps.push(M.makeStep('actions:set-selection', { width: 4000, height: 3000, units: 'px', runs }, 'Set Selection'));
    steps.push(M.makeStep('image:adjust-levels', { black: 10, white: 240, gamma: 1.1 }, 'Levels'));
  }
  const sets = [M.makeSet('Retouch', [M.makeAction('Eight ovals', steps)])];
  assert.equal(M.limitError(sets), null);
  const text = M.serializeSets(sets);
  assert.ok(new TextEncoder().encode(text).length <= M.MAX_FILE_BYTES);
  const back = M.parseActionsFile(new TextEncoder().encode(text));
  assert.equal(back[0].actions[0].steps.length, 16);
  assert.deepEqual(back[0].actions[0].steps[0].arg.runs, runs);
  // a small set stays indented for people who read it
  assert.match(M.serializeSets([M.makeSet('S', [M.makeAction('A', [M.makeStep('image:adjust-invert')])])]), /\n {2}"format"/);
});

test('settleLinks remembers every dissolved link set, so Undo past two of them makes the first whole again', async () => {
  const { settleLinks } = await import('../../src/renderer/lib/layers-extras/tags.js');
  const A = { name: 'A', linked: 'K1' }, B = { name: 'B', linked: 'K1' }, C = { name: 'C', linked: null };
  let layers = [A, B, C];
  const doc = { root: {}, layers: () => layers };
  // B deleted: A is left alone in K1
  layers = [A, C];
  assert.equal(settleLinks(doc), true);
  assert.equal(A.linked, null);
  // A and C linked (K2), then C deleted: A remembers both sets
  A.linked = C.linked = 'K2';
  assert.equal(settleLinks(doc), false);
  layers = [A];
  settleLinks(doc);
  assert.equal(A.linked, null);
  // Undo: C comes back (K2 whole again), the Link of A and C is undone, B comes back (K1 whole again)
  layers = [A, C];
  settleLinks(doc);
  assert.equal(A.linked, 'K2');
  A.linked = C.linked = null;
  settleLinks(doc);
  layers = [A, B, C];
  assert.equal(settleLinks(doc), true);
  assert.deepEqual(layers.map((l) => l.linked ?? null), ['K1', 'K1', null]);
  // a layer linked elsewhere does not keep a remembered set alive for a returning partner
  const D = { name: 'D', linked: 'K9' }, E = { name: 'E', linked: 'K3', loneLink: ['K9'] };
  layers = [D, E];
  settleLinks(doc);
  assert.equal(D.linked, null);
  assert.equal(E.linked, null);
});
