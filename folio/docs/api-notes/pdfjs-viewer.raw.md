# pdfjs-dist 6.4.299 viewer components — verified API reference for Folio PDF

All claims below were read from the installed files. Path aliases used in citations:

- `V` = `/home/user/claude/folio/node_modules/pdfjs-dist/web/pdf_viewer.mjs`
- `C` = `/home/user/claude/folio/node_modules/pdfjs-dist/build/pdf.mjs`
- `W` = `/home/user/claude/folio/node_modules/pdfjs-dist/build/pdf.worker.mjs`
- `CSS` = `/home/user/claude/folio/node_modules/pdfjs-dist/web/pdf_viewer.css`
- `TV/` = `/home/user/claude/folio/node_modules/pdfjs-dist/types/web/`
- `TA` = `/home/user/claude/folio/node_modules/pdfjs-dist/types/src/display/api.d.ts`

Package facts: `package.json` says `"version": "6.4.299"`, `"main": "build/pdf.mjs"`, `"types": "types/src/pdf.d.ts"`, engines node >=22.13 (`/home/user/claude/folio/node_modules/pdfjs-dist/package.json` lines 2-5, 29). The `web/` directory contains only `images/` (85 SVG/GIF files), `pdf_viewer.css`, `pdf_viewer.d.mts`, `pdf_viewer.mjs`, `pdf_viewer.mjs.map`. **There is no `locale/` folder and no `.ftl` files anywhere in the package.** Other top-level dirs: `build/`, `cmaps/`, `iccs/`, `image_decoders/`, `legacy/`, `standard_fonts/`, `types/`, `wasm/` (wasm has `jbig2.wasm`, `openjpeg.wasm`, `qcms_bg.wasm`, `quickjs-eval.js`, `quickjs-eval.wasm` plus no-wasm fallbacks).

## 0. Critical wiring fact: pdf_viewer.mjs does NOT import pdf.mjs

`V:28-91` is `const { AbortException, AnnotationEditorLayer, …, XfaLayer } = globalThis.pdfjsLib;`. The viewer bundle takes everything from a global that `C:28144` sets (`globalThis.pdfjsLib = { … }`) when `build/pdf.mjs` is evaluated. Consequence for a no-bundler ES-module renderer: `build/pdf.mjs` must be evaluated **before** `web/pdf_viewer.mjs`. Static imports evaluate in source order, so this works:

```js
import * as pdfjsLib from "../node_modules/pdfjs-dist/build/pdf.mjs";   // sets globalThis.pdfjsLib (C:28144)
import * as pdfjsViewer from "../node_modules/pdfjs-dist/web/pdf_viewer.mjs"; // reads it (V:28-91)
```

Do not put the viewer import first. The viewer also throws if the API version differs from `"6.4.299"` (`V:7988-7991`).

## 1. Exports of web/pdf_viewer.mjs

Export statement (`V:9809`):

`AnnotationLayerBuilder, DownloadManager, EventBus, FindState, GenericL10n, LinkTarget, PDFFindController, PDFHistory, PDFLinkService, PDFPageView, PDFScriptingManager, PDFSinglePageViewer, PDFViewer, ProgressBar, RenderingStates, ScrollMode, SimpleLinkService, SpreadMode, StructTreeLayerBuilder, TextLayerBuilder, XfaLayerBuilder, parseQueryString`

(Also assigned to `globalThis.pdfjsViewer` at `V:9785-9807`; `web/pdf_viewer.d.mts` re-exports `TV/pdf_viewer.component.d.ts`, which lists the same names.)

- **GenericL10n: EXPORTED** (`V:9809`, as `genericl10n_GenericL10n as GenericL10n`; class at `V:3708`).
- **PDFThumbnailViewer, PDFSidebar, CommentManager, SignatureManager, Toolbar, AnnotationEditorParams, AltTextManager, EditorUndoBar: NOT PRESENT in this build** (grep for those class names in `V` returns 0 hits). `TV/pdf_thumbnail_viewer.d.ts`, `TV/comment_manager.d.ts`, `TV/sidebar.d.ts`, `TV/menu.d.ts` exist as typings only; the code is not in the components bundle.
- Core exports from `C:28209` you will need: `AnnotationEditorLayer, AnnotationEditorParamsType, AnnotationEditorType, AnnotationEditorUIManager, AnnotationLayer, AnnotationMode, AnnotationType, ColorPicker, DrawLayer, GlobalWorkerOptions, PermissionFlag, PixelsPerInch, RenderingCancelledException, SignatureExtractor, SupportedImageMimeTypes, TextLayer, TouchManager, Util, getDocument, version, …`.

## 2. PDFViewer constructor options

Constructor `V:7987-8075`; typedef `TV/pdf_viewer.d.ts:11-167`. `options.container` and `options.viewer` must both be `DIV`s (`V:7992-7998`), and the container must be `position: absolute` when attached (`V:7999-8001`, throws otherwise). `viewer` defaults to `container.firstElementChild` (`V:7994`).

| Option | Type / default | Source | Effect |
|---|---|---|---|
| `container` | HTMLDivElement, required | `V:7992` | scroll element; observed by ResizeObserver (`V:8002`), scroll watched (`V:8054`). |
| `viewer` | HTMLDivElement, default `container.firstElementChild` | `V:7994` | receives `.page` divs, gets `--scale-factor` (`V:8480`). |
| `eventBus` | EventBus, required | `V:8003` | |
| `linkService` | default `new SimpleLinkService()` | `V:8004` | |
| `downloadManager` | default null | `V:8005` | used by annotation layer (file attachments). |
| `findController` | default null | `V:8006`; `onIsPageVisible` wired `V:8011-8013` | |
| `scriptingManager` | default null | `V:8014` | `enableScripting` getter = `!!_scriptingManager` (`V:8107`). |
| `renderingQueue` | default: internal `PDFRenderingQueue` | `V:8039-8045` | |
| `textLayerMode` | `TextLayerMode.ENABLE` (1) | `V:8015`; enum `V:184-188` (DISABLE 0, ENABLE 1, ENABLE_PERMISSIONS 2) | |
| `annotationMode` | `AnnotationMode.ENABLE_FORMS` (2) | `V:8016`; enum `C:48-53` | see §6(i). |
| `annotationEditorMode` | `AnnotationEditorType.NONE` (0) | `V:8017` | `DISABLE` (-1) means no UIManager is ever created (`V:8469`). |
| `annotationEditorHighlightColors` | string, default null | `V:8018`; parsed `C:2790-2796` | **Format: comma-separated `name=color` pairs**, e.g. the default-viewer value `"yellow=#FFFF98,green=#53FFBC,blue=#80EBFF,pink=#FFCBE6,red=#FF4F5F,yellow_HCM=#FFFFCC,…"` (`V:4530`). Names are used as l10n keys `pdfjs-editor-colorpicker-<name>` (`C:17204-17210`, `C:17260`); `_HCM` suffixed names are used only when `pageColors` is set (`C:2797-2817`). Values are upper-cased. First color becomes the default highlight fill (`C:23656`). If omitted, highlight default is `#fff066` (`C:23656`) and `ColorPicker` dropdown has no entries (`C:17255`). |
| `enableHighlightFloatingButton` | `=== true`, default false | `V:8019` | shows a floating "Highlight/Comment" toolbar after text selection when not in an editor mode (`C:3185-3190`, `C:3073-3086`). |
| `enableUpdatedAddImage` | `=== true`, default false | `V:8020` | "new alt-text flow" for stamps (`C:2778`, `C:26078-26099`); needs `altTextManager` to be useful. |
| `enableNewAltTextWhenAddingImage` | `=== true`, default false | `V:8021` | opens alt-text editor right after adding an image (`C:26080-26085`). |
| `enableComment` | **NOT a PDFViewer option.** | `V:8254-8256` | `enableComment` is derived as `!!commentManager`. |
| `commentManager` | object or null | `V:8007`, passed to UIManager `V:8475`, page views `V:8525`, annotation layer `V:1918` | see §6(f). |
| `signatureManager` | object or null | `V:8008`, `V:8475`, `V:9665` | see §6(e). |
| `altTextManager` | object or null | `V:8006`; called `C:2844` (`editAltText(uiManager, editor, firstTime)`) and `C:2753` (`destroy()`) | |
| `editorUndoBar` | object or null | `V:8009`; methods `show(undoFn, typeOrCount)` `C:2871`, `hide()` `C:3599`, `destroy()` `C:2769` | |
| `viewerAlert` | element or null | `V:7993`; `a11yAlert` sets `data-l10n-id` on it (`C:3103-3112`) | |
| `mlManager` | object or null | `V:8035`; `loadModel("altText")` `V:9662`, `isEnabledFor`, `guess` `C:26127-26135` | leave null. |
| `imageResourcesPath` | string, default `""`, **include trailing slash** | `V:8022`, typedef `TV/pdf_viewer.d.ts:72-76`; used `C:18631` and `C:20659` | `annotation-<name>.svg` icons for Text and FileAttachment annotations. |
| `enablePrintAutoRotate` | false | `V:8023`, used `V:9314` | |
| `removePageBorders` | false | `V:8024`, adds class `removePageBorders` `V:8060-8062` | |
| `maxCanvasPixels` | default `2 ** 25` from AppOptions (`V:4545`); page view fallback `V:6503` | `-1` no limit, `0` CSS-only zoom (`V:7035-7039`) | |
| `maxCanvasDim` | default 32767 (typedef `TV/pdf_viewer.d.ts:88-93`) | `V:8026` | |
| `capCanvasAreaFactor` | default 200 (typedef) | `V:8027` | |
| `enableDetailCanvas` | true | `V:8028` | |
| `enableOptimizedPartialRendering` | false | `V:8029` | |
| `enableSelectionRendering` | true | `V:8030` | |
| `imagesRightClickMinSize` | -1 | `V:8031` | |
| `l10n` | L10n, default `new GenericL10n()` | `V:8032-8033` | see §3. |
| `enablePermissions` | false | `V:8034`; applied `V:8281-8300` | |
| `pageColors` | null | `V:8035` | |
| `supportsPinchToZoom` | `!== false` → true | `V:8036` | only forwarded to the editor UIManager for pinch-resizing editors (`C:2734`, `C:6332-6340`); **PDFViewer has no touch/wheel zoom of its own** (grep for `"wheel"`/`TouchManager` in `V` shows only the import at `V:85` and this option). |
| `enableAutoLinking` | `!== false` → true | `V:8037`; `V:6703-6705` | |
| `minDurationToUpdateCanvas` | 500 | `V:8038` | |
| `abortSignal` | AbortSignal or null | `V:8044-8053`; disconnects ResizeObserver, passed to `watchScroll` and page views (`V:8526`) | |
| `enableHWA` | **NOT PRESENT as a PDFViewer option** (only AppOptions entry `V:4610`; a `BaseCanvasFactory` flag in `C:9124-9139`). | | |

