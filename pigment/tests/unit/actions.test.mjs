// Actions and automation: the pure parts (recording rules, conditionals, the JSON action file, function
// keys, file naming tokens, fitting, the contact sheet grid, selection step data, Crop and Straighten).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../src/renderer/lib/actions/model.js';
import * as N from '../../src/renderer/lib/automate/naming.js';
import * as S from '../../src/renderer/lib/actions/selection-data.js';
import * as Scan from '../../src/renderer/lib/automate/scan.js';
import { createImage, setPixel } from '../../src/shared/pixels/core.js';

const done = (id, extra = {}) => ({ id, arg: undefined, source: 'menu', cancelled: false, replayable: true, ...extra });

// ---- recording rules ------------------------------------------------------------------------------------------

test('a finished command becomes a step with its replay argument and label', () => {
  const d = M.recordDecision(done('filter:gaussian-blur', { arg: { radius: 3 } }), { label: 'Gaussian Blur' });
  assert.equal(d.record, true);
  assert.equal(d.step.command, 'filter:gaussian-blur');
  assert.deepEqual(d.step.arg, { radius: 3 });
  assert.equal(d.step.label, 'Gaussian Blur');
  assert.equal(d.step.enabled, true);
  assert.equal(d.step.dialog, false);
  assert.match(d.step.id, /^s/);
  // a command without an argument stores none (the key is absent, so JSON stays small)
  const plain = M.recordDecision(done('image:adjust-invert'));
  assert.equal('arg' in plain.step, false);
  assert.equal(plain.step.label, 'Invert');
});

test('the step keeps a copy of the argument, not the object the command may go on changing', () => {
  const arg = { points: [[0, 0], [255, 255]] };
  const d = M.recordDecision(done('image:adjust-curves', { arg }));
  arg.points.push([1, 2]);
  assert.deepEqual(d.step.arg, { points: [[0, 0], [255, 255]] });
});

test('cancelled dialogs, playback, nested runs, viewing and tool switching are not recorded', () => {
  const reason = (e) => M.recordDecision(e).reason;
  assert.equal(reason(done('image:size', { cancelled: true })), 'cancelled');
  assert.equal(reason(done('filter:invert', { source: 'action' })), 'playback');
  assert.equal(reason(done('edit:transform', { arg: 'flip-h', nested: true })), 'nested');
  for (const id of ['view:zoom-in', 'window:panel-layers', 'help:about', 'tool:brush', 'tool:select', 'app:enter', 'actions:record', 'edit:undo', 'edit:redo', 'edit:preferences', 'file:print']) {
    assert.equal(reason(done(id)), 'ignored', id);
  }
  // guides and the colour swatches are recorded although they live in the view / tool groups
  for (const id of ['view:new-guide', 'view:clear-guides', 'tool:swap-colors', 'tool:default-colors']) assert.equal(M.recordDecision(done(id)).record, true, id);
  assert.deepEqual(M.recordDecision(done('tool:fg-color', { arg: '#ff0000' })).step.arg, '#ff0000');
});

test('commands that only open an on-canvas session are left to the session commit', () => {
  for (const id of ['edit:free-transform', 'edit:transform-scale', 'edit:transform-warp', 'edit:puppet-warp', 'select:transform']) assert.equal(M.recordDecision(done(id)).reason, 'session', id);
  assert.equal(M.recordDecision(done('edit:transform', { arg: 'rotate' })).reason, 'session');
  assert.equal(M.recordDecision(done('edit:transform')).reason, 'session');
  // the immediate transforms are ordinary steps
  assert.equal(M.recordDecision(done('edit:transform', { arg: 'flip-h' })).record, true);
  assert.equal(M.recordDecision(done('edit:transform-rotate-90')).record, true);
});

test('a dialog command without a replayable form, or with settings JSON cannot hold, is refused with its label', () => {
  const u = M.recordDecision(done('layer:style', { replayable: false }), { label: 'Layer Style' });
  assert.deepEqual([u.record, u.reason, u.label], [false, 'unreplayable', 'Layer Style']);
  const fn = M.recordDecision(done('filter:custom', { arg: { kernel: () => 1 } }));
  assert.equal(fn.reason, 'data');
  const nan = M.recordDecision(done('filter:custom', { arg: { v: NaN } }));
  assert.equal(nan.reason, 'data');
  class Canvas {}
  assert.equal(M.recordDecision(done('edit:fill', { arg: { pattern: new Canvas() } })).reason, 'data');
  const huge = M.recordDecision(done('select:load', { arg: { mask: 'x'.repeat(M.MAX_ARG_BYTES + 1) } }));
  assert.equal(huge.reason, 'data');
});

test('labels: the known label loses its ellipsis, string arguments name the variant, ids are made readable', () => {
  assert.equal(M.commandLabel('edit:fill', undefined, 'Fill…'), 'Fill');
  assert.equal(M.commandLabel('layer:mask', 'reveal-all', 'Layer mask'), 'Layer mask: reveal all');
  assert.equal(M.commandLabel('image:depth', 16, 'Bits/Channel'), 'Bits/Channel: 16');
  assert.equal(M.commandLabel('layer:via-copy'), 'Via Copy');
  assert.equal(M.commandLabel('image:adjust-hue-saturation'), 'Hue Saturation');
  assert.equal(M.commandLabel('file:open-paths', '/a/b.png', 'Open'), 'Open'); // paths are not variants
  assert.equal(M.describeArg({ radius: 3.14159, mode: 'normal', nested: { a: 1 } }), 'radius: 3.14, mode: normal');
  assert.equal(M.describeArg([1, 2, 3]), '1, 2, 3');
  assert.equal(M.describeArg(undefined), '');
  assert.equal(M.describeArg('x'.repeat(100), 10).length, 10);
});

