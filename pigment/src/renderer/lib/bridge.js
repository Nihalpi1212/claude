// The bridge to the host. In Electron, window.pigment comes from the preload script. In a plain
// browser (Playwright tests, `npm run dev:web`) a compatible in-memory implementation is used so the
// whole UI works without Electron. Renderer code must import `bridge` from here and never touch
// window.pigment directly.
import { DEFAULT_SETTINGS, withDefaults } from '../../shared/defaults.js';

export const isElectron = typeof window !== 'undefined' && !!window.pigment;

function createBrowserBridge() {
  const test = (window.__pigmentTest ||= {});
  test.files ||= {}; // path -> Uint8Array
  test.written ||= {}; // path -> Uint8Array
  test.messages ||= []; // showMessage calls, for assertions
  const listeners = new Map();
  // N: a write that fails returns false and leaves the reason in storage.lastError ('storage-quota' |
  // 'storage-unavailable'); __pigmentTest.failSettingsWrite = 'quota' | 'unavailable' simulates one for settings
  const storage = {
    lastError: null,
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        storage.lastError = null;
        return true;
      } catch (err) {
        storage.lastError = err?.name === 'QuotaExceededError' || err?.code === 22 ? 'storage-quota' : 'storage-unavailable';
        return false;
      }
    },
  };
  const writeError = (code) => {
    const err = new Error(code === 'storage-quota' ? 'The browser storage is full' : 'The browser storage is not available');
    err.code = code;
    return err;
  };
  let settings = withDefaults(storage.get('pigment.settings', {}));
  let recent = storage.get('pigment.recent', []);
  const emit = (channel, ...args) => {
    for (const handler of listeners.get(channel) ?? []) handler(...args);
  };

  async function pickFiles({ multiple = false, accept = 'image/*,.psd,.psb,.pigment' } = {}) {
    if (Array.isArray(test.nextOpenFiles)) {
      const files = test.nextOpenFiles;
      test.nextOpenFiles = null;
      return files;
    }
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.multiple = multiple;
      input.style.display = 'none';
      document.body.appendChild(input);
      input.addEventListener('change', async () => {
        const paths = [];
        for (const file of input.files) {
          const path = `browser:/${file.name}`;
          test.files[path] = new Uint8Array(await file.arrayBuffer());
          paths.push(path);
        }
        input.remove();
        resolve(paths);
      });
      input.addEventListener('cancel', () => {
        input.remove();
        resolve([]);
      });
      input.click();
    });
  }

  function download(name, bytes) {
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  function simpleMessage(opts) {
    if (typeof test.autoRespond === 'function') {
      const answer = test.autoRespond(opts);
      if (answer !== undefined) return Promise.resolve(typeof answer === 'number' ? { response: answer, checkboxChecked: false } : answer);
    }
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'dialog-backdrop';
      backdrop.innerHTML = `<div class="dialog" role="alertdialog" style="max-width:460px"><div class="dialog-body"><p class="dialog-message"></p><p class="dialog-detail muted"></p></div><div class="dialog-buttons"></div></div>`;
      backdrop.querySelector('.dialog-message').textContent = opts.message ?? '';
      backdrop.querySelector('.dialog-detail').textContent = opts.detail ?? '';
      const buttons = (opts.buttons?.length ? opts.buttons : ['OK']).map((label, i) => {
        const b = document.createElement('button');
        b.className = 'btn' + (i === (opts.defaultId ?? 0) ? ' primary' : '');
        b.textContent = label;
        b.addEventListener('click', () => {
          backdrop.remove();
          resolve({ response: i, checkboxChecked: false });
        });
        return b;
      });
      backdrop.querySelector('.dialog-buttons').append(...buttons);
      document.getElementById('dialogs')?.appendChild(backdrop) ?? document.body.appendChild(backdrop);
      buttons[opts.defaultId ?? 0]?.focus();
    });
  }

  const api = {
    platform: 'browser',
    version: '0.1.0-web',
    isPackaged: false,
    userName: '',
    async openFileDialog(opts = {}) {
      const accept = opts.filters?.length ? opts.filters.flatMap((f) => f.extensions.map((e) => (e === '*' ? '' : `.${e}`))).filter(Boolean).join(',') : undefined;
      return pickFiles({ multiple: !!opts.multiple, accept });
    },
    async saveFileDialog(opts = {}) {
      if (typeof test.nextSavePath === 'string') {
        const path = test.nextSavePath;
        test.nextSavePath = null;
        return path;
      }
      const name = (opts.defaultPath ?? 'image.png').split(/[\\/]/).pop();
      const chosen = test.silent ? name : window.prompt('Save as (file name)', name);
      return chosen ? `download:/${chosen}` : null;
    },
    async openDirectoryDialog() {
      return typeof test.nextDirectory === 'string' ? test.nextDirectory : null;
    },
    async readFile(path) {
      if (test.files[path]) return test.files[path];
      const response = await fetch(path);
      if (!response.ok) throw new Error(`Could not read ${path} (${response.status})`);
      return new Uint8Array(await response.arrayBuffer());
    },
    async writeFile(path, data) {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      test.written[path] = bytes;
      if (path.startsWith('download:/')) download(path.slice('download:/'.length), bytes);
      else test.files[path] = bytes;
    },
    /** Folders are synthetic in the browser: every stored file whose path starts with `${dir}/` is listed (one level). */
    async listDir(dir) {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      const seen = new Map();
      for (const path of Object.keys({ ...test.files, ...test.written })) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        const name = slash >= 0 ? rest.slice(0, slash) : rest;
        if (!name || seen.has(name)) continue;
        const bytes = slash >= 0 ? null : test.files[path] ?? test.written[path];
        seen.set(name, { name, path: prefix + name, isDir: slash >= 0, size: bytes?.byteLength ?? 0, mtimeMs: Date.now() });
      }
      return [...seen.values()].sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.isDir ? -1 : 1));
    },
    async makeDir(path) {
      return path;
    },
    async pathInfo(path) {
      const name = path.split(/[\\/]/).pop();
      const bytes = test.files[path] ?? test.written[path];
      if (!bytes) throw new Error(`No such file: ${path}`);
      return { path, name, dir: path.slice(0, Math.max(0, path.length - name.length - 1)), size: bytes?.byteLength ?? 0, mtimeMs: Date.now() };
    },
    pathForFile(file) {
      // Browser drag-and-drop: stash the bytes under a synthetic path, read asynchronously by readFile.
      const path = `browser:/${file.name}`;
      test.pending ||= {};
      test.pending[path] = file.arrayBuffer().then((buf) => {
        test.files[path] = new Uint8Array(buf);
      });
      return path;
    },
    showItemInFolder() {},
    async openExternal(url) {
      window.open(url, '_blank', 'noopener');
    },
    showMessage: simpleMessage,
    async getSettings() {
      return { ...settings };
    },
    async setSettings(patch) {
      // the in-memory copy changes first: the session keeps working when the storage refuses the write (N)
      settings = withDefaults({ ...settings, ...patch });
      const fail = test.failSettingsWrite;
      if (fail === 'quota' || fail === 'unavailable') throw writeError(fail === 'quota' ? 'storage-quota' : 'storage-unavailable');
      if (!storage.set('pigment.settings', settings)) throw writeError(storage.lastError ?? 'storage-unavailable');
      return { ...settings };
    },
    async getRecent() {
      return recent.slice();
    },
    async addRecent(entry) {
      recent = [{ ...recent.find((r) => r.path === entry.path), ...entry, lastOpened: Date.now() }, ...recent.filter((r) => r.path !== entry.path)].slice(0, settings.recentLimit ?? DEFAULT_SETTINGS.recentLimit);
      storage.set('pigment.recent', recent);
      return recent.slice();
    },
    async removeRecent(path) {
      recent = recent.filter((r) => r.path !== path);
      storage.set('pigment.recent', recent);
      return recent.slice();
    },
    async clearRecent() {
      recent = [];
      storage.set('pigment.recent', recent);
    },
    async getStartupFiles() {
      const files = Array.isArray(test.startupFiles) ? test.startupFiles : [];
      test.startupFiles = [];
      return files;
    },
    setUiState(state) {
      test.uiState = { ...(test.uiState ?? {}), ...state };
      document.title = state.hasDocument ? `${state.dirty ? '• ' : ''}${state.title} — Pigment` : 'Pigment';
    },
    async setFullScreen(flag) {
      try {
        if (flag) await document.documentElement.requestFullscreen();
        else if (document.fullscreenElement) await document.exitFullscreen();
      } catch {
        /* not allowed outside a user gesture */
      }
    },
    async isFullScreen() {
      return !!document.fullscreenElement;
    },
    closeWindow() {
      emit('before-close', { quitting: false });
    },
    respondClose(allow, quit) {
      test.closeResponse = allow;
      test.closeQuit = !!quit;
    },
    closeAck() {
      test.closeAcked = true;
    },
    async setTheme(theme) {
      return theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    },
    async getSystemDark() {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    },
    nativeEdit(action) {
      const map = { undo: 'undo', redo: 'redo', cut: 'cut', copy: 'copy', paste: 'paste', delete: 'delete', selectAll: 'selectAll' };
      try {
        document.execCommand(map[action]);
      } catch {
        /* ignore */
      }
    },
    async print() {
      if (test.silent) return { ok: true };
      window.print();
      return { ok: true };
    },
    async printToPDF() {
      throw new Error('Print to PDF is only available in the desktop app');
    },
    async printImage() {
      if (test.silent) return { ok: true };
      window.print();
      return { ok: true };
    },
    // AI in the browser build: lib/ai/client.js talks to the providers directly (keys kept in localStorage)
    ai: null,
    async getPrinters() {
      return [];
    },
    writeClipboardText(text) {
      test.clipboardText = text;
      navigator.clipboard?.writeText(text).catch(() => {});
    },
    writeClipboardImage(dataUrl) {
      test.clipboardImage = dataUrl;
    },
    async readClipboardImage() {
      // the browser build reads the clipboard through navigator.clipboard (see edit-ops.js)
      return null;
    },
    /** The clipboard's text (O): __pigmentTest.clipboardText when it is a string (the specs set it), else the system's. */
    async readClipboardText() {
      if (typeof test.clipboardText === 'string') return test.clipboardText;
      try {
        return (await navigator.clipboard?.readText?.()) ?? '';
      } catch {
        return '';
      }
    },
    presets: browserPresets(test),
    async watchFile() {},
    async unwatchFile() {},
    on(channel, handler) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(handler);
      return () => listeners.get(channel)?.delete(handler);
    },
    // test hooks
    __emit: emit,
  };
  test.bridge = api;
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => emit('theme', { dark: e.matches }));
  return api;
}