## 3. Localization without .ftl files

**What happens when `l10n` is omitted:** `PDFViewer` does `this.l10n ||= new GenericL10n()` (`V:8033`) and, only when the option was omitted, calls `this.l10n.translate(this.container)` (`V:8072-8074`). `PDFPageView` (`V:6508-6509`, `V:6547-6549`) and `AnnotationEditorLayerBuilder` (`V:4254-4255`) do the same, but PDFViewer passes its own l10n to them (`V:8521`, `V:7264`).

**GenericL10n with no `lang` needs no files.** `GenericL10n(lang)` (`V:3709-3715`): when `lang` is falsy it uses `#generateBundlesFallback` (`V:3764-3766`) which yields the **built-in English bundle** from `#createBundleFallback` (`V:3767-3779`), a Fluent resource string embedded in the file containing every `pdfjs-*` id (previous/next/zoom…, all `pdfjs-editor-*`, resizer labels, comment dialog, signature dialog, undo bar, alt-text, document properties, find bar, password, etc.). When `lang` IS given, it tries `document.querySelector('link[type="application/l10n"]')` and fetches a JSON manifest + `.ftl` (`V:3748-3763`, `V:3738-3746`); failures are caught and it still falls back to the built-in en-us bundle (`V:3729-3735`).

So the **safest construction is simply to omit `l10n`** (or `new GenericL10n()` with no argument). Translation is applied by Fluent's `DOMLocalization` via a MutationObserver (`V:3508-3545`) to any element with `data-l10n-id` under a connected root (`V:3615-3621`), and `translateOnce(el)` for one element (`V:3622-3628`). Missing ids only produce `console.warn("[fluent] Missing translations …")` (`V:3324-3328`) and the element is left untouched (`V:3561-3566`) — nothing throws.

**L10n interface** (`TV/l10n.d.ts:6-27`, impl `V:3579-3644`): `getLanguage()`, `getDirection()` → `"ltr"|"rtl"`, `async get(ids, args=null)` (string or array), `async translate(element)`, `async translateOnce(element)`, `async destroy()`, `pause()`, `resume()`. The viewer calls `translate` (`V:8073`, `V:6548`), `pause/resume` around layer insertion (`V:6748-6750`, `V:6775-6780`, `V:7151-7153`), and the core calls only `AltText._l10n.get("pdfjs-editor-new-alt-text-generated-alt-text-with-disclaimer", {…})` (`C:4381`). A minimal custom object implementing these 8 methods is accepted, but the editors set `data-l10n-id`/`data-l10n-args` attributes and expect the l10n to fill them (e.g. `C:6009`, `C:6493`, `C:6519`, `C:21553-21554` sets `data-l10n-attrs="default-content"` and CSS `content: attr(default-content)` at `CSS:3928` is the FreeText placeholder). With a no-op l10n: toolbar/resizer buttons render with icons (CSS) but **no `title`/`aria-label`**, FreeText shows no "Start typing…" placeholder, the floating toolbar's visually-hidden label span is empty, and the comment "Show comment" button has no title. Recommendation: keep `GenericL10n()`; if you need a tiny custom dictionary, implement `translate(root)` by walking `[data-l10n-id]` (and a MutationObserver) and applying the strings below.

**l10n ids used by the core editors/layers** (`grep -o "pdfjs-[a-z0-9-]*" C | sort -u` — complete list, 51 ids) with English from the fallback bundle at `V:3767`:

| id | English (value / attributes) |
|---|---|
| pdfjs-annotation-date-time-string | `{ DATETIME($dateObj, dateStyle:"short", timeStyle:"medium") }` |
| pdfjs-comment-floating-button / -label | .title/.aria-label "Comment" / "Comment" |
| pdfjs-editor-add-comment-button | .title "Add comment" |
| pdfjs-editor-alt-text-button / -label | .aria-label "Alt text" / "Alt text" |
| pdfjs-editor-alt-text-decorative-tooltip | "Marked as decorative" |
| pdfjs-editor-alt-text-edit-button | .aria-label "Edit alt text" |
| pdfjs-editor-color-picker-free-text-input | .title "Change text color" |
| pdfjs-editor-color-picker-ink-input | .title "Change drawing color" |
| pdfjs-editor-colorpicker-button | .title "Change color" |
| pdfjs-editor-colorpicker-dropdown | .aria-label "Color choices" |
| pdfjs-editor-colorpicker-yellow/green/blue/pink/red | .title "Yellow"/"Green"/"Blue"/"Pink"/"Red" |
| pdfjs-editor-freetext-added-alert / highlight / ink / stamp / signature | "Text added" / "Highlight added" / "Drawing added" / "Image added" / "Signature added" (set on `viewerAlert`, `C:3103`) |
| pdfjs-editor-highlight-editor | .aria-label "Highlight editor" |
| pdfjs-editor-ink-editor | .aria-label "Drawing editor" |
| pdfjs-editor-stamp-editor | .aria-label "Image editor" |
| pdfjs-editor-signature-editor1 | .aria-description "Signature editor: { $description }" |
| pdfjs-editor-new-alt-text-added-button / -label, -missing-button / -label, -to-review-button / -label | "Alt text added", "Missing alt text", "Review alt text" (aria-label + label) |
| pdfjs-editor-new-alt-text-generated-alt-text-with-disclaimer | "Created automatically: { $generatedAltText }" |
| pdfjs-editor-remove-freetext-button / -highlight / -ink / -signature / -stamp | .title "Remove text" / "Remove highlight" / "Remove drawing" / "Remove signature" / "Remove image" (`C:1803-1809`) |
| pdfjs-editor-resizer-top-left … middle-left (8 ids) | .aria-label "Top left corner — resize", "Top middle — resize", "Top right corner — resize", "Middle right — resize", "Bottom right corner — resize", "Bottom middle — resize", "Bottom left corner — resize", "Middle left — resize" (`C:5237-5246`) |
| pdfjs-free-text2 | .aria-label "Text Editor", .default-content "Start typing…" |
| pdfjs-highlight-floating-button1 / -label | .title/.aria-label "Highlight" / "Highlight" |
| pdfjs-show-comment-button | .title "Show comment" |
| pdfjs-text-annotation-type | .alt "[{ $type } Annotation]" |

Ids used by the viewer bundle itself outside the fallback string: `pdfjs-page-landmark` (.aria-label "Page { $page }", `V:6524`) plus the same editor ids. The signature dialog and comment sidebar/dialog ids (`pdfjs-editor-add-signature-*`, `pdfjs-editor-edit-comment-dialog-*`, `pdfjs-editor-comments-sidebar-*`) exist in the fallback bundle but **no code in this build renders those dialogs** — they belong to the absent SignatureManager/CommentManager.

## 4. PDFViewer properties and methods

