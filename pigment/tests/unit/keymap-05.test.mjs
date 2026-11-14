// Keymap 0.5 (ARCHITECTURE.md "0.5 features", S9.1–S9.4, S13.3–S13.5): every new binding, the PAINT keys, overlays,
// the store's placement, conflicts and `force`, keysFor, key sources (an action's function key), FIXED_KEYS,
// typeKeyFor over an overlay, runsWhileTyping and resolveKey. Rule 11: nothing here pins a stub's own behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MENU_KEYS, RENDERER_KEYS, TYPE_KEYS, PAINT_KEYS, FIXED_KEYS, BLEND_MODE_KEYS, COMMAND_LABELS, SHORTCUT_GROUPS,
  effectiveKeys, keyConflicts, typeKeyFor, runsWhileTyping, sameAccelerator, fixedKeyFor, isPlainKey, normalizeOverlay,
} from '../../src/shared/keymap.js';
import { KeymapStore } from '../../src/renderer/lib/keymap-store.js';

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const is = (a, b, msg) => assert.ok(a && sameAccelerator(a, b), `${msg ?? ''} ${a} vs ${b}`);

// S13.3: every new command id and its key ('MENU:' native menu, 'PAINT:' paint context, null none)
const S13_3 = {
  'window:panel-brush-settings': 'MENU:F5',
  'window:panel-styles': null, 'window:panel-shapes': null, 'window:panel-tool-presets': null,
  'edit:define-brush': null, 'edit:define-custom-shape': null,
  'edit:preset-manager': null, 'edit:export-import-presets': null, 'edit:migrate-presets': null,
  'edit:assign-profile': null, 'edit:color-settings': null, 'edit:convert-profile': null,
  'edit:camera-raw-preferences': null,
  'edit:menus': 'MENU:CmdOrCtrl+Alt+Shift+M',
  'edit:show-all-menu-items': null,
  'help:shortcuts': 'MENU:CmdOrCtrl+Alt+Shift+K',
  'type:add-fonts': null, 'type:font-preview-size': null, 'type:manage-missing-fonts': null, 'type:replace-missing-fonts': null,
  'type:anti-alias': null, 'type:warp-text': null, 'type:create-work-path': null, 'type:convert-to-shape': null,
  'type:convert-text-kind': null, 'type:update-all': null, 'type:paste-lorem-ipsum': null, 'type:toggle-orientation': null,
  'tool:type-mask-horizontal': null, 'tool:type-mask-vertical': null,
  'tool:brush-preset': null,
  'tool:airbrush-toggle': 'PAINT:Shift+Alt+P',
  'tool:brush-prev': 'PAINT:,', 'tool:brush-next': 'PAINT:.', 'tool:brush-first': 'PAINT:Shift+,', 'tool:brush-last': 'PAINT:Shift+.',
  ...Object.fromEntries(DIGITS.map((d) => [`tool:opacity-digit-${d}`, `PAINT:${d}`])),
  ...Object.fromEntries(DIGITS.map((d) => [`tool:flow-digit-${d}`, `PAINT:Shift+${d}`])),
  'tool:preset': null, 'tool:reset': null, 'tool:reset-all': null,
  'layer:style-preset': null,
};
for (const [id, letter] of BLEND_MODE_KEYS) if (id !== 'pass-through') S13_3[`tool:blend-mode-${id}`] = `PAINT:Shift+Alt+${letter}`;
S13_3['tool:blend-mode-behind'] = 'PAINT:Shift+Alt+Q';
S13_3['tool:blend-mode-clear'] = 'PAINT:Shift+Alt+R';

