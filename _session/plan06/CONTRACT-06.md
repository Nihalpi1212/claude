# Pigment 0.6: the skeleton contract (final, after review)

Two parts. **Part 1** is the text of a new section "## 0.6 features (contracts)" for ARCHITECTURE.md, written for the
sixteen package owners and the skeleton implementer. **Part 2** is the checklist of skeleton-06, file by file, in steps
that keep the app and the suite working.

Names of 0.4 and 0.5 are reused without restating them: rules 1–15 of "Rules for the parallel round", extension points
E1–E55, sections A–O (0.4: C preset store, D document store, E sessions and command flags, H field widgets, L.1/L.2
Properties and Preferences sections, L.9 drop handlers, L.14 type panel sections) and S1–S15 (0.5: S4 PSD mapper
registries, S5 io-chunks, S6 colour pipeline and display stages, S8 develop stages and registry, S9 keymap store, S10
preset files, S11 type, S12 toolbox / save options / open hooks, S15 capability flags). New extension points continue
the numbering (E56–E90); the shared integration points of 0.6 are T1–T18. Paths are relative to `src/renderer/` unless
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

16. **Edit targets and the selection are a sixth path.** Every feature that writes, moves, copies or clears pixels (a
    tool, a filter, an adjustment, a fill, a paste, a stroke, a history paint, the Move tool, Free Transform, Copy,
    Cut, Clear) asks `editTarget(app, { for })` (T2) and honours the selection; it is checked on a colour channel, an
    alpha channel, a layer mask and Quick Mask as well as on a layer, or its docs say why the target refuses it.
    Rule 13's five paths stay: undo and redo, `.pigment` and PSD round trip, actions, 16/32-bit and non-RGB modes,
    Electron.
17. **Third-party code.** Two packages bring third-party code: pdf-import (pdf.js, Apache-2.0) and raw-open-workflow
    (LibRaw, LGPL-2.1, chosen over its CDDL-1.0 option). The skeleton adds the `pdfjs-dist` dependency (T15.1);
    raw-open-workflow owns `package.json` and `package-lock.json` for the round, after the skeleton's entry, for its
    LibRaw build (T14.1). Each vendors through its own E23 step (`scripts/vendor/pdfjs.mjs`,
    `scripts/vendor/libraw.mjs`). Every package that ships third-party data lists it, with licence text, in
    `docs/0.6/<package>.md` for the release notices.
18. **Layer fields travel together; whole-document readers skip helper layers.** A field that rides on a layer
    (`mask`, `filterMask`, `vectorMask`, `deep`, `liveTransform`) is moved, remapped, copied and cloned wherever 0.5
    does it for `mask` (T5.1 names the sites). Every whole-document reader (capture, flatten, save, convert) skips
    `quickMask` and `preview` layers, as 0.5's do.
19. **Display, not composite.** Channel views, spot inks, proof colours and gamut warnings are display stages (S6.4);
    they never enter `compositor.composite()`, so merged sampling, the Info panel's numbers, exports and the `pixel()`
    spec helper read document pixels as in 0.5. A stage whose output changes without a composite (a view toggle, an
    alpha channel stroke) says so through its `key` or `noteDamage` (T3.2, T8.2).
20. **Spec lines the skeleton gates** are listed in T18.2; a package that finds another line pinning a 0.5 behaviour it
    changes does not edit it: it names file and line in its report and the integrator gates it (rule 11).

### Behaviours split across packages (rule 12)