test('step kinds decide how a step plays', () => {
  assert.equal(M.stepKind(M.makeStep('filter:invert')), 'command');
  assert.equal(M.stepKind({ ...M.makeStep('image:size', { width: 10 }), dialog: true }), 'dialog');
  assert.equal(M.stepKind(M.makeMenuItemStep('image:size', 'Image Size')), 'dialog');
  assert.equal(M.stepKind(M.makeStopStep('Check the image', true)), 'stop');
  assert.equal(M.stepKind(M.makeConditionalStep('selection-exists', 'A', null)), 'conditional');
  assert.deepEqual(M.makeStopStep('Hi', 1).stop, { message: 'Hi', allowContinue: true });
});

// ---- conditionals -----------------------------------------------------------------------------------------------

test('conditional tests read the document state', () => {
  const landscape = { open: true, width: 400, height: 300, mode: 'rgb', depth: 8, layers: 2, hasSelection: true, channels: 0, layer: { type: 'raster', background: true, mask: false, visible: true, locked: false, styles: false, group: false } };
  const portrait = { ...landscape, width: 300, height: 400, mode: 'grayscale', hasSelection: false, layers: 1, layer: { type: 'text', background: false, mask: true, visible: false, locked: true, styles: true, group: false } };
  const t = (id, s) => M.evaluateCondition(id, s);
  assert.deepEqual([t('document-is-landscape', landscape), t('document-is-landscape', portrait)], [true, false]);
  assert.deepEqual([t('document-is-portrait', landscape), t('document-is-portrait', portrait)], [false, true]);
  assert.equal(t('document-is-square', { open: true, width: 5, height: 5 }), true);
  assert.deepEqual([t('document-mode-is-rgb', landscape), t('document-mode-is-rgb', portrait), t('document-mode-is-grayscale', portrait)], [true, false, true]);
  assert.deepEqual([t('selection-exists', landscape), t('selection-exists', portrait)], [true, false]);
  assert.deepEqual([t('document-has-layers', landscape), t('document-has-layers', portrait)], [true, false]);
  assert.deepEqual([t('layer-is-background', landscape), t('layer-is-background', portrait)], [true, false]);
  assert.deepEqual([t('layer-has-mask', landscape), t('layer-has-mask', portrait)], [false, true]);
  assert.deepEqual([t('layer-is-pixel', landscape), t('layer-is-pixel', portrait)], [true, false]);
  assert.deepEqual([t('layer-is-text', landscape), t('layer-is-text', portrait)], [false, true]);
  assert.deepEqual([t('layer-is-visible', landscape), t('layer-is-visible', portrait)], [true, false]);
  assert.deepEqual([t('layer-is-locked', landscape), t('layer-has-effects', portrait)], [false, true]);
});

test('without a document or a layer every test is false, and so is an unknown test', () => {
  for (const id of M.CONDITION_IDS) {
    assert.equal(M.evaluateCondition(id, { open: false, layer: null }), false, id);
    assert.equal(M.evaluateCondition(id, undefined), false, id);
  }
  assert.equal(M.evaluateCondition('layer-is-on-fire', { open: true, layer: {} }), false);
  // the contract's ids exist
  for (const id of ['document-is-landscape', 'layer-is-background', 'layer-has-mask', 'layer-is-pixel', 'selection-exists', 'document-mode-is-rgb', 'layer-is-visible', 'layer-is-text']) assert.ok(M.CONDITIONS[id], id);
});

test('a conditional picks the action of its branch, or nothing', () => {
  const c = { test: 'document-is-landscape', thenAction: 'Wide', elseAction: 'Tall' };
  assert.equal(M.conditionalBranch(c, { open: true, width: 2, height: 1 }), 'Wide');
  assert.equal(M.conditionalBranch(c, { open: true, width: 1, height: 2 }), 'Tall');
  assert.equal(M.conditionalBranch({ ...c, elseAction: null }, { open: true, width: 1, height: 2 }), null);
  assert.equal(M.makeConditionalStep('document-is-landscape', 'Wide', '').label, 'If Document Is Landscape');
});

// ---- sets and files -----------------------------------------------------------------------------------------------

function sampleSets() {
  const a = M.makeAction('Soften', [
    M.makeStep('image:adjust-levels', { black: 10, white: 240, gamma: 1.2 }, 'Levels'),
    { ...M.makeStep('filter:gaussian-blur', { radius: 2.5 }, 'Gaussian Blur'), dialog: true },
    { ...M.makeStep('image:adjust-invert', undefined, 'Invert'), enabled: false },
    M.makeStopStep('Look at the result', true),
    M.makeMenuItemStep('image:size', 'Image Size'),
    M.makeConditionalStep('document-is-landscape', 'Other', null),
  ], { functionKey: { key: 'F5', shift: true, ctrl: false }, color: 'red' });
  return [M.makeSet('My Set', [a, M.makeAction('Other', [M.makeStep('image:flatten')])])];
}

