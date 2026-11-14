# pdfjs-dist 6.4.299 — verified core display API reference for Folio PDF

Every claim below was read from the files installed under `/home/user/claude/folio/node_modules/pdfjs-dist` (version `6.4.299`, build `d0991a0d5` — `build/pdf.mjs:17168-17169`). Path abbreviations used in citations:

| Short name | Absolute path |
|---|---|
| `pdf.mjs` | `/home/user/claude/folio/node_modules/pdfjs-dist/build/pdf.mjs` |
| `worker` | `/home/user/claude/folio/node_modules/pdfjs-dist/build/pdf.worker.mjs` |
| `api.d.ts` | `/home/user/claude/folio/node_modules/pdfjs-dist/types/src/display/api.d.ts` |
| `util.d.ts` | `/home/user/claude/folio/node_modules/pdfjs-dist/types/src/shared/util.d.ts` |
| `viewer.mjs` | `/home/user/claude/folio/node_modules/pdfjs-dist/web/pdf_viewer.mjs` |
| `pkg` | `/home/user/claude/folio/node_modules/pdfjs-dist/package.json` |

Things the task asked about that are **NOT PRESENT** in this version are called out explicitly in each section and collected in §5.3.

---

## 0. Package layout, import paths, build flavours

**`package.json` has no `exports` map** (`pkg:1-27`), so every file path under the package is importable: `pdfjs-dist` resolves to `"main": "build/pdf.mjs"` (`pkg:5`), types come from `"types": "types/src/pdf.d.ts"` (`pkg:6`), `"engines": {"node": ">=22.13.0 || >=24"}` (`pkg:22-24`), and `@napi-rs/canvas ^1.0.10` is an *optional* dependency (`pkg:14-16`) that **is** installed at `/home/user/claude/folio/node_modules/@napi-rs/canvas`.

Directory layout (verified with `ls`):

```
build/            pdf.mjs, pdf.worker.mjs, pdf.sandbox.mjs (+ .min.mjs and .map for each)
legacy/build/     same three files + pdf.d.mts (which is just `export * from "pdfjs-dist";`)
legacy/web/       pdf_viewer.mjs, pdf_viewer.css, pdf_viewer.d.mts, images/
web/              pdf_viewer.mjs, pdf_viewer.css, pdf_viewer.d.mts, images/
cmaps/            *.bcmap (binary packed CMaps, e.g. Adobe-Japan1-UCS2.bcmap)
standard_fonts/   Foxit*.pfb, LiberationSans-*.ttf (+ LICENSE_FOXIT, LICENSE_LIBERATION)
wasm/             jbig2.wasm, openjpeg.wasm, qcms_bg.wasm, quickjs-eval.wasm, *_nowasm_fallback.js, quickjs-eval.js
iccs/             CGATS001Compat-v2-micro.icc
image_decoders/   pdf.image_decoders.mjs
types/            src/display/*.d.ts, src/shared/*.d.ts, src/core/*.d.ts, web/
webpack.mjs       sets GlobalWorkerOptions.workerPort = new Worker(new URL("./build/pdf.worker.mjs", import.meta.url), {type:"module"}) and re-exports build/pdf.mjs
```

**Modern vs legacy build.** `build/pdf.mjs` relies on very new JS built-ins: `URL.parse` (`pdf.mjs:386`), `Map.prototype.getOrInsertComputed` (`pdf.mjs:2463`), `Promise.withResolvers` (`pdf.mjs:2897`), `Uint8Array.prototype.toBase64` (`pdf.mjs:8171`), `Math.sumPrecise` (`pdf.mjs:21673`). `legacy/build/pdf.mjs` polyfills them with core-js (237 `core-js` references; polyfills for `getOrInsertComputed` at `legacy/build/pdf.mjs:5127-5130`, `Math.sumPrecise` at `:5202`, `toBase64` at `:5726`). The modern build prints `Warning: Please use the \`legacy\` build in Node.js environments.` whenever it is loaded in Node (`pdf.mjs:9588-9590`); the legacy build does not. The export lists of both builds are identical (diffed; only internal aliasing differs). Node 22.22 happens to have all five built-ins (verified by running), but **use `pdfjs-dist/legacy/build/pdf.mjs` in Node tests** anyway (§8). In the Electron 44 renderer use `build/pdf.mjs`.

**`isNodeJS` detection** (`pdf.mjs:28`): `typeof process === "object" && process + "" === "[object process]" && !process.versions.nw && !(process.versions.electron && process.type && process.type !== "browser")`. Consequence for Folio: the Electron **main process** (`process.type === "browser"`) is treated as Node (Node factories, worker disabled); a renderer with `nodeIntegration` (`process.type === "renderer"`) or a sandboxed renderer (no `process`) is treated as a browser.

---

## 1. Loading a document

### 1.1 `getDocument(src)` → `PDFDocumentLoadingTask`

Signature: `getDocument(src?: DocumentInitParameters): PDFDocumentLoadingTask` (`api.d.ts:750`; implementation `pdf.mjs:15398-15543`). You must pass one of `data`, `range`, or `url`, otherwise the task rejects with `Error("getDocument - expected either \`data\`, \`range\`, or \`url\` parameter.")` (`pdf.mjs:15510-15528`).

Every `DocumentInitParameters` field, with the type from `api.d.ts:9-227` and the *effective default computed in the code* (`pdf.mjs:15403-15440`):

| Field | Type | Effective default / behaviour | Source |
|---|---|---|---|
| `url` | `string \| URL` | `null`. String → `URL.parse(val, window.location)` in browsers; in Node, a string without a scheme is converted with `url.pathToFileURL` | `api.d.ts:13`, `pdf.mjs:8572-8590`, `15403` |
| `data` | `string \| number[] \| ArrayBuffer \| TypedArray` | `null`. See §1.2 for transfer/neuter rules | `api.d.ts:24`, `pdf.mjs:8591-8605`, `15404` |
| `httpHeaders` | `object` | `null` | `pdf.mjs:15405` |
| `withCredentials` | `boolean` | `false` (`=== true` check) | `pdf.mjs:15406` |
| `password` | `string` | `null` | `pdf.mjs:15407` |
| `range` | `PDFDataRangeTransport` | `null` unless `instanceof PDFDataRangeTransport` | `pdf.mjs:15408` |
| `rangeChunkSize` | `number` | `2 ** 16` = 65536 unless a positive integer is given | `pdf.mjs:15409` |
| `worker` | `PDFWorker` | `null` → `PDFWorker.create({verbosity, port: GlobalWorkerOptions.workerPort})` | `pdf.mjs:15410`, `15458-15464` |
| `verbosity` | `number` | `undefined` → `setVerbosityLevel(undefined)` is a no-op (only integers accepted), library default is `VerbosityLevel.WARNINGS` (1). **Global** for the whole module. | `pdf.mjs:15411`, `15442`, `330-335` |
| `docBaseUrl` | `string` | `null` unless a non-`data:` string | `pdf.mjs:15412` |
| `cMapUrl` | `string` | `null`; **must end with `/`** or `getDocument` throws `Invalid factory url: "..." must include trailing slash.` | `pdf.mjs:15413`, `8606-8614` |
| `cMapPacked` | `boolean` | `true` (`!== false`) | `pdf.mjs:15414` |
| `iccUrl` | `string` | `null`; trailing slash required | `pdf.mjs:15415` |
| `standardFontDataUrl` | `string` | `null`; trailing slash required | `pdf.mjs:15416` |
| `wasmUrl` | `string` | `null`; trailing slash required | `pdf.mjs:15417` |
| `stopAtErrors` | `boolean` | `false` (internally `ignoreErrors = src.stopAtErrors !== true`) | `pdf.mjs:15418` |
| `maxImageSize` | `number` | `-1` (no limit) unless integer > -1 | `pdf.mjs:15419` |
| `isOffscreenCanvasSupported` | `boolean` | `!isNodeJS` | `pdf.mjs:15420` |
| `isImageDecoderSupported` | `boolean` | `!isNodeJS` | `pdf.mjs:15421` |
| `canvasMaxAreaInBytes` | `number` | `-1` (worker guesses, possibly slowly) | `pdf.mjs:15422`, `api.d.ts:139-143` |
| `disableFontFace` | `boolean` | `isNodeJS` (i.e. `false` in browsers, `true` in Node) | `pdf.mjs:15423` |
| `fontExtraProperties` | `boolean` | `false` | `pdf.mjs:15424` |
| `enableXfa` | `boolean` | `false` | `pdf.mjs:15425` |
| `ownerDocument` | `HTMLDocument` | `globalThis.document` | `pdf.mjs:15426` |
| `disableRange` | `boolean` | `false` | `pdf.mjs:15427` |
| `disableStream` | `boolean` | `false` | `pdf.mjs:15428` |
| `disableAutoFetch` | `boolean` | `false` (also requires `disableStream` to be effective, `api.d.ts:188-190`) | `pdf.mjs:15429` |
| `pdfBug` | `boolean` | `false` | `pdf.mjs:15430` |
| `CanvasFactory` | class | `NodeCanvasFactory` in Node else `DOMCanvasFactory` | `pdf.mjs:15431` |
| `FilterFactory` | class | `NodeFilterFactory` / `DOMFilterFactory` | `pdf.mjs:15432` |
| `BinaryDataFactory` | class | `NodeBinaryDataFactory` / `DOMBinaryDataFactory` (main-thread fallback loader for CMaps, standard fonts, wasm) | `pdf.mjs:15433`, `api.d.ts:209-215` |
| `enableHWA` | `boolean` | `false`; passed to the canvas factory | `pdf.mjs:15434`, `15444-15447` |
| `enableWebGPU` | `boolean` | `false` (undocumented in d.ts; triggers `initGPU()`) | `pdf.mjs:15435-15436` |
| `useWasm` | `boolean` | `true` (`!== false`) | `pdf.mjs:15437`, `api.d.ts:105-110` |
| `pagesMapper` | object | `new PagesMapper()` (page reorder/clone support) | `pdf.mjs:15438`, `api.d.ts:221-226` |
| `useSystemFonts` | `boolean` | `!isNodeJS && !disableFontFace` | `pdf.mjs:15439` |
| `useWorkerFetch` | `boolean` | `true` only when `BinaryDataFactory === DOMBinaryDataFactory` **and** `cMapUrl`, `standardFontDataUrl`, `wasmUrl` are all set **and** each is an `http(s):` URL relative to `document.baseURI` (`isValidFetchUrl`, which only accepts `/https?:/` — `pdf.mjs:1402-1405`). Otherwise `false`. | `pdf.mjs:15440` |

**NOT PRESENT in this version:** `CMapReaderFactory`, `StandardFontDataFactory` (replaced by the single `BinaryDataFactory`, `api.d.ts:209-215`), `length` (only exists as the first constructor argument of `PDFDataRangeTransport`, `api.d.ts:765`), `isEvalSupported` (no occurrence in `pdf.mjs` or `api.d.ts`).