| Behaviour | Half and owner | Other half and owner | Between them |
|---|---|---|---|
| Dragging inside a selection | outline drags and nudges (selection-tools-depth) | the Move tool (move-tool-depth, 0.5) | `select:offset`, `outline-drag.js`, `antsOffset` (T1.2) |
| Select Subject, Object Selection | the tools, buttons, the workspace's calls (selection-tools-depth) | `select:subject`, `select:sky`, Focus Area (select-menu-finish) | segmenters (T1.6) |
| Select and Mask | the workspace, presets, preview (selection-tools-depth) | Focus Area and Color Range hand-offs (select-menu-finish) | `runSelectMask`, `MaskPreview` (T1.5, T1.8) |
| Quick Mask | mode, options, history, target kind, row (select-menu-finish) | the channel kinds and panel (channels-depth) | kind order 50 (T2.1), `registerChannelRows` (T3.3) |
| Editing a colour channel, an alpha channel, a mask | kinds, surfaces, restriction (channels-depth) | tools, filters, fills, Move, Free Transform, clipboard (call sites, skeleton) | `editTarget`, `restrictToTarget` (T2) |
| Filters on a smart object with another target chosen | `intercept` declines (smart-filters-depth; landed by the skeleton) | the kinds (channels-depth, `filter-mask`) | T2.3 |
| Paste into a mask or a channel | the kinds' `paste` (channels-depth) | the paste flow (skeleton) | T2.4 |
| Alpha and spot channels in files | model and UI (channels-depth) | PSD (psd-document), TIFF (save-options-common-formats) | T3.1's fields |
| Spot channels through Image › Mode | conversions keep them (color-settings) | `spot-inks` skips 0.3 plates (channels-depth) | T3.7 |
| Smart filters in PSD | mapping and aspect (smart-filters-depth) | the smart object itself (linked-smart-objects, 0.7) | the `'smart-object'` claim (T5.6) |
| Depth maps, Displace and texture files on smart objects | resources (smart-filters-depth) | the filter kinds (0.3) | `registerFilterResource` (T5.4) |
| History Brush, erase to history, Fill › History | the source per target (history-panel-depth) | the call sites (skeleton; retouch-tools-depth 0.7) | `sourcePixels(target)` (T4.4) |
| Visibility and History | not recording, dirty anyway (history-panel-depth) | the marks (skeleton) | `visibility`, `unrecordedChange` (T4.1, T4.6) |
| Revert and Auto-Update | commands, watching (file-handling-autosave) | `replaceContent`, `openedWith` (skeleton) | T12.3 |
| A reloaded document looks like the opened one | the reload (file-handling-autosave) | hooks with `onReload`: orientation (metadata-io), policy (color-settings); `.psdt` not (psd-document) | `runOpenHooks({ reason })` (T12.3) |
| Snapshots | snapshots (history-panel-depth) | document states (skeleton) | `captureDocState` (T4.3) |
| Working spaces, untagged documents | settings, engine (color-settings) | readers of `workingRGB()` (skeleton) | `setWorkingSpaces` (T7.1) |
| Profile mismatch on open and paste | policy, dialogs (color-settings) | hook runner, paste flow (skeleton) | `registerOpenHook`, `registerColorPolicy` (T7.3) |
| Colours in Convert to Profile | the conversion (color-settings) | each layer type's colours (skeleton built-ins, later types) | `mapColors`, `mapDocumentColors` (T7.4) |
| CMYK, Lab, Gray numbers in the UI | conversions (color-settings) | picker, Color panel, Info (call sites, skeleton) | T7.2, `registerInfoReadout` (T7.5) |
| Proof Colors, Gamut Warning | condition, stages, gamut test (soft-proofing) | engine transforms (color-settings) | `setProofing`, `proofTransform`, `gamutMask` (T8) |
| Use Proof Setup, Out of Gamut | the option, the kind (save-options-common-formats, select-menu-finish) | conversion and test (soft-proofing) | T8.4 |
| Metadata in files | provider, store (metadata-io) | Export As' choice (export-as) | `opts.metadata` (T9.4) |
| Convert to sRGB, Embed Color Profile | the options (export-as) | `'icc'`, `toSRGB` (icc-engine; color-settings' files) | S6.3 |
| EXIF orientation | the hook (metadata-io) | readers' flags, `orientDocument` (skeleton) | T9.3 |
| Layered TIFF | the writer (save-options-common-formats) | the PSD layer section (skeleton) | `psdLayerSection` (T10.5) |
| Native PSD modes and depths | stages claiming them (psd-document) | 0.4's emulation and toasts (skeleton) | `writesMode` / `writesDepth` (T10.2) |
| Save As options | panel, dialogs, field specs (save-options-common-formats) | save flow (skeleton); export fields (export-as) | `'*'`, `holds`, `in` (T11.2) |
| RAW files | decoding, session, white balance (raw-open-workflow) | develop stages, workspace (0.5) | `developPlanes`, `ctx.input`, `ws.input` (T14) |
| RAW sidecar, camera data | sidecar, EXIF in (raw-open-workflow) | crs: mapping (0.5); storing and writing (metadata-io) | facade `{ input }` (T14.5), `setMetadata` (T9.2) |
| Placed PDF stays sharp, also in saves | the kind, `prepare`, `raster` (pdf-import) | `SmartLayer.render`, synchronous readers (skeleton) | `settleSmartSources` (T6) |
| OpenType features and PSD | catalogue use, UI, glyphs, aspect, wrapper (type-opentype-glyphs) | shaping, the text kind (type-fonts, psd-text, 0.5) | CharStyle `features`, T13.4 |
| Edge auto-scroll | scrolling (view-navigation) | the tools (opt-out trait) | `autoScrolls` (T16.3) |
| Space during a gesture | repositioning (selection-tools-depth) | key routing (skeleton) | `takeSpace` (T1.4) |
| Channel keys, H and R | the commands and tools (channels-depth, view-navigation) | bindings, letters (skeleton) | T16.5, T17 |
| UI state for menus | each owner's keys | `syncUiState` (skeleton) | `registerUiState` (T17.5) |

### Ownership of existing files

Every existing file 0.6 changes (0.5's new files included). "skeleton" means skeleton-06 makes all of 0.6's changes
there and no package edits it afterwards. Column "Plug in" says what the skeleton lands first in a package-owned file,
or which extension point the other packages use instead of editing it. Every skeleton call site placed in a file
another package owns carries a marker comment naming the T-section, as in rule 10.

| File | Owner | What the owner changes | Plug in |
|---|---|---|---|
| `app.js` | skeleton | MODULES; `'app:started'` (T12.4); `file:revert` moves out; `registerUiState` (T17.5); `editTarget`, `setEditTarget` (T2) | E62, E81, E87 |
| `lib/edit-ops.js` | skeleton | the moves of T1.7, T3.5; `pixelTarget` → `editTarget` (alias kept); copy, cut, clear, fill, stroke, paste through the target (T2.3, T2.4) and paste's policy (T7.3); Fill › History (T4.4); `select:offset` (T1.2) | E62, E65, E72 |
| `lib/selection.js` | skeleton | `offset`, `equals` (T1.1) | E56 |
| `lib/layer-ops.js` | skeleton | `visibility` marks (T4.1); `cloneLayer`'s filter mask (T5.1); Rasterize settles (T6) | E65 (move-tool-depth's markers stay) |
| `lib/image-ops.js`, `lib/layer-move.js` | skeleton | the filter mask in remaps, `shallow()`, Free Transform and moves (T5.1); Free Transform's target (T2.3); `orientDocument` (T9.3) | E88 |
| `lib/tools/move.js` | skeleton | press and nudge through `editTarget` (T2.3) | E62 |
| `src/shared/pixels/selection-ops.js` | select-menu-finish | localized clusters, hue-dominance ranges, `canvasBounds` | skeleton lands first: `floodFill(…, { sample })` (T1.3) |
| `lib/tools/select.js` | selection-tools-depth | marquee styles, outline drags and nudges, live-wire lassos, Quick Selection, Wand sample size | skeleton lands first: snap and flood moved to `livewire.js`, `quick-select.js` (T1.3); keeps `applySelection`, `COMBINE_OPTION`, the classes' exports, the snap calls |
| `lib/tools/object-select.js` | skeleton | `segment('object', …)` (T1.6); the `outline-drag.js` calls (T1.2) | E56, E59 |
| `lib/select-mask.js` | select-menu-finish | Focus Area brushes and views; Subject / Sky through segmenters | skeleton lands first: the `segment()` calls; `select:select-mask` → `runSelectMask` (T1.5) |
| `lib/select-mask/workspace.js`, `preview.js` | selection-tools-depth | tool options, brush picker, preview quality, presets, Remember Settings | skeleton lands first: `runSelectMask`, two `segment()` calls (T1.5, T1.6); keeps T1.8's exports and the DOM `select-mask.spec` drives |
| `lib/panels/channels.js` | channels-depth | eyes, targets, reorder, Channel Options, spot channels, shortcuts, panel menu | skeleton lands first: `channelRows(doc)` (T3.3); keeps T3.6's DOM |
| `lib/panels/layers.js` | skeleton | `filterRows` moves out (T5.3); thumbnails through `setEditTarget` and `app.ui.target` (T2.2) | E25, E68 |
| `lib/smart-object.js` | smart-filters-depth | filter mask, blending, resources, drag, re-edit, PSD hand-off | skeleton lands first: T6's conversions, T5.1's fields, `injectResources` (T5.4), `intercept`'s decline (T2.3) |
| `lib/layers-extras/structure.js`, `lib/print.js` | skeleton | Convert to Layers through `toDocument`; Print settles (T6) | E70 |
| `lib/history.js` | history-panel-depth | tree, snapshots, options, source, delete, Clear History | skeleton lands first: `source`, `sourcePixels`, `capture`, `group`'s mark (T4); keeps T4.1's members |
| `lib/panels/history.js` | history-panel-depth | source column, New Snapshot dialog, History Options, panel menu | keeps T4.8's DOM |
| `lib/tools/paint.js`, `retouch.js`, `fill.js`, `bucket.js`, `adjustment-brush.js`, `vector.js`, `lib/brush/engine.js` | skeleton | T2.3's presses, strokes and fills; History Brush and erase-to-history (T4.4) | E62, E65 |
| `lib/adjust-ui.js`, `lib/filter-ui.js` | skeleton | `beginPixelEdit` through the target and `restrictToTarget` (T2.3) | E62 |
| `lib/depth.js` | skeleton | helpers move to `lib/export-pixels.js`; 16-bit PNG through `encodeForPath` (T11.1); TIFF test without RAW (T12.1); 8-bit toast on `psdWritesDepth` (T10.6) | E77, E78 |
| `lib/io.js` | skeleton | entry providers (T5.5); sources through kinds (T6); channel fields (T3.1); `openDocument` and the reader choice (T9.3, T12.1); `writePigment` options (T12.4); `exportImage` / `encodeForPath` (T11.4); `.psdt` (T10.6) | E70, E71, E80, E88 |
| `lib/document.js` | skeleton | `metadata`, `modeProfile`, `openedWith` (T9.2, T7.2, T12.1); channel fields (T3.1); `mapColors` (T7.4) | E68, E76, E89 |
| `lib/documents.js` | skeleton | save options, `holds`, `'copy'`, `'doc:saved-copy'` (T11.2); open groups, `'doc:ready'` (T12.1); `replaceContent`, reload (T12.3); the RGB toast (T10.6) | E78, E80, E81, E88 |
| `lib/automate/batch.js` | skeleton | `interactive: false`, `markSaved` after the hooks, `'doc:ready'` (T12.1) | E80, E88 |
| `lib/io-chunks.js`, `lib/io-chunks/*.js` | skeleton | T9.1 | E76 |
| `lib/file-info.js` | metadata-io | through the store; the `writeTo` wrap and `stampPsd` removed | keeps `xmpPacket`, `parseXmp`, `readExif`, `describeExif`, `normaliseInfo`, `hasInfo`, `app.fileInfo.withInfo` |
| `lib/file-ops.js`, `lib/layers-extras/export.js` | export-as | Export As, Quick Export, Layers to Files, per-layer Export As | keeps `properties()`, the command ids and replay arguments (T11.4) |
| `lib/psd/registry.js`, `read.js`, `write.js`, `index.js`, `builtin.js` | skeleton | T10.2; the 0.6 mapper imports | E40, E77 |
| `scripts/vendor-entries/ag-psd-fixes.js` | skeleton | imports `ag-psd-text-features.js` (T13.4) | S4.5 |
| `lib/color/pipeline.js` | skeleton | T7, T8's pipeline members | E72–E74 |
| `lib/color/cmm.js`, `profiles.js`, `doc-profile.js`, `scripts/vendor/lcms2.mjs`, `src/renderer/vendor/lcms2/` | color-settings | CMYK, Gray, Lab, proof and gamut transforms, device links, abstract profiles, the lcms2 exports | keeps S6.1 and icc-engine's exports |
| `lib/color-modes.js` | soft-proofing | `view:proof` / `view:gamut` on stages; `postProcess` goes | T8 |
| `lib/modes.js` | color-settings | `image:mode` through profiles (T7.4); spot channels kept (T3.7) | |
| `lib/adjust-more-ui.js` | color-settings | Color Lookup profiles; Export Color Lookup Tables | |
| `lib/color-picker.js`, `lib/panels/color.js`, `color-views.js` | skeleton | CMYK through `toCmyk`/`fromCmyk`, the alarm through `outOfGamut` | E73, E74 |
| `lib/panels/info.js` | skeleton | readouts as `registerInfoReadout` built-ins | E75 |
| `lib/extras.js` | skeleton | the `navigation` section (T18.1); New Document's sRGB (T7.1) | E20 |
| `lib/type/char-format.js` | skeleton | OpenType ▸ in the Character panel menu (T13.2) | E83 |
| `lib/develop-ui.js`, `lib/develop/workspace.js`, `white-balance.js`, `presets.js` | raw-open-workflow | the RAW session, `ws.input`, raw white balance (T14.4) | keeps camera-raw-workspace's exports, S8.3's DOM, E47's slots |
| `src/shared/pixels/develop.js`, `develop-stages.js`, `lib/develop/registry.js` | skeleton | T14.2, T14.4's hooks, T14.5 | E84 |
| `lib/canvas-view.js` | view-navigation | T16 | skeleton lands first: `antsOffset`, `freeze`/`thaw`, immediate scrolling (T1.2, T4.4, T16.2); keeps `MIN_ZOOM`/`MAX_ZOOM`, `ZOOM_STEPS`, S2.5/S3.3's pointer contract, S6.4's display path |
| `lib/tools/nav.js` | skeleton | Hand, Rotate View, Zoom move to `view-tools.js`, re-exported | |
| `lib/panels/navigator.js` | view-navigation | region zoom, panel options | keeps the `displayCanvas` call |
| `lib/shortcuts.js`, `lib/tools.js`, `lib/tool-traits.js` | skeleton | T1.4, T16.3, T16.5, T16.7's keys, `toolboxDoubleClick` | E61, E85, E86 |
| `src/shared/pixels/tiff.js`, `png.js` | save-options-common-formats | TIFF read and write depth, layers, alpha; PNG options | keeps every export the tests import |
| `scripts/build-vendor.mjs` | skeleton | `PIGMENT_REQUIRE_VENDOR` (T14.1) | E23 |
| `src/shared/formats.js` | skeleton | `psdt`, `pdf`, `ai`, `RAW_EXTENSIONS` | |
| `src/shared/keymap.js`, `menu-template.js` | skeleton | T17 | E90 |
| `src/shared/defaults.js` | skeleton | T18.1 | rule 5 |
| `src/main/ipc.js`, `src/preload.cjs`, `lib/bridge.js`, `src/main/main.js` | skeleton | T12.5 (main.js: the crash dialog only) | E82 |
| `lib/stubs-later.js` | skeleton | drops `edit:color-settings`, `edit:convert-profile` | |
| `lib/preset-kinds.js` | skeleton | `registerPresetKinds06()` (T18.3) | E5 |
| `index.html` | skeleton | stylesheet links; no import map change | rule 6 |
| `package.json`, `package-lock.json` | raw-open-workflow | LibRaw dependency, `asarUnpack`, `fileAssociations` (T14.1, T14.4) | skeleton lands first: `pdfjs-dist`, any lcms2 change |
| the Pigment release workflow (outside `pigment/`) | raw-open-workflow | `PIGMENT_REQUIRE_VENDOR` (T14.1) | |
| the spec lines of T18.2 | skeleton | gated as listed | |

No 0.6 package edits a file owned by "skeleton" in this table, nor these, which 0.6 does not change: `compositor.js`,
`sessions.js`, `commands.js`, `presets.js`, `doc-store.js`, `temp-tools.js`, `canvas-capture.js`, `sample.js`,
`brush.js` and `lib/brush/*` other than `engine.js`, `lib/select-mask/engine.js`, `output.js`, `ops.js`, `worker.js`,
`lib/psd/text.js` and the other 0.5 mapper files, `lib/type/*` other than the new files, `panels/character.js`,
`panels/properties.js`, `actions.js`, `keymap-store.js`, `preset-formats.js`, `src/main/watch.js`, and
`src/shared/pixels/*` other than `selection-ops.js`, `tiff.js`, `png.js`, `develop.js`, `develop-stages.js` and the new
files. The 0.5 writers of `history.savedIndex` (T4.1) and of `view.hideAnts` stay as they are.

### Where the briefs are wrong about the code

The decisions are binding:

- **Registration is not an edit.** raw-open-workflow and pdf-import do not touch `io.js` (`registerOpenFormat` exists
  since 0.3; the skeleton adds `interactive`, `null` results and open groups); type-opentype-glyphs does not touch
  `panels/character.js` (its OpenType row is an E26 section) nor `type/shaper.js` (CharStyle `features`, a map of
  OpenType tag to value, has reached HarfBuzz through `featureList` since 0.4); raw-open-workflow does not touch the
  workspace for slots (E47's `registerWorkspaceSlot` has `'filmstrip'`, `'footer-start'`, `'footer-end'`; it owns the
  workspace and white-balance files for the RAW entry point, T14.4); psd-document does not touch `psd/registry.js` (it registers
  resources and byte stages); channels-depth does not touch `compositor.js` (channel views and spot inks are display
  stages, rule 19); soft-proofing and type-opentype-glyphs do not touch `main/menu.js` (it re-exports
  `src/shared/menu-template.js`, the skeleton's); color-settings and soft-proofing do not touch `extras.js` (their
  preferences are E20 sections; the colour picker moved out of `extras.js` in 0.5).
- **`edit-ops.js` is split, not shared.** select-menu-finish, channels-depth and history-panel-depth all named it; the
  skeleton moves each one's code into that package's new file verbatim (T1.7, T3.5) and converts the rest (T2, T4.4).
- **Non-linear history does not need stored states.** Undo and redo closures are exact inverses; a tree of entries
  reaches any state by undoing to the common ancestor and redoing down the other branch (T4.2). Only snapshots, the
  captured source and recovery keep document states, through `lib/doc-state.js` (T4.3).
- **Metadata containers are the skeleton's.** metadata-io does not edit `io-chunks.js` nor `tiff.js`: TIFF EXIF, the
  PSD thumbnail and orientation reading land in the skeleton's container code (T9.1); metadata-io decides what is
  written. TIFF orientation is applied by metadata-io's open hook, so `tiff.js` stays save-options-common-formats'.
- **Smart filters cannot stay editable in PSD before smart objects are written natively.** 0.5 writes smart objects as
  pixels (kind 500 is reserved for linked-smart-objects, 0.7). smart-filters-depth delivers the filter descriptor
  mapping and the `smart-filters` aspect, which takes effect once a kind claims `'smart-object'`; until then the save
  notice says the filters are kept in `.pigment` only (T5.6; review decision 11).
- **The Rotate View tool keeps its place in the Hand slot**, as in Photoshop; what is wrong is the letter resolution
  (R activates the slot's last-used tool, and Shift+R finds no slot). The skeleton fixes it in `shortcuts.js` from the
  effective keymap (T16.5); no slot is added.
- **Several files the briefs do not name must change** for their features to hold in every path: `image-ops.js` and
  `layer-move.js` (the filter mask moves with its layer), `tools/move.js` (it must not move the layer for a channel
  target), `layer-ops.js` (`cloneLayer` lives there, not in `document.js`), `print.js` and `layers-extras/structure.js`
  (asynchronous smart sources), `main.js` (the crash dialog). The skeleton makes those changes; no package edits them.
- **Quick Mask stays a hidden layer in 0.6.** Moving it onto the channel target would make select-menu-finish wait for
  channels-depth; it gets options, history, a Channels panel row through `registerChannelRows` (T3.3) and an edit-target
  kind of its own that answers before every channel kind (T2.1).
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
| skeleton | `lib/edit-target.js` (T2), `lib/channel-rows.js` (T3.3), `lib/segmenters.js` (T1.6), `lib/doc-state.js` (T4.3), `lib/source-kinds.js` (T6), `lib/pigment-entries.js` (T5.5), `lib/info-readouts.js` (T7.5), `lib/psd/bytes.js` (T10.3), `lib/export-pixels.js` (T11.1), `src/shared/opentype-features.js` (T13.1), `tests/e2e/skeleton-06.spec.mjs`, `tests/e2e/helpers-06.mjs`, the unit tests of Part 2; the stub files below | none of its own (the registries are plain imports) |
| selection-tools-depth | `src/shared/pixels/livewire.js` (stub: straight segments, T1.3), `src/shared/pixels/quick-select.js` (stub: 0.5's windowed flood moved out of `select.js`), `lib/tools/selection-brush.js` (stub), `lib/tools/outline-drag.js` (stub: every function answers false, T1.2), new `lib/select-mask/presets.js` | `lib/tools/selection-brush.js` (after `lib/tools/select.js`) |
| select-menu-finish | `lib/color-range.js`, `lib/select-modify.js`, `lib/quick-mask.js` (stubs: 0.5's code moved from `edit-ops.js`, working; `quick-mask.js` also registers the `quick-mask` edit-target kind and `app.quickMask`, T1.7), new `lib/select-mask/focus-tools.js` | the three, right after `lib/edit-ops.js` |
| channels-depth | `lib/channel-dialogs.js` (stub: 0.5's `select:save` / `select:load` moved, working; the T17 `channel:*` ids stubbed), `lib/channel-target.js`, `lib/spot-channels.js` (stubs) | `lib/channel-dialogs.js` after `lib/edit-ops.js`; `lib/channel-target.js` in the 0.6 block |
| smart-filters-depth | `lib/panels/layers-filters.js` (stub: 0.5's `filterRows` moved), `lib/smart-filter-mask.js`, `lib/smart-filter-resources.js` (stubs; the latter with the registry, a pass-through `injectResources` and the blob store), `lib/psd/smart-filters.js` (stub, loaded by `lib/psd/index.js`) | `lib/smart-filter-mask.js` |
| history-panel-depth | `lib/history-states.js` (stub: `HISTORY_FEATURES`), `lib/panels/history-menu.js` (stub: the `history:*` ids) | `lib/history-states.js` |
| color-settings | `lib/color/settings.js` (stub: `edit:color-settings`), `lib/color/convert.js` (stub: `edit:convert-profile`), new `lib/color/lut-icc.js` | `lib/color/settings.js`, `lib/color/convert.js` |
| soft-proofing | `lib/color/proof.js` (stub: `view:proof-setup`, `PROOF_FEATURES`), new `src/shared/pixels/color-blind.js` | `lib/color/proof.js` |
| metadata-io | `lib/metadata-store.js` (stub: T9.2's API over raw chunks, `METADATA_FEATURES`), new `src/shared/metadata/exif.js`, `xmp.js`, `iptc.js` | `lib/metadata-store.js` |
| psd-document | `lib/psd/resources.js`, `channels.js`, `deep.js`, `modes.js` (stubs with their `PSD_FEATURES` flags false, loaded by `lib/psd/index.js`) | none |
| export-as | `lib/export/prefs.js` (stub: `file:export-preferences`, `EXPORT_FEATURES`), new `lib/export/dialog.js`, `assets.js` | `lib/export/prefs.js` |
| save-options-common-formats | `lib/save-options.js` (stub: the `'*'` registration answering `{}`, `saveOptionFields` answering `[]`, `SAVE_OPTION_FEATURES`), new `src/shared/pixels/jpeg-encode.js`, `bmp.js`, `ico.js` | `lib/save-options.js` |
| file-handling-autosave | `lib/file-handling.js` (stub: 0.5's `file:revert` moved from `app.js`, working; `file:open-as`, `file:share`, `file:versions` stubbed), `src/main/share.js` (stub, T12.5), new `lib/recovery.js`, `versions.js`, `file-watch.js` | `lib/file-handling.js` |
| type-opentype-glyphs | `lib/type/features.js` (stub: `type:opentype` stubbed, `openTypeMenuItems`), `lib/panels/glyphs.js` (stub: `window:panel-glyphs` stubbed), `lib/psd/text-features.js` (stub, loaded by `lib/psd/index.js`), `scripts/vendor-entries/ag-psd-text-features.js` (stub: `export const patched = false`, T13.4), new `lib/type/alternates-popup.js` | `lib/type/features.js`; `lib/panels/glyphs.js` after `lib/panels/tool-presets.js` |
| raw-open-workflow | `lib/raw/workflow.js` (stub: `RAW_FEATURES`), `src/shared/pixels/develop-linear.js` (stub, empty, imported by `develop.js`), new `lib/raw/decode.js`, `session.js`, `scripts/vendor/libraw.mjs`, `src/renderer/vendor/libraw/` (built) | `lib/raw/workflow.js` |
| pdf-import | `lib/pdf/import.js` (stub: `PDF_FEATURES`), new `lib/pdf/smart-source.js`, `scripts/vendor/pdfjs.mjs`, `src/renderer/vendor/pdfjs/` (built) | `lib/pdf/import.js` |
| view-navigation | `lib/tools/view-tools.js` (stub: 0.5's Hand, Rotate View and Zoom moved from `nav.js`, working; the `view:scroll-*` ids stubbed), `lib/view-motion.js` (stub: `VIEW_FEATURES`), new `lib/view-scrollbars.js` | `lib/tools/view-tools.js` right after `lib/tools/nav.js` |

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

Thirty-five new extension points; the T-section specifies each.

| # | Extension point | Where | Used in 0.6 by | Later users |
|---|---|---|---|---|
| E56 | Selection offsets, outline drags | `lib/selection.js`, `outline-drag.js` (T1.2) | selection-tools-depth | pen-paths, local-models-segmentation |
| E57 | Selection tools' options-bar buttons | E39 slots (T1.3) | selection-tools-depth | local-models-segmentation |
| E58 | Live-wire engine | `livewire.js` (T1.3) | selection-tools-depth | pen-paths |
| E59 | Segmenters | `lib/segmenters.js` (T1.6) | select-menu-finish, selection-tools-depth | local-models-segmentation, neural-filters-local |
| E60 | Color Range kinds | `lib/color-range.js` (T1.5) | select-menu-finish, soft-proofing | local-models-segmentation |
| E61 | Space during a gesture | `tool.takeSpace` (T1.4) | selection-tools-depth | pen-paths, shapes, crop |
| E62 | Edit targets, channel restriction | `lib/edit-target.js` (T2) | channels-depth, select-menu-finish, smart-filters-depth | cmyk-lab-storage, deep-pipeline |
| E63 | Channels panel rows | `lib/channel-rows.js` (T3.3) | select-menu-finish | cmyk-lab-storage |
| E64 | Channel views and spot inks as display stages | S6.4 orders 40–60 (T3.2) | channels-depth | print, cmyk-lab-storage |
| E65 | History tree and source | `lib/history.js` (T4.1–T4.4) | history-panel-depth | retouch-tools-depth, scripting-api, file-info-dialog |
| E66 | Document states | `lib/doc-state.js` (T4.3) | history-panel-depth, color-settings, file-handling-autosave | tile-store, layer-comps |
| E67 | History state capture | `history.capture` (T4.4) | history-panel-depth | retouch-tools-depth, scripting-api |
| E68 | Smart filter fields, filter mask | `lib/smart-object.js` (T5.1–T5.3) | smart-filters-depth | transform-warp-depth, liquify-depth, linked-smart-objects |
| E69 | Filter resources at render time | `registerFilterResource` (T5.4) | smart-filters-depth | liquify-depth |
| E70 | Source kinds, place readers, `settleSmartSources` | `lib/source-kinds.js` (T6) | pdf-import, raw-open-workflow | linked-smart-objects, transform-warp-depth, layer-comps |
| E71 | `.pigment` entry providers | `lib/pigment-entries.js` (T5.5) | smart-filters-depth, metadata-io, file-handling-autosave | notes-count-measurement, frame-animation |
| E72 | Working spaces, options, colour policies | `pipeline.js` (T7.1, T7.3) | color-settings | print, edit-clipboard-finish, cmyk-lab-storage |
| E73 | Device conversions, the mode profile | `toCmyk` … `convertPixels` (T7.2) | color-settings, soft-proofing | cmyk-lab-storage, print |
| E74 | Proofing and gamut tests | `setProofing`, `gamutMask` (T8) | soft-proofing, save-options-common-formats, select-menu-finish | print, info-histogram-properties |
| E75 | Info panel readouts | `lib/info-readouts.js` (T7.5) | color-settings, soft-proofing | info-histogram-properties |
| E76 | Metadata store and chunk kinds | `lib/metadata-store.js`, io-chunks (T9) | metadata-io, export-as, raw-open-workflow, pdf-import | file-info-dialog, pdf-export, home-new-doc-browser, lens-correction-profiles |
| E77 | PSD byte stages, raw resources, byte helpers | `lib/psd/registry.js`, `bytes.js` (T10) | psd-document, save-options-common-formats | layer-comps, artboards-frames, slices-web-export, cmyk-formats-separations |
| E78 | Save As options, `holds`, option field specs | `documents.js`, `registerExportFormat` (T11.2) | save-options-common-formats, psd-document, export-as | formats-more-codecs, save-for-web |
| E79 | Export assets, prepared sources | `lib/export/assets.js`, `exportImage` (T11.4) | export-as | save-for-web, artboards-frames, slices-web-export, layer-comps |
| E80 | Open: forced reader, options, `null`, groups | `openDocument`, `registerOpenGroup` (T12.1) | file-handling-autosave, raw-open-workflow, pdf-import | formats-more-codecs, home-new-doc-browser |
| E81 | Content replacement, `'app:started'` | `replaceContent` (T12.3, T12.4) | file-handling-autosave | print, document-windows |
| E82 | Bridge: share, recovery, file changes | `bridge.js`, `preload.cjs`, `ipc.js` (T12.5) | file-handling-autosave | print, home-new-doc-browser |
| E83 | OpenType catalogue, glyph insertion | `opentype-features.js`, `insertGlyph` (T13) | type-opentype-glyphs | type-styles-prefs, type-international |
| E84 | Develop input space, the RAW session | `developPlanes`, `ctx.input`, `ws.input` (T14) | raw-open-workflow | camera-raw-local, lens-correction-profiles |
| E85 | View motion, zoom range, scrolling, auto-scroll | `view-motion.js`, `canvas-view.js` (T16) | view-navigation | document-windows |
| E86 | Tool letters, held letters | `shortcuts.js` (T16.5) | view-navigation | workspaces-toolbar |
| E87 | UI state providers | `app.registerUiState` (T17.5) | five packages (T17.5) | every package with a menu state |
| E88 | Open lifecycle: `'doc:ready'`, `openedWith`, reload reasons, `orientDocument` | `documents.js`, `io.js`, `image-ops.js` (T9.3, T12) | metadata-io, color-settings, psd-document, history-panel-depth, file-handling-autosave | home-new-doc-browser, linked-smart-objects |
| E89 | Colour mapping | `mapColors`, `mapDocumentColors` (T7.4) | color-settings | edit-clipboard-finish, artboards-frames, cmyk-lab-storage |
| E90 | Default keys by version | `DEFAULTS_SINCE` (T17.4) | skeleton | every release with new keys |

0.4 and 0.5 extension points 0.6 relies on: E5 (preset store), E6 (document store), E7 (widgets), E14 (canvas
capture), E18 (Properties sections), E20 (Preferences sections), E23 (vendor steps), E25 (drop handlers), E26 (type
panel sections), E28 (merged sampling), E29 (tool traits), E39 (options-bar slots), E40 (PSD registries), E42
(chunks), E43 (colour pipeline), E45 (save options), E47 (develop registry and workspace slots), E54 (open hooks), E55
(smart filter kinds).

### Shared integration points

Each point gives the API, the stub skeleton-06 ships so that every package can be built and tested before the others
land, and who completes it.

#### T1. The selection and the selection tools

**T1.1 Model.** The selection stays 0.2's (`doc.selection`, a document-size coverage mask, 255 = selected, with a
cached outline; every change through `app.applySelection(next, mode, label)`, one entry, `savedSelection` kept for
Reselect). The skeleton adds `offset(dx, dy): Selection` (whole pixels; what moves past the canvas is dropped, a known
difference) and `static equals(a, b)`.

**T1.2 Outline moves versus pixel moves (E56).** With a marquee, a lasso, the Magic Wand or Object Selection, no Shift
or Alt and a press inside the selection (coverage ≥ 128), a drag of more than 2 screen px moves the *outline*: the
view draws its cached ants translated (`view.antsOffset = { dx, dy }`, `canvas-view.js`, landed by the skeleton; Shift
constrains to 45°) and the release runs `select:offset { dx, dy }`, the only place `offset()` is computed. A press
without a drag behaves as in 0.5. Quick Selection and the Selection Brush always paint, inside the selection too
(Photoshop). The arrows with any selection tool, a selection and no stroke in progress run `select:offset` by 1 px
(Shift: 10), one entry per press. The gesture is `lib/tools/outline-drag.js` (selection-tools-depth):
`outlineDragDown(tool, p): boolean`, `outlineDragMove`, `outlineDragUp`, `outlineNudge(tool, e): boolean` (stub: false,
so 0.5's handlers run), called by `select.js` and, at the top of its handlers, by `object-select.js` (skeleton, marked
`// outline drag (T1.2)`). Pixels move only with the Move tool (or Ctrl held), as in 0.5. `select:offset` (skeleton,
working): `app.applySelection(doc.selection.offset(dx, dy), 'replace', 'Move Selection')`; recorded; disabled without
a selection or while Quick Mask is on.

**T1.3 Tool options (selection-tools-depth)** in `settings.tools[toolId]`; 0.5's keys keep their meaning.

| Tool (id; slot) | Options |
|---|---|
| `marquee-rect`, `marquee-ellipse` (marquee) | `combine`; `feather` px 0..1000; `antialias` (ellipse); `style` `'normal' \| 'ratio' \| 'size'`; `fixedW`, `fixedH` (0.5 keys); `fixedUnit` `'px' \| 'in' \| 'cm' \| 'mm'` |
| `marquee-row`, `marquee-column` (marquee) | `combine`; `feather` |
| `lasso-free`, `lasso-polygon` (lasso) | `combine`; `feather`; `antialias` |
| `lasso-magnetic` (lasso) | the above; `width` 1..256 px (10); `contrast` 1..100 % (10); `frequency` 0..100 (57); `penPressure` (false) |
| `quick-select` (wand) | `combine` `'replace' \| 'add' \| 'subtract'`; `size` 1..5000 px (30); `hardness`, `spacing`; `sampleMerged`; `enhanceEdge` |
| `wand` (wand) | `combine`; `sample` `'point' \| '3' \| '5' \| '11' \| '31' \| '51' \| '101'`; `tolerance` 0..255 (32); `antialias`; `contiguous`; `sampleMerged` |
| `object-select` (wand) | 0.3's options |
| `selection-brush` (wand; new) | `mode` `'add' \| 'subtract'`; `size`, `hardness`; `overlay`, `overlayColor`, `overlayOpacity` |

The skeleton adds `sample` to `selection-ops.js floodFill` (the seed colour is the mean of that square clipped to the
image; marked). **Options-bar buttons (E57)**: an E39 slot (`place: 'end'`) with "Select Subject" (wand, quick-select,
object-select) and "Select and Mask…" (every selection tool). **Live-wire (E58)**, `src/shared/pixels/livewire.js`
(pure; fixed here because pen-paths reuses it):

```ts
edgeCost(img: ImageDataLike, { scale = 1 } = {}): { width, height, scale,
  tile(tx, ty): Float32Array }            // 256 × 256 cost tiles (0 strong edge .. 1 flat), computed on first use
createLiveWire(costs, { width = 10 /* document px */, contrast = 0.1 /* 0..1 */ } = {}): {
  seed(x, y): void;                       // fixes a point (document px)
  path(x, y): [number, number][];         // minimal-cost path from the last seed, within `width` of the pointer's trail
  snap(x, y): { x, y };                   // the strongest edge within `width`
  setWidth(px): void;                     // pen pressure narrows it
  reset(): void;                          // tiles far from the trail are dropped as it moves on
}
```
The tool divides Contrast by 100 and places anchors itself (Frequency). Stub: the straight segment and 0.5's
gradient-maximum snap, moved out of `select.js`. selection-tools-depth's unit test traces a 6000 × 6000 edge with fewer
than 40 tiles alive. `quick-select.js`: `quickSelect(img, mask, dabs: { x, y, r }[], { subtract, enhanceEdge,
tolerance }) → { mask, rect }` (stub: 0.5's windowed flood fill, moved).

**T1.4 Space during a gesture (E61).** On a Space press outside text fields and dialogs `shortcuts.js` first calls
`app.tools.active?.takeSpace?.(true, event)`; true means no pan, and the release calls `takeSpace(false, event)`. A
tool answers true only during its own drag; the marquee moves the whole rectangle while Space is held. 0.5's tools have
no `takeSpace`.

**T1.5 How the Select menu makes selections.** Every command ends in one `app.applySelection` with Photoshop's label
and records an argument that replays without a dialog; 0.5's arguments keep replaying.

| Command (owner) | Replay argument (0.6) |
|---|---|
| `select:color-range` (select-menu-finish) | `{ select: kind id, samples?: [{ x, y, color }], fuzziness 0..200, localized?, range?: 0..100, invert?, inSelection?, preview? }`; 0.5's `{ select, color, fuzziness, invert }` replays |
| `select:modify`, `-feather`, `-expand`, `-contract`, `-border`, `-smooth` (select-menu-finish) | 0.5's plus `canvasBounds?` |
| `select:focus-area` (select-menu-finish) | 0.3's plus `strokes?: { add: [x, y, r][], subtract: [x, y, r][] }` |
| `select:quick-mask`, `select:quick-mask-options` (select-menu-finish) | none; `{ indicates: 'masked' \| 'selected', color, opacity }` |
| `select:select-mask` (registered in `select-mask.js`, which passes the whole argument to `runSelectMask(app, arg, ctx)` in selection-tools-depth's `workspace.js`) | 0.3's `{ interactive?, mask?, output?, …refine }` plus `preset?: id` (`normaliseRefine` resolves it); the Focus Area hand-off `{ interactive, mask, output }` stays select-menu-finish's |
| `select:subject`, `select:sky` (select-menu-finish) | 0.3's |
| `select:save`, `select:load` (channels-depth) | T3.4 |

**Color Range kinds (E60)**, `lib/color-range.js`: `registerColorRangeKind({ id, label, group: 'colors' | 'tones' |
'special', order, fields?, mask(img, params, ctx): Uint8ClampedArray })`; built-ins: sampled, six hue ranges, three
tones, `out-of-gamut` (T8.4). local-models-segmentation adds Skin Tones and Detect Faces.

**T1.6 Segmenters (E59)**, `lib/segmenters.js` (skeleton):

```ts
registerSegmenter({ id, label, kinds: ('subject' | 'sky' | 'object' | 'focus' | 'people' | 'hair')[], priority,
  available(): boolean, run(img, kind, opts: { rect?, polygon?, sampleAll?, signal? }): Promise<{ mask }> })
segment(app, kind, img | { key }, opts): Promise<{ mask, by, label }>   // highest priority available; { key }: an image the engine holds
segmenters(kind?): def[]
```
The built-in `heuristic` (priority 0) runs 0.3's `segment.js` in the select-mask worker. The skeleton converts
`select-mask.js` (Subject, Sky, Focus Area), `object-select.js` and the workspace's Select Subject and Object Selection
(`select-mask/workspace.js`' two `engine.run` calls) to `segment()` (marked `// segment (lib/segmenters.js)`),
pixel-equal to 0.5; `select-mask/engine.js` does not change. local-models-segmentation (0.9) registers models at
priority 10.

**T1.7 Code that leaves `edit-ops.js`** (skeleton, verbatim, working): `colorRange`, `rangeMask`, `select:color-range`
to `lib/color-range.js`; `modify` and the six Modify commands to `lib/select-modify.js`; quick mask (state, overlay,
`select:quick-mask`, the Q listener) to `lib/quick-mask.js`, which also gets the `quick-mask` target kind (T2.1) and
`app.quickMask = { active(doc), parkedSelection(doc), leave(doc, { apply }) }`; entering saves `app.ui.target`, leaving
restores it. The other Select commands stay.

**T1.8 Select and Mask** (selection-tools-depth): preset kind `select-mask-presets` (`normaliseRefine`'s fields plus
`view`); Remember Settings (`settings.selectionTools.selectMask.remember`: true starts from the last OK'd settings, as
0.3; false from the chosen preset or the defaults); below High Quality Preview a copy of at most 1 MP is refined while a
control moves; Real-time Refinement off refines on release. Both are opt-in `MaskPreview` options (`{ maxPixels }`);
`MaskPreview` keeps its 0.5 API (`new MaskPreview(app, doc, { layer })`, `set({ enabled, view, opacity, onion })`,
`setMask(mask, rect?)`, `setBand`, `destroy()`), `VIEW_MODES` and `VIEW_KEYS`, which Focus Area and Color Range's
previews use; their eyedroppers and brushes take canvas clicks under the dialog through E14 and
`app.dialogs.setCanvasThrough`. The DOM `select-mask.spec.mjs` drives stays.

**T1.9 Paths.** One entry per outline drag, nudge, Color Range, Modify, Quick Mask exit; `.pigment` keeps the selection
and presets live in the store; PSD has no active selection; actions record the commands (not tool drags, 0.3);
16/32-bit and modes sample the 8-bit proxy.

#### T2. Edit targets: what pixel edits write into (E62)

**T2.1 API** (`lib/edit-target.js`, skeleton; Node-safe apart from canvases):

```ts
interface EditTarget {
  kind: 'layer' | 'mask' | 'channel' | 'alpha' | 'quick-mask' | 'filter-mask' | string;
  label: string;                      // "Layer 1", "Layer 1 Mask", "Red", "Red, Green", "Alpha 1", "Quick Mask"
  layer: Layer | ChannelSurface;      // what History entries name
  canvas: HTMLCanvasElement; x: number; y: number;   // where the edit draws, at that document offset
  mask: boolean;                      // a mask-format canvas (alpha = value): brush mode 'mask'
  grey: boolean;                      // colours count by their luminance
  channels: { r, g, b: boolean } | null;   // colour-channel restriction on a layer canvas
  changeKind: 'pixels' | 'mask' | 'channel';   // the `kind` History entries and doc.changed get
  grows: boolean;                     // 'layer' and 'channel': ensureCoverage and BrushStroke.migrate may grow the canvas
  refuses?(op: 'paint' | 'fill' | 'filter' | 'adjust' | 'paste' | 'stroke' | 'transform' | 'move' | 'copy' | 'cut'
    | 'clear'): string | null;        // a refusal toast
  paste?(app, image: { canvas, x, y }, opts: { into, inPlace }): boolean;
  copy?(app, rect): { canvas, x, y }; // grey for masks and alpha, the channel's grey for a colour target
  clear?(app, selection): void;       // masks and alpha fill with the background luminance
}
editTarget(app, { for: op = 'paint', quiet = false, layer = app.doc?.active } = {}): EditTarget | null
registerEditTargetKind(kind, { order, resolve(app, doc, layer, opts): EditTarget | null })   // first answer by order wins
restrictToTarget(target, after, before): void   // keeps `before`'s untargeted channels and alpha (0.4's restrictChannels)
greyOf(colour): colour                          // luminance grey (0.299, 0.587, 0.114)
app.setEditTarget(t: null | { kind, ... })      // any registered kind
app.ui.target                                   // the choice; { kind: 'mask' } keeps app.ui.editingMask in step; 'target:changed'
```
Kinds by order: `quick-mask` (50: while `doc.view.quickMask` is set, its layer's canvas, `grey`, refusing paste, move
and transform; landed by the skeleton in `quick-mask.js`), `mask` (100: 0.4's mask editing), `filter-mask` (120,
smart-filters-depth), `alpha` (150: an alpha or spot channel through a surface, channels-depth), `channel` (200: colour
channels of a raster layer, channels-depth), `layer` (900: a raster layer, with 0.5's group, lock and rasterize
refusals). With the skeleton's three, `editTarget` answers as 0.5's `pixelTarget` and `paintableLayer()` (on Quick Mask
colours count by luminance, which leaves the same selection); `app.pixelTarget` stays an alias.

**T2.2 Choosing it.** The Channels panel, `channel:target` (T17: Ctrl+2 composite, Ctrl+3/4/5 red, green, blue,
Ctrl+6…9 the first four alpha channels, Ctrl+\\ the mask), Shift-click adding colour channels, the Layers panel's
layer, mask and filter-mask thumbnails. The composite or the layer clears `app.ui.target`; activating another layer
keeps a colour-channel choice and drops an alpha or filter-mask one (Photoshop). The layer thumbnail shows as selected
only while `app.ui.target` is null or `layer`. The status bar shows `label`. While Quick Mask is on, its row is the
selected one and clicking another row leaves Quick Mask first.

**T2.3 Call sites** (skeleton, marked `// target (T2)`):

- **Presses.** `paintableLayer()` and the raster check (`rasterizePrompt`) in `StrokeTool.strokeDown`, the DabTool
  presses, `fill.js`, `bucket.js` and `vector.js`' `pixelTarget` become `editTarget(app, { for: 'paint' | 'fill' |
  'stroke' })` (the `layer` kind keeps 0.5's toasts and prompt); `ensureCoverage` and `migrate` run only when
  `target.grows`, so a stroke on Alpha 1 with a text layer active prompts nothing and grows nothing.
- **Strokes and fills.** `strokeTarget`, `baseSettings` (`mode`, `maskValue` and `constrainColor` from luminance when
  `grey`, `settings.restrict = channels`), `lib/brush/engine.js` (restores the untargeted channels of each flushed rect;
  history kind `changeKind`), the DabTool loop, the Gradient, Paint Bucket, `edit:fill`, `edit:stroke`, Stroke and Fill
  Path, where every colour goes through `grey ? greyOf(c) : c` (a red-to-blue gradient on Red writes 76 to 29).
- **Filters and adjustments.** `beginPixelEdit` (base and commit through the target, `restrictToTarget` before the
  entry) and filter runs (`filter-ui.js`). `app.smartFilters.intercept` declines whenever `editTarget(app, { for, quiet:
  true })?.kind` is not `'layer'`, so a filter with an alpha channel or the filter mask targeted edits that target.
- **Move, transform, clipboard.** The Move tool's press and nudge, Free Transform's start and `copyPixels` /
  `clearPixels` ask `{ for: 'move' | 'transform' | 'copy' | 'cut' | 'clear' }` and use the target's `copy` / `clear`.
  `alpha` and `channel` refuse move and transform with "Moving one channel is not available yet" (a known gap in 0.6).
- **Paste** (T2.4). A target whose `refuses(op)` answers shows that text and nothing happens.

**T2.4 Paste into a target.** `paste()` first asks `editTarget(app, { for: 'paste', quiet: true })`; a non-`layer`
target whose `paste` returns true has pasted (one entry "Paste"). The `mask` kind pastes the luminance (centred, in
place for Paste in Place, clipped for Paste Into); channels-depth's kinds do the same for their surfaces.

**T2.5 Channel surfaces** (channels-depth): `{ type: 'channel', channel, canvas /* document size, mask format */,
touch(rect), version }`, made from `ch.mask` on first use and cached per mask array. `touch(rect)` writes the canvas
alpha into `ch.mask`, bumps `version`, calls `doc.view.compositor.noteDamage(rect)` and `doc.view.invalidate()` (no
composite changes, rule 19) and emits `doc.changed('channel', { channel, rect })`, never `'pixels'` or `'mask'`, which
the 0.5 listeners expecting a Layer ignore. History entries name the surface with `kind: 'channel'`; a structural copy
`{ ...ch, name }` shares the array. Nothing else writes `ch.mask` in place.

**T2.6 Depths and modes.** 16/32-bit: edits go to the 8-bit proxy and `depth.js` refreshes `deep` (0.3); a
colour-channel edit loses the untargeted channels' extra precision there (known gap, deep-pipeline 0.9). Masks and alpha
channels stay 8-bit. Grayscale, Duotone, Indexed, Bitmap: one channel is the composite, so `channel` never applies.
CMYK, Lab, Multichannel: a derived channel can be viewed and loaded, but `refuses` edits with "Editing one CMYK or Lab
channel needs real CMYK and Lab storage" until cmyk-lab-storage (0.10); alpha and spot channels are editable in every
mode.

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
`describe().channels` becomes `{ id, name, kind?, spot?, options? }` (a 0.5 reader keeps id and name). Eyes are view
state (`view.channelView`), not saved.

**T3.2 Views (E64)**, display stages (S6.4) registered by channels-depth:

```ts
view.channelView: null | { colour: ('r' | 'g' | 'b' | string)[] /* visible colour channels */,
                           alpha: string[] /* visible alpha and spot ids */, inColor: boolean /* settings.channels.showInColor */ }
```
`channel-view` (order 40): one colour channel grey (tinted with `inColor`), several in their colours; CMYK and Lab show
their derived planes. `alpha-overlay` (50): visible alpha channels in their `options` colour and opacity (alone: grey).
`spot-inks` (60): spot channels as inks over the composite, `solidity` 0 multiplying and 1 covering; it skips `spot.key`
channels while `doc.mode === 'multichannel'`, which 0.3's mode renderer already inks. Proof is 100, gamut 110,
icc-engine 900. Each stage's `key(view)` (T8.2) covers the state it reads (eyes, Show in Color, options, solidity); a
surface stroke reaches the later stages through `noteDamage` (T2.5). The Navigator and thumbnails show the composite.

**T3.3 Row providers (E63)**, `lib/channel-rows.js` (skeleton):

```ts
registerChannelRows({ id, order, rows(doc, app): ChannelRow[] })
interface ChannelRow { id: string; label: string; thumb(doc, w, h): HTMLCanvasElement; selected?: boolean;
  eye?: boolean | null; italic?: boolean; onClick?(e): void; onDblClick?(e): void; menu?(): PopoverItem[] }
channelRows(doc, app): ChannelRow[]
```
0.5's panel (skeleton edit) and channels-depth's render these rows after the saved channels. select-menu-finish
registers `quick-mask` (order 100): an italic, selected "Quick Mask" row while it is on; double-click opens its options.

**T3.4 Commands** (channels-depth; ids in T17): New Channel, New Spot Channel (name, ink through
`app.colorPicker.pick({ allowBooks: true })`, solidity), Channel Options (alpha: name, Color Indicates, colour,
opacity; spot: name, ink, solidity), Duplicate Channel (as, destination document or New, invert), Delete, Merge Spot
Channel (bakes the ink, one structural entry), Split Channels (one Grayscale document per channel, "<name>_Red" …, the
source closes after a confirmation when unsaved), Merge Channels (RGB, CMYK, Lab or Multichannel, sources per channel;
they close), drag to reorder (alpha and spot only), Panel Options. `select:save` grows `{ name, document?: name |
'new', channel?: name | 'new', operation?: 'replace' | 'add' | 'subtract' | 'intersect', invert? }` and `select:load`
`{ document?: name, channel: name, invert, mode }`: names, so a recorded step replays in another session.

**T3.5 Moved code** (skeleton): `select:save`, `select:load` to `lib/channel-dialogs.js`, verbatim and working.

**T3.6 DOM the specs rely on** (kept): `.channels-panel`, `.channel-list .channel-row`, `.layer-name`, `data-channel`
(the 0.3 type for mode rows, the id for saved channels), `.channel-ink` on spot rows, the footer `[data-act="load" |
"save" | "new" | "delete"]`, Ctrl-click loading a row, a click selecting a saved channel (`modes.spec.mjs:546–606,
818`).

**T3.7 Paths.** One entry per command; `.pigment` carries T3.1; PSD is psd-document's, TIFF
save-options-common-formats'; actions by channel name; alpha channels stay 8-bit (Photoshop keeps the document depth: a
known difference); Split and Merge refuse Indexed and Bitmap; Merge to CMYK or Lab builds RGBA through `fromCmyk` /
`fromLab`. **Image › Mode** (`modes.js convert`, color-settings) drops only 0.3's plates (`spot.key`), the extra
channels Bitmap cannot hold and every extra channel for Indexed; it keeps `kind: 'spot'` channels with their ink (0.5
dropped every `spot` channel). cmyk-lab-storage (0.10) adds plane targets, rows and a view stage on the T3.1 model.

#### T4. History: the tree, snapshots, the source, captures

**T4.1 Entries and kept members.** Entries keep 0.2's shape and every recording API stays (`run`, `push`, `pixels`,
`beginStroke`/`endStroke`, `replaceCanvas`, `group`, `merge`, `mark`/`rollback`, `structural`, `setLayerProps`). The
members 0.5 code outside `history.js` reads or writes keep their 0.5 meaning on the current path: `entries`, `index`,
`savedIndex` (assignable: -1 the root is saved, -2 no reachable saved state, n the state after `entries[n]`;
history-panel-depth maps it onto the tree, so the ten 0.5 writers of `-2` stay unchanged), `mark()` (`{ entries,
index, savedIndex, … }`), `trim()`, `onChange`, `limit`, `memoryLimit`, `stroke`, `batch`, `hold`, `savedImage`,
`goTo(index)`, `canUndo`, `canRedo`, `dirty`. New optional field `visibility: true`, set by the skeleton in
`setLayerProps` and `setLayersProps` when every patch is `{ visible }` alone and by `history.group` on a group whose
entries all have it (the eye sweep, Alt-click solo).

**T4.2 Non-linear history** (history-panel-depth). `entries` and `index` are the *current path* and the position on it
(every 0.5 reader is unchanged). With `settings.history.nonLinear`, a new entry made while `index < entries.length - 1`
keeps the redo entries as a branch. Added:

```ts
history.states(): { id, label, parent: string | null, current, onPath, at }[]   // creation order
history.jump(id): void            // undo to the common ancestor, redo down to `id`; one 'history:changed'
history.currentId(); history.savedId()   // dirty = currentId() !== savedId() || unrecordedChange
history.deleteState(id): void     // linear: that state and the later ones; non-linear: its subtree
history.clearStates(): void       // Clear History: entries go, snapshots stay, `dirty` keeps its value
```
No stored states are needed: undo and redo are exact inverses applied along a path. Trimming drops the oldest entry by
creation, with the branches that do not hold the current state. `merge` and `mergeKey` merge only into a current entry
without children; `rollback` removes everything since its `mark`. Clear History must not make an edited document look
saved (0.5's `clear()` sets `savedIndex = -1`). Stub (0.5): linear.

**T4.3 Document states (E66)**, `lib/doc-state.js` (skeleton):

```ts
captureDocState(app, doc, { from = 'document' | 'merged' | 'layer', layer = null } = {}): DocState
   // 'document': every layer but quickMask and preview ones (canvases, masks, filter masks, deep planes copied), the tree,
   //   size, mode, depth, colour table, duotone, profile, modeProfile, channels, paths, store, meta, metadata, and the
   //   selection `app.quickMask.parkedSelection(doc) ?? doc.selection`; after app.deep.sync(doc).
   //   'merged': the flattened image (flattenDeep at 16/32 bits); 'layer': that layer
docStateBytes(state): number
applyDocState(app, doc, state, label): HistoryEntry   // one entry, fresh copies; ends Quick Mask first (leave, apply: false)
docStateToDocument(state, { name }): Document         // New Document from a snapshot or state
mapDocumentColors(doc, fn: (rgb) => rgb): void        // T7.4
```
Copies are made at capture: 0.6 has no copy-on-write (0.5 writes canvases in place outside History, as `move.js`'
shift, `modes.js`' constraint and the Quick Mask layer do; tile-store, 0.10, brings a write barrier). A capture over its
budget throws `RangeError` with the size needed.

**T4.4 The history source (E65) and captures (E67).**

```ts
history.source(): { kind: 'saved' | 'snapshot' | 'state', id: string | null, label: string }
history.setSource(kind, id): void
history.sourcePixels(target: EditTarget): { canvas, x, y } | null
   // 'layer' and 'channel': the source's canvas of that layer (the restriction then applies); 'mask': its mask;
   // 'alpha': the source's channel as a mask-format canvas; a merged source: the merged image; null when missing or
   // of another canvas size (the tool says so, as 0.5)
history.capture(id): Promise<DocState | null>
   // null (with a toast) while app.sessions has an open session, history.stroke is set or Quick Mask is on; else a jump
   // there and back with onChange held and the view frozen (view.freeze()/thaw(), landed by the skeleton), a capture
   // after app.deep.sync, and the current state restored; doc:change listeners see an undo and a redo, as with Ctrl+Z
```
Stub: `{ kind: 'saved' }`, `setSource` does nothing, `sourcePixels` returns 0.4's `savedSnapshot()` at 0, 0 for every
target (0.5 paints the merged image into a mask too), `capture` answers null; the History Brush, Erase to History and
Fill › History, converted by the skeleton, behave as in 0.5. history-panel-depth: the default source is the first
snapshot; a state's left column sets the source through `capture` (in the snapshot budget). retouch-tools-depth (0.7)
reads the same API.

**T4.5 Snapshots** (history-panel-depth). `history.snapshots: { id, name, from, state: DocState | null, canvas, at,
root?: true }[]` (0.4's `{ name, canvas, at }` keep `canvas`). The **first snapshot is virtual** (`root`, no state): the
root state, reached by `jump`, so opening costs nothing; it becomes a DocState only when `trim()` is about to drop the
root entry or New Document from it is chosen, and becomes Merged Layers silently, with a status notice, when that does
not fit. It is added on `'doc:ready'` with `interactive` true (T12.1) and on New. New Snapshot (name, From: Full
Document / Merged Layers / Current Layer; the dialog by option or with Alt), rename, delete, snapshot on save
(`'doc:saved'` only), New Document from a state or snapshot. Clicking a captured snapshot applies it as **one entry
named after it** (Photoshop selects the row instead: a recorded difference). Over the budget the panel offers Merged
Layers, never during open. Snapshots and a captured source share `settings.history.snapshotMemoryMB`, apart from the
entries' `historyMemoryMB`.

**T4.6 Outside readers and visibility.** Quick Mask's reattach listener, depth.js' sync and the panels see a `jump` as
undos and redos. With `visibilityUndoable` off, an entry marked `visibility` is not pushed and
`history.unrecordedChange` is set (in `dirty`, cleared by `markSaved`), so closing after hiding a layer still asks.

**T4.7 History Options** (`settings.history`): `{ autoFirstSnapshot: true, snapshotOnSave: false, newSnapshotDialog:
false, visibilityUndoable: true, nonLinear: false, snapshotMemoryMB: 512 }`; Photoshop's defaults except
`visibilityUndoable` (0.5's recorded eye toggles).

**T4.8 DOM the specs rely on** (kept): `.history-panel`, `.history-snapshots`, `.history-states .history-item` with the
label as text, `.history-item.current`, `.future`, the footer's `[data-act="new-doc" | "snapshot" | "delete"]`.

**T4.9 Paths.** Every 0.5 command records as before; `history:new-snapshot { name, from }` records, the other
`history:*` commands are `record: false`; snapshots live in memory (as Photoshop's); 16/32-bit: Full Document
captures `deep` after the sync, Merged Layers `flattenDeep`. history-tree.test.mjs: the sweep, the solo and one eye in
both settings; Clear History on an edited document stays dirty. The e2e: with the option off, closing after hiding a
layer asks.

#### T5. Smart filters

**T5.1 The entry (E68).** `layer.filters[i] = { kind, params, enabled, blend?: { mode, opacity: 0..1 }, resources?: {
[name]: { blob: string /* content hash */, width, height, channels: 1 | 4, type: 'u8' | 'f32' } } }` (defaults Normal,
1, none) and per smart layer `layer.filterMask: { canvas /* document size, mask format */, enabled, linked, density,
feather } | null`, Photoshop's one filter mask. The skeleton makes `normaliseFilter`, the constructor and `describe`
(`hasFilterMask`, `filterMaskEnabled`, `filterMaskLinked`) keep them, and treats `filterMask` like `mask` (rule 18,
marked `// filter mask (T5.1)`): `image-ops.js`' `remap` (Image Size, Canvas Size, Crop, Rotate, Flip, Trim, Reveal All)
transforms its canvas, `shallow()` copies `{ ...filterMask }`, Free Transform and `layer-move.js` move a linked one,
`layer-ops.js cloneLayer` leaves it out of the JSON clone and copies the canvas. `liveTransform` is plain data.
`filters[0]` runs first (the bottom row).

**T5.2 Render chain** (smart-filters-depth): each enabled filter gives `next = filter(img)`, then `img = blend(img,
next, mode, opacity)`; the filter mask then mixes the unfiltered and filtered renders (density, feather). A selection
active when the first filter is added becomes the mask. The `filter-mask` target (T2.1) lets brushes, filters and
adjustments edit it.

**T5.3 Panel and commands.** `lib/panels/layers-filters.js` (moved by the skeleton): `filterRows(app, layer, { depth,
thumbSize, thumb(layer, kind) }) → DocumentFragment`, mask thumbnail, blending icon (double-click: that filter's
Blending Options), drag and Alt-drag through E25 with MIME `application/x-pigment-smart-filter` (`{ layerId, index |
'all' }`). `layer:smart-filter { id, index: number | 'all', op: 'move' | 'copy', to: layerId, at?: number }` is one
structural entry (`at` indexes the target's `filters`, 0 the bottom row, default the top; the same layer reorders; a
non-smart target converts first). It keeps 0.5's ops and gains `'blend'`. `layer:smart-filter-mask { id?, op: 'add' |
'delete' | 'toggle' | 'link' | 'from-selection' }` (an op string alone: the active layer). Re-editing opens the kind's
dialog or E55 session with the injected params. **DOM** (kept, `smart.spec.mjs:165–169`, `smart2.spec.mjs:87`,
`extras3.spec.mjs:40`): one `.smart-filter-head` and one `.smart-filter-row[data-index]` per filter, `.layer-name`,
`.eye`; the mask thumbnail is `.smart-filter-head .filter-mask-thumb`, never a row.

**T5.4 Resources at render time (E69).** `registerFilterResource(kind, { names, capture(params, { app, doc, layer }) →
Promise<{ [name]: { width, height, channels, data, rect } }>, inject(params, resources, ctx: { origin, width, height,
docWidth, docHeight, matrix }) → params })` in `lib/smart-filter-resources.js`. `capture` gives document-space data and
its `rect`; `applySmartFilter` and `applyToRegion` (skeleton) pass the render context they build, so a depth map is
cropped and resampled to the padded, clipped render rect (stub: pass-through). Registered: Lens Blur (depth map from a
channel, mask or transparency; its opener recomputes the map from `params.source`, so `filters-a-ui.js` is unchanged),
Displace (`params.map` with `data`), Texturizer, Conté Crayon, Glass, Rough Pastels, Underpainting. **Blob store**:
module level, Node-safe, keyed by content hash (`putBlob(data, meta) → hash`, `getBlob(hash)`), so copies share blobs
and files cannot collide; never freed in a session, which keeps undo safe.

**T5.5 `.pigment` entry providers (E71)**, `lib/pigment-entries.js` (skeleton, Node-safe):

```ts
registerPigmentEntries({ id, order,
  write(doc, ctx: { layers, purpose, path }): Promise<{ name, data: Uint8Array, compress? }[]>,   // names under `${id}/`
  read(doc, ctx: { find(name): { data } | null, list(prefix): string[], description }): Promise<void> })
```
Called after `writePigment`'s own entries and after `readPigment` builds the tree; a read failure is an open notice.
Users: `smartfilters/` (masks and `<hash>.bin` once per referenced hash, nested documents too, registered before the
first render), `metadata/` (T9.5), `versions/` (T12.2).

**T5.6 PSD** (`lib/psd/smart-filters.js`): aspect `smart-filters` (order 600) with `filterToPsd(f) → Filter | null`
(ag-psd's typed `Filter`: `FilterVariant & { name, opacity /* percent */, blendMode /* toPsdBlend */, enabled }`) and
`filterFromPsd(f)`, exported for linked-smart-objects. It writes `rec.placedLayer.filter = { enabled, maskEnabled,
maskLinked, maskExtendWithWhite, list }` and `filterEffectsMasks`, only on layers claimed `'smart-object'`. No 0.6 kind
claims it, so smart objects save as pixels and the notice `'smart-filters-pixels'` counts the smart layers with
filters: "N smart objects with smart filters were saved as pixels; their filters stay editable in .pigment files". A
unit test with a fake kind 500 claiming `'smart-object'` round-trips kinds, blend, opacity, enabled and the mask.

**T5.7 What 0.7 uses.** transform-warp-depth's live warp (`layer.liveTransform`, carried as data, rendered before the
filters); liquify-depth's kind through E55 with its mesh as a resource; linked-smart-objects' source kinds and kind 500.

**T5.8 Paths.** One entry per op; mask strokes through History; `.pigment`: T5.1 plus T5.5; actions record `id` and
indices, replayed on the active layer when the id is absent (0.5's `layer:rename` rule); 16/32-bit: 8-bit renders
(0.3).

#### T6. Smart-object source kinds and place readers (E70)

`lib/source-kinds.js` (skeleton; the registry and 0.2's two kinds `image` and `document`, moved out of
`smart-object.js`):

```ts
registerSourceKind(kind, {
  width(src): number; height(src): number;          // base-space size in px
  version(src): string;                             // part of SmartLayer.render's cache key: it changes when an exact render lands
  canvas?(src): HTMLCanvasElement;                  // raster kinds: base-space pixels
  draw?(ctx, src, { matrix, rect }): boolean;       // vector kinds: draw at the size `matrix` gives (ctx offset to rect);
                                                    // false: drew its nearest cached render scaled, the exact one is coming
  prepare?(src, { matrix } | { scale }): Promise<void>;   // the exact render for that matrix or scale is ready afterwards
  raster?(src, scale): HTMLCanvasElement;           // pixels at a scale (after prepare); transform-warp-depth's live warp uses it
  copy(src): src;                                   // New Smart Object via Copy, cloneDocument
  toFiles(src): Promise<{ name, data }[]>;          // .pigment, under smart/<layer id>/
  fromFiles(files, desc): Promise<src>;
  describe(src): object;                            // merged into describe().source
  exportFile?(src): { ext, data };                  // Export Contents writes the embedded file (the PDF, the raw bytes)
  toDocument?(src): Document;                       // Convert to Layers, Edit Contents' fallback; default: one raster layer of raster(src, 1)
  editContents?(app, layer): Promise<void>;         // Edit Contents; absent: toDocument, else "Replace Contents to change this object"
})
registerPlaceReader({ id, extensions, test?(bytes, name),
  read(bytes, { name, path, interactive }): Promise<{ source } | { document } | null> })    // null: cancelled, no error
settleSmartSources(doc): Promise<void>               // every smart layer's prepare() for its current matrix, then a touch
```
When `draw` returns false, the skeleton's `SmartLayer` awaits `prepare` and touches the layer and repaints; the kind's
`version(src)` changes when the exact render lands, so the cache key (which leaves `layer.version` out on purpose)
misses. Every synchronous reader of `render()` gets the exact pixels because the skeleton awaits `settleSmartSources`
first in `encodeForPath`, `exportImage`, `writePigment` (saves, recovery, nested documents), Print (`print.js`),
Rasterize (`layer-ops.js`), Convert to Layers (`layers-extras/structure.js`) and before a smart filter session's first
`render({ full: true })` (`smart-object.js`). The skeleton converts to the kind API (marked `// source kinds (T6)`):
`makeSource`, `copySource`, `resolveSource`, `SmartLayer.render`, Export Contents (`exportFile`, else 0.5's PNG or
`.pigment`), Edit Contents' fallback and write-back (`documentFromImage`), Convert to Layers (`toDocument`),
`sourceFromFile` (place readers first, so Replace Contents tries them too), `file:place`, and `writePigment` /
`readPigment`: 0.5's `smart/<id>.pigment` and `smart/<id>.png` stay readable, and for every kind without `canvas` the
writer also stores `smart/<id>.png` (the last exact render in base space, the longer side capped at 4096 px), which the
reader shows at once and keeps as the permanent fallback, with an open notice, when the kind is not registered or its
`fromFiles` fails; so a 0.5 reader, a build without pdf.js or LibRaw and the time before pdf.js has rendered all show
the image. `decodeImageFile` (Open as Smart Object, Import, Load Files into Stack) passes `interactive: false`, takes
the first document of an array and treats `null` as a cancel. pdf-import registers the kind `pdf` and readers for
`.pdf`, `.ai` (T15.3); raw-open-workflow the kind `raw` (T14.3). linked-smart-objects (0.7) adds linked sources
(`link: { path, mtime, missing }`) and SVG.

#### T7. Colour settings and conversions

**T7.1 Working spaces (E72)**, `lib/color/pipeline.js` (skeleton):

```ts
setWorkingSpaces({ rgb, cmyk = null, gray = null, spot = { dotGain: 20 }, options })   // 0.5's { rgb } still accepted
workingSpaces(): { rgb, cmyk: ColorProfile | null /* null: 0.3's naive model */, gray: ColorProfile | null /* Gray Gamma 2.2 */,
                   spot, options: ConversionOptions }
interface ConversionOptions { intent: 'perceptual' | 'relative' | 'saturation' | 'absolute' /* 'relative' */; bpc /* true */;
  dither /* true */; sceneReferred; desaturateMonitor: number | null; blendRgbGamma: number | null; blendTextGamma: number | null }
```
color-settings owns `settings.colorSettings` (`{ preset, rgb, cmyk, gray, spotDotGain, policies: { rgb, cmyk, gray:
'preserve' | 'convert' | 'off' }, ask: { openMismatch, pasteMismatch, missing }, options }`), the dialog, the presets
(kind `color-settings`; `.csf` is not read) and calls `setWorkingSpaces` at start and on change. Blend-with-gamma values
are kept and shown; the compositor blends encoded numbers until deep-pipeline, and the dialog says so. Working CMYK
stays `null` until the user chooses a profile (review decision 9). **Untagged means the working space** (S6.6, 0.5
deviation 21): when `workingRGB()` is not sRGB, New Document (`extras.js`, marked) stores its sRGB choice as
`doc.profile = SRGB` and offers "Working RGB: <name>" as `null`; replay arguments stay 0.5's under an sRGB working
space.

**T7.2 Device conversions (E73)**, synchronous, in the pipeline, answered by the engine member when present (0.5
deviation 18), else by the stub:

```ts
toCmyk(rgb, doc | null): [c, m, y, k]        // 0..100, through doc.modeProfile ?? workingSpaces().cmyk; stub: rgbToCmyk
fromCmyk(cmyk, doc | null): [r, g, b]       // stub: cmykToRgb
toGray(rgb, doc | null): number; fromGray(k, doc | null): [r, g, b]   // % ink; stub: luma
channelPlanesFor(img, doc): { id, data }[]  // CMYK / Lab / Gray planes of a channel-view document; stub: modes.js channelPlanes
convertPixels(img, from, to, opts?): ImageDataLike   // identity in the stub
setDocumentConverter(fn); convertDocument(app, doc, to, opts): Promise<HistoryEntry | null>   // stub: a toast, null
```
The skeleton converts the picker's and Color panel's CMYK fields and the Info readouts to these (marked).
color-settings adds the members in `cmm.js`, with S6.1's `transform(from, to, { intent, bpc, inFormat, outFormat })`
taking a format per side (`'rgba8' | 'rgba16' | 'rgbaf' | 'cmyk8' | 'cmyk16' | 'gray8' | 'gray16' | 'lab16' | 'labf'`;
`format` stays shorthand for both). **The mode profile**: `doc.modeProfile: ColorProfile | null` (`document.js`) is the
CMYK or Gray profile of the image mode (null: the working one), used by the four conversions and `channelPlanesFor`;
it is in `describe()`, `.pigment`'s `mode.icc`, `DocState` and `replaceContent`'s swap, while the `'icc'` provider keeps
embedding `doc.profile`. A conversion to CMYK leaves RGBA numbers from the device round trip in `doc.profile`.

**T7.3 Policies (E72).** Open: an open hook (order 300, `{ onReload: true }`, before type-fonts' 500) for mismatch
(Preserve / Convert / Discard) and missing profiles (Leave / Assign working / Assign…), answering from the policy with
a notice when not interactive, storing its decision in `doc.openDecisions`, skipping `format` `'raw'` and `'pdf'`.
Paste: `registerColorPolicy({ onPaste(app, doc, image: { canvas, profile }) → Promise<canvas | null> })`, called by
`paste()` with the copy's profile (an internal copy records it; a system image is sRGB); `null` cancels; the stub
returns the canvas (0.5). Place keeps 0.5's behaviour (known gap until linked-smart-objects).

**T7.4 Convert to Profile and modes** (color-settings): `edit:convert-profile { profile, intent, bpc, dither, flatten,
mode? }` (the profile as id, plus base64 bytes when not built in): one entry made of `captureDocState` before and after
(over the budget it offers Flatten), converting raster pixels and `deep` planes (masks untouched) and the colours
layer types and styles expose (adjustment parameters stay); to Gray the document becomes Grayscale, to CMYK a CMYK
document with `doc.modeProfile`; Advanced: device links and abstract profiles. **Colour mapping (E89)**:
`registerLayerType(type, cls, { describe, mapColors(layer, fn) })` with built-ins for the 0.4 and 0.5 types (text runs'
colours, live-shape paints, gradient stops, fill layers) and `mapDocumentColors(doc, fn)`, which also maps J.6's style
colours and gradients (duotone inks and colour tables are not mapped). Later types register theirs;
edit-clipboard-finish (0.7) reuses it. `image:mode` uses the working profiles when they exist; Bitmap refuses.

**T7.5 Info readouts (E75)**, `lib/info-readouts.js` (skeleton): `registerInfoReadout({ id, label, order, rows(sample: {
rgb, alpha, deep? }, doc, view) → [key, text][] })`, `infoReadouts()`; `settings.infoSecondary` keeps the id. Built-ins:
0.5's `cmyk` (with "!" when `outOfGamut`), `lab`, `hsb`; color-settings adds `gray` and `web`, soft-proofing `proof`.

**T7.6 Colour lookups** (color-settings): Color Lookup takes abstract and device-link profiles (sampled into the
params); Export Color Lookup Tables writes `.cube`, `.3dl`, `.csp` and an ICC device link (`lut-icc.js`).

**T7.7 Paths.** Convert and Assign are one entry each; `.pigment` and PSD carry the profile; actions record the
profile; 16/32-bit converts `deep`; Electron lists system profiles, the browser build generated and user ones.

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
Pipeline functions [stubs]: `currentProof(view)` [working CMYK], `setProof(view, condition)` [stored on the view; new
views start from `settings.proof.last`], `proofTransformFor(view)` [null], `proofConvertCanvas(canvas, doc, condition)`
[0.3's `applyProof`], `outOfGamut(rgb, doc, { against: 'proof' | 'cmyk' })` [0.3's `isOutOfCmykGamut`],
`gamutMask(img, doc, { against, rect }) → Uint8Array` (255 = out) [the per-colour stub in a loop], `setGamutTest(fn,
bulk?)`. soft-proofing installs its own with `setProofing({ currentProof, setProof, proofTransformFor,
proofConvertCanvas, outOfGamut, gamutMask? })` from `proof.js install()`; the later registration wins, as with
`setColorEngine`. color-settings' engine adds `proofTransform(from, device, to, { intent, proofIntent, bpc, paperColor,
blackInk, preserveNumbers, gamutCheck, inFormat, outFormat }) → { apply(src, dst, n) }`. Saved setups are the kind
`proof-setups` (`.psf` is not read).

**T8.2 Display.** `color-modes.js`' `postProcess` hook becomes two stages: `proof` (100, while `view:proof`) and `gamut`
(110, `view:gamut`, `settings.proof.gamut = { color, opacity }`). **Stage keys** (skeleton, `pipeline.js`):
`registerDisplayStage` takes an optional `key(view): string`; `toDisplay` keeps per view the chain signature (ids and
keys of the active stages) and gives a stage whose key or activity changed, and every later stage, `damage: 'full'`,
so a toggle that recomposites nothing still reaches icc-engine's stage at 900; `info.original` is the input before
any stage. The proof key hashes the whole condition; the proof stage outputs document-profile numbers (document →
device → document), so the 900 stage stays the only display conversion; the gamut stage tests `info.original`.
`settings.proofColors` and `gamutWarning` stay the toggles. Without an engine or a CMYK profile the stages give 0.3's
pixels. Isolation's wrapper (`layers-extras/find.js`) then wraps a `null` `postProcess`, as expected.

**T8.3 Colour blindness**: `color-blind.js simulate(img, 'protanopia' | 'deuteranopia', rect)` (Viénot–Brettel, linear).

**T8.4 Users:** Gamut Warning, the picker's alarm, Info's "!", Color Range's Out of Gamut, Use Proof Setup on save
(`proofConvertCanvas` of the flattened image), print (0.8: `currentProof`, the engine's proof transform).

**T8.5 Paths.** View state: no entry; `view:proof-setup` is `record: false`; the condition persists in settings and
presets; 16/32-bit display the proxy; the native radios follow `proofSetup` (T17.5).

#### T9. Metadata through open and save (E76)

**T9.1 Containers** (skeleton; `io-chunks` stays the one place that reads and writes the blocks, S5). Added:

- TIFF `exif`: on read, IFD0's descriptive tags (270, 271, 272, 274, 305, 306, 315, 33432) and the EXIF (34665) and
  GPS (34853) sub-IFDs become a standalone TIFF-structured block (JPEG's APP1 form); on write they are replaced from it.
- The TIFF container keeps an unchanged entry's value at its old offset and appends only new or changed values (0.5
  appended a copy of every long value, so a layered TIFF's tag 37724 doubled on every patch).
- `Chunks.thumbnail?: { jpeg, width, height } | null`: PSD 1036 (JPEG's thumbnail is IFD1 inside the EXIF block).
- `readOrientation(chunks): 1..8` (IFD0 tag 274; 1 without one).
- `applyChunks` awaits each `provide()`; `info` gains `{ width, height, depth }`, read from the encoded bytes.
- `thumbnailJpeg(doc, { maxSide = 160, quality = 0.8 }) → Promise<{ jpeg, width, height }>` (`io-chunks.js`).

A kind no provider gives leaves the bytes as they are, so a document without metadata saves as in 0.5.

**T9.2 The store** (`lib/metadata-store.js`, metadata-io; the skeleton's stub has this API):

```ts
doc.metadata: DocMetadata | null      // document.js; null for New
interface DocMetadata {
  exif: Uint8Array | null;            // the TIFF-structured block as read (MakerNotes and unknown tags inside)
  xmp: string | null; iptc: Uint8Array | null;
  orientation: number;                // 1..8
  orientationApplied: boolean;        // the pixels are already upright
  source: { format: string, path: string | null, orientation? } | null;
}
metadataOf(doc): DocMetadata          // an empty one when null
setMetadata(app, doc, patch, { label = null } = {})   // no label: not an edit (open, RAW, PDF import); a label: one entry
exifFields(doc): object               // camera data, 0.3's readExif shape
METADATA_FEATURES = { provider, exif, iptc, thumbnails }     // stub: all false
```
Stub: `openDocument` fills `doc.metadata` from the chunks it reads unless the reader set it (a reader's `metadata`,
`format` and `profile` win; adoption is skipped when the reader set `profile`, and for `format === 'raw'`);
`exifFields` calls 0.3's `readExif`; no provider, and `file-info.js` keeps 0.5's behaviour. File Info's fields stay
`doc.meta` (0.3); metadata-io merges them into XMP and IPTC when writing.

**T9.3 Orientation.** `decodeImage` asks `createImageBitmap` for `imageOrientation: 'from-image'` (explicit now).
`openDocument` sets `orientationApplied: true` on that path, for PSD and PSB (upright whatever 1058 says), for
`.pigment` and for readers declaring `appliesOrientation: true` (a reader that turns its pixels sets the fields too);
`false` for the other readers (TIFF, TGA, PNG-16). metadata-io's open hook (order 200, `{ onReload: true }`) turns a
document with `orientation !== 1 && !orientationApplied` upright through `orientDocument(doc, orientation)`
(`image-ops.js`, skeleton, pure: tree, masks, filter masks, deep planes, guides, paths, selection, flips included, no
history; open hooks only) and sets `orientation: 1, orientationApplied: true`. The hooks run before the document is
ready: `openPaths` and Batch mark it saved again after them and emit `'doc:ready'` (T12.1), where the saved image, the
first snapshot and the recovery baseline start. Every write states orientation 1. Placed and smart-object files keep
their stored orientation (the hooks do not run there): a known gap.

**T9.4 What is written** (metadata-io's chunk provider `'metadata'`, order 200, after `'icc'`):

| Kind | `purpose: 'save'` | `purpose: 'export'`, by `opts.metadata` | `'copy'` |
|---|---|---|---|
| EXIF | the block as read, orientation 1, pixel dimensions from `info`, the thumbnail rebuilt | `'all'`: as save; else none | none |
| XMP | as read with File Info merged, `xmp:ModifyDate`, `tiff:Orientation` 1 | `'all'`: as save; `'copyright'`: rights, creator, contact; `'none'`: none | none |
| IPTC | as read with File Info merged (JPEG, TIFF, PSD) | `'copyright'`: 2:116, 2:80, contact; `'none'`: none | none |
| Resolution | `doc.dpi` in every format that holds it | the same | none |
| Thumbnail | PSD 1036 (replacing ag-psd's); JPEG IFD1 | none | none |

`opts.metadata` is `'all' | 'copyright' | 'none'`; save defaults to `'all'`, export to `settings.export.metadata`
(`'none'`, Photoshop's Export As default). Other JPEG segments (APP12, APP14) are not carried. The provider replaces
`file-info.js`' `writeTo` wrap and `stampPsd` in the same landing.

**T9.5 `.pigment`**: metadata-io's entry provider writes `metadata/exif.bin`, `xmp.xml`, `iptc.bin` and
`describe().metadata = { orientation: 1, source }` (the pixels as stored; the read value in `source.orientation`), so
an upright JPEG saved as `.pigment` is not turned again.

**T9.6 What later packages use.** Pure `src/shared/metadata/exif.js` (`parseExif(block) → { ifd0, exif, gps, interop,
ifd1, makerNote }`, `writeExif`), `xmp.js` (`parseXmp`, `serializeXmp`, `setProperty`, `getProperty`), `iptc.js`
(`parseIptc`, `writeIptc`); from the store `xmpForExport(doc, opts)` (pdf-export), `readMetadataQuick(bytes, format) →
{ fields, thumbnail }` (home-new-doc-browser), `exifFields` (lens-correction-profiles). file-info-dialog (0.8) edits
through `setMetadata` with a label.

**T9.7 Paths.** File Info edits stay one entry; PSD carries 1028, 1036, 1058, 1060 through the chunks; actions: none.

#### T10. PSD document resources (E77)

**T10.1 What psd-document maps.** Guides and grid (re-registering the built-in `guides`, order 200, with 1032's
grid), saved paths (2000–2997), the work path (1025), the clipping path (2999), alpha channel names and identifiers
(1006, 1045, 1053), DisplayInfo (1077), the extra channels' data, 16 and 32 bits, Grayscale, Indexed and Bitmap, PSB
(`psb: true` for `.psb` and above 30 000 px; bounded by the canvas limit until tile-store) and `.psdt` (untitled on
open; "Photoshop Template" in Save As).

**T10.2 Registry additions** (`lib/psd/registry.js`, skeleton):

```ts
registerPsdByteStage({ id, order,
  beforeRead?(bytes, ctx): { agOptions?, state? } | void,   // e.g. useImageData for a 16/32-bit file
  afterParse?(psd, ctx, state): void,              // after readPsd, before kinds and resources: imageData to canvases (the
                                                   // proxy rule depth.js exports), deep samples on pl.deep, pl.mask.deep, psd.deep
  afterRead?(doc, psd, bytes, ctx, state): void,   // alpha channels, the mode
  afterWrite?(bytes, doc, ctx: { opts, report, compositor, psd, layerOf(record), records }): Uint8Array,
                                                   // records in ag-psd's write order, dividers included
  writesMode?(doc): boolean, writesDepth?(doc): boolean })   // this stage writes the mode / depth natively
registerPsdRawResource({ ids, order, read?(map, doc, ctx): void, write?(doc, ctx): Map<number, Uint8Array> })
psdWritesMode(doc): boolean; psdWritesDepth(doc): boolean
```
`read.js`: header → `beforeRead` → ag-psd → `afterParse` → a builtin aspect at order 5 (`builtin.js`) moving `pl.deep`
to `layer.deep` and setting `doc.depth` → S4's kinds, aspects, resources → raw resources → `afterRead`. `write.js`:
S4 → ag-psd → raw resources → `afterWrite`; then `encodeForPath`'s `'save'` chunks. When `psdWritesMode(doc)`,
`imageModeOf` passes the layers through and `ctx.imageMode.native` keeps the `composite` resource from appending the
Channel Mixer or Gradient Map. `psdOptions(direction, base, ctx)` hooks get `{ doc, path, format }`. Refused by
`registerPsdRawResource`: the chunks' ids (1005, 1028, 1036, 1039, 1058, 1060) and ag-psd's (1006, 1032, 1045, 1053);
`writeImageResources(bytes, map, { remove })` removes an id before inserting it. Orders: paths 300, clipping path 320,
DisplayInfo 350; stages `channels` 500, `deep` 600, `modes` 700.

**T10.3 Byte helpers** (`lib/psd/bytes.js`, skeleton, pure): `psdSections(bytes) → { header: { version, channels,
height, width, depth, mode }, colorModeData, imageResources, layerAndMask, imageData }`, `readImageResources`,
`writeImageResources(bytes, map, { remove })`, `packBits`, `unpackBits`, `writeHeader`, `replaceSection`,
`psdLayerSection(bytes)`, `psdFromLayerSection(section, { width, height, depth, mode })`.

**T10.4 ag-psd 31.0.3, measured:** writes 8-bit RGB only; reads 16/32-bit layer data only with `useImageData`, which
gives `imageData` and no `canvas` (hence `afterParse`); reads and writes 1006, 1045 (`alphaChannelNames`), 1053
(`alphaIdentifiers`) and 1032, which psd-document maps through `registerPsdResource` on those fields; has mock or no
handlers for 1077, 1025, 2000–2997, 2999 (raw resources); writes 1036 with `generateThumbnail`; supports `psb: true`.
A package that needs another internal names it in its report (S4.5).

**T10.5 Layered TIFF** (save-options-common-formats): tag 37724 holds `"Adobe Photoshop Document Data Block\0"` and
`psdLayerSection(writePsdDocument(…))`; reading wraps it with `psdFromLayerSection` for `readPsdDocument`.

**T10.6 Notices, PSB and PSDT.** The skeleton keeps 0.5's two toasts for psd, psb and psdt, per document (marked): "PSD
files are written as RGB …" while `!psdWritesMode(doc)` (Duotone, Multichannel, CMYK and Lab keep it until
cmyk-formats-separations, 0.11) and "… at 8 bits/channel …" while `!psdWritesDepth(doc)`. psd-document calls
`registerExportFormat('psb' | 'psdt', { ext, layered: true, saveOnly: true, encode: (doc, opts, c) =>
writePsdDocument(doc, c, { ...opts, format }) })` from `resources.js` (into `WRITE_EXTENSIONS` and `SAVE_FILTERS`;
export-as hides `saveOnly`); the skeleton adds `psdt` to io.js' open lists and PSD branch. `PSD_FEATURES`:
`guidesGrid`, `paths`, `alphaChannels`, `spotChannels`, `deep16`, `deep32`, `modes`, `psb`, `psdt`. Later: layer-comps
(1065), artboards-frames (kind 120), slices-web-export (1050), cmyk-formats-separations (byte stages, `bytes.js`).

**T10.7 Paths.** Each resource round-trips against documents and files the tests build; the 0.5 goldens hold while the
flags are false; no new vendor code.

#### T11. Export and save options

**T11.1 Formats.** save-options-common-formats registers BMP, ICO and CUR, TIFF and WebP options and its JPEG encoder
through `registerExportFormat` (into `WRITE_EXTENSIONS` and the skeleton-built `SAVE_FILTERS`), and re-registers from
`save-options.js` the TIFF reader (same id, replaced in place) and the `tiff`, `png16` and `png` writers (same ids) over
`lib/export-pixels.js` (skeleton: `exportPlanes`, `exportImageData`, `documentFromPlanes`, `packChannels`, moved out of
`depth.js`). The skeleton routes a deep document saved to `.png` through `encodeForPath` to `png16`, so `writeTo` →
`saveOptions` → encoder → chunks runs once with the merged options; `depth.js` keeps only its 8-bit toasts. The
browser's encoders stay in use for 0.5's options (baseline JPEG, default PNG, lossy WebP), so default options give
0.5's encoder output (the bytes before `applyChunks`).

**T11.2 Save As options (E78)** (`documents.js`, skeleton): `registerSaveOptions('*', def)` is asked first for every
format; `def.id` names a registration and the same id again replaces it (0.5's JPEG/WebP quality is `'quality'`);
`ask(app, doc, path, { ask, saveAs })`. `writeTo` honours `asCopy` (no `markSaved`, the path stays; it resolves
`'copy'`, truthy, and `saveAs` keeps the path then), `layers: false`, `alphaChannels`, `spotColors`, `notes`,
`useProofSetup` (the flattened image through `proofConvertCanvas`) and `embedProfile`, and emits `'doc:saved'` for a
save, `'doc:saved-copy'` for a copy. `registerExportFormat` defs gain `holds: { layers, alphaChannels, spotColors,
notes, icc }` (the skeleton fills in the built-ins); the `'*'` panel offers only what the format holds, and while
`SAVE_OPTION_FEATURES.panel` is true `saveAs` skips 0.4's "Save as a flat image" confirm. save-options-common-formats
registers the panel (As a Copy, Layers, Alpha Channels, Spot Colors, Notes, Use Proof Setup, Embed Color Profile) and
the format dialogs from field specs it owns (`saveOptionFields(format)`, each with `in: ['save', 'export']`); export-as
renders those marked `'export'`. Stub: `'*'` answers `{}`.

**T11.3 Option keys** (formats-more-codecs and save-for-web build on them): JPEG `{ quality 0..1, format: 'baseline' |
'optimized' | 'progressive', scans: 3..5, subsampling: '4:4:4' | '4:2:2' | '4:2:0', matte, grey }`; PNG `{ compression:
'none' | 'fast' | 'smallest', interlace }`; TIFF `{ compression: 'none' | 'lzw' | 'deflate' | 'packbits' | 'jpeg'
('zip' an alias of 'deflate', so 0.4 and 0.5 replays work), quality, byteOrder: 'II' | 'MM', pyramid, layers,
layerCompression: 'rle' | 'zip', transparency, alphaChannels }`; WebP `{ quality, lossless }`; BMP `{ depth, rle, os2,
flip }`; ICO and CUR `{ sizes: number[], hotspot? }`.

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
Every flat write goes through `io.js exportImage` with `purpose: 'export'` (chunks once), which accepts a prepared
`opts.source: { canvas } | { deep: { type, width, height, data } }` (skeleton: sizing and background once, every
encoder handed the source; the `export-pixels.js` helpers honour `deep`), so PNG and TIFF keep 16 bits after resample
or Convert to sRGB; `toSRGB` and `convertPixels` accept deep planes (the stub passes them through). Layered assets (PSD,
`.pigment`) are written from a temporary document carrying `doc.metadata` and `doc.profile`, through `encodeForPath(…,
{ purpose: 'export' })` (the skeleton makes it honour `purpose`, default `'save'`). Export Preferences (`settings.export
= { quickFormat: 'png', quickOptions: {}, quickLocation: 'ask' | 'next-to-document', metadata: 'none', convertToSrgb:
true, embedProfile: true }`), Quick Export as [format] (`quickExportFormat`), the dialog (assets, scales with suffixes,
preview with zoom and 2-up, sizes, resample, metadata, colour space, file size), Layers to Files (PSD, nesting,
per-format options). Convert to sRGB defaults on, as Photoshop (the default 0.5's review decision 6 left to 0.6). Command ids and replay arguments stay
(`file:export` replays 0.4's `{ path, format, quality, width, height, background }` and adds `{ assets, folder }`;
`file:export-quick`, `file:export-layers`, `layer:export-as`, `layer:export-quick`); `file:export-preferences` is new.

**T11.5 Paths.** No history; actions replay with their arguments; 16/32-bit: PNG and TIFF keep the depth through their
encoders, the rest are 8-bit; modes: the mode renderer runs in the flatten (0.3); Electron: folder and file dialogs.

#### T12. File handling (E80–E82)

**T12.1 Opening** (skeleton): `openDocument(bytes, { name, path, as = null, options = null, interactive = true })`; `as`
forces a reader (a registered id, `'pigment'`, `'psd'`, `'image'`), which gets `{ name, path, colorSpaceConversion,
interactive, options }`. **Reader choice**: first the readers listing the extension (whose `test`, if any, passes), then
the others by `test`, so a `.dng` reaches the RAW reader, not the TIFF reader that sniffs its structure; the TIFF test
also leaves out `RAW_EXTENSIONS`; a registration with an existing id replaces that reader in place. A reader may return
`null` (Cancel or Done in the RAW workspace, a cancelled Import PDF: `openPaths` adds nothing, reports nothing, records
no recent file) or an array (each added like one open, named `<name>-<page>`). `openDocument` sets `doc.name` and
`doc.path` as 0.5, fills `doc.format`, `doc.metadata` and the adopted profile only where the reader left them unset
(T9.2), and records `doc.openedWith = { reader, options }` (PDF `{ page, box, resolution, mode, depth }`, RAW `{ params
}`). `registerOpenGroup({ id, test(path), open(app, paths, { interactive }) → Promise<Document[]> })`: `openPaths` hands
a group every path it accepts at once (RAW files share one session) and opens the rest one by one; all go through `add`,
the hooks and the notices. `openPaths` and Batch (`interactive: false`) then mark the document saved again and emit
`'doc:ready'` `{ doc, interactive }`. Open As (`file:open-as`) shows the open dialog, then the reader choice.

**T12.2 Versions** (file-handling-autosave, `lib/versions.js`): with `settings.fileHandling.versions.enabled`, saving a
`.pigment` keeps the previous saved file inside the new one as `versions/<n>.pigment` (T5.5; the provider writes only
for `purpose: 'save'`), at most `keep` (5); `file:versions` (File › Version History…) lists them with time and
thumbnail and opens one as a new document or restores it (`replaceContent`, "Restore Version").

**T12.3 Replacing content and reloading (E81, E88)** (`documents.js`, skeleton): `app.docs.replaceContent(doc, fresh,
{ label = 'Revert' })` is one entry that swaps the content (tree, size, mode, depth, colour table, duotone, profile,
modeProfile, channels, paths, store, selection, meta, metadata, openedWith, openDecisions) with `fresh`'s by reference,
rebinds objects tied to a Document (the DocStore's `doc`), emits `'doc:content-replaced'` `{ doc }` and marks the
document saved after a Revert or a reload. A reload (the moved `file:revert` already does it in the stub; Auto-Update
the same) reads the file with `openDocument(bytes, { as: doc.openedWith.reader, options: doc.openedWith.options,
interactive: false })` and runs `runOpenHooks(fresh, { reason: 'revert' | 'reload', previous: doc, interactive: false
})`, which runs only hooks registered with `{ onReload: true }`: orientation yes, the colour policy repeating
`previous.openDecisions`, the `.psdt` hook no. `file:revert` (F12) loses 0.5's confirmation once file-handling-autosave
lands (T18.2 gates `hunt2.spec.mjs`). File watching reloads a clean document and asks first for an edited one.

**T12.4 Recovery** (file-handling-autosave, `lib/recovery.js`): `settings.fileHandling = { recovery: { enabled: true,
minutes: 10 }, autoUpdate: false, versions: { enabled: false, keep: 5 }, backgroundSave: false }`. `writePigment(doc, {
purpose = 'save' | 'copy' | 'recovery' | 'nested' | 'export', path = null, yieldEvery = null } = {})` (skeleton;
`encodeForPath` passes `'copy'` or `'save'` and the path, nested documents `'nested'`; providers get `ctx.purpose` and
`ctx.path`). Every N minutes each changed document is captured with `captureDocState` in one task, while no session is
open and no stroke runs (so JSON and pixels agree; over the snapshot budget the round is skipped with a notice), turned
into a document and written with `{ purpose: 'recovery', yieldEvery }` between idle callbacks through
`bridge.recoveryWrite`, indexed in `recovery/index.json` (`{ id, name, path, at, file }[]`). `'doc:saved'` (not
`'doc:saved-copy'`) or a close removes the entry. On `'app:started'` crash entries are offered (Open, Delete, Later); a
recovered document is untitled and dirty, `doc.recoveredFrom = path`. Save in Background stays off (workers-progress).

**T12.5 Bridge (E82)** (skeleton: `ipc.js`, `preload.cjs`, `bridge.js`, `main.js`):

```ts
bridge.share(paths: string[], { title }): Promise<{ ok: boolean, reason?: 'unsupported' | 'cancelled' }>
bridge.tempPath(name): Promise<string>                        // <tmp>/pigment-share/<name>; ipc.js empties it on 'will-quit'
bridge.recoveryList(): Promise<{ name, size, mtimeMs }[]>;  bridge.recoveryRead(name); bridge.recoveryWrite(name, bytes);
bridge.recoveryRemove(name);  bridge.recoveryReveal()          // <userData>/recovery/, names without separators
bridge.on('file-changed', ({ path }) => void)                 // watch.js's events, as main sends them
```
`src/main/share.js` (file-handling-autosave; stub `{ ok: false, reason: 'unsupported' }`): macOS through `ShareMenu`;
Windows and Linux reveal the copy and say so. The browser bridge: `share` through `navigator.share`; recovery in
IndexedDB `pigment-recovery` (it survives a reload; a `window.__pigmentTest.recovery` seeded by `addInitScript`
overrides it); `window.__pigmentTest.touchFile(path)` emits `'file-changed'`. `main.js`' one 0.6 change: the
`render-process-gone` dialog says "recovered documents will be offered after reload", and under `PIGMENT_TEST=1` the
window reloads without it.

**T12.6 Paths.** Revert and Restore Version are undoable; recovery files are `.pigment` files; actions: `file:revert`
keeps 0.5's rule, the others are `record: false`.

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

**T13.2 Commands and controls** (type-opentype-glyphs): `type:opentype { id, on? }` resolves `on` once, from the first
run's state, when it is absent, and records it in the argument (a replay is deterministic). It applies per run, since
`features` is one whole value per run: inside a session one `typeSession(app).edit((content, from, to) => …)` that maps
each run of `M.runsIn(content, from, to)` with `featuresFor(run.style.features, id, on)`; outside a session
`type/target.js editTypeLayers(app, layers, fn)` with the same per-run map on every targeted text layer (one entry named
after the feature, as Photoshop; no change to `target.js`). Type › OpenType ▸ and the
Character panel menu's OpenType ▸ (`openTypeMenuItems(app)` from `lib/type/features.js`, placed by the skeleton in
`char-format.js`) list the catalogue as checkboxes (`state.openType`, `state.openTypeAvailable`, T17.5); the Character
panel's button row is an E26 section `opentype`. A feature the face lacks is disabled (from the face record's
`features` set); text drawn by the Canvas fallback engine (browser build without local fonts) cannot take features,
and the controls say so.

**T13.3 The Glyphs panel** (`lib/panels/glyphs.js`, `window:panel-glyphs`): the face's glyphs from its cmap
(`face.collectUnicodes()`) and GSUB (`face.referenceTable('GSUB')`, parsed by the package), font and style choice, zoom,
subsets (Entire Font, Alternates for Current Selection, Unicode blocks, OpenType features) through
`registerGlyphSubset({ id, label, test(glyph: { gid, codepoint | null, routes }, face) })` (so subsets of unencoded
alternates can be expressed), recently used glyphs (`settings.glyphs.recent`, 30). Double click: `type:insert-glyph {
text, features?, postScriptName? }` replaces the session's selection (or inserts at the caret) with one
`typeSession(app).edit` that does `M.replaceRange` plus the per-character feature merge and puts the caret after it:
one step of the session's own undo, its text recorded. A glyph reachable only through a substitution
inserts its base character with the feature value that selects it (`aalt`, `salt`, `ssNN`, `swsh` = n) on that one
character; a glyph with neither a code point nor a feature route is shown greyed. The on-canvas alternates popup
(`alternates-popup.js`) does the same for the one selected character.

**T13.4 PSD** (`lib/psd/text-features.js`): aspect `text-features` (order 410, after psd-text's text kind), on layers
claimed `'text'`. ag-psd 31.0.3's `TextStyle` has only `ligatures` and `dLigatures` (`psd.d.ts`, `text.js styleKeys`);
`decodeEngineData` and `encodeEngineData` drop every other engine-data key. So type-opentype-glyphs owns
`scripts/vendor-entries/ag-psd-text-features.js` (stub `export const patched = false`), imported by `ag-psd-fixes.js`
after `ag-psd-text.js` (S4.5's pattern; `fixesPatched.textFeatures`): it wraps `infoHandlersMap.TySh` after psd-text's
wrapper, re-parses `text.EngineData` on read and adds the StyleSheetData keys Swash, OldStyle, Fractions, Ordinals,
Titling, StylisticAlternates, Ornaments and FigureStyle as `styleRuns[i].style.openType = {…}`, and writes them back.
The existing ag-psd vendor build (`build-vendor.mjs`) picks it up; `psdFeatures().textFeatures` says it is real. The
aspect writes `ligatures` / `dLigatures` always and the other features while that flag is true, reads them back by
text offset, and reports the features it could not write (stylistic sets; all but the two ligature kinds while the
flag is false) once.

**T13.5 What later packages use.** type-styles-prefs (0.7): character styles store `features`; `featuresFor` and the
catalogue; `insertGlyph(app, spec)` (exported). type-international (0.9): `registerGlyphSubset` for CJK and Arabic
blocks; vertical forms (`vert`, `vrt2`) are applied by the vertical layout, not listed in the catalogue.

**T13.6 Paths.** One entry per toggle; `.pigment` and clone carry `features` (0.4); PSD: T13.4; actions record
`type:opentype` with its id and `type:insert-glyph` with its text; Electron: local fonts reach HarfBuzz through
`queryLocalFonts` (0.4); the browser build without `local-fonts` only shapes added fonts.

#### T14. Camera RAW opening (E84)

**T14.1 Decoder, licence and shipping** (raw-open-workflow). LibRaw (0.21 or later) compiled to wasm without the GPL
demosaic packs, in a module worker, under **LGPL-2.1** (its CDDL-1.0 option is not needed): `libraw.wasm`,
`libraw.mjs`, `LICENSE` and `SOURCE.md` (version, source URL, build script) ship as separate files in
`src/renderer/vendor/libraw/`, loaded by URL, never bundled, kept outside the asar by `build.asarUnpack`. Relinking: a
user's own `libraw.wasm` named by `settings.rawWorkflow.libraryPath`, read through `bridge.readFile` and instantiated by
the shipped glue (`'wasm-unsafe-eval'`), accepted only when its `libraw_version()` and `abi` integer match; the glue is
never replaced (`script-src 'self'` and `pigment://` confine scripts). `scripts/vendor/libraw.mjs` copies a pinned
prebuilt package (an exact-version devDependency the lockfile pins, review decision 12) or builds from pinned sources
with emscripten; failing both it warns (E23) and RAW stays off (`RAW_FEATURES.decoder` false). `PIGMENT_REQUIRE_VENDOR=
libraw,pdfjs,lcms2` (read by `build-vendor.mjs`, skeleton) makes a listed step's failure fatal; raw-open-workflow sets
it in the release workflow. The CSP already allows `'wasm-unsafe-eval'` and `worker-src 'self' blob:`. Decoding API
(`lib/raw/decode.js`):

```ts
decodeRaw(bytes, { half = false } = {}): Promise<{ width, height,
  planes: { R, G, B: Float32Array },              // camera-native, linear, black-subtracted, not white-balanced
  camera: { make, model, lens?, iso?, exposureTime?, fNumber?, focalLength?, date? },
  asShot: { multipliers: [r, g, b], temperature?, tint? }, cameraToXyz: number[] /* 3x3, D50 */,
  dng?: { colorMatrix1?, colorMatrix2?, forwardMatrix1?, forwardMatrix2?, illuminant1?, illuminant2?, profileName? },
  exif: Uint8Array | null, thumbnail: Uint8Array | null, orientation: number }>
```

**T14.2 The linear input path** (skeleton, `develop-stages.js` / `develop.js`): `developPlanes(planes, params, { input
= 'display' | 'raw', rect, processVersion })` runs the stages on float planes, skipping 0.2's sRGB-to-linear entry for
`'raw'`; every stage's `ctx` gains `input`. `develop(img, params, rect)` is unchanged and passes `'display'` (the S8.1
test against `develop-04.mjs` holds). The raw path: from `camera-color` on the planes are **linear Rec. 709 / sRGB
primaries, unbounded float**; `camera-color` (order 95, raw-open-workflow's `develop-linear.js`, imported by
`develop.js`, empty stub) applies the white balance itself (the multipliers, then the DNG matrices interpolated by
temperature, LibRaw's matrix, or a `.dcp` HueSatMap and forward matrix), so `white-balance`'s raw variant is neutral;
the perceptual encode before `tone` does not clamp for raw input (the sRGB curve extended above 1), so highlights reach
`tone`'s raw variant (highlight recovery, with an optional linear pre-pass). `registerRawVariant(stageId, apply)` lets
`white-balance`, `exposure` (true stops) and `tone` hand raw input to raw-open-workflow's versions; `dcp-look` (260) is
the other raw-only stage; both are neutral on display input. After `developPlanes`, the float result goes to
`rawWorkflow.space` through the engine's `transform` (`'rgbaf'`) before quantising. `.dcp` files are the preset kind
`camera-profiles` (`{ make, model, name, blob: 'dcp-<sha1>.dcp' }`).

**T14.3 Workflow and outputs.** `settings.rawWorkflow = { space: profile id ('srgb'), depth: 8 | 16 | 32 (8), size: {
long } | null, resolution: 300, sharpen: { for: 'none' | 'screen' | 'matte' | 'glossy', amount: 'low' | 'standard' |
'high' }, smartObjects: false }`, preset kind `raw-workflow-presets`. Open: a document in the workflow space, depth and
size, `doc.format = 'raw'`, EXIF through `setMetadata`. Open Copy: the same, no sidecar. Open Object: a smart object of
source kind `raw` (bytes, params and workflow; `draw`, `prepare`, `exportFile`, `toDocument`; double-click reopens the
workspace). Done: the sidecar is written, the reader returns `null`. Save Image: JPEG, TIFF or PSD through
`encodeForPath` of a temporary document. Photo Merge (HDR, Panorama, HDR Panorama): `app.alignBlend.alignImages` and
0.3's merge maths, to `.pigment` or TIFF (never DNG).

**T14.4 The session.** raw-open-workflow owns `develop-ui.js`, `develop/workspace.js`, `white-balance.js` and
`presets.js` for the round (exports kept). The workspace gains `ws.input: 'display' | 'raw'`; in RAW mode `ws.source`
is an 8-bit render of the planes at neutral params (what camera-raw-panels' tools sample) and `ws.planes` the floats;
section `test(ctx)` and `fields(mode, ctx)` get `ctx.input` (`registry.js`, skeleton). Raw white balance is the raw-only
param `rawWhiteBalance { preset: 'as-shot' | 'auto' | 'daylight' | 'cloudy' | 'shade' | 'tungsten' | 'fluorescent' |
'flash' | 'custom', temperature 2000..50000, tint }`, owned by `camera-color`, with `crs:WhiteBalance`,
`crs:Temperature`, `crs:Tint`; its menu and tool solve in camera space. `openRawSession(app, files: { path, bytes }[], {
interactive })` opens the workspace on several images: the filmstrip slot (ratings, labels, multiple selection, Sync
Settings), the Workflow Options link, Save Image…, Open (Alt: Open Copy; Shift: Open Object), Cancel, Done. It
registers the open group `raw` for `RAW_EXTENSIONS` (`dng`, `cr2`, `cr3`, `crw`, `nef`, `nrw`, `arw`, `srf`, `sr2`,
`raf`, `orf`, `rw2`, `rwl`, `pef`, `srw`, `x3f`, `3fr`, `iiq`, `mrw`, `dcr`, `kdc`, `erf`, `mos`, `raw`, in
`src/shared/formats.js`) and a reader listing them with `appliesOrientation: true` that works without UI when not
interactive (the sidecar or the defaults). Reader and group turn the image upright and set `orientation: 1,
orientationApplied: true` and EXIF tag 274 to 1. `fileAssociations` (package.json): `psb` and `psdt` ("Photoshop
Document", Editor), `pdf` and `ai` (Viewer), one "Camera Raw image" row of `RAW_EXTENSIONS` (Viewer).

**T14.5 Sidecar .xmp.** `<name>.xmp` beside the raw file (Electron; the browser build keeps settings in the session):
`paramsToXmp(params, { input }) → string` and `paramsFromXmp(text, { input }) → { params, report }` are a facade the
skeleton adds in `lib/develop/registry.js` over `lib/develop/presets.js`' reader and writer (S8.4; raw-open-workflow's
file for the round); raw-open-workflow adds `rawWhiteBalance`'s names, `xmp:Rating`, `xmp:Label` and
`crs:RawFileName`.

**T14.6 What later packages use.** camera-raw-local (0.9) adds local adjustments as stages over `developPlanes`;
lens-correction-profiles (0.9) reads `camera.lens` and the EXIF fields and adds an Optics profile option through E47.

**T14.7 Paths.** Opening is not an entry; Open Object's edits are E55 entries; `.pigment` embeds a `raw` source's
bytes (large files, documented); PSD writes it as pixels; actions replay `file:open-paths` without UI; Electron loads
the unpacked wasm, the browser build the same files from `vendor/`.

#### T15. PDF import

**T15.1 pdf.js** (`pdfjs-dist`, Apache-2.0). The skeleton adds it to `devDependencies` at an exact version (the newest
release at least two weeks old that runs in Electron 44's Chromium; Folio's version is preferred, so one copy is
reviewed). pdf-import's vendor step copies `build/pdf.min.mjs`, `build/pdf.worker.min.mjs`, `cmaps/`, `standard_fonts/`,
`wasm/` (OpenJPEG, qcms) and `iccs/` into `src/renderer/vendor/pdfjs/` (git-ignored, like ag-psd's bundle). Loading:
`import()` of that file on first use, `GlobalWorkerOptions.workerSrc` beside it, `isEvalSupported: false`, local
`cMapUrl`, `standardFontDataUrl`, `wasmUrl` and `iccUrl`, no network; the CSP is unchanged. The NOTICE goes into
`docs/0.6/pdf-import.md`.

**T15.2 Open** (`lib/pdf/import.js`): `registerOpenFormat({ id: 'pdf', extensions: ['pdf', 'ai'], test: '%PDF-'
header, read })`. Interactive: the Import PDF dialog (Pages or Images; page thumbnails with multiple selection; Crop To:
bounding, media, crop, bleed, trim or art box; width, height, resolution and units with Constrain Proportions; Mode RGB
or Grayscale; 8 or 16 bits; Anti-aliased). A reader may return several documents (`Document[]`, the skeleton's
`openPaths` adds each, named `<name>-<page>`, T12.1) and records `doc.openedWith.options` for Revert. Not interactive:
the recorded options, else page 1 with the last settings (`settings.pdfImport`). The PDF's XMP
metadata goes to `setMetadata`; an RGB result is untagged (the working space). A non-PDF `.ai` (before Illustrator 9)
is refused with a message.

**T15.3 Place** (`lib/pdf/smart-source.js`): place reader `pdf` (`.pdf`, `.ai`; a page and crop box chooser) and source
kind `pdf` (`{ bytes, page, box, width, height }` in points at 72 ppi): `draw(ctx, src, { matrix, rect })` renders the
page with pdf.js at the matrix's scale. pdf.js renders asynchronously: `draw` returns `false` after drawing its nearest
cached render scaled; `prepare` renders the exact one and bumps `version(src)`; `raster`, `exportFile` (the PDF bytes)
and `toDocument` complete the kind (T6). `.eps` placement is refused with "needs an EPS interpreter (Pigment 0.9)"
(formats-more-codecs).

**T15.4 What later packages use.** linked-smart-objects (0.7): kind `pdf` with `link`; notes-count-measurement (0.9):
`pdfAnnotations(bytes, page) → { rect, contents, author, date }[]` (exported by `import.js`).

**T15.5 Paths.** Place is one structural entry (0.2); `.pigment` stores the PDF bytes through the kind's `toFiles`;
PSD writes the object as pixels (0.5); actions replay `file:place` and `file:open-paths` with the last settings;
16-bit import renders at 8 bits and converts; Electron loads the vendor files inside the asar through `pigment://`.

#### T16. View navigation (E85, E86)

**T16.1 Range.** `MIN_ZOOM = 0.002`, `MAX_ZOOM = 128` (0.2 % to 12 800 %), `ZOOM_STEPS` extended with Photoshop's
steps; the pixel grid and `imageSmoothingEnabled` rules of 0.2 hold.

**T16.2 Motion** (`lib/view-motion.js`): `view.zoom`, `panX`, `panY`, `rotation`, `matrix()`, `toScreen()` and
`toDoc()` are always the *targets*, so every caller and spec that reads them after a zoom command sees the final value
and pointer mapping stays exact. Animated Zoom is a display transition only: during it `paint()` draws the complete
target frame (composite, underlays, grid and every overlay: tools, `addOverlay` painters, snap, canvas capture,
rulers, guides, ants, the edge shadow, the mask view) into an offscreen canvas, then draws that onto the view canvas
through the eased delta (target → displayed) for at most 150 ms; no CSS transform touches the canvas. Only zooms from
the wheel, the Zoom tool, keys and menus (sources `'key'`, `'menu'`, `'menu-key'`) animate, never source `'api'` or a
direct `setZoom`. API: `view.animateTo({ zoom?, anchor?, panX?, panY?, rotation? }, { duration })`, `view.scrollBy(dx,
dy)`, `view.scrollPage('up' | 'down' | 'left' | 'right' | 'home' | 'end', { small })` (the skeleton lands immediate,
unanimated versions in `canvas-view.js`, so later packages and the skeleton spec test against them),
`view.motion.settled(): Promise` (resolves when no transition or flick runs), `'view:changed'` with the target values
(0.2). Flick panning: a Hand or Space drag of at least 100 ms and 5 samples whose speed over the last 30 ms (by
`timeStamp`) is above 0.8 px/ms and whose release comes within 50 ms of the last move continues and decays. Playwright
sends each `mouse.move` step with its own time stamp, so `conventions-shortcuts-fields.spec.mjs:382–389` (an exact
Space-drag pan) is gated (T18.2); view-navigation's own e2e drives flicks with steps separated by `waitForTimeout`.
Overscroll: `settings.view.overscroll` default true keeps 0.5's 40 px sliver; false clamps as Photoshop's default does
(a recorded difference). `view:set-zoom` (0.4) keeps its rule: a value up to 64 is a factor, above it a percentage
(the threshold stays 64, not `MAX_ZOOM`); `{ percent }` (`app.js`, skeleton) says it exactly.

**T16.3 Wheel, gestures, auto-scroll.** Plain wheel scrolls (Shift: sideways), or zooms with Zoom with Scroll Wheel
(0.5's setting); Alt+wheel zooms at the pointer; Ctrl+wheel (Cmd+wheel on macOS) scrolls sideways (Photoshop; 0.5
zoomed: release note). A trackpad pinch arrives as a wheel event with `ctrlKey` while Control is not physically held
(tracked from key events) and zooms. Edge auto-scroll (E85): during a primary-button drag routed to a tool whose
`autoScrolls(tool)` is true (`tool-traits.js`, skeleton; false for Hand, Rotate View, Zoom, Eyedropper, Color Sampler),
a pointer that stays outside the canvas area for 100 ms scrolls the view toward it, re-sending `onPointerMove` at the
same screen point each frame; the release stops it.

**T16.4 Scroll bars** (`lib/view-scrollbars.js`): overlays on the canvas host's right and bottom edges (thumb = visible
fraction), hidden in full screen; dragging a thumb pans, a click on the track pages.

**T16.5 Tool letters (E86)** (skeleton, `shortcuts.js`). Tool letters come from the effective keymap (`toolKeys`, built
from the `tool:<id>` entries, which the 0.5 Shortcuts editor can rebind). When a letter's effective command is
`tool:<toolId>` of a registered tool and that tool's slot holds tools whose own letters differ, the letter activates
that tool; otherwise it activates the slot's current tool (0.5). So H is always the Hand and R always Rotate View, both
in the Hand slot as in Photoshop. Shift+letter finds the slot by `slots.find((s) => s.id === id) ?? slots.find((s) =>
s.tools.includes(id))` (0.5 found none for `rotate-view`) and cycles it. `app.shortcuts.isHeld(letter)` answers from
`shortcuts.js`' keydown and keyup tracking (reset on blur), for the bird's-eye view. `nav.js` re-exports `HandTool`,
`RotateViewTool` and `ZoomTool` from `view-tools.js` (rule 2).

**T16.6 Tools and Navigator** (view-navigation, `lib/tools/view-tools.js`, `panels/navigator.js`): Hand with bird's-eye
view (hold H and press while zoomed in: the view zooms out to fit with a box; the release zooms in where the box is),
Zoom (scrubby zoom, Zoom Clicked Point to Center, double-click its toolbox icon: 100 %), Hand icon double-click: fit;
Rotate View with a compass overlay and an angle field; the Navigator's Ctrl-drag region zoom and Panel Options (view box
colour, `settings.view.navigatorColor`). Toolbox double-clicks reach `tool.toolboxDoubleClick?.()` (skeleton,
`tools.js`).

**T16.7 Preferences and keys.** The skeleton's built-in section `navigation` (order 22) holds `zoomWithWheel` and
`animatedZoom` (moved from `interface`); view-navigation replaces it (Animated Zoom, Zoom with Scroll Wheel, Zoom
Clicked Point to Center, Enable Flick Panning, Overscroll) over `settings.view` and the two 0.3 keys. Keys:
`view:scroll-*` (T17); `shortcuts.js` leaves the plain ones (PageUp, PageDown, Home, End) to a focused `<select>`, a
`[role=listbox]` (the History, Actions and Layers lists) and a focused scrollable panel container, as it already does
for `<input type=range>`. Resize Windows, Scroll All Windows and Zoom All Windows wait for document-windows (0.8), which
uses `animateTo`, the scroll API and the zoom constants.

**T16.8 Paths.** No history; preferences persist; Electron: macOS trackpad pinch and Windows precision touchpads
through the ctrlKey rule; the browser build is the same.

#### T17. Commands, menus and keys

**T17.1** S13.1's rules hold: every item and binding below lands in skeleton-06 (`menu-template.js`, `keymap.js`,
`COMMAND_LABELS`, `SHORTCUT_GROUPS`); an item whose command is a stub is disabled through `state.stubs`; no package
adds a command id outside this table; actions inside a package's own panels and dialogs are not commands unless
listed. Keymap tables bind commands, not arguments, so keyed variants are separate ids.

**T17.2 Menus.** File: Open As… after Open…; Version History… after Revert; Export ▸ gains Export Preferences… after
Export As…, and its first item's label is "Quick Export as <format>" (`state.quickExportFormat`); Share… after Export ▸.
Edit: Color Settings… gets Shift+CmdOrCtrl+K. Layer › Smart Filter ▸ (0.4 submenu, both places it appears) gains
`lyr(state.filterMaskEnabled ? 'Disable Filter Mask' : 'Enable Filter Mask', 'layer:smart-filter-mask', { arg: 'toggle',
enabled: smart && state.hasFilterMask })` and Delete Filter Mask (`arg: 'delete'`, same enabling). View: Proof Setup ▸
before Proof Colors (radios on `state.proofSetup`: Custom…, ─, Working CMYK, Working Cyan / Magenta / Yellow / Black
Plate, Working CMY Plates, ─, Legacy Macintosh RGB, Internet Standard RGB (sRGB), Monitor RGB, ─, Color Blindness –
Protanopia-type, Color Blindness – Deuteranopia-type, then the saved setups of `state.proofSetups`); 200% keeps its item
without a key. Type: Panels ▸ gains Glyphs Panel; OpenType ▸ after Anti-Alias ▸ (checkboxes from `OPENTYPE_FEATURES`,
checked from `state.openType`, enabled from `state.openTypeAvailable`). Window (`PANELS`): Glyphs after Paragraph.
Channel, History and Glyphs panel commands have no native items.

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
| `layer:smart-filter-mask` (`{ id?, op: 'add' \| 'delete' \| 'toggle' \| 'link' \| 'from-selection' }`, or the op alone) | Layer › Smart Filter ▸ | none | stub | smart-filters-depth |
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
`keyboard.press`, `keyboard.down`, `mouse.wheel` and `sendInputEvent` on the frozen 0.5 tree). **Saved overlays (E90)**:
`src/shared/keymap.js` lists the commands whose default keys are new in a release (`DEFAULTS_SINCE = { '0.6': [...] }`,
every key below); `effectiveKeys` drops such a default when the user's overlay gives the same combination, on that
platform, to another command (the user's choice wins), and the Keyboard Shortcuts dialog's conflict note names the
dropped default.

| Key | 0.5 | 0.6 | Spec lines | Change |
|---|---|---|---|---|
| Ctrl+2 | `view:zoom-200` (renderer key) | `channel:target-composite` | none | none |
| Ctrl+3 … Ctrl+9, Ctrl+Alt+2 … 9, Ctrl+\\ | unbound | channel keys | none (`masks-vector-masks.spec.mjs:386` presses Backslash alone: `layer:mask-overlay`, unchanged) | none |
| Shift+CmdOrCtrl+K | type session only (All Caps) | `edit:color-settings`; the type key still wins inside a type session (`typeKeyFor`, 0.4) | `type-editing.spec.mjs:315` (in a session) | none |
| Alt+Shift+CmdOrCtrl+O | unbound | `file:open-as` | none | none |
| PageUp, PageDown, Home, End (and modified) | unbound | `view:scroll-*` | `Home`, `End`, `Shift+Home`, `Shift+End`, `Control+Home`, `Control+End` are pressed in text fields and type sessions only, where plain and editing keys never reach the global table (0.4) | none |
| Ctrl+wheel | zoom | sideways scroll (a pinch still zooms) | `conventions-shortcuts-fields.spec.mjs:70, 394` use a plain wheel | none |
| Alt+wheel | scroll | zoom | none | none |
| R, H | the Hand slot's current tool | Rotate View, Hand (from the keymap, T16.5) | `blur-gallery.spec.mjs:541–545` presses `h` inside the Blur Gallery session (its own keys) | none |
| Shift+R | nothing (no slot found) | cycles the Hand slot | none | none |

**T17.5 UI state (E87).** `app.registerUiState(key, (app) => string | number | boolean | null)` (`app.js`, skeleton):
`syncUiState` merges the registered values into its object, through the same changed-check, and resyncs also on
`'type:selection'`, `'target:changed'` and `'type:catalog-changed'`. Each owner registers its keys from its own file;
each stub registers them with the 0.5-equivalent value: `proofSetup` (condition id) and `proofSetups` (JSON of the
saved setups' ids and names) from `lib/color/proof.js`; `openType` and `openTypeAvailable` (comma lists of catalogue
ids for the active text; stub `''`) from `lib/type/features.js`; `quickExportFormat` (`'PNG'`) from
`lib/export/prefs.js`; `channelTarget` (`'composite' | 'r' | 'g' | 'b' | 'mask' | <alpha id>`) from
`lib/channel-target.js`; `hasFilterMask` and `filterMaskEnabled` (stub false) from `lib/smart-filter-mask.js`.

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
| `tests/e2e/repaint-speed.spec.mjs:531` | `v.postProcess(a, v)` with `settings.proofColors` (`{ differ, cached }`) | while `!PROOF_FEATURES.real`; after, the same property through `displayStages().find((s) => s.id === 'proof').apply(…)` (8) |
| `tests/e2e/conventions-shortcuts-fields.spec.mjs:382–389` | an exact Space-drag pan right after the release | with `VIEW_FEATURES.motion` the test sets `settings.view.flickPanning = false` first (13) |
| `tests/e2e/select-mask.spec.mjs:71` (`viewPixel`) and every other reader of `view.ctx` pixels (step 0 greps `view.ctx`) | the view canvas two frames after `invalidate` | awaits `view.motion?.settled?.()` first, a no-op before view-navigation (13) |
| the specs that answer the flat-image confirm of a Save As (step 0 lists them) | 0.4's "Save as a flat image" confirm | its answer runs while `!SAVE_OPTION_FEATURES.panel`; after, the same step answers the panel's OK (11) |

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
| type-opentype-glyphs | `app.stubbed` lacks `type:opentype`; `psdFeatures().textFeatures` for the ag-psd wrapper |
| raw-open-workflow | `RAW_FEATURES.decoder` (`lib/raw/workflow.js`) |
| pdf-import | `PDF_FEATURES.import` (`lib/pdf/import.js`) |
| view-navigation | `VIEW_FEATURES.motion` (`lib/view-motion.js`) |

### Packages

Ports 8851–8866 in this order. The brief's feature list is each package's scope; a section adds what the contract
decides: files, deliveries, tests, the paths of rules 13 and 16 that bite, and "done"; every package also runs the paths
of its T-sections. **Landing order** (every package builds against the stubs; the order only decides which landed
partner a later package's checks can already see): sequence A — history-panel-depth, selection-tools-depth,
select-menu-finish, channels-depth, smart-filters-depth, pdf-import, type-opentype-glyphs, view-navigation; sequence B —
color-settings, soft-proofing, metadata-io, psd-document, save-options-common-formats, export-as,
file-handling-autosave, raw-open-workflow. Two packages run at a time, one from each sequence.

#### 1. selection-tools-depth (8851, entry `lib/tools/selection-brush.js`)
**Owns** `lib/tools/select.js`, `selection-brush.js`, `outline-drag.js`, `lib/select-mask/workspace.js`, `preview.js`,
new `lib/select-mask/presets.js`, `src/shared/pixels/livewire.js`, `quick-select.js`. **Delivers** T1.2–T1.5's tool
side (outline drags and nudges, marquee styles and Space, live-wire lassos, Quick Selection with Enhance Edge, Wand
sample size, the Selection Brush, the E57 buttons, `runSelectMask` with `preset`) and T1.8. **Tests** unit (live-wire
paths and the tile bound, quick-select stops at an edge, sample-size seeds); e2e (drag inside moves the outline with the
marquee and Object Selection, pixels stay; a Quick Selection drag inside extends; arrows nudge, one entry each; Fixed
Ratio and Size; Space mid-drag; a magnetic lasso follows an edge; a preset round trip and its replay). **Paths** the
Ctrl-held Move tool still moves pixels; Quick Mask refuses outline moves. **Done** `select-mask.spec.mjs` and every 0.5
selection spec green, `LIVEWIRE_REAL` true.

#### 2. select-menu-finish (8852, entries `lib/color-range.js`, `select-modify.js`, `quick-mask.js`)
**Owns** those three after the move (`quick-mask.js` with its target kind and `app.quickMask`), `lib/select-mask.js`,
`src/shared/pixels/selection-ops.js`, new `lib/select-mask/focus-tools.js`. **Delivers** Color Range as a real dialog
(samples with + and −, Localized Color Clusters, hue ranges, tones, Out of Gamut through `gamutMask`, matte and Quick
Mask previews through `MaskPreview`, Selection / Image, `.axt`, inside a selection; E60), Modify's canvas bounds, Quick
Mask Options, history and row (E63), Focus Area brushes, Hand, Zoom and views. **Tests** unit (clusters, hue masks,
canvas bounds); e2e (Color Range samples, inside a selection, 0.5 and 0.6 replays; inverted Quick Mask options; Focus
Area brush; Focus Area › Select and Mask… still hands over to the workspace). **Done** every T1.5 argument replays.

#### 3. channels-depth (8853, entries `lib/channel-dialogs.js`, `lib/channel-target.js`)
**Owns** `lib/panels/channels.js`, `channel-dialogs.js`, new `channel-target.js`, `spot-channels.js`. **Delivers** T2's
`alpha` and `channel` kinds (surfaces, paste, copy, clear; move and transform refused), T3.2's stages with
keys, T3.4, every `channel:*` id, `channelTarget`. **Tests** unit (surface write-back, `restrictToTarget`); e2e (Brush,
Gradient, Blur, Levels, Paste on Red leave green and blue, a red-to-blue gradient writes 76 to 29; an alpha stroke with
a text layer active prompts nothing, undo; Delete on an alpha channel clears it; Copy of Red is grey; Red targeted, Q,
paint black, Q selects as expected; a spot ink shows on screen, not in `pixel()`, and survives RGB → Grayscale;
Multichannel displays as in 0.5; the overlay updates on a tagged document; Split and Merge; Ctrl+3, Ctrl+2; T3.6).
**Paths** surfaces through undo; actions by name; CMYK and Lab refusals; Electron Ctrl+digits. **Done**
`modes.spec.mjs` green, every 0.5 brush tool paints an alpha channel.

#### 4. smart-filters-depth (8854, entry `lib/smart-filter-mask.js`)
**Owns** `lib/smart-object.js`, `lib/panels/layers-filters.js`, new `smart-filter-mask.js`, `smart-filter-resources.js`,
`lib/psd/smart-filters.js`. **Delivers** T5.1–T5.6, the `filter-mask` kind, `hasFilterMask` / `filterMaskEnabled`.
**Tests** unit (chain maths; the fake-kind-500 round trip; a depth map in a padded, clipped rect); e2e (a mask hides a
blur; Multiply 50 % on one filter; Blur with the filter mask targeted blurs the mask; Alt-drag copies in one entry; a
Lens Blur with a depth channel survives `.pigment`; the PSD notice; T5.3's DOM). **Done** 0.3's gaps for Lens Blur,
Displace and the texture kinds on smart objects closed.

#### 5. history-panel-depth (8855, entry `lib/history-states.js`)
**Owns** `lib/history.js`, `lib/panels/history.js`, new `history-states.js`, `lib/panels/history-menu.js`.
**Delivers** T4.1–T4.7 (the tree over the kept members, source per target, `capture`, the virtual first snapshot, the
snapshot budget, visibility), every `history:*` id. **Tests** unit `history-tree.test.mjs` (branching, jump, trimming
with branches and the root capture, merge, rollback, dirty on a branch, T4.9's cases); e2e (two branches reachable;
History Brush from a chosen state on a layer and a mask; Full Document snapshot; a Quick Mask snapshot applies without
a Quick Mask layer; snapshot on save, not on Save a Copy; Merged Layers offered over the budget; Batch captures
nothing; T4.8). **Done** `hunt4-sessions.spec.mjs` and every history spec green with non-linear history off and on.

#### 6. color-settings (8856, entries `lib/color/settings.js`, `lib/color/convert.js`)
**Owns** `lib/color/cmm.js`, `profiles.js`, `doc-profile.js`, the lcms2 vendor step and build, `lib/modes.js`,
`lib/adjust-more-ui.js`, new `settings.js`, `convert.js`, `lut-icc.js`. **Delivers** T7.1–T7.6 and the engine's
`proofTransform` (T8.1). **Tests** unit (round trips when the wasm loads in Node; policy decisions); e2e (a mismatched
PNG asks and converts, Batch silently, Revert repeats it; Convert to Profile of a 16-bit document with text, and undo;
CMYK numbers follow the profile; a P3 paste converts; New sRGB under Adobe RGB saves sRGB). **Done** S6.4's targets met
with a CMYK proof active.

#### 7. soft-proofing (8857, entry `lib/color/proof.js`)
**Owns** `lib/color-modes.js`, new `proof.js`, `src/shared/pixels/color-blind.js`. **Delivers** T8 (`setProofing`, the
stages and their keys, `gamutMask`, presets, the section, the `proof` readout, `proofSetup`). **Tests** unit
(colour-blind numbers); e2e (the stage converts the damage only; Proof Colors toggles with the 900 stage active; two
Custom setups differ; Gamut Warning colour; a plate preset; no engine gives 0.3's pixels). **Done** the 0.3 proof specs
green, Proof Setup radios in the native menu.

#### 8. metadata-io (8858, entry `lib/metadata-store.js`)
**Owns** `lib/file-info.js`, new `metadata-store.js`, `src/shared/metadata/*.js`. **Delivers** T9.2–T9.6 (an async
provider, the orientation hook through `orientDocument`, thumbnails, the `.pigment` provider). **Tests** unit (EXIF
with MakerNotes at byte level; XMP merge; IPTC); e2e (EXIF and XMP through Save As JPEG, PNG, TIFF, WebP, PSD; Export
As choices at a scaled size; a rotated TIFF opens upright, saves 1, reopens from `.pigment` unturned, reverts upright;
a PSD with 1058 at 6 is not turned; Batch keeps camera data). **Done** File Info reaches JPEG, PNG, TIFF and WebP.

#### 9. psd-document (8859, files loaded by `lib/psd/index.js`)
**Owns** `lib/psd/resources.js`, `channels.js`, `deep.js`, `modes.js`. **Delivers** T10.1, T10.6 over T10.2–T10.3.
**Tests** unit (each resource both ways); e2e (guides and grid; three kinds of path; alpha and spot channels; 16 and
32-bit layers and masks; Grayscale without a Channel Mixer layer; Indexed and Bitmap; a PSB refused at the canvas
limit; `.psb` and `.psdt` saves; a PSDT opens and reverts untitled). **Done** the flags true and the toasts gone for
what it writes.

#### 10. export-as (8860, entry `lib/export/prefs.js`)
**Owns** `lib/file-ops.js`, `lib/layers-extras/export.js`, new `lib/export/*.js`. **Delivers** T11.4,
`quickExportFormat`. **Tests** e2e (three scales, three files; canvas size; a 16-bit PNG at 50 % keeps 16 bits;
Convert to sRGB on P3; Quick Export next to the document; Layers to Files as PSD with the profile; 0.4's `file:export`
arguments replay). **Done** every 0.4/0.5 export spec green.

#### 11. save-options-common-formats (8861, entry `lib/save-options.js`)
**Owns** `src/shared/pixels/tiff.js`, `png.js`, new `save-options.js`, `jpeg-encode.js`, `bmp.js`, `ico.js`.
**Delivers** T11.1–T11.3, T10.5, TIFF read depth, BMP, ICO and CUR. **Tests** unit (JPEG against the browser's
decoder; BMP, ICO and TIFF variants; compression aliases); e2e (As a Copy keeps path and dirty state; Layers off; a
layered TIFF reopens and resaves without growing; a 16-bit PNG gets the PNG options; progressive JPEG; interlaced PNG;
lossless WebP). **Paths** default options give 0.5's encoder output. **Done** `hunt2.spec.mjs`' JPEG test and the S12.3
specs green.

#### 12. file-handling-autosave (8862, entry `lib/file-handling.js`)
**Owns** `file-handling.js`, new `recovery.js`, `versions.js`, `file-watch.js`, `src/main/share.js`. **Delivers**
T12.1's Open As, T12.2–T12.4, Share, `file-recovery`. **Tests** unit (index, naming); e2e (a recovery file after the
interval with fake timers, offered after a reload; Revert one entry; Revert of PDF page 2 reopens page 2; `touchFile`
reloads a clean document; Open As forces a reader; a version restores; Save a Copy keeps the entry); electron (the
folder under userData; a killed renderer reloads and offers its documents). **Done** the Electron recovery spec green.

#### 13. type-opentype-glyphs (8863, entries `lib/type/features.js`, `lib/panels/glyphs.js`)
**Owns** those, new `alternates-popup.js`, `lib/psd/text-features.js`, `ag-psd-text-features.js`. **Delivers**
T13.2–T13.4, `openType`. **Tests** unit (GSUB alternates on the OFL font, patches, the per-run map); e2e (Discretionary
Ligatures changes glyphs; a toggle over mixed runs keeps their other features; a disabled button; glyph insertion as
one undo step; `salt`; PSD ligatures, and fractions with `textFeatures`; `.pigment`). **Done** the type specs green.

#### 14. raw-open-workflow (8864, entry `lib/raw/workflow.js`)
**Owns** `lib/develop-ui.js`, `lib/develop/workspace.js`, `white-balance.js`, `presets.js`, `package.json` and the
lock (after the skeleton), the release workflow's vendor line, new `lib/raw/*.js`, `develop-linear.js`, the LibRaw
vendor step and build. **Delivers** T14 and the `raw` source kind. **Tests** unit (stops on linear planes, matrix
interpolation, a highlight above 1 reaching `tone`, display path equal to `develop-04.mjs`); e2e (a test-built DNG
through the workspace, `openDocument` and Batch; Done writes a sidecar with `crs:Temperature`; Open Object re-edits;
two files, one session); electron (the wasm from the unpacked folder). **Done** `RAW_FEATURES.decoder` true in the
packaged app on all three CI platforms, licence files shipped.

#### 15. pdf-import (8865, entry `lib/pdf/import.js`)
**Owns** `import.js`, new `smart-source.js`, the pdf.js vendor step and copy. **Delivers** T15. **Tests** e2e (page 2
at 150 ppi; Images mode; sharp after a 4× scale on screen and in a PNG saved at once; `.pigment` round trip and the
fallback image without the kind; Export Contents writes the PDF; a non-interactive open). **Done** both builds open the
fixture, no network.

#### 16. view-navigation (8866, entry `lib/tools/view-tools.js`)
**Owns** `lib/canvas-view.js`, `lib/panels/navigator.js`, `view-tools.js`, new `view-motion.js`, `view-scrollbars.js`.
**Delivers** T16. **Tests** unit (zoom steps, flick rule); e2e (range; Alt+wheel, Ctrl+wheel, pinch; an animated zoom
keeps a marquee overlay on the image; auto-scroll after 100 ms; R and H; bird's-eye; scroll bars; PageDown, and Home in
the Layers list). **Paths** the specs that read `view.zoom` or pan. **Done** the whole suite green with Animated Zoom
and Flick Panning on.

### Reliances on 0.5

What a 0.6 package uses that a 0.5 *package* promised; each line is checked against the code when 0.5 is released, in
step 0 of Part 2. A reliance that does not hold is fixed by the skeleton (a facade) or noted here before packages start.

| 0.6 user | 0.5 promise | CONTRACT-05 | Function or field |
|---|---|---|---|
| color-settings, soft-proofing | ICC engine with RGB transforms and profile parsing of every colour space | S6.1 (icc-engine) | `parse` accepts CMYK, Gray and Lab profiles; `transform(from, to, { intent, bpc, format })`; the engine members of 0.5 deviation 18 |
| color-settings, soft-proofing | the lcms2 build exports what CMYK, Gray, Lab and proofing need | S6.1 (icc-engine's `scripts/vendor/lcms2.mjs`) | CMYK, Gray and Lab pixel types at 8 and 16 bits and float; `cmsCreateProofingTransform` with `cmsFLAGS_GAMUTCHECK` and `cmsFLAGS_SOFTPROOFING`; `cmsCreateMultiprofileTransform` and device links; `cmsSaveProfileToMem`; black-point detection |
| color-settings | untagged is the working space everywhere | S6.4, S6.6 (icc-engine) | the display stage's `active`, `describe` and the `'icc'` provider use `profileOf(doc)`, not `doc.profile === null`, and the stage converts what `damage` says; where not, color-settings (owner of `cmm.js`) fixes it |
| color-settings | `color-profiles` kind, system profile listing | S6.6, S10.5 (icc-engine) | the kind's `data`, `profiles()` |
| export-as | the `'icc'` provider honours `embedProfile` and `convertTo` | S6.3 (icc-engine) | `opts.embedProfile === false`, `opts.convertTo === 'srgb'` |
| export-as, raw-open-workflow | `toSRGB` converts | S6.5 (icc-engine) | `toSRGB(canvas, doc)` |
| channels-depth | the colour picker with books | S7.1 (color-picker-swatches) | `app.colorPicker.pick({ allowBooks })` |
| skeleton (call sites) | the picker's CMYK fields and the Color panel's CMYK sliders call 0.3's model through identifiable functions | S7.1 (color-picker-swatches) | `rgbToCmyk` / `cmykToRgb` call sites in `color-picker.js`, `color-views.js` |
| type-opentype-glyphs | the face record exposes the HarfBuzz face and its features | S11 (type-fonts keeps `faceFor`) | `faceFor(style).face` (harfbuzzjs `Face`), `.features` (Set) |
| type-opentype-glyphs | `features` reach HarfBuzz per run | 0.4 A, S11 (type-fonts) | `featureList` in `shaper.js` |
| type-opentype-glyphs | the text kind writes and reads style runs in the model's run order | S4, psd-text section | `rec.text.styleRuns`, claim `'text'` |
| type-opentype-glyphs | psd-text's wrapper of the TySh handler can be chained | S4.5, psd-text section | `scripts/vendor-entries/ag-psd-text.js` wraps `infoHandlersMap.TySh` and exports `patched` |
| raw-open-workflow | the workspace implements `DevelopWorkspace`, its slots, presets and snapshots | S8.2, S8.4 (camera-raw-workspace) | `registerWorkspaceSlot` places, `DevelopWorkspace`, `camera-raw-presets` |
| raw-open-workflow, skeleton | the .xmp reader and writer | S8.4 (camera-raw-workspace) | the names behind T14.5's facade (to be read from `lib/develop/presets.js`) |
| raw-open-workflow | the `profile` stage and the profile browser | S8.4 (camera-raw-workspace) | order 250, `camera-raw-profiles` |
| raw-open-workflow | Optics and Geometry stages with `mapPoint` | S8.1 (camera-raw-panels) | resample stages 50–90 |
| raw-open-workflow | the white balance menu, tool and fields | camera-raw-workspace section 7 | `lib/develop/white-balance.js` exports; the tools that read `ws.source` / `ws.sample` (Targeted Adjustment, guided Upright, camera-raw-panels) |
| psd-document | the raster-mask aspect and claims | S4.6 (psd-layers) | `claim(layer, 'vector-mask')`, the `raster-mask` re-registration |
| psd-document | Maximize Compatibility's composite | S4.4 (psd-layers' setting) | `settings.psd.maximizeCompatibility` |
| smart-filters-depth | Camera Raw's smart kind with `open` | S8.3 (camera-raw-workspace) | `registerKind('camera-raw', { open })` |
| history-panel-depth | tool presets do not write history | S12.1 (presets-panels) | `setOptions` |
| selection-tools-depth | the brush picker for Quick Selection and the Selection Brush | brush-settings-panel | `app.brushPicker.renderButton(el, tool)` |
| view-navigation | the Eyedropper keeps `sampleAt` and the ring | S12 (color-picker-swatches) | `EyedropperTool.sampleAt`, `this.ring` |
| skeleton | the keymap store's sets and overlays | S9 (skeleton-05; shortcuts-editor writes) | `KeymapStore.set` placement for the T17 keys; `effectiveKeys` as 0.5 left it (E90) |
| skeleton (T2.3) | the Move tool's press and nudge paths | move-tool-depth section | `tools/move.js onPointerDown` lifts `layer.canvas` unless `editingMask`; `onKeyDown` calls `offsetLayers` |
| skeleton (T2.3) | the delivered brush engine keeps the skeleton's stroke shape | S2 (brush-engine-core) | `BrushStroke({ target, layer, settings, … })`, `migrate`, `beginStroke(canvas, { kind })`, flushed rects |

### Tests expected from every 0.6 package

As in 0.5: `tests/unit/<package>.test.mjs` for pure code (numbers checked), `tests/e2e/<package>.spec.mjs` on its port,
`app.spec.mjs`, `skeleton-04/05/06.spec.mjs` and `brush-golden.spec.mjs` green with the package landed, and the whole
suite green on its port. The report lists what was not done, every behaviour change of an existing feature, every
deviation from this contract, every test skipped until a partner lands, the six paths checked (rules 13 and 16), and
the measured cost of anything on the repaint or stroke path.

### Review decisions

The four engineers' findings were applied where the code agreed; these were decided otherwise or in part, and the
draft's open questions are answered here:

1. **`history.savedIndex` stays an assignable member** mapped onto the tree, not a `markUnsaved()` called at its
   writers: the ten 0.5 writers (with `image-ops.js:833` and `tools/text.js:934`) stay as they are.
2. **The `sourcePixels` stub answers the merged image for every target**, not only `layer`: 0.5 paints the saved
   composite into a mask too, and the stub keeps 0.5's behaviour.
3. **Outline drags draw through `view.antsOffset`**, not by making `view.hideAnts` a reason set: six 0.5 files save and
   restore that boolean and a spec reads it.
4. **`writeTo` resolves `'copy'`** for a copy, not `{ ok, asCopy }`: every caller tests truthiness only.
5. **`openDocument` keeps setting `doc.name`** (readers pass the file name with its extension); `format`, `metadata` and
   the profile follow the reader, and an array's documents get page suffixes.
6. **No `applyCharWith` in `type/target.js`**: `editTypeLayers`, `typeSession().edit` and `runsIn` exist, so per-run
   features need no change to a frozen type file.
7. **The OpenType PSD wrapper has a floor**: if `ag-psd-text-features.js` is not delivered, T13.4 still writes the two
   ligature kinds and reports the rest (`psdFeatures().textFeatures` false).
8. **Raw white balance has one owner**: raw-open-workflow takes `white-balance.js` and `presets.js` for the round and
   gets the `ws.input` / `ctx.input` hooks too, rather than hooks alone over camera-raw-workspace's files.
9. **Colour mapping**: Pigment has no layer-style effect registry, so `mapDocumentColors` maps J.6's style fields
   itself and `mapColors` lives on `registerLayerType` only. **No CMYK profile is bundled by contract**: working CMYK
   stays 0.3's model unless color-settings ships one whose licence it records.
10. **Copy-on-write is dropped** with `willWrite` and the old rule 18 (0.5 writes canvases in place outside History);
    snapshots copy at capture and the first snapshot is virtual. E67 is now `history.capture`.
11. **Smart filters in PSD stay an inert aspect, tested through a fake kind 500**; linked-smart-objects (0.7) keeps
    native smart objects.
12. **LibRaw ships from a pinned prebuilt package** (an exact-version devDependency), built from source where emscripten
    is present; the release requires it through `PIGMENT_REQUIRE_VENDOR`.
13. **Kept as drafted**, with no finding against them: `visibilityUndoable` on by default; clicking a captured snapshot
    adds an entry; Revert asks nothing once it is undoable; Overscroll stays on.
14. **The TIFF container keeps unchanged values in place**, not a `chunksInline` flag per format: one rule in one
    skeleton file.
15. **The skeleton lands the `quick-mask` target kind** in the moved `quick-mask.js`, so the rule holds whichever of
    select-menu-finish and channels-depth a checkout has.
16. **Snapshot memory has its own budget** (`snapshotMemoryMB`), not a share of `historyMemoryMB`, so the entries'
    trimming stays 0.5's.

---

# Part 2: implementation checklist for skeleton-06

The app works after every step. After each step: `npm test` and the specs the step names; after steps 5, 7, 10, 11 and
13 the whole browser suite and the Electron tests. Start: 0.5 as released (roughly 1000 unit, 700 browser and 8 Electron
tests, all green); they stay green, changed only where T18.2 says, in the step it names. Every new skeleton test that
pins a stub's behaviour reads its package's T18.4 flag and checks the landed behaviour otherwise (rule 11; "gated"
below): `skeleton-06.spec.mjs` keeps an owner map and a `landed(page)` helper as skeleton-05 does, and its fakes use ids
of their own (kinds, stages, readers, resources) and are removed after each test, so they hold with the packages landed;
saves in it pass `askOptions: false`. Ports: 8850. The skeleton adds about 80 unit tests in 15 files, about 45 browser
tests and 3 Electron tests (`keys-06.spec.mjs`).

**Step 0. Start state and reliances.** Run the three suites on the released tree and record the counts. Check every
row of "Reliances on 0.5" (the lcms2 build against a list of its symbols) and write the result into
`docs/0.6/README.md`; a row that differs gets a facade in the step that uses it, or a note to its owner before the
round; an lcms2 version change goes into `package.json` now. Grep `tests/e2e` for `stubbed`, `.history-item`,
`view.ctx` and Save As flows that confirm flattening, and read the 0.5 integrator's edits of `skeleton-05.spec.mjs` and
the S14.2 lines, to fix T18.2's line numbers. Confirm T10.4 against the installed ag-psd. Record the release workflow's
path. No goldens are recorded: 0.5's brush, PSD and develop goldens cover the paths the skeleton touches.

**Step 1. Settings, styles, preset kinds.** `defaults.js` (T18.1); fourteen empty stylesheets linked in `index.html`
(`selection-tools`, `select-menu`, `channels`, `smart-filters`, `history`, `color-settings`, `proofing`, `export-as`,
`save-options`, `file-handling`, `glyphs`, `raw`, `pdf-import`, `view-navigation`); `registerPresetKinds06()`; the
built-in `navigation` section in `extras.js`; `pdfjs-dist` at an exact version in `package.json` (T15.1). Test:
`tests/unit/skeleton-06.test.mjs` "settings" (every namespace declared; `withDefaults` keeps a 0.5 settings object).

**Step 2. Stubs and moved code.** Every MODULES entry of "New files" as a stub with its T17.3 ids and stub API; the
MODULES order; moved verbatim and working: T1.7's three files (with `app.quickMask`), `select:save`/`select:load`,
`file:revert`, the view tools (re-exported by `nav.js`), `filterRows`, `runSelectMask` (the closure variables as
parameters), `lib/export-pixels.js`, the magnetic snap and the Quick Selection flood; the `outline-drag.js` stub;
`stubs-later.js`; T18.2's `stubbed` lists and conventions probe. Tests: "stubs" (every T17.3 id is a disabled stub or a
real registration; the moved commands behave as in 0.5: a Color Range replay, Feather, Q twice, Save then Load
Selection, Revert (gated: its confirmation), the three view tools, `select:select-mask` with 0.5's argument, a 16-bit
TIFF export, T5.3's DOM).

**Step 3. Keys, menus, formats, UI state.** `keymap.js` (T17.3, `DEFAULTS_SINCE`), `menu-template.js` (T17.2),
`opentype-features.js`, `formats.js`, `app.js`' `registerUiState` (the stubs register their keys), `shortcuts.js`
(T1.4, T16.5, T16.7's keys), `canvas-view.js`' immediate scrolling, `tool-traits.js`, `tools.js`, `char-format.js`.
Tests: `keymap-06.test.mjs` (every T17.3 key; no conflict with the 0.5 tables on any platform; an overlay on Ctrl+3
wins; `typeKeyFor` keeps Shift+Ctrl+K in a session; Ctrl+2 is not `view:zoom-200`; a rebound `tool:rotate-view`),
`menu-06.test.mjs` (every T17.2 item, the OpenType items, the Proof Setup radios, the filter-mask label, no accelerator
twice), `opentype-features.test.mjs`, `keys-06.spec.mjs` (Alt+Shift+Ctrl+O once; a Proof Setup radio follows its
state), "keys" (R and H after the other was the slot's tool; Shift+R cycles; a fake `takeSpace`; Home in the Layers
list; a registered ui-state key resyncs on `'target:changed'`).

**Step 4. Selection and segmenters** (T1.1, T1.2's plumbing, T1.3's sample, T1.6). Tests: `segmenters.test.mjs`
(priority, availability, `{ key }`), `selection-06.test.mjs` (offset clipping, seed means), "selection"
(`select:offset` is one recorded entry; Select Subject from the menu and the workspace equals 0.5's; a fake segmenter
of priority 10 answers in both; `antsOffset` translates the ants).

**Step 5. Edit targets and channel plumbing** (T2, T3.1, T3.3): `lib/edit-target.js`, the `quick-mask` kind, T2.3's
call sites, the brush engine's restriction and kind, the Layers panel's thumbnails, `lib/channel-rows.js`, the channel
fields. Tests: `edit-target.test.mjs` (order, `restrictToTarget`, `greyOf`), "targets" (a fake `channel` kind on red:
Brush, Gradient, Fill, Gaussian Blur, Levels, Paste change red only, one entry each; a fake `alpha` kind with a text
layer active: a stroke paints the surface without a prompt or canvas growth, it and its undo write the mask in place,
the display pixel under a fake overlay stage changes on a tagged document; on a smart object Blur adds no smart filter;
a kind refusing `'move'` stops the Move tool and nudges; Copy uses the kind's `copy`; Quick Mask paints its layer with
the channel kind registered; 0.5's mask editing and `pixelTarget` callers unchanged; a fake row; the fields survive
`.pigment`). Whole suite.

**Step 6. History and document states** (T4.1, T4.3, T4.4; `mapColors`, `freeze`). Tests: `doc-state.test.mjs`
(`mapDocumentColors` over text, a live shape, a gradient fill, a style), "history" (gated: `sourcePixels` and the
History Brush as in 0.5; a 16-bit layered document with a mask, an alpha channel and a smart object round trips as
one entry; a Quick Mask capture holds no Quick Mask layer and the parked selection, and applying it ends Quick Mask;
`docStateToDocument`; sweep, solo and one eye are marked `visibility`; over the budget, `RangeError`).

**Step 7. Smart objects and `.pigment` entries** (T5.1, T5.4's pass-through, T5.5, T6). Tests:
`pigment-entries.test.mjs`, `source-kinds.test.mjs` (the fallback PNG), "smart" (a fake vector kind at 3×; an async
kind saved right after a 4× scale writes the exact render; a fake place reader, `null` cancels; Replace Contents tries
it; a 0.5 `.pigment` reopens equal; a filter mask stays aligned and unshared through Canvas Size, Image Size, a Move
drag, Free Transform, Duplicate and their undo; `blend` and `filterMask` survive `.pigment` (gated: while unrendered);
an entry provider round trips with its `purpose`, a failing one is a notice). Whole suite.

**Step 8. Colour** (T7.1–T7.5's pipeline, T8.1's stubs, T8.2's keys, `modeProfile`, New Document's sRGB, T18.2's
repaint-speed gate). Tests: `color-pipeline-06.test.mjs` (stubs equal 0.3's numbers; engine members used; 0.5's `{ rgb
}`; a fake `setProofing`; the stub `gamutMask`; a key change gives later stages full damage), "colour" (a fake engine's
`toCmyk` in the picker, Color panel and Info; a fake paste policy and its `null`; a fake gamut test drives the alarm
and "!"; a readout in Info; a keyed fake stage reaches the screen through a fake 900 stage; New Document stores
`SRGB` under a fake Adobe RGB working space).

**Step 9. Metadata containers, orientation, `'doc:ready'`** (T9.1–T9.3; T18.2's skeleton-05 gate). Tests:
`io-chunks-06.test.mjs` (TIFF EXIF both byte orders with sub-IFDs; an empty patch keeps the bytes; the 1 MB tag; an
async provider; PSD thumbnail; malformed input never throws), `orient.test.mjs` (`orientDocument` 2…8 on layers, masks,
guides, paths, selection), "metadata" (a JPEG with orientation 6 opens upright, applied; gated: a TIFF with 6 opens as
stored; a fake hook calling `orientDocument` runs before `'doc:ready'` and `sourcePixels` is upright; a PSD reads
applied; `doc.metadata` equals the file's blocks; a fake reader's metadata survives).

**Step 10. PSD byte stages** (T10.2, T10.3, T10.6's gates, T13.4's import). Tests: `psd-bytes.test.mjs` (sections;
resources written, removed and read; `packBits`; the layer section through `readPsdDocument`),
`psd-registry-06.test.mjs` (order; 1039 and 1006 refused; a fake `afterParse` gives a 16-bit file's layers canvases and
`deep`), "psd" (a fake raw resource 4000 round trips; a fake `afterWrite` reaches `afterRead`; a fake `writesMode` stage
gets a Grayscale document without a Channel Mixer layer or toast; gated: the 0.5 goldens with no stage). Whole suite.

**Step 11. Saving, exporting, opening, file handling** (T11.1–T11.2, T11.4's plumbing, T12.1, T12.3–T12.5,
`build-vendor.mjs`, `'app:started'`, T18.2's hunt2 and flat-confirm gates). Tests: "files" (a fake `'*'` `asCopy` keeps
path and dirty state and emits `'doc:saved-copy'`; a replaced `quality` asks once; a deep `.png` save asks once, writes
16 bits, chunks once; a fake group takes two paths; a `null` reader adds nothing; `as` forces a reader; a
TIFF-structured `.dng` never reaches the TIFF reader, from `openDocument` or Batch (gated: a fake raw reader until
raw-open-workflow's); `replaceContent` is one undoable "Revert"; Revert reuses a forced reader and its options and runs
only `onReload` hooks; a deep `exportImage` source keeps 16 bits; browser recovery survives a reload; `touchFile`),
`keys-06.spec.mjs` (recovery under userData; gated: the share stub's answer; with `PIGMENT_TEST=1` a killed renderer
reloads without a dialog).

**Step 12. The develop input path** (T14.2, T14.4's hooks, T14.5). Tests: `develop-planes.test.mjs` (display input
equals `develop()`; raw skips the entry; a raw value above 1 reaches `tone`; raw variants for raw only; `develop-04.mjs`
equality; the facade).

**Step 13. Specs and the full run.** T18.2 line by line; `skeleton-06.spec.mjs` complete and gated; all three suites; a
headless start-up with no console error or warning; while no package has landed, `app.stubbed` is exactly T17.3's stub
ids.

**Step 14. Documentation.** Part 1 into ARCHITECTURE.md; `docs/0.6/README.md` (packages, ports, sequences, step 0's
results); "The skeleton as landed" for every detail the code forced.