test('an actions file round-trips: names, order, arguments, flags, stops, menu items, conditionals, keys and colours', () => {
  const sets = sampleSets();
  const text = M.serializeSets(sets);
  const json = JSON.parse(text);
  assert.equal(json.format, 'pigment-actions');
  assert.equal(json.version, 1);
  const back = M.parseActionsFile(text);
  assert.equal(back.length, 1);
  assert.equal(back[0].name, 'My Set');
  assert.deepEqual(back[0].actions.map((a) => a.name), ['Soften', 'Other']);
  const [a] = back[0].actions;
  assert.deepEqual(a.functionKey, { key: 'F5', shift: true, ctrl: false });
  assert.equal(a.color, 'red');
  assert.deepEqual(a.steps.map((s) => s.command), ['image:adjust-levels', 'filter:gaussian-blur', 'image:adjust-invert', null, 'image:size', null]);
  assert.deepEqual(a.steps[0].arg, { black: 10, white: 240, gamma: 1.2 });
  assert.deepEqual(a.steps.map((s) => s.enabled), [true, true, false, true, true, true]);
  assert.deepEqual(a.steps.map((s) => s.dialog), [false, true, false, false, true, false]);
  assert.deepEqual(a.steps[3].stop, { message: 'Look at the result', allowContinue: true });
  assert.equal(a.steps[4].menuItem, 'image:size');
  assert.deepEqual(a.steps[5].conditional, { test: 'document-is-landscape', thenAction: 'Other', elseAction: null });
  assert.deepEqual(a.steps.map((s) => s.label), ['Levels', 'Gaussian Blur', 'Invert', 'Stop', 'Image Size', 'If Document Is Landscape']);
  // a second round trip is byte-identical: nothing is lost or invented along the way
  assert.equal(M.serializeSets(back), text);
  // bytes work like text, with or without a BOM
  assert.equal(M.parseActionsFile(new TextEncoder().encode(`\uFEFF${text}`))[0].actions.length, 2);
});

test('loading a file gives fresh ids, so the same file can be loaded twice', () => {
  const text = M.serializeSets(sampleSets());
  const one = M.parseActionsFile(text), two = M.parseActionsFile(text);
  const ids = (sets) => sets.flatMap((s) => [s.id, ...s.actions.flatMap((a) => [a.id, ...a.steps.map((st) => st.id)])]);
  const all = [...ids(one), ...ids(two)];
  assert.equal(new Set(all).size, all.length);
});

test('files that are not Pigment actions are refused with a reason; Photoshop .atn files are named', () => {
  assert.throws(() => M.parseActionsFile('not json'), /not valid JSON/);
  assert.throws(() => M.parseActionsFile('{"sets":[]}'), /not a Pigment actions file/);
  assert.throws(() => M.parseActionsFile(JSON.stringify({ format: 'pigment-actions', version: 99, sets: [{}] })), /newer version/);
  assert.throws(() => M.parseActionsFile(JSON.stringify({ format: 'pigment-actions', version: 1, sets: [] })), /no action sets/);
  const atn = new Uint8Array([0, 0, 0, 0x10, 0, 0, 0, 5, 0, 0x41, 0, 0x42]);
  assert.equal(M.looksLikeAtn(atn), true);
  assert.throws(() => M.parseActionsFile(atn), /\.atn action files cannot be read/);
});

test('normalizeSets repairs stored data: missing ids, bad steps, unknown keys and colours, duplicate ids', () => {
  const sets = M.normalizeSets([
    { name: 'A', actions: [{ name: 'One', functionKey: { key: 'F1' }, color: 'pink', steps: [{ command: 'filter:invert' }, { nothing: true }, null, { command: 'x', arg: { deep: [1, { a: 'b' }] }, enabled: false }, { id: 'dup', command: 'y' }, { id: 'dup', command: 'z' }] }, 'junk'] },
    null,
    { actions: 'nope' },
  ]);
  assert.equal(sets.length, 2);
  assert.equal(sets[1].name, 'Set');
  assert.deepEqual(sets[1].actions, []);
  const a = sets[0].actions[0];
  assert.equal(sets[0].actions.length, 1);
  assert.equal(a.functionKey, undefined); // F1 is not offered
  assert.equal(a.color, undefined);
  assert.deepEqual(a.steps.map((s) => s.command), ['filter:invert', 'x', 'y', 'z']);
  assert.deepEqual(a.steps[1].arg, { deep: [1, { a: 'b' }] });
  assert.equal(a.steps[1].enabled, false);
  assert.equal(new Set(a.steps.map((s) => s.id)).size, 4);
  assert.equal(a.steps[0].label, 'Invert');
  assert.deepEqual(M.normalizeSets(undefined), []);
});

test('duplicating an action or a set copies the steps with new ids and frees the function key', () => {
  const [set] = sampleSets();
  const copy = M.duplicateAction(set.actions[0]);
  assert.equal(copy.name, 'Soften copy');
  assert.equal(copy.functionKey, undefined);
  assert.notEqual(copy.id, set.actions[0].id);
  assert.deepEqual(copy.steps.map((s) => s.command), set.actions[0].steps.map((s) => s.command));
  assert.ok(copy.steps.every((s, i) => s.id !== set.actions[0].steps[i].id));
  copy.steps[0].arg.black = 99;
  assert.equal(set.actions[0].steps[0].arg.black, 10);
  const setCopy = M.duplicateSet(set);
  assert.equal(setCopy.actions.length, 2);
  assert.notEqual(setCopy.actions[1].id, set.actions[1].id);
});