### 1.2 How `data` is handled — transfer / neutering (read this before wiring pdf-lib)

`getDataProp` (`pdf.mjs:8591-8605`):

```js
function getDataProp(val) {
  if (isNodeJS && typeof Buffer !== "undefined" && val instanceof Buffer) {
    throw new Error("Please provide binary data as `Uint8Array`, rather than `Buffer`.");   // :8592-8594
  }
  if (val instanceof Uint8Array && val.byteLength === val.buffer.byteLength) {
    return val;                                   // :8595-8597  used AS-IS (no copy)
  }
  if (typeof val === "string") return stringToBytes(val);            // :8598-8600
  if (val instanceof ArrayBuffer || ArrayBuffer.isView(val) || typeof val === "object" && !isNaN(val?.length)) {
    return new Uint8Array(val);                   // :8601-8603  ArrayBuffer → VIEW over same buffer; other views/arrays → COPY
  }
  throw new Error("Invalid PDF binary data: ...");
}
```

Then the bytes are sent to the worker **with `data.buffer` in the transfer list**: `worker.messageHandler.sendWithPromise("GetDocRequest", docParams, data ? [data.buffer] : null)` (`pdf.mjs:15508`), and `MessageHandler.sendWithPromise` passes `transfers` straight to `postMessage` (`pdf.mjs:8796-8807`). The fake worker's `LoopbackPort.postMessage` does `structuredClone(obj, {transfer})` (`pdf.mjs:8621-8626`), so the buffer is **neutered in the fake-worker case too**.

Rules (all verified by running in Node, see §8 output):

| What you pass | Result for the caller's buffer |
|---|---|
| `Uint8Array` covering its whole `ArrayBuffer` (e.g. `fs.readFileSync`→`new Uint8Array(buf)`, `await file.bytes()`, `pdfLibDoc.save()`) | **neutered** (`byteLength` becomes 0) |
| `ArrayBuffer` | **neutered** |
| `Uint8Array` subarray/view (`byteLength !== buffer.byteLength`), `number[]`, other TypedArrays | copied (`new Uint8Array(val)`), original intact |
| Node `Buffer` | throws |

**Folio rule:** keep the original bytes for pdf-lib and hand pdf.js a copy: `getDocument({ data: originalBytes.slice(), ... })`. `PDFDataRangeTransport` chunks are transferred the same way (`api.d.ts:754-756`).

### 1.3 Where CMaps / standard fonts / wasm are fetched from (matters for the custom `folio://` scheme)

* `useWorkerFetch === true` → the worker fetches `${cMapUrl}${name}.bcmap` (`worker:34138`), `${standardFontDataUrl}${filename}` (`worker:34166`), `${wasmUrl}${file}` (`worker:9643`) with `fetch()` (`fetchBinaryData`, `worker:1355-1361`), and `qcms_bg.wasm` for ICC colour with a **synchronous XHR** (`fetchSync`, `worker:2675-2681`, called at `worker:2776`). With `useWorkerFetch` false the ICC/qcms path is disabled entirely (`worker:2763-2766`).
* `useWorkerFetch === false` → the worker asks the main thread (`FetchBinaryData` handler, `pdf.mjs:16735`) and `DOMBinaryDataFactory._fetch` (`pdf.mjs:9114-9120`) calls `fetchData(url, type)` (`pdf.mjs:1239-1280`): `fetch()` for http(s) URLs, otherwise an `XMLHttpRequest` with `responseType = "arraybuffer"`, accepting status 200 **or 0** (`pdf.mjs:1255-1279`). The URL is simply `baseUrl + filename` (`pdf.mjs:9105`).

For a `folio://` page `isValidFetchUrl` is false, so the default is the main-thread XHR path. Either path requires the custom scheme to answer GET requests for `cmaps/*.bcmap`, `standard_fonts/*`, `wasm/*`, `iccs/*`; if you force `useWorkerFetch: true` the scheme must be usable with `fetch()` *from a Worker* and with sync XHR (an Electron `protocol.registerSchemesAsPrivileged` concern — not verified here, belongs to the Electron note).

Minimal renderer setup (adapt paths to the vendored copy):

```js
import * as pdfjs from "../vendor/pdfjs/build/pdf.mjs";
pdfjs.GlobalWorkerOptions.workerPort = new Worker(
  new URL("../vendor/pdfjs/build/pdf.worker.mjs", import.meta.url), { type: "module" }); // same pattern as webpack.mjs:18-23
const base = new URL("../vendor/pdfjs/", import.meta.url).href;   // "folio://app/vendor/pdfjs/"
const task = pdfjs.getDocument({
  data: bytes.slice(),                 // copy! (§1.2)
  cMapUrl: base + "cmaps/", cMapPacked: true,
  standardFontDataUrl: base + "standard_fonts/",
  wasmUrl: base + "wasm/", iccUrl: base + "iccs/",
  verbosity: pdfjs.VerbosityLevel.ERRORS,
});
```

### 1.4 `PDFDocumentLoadingTask` (`pdf.mjs:15544-15579`, `api.d.ts:801-864`)

| Member | Behaviour |
|---|---|
| `docId` | `"d0"`, `"d1"`, … (static counter, `pdf.mjs:15545,15550`) |
| `promise` | `Promise<PDFDocumentProxy>` resolved on worker `GetDoc` (`pdf.mjs:16600-16608`), rejected with a wrapped exception on `DocException` (`:16609-16611`) |
| `destroyed` | boolean |
| `onPassword(updatePassword, reason)` | Called from the `PasswordRequest` handler (`pdf.mjs:16612-16632`). `reason` is `ex.code`: `PasswordResponses.NEED_PASSWORD = 1` or `INCORRECT_PASSWORD = 2` (`pdf.mjs:326-329`). Call `updatePassword("secret")` to retry; call `updatePassword(new Error("cancelled"))` to reject loading (`:16618-16626`). If no `onPassword` is set the task rejects with `PasswordException` (`:16615-16617`). |
| `onProgress({loaded, total, percent})` | `percent = total ? clamp(round(loaded/total*100),0,100) : NaN` (`pdf.mjs:16423-16432`); fired from the network reader and from `DataLoaded` (`:16633-16638`) |
| `destroy()` | `async`; marks `_pendingDestroy` on the worker, waits for setup, destroys transport and worker (`pdf.mjs:15557-15575`). Creating a new document on the same `workerPort` while a destroy is pending throws `"PDFWorker.create - the worker is being destroyed. Please remember to await \`PDFDocumentLoadingTask.destroy()\`-calls."` (`:16352-16354`) — **always `await task.destroy()`**. |
| `getData()` | raw bytes even while `onPassword` is pending (`api.d.ts:857-863`) |

Exceptions that can reach you (`wrapReason`, `pdf.mjs:8679-8699`): `AbortException`, `InvalidPDFException`, `PasswordException` (has `.code`), `ResponseException` (has `.status`, `.missing`), `UnknownErrorException` (has `.details`). All carry `.name` equal to the class name (`BaseException`, e.g. `pdf.mjs:1283`). **`MissingPDFException` and `UnexpectedResponseException` are NOT PRESENT** — they were folded into `ResponseException` (`util.d.ts:362-368`; `missing === true` is the old "missing PDF" case).

---

## 2. `GlobalWorkerOptions` and the fake-worker fallback

`GlobalWorkerOptions` (`pdf.mjs:14343-14364`): `static workerPort` setter accepts only a `Worker` instance or `null` (else throws `Invalid \`workerPort\` type.`), `static workerSrc` accepts only strings. `workerPort` overrides `workerSrc` (`types/src/display/worker_options.d.ts:4-7`).

`PDFWorker` (`pdf.mjs:16202-16385`):

* Static init: in Node the real worker is disabled and `GlobalWorkerOptions.workerSrc ||= "./pdf.worker.mjs"` (`:16211-16214`).
* `#initialize()` (`:16269-16318`): if `workerSrc` is cross-origin it is wrapped in a Blob module that `await import()`s it (`:16215-16228`, `16278-16280`); then `new Worker(workerSrc, {type: "module"})` (`:16281-16283`). If the worker emits `error` before it is ready, or the `ready` payload is not a `Uint8Array`, `terminateEarly()` terminates it and **silently switches to the fake worker** (`:16285-16313`). A synchronous exception (e.g. no `Worker` constructor, or `workerSrc` unset → `No "GlobalWorkerOptions.workerSrc" specified.` from `:16359-16364`) logs `info("The worker has been disabled.")` and also falls back (`:16314-16317`).
* `#setupFakeWorker()` (`:16319-16339`): logs `warn("Setting up fake worker.")` once (only visible when verbosity ≥ `WARNINGS`), then dynamically `import(this.workerSrc)` (`:16377-16380`) and runs `WorkerMessageHandler.setup` on a `LoopbackPort` in the main thread. If that import fails the worker promise rejects with `Setting up fake worker failed: "..."` (`:16337`), which rejects `getDocument().promise`.
* `globalThis.pdfjsWorker?.WorkerMessageHandler` is honoured as a main-thread worker (`:16365-16371`).
* One `PDFWorker` per port; `PDFWorker.create(params)` returns the cached instance for a given `port` (`:16239-16242`, `16349-16358`).

**Detecting that you are on the fake worker** (nothing public exposes `#isWorkerDisabled`): after `await task.promise`, check `task._worker.port instanceof Worker` — on the fallback `task._worker.port.constructor.name === "LoopbackPort"` (`pdf.mjs:8618`; verified in the §8 run). Or create the worker yourself and inspect `worker.port` after `await worker.promise`:

```js
const worker = pdfjs.PDFWorker.create({ port: pdfjs.GlobalWorkerOptions.workerPort });
await worker.promise;
if (!(worker.port instanceof Worker)) console.error("pdf.js is running without a Web Worker (fake worker)");
const task = pdfjs.getDocument({ data, worker, ... });
```

---

## 3. `PDFDocumentProxy` (`pdf.mjs:15620-15747`, `api.d.ts:868-1252`)

