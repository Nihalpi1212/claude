### The skeleton as landed: where it differs from the text above

The skeleton follows the contracts above; where the code forced a different or extra detail, it is listed here (the
names above stay valid). Package owners build against this list too.

**Goldens and tests (Part 2, step 0).**

- Fifteen stroke cases, not fourteen: the pressure ramps with `pressureSize` and with `pressureOpacity` are two cases.
  The cases, the bases they are drawn on and the page code that drives them live in `tests/e2e/goldens.mjs` (shared by
  the recorder, `brush-golden.spec.mjs` and skeleton-05 "psd"); a page that defines `window.__goldenStroke(c, ctx)` or
  `window.__goldenWritePsd(doc)` drives another form of the same case. `record-goldens.spec.mjs` runs only with
  `PIGMENT_RECORD=1` and is never run again: the fixtures are 0.4.0's recording.
- The brush PNGs are straight RGBA encoded with `shared/pixels/png.js encodeRgba8`: decode them with `decodePng` and
  `toRgba8` and compare with `getImageData`, never through a canvas (premultiplication rounds low alphas).
- The text layers' bounds in `psd-golden/text.json` and `grayscale.json` come from the fonts of the recording machine.
- `tests/unit/fixtures/develop-04.mjs` is 0.4's `develop.js` with a three-line header and its `./core.js` import
  pointing at `src/shared/pixels/core.js`; nothing else differs.

**S1–S3 (brush).**

- `brush/preset.js` also exports `withoutSampleData(preset)` (the store, settings and the migration keep presets without
  data URLs). `brushFromLegacy` of a 0.4 *preset* always gives `tool.flow` (`flow ?? 1`: 0.4's Brushes panel set flow 1
  on every pick of a preset without one).
- The migration keeps 0.4's ids by pushing into the store's order (`app.presets.state('brushes').order`): `add()` makes
  new ids and `presets.js` is frozen. It runs only when `settings.brushPresets` has entries.
- `setToolBrush` writes the flat tip keys a tool has an option for (and `angle`, `roundness`, `spacing` for `'full'`
  tools), clamped to the tool's own option (DabTools 1000 px), and `preset.tool` values only for options the tool has,
  as 0.4's Brushes panel did; `brushPresetId` only when a presetId is given. Protect Texture keeps the current pattern
  and scale; the flag itself comes from the incoming preset.
- `[` and `]` clamp to the tool's own maximum as well as 5000 (DabTools stop at 1000); the Pencil's maximum is 5000
  (`PENCIL_SIZE`). `ensureCoverage` reads the reach once per stroke from `toolBrush`, so Eraser Block and the Pencil
  keep 0.4's growth margin.
