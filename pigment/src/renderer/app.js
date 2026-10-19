// Pigment renderer bootstrap: builds the App object, registers core commands and UI, installs the
// feature modules, then opens startup files or shows the welcome screen.
import { bridge, isElectron, isMac, platform } from './lib/bridge.js';
import { CommandRegistry } from './lib/commands.js';
import { Dialogs } from './lib/dialogs.js';
import { Statusbar } from './lib/statusbar.js';
import { ToolManager } from './lib/tools.js';
import { PanelDock } from './lib/panels.js';
import { DocumentManager } from './lib/documents.js';
import { createDocument } from './lib/document.js';
import { Selection } from './lib/selection.js';
import { icon } from './lib/icons.js';
import { withDefaults } from '../shared/defaults.js';
import { parseColor, rgbaToHex } from '../shared/pixels/color.js';
import { MENU_KEYS, RENDERER_KEYS, SHORTCUT_GROUPS, COMMAND_LABELS, describeAccelerator } from '../shared/keymap.js';

// Feature modules installed after the core, in this order. A module that fails to load is skipped
// with a warning so the rest of the app keeps working.
const MODULES = [
  'lib/shortcuts.js',
  'lib/layer-ops.js',
  'lib/edit-ops.js',
  'lib/image-ops.js',
  'lib/file-ops.js',
  'lib/tools/move.js',
  'lib/tools/select.js',
  'lib/tools/paint.js',
  'lib/tools/retouch.js',
  'lib/tools/fill.js',
  'lib/tools/text.js',
  'lib/tools/vector.js',
  'lib/tools/nav.js',
  'lib/adjust-ui.js',
  'lib/filter-ui.js',
  'lib/style-ui.js',
  'lib/panels/color.js',
  'lib/panels/swatches.js',
  'lib/panels/brushes.js',
  'lib/panels/properties.js',
  'lib/panels/adjustments.js',
  'lib/panels/character.js',
  'lib/panels/paths.js',
  'lib/panels/layers.js',
  'lib/panels/channels.js',
  'lib/panels/history.js',
  'lib/panels/navigator.js',
  'lib/panels/info.js',
  'lib/extras.js',
  'lib/welcome.js',
];

export class App extends EventTarget {
  constructor() {
    super();
    this.bridge = bridge;
    this.settings = withDefaults({});
    this.commands = new CommandRegistry(this);
    this.dialogs = new Dialogs(this);
    this.statusbar = new Statusbar();
    this.ui = { editingMask: false, showMaskOverlay: false };
    this.uiState = {};
    this.saveTimer = null;
    this.pendingSettings = {};
  }

  get doc() {
    return this.docs?.active ?? null;
  }
  get view() {
    return this.doc?.view ?? null;
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
    if (patch && 'theme' in patch) await this.applyTheme();
  }

