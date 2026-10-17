// Folio PDF renderer bootstrap: builds the App object, registers core commands and UI, installs
// feature modules, then opens startup files or restores the previous session.
import { bridge, isElectron, isMac, platform } from './lib/bridge.js';
import { CommandRegistry } from './lib/commands.js';
import { Dialogs } from './lib/dialogs.js';
import { Toolbar } from './lib/toolbar.js';
import { Statusbar } from './lib/statusbar.js';
import { Sidebar } from './lib/sidebar.js';
import { TabManager } from './lib/tabs.js';
import { ScrollMode, SpreadMode, ZOOM_PRESETS } from './lib/viewer.js';
import { icon } from './lib/icons.js';
import { withDefaults } from '../shared/defaults.js';
import { MENU_KEYS, RENDERER_KEYS, SHORTCUT_GROUPS, COMMAND_LABELS, describeAccelerator } from '../shared/keymap.js';

// Feature modules installed after the core. Missing modules are skipped with a warning so the
// app keeps working while features are being developed.
const MODULES = ['welcome', 'findbar', 'shortcuts', 'panels', 'annotate', 'sign', 'forms', 'pages', 'tools', 'print', 'properties', 'preferences', 'comments'];

class App extends EventTarget {
  constructor() {
    super();
    this.bridge = bridge;
    this.settings = withDefaults({});
    this.commands = new CommandRegistry(this);
    this.dialogs = new Dialogs(this);
    this.toolbar = new Toolbar(this);
    this.statusbar = new Statusbar();
    this.sidebar = new Sidebar(this);
    this.tabs = null;
    this.readAloud = false;
    this.tool = 'none';
    this.uiState = {};
  }

  get session() {
    return this.tabs?.active ?? null;
  }
  get view() {
    return this.session?.view ?? null;
  }

  emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }
  on(name, handler) {
    const listener = (event) => handler(event.detail);
    this.addEventListener(name, listener);
    return () => this.removeEventListener(name, listener);
  }

  async saveSettings(patch) {
    Object.assign(this.settings, patch);
    try {
      this.settings = withDefaults(await bridge.setSettings(patch));
    } catch (err) {
      console.warn('Could not persist settings', err);
    }
    this.emit('settings:changed', patch);
  }

  reportError(err, context) {
    console.error(context ?? 'Error', err);
    const message = err?.message ?? String(err);
    this.dialogs.toast(context ? `${context}: ${message}` : message, { kind: 'error', timeout: 6000 });
  }

  async askPassword(name, wrong) {
    const content = document.createElement('div');
    content.className = 'password-dialog';
    content.innerHTML = `<p class="dialog-message"></p><p class="muted">${wrong ? 'The password you entered is incorrect. Try again.' : 'Enter the password to open it.'}</p><label class="field"><span>Password</span><input class="input" type="password" autocomplete="off"></label>`;
    content.querySelector('.dialog-message').textContent = `"${name}" is protected`;
    const input = content.querySelector('input');
    const ok = await this.dialogs.open({ title: 'Password required', content, buttons: [{ label: 'Cancel', value: null }, { label: 'Open', value: true, primary: true }] });
    return ok ? input.value : null;
  }

  // ---- theme -----------------------------------------------------------------------------------------
  async applyTheme() {
    const theme = this.settings.theme ?? 'system';
    let dark;
    try {
      dark = await bridge.setTheme(theme);
    } catch {
      dark = theme === 'dark';
    }
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    this.emit('theme:changed', { dark });
  }

  // ---- ui state sent to the native menu -----------------------------------------------------------------
  syncUiState() {
    const s = this.session;
    const state = {
      hasDocument: !!s,
      dirty: !!s?.dirty,
      path: s?.path ?? null,
      title: s?.name ?? '',
      scrollMode: s?.view.scrollMode ?? this.settings.scrollMode,
      spreadMode: s?.view.spreadMode ?? this.settings.spreadMode,
      sidebarOpen: this.sidebar.isOpen(),
      sidebarView: this.sidebar.current,
      nightMode: !!s?.view.nightMode,
      theme: this.settings.theme,
      tool: this.tool,
      handTool: !!s?.view.handTool,
      highlightFormFields: this.settings.highlightFormFields !== false,
      readAloud: this.readAloud,
    };
    const changed = Object.keys(state).some((k) => this.uiState[k] !== state[k]);
    if (!changed) return;
    this.uiState = state;
    bridge.setUiState(state);
  }

  setTool(tool) {
    if (this.tool === tool) return;
    this.tool = tool;
    this.emit('tool:changed', { tool });
    this.commands.invalidate();
  }
}

