// Native application menu (File, Edit, Image, Layer, Select, Filter, AI, View, Window, Help). Every
// item runs a renderer command (see ARCHITECTURE.md "Commands"); the renderer decides what the
// command means in its current state and ignores it when it does not apply. Items whose command is
// still a stub (state.stubs, see lib/stub.js) or whose registry kind is a placeholder are disabled.
import { MENU_KEYS } from '../shared/keymap.js';
import { ADJUSTMENTS } from '../shared/pixels/adjust.js';
import { FILTERS, FILTER_CATEGORIES, GALLERY_GROUPS } from '../shared/pixels/filters.js';
import { STYLE_KEYS } from '../shared/pixels/styles.js';

/** Kinds offered as adjustment layers, in Photoshop's order. */
const LAYER_ADJUSTMENTS = ['brightness-contrast', 'levels', 'curves', 'exposure', null, 'vibrance', 'hue-saturation', 'color-balance', 'black-white', 'photo-filter', 'channel-mixer', 'color-lookup', null, 'invert', 'posterize', 'threshold', 'gradient-map', 'selective-color'];
/** Image > Adjustments, in Photoshop's order. */
const IMAGE_ADJUSTMENTS = [...LAYER_ADJUSTMENTS, null, 'shadows-highlights', 'hdr-toning', null, 'desaturate', 'match-color', 'replace-color', 'equalize'];
const NO_DIALOG = new Set(['invert', 'desaturate', 'equalize']);
/** Filters that apply without a dialog (kinds may also say so with `direct: true`). */
const DIRECT_FILTERS = new Set(['despeckle', 'fragment', 'find-edges', 'solarize', 'invert-alpha']);
/** Image > Mode, in Photoshop's order: [id, label, bit depths it allows]. */
export const IMAGE_MODES = [
  ['bitmap', 'Bitmap…', [1]], ['grayscale', 'Grayscale', [8, 16, 32]], ['duotone', 'Duotone…', [8]], ['indexed', 'Indexed Color…', [8]],
  ['rgb', 'RGB Color', [8, 16, 32]], ['cmyk', 'CMYK Color', [8, 16]], ['lab', 'Lab Color', [8, 16]], ['multichannel', 'Multichannel', [8, 16]],
];
/** Layer > Smart Objects > Stack Mode, in Photoshop's order. */
export const STACK_MODES = [['none', 'None'], ['entropy', 'Entropy'], ['kurtosis', 'Kurtosis'], ['maximum', 'Maximum'], ['mean', 'Mean'], ['median', 'Median'], ['minimum', 'Minimum'], ['range', 'Range'], ['skewness', 'Skewness'], ['standard-deviation', 'Standard Deviation'], ['summation', 'Summation'], ['variance', 'Variance']];

