// Single source of truth for keyboard shortcuts (Photoshop's defaults wherever they exist).
// MENU_KEYS: command -> Electron accelerator shown in (and registered by) the native menu.
// RENDERER_KEYS: extra combos only the renderer handles. Never put plain keys (letters, Delete,
// Escape) in the native menu: on macOS the menu would intercept them while typing in a text field.
//
// Dispatch rule: the renderer handles every combo it recognises (both tables) and calls
// preventDefault; on macOS the native menu intercepts MENU_KEYS first, on Windows/Linux the page
// sees the key first. The command registry de-duplicates a command that arrives twice within a
// few milliseconds from different sources, so neither path can double-fire.

export const MENU_KEYS = {
  'file:new': 'CmdOrCtrl+N',
  'file:open': 'CmdOrCtrl+O',
  'file:save': 'CmdOrCtrl+S',
  'file:save-as': 'CmdOrCtrl+Shift+S',
  'file:export': 'CmdOrCtrl+Alt+Shift+S',
  'file:export-quick': 'CmdOrCtrl+Alt+Shift+E',
  'file:close': 'CmdOrCtrl+W',
  'file:close-all': 'CmdOrCtrl+Alt+W',
  'file:properties': 'CmdOrCtrl+Alt+Shift+I',
  'file:print': 'CmdOrCtrl+P',
  'edit:undo': 'CmdOrCtrl+Z',
  'edit:redo': 'CmdOrCtrl+Shift+Z',
  'edit:step-forward': 'CmdOrCtrl+Alt+Shift+Z',
  'edit:step-backward': 'CmdOrCtrl+Alt+Z',
  'edit:cut': 'CmdOrCtrl+X',
  'edit:copy': 'CmdOrCtrl+C',
  'edit:copy-merged': 'CmdOrCtrl+Shift+C',
  'edit:paste': 'CmdOrCtrl+V',
  'edit:paste-in-place': 'CmdOrCtrl+Shift+V',
  'edit:paste-into': 'CmdOrCtrl+Alt+Shift+V',
  'edit:fill': 'Shift+F5',
  'edit:free-transform': 'CmdOrCtrl+T',
  'edit:transform-again': 'CmdOrCtrl+Shift+T',
  'edit:preferences': 'CmdOrCtrl+K',
  'image:adjust-levels': 'CmdOrCtrl+L',
  'image:adjust-curves': 'CmdOrCtrl+M',
  'image:adjust-hue-saturation': 'CmdOrCtrl+U',
  'image:adjust-color-balance': 'CmdOrCtrl+B',
  'image:adjust-black-white': 'CmdOrCtrl+Alt+Shift+B',
  'image:adjust-invert': 'CmdOrCtrl+I',
  'image:adjust-desaturate': 'CmdOrCtrl+Shift+U',
  'image:auto-tone': 'CmdOrCtrl+Shift+L',
  'image:auto-contrast': 'CmdOrCtrl+Alt+Shift+L',
  'image:auto-color': 'CmdOrCtrl+Shift+B',
  'image:size': 'CmdOrCtrl+Alt+I',
  'image:canvas-size': 'CmdOrCtrl+Alt+C',
  'layer:new': 'CmdOrCtrl+Shift+N',
  'layer:via-copy': 'CmdOrCtrl+J',
  'layer:via-cut': 'CmdOrCtrl+Shift+J',
  'layer:group': 'CmdOrCtrl+G',
  'layer:ungroup': 'CmdOrCtrl+Shift+G',
  'layer:clip': 'CmdOrCtrl+Alt+G',
  'layer:merge-down': 'CmdOrCtrl+E',
  'layer:merge-visible': 'CmdOrCtrl+Shift+E',
  'layer:arrange-front': 'CmdOrCtrl+Shift+]',
  'layer:arrange-forward': 'CmdOrCtrl+]',
  'layer:arrange-backward': 'CmdOrCtrl+[',
  'layer:arrange-back': 'CmdOrCtrl+Shift+[',
  'layer:select-all': 'CmdOrCtrl+Alt+A',
  'select:all': 'CmdOrCtrl+A',
  'select:none': 'CmdOrCtrl+D',
  'select:reselect': 'CmdOrCtrl+Shift+D',
  'select:inverse': 'CmdOrCtrl+Shift+I',
  'select:feather': 'Shift+F6',
  'filter:last': 'CmdOrCtrl+F',
  'filter:liquify': 'CmdOrCtrl+Shift+X',
  'filter:camera-raw': 'CmdOrCtrl+Shift+A',
  'view:gamut': 'CmdOrCtrl+Shift+Y',
  'view:zoom-in': 'CmdOrCtrl+=',
  'view:zoom-out': 'CmdOrCtrl+-',
  'view:zoom-fit': 'CmdOrCtrl+0',
  'view:zoom-100': 'CmdOrCtrl+1',
  'view:rulers': 'CmdOrCtrl+R',
  'view:grid': "CmdOrCtrl+'",
  'view:guides': 'CmdOrCtrl+;',
  'view:extras': 'CmdOrCtrl+H',
  'view:snap': 'CmdOrCtrl+Shift+;',
  'view:next-tab': 'Ctrl+Tab',
  'view:prev-tab': 'Ctrl+Shift+Tab',
  'help:shortcuts': 'CmdOrCtrl+/',
};

