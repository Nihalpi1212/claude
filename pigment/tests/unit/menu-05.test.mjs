// The 0.5 menu template (ARCHITECTURE.md "0.5 features", S9.5, S13.2): every new item with its command and argument,
// no accelerator twice on any platform and state, hidden and coloured items with "Show All Menu Items", and
// accelerators that follow the keymap overlay of the ui state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMenuTemplate, menuItemCommands, PANELS } from '../../src/shared/menu-template.js';
import { parseAccelerator, sameAccelerator } from '../../src/shared/keymap.js';

const FULL = { hasDocument: true, hasLayer: true, hasSelection: true, layerType: 'text', textKind: 'point', antiAlias: 'smooth', fontPreviewSize: 'medium' };
const build = (platform = 'linux', state = FULL, { isPackaged = false } = {}) => buildMenuTemplate({ platform, state, recent: [], run: (cmd, arg) => (build.last = [cmd, arg]), isPackaged });

/** Every item that runs a command: its path of labels (without &), the command, the argument and the item. */
function commands(platform = 'linux', state = FULL, opts) {
  const t = build(platform, state, opts);
  const out = [];
  const walk = (xs, path) => {
    for (const it of xs) {
      if (it.submenu) walk(it.submenu, [...path, it.label.replace(/&/g, '')]);
      else if (it.click) {
        build.last = null;
        it.click(it, null, undefined);
        if (build.last) out.push({ path: [...path, it.label.replace(/&/g, '')], cmd: build.last[0], arg: build.last[1], item: it });
      }
    }
  };
  walk(t, []);
  return out;
}
const find = (all, path) => all.find((x) => x.path.join(' > ') === path.join(' > '));

const EXPECTED = [
  [['Edit', 'Define Brush Preset…'], 'edit:define-brush'],
  [['Edit', 'Define Custom Shape…'], 'edit:define-custom-shape'],
  [['Edit', 'Presets', 'Preset Manager…'], 'edit:preset-manager'],
  [['Edit', 'Presets', 'Export/Import Presets…'], 'edit:export-import-presets'],
  [['Edit', 'Presets', 'Migrate Presets'], 'edit:migrate-presets'],
  [['Edit', 'Color Settings…'], 'edit:color-settings'],
  [['Edit', 'Assign Profile…'], 'edit:assign-profile'],
  [['Edit', 'Convert to Profile…'], 'edit:convert-profile'],
  [['Edit', 'Keyboard Shortcuts…'], 'help:shortcuts'],
  [['Edit', 'Menus…'], 'edit:menus'],
  [['Edit', 'Preferences…'], 'edit:preferences'],
  [['Edit', 'Camera Raw Preferences…'], 'edit:camera-raw-preferences'],
  [['Type', 'Add Fonts…'], 'type:add-fonts'],
  ...[['None', 'none'], ['Sharp', 'sharp'], ['Crisp', 'crisp'], ['Strong', 'strong'], ['Smooth', 'smooth'], ['Windows LCD', 'lcd'], ['Windows', 'windows']]
    .map(([label, arg]) => [['Type', 'Anti-Alias', label], 'type:anti-alias', arg]),
  [['Type', 'Convert to Paragraph Text'], 'type:convert-text-kind'],
  [['Type', 'Warp Text…'], 'type:warp-text'],
  [['Type', 'Create Work Path'], 'type:create-work-path'],
  [['Type', 'Convert to Shape'], 'type:convert-to-shape'],
  ...[['None', 'none'], ['Small', 'small'], ['Medium', 'medium'], ['Large', 'large'], ['Extra Large', 'xlarge'], ['Huge', 'huge']]
    .map(([label, arg]) => [['Type', 'Font Preview Size', label], 'type:font-preview-size', arg]),
  [['Type', 'Update All Text Layers'], 'type:update-all'],
  [['Type', 'Manage Missing Fonts…'], 'type:manage-missing-fonts'],
  [['Type', 'Replace All Missing Fonts'], 'type:replace-missing-fonts'],
  [['Type', 'Paste Lorem Ipsum'], 'type:paste-lorem-ipsum'],
  [['Window', 'Styles'], 'window:panel-styles'],
  [['Window', 'Shapes'], 'window:panel-shapes'],
  [['Window', 'Brush Settings'], 'window:panel-brush-settings'],
  [['Window', 'Tool Presets'], 'window:panel-tool-presets'],
];

