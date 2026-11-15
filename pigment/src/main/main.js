// Pigment — Electron main process.
import { screen, app, BrowserWindow, Menu, nativeTheme, protocol, session, shell, ipcMain, dialog, clipboard, nativeImage, safeStorage } from 'electron';
import { promises as fs, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_SCHEME, mimeFor, resolveAppUrl } from './protocol.js';
import { JsonStore } from './settings-store.js';
import { normalizeRecent } from './recent.js';
import { FileWatcher } from './watch.js';
import { registerIpc } from './ipc.js';
import { buildMenuTemplate } from './menu.js';
import { filesFromArgv } from './startup-files.js';
import { withDefaults } from '../shared/defaults.js';
import { parseAccelerator, eventMatches, effectiveKeys, sameAccelerator } from '../shared/keymap.js';

const here = dirname(fileURLToPath(import.meta.url));
const RENDERER_DIR = join(here, '..', 'renderer');
const APP_URL = `${APP_SCHEME}://app/index.html`;
const IS_MAC = process.platform === 'darwin';
// local-fonts lets the Type tool list installed fonts (window.queryLocalFonts)
const ALLOWED_PERMISSIONS = ['fullscreen', 'clipboard-sanitized-write', 'clipboard-read', 'local-fonts'];

app.setName('Pigment');
// Tests and portable setups can point the settings/recent files elsewhere.
if (process.env.PIGMENT_USER_DATA) app.setPath('userData', process.env.PIGMENT_USER_DATA);
if (process.platform === 'win32') app.setAppUserModelId('com.pigmentapp.app');

// The renderer page lives on a privileged scheme so it has a real origin (module workers, fetch,
// import maps, localStorage) without the restrictions of file://.
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
]);

// ---- single instance + files to open ------------------------------------------------------------
const startup = { files: [], commands: [], rendererReady: false };
let mainWindow = null;
let quitting = false;
let closeTimer = null;

function queueFiles(paths) {
  const files = paths.filter((p) => typeof p === 'string' && p);
  if (!files.length) return;
  if (startup.rendererReady && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pigment:event:open-files', files);
  } else {
    startup.files.push(...files);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    queueFiles(filesFromArgv(argv, { isPackaged: app.isPackaged, cwd: workingDirectory, exists: existsSync }));
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else if (app.isReady()) {
      createWindow();
    }
  });
}

app.on('open-file', (event, path) => {
  event.preventDefault();
  queueFiles([path]);
  if (app.isReady() && (!mainWindow || mainWindow.isDestroyed())) createWindow();
});

queueFiles(filesFromArgv(process.argv, { isPackaged: app.isPackaged, cwd: process.cwd(), exists: existsSync }));

// ---- persistence ------------------------------------------------------------------------------------
const userData = () => app.getPath('userData');
const settings = new JsonStore(join(userData(), 'settings.json'), withDefaults);
const recent = new JsonStore(join(userData(), 'recent.json'), normalizeRecent);
const watcher = new FileWatcher((path) => mainWindow?.webContents.send('pigment:event:file-changed', { path }));
const uiState = { current: {} };

// ---- menu --------------------------------------------------------------------------------------------
/**
 * Sends a menu command to the renderer. The third value tells the renderer where it came from (M.1, O):
 * true for the item's accelerator (source 'menu-key'), false for a mouse click ('menu'), 'key' for a key
 * main.js intercepted before the page saw it (Shift+Alt+letter on Windows and Linux).
 */
function runCommand(cmd, arg, via = false) {
  const hasWindow = mainWindow && !mainWindow.isDestroyed();
  if (cmd === 'help:devtools') {
    if (hasWindow) mainWindow.webContents.toggleDevTools();
    return;
  }
  if (!hasWindow || !startup.rendererReady) {
    // No window (macOS after closing it) or a renderer that is still loading: queue the command;
    // getStartupFiles delivers it once the renderer listens (the load event fires before the
    // renderer has attached its handlers). Recent files go through the file queue.
    if (cmd === 'file:open-recent' && typeof arg === 'string') queueFiles([arg]);
    else startup.commands.push({ cmd, arg, via });
    if (!hasWindow && app.isReady()) createWindow();
    return;
  }
  mainWindow.webContents.send('pigment:event:command', cmd, arg, via);
}