// Renderer-only combos. Plain letters select tools (Photoshop's keys); Shift+letter cycles a tool slot.
export const RENDERER_KEYS = {
  'edit:redo': ['CmdOrCtrl+Y'],
  'edit:clear': ['Delete', 'Backspace'],
  'edit:fill-foreground': ['Alt+Backspace', 'Alt+Delete'],
  'edit:fill-background': ['CmdOrCtrl+Backspace', 'CmdOrCtrl+Delete'],
  'view:zoom-in': ['CmdOrCtrl+Plus', 'CmdOrCtrl+numadd'],
  'view:zoom-out': ['CmdOrCtrl+numsub'],
  'view:zoom-200': ['CmdOrCtrl+2'],
  'view:fullscreen': ['F11'],
  'window:toggle-panels': ['Tab'],
  'help:devtools': ['F12'],
  'tool:move': ['v'],
  'tool:marquee': ['m'],
  'tool:lasso': ['l'],
  'tool:wand': ['w'],
  'tool:crop': ['c'],
  'tool:eyedropper': ['i'],
  'tool:heal': ['j'],
  'tool:brush': ['b'],
  'tool:clone': ['s'],
  'tool:history': ['y'],
  'tool:eraser': ['e'],
  'tool:fill': ['g'],
  'tool:retouch': ['o'],
  'tool:pen': ['p'],
  'tool:text': ['t'],
  'tool:path-select': ['a'],
  'tool:shape': ['u'],
  'tool:hand': ['h'],
  'tool:rotate-view': ['r'],
  'tool:zoom': ['z'],
  'tool:swap-colors': ['x'],
  'tool:default-colors': ['d'],
  'tool:brush-size-down': ['['],
  'tool:brush-size-up': [']'],
  'tool:brush-hardness-down': ['Shift+['],
  'tool:brush-hardness-up': ['Shift+]'],
  'layer:mask-toggle-view': ['Alt+\\'],
  'app:escape': ['Escape'],
  'app:enter': ['Enter'],
};

export const SHORTCUT_GROUPS = [
  { title: 'Files', commands: ['file:new', 'file:open', 'file:save', 'file:save-as', 'file:export', 'file:export-quick', 'file:print', 'file:close', 'file:properties'] },
  { title: 'Editing', commands: ['edit:undo', 'edit:redo', 'edit:step-backward', 'edit:step-forward', 'edit:cut', 'edit:copy', 'edit:copy-merged', 'edit:paste', 'edit:paste-in-place', 'edit:clear', 'edit:fill', 'edit:fill-foreground', 'edit:fill-background', 'edit:free-transform', 'edit:preferences'] },
  { title: 'Image', commands: ['image:adjust-levels', 'image:adjust-curves', 'image:adjust-hue-saturation', 'image:adjust-color-balance', 'image:adjust-black-white', 'image:adjust-invert', 'image:adjust-desaturate', 'image:auto-tone', 'image:auto-contrast', 'image:auto-color', 'image:size', 'image:canvas-size'] },
  { title: 'Layers', commands: ['layer:new', 'layer:via-copy', 'layer:via-cut', 'layer:group', 'layer:ungroup', 'layer:clip', 'layer:merge-down', 'layer:merge-visible', 'layer:arrange-front', 'layer:arrange-forward', 'layer:arrange-backward', 'layer:arrange-back', 'layer:select-all'] },
  { title: 'Selection', commands: ['select:all', 'select:none', 'select:reselect', 'select:inverse', 'select:feather'] },
  { title: 'Filters', commands: ['filter:last', 'filter:liquify', 'filter:camera-raw'] },
  { title: 'View', commands: ['view:zoom-in', 'view:zoom-out', 'view:zoom-fit', 'view:zoom-100', 'view:zoom-200', 'view:rulers', 'view:grid', 'view:guides', 'view:extras', 'view:snap', 'view:gamut', 'view:fullscreen', 'window:toggle-panels', 'view:next-tab', 'view:prev-tab'] },
  { title: 'Tools', commands: ['tool:move', 'tool:marquee', 'tool:lasso', 'tool:wand', 'tool:crop', 'tool:eyedropper', 'tool:heal', 'tool:brush', 'tool:clone', 'tool:history', 'tool:eraser', 'tool:fill', 'tool:retouch', 'tool:pen', 'tool:text', 'tool:path-select', 'tool:shape', 'tool:hand', 'tool:rotate-view', 'tool:zoom', 'tool:swap-colors', 'tool:default-colors', 'tool:brush-size-down', 'tool:brush-size-up', 'tool:brush-hardness-down', 'tool:brush-hardness-up', 'app:escape', 'app:enter'] },
  { title: 'Help', commands: ['help:shortcuts', 'help:devtools'] },
];