export const PANELS = [
  ['color', 'Color'], ['swatches', 'Swatches'], ['brushes', 'Brushes'], null,
  ['properties', 'Properties'], ['adjustments', 'Adjustments'], ['character', 'Character'], ['paths', 'Paths'], null,
  ['layers', 'Layers'], ['channels', 'Channels'], ['history', 'History'], ['actions', 'Actions'], ['navigator', 'Navigator'], ['info', 'Info'], null,
  ['assistant', 'AI Assistant'],
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
  const smart = layer && state.layerType === 'smart';
  const stubs = new Set(typeof state.stubs === 'string' ? state.stubs.split(',').filter(Boolean) : []);
  const sep = { type: 'separator' };
  const item = (label, cmd, extra = {}) => ({
    label,
    accelerator: 'accelerator' in extra ? extra.accelerator : MENU_KEYS[cmd],
    click: () => run(cmd, extra.arg),
    enabled: (extra.enabled ?? true) && !stubs.has(cmd),
    ...(extra.type ? { type: extra.type, checked: !!extra.checked } : {}),
  });
  const doc = (label, cmd, extra = {}) => item(label, cmd, { enabled: has, ...extra });
  const lyr = (label, cmd, extra = {}) => item(label, cmd, { enabled: layer, ...extra });
  const sub = (label, submenu, enabled = true) => ({ label, submenu, enabled });
  const filterItem = (k) => lyr(`${FILTERS[k].name}${DIRECT_FILTERS.has(k) || FILTERS[k].direct ? '' : '…'}`, `filter:${k}`, { enabled: layer && !FILTERS[k].placeholder });
  const adjustItem = (k) => lyr(`${ADJUSTMENTS[k].name}${NO_DIALOG.has(k) ? '' : '…'}`, `image:adjust-${k}`, { enabled: layer && !ADJUSTMENTS[k].placeholder });

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
    item('Open as Smart Object…', 'file:open-smart'),
    sub('Open &Recent', recentItems),
    sep,
    doc('&Close', 'file:close'),
    doc('Close All', 'file:close-all'),
    doc('Close Others', 'file:close-others'),
    sep,
    doc('&Save', 'file:save'),
    doc('Save &As…', 'file:save-as'),
    doc('Save a Cop&y…', 'file:save-copy'),
    doc('Re&vert', 'file:revert', { enabled: has && !!state.path && !!state.dirty }),
    sep,
    sub('&Export', [
      doc('Quick Export as PNG', 'file:export-quick'),
      doc('Export As…', 'file:export'),
      doc('Save for Web (Legacy)…', 'file:save-for-web'),
      sep,
      doc('Layers to Files…', 'file:export-layers'),
      doc('Color Lookup Tables…', 'file:export-luts'),
    ], has),
    sep,
    doc('&Place Image as Layer…', 'file:place'),
    sep,
    sub('Automate', [
      item('Batch…', 'file:automate-batch'),
      item('Crop and Straighten Photos', 'file:automate-crop-straighten', { enabled: layer }),
      item('Contact Sheet…', 'file:automate-contact-sheet'),
      item('Conditional Mode Change…', 'file:automate-conditional-mode', { enabled: has }),
      item('Fit Image…', 'file:automate-fit-image', { enabled: has }),
      item('Merge to HDR…', 'file:automate-merge-hdr'),
      item('Photomerge…', 'file:automate-photomerge'),
    ]),
    sub('Scripts', [
      item('Image Processor…', 'file:script-image-processor'),
      sep,
      doc('Delete All Empty Layers', 'file:script-delete-empty-layers'),
      doc('Flatten All Layer Effects', 'file:script-flatten-effects'),
      doc('Flatten All Masks', 'file:script-flatten-masks'),
      sep,
      item('Load Files into Stack…', 'file:script-load-stack'),
      item('Statistics…', 'file:script-statistics'),
    ]),
    sep,
    doc('&Print…', 'file:print'),
    sep,
    doc('File &Info…', 'file:properties'),
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
    lyr('Content-A&ware Fill', 'edit:content-aware-fill', { enabled: layer && sel }),
    lyr('&Stroke…', 'edit:stroke', { enabled: sel }),
    sep,
    lyr('Content-Aware Scale', 'edit:content-aware-scale'),
    lyr('Puppet Warp', 'edit:puppet-warp'),
    lyr('Perspective Warp', 'edit:perspective-warp'),
    lyr('Free &Transform', 'edit:free-transform'),
    sub('Transfor&m', [
      lyr('Again', 'edit:transform-again'),
      sep,
      lyr('Scale', 'edit:transform-scale'),
      lyr('Rotate', 'edit:transform-rotate'),
      lyr('Skew', 'edit:transform-skew'),
      lyr('Distort', 'edit:transform-distort'),
      lyr('Perspective', 'edit:transform-perspective'),
      lyr('Warp', 'edit:transform-warp'),
      sep,
      lyr('Rotate 180°', 'edit:transform-rotate-180'),
      lyr('Rotate 90° Clockwise', 'edit:transform-rotate-90'),
      lyr('Rotate 90° Counter Clockwise', 'edit:transform-rotate--90'),
      sep,
      lyr('Flip Horizontal', 'edit:transform-flip-h'),
      lyr('Flip Vertical', 'edit:transform-flip-v'),
    ], layer),
    doc('Auto-Align Layers…', 'edit:auto-align'),
    doc('Auto-Blend Layers…', 'edit:auto-blend'),
    sep,
    doc('Define &Pattern', 'edit:define-pattern'),
    sep,
    sub('Purge', [
      doc('Undo', 'edit:purge', { arg: 'undo' }),
      item('Clipboard', 'edit:purge', { arg: 'clipboard' }),
      doc('Histories', 'edit:purge', { arg: 'histories' }),
      item('All', 'edit:purge', { arg: 'all' }),
    ]),
    sep,
    item('&Keyboard Shortcuts…', 'help:shortcuts', { accelerator: undefined }),
    ...(mac ? [] : [item('Pre&ferences…', 'edit:preferences')]),
  ]);

  const mode = state.mode ?? 'rgb';
  const depth = state.depth ?? 8;
  const adjustmentItems = IMAGE_ADJUSTMENTS.map((k) => (k ? adjustItem(k) : sep));
  const imageMenu = sub('&Image', [
    sub('&Mode', [
      ...IMAGE_MODES.map(([id, label]) => doc(label, 'image:mode', { arg: id, type: 'radio', checked: mode === id })),
      sep,
      doc('8 Bits/Channel', 'image:depth', { arg: 8, type: 'radio', checked: depth === 8 || mode === 'bitmap' }),
      doc('16 Bits/Channel', 'image:depth', { arg: 16, type: 'radio', checked: depth === 16, enabled: has && mode !== 'bitmap' && mode !== 'indexed' && mode !== 'duotone' }),
      doc('32 Bits/Channel', 'image:depth', { arg: 32, type: 'radio', checked: depth === 32, enabled: has && (mode === 'rgb' || mode === 'grayscale') }),
      sep,
      doc('Color Table…', 'image:color-table', { enabled: has && mode === 'indexed' }),
    ], has),
    sep,
    sub('&Adjustments', adjustmentItems, layer),
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
    lyr('Apply Image…', 'image:apply-image'),
    doc('Calculations…', 'image:calculations'),
    sep,
    doc('Trap…', 'image:trap', { enabled: has && mode === 'cmyk' }),
  ]);

  const layerMenu = sub('&Layer', [
    sub('&New', [
      doc('Layer…', 'layer:new'),
      lyr(state.backgroundLayer ? 'Layer from Background…' : 'Background from Layer', 'layer:from-background'),
      doc('Group', 'layer:new-group'),
      lyr('Group from Layers…', 'layer:group-from-layers'),
      sep,
      lyr('Layer via Copy', 'layer:via-copy'),
      lyr('Layer via Cut', 'layer:via-cut'),
    ], has),
    lyr('&Duplicate Layer', 'layer:duplicate'),
    sub('De&lete', [lyr('Layer', 'layer:delete'), doc('Hidden Layers', 'layer:delete-hidden')], has),
    sep,
    lyr('Quick Export as PNG', 'layer:export-quick'),
    lyr('Export As…', 'layer:export-as'),
    sep,
    lyr('Rena&me Layer…', 'layer:rename'),
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
    sub('Smart &Filter', [
      lyr('Enable / Disable Smart Filters', 'layer:smart-filters-toggle', { enabled: smart }),
      lyr('Clear Smart Filters', 'layer:smart-filters-clear', { enabled: smart }),
    ], layer),
    sep,
    sub('New Fi&ll Layer', [doc('Solid Color…', 'layer:new-fill', { arg: 'solid' }), doc('Gradient…', 'layer:new-fill', { arg: 'gradient' }), doc('Pattern…', 'layer:new-fill', { arg: 'pattern' })], has),
    sub('New &Adjustment Layer', LAYER_ADJUSTMENTS.map((k) => (k ? doc(`${ADJUSTMENTS[k].name}…`, 'layer:new-adjustment', { arg: k, enabled: has && !ADJUSTMENTS[k].placeholder }) : sep)), has),
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
    sub('Smart &Objects', [
      lyr('Convert to Smart Object', 'layer:smart-convert'),
      lyr('New Smart Object via Copy', 'layer:smart-via-copy', { enabled: smart }),
      sep,
      lyr('Edit Contents', 'layer:smart-edit', { enabled: smart }),
      lyr('Replace Contents…', 'layer:smart-replace', { enabled: smart }),
      lyr('Export Contents…', 'layer:smart-export', { enabled: smart }),
      lyr('Reset Transform', 'layer:smart-reset', { enabled: smart }),
      sep,
      sub('Stack Mode', STACK_MODES.map(([id, label]) => lyr(label, 'layer:stack-mode', { arg: id, type: 'radio', checked: (state.stackMode ?? 'none') === id, enabled: smart })), smart),
      lyr('Convert to Layers', 'layer:smart-to-layers', { enabled: smart }),
      sep,
      lyr('Enable / Disable Smart Filters', 'layer:smart-filters-toggle', { enabled: smart }),
      lyr('Clear Smart Filters', 'layer:smart-filters-clear', { enabled: smart }),
      sep,
      lyr('Rasterize', 'layer:smart-rasterize', { enabled: smart }),
    ], layer),
    sub('&Type', [
      lyr('Text on Path', 'text:on-path', { enabled: layer && state.layerType === 'text' }),
      lyr('Release from Path', 'text:release-path', { enabled: layer && state.layerType === 'text' }),
      lyr('Flip Text on Path', 'text:flip-path', { enabled: layer && state.layerType === 'text' }),
      sep,
      lyr('Horizontal', 'text:orientation', { arg: 'horizontal', type: 'radio', checked: !state.textOrientation || state.textOrientation === 'horizontal', enabled: layer && state.layerType === 'text' }),
      lyr('Vertical', 'text:orientation', { arg: 'vertical', type: 'radio', checked: state.textOrientation === 'vertical', enabled: layer && state.layerType === 'text' }),
      lyr('Vertical, Stacked (CJK)', 'text:orientation', { arg: 'vertical-stacked', type: 'radio', checked: state.textOrientation === 'vertical-stacked', enabled: layer && state.layerType === 'text' }),
    ], layer),
    sub('Shape &Operations', [
      lyr('Combine Shapes', 'path:op', { arg: 'combine' }),
      lyr('Subtract Front Shape', 'path:op', { arg: 'subtract' }),
      lyr('Intersect Shape Areas', 'path:op', { arg: 'intersect' }),
      lyr('Exclude Overlapping Shapes', 'path:op', { arg: 'exclude' }),
      sep,
      lyr('Merge Shape Components', 'path:merge-components'),
    ], layer && state.layerType === 'shape'),
    sub('Rasteri&ze', [lyr('Layer', 'layer:rasterize'), lyr('Layer Style', 'layer:rasterize-style'), sep, doc('All Layers', 'layer:rasterize-all')], layer),
    lyr('Edit &Text', 'layer:edit-text', { enabled: layer && state.layerType === 'text' }),
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
    lyr('Link Layers', 'layer:link'),
    lyr('Select Linked Layers', 'layer:select-linked'),
    sep,
    lyr('Merge Do&wn', 'layer:merge-down'),
    doc('Merge &Visible', 'layer:merge-visible'),
    doc('&Flatten Image', 'image:flatten'),
    sep,
    sub('Matting', [
      lyr('Color Decontaminate…', 'layer:matting', { arg: 'decontaminate' }),
      lyr('Defringe…', 'layer:matting', { arg: 'defringe' }),
      lyr('Remove Black Matte', 'layer:matting', { arg: 'remove-black' }),
      lyr('Remove White Matte', 'layer:matting', { arg: 'remove-white' }),
    ], layer),
  ]);

  const selectMenu = sub('&Select', [
    item('&All', 'select:all'),
    doc('&Deselect', 'select:none', { enabled: sel }),
    doc('&Reselect', 'select:reselect'),
    doc('&Inverse', 'select:inverse', { enabled: sel }),
    sep,
    doc('All &Layers', 'layer:select-all'),
    doc('Deselect Layers', 'select:deselect-layers'),
    doc('Find Layers', 'select:find-layers'),
    doc('Isolate Layers', 'select:isolate-layers', { type: 'checkbox', checked: !!state.isolated }),
    sep,
    doc('&Color Range…', 'select:color-range'),
    lyr('Focus Area…', 'select:focus-area'),
    lyr('Subject', 'select:subject'),
    lyr('Sky', 'select:sky'),
    sep,
    doc('Select and &Mask…', 'select:select-mask'),
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

  // the gallery groups appear in the menu when the preference says so (Photoshop: "Show all Filter Gallery groups and names")
  const galleryMenus = state.showGalleryInMenu ? GALLERY_GROUPS.filter((g) => g.kinds.length).map((g) => sub(g.name, g.kinds.map(filterItem), layer)) : [];
  const filterMenu = sub('Fil&ter', [
    lyr(state.lastFilter ? `Last Filter: ${state.lastFilter}` : 'Last Filter', 'filter:last', { enabled: layer && !!state.lastFilter }),
    sep,
    lyr('Convert for Smart Filters', 'layer:smart-convert', { enabled: layer && !smart }),
    sep,
    filterItem('filter-gallery'),
    filterItem('lens-correction'),
    lyr('&Liquify…', 'filter:liquify'),
    lyr('Camera &Raw Filter…', 'filter:camera-raw'),
    sep,
    ...FILTER_CATEGORIES.map((cat) => sub(cat.name, cat.kinds.map(filterItem), layer)),
    ...(galleryMenus.length ? [sep, ...galleryMenus] : []),
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
      // Cmd+H hides the app on macOS, so Show Extras has no accelerator there
      item('Selection Edges', 'view:extras', { type: 'checkbox', checked: state.extras !== false, ...(mac ? { accelerator: undefined } : {}) }),
      item('Grid', 'view:grid', { type: 'checkbox', checked: !!state.showGrid }),
      item('Guides', 'view:guides', { type: 'checkbox', checked: state.showGuides !== false }),
      item('Pixel Grid', 'view:pixel-grid', { type: 'checkbox', checked: state.pixelGrid !== false }),
    ]),
    item('&Rulers', 'view:rulers', { type: 'checkbox', checked: state.showRulers !== false }),
    item('Sna&p', 'view:snap', { type: 'checkbox', checked: state.snap !== false }),
    sep,
    doc('Proof Colors (CMYK)', 'view:proof', { type: 'checkbox', checked: !!state.proofColors }),
    doc('Gamut Warning', 'view:gamut', { type: 'checkbox', checked: !!state.gamutWarning }),
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
      ...(isPackaged ? [] : [sep, item('Toggle Developer Tools', 'help:devtools', { accelerator: mac ? 'Alt+Cmd+I' : 'F12' })]),
      ...(mac ? [] : [sep, item('&About Pigment', 'help:about')]),
    ],
  };

  const aiMenu = sub('A&I', [
    item('AI &Accounts…', 'ai:accounts'),
    sep,
    lyr('Generative &Fill…', 'ai:generative-fill', { enabled: layer && sel }),
    lyr('Generative &Expand…', 'ai:generative-expand'),
    doc('Generate &Image…', 'ai:generate-image'),
    sep,
    lyr('Remove &Background', 'ai:remove-background'),
    lyr('Replace Background…', 'ai:replace-background'),
    lyr('Replace &Sky…', 'ai:replace-sky'),
    sep,
    doc('&Describe Image', 'ai:describe'),
    sep,
    item('AI A&ssistant', 'window:panel-assistant'),
  ]);

  const template = [fileMenu, editMenu, imageMenu, layerMenu, selectMenu, filterMenu, aiMenu, viewMenu, windowMenu, helpMenu];
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