  /** Coalesces frequent setting writes (tool options, panel layout) into one write. */
  saveSettingsSoon(patch) {
    Object.assign(this.settings, patch);
    Object.assign(this.pendingSettings, patch);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const p = this.pendingSettings;
      this.pendingSettings = {};
      bridge.setSettings(p).catch((err) => console.warn('Could not persist settings', err));
    }, 400);
    this.emit('settings:changed', patch);
  }

  reportError(err, context) {
    console.error(context ?? 'Error', err);
    const message = err?.message ?? String(err);
    this.dialogs.toast(context ? `${context}: ${message}` : message, { kind: 'error', timeout: 6000 });
  }

  /** Runs a slow task with a busy cursor and status text. */
  async busy(label, fn) {
    this.statusbar.set('busy', label);
    document.body.classList.add('busy');
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
    try {
      return await fn();
    } finally {
      document.body.classList.remove('busy');
      this.statusbar.clear('busy');
    }
  }

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
    this.view?.invalidate();
  }

  syncUiState() {
    const d = this.doc;
    const state = {
      hasDocument: !!d,
      dirty: !!d?.history?.dirty,
      path: d?.path ?? null,
      title: d?.name ?? '',
      hasSelection: !!d?.selection && !d.selection.isEmpty,
      hasLayer: !!d?.active,
      canUndo: !!d?.history?.canUndo,
      canRedo: !!d?.history?.canRedo,
      undoLabel: d?.history?.canUndo ? d.history.entries[d.history.index]?.label ?? '' : '',
      redoLabel: d?.history?.canRedo ? d.history.entries[d.history.index + 1]?.label ?? '' : '',
      theme: this.settings.theme,
      tool: this.tools?.active?.id ?? null,
      showRulers: this.settings.showRulers !== false,
      showGrid: !!this.settings.showGrid,
      showGuides: this.settings.showGuides !== false,
      snap: this.settings.snap !== false,
      pixelGrid: this.settings.pixelGrid !== false,
      extras: this.settings.showSelectionEdges !== false,
      lastFilter: this.settings.lastFilter?.name ?? '',
      editingMask: !!this.ui.editingMask,
      layerType: d?.active?.type ?? null,
    };
    const changed = Object.keys(state).some((k) => this.uiState[k] !== state[k]);
    if (!changed) return;
    this.uiState = state;
    document.title = state.hasDocument ? `${state.dirty ? '• ' : ''}${state.title} — Pigment` : 'Pigment';
    bridge.setUiState(state);
  }

  // ---- colours ----------------------------------------------------------------------------------------------
  setColors({ foreground, background } = {}) {
    const patch = {};
    if (foreground) patch.foreground = rgbaToHex(parseColor(foreground));
    if (background) patch.background = rgbaToHex(parseColor(background));
    this.saveSettingsSoon(patch);
    this.emit('color:changed', { fg: this.settings.foreground, bg: this.settings.background });
  }

  // ---- selection helpers ------------------------------------------------------------------------------------------
  /** Applies a selection (combine mode) undoably. */
  applySelection(next, mode = 'replace', label = 'Selection') {
    const d = this.doc;
    if (!d) return;
    const before = d.selection;
    let result = next;
    if (before && !before.isEmpty && next && mode !== 'replace') result = before.combine(next, mode);
    if (result && result.isEmpty) result = null;
    const set = (s) => {
      d.selection = s;
      d.changed('selection');
    };
    set(result);
    if (before && !before.isEmpty) d.savedSelection = before;
    d.history.push({ label, undo: () => set(before), redo: () => set(result), bytes: 0, at: Date.now() });
    this.syncUiState();
  }

  setEditingMask(on) {
    const layer = this.doc?.active;
    const value = !!on && !!layer?.mask;
    if (this.ui.editingMask === value) return;
    this.ui.editingMask = value;
    if (!value && this.view) this.view.maskView = false;
    this.emit('mask:editing', value);
    this.doc?.changed('mask-edit');
    this.statusbar.set('target', value ? 'Editing layer mask (paint black to hide, white to reveal)' : '');
    this.syncUiState();
  }

  /** Crops the canvas to rect (document coordinates), keeping layers that extend beyond when deletePixels is false. */
  cropDocument(rect, opts) {
    return this.commands.run('image:crop-rect', { rect, ...opts }, 'api');
  }

  /** Opens a new document from settings. */
  newDocument(opts) {
    const doc = createDocument(opts);
    this.docs.add(doc);
    doc.history.markSaved();
    return doc;
  }
}