export const COMMAND_LABELS = {
  'file:new': 'New document', 'file:open': 'Open', 'file:save': 'Save', 'file:save-as': 'Save as', 'file:export': 'Export as', 'file:export-quick': 'Quick export as PNG',
  'file:close': 'Close', 'file:close-all': 'Close all', 'file:properties': 'Document info', 'file:print': 'Print',
  'filter:liquify': 'Liquify', 'filter:camera-raw': 'Camera Raw filter', 'view:gamut': 'Gamut warning',
  'edit:undo': 'Undo', 'edit:redo': 'Redo', 'edit:step-backward': 'Step backward', 'edit:step-forward': 'Step forward', 'edit:cut': 'Cut', 'edit:copy': 'Copy',
  'edit:copy-merged': 'Copy merged', 'edit:paste': 'Paste', 'edit:paste-in-place': 'Paste in place', 'edit:paste-into': 'Paste into selection', 'edit:clear': 'Clear selection',
  'edit:fill': 'Fill…', 'edit:fill-foreground': 'Fill with foreground colour', 'edit:fill-background': 'Fill with background colour', 'edit:free-transform': 'Free transform',
  'edit:transform-again': 'Transform again', 'edit:preferences': 'Preferences',
  'image:adjust-levels': 'Levels', 'image:adjust-curves': 'Curves', 'image:adjust-hue-saturation': 'Hue/Saturation', 'image:adjust-color-balance': 'Color balance',
  'image:adjust-black-white': 'Black & white', 'image:adjust-invert': 'Invert', 'image:adjust-desaturate': 'Desaturate', 'image:auto-tone': 'Auto tone', 'image:auto-contrast': 'Auto contrast',
  'image:auto-color': 'Auto color', 'image:size': 'Image size', 'image:canvas-size': 'Canvas size',
  'layer:new': 'New layer', 'layer:via-copy': 'Layer via copy', 'layer:via-cut': 'Layer via cut', 'layer:group': 'Group layers', 'layer:ungroup': 'Ungroup', 'layer:clip': 'Create / release clipping mask',
  'layer:merge-down': 'Merge down', 'layer:merge-visible': 'Merge visible', 'layer:arrange-front': 'Bring to front', 'layer:arrange-forward': 'Bring forward', 'layer:arrange-backward': 'Send backward',
  'layer:arrange-back': 'Send to back', 'layer:select-all': 'Select all layers',
  'select:all': 'Select all', 'select:none': 'Deselect', 'select:reselect': 'Reselect', 'select:inverse': 'Inverse', 'select:feather': 'Feather…', 'filter:last': 'Repeat last filter',
  'view:zoom-in': 'Zoom in', 'view:zoom-out': 'Zoom out', 'view:zoom-fit': 'Fit on screen', 'view:zoom-100': '100%', 'view:zoom-200': '200%', 'view:rulers': 'Rulers', 'view:grid': 'Grid',
  'view:guides': 'Guides', 'view:extras': 'Show / hide extras', 'view:snap': 'Snap', 'view:fullscreen': 'Full screen', 'window:toggle-panels': 'Hide / show panels', 'view:next-tab': 'Next document', 'view:prev-tab': 'Previous document',
  'tool:move': 'Move', 'tool:marquee': 'Marquee', 'tool:lasso': 'Lasso', 'tool:wand': 'Magic wand / quick selection', 'tool:crop': 'Crop', 'tool:eyedropper': 'Eyedropper', 'tool:heal': 'Healing',
  'tool:brush': 'Brush / pencil', 'tool:clone': 'Clone stamp', 'tool:history': 'History brush', 'tool:eraser': 'Eraser', 'tool:fill': 'Gradient / paint bucket', 'tool:retouch': 'Dodge / burn / sponge', 'tool:pen': 'Pen', 'tool:text': 'Text',
  'tool:path-select': 'Path selection', 'tool:shape': 'Shapes', 'tool:hand': 'Hand', 'tool:rotate-view': 'Rotate view', 'tool:zoom': 'Zoom', 'tool:swap-colors': 'Swap colours', 'tool:default-colors': 'Default colours',
  'tool:brush-size-down': 'Smaller brush', 'tool:brush-size-up': 'Larger brush', 'tool:brush-hardness-down': 'Softer brush', 'tool:brush-hardness-up': 'Harder brush',
  'app:escape': 'Cancel / deselect tool action', 'app:enter': 'Commit (transform, crop, text)', 'help:shortcuts': 'Keyboard shortcuts', 'help:devtools': 'Developer tools',
};

