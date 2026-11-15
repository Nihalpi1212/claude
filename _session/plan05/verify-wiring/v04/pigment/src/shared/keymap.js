// Single source of truth for keyboard shortcuts (Photoshop's defaults wherever they exist).
// MENU_KEYS: command -> Electron accelerator shown in (and registered by) the native menu.
// RENDERER_KEYS: extra combos only the renderer handles. Never put plain keys (letters, Delete,
// Escape) in the native menu: on macOS the menu would intercept them while typing in a text field.
//
// TYPE_KEYS (0.4): accelerators active only while a Type tool session is editing (type-editing's edit-keys.js
// dispatches them from the editor's input; shortcuts.js never sees them). typeKeyFor() maps a menu or renderer
// command whose accelerator is also a type key to that type command (the type session's handle uses it).
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
  // 0.4 (M.4): Photoshop's export keys; Alt+Shift+Ctrl+E is Stamp Visible now
  'file:export': 'CmdOrCtrl+Alt+Shift+W',
  'file:export-quick': "CmdOrCtrl+Shift+'",
  'file:save-for-web': 'CmdOrCtrl+Alt+Shift+S',
  'file:close': 'CmdOrCtrl+W',
  'file:close-all': 'CmdOrCtrl+Alt+W',
  'file:properties': 'CmdOrCtrl+Alt+Shift+I',
  'file:close-others': 'CmdOrCtrl+Alt+P',
  'file:print': 'CmdOrCtrl+P',
  'edit:undo': 'CmdOrCtrl+Z',
  'edit:redo': 'CmdOrCtrl+Shift+Z',
  // Step Forward / Backward lose their keys to Toggle Last State, as in Photoshop's defaults
  'edit:toggle-last-state': 'CmdOrCtrl+Alt+Z',
  'edit:cut': 'CmdOrCtrl+X',
  'edit:copy': 'CmdOrCtrl+C',
  'edit:copy-merged': 'CmdOrCtrl+Shift+C',
  'edit:paste': 'CmdOrCtrl+V',
  'edit:paste-in-place': 'CmdOrCtrl+Shift+V',
  'edit:paste-into': 'CmdOrCtrl+Alt+Shift+V',
  'edit:fill': 'Shift+F5',
  'edit:free-transform': 'CmdOrCtrl+T',
  'edit:transform-again': 'CmdOrCtrl+Shift+T',
  'edit:content-aware-scale': 'CmdOrCtrl+Alt+Shift+C',
  'edit:search': 'CmdOrCtrl+F',
  'edit:preferences': 'CmdOrCtrl+K', // the macOS app menu's Settings… too (Cmd+, is Hide / Show Layers)
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
  'layer:merge': 'CmdOrCtrl+E', // Merge Down / Merge Layers / Merge Group by context; layer:merge-down keeps its 0.3 meaning
  'layer:lock-dialog': 'CmdOrCtrl+/',
  'layer:visibility': 'CmdOrCtrl+,',
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
  'select:select-mask': 'CmdOrCtrl+Alt+R',
  'select:find-layers': 'CmdOrCtrl+Alt+Shift+F',
  'filter:last': 'CmdOrCtrl+Alt+F', // Ctrl+F is Edit > Search…
  'filter:liquify': 'CmdOrCtrl+Shift+X',
  'filter:camera-raw': 'CmdOrCtrl+Shift+A',
  'filter:lens-correction': 'CmdOrCtrl+Shift+R',
  'window:panel-actions': 'Alt+F9',
  'view:gamut': 'CmdOrCtrl+Shift+Y',
  'view:proof': 'CmdOrCtrl+Y', // Ctrl+Y no longer redoes
  'view:zoom-in': 'CmdOrCtrl+=',
  'view:zoom-out': 'CmdOrCtrl+-',
  'view:zoom-fit': 'CmdOrCtrl+0',
  'view:zoom-100': 'CmdOrCtrl+1',
  'view:rulers': 'CmdOrCtrl+R',
  'view:grid': "CmdOrCtrl+'",
  'view:guides': 'CmdOrCtrl+;',
  'view:extras': 'CmdOrCtrl+H',
  'view:snap': 'CmdOrCtrl+Shift+;',
  'view:lock-guides': 'CmdOrCtrl+Alt+;',
  'view:next-tab': 'Ctrl+Tab',
  'view:prev-tab': 'Ctrl+Shift+Tab',
  'help:shortcuts': 'CmdOrCtrl+Alt+Shift+K',
  'edit:menus': 'CmdOrCtrl+Alt+Shift+M',
};