test('finding actions and steps, unique names', () => {
  const sets = sampleSets();
  const [set] = sets;
  assert.equal(M.findAction(sets, set.actions[1].id).action.name, 'Other');
  assert.equal(M.findAction(sets, 'nope'), null);
  assert.equal(M.findStep(sets, set.actions[0].steps[2].id).index, 2);
  assert.equal(M.findActionByName(sets, 'Other', set).action, set.actions[1]);
  assert.equal(M.findActionByName(sets, 'Missing'), null);
  assert.equal(M.uniqueName('Action 1', ['Action 1', 'Action 2']), 'Action 3');
  assert.equal(M.uniqueName('Set', ['Set']), 'Set 2');
  assert.equal(M.uniqueName('Free', ['Taken']), 'Free');
});

// ---- function keys ------------------------------------------------------------------------------------------------

test('function keys match exactly their modifiers and never while Alt is held', () => {
  const fk = { key: 'F5', shift: true, ctrl: false };
  const ev = (key, mods = {}) => ({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods });
  assert.equal(M.matchesFunctionKey(ev('F5', { shiftKey: true }), fk), true);
  assert.equal(M.matchesFunctionKey(ev('F5'), fk), false);
  assert.equal(M.matchesFunctionKey(ev('F5', { shiftKey: true, ctrlKey: true }), fk), false);
  assert.equal(M.matchesFunctionKey(ev('F5', { shiftKey: true, altKey: true }), fk), false);
  assert.equal(M.matchesFunctionKey(ev('F6', { shiftKey: true }), fk), false);
  // Ctrl means Command on macOS
  const c = { key: 'F7', shift: false, ctrl: true };
  assert.equal(M.matchesFunctionKey(ev('F7', { ctrlKey: true }), c, false), true);
  assert.equal(M.matchesFunctionKey(ev('F7', { metaKey: true }), c, true), true);
  assert.equal(M.matchesFunctionKey(ev('F7', { ctrlKey: true }), c, true), false);
  assert.equal(M.functionKeyLabel(fk), 'Shift+F5');
  assert.equal(M.functionKeyLabel({ key: 'f7', shift: true, ctrl: true }), 'Shift+Ctrl+F7');
  assert.equal(M.functionKeyLabel({ key: 'F1' }), '');
  assert.equal(M.normalizeFunctionKey({ key: 'F13' }), null);
});

test('a function key plays the first action bound to it and knows its owner', () => {
  const sets = sampleSets();
  const ev = { key: 'F5', shiftKey: true, ctrlKey: false, metaKey: false, altKey: false };
  assert.equal(M.actionForKey(sets, ev).action.name, 'Soften');
  assert.equal(M.actionForKey(sets, { ...ev, shiftKey: false }), null);
  assert.equal(M.functionKeyOwner(sets, { key: 'F5', shift: true }).name, 'Soften');
  assert.equal(M.functionKeyOwner(sets, { key: 'F5', shift: true }, sets[0].actions[0]), null);
  assert.equal(M.functionKeyOwner(sets, { key: 'F6' }), null);
});

// ---- file naming --------------------------------------------------------------------------------------------------

const date = new Date(2026, 10, 11); // 11 November 2026

test('file naming tokens: document name in three cases, serial numbers, letters, dates and the extension', () => {
  const ctx = { name: 'Beach Photo', ext: 'JPG', serial: 7, date };
  const n = (...tokens) => N.buildFileName(tokens, ctx);
  assert.equal(n('name', 'ext'), 'Beach Photo.jpg');
  assert.equal(n('name-lower', 'ext'), 'beach photo.jpg');
  assert.equal(n('name-upper', 'ext-upper'), 'BEACH PHOTO.JPG');
  assert.equal(n('name', '_', 'serial-3', 'ext'), 'Beach Photo_007.jpg');
  assert.equal(n('serial-1', 'ext'), '7.jpg');
  assert.equal(n('serial-2', 'ext'), '07.jpg');
  assert.equal(n('serial-4', 'ext'), '0007.jpg');
  assert.equal(n('name', 'letter-lower', 'ext'), 'Beach Photog.jpg');
  assert.equal(n('letter-upper', 'ext'), 'G.jpg');
  assert.equal(n('mmddyy', 'ext'), '111126.jpg');
  assert.equal(n('mmdd', 'ext'), '1111.jpg');
  assert.equal(n('yyyymmdd', 'ext'), '20261111.jpg');
  assert.equal(n('yymmdd', 'ext'), '261111.jpg');
  assert.equal(n('yyddmm', 'ext'), '261111.jpg');
  assert.equal(n('ddmmyy', 'ext'), '111126.jpg');
  assert.equal(n('ddmm', 'ext'), '1111.jpg');
  // a different day and month tell the date orders apart
  const d2 = { ...ctx, date: new Date(2031, 0, 9) };
  assert.equal(N.buildFileName(['mmddyy', '-', 'ddmmyy', '-', 'yyddmm', 'ext'], d2), '010931-090131-310901.jpg');
  // serials wider than their field keep all digits
  assert.equal(N.buildFileName(['serial-2', 'ext'], { ...ctx, serial: 123 }), '123.jpg');
});

