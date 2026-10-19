// Native application menu (File, Edit, Image, Layer, Select, Filter, View, Window, Help). Every
// item runs a renderer command (see ARCHITECTURE.md "Commands"); the renderer decides what the
// command means in its current state and ignores it when it does not apply.
import { MENU_KEYS } from '../shared/keymap.js';
import { ADJUSTMENTS } from '../shared/pixels/adjust.js';
import { FILTERS, FILTER_CATEGORIES } from '../shared/pixels/filters.js';
import { STYLE_KEYS } from '../shared/pixels/styles.js';

/** Kinds offered as adjustment layers, in Photoshop's order. */
const LAYER_ADJUSTMENTS = ['brightness-contrast', 'levels', 'curves', 'exposure', null, 'vibrance', 'hue-saturation', 'color-balance', 'black-white', 'photo-filter', 'channel-mixer', null, 'invert', 'posterize', 'threshold', 'gradient-map', 'selective-color'];
const IMAGE_ADJUSTMENTS = [...LAYER_ADJUSTMENTS, null, 'shadows-highlights', null, 'desaturate', 'equalize'];
const NO_DIALOG = new Set(['invert', 'desaturate', 'equalize']);
/** Filters that apply without a dialog. */
const DIRECT_FILTERS = new Set(['despeckle', 'fragment', 'find-edges', 'solarize', 'invert-alpha']);

export const PANELS = [
  ['color', 'Color'], ['swatches', 'Swatches'], ['brushes', 'Brushes'], null,
  ['properties', 'Properties'], ['adjustments', 'Adjustments'], ['character', 'Character'], ['paths', 'Paths'], null,
  ['layers', 'Layers'], ['channels', 'Channels'], ['history', 'History'], ['navigator', 'Navigator'], ['info', 'Info'],
];

/**
 * @param {object} opts
 * @param {string} opts.platform            process.platform
 * @param {object} opts.state               ui state last reported by the renderer (setUiState)
 * @param {{path:string,name:string}[]} opts.recent
 * @param {(cmd: string, arg?: unknown) => void} opts.run   dispatches a command to the window
 * @param {boolean} [opts.isPackaged]
 */
