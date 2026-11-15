# Pigment 0.6: the skeleton contract (draft for review)

Two parts. **Part 1** is the text of a new section "## 0.6 features (contracts)" for ARCHITECTURE.md, written for the
sixteen package owners and the skeleton implementer. **Part 2** is the checklist of skeleton-06, file by file, in steps
that keep the app and the suite working.

Names of 0.4 and 0.5 are reused without restating them: rules 1–15 of "Rules for the parallel round", extension points
E1–E55, sections A–O (0.4: C preset store, D document store, E sessions and command flags, H field widgets, L.1/L.2
Properties and Preferences sections, L.9 drop handlers, L.14 type panel sections) and S1–S15 (0.5: S4 PSD mapper
registries, S5 io-chunks, S6 colour pipeline and display stages, S8 develop stages and registry, S9 keymap store, S10
preset files, S11 type, S12 toolbox / save options / open hooks, S15 capability flags). New extension points continue
the numbering (E56–E86); the shared integration points of 0.6 are T1–T18. Paths are relative to `src/renderer/` unless
they start with `src/`, `scripts/` or `tests/`.

**Starting point.** The code 0.6 starts from is 0.5 as released: the 0.5 contract plus the deviations the skeleton's
implementers recorded (`plan05/build/HANDOFF-*.md`), with the fifteen 0.5 packages delivered as their sections promise.
Where this contract names a 0.5 function, the deviation list's spelling wins (for example `registerPsdFeatures`,
`noteDamage`, `toDisplay`'s `source` field, `registerSaveOptions` taking an array, `runOpenHooks` exported). Everything
a 0.6 package uses from a 0.5 *package* (not the 0.5 skeleton) is listed in "Reliances on 0.5", to be checked against
the code when 0.5 is released, before skeleton-06 starts.

---

# Part 1: ARCHITECTURE.md, "## 0.6 features (contracts)"

## 0.6 features (contracts)

Pigment 0.6 is "Photoshop parity, stage 4": the selection tools and the Select menu, channels, smart filter depth,
History snapshots and non-linear history, Color Settings and Convert to Profile, soft proofing, metadata through open
and save, PSD document resources and depths, Export As, the Save As options and the common formats, recovery and file
handling, OpenType and the Glyphs panel, camera RAW opening, PDF import and placing, and view navigation. It is built
like 0.4 and 0.5: **skeleton-06** lands first (contracts, extension points, every new menu item and key binding, stub
modules, capability flags), then **sixteen packages** are built at the same time in one checkout, then everything is
integrated, hunted for cross-feature bugs, reviewed and released.

### Rules for the parallel round

Rules 1–15 hold (one owner per existing file; new files and stubs; register, do not patch; stubs through
`stubCommands`; one settings namespace per package; stylesheets and `registerIcons`; `docs/0.6/<package>.md`; tests
with their own port and artifacts directory; the whole suite green; marked call sites kept; stub-pinning skeleton tests
gated, never deleted; one owner per behaviour; the five paths; `PIGMENT_PARTIAL=1`). Rule 14 becomes: the skeleton's
specs use 8850, the packages 8851–8866 in the order of "Packages". Rule 15 becomes rule 17 below. Added:

16. **Edit targets and the selection are a sixth path.** Every feature that writes pixels (a tool, a filter, an
    adjustment, a fill, a paste, a stroke, a history paint) writes into `editTarget(app)` (T2) and honours the
    selection; it is checked on a colour channel, an alpha channel and a layer mask as well as on a layer, or its docs
    say why the target refuses it. Rule 13's five paths stay: undo and redo, `.pigment` and PSD round trip, actions,
    16/32-bit and non-RGB modes, Electron.
17. **Third-party code.** Two packages bring third-party code: pdf-import (pdf.js, Apache-2.0) and raw-open-workflow
    (LibRaw, LGPL-2.1, chosen over its CDDL-1.0 option). The skeleton adds the `pdfjs-dist` dependency (T15.1);
    raw-open-workflow owns `package.json` and `package-lock.json` for the round, after the skeleton's entry, for its
    LibRaw build (T14.1). Each vendors through its own E23 step (`scripts/vendor/pdfjs.mjs`,
    `scripts/vendor/libraw.mjs`). Every package that ships third-party data lists it, with licence text, in
    `docs/0.6/<package>.md` for the release notices.
18. **History writes.** Every in-place change of a layer canvas, a mask canvas, an alpha channel's mask or a `deep`
    plane goes through the History pixel APIs (`beginStroke`/`endStroke`, `pixels`, `replaceCanvas`) or calls
    `doc.history.willWrite(target, rect)` first (T4.6). A package that writes pixels any other way breaks snapshots and
    says so in its report; the integrator moves the write.
19. **Display, not composite.** Channel views, spot inks, proof colours and gamut warnings are display stages (S6.4);
    they never enter `compositor.composite()`, so merged sampling, the Info panel's numbers, exports and the `pixel()`
    spec helper read document pixels as in 0.5.
20. **Spec lines the skeleton gates** are listed in T18.2; a package that finds another line pinning a 0.5 behaviour it
    changes does not edit it: it names file and line in its report and the integrator gates it (rule 11).

### Behaviours split across packages (rule 12)