test('the extension always ends the name; None and empty fields add nothing; illegal characters are replaced', () => {
  const ctx = { name: 'a', ext: 'png', serial: 1, date };
  assert.equal(N.buildFileName(['name', 'none', '', null, 'serial-2'], ctx), 'a01.png'); // no extension field: appended
  assert.equal(N.buildFileName(['ext', 'name'], ctx), 'a.png'); // extension first: moved to the end
  assert.equal(N.buildFileName(['name', 'ext', '_web'], ctx), 'a_web.png');
  assert.equal(N.buildFileName(['none'], ctx), 'a.png'); // an empty scheme falls back to the document name
  assert.equal(N.buildFileName(['web/', 'name', ':v?', 'ext'], ctx), 'web-a-v-.png');
  assert.equal(N.buildFileName(['name'], { name: 'x', ext: '', serial: 1, date }), 'x');
  assert.equal(N.isNameToken('serial-3'), true);
  assert.equal(N.isNameToken('_web'), false);
  assert.equal(N.namingIsUnique(['mmddyy', 'ext']), false);
  assert.equal(N.namingIsUnique(['mmddyy', 'serial-2', 'ext']), true);
  assert.equal(N.namingIsUnique(N.DEFAULT_NAMING), true);
});

test('serial letters continue past z like spreadsheet columns', () => {
  assert.deepEqual([1, 2, 26, 27, 28, 52, 53, 702, 703].map(N.serialLetter), ['a', 'b', 'z', 'aa', 'ab', 'az', 'ba', 'zz', 'aaa']);
});

test('destination names never collide (case-insensitively), paths join with the folder separator', () => {
  const taken = new Set(['a.png', 'a-2.png']);
  assert.equal(N.uniqueFileName('A.png', taken), 'A-3.png');
  assert.equal(N.uniqueFileName('b.png', taken), 'b.png');
  assert.equal(N.joinPath('/out', 'a.png'), '/out/a.png');
  assert.equal(N.joinPath('/out/', 'a.png'), '/out/a.png');
  assert.equal(N.joinPath('C:\\out', 'a.png'), 'C:\\out\\a.png');
  assert.equal(N.joinPath('browser:/dest', 'a.png'), 'browser:/dest/a.png');
  assert.equal(N.dirName('/a/b/c.png'), '/a/b');
  assert.deepEqual(N.splitName('/x/photo.final.JPG'), { name: 'photo.final', ext: 'JPG' });
  assert.deepEqual(N.splitName('README'), { name: 'README', ext: '' });
});

// ---- fit image, contact sheet ---------------------------------------------------------------------------------------

test('fitSize keeps the proportions inside the box and can refuse to enlarge', () => {
  assert.deepEqual(N.fitSize(4000, 3000, 800, 800), { width: 800, height: 600, scale: 0.2 });
  assert.deepEqual(N.fitSize(3000, 4000, 800, 800), { width: 600, height: 800, scale: 0.2 });
  assert.deepEqual(N.fitSize(400, 300, 800, 800), { width: 800, height: 600, scale: 2 });
  assert.deepEqual(N.fitSize(400, 300, 800, 800, { enlarge: false }), { width: 400, height: 300, scale: 1 });
  assert.deepEqual(N.fitSize(400, 300, 200, 0), { width: 200, height: 150, scale: 0.5 }); // 0 = that side is free
  assert.deepEqual(N.fitSize(10, 1000, 5, 5), { width: 1, height: 5, scale: 0.005 }); // never below one pixel
});

test('contact sheet grid: cells tile the page inside the margin, captions take their line', () => {
  const L = N.contactSheetLayout({ width: 1000, height: 800, columns: 4, rows: 3, spacing: 20, caption: true, fontSize: 12 });
  assert.equal(L.perPage, 12);
  assert.equal(L.cellWidth, (1000 - 40 - 60) / 4); // 225
  assert.equal(L.cellHeight, Math.floor((800 - 40 - 40) / 3)); // 240
  assert.equal(L.captionHeight, 18);
  assert.equal(L.imageHeight, 222);
  assert.deepEqual(L.cells[0], { x: 20, y: 20, width: 225, height: 222, captionY: 242 });
  assert.deepEqual([L.cells[1].x, L.cells[1].y], [265, 20]); // across first
  assert.deepEqual([L.cells[4].x, L.cells[4].y], [20, 280]);
  const last = L.cells[11];
  assert.ok(last.x + last.width <= 1000 - 20 && last.captionY + L.captionHeight <= 800 - 20);
  // down first
  const D = N.contactSheetLayout({ width: 1000, height: 800, columns: 4, rows: 3, spacing: 20, across: false });
  assert.deepEqual([D.cells[1].x, D.cells[1].y], [20, 280]);
  assert.equal(D.captionHeight, 0);
});