- `setDocument(pdfDocument|null)` `V:8382-8600`: tears down the previous doc (dispatches `pagesdestroy`, cancels rendering, `findController.setDocument(null)`, `scriptingManager.setDocument(null)`, destroys the UIManager, `V:8383-8395`), then creates all `PDFPageView`s (`V:8505-8530`), creates the `AnnotationEditorUIManager` if `annotationEditorMode !== DISABLE` and the doc is not pure XFA (`V:8469-8485`), dispatches `annotationeditoruimanager` with `{source, uiManager}` (`V:8476-8479`), sets `--scale-factor` (`V:8480`), dispatches `pagesinit` (`V:8588`), calls `findController.setDocument`/`scriptingManager.setDocument` after the first page is rendered (`V:8557-8559`), resolves `pagesPromise` after all pages are fetched (`V:8562-8583`), dispatches `pagesloaded` `{source, pagesCount}` (`V:8430`). `pagesinit` is where you must set `currentScaleValue` (see §14).
- `pdfDocument` property; `pagesCount` (`V:8079`); `getPageView(index)` zero-based (`V:8082`); `getCachedPageViews()` (`V:8085`); `pageViewsReady` (`V:8088`); `_pages` array (`V:8720`).
- `currentPageNumber` get/set (`V:8110-8126`, 1-based; invalid → `console.error`); `_setCurrentPageNumber` dispatches `pagechanging` (`V:8139-8144`).
- `currentPageLabel` get/set (`V:8150-8170`); `setPageLabels(labels|null)` (`V:8703`, length must equal `numPages`); `pageLabelToPageNumber(label)` (`V:9003`).
- `currentScale` get/set numeric (`V:8171-8184`), `currentScaleValue` get/set (`V:8185-8194`). Accepted strings in `#setScale` (`V:8945-8993`): any positive number string, `"page-actual"`, `"page-width"`, `"page-height"`, `"page-fit"`, `"auto"`; unknown → `console.error`. `auto` is capped at `MAX_AUTO_SCALE = 1.25` (`V:167`, `V:8975`). `MIN_SCALE 0.1`, `MAX_SCALE 25`, `DEFAULT_SCALE_DELTA 1.1` (`V:163-165`), `DEFAULT_SCALE_VALUE "auto"` (`V:161`).
- `pagesRotation` get/set (`V:8196-8232`), accepts 0/90/180/270 (`isValidRotation` `V:483`), dispatches `rotationchanging`.
- `scrollMode` get/set (`V:9360-9381`), enum `ScrollMode` `V:189-195`: `UNKNOWN -1, VERTICAL 0, HORIZONTAL 1, WRAPPED 2, PAGE 3`; forced to PAGE above 10000 pages (`PagesCountLimit` `V:7893-7897`). `spreadMode` get/set (`V:9403-9420`), enum `SpreadMode` `V:196-201`: `UNKNOWN -1, NONE 0, ODD 1, EVEN 2`.
- `scrollPageIntoView({pageNumber, destArray=null, allowNegativeOffset=false, ignoreDestinationZoom=false, center=null})` `V:9010-9116`; `destArray` is a PDF dest array `[ref, {name:"XYZ"|"Fit"|"FitB"|"FitH"|"FitBH"|"FitV"|"FitBV"|"FitR"}, …]`; `center` ∈ `null|"horizontal"|"vertical"|"both"` (`TV/pdf_viewer.d.ts:421-424`).
- `updateScale({drawingDelay, scaleFactor=null, steps=null, origin, pan=null})` `V:9579-9610` (throws unless `steps` or `scaleFactor`); `increaseScale(options)` / `decreaseScale(options)` `V:9611-9622` (default 1 step); `origin` = `[clientX, clientY]` for zoom-at-point (`V:8914-8919`).
- `annotationEditorMode` getter returns `DISABLE` when no UIManager (`V:9669-9671`); setter takes `{mode, editId=null, isFromKeyboard=false, mustEnterInEditMode=false, editComment=false}` (`V:9672-9737`) and throws `"The AnnotationEditor is not enabled."` if no UIManager (`V:9679-9681`) or on an invalid mode (`V:9686-9688`, `isValidAnnotationEditorMode` `V:7898-7900`). Dispatches `annotationeditormodechanged` `{source, mode}` when done (`V:9703-9706`).
- `optionalContentConfigPromise` get/set (`V:9329-9359`), setter dispatches `optionalcontentconfigchanged` `{source, promise}`.
- `refresh(noUpdate=false, updateArgs)` `V:9738-9748`; `update()` `V:9140-9179` (recomputes visible pages, renders, dispatches `updateviewarea`); `cleanup()` `V:9241`; `focus()` `V:9211`; `containsElement(el)` `V:9208`; `forceRendering(visible?)` `V:9282`; `_getVisiblePages()` `V:9229` returns `{first, last, views:[{id, x, y, view, percent, widthPercent, visibleArea}], ids:Set}` (`getVisibleElements` `V:379-462`).
- `isInPresentationMode` / `isChangingPresentationMode` (`V:9217-9222`) read `this.presentationModeState`, a plain public property initialised to `PresentationModeState.UNKNOWN` (`V:8057`); enum `V:170-175`: `UNKNOWN 0, NORMAL 1, CHANGING 2, FULLSCREEN 3`. The host must set it and dispatch `presentationmodechanged` `{state}` itself (AnnotationLayerBuilder listens, `V:1898`).
- `firstPagePromise`, `onePageRendered`, `pagesPromise` (`V:8233-8241`, null when no doc).
- `hasEqualPageSizes` (`V:9296`); `getPagesOverview()` (`V:9306-9328`) → `[{width, height, rotation}]` at scale 1 (auto-rotated when `enablePrintAutoRotate`).
- `previousPage()` / `nextPage()` (`V:9560-9578`) return boolean, spread-aware.
- `containerTopLeft` (`V:9638`) → `[offsetTop, offsetLeft]`.
- `getAllText(interruptSignal)` (`V:8319-8342`) → full text string.
- `renderingQueue` (`V:8040-8045`), `enableScripting` (`V:8107`), `renderForms` (`V:8104`), `printingAllowed` (`V:8076`).
- `isPageVisible` / `isPageCached` / `setFindController` / public `annotationEditorUIManager` getter: **NOT PRESENT** (not in the method list `V:7987-9748`). The UIManager is private (`#annotationEditorUIManager`); reach it via the `annotationeditoruimanager` event (`V:8476`) or `pdfViewer._layerProperties.annotationEditorUIManager` (`V:8242-8247`). `findController` is a public property (`V:8006`).
- `panBy(dx, dy)` (`V:8842`), `clearSelection()` (`V:8091`), `_updateLocation` builds `_location = {pageNumber, scale, top, left, rotation, pdfOpenParams}` (`V:9117-9139`).
- `PDFSinglePageViewer extends PDFViewer` (`V:9755-9763`): forces `ScrollMode.PAGE` and no spreads.

**PDFPageView fields** (`V:6483-6551`): `id` (1-based), `renderingId`, `div` (`.page` with `data-page-number`), `pdfPage`, `pageLabel`, `rotation`, `scale`, `viewport`, `pdfPageRotate`, `annotationLayer` (AnnotationLayerBuilder), `annotationEditorLayer` (AnnotationEditorLayerBuilder; its `.annotationEditorLayer` is the core `AnnotationEditorLayer`, `V:4258`, `V:4283`), `textLayer` (TextLayerBuilder), `xfaLayer`, `structTreeLayer`, `drawLayer`, `detailView`, `canvas` (from BasePDFPageView, `TV/base_pdf_page_view.d.ts:3`), `renderingState` (`V:4885-4915`, enum `RenderingStates` `V:4858`: `INITIAL 0, RUNNING 1, PAUSED 2, FINISHED 3`), `width`/`height` getters (`V:7094-7099`), `getPagePoint(x,y)` → `viewport.convertToPdfPoint` (`V:7100`), `hasEditableAnnotations()` (`V:6665`), `toggleEditingMode(isEditing)` (`V:6880`), `thumbnailCanvas` (`V:7306`), `draw()` (`V:7126`), `reset({keep…})` (`V:6811`), `update({scale, rotation, optionalContentConfigPromise, drawingDelay})` (`V:6910`). Layer DOM order: canvasWrapper, textLayer, annotationLayer, annotationEditorLayer/xfaLayer (`V:6460`).

## 5. EventBus and the complete event list

`EventBus` (`V:2137-2196`): `on(eventName, listener, options={signal?, once?, internal?})`, `off(eventName, listener)`, `dispatch(eventName, data)`. Internal (library) listeners run before external ones (`V:2171-2195`). Listeners receive the data object; every payload has `source`.

Events dispatched by the library (file:line → payload):

| Event | Where | Payload |
|---|---|---|
| `pagesinit` | `V:8588` | `{source}` |
| `pagesloaded` | `V:8430` | `{source, pagesCount}` |
| `pagesdestroy` | `V:8384` | `{source}` |
| `pagechanging` | `V:8139` | `{source, pageNumber, pageLabel, previous}` |
| `scalechanging` | `V:8883`, `V:8933` | `{source, scale, presetValue}` (`presetValue` is the string like `"page-width"` or undefined) |
| `rotationchanging` | `V:8224` | `{source, pagesRotation, pageNumber}` |
| `updateviewarea` | `V:9175` | `{source, location:{pageNumber, scale, top, left, rotation, pdfOpenParams}}` |
| `scrollmodechanged` / `spreadmodechanged` | `V:9376`, `V:8424` / `V:9415` | `{source, mode}` |
| `optionalcontentconfigchanged` | `V:9355` | `{source, promise}` |
| `printingallowed` | `V:8276` | `{source, isAllowed}` |
| `pagerender` | `V:5073` | `{source: pageView, pageNumber}` |
| `pagerendered` | `V:5079` | `{source: pageView, pageNumber, cssTransform, isDetailView, timestamp, error}` |
| `textlayerrendered`, `annotationlayerrendered`, `annotationeditorlayerrendered`, `xfalayerrendered`, `linkannotationsadded` | `V:6676-6681` via `#dispatchLayerRendered` (callers `V:6700`, `V:6721`, `V:6771`, `V:6760`, `V:6806`) | `{source: pageView, pageNumber, error}` |
| `annotationeditoruimanager` | `V:8476` | `{source, uiManager}` |
| `annotationeditormodechanged` | `V:8538` (once, after first editor layer renders), `V:9703` | `{source, mode}` |
| `editingstateschanged` | `C:3509` | `{source, details:{isEditing, isEmpty, hasSomethingToUndo, hasSomethingToRedo, hasSelectedEditor, hasSelectedText}}` (`C:2609-2616`). **`annotationeditorstateschanged` is NOT PRESENT in this version** — the name is `editingstateschanged`. |
| `annotationeditorparamschanged` | `C:3519` | `{source, details: [[AnnotationEditorParamsType, value], …]}` |
| `switchannotationeditormode` | `C:3680` (`updateToolbar`, when an editor is selected: `{source, mode, editId}`), `C:18287` (dblclick on an existing editable annotation: `{source, mode, editId, mustEnterInEditMode:true}`) | host should respond by setting `pdfViewer.annotationEditorMode = evt` (see §6a) |
| `switchannotationeditorparams` | `C:17278` (ColorPicker) | `{source, type, value}`; the UIManager listens and calls `updateParams` (`C:2700`) |
| `showannotationeditorui` | `C:2922` | `{source, mode}` — emitted by `uiManager.switchToMode` (`C:2916-2926`); host must switch mode so that `annotationeditormodechanged` fires |
| `setpreference` | `C:2928` | `{source, name, value}` |
| `reporttelemetry` | `C:3694`, `C:6694` | `{source, details:{type:"editing", data}}` |
| `editorsrendered` | `C:26871` | `{source: layer, pageNumber}` |
| `updatefindmatchescount` | `V:1441` | `{source, matchesCount:{current, total}}` |
| `updatefindcontrolstate` | `V:1450` | `{source, state, previous, entireWord, matchesCount, rawQuery}` |
| `updatetextlayermatches` | `V:1194`, `V:1200` | `{source, pageIndex}` (-1 = all) |
| `findfromurlhash` | `V:1683` | `{source, query}` |
| `pagemode` | `V:1729` | `{source, mode}` |
| `namedaction` | `V:1778` | `{source, action}` |
| `fileattachmentannotation` | `C:20642` | `{source, attachmentId, filename, content, …}` |
| `sandboxcreated` | `V:7487` | `{source}` |
| `print`, `download` | `V:7582`, `V:7595` | `{source}` (from sandbox commands) |
| `updatefromsandbox` | `V:7744` | `{source: window, detail}` |
| `dispatcheventinsandbox` | `C:18487` etc. | `{source, detail}` |

Events the library **listens** for (host dispatches): `find`, `findbarclose`, `pagesedited` (`V:853-855`), `editingaction` (`C:2695`), `switchannotationeditorparams` (`C:2700`), `setpreference` (`C:2699`), `presentationmodechanged` (`V:1898`), `thumbnailrendered` (`V:8064`, payload `{pageNumber, pdfPage}`). **`mainhighlightcolorpickerupdatedcolor`, `annotationeditorundo/redo`, `editorselectionchanged`, signature-/comment-specific events: NOT PRESENT** (grep returns nothing); selection state comes through `editingstateschanged.details.hasSelectedEditor`.

## 6. Annotation editing from the host (exhaustive)

### (a) Switching mode

Enum confirmed at `C:55-65`: `DISABLE:-1, NONE:0, FREETEXT:3, HIGHLIGHT:9, STAMP:13, INK:15, POPUP:16, SIGNATURE:101, COMMENT:102`.

```js
pdfViewer.annotationEditorMode = { mode: pdfjsLib.AnnotationEditorType.INK };
// to edit a specific existing editor: { mode, editId: editor.uid, mustEnterInEditMode: true }
```

Setter at `V:9672-9737` → `uiManager.updateMode(mode, editId, true, isFromKeyboard, mustEnterInEditMode, editComment)` (`C:3576-3670`). `NONE` disables all layers, hides standalone comment buttons, hides the undo bar (`C:3592-3600`); other modes call `setEditingState(true)`, enable every layer (deserialising existing editable annotations, `C:26839-26875`), then `layer.updateMode(mode)` which toggles classes `freetextEditing`/`inkEditing`/`stampEditing`/`highlightEditing`/`signatureEditing` or `commentEditing` (`C:26775-26814`).

- **`POPUP` (16)** is "comment review" mode: `updateMode` collects every editor with a comment plus every editable annotation in the document that has a popup (`pdfDocument.getAnnotationsByType`, `C:3619-3646`) and calls `commentManager.showSidebar(allComments)`; the layer gets class `commentEditing`; clicks on the layer do not create editors (`C:27273-27276`). Without a `commentManager` it just enables layers.
- **`COMMENT` (102)** is only a valid enum value for the toolbar/floating "Comment" button flow: `commentSelection()` → `highlightSelection(method, true)` creates a HIGHLIGHT editor and immediately opens `editor.editComment()` (`C:3066-3068`, `C:3019-3065`). No `AnnotationEditorLayer.#editorTypes` entry exists for it (the map is `[FreeText, Ink, Stamp, Highlight, Signature]`, `C:26735`), so setting `mode: COMMENT` creates nothing on click (`#createNewEditor` returns null, `C:27172-27175`).
- `SIGNATURE` mode awaits `signatureManager.loadSignatures()` (`C:3606-3608`).

### (b) Changing parameters

Enum confirmed at `C:66-81`: `RESIZE:1, CREATE:2, FREETEXT_SIZE:11, FREETEXT_COLOR:12, FREETEXT_OPACITY:13, INK_COLOR:21, INK_THICKNESS:22, INK_OPACITY:23, INK_COLOR_AND_OPACITY:24, HIGHLIGHT_COLOR:31, HIGHLIGHT_THICKNESS:32, HIGHLIGHT_FREE:33, HIGHLIGHT_SHOW_ALL:34, DRAW_STEP:41`.

`eventBus.dispatch("switchannotationeditorparams", {source, type, value})` → `uiManager.updateParams(type, value)` (`C:2700`, `C:3685-3717`): with a selection it calls `editor.updateParams` on each selected editor, otherwise `EditorClass.updateDefaultParams` (`C:3708-3716`). Expected values:

| type | value | evidence |
|---|---|---|
| `CREATE` (2) | object spread into the new editor's constructor params; `currentLayer.addNewEditor(value)` | `C:3690-3692`, `C:27241-27243` |
| `FREETEXT_SIZE` (11) | number (px at scale 1; default 10) | `C:21209`, `C:21264-21266`, `C:21295-21301` |
| `FREETEXT_COLOR` (12) | CSS color string, hex like `"#RRGGBB"` (default `CanvasText` hex via `_defaultLineColor`, `C:5215`) | `C:21267-21269`, `C:21318` |
| `FREETEXT_OPACITY` (13) | **not handled by any editor** (no case in `C:21262-21281`) |
| `INK_COLOR` (21) | hex color string → SVG `stroke` | typesMap `C:24825` |
| `INK_THICKNESS` (22) | number → `stroke-width` | `C:24825` |
| `INK_OPACITY` (23) | number 0..1 → `stroke-opacity` | `C:24825` |
| `INK_COLOR_AND_OPACITY` (24) | `{color: "#RRGGBB", opacity: 0..1}` | `C:24906-24918` |
| `HIGHLIGHT_COLOR` (31) | hex color string (upper-cased from your `annotationEditorHighlightColors`) → `fill` | `C:23668`, `C:23751-23758` |
| `HIGHLIGHT_THICKNESS` (32) | number (default 12), only affects free highlights | `C:23623`, `C:23760-23766` |
| `HIGHLIGHT_FREE` (33) | **read-only UI state**: emitted in `annotationeditorparamschanged` (`C:3514`, `C:23771`); not accepted as input |
| `HIGHLIGHT_SHOW_ALL` (34) | boolean → `showAllEditors("highlight", value)` | `C:3693-3708` |
| `RESIZE` (1), `DRAW_STEP` (41) | internal undo-stack types (`C:22605`, `C:22617`); not host inputs |

Current defaults are pushed to you via `annotationeditorparamschanged` when editor types register (`C:3544-3552`) and when an editor is selected (`C:3822-3829`, `C:3860-3879`). `ColorPicker` (`C:17175`) can be instantiated by the host as `new ColorPicker({uiManager})` + `renderMainDropdown()` (`C:17236-17241`) — it dispatches `switchannotationeditorparams` itself (`C:17278-17283`); register it with `uiManager.setMainHighlightColorPicker(cp)` (`C:2840`).

### (c) Editing actions and keyboard

