# Folio PDF — architecture and module contracts

Folio PDF is a free, open-source desktop PDF reader for Windows and macOS (Linux builds too) that
covers what people use Adobe Acrobat Reader for: viewing, searching, commenting/annotating,
filling forms, signing, and organizing pages. It is an Electron app with **no bundler**: the
renderer is plain ES modules served over a privileged custom scheme (`folio://app/`), pdf.js 6.4
viewer components do the rendering/text/forms/annotation editing, and pdf-lib 1.17 does document
surgery (page operations, annotation objects pdf.js cannot create, metadata, merging...).

This file is the contract between modules. Builders of different modules work in parallel and
rely on it; change it only together with every module it affects.

## Directory layout

```
folio/
  package.json                 scripts, deps, electron-builder config ("build" key)
  scripts/copy-vendor.mjs      copies pdf.js + pdf-lib browser builds into src/renderer/vendor (postinstall)
  build/icon.svg, icon.png     app icon (1024x1024; electron-builder derives .icns/.ico)
  src/main/main.js             Electron entry: app lifecycle, windows, folio:// protocol, single instance, open-file
  src/main/menu.js             buildMenuTemplate({platform, state}) -> Menu template; menu clicks send commands to the renderer
  src/main/ipc.js              ipcMain handlers backing the preload bridge (fs, dialogs, print, settings, recent, clipboard, watch)
  src/main/protocol.js         pure helpers for the folio:// handler (path resolution + MIME map), unit-testable
  src/main/settings-store.js   pure JSON store (load/save/patch) used for settings.json and recent.json, unit-testable
  src/main/recent.js           pure recent-files list logic (add/dedupe/limit/remove), unit-testable
  src/main/watch.js            fs.watch wrapper for "file changed on disk" notifications
  src/preload.cjs              contextBridge: exposes window.folio (CommonJS because sandbox: true)
  src/renderer/index.html      the single page: static DOM skeleton with the ids listed below + import map
  src/renderer/app.js          bootstrap: constructs App, registers every module, runs startup (argv files, session restore)
  src/renderer/styles/*.css    theme.css (tokens), app.css (layout/shell), and one file per module
  src/renderer/lib/*.js        renderer modules (see "Renderer modules")
  src/renderer/vendor/         generated, git-ignored (pdfjs/, pdf-lib/)
  src/shared/*.js              isomorphic (browser + Node) modules: the pdf-lib engine, page ranges, dates, units
  tests/unit/*.test.mjs        node:test unit tests (engine, stores, parsers, menu template, protocol helpers)
  tests/e2e/                   Playwright tests that load the renderer in Chromium with the browser bridge
  tests/fixtures/make-fixtures.mjs   generates fixture PDFs with pdf-lib into tests/fixtures/out/ (git-ignored)
  docs/                        api notes used during development, user docs
  .github/workflows/folio-ci.yml, folio-release.yml
```

## Runtime model

* **Main process** owns: windows, native menus, dialogs, file IO, printing, settings/recent persistence,
  file watching, clipboard, the `folio://` scheme. It never parses PDFs.
* **Renderer** owns everything document related. One window hosts many **tabs**; each tab is a
  `DocumentSession` (bytes + pdf.js document + a `DocumentView`).
* **Bytes are the source of truth.** `session.bytes` (Uint8Array) is the current document. pdf.js edits
  (form values, FreeText/Ink/Highlight/Stamp/Signature editors) live in `annotationStorage` until
  flushed with `pdfDocument.saveDocument()`. pdf-lib operations take bytes and return new bytes.
  The integration rule for every pdf-lib operation on an open document is:

  ```
  const bytes = await session.view.flush();          // saveDocument() if pdf.js has edits, else current bytes
  const next  = await engine.someOperation(bytes, ...);
  await session.replaceBytes(next, { keepPosition: true });  // reload in the viewer, mark dirty
  ```
* **Saving** = flush, then write `session.bytes` to the path (Save) or a chosen path (Save As / Save a Copy).
  Dirty state = `view.hasUnsavedEdits() || session.opsDirty`.
* Always **copy** bytes before handing them to pdf.js `getDocument({data})` (the buffer is transferred to the
  worker). Keep the original `Uint8Array` in the session.

## The preload bridge: `window.folio`

