// Single source of truth for keyboard shortcuts.
// MENU_KEYS: command -> Electron accelerator shown in (and registered by) the native menu.
// RENDERER_KEYS: extra combos only the renderer handles (never put plain keys such as Home or a
// letter in the native menu: on macOS the menu intercepts them even while typing in a text field).
//
// Dispatch rule: the renderer handles every combo it recognises (both tables) and calls
// preventDefault; on macOS the native menu intercepts MENU_KEYS first, on Windows/Linux the page
// sees the key first. The command registry de-duplicates a command that arrives twice within a
// few milliseconds from different sources, so neither path can double-fire.

export const MENU_KEYS = {
  'file:open': 'CmdOrCtrl+O',
  'file:save': 'CmdOrCtrl+S',
  'file:save-as': 'CmdOrCtrl+Shift+S',
  'file:print': 'CmdOrCtrl+P',
  'file:close': 'CmdOrCtrl+W',
  'file:properties': 'CmdOrCtrl+D',
  'edit:undo': 'CmdOrCtrl+Z',
  'edit:redo': 'CmdOrCtrl+Shift+Z',
  'edit:cut': 'CmdOrCtrl+X',
  'edit:copy': 'CmdOrCtrl+C',
  'edit:paste': 'CmdOrCtrl+V',
  'edit:select-all': 'CmdOrCtrl+A',
  'edit:find': 'CmdOrCtrl+F',
  'edit:find-next': 'CmdOrCtrl+G',
  'edit:find-prev': 'CmdOrCtrl+Shift+G',
  'edit:preferences': 'CmdOrCtrl+,',
  'view:zoom-in': 'CmdOrCtrl+=',
  'view:zoom-out': 'CmdOrCtrl+-',
  'view:fit-page': 'CmdOrCtrl+0',
  'view:actual-size': 'CmdOrCtrl+1',
  'view:fit-width': 'CmdOrCtrl+2',
  'view:rotate-cw': 'CmdOrCtrl+R',
  'view:rotate-ccw': 'CmdOrCtrl+Shift+R',
  'view:go-to-page': 'CmdOrCtrl+Shift+N',
  'view:back': 'CmdOrCtrl+[',
  'view:forward': 'CmdOrCtrl+]',
  'view:toggle-sidebar': 'CmdOrCtrl+Shift+B',
  'view:presentation': 'CmdOrCtrl+L',
  'view:read-aloud': 'CmdOrCtrl+Shift+Y',
  'view:next-tab': 'Ctrl+Tab',
  'view:prev-tab': 'Ctrl+Shift+Tab',
  'pages:organize': 'CmdOrCtrl+Shift+O',
  'help:shortcuts': 'CmdOrCtrl+/',
  'help:devtools': 'CmdOrCtrl+Shift+I',
};

// Renderer-only combos (Electron accelerator syntax for uniformity). "Text" combos are skipped
// while a text field is focused; "plain" letters are skipped when any modifier is held.
export const RENDERER_KEYS = {
  'edit:redo': ['CmdOrCtrl+Y'],
  'edit:find-next': ['F3'],
  'edit:find-prev': ['Shift+F3'],
  'view:zoom-in': ['CmdOrCtrl+Plus', 'CmdOrCtrl+numadd'],
  'view:zoom-out': ['CmdOrCtrl+numsub'],
  'view:first-page': ['Home', 'CmdOrCtrl+Up'],
  'view:last-page': ['End', 'CmdOrCtrl+Down'],
  'view:next-page': ['PageDown', 'Right', 'j'],
  'view:prev-page': ['PageUp', 'Left', 'k'],
  'view:back': ['Alt+Left'],
  'view:forward': ['Alt+Right'],
  'view:fullscreen': ['F11'],
  'view:presentation': ['F5'],
  'view:toggle-sidebar': ['F4'],
  'help:devtools': ['F12'],
  'tool:none': ['v'],
  'view:hand-tool': ['h'],
  'tool:highlight': ['u'],
  'tool:text': ['t'],
  'tool:ink': ['d'],
  'tool:note': ['n'],
  'tool:sign': ['s'],
  'edit:delete': ['Delete', 'Backspace'],
  'app:escape': ['Escape'],
};

// Human readable labels for the shortcuts help dialog (renderer builds the table from both maps).
export const SHORTCUT_GROUPS = [
  { title: 'Files', commands: ['file:open', 'file:save', 'file:save-as', 'file:print', 'file:close', 'file:properties'] },
  { title: 'Editing', commands: ['edit:undo', 'edit:redo', 'edit:cut', 'edit:copy', 'edit:paste', 'edit:select-all', 'edit:delete', 'edit:preferences'] },
  { title: 'Search', commands: ['edit:find', 'edit:find-next', 'edit:find-prev'] },
  { title: 'Navigation', commands: ['view:first-page', 'view:prev-page', 'view:next-page', 'view:last-page', 'view:go-to-page', 'view:back', 'view:forward', 'view:next-tab', 'view:prev-tab'] },
  { title: 'View', commands: ['view:zoom-in', 'view:zoom-out', 'view:actual-size', 'view:fit-page', 'view:fit-width', 'view:rotate-cw', 'view:rotate-ccw', 'view:toggle-sidebar', 'view:presentation', 'view:fullscreen', 'view:read-aloud'] },
  { title: 'Tools', commands: ['tool:none', 'view:hand-tool', 'tool:highlight', 'tool:text', 'tool:ink', 'tool:note', 'tool:sign', 'pages:organize', 'app:escape'] },
  { title: 'Help', commands: ['help:shortcuts', 'help:devtools'] },
];