- `traceDabs(..., { modifiers })` takes per-trace modifiers; the `finish` sample is the last sample extended again
  without smoothing (0.4's move-then-release, which `dabs.json` recorded). The engine exports `runBufferModifiers`
  (unit-tested). The `coverage` stage's mask is the dab box ∩ the target canvas (not yet ∩ the selection bounds).
- Cursor preference labels: Standard, Precise, Normal Brush Tip (`outline`), Full Size Brush Tip (`full`).

**S4 (PSD).**

- `psd/registry.js` extras: `registerPsdFeatures(flags)` (flags of files the registry cannot import), `psdLayerKinds()`,
  `psdAspects()`, `psdResources()`, `psdNotice(code)`, `psdNotices()`, `psdOptions(direction, base)`.
- A kind's `write` returning null declines and the next kind is asked. Resources on read follow the write rule: order
  < 500 before the layers, ≥ 500 after.
- Two aspects beyond S4.3: `adjustment-placeholder` 110 (`adjustments.js`: an unknown adjustment's slot keeps 0.4's name
  and is hidden) and `notices` 1000 (`builtin.js`: counts 'styled' and 'pixel-text' after every other aspect).
  'pixel-text' counts only text 0.4 would have written as text (not text on a path or stacked text), so the counts and
  texts are 0.4's. The stub text kind matches `psdExpressible(layer)` with an `asShown` colour; other text falls to the
  raster kind.
- Write ctx extras: `imageMode` (`greyOnTop`, `inksOnTop`, `inks()`), `flatten()`, `psdOptions`; read ctx `patterns` is a
  `Map` of PSD pattern id → PatternInfo. `write.js` imports `compositor.js` and `mask-render.js` (0.4's io.js did);
  mappers reach `maskOf` and `shown` through ctx.
- `writePsdDocument(doc, compositor, opts)` also takes `opts.report` and `opts.notices: false`; `readPsdDocument(bytes,
  { report })`. Maximize Compatibility off writes a white opaque composite and `versionInfo { hasRealMergedData: false,
  writerName / readerName 'Pigment', fileVersion 1 }`.
- `#ag-psd` works in Chromium and Electron 44 import maps; `io.js` imports `#ag-psd`, the specs keep `'ag-psd'` (one
  module instance). `ag-psd-fixes.js` exports `fixesPatched = { grdm, layers, text }`. Rebuild the bundle with
  `node scripts/build-vendor.mjs` after editing a vendor entry and the CSP hash with `node scripts/csp-hash.mjs` after
  editing the import map.

**S5–S6 (chunks, colour, opening, saving).**

- `io-chunks.js` extras `sniffChunkFormat`, `chunkProviders`; `io-chunks/bytes.js` holds the shared byte and 8BIM
  helpers. `readChunks` sniffs the signature first; `applyChunks` sniffs when `formatOrExt` names no chunk format. PNG
  zlib uses `shared/pixels/png.js zlibCodecs` (iCCP and zTXt hold zlib streams). Resolution as read: PNG pHYs per inch
  rounded to 0.1, JPEG, TIFF and PSD to 0.01; PSD unit 2 is reported as `'cm'`.
- `pipeline.js` extras: `displaySpaceOf(view)`, `profileOf(doc)`, `workingRGB()`, `setWorkingSpaces()`; `assignProfile`
  lives here. An engine may add `toLab`, `fromLab`, `cssColor`, `describe`, `convertCanvas`, `profileById`; the pipeline
  uses them when present. Before `ready()` resolves a registered engine gets the stub's answers for the sync calls;
  `'color:display-changed'` fires once it resolves.
- `toDisplay` hands stages `{ damage, scratch, source: 'composite' | 'processed' | 'preview' }`; the compositor
  alternates two back buffers, so a stage keys its kept copy on (view, profile id, space) and applies `damage`.
  `compositor.noteDamage(rect | 'full')` is an extra.
- `documents.js`: `registerSaveOptions` takes one extension or an array; `runOpenHooks` is exported (Batch uses it); a
  hook's `notice` appends to `doc.openNotices`, in Batch to `summary.notes` (new field of the Batch and Image Processor
  summaries) and the log file.
- New Document's `profile` and Save for Web's `srgb: false` enter the replay arguments only when they differ from 0.4's
  default, so 0.4's recorded arguments are unchanged. The Info panel's Lab readout through `toLab` landed with S6.6. The
  status bar segment and the Info row exist only while `describe()` is non-empty.

**S7 (colour UI).** `color-picker.js` also exports `colorValue(hex)`, `swatchHex(data)`. `swatchColors(app)` reads the
`swatches` kind only once `settings.colorUI.swatchesMigrated` is true (until then 0.4's edited palette shows). The
`color` widget's spec fields are `key`, `dataK`, `id`, `text`, `title`, `ariaLabel`, `className`, `style`, and the widget
exposes `.input`; `form.js` keeps its own `color` case (0.4's DOM); the options bar's `color` kind uses `onInput` only
(0.4 listened to `input`). The gradient field's two colours are in the stub `gradient` widget, which 0.4's gradients
package replaces at start-up. `sampleMerged`'s `skipAdjustments` skips layers of type `'adjustment'`.

**S8 (Camera Raw) and S12.4.**

- `develop-stages.js` holds the loop (`develop.js` re-exports it): `develop(img, params, rect, { docWidth, docHeight })`;
  extras `developNeutral`, `developMargin(params, w, h)`, `isBuiltinStage(id)`. `params.normalize(p)` receives the whole
  params (defaults merged in) and returns the stage's own keys. The builtins keep 0.4's neutral test and clamping; the
  margins of `texture-clarity`, `noise` and `sharpen` are 48 (0.4's fixed margin). `developDefaults()` includes
  `treatment: 'color'`, after 0.4's keys.
- `develop/registry.js` extras: `developTools`, `workspaceSlots(place)`, `isBuiltinDevelop(kind, id)`; every
  registration returns its unregister function; `createFakeWorkspace(params, image, { origin, onSet, onInvalidate })`
  records `sets`, `invalidations`, `cursor`.
- `develop-ui.js` has its own `developDialog` (0.4's pixelEditDialog for this dialog, same DOM) so it can restart the
  session when the needed margin grows; the skeleton's tool strip is a row of buttons over `createFakeWorkspace` (no
  pointer routing). Camera Raw params from a source other than `'action'` / `'repeat'` open the prefilled dialog (also
  on smart layers).
- `filter:last` also accepts `{ command, params }`; it is enabled only while the remembered command is.
  `filter:last-dialog` records the command with what it resolves with, and nothing when cancelled.

**S9, S13 (keys and menus).**

- Color Settings…, Assign Profile… and Convert to Profile… landed with the stubs (step 2), for the Search probe of
  S14.2.
- In Electron 44 on Windows and Linux the page sees F7 first: `shortcuts.js` runs `window:panel-layers` with source
  `'key'` and prevents the default, so the native accelerator never fires there; on macOS the menu takes the key
  (`'menu-key'`). `keys-05.spec.mjs` asserts one run either way.
- `main.js`'s Shift+Alt table also holds the paint keys without a global binding (Shift+Alt+Q Behind, Shift+Alt+R
  Clear) and sends them as their paint command, so menu mnemonics never swallow them.
- `set(..., { force: true })` refuses (returns the conflicts, changes nothing) for a `FIXED_KEYS` key or one a key
  source owns. `FIXED_KEYS` is `{ [cmd]: { accel, platforms?, development? } }` with `fixedKeyFor(cmd, { platform,
  isPackaged })`. A "plain key" has no Ctrl, Cmd or Alt and is not a function key; Shift+letter counts as plain.
- `actions.js builtinKeyOwner` reads `effectiveKeys(app.keymap.overlay())`, not `keysFor` (which reads the tables after
  the actions' own keys shadowed them). Window > Toggle Full Screen shows the effective renderer key (F11 by default).

**S10 (preset files).**

- `preset-formats.js` extras: `importPresetBytes(app, [{ name, bytes }], { kinds })` and `exportPresetBytes(app, kind,
  ids, format)` (the file-free halves of `importPresetFiles` and `exportPresetsDialog`, used by the Node tests),
  `opensAsPresets(path)` (the routing test of `documents.js` and `app.js`), `presetFileExtensions({ kinds })`.
  `presetFileFormatFor(nameOrExt, { kinds })` prefers formats of those kinds; `registerPresetFileFormat` returns its
  unregister function; `exportPresetsDialog` also takes `path` (0.4's `exportPresets(app, ids, path)`) and
  `defaultName`.
- `presetFileFormats()` returns one shape for both registries: `{ id, name, extensions (no dot), kinds, store, read,
  write, import, def }` (`store`: 0.4's registry, read and written through `app.presets`). A kind's own
  `pigment-presets` variant (patterns renames its pixel files) is listed once, as the `'*'` format; among the `'*'`
  formats this registry's (the bundle) come before `.pigment-presets`, which is last.
- A `.pigment-presets` file always goes to the kind its JSON names, whatever `kinds` the caller gave; its `extraBlobs`
  are written before the store import. A `$presetRef` the file does not hold (or a cycle) becomes `null` with a report
  line. The report is shown with `app.dialogs.alert(…, { detail })`; the toast reads "Imported 3 presets: Brushes 2,
  Patterns 1". Extensions an open format reads (the patterns' Images format) are never routed: they open as documents.
- `OPEN_FILTERS` itself is unchanged, because Place, Replace Contents and Load Files into Stack use it too: File > Open
  (`documents.js openDialog`) adds the "Presets" filter before "All files" when the dialog opens. A Shift-drop places
  the images and imports the preset files; a plain drop goes through `openPaths`, which routes.
- `installPresetFormats(app)` registers the skeleton's blob refs and nothing else.
- `registerPresetKinds05()` also re-registers `tool-presets` with 0.5's data (`normalizeToolPreset`, exported:
  `options.brush` of a 0.4 preset becomes `brush`); `keyboard-shortcuts` has the built-in `photoshop-defaults` ("Photoshop
  Defaults", `{ v: 1 }`), `menu-sets` the built-in `default` ("Default"); `styles` and `shapes` keep 0.4's definitions
  until presets-panels re-registers them. Step 8 registered `swatches`, `color-books` and `color-profiles`; `swatches`
  built-ins have ids `default-<i>` and the hex as name.
- `brush/abr.js` (stub): a sampled tip's blob is an 8-bit grey PNG written with stored deflate blocks (synchronous, so
  `brushFromAgPsd` stays pure), named `tip-<sha1 of the PNG>.png`; a computed tip keeps its hardness, a sampled one gets
  1; other tip types and every other section are reported. `preset-files/aco-ase.js` (stub) names its writers
  `writeAse({ groups, colors })` and `writeAco({ colors })`, each `→ { bytes, report }`.
- `shapeProps.unit`: `normalizeShapeProps` keeps it only when present (0.4 layers read as before);
  `regenerateShape` fills it (a copy of the preset's path) on the first edit while the preset exists; `shapePath`
  prefers it to the resolver.

**S11 (type).** `TYPE_OPTION_DEFAULTS` has no `warp` key (absent means null), so 0.4's typeOptions are unchanged;
`WARP_STYLES` is listed in `model.js` (warp.js is not Node-safe; skeleton-05 checks they match). `api.js`: `renderText`
marks `transformed: true` when a transformed stage ran; `setEditing` redraws only when a registered `'bypass'` stage
applies; extra `isEditing(layer)`. `font-library.js` reads local font records only when the `local-fonts` permission is
already granted (no prompt), within 3 s; `favourites` and `recent` are no-ops; extras `createStubCatalog`,
`parsePostScriptStyle`. In `tools/text.js` a family or style patch goes through `type/target.js applyChar` only when it
says more than 0.4's font patch (a PostScript name, axes, or any patch of a `real` catalog), so with the stub catalog
0.4's runs, entries and labels stay; new option keys `orientationToggle`, `antiAlias`, `warpText`; `app.typeTools()`
lets `editor.js` find a subclass's session; a mask tool without a partner has no `sibling`. Anti-alias labels "Windows
LCD" and "Windows".

**S12.1–S12.2 (toolbox and transform).**

- `registerOptionsSlot` returns its unregister function; the same id replaces a slot; of several `'title'` slots the
  first by order that renders wins; `'end'` slots come after the tool's own `renderOptions`. With no slot the bar is
  0.4's. `resetOptions('*')` emits `'tool:options'` `{ tool, key: '*' }` for every registered tool. `setOptions`
  compares old and new values by JSON for its per-key events and re-renders only when the tool is active (the Type
  tool's bar still shows the active text layer's values, as in 0.4).
- `TransformTool.planFor(doc, { selectionOnly, quiet })` (extra) is the code `start()` and `previewBox()` share;
  `beginDrag(p, handle)` (extra) is the press code a grab reuses. `previewBox` returns null while a transform runs.
  `start({ grab })` clears the temporary tool only for a grab. The history label stays 0.4's "Free transform".
- `lib/tools/move-handles.js` exports `MOVE_FEATURES = { handles: false }` (frozen) and is not imported yet:
  move-tool-depth adds the import to `tools/move.js`.

**S14.2 (existing specs).** One line beyond the table: `shapes-live.spec.mjs:91` pinned a new custom shape's
`shapeProps` exactly; presets-panels fills `unit` there, so the line now compares without `unit` (and checks it is a
path when present).