Exposed by `src/preload.cjs` via `contextBridge.exposeInMainWorld('folio', api)`. In a plain browser
(Playwright tests, `npm run dev:web`) `src/renderer/lib/bridge.js` provides a compatible in-memory
implementation (`browserBridge`) so the whole UI runs without Electron. All renderer code imports
`bridge` from `lib/bridge.js` and never touches `window.folio` directly.

```ts
type Filter = { name: string; extensions: string[] };
type PathInfo = { path: string; name: string; dir: string; size: number; mtimeMs: number };
type RecentEntry = { path: string; name: string; lastOpened: number; page?: number; zoom?: string|number };
type MessageOptions = { type?: 'none'|'info'|'warning'|'error'|'question'; title?: string; message: string;
                        detail?: string; buttons?: string[]; defaultId?: number; cancelId?: number; checkboxLabel?: string };

interface FolioBridge {
  platform: 'darwin' | 'win32' | 'linux' | 'browser';
  version: string;                                   // app version
  isPackaged: boolean;

  // files
  openFileDialog(opts?: { multiple?: boolean; filters?: Filter[]; title?: string }): Promise<string[]>;   // [] when cancelled
  saveFileDialog(opts?: { defaultPath?: string; filters?: Filter[]; title?: string }): Promise<string | null>;
  openDirectoryDialog(opts?: { title?: string }): Promise<string | null>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  pathInfo(path: string): Promise<PathInfo>;
  pathForFile(file: File): string | null;            // for OS drag-and-drop (webUtils.getPathForFile); null in browser
  showItemInFolder(path: string): void;
  openExternal(url: string): Promise<void>;          // main restricts to http(s)/mailto
  showMessage(opts: MessageOptions): Promise<{ response: number; checkboxChecked: boolean }>;

  // settings and recent files (JSON in userData)
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;   // shallow merge, returns the full object
  getRecent(): Promise<RecentEntry[]>;
  addRecent(entry: RecentEntry): Promise<RecentEntry[]>;
  removeRecent(path: string): Promise<RecentEntry[]>;
  clearRecent(): Promise<void>;
  getStartupFiles(): Promise<string[]>;              // files passed on argv / open-file before the renderer was ready

  // window and document state
  setUiState(state: { hasDocument: boolean; dirty: boolean; path: string | null; title: string; scrollMode; spreadMode; sidebarOpen; sidebarView; nightMode; theme; tool; handTool; highlightFormFields; readAloud }): void;  // drives the window title and native menu state
  nativeEdit(action: 'undo'|'redo'|'cut'|'copy'|'paste'|'delete'|'selectAll'): void;   // webContents.<action>() for text fields
  setFullScreen(flag: boolean): Promise<void>;
  isFullScreen(): Promise<boolean>;
  closeWindow(): void;
  respondClose(allow: boolean, quit?: boolean): void; // answer to the 'before-close' event ({ quitting } payload echoed back)
  closeAck(): void;                                  // sent first thing in the 'before-close' handler: main then waits for respondClose without a timeout
  setTheme(theme: 'system'|'light'|'dark'): Promise<boolean>;   // returns shouldUseDarkColors after applying
  getSystemDark(): Promise<boolean>;

  // printing (renderer prepares the #print-container first, then calls print)
  print(opts?: { silent?: boolean; printBackground?: boolean; landscape?: boolean; copies?: number;
                 pageRanges?: { from: number; to: number }[]; deviceName?: string }): Promise<{ ok: boolean; reason?: string }>;
  printToPDF(opts?: object): Promise<Uint8Array>;
  getPrinters(): Promise<{ name: string; displayName: string; isDefault: boolean }[]>;

  // clipboard
  writeClipboardText(text: string): void;
  writeClipboardImage(dataUrl: string): void;

  // file watching: main emits 'file-changed' with { path }
  watchFile(path: string): Promise<void>;
  unwatchFile(path: string): Promise<void>;

  // events from main. Returns an unsubscribe function.
  on(channel: 'command', handler: (cmd: string, arg?: unknown) => void): () => void;   // menu/accelerator -> command
  on(channel: 'open-files', handler: (paths: string[]) => void): () => void;           // open-file / second-instance / argv
  on(channel: 'theme', handler: (info: { dark: boolean }) => void): () => void;        // nativeTheme 'updated'
  on(channel: 'file-changed', handler: (info: { path: string }) => void): () => void;
  on(channel: 'before-close', handler: (info: { quitting: boolean }) => void): () => void;   // renderer must call respondClose
  on(channel: 'fullscreen', handler: (info: { fullScreen: boolean }) => void): () => void;
}
```

