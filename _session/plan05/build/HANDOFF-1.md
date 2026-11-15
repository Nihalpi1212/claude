# Hand-off 1: Pigment 0.5 skeleton, Part 2 steps 0 to 3

Implementer 1 of 5. Nothing is committed: everything below is in the working tree of /home/user/claude/pigment
(base 0.4.0, commit 99dbdee). No git command that changes anything was run.

## Baseline on the untouched 0.4.0 tree (before any change)

| Suite | Result |
|---|---|
| Unit (`node --test tests/unit/*.test.mjs`) | 878 / 878 pass |
| Browser (port 8850, whole suite) | **613** / 613 pass (22.5 min). The brief says 611; the tree at 99dbdee has 613 tests. |
| Electron | 6 / 6 pass |

No failure and no flake in the baseline run (no "Execution context was destroyed" seen).

## Step 0: goldens (recorded on the untouched tree, right after the baseline, before any other file changed)

- `tests/e2e/record-goldens.spec.mjs`: runs only with `PIGMENT_RECORD=1` (otherwise its 2 tests are skipped, so the
  whole-suite count shows 2 skipped from now on). Command:
  `PIGMENT_RECORD=1 PIGMENT_E2E_PORT=8850 npx playwright test -c tests/e2e/playwright.config.mjs record-goldens`.
  **Do not run it again**: the files must stay the 0.4.0 recording.
- `tests/e2e/goldens.mjs` (new, not in the contract; see deviations): the cases and the page code shared by the
  recorder and by the checks still to be written (`brush-golden.spec.mjs`, step 4; skeleton-05 "psd", step 5):
  `W`, `H` (160 × 120), `BASE_SETTINGS`, `CASES`, `TOOL_OPTIONS`, `TOOL_SETTINGS`, `TOOL_CONTEXT`, `PSD_GOLDEN_DOCS`,
  and three page functions for `page.evaluate`:
  - `pageStrokeCases({ cases, W, H, log, png })`: rebuilds each case's base on the active layer of a W × H
    document and strokes it. If the page defines `window.__goldenStroke(c, { target, layer, settings, selection,
    history })` (returning the dirty rect), that drives the stroke instead of 0.4's BrushStroke loop: that is how the
    0.5 checks drive the legacy form, the preset form, or the tools. Returns `{ id, dirty, rgba (base64 straight
    RGBA), png?, dabs? }` per case.
  - `pageToolSettings(...)`: what each tool's `strokeSettings` returns for the fixed options.
  - `pagePsdGolden(which)`: builds one of the six documents (a new document) and returns `readPsd` JSON; if the page
    defines `window.__goldenWritePsd(doc)` it writes with that instead of `writePsdDocument(doc, compositor)`.