| Member | Signature / return shape | Source |
|---|---|---|
| `numPages` | `number` | `pdf.mjs:15637` |
| `fingerprints` | `[string, string \| null]` — second element only for modified docs | `api.d.ts:893-898` |
| `isPureXfa`, `allXfaHtml` | boolean / fake-DOM tree or null | `pdf.mjs:15643-15648` |
| `annotationStorage` | `AnnotationStorage` (lazily created) | `pdf.mjs:16433-16435` |
| `pagesMapper`, `canvasFactory`, `filterFactory` | transport objects | `pdf.mjs:15625-15636` |
| `getPage(pageNumber)` | `Promise<PDFPageProxy>`; 1-based; rejects `Invalid page request.` outside `[1, numPages]`; results are cached per index | `pdf.mjs:16819-16844` |
| `getPageIndex({num, gen})` | `Promise<number>` (0-based); throws `Invalid pageIndex request.` for non-ref objects | `pdf.mjs:16845-16858` |
| `getDestinations()` | `Promise<Map<string, any[]>>` — slow on big docs, prefer `getDestination` | `api.d.ts:922-927` |
| `getDestination(id)` | `Promise<any[] \| null>` explicit destination array | `api.d.ts:929-934` |
| `getPageLabels()` | `Promise<string[] \| null>` | `api.d.ts:936-940` |
| `getPageLayout()` / `getPageMode()` | `Promise<string>` | `api.d.ts:942-950` |
| `getViewerPreferences()` | `Promise<Map \| null>` | `api.d.ts:952-956` |
| `getOpenAction()` | `Promise<Map \| null>` | `api.d.ts:958-962` |
| `getAttachments()` | `Promise<Map<string, CatalogAttachment> \| null>`; `CatalogAttachment = {content?: Uint8Array \| null, description: string, filename: string, rawFilename: string}` | `api.d.ts:964-968`, `types/src/core/catalog.d.ts:8-29` |
| `getAttachmentContent(id)` | `Promise<Uint8Array \| null>` (lazy content) | `api.d.ts:970-975` |
| `getAnnotationsByType(types: Set<number>, pageIndexesToSkip: Set<number>)` | `Promise<object[]>` | `api.d.ts:977-982` |
| `getJSActions()` | `Promise<Map \| null>` (document-level JS) | `pdf.mjs:15685-15687` |
| `getOutline()` | `Promise<OutlineNode[]>`; node = `{title, bold, italic, color: Uint8ClampedArray(3), dest: string \| any[] \| null, url: string \| null, unsafeUrl?: string, newWindow?: boolean, count?: number, items: OutlineNode[]}` | `api.d.ts:1009-1024` |
| `getOptionalContentConfig({intent = "display"})` | `Promise<OptionalContentConfig>`; the resulting config carries `renderingIntent` and **must** match the `intent` later passed to `render()` or render throws `Must use the same \`intent\`-argument…` | `pdf.mjs:15691-15698`, `15949-15951` |
| `getPermissions()` | `Promise<Set<number> \| null>` of `PermissionFlag` values | `api.d.ts:1052-1057` |
| `getMetadata()` | `Promise<{info, metadata: Metadata \| null, contentDispositionFilename, contentLength, hasStructTree}>` | `pdf.mjs:16937-16946` |
| `getMarkInfo()` | `Promise<{Marked, UserProperties, Suspects} \| null>` | `api.d.ts:1081-1085` |
| `getData()` | `Promise<Uint8Array>` original bytes | `pdf.mjs:16745-16747` |
| `saveDocument(printToPDF?)` | `Promise<Uint8Array>` — see §3.2 | `pdf.mjs:16748-16766` |
| `extractPages(pageInfos, copyLevels?)` | `Promise<Uint8Array>`; new page-assembly API (`{document?, image?: ImageBitmap, includePages?, excludePages?, pageIndices?, insertAfter?}`) | `api.d.ts:1102-1180`, `pdf.mjs:16767-16818` |
| `getDownloadInfo()` | `Promise<{length}>` | `pdf.mjs:15717-15719` |
| `cleanup(keepLoadedFonts = false)` | `Promise`; **throws `startCleanup: Page N is currently rendering.`** if any page has active render tasks | `pdf.mjs:16950-16968` |
| `cachedPageNumber(ref)` | `number \| null` | `pdf.mjs:16969-16982` |
| `loadingParams` | `{disableAutoFetch, enableXfa}` only | `pdf.mjs:15498-15501` |
| `loadingTask` | the `PDFDocumentLoadingTask` | `pdf.mjs:15729-15731` |
| `getFieldObjects()` | `Promise<Map<string, object[]> \| null>` keyed by fully-qualified field name — shapes in §3.3 | `pdf.mjs:16865-16867`, `worker:64552-64555` |
| `getSignatures()` / `getSignatureData(id)` | signature metadata list / `{data: Uint8Array[], pkcs7: Uint8Array}` | `api.d.ts:1221-1240` |
| `hasJSActions()` | `Promise<boolean>` | `api.d.ts:1241-1245` |
| `getCalculationOrderIds()` | `Promise<string[] \| null>` | `api.d.ts:1246-1251` |

**NOT PRESENT:** `PDFDocumentProxy.destroy()` (no such method in `pdf.mjs:15620-15747` or `api.d.ts:868-1252`; destroy through `loadingTask.destroy()`), `PDFDocumentProxy.getPageJSActions()` (page-level actions are `PDFPageProxy.getJSActions()`, `pdf.mjs:15817-15819`).

### 3.1 `getMetadata()` details

`info` is built in the worker (`worker:59847-59915`): always-present keys `PDFFormatVersion`, `Language`, `EncryptFilterName` (`xref.encrypt?.filterName ?? null`), `IsLinearized`, `IsAcroFormPresent`, `IsXFAPresent`, `IsCollectionPresent`, `IsSignaturesPresent` (`:59853-59862`); then from the Info dict: `Title`, `Author`, `Subject`, `Keywords`, `Creator`, `Producer`, `CreationDate`, `ModDate` (strings, decoded with `stringToPDFString`, `:59877-59889`), `Trapped` (a `Name` object, `:59890-59895`), and **everything else goes into `info.Custom`, a `Map<string, string|number|boolean|Name>`** (`:59896-59915`). Dates are raw PDF date strings (`"D:20261017175459Z"` in the §8 run) — convert with `PDFDateString.toDateObject` (§5).

`metadata` is the XMP packet parsed by `MetadataParser` (`worker:40345-40366`, `39096-39185`): `new Metadata({parsedData: Map, rawData: string})`. The `Metadata` class (`pdf.mjs:14367-14386`) has **only** `get(name)` (returns `null` when absent), `getRaw()` (the XMP XML string) and `[Symbol.iterator]()` over `[name, value]` entries. Keys are the XML element names, e.g. `"dc:title"`; sequence elements become arrays of strings (`worker:39147-39148`). **`metadata.getAll()` and `metadata.has()` are NOT PRESENT** — use `[...metadata]` / `Object.fromEntries(metadata)` and `metadata.get(k) !== null`.

### 3.2 `saveDocument()` — exact behaviour

Main thread (`pdf.mjs:16748-16766`): if `annotationStorage.size <= 0` it logs `warn("saveDocument called while \`annotationStorage\` is empty, please use the getData-method instead.")` and continues; it sends `{isPureXfa, numPages, annotationStorage: serializable.map, supportsPrintToPDF, filename}` with the serializable `transfer` list (stamp bitmaps) to the worker `SaveDocument` handler and finally calls `annotationStorage.resetModified()`.

Worker handler (`worker:64656-64790`):

1. Builds `newAnnotationsByPage` from storage entries whose key starts with `"pdfjs_internal_editor_"` (`AnnotationEditorPrefix`, `pdf.mjs:54`), grouped by `value.pageIndex` (`getNewAnnotationsMap`, `worker:1705-1717`).
2. For those pages calls `page.saveNewAnnotations(...)` (`worker:64687-64695`, `59042-59070`), optionally creating/updating the structure tree (`:64670-64710`).
3. For **every** page calls `page.save(handler, task, annotationStorage, changes)` (`:64715-64723`) which calls each parsed annotation's `save()` — this is where form-field values (keyed by the annotation `id`, e.g. `"9R"`) are written (`worker:53953-54040`, §6.4).
4. `if (changes.size === 0) return stream.bytes;` — **with nothing to write you get the original bytes back unchanged** (`:64732-64734`; verified in §8: same length).
5. Otherwise `incrementalUpdate(...)` (`worker:61507-61564`): copies the original bytes, appends a newline if needed, appends the changed objects (`writeChanges`, `:61475-61506`) and a new xref table or xref **stream** (`useXrefStream: isDict(xref.topDict, "XRef")`, `:64786`), trailer with `/Prev`, `/Root`, `/Info`, `/Encrypt` (`getTrailerDict`, `:61457-61474`), `/Size`, and returns a fresh `Uint8Array` (`:61556-61563`). It is a **true incremental update**: the output starts with the original bytes (verified in §8).
6. **Encrypted documents:** each new object is written through `writeObject(ref, obj, buffer, {encrypt, encryptRef})` which encrypts strings/streams with `encrypt.createCipherTransform(ref.num, ref.gen)` (`worker:61149-61156`, `61210`, `61249`) and the `/Encrypt` ref is carried into the new trailer (`:64765`, `61472`). So saving a password-opened PDF produces a still-encrypted PDF with the same security handler.
7. `NeedAppearances` is set on the AcroForm when a field could not get an appearance (`:64735`, `updateAcroform`, `:61521-61530`); XFA datasets are updated for XFA forms (`:64736-64751`, `61531-61538`).

The `printToPDF` argument is a Firefox-only hook (`api.d.ts:1092-1101`); pass nothing.

### 3.3 `getFieldObjects()` return shapes (worker `getFieldObject()` implementations)

Map key = fully-qualified field name; value = array of objects (one per widget/kid). Non-terminal field nodes have `kidIds`:

* Parent node (`worker:53433-53448`): `{id, actions, name, strokeColor, fillColor, type: "", kidIds: string[], page, rotation}`.
* Text (`:54538-54559`): `{id, value, defaultValue, multiline, password, charLimit, comb, editable, hidden, name, rect, actions, page, strokeColor, fillColor, rotation, datetimeFormat, hasDatetimeHTML, type: "text"}`.
* Button (`:54993-55012`): `type: "checkbox" | "radiobutton" | "button"`, `value` (`fieldValue || "Off"`), `defaultValue`, `exportValues` (checkbox `exportValue` / radio `buttonValue`), `editable`, `name`, `rect`, `hidden`, `actions`, …
* Choice (`:55078-55095`): `type: "combobox" | "listbox"`, `value` (first selected or null), `numItems`, `multipleSelection`, `items` (= `options`), …
* Signature (`:55224-55231`): `{id, value: null, page, type: "signature"}`.

`id` is the annotation ref string (`"9R"`) and is the key you use in `annotationStorage.setValue(id, {...})`. Real output is in §8.

### 3.4 `AnnotationStorage` (`pdf.mjs:6875-7079`, `types/src/display/annotation_storage.d.ts`)