IPC channel names are `folio:<method>` (e.g. `folio:readFile`); events from main are
`folio:event:<channel>`. Errors thrown in `ipcMain.handle` reach the renderer as rejected promises
with the message only, so main must throw `Error` objects with user-readable messages.

### Settings

```ts
interface Settings {
  theme: 'system' | 'light' | 'dark';           // UI theme (default 'system')
  authorName: string;                             // /T of created annotations (default: OS user name, set by main on first run)
  defaultZoom: 'auto' | 'page-fit' | 'page-width' | number;   // default 'auto'
  scrollMode: 0 | 1 | 2 | 3;                      // pdf.js ScrollMode: VERTICAL 0, HORIZONTAL 1, WRAPPED 2, PAGE 3 (default 0)
  spreadMode: 0 | 1 | 2;                          // pdf.js SpreadMode: NONE 0, ODD 1, EVEN 2 (default 0)
  rememberLastPage: boolean;                      // reopen at last page (default true)
  restoreSession: boolean;                        // reopen tabs from the last run (default true)
  sidebarOpen: boolean; sidebarView: 'thumbnails'|'outline'|'attachments'|'layers'|'comments';
  highlightFormFields: boolean;                   // default true
  nightMode: boolean;                             // invert page colors (default false)
  highlightColor: string; inkColor: string; inkThickness: number; inkOpacity: number;
  freeTextColor: string; freeTextSize: number; shapeColor: string; shapeWidth: number; shapeOpacity: number;
  noteColor: string;
  signatures: { id: string; kind: 'signature'|'initials'; name: string; dataUrl: string; width: number; height: number; createdAt: number }[];
  stampPresets: string[];                         // text stamps: "APPROVED", "DRAFT", ...
  measureUnit: 'mm' | 'cm' | 'in' | 'pt';
  recentLimit: number;                            // default 20
  lastSession: { path: string; page: number }[];  // written on quit when restoreSession
  windowBounds?: { x: number; y: number; width: number; height: number; maximized: boolean };
}
```
Defaults live in `src/shared/defaults.js` (`DEFAULT_SETTINGS`) and are used by both main and renderer.

## Commands

Every user action is a **command** with a string id, dispatched through `app.commands.run(id, arg)`.
Native menu items (main), toolbar buttons, context menus and keyboard shortcuts all run commands;
nothing else calls module methods across module boundaries. Commands registered with
`app.commands.register(id, { run(arg), enabled?(): boolean, checked?(): boolean, label? })`.

| Group | Ids (arg) |
|---|---|
| file | `file:open`, `file:open-paths` (string[]), `file:open-recent` (path), `file:new-from-images`, `file:merge`, `file:save`, `file:save-as`, `file:save-copy`, `file:close`, `file:close-all`, `file:reload`, `file:print`, `file:properties`, `file:reveal`, `file:export-text`, `file:export-images`, `file:export-form-data`, `file:flatten`, `file:quit` |
| edit | `edit:undo`, `edit:redo`, `edit:cut`, `edit:copy`, `edit:paste`, `edit:delete`, `edit:select-all`, `edit:find`, `edit:find-next`, `edit:find-prev`, `edit:preferences`, `edit:snapshot` |
| view | `view:zoom-in`, `view:zoom-out`, `view:zoom-reset`, `view:fit-page`, `view:fit-width`, `view:actual-size`, `view:set-zoom` (number or preset string), `view:rotate-cw`, `view:rotate-ccw`, `view:first-page`, `view:last-page`, `view:next-page`, `view:prev-page`, `view:go-to-page` (number), `view:back`, `view:forward`, `view:scroll-vertical`, `view:scroll-horizontal`, `view:scroll-wrapped`, `view:scroll-page`, `view:spread-none`, `view:spread-odd`, `view:spread-even`, `view:toggle-sidebar`, `view:sidebar` (view name), `view:presentation`, `view:fullscreen`, `view:night-mode`, `view:theme` ('system'/'light'/'dark'), `view:hand-tool`, `view:select-tool`, `view:read-aloud`, `view:next-tab`, `view:prev-tab`, `view:focus-page-number` |
| tool | `tool:none`, `tool:highlight`, `tool:highlight-free`, `tool:underline`, `tool:strikeout`, `tool:squiggly`, `tool:note`, `tool:text`, `tool:ink`, `tool:rect`, `tool:ellipse`, `tool:line`, `tool:arrow`, `tool:stamp`, `tool:image`, `tool:sign`, `tool:initials`, `tool:measure`, `tool:eraser` |
| pages | `pages:organize`, `pages:insert`, `pages:extract`, `pages:split`, `pages:rotate` (indices), `pages:delete` (indices), `pages:crop` |
| impose | `impose:booklet`, `impose:nup`, `impose:step-repeat`, `impose:manual`, `impose:shuffle`, `impose:reverse`, `impose:insert-blank`, `impose:fill-multiple`, `impose:duplicate`, `impose:trim-shift`, `impose:adjust-size`, `impose:mirror`, `impose:rotate-content`, `impose:split`, `impose:tile`, `impose:page-boxes`, `impose:page-info`, `impose:stick-text` ({preset}), `impose:page-numbers`, `impose:bates`, `impose:tape`, `impose:marks`, `impose:sample`, `impose:sheet-sizes`, `impose:sequences`, `impose:record` (toggle), `impose:run-sequence` (name or {steps}) — see docs/IMPOSITION.md |
| form | `form:toggle-highlight`, `form:reset`, `form:export`, `form:next-field` |
| help | `help:shortcuts`, `help:about`, `help:website`, `help:devtools` |