test('every S13.3 id has a label and exactly the key S13.3 decides', () => {
  assert.equal(Object.keys(S13_3).filter((id) => id.startsWith('tool:blend-mode-')).length, 25);
  for (const [id, decision] of Object.entries(S13_3)) {
    assert.ok(typeof COMMAND_LABELS[id] === 'string' && COMMAND_LABELS[id].length > 0, `label for ${id}`);
    const menu = MENU_KEYS[id] ?? null, renderer = RENDERER_KEYS[id] ?? [], type = TYPE_KEYS[id] ?? null, paint = PAINT_KEYS[id] ?? [];
    assert.equal(type, null, id);
    if (decision === null) {
      assert.equal(menu, null, `${id} has no menu key`);
      assert.deepEqual(renderer, [], `${id} has no renderer key`);
      assert.deepEqual(paint, [], `${id} has no paint key`);
    } else if (decision.startsWith('MENU:')) {
      is(menu, decision.slice(5), id);
      assert.deepEqual(renderer, [], id);
      assert.deepEqual(paint, [], id);
    } else {
      assert.equal(menu, null, id);
      assert.deepEqual(renderer, [], id);
      assert.equal(paint.length, 1, `${id}: ${paint}`);
      is(paint[0], decision.slice(6), id);
    }
  }
  // PAINT_KEYS holds exactly the paint bindings of S13.3
  assert.deepEqual(Object.keys(PAINT_KEYS).sort(), Object.entries(S13_3).filter(([, d]) => d?.startsWith('PAINT:')).map(([id]) => id).sort());
});

test('the function keys of S13.3 and the developer tools key (S13.5)', () => {
  is(MENU_KEYS['help:guide'], 'F1');
  is(MENU_KEYS['window:panel-brush-settings'], 'F5');
  is(MENU_KEYS['window:panel-color'], 'F6');
  is(MENU_KEYS['window:panel-layers'], 'F7');
  is(MENU_KEYS['window:panel-info'], 'F8');
  is(MENU_KEYS['file:revert'], 'F12');
  // F12 left the developer tools: Shift+CmdOrCtrl+F12, a fixed key of development builds
  assert.equal(RENDERER_KEYS['help:devtools'], undefined);
  assert.equal(MENU_KEYS['help:devtools'], undefined);
  is(FIXED_KEYS['help:devtools'].accel, 'Shift+CmdOrCtrl+F12');
  assert.equal(fixedKeyFor('help:devtools', { platform: 'linux', isPackaged: true }), null);
  is(fixedKeyFor('help:devtools', { platform: 'win32', isPackaged: false }), 'Shift+CmdOrCtrl+F12');
  is(fixedKeyFor('view:fullscreen', { platform: 'darwin' }), 'Ctrl+Cmd+F');
  assert.equal(fixedKeyFor('view:fullscreen', { platform: 'win32' }), null);
  // the Shift+Alt blend letters keep their 0.4 meaning outside the paint context
  is(RENDERER_KEYS['layer:blend-mode-pass-through'][0], 'Shift+Alt+P');
  is(RENDERER_KEYS['layer:opacity-digit-2'][0], '2');
});

test('SHORTCUT_GROUPS list every new command with a key, labelled; a paint group holds the PAINT keys', () => {
  const listed = new Set(SHORTCUT_GROUPS.flatMap((g) => g.commands));
  for (const id of [...Object.keys(PAINT_KEYS), 'file:revert', 'help:guide', 'window:panel-brush-settings', 'window:panel-color', 'window:panel-layers', 'window:panel-info']) assert.ok(listed.has(id), id);
  const paint = SHORTCUT_GROUPS.find((g) => g.paint);
  assert.ok(paint, 'a group marked paint');
  assert.deepEqual([...paint.commands].sort(), Object.keys(PAINT_KEYS).sort());
  for (const g of SHORTCUT_GROUPS) for (const id of g.commands) assert.ok(COMMAND_LABELS[id], `label for ${id}`);
});

test('the default tables have no conflict in any scope', () => {
  assert.deepEqual(keyConflicts(effectiveKeys(null)), []);
});