// ---- core commands --------------------------------------------------------------------------------------
function registerCoreCommands(app) {
  const has = () => !!app.session;
  const view = () => app.view;
  const doc = (run, extra = {}) => ({ enabled: has, run, ...extra });
  const isTextTarget = () => {
    const el = document.activeElement;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  };

  app.commands.registerAll({
    // files
    'file:open': async () => {
      const paths = await bridge.openFileDialog({ multiple: true });
      for (const path of paths) await app.tabs.open({ path });
    },
    'file:open-paths': async (paths) => {
      for (const path of paths ?? []) await app.tabs.open({ path });
    },
    'file:open-recent': (path) => app.tabs.open({ path }),
    'file:clear-recent': async () => {
      await bridge.clearRecent();
      app.emit('recent:changed');
    },
    'file:save': doc(() => app.session.save()),
    'file:save-as': doc(() => app.session.saveAs()),
    'file:save-copy': doc(() => app.session.saveCopy()),
    'file:close': doc(() => app.session.close()),
    'file:close-all': doc(async () => {
      for (const s of app.tabs.list()) if (!(await s.close())) break;
    }),
    'file:reload': doc(async () => {
      const s = app.session;
      if (!s.path) return;
      if (!(await s.confirmDiscard())) return;
      const bytes = await bridge.readFile(s.path);
      s.opsDirty = false;
      await s.replaceBytes(bytes, { keepPosition: true, markDirty: false });
      s.view.markSaved();
    }),
    'file:reveal': doc(() => bridge.showItemInFolder(app.session.path), { enabled: () => !!app.session?.path && !app.session.path.startsWith('browser:/') }),
    'file:quit': () => bridge.closeWindow(),

    // edit (smart dispatch between text fields, pdf.js editors and native)
    'edit:undo': () => (isTextTarget() || !view()?.uiManager?.hasSomethingToUndo?.() ? bridge.nativeEdit('undo') : view().editorAction('undo')),
    'edit:redo': () => (isTextTarget() || !view()?.uiManager?.hasSomethingToRedo?.() ? bridge.nativeEdit('redo') : view().editorAction('redo')),
    'edit:cut': () => bridge.nativeEdit('cut'),
    'edit:copy': () => bridge.nativeEdit('copy'),
    'edit:paste': () => bridge.nativeEdit('paste'),
    'edit:delete': () => {
      if (isTextTarget()) return bridge.nativeEdit('delete');
      if (view()?.uiManager?.hasSelection) view().editorAction('delete');
    },
    'edit:select-all': () => {
      if (isTextTarget()) return bridge.nativeEdit('selectAll');
      const v = view();
      if (v?.uiManager && v.editorMode > 0) return v.editorAction('selectAll');
      if (v) {
        const range = document.createRange();
        range.selectNodeContents(v.container.querySelector('.pdfViewer') ?? v.container);
        const sel = document.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    },

    // view: zoom
    'view:zoom-in': doc(() => view().zoomIn()),
    'view:zoom-out': doc(() => view().zoomOut()),
    'view:zoom-reset': doc(() => (view().zoom = 1)),
    'view:actual-size': doc(() => (view().zoom = 'page-actual')),
    'view:fit-page': doc(() => (view().zoom = 'page-fit')),
    'view:fit-width': doc(() => (view().zoom = 'page-width')),
    'view:set-zoom': doc((value) => (view().zoom = value)),
    'view:rotate-cw': doc(() => view().rotate(90)),
    'view:rotate-ccw': doc(() => view().rotate(-90)),
    // view: navigation
    'view:first-page': doc(() => (view().page = 1)),
    'view:last-page': doc(() => (view().page = view().numPages)),
    'view:next-page': doc(() => view().nextPage()),
    'view:prev-page': doc(() => view().previousPage()),
    'view:go-to-page': doc(async (n) => {
      if (Number.isInteger(n)) {
        view().page = n;
        return;
      }
      const answer = await app.dialogs.prompt(`Go to page (1–${view().numPages})`, { title: 'Go to Page', type: 'number', value: String(view().page), min: 1, max: view().numPages, okLabel: 'Go' });
      if (answer !== null && answer !== '') {
        const page = Number(answer);
        if (Number.isFinite(page)) view().page = page;
        else view().goToPageLabel(answer);
      }
    }),
    'view:focus-page-number': doc(() => {
      const input = document.getElementById('tb-page-input');
      input?.focus();
      input?.select();
    }),
    'view:back': doc(() => view().back()),
    'view:forward': doc(() => view().forward()),
    // view: layout
    'view:scroll-vertical': doc(() => setScroll(ScrollMode.VERTICAL), { checked: () => view()?.scrollMode === ScrollMode.VERTICAL }),
    'view:scroll-horizontal': doc(() => setScroll(ScrollMode.HORIZONTAL), { checked: () => view()?.scrollMode === ScrollMode.HORIZONTAL }),
    'view:scroll-wrapped': doc(() => setScroll(ScrollMode.WRAPPED), { checked: () => view()?.scrollMode === ScrollMode.WRAPPED }),
    'view:scroll-page': doc(() => setScroll(ScrollMode.PAGE), { checked: () => view()?.scrollMode === ScrollMode.PAGE }),
    'view:spread-none': doc(() => setSpread(SpreadMode.NONE), { checked: () => view()?.spreadMode === SpreadMode.NONE }),
    'view:spread-odd': doc(() => setSpread(SpreadMode.ODD), { checked: () => view()?.spreadMode === SpreadMode.ODD }),
    'view:spread-even': doc(() => setSpread(SpreadMode.EVEN), { checked: () => view()?.spreadMode === SpreadMode.EVEN }),
    'view:toggle-sidebar': { run: () => app.sidebar.toggle(), checked: () => app.sidebar.isOpen() },
    'view:sidebar': { run: (id) => app.sidebar.show(id) },
    'view:night-mode': doc(
      () => {
        const next = !view().nightMode;
        view().setNightMode(next);
        app.saveSettings({ nightMode: next });
      },
      { checked: () => !!view()?.nightMode }
    ),
    'view:theme': { run: async (theme) => {
      await app.saveSettings({ theme });
      await app.applyTheme();
    } },
    'view:presentation': doc(() => togglePresentation(), { checked: () => !!view()?.presentation }),
    'view:fullscreen': async () => bridge.setFullScreen(!(await bridge.isFullScreen())),
    'view:hand-tool': doc(
      () => {
        app.commands.run('tool:none', undefined, 'api');
        view().setHandTool(true);
        app.setTool('hand');
      },
      { checked: () => !!view()?.handTool }
    ),
    'view:select-tool': doc(() => app.commands.run('tool:none', undefined, 'api')),
    'tool:none': {
      run: () => {
        const v = view();
        if (v) {
          v.setHandTool(false);
          if (v.editorMode !== 0) v.editorMode = 0;
        }
        app.setTool('none');
        app.toolbar.setSecondary(null);
      },
      checked: () => app.tool === 'none',
    },
    'view:next-tab': { run: () => app.tabs.next(1), enabled: () => app.tabs.list().length > 1 },
    'view:prev-tab': { run: () => app.tabs.next(-1), enabled: () => app.tabs.list().length > 1 },
    'app:escape': () => {
      if (app.dialogs.activePopover) return app.dialogs.closePopover();
      if (view()?.presentation) return togglePresentation();
      const findbar = document.getElementById('findbar');
      if (findbar && !findbar.hidden && findbar.contains(document.activeElement)) return app.commands.run('edit:find-close', undefined, 'api');
      if (view()?.uiManager?.hasSelection) return view().uiManager.unselectAll();
      if (app.tool !== 'none') return app.commands.run('tool:none', undefined, 'api');
      if (findbar && !findbar.hidden) return app.commands.run('edit:find-close', undefined, 'api');
      view()?.focus();
    },

    // help
    'help:shortcuts': () => showShortcuts(app),
    'help:about': () => showAbout(app),
    'help:website': () => bridge.openExternal('https://github.com/Nihalpi1212/claude/tree/main/folio'),
    'help:devtools': () => {},
  });

  function setScroll(mode) {
    view().scrollMode = mode;
    app.saveSettings({ scrollMode: mode });
    app.syncUiState();
  }
  function setSpread(mode) {
    view().spreadMode = mode;
    app.saveSettings({ spreadMode: mode });
    app.syncUiState();
  }

  let presentationState = null;
  async function togglePresentation() {
    const v = view();
    if (!v) return;
    if (!v.presentation) {
      presentationState = { scrollMode: v.scrollMode, spreadMode: v.spreadMode, zoom: v.pdfViewer.currentScaleValue, sidebar: app.sidebar.isOpen() };
      v.presentation = true;
      document.body.classList.add('presentation');
      if (app.sidebar.isOpen()) app.sidebar.toggle(false);
      v.scrollMode = ScrollMode.PAGE;
      v.spreadMode = SpreadMode.NONE;
      await bridge.setFullScreen(true);
      requestAnimationFrame(() => {
        v.zoom = 'page-fit';
        v.focus();
      });
      app.commands.invalidate();
    } else {
      v.presentation = false;
      document.body.classList.remove('presentation');
      await bridge.setFullScreen(false);
      if (presentationState) {
        v.scrollMode = presentationState.scrollMode;
        v.spreadMode = presentationState.spreadMode;
        if (presentationState.sidebar) app.sidebar.toggle(true);
        requestAnimationFrame(() => {
          v.pdfViewer.currentScaleValue = presentationState.zoom;
          v.focus();
        });
      }
      app.commands.invalidate();
    }
    app.emit('presentation:changed', { on: v.presentation });
  }
}

function showShortcuts(app) {
  const content = document.createElement('div');
  content.className = 'shortcut-grid';
  for (const group of SHORTCUT_GROUPS) {
    const g = document.createElement('div');
    g.className = 'shortcut-group';
    const h = document.createElement('h3');
    h.textContent = group.title;
    g.appendChild(h);
    for (const cmd of group.commands) {
      const accels = [MENU_KEYS[cmd], ...(RENDERER_KEYS[cmd] ?? [])].filter(Boolean);
      if (!accels.length) continue;
      const row = document.createElement('div');
      row.className = 'shortcut-row';
      const label = document.createElement('span');
      label.textContent = COMMAND_LABELS[cmd] ?? cmd;
      const keys = document.createElement('span');
      keys.className = 'keys';
      for (const a of accels.slice(0, 2)) {
        const k = document.createElement('kbd');
        k.className = 'kbd';
        k.textContent = describeAccelerator(a, isMac);
        keys.appendChild(k);
      }
      row.append(label, keys);
      g.appendChild(row);
    }
    content.appendChild(g);
  }
  return app.dialogs.open({ title: 'Keyboard shortcuts', content, className: 'wide', buttons: [{ label: 'Close', value: true, primary: true }] });
}

function showAbout(app) {
  const content = document.createElement('div');
  content.className = 'about-dialog';
  content.innerHTML = `<img src="/build/icon.png" alt=""><h3>Folio PDF</h3><p>Version ${bridge.version}</p><p>A free, open-source PDF reader for Windows, macOS and Linux.<br>Built with Electron, pdf.js and pdf-lib. MIT License.</p>`;
  return app.dialogs.open({ title: 'About Folio PDF', content, buttons: [{ label: 'Close', value: true, primary: true }] });
}

// ---- core toolbar -------------------------------------------------------------------------------------------
function buildToolbar(app) {
  const tb = app.toolbar;
  tb.addButton({ id: 'open', group: 'file', icon: 'open', title: 'Open', command: 'file:open' });
  tb.addButton({ id: 'save', group: 'file', icon: 'save', title: 'Save', command: 'file:save' });
  tb.addButton({ id: 'print', group: 'file', icon: 'print', title: 'Print', command: 'file:print' });
  tb.addButton({ id: 'sidebar', group: 'file', icon: 'sidebar', title: 'Sidebar', command: 'view:toggle-sidebar', toggle: true });

  // navigation
  tb.addButton({ id: 'prev', group: 'nav', icon: 'chevron-left', title: 'Previous page', command: 'view:prev-page' });
  const pageInput = document.createElement('input');
  pageInput.className = 'tb-input tb-page-input';
  pageInput.id = 'tb-page-input';
  pageInput.type = 'text';
  pageInput.inputMode = 'numeric';
  pageInput.setAttribute('aria-label', 'Page number');
  pageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      const v = app.view;
      if (!v) return;
      const n = Number(pageInput.value);
      if (Number.isFinite(n) && n >= 1) v.page = n;
      else v.goToPageLabel(pageInput.value);
      v.focus();
    } else if (event.key === 'Escape') {
      app.view?.focus();
    }
  });
  pageInput.addEventListener('focus', () => pageInput.select());
  tb.addElement('nav', pageInput);
  const pageCount = document.createElement('span');
  pageCount.className = 'tb-page-count';
  pageCount.id = 'tb-page-count';
  tb.addElement('nav', pageCount);
  tb.addButton({ id: 'next', group: 'nav', icon: 'chevron-right', title: 'Next page', command: 'view:next-page' });

  // zoom
  tb.addButton({ id: 'zoom-out', group: 'zoom', icon: 'zoom-out', title: 'Zoom out', command: 'view:zoom-out' });
  const zoomInput = document.createElement('input');
  zoomInput.className = 'tb-input tb-zoom-input';
  zoomInput.id = 'tb-zoom-input';
  zoomInput.type = 'text';
  zoomInput.setAttribute('aria-label', 'Zoom level');
  zoomInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      const n = parseFloat(zoomInput.value);
      if (Number.isFinite(n) && n > 0 && app.view) app.view.zoom = n / 100;
      app.view?.focus();
    } else if (event.key === 'Escape') app.view?.focus();
  });
  zoomInput.addEventListener('focus', () => zoomInput.select());
  tb.addElement('zoom', zoomInput);
  const zoomMenu = () => [
    { label: 'Automatic', checked: app.view?.zoom === 'auto', onSelect: () => app.commands.run('view:set-zoom', 'auto', 'toolbar') },
    { label: 'Actual size', checked: app.view?.zoom === 'page-actual', shortcut: MENU_KEYS['view:actual-size'], onSelect: () => app.commands.run('view:actual-size', undefined, 'toolbar') },
    { label: 'Fit page', checked: app.view?.zoom === 'page-fit', shortcut: MENU_KEYS['view:fit-page'], onSelect: () => app.commands.run('view:fit-page', undefined, 'toolbar') },
    { label: 'Fit width', checked: app.view?.zoom === 'page-width', shortcut: MENU_KEYS['view:fit-width'], onSelect: () => app.commands.run('view:fit-width', undefined, 'toolbar') },
    { type: 'separator' },
    ...[50, 75, 100, 125, 150, 200, 300, 400].map((p) => ({ label: `${p}%`, checked: typeof app.view?.zoom === 'number' && Math.round(app.view.zoom * 100) === p, onSelect: () => app.commands.run('view:set-zoom', p / 100, 'toolbar') })),
  ];
  tb.addButton({ id: 'zoom-menu', group: 'zoom', icon: 'chevron-down', title: 'Zoom presets', menu: zoomMenu, enabled: () => !!app.session });
  tb.addButton({ id: 'zoom-in', group: 'zoom', icon: 'zoom-in', title: 'Zoom in', command: 'view:zoom-in' });
  tb.addButton({ id: 'fit-width', group: 'zoom', icon: 'fit-width', title: 'Fit width', command: 'view:fit-width', pressed: () => app.view?.zoom === 'page-width' });
  tb.addButton({ id: 'fit-page', group: 'zoom', icon: 'fit-page', title: 'Fit page', command: 'view:fit-page', pressed: () => app.view?.zoom === 'page-fit' });

  // tools: select/hand (annotation tools are added by annotate.js)
  tb.addButton({ id: 'select', group: 'tools', icon: 'select', title: 'Select text and annotations', command: 'tool:none', pressed: () => app.tool === 'none' });
  tb.addButton({ id: 'hand', group: 'tools', icon: 'hand', title: 'Hand tool (drag to scroll)', command: 'view:hand-tool', pressed: () => app.tool === 'hand' });

  // view menu + find
  tb.addButton({ id: 'find', group: 'view', icon: 'search', title: 'Find', command: 'edit:find' });
  const viewMenu = () => {
    const v = app.view;
    return [
      { label: 'Rotate clockwise', icon: 'rotate-cw', shortcut: MENU_KEYS['view:rotate-cw'], onSelect: () => app.commands.run('view:rotate-cw', undefined, 'toolbar') },
      { label: 'Rotate counter-clockwise', icon: 'rotate-ccw', shortcut: MENU_KEYS['view:rotate-ccw'], onSelect: () => app.commands.run('view:rotate-ccw', undefined, 'toolbar') },
      { type: 'separator' },
      { type: 'title', label: 'Page layout' },
      { label: 'Continuous', checked: v?.scrollMode === ScrollMode.VERTICAL, onSelect: () => app.commands.run('view:scroll-vertical', undefined, 'toolbar') },
      { label: 'Single page', checked: v?.scrollMode === ScrollMode.PAGE, onSelect: () => app.commands.run('view:scroll-page', undefined, 'toolbar') },
      { label: 'Horizontal', checked: v?.scrollMode === ScrollMode.HORIZONTAL, onSelect: () => app.commands.run('view:scroll-horizontal', undefined, 'toolbar') },
      { label: 'Wrapped', checked: v?.scrollMode === ScrollMode.WRAPPED, onSelect: () => app.commands.run('view:scroll-wrapped', undefined, 'toolbar') },
      { type: 'separator' },
      { label: 'No spreads', checked: v?.spreadMode === SpreadMode.NONE, onSelect: () => app.commands.run('view:spread-none', undefined, 'toolbar') },
      { label: 'Two pages (odd left)', checked: v?.spreadMode === SpreadMode.ODD, onSelect: () => app.commands.run('view:spread-odd', undefined, 'toolbar') },
      { label: 'Two pages (even left)', checked: v?.spreadMode === SpreadMode.EVEN, onSelect: () => app.commands.run('view:spread-even', undefined, 'toolbar') },
      { type: 'separator' },
      { label: 'Night mode', icon: 'night', checked: !!v?.nightMode, onSelect: () => app.commands.run('view:night-mode', undefined, 'toolbar') },
      { label: 'Presentation mode', icon: 'presentation', shortcut: MENU_KEYS['view:presentation'], onSelect: () => app.commands.run('view:presentation', undefined, 'toolbar') },
      { label: 'Read out loud', icon: 'speaker', checked: app.readAloud, shortcut: MENU_KEYS['view:read-aloud'], disabled: !app.commands.has('view:read-aloud'), onSelect: () => app.commands.run('view:read-aloud', undefined, 'toolbar') },
      { type: 'separator' },
      { label: 'Document properties…', icon: 'info', shortcut: MENU_KEYS['file:properties'], disabled: !app.commands.has('file:properties'), onSelect: () => app.commands.run('file:properties', undefined, 'toolbar') },
    ];
  };
  tb.addButton({ id: 'view-menu', group: 'view', icon: 'eye', title: 'View options', menu: viewMenu, enabled: () => !!app.session });
  const moreMenu = () => [
    { label: 'Open…', icon: 'open', shortcut: MENU_KEYS['file:open'], onSelect: () => app.commands.run('file:open', undefined, 'toolbar') },
    { label: 'Save as…', icon: 'save', shortcut: MENU_KEYS['file:save-as'], disabled: !app.session, onSelect: () => app.commands.run('file:save-as', undefined, 'toolbar') },
    { label: 'Save a copy…', icon: 'copy', disabled: !app.session, onSelect: () => app.commands.run('file:save-copy', undefined, 'toolbar') },
    { label: 'Reload from disk', icon: 'refresh', disabled: !app.session?.path, onSelect: () => app.commands.run('file:reload', undefined, 'toolbar') },
    { type: 'separator' },
    { label: 'Create PDF from images…', icon: 'image', disabled: !app.commands.has('file:new-from-images'), onSelect: () => app.commands.run('file:new-from-images', undefined, 'toolbar') },
    { label: 'Combine files…', icon: 'merge', disabled: !app.commands.has('file:merge'), onSelect: () => app.commands.run('file:merge', undefined, 'toolbar') },
    { type: 'separator' },
    { label: 'Preferences…', icon: 'settings', shortcut: MENU_KEYS['edit:preferences'], disabled: !app.commands.has('edit:preferences'), onSelect: () => app.commands.run('edit:preferences', undefined, 'toolbar') },
    { label: 'Keyboard shortcuts', icon: 'keyboard', shortcut: MENU_KEYS['help:shortcuts'], onSelect: () => app.commands.run('help:shortcuts', undefined, 'toolbar') },
    { label: 'About Folio PDF', icon: 'info', onSelect: () => app.commands.run('help:about', undefined, 'toolbar') },
  ];
  tb.addButton({ id: 'more', group: 'right', icon: 'more', title: 'More', menu: moreMenu });

  const refresh = () => {
    const v = app.view;
    if (!v || !v.pdfDocument) {
      pageInput.value = '';
      pageInput.disabled = true;
      pageCount.textContent = '';
      zoomInput.value = '';
      zoomInput.disabled = true;
      return;
    }
    pageInput.disabled = false;
    zoomInput.disabled = false;
    if (document.activeElement !== pageInput) pageInput.value = String(v.page);
    const label = v.pageLabel;
    pageCount.textContent = label && label !== String(v.page) ? `(${label}) of ${v.numPages}` : `of ${v.numPages}`;
    if (document.activeElement !== zoomInput) zoomInput.value = `${Math.round(v.scale * 100)}%`;
  };
  tb.onUpdate(refresh);
  app.on('page:changed', refresh);
  app.on('zoom:changed', refresh);
  app.on('tab:activated', refresh);
  app.on('doc:loaded', refresh);
  app.on('doc:reloaded', refresh);
  refresh();
}