| Member | Behaviour | Source |
|---|---|---|
| `getValue(key, defaultValue)` | returns `defaultValue` if absent, else `Object.assign(defaultValue, stored)` (mutates and returns `defaultValue`) | `pdf.mjs:6883-6886` |
| `getRawValue(key)` | stored object or `undefined` | `:6887-6889` |
| `setValue(key, value)` | if key exists, **merges** `value`'s entries into the stored object field by field; else stores `value`. Fires `onSetModified()` once when it first becomes modified; if `value` is an editor, fires `onAnnotationEditor(type)` | `:6907-6928` |
| `remove(key)` | deletes; `resetModified()` when empty; `onAnnotationEditor(null)` when no editors remain | `:6890-6906` |
| `has(key)`, `size` | | `:6929-6934` |
| `onSetModified`, `onResetModified`, `onAnnotationEditor` | callback properties (null by default) | `:6880-6882` |
| `resetModified()` | fires `onResetModified()` if it was modified | `:6941-6946` |
| `print` | `new PrintAnnotationStorage(this)` — frozen structured clone of `serializable` for printing | `:6947-6949`, `7080-7110` |
| `serializable` | `SerializableEmpty` (`{map: null, hash: "", transfer: undefined}`) or `{map: Map<key, serialized>, hash, transfer: ImageBitmap[]}`; editors are serialized via `editor.serialize(false, context)`, plain objects are passed through as-is; entries with `page` get `pageIndex` | `:6950-6983` |
| `editorStats` | telemetry-ish counts per editor type plus `comments: {deleted, edited}` or `null` | `:6984-7037` |
| `modifiedIds` | `{ids: Set<string>, hash}` of edited existing annotations | `:7052-7075` |
| `updateEditor(annotationId, data)`, `getEditor(annotationId)`, `resetModifiedIds()` | editor bookkeeping | `:7038-7051` |
| `[Symbol.iterator]` | `storage.entries()` | `:7076-7078` |

Keys: widget annotation ids (`"9R"`) for form fields; `"pdfjs_internal_editor_N"` for new editor annotations (`AnnotationEditorPrefix`, `pdf.mjs:54`; `AnnotationPrefix = "pdfjs_internal_id_"` at `:53`).

### 3.5 `OptionalContentConfig` (`pdf.mjs:14442-14681`)

* `getOrder()` → `null` if no groups, else a copy of the `/Order` array (ids and nested arrays) or all ids (`:14641-14646`).
* `getGroup(id)` → `OptionalContentGroup | null` with `name`, `intent`, `usage`, `rbGroups`, and getter `visible` (`:14647-14649`, `14392-14427`).
* `setVisibility(id, visible = true, preserveRB = true)` → also turns off other members of the group's radio-button groups (`:14589-14606`).
* `setOCGState({state, preserveRB})` → applies an array like `["OFF", id1, "ON", id2, "Toggle", id3]` (`:14607-14637`).
* `isVisible(group)` → for `{type: "OCG", id}` or `{type: "OCMD", expression | ids, policy}` (`:14520-14588`).
* `hasInitialVisibility` (`:14638-14640`), `getHash()` (`:14650-14659`), `[Symbol.iterator]` over `[id, group]` (`:14660-14662`), `serializable` / `static fromSerializable` (`:14663-14680`), `name`, `creator`, `renderingIntent`.
* **`getGroups()` is NOT PRESENT** — iterate the config (`for (const [id, group] of config)`) or `getOrder()` + `getGroup(id)`.

---

## 4. `PDFPageProxy` (`pdf.mjs:15748-16201`, `api.d.ts:1438-1581`)

| Member | Notes | Source |
|---|---|---|
| `pageNumber` (get/set), `rotate`, `ref` (`{num, gen}` or null), `userUnit`, `view` (`[x1, y1, x2, y2]`) | | `pdf.mjs:15773-15791` |
| `getViewport({scale, rotation = this.rotate, offsetX = 0, offsetY = 0, dontFlip = false})` | returns `PageViewport` | `pdf.mjs:15792-15808` |
| `getAnnotations({intent = "display"})` | `intent` ∈ `"display" \| "print" \| "any"`; worker returns `annotation.data` for viewable (display), printable (print) or all (any) annotations | `pdf.mjs:15809-15816`, `worker:59278-59286` |
| `getJSActions()` | page-level JS actions map | `pdf.mjs:15817-15819` |
| `getXfa()` | XFA fake-DOM for this page or null | `:15826-15828` |
| `render(params)` | → `RenderTask` (§4.4) | `:15829-15959` |
| `getOperatorList({intent, annotationMode, printAnnotationStorage, isEditing})` | `Promise<{fnArray, argsArray, lastChunk, separateAnnots}>` | `:15960-15990` |
| `streamTextContent({includeMarkedContent = false, disableNormalization = false})` | `ReadableStream` of `{items, styles, lang}` chunks (100 items high-water mark) | `:15991-16005` |
| `getTextContent(params)` | concatenates the stream; for XFA documents returns `XfaText.textContent` instead | `:16006-16022` |
| `getStructTree()` | `StructTreeNode` tree (`{children, role, structId?, rowSpan?, colSpan?, headers?, scope?, short?, summary?}`, leaves `{type: "content"\|"object", id}`) | `api.d.ts:520-578` |
| `cleanup(resetStats = false)` | returns `false` (and does nothing) while any render/opList task is active or an operator list is incomplete; otherwise clears intent states and `objs` | `pdf.mjs:16047-16071` |
| `stats` | `StatTimer` when `pdfBug` | `:16198-16200` |
| `clone(id)` | copy used by the pages mapper | `:15767-15772` |

### 4.1 `PageViewport` (`pdf.mjs:806-915`, `types/src/display/page_viewport.d.ts`)

Fields: `viewBox`, `userUnit`, `scale`, `rotation`, `offsetX`, `offsetY`, `transform` (6-element matrix, `:875`), `width`, `height` (`:876-877`; `scale` is multiplied by `userUnit`, `:822`). Rotation must be a multiple of 90 or it throws `PageViewport: Invalid rotation…` (`:826-857`). Methods: `rawDims` → `{pageWidth, pageHeight, pageX, pageY}` (`:879-887`), `clone({scale, rotation, offsetX, offsetY, dontFlip})` (`:888-904`), `convertToViewportPoint(x, y)` → `[vx, vy]` (`:905-909`), `convertToPdfPoint(x, y)` → `[px, py]` (`:910-914`).

**`convertToViewportRectangle` is NOT PRESENT.** Implement it as:

```js
function pdfRectToViewport(viewport, [x1, y1, x2, y2]) {
  const [ax, ay] = viewport.convertToViewportPoint(x1, y1);
  const [bx, by] = viewport.convertToViewportPoint(x2, y2);
  return pdfjs.Util.normalizeRect([ax, ay, bx, by]);   // Util.normalizeRect: pdf.mjs:635-646
}
```

### 4.2 Annotation objects returned by `getAnnotations()`

Common fields set in the worker `Annotation` constructor (`worker:53036-53056`): `annotationType` (numeric `AnnotationType`, `AnnotationType[subtype.toUpperCase()]`), `annotationFlags` (raw `/F`), `borderStyle` (`{width, style (AnnotationBorderStyleType), dashArray, horizontalCornerRadius, verticalCornerRadius}`), `color` (`Uint8ClampedArray(3)` or null), `backgroundColor`, `borderColor`, `rotation`, `contentsObj: {str, dir}`, `hasAppearance`, `id` (e.g. `"9R"`), `modificationDate` (raw PDF date string or null), `oc`, `rect` (normalized `[x1,y1,x2,y2]`), `subtype` (`"Widget"`, `"Highlight"`, …), `hasOwnCanvas`, `noRotate` (from flag `NOROTATE`), `noHTML`, `isEditable`, `structParent`, plus `it` (`/IT` name, `:53079-53082`) and — when fields are collected — `kidIds`, `actions`, `fieldName`, `pageIndex` (`:53062-53078`). `{str, dir}` objects come from `_parseStringHelper` (`worker:53143-53150`; `dir` is `"rtl"` or `"ltr"`).

Markup annotations add (`worker:53586-53637`): `inReplyTo` (ref string), `replyType` (`"R"` or `"Group"`), `titleObj: {str, dir}` (the author `/T`), `creationDate`, `popupRef` (ref string or null), `richText` (HTML from `/RC`). Popup annotations add (`:55289-55329`): `parentRect`, `creationDate`, `modificationDate`, `color`, `titleObj`, `contentsObj`, `richText`, `open`; a zero-size popup gets `rect = null`.

Per-subtype fields (line = worker assignment): Link: `url`, `unsafeUrl`, `newWindow`, `dest`, `action`, `setOCGState`, `resetForm`, `attachment`, `attachmentDest` (set by `Catalog.parseDestDictionary`, `worker:41620-41759`); Text (sticky note): `name` icon (`:55244`); Highlight/Underline/Squiggly/StrikeOut: `quadPoints` (`Float32Array`, `:55932`, `56038`), `opacity`; Ink: `inkLists: Float32Array[]` (`:55749-55771`), `opacity`; Line: `lineCoordinates`, `lineEndings` (`:55560-55562`); Polyline/Polygon: `vertices` (`:55686`); FreeText: `defaultAppearanceData {fontSize, fontColor, …}`, `textContent`, `textPosition` (`:55366-55382`); FileAttachment: `fileId`, `file {filename, content?…}`, `name`, `fillAlpha` (`:56253-56258`); Widgets (`:53760-53824`): `fieldName`, `fieldValue`, `defaultFieldValue`, `alternativeText`, `fieldType` (`"Tx"`, `"Btn"`, `"Ch"`, `"Sig"`), `fieldFlags`, `password`, `readOnly`, `required`, `hidden` (HIDDEN or NOVIEW flag), plus text widgets `multiLine`, `maxLen`, `comb`, `textAlignment`, `datetimeFormat` (`:54347-54397`), buttons `checkBox`, `radioButton`, `pushButton`, `isTooltipOnly`, `exportValue`, `buttonValue` (`:54569-54572`, `54902`, `54926`), choices `options` (`[{exportValue, displayValue}]`), `combo`, `multiSelect` (`:55038`, `55074-55075`).

There is no separate `noView` data field — it is folded into `hidden` for widgets (`worker:53824`); test `annotationFlags & 0x20` yourself for other subtypes (flag table in §5.3).

### 4.3 `getTextContent()` item shape

`TextContent = {items, styles, lang}` (`api.d.ts:290-306`). `TextItem = {str, dir ("ttb"|"ltr"|"rtl"), transform: number[6], width, height, fontName, hasEOL}` (`api.d.ts:310-340`); `TextMarkedContent = {type: "beginMarkedContent"|"beginMarkedContentProps"|"endMarkedContent", id}` when `includeMarkedContent` (`:344-355`); `styles[fontName] = {ascent, descent, vertical, fontFamily}` (`:359-376`). All whitespace is normalised to `0x20` (`api.d.ts:1527-1528`). The worker emits `hasEOL: true` on the item that ends a line (`worker:35996-36001`) and, when no item is open, pushes an empty item `{str: "", dir: "ltr", width: 0, height: 0, transform, fontName, hasEOL: true}` (`:36003-36011`). EOL is decided from geometry: a backwards x-advance with a y jump > ½ line height (`:35857-35861`) or a y jump larger than the item height (`:35868-35871`).