Main's menu uses exactly these ids (`webContents.send('folio:event:command', id, arg)`).

### Keyboard shortcuts (renderer `lib/shortcuts.js`, Cmd on macOS = Ctrl elsewhere)

Open Ctrl+O · Save Ctrl+S · Save As Ctrl+Shift+S · Print Ctrl+P · Close tab Ctrl+W · Find Ctrl+F · Find next/prev F3 / Shift+F3 (and Enter / Shift+Enter in the find bar) ·
Zoom in/out Ctrl+= / Ctrl+- · Actual size Ctrl+0 · Fit page Ctrl+1 · Fit width Ctrl+2 · Rotate Ctrl+Shift+Plus / Ctrl+Shift+Minus ·
First/last page Home/End · Next/prev page PageDown/PageUp (and Right/Left when not in text) · Go to page Ctrl+G · Back/forward Alt+Left/Alt+Right ·
Sidebar F4 · Presentation Ctrl+L / F5 · Full screen F11 · Next/prev tab Ctrl+Tab / Ctrl+Shift+Tab · Properties Ctrl+D ·
Tools: V select, H hand, U highlight, T text box, D draw, N note, S sign, Escape = `tool:none`/exit presentation/close find · Undo/redo Ctrl+Z / Ctrl+Shift+Z (Ctrl+Y) · Delete/Backspace deletes the selected annotation.
Ctrl+wheel zooms around the cursor; pinch zoom is supported.

## Renderer modules

All in `src/renderer/lib/`. Each module exports `install(app)` (idempotent) and gets the `App` object;
`app.js` installs them in a fixed order. Modules communicate only through `app.commands`, `app.events`
(an `EventTarget`; `app.emit(name, detail)` / `app.on(name, handler)`), the active session, and the
bridge. Each module owns its own CSS file in `styles/` (already linked from index.html) and creates
its own dialogs with `app.dialogs`.