| Behaviour | Half and owner | Other half and owner | Between them |
|---|---|---|---|
| Dragging inside a selection | the outline drag and arrow nudges of the selection tools (selection-tools-depth) | moving pixels with the Move tool (move-tool-depth, 0.5, landed) | `Selection.offset`, `select:offset` (T1.2, skeleton) |
| Select Subject, Object Selection, Quick Selection's edges | the tools and options-bar buttons (selection-tools-depth) | `select:subject`, `select:sky`, Focus Area (select-menu-finish) | the segmenter registry (T1.6, skeleton; local-models-segmentation 0.9 registers models) |
| Select and Mask | the workspace, its presets, preview quality (selection-tools-depth) | the commands that hand over to it: Focus Area, Color Range "Select and Mask…" (select-menu-finish) | `select:select-mask` argument (T1.5) |
| Quick Mask | the mode, Quick Mask Options, its history (select-menu-finish) | the Channels panel row (channels-depth) | `registerChannelRows` (T3.3, skeleton) |
| Painting, filtering, filling into a colour channel, an alpha channel, a mask | the target kinds and their channel restriction (channels-depth) | the tools, filters, fills (0.5 code; call sites converted by the skeleton) | `editTarget`, `restrictToTarget` (T2) |
| Paste into a mask or a channel | the target kinds' `paste` (channels-depth) | the paste flow (skeleton, `edit-ops.js`) | T2.4 |
| Alpha and spot channels in files | the channel model and UI (channels-depth) | PSD (psd-document), TIFF and Save As options (save-options-common-formats) | the channel fields (T3.1) |
| Smart filters in PSD | the filter mapping and the `smart-filters` aspect (smart-filters-depth) | writing the smart object itself (linked-smart-objects, 0.7) | the aspect writes only on a layer a kind claimed `'smart-object'` (T5.6) |
| Lens Blur depth maps, Displace maps, Texturizer files on smart objects | resources and the render-time hook (smart-filters-depth) | the filter kinds (0.3, unchanged) | `registerFilterResource` (T5.4) |
| History Brush, Eraser "erase to history", Fill › History | the source state and its pixels (history-panel-depth) | the three call sites (skeleton now; retouch-tools-depth 0.7) | `history.sourcePixels` (T4.4) |
| Revert and Auto-Update Open Documents | the commands, file watching (file-handling-autosave) | replacing a document's content in one entry (skeleton) | `app.docs.replaceContent` (T12.3) |
| Snapshots and Revert as states | snapshots (history-panel-depth) | document states (skeleton, `lib/doc-state.js`) | `captureDocState` / `applyDocState` (T4.3) |
| Working spaces, untagged documents | the settings and the engine (color-settings) | every reader of `workingRGB()` (0.5 pipeline, skeleton) | `setWorkingSpaces` (T7.1) |
| Profile mismatch on open and paste | the policy and its dialogs (color-settings) | the open hook runner (0.5 skeleton), the paste flow (skeleton) | `registerOpenHook`, `registerColorPolicy` (T7.3) |
| CMYK, Lab and Gray numbers in the picker, Info and Color panels | the conversions (color-settings) | the UI (0.5 color-picker-swatches' files; call sites converted by the skeleton), Info readouts (skeleton registry) | `toCmyk` / `fromCmyk` / `toGray` (T7.2), `registerInfoReadout` (T7.5) |
| Proof Colors, Gamut Warning, gamut alarms | the proof condition, the display stage, the gamut test (soft-proofing) | CMYK and proofing transforms in the engine (color-settings, owner of `lib/color/cmm.js`) | `engine.proofTransform`, `proofTransformFor`, `outOfGamut` (T8) |
| Use Proof Setup on save, Out of Gamut in Color Range | the option, the Color Range kind (save-options-common-formats, select-menu-finish) | the conversion and the test (soft-proofing) | `proofConvertCanvas`, `outOfGamut` (T8.4) |
| Metadata in saved and exported files | the chunk provider and the store (metadata-io) | Export As' Metadata choice (export-as); Save As keeps all | `opts.metadata` (T9.4) |
| Convert to sRGB and Embed Color Profile in Export As | the options (export-as) | the `'icc'` provider and `toSRGB` (icc-engine, 0.5) | `opts.convertTo`, `opts.embedProfile` (S6.3) |
| EXIF orientation | the open hook that rotates, reset on save (metadata-io) | readers say whether they applied it (skeleton: `decodeImage`, readers) | `doc.metadata.orientation`, `info.orientationApplied` (T9.3) |
| Layered TIFF | the TIFF writer and option (save-options-common-formats) | the PSD layer section (skeleton byte helpers over `writePsdDocument`) | `psdLayerSection` (T10.5) |
| Save As options | the panel and the format dialogs (save-options-common-formats) | the save flow (skeleton, `documents.js`) | wildcard `registerSaveOptions('*')`, `opts.asCopy` (T11.2) |
| RAW files | decoding, the session, workflow, filmstrip (raw-open-workflow) | develop stages and the workspace (0.5) | `developPlanes`, `ctx.input`, workspace slots (T14) |
| RAW sidecar .xmp | reading and writing the sidecar (raw-open-workflow) | the crs: mapping (camera-raw-workspace, 0.5) | `paramsToXmp` / `paramsFromXmp` facade (T14.5) |
| RAW camera data | EXIF from the decoder into the document (raw-open-workflow) | storing and writing it (metadata-io) | `setMetadata` (T9.2) |
| Placed PDF / AI stays sharp | the vector source kind (pdf-import) | `SmartLayer.render` (skeleton change; smart-filters-depth's file afterwards) | `registerSourceKind` (T6) |
| OpenType features | the catalogue use, buttons, menus, glyph insertion (type-opentype-glyphs) | applying `features` while shaping (type-fonts 0.5, unchanged) | CharStyle `features` (0.4 A) |
| OpenType in PSD | the `text-features` aspect (type-opentype-glyphs) | the text kind (psd-text, 0.5, unchanged) | aspect order 410 (T13.4) |
| Edge auto-scroll | scrolling the view (view-navigation) | every dragging tool (unchanged; opt-out trait) | `autoScrolls(tool)` (T16.3) |
| Space during a gesture | the marquee and shape repositioning (selection-tools-depth) | key routing (skeleton, `shortcuts.js`) | `tool.takeSpace` (T1.4) |
| Channel keys Ctrl+2…9, Ctrl+\\ | the commands (channels-depth) | the bindings (skeleton) | T17 |
| H, R and Z in the Hand slot | Hand, Rotate View, Zoom tools (view-navigation) | letter resolution (skeleton, `shortcuts.js`) | T16.5 |

### Ownership of existing files

Every existing file 0.6 changes (0.5's new files included). "skeleton" means skeleton-06 makes all of 0.6's changes
there and no package edits it afterwards. Column "Plug in" says what the skeleton lands first in a package-owned file,
or which extension point the other packages use instead of editing it. Every skeleton call site placed in a file
another package owns carries a marker comment naming the T-section, as in rule 10.

| File | Owner | What the owner changes | Plug in |
|---|---|---|---|
| `app.js` | skeleton | MODULES; `'app:started'` emitted at the end of `start()` (T12.4); `file:revert` moves to `lib/file-handling.js` verbatim; ui state keys of T17.5; `app.editTarget` (T2) | E62, E81 |
| `lib/edit-ops.js` | skeleton | `colorRange`/`rangeMask` move to `lib/color-range.js`, `modify` and the six Modify commands to `lib/select-modify.js`, quick mask to `lib/quick-mask.js`, `select:save`/`select:load` to `lib/channel-dialogs.js` (all verbatim, T1.7); `pixelTarget` becomes `editTarget` (`app.pixelTarget` kept as an alias); paste asks the target and the colour policy (T2.4, T7.3); Fill › History reads `history.sourcePixels` (T4.4); registers `select:offset` (T1.2) | E62, E65, E72 |
| `lib/selection.js` | skeleton | `offset(dx, dy)`, `Selection.equals` (T1.1) | E56 |
| `lib/layer-ops.js` | skeleton | `setLayerProps` marks a `{ visible }`-only entry `visibility: true` (T4.1) | E65 (move-tool-depth's 0.5 markers stay) |
| `src/shared/pixels/selection-ops.js` | select-menu-finish | localized colour clusters, hue-dominance ranges, `canvasBounds` option of the Modify operations | skeleton lands first: `floodFill(…, { sample })` (Magic Wand Sample Size, T1.3, marked) |
| `lib/tools/select.js` | selection-tools-depth | marquee styles, outline drags and nudges, the lassos with live-wire, Quick Selection, Wand sample size | skeleton lands first: the magnetic snap and the Quick Selection flood move to the stubs of `livewire.js` and `quick-select.js` (T1.3); keeps `applySelection`, `COMBINE_OPTION`, the classes' exports; the snap calls stay (rule 10) |
| `lib/tools/object-select.js` | skeleton | `objectSelect` through `segment('object', …)` (T1.6) | E59 |
| `lib/select-mask.js` | select-menu-finish | Focus Area brushes and views; Select Subject / Sky through segmenters | skeleton lands first: the three `segment()` calls (marked) |
| `lib/select-mask/workspace.js`, `preview.js` | selection-tools-depth | tool options, brush picker, reduced preview and High Quality / Real-time Refinement, presets, Remember Settings | keeps `TOOL_ID`, `REFINE_DEFAULTS`, `normaliseRefine`, `refineOptions`, the DOM `select-mask.spec` drives |
| `lib/select-mask/engine.js`, `output.js`, `ops.js`, `worker.js` | skeleton | `engine.js` asks the segmenter registry (T1.6); `output.js` unchanged | E59 |
| `lib/panels/channels.js` | channels-depth | eyes, targets, reorder, Channel Options, spot channels, shortcuts, panel menu | skeleton lands first: rows from `channelRows(doc)` after the saved channels (T3.3); keeps the DOM of T3.6 |
| `lib/panels/layers.js` | skeleton | `filterRows` moves verbatim to `lib/panels/layers-filters.js` (smart-filters-depth's); the layer and mask thumbnails set the target through `app.setEditTarget` (0.4's `setEditingMask` kept in step, T2.2) | E25, E68 |
| `lib/smart-object.js` | smart-filters-depth | filter mask, per-filter blending, resources, drag between layers, re-edit, PSD hand-off | skeleton lands first: source kinds and place readers (T6), filter entries keep the T5.1 fields, `applySmartFilter` resolves resources (T5.4, stub: none) |
| `lib/history.js` | history-panel-depth | the entry tree, snapshots, options, source, delete state, Clear History | skeleton lands first: `source()`, `sourcePixels()`, `willWrite()` and its calls inside `beginStroke` / `pixels` (T4) |
| `lib/panels/history.js` | history-panel-depth | source column, New Snapshot dialog, History Options, panel menu | keeps T4.8's DOM |
| `lib/tools/paint.js`, `retouch.js`, `fill.js`, `bucket.js`, `adjustment-brush.js`, `lib/tools/vector.js` (its `pixelTarget` twin), `lib/brush/engine.js` (the restriction at composite) | skeleton | every stroke and fill target through `editTarget` (T2.3); History Brush and erase-to-history through `sourcePixels` (T4.4) | E62, E65 (no 0.6 package edits these files) |
| `lib/adjust-ui.js`, `lib/filter-ui.js` | skeleton | `beginPixelEdit` takes `editTarget(app, { for: 'filter' \| 'adjust' })` and commits through `restrictToTarget` (T2.3) | E62 |
| `lib/depth.js` | skeleton | `willWrite(layer.deep)` before every in-place deep rewrite (T4.6); the png16 encoder passes `opts.interlace` and `opts.compression` to `encodePng` (T11.3) | E67, E78 |
| `lib/io.js` | skeleton | `.pigment` entry providers (T5.5, T9.5, T12.2), smart sources through kinds (T6), the channel fields (T3.1), `openDocument(…, { as, interactive })`, `null` results, orientation flag (T9.3, T12.1) | E70, E71, E80 |
| `lib/document.js` | skeleton | `doc.metadata` (T9.2); channel `kind` / `spot` / `options` in `describe()` and normalised (T3.1); `cloneLayer` copies a smart layer's `filterMask` (T5.1) | E68, E76 |
| `lib/documents.js` | skeleton | wildcard save options and `asCopy` (T11.2), open groups and `{ as }` (T12.1), `replaceContent` (T12.3), `SAVE_FILTERS` from the registered formats | E78, E80, E81 |
| `lib/io-chunks.js`, `lib/io-chunks/*.js` | skeleton | TIFF EXIF read and write, PSD thumbnail resource 1036, `readOrientation` (T9.1) | E76 |
| `lib/file-info.js` | metadata-io | reads and writes through the store; the `writeTo` wrap and `stampPsd` removed | keeps `xmpPacket`, `parseXmp`, `readExif`, `describeExif`, `normaliseInfo`, `hasInfo`, `app.fileInfo.withInfo` (batch.js calls it) |
| `lib/file-ops.js`, `lib/layers-extras/export.js` | export-as | Export As, Quick Export, Layers to Files, per-layer Export As over `lib/export/*` | keeps `properties()` (File Info) as it is, the command ids and their replay arguments (T11.5) |
| `lib/psd/registry.js`, `read.js`, `write.js`, `index.js` | skeleton | byte stages and raw resources (T10.2), the import lines for the 0.6 mapper files | E77 |
| `lib/psd/builtin.js` | skeleton | none in 0.6: psd-document re-registers `guides` (the builtin rule keeps its registration) | E40 |
| `lib/color/pipeline.js` | skeleton | `setWorkingSpaces({ rgb, cmyk, gray, spot, options })`, `workingSpaces()`, device conversions, proof hooks, `registerColorPolicy` (T7, T8) | E72–E74 |
| `lib/color/cmm.js`, `profiles.js`, `doc-profile.js` | color-settings | CMYK, Gray and Lab transforms, proofing and gamut transforms, device links and abstract profiles, conversion options | keeps every S6.1 member and icc-engine's exports |
| `lib/color-modes.js` | soft-proofing | `view:proof` / `view:gamut` on the proof stage; its `postProcess` hook goes | T8 |
| `lib/modes.js` | color-settings | `image:mode` through profiles when they exist (T7.4) | keeps spot channel handling with the T3.1 fields |
| `lib/adjust-more-ui.js` | color-settings | Color Lookup with abstract and device-link profiles; Export Color Lookup Tables (.cube, .3dl, .csp, ICC) | |
| `lib/color-picker.js`, `lib/panels/color.js`, `lib/panels/color-views.js` | skeleton | CMYK fields and sliders through `toCmyk`/`fromCmyk`, the gamut alarm through `outOfGamut` (marked) | E73, E74 (no 0.6 package edits them) |
| `lib/panels/info.js` | skeleton | the secondary readouts become `registerInfoReadout` registrations (0.5's three are the built-ins) | E75 |
| `lib/extras.js` | skeleton | `zoomWithWheel` and `animatedZoom` move from the built-in `interface` section to a new built-in `navigation` section (T18.1) | E20 |
| `lib/type/char-format.js` | skeleton | the Character panel menu gains "OpenType ▸" from the shared catalogue (T13.2) | E83 |
| `lib/develop-ui.js`, `lib/develop/workspace.js` | raw-open-workflow | the workspace opened on a RAW session (several images, filmstrip, output buttons) | keeps camera-raw-workspace's API and S8.3's DOM; E47's slots |
| `src/shared/pixels/develop.js`, `develop-stages.js`, `lib/develop/registry.js` | skeleton | `developPlanes`, `ctx.input`, the import of `develop-linear.js`, the xmp facade (T14.2, T14.5) | E84 |
| `lib/canvas-view.js` | view-navigation | zoom range and animation, wheel and gestures, overscroll, edge auto-scroll, scroll bars, flick panning | keeps `MIN_ZOOM`/`MAX_ZOOM` exports, `ZOOM_STEPS`, S2.5/S3.3's pointer contract, S6.4's display path |
| `lib/tools/nav.js` | skeleton | Hand, Rotate View and Zoom move verbatim to `lib/tools/view-tools.js` (view-navigation's) | the Eyedropper, Color Sampler and Ruler stay (no 0.6 package edits nav.js) |
| `lib/panels/navigator.js` | view-navigation | Ctrl-drag region zoom, panel options, view box colour | keeps 0.5's `displayCanvas` call (marked) |
| `lib/shortcuts.js`, `lib/tools.js`, `lib/tool-traits.js` | skeleton | `takeSpace` routing (T1.4), tool letters in shared slots (T16.5), `autoScrolls(tool)` (T16.3) | E61, E85, E86 |
| `lib/automate/batch.js` | skeleton | `openDocument(…, { interactive: false })` (T12.1) | E80 |
| `src/shared/pixels/tiff.js`, `png.js` | save-options-common-formats | TIFF read (JPEG-in-TIFF, YCbCr, Lab, pages, orientation left to metadata-io) and write (byte order, pyramid, layers, alpha channels); PNG compression option | keeps every export the unit tests and io-chunks' tests import |
| `src/shared/formats.js` | skeleton | `psdt`, `pdf`, `ai`, the RAW extensions (T15, T14) | |
| `src/shared/keymap.js`, `src/shared/menu-template.js` | skeleton | every 0.6 item and binding (T17) | |
| `src/shared/defaults.js` | skeleton | the 0.6 namespaces (T18.1) | rule 5 |
| `src/main/ipc.js`, `src/preload.cjs`, `lib/bridge.js` | skeleton | share, recovery folder, file-change events (T12.5) | E82 |
| `lib/stubs-later.js` | skeleton | drops `edit:color-settings`, `edit:convert-profile` (now `lib/color/*` stubs) | |
| `lib/preset-kinds.js` | skeleton | `registerPresetKinds06()` (T18.3) | E5 |
| `index.html` | skeleton | stylesheet links; no import map change (pdf.js and LibRaw are loaded by URL from `vendor/`, T15.1, T14.1) | rule 6 |
| `package.json`, `package-lock.json` | raw-open-workflow | its LibRaw build dependency, if it uses one; `build.asarUnpack` for `src/renderer/vendor/libraw/**` (T14.1) | skeleton lands first: `pdfjs-dist` (T15.1) |
| the spec lines of T18.2 | skeleton | gated as listed | |

No 0.6 package edits a file owned by "skeleton" in this table, nor these, which 0.6 does not change: `compositor.js`,
`sessions.js`, `commands.js`, `presets.js`, `doc-store.js`, `image-ops.js`, `temp-tools.js`,
`canvas-capture.js`, `sample.js`, `brush.js` and `lib/brush/*` other than `engine.js`, `layer-move.js`, `lib/psd/text.js` and the other 0.5 mapper files,
`lib/type/*` other than the new files, `panels/character.js`, `panels/properties.js`, `actions.js`, `keymap-store.js`,
`preset-formats.js`, `src/main/main.js`, `src/main/watch.js`, and `src/shared/pixels/*` other than `selection-ops.js`,
`tiff.js`, `png.js`, `develop.js`, `develop-stages.js` and the new files.

### Where the briefs are wrong about the code

The decisions are binding:

- **Registration is not an edit.** raw-open-workflow and pdf-import do not touch `io.js` (`registerOpenFormat` exists
  since 0.3; the skeleton adds `interactive`, `null` results and open groups); type-opentype-glyphs does not touch
  `panels/character.js` (its OpenType row is an E26 section) nor `type/shaper.js` (CharStyle `features`, a map of
  OpenType tag to value, has reached HarfBuzz through `featureList` since 0.4); raw-open-workflow does not touch the
  workspace for slots (E47's `registerWorkspaceSlot` has `'filmstrip'`, `'footer-start'`, `'footer-end'`; it owns the
  workspace files only for the RAW entry point, T14.4); psd-document does not touch `psd/registry.js` (it registers
  resources and byte stages); channels-depth does not touch `compositor.js` (channel views and spot inks are display
  stages, rule 19); soft-proofing and type-opentype-glyphs do not touch `main/menu.js` (it re-exports
  `src/shared/menu-template.js`, the skeleton's); color-settings and soft-proofing do not touch `extras.js` (their
  preferences are E20 sections; the colour picker moved out of `extras.js` in 0.5).
- **`edit-ops.js` is split, not shared.** select-menu-finish, channels-depth and history-panel-depth all named it; the
  skeleton moves each one's code into that package's new file verbatim (T1.7, T3.5) and converts the rest (T2, T4.4).
- **Non-linear history does not need stored states.** Undo and redo closures are exact inverses; a tree of entries
  reaches any state by undoing to the common ancestor and redoing down the other branch (T4.2). Only snapshots (and
  Revert's previous content) keep document states, through `lib/doc-state.js` (T4.3).
- **Metadata containers are the skeleton's.** metadata-io does not edit `io-chunks.js` nor `tiff.js`: TIFF EXIF, the
  PSD thumbnail and orientation reading land in the skeleton's container code (T9.1); metadata-io decides what is
  written. TIFF orientation is applied by metadata-io's open hook, so `tiff.js` stays save-options-common-formats'.
- **Smart filters cannot stay editable in PSD before smart objects are written natively.** 0.5 writes smart objects as
  pixels (kind 500 is reserved for linked-smart-objects, 0.7). smart-filters-depth delivers the filter descriptor
  mapping and the `smart-filters` aspect, which takes effect once a kind claims `'smart-object'`; until then the save
  notice says the filters are kept in `.pigment` only (T5.6). See the open questions.
- **The Rotate View tool keeps its place in the Hand slot**, as in Photoshop; what is wrong is the letter resolution
  (R activates the slot's last-used tool). The skeleton fixes it in `shortcuts.js` (T16.5); no slot is added.
- **Quick Mask stays a hidden layer in 0.6.** Moving it onto the channel target would make select-menu-finish wait for
  channels-depth; it gets options, history and a Channels panel row through `registerChannelRows` (T3.3).
- **The workspace for RAW opens without a document.** 0.5's workspace opens on a layer or a smart filter; the RAW
  entry point is new code in the workspace files, which raw-open-workflow owns for the round (T14.4).
- **PSB still stops at the canvas limit**, and `.psdt` is a PSD whose open hook makes the document untitled (T10.6).
- **Layered TIFF reuses the PSD writer** through the skeleton's byte helpers (`psdLayerSection`, T10.5), not by
  editing `lib/psd/write.js`.
- **The skeleton cannot know LibRaw's packaging.** T14.1 fixes the licence route and the loading contract;
  raw-open-workflow chooses the build and records it.

### New files

| Package | New files (owned) | MODULES entry (stub by the skeleton until the package lands) |
|---|---|---|
| skeleton | `lib/edit-target.js` (T2), `lib/channel-rows.js` (T3.3), `lib/segmenters.js` (T1.6), `lib/doc-state.js` (T4.3), `lib/source-kinds.js` (T6), `lib/pigment-entries.js` (T5.5), `lib/info-readouts.js` (T7.5), `lib/psd/bytes.js` (T10.4), `src/shared/opentype-features.js` (T13.1), `tests/e2e/skeleton-06.spec.mjs`, `tests/e2e/helpers-06.mjs`, the unit tests of Part 2; the stub files below | none of its own (the registries are plain imports) |
| selection-tools-depth | `src/shared/pixels/livewire.js` (stub: straight segments, T1.3), `src/shared/pixels/quick-select.js` (stub: 0.5's windowed flood moved out of `select.js`), `lib/tools/selection-brush.js` (stub), new `lib/select-mask/presets.js` | `lib/tools/selection-brush.js` (after `lib/tools/select.js`) |
| select-menu-finish | `lib/color-range.js`, `lib/select-modify.js`, `lib/quick-mask.js` (stubs: 0.5's code moved from `edit-ops.js`, working), new `lib/select-mask/focus-tools.js` | the three, right after `lib/edit-ops.js` |
| channels-depth | `lib/channel-dialogs.js` (stub: 0.5's `select:save` / `select:load` moved, working; the T17 `channel:*` ids stubbed), `lib/channel-target.js`, `lib/spot-channels.js` (stubs) | `lib/channel-dialogs.js` after `lib/edit-ops.js`; `lib/channel-target.js` in the 0.6 block |
| smart-filters-depth | `lib/panels/layers-filters.js` (stub: 0.5's `filterRows` moved), `lib/smart-filter-mask.js`, `lib/smart-filter-resources.js` (stubs), `lib/psd/smart-filters.js` (stub, loaded by `lib/psd/index.js`) | `lib/smart-filter-mask.js` |
| history-panel-depth | `lib/history-states.js` (stub: `HISTORY_FEATURES`), `lib/panels/history-menu.js` (stub: the `history:*` ids) | `lib/history-states.js` |
| color-settings | `lib/color/settings.js` (stub: `edit:color-settings`), `lib/color/convert.js` (stub: `edit:convert-profile`), new `lib/color/lut-icc.js` | `lib/color/settings.js`, `lib/color/convert.js` |
| soft-proofing | `lib/color/proof.js` (stub: `view:proof-setup`, `PROOF_FEATURES`), new `src/shared/pixels/color-blind.js` | `lib/color/proof.js` |
| metadata-io | `lib/metadata-store.js` (stub: T9.2's API over raw chunks, `METADATA_FEATURES`), new `src/shared/metadata/exif.js`, `xmp.js`, `iptc.js` | `lib/metadata-store.js` |
| psd-document | `lib/psd/resources.js`, `channels.js`, `deep.js`, `modes.js` (stubs with their `PSD_FEATURES` flags false, loaded by `lib/psd/index.js`) | none |
| export-as | `lib/export/prefs.js` (stub: `file:export-preferences`, `EXPORT_FEATURES`), new `lib/export/dialog.js`, `assets.js` | `lib/export/prefs.js` |
| save-options-common-formats | `lib/save-options.js` (stub: the `'*'` registration answering `{}`, `SAVE_OPTION_FEATURES`), new `src/shared/pixels/jpeg-encode.js`, `bmp.js`, `ico.js` | `lib/save-options.js` |
| file-handling-autosave | `lib/file-handling.js` (stub: 0.5's `file:revert` moved from `app.js`, working; `file:open-as`, `file:share`, `file:versions` stubbed), `src/main/share.js` (stub, T12.5), new `lib/recovery.js`, `versions.js`, `file-watch.js` | `lib/file-handling.js` |
| type-opentype-glyphs | `lib/type/features.js` (stub: `type:opentype` stubbed, `openTypeMenuItems`), `lib/panels/glyphs.js` (stub: `window:panel-glyphs` stubbed), `lib/psd/text-features.js` (stub, loaded by `lib/psd/index.js`), new `lib/type/alternates-popup.js` | `lib/type/features.js`; `lib/panels/glyphs.js` after `lib/panels/tool-presets.js` |
| raw-open-workflow | `lib/raw/workflow.js` (stub: `RAW_FEATURES`), `src/shared/pixels/develop-linear.js` (stub, empty, imported by `develop.js`), new `lib/raw/decode.js`, `session.js`, `scripts/vendor/libraw.mjs`, `src/renderer/vendor/libraw/` (built) | `lib/raw/workflow.js` |
| pdf-import | `lib/pdf/import.js` (stub: `PDF_FEATURES`), new `lib/pdf/smart-source.js`, `scripts/vendor/pdfjs.mjs`, `src/renderer/vendor/pdfjs/` (built) | `lib/pdf/import.js` |
| view-navigation | `lib/tools/view-tools.js` (stub: 0.5's Hand, Rotate View and Zoom moved from `nav.js`, working), `lib/view-motion.js` (stub: `VIEW_FEATURES`), new `lib/view-scrollbars.js` | `lib/tools/view-tools.js` right after `lib/tools/nav.js` |

**MODULES order** (app.js). Right after `lib/edit-ops.js`: `lib/color-range.js`, `lib/select-modify.js`,
`lib/quick-mask.js`, `lib/channel-dialogs.js` (they hold working 0.5 commands, so they keep 0.5's early place). After
`lib/tools/select.js`: `lib/tools/selection-brush.js`. After `lib/tools/nav.js`: `lib/tools/view-tools.js`. The 0.6
block after `lib/shortcuts-editor.js` (the last 0.5 command entry) and before `lib/panels/color.js`, in package order:
`lib/channel-target.js`, `lib/smart-filter-mask.js`, `lib/history-states.js`, `lib/color/settings.js`,
`lib/color/convert.js`, `lib/color/proof.js`, `lib/metadata-store.js`, `lib/export/prefs.js`, `lib/save-options.js`,
`lib/file-handling.js`, `lib/type/features.js`, `lib/raw/workflow.js`, `lib/pdf/import.js`; `lib/panels/glyphs.js`
after `lib/panels/tool-presets.js`. `lib/stubs-later.js` keeps its place. `lib/psd/index.js` gains the import lines of
`resources.js`, `channels.js`, `deep.js`, `modes.js`, `smart-filters.js`, `text-features.js` (S4.1's reserved list
plus `text-features.js`). `start()` calls `registerPresetKinds06()` after `registerPresetKinds05()` and emits
`'app:started'` after the startup files and the session restore.

### Extension points

Thirty-one new extension points; the T-section specifies each.

| # | Extension point | Where | Used in 0.6 by | Later users |
|---|---|---|---|---|
| E56 | Selection offsets: `Selection.offset`, `select:offset` | `lib/selection.js` (T1.1–T1.2) | selection-tools-depth | pen-paths (path selection drags), move-tool work |
| E57 | Selection tools' options-bar buttons (Select Subject, Select and Mask) through E39 slots | `tools.js registerOptionsSlot`, `SELECTION_TOOLS` (T1.3) | selection-tools-depth | local-models-segmentation (Object Finder) |
| E58 | Live-wire engine | `src/shared/pixels/livewire.js` (T1.3) | selection-tools-depth | pen-paths (magnetic pen, Content-Aware Tracing) |
| E59 | Segmenters | `lib/segmenters.js` (T1.6) | select-menu-finish, selection-tools-depth | local-models-segmentation, neural-filters-local |
| E60 | Color Range kinds | `lib/color-range.js registerColorRangeKind` (T1.5) | select-menu-finish, soft-proofing (Out of Gamut) | local-models-segmentation (Skin Tones, Detect Faces) |
| E61 | Space during a gesture | `tool.takeSpace`, `shortcuts.js` (T1.4) | selection-tools-depth | pen-paths, shapes, crop |
| E62 | Edit targets and channel restriction | `lib/edit-target.js` (T2) | channels-depth | cmyk-lab-storage (real plates), deep-pipeline |
| E63 | Channels panel row providers | `lib/channel-rows.js` (T3.3) | select-menu-finish (Quick Mask) | cmyk-lab-storage |
| E64 | Channel views and spot inks as display stages | S6.4 orders 40–60 (T3.2) | channels-depth | print (separations preview), cmyk-lab-storage |
| E65 | History tree and source | `lib/history.js` (T4.1–T4.4) | history-panel-depth | retouch-tools-depth, scripting-api, file-info-dialog (History Log) |
| E66 | Document states | `lib/doc-state.js` (T4.3) | history-panel-depth, file-handling-autosave | tile-store, layer-comps |
| E67 | History write barrier | `history.willWrite` (T4.6) | history-panel-depth | deep-pipeline, tile-store |
| E68 | Smart filter entry fields and filter mask | `lib/smart-object.js` (T5.1–T5.3) | smart-filters-depth | transform-warp-depth, liquify-depth, linked-smart-objects |
| E69 | Filter resources at render time | `registerFilterResource` (T5.4) | smart-filters-depth | liquify-depth (meshes) |
| E70 | Smart-object source kinds and place readers | `lib/source-kinds.js` (T6) | pdf-import | linked-smart-objects (linked files, SVG), layer-comps (a comp of the source) |
| E71 | `.pigment` entry providers | `lib/pigment-entries.js` (T5.5) | smart-filters-depth, metadata-io, file-handling-autosave | notes-count-measurement, frame-animation |
| E72 | Working spaces, conversion options and colour policies | `lib/color/pipeline.js` (T7.1, T7.3) | color-settings | print, edit-clipboard-finish, cmyk-lab-storage |
| E73 | Device conversions | `toCmyk`, `fromCmyk`, `toGray`, `convertPixels` (T7.2) | color-settings, soft-proofing | cmyk-lab-storage, print |
| E74 | Proof conditions, transforms and gamut tests | `proofTransformFor`, `currentProof`, `outOfGamut` (T8) | soft-proofing, save-options-common-formats, select-menu-finish | print (hard proofing), info-histogram-properties |
| E75 | Info panel readouts | `lib/info-readouts.js` (T7.5) | color-settings, soft-proofing | info-histogram-properties |
| E76 | Metadata store and chunk kinds | `lib/metadata-store.js`, io-chunks (T9) | metadata-io, export-as, raw-open-workflow, pdf-import | file-info-dialog, pdf-export, home-new-doc-browser, lens-correction-profiles |
| E77 | PSD byte stages, raw resources, byte helpers | `lib/psd/registry.js`, `lib/psd/bytes.js` (T10) | psd-document, save-options-common-formats | layer-comps, artboards-frames, slices-web-export, cmyk-formats-separations |
| E78 | Save As options (`'*'`), format option dialogs, the save option keys | `documents.js registerSaveOptions` (T11.2) | save-options-common-formats, psd-document | formats-more-codecs, save-for-web |
| E79 | Export assets and export preferences | `lib/export/assets.js exportAssets` (T11.4) | export-as | save-for-web, artboards-frames, slices-web-export, layer-comps |
| E80 | Open: forced reader, `interactive`, `null` results, open groups | `io.js openDocument`, `documents.js registerOpenGroup` (T12.1) | file-handling-autosave, raw-open-workflow, pdf-import | formats-more-codecs, home-new-doc-browser |
| E81 | Content replacement and the start-up event | `app.docs.replaceContent`, `'app:started'` (T12.3–T12.4) | file-handling-autosave | print, document-windows |
| E82 | Bridge: share, recovery folder, file changes | `bridge.js`, `preload.cjs`, `ipc.js` (T12.5) | file-handling-autosave | print, home-new-doc-browser |
| E83 | OpenType catalogue and glyph insertion | `src/shared/opentype-features.js`, `insertGlyph` (T13) | type-opentype-glyphs | type-styles-prefs, type-international |
| E84 | Develop input space and the RAW session | `developPlanes`, `ctx.input`, `openRawSession` (T14) | raw-open-workflow | camera-raw-local, lens-correction-profiles |
| E85 | View motion, zoom range, scrolling, auto-scroll | `lib/view-motion.js`, `view.scrollBy`, `autoScrolls` (T16) | view-navigation | document-windows (Match Zoom, second views) |
| E86 | Tool letters in shared slots | `shortcuts.js`, `tool.key` (T16.5) | view-navigation | workspaces-toolbar |

0.4 and 0.5 extension points 0.6 relies on: E5 (preset store), E6 (document store), E7 (widgets), E14 (canvas
capture), E18 (Properties sections), E20 (Preferences sections), E23 (vendor steps), E25 (drop handlers), E26 (type
panel sections), E28 (merged sampling), E29 (tool traits), E39 (options-bar slots), E40 (PSD registries), E42
(chunks), E43 (colour pipeline), E45 (save options), E47 (develop registry and workspace slots), E54 (open hooks), E55
(smart filter kinds).

### Shared integration points

Each point gives the API, the stub skeleton-06 ships so that every package can be built and tested before the others
land, and who completes it.

#### T1. The selection and the selection tools

**T1.1 Model.** The selection stays 0.2's: `doc.selection: Selection | null`, a document-size `Uint8ClampedArray`
coverage mask (255 = selected) with a cached outline; every change goes through `app.applySelection(next, mode, label)`
(one history entry; `mode` `'replace' | 'add' | 'subtract' | 'intersect'`; it keeps `savedSelection` for Reselect).
The skeleton adds to `lib/selection.js`: `offset(dx, dy): Selection` (whole pixels; what moves past the canvas is
dropped, a known difference: Photoshop keeps outlines beyond the canvas) and `static equals(a, b)`.

**T1.2 Outline moves versus pixel moves (E56).** With a selection tool active (`selects(tool)`, `tool-traits.js`:
the marquees, lassos, Quick Selection, Magic Wand, Object Selection, Selection Brush), no Shift or Alt at the press and
a press inside the selection (coverage ≥ 128 there), a drag of more than 2 screen px moves the *outline*: the tool draws
`selection.offset(dx, dy).path2d()` dashed while dragging (Shift constrains to 45°) and on release runs
`select:offset { dx, dy }`. A press inside without a drag behaves as in 0.5 (a click deselects with the marquee). The
arrow keys with a selection tool and a selection run `select:offset` by 1 px (Shift: 10 px), one entry per press,
through the tool's `onKeyDown`. Pixels move only with the Move tool (or Ctrl held, the temporary Move tool): 0.5's
move-tool-depth behaviour, unchanged. `select:offset` (skeleton, working): `{ dx, dy }` → `app.applySelection(
doc.selection.offset(dx, dy), 'replace', 'Move Selection')`; recorded; enabled with a selection; refused (disabled)
while Quick Mask is on.

**T1.3 Tool options (selection-tools-depth).** Option keys live in `settings.tools[toolId]`; 0.5's keys keep their
meaning so tool presets and specs hold.

| Tool (id; slot) | Options |
|---|---|
| `marquee-rect`, `marquee-ellipse` (marquee) | `combine`; `feather` px 0..1000; `antialias` (ellipse); `style` `'normal' \| 'ratio' \| 'size'` (0.5 values); `fixedW`, `fixedH` (0.5 keys; ratio numbers or sizes); `fixedUnit` `'px' \| 'in' \| 'cm' \| 'mm'` (Fixed Size) |
| `marquee-row`, `marquee-column` (marquee) | `combine`; `feather` |
| `lasso-free`, `lasso-polygon` (lasso) | `combine`; `feather`; `antialias` |
| `lasso-magnetic` (lasso) | the above; `width` 1..256 px (10); `contrast` 1..100 % (10); `frequency` 0..100 (57); `penPressure` boolean (false: pen pressure narrows the width) |
| `quick-select` (wand) | `combine` `'replace' \| 'add' \| 'subtract'`; `size` 1..5000 px (30, 0.5 key); `hardness`, `spacing`; `sampleMerged`; `enhanceEdge` |
| `wand` (wand) | `combine`; `sample` `'point' \| '3' \| '5' \| '11' \| '31' \| '51' \| '101'` ('point'); `tolerance` 0..255 (32); `antialias`; `contiguous`; `sampleMerged` |
| `object-select` (wand) | 0.3's options, unchanged |
| `selection-brush` (wand; new) | `mode` `'add' \| 'subtract'`; `size`, `hardness`; `overlay` boolean, `overlayColor`, `overlayOpacity` |

The Magic Wand's sample size: the skeleton adds `sample` (1, 3, 5, 11, 31, 51, 101) to `selection-ops.js floodFill`:
the seed colour is the mean of that square clipped to the image (marked; select-menu-finish owns the file). **Options-bar
buttons (E57):** selection-tools-depth registers an E39 slot (`place: 'end'`) that renders "Select Subject" (wand,
quick-select, object-select) running `select:subject`, and "Select and Mask…" (every selection tool) running
`select:select-mask`; until it lands the bar is 0.5's. **Live-wire (E58)**, `src/shared/pixels/livewire.js` (pure; the
API is fixed here because pen-paths reuses it):

```ts
edgeCost(img: ImageDataLike, { scale = 1, rect = null } = {}): { width, height, scale, cost: Float32Array }   // 0 strong edge .. 1 flat
createLiveWire(cost, { width = 10, contrast = 0.1 } = {}): {
  seed(x, y): void;                       // fixes a point (document px)
  path(x, y): [number, number][];         // minimal-cost path from the last seed, document px; within `width` of the pointer's trail
  snap(x, y): { x, y };                   // the strongest edge within `width`
  reset(): void;
}
```
Stub: `path` is the straight segment and `snap` 0.5's gradient-maximum snapping, moved verbatim out of `select.js`.
`src/shared/pixels/quick-select.js`: `quickSelect(img, mask, dabs: { x, y, r }[], { subtract, enhanceEdge, tolerance })
→ { mask, rect }` (stub: 0.5's windowed flood fill, moved).

**T1.4 Space during a gesture (E61).** `shortcuts.js` (skeleton): on a Space press outside text fields and dialogs,
before panning, it calls `app.tools.active?.takeSpace?.(true, event)`; `true` means Space belongs to the tool: no pan,
and the release calls `takeSpace(false, event)`. A tool answers true only while its own drag is in progress. The
marquee (selection-tools-depth) moves the whole rectangle while Space is held and resumes sizing on release. Every 0.5
tool has no `takeSpace`: Space pans as before.

**T1.5 How the Select menu makes selections.** Every command ends in one `app.applySelection` with Photoshop's label
and calls `ctx.setReplayArg` with an argument that replays without a dialog; 0.5's arguments keep replaying.

| Command (owner) | Replay argument (0.6) |
|---|---|
| `select:color-range` (select-menu-finish) | `{ select: kind id, samples?: [{ x, y, color: [r,g,b] }], fuzziness 0..200, localized?: boolean, range?: 0..100, invert?, inSelection?: boolean, preview? }`; 0.5's `{ select, color, fuzziness, invert }` replays (one sample) |
| `select:modify`, `-feather`, `-expand`, `-contract`, `-border`, `-smooth` (select-menu-finish) | 0.5's `{ kind?, amount }` plus `canvasBounds?: boolean` (Apply effect at canvas bounds) |
| `select:focus-area` (select-menu-finish) | 0.3's plus `strokes?: { add: [x, y, r][], subtract: [x, y, r][] }` in document px |
| `select:quick-mask`, `select:quick-mask-options` (select-menu-finish) | none; `{ indicates: 'masked' \| 'selected', color, opacity }` |
| `select:select-mask` (selection-tools-depth's workspace) | 0.3's `{ interactive?, mask?, output?, …refine }` plus `preset?: id` |
| `select:subject`, `select:sky` (select-menu-finish) | 0.3's |
| `select:save`, `select:load` (channels-depth) | T3.4 |

**Color Range kinds (E60)**, `lib/color-range.js`: `registerColorRangeKind({ id, label, group: 'colors' | 'tones' |
'special', order, fields?, mask(img, params, ctx): Uint8ClampedArray })` (select-menu-finish's built-ins: sampled,
the six hue ranges, highlights / midtones / shadows, `out-of-gamut` through `outOfGamut` (T8.4)); `.axt` settings
files load and save in the dialog. local-models-segmentation adds Skin Tones and Detect Faces here.

**T1.6 Segmenters (E59)**, `lib/segmenters.js` (skeleton):

```ts
registerSegmenter({ id, label, kinds: ('subject' | 'sky' | 'object' | 'focus' | 'people' | 'hair')[], priority: number,
  available(): boolean, run(img: ImageDataLike, kind, opts: { rect?, polygon?, sampleAll?, signal? }): Promise<{ mask: Uint8ClampedArray }> })
segment(app, kind, img, opts): Promise<{ mask, by: string /* segmenter id */, label }>   // highest priority available
segmenters(kind?): def[]
```
The built-in `heuristic` (priority 0) runs 0.3's `segment.js` (`selectSubject`, `selectSky`, `objectSelect`,
`focusArea`) in the select-mask worker as 0.3 does. The skeleton converts `select-mask.js` (Subject, Sky, Focus Area),
`object-select.js` and `select-mask/engine.js` (the workspace's Object Selection) to `segment()` (marked
`// segment (lib/segmenters.js)`); results are pixel-equal to 0.5's. local-models-segmentation (0.9) registers models
with priority 10; the label then says which model made the mask.

**T1.7 Code that leaves `edit-ops.js`** (skeleton, verbatim, working): `colorRange`, `rangeMask` and
`select:color-range` to `lib/color-range.js`; `modify` and the six Modify commands to `lib/select-modify.js`; quick mask
(state, overlay, `select:quick-mask`, the Q key listener) to `lib/quick-mask.js`. `select:grow`, `select:similar`,
`select:from-layer`, `select:inverse` and the rest stay in `edit-ops.js`.

**T1.8 Select and Mask presets** (selection-tools-depth): preset kind `select-mask-presets` (`data`: `normaliseRefine`'s
fields plus `view: { mode, opacity }`), registered empty by `registerPresetKinds06()`. Remember Settings:
`settings.selectionTools.selectMask.remember` (true: the next session starts from the last OK'd settings, 0.3's
behaviour; false: from the chosen preset or the defaults). Preview quality: below High Quality Preview the workspace
refines a copy of at most 1 MP while a control moves and the full image once it stops; Real-time Refinement off
refines on release only. The DOM `select-mask.spec.mjs` drives stays (the view-mode keys `k`, `y`, `m`, `o`, the tool
keys `w`, `l`).

**T1.9 Paths.** Undo: one entry per outline drag, nudge, Color Range, Modify, Quick Mask exit; `.pigment` keeps the
selection (0.2) and Select and Mask presets live in the store; PSD has no active selection (saved channels: T10);
actions record the commands with their arguments (tool drags are not recorded, 0.3); 16/32-bit and modes: selection
tools sample the 8-bit proxy composite through `sampleMerged`; Electron: nothing specific.

#### T2. Edit targets: what pixel edits write into (E62)

**T2.1 API** (`lib/edit-target.js`, skeleton; Node-safe apart from canvases):

```ts
interface EditTarget {
  kind: 'layer' | 'mask' | 'channel' | 'alpha' | string;
  label: string;                      // "Layer 1", "Layer 1 Mask", "Red", "Red, Green", "Alpha 1"
  layer: Layer | ChannelSurface;      // what History entries name; touch() after every write
  canvas: HTMLCanvasElement; x: number; y: number;   // where the edit draws, at that document offset
  mask: boolean;                      // a mask-format canvas (alpha = value, RGB white): brush mode 'mask'
  grey: boolean;                      // colours count by their luminance (one channel, masks, alpha channels)
  channels: { r: boolean, g: boolean, b: boolean } | null;   // colour-channel restriction on a layer canvas
  refuses?(op: 'paint' | 'fill' | 'filter' | 'adjust' | 'paste' | 'stroke' | 'transform'): string | null;   // a refusal toast
  paste?(app, image: { canvas, x, y }, opts: { into: boolean, inPlace: boolean }): boolean;
}
editTarget(app, { for: op = 'paint', quiet = false, layer = app.doc?.active } = {}): EditTarget | null
registerEditTargetKind(kind, { order, resolve(app, doc, layer, opts): EditTarget | null })   // first answer by order wins
restrictToTarget(target, after: ImageDataLike, before: ImageDataLike): void   // keeps the untargeted colour channels and alpha
                                                                              // of `before` (0.4's blend-if.js restrictChannels)
app.setEditTarget(t: null | { kind: 'channel', channels: string[] } | { kind: 'alpha', id } | { kind: 'mask' } | { kind: 'layer' })
app.ui.target                         // the current choice; { kind: 'mask' } keeps 0.4's app.ui.editingMask in step; emits 'target:changed'
```
Built-in kinds (skeleton): `mask` (order 100: 0.4's mask when `app.ui.editingMask` and the layer has one) and `layer`
(order 900: a raster layer, with 0.5's rasterize prompt and lock refusals). With these two `editTarget` answers exactly
0.5's `pixelTarget`, so every 0.5 test holds. channels-depth registers `alpha` (order 150: an alpha or spot channel,
through a ChannelSurface) and `channel` (order 200: one or more colour channels of a raster layer). `app.pixelTarget(opts)`
stays as an alias of `editTarget(app, opts)`.

**T2.2 Choosing it.** Clicks in the Channels panel, `channel:target` (T17: Ctrl+2 composite, Ctrl+3/4/5 red, green,
blue, Ctrl+6…9 the first four alpha channels, Ctrl+\\ the layer mask), Shift-click adding colour channels, the Layers
panel's layer and mask thumbnails (0.4). Choosing the composite or the layer clears `app.ui.target`; activating another
layer keeps a colour-channel choice and drops an alpha one, as Photoshop does. The status bar's `target` segment shows
`label`.

**T2.3 Call sites** (skeleton converts, marked `// target (T2)`): `StrokeTool.strokeTarget` and `baseSettings`
(`mode: target.mask ? 'mask' : 'paint'`, `maskValue` and `constrainColor` from luminance when `target.grey`, and
`settings.restrict = target.channels`), the stub engine's composite (`lib/brush/engine.js` restores the untargeted
channels of each flushed rect from its pre-stroke copy when `restrict` is set), the DabTool loop and stamps
(`retouch.js`), the Gradient and Paint Bucket (`fill.js`, `bucket.js`), `edit:fill` and `edit:stroke`, Stroke and Fill
Path (`vector.js`), `beginPixelEdit` (`adjust-ui.js`: the session's base and commit go through the target; commit calls
`restrictToTarget` before its `history.pixels` entry), Filter dialogs and direct filter runs (`filter-ui.js`), and
paste (T2.4). A target whose `refuses(op)` answers shows that text and the operation does nothing. Free Transform keeps
0.5's choice (layer or mask).

**T2.4 Paste into a target.** `paste()` (edit-ops, skeleton) first asks `editTarget(app, { for: 'paste', quiet: true })`;
a target other than `layer` whose `paste` returns true has pasted (one entry "Paste"). The built-in `mask` kind pastes
the image's luminance into the mask (centred, in place for Paste in Place, clipped to the selection for Paste Into).
channels-depth's `alpha` and `channel` kinds do the same for their surfaces.

**T2.5 Channel surfaces** (channels-depth): an alpha or spot channel is edited through a surface `{ canvas /* document
size, mask format */, touch() /* writes the canvas alpha into ch.mask in place */, version }`, made from `ch.mask` on
first use and cached per mask array. History entries name the surface, so undo and redo write the array back through
`touch()`; a structural copy `{ ...ch, name }` shares the array, so it stays right. Nothing writes `ch.mask` in place
except a surface's `touch()` or a History entry.

**T2.6 Depths and modes.** 16/32-bit: edits go to the 8-bit proxy and `depth.js` refreshes `deep` in the rect (0.3); in
a colour-channel edit the untargeted channels lose their extra precision there (known gap, deep-pipeline 0.9). Masks and
alpha channels stay 8-bit. Grayscale, Duotone, Indexed, Bitmap: the one channel is the composite, so the `channel` kind
never applies. CMYK, Lab, Multichannel (channel views over RGBA): a derived colour channel can be viewed and loaded as a
selection, but `refuses('paint' | 'fill' | 'filter' | 'adjust' | 'paste')` with "Editing one CMYK or Lab channel needs
real CMYK and Lab storage" until cmyk-lab-storage (0.10) registers plane targets; alpha and spot channels are editable
in every mode.

#### T3. Channels: views, spot channels, Split and Merge

**T3.1 The channel object** (`doc.channels[i]`; normalised by the skeleton in `document.js` and `readPigment`):

```ts
interface AlphaChannel {
  id: string; name: string;
  mask: Uint8ClampedArray;            // width * height, 255 = white = selected (0.3)
  kind?: 'alpha' | 'spot';            // absent: 'spot' when `spot` is set, else 'alpha'
  spot?: { key?: string /* 0.3 Multichannel plate */, color: [r, g, b], solidity: number /* 0..1, default 0 */ } | null;
  options?: { indicates: 'masked' | 'selected', color: '#rrggbb', opacity: number }   // defaults 'masked', '#ff0000', 0.5
}
```
`describe().channels` becomes `{ id, name, kind?, spot?, options? }` (a 0.5 reader keeps id and name; 0.3's Multichannel
spots in `meta.imageMode` keep setting `spot`). Eyes are view state: `view.channelView` (T3.2), not saved.

**T3.2 Views (E64)** — display stages (S6.4), registered by channels-depth:

```ts
view.channelView: null | { colour: ('r' | 'g' | 'b' | string)[] /* visible colour channels; null view = composite */,
                           alpha: string[] /* visible alpha and spot ids */, inColor: boolean /* settings.channels.showInColor */ }
```
`channel-view` (order 40): one visible colour channel drawn grey (or tinted with `inColor`), several in their colours;
CMYK and Lab documents show their derived planes (`channelPlanes`). `alpha-overlay` (50): visible alpha channels over
the image in their `options` colour and opacity (an alpha channel shown alone is grey). `spot-inks` (60): spot channels
as inks over the composite, `solidity` 0 multiplying and 1 covering. Proof is 100, gamut 110, icc-engine 900. The 0.3
Multichannel mode renderer stays a compositor mode renderer. The Navigator and thumbnails show the composite.

**T3.3 Row providers (E63)**, `lib/channel-rows.js` (skeleton):

```ts
registerChannelRows({ id, order, rows(doc, app): ChannelRow[] })
interface ChannelRow { id: string; label: string; thumb(doc, w, h): HTMLCanvasElement; selected?: boolean;
  eye?: boolean | null; italic?: boolean; onClick?(e): void; onDblClick?(e): void; menu?(): PopoverItem[] }
channelRows(doc, app): ChannelRow[]
```
The skeleton's edit of 0.5's panel renders these rows after the saved channels; channels-depth's panel keeps doing so.
select-menu-finish registers `quick-mask` (order 100): an italic "Quick Mask" row while Quick Mask is on, whose
double-click opens Quick Mask Options.

**T3.4 Spot channels and the channel commands** (channels-depth; ids in T17): New Channel and New Spot Channel (name,
ink colour through `app.colorPicker.pick({ allowBooks: true })`, solidity), Channel Options (alpha: name, Color
Indicates, colour, opacity; spot: name, ink, solidity), Duplicate Channel (as, destination document or New, invert),
Delete, Merge Spot Channel (flattens and bakes the ink: one structural entry), Split Channels (one Grayscale document
per channel named "<name>_Red" …, alpha and spot channels included; the source closes after a confirmation when it
has unsaved changes), Merge Channels (mode RGB, CMYK, Lab or Multichannel, the source documents chosen per channel; a
new document; the sources close), drag to reorder (alpha and spot channels only), Panel Options (thumbnail size).
`select:save` grows `{ name, document?: docId | 'new', channel?: id | 'new', operation?: 'replace' | 'add' | 'subtract'
| 'intersect', invert? }` and `select:load` `{ document?, channel: name, invert, mode }` (0.5's arguments replay).

**T3.5 Moved code** (skeleton): `select:save` and `select:load` from `edit-ops.js` to `lib/channel-dialogs.js`,
verbatim and working.

**T3.6 DOM the specs rely on** (channels-depth keeps it): `.channels-panel`, `.channel-list .channel-row`, `.layer-name`
inside a row, `data-channel` = the 0.3 type for mode rows (`rgb`, `r`, `g`, `b`, `c`, `m`, `y`, `k`, `L`, `a`, `b`)
and the id for saved channels, `.channel-ink` on spot rows, the footer `[data-act="load" | "save" | "new" | "delete"]`,
Ctrl-click loading a row as a selection, a click selecting a saved channel for Delete (`modes.spec.mjs:546–606, 818`).

**T3.7 Paths, and what cmyk-lab-storage needs.** Every command is one entry; `.pigment` carries the T3.1 fields; PSD is
psd-document's (T10.3); TIFF alpha channels are save-options-common-formats' (T11.3); actions record channel commands
by channel name; alpha channels stay 8-bit at every depth (Photoshop keeps the document depth: a known difference);
Split and Merge work in every mode except Indexed and Bitmap (refused, as Photoshop); Merge to CMYK or Lab builds RGBA
through `fromCmyk` / `fromLab` (T7.2). cmyk-lab-storage (0.10) registers plane targets (T2), real-plate rows (T3.3)
and a plane view stage, and keeps the T3.1 model; spot channels become real plates there.

#### T4. History: the tree, snapshots, the source, the write barrier

**T4.1 Entries** keep 0.2's shape (`{ label, undo(), redo(), bytes, at, mergeKey?, made? }`) and every recording API
stays: `run`, `push`, `pixels`, `beginStroke`/`endStroke`, `replaceCanvas`, `group`, `merge`, `mark`/`rollback`,
`structural`, `setLayerProps`. New optional field `visibility: true`, set by the skeleton in `layer-ops.js
setLayerProps` when the patch is `{ visible }` alone.

**T4.2 Non-linear history** (history-panel-depth). `history.entries` and `history.index` keep their meaning: the
entries of the *current path* and the position on it (every 0.5 reader — `syncUiState`'s labels, Toggle Last State,
the actions engine, the specs — reads them unchanged). With `settings.history.nonLinear`, a new entry made while
`index < entries.length - 1` keeps the redo entries as a branch instead of dropping them. Added:

```ts
history.states(): { id: string, label: string, parent: string | null, current: boolean, onPath: boolean, at: number }[]   // creation order
history.jump(id): void            // undo to the common ancestor, redo down to `id`; one 'history:changed'
history.currentId(): string | null; history.savedId(): string | null    // dirty = currentId() !== savedId()
history.deleteState(id): void     // linear: that state and the later ones; non-linear: its subtree
history.clearStates(): void       // Clear History: entries go, snapshots stay
```
This needs no stored document states: undo and redo are exact inverses and the tree only ever applies them along a
path, so a branch's entries run on the state they were recorded from. Trimming (`historyLimit`, `historyMemoryMB`)
drops the oldest entry by creation; when it has several children, the branches that do not hold the current state go
with it. `merge` and `setLayerProps`' `mergeKey` merge only into a current entry without children. `rollback` removes
everything made since its `mark`. Stub (0.5): linear.

**T4.3 Document states (E66)**, `lib/doc-state.js` (skeleton):

```ts
captureDocState(doc, { from = 'document' | 'merged' | 'layer', layer = null } = {}): DocState
   // 'document': every layer (canvases, masks, deep planes, filter masks copied; props through describe-like clones),
   //   the tree, size, mode, depth, colour table, duotone, profile, channels (masks copied), paths, store, selection,
   //   meta, metadata; 'merged': one raster layer of the flattened image (flattenDeep at 16/32 bits); 'layer': that layer
docStateBytes(state): number
applyDocState(app, doc, state, label): HistoryEntry   // one entry; restores fresh copies, so later edits never touch `state`
docStateToDocument(state, { name }): Document         // New Document from Snapshot / from a state
```
Copies are made at capture; a capture that would exceed `historyMemoryMB` throws `RangeError` with the size needed.

**T4.4 The history source (E65).**

```ts
history.source(): { kind: 'saved' | 'snapshot' | 'state', id: string | null, label: string }
history.setSource(kind, id): void
history.sourcePixels(layer = null): { canvas, x, y } | null
   // the source's pixels for `layer` (that layer, by id, in the source), or the merged image for a merged source;
   // null when the source holds no such layer or has another canvas size (the tool says so, as 0.5 does)
```
Stub (skeleton): `{ kind: 'saved' }`, `setSource` does nothing, `sourcePixels` returns 0.4's `savedSnapshot()` as
`{ canvas, x: 0, y: 0 }` for any layer, so the History Brush (`retouch.js`), the Eraser's Erase to History (`paint.js`)
and Fill › History (`edit-ops.js`), converted by the skeleton to `sourcePixels`, behave as in 0.5. history-panel-depth:
the default source is the first snapshot when one exists; clicking a state's left column makes it the source, which is
captured then (a quiet `jump` there and back inside `history.hold`, `captureDocState`, counted in the memory budget,
dropped when the source changes). retouch-tools-depth (0.7) reads the same API for the Art History Brush.

**T4.5 Snapshots** (history-panel-depth). `history.snapshots: { id, name, from, state: DocState | null, canvas, at }[]`
— 0.4's `{ name, canvas, at }` keep `canvas` (the merged image, the thumbnail and New Document from Snapshot).
New Snapshot (name, From: Full Document / Merged Layers / Current Layer; the dialog when Show New Snapshot Dialog is on
or with Alt), rename, delete, the first snapshot on open and new (`'doc:opened'` and New), Automatically Create New
Snapshot When Saving (`'doc:saved'`), New Document from a state or snapshot. Clicking a snapshot applies it as **one
history entry named after it** (`applyDocState`): Photoshop selects the snapshot row instead; a recorded difference
that keeps the tree sound. A snapshot that does not fit the budget offers Merged Layers.

**T4.6 Write barrier (E67).** `history.willWrite(target, rect = null, { copy } = {})`, where `target` is a layer or
mask canvas, a `deep` planes object or an alpha channel's mask: called before an in-place write by `beginStroke` (with
the full copy it makes anyway as `copy`), by `pixels` (before `mutate`), by `depth.js` before it rewrites `deep`, and by
channel surfaces' `touch()`. Stub: nothing. history-panel-depth may use it to make snapshots copy on write; rule 18
makes every other writer call it.

**T4.7 History Options** (`settings.history`, history-panel-depth): `{ autoFirstSnapshot: true, snapshotOnSave: false,
newSnapshotDialog: false, visibilityUndoable: true, nonLinear: false }` — Photoshop's defaults except
`visibilityUndoable`, which keeps 0.5's recorded eye toggles (an entry marked `visibility` is applied without being
recorded when it is off).

**T4.8 DOM the specs rely on** (kept): `.history-panel`, `.history-snapshots`, `.history-states .history-item` with the
state's label as text, `.history-item.current`, `.future`, the footer's `[data-act="new-doc" | "snapshot" | "delete"]`.

**T4.9 Paths.** Every 0.5 command records as before (T4.1); New Snapshot records (`history:new-snapshot { name, from }`),
the other `history:*` commands are `record: false`; snapshots live in memory only (Photoshop does not save them either);
16/32-bit: Full Document captures `deep`, Merged Layers captures `flattenDeep`; Electron: nothing specific.

#### T5. Smart filters

**T5.1 The entry (E68).** `layer.filters[i] = { kind, params, enabled, blend?: { mode: BlendMode, opacity: 0..1 },
resources?: { [name]: { blob: string, width, height, channels: 1 | 4, type: 'u8' | 'f32' } } }` (defaults: Normal,
1, none) and per smart layer `layer.filterMask: { canvas /* document size, mask format */, enabled, linked, density,
feather } | null` — Photoshop's one filter mask per smart object. The skeleton makes `normaliseFilter`, the
`SmartLayer` constructor, `describe` (`hasFilterMask`, `filterMaskEnabled`, `filterMaskLinked`) and `cloneLayer` keep
these; 0.5 files have none. The order stays 0.2's: `filters[0]` runs first (the bottom row).

**T5.2 Render chain** (smart-filters-depth): for each enabled filter, `next = filter(img)` then `img =
blend(img, next, blend.mode, blend.opacity)`; after the chain the filter mask mixes the unfiltered render and the
filtered one (density and feather as a layer mask's). A selection active when the first filter is added becomes the
filter mask (white otherwise). The filter mask is an edit target (`filter-mask`, order 120, registered by
smart-filters-depth, T2), so every brush paints it.

**T5.3 Panel and commands.** `lib/panels/layers-filters.js` (moved by the skeleton) is smart-filters-depth's: mask
thumbnail, blending icon (double-click: Blending Options of that filter), drag and Alt-drag through E25 with MIME
`application/x-pigment-smart-filter` (`{ layerId, index | 'all' }`) onto layer rows: `layer:smart-filter { id, index,
op: 'move' | 'copy', to, at? }`, one structural entry; dropping on a layer that is not a smart object converts it first
(Photoshop's prompt). `layer:smart-filter` keeps 0.5's ops (`toggle`, `delete`, `edit`, `up`, `down`) and gains
`'blend'` (`{ blend }` or a dialog), `'move'`, `'copy'`; `layer:smart-filter-mask` is new (T17). Re-editing opens the
kind's dialog or E55 session with the saved params and resources.

**T5.4 Resources at render time (E69).** `registerFilterResource(kind, { names, capture(params, { app, doc, layer }) →
Promise<{ [name]: { width, height, channels, data } }>, inject(params, resources) → params })` (registry in
`lib/smart-filter-resources.js`; the skeleton's `applySmartFilter` calls `injectResources(f)` before the kind runs, a
pass-through in the stub). smart-filters-depth registers Lens Blur (the depth map from a channel, mask or
transparency), Displace (the map file), Texturizer, Conté Crayon, Glass, Rough Pastels and Underpainting (their texture
files), which closes 0.3's known gaps on smart objects. Resource data lives in the layer's blob store
(`app.smartFilters.blobs`, in memory) and in `.pigment` through T5.5.

**T5.5 `.pigment` entry providers (E71)**, `lib/pigment-entries.js` (skeleton, Node-safe):

```ts
registerPigmentEntries({ id, order,
  write(doc, ctx: { layers: Layer[] }): Promise<{ name: string, data: Uint8Array, compress?: boolean }[]>,   // names under `${id}/`
  read(doc, ctx: { find(name): { data } | null, list(prefix): string[], description: object }): Promise<void> })
```
`writePigment` calls the providers after its own entries, `readPigment` after the tree is built; a provider's failure on
read is an open notice, not a failed open. Users: `smartfilters/` (masks and resources; smart-filters-depth),
`metadata/` (T9.5), `versions/` (T12.2).

**T5.6 PSD** (smart-filters-depth, `lib/psd/smart-filters.js`): aspect `smart-filters` (order 600, S4.3) maps the kinds
that have a Photoshop descriptor both ways (`filterToPsd(f) → descriptor | null`, `filterFromPsd(desc) → entry | null`,
exported for linked-smart-objects) and acts only on layers a kind read or wrote as a smart object (`claimed(layer,
'smart-object')`). No kind does in 0.6, so smart objects still save as pixels and a save notice
`'smart-filters-pixels'` says "N smart objects with smart filters were saved as pixels; their filters stay editable in
.pigment files". linked-smart-objects (0.7) registers kind 500 and the filters then round-trip.

**T5.7 What 0.7 uses.** transform-warp-depth keeps a live warp on the layer (`layer.liveTransform`, reserved: the
skeleton's `describe` and constructor carry it as data) rendered before the filters; liquify-depth registers its kind
through E55 with its mesh as a resource (E69); linked-smart-objects adds source kinds (T6) and PSD kind 500.

**T5.8 Paths.** Undo: every op one entry, mask strokes through History; `.pigment`: T5.1 fields plus T5.5 entries;
PSD: T5.6; actions: `layer:smart-filter` and `layer:smart-filter-mask` record with layer names and indices; 16/32-bit:
smart objects render at 8 bits (0.3); modes: the mode renderer runs after the render; Electron: nothing specific.

#### T6. Smart-object source kinds and place readers (E70)

`lib/source-kinds.js` (skeleton; the registry and 0.2's two kinds `image` and `document`, moved out of
`smart-object.js`):

```ts
registerSourceKind(kind, {
  width(src): number; height(src): number;          // base-space size in px
  version(src): string;                             // part of SmartLayer.render's cache key
  canvas?(src): HTMLCanvasElement;                  // raster kinds: base-space pixels
  draw?(ctx, src, { matrix, rect }): void;          // vector kinds: draw at the size `matrix` gives (ctx already offset to rect)
  copy(src): src;                                   // New Smart Object via Copy, cloneDocument
  toFiles(src): Promise<{ name, data }[]>;          // .pigment, under smart/<layer id>/
  fromFiles(files, desc): Promise<src>;
  describe(src): object;                            // merged into describe().source
  editContents?(app, layer): Promise<void>;         // Edit Contents; absent: "Replace Contents to change this object"
})
registerPlaceReader({ id, extensions, test?(bytes, name),
  read(bytes, { name, path, interactive }): Promise<{ source } | { document } | null> })    // null: cancelled, no error
```
The skeleton converts `makeSource`, `copySource`, `resolveSource`, `SmartLayer.render` (`draw` when the kind has it,
else 0.2's `drawImage` of `canvas`), `writePigment` / `readPigment` (0.5's `smart/<id>.pigment` and `smart/<id>.png`
stay readable) and `file:place` (place readers first, then 0.2's decoding). pdf-import registers the kind `pdf` and
readers for `.pdf`, `.ai` (T15.3). linked-smart-objects (0.7) adds linked sources (`link: { path, mtime, missing }`) and
SVG.

#### T7. Colour settings and conversions

**T7.1 Working spaces (E72)**, `lib/color/pipeline.js` (skeleton):

```ts
setWorkingSpaces({ rgb, cmyk = null, gray = null, spot = { dotGain: 20 }, options })   // 0.5's { rgb } still accepted
workingSpaces(): { rgb: ColorProfile, cmyk: ColorProfile | null /* null: 0.3's naive model */, gray: ColorProfile | null
                   /* null: Gray Gamma 2.2 */, spot, options: ConversionOptions }
interface ConversionOptions { intent: 'perceptual' | 'relative' | 'saturation' | 'absolute' /* 'relative' */; bpc: boolean /* true */;
  dither: boolean /* true */; sceneReferred: boolean; desaturateMonitor: number | null; blendRgbGamma: number | null; blendTextGamma: number | null }
```
color-settings owns `settings.colorSettings` (`{ preset, rgb, cmyk, gray, spotDotGain, policies: { rgb, cmyk, gray:
'preserve' | 'convert' | 'off' }, ask: { openMismatch, pasteMismatch, missing }, options }`), the Color Settings dialog,
the presets (kind `color-settings`; `.csf` is not read, its format is undocumented) and calls `setWorkingSpaces` at
start and on change. Blend-with-gamma values are kept and shown; the compositor blends encoded numbers (Photoshop's
default) until deep-pipeline, and the dialog says so. Pigment ships no Adobe CMYK profile: working CMYK stays `null`
(the 0.3 model) until the user chooses a system or user profile, unless color-settings bundles a freely redistributable
one (open question).

**T7.2 Device conversions (E73)** — synchronous, in the pipeline (skeleton), answered by the engine when it has the
member (0.5 deviation 18's rule), else by the stub:

```ts
toCmyk(rgb, doc | null): [c, m, y, k]        // 0..100, through workingSpaces().cmyk; stub: color.js rgbToCmyk
fromCmyk(cmyk, doc | null): [r, g, b]       // stub: cmykToRgb
toGray(rgb, doc | null): number; fromGray(k, doc | null): [r, g, b]   // % ink; stub: luma
channelPlanesFor(img, doc): { id, data }[]  // CMYK / Lab / Gray planes of a channel-view document; stub: modes.js channelPlanes
convertPixels(img, from, to, opts?): ImageDataLike   // identity in the stub
setDocumentConverter(fn); convertDocument(app, doc, to, opts): Promise<HistoryEntry | null>   // stub: a toast, null
```
The skeleton converts the CMYK fields and sliders of `color-picker.js` and `color-views.js` and the Info readouts to
these calls (marked). color-settings adds the engine members (`toCmyk`, `fromCmyk`, `toGray`, `fromGray`,
`convertPixels`, transforms in `'rgba8' | 'rgba16' | 'rgbaf' | 'cmyk8'` formats) in `lib/color/cmm.js`.

**T7.3 Policies (E72).** Open: color-settings registers an open hook (order 300, before type-fonts' 500) for mismatch
(Preserve / Convert to working / Discard) and missing profiles (Leave / Assign working / Assign…), answering from the
policy without a dialog when `interactive` is false (a notice), and skipping `format` `'raw'` and `'pdf'` (their
dialogs assign the profile). Paste: `registerColorPolicy({ onPaste(app, doc, image: { canvas, profile }) →
Promise<canvas | null> })`; `edit-ops.js paste()` (skeleton) calls `colorPolicy().onPaste` with the profile of the copy
(an internal copy records its document's profile; a system clipboard image is sRGB); `null` cancels; the stub returns
the canvas (0.5: numbers copied). Place keeps 0.5's behaviour (smart object sources keep their numbers; known gap until
linked-smart-objects).

**T7.4 Convert to Profile and modes** (color-settings): `edit:convert-profile { profile, intent, bpc, dither, flatten,
mode? }` (the profile as id, plus base64 bytes when it is not built in, so a replay elsewhere works): one entry that
converts raster pixels and `deep` planes, masks untouched, and the colours of text, shape, fill and style parameters
(adjustment parameters stay); to a Gray profile the document becomes Grayscale, to a CMYK profile CMYK (channel views
over RGBA whose planes come from `channelPlanesFor`); Advanced: device link and abstract profiles. `image:mode` uses the
working profiles when they exist (`lib/modes.js`). Indexed documents convert the colour table; Bitmap refuses.

**T7.5 Info readouts (E75)**, `lib/info-readouts.js` (skeleton): `registerInfoReadout({ id, label, order, rows(sample: {
rgb, alpha, deep? }, doc, view) → [key, text][] })`, `infoReadouts()`; the Info panel's select lists them and
`settings.infoSecondary` keeps the id. Built-ins: 0.5's `cmyk` (through `toCmyk`, with "!" when `outOfGamut`), `lab`,
`hsb`. color-settings adds `gray` and `web`; soft-proofing adds `proof`.

**T7.6 Colour lookups** (color-settings): Color Lookup accepts abstract and device-link ICC profiles (sampled into a
self-contained table in the params, as 0.5's `profile` param); Export Color Lookup Tables writes `.cube`, `.3dl`,
`.csp` and an ICC device link (`lib/color/lut-icc.js`).

**T7.7 Paths.** Convert and Assign are one entry each; `.pigment` and PSD carry the profile (0.5); actions record the
conversion with its profile; 16/32-bit converts `deep` (`'rgba16'`, `'rgbaf'`); Electron lists system profiles (0.5's
`listColorProfiles`); the browser build has the generated profiles and user files only.

#### T8. Proofing (E74)

**T8.1 The condition** (soft-proofing, `lib/color/proof.js`):

```ts
interface ProofCondition {
  id: 'working-cmyk' | 'working-c' | 'working-m' | 'working-y' | 'working-k' | 'working-cmy' | 'legacy-mac-rgb'
      | 'srgb' | 'monitor-rgb' | 'protanopia' | 'deuteranopia' | 'custom' | string /* a saved setup's preset id */;
  device: string | null;            // profile id; null: working CMYK, or the 0.3 model without one
  preserveNumbers: boolean; intent: ConversionOptions['intent']; bpc: boolean;
  paperColor: boolean; blackInk: boolean; plates?: ('c' | 'm' | 'y' | 'k')[]; blindness?: 'protanopia' | 'deuteranopia' }
```
Pipeline functions (skeleton stubs in brackets): `currentProof(view)` [the working-CMYK condition], `setProof(view,
condition)` (soft-proofing, per view as Photoshop's per window; new views start from `settings.proof.last`),
`proofTransformFor(view)` [null], `proofConvertCanvas(canvas, doc, condition)` [0.3's `applyProof` CMYK round trip],
`outOfGamut(rgb, doc, { against: 'proof' | 'cmyk' })` [0.3's `isOutOfCmykGamut`], `setGamutTest(fn)`. Saved setups are
the preset kind `proof-setups` (`.psf` is not read).

**T8.2 Display.** soft-proofing replaces `color-modes.js`'s `postProcess` hook with two display stages: `proof` (order
100, while `view:proof` is on) and `gamut` (110, `view:gamut`, `settings.proof.gamut = { color, opacity }`, 0.3's grey
at 100 %). They follow S6.4's damage rules and key their kept copy on (view, profile id, condition id, display space).
`settings.proofColors` and `settings.gamutWarning` stay the toggles (0.3 keys; ui state unchanged). Without an engine,
or with no CMYK profile, the stages give 0.3's pixels, so the 0.3/0.4 proof specs hold.

**T8.3 Colour blindness**: `src/shared/pixels/color-blind.js simulate(img, 'protanopia' | 'deuteranopia', rect)`
(pure; Viénot–Brettel in linear light), used by the two conditions.

**T8.4 Users of the gamut test and the proof conversion:** Gamut Warning, the colour picker's alarm (skeleton call
site), Info's "!" (T7.5), Color Range's Out of Gamut (select-menu-finish), "Use Proof Setup" on save
(save-options-common-formats: `proofConvertCanvas` of the flattened image), print (0.8: `currentProof`,
`proofConvertCanvas`, the engine's proof transform with paper colour and black ink).

**T8.5 Paths.** View state only: no history entry; `view:proof-setup` is `record: false`; the condition persists in
settings and presets; 16/32-bit displays from the proxy; Electron: the Proof Setup radios come from ui state
`proofSetup` (T17.5).

#### T9. Metadata through open and save (E76)

**T9.1 Containers** (skeleton; `io-chunks` stays the one place that reads and writes the blocks, S5). Added:

- TIFF `exif`, read and write: on read, IFD0's descriptive tags (270, 271, 272, 274, 305, 306, 315, 33432) plus the
  EXIF (34665) and GPS (34853) sub-IFDs become a standalone TIFF-structured block, the form JPEG's APP1 holds; on
  write, those tags and sub-IFDs are replaced from the block (IFD0 rebuilt as S5 does, offsets rewritten).
- `Chunks.thumbnail?: { jpeg: Uint8Array, width, height } | null`: PSD resource 1036 only (JPEG's thumbnail is IFD1
  inside the EXIF block, metadata-io's).
- `readOrientation(chunks): 1..8` (IFD0 tag 274 of the EXIF block; 1 without one).

A kind no provider gives leaves the bytes as they are, so a document without metadata saves as in 0.5.

**T9.2 The store** (`lib/metadata-store.js`, metadata-io; the skeleton's stub has this API):

```ts
doc.metadata: DocMetadata | null      // document.js; null for New
interface DocMetadata {
  exif: Uint8Array | null;            // the TIFF-structured block as read (MakerNotes and unknown tags inside)
  xmp: string | null;                 // the packet as read
  iptc: Uint8Array | null;            // IIM records
  orientation: number;                // 1..8 as read
  orientationApplied: boolean;        // the decoder already turned the pixels upright
  source: { format: string, path: string | null } | null;
}
metadataOf(doc): DocMetadata          // an empty one when null
setMetadata(app, doc, patch, { label = null } = {})   // no label: not an edit (open, RAW, PDF import); a label: one entry
exifFields(doc): object               // camera data, 0.3's readExif shape (make, model, lens, exposureTime, fNumber, iso, …)
METADATA_FEATURES = { provider, exif, iptc, thumbnails }     // stub: all false
```
Stub: `openDocument` (skeleton) fills `doc.metadata` from the chunks it already reads; `exifFields` calls 0.3's
`readExif` on the block; no provider is registered, and `file-info.js` keeps 0.5's behaviour. File Info's fields stay
`doc.meta` (0.3); metadata-io merges them into XMP and IPTC when writing.

**T9.3 Orientation.** `decodeImage` (skeleton) asks `createImageBitmap` for `imageOrientation: 'from-image'` (Chromium's
default, now explicit) and `openDocument` sets `orientationApplied: true` on that path and `false` for registered
readers (TIFF and the others decode themselves). metadata-io's open hook (order 200) turns a document upright when
`orientation !== 1 && !orientationApplied` (part of the open state: no entry). Every write states orientation 1.

**T9.4 What is written** (metadata-io's chunk provider `'metadata'`, order 200, after icc-engine's `'icc'`):

| Kind | `purpose: 'save'` | `purpose: 'export'`, by `opts.metadata` | `'copy'` |
|---|---|---|---|
| EXIF | the block as read, orientation 1, pixel dimensions updated, the JPEG thumbnail rebuilt | `'all'`: as save; `'copyright'`, `'none'`: none | none |
| XMP | the packet as read with File Info merged, `xmp:ModifyDate`, `tiff:Orientation` 1 | `'all'`: as save; `'copyright'`: rights, creator and contact info only; `'none'`: none | none |
| IPTC | as read with File Info merged (JPEG, TIFF, PSD) | `'copyright'`: 2:116, 2:80 and contact; `'none'`: none | none |
| Resolution | `doc.dpi` in every format that holds it | the same | none |
| Thumbnail | PSD 1036; JPEG IFD1 with EXIF | none | none |

`opts.metadata` is `'all' | 'copyright' | 'none'`; save defaults to `'all'`, export to `settings.export.metadata`
(export-as; `'none'`, Photoshop's Export As default); Save for Web (0.9) passes its own. JPEG application segments
other than these (APP12, APP14) are not carried: the pixels are encoded again. The provider replaces `file-info.js`'s
`writeTo` wrap and `stampPsd` in the same landing, so XMP is never written twice.

**T9.5 `.pigment`**: metadata-io's entry provider (T5.5) writes `metadata/exif.bin`, `metadata/xmp.xml`,
`metadata/iptc.bin`, and `describe().metadata = { orientation, source }`; 0.5 files have none (0.3's `meta.exif`
summary stays where it is).

**T9.6 What later packages use.** metadata-io exports pure `src/shared/metadata/exif.js` (`parseExif(block) → { ifd0,
exif, gps, interop, ifd1, makerNote }`, `writeExif(parsed)`), `xmp.js` (`parseXmp(text)`, `serializeXmp(doc)`,
`setProperty`, `getProperty`), `iptc.js` (`parseIptc`, `writeIptc`) and from the store `xmpForExport(doc, opts)` (pdf-export,
0.7), `readMetadataQuick(bytes, format) → { fields, thumbnail }` without decoding pixels (home-new-doc-browser, 0.9),
`exifFields` (lens-correction-profiles, 0.9). file-info-dialog (0.8) edits XMP through `setMetadata` with a label and
writes the History Log from a `'history:changed'` listener.

**T9.7 Paths.** File Info edits stay one entry (0.3's `file:properties`); PSD carries 1028, 1036, 1058, 1060 through the
chunks; actions: none; 16/32-bit: nothing specific; Electron: nothing specific.

#### T10. PSD document resources (E77)

**T10.1 What psd-document maps.** Guides and grid (it re-registers the built-in resource `guides`, order 200, with the
grid settings of 1032), saved paths (2000–2997), the work path (1025), the clipping path (2999, with flatness), alpha
channel names and identifiers (1006, 1045, 1053), DisplayInfo (1077: spot ink, solidity, channel colour, opacity and
Color Indicates), the extra channels' image data, 16 and 32 bits per channel, Grayscale, Indexed and Bitmap documents,
PSB (`psb: true` for `.psb` and above 30 000 px; still bounded by the canvas limit until tile-store) and Photoshop
templates (`.psdt`: an open hook makes the document untitled; Save As offers "Photoshop Template").

**T10.2 Registry additions** (`lib/psd/registry.js`, skeleton):

```ts
registerPsdByteStage({ id, order,
  beforeRead?(bytes, ctx): { agOptions?: object, state?: any } | void,   // e.g. useImageData for a 16/32-bit file
  afterRead?(doc, psd, bytes, ctx, state): void,                          // alpha channels, deep planes, the mode
  afterWrite?(bytes, doc, ctx: { opts, report, compositor }): Uint8Array }) // rewrites header, channel data, sections
registerPsdRawResource({ ids: number[], order, read?(map: Map<number, Uint8Array>, doc, ctx): void,
  write?(doc, ctx): Map<number, Uint8Array> })
```
`read.js`: header → `beforeRead` stages → ag-psd with the merged options → kinds, aspects, resources (S4) → raw
resources → `afterRead` stages. `write.js`: S4's write → ag-psd → raw resources inserted → `afterWrite` stages; then
`encodeForPath` applies the `'save'` chunks (0.5). The ids the chunks own (1005, 1028, 1036, 1039, 1058, 1060) are
refused by `registerPsdRawResource`. Orders: raw paths 300, clipping path 320, alpha names and DisplayInfo 350; byte
stages `channels` 500, `deep` 600, `modes` 700.

**T10.3 Byte helpers** (`lib/psd/bytes.js`, skeleton, pure, Node-tested on files ag-psd writes): `psdSections(bytes) →
{ header: { version, channels, height, width, depth, mode }, colorModeData, imageResources, layerAndMask, imageData }`
(offsets and lengths), `readImageResources(bytes) → Map`, `writeImageResources(bytes, map, { remove })`,
`packBits(row)`, `unpackBits(data, length)`, `writeHeader(bytes, header)`, `replaceSection(bytes, name, data)`,
`psdLayerSection(bytes)` and `psdFromLayerSection(section, { width, height, depth, mode })` (T10.5).

**T10.4 ag-psd 31.0.3, measured:** writes 8-bit RGB only ("bitsPerChannel other than 8 are not supported for
writing"), reads 16/32-bit layer data only with `useImageData`, has no resource handlers for paths, alpha names or
DisplayInfo (raw resources here), and supports `psb: true`. psd-document writes 16/32-bit and the modes through byte
stages over ag-psd's 8-bit file; a package that needs another internal names it in its report (S4.5).

**T10.5 Layered TIFF** (save-options-common-formats): tag 37724 holds `"Adobe Photoshop Document Data Block\0"` and
`psdLayerSection(writePsdDocument(doc, compositor, opts))`; reading wraps the section with `psdFromLayerSection` and
reads it with `readPsdDocument`, so every mapper applies.

**T10.6 Notices and flags.** psd-document registers save notices for what a file cannot keep; while
`psdFeatures().modes` / `.deep16` are false, the skeleton keeps 0.5's two toasts ("PSD files are written as RGB …"
in `documents.js`, "PSD files are written at 8 bits/channel …" in `depth.js`), gated on those flags (marked).
`PSD_FEATURES` of the four files: `guidesGrid`, `paths`, `alphaChannels`, `spotChannels`, `deep16`, `deep32`, `modes`,
`psb`, `psdt`. Later users: layer-comps (resource 1065 at order 600), artboards-frames (kind 120), slices-web-export
(1050), cmyk-formats-separations (CMYK, Lab, Duotone and Multichannel through byte stages and `bytes.js`).

**T10.7 Paths.** Round trips of each resource against documents and files the tests build; the 0.5 PSD goldens hold
while the flags are false (skeleton-05's gate); 16/32-bit and the modes are this package's subject; the packaged build
carries no new vendor code.

#### T11. Export and save options

**T11.1 Formats.** save-options-common-formats registers BMP (read and write), ICO and CUR, TIFF and WebP options and
its own JPEG encoder through `registerExportFormat` (0.3), which adds their extensions to `WRITE_EXTENSIONS` and to
Save As (`SAVE_FILTERS` is built from the registered formats by the skeleton). The browser's encoders stay in use
whenever the options are 0.5's (baseline JPEG at a quality, PNG with default compression, lossy WebP), so a save with
default options keeps 0.5's bytes; the own encoders run when an option needs them.

**T11.2 Save As options (E78)** (`documents.js`, skeleton): `registerSaveOptions('*', def)` is asked first for every
format; `def.id` names a registration and the same id registered again replaces it (0.5's built-in JPEG/WebP quality is
`id: 'quality'`); `ask(app, doc, path, { ask, saveAs })` gets `saveAs: true` from Save As and Save a Copy. `writeTo`
honours `asCopy` (as `copy`: no `markSaved`, the path stays), `layers: false` (encode flattened), `alphaChannels`,
`spotColors`, `notes` (PSD writers read them), `useProofSetup` (flat formats: the flattened image through
`proofConvertCanvas`, T8.4) and `embedProfile` (S6.3). save-options-common-formats registers the `'*'` panel (As a
Copy, Layers, Alpha Channels, Spot Colors, Notes, Use Proof Setup, Embed Color Profile; only the choices the format
can hold) and the per-format dialogs (JPEG, PNG, TIFF, WebP, BMP, ICO). Stub: `'*'` answers `{}`, so the flow is 0.5's.

**T11.3 Option keys** (the contract formats-more-codecs and save-for-web build on): JPEG `{ quality 0..1, format:
'baseline' | 'optimized' | 'progressive', scans: 3..5, subsampling: '4:4:4' | '4:2:2' | '4:2:0', matte, grey }`; PNG `{
compression: 'none' | 'fast' | 'smallest', interlace }` (the skeleton's `depth.js` passes them to `encodePng` for
16-bit); TIFF `{ compression: 'none' | 'lzw' | 'zip' | 'jpeg', quality, byteOrder: 'II' | 'MM', pyramid, layers,
layerCompression: 'rle' | 'zip', transparency, alphaChannels }`; WebP `{ quality, lossless }`; BMP `{ depth: 1 | 4 |
8 | 16 | 24 | 32, rle, os2, flip }`; ICO and CUR `{ sizes: number[], hotspot? }`.

**T11.4 Export assets (E79)** (export-as, `lib/export/assets.js`):

```ts
interface ExportAsset {
  source: { kind: 'document' } | { kind: 'layers', ids: string[] } | { kind: string, ref: string };   // artboards 0.9, comps 0.8
  scales: { scale?: number, width?: number, height?: number, suffix: string }[];
  format: string; options: object; canvas?: { width, height };
  resample: 'bicubic' | 'bilinear' | 'nearest' | 'lanczos' | 'area';
  metadata: 'none' | 'copyright' | 'all'; convertTo: 'srgb' | null; embedProfile: boolean }
renderAsset(doc, asset, scaleIndex): Promise<{ canvas, deep? }>      // what the preview and the encoder use
exportAssets(app, doc, assets, { folder, naming }): Promise<{ written: string[], report: string[] }>
registerAssetSource(kind, { label, list(doc), render(doc, ref, opts) })   // artboards-frames, layer-comps, slices-web-export
```
Every write goes through `io.js exportImage` with `purpose: 'export'` (chunks once, S5). Export Preferences
(`settings.export = { quickFormat: 'png', quickOptions: {}, quickLocation: 'ask' | 'next-to-document', metadata: 'none',
convertToSrgb: true, embedProfile: true }`), Quick Export as [format] (menu label from ui state `quickExportFormat`),
the dialog (asset list, scales with suffixes, preview with zoom and 2-up, sizes, resample, metadata, colour space, file
size), Layers to Files (PSD output, nested layers, per-format options). Convert to sRGB defaults on, as Photoshop (0.5
review decision 6). Command ids and replay arguments stay: `file:export` (0.4's `{ path, format, quality, width,
height, background }` replays; 0.6 adds `{ assets, folder }`), `file:export-quick`, `file:export-layers`,
`layer:export-as`, `layer:export-quick`; `file:export-preferences` is new.

**T11.5 Paths.** No history; actions replay with their arguments; 16/32-bit: PNG and TIFF keep the depth through their
encoders, the rest are 8-bit; modes: the mode renderer runs in the flatten (0.3); Electron: folder and file dialogs.

#### T12. File handling (E80–E82)

**T12.1 Opening** (skeleton): `openDocument(bytes, { name, path, as = null, interactive = true })`; `as` forces a
reader (a registered id, or `'pigment'`, `'psd'`, `'image'`); readers get `{ name, path, colorSpaceConversion,
interactive }` and may return `null` ("nothing to open": Cancel or Done in the RAW workspace, a cancelled Import PDF):
`openPaths` then adds nothing, reports no error and records no recent file; or an array of documents (Import PDF of
several pages), each added like a single open. `registerOpenGroup({ id, test(path) →
boolean, open(app, paths, { interactive }) → Promise<Document[]> })`: `openPaths` hands every path a group's `test`
accepts to that group at once (RAW files opened together share one session, T14.4) and opens the rest one by one; the
group's documents go through `add`, the open hooks and the notices like the others. Batch calls `openDocument` with
`interactive: false`. Open As (`file:open-as`, file-handling-autosave) shows the open dialog, then the reader choice.

**T12.2 Versions** (file-handling-autosave, `lib/versions.js`): with `settings.fileHandling.versions.enabled`, saving a
`.pigment` keeps the previous saved file inside the new one as `versions/<n>.pigment` (T5.5), at most `keep` (5);
`file:versions` (File › Version History…) lists them with time and thumbnail and opens one as a new document or
restores it (`replaceContent`, "Restore Version").

**T12.3 Replacing content (E81)** (`documents.js`, skeleton): `app.docs.replaceContent(doc, fresh, { label = 'Revert'
})`: one history entry that swaps the document's content (tree, size, mode, depth, colour table, duotone, profile,
channels, paths, store, selection, meta, metadata) with `fresh`'s; the entry keeps both sides by reference (fresh's
objects become the document's), and the document is marked saved after a Revert or a reload. `file:revert` (moved to
`lib/file-handling.js`; F12) becomes this entry, without 0.5's confirmation once file-handling-autosave lands (T18.2
gates `hunt2.spec.mjs`'s two confirmations). File watching (`lib/file-watch.js`, `settings.fileHandling.autoUpdate`)
reloads a clean document through it and asks first for one with unsaved changes.

**T12.4 Recovery** (file-handling-autosave, `lib/recovery.js`): `settings.fileHandling = { recovery: { enabled: true,
minutes: 10 }, autoUpdate: false, versions: { enabled: false, keep: 5 }, backgroundSave: false }`. Every N minutes each
document changed since its last recovery write is written with `writePigment` (layer by layer between idle callbacks)
through `bridge.recoveryWrite`, with an index `recovery/index.json` (`{ id, name, path, at, file }[]`); a save or close
removes its entry. On `'app:started'` entries left by a crash are offered (Open, Delete, Later); a recovered document
is untitled and dirty with `doc.recoveredFrom = path`. Save in Background stays off (workers-progress, 0.8, completes
it).

**T12.5 Bridge (E82)** (skeleton: `ipc.js`, `preload.cjs`, `bridge.js`):

```ts
bridge.share(paths: string[], { title }): Promise<{ ok: boolean, reason?: 'unsupported' | 'cancelled' }>
bridge.tempPath(name): Promise<string>                        // <tmp>/pigment-share/<name>, the folder emptied at quit
bridge.recoveryList(): Promise<{ name, size, mtimeMs }[]>;  bridge.recoveryRead(name); bridge.recoveryWrite(name, bytes);
bridge.recoveryRemove(name);  bridge.recoveryReveal()          // <userData>/recovery/, names without separators
bridge.on('file-changed', (path) => void)                     // watch.js's events, which main already sends
```
`src/main/share.js` (file-handling-autosave; stub `{ ok: false, reason: 'unsupported' }`): macOS through Electron's
`ShareMenu`; Windows and Linux reveal the exported copy in the file manager and say so. The browser bridge: `share`
through `navigator.share` with files when available, recovery in memory (`window.__pigmentTest.recovery`), no file
events.

**T12.6 Paths.** Revert and Restore Version are undoable entries; recovery files are `.pigment` files, so what survives
`.pigment` survives a crash; actions: `file:revert` keeps 0.5's recording rule, the others are `record: false`;
Electron and the browser build differ as T12.5 says.

#### T13. OpenType and the Glyphs panel (E83)

**T13.1 The catalogue** (`src/shared/opentype-features.js`, skeleton, frozen; the menu template and the renderer both
read it):

```ts
OPENTYPE_FEATURES: { id: string, label: string, on: [tag, value][], off?: [tag, value][], defaultOn: boolean,
                     group: 'ligatures' | 'alternates' | 'figures' | 'positional' | 'japanese', exclusive?: string }[]
featuresFor(current: CharStyle['features'], id, on: boolean): CharStyle['features']   // the patch for one toggle
activeFeatureIds(features): string[];  featureTags(id): string[]
```
Ids: `standard-ligatures` (liga, clig; on by default), `contextual-alternates` (calt; on), `discretionary-ligatures`
(dlig), `swash` (swsh), `stylistic-alternates` (salt), `ss01` … `ss20`, `titling` (titl), `ornaments` (ornm),
`ordinals` (ordn), `fractions` (frac), `justification-alternates` (jalt), `lining` / `oldstyle` (lnum / onum,
exclusive `figure-case`), `proportional` / `tabular` (pnum / tnum, exclusive `figure-width`), `jp78`, `jp83`, `jp90`,
`jp04`, `nlck` (exclusive `japanese-forms`), `proportional-metrics` (palt). A feature is a run attribute in 0.4's
CharStyle `features` (tag → value), which type-fonts' shaper already passes to HarfBuzz: no model or shaper change.
Small caps stay 0.4's `caps: 'small'` (real `smcp` when the face has it).

**T13.2 Commands and controls** (type-opentype-glyphs): `type:opentype { id, on? }` (toggles without `on`) applies
through `type/target.js applyChar` (one entry named after the feature, as Photoshop); Type › OpenType ▸ and the
Character panel menu's OpenType ▸ (`openTypeMenuItems(app)` from `lib/type/features.js`, placed by the skeleton in
`char-format.js`) list the catalogue as checkboxes (`state.openType`, `state.openTypeAvailable`, T17.5); the Character
panel's button row is an E26 section `opentype`. A feature the face lacks is disabled (from the face record's
`features` set); text drawn by the Canvas fallback engine (browser build without local fonts) cannot take features,
and the controls say so.

**T13.3 The Glyphs panel** (`lib/panels/glyphs.js`, `window:panel-glyphs`): the face's glyphs from its cmap
(`face.collectUnicodes()`) and GSUB (`face.referenceTable('GSUB')`, parsed by the package), font and style choice, zoom,
subsets (Entire Font, Alternates for Current Selection, Unicode blocks, OpenType features) through
`registerGlyphSubset({ id, label, test(codepoint, face) })`, recently used glyphs (`settings.glyphs.recent`, 30). Double
click: `type:insert-glyph { text, features?, postScriptName? }` inserts at the caret of the type session through 0.4's
editor (`typeSession(app).session.editor.insert`, then `typeSession().edit` for the features; one step of the
session's own undo, its text recorded), or replaces the selection. A glyph reachable only through a substitution
inserts its base character with the feature value that selects it (`aalt`, `salt`, `ssNN`, `swsh` = n) on that one
character; a glyph with neither a code point nor a feature route is shown greyed. The on-canvas alternates popup
(`alternates-popup.js`) does the same for the one selected character.

**T13.4 PSD** (`lib/psd/text-features.js`): aspect `text-features` (order 410, after psd-text's text kind) writes the
runs' features into the TextStyle fields ag-psd has (`ligatures`, `dLigatures`, `swash`, `oldStyle`, `fractions`,
`ordinals`, `titling`, `stylisticAlternate`, `ornaments`, `figureStyle`) on layers claimed `'text'`, reads them back by
text offset, and reports features without a PSD field (stylistic sets) once.

**T13.5 What later packages use.** type-styles-prefs (0.7): character styles store `features`; `featuresFor` and the
catalogue; `insertGlyph(app, spec)` (exported). type-international (0.9): `registerGlyphSubset` for CJK and Arabic
blocks; vertical forms (`vert`, `vrt2`) are applied by the vertical layout, not listed in the catalogue.

**T13.6 Paths.** One entry per toggle; `.pigment` and clone carry `features` (0.4); PSD: T13.4; actions record
`type:opentype` with its id and `type:insert-glyph` with its text; Electron: local fonts reach HarfBuzz through
`queryLocalFonts` (0.4); the browser build without `local-fonts` only shapes added fonts.

#### T14. Camera RAW opening (E84)

**T14.1 Decoder, licence and shipping** (raw-open-workflow). LibRaw (0.21 or later) compiled to wasm without the GPL
demosaic packs, run in a module worker. Licence route **LGPL-2.1** (LibRaw's other option, CDDL-1.0, is not needed):
the wasm and its glue ship as separate files in `src/renderer/vendor/libraw/` (`libraw.wasm`, `libraw.mjs`,
`LICENSE`, `SOURCE.md` with the exact version, the source URL and the build script), loaded by URL at run time and never
bundled into Pigment's own code; `build.asarUnpack` (package.json, raw-open-workflow) keeps the folder outside the asar
so a user can replace it with an own build of the same interface (`libraw_version()` is checked at load). The vendor
step `scripts/vendor/libraw.mjs` builds from pinned sources when emscripten is present, else copies a pinned prebuilt
package; when neither works it warns (E23) and RAW stays off (`RAW_FEATURES.decoder` false: no reader registered). CSP:
`'wasm-unsafe-eval'` and `worker-src 'self' blob:` are already in `index.html` (0.4). Decoding API (`lib/raw/decode.js`):

```ts
decodeRaw(bytes, { half = false } = {}): Promise<{ width, height,
  planes: { R, G, B: Float32Array },              // camera-native, linear, black-subtracted, not white-balanced
  camera: { make, model, lens?, iso?, exposureTime?, fNumber?, focalLength?, date? },
  asShot: { multipliers: [r, g, b], temperature?, tint? }, cameraToXyz: number[] /* 3x3, D50 */,
  dng?: { colorMatrix1?, colorMatrix2?, forwardMatrix1?, forwardMatrix2?, illuminant1?, illuminant2?, profileName? },
  exif: Uint8Array | null, thumbnail: Uint8Array | null, orientation: number }>
```

**T14.2 The linear input path** (skeleton, `develop-stages.js` / `develop.js`): `developPlanes(planes, params, { input
= 'display' | 'raw', rect, processVersion })` runs the registered stages on float planes, skipping 0.2's sRGB-to-linear
entry when `input` is `'raw'`; every stage's `ctx` gains `input`. `develop(img, params, rect)` (8-bit, smart filters,
actions) is unchanged and passes `'display'`. `registerRawVariant(stageId, apply)` lets the builtin stages
`white-balance`, `exposure` and `tone` hand raw input to raw-open-workflow's scene-linear versions (Exposure in true
stops, white balance in camera space, highlight recovery); the display path is untouched (the S8.1 unit test against
`develop-04.mjs` keeps passing). raw-open-workflow registers raw-only stages from `develop-linear.js` (imported by
`develop.js`; the stub is empty): `camera-color` (order 95: camera RGB to the working linear space through the DNG
matrices interpolated by temperature, LibRaw's matrix, or a user `.dcp` HueSatMap and forward matrix) and `dcp-look`
(order 260); both are neutral on display input. `.dcp` files are a preset kind `camera-profiles` (`{ make, model, name,
blob: 'dcp-<sha1>.dcp' }`), listed in the workspace's profile browser.

**T14.3 Workflow and outputs.** `settings.rawWorkflow = { space: profile id ('srgb'), depth: 8 | 16 | 32 (8), size: {
long } | null, resolution: 300, sharpen: { for: 'none' | 'screen' | 'matte' | 'glossy', amount: 'low' | 'standard' |
'high' }, smartObjects: false }` and the preset kind `raw-workflow-presets`. Open: a document in the workflow space
(`doc.profile`), depth and size, `doc.format = 'raw'`, the EXIF block through `setMetadata` (T9.2). Open Copy: the
same, the sidecar not written. Open Object: a smart object of source kind `raw` (T6: the raw bytes, params and
workflow; `draw` renders the developed image; double-click reopens the workspace). Done: the sidecar is written,
nothing opens (the reader returns `null`). Save Image: JPEG, TIFF or PSD through `encodeForPath` of a temporary
document. Photo Merge (HDR, Panorama, HDR Panorama): `app.alignBlend.alignImages` and 0.3's merge maths, giving a
`.pigment` document or a TIFF (never DNG).

**T14.4 The session** (raw-open-workflow owns `develop-ui.js` and `develop/workspace.js` for the round):
`openRawSession(app, files: { path, bytes }[], { interactive })` opens 0.5's workspace in RAW mode on several images:
the filmstrip slot (thumbnails, ratings and colour labels, multiple selection, Sync Settings), the footer's Workflow
Options link and the buttons Save Image…, Open (Alt: Open Copy; Shift: Open Object), Cancel, Done. It registers the
open group `raw` (T12.1) for the RAW extensions (`dng`, `cr2`, `cr3`, `crw`, `nef`, `nrw`, `arw`, `srf`, `sr2`, `raf`,
`orf`, `rw2`, `rwl`, `pef`, `srw`, `x3f`, `3fr`, `iiq`, `mrw`, `dcr`, `kdc`, `erf`, `mos`, `raw`; the skeleton adds them
to `src/shared/formats.js`) and a reader with `interactive: false` (Batch, actions: the sidecar or the defaults, no
UI). The open hook policy of T7.3 skips `format: 'raw'`.

**T14.5 Sidecar .xmp.** `<name>.xmp` beside the raw file (Electron; the browser build keeps settings in the session):
`paramsToXmp(params) → string` and `paramsFromXmp(text) → { params, report }` are a facade the skeleton adds in
`lib/develop/registry.js` over camera-raw-workspace's reader and writer (S8.4); raw-open-workflow adds `xmp:Rating`,
`xmp:Label` and `crs:RawFileName`.

**T14.6 What later packages use.** camera-raw-local (0.9) adds local adjustments as stages over `developPlanes`;
lens-correction-profiles (0.9) reads `camera.lens` and the EXIF fields and adds an Optics profile option through E47.

**T14.7 Paths.** Opening is not an entry; Open Object's smart object edits are E55 entries; `.pigment` embeds the raw
bytes of a `raw` source (large files, documented); PSD writes it as pixels (0.5); actions replay `file:open-paths` of a
raw file non-interactively; 16/32-bit outputs; Electron: the unpacked wasm and the worker inside the packaged app;
the browser build loads the same files from `vendor/`.

#### T15. PDF import

**T15.1 pdf.js** (`pdfjs-dist`, Apache-2.0). The skeleton adds it to `devDependencies` at an exact version (the newest
release at least two weeks old that runs in Electron 44's Chromium; Folio's version is preferred, so one copy is
reviewed). pdf-import's vendor step copies `build/pdf.min.mjs`, `build/pdf.worker.min.mjs`, `cmaps/` and
`standard_fonts/` into `src/renderer/vendor/pdfjs/` (git-ignored, like ag-psd's bundle). Loading: `import()` of that
file on first use, `GlobalWorkerOptions.workerSrc` beside it, `isEvalSupported: false`, local `cMapUrl` and
`standardFontDataUrl`, no network; the CSP is unchanged. The NOTICE goes into `docs/0.6/pdf-import.md`.

**T15.2 Open** (`lib/pdf/import.js`): `registerOpenFormat({ id: 'pdf', extensions: ['pdf', 'ai'], test: '%PDF-'
header, read })`. Interactive: the Import PDF dialog (Pages or Images; page thumbnails with multiple selection; Crop To:
bounding, media, crop, bleed, trim or art box; width, height, resolution and units with Constrain Proportions; Mode RGB
or Grayscale; 8 or 16 bits; Anti-aliased). A reader may return several documents (`Document[]`, the skeleton's
`openPaths` adds each, T12.1). Not interactive: page 1 with the last settings (`settings.pdfImport`). The PDF's XMP
metadata goes to `setMetadata`; an RGB result is untagged (the working space). A non-PDF `.ai` (before Illustrator 9)
is refused with a message.

**T15.3 Place** (`lib/pdf/smart-source.js`): place reader `pdf` (`.pdf`, `.ai`; a page and crop box chooser) and
source kind `pdf` (`{ bytes, page, box, width, height }` in points at 72 ppi): `draw(ctx, src, { matrix, rect })`
renders the page with pdf.js at the matrix's scale. pdf.js renders asynchronously: a kind's `draw` may return `false`
after drawing its nearest cached render scaled, and calls `src.onReady()` when the exact render is done; the skeleton's
`SmartLayer` sets `onReady` to touch the layer and repaint. `.eps` placement is refused with "needs an EPS interpreter
(Pigment 0.9)" (formats-more-codecs).

**T15.4 What later packages use.** linked-smart-objects (0.7): kind `pdf` with `link`; notes-count-measurement (0.9):
`pdfAnnotations(bytes, page) → { rect, contents, author, date }[]` (exported by `import.js`).

**T15.5 Paths.** Place is one structural entry (0.2); `.pigment` stores the PDF bytes through the kind's `toFiles`;
PSD writes the object as pixels (0.5); actions replay `file:place` and `file:open-paths` with the last settings;
16-bit import renders at 8 bits and converts; Electron loads the vendor files inside the asar through `pigment://`.

#### T16. View navigation (E85, E86)

**T16.1 Range.** `MIN_ZOOM = 0.002`, `MAX_ZOOM = 128` (0.2 % to 12 800 %), `ZOOM_STEPS` extended with Photoshop's
steps; the pixel grid and `imageSmoothingEnabled` rules of 0.2 hold.

**T16.2 Motion** (`lib/view-motion.js`): `view.zoom`, `panX`, `panY` and `rotation` take their target values at once;
Animated Zoom is a display transition only (the drawn transform eases over at most 150 ms while pointer mapping uses
the target), so every caller and spec that reads `view.zoom` after a zoom command sees the final value. API:
`view.animateTo({ zoom?, anchor?, panX?, panY?, rotation? }, { duration })`, `view.scrollBy(dx, dy)`,
`view.scrollPage('up' | 'down' | 'left' | 'right' | 'home' | 'end', { small })`, `'view:changed'` with the target
values (0.2). Flick panning: after a Hand or Space drag whose samples of the last 30 ms (by `timeStamp`) move faster
than 0.8 px/ms, the pan continues and decays; synthetic drags whose samples share time stamps never flick
(`conventions-shortcuts-fields.spec.mjs:385–389` asserts an exact pan). Overscroll: `settings.view.overscroll` default
true keeps 0.5's 40 px sliver; false clamps as Photoshop's default does (a recorded difference).

**T16.3 Wheel, gestures, auto-scroll.** Plain wheel scrolls (Shift: sideways), or zooms with Zoom with Scroll Wheel
(0.5's setting); Alt+wheel zooms at the pointer; Ctrl+wheel (Cmd+wheel on macOS) scrolls sideways (Photoshop; 0.5
zoomed: release note). A trackpad pinch arrives as a wheel event with `ctrlKey` while Control is not physically held
(tracked from key events) and zooms. Edge auto-scroll (E85): during a primary-button drag routed to a tool whose
`autoScrolls(tool)` is true (`tool-traits.js`, skeleton; false for Hand, Rotate View, Zoom, Eyedropper, Color Sampler),
a pointer that stays outside the canvas area for 100 ms scrolls the view toward it, re-sending `onPointerMove` at the
same screen point each frame; the release stops it.

**T16.4 Scroll bars** (`lib/view-scrollbars.js`): overlays on the canvas host's right and bottom edges (thumb = visible
fraction), hidden in full screen; dragging a thumb pans, a click on the track pages.

**T16.5 Tool letters (E86)** (skeleton, `shortcuts.js`): a letter activates the slot's current tool, except in a slot
whose tools have different letters of their own (`tool.key`): there the letter activates its tool. So H is always the
Hand and R always Rotate View, both in the Hand slot as in Photoshop; Shift+H / Shift+R cycle the slot.

**T16.6 Tools and Navigator** (view-navigation, `lib/tools/view-tools.js`, `panels/navigator.js`): Hand with bird's-eye
view (hold H and press while zoomed in: the view zooms out to fit with a box; the release zooms in where the box is),
Zoom (scrubby zoom, Zoom Clicked Point to Center, double-click its toolbox icon: 100 %), Hand icon double-click: fit;
Rotate View with a compass overlay and an angle field; the Navigator's Ctrl-drag region zoom and Panel Options (view box
colour, `settings.view.navigatorColor`). Toolbox double-clicks reach `tool.toolboxDoubleClick?.()` (skeleton,
`tools.js`).

**T16.7 Preferences and keys.** The skeleton's built-in section `navigation` (order 22) holds `zoomWithWheel` and
`animatedZoom` (moved from `interface`); view-navigation replaces it (Animated Zoom, Zoom with Scroll Wheel, Zoom
Clicked Point to Center, Enable Flick Panning, Overscroll) over `settings.view` and the two 0.3 keys. Keys: `view:scroll`
(T17). Resize Windows, Scroll All Windows and Zoom All Windows wait for document-windows (0.8), which uses
`animateTo`, the scroll API and the zoom constants.

**T16.8 Paths.** No history; preferences persist; Electron: macOS trackpad pinch and Windows precision touchpads
through the ctrlKey rule; the browser build is the same.

#### T17. Commands, menus and keys

**T17.1** S13.1's rules hold: every item and binding below lands in skeleton-06 (`menu-template.js`, `keymap.js`,
`COMMAND_LABELS`, `SHORTCUT_GROUPS`); an item whose command is a stub is disabled through `state.stubs`; no package
adds a command id outside this table; actions inside a package's own panels and dialogs are not commands unless
listed. Keymap tables bind commands, not arguments, so keyed variants are separate ids.

**T17.2 Menus.** File: Open As… after Open…; Version History… after Revert; Export ▸ gains Export Preferences… after
Export As…, and its first item's label is "Quick Export as <format>" (`state.quickExportFormat`); Share… after
Export ▸. Edit: Color Settings… gets Shift+CmdOrCtrl+K. Layer › Smart Filter ▸ (0.4 submenu) gains Disable Filter
Mask and Delete Filter Mask. View: Proof Setup ▸ before Proof Colors (radios on `state.proofSetup`: Custom…, ─,
Working CMYK, Working Cyan / Magenta / Yellow / Black Plate, Working CMY Plates, ─, Legacy Macintosh RGB, Internet
Standard RGB (sRGB), Monitor RGB, ─, Color Blindness – Protanopia-type, Color Blindness – Deuteranopia-type, then the
saved setups of `state.proofSetups`); 200% keeps its item without a key. Type: Panels ▸ gains Glyphs Panel; OpenType ▸
after Anti-Alias ▸ (checkboxes from `OPENTYPE_FEATURES`, checked from `state.openType`, enabled from
`state.openTypeAvailable`). Window (`PANELS`): Glyphs after Paragraph. Channel, History and Glyphs panel commands
have no native items.

**T17.3 Every new command id.**

| Id (arg) | Menu place | Key | Until the owner lands | Owner |
|---|---|---|---|---|
| `select:offset` (`{ dx, dy }`) | none (selection tools, arrows) | none (the tools' arrows) | working | skeleton |
| `tool:selection-brush` | toolbox, `wand` slot | Shift+W cycles (0.4) | stub; `app.tools.register` replaces it | selection-tools-depth |
| `select:quick-mask-options` (`{ indicates, color, opacity }` or dialog) | none (Quick Mask row and button double-click) | none | stub | select-menu-finish |
| `channel:target` (`'composite' \| 'mask' \| 'layer' \| { channels } \| { alpha: name }`) | none (Channels panel) | none | stub | channels-depth |
| `channel:target-composite`, `channel:target-1` … `-7`, `channel:target-mask` | none | Ctrl+2, Ctrl+3 … Ctrl+9 (the n-th channel after the composite: colour channels, then alpha and spot), Ctrl+\\ | stub | channels-depth |
| `channel:load-composite`, `channel:load-1` … `-7` | none | Ctrl+Alt+2 (luminosity), Ctrl+Alt+3 … Ctrl+Alt+9 | stub | channels-depth |
| `channel:new`, `channel:new-spot`, `channel:duplicate`, `channel:delete`, `channel:options`, `channel:merge-spot`, `channel:split`, `channel:merge`, `channel:panel-options` | none (Channels panel menu) | none | stub | channels-depth |
| `channel:visibility` (id or colour id) | none (eyes) | none | stub, `record: false` | channels-depth |
| `layer:smart-filter-mask` (`'add' \| 'delete' \| 'toggle' \| 'link' \| 'from-selection'`) | Layer › Smart Filter ▸ | none | stub | smart-filters-depth |
| `history:new-snapshot` (`{ name, from }` or dialog) | none (History panel) | none | stub | history-panel-depth |
| `history:select`, `history:delete`, `history:clear`, `history:new-document`, `history:options`, `history:set-source` | none (History panel and its menu) | none | stub, `record: false` | history-panel-depth |
| `edit:color-settings` (0.5 id) | Edit | Shift+CmdOrCtrl+K | stub, moves from `stubs-later.js` to `lib/color/settings.js` | color-settings |
| `edit:convert-profile` (0.5 id; T7.4) | Edit | none | stub, moves to `lib/color/convert.js` | color-settings |
| `view:proof-setup` (T8.1 id or `{ custom }`) | View › Proof Setup ▸ | none | stub, `record: false` | soft-proofing |
| `file:export-preferences` | File › Export ▸ | none | stub | export-as |
| `file:open-as` | File | Alt+Shift+CmdOrCtrl+O | stub | file-handling-autosave |
| `file:versions` | File | none | stub | file-handling-autosave |
| `file:share` | File | none | stub, `record: false` | file-handling-autosave |
| `file:revert` (0.4 id) | File | F12 (0.5) | working, moved to `lib/file-handling.js` | file-handling-autosave |
| `type:opentype` (`{ id, on? }`) | Type › OpenType ▸; Character panel menu | none | stub | type-opentype-glyphs |
| `type:insert-glyph` (`{ text, features?, postScriptName? }`) | none (Glyphs panel) | none | stub | type-opentype-glyphs |
| `window:panel-glyphs` | Window; Type › Panels ▸ | none | stub | type-opentype-glyphs |
| `view:scroll-up`, `-down`, `-left`, `-right`, `-up-small`, `-down-small`, `-left-small`, `-right-small`, `-home`, `-end` | none | PageUp, PageDown, CmdOrCtrl+PageUp, CmdOrCtrl+PageDown, Shift+PageUp, Shift+PageDown, Shift+CmdOrCtrl+PageUp, Shift+CmdOrCtrl+PageDown, Home, End | stub | view-navigation |

raw-open-workflow, pdf-import, metadata-io, psd-document, save-options-common-formats add no command: they work
through File › Open, Place, Save As, Export As and the workspace's own buttons.

**T17.4 Changed bindings and the specs that press them** (grep of `tests/e2e` and `tests/electron` for
`keyboard.press`, `keyboard.down`, `mouse.wheel` and `sendInputEvent` on the frozen 0.5 tree):

| Key | 0.5 | 0.6 | Spec lines | Change |
|---|---|---|---|---|
| Ctrl+2 | `view:zoom-200` (renderer key) | `channel:target-composite` | none | none |
| Ctrl+3 … Ctrl+9, Ctrl+Alt+2 … 9, Ctrl+\\ | unbound | channel keys | none (`masks-vector-masks.spec.mjs:386` presses Backslash alone: `layer:mask-overlay`, unchanged) | none |
| Shift+CmdOrCtrl+K | type session only (All Caps) | `edit:color-settings`; the type key still wins inside a type session (`typeKeyFor`, 0.4) | `type-editing.spec.mjs:315` (in a session) | none |
| Alt+Shift+CmdOrCtrl+O | unbound | `file:open-as` | none | none |
| PageUp, PageDown, Home, End (and modified) | unbound | `view:scroll-*` | `Home`, `End`, `Shift+Home`, `Shift+End`, `Control+Home`, `Control+End` are pressed in text fields and type sessions only, where plain and editing keys never reach the global table (0.4) | none |
| Ctrl+wheel | zoom | sideways scroll (a pinch still zooms) | `conventions-shortcuts-fields.spec.mjs:70, 394` use a plain wheel | none |
| Alt+wheel | scroll | zoom | none | none |
| R, H | the Hand slot's current tool | Rotate View, Hand | `blur-gallery.spec.mjs:541–545` presses `h` inside the Blur Gallery session (its own keys) | none |

**T17.5 UI state** (added keys): `proofSetup` (condition id), `proofSetups` (JSON of the saved setups' ids and names),
`openType` and `openTypeAvailable` (comma lists of catalogue ids for the active text), `quickExportFormat` (`'PNG'`),
`channelTarget` (`'composite' | 'r' | 'g' | 'b' | 'mask' | <alpha id>`).

#### T18. Settings, preset kinds, spec lines, stubs and flags

**T18.1 Namespaces** (`src/shared/defaults.js`, skeleton; rule 5):

| Key | Owner | Declared sub-keys |
|---|---|---|
| `selectionTools` | selection-tools-depth | `selectMask: { remember: true, presetId: null, highQuality: false, realtime: true }` |
| `selectMenu` | select-menu-finish | `colorRange: { last: null }`, `quickMask: { indicates: 'masked', color: '#ff0000', opacity: 0.5 }` |
| `channels` | channels-depth | `showInColor: false`, `thumbSize: 'small'` |
| `smartFilters` | smart-filters-depth | `{}` |
| `history` | history-panel-depth | T4.7 |
| `colorSettings` | color-settings | T7.1 (`preset: 'pigment-default'`, `rgb: 'srgb'`, `cmyk: null`, `gray: null`, …) |
| `proof` | soft-proofing | `last: { id: 'working-cmyk', device: null, preserveNumbers: false, intent: 'relative', bpc: true, paperColor: false, blackInk: false }`, `gamut: { color: '#808080', opacity: 1 }` |
| `metadata` | metadata-io | `{}` |
| `psdDocument` | psd-document | `{}` |
| `export` | export-as | T11.4 |
| `saveOptions` | save-options-common-formats | `jpeg: {}`, `png: {}`, `tiff: {}`, `webp: {}`, `bmp: {}`, `ico: {}` (the last answers per format) |
| `fileHandling` | file-handling-autosave | T12.4 |
| `glyphs` | type-opentype-glyphs | `recent: []`, `zoom: 1`, `subset: 'all'` |
| `rawWorkflow` | raw-open-workflow | T14.3 plus `sidecar: true`, `libraryPath: null` |
| `pdfImport` | pdf-import | `{ select: 'pages', box: 'crop', resolution: 300, mode: 'rgb', depth: 8, antialias: true }` |
| `view` | view-navigation | `overscroll: true`, `flickPanning: true`, `zoomClickedPointToCenter: false`, `navigatorColor: '#ff0000'` |

0.3's flat `zoomWithWheel`, `animatedZoom`, `proofColors`, `gamutWarning`, `infoSecondary`, `historyLimit`,
`historyMemoryMB` and `exportDefaults` stay where they are. Preferences sections of 0.6 (E20, new ids): `navigation` 22
(built-in by the skeleton, replaced by view-navigation), `transparency-gamut` 31 (soft-proofing), `file-recovery` 44
(file-handling-autosave; psd-layers' `file-handling` 45 stays its own), `export` 48 (export-as), `raw-files` 49
(raw-open-workflow: sidecars, the LibRaw folder).

**T18.2 Existing spec lines that pin a 0.5 behaviour** (edited by the skeleton so they hold before and after the package
lands; rule 11; flags read in the page by dynamic import of the T18.4 modules):

| Line | Pins | Change (step of Part 2) |
|---|---|---|
| `tests/e2e/skeleton-05.spec.mjs:719` "every save and export of an untagged document is byte-identical" (as the 0.5 integrator left it) | no metadata provider | its byte comparisons run while `!METADATA_FEATURES.provider`; after, decoded pixels are equal and the chunk kinds are exactly `resolution` (PNG, JPEG, TIFF), `resolution` and `thumbnail` (PSD) (9) |
| `tests/e2e/hunt2-layers.spec.mjs:276`, `:282` | the count of every `.history-item` in the panel (a first snapshot adds one) | `.history-states .history-item`: equal before and after (6) |
| `tests/e2e/hunt2.spec.mjs:125`, `:134` | Revert's confirmation | `confirmDialog` only while `app.stubbed.includes('file:open-as')`; after, the test also checks one "Revert" entry and `dirty === false` (11) |
| `tests/e2e/conventions-shortcuts-fields.spec.mjs` (the 0.5 S14.2 probe for "color settings") | `edit:color-settings` disabled | disabled while `app.stubbed.includes('edit:color-settings')`, enabled after (2) |
| every spec that compares `app.stubbed` with an exact list (grep `stubbed` in `tests/e2e`) | 0.5's final stub list | every id in `app.stubbed` is an S13.3 or T17.3 id; T17.3's are stubs or real registrations (2) |
| `tests/unit/menu-04.test.mjs`, `menu-05.test.mjs`, `keymap-05.test.mjs` | exact menu or key lists, if any assertion is exact | widened to include T17's items only where a line fails (3) |

Not edited (they hold): skeleton-05's F12 tests (F12 still reverts only outside text fields and type sessions), the
0.3/0.4 proof and gamut specs (T8.2 gives 0.3's pixels without a CMYK profile), the select-mask, modes and channel
specs (T1.8, T3.6 keep their DOM).

**T18.3 Preset kinds** (`registerPresetKinds06()` in `preset-kinds.js`, called after `registerPresetKinds05()`; owners
re-register with full definitions): `select-mask-presets` (selection-tools-depth), `color-settings` (color-settings),
`proof-setups` (soft-proofing), `export-presets` (export-as: saved asset settings), `camera-profiles` and
`raw-workflow-presets` (raw-open-workflow). Each is registered empty, with no built-ins.

**T18.4 Stubs and capability flags.** Each package's MODULES entry is a stub whose `install(app)` calls
`stubCommands(app, ids)` with its T17.3 ids and exports the stub API its file lists; a package replaces its files at the
same paths and keeps every listed export. "Landed" is read from:

| Package | Flag (false or present in the stub) |
|---|---|
| selection-tools-depth | `app.stubbed` lacks `tool:selection-brush`; `LIVEWIRE_REAL` (`livewire.js`) |
| select-menu-finish | `app.stubbed` lacks `select:quick-mask-options` |
| channels-depth | `app.stubbed` lacks `channel:new-spot` |
| smart-filters-depth | `app.stubbed` lacks `layer:smart-filter-mask` |
| history-panel-depth | `HISTORY_FEATURES.tree` (`lib/history-states.js`) |
| color-settings | `app.stubbed` lacks `edit:color-settings` |
| soft-proofing | `PROOF_FEATURES.real` (`lib/color/proof.js`) |
| metadata-io | `METADATA_FEATURES.provider` (`lib/metadata-store.js`) |
| psd-document | `psdFeatures().paths` (and `.guidesGrid`, `.alphaChannels`, `.spotChannels`, `.deep16`, `.deep32`, `.modes`, `.psb`, `.psdt`) |
| export-as | `app.stubbed` lacks `file:export-preferences` |
| save-options-common-formats | `SAVE_OPTION_FEATURES.panel` (`lib/save-options.js`) |
| file-handling-autosave | `app.stubbed` lacks `file:open-as` |
| type-opentype-glyphs | `app.stubbed` lacks `type:opentype` |
| raw-open-workflow | `RAW_FEATURES.decoder` (`lib/raw/workflow.js`) |
| pdf-import | `PDF_FEATURES.import` (`lib/pdf/import.js`) |
| view-navigation | `VIEW_FEATURES.motion` (`lib/view-motion.js`) |

### Packages

Ports 8851–8866 in this order. The brief's feature list is each package's scope; a section adds what the contract
decides: files, what it provides, how it builds before a partner lands, tests, the paths of rules 13 and 16 that bite,
and "done". **Landing order** (every package builds against the stubs; the order only decides which landed partner a
later package's checks can already see): sequence A — history-panel-depth, selection-tools-depth, select-menu-finish,
channels-depth, smart-filters-depth, pdf-import, type-opentype-glyphs, view-navigation; sequence B — color-settings,
soft-proofing, metadata-io, psd-document, save-options-common-formats, export-as, file-handling-autosave,
raw-open-workflow. Two packages run at a time, one from each sequence.

#### 1. selection-tools-depth (8851, entry `lib/tools/selection-brush.js`)
**Owns** `lib/tools/select.js`, `selection-brush.js`, `lib/select-mask/workspace.js`, `preview.js`, `engine.js` (after
the skeleton), new `lib/select-mask/presets.js`, `src/shared/pixels/livewire.js`, `quick-select.js`. **Delivers** T1.2's
outline drags and nudges, T1.3's options (marquee styles with Space repositioning through `takeSpace`, the lassos with
live-wire, Quick Selection as edge-aware region growing with Enhance Edge, Wand sample size, the Selection Brush), the
E57 buttons, T1.8 (presets on `select-mask-presets`, Remember Settings, reduced preview, Real-time Refinement).
**Provides** E58's live-wire API (pen-paths, 0.7), E56. **Same release** Select Subject runs whatever segmenter is
registered (the heuristic). **Tests** unit `selection-tools-depth.test.mjs` (live-wire paths on synthetic edges,
quick-select growth stops at an edge, sample-size seeds), e2e `selection-tools-depth.spec.mjs` (drag inside moves the
outline and the layer's pixels stay; arrows nudge with one entry each; Fixed Ratio and Fixed Size; Space repositions
mid-drag; a magnetic lasso follows a drawn edge; Quick Selection stops at an edge; a preset round trip). **Paths**
undo labels; the Ctrl-held temporary Move tool still moves pixels; Quick Mask on refuses outline moves; select-mask
specs. **Done** `select-mask.spec.mjs` and every 0.5 selection spec green, `LIVEWIRE_REAL` true.

#### 2. select-menu-finish (8852, entries `lib/color-range.js`, `select-modify.js`, `quick-mask.js`)
**Owns** those three (after the skeleton's move), `lib/select-mask.js`, `src/shared/pixels/selection-ops.js`, new
`lib/select-mask/focus-tools.js`. **Delivers** Color Range as a real dialog (sampled colours with + and − eyedroppers
on image and preview, Localized Color Clusters and Range, the six hue ranges, tones, Out of Gamut through
`outOfGamut`, preview modes, Selection / Image toggle, `.axt` load and save, inside an existing selection), the
`registerColorRangeKind` registry (E60), Modify's Apply effect at canvas bounds, Quick Mask Options, history and its
channel row (E63), Focus Area brushes, Hand, Zoom and view modes. **Same release** Out of Gamut uses the stub gamut
test until soft-proofing lands; the Quick Mask row shows in 0.5's panel through the skeleton's `channelRows` call.
**Tests** unit (localized clusters, hue-dominance masks, canvas-bounds contraction), e2e `select-menu-finish.spec.mjs`
(Color Range add and subtract samples, inside a selection, replay of the 0.5 argument and of the 0.6 one; Quick Mask
options inverted; Focus Area add brush). **Paths** actions replay without dialogs; 16/32-bit sample the proxy;
modes (a grey document's colour ranges). **Done** every T1.5 argument replays.

#### 3. channels-depth (8853, entries `lib/channel-dialogs.js`, `lib/channel-target.js`)
**Owns** `lib/panels/channels.js` (after the skeleton), `channel-dialogs.js` (after the move), new `channel-target.js`,
`spot-channels.js`. **Delivers** T2's `alpha` and `channel` targets with surfaces and paste, T3.2's three display
stages, T3.4's commands and dialogs, the eyes, reordering, panel options, every T17.3 `channel:*` id, Save and Load
Selection with document and operation choices. **Provides** T3.1 fields to psd-document and save-options-common-formats.
**Same release** psd-document maps the fields whether or not the panel exists. **Tests** unit (surface write-back,
`restrictToTarget`), e2e `channels-depth.spec.mjs` (Brush, Gradient, Gaussian Blur, Levels and Paste on the Red channel
leave green and blue alone; painting an alpha channel then undo; a spot channel's ink shows on screen and not in
`pixel()`; Split and Merge round trip; Ctrl+3 then Ctrl+2; T3.6's DOM). **Paths** undo through surfaces; `.pigment`
fields; CMYK and Lab refusals; 16-bit restriction; Electron menu keys Ctrl+digits. **Done** `modes.spec.mjs` green, every
0.5 brush tool paints an alpha channel.

#### 4. smart-filters-depth (8854, entry `lib/smart-filter-mask.js`)
**Owns** `lib/smart-object.js` (after the skeleton), `lib/panels/layers-filters.js`, new `smart-filter-mask.js`,
`smart-filter-resources.js`, `lib/psd/smart-filters.js`. **Delivers** T5.1–T5.6: the filter mask (from the selection,
an edit target), per-filter blending, drag and Alt-drag through E25, re-editing, resources for Lens Blur, Displace and
the texture filters, the `.pigment` provider, the PSD descriptor mapping and aspect, `layer:smart-filter-mask`.
**Provides** `filterToPsd` / `filterFromPsd`, E68–E69 for 0.7. **Same release** pdf-import's source kind renders through
the skeleton's `SmartLayer.render` change, which this package keeps. **Tests** unit (blend and mask maths of the chain),
e2e `smart-filters-depth.spec.mjs` (a mask hides a blur where black; Multiply 50 % on one filter; Alt-drag copies a filter
to another smart object in one entry; a Lens Blur with a depth channel survives `.pigment` on a fresh document; the PSD
save notice). **Paths** setFilters entries; `cloneLayer` and Duplicate keep masks; actions by layer name and index.
**Done** 0.3's known gaps for Lens Blur, Displace and the texture kinds on smart objects are closed.

#### 5. history-panel-depth (8855, entry `lib/history-states.js`)
**Owns** `lib/history.js`, `lib/panels/history.js` (after the skeleton), new `history-states.js`,
`lib/panels/history-menu.js`. **Delivers** T4.2 (tree, `states`, `jump`, `deleteState`, `clearStates`), T4.4 (source,
set from the panel's left column, captured on choice), T4.5 (snapshots From Full Document / Merged Layers / Current
Layer, dialog, first snapshot, snapshot on save, New Document from a state or snapshot), T4.6 copy-on-write if it
chooses, T4.7 options, every `history:*` id, Fill › History through the source. **Provides** E65–E67. **Tests** unit
`history-tree.test.mjs` (branching, jump, trimming with branches, merge rules, rollback, dirty on a branch), e2e
`history-panel-depth.spec.mjs` (non-linear: two branches reachable; History Brush from a chosen state; a Full Document
snapshot restores layers; snapshot on save; Current Layer snapshot; memory refusal offers Merged Layers; T4.8's DOM).
**Paths** every recording API through the tree (a stroke, a structural change, a slider merge, a type session, a
smart object's `mark` / `rollback`); 16/32-bit snapshots; budget. **Done** `hunt4-sessions.spec.mjs` and every
history-reading spec green with non-linear history both off and on (one CI run each).

#### 6. color-settings (8856, entries `lib/color/settings.js`, `lib/color/convert.js`)
**Owns** `lib/color/cmm.js`, `profiles.js`, `doc-profile.js` (icc-engine's), `lib/modes.js`, `lib/adjust-more-ui.js`,
new `settings.js`, `convert.js`, `lut-icc.js`. **Delivers** T7.1 (dialog, presets, `setWorkingSpaces`), T7.2's engine
members, T7.3 (open hook, paste policy), T7.4 (Convert to Profile basic and advanced, modes through profiles), T7.5's
`gray` and `web` readouts, T7.6. **Provides** CMYK, Gray and proof transforms in the engine for soft-proofing.
**Same release** soft-proofing builds on the stubs and on icc-engine's transforms. **Tests** unit (transform round trips
in Node when the wasm loads there; policy decisions), e2e `color-settings.spec.mjs` (a mismatched PNG asks and converts;
non-interactive Batch converts silently; Convert to Profile of a 16-bit document and undo; working CMYK numbers in Info
and the picker change with the profile; a paste from a P3 document is converted). **Paths** untagged documents stay
byte-identical; actions replay Convert with the profile's bytes; Electron's system profiles. **Done** S6.4's targets
still met with a CMYK proof active (with soft-proofing).

#### 7. soft-proofing (8857, entry `lib/color/proof.js`)
**Owns** `lib/color-modes.js`, new `proof.js`, `src/shared/pixels/color-blind.js`. **Delivers** T8: conditions, Custom
dialog, presets and saved setups, the two display stages over S6.4's damage, the gamut test, `proofConvertCanvas`, the
`transparency-gamut` section, the `proof` readout. **Same release** without color-settings' CMYK transforms the stages
give 0.3's naive proof; with them the real one. **Tests** unit (colour-blind simulation numbers), e2e
`soft-proofing.spec.mjs` (a proof stage converts the damage only; Gamut Warning colour and opacity; a plate preset shows
one ink; the browser build without an engine shows 0.3's pixels). **Paths** per-view conditions with two documents;
the view's canvas swap (S6.4). **Done** the 0.3 proof specs green and Proof Setup radios in the native menu.

#### 8. metadata-io (8858, entry `lib/metadata-store.js`)
**Owns** `lib/file-info.js`, new `metadata-store.js`, `src/shared/metadata/exif.js`, `xmp.js`, `iptc.js`. **Delivers**
T9.2–T9.6: the store, the provider, orientation, thumbnails, the `.pigment` provider, File Info through the store (the
`writeTo` wrap removed). **Provides** T9.6's functions. **Tests** unit (EXIF parse and write keeping MakerNotes and
unknown tags at byte level; XMP merge; IPTC; orientation), e2e `metadata-io.spec.mjs` (a JPEG built with EXIF and XMP
keeps them through Save As JPEG, PNG, TIFF, WebP and PSD; Export As with each metadata choice; a rotated TIFF opens
upright and saves orientation 1; resolution through every format; Batch keeps camera data). **Paths** the gated
skeleton-05 line (T18.2); `.pigment` round trip; the Image Processor's `withInfo`. **Done** File Info reaches JPEG, PNG,
TIFF and WebP through Save As.

#### 9. psd-document (8859, files loaded by `lib/psd/index.js`)
**Owns** `lib/psd/resources.js`, `channels.js`, `deep.js`, `modes.js`. **Delivers** T10.1 through T10.2's registries
and T10.3's helpers, the save notices, PSB and PSDT. **Tests** unit (each resource both ways on ag-psd objects and
bytes), e2e `psd-document.spec.mjs` (guides and grid; a saved path, the work path and a clipping path; alpha and spot
channels with their DisplayInfo; 16-bit and 32-bit layer pixels within 1/65535 and exactly; Grayscale, Indexed and
Bitmap kept; a PSB above 30 000 px wide refused at the canvas limit with a message; a PSDT opens untitled).
**Paths** the 0.5 PSD goldens while the flags are false; mode documents through `modeRendered`; the packaged bundle.
**Done** `psdFeatures()` flags true and the two 0.5 toasts gone.

#### 10. export-as (8860, entry `lib/export/prefs.js`)
**Owns** `lib/file-ops.js`, `lib/layers-extras/export.js`, new `lib/export/dialog.js`, `assets.js`, `prefs.js`.
**Delivers** T11.4: the dialog, assets with scales and suffixes, the preview, Quick Export by preference, Layers to
Files with PSD and nesting, per-layer Export As, the `export` section, `export-presets`. **Same release** the metadata
choice reaches files once metadata-io lands (until then `'none'` is what 0.5 writes anyway). **Tests** e2e
`export-as.spec.mjs` (three scales with suffixes write three files; canvas size; Convert to sRGB on a P3 document;
Quick Export as JPEG next to the document; Layers to Files as PSD; 0.4's recorded `file:export` arguments replay).
**Paths** chunks exactly once; 16-bit PNG; actions. **Done** every 0.4/0.5 export spec green.

#### 11. save-options-common-formats (8861, entry `lib/save-options.js`)
**Owns** `src/shared/pixels/tiff.js`, `png.js`, new `save-options.js`, `jpeg-encode.js`, `bmp.js`, `ico.js`.
**Delivers** T11.1–T11.3 and T10.5 (layered TIFF), TIFF read depth (JPEG-in-TIFF, YCbCr, Lab, pages, pyramid, byte
order), BMP and ICO / CUR read and write. **Same release** Use Proof Setup uses the stub proof conversion until
soft-proofing lands; alpha and spot channels come from T3.1 whatever the panel. **Tests** unit (JPEG encoder against the
browser's decoder; BMP and ICO round trips; TIFF variants built in the test), e2e `save-options-common-formats.spec.mjs`
(As a Copy keeps the path and dirty state; Layers off flattens; a layered TIFF reopens with its layers; progressive
JPEG; PNG interlaced; WebP lossless). **Paths** default options keep 0.5's bytes; 16-bit TIFF and PNG; save with
`ask: false` (Batch, close-save). **Done** `hunt2.spec.mjs`' JPEG quality test and the S12.3 specs green.

#### 12. file-handling-autosave (8862, entry `lib/file-handling.js`)
**Owns** `file-handling.js` (after the move), new `recovery.js`, `versions.js`, `file-watch.js`, `src/main/share.js`.
**Delivers** T12.1's Open As, T12.2–T12.4, Share, the `file-recovery` section. **Tests** unit (recovery index and naming),
e2e `file-handling-autosave.spec.mjs` (a recovery file is written after the interval with fake timers and offered on a
restart of the page; Revert is one entry and undoes; a changed file reloads a clean document; Open As forces the PNG
reader on a misnamed file; a version restores), electron `file-handling.spec.mjs` (recovery folder under userData).
**Paths** the gated hunt2 line; quitting with dirty documents removes nothing; the browser bridge. **Done** recovery
survives a killed renderer in the Electron spec.

#### 13. type-opentype-glyphs (8863, entries `lib/type/features.js`, `lib/panels/glyphs.js`)
**Owns** those, new `lib/type/alternates-popup.js`, `lib/psd/text-features.js`. **Delivers** T13.2–T13.4.
**Tests** unit (GSUB alternate lookup on the OFL test font, catalogue patches), e2e `type-opentype-glyphs.spec.mjs` (with
the OFL fixture font: Discretionary Ligatures changes the shaped glyphs; a disabled button for a missing feature; Glyphs
panel insertion inside a session; an alternate through `salt`; PSD round trip of ligatures and fractions; `.pigment`).
**Paths** the Canvas engine message; type sessions' own undo. **Done** the type specs green.

#### 14. raw-open-workflow (8864, entry `lib/raw/workflow.js`)
**Owns** `lib/develop-ui.js`, `lib/develop/workspace.js`, `package.json` and `package-lock.json` (after the skeleton),
new `lib/raw/decode.js`, `session.js`, `workflow.js`, `src/shared/pixels/develop-linear.js`, `scripts/vendor/libraw.mjs`,
`src/renderer/vendor/libraw/`. **Delivers** T14. **Same release** sidecar `.xmp` through the skeleton's facade;
metadata through `setMetadata`. **Tests** unit (`develop-linear` numbers: exposure stops on linear planes, camera matrix
interpolation; the display path equal to `develop-04.mjs`), e2e `raw-open-workflow.spec.mjs` (a small DNG built in the
test opens through the workspace; Done writes a sidecar and opens nothing; Open Object makes a `raw` smart object that
re-edits; two files share one session with a filmstrip; Batch opens without UI), electron `raw.spec.mjs` (the wasm loads
from the unpacked folder). **Paths** CSP and asar; 16-bit output; actions. **Done** RAW_FEATURES.decoder true in the
packaged app on all three CI platforms, licence files shipped.

#### 15. pdf-import (8865, entry `lib/pdf/import.js`)
**Owns** `import.js`, new `smart-source.js`, `scripts/vendor/pdfjs.mjs`, `src/renderer/vendor/pdfjs/`. **Delivers**
T15. **Same release** the source kind runs on the skeleton's render change, kept by smart-filters-depth. **Tests** e2e
`pdf-import.spec.mjs` (a two-page PDF built in the test opens page 2 at 150 ppi; Images mode; a placed page stays sharp
after a 4× scale; `.pigment` round trip of a placed PDF; a non-interactive open). **Paths** Electron loads the worker
inside the asar; no network. **Done** both builds open the fixture.

#### 16. view-navigation (8866, entry `lib/tools/view-tools.js`)
**Owns** `lib/canvas-view.js`, `lib/panels/navigator.js`, `view-tools.js` (after the move), new `view-motion.js`,
`view-scrollbars.js`. **Delivers** T16. **Tests** unit (zoom steps, flick decay), e2e `view-navigation.spec.mjs` (the
zoom range; Alt+wheel zooms; Ctrl+wheel scrolls sideways; a pinch zooms; a marquee drag past the edge scrolls after
100 ms; R and H; bird's-eye; scroll bars; PageDown). **Paths** every spec that reads `view.zoom` or pans
(`conventions-shortcuts-fields`, `guides-snapping`, `blur-gallery`, `hunt4-layers-automation`); dialogs letting the
canvas through (E15). **Done** the whole suite green with Animated Zoom and Flick Panning on.

### Reliances on 0.5

What a 0.6 package uses that a 0.5 *package* promised; each line is checked against the code when 0.5 is released, in
step 0 of Part 2. A reliance that does not hold is fixed by the skeleton (a facade) or noted here before packages start.

| 0.6 user | 0.5 promise | CONTRACT-05 | Function or field |
|---|---|---|---|
| color-settings, soft-proofing | ICC engine with RGB transforms and profile parsing of every colour space | S6.1 (icc-engine) | `parse` accepts CMYK, Gray and Lab profiles; `transform(from, to, { intent, bpc, format })`; the engine members of 0.5 deviation 18 |
| color-settings | `color-profiles` kind, system profile listing | S6.6, S10.5 (icc-engine) | the kind's `data`, `profiles()` |
| export-as | the `'icc'` provider honours `embedProfile` and `convertTo` | S6.3 (icc-engine) | `opts.embedProfile === false`, `opts.convertTo === 'srgb'` |
| export-as, raw-open-workflow | `toSRGB` converts | S6.5 (icc-engine) | `toSRGB(canvas, doc)` |
| channels-depth | the colour picker with books | S7.1 (color-picker-swatches) | `app.colorPicker.pick({ allowBooks })` |
| skeleton (call sites) | the picker's CMYK fields and the Color panel's CMYK sliders call 0.3's model through identifiable functions | S7.1 (color-picker-swatches) | `rgbToCmyk` / `cmykToRgb` call sites in `color-picker.js`, `color-views.js` |
| type-opentype-glyphs | the face record exposes the HarfBuzz face and its features | S11 (type-fonts keeps `faceFor`) | `faceFor(style).face` (harfbuzzjs `Face`), `.features` (Set) |
| type-opentype-glyphs | `features` reach HarfBuzz per run | 0.4 A, S11 (type-fonts) | `featureList` in `shaper.js` |
| type-opentype-glyphs | the text kind writes and reads style runs in the model's run order | S4, psd-text section | `rec.text.styleRuns`, claim `'text'` |
| raw-open-workflow | the workspace implements `DevelopWorkspace`, its slots, presets and snapshots | S8.2, S8.4 (camera-raw-workspace) | `registerWorkspaceSlot` places, `DevelopWorkspace`, `camera-raw-presets` |
| raw-open-workflow, skeleton | the .xmp reader and writer | S8.4 (camera-raw-workspace) | the names behind T14.5's facade (to be read from `lib/develop/presets.js`) |
| raw-open-workflow | the `profile` stage and the profile browser | S8.4 (camera-raw-workspace) | order 250, `camera-raw-profiles` |
| raw-open-workflow | Optics and Geometry stages with `mapPoint` | S8.1 (camera-raw-panels) | resample stages 50–90 |
| psd-document | the raster-mask aspect and claims | S4.6 (psd-layers) | `claim(layer, 'vector-mask')`, the `raster-mask` re-registration |
| psd-document | Maximize Compatibility's composite | S4.4 (psd-layers' setting) | `settings.psd.maximizeCompatibility` |
| smart-filters-depth | Camera Raw's smart kind with `open` | S8.3 (camera-raw-workspace) | `registerKind('camera-raw', { open })` |
| history-panel-depth | tool presets do not write history | S12.1 (presets-panels) | `setOptions` |
| selection-tools-depth | the brush picker for Quick Selection and the Selection Brush | brush-settings-panel | `app.brushPicker.renderButton(el, tool)` |
| view-navigation | the Eyedropper keeps `sampleAt` and the ring | S12 (color-picker-swatches) | `EyedropperTool.sampleAt`, `this.ring` |
| skeleton | the keymap store's sets and overlays | S9 (skeleton-05; shortcuts-editor writes) | `KeymapStore.set` placement for the T17 keys |

### Tests expected from every 0.6 package

As in 0.5: `tests/unit/<package>.test.mjs` for pure code (numbers checked), `tests/e2e/<package>.spec.mjs` on its port,
`app.spec.mjs`, `skeleton-04/05/06.spec.mjs` and `brush-golden.spec.mjs` green with the package landed, and the whole
suite green on its port. The report lists what was not done, every behaviour change of an existing feature, every
deviation from this contract, every test skipped until a partner lands, the six paths checked (rules 13 and 16), and
the measured cost of anything on the repaint or stroke path.

### Open questions for the reviewers

1. **Smart filters editable in PSD** need smart objects written natively. Move embedded smart objects (PSD kind 500,
   ag-psd's `placedLayer` and `linkedFiles`) from linked-smart-objects (0.7) into smart-filters-depth, or keep T5.6's
   inert aspect and the notice?
2. **A bundled CMYK profile**: ship a freely redistributable one (for example an ECI profile, licence to be checked) as
   the default working CMYK, or leave CMYK on 0.3's model until the user picks a profile?
3. **History Options defaults**: `visibilityUndoable: true` keeps 0.5's recorded eye toggles; Photoshop's default may
   differ by version. Keep?
4. **Snapshots as entries**: clicking a snapshot adds an entry (T4.5) instead of selecting the row. Acceptable?
5. **LibRaw build**: an own emscripten build in CI (reproducible, slower CI) or a pinned prebuilt package (to be vetted)?
6. **Revert without confirmation** once undoable: Photoshop does not ask; 0.5 asked. Keep the question for documents
   whose history the revert would make unreachable in linear mode?
7. **Overscroll default** stays on (0.5's behaviour) although Photoshop's default is off: T16.2.

---

# Part 2: implementation checklist for skeleton-06

The app works after every step. After each step: `npm test` and the specs the step names; after steps 5, 10 and 13
the whole browser suite and the Electron tests. Start: 0.5 as released (roughly 1000 unit, 700 browser and 8 Electron
tests, all green); they stay green, changed only where T18.2 says, in the step it names. Every new skeleton test that
pins a stub's own behaviour reads its package's T18.4 flag and checks the landed behaviour otherwise (rule 11):
`skeleton-06.spec.mjs` keeps an owner map and a `landed(page)` helper as skeleton-05 does (a flag module that does not
exist yet is not imported). Ports: 8850. The skeleton adds about 60 unit tests in 13 files, about 32 browser tests in
`skeleton-06.spec.mjs` and 2 Electron tests in `tests/electron/keys-06.spec.mjs`.

**Step 0. Start state and reliances.** Run the three suites on the released tree and record the counts. Check every
row of "Reliances on 0.5" against the code and write the result (holds / differs, with the real name) into
`docs/0.6/README.md`; a row that differs gets a facade in this checklist's step that uses it, or a note to the owner
package before the round starts. Read the 0.5 integrator's edits of `skeleton-05.spec.mjs` and of the S14.2 lines, and
grep `tests/e2e` for `stubbed` and for `.history-item`, to fix T18.2's line numbers. Confirm T10.4 against the
installed ag-psd. No goldens are recorded: 0.5's brush, PSD and develop goldens cover the paths 0.6's skeleton touches.

**Step 1. Settings, styles, preset kinds.** `defaults.js` (T18.1); fourteen empty stylesheets linked in `index.html`
(`selection-tools`, `select-menu`, `channels`, `smart-filters`, `history`, `color-settings`, `proofing`, `export-as`,
`save-options`, `file-handling`, `glyphs`, `raw`, `pdf-import`, `view-navigation`); `registerPresetKinds06()` (T18.3)
called from `start()`; `extras.js`: the built-in `navigation` section (order 22) with `zoomWithWheel` and
`animatedZoom`, removed from `interface`. Test: `tests/unit/skeleton-06.test.mjs` "settings" (every namespace
declared; `withDefaults` keeps a 0.5 settings object unchanged).

**Step 2. Stubs and moved code.** Every MODULES entry of "New files" as a stub with its T17.3 ids and its stub API; the
MODULES order; moved verbatim and working: `colorRange`/`rangeMask` → `lib/color-range.js`, Modify → `lib/select-modify.js`,
quick mask and its Q listener → `lib/quick-mask.js`, `select:save`/`select:load` → `lib/channel-dialogs.js`,
`file:revert` → `lib/file-handling.js`, Hand / Rotate View / Zoom → `lib/tools/view-tools.js`, `filterRows` →
`lib/panels/layers-filters.js`, the magnetic snap → `src/shared/pixels/livewire.js` (stub with T1.3's API), the Quick
Selection flood → `src/shared/pixels/quick-select.js`; `stubs-later.js` drops its two ids (now `lib/color/settings.js`
and `lib/color/convert.js` stubs); T18.2's `stubbed` lists and the conventions probe. Tests: `skeleton-06.spec.mjs`
"stubs" (every T17.3 id is a disabled stub in `app.stubbed` or a real registration; the moved commands behave as in
0.5: a Color Range replay with 0.5's argument, Feather, Q twice, Save then Load Selection, Revert, `tool:hand`,
`tool:rotate-view`, `tool:zoom`, the smart filter rows' DOM).

**Step 3. Keys, menus, formats, tool plumbing.** `keymap.js` (T17.3's keys; Ctrl+2 leaves `view:zoom-200`; labels,
groups), `menu-template.js` (T17.2; T17.5's ui state read), `src/shared/opentype-features.js` (T13.1),
`src/shared/formats.js` (`psdt`, `pdf`, `ai`, the RAW list), `app.js` ui state keys, `shortcuts.js` (`takeSpace`,
T16.5's letters, the `view:scroll-*` plain keys outside text fields), `tool-traits.js` (`selects`, `autoScrolls`),
`tools.js` (`toolboxDoubleClick`), `char-format.js` (OpenType ▸ in the Character panel menu from
`openTypeMenuItems`). Tests: `tests/unit/keymap-06.test.mjs` (every T17.3 key; no conflict with the 0.5 tables on any
platform through `keyConflicts`; `typeKeyFor` keeps Shift+Ctrl+K as All Caps in a session; Ctrl+2 is no longer
`view:zoom-200`), `tests/unit/menu-06.test.mjs` (every T17.2 item with its command and argument; OpenType items equal the
catalogue; the Proof Setup radios; no accelerator twice), `tests/unit/opentype-features.test.mjs` (patches,
exclusive groups, default-on features), `tests/electron/keys-06.spec.mjs` (Alt+Shift+Ctrl+O reaches `file:open-as` once;
a Proof Setup radio follows `state.proofSetup`), `skeleton-06.spec.mjs` "keys" (R activates Rotate View after the Hand
was the slot's last tool and H the Hand; a fake tool whose `takeSpace` answers true keeps Space from panning;
`app.keymap.keysFor('channel:target-composite')` is Ctrl+2).

**Step 4. Selection and segmenters** (T1.1, T1.2's command, T1.3's `floodFill` sample, T1.6): `selection.js`
(`offset`, `equals`), `select:offset` (registered working in `edit-ops.js`), `selection-ops.js floodFill(…, { sample })`,
`lib/segmenters.js` with the heuristic built-in, and the four call sites. Tests: `tests/unit/segmenters.test.mjs`
(priority, availability, unknown kinds), `tests/unit/selection-06.test.mjs` (offset clipping, sample-size seed means),
`skeleton-06.spec.mjs` "selection" (`select:offset` is one entry that undoes and records; Select Subject's mask equals
0.5's on a fixture through the heuristic; a fake segmenter of priority 10 answers instead).

**Step 5. Edit targets and channel plumbing** (T2, T3.1, T3.3): `lib/edit-target.js` with `mask` and `layer`,
`app.setEditTarget`, `app.ui.target`, `'target:changed'`, the status bar label; the call sites of T2.3 (`paint.js`,
`retouch.js`, `fill.js`, `bucket.js`, `vector.js`, `adjustment-brush.js`, `adjust-ui.js`, `filter-ui.js`, `edit-ops.js`
fill, stroke and paste) and `lib/brush/engine.js`'s `restrict`; `lib/channel-rows.js` and its call in 0.5's panel;
`document.js` channel fields in `describe()`, `readPigment`'s normalisation. Tests: `tests/unit/edit-target.test.mjs`
(order, first answer, `restrictToTarget` on ImageData), `skeleton-06.spec.mjs` "targets" (with a fake `channel` kind
restricting to red: a Brush stroke, a Gradient, Fill, Gaussian Blur, Levels and Paste change red only, each one entry;
a fake `alpha` kind with a surface: a stroke and its undo write the mask array in place; 0.5's mask editing and every
`pixelTarget` caller unchanged; a fake row provider adds a row; the channel fields survive `.pigment`). Whole suite.

**Step 6. History and document states** (T4.1, T4.3, T4.4, T4.6): `history.js` (`source`, `setSource`, `sourcePixels`,
`willWrite` and its calls in `beginStroke` and `pixels`), `lib/doc-state.js`, the three source call sites,
`layer-ops.js setLayerProps`' `visibility` mark, `depth.js`' `willWrite` calls, T18.2's `hunt2-layers` narrowing.
Tests: `skeleton-06.spec.mjs` "history" (`sourcePixels` equals `savedSnapshot` and the History Brush paints as in 0.5;
`captureDocState` and `applyDocState` round trip a 16-bit layered document with a mask, an alpha channel and a smart
object as one entry that undoes; `docStateToDocument`; a spy sees `willWrite` from a stroke, a filter commit and a deep
refresh; a capture over the budget throws `RangeError`).

**Step 7. Smart objects and `.pigment` entries** (T5.1, T5.4's pass-through, T5.5, T6): `lib/source-kinds.js` with
`image` and `document`; `smart-object.js` (`makeSource`, `copySource`, `resolveSource`, `render`'s `draw` and `onReady`,
place readers in `file:place`, the T5.1 fields in `normaliseFilter`, the constructor, `describe`; `injectResources`);
`document.js cloneLayer` copies `filterMask`; `lib/pigment-entries.js` and its two calls in `io.js`; sources through
kinds in `writePigment` / `readPigment` with 0.5's entries still read. Tests: `tests/unit/pigment-entries.test.mjs`,
`tests/unit/source-kinds.test.mjs`, `skeleton-06.spec.mjs` "smart" (a fake vector kind draws with the render matrix at
3×, and an async kind's `onReady` repaints; a fake place reader places its source and `null` cancels silently; a 0.5
`.pigment` with document and image smart objects reopens equal; filter `blend` and `filterMask` survive `.pigment`
and Duplicate Layer while nothing renders them; a fake entry provider round trips and a failing one is an open notice).

**Step 8. Colour** (T7.1–T7.3, T7.5, T8.1's stubs): `pipeline.js` (`setWorkingSpaces`, `workingSpaces`, `toCmyk`,
`fromCmyk`, `toGray`, `fromGray`, `channelPlanesFor`, `convertPixels`, `setDocumentConverter`, `convertDocument`,
`registerColorPolicy`, `colorPolicy`, `currentProof`, `setProof`, `proofTransformFor`, `proofConvertCanvas`,
`outOfGamut`, `setGamutTest`); `lib/info-readouts.js` and `panels/info.js`; the call sites in `color-picker.js`,
`color-views.js`, `edit-ops.js` paste and the Channels panel's planes. Tests: `tests/unit/color-pipeline-06.test.mjs`
(every stub equals 0.3's numbers; an engine member is used when present; 0.5's `{ rgb }` call still works),
`skeleton-06.spec.mjs` "colour" (a fake engine's `toCmyk` reaches the picker's fields, the Color panel and Info; a fake
paste policy converts a paste and `null` cancels it; a fake gamut test drives the picker's alarm and Info's "!"; a
registered readout appears in Info's select).

**Step 9. Metadata containers and the store stub** (T9.1–T9.3): `io-chunks/tiff.js` EXIF read and write,
`io-chunks/psd.js` 1036, `readOrientation`, `chunkSupport`; `decodeImage`'s explicit `imageOrientation`;
`openDocument` fills `doc.metadata` and `orientationApplied`; `lib/metadata-store.js` stub; T18.2's skeleton-05 gate.
Tests: `tests/unit/io-chunks-06.test.mjs` (TIFF EXIF both byte orders with EXIF and GPS sub-IFDs; an empty patch keeps
the bytes; PSD thumbnail; orientation; malformed input never throws), `skeleton-06.spec.mjs` "metadata" (a JPEG with
orientation 6 opens upright with `orientation: 6, orientationApplied: true`; a TIFF with orientation 6 opens as stored
with `orientationApplied: false`; `doc.metadata`'s blocks equal the file's).

**Step 10. PSD byte stages** (T10.2, T10.3, T10.6's gates): `psd/registry.js` (`registerPsdByteStage`,
`registerPsdRawResource`, refused chunk ids), `read.js` and `write.js` pipelines, `lib/psd/bytes.js`, the six import
lines in `psd/index.js` (stub mapper files), the two gated toasts. Tests: `tests/unit/psd-bytes.test.mjs` (sections of
an ag-psd file; resources written and read back; `packBits` round trip; `psdLayerSection` / `psdFromLayerSection`
through `readPsdDocument`), `tests/unit/psd-registry-06.test.mjs` (stage order; 1039 refused), `skeleton-06.spec.mjs`
"psd" (a fake raw resource 2000 round trips; a fake `afterWrite` stage's bytes reach `afterRead`; the 0.5 PSD goldens
unchanged with no stage). Whole suite.

**Step 11. Saving, exporting, opening, file handling** (T11.2, T12.1, T12.3, T12.5): `documents.js` (registration ids
and `'*'`, `saveAs` in `ask`, `asCopy`, `layers`, `useProofSetup`, `embedProfile`; `SAVE_FILTERS` from the formats;
`registerOpenGroup`; `null` and array results; `replaceContent`), `io.js openDocument(…, { as, interactive })`,
`automate/batch.js`, `depth.js` PNG options, `ipc.js` / `preload.cjs` / `bridge.js` (`share`, `tempPath`, the recovery
calls, `'file-changed'`), `src/main/share.js` stub, `app.js` `'app:started'`, T18.2's `hunt2.spec.mjs` gate. Tests:
`skeleton-06.spec.mjs` "files" (a fake `'*'` option answering `asCopy` keeps the path and the dirty state; the `quality`
id replaced by a fake asks once; a fake group takes two paths at once; a reader returning `null` adds nothing, no error,
no recent file; `as` forces a reader; `replaceContent` is one "Revert" entry that undoes; the browser bridge's recovery
calls round trip; Batch opens with `interactive: false`), `keys-06.spec.mjs` (recovery write, list and remove under
userData; `share` answers the stub's result).

**Step 12. The develop input path** (T14.2, T14.5): `developPlanes`, `ctx.input`, `registerRawVariant` in
`develop-stages.js`; `develop.js` imports `develop-linear.js`; the xmp facade in `lib/develop/registry.js`. Tests:
`tests/unit/develop-planes.test.mjs` (display input equals `develop()`; raw input skips the entry conversion; a raw
variant runs for raw input only; `develop-04.mjs` equality kept; the facade answers camera-raw-workspace's functions).

**Step 13. Specs and the full run.** T18.2 checked line by line; `skeleton-06.spec.mjs` complete with every stub
assertion gated on T18.4; all three suites; a headless start-up with no console error or warning; while no package has
landed, `app.stubbed` is exactly T17.3's stub ids (after, each is a stub or a real registration).

**Step 14. Documentation.** Part 1 into ARCHITECTURE.md; `docs/0.6/README.md` naming the packages, ports, the landing
sequences and step 0's reliance results; "The skeleton as landed" for every detail the code forced, as in 0.4 and 0.5.
