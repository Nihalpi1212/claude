// Session registry (0.4 skeleton, E) with a fake app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionRegistry, UNDO_LIKE, GESTURE_SOURCES, SAFE_WHILE_BUSY } from '../../src/renderer/lib/sessions.js';

function fakeApp(defs = {}) {
  const toasts = [];
  const app = {
    commands: { commands: new Map(Object.entries(defs)) },
    dialogs: { isOpen: false, toast: (text, opts) => toasts.push([text, opts]) },
  };
  let t = 0;
  const reg = new SessionRegistry(app, { clock: () => t });
  return { app, reg, toasts, tick: (ms) => (t += ms) };
}

test('constants', () => {
  for (const id of ['edit:undo', 'edit:redo', 'edit:step-backward', 'edit:step-forward', 'edit:toggle-last-state']) assert.ok(UNDO_LIKE.test(id), id);
  assert.ok(!UNDO_LIKE.test('edit:undo-all'));
  assert.deepEqual([...GESTURE_SOURCES], ['menu', 'menu-key', 'key', 'toolbar', 'panel']);
  assert.ok(SAFE_WHILE_BUSY.test('view:zoom-in') && SAFE_WHILE_BUSY.test('actions:stop') && !SAFE_WHILE_BUSY.test('layer:new'));
});

test('modal: allow passes, handle answers, others are refused with a throttled hint', () => {
  const { reg, toasts, tick } = fakeApp();
  let undone = 0;
  reg.register({
    id: 'sm', policy: 'modal', label: () => 'Select and Mask',
    allow: /^(view:|help:)/,
    handle: (id) => (id === 'edit:undo' ? (undone++, {}) : id === 'select:all' ? { result: 42 } : undefined),
  });
  assert.equal(reg.guardModal('view:zoom-in', undefined, 'key'), null);
  assert.deepEqual(reg.guardModal('edit:undo', undefined, 'key'), { handled: true, by: 'sm', result: undefined });
  assert.equal(undone, 1);
  assert.deepEqual(reg.guardModal('select:all', undefined, 'menu'), { handled: true, by: 'sm', result: 42 });
  assert.deepEqual(reg.guardModal('layer:new', undefined, 'menu'), { refused: true, by: 'sm' });
  assert.deepEqual(toasts, [['Finish Select and Mask first: Enter applies it, Esc cancels', { timeout: 2200 }]]);
  tick(1000);
  reg.guardModal('layer:new', undefined, 'key');
  assert.equal(toasts.length, 1, 'throttled');
  tick(2000);
  reg.guardModal('layer:new', undefined, 'key');
  assert.equal(toasts.length, 2);
  tick(3000);
  // 'api' is refused silently
  assert.deepEqual(reg.guardModal('layer:new', undefined, 'api'), { refused: true, by: 'sm' });
  assert.equal(toasts.length, 2);
});

test('a RegExp allow never admits a changesDocument def; a function allow decides itself', () => {
  const { reg } = fakeApp({ 'view:new-guide': { run() {}, changesDocument: true }, 'view:zoom-in': { run() {} } });
  const off = reg.register({ id: 'bg', policy: 'modal', label: 'Blur', allow: /^view:/, hint: false });
  assert.equal(reg.guardModal('view:zoom-in', undefined, 'key'), null);
  assert.deepEqual(reg.guardModal('view:new-guide', undefined, 'key'), { refused: true, by: 'bg' });
  off();
  reg.register({ id: 'fn', policy: 'modal', label: 'Fn', allow: (id) => id === 'view:new-guide', hint: false });
  assert.equal(reg.guardModal('view:new-guide', undefined, 'key'), null);
});

test('active() gates an entry; begin() entries last until end(); newest first', () => {
  const { reg } = fakeApp();
  let on = false;
  reg.register({ id: 'a', policy: 'modal', label: 'A', active: () => on, hint: false });
  assert.equal(reg.guardModal('layer:new', undefined, 'key'), null);
  assert.deepEqual(reg.list(), []);
  on = true;
  assert.deepEqual(reg.guardModal('layer:new', undefined, 'key'), { refused: true, by: 'a' });
  const b = reg.begin({ id: 'b', policy: 'modal', label: 'B', hint: false, handle: (id) => (id === 'layer:new' ? {} : undefined) });
  assert.deepEqual(reg.list().map((s) => s.id), ['a', 'b']);
  // b (newest) answers before a refuses
  assert.deepEqual(reg.guardModal('layer:new', undefined, 'key'), { handled: true, by: 'b', result: undefined });
  b.end();
  assert.deepEqual(reg.list().map((s) => s.id), ['a']);
  // a throwing active() counts as inactive
  reg.register({ id: 'c', policy: 'modal', label: 'C', active: () => { throw new Error('x'); } });
  assert.deepEqual(reg.list().map((s) => s.id), ['a']);
});