test('overlays: an entry replaces the default, null and [] remove it, malformed entries are dropped', () => {
  const base = effectiveKeys(null);
  assert.deepEqual(base.menu, MENU_KEYS);
  assert.deepEqual(base.renderer, RENDERER_KEYS);
  assert.deepEqual(base.type, TYPE_KEYS);
  assert.deepEqual(base.paint, PAINT_KEYS);
  const e = effectiveKeys({ v: 1, menu: { 'layer:new': 'CmdOrCtrl+Alt+K', 'file:save': null, bad: 42 }, renderer: { 'tool:brush': ['q'], 'tool:eraser': [] }, type: { 'type:align-left': null }, paint: { 'tool:brush-next': ['Shift+Alt+F1'] } });
  assert.equal(e.menu['layer:new'], 'CmdOrCtrl+Alt+K');
  assert.equal(e.menu['file:save'], undefined);
  assert.equal(e.menu.bad, undefined);
  assert.deepEqual(e.renderer['tool:brush'], ['q']);
  assert.equal(e.renderer['tool:eraser'], undefined);
  assert.equal(e.type['type:align-left'], undefined);
  assert.deepEqual(e.paint['tool:brush-next'], ['Shift+Alt+F1']);
  // the defaults themselves are untouched
  assert.equal(MENU_KEYS['file:save'], 'CmdOrCtrl+S');
  assert.deepEqual(normalizeOverlay('nonsense'), { v: 1 });
  assert.deepEqual(effectiveKeys('nonsense'), base);
});

test('typeKeyFor reads the effective tables; runsWhileTyping no longer lets F12 revert from a text field', () => {
  assert.equal(typeKeyFor('image:auto-tone'), 'type:align-left');
  const moved = effectiveKeys({ v: 1, menu: { 'image:auto-tone': 'CmdOrCtrl+Alt+Shift+F2' } });
  assert.equal(typeKeyFor('image:auto-tone', moved), null);
  const rebound = effectiveKeys({ v: 1, type: { 'type:align-left': 'CmdOrCtrl+J' } });
  assert.equal(typeKeyFor('layer:via-copy', rebound), 'type:align-left');
  assert.equal(typeKeyFor('image:auto-tone', rebound), null);
  assert.equal(runsWhileTyping('file:revert'), false);
  assert.equal(runsWhileTyping('file:save'), true);
  assert.equal(runsWhileTyping('window:panel-layers'), true);
  assert.equal(isPlainKey('F5'), false);
  assert.equal(isPlainKey('Shift+F5'), false);
  assert.equal(isPlainKey('q'), true);
  assert.equal(isPlainKey('Shift+,'), true);
  assert.equal(isPlainKey('CmdOrCtrl+J'), false);
});

/** A KeymapStore over a fake app (settings, events, tools and commands). */
function store({ tool = 'move', enabled = () => true, keymap } = {}) {
  const events = [];
  const listeners = new Map();
  const app = {
    settings: { keymap: keymap ?? { set: 'photoshop-defaults', overlay: { v: 1 }, menus: { set: 'default', hidden: [], colors: {}, showAll: false } } },
    saved: [],
    saveSettingsSoon(patch) {
      Object.assign(this.settings, patch);
      this.saved.push(patch);
      for (const fn of listeners.get('settings:changed') ?? []) fn(patch);
    },
    emit(name, detail) {
      events.push([name, detail]);
      for (const fn of listeners.get(name) ?? []) fn(detail);
    },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
      return () => {};
    },
    tools: { active: { id: tool } },
    commands: { isEnabled: enabled },
  };
  const s = new KeymapStore(app);
  return { s, app, events, changes: () => events.filter(([n]) => n === 'keymap:changed').length };
}

test('store set: placement between the native menu and the renderer table', () => {
  const { s, app } = store();
  // a command with a menu item: the first non-plain key goes to the menu, the rest to the renderer
  assert.deepEqual(s.set('layer:new', ['CmdOrCtrl+Alt+K', 'CmdOrCtrl+Alt+Shift+F3', 'k']), []);
  assert.equal(s.effective().menu['layer:new'], 'CmdOrCtrl+Alt+K');
  assert.deepEqual(s.effective().renderer['layer:new'], ['CmdOrCtrl+Alt+Shift+F3', 'k']);
  assert.deepEqual(s.keysFor('layer:new'), ['CmdOrCtrl+Alt+K', 'CmdOrCtrl+Alt+Shift+F3', 'k']);
  assert.deepEqual(s.keysFor('layer:new', 'menu'), ['CmdOrCtrl+Alt+K']);
  // a plain key never goes to the menu, even for a command with a menu item
  s.set('edit:fill', ['q']);
  assert.equal(s.effective().menu['edit:fill'], undefined);
  assert.deepEqual(s.effective().renderer['edit:fill'], ['q']);
  // a command without a menu item: renderer only
  s.set('layer:stamp-visible', ['CmdOrCtrl+Alt+Shift+F4']);
  assert.equal(s.effective().menu['layer:stamp-visible'], undefined);
  assert.deepEqual(s.keysFor('layer:stamp-visible'), ['CmdOrCtrl+Alt+Shift+F4']);
  // the overlay is persisted in settings.keymap
  assert.equal(app.settings.keymap.overlay.menu['layer:new'], 'CmdOrCtrl+Alt+K');
  // null removes every key of the command in the scope; reset brings the defaults back
  s.set('file:save', null);
  assert.deepEqual(s.keysFor('file:save'), []);
  s.reset('file:save');
  assert.deepEqual(s.keysFor('file:save'), ['CmdOrCtrl+S']);
  s.reset();
  assert.deepEqual(s.overlay(), { v: 1 });
  // the type and paint scopes
  s.set('type:align-left', ['CmdOrCtrl+Alt+Shift+F5'], { scope: 'type' });
  assert.deepEqual(s.keysFor('type:align-left', 'type'), ['CmdOrCtrl+Alt+Shift+F5']);
  s.set('tool:brush-next', ['Shift+Alt+F6'], { scope: 'paint' });
  assert.deepEqual(s.keysFor('tool:brush-next', 'paint'), ['Shift+Alt+F6']);
});

test('store set: a conflict changes nothing without force; with force the key moves in one keymap:changed', () => {
  const { s, changes } = store();
  const before = changes();
  const c = s.set('layer:new', ['CmdOrCtrl+J']);
  assert.equal(c.length, 1);
  assert.equal(c[0].scope, 'global');
  assert.deepEqual([...c[0].commands].sort(), ['layer:new', 'layer:via-copy']);
  assert.equal(changes(), before, 'nothing changed');
  assert.deepEqual(s.keysFor('layer:new'), ['CmdOrCtrl+Shift+N']);
  const forced = s.set('layer:new', ['CmdOrCtrl+J'], { force: true });
  assert.equal(forced.length, 1);
  assert.equal(changes(), before + 1, 'one keymap:changed');
  assert.deepEqual(s.keysFor('layer:new'), ['CmdOrCtrl+J']);
  assert.deepEqual(s.keysFor('layer:via-copy'), []);
  assert.deepEqual(s.conflicts(), []);
  // a renderer key taken by force
  s.set('tool:brush', ['e'], { force: true });
  assert.deepEqual(s.keysFor('tool:eraser'), []);
  // a type key collides only with type keys (a type key shadowing a global key is by design)
  assert.deepEqual(s.set('type:align-left', ['CmdOrCtrl+S'], { scope: 'type' }), []);
  const t = s.set('type:align-right', ['CmdOrCtrl+S'], { scope: 'type' });
  assert.equal(t.length, 1);
  assert.equal(t[0].scope, 'type');
});