/** The 24 blend-mode keys (Shift+Alt+letter, Photoshop's letters): [mode id, letter, label]. */
export const BLEND_MODE_KEYS = [
  ['normal', 'N', 'Normal'], ['dissolve', 'I', 'Dissolve'], ['darken', 'K', 'Darken'], ['multiply', 'M', 'Multiply'],
  ['color-burn', 'B', 'Color Burn'], ['linear-burn', 'A', 'Linear Burn'], ['lighten', 'G', 'Lighten'], ['screen', 'S', 'Screen'],
  ['color-dodge', 'D', 'Color Dodge'], ['linear-dodge', 'W', 'Linear Dodge (Add)'], ['overlay', 'O', 'Overlay'], ['soft-light', 'F', 'Soft Light'],
  ['hard-light', 'H', 'Hard Light'], ['vivid-light', 'V', 'Vivid Light'], ['linear-light', 'J', 'Linear Light'], ['pin-light', 'Z', 'Pin Light'],
  ['hard-mix', 'L', 'Hard Mix'], ['difference', 'E', 'Difference'], ['exclusion', 'X', 'Exclusion'], ['hue', 'U', 'Hue'],
  ['saturation', 'T', 'Saturation'], ['color', 'C', 'Color'], ['luminosity', 'Y', 'Luminosity'], ['pass-through', 'P', 'Pass Through'],
];
const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

// Renderer-only combos. Plain letters select tools (Photoshop's keys); Shift+letter cycles a tool slot.
export const RENDERER_KEYS = {
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
  // 0.4 (M.4): finish-layer-menu's layer keys. The digit, '/', '\\' and blend-mode keys never act while a text
  // field has focus (shortcuts.js skips plain keys and non-view commands there)
  'layer:stamp-visible': ['CmdOrCtrl+Alt+Shift+E'],
  'layer:stamp-selected': ['CmdOrCtrl+Alt+E'],
  'layer:new-no-dialog': ['CmdOrCtrl+Alt+Shift+N'],
  'layer:select-forward': ['Alt+]'],
  'layer:select-backward': ['Alt+['],
  'layer:select-front': ['Alt+.'],
  'layer:select-back': ['Alt+,'],
  'layer:select-add-forward': ['Shift+Alt+]'],
  'layer:select-add-backward': ['Shift+Alt+['],
  'layer:lock-transparency-toggle': ['/'],
  // 1 … 9 set 10 % … 90 %, 0 sets 100 % (only while the active tool does not paint, lib/tool-traits.js)
  ...Object.fromEntries(DIGITS.map((d) => [`layer:opacity-digit-${d}`, [d]])),
  ...Object.fromEntries(DIGITS.map((d) => [`layer:fill-digit-${d}`, [`Shift+${d}`]])),
  ...Object.fromEntries(BLEND_MODE_KEYS.map(([id, letter]) => [`layer:blend-mode-${id}`, [`Shift+Alt+${letter}`]])),
  'layer:blend-next': ['Shift+='],
  'layer:blend-prev': ['Shift+-'],
  // adjust-tonal: reopen with the last-used values (the plain commands open with the defaults)
  'image:adjust-levels-last': ['CmdOrCtrl+Alt+L'],
  'image:adjust-curves-last': ['CmdOrCtrl+Alt+M'],
  'image:adjust-hue-saturation-last': ['CmdOrCtrl+Alt+U'],
  'image:adjust-color-balance-last': ['CmdOrCtrl+Alt+B'],
  'layer:mask-overlay': ['\\'],
  'app:escape': ['Escape'],
  'app:enter': ['Enter'],
};