// ---- core commands ------------------------------------------------------------------------------------------
function registerCoreCommands(app) {
  const has = () => !!app.doc;
  const isTextTarget = () => {
    const el = document.activeElement;
    return !!el && ((el.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'color'].includes(el.type)) || el.tagName === 'TEXTAREA' || el.isContentEditable);
  };
  app.commands.registerAll({
    // files
    'file:new': { run: (arg) => app.newDocumentDialog?.(arg) },
    'file:open': { run: () => app.docs.openDialog() },
    'file:open-paths': { run: (paths) => app.docs.openPaths(Array.isArray(paths) ? paths : [paths]) },
    'file:open-recent': { run: (path) => app.docs.openPaths([path]) },
    'file:clear-recent': {
      run: async () => {
        await bridge.clearRecent();
        app.emit('recent:changed');
      },
    },
    'file:save': { enabled: has, run: () => app.docs.save() },
    'file:save-as': { enabled: has, run: () => app.docs.saveAs() },
    'file:save-copy': { enabled: has, run: () => app.docs.saveAs(app.doc, { copy: true }) },
    'file:close': { enabled: has, run: () => app.docs.close() },
    'file:close-all': { enabled: has, run: () => app.docs.closeAll() },
    'file:revert': {
      enabled: () => !!app.doc?.path && !!app.doc?.history?.dirty,
      run: async () => {
        const d = app.doc;
        const ok = await app.dialogs.confirm(`Discard all changes to "${d.name}" and reload it from disk?`, { title: 'Revert', okLabel: 'Revert', danger: true });
        if (!ok) return;
        const path = d.path;
        await app.docs.close(d, { force: true });
        await app.docs.openPaths([path]);
      },
    },
    'file:reveal': { enabled: () => !!app.doc?.path, run: () => bridge.showItemInFolder(app.doc.path) },
    'file:quit': { run: () => bridge.closeWindow() },

    // history
    'edit:undo': {
      run: () => {
        if (isTextTarget()) return bridge.nativeEdit('undo');
        if (app.tools?.active?.cancel?.()) return;
        app.doc?.history.undo();
      },
    },
    'edit:redo': {
      run: () => {
        if (isTextTarget()) return bridge.nativeEdit('redo');
        app.doc?.history.redo();
      },
    },
    'edit:step-backward': { enabled: () => !!app.doc?.history.canUndo, run: () => app.doc.history.undo() },
    'edit:step-forward': { enabled: () => !!app.doc?.history.canRedo, run: () => app.doc.history.redo() },
    'edit:preferences': { run: () => app.preferencesDialog?.() },

    // view
    'view:zoom-in': { enabled: has, run: () => app.view.zoomStep(1) },
    'view:zoom-out': { enabled: has, run: () => app.view.zoomStep(-1) },
    'view:zoom-fit': { enabled: has, run: () => app.view.zoomToFit() },
    'view:zoom-fill': { enabled: has, run: () => app.view.zoomToFill() },
    'view:zoom-100': { enabled: has, run: () => app.view.setZoom(1) },
    'view:zoom-200': { enabled: has, run: () => app.view.setZoom(2) },
    'view:set-zoom': { enabled: has, run: (z) => app.view.setZoom(Number(z) / (Number(z) > 64 ? 100 : 1)) },
    'view:rotate': { enabled: has, run: (deg) => app.view.setRotation(deg === 'reset' ? 0 : app.view.rotation + Number(deg || 0)) },
    'view:rulers': { checked: () => app.settings.showRulers !== false, run: () => toggleSetting('showRulers', true) },
    'view:grid': { checked: () => !!app.settings.showGrid, run: () => toggleSetting('showGrid', false) },
    'view:guides': { checked: () => app.settings.showGuides !== false, run: () => toggleSetting('showGuides', true) },
    'view:pixel-grid': { checked: () => app.settings.pixelGrid !== false, run: () => toggleSetting('pixelGrid', true) },
    'view:snap': { checked: () => app.settings.snap !== false, run: () => toggleSetting('snap', true) },
    'view:extras': { checked: () => app.settings.showSelectionEdges !== false, run: () => toggleSetting('showSelectionEdges', true) },
    'view:new-guide': {
      enabled: has,
      run: async (arg) => {
        let g = arg;
        if (!g) {
          const v = await app.dialogs.prompt('Position (pixels). Prefix with "h" for a horizontal guide, e.g. h200', { title: 'New Guide', value: String(Math.round(app.doc.width / 2)) });
          if (v === null) return;
          const m = /^\s*([hv]?)\s*(-?[\d.]+)/i.exec(v);
          if (!m) return;
          g = { axis: m[1].toLowerCase() === 'h' ? 'y' : 'x', pos: Number(m[2]) };
        }
        addGuide(app, g);
      },
    },
    'view:clear-guides': {
      enabled: () => !!app.doc?.guides.length,
      run: () => {
        const d = app.doc;
        const before = d.guides.slice();
        const set = (g) => {
          d.guides = g.slice();
          d.changed('guides');
        };
        set([]);
        d.history.push({ label: 'Clear guides', undo: () => set(before), redo: () => set([]), bytes: 0, at: Date.now() });
      },
    },
    'view:fullscreen': { run: async () => bridge.setFullScreen(!(await bridge.isFullScreen())) },
    'view:theme': { run: (t) => app.saveSettings({ theme: t }) },
    'view:next-tab': { run: () => app.docs.next(1) },
    'view:prev-tab': { run: () => app.docs.next(-1) },
    'window:toggle-panels': {
      run: () => {
        const appEl = document.getElementById('app');
        appEl.classList.toggle('panels-hidden');
        requestAnimationFrame(() => app.view?.resize());
      },
    },
    'window:reset-workspace': {
      run: () => {
        app.panels.reset();
        document.getElementById('app').classList.remove('panels-hidden');
        requestAnimationFrame(() => app.view?.resize());
      },
    },

    // colours and brush shortcuts
    'tool:swap-colors': { run: () => app.setColors({ foreground: app.settings.background, background: app.settings.foreground }) },
    'tool:default-colors': { run: () => app.setColors({ foreground: '#000000', background: '#ffffff' }) },
    'tool:pick-fg': {
      run: async () => {
        const c = await app.pickColor?.(app.settings.foreground, { title: 'Color Picker (Foreground Color)' });
        if (c) app.setColors({ foreground: c });
      },
    },
    'tool:pick-bg': {
      run: async () => {
        const c = await app.pickColor?.(app.settings.background, { title: 'Color Picker (Background Color)' });
        if (c) app.setColors({ background: c });
      },
    },
    'tool:fg-color': { run: (hex) => app.setColors({ foreground: hex }) },
    'tool:bg-color': { run: (hex) => app.setColors({ background: hex }) },
    'tool:brush-size-up': { run: () => adjustBrush('size', +1) },
    'tool:brush-size-down': { run: () => adjustBrush('size', -1) },
    'tool:brush-hardness-up': { run: () => adjustBrush('hardness', +1) },
    'tool:brush-hardness-down': { run: () => adjustBrush('hardness', -1) },
    'tool:select': { run: (id) => app.tools.activate(id) },

    'app:escape': {
      run: () => {
        if (app.dialogs.activePopover) return app.dialogs.closePopover();
        if (app.tools?.active?.cancel?.()) return;
        if (app.view?.maskView) {
          app.view.maskView = false;
          app.view.invalidate();
        }
      },
    },
    'app:enter': { run: () => app.tools?.active?.commit?.() },

    'help:shortcuts': { run: () => shortcutsDialog(app) },
    'help:about': { run: () => aboutDialog(app) },
    'help:guide': { run: () => bridge.openExternal('https://github.com/Nihalpi1212/claude/blob/claude/fervent-newton-263lz3/pigment/docs/USER-GUIDE.md').catch(() => {}) },
    'help:website': { run: () => bridge.openExternal('https://github.com/Nihalpi1212/claude').catch(() => {}) },
    'help:devtools': { run: () => {} },
  });

  function toggleSetting(key, def) {
    const value = !(app.settings[key] ?? def);
    app.saveSettings({ [key]: value });
    app.view?.el.classList.toggle('no-rulers', key === 'showRulers' ? !value : app.view?.el.classList.contains('no-rulers'));
    if (key === 'showRulers') requestAnimationFrame(() => app.view?.resize());
    app.view?.invalidate();
    app.commands.invalidate();
    app.syncUiState();
  }

  function adjustBrush(key, dir) {
    const tool = app.tools?.active;
    if (!tool || !tool.options.some((o) => o.key === key)) return;
    const v = tool.opt(key);
    if (key === 'size') {
      const step = v < 10 ? 1 : v < 50 ? 5 : v < 100 ? 10 : v < 300 ? 25 : 50;
      tool.setOpt('size', Math.max(1, Math.min(2500, v + dir * step)));
    } else tool.setOpt('hardness', Math.round(Math.max(0, Math.min(1, v + dir * 0.25)) * 100) / 100);
  }
}