// 0.5 (ARCHITECTURE.md "0.5 features", S9.4): the keymap the menu and the Shift+Alt keys follow. The renderer reports
// the resolved overlay (its user keys minus the keys actions own) as a JSON string in the ui state; before the first
// ui state, settings.keymap.overlay (the actions' keys follow with the first ui state).
function keymapJson() {
  return typeof uiState.current.keymap === 'string' ? uiState.current.keymap : JSON.stringify(settings.get().keymap?.overlay ?? null);
}
function menusJson() {
  return typeof uiState.current.menus === 'string' ? uiState.current.menus : JSON.stringify(settings.get().keymap?.menus ?? null);
}
function parseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// Shift+Alt+letter (the blend-mode keys) and Shift+Alt+[ / ] share Alt with the menu mnemonics on Windows and
// Linux (&File, &Edit, …): Chromium would open a menu instead of delivering the key. main.js takes these keys
// before the page and the menu see them and runs their command as a key (O). 0.5: from the effective keymap; a
// paint-context key with no global command on the same key (Shift+Alt+Q Behind, Shift+Alt+R Clear) goes as its
// paint command, which the renderer runs only while it is enabled (S13.4)
let shiftAltCache = { json: null, keys: [] };
function shiftAltKeys() {
  const json = keymapJson();
  if (shiftAltCache.json === json) return shiftAltCache.keys;
  const eff = effectiveKeys(parseJson(json));
  const shiftAlt = ({ desc }) => desc.shift && desc.alt && !desc.ctrl && !desc.meta && !desc.cmdOrCtrl;
  const entries = (table) => Object.entries(table).flatMap(([cmd, list]) => list.map((accel) => ({ cmd, accel, desc: parseAccelerator(accel) }))).filter(shiftAlt);
  const global = entries(eff.renderer);
  const paintOnly = entries(eff.paint).filter((p) => !global.some((g) => sameAccelerator(g.accel, p.accel)));
  shiftAltCache = { json, keys: [...global, ...paintOnly] };
  return shiftAltCache.keys;
}

function interceptShiftAlt(event, input) {
  if (IS_MAC || input.type !== 'keyDown' || !input.shift || !input.alt || input.control || input.meta) return;
  const ev = { key: input.key, code: input.code, location: input.location ?? 0, shiftKey: true, altKey: true, ctrlKey: false, metaKey: false };
  const hit = shiftAltKeys().find(({ desc }) => eventMatches(ev, desc, false));
  if (!hit) return;
  event.preventDefault();
  if (!input.isAutoRepeat) runCommand(hit.cmd, undefined, 'key');
}

let menuTimer = null;
function updateMenu() {
  clearTimeout(menuTimer);
  menuTimer = setTimeout(() => {
    const state = { ...uiState.current, keymap: keymapJson(), menus: menusJson() };
    const template = buildMenuTemplate({ platform: process.platform, state, recent: recent.get(), run: (cmd, arg, viaKey) => runCommand(cmd, arg, !!viaKey), isPackaged: app.isPackaged });
    colourIcons(template);
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }, 30);
}