test('thumbnails are centred in their cell and turn when that makes them larger', () => {
  const cell = { x: 100, y: 50, width: 200, height: 100 };
  assert.deepEqual(N.placeThumbnail(cell, 400, 100), { x: 100, y: 75, width: 200, height: 50, rotated: false, scale: 0.5 });
  const tall = N.placeThumbnail(cell, 100, 400);
  assert.deepEqual([tall.width, tall.height, tall.rotated], [25, 100, false]);
  const turned = N.placeThumbnail(cell, 100, 400, { rotate: true });
  assert.deepEqual([turned.width, turned.height, turned.rotated, turned.x, turned.y], [200, 50, true, 100, 75]);
  assert.equal(N.placeThumbnail(cell, 400, 100, { rotate: true }).rotated, false);
  assert.deepEqual(N.paginate([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

// ---- selection step data --------------------------------------------------------------------------------------------

function maskSelection(width, height, fn) {
  const mask = new Uint8ClampedArray(width * height);
  let x1 = width, y1 = height, x2 = -1, y2 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const v = fn(x, y);
    mask[y * width + x] = v;
    if (v) {
      x1 = Math.min(x1, x); x2 = Math.max(x2, x); y1 = Math.min(y1, y); y2 = Math.max(y2, y);
    }
  }
  return { width, height, mask, bounds: x2 < 0 ? null : { x: x1, y: y1, width: x2 - x1 + 1, height: y2 - y1 + 1 } };
}

test('a rectangular selection is stored as a rectangle, anything else as runs; both replay exactly', () => {
  const rect = maskSelection(40, 30, (x, y) => (x >= 5 && x < 25 && y >= 10 && y < 20 ? 255 : 0));
  const a = S.encodeSelection(rect, { width: 40, height: 30 });
  assert.deepEqual(a, { width: 40, height: 30, units: 'px', rect: [5, 10, 20, 10] });
  assert.deepEqual([...S.selectionMask(a, 40, 30)], [...rect.mask]);
  const disc = maskSelection(40, 30, (x, y) => (Math.hypot(x - 20, y - 15) < 9 ? 255 : Math.hypot(x - 20, y - 15) < 10 ? 128 : 0));
  const b = S.encodeSelection(disc, { width: 40, height: 30 });
  assert.ok(Array.isArray(b.runs) && !b.rect);
  assert.ok(b.runs.length < 40 * 30 / 4, `runs ${b.runs.length}`);
  assert.deepEqual([...S.selectionMask(b, 40, 30)], [...disc.mask]);
  assert.equal(S.encodeSelection(null, { width: 4, height: 4 }), null);
  assert.equal(S.encodeSelection(maskSelection(4, 4, () => 0), { width: 4, height: 4 }), null);
  assert.equal(S.selectionMask(null, 4, 4), null);
});

test('run-length coding is lossless and a noisy mask is refused instead of bloating the settings', () => {
  const m = Uint8ClampedArray.from([0, 0, 255, 255, 255, 7, 0, 0, 0]);
  assert.deepEqual(S.encodeRuns(m), [0, 2, 255, 3, 7, 1, 0, 3]);
  assert.deepEqual([...S.decodeRuns(S.encodeRuns(m), m.length)], [...m]);
  const noise = maskSelection(300, 300, (x, y) => ((x * 7 + y * 13) % 5 ? 255 : 0));
  assert.equal(S.encodeSelection(noise, { width: 300, height: 300 }), undefined);
});

test('pixel selections keep their place in a larger document, percent selections scale with it', () => {
  const px = { width: 40, height: 30, units: 'px', rect: [5, 10, 20, 10] };
  const big = S.selectionMask(px, 80, 60);
  assert.equal(big[10 * 80 + 5], 255);
  assert.equal(big[19 * 80 + 24], 255);
  assert.equal(big[20 * 80 + 24], 0);
  assert.equal(big.reduce((s, v) => s + (v ? 1 : 0), 0), 200);
  const pc = S.selectionMask({ ...px, units: 'percent' }, 80, 60);
  assert.equal(pc.reduce((s, v) => s + (v ? 1 : 0), 0), 800);
  assert.equal(pc[20 * 80 + 10], 255);
  assert.equal(pc[19 * 80 + 10], 0);
  // a pixel selection that lies outside a smaller document is clipped, not wrapped
  const small = S.selectionMask(px, 10, 15);
  assert.equal(small.reduce((s, v) => s + (v ? 1 : 0), 0), 5 * 5);
  // runs scale too
  const disc = S.encodeSelection(maskSelection(20, 20, (x, y) => (Math.hypot(x - 9.5, y - 9.5) < 6 ? 255 : 0)), { width: 20, height: 20, units: 'percent' });
  const scaled = S.selectionMask(disc, 40, 40);
  const area = scaled.reduce((s, v) => s + (v ? 1 : 0), 0);
  assert.ok(Math.abs(area - Math.PI * 12 * 12) < 40, `area ${area}`);
});

// ---- crop and straighten --------------------------------------------------------------------------------------------

/** Scanner bed with rotated rectangles: [{ cx, cy, w, h, deg, color }] */
function scan(width, height, photos, bg = [250, 250, 250, 1]) {
  const img = createImage(width, height, bg);
  for (const p of photos) {
    const r = (p.deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const dx = x + 0.5 - p.cx, dy = y + 0.5 - p.cy;
      const u = dx * c + dy * s, v = -dx * s + dy * c;
      if (Math.abs(u) <= p.w / 2 && Math.abs(v) <= p.h / 2) setPixel(img, x, y, p.color ?? [40, 90, 160, 1]);
    }
  }
  return img;
}

test('the border colour is the most common colour along the edge', () => {
  const img = scan(60, 40, [{ cx: 30, cy: 20, w: 20, h: 10, deg: 0 }]);
  assert.deepEqual(Scan.borderColor(img), [250, 250, 250, 255]);
  // a photo touching one edge does not win over the bed
  const touching = scan(60, 40, [{ cx: 10, cy: 20, w: 20, h: 30, deg: 0 }]);
  assert.deepEqual(Scan.borderColor(touching), [250, 250, 250, 255]);
});

test('convex hull and minimum-area rectangle recover a rotated rectangle', () => {
  const hull = Scan.convexHull([[0, 0], [4, 0], [4, 3], [0, 3], [2, 1], [1, 2], [4, 0]]);
  assert.equal(hull.length, 4);
  const straight = Scan.minAreaRect(hull);
  assert.deepEqual([straight.width, straight.height, straight.angle, ...straight.center], [4, 3, 0, 2, 1.5]);
  // a 100×40 rectangle turned by 20° about (50, 60)
  const r = (20 * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const pts = [[-50, -20], [50, -20], [50, 20], [-50, 20]].map(([u, v]) => [50 + u * c - v * s, 60 + u * s + v * c]);
  const rect = Scan.minAreaRect(Scan.convexHull(pts));
  assert.ok(Math.abs(rect.width - 100) < 1e-6 && Math.abs(rect.height - 40) < 1e-6, `${rect.width}×${rect.height}`);
  assert.ok(Math.abs(rect.angle - 20) < 1e-6, `angle ${rect.angle}`);
  assert.ok(Math.abs(rect.center[0] - 50) < 1e-6 && Math.abs(rect.center[1] - 60) < 1e-6);
  // angles fold into (-45, 45]: a 70° turn of the same rectangle is a 40×100 one at -20°
  const r2 = (70 * Math.PI) / 180, c2 = Math.cos(r2), s2 = Math.sin(r2);
  const turned = Scan.minAreaRect(Scan.convexHull([[-50, -20], [50, -20], [50, 20], [-50, 20]].map(([u, v]) => [u * c2 - v * s2, u * s2 + v * c2])));
  assert.ok(Math.abs(turned.angle + 20) < 1e-6 && Math.abs(turned.width - 40) < 1e-6 && Math.abs(turned.height - 100) < 1e-6);
});

test('findPhotos separates two photos on a scanner bed and measures their size and tilt', () => {
  const img = scan(320, 200, [
    { cx: 85, cy: 100, w: 110, h: 70, deg: 8 },
    { cx: 235, cy: 95, w: 90, h: 120, deg: -5, color: [200, 60, 40, 1] },
  ]);
  const photos = Scan.findPhotos(img);
  assert.equal(photos.length, 2);
  const [a, b] = photos; // reading order: left first
  assert.ok(Math.abs(a.angle - 8) < 1, `angle ${a.angle}`);
  assert.ok(Math.abs(a.width - 110) <= 3 && Math.abs(a.height - 70) <= 3, `${a.width}×${a.height}`);
  assert.ok(Math.abs(a.center[0] - 85) < 1.5 && Math.abs(a.center[1] - 100) < 1.5);
  assert.ok(Math.abs(b.angle + 5) < 1, `angle ${b.angle}`);
  assert.ok(Math.abs(b.width - 90) <= 3 && Math.abs(b.height - 120) <= 3, `${b.width}×${b.height}`);
  assert.equal(Scan.isWholeImage(photos, 320, 200), false);
});

test('a straight photo keeps its exact pixel bounds, specks are ignored, bright areas inside a photo stay inside', () => {
  const img = scan(200, 120, [{ cx: 80, cy: 60, w: 100, h: 60, deg: 0 }]);
  // a white window inside the photo (not connected to the bed) and a dust speck on the bed
  for (let y = 50; y < 70; y++) for (let x = 60; x < 90; x++) setPixel(img, x, y, [250, 250, 250, 1]);
  setPixel(img, 180, 20, [0, 0, 0, 1]);
  setPixel(img, 181, 20, [0, 0, 0, 1]);
  const photos = Scan.findPhotos(img);
  assert.equal(photos.length, 1);
  assert.deepEqual(photos[0].bounds, { x: 30, y: 30, width: 100, height: 60 });
  assert.deepEqual([photos[0].width, photos[0].height, photos[0].angle], [100, 60, 0]);
  // nothing but bed: no photos; a full-frame image: recognised as the whole image
  assert.equal(Scan.findPhotos(scan(50, 50, [])).length, 0);
  const full = createImage(64, 48, [10, 200, 30, 1]);
  setPixel(full, 0, 0, [250, 250, 250, 1]);
  for (let x = 0; x < 64; x++) setPixel(full, x, 0, x % 2 ? [250, 250, 250, 1] : [10, 200, 30, 1]);
  const whole = Scan.findPhotos(createImage(64, 48, [10, 200, 30, 1]));
  assert.equal(whole.length, 0); // one colour everywhere is all background
});

test('transparent surroundings count as background', () => {
  const img = createImage(100, 80, [0, 0, 0, 0]);
  for (let y = 20; y < 60; y++) for (let x = 10; x < 70; x++) setPixel(img, x, y, [120, 80, 40, 1]);
  const photos = Scan.findPhotos(img);
  assert.equal(photos.length, 1);
  assert.deepEqual(photos[0].bounds, { x: 10, y: 20, width: 60, height: 40 });
});

// ---- built-in set, optional steps, Liquify mesh data ----------------------------------------------------------

test('the Default Actions set holds the ten built-in actions as ordinary, serialisable steps', async () => {
  const { defaultActionSets, DEFAULT_SET_NAME } = await import('../../src/renderer/lib/actions/defaults.js');
  const sets = defaultActionSets();
  assert.equal(sets.length, 1);
  assert.equal(sets[0].name, DEFAULT_SET_NAME);
  assert.equal(sets[0].builtin, true);
  assert.deepEqual(sets[0].actions.map((a) => a.name), [
    'Vignette (selection)', 'Frame Channel – 50 pixel', 'Wood Frame – 50 pixel', 'Cast Shadow (type)', 'Water Reflection (type)',
    'Custom RGB to Grayscale', 'Molten Lead', 'Sepia Toning (layer)', 'Quadrant Colors', 'Gradient Map',
  ]);
  const steps = sets[0].actions.flatMap((a) => a.steps);
  assert.ok(steps.length >= 40);
  for (const s of steps) {
    assert.match(s.command, /^[a-z]+:[a-z0-9-]+$/, s.label);
    assert.ok(M.isPlainData(s.arg), s.label);
    assert.equal(s.enabled, true);
    assert.equal(s.dialog, false);
    assert.equal(M.isIgnoredCommand(s.command), false, `${s.command} would not be recordable`);
  }
  // ids are unique across the set, and a second call gives an independent copy
  const ids = [sets[0].id, ...sets[0].actions.map((a) => a.id), ...steps.map((s) => s.id)];
  assert.equal(new Set(ids).size, ids.length);
  assert.notEqual(defaultActionSets()[0].actions[0].id, sets[0].actions[0].id);
  // the set survives the settings file and an actions file unchanged in substance
  const again = M.parseActionsFile(M.serializeSets(M.normalizeSets(JSON.parse(JSON.stringify(sets)))));
  assert.deepEqual(again[0].actions.map((a) => a.steps.map((s) => [s.command, s.arg ?? null, s.label, !!s.optional])), sets[0].actions.map((a) => a.steps.map((s) => [s.command, s.arg ?? null, s.label, !!s.optional])));
  // "Rasterize Layer" in the two type actions is optional: on a pixel layer it is skipped, not asked about
  const optional = sets[0].actions.filter((a) => a.steps.some((s) => s.optional)).map((a) => a.name);
  assert.deepEqual(optional, ['Cast Shadow (type)', 'Water Reflection (type)']);
});

test('the optional flag is kept only on command steps', () => {
  const [set] = M.normalizeSets([{ name: 'S', actions: [{ name: 'A', steps: [{ command: 'layer:rasterize', optional: true }, { stop: { message: 'x' }, optional: true }, { command: 'image:adjust-invert' }] }] }]);
  assert.deepEqual(set.actions[0].steps.map((s) => !!s.optional), [true, false, false]);
  const file = JSON.parse(M.serializeSets([set]));
  assert.deepEqual(file.sets[0].actions[0].steps.map((s) => s.optional ?? null), [true, null, null]);
});

test('a Liquify mesh is stored sparsely, restores within 1/16 px and scales to another image size', async () => {
  const { encodeSparse, decodeSparse, encodeField, decodeField } = await import('../../src/renderer/lib/actions/mesh-data.js');
  const values = new Float32Array(400);
  values[37] = 2.5;
  values[38] = -1.26;
  values[41] = 0.01; // below the quantisation step: dropped
  values[300] = 7;
  const packed = encodeSparse(values);
  assert.ok(packed.length < 16, `sparse data has ${packed.length} numbers`);
  const back = decodeSparse(packed, 400);
  for (let i = 0; i < 400; i++) assert.ok(Math.abs(back[i] - values[i]) <= 1 / 16, `value ${i}`);
  assert.equal(back[37], 2.5);
  assert.equal(back[300], 7);
  assert.deepEqual(Array.from(decodeSparse(encodeSparse(new Float32Array(50)), 50)), new Array(50).fill(0));

  class Field {
    constructor(w, h, cell) {
      this.w = w;
      this.h = h;
      this.cell = cell;
      this.gw = Math.ceil(w / cell) + 1;
      this.gh = Math.ceil(h / cell) + 1;
      this.dx = new Float32Array(this.gw * this.gh);
      this.dy = new Float32Array(this.gw * this.gh);
    }
  }
  const f = new Field(80, 40, 8);
  f.dx[2 * f.gw + 5] = 6; // a push at grid (5, 2) = image (40, 16)
  f.dy[2 * f.gw + 5] = -3;
  const data = JSON.parse(JSON.stringify(encodeField(f)));
  const same = decodeField(data, Field, 80, 40, 8);
  assert.deepEqual(Array.from(same.dx), Array.from(f.dx));
  assert.deepEqual(Array.from(same.dy), Array.from(f.dy));
  // twice the size: the push is at the same relative place and twice as long
  const big = decodeField(data, Field, 160, 80, 8);
  assert.equal(big.dx[4 * big.gw + 10], 12);
  assert.equal(big.dy[4 * big.gw + 10], -6);
  assert.equal(big.dx[0], 0);
  // no data: an identity field
  assert.equal(decodeField(null, Field, 16, 16, 8).dx.every((v) => v === 0), true);
});

test('the engine\'s own step commands are recorded; its panel commands are not', () => {
  for (const id of ['actions:play', 'actions:save-as', 'actions:select-layer', 'actions:set-selection', 'actions:transform']) {
    assert.equal(M.isIgnoredCommand(id), false, id);
    assert.equal(M.recordDecision(done(id, { action: 'Other' })).record, true, id);
  }
  for (const id of ['actions:record', 'actions:stop', 'actions:new-set', 'actions:new-action', 'actions:insert-stop', 'actions:toggle-step', 'actions:button-mode', 'actions:load', 'actions:save']) {
    assert.equal(M.isIgnoredCommand(id), true, id);
    assert.equal(M.recordDecision(done(id)).reason, 'ignored', id);
  }
});