### 4.4 `render(params)` and `RenderTask`

Destructured parameters (`pdf.mjs:15829-15845`; docs `api.d.ts:391-485`):

| Param | Default | Notes |
|---|---|---|
| `canvas` | `canvasContext.canvas` | Preferred. If you pass **neither** `canvas` nor `canvasContext` the destructuring throws a `TypeError`. To render into a context that has no `.canvas` you *must* pass `canvas: null, canvasContext: ctx` (`pdf.mjs:17055-17056`). |
| `canvasContext` | — | back-compat |
| `viewport` | — | required |
| `intent` | `"display"` | `"display" \| "print" \| "any"`; unknown values warn and fall back to display (`pdf.mjs:16436-16450`) |
| `annotationMode` | `AnnotationMode.ENABLE` (1) | `DISABLE = 0`, `ENABLE = 1`, `ENABLE_FORMS = 2`, `ENABLE_STORAGE = 3` (`pdf.mjs:47-52`); mapped to `RenderingIntentFlag` bits at `:16452-16467` |
| `transform` | `null` | extra 6-element matrix applied before the viewport transform |
| `background` | `null` → `"rgb(255,255,255)"` | any `fillStyle` |
| `optionalContentConfigPromise` | `null` → fetched with the same intent | must come from `getOptionalContentConfig({intent})` with the same intent (`:15949-15951`) |
| `annotationCanvasMap` | `null` | `Map<annotationId, HTMLCanvasElement>` |
| `pageColors` | `null` | `{background, foreground}` for HCM |
| `printAnnotationStorage` | `null` | only used when `intent` includes print (`:16451`) |
| `isEditing` | `false` | adds `IS_EDITING` flag |
| `recordImages`, `recordOperations`, `operationsFilter(index, operatorList)` | `false`/`null` | new in 6.x (`api.d.ts:471-486`) |

Rendering the same canvas twice concurrently throws `Cannot use the same canvas during multiple render() operations…` (`pdf.mjs:17074`). Print-intent renders schedule page cleanup automatically (`:15888-15890`). Display renders are paced with `requestAnimationFrame` (`:15935`, `17047`).

`RenderTask` (`pdf.mjs:16984-17012`): `promise` (`Promise<void>`), `cancel(extraDelay = 0)`, `onContinue(cont)` (called when rendering pauses; call `cont()` to resume — `:17137-17138`), `onError(err)` (sync callback on error or cancel, `:17118`), `separateAnnots` (boolean), `imageCoordinates`. Cancelling rejects `promise` with `RenderingCancelledException` (`name === "RenderingCancelledException"`, has `.extraDelay`; `pdf.mjs:1281-1286`, `17116`). Standard pattern:

```js
const task = page.render({ canvas, viewport });
try { await task.promise; }
catch (e) { if (!(e instanceof pdfjs.RenderingCancelledException)) throw e; }
```

---

## 5. Exports of `build/pdf.mjs` and enum values

The single export statement is at `pdf.mjs:28209` (identical list in `legacy/build/pdf.mjs:34670` and `types/src/pdf.d.ts:69`):

`AbortException, AnnotationEditorLayer, AnnotationEditorParamsType, AnnotationEditorType, AnnotationEditorUIManager, AnnotationLayer, AnnotationMode, AnnotationType, CSSConstants, ColorPicker, DOMSVGFactory, DrawLayer, FeatureTest, GlobalWorkerOptions, ImageKind, InvalidPDFException, MathClamp, OPS, OutputScale, PDFDataRangeTransport, PDFDateString, PDFWorker, PasswordException, PasswordResponses, PermissionFlag, PixelsPerInch, RenderingCancelledException, ResponseException, SignatureExtractor, SupportedImageMimeTypes, TextLayer, TextLayerImages, TouchManager, Util, VerbosityLevel, XfaLayer, applyOpacity, build, createValidAbsoluteUrl, fetchData, findContrastColor, getDocument, getFilenameFromUrl, getPdfFilenameFromUrl, getRGB, getRGBA, getUuid, isDataScheme, isPdfFile, isValidExplicitDest, makeArr, makeMap, makeObj, makeSet, noContextMenu, normalizeUnicode, renderRichText, setLayerDimensions, shadow, stopEvent, updateUrlHash, version`

### 5.1 Enum values (copied from `pdf.mjs`)

```js
AnnotationEditorType  (pdf.mjs:55-65):  DISABLE: -1, NONE: 0, FREETEXT: 3, HIGHLIGHT: 9, STAMP: 13, INK: 15, POPUP: 16, SIGNATURE: 101, COMMENT: 102
AnnotationEditorParamsType (pdf.mjs:66-81): RESIZE: 1, CREATE: 2, FREETEXT_SIZE: 11, FREETEXT_COLOR: 12, FREETEXT_OPACITY: 13,
    INK_COLOR: 21, INK_THICKNESS: 22, INK_OPACITY: 23, INK_COLOR_AND_OPACITY: 24,
    HIGHLIGHT_COLOR: 31, HIGHLIGHT_THICKNESS: 32, HIGHLIGHT_FREE: 33, HIGHLIGHT_SHOW_ALL: 34, DRAW_STEP: 41
AnnotationMode (pdf.mjs:47-52): DISABLE: 0, ENABLE: 1, ENABLE_FORMS: 2, ENABLE_STORAGE: 3
AnnotationType (pdf.mjs:114-142): TEXT: 1, LINK: 2, FREETEXT: 3, LINE: 4, SQUARE: 5, CIRCLE: 6, POLYGON: 7, POLYLINE: 8,
    HIGHLIGHT: 9, UNDERLINE: 10, SQUIGGLY: 11, STRIKEOUT: 12, STAMP: 13, CARET: 14, INK: 15, POPUP: 16, FILEATTACHMENT: 17,
    SOUND: 18, MOVIE: 19, WIDGET: 20, SCREEN: 21, PRINTERMARK: 22, TRAPNET: 23, WATERMARK: 24, THREED: 25, REDACT: 26, RICHMEDIA: 27
PermissionFlag (pdf.mjs:82-91): PRINT: 0x04, MODIFY_CONTENTS: 0x08, COPY: 0x10, MODIFY_ANNOTATIONS: 0x20,
    FILL_INTERACTIVE_FORMS: 0x100, COPY_FOR_ACCESSIBILITY: 0x200, ASSEMBLE: 0x400, PRINT_HIGH_QUALITY: 0x800
PasswordResponses (pdf.mjs:326-329): NEED_PASSWORD: 1, INCORRECT_PASSWORD: 2
VerbosityLevel (pdf.mjs:221-225): ERRORS: 0, WARNINGS: 1, INFOS: 5
ImageKind (pdf.mjs:109-113): GRAYSCALE_1BPP: 1, RGB_24BPP: 2, RGBA_32BPP: 3
OPS (pdf.mjs:226-318): dependency: 1 … rawFillPath: 94
```

### 5.2 Utility exports

| Export | Signature / notes | Source |
|---|---|---|
| `Util.transform(m1, m2)` | returns a **new** 6-element matrix | `pdf.mjs:547-549` |
| `Util.applyTransform(p, m, pos = 0)` | **mutates `p` in place and returns `undefined`** (older versions returned a new array — do not write `const [x,y] = Util.applyTransform(...)`) | `:553-558` |
| `Util.applyInverseTransform(p, m)` | in place, returns `undefined` | `:573-579` |
| `Util.applyTransformToBezier(p, m, pos)`, `Util.inverseTransform(m)` (returns array), `Util.normalizeRect(rect)` (returns new array), `Util.intersect(r1, r2)` (`number[] \| null`), `Util.axialAlignedBoundingBox`, `Util.singularValueDecompose2dScale`, `Util.bezierBoundingBox`, `Util.rectBoundingBox`, `Util.pointBoundingBox`, `Util.multiplyByDOMMatrix`, `Util.makeHexColor(r, g, b)` | | `:544-699`, `util.d.ts:408-426` |
| `createValidAbsoluteUrl(url, baseUrl = null, options = null)` | `URL \| null`; `options.addDefaultProtocol` (prefix `http://` to `www.x.y`), `options.tryConvertEncoding` | `:369-388` |
| `updateUrlHash(url, hash, allowRel = false)` | | `:389-399` |
| `getFilenameFromUrl(url)` | strips `#`/`?` and path | `:1298-1301` |
| `getPdfFilenameFromUrl(url, defaultFilename = "document.pdf")` | | `:1302-…` |
| `isPdfFile(name)` / `isDataScheme(url)` | | `:1295-1297`, `1287` |
| `PDFDateString.toDateObject(input)` | `Date \| null` from `"D:YYYYMMDDHHmmSSOHH'mm'"`; also accepts a `Date` | `:1416-1455` |
| `shadow(obj, prop, value, nonSerializable = false)` | define-once cached property | `:403` |
| `fetchData(url, type = "text")` | `"blob" \| "bytes" \| "json" \| "text"`; `fetch` for http(s) else XHR | `:1239-1280` |
| `setLayerDimensions(div, viewport, mustFlip = false, mustRotate = true)` | sets `width/height` CSS using `--total-scale-factor`, `--scale-round-x/y` and `data-main-rotation` | `:1517-1539` |
| `OutputScale` | `new OutputScale()` → `sx = sy = devicePixelRatio`; `scaled`, `symmetric`, `limitCanvas(width, height, maxPixels, maxDim, capAreaFactor = -1)` → `true` when it clamped; `static pixelRatio`, `static capPixels` | `:1540-1584` |
| `PixelsPerInch` | `CSS = 96`, `PDF = 72`, `PDF_TO_CSS_UNITS = 96/72` | `:1234-1238` |
| `stopEvent(e)` / `noContextMenu(e)` | `preventDefault`(+`stopPropagation`) | `:1409-1412`, `1406-1408` |
| `SupportedImageMimeTypes` | `Set` of apng, avif, bmp, gif, jpeg, png, svg+xml, webp, x-icon | `:1585` |
| `MathClamp(v, min, max)` | | `:800-802` |
| `isValidExplicitDest(dest)` | validates explicit destination arrays | `:8617` |
| `getRGB(color)`, `getRGBA(color)`, `applyOpacity`, `findContrastColor`, `renderRichText({html, dir, className}, container)`, `CSSConstants.commentForegroundColor`, `FeatureTest.*` (`isOffscreenCanvasSupported`, `platform`, …), `getUuid`, `normalizeUnicode`, `makeArr/makeMap/makeObj/makeSet` | | `:1456-1734`, `util.d.ts:180-190` |
| `version`, `build` | `"6.4.299"`, `"d0991a0d5"` | `:17168-17169` |

Classes:

* **`TextLayer`** (`pdf.mjs:15006-15396`): `new TextLayer({textContentSource: ReadableStream | TextContent, container: HTMLElement, viewport, images?})` (`:15032-15076`; throws `No "textContentSource" parameter specified.`); `render(): Promise` (`:15084-15107`); `update({viewport, onBefore})` (`:15108-15136`); `cancel()`; `textDivs`, `textContentItemsStr`; `static cleanup()` (`:15284`). It reads `viewport.rawDims` and `viewport.scale * devicePixelRatio`.
* **`AnnotationLayer`** (`pdf.mjs:20819-21199`): constructor `{div, accessibilityManager, annotationCanvasMap, annotationEditorUIManager, page, viewport, structTreeLayer, commentManager, linkService, annotationStorage}` (`:20829-20851`); `render({annotations, optionalContentConfig, downloadManager, imageResourcesPath, renderForms (default true), enableComment, enableScripting, hasJSActions, fieldObjects, …})` (`:20855-20879`, d.ts `annotation_layer.d.ts:27-56`); `update({viewport, optionalContentConfig})`, `destroy()`, `hasEditableAnnotations()`, `getEditableAnnotations()`, `addLinkAnnotations()`. It skips annotations with `noHTML` or zero-area `rect` (`:20880-20888`).
* **`DrawLayer`** (`pdf.mjs:27496-…`): `new DrawLayer({filterFactory = null, pageColors = null, pageIndex, textLayer = null})` (`:27511-27516`); `setParent`, `draw`, `drawOutline`, `finalizeDraw`, `updateProperties`, `remove`, `destroy` (`draw_layer.d.ts:129-142`).
* **`AnnotationEditorLayer`** constructor `{uiManager, pageIndex, div, structTreeLayer, accessibilityManager, annotationLayer, drawLayer, textLayer, viewport, l10n}` (`pdf.mjs:26735-26746`).
* **`AnnotationEditorUIManager`** constructor takes 16 positional arguments: `(container, viewer, viewerAlert, altTextManager, commentManager, signatureManager, eventBus, pdfDocument, pageColors, highlightColors, enableHighlightFloatingButton, enableUpdatedAddImage, enableNewAltTextWhenAddingImage, mlManager, editorUndoBar, supportsPinchToZoom)` (`pdf.mjs:2681`).
* **`ColorPicker`** `{editor = null, uiManager = null}` (`:17190-17192`); **`DOMSVGFactory`** (`:17583-17587`); **`TouchManager`** `{container, isPinchingDisabled, isPinchingStopped, onPinchStart, onPinching, onPinchEnd, onPanning, signal}` (`:4837-4845`); **`TextLayerImages`** `(minSize, coordinates, viewport, getPageCanvas)` (`:28032-28038`); **`SignatureExtractor`** static `extractContoursFromText` (`:25378`), `process(bitmap, pageWidth, pageHeight, rotation, innerMargin)` (`:25430`), `processDrawnLines` (`:25449`), `compressSignature` (`:25521`), `decompressSignature` (`:25580`); **`XfaLayer.render({annotationStorage, linkService, xfaHtml, intent, div, viewport})`** (`:1119-1137`) and `XfaLayer.update` (`:1207-1210`); **`PDFDataRangeTransport(length, initialData, progressiveDone?, contentDispositionFilename?)`** (`api.d.ts:758-788`).

### 5.3 NOT PRESENT / not exported (and what to use instead)

| Asked for | Status | Replacement |
|---|---|---|
| `AnnotationFlag` | defined but **tree-shaken to `null`** (`pdf.mjs:154-165` is `null && ({...})`) and not exported | define your own: `INVISIBLE 0x01, HIDDEN 0x02, PRINT 0x04, NOZOOM 0x08, NOROTATE 0x10, NOVIEW 0x20, READONLY 0x40, LOCKED 0x80, TOGGLENOVIEW 0x100, LOCKEDCONTENTS 0x200` (`pdf.mjs:155-164`) |
| `AnnotationFieldFlag`, `AnnotationReplyType`, `AnnotationBorderStyleType`, `RenderingIntentFlag`, `TextRenderingMode` | defined (`pdf.mjs:166-193`, `36-46`, `97-108`) but not exported | copy values; `AnnotationBorderStyleType` = `SOLID 1, DASHED 2, BEVELED 3, INSET 4, UNDERLINE 5` |
| `MissingPDFException`, `UnexpectedResponseException` | NOT PRESENT | `ResponseException` (`.status`, `.missing`) |
| `getXfaPageViewport` | NOT PRESENT (0 matches in `pdf.mjs`) | build a `PageViewport` from `page.getViewport()`; XFA pages use `XfaLayer.render({viewport})` |
| `noContextNenu` | typo; the export is `noContextMenu` (`pdf.mjs:1406`) | |
| `CommentEditor` | NOT PRESENT (0 matches). Comments are a `Comment` helper (`pdf.mjs:4751-4761`) attached to any editor and serialized as `popup` | see §6 |
| `PageViewport.convertToViewportRectangle`, `OptionalContentConfig.getGroups`, `Metadata.getAll/has`, `PDFDocumentProxy.destroy`, `getPageJSActions`, `CMapReaderFactory`, `StandardFontDataFactory`, `isEvalSupported`, `length` in init params | NOT PRESENT | see §3, §4 |
| `maxCanvasPixels` | not a core-API option (0 matches in `pdf.mjs`); it is a viewer `AppOptions` entry, default `2 ** 25` (`viewer.mjs:4544-4546`), compat value `5242880` (`:4356`) | use `OutputScale.limitCanvas` yourself (§9) |

---

## 6. What `saveDocument()` writes for editor annotations (and how Acrobat will see them)

### 6.1 What the editors serialize (main thread)

Base `AnnotationEditor.serialize()` (`pdf.mjs:6358-6366`) returns `{annotationType: this.mode, pageIndex, rect (PDF user-space [x1,y1,x2,y2]), rotation, structTreeParentId, popupRef}`; deleted editors return `serializeDeleted()` = `{id, deleted: true, pageIndex, popupRef}` (`:6350-6356`). `addComment(serialized)` adds `popup: {contents, deleted, rect}` when the comment was edited (`:5973-5989`); the `Comment` object itself is `{text, richText, date, deleted}` (`:4754-4761`). Editors that already correspond to an existing annotation add `id` (the `"NNR"` ref string) and return `null` when nothing changed.

| Editor | Extra serialized fields | Source |
|---|---|---|
| `FreeTextEditor` | `color` (RGB array), `fontSize`, `value` (text with `\n`) | `pdf.mjs:21772-21795` |
| `InkEditor` | `color`, `opacity`, `thickness`, `paths: {lines, points}` (`lines[i]` = flat bezier command array, `points[i]` = flat polyline) | `:24959-24996`, `24369-24432` |
| `HighlightEditor` | `color`, `opacity`, `thickness`, `quadPoints` (flat array, 8 numbers per quad) **or** `outlines` for free-hand highlights | `:24021-24042`, `23420-23441`, `23462-23475` |
| `StampEditor` | `bitmapId`, `isSvg`, `accessibilityData {type:"Figure", alt, structParent?}`, and `bitmap` (an `ImageBitmap`, transferred to the worker) | `:26617-26679`, `6968-6976` |
| `SignatureEditor` | `isSignature: true`, `areContours`, `color: [0,0,0]`, `thickness`, `lines`, optional `accessibilityData` | `:25962-25999` |

**Author:** the editors never set a `user` field (grep for `\buser\b` in `pdf.mjs` returns nothing), and never set `date` (only `Comment.data` has one). See §6.3.

### 6.2 What the worker writes (`worker:52787-52861` dispatch; writers below)

Dispatch by `annotationType` (`worker:52797-52856`): `FREETEXT` → `FreeTextAnnotation` (a shared `/Helv` Type1 Helvetica/WinAnsi font object is created once, `:52799-52809`); `HIGHLIGHT` with `quadPoints` → `HighlightAnnotation`, without → `InkAnnotation`; `INK` → `InkAnnotation`; `STAMP` → `StampAnnotation` with the generated image XObject (`:52826-52852`); `SIGNATURE` → `StampAnnotation` with a vector appearance (`:52853-52855`). **There is no `COMMENT` or `POPUP` case**: comments only exist as the `popup` of another annotation. Entries with `deleted: true` are skipped here and instead removed from the page `/Annots` and written as deleted objects (`:52794-52796`, `59013-59021`, `59051`, `59065-59069`).

Generic `createNewAnnotation` (`worker:53690-53734`): allocates a ref, writes the appearance stream object, builds the dict, sets `/StructParent`, and if `popup` exists writes a `/Popup` annotation (`PopupAnnotation.createNewDict`, `:55331-55344`: `/Type /Annot /Subtype /Popup /Open false /Rect /Parent`) and sets `/Popup` + **`/Contents = popup.contents`** on the parent (`:53721-53731`). A deleted popup removes `/Popup`, `/Contents`, `/RC` (`:53715-53720`).

| Result | Dict written | Appearance | Acrobat-visible? |
|---|---|---|---|
| **FreeText** (`worker:55396-55431`) | `/Type /Annot /Subtype /FreeText`, `/CreationDate` (new) or `/M` (edit), `/Rect`, `/DA "/Helv <size> Tf r g b rg"`, `/Contents = value`, `/F 4`, `/Border [0 0 0]`, `/Rotate`, `/T = user` (only if defined), `/AP << /N ref >>` | `createNewAppearanceStream` (`:55441-…`) draws the text with the `/Helv` font, scaled to fit; returns `null` (→ no `/AP`) if a line is not encodable in WinAnsi (`:55486-55488`) or no `color` | Yes: real `/FreeText` with `/DA` + appearance stream |
| **Highlight** (`:55955-55987`) | `/Subtype /Highlight`, `/CreationDate`/`/M`, `/Rect`, `/F 4`, `/Border`, `/Rotate`, **`/QuadPoints`**, `/C` (rgb 0-1), `/CA` opacity, `/T` if defined, `/AP` | `:55988-56029`: polygon fill from `outlines`, `ExtGState /R0 /BM /Multiply`, `/ca` when opacity ≠ 1 | Yes: `/Highlight` + `QuadPoints` (verified in §8.3 output) |
| **Ink** (`:55803-55844`) | `/Subtype /Ink`, `/CreationDate`/`/M`, `/Rect`, **`/InkList`** (= `outlines?.points || paths.points`), `/F 4`, `/Rotate`, `/T`, `/IT /InkHighlight` for free highlights, `/BS << /W thickness >>`, `/C`, `/CA`, `/AP` | `:55845-55885`: stroked bezier path from `paths.lines` (`writeLineToCurveToAppearance`, `:52987-53000`: `data[4],data[5]` = moveTo, then groups of 6 → `c`, or `l` when the group starts with `NaN`), `/R0` ExtGState with `/CA` | Yes: `/Ink` with `InkList` |
| **Stamp** (`:56158-56184`) | `/Subtype /Stamp`, `/CreationDate`/`/M`, `/Rect`, `/F 4`, `/Border`, `/Rotate`, `/T`, `/AP` | `:56210-56241`: form XObject `q w 0 0 h 0 0 cm /Im0 Do Q` with `/Resources /XObject /Im0` → the bitmap written as an **image XObject**: `createImage` (`worker:41874-41966`) draws the `ImageBitmap` on an `OffscreenCanvas`, uses Flate (PNG-predictor) for images with ≤ threshold colours or any alpha, else `DCTDecode` JPEG at quality 1; alpha goes to an `/SMask` DeviceGray image (`:41944-41958`, `52833-52839`). Requires `OffscreenCanvas` in the worker; in Node it warns `generateImages: OffscreenCanvas is not supported…` (observed) and the image is skipped. | Yes: `/Stamp` with embedded image |
| **Signature** | `/Stamp` dict as above (`isSignature`) | `#createNewAppearanceStreamForDrawing` (`:56185-56209`): vector strokes (`S`) or filled contours (`F`) | Yes (as a stamp, not a `/Sig` field) |
| **Comment** | `/Popup` + parent `/Contents` (and `/RC` is deleted on edit, `:55415`) | none | Yes (sticky-note popup in Acrobat) |