// Coloured menu items (S9.5): the template marks them with pigmentColor; each becomes a 12 px dot icon, made once per
// colour. Photoshop's menu colours.
const MENU_COLOR_RGB = { red: [229, 72, 77], orange: [247, 107, 21], yellow: [245, 196, 0], green: [48, 164, 108], blue: [59, 130, 246], violet: [142, 78, 198], gray: [139, 141, 152] };
const dotIcons = new Map();
function dotIcon(name) {
  if (!dotIcons.has(name)) {
    const [r, g, b] = MENU_COLOR_RGB[name] ?? MENU_COLOR_RGB.gray;
    const size = 12;
    const buf = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // coverage of a 10 px disc, antialiased over one pixel
        const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
        const a = Math.max(0, Math.min(1, 5.5 - d));
        const i = (y * size + x) * 4;
        // BGRA, premultiplied (what nativeImage.createFromBitmap reads)
        buf[i] = Math.round(b * a);
        buf[i + 1] = Math.round(g * a);
        buf[i + 2] = Math.round(r * a);
        buf[i + 3] = Math.round(255 * a);
      }
    }
    dotIcons.set(name, nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 1 }));
  }
  return dotIcons.get(name);
}
function colourIcons(list) {
  for (const it of list) {
    if (it.pigmentColor) {
      it.icon = dotIcon(it.pigmentColor);
      delete it.pigmentColor;
    }
    if (Array.isArray(it.submenu)) colourIcons(it.submenu);
  }
}

// ---- window ------------------------------------------------------------------------------------------
/**
 * Saved bounds are only reused when enough of the window's title bar (a 100×20 px piece of its top
 * strip) is on a connected display's work area, so the window can always be grabbed and moved.
 */
function visibleBounds(b) {
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width <= 0 || b.height <= 0) return null;
  const strip = { x: b.x, y: b.y, width: b.width, height: Math.min(40, b.height) };
  const grabbable = screen.getAllDisplays().some(({ workArea: a }) => {
    const w = Math.min(strip.x + strip.width, a.x + a.width) - Math.max(strip.x, a.x);
    const h = Math.min(strip.y + strip.height, a.y + a.height) - Math.max(strip.y, a.y);
    return w >= Math.min(100, strip.width) && h >= Math.min(20, strip.height);
  });
  return grabbable ? b : null;
}

async function createWindow() {
  startup.rendererReady = false; // files/commands arriving while this renderer loads are queued
  const saved = settings.get().windowBounds;
  const bounds = visibleBounds(saved);
  // cap the size to the display the window will appear on (not necessarily the primary one)
  const work = (bounds ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay()).workArea;
  const win = new BrowserWindow({
    width: Math.min(bounds?.width ?? saved?.width ?? 1280, work.width),
    height: Math.min(bounds?.height ?? saved?.height ?? 860, work.height),
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1b1f' : '#f4f4f6',
    title: 'Pigment',
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    trafficLightPosition: IS_MAC ? { x: 14, y: 14 } : undefined,
    icon: IS_MAC ? undefined : join(here, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: join(here, '..', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      backgroundThrottling: false,
    },
  });
  mainWindow = win;

  win.once('ready-to-show', () => {
    if (saved?.maximized) win.maximize();
    win.show();
  });

  // No navigation away from the app page, and no popups: external links go to the system browser.
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${APP_SCHEME}://app/`)) {
      event.preventDefault();
      openExternalSafely(url);
    }
  });
  win.webContents.on('before-input-event', interceptShiftAlt);
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: 'deny' };
  });

  win.on('close', (event) => {
    if (win.allowClose) {
      saveWindowBounds(win);
      return;
    }
    event.preventDefault();
    saveWindowBounds(win);
    if (win.webContents.isCrashed() || win.webContents.isLoading()) {
      win.allowClose = true;
      win.close();
      return;
    }
    if (win.closePending) return; // the renderer is already prompting; ignore repeated close requests
    win.closePending = true;
    win.webContents.send('pigment:event:before-close', { quitting });
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      // The renderer never acknowledged the request (hung before it could prompt): do not trap the
      // user in an unclosable window. Once acknowledged there is no time limit, because the
      // renderer may be waiting on the user ("Save changes?") or on a long save.
      win.allowClose = true;
      win.close();
    }, 8000);
  });
  const forceClose = () => {
    clearTimeout(closeTimer);
    if (win.isDestroyed()) return;
    win.allowClose = true;
    win.close();
  };
  win.webContents.on('render-process-gone', async (_event, details) => {
    if (win.isDestroyed()) return;
    if (win.closePending) return forceClose(); // it died while we were waiting for its answer
    // A crash with no close pending: offer a reload instead of silently losing the window (and, on
    // Windows/Linux, the whole app through window-all-closed).
    const { response } = await dialog.showMessageBox(win, {
      type: 'error',
      message: 'The document view stopped working',
      detail: `Reason: ${details?.reason ?? 'unknown'}. Reload it to continue (unsaved changes are lost), or close the window.`,
      buttons: ['Reload', 'Close Window'],
      defaultId: 0,
      cancelId: 1,
    });
    if (win.isDestroyed()) return;
    if (response === 0) {
      startup.rendererReady = false;
      win.webContents.reload();
    } else forceClose();
  });
  win.webContents.on('unresponsive', () => {
    if (win.closePending) forceClose();
  });
  win.on('closed', () => {
    clearTimeout(closeTimer);
    if (mainWindow === win) mainWindow = null;
    watcher.close();
    // the menu must not keep offering document commands for a window that no longer exists
    uiState.current = {};
    updateMenu();
  });
  win.on('enter-full-screen', () => win.webContents.send('pigment:event:fullscreen', { fullScreen: true }));
  win.on('leave-full-screen', () => win.webContents.send('pigment:event:fullscreen', { fullScreen: false }));

  await win.loadURL(APP_URL);
  updateMenu();
  return win;
}

