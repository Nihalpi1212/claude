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