Editing an existing annotation: the serialized `id` is turned into a ref, the original dict is fetched and cloned as `oldAnnotation` (`worker:59002-59039`), and the writers mutate that clone (`setIfNotExists` keeps original `/Type`/`/Subtype`, `/M` is updated instead of `/CreationDate`).

### 6.3 Author `/T` and dates — practical consequence for Folio

`/T` is written with `setIfDefined("T", stringToAsciiOrUTF16BE(user))` in every writer (`worker:55424`, `55827`, `55980`, `56177`), but **no built-in editor ever supplies `user`**, so out of the box new annotations have **no author**. Dates default to "now" because `getModificationDate(date = new Date())` (`worker:1718-1724`) accepts `undefined`.

Options verified against the code:

1. If Folio writes annotation entries itself (plain objects via `annotationStorage.setValue("pdfjs_internal_editor_<n>", {...})`), include `user: "<author>"` and optionally `date`. Verified in §8.3: `/T (Folio User)` appears.
2. If Folio uses the pdf.js editors, inject the author by wrapping the `serializable` getter on the document's storage instance (the transport reads `this.annotationStorage.serializable`, `pdf.mjs:16755`, `16782`, `16097-16103`):

```js
const proto = Object.getPrototypeOf(pdfDocument.annotationStorage);
const desc = Object.getOwnPropertyDescriptor(proto, "serializable");
Object.defineProperty(pdfDocument.annotationStorage, "serializable", {
  get() {
    const s = desc.get.call(this);
    if (s.map) for (const v of s.map.values()) if (v && !v.deleted && v.user === undefined) v.user = currentAuthor;
    return s;
  },
});
```
3. Or post-process the saved bytes with pdf-lib and set `/T` on annotations that lack it.

Note the quirk at `worker:53727`: when a FreeText has a comment, its `/Contents` becomes the comment text (verified in §8.3), the typed text lives only in `/DA` + the appearance stream.

### 6.4 Form-field values

`WidgetAnnotation.save` (`worker:53953-54040`) reads `annotationStorage.get(this.data.id)` — an entry `{value, rotation?, noView?, noPrint?}`; `value` is a string (text, choice) or array (multi-select), boolean for checkboxes (`_saveCheckbox`, `:54645-54661`), radio buttons via `_saveRadioButton` (`:54694`). Unchanged values are skipped (`:53958-53966`). It copies the original dict minus `/AP`, sets `/V` through `setValue` (`:54008`), sets `/MK` for rotation, and writes a fresh `/AP /N` form XObject (`:54019-54030`) unless `NeedAppearances` is required. Text widgets also honour `/PMD` barcodes as hidden (`:54336-54340`).

```js
const [annot] = await page.getAnnotations();        // annot.id === "9R", annot.fieldType === "Tx"
pdfDocument.annotationStorage.setValue(annot.id, { value: "Bob" });
const bytes = await pdfDocument.saveDocument();     // Uint8Array, incremental update
```

---

## 7. Text extraction ("export as text")

```js
async function pageToText(page) {
  const { items } = await page.getTextContent();      // pdf.mjs:16006-16021
  const lines = [];
  let line = "";
  let lastY = null;
  for (const item of items) {
    if (!("str" in item)) continue;                     // skip TextMarkedContent when includeMarkedContent
    const y = item.transform[5];                        // transform = [a, b, c, d, e, f]; e,f = baseline origin in PDF user space (api.d.ts:322)
    if (lastY !== null && !line.endsWith("\n") && Math.abs(y - lastY) > item.height * 0.5 && line) {
      lines.push(line); line = "";                      // fallback for producers whose items never carry hasEOL
    }
    line += item.str;
    if (item.hasEOL) { lines.push(line); line = ""; }   // worker:35996-36012 sets hasEOL on the last item of a line
    lastY = y;
  }
  if (line) lines.push(line);
  return lines.join("\n");
}
```

Notes: `str` may be `""` with `hasEOL: true` for blank lines (`worker:36003-36011`); items are in content-stream order, not visual order — for columnar layouts sort by `transform[5]` descending then `transform[4]` ascending before joining; `dir === "rtl"` items are already bidi-processed strings (`worker:35740-35753`). Use `disableNormalization: true` if you need the raw code points (`api.d.ts:281-285`). `styles[item.fontName].fontFamily` tells you the substituted font.

---

## 8. Node usage for unit tests (Node 22.22.0, verified by execution)

* Import `pdfjs-dist/legacy/build/pdf.mjs` (deep paths are allowed because `package.json` has no `exports` map). The bare `pdfjs-dist` resolves to the modern `build/pdf.mjs`, which works on Node 22.22 but prints `Warning: Please use the \`legacy\` build in Node.js environments.` (`pdf.mjs:9588-9590`).
* No worker setup is needed: `PDFWorker` disables the real worker in Node and sets `GlobalWorkerOptions.workerSrc ||= "./pdf.worker.mjs"` (`pdf.mjs:16211-16214`), which the fake worker loads with `import()` relative to the pdf.mjs module (`:16377-16380`) — the §8.1 output shows `workerSrc === "./pdf.worker.mjs"` and `port ctor: LoopbackPort`.
* Node defaults: `disableFontFace = true`, `useSystemFonts = false`, `isOffscreenCanvasSupported = false`, `isImageDecoderSupported = false`, `useWorkerFetch = false` (`pdf.mjs:15420-15440`), so CMaps/fonts/wasm are read with `fs/promises.readFile(url)` by `NodeBinaryDataFactory` (`pdf.mjs:9591-9594`, `9604-9608`). Therefore `standardFontDataUrl`, `cMapUrl`, `wasmUrl` must be **filesystem paths ending in `/`** (e.g. `<pkg>/standard_fonts/`), not `file://` URLs.
* `url:` strings without a scheme are turned into `file://` URLs and streamed with `PDFNodeStream` (`pdf.mjs:8577-8583`, `14338-14340`).
* **Canvas is only needed for `render()`**: `NodeCanvasFactory._createCanvas` lazily `require`s `@napi-rs/canvas` (`pdf.mjs:9597-9603`); `getAnnotations`, `getTextContent`, `getFieldObjects`, `getMetadata`, `saveDocument` never touch it (verified below — `@napi-rs/canvas` is installed but unused in the run). Stamps with images cannot be saved in Node (`OffscreenCanvas` required, `worker:41887`).
* Pass `Uint8Array`, never `Buffer` (`pdf.mjs:8592-8594`); `fs.readFileSync` returns a Buffer → `new Uint8Array(buf.buffer, buf.byteOffset, buf.length)` (a view; copied by `getDataProp` because it does not span the whole pool buffer) or `Uint8Array.from(buf)`.
* Always `await task.destroy()` at the end of each test.

### 8.1 Round-trip script (pdf-lib → pdf.js → `saveDocument` → pdf-lib)

File: `/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad/pdfjs-roundtrip.mjs` (run with `cd /home/user/claude/folio && node <file>`; the `createRequire("/home/user/claude/folio/package.json")` lines only exist because the script lives outside the project — inside `tests/unit/*.test.mjs` use plain `import { PDFDocument } from "pdf-lib"` and `import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"`).

```js
// Round-trip test: pdf-lib -> pdf.js (legacy build, Node 22) -> saveDocument -> pdf-lib
import { createRequire as _cr } from "node:module";
const _req = _cr("/home/user/claude/folio/package.json");
const { PDFDocument } = _req("pdf-lib");
const pdfjs = await import(_req.resolve("pdfjs-dist/legacy/build/pdf.mjs"));
import path from "node:path";

const require = _req;
const pdfjsRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
const STANDARD_FONTS = path.join(pdfjsRoot, "standard_fonts") + "/";
const CMAPS = path.join(pdfjsRoot, "cmaps") + "/";
const WASM = path.join(pdfjsRoot, "wasm") + "/";

console.log("pdfjs version/build:", pdfjs.version, pdfjs.build);
console.log("GlobalWorkerOptions.workerSrc (after import, before any getDocument):", JSON.stringify(pdfjs.GlobalWorkerOptions.workerSrc));

// 1. Build a 1-page PDF with one AcroForm text field using pdf-lib
const src = await PDFDocument.create();
const page = src.addPage([300, 200]);
const form = src.getForm();
const tf = form.createTextField("customer.name");
tf.setText("Alice");
tf.addToPage(page, { x: 20, y: 120, width: 200, height: 30 });
src.setTitle("Roundtrip test");
const originalBytes = await src.save(); // Uint8Array

// 2. Copy before handing to pdf.js (the buffer gets transferred to the worker)
const forPdfjs = originalBytes.slice();
const task = pdfjs.getDocument({
  data: forPdfjs,
  standardFontDataUrl: STANDARD_FONTS,
  cMapUrl: CMAPS,
  cMapPacked: true,
  wasmUrl: WASM,
  verbosity: pdfjs.VerbosityLevel.ERRORS,
});
console.log("GlobalWorkerOptions.workerSrc (after getDocument):", JSON.stringify(pdfjs.GlobalWorkerOptions.workerSrc));
const doc = await task.promise;
console.log("buffer neutered after getDocument? forPdfjs.byteLength =", forPdfjs.byteLength, "| originalBytes.byteLength =", originalBytes.byteLength);
console.log("worker port is a real Worker?", typeof Worker !== "undefined" && task._worker.port instanceof Worker, "| port ctor:", task._worker.port.constructor.name);

console.log("numPages:", doc.numPages);
console.log("fingerprints:", doc.fingerprints);
const fields = await doc.getFieldObjects();
console.log("getFieldObjects():", JSON.stringify(Object.fromEntries(fields), null, 1));
const { info } = await doc.getMetadata();
console.log("getMetadata().info:", JSON.stringify(info));

const p1 = await doc.getPage(1);
const annots = await p1.getAnnotations({ intent: "display" });
console.log("getAnnotations(): count =", annots.length, "| id =", annots[0].id, "| subtype =", annots[0].subtype, "| annotationType =", annots[0].annotationType, "| fieldName =", annots[0].fieldName, "| fieldValue =", annots[0].fieldValue, "| fieldType =", annots[0].fieldType);
const text = await p1.getTextContent();
console.log("getTextContent(): items =", text.items.length, "(no canvas needed)");

// 3. Change the field value through annotationStorage, keyed by annotation id
const fieldId = annots[0].id;
doc.annotationStorage.setValue(fieldId, { value: "Bob" });
console.log("annotationStorage.size =", doc.annotationStorage.size, "| getValue:", doc.annotationStorage.getValue(fieldId, {}));

// 4. saveDocument -> incremental update bytes
const saved = await doc.saveDocument();
console.log("saveDocument(): type =", saved.constructor.name, "| length =", saved.length, "(original", originalBytes.length + ")");
console.log("saved starts with original bytes?", Buffer.compare(Buffer.from(saved.subarray(0, originalBytes.length)), Buffer.from(originalBytes)) === 0);
console.log("tail of saved file:", JSON.stringify(Buffer.from(saved.subarray(saved.length - 60)).toString("latin1")));
await task.destroy();

// 5. Reload saved bytes with pdf-lib and read the field value
const reloaded = await PDFDocument.load(saved);
console.log("pdf-lib after reload: customer.name =", JSON.stringify(reloaded.getForm().getTextField("customer.name").getText()));
```

