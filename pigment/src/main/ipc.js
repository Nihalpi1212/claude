// ipcMain handlers backing the preload bridge. Channel names: pigment:<method>; events to the
// renderer: pigment:event:<channel>. Every handler validates its arguments because the renderer is
// sandboxed and untrusted by design.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { basename, dirname } from 'node:path';
import { addRecent, removeRecent } from './recent.js';
import { OPEN_DIALOG_FILTERS } from '../shared/formats.js';
import { writeClipboardText, writeClipboardImage, readClipboardImage } from './clipboard.js';

const DEFAULT_FILTERS = OPEN_DIALOG_FILTERS;

const EDIT_ACTIONS = new Set(['undo', 'redo', 'cut', 'copy', 'paste', 'delete', 'selectAll']);

function assertString(value, what) {
  if (typeof value !== 'string' || !value) throw new Error(`${what} must be a non-empty string`);
  return value;
}

function toUint8(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new Error('Expected binary data');
}

/**
 * @param {object} ctx
 * @param {typeof import('electron')} ctx.electron
 * @param {import('./settings-store.js').JsonStore} ctx.settings
 * @param {import('./settings-store.js').JsonStore} ctx.recent
 * @param {import('./watch.js').FileWatcher} ctx.watcher
 * @param {() => import('electron').BrowserWindow | null} ctx.getWindow
 * @param {() => void} ctx.updateMenu
 * @param {{ files: string[], rendererReady: boolean }} ctx.startup
 * @param {{ current: object }} ctx.uiState
 * @param {(allow: boolean, quit: boolean) => void} ctx.onCloseResponse
 * @param {() => void} [ctx.onCloseAck]   renderer acknowledged 'before-close' (it is alive and prompting)
 */
