// Native application menu. Every item runs a renderer command (see ARCHITECTURE.md "Commands");
// the renderer decides what the command means in its current state.
import { MENU_KEYS } from '../shared/keymap.js';

const SIDEBAR_VIEWS = [
  ['thumbnails', 'Page Thumbnails'],
  ['outline', 'Bookmarks'],
  ['attachments', 'Attachments'],
  ['layers', 'Layers'],
  ['comments', 'Comments'],
];

/**
 * @param {object} opts
 * @param {string} opts.platform            process.platform
 * @param {object} opts.state               ui state last reported by the renderer (setUiState)
 * @param {{path:string,name:string}[]} opts.recent
 * @param {(cmd: string, arg?: unknown) => void} opts.run   dispatches a command to the focused window
 * @param {boolean} [opts.isPackaged]
 */
export function buildMenuTemplate({ platform, state = {}, recent = [], run, isPackaged = true }) {
  const mac = platform === 'darwin';
  const has = !!state.hasDocument;
  const item = (label, cmd, extra = {}) => ({
    label,
    accelerator: MENU_KEYS[cmd],
    click: () => run(cmd, extra.arg),
    enabled: extra.enabled ?? true,
    ...(extra.type ? { type: extra.type, checked: !!extra.checked } : {}),
    ...(extra.id ? { id: extra.id } : {}),
  });
  const doc = (label, cmd, extra = {}) => item(label, cmd, { enabled: has, ...extra });
  const sep = { type: 'separator' };

  const recentItems = recent.length
    ? [
        ...recent.slice(0, 15).map((r) => ({ label: r.name || r.path, sublabel: mac ? undefined : r.path, toolTip: r.path, click: () => run('file:open-recent', r.path) })),
        sep,
        { label: 'Clear Recent Files', click: () => run('file:clear-recent') },
      ]
    : [{ label: 'No Recent Files', enabled: false }];

  const fileMenu = {
    label: '&File',
    submenu: [
      item('&Open…', 'file:open'),
      { label: 'Open &Recent', submenu: recentItems },
      sep,
      item('&New PDF from Images…', 'file:new-from-images'),
      item('&Combine Files into PDF…', 'file:merge'),
      sep,
      doc('&Save', 'file:save'),
      doc('Save &As…', 'file:save-as'),
      doc('Save a Cop&y…', 'file:save-copy'),
      doc('Reload from Disk', 'file:reload'),
      sep,
      doc('&Close', 'file:close'),
      doc('Close All', 'file:close-all'),
      sep,
      doc('&Properties…', 'file:properties'),
      doc(mac ? 'Reveal in Finder' : platform === 'win32' ? 'Show in Explorer' : 'Show in File Manager', 'file:reveal', { enabled: has && !!state.path }),
      {
        label: '&Export',
        enabled: has,
        submenu: [
          doc('Text…', 'file:export-text'),
          doc('Page Images…', 'file:export-images'),
          doc('Form Data (JSON)…', 'file:export-form-data'),
          doc('Flattened PDF (forms and annotations baked in)…', 'file:flatten'),
        ],
      },
      sep,
      doc('&Print…', 'file:print'),
      ...(mac ? [] : [sep, { role: 'quit', label: platform === 'win32' ? 'E&xit' : '&Quit' }]),
    ],
  };

  const editMenu = {
    label: '&Edit',
    submenu: [
      item('&Undo', 'edit:undo'),
      item('&Redo', 'edit:redo'),
      sep,
      item('Cu&t', 'edit:cut'),
      item('&Copy', 'edit:copy'),
      item('&Paste', 'edit:paste'),
      item('&Delete', 'edit:delete'),
      item('Select &All', 'edit:select-all'),
      sep,
      doc('Take a &Snapshot (copy area as image)', 'edit:snapshot'),
      sep,
      doc('&Find…', 'edit:find'),
      doc('Find &Next', 'edit:find-next'),
      doc('Find Pre&vious', 'edit:find-prev'),
      ...(mac ? [] : [sep, item('Pre&ferences…', 'edit:preferences')]),
    ],
  };

  const viewMenu = {
    label: '&View',
    submenu: [
      doc('Zoom &In', 'view:zoom-in'),
      doc('Zoom &Out', 'view:zoom-out'),
      doc('&Actual Size', 'view:actual-size'),
      doc('Fit &Page', 'view:fit-page'),
      doc('Fit &Width', 'view:fit-width'),
      sep,
      doc('Rotate &Clockwise', 'view:rotate-cw'),
      doc('Rotate Counter-cloc&kwise', 'view:rotate-ccw'),
      sep,
      {
        label: 'Page &Layout',
        enabled: has,
        submenu: [
          doc('Continuous', 'view:scroll-vertical', { type: 'radio', checked: (state.scrollMode ?? 0) === 0 }),
          doc('Single Page', 'view:scroll-page', { type: 'radio', checked: state.scrollMode === 3 }),
          doc('Horizontal', 'view:scroll-horizontal', { type: 'radio', checked: state.scrollMode === 1 }),
          doc('Wrapped', 'view:scroll-wrapped', { type: 'radio', checked: state.scrollMode === 2 }),
          sep,
          doc('No Spreads', 'view:spread-none', { type: 'radio', checked: (state.spreadMode ?? 0) === 0 }),
          doc('Two-Page (odd pages left)', 'view:spread-odd', { type: 'radio', checked: state.spreadMode === 1 }),
          doc('Two-Page (even pages left)', 'view:spread-even', { type: 'radio', checked: state.spreadMode === 2 }),
        ],
      },
      sep,
      doc('&First Page', 'view:first-page'),
      doc('Pre&vious Page', 'view:prev-page'),
      doc('&Next Page', 'view:next-page'),
      doc('&Last Page', 'view:last-page'),
      doc('&Go to Page…', 'view:go-to-page'),
      sep,
      doc('&Back', 'view:back'),
      doc('For&ward', 'view:forward'),
      sep,
      {
        label: '&Sidebar',
        submenu: [
          doc('Show Sidebar', 'view:toggle-sidebar', { type: 'checkbox', checked: !!state.sidebarOpen }),
          sep,
          ...SIDEBAR_VIEWS.map(([id, label]) => doc(label, 'view:sidebar', { arg: id, type: 'radio', checked: state.sidebarView === id })),
        ],
      },
      sep,
      doc('Night Mode (invert page colors)', 'view:night-mode', { type: 'checkbox', checked: !!state.nightMode }),
      {
        label: '&Theme',
        submenu: ['system', 'light', 'dark'].map((t) => item(t[0].toUpperCase() + t.slice(1), 'view:theme', { arg: t, type: 'radio', checked: (state.theme ?? 'system') === t })),
      },
      sep,
      doc('&Presentation Mode', 'view:presentation'),
      { role: 'togglefullscreen' },
      sep,
      doc('&Read Out Loud', 'view:read-aloud', { type: 'checkbox', checked: !!state.readAloud }),
    ],
  };

  const tool = (label, cmd, extra = {}) => doc(label, cmd, { type: 'radio', checked: state.tool === cmd.replace(/^tool:/, '') && !state.handTool, ...extra });
  const toolsMenu = {
    label: '&Tools',
    submenu: [
      doc('&Select Tool', 'tool:none', { type: 'radio', checked: !state.handTool && (!state.tool || state.tool === 'none') }),
      doc('&Hand Tool', 'view:hand-tool', { type: 'radio', checked: !!state.handTool }),
      sep,
      tool('&Highlight Text', 'tool:highlight'),
      tool('&Underline', 'tool:underline'),
      tool('Stri&kethrough', 'tool:strikeout'),
      tool('Squiggly Underline', 'tool:squiggly'),
      tool('Free Highlight (draw)', 'tool:highlight-free'),
      sep,
      tool('Sticky &Note', 'tool:note'),
      tool('&Text Box', 'tool:text'),
      tool('&Draw (pencil)', 'tool:ink'),
      {
        label: 'Sha&pes',
        enabled: has,
        submenu: [tool('Rectangle', 'tool:rect'), tool('Ellipse', 'tool:ellipse'), tool('Line', 'tool:line'), tool('Arrow', 'tool:arrow')],
      },
      tool('Sta&mp…', 'tool:stamp'),
      tool('Add &Image…', 'tool:image'),
      tool('&Eraser (delete annotations)', 'tool:eraser'),
      sep,
      {
        label: 'Fill && Si&gn',
        enabled: has,
        submenu: [tool('Add Signature…', 'tool:sign'), tool('Add Initials…', 'tool:initials'), sep, doc('Highlight Form Fields', 'form:toggle-highlight', { type: 'checkbox', checked: state.highlightFormFields !== false }), doc('Next Field', 'form:next-field'), doc('Reset Form…', 'form:reset'), doc('Export Form Data…', 'form:export')],
      },
      tool('Measure &Distance', 'tool:measure'),
      sep,
      doc('&Organize Pages…', 'pages:organize'),
      doc('Insert Pages from File…', 'pages:insert'),
      doc('Extract Pages…', 'pages:extract'),
      doc('Split Document…', 'pages:split'),
      doc('Crop Pages…', 'pages:crop'),
    ],
  };

  const imposeMenu = {
    label: '&Impose',
    submenu: [
      doc('Create &Booklet…', 'impose:booklet'),
      doc('&N-up Pages…', 'impose:nup'),
      doc('Step and &Repeat…', 'impose:step-repeat'),
      doc('&Manual Imposition…', 'impose:manual'),
      sep,
      doc('&Shuffle Pages…', 'impose:shuffle'),
      doc('Re&verse Pages', 'impose:reverse'),
      doc('Insert Blank Pages…', 'impose:insert-blank'),
      doc('Fill to a Multiple of Pages…', 'impose:fill-multiple'),
      doc('Duplicate Pages…', 'impose:duplicate'),
      sep,
      doc('&Trim and Shift…', 'impose:trim-shift'),
      doc('&Adjust Page Sizes…', 'impose:adjust-size'),
      doc('Mirror Pages…', 'impose:mirror'),
      doc('Rotate Page Content…', 'impose:rotate-content'),
      doc('Split Pages…', 'impose:split'),
      doc('Tile Pages…', 'impose:tile'),
      doc('Page Bo&xes…', 'impose:page-boxes'),
      doc('Page &Info…', 'impose:page-info'),
      sep,
      doc('&Page Numbers…', 'impose:page-numbers'),
      doc('Bates Numbers…', 'impose:bates'),
      doc('Stick On Text…', 'impose:stick-text'),
      doc('Masking Tape…', 'impose:tape'),
      doc("Printer's Mar&ks…", 'impose:marks'),
      sep,
      item('Create Sample &Document…', 'impose:sample'),
      item('Sheet Si&zes…', 'impose:sheet-sizes'),
      item('Automation Se&quences…', 'impose:sequences'),
      item(state.imposeRecording ? 'Stop Recording Sequence' : 'Record Sequence…', 'impose:record', { type: 'checkbox', checked: !!state.imposeRecording }),
    ],
  };

  const windowMenu = {
    role: 'window',
    label: '&Window',
    submenu: [
      { role: 'minimize' },
      ...(mac ? [{ role: 'zoom' }] : []),
      sep,
      doc('Next Tab', 'view:next-tab'),
      doc('Previous Tab', 'view:prev-tab'),
      ...(mac ? [sep, { role: 'front' }] : [{ role: 'close' }]),
    ],
  };

  const helpMenu = {
    role: 'help',
    label: '&Help',
    submenu: [
      item('&Keyboard Shortcuts', 'help:shortcuts'),
      item('Folio PDF on &GitHub', 'help:website'),
      sep,
      item('Toggle &Developer Tools', 'help:devtools'),
      ...(isPackaged ? [] : [{ role: 'reload' }]),
      ...(mac ? [] : [sep, item('&About Folio PDF', 'help:about')]),
    ],
  };

  const appMenu = {
    role: 'appMenu',
    label: 'Folio PDF',
    submenu: [
      { role: 'about' },
      sep,
      item('Preferences…', 'edit:preferences'),
      sep,
      { role: 'services' },
      sep,
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      sep,
      { role: 'quit' },
    ],
  };

  return [...(mac ? [appMenu] : []), fileMenu, editMenu, viewMenu, toolsMenu, imposeMenu, windowMenu, helpMenu];
}