function saveWindowBounds(win) {
  try {
    const maximized = win.isMaximized();
    const b = maximized ? win.getNormalBounds() : win.getBounds();
    settings.patch({ windowBounds: { x: b.x, y: b.y, width: b.width, height: b.height, maximized } }).catch(() => {});
  } catch {
    /* ignore */
  }
}

function openExternalSafely(url) {
  try {
    const parsed = new URL(url);
    if (['http:', 'https:', 'mailto:'].includes(parsed.protocol)) shell.openExternal(parsed.href);
  } catch {
    /* ignore */
  }
}

function onCloseAck() {
  // The renderer received 'before-close' and is prompting/saving: wait for its answer however long it takes.
  clearTimeout(closeTimer);
  closeTimer = null;
}

function onCloseResponse(allow, quit) {
  clearTimeout(closeTimer);
  closeTimer = null;
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  win.closePending = false;
  if (allow) {
    win.allowClose = true;
    win.close();
    if (quit) app.quit();
  } else {
    quitting = false;
    win.allowClose = false;
  }
}

// ---- app lifecycle ------------------------------------------------------------------------------------
app.whenReady().then(async () => {
  await Promise.all([settings.load(), recent.load()]);
  const theme = settings.get().theme;
  nativeTheme.themeSource = ['light', 'dark'].includes(theme) ? theme : 'system';

  protocol.handle(APP_SCHEME, async (request) => {
    const file = resolveAppUrl(request.url, RENDERER_DIR);
    if (!file) return new Response('Not found', { status: 404 });
    try {
      const data = await fs.readFile(file);
      return new Response(data, { headers: { 'Content-Type': mimeFor(file), 'Cache-Control': 'no-cache' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.includes(permission));

  app.setAboutPanelOptions({
    applicationName: 'Pigment',
    applicationVersion: app.getVersion(),
    copyright: 'Free and open source. MIT License.',
    website: 'https://github.com/Nihalpi1212/claude',
    iconPath: join(here, '..', '..', 'build', 'icon.png'),
  });

  registerIpc({
    // safeStorage encrypts the AI credentials with the OS keychain (src/main/ai.js)
    electron: { app, ipcMain, dialog, shell, clipboard, nativeImage, nativeTheme, BrowserWindow, safeStorage },
    settings,
    recent,
    watcher,
    getWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
    updateMenu,
    startup,
    uiState,
    onCloseResponse,
    onCloseAck,
  });

  nativeTheme.on('updated', () => mainWindow?.webContents.send('pigment:event:theme', { dark: nativeTheme.shouldUseDarkColors }));

  updateMenu();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  if (!IS_MAC || quitting) app.quit();
});
