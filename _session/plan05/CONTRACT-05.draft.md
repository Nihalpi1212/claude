# Pigment 0.5: the skeleton contract (draft 1, for review)

Two parts. **Part 1** is the text of a new section "## 0.5 features (contracts)" for ARCHITECTURE.md, written for the
fifteen package owners and the skeleton implementer. **Part 2** is the skeleton's implementation checklist, file by
file, in an order that keeps the app working at every step.

Names from the 0.4 section are reused without restating them: rules 1–10 of "Rules for the parallel round",
extension points E1–E33, sections A–O of "Shared integration points" (for example C = preset store, D = document
store, E = sessions and command flags, H = field widgets, L.1/L.2 = Properties and Preferences sections, L.8 = vendor
steps, M.8 = changed bindings). New extension points continue the numbering (E34–E53); the shared integration points
of 0.5 are S1–S15. Paths are relative to `src/renderer/` unless they start with `src/`, `scripts/` or `tests/`.

---

# Part 1: ARCHITECTURE.md, "## 0.5 features (contracts)"

## 0.5 features (contracts)

Pigment 0.5 is "Photoshop parity, stage 3": the brush engine, Brush Settings and Brushes panels with .abr, painting
behaviours, colour management through LittleCMS, PSD fidelity for layers and text, the Camera Raw workspace and
panels, the Styles, Shapes and Tool Presets panels, the Preset Manager and Photoshop preset files, the colour picker and
Swatches, the font menu, the Type menu commands, the shortcuts and menus editor, and Move tool depth. It is built like
0.4: the **skeleton** lands first, then **fifteen packages** are built at the same time in one checkout, then
everything is integrated, hunted for cross-feature bugs, reviewed and released.

### Rules for the parallel round

Rules 1–10 of 0.4 hold unchanged (one owner per existing file; new files and stubs; register, do not patch; stubs
through `stubCommands`; one settings namespace per package; stylesheets and `registerIcons`; documentation in
`docs/0.5/<package>.md`; tests with their own port and artifacts directory; the whole suite green; call sites placed for
others carry a marker comment and are kept). Five rules are added, from what 0.4's integration, hunt and review found:

11. **Skeleton tests that pin a stub are gated, never deleted.** Every assertion of `skeleton-05.spec.mjs`,
    `brush-golden.spec.mjs` and the skeleton's unit tests about a stub's own behaviour runs only while that stub is in
    place, read from the capability flags of S15. The existing spec lines that pin a 0.4 limitation a 0.5 package
    removes are listed in S14.2; the skeleton gates them the same way. A package that finds another such line does
    not edit it: it names file and line in its report, and the integrator gates it.
12. **One owner per behaviour.** A behaviour that needs code in two packages has its halves assigned in the table
    "Behaviours split across packages" below, with the API between them. A package tests its half against the other
    half's stub; it never writes a private copy of the other half to make its own tests pass.
