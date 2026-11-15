# Pigment 0.5: the skeleton contract (final, after review)

Two parts. **Part 1** is the text of a new section "## 0.5 features (contracts)" for ARCHITECTURE.md, written for the
fifteen package owners and the skeleton implementer; it ends with the review decisions. **Part 2** is the skeleton's
implementation checklist, file by file, in an order that keeps the app and the suite working at every step.

Names from the 0.4 section are reused without restating them: rules 1–10 of "Rules for the parallel round",
extension points E1–E33, sections A–O of "Shared integration points" (C = preset store, D = document store, E = sessions
and command flags, H = field widgets, J.8 = vector masks baked into PSD, L.1/L.2 = Properties and Preferences sections,
L.6 = PatternRef, L.8 = vendor steps, M.8 = changed bindings). New extension points continue the numbering (E34–E55);
the shared integration points of 0.5 are S1–S15. Paths are relative to `src/renderer/` unless they start with `src/`,
`scripts/` or `tests/`.

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
    place, read from the capability flags of S15, and the same test checks the landed behaviour otherwise. The
    existing spec lines that pin a 0.4 limitation a 0.5 package removes are listed in S14.2; the skeleton gates them
    the same way. A package that finds another such line does not edit it: it names file and line in its report, and
    the integrator gates it.
12. **One owner per behaviour.** A behaviour that needs code in two packages has its halves assigned in the table
    "Behaviours split across packages" below, with the API between them. A package tests its half against the other
    half's stub; it never writes a private copy of the other half to make its own tests pass.
13. **The five paths.** Every feature is checked through undo and redo (one entry per gesture or command, with
    Photoshop's label); save and reopen as `.pigment` and PSD (or the docs say why PSD cannot hold it); action
    playback (replay arguments that carry their data; `record: false` for UI-only commands); 16/32-bit documents and
    the non-RGB modes (channel views over RGBA, 0.3); and the Electron build (preload bridge, `pigment://` inside the
    asar, the native menu and its accelerators, file dialogs). Each package section names what bites.
14. **Ports.** The skeleton's specs use 8850; the packages 8851–8865 in the order of "Packages". `PIGMENT_PARTIAL=1` as
    in 0.4.
15. **Third-party code.** Only icc-engine adds an npm dependency (LittleCMS 2 as wasm, MIT); it owns `package.json` and
    `package-lock.json` for the round, after the skeleton's `imports` entry (S4.5). type-fonts bundles OFL font files
    with their licence files beside them. Every package that bundles third-party data lists it in
    `docs/0.5/<package>.md` for the release notes' notices.

### Behaviours split across packages (rule 12)

| Behaviour | Half and owner | Other half and owner | Between them |
|---|---|---|---|
| Picking a brush preset and painting with it | Brushes and Brush Settings panels (brush-settings-panel) | the engine (brush-engine-core) | `setToolBrush` / `toolBrush` / `prepareBrush`, `tool:brush-preset` (S1.3, skeleton) |
| Texture, Dual Brush, Noise, Wet Edges, Brush Pose | the modifiers (brush-settings-panel) | the modifier chain (brush-engine-core; the stub engine runs it too) | `registerDabModifier` (S2.4) |
| Build-up, Protect Texture, captured tool colour | the panel's checkboxes, `tool:airbrush-toggle` (brush-settings-panel, brush-engine-core) | `preset.buildUp`, `setToolBrush` (skeleton) | S1.3: one flag, written only through `setToolBrush` |
| How far a stroke reaches (layer growth) | `strokeReach`, modifiers' `reach` (brush-engine-core, brush-settings-panel) | growing the layer (`paint.js`, brush-painting-behaviours; `vector.js`, presets-panels; calls placed by the skeleton) | S2.6 |
| The cursor shows the real tip | drawing (brush-painting-behaviours) | tip geometry (brush-engine-core) | `tipOutline` (S2.6) |
| Painting gestures beside the temporary tools | the claims (brush-painting-behaviours) | press routing (skeleton, `canvas-view.js`) | `claimsPress` (S3.3) |
| Digits, Shift+digits, Shift+Alt+letters while painting | the `tool:*` commands (brush-painting-behaviours; `tool:airbrush-toggle`: brush-engine-core) | the key context (skeleton) | `PAINT_KEYS`, `app.keymap.resolveKey` (S13.4) |
| HUD colour picker (Alt+Shift+right-drag) | the gesture: claims the press, forwards moves (brush-painting-behaviours) | the picker: draws, applies the colour live, recent colours (color-picker-swatches) | the `hud()` session (S7.1) |
| Pen eraser end | the tool switch (brush-painting-behaviours) | `sample.eraser`, button 5 routing (skeleton) | S2.5, S3.3 |
| .abr and .tpl brushes | `brushFromAgPsd` (brush-settings-panel) | .tpl container (preset-files-manager); import, links, routing (skeleton) | `lib/brush/abr.js` (S10.6) |
| .asl styles, .csh shapes | containers, names, groups (preset-files-manager) | effect and path mapping (psd-layers) | `stylesFromPsd/ToPsd`, `pathFromPsd/ToPsd` (S4.6) |
| Styles that use patterns | import (preset-files-manager) | apply and capture (presets-panels) | S10.5 |
| Swatch files and colour books | `parseAse` / `parseAco` (preset-files-manager) | Color Libraries, .acb (color-picker-swatches) | `lib/preset-files/aco-ase.js` (S7.2) |
| PSD text warp and anti-alias | the mapping (psd-text) | the rendering (type-menu-commands) | `typeOptions.warp`, `typeOptions.antiAlias` (S11.4) |
| PSD text fonts | PostScript names (psd-text) | catalog lookups (type-fonts) | `fromPostScriptName` (read), `resolve` (write) (S11.1) |
| ICC profiles in files | the container bytes (skeleton) | what is adopted and embedded (icc-engine) | `readChunks` / chunk providers (S5), colour pipeline (S6) |
| Colour numbers in the picker, Info, swatches | the UI (color-picker-swatches) | the conversions (icc-engine) | the sync calls of S6.5 |
| The Camera Raw dialog | workspace host, profile, white balance, Auto, B&W button (camera-raw-workspace) | stages, tabs, Targeted Adjustment and guided Upright tools (camera-raw-panels) | `DevelopWorkspace`, the registries (S8) |
| Camera Raw as a smart filter | the kind's `open` (camera-raw-workspace) | the smart filter entry (skeleton, `smart-object.js`) | E55 (S8.3) |
| Keyboard shortcuts | the editor (shortcuts-editor) | store, dispatch, native menu (skeleton) | S9 |
| Photoshop preset files | the format readers and writers (preset-files-manager; .abr: brush-settings-panel) | import, export, opening, dropping (skeleton) | S10 |
| Tool presets | capture and apply (presets-panels) | `setOptions`, `setToolBrush`, `setTypeDefaults` (skeleton) | S10.5, S12.1 |
| Move tool handles start Free Transform | the handles (move-tool-depth) | the session and its box (skeleton, image-ops.js) | `previewBox`, `start({ grab })` (S12.2) |
| Missing fonts in opened files | the dialog and report (type-fonts) | open hooks (skeleton) | `registerOpenHook` (S12.6) |

### Ownership of existing files

Every existing file 0.5 changes. "skeleton" means the skeleton makes all of 0.5's changes there and no package edits
it afterwards. Column "Plug in" says what the skeleton lands first in a package-owned file, or which extension point
the other packages use instead of editing it.

| File | Owner | What the owner changes | Plug in |
|---|---|---|---|
| `app.js` | skeleton | MODULES and the `start()` services; `help:shortcuts` moves out; `tool:pick-fg/bg` through `app.colorPicker`; brush size cap 5000; `'key'` commands through `resolveKey` (S13.4); status bar (S6.6); ui state (S13.6); dropped preset files (S10.4); the shortcuts list through `keysFor`; `file:open` passes `interactive` (S12.6) | E43, E49, E50 |
| `lib/brush.js` | skeleton | the facade over `lib/brush/engine.js` (S2); keeps `dabCanvas` (pixel-budget cache, S2.8), `drawBlended`, `drawOnMask` | E35 |
| `lib/tools.js` | skeleton | `BRUSH_OPTIONS` re-exported from `lib/brush/options.js`; options-bar slots, `resetOptions`, `setOptions`, the cursor filter's registration (S12.1); the `brush` button through `app.brushPicker.renderButton`; option kind `color` through the widget registry (S7.3); toolbox tooltips through `keysFor` | E39, E46 |
| `lib/tools/paint.js` | brush-painting-behaviours | gestures, cursor, arrow-key tip rotation | skeleton lands first: S3.1's gesture split and `claimsPress`; `baseSettings` from `toolBrush` (S1.3, marked `// brush (lib/brush/tool-brush.js)`); `ensureCoverage` through `strokeReach` (marked `// brush (lib/brush.js)`); `BLEND_OPTIONS` and the Pencil's size from `options.js`; the `migrate` prototype patch removed; cursor through `lib/brush-cursor.js` |
| `lib/tools/retouch.js`, `lib/tools/adjustment-brush.js` | skeleton | `onPointerDown/Move/Up` renamed `strokeDown/Move/Up` under the inherited gesture (S3.1); DabTool keeps its dab loop and `SIZE` (max 1000) until 0.7 | E37 |
| `lib/tools/vector.js` | presets-panels | Custom Shape picker over `shapes`, Define Custom Shape, `shapeProps.unit` on new shapes (S10.5) | keeps `CUSTOM_SHAPES`, `customPath`, `createShapeLayer` and the L.4 registries; skeleton lands first: `strokePathPixels` spacing from `toolBrush` and growth by `strokeReach` (marked) |
| `lib/tools/text.js` | skeleton | S11.2's option kinds and font patches, the anti-alias, orientation and Warp Text controls, `setEditing` (S11.3), the TypeTool surface and `typeTools` (S11.5) | E51, E52 |
| `lib/tools/move.js` | move-tool-depth | auto-select, handles, layer marquee, nudging, align and distribute buttons, mask moves | E53; the snap calls (rule 10) stay |
| `lib/tools/nav.js` | color-picker-swatches | Eyedropper options and screen sampling, Copy Color as Hex / HTML | keeps `EyedropperTool.sampleAt(p, { setForeground, setBackground })` and `this.ring` (paint.js, temp-tools.js call them); E28 calls stay |
| `lib/canvas-view.js` | skeleton | pointer samples, button 5, press claims, right-button drags (S2.5, S3.3); the cursor filter inside `setCursor` (S3.2); display stages, damage tokens, the canvas colour space (S6.4) | E36, E43 |
| `lib/compositor.js` | skeleton | `takeDamage(token)` (S6.4) | E44 |
| `lib/document.js` | skeleton | `doc.profile`, describe and duplicate (S6.2); `TextLayer.render` honours `transformed` stages (S11.3) | E43, E52 |
| `lib/sample.js` | skeleton | `sampleMerged(app, doc, { until, skipAdjustments })` (S7.5) | E28 |
| `lib/shape-geometry.js`, `lib/path-ops.js` | skeleton | `shapeProps.unit` kept by `normalizeShapeProps` and preferred by `customShapePath` (S10.5) | E33 |
| `lib/smart-object.js` | skeleton | `cloneDocument` copies `doc.profile`; `registerKind` gains `open`, `recolourOnly(params)`, `geometric(params)`; camera-raw leaves the hard-coded sets (S8.3) | E55 |
| `lib/type/model.js` | skeleton | char attribute `axes`; `normalizeTypeOptions` normalises `warp` (S11.4) | E51 |
| `lib/type/api.js` | skeleton | font catalog slot, text render stages, `setEditing` (S11) | E51, E52 |
| `lib/type/edit-keys.js`, `lib/type/editor.js` | skeleton | their key tables from `app.keymap`, rebuilt on `'keymap:changed'` (S9.4) | E49 |
| `lib/type/fonts.js`, `shaper.js`, `layout.js` | type-fonts | variable instances and axes, per-cluster fallback, bundled and added fonts | keeps `faceFor`, `unitOutline`, `addFontData`, `loadedFaces`, `requestFamily` and the `LayoutRun` fields `units`, `face`, `size` (type-menu-commands reads them) |
| `lib/type/char-format.js` | skeleton | its two `<input type=color>` become `color` widgets (S7.3); the anti-alias select gets seven values and runs `type:anti-alias` (S11.4) | E46 |
| `lib/io.js` | skeleton | PSD code to `lib/psd/` (S4); chunks on open, save and export (S5); the decode conversion through readers (S6.3) | E40, E42, E43 |
| `lib/modes/formats.js` | skeleton | its two `decodeImage` fallbacks pass the reader's `colorSpaceConversion` (S6.3) | |
| `lib/documents.js` | skeleton | save options (S12.3), preset files (S10.4), open hooks (S12.6), open notices (S4.4) | E45, E50, E54 |
| `lib/depth.js` | skeleton | its `writeTo` 16-bit PNG save applies the chunks (S5) | E42 |
| `lib/edit-ops.js` | skeleton | the PNG clipboard copy applies the chunks with purpose `'copy'` (S5) | E42 |
| `lib/develop-ui.js` | camera-raw-workspace | the full-window workspace | skeleton lands first: the editor built from the registry with 0.4's DOM, the smart kind's `recolourOnly` / `geometric` / `padding` (S8.3) |
| `src/shared/pixels/develop.js` | skeleton | the pipeline as registered stages over planes with alpha, process version; 0.4's helpers move to `develop-util.js` and are re-exported (S8.1) | E47 |
| `lib/filter-ui.js` | skeleton | `app.filterEditor.rememberCommand`; `filter:last` / `filter:last-dialog` for commands (S12.4) | E48 |
| `lib/extras.js` | skeleton | `pickColor` moves to `lib/color-picker.js`; New Document "Color Profile" (S6.6); the built-in `tools` section's `cursorStyle` values (S3.2) | E20, E43 |
| `lib/form.js`, `lib/fields.js` | skeleton | field type `color` through a widget; the stub `color` widget; the gradient field's two colour inputs (S7.3) | E7, E46 |
| `lib/shape-paint-ui.js`, `lib/lens-correction.js` | skeleton | their `<input type=color>` become `color` widgets; the swatch row from `swatchColors(app)` (S7.1) | E46 |
| `lib/panels/color.js`, `lib/panels/swatches.js` | color-picker-swatches | views, sliders, the swatch store, groups, search | keeps `createColorWidget`, `normHex` |
| `lib/panels/brushes.js` | brush-settings-panel | the Brushes panel over `brushes`, `app.brushPicker` | skeleton lands first: deletes `installTipHook`; `drawStroke` moves to the engine as `renderStrokePreview`; the spacing slider writes the tool's flat `spacing` (marked); `BUILTIN_BRUSHES` kept |
| `lib/panels/info.js` | skeleton | document profile row (S6.6); the Lab row through `toLab(rgb, doc.profile)` | E43 |
| `lib/panels/navigator.js` | skeleton | the thumbnail through `displayCanvas` (marked `// color (lib/color/pipeline.js)`) | E43 |
| `lib/style-ui.js` | presets-panels | Styles page, New Style, Make Default | E13 |
| `lib/layer-ops.js`, `lib/layer-move.js` | move-tool-depth | align targets and spacing, `offsetLayers(…, { maskOnly })` | every 0.4 marker stays |
| `lib/image-ops.js` | skeleton | `TransformTool.previewBox`, `start({ grab })` (S12.2) | E53 |
| `lib/gradient-editor.js`, `lib/pattern-picker.js` | skeleton | Export goes through `exportPresetsDialog` (S10.3) | E50 |
| `lib/modes/save-for-web.js` | skeleton | "Convert to sRGB" awaits `toSRGB` (marked) | E43 |
| `lib/automate/batch.js` | skeleton | "Convert to sRGB" awaits `toSRGB`; open hooks with `interactive: false` (S12.6) | E43, E54 |
| `lib/actions.js` | skeleton | action function keys reported to the keymap store; `builtinKeyOwner` through `keysFor` (marked `// keymap (lib/keymap-store.js)`) | E49 |
| `lib/shortcuts.js` | skeleton | the table from `app.keymap`, the paint context, rebuilt on `keymap:changed`; F-keys never reach the browser (S9.4) | E38, E49 |
| `lib/toolbar.js`, `lib/command-search.js` | skeleton | accelerators shown through `keysFor` | E49 |
| `lib/stubs-later.js` | skeleton | drops `edit:menus` (now shortcuts-editor's stub), adds `edit:color-settings`, `edit:convert-profile` (0.6) | |
| `lib/preset-kinds.js` | skeleton | `registerPresetKinds05()` (S10.5) | E5 |
| `src/shared/keymap.js` | skeleton | every 0.5 binding, `PAINT_KEYS`, `FIXED_KEYS`, `effectiveKeys`, `typeKeyFor(cmd, effective)`, `runsWhileTyping` without `file:revert`, labels, groups | |
| `src/shared/menu-template.js` | skeleton | every 0.5 item; accelerators from `state.keymap` and `FIXED_KEYS`; hidden and coloured items (S9.5) | |
| `src/main/main.js` | skeleton | coloured items as icons, Shift+Alt keys and the first menu from the effective keymap, devtools key | |
| `src/main/ipc.js`, `src/preload.cjs`, `lib/bridge.js` | skeleton | `listColorProfiles` (S6.6) | |
| `src/shared/defaults.js` | skeleton | the 0.5 namespaces (S14.1) | rule 5 |
| `index.html` | skeleton | stylesheet links; the import map's `#ag-psd` key and the CSP hash recomputed (S4.5) | rule 6 |
| `scripts/vendor-entries/ag-psd.js` | skeleton | imports `ag-psd-fixes.js`; `export * from './ag-psd-internals.js'` (S4.5) | E41 |
| `package.json`, `package-lock.json` | icc-engine | the lcms2 dependency | skeleton lands first: `"imports": { "#ag-psd": … }` (S4.5) |
| `tests/unit/type-model.test.mjs` (line 26), the spec lines of S14.2 | skeleton | gated or updated as listed | |

No 0.5 package edits a file of the table owned by "skeleton", nor these files, which 0.5 does not change:
`history.js`, `commands.js`, `sessions.js`, `presets.js`, `doc-store.js`, `panels.js`, `layer-dialogs.js`,
`tool-traits.js`, `temp-tools.js`, `canvas-capture.js`, `file-info.js`, `file-ops.js`, `layers-extras/*.js`,
`panels/layers.js`, `panels/character.js`, `panels/paragraph.js`, `panels/gradients.js`, `panels/patterns.js`,
`type/render.js`, `type/target.js`, `warp.js` (read only), `select*.js`, and `src/shared/pixels/*` other than
`develop.js` (skeleton) and the new files.

### Where the briefs are wrong about the code

The briefs name files to touch; the code decides otherwise in these cases (the decision is binding):

- **Registration is not an edit.** brush-settings-panel and preset-files-manager do not touch `lib/preset-formats.js`,
  psd-layers and psd-text do not touch `lib/psd/registry.js`, camera-raw-panels does not touch `lib/develop/registry.js`,
  brush-settings-panel does not touch `lib/panels.js` (panels register themselves; F5 is the skeleton's key), and
  brush-engine-core does not touch `lib/edit-ops.js` (`edit:define-brush` is registered from `lib/brush/define.js`).
- **The skeleton lands the hooks** the briefs give to packages: pointer normalisation in `canvas-view.js`
  (brush-engine-core's brief), the display transform hook, `doc.profile`, `decodeImage`'s colour handling and the ICC
  chunk readers and writers (icc-engine's brief), the develop stage list (camera-raw-panels' brief), `help:shortcuts`
  and the native menu's accelerators (shortcuts-editor's brief), the type tools' options-bar controls
  (type-menu-commands' brief), the cursor filter (brush-painting-behaviours' `tools.js` touch).
- **icc-engine does not edit `io-chunks.js`.** The container code is the skeleton's; icc-engine decides which profile
  is adopted and embedded (S5, S6). metadata-io (0.6) will do the same for EXIF, XMP, IPTC and resolution.
- **Warp Text is not a text extension.** `document.js textExtensions` choose a layout (text on a path); warp is a text
  render stage in `lib/type/api.js` (S11.3).
- **`textLayerFromPsd` / `textToPsd` are not removed by psd-text**: the skeleton moves them into `lib/psd/text.js`,
  psd-text's file, as the stub psd-text replaces.
- **Pen eraser end and side buttons** move from brush-engine-core to brush-painting-behaviours: they switch tools
  during a gesture, which is the gesture layer's job (S3.1). brush-engine-core keeps tilt, twist, wheel and pressure.
- **Maximize Compatibility** is a save option plus a setting read by `writePsdDocument` (S4.4), not an edit of
  `documents.js`; **Last Filter repeats Camera Raw** through `rememberCommand` (S12.4), not an edit of `filter-ui.js`;
  the **Cursors** preferences are a new section `cursors` beside the built-in `tools` section, and **Camera Raw**
  preferences a section of their own (E20), not edits of `extras.js`; type-fonts' missing-font check is an open hook
  (S12.6), not a `doc:opened` listener (that event fires for New, Duplicate, Batch and smart object contents too).
- **Swatches, gradients, patterns panels.** The Gradients and Patterns panels import every format registered for
  their kind through `registerPresetFormat` (`presetFormats(kind)`), so .grd and .pat register there (S10.1) and need
  no panel edit. Their Export picked the first writable format, which would silently become .grd or .pat: the skeleton
  routes both through `exportPresetsDialog` (S10.3). The Swatches panel is color-picker-swatches' file.
- **"Pressure for opacity"** (brush-engine-core): 0.4's `pressureOpacity` scales *flow*; that stays for the legacy
  option (the goldens depend on it), and Transfer's opacity control acts on the dab's opacity ceiling (S2.3).
- **Dehaze to a dark-channel method** (camera-raw-panels) changes existing smart filters: it is process version 2;
  version 1 keeps 0.4's look (S8.1).
- **Colour books, colour-profile files, Camera Raw snapshots and profiles, added fonts** have no home in the briefs'
  file lists; they are preset kinds (S10.5).

### New files

| Package | New files (owned) | MODULES entry (stub by the skeleton until the package lands) |
|---|---|---|
| skeleton | `lib/brush/preset.js`, `lib/brush/tool-brush.js` (S1); `lib/psd/registry.js`, `read.js`, `write.js`, `builtin.js`, `convert.js`, `report.js`, `index.js` (S4); `scripts/vendor-entries/ag-psd-fixes.js`, `ag-psd-internals.js` (S4.5); `lib/io-chunks.js` and `lib/io-chunks/jpeg.js`, `png.js`, `webp.js`, `tiff.js`, `psd.js` (S5); `lib/color/pipeline.js` (S6); `src/shared/pixels/develop-stages.js`, `develop-util.js`, `lib/develop/registry.js`, `lib/develop/tabs-04.js` (S8); `lib/keymap-store.js` (S9); `lib/preset-formats.js` (S10); the stub files below | `lib/psd/index.js` (its `install(app)` runs the mapper files' optional installs) |
| brush-engine-core | `lib/brush/engine.js` (stub: 0.4's engine), `lib/brush/options.js` (stub: 0.4's `BRUSH_OPTIONS`, `BRUSH_SIZE`), `lib/brush/define.js` (stub), new `tips.js`, `dynamics.js`, `stroke.js` | `lib/brush/define.js` |
| brush-settings-panel | `lib/panels/brush-settings.js` (stub), `lib/brush/abr.js` (stub: `brushFromAgPsd` through `brushFromLegacy`), new `lib/brush/texture.js`, `dual.js`, `extras.js` | `lib/panels/brush-settings.js` (panel group, after `lib/panels/layers-menu.js`) |
| brush-painting-behaviours | `lib/tools/paint-gesture.js` (stub: pass-through), `lib/brush-cursor.js` (stub: 0.4's cursor code), `lib/tools/paint-keys.js` (stub), new `lib/brush-hud.js` | `lib/tools/paint-keys.js` |
| icc-engine | `lib/color/cmm.js` (stub), new `lib/color/profiles.js`, `doc-profile.js`, an optional worker module, `scripts/vendor/lcms2.mjs`, `src/renderer/vendor/lcms2/` (built) | `lib/color/cmm.js` |
| psd-layers | `lib/psd/adjustments.js` (stub: 0.4's adjustment mapping), `effects.js`, `vector.js` (stubs with the S4.6 signatures), `tags.js` (stub), `scripts/vendor-entries/ag-psd-layers.js` (stub) | none (`lib/psd/index.js` imports them) |
| psd-text | `lib/psd/text.js` (stub: 0.4's text mapping), `scripts/vendor-entries/ag-psd-text.js` (stub) | none |
| camera-raw-workspace | `lib/develop/workspace.js` (stub), `src/shared/pixels/develop-profile.js` (stub, imported by `develop.js`), new `lib/develop/presets.js`, `white-balance.js` | `lib/develop/workspace.js` |
| camera-raw-panels | `src/shared/pixels/develop-more.js` (stub, imported by `develop.js`), `lib/develop/tabs/index.js` (stub), new `lib/develop/tabs/*.js` | `lib/develop/tabs/index.js` |
| presets-panels | `lib/tool-presets.js`, `lib/panels/styles.js`, `shapes.js`, `tool-presets.js` (stubs) | `lib/tool-presets.js`; the three panels after `lib/panels/brush-settings.js` |
| preset-files-manager | `lib/preset-manager.js` (stub), `lib/preset-files/aco-ase.js` (stub: empty `parseAse` / `parseAco`, S7.2), new `lib/preset-files/pat.js`, `grd.js`, `asl.js`, `csh.js`, `tpl.js`, `bundle.js`, `src/renderer/presets/` (Pigment-made sets) | `lib/preset-manager.js` |
| color-picker-swatches | `lib/color-picker.js` (stub: 0.4's picker dialog, `swatchColors`), new `lib/hud-picker.js`, `lib/color-libraries.js`, `lib/panels/color-views.js` | `lib/color-picker.js` |
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

Twenty-two new extension points; the S-section specifies each.

| # | Extension point | Where | Used in 0.5 by | Later users |
|---|---|---|---|---|
| E34 | BrushPreset schema and the tool's brush | `lib/brush/preset.js`, `tool-brush.js` (S1) | brush-engine-core, brush-settings-panel, brush-painting-behaviours, presets-panels | retouch-tools-depth, brush-tips-mixer, actions-recording |
| E35 | Brush engine: `BrushStroke`, dab model, modifier chain, tip kinds, reach, previews | `lib/brush.js` → `lib/brush/engine.js` (S2) | brush-engine-core, brush-settings-panel, brush-painting-behaviours | brush-tips-mixer, deep-pipeline (float buffer), retouch-tools-depth, actions-recording |
| E36 | Pointer samples, press claims, right-button drags | `canvas-view.js` (S2.5, S3.3) | brush-engine-core, brush-painting-behaviours, color-picker-swatches | every pen-aware tool |
| E37 | Paint gestures (`strokeDown/Move/Up`, `claims`) | `lib/tools/paint-gesture.js` (S3.1) | brush-painting-behaviours | retouch-tools-depth, actions-recording |
| E38 | Paint-context keys | `keymap.js PAINT_KEYS`, `shortcuts.js`, `app.keymap.resolveKey` (S13.4) | brush-painting-behaviours, brush-engine-core, shortcuts-editor | retouch-tools-depth, brush-tips-mixer |
| E39 | Toolbox plumbing: options-bar slots, `resetOptions`, `setOptions`, cursor filter | `tools.js`, `CanvasView.setCursor` (S12.1, S3.2) | presets-panels, brush-painting-behaviours | workspaces-toolbar |
| E40 | PSD mapper registries, claims, notices, conversions | `lib/psd/registry.js`, `convert.js` (S4) | psd-layers, psd-text, preset-files-manager (conversions) | smart-filters-depth, psd-document, linked-smart-objects, layer-comps, artboards-frames, notes-count-measurement |
| E41 | ag-psd handler fixes and internals | `scripts/vendor-entries/ag-psd-fixes.js`, `ag-psd-internals.js`, `#ag-psd` (S4.5) | psd-layers, psd-text, preset-files-manager, brush-settings-panel | psd-document, actions-atn |
| E42 | Container chunks and chunk providers | `lib/io-chunks.js` (S5) | icc-engine | metadata-io, export-as, save-options-common-formats, save-for-web |
| E43 | Colour pipeline: engine slot, open, display and export hooks, conversions, display stages | `lib/color/pipeline.js` (S6) | icc-engine, color-picker-swatches, camera-raw-workspace | color-settings, soft-proofing, info-histogram-properties, print, hdr-32bit, raw-open-workflow |
| E44 | Compositor damage tokens | `Compositor.takeDamage` (S6.4) | icc-engine | soft-proofing, gpu-pipeline |
| E45 | Save options per format | `documents.js registerSaveOptions` (S12.3) | psd-layers | save-options-common-formats, export-as |
| E46 | Colour picker API, HUD session and the `color` field widget | `app.colorPicker`, `fields.js` (S7) | color-picker-swatches, brush-painting-behaviours | hdr-32bit (intensity) |
| E47 | Camera Raw registry, develop stages, workspace interface | `lib/develop/registry.js`, `develop-stages.js` (S8) | camera-raw-workspace, camera-raw-panels | raw-open-workflow, camera-raw-local, lens-correction-profiles |
| E48 | Last Filter command sources | `app.filterEditor.rememberCommand` (S12.4) | camera-raw-workspace | filter-dialogs-a (Liquify), smart-filters-depth |
| E49 | Keymap store, key sources, menu customisation | `lib/keymap-store.js`, `keymap.js effectiveKeys`, `menu-template.js` (S9) | shortcuts-editor, brush-painting-behaviours | workspaces-toolbar, actions-atn |
| E50 | Preset files: multi-kind formats, blob references, import/export dialogs, opening and dropping | `lib/preset-formats.js` (S10) | preset-files-manager, brush-settings-panel, color-picker-swatches, presets-panels, camera-raw-workspace | actions-atn (.atn) |
| E51 | Font catalog and font widgets | `lib/type/api.js fontCatalog`, widget kinds `font-family` / `font-style` (S11.1–2) | type-fonts, psd-text | type-opentype-glyphs |
| E52 | Text render stages and the editing flag | `lib/type/api.js` (S11.3) | type-menu-commands, type-fonts (hover preview) | type-on-path-area |
| E53 | Transform preview box and grab | `image-ops.js TransformTool` (S12.2) | move-tool-depth | transform-warp-depth |
| E54 | Open hooks | `documents.js registerOpenHook` (S12.6) | type-fonts, icc-engine (policy) | color-settings, metadata-io, psd-document |
| E55 | Smart filter kinds with their own session | `app.smartFilters.registerKind` (S8.3) | camera-raw-workspace | smart-filters-depth, filter-dialogs-a |

0.4 extension points 0.5 relies on: E5 (preset store), E7 (widgets), E13 (Layer Style pages), E14 (canvas capture),
E16 (`app.patterns`), E20 (Preferences sections), E23 (vendor steps), E25 (drop handlers), E26 (type panel sections),
E28 (merged sampling), E29 (tool traits), E31 (definition flags), E33 (shape geometry).

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
interface SampleRef { blob: string; hash: string; width: number; height: number;    // blob 'tip-<sha1>.png', a side file of
  dataUrl?: string }   // the 'brushes' kind (grey PNG, white = full coverage); dataUrl only on copies that leave the store
interface TipShape {
  kind: 'computed' | 'sampled' | string;   // 0.10 adds erodible / bristle / airbrush; an unknown kind keeps its fields
                                           // in tip.extras and paints as computed
  size: number;          // diameter 1..5000, default 24
  hardness: number;      // 0..1, default 0.8 (computed tips)
  sample: SampleRef | null;                // sampled tips
  angle: number;         // -180..180, default 0
  roundness: number;     // 0.01..1, default 1
  flipX: boolean; flipY: boolean;          // default false
  spacing: number;       // fraction of the diameter 0.01..10, default 0.12
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
without its pixels. `prepareBrush` (S1.3) awaits `app.patterns.get(presetId)`; at stroke start the engine reads the
pixels synchronously with `app.patterns.resolve(ref, onReady)`; a pattern still missing turns Texture off for that
stroke with one toast. `buildUp` is the one build-up flag (the panel's checkbox and `tool:airbrush-toggle` both write
it through `setToolBrush`); `smoothCurves` is placement (brush-engine-core); `protectTexture` is applied by
`setToolBrush` (S1.3), not per dab.

Exports: `DEFAULT_BRUSH` (frozen: the defaults above, every section disabled), `BRUSH_SECTIONS` (`[{ id, label,
toggle }]` in the panel's order: `tip` "Brush Tip Shape", `shapeDynamics`, `scattering`, `texture`, `dualBrush`,
`colorDynamics`, `transfer`, `brushPose`, `noise`, `wetEdges`, `buildUp`, `smoothCurves` "Smoothing",
`protectTexture`), `CONTROL_TYPES`, `TEXTURE_MODES`, `DUAL_MODES`, `RANGES`, and:

```ts
normalizeBrush(any): BrushPreset             // never throws; defaults filled, ranges clamped, unknown keys moved to extras;
                                             // a 0.4 flat object (has `size`, no `tip`) goes through brushFromLegacy
brushFromLegacy(o): BrushPreset              // 0.4 presets ({ id, name, size, hardness, spacing, angle, roundness, flow }) and
                                             // 0.4 stroke settings: tip keys to tip; a 0.4 *preset's* flow to tool.flow
legacyTip(preset): { size, hardness, spacing, angle, roundness }   // the flat keys 0.4 code reads
splitStrokeSettings(settings): { preset, paint }   // S2.2's precedence, the one implementation
brushEquals(a, b): boolean;  sectionDiff(a, b): string[]          // section ids that differ ("modified" marks, locks)
withSections(base, from, ids): BrushPreset   // base with those sections taken from `from` (locks, Copy Texture to Other Tools)
clearControls(preset): BrushPreset           // every toggled section off, tip kept (Clear Brush Controls)
blobsOf(preset): string[]                    // tip.sample.blob and dualBrush.tip.sample.blob
```

**S1.2 Preset kind `brushes`** (registered by `registerPresetKinds05`, S10.5; brush-settings-panel re-registers it with
groups and thumbnails): `data` is a `BrushPreset` without `dataUrl`s, `normalize: normalizeBrush`, `blobs: blobsOf`;
built-ins are 0.4's `BUILTIN_BRUSHES` (`panels/brushes.js`, kept as an export) under their 0.4 ids through
`brushFromLegacy`. Sample blobs always live in this kind, are content-addressed and are never removed (the store has
no blob collection; a tool or tool preset may still name a deleted preset's tip). **Migration**: `installToolBrush`
waits for `app.presets.ready('brushes')`; when `settings.brushes.migrated` is not true it adds each entry of 0.4's
`settings.brushPresets` (its id kept) and sets `migrated: true`. `settings.brushPresets` is never deleted.

**S1.3 The tool's brush** (`lib/brush/tool-brush.js`). Each painting tool has its own current brush, as in Photoshop.

```ts
toolBrush(app, toolId): { preset: BrushPreset /* merged: the flat tip keys applied to tip */, paint: ToolPaint }
setToolBrush(app, toolId, preset, { respectLocks = true, includeTool = true, presetId = null } = {}): void
prepareBrush(app, preset): Promise<void>   // decodes sample tips (blob, else dataUrl, which it also writes into 'brushes')
                                           // into a cache by hash and awaits texture patterns; computed tips resolve at once
sampleCanvas(hash): HTMLCanvasElement | null   // sync, for the engine; null until prepared
brushReady(preset): boolean
withSampleData(app, preset): Promise<BrushPreset>   // a copy whose SampleRefs carry dataUrl (replay args, exports)
supportsBrush(tool): 'full' | 'tip' | false     // 'full': StrokeTool subclasses with a size option; 'tip': the DabTool
                                                // family (size and hardness only in 0.5); false: other tools
installToolBrush(app): void                      // start(): migration (S1.2) and the command below
interface ToolPaint { opacity, flow, blend, smoothing, smoothingOptions: { mode: 'average' | 'pulled-string', catchUp: boolean,
                      catchUpOnEnd: boolean, adjustForZoom: boolean }, pressureSize: boolean, pressureOpacity: boolean, lockAlpha: boolean }
```

Storage: `settings.tools[toolId]` keeps 0.4's flat keys (`size`, `hardness`, `angle`, `roundness`, `opacity`, `flow`,
`smoothing`, `pressureSize`, `pressureOpacity`, `blend`, `lockAlpha`), gains a flat `spacing`, and `brush` (a full
`BrushPreset`), `brushPresetId` and `smoothingOptions`. **The flat keys win** for size, hardness, angle, roundness and
spacing (0.4 code, the `[`/`]` keys, the resize HUD, arrow rotation and the specs set them with `setOpt`); spacing
falls back to `brush.tip.spacing`, then 0.4's `settings.brush.spacing`, then 0.12. `smoothingOptions.mode: 'average'`
is 0.4's smoothing (`k = 1 − smoothing`) and the default, so every 0.4 stroke keeps its path.

`setToolBrush` writes `brush`, the flat keys and `brushPresetId` in one `saveSettingsSoon`, then calls
`app.tools.updateControl(key)` for each flat key it wrote, `updateCursor()` and `view.invalidate()`, emits
`'tool:options'` `{ tool, key: 'brush', value, presetId }` and starts `prepareBrush`. With `respectLocks`, the sections
in `settings.brushes.locks` keep the current brush's values; with `includeTool`, `preset.tool` values go to the flat
`opacity`, `flow`, `blend`, `smoothing`, and `tool.color` to `app.setColors({ foreground })`. **Protect Texture:** when
the current brush has `protectTexture` and the incoming preset's texture is enabled, the current pattern and scale are
kept. **"Modified"** (the panel's mark, the recent row) means `sectionDiff(toolBrush(app, id).preset, stored).length > 0`;
`brushPresetId` is never cleared by an edit.

`StrokeTool.baseSettings(layer, target)` (paint.js, landed by the skeleton) returns 0.4's flat object built from
`toolBrush`: `{ ...legacyTip(preset), ...paint, preset, color, background, mode, maskValue, lockTransparency,
antialias: true, view }`. Subclasses spread it and override keys exactly as in 0.4 (Pencil: `hardness: 1, flow: 1,
smoothing: 0, antialias: false, pressureSize: false`; Eraser Block: `size: 16`; the stamps' `sampler`; the Adjustment
Brush's `mode`, `maskValue`); S2.2's precedence makes those overrides win over the preset. A new ToolPaint field reaches
the stroke without a paint.js edit.

**Command `tool:brush-preset`** (registered working by the skeleton): arg a preset id of `brushes`, or `{ id?,
preset?, tool? }`; applies to `arg.tool`, else the active tool when `supportsBrush` is not false, else the last painting
tool; `ctx.setReplayArg({ id, preset: await withSampleData(app, preset) })`, so a replay works where the preset or its
tip does not exist. Recorded.

#### S2. Brush engine (`lib/brush.js` facade, skeleton; `lib/brush/engine.js`, stub by the skeleton, owned by brush-engine-core)

**S2.1 Facade.** `lib/brush.js` re-exports the engine's exports (below) and keeps `dabCanvas`, `drawBlended`,
`drawOnMask`; callers import from it only. The stub engine is 0.4's `BrushStroke` moved verbatim plus the hooks below;
`migrate` becomes a method.

**S2.2 Stroke.**

```ts
class BrushStroke {
  constructor(o: { target: { canvas, x, y, mask?: boolean }, layer, history, selection?: Selection | null,
                   onDirty?: (docRect, layer) => void, settings: object, modifiers?: DabModifier[] /* this stroke only */ });
  begin(sample): void;               // again within a stroke: a new sub-path (position and smoothing reset; the history
                                     // entry, dab index and fade count kept): strokePathPixels' sub-paths
  extend(sample): void;
  finish(sample): void;              // extends to the release point without smoothing (0.4's onPointerUp by hand)
  tick(now: number): void;           // build-up: the dabs due at `now` while the pointer rests (rAF; tests pass fake times)
  end(): HistoryEntry | null;  cancel(): void;  migrate(target, before): void;
  readonly target; readonly layer; readonly canvas; readonly dirty: Rect | null; readonly preset; readonly paint;
  readonly s: object;                // 0.4's merged settings view; `s.smoothing` stays writable (0.4 callers)
  readonly leash: { from: {x,y}, to: {x,y} } | null;   // pulled-string smoothing: drawn by the cursor (S3.2)
}
interface StrokePaint { mode: 'paint' | 'erase' | 'mask'; color: '#rrggbb'; background: '#rrggbb'; maskValue: number;
  opacity: number; flow: number; blend: BlendMode | 'behind' | 'clear'; lockTransparency: boolean; antialias: boolean;
  sampler?: (tctx, lx, ly, w, h, { x, y, size }) => void;      // clone, pattern and history stamps (0.4 semantics)
  smoothing: number; smoothingOptions?: ToolPaint['smoothingOptions']; pressureSize: boolean; pressureOpacity: boolean;
  label: string; constrainColor?: (rgb) => rgb; seed?: number; view?: CanvasView }
normalizeSample(partial, prev?): PointerSample   // pressure 1, tilt 0, twist 0, wheel 0, pointerType 'mouse',
                                                 // time = prev.time + 1 ms per px travelled (0 for the first)
```

**`settings`** is 0.4's flat object, optionally with `preset`: `splitStrokeSettings` takes `preset =
normalizeBrush(settings.preset ?? brushFromLegacy(settings))`, then every flat tip key present (`size`, `hardness`,
`angle`, `roundness`, `spacing`) overrides `preset.tip`, and every other key is a StrokePaint field. Every caller
(tools, `strokePathPixels`, previews, tests) uses this one form; samples may be partial (`normalizeSample` fills them).
History: 0.4's calls exactly (`beginStroke` in the constructor, `endStroke(dirty)`, `cancelStroke()`); one stroke is one
entry, build-up dabs, sub-paths and Shift-click lines included.

**S2.3 Dab model.**

```ts
interface Dab { x: number; y: number;          // stroke-canvas px, float
  size: number; angle: number; roundness: number; flipX: boolean; flipY: boolean;
  opacity: number;   // the stroke's opacity ceiling at this dab (Transfer's opacity control and jitter), 0..1
  flow: number;      // accumulation alpha of this dab, 0..1 (0.4's pressureOpacity scales flow: kept)
  color: [number, number, number]; tip: TipShape; index: number; t: number /* ms since begin */;
  sample: PointerSample;  direction: number /* degrees of travel */;  seed: number }
traceDabs(samples: (PointerSample | { break: true })[], settings, { seed = 1, finish = true } = {}): Dab[]
        // pure: sample stages, placement, smoothing and per-dab dynamics of a whole stroke; no pixels, no timer;
        // { break } starts a sub-path; with finish, the last sample is the release (S2.2 finish)
```

**Goldens (rule 11).** For 0.4's legacy settings and for presets whose sections are all off, `traceDabs` returns 0.4's
dab positions, sizes and flows exactly (`tests/fixtures/brush-golden/dabs.json`, recorded from the 0.4 code before
anything changes, the onPointerUp extend recorded as the finish), and strokes paint 0.4's pixels within tolerance: on
every case the largest per-channel difference is at most 3, the mean absolute difference over the stroke's bounding box
at most 0.35, and the aliased cases (Pencil, Eraser Pencil and Block) are equal. The stub engine is equal on every case.

**S2.4 Modifier chain.**

```ts
registerDabModifier(mod: {
  id: string; order: number;                         // same id: the later registration wins
  enabled(preset, paint): boolean;                   // false: costs nothing for this stroke
  begin?(ctx: StrokeContext): any;                   // once per stroke; returns the modifier's state
  sample?(s: PointerSample, state, ctx): PointerSample;   // every input sample (begin, extend, finish, tick, traceDabs),
                                                     // before smoothing and placement, in order: Brush Pose
  geometry?(dab: Dab, state, ctx): Dab[] | void;     // edit the dab in place, or return several (Scattering's count)
  coverage?(mask: { data: Float32Array, width, height, x, y, scale }, dab, state, ctx): void;
                                                     // the dab's coverage (0..1) before it is accumulated: Texture each
                                                     // tip, Dual Brush, Noise, Wet Edges
  buffer?(img: ImageDataLike, rect, state, ctx): void;   // the accumulated stroke inside rect, each time it is composited
  reach?(preset, paint): number;                     // px this modifier adds beyond the tip (Scattering, Dual Brush, Pose)
  end?(state, ctx): void;
}): () => void
dabModifiers(): DabModifier[]                        // registered ones, in order
interface StrokeContext { preset, paint, stroke: BrushStroke | null /* null in traceDabs */, doc, layer, app,
  random: (salt: string) => () => number /* seeded from paint.seed */, constrainColor(rgb), patterns: app.patterns }
```

Data contracts. `coverage`'s mask covers dab bbox ∩ target canvas ∩ selection bounds (x, y: stroke-canvas px of its
0,0); above 1024 px the engine may hand a reduced mask (`scale` < 1, one mask pixel per `1/scale` canvas px) and
modifiers honour it. `buffer`'s `img` is straight-alpha RGBA8 of the accumulated stroke, before stroke opacity and the
selection clip; a modifier may only scale the A channel; every engine converts its own accumulation to this view.

Order ranges: 50 Brush Pose (`sample`); 100–199 Shape Dynamics; 200–299 Scattering; 300–399 Color Dynamics; 400–499
Transfer; 500–599 Texture; 600–699 Dual Brush; 700 Noise; 800 Wet Edges. brush-engine-core registers 100–499,
brush-settings-panel 50 and 500–800. An enabled section with no registered modifier paints as off. **Stub:** 0.4's
engine plus `sample` on each input sample, `geometry` on every dab, `coverage` through a scratch canvas read back and
written back (only when such a modifier is enabled), `buffer` on a copy of the flushed rect. With nothing enabled the
0.4 path runs unchanged.

**S2.5 Pointer samples** (`canvas-view.js`, landed by the skeleton; every routed pointer event, coalesced events
included as in 0.4):

```ts
interface PointerSample {
  x, y; screenX, screenY;
  pressure: number;          // pen: e.pressure when > 0, else 1 (0.4); mouse and touch 1
  tiltX: number; tiltY: number;            // degrees -90..90 (0 for a mouse)
  twist: number;             // barrel rotation, degrees 0..359 (e.twist ?? 0)
  tangentialPressure: number;// stylus wheel, -1..1 (e.tangentialPressure ?? 0)
  altitude: number; azimuth: number;      // radians (e.altitudeAngle / azimuthAngle, else derived from tilt)
  pointerType: 'mouse' | 'pen' | 'touch';
  eraser: boolean;           // pen eraser end: pointerType 'pen' and (button 5 or buttons & 32)
  barrel: boolean;           // side button held during tip contact: pointerType 'pen' and (buttons & 2) on a primary press
  buttons, button, shift, alt, ctrl, meta;
  capsLock: boolean;         // e.getModifierState('CapsLock'): the precise cursor
  time: number;              // e.timeStamp
  temporary: 'ctrl' | 'alt' | 'space' | 'key' | null;   // 0.4 (F)
  original: PointerEvent }
```

A mouse sample gives the tilt, rotation and wheel controls their neutral value. A pen eraser contact arrives as
`pointerdown` with button 5 / buttons 32: canvas-view treats it as a primary press (canvas capture, `onPointerDown`
with `eraser: true`, moves and up as for button 0). A side-button press without tip contact arrives as button 2 and is a
right-button drag (S3.3) with `barrel: true`. Electron gets pen data through Chromium's pointer events; no command-line
switch is added unless a measurement in the packaged app needs one.

**S2.6 Tips, reach and previews.**

```ts
ENGINE: { id: string, version: number, features: { dynamics, sampledTips, buildUp, smoothingModes, smoothCurves, tilt, modifiersFor: string[] } }
                         // stub: { id: 'classic-0.4', version: 1, features: all false, modifiersFor: [] }
registerTipKind(kind, { render(tip, size): HTMLCanvasElement /* coverage in alpha */, outline(tip, o): [x, y][][] }): void
tipOutline(tip, { size, angle, roundness, flipX, flipY }): [x, y][][]   // polygons around (0, 0) in px; stub: an ellipse
renderTip(tip, size, color = '#000'): HTMLCanvasElement                 // thumbnails; stub: dabCanvas
strokeReach(preset, paint): number   // px from the pointer within which a dab can put pixels: size jitter, scatter,
                                     // pose and every enabled modifier's reach; stub: tip.size (0.4's growth margin)
renderStrokePreview(preset, paint, { width, height, scale = devicePixelRatio, path?: [x, y][], color }): HTMLCanvasElement
```

`renderStrokePreview` (the Brush Settings preview, the Brushes panel's stroke view) drives a real `BrushStroke` along
`path` (default: 0.4's S curve) on an offscreen target with a no-op history (`beginStroke` returns `{ backup }`) and a
synchronous flush at the end; the stub does the same with the stub stroke, so registered modifiers show before the
engine lands. `ensureCoverage` (paint.js) and `strokePathPixels`' grow rectangle (vector.js) grow by `strokeReach`
(skeleton call sites, marked). A sampled tip not yet decoded (`sampleCanvas` null) paints as a computed tip of the same
size, with one toast per stroke.

**S2.7 Every painting tool in 0.5.**

| Tools | Path |
|---|---|
| Brush, Pencil, Eraser (Brush, Pencil, Block), Clone Stamp, Pattern Stamp, History Brush, Adjustment Brush, Quick Mask painting | `BrushStroke` with `baseSettings` (S1.3): every section applies; the subclass overrides win (Pencil and Eraser Pencil/Block stay aliased whole-pixel dabs, equal to 0.4); samplers keep 0.4's meaning |
| Stroke Path (`vector.js strokePathPixels`) | `BrushStroke` with 0.4's settings: size and hardness of the tool, spacing `min(0.12, toolBrush spacing)`; one `begin` per sub-path |
| Blur, Sharpen, Smudge, Dodge, Burn, Sponge, Color Replacement, Background Eraser, Healing Brush, Spot Healing | DabTool's own 0.4 dab loop (size up to 1000, hardness, pressure for strength); gestures (S3) and cursors apply; their move onto the engine is retouch-tools-depth (0.7) |
| Mixer Brush, Art History Brush | not in 0.5 (brush-tips-mixer 0.10, retouch-tools-depth 0.7) |

16/32-bit documents: strokes paint the 8-bit proxy and `depth.js` rebuilds the deep pixels from it, as in 0.3 (float
stroke buffers are deep-pipeline, 0.9). Non-RGB modes: `constrainColor` is `app.colorConstraint` applied to the dab
colour, so Color Dynamics stay grey in Grayscale and snap in Indexed.

**S2.8 Cost at 5000 px** (the cap rises in the skeleton, under the stub engine too). `dabCanvas` (skeleton) bounds its
cache by total pixels (64 MP) instead of 200 entries, and quantises sizes above 128 px to 1 % steps (below, 0.4's whole
pixels: the goldens are untouched). Every engine keeps 0.4's repaint contract: `onDirty` per flush with rects that
include scattered dabs, an empty rect at the end, no full-view repaint per dab. `repaint-speed.spec.mjs` gains a case
gated on `ENGINE.id !== 'classic-0.4'`: a 2500 px soft stroke with Texture on a 4000 × 4000 document, under 25 ms per
dab on the CI runner, with no full repaint.

#### S3. Paint gestures, cursors and right-button drags

**S3.1 Gestures** (`lib/tools/paint-gesture.js`, stub by the skeleton; owned by brush-painting-behaviours).

```ts
export class PaintGesture {
  static real: boolean;          // stub false
  constructor(tool: StrokeTool);
  claims(p: PointerSample): boolean;   // a press the gesture takes from a temporary tool (S3.3); stub false
  down(p): void; move(p, dragging: boolean): void; up(p): void;
  contextDown(p): boolean;       // a right-button press: true takes the drag (S3.3); stub false
  cancel(): boolean;             // Escape mid-gesture
  key?(e: KeyboardEvent): boolean;
}
// paint.js after the skeleton: StrokeTool's constructor sets this.gesture = new PaintGesture(this), and
claimsPress(p) { return this.gesture.claims(p) }   onPointerDown(p) { this.gesture.down(p) }
onPointerMove(p, d) { this.gesture.move(p, d) }    onPointerUp(p) { this.gesture.up(p) }   onContextMenu(p) { return this.gesture.contextDown(p) }
strokeDown(p, opts = {}) / strokeMove(p, dragging) / strokeUp(p)    // 0.4's handler bodies; opts: { erase?: boolean, tool?: Tool }
```

The rename is mechanical: every StrokeTool subclass (paint.js, retouch.js's DabTool family and stamps,
adjustment-brush.js) defines `strokeDown/Move/Up` where 0.4 defined `onPointerDown/Move/Up`; Alt-click handling stays in
`strokeDown`. Stub: `down → tool.strokeDown(p)`, and so on. brush-painting-behaviours implements: Shift-click straight
lines (from the last stroke's end point, kept per tool and document: one `BrushStroke`, one history entry), Shift-drag
axis constraint, held ` (tilde) erase (`strokeDown(p, { erase: true })`), the pen's eraser end (`p.eraser`: the Eraser
tool's `strokeDown` with its own brush for this stroke, back on `up`), the brush-resize HUD (Alt+right-drag on Windows
and Linux, Ctrl+Alt+drag on macOS), and the HUD colour picker gesture (Alt+Shift+right-drag; Ctrl+Alt+Cmd+drag on
macOS): it opens `app.colorPicker.hud({ at, tool, initial })` (S7.1), forwards every move and the release to the session
and calls `cancel()` on Escape. Its `claims(p)` answers true for exactly those presses.

**S3.2 Cursors** (`lib/brush-cursor.js`, stub = 0.4's `StrokeTool.drawOverlay` and `cursorStyle` moved; owned by
brush-painting-behaviours): `drawBrushCursor(ctx, view, tool)`, `brushCursorCss(tool)`; paint.js calls them. The cursor
reads the tip from `tipOutline` and the leash from `stroke.leash`. **Cursor filter:** `app.tools.setCursorFilter(fn(css,
{ tool, view }) → css)` (one filter, the later wins) is applied inside `CanvasView.setCursor` (skeleton), so every caller
(tools.js, temp-tools.js, canvas-capture.js, text.js) goes through it: Other Cursors (Precise) and Caps Lock use it.
**Preferences:** the skeleton changes the built-in `tools` section (title "Cursors and tools", its five transform and
placement fields kept): `cursorStyle` offers `'standard' | 'precise' | 'outline' | 'full'` (Standard, Precise, Normal
Brush Tip, Full Size Brush Tip; 0.4's `'dot'` is read as `'standard'`; the default stays `'outline'`; the stub cursor
draws `standard` as 0.4's dot and `full` as the outline). brush-painting-behaviours registers a section `cursors`
(order 21) for `settings.painting.cursors` (Show Crosshair in Brush Tip, Only Crosshair While Painting, Other Cursors,
Brush Preview colour, leash colour); it adds no second `cursorStyle` field (skeleton-04 counts one).

**S3.3 Presses and right-button drags** (`canvas-view.js`, skeleton).

- **Press claims.** On `pointerdown`, while `view.tempTool` is set, canvas-view asks `app.tools.active?.claimsPress?.(p)`
  with the unstripped sample (button and modifiers). True: it calls `app.tempTools.clear()` and routes the whole press
  (down, moves, up; or `onContextMenu` for button 2) to the active tool. So holding Alt (temporary Eyedropper) then
  right-dragging reaches the Brush, and Ctrl (temporary Move on macOS) then Ctrl+Alt-dragging does not move the layer.
  Every 0.4 tool has no `claimsPress`; the stub gesture claims nothing.
- **Right-button drags.** A tool's `onContextMenu(p)` that returns `true` takes the drag: moves go to
  `onPointerMove(p, true)` (with `p.buttons & 2`), the release to `onPointerUp({ ...p, button: 2 })`. Every 0.4 tool
  returns `undefined` and behaves as before.
- **Button 5** (pen eraser): a primary press (S2.5).

#### S4. PSD mapper registries (`lib/psd/*`, skeleton; packages register from their own files)

**S4.1 Move.** 0.4's PSD code leaves `io.js`: `readPsdDocument` to `lib/psd/read.js`, `writePsdDocument` to
`lib/psd/write.js`, the pieces to the registered mappers below, 0.4's private helpers (`rgbFromPsd`, `psdColor`,
`psdBlend` / `toPsdBlend`, `psdGradientStops`, `GRDM_CODES`, the gradient and pattern conversions of
`adjustmentToPsd/FromPsd`) to `lib/psd/convert.js` (skeleton, frozen: colour through `fromLab` of S6.5, so Lab colours
stop turning black or white; blend modes; ag-psd gradients ↔ GradientDef; ag-psd patterns ↔ a `patterns`-kind blob or
a PatternRef with `dataUrl`). `io.js` re-exports `readPsdDocument`, `writePsdDocument`, `adjustmentToPsd`,
`adjustmentFromPsd`, `blendIfToPsd`, `blendIfFromPsd`, `psdExpressible`, `PSD_TEXT_KEYS`, `cssFamilyFromPsFont` (tests
import them from `/lib/io.js`); the owners of the files that now hold them keep these exports (rule 2).
`lib/psd/index.js` imports the registry, `builtin.js` and every mapper file (`adjustments.js`, `effects.js`, `vector.js`,
`tags.js`, `text.js`); later skeletons add one import line per new mapper file (reserved: `resources.js`, `channels.js`,
`deep.js`, `modes.js` 0.6, `smart-filters.js` 0.6, `smart-objects.js` 0.7, `comps.js` 0.8, `artboards.js`,
`annotations.js` 0.9, `slices.js` 0.10). **Node-safe imports:** `lib/psd/*.js` import at top level only Node-safe
modules (the registry, `convert.js`, `document.js`, `type/model.js`, `type/api.js`, `src/shared/*`, `#ag-psd`); they
reach fonts through `fontCatalog()` at call time and never import `font-library.js`, `fonts.js` or a DOM module, because
many Node tests import `io.js`. The psd-registry unit test imports `io.js` in Node with every mapper loaded, as a guard.

**S4.2 API** (`lib/psd/registry.js`; the same id registered twice: the later wins; a `{ builtin: true }` registration
never replaces one made before it).

```ts
registerPsdLayerKind({ id, order,
  test?(pl, ctx): boolean;  read?(pl, ctx): Layer;                 // read: the first kind (by order) whose test passes builds the layer
  match?(layer, ctx): boolean;  write?(layer, ctx): AgPsdLayer | null })   // write: the first kind whose match passes writes the record
registerPsdAspect({ id, order, read?(pl, layer, ctx): void, write?(layer, rec, ctx): void })   // every layer, by order
registerPsdResource({ id, order, read?(psd, doc, ctx): void, write?(doc, psd, ctx): void })    // document level; on write,
                                                                                                // order < 500 before the layers
registerPsdOptions({ read?(opts): opts, write?(opts): opts })      // ag-psd options (0.4: skipThumbnail, skipLinkedFilesData;
                                                                    // generateThumbnail, noBackground)
registerPsdNotice(code, { when: 'open' | 'save', text(count, details): string, timeout?: number })
psdFeatures(): Record<string, boolean>    // the merged PSD_FEATURES flags of the mapper files (S15); Node-safe
interface PsdReadCtx  { doc, psd, opts, report, parent: GroupLayer, claim(layer, part), claimed(layer, part), patterns: Map }
interface PsdWriteCtx { doc, psd, opts: { compositor, maximizeCompatibility, ... }, report, claim(layer, part), claimed(layer, part),
  shown(canvas, x, y) /* pixels as the image mode shows them, 0.4 */, maskOf(layer, parts) /* K.1 bake */,
  modeRendered: boolean /* 0.4's modeRender is non-null */, asShown(hex): boolean /* 0.4's textAsShown test */ }
report: { add(code, detail?): void; count(code): number; lines(): string[] }
```

**Claims.** A mapper that writes a feature natively claims it: `'effects'`, `'advanced-blending'`, `'vector-mask'`
(the layer's own `layer.vectorMask` written as `vmsk`; a shape kind claims `'shape'` only), `'text'`, `'shape'`,
`'fill'`, `'adjustment'`, `'tags'`. The built-ins read the claims: the built-in raster-mask aspect writes `maskOf(layer,
claimed(layer, 'vector-mask') ? 'raster' : 'all')` (J.8 when nobody claimed the vector mask); the notice `'styled'`
counts layers with enabled styles not claimed `'effects'` or non-default blending options (other than Blend If) not
claimed `'advanced-blending'`; `'pixel-text'` counts text layers no kind claimed `'text'`. So a notice disappears exactly
when a package starts writing the feature. **Mode documents:** while `ctx.modeRendered`, a kind or aspect that writes
colours (shape, fill, text, effects, advanced blending) writes natively only when every colour it writes passes
`asShown`; otherwise it declines without claiming, raster (900) writes `shown()` pixels and the 0.4 notices stay.
16/32-bit documents: the mappers run on the 8-bit proxies, as 0.4's writer did.

**S4.3 Order** (0.5 and reserved). Kinds: group 100 (built-in), artboard 120 (0.9), adjustment 200 (psd-layers; stub
0.4's mapping), fill 300 (psd-layers), shape 350 (psd-layers), text 400 (psd-text; stub 0.4's), smart-object 500 (0.7),
raster 900 (built-in: any layer no other kind wrote, as rendered pixels). Aspects: common 100 (name, visibility,
opacity, fill, blend, clipping, locks), blend-if 200, advanced-blending 210 (psd-layers), vector-mask 290 (psd-layers),
raster-mask 300 (built-in 0.4's; psd-layers re-registers it, S4.6), effects 400 (psd-layers), tags 500 (psd-layers:
colour labels, link groups), smart-filters 600 (0.6), comps 700 (0.8). Resources: resolution 100, guides 200,
global-light 250 (psd-layers: `doc.globalLight` ↔ `globalAngle` / `globalAltitude`), psd-document's 300–450 (0.6),
comps 600, notes 650, composite and image-mode handling 900 (0.4's grey / duotone code, built-in). On read, a group's
aspects run after its children; ids are assigned by the kind.

**S4.4 Notices and Maximize Compatibility.** The built-in codes keep 0.4's texts exactly (specs assert them):
`'other-space'`, `'styled'`, `'no-psd-adjustment'`, `'colorized'`, `'guides-origin'`, `'pixel-text'`.
`writePsdDocument(doc, compositor, opts)` shows the save notices as toasts, one per code, as 0.4 did. Open notices
(`when: 'open'`, for example "2 layer effects Pigment does not have were dropped: Outer Glow (contour), …") are returned
as `doc.openNotices` (not saved) and shown by `documents.js openPaths` after the document opens. `encodeForPath` passes
its opts to `writePsdDocument`, which resolves `opts.maximizeCompatibility` when absent from
`doc.view?.app?.settings.psd.maximizeCompatibility` (`'never'` → false, else true), so Batch, the Image Processor and
"Close: save" follow the preference. The built-in composite resource honours false: no `flattenDocument`, a blank
composite as Photoshop writes it, `imageResources.versionInfo.hasRealMergedData = false`, no thumbnail. The reader keeps
0.4's composite fallback for a file without layers.

**S4.5 ag-psd: fixes, internals, `#ag-psd`.** `scripts/vendor-entries/ag-psd.js` imports `./ag-psd-fixes.js` (which
imports `./ag-psd-grdm.js` (0.4), `./ag-psd-layers.js` (psd-layers) and `./ag-psd-text.js` (psd-text); each fix wraps a
handler in ag-psd's `infoHandlersMap` / `resourceHandlersMap` as `ag-psd-grdm.js` does, is idempotent and exports
`patched: boolean`) and adds `export * from './ag-psd-internals.js'`. The internals entry (skeleton) re-exports from
`ag-psd/dist/*.js`: `readAbr`, `readCsh`, `readAse`, `readPattern`, `writePattern`, `createReader`, `createWriter`,
`readVersionAndDescriptor`, `writeVersionAndDescriptor`, `parseEffects`, `serializeEffects`, `parseVectorContent`, and
`parseBrushDescriptor(desc)` (a copy of abr.js's private `parseBrushShape` / `parseDynamics`, MIT notice kept). A
package needing another internal names it in its report and the integrator adds it. **Import path:** renderer modules
import ag-psd as `'#ag-psd'`: `package.json` gets `"imports": { "#ag-psd": { "node": "./scripts/vendor-entries/ag-psd.js",
"default": "./src/renderer/vendor/ag-psd.js" } }` and the import map `"#ag-psd": "./vendor/ag-psd.js"` beside the kept
`"ag-psd"` key (specs import that one); the CSP hash is recomputed (`node scripts/csp-hash.mjs`). Node tests therefore
load the real entry with every fix, and the 0.4 rule "Node tests import the fixes first" goes away. (If Chromium refused
a `#` key, the key becomes `ag-psd/internals` with a Node test loader; the integrator decides on the measured build.)
ICC profiles are not an ag-psd matter: resource 1039 is written and read at the byte level (S5).

**S4.6 psd-layers' exports for other packages** (stubs by the skeleton with these signatures; rule 12 rows):
`effects.js`: `stylesFromPsd(effectsInfo, { patterns }) → { styles, report }` and `stylesToPsd(styles, ctx) → {
effects, patterns, report }` (stub `{ styles: null, report: ['effects'] }` / `{ effects: null, … }`); `vector.js`:
`pathFromPsd(paths, w, h) → Path | null`, `pathToPsd(path, w, h)` (stub null). preset-files-manager's .asl and .csh use
them and gate their content assertions on `psdFeatures().effects` / `.vectorMasks`. psd-layers also re-registers the
`raster-mask` aspect: read, the user mask is `pl.realMask` when `pl.mask.fromVectorData`, else `pl.mask`, with density
and feather from `userMaskDensity` / `userMaskFeather` (`vectorMaskDensity` / `vectorMaskFeather` for the vector mask);
write, when `'vector-mask'` is claimed, the raster mask's pixels at full strength with those parameters, nothing baked.
A shape layer with its own vector mask (PSD cannot hold both) bakes or intersects it, reported. Read builds PatternRefs
with `dataUrl` from `ctx.patterns`. Effects Pigment lacks are dropped, or approximated by the nearest Pigment effect,
and reported on open with a count by name (a PSD layer's pixels carry no effects, so there is nothing to rasterise).

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
applyChunks(doc, bytes, formatOrExt, { purpose, opts }): Promise<Uint8Array>   // writeChunks(chunksFor(...)); `bytes`
                                                       // unchanged without a provider or for a format without chunks (GIF, TGA)
```

| Format | ICC | EXIF | XMP | IPTC | Resolution |
|---|---|---|---|---|---|
| JPEG | APP2 `ICC_PROFILE\0` + seq/count, split at 65 519 bytes | APP1 `Exif\0\0` | APP1 `http://ns.adobe.com/xap/1.0/\0` (standard packet) | APP13 `Photoshop 3.0\0`, 8BIM 0x0404 | APP0 JFIF density |
| PNG | `iCCP` (zlib; writing removes `sRGB`, `gAMA`, `cHRM`) | `eXIf` | `iTXt` `XML:com.adobe.xmp` | read only: ImageMagick's `zTXt` `Raw profile type iptc` | `pHYs` |
| WebP | `ICCP` (the file becomes VP8X: canvas size from the VP8 / VP8L header, flags set) | `EXIF` | `XMP ` | — | — |
| TIFF | tag 34675 | read and write in 0.6 (metadata-io) | tag 700 | tag 33723 | tags 282, 283, 296 |
| PSD | resource 1039 | 1058 | 1060 | 1028 | 1005 |

TIFF writes rebuild IFD0 at the end of the file (entries sorted, values over 4 bytes appended, the header's offset
updated, both byte orders, the next-IFD pointer kept); every other byte stays. Unit tests use files the tests build
(PNG through `pixels/png.js`, TIFF through `pixels/tiff.js`, PSD through ag-psd, small JPEG and WebP byte constants).

**Where it runs.** Open: `openDocument` reads the chunks of JPEG, PNG, TIFF, WebP and PSD files before decoding (S6.3).
Write, exactly once per file: `io.js exportImage` applies `applyChunks` after any encoder, built-in or registered (so
Export As, Quick Export, Export Layers to Files, Save for Web and 16-bit PNG / TIFF through it), with `purpose:
opts.purpose ?? 'export'`; `encodeForPath` passes `purpose: 'save'` to `exportImage` and applies `'save'` itself to
what it returns otherwise (PSD, layered encoders; not `.pigment`, which has its own entry, S6.2); `depth.js`'s `writeTo`
16-bit save applies `'save'`; `edit-ops.js`'s PNG clipboard copy applies `'copy'`. **In 0.5 the only provider is
icc-engine's `'icc'`**: with no provider every file is byte-identical to 0.4's. `file-info.js` keeps stamping XMP into
PSDs and reading EXIF/XMP on open as in 0.4; metadata-io (0.6) moves that onto providers and this reader. Export As
defaulting to "Convert to sRGB" as Photoshop does is export-as' (0.6); in 0.5 it embeds the document's profile.

#### S6. Colour pipeline (`lib/color/pipeline.js`, skeleton; the engine is icc-engine's)

**S6.1 Engine slot.**

```ts
interface ColorProfile { id: string /* sha-1 hex of bytes, or a built-in id */; name: string; bytes: Uint8Array | null;
  colorSpace: 'rgb' | 'gray' | 'cmyk' | 'lab'; wellKnown: 'srgb' | 'display-p3' | 'adobe-rgb' | 'prophoto' | 'gray-gamma-2.2' | null;
  source: 'builtin' | 'embedded' | 'system' | 'user' }
export const SRGB: ColorProfile               // { id: 'srgb', name: 'sRGB IEC61966-2.1', bytes: null, colorSpace: 'rgb', wellKnown: 'srgb', source: 'builtin' }
setColorEngine(engine: ColorEngine): void     // icc-engine, from lib/color/cmm.js install(); the later wins
colorEngine(): ColorEngine                    // the stub until then: id 'none', available false, ready() resolved,
                                              // decodeConversion 'default', adoptOnOpen nothing, displaySpace 'srgb',
                                              // transform identity, parse null, builtins and profiles [SRGB]
interface ColorEngine {
  id: string; available: boolean; ready(): Promise<void>;
  parse(bytes): ColorProfile | null; builtins(): ColorProfile[]; profiles(): Promise<ColorProfile[]>;   // + OS and user profiles
  transform(from, to, { intent = 'perceptual', bpc = true, format }): { identity: boolean, apply(src, dst, n): void }
  decodeConversion(chunks, format): 'default' | 'none';
  adoptOnOpen(doc, { chunks, format, conv }): void;
  displaySpace(view): 'srgb' | 'display-p3';       // the display transform itself is a display stage (S6.4)
}
```

**Sync and async.** Synchronous: `parse`, `transform().apply`, `decodeConversion`, `adoptOnOpen`, `displaySpace` and the
pipeline's `convertColor`, `toLab`, `fromLab`, `cssColor`, `describe`, `profilesList` (built-ins, the `color-profiles`
kind, OS profiles cached after the first `profiles()`), `profileById(id): ColorProfile | null`. Before `ready()` they
give the sRGB stub answers, and `'color:display-changed'` fires once the engine is ready. Asynchronous: `ready()`,
`profiles()`, `toSRGB`, `convertCanvas` (stubs `Promise.resolve(input)`; every call site awaits). icc-engine
instantiates the wasm on the main thread for parsing, transforms and display LUTs; a worker is optional, for bulk
conversions only.

**S6.2 The document profile.** `doc.profile: ColorProfile | null` (document.js). `null` is "untagged", read as the
working RGB space, `workingRGB()` (sRGB in 0.5; color-settings sets it in 0.6 through `setWorkingSpaces`). In 0.5 every
document stores RGB numbers; `doc.profile` is an RGB or Gray profile. `.pigment`: `describe().profile = { id, name,
colorSpace, wellKnown } | null` and the bytes as zip entry `profile.icc`; `readPigment` restores it (a 0.4 file has
neither: `null`; a 0.4 reader ignores both). Image > Duplicate and `cloneDocument` copy it; a smart object whose
document has another profile renders its numbers unconverted (known gap, linked-smart-objects 0.7).
`assignProfile(app, doc, profile, label)` is one history entry that swaps `doc.profile` and calls `doc.changed('props')`.

**S6.3 Open and save.** `openDocument` awaits `colorEngine().ready()` (at most 3 s; a launch with a file runs before the
wasm is compiled), reads the chunks, computes `conv = colorEngine().decodeConversion(chunks, format)` **before choosing
a reader**, and passes it to the built-in `decodeImage(bytes, name, { colorSpaceConversion: conv })` and to a registered
reader as `reader.read(bytes, { name, path, colorSpaceConversion: conv })`; `modes/formats.js`' two `decodeImage`
fallbacks (soft-alpha palette PNGs, GIFs that fail to parse) pass it on, and readers that decode themselves (TIFF,
16-bit PNG, GIF, PSD) never convert. After the document is built, `adoptOnOpen(doc, { chunks, format, conv })` (stub:
nothing). icc-engine answers `'none'` exactly when it will adopt the embedded profile: untagged files (and PNGs with
only `gAMA` / `sRGB`) decode as in 0.4. Save: the `'icc'` provider embeds `doc.profile.bytes` when the document is
tagged, unless `opts.embedProfile === false` or `opts.convertTo === 'srgb'` (the pixels were converted: nothing, or
sRGB, is embedded). Placing or pasting pixels from another profile copies numbers (known gap; the 0.6 policy converts).

**S6.4 Display.** `canvas-view.js paint()` draws through `toDisplay(shown, view, { preview })` (pipeline.js), where
`shown` is 0.4's `postProcess` result. `registerDisplayStage({ id, order, active(view), apply(canvas, view, { damage,
scratch }) → canvas })`: soft-proofing (0.6) at 100, icc-engine's transform (document profile → the view canvas's
space) at 900; stub: no stage. **Damage**, decided by `toDisplay` alone:
- `shown` is the composite: `compositor.takeDamage(view)` (compositor.js) returns the union of every rect the
  compositor's full composite changed since this token last took it, whoever called `composite()` (the view, the
  early return, `sampleMerged` for Info and the Eyedropper, the Navigator, exports); a token that never took gets
  `'full'`; `null` when nothing changed.
- a `postProcess` output (proof colours, isolation, Select and Mask, the mode dialogs): `'full'` on every paint, not
  kept (such previews on a tagged document cost one conversion per paint).
- a gesture preview frame (`preview.canvas`): converted whole into the stage's scratch buffer, never kept.
- stages key their kept copy on (input canvas, `doc.profile?.id`, display space) and convert in full on a miss (Assign
  Profile, a display change).

`displayCanvas(canvas, doc, { space }) → canvas` (sync; the caller caches) serves the Navigator (skeleton call site) and
the Camera Raw workspace's preview; layer thumbnails and other panel images stay unmanaged (known gap,
info-histogram-properties 0.6). The view's 2D context is created with `{ colorSpace: displaySpace(view) }` (stub
`'srgb'`); when the answer changes, the view swaps its `<canvas class="view">` for a new element (ruler listeners bound
once, canvas listeners per element; `view.canvas` is the live element, read at call time by `dialogs.js` and the
sessions). Targets for icc-engine: sRGB and untagged documents cost nothing (stage inactive); a 2000 × 2000 damage
converts in under 60 ms on the CI runner.

**S6.5 Conversions** (stubs in brackets): `convertColor(rgb, from, to)` [identity], `toLab(rgb, profile)` /
`fromLab(lab, profile)` [`pixels/color.js` sRGB D65, 0.4's numbers], `toSRGB(canvas | ImageDataLike, doc)` ['Convert to
sRGB' in Save for Web and the Image Processor; identity], `convertCanvas(canvas, from, to, opts)` [identity],
`cssColor(rgb, doc)` [`'#rrggbb'`; with an engine, `color(display-p3 …)` where needed], `describe(doc)` ['' without an
engine, else "Untagged RGB" or the profile's name with the depth: "Display P3 (16bpc)"], `profilesList()` [`[SRGB]`],
`profileById`. Numbers bound to no document (`settings.foreground` / `.background`, `recentColors`, RGB swatches) are
used unconverted in whichever document is active (known gap until color-settings, 0.6); screen samples
(`window.EyeDropper`) go through `convertColor(rgb, SRGB, doc.profile)`; Lab and book colours through `fromLab(lab,
doc.profile)`. CMYK numbers stay 0.3's naive model until color-settings.

**S6.6 UI placed by the skeleton.** New Document dialog: "Color Profile" select from `profilesList()` (stub: "sRGB
IEC61966-2.1", "Don't Color Manage This Document"), stored in `newDocPreset.profile` and applied with `doc.profile` (sRGB
chosen means `null`, as 0.4). Status bar segment `profile` and the Info panel row "Profile" show `describe(doc)` and are
absent while it is ''; the Info panel's Lab row uses `toLab(rgb, doc.profile)`. `bridge.listColorProfiles(): Promise<{
path, name }[]>` lists the operating system's profile folders (macOS `/Library/ColorSync/Profiles`,
`~/Library/ColorSync/Profiles`; Windows `%WINDIR%\System32\spool\drivers\color`; Linux `/usr/share/color/icc`,
`~/.local/share/icc`); the browser bridge returns `window.__pigmentTest.colorProfiles ?? []`.

**S6.7 Depths and modes.**

| Document | What the profile means in 0.5 |
|---|---|
| RGB, 8/16/32-bit | the numbers of every layer (8-bit canvases and `deep` planes) are in `doc.profile`; 32-bit stays display-referred (0.3) |
| Grayscale, Duotone | an RGB or Gray profile; a Gray profile's tone curve is applied to each channel for display |
| Indexed | the colour table is in `doc.profile` |
| CMYK, Lab, Multichannel (channel views) | `doc.profile` is RGB; a tagged CMYK or Lab file opens as 0.3 converts it and an open notice says its profile was not used; profile-based conversion is color-settings' (0.6), real CMYK 0.10 |
| Bitmap | no profile |

Assign Profile changes `doc.profile` only; Convert to Profile (0.6) changes numbers. The 0.6 colour policy registers
an open hook (S12.6) and `registerColorPolicy({ onPaste })`, called by the 0.6 skeleton step in `edit-ops.js`.

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
app.colorPicker.hud({ at: { x, y } /* screen */, tool, initial }): HudSession
interface HudSession { move(p: PointerSample): void; up(p): void; cancel(): void; done: Promise<ColorValue | null> }
app.pickColor(initial, { title, live }): Promise<'#rrggbb' | null>   // 0.4's API, kept: pick() returning hex
swatchColors(app): '#rrggbb'[]      // the swatches as hex (the shape paint popover's row); stub: the `swatches` kind,
                                    // else 0.4's settings.swatches / DEFAULT_SWATCHES
```

The HUD session is the picker's: it draws, sets the foreground live through `app.setColors` as the drag moves (no
history entry, as the Color panel), restores the initial colour on `cancel()`, adds the colour to `recentColors` on
`up`, and resolves `done` with the final value (null when cancelled). The gesture only forwards (S3.1). Stub: a
session whose `done` resolves null on `up`. Stub picker (`real: false`): 0.4's dialog moved verbatim from `extras.js`
(S7.4's DOM included); `pick` wraps it. `tool:pick-fg` / `tool:pick-bg` (app.js) call `pick({ target })`; the
foreground and background stay `settings.foreground` / `.background` hex strings (0.4), set through `app.setColors`
(which applies `app.colorConstraint` for the image modes). Lab and CMYK fields go through `toLab` / `fromLab` (S6.5) and
0.3's CMYK model; swatch chips are painted with `cssColor`.

**S7.2 Swatches and books.** Kind `swatches` (registered by the skeleton with `DEFAULT_SWATCHES` as built-ins;
color-picker-swatches re-registers it with groups): `data = { color: { space: 'rgb' | 'lab' | 'cmyk' | 'gray', values:
number[] /* rgb 0..255, lab L 0..100 a b -128..127, cmyk and gray 0..100 */ }, book?: { book, name } }`, the name on the
preset. color-picker-swatches migrates 0.4's `settings.swatches` (when `swatchesEdited`) into the kind once
(`settings.colorUI.swatchesMigrated`); `settings.recentColors` stays where it is. Kind `color-books`: one preset per
loaded book, `data = { title, colorSpace, count, blob: 'book-<sha1>.json' }`, the entries in the side file; no licensed
books are shipped. **Files:** `lib/preset-files/aco-ase.js` (preset-files-manager; stub by the skeleton) exports pure
`parseAse(bytes) → { groups: { name, colors }[], colors: { name, color: S7.2 color, type: 'global' | 'spot' | 'process'
}[], report }`, `parseAco(bytes)` and the writers (stub: empty results and a report line; `ACO_ASE_REAL = false`). Opening,
dropping and the Swatches panel's Import send .ase / .aco to `swatches` only (`registerPresetFormat('swatches', …)`);
the Color Libraries dialog's "Load Book…" calls `parseAse` itself to build a `color-books` preset; color-picker-swatches
registers .acb with `registerPresetFileFormat({ kinds: ['color-books'] })`.

**S7.3 The `color` field widget** (fields.js, skeleton): `form.js` field type `color`, the options-bar kind `color`
(tools.js), the `paint` widget's solid colour, the gradient field's two stop colours (`data-key="start"` / `"end"`), the
Character panel's two colour inputs (`char-format.js`), `shape-paint-ui.js` and `lens-correction.js` build
`createWidget('color', spec, …)`; value `'#rrggbb'`. Stub widget: 0.4's DOM exactly (an `<input type="color"
data-key=…>` plus, in forms, the hex text input). color-picker-swatches registers the real one: a swatch button that
opens `pick({ target: 'field' })`, **keeping** an `input[type="color"]` with the field's `data-key` whose `input` event
sets the value (it may be visually hidden: `hunt.spec.mjs:169`, `guides-snapping.spec.mjs:456` set colours through it).

**S7.4 DOM the specs rely on** (kept by color-picker-swatches): the dialog's class `color-picker-dialog`; inputs
`[data-f="h|s|v|r|g|b|hex"]` and `[data-m="L|a|b|c|m|y|k"]`; OK as `.dialog-buttons .btn.primary`; a field commits on
`blur` and `change` (`text-color.spec.mjs:278`, `modes.spec.mjs:685`).

**S7.5 Eyedropper sampling.** `sampleMerged(app, doc, { stored, rect, until?: Layer, skipAdjustments?: boolean })`
(sample.js, skeleton): `until` and `skipAdjustments` map to `compositor.composite(doc, { until, skip })` and enter its
cache key. Photoshop's Sample menu maps to it: Current Layer (the layer's own pixels), Current & Below (`until`: the
layer above), All Layers, All Layers No Adjustments, Current & Below No Adjustments.

#### S8. Camera Raw: develop stages (`src/shared/pixels/develop-stages.js`) and registry (`lib/develop/registry.js`) — skeleton

**S8.1 Stages** (pure; Node tests, smart filters and actions run them). 0.2's `develop()` becomes a loop over
registered stages; with the 0.4 stages its output is identical (unit test against a frozen copy of the 0.4 function on
random images and every control). 0.4's helpers and constants (the `TO_LINEAR` / `TO_SRGB` tables, `toSrgb`, `luma`,
`scaleToLuma`, `applyLumaCurve`, `localContrast`, `textureContrast`, `gaussianBlurFloat`, `saturate`, `applyHsl`,
`hslRangeWeights`, `HSL_RANGES`, `DEVELOP_DEFAULTS`, the seeded random, `denoise`) move verbatim to
`src/shared/pixels/develop-util.js`, which imports nothing from `develop*`; `develop.js` re-exports what it exported in
0.4. **Import rule:** `develop-more.js`, `develop-profile.js` and their imports may import `develop-stages.js` and
`develop-util.js`, never `develop.js` (a unit test imports `develop-more.js` first and must not throw).

```ts
registerDevelopStage({
  id: string, order: number, space: 'linear' | 'perceptual' | 'resample',
  params?: { keys: string[] /* the top-level param keys it owns */, defaults(): object, normalize?(p): object },
  neutral(p): boolean,                    // p: the whole normalized params; true: skipped
  margin?(p, w, h): number,               // px read around a pixel; Infinity: needs the whole layer
  apply(planes: { R, G, B, A: Float32Array /* A 0..1 */, w, h }, p, ctx: { processVersion, rect, docWidth, docHeight, seed }): void,
                                          // 'resample' stages may replace the planes (A resampled too; uncovered corners A 0)
  mapPoint?(pt, p, ctx, dir: 'forward' | 'inverse'): { x, y },   // resample stages: source ↔ output
  xmp?: { [paramPath]: { name: 'crs:…', type: 'number' | 'bool' | 'enum' | 'seq', scale?, offset?, encode?(v), decode?(x) } }
}, { builtin? })                          // same id: the later wins; a builtin never replaces an earlier registration
developStages(); developDefaults(); normalizeDevelopParams(p);   // the registered stages' defaults merged
mapToSource(pt, params, ctx): { x, y }   // composes the active resample stages' inverse mapPoint (tools click the output)
develop(img, params, rect = null): ImageDataLike    // 0.2's signature; alpha written back when a resample stage ran
```

**Params.** 0.4's flat params stay where they are (`temperature`, `tint`, `exposure`, `contrast`, …, `texture`,
`clarity`, `dehaze`, `vibrance`, `saturation`, `vignette`, `grain`, `seed`, and the nested `hsl`, `sharpen`, `noise`),
each owned by the builtin that reads it: they are in `.pigment` smart filters and recorded actions, and `extras.spec`
reads `data-key="vignette"`. New sub-parameters go in new top-level objects named after their stage: `vignetteStyle {
style, midpoint, roundness, feather, highlights }`, `grainStyle { size, roughness }`, `curve`, `colorGrading`, `optics`,
`geometry`, `calibration`, `bwMix { <range> }`, `profile` (S8.4). `processVersion` 1 ↔ `crs:ProcessVersion` "6.7", 2 ↔
"11.0".

**Order:** `'resample'` stages first (geometry and optics, 50–90); then linear (white balance 100, exposure 200, profile
250, calibration 280); the conversion to perceptual values; then tone 300, texture/clarity 400, dehaze 450, colour
500 (vibrance, saturation), HSL / Color Mixer 510, treatment (B&W) 520, colour grading 530, curve 540, noise reduction
600, sharpening 650, effects (vignette 700, grain 800). The skeleton registers 0.4's steps as builtin stages
`white-balance`, `exposure`, `tone`, `texture-clarity`, `dehaze`, `vibrance-saturation`, `hsl`, `noise`, `sharpen`,
`vignette`, `grain`, plus `treatment` (`p.treatment: 'color' | 'bw'`, default `'color'`: a luminance mix with 0.3's
Black & White weights). camera-raw-panels owns `treatment` from then on (it re-registers it with the Color Mixer's
`bwMix`); the workspace's B&W button only sets `treatment`. `develop.js` imports `develop-more.js` (camera-raw-panels'
stub) and `develop-profile.js` (camera-raw-workspace's stub), both empty, after the registry and before registering the
builtins, so the builtin rule keeps the packages' stages. **Process version:** `p.processVersion`, absent = 1 (every
0.2–0.4 smart filter and recorded step); the 0.5 workspace writes 2 for new edits and keeps an existing filter's
version until the user updates it. A stage whose output changes for existing params keeps its version 1 path
(camera-raw-panels' dark-channel dehaze is version 2 only).

**S8.2 Registry and workspace** (renderer).

```ts
registerDevelopTab({ id, label, order, modes?: string[] }, { builtin? })
registerDevelopSection({ tab, id, label, order, fields?: FieldSpec[] | ((mode) => FieldSpec[]), render?(ctx): HTMLElement,
                         test?(ctx): boolean }, { builtin? })      // ctx: { params, get, set, app, session, workspace | null }
registerDevelopTool({ id, label, icon, key?, order, cursor, activate?(ws), deactivate?(ws), down(p, ws), move?(p, ws, dragging),
                      up?(p, ws), overlay?(ctx, ws) })       // zoom, hand, white balance, sampler, targeted adjustment, guided Upright
registerWorkspaceSlot({ id, place: 'toolbar-start' | 'toolbar-end' | 'panel-top' | 'footer-start' | 'footer-end' | 'filmstrip', order,
                        render(ws): HTMLElement })           // raw-open-workflow (0.6) adds the filmstrip and output buttons
developTabs(): tab[]     // with their sections, in order
interface DevelopWorkspace {
  params: object; get(path): any;
  set(path, value, { final = false } = {}): void;   // intermediate values preview; final ends a drag; no history inside
                                                     // the dialog (OK records the one entry)
  source: ImageDataLike & { origin: { x, y } };      // pre-develop pixels; origin in document px
  sample(pt, { radius = 1, stage?: string | 'before' | 'after' } = {}): [r, g, b];
  toImage(screenPt): { x, y }; toScreen(imagePt): { x, y };   // output image px (after resample stages; mapToSource for source)
  zoom: number; activeTool: string | null; invalidate(): void; setCursor(css): void;
}
createFakeWorkspace(params, image): DevelopWorkspace   // registry.js: tools are tested before the workspace lands
```

Tool callbacks get `p = { x, y }` in output image px plus the PointerSample modifiers; `overlay(ctx, ws)` draws in
screen CSS px. The skeleton registers 0.4's four tabs as builtins from `lib/develop/tabs-04.js`: `basic` (sections
`white-balance`, `tone`, `presence`), `detail` (`sharpening`, `noise`), `hsl` (modes hue / saturation / luminance),
`effects` (`vignette`, `grain`), with 0.4's fields. camera-raw-workspace replaces `basic`'s `white-balance` section and
adds `profile`; camera-raw-panels replaces `presence`, `detail`'s sections, `hsl` (Color Mixer, same tab id), `effects`,
and adds the tabs `curve`, `color-grading`, `optics`, `geometry`, `calibration`.

**S8.3 The dialog the skeleton lands** (develop-ui.js, then camera-raw-workspace's): `developEditor` builds its tabs and
sections from `developTabs()`, with 0.4's DOM, which `extras.spec.mjs` uses and the workspace keeps: the root
`.camera-raw` inside a `.dialog`, `button[data-action="auto"|"reset"]`, tabs `.dialog-tab[data-tab=<id>]` (ids `basic`,
`detail`, `hsl`, `effects` stay), number inputs `input[type="number"][data-key=<param path>]` (`exposure`,
`hsl.<range>.<mode>`, `vignette` stay), and the live preview through the pixel-edit session (`session.show`). OK records
one "Camera Raw" entry. When a stage's `margin` is Infinity, the session starts with `ignoreSelection: true` and the
selection masks the result at commit. **Smart filters (E55)**: `app.smartFilters.registerKind(kind, def)`
(smart-object.js, skeleton) gains optional `open?(layer, params, { index, label }) → Promise<params | null>` (when
present, `intercept` with params null and `edit(layer, index)` call it instead of the 440 px `filterDialog`; the kind
previews through `layer.filters` + `d.changed`, and smart-object.js still records "Smart filter" / "Edit smart filter"
through `setFilters`), `recolourOnly?(params) → boolean` and `geometric?: boolean | (params) => boolean`, which replace
camera-raw's entries in `RECOLOUR_ONLY` and `GEOMETRIC_FILTERS`. The skeleton's develop-ui registers `geometric: true`,
`recolourOnly: () => true` and `padding` from the stages' margins (0.4's results unchanged); camera-raw-workspace adds
`open` (the workspace on the smart layer) and makes `recolourOnly` false while a resample stage is active.

**S8.4 Presets, snapshots, profiles, settings.** Kinds `camera-raw-presets` (`data = { params: partial params, groups:
string[] }`), `camera-raw-snapshots` (`data = { params, document: name }`) and `camera-raw-profiles` (`data = { name,
size, blob: 'lut-<sha1>.cube' }`, the user's LUT library; `.cube` registered with `registerPresetFileFormat({ kinds:
['camera-raw-profiles'] })`), registered empty by the skeleton, re-registered by camera-raw-workspace. The `profile`
param is self-contained so smart filters, `.pigment` files on another machine, actions and Last Filter render the same:
`profile: { id, name, amount /* 0..200 */, lut?: { size /* ≤ 33 */, domain?: [min, max], data: string /* base64 Uint16
RGB */ } }`; a built-in look carries its id and `develop-profile.js` generates its LUT; a user LUT is embedded whole.
`.xmp` settings files map through the stages' `xmp` maps (unmapped fields, an embedded LUT included, are reported, never
invented); the skeleton writes the names for 0.4's fields (`crs:IncrementalTemperature`, `crs:Exposure2012`, …,
`crs:HueAdjustmentRed`, …, `crs:GrainAmount`); camera-raw-workspace owns the reader, the writer and the scales. Numbers
are document numbers: the stages read them with the sRGB tone curve whatever `doc.profile` says (known approximation
until raw-open-workflow's scene-linear path).