`eventBus.dispatch("editingaction", {name})` with `name ∈ "undo" | "redo" | "delete" | "selectAll" | "highlightSelection" | "commentSelection"` (`C:3420-3437`). Direct methods: `uiManager.undo()` `C:3896`, `redo()` `C:3905`, `delete()` `C:3935`, `selectAll()` `C:3981`, `unselectAll()` `C:3987`, `copy(event)`/`cut(event)`/`paste(event)` `C:3326-3404` (they take a ClipboardEvent and use `event.clipboardData`; the editors serialise to MIME `application/pdfjs`, `C:3342`).

Keyboard: the UIManager binds `keydown`/`keyup` on **`window`** (`C:3248-3259`), active from construction; shortcuts run only when `getMode() !== NONE` and no editor is handling keys (`C:3405-3412`). Table at `C:2628-2680`: `ctrl+a`/`meta+a` selectAll, `ctrl+z`/`meta+z` undo, `ctrl+y`, `ctrl+shift+z`/`meta+shift+z` redo, `Backspace`/`Delete` (+modifiers) delete, `Enter`/`Space` add new editor (only when target is inside the container), `Escape` unselectAll, arrows (±1 px) and `ctrl+arrows`/`mac shift+arrows` (±10 px) move selected editors (only when `container.contains(document.activeElement)` and not a BUTTON). `textInputChecker` skips `<input type=text|number>` targets but **not `<textarea>`s or contenteditable** (`C:2622-2632`), so stop propagation of keydown in your own text areas while an editor mode is active. Copy/cut/paste listeners are attached to `document` while editing (`C:3265-3283`), and `dragover`/`drop` listeners on `document` from construction (`C:3285-3294`) — dropping an image anywhere creates a stamp via `StampEditor.paste` (`C:26049-26055`).

### (d) Adding a STAMP editor programmatically

Reach the layer: `pdfViewer.getPageView(i).annotationEditorLayer.annotationEditorLayer` (builder `V:4258` → core layer `V:4283`), or `uiManager.getLayer(pageIndex)` / `uiManager.currentLayer` (`C:3556-3561`). Layers exist only after the page's editor layer has rendered (`annotationeditorlayerrendered`, or `await uiManager.waitForEditorsRendered(pageNumber)` `C:2890`).

`StampEditor` constructor reads `params.bitmapUrl` and `params.bitmapFile` (`C:26034-26042`); `bitmap`/`bitmapId` are only used by `deserialize` (`C:26558-26600`). Loading order in `#getBitmap` (`C:26171-26217`): `bitmapId` → `bitmapUrl` (`imageManager.getFromUrl`, `fetchData(url,"blob")`, `C:2203`) → `bitmapFile` (`getFromFile`, must be a `File`, `C:2206`, `C:2281`) → otherwise **opens a native `<input type=file>` picker** (`C:26195-26216`). Accepted MIME types: `SupportedImageMimeTypes` `C:1585` (apng, avif, bmp, gif, jpeg, png, svg+xml, webp, x-icon). `enableUpdatedAddImage` does not change this; it only switches on the alt-text flow after load (`C:26078-26099`).

Recipe (verified method names):

```js
const { AnnotationEditorType, AnnotationEditorParamsType } = pdfjsLib;
// 1. enter STAMP mode (required: #createNewEditor uses the current mode, C:27172-27175)
pdfViewer.annotationEditorMode = { mode: AnnotationEditorType.STAMP };
await new Promise(r => eventBus.on("annotationeditormodechanged", r, { once: true }));

// 2a. centered on the current page: uiManager.updateParams(CREATE, …) → currentLayer.addNewEditor(value)   (C:3690-3692, C:27241)
const file = new File([pngBlob], "signature.png", { type: "image/png" });
uiManager.updateParams(AnnotationEditorParamsType.CREATE, { bitmapFile: file });
// or: eventBus.dispatch("switchannotationeditorparams", {source:null, type: CREATE, value:{ bitmapUrl: blobUrl }});

// 2b. at a position on page i: layer.createAndAddNewEditor({offsetX, offsetY}, false, {bitmapFile: file})  (C:27203-27218)
const layer = pdfViewer.getPageView(i).annotationEditorLayer.annotationEditorLayer;
const editor = layer.createAndAddNewEditor({ offsetX: xCss, offsetY: yCss }, /*isCentered*/ false, { bitmapFile: file });
```

`event.offsetX/offsetY` are CSS pixels relative to the layer div (its size is `pageDimensions * parentScale`, `C:5548-5554`): the editor stores `x = offsetX / layerWidth`, `y = offsetY / layerHeight` as fractions (`C:5198-5200`). To convert PDF-space points use `pageView.viewport.convertToViewportPoint(x, y)` (used at `V:9095`). `pasteEditor(options, params)` (`C:27179-27199`) is the drop/paste path: it switches mode itself and centers the editor. After the bitmap loads the editor sizes itself to the bitmap, capped at 75% of the page (`C:26316-26329`), calls `center()` if `isCentered` else `fixAndSetPosition()` (`C:26336-26340`), registers an undo entry, and adds itself to `annotationStorage` via `layer.add` → `uiManager.addToAnnotationStorage` (`C:27105`, `C:3098`). `editor.width/height` are page fractions and `setDims()`/`fixAndSetPosition()`/`translateInPage(x,y)` exist (`C:5555`, `C:5460`, `C:5389`) but are internal; `getPDFRect()` (`C:6237`) returns the PDF rect.

### (e) Signature editor vs. PNG stamps

`SignatureEditor` (`C:25687-26020`) in `render()` (`C:25747-25805`) either builds the outline from `params.signatureData` `{lines, mustSmooth, areContours, description, uuid, heightInPage}` (`C:25760-25783`) or — with no data — **hides its div and calls `this._uiManager.getSignature(this)`** (`C:25784-25788`), which forwards to `signatureManager.getSignature({uiManager, editor})` (`C:2907-2911`). The manager must eventually call `editor.addSignature(outlineData, heightInPage, description, uuid)` (`C:25861-25910`) or `editor.remove()`. Outline data must be produced with `editor.getFromImage(bitmap)` (`C:25911` → `SignatureExtractor.process(bitmap, pageWidth, pageHeight, rotation, innerMargin)` `C:25430-25448`), `editor.getFromText(text, fontInfo)` (`C:25921` → `extractContoursFromText` `C:25378`) or `editor.getDrawnSignature(curves)` (`C:25931` → `processDrawnLines` `C:25449-25520`, returns `{outline, newCurves, areContours, thickness, width, height}` or null). Every method the editors/UIManager call on `signatureManager`: `getSignature({uiManager, editor})` `C:2908`, `loadSignatures()` `C:3608`/`V:9665`, `destroy()` `C:2755`, `renderEditButton(editor)` → button element or null `C:1939-1945` (used because `toolbarButtons` returns `[["editSignature", signatureManager]]` when a manager exists, `C:25858-25860`). There is no dialog in this build; `SignatureExtractor.compressSignature/decompressSignature` (`C:25521`, `C:25580`) exist for persisting saved signatures. On save, a signature serialises as an ink-like annotation `{isSignature:true, areContours, color:[0,0,0], thickness, lines, accessibilityData}` (`C:25962-25999`).

**Recommendation: generate signatures as STAMP editors from a PNG.** Reasons with citations: (1) the stamp path needs no host-side manager — `bitmapFile`/`bitmapUrl` are consumed directly (`C:26034-26042`, `C:26180-26194`); (2) the signature path requires implementing a 4-method manager and a UI and must call back `addSignature` with `SignatureExtractor` output (`C:25784-25788`, `C:25861`); (3) PNG stamps keep color and anti-aliasing, whereas `SignatureExtractor.process` thresholds to black contours (`C:25430-25438`, `color:[0,0,0]` `C:25978`). Use `AnnotationEditorType.SIGNATURE` only if you want a vector, black-ink signature embedded as an Ink annotation.

### (f) Comments

`enableComment` is `!!commentManager` (`V:8254-8256`), forwarded to `AnnotationLayerBuilder` (`V:1886`) and `AnnotationLayer.render` (`C:20869`). Interface the core calls on `commentManager` (`TV/comment_manager.d.ts:4-20`; call sites): `setSidebarUiManager(uiManager)` `C:2735`, `showDialog(uiManager|null, editorOrPopup, posX, posY, options)` `C:2850`/`C:19885`, `destroyPopup()` `C:3591`, `toggleCommentPopup(editorOrPopup, isSelected, visibility, isEditable)` `C:2882`/`C:19708`, `updateComment(data)` `C:2858`, `updatePopupColor(editor)` `C:2861`, `removeComments([uid])` `C:2864`, `showSidebar(annotations)` `C:3646`, `hideSidebar()` `C:3589`, `makeCommentColor(color, opacity)` `C:2885`/`C:19789`, `dialogElement` getter `C:2888`, `destroy()` `C:2754`. The core creates: a toolbar "comment" button (`C:4552-4556`, `Comment.renderForToolbar`), a standalone `button.annotationCommentButton` on editors with a comment (`C:4560-4575`) and on existing popup annotations (`C:19725-19760`); it never creates the dialog or the sidebar. With no manager, existing popups render as classic hover popups (`C:19546-19551`, `C:19950-20010`, title + date + rich text).

Host-side flow without a manager: set `editor.comment = "text"` (setter `C:5917-5933`) — the data object is `{text, richText, date, deleted, color, opacity}` (`C:5896-5916`). What is saved: `editor.serialize()` calls `addComment(serialized)` which adds `serialized.popup = {contents, deleted, rect}` when the comment was edited (`C:5973-5990`); the worker writes `/Contents` on the markup annotation and a `/Popup` dict with `/Subtype /Popup`, `/Open false`, `/Rect`, `/Parent` (`W:53716-53733`, `W:55331-55339`); deleted popups remove `/Popup`, `/Contents`, `/RC` (`W:53715-53720`). **Author (`/T`)**: the worker does `setIfDefined("T", user)` for FreeText (`W:55424`), Ink (`W:55827`), Highlight (`W:55980`) and Stamp (`W:56177`), but the display-side `serialize()` of every editor never includes a `user` field (`C:21772-21793`, `C:24967-24990`, `C:26617-26640`, `C:25962-25999`) — grep `user:`/`ownerName`/`author` in `C` returns nothing. So **no author is written; add `/T` with pdf-lib after `saveDocument()`** if you need it.

### (g) Highlight from selection

`uiManager.highlightSelection(methodOfCreation="", comment=false)` (`C:3019-3065`): takes `document.getSelection()`, requires the anchor inside a `.textLayer`, computes boxes (`getSelectionBoxes`, `C:4166-4247`), empties the selection and calls `layer.createAndAddNewEditor({x:0,y:0}, false, {methodOfCreation, boxes, anchorNode, anchorOffset, focusNode, focusOffset, text})`. If the mode is NONE it first calls `switchToMode(HIGHLIGHT, cb)` which dispatches `showannotationeditorui` and waits for `annotationeditormodechanged` (`C:3055-3060`, `C:2916-2926`) — so the host must handle `showannotationeditorui` by setting `pdfViewer.annotationEditorMode = {mode}`. In HIGHLIGHT mode a mouse selection auto-highlights on pointerup (`C:3115-3184`, `C:3185-3187`). `enableHighlightFloatingButton` shows a small `.editToolbar` with "Highlight" (and "Comment" if a commentManager exists) after selecting text in NONE mode (`C:3188-3190`, `C:2007-2050`). **Free highlight**: in HIGHLIGHT mode, pressing on the text layer background (not on text) starts a drawn highlight (`C:27018-27034`, `HighlightEditor.startDrawing`); the "free" flag is reported back as `HIGHLIGHT_FREE` (`C:23771`); thickness via `HIGHLIGHT_THICKNESS`.

### (h) Editing/deleting existing annotations

Editable = `data.isEditable`, set by the worker to `!noHTML` for `FreeTextAnnotation` (`W:55353`), `InkAnnotation` (`W:55750`), `HighlightAnnotation` (`W:55929`), `StampAnnotation` (`W:56140`); nothing else (Text/Popup/Widget/signature fields are not editable). The element's `_isEditable` (`C:17700`) puts it in `AnnotationLayer.#editableAnnotations` (`C:20904-20907`); when a layer is enabled each one is hidden and deserialised into an editor (`C:26855-26867`). Double-clicking an editable annotation in NONE mode dispatches `switchannotationeditormode {mode, editId, mustEnterInEditMode:true}` (`C:18277-18293`); the host switches mode. Deletion: `layer.detach` → `uiManager.addDeletedAnnotationElement(editor)` sets `editor.deleted = true` (`C:27065-27071`, `C:3800-3804`); `serialize()` then returns `serializeDeleted()` = `{id: annotationElementId, deleted: true, pageIndex, popupRef}` (`C:6350-6357`, e.g. `C:26622-26624`); the worker drops those refs from the page `/Annots` (`W:59013-59020`, `W:59051`). The storage removes the entry only for non-existing editors (`C:3792-3794`). When leaving edit mode, unchanged existing editors are removed and the original annotation re-shown (`C:26896-26935`); changed ones update the annotation element (`C:26924-26932`, `renderAnnotationElement`).

### (i) Modes: NONE vs DISABLE, AnnotationMode

- `annotationEditorMode: DISABLE` → no `AnnotationEditorUIManager` and no editor layers at all (`V:8469`, `V:7255-7258`); documents lacking `MODIFY_CONTENTS` permission are forced to DISABLE when `enablePermissions` (`V:8294-8296`).
- `NONE` → UIManager exists, layers render hidden/`nonEditing` (`C:26775-26781`, `V:4283`), existing editable annotations stay as normal annotation-layer elements; text selection works.
- `AnnotationMode` (`C:48-53`): `DISABLE 0` (no annotation layer at all; editor layer is still created, `V:7259`), `ENABLE 1` (annotations drawn on canvas, no interactive forms), `ENABLE_FORMS 2` (form widgets in the DOM; `renderForms` `V:8104`), `ENABLE_STORAGE 3` (canvas rendering uses `annotationStorage` values — for printing, `TA:421-430`).

### (j) UIManager public surface (constructor `C:2681`)

`destroy()` 2737, `hasSelection` 3890, `isEditorHandlingKeyboard` 4148, `getMode()` 4157, `isEditingMode()` 4160, `getActive()` 4154, `isActive(editor)` 4151, `currentLayer` 3556, `getLayer(pageIndex)` 3559, `currentPageIndex` 3562, `*getEditors(pageIndex)` 3768, `getEditor(id)` 3775, `firstSelectedEditor` 3880, `setSelected(editor)` 3860, `toggleSelected` 3844, `unselect` 3883, `selectAll()` 3981, `unselectAll()` 3987, `delete()` 3935, `undo()` 3896, `redo()` 3905, `copy/cut/paste(event)` 3326-3404, `focusMainContainer()` 2958, `setEditingState(bool)` 3524, `updateParams(type, value)` 3685, `updateMode(...)` 3576, `switchToMode(mode, cb)` 2916, `addToAnnotationStorage(editor)` 3098, `editAltText(editor, firstTime)` 2843, `updateUIForDefaultProperties(EditorClass)` 3841, `showAllEditors(type, visible)` 3718, `highlightSelection()` 3019, `commentSelection()` 3066, `translateSelectedEditors(x,y)` 4009, `getSelectionBoxes(textLayer)` 4166, `waitForEditorsRendered(pageNumber)` 2890, `highlightColors` 2797, `direction` 2787, `imageManager` 4163, `signatureManager` 2913, `hasCommentManager()` 2846, `viewParameters {realScale, rotation}` `C:2726-2729`, `_eventBus`, `_signal`. **`hasSomethingToUndo/Redo`, `getSelectedEditors`, `getEditorsCount`: NOT PRESENT** on the manager (undo/redo availability arrives in `editingstateschanged.details`; count via `[...uiManager.getEditors(i)].length` or `pdfDocument.annotationStorage.size` `C:6932`). Get the instance from the `annotationeditoruimanager` event (`V:8476`) or `pdfViewer._layerProperties.annotationEditorUIManager` (`V:8244`).

Editor instance API you may touch: `uid` 5273, `id`, `pageIndex`, `annotationElementId`, `deleted`, `editorType` 5206, `mode` 5209, `x/y/width/height` fractions, `getPDFRect()` 6237, `comment` get/set 5896/5917, `hasComment` 5958, `editComment()` 5961, `serialize()` 6358, `getData()` 6246, `remove()` 6391, `select()/unselect()/focus()` 6568-6594, `enterInEditMode()` 6621, `show(visible)` 6702, `altTextData` 5843.

AnnotationStorage (`C:6875-7079`): `getValue`, `getRawValue`, `setValue`, `remove`, `has`, `size`, `onSetModified/onResetModified/onAnnotationEditor` callbacks (`C:6880-6882`), `resetModified()`, `resetModifiedIds()`, `print` getter → `PrintAnnotationStorage` (`C:6947-6949`, `C:7080`), `serializable`, `modifiedIds`, iterable. `pdfDocument.annotationStorage` getter at `C:15628`; `saveDocument()` `C:15711` (`TA:1101`) returns the new PDF bytes with editor annotations written.

## 7. PDFFindController

Constructor `{linkService, eventBus, delay=250, updateMatchesCountOnProgress=true}` (`V:842-855`); listens to `find`, `findbarclose`, `pagesedited`. Dispatch a search:

```js
eventBus.dispatch("find", { source, type: "", query: "foo", caseSensitive: false, entireWord: false,
                            highlightAll: true, findPrevious: false, matchDiacritics: false });
```