```ts
interface App {
  bridge: FolioBridge;             // from lib/bridge.js
  settings: Settings;              // live object; call app.saveSettings(patch) to persist (emits 'settings:changed')
  commands: CommandRegistry;       // lib/commands.js
  tabs: TabManager;                // lib/tabs.js: open(bytes|path), close(id), activate(id), list(), active (session), on events
  dialogs: Dialogs;                // lib/dialogs.js: modal(contentEl|html, {title, buttons}) -> Promise<result>, prompt(), confirm(), toast(msg, {kind, timeout})
  sidebar: Sidebar;                // lib/sidebar.js: registerPanel({id, title, icon, element, onShow}), show(id), toggle(), isOpen()
  toolbar: Toolbar;                // lib/toolbar.js: addButton({id, group, command, icon, title, toggle?}), setSecondary(el|null), update()
  statusbar: Statusbar;            // lib/statusbar.js: set(key, text|el), clear(key)
  get session(): DocumentSession | null;   // active tab's session
  emit(name: string, detail?: any): void; on(name, handler): () => void;
  saveSettings(patch: Partial<Settings>): Promise<void>;
}

interface DocumentSession {
  id: string;
  path: string | null;             // null for unsaved docs (e.g. created from images)
  name: string;                    // display name (file name or "Untitled.pdf")
  bytes: Uint8Array;               // current document bytes (see "Bytes are the source of truth")
  view: DocumentView;
  opsDirty: boolean;               // pdf-lib operations applied since last save
  password?: string;
  get dirty(): boolean;            // opsDirty || view.hasUnsavedEdits()
  flush(): Promise<Uint8Array>;    // view.flush(); updates bytes
  replaceBytes(bytes: Uint8Array, opts?: { keepPosition?: boolean; markDirty?: boolean }): Promise<void>;  // reload document in place
  save(): Promise<boolean>; saveAs(): Promise<boolean>; saveCopy(): Promise<boolean>;
  close(): Promise<boolean>;       // prompts when dirty; true when closed
}
```