// ---- status bar ---------------------------------------------------------------------------------------------
function buildStatusbar(app) {
  const sb = app.statusbar;
  const refresh = () => {
    const s = app.session;
    if (!s || !s.view.pdfDocument) {
      sb.clear('page');
      sb.clear('zoom');
      sb.clear('size');
      sb.set('hint', 'Open a PDF to get started');
      return;
    }
    sb.clear('hint');
    sb.set('page', `Page ${s.view.page} of ${s.view.numPages}`);
    sb.set('zoom', `${Math.round(s.view.scale * 100)}%`, { right: true });
    const kb = s.bytes.byteLength / 1024;
    sb.set('size', kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`, { right: true });
  };
  for (const ev of ['page:changed', 'zoom:changed', 'tab:activated', 'doc:loaded', 'doc:reloaded', 'doc:saved']) app.on(ev, refresh);
  refresh();
}

// ---- drag and drop ------------------------------------------------------------------------------------------
function setupDragDrop(app) {
  let depth = 0;
  document.addEventListener('dragenter', (event) => {
    if (![...event.dataTransfer?.types ?? []].includes('Files')) return;
    depth++;
    document.body.classList.add('drag-over');
  });
  document.addEventListener('dragleave', () => {
    if (--depth <= 0) {
      depth = 0;
      document.body.classList.remove('drag-over');
    }
  });
  document.addEventListener('dragover', (event) => {
    if ([...event.dataTransfer?.types ?? []].includes('Files')) event.preventDefault();
  });
  document.addEventListener('drop', async (event) => {
    depth = 0;
    document.body.classList.remove('drag-over');
    const files = [...(event.dataTransfer?.files ?? [])];
    if (!files.length) return;
    event.preventDefault();
    for (const file of files) {
      if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') continue;
      const path = bridge.pathForFile(file);
      if (path) await app.tabs.open({ path });
      else await app.tabs.open({ bytes: new Uint8Array(await file.arrayBuffer()), name: file.name });
    }
  });
}

// ---- host events --------------------------------------------------------------------------------------------
function setupHostEvents(app) {
  bridge.on('command', (cmd, arg) => app.commands.run(cmd, arg, 'menu'));
  bridge.on('open-files', (paths) => app.commands.run('file:open-paths', paths, 'api'));
  bridge.on('theme', ({ dark }) => {
    if (app.settings.theme === 'system') {
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      app.emit('theme:changed', { dark });
    }
  });
  bridge.on('fullscreen', ({ fullScreen }) => {
    document.body.classList.toggle('fullscreen', !!fullScreen);
    if (!fullScreen && app.view?.presentation) app.commands.run('view:presentation', undefined, 'api');
  });
  bridge.on('file-changed', async ({ path }) => {
    const session = app.tabs.findByPath(path);
    if (!session) return;
    if (session.dirty) {
      app.dialogs.toast(`"${session.name}" changed on disk. Your unsaved edits are kept; use File › Reload to discard them.`, { timeout: 8000 });
      return;
    }
    try {
      const bytes = await bridge.readFile(path);
      await session.replaceBytes(bytes, { keepPosition: true, markDirty: false });
      session.view.markSaved();
      app.dialogs.toast(`Reloaded "${session.name}" (changed on disk)`, { timeout: 2500 });
    } catch (err) {
      app.reportError(err, 'Could not reload the changed file');
    }
  });
  bridge.on('before-close', async ({ quitting } = {}) => {
    try {
      const lastSession = app.tabs.list().filter((s) => s.path && !s.path.startsWith('browser:/')).map((s) => ({ path: s.path, page: s.view.page }));
      for (const s of app.tabs.list()) app.tabs.rememberRecent(s);
      for (const s of app.tabs.list()) {
        if (!(await s.confirmDiscard())) {
          bridge.respondClose(false, !!quitting);
          return;
        }
      }
      await app.saveSettings({ lastSession });
    } catch (err) {
      console.warn('before-close', err);
    }
    bridge.respondClose(true, !!quitting);
  });
}

// ---- startup -------------------------------------------------------------------------------------------------
async function start() {
  const app = new App();
  window.folioApp = app;
  document.body.classList.add(`platform-${platform}`);
  try {
    app.settings = withDefaults(await bridge.getSettings());
  } catch (err) {
    console.warn('settings unavailable', err);
  }
  if (!app.settings.authorName && bridge.userName) app.settings.authorName = bridge.userName;
  await app.applyTheme();
  app.tabs = new TabManager(app);
  registerCoreCommands(app);
  buildToolbar(app);
  buildStatusbar(app);
  setupDragDrop(app);
  setupHostEvents(app);

  for (const name of MODULES) {
    try {
      const mod = await import(`./lib/${name}.js`);
      mod.install?.(app);
    } catch (err) {
      if (!/Failed to fetch|Cannot find|404|Failed to load/i.test(String(err?.message))) console.warn(`Module ${name} failed`, err);
      else console.info(`Module ${name} not present yet`);
    }
  }

  if (app.settings.sidebarOpen) app.sidebar.toggle(true);
  app.on('tab:activated', () => app.syncUiState());
  app.on('doc:dirty', () => {
    app.tabs.render();
    app.syncUiState();
  });
  app.on('doc:loaded', () => app.syncUiState());
  app.on('doc:saved', () => app.syncUiState());
  app.on('sidebar:changed', () => app.syncUiState());
  app.on('tool:changed', () => app.syncUiState());
  app.on('settings:changed', () => app.syncUiState());
  app.on('layout:mode', () => app.syncUiState());
  app.on('commands:changed', () => app.syncUiState());
  app.syncUiState();

  const startupFiles = await bridge.getStartupFiles().catch(() => []);
  if (startupFiles.length) {
    for (const path of startupFiles) await app.tabs.open({ path });
  } else if (app.settings.restoreSession && app.settings.lastSession?.length && isElectron) {
    for (const entry of app.settings.lastSession) await app.tabs.open({ path: entry.path, page: entry.page, activate: false });
    if (app.tabs.list().length) app.tabs.activate(app.tabs.list()[0]);
  }
  if (!app.session) document.getElementById('welcome').hidden = false;
  app.emit('app:ready');
  document.body.dataset.ready = 'true';
}

start().catch((err) => {
  console.error('Folio failed to start', err);
  document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif"><h2>Folio PDF could not start</h2><pre>${String(err?.stack ?? err)}</pre></div>`;
});