test('busy: gesture sources (menu-key too) are refused unless allowed or a dialog is open', () => {
  const { app, reg, toasts, tick } = fakeApp({ 'view:new-guide': { run() {}, changesDocument: true } });
  assert.equal(reg.busyDepth, 0);
  const s = reg.begin({ id: 'busy', policy: 'busy', label: 'Working', allow: SAFE_WHILE_BUSY, onClose: 'keep' });
  assert.equal(reg.busyDepth, 1);
  for (const source of ['menu', 'menu-key', 'key', 'toolbar', 'panel']) assert.deepEqual(reg.guardBusy('layer:new', source), { refused: true, by: 'busy' }, source);
  for (const source of ['api', 'action', 'assistant', 'drop', 'os']) assert.equal(reg.guardBusy('layer:new', source), null, source);
  assert.equal(reg.guardBusy('view:zoom-in', 'key'), null);
  assert.deepEqual(reg.guardBusy('view:new-guide', 'menu'), { refused: true, by: 'busy' });
  assert.deepEqual(toasts, [['Pigment is still working: try again when it has finished', { kind: 'info', timeout: 2200 }]]);
  tick(3000);
  reg.guardBusy('layer:new', 'key');
  assert.equal(toasts.length, 2);
  app.dialogs.isOpen = true;
  assert.equal(reg.guardBusy('layer:new', 'key'), null);
  app.dialogs.isOpen = false;
  // a busy session with its own sources
  const t = reg.begin({ id: 'busy2', policy: 'busy', label: 'Other', sources: new Set(['api']) });
  assert.equal(reg.busyDepth, 2);
  assert.deepEqual(reg.guardBusy('layer:new', 'api'), { refused: true, by: 'busy2' });
  t.end();
  s.end();
  assert.equal(reg.busyDepth, 0);
  assert.equal(reg.guardBusy('layer:new', 'key'), null);
});

test('commit: undo-like ids (and undoLike defs) cancel, other commands commit first, allowed ones pass', () => {
  const { reg } = fakeApp({ 'edit:toggle-last-state': { run() {}, undoLike: true }, 'my:undo-ish': { run() {}, undoLike: true } });
  const log = [];
  let open = true;
  reg.register({ id: 'transform', policy: 'commit', label: 'Free Transform', active: () => open, allow: /^(view:|app:enter$)/, commit: () => log.push('commit'), cancel: (r) => log.push(`cancel:${r}`) });
  assert.equal(reg.commitBefore('view:zoom-in'), null);
  assert.deepEqual(log, []);
  assert.deepEqual(reg.commitBefore('edit:undo'), { cancelled: true, by: 'transform' });
  assert.deepEqual(reg.commitBefore('my:undo-ish'), { cancelled: true, by: 'transform' });
  assert.deepEqual(reg.commitBefore('edit:toggle-last-state'), { cancelled: true, by: 'transform' });
  assert.equal(reg.commitBefore('layer:new'), null);
  assert.deepEqual(log, ['cancel:undo', 'cancel:undo', 'cancel:undo', 'commit']);
  open = false;
  assert.equal(reg.commitBefore('edit:undo'), null);
  // commit sessions are not refused by guardModal
  open = true;
  assert.equal(reg.guardModal('layer:new', undefined, 'key'), null);
});

test('observe: undo / redo claimed newest first; ownsFocus', () => {
  const { reg } = fakeApp();
  assert.equal(reg.undo(), false);
  const calls = [];
  const input = { id: 'ta' };
  let typing = false;
  reg.register({ id: 'type', policy: 'observe', label: 'Type', active: () => typing, undo: () => (calls.push('undo'), true), redo: () => (calls.push('redo'), true), ownsFocus: (el) => el === input });
  assert.equal(reg.undo(), false);
  assert.equal(reg.ownsFocus(input), false);
  typing = true;
  assert.equal(reg.undo(), true);
  assert.equal(reg.redo(), true);
  assert.deepEqual(calls, ['undo', 'redo']);
  assert.equal(reg.ownsFocus(input), true);
  assert.equal(reg.ownsFocus({}), false);
  assert.equal(reg.ownsFocus(null), false);
  // an observe session never refuses
  assert.equal(reg.guardModal('layer:new', undefined, 'key'), null);
  assert.equal(reg.guardBusy('layer:new', 'key'), null);
  assert.equal(reg.commitBefore('layer:new'), null);
});

test('cancelAll: newest first, onClose cancel / commit / keep, defaults by policy', async () => {
  const { reg } = fakeApp();
  const log = [];
  reg.register({ id: 'modal', policy: 'modal', label: 'M', cancel: (r) => log.push(`modal:cancel:${r}`) });
  reg.register({ id: 'commit-default', policy: 'commit', label: 'C', commit: () => log.push('cd:commit'), cancel: () => log.push('cd:cancel') });
  reg.register({ id: 'type', policy: 'commit', label: 'T', onClose: 'commit', commit: async () => { await null; log.push('type:commit'); }, cancel: () => log.push('type:cancel') });
  reg.register({ id: 'obs', policy: 'observe', label: 'O', cancel: () => log.push('obs:cancel') });
  reg.begin({ id: 'busy', policy: 'busy', label: 'B', onClose: 'keep', cancel: () => log.push('busy:cancel') });
  reg.register({ id: 'off', policy: 'modal', label: 'X', active: () => false, cancel: () => log.push('off:cancel') });
  reg.register({ id: 'throws', policy: 'modal', label: 'E', cancel: () => { throw new Error('boom'); } });
  const warn = console.warn;
  console.warn = () => {};
  try {
    await reg.cancelAll();
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(log, ['type:commit', 'cd:cancel', 'modal:cancel:close']);
});
