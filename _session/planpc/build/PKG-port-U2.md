# PKG-port-U2: Actions: Default Actions and Insert Conditional (rows 37, 38, 40; row 39 dropped)

Built on `claude/pigment-photocraft` after `53805fb` (U4; PhotoCraft 057297b, craft-libs 18ffc07). Spec: PORTS-A §5.2,
§5.3, §5.4 and §9 U2; REBASE-FU "U2" (it wins). Fifth package of group FU (F3, F2, F1, U4 before it; U1 and U3 not
built yet).

**CI first.** At the start (06:50 UTC) the newest finished runs were 46117807233 (`0a8765f`, **cancelled**: superseded
by the next push, not red) and 46110072787 (`2ca195b`, F1, **green**); 46115758573 (`e8ec9d5`, U4's first) then
finished **green**. Nothing red, so no CI commit. The run on `53805fb` (46118018605) was still in progress when I
checked last, and the runs on this package's commits were not waited for: **the next engineer checks them first.**

**REBASE-FU's line numbers** checked against the tree (groups A and P had landed since it was written):
`library_commands.rs:25` (`BASICS_SET`) and `:137-143` (`basics`) matched; `library_commands/tests.rs:86` and `:238`
matched (plus `:83-85`, `:95`, `:237`, which name "Pigment Basics" too); `preset_store.rs:705-709` (`load_actions`) and
`preset_store/tests.rs:390-400` matched; `panels/actions/menu.rs:26/32/48` matched; `panels/actions.rs:403`
(`RecordAgain`) matched; `dialogs.rs:110` (`INSERT_STOP_FAMILY`) is now `:116` (A2's Save Adjustment Preset line came
before it); `actions.rs:132` (`action_form_choices`) is `panels/actions.rs:132`; `actions_edit_cmds.rs:253-287`
(`CONDITIONS`) matched; `cmd.rs` module list unchanged.

## Commits (pushed)

- `a123260` Pigment Default Actions (U2), engine and app: Photoshop's set on first launch and from Reset Actions
- (UI commit, see the end of this file)

## What was built

### Default Actions (rows 37, 38)

- `crates/engine/src/cmd/actions_default.rs` (new; `pub mod actions_default;` in `cmd.rs`, reached as
  `photocraft_engine::commands::actions_default`): `SET = "Default Actions"`, `default_actions(set) -> Vec<Action>`,
  `default_file(set) -> ActionsFile`, `seed_on_first_launch()`, `first_launch(backend)`, `seeded(backend, flag)`.
- The set, in Photoshop's order: Vignette (selection), Frame Channel – 50 pixel, Wood Frame – 50 pixel, Cast Shadow
  (type), Water Reflection (type), Custom RGB to Grayscale, Molten Lead, **Make Clip Path (selection)**, Sepia Toning
  (layer), Quadrant Colors, Gradient Map, **Mixer Brush Cloning Paint Setup**. Names as the JavaScript app had them
  (en dash in the two frames).
- Translation choices (the code won over the spec where they differ):
  - Quadrant Colors: Photoshop's/JS's percent rectangles become `select.all` + `select.transformSelection
    {"scaleX":50,"scaleY":50,"reference":<corner>}` (the engine's `select.rect` takes pixels only), so it works on any size.
  - Cast Shadow (type): `edit.transform` has no relative skew (only scale/rotate/move) and a matrix depends on the
    layer's place, so the shadow is `scaleY 50` about the bottom edge, not slanted. Rasterize is `layer.rasterize.layer`
    (JS's was an optional step; the engine has no optional steps). Water Reflection: `scaleY -100` about the bottom.
  - Sepia Toning (layer): `layer.duplicate` instead of JS's Layer Via Copy, so it works without a selection.
  - Molten Lead: `filter.gallery.chrome` directly; Levels and Hue/Saturation colourise as JS.
  - Wood Frame: Fibers carries its own colours (`foreground`/`background` params), so the swatches stay; a
    `tools.setColors` step was tried and does not save to `.atn` either, so it was not kept.
  - Make Clip Path (selection): `select.toWorkPath {"tolerance":2}`, `path.rename work → "Path 1"`,
    `path.clippingPath.set`.
  - Mixer Brush Cloning Paint Setup: a new layer "Mixer Brush Painting", `brush.mixer.sampleAllLayers on`,
    `autoLoad off`, `autoClean on`. **Tool selection is not an action step in Pigment** (the spec thought it was:
    `tools.select.*` are shell commands, refused by `actions.insert`'s `is_step_command`), so the user picks the Mixer
    Brush.
  - **Save As Photoshop PDF: left out.** A played Save As writes its recorded path; the player opens dialogs only for
    filter/adjustment steps (`runner.rs` `run_step`), so the step would write a fixed file.
- **Rename** (owner's choice): `BASICS_SET = crate::commands::actions_default::SET` ("Default Actions"); `basics(set)`
  returns `default_file(set)`. `scripts/pigment-rebrand.py --check` needed no change (the line holds no product name).
  FORK.md's two rename rows say so and how to undo it.
- **First launch**: `apps/photocraft/src/main.rs` calls `seed_on_first_launch()` before `open_dir_async`.
  `preset_store::load_actions`'s missing-file arm returns `first_launch(backend)`: the set only when the flag is set and
  the store has neither `actions.json` nor `index.json`; it then **writes `actions.json` at once** (otherwise a later
  brush save would write `index.json` and the unmodified set would vanish on the next launch). An existing
  `actions.json` (Clear All leaves an empty one) is never seeded; deleting the set is kept. The flag is a process
  `AtomicBool` that only the desktop app sets, so upstream's preset_store test opens an empty list unchanged. The web
  app (`apps/photocraft-web`) and the CLI do not seed.
- Action and set names stay English: the framework's Actions panel draws them itself; `ActionsHost` has no name hook
  (only `step_label`). Not translatable without craft-libs.
- **`.atn`**: Save Actions… of the set needs Skip Unsupported: layer-style steps (`layer.layerStyle.*`),
  `select.saveSelection`, Fibers with its own colours, `select.toWorkPath`, `path.rename`, `path.clippingPath.set` and
  the `brush.mixer.*` toggles have no event in `atn_cmds/events.rs`. Eight actions save whole; Frame Channel, Wood
  Frame, Make Clip Path and Mixer Brush lose those steps. Mapping them is an `.atn` package of its own.

### Insert Conditional (row 40)

- `crates/ui-egui/src/panels/actions/conditional.rs` (new): `ActionsExtraCommand::InsertConditional`
  (`#[derive(CommandSet)]`, prefix **`pigmentActionsPanel`**, not REBASE-FU's `actionsPanel.pigment`: the derive
  refuses a prefix with a dot), label "Insert Conditional…". `splice` puts it right after Insert Stop…, `add_state`
  gives it Insert Stop…'s state, `run_fired` opens the dialog.
- Dialog "Conditional Action" (`ParamDialog`, key `actionsPanel.insertConditional`, `FAMILY` in `PARAM_FAMILIES`):
  If Current (searchable choice of the 33 `CONDITIONS` in Photoshop's/JS's words, `condition_label`), Then Play Action
  and Else Play Action (None + `action_form_choices` names; a branch naming a missing action keeps its name).
  New steps default to Document Is Open / None / None.
- Insert: `actions.insert {"action","at","id":"actions.conditional","params":{"if","then","else"}}` after the selected
  step or last in the selected action (pending recorded steps count), selects it and expands the action. None is
  `null`.
- Edit: `apply_event`'s `RecordAgain` arm, guarded by `conditional::is_conditional`, opens the dialog on the step's
  values; OK checks the list revision, then `actions.delete` + `actions.insert` at the same index (list edits only).
  The edited step's own disabled/dialog flags are reset (the others are kept); Record Again itself would replay the
  condition and its branch on the document.
- The host's step label stays upstream's ("Conditional: cond → then / else", `host.rs`), not changed.

### Row 39 (Clear All, Reset, Replace)

Dropped: upstream built it (REBASE-FU). Reset now restores Default Actions.

## Tests

New:
- `crates/engine/src/cmd/actions_default/tests.rs` (9): Photoshop's order and the set field; every step id is a
  registered command with object params; **every action plays** (`actions.play`, no `failed`, `ran` = step count,
  one history entry) on a 400×300 RGB document with an orange Background, plus a type layer for "(type)" and a 200×150
  selection for "(selection)"; what they do (Vignette: two layers incl. "Vignette Background", selection gone; Frame
  Channel: the "Frame" channel and layer; Wood Frame: 500×400; Make Clip Path: clipping path "Path 1"; layer counts for
  Gradient Map, Sepia Toning, Cast Shadow, Water Reflection, Mixer Brush; the Mixer Brush options); Reset replace gives
  the set and its names, append keeps "Mine" and numbers "Default Actions 2"; `.atn` save with Skip Unsupported skips
  only the listed ids and loads back with every other step; seeding only with the flag, written at once and reopened by
  `open` and `attach_preset_store`; an existing empty `actions.json` or an `index.json` is never seeded; Clear All then
  sync stays empty.
- `crates/ui-egui/src/panels/actions/conditional_tests.rs` (5): the row follows Insert Stop… once, its state equals
  Insert Stop…'s (off with nothing selected, on with an action, while recording), firing it without a selection opens
  nothing, and `ui.menu.invoke` with its id opens the dialog; inserting after a step and last, with `ui.dialog.set`;
  Record Again on a conditional opens on its values and OK replaces it in place (other steps' flags kept, no document
  history); Record Again on another step does not take this path; every condition has words.
- Upstream tests changed: `library_commands/tests.rs` (two tests, name the set and actions through `BASICS_SET` /
  `default_actions`), `menu_tests.rs` `rows()` (skips non-framework rows).

Results (nextest `--profile ci`, `TMPDIR=/dev/shm/pt`, CI's font and i18n dirs):
- `-p photocraft-engine --features photocraft-io/heif --lib -E 'test(/actions_default|library_commands|preset_store|actions/)'`:
  177 passed.
- `-p photocraft-ui-egui --features photocraft-io/heif --lib -E 'test(/panels::actions|dialogs|menus/)'`: 902 passed;
  `-E 'test(/conditional|library_tests|menu_tests|shortcuts|crop_ui|transform_undo/)'`: 125 passed.
- Whole ui-egui suite and whole engine suite: see the end of this file.
- `cargo fmt --all -- --check`; `cargo clippy --locked --features heif -p photocraft-engine -p photocraft-ui-egui
  -p photocraft --all-targets -- -D warnings`; `python3 scripts/pigment-rebrand.py --check`; `cargo xtask layers`,
  `panel-commands`, `test-binaries`, `scorecard --check`: all clean. No engine command was added (no panic hunt needed;
  `actions.reset` only restores a different file).

## Hooks into upstream files (all in FORK.md, "Default Actions and Insert Conditional", and its two rename rows)

- `crates/engine/src/cmd.rs`: `pub mod actions_default;` (between `actions_cmds` and `actions_edit_cmds`).
- `crates/engine/src/cmd/actions_edit_cmds/library_commands.rs`: `BASICS_SET`, `basics`, the `use` line, one comment.
- `crates/engine/src/cmd/actions_edit_cmds/library_commands/tests.rs`: two tests' assertions and a `use`.
- `crates/engine/src/cmd/actions_edit_cmds.rs`: `actions.reset`'s params text.
- `crates/engine/src/preset_store.rs`: `load_actions`' missing-file arm.
- `apps/photocraft/src/main.rs`: `seed_on_first_launch()`.
- `crates/ui-egui/src/panels/actions.rs`: `pub(crate) mod conditional;`, `mod conditional_tests;`, the `RecordAgain` arm.
- `crates/ui-egui/src/panels/actions/menu.rs`: one line each in `panel_rows`, `states`, `run_fired`.
- `crates/ui-egui/src/panels/actions/menu_tests.rs`: `rows()`.
- `crates/ui-egui/src/dialogs.rs`: `PARAM_FAMILIES`.
- Docs: `docs/parity/README.md` (the four U2 rows), FORK.md.

## Spec rows

- 37 Default and bundled action sets: **done** for Default Actions (12 of Photoshop's 13); Adobe's other sets dropped
  (spec). Not done: Save As Photoshop PDF (reason above).
- 38 Default Actions set (panels): **done** (first launch in the desktop app, Reset Actions).
- 39 Clear All / Reset / Replace: **dropped**, upstream built it.
- 40 Insert Conditional dialog: **done** (row, dialog, edit through Record Again).

## For the next package

- **CI**: check the runs on `53805fb` and this package's commits first.
- **U1** adds an Info Panel Options family to `dialogs.rs` `PARAM_FAMILIES`: mine is the line after
  `INSERT_STOP_FAMILY`; put yours elsewhere or beside it.
- A Pigment `CommandSet` prefix must be one lower-camel segment (`pigmentActionsPanel`), not dotted.
- `.atn` gaps found here (no events for layer-style setters, Save Selection, Make Work Path from a selection, path
  rename, Clipping Path, Mixer Brush options, Fibers with explicit colours, `tools.setColors` with hex): worth a
  package of their own if users save Default Actions to `.atn`.
- The edited conditional's own include/dialog flags are reset by delete+insert; a `actions.setStepParams` engine
  command would keep them (not built: list edits through existing commands only, as REBASE-FU asked).
- Disk: ~9 GB free during this package.