// Accelerators active only while a Type tool session is editing (M.4); type-editing dispatches them from its input.
export const TYPE_KEYS = {
  'type:size-up': 'CmdOrCtrl+Shift+.',
  'type:size-down': 'CmdOrCtrl+Shift+,',
  'type:size-up-10': 'CmdOrCtrl+Alt+Shift+.',
  'type:size-down-10': 'CmdOrCtrl+Alt+Shift+,',
  'type:leading-down': 'Alt+Up',
  'type:leading-up': 'Alt+Down',
  'type:leading-down-10': 'CmdOrCtrl+Alt+Up',
  'type:leading-up-10': 'CmdOrCtrl+Alt+Down',
  'type:kern-down': 'Alt+Left',
  'type:kern-up': 'Alt+Right',
  'type:kern-down-100': 'CmdOrCtrl+Alt+Left',
  'type:kern-up-100': 'CmdOrCtrl+Alt+Right',
  'type:baseline-up': 'Shift+Alt+Up',
  'type:baseline-down': 'Shift+Alt+Down',
  'type:baseline-up-10': 'CmdOrCtrl+Alt+Shift+Up',
  'type:baseline-down-10': 'CmdOrCtrl+Alt+Shift+Down',
  'type:align-left': 'CmdOrCtrl+Shift+L',
  'type:align-center': 'CmdOrCtrl+Shift+C',
  'type:align-right': 'CmdOrCtrl+Shift+R',
  'type:align-justify-left': 'CmdOrCtrl+Shift+J',
  'type:align-justify-all': 'CmdOrCtrl+Shift+F',
  'type:toggle-faux-bold': 'CmdOrCtrl+Shift+B',
  'type:toggle-faux-italic': 'CmdOrCtrl+Shift+I',
  'type:toggle-underline': 'CmdOrCtrl+Shift+U',
  'type:toggle-strike': 'CmdOrCtrl+Shift+/',
  'type:toggle-all-caps': 'CmdOrCtrl+Shift+K',
  'type:toggle-small-caps': 'CmdOrCtrl+Shift+H',
  'type:toggle-superscript': 'CmdOrCtrl+Shift+=',
  'type:toggle-subscript': 'CmdOrCtrl+Alt+Shift+=',
  'type:reset-scale-x': 'CmdOrCtrl+Shift+X',
  'type:reset-scale-y': 'CmdOrCtrl+Alt+Shift+X',
  'type:auto-leading': 'CmdOrCtrl+Alt+Shift+A',
  'type:reset-tracking': 'CmdOrCtrl+Shift+Q',
  'type:toggle-hyphenation': 'CmdOrCtrl+Alt+Shift+H',
  'type:toggle-composer': 'CmdOrCtrl+Alt+Shift+T',
  'type:hide-selection': 'CmdOrCtrl+H',
};

/**
 * Whether a key may run cmd while the focus is in a text field (M.4: a key that edits the text edits the text). The
 * edit keys run because their commands hand the edit to the field (undo, the clipboard, select all, delete); file,
 * view, help and window commands touch no layer. Everything else (Ctrl+E, Ctrl+J, Ctrl+I, …) waits. lib/shortcuts.js
 * applies the same rule to the keys the page sees; app.js to the native menu's accelerators (Electron).
 */
export const TEXT_FIELD_EDIT_KEYS = new Set(['edit:undo', 'edit:redo', 'edit:cut', 'edit:copy', 'edit:paste', 'edit:select-all', 'select:all', 'edit:clear', 'view:zoom-in', 'view:zoom-out']);
export function runsWhileTyping(cmd) {
  return TEXT_FIELD_EDIT_KEYS.has(cmd) || /^(file:|view:|help:|window:)/.test(String(cmd));
}

/** Two accelerators name the same key combination (modifier order and spelling do not matter). */
export function sameAccelerator(a, b) {
  const x = parseAccelerator(a), y = parseAccelerator(b);
  return x.key === y.key && x.cmdOrCtrl === y.cmdOrCtrl && x.ctrl === y.ctrl && x.meta === y.meta && x.alt === y.alt && x.shift === y.shift;
}

/**
 * The type command whose TYPE_KEYS accelerator is also the accelerator of commandId in MENU_KEYS or RENDERER_KEYS
 * (Shift+Ctrl+L is Auto Tone outside a type session and Align Left inside one), else null. The type session's
 * handle uses it for keys (B.8); nothing else duplicates the mapping.
 */