`type` values handled in `#onFind` (`V:883-950`): `""` (new search, debounced by `delay`), `"again"` (next/prev), `"highlightallchange"`, and anything else such as `"casesensitivitychange"`, `"entirewordchange"`, `"diacriticmatchingchange"` (fall to `#nextMatch` after `#shouldDirtyMatch`, `V:995-1019`). `query` may be a string or `string[]` (`V:982-993`, joined as alternation `V:1109-1120`). Fields read: `query, type, caseSensitive, entireWord, highlightAll, findPrevious, matchDiacritics` (`V:1021`, `V:1124-1127`, `V:1206`, `V:1097`). Emits `updatefindcontrolstate` `{state, previous, entireWord, matchesCount:{current,total}, rawQuery}` (`V:1446-1458`) and `updatefindmatchescount` (`V:1440-1445`). `FindState` (`V:639-644`): `FOUND 0, NOT_FOUND 1, WRAPPED 2, PENDING 3`. Getters for a results list: `pageMatches` (array per page of match start offsets, `V:861`), `pageMatchesLength` (`V:864`), `selected` `{pageIdx, matchIdx}` (`V:867`), `state` (`V:870`), `highlightMatches` (`V:858`). Highlights are rendered by `TextHighlighter` into the text layer as `<span class="highlight [begin|middle|end] [selected] appended">` (`V:6043-6107`), styled at `CSS:709-756` (`--highlight-bg-color`, `--highlight-selected-bg-color`); the selected match is scrolled with `scrollMatchIntoView` (`V:929-945`). Clear: `eventBus.dispatch("findbarclose", {source})` → `#onFindBarClose` sets `FOUND`, turns off highlighting and refreshes all pages (`V:1400-1418`). `findController.setDocument` is called by `PDFViewer.setDocument` (`V:8557`).

## 8. PDFLinkService

Constructor `{eventBus, externalLinkTarget=null, externalLinkRel=null, ignoreDestinationZoom=false}` (`V:1475-1489`); public `externalLinkEnabled = true` (`V:1474`). `setDocument(pdfDocument, baseUrl=null)` `V:1490`, `setViewer(pdfViewer)` `V:1494`, `setHistory(pdfHistory)` `V:1497`; getters/setters `pagesCount` `V:1500`, `page` `V:1503-1510`, `rotation` `V:1511-1518`, `isInPresentationMode` `V:1519`. `goToDestination(dest)` (string name or explicit array / promise, `V:1522-1579`; pushes history, scrolls, focuses the text layer), `goToPage(numberOrLabel)` `V:1580-1596`, `goToXY(pageNumber, x, y, options)` `V:1597`, `executeNamedAction("GoBack"|"GoForward"|"NextPage"|"PrevPage"|"LastPage"|"FirstPage")` then dispatches `namedaction` (`V:1752-1782`), `executeSetOCGState` `V:1783`, `getDestinationHash(dest)` `V:1657`, `getAnchorUrl(anchor)` `V:1670`, `setHash(hash)` `V:1673-1751` (supports `page=`, `zoom=`, `nameddest=`, `pagemode=`, `search=`), `addLinkAttributes(link, url, newWindow=false)` `V:1617-1656`. `LinkTarget` (`V:1466-1472`): `NONE 0, SELF 1, BLANK 2, PARENT 3, TOP 4`. External links become `<a href=url title=url target=… rel=…>` with `rel` default `"noopener noreferrer nofollow"` (`V:1465`, `V:1653-1655`). For Electron use `externalLinkTarget: LinkTarget.BLANK` so clicks go through `webContents.setWindowOpenHandler`, or set `externalLinkEnabled = false` to get `href=""` + `onclick=()=>false` (`V:1634-1638`) and handle clicks yourself (the anchor keeps `title` = display URL). `SimpleLinkService` (`V:1796`) is the same class with a no-op `setDocument`.

## 9. PDFHistory

Constructor `{linkService, eventBus}` (`V:3786-3804`); `initialize({fingerprint, resetHistory=false, updateUrl=false})` `V:3805-3860`, `reset()` `V:3861`, `push({namedDest, explicitDest, pageNumber})` `V:3874`, `pushPage(n)` `V:3921`, `pushCurrentPosition()` `V:3948`, `back()`/`forward()` `V:3954-3971` (call `window.history.back()/forward()`), getters `popStateInProgress`, `initialBookmark`, `initialRotation` `V:3972-3980`. It **always** uses `window.history.replaceState/pushState(newState, "", newUrl)` (`V:3997-4001`) and binds `popstate`/`pagehide` on `window` (`V:4172-4190`); `newUrl` is `undefined` unless `updateUrl === true` and `document.location.protocol !== "file:"` (`V:3989-3996`), so `updateUrl:false` keeps the URL untouched (`document.location.hash` is still read by `getCurrentHash`, `V:3781-3783`). On `folio://app/index.html` the scheme must be registered as `standard` for `history.pushState` to be allowed (Chromium rejects it on non-standard schemes); because PDFHistory also fights your own `#` navigation, simplest is to not instantiate it and implement back/forward in-app with `updateviewarea.location.pdfOpenParams` + `linkService.setHash`.

## 10. PDFScriptingManager (AcroForm JS)

`build/pdf.sandbox.mjs` exists (118 KB) and exports `QuickJSSandbox(wasmUrl = "../web/wasm/")`, which loads `${wasmUrl}quickjs-eval.js` (`/home/user/claude/folio/node_modules/pdfjs-dist/build/pdf.sandbox.mjs:195-209`); the files are in `wasm/quickjs-eval.js` and `wasm/quickjs-eval.wasm`. Component class `PDFScriptingManagerComponents` (`V:7740-7760`): constructor `options = {eventBus, sandboxBundleSrc, wasmUrl, externalServices?, docProperties?}`; when `externalServices` is absent it installs a `window` listener forwarding `updatefromsandbox` CustomEvents to the bus (`V:7742-7749`) and creates `GenericScripting(sandboxBundleSrc, wasmUrl)` (`V:7750-7752`, class `V:7338-7367`: dynamic `import(sandboxBundleSrc)` then `QuickJSSandbox(new URL(wasmUrl, location.href).href)`). `docProperties` defaults to `V:7318-7337`. Base options typedef `TV/pdf_scripting_manager.d.ts:2-22`. Minimal setup:

```js
const scriptingManager = new pdfjsViewer.PDFScriptingManager({
  eventBus, sandboxBundleSrc: new URL("../node_modules/pdfjs-dist/build/pdf.sandbox.mjs", import.meta.url).href,
  wasmUrl: new URL("../node_modules/pdfjs-dist/wasm/", import.meta.url).href });
const pdfViewer = new pdfjsViewer.PDFViewer({ …, scriptingManager });
scriptingManager.setViewer(pdfViewer);          // V:7391 — host must call this
```

`setDocument` is called by the viewer (`V:8558`); it fetches field objects/calc order/JS actions, creates the sandbox and dispatches `sandboxcreated` (`V:7394-7505`). Public: `dispatchWillSave/DidSave/WillPrint/DidPrint()` (`V:7506-7541`), `ready` (`V:7545`), `destroyPromise` (`V:7542`). Sandbox commands handled: `print` → dispatches `print`, `SaveAs` → `download`, zoom/page navigation (`V:7554-7647`). The sandbox needs `isEvalSupported`-style wasm loading over your custom scheme; `wasmUrl` must resolve to the directory with a trailing slash.

## 11. Printing

`PDFPrintService` is NOT PRESENT in the bundle. Use `pdfViewer.getPagesOverview()` → `[{width, height, rotation}]` at scale 1 (`V:9306-9328`), honour `pdfViewer.printingAllowed` (`V:8076`, from `PermissionFlag.PRINT|PRINT_HIGH_QUALITY` `V:8290`), set `pdfViewer.renderingQueue.printing = true` while printing to pause page rendering (`V:7771`, `V:7794-7796`), and render each page:

```js
const printStorage = pdfDocument.annotationStorage.print;          // C:6947-6949 (PrintAnnotationStorage snapshot)
const page = await pdfDocument.getPage(n);
const viewport = page.getViewport({ scale: PRINT_UNITS, rotation });   // C:15792, TA GetViewportParameters
const task = page.render({ canvas, viewport, intent: "print",
  annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE, printAnnotationStorage: printStorage,
  optionalContentConfigPromise: pdfDocument.getOptionalContentConfig({ intent: "print" }) });  // C:15829; TA:391-460
await task.promise;
```

`RenderParameters` fields confirmed at `TA:391-463`: `canvas, viewport, canvasContext?, intent ("display"|"print"|"any"), annotationMode, transform, background, pageColors, optionalContentConfigPromise, annotationCanvasMap, printAnnotationStorage, isEditing, recordImages, recordOperations, operationsFilter`. Call `scriptingManager.dispatchWillPrint()/dispatchDidPrint()` around it if scripting is on (`V:7518-7541`).

## 12. Thumbnails

`PDFThumbnailViewer` is NOT PRESENT (only `TV/pdf_thumbnail_viewer.d.ts`). `PDFRenderingQueue.setThumbnailViewer(obj)` (`V:7777`) expects an object with `forceRendering()` and is only used when `isThumbnailViewEnabled` (`V:7773`, `V:7791-7793`); `PDFViewer` listens to `thumbnailrendered {pageNumber, pdfPage}` to clean up pages not in its cache (`V:8064-8071`). Minimal thumbnail: `const vp = page.getViewport({scale: thumbWidth / page.getViewport({scale:1}).width}); canvas.width = vp.width; canvas.height = vp.height; await page.render({canvas, viewport: vp, intent:"display", annotationMode: AnnotationMode.ENABLE}).promise;` (`C:15792`, `C:15829`, `TA:391-430`). You can also reuse `pageView.thumbnailCanvas` when non-null (`V:7306-7314`).

## 13. CSS requirements

