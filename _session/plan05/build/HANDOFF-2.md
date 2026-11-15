# Hand-off 2: Pigment 0.5 skeleton, Part 2 step 4 (the brush) — done; the 14 overwritten files were restored afterwards (see RESTORED)

## RESTORED (by the orchestrator, after implementer 2 finished): the tree is whole again

The 14 files below were rebuilt and copied back before implementer 3 started; nothing in the "(Resolved …)" section below needs doing.

- Method: implementer 1's recorded file edits (transcript of agent af483a1292a4ea5d0: Edit #105, #110 and the python /
  sed commands #106, #108, #109, #113, #114, #115, #118, #120, #121, #125, #126, #131, #133, in order) were replayed on
  a clean extract of 99dbdee (`git archive 99dbdee pigment | tar x -C <scratch>`); every replacement asserted its anchor,
  and the draft they read (scratchpad/drafts/keymap-add.js) is byte-identical to the one implementer 1 wrote. Then
  `step4-patches/apply-step4.py` on that copy, and the 14 files copied over the working tree.
- Checks: the replayed tools.js equals `restore-tools-impl1.py` on 0.4.0; on the replayed copy apply-step4.py patched
  every step-4 file, and each of brush.js, paint.js, retouch.js, adjustment-brush.js, vector.js, brushes.js,
  preset-kinds.js, canvas-view.js, tools.js and extras.js came out byte-identical to the working tree's; app.js carries
  the same step-4 hunks as before. apply-step4.py on the restored tree reports "already patched" for all 11 files.
- Implementer 1's final state (these 14 files plus its untracked files) is the state its last full run passed (895 unit,
  617 browser passed / 2 skipped, 7 Electron).
- Restored files: src/main/main.js, src/renderer/app.js, src/renderer/index.html, src/renderer/lib/actions.js,
  command-search.js, shortcuts.js, stubs-later.js, toolbar.js, tools.js, type/edit-keys.js, type/editor.js,
  src/shared/defaults.js, keymap.js, menu-template.js.

Test counts after the restore (steps 0-4, whole suites):
- Unit: **913 / 913** pass.
- Electron: **7 / 7** pass.
- Browser (port 8850, 25.2 min): 629 listed, **625 passed, 3 skipped, 1 failed**. The failure is the known flake
  (task #26), not the restore: `editing.spec.mjs:179` failed inside `openFixture`'s `runAwait('file:open-paths')` with
  "Execution context was destroyed … [original: Protocol error (Runtime.callFunctionOn): Promise was collected]" before
  the test body ran; the spec file passes on a re-run. So all 626 expected tests pass. (The flake is being root-caused
  separately; nothing for the skeleton to do about it. If it shows up in your runs, quote the "[original: …]" text.)

Implementer 2 of 5. Nothing is committed; no git command that changes anything was run.

## (Resolved, see RESTORED above) I overwrote implementer 1's changes to 14 tracked files (my mistake)

While making a scratch copy of 0.4.0 to compare against, I ran
`cd <scratch> && (cd /home/user/claude && git archive HEAD pigment/src | tar x)`. The subshell's `cd` made `tar x`
extract **into /home/user/claude**, so every tracked file under `pigment/src/` was overwritten with its 99dbdee
(0.4.0) content. Untracked files were not touched, and nothing under `pigment/tests/` was touched (`tar` got only
`pigment/src`).

**Lost (implementer 1's steps 1–3 edits; these files were back at 0.4.0 exactly):**
`src/main/main.js`, `src/renderer/app.js`, `src/renderer/index.html`, `src/renderer/lib/actions.js`,
`src/renderer/lib/command-search.js`, `src/renderer/lib/shortcuts.js`, `src/renderer/lib/stubs-later.js`,
`src/renderer/lib/toolbar.js`, `src/renderer/lib/tools.js`, `src/renderer/lib/type/edit-keys.js`,
`src/renderer/lib/type/editor.js`, `src/shared/defaults.js`, `src/shared/keymap.js`, `src/shared/menu-template.js`.

**Intact:** all of implementer 1's new (untracked) files (keymap-store.js, shortcuts-editor.js, the stubs, the
stylesheets, the goldens, skeleton-05.spec.mjs, keys-05.spec.mjs, keymap-05/menu-05 tests, …) and its edit of
`tests/e2e/conventions-shortcuts-fields.spec.mjs`. No snapshot branch for 0.5 existed (`snapshot.sh` had not been run),
and I was not permitted to read implementer 1's transcript to replay its edits, so I could not restore 12 of the 14
files. I did not try to rewrite them from the hand-off text: a guessed version would differ from what HANDOFF-1
describes and would break an exact replay.

**State now:**
- `src/renderer/lib/tools.js`: implementer 1's changes restored exactly (I had read the whole file before the
  overwrite; `step4-patches/restore-tools-impl1.py` re-does them on the 0.4.0 file), plus my step-4 edits.
- `src/renderer/app.js`: 0.4.0 **plus my step-4 edits only** (implementer 1's app.js changes are still missing).
- The other 12 files above: 0.4.0, unchanged by me.

**How to restore (integrator):**
1. In a scratch checkout of 99dbdee (`git archive HEAD pigment | tar x -C <empty dir>` — run tar from inside the
   empty dir!), replay implementer 1's recorded file edits (its transcript: agent `af483a1292a4ea5d0`, workflow
   `wf_1efcb24a-34c`: Write / Edit calls and the python / sed commands, in order) for the 14 files, or re-run steps
   1–3's tracked-file work. Check the result against HANDOFF-1.
2. Copy those 14 files over the working tree (app.js and tools.js included: their current content does not matter).
3. Run `python3 /tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad/plan05/build/step4-patches/apply-step4.py`.
   It re-applies every step-4 edit of an existing file; each file is guarded by a marker ("already patched"), and
   every anchor is text that both 0.4.0 and implementer 1's versions contain (I applied the same edits to implementer
   1's app.js and tools.js before the overwrite, and they applied). Only app.js and tools.js will be patched.
4. Run unit, the whole browser suite and Electron (step 4 is a full-suite step). Expect keymap-05, menu-05,
   keys-05 and skeleton-05 "stubs"/"keys" to pass again once the 14 files are back.

Backups of every step-4 file (new and patched) are in `step4-patches/files/` (same relative paths).

## Step 4 done (S1–S3)

New files:
- `lib/brush/preset.js` (S1.1): `DEFAULT_BRUSH`, `BRUSH_SECTIONS`, `CONTROL_TYPES`, `TEXTURE_MODES`, `DUAL_MODES`,
  `RANGES` (every numeric path), `normalizeBrush`, `brushFromLegacy`, `legacyTip`, `splitStrokeSettings`,
  `brushEquals`, `sectionDiff`, `withSections`, `clearControls`, `blobsOf`, and `withoutSampleData` (extra, see
  deviations). Pure.
- `lib/brush/engine.js` (S2, stub engine): 0.4's `BrushStroke` moved verbatim (`migrate` now a method) plus the hooks:
  `ENGINE` (`classic-0.4`, features all false), `normalizeSample`, `traceDabs`, `registerDabModifier`,
  `dabModifiers`, the `sample` / `geometry` / `coverage` (scratch canvas read back and written back) / `buffer` (copy
  of the flushed rect) stages, each only when a modifier of that stage is enabled; `begin` again = sub-path,
  `finish`, `tick` (no-op), `preset`, `paint`, `s`, `leash` (null); `registerTipKind`, `tipOutline` (ellipse),
  `renderTip`, `strokeReach` (tip size + enabled modifiers' reach), `renderStrokePreview`; decoded sampled tips paint
  (one toast per stroke and a round tip while not decoded). The placement code is shared by the stroke and
  `traceDabs`. Node-safe at import.
- `lib/brush/options.js`: `BRUSH_SIZE` (1..5000), `PENCIL_SIZE`, `BRUSH_OPTIONS`, `PAINT_BLEND_OPTIONS`.
- `lib/brush/tool-brush.js` (S1.2, S1.3): `supportsBrush`, `toolBrush`, `setToolBrush` (locks, Protect Texture,
  includeTool, presetId, clamping to the tool's own option, one `saveSettingsSoon`, `updateControl` per written key,
  `'tool:options'` with key `'brush'`), `prepareBrush`, `sampleCanvas`, `brushReady`, `withSampleData`,
  `installToolBrush` (migration of `settings.brushPresets` into `brushes` once, `tool:brush-preset`, decode on
  `'tool:changed'`).
- `lib/tools/paint-gesture.js` (stub `PaintGesture`, `real = false`), `lib/brush-cursor.js` (0.4's cursor moved;
  `'dot'` reads as `'standard'`).

Edited (all marked): `lib/brush.js` (facade: `export * from './brush/engine.js'`; `dabCanvas` bounded by 64 MP,
sizes over 128 px quantised to 1 % steps); `lib/tools/paint.js` (gesture split, `claimsPress`, `onContextMenu`,
`strokeDown/Move/Up`, `baseSettings` from `toolBrush`, `ensureCoverage` by `strokeReach`, `finish` on up, cursor
delegated, the `migrate` patch removed, Pencil size and modes from options.js); `lib/tools/retouch.js` and
`adjustment-brush.js` (renames); `lib/tools/vector.js strokePathPixels` (spacing `min(0.12, toolBrush spacing)`,
growth by `strokeReach`); `lib/panels/brushes.js` (`installTipHook` gone, preview through `renderStrokePreview`,
per-tool flat spacing, picks through `setToolBrush` with the preset id); `lib/preset-kinds.js`
(`registerPresetKinds05()` with `brushes`); `lib/canvas-view.js` (full PointerSample, button 5 as primary, press
claims with `app.tempTools.clear()`, right-button drags, cursor filter in `setCursor`); `lib/tools.js`
(re-exports from options.js, `setCursorFilter`, the brush button through `app.brushPicker.renderButton` when
present); `lib/extras.js` (the four cursor styles); `app.js` (`registerPresetKinds05()`, `installToolBrush(app)`
after `app.presets`, the size cap 5000).

Tests: `tests/unit/brush-preset.test.mjs` (9), `tests/unit/brush-golden.test.mjs` (9: traceDabs equals dabs.json for
all 15 cases in the legacy and the preset form, sample stage, geometry, buffer halving, reach, normalizeSample,
tipOutline, ENGINE gated on its id), `tests/e2e/brush-golden.spec.mjs` (5: the 15 cases in legacy, preset and tools
forms — all **equal** to the PNGs under the classic engine; the tools' strokeSettings against cases.json for every
recorded key; a buffer modifier halving the composited alpha), skeleton-05 "brush" (4 tests: Alt then right-drag
claimed past the Eyedropper; Ctrl then Ctrl+Alt-drag claimed past the Move tool, the layer stays; pen button 5 /
buttons 32 reaches down with `eraser: true`; reach 300 grows a lazy layer around moved dabs; a modifier shows in
`renderStrokePreview`; a Brushes panel pick updates the options bar Size and the button, `[` keeps
`brushPresetId` and makes `sectionDiff` = `['tip']`; `tool:brush-preset` records `{ id, preset }` and replays without
the preset; a data-URL-only sampled tip paints after `prepareBrush` and its blob lands in `brushes`; stub
assertions gated on `PaintGesture.real`). `SKELETON_LATER` is now empty. `repaint-speed.spec.mjs` gained the S2.8
case, skipped while `ENGINE.id === 'classic-0.4'` (so never run yet).

## Deviations

1. `lib/brush/preset.js` exports `withoutSampleData(preset)` (not in S1.1): the `brushes` kind, settings and the
   migration store presets without data URLs; one implementation.
2. `brushFromLegacy` of a 0.4 *preset* (has `id`/`name`, no `mode`/`color`/`opacity`) always gives `tool.flow`
   (`flow ?? 1`), because 0.4's Brushes panel set flow 1 on every pick of a preset without one.
3. Migration keeps 0.4 ids by pushing into the preset store's order (`app.presets.state('brushes').order`,
   `changedState`): `presets.js` is frozen for 0.5 and `add()` makes new ids. It runs only when
   `settings.brushPresets` has entries.
4. `setToolBrush` writes the flat tip keys a tool has an option for (and angle / roundness / spacing for `'full'`
   tools), clamped to the tool's own option (DabTools 1000 px), and `preset.tool` values only for options the tool has
   — as 0.4's Brushes panel did. It writes `brushPresetId` only when a presetId is given (an edit never clears it).
5. Protect Texture keeps the current pattern and scale; the protect flag itself comes from the incoming preset.
6. `[`/`]` clamp to the tool's own size max as well as 5000 (DabTools stop at 1000; 0.4 let them reach 2500).
7. ensureCoverage reads the reach once per stroke from `toolBrush` (not from the stroke's preset), so Eraser Block
   and the Pencil keep 0.4's growth margin (`opt('size')`) exactly.
8. `traceDabs(..., { modifiers })` takes per-trace modifiers like the stroke does; the `finish` sample is the last
   sample extended again without smoothing (as 0.4's move-then-release did; that is what dabs.json recorded).
9. "A buffer modifier halving A halves the composited alpha" is checked in `brush-golden.spec.mjs` (Node has no
   canvas); the unit test checks the pure `runBufferModifiers` (exported from the engine for it).
10. `coverage`'s mask is dab box ∩ target canvas (not yet ∩ selection bounds); the selection still clips at
    composite time. brush-engine-core's engine may tighten it.
11. Pencil size max 500 → 5000 (`PENCIL_SIZE`), part of the 5000 px cap.
12. Cursor preference labels: Standard, Precise, Normal Brush Tip (`outline`), Full Size Brush Tip (`full`).

## Test counts (on the tree as it is now: 0.4.0's 13 lost files + step 4)

- Unit: 898 tests, 896 pass, 2 fail (keymap-05, menu-05: they import keymap.js / menu-template.js exports that are
  lost). With the restore: 878 + 17 (implementer 1) + 18 (mine) = 913 expected.
- Browser, whole suite (port 8850, 19.0 min, one worker): 629 listed, **621 passed, 5 failed, 3 skipped**. The 3
  skipped: record-goldens (2) and the new gated repaint-speed case (1). The 5 failures are exactly the tests of steps
  2–3 that need the lost files: `conventions-shortcuts-fields.spec.mjs:184` (no `edit:color-settings` in 0.4's
  stubs-later.js), skeleton-05 "stubs" (no 0.5 MODULES entries in 0.4's app.js) and its three "keys" tests (no
  `app.keymap`). Every 0.4 spec, `brush-golden.spec.mjs` (5) and skeleton-05 "brush" (4) passed. No "Execution
  context was destroyed" failure and no flake. Log: `scratchpad/logs/impl2-full-e2e.log`.
- Electron: 7 listed, **6 passed, 1 failed** (`keys-05.spec.mjs`, step 3, lost files).
- Expected after the restore: unit 913, browser 629 listed (626 passed + 3 skipped), Electron 7 — not yet verified.
- No test server, browser or Electron process is left running.

## Tips for the next implementer

- (Done: the restore and apply-step4.py ran; see RESTORED.)
- The goldens hold exactly under the stub engine in all three forms; `brush-golden.spec.mjs` is the quick check after
  any edit near the brush (8 s).
- Never `tar x` from a subshell that changed directory: extract with `tar x -C <dir>`.