Output (verbatim):

```
pdfjs version/build: 6.4.299 d0991a0d5
GlobalWorkerOptions.workerSrc (after import, before any getDocument): "./pdf.worker.mjs"
GlobalWorkerOptions.workerSrc (after getDocument): "./pdf.worker.mjs"
buffer neutered after getDocument? forPdfjs.byteLength = 0 | originalBytes.byteLength = 1613
worker port is a real Worker? false | port ctor: LoopbackPort
numPages: 1
fingerprints: [ '80f99a396933cf28d2abf24506d2169a', null ]
getFieldObjects(): {
 "customer": [ { "id": "7R", "actions": null, "name": "customer", "strokeColor": null, "fillColor": null, "type": "", "kidIds": [ "8R" ], "page": -1, "rotation": 0 } ],
 "customer.name": [
  { "id": "8R", "actions": null, "name": "customer.name", "strokeColor": null, "fillColor": null, "type": "", "kidIds": [ "9R" ], "page": -1, "rotation": 0 },
  { "id": "9R", "value": "Alice", "defaultValue": "", "multiline": false, "password": false, "charLimit": 0, "comb": false, "editable": true, "hidden": false,
    "name": "customer.name", "rect": [ 19.5, 119.5, 220.5, 150.5 ], "actions": null, "page": 0,
    "strokeColor": { "0": 0, "1": 0, "2": 0 }, "fillColor": { "0": 255, "1": 255, "2": 255 }, "rotation": 0, "hasDatetimeHTML": false, "type": "text" }
 ]
}
getMetadata().info: {"PDFFormatVersion":"1.7","Language":null,"EncryptFilterName":null,"IsLinearized":false,"IsAcroFormPresent":true,"IsXFAPresent":false,"IsCollectionPresent":false,"IsSignaturesPresent":false,"Producer":"pdf-lib (https://github.com/Hopding/pdf-lib)","ModDate":"D:20261017175459Z","Creator":"pdf-lib (https://github.com/Hopding/pdf-lib)","CreationDate":"D:20261017175459Z","Title":"Roundtrip test"}
getAnnotations(): count = 1 | id = 9R | subtype = Widget | annotationType = 20 | fieldName = customer.name | fieldValue = Alice | fieldType = Tx
getTextContent(): items = 0 (no canvas needed)
annotationStorage.size = 1 | getValue: { value: 'Bob' }
saveDocument(): type = Uint8Array | length = 2354 (original 1613)
saved starts with original bytes? true
tail of saved file: "> stream\n\u0001\u0006N\u0001\u0006Æ\u0001\u0007\u0001\b\nendstream\nendobj\nstartxref\n2186\n%%EOF\n"
pdf-lib after reload: customer.name = "Bob"
```

(The JSON block above is reformatted onto fewer lines; values are unchanged. `strokeColor`/`fillColor` print as `{0,1,2}` objects because they are `Uint8ClampedArray`s.)

### 8.2 Extra checks (`/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad/pdfjs-extra-checks.mjs`)

Output (verbatim, trimmed to the relevant lines):

```
Node v22.22.0 | Map.prototype.getOrInsertComputed: function | Math.sumPrecise: function | Uint8Array.prototype.toBase64: function | Promise.withResolvers: function | URL.parse: function
Warning: Please use the `legacy` build in Node.js environments.
modern build import OK; version 6.4.299
Buffer -> Please provide binary data as `Uint8Array`, rather than `Buffer`.
subarray view: original buffer byteLength after load = 585 (not neutered)
ArrayBuffer: byteLength after load = 0 (neutered)
Warning: saveDocument called while `annotationStorage` is empty, please use the getData-method instead.
saveDocument() w/ empty storage: length 575 == original 575 -> true
getData() length 575
```

### 8.3 Writing editor-style annotations without the editor UI (same script)

```js
const P = pdfjs.AnnotationEditorType;
d3.annotationStorage.setValue("pdfjs_internal_editor_0", { annotationType: P.FREETEXT, color: [255, 0, 0], fontSize: 12, value: "Hello Folio",
  pageIndex: 0, rect: [20, 200, 200, 240], rotation: 0, structTreeParentId: null, popupRef: "", user: "Folio User",
  popup: { contents: "A comment", deleted: false, rect: [301, 140, 481, 240] } });
d3.annotationStorage.setValue("pdfjs_internal_editor_1", { annotationType: P.HIGHLIGHT, color: [255, 255, 0], opacity: 1, thickness: 12, pageIndex: 0,
  rect: [20, 100, 120, 120], rotation: 0, structTreeParentId: null, popupRef: "",
  quadPoints: [20, 120, 120, 120, 20, 100, 120, 100], outlines: [[20, 100, 120, 100, 120, 120, 20, 120]] });
d3.annotationStorage.setValue("pdfjs_internal_editor_2", { annotationType: P.INK, color: [0, 0, 255], opacity: 1, thickness: 2, pageIndex: 0,
  rect: [20, 20, 120, 60], rotation: 0, structTreeParentId: null, popupRef: "",
  paths: { lines: [[0, 20, 20, 0, 0, 0, 0, 0, 0, 0, 120, 60]], points: [[20, 20, 120, 60]] } });
const out = await d3.saveDocument();
```

Reading `out` back with pdf-lib (`page.node.Annots()`):

```
Warning: generateImages: OffscreenCanvas is not supported, cannot save or print some annotations with images.
Warning: Font "Helv" is not available -- attempting to fallback to a default font.
annot 0 /FreeText keys: /Type /Subtype /CreationDate /Rect /DA /Contents /F /Border /Rotate /T /AP /Popup | T = (Folio User) | DA = (/Helv 12 Tf 1 0 0 rg) | Contents = (A comment)
annot 1 /Popup keys: /Type /Subtype /Open /Rect /Parent
annot 2 /Highlight keys: /Type /Subtype /CreationDate /Rect /F /Border /Rotate /QuadPoints /C /CA /AP | QuadPoints = [ 20 120 120 120 20 100 120 100 ]
annot 3 /Ink keys: /Type /Subtype /CreationDate /Rect /InkList /F /Rotate /BS /C /CA /AP | InkList = [ [ 20 20 120 60 ] ]
```

This confirms §6: real `/Highlight` + `QuadPoints`, real `/Ink` + `InkList`, `/FreeText` with `/DA` and an `/AP`, `/Popup` + `/Contents`, and `/T` only because `user` was supplied.

---

## 9. Memory / performance gotchas for a desktop app

1. **Copy before load.** Whole-buffer `Uint8Array`s and `ArrayBuffer`s are transferred and neutered (`pdf.mjs:8595-8603`, `15508`), also with the fake worker (`:8621-8626`). Keep `originalBytes` for pdf-lib and pass `originalBytes.slice()` to `getDocument`. After `saveDocument()` you get a brand-new `Uint8Array` (`worker:61557-61563`) — treat it as the new "original" for pdf-lib.
2. **Lifecycle.** `loadingTask.destroy()` (not `pdfDocument.destroy()`) terminates the worker, cancels renders, clears fonts and `TextLayer.cleanup()` (`pdf.mjs:16486-16516`). Await it before loading another file on the same `workerPort` (`:16352-16354`).
3. **Per-page cleanup.** Call `page.cleanup()` after a page scrolls out of view; it returns `false` and keeps everything while a render is in flight (`:16047-16071`). `pdfDocument.cleanup()` throws if any page is rendering (`:16956-16959`) — gate it on "no active render tasks". `keepLoadedFonts` only matters for XFA/print.
4. **One render per canvas** (`:17074`); cancel the previous `RenderTask` on zoom and reuse the canvas only after its promise settles.
5. **Canvas size cap.** The core has no `maxCanvasPixels`; replicate the viewer: `const os = new OutputScale(); os.limitCanvas(viewport.width, viewport.height, 2 ** 25 /* viewer default, viewer.mjs:4545 */, -1); canvas.width = Math.floor(viewport.width * os.sx); canvas.height = Math.floor(viewport.height * os.sy); canvas.style.width = viewport.width + "px"; page.render({ canvas, viewport, transform: os.scaled ? [os.sx, 0, 0, os.sy, 0, 0] : null })` (`OutputScale`, `pdf.mjs:1540-1584`).
6. **Worker-side limits.** `maxImageSize` (`-1` = unlimited, `:15419`), `canvasMaxAreaInBytes` (`:15422`), `isOffscreenCanvasSupported` / `isImageDecoderSupported` (`:15420-15421`) and `useWasm` (`:15437`) tune image decoding; `enableHWA` (`:15434`) selects hardware-accelerated 2D contexts in the canvas factory.
7. **Stamp bitmaps** are transferred to the worker on every `saveDocument`/print serialization (`:6971-6976`, `16752-16762`); large pasted images cost memory twice.
8. **Streaming.** For `url` loads keep `disableStream`/`disableRange` false; for `data` loads none of that applies (`:15510`). `getDownloadInfo()` resolves once all bytes are in (`:15717-15719`).
9. **Verbosity is global** (`setVerbosityLevel`, `:15442`); set `VerbosityLevel.ERRORS` in production to silence the fake-worker and empty-storage warnings, but then also implement the explicit fake-worker detection from §2.
10. **Fingerprints** (`:15640-15642`) are the right key for per-document UI state (recent files, last page); the second element is only non-null for modified files.