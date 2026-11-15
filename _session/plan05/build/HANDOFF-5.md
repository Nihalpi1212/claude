# Hand-off 5: Pigment 0.5 skeleton, Part 2 steps 10 to 13 (preset files; toolbox and transform; specs and the full run; documentation)

Implementer 5 of 5. Nothing is committed; no git command that changes anything was run. Working tree of
/home/user/claude/pigment on top of implementers 1–4 (base 0.4.0, 99dbdee). A copy of every file I created or edited
(current state, which includes earlier implementers' edits in shared files such as app.js and skeleton-05.spec.mjs) is
in `scratchpad/plan05/build/step10-13-files/` (same relative paths).

Start state checked: unit 942/942 pass (HANDOFF-4's count).

## Step 10: preset files (S10, S7.2)

New files:
- `src/renderer/lib/preset-formats.js` (skeleton, Node-safe: the bridge is imported only when a dialog or a file read
  runs): `registerPresetFileFormat` (returns an unregister function), `presetFileFormats({ kind, write })` over both
  registries (this one, 0.4's per-kind formats, 0.4's `'*'` `.pigment-presets` last), `presetFileFormatFor(nameOrExt, {
  kinds })`, `registerBlobRefs`, `blobRefs`, `importPresetFiles(app, { paths, kinds })` (open dialog filtered by the
  registered extensions; toast of what was added, `app.dialogs.alert` with the report), `presetFileMenuItems(app, kind,
  { selectedIds })`, `exportPresetsDialog(app, kind, ids, { title, path, defaultName })` (`.pigment-presets` first, the
  typed extension picks the format, none → `.pigment-presets` appended), `BUNDLE_SETTINGS`, `installPresetFormats(app)`
  (the blob refs of `brushes` and `tool-presets`); extras `importPresetBytes`, `exportPresetBytes`, `opensAsPresets`,
  `presetFileExtensions`. File-local `ref` / `$presetRef` links (referenced items added first, placeholders become `{
  presetId, name }`), groups (parents first), item blobs to the kind `blobRefs` names, `.pigment-presets` routed by the
  kind in its JSON, `extraBlobs` written on export (only when there are any: 0.4's bytes otherwise) and on import.
- `src/renderer/lib/brush/abr.js` (brush-settings-panel's stub): `ABR_REAL = false`, `brushFromAgPsd(brush, samples)`
  → `{ preset, blobs, report }` (tip through `brushFromLegacy`, flips, Spacing off, a sampled tip as a SampleRef whose
  blob is a grey PNG named `tip-<sha1>.png`; other sections reported). Pure and synchronous (own CRC-32, stored-deflate
  PNG writer and SHA-1, checked against Node's crypto in the unit test).
- `src/renderer/lib/preset-files/aco-ase.js` (preset-files-manager's stub): `ACO_ASE_REAL = false`, `parseAse`,
  `parseAco` (empty results, one report line), `writeAse`, `writeAco` (`{ bytes: empty, report }`).

Edited (all marked `// preset files (lib/preset-formats.js)` or with a 0.5 / S10.5 comment):
- `lib/preset-kinds.js registerPresetKinds05()`: `fonts`, `keyboard-shortcuts` (built-in `photoshop-defaults`),
  `menu-sets` (built-in `default`), and `tool-presets` re-registered with 0.5's data (`normalizeToolPreset`, exported).
  The keymap store's `sets()` now lists the kind (Photoshop Defaults) and `saveSet` / `useSet` work.
- `lib/gradient-editor.js exportPresets` and `lib/pattern-picker.js exportPatterns` → `exportPresetsDialog` (same title,
  default name, filters, toast and error text as 0.4 when only `.pigment-presets` writes the kind).
- `lib/documents.js`: `openPaths` sends a file that only a preset format reads to `importPresetFiles` (S10.4);
  `openDialog` adds a "Presets" filter before "All files".
- `app.js`: `installPresetFormats(app)` in `start()` after `installToolBrush`; a Shift-drop imports preset files and
  places the rest (a plain drop goes through `file:open-paths`, which routes).
- `lib/path-ops.js` (`normalizeShapeProps` keeps a valid `shapeProps.unit`; `regenerateShape` fills it from the
  resolver while the preset exists) and `lib/shape-geometry.js` (`shapePath` prefers `unit` to the resolver).

Tests: `tests/unit/preset-formats.test.mjs` (5: a two-kind import with `$presetRef`, groups and blobs; both registries,
the export order and format choice, a store format of one kind; a tool preset's tip in `extraBlobs` landing in
`brushes`, `.pigment-presets` routed by its kind; malformed files never throw; the .abr and .aco/.ase stubs gated on
`ABR_REAL` / `ACO_ASE_REAL`), skeleton-05 "presets" (3): a fake two-kind format's file opened and dropped imports into
both kinds and opens no document, an .ase reaches `swatches` only (a stand-in format until preset-files-manager lands,
an ASE file built in the test either way), the Open dialog's Presets filter; with a writable gradients format
registered, the Gradients panel's Export All still writes `.pigment-presets` and a typed extension picks the other
format; a custom shape whose preset is deleted keeps its outline through edits, `.pigment` and PSD.

## Step 11: toolbox and transform (S12.1, S12.2)

- `lib/tools.js`: `registerOptionsSlot({ id, place, order, render })` (returns its unregister function; no slot → 0.4's
  bar exactly), `resetOptions(toolId | '*')`, `setOptions(toolId, values, { replace })` (one `saveSettingsSoon`, no
  `onOptionChanged`, per-key events with `batch: true`, then `'*'`).
- `lib/image-ops.js TransformTool`: `planFor(doc, { selectionOnly, quiet })` (extra: the target and box choice of
  `start()`, which now uses it), `previewBox(doc)`, `start({ mode, selectionOnly, grab })` (a grab clears the temporary
  tool, strips Ctrl/Meta and continues the drag through `beginDrag(p, handle)`, the press code `onPointerDown` now
  calls).
- `lib/tools/move-handles.js` (move-tool-depth's stub): `MOVE_FEATURES = { handles: false }`. Not imported by
  `tools/move.js` (move-tool-depth's file; it adds the import).

Tests: skeleton-05 "toolbox" (3): title / start / end slots render and go; `resetOptions`; `setOptions` on the Type tool
with a text layer active edits no layer, makes no entry and emits the keys then `'*'`; `previewBox` equals the session's
box and targets for a raster layer with a pixel selection and for two layers, null during a session and with nothing to
transform; a grab on `'se'` (move-tool-depth's real handle once `MOVE_FEATURES.handles`, else a patched Move tool press)
scales into one "Free transform" entry from the Move tool and from the Ctrl-held temporary Move tool over the Brush,
which is active again after the commit.

## Step 12: specs and the full run

- S14.2 checked line by line against the tree: `extras.spec.mjs:32` (data-tab ids, step 7), `hunt5-styles.spec.mjs` test
  at 106 (step 5), `adjustment-blending.spec.mjs:358/368/376` (376 gated; 358 and 368 hold both ways, step 5),
  `masks-vector-masks.spec.mjs:255–259` (step 5), `type-model.test.mjs:26` → 25 (step 9),
  `type-character-panel.spec.mjs:101/106/119` (101 and 119 through `styleKey`; 106's `''` holds both ways, step 9),
  `conventions-shortcuts-fields.spec.mjs:218–223` (step 2), `skeleton-04.spec.mjs:594–596` not edited (no diff). One
  more line found and gated: `shapes-live.spec.mjs:91` (see deviations).
- skeleton-05: "stubs" now also checks that `app.stubbed` is exactly S13.3's stub ids (with `edit:color-settings`,
  `edit:convert-profile`) while no package has landed; new "start-up" test (no console error or warning in the browser
  build, the start() services present). Stub assertions of steps 10–11 are gated: `.ase` stand-in on `ACO_ASE_REAL`
  and an already registered .ase format, the grab on `MOVE_FEATURES.handles`, the 0.4 title on presets-panels, slot
  orders chosen so a package's own slots cannot change the test's result, the gradients test format on its own
  extension (`skgrd`) so preset-files-manager's .grd does not take the typed name.
- `tests/electron/keys-05.spec.mjs`: new test "a start-up logs no console error or warning" (Electron, `pigment://`).

## Step 13: documentation

- ARCHITECTURE.md: Part 1 appended as "## 0.5 features (contracts)" (verbatim, plus the contract's preamble paragraph
  on reused names and paths after the section's first paragraph, and S14.2's column header "Change (step of the
  skeleton)" instead of "step of Part 2"), followed by "### The skeleton as landed: where it differs from the text
  above", which collects the deviations of all five hand-offs by section (S1–S3, S4, S5–S6, S7, S8/S12.4, S9/S13, S10,
  S11, S12.1–2, S14.2) for the package owners.
- `docs/0.5/README.md`: rule 7, the fifteen packages with their ports, entries and file names, the three parts of each
  file, rule 15's notices.
- `docs/0.5/skeleton.md` (as `docs/0.4/skeleton.md`): the skeleton's release notes (keys, menus, behaviour, the review
  decisions a user notices).

## Deviations from the contract (file, name, what differs, why)

1. `lib/preset-formats.js`: extra exports `importPresetBytes`, `exportPresetBytes` (the file-free halves, so Node tests
   can drive import and export), `opensAsPresets` (the one routing test of documents.js and app.js),
   `presetFileExtensions`; `presetFileFormatFor(nameOrExt, { kinds })` takes an optional preference;
   `exportPresetsDialog` also takes `path` (0.4's `exportPresets(app, ids, path)` / `exportPatterns` signature is kept)
   and `defaultName`; `registerPresetFileFormat` returns an unregister function.
2. `presetFileFormats()` returns one wrapped shape for both registries (`{ id, name, extensions, kinds, store, read,
   write, import, def }`); a kind's own `pigment-presets` variant (patterns) is listed once, as `'*'`; among `'*'`
   formats this registry's come before the store's `.pigment-presets`.
3. `OPEN_FILTERS` (io.js) is not changed: Place, Replace Contents and Load Files into Stack use it and must not list
   preset files. `documents.js openDialog` adds the "Presets" filter (computed when the dialog opens, since packages
   register formats from `install()`). Extensions an open format reads (png from patterns' Images format) are never
   routed to presets.
4. A `.pigment-presets` file goes to the kind its JSON names whatever `kinds` says; a `$presetRef` the file lacks, or a
   cycle, becomes `null` with a report line.
5. `installPresetFormats(app)` registers the two blob refs and nothing else (S10 names no other job).
6. `brush/abr.js`: blob PNGs are 8-bit greyscale written with stored deflate blocks (zlib's real deflate is async here;
   `brushFromAgPsd` is synchronous by contract); a computed tip keeps its hardness, a sampled tip gets hardness 1.
7. `preset-files/aco-ase.js`: the writers are named `writeAse({ groups, colors })` and `writeAco({ colors })`, each
   returning `{ bytes, report }` (S7.2 says only "the writers").
8. `preset-kinds.js`: `tool-presets` is re-registered by `registerPresetKinds05()` with 0.5's data (S10.5 makes
   presets-panels its owner; the skeleton needs the normalised `brush` for blob refs and import); `styles` and `shapes`
   keep 0.4's definitions. It now imports `keymap.js normalizeOverlay` and `keymap-store.js MENU_COLORS`.
9. `shapeProps.unit`: kept only when present, so 0.4 layers read and write as before; filled on the first
   `regenerateShape` while the preset exists (not at creation: `createShapeLayer` is presets-panels' file).
10. `tools.js`: `resetOptions('*')` emits `'tool:options'` `{ tool, key: '*' }` once per registered tool (listeners
    filter by tool id); `setOptions` re-renders only when the tool is active; the Type tool's bar keeps showing the
    active text layer's values (0.4's `syncFromLayer`), while the stored options change.
11. `image-ops.js`: extras `planFor` and `beginDrag`; `previewBox` is null while a transform runs; the history label is
    0.4's "Free transform" (the contract writes "Free Transform"; 0.4's specs pin the lower case).
12. `move-handles.js` is not imported by `tools/move.js` (move-tool-depth's file).
13. `tests/e2e/shapes-live.spec.mjs:91` (not in S14.2): it pinned a new custom shape's `shapeProps` with `toEqual`;
    presets-panels fills `unit` in `createShapeLayer`, so the line now drops `unit` before comparing and checks it is a
    path when present.
14. `tests/electron/keys-05.spec.mjs` has a second test (the Electron start-up check of step 12): Electron 7 → 8.

## Not done

Nothing of steps 10–13 is left.

## Test counts at the end

| Suite | Result |
|---|---|
| Unit | **947 / 947** pass (942 + preset-formats 5) |
| Browser (port 8850, one worker, 19.7 min, whole suite after every code change) | 656 listed: **653 passed, 3 skipped, 0 failed**. 656 = 649 + skeleton-05 "presets" 3 + "toolbox" 3 + "start-up" 1. The 3 skipped: record-goldens (2) and the gated repaint-speed case. No flake, no "Execution context was destroyed". Log: `scratchpad/logs/impl5-full-e2e.log`. |
| Electron | **8 / 8** pass (7 + the new start-up test in keys-05) |

Run after the last code change (docs only changed afterwards). No test server, browser or Electron process of mine is left
running.

## Tips for the integrator and the packages

- The skeleton is complete: every S-section is landed or stubbed; `app.stubbed` equals S13.3's stub ids plus 0.6's two.
- A package that adds a preset file format registers with `registerPresetFileFormat` (several kinds, blobs of another
  kind, no store kind) or 0.4's `registerPresetFormat(kind, …)` (one kind a 0.4 panel imports); opening, dropping, the
  Open dialog's filter and the panels' Export pick it up without edits.
- `importPresetBytes` / `exportPresetBytes` are the quick way to test a format in Node (see
  `tests/unit/preset-formats.test.mjs`'s `makeApp()`): `preset-kinds.js` is not Node-safe (it imports the tools).
- move-tool-depth: draw `previewBox(doc)` and call `app.transformTool.start({ mode: 'free', grab: { pointer, handle } })`
  from the Move tool's press; skeleton-05's grab test then drives the real handle (`showTransform` on).

## Fix pass

Two passes worked from the three reviews (engines, modules, wiring; 24 findings). The first (agent a961194ae4e53bf7d,
02:12–02:28 UTC) edited through Bash and was stopped by a usage limit; its commands are in
`scratchpad/plan05/build/fix-pass-1-actions.md`. The second pass (this one) checked each of its edits against the
code, kept the sound ones, corrected the rest, finished the findings it had not reached, and ran the suites. Below,
"P1" is the first pass's work and "P2" this pass's. Nothing is committed.

### Findings, one by one

1. **S2.8 large dabs drawn at the cache's size (blocker), fixed.** P1: `brush.js` exports `dabDiameter` and
   `dabDrawSide(size)` (= `ceil(size) + 2`, 0.4's side); `engine.js drawDab` (plain, rotated, aliased and sampler
   paths), `renderTip` (`atDrawSide`) and `panels/brushes.js drawTip` draw the cached canvas at that side, so a dab keeps
   0.4's extent and stays in the dirty rect and coverage box; ARCHITECTURE S2.8 says so. P1's skeleton-05 test "one hard
   dab at 1000 px and 2500 px keeps 0.4's extent" compares with 0.4's dab (±1 px reach, alpha sums within 0.2 %, the
   dirty rect holds the dab); P1 showed it fails without the fix. P2: checked every `dabCanvas` caller (no others);
   ran the test (passes).
2. **S2.5 `barrel` on a hovering side-button drag, fixed.** P1: `canvas-view.js norm`: `barrel: pen && ((buttons & 2)
   || button === 2)` (the `button === 2` part keeps it on the release, where buttons is 0); S2.5's text. P1's new check
   in skeleton-05 "claimed presses …" failed: it dispatched with pointerIds 2 and 3, and `setPointerCapture` throws for
   an id that is not active, so the press never reached `onContextMenu`. P2: the check uses pointerId 1 (as the eraser
   check does); passes; the mouse right-drag stays `barrel: false`. P2 also reflowed the S2.5 paragraph.
3. **S2.2 who drives `tick` (major), fixed in the text.** P1: ARCHITECTURE S2.2: while `preset.buildUp` is on the stroke
   schedules its own rAF ticks from `begin()` to `end()`/`cancel()` (brush-engine-core); `tools/paint.js` schedules
   none. P2: reworded its last sentence ("exactly one loop drives build-up"); the stub's `tick` stays a no-op (no
   build-up before brush-engine-core).
4. **S2.4 / S2.7 / S1.3 seed and constrainColor (major), fixed.** P1: `engine.js strokeContext` derives both when
   `paint` lacks them: a fresh seed per stroke (`nextStrokeSeed`), `traceDabs` its `seed` option (default 1), previews
   seed 1; `constrainColor` = `app.colorConstraint` (hex in, hex out) on the rgb, else identity; a geometry modifier's
   dab colour goes through it; S2.4 and S2.7 text. P2: limited that constraint to `mode: 'paint'` (a mask's white and an
   eraser's black are not image colours: in Indexed mode they would have snapped to the palette); added the rule to
   S1.3 (`baseSettings` adds no `seed` and no `constrainColor`).
5. **S2.6 previews without app (minor), fixed.** P1: `renderStrokePreview` keeps `paint.app` (or `paint.view.app`) and
   drops only the view; `panels/brushes.js drawStroke` passes the app; `StrokePaint.app` in S2.4. P2: checked the call
   site has `app` in scope.
6. **S4 / S15 `registerPsdFeatures` (minor), fixed in the text** (P1): "each mapper file calls
   `registerPsdFeatures(PSD_FEATURES)` at top level; exporting the object alone does not count", in the as-landed list
   and at `psdFeatures()`.
7. **S2.8 sampled-tip cache (minor), fixed** (P1): `sampleCache` keyed on `dabDiameter`, bounded at 64 MP like
   `dabCanvas`, drawn at `dabDrawSide`. P2: checked.
8. **S1.3 "Modified" against a clamped tool (minor), fixed.** P1: `setToolBrush` also writes the clamped tip values into
   the stored `brush`, and `tool-brush.js` exports `clampBrushToTool(app, toolId, preset)`; S1.3 defines "Modified" as
   `sectionDiff(toolBrush(app, id).preset, clampBrushToTool(app, id, stored))`. Both kept (the first makes
   `settings.tools[id].brush` agree with `toolBrush`; the second fixes the comparison with the `brushes` preset, which
   is what skeleton-05 "brush" compares). P2: unit assertions in `brush-preset.test.mjs` (a DabTool's stored brush holds
   1000; a fresh pick of a 2500 px preset has no section difference; the Brush keeps 2500).
9. **Stub stroke tip flips (minor), fixed** (P1): the no-geometry path paints `preset.tip.flipX/flipY`; goldens
   unchanged.
10. **S1.2 migration untested (minor), fixed** (P1): skeleton-05 "0.4's settings.brushPresets migrate once" (ids after
   the built-ins, data, `migrated`, `brushPresets` kept, no duplicates after a second start). P2: ran it (passes).
11. **S5 damaged files keep what was read (minor), fixed.** P1: every container reader stops at the damage and returns
   the kinds read before it with `damaged: true` (PNG: a truncated chunk or a chunk whose zlib stream fails; JPEG: a bad
   marker, a truncated segment, no SOS, a damaged 8BIM block; WebP; TIFF IFD0 entries outside the file; PSD resources);
   writers still throw; unit test in `io-chunks.test.mjs`; the as-landed S5 text. P2: checked the PNG rewrite against
   the original read loop (each `continue` became `return`, same branches); a JPEG profile split over APP2 segments is
   now given only whole when the file is damaged (a cut-short profile would have reached icc-engine as a broken one);
   S5 text updated.
12. **S11.3 `transformed` stage that returns `next()` (major), fixed.** P1: `type/api.js renderText` marks a transformed
   stage's result `transformed: true` unless it is `next()`'s own object handed on (it keeps `next()`'s space) or the
   stage returns `transformed: false`; TextLayer.render then resamples as 0.4. S11.3 and the as-landed text; skeleton-05
   "type: a render stage …" now checks a rotated layer gives the same pixels with a pass-through stage and with a
   `transformed: false` stage as with none. P2: checked nesting (an inner transformed result handed on keeps its flag);
   the test passes.
13. **S11.2 `typeDefaults` / `setTypeDefaults` and the real catalog (major), fixed (the reviewer's first option).** P1:
   `type/target.js` (listed as unchanged in 0.5; recorded as the one skeleton edit there) reads the style option through
   `fontCatalog().stylePatch` and writes it through `styleKey`; `postScriptName` and `axes` live in the option with a
   real catalog; a 0.4 key the catalog does not answer for is parsed as 0.4 did; skeleton-05's fake-catalog test checks
   the capture and the apply. P2: made the "does not answer" rule explicit in ARCHITECTURE (`stylePatch` returns null or
   no finite `fontWeight`); checked there is no import cycle.
14. **skeleton-05 TypeTool list and sibling (major), fixed** (P1): the list starts with the two 0.4 tools and ends with
   the dummy; `sibling` is the registered vertical mask tool when there is one, else null; the Shift+T loop runs the
   slot's length. P2: corrected the stale comment.
15. **skeleton-05 swatch row vs 76 built-ins (major), fixed** (P1): `after.colors` is `swatchColors(app).slice(0, 60)`.
16. **skeleton-05 setOptions on the slot id 'text' (minor), fixed** (P1): activates and sets `type-horizontal`, checks the
   active id; S12.1 notes that selecting another text layer re-syncs the options (0.4's `syncFromLayer`).
17. **S11.1 hover preview stages applied twice (minor), fixed** (P1): `api.js` exports `renderBase(layer)` (engine or
   extension, no stage); S11.1 tells the hover stage to render its clone through it.
18. **skeleton-05 fake catalog as a spread (minor), fixed.** P1: `Object.create(prev)` + `Object.assign`, and
   `prev.stylePatch.call(prev, …)`. P2: `Object.assign` onto an object whose prototype is frozen throws for inherited
   read-only members (the stub catalog `EMPTY_CATALOG` is frozen; a real one may be), so the overrides are now defined
   with `Object.create(prev, { … })`.
19. **S7.1 picker targets (minor), fixed** (P1): `app.pickColor(initial, { title, live, target = 'field' })` passes its
   target; gradient stops (`gradient-editor.js`, `tools/fill.js`) pass `'stop'`, the shape popover `'field'`; S7 text.
20. **S13.4 paint-only Shift+Alt keys from main (major), fixed** (P1): `keymap-store.js resolveKey` returns a paint
   command that has no global key only while a painting tool is active and it is enabled, else null; `app.js` runs
   nothing for null (no `commitBefore`, a Free Transform stays open); unit test in `keymap-05.test.mjs`; the as-landed
   S9/S13 text. P2: checked there is no other caller.
21. **S9.5 macOS application menu not customisable (minor), fixed** (P1): `customize` runs after the macOS app menu is
   added; the menu itself and its role items stay. P2: unit test in `menu-05.test.mjs` (hidden Settings… and Camera Raw
   Preferences…, Quit kept, Show All Menu Items, About coloured).
22. **S9.2 Toggle Full Screen after a rebind (minor), fixed** (P1): Windows and Linux show `keys.menu[cmd] ??
   keys.renderer[cmd][0]`; macOS keeps the fixed Ctrl+Cmd+F (a user key works through `shortcuts.js`); recorded. P2:
   the same unit test checks win32, linux and darwin.
23. **S13.3 `keysFor` without FIXED_KEYS (minor), fixed** (P1): recorded that `keysFor` excludes them; the stub shortcuts
   list adds `fixedKeyFor(cmd, { platform, isPackaged })`, so Toggle Developer Tools is listed in development builds.
24. **`panels/brushes.js` ownership row (minor), fixed in the text** (P1): the row and the as-landed S1–S3 list name the
   pick through `setToolBrush` with `presetId`, the spacing getter, `dabDrawSide` and the preview's `app`.

No finding was rejected: each was real as reported.

### Deviations added by the fix pass

- `brush.js`: new exports `dabDiameter`, `dabDrawSide` (P1). `tool-brush.js`: new export `clampBrushToTool` (P1).
  `type/api.js`: new export `renderBase` (P1). `StrokePaint.app` (P1). All recorded in ARCHITECTURE.
- `type/target.js` changed although 0.5 lists it as unchanged (P1, finding 13; recorded in the as-landed S11 list).
- `app.pickColor`'s options gain `target` (P1).

### Test counts at the end

Run after the last code change (only this hand-off changed afterwards):

| Suite | Result |
|---|---|
| Unit | **949 / 949** pass (947 + io-chunks "a file damaged after its chunks" (P1) + menu-05 "the macOS application menu …" (P2); the other new unit checks are assertions inside existing tests) |
| Browser (port 8850, one worker, 20.0 min, whole suite) | 658 listed: **655 passed, 3 skipped, 0 failed**. 658 = 656 + skeleton-05 "one hard dab at 1000 px and 2500 px" + "0.4's settings.brushPresets migrate once" (both P1). The 3 skipped are record-goldens (2) and the gated repaint-speed case. No flake, no "Execution context was destroyed". Log: `scratchpad/logs/fixpass2-full-e2e.log`. |
| Electron | **8 / 8** pass |

No test server, browser or Electron process of this pass is left running.

### Tips

- `fix-pass-1-actions.md` holds P1's exact commands; the current tree is P1 plus the P2 corrections listed above.
- A synthetic `PointerEvent` dispatched at the view canvas must use pointerId 1 (the page's active pointer):
  canvas-view calls `setPointerCapture`, which throws for any other id, and the press then never reaches the tool.