13. **The five paths.** Every feature is checked through undo and redo (one entry per gesture or command, with
    Photoshop's label); save and reopen as `.pigment` and PSD (or the docs say why PSD cannot hold it); action
    playback (replay arguments; `record: false` for UI-only commands); 16/32-bit documents and the non-RGB modes
    (channel views over RGBA, 0.3); and the Electron build (preload bridge, `pigment://` inside the asar, the native
    menu and its accelerators, file dialogs). Each package section names what bites.
14. **Ports.** The skeleton's specs use 8850; the packages 8851–8865 in the order of "Packages". `PIGMENT_PARTIAL=1` as
    in 0.4.
15. **Third-party code.** Only icc-engine adds an npm dependency (LittleCMS 2 as wasm, MIT); it owns `package.json` and
    `package-lock.json` for the round. type-fonts bundles OFL font files with their licence files beside them. Every
    package that bundles third-party data lists it in `docs/0.5/<package>.md` for the release notes' notices.

### Behaviours split across packages (rule 12)

| Behaviour | Half and owner | Other half and owner | Between them |
|---|---|---|---|
| Picking a brush preset and painting with it | Brushes and Brush Settings panels (brush-settings-panel) | the engine (brush-engine-core) | `setToolBrush` / `toolBrush`, `tool:brush-preset` (S1.3, skeleton) |
| Texture, Dual Brush, Noise, Wet Edges, Brush Pose, Protect Texture | the modifiers (brush-settings-panel) | the modifier chain (brush-engine-core; the skeleton's stub engine runs it too) | `registerDabModifier` (S2.4) |
| The cursor shows the real tip | drawing (brush-painting-behaviours) | tip geometry (brush-engine-core) | `tipOutline` (S2.6) |
| Digits, Shift+digits, Shift+Alt+letters while painting | the `tool:*` commands (brush-painting-behaviours; `tool:airbrush-toggle`: brush-engine-core) | the key context (skeleton) | `PAINT_KEYS`, `app.keymap.resolveKey` (S13.4) |
| HUD colour picker (Alt+Shift+right-drag) | the gesture (brush-painting-behaviours) | the picker (color-picker-swatches) | `app.colorPicker.hud()` (S7.1) |
| Pen eraser end | the tool switch (brush-painting-behaviours) | `sample.eraser` (skeleton) | S2.5 |
| .abr files | the reader and writer (brush-settings-panel) | import, pattern links, routing (skeleton) | S10 |
| PSD text warp and anti-alias | the mapping (psd-text) | the rendering (type-menu-commands) | `typeOptions.warp`, `typeOptions.antiAlias` (S11.4) |
| PSD text fonts | PostScript names (psd-text) | catalog lookup (type-fonts) | `fontCatalog().resolve` (S11.1) |
| ICC profiles in files | the container bytes (skeleton) | what is adopted and embedded (icc-engine) | `readChunks` / chunk providers (S5), colour pipeline (S6) |
| Colour numbers in the picker, Info, swatches | the UI (color-picker-swatches) | the conversions (icc-engine) | `toLab`, `fromLab`, `cssColor` (S6.5) |
| The Camera Raw dialog | workspace host, Basic tab's profile, white balance, Auto, B&W (camera-raw-workspace) | pixel stages and the other tabs (camera-raw-panels) | S8 |
| Keyboard shortcuts | the editor (shortcuts-editor) | store, dispatch, native menu (skeleton) | S9 |
| Photoshop preset files | the format readers and writers (preset-files-manager; .abr: brush-settings-panel) | import, export, opening, dropping (skeleton) | S10 |
| Tool presets keep the brush | the panel (presets-panels) | the brush lives in `settings.tools[id].brush` (skeleton) | S1.3 |
| Move tool handles start Free Transform | the handles (move-tool-depth) | the session (skeleton, image-ops.js) | `transformTool.start({ grab })` (S12.2) |
| Missing fonts in opened files | the dialog and report (type-fonts) | `doc:opened` (exists) | S11.1 |

### Ownership of existing files

Every existing file 0.5 changes. "skeleton" means the skeleton makes all of 0.5's changes there and no package edits
it afterwards. Column "Plug in" says what the skeleton lands first in a package-owned file, or which extension point
the other packages use instead of editing it.

| File | Owner | What the owner changes | Plug in |
|---|---|---|---|
| `app.js` | skeleton | MODULES and the `start()` services (see "New files"); `help:shortcuts` moves out; `tool:pick-fg/bg` through `app.colorPicker`; brush size cap 5000; `'key'` commands through `resolveKey` (S13.4); status bar (S6.6); ui state (S13.6); dropped preset files (S10.4) | E43, E49, E50 |
| `lib/brush.js` | skeleton | becomes the facade over `lib/brush/engine.js` (S2); keeps `dabCanvas`, `drawBlended`, `drawOnMask` | E35 |
| `lib/tools.js` | skeleton | `BRUSH_OPTIONS` re-exported from `lib/brush/options.js`; options-bar slots, `resetOptions`, cursor filter (S12.1); option kind `color` through the widget registry (S7.3) | E39, E46 |
| `lib/tools/paint.js` | brush-painting-behaviours | gestures, cursor, arrow-key tip rotation | skeleton lands first: S3.1's gesture split; `baseSettings` from `toolBrush` (marked `// brush (lib/brush/tool-brush.js)`); `BLEND_OPTIONS` from `options.js`; the `migrate` prototype patch removed; cursor through `lib/brush-cursor.js` |
| `lib/tools/retouch.js`, `lib/tools/adjustment-brush.js` | skeleton | `onPointerDown/Move/Up` renamed `strokeDown/Move/Up` under the inherited gesture (S3.1); DabTool keeps its own dab loop (0.7 moves it) | E37 |
| `lib/tools/vector.js` | presets-panels | Custom Shape picker over the `shapes` kind, Define Custom Shape | keeps `CUSTOM_SHAPES`, `customPath`, `createShapeLayer` and the L.4 registries (rule 2); `strokePathPixels` keeps the 0.4 `settings` form of `BrushStroke` |
| `lib/tools/text.js` | skeleton | S11.2's option kinds, the anti-alias, orientation and Warp Text controls, `setEditing` (S11.3), the TypeTool surface (S11.5) | E51, E52 |
| `lib/tools/move.js` | move-tool-depth | auto-select, handles, layer marquee, nudging, align and distribute buttons, mask moves | E53; the snap calls (rule 10) stay |
| `lib/tools/nav.js` | color-picker-swatches | Eyedropper options and screen sampling, Copy Color as Hex / HTML | E28 (`sampleMerged` calls stay) |
| `lib/canvas-view.js` | skeleton | pointer samples (S2.5), right-button drags (S3.3), display stages and the canvas colour space (S6.4) | E36, E43 |
| `lib/compositor.js` | skeleton | `damage` (S6.4) | E44 |
| `lib/document.js` | skeleton | `doc.profile`, describe and duplicate (S6.2) | E43 |
| `lib/type/model.js` | skeleton | char attribute `axes`; `normalizeTypeOptions` normalises `warp` (S11.4) | E51 |
| `lib/type/api.js` | skeleton | font catalog slot, text render stages, `setEditing` (S11) | E51, E52 |
| `lib/type/fonts.js`, `shaper.js`, `layout.js` | type-fonts | variable instances and axes, per-cluster fallback, bundled and added fonts | keeps `faceFor`, `unitOutline`, `addFontData`, `loadedFaces`, `requestFamily` and the `LayoutRun` fields `units`, `face`, `size` (type-menu-commands reads them) |
| `lib/type/char-format.js` | skeleton | its two `<input type=color>` become `color` widgets (S7.3) | E46 |
| `lib/io.js` | skeleton | PSD code to `lib/psd/` (S4); chunks and the colour pipeline on open and save (S5, S6.3) | E40, E42, E43 |
| `lib/documents.js` | skeleton | save options (S12.3), preset files (S10.4), colour policy `onOpen` (S6.7), open notices (S4.4) | E43, E45, E50 |
| `lib/depth.js` | skeleton | its own 16-bit PNG save applies the chunk providers (S5) | E42 |
| `lib/develop-ui.js` | camera-raw-workspace | the full-window workspace | skeleton lands first: the editor built from the registry with 0.4's DOM (S8.3) |
| `src/shared/pixels/develop.js` | skeleton | the pipeline split into registered stages, process version (S8.1) | E47 |
| `lib/filter-ui.js` | skeleton | `app.filterEditor.rememberCommand` (S12.4) | E48 |
| `lib/extras.js` | skeleton | `pickColor` moves to `lib/color-picker.js`; New Document "Color Profile" (S6.6) | E20, E43 |
| `lib/form.js`, `lib/fields.js` | skeleton | field type `color` through a widget; the stub `color` widget (S7.3) | E7, E46 |
| `lib/shape-paint-ui.js`, `lib/lens-correction.js` | skeleton | their `<input type=color>` become `color` widgets | E46 |
| `lib/panels/color.js`, `lib/panels/swatches.js` | color-picker-swatches | views, sliders, the swatch store, groups, search | keeps `createColorWidget`, `normHex` |
| `lib/panels/brushes.js` | brush-settings-panel | the Brushes panel over `brushes`, `app.brushPicker` | skeleton lands first: deletes `installTipHook` (a prototype patch, a no-op since `baseSettings` passes angle and roundness); `drawStroke` moves to the engine as `renderStrokePreview`; `BUILTIN_BRUSHES` kept |
| `lib/panels/info.js` | skeleton | document profile row (S6.6) | E43 |
| `lib/smart-object.js` | skeleton | `cloneDocument` copies `doc.profile` (S6.2) | |
| `lib/style-ui.js` | presets-panels | Styles page, New Style, Make Default | E13 |
| `lib/layer-ops.js`, `lib/layer-move.js` | move-tool-depth | align target and spacing, mask moves | every 0.4 marker stays |
| `lib/image-ops.js` | skeleton | `TransformTool.start({ grab })` (S12.2) | E53 |
| `lib/gradient-editor.js`, `lib/pattern-picker.js` | skeleton | Export goes through `exportPresetsDialog` (S10.3) | E50 |
| `lib/modes/save-for-web.js`, `lib/automate/batch.js` | skeleton | "Convert to sRGB" calls `toSRGB` (marked `// color (lib/color/pipeline.js)`) | E43 |
| `lib/actions.js` | skeleton | action function keys reported to the keymap store (marked `// keymap (lib/keymap-store.js)`) | E49 |
| `lib/shortcuts.js` | skeleton | the table from `app.keymap`, the paint context, rebuilt on `keymap:changed` | E38, E49 |
| `lib/stubs-later.js` | skeleton | drops `edit:menus` (now shortcuts-editor's stub), adds `edit:color-settings`, `edit:convert-profile` (0.6) | |
| `lib/preset-kinds.js` | skeleton | `registerPresetKinds05()` (S10.5) | E5 |
| `src/shared/keymap.js` | skeleton | every 0.5 binding, `PAINT_KEYS`, `effectiveKeys`, labels, groups | |
| `src/shared/menu-template.js` | skeleton | every 0.5 item; accelerators from `state.keymap`; hidden and coloured items (S9.5) | |
| `src/main/main.js` | skeleton | coloured items as icons, Shift+Alt keys from the effective keymap, devtools key | |
| `src/main/ipc.js`, `src/preload.cjs`, `lib/bridge.js` | skeleton | `listColorProfiles` (S6.6) | |
| `src/shared/defaults.js` | skeleton | the 0.5 namespaces (S14.1) | rule 5 |
| `index.html` | skeleton | stylesheet links (CSP unchanged: wasm and module workers are allowed) | rule 6 |
| `scripts/vendor-entries/ag-psd.js` | skeleton | also exports `readAbr`, `readCsh`; imports `ag-psd-fixes.js` (S4.5) | E41 |
| `package.json`, `package-lock.json` | icc-engine | the lcms2 dependency | |
| `tests/unit/type-model.test.mjs` (line 26), the spec lines of S14.2 | skeleton | gated or updated as listed | |

No 0.5 package edits (for the avoidance of doubt): `history.js`, `commands.js`, `sessions.js`, `presets.js`,
`doc-store.js`, `panels.js`, `layer-dialogs.js`, `tool-traits.js`, `temp-tools.js`, `file-info.js`, `smart-object.js`,
`edit-ops.js`, `panels/layers.js`, `panels/character.js`, `panels/paragraph.js`, `panels/gradients.js`,
`panels/patterns.js`, `type/render.js`, `type/editor.js`, `type/target.js`, `warp.js` (read only), `select*.js`, and
`src/shared/pixels/*` other than `develop.js` (skeleton) and the new files.

### Where the briefs are wrong about the code

The briefs name files to touch; the code decides otherwise in these cases (the decision is binding):

- **Registration is not an edit.** brush-settings-panel and preset-files-manager do not touch `lib/preset-formats.js`,
  psd-layers and psd-text do not touch `lib/psd/registry.js`, camera-raw-panels does not touch `lib/develop/registry.js`,
  brush-settings-panel does not touch `lib/panels.js` (panels register themselves; F5 is the skeleton's key), and
  brush-engine-core does not touch `lib/edit-ops.js` (`edit:define-brush` is registered from `lib/brush/define.js`).
  They call the registries from their own files.
- **The skeleton lands the hooks** the briefs give to packages: pointer normalisation in `canvas-view.js`
  (brush-engine-core's brief), the display transform hook, `doc.profile`, `decodeImage`'s colour handling and the ICC
  chunk readers and writers (icc-engine's brief), the develop stage list (camera-raw-panels' brief), `help:shortcuts`
  and the native menu's accelerators (shortcuts-editor's brief), the options-bar controls of the type tools
  (type-menu-commands' brief). The packages fill them from their own files.
- **icc-engine does not edit `io-chunks.js`.** The container code (where an ICC profile sits in a JPEG, PNG, TIFF, WebP
  or PSD) is the skeleton's; icc-engine decides which profile is adopted and embedded (S5, S6). metadata-io (0.6) will
  do the same for EXIF, XMP, IPTC and resolution.
- **Warp Text is not a text extension.** `document.js textExtensions` choose a layout (text on a path); warp is a pass
  after the engine's render, so it is a text render stage in `lib/type/api.js` (S11.3).
- **`textLayerFromPsd` / `textToPsd` are not removed by psd-text**: the skeleton moves them into `lib/psd/text.js`,
  psd-text's file, as the stub psd-text replaces.
- **Pen eraser end and side buttons** move from brush-engine-core to brush-painting-behaviours: they switch tools
  during a gesture, which is the gesture layer's job (S3.1). brush-engine-core keeps tilt, twist, wheel and pressure.
- **Maximize Compatibility** is a save option (S12.3), not an edit of `documents.js`; **Last Filter repeats Camera
  Raw** through `rememberCommand` (S12.4), not an edit of `filter-ui.js`; the **Cursors** and **Camera Raw** preferences
  register sections (E20), not edits of `extras.js`; type-fonts' missing-font check listens to `doc:opened`.
- **Swatches, gradients, patterns panels.** The Gradients and Patterns panels already import every format registered
  for their kind (`presetFormats(kind)`); preset-files-manager needs no edit there. Their Export picked the first
  writable format, which would silently become .grd or .pat: the skeleton routes both through `exportPresetsDialog`
  (S10.3). The Swatches panel is color-picker-swatches' file; it calls the same functions.
- **"Pressure for opacity"** (brush-engine-core): 0.4's `pressureOpacity` scales *flow*; that stays for the legacy
  option (the goldens depend on it), and Transfer's opacity control acts on the dab's opacity ceiling (S2.3).
- **Dehaze to a dark-channel method** (camera-raw-panels) changes existing smart filters: it is process version 2;
  version 1 keeps 0.4's look (S8.1).
- **Colour books, colour-profile files and Camera Raw snapshots** have no home in the briefs' file lists; they are
  preset kinds (S10.5).

### New files

| Package | New files (owned) | MODULES entry (stub by the skeleton until the package lands) |
|---|---|---|
| skeleton | `lib/brush/preset.js`, `lib/brush/tool-brush.js` (S1); `lib/psd/registry.js`, `read.js`, `write.js`, `builtin.js`, `report.js`, `index.js` (S4); `scripts/vendor-entries/ag-psd-fixes.js`; `lib/io-chunks.js` and `lib/io-chunks/jpeg.js`, `png.js`, `webp.js`, `tiff.js`, `psd.js` (S5); `lib/color/pipeline.js` (S6); `src/shared/pixels/develop-stages.js`, `lib/develop/registry.js`, `lib/develop/tabs-04.js` (S8); `lib/keymap-store.js` (S9); `lib/preset-formats.js` (S10); the stub files below | `lib/psd/index.js` (its `install(app)` runs the mapper files' optional installs) |
| brush-engine-core | `lib/brush/engine.js` (stub: 0.4's engine), `lib/brush/options.js` (stub: 0.4's `BRUSH_OPTIONS`), `lib/brush/define.js` (stub), new `tips.js`, `dynamics.js`, `stroke.js` | `lib/brush/define.js` |
| brush-settings-panel | `lib/panels/brush-settings.js` (stub), new `lib/brush/texture.js`, `dual.js`, `extras.js`, `abr.js` | `lib/panels/brush-settings.js` (panel group, after `lib/panels/layers-menu.js`) |
| brush-painting-behaviours | `lib/tools/paint-gesture.js` (stub: pass-through), `lib/brush-cursor.js` (stub: 0.4's cursor code), `lib/tools/paint-keys.js` (stub), new `lib/brush-hud.js` | `lib/tools/paint-keys.js` |
| icc-engine | `lib/color/cmm.js` (stub), new `lib/color/profiles.js`, `doc-profile.js`, a worker module, `scripts/vendor/lcms2.mjs`, `src/renderer/vendor/lcms2/` (built) | `lib/color/cmm.js` |
| psd-layers | `lib/psd/adjustments.js` (stub: 0.4's adjustment mapping), `effects.js`, `vector.js`, `tags.js` (stubs), `scripts/vendor-entries/ag-psd-layers.js` (stub) | none (`lib/psd/index.js` imports them) |
| psd-text | `lib/psd/text.js` (stub: 0.4's text mapping), `scripts/vendor-entries/ag-psd-text.js` (stub) | none |
| camera-raw-workspace | `lib/develop/workspace.js` (stub), `src/shared/pixels/develop-profile.js` (stub, imported by `develop.js`), new `lib/develop/presets.js`, `white-balance.js` | `lib/develop/workspace.js` |
| camera-raw-panels | `src/shared/pixels/develop-more.js` (stub, imported by `develop.js`), `lib/develop/tabs/index.js` (stub), new `lib/develop/tabs/*.js` | `lib/develop/tabs/index.js` |
| presets-panels | `lib/tool-presets.js`, `lib/panels/styles.js`, `shapes.js`, `tool-presets.js` (stubs) | `lib/tool-presets.js`; the three panels after `lib/panels/brush-settings.js` |
| preset-files-manager | `lib/preset-manager.js` (stub), new `lib/preset-files/pat.js`, `grd.js`, `asl.js`, `csh.js`, `aco-ase.js`, `tpl.js`, `bundle.js`, `src/renderer/presets/` (Pigment-made sets) | `lib/preset-manager.js` |
| color-picker-swatches | `lib/color-picker.js` (stub: 0.4's picker dialog), new `lib/hud-picker.js`, `lib/color-libraries.js`, `lib/panels/color-views.js` | `lib/color-picker.js` |
| type-fonts | `lib/type/font-library.js` (stub: 0.4's family list as a catalog, the two font widgets as 0.4's selects), new `lib/type/font-picker.js`, `missing-fonts.js`, `src/renderer/fonts/` | `lib/type/font-library.js` |
| type-menu-commands | `lib/type/commands.js` (stub), new `lib/type/outlines.js`, `warp-text.js`, `antialias.js`, `lib/tools/type-mask.js` | `lib/type/commands.js` |
| shortcuts-editor | `lib/shortcuts-editor.js` (stub: 0.4's shortcuts list, `help:shortcuts` working), new `lib/menu-editor.js` | `lib/shortcuts-editor.js` |
| move-tool-depth | `lib/tools/move-handles.js` (stub: `MOVE_FEATURES`) | none (imported by `tools/move.js`) |

**MODULES order** (app.js): the 0.5 command entries go after `lib/stubs-later.js` and before `lib/panels/color.js`, in
package order (`lib/brush/define.js`, `lib/tools/paint-keys.js`, `lib/color/cmm.js`, `lib/psd/index.js`,
`lib/develop/workspace.js`, `lib/develop/tabs/index.js`, `lib/tool-presets.js`, `lib/preset-manager.js`,
`lib/color-picker.js`, `lib/type/font-library.js`, `lib/type/commands.js`, `lib/shortcuts-editor.js`); the four panel
modules (`lib/panels/brush-settings.js`, `styles.js`, `shapes.js`, `tool-presets.js`) after `lib/panels/layers-menu.js`.
`start()` creates, before MODULES: `app.keymap` (`new KeymapStore(app)`, S9; `lib/shortcuts.js`, the first module,
reads it), `attachColorPipeline(app)` (S6), `installToolBrush(app)` (S1.3), `installPresetFormats(app)` (S10). The
brush facade, `lib/psd/registry.js`, `lib/io-chunks.js`, `lib/develop/registry.js` are plain imports.

### Extension points

Twenty new extension points; the S-section specifies each.

| # | Extension point | Where | Used in 0.5 by | Later users |
|---|---|---|---|---|
| E34 | BrushPreset schema and the tool's brush | `lib/brush/preset.js`, `tool-brush.js` (S1) | brush-engine-core, brush-settings-panel, brush-painting-behaviours, presets-panels | retouch-tools-depth, brush-tips-mixer, actions-recording |
| E35 | Brush engine: `BrushStroke`, dab model, modifier chain, tip kinds, previews | `lib/brush.js` → `lib/brush/engine.js` (S2) | brush-engine-core, brush-settings-panel, brush-painting-behaviours | brush-tips-mixer (tips, mixer), deep-pipeline (float buffer), retouch-tools-depth, actions-recording (replay) |
| E36 | Pointer samples and right-button drags | `canvas-view.js` (S2.5, S3.3) | brush-engine-core, brush-painting-behaviours, color-picker-swatches | every pen-aware tool |
| E37 | Paint gestures (`strokeDown/Move/Up`) | `lib/tools/paint-gesture.js` (S3.1) | brush-painting-behaviours | retouch-tools-depth, actions-recording |
| E38 | Paint-context keys | `keymap.js PAINT_KEYS`, `shortcuts.js`, `app.keymap.resolveKey` (S13.4) | brush-painting-behaviours, brush-engine-core, shortcuts-editor (edits them) | retouch-tools-depth, brush-tips-mixer |
| E39 | Toolbox plumbing: options-bar slots, `resetOptions`, cursor filter | `tools.js` (S12.1, S3.2) | presets-panels, brush-painting-behaviours | workspaces-toolbar |
| E40 | PSD mapper registries, claims and notices | `lib/psd/registry.js` (S4) | psd-layers, psd-text | smart-filters-depth, psd-document, linked-smart-objects, layer-comps, artboards-frames, notes-count-measurement |
| E41 | ag-psd handler fixes | `scripts/vendor-entries/ag-psd-fixes.js` (S4.5) | psd-layers, psd-text | psd-document |
| E42 | Container chunks and chunk providers | `lib/io-chunks.js` (S5) | icc-engine | metadata-io, export-as, save-options-common-formats, save-for-web |
| E43 | Colour pipeline: engine slot, open, display and export hooks, conversions, policy and display stages | `lib/color/pipeline.js` (S6) | icc-engine, color-picker-swatches | color-settings, soft-proofing, info-histogram-properties, print, hdr-32bit, raw-open-workflow |
| E44 | Compositor damage | `Compositor.damage` (S6.4) | icc-engine | soft-proofing, gpu-pipeline |
| E45 | Save options per format | `documents.js registerSaveOptions` (S12.3) | psd-layers | save-options-common-formats, export-as |
| E46 | Colour picker API and the `color` field widget | `app.colorPicker`, `fields.js` (S7) | color-picker-swatches | hdr-32bit (intensity) |
| E47 | Camera Raw registry and develop stages | `lib/develop/registry.js`, `src/shared/pixels/develop-stages.js` (S8) | camera-raw-workspace, camera-raw-panels | raw-open-workflow, camera-raw-local, lens-correction-profiles |
| E48 | Last Filter command sources | `app.filterEditor.rememberCommand` (S12.4) | camera-raw-workspace | filter-dialogs-a (Liquify) |
| E49 | Keymap store, key sources, menu customisation | `lib/keymap-store.js`, `keymap.js effectiveKeys`, `menu-template.js` (S9) | shortcuts-editor, brush-painting-behaviours | workspaces-toolbar |
| E50 | Preset files: multi-kind formats, import/export dialogs, opening and dropping | `lib/preset-formats.js` (S10) | preset-files-manager, brush-settings-panel, color-picker-swatches, presets-panels | actions-atn (.atn) |
| E51 | Font catalog and font widgets | `lib/type/api.js fontCatalog`, widget kinds `font-family` / `font-style` (S11.1–2) | type-fonts, psd-text | type-opentype-glyphs |
| E52 | Text render stages and the editing flag | `lib/type/api.js` (S11.3) | type-menu-commands | type-on-path-area |
| E53 | Transform grab | `image-ops.js TransformTool.start({ grab })` (S12.2) | move-tool-depth | transform-warp-depth |

0.4 extension points 0.5 relies on: E5 (preset store), E7 (widgets), E13 (Layer Style pages), E14 (canvas capture),
E16 (`app.patterns`), E20 (Preferences sections), E23 (vendor steps), E25 (drop handlers), E26 (type panel sections),
E28 (merged sampling), E29 (tool traits), E31 (definition flags).

### Shared integration points

Each point gives the API, the stub the skeleton ships, and who completes it.

#### S1. BrushPreset schema (`lib/brush/preset.js`) and the tool's brush (`lib/brush/tool-brush.js`) — skeleton; no package edits them

**S1.1 Schema.** Pure (Node-testable). Sizes in px, angles in degrees, every other amount a fraction 0..1 (the panel
shows percent) unless the range says otherwise. A field the user cannot set in Photoshop for a section keeps its
default. Ranges are exported as `RANGES` (`{ 'tip.size': [1, 5000], 'scattering.scatter': [0, 10], … }`, every numeric
path) and `normalizeBrush` clamps to them.

```ts
type ControlType = 'off' | 'fade' | 'pen-pressure' | 'pen-tilt' | 'stylus-wheel' | 'rotation'
                 | 'initial-direction' | 'direction' | 'initial-rotation';            // ag-psd's list, kebab-case
interface Control { type: ControlType; fadeSteps: number }                          // fadeSteps 1..9999, default 25
interface SampleRef { blob: string; hash: string; width: number; height: number }   // blob: 'tip-<sha1 hex>.png', a side
                                    // file of the 'brushes' kind; grey PNG, white = full coverage
interface TipShape {
  kind: 'computed' | 'sampled' | string;   // 0.10 adds erodible / bristle / airbrush; an unknown kind keeps its fields
                                           // in tip.extras and paints as computed
  size: number;          // diameter 1..5000, default 24
  hardness: number;      // 0..1, default 0.8 (computed tips)
  sample: SampleRef | null;                // sampled tips
  angle: number;         // -180..180, default 0
  roundness: number;     // 0.01..1, default 1
  flipX: boolean; flipY: boolean;          // default false
  spacing: number;       // fraction of the diameter 0.01..10, default 0.12 (0.4's settings.brush.spacing)
  spacingOn: boolean;    // false: one dab per pointer sample (Photoshop's unticked Spacing); default true
  extras?: object;
}
interface BrushPreset {
  brushVersion: 1;
  tip: TipShape;
  shapeDynamics: { enabled: boolean; sizeJitter: number; sizeControl: Control; minimumDiameter: number; tiltScale: number /* 0..2 */;
                   angleJitter: number /* × 360° */; angleControl: Control; roundnessJitter: number; roundnessControl: Control;
                   minimumRoundness: number; flipXJitter: boolean; flipYJitter: boolean; brushProjection: boolean };
  scattering:    { enabled; scatter: number /* × diameter, 0..10 */; bothAxes: boolean; scatterControl: Control;
                   count: number /* 1..16 */; countJitter: number; countControl: Control };
  texture:       { enabled; pattern: PatternRef | null; invert: boolean; scale: number /* 0.01..10 */; brightness: number /* -150..150 */;
                   contrast: number /* -50..100 */; eachTip: boolean; mode: TextureMode; depth: number; minimumDepth: number;
                   depthJitter: number; depthControl: Control };
  dualBrush:     { enabled; mode: DualMode; flip: boolean; tip: TipShape; scatter: number; bothAxes: boolean; count: number; countJitter: number };
  colorDynamics: { enabled; perTip: boolean /* true */; fbJitter: number; fbControl: Control; hueJitter: number;
                   saturationJitter: number; brightnessJitter: number; purity: number /* -1..1 */ };
  transfer:      { enabled; opacityJitter: number; opacityControl: Control; minimumOpacity: number; flowJitter: number;
                   flowControl: Control; minimumFlow: number;
                   wetnessJitter: number; wetnessControl: Control; mixJitter: number; mixControl: Control };   // Mixer Brush (0.10): kept, unused
  brushPose:     { enabled; tiltX: number /* -1..1 */; tiltY: number; rotation: number /* 0..360 */; pressure: number;
                   overrideTilt: boolean; overrideRotation: boolean; overridePressure: boolean };
  noise: boolean; wetEdges: boolean; buildUp: boolean; smoothCurves: boolean; protectTexture: boolean;   // default false
  tool: null | { opacity?: number; flow?: number; blend?: string; smoothing?: number; color?: '#rrggbb' };  // "capture tool settings"
  extras: object;        // sections and fields this release does not know (from .abr or a newer file): kept verbatim
}
type TextureMode = 'multiply' | 'subtract' | 'darken' | 'overlay' | 'color-dodge' | 'color-burn' | 'linear-burn' | 'hard-mix' | 'linear-height' | 'height';
type DualMode    = 'multiply' | 'darken' | 'overlay' | 'color-dodge' | 'color-burn' | 'linear-burn' | 'hard-mix' | 'linear-height';
```

A texture `PatternRef` is `{ presetId, name, dataUrl? }`: unlike layer data (L.6), a brush may name a pattern preset
without its pixels (presets live in settings and the preset store, not in documents); the engine resolves it through
`app.patterns.get(presetId)` at stroke start, and a missing pattern turns Texture off for that stroke with one toast.

Exports: `DEFAULT_BRUSH` (frozen: the defaults above, every section disabled), `BRUSH_SECTIONS` (`[{ id, label,
toggle }]` in the panel's order: `tip` "Brush Tip Shape", `shapeDynamics`, `scattering`, `texture`, `dualBrush`,
`colorDynamics`, `transfer`, `brushPose`, `noise`, `wetEdges`, `buildUp`, `smoothCurves` "Smoothing",
`protectTexture`), `CONTROL_TYPES`, `TEXTURE_MODES`, `DUAL_MODES`, `RANGES`, and:

```ts
normalizeBrush(any): BrushPreset             // never throws; defaults filled, ranges clamped, unknown keys moved to extras;
                                             // a 0.4 flat object (has `size`, no `tip`) goes through brushFromLegacy
brushFromLegacy(o): BrushPreset              // 0.4 preset objects ({ id, name, size, hardness, spacing, angle, roundness, flow })
                                             // and 0.4 BrushStroke settings: size, hardness, angle, roundness, spacing go to tip;
                                             // a 0.4 *preset's* flow goes to tool.flow (the airbrush presets); settings' flow does not
legacyTip(preset): { size, hardness, spacing, angle, roundness }   // the flat keys 0.4 code reads
brushEquals(a, b): boolean;  sectionDiff(a, b): string[]          // section ids that differ ("modified" marks, locks)
withSections(base, from, ids): BrushPreset   // base with those sections taken from `from` (locks, Copy Texture to Other Tools)
clearControls(preset): BrushPreset           // every toggled section off, tip kept (Clear Brush Controls)
blobsOf(preset): string[]                    // tip.sample.blob and dualBrush.tip.sample.blob
```

**S1.2 Preset kind `brushes`** (registered by `registerPresetKinds05`, S10.5; brush-settings-panel re-registers it with
groups and thumbnails, rule "the later registration wins"): `data` is a `BrushPreset`, `normalize: normalizeBrush`,
`blobs: blobsOf`; built-ins are 0.4's `BUILTIN_BRUSHES` (`panels/brushes.js`, kept as an export) under their 0.4 ids
through `brushFromLegacy`. **Migration**: `installToolBrush(app)` (S1.3) waits for `app.presets.ready('brushes')`; when
`settings.brushes.migrated` is not true it adds each entry of 0.4's `settings.brushPresets` (its id kept) and sets
`migrated: true`. `settings.brushPresets` is never deleted (a downgrade to 0.4 still finds it).

**S1.3 The tool's brush** (`lib/brush/tool-brush.js`). Each painting tool has its own current brush, as in Photoshop.

```ts
toolBrush(app, toolId): { preset: BrushPreset, paint: ToolPaint }
setToolBrush(app, toolId, preset, { respectLocks = true, includeTool = true, presetId = null } = {}): void
supportsBrush(tool): 'full' | 'tip' | false     // 'full': StrokeTool subclasses with a size option; 'tip': the DabTool
                                                // family (size and hardness only in 0.5); false: other tools
installToolBrush(app): void                      // start(): migration (S1.2) and the command below
interface ToolPaint { opacity, flow, blend, smoothing, smoothingOptions: { mode: 'average' | 'pulled-string', catchUp: boolean,
                      catchUpOnEnd: boolean, adjustForZoom: boolean }, buildUp: boolean, pressureSize: boolean,
                      pressureOpacity: boolean, lockAlpha: boolean }
```

Storage: `settings.tools[toolId]` keeps 0.4's flat keys (`size`, `hardness`, `angle`, `roundness`, `opacity`, `flow`,
`smoothing`, `pressureSize`, `pressureOpacity`, `blend`, `lockAlpha`) and gains `brush` (a full `BrushPreset`),
`brushPresetId` (the preset it came from; null once edited) and `smoothingOptions`, `buildUp`. **The flat keys win**
for size, hardness, angle and roundness (0.4 code and the specs set them with `setOpt`); spacing comes from
`brush.tip.spacing` when `brush` exists, else from 0.4's `settings.brush.spacing`. `smoothingOptions.mode: 'average'`
is 0.4's smoothing (an exponential average, `k = 1 − smoothing`) and the default, so every 0.4 stroke keeps its path.
`setToolBrush` writes `brush`, the flat keys and `brushPresetId` in one `saveSettingsSoon` and emits `'tool:options'`
`{ tool, key: 'brush', value }`; with `respectLocks`, the sections listed in `settings.brushes.locks` keep the current
brush's values; with `includeTool`, `preset.tool` values go to the flat `opacity`, `flow`, `blend`, `smoothing`.

**Command `tool:brush-preset`** (registered working by the skeleton): arg a preset id of `brushes`, or `{ id?,
preset?, tool? }`; applies to `arg.tool`, else the active tool when `supportsBrush` is not false, else the last painting
tool; `ctx.setReplayArg({ preset: <data> , id })`, so a replay works where the preset does not exist. Recorded.

#### S2. Brush engine (`lib/brush.js` facade, skeleton; `lib/brush/engine.js`, stub by the skeleton, owned by brush-engine-core)

**S2.1 Facade.** `lib/brush.js` re-exports the engine's exports (below) and keeps `dabCanvas`, `drawBlended`,
`drawOnMask`; callers import from it only. The stub engine is 0.4's `BrushStroke` moved verbatim plus the hooks below;
`migrate` becomes a method.

**S2.2 Stroke.**

```ts
class BrushStroke {
  constructor(o: {
    target: { canvas: HTMLCanvasElement, x: number, y: number, mask?: boolean }, layer, history,
    selection?: Selection | null, onDirty?: (docRect, layer) => void,
    preset?: BrushPreset,            // normalised by the constructor
    paint?: StrokePaint,
    modifiers?: DabModifier[],       // this stroke only, after the registered ones (previews)
    settings?: object,               // 0.4 form ({ size, hardness, opacity, flow, spacing, smoothing, angle, roundness,
                                     // pressureSize, pressureOpacity, blend, color, mode, maskValue, antialias,
                                     // lockTransparency, sampler, label }): used when `preset` is absent
  });
  begin(sample: PointerSample): void;  extend(sample): void;
  finish(sample): void;              // extends to the release point without smoothing (what 0.4's onPointerUp did by hand)
  tick(now: number): void;           // build-up: places the dabs due at `now` while the pointer rests (the engine calls it
                                     // from requestAnimationFrame; tests call it with fake times)
  end(): HistoryEntry | null;  cancel(): void;  migrate(target, before): void;
  readonly target; readonly layer; readonly canvas; readonly dirty: Rect | null;
  readonly s: object;                // 0.4's merged settings view; `s.smoothing` stays writable (0.4 callers)
  readonly leash: { from: {x,y}, to: {x,y} } | null;   // pulled-string smoothing: drawn by the cursor (S3.2)
}
interface StrokePaint { mode: 'paint' | 'erase' | 'mask'; color: '#rrggbb'; background: '#rrggbb'; maskValue: number;
  opacity: number; flow: number; blend: BlendMode | 'behind' | 'clear'; lockTransparency: boolean; antialias: boolean;
  sampler?: (tctx, lx, ly, w, h, { x, y, size }) => void;      // clone, pattern and history stamps (0.4 semantics)
  smoothing: number; smoothingOptions?: ToolPaint['smoothingOptions']; buildUp: boolean;
  pressureSize: boolean; pressureOpacity: boolean;               // the options-bar overrides (0.4 keys)
  label: string; constrainColor?: (rgb: number[]) => number[]; seed?: number; view?: CanvasView }
```

History: 0.4's calls exactly (`beginStroke` in the constructor, `endStroke(dirty)`, `cancelStroke()`; depth.js and the
History panel rely on them); one stroke is one entry, build-up dabs and Shift-click lines included.

**S2.3 Dab model.** The engine evaluates a stroke as dabs:

```ts
interface Dab { x: number; y: number;          // stroke-canvas px, float
  size: number; angle: number; roundness: number; flipX: boolean; flipY: boolean;
  opacity: number;   // the stroke's opacity ceiling at this dab (Transfer's opacity control and jitter), 0..1
  flow: number;      // accumulation alpha of this dab, 0..1 (0.4's pressureOpacity scales flow: kept)
  color: [number, number, number]; tip: TipShape; index: number; t: number /* ms since begin */;
  sample: PointerSample;  direction: number /* degrees of travel */;  seed: number }
traceDabs(samples: PointerSample[], preset: BrushPreset, paint: StrokePaint, { seed = 1, times? } = {}): Dab[]
                     // pure: placement, smoothing and per-dab dynamics of a whole stroke, no pixels, no timer
```

**Goldens (rule 11 applies).** For 0.4's legacy settings and for presets whose sections are all off, `traceDabs` returns
0.4's dab positions, sizes and flows exactly (`tests/fixtures/brush-golden/dabs.json`, recorded from the 0.4 code by
the skeleton before anything changes), and strokes paint 0.4's pixels within tolerance: on every golden case the largest
per-channel difference is at most 3, the mean absolute difference over the stroke's bounding box at most 0.35, and the
Pencil (aliased) cases are equal. The stub engine is equal on every case.

**S2.4 Modifier chain.**

```ts
registerDabModifier(mod: {
  id: string; order: number;                         // same id: the later registration wins
  enabled(preset, paint): boolean;                   // false: costs nothing for this stroke
  begin?(ctx: StrokeContext): any;                   // once per stroke; returns the modifier's state
  geometry?(dab: Dab, state, ctx): Dab[] | void;     // edit the dab in place, or return several (Scattering's count)
  coverage?(mask: { data: Float32Array, width, height, x, y }, dab, state, ctx): void;
                                                     // the dab's coverage (0..1, stroke-canvas px x, y of its 0,0) before
                                                     // it is accumulated: Texture each tip, Dual Brush, Noise, Wet Edges
  buffer?(img: ImageDataLike, rect, state, ctx): void;   // the stroke buffer's rect, on a copy, each time it is composited
                                                         // onto the layer: Texture not per tip
  end?(state, ctx): void;
}): () => void
dabModifiers(): DabModifier[]                        // registered ones, in order
interface StrokeContext { preset, paint, stroke: BrushStroke | null /* null in traceDabs */, doc, layer, app,
  random: (salt: string) => () => number /* seeded from paint.seed */, constrainColor(rgb), patterns: app.patterns }
```

Order ranges: 50 Brush Pose (rewrites sample values first); 100–199 Shape Dynamics; 200–299 Scattering; 300–399
Color Dynamics; 400–499 Transfer; 500–599 Texture; 600–699 Dual Brush; 700 Noise; 800 Wet Edges; 900 Protect Texture.
brush-engine-core registers 100–499 (so `dabModifiers()` shows the order), brush-settings-panel 50 and 500–900. An
enabled section with no registered modifier paints as off. **Stub:** 0.4's engine plus `geometry` on every dab;
`coverage` through a scratch canvas read back and written back (a slow path, only when such a modifier is enabled);
`buffer` on a copy of the flushed rect. With nothing enabled the 0.4 path runs unchanged.

**S2.5 Pointer samples** (`canvas-view.js`, landed by the skeleton; every routed pointer event, coalesced events
included as in 0.4):

```ts
interface PointerSample {
  x, y; screenX, screenY;
  pressure: number;          // pen: e.pressure when > 0, else 1 (0.4); mouse and touch 1
  tiltX: number; tiltY: number;            // degrees -90..90 (0 for a mouse)
  twist: number;             // barrel rotation, degrees 0..359 (e.twist ?? 0)
  tangentialPressure: number;// stylus wheel / airbrush finger wheel, -1..1 (e.tangentialPressure ?? 0)
  altitude: number; azimuth: number;      // radians (e.altitudeAngle / azimuthAngle, else derived from tilt)
  pointerType: 'mouse' | 'pen' | 'touch';
  eraser: boolean;           // pen eraser end: pointerType 'pen' and (buttons & 32)
  barrel: boolean;           // pen side button: pointerType 'pen' and (buttons & 2)
  buttons, button, shift, alt, ctrl, meta;
  capsLock: boolean;         // e.getModifierState('CapsLock'): the precise cursor
  time: number;              // e.timeStamp
  temporary: 'ctrl' | 'alt' | 'space' | 'key' | null;   // 0.4 (F)
  original: PointerEvent }
```

A mouse sample gives the tilt, rotation and wheel controls their neutral value. Electron gets pen data through
Chromium's pointer events; no command-line switch is added unless a measurement in the packaged app needs one.

**S2.6 Tips and previews.**

```ts
ENGINE: { id: string, version: number, features: { dynamics, sampledTips, buildUp, smoothingModes, tilt, modifiersFor: string[] } }
                         // stub: { id: 'classic-0.4', version: 1, features: all false, modifiersFor: [] }
registerTipKind(kind, { render(tip, size): HTMLCanvasElement /* coverage in alpha */, outline(tip, o): [x, y][][] }): void
tipOutline(tip, { size, angle, roundness, flipX, flipY }): [x, y][][]   // polygons around (0, 0) in px; stub: an ellipse
renderTip(tip, size, color = '#000'): HTMLCanvasElement                 // thumbnails; stub: dabCanvas
renderStrokePreview(preset, paint, { width, height, scale = devicePixelRatio, path?: [x, y][], color }): HTMLCanvasElement
                         // a real BrushStroke along `path` (default: 0.4's S curve) on an offscreen target with a no-op
                         // history: the Brush Settings preview and the Brushes panel's stroke view; stub: 0.4's drawStroke
```

**S2.7 Every painting tool in 0.5.**

| Tools | Path |
|---|---|
| Brush, Pencil, Eraser (Brush, Pencil, Block), Clone Stamp, Pattern Stamp, History Brush, Adjustment Brush, Quick Mask painting | `BrushStroke` with `toolBrush` (paint.js `baseSettings`, S1.3): every section applies; samplers keep 0.4's meaning (the dab's coverage masks the sampled pixels) |
| Stroke Path (`vector.js strokePathPixels`) | `BrushStroke` with 0.4 `settings` (the brush's size and hardness, as 0.4) |
| Pencil | computed tip, hardness 1, `antialias: false`: aliased whole-pixel dabs, equal to 0.4 |
| Blur, Sharpen, Smudge, Dodge, Burn, Sponge, Color Replacement, Background Eraser, Healing Brush, Spot Healing | DabTool's own 0.4 dab loop (size, hardness, pressure for strength); gestures (S3) and cursors apply; their move onto the engine is retouch-tools-depth (0.7) |
| Mixer Brush, Art History Brush | not in 0.5 (brush-tips-mixer 0.10, retouch-tools-depth 0.7) |

16/32-bit documents: strokes paint the 8-bit proxy and `depth.js` rebuilds the deep pixels from it, as in 0.3 (float
stroke buffers are deep-pipeline, 0.9). Non-RGB modes: the stroke context's `constrainColor` is
`app.colorConstraint` applied to the dab colour, so Color Dynamics stay grey in Grayscale and snap in Indexed.

#### S3. Paint gestures, cursors and right-button drags

**S3.1 Gestures** (`lib/tools/paint-gesture.js`, stub by the skeleton; owned by brush-painting-behaviours).

```ts
export class PaintGesture {
  constructor(tool: StrokeTool);
  down(p: PointerSample): void; move(p, dragging: boolean): void; up(p): void;
  contextDown(p): boolean;      // a right-button press: true takes the drag (S3.3); stub false
  cancel(): boolean;            // Escape mid-gesture
  key?(e: KeyboardEvent): boolean;
}
// paint.js after the skeleton: StrokeTool's constructor sets this.gesture = new PaintGesture(this), and
onPointerDown(p) { this.gesture.down(p) }  onPointerMove(p, d) { this.gesture.move(p, d) }  onPointerUp(p) { this.gesture.up(p) }
onContextMenu(p) { return this.gesture.contextDown(p) }
strokeDown(p, opts = {}) / strokeMove(p, dragging) / strokeUp(p)    // 0.4's handler bodies; opts: { erase?: boolean, tool?: Tool }
```

The rename is mechanical: every StrokeTool subclass (paint.js, retouch.js's DabTool family and stamps,
adjustment-brush.js) defines `strokeDown/Move/Up` where 0.4 defined `onPointerDown/Move/Up`; Alt-click handling stays in
`strokeDown`. Stub: `down → tool.strokeDown(p)`, and so on. brush-painting-behaviours implements in it: Shift-click
straight lines (from the last stroke's end point, kept per tool and document: one `BrushStroke` from that point,
one history entry), Shift-drag axis constraint, held ` (tilde) erase (`strokeDown(p, { erase: true })`), the pen's
eraser end (`p.eraser`: the Eraser tool's `strokeDown` with its own brush for this stroke, back on `up`), the
brush-resize HUD (S3.3), and the HUD colour picker gesture (Alt+Shift+right-drag; Ctrl+Alt+Cmd+drag on macOS), which
calls `app.colorPicker.hud({ at, tool })` (S7.1).

**S3.2 Cursors** (`lib/brush-cursor.js`, stub = 0.4's `StrokeTool.drawOverlay` and `cursorStyle` moved; owned by
brush-painting-behaviours): `drawBrushCursor(ctx, view, tool)`, `brushCursorCss(tool)`. paint.js calls them. The
toolbox applies `app.tools.setCursorFilter(fn(tool, css) → css)` (tools.js, skeleton; one filter, the later wins)
whenever it sets the canvas cursor (activate, `updateCursor`): Other Cursors (Precise) and Caps Lock use it. The cursor
reads the tip from `tipOutline` and the leash from `stroke.leash`. The Preferences section with id `tools` keeps the
title "Cursors and tools" and a field with key `cursorStyle` (the skeleton-04 spec reads both, S14.2):
brush-painting-behaviours re-registers that id with Photoshop's Painting Cursors (Standard, Precise, Normal Brush Tip,
Full Size Brush Tip; `cursorStyle` values `'standard' | 'precise' | 'outline' | 'full'`, 0.4's `'dot'` read as
`'standard'`), Show Crosshair in Brush Tip, Only Crosshair While Painting, Other Cursors, Brush Preview colour.

**S3.3 Right-button drags** (`canvas-view.js`, skeleton). A tool's `onContextMenu(p)` that returns `true` takes the
right-button drag: moves go to `onPointerMove(p, true)` (with `p.buttons & 2`), the release to `onPointerUp({ ...p,
button: 2 })`. Every 0.4 tool returns `undefined` and behaves as before. The gesture uses it for the HUD (Alt+right-drag
on Windows and Linux; on macOS Ctrl+Alt+drag with the left button arrives through `down`).

#### S4. PSD mapper registries (`lib/psd/*`, skeleton; packages register from their own files)

**S4.1 Move.** 0.4's PSD code leaves `io.js`: `readPsdDocument` to `lib/psd/read.js`, `writePsdDocument` to
`lib/psd/write.js`, the pieces to the registered mappers below. `io.js` re-exports `readPsdDocument`,
`writePsdDocument`, `adjustmentToPsd`, `adjustmentFromPsd`, `blendIfToPsd`, `blendIfFromPsd`, `psdExpressible`,
`PSD_TEXT_KEYS`, `cssFamilyFromPsFont` (unit tests and specs import them from `/lib/io.js`); the owners of the files
that now hold them keep these exports (rule 2). `lib/psd/index.js` imports the registry, `builtin.js` and every mapper
file (`adjustments.js`, `effects.js`, `vector.js`, `tags.js`, `text.js`); later skeletons add one import line per new
mapper file (reserved names: `resources.js`, `channels.js`, `deep.js`, `modes.js` 0.6, `smart-filters.js` 0.6,
`smart-objects.js` 0.7, `comps.js` 0.8, `artboards.js`, `annotations.js` 0.9, `slices.js` 0.10).

**S4.2 API** (`lib/psd/registry.js`; the same id registered twice: the later wins; a `{ builtin: true }` registration
never replaces one made before it).

```ts
registerPsdLayerKind({ id, order,
  test?(pl, ctx): boolean;  read?(pl, ctx): Layer;                 // read: the first kind (by order) whose test passes builds the layer
  match?(layer, ctx): boolean;  write?(layer, ctx): AgPsdLayer | null })   // write: the first kind whose match passes writes the record
registerPsdAspect({ id, order, read?(pl, layer, ctx): void, write?(layer, rec, ctx): void })   // run on every layer, by order
registerPsdResource({ id, order, read?(psd, doc, ctx): void, write?(doc, psd, ctx): void })    // document level; on write, order < 500
                                                                                                // runs before the layers, >= 500 after
registerPsdOptions({ read?(opts): opts, write?(opts): opts })      // ag-psd read / write options (0.4: skipThumbnail, skipLinkedFilesData;
                                                                    // generateThumbnail, noBackground)
registerPsdNotice(code, { when: 'open' | 'save', text(count, details): string, timeout?: number })
psdFeatures(): Record<string, boolean>    // the merged PSD_FEATURES flags of the mapper files (S15)
interface PsdReadCtx  { doc, psd, opts, report, parent: GroupLayer, claim(layer, part), claimed(layer, part), patterns: Map }
interface PsdWriteCtx { doc, psd, opts: { compositor, maximizeCompatibility, ... }, report, claim(layer, part), claimed(layer, part),
                        shown(canvas, x, y) /* pixels as the image mode shows them, 0.4 */, maskOf(layer, parts) /* K.1 bake */ }
report: { add(code, detail?): void; count(code): number; lines(): string[] }
```

Claims: a mapper that writes a feature natively claims it (`'effects'`, `'advanced-blending'`, `'vector-mask'`,
`'text'`, `'shape'`, `'fill'`, `'adjustment'`, `'tags'`); the built-ins read the claims: the raster-mask aspect writes
`maskOf(layer, claimed(layer, 'vector-mask') ? 'raster' : 'all')` (J.8 when nobody claimed the vector mask); the
notice `'styled'` counts layers with enabled styles not claimed `'effects'` or non-default blending options (other than
Blend If) not claimed `'advanced-blending'`; `'pixel-text'` counts text layers no kind claimed `'text'`. So a notice
disappears exactly when a package starts writing the feature.

**S4.3 Order** (0.5 and reserved). Kinds: group 100 (built-in), artboard 120 (0.9), adjustment 200 (psd-layers;
the stub is 0.4's mapping), fill 300 (psd-layers), shape 350 (psd-layers), text 400 (psd-text; the stub is 0.4's),
smart-object 500 (0.7), raster 900 (built-in: any layer no other kind wrote, as rendered pixels). Aspects: common 100
(name, visibility, opacity, fill, blend, clipping, locks), blend-if 200, advanced-blending 210 (psd-layers),
vector-mask 290 (psd-layers), raster-mask 300, effects 400 (psd-layers), tags 500 (psd-layers: colour labels, link
groups), smart-filters 600 (0.6), comps 700 (0.8). Resources: resolution 100, guides 200, psd-document's 300–450
(0.6), comps 600, notes 650, composite and image-mode handling 900 (0.4's grey / duotone code, built-in). On read, a
group's aspects run after its children; ids are assigned by the kind.

**S4.4 Notices.** The built-in codes keep 0.4's texts exactly (specs assert them): `'other-space'`, `'styled'`,
`'no-psd-adjustment'`, `'colorized'`, `'guides-origin'`, `'pixel-text'`. `writePsdDocument(doc, compositor, opts)`
shows the save notices as toasts, one per code, as 0.4 did. Open notices (`when: 'open'`, for example "2 layer effects
Pigment does not have were rasterised") are returned on the document as `doc.openNotices` (not saved) and shown by
`documents.js openPaths` after the document opens.

**S4.5 ag-psd fixes.** `scripts/vendor-entries/ag-psd.js` imports `./ag-psd-fixes.js`, which imports
`./ag-psd-grdm.js` (0.4), `./ag-psd-layers.js` (psd-layers) and `./ag-psd-text.js` (psd-text); each fix wraps a handler
in ag-psd's `infoHandlersMap` / `resourceHandlersMap` as `ag-psd-grdm.js` does (no text patches of the bundle), is
idempotent, and exports `patched: boolean`. Node tests that read or write PSDs import
`scripts/vendor-entries/ag-psd-fixes.js` first (the renderer gets the fixes through the bundle, rebuilt by
`npm install` / `node scripts/build-vendor.mjs`). The entry also exports `readAbr` and `readCsh` (ag-psd's own parsers).
ICC profiles are not an ag-psd matter: resource 1039 is written and read at the byte level (S5); ag-psd 31 only knows it
under `MOCK_HANDLERS`.

#### S5. Container chunks (`lib/io-chunks.js`, `lib/io-chunks/*.js`, skeleton; no package edits them)

The one place that reads and writes ICC profiles, EXIF, XMP, IPTC and resolution in JPEG, PNG, TIFF, WebP and PSD.
Pure (Node-testable), byte level, async (PNG's zlib goes through `src/shared/zip.js streamCodecs`).

```ts
type ChunkFormat = 'jpeg' | 'png' | 'tiff' | 'webp' | 'psd';
interface Chunks {
  icc?: Uint8Array | null;        // the profile's bytes
  exif?: Uint8Array | null;       // a TIFF-structured EXIF block ("II*\0…" / "MM\0*…"), without JPEG's "Exif\0\0"
  xmp?: string | null;            // the packet as text
  iptc?: Uint8Array | null;       // IPTC-IIM records
  resolution?: { x: number, y: number, unit: 'in' | 'cm' | 'none' } | null;    // pixels per unit
}
chunkFormatFor(nameOrExt): ChunkFormat | null           // jpg/jpeg, png, tif/tiff, webp, psd/psb
readChunks(bytes, format): Promise<Chunks & { damaged?: true }>      // never throws
writeChunks(bytes, format, chunks: Partial<Chunks>): Promise<Uint8Array>   // replaces the kinds given (null removes one),
                                                       // keeps every other byte; returns `bytes` itself for an empty patch
chunkSupport(format): { read: Kind[], write: Kind[] }
registerChunkProvider({ id, order, kinds: Kind[], provide(doc, { format, purpose: 'save' | 'copy' | 'export', opts }): Partial<Chunks> | null }): void
chunksFor(doc, info): Partial<Chunks>                   // the providers in order; a later provider overrides a kind
```

Where each kind sits (the skeleton writes all of it, with unit tests on byte arrays the tests build: PNG through
`pixels/png.js`, TIFF through `pixels/tiff.js`, PSD through ag-psd, small JPEG and WebP files as byte constants):

| Format | ICC | EXIF | XMP | IPTC | Resolution |
|---|---|---|---|---|---|
| JPEG | APP2 `ICC_PROFILE\0` + seq/count, split at 65 519 bytes | APP1 `Exif\0\0` | APP1 `http://ns.adobe.com/xap/1.0/\0` (standard packet) | APP13 `Photoshop 3.0\0`, 8BIM 0x0404 | APP0 JFIF density |
| PNG | `iCCP` (zlib; writing removes `sRGB`, `gAMA`, `cHRM`) | `eXIf` | `iTXt` `XML:com.adobe.xmp` | read only: ImageMagick's `zTXt` `Raw profile type iptc` | `pHYs` |
| WebP | `ICCP` (the file becomes VP8X: canvas size read from the VP8 / VP8L header, flags set) | `EXIF` | `XMP ` | — | — |
| TIFF | tag 34675 | read and write in 0.6 (metadata-io) | tag 700 | tag 33723 | tags 282, 283, 296 |
| PSD | resource 1039 | 1058 | 1060 | 1028 | 1005 |

TIFF writes rebuild IFD0 at the end of the file (entries sorted, values over 4 bytes appended, the header's offset
updated, both byte orders, the next-IFD pointer kept); every other byte stays.

**Where it runs.** Open: `openDocument` reads the chunks of JPEG, PNG, TIFF, WebP and PSD files before decoding and
hands them to the colour pipeline (S6.3). Save: `encodeForPath` and `depth.js`'s own 16-bit PNG save call
`writeChunks(bytes, format, chunksFor(doc, { format, purpose, opts }))` after encoding. **In 0.5 the only provider is
icc-engine's `'icc'`**: with no provider (the stub period) every file is byte-identical to 0.4's. `file-info.js` keeps
stamping XMP into saved PSDs and reading EXIF/XMP on open as in 0.4; metadata-io (0.6) moves that onto providers and
this reader.

#### S6. Colour pipeline (`lib/color/pipeline.js`, skeleton; the engine is icc-engine's)

**S6.1 Engine slot.**

```ts
interface ColorProfile { id: string /* sha-1 hex of bytes, or a built-in id */; name: string; bytes: Uint8Array | null;
  colorSpace: 'rgb' | 'gray' | 'cmyk' | 'lab'; wellKnown: 'srgb' | 'display-p3' | 'adobe-rgb' | 'prophoto' | 'gray-gamma-2.2' | null;
  source: 'builtin' | 'embedded' | 'system' | 'user' }
export const SRGB: ColorProfile               // { id: 'srgb', name: 'sRGB IEC61966-2.1', bytes: null, colorSpace: 'rgb', wellKnown: 'srgb', source: 'builtin' }
setColorEngine(engine: ColorEngine): void     // icc-engine, from lib/color/cmm.js install(); the later wins
colorEngine(): ColorEngine                    // the stub until then: id 'none', available false, decodeConversion 'default',
                                              // adoptOnOpen nothing, displaySpace 'srgb', transform identity, parse null,
                                              // builtins and profiles [SRGB]
interface ColorEngine {
  id: string; available: boolean; ready(): Promise<void>;
  parse(bytes): ColorProfile | null; builtins(): ColorProfile[]; profiles(): Promise<ColorProfile[]>;   // + OS and user profiles
  transform(from, to, { intent = 'perceptual', bpc = true, format }): { identity: boolean, apply(src, dst, n): void }
  decodeConversion(chunks, format): 'default' | 'none';
  adoptOnOpen(doc, { chunks, format }): void;
  displaySpace(view): 'srgb' | 'display-p3';       // the display transform itself is a display stage (S6.4)
}
```

**S6.2 The document profile.** `doc.profile: ColorProfile | null` (document.js, skeleton). `null` is "untagged" and is
read as the working RGB space, `workingRGB()` (sRGB in 0.5; color-settings sets it in 0.6 through
`setWorkingSpaces({ rgb, gray, cmyk })`). In 0.5 every document stores RGB numbers; `doc.profile` is an RGB or Gray
profile. `.pigment`: `describe().profile = { id, name, colorSpace, wellKnown } | null` and the bytes as zip entry
`profile.icc`; `readPigment` restores it (a 0.4 file has neither: `null`; a 0.4 reader ignores both). Image > Duplicate
copies it; `cloneDocument` (smart objects) copies it; a smart object whose document has another profile renders its
numbers unconverted in 0.5 (known gap, linked-smart-objects 0.7). Undo: `assignProfile(app, doc, profile, label)`
(pipeline.js) is one history entry that swaps `doc.profile` and calls `doc.changed('props')`.

**S6.3 Open and save.** `openDocument`: `chunks = await readChunks(bytes, format)`; `conv =
colorEngine().decodeConversion(chunks, format)` is passed to `decodeImage(bytes, name, { colorSpaceConversion: conv })`
for JPEG, PNG and WebP (stub: `'default'`, 0.4's: Chromium converts tagged images to sRGB); after the document is built,
`colorEngine().adoptOnOpen(doc, { chunks, format })` (stub: nothing, `doc.profile` stays null). icc-engine answers
`'none'` only when it adopts the embedded profile: untagged files (and PNGs with only `gAMA` / `sRGB`) decode as in 0.4.
TIFF, 16-bit PNG, GIF and PSD decoders never convert. Save:
icc-engine's chunk provider `'icc'` embeds `doc.profile.bytes` when the document is tagged, unless `opts.embedProfile ===
false` or `opts.convertTo === 'srgb'` (then the pixels were converted and nothing, or sRGB, is embedded as
save-options-common-formats will offer in 0.6). Placing or pasting pixels from another profile copies numbers in 0.5
(known gap; the 0.6 policy hook converts).

**S6.4 Display.** `canvas-view.js paint()` draws `toDisplay(postProcessed, view, { damage })` (pipeline.js: runs the
display stages) where `postProcessed` is 0.4's `view.postProcess` result (proof colours, isolation and the previews keep
working on document numbers). Display stages run in order: `registerDisplayStage({ id, order, active(view), apply(canvas, view, { damage })
})`; soft-proofing (0.6) registers at 100, icc-engine's display transform (document profile → the view canvas's space)
at 900. Stub: no stage, the composite itself. The view's 2D context is created with
`{ colorSpace: displaySpace(view) }` (stub `'srgb'`); when the answer changes (document activation, the preference,
`'color:display-changed'`), the view swaps its `<canvas class="view">` for a new element with the new colour space
(ruler listeners bound once, canvas listeners per element; `view.canvas`
is the live element, which `dialogs.js` and the sessions read at call time). **Damage:** `Compositor.damage` (compositor.js, skeleton) is set by every
full view composite: `null` when it returned the last canvas unchanged (`lastPath 'same'`), the repainted region's rect
(`'region'`), the document rect (`'full'` and every other path); a display stage converts only the damage and keeps its
converted copy. Targets for icc-engine: sRGB and untagged documents cost nothing (stage inactive); a 2000 × 2000 damage
converts in under 60 ms on the CI runner.

**S6.5 Conversions** (pipeline functions dispatching to the engine; stubs in brackets): `convertColor(rgb, from, to)`
[identity], `toLab(rgb, profile)` / `fromLab(lab, profile)` [`pixels/color.js` sRGB D65, 0.4's numbers], `toSRGB(canvas |
ImageDataLike, doc)` ['Convert to sRGB' in Save for Web and Image Processor; identity], `convertCanvas(canvas, from, to,
opts)` [identity], `cssColor(rgb, doc)` [`'#rrggbb'`; with an engine, a colour the UI can show for a number in the
document's space, `color(display-p3 …)` where needed], `describe(doc)` ['' when no engine is available, else "Untagged
RGB" or the profile's name, with the depth: "Display P3 (16bpc)"], `profilesList()` [`[SRGB]`]. CMYK numbers stay 0.3's
naive model until color-settings (0.6).

**S6.6 UI placed by the skeleton.** New Document dialog: "Color Profile" select from `profilesList()` (stub: "sRGB
IEC61966-2.1", "Don't Color Manage This Document"), stored in `newDocPreset.profile` and applied with `doc.profile` (sRGB
chosen means `null`, untagged, as 0.4). Status bar segment `profile` and the Info panel row "Profile" show `describe(doc)`
and are absent while it is ''. `bridge.listColorProfiles(): Promise<{ path, name }[]>` lists the operating system's
profile folders (macOS `/Library/ColorSync/Profiles`, `~/Library/ColorSync/Profiles`; Windows
`%WINDIR%\System32\spool\drivers\color`; Linux `/usr/share/color/icc`, `~/.local/share/icc`), names from the file names;
the browser bridge returns `window.__pigmentTest.colorProfiles ?? []`.

**S6.7 Depths and modes.**

| Document | What the profile means in 0.5 |
|---|---|
| RGB, 8/16/32-bit | the numbers of every layer (8-bit canvases and `deep` planes) are in `doc.profile`; 32-bit stays display-referred (0.3) |
| Grayscale, Duotone | an RGB or Gray profile; a Gray profile's tone curve is applied to each channel for display |
| Indexed | the colour table is in `doc.profile` |
| CMYK, Lab, Multichannel (channel views) | `doc.profile` is RGB; a tagged CMYK or Lab file opens as 0.3 converts it (the readers convert before the profile is seen) and an open notice says its profile was not used; profile-based conversion is color-settings' (0.6), real CMYK 0.10 |
| Bitmap | no profile |

Assign Profile changes `doc.profile` only; Convert to Profile (0.6) changes numbers. Policy hooks for 0.6:
`registerColorPolicy({ onOpen(doc, info), onPaste(doc, info) })`; `documents.js` awaits `onOpen` after a document is
built and before `'doc:opened'` (stub: none registered); `onPaste` is called by the 0.6 skeleton step in `edit-ops.js`.

#### S7. Colour UI (`lib/color-picker.js`, stub by the skeleton; owned by color-picker-swatches)

**S7.1 One picker.** Every colour the user chooses goes through `app.colorPicker`:

```ts
interface ColorValue { hex: '#rrggbb';                 // what painting uses: RGB numbers in the document's profile
  rgb: [number, number, number];                        // 0..255
  lab?: [number, number, number]; cmyk?: [number, number, number, number];   // when chosen in that model or from a book
  book?: { book: string, name: string } | null;  space: 'rgb' | 'hsb' | 'lab' | 'cmyk' | 'book' }
app.colorPicker.pick({ initial: ColorValue | string, title?, live?(c: ColorValue): void, doc? = app.doc,
                       target?: 'foreground' | 'background' | 'field' | 'stop' | 'text' | 'effect' | 'swatch',
                       allowBooks? = true }): Promise<ColorValue | null>
app.colorPicker.hud({ at: { x, y } /* screen */, tool, initial }): Promise<ColorValue | null>   // stub: resolves null
app.pickColor(initial, { title, live }): Promise<'#rrggbb' | null>   // 0.4's API, kept: pick() returning hex, live gets hex
```

Stub (`real: false`): 0.4's picker dialog moved verbatim from `extras.js` (S7.4's DOM included), `pick` wraps it and
builds the `ColorValue` from the hex. `tool:pick-fg` / `tool:pick-bg` (app.js) call `pick({ target })`; the foreground and
background stay `settings.foreground` / `.background` hex strings (0.4), set through `app.setColors` (which applies
`app.colorConstraint` for the image modes). Lab and CMYK fields go through `toLab` / `fromLab` (S6.5) and 0.3's CMYK
model; swatch chips are painted with `cssColor` so they match the canvas.

**S7.2 Swatches and books.** Kind `swatches` (registered by the skeleton with `DEFAULT_SWATCHES` as built-ins;
color-picker-swatches re-registers it with groups): `data = { color: { space: 'rgb' | 'lab' | 'cmyk' | 'gray', values:
number[] /* rgb 0..255, lab L 0..100 a b -128..127, cmyk and gray 0..100 */ }, book?: { book, name } }`, the name on the
preset. color-picker-swatches migrates 0.4's `settings.swatches` (when `swatchesEdited`) into the kind once
(`settings.colorUI.swatchesMigrated`); `settings.recentColors` stays where it is. Kind `color-books`: one preset per
loaded book, `data = { title, colorSpace, count, blob: 'book-<sha1>.json' }` with the entries in the side file (.acb
reader by color-picker-swatches; no licensed books are shipped). preset-files-manager's .aco / .ase formats read and
write the `swatches` data above.

**S7.3 The `color` field widget** (fields.js, skeleton): `form.js` field type `color`, the options-bar kind `color`
(tools.js), the `paint` widget's solid colour, the Character panel's two colour inputs (`char-format.js`),
`shape-paint-ui.js` and `lens-correction.js` build `createWidget('color', spec, …)`; value `'#rrggbb'`. Stub widget:
0.4's DOM exactly (an `<input type="color" data-key=…>` plus, in forms, the hex text input). color-picker-swatches
registers the real one: a swatch button that opens `pick({ target: 'field' })`, **keeping** an `input[type="color"]`
with the field's `data-key` whose `input` event sets the value (it may be visually hidden: `hunt.spec.mjs:169`,
`guides-snapping.spec.mjs:456` set colours through it).

**S7.4 DOM the specs rely on** (kept by color-picker-swatches): the dialog's class `color-picker-dialog`; inputs
`[data-f="h|s|v|r|g|b|hex"]` and `[data-m="L|a|b|c|m|y|k"]`; OK as `.dialog-buttons .btn.primary`; a field commits on
`blur` and `change` (`text-color.spec.mjs:278`, `modes.spec.mjs:685`).

#### S8. Camera Raw: develop stages (`src/shared/pixels/develop-stages.js`) and registry (`lib/develop/registry.js`) — skeleton

**S8.1 Stages** (pure; Node tests, smart filters and actions run them). 0.2's `develop()` becomes a loop over
registered stages; with the 0.4 stages its output is identical (unit test against a frozen copy of the 0.4 function on
random images and every control).

```ts
registerDevelopStage({
  id: string, order: number, space: 'linear' | 'perceptual' | 'resample',
  params?: { ns: string, defaults(): object, normalize?(v): object },   // the namespace of params this stage owns
  neutral(p): boolean,                    // true: skipped
  margin?(p, w, h): number,               // px read around a pixel (selection-limited previews)
  apply(planes: { R, G, B: Float32Array, w, h }, p, ctx: { processVersion, rect, docWidth, docHeight, seed }): void
                                          // 'resample' stages may replace the planes with same-size new ones
  xmp?: { [paramPath]: { name: 'crs:…', scale?: number, offset?: number } }    // sidecar and preset mapping (S8.4)
}, { builtin? })                          // same id: the later wins; a builtin never replaces an earlier registration
developStages(): stage[];  developDefaults(): object;  normalizeDevelopParams(p): object   // registered namespaces' defaults merged
develop(img, params, rect = null): ImageDataLike    // 0.2's signature
```

Order: `'resample'` stages first (geometry and optics, 50–90); then linear (white balance 100, exposure 200, profile
250, calibration 280); the conversion to perceptual values; then tone 300, texture/clarity 400, dehaze 450, colour
500 (vibrance, saturation), HSL / Color Mixer 510, treatment (B&W) 520, colour grading 530, curve 540, noise reduction
600, sharpening 650, effects (vignette 700, grain 800). The skeleton registers 0.4's steps as builtin stages with
these ids: `white-balance`, `exposure`, `tone`, `texture-clarity`, `dehaze`, `vibrance-saturation`, `hsl`, `noise`,
`sharpen`, `vignette`, `grain`, plus `treatment` (`p.treatment: 'color' | 'bw'`, default `'color'`; B&W is a luminance
mix with 0.3's Black & White weights; camera-raw-panels may replace it with the Color Mixer's B&W mix). `develop.js`
imports `develop-more.js` (camera-raw-panels' stub) and `develop-profile.js` (camera-raw-workspace's stub), both empty,
after the registry module and before registering the builtins,
so no import cycle arises and the builtin rule keeps the package's stages. **Process version:** `p.processVersion`,
absent = 1 (every 0.2–0.4 smart filter and recorded step); the 0.5 workspace writes 2 for new edits and keeps an
existing filter's version until the user updates it. A stage whose output changes for existing params keeps its version
1 path (camera-raw-panels' dark-channel dehaze is version 2 only).

**S8.2 Registry** (renderer).

```ts
registerDevelopTab({ id, label, order, modes?: string[] }, { builtin? })
registerDevelopSection({ tab, id, label, order, fields?: FieldSpec[] | ((mode) => FieldSpec[]), render?(ctx): HTMLElement,
                         test?(ctx): boolean }, { builtin? })
                         // ctx: { params, get(path), set(path, value), app, session, workspace | null }
registerDevelopTool({ id, label, icon, key?, order, cursor, activate?(ws), deactivate?(ws), down(p, ws), move?(p, ws, dragging),
                      up?(p, ws), overlay?(ctx, ws) })       // zoom, hand, white balance, sampler, targeted adjustment, guided Upright
registerWorkspaceSlot({ id, place: 'toolbar-start' | 'toolbar-end' | 'panel-top' | 'footer-start' | 'footer-end' | 'filmstrip', order,
                        render(ws): HTMLElement })           // raw-open-workflow (0.6) adds the filmstrip and output buttons
developTabs(): tab[]     // with their sections, in order
```

The skeleton registers 0.4's four tabs as builtins from `lib/develop/tabs-04.js`: `basic` (sections `white-balance`,
`tone`, `presence`), `detail` (`sharpening`, `noise`), `hsl` (modes hue / saturation / luminance), `effects` (`vignette`,
`grain`), with 0.4's fields. camera-raw-workspace replaces `basic`'s `white-balance` section and adds `profile`;
camera-raw-panels replaces `presence`, `detail`'s sections, `hsl` (Color Mixer, same tab id), `effects`, and adds the
tabs `curve`, `color-grading`, `optics`, `geometry`, `calibration`.

**S8.3 The dialog the skeleton lands** (develop-ui.js, then camera-raw-workspace's): `developEditor` builds its tabs and
sections from `developTabs()`, with 0.4's DOM, which `extras.spec.mjs` uses and the workspace keeps: the root
`.camera-raw` inside a `.dialog`, `button[data-action="auto"|"reset"]`, tabs `.dialog-tab[data-tab=<id>]` (ids `basic`,
`detail`, `hsl`, `effects` stay), number inputs `input[type="number"][data-key=<param path>]` (`exposure`,
`hsl.<range>.<mode>`, `vignette` stay), and the live preview through the pixel-edit session (`session.show`), so the
document's composite shows the preview while the dialog is open. OK records one "Camera Raw" entry; on a smart layer the
params become the smart filter (0.2), with `processVersion`.

**S8.4 Presets, snapshots, settings.** Kinds `camera-raw-presets` (`data = { params: partial params, groups: string[] }`,
the section ids it sets) and `camera-raw-snapshots` (`data = { params, document: name }`), registered empty by the
skeleton, re-registered by camera-raw-workspace. `.xmp` settings files map through the stages' `xmp` maps (unmapped
fields reported, never invented); the skeleton writes the names for 0.4's fields (`crs:IncrementalTemperature`, `crs:Exposure2012`, …,
`crs:HueAdjustmentRed`, …, `crs:GrainAmount`); camera-raw-workspace owns the reader, the writer and the scales. Numbers are document numbers: the stages read them with the
sRGB tone curve whatever `doc.profile` says (a known approximation until raw-open-workflow's scene-linear path).

#### S9. Keymap store (`lib/keymap-store.js`, skeleton) and menu customisation

**S9.1 Tables** (`src/shared/keymap.js`): 0.4's `MENU_KEYS` (command → accelerator), `RENDERER_KEYS` (command →
accelerators), `TYPE_KEYS` (type sessions) and the new `PAINT_KEYS` (command → accelerators, considered only while
`paints(app.tools.active)`, S13.4). An **overlay** holds the user's differences:

```ts
interface KeyOverlay { v: 1; menu?: { [cmd]: string | null }; renderer?: { [cmd]: string[] }; type?: { [cmd]: string | null };
                       paint?: { [cmd]: string[] } }        // an entry replaces the default; null / [] removes the binding
effectiveKeys(overlay | null): { menu, renderer, type, paint }      // pure, src/shared (main, renderer and Node use it)
keyConflicts(effective, sources = []): { accel, scope: 'global' | 'type' | 'paint', commands: string[] }[]
                    // global = menu ∪ renderer; a paint key shadowing a global key is by design, not a conflict
```

**S9.2 Store.**

```ts
app.keymap: {
  effective(): ReturnType<typeof effectiveKeys>;           // with the key sources' "over" entries removed (S9.3)
  overlay(): KeyOverlay;  set(cmd, accels: string[] | null, { table }): Conflict[];  reset(cmd?): void;
  sets(): Preset[];  activeSet(): string;  useSet(id): Promise<void>;  saveSet(name): Promise<Preset>;  deleteSet(id): void;
  conflicts(): Conflict[];  resolveKey(cmd, source): string;   // S13.4
  registerKeySource(id, list: () => { accel, label, priority: 'over' | 'under' }[]): () => void;  refreshSources(): void;
  menus(): MenuCustom;  setMenus(m: MenuCustom): void;
}
interface MenuCustom { set: string; hidden: string[]; colors: { [itemKey]: 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'violet' | 'gray' }; showAll: boolean }
// itemKey: the command id, or `${cmd}|${JSON.stringify(arg)}` for an item with an argument
```

Persistence: `settings.keymap = { set: 'photoshop-defaults', overlay: { v: 1 }, menus: { set: 'default', hidden: [],
colors: {}, showAll: false } }` (the active overlay is a copy in settings, so start-up needs no preset I/O); named sets
are presets of kind `keyboard-shortcuts` (`data: KeyOverlay`; built-in `photoshop-defaults`, an empty overlay) and menu
sets of kind `menu-sets` (`data: { hidden, colors }`; built-in `default`). Every change saves settings and emits
`'keymap:changed'`; `shortcuts.js` rebuilds its table on it; `app.syncUiState` sends `keymap: JSON.stringify(overlay)`
and `menus: JSON.stringify(menus)` (strings: the ui state compares by identity).

**S9.3 Key sources.** `lib/actions.js` (skeleton call, marked) registers the actions' function keys with priority
`'over'`: an application binding on the same key is dropped from `effective()` (the menu shows no accelerator, the page
ignores it) while the action owns the key, on every platform (0.3 left "who wins" unverified; on macOS the menu would
otherwise win). The actions engine calls `app.keymap.refreshSources()` when an action's key changes.

**S9.4 Dispatch.** `shortcuts.js` builds its table from `app.keymap.effective()` (0.4's sort and text-field rules
unchanged). `main.js` reads `uiState.keymap` (recomputing `effectiveKeys` when it changes) for its Shift+Alt
interception; the menu template does the same for accelerators.

**S9.5 Native menu** (`menu-template.js`, skeleton): `item()` takes its accelerator from
`effectiveKeys(JSON.parse(state.keymap ?? 'null')).menu[cmd]` (explicit `accelerator` options of 0.4 stay); an item
whose `itemKey` is in `menus.hidden` is left out unless `menus.showAll`; a menu that lost items ends with a separator and
"Show All Menu Items" (`edit:show-all-menu-items`); a coloured item carries `pigmentColor: <name>`, which `main.js`
turns into a 12 px coloured-dot `icon` (`nativeImage.createFromBitmap`, made once per colour) before
`Menu.buildFromTemplate` (Electron menus have no item colour). Hidden and coloured items apply to the application menus
only; panel menus are popovers and are not customisable in 0.5.

#### S10. Preset files (`lib/preset-formats.js`, skeleton) and the 0.5 preset kinds

**S10.1 Formats.** 0.4's `registerPresetFormat(kind, fmt)` (C) stays for one-kind formats. Files that hold several
kinds (.abr: brushes and their patterns; .asl: styles and patterns; .tpl: tool presets and brushes) or no preset-store
kind (.atn, 0.8) register here:

```ts
registerPresetFileFormat({ id, name, extensions: string[], kinds: string[],
  read?(bytes, ctx: { name }): Promise<{ items: { kind, ref?: string, name, group?: string, data, blobs?: { [name]: Uint8Array } }[],
                                         groups?: { kind, id, name, parent? }[], report: string[] }>,
  write?(selection: { kind, presets: Preset[] }[], ctx: { readBlob(kind, name) }): Promise<Uint8Array>,
  import?(app, bytes, ctx): Promise<{ added: number, report: string[] }> })     // formats outside the preset store (.atn)
presetFileFormats({ kind?, write? }): format[]        // both registries, kind formats first, '*' (.pigment-presets) last
presetFileFormatFor(nameOrExt): format | null
```

Links between items of one file: an item may carry a file-local `ref`, and data may hold `{ $presetRef: { kind, ref } }`
anywhere; the importer adds the referenced items first and replaces each placeholder with `{ presetId, name }` of the
new preset (a brush's texture pointing at a pattern of the same .abr).

**S10.2 Import.** `importPresetFiles(app, { paths?, kinds? }): Promise<{ added: { [kind]: number }, report: string[] }>`:
without paths it shows the open dialog filtered by the registered extensions (all, or those of `kinds`); each file goes
to the format of its extension, its items to their kinds (`app.presets.ready(kind)` first, blobs through `writeBlob`); a
toast lists what was added, a dialog lists the report lines when there are any. `presetFileMenuItems(app, kind, {
selectedIds })` returns the popover items Import…, Export Selected…, Export All… for a panel menu.

**S10.3 Export.** `exportPresetsDialog(app, kind, ids | null, { title })`: the save dialog offers every format that
writes `kind`, `.pigment-presets` first (0.4's default); the typed extension picks the format. `gradient-editor.js
exportPresets` and `pattern-picker.js exportPatterns` call it (skeleton), so registering .grd or .pat does not change
what Export writes by default.

**S10.4 Opening and dropping.** `documents.js openPaths` and `app.js`'s window drop send a file whose extension
belongs to a preset file format and to no open format to `importPresetFiles` instead of opening it (Photoshop opens
.abr, .grd, .pat this way). `OPEN_FILTERS` gains a "Presets" filter listing those extensions.

**S10.5 Kinds of 0.5** (registered by `registerPresetKinds05()` in `preset-kinds.js`, called with
`registerPresetKinds04()` in `start()`; owners re-register with full definitions):

| Kind | `data` | Built-ins from the skeleton | Owner |
|---|---|---|---|
| `brushes` | `BrushPreset` (S1) | 0.4's `BUILTIN_BRUSHES` | brush-settings-panel |
| `swatches` | S7.2 | `DEFAULT_SWATCHES` | color-picker-swatches |
| `color-books` | S7.2 | none | color-picker-swatches |
| `color-profiles` | `{ name, colorSpace, blob: 'icc-<sha1>.icc' }` (user profiles, so the browser build has them too) | none | icc-engine |
| `camera-raw-presets`, `camera-raw-snapshots` | S8.4 | none | camera-raw-workspace |
| `keyboard-shortcuts`, `menu-sets` | S9.2 | `photoshop-defaults`, `default` | shortcuts-editor (the skeleton's store reads them) |
| `styles`, `shapes`, `tool-presets` (0.4 kinds) | C | as 0.4 | presets-panels |

`tool-presets` data grows to `{ tool, options /* a copy of settings.tools[tool], brush included */, color?: '#rrggbb'
}`. Pigment-made libraries (Dry Media brushes, swatch books of its own, shape sets…) are `.pigment-presets` files under
`src/renderer/presets/` that the Preset Manager and the panels' menus offer to load; they are not built-ins (built-ins
are synchronous code and stay small).

#### S11. Type: the font catalog, text render stages, TextLayer fields

**S11.1 Font catalog** (`lib/type/api.js`, skeleton slot; type-fonts registers the real one from `font-library.js`).

```ts
registerFontCatalog(catalog: FontCatalog): void;  fontCatalog(): FontCatalog
interface FontCatalog {
  ready(): Promise<void>;                  // system names (queryLocalFonts index, no font bytes), bundled and added fonts
  families({ search?, classes?: FontClass[], favourites?: boolean } = {}): FamilyEntry[];   // sync after ready
  family(name): FamilyEntry | null;  styles(family): StyleEntry[];
  resolve(style /* resolved CharStyle */): { family, postScriptName: string | null, weight, italic, axes: object,
                                             synthetic: { bold: boolean, italic: boolean }, missing: boolean, substitute: string | null };
  axes(postScriptNameOrFamily): Promise<{ tag, name, min, max, default }[]>;
  addFiles(files: { bytes: Uint8Array, name: string }[]): Promise<FamilyEntry[]>;   // Type > Add Fonts…
  missing(doc): { family, postScriptName, layers: Layer[] }[];
  favourites: { list(): string[], toggle(family): void };  recent: { list(): string[], push(family): void };
}
type FamilyEntry = { name, styles: StyleEntry[], classification: FontClass | null, source: 'system' | 'bundled' | 'user' | 'document',
                     variable: boolean, cssFamily?: string };
type StyleEntry = { name, postScriptName, weight, italic, stretch?: number, instance?: { [axisTag]: number } };
type FontClass = 'serif' | 'sans-serif' | 'slab-serif' | 'script' | 'handwritten' | 'monospace' | 'decorative' | 'blackletter';
```

`api.js`'s default catalog is empty; the stub `lib/type/font-library.js` registers 0.4's equivalent: families from
`tools/text.js fontFamilies()` (its static list plus `queryLocalFonts` names; `onFontsChanged` → the event), styles from
its `STYLES` (Regular … Black and their italics, synthesised), `resolve` through `fonts.js faceFor` / `hasFamily`
(`missing: !hasFamily(family)`), `missing(doc)` → `[]`, `addFiles` → `fonts.addFontData`; `real: false`. (The catalog
and widgets live in that file, not in `api.js` or `fields.js`, which `tools/text.js` must not be imported into.) Emits `'type:catalog-changed'` on `app` when its lists change. psd-text maps PostScript names
through `resolve`; type-fonts' missing-font check runs on `'doc:opened'`.

**S11.2 Font widgets** (registered by the `font-library.js` stub, E7): option kinds `font-family` and `font-style`,
value the family name and the style key (`'400'`, `'700i'`, or a PostScript name once type-fonts lands); the stubs are
0.4's selects (`.opt[data-key="family"] select`, `.opt[data-key="style"] select`; options from `spec.options`, which
`tools/text.js` keeps filling through `setFamilyOptions`). The type tools' options
use these kinds (skeleton change in `tools/text.js`). The Character panel's controls are replaced through E26
(`registerTypeSection('character', { replaces: 'family' | 'style' })`).

**S11.3 Text render stages** (`lib/type/api.js`, skeleton):

```ts
registerTextRenderStage({ id, order, test(layer): boolean,
  render(layer, next: () => { canvas, x, y }, layout): { canvas, x, y },   // wrap next() (post-process) or draw from outlines
  bounds?(layer, next: () => Rect, layout): Rect,
  whileEditing?: 'bypass' | 'apply' })                                       // default 'bypass'
setEditing(layer, on: boolean): void      // tools/text.js (skeleton) calls it around a type session
```

`renderText` and `textBounds` apply the stages whose `test` passes, in order, each wrapping the next, the engine's
render innermost. While a session edits a layer, `'bypass'` stages are skipped (warped text is edited unwarped in 0.5,
a known difference from Photoshop). type-menu-commands registers `warp` (order 100) and `anti-alias` (order 200: None,
Sharp, Crisp, Strong drawn from glyph outlines with its own coverage rasteriser; Smooth is the engine's own; Windows
LCD and Windows are drawn as Smooth and Sharp and the docs say so). Glyph outlines: type-menu-commands builds them in
`outlines.js` from `layoutText(layer)` runs (`units`, `face`, `size`) and `fonts.js unitOutline` (type-fonts keeps these,
see the ownership table); text drawn by the Canvas stub engine has no outlines and the commands that need them say so.

**S11.4 TextLayer fields** (model.js, skeleton; all already travel through `describe`, `cloneLayer` and the
`setLayerProps` snapshot because they live in `content` or `typeOptions`):

| Field | Default | Meaning | `.pigment` | PSD (psd-text) |
|---|---|---|---|---|
| CharStyle `axes` | `{}` | variable-font axis values `{ wght: 650, wdth: 90 }`; sparse | in `content` (0.4 readers drop the unknown attribute) | not in Photoshop's text engine data: written as the named instance's PostScript name when one matches, else reported |
| CharStyle `postScriptName` (0.4) | `null` | the real face | in `content` | `FontSet` names (S11.1) |
| `typeOptions.antiAlias` (0.4) | `'smooth'` | `'none' \| 'sharp' \| 'crisp' \| 'strong' \| 'smooth' \| 'lcd' \| 'windows'` | `typeOptions` | `AntiAlias` |
| `typeOptions.warp` | `null` | `{ style: WARP_PRESETS id other than none / custom, horizontal: true, bend: -100..100, hDistort: -100..100, vDistort: -100..100 }` | `typeOptions` | `warp` (style, value, perspective, perspectiveOther, rotate) |

`normalizeTypeOptions` normalises `warp` (unknown style or all values 0 with style `none` → `null`); the model's value
check accepts `axes` as a plain object of finite numbers keyed by four-character tags; `CHAR_KEYS` grows to 25
(`tests/unit/type-model.test.mjs:26` updated by the skeleton).

**S11.5 TypeTool for subclasses.** `tools/text.js` keeps `export class TypeTool` and these methods for subclasses (the
Type Mask tools): `beginNew(at, box, opts)`, `openEditor()`, `closeEditor()`, `commitSession()`, `cancelSession()`,
`dropNew(session)`, `fontFromOptions()`. A mask tool overrides `commitSession` (closes the editor, turns the text into a
selection, drops the temporary layer: one history entry "Type Mask") and draws its own overlay.

#### S12. Move tool depth and toolbox plumbing

**S12.1 Toolbox** (tools.js, skeleton): `app.tools.registerOptionsSlot({ id, place: 'title' | 'start' | 'end', order,
render(tool, bar): HTMLElement | null })` (the options bar renders slots around a tool's own options; `'title'` replaces
the tool icon and name: presets-panels' tool preset picker); `app.tools.resetOptions(toolId | '*')` (deletes
`settings.tools[id]`, re-renders, emits `'tool:options'` with key `'*'`); `app.tools.setCursorFilter(fn)` (S3.2).
`BRUSH_OPTIONS` lives in `lib/brush/options.js` (brush-engine-core; tools.js re-exports it) with `PAINT_BLEND_OPTIONS`
(0.4's list; brush-engine-core adds Behind, Clear, Dissolve).

**S12.2 Transform grab** (image-ops.js, skeleton): `app.transformTool.start({ mode, selectionOnly, grab?: { pointer:
PointerSample, handle: 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate' | 'move' } })`: after the session
starts and the transform tool is active, it continues the pointer drag in progress as if it had started on that handle
(the routed moves reach the transform tool; canvas-view asks `currentTool()` per event). One "Free Transform" history
entry on commit, as 0.4.

**S12.3 Save options** (documents.js, skeleton): `registerSaveOptions(formatOrExt, { ask(app, doc, path, { ask:
boolean }): Promise<object | null> /* null cancels the save */ })`; `writeTo` merges the answers into the options
`encodeForPath` gets. 0.4's JPEG/WebP quality (asked once per document, `doc.saveOpts`, `settings.saveQuality`) is the
built-in registration for jpg/jpeg/webp. psd-layers registers `psd` (Maximize Compatibility: `opts.maximizeCompatibility`,
default true as 0.4 always wrote the composite).

**S12.4 Last Filter for commands** (filter-ui.js, skeleton): `app.filterEditor.rememberCommand(id, name, arg)` stores
`settings.lastFilter = { command: id, name, params: arg }`; `filter:last` runs `app.commands.run(command, params,
'api')` for such an entry (0.4 entries with `kind` behave as before); the label is "Last Filter: <name>".

**S12.5 Move tool** (move-tool-depth): tool options `autoSelect` (0.4 key, boolean), `autoSelectTarget: 'layer' |
'group'`, `showTransform` (0.4 key, default true), `alignTo: 'selection' | 'canvas'`. `layer:align` and
`layer:distribute` keep their 0.4 string arguments and also accept `{ edge, to?: 'selection' | 'canvas', gap?: px }`
(`gap` with `'horizontal' | 'vertical'`: Distribute Spacing by a fixed amount). Arrow nudges and Alt+arrow duplicates
are one history entry each; a drag from empty canvas with Auto-Select selects the layers it touches (no history entry);
with the layer mask as the edit target (`app.ui.editingMask`) and the mask unlinked, the Move tool moves the mask alone.
Snap calls (rule 10) stay on every drag.

#### S13. Commands, menus and keys

**S13.1** Every item and binding below lands in the skeleton (`menu-template.js`, `keymap.js`, labels in
`COMMAND_LABELS`, groups in `SHORTCUT_GROUPS`); an item whose command is a stub is disabled (`state.stubs`), as in 0.4.

**S13.2 Menus.** File: Revert gets F12. Edit: Define Brush Preset… before Define Pattern…, Define Custom Shape… after
it; after Purge: Presets ▸ (Preset Manager…, Export/Import Presets…, Migrate Presets), then Color Settings…, Assign
Profile…, Convert to Profile…, then Keyboard Shortcuts…, Menus… (0.4), Preferences… and Camera Raw Preferences…
(macOS: both in the app menu, after Settings…). Type (0.4 items stay): Add Fonts… first; Anti-Alias ▸ after Panels;
after Rasterize Type Layer: Convert to Paragraph Text / Point Text, Warp Text…, Create Work Path, Convert to Shape;
then Font Preview Size ▸, Update All Text Layers, Manage Missing Fonts…, Replace All Missing Fonts, Paste Lorem Ipsum.
Window (`PANELS`): Color, Swatches, Gradients, Patterns, Styles, Shapes, ─, Brush Settings, Brushes, Tool Presets, ─, then
0.4's list. Help: Pigment Help gets F1.

**S13.3 Every new command id.**

| Id (arg) | Menu place | Key | Until the owner lands | Owner |
|---|---|---|---|---|
| `window:panel-brush-settings` | Window | F5 | stub | brush-settings-panel |
| `window:panel-styles`, `-shapes`, `-tool-presets` | Window | none | stub | presets-panels |
| `edit:define-brush` | Edit | none | stub | brush-engine-core |
| `edit:define-custom-shape` | Edit | none | stub | presets-panels |
| `edit:preset-manager`, `edit:export-import-presets`, `edit:migrate-presets` | Edit > Presets | none | stub | preset-files-manager |
| `edit:assign-profile` (`{ profile: id \| null }`) | Edit | none | stub | icc-engine |
| `edit:color-settings`, `edit:convert-profile` | Edit | none | stub (`stubs-later.js`) | color-settings (0.6) |
| `edit:camera-raw-preferences` | Edit (macOS app menu) | none | stub | camera-raw-workspace |
| `edit:menus` (0.4 id) | Edit | Alt+Shift+Ctrl+M (0.4) | stub | shortcuts-editor |
| `edit:show-all-menu-items` | end of a menu with hidden items | none | stub | shortcuts-editor |
| `help:shortcuts` (0.4 id, moved) | Edit | Alt+Shift+Ctrl+K (0.4) | working: 0.4's list from `effective()` | shortcuts-editor |
| `type:add-fonts` | Type | none | stub | type-fonts |
| `type:font-preview-size` (`'none' \| 'small' \| 'medium' \| 'large' \| 'xlarge' \| 'huge'`) | Type > Font Preview Size (radios, `state.fontPreviewSize`) | none | stub | type-fonts |
| `type:manage-missing-fonts`, `type:replace-missing-fonts` | Type | none | stub | type-fonts |
| `type:anti-alias` (S11.4 values) | Type > Anti-Alias (radios, `state.antiAlias`); options-bar select | none | stub | type-menu-commands |
| `type:warp-text` (warp object; none = dialog) | Type; options-bar button | none | stub | type-menu-commands |
| `type:create-work-path`, `type:convert-to-shape`, `type:convert-text-kind`, `type:update-all`, `type:paste-lorem-ipsum` | Type (Convert's label from `state.textKind`) | none | stub | type-menu-commands |
| `type:toggle-orientation` | options-bar button | none | stub | type-menu-commands |
| `tool:brush-preset` (S1.3) | none | none | working (skeleton) | skeleton |
| `tool:airbrush-toggle` | none (options-bar button) | Shift+Alt+P (PAINT) | stub | brush-engine-core |
| `tool:brush-prev`, `-next`, `-first`, `-last` | none | `,` `.` `Shift+,` `Shift+.` | stub | brush-painting-behaviours |
| `tool:opacity-digit-0` … `-9`, `tool:flow-digit-0` … `-9` | none | digits, Shift+digits (PAINT) | stub | brush-painting-behaviours |
| `tool:blend-mode-<mode>`: the 23 modes of `BLEND_MODE_KEYS` other than pass-through, and `behind`, `clear` | none | Shift+Alt+letter (PAINT; Behind Q, Clear R) | stub | brush-painting-behaviours |
| `tool:preset` (id or `{ tool, options }`), `tool:reset` (tool id), `tool:reset-all` | none (tool preset picker) | none | stub | presets-panels |
| `layer:style-preset` (id or `{ styles, blending }`) | none (Styles panel) | none | stub | presets-panels |

Function keys (MENU): F1 `help:guide`, F5 `window:panel-brush-settings`, F6 `window:panel-color`, F7
`window:panel-layers`, F8 `window:panel-info`, F12 `file:revert`. The panel commands keep 0.4's meaning (show and
reveal); Photoshop's F-keys toggle, a recorded difference. Developer Tools moves from F12 to Shift+Ctrl+F12
(development builds only).

**S13.4 Paint keys.** `PAINT_KEYS` holds the PAINT bindings above. `shortcuts.js` tries them first while
`paints(app.tools.active)` and runs the first whose command is enabled; otherwise the global table answers as in 0.4.
On Windows and Linux `main.js` takes Shift+Alt+letter before the page (0.4, O) and sends the global command with
source `'key'`; `app.js` passes it through `app.keymap.resolveKey(cmd, 'key')`, which returns the enabled PAINT
command with the same accelerator while a painting tool is active, else `cmd`. So the electron test `keys-04` (Move
tool active) is unchanged.

**S13.5 Changed bindings and the specs that press them** (grep of `tests/e2e`, `tests/electron` for `keyboard.press`):

| Key | 0.4 | 0.5 | Spec lines | Change |
|---|---|---|---|---|
| F12 | `help:devtools` | `file:revert` | none | |
| F1, F5–F8 | unbound | S13.3 | none (`actions.spec.mjs:341` assigns Shift+F9 to an action) | |
| `,` `.` `Shift+,` `Shift+.` | unbound | brush presets | none | |
| digits, Shift+digits, Shift+Alt+letters with a painting tool active | layer digits disabled; layer blend modes | `tool:*` (PAINT) | `finish-layer-menu.spec.mjs:463–467` presses `2` with the Brush active and expects the layer's opacity unchanged: still true (the Brush's opacity becomes 20 %); `:470`, `:478`, `hunt5-layers-conventions.spec.mjs:251–253` press them with the Move tool | none |
| Shift+Alt+P with a painting tool active | `layer:blend-mode-pass-through` | `tool:airbrush-toggle` when enabled | none | |

**S13.6 UI state** (added keys): `keymap`, `menus` (JSON strings, S9.2), `antiAlias` (the active text layer's),
`textKind` (`'point' | 'paragraph'`), `fontPreviewSize`.

#### S14. Settings and existing specs

**S14.1 Namespaces** (`src/shared/defaults.js`, skeleton; rule 5):

| Key | Owner | Declared sub-keys |
|---|---|---|
| `brushes` | brush-settings-panel (the engine and behaviours read; the skeleton writes `migrated`) | `locks: {}`, `recent: []`, `view: 'thumbs'`, `migrated: false` |
| `brushEngine` | brush-engine-core | `{}` |
| `painting` | brush-painting-behaviours | `cursors: { crosshairInTip: false, crosshairWhilePainting: false, other: 'standard', previewColor: '#ff0000', leashColor: '#4080ff' }`, `hud: { vertical: 'hardness' }`, `digitPairMs: 600` |
| `colorManagement` | icc-engine | `display: 'auto'` (`'auto' \| 'srgb' \| 'display-p3'`), `userProfiles: []` |
| `psd` | psd-layers (psd-text adds its own sub-keys) | `maximizeCompatibility: 'always'` (`'ask' \| 'always' \| 'never'`) |
| `cameraRaw` | camera-raw-workspace (camera-raw-panels reads) | `defaults: null`, `view: { beforeAfter: 'off', clipShadows: false, clipHighlights: false }` |
| `presetPanels` | presets-panels | `currentToolOnly: true` |
| `presetManager` | preset-files-manager | `{}` |
| `colorUI` | color-picker-swatches | `picker: 'pigment'`, `hud: 'hue-strip'`, `swatchesMigrated: false` |
| `typeFonts` | type-fonts | `previewSize: 'medium'`, `favourites: []`, `recent: []`, `sample: 'Sample'` |
| `typeCommands` | type-menu-commands | `{}` |
| `keymap` | skeleton (shortcuts-editor writes through `app.keymap`) | S9.2 |

0.4's flat keys stay: `brush`, `brushPresets`, `swatches`, `swatchesEdited`, `recentColors`, `cursorStyle`, `tools`.

**S14.2 Existing spec lines that pin a 0.4 limitation** (edited by the skeleton so they hold before and after the package
lands; rule 11):

| Line | Pins | Change |
|---|---|---|
| `tests/e2e/extras.spec.mjs:32` | the Camera Raw tab labels, exactly | compares the `data-tab` ids with `arrayContaining(['basic', 'detail', 'hsl', 'effects'])` |
| `tests/e2e/hunt5-styles.spec.mjs:112` (the test at 106) | PSD drops effects and Blending Options, with the notice | 0.4's assertion while `!psdFeatures().effects \|\| !psdFeatures().advancedBlending`; else the drop shadow comes back from the saved file and no "saved without them" toast shows |
| `tests/e2e/adjustment-blending.spec.mjs:358`, `:368`, `:376` | the channel-restriction notice | the same gate on `psdFeatures().advancedBlending` |
| `tests/e2e/masks-vector-masks.spec.mjs:255–259` | the vector mask baked into the PSD's raster mask (J.8) | 0.4's assertions while `!psdFeatures().vectorMasks`; else the PSD layer has the vector path and the raster mask carries the density only |
| `tests/unit/type-model.test.mjs:26` | `CHAR_KEYS.length === 24` | 25 |
| `tests/e2e/skeleton-04.spec.mjs:594–596` | "Cursors and tools", `cursorStyle` | not edited: kept by S3.2 |

#### S15. Stubs and capability flags

Each package's MODULES entry is created by the skeleton as a stub whose `install(app)` calls `stubCommands(app, ids)`
with the ids of S13.3 (0.4, rule 4; `record: false` on `edit:show-all-menu-items`) and exports the stub API its file
lists. A package replaces its files at the same paths and keeps every listed export. "Landed" is read from:

| Package | Flag (false or present in the stub) |
|---|---|
| brush-engine-core | `ENGINE.id !== 'classic-0.4'` (`lib/brush.js`) |
| brush-settings-panel | `app.stubbed` lacks `window:panel-brush-settings` |
| brush-painting-behaviours | `PaintGesture.real === true` (`lib/tools/paint-gesture.js`) |
| icc-engine | `colorEngine().available` (`lib/color/pipeline.js`) |
| psd-layers | `psdFeatures().effects` (and `.vectorMasks`, `.shapes`, `.fills`, `.advancedBlending`, `.tags`) |
| psd-text | `psdFeatures().textRuns` |
| camera-raw-workspace, camera-raw-panels | `developFeatures().workspace`, `.panels` (`lib/develop/registry.js`; each package calls `setDevelopFeature(name)`) |
| presets-panels | `app.stubbed` lacks `window:panel-styles` |
| preset-files-manager | `app.stubbed` lacks `edit:preset-manager` |
| color-picker-swatches | `app.colorPicker.real === true` |
| type-fonts | `fontCatalog().real === true` |
| type-menu-commands | `app.stubbed` lacks `type:warp-text` |
| shortcuts-editor | `app.stubbed` lacks `edit:menus` |
| move-tool-depth | `MOVE_FEATURES.handles` (`lib/tools/move-handles.js`) |

### Packages

Ports 8851–8865 in this order. The brief's feature list is each package's scope; a section adds only what the contract
decides: files, what it provides, how it builds before a partner lands, tests, the paths of rule 13 that bite, and
"done". Every package also meets "Tests expected" below.

#### 1. brush-engine-core (8851, entry `lib/brush/define.js`)
**Owns** `lib/brush/engine.js`, `options.js`, `define.js`, new `tips.js`, `dynamics.js`, `stroke.js`. **Delivers** tips
(`registerTipKind`: analytic computed, sampled), Spacing off, Shape Dynamics, Scattering, Color Dynamics, Transfer with
every control of S1.1, build-up (`tick`), smoothing modes with the leash, the pressure overrides, Behind / Clear /
Dissolve, sizes to 5000 px, `edit:define-brush` (selection or layer → luminance coverage, cropped, a `brushes` preset
with a sample blob in group "Defined"), `tool:airbrush-toggle`. **Provides** `traceDabs`, `tipOutline`, `renderTip`,
`renderStrokePreview`, `ENGINE.features`, `stroke.leash`. **Same release** brush-settings-panel's modifiers join the
chain as they register; until then their sections paint as off. **Tests** unit (golden dabs; each control on synthetic
samples; seeded jitter; build-up with fake times), e2e (pen samples with tilt, twist and wheel through the API; a
defined sampled tip; Behind and Clear; a 16-bit stroke keeps `deep` in step; Grayscale stays grey). **Paths** one entry
per stroke; masks, selections, `migrate`; Indexed; pen input in the packaged app. **Done** S2.3's goldens, every 0.4
paint spec green, `ENGINE.features` all true.

#### 2. brush-settings-panel (8852, entry `lib/panels/brush-settings.js`)
**Owns** `lib/panels/brush-settings.js`, `lib/panels/brushes.js`, new `lib/brush/texture.js`, `dual.js`, `extras.js`,
`abr.js`. **Delivers** every S1 section in the panel (enable boxes, angle and roundness control, locks in
`settings.brushes.locks`, Clear Brush Controls, preview by `renderStrokePreview`); modifiers 50 and 500–900; the Brushes
panel over `brushes` (groups, search, reorder, recent row, tool and colour capture, Import / Export); .abr as a two-kind
format (`brushes`, `patterns`; read through ag-psd's `readAbr`, unknown sections reported; write computed and sampled
tips); `app.brushPicker` kept. **Same release** paints through the stub engine's modifier path. **Tests** unit (coverage
maths; .abr round trip on files the test builds or freely licensed files), e2e (F5; locks survive a preset pick; a
textured stroke repeats with the pattern; .abr import adds brushes and their pattern). **Paths** settings per tool;
preset-store write failures (N); `tool:brush-preset` replays with data.

#### 3. brush-painting-behaviours (8853, entry `lib/tools/paint-keys.js`)
**Owns** `lib/tools/paint.js` (after the skeleton), `paint-gesture.js`, `paint-keys.js`, `lib/brush-cursor.js`, new
`lib/brush-hud.js`. **Delivers** S3.1's gestures (lines, axis lock, tilde, eraser end and side button, HUD, the HUD
colour picker gesture), S3.2's cursors and `tools` section, S13.3's keys (two digits within `painting.digitPairMs` set
an exact value, as finish-layer-menu's), arrow-key tip rotation (1°, Shift 15°). **Same release** the stub engine's
ellipse `tipOutline`; `app.colorPicker.hud` resolves null. **Tests** unit (digit pairs, axis lock), e2e (a Shift-click
line is one entry; digits set the Brush's opacity, the layer's with the Move tool; Shift+Alt+M the Brush's mode; `,` `.`
step presets; HUD resizes; tilde erases; DabTools take lines). **Paths** text fields and dialogs (0.4 key rules); the
Electron Shift+Alt path through `resolveKey`; macOS Ctrl+Alt HUD.

#### 4. icc-engine (8854, entry `lib/color/cmm.js`)
**Owns** `lib/color/*` except `pipeline.js`, `scripts/vendor/lcms2.mjs` (E23), `src/renderer/vendor/lcms2/`,
`package.json`, `package-lock.json`. **Delivers** the engine of S6.1 (lcms2 wasm, cached transforms; display transforms
may be 3D LUTs applied on the main thread so `toDisplay` stays synchronous), generated profiles (sRGB, Display P3, Adobe
RGB (1998)-compatible, ProPhoto-compatible, Gray Gamma 2.2), system and user profiles (`color-profiles` kind), adoption,
the `'icc'` provider, the display stage and canvas space, `edit:assign-profile` (Don't Color Manage / Working RGB /
Profile; one entry), `describe`, the conversions of S6.5 (color-picker-swatches and the Camera Raw workspace use
them), the Preferences section `color-management`. **Same release** color-picker-swatches and the Camera Raw packages
build against the pipeline's sRGB stubs. **Tests** unit (profile parsing; transforms in Node when the wasm loads there), e2e (P3-tagged PNG
and JPEG built in the page keep numbers and name; every format re-embeds the bytes; Assign undo and `.pigment`; the view
canvas differs from the composite for P3 and equals it for sRGB; Convert to sRGB in Save for Web). **Paths** 0.4 readers
of `.pigment`; PSD 1039 at the byte level; 16-bit PNG and TIFF; Gray profiles; the wasm and worker inside the asar (0.3
never verified a module worker in a packaged build: verify, fall back to the main thread). **Done** untagged and sRGB
documents byte- and pixel-identical to 0.4; S6.4's 60 ms target.

#### 5. psd-layers (8855, files loaded by `lib/psd/index.js`)
**Owns** `lib/psd/adjustments.js`, `effects.js`, `vector.js`, `tags.js`, `scripts/vendor-entries/ag-psd-layers.js`.
**Delivers** both directions for effects (every instance; unknown ones rasterised and reported on open), vector masks,
shape layers (live kinds where the origination data allows, else path shapes), fill layers, every adjustment with a PSD
form, advanced blending, labels and link groups, claims and `PSD_FEATURES`; Maximize Compatibility (save option `psd`,
section `file-handling`). **Tests** unit (mappers on ag-psd objects both ways), e2e (round trips of each feature on
documents and PSDs built in the test; composite with and without Maximize Compatibility). **Paths** notices vanish only
where claimed; 16/32-bit and mode documents keep 0.4's PSD path (psd-document, 0.6); the packaged bundle carries the
fixes. **Done** S14.2's gated lines pass their landed branch.

#### 6. psd-text (8856, file loaded by `lib/psd/index.js`)
**Owns** `lib/psd/text.js`, `scripts/vendor-entries/ag-psd-text.js`. **Delivers** style and paragraph runs both ways,
faces by PostScript name through `fontCatalog().resolve`, kerning, scales, baseline, caps, justification, box height,
`antiAlias`, `warp` (S11.4), a wider `psdExpressible` (path and stacked text stay pixels); keeps the exports of S4.1.
**Same release** the stub catalog resolves by family; warp is mapped as data whether or not type-menu-commands draws it.
**Tests** unit (engine data), e2e (two runs and two paragraphs; a real bold; warp and anti-alias; the `hunt5-type` PSD
tests). **Done** `psdFeatures().textRuns`.

#### 7. camera-raw-workspace (8857, entry `lib/develop/workspace.js`)
**Owns** `lib/develop-ui.js` (after the skeleton), `lib/develop/workspace.js`, new `presets.js`, `white-balance.js`,
`src/shared/pixels/develop-profile.js`. **Delivers** the full-window workspace (zoom, hand, histogram and clipping from
the preview, sampler, Before / After, tool strip and slots from the registry), White Balance tool and menu, Auto and B&W
(`treatment`), the profile stage (order 250: Pigment looks and user .cube LUTs), presets, snapshots and .xmp settings
(S8.4), `edit:camera-raw-preferences`, Last Filter through `rememberCommand`; keeps S8.3's DOM and session preview.
**Same release** camera-raw-panels' tabs, sections and tools appear as they register. **Tests** unit `develop-xmp.test.mjs`, e2e (histogram, clipping, WB on a grey patch, preset, snapshot, Last Filter,
smart filter re-edit, `extras.spec.mjs`). **Paths** one "Camera Raw" entry; `processVersion` in smart filters; replay.

#### 8. camera-raw-panels (8858, entry `lib/develop/tabs/index.js`)
**Owns** `src/shared/pixels/develop-more.js` (and pure files it imports), `lib/develop/tabs/*.js`. **Delivers** the brief's
nine tabs as stages and sections (S8.1–S8.2) with `xmp` maps; Optics and Geometry as resample stages; the Targeted
Adjustment and guided Upright tools. Neutral params give 0.4's output; version 1 gives 0.4's dehaze. **Same release**
tool tests skip while `!developFeatures().workspace`. **Tests** unit (numbers per stage, neutral identity, version 1
and 2), e2e (a curve point, a grade, an Upright change pixels). **Done** a neutral 12 MP develop costs no more than 0.4's.

#### 9. presets-panels (8859, entry `lib/tool-presets.js`)
**Owns** `lib/tool-presets.js`, `lib/panels/styles.js`, `shapes.js`, `tool-presets.js`, `lib/tools/vector.js`,
`lib/style-ui.js`. **Delivers** the Styles panel (`layer:style-preset`, drops `application/x-pigment-style`, New Style,
Make / Reset to Default), the Shapes panel (drops `application/x-pigment-shape`, the Custom Shape picker,
`edit:define-custom-shape`), Tool Presets (title slot, `tool:preset`, Current Tool Only, `tool:reset`, `tool:reset-all`),
type-tool presets; re-registers the three kinds. **Same release** Import lists whatever formats preset-files-manager
has registered (.pigment-presets before). **Tests** e2e per panel; both commands replay with data. **Paths** a
style is one `setLayerProps` entry, a dropped shape one structural entry; tool presets keep `brush`.

#### 10. preset-files-manager (8860, entry `lib/preset-manager.js`)
**Owns** `lib/preset-manager.js`, `lib/preset-files/*.js`, `src/renderer/presets/`. **Delivers** the Preset Manager,
Export/Import Presets as one `.pigment-bundle` (every kind's presets and blobs, optionally the settings namespaces),
Migrate Presets (a bundle or an older Pigment's preset folder), and .pat, .grd, .asl, .csh (`readCsh`), .aco / .ase
(S7.2), .tpl; readers report, never throw. **Same release** the `swatches` data of S7.2 is fixed, so .aco / .ase work
before color-picker-swatches lands. **Tests** unit (round trips on bytes the tests build; truncated files), e2e
(manager; a dropped .grd lands in Gradients; bundle round trip). **Paths** store write failures; IndexedDB; files over
64 MB refused with a message.

#### 11. color-picker-swatches (8861, entry `lib/color-picker.js`)
**Owns** `lib/color-picker.js`, `lib/panels/color.js`, `swatches.js`, `lib/tools/nav.js`, new `lib/hud-picker.js`,
`color-libraries.js`, `lib/panels/color-views.js`. **Delivers** S7.1's picker (axis buttons, Only Web Colors, gamut and
web-safe warnings, sampling the image (E14) or the screen (`window.EyeDropper`), books), the HUD picker, Color panel
views and sliders, Swatches on its kind (migration, groups, search, Import / Export through S10), `color-books` with
.acb, Eyedropper sample sizes and the five Sample choices (`sampleMerged`), Copy Color as Hex / HTML, the real `color`
widget, the section `color-picker`; keeps S7.3–S7.4. **Same release** sRGB maths until icc-engine lands; .aco / .ase
from preset-files-manager. **Tests** e2e (each colour field opens the picker; Lab fields;
groups; hex copy). **Paths** the modes' colour constraint; the browser build's swatches.

#### 12. type-fonts (8862, entry `lib/type/font-library.js`)
**Owns** `lib/type/font-library.js`, `font-picker.js`, `missing-fonts.js`, `fonts.js`, `shaper.js`, `layout.js`,
`src/renderer/fonts/`. **Delivers** the catalog (S11.1), the font widgets and Character panel replacements, WYSIWYG
rows, canvas hover preview (no history entry), search, classification (OS/2, PANOSE), favourites, recents, variable
axes and named instances, Add Fonts, missing fonts, per-cluster fallback. **Provides** `resolve` to psd-text. **Tests** unit (classification, axes), e2e
(with the OFL fixture font: real styles, an axis changes layout, a missing font is reported, fallback draws). **Paths**
`axes` in `.pigment`; the browser build without `local-fonts`; 1000 families stay responsive.

#### 13. type-menu-commands (8863, entry `lib/type/commands.js`)
**Owns** `lib/type/commands.js`, new `outlines.js`, `warp-text.js`, `antialias.js`, `lib/tools/type-mask.js`.
**Delivers** the render stages (S11.3), Warp Text (`WARP_PRESETS`, `presetControls` of `warp.js`, read only), Create
Work Path, Convert to Shape, Convert to Point / Paragraph Text, Update All Text Layers, Paste Lorem Ipsum, the two Type
Mask tools (S11.5, `text` slot: Shift+T cycles), `type:toggle-orientation`, `type:anti-alias`. **Tests** e2e (warp
pixels and `.pigment`; a work path with a subpath per glyph contour; a mask in one entry; anti-alias None gives only 0 /
255 alpha). **Paths** one entry per command; Free Transform of warped text; no warp on a path; the Canvas engine has no
outlines (a message).

#### 14. shortcuts-editor (8864, entry `lib/shortcuts-editor.js`)
**Owns** `lib/shortcuts-editor.js`, new `lib/menu-editor.js`. **Delivers** the Keyboard Shortcuts dialog over
`app.keymap` (menus, tools, type and paint keys; sets; conflicts before a key is taken; Summarize to HTML; .kys import
best effort; a built-in legacy-undo set) and the Menus tab (hide, colour, sets, Show All); Alt+Shift+Ctrl+K / M open
the tabs. **Tests** unit (overlays), e2e, electron `shortcuts-editor.spec.mjs` (accelerator and hidden item in the
native menu). **Paths** persistence; action keys (S9.3); macOS menu precedence.

#### 15. move-tool-depth (8865)
**Owns** `lib/tools/move.js`, `move-handles.js`, `lib/layer-ops.js`, `lib/layer-move.js`. **Delivers** S12.5.
**Tests** e2e per feature; 0.4's snapping and links specs. **Paths** position locks and the Background (0.4's open item
stays open unless solved in one entry); groups; isolation; `deep` moves with the canvas.

### Tests expected from every 0.5 package

As in 0.4: unit tests for pure code (`tests/unit/<package>.test.mjs`, numbers checked), an e2e spec
(`tests/e2e/<package>.spec.mjs`, its port), `app.spec.mjs`, `skeleton-04.spec.mjs`, `skeleton-05.spec.mjs` and
`brush-golden.spec.mjs` green with the package landed, and the whole suite green on the package's port. The report lists
what was not done, every behaviour change of an existing feature, every deviation from this contract, every test
skipped until a partner lands, the five paths checked (rule 13), and the measured cost of anything on the repaint or
stroke path.

---

# Part 2: implementation checklist for the skeleton

The app works after every step. After each step: `npm test` and the specs named; after steps 4, 6 and 12 the whole
browser suite and the Electron tests. Baseline 0.4.0: 878 unit, 611 browser, 6 Electron tests, all green; they stay
green (rule 9), changed only where S14.2 says. The two "Execution context was destroyed (navigation)" failures of
the 0.4 round (`actions.spec.mjs:574`, `content-aware-lens.spec.mjs:543`) are still unexplained: whoever sees one
keeps the trace and reports it; no retry is added for it.

**Step 0. Goldens, recorded on the untouched 0.4.0 tree** by `tests/e2e/record-goldens.spec.mjs` (runs only with
`PIGMENT_RECORD=1`): `tests/fixtures/brush-golden/` (`cases.json`, one PNG per case, `dabs.json` logged by wrapping
`BrushStroke.prototype.dab` inside the recorder only) for fourteen strokes driven through 0.4's `BrushStroke` with fixed
samples: hard 20 px line; soft 40 px S curve at flow 0.5, opacity 0.8; angle 45° roundness 0.3; Pencil 3 px; soft
Eraser; black on a layer mask; pressure ramps with `pressureSize` and with `pressureOpacity`; Multiply; Vivid Light;
Lock Transparency; a Clone Stamp sampler; spacing 0.5; "Airbrush Soft 65"; a selection clip. Also
`tests/fixtures/psd-golden/*.json` (`readPsd` without image data of 0.4's `writePsdDocument` for six documents: text,
adjustments, masks with a vector mask, styles with Blend If, guides, Grayscale) and `tests/unit/fixtures/develop-04.mjs`
(a verbatim copy of 0.4's `develop.js`).

**Step 1. Settings and styles.** `defaults.js` (S14.1); empty stylesheets for the eleven packages with UI, linked in
`index.html` (`brush-settings`, `painting`, `color-management`, `camera-raw`, `presets-panels`, `preset-manager`,
`color-picker`, `type-fonts`, `type-commands`, `shortcuts-editor`, `move-tool`).

**Step 2. Keys and menus** (S9, S13): `keymap.js`, `menu-template.js`, `keymap-store.js`, `app.js` (`app.keymap`,
ui state, `resolveKey`), `shortcuts.js`, `actions.js` (key source), `main.js`. Tests: `tests/unit/keymap-05.test.mjs`
(every S13.3 key, PAINT keys, overlays, conflicts, action keys win), `tests/unit/menu-05.test.mjs` (every S13.2 item
with command and argument; no accelerator twice on any platform and state; hidden, coloured and "Show All" items;
accelerators follow an overlay), `tests/electron/keys-05.spec.mjs` (F7 by `sendInputEvent` runs `window:panel-layers`
once with source `'menu-key'`; an overlay changes the native accelerator; a hidden item is absent).

**Step 3. Stubs** (S15): every stub file of "New files" with its listed API; MODULES order; `stubs-later.js`;
`help:shortcuts` and its dialog moved into `lib/shortcuts-editor.js`. Test: `skeleton-05.spec.mjs` "menus, keys and
stubs".

**Step 4. Brush** (S1–S3): `preset.js`; the engine stub and facade (0.4 code moved, hooks, `traceDabs`, tips,
`renderStrokePreview` moved from `panels/brushes.js`); `options.js`; `tool-brush.js` with the `brushes` kind and
migration; `paint.js` (gesture split, `toolBrush`, cursor delegation, patch removed), `paint-gesture.js`,
`brush-cursor.js`; the renames in `retouch.js` and `adjustment-brush.js`; `installTipHook` removed; brush size cap
5000; `canvas-view.js` samples and right-button drags. Tests: `tests/unit/brush-preset.test.mjs`,
`tests/unit/brush-golden.test.mjs` (`traceDabs` equals `dabs.json` for every engine), `tests/e2e/brush-golden.spec.mjs`
(each case in the legacy and the preset form: equal to the PNG while `ENGINE.id === 'classic-0.4'`, within S2.3's
tolerance after).

**Step 5. PSD** (S4): the registry modules, 0.4's mapping split into `builtin.js` and the `adjustments.js` / `text.js`
stubs, empty `effects.js`, `vector.js`, `tags.js`; `io.js` re-exports; open notices in `documents.js`; the ag-psd fixes
entry. Tests: `tests/unit/psd-registry.test.mjs` (order, builtin rule, claims, notices) and the psd-golden comparison in
`skeleton-05.spec.mjs`.

**Step 6. Chunks and colour** (S5, S6, S12.3): `io-chunks.js` and its containers; `pipeline.js`; `doc.profile`;
`io.js`, `depth.js`, `compositor.js damage`, `canvas-view.js` stages and canvas swap, `documents.js`
(`registerSaveOptions`, `onOpen`), `extras.js` New Document field, status bar and Info row, `toSRGB` call sites,
`listColorProfiles` (ipc, preload, bridge). Tests: `tests/unit/io-chunks.test.mjs` (every kind of S5's table on files the
tests build: PNG via `png.js`, TIFF via `tiff.js` in both byte orders, PSD via ag-psd, JPEG and WebP byte constants, a
VP8L file made VP8X; an empty patch returns the same bytes; malformed input never throws),
`tests/unit/color-pipeline.test.mjs`, `skeleton-05.spec.mjs` "colour hooks" (with the stub every save is byte-identical
to a save with the pipeline bypassed; with a fake engine registered in the page: a PNG's iCCP is adopted, a save embeds
it and `readChunks` finds it, the display stage converts the damage only, Assign Profile undoes and survives
`.pigment`).

**Step 7. Camera Raw** (S8, S12.4): `develop-stages.js`; `develop.js` as builtin stages; `registry.js`, `tabs-04.js`;
`develop-ui.js` from the registry; `rememberCommand`; the two kinds. Tests: `tests/unit/develop-stages.test.mjs` (equal to
`develop-04.mjs` on random images for every control; order; builtin rule; namespaced defaults; process version),
`extras.spec.mjs` (after S14.2's edit), `skeleton-05.spec.mjs` (a stage, a section and a tool registered in the page
appear; Last Filter repeats a remembered command).

**Step 8. Colour UI** (S7): the picker stub, `tool:pick-fg/bg`, the `color` widget and its five call sites, the three
kinds. Test: `skeleton-05.spec.mjs` (a fake `color` widget appears in a dialog form, the options bar and the Character
panel), the 0.4 colour specs.

**Step 9. Type** (S11): `model.js`, `type-model.test.mjs:26`, `api.js`, the `font-library.js` stub (catalog and
widgets), `tools/text.js`. Test:
`skeleton-05.spec.mjs` (a test stage recolours a text layer and is bypassed while editing; `warp` and `axes` survive
`.pigment`).

**Step 10. Preset files** (S10): `preset-formats.js`, `registerPresetKinds05()`, the two Export call sites, open and
drop routing. Tests: `tests/unit/preset-formats.test.mjs` (two-kind import with `$presetRef`; export format choice),
`skeleton-05.spec.mjs` (a fake format's file opened and dropped imports into two kinds; Gradients Export still writes
`.pigment-presets`).

**Step 11. Toolbox and transform** (S12.1, S12.2). Test: `skeleton-05.spec.mjs` (a title slot renders; `resetOptions`;
a grab on `'se'` continues the drag into one Free Transform entry).

**Step 12. Specs and the full run.** S14.2's edits; `skeleton-05.spec.mjs` with every stub assertion gated on S15 (an
owner map and a `landed(page)` helper, as `skeleton-04.spec.mjs`); all three suites; a headless start-up with no console
error or warning; `app.stubbed` is exactly S13.3's stub ids plus `edit:color-settings`, `edit:convert-profile`.

**Step 13. Documentation.** Part 1 into ARCHITECTURE.md; `docs/0.5/README.md` naming the packages and ports; "The
skeleton as landed" for every detail the code forced, as in 0.4.