- `tests/fixtures/brush-golden/`: `cases.json` (the cases with settings, samples, bases, the dirty box, the dab count,
  how they were driven, and `toolSettings` for Brush, Pencil, Eraser Brush / Pencil / Block and Clone Stamp),
  one PNG per case, `dabs.json` (`{ [case]: [{ x, y, pressure, size, flow }] }` from wrapping
  `BrushStroke.prototype.dab` inside the recorder only; size and flow computed as 0.4's `dab()` does).
  **PNG format:** straight RGBA from `getImageData`, encoded with `src/shared/pixels/png.js encodeRgba8`. Decode with
  `decodePng` + `toRgba8` and compare with `getImageData` of the stroked canvas; never load the PNG through a canvas
  (premultiplication rounds low alphas and would break "equal").
  Each case was run twice in the recording and was identical both times (pixels and dabs).
- `tests/fixtures/psd-golden/{text,adjustments,masks,styles,guides,grayscale}.json`: `readPsd(bytes,
  { skipLayerImageData, skipCompositeImageData, skipThumbnail, skipLinkedFilesData })` of 0.4's
  `writePsdDocument`, canvases as `{ $canvas: [w, h] }`, typed arrays as `{ $bytes: [...] }`. Each was written twice
  and identical. masks.json has a raster mask and a vector mask (baked into the raster mask, J.8); styles.json has a
  drop shadow (dropped, 'styled' notice) and Blend If; grayscale.json has a coloured raster, a grey text (kept as
  text) and a red text (written as pixels).
- `tests/unit/fixtures/develop-04.mjs`: 0.4's `develop.js` with a 3-line header (see deviations).

## Step 1: settings and styles

- `src/shared/defaults.js`: the twelve namespaces of S14.1 with their declared sub-keys (`brushes`, `brushEngine`,
  `painting`, `colorManagement`, `psd`, `cameraRaw`, `presetPanels`, `presetManager`, `colorUI`, `typeFonts`,
  `typeCommands`, `keymap`). `withDefaults` merges one level deep (0.4), so nested defaults (`painting.cursors`,
  `cameraRaw.view`, `keymap.menus`) are read with `??` by their owners; the keymap store normalises its own.
- Eleven empty stylesheets in `src/renderer/styles/` (`brush-settings`, `painting`, `color-management`, `camera-raw`,
  `presets-panels`, `preset-manager`, `color-picker`, `type-fonts`, `type-commands`, `shortcuts-editor`,
  `move-tool`), linked in `index.html` after the 0.4 package sheets. The CSP hash is unchanged (it covers the inline
  import map only).

## Step 2: stub modules and the module order

- MODULES (app.js): the twelve 0.5 command entries after `lib/stubs-later.js` in package order, the four panel
  modules after `lib/panels/layers-menu.js`, exactly as "New files" says.
- New stub files, each `install(app)` → `stubCommands` with its S13.3 ids: `lib/brush/define.js`
  (edit:define-brush, tool:airbrush-toggle), `lib/tools/paint-keys.js` (the 49 paint key commands; exports
  `PAINT_BLEND_MODES`, `PAINT_KEY_COMMANDS`), `lib/color/cmm.js` (edit:assign-profile), `lib/develop/workspace.js`
  (edit:camera-raw-preferences), `lib/develop/tabs/index.js` (none), `lib/tool-presets.js` (edit:define-custom-shape,
  tool:preset, tool:reset, tool:reset-all, layer:style-preset), `lib/preset-manager.js` (the three Presets ids),
  `lib/type/font-library.js` (the four type-fonts ids), `lib/type/commands.js` (the ten type-menu-commands ids,
  Type Mask tools included), `lib/shortcuts-editor.js` (help:shortcuts working, edit:menus and
  `{ id: 'edit:show-all-menu-items', record: false }` stubs), `lib/panels/brush-settings.js`, `styles.js`,
  `shapes.js`, `tool-presets.js` (their window:panel-* ids).
- Placeholders that later steps fill (they hold no 0.4 code yet, so they are empty MODULES entries in their place of
  the order): `lib/psd/index.js` (step 5: registry, builtin.js, the mapper imports and installs) and
  `lib/color-picker.js` (step 8: 0.4's picker dialog moved from extras.js, `app.colorPicker`, `swatchColors`).
  `lib/type/font-library.js` gets its catalog and widgets in step 9.
- `help:shortcuts` and `shortcutsDialog` moved verbatim from app.js into `lib/shortcuts-editor.js` (exported); in step
  3 its key lookup became `app.keymap.keysFor(cmd, 'type' | 'paint' | 'global')` and a paint group header says
  "(with a painting tool)".
- `lib/stubs-later.js`: `edit:color-settings`, `edit:convert-profile` (edit:menus gone).
- S14.2 edit of `tests/e2e/conventions-shortcuts-fields.spec.mjs` (was 218–223): the probe searches "color settings"
  and expects `edit:color-settings`; the `edit:menus` check stays, gated on `app.stubbed.includes('edit:menus')`.
- `tests/e2e/skeleton-05.spec.mjs` (port 8850): the S15 owner map and `landed(page)` (stub ids for five packages,
  module flags for the others; a flag module that does not exist yet is not imported, checked in Node with
  `existsSync`, because a 404 import would be a console error), the S13.3 id table, and the test "stubs".

## Step 3: keys and menus

- `src/shared/keymap.js`: MENU_KEYS gain F1 `help:guide`, F5 `window:panel-brush-settings`, F6 `window:panel-color`,
  F7 `window:panel-layers`, F8 `window:panel-info`, F12 `file:revert`; `help:devtools` left RENDERER_KEYS. New
  exports: `PAINT_BLEND_KEYS`, `PAINT_KEYS` (50 commands), `FIXED_KEYS` (`{ accel, platforms?, development? }`),
  `fixedKeyFor(cmd, { platform, isPackaged })`, `isPlainKey`, `accelCollides`, `normalizeOverlay`, `effectiveKeys`,
  `keyConflicts(effective, sources)` (sources named `source:<id>` in `commands`), `typeKeyFor(cmd, effective)`,
  `runsWhileTyping` false for `file:revert`; labels for every new id; SHORTCUT_GROUPS gain the new ids, a "Panels"
  group, a "Painting" group (`paint: true`, every PAINT_KEYS command) and a "Type menu" group.
- `src/shared/menu-template.js`: accelerators from `effectiveKeys(JSON.parse(state.keymap))`, then `fixedKeyFor`;
  every S13.2 item (Edit: Define Brush Preset…, Define Custom Shape…, Presets ▸, Color Settings…, Assign Profile…,
  Convert to Profile…, Camera Raw Preferences… (macOS: app menu after Settings…); Type: Add Fonts…, Anti-Alias ▸
  (radios on `state.antiAlias`), Convert to Paragraph/Point Text (`state.textKind`), Warp Text…, Create Work Path,
  Convert to Shape, Font Preview Size ▸ (`state.fontPreviewSize`), Update All Text Layers, Manage Missing Fonts…,
  Replace All Missing Fonts, Paste Lorem Ipsum; Window: the new PANELS order; Toggle Developer Tools takes
  Shift+CmdOrCtrl+F12 from FIXED_KEYS); `state.menus` customisation (hidden items left out unless `showAll`, a menu
  that lost items is tidied and ends with a separator and "Show All Menu Items", coloured items and submenus get
  `pigmentColor`); `menuItemCommands()`. Item keys live under a Symbol, so Electron never sees them.
- `src/renderer/lib/keymap-store.js` (new): `KeymapStore` with the whole S9.2 API (`effective`, `resolvedOverlay`,
  `keysFor`, `overlay`, `set` with placement, conflicts and `force`, `reset`, `conflicts`, `resolveKey`, `sets`,
  `activeSet`, `useSet`, `saveSet`, `deleteSet`, `registerKeySource`, `refreshSources`, `menus`, `setMenus`) and
  `normalizeMenus`, `MENU_COLORS`. Persists `settings.keymap` with `saveSettingsSoon`, emits `'keymap:changed'`, calls
  `app.syncUiState()`, re-reads settings.keymap on `'settings:changed'` when it differs from its own state.
- `app.js`: `app.keymap = new KeymapStore(app)` in `start()` before MODULES; ui state `keymap`, `menus`, `antiAlias`,
  `textKind`, `fontPreviewSize`; a `'key'` command from main.js goes through `app.keymap.resolveKey(cmd, 'key')`.
- `lib/shortcuts.js`: tables from `app.keymap.effective()`, rebuilt on `'keymap:changed'`; the paint table first while
  `paints(app.tools.active)` (first enabled command wins; stubs are disabled, so 0.4 behaviour holds); a matched F1–F12
  binding is `preventDefault`ed everywhere (dialogs, text fields); in text fields `runsWhileTyping` decides.
- `lib/type/edit-keys.js` (`setTypeKeyTable`), `lib/type/editor.js` (ACCEL_TABLE and `typeKeyFor` over the effective
  tables, rebuilt on the event; the session's `handle` answers `file:revert` from 'key' / 'menu-key' with nothing),
  `lib/tools.js` (tooltips and flyout through `rendererKey` → `keysFor`, the toolbox re-rendered on the event),
  `lib/toolbar.js`, `lib/command-search.js`, `lib/actions.js` (`builtinKeyOwner` over `effectiveKeys(app.keymap.overlay())`;
  the actions' function keys registered as key source `'actions'` with priority `'over'`, `refreshSources()` when
  they change on `'actions:changed'`). All marked `// keymap (lib/keymap-store.js)`.
- `src/main/main.js`: the menu state's `keymap` / `menus` from the ui state, or from `settings.keymap` before the first
  ui state; the Shift+Alt table from the effective keymap (cached per keymap string); coloured items become a 12 px
  dot `nativeImage.createFromBitmap` (one per colour); the devtools accelerator comes from the template.
- Tests: `tests/unit/keymap-05.test.mjs` (12), `tests/unit/menu-05.test.mjs` (5), `tests/electron/keys-05.spec.mjs`
  (1), skeleton-05 "keys" (3).

## Deviations from the contract (file, name, what differs, why)

1. **Step 0, number of stroke cases** (`goldens.mjs CASES`): 15, not "fourteen". The list in Part 2 names 15 strokes
   (pressure ramps with `pressureSize` and with `pressureOpacity` are two); the list wins.
2. **Step 0, `tests/e2e/goldens.mjs`** (new file not in the contract): the cases and the page code are shared so the
   checks of steps 4 and 5 rebuild exactly what was recorded (bases, Clone Stamp snapshot sampler, the elliptical
   selection, the six PSD documents). Hooks `window.__goldenStroke` / `window.__goldenWritePsd` let a check drive
   another form without copying the case code.
3. **Step 0, `tests/unit/fixtures/develop-04.mjs`**: not byte-verbatim: a 3-line header comment and the
   `./core.js` import rewritten to `../../../src/shared/pixels/core.js` (the only way the copy can load from
   tests/unit/fixtures; core.js is not changed by 0.5). Everything else is identical (`diff` checked).
4. **Step 0, PSD goldens and fonts**: text layers' layer bounds in `text.json` and `grayscale.json` come from the
   installed fonts of the recording machine (Chromium in Playwright here). Compare them on this machine, or ignore
   text layer bounds when the check runs elsewhere.
5. **Step 2 → the three Edit colour items**: Color Settings…, Assign Profile…, Convert to Profile… landed in step 2
   (not 3), because S14.2's conventions edit (step 2) searches the palette for "color settings", which only finds
   menu items.
6. **Step 2, `lib/psd/index.js` and `lib/color-picker.js`** are empty placeholders in the MODULES order now; their
   content is steps 5 and 8 ("the files holding moved 0.4 code arrive in their topic's step").
7. **Step 3, Electron F7 source** (`tests/electron/keys-05.spec.mjs`): the contract says F7 runs
   `window:panel-layers` once "with source 'menu-key'". Measured in Electron 44 on Linux: the page sees F7 first,
   shortcuts.js runs it with source 'key' and prevents its default, so the native accelerator never fires. The test
   asserts exactly one run, with 'key' on Windows/Linux and 'menu-key' on macOS (where the menu takes keys first).
8. **Step 3, Shift+Alt paint-only keys in main.js**: main's Shift+Alt table also holds the PAINT keys that have no
   global binding (Shift+Alt+Q Behind, Shift+Alt+R Clear) and sends them as their paint command with source 'key'
   (disabled stubs do nothing); otherwise Windows/Linux menu mnemonics would swallow them. Keys with a global
   binding go as the global command and `resolveKey` maps them (S13.4).
9. **Step 3, `set(..., { force: true })`** refuses (returns the conflicts, changes nothing) when the key is a
   FIXED_KEYS key or one a key source (an action) owns: neither is the keymap's to take.
10. **Step 3, `FIXED_KEYS` shape**: `{ [cmd]: { accel, platforms?: string[], development?: true } }` plus
    `fixedKeyFor(cmd, { platform, isPackaged })`, since both entries are conditional. `keyConflicts` checks them on
    every platform.
11. **Step 3, "plain key"** (placement in `set`): no Ctrl/Cmd/Alt and not a function key (F-keys go to the native
    menu, as S13.3's F5–F12 do); Shift+letter counts as plain.
12. **Step 3, `builtinKeyOwner`** (actions.js) reads `effectiveKeys(app.keymap.overlay())` rather than `keysFor`:
    `keysFor` reads the tables after the actions' own keys shadowed them, which would hide the very binding the
    Action Options note warns about.
13. **Step 3, Window > Toggle Full Screen** on Windows/Linux shows the effective renderer key (`F11` by default) as
    in 0.4 (0.4 hard-coded 'F11').

## Not done (not in steps 0–3)

- `tool:brush-preset` (S1.3) is step 4: `skeleton-05.spec.mjs` lists it in `SKELETON_LATER`; **step 4 removes it
  from that set** so the "stubs" test requires it.
- `lib/tools/paint-keys.js` builds its id list itself (BLEND_MODE_KEYS minus pass-through, plus behind and clear);
  it matches `Object.keys(PAINT_KEYS)` minus `tool:airbrush-toggle` (brush-engine-core's).
- Preset kinds `keyboard-shortcuts` / `menu-sets` are step 10 (`registerPresetKinds05`). Until then
  `app.keymap.sets()` returns the built-in "Photoshop Defaults" only, and `saveSet` / `useSet(other)` throw (the kind
  is not registered).
- Brush size cap 5000 (app.js `adjustBrush` still 2500) is step 4.

## Test counts at the end of step 3 (whole suites, run after step 3 with nothing else changing)

| Suite | Result |
|---|---|
| Unit | **895 / 895** pass (878 + keymap-05 12 + menu-05 5) |
| Browser (port 8850) | **617 passed, 2 skipped** (619 listed: 613 of 0.4 + skeleton-05's 4; the 2 skipped are record-goldens, which runs only with PIGMENT_RECORD=1), 24.9 min, no failure, no flake |
| Electron | **7 / 7** pass (6 + keys-05) |

No "Execution context was destroyed" failure in either of my two full runs. No test server or browser is left
running.

## Tips for the next implementer

- The two "golden" spec helpers are in `tests/e2e/goldens.mjs`; read its header. For "equal while
  `ENGINE.id === 'classic-0.4'`", compare `rgba` from `pageStrokeCases` with the decoded PNG byte for byte, and
  `traceDabs` with `dabs.json` (x, y, size, flow; pressure is there too).
- `cases.json toolSettings.tools[*].settings` is what 0.4's tools return with the Brushes panel's angle/roundness hook
  installed (`installTipHook`); after step 4 removes the hook, `baseSettings` must still give these values.
- skeleton-05's `landed(page)` already reads every S15 flag, including modules that do not exist yet
  (`lib/brush.js ENGINE`, `lib/tools/paint-gesture.js`, `lib/color/pipeline.js`, `lib/psd/registry.js`,
  `lib/develop/registry.js`, `lib/type/api.js fontCatalog`, `lib/tools/move-handles.js`, `lib/brush/abr.js`,
  `lib/preset-files/aco-ase.js`): it imports a module only if its file exists, so create those files at those
  paths.
- The keymap store's unit tests build it over a fake app (see `store()` in keymap-05.test.mjs); it imports only
  `src/shared/*` and `lib/tool-traits.js`, so it runs in Node.
- To simulate a native menu accelerator in the browser build: `window.__pigmentTest.bridge.__emit('command', cmd,
  arg, true)` (that is app.js's 'menu-key' path).
- Electron: `ELECTRON_ENABLE_LOGGING` noise in the Electron log is normal.