test('every item of S13.2 is present with its command and argument', () => {
  const all = commands();
  for (const [path, cmd, arg] of EXPECTED) {
    const hit = find(all, path);
    assert.ok(hit, `missing: ${path.join(' > ')}`);
    assert.equal(hit.cmd, cmd, path.join(' > '));
    assert.deepEqual(hit.arg, arg, path.join(' > '));
  }
  // Edit: Define Brush Preset… before Define Pattern…, Define Custom Shape… after it
  const edit = all.filter((x) => x.path[0] === 'Edit').map((x) => x.cmd);
  const iPattern = edit.indexOf('edit:define-pattern');
  assert.deepEqual(edit.slice(iPattern - 1, iPattern + 2), ['edit:define-brush', 'edit:define-pattern', 'edit:define-custom-shape']);
  // after Purge: Presets, then Color Settings, Assign and Convert, then Keyboard Shortcuts, Menus, Preferences and Camera Raw Preferences
  const tail = edit.slice(edit.lastIndexOf('edit:purge') + 1);
  assert.deepEqual(tail, ['edit:preset-manager', 'edit:export-import-presets', 'edit:migrate-presets', 'edit:color-settings', 'edit:assign-profile', 'edit:convert-profile', 'help:shortcuts', 'edit:menus', 'edit:preferences', 'edit:camera-raw-preferences']);
  // Type: Add Fonts first, Anti-Alias after Panels; the conversions after Rasterize Type Layer; the 0.4 items stay
  const typeMenu = build().find((m) => m.label === 'T&ype').submenu.filter((i) => i.type !== 'separator').map((i) => i.label.replace(/&/g, ''));
  assert.equal(typeMenu[0], 'Add Fonts…');
  assert.equal(typeMenu[typeMenu.indexOf('Panels') + 1], 'Anti-Alias');
  const iRaster = typeMenu.indexOf('Rasterize Type Layer');
  assert.deepEqual(typeMenu.slice(iRaster + 1), ['Convert to Paragraph Text', 'Warp Text…', 'Create Work Path', 'Convert to Shape', 'Font Preview Size', 'Update All Text Layers', 'Manage Missing Fonts…', 'Replace All Missing Fonts', 'Paste Lorem Ipsum']);
  for (const old of ['Orientation', 'Text on Path', 'Release from Path', 'Flip Text on Path', 'Edit Text']) assert.ok(typeMenu.includes(old), old);
  // the Convert label follows state.textKind; the radios follow antiAlias and fontPreviewSize
  assert.ok(find(commands('linux', { ...FULL, textKind: 'paragraph' }), ['Type', 'Convert to Point Text']));
  const radios = commands('linux', { ...FULL, antiAlias: 'crisp', fontPreviewSize: 'huge' });
  assert.deepEqual(radios.filter((x) => x.cmd === 'type:anti-alias' && x.item.checked).map((x) => x.arg), ['crisp']);
  assert.deepEqual(radios.filter((x) => x.cmd === 'type:font-preview-size' && x.item.checked).map((x) => x.arg), ['huge']);
  // Window: Color, Swatches, Gradients, Patterns, Styles, Shapes, ─, Brush Settings, Brushes, Tool Presets, ─, 0.4's list
  assert.deepEqual(PANELS.slice(0, 12).map((p) => p?.[0] ?? null), ['color', 'swatches', 'gradients', 'patterns', 'styles', 'shapes', null, 'brush-settings', 'brushes', 'tool-presets', null, 'properties']);
  // macOS: Preferences and Camera Raw Preferences in the app menu, after Settings…
  const mac = build('darwin');
  const appMenu = mac[0].submenu.map((i) => i.label);
  assert.equal(appMenu[appMenu.indexOf('Settings…') + 1], 'Camera Raw Preferences…');
  assert.ok(!commands('darwin').some((x) => x.path[0] === 'Edit' && (x.cmd === 'edit:preferences' || x.cmd === 'edit:camera-raw-preferences')));
});