export const COMMAND_LABELS = {
  'file:open': 'Open file', 'file:save': 'Save', 'file:save-as': 'Save as', 'file:print': 'Print', 'file:close': 'Close tab',
  'file:properties': 'Document properties', 'edit:undo': 'Undo', 'edit:redo': 'Redo', 'edit:cut': 'Cut', 'edit:copy': 'Copy',
  'edit:paste': 'Paste', 'edit:select-all': 'Select all', 'edit:delete': 'Delete selected annotation', 'edit:preferences': 'Preferences',
  'edit:find': 'Find', 'edit:find-next': 'Find next', 'edit:find-prev': 'Find previous', 'view:first-page': 'First page',
  'view:prev-page': 'Previous page', 'view:next-page': 'Next page', 'view:last-page': 'Last page', 'view:go-to-page': 'Go to page',
  'view:back': 'Back', 'view:forward': 'Forward', 'view:next-tab': 'Next tab', 'view:prev-tab': 'Previous tab', 'view:zoom-in': 'Zoom in',
  'view:zoom-out': 'Zoom out', 'view:actual-size': 'Actual size', 'view:fit-page': 'Fit page', 'view:fit-width': 'Fit width',
  'view:rotate-cw': 'Rotate clockwise', 'view:rotate-ccw': 'Rotate counter-clockwise', 'view:toggle-sidebar': 'Show or hide the sidebar',
  'view:presentation': 'Presentation mode', 'view:fullscreen': 'Full screen', 'view:read-aloud': 'Read out loud', 'tool:none': 'Select tool',
  'view:hand-tool': 'Hand tool', 'tool:highlight': 'Highlight', 'tool:text': 'Text box', 'tool:ink': 'Draw', 'tool:note': 'Sticky note',
  'tool:sign': 'Sign', 'pages:organize': 'Organize pages', 'app:escape': 'Leave the current tool, find bar or presentation',
  'help:shortcuts': 'Keyboard shortcuts', 'help:devtools': 'Developer tools',
};

/**
 * Parses an Electron accelerator ("CmdOrCtrl+Shift+Z") into a normalized key descriptor.
 * @returns {{ key: string, ctrl: boolean, meta: boolean, alt: boolean, shift: boolean, cmdOrCtrl: boolean }}
 */
export function parseAccelerator(accel) {
  const parts = String(accel).split('+');
  const key = parts.pop();
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  return {
    key: normalizeKeyName(key),
    cmdOrCtrl: mods.has('cmdorctrl') || mods.has('commandorcontrol'),
    ctrl: mods.has('ctrl') || mods.has('control'),
    meta: mods.has('cmd') || mods.has('command') || mods.has('super') || mods.has('meta'),
    alt: mods.has('alt') || mods.has('option'),
    shift: mods.has('shift'),
  };
}

const KEY_ALIASES = {
  plus: '+', '=': '=', '-': '-', ',': ',', '/': '/', '[': '[', ']': ']',
  numadd: 'numpad+', numsub: 'numpad-', esc: 'escape', return: 'enter', space: ' ',
  up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright',
};

export function normalizeKeyName(key) {
  const lower = String(key).toLowerCase();
  return KEY_ALIASES[lower] ?? lower;
}

/**
 * Tests a KeyboardEvent against a parsed accelerator.
 * @param {KeyboardEvent} event
 * @param {ReturnType<typeof parseAccelerator>} desc
 * @param {boolean} isMac
 */
export function eventMatches(event, desc, isMac) {
  let key = String(event.key).toLowerCase();
  if (event.location === 3 /* numpad */ && (key === '+' || key === '-')) key = `numpad${key}`;
  if (key !== desc.key) {
    // "=" and "+" share a physical key on most layouts; treat Cmd+= and Cmd++ the same.
    if (!((desc.key === '=' && key === '+') || (desc.key === '+' && key === '='))) return false;
  }
  const wantCtrl = desc.ctrl || (desc.cmdOrCtrl && !isMac);
  const wantMeta = desc.meta || (desc.cmdOrCtrl && isMac);
  return !!event.ctrlKey === wantCtrl && !!event.metaKey === wantMeta && !!event.altKey === desc.alt && !!event.shiftKey === desc.shift;
}

/** Human-readable form for the current platform, e.g. "⌘⇧S" or "Ctrl+Shift+S". */
export function describeAccelerator(accel, isMac) {
  const d = parseAccelerator(accel);
  const keyNames = { arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→', escape: 'Esc', ' ': 'Space', 'numpad+': 'Num +', 'numpad-': 'Num -', pageup: 'Page Up', pagedown: 'Page Down' };
  const keyLabel = keyNames[d.key] ?? (d.key.length === 1 ? d.key.toUpperCase() : d.key[0].toUpperCase() + d.key.slice(1));
  if (isMac) {
    return `${d.ctrl ? '⌃' : ''}${d.alt ? '⌥' : ''}${d.shift ? '⇧' : ''}${d.meta || d.cmdOrCtrl ? '⌘' : ''}${keyLabel}`;
  }
  const parts = [];
  if (d.ctrl || d.cmdOrCtrl) parts.push('Ctrl');
  if (d.meta) parts.push('Win');
  if (d.alt) parts.push('Alt');
  if (d.shift) parts.push('Shift');
  parts.push(keyLabel);
  return parts.join('+');
}