export function buildMenuTemplate({ platform, state = {}, recent = [], run, isPackaged = true }) {
  const mac = platform === 'darwin';
  const has = !!state.hasDocument;
  const sel = has && !!state.hasSelection;
  const layer = has && !!state.hasLayer;
  const sep = { type: 'separator' };
  const item = (label, cmd, extra = {}) => ({
    label,
    accelerator: 'accelerator' in extra ? extra.accelerator : MENU_KEYS[cmd],
    click: () => run(cmd, extra.arg),
    enabled: extra.enabled ?? true,
    ...(extra.type ? { type: extra.type, checked: !!extra.checked } : {}),
  });
  const doc = (label, cmd, extra = {}) => item(label, cmd, { enabled: has, ...extra });
  const lyr = (label, cmd, extra = {}) => item(label, cmd, { enabled: layer, ...extra });
  const sub = (label, submenu, enabled = true) => ({ label, submenu, enabled });

  const recentItems = recent.length
    ? [
        ...recent.slice(0, 15).map((r) => ({ label: r.name || r.path, sublabel: mac ? undefined : r.path, toolTip: r.path, click: () => run('file:open-recent', r.path) })),
        sep,
        { label: 'Clear Recent Files', click: () => run('file:clear-recent') },
      ]
    : [{ label: 'No Recent Files', enabled: false }];

  const fileMenu = sub('&File', [
    item('&New…', 'file:new'),
    item('&Open…', 'file:open'),
    sub('Open &Recent', recentItems),
    sep,
    doc('&Close', 'file:close'),
    doc('Close All', 'file:close-all'),
    sep,
    doc('&Save', 'file:save'),
    doc('Save &As…', 'file:save-as'),
    doc('Save a Cop&y…', 'file:save-copy'),
    doc('Re&vert', 'file:revert', { enabled: has && !!state.path && !!state.dirty }),
    sep,
    sub('&Export', [doc('Quick Export as PNG', 'file:export-quick'), doc('Export As…', 'file:export'), sep, doc('Layers to Files…', 'file:export-layers')], has),
    sep,
    doc('&Place Image as Layer…', 'file:place'),
    sep,
    doc('Document &Properties…', 'file:properties'),
    doc(mac ? 'Reveal in Finder' : platform === 'win32' ? 'Show in Explorer' : 'Show in File Manager', 'file:reveal', { enabled: has && !!state.path }),
    ...(mac ? [] : [sep, { role: 'quit', label: platform === 'win32' ? 'E&xit' : '&Quit' }]),
  ]);

  const editMenu = sub('&Edit', [
    item(state.undoLabel ? `&Undo ${state.undoLabel}` : '&Undo', 'edit:undo'),
    item(state.redoLabel ? `&Redo ${state.redoLabel}` : '&Redo', 'edit:redo'),
    doc('Step Forward', 'edit:step-forward', { enabled: has && !!state.canRedo }),
    doc('Step Backward', 'edit:step-backward', { enabled: has && !!state.canUndo }),
    sep,
    doc('Fade…', 'edit:fade'),
    sep,
    item('Cu&t', 'edit:cut'),
    item('&Copy', 'edit:copy'),
    doc('Copy &Merged', 'edit:copy-merged'),
    item('&Paste', 'edit:paste'),
    sub('Paste Special', [item('Paste in Place', 'edit:paste-in-place'), doc('Paste Into Selection', 'edit:paste-into', { enabled: sel })]),
    item('Clea&r', 'edit:clear'),
    sep,
    lyr('&Fill…', 'edit:fill'),
    lyr('&Stroke…', 'edit:stroke', { enabled: sel }),
    sep,
    lyr('Free &Transform', 'edit:free-transform'),
    sub('Transfor&m', [
      lyr('Again', 'edit:transform-again'),
      sep,
      lyr('Scale', 'edit:transform-scale'),
      lyr('Rotate', 'edit:transform-rotate'),
      lyr('Skew', 'edit:transform-skew'),
      lyr('Distort', 'edit:transform-distort'),
      lyr('Perspective', 'edit:transform-perspective'),
      sep,
      lyr('Rotate 180°', 'edit:transform-rotate-180'),
      lyr('Rotate 90° Clockwise', 'edit:transform-rotate-90'),
      lyr('Rotate 90° Counter Clockwise', 'edit:transform-rotate--90'),
      sep,
      lyr('Flip Horizontal', 'edit:transform-flip-h'),
      lyr('Flip Vertical', 'edit:transform-flip-v'),
    ], layer),
    sep,
    doc('Define &Pattern', 'edit:define-pattern'),
    sep,
    item('&Keyboard Shortcuts…', 'help:shortcuts', { accelerator: undefined }),
    ...(mac ? [] : [item('Pre&ferences…', 'edit:preferences')]),
  ]);

  const adjustmentItems = (cmdFor) => IMAGE_ADJUSTMENTS.map((k) => (k ? cmdFor(k) : sep));
  const imageMenu = sub('&Image', [
    sub('&Adjustments', adjustmentItems((k) => lyr(`${ADJUSTMENTS[k].name}${NO_DIALOG.has(k) ? '' : '…'}`, `image:adjust-${k}`)), layer),
    sep,
    lyr('Auto &Tone', 'image:auto-tone'),
    lyr('Auto &Contrast', 'image:auto-contrast'),
    lyr('Auto C&olor', 'image:auto-color'),
    sep,
    doc('&Image Size…', 'image:size'),
    doc('Ca&nvas Size…', 'image:canvas-size'),
    sub('Image Rotatio&n', [
      doc('180°', 'image:rotate-180'),
      doc('90° Clockwise', 'image:rotate-90'),
      doc('90° Counter Clockwise', 'image:rotate--90'),
      doc('Arbitrary…', 'image:rotate-arbitrary'),
      sep,
      doc('Flip Canvas Horizontal', 'image:flip-h'),
      doc('Flip Canvas Vertical', 'image:flip-v'),
    ], has),
    doc('&Crop', 'image:crop', { enabled: sel }),
    doc('T&rim…', 'image:trim'),
    doc('Reveal &All', 'image:reveal-all'),
    sep,
    doc('&Duplicate…', 'image:duplicate'),
  ]);

  const layerMenu = sub('&Layer', [
    sub('&New', [doc('Layer…', 'layer:new'), doc('Group', 'layer:new-group'), sep, lyr('Layer via Copy', 'layer:via-copy'), lyr('Layer via Cut', 'layer:via-cut')], has),
    lyr('&Duplicate Layer', 'layer:duplicate'),
    lyr('De&lete Layer', 'layer:delete'),
    lyr('Rena&me Layer…', 'layer:rename'),
    sep,
    sub('Layer St&yle', [
      lyr('Blending Options…', 'layer:style', { arg: 'dialog' }),
      sep,
      ...STYLE_KEYS.map(({ key, name }) => lyr(`${name}…`, `layer:style-${key}`)),
      sep,
      lyr('Copy Layer Style', 'layer:copy-style'),
      lyr('Paste Layer Style', 'layer:paste-style'),
      lyr('Clear Layer Style', 'layer:clear-style'),
      sep,
      doc('Global Light…', 'layer:global-light'),
    ], layer),
    sep,
    sub('New Fi&ll Layer', [doc('Solid Color…', 'layer:new-fill', { arg: 'solid' }), doc('Gradient…', 'layer:new-fill', { arg: 'gradient' }), doc('Pattern…', 'layer:new-fill', { arg: 'pattern' })], has),
    sub('New &Adjustment Layer', LAYER_ADJUSTMENTS.map((k) => (k ? doc(`${ADJUSTMENTS[k].name}…`, 'layer:new-adjustment', { arg: k }) : sep)), has),
    lyr('Layer Content &Options…', 'layer:properties'),
    sep,
    sub('Layer &Mask', [
      lyr('Reveal All', 'layer:mask', { arg: 'reveal-all' }),
      lyr('Hide All', 'layer:mask', { arg: 'hide-all' }),
      lyr('Reveal Selection', 'layer:mask', { arg: 'reveal-selection', enabled: layer && sel }),
      lyr('Hide Selection', 'layer:mask', { arg: 'hide-selection', enabled: layer && sel }),
      lyr('From Transparency', 'layer:mask', { arg: 'from-transparency' }),
      sep,
      lyr('Delete', 'layer:mask', { arg: 'delete' }),
      lyr('Apply', 'layer:mask', { arg: 'apply' }),
      sep,
      lyr('Disable / Enable', 'layer:mask', { arg: 'toggle' }),
      lyr('Link / Unlink', 'layer:mask', { arg: 'link' }),
      lyr('Edit Mask', 'layer:mask', { arg: 'select', type: 'checkbox', checked: !!state.editingMask }),
    ], layer),
    lyr('Create Clipping Mask', 'layer:clip'),
    sep,
    lyr('&Group Layers', 'layer:group'),
    lyr('&Ungroup Layers', 'layer:ungroup'),
    lyr('&Hide / Show Layers', 'layer:visibility'),
    sep,
    sub('A&rrange', [lyr('Bring to Front', 'layer:arrange-front'), lyr('Bring Forward', 'layer:arrange-forward'), lyr('Send Backward', 'layer:arrange-backward'), lyr('Send to Back', 'layer:arrange-back')], layer),
    sub('Ali&gn', [
      lyr('Left Edges', 'layer:align', { arg: 'left' }), lyr('Horizontal Centers', 'layer:align', { arg: 'hcenter' }), lyr('Right Edges', 'layer:align', { arg: 'right' }), sep,
      lyr('Top Edges', 'layer:align', { arg: 'top' }), lyr('Vertical Centers', 'layer:align', { arg: 'vcenter' }), lyr('Bottom Edges', 'layer:align', { arg: 'bottom' }),
    ], layer),
    sub('Distri&bute', [lyr('Horizontally', 'layer:distribute', { arg: 'horizontal' }), lyr('Vertically', 'layer:distribute', { arg: 'vertical' })], layer),
    sub('Loc&k Layer', [lyr('All', 'layer:lock', { arg: 'all' }), lyr('Image Pixels', 'layer:lock', { arg: 'pixels' }), lyr('Position', 'layer:lock', { arg: 'position' }), lyr('Transparent Pixels', 'layer:lock', { arg: 'transparency' })], layer),
    sep,
    sub('Rasteri&ze', [lyr('Layer', 'layer:rasterize'), lyr('Layer Style', 'layer:rasterize-style')], layer),
    lyr('Edit &Text', 'layer:edit-text', { enabled: layer && state.layerType === 'text' }),
    sep,
    lyr('Merge Do&wn', 'layer:merge-down'),
    doc('Merge &Visible', 'layer:merge-visible'),
    doc('&Flatten Image', 'image:flatten'),
  ]);

  const selectMenu = sub('&Select', [
    item('&All', 'select:all'),
    doc('&Deselect', 'select:none', { enabled: sel }),
    doc('&Reselect', 'select:reselect'),
    doc('&Inverse', 'select:inverse', { enabled: sel }),
    sep,
    doc('All &Layers', 'layer:select-all'),
    sep,
    doc('&Color Range…', 'select:color-range'),
    sep,
    sub('&Modify', [
      doc('Border…', 'select:border', { enabled: sel }),
      doc('Smooth…', 'select:smooth', { enabled: sel }),
      doc('Expand…', 'select:expand', { enabled: sel }),
      doc('Contract…', 'select:contract', { enabled: sel }),
      doc('Feather…', 'select:feather', { enabled: sel }),
    ], sel),
    doc('&Grow', 'select:grow', { enabled: sel }),
    doc('Si&milar', 'select:similar', { enabled: sel }),
    sep,
    doc('&Transform Selection', 'select:transform', { enabled: sel }),
    doc('Edit in &Quick Mask Mode', 'select:quick-mask'),
    sep,
    doc('L&oad Selection…', 'select:load'),
    doc('&Save Selection…', 'select:save', { enabled: sel }),
    lyr('Layer &Transparency as Selection', 'select:from-layer'),
  ]);

  const filterMenu = sub('Fil&ter', [
    lyr(state.lastFilter ? `Last Filter: ${state.lastFilter}` : 'Last Filter', 'filter:last', { enabled: layer && !!state.lastFilter }),
    sep,
    ...FILTER_CATEGORIES.map((cat) => sub(cat.name, cat.kinds.map((k) => lyr(`${FILTERS[k].name}${DIRECT_FILTERS.has(k) ? '' : '…'}`, `filter:${k}`)), layer)),
  ]);

  const viewMenu = sub('&View', [
    doc('Zoom &In', 'view:zoom-in'),
    doc('Zoom &Out', 'view:zoom-out'),
    doc('&Fit on Screen', 'view:zoom-fit'),
    doc('Fill Screen', 'view:zoom-fill'),
    doc('&100%', 'view:zoom-100'),
    doc('200%', 'view:zoom-200'),
    doc('Reset View Rotation', 'view:rotate', { arg: 'reset' }),
    sep,
    sub('&Show', [
      item('Selection Edges', 'view:extras', { type: 'checkbox', checked: state.extras !== false }),
      item('Grid', 'view:grid', { type: 'checkbox', checked: !!state.showGrid }),
      item('Guides', 'view:guides', { type: 'checkbox', checked: state.showGuides !== false }),
      item('Pixel Grid', 'view:pixel-grid', { type: 'checkbox', checked: state.pixelGrid !== false }),
    ]),
    item('&Rulers', 'view:rulers', { type: 'checkbox', checked: state.showRulers !== false }),
    item('Sna&p', 'view:snap', { type: 'checkbox', checked: state.snap !== false }),
    sep,
    doc('New &Guide…', 'view:new-guide'),
    doc('&Clear Guides', 'view:clear-guides'),
    sep,
    sub('&Theme', ['system', 'light', 'dark'].map((t) => item(t[0].toUpperCase() + t.slice(1), 'view:theme', { arg: t, type: 'radio', checked: (state.theme ?? 'system') === t }))),
    sep,
    doc('Next Document', 'view:next-tab'),
    doc('Previous Document', 'view:prev-tab'),
    item('Toggle Full Screen', 'view:fullscreen', { accelerator: mac ? 'Ctrl+Cmd+F' : 'F11' }),
  ]);

  const windowMenu = sub('&Window', [
    ...PANELS.map((p) => (p ? item(p[1], `window:panel-${p[0]}`) : sep)),
    sep,
    item('Show / Hide Panels', 'window:toggle-panels'),
    item('Reset Workspace', 'window:reset-workspace'),
    ...(mac ? [sep, { role: 'minimize' }, { role: 'zoom' }, sep, { role: 'front' }] : []),
  ]);

  const helpMenu = {
    label: '&Help',
    role: 'help',
    submenu: [
      item('Pigment &Help', 'help:guide'),
      item('&Keyboard Shortcuts', 'help:shortcuts'),
      item('Pigment &Website', 'help:website'),
      ...(isPackaged ? [] : [sep, item('Toggle Developer Tools', 'help:devtools', { accelerator: mac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I' })]),
      ...(mac ? [] : [sep, item('&About Pigment', 'help:about')]),
    ],
  };

  const template = [fileMenu, editMenu, imageMenu, layerMenu, selectMenu, filterMenu, viewMenu, windowMenu, helpMenu];
  if (mac) {
    template.unshift({
      label: 'Pigment',
      submenu: [
        item('About Pigment', 'help:about'),
        sep,
        item('Settings…', 'edit:preferences', { accelerator: 'Cmd+,' }),
        sep,
        { role: 'services' },
        sep,
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        sep,
        { role: 'quit' },
      ],
    });
  }
  return template;
}