export function addGuide(app, g) {
  const d = app.doc;
  if (!d) return;
  const before = d.guides.slice();
  const after = [...before, { axis: g.axis === 'y' ? 'y' : 'x', pos: Math.round(g.pos) }];
  const set = (list) => {
    d.guides = list.slice();
    d.changed('guides');
  };
  set(after);
  d.history.push({ label: 'New guide', undo: () => set(before), redo: () => set(after), bytes: 0, at: Date.now() });
}

function shortcutsDialog(app) {
  const content = document.createElement('div');
  content.style.maxHeight = '60vh';
  content.style.overflow = 'auto';
  const table = document.createElement('table');
  table.className = 'kbd-table';
  for (const group of SHORTCUT_GROUPS) {
    const head = document.createElement('tr');
    head.innerHTML = `<th colspan="2">${group.title}</th>`;
    table.appendChild(head);
    for (const cmd of group.commands) {
      const keys = [MENU_KEYS[cmd], ...(RENDERER_KEYS[cmd] ?? [])].filter(Boolean);
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

function aboutDialog(app) {
  const content = document.createElement('div');
  content.innerHTML = `<div style="display:flex;gap:16px;align-items:center"><img src="/build/icon.png" alt="" width="64" height="64" onerror="this.remove()"><div><h2 style="margin:0">Pigment</h2><p class="muted" style="margin:4px 0">Version ${bridge.version}</p><p style="margin:4px 0">A free, open-source image editor: layers, masks, brushes, selections, adjustments, filters, layer styles, text, shapes and PSD files.</p><p class="muted" style="margin:4px 0">MIT License.</p></div></div>`;
  return app.dialogs.open({ title: 'About Pigment', content, width: 480, buttons: [{ label: 'OK', value: true, primary: true }] });
}

// ---- status bar ---------------------------------------------------------------------------------------------
function setupStatusbar(app) {
  const zoom = document.createElement('span');
  zoom.className = 'status-zoom';
  zoom.innerHTML = `<input class="input" type="text" aria-label="Zoom" title="Zoom (type a percentage)">%`;
  const input = zoom.querySelector('input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const v = parseFloat(input.value);
      if (Number.isFinite(v) && v > 0) app.view?.setZoom(v / 100);
      input.blur();
    }
    e.stopPropagation();
  });
  app.statusbar.set('zoom', zoom);
  const update = () => {
    const d = app.doc;
    if (!d) {
      app.statusbar.clear('zoom');
      app.statusbar.clear('size');
      app.statusbar.clear('pos');
      return;
    }
    app.statusbar.set('zoom', zoom);
    if (document.activeElement !== input) input.value = String(Math.round(d.view.zoom * 1000) / 10);
    app.statusbar.set('size', `${d.width} × ${d.height} px · ${d.dpi} ppi · ${d.layers().length} layer${d.layers().length === 1 ? '' : 's'}`);
  };
  app.on('view:changed', () => {
    update();
    app.docs.renderTabs();
  });
  app.on('doc:activated', update);
  app.on('doc:change', (e) => {
    if (e.kind === 'tree' || e.kind === 'canvas') update();
  });
  app.on('pointer:moved', ({ x, y }) => {
    const d = app.doc;
    if (!d) return;
    const inside = x >= 0 && y >= 0 && x < d.width && y < d.height;
    app.statusbar.set('pos', inside ? `X ${Math.floor(x)}  Y ${Math.floor(y)}` : '', { right: true });
  });
}

// ---- host events ----------------------------------------------------------------------------------------------
function setupHostEvents(app) {
  bridge.on('command', (cmd, arg) => app.commands.run(cmd, arg, 'menu'));
  bridge.on('open-files', (paths) => app.commands.run('file:open-paths', paths, 'api'));
  bridge.on('theme', ({ dark }) => {
    if (app.settings.theme === 'system') {
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      app.emit('theme:changed', { dark });
      app.view?.invalidate();
    }
  });
  bridge.on('fullscreen', ({ fullScreen }) => document.body.classList.toggle('fullscreen', !!fullScreen));
  bridge.on('before-close', async ({ quitting } = {}) => {
    bridge.closeAck?.();
    try {
      for (const d of app.docs.list()) {
        if (!(await app.docs.confirmDiscard(d))) {
          bridge.respondClose(false, !!quitting);
          return;
        }
      }
    } catch (err) {
      console.warn('before-close', err);
    }
    bridge.respondClose(true, !!quitting);
  });
}

// ---- drag and drop ----------------------------------------------------------------------------------------------
function setupDragAndDrop(app) {
  let overlay = null;
  let depth = 0;
  const show = () => {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'drop-overlay';
    overlay.textContent = app.doc ? 'Drop to open (hold Shift to place as a layer)' : 'Drop images to open them';
    document.body.appendChild(overlay);
  };
  const hide = () => {
    overlay?.remove();
    overlay = null;
    depth = 0;
  };
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    depth++;
    show();
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) hide();
  });
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
  });
  window.addEventListener('drop', async (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    hide();
    const files = [...e.dataTransfer.files];
    const paths = files.map((f) => bridge.pathForFile(f)).filter(Boolean);
    if (e.shiftKey && app.doc) {
      for (const p of paths) await app.commands.run('file:place', p, 'api');
      return;
    }
    app.commands.run('file:open-paths', paths, 'api');
  });
}

