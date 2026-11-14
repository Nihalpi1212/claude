// shortcuts-editor's MODULES entry (ARCHITECTURE.md "0.5 features", package 14). Until the package lands this is the
// skeleton's stub (S15): Help > Keyboard Shortcuts (help:shortcuts, Alt+Shift+Ctrl+K) works and shows 0.4's list of
// shortcuts, moved here verbatim from app.js (its keys now read through app.keymap.keysFor, S9.4); Edit > Menus…
// (edit:menus) and "Show All Menu Items" are disabled stubs. The package replaces this file at the same path with the
// Keyboard Shortcuts and Menus dialog over app.keymap (S9), keeping help:shortcuts.
import { SHORTCUT_GROUPS, COMMAND_LABELS, describeAccelerator } from '../../shared/keymap.js';
import { isMac } from './bridge.js';
import { stubCommands } from './stub.js';

export function shortcutsDialog(app) {
  const content = document.createElement('div');
  content.style.maxHeight = '60vh';
  content.style.overflow = 'auto';
  const table = document.createElement('table');
  table.className = 'kbd-table';
  for (const group of SHORTCUT_GROUPS) {
    const head = document.createElement('tr');
    head.innerHTML = `<th colspan="2">${group.title}${group.type ? ' (while editing text)' : group.paint ? ' (with a painting tool)' : ''}</th>`;
    table.appendChild(head);
    for (const cmd of group.commands) {
      // keymap (lib/keymap-store.js)
      const keys = app.keymap.keysFor(cmd, group.type ? 'type' : group.paint ? 'paint' : 'global');
      if (!keys.length) continue;
      const tr = document.createElement('tr');
      const a = document.createElement('td');
      a.textContent = COMMAND_LABELS[cmd] ?? cmd;
      const b = document.createElement('td');
      b.textContent = keys.map((k) => describeAccelerator(k, isMac)).join('  ·  ');
      tr.append(a, b);
      table.appendChild(tr);
    }
  }
  const extra = document.createElement('p');
  extra.className = 'muted';
  extra.textContent = 'Hold Space to pan with any tool. Ctrl/Cmd + mouse wheel zooms. Alt-click with a painting tool samples a colour. Shift+letter cycles the tools in a slot.';
  content.append(table, extra);
  return app.dialogs.open({ title: 'Keyboard Shortcuts', content, width: 560, buttons: [{ label: 'Close', value: true, primary: true }] });
}

export function install(app) {
  app.commands.register('help:shortcuts', { run: () => shortcutsDialog(app) });
  stubCommands(app, ['edit:menus', { id: 'edit:show-all-menu-items', record: false }]);
}
