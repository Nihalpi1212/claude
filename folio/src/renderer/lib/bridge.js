// The bridge to the host. In Electron, window.folio comes from the preload script. In a plain
// browser (Playwright tests, `npm run dev:web`) a compatible in-memory implementation is used so the
// whole UI works without Electron. Renderer code must import `bridge` from here and never touch
// window.folio directly.
import { DEFAULT_SETTINGS, withDefaults } from '../../shared/defaults.js';

export const isElectron = typeof window !== 'undefined' && !!window.folio;

function createBrowserBridge() {
  const test = (window.__folioTest ||= {});
  test.files ||= {}; // path -> Uint8Array
  test.written ||= {}; // path -> Uint8Array
  test.messages ||= []; // showMessage calls, for assertions
  const listeners = new Map();
  const storage = {
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
      } catch {
        /* storage unavailable */
      }
    },
  };
  let settings = withDefaults(storage.get('folio.settings', {}));
  let recent = storage.get('folio.recent', []);
  const emit = (channel, ...args) => {
    for (const handler of listeners.get(channel) ?? []) handler(...args);
  };

  async function pickFiles({ multiple = false, accept = '.pdf,application/pdf' } = {}) {
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
    const blob = new Blob([bytes], { type: name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream' });
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
      const name = (opts.defaultPath ?? 'document.pdf').split(/[\\/]/).pop();
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
    async pathInfo(path) {
      const name = path.split(/[\\/]/).pop();
      const bytes = test.files[path];
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
      settings = withDefaults({ ...settings, ...patch });
      storage.set('folio.settings', settings);
      return { ...settings };
    },
    async getRecent() {
      return recent.slice();
    },
    async addRecent(entry) {
      recent = [{ ...recent.find((r) => r.path === entry.path), ...entry, lastOpened: Date.now() }, ...recent.filter((r) => r.path !== entry.path)].slice(0, settings.recentLimit ?? DEFAULT_SETTINGS.recentLimit);
      storage.set('folio.recent', recent);
      return recent.slice();
    },
    async removeRecent(path) {
      recent = recent.filter((r) => r.path !== path);
      storage.set('folio.recent', recent);
      return recent.slice();
    },
    async clearRecent() {
      recent = [];
      storage.set('folio.recent', recent);
    },
    async getStartupFiles() {
      const files = Array.isArray(test.startupFiles) ? test.startupFiles : [];
      test.startupFiles = [];
      return files;
    },
    setUiState(state) {
      test.uiState = { ...(test.uiState ?? {}), ...state };
      document.title = state.hasDocument ? `${state.dirty ? '• ' : ''}${state.title} — Folio PDF` : 'Folio PDF';
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
    respondClose(allow) {
      test.closeResponse = allow;
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

export const bridge = isElectron ? window.folio : createBrowserBridge();
export const platform = bridge.platform;
export const isMac = platform === 'darwin';
export const pathSep = platform === 'win32' ? '\\' : '/';
export const joinPath = (dir, name) => (dir.endsWith(pathSep) ? dir + name : dir + pathSep + name);
