# Hand-off 4: Pigment 0.5 skeleton, Part 2 steps 7 to 9 (Camera Raw, colour UI, type)

Implementer 4 of 5. Nothing is committed; no git command that changes anything was run. Working tree of
/home/user/claude/pigment on top of implementers 1–3 (base 0.4.0, 99dbdee). A copy of every file I created or edited
(current state, including earlier implementers' edits in shared files such as app.js) is in
`scratchpad/plan05/build/step789-files/` (same relative paths).

Start state checked: unit 936/936 pass (HANDOFF-3's count).

## Step 7: Camera Raw stages and registry, Last Filter for commands (S8, S12.4)

New files:
- `src/shared/pixels/develop-util.js`: 0.4's helpers and constants moved verbatim (generated from 0.4's develop.js
  text, only `export` added): `HSL_RANGES`, `RANGE_HUES`, `neutralHsl`, `DEVELOP_DEFAULTS`, `num`, `clamp`, `clamp01`,
  `smoothstep`, `TO_LINEAR`, `TO_SRGB`, `SRGB_STEPS`, `toSrgb` (the interpolated table, 0.4's internal one),
  `toSrgbExact`, `toLinear`, `LUMA_R/G/B`, `shadowsSafe`, `luma`, `scaleToLuma`, `applyLumaCurve`, `textureContrast`,
  `localContrast`, `gaussianBlurFloat`, `boxGaussian`, `boxBlurH/V`, `saturate`, `hslRangeWeights`, `weightTable`,
  `applyHsl`, `hslToRgb01`, `denoise`, `randomSeeded` (re-exported from core.js). Imports only core.js.
- `src/shared/pixels/develop-stages.js`: `registerDevelopStage(def, { builtin })` (returns an unregister function),
  `developStages`, `developDefaults`, `normalizeDevelopParams`, `mapToSource`, `develop(img, params, rect, opts)` (the
  loop), plus (deviations) `developNeutral`, `developMargin`, `isBuiltinStage`.
- `src/shared/pixels/develop-more.js`, `develop-profile.js`: empty stubs (`export {}`), imported by develop.js before
  the builtins.
- `src/renderer/lib/develop/registry.js`: `registerDevelopTab`, `registerDevelopSection`, `registerDevelopTool`,
  `registerWorkspaceSlot` (each `(def, { builtin })`, unregister function returned), `developTabs`, `developFeatures`,
  `setDevelopFeature`, `createFakeWorkspace(params, image, { origin, onSet, onInvalidate })`, plus `developTools`,
  `workspaceSlots(place)`, `isBuiltinDevelop(kind, id)`. Node-safe.
- `src/renderer/lib/develop/tabs-04.js`: 0.4's tabs/sections as builtins (basic 100: white-balance, tone, presence;
  detail 300: sharpening, noise; hsl 400 with modes; effects 800: vignette, grain), 0.4's fields and labels.
- `tests/unit/develop-stages.test.mjs` (6).

Edited:
- `src/shared/pixels/develop.js`: imports develop-stages, develop-more, develop-profile, registers 0.4's controls as
  builtin stages (`white-balance` 100 / `exposure` 200 linear; `tone` 300, `texture-clarity` 400, `dehaze` 450,
  `vibrance-saturation` 500, `hsl` 510, `treatment` 520 (B&W with 0.3's Black & White default weights), `noise` 600,
  `sharpen` 650, `vignette` 700, `grain` 800 perceptual), each with `params.keys/defaults(/normalize)`, `neutral`,
  `apply` (0.4's code block), `xmp` names (`crs:IncrementalTemperature`, `crs:Exposure2012`, …,
  `crs:HueAdjustmentRed`, …, `crs:GrainAmount`, `crs:ConvertToGrayscale`). Re-exports every 0.4 export
  (`normalizeParams`, `isNeutral` now over the stages; `toSrgb` is still `toSrgbExact`). `autoTone` stays here.
- `lib/develop-ui.js`: `developEditor` built from `developTabs()` with 0.4's DOM (consecutive plain sections share one
  form with headings: identical DOM for the builtins; a section with `render` or `test` gets a
  `.camera-raw-section[data-section]` box; ctx `{ params, get, set, app, session, workspace }`); a tool strip
  `.camera-raw-tools` with `button[data-tool]` only when tools are registered; its own dialog `developDialog` (0.4's
  pixelEditDialog for this dialog) that restarts the pixel session when the needed margin changes, with
  `ignoreSelection` for an Infinity margin and the selection masking preview and result; source `'action'` or
  `'repeat'` with params applies without UI, any other source with params opens the dialog prefilled (also on smart
  layers); the smart kind registers `geometric: true`, `recolourOnly: () => true`, `padding` from the stage margins
  (48 with the builtins, 0.4's value).
- `lib/smart-object.js` (E55): `'camera-raw'` left `GEOMETRIC_FILTERS` and `RECOLOUR_ONLY`; `geometric` may be a
  function of params; `recolourOnly(params)`; a kind's `open(layer, params, { index, label })` runs from
  `filterDialog` (so `intercept` with null params, `edit`, and the Layers panel's edit op), previews through
  layer.filters, the module restores the filters and records "Smart filter: X" / "Edit smart filter: X" once;
  `intercept`'s `start` prefills a registered kind's dialog.
- `lib/filter-ui.js`: `app.filterEditor.rememberCommand(id, name, params)` → `settings.lastFilter = { command, name,
  params }`; `filter:last` runs the command from `'repeat'` inside its own run and calls `setReplayCommand`;
  `filter:last-dialog` runs it from `'api'`. 0.4 `{ kind }` entries unchanged.
- `lib/actions.js`: `PROGRAMMATIC = /^(api|action|repeat)$/`.
- `lib/preset-kinds.js`: kinds `camera-raw-presets`, `camera-raw-snapshots`, `camera-raw-profiles` (empty).
- S14.2: `tests/e2e/extras.spec.mjs:32` → `data-tab` ids with `arrayContaining(['basic', 'detail', 'hsl', 'effects'])`.
- skeleton-05 "camera raw" (4 tests): a stage, a section (plain and rendered) and a tool registered in the page appear
  and drive the preview; a fake kind's `open` runs for a new and a re-edited smart filter, one entry each (padding 48
  gated on camera-raw-workspace); a whole-layer stage restarts the session without the selection, which masks the
  result; Last Filter repeats a remembered command from `'repeat'` and an action records one step with its params,
  Camera Raw repeats without its dialog, `filter:last-dialog` opens it prefilled.

## Step 8: colour UI (S7)

- `lib/color-picker.js` (color-picker-swatches' stub): 0.4's `pickColor` dialog moved verbatim from extras.js;
  `app.colorPicker = { real: false, pick(opts) → ColorValue | null, hud() → stub session (done null on up/cancel) }`;
  `app.pickColor` (0.4's hex API over `pick`); exports `swatchColors(app)`, plus `colorValue(hex)`, `swatchHex(data)`.
- `lib/extras.js`: picker and its imports removed (no longer sets app.pickColor).
- `app.js`: `tool:pick-fg/bg` → `app.colorPicker.pick({ initial, title, target })`, `setColors(c.hex)`.
- `lib/fields.js`: the stub `color` widget (spec `key`, `dataK`, `id`, `text`, `title`, `ariaLabel`, `className`,
  `style`; 0.4's DOM; `onInput` on `input`, `onChange` on `change`; the widget also exposes `.input`); the stub gradient
  widget's two end colours and the stub paint widget's solid colour use it.
- Call sites: `form.js` field type `color` (own case, `text: true`), `tools.js` option kind `color`, `char-format.js`
  (text colour, stroke colour), `shape-paint-ui.js` (solid colour; swatch row from `swatchColors(app)`, 0.4 names kept
  as tooltips), `lens-correction.js` (grid colour).
- `lib/sample.js`: `sampleMerged(app, doc, { stored, rect, until, skipAdjustments })`, both in the cache key.
- `lib/preset-kinds.js`: kinds `swatches` (DEFAULT_SWATCHES as builtins `default-<i>`), `color-books`,
  `color-profiles`.
- The Info panel's Lab row was already done in step 6 (HANDOFF-3 deviation 23).
- skeleton-05 "colour ui" (2 tests): a fake `color` widget appears in a dialog form (and its input sets the value), the
  options bar, the gradient field and the Character panel; the shape popover row equals `swatchColors`; `sampleMerged`
  with `until` (also with `rect`); the picker API, and the stub's dialog / HUD / `tool:pick-fg` gated on
  `app.colorPicker.real`.
- 0.4 colour specs run after step 8: gallery-b, guides-snapping, hunt, layers-panel-depth, modes, shapes-live,
  skeleton-04, text-color, type-character-panel, content-aware-lens, gradients, app: 130/130.

## Step 9: type (S11)

- `lib/type/model.js`: CharStyle `axes: {}` (after `postScriptName`; `CHAR_KEYS` 25) with its value check (finite
  numbers, four-character tags); `normalizeTypeOptions` normalises `warp` (kept only when valid); new exports
  `WARP_STYLES`, `ANTI_ALIAS_METHODS`, `normalizeWarp`. `tests/unit/type-model.test.mjs:26` → 25.
- `lib/type/api.js`: `registerTextRenderStage` (unregister function; redraws every text layer), `stageGeometry`,
  `renderText(layer, { matrix })` and `textBounds` through the active stages (lower order nearer the engine;
  `'bypass'` stages skipped while editing; `extensions` gate), `setEditing`, plus `isEditing`;
  `registerFontCatalog` / `fontCatalog` (default: an empty catalog with 0.4's style keys).
- `lib/document.js`: `TextLayer.render` asks `render(this, { matrix: this.transform })` and keeps a `transformed`
  result as it is.
- `lib/type/font-library.js` (type-fonts' stub): `createStubCatalog(app)` registered at install (0.4's families +
  granted local font records, STYLES, styleOf / styleToFont, fromPostScriptName, missing by families / records /
  metric aliases, `missing(doc)` [], `addFiles` → `addFontData`), `'type:catalog-changed'`; widgets `font-family` /
  `font-style` as 0.4's selects; its four stub commands; extra export `parsePostScriptStyle`.
- `lib/tools/text.js`: option kinds `font-family` / `font-style`; options-bar `antiAlias` select (seven values; runs
  `type:anti-alias`, else 0.4's `applyTypeOptions` label "Anti-Aliasing"), `orientationToggle` and `warpText` buttons
  (run the stubs); `fontFromOptions`, `syncFromLayer` (style through `styleKey`, antiAlias shown), `onOptionChanged`
  (family/style through `stylePatch`), `beginNew` (postScriptName / axes from the patch, antiAlias from the option);
  `new TypeTool(app, { id, name, icon, vertical, mask })` (0.4's `(app, vertical)` works), `sibling` by orientation and
  mask; `registerTypeTool`, `typeTools(app)`, `app.typeTools()`; `typeSession` and every install() listener iterate
  them; `setEditing` around sessions (openEditor / closeEditor). Export `ANTI_ALIAS_OPTIONS`.
- `lib/type/editor.js`: `editingTool` iterates `app.typeTools()`.
- `lib/tools.js`: kinds `font-family` / `font-style` fall back to 0.4's select while no widget is registered; button
  and select `title`.
- `lib/type/char-format.js`: anti-alias select with seven values, runs `type:anti-alias` (fallback 0.4's call).
- S14.2: `tests/e2e/type-character-panel.spec.mjs:101, 119`: `'700'` → the page's `fontCatalog().styleKey({ fontFamily,
  fontWeight: 700, fontItalic: false })`; `''` for mixed unchanged.
- skeleton-05 "type" (4 tests): a test stage recolours a text layer, is bypassed while editing and back after; a
  `transformed` stage gets the vertical layer's matrix and its result is used as it is; `warp` and `axes` survive
  `.pigment`, normalisation, `WARP_STYLES` equal warp.js' presets, seven methods in the options bar; the stub catalog's
  keys (gated on `fontCatalog().real`); a fake catalog's PostScript-name style from the options bar lands in the runs
  (one "Character" entry) and in new text, new text takes the anti-alias; a TypeTool subclass in the `text` slot is
  reached by Shift+T and `layer:new` commits its session.

## Deviations from the contract (file, name, what differs, why)

1. `develop-stages.js`: the loop `develop()` lives here (develop.js re-exports it) so stage code and the loop share
   one module; extras `developNeutral`, `developMargin(params, w, h)` (the dialog and the smart padding need it),
   `isBuiltinStage(id)` (rule-11 gating in the unit test). `develop(img, params, rect, { docWidth, docHeight })`: a 4th
   optional argument for ctx.docWidth/docHeight (default the image).
2. `params.normalize(p)`: receives the whole params (defaults merged in) and returns the values of the stage's own
   keys, which are merged in (the contract leaves the shape open).
3. Builtin `neutral(p)` uses 0.4's `isNeutral` semantics (any non-zero raw value), and `apply` keeps 0.4's clamped
   test, so a value that clamps to zero still unpacks/packs as 0.4 did (byte-equal, tested with `grain: -5`).
4. Builtin margins: `texture-clarity`, `noise`, `sharpen` declare 48 (0.4's fixed dialog margin) rather than their
   true reach, so dialog sessions and smart padding stay 0.4's. A package stage reading further raises it.
5. `developDefaults()` now includes `treatment: 'color'` (the treatment stage's key), so Camera Raw's recorded and
   smart-filter params carry it. 0.4's keys come first in 0.4's order.
6. `registry.js` extras: `developTools`, `workspaceSlots`, `isBuiltinDevelop`; registrations return unregister
   functions; `createFakeWorkspace` takes `{ origin, onSet, onInvalidate }` and records `sets`, `invalidations`,
   `cursor`; `sample` radius r averages a (2r−1)² box.
7. `develop-ui.js` no longer uses adjust-ui's `pixelEditDialog` (it cannot restart its session); `developDialog` is
   its copy for this dialog with the same DOM (Preview checkbox `data-key="__preview"`, buttons, busy commit). The
   session also restarts when a finite margin grows past the session's.
8. Tools in the skeleton dialog: a button strip and `activate(ws)` on a createFakeWorkspace over the session pixels;
   pointer input on the canvas is not routed to tools (camera-raw-workspace's workspace does that).
9. Smart layer + Camera Raw params from a source other than `'action'` / `'repeat'` (e.g. the assistant, `'api'`) now
   open the prefilled dialog instead of adding the filter directly (S12.4's rule; 0.4's raster path already did).
10. `filter:last` also accepts an arg `{ command, params }`; its `enabled` also needs the remembered command enabled.
    `filter:last-dialog` records the command with what it resolves with when that is an object, and cancels the
    recording when it resolves falsy (cancelled dialog).
11. Kinds: the three Camera Raw kinds in step 7; `swatches`, `color-books` and `color-profiles` in step 8 (the "three
    kinds" of step 8; HANDOFF-3 expected `color-profiles` in step 10). `swatches` builtins have ids `default-<i>` and
    the hex as name.
12. `swatchColors(app)` reads the `swatches` kind only once `settings.colorUI.swatchesMigrated` is true, else 0.4's
    `settings.swatches` / DEFAULT_SWATCHES, so 0.4's edited palette shows until color-picker-swatches migrates it.
13. `color` widget spec fields as listed above, `.input` on the widget object; form.js keeps its own `color` case
    (the generic widget path would add `data-widget`/`data-key` to the wrapper and duplicate the data-key in 0.4's
    DOM); the options bar's `color` kind uses `onInput` only (0.4 listened to `input` only).
14. The gradient field's two colours are in fields.js' stub `gradient` widget, which the gradients package (0.4,
    `gradient-widget.js`) replaces at start-up; its stop colours go through `app.pickColor`. The spec checks the stub
    widget on a second instance of fields.js (`import('/lib/fields.js?gradient-stub')`).
15. `color-picker.js` extra exports `colorValue`, `swatchHex`; `sampleMerged`'s `skipAdjustments` skips layers of
    type `'adjustment'`.
16. `model.js`: `TYPE_OPTION_DEFAULTS` is unchanged (no `warp` key: absent means null), so type-model.test.mjs:25 and
    every 0.4 typeOptions stay as they were. `WARP_STYLES` is listed in model.js (warp.js is not Node-safe); the spec
    checks it equals warp.js' presets.
17. `api.js`: `renderText` marks `transformed: true` when a `transformed` stage ran with a matrix (how
    TextLayer.render knows); `setEditing` redraws only when a registered `'bypass'` stage applies to the layer (with
    no stage, 0.4's sessions fire no extra change); `isEditing(layer)` extra; the default catalog has 0.4's style keys.
18. `font-library.js`: local records are read only when the `local-fonts` permission is granted (no prompt), at most
    3 s; fonts.js' metric-alias family names are copied (fonts.js is type-fonts' file and does not export them);
    `favourites` / `recent` are no-ops; extra exports `createStubCatalog`, `parsePostScriptStyle`.
19. `tools/text.js`: a family/style patch goes through `type/target.js applyChar` only when it says more than 0.4's
    font patch (a PostScript name, axes, or any patch of a `real` catalog); with the stub catalog 0.4's `applyFont`
    path runs unchanged (runs, entries, labels). New option keys `orientationToggle`, `antiAlias`, `warpText`. The
    install listeners iterate an iterable over `typeTools(app)`; `app.typeTools()` lets editor.js find a subclass's
    session without importing text.js. A mask tool without a partner has no `sibling` (null).
20. Anti-alias labels "Windows LCD" and "Windows"; the stub fallback keeps 0.4's label "Anti-Aliasing".

## Not done

Nothing of steps 7–9 is left. Not in my steps: the Character panel's family/style replacement (E26, type-fonts),
the `fonts`, `keyboard-shortcuts`, `menu-sets` kinds and the rest of `registerPresetKinds05` (step 10).

## Test counts at the end (after step 9)

(filled in below after the full runs)

## Tips for the next implementer (step 10: preset files)

- `lib/preset-kinds.js registerPresetKinds05()` now holds brushes, the three colour kinds and the three Camera Raw
  kinds; add the remaining kinds there. `color-books`, `color-profiles` and `camera-raw-profiles` already declare
  `blobs`.
- `skeleton-05.spec.mjs` helpers added: `fillLayer(page, color)` (step 7), `addTextLayer(page, text, props)` (step 9).
- To check a stub widget that a 0.4 package replaced, import a second instance of the module with a query string.
- After any edit near Camera Raw: `node --test tests/unit/develop-stages.test.mjs` compares with 0.4 in a second.