export function typeKeyFor(commandId) {
  const own = [MENU_KEYS[commandId], ...(RENDERER_KEYS[commandId] ?? [])].filter(Boolean);
  if (!own.length) return null;
  for (const [typeCmd, accel] of Object.entries(TYPE_KEYS)) if (own.some((a) => sameAccelerator(a, accel))) return typeCmd;
  return null;
}

export const SHORTCUT_GROUPS = [
  { title: 'Files', commands: ['file:new', 'file:open', 'file:save', 'file:save-as', 'file:export', 'file:export-quick', 'file:save-for-web', 'file:print', 'file:close', 'file:close-others', 'file:properties'] },
  { title: 'Editing', commands: ['edit:undo', 'edit:redo', 'edit:toggle-last-state', 'edit:step-backward', 'edit:step-forward', 'edit:cut', 'edit:copy', 'edit:copy-merged', 'edit:paste', 'edit:paste-in-place', 'edit:clear', 'edit:search', 'edit:fill', 'edit:fill-foreground', 'edit:fill-background', 'edit:free-transform', 'edit:content-aware-scale', 'edit:preferences', 'edit:menus'] },
  { title: 'Image', commands: ['image:adjust-levels', 'image:adjust-curves', 'image:adjust-hue-saturation', 'image:adjust-color-balance', 'image:adjust-levels-last', 'image:adjust-curves-last', 'image:adjust-hue-saturation-last', 'image:adjust-color-balance-last', 'image:adjust-black-white', 'image:adjust-invert', 'image:adjust-desaturate', 'image:auto-tone', 'image:auto-contrast', 'image:auto-color', 'image:size', 'image:canvas-size'] },
  { title: 'Layers', commands: ['layer:new', 'layer:new-no-dialog', 'layer:via-copy', 'layer:via-cut', 'layer:group', 'layer:ungroup', 'layer:clip', 'layer:merge', 'layer:merge-visible', 'layer:stamp-visible', 'layer:stamp-selected', 'layer:arrange-front', 'layer:arrange-forward', 'layer:arrange-backward', 'layer:arrange-back', 'layer:select-all', 'layer:visibility', 'layer:lock-dialog'] },
  {
    title: 'Layer keys',
    commands: [
      'layer:select-forward', 'layer:select-backward', 'layer:select-front', 'layer:select-back', 'layer:select-add-forward', 'layer:select-add-backward',
      'layer:lock-transparency-toggle', 'layer:mask-overlay', 'layer:mask-toggle-view',
      ...DIGITS.map((d) => `layer:opacity-digit-${d}`), ...DIGITS.map((d) => `layer:fill-digit-${d}`),
      'layer:blend-next', 'layer:blend-prev', ...BLEND_MODE_KEYS.map(([id]) => `layer:blend-mode-${id}`),
    ],
  },
  { title: 'Selection', commands: ['select:all', 'select:none', 'select:reselect', 'select:inverse', 'select:feather', 'select:select-mask', 'select:find-layers'] },
  { title: 'Filters', commands: ['filter:last', 'filter:liquify', 'filter:camera-raw', 'filter:lens-correction'] },
  { title: 'View', commands: ['view:zoom-in', 'view:zoom-out', 'view:zoom-fit', 'view:zoom-100', 'view:zoom-200', 'view:rulers', 'view:grid', 'view:guides', 'view:lock-guides', 'view:extras', 'view:snap', 'view:proof', 'view:gamut', 'view:fullscreen', 'window:toggle-panels', 'window:panel-actions', 'view:next-tab', 'view:prev-tab'] },
  { title: 'Tools', commands: ['tool:move', 'tool:marquee', 'tool:lasso', 'tool:wand', 'tool:crop', 'tool:eyedropper', 'tool:heal', 'tool:brush', 'tool:clone', 'tool:history', 'tool:eraser', 'tool:fill', 'tool:retouch', 'tool:pen', 'tool:text', 'tool:path-select', 'tool:shape', 'tool:hand', 'tool:rotate-view', 'tool:zoom', 'tool:swap-colors', 'tool:default-colors', 'tool:brush-size-down', 'tool:brush-size-up', 'tool:brush-hardness-down', 'tool:brush-hardness-up', 'app:escape', 'app:enter'] },
  // keys of TYPE_KEYS: only while editing text with a Type tool
  { title: 'Type', type: true, commands: Object.keys(TYPE_KEYS) },
  { title: 'Help', commands: ['help:shortcuts', 'help:devtools'] },
];

