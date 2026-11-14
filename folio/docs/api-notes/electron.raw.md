# Folio PDF — Electron 44.9.0 + electron-builder 26.15.3 API reference (verified against installed files)

All paths below are under `/home/user/claude/folio/node_modules/`. `d.ts` = `electron/electron.d.ts` (27 978 lines). `scheme.json` = `app-builder-lib/scheme.json`. Line numbers are from the installed files. Where a thing does not exist in the installed version it is marked **NOT PRESENT**.

Most important deviations from what engineers may remember:

| Expectation | Reality in these installed versions |
|---|---|
| `clipboard.writeImage(nativeImage)` / `clipboard.readImage()` / `writeHTML` / `writeBuffer` | **NOT PRESENT.** Clipboard is now an async, `ClipboardItem`-based API (`d.ts:7356-7445`) and is **main-process only** (`d.ts:26121`, not in `Common`/`Renderer` namespaces). Use `clipboard.write([new ClipboardItem({ "image/png": blob })])` from main via IPC. |
| `mac.notarize: false` | Allowed: schema type is plain `boolean` and the source special-cases `=== false` → "skipped macOS notarization" (`MacTargetHelper.js:256-260`). |
| `mac.identity: null` | Allowed and documented as "skip signing entirely" (`scheme.json definitions.MacConfiguration.properties.identity`, `MacTargetHelper.js:13-19`). |
| `win.publisherName` | **NOT PRESENT** on `WindowsConfiguration` in v26; it moved to `win.signtoolOptions.publisherName`. |
| `!node_modules/**/*` in `files` | Harmless but redundant: electron-builder always injects `!**/node_modules/**` into the main matcher and copies production deps via a separate collector (`fileMatcher.js:128-138`, `appFileCopier.js:147-200`). |
| `protocol.registerSource` | New (experimental) zero-JS static file server for a scheme (`d.ts:12117-12137`) — a good alternative to `protocol.handle` for serving the renderer bundle. |

---

## Part A — Electron 44.9.0 (main / preload)

### A1. Custom privileged app scheme

**`protocol.registerSchemesAsPrivileged(customSchemes: CustomScheme[]): void`** — `d.ts:12115`.
Must be called **before `app` `ready`, and only once**: `d.ts:12079-12080` — "This method can only be used before the `ready` event of the `app` module gets emitted and can be called only once."

`CustomScheme` (`d.ts:7907-7915`): `{ scheme: string; privileges?: Privileges }`.

`Privileges` (`d.ts:23948-23988`), all default `false`:

| Field | Note (line) |
|---|---|
| `standard` | Generic-URI syntax; required for relative URLs and web storage (`12091-12103`: "By default web storage apis (localStorage, sessionStorage, webSQL, indexedDB, cookies) are disabled for non standard schemes") |
| `secure` | treat as secure context |
| `bypassCSP` | |
| `allowServiceWorkers` | |
| `supportFetchAPI` | |
| `corsEnabled` | |
| `stream` | "Protocols that use streams ... should set `stream: true`" (`12107-12110`) |
| `codeCache` | "only works when `standard` is also set to true" (`23976-23979`) |
| `allowExtensions` | Chrome extensions on the scheme (`23981-23986`) |

Origin: a `standard` + `secure` scheme gives the page a real origin (`app://folio/...`), which is what unlocks relative URL resolution (`12093-12095`), the storage APIs quoted above, and the FileSystem API (`12098-12100`). The d.ts does not explicitly mention module Workers or import maps; those follow from having a standard origin + `supportFetchAPI` + `corsEnabled` (both needed for `fetch()`/ES module loading of `.mjs` files), so treat that as "implied, not quoted".

**`protocol.handle(scheme, handler)`** — `d.ts:11974`:
```ts
handle(scheme: string, handler: (request: GlobalRequest) => (GlobalResponse) | (Promise<GlobalResponse>)): void;
```
`GlobalResponse = Response`, `GlobalRequest = Request` (`d.ts:9-10`). "Either a `Response` or a `Promise<Response>` can be returned" (`11969`). New in this version: `request.initiatorOrigin` is set when web content made the request and is not controlled by the page (`11961-11966`). `protocol.unhandle(scheme)` removes it (`12171`). The d.ts does not state "must be called after ready" for `handle`; it is a `protocol` module call and the `session` it binds to exists only after `ready` (`session.defaultSession` is a static on `Session`, `d.ts:12970`); call it inside `app.whenReady()`.

Recommended handler, reading from disk (asar-aware because `fs` in the main process is patched; `process.noAsar` controls this, `d.ts:27911-27914`):

```js
// main.js (CommonJS)
const { app, protocol, net } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");

protocol.registerSchemesAsPrivileged([{
  scheme: "folio",
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true }
}]);

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
  ".wasm": "application/wasm", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".otf": "font/otf", ".bcmap": "application/octet-stream",
  ".pfb": "application/x-font-type1", ".ico": "image/x-icon", ".map": "application/json"
};

app.whenReady().then(() => {
  const root = path.join(__dirname, "renderer");           // inside app.asar when packaged
  protocol.handle("folio", async (request) => {
    const url = new URL(request.url);                        // folio://app/index.html
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/" || rel === "") rel = "/index.html";
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root + path.sep)) return new Response("forbidden", { status: 403 });
    try {
      const body = await fs.readFile(file);                  // asar-aware in main
      return new Response(body, { headers: { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
});
```