test('the function keys reach the native menu: Revert F12, Pigment Help F1, the panels F5 to F8', () => {
  const all = commands();
  const accel = (path) => find(all, path)?.item.accelerator;
  assert.ok(sameAccelerator(accel(['File', 'Revert']), 'F12'));
  assert.ok(sameAccelerator(accel(['Help', 'Pigment Help']), 'F1'));
  assert.ok(sameAccelerator(accel(['Window', 'Brush Settings']), 'F5'));
  assert.ok(sameAccelerator(accel(['Window', 'Color']), 'F6'));
  assert.ok(sameAccelerator(accel(['Window', 'Layers']), 'F7'));
  assert.ok(sameAccelerator(accel(['Window', 'Info']), 'F8'));
  // the developer tools: Shift+CmdOrCtrl+F12 in development builds, no item in packaged ones
  assert.ok(sameAccelerator(accel(['Help', 'Toggle Developer Tools']), 'Shift+CmdOrCtrl+F12'));
  assert.ok(!commands('linux', FULL, { isPackaged: true }).some((x) => x.cmd === 'help:devtools'));
  // full screen: Ctrl+Cmd+F on macOS (fixed), F11 elsewhere
  assert.ok(sameAccelerator(find(commands('darwin'), ['View', 'Toggle Full Screen']).item.accelerator, 'Ctrl+Cmd+F'));
  assert.ok(sameAccelerator(accel(['View', 'Toggle Full Screen']), 'F11'));
});

/** The key combination an accelerator stands for on a platform (CmdOrCtrl resolved). */
function combo(accel, platform) {
  const d = parseAccelerator(accel);
  const mac = platform === 'darwin';
  const ctrl = d.ctrl || (d.cmdOrCtrl && !mac);
  const meta = d.meta || (d.cmdOrCtrl && mac);
  return `${ctrl ? 'C' : ''}${meta ? 'M' : ''}${d.alt ? 'A' : ''}${d.shift ? 'S' : ''}+${d.key}`;
}

test('no accelerator is used twice in the template, on any platform, state and build', () => {
  const states = [FULL, { ...FULL, showGalleryInMenu: true }, {}, { ...FULL, keymap: JSON.stringify({ v: 1, menu: { 'layer:new': 'CmdOrCtrl+Alt+K' } }) }];
  for (const platform of ['darwin', 'win32', 'linux']) {
    for (const state of states) {
      for (const isPackaged of [true, false]) {
        const seen = new Map();
        const walk = (list) => {
          for (const it of list) {
            if (it.submenu) walk(it.submenu);
            if (!it.accelerator) continue;
            const k = combo(it.accelerator, platform);
            assert.ok(!seen.has(k), `${platform}: ${it.accelerator} on "${it.label}" and "${seen.get(k)}"`);
            seen.set(k, it.label);
          }
        };
        walk(build(platform, state, { isPackaged }));
      }
    }
  }
});

test('accelerators follow the keymap overlay of the ui state', () => {
  const state = { ...FULL, keymap: JSON.stringify({ v: 1, menu: { 'layer:new': 'CmdOrCtrl+Alt+K', 'file:save': null, 'window:panel-layers': null } }) };
  const all = commands('linux', state);
  assert.equal(find(all, ['Layer', 'New', 'Layer…']).item.accelerator, 'CmdOrCtrl+Alt+K');
  assert.equal(find(all, ['File', 'Save']).item.accelerator ?? null, null);
  assert.equal(find(all, ['Window', 'Layers']).item.accelerator ?? null, null);
  // a malformed keymap is the default tables
  assert.equal(find(commands('linux', { ...FULL, keymap: '{nope' }), ['File', 'Save']).item.accelerator, 'CmdOrCtrl+S');
  // menuItemCommands: every command with a native item, on either platform
  const cmds = menuItemCommands();
  for (const id of ['layer:new', 'file:save', 'edit:preferences', 'window:panel-layers', 'type:anti-alias', 'help:devtools']) assert.ok(cmds.has(id), id);
  assert.ok(!cmds.has('tool:brush'));
  assert.ok(!cmds.has('layer:opacity-digit-1'));
});