export function registerIpc(ctx) {
  const { electron, settings, recent, watcher, getWindow, updateMenu, startup, uiState } = ctx;
  const { ipcMain, dialog, shell, clipboard, nativeImage, nativeTheme, app } = electron;

  const handle = (method, fn) => ipcMain.handle(`pigment:${method}`, (event, ...args) => fn(...args, event));
  const on = (method, fn) => ipcMain.on(`pigment:${method}`, (event, ...args) => fn(...args, event));

  ipcMain.on('pigment:bootstrap', (event) => {
    let userName = '';
    try {
      userName = os.userInfo().username ?? '';
    } catch {
      /* ignore */
    }
    event.returnValue = { version: app.getVersion(), isPackaged: app.isPackaged, userName };
  });

  // ---- files -----------------------------------------------------------------------------------
  handle('openFileDialog', async (opts = {}) => {
    const win = getWindow();
    const result = await dialog.showOpenDialog(win ?? undefined, {
      title: typeof opts.title === 'string' ? opts.title : 'Open',
      properties: ['openFile', ...(opts.multiple ? ['multiSelections'] : [])],
      filters: Array.isArray(opts.filters) && opts.filters.length ? opts.filters : DEFAULT_FILTERS,
    });
    return result.canceled ? [] : result.filePaths;
  });

  handle('saveFileDialog', async (opts = {}) => {
    const win = getWindow();
    const result = await dialog.showSaveDialog(win ?? undefined, {
      title: typeof opts.title === 'string' ? opts.title : 'Save',
      defaultPath: typeof opts.defaultPath === 'string' ? opts.defaultPath : undefined,
      filters: Array.isArray(opts.filters) && opts.filters.length ? opts.filters : DEFAULT_FILTERS,
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    return result.canceled || !result.filePath ? null : result.filePath;
  });

  handle('openDirectoryDialog', async (opts = {}) => {
    const win = getWindow();
    const result = await dialog.showOpenDialog(win ?? undefined, { title: typeof opts.title === 'string' ? opts.title : 'Choose a folder', properties: ['openDirectory', 'createDirectory'] });
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
  });

  handle('readFile', async (path) => {
    assertString(path, 'path');
    const buffer = await fs.readFile(path);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  });

  handle('writeFile', async (path, data) => {
    assertString(path, 'path');
    const bytes = toUint8(data);
    // Write next to the target and rename so a crash never leaves a truncated file behind.
    const tmp = `${path}.pigment-${process.pid}-${Date.now()}.tmp`;
    try {
      await fs.writeFile(tmp, bytes);
      await fs.rename(tmp, path);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      // Some locations (network shares, locked files) refuse renames; fall back to a direct write.
      if (err && (err.code === 'EPERM' || err.code === 'EXDEV' || err.code === 'EBUSY')) {
        await fs.writeFile(path, bytes);
      } else {
        throw new Error(`Could not save "${basename(path)}": ${err.message}`);
      }
    }
    await watcher.markSelfWrite(path);
  });

  handle('pathInfo', async (path) => {
    assertString(path, 'path');
    const stat = await fs.stat(path);
    return { path, name: basename(path), dir: dirname(path), size: stat.size, mtimeMs: stat.mtimeMs };
  });

  on('showItemInFolder', (path) => {
    if (typeof path === 'string' && path) shell.showItemInFolder(path);
  });

  handle('openExternal', async (url) => {
    assertString(url, 'url');
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('Invalid link');
    }
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) throw new Error(`Links of type ${parsed.protocol} are not allowed`);
    await shell.openExternal(parsed.href);
  });

  handle('showMessage', async (opts = {}) => {
    const win = getWindow();
    const result = await dialog.showMessageBox(win ?? undefined, {
      type: ['none', 'info', 'error', 'question', 'warning'].includes(opts.type) ? opts.type : 'info',
      title: typeof opts.title === 'string' ? opts.title : 'Pigment',
      message: String(opts.message ?? ''),
      detail: typeof opts.detail === 'string' ? opts.detail : undefined,
      buttons: Array.isArray(opts.buttons) && opts.buttons.length ? opts.buttons.map(String) : ['OK'],
      defaultId: Number.isInteger(opts.defaultId) ? opts.defaultId : 0,
      cancelId: Number.isInteger(opts.cancelId) ? opts.cancelId : undefined,
      checkboxLabel: typeof opts.checkboxLabel === 'string' ? opts.checkboxLabel : undefined,
      noLink: true,
    });
    return { response: result.response, checkboxChecked: !!result.checkboxChecked };
  });

  // ---- settings and recent files ---------------------------------------------------------------
  handle('getSettings', async () => settings.get());
  handle('setSettings', async (patch) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Settings patch must be an object');
    const next = await settings.patch(patch);
    if (typeof patch.theme === 'string') nativeTheme.themeSource = ['light', 'dark'].includes(patch.theme) ? patch.theme : 'system';
    updateMenu();
    return next;
  });

  handle('getRecent', async () => recent.get());
  handle('addRecent', async (entry) => {
    if (!entry || typeof entry.path !== 'string') throw new Error('Recent entry needs a path');
    const limit = settings.get().recentLimit ?? 20;
    const next = await recent.set(addRecent(recent.get(), entry, limit));
    try {
      app.addRecentDocument(entry.path);
    } catch {
      /* not supported on this platform */
    }
    updateMenu();
    return next;
  });
  handle('removeRecent', async (path) => {
    const next = await recent.set(removeRecent(recent.get(), path));
    updateMenu();
    return next;
  });
  handle('clearRecent', async () => {
    await recent.set([]);
    try {
      app.clearRecentDocuments();
    } catch {
      /* ignore */
    }
    updateMenu();
  });

  handle('getStartupFiles', async (event) => {
    startup.rendererReady = true;
    const files = startup.files.splice(0);
    // menu commands issued while no window existed (macOS) run once the renderer listens
    const pending = Array.isArray(startup.commands) ? startup.commands.splice(0) : [];
    if (pending.length) {
      setImmediate(() => {
        for (const { cmd, arg } of pending) if (!event.sender.isDestroyed()) event.sender.send('pigment:event:command', cmd, arg);
      });
    }
    return files;
  });

  // ---- window and ui state ----------------------------------------------------------------------
  on('setUiState', (state) => {
    if (!state || typeof state !== 'object') return;
    uiState.current = { ...uiState.current, ...state };
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      const title = typeof state.title === 'string' && state.title ? state.title : 'Pigment';
      const dirty = !!state.dirty;
      win.setTitle(state.hasDocument ? `${dirty ? '• ' : ''}${title} — Pigment` : 'Pigment');
      if (process.platform === 'darwin') {
        win.setDocumentEdited(!!state.hasDocument && dirty);
        win.setRepresentedFilename(typeof state.path === 'string' ? state.path : '');
      }
    }
    updateMenu();
  });

  handle('setFullScreen', async (flag) => {
    const win = getWindow();
    if (win) win.setFullScreen(!!flag);
  });
  handle('isFullScreen', async () => !!getWindow()?.isFullScreen());

  on('closeWindow', () => getWindow()?.close());
  on('respondClose', (allow, quit) => ctx.onCloseResponse(allow === true, quit === true));
  on('closeAck', () => ctx.onCloseAck?.());

  handle('setTheme', async (theme) => {
    nativeTheme.themeSource = ['light', 'dark'].includes(theme) ? theme : 'system';
    return nativeTheme.shouldUseDarkColors;
  });
  handle('getSystemDark', async () => nativeTheme.shouldUseDarkColors);

  on('nativeEdit', (action) => {
    const win = getWindow();
    if (!win || !EDIT_ACTIONS.has(action)) return;
    win.webContents[action]();
  });

  // ---- printing --------------------------------------------------------------------------------
  handle('print', (opts = {}) => {
    const win = getWindow();
    if (!win) return { ok: false, reason: 'No window' };
    const options = { silent: !!opts.silent, printBackground: opts.printBackground !== false };
    if (typeof opts.deviceName === 'string') options.deviceName = opts.deviceName;
    if (typeof opts.landscape === 'boolean') options.landscape = opts.landscape;
    if (Number.isInteger(opts.copies) && opts.copies > 0) options.copies = opts.copies;
    if (Array.isArray(opts.pageRanges)) options.pageRanges = opts.pageRanges.filter((r) => r && Number.isInteger(r.from) && Number.isInteger(r.to));
    if (opts.margins && typeof opts.margins === 'object') options.margins = opts.margins;
    return new Promise((resolve) => {
      try {
        win.webContents.print(options, (success, failureReason) => resolve({ ok: success, reason: success ? undefined : failureReason }));
      } catch (err) {
        resolve({ ok: false, reason: err.message });
      }
    });
  });

  handle('printToPDF', async (opts = {}) => {
    const win = getWindow();
    if (!win) throw new Error('No window');
    const buffer = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, ...(opts && typeof opts === 'object' ? opts : {}) });
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  });

  handle('getPrinters', async () => {
    const win = getWindow();
    if (!win) return [];
    const printers = await win.webContents.getPrintersAsync();
    return printers.map((p) => ({ name: p.name, displayName: p.displayName, isDefault: !!p.isDefault }));
  });

  // ---- clipboard -------------------------------------------------------------------------------
  on('writeClipboardText', (text) => {
    writeClipboardText(clipboard, text).catch((err) => console.warn('clipboard text write failed', err));
  });
  handle('readClipboardImage', async () => readClipboardImage(clipboard, nativeImage));

  on('writeClipboardImage', (dataUrl) => {
    writeClipboardImage(clipboard, nativeImage, dataUrl).catch((err) => console.warn('clipboard image write failed', err));
  });

  // ---- file watching ---------------------------------------------------------------------------
  handle('watchFile', async (path) => watcher.add(assertString(path, 'path')));
  handle('unwatchFile', async (path) => watcher.remove(assertString(path, 'path')));
}