/** Parses an Electron accelerator ("CmdOrCtrl+Shift+Z") into a normalized key descriptor. */
export function parseAccelerator(accel) {
  const parts = String(accel).split('+');
  let key = parts.pop();
  if (key === '' && parts.length) key = '+'; // "CmdOrCtrl++"
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
  plus: '+', '=': '=', '-': '-', ',': ',', '/': '/', '[': '[', ']': ']', ';': ';', "'": "'", '\\': '\\',
  numadd: 'numpad+', numsub: 'numpad-', esc: 'escape', return: 'enter', space: ' ',
  up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright',
};

export function normalizeKeyName(key) {
  const lower = String(key).toLowerCase();
  return KEY_ALIASES[lower] ?? lower;
}

/** Tests a KeyboardEvent against a parsed accelerator. */
export function eventMatches(event, desc, isMac) {
  let key = String(event.key).toLowerCase();
  if (event.location === 3 /* numpad */ && (key === '+' || key === '-')) key = `numpad${key}`;
  if (key === 'esc') key = 'escape';
  if (key !== desc.key) {
    // Shift changes the key value for symbols ("[" -> "{"); compare by physical code for those
    if (!(desc.shift && event.code && codeToKey(event.code) === desc.key)) return false;
  }
  const primary = isMac ? event.metaKey : event.ctrlKey;
  const secondary = isMac ? event.ctrlKey : event.metaKey;
  if (desc.cmdOrCtrl) {
    if (!primary || secondary) return false;
  } else {
    if (desc.ctrl !== event.ctrlKey) return false;
    if (desc.meta !== event.metaKey) return false;
  }
  if (desc.alt !== event.altKey) return false;
  if (desc.shift !== event.shiftKey) return false;
  return true;
}

function codeToKey(code) {
  const map = { BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Backslash: '\\', Equal: '=', Minus: '-', Comma: ',', Period: '.', Slash: '/' };
  if (map[code]) return map[code];
  if (/^Key[A-Z]$/.test(code)) return code[3].toLowerCase();
  if (/^Digit\d$/.test(code)) return code[5];
  return null;
}

/** Human-readable accelerator for tooltips and menus ("Ctrl+Shift+Z" / "⇧⌘Z"). */
export function describeAccelerator(accel, isMac) {
  const parts = String(accel).split('+');
  const key = parts.pop() || '+';
  const keyLabel = { Plus: '+', numadd: 'Num +', numsub: 'Num −', Backspace: isMac ? '⌫' : 'Backspace', Delete: isMac ? '⌦' : 'Delete', Escape: 'Esc', Tab: 'Tab', Enter: isMac ? '↩' : 'Enter', Left: '←', Right: '→', Up: '↑', Down: '↓' }[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  if (isMac) {
    const sym = { cmdorctrl: '⌘', cmd: '⌘', command: '⌘', ctrl: '⌃', control: '⌃', alt: '⌥', option: '⌥', shift: '⇧' };
    return parts.map((p) => sym[p.toLowerCase()] ?? p).join('') + keyLabel;
  }
  const names = { cmdorctrl: 'Ctrl', cmd: 'Win', command: 'Win', ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', option: 'Alt', shift: 'Shift' };
  return [...parts.map((p) => names[p.toLowerCase()] ?? p), keyLabel].join('+');
}
