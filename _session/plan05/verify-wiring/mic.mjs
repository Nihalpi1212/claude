import { buildMenuTemplate, menuItemCommands } from '/home/user/claude/pigment/src/shared/menu-template.js';
import { MENU_KEYS } from '/home/user/claude/pigment/src/shared/keymap.js';
const base = menuItemCommands();
const extra = new Set();
const states = [];
for (const mode of ['rgb', 'grayscale', 'indexed', 'cmyk', 'lab', 'duotone', 'bitmap', 'multichannel']) for (const layerType of ['raster', 'text', 'smart', 'shape', 'fill', 'adjustment', 'group', null]) for (const depth of [8, 16, 32]) states.push({ hasDocument: true, hasLayer: true, hasSelection: true, mode, layerType, depth, typeEditing: true, editingMask: true, isolated: true, hasVectorMask: true, stackMode: 'mean', backgroundLayer: true });
for (const platform of ['darwin', 'win32', 'linux']) for (const state of states) {
  const walk = (l) => { for (const it of l) { if (Array.isArray(it.submenu)) walk(it.submenu); else if (typeof it.click === 'function') it.click(it, null, undefined); } };
  walk(buildMenuTemplate({ platform, state, recent: [{ path: '/x', name: 'x' }], run: (c) => { if (!base.has(c)) extra.add(c); }, isPackaged: false }));
}
console.log('commands with items missing from menuItemCommands:', [...extra]);
console.log('MENU_KEYS commands without an item:', Object.keys(MENU_KEYS).filter((c) => !base.has(c)));