export const COMMAND_LABELS = {
  'file:new': 'New document', 'file:open': 'Open', 'file:save': 'Save', 'file:save-as': 'Save as', 'file:export': 'Export as', 'file:export-quick': 'Quick export as PNG',
  'file:close': 'Close', 'file:close-all': 'Close all', 'file:close-others': 'Close others', 'file:properties': 'File info', 'file:print': 'Print',
  'filter:liquify': 'Liquify', 'filter:camera-raw': 'Camera Raw filter', 'filter:lens-correction': 'Lens Correction', 'view:gamut': 'Gamut warning',
  'edit:content-aware-scale': 'Content-Aware Scale', 'select:select-mask': 'Select and Mask', 'select:find-layers': 'Find layers', 'window:panel-actions': 'Actions panel',
  'layer:smart-convert': 'Convert to smart object', 'layer:smart-edit': 'Edit smart object contents', 'layer:smart-rasterize': 'Rasterize smart object',
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
  // 0.4 (M.7)
  'file:save-for-web': 'Save for Web (legacy)', 'edit:toggle-last-state': 'Toggle last state', 'edit:search': 'Search', 'edit:menus': 'Menus',
  'edit:paste-without-formatting': 'Paste without formatting', 'view:proof': 'Proof colors', 'view:lock-guides': 'Lock guides',
  'view:smart-guides': 'Smart guides', 'view:snap-to': 'Snap to', 'view:clear-artboard-guides': 'Clear selected artboard guides',
  'view:clear-selected-guides': 'Clear selected guides', 'view:new-guide-layout': 'New guide layout', 'view:guides-from-shape': 'New guides from shape',
  'view:edit-selected-guides': 'Edit selected guides', 'view:new-guide': 'New guide', 'view:clear-guides': 'Clear guides',
  'view:ruler-unit': 'Ruler units', 'view:ruler-origin-reset': 'Reset ruler origin', 'view:pattern-preview': 'Pattern preview',
  'window:panel-paragraph': 'Paragraph panel', 'window:panel-gradients': 'Gradients panel', 'window:panel-patterns': 'Patterns panel',
  'type:toggle-panels': 'Character and Paragraph panels', 'type:reset-character': 'Reset character', 'type:reset-paragraph': 'Reset paragraph',
  'type:hyphenation-settings': 'Hyphenation settings', 'type:justification-settings': 'Justification settings',
  'type:size-up': 'Larger text', 'type:size-down': 'Smaller text', 'type:size-up-10': 'Larger text (×5)', 'type:size-down-10': 'Smaller text (×5)',
  'type:leading-down': 'Less leading', 'type:leading-up': 'More leading', 'type:leading-down-10': 'Less leading (×5)', 'type:leading-up-10': 'More leading (×5)',
  'type:kern-down': 'Tighter kerning / tracking', 'type:kern-up': 'Looser kerning / tracking', 'type:kern-down-100': 'Tighter kerning / tracking (×5)',
  'type:kern-up-100': 'Looser kerning / tracking (×5)', 'type:baseline-up': 'Raise baseline', 'type:baseline-down': 'Lower baseline',
  'type:baseline-up-10': 'Raise baseline (×5)', 'type:baseline-down-10': 'Lower baseline (×5)', 'type:align-left': 'Align left', 'type:align-center': 'Center text',
  'type:align-right': 'Align right', 'type:align-justify-left': 'Justify, last line left', 'type:align-justify-all': 'Justify all',
  'type:toggle-faux-bold': 'Faux bold', 'type:toggle-faux-italic': 'Faux italic', 'type:toggle-underline': 'Underline', 'type:toggle-strike': 'Strikethrough',
  'type:toggle-all-caps': 'All caps', 'type:toggle-small-caps': 'Small caps', 'type:toggle-superscript': 'Superscript', 'type:toggle-subscript': 'Subscript',
  'type:reset-scale-x': 'Reset horizontal scale', 'type:reset-scale-y': 'Reset vertical scale', 'type:auto-leading': 'Auto leading',
  'type:reset-tracking': 'Reset tracking', 'type:toggle-hyphenation': 'Hyphenation on / off', 'type:toggle-composer': 'Single-line / every-line composer',
  'type:hide-selection': 'Hide text selection',
  'image:adjust-color-vibrance': 'Color and vibrance', 'image:adjust-clarity-dehaze': 'Clarity and dehaze', 'image:adjust-grain': 'Grain',
  'image:adjust-levels-last': 'Levels (last settings)', 'image:adjust-curves-last': 'Curves (last settings)',
  'image:adjust-hue-saturation-last': 'Hue/Saturation (last settings)', 'image:adjust-color-balance-last': 'Color balance (last settings)',
  'layer:style-create-layers': 'Create layers from style', 'layer:style-toggle-all': 'Hide / show all effects', 'layer:style-scale': 'Scale effects',
  'layer:vector-mask': 'Vector mask', 'layer:mask-overlay': 'Mask overlay (rubylith)', 'layer:mask-overlay-options': 'Mask overlay options',
  'layer:mask-toggle-view': 'Show layer mask', 'path:make-mask': 'Make vector mask from path', 'path:make-shape': 'Make shape from path',
  'layer:copy-shape-attributes': 'Copy shape attributes', 'layer:paste-shape-attributes': 'Paste shape attributes',
  'layer:collapse-all-groups': 'Collapse all groups', 'layer:panel-options': 'Layers panel options',
  'layer:merge': 'Merge layers', 'layer:merge-group': 'Merge group', 'layer:merge-clipping': 'Merge clipping mask', 'layer:arrange-reverse': 'Reverse layer order',
  'layer:lock-dialog': 'Lock layers', 'layer:lock-group': 'Lock all layers in group', 'layer:select-similar': 'Select similar layers',
  'layer:new-no-dialog': 'New layer (no dialog)', 'layer:stamp-visible': 'Stamp visible', 'layer:stamp-selected': 'Stamp selected layers',
  'layer:select-forward': 'Select layer above', 'layer:select-backward': 'Select layer below', 'layer:select-front': 'Select top layer',
  'layer:select-back': 'Select bottom layer', 'layer:select-add-forward': 'Add layer above to selection', 'layer:select-add-backward': 'Add layer below to selection',
  'layer:lock-transparency-toggle': 'Lock transparent pixels', 'layer:visibility': 'Hide / show layers',
  'layer:blend-next': 'Next blend mode', 'layer:blend-prev': 'Previous blend mode',
  // command ids the 0.4 packages added beyond M.7 (recorded steps and the Keyboard Shortcuts list read these)
  'view:move-guide': 'Move guide', 'view:ruler-origin': 'Ruler origin', 'layer:mask-properties': 'Mask properties',
  'layer:shape-properties': 'Shape properties', 'layer:effect': 'Layer effect', 'layer:adjustment-preset': 'Adjustment preset',
  ...Object.fromEntries(DIGITS.map((d) => [`layer:opacity-digit-${d}`, `Opacity ${d === '0' ? 100 : Number(d) * 10}%`])),
  ...Object.fromEntries(DIGITS.map((d) => [`layer:fill-digit-${d}`, `Fill ${d === '0' ? 100 : Number(d) * 10}%`])),
  ...Object.fromEntries(BLEND_MODE_KEYS.map(([id, , label]) => [`layer:blend-mode-${id}`, `Blend mode: ${label}`])),
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
    // Shift changes the key value for symbols ("[" -> "{", "1" -> "!"), and on macOS Option changes it for every key
    // (Option+[ gives "“", Option+Shift+N "˜"): with either modifier compare by physical key instead. Only when the
    // key produced is not an ASCII letter or digit: a letter is what the user pressed on any layout (AZERTY's Z sends
    // code KeyW, QWERTZ's Y code KeyZ), so it never matches the binding of another letter by position.
    if (/^[a-z0-9]$/.test(key)) return false;
    if (!((desc.shift || desc.alt) && event.code && codeToKey(event.code) === desc.key)) return false;
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

/** The unshifted US-layout key of a physical key code (null for keys it does not map). */
export function codeToKey(code) {
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