Gotcha, `net.fetch` vs `readFile`: `net.fetch` "can be made to custom protocols as well as `file:`" (`d.ts:10694-10699`) and is the documented alternative (`net.fetch(pathToFileURL(file).toString())`), but the d.ts does not say anything about asar for `net.fetch`; `fs.readFile` is explicitly asar-aware (Node's fs is patched unless `process.noAsar`, `d.ts:27911-27914`). The zero-JS alternative, **`protocol.registerSource(scheme, { routes: [{ match?: { host?, path? }, source: { type: "directory", root, index?, headers? } }] })`** (`d.ts:12117-12137`, `ProtocolRoute` `12286`, `Match` `22890`, `Source` `24401`) streams files "the way `file:` URLs are, including from `asar` archives, with `Content-Type` taken from the file extension" (`12120-12122`) — but `Content-Type` is then determined by Chromium's extension table, so `.bcmap`/`.pfb` types are not under your control. It is marked `@experimental`.

### A2. BrowserWindow secure defaults

`WebPreferences` (`d.ts:19841-20386`):

| Option | Default and citation |
|---|---|
| `contextIsolation` | `true` (`19875-19889`) |
| `sandbox` | `true` "since Electron 20"; "automatically disabled when `nodeIntegration` is set to `true`" (`20035-20040`) |
| `nodeIntegration` | `false` (`19981-19983`) |
| `preload` | "The value should be the absolute file path to the script" (`20015-20021`) |
| `webSecurity` | `true`; `false` also flips `allowRunningInsecureContent` (`20079-20083`) |
| `allowRunningInsecureContent` | `false` (`19857-19860`) |
| `spellcheck` | `true` (`20057-20059`) |
| `backgroundThrottling` | `true` (`19870-19874`) |

ESM preload + sandbox: **unverified in d.ts** (no mention of ESM/`.mjs` for preload anywhere; grep found nothing). Ship the preload as CommonJS (`preload.cjs`/`.js` with `require("electron")`), which works with `sandbox: true`.

`BaseWindowConstructorOptions` (`d.ts:4164-4561`): `backgroundColor` (`4204-4209`, default `#FFF`), `show` (`4361-4364`, default `true`), `titleBarStyle?: 'default' | 'hidden' | 'hiddenInset' | 'customButtonsOnHover'` (`4412`), `trafficLightPosition?: Point` (macOS, `4413-4418`), `titleBarOverlay` (`4405-4411`), `title` (`4396-4400`). `BrowserWindowConstructorOptions` adds `webPreferences` and `paintWhenInitiallyHidden` (`7039-7054`).

Events/methods (BrowserWindow class `4561-7039`): `'ready-to-show'` (`5066-5073`; "This event will never fire if you use `paintWhenInitiallyHidden: false`"), `'close'` (`4690-4699`; `event.preventDefault()` cancels), `'closed'` (`4729`), `'enter-full-screen'`/`'leave-full-screen'` (`4746`, `4802`), `setDocumentEdited(edited)` macOS (`6514-6520`), `isDocumentEdited()` (`6086`), `setRepresentedFilename(filename)` macOS (`6657-6663`), `setTitle(title)` (`6763-6766`), `setFullScreen(flag)` (`6532-6540`; on macOS the transition is async — wait for the events), `isFullScreen()` (`6108`), statics `fromWebContents` (`5810`), `getAllWindows` (`5814`), `getFocusedWindow` (`5818`).

`webContents.setWindowOpenHandler(handler)` (`d.ts:19143-19153`) returns `WindowOpenHandlerResponse` `{ action: 'allow' | 'deny'; overrideBrowserWindowOptions?; outlivesOpener?; createWindow? }` (`21058-21083`); `HandlerDetails` has `url, frameName, features, disposition, referrer, postBody?` (`22551-22584`).
`'will-navigate'` (`18175-18195`): `(details: Event<WebContentsWillNavigateEventParams>, url /*deprecated*/ ...)`; params `{ url, isSameDocument, isMainFrame, frame, initiator? }` (`25143-25160`); `event.preventDefault()` prevents it; not emitted for `loadURL` or in-page hash changes.
`'did-finish-load'` listener has no args (`17249-17252`). `'dom-ready'` (`17680`).

```js
const win = new BrowserWindow({
  show: false, backgroundColor: "#1e1e1e",
  titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
  trafficLightPosition: { x: 12, y: 10 },
  webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false }
});
win.once("ready-to-show", () => win.show());
win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("folio://")) e.preventDefault(); });
win.loadURL("folio://app/index.html");
```

### A3. Files, dialogs, recent documents, OS open-with, drag-drop, shell, clipboard

`dialog.showOpenDialog(window: BaseWindow, options)` → `Promise<OpenDialogReturnValue>` (`d.ts:8243`; a window-less overload exists). `OpenDialogOptions` (`23656-23688`): `title, defaultPath, buttonLabel, filters: FileFilter[], properties: Array<'openFile'|'openDirectory'|'multiSelections'|'showHiddenFiles'|'createDirectory'|'promptToCreate'|'noResolveAliases'|'treatPackageAsDirectory'|'dontAddToRecent'>, message (macOS), securityScopedBookmarks`. Return `{ canceled: boolean; filePaths: string[]; bookmarks? }` (`23689-23700`). `FileFilter = { name: string; extensions: string[] }` (`8920-8926`); extensions "without wildcards or dots" (`8261-8262`).

`dialog.showSaveDialog(window, options)` → `Promise<SaveDialogReturnValue>` (`8339`). Options (`24159-24204`): `title, defaultPath, buttonLabel, filters, message, nameFieldLabel, showsTagField, properties: Array<'showHiddenFiles'|'createDirectory'|'treatPackageAsDirectory'|'showOverwriteConfirmation'|'dontAddToRecent'>, securityScopedBookmarks`. Return `{ canceled, filePath: string /* "" if canceled */ }` (`24205-24212`).

`dialog.showMessageBox(window, options)` → `Promise<MessageBoxReturnValue>` (`8178`). `MessageBoxOptions` (`23021-23097`): `message` (required), `type?: 'none'|'info'|'error'|'question'|'warning'`, `buttons?: string[]`, `defaultId?`, `signal?: AbortSignal`, `title?`, `detail?`, `checkboxLabel?`, `checkboxChecked?`, `icon?`, `textWidth?` (macOS), `cancelId?` (defaults to first button labeled "cancel"/"no"), `noLink?`, `normalizeAccessKeys?`. Return `{ response: number; checkboxChecked: boolean }` (`23098-23107`). `dialog.showErrorBox(title, content)` (`8165`).

Recent documents: `app.addRecentDocument(path)` and `app.clearRecentDocuments()` — both `@platform darwin,win32` (`d.ts:1109-1122`). Menu roles `recentDocuments` and `clearRecentDocuments` exist in the role union (`22923`); they are macOS-menu roles (they appear in the macOS-only group of that doc comment, `22910-22915`).

macOS open-with: `app.on('open-file', (event, path: string))` (`d.ts:662-678`): "Make sure to listen for the `open-file` event very early in your application startup ... (even before the `ready` event is emitted). You should call `event.preventDefault()` if you want to handle this event. On Windows, you have to parse `process.argv` (in the main process) to get the filepath." `app.on('open-url', (event, url))` (`700-712`), same early-registration rule; requires `CFBundleURLTypes` (electron-builder `protocols` produces it, `electronMac.js:150-154`).

Windows/Linux open-with while running: `app.requestSingleInstanceLock(additionalData?)` → `boolean` (`d.ts:1635-1659`): returns `false` → "your process should immediately quit as it has sent its parameters to another instance". `app.on('second-instance', (event, argv: string[], workingDirectory: string, additionalData: unknown))` (`807-845`): "guaranteed to be emitted after the `ready` event"; "`argv` will not be exactly the same list ... additional arguments might be appended" (e.g. `--original-process-start-time`), so prefer `additionalData` or filter `argv` for entries that are existing `.pdf` paths. First launch: `process.argv` — `process.defaultApp` is `true` when started as `electron .` and "can be useful to determine how many arguments will need to be sliced off from `process.argv`" (`27884-27890`); `app.isPackaged` (`2081-2086`). Pattern: `const args = process.argv.slice(process.defaultApp ? 2 : 1).filter(a => !a.startsWith("--"))`.

Drag-and-drop from the OS: `File.path` is gone; use **`webUtils.getPathForFile(file: File): string`** in the preload (`d.ts:20386-20400`; "This method superseded the previous augmentation to the `File` object with the `path` property"; returns `""` for JS-constructed Files; throws for non-File). `webUtils` is in the `Renderer` namespace (`26537`), so it's available in a sandboxed preload. The `File` object cannot be sent over IPC (`9637-9640`), so resolve to a path in preload and send the string.

`shell` (`14441-14503`, `Common` namespace): `showItemInFolder(fullPath): void` (`14472`), `openPath(path): Promise<string>` (resolves with error message or `""`, `14460`), `openExternal(url, options?: { activate?, workingDirectory?, logUsage? }): Promise<void>` (`14453`, `OpenExternalOptions` `23742`). Restrict before calling:

```js
ipcMain.handle("shell:openExternal", (e, url) => {
  const u = new URL(url);
  if (!["http:", "https:", "mailto:"].includes(u.protocol)) throw new Error("blocked");
  return shell.openExternal(u.toString());
});
```

Clipboard — **changed API**. `Clipboard` (`d.ts:7356-7399`): `clear()`, `has(mimetype): Promise<boolean>`, `read(): Promise<ClipboardItem[]>`, `readText(): Promise<string>`, `write(data: ClipboardItem[]): Promise<void>`, `writeText(text): Promise<void>`, `selection` (Linux). `class ClipboardItem` (`7416-7445`): `constructor(items: Record<string, string | ClipboardBookmark | Blob | Promise<Blob | string>>)`, `getType(type): Promise<Blob | ClipboardBookmark>`, `types: string[]`. **`writeImage`, `readImage`, `writeHTML`, `writeBuffer`, `writeRTF`: NOT PRESENT** (grep returns nothing). `clipboard` and `ClipboardItem` are exported only in the `Main` namespace (`26121`, `26123`) — not available in preload. Copying a rendered page as PNG:

```js
// main
const { clipboard, ClipboardItem } = require("electron");
ipcMain.handle("clipboard:writePng", async (e, pngBytes /* Uint8Array */) => {
  await clipboard.write([new ClipboardItem({ "image/png": new Blob([pngBytes], { type: "image/png" }) })]);
});
```
`nativeImage` is still in `Common` (`25773`): `createFromDataURL(dataURL)` (`10332`), `createFromBuffer(buffer, options?)` (`10327`), `createFromPath` (`10372`), `toPNG()` (`10467`), `toDataURL()` (`10459`), `getSize()` (`10432`), `isEmpty()` (`10436`) — useful for icons/thumbnails, but it is no longer the clipboard's image carrier.

### A4. Printing

`webContents.print(options?: WebContentsPrintOptions, callback?: (success: boolean, failureReason: string) => void): void` (`d.ts:18958`). Doc (`18937-18957`): when `silent` is `true` the system default printer is used if `deviceName` is empty; failure reasons include "Invalid printer settings", "Print job canceled", "Print job failed"; custom `pageSize` width/height must be ≥ 353 microns; if no valid `pageSize` and `usePrinterDefaultPageSize` is `false`, an error is thrown.

`WebContentsPrintOptions` (`25027-25102`): `silent` (default false), `printBackground` (false), `deviceName` (system name, e.g. `Brother_QL_820NWB`), `color` (true), `margins: Margins`, `landscape` (false), `scaleFactor`, `pagesPerSheet`, `collate`, `copies`, `pageRanges: PageRanges[]` ("On macOS, only one range is honored"), `duplexMode: 'simplex'|'shortEdge'|'longEdge'`, `dpi: Record<string, number>`, `header`, `footer`, `pageSize: 'A0'|'A1'|'A2'|'A3'|'A4'|'A5'|'A6'|'Legal'|'Letter'|'Tabloid' | Size`, `usePrinterDefaultPageSize` (new; "Cannot be combined with `pageSize`", falls back to A4). `Margins` (`25432-25454`): `marginType: 'default'|'none'|'printableArea'|'custom'`, `top/bottom/left/right` **in pixels**. `PageRanges` (`25534-25543`): `{ from: number; to: number }` **0-based, inclusive**. `Size = { width, height }` (`14544-14550`) — units for `print()`'s custom size are microns per the `print()` doc (`18937-18940`).

`webContents.printToPDF(options: PrintToPDFOptions): Promise<Buffer>` (`18970`; "`landscape` will be ignored if `@page` CSS at-rule is used"). `PrintToPDFOptions` (`11696-11762`): `displayHeaderFooter` (false), `footerTemplate`, `headerTemplate` (classes `date`, `title`, `url`, `pageNumber`, `totalPages`), `generateDocumentOutline` (experimental), `generateTaggedPDF` (experimental), `landscape` (false), `margins: PrintToPDFMargins` (`11674-11695`: `top/bottom/left/right` **in inches**, default 1 cm ≈ 0.4 in), `pageRanges: string` (e.g. `'1-5, 8, 11-13'`, 1-based), `pageSize: 'A0'…'Tabloid' | 'Ledger' | { width, height } **in inches**` (default `Letter`), `preferCSSPageSize` (false), `printBackground` (false), `scale` (1). Note `Ledger` is valid for `printToPDF` but **not** for `print()`.

`webContents.getPrintersAsync(): Promise<PrinterInfo[]>` (`18711`). `PrinterInfo` (`11652-11672`): `{ description, displayName, name /* OS name — use as deviceName */, options }`.

`window.print()` from the renderer: **unverified** — the d.ts has no mention of `window.print` (grep empty). Use `webContents.print()` from main via IPC.

### A5. Menus, accelerators, about panel, paths

`Menu.buildFromTemplate(template: Array<MenuItemConstructorOptions | MenuItem>): Menu` (`d.ts:9947`), `Menu.setApplicationMenu(menu | null)` (`9989`; on Windows/Linux sets each window's menu; `&File` yields `Alt-F`; `null` removes the bar; a default menu is created if you never set one, `9964-9988`), `Menu.getApplicationMenu()` (`9954`), `menu.getMenuItemById(id): MenuItem | null` (`10001`), `menu.append/insert` (`9993`, `10005`), `menu.popup(options?: PopupOptions)` (`10011`), `menu.closePopup(window?)` (`9997`). `PopupOptions` (`23877-23905`): `window?`, `frame?: WebFrameMain` (pass `params.frame` from `'context-menu'`), `x?`, `y?` (both or neither), `positioningItem?` (macOS), `sourceType?`. `'context-menu'` event: `(event, params: ContextMenuParams)` (`16896`), with `params.x`, `params.y`, `params.frame`, `params.linkURL`, `params.selectionText`, `params.isEditable` (`21723+`).

`MenuItemConstructorOptions` (`22904-23021`): `click(menuItem, window: BaseWindow | undefined, event: KeyboardEvent)`, `role`, `type: 'normal'|'separator'|'submenu'|'checkbox'|'radio'|'header'|'palette'`, `label`, `accessibilityLabel`, `sublabel` (macOS ≥ 14.4), `toolTip` (macOS), `accelerator: string`, `icon: NativeImage | string`, `enabled`, `acceleratorWorksWhenHidden` (macOS, default true), `visible`, `checked`, `registerAccelerator` (win32/linux, default true), `sharingItem`, `submenu: MenuItemConstructorOptions[] | Menu`, `id`, `before/after/beforeGroupContaining/afterGroupContaining: string[]`, `badge` (macOS 14).

Roles present in the union (`22923`): `undo, redo, cut, copy, paste, pasteAndMatchStyle, delete, selectAll, reload, forceReload, toggleDevTools, resetZoom, zoomIn, zoomOut, toggleSpellChecker, togglefullscreen, window, minimize, close, help, about, services, hide, hideOthers, unhide, quit, showSubstitutions, toggleSmartQuotes, toggleSmartDashes, toggleTextReplacement, startSpeaking, stopSpeaking, zoom, front, appMenu, fileMenu, editMenu, viewMenu, shareMenu, recentDocuments, toggleTabBar, selectNextTab, selectPreviousTab, showAllTabs, mergeAllWindows, clearRecentDocuments, moveTabToNewWindow, windowMenu`. All names requested by the task exist. Note the role is lowercase `togglefullscreen` (not `toggleFullScreen`).

Accelerator syntax: `type Accelerator = string` (`d.ts:14`). **The grammar (`CommandOrControl`, `CmdOrCtrl`, `Alt`, `Shift`, `Plus`, `Space`, `Escape`, `F11`, `Left/Right/Up/Down`, `PageUp`, `Home`, `End`, `numadd`, `numsub`, `Tab`, `Backspace`, `Delete`, `Return`...) is NOT documented in any installed file** (grep for `CommandOrControl` across node_modules returns nothing). Treat it as unverified-but-standard; use `CommandOrControl+O`, `CommandOrControl+Shift+S`, `CommandOrControl+Plus`, `CommandOrControl+numadd`, `F11`, `Escape` as in the public docs, and keep every accelerator behind a `click` so a bad string degrades to "no shortcut" rather than a crash.

`app.setAboutPanelOptions(options)` (`1682`); `AboutPanelOptionsOptions` (`21112-21160`): `applicationName, applicationVersion, copyright, version (darwin), credits (darwin,win32), authors: string[] (linux), website (linux), iconPath (linux,win32; 48×48 PNG best on Windows)`.

`app.getPath(name)` (`1392`) names: `'home'|'appData'|'assets'|'userData'|'sessionData'|'temp'|'exe'|'module'|'desktop'|'documents'|'downloads'|'music'|'pictures'|'videos'|'recent'|'logs'|'crashDumps'`. `app.getVersion()` (`1462`: package.json version), `app.getName()` (`1383`: prefers `productName` over `name`), `app.setName(name)` (`1889`: internal only, "does not affect the name that the OS uses").

### A6. IPC and preload

`contextBridge.exposeInMainWorld(apiKey: string, api: any): void` (`d.ts:7615`). The d.ts carries **no serialization table**; the constraints ("only serializable values, functions as values, Promises OK, prototypes stripped") are **unverified here** — design the API as a flat object of functions returning Promises/plain data.

`ipcRenderer.invoke(channel, ...args): Promise<any>` (`9636`). Doc (`9616-9640`): "Arguments will be serialized with the Structured Clone Algorithm, just like `window.postMessage`, so prototype chains will not be included. Sending Functions, Promises, Symbols, WeakMaps, or WeakSets will throw an exception." and "Since the main process does not have support for DOM objects such as `ImageBitmap`, `File`, `DOMMatrix` ... Attempting to send such objects over IPC will result in an error." `Blob` is not named either way → **unverified; use `Uint8Array`/`ArrayBuffer`** (structured-clonable). Error propagation: "If the handler in the main process throws an error, the promise returned by `invoke` will reject. However, the `Error` object in the renderer process will not be the same" (`9641-9644`); on the main side: "Errors thrown through `handle` ... only the `message` property from the original error is provided to the renderer" (`9393-9396`).

`ipcMain.handle(channel, listener: (event: IpcMainInvokeEvent, ...args) => Promise<any> | any)` (`9397`), `handleOnce` (`9402`), `removeHandler(channel)` (`9429`). `IpcMainInvokeEvent` (`9481-9500`): `frameId, processId, sender: WebContents, senderFrame`.
`ipcRenderer.on(channel, (event: IpcRendererEvent, ...args) => void)` (`9651`) with the warning "Do not expose the `event` argument to the renderer ... `ipcRenderer.on('my-channel', (event, ...args) => callback(...args))`" (`9644-9650`). `ipcRenderer.removeListener(channel, listener)` (`9676`) / `off` (`9640`) for cleanup. `webContents.send(channel, ...args)` (`19038`, same structured-clone rules `19026-19037`).

```js
// preload.cjs
const { contextBridge, ipcRenderer, webUtils } = require("electron");
contextBridge.exposeInMainWorld("folio", {
  openFiles: () => ipcRenderer.invoke("dialog:open"),
  readFile: (p) => ipcRenderer.invoke("fs:read", p),              // resolves Uint8Array
  saveFile: (p, bytes) => ipcRenderer.invoke("fs:write", p, bytes), // bytes: Uint8Array
  pathForFile: (file) => webUtils.getPathForFile(file),
  onOpenPath: (cb) => { const l = (_e, p) => cb(p); ipcRenderer.on("app:open-path", l); return () => ipcRenderer.removeListener("app:open-path", l); }
});
```

### A7. Theme, lifecycle, permissions, zoom, misc

`nativeTheme` (`10479-10590`): `shouldUseDarkColors` (readonly, `10518`), `themeSource: 'system' | 'light' | 'dark'` (`10585`, writable; default `system`), event `'updated'` (`10489`, no args). `nativeTheme` is main-only (`26150`); forward to the renderer with `webContents.send`.

`app.on('window-all-closed')` (`1103`; if you subscribe, you own quitting — standard `if (process.platform !== 'darwin') app.quit()`), `app.on('activate', (event, hasVisibleWindows: boolean))` macOS (`105`), `app.on('before-quit', (event))` (`292`; `preventDefault` cancels; not emitted on Windows shutdown), `'will-quit'` (`1088`), `app.whenReady()` (`2032`), `'ready'` listener `(event, launchInfo)` (`762`). Window `'close'` + `event.preventDefault()` for unsaved-changes prompt (`4690-4699`).

`session.defaultSession` (`12970`). `ses.setPermissionRequestHandler(handler | null)` (`13939`: `(webContents, permission, callback(granted), details)`), `ses.setPermissionCheckHandler(handler | null)` (`13930`: `(webContents | null, permission, requestingOrigin, details) => boolean`). Permission union (`13930`/`13939`) includes `'clipboard-read' | 'clipboard-sanitized-write' | 'fullscreen' | 'notifications' | 'openExternal' | 'media' | 'local-fonts' | 'fileSystem' | ...`. Deny everything except `fullscreen`/`clipboard-sanitized-write` for Folio.

`webContents.setZoomFactor(factor)` (`19161`; clamped 0.25–5.0), `setZoomLevel(level)` (`19173`; `scale = 1.2^level`), `getZoomFactor()` (`18750`). `BrowserWindow.setFullScreen/isFullScreen` and the two events — see A2. `app.commandLine.appendSwitch(the_switch, value?)` (`7490`; must be called before `ready`, does not affect `process.argv`). `new Notification(options?)` (`10955`), `NotificationConstructorOptions` (`23255-23330`): `title, subtitle, body, silent, icon, hasReply, timeoutType: 'default'|'never', replyPlaceholder, sound, urgency, actions, closeButtonText, toastXml, id, groupId, groupTitle`; `notification.show()`; `'click'` event (`10833`). `app.setAppUserModelId(id)` win32 (`1740-1747`); the d.ts says nothing about matching the installer appId — electron-builder's `appId` doc says it is used "as Application User Model ID for Windows" (`scheme.json properties.appId`), so pass the same string (`com.foliopdf.app`) to keep taskbar grouping consistent with the NSIS shortcut. `process.platform` is Node's; Electron adds `process.defaultApp`, `process.contextIsolated`, `process.noAsar` (`27876-27914`). `webContents.openDevTools(options?)` (`18917`). `app.setLoginItemSettings` exists (`1882`) — not needed.

### A8. File watching

No Electron API; `grep -n "watch" electron.d.ts` yields only `webRequest`/`webContents` unrelated hits. Use Node `fs.watch(file, { persistent: false }, cb)` in main and debounce (editors often write via rename/temp-file, so re-arm the watcher on `'rename'` and ignore `ENOENT` windows). `fs.watchFile` polling is the fallback for network volumes.

---

## Part B — electron-builder 26.15.3

### B1. Top-level keys (all `scheme.json` → `properties.<key>`; root `additionalProperties: false`)

| Key | Schema | Notes |
|---|---|---|
| `appId` | `["null","string"]`, default `com.electron.${name}` | CFBundleIdentifier / Windows AUMID |
| `productName` | `["null","string"]` | |
| `copyright` | default `Copyright © year ${author}` | |
| `directories` | `MetadataDirectories` `{ app, buildResources (default "build"), output (default "dist") }` | build resources are **not** packed |
| `files` | `FileSet | (FileSet|string)[] | string | null` | default list quoted in description (see B8) |
| `extraResources` / `extraFiles` | same shape | → `Contents/Resources` (mac) or `resources/` (win/linux); `extraFiles` → content dir |
| `asar` | `AsarOptions | boolean | null`, default `true` | |
| `asarUnpack` | `string[] | string | null` | |
| `compression` | `maximum | normal | store`, default `normal` | |
| `artifactName` | string; description: "Defaults to `${productName}-${version}.${ext}`" | macro set below |
| `fileAssociations` | `FileAssociation | FileAssociation[]` | fields: `ext: string|string[]`, `name`, `description` (windows), `mimeType` (linux), `icon`, `isPackage` (mac), `rank` (mac: `Owner|Default|Alternate|None`, default `Default`), `role` (mac: `Editor|Viewer|Shell|None`, default `Editor`) — `definitions.FileAssociation` |
| `protocols` | `Protocol | Protocol[]` `{ name, schemes: string[], role }` | |
| `publish` | `GithubOptions | GitlabOptions | S3Options | SpacesOptions | GenericServerOptions | CustomPublishOptions | KeygenOptions | SnapStoreOptions | BitbucketOptions | AllPublishOptions[] | string | null` | **`null` is valid** |
| `electronVersion`, `npmRebuild` (true), `nodeGypRebuild` (false), `buildDependenciesFromSource` (false), `removePackageScripts` (true), `extraMetadata` (`{}` any), `beforePack`/`afterPack`/`afterSign` (function | string | null), `electronLanguages` (string | string[]), `forceCodeSigning` (false), `detectUpdateChannel` (true), `generateUpdatesFilesForAllChannels` (false) | all present | |

`GithubOptions` (`definitions.GithubOptions`): `provider: "github"` (const), `owner`, `repo`, `host`, `protocol`, `releaseType: draft | prerelease | release` (default `draft`), `vPrefixedTagName` (default true), `tagNamePrefix`, `private`, `publishAutoUpdate`, `channel`, `token` (never in config), `timeout`, `requestHeaders`.

Artifact macros (`app-builder-lib/out/util/macroExpander.js:17-56` + `platformPackager.js:565-569`): `${productName}` (sanitized), `${arch}` (removed together with its separator when arch is null, `:6-15`), `${author}`, `${platform}` (`process.platform`), `${channel}`, `${env.NAME}`, any `appInfo` property (`${version}`, `${name}`, `${buildVersion}`, `${buildNumber}` — `appInfo.js:29,40,115`), and extras `${os}` (= `mac` / `win` / `linux`, `core.js:46-48`) and `${ext}` (`platformPackager.js:565-569`). `${arch}` for x64 becomes `x86_64` for AppImage/rpm/flatpak and `amd64` for deb/snap (`builder-util/out/arch.js:58-68`).

### B2. Icons

Resolution (`app-builder-lib/out/util/iconConverter.js:95-131`, `buildSourceCandidates`): for a configured source without a known extension it tries `src.<format>`, `src`, `src.png`, `src.svg`, then `.icns`/`.ico`; then always `icon.<format>` (`icon.icns` / `icon.ico`), then directories `icons` and `icon`, then `icon.png`, `icon.svg`, then the other formats. Roots searched: `buildResourcesDir` then `projectDir` (`platformPackager.js:673`). So **`build/icon.png` alone is enough**; a 1024×1024 PNG is converted by the downloaded `icons@1.1.0` tool (`toolsets/icons.js:17-18`) into `.icns` (mac), `.ico` (win) and a PNG set (linux). Minimum sizes enforced (`iconConverter.js:251-253`): **512 px for icns, 256 px for ico/png sets**; an existing `.ico` must be ≥ 256 (`:199-200`). Defaults per platform: `mac.icon` default `build/icon.icns` (also accepts `.icon` Icon Composer assets), `win.icon` default `build/icon.ico`, `linux.icon` "icon set directory or one png file ... filename must contain the size (e.g. 32x32.png) ... By default will be generated automatically based on the macOS icns file" (`definitions.LinuxConfiguration.properties.icon`); a `build/icons/` directory is picked up as fallback (`LinuxTargetHelper.js:173-175`, `collectIconsFromDir` `iconConverter.js:150-165`, which accepts `NNxNN.png`/`NN.png` and `icon.png`). Per-association icon: `fileAssociations[].icon` defaults to `${firstExt}.icns`/`${firstExt}.ico` in `build/` or the app icon (`definitions.FileAssociation.properties.icon`; mac: `electronMac.js:160-165`, win: `NsisTarget.js:638-642`).

### B3. mac

`definitions.MacConfiguration` (`additionalProperties: false`): `target` (`default | dmg | mas | mas-dev | pkg | 7z | zip | tar.* | dir`, default "default (dmg and zip)"; note "Squirrel.Mac auto update requires both `dmg` and `zip`"), `category`, `icon`, `hardenedRuntime` (default **true**), `gatekeeperAssess` (false), `entitlements` / `entitlementsInherit` (auto-picked from `build/entitlements.mac.plist` / `build/entitlements.mac.inherit.plist`), `identity` (`null` = skip signing; `"-"` = ad-hoc; unset = keychain search, no ad-hoc fallback), `notarize: boolean` (see table at top; env sets: `APPLE_API_KEY/ID/ISSUER`, or `APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID`, or `APPLE_KEYCHAIN(_PROFILE)` — `MacTargetHelper.js:218-253`), `extendInfo` (merged with `deepAssign` into Info.plist, `macPackager.js:404-407`), `darkModeSupport` (false → sets `NSRequiresAquaSystemAppearance=false`, `macPackager.js:401-403`), `minimumSystemVersion` (→ `LSMinimumSystemVersion`, `:392-395`), `type: development | distribution`, `bundleVersion`, `bundleShortVersion`, `helperBundleId` (default `${appBundleIdentifier}.helper`), `electronLanguages`, `x64ArchFiles`, `mergeASARs` (default true), `singleArchFiles` (all three only for universal; passed to `@electron/universal` `makeUniversalApp`, `macPackager.js:188-196`; `@electron/universal@2.0.3` is installed). `CSC_IDENTITY_AUTO_DISCOVERY=false` disables keychain search (`util/flags.js:13-15`) and is reported in the skip warning (`macCodeSign.js:54-56`); the warning text is "skipped macOS application code signing" (`macCodeSign.js:73-79`) and is **only an error** when `forceCodeSigning` or MAS.

`fileAssociations` **do** generate `CFBundleDocumentTypes` automatically (`electronMac.js:157-180`: `CFBundleTypeExtensions`, `CFBundleTypeName`, `CFBundleTypeRole`, `LSHandlerRank`, `CFBundleTypeIconFile`, optional `LSTypeIsPackage`), merged with any `extendInfo.CFBundleDocumentTypes` (`:179-180`). You do not need `extendInfo` for PDF.

Universal: `doPack` routes `arch === universal` to `doUniversalPack`, which packs x64 and arm64 separately and merges (`macPackager.js:129-131`, `143-200`); the dmg target is created per target name via `require("dmg-builder").DmgTarget` (`macPackager.js:110-112`) and `DmgTarget.build(appPath, arch)` takes any arch (`dmg-builder/out/dmg.js:22-32`) → **universal + dmg works**. `dmg-builder@26.15.3` is installed.

`definitions.DmgOptions`: `title` (default `${productName} ${version}`; macros `${productName}`, `${version}`, `${name}`), `icon` (defaults to app icon), `background` (default `build/background.tiff|png`, 540×380), `backgroundColor`, `iconSize` (80), `iconTextSize` (12), `contents: DmgContent[]` (`{ x, y, type: 'dir'|'file'|'link', path, name }`; x/y are the icon **center**), `window: { x (400), y (100), width (540), height (380) }`, `format: UDBZ|UDCO|UDRO|UDRW|UDZO|ULFO` (default `UDZO`), `filesystem: APFS|HFS+` (default HFS+), `sign` (false; "will lead to unwanted errors in combination with notarization"), `writeUpdateInfo` (true), `internetEnabled`, `license`, `size`, `shrink`, `badgeIcon`, `artifactName`, `publish`.

### B4. win

`definitions.WindowsConfiguration`: `target` (`nsis | nsis-web | portable | appx | msi | msi-wrapped | squirrel | 7z | zip | tar.* | dir`, default `nsis`), `icon` (default `build/icon.ico`), `legalTrademarks`, `requestedExecutionLevel: asInvoker | highestAvailable | requireAdministrator` (default `asInvoker`), `verifyUpdateCodeSignature` (true), `signAndEditExecutable` (true), `signExts`, `defaultArch`, `extraFiles`, `extraResources`, `artifactName`, `files`, `cscLink`, `cscKeyPassword`, `publish`, `forceCodeSigning`, `fileAssociations`, `protocols`. Signing in v26 lives in **`win.signtoolOptions`** (`WindowsSigntoolConfiguration`: `certificateFile`, `certificatePassword`, `certificateSha1`, `certificateSubjectName`, `publisherName`, `rfc3161TimeStampServer`, `timeStampServer`, `sign`, `signingHashAlgorithms`, `additionalCertificateFile`) or **`win.azureSignOptions`** (`WindowsAzureSigningConfiguration`: `endpoint`, `codeSigningAccountName`, `certificateProfileName`, `publisherName`, `fileDigest`, `timestampDigest`, `timestampRfc3161`). The old top-level `win.publisherName`, `win.certificateFile`, `win.sign`, `win.signDlls`, etc. are **NOT PRESENT** (schema dump shows `*** NOT PRESENT ***` for each). File associations are registered with an `APP_ASSOCIATE` macro and `"$appExe \"%1\""` command (`NsisTarget.js:630-650`), and unregistered on uninstall (`:653-659`).

Arch: `TargetConfiguration.arch` accepts `arm64 | armv7l | ia32 | universal | x64` (`definitions.ArchType`). NSIS handles x64/arm64/ia32 in one installer (`NsisTarget.js:204-216`: `APP_DIR_64`, `APP_DIR_ARM64`, `APP_DIR_32`); `nsis.buildUniversalInstaller: false` builds one installer per arch (`NsisTarget.js:56`). The CLI's `--arm64` maps to `Arch.arm64` (`electron-builder/out/builder.js:34-36`). **`["x64","arm64"]` is valid.**

`definitions.NsisOptions` (all present): `oneClick` (true), `perMachine` (false), `allowElevation` (true), `allowToChangeInstallationDirectory` (false), `installerIcon`, `uninstallerIcon`, `installerHeaderIcon`, `installerSidebar` (164×314 bmp), `uninstallerSidebar`, `installerHeader`, `license`, `artifactName` (default `${productName} Setup ${version}.${ext}`), `deleteAppDataOnUninstall` (false, one-click only), `createDesktopShortcut: true | false | "always"`, `createStartMenuShortcut` (true), `shortcutName`, `menuCategory` (string|boolean), `runAfterFinish` (true), `include` (default `build/installer.nsh`), `script` (default `build/installer.nsi`), `guid`, `differentialPackage`, `packElevateHelper` (true), `unicode` (true), `warningsAsErrors` (true), `selectPerMachineByDefault` (false), `displayLanguageSelector` (false), `multiLanguageInstaller`, `uninstallDisplayName` (`${productName} ${version}`), `installerLanguages`, `language` (LCID, default 1033), `removeDefaultUninstallWelcomePage`, `customNsisBinary`, `preCompressedFileExtensions`, `buildUniversalInstaller`, `useZip`.
`definitions.PortableOptions`: `artifactName`, `requestExecutionLevel: admin | highest | user` (default `user`), `unpackDirName: string | boolean`, `splashImage` (`.bmp`), `guid`, `unicode`, `warningsAsErrors`, `buildUniversalInstaller`, `customNsisBinary`, `customNsisResources`, `useZip`, `publish`.

### B5. linux

`definitions.LinuxConfiguration`: `target` (`AppImage | flatpak | snap | deb | rpm | freebsd | pacman | p5p | apk | 7z | zip | tar.* | dir`, default `AppImage`), `category` (freedesktop main category, e.g. `Office`), `icon`, `maintainer` / `vendor` (default from package.json `author`), `synopsis`, `description`, `desktop: LinuxDesktopFile { entry, desktopActions }` (note: `entry`/`desktopActions` are objects even though schema says `typeof: function | null`), `mimeTypes: string[]`, `executableName`, `executableArgs`, `artifactName`, `packageCategory`. `definitions.AppImageOptions`: `artifactName`, `category`, `compression: gzip | xz | zstd`, `description`, `desktop`, `executableArgs`, `license` (plain text only), `mimeTypes`, `publish`, `synopsis`. Only deb/rpm (fpm) require `author.email` (`FpmTarget.js:85-92` → `errorMessages.authorEmailIsMissed`); AppImage does not.

### B6. CLI flags and env

From `electron-builder/out/builder.js:190-265`: `--mac`/`-m`/`--macos`, `--linux`/`-l`, `--win`/`-w`/`--windows` (each `type: array` — may be followed by target names, e.g. `--linux deb tar.xz`), `--x64`, `--ia32`, `--armv7l`, `--arm64`, `--universal` (booleans), `--dir` ("Build unpacked dir. Useful to test."), `--publish`/`-p` with choices `onTag | onTagOrDraft | always | never` (`:241-246`), `--prepackaged`/`--pd`, `--projectDir`/`--project`, `--config`/`-c` (file path; dotted form `-c.extraMetadata.version=1.2.3` and `--config.nsis.unicode=false` are shown in examples `:267-268`). Publish policy: `publish: null` in config → `getPublishConfigs` returns null at every level (`PublishManager.js:337-360`); if `publish` is simply *absent* and `GH_TOKEN`/`GITHUB_TOKEN` is set, GitHub is auto-selected (`:363-366`); unset `--publish` on CI defaults to `onTagOrDraft` with a deprecation warning (`:56-60`), so **always pass `--publish never` on CI** unless you want uploads. Env: `GH_TOKEN` (`PublishManager.js:365`), `CSC_LINK`/`CSC_KEY_PASSWORD` and `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` (`WindowsSigntoolConfiguration` descriptions; `CSC_NAME` in `macCodeSign.js:262`), `CSC_IDENTITY_AUTO_DISCOVERY` (`flags.js:13-15`), `CSC_FOR_PULL_REQUEST` (`macCodeSign.js:39`), `PUBLISH_FOR_PULL_REQUEST` (`PublishManager.js:44`), `ELECTRON_BUILDER_CACHE` (`builder-util/out/util.js:387-396`; prefixes bin cache keys `binDownload.js:83`), `USE_HARD_LINKS=true` (only honoured on non-win32, `builder-util/out/fs.js:125`), `DEBUG=electron-builder` (`builder-util/out/log.js:8`), `USE_SYSTEM_SIGNCODE` (`flags.js:7-8`).

### B7. Cross-building and CI matrix

- NSIS on any host: `makensis` is downloaded (`nsis-3.0.4.1.7z` + `nsis-resources-3.4.1.7z`, or the `nsis-bundle-3.12.tar.gz` toolset; `toolsets/windows.js:156-183`) with per-platform binaries (`mac/makensis`, `Bin/makensis.exe`, `linux/makensis` — `:190-196`). The **uninstaller stub must be executed** to produce the uninstaller; on non-Windows that runs under Wine (`NsisTarget.js:372-374` → `vm/WineVm.js:28-31` short-circuits to a direct exec on win32; otherwise `toolsets/wine.js` downloads `wine-11.0-linux-x86_64.tar.xz` / `wine-11.0-darwin-x86_64.tar.xz`, `:12-13,51`). Executable resource editing uses `resedit` (pure JS, `WindowsConfiguration.signAndEditExecutable`), not rcedit/wine. Windows code signing tools come from `winCodeSign-2.6.0.7z` or the `win-codesign-*` bundles (`toolsets/windows.js:21-36`), downloaded only when signing. So Linux *can* build NSIS/portable (with a ~100 MB Wine download), but `windows-latest` avoids Wine entirely.
- DMG on Linux: no — `dmg-builder` shells out to `hdiutil`; and signing/notarization need macOS (`macCodeSign.js:24`: "supported only on macOS"). Universal needs both arch packs merged by `@electron/universal`, which is pure Node but the dmg step still needs macOS.
- AppImage: build on `ubuntu-latest`.
- Recommended matrix: `macos-latest` → `--mac dmg zip --universal`; `windows-latest` → `--win nsis portable --x64 --arm64`; `ubuntu-latest` → `--linux AppImage --x64`. Always `--publish never` (or `onTag` with `GH_TOKEN`).
- Unsigned mac on CI: set `CSC_IDENTITY_AUTO_DISCOVERY=false` (`flags.js:13-15`) **or** `mac.identity: null` (`MacTargetHelper.js:13-19`, logs "skipped macOS code signing" and returns before any notarize call — `macPackager.js:296-298`). With `identity: null`, `notarize` is never reached; keep `notarize: false` anyway for clarity (`MacTargetHelper.js:256-260`). Do not set `forceCodeSigning: true` (`MacTargetHelper.js:14-16` throws). The DMG is not signed by default (`dmg.sign` default false).

### B8. Validation of the draft config

Checked key-by-key against `scheme.json` (root and every referenced definition have `additionalProperties: false`, so unknown keys fail validation):

| Draft key | Verdict |
|---|---|
| `appId`, `productName`, `copyright` | valid |
| `directories.output/buildResources` | valid (`MetadataDirectories`) |
| `files: ["src/**/*", "package.json", "!**/*.map"]` | valid shape. `package.json` is auto-added anyway (`fileMatcher.js:123-125`); `!**/node_modules/**` is auto-injected (`:128-138`), and production deps are copied by the separate node-module collector from `dependencies`/`optionalDependencies` only (`nodeModulesCollector.js:159-169`, `appFileCopier.js:147-200`). With **no runtime `dependencies`** in package.json the collector logs "no node modules returned" and copies nothing (`appFileCopier.js:196-200`) — exactly what you want. Adding `"!node_modules/**/*"` is harmless but unnecessary. `src/renderer/vendor/**` is included by `src/**/*`. |
| `asar: true` | valid |
| `artifactName: "${productName}-${version}-${os}-${arch}.${ext}"` | valid; `${os}` and `${ext}` are supplied as extras (`platformPackager.js:565-569`). |
| `fileAssociations[0]` with `ext,name,description,mimeType,role` | valid; `role: "Editor"` is the default; `description` is windows-only, `mimeType` linux-only. |
| `mac.category/target/hardenedRuntime/gatekeeperAssess/darkModeSupport` | valid |
| `mac.notarize: false` | **valid** (`type: boolean`) |
| `mac.identity: null` | **valid** (`type: ["null","string"]`) |
| `mac.target[].arch: ["universal"]` with `dmg` and `zip` | valid; dmg + universal works (B3). |
| `dmg.contents[0] = {x,y}` without `type`/`path` | schema-valid (no `required`), and dmg-builder treats an entry without `type` as the app file; but be explicit: `{ "x": 130, "y": 220, "type": "file" }`. |
| `win.target[].arch: ["x64","arm64"]` for nsis | valid |
| `nsis.*` | all valid; note `perMachine: false` + `oneClick: false` shows the install-mode page. |
| `portable.artifactName` | valid |
| `linux.target/category/mimeTypes` | valid |
| `publish: null` | **valid** and means "never publish" (`PublishManager.js:355-358`). |

Nothing is unknown or wrong-typed. Corrected (and slightly hardened) config:

```json
{
  "appId": "com.foliopdf.app",
  "productName": "Folio PDF",
  "copyright": "Copyright (c) 2026 Folio PDF contributors",
  "directories": { "output": "dist", "buildResources": "build" },
  "files": ["src/**/*", "package.json", "!**/*.map"],
  "asar": true,
  "artifactName": "${productName}-${version}-${os}-${arch}.${ext}",
  "fileAssociations": [
    { "ext": "pdf", "name": "PDF Document", "description": "Portable Document Format", "mimeType": "application/pdf", "role": "Editor", "rank": "Alternate" }
  ],
  "mac": {
    "category": "public.app-category.productivity",
    "target": [
      { "target": "dmg", "arch": ["universal"] },
      { "target": "zip", "arch": ["universal"] }
    ],
    "hardenedRuntime": false,
    "gatekeeperAssess": false,
    "darkModeSupport": true,
    "notarize": false,
    "identity": null,
    "minimumSystemVersion": "11.0.0"
  },
  "dmg": {
    "sign": false,
    "contents": [
      { "x": 130, "y": 220, "type": "file" },
      { "x": 410, "y": 220, "type": "link", "path": "/Applications" }
    ]
  },
  "win": {
    "target": [
      { "target": "nsis", "arch": ["x64", "arm64"] },
      { "target": "portable", "arch": ["x64"] }
    ],
    "requestedExecutionLevel": "asInvoker"
  },
  "nsis": {
    "oneClick": false,
    "perMachine": false,
    "allowToChangeInstallationDirectory": true,
    "createDesktopShortcut": true,
    "createStartMenuShortcut": true,
    "shortcutName": "Folio PDF",
    "deleteAppDataOnUninstall": false,
    "artifactName": "${productName}-${version}-win-${arch}-setup.${ext}"
  },
  "portable": { "artifactName": "${productName}-${version}-portable.${ext}" },
  "linux": {
    "target": ["AppImage"],
    "category": "Office",
    "mimeTypes": ["application/pdf"],
    "synopsis": "Free PDF reader and editor"
  },
  "publish": null
}
```
(`rank: "Alternate"` avoids claiming ownership of PDFs over Preview on first launch; drop it if you want Folio to be the default. The nsis `artifactName` override avoids the default `${productName} Setup ${version}.exe` with spaces.)

### B9. package.json requirements (verified in `app-builder-lib/out/util/packageMetadata.js:33-62` and `electron/electronVersion.js`)

- `name`: **required** — `checkNotEmpty("name")` (`:46`) → error "Please specify 'name' in the package.json". Lowercase is npm convention; electron-builder does not enforce case here (only `normalizePackageData.js` warnings).
- `version`: **required** (`:54`).
- `description`: optional, warns "description is missed in the package.json" (`:47-49`).
- `author`: optional for nsis/dmg/AppImage — only a warning "author is missed in the package.json" (`:51-53`). It becomes **an error only for deb/rpm** ("Please specify author 'email' in the application package.json ... required to set Linux .deb package maintainer", `errorMessages.js:4-9`, used in `FpmTarget.js:85-92`). `${author}` macro (default `copyright`) throws if missing (`macroExpander.js:28-33`) — you set `copyright` explicitly, so fine.
- `main`: not validated by electron-builder (only referenced for electron-compile, `appFileCopier.js:247`); Electron itself needs it to find the entry. Set `"main": "src/main/main.js"`.
- `homepage`/`repository`: optional; `repository` is only used to auto-detect GitHub `owner/repo` when publishing.
- `build` key inside the *app* package.json of a two-package layout is an error (`:56-60`); single package.json is fine.
- Electron version: resolved first from `node_modules/electron/package.json` (`electronVersion.js:38-55`), then from `devDependencies.electron` **and, as fallback, `dependencies.electron`** (`:110-121`). No error text forbids `electron` in `dependencies`, but keep it in `devDependencies`: if it were a production dependency the node-module collector would copy the entire Electron download into the app. The version must be exact when not installed ("Electron version ... is a range, not a fixed version", `:103-106`); with `node_modules/electron` present a `^44.9.0` range is fine. Error if nothing found: "Cannot find electron dependency to get electron version" (`:97`).