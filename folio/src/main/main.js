// Folio PDF — Electron main process.
import { screen, app, BrowserWindow, Menu, nativeTheme, protocol, session, shell, ipcMain, dialog, clipboard, nativeImage } from 'electron';
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

const here = dirname(fileURLToPath(import.meta.url));
const RENDERER_DIR = join(here, '..', 'renderer');
const APP_URL = `${APP_SCHEME}://app/index.html`;
const IS_MAC = process.platform === 'darwin';

app.setName('Folio PDF');
// Tests and portable setups can point the settings/recent files elsewhere.
if (process.env.FOLIO_USER_DATA) app.setPath('userData', process.env.FOLIO_USER_DATA);
if (process.platform === 'win32') app.setAppUserModelId('com.foliopdf.app');

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
    mainWindow.webContents.send('folio:event:open-files', files);
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
const watcher = new FileWatcher((path) => mainWindow?.webContents.send('folio:event:file-changed', { path }));
const uiState = { current: {} };

// ---- menu --------------------------------------------------------------------------------------------
function runCommand(cmd, arg) {
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
    else startup.commands.push({ cmd, arg });
    if (!hasWindow && app.isReady()) createWindow();
    return;
  }
  mainWindow.webContents.send('folio:event:command', cmd, arg);
}

let menuTimer = null;
function updateMenu() {
  clearTimeout(menuTimer);
  menuTimer = setTimeout(() => {
    const template = buildMenuTemplate({ platform: process.platform, state: uiState.current, recent: recent.get(), run: runCommand, isPackaged: app.isPackaged });
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }, 30);
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
    title: 'Folio PDF',
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
    win.webContents.send('folio:event:before-close', { quitting });
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
  win.on('enter-full-screen', () => win.webContents.send('folio:event:fullscreen', { fullScreen: true }));
  win.on('leave-full-screen', () => win.webContents.send('folio:event:fullscreen', { fullScreen: false }));

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
    callback(['fullscreen', 'clipboard-sanitized-write', 'clipboard-read'].includes(permission));
  });

  app.setAboutPanelOptions({
    applicationName: 'Folio PDF',
    applicationVersion: app.getVersion(),
    copyright: 'Free and open source. MIT License.',
    website: 'https://github.com/Nihalpi1212/claude',
    iconPath: join(here, '..', '..', 'build', 'icon.png'),
  });

  registerIpc({
    electron: { app, ipcMain, dialog, shell, clipboard, nativeImage, nativeTheme, BrowserWindow },
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

  nativeTheme.on('updated', () => mainWindow?.webContents.send('folio:event:theme', { dark: nativeTheme.shouldUseDarkColors }));

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