test('store: FIXED_KEYS cannot be taken, also with force', () => {
  const { s, changes } = store();
  const before = changes();
  const c = s.set('layer:new', ['Shift+CmdOrCtrl+F12'], { force: true });
  assert.equal(c.length, 1);
  assert.ok(c[0].commands.includes('help:devtools'));
  assert.equal(changes(), before);
  assert.deepEqual(s.keysFor('layer:new'), ['CmdOrCtrl+Shift+N']);
  assert.ok(keyConflicts(effectiveKeys({ v: 1, renderer: { 'tool:brush': ['Ctrl+Cmd+F'] } })).some((x) => x.commands.includes('view:fullscreen')));
});

test('key sources: an action on F7 shadows window:panel-layers in effective() and resolvedOverlay()', () => {
  const { s, changes } = store();
  assert.deepEqual(s.keysFor('window:panel-layers'), ['F7']);
  let keys = [{ accel: 'F7', label: 'My action', priority: 'over' }];
  const before = changes();
  const off = s.registerKeySource('actions', () => keys);
  assert.equal(changes(), before + 1);
  assert.equal(s.effective().menu['window:panel-layers'], undefined);
  assert.deepEqual(s.keysFor('window:panel-layers'), []);
  assert.equal(s.resolvedOverlay().menu['window:panel-layers'], null);
  assert.ok(s.conflicts().some((c) => c.commands.includes('window:panel-layers') && c.commands.includes('source:actions')));
  // the user's own overlay is not changed by the source
  assert.deepEqual(s.overlay(), { v: 1 });
  // an 'under' source shadows nothing
  keys = [{ accel: 'F7', label: 'My action', priority: 'under' }];
  s.refreshSources();
  assert.deepEqual(s.keysFor('window:panel-layers'), ['F7']);
  keys = [{ accel: 'Shift+F2', label: 'Other', priority: 'over' }];
  s.refreshSources();
  assert.deepEqual(s.keysFor('window:panel-layers'), ['F7']);
  off();
  assert.deepEqual(s.resolvedOverlay(), { v: 1 });
});

test('resolveKey: the enabled PAINT command of the same key while a painting tool is active', () => {
  let on = true;
  const { s } = store({ tool: 'brush', enabled: () => on });
  assert.equal(s.resolveKey('layer:blend-mode-multiply', 'key'), 'tool:blend-mode-multiply');
  assert.equal(s.resolveKey('layer:blend-mode-pass-through', 'key'), 'tool:airbrush-toggle');
  assert.equal(s.resolveKey('layer:new', 'key'), 'layer:new');
  assert.equal(s.resolveKey('layer:blend-mode-multiply', 'api'), 'layer:blend-mode-multiply');
  on = false;
  assert.equal(s.resolveKey('layer:blend-mode-multiply', 'key'), 'layer:blend-mode-multiply');
  const move = store({ tool: 'move' }).s;
  assert.equal(move.resolveKey('layer:blend-mode-multiply', 'key'), 'layer:blend-mode-multiply');
});

test('store: menus and settings written elsewhere are taken over', () => {
  const { s, app, changes } = store();
  s.setMenus({ hidden: ['layer:new', 'layer:new'], colors: { 'file:save': 'red', 'file:open': 'pink' }, showAll: 1 });
  assert.deepEqual(s.menus(), { set: 'default', hidden: ['layer:new'], colors: { 'file:save': 'red' }, showAll: true });
  assert.deepEqual(app.settings.keymap.menus, s.menus());
  const before = changes();
  // an imported bundle (S10.7) replaces settings.keymap and emits settings:changed
  app.settings.keymap = { set: 'mine', overlay: { v: 1, menu: { 'file:save': 'CmdOrCtrl+Alt+F9' } }, menus: { hidden: [] } };
  app.emit('settings:changed', { keymap: app.settings.keymap });
  assert.equal(changes(), before + 1);
  assert.equal(s.activeSet(), 'mine');
  assert.deepEqual(s.keysFor('file:save'), ['CmdOrCtrl+Alt+F9']);
  assert.equal(s.sets()[0].id, 'photoshop-defaults');
});