// ---- startup ------------------------------------------------------------------------------------------------------
async function start() {
  const app = new App();
  window.pigmentApp = app;
  document.body.classList.add(`platform-${platform}`);
  try {
    app.settings = withDefaults(await bridge.getSettings());
  } catch (err) {
    console.warn('settings unavailable', err);
  }
  await app.applyTheme();
  app.tools = new ToolManager(app);
  app.panels = new PanelDock(app);
  app.docs = new DocumentManager(app);
  registerCoreCommands(app);
  setupStatusbar(app);
  setupHostEvents(app);
  setupDragAndDrop(app);
  app.docs.renderTabs();
  for (const path of MODULES) {
    try {
      const mod = await import(`./${path}`);
      await mod.install?.(app);
    } catch (err) {
      console.error(`Module ${path} failed to load`, err);
    }
  }
  app.tools.renderToolbox();
  const firstTool = app.settings.lastTool && app.tools.get(app.settings.lastTool) ? app.settings.lastTool : 'move';
  app.tools.activate(app.tools.get(firstTool) ? firstTool : [...app.tools.tools.keys()][0]);
  app.on('tool:changed', ({ tool }) => app.saveSettingsSoon({ lastTool: tool.id }));
  app.on('doc:change', () => app.syncUiState());
  app.on('selection:changed', () => app.commands.invalidate());
  app.on('layer:activated', () => {
    app.commands.invalidate();
    app.syncUiState();
  });
  app.on('settings:changed', () => app.syncUiState());
  app.on('commands:changed', () => app.syncUiState());
  window.addEventListener('resize', () => app.view?.resize());
  document.getElementById('welcome').hidden = false;
  document.getElementById('canvas-host').hidden = true;
  app.syncUiState();
  const startup = await bridge.getStartupFiles().catch(() => []);
  if (startup?.length) await app.docs.openPaths(startup);
  document.body.dataset.ready = 'true';
  app.emit('app:ready');
  void isElectron;
  void icon;
  void Selection;
}

start().catch((err) => {
  console.error('Pigment failed to start', err);
  document.body.dataset.ready = 'error';
  const pre = document.createElement('pre');
  pre.style.cssText = 'padding:20px;color:#c00;white-space:pre-wrap';
  pre.textContent = `Pigment failed to start:\n${err?.stack ?? err}`;
  document.body.appendChild(pre);
});
