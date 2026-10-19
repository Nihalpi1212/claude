// Preload: the only bridge between the sandboxed renderer and the main process.
// Exposes window.pigment (see ARCHITECTURE.md "The preload bridge"). CommonJS because sandbox: true.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (method, ...args) => ipcRenderer.invoke(`pigment:${method}`, ...args);
const send = (method, ...args) => ipcRenderer.send(`pigment:${method}`, ...args);

const bootstrap = ipcRenderer.sendSync('pigment:bootstrap');

const api = {
  platform: process.platform,
  version: bootstrap.version,
  isPackaged: bootstrap.isPackaged,
  userName: bootstrap.userName,

  openFileDialog: (opts) => invoke('openFileDialog', opts),
  saveFileDialog: (opts) => invoke('saveFileDialog', opts),
  openDirectoryDialog: (opts) => invoke('openDirectoryDialog', opts),
  readFile: (path) => invoke('readFile', path),
  writeFile: (path, data) => invoke('writeFile', path, data),
  pathInfo: (path) => invoke('pathInfo', path),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
  showItemInFolder: (path) => send('showItemInFolder', path),
  openExternal: (url) => invoke('openExternal', url),
  showMessage: (opts) => invoke('showMessage', opts),

  getSettings: () => invoke('getSettings'),
  setSettings: (patch) => invoke('setSettings', patch),
  getRecent: () => invoke('getRecent'),
  addRecent: (entry) => invoke('addRecent', entry),
  removeRecent: (path) => invoke('removeRecent', path),
  clearRecent: () => invoke('clearRecent'),
  getStartupFiles: () => invoke('getStartupFiles'),

  setUiState: (state) => send('setUiState', state),
  setFullScreen: (flag) => invoke('setFullScreen', flag),
  isFullScreen: () => invoke('isFullScreen'),
  closeWindow: () => send('closeWindow'),
  respondClose: (allow, quit) => send('respondClose', !!allow, !!quit),
  closeAck: () => send('closeAck'),
  setTheme: (theme) => invoke('setTheme', theme),
  getSystemDark: () => invoke('getSystemDark'),
  nativeEdit: (action) => send('nativeEdit', action),

  print: (opts) => invoke('print', opts),
  printToPDF: (opts) => invoke('printToPDF', opts),
  getPrinters: () => invoke('getPrinters'),

  writeClipboardText: (text) => send('writeClipboardText', text),
  writeClipboardImage: (dataUrl) => send('writeClipboardImage', dataUrl),

  watchFile: (path) => invoke('watchFile', path),
  unwatchFile: (path) => invoke('unwatchFile', path),

  on: (channel, handler) => {
    const name = `pigment:event:${channel}`;
    const listener = (_event, ...args) => handler(...args);
    ipcRenderer.on(name, listener);
    return () => ipcRenderer.removeListener(name, listener);
  },
};

contextBridge.exposeInMainWorld('pigment', api);