/**
 * The preset store's backend in the browser (ARCHITECTURE.md "0.4 features", C): the five methods of the Electron
 * bridge on IndexedDB (database 'pigment-presets', stores 'files' (key: kind) and 'blobs' (key: kind/name)). When
 * window.__pigmentTest.presets is an object the backend reads and writes it instead: { files: { [kind]: json },
 * blobs: { ['kind/name']: Uint8Array } } (specs seed and assert it); __pigmentTest.failPresetWrite = 'quota' makes
 * writes fail. write(kind, null) deletes the kind's file.
 */
const PRESET_KIND = /^[a-z][a-z0-9-]*(:[a-z0-9-]+)?$/;
const BLOB_NAME = /^[A-Za-z0-9._-]{1,128}$/;
function browserPresets(test) {
  let dbPromise = null;
  const db = () => {
    dbPromise ??= new Promise((resolve, reject) => {
      const req = indexedDB.open('pigment-presets', 1);
      req.onupgradeneeded = () => {
        for (const name of ['files', 'blobs']) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB is not available'));
    });
    return dbPromise;
  };
  const run = async (store, mode, fn) => {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      let result;
      if (req) req.onsuccess = () => (result = req.result);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? req?.error);
      tx.onabort = () => reject(tx.error ?? new Error('The preset write was aborted'));
    });
  };
  const memory = () => {
    const m = test.presets;
    if (!m || typeof m !== 'object') return null;
    m.files ??= {};
    m.blobs ??= {};
    return m;
  };
  const checkKind = (kind) => {
    if (typeof kind !== 'string' || !PRESET_KIND.test(kind)) throw new Error(`Invalid preset kind: ${String(kind).slice(0, 64)}`);
  };
  const checkName = (name) => {
    if (typeof name !== 'string' || !BLOB_NAME.test(name) || name === '.' || name === '..') throw new Error(`Invalid preset blob name: ${String(name).slice(0, 64)}`);
  };
  const failing = () => {
    if (test.failPresetWrite !== 'quota' && test.failPresetWrite !== 'unavailable') return;
    const err = new Error(test.failPresetWrite === 'quota' ? 'The browser storage is full' : 'The browser storage is not available');
    err.code = test.failPresetWrite === 'quota' ? 'storage-quota' : 'storage-unavailable';
    throw err;
  };
  const copy = (v) => (v === null || v === undefined ? null : JSON.parse(JSON.stringify(v)));
  return {
    async read(kind) {
      checkKind(kind);
      const m = memory();
      if (m) return copy(m.files[kind] ?? null);
      return copy((await run('files', 'readonly', (s) => s.get(kind))) ?? null);
    },
    async write(kind, json) {
      checkKind(kind);
      if (json !== null && (!json || typeof json !== 'object' || Array.isArray(json))) throw new Error('A presets file must be an object');
      failing();
      const m = memory();
      if (m) {
        if (json === null) delete m.files[kind];
        else m.files[kind] = copy(json);
        return;
      }
      await run('files', 'readwrite', (s) => (json === null ? s.delete(kind) : s.put(copy(json), kind)));
    },
    async readBlob(kind, name) {
      checkKind(kind);
      checkName(name);
      const m = memory();
      const v = m ? m.blobs[`${kind}/${name}`] : await run('blobs', 'readonly', (s) => s.get(`${kind}/${name}`));
      return v ? new Uint8Array(v) : null;
    },
    async writeBlob(kind, name, bytes) {
      checkKind(kind);
      checkName(name);
      failing();
      const data = new Uint8Array(bytes);
      const m = memory();
      if (m) {
        m.blobs[`${kind}/${name}`] = data;
        return;
      }
      await run('blobs', 'readwrite', (s) => s.put(data, `${kind}/${name}`));
    },
    async removeBlob(kind, name) {
      checkKind(kind);
      checkName(name);
      const m = memory();
      if (m) {
        delete m.blobs[`${kind}/${name}`];
        return;
      }
      await run('blobs', 'readwrite', (s) => s.delete(`${kind}/${name}`));
    },
  };
}

export const bridge = isElectron ? window.pigment : createBrowserBridge();
export const platform = bridge.platform;
export const isMac = platform === 'darwin';
export const pathSep = platform === 'win32' ? '\\' : '/';
export const joinPath = (dir, name) => (dir.endsWith(pathSep) ? dir + name : dir + pathSep + name);
