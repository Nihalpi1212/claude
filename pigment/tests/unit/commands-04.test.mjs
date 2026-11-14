// Command registry 0.4 (E): observers, the run order with the session registry, definition flags,
// setReplayCommand and stub replacement. A fake app, no DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandRegistry, GESTURE_SOURCES } from '../../src/renderer/lib/commands.js';
import { SessionRegistry, SAFE_WHILE_BUSY } from '../../src/renderer/lib/sessions.js';
import { stubCommands } from '../../src/renderer/lib/stub.js';

function fakeApp() {
  const events = [];
  const app = {
    events,
    stubbed: [],
    dialogs: { isOpen: false, toast() {}, passesMenu: null },
    emit: (name, detail) => events.push([name, detail]),
    reportError: (err) => { throw err; },
  };
  app.commands = new CommandRegistry(app);
  app.sessions = new SessionRegistry(app);
  return app;
}
const done = (app) => app.events.filter(([n]) => n === 'command:done').map(([, d]) => d);

test('GESTURE_SOURCES includes menu-key', () => {
  assert.ok(GESTURE_SOURCES.has('menu-key'));
});

test('observers see every run, with handledBy / refused, in registration order', () => {
  const app = fakeApp();
  const log = [];
  app.commands.register('a:x', { run: (arg) => `ran ${arg}` });
  app.commands.observe({ before: (id, arg, source) => (log.push(['before1', id, source]), 't1'), after: (t, r, info) => log.push(['after1', t, r, info.handledBy, info.refused]) });
  const off = app.commands.observe({ before: () => 't2', after: (t) => log.push(['after2', t]) });
  assert.equal(app.commands.run('a:x', 5, 'key'), 'ran 5');
  assert.deepEqual(log, [['before1', 'a:x', 'key'], ['after1', 't1', 'ran 5', null, false], ['after2', 't2']]);
  off();
  log.length = 0;
  app.sessions.register({ id: 'm', policy: 'modal', label: 'M', hint: false, handle: (id) => (id === 'a:h' ? { result: 7 } : undefined) });
  assert.equal(app.commands.run('a:h', undefined, 'key'), 7);
  assert.deepEqual(log.at(-1), ['after1', 't1', 7, 'm', false]);
  assert.equal(app.commands.run('a:x', 1, 'key'), undefined);
  assert.deepEqual(log.at(-1), ['after1', 't1', undefined, null, true]);
  // an unknown id still reaches observers (after with nothing)
  const warn = console.warn;
  console.warn = () => {};
  try {
    app.sessions.entries.length = 0;
    assert.equal(app.commands.run('nope:x'), undefined);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(log.at(-1), ['after1', 't1', undefined, null, false]);
});

test('busy refuses gestures (menu-key too) but not code; changesDocument is refused while busy', () => {
  const app = fakeApp();
  let n = 0;
  app.commands.register('layer:new', { run: () => ++n });
  app.commands.register('view:zoom-in', { run: () => ++n });
  app.commands.register('view:new-guide', { run: () => ++n, changesDocument: true });
  const s = app.sessions.begin({ id: 'busy', policy: 'busy', label: 'B', allow: SAFE_WHILE_BUSY });
  assert.equal(app.commands.run('layer:new', undefined, 'menu-key'), undefined);
  assert.equal(app.commands.run('view:new-guide', undefined, 'menu'), undefined);
  assert.equal(n, 0);
  assert.equal(app.commands.run('view:zoom-in', undefined, 'key'), 1);
  // (another argument: the same command from another source within 40 ms would be de-duplicated)
  assert.equal(app.commands.run('layer:new', 'a', 'api'), 2);
  s.end();
  assert.equal(app.commands.run('layer:new', 'b', 'key'), 3);
});

test('menu and menu-key commands are ignored while a dialog is open unless passesMenu says so', () => {
  const app = fakeApp();
  let n = 0;
  app.commands.register('view:zoom-in', { run: () => ++n });
  app.dialogs.isOpen = true;
  assert.equal(app.commands.run('view:zoom-in', undefined, 'menu'), undefined);
  assert.equal(app.commands.run('view:zoom-in', undefined, 'menu-key'), undefined);
  assert.equal(n, 0);
  app.dialogs.passesMenu = (id) => id.startsWith('view:');
  assert.equal(app.commands.run('view:zoom-in', 1, 'menu-key'), 1);
  // keys go through as in 0.3
  app.dialogs.passesMenu = null;
  assert.equal(app.commands.run('view:zoom-in', 2, 'key'), 2);
});

test('a commit session commits before a command and is cancelled by undo-like ones', () => {
  const app = fakeApp();
  const log = [];
  let open = true;
  app.commands.register('layer:new', { run: () => log.push('layer:new') });
  app.commands.register('edit:undo', { run: () => log.push('undo') });
  app.commands.register('my:toggle', { run: () => log.push('toggle'), undoLike: true });
  app.sessions.register({ id: 'transform', policy: 'commit', label: 'T', active: () => open, commit: () => { log.push('commit'); open = false; }, cancel: () => { log.push('cancel'); open = false; } });
  app.commands.run('layer:new', undefined, 'key');
  assert.deepEqual(log, ['commit', 'layer:new']);
  open = true;
  app.commands.run('edit:undo', undefined, 'key');
  open = true;
  app.commands.run('my:toggle', undefined, 'key');
  assert.deepEqual(log, ['commit', 'layer:new', 'cancel', 'cancel']);
});

test('setReplayCommand and setReplayArg reach command:done', () => {
  const app = fakeApp();
  app.commands.register('layer:merge', { run: (arg, ctx) => ctx.setReplayCommand('layer:merge-down') });
  app.commands.register('x:dialog', { dialog: true, run: (arg, ctx) => ctx.setReplayArg({ a: 1 }) });
  app.commands.run('layer:merge', undefined, 'key');
  app.commands.run('x:dialog', undefined, 'menu');
  const [m, d] = done(app);
  assert.equal(m.id, 'layer:merge');
  assert.equal(m.replayId, 'layer:merge-down');
  assert.equal(m.replayArg, undefined);
  assert.equal(m.replayable, true);
  assert.deepEqual([d.id, d.arg, d.replayable, 'replayId' in d], ['x:dialog', { a: 1 }, true, false]);
});

test('a real registration replaces a stub whatever the order; a stub never shadows a real command', () => {
  const app = fakeApp();
  stubCommands(app, ['a:one', 'a:two']);
  assert.deepEqual(app.stubbed, ['a:one', 'a:two']);
  assert.equal(app.commands.commands.get('a:one').stub, true);
  assert.equal(app.commands.isEnabled('a:one'), false);
  app.commands.register('a:one', { run: () => 1 });
  assert.deepEqual(app.stubbed, ['a:two']);
  assert.ok(app.events.some(([n]) => n === 'commands:changed'));
  app.commands.register('b:real', { run: () => 2 });
  stubCommands(app, ['b:real']);
  assert.ok(!app.stubbed.includes('b:real'));
  assert.equal(app.commands.run('b:real'), 2);
});

test('the recorder consults the definition flags before its 0.3 lists', async () => {
  const { isIgnoredCommand, recordDecision } = await import('../../src/renderer/lib/actions/model.js');
  assert.equal(isIgnoredCommand('view:zoom-in'), true);
  assert.equal(isIgnoredCommand('view:lock-guides', { changesDocument: true }), false);
  assert.equal(isIgnoredCommand('layer:collapse-all-groups', { record: false }), true);
  assert.equal(isIgnoredCommand('edit:search', { record: false }), true);
  assert.equal(isIgnoredCommand('edit:undo', { record: true }), false);
  assert.equal(isIgnoredCommand('edit:toggle-last-state', { undoLike: true }), true);
  // without a definition the 0.3 lists decide alone
  assert.equal(isIgnoredCommand('view:new-guide'), false);
  assert.equal(isIgnoredCommand('layer:new'), false);
  const ev = { id: 'view:snap-to', arg: 'grid', source: 'menu', cancelled: false, replayable: true };
  assert.equal(recordDecision(ev).record, false);
  assert.equal(recordDecision(ev, { def: { changesDocument: true } }).record, true);
});