test('hidden and coloured items, "Show All Menu Items", and showAll', () => {
  const menus = { set: 'default', hidden: ['layer:new', 'edit:purge|"undo"', 'menu:Edit>Transform', 'file:print'], colors: { 'file:save': 'red', 'menu:Image>Mode': 'blue', 'edit:purge|"all"': 'green' }, showAll: false };
  const state = { ...FULL, menus: JSON.stringify(menus) };
  const t = build('linux', state);
  const all = commands('linux', state);
  assert.ok(!find(all, ['Layer', 'New', 'Layer…']));
  assert.ok(!find(all, ['Edit', 'Purge', 'Undo']));
  assert.ok(find(all, ['Edit', 'Purge', 'Clipboard']));
  assert.ok(!all.some((x) => x.path[1] === 'Transform'));
  assert.ok(!find(all, ['File', 'Print…']));
  // a menu that lost items ends with a separator and Show All Menu Items
  const ends = (menu) => {
    const items = menu.submenu;
    assert.equal(items.at(-2).type, 'separator', menu.label);
    assert.equal(items.at(-1).label, 'Show All Menu Items', menu.label);
  };
  ends(t.find((m) => m.label === '&File'));
  ends(t.find((m) => m.label === '&Edit'));
  ends(t.find((m) => m.label === '&Edit').submenu.find((m) => m.label === 'Purge'));
  ends(t.find((m) => m.label === '&Layer').submenu.find((m) => m.label === '&New'));
  assert.equal(find(all, ['File', 'Show All Menu Items']).cmd, 'edit:show-all-menu-items');
  // a menu that lost nothing has no such item; no separator twice or at either end of a menu
  assert.ok(!t.find((m) => m.label === '&Image').submenu.some((i) => i.label === 'Show All Menu Items'));
  const walk = (list, path) => {
    list.forEach((it, i) => {
      if (it.type === 'separator') {
        assert.ok(i > 0 && i < list.length - 1, `separator at an end of ${path}`);
        assert.notEqual(list[i + 1]?.type, 'separator', `two separators in ${path}`);
      }
      if (it.submenu) walk(it.submenu, `${path} > ${it.label}`);
    });
  };
  walk(t, 'menu');
  // coloured items and submenus carry pigmentColor (main.js draws the dot)
  assert.equal(find(all, ['File', 'Save']).item.pigmentColor, 'red');
  assert.equal(find(all, ['Edit', 'Purge', 'All']).item.pigmentColor, 'green');
  assert.equal(t.find((m) => m.label === '&Image').submenu.find((m) => m.label === '&Mode').pigmentColor, 'blue');
  assert.equal(find(all, ['File', 'Open…']).item.pigmentColor, undefined);
  // Show All: every item back, colours kept, no Show All item
  const shown = commands('linux', { ...FULL, menus: JSON.stringify({ ...menus, showAll: true }) });
  assert.ok(find(shown, ['Layer', 'New', 'Layer…']));
  assert.ok(!shown.some((x) => x.cmd === 'edit:show-all-menu-items'));
  assert.equal(find(shown, ['File', 'Save']).item.pigmentColor, 'red');
  // the stub disables the item like every other stub
  const stubbed = commands('linux', { ...FULL, menus: JSON.stringify(menus), stubs: 'edit:show-all-menu-items' });
  assert.equal(find(stubbed, ['File', 'Show All Menu Items']).item.enabled, false);
});

test('the macOS application menu is customised like the others; Toggle Full Screen shows a key set() moved to menu', () => {
  const menus = { hidden: ['edit:preferences', 'edit:camera-raw-preferences', 'menu:Pigment'], colors: { 'help:about': 'red' } };
  const t = build('darwin', { ...FULL, menus: JSON.stringify(menus) });
  const app = t[0];
  assert.equal(app.label, 'Pigment'); // the menu itself stays: Quit lives there
  const labels = app.submenu.map((i) => i.label ?? i.role ?? i.type);
  assert.ok(!labels.some((l) => /^Settings|^Camera Raw Preferences/.test(l)), labels.join());
  assert.ok(labels.includes('quit'));
  assert.equal(app.submenu.at(-1).label, 'Show All Menu Items');
  assert.equal(app.submenu.find((i) => /^About/.test(i.label ?? '')).pigmentColor, 'red');
  const full = (platform, keymap) => commands(platform, { ...FULL, keymap: JSON.stringify(keymap) }).find((x) => x.cmd === 'view:fullscreen').item.accelerator;
  const moved = { v: 1, menu: { 'view:fullscreen': 'CmdOrCtrl+Alt+Shift+F11' }, renderer: { 'view:fullscreen': [] } };
  assert.equal(full('win32', moved), 'CmdOrCtrl+Alt+Shift+F11');
  assert.equal(full('linux', { v: 1 }), 'F11');
  assert.equal(full('darwin', moved), 'Ctrl+Cmd+F');
});