`lib/impose.js` (the Impose menu) builds its dialogs with a small form builder (fields in the user's unit, sheet-size and page-range fields), records steps into `app.impose.recording` while a sequence is being recorded, and routes results either to a new tab (`app.tabs.open({ bytes, name })`) or in place through `app.edit.apply`; the engine is `src/shared/impose.js` (`OPS` maps step names to functions, `runSequence` replays them). Custom sheet sizes and sequences live in settings (`customSheetSizes`, `imposeSequences`).

Document-level undo/redo for engine operations lives in `lib/history.js` (`app.edit.apply(op, {label})`, `undo()`, `redo()`), while pdf.js keeps its own undo stack for its editors; `edit:undo` consults pdf.js first (`view.editorStates`), then the document history, then the native text-field undo.

Events emitted on `app` (detail in parentheses): `tab:opened` (session), `tab:activated` (session|null), `tab:closed` (id),
`doc:loaded` (session) after the first pages are ready, `doc:reloaded` (session) after replaceBytes, `doc:dirty` ({session, dirty}),
`doc:saved` (session), `page:changed` ({session, page}), `zoom:changed` ({session, scale, value}), `tool:changed` ({tool}),
`selection:changed` ({session, hasText}), `editor:states` (pdf.js annotationeditorstateschanged payload), `settings:changed` (patch),
`find:results` ({current, total, state}).

### `DocumentView` (`lib/viewer.js`) — the pdf.js wrapper, one per tab

```ts
class DocumentView {
  constructor(opts: { host: HTMLElement; app: App });     // builds <div class="viewerContainer"><div class="pdfViewer"/></div> inside host
  load(bytes: Uint8Array, opts: { password?: string; name: string }): Promise<{ numPages: number }>;   // throws PasswordError {needsPassword, wrong} / InvalidPdfError
  destroy(): void;
  // pdf.js objects (read-only access for modules that need them)
  pdfDocument; pdfViewer; eventBus; linkService; findController; history; uiManager /* AnnotationEditorUIManager or null */;
  container: HTMLElement;         // the scrolling .viewerContainer
  // navigation / layout
  page: number; readonly numPages: number; pageLabel: string | null;
  zoom: number | string;          // numeric scale or 'auto' | 'page-fit' | 'page-width' | 'page-actual'
  zoomIn(steps?: number): void; zoomOut(steps?: number): void; zoomAt(scale: number, clientX: number, clientY: number): void;
  rotation: number; rotate(deltaDeg: 90 | -90): void;
  scrollMode: number; spreadMode: number;
  goToDestination(dest): Promise<void>; back(): void; forward(): void;
  presentation: boolean; nightMode: boolean; handTool: boolean;
  // editing (pdf.js editors)
  editorMode: number;                                            // AnnotationEditorType value; setter switches mode
  setEditorParam(type: number, value: unknown): void;            // AnnotationEditorParamsType
  editorAction(name: 'undo'|'redo'|'delete'|'selectAll'|'copy'|'cut'|'paste'): void;
  addImageStamp(blob: Blob, opts?: { pageIndex?: number; x?: number; y?: number; width?: number }): Promise<void>;  // signature/stamp placement
  hasUnsavedEdits(): boolean; onEditsChanged(handler): () => void;
  flush(): Promise<Uint8Array>;                                  // saveDocument() when there are edits; always returns current bytes
  // geometry
  getPageView(index: number);                                    // pdf.js PDFPageView (index 0-based)
  pageIndexAt(clientX, clientY): number | -1;
  clientToPdf(pageIndex, clientX, clientY): { x: number; y: number };     // PDF user space (points, origin bottom-left)
  pdfToClient(pageIndex, x, y): { x: number; y: number };
  getSelection(): { pageIndex: number; text: string; quads: number[][]; rects: Rect[] }[] | null;  // text selection as PDF-space quads per page
  // document info (promises straight from pdf.js)
  getOutline(); getAttachments(); getMetadata(); getPermissions(); getOptionalContentConfig(); getPageLabels(); getFieldObjects();
  renderPage(index: number, opts: { scale?: number; width?: number; annotationMode?: number; forPrint?: boolean }): Promise<HTMLCanvasElement>;
  getPageText(index: number): Promise<string>;
  // search
  find(opts: { query: string; type?: ''|'again'|'highlightallchange'|'casesensitivitychange'|'entirewordchange'; caseSensitive?: boolean; entireWord?: boolean; highlightAll?: boolean; findPrevious?: boolean }): void;
  clearFind(): void;
  // events: proxy for eventBus.on/off plus 'editschanged'
  on(event: string, handler): () => void;
}
```

Page indices are **0-based** everywhere in code; **1-based** only in UI text and `view.page`.

### Annotation ids

pdf.js names annotations `"<num>R"` (gen 0) or `"<num>R<gen>"`. The engine uses the same format
(`src/shared/pdf-ids.js`: `annotId(num, gen)`, `parseAnnotId(id)`), so the comments panel can list
annotations from pdf.js `getAnnotations()` and edit/delete them through the engine.

## The engine: `src/shared/engine.js` (pdf-lib)

Isomorphic ES module (browser via import map, Node via node_modules). Every function is pure:
takes `Uint8Array` bytes, returns a Promise of new bytes (or data). Never mutates inputs. Throws
`EngineError` with a `code` (`'encrypted' | 'invalid' | 'unsupported' | 'range'`) and a user-readable message.

```ts
// pages
rotatePages(bytes, pageIndices: number[], deltaDeg: 90|180|270|-90): Promise<Uint8Array>
deletePages(bytes, pageIndices: number[]): Promise<Uint8Array>                     // refuses to delete every page
reorderPages(bytes, newOrder: number[]): Promise<Uint8Array>                       // newOrder[i] = old index placed at position i (permutation)
insertPages(bytes, otherBytes, atIndex: number, pageIndices?: number[]): Promise<Uint8Array>
extractPages(bytes, pageIndices: number[]): Promise<Uint8Array>                    // new document
splitByRanges(bytes, ranges: number[][]): Promise<Uint8Array[]>                    // each range = page indices
mergeDocuments(list: Uint8Array[]): Promise<Uint8Array>
cropPages(bytes, pageIndices, box: { x, y, width, height }): Promise<Uint8Array>   // PDF units, sets CropBox
getPageInfo(bytes): Promise<{ count: number; pages: { width: number; height: number; rotation: number }[] }>
// document
getMetadata(bytes): Promise<{ title, author, subject, keywords, creator, producer, creationDate, modificationDate }>
setMetadata(bytes, patch): Promise<Uint8Array>
flattenForms(bytes): Promise<Uint8Array>
getFormData(bytes): Promise<{ name: string; type: string; value: unknown }[]>
resetForm(bytes): Promise<Uint8Array>
imagesToPdf(images: { bytes: Uint8Array; type: 'png'|'jpeg' }[], opts?: { pageSize?: 'fit'|'A4'|'Letter'; margin?: number }): Promise<Uint8Array>
rasterizedCopy(pages: { png: Uint8Array; widthPt: number; heightPt: number }[]): Promise<Uint8Array>
// annotations (all created with /F 4 (Print), /NM uuid, /T author, /M and /CreationDate now, and an appearance stream)
listAnnotations(bytes): Promise<AnnotInfo[]>
addAnnotation(bytes, pageIndex, spec: AnnotSpec): Promise<{ bytes: Uint8Array; id: string }>
updateAnnotation(bytes, id, patch: { contents?, color?, opacity?, author?, hidden?, subject? }): Promise<Uint8Array>
deleteAnnotation(bytes, id): Promise<Uint8Array>                                   // also removes its /Popup and replies
addReply(bytes, parentId, { contents, author }): Promise<{ bytes; id }>

type Rect = [x1, y1, x2, y2];               // PDF user space
type AnnotInfo = { id: string; page: number; subtype: string; rect: Rect; contents: string; author: string;
                   created: Date|null; modified: Date|null; color: string|null; opacity: number; inReplyTo: string|null;
                   name: string|null; hidden: boolean; subject: string|null };
type AnnotSpec =
  | { type: 'note'; rect: Rect /* icon box ~20x20 */; contents: string; author: string; color: string; icon?: 'Comment'|'Note'|'Help'|'Key'|'Paragraph'; open?: boolean }
  | { type: 'highlight'|'underline'|'strikeout'|'squiggly'; quads: number[][]; contents?: string; author: string; color: string; opacity?: number }
  | { type: 'square'|'circle'; rect: Rect; color: string; fill?: string|null; width: number; opacity?: number; contents?: string; author: string }
  | { type: 'line'|'arrow'; start: [x,y]; end: [x,y]; color: string; width: number; opacity?: number; contents?: string; author: string }
  | { type: 'ink'; paths: number[][]; color: string; width: number; opacity?: number; author: string }
  | { type: 'freetext'; rect: Rect; text: string; fontSize: number; color: string; author: string }
  | { type: 'stamp-image'; rect: Rect; image: Uint8Array; imageType: 'png'|'jpeg'; author: string; subject?: string }
  | { type: 'stamp-text'; rect: Rect; text: string; color: string; author: string };
```
Colors are CSS hex strings (`#rrggbb`); opacity 0–1. Appearance-stream builders live in
`src/shared/appearance.js`. Fixtures for tests are built by `tests/fixtures/make-fixtures.mjs`.

## DOM skeleton (`src/renderer/index.html`)

Static ids that modules may rely on (never rename): `#app`, `#titlebar` (drag region, macOS), `#tabbar`,
`#toolbar` (`.toolbar-group[data-group=file|nav|zoom|tools|view|right]`), `#toolbar-secondary`,
`#findbar`, `#main`, `#sidebar` (`#sidebar-tabs`, `#sidebar-panels`), `#viewer-host` (DocumentView hosts
are children; only the active one is visible), `#welcome`, `#statusbar`, `#dialogs`, `#toasts`,
`#print-container`. Everything else is created by modules.

Import map (index.html): `pdfjs-dist` → `./vendor/pdfjs/pdf.mjs`, `pdfjs-dist/web/pdf_viewer.mjs` →
`./vendor/pdfjs/pdf_viewer.mjs`, `pdf-lib` → `./vendor/pdf-lib/pdf-lib.esm.js`, `@pdf-lib/fontkit` →
`./vendor/pdf-lib/fontkit.es.js`. Shared modules import `'pdf-lib'` by bare specifier so they work in
both Node and the browser. pdf.js asset URLs are built with `new URL('../vendor/pdfjs/...', import.meta.url)`.

## Theme

`styles/theme.css` defines tokens on `:root` and `[data-theme="dark"]`: `--bg`, `--bg-elevated`, `--bg-sunken`,
`--fg`, `--fg-muted`, `--accent`, `--accent-fg`, `--border`, `--hover`, `--active`, `--danger`, `--viewer-bg`,
`--toolbar-height`, `--sidebar-width`, `--radius`, `--shadow`, `--font`. `app.js` sets `document.documentElement.dataset.theme`
from settings/system. Night mode (invert pages) is a class `night` on the viewer container (`filter: invert(1) hue-rotate(180deg)` on canvases).

## Tests

* `npm test` — node:test over `tests/unit/*.test.mjs` (must run with no network and no Electron binary).
* `npm run test:e2e` — Playwright against `tests/e2e/server.mjs` serving `src/renderer` with the browser bridge.
  Specs inject fixture PDFs through `window.__folioTest = { files: { '/fixtures/x.pdf': Uint8Array } }` which the
  browser bridge serves from `readFile`, and drive the UI through real clicks/keys.
* CI: `.github/workflows/folio-ci.yml` runs both on ubuntu; `folio-release.yml` builds installers on
  windows-latest, macos-latest and ubuntu-latest and attaches them to a GitHub Release on tags `folio-v*`.
