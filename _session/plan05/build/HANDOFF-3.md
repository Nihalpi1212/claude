# Hand-off 3: Pigment 0.5 skeleton, Part 2 steps 5 and 6 (PSD registries; chunks, colour, saving, opening)

Implementer 3 of 5. Nothing is committed; no git command that changes anything was run. Working tree of
/home/user/claude/pigment on top of implementers 1 and 2 (base 0.4.0, 99dbdee). A copy of every file I created or
edited (in its current state, which includes earlier implementers' edits in shared files such as app.js) is in
`scratchpad/plan05/build/step56-files/` (same relative paths).

Start state checked: unit 913/913 pass (as HANDOFF-2's RESTORED section says).

**Rebuild the vendor bundle after checkout:** `node scripts/build-vendor.mjs` (npm's postinstall does it). The bundle
`src/renderer/vendor/ag-psd.js` is git-ignored; step 5 changed its entry (fixes, internals). I rebuilt it here.

## Step 5: PSD (S4)

New files (`src/renderer/lib/psd/`):
- `registry.js`: `registerPsdLayerKind`, `registerPsdAspect`, `registerPsdResource` (each `(def, { builtin })`, same id:
  later wins, a builtin never replaces an earlier one, stable sort by order, returns an unregister function),
  `registerPsdOptions`, `registerPsdNotice(code, { when, text, timeout }, { builtin })`, `psdFeatures()`, plus
  (deviations) `registerPsdFeatures(flags)`, `psdLayerKinds()`, `psdAspects()`, `psdResources()`, `psdNotice(code)`,
  `psdNotices()`, `psdOptions(direction, base)`.
- `report.js`: `createReport()` → `{ add, count, details, codes, lines(when?), notices(when?) }`; `toastSaveNotices`.
- `convert.js` (frozen): `rgbFromPsd(c, fallback, profile)` (Lab through the pipeline's `fromLab`: no longer black or
  white), `psdColor`, `hsbHex`, `hsbToRgb`, `psdBlend`, `toPsdBlend`, `PSD_TO_BLEND`, `BLEND_TO_PSD`, `GRDM_CODES`,
  `GRDM_METHODS`, `psdGradientStops`, `gradientToPsd(def)` / `gradientFromPsd(a)` (0.4's Gradient Map mapping),
  `patternFromPsd(info)`, `patternCanvas(info)`, `patternRefFromPsd(info, { presetId })`, `patternToPsd({ name, id,
  canvas | width,height,data })`.
- `builtin.js`: kinds group 100 and raster 900; aspects common 100, blend-if 200, raster-mask 300, notices 1000;
  resources resolution 100, guides 200, composite 900 (0.4's Grayscale Channel Mixer / Duotone Gradient Map layers,
  Maximize Compatibility); the six 0.4 notices with 0.4's texts in 0.4's toast order; exports `blendIfToPsd`,
  `blendIfFromPsd`.
- `adjustments.js` (stub, psd-layers): 0.4's `adjustmentToPsd` / `adjustmentFromPsd` moved, kind `adjustment` 200,
  aspect `adjustment-placeholder` 110, `PSD_FEATURES = { fills: false }`.
- `text.js` (stub, psd-text): 0.4's `textLayerFromPsd`, `textToPsd`, `psdExpressible`, `PSD_TEXT_KEYS`,
  `cssFamilyFromPsFont` moved verbatim (the two functions now exported), kind `text` 400, `PSD_FEATURES = { textRuns }`.
- `effects.js` (`stylesFromPsd`, `stylesToPsd`, `PSD_FEATURES = { effects, advancedBlending }`), `vector.js`
  (`pathFromPsd`, `pathToPsd`, `{ vectorMasks, shapes }`), `tags.js` (`{ tags, globalLight }`): stubs with S4.6's
  signatures; they register no mapper.
- `read.js` (`readPsdDocument(bytes, { report })`), `write.js` (`writePsdDocument(doc, compositor, opts)`,
  `resolveMaximizeCompatibility`), `index.js` (imports all; `install(app)` runs each mapper file's optional install).

Edited: `lib/io.js` (PSD section replaced by re-exports of every 0.4 name; imports `./psd/index.js` so Node gets every
mapper; ag-psd through `#ag-psd`; `encodeForPath` passes its opts to `writePsdDocument`); `lib/documents.js` (open
notices: `showOpenNotices(doc)` after an open, one toast per line, 6 s); `package.json` (`"imports": { "#ag-psd" }`);
`index.html` (import map key `#ag-psd` beside `ag-psd`, CSP hash recomputed with `node scripts/csp-hash.mjs`);
`scripts/vendor-entries/ag-psd.js` (imports `ag-psd-fixes.js`, exports `fixesPatched` and `* from
ag-psd-internals.js`, keeps `grdmPatched`); new `ag-psd-fixes.js`, `ag-psd-internals.js` (every S4.5 name, plus
`parseBrushDescriptor`, a copy of ag-psd's private abr.js parsing with its MIT notice), `ag-psd-layers.js` and
`ag-psd-text.js` (stubs, `patched = false`).

S14.2's three PSD edits, each gated on `psdFeatures()` read in the page: `hunt5-styles.spec.mjs` (the test at 106),
`adjustment-blending.spec.mjs` (the notice at 376; 368 holds both ways), `masks-vector-masks.spec.mjs:255–259`
(landed branch: `vectorMask.path`, density ≈ 0.5, the raster mask at full strength `[255, 0, 255]`).

Tests: `tests/unit/psd-registry.test.mjs` (9), `skeleton-05.spec.mjs` "psd" (4): the six goldens compared **exactly**
(string-equal to the recorded JSON) while their mappers' flags are false, and every layer read back by name after; a
fake shape kind writes natively in RGB and declines in Grayscale (grey pixels, `modeRendered`/`asShown`); Maximize
Compatibility off → white composite, `hasRealMergedData: false`, no thumbnail, also from `settings.psd` `'never'`
('ask' behaves as on); a mapper's open notice reaches `doc.openNotices` and a toast.

## Step 6: chunks, colour, saving and opening (S5, S6, S12.3, S12.6)

New files:
- `lib/io-chunks.js`: `chunkFormatFor`, `readChunks` (never throws; `{ damaged: true }`), `writeChunks` (same bytes
  for an empty patch; kinds the format cannot write are ignored), `chunkSupport`, `registerChunkProvider`,
  `chunksFor`, `applyChunks`, plus (deviations) `sniffChunkFormat`, `chunkProviders`.
- `lib/io-chunks/jpeg.js`, `png.js`, `webp.js`, `tiff.js`, `psd.js` (S5's table), and `bytes.js` (shared byte and
  8BIM helpers; not in the contract's file list).
- `lib/color/pipeline.js`: everything of S6.1, S6.2, S6.4, S6.5: `SRGB`, `setColorEngine`, `colorEngine`,
  `workingRGB`, `setWorkingSpaces`, `profileOf`, `convertColor`, `toLab`, `fromLab`, `toSRGB`, `convertCanvas`,
  `cssColor`, `describe`, `profilesList`, `profileById`, `assignProfile(app, doc, profile, label)`,
  `registerDisplayStage`, `displayStages`, `toDisplay`, `displaySpaceOf`, `displayCanvas`, `attachColorPipeline`.
  Node-safe (Node tests import it through `psd/convert.js`).

Edited (all marked `color (lib/color/pipeline.js)`, `chunks (lib/io-chunks.js)` or `open hooks (S12.6)`):
- `io.js`: `decodeImage(bytes, name, { colorSpaceConversion })`; `openDocument` awaits the engine (≤ 3 s), reads the
  chunks, asks `decodeConversion` before choosing a reader, passes `colorSpaceConversion` to the registered reader and
  `decodeImage`, then `adoptOnOpen(doc, { chunks, format, conv })`; `exportImage` applies the chunks after every
  encoder (`purpose: opts.purpose ?? 'export'`); `encodeForPath` passes `purpose: 'save'` and applies 'save' to PSD
  and layered encoders; `.pigment` writes `profile.icc` and `readPigment` restores `doc.profile`.
- `modes/formats.js` (both decodeImage fallbacks pass the conversion), `depth.js` (16-bit PNG save applies 'save'),
  `edit-ops.js` (the PNG copy applies 'copy'; without a provider the 0.4 path runs untouched).
- `compositor.js`: `noteDamage(rect | 'full')` (extra), `takeDamage(token)`; logged by every full composite path
  (`compositeOnce` full, `compositeView` region and full; 'same' and the version early return log nothing).
- `canvas-view.js`: `toDisplay` for the composite and the preview frame; context made in `displaySpaceOf(view)`
  (`getContext('2d')` exactly as 0.4 for 'srgb'); `syncColorSpace()` swaps `<canvas class="view">` on
  `'color:display-changed'` (the canvas listeners are recorded once through a stand-in object in `#bindPointer` and
  re-added to the new element; rulers bound once); `view.space`.
- `document.js` (`doc.profile`, `describe().profile`), `image-ops.js` (Duplicate copies it), `smart-object.js`
  (`cloneDocument` copies it).
- `documents.js`: `registerSaveOptions(formatOrExt | exts[], { ask })` (0.4's JPEG/WebP quality is the built-in),
  `saveOptions()` replaces the `lossyOptions` call in `writeTo`; `registerOpenHook(fn, { order })`, `runOpenHooks`
  (exported, used by Batch); `openPaths(paths, { interactive })` runs the hooks then shows the open notices.
- `app.js`: `attachColorPipeline(app)` in `start()` after the keymap store; `file:open-paths` / `file:open-recent` pass
  `interactive: ctx.source !== 'action'`; status bar segment `profile` (created only while `describe()` is non-empty).
- `automate/batch.js`: open hooks with `interactive: false`, their notices in `summary.notes` and the batch log;
  Image Processor's "Convert Profile to sRGB" converts a tagged document's JPEG through `toSRGB` (`convertTo: 'srgb'`).
- `modes/save-for-web.js`: "Convert to sRGB" awaits `toSRGB` for a tagged document (`convertTo: 'srgb'`).
- `extras.js`: New Document "Color Profile" select (`profilesList()` + "Don't Color Manage This Document").
- `panels/info.js`: "Profile" row (hidden while ''), the Lab readout through `toLab(rgb, doc.profile)`.
- `panels/navigator.js`: thumbnail through `displayCanvas`.
- `src/main/ipc.js`, `src/preload.cjs`, `lib/bridge.js`: `listColorProfiles()`.

Tests: `tests/unit/io-chunks.test.mjs` (9), `tests/unit/color-pipeline.test.mjs` (5), `skeleton-05.spec.mjs` "colour"
(6): untagged saves and exports byte-identical (PNG, JPEG, WebP, PSD, the registered encoders, Save As, no
`profile.icc`); with a fake engine a PNG's iCCP is adopted (decoder asked with 'none') and re-embedded by save, Export
As and copy with their purposes; a soft-alpha palette PNG reaches the browser decoder once with 'none'; Assign Profile
is one entry, undoes, survives `.pigment` and Duplicate, and the status bar shows it only with an engine; a display
stage converts only regions after its first full conversion and a `sampleMerged` between two paints loses no region;
a display-space change swaps the view canvas, which still paints with the Brush; an open hook sees `interactive: true`
from Open, `false` from Batch, and nothing for New or Duplicate.

## Deviations (file, name, what differs, why)

1. `psd/registry.js`: `registerPsdFeatures(flags)` and the getters (`psdLayerKinds`, `psdAspects`, `psdResources`,
   `psdNotice`, `psdNotices`, `psdOptions`). psdFeatures() must merge flags from files the registry cannot import
   (cycle); read.js / write.js need the lists.
2. A kind's `write` returning null **declines**, and the next kind is asked (S4.2's "declines without claiming").
3. Resources on **read** follow the write rule too: order < 500 before the layers, ≥ 500 after (the composite fallback
   for a file without layers must see whether layers were read).
4. Two aspects not in S4.3's list: `adjustment-placeholder` 110 (adjustments.js; gives an unknown adjustment's slot its
   0.4 name and hides it after the common aspect wrote the layer's own) and `notices` 1000 (builtin.js; counts
   'styled' and 'pixel-text' after every other aspect, so a claim made by an aspect of any order is seen).
5. 'pixel-text' counts text layers not claimed `'text'` **that 0.4 would have written as text** (not text on a path or
   stacked text, colour `asShown`); S4.2's "text layers no kind claimed" would also count path text, which 0.4 never
   reported. Same texts and counts as 0.4.
6. The stub text kind's `match` includes `psdExpressible(layer)` and `asShown(colour)`; non-expressible text falls to
   the raster kind (0.4's pixels, unchanged).
7. Write ctx extras: `imageMode` (`greyOnTop`, `inksOnTop`, `inks()`), `flatten()`, `psdOptions` (ag-psd options the
   composite resource may change); read ctx `patterns` is a `Map` of PSD pattern id → PatternInfo.
8. `write.js` imports `compositor.js` and `mask-render.js`, outside S4.1's list: 0.4's io.js already imported both at
   top level (Node-safe); `maskOf` and `shown` reach the mappers through ctx, so mapper files do not import them.
9. `writePsdDocument(doc, compositor, opts)` also takes `opts.report` and `opts.notices: false` (no toasts);
   `readPsdDocument(bytes, { report })`.
10. Maximize Compatibility off writes a **white** opaque composite (ag-psd writes black zeros without a canvas) and
    `versionInfo { hasRealMergedData: false, writerName/readerName 'Pigment', fileVersion 1 }`.
11. `#ag-psd`: Chromium (and Electron 44) accept the `#` key in the import map; no fallback needed. `io.js` also imports
    `#ag-psd` now; specs keep importing `'ag-psd'` (same module URL, same instance).
12. `ag-psd-fixes.js` exports `fixesPatched = { grdm, layers, text }` (each fix file exports `patched`; three
    `patched` names cannot be re-exported side by side).
13. PNG zlib in `io-chunks/png.js` uses `shared/pixels/png.js zlibCodecs` (zlib-wrapped), not `zip.js streamCodecs`
    (raw deflate, which iCCP/zTXt cannot hold).
14. `io-chunks/bytes.js`: a helper file not in the New files table.
15. Resolution as read: PNG pHYs per metre is reported per inch rounded to 0.1 (2835 ppm is 72.009 dpi); JPEG, TIFF,
    PSD to 0.01. PSD ResolutionInfo is pixels per inch; unit 2 is reported as `'cm'` with the value / 2.54. TIFF EXIF
    is not supported (0.6), as the table says.
16. `readChunks` sniffs the signature first (a file whose extension lies is read as what it is); `applyChunks` sniffs
    when `formatOrExt` names no chunk format.
17. `toDisplay` hands stages `{ damage, scratch: boolean, source: 'composite' | 'processed' | 'preview' }`. Because the
    compositor alternates two back buffers, a stage keys its kept copy of the composite on (view, profile id, space)
    and applies `damage`, not on the input canvas object as S6.4's last bullet says.
18. `pipeline.js` extras: `displaySpaceOf(view)`, `profileOf(doc)`, `workingRGB()`, `setWorkingSpaces()` (S6.2 names
    it for 0.6), `assignProfile` lives here. An engine may add `toLab`, `fromLab`, `cssColor`, `describe`,
    `convertCanvas`, `profileById`; the pipeline uses them when present (not in S6.1's interface) and otherwise answers
    as the stub. `displayCanvas` converts with `engine.transform` to the built-in whose `wellKnown` is the space.
19. Before `ready()` resolves, a registered engine gets the stub's answers for the sync calls (`live()`); 
    `'color:display-changed'` fires once it resolves (and from `attachColorPipeline` if it was ready before).
20. `documents.js`: `registerSaveOptions` takes one extension or an array; `runOpenHooks` exported for Batch. A hook's
    `notice` in openPaths appends to `doc.openNotices`; in Batch it goes to `summary.notes` (new field of both Batch
    and Image Processor summaries) and the log file (now also written when only notes exist).
21. New Document: `profile` enters the replay arguments and `newDocPreset` only when it is not sRGB, so 0.4's recorded
    arguments and presets are unchanged; the field is hidden for Bitmap.
22. Save for Web: `srgb: false` enters the arguments only when unticked (0.4's arguments otherwise); the checkbox help
    now reads "Converts a document in another colour profile to sRGB; sRGB and untagged documents are not changed".
23. Info panel's Lab readout through `toLab` landed in step 6 (S6.6), not step 8; step 8 has nothing left there.
24. Status bar `profile` segment and Info row exist only while `describe()` is non-empty (no hidden element is
    created without an engine).

## Not done

Nothing of steps 5–6 is left. Not in my steps: `edit:assign-profile` stays icc-engine's stub (the skeleton gives
`assignProfile` for it); the `color-profiles` kind is step 10's `registerPresetKinds05`.

## Test counts at the end (whole suites, after step 6)

| Suite | Result |
|---|---|
| Unit | **936 / 936** pass (913 + psd-registry 9 + io-chunks 9 + color-pipeline 5) |
| Browser (port 8850, one worker, 27.1 min) | 639 listed: **635 passed, 3 skipped, 1 failed** (the known flake, below). 639 = 629 + skeleton-05 "psd" 4 + "colour" 6. The 3 skipped: record-goldens (2) and the gated repaint-speed case. |
| Electron | **7 / 7** pass (the renderer loads `#ag-psd` through the import map under `pigment://`) |

**The one failure is the known "Execution context was destroyed" flake** (task #26), not a regression:
`tests/e2e/extras2.spec.mjs:73` "Image Size keeps text on its scaled path", in the full run of
`scratchpad/logs/impl3-full-e2e.log` (test 185 of 639), at `helpers.mjs:33` `runAwait` (the spec's line 80,
`image:size`). Whole message:
`Error: page.evaluate: Execution context was destroyed, most likely because of a navigation. [original: Protocol error (Runtime.callFunctionOn): Promise was collected]`.
Re-run alone with `--repeat-each 3` (port 8849): 3 / 3 pass. No trace: the run used `--trace off` as instructed. No retry
was added. Every other test, including every 0.4 PSD, save, export, open, colour and Batch spec, passed.

After the full run I removed one unused re-export from `lib/psd/report.js` (`psdNotice`); unit tests and skeleton-05
"psd" pass after it. No test server, browser or Electron process of mine is left running (the servers on ports
8892–8894 belong to the flake investigation in `scratchpad/flake26/`).

## Tips for the next implementer (step 7: Camera Raw)

- `skeleton-05.spec.mjs` helpers added: `fakeEngine(page, { space })` (step 6). FLAG_MODULES already lists
  `/lib/develop/registry.js`: create the file at that path.
- After editing any `scripts/vendor-entries/*` file run `node scripts/build-vendor.mjs`; after editing the import map
  run `node scripts/csp-hash.mjs`.
- `openDocument` now awaits one microtask for the engine and reads chunks; readers get `{ name, path,
  colorSpaceConversion }`.
- A save goes through `docs.saveOptions(doc, path, { ask })` (S12.3), not `lossyOptions` directly.