- Container: `position:absolute` (enforced `V:7999-8001`) with `overflow:auto`; the inner div must carry class `pdfViewer` (`CSS:6301-6350` sets `--scale-factor: 1`, `--page-bg-color`, `.canvasWrapper`/canvas rules). `.pdfViewer .page` (`CSS:6353-6366`) defines `--user-unit`, `--total-scale-factor: calc(var(--scale-factor) * var(--user-unit))`, `--scale-round-x/y`, `margin: var(--page-margin)`, `border: var(--page-border)`. The viewer writes `--scale-factor` on the viewer element (`V:8480`, `V:8881`), `--user-unit` on page divs (`V:6600-6606`), and `--viewer-container-height` on `document.documentElement` (`V:9627-9631`). `:root` at `CSS:6238-6241` holds `--viewer-container-height: 0` and the pdfViewer padding vars.
- Text layer: `.textLayer` (`CSS:648-810`) requires `--total-scale-factor` from `.page`; find highlights at `CSS:709-756`; `.textLayer.highlighting` (touch-action) `CSS:668`; `.endOfContent`/`.selecting` `CSS:782-800`.
- Annotation layer: `CSS:811-1269` (form field vars, `--hcm-highlight-filter` from `.pdfViewer`).
- Editor styles **are included**: `.annotationEditorLayer` (`CSS:3466-3575`, `4010`, `4493`), `.freeTextEditor` (9 hits), `.inkEditor` (8), `.stampEditor` (5), `.highlightEditor` (6), `.signatureEditor` (4), `.editToolbar` (9), `.resizers` (3), `.altText` (3), `.colorPicker` (3), `.commentPopup` (12), `#editorComment` (8), `#editorUndoBar` (`CSS:374`), `.selectedEditor` (5). The editor `:root` block at `CSS:3372-3404` defines `--outline-width: 2px` (read by `AnnotationEditor.initialize` via `getComputedStyle(document.documentElement)`, `C:5249-5252`), `--editor-toolbar-vert-offset`, `--freetext-padding` (read `C:21260`), resizer vars and the editing cursors; `--comment-button-dim: 24px` at `CSS:2749`; toolbar vars at `CSS:3578-3592`.
- Image assets referenced as `url(images/…)` **relative to the CSS file** (`CSS` lines e.g. 3382-3386 cursors, 3579 `toolbarButton-editorHighlight.svg`, editor-toolbar-delete/edit, altText_*, comment-*, messageBar_*, loading-icon.gif, treeitem-*, pages_*, toolbarButton-* for the absent sidebar). Ship the whole `web/images/` directory next to `pdf_viewer.css`. `imageResourcesPath` is separate: it must point (with trailing slash) at a directory containing `annotation-comment.svg`, `annotation-note.svg`, `annotation-help.svg`, `annotation-key.svg`, `annotation-insert.svg`, `annotation-newparagraph.svg`, `annotation-paragraph.svg`, `annotation-check.svg`, `annotation-noicon.svg`, `annotation-paperclip.svg`, `annotation-pushpin.svg` (all present in `web/images/`; used `C:18631`, `C:20659`) — point it at the same `web/images/` directory.
- CSS variables used but never defined in pdf_viewer.css (all consumed inside `var(--x, fallback)` or guarded; verified by grepping each `--x:`): `--editor-toolbar-min-width` (`CSS:2570`), `--menuitem-height` (2572), `--focus-outline-color` (4884, 5294), `--focus-outline-width` (6248), `--focus-outline-offset` (1773), `--dir-factor` (2826, 3193), `--doorhanger-height` (6187), `--comb-offset` (1091), `--main-color` (1926, 2906), `--text-color` (46, 2886), `--toolbar-icon-bg-color` (5056), `--icon-size` (5598), `--link-color` (6251), `--border-color`, `--border-color-interactive`, `--checkbox-size`, `--color-accent-primary`, `--color-blue-60`/`--color-gray-20`/`--color-gray-60` (3375-3383, with fallbacks), `--button-*` family (16-160, fallbacks via `light-dark()`), `--background-color-box/-canvas`, `--border-radius-*`, `--border-width`, `--size-item-*`, `--comment-edit-button-icon` (2821), `--viewsManager-width`, `--sidebar-transition-*`. Safe host defaults on `:root`: `--dir-factor: 1` (set `-1` for RTL), `--editor-toolbar-min-width: 0`, `--menuitem-height: 32px`, `--focus-outline-color: #0060df`, `--focus-outline-width: 2px`, `--focus-outline-offset: 0`, `--doorhanger-height: 0`, `--comb-offset: 0`, `--main-color: light-dark(#15141a,#fbfbfe)`, `--text-color: light-dark(#15141a,#fbfbfe)`, `--toolbar-icon-bg-color: light-dark(#5b5b66,#fbfbfe)`, `--icon-size: 16px`, `--link-color: #0060df`, `--border-color: light-dark(#8f8f9d,#52525e)`, `--checkbox-size: 16px`, `--color-accent-primary: #0060df`, `--comment-edit-button-icon: url(images/comment-editButton.svg)`.

## 14. Host checklist

1. `pdfjsLib.GlobalWorkerOptions.workerSrc = "<url of build/pdf.worker.mjs>"` (`C:14343-14362`), and pass `cMapUrl`, `standardFontDataUrl`, `wasmUrl`, `iccUrl` (directories with trailing slash; `TA:69-104`) to `getDocument` so JBIG2/JPX/ICC and CJK fonts work offline (`cmaps/`, `standard_fonts/`, `wasm/`, `iccs/` ship in the package).
2. Import order: `build/pdf.mjs` before `web/pdf_viewer.mjs` (§0).
3. Construct in this order: `eventBus = new EventBus()`; `linkService = new PDFLinkService({eventBus, externalLinkTarget: LinkTarget.BLANK})`; `findController = new PDFFindController({eventBus, linkService})`; `pdfViewer = new PDFViewer({container, viewer, eventBus, linkService, findController, annotationEditorMode: AnnotationEditorType.NONE, annotationEditorHighlightColors: "…", imageResourcesPath})`; `linkService.setViewer(pdfViewer)` (`V:1494`); then per document `linkService.setDocument(pdfDocument, null)` and `pdfViewer.setDocument(pdfDocument)` (the viewer calls `findController.setDocument` and `scriptingManager.setDocument` itself, `V:8557-8558`).
4. `eventBus.on("pagesinit", () => { pdfViewer.currentScaleValue = "page-width"; })` — before that `_currentScale` is `UNKNOWN_SCALE` (`V:8722`) and pages would render at scale 1; `scrollPageIntoView` falls back to `"auto"` only when navigating (`V:9090-9092`).
5. Handle `showannotationeditorui` and `switchannotationeditormode` by assigning `pdfViewer.annotationEditorMode = {mode, editId, mustEnterInEditMode}` (§6a/g/h); subscribe to `annotationeditoruimanager` to capture `uiManager`; `editingstateschanged` / `annotationeditorparamschanged` drive your toolbar.
6. Before destroying a `loadingTask`, call `pdfViewer.setDocument(null)` and `linkService.setDocument(null)`; `setDocument(null)` destroys the UIManager and aborts internal listeners (`V:8383-8398`, `V:8745-8747`). Pass an `abortSignal` and abort it when the viewer DOM is removed (`V:8044-8053`).
7. Window resize: the viewer only refreshes the `--viewer-container-height` var on resize (`V:9633-9640`); re-apply `pdfViewer.currentScaleValue = pdfViewer.currentScaleValue` (only meaningful for preset strings) and call `pdfViewer.update()`, which is what the default app does.
8. Zoom: no wheel handling exists in `V`; implement `ctrl+wheel` with `pdfViewer.updateScale({steps: ±1, origin: [e.clientX, e.clientY], drawingDelay: 200})` (`V:9579-9610`). Pinch: `supportsPinchToZoom` only affects editor resizing (`C:6332-6340`); use `new pdfjsLib.TouchManager({container, onPinching: (origin, prevDistance, distance, dx, dy) => pdfViewer.updateScale({scaleFactor: distance / prevDistance, origin, pan: [dx, dy], drawingDelay: 200}), signal})` (`C:4820-4850`, callback signature `C:5022`).
9. Presentation mode: set `pdfViewer.presentationModeState` and dispatch `presentationmodechanged {state}` yourself (`V:8057`, `V:1898`).
10. Saving: `const bytes = await pdfDocument.saveDocument()` (`C:15711`); `annotationStorage.onSetModified/onResetModified` callbacks (`C:6880-6881`) tell you when the document is dirty; `resetModifiedIds()` is called when leaving edit mode (`V:9711`).
11. File picker side-effects: clicking the layer in STAMP mode never creates an editor (`C:27273-27276`), but `Enter`/`Space` with focus in the container calls `addNewEditorFromKeyboard` → `StampEditor` with no bitmap → **opens a native file picker** (`C:3671-3675`, `C:26195-26216`); same when the host dispatches `CREATE` without `bitmapFile/bitmapUrl`.
12. Electron external links: anchors get `target="_blank"` + `rel="noopener noreferrer nofollow"` with `LinkTarget.BLANK` (`V:1641-1655`); intercept in `webContents.setWindowOpenHandler` and `shell.openExternal`.