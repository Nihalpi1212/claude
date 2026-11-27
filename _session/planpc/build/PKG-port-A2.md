# PKG-port-A2: adjustment presets interface and the Adjustments panel presets (rows 1, 10)

Built on `claude/pigment-photocraft` (PhotoCraft 057297b). Spec: PORTS-A §2.1 "Build (A2: UI)", §2.12,
§9 A2; REBASE-A "A2" (it wins). Read with PKG-port-A1.md.

## Commits (all pushed)

- `c5690a2` Pigment adjustment presets (A1), model and commands: adjustment.presets.* (A1's
  uncommitted work, verified and committed first)
- `1707b3b` Pigment adjustment presets (A2): the Preset row in the dialogs and Properties, the panel
  presets' commands
- `a90c780` Pigment adjustment presets (A2): the Adjustments panel's presets, their hover preview,
  Save Adjustment Preset

## First: A1's engine half was not committed

A1's notes describe the model and the commands, but when A2 started only A1's io half (`852f6aa`) was
committed; `presets/adjustments.rs`, `cmd/adjust_preset_cmds.rs` (+ tests) and the hooks in
`presets.rs`, `cmd.rs`, `automation/src/workspace.rs`, `FORK.md` sat uncommitted in the tree. A2
verified them (engine `adjust_preset` tests 11/11, automation `workspace` 56/56, panic hunt, clippy,
fmt, rebrand, `xtask scorecard --check`, `panel-commands`) and committed them as `c5690a2` before
starting. CI: the newest finished run before A2 (`45955287515`, on `852f6aa`) was green.

## What was built

1. **The Preset row** above every adjustment editor, in the Image › Adjustments dialogs and in an
   adjustment layer's Properties: `crates/ui-egui/src/dialogs/adjust_editors/preset_row.rs`.
   - The framework's `NamedPresetRow` around a `PresetPicker` (list view, no search, no browser row
     menu): **Default** (the kind's defaults, marked built-in so it can't be renamed or deleted), then
     each group (`Built-in`, `My Presets`, other user groups) with its presets; built-in names go
     through `tl!`. The held key is the preset the value matches; none → the framework's "Custom"
     placeholder.
   - **Custom rule** (JS `sameSettings`): a value shows a preset when every key the preset names
     has the preset's value. Both sides are read through the engine (`values::from_params` then
     `values::to_params`), so `15`/`15.0` and a two-point curve compare equal. Default is checked
     first (`default_for` of the kind and mode).
   - New… → `adjustment.presets.save` (numbers tidied to 4 decimals: the editors hold `f32`, so
     `1.2` would be saved as `1.2000000476837158`); Rename…/Delete → `adjustment.presets.edit`;
     **Reset Presets** (a button after the row) → `adjustment.presets.reset`.
   - **Load…/Save…** for the six kinds with a Photoshop file (`.acv .alv .ahu .cha .asv .blw`, filter
     titled "Curves presets" etc.): Load → `pick_file_bytes_filtered` → `adjustment.presets.load`
     with `data` + `fileName`, then the loaded preset is **shown** (JS picked it after Load); Save →
     the bytes are made in the row (`photocraft_io::adjust_presets::write` of the current settings,
     named after the shown preset, else the kind) and written by `pick_save` + `app.services.write`,
     as `swatches_ui::answer_file` does (works on the web too).
   - A pick is the preset's params over the kind's defaults (`values::from_params`, base none), with
     Levels/Curves `red/green/blue` remapped to the document's channels (`panel::for_mode`, below).
   - Dialog: drawn in `adjust_dialog::shared_editor` before the editor; a pick writes the dialog's
     value in the closure (the host counts it as an edit and previews it); the other asks go out as
     `AdjustAsk::Preset(PresetAsk)`, answered in `answer_asks` by `preset_row::answer_dialog`. The
     list lives in `EditorSetup.presets` (+ `presets_rev`); `preset_row::follow_dialog` (first line of
     `answer_asks`) re-reads it when `session.presets.rev` moved, so a save, a load or an agent's edit
     shows at once.
   - Properties: `preset_row::in_properties` in `session::layer_editor` before the editor; a pick is
     committed through `session::commit` with no coalesce key: **one `layer.setAdjustment`, one
     history step**. A loaded file is applied to the layer with one `layer.setAdjustment`.
2. **The Adjustments panel presets** (row 10).
   - Engine model `crates/engine/src/presets/adjustments/panel.rs`: `PANEL_PRESETS` (groups Portraits,
     Landscape, Photo Repair, Creative, Black & White, Cinematic; the JS ids), `PanelPreset`,
     `PresetLayer {kind, params, name}`, `find`, `yours`, `builtin_layers`, `saved_layers`,
     `saved_params`, `for_mode`, `PANEL_KIND = "__panel"` (the pseudo-kind of `presets.adjustments`
     that holds "Your Presets"; its params are `{"layers":[{"kind","params","name"?}…]}`, bottom
     first), `YOUR_PRESETS = "yours"`.
   - Commands `crates/engine/src/cmd/adjust_preset_cmds/panel.rs` (registered by A1's `specs()`):
     `layer.adjustmentPreset {"group","preset"}` (journaled, `has_doc`, history label "Adjustment
     Preset: {name}"): the layers above the active one, each masked by the selection (kept for every
     layer; the last drops it, as `mask_new_layer` does) or a reveal-all mask, in a group named after
     the preset when there are several, numbered names ("Curves 1"), the top one active; refuses past
     `MAX_GROUP_DEPTH`. `layer.saveAdjustmentPreset {"name","layers"?}` (not journaled): the selected
     (or named) adjustment layers in document order, kind + `to_params` + the layer's name; a
     selection keeps only the adjustment layers, named ids must all be. `layer.deleteAdjustmentPreset
     {"name"}`. `pub fn preview(doc, active, presets, group, preset) -> Option<Document>` builds the
     same layers on a copy (the hover preview).
   - Interface `crates/ui-egui/src/panels/adjustment_presets.rs`: under the grid, a section "Adjustment
     Presets" with one collapsible `Section` per group (closed at first, as the JS `<details>`) and one
     full-width `Button` per preset (tooltip "Adds Curves, Hue/Saturation"), each running
     `layer.adjustmentPreset` through `app.run`; "Your Presets" (open) when there are any, with a
     context menu Delete → `layer.deleteAdjustmentPreset`.
   - **Hover preview**: `app.adjust_panel_hover` (`Hover {doc, revision, group, preset, frame,
     shown}`) set while a button is hovered, cleared otherwise; `display_doc` (called from
     `canvas::display_doc_live` after the blend-mode preview) shows `panel::preview`'s document under
     a key in `[1<<39, 1<<40)`, memoised per key, dropped when the panel was not drawn last frame or
     the document's revision moved. It previews **every** layer of the preset, exactly as the command
     would add it (masks included).
   - **Properties panel menu** (it had no rows): `PropertiesCommand::SaveAdjustmentPreset` ("Save
     Adjustment Preset…", a framework `CommandSet`, prefix `propertiesPanel`), enabled when the
     selection holds an editable adjustment layer; it opens a framework param dialog
     (`open_param_unsaved`, key `pigment.saveAdjustmentPreset`, name field suggesting the first free
     "Adjustment Preset N"); its `SAVE_FAMILY` runs `layer.saveAdjustmentPreset`.

## Choices recorded (where the spec/REBASE and the code or the JS app differ)

- **Built-ins are not marked `built_in` in the row** (REBASE said to mark them). The framework's
  `built_in` disables Rename and Delete; A1's model, the JS app and Photoshop let the user delete and
  rename built-ins (they come back with Reset). Only Default is marked.
- **"Reset Presets", no ellipsis, no confirm** (REBASE: "Reset to Default…"). Properties already has
  upstream's "Reset to defaults" (the settings), and A1's reset only restores built-ins and keeps the
  user's presets, so it needs no question. JS's label was "Reset Presets…" with a confirm because its
  reset dropped user presets.
- **A taken name is refused** by the row (`check_name` → the framework's "A preset with this name
  already exists."), not replaced after a "Replace?" question; the engine's `save` still replaces for
  agents. Renaming to a taken name is refused too (A1's `rename`).
- **Delete deletes at once** (the framework's row has no confirm; Photoshop asks none either).
- **Hover preview built in the engine** (`panel::preview`) instead of REBASE's
  `adjust_preview::hover_document`: the preview is then the command's result, masks and grouping
  included, and no upstream file of the preview machinery changed.
- **Seven JS panel presets left for A6** (they use Color and Vibrance, Clarity and Dehaze, Grain):
  Bright and Warm, Soft Skin (Portraits), Vivid, Clear Distance (Landscape), Remove Warm Cast (Photo
  Repair), Vintage Fade (Creative), Film Grain (Cinematic). Their JS order inside the groups is in
  `adjust/color-formats.js` `ADJUSTMENT_PANEL_PRESETS`.
- **Lab remap**: `for_mode` maps red/green/blue by position as JS `remapTonalSpace` did: CMYK
  cyan/magenta/yellow, Lab a/b (blue dropped), modes without colour channels keep the composite only.
  It is applied in the row (`preset_value`) and in `layer.adjustmentPreset`.
- **`.pcpresets` not in the file filter** (spec): that exchange format gets adjustments in P1b (D4).

## Hooks into upstream files (all in FORK.md, "What Pigment added › Adjustment presets")

| File | Hook |
|---|---|
| `crates/ui-egui/src/dialogs/adjust_editors.rs` | `pub mod preset_row;`; `AdjustAsk::Preset`; `EditorSetup.presets`, `presets_rev` and their `Default` |
| `crates/ui-egui/src/dialogs/adjust_dialog.rs` | `build_setup` two fields; `shared_editor` two lines (`in_dialog`, `.or(preset)`); `answer_asks` `follow_dialog` + the `Preset` arm |
| `crates/ui-egui/src/dialogs/adjust_editors/session.rs` | `layer_editor`: `in_properties` + `commit` before the editor (4 lines) |
| `crates/ui-egui/src/panels.rs` | `pub(crate) mod adjustment_presets;` |
| `crates/ui-egui/src/lib.rs`, `app.rs` | field `adjust_panel_hover` and its `None` |
| `crates/ui-egui/src/canvas/display.rs` | one `display_doc` branch after `blend_preview` |
| `crates/ui-egui/src/panels/properties/adjustments.rs` | keep the grid's pick, draw `section`, then run the pick |
| `crates/ui-egui/src/panels/registry.rs` | Properties entry `rows`/`states`/`run` |
| `crates/ui-egui/src/dialogs.rs` | `SAVE_FAMILY` in `PARAM_FAMILIES` |

Pigment's own files changed: `crates/engine/src/presets/adjustments.rs` (`pub mod panel;`),
`crates/engine/src/cmd/adjust_preset_cmds.rs` (`pub mod panel;`, `specs()` extends with
`panel::specs()`), `adjust_preset_cmds/tests.rs` (the "nothing journaled" test checks
`adjustment.presets.*` only, since `layer.adjustmentPreset` edits the document).

## Files

New: `crates/engine/src/presets/adjustments/panel.rs`, `crates/engine/src/cmd/adjust_preset_cmds/panel.rs`,
`crates/engine/src/cmd/adjust_preset_cmds/panel_tests.rs`, `crates/ui-egui/src/dialogs/adjust_editors/preset_row.rs`,
`crates/ui-egui/src/dialogs/adjust_editors/preset_row/tests.rs`, `crates/ui-egui/src/panels/adjustment_presets.rs`,
`crates/ui-egui/src/panels/adjustment_presets/tests.rs`. Edited: the hook files above, `docs/FORK.md`.

## Tests (all green here)

- engine `cmd::adjust_preset_cmds` (21 = A1's 11 + 10): every built-in panel preset adds its layers
  with the preset's settings over the defaults and a mask, one history step, top active; several
  layers → a group named after the preset, children bottom first ("Curves 1", "Hue/Saturation 1"),
  history label, one undo/redo; single layer → no group, numbering on; every layer takes the
  selection as its mask and the selection is dropped; `for_mode` in CMYK/Lab/Gray/RGB and Cross
  Process in a CMYK document is a CMYK curve; Your Presets saved from the selection (no history
  step), added back with kinds, names and settings, deleted; Your Presets survive `PresetState`
  save/load; saving needs adjustment layers (background, unknown id, blank name refused); bad
  group/preset params and damaged saved presets are errors, no history entry; the hover preview is
  the document the command makes.
- ui-egui `dialogs::adjust_editors::preset_row::tests` (8): the shown preset/Default/Custom rule
  (moved point → Custom, edited red under a composite preset still the preset, `15.0` = `15`); rows
  order; Save… bytes are Photoshop's `.acv`, name sanitised, no Save for Exposure; **picking "Strong
  Contrast (RGB)" in the Curves dialog by pointer** sets the built-in's points, an edit shows Custom
  in the picker, the document is untouched before OK; New/Rename/Delete (built-in)/Reset from the
  dialog through `answer_dialog` (settings only, no address keys; numbers as typed; listed at once
  and shown as current); every dialog kind shows the row; **a preset picked by pointer in a Levels
  layer's Properties is one history step** and sets the layer.
- ui-egui `panels::adjustment_presets::tests` (5): every group and preset listed (opened by pointer);
  hovering Moody previews a group on the canvas without touching the document, leaving clears it,
  clicking adds Curves + Hue/Saturation in one step, one undo removes it; a single-layer preset adds
  no group; Save Adjustment Preset… (state disabled without an adjustment layer, enabled with one)
  opens the name dialog, OK saves "Adjustment Preset 1", and the panel's Your Presets button adds it;
  a preview is dropped when the panel is no longer drawn or the document changes.
- Unchanged and green: ui-egui `adjust` + `properties` (83), `menus:: filter_dialog assistant_tools
  layers_tree align_bar` (142), `panels:: canvas::display menus:: adjust dock registry` (see Checks),
  automation lib (149), xtask (108).

## Checks

`cargo fmt --all -- --check`, `cargo clippy -p photocraft-engine -p photocraft-ui-egui
--all-targets -D warnings` (and engine + automation for A1's commit), `python3
scripts/pigment-rebrand.py --check`, panic hunt (`--ignored`, 1/1, with the three new commands),
`cargo xtask egui-fork`, `layers`, `panel-commands`, `test-binaries`, `scorecard --check`, `cargo test -p
xtask`: all green.

Container-only: `legacy_pigment_render::tests::cancelling_the_open_stops_the_smart_filters` (L3's
timing test, untouched by A2) fails here even alone (the median filters stop 83 s after the cancel
instead of < 2 s); it passed in CI on `852f6aa` (run 45955287515), so it is this container's speed,
not a regression. The full engine lib otherwise passed (4155).

## Not done (with why)

- HDR Toning's preset row: A7 (its dialog is a `HostedParamDialog`; REBASE puts the row in
  `filter_dialog/rows.rs` as a `Param::custom`, reusing `preset_row::preset_row`).
- Color Lookup presets: `colorLookup` is in A1's `KINDS` but its Properties editor is
  `adjust_ui::color_lookup_editor` (returns before the shared editor) and it has no Image ›
  Adjustments dialog here, so it shows no row. Add `preset_row::in_properties` there if wanted.
- The seven A6 panel presets (above) and their tooltips: A6.
- File › Open / drop of `.acv …` straight into the presets (A1 left it optional for A2): not done;
  Load… in the row covers it, the JS app had no Open route either.

## For the next packages

- **A3** (Auto, Options…): draw your buttons in the same closures; `EditorSetup` now has `presets`
  and `presets_rev` (keep them in any new `EditorSetup {…}` literal, or use `..Default::default()`).
  `AdjustAsk` has a `Preset` variant: `match` arms on `AdjustAsk` need it (session.rs uses `_`).
- **A4** (Curves Display Options… in the Properties menu): the Properties panel menu now exists:
  add a variant to `panels::adjustment_presets::PropertiesCommand` (or move the enum to its own
  module) and extend `panel_rows`/`command_states`/`run_fired`; the registry hook is already there.
- **A5/A6**: a new adjustment kind gets the Preset row in dialogs and Properties automatically when
  it is in A1's `presets::adjustments::KINDS` and in `adjust_editors::KINDS`. A6 adds its seven panel
  presets to `PANEL_PRESETS` (keep the JS order) and the `every_built_in_panel_preset_adds_its_layers`
  test covers them.
- **A7**: reuse `preset_row::preset_row(ui, "hdrToning", &entries, &value, &cx)`; HDR Toning has no
  `AdjustValue` variant, so either give the row a params-based entry point (compare and apply on
  params) or add one; `held`/`matches` are written for `AdjustValue`.
- **P1a/P1b**: user adjustment presets are `session.presets.adjustments` (`AdjustmentPresets`); the
  panel's Your Presets are its pseudo-kind `__panel`. `.pcpresets` export should carry both.
