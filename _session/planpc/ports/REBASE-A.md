# REBASE-A: group A (A1 to A7) re-checked against Pigment on PhotoCraft 057297b

Read each section beside its package in `PORTS-A.md` (sections 0, 2.1 to 2.12 and 9). Where the two
disagree, this file wins. The spec's intent and its tests' intent still hold. Only the places, the
framework pieces and the hooks change.

**Tree checked:** `/home/user/claude/pigment` on `claude/pigment-photocraft` at `03ccb71`
(`UPSTREAM-REVISION` = `057297b`). The pre-merge tree it is compared with is `f4e3ffa4`. craft-libs is pinned at
`18ffc07` (`Cargo.toml:15`) and was read from the cargo checkout
`~/.cargo/git/checkouts/craft-libs-d830b991a08c6c3d/18ffc07` (below, `CL/` = that folder's `crates/`).
The JS references (`claude/fervent-newton-263lz3`) are still readable with `git show`.

**Upstream's measured documents.** `docs/target-app-parity.md`, `docs/gaps.md`, `docs/scorecard.md` and
`docs/parity-checklist.md` claim none of the group's features: no adjustment presets, Auto Color
Correction Options, Curves display options, on-image tools, the three newer adjustments, HDR methods,
Match Color statistics, a Replace Color preview or solid colour in Properties. Two things are relevant:
the toolbox count leaves out "Targeted Adjustment" (`target-app-parity.md:65`), and Curves'
eyedroppers are UI-217-15, done (`scorecard.md:237`). The menu parity file counts only Photoshop's catalogue
(`menu_catalog.rs`). The code, not the documents, shows the one row part upstream built: the Levels
clipping display (A4).

## What changed for every package

1. **The adjustment editors moved into the framework.** `crates/ui-egui/src/dialogs/adjust_editors/{basic,curves,levels,
   hue_saturation,selective_color,gradient_map}.rs` are gone. Each kind is now a craft editor
   (`craft::imaging::ui::adjust::*`, source `CL/imaging/src/ui/adjust/`): `LevelsPanel`, `CurvesPanel` (around
   `craft::imaging::ui::curve::CurveEditor`), `BrightnessContrastEditor`, `AdjustSliders` (Exposure, Vibrance,
   Posterize, any table of `AdjustField`s), `HueSaturationEditor`, `BlackWhiteEditor`, `ChannelMixerEditor`,
   `SelectiveColorEditor`, `ThresholdEditor`, `ColorBalanceEditor`, `PhotoFilterEditor`, and Gradient Map's
   `craft::draw::ui::gradient::GradientMapEditor`. Pigment cannot change these editors (craft-libs is a pinned
   git dependency; FORK.md treats a craft-libs change as a question for the project's owner, see line 342). What
   Pigment owns:
   - `crates/ui-egui/src/dialogs/adjust_editors.rs`: `KINDS` (line 44, 14 kinds); the `AdjustValue` enum (line 78, one
     variant per kind); `show` (line 221), which calls the framework editor of each kind; `editor`/`dialog_editor`
     (lines 355/361); the asks enum `AdjustAsk` (line 159: `Auto`, `ImportGradients`, `PickColor`); `answer_color`,
     `answer_auto`; `EditorSetup` (line 180).
   - `crates/ui-egui/src/dialogs/adjust_editors/values.rs` (new upstream): `from_params`/`to_params` between engine
     params and `AdjustValue`, the tone channels and histograms.
   - `crates/ui-egui/src/dialogs/adjust_editors/session.rs`: the Properties editor, `layer_editor` (line 140), `commit`
     (line 254, one `layer.setAdjustment` with an optional `coalesce` key), the ask handling (line 225).
   - `crates/ui-egui/src/dialogs/adjust_dialog.rs`: the Image › Adjustments dialog is the framework's
     `HostedAdjustDialog<DialogValue, AdjustAsk>` on `app.framework.dialogs` (`open_hosted` line 596). The closure it
     runs is `shared_editor` (line 562), and `answer_asks` (line 755) answers what the editor asked. `pick` (line 240)
     handles a point picker and `add_point` (line 317) the Cmd-click Curves point. `OpenAdjust` (line 64) is
     `app.adjust_open`.

   **The rule for interface work in group A:** draw Pigment's controls in the closures Pigment owns, before or after
   the framework editor: `adjust_dialog::shared_editor` for the dialog, `session::layer_editor` for Properties, and
   the `show` arm of the kind. They receive `&mut DialogValue` (the value and its `ValueCx`) or the value with
   `vcx`. What they need from the app goes out as new `AdjustAsk` variants, answered in `answer_asks` and in
   `session.rs`'s `match out.ask`. Build controls from `craft::ui` pieces: `craft::ui::buttons::{Button,
   ToggleButton, IconButton}`, `craft::ui::choice::{Checkbox, Segmented, Swatch}`, `craft::ui::pickers::Select`,
   `craft::ui::layout_components::{Row, Stack}`, `craft::ui::display::Text`, `craft::ui::sections::Section`. A control
   that must let a press through the modal dialog to the canvas calls `cx.pass_canvas_gesture(canvas,
   CanvasGesture::PRIMARY)` from a framework container's `cx`, each pass (example: `TonePickerRow`,
   `CL/imaging/src/ui/adjust/tone.rs:151`; the canvas id is `AdjustDialogCx::canvas`).
2. **Filter-style dialogs are framework `HostedParamDialog`s.** Match Color, Replace Color and HDR Toning are
   parameter dialogs. Their custom rows are `Param::custom(key, label, |ui, fields, cx| …)` in
   `crates/ui-egui/src/dialogs/filter_dialog/rows.rs` (`custom_rows` line 56; Match Color line 359, Replace Color
   line 408). Use `Param::visible_when` / `enabled_when_in` (`CL/ui-patterns/src/patterns/form_dialogs/param.rs:737`, 621)
   for rows that depend on another field. Private keys a row keeps are left out by the family's `command_params`
   (header of `rows.rs`).
3. **Canvas presses for dialogs** are routed by `crates/ui-egui/src/dialogs/canvas_input.rs` (`DialogPick` line 28,
   `armed` line 55, `cursor` line 233) and `crates/ui-egui/src/canvas/tools/dialog.rs` (press/drag mapping lines 61 to
   125). The Properties panel's armed picker is `crates/ui-egui/src/dialogs/layer_picker.rs` (`arm` 44, `armed` 54,
   `sample_at` 78).
4. **Preferences and presets are saved in `config.toml`** through `craft::settings::SettingsStore<SavedPrefs>`
   (`crates/engine/src/prefs.rs:1781` to 1810). `preferences.json` is only imported once. `PresetState::to_json`
   (`presets.rs:155`) is saved under `presets` in the same TOML file. TOML has no null (`strip_nulls`,
   `prefs.rs:1818`). Every "save and reload" test goes through `SavedPrefs` serialization, not `preferences.json`.
   The spec's D1 and D3 stand with that change.
5. **Panel menus** are `PanelRow`s from the panel's registry entry (`crates/ui-egui/src/panels/registry.rs:36`,
   `rows`/`states`/`run`; example `panels/actions/menu.rs:31`). `xtask panel-commands` has an empty allow-list
   (`xtask/src/panel_commands.rs:48`), so every click handler must dispatch a command id (`app.run`,
   `menus::invoke`).
6. **Menus.** An engine `CommandSpec` that has a `menu` path becomes a menu row automatically (`menus/items.rs:160`
   to 200). Its place comes from `PLACE_AFTER` (there is a Pigment hook for AI, `ai_ui::place_after`). Do not add rows
   to `menu_catalog.rs`: it is Photoshop's tree, and `parity-checklist.md` is generated from it.
7. **Icons**: the framework's names are in `CL/ui-contract/icons/icons.toml`. Pigment's own SVGs are
   `assets/icons/*.svg`, listed in `crates/ui-egui/src/icon_data.rs`.
8. **Words**: `tl!()` (`crates/ui-egui/src/lib.rs:25`) and the craft-i18n catalogues (`i18n.rs` header). Framework
   patterns bring their own words (presets: `PresetWords`; adjustments: `AdjustWords`), so several English strings
   the spec lists are no longer Pigment's to add.
9. **Engine, io, algo, doc are unchanged in group A's places.** `adjust_params.rs` is identical (`eyedropper_from_params`
   930, `destructive_eyedropper` 944, `layer_eyedropper` 978, `levels_eyedropper` 836, `adjustment_eyedropper` 869,
   `curves_eyedropper` 880, `to_params` 275, `map_to_points` 590). `io/src/adjust_map.rs` and `adjust_map/encode.rs`
   are unchanged (`parse` 169, `parse_any` 217, encode fns `pub(super)`). The `ADJ` table moved from line 1217 to
   `cmd.rs:1226`. `edit_cmds.rs` `auto_adjust` is at line 851. `prefs.rs` `Preferences` is at line 1538.

---

## A1: adjustment presets, model, files, commands (rows 1 to 8, preset half)

### Status of each row
| Row | Now | Evidence |
|---|---|---|
| 1 Adjustment presets save/load/built-ins | missing | `crates/engine/src/presets/` has clone_source, gradients, patterns, shapes, styles, swatches, tools only; `PresetState` (`presets.rs:68`) has no adjustment field; no `adjustment.presets.*` command (`grep -rn "adjustment.presets" crates` is empty) |
| 2 Curves presets (.acv) | missing | no `.acv` reader/writer in `crates/io` |
| 3 Hue/Sat presets (.ahu) | missing | same |
| 4 B&W presets (.blw) | missing | same |
| 5 B/C presets | missing | same |
| 6 Channel Mixer presets (.cha) | missing | same |
| 7 Exposure presets | missing | same |
| 8 Threshold presets | missing | same |

None is dropped.

### Where things are now
| The spec names | Now |
|---|---|
| `crates/engine/src/presets.rs` `PresetState`, `Persisted` | still there: `PresetState` line 68, `Persisted` line 124, `to_json` 155, `load_presets_json` 182, `presets_changed` 281. Saved inside `config.toml` (see "What changed", 4) |
| `crates/io/src/adjust_map.rs` `parse` 169, `parse_any`, `b"hue2"` arm, `parse_black_white` | unchanged: `parse` 169, `parse_any` 217, `hue2` arm 236, `parse_black_white` 601, `parse_channel_mixer` 658, `parse_selective` 438, `parse_curves` 47 |
| `adjust_map/encode.rs` `levels` 78, `curves` 93, `hue_saturation` 39, `selective_color` 113, `black_white` 198, `channel_mixer` 227 | unchanged, same lines, still `pub(super)` |
| `crates/io/src/lib.rs` re-export | `mod adjust_map;` line 38, `pub use adjust_map::ADJUSTMENT_KEYS;` line 100: add the `adjust_presets` re-export beside them |
| `adjust_params::to_params` 275, `map_to_points` 590, `from_params` 92 | unchanged |
| `cmd.rs` ADJ table 1217 | `cmd.rs:1226` |
| `adjust_cmds::specs` registration | `cmd.rs:1426` (`v.extend(crate::adjust_cmds::specs())`); `presets::specs` at 1447 |
| `edit_menu_cmds/presets.rs` `PresetFile` 140 (D4) | unchanged (150 lines) |
| "preferences.json under presets.adjustments" | `config.toml`, key `presets.adjustments` (TOML) |

### The plan, adjusted
The spec's A1 stands as written, with these changes:
- **Files**: `crates/io/src/adjust_map/preset_files.rs` (new; `mod preset_files;` in `adjust_map.rs` beside `mod encode;`
  line 17), `crates/engine/src/presets/adjustments.rs` (new; `pub mod adjustments;` in `presets.rs` after line 30),
  `crates/engine/src/cmd/adjust_preset_cmds.rs` (new; register next to `cmd.rs:1426`).
- **Hooks into upstream files** (list each one in FORK.md under "What Pigment added", a new "Adjustment presets"
  subsection): `presets.rs` (one field in `PresetState`, `Default`, `Persisted`, `to_json`, `load_presets_json`);
  `adjust_map/encode.rs` (`pub(super)` to `pub(crate)` on the six encoders); `adjust_map.rs` (the `mod` line, and
  `parse_any`/`parse_black_white` to `pub(crate)` if `preset_files` calls them); `io/src/lib.rs` (one re-export);
  `cmd.rs` (one `extend`).
- **Persistence**: `adjustments` is a `#[serde(default)] Option<Value>` in `Persisted`, read entry by entry as
  `tool_presets` and `contours` are (a bad entry must not discard the others, #5602 comment at `presets.rs:178`).
  Store params with no nulls (TOML). `hidden_builtins` per kind as in D1.
- **Optional, small**: route `.acv .alv .ahu .cha .asv .blw` dropped on the window or opened with File › Open to
  `adjustment.presets.load` in `crates/ui-egui/src/preset_files_ui.rs` (`PRESET_EXTS` line 20, `open` line 88). The
  JS app did not do this, so it is optional. If it is added, list it in FORK.md.
- **Tests** (unchanged intent): io round trips, golden sizes, the JS-written fixtures under
  `crates/io/tests/fixtures/adjust-presets/`, truncation loop. Engine: built-in names, save/rename/delete/reset,
  `presets.rev` bump, and **a `SavedPrefs` TOML round trip** (serialize with `toml`/the store as the prefs tests in
  `crates/engine/src/prefs/tests.rs` do) that keeps user presets and hidden built-ins; `.acv` load names the preset
  after the file. New commands are engine commands: run the panic hunt (`cargo test -p photocraft-engine --test
  panic_hunt -- --ignored`) with adversarial `kind`/`data`.
- **Effort**: L, 2 days (unchanged).

---

## A2: adjustment presets interface and the Adjustments panel presets (rows 1, 10)

### Status of each row
| Row | Now | Evidence |
|---|---|---|
| 1 Preset menu and gear menu in dialogs and Properties | missing | `adjust_dialog::shared_editor` (line 562) and `session::layer_editor` (line 140) draw the framework editor only; `HostedAdjustDialog` has no preset slot |
| 10 Adjustments panel presets (groups, Your Presets, hover preview) | missing | `crates/ui-egui/src/panels/properties/adjustments.rs` (14 lines) shows the framework's `AdjustmentsPanel` grid of 16 kinds and nothing else |

### Where things are now
| The spec names | Now |
|---|---|
| `adjust_dialog.rs` `body` line 602 ("top of body") | gone (the dialog body is the framework's `HostedAdjustDialog`). Hook: `adjust_dialog::shared_editor` (line 562): draw the preset row, then `adjust_editors::dialog_editor(...)` |
| `adjust_editors/session.rs` `layer_editor` line 84 | `session.rs:140`; the editor runs at line 208 (`run(ui, &mut value, &mut cx)`). Draw the preset row just before it; commit through `commit` (line 254) |
| `adjust_editors.rs` `editor` 152, `KINDS` 58 | `editor` line 355, `KINDS` line 44 |
| `widgets::dropdown`, a gear menu | `crate::widgets` deleted. Use the framework's **`craft::ui::patterns::presets::NamedPresetRow`** around a `PresetPicker` (`CL/ui-patterns/src/patterns/presets/named.rs:160`): the picker, New…, Rename…, Delete, "(built-in)" marks (`built_in`), file entries (`files: PresetFiles`, Load/Replace/Save), F2 rename, name checks (`check_name`, `PresetError::NameTaken`). Upstream's use: `crates/ui-egui/src/dialogs/export_dialog.rs:234` (`PresetLibrary`, `NamedPresetEvent`) and `dialogs/new_doc_ui.rs`; craft's own `CL/ui-patterns/src/patterns/form_dialogs/pdf_export.rs:331` to 380 (the "modified" placeholder = Photoshop's Custom) |
| `crate::file_dialog` filters by kind | `app.pick_file_bytes_filtered(&exts, |app, name, bytes| …)` (`file_dialog.rs:288`) and `app.pick_save(name, |app, path| …)` (216) with `app.services.write`; example `panels/swatches_ui.rs:215` `answer_file` (a `PresetFileRequest` from the row) |
| `adjust_params` `merge` | private `merge` at `adjust_params.rs:443`; in the UI, convert preset params with `values::from_params(kind, params, &vcx)` and write the value |
| `panels/properties.rs` `adjustments_grid` line 228 | gone. The Adjustments panel is `panels/properties/adjustments.rs::panel` (framework `AdjustmentsPanel`, `CL/imaging/src/ui/adjust/panel.rs`); the registry entry is `panels/registry.rs:121` |
| `adjust_preview.rs` temporary preview layer for hover | `dialogs/adjust_preview.rs`: `preview_document` 175 (dialog: clipped to the target) and the Properties live path `live_key` 527 (`app.live_adjust`). Neither adds new layers above the active one |
| Properties panel menu "Save Adjustment Preset…" | Properties has no menu rows today (`registry.rs:120`, default `no_rows`). Add `rows`/`states`/`run` as `panels/actions/menu.rs` does, with a `PanelRow::Command` for `layer.saveAdjustmentPreset` |
| strings "Preset:", "Save Preset…", "Delete Current Preset", "Rename Preset…", "Replace the preset…?" | come from the framework's `PresetWords` (New…, Rename…, Delete, Load/Save, name-taken message). Pigment adds only the kind titles ("Curves presets"…), "Reset to Default…", the built-in preset names, "Adjustment Presets", the panel group/preset names, "Your Presets", "Save Adjustment Preset…" |

### The plan, adjusted
- **New file** `crates/ui-egui/src/dialogs/adjust_editors/preset_row.rs`: `preset_row(ui, kind, presets: &[PresetEntry],
  current_params: &Value) -> Vec<PresetAsk>`. It builds `PresetRow`s (groups as `PresetRow` groups, built-ins marked through
  `built_in`), a `PresetPicker` whose held key is the matching preset, or `None` with the placeholder "Custom" when the
  settings differ (the JS `sameSettings` rule: compare the preset's keys only), and `PresetFiles::new("adjustment.<kind>",
  title, &[ext, "pcpresets"])`. "Reset to Default…" is a `Button` after the row (Photoshop's gear item), sent as
  `adjustment.presets.reset`. The function returns the row's `NamedPresetEvent`s mapped to `PresetAsk { Apply(params),
  Create(name), Rename{..}, Delete(name), File(PresetFileRequest), Reset }`.
- **The preset list in the closure**: add `presets: Vec<PresetEntry>` and `presets_rev: u64` to `EditorSetup` (`adjust_editors.rs:180`).
  Fill them in `adjust_dialog::build_setup` (line 523) and in `session::layer_editor` from `adjustment.presets.list`.
  `answer_asks` replaces `open.setup` when `app.session.presets.rev` moved, as `follow_target` does for the target.
- **Asks**: add `AdjustAsk::Preset(PresetAsk)` (`adjust_editors.rs:159`). The dialog answers it in `answer_asks` (line 755):
  Apply calls `apply_params(app, id, &params)` (line 182); Create, Rename, Delete and Reset run `adjustment.presets.*`;
  File runs `pick_file_bytes_filtered` into `adjustment.presets.load`, or `adjustment.presets.export` then `pick_save`. Properties
  answers it in `session.rs`'s `match out.ask` (line 225): Apply goes through `commit(…, Some(layer_key(id)))`, one
  history step.
- **Hook points (upstream files, keep each to a few lines; list them in FORK.md)**: `adjust_dialog.rs` `shared_editor`
  (draw the row before the editor), `answer_asks` (one arm), `build_setup` (two fields); `session.rs` `layer_editor` (draw
  the row, one arm); `adjust_editors.rs` (`mod preset_row;`, the enum variant, two `EditorSetup` fields).
- **HDR Toning presets** (A7's kind): its dialog is a `HostedParamDialog`, so the row is a `Param::custom("__preset", …)`
  in `filter_dialog/rows.rs` (an `hdr_toning` arm in `custom_rows` line 56). The preset list is captured when the rows
  are built (`custom_rows` has `app`). The events go out through a private field key that the filter dialog's pump reads.
  This is A7's work, with `preset_row` reused.
- **Adjustments panel presets (row 10)** in `panels/properties/adjustments.rs` (Pigment adds code after the grid; the file
  is upstream's: list the hook). Use `craft::ui::sections::Section` (collapsible, as `layer_props_ui.rs:168`/212 use
  it) per group, and one `Button` per preset (`Sizing::FillWidth`, as `properties.rs:145` does) that runs
  `layer.adjustmentPreset {"group","preset"}` through `app.run` (panel-commands rule). "Your Presets" is the user
  group `__panel`. The engine part (`PANEL_PRESETS`, `layer.adjustmentPreset`, `layer.saveAdjustmentPreset`) is as
  the spec says, in `presets/adjustments.rs`.
- **Hover preview**: add `app.adjust_panel_hover: Option<(DocId, u64 /*revision*/, Vec<(String, Value)>)>`, set while a
  preset button is hovered (`response.hovered()`) and cleared otherwise. Add a small branch in `canvas::display_doc`
  beside the `live_adjust` branch that shows a shallow copy of the document with temporary adjustment layers
  (`photocraft_engine::adjust_params::from_params` → `Layer::adjustment`) inserted above the active layer. A new
  `adjust_preview::hover_document(doc, active, &[(kind, params)])` builds it in the style of `base_document`/`with_settings`
  (lines 130/158). This previews every layer of the preset, which is better than the spec's fallback of the first
  layer only.
- **Properties panel menu**: `registry.rs:120` gets `rows: properties::menu_rows` (one `PanelRow::Command` for
  `layer.saveAdjustmentPreset`, enabled when the selection holds adjustment layers), `states`, `run`. The
  "Save Adjustment Preset…" name prompt is a framework prompt, as `dialogs/preset_group_prompt.rs` asks for a name.
- **Tests** (intent unchanged; mechanics new): use the harness in `dialogs/adjust_editors/ui_tests.rs`
  (`app_harness`, `label_rect`, `click`, `history_len`) and in `dialogs/adjust_dialog/tests.rs` (`open_in_harness`,
  `params`, `ok`). Cases: open Curves, pick "Strong Contrast (RGB)" in the picker and the dialog's `points` equal the
  built-in; drag a point and the picker shows the Custom placeholder; a Levels layer in Properties applies a preset
  in one history step (`history_len` +1). Panel: `layer.adjustmentPreset` "Film Grain" (after A6) adds a group with
  Curves and Grain, a single-layer preset adds no group, and one undo removes everything. Hover sets
  `adjust_panel_hover` and leaving clears it. Run `cargo xtask panel-commands` and, for the new panel rows,
  `cargo xtask scorecard --check`.
- **Effort**: M+, 1.5 days. The framework row saves the dropdown and menu work. Wiring three hosts (dialog,
  Properties, the HDR param dialog) takes about the same time.

---

## A3: Auto Color Correction Options, Auto in Curves and Brightness/Contrast, eyedropper targets (rows 2, 5, 14, 15, 16)

### Status of each row
| Row | Now | Evidence |
|---|---|---|
| 2 Curves Auto | missing | `CurvesPanel` (`CL/imaging/src/ui/adjust/curves_panel.rs`) has the pickers, the Channel select, the mode icons and Smooth; no Auto, no Options |
| 5 Brightness/Contrast Auto | missing | `BrightnessContrastEditor` (`CL/imaging/src/ui/adjust/basic/brightness_contrast.rs`): Brightness, Contrast, Use Legacy |
| 14 Auto Color Correction Options | missing | no options anywhere; `image.autoTone/autoContrast/autoColor` (`edit_cmds.rs:1281` to 1283) take `{}` and `auto_adjust` (line 851) has a fixed 0.1 % clip |
| 15 Levels Auto and Auto Options | Auto present, Options missing | Levels Auto is the framework's `Levels::auto` (`CL/imaging/src/ui/adjust/levels_panel.rs:33`, "PhotoCraft's rule": total/1000 per channel), emitted as one `Set` labelled "Auto" (line 243); no Alt-click, no options |
| 16 Levels/Curves eyedropper target colours | missing | `levels_eyedropper`/`curves_eyedropper` (`adjust_params.rs:836`, 880) still set 0/255/neutral; the picker row is the framework's `TonePickerRow`, which reports no double-click (`TonePickerRowOutput { response, change }`, `tone.rs:86`) |

New upstream: `photocraft_algo::tone::auto_levels::analyze` (`crates/algo/src/tone/auto_levels.rs:113`), a bounded,
cancellable sampler of the three channel histograms with the same fixed rule (Tone/Contrast/Color). It has no
algorithm choice or targets, and `auto_adjust` does not use it yet (only `algo/src/tests/adversarial_native.rs`
does).

### Where things are now
| The spec names | Now |
|---|---|
| `crates/algo/src/auto_tone.rs` (new) | still a new file. Put it at `crates/algo/src/tone/auto_options.rs` beside upstream's `auto_levels.rs` (`pub mod auto_options;` in `tone.rs` after line 218), or keep `algo/src/auto_tone.rs`; either is a Pigment-owned file. It takes histograms as input, as the spec says |
| `prefs.rs` `Preferences` line 1368, D3 section | `Preferences` at line 1538; add `pub adjustments: AdjustmentPrefs` (serde camelCase, a `[adjustments]` table in `config.toml`); validation in `prefs/validate.rs`; `prefs.set` paths through `prefs/cmds.rs:22` |
| `edit_cmds.rs` `auto_adjust` line 843 | line 851 (specs 1281 to 1283) |
| `adjust_params.rs` `levels_eyedropper` 836, `curves_eyedropper` 880 | unchanged |
| `levels.rs` line 82 Auto, `curves.rs` beside the channel picker, `basic.rs::brightness_contrast` | gone (framework editors). Hooks: the `levels`, `curves` and `brightnessContrast` arms of `adjust_editors.rs::show` (lines 224 to 280) |
| `adjust_dialog.rs` `picker_controls` line 243 (double-click) | gone. The picker row is drawn inside `LevelsPanel`/`CurvesPanel` when `.pickers(…)` is given (`adjust_editors.rs`, the `levels` and `curves` arms) |
| `auto_options_ui.rs` with `color_picker_ui` swatches | a framework `HostedParamDialog`: rows `ParamKind::radio`/`choice` (algorithms), `ParamKind::bool` (Snap Neutral Midtones, Save as defaults), `ParamKind::color(Some(rgb))` (the three targets; the colour row opens the shared picker), numbers with a range (clips). Examples: `dialogs/fill_ui.rs:50`, `dialogs/duplicate_layer_ui.rs:67`, `menus/view_cmds/dialogs.rs:401` |
| "Save the new target colors as defaults?" `dont_show_again` prompt | a framework `StandardPrompt` with `.dont_show_again()`, its key in `dont_show_again_keys()`, as `dialogs/legacy_save_prompt.rs` and `dialogs/alerts.rs` do (MERGE-PLAN §5.2) |

### The plan, adjusted
- **algo** (`tone/auto_options.rs`): as the spec says (`AutoOptions`, `auto_levels(hists, sample, options) -> [Levels5; 4]`,
  ported line for line from JS `autoLevelsParams`, `clipRange`, `gammaFor`, `darkLightColors`, `neutralSample`). For the
  histograms of a layer, reuse upstream's bounded sampling: make `auto_levels::histograms` `pub` (one-word upstream hook)
  or copy its grid policy, so a 24 MP image stays bounded and cancellable.
- **engine**: `Preferences.adjustments.auto_options` (+ `auto_options_saved`); `auto_adjust` (line 851) reads explicit params
  first, then the saved options, then Photoshop's per-command defaults; `adjust_params::auto_params(kind, hist, sample,
  options)`; eyedropper targets in `levels_eyedropper`/`curves_eyedropper`; the new command `image.adjustments.autoOptions`
  (journal false). Add `adjust_params::auto_brightness_contrast(hist)` (JS `autoBrightnessContrast`) and
  `auto_curves` here too (spec 2.2). The engine commands need the panic hunt.
- **Auto in the editors** (all in Pigment's `adjust_editors.rs`):
  - Levels: the framework's Auto sets the value itself. In the `levels` arm, after `panel.show(ui)`, look for an event
    `EditEvent::Set` labelled "Auto". If there is one, return `AdjustAsk::AutoTone { kind: "levels", options: None }`.
    The host (`answer_asks` / `session.rs`) replaces the framework's result with `image.adjustments.autoOptions`'
    `auto_params` result whenever the user saved options. With Alt held in that pass (`ui.input(|i|
    i.modifiers.alt)`) it opens the options dialog instead and restores the value from before the event (the `Set`
    event's `before`).
  - Curves and Brightness/Contrast: draw a `Row` with `Button::new("Auto")` and, for Curves, `Button::new("Options…")`
    after the framework editor in the arm (Photoshop puts them beside the channel select; below the editor is the
    nearest place Pigment can draw without a craft-libs change, so record that choice in FORK.md). Levels also gets
    "Options…".
- **The options dialog** `crates/ui-egui/src/dialogs/auto_options_ui.rs` (new): a `HostedParamDialog` opened **over** the
  adjustment dialog on `app.framework.dialogs` (the host stacks dialogs as it does for the Color Picker over Levels).
  Its pump takes the form's fields on every change and writes `auto_params(...)` into the adjustment dialog's value
  (`apply_params`), so the parent previews. Cancel restores the parameters saved when the dialog opened. OK with "Save as
  defaults" sets the preference.
- **Eyedropper double-click (row 16)**: the framework row does not report it. Draw Pigment's own picker row in the
  `levels`/`curves` arms instead of passing `.pickers(…)` to the panel. It has three `ToggleButton`s with
  `TonePicker::ALL`, `picker.icon()`, `picker.label(&words)`, `picker.supported(..)`, `.escape_disarms()`, and
  `cx.pass_canvas_gesture` while one is armed: a copy of `TonePickerRow::show` (`tone.rs:141` to 170) that also reads
  `response.double_clicked()` and returns `AdjustAsk::PickTarget(TonePicker)`. The host opens the Color Picker
  (`color_picker_ui::open_for_request`) and stores the answer in the options. The targets can also be set in the
  options dialog's three colour rows, so a fallback that keeps only that path costs nothing. If the extra row is
  rejected in review, record it.
- **Hooks**: `prefs.rs` (one section field), `prefs/validate.rs` (one call), `edit_cmds.rs` `auto_adjust` (the options
  source) and its three spec strings, `adjust_params.rs` (eyedropper targets), `tone.rs` (one `mod` line), `adjust_editors.rs`
  arms and asks, `adjust_dialog.rs` `answer_asks`, `session.rs` ask arm, `dialogs.rs` (register the new dialog and prompt).
- **Tests**: algo, the six JS-generated cases (node, as the spec says), snap neutral, clip 0 vs 2 %. Engine:
  `image.autoColor` with saved options equals `image.adjustments.levels` with the `auto_params` result; validation
  clamps 50 % to 9.99. UI (`adjust_dialog/tests.rs` harness): Alt-click Auto opens the options dialog and Cancel
  restores the Levels fields; Curves Auto on a low-contrast fixture sets the end points at the clip; B/C Auto raises
  brightness on a dark image; double-clicking the white eyedropper opens the picker and its answer becomes the
  highlight target. Run `cargo xtask scorecard --check`: the scorecard's preference audit counts preferences that
  do nothing, so a new one needs its reader.
- **Effort**: M+, 2 days (the spec said 1.5). The framework's own Auto has to be intercepted and the picker row redrawn.

---

## A4: Curves display options and Show Clipping (row 11)

### Status of each row
| Part of row 11 | Now | Evidence |
|---|---|---|
| Levels Alt-drag clipping display | **done upstream, dropped from A4** | `crates/ui-egui/src/levels_clipping.rs` (#3328): Alt on the Levels black/white input thumb shows Photoshop's threshold display on the canvas (`LevelsEditorOutput::clipping`, `CL/imaging/src/ui/adjust/levels_editor.rs:186`; `HostedAdjustDialog::clipping()`; drawn by `canvas/document_display.rs:323`); tests `crates/ui-egui/src/levels_clipping_tests.rs` (`gamma_and_output_levels_do_not_hide_clipping` and others). It is per channel, Grayscale too, refused for CMYK/Lab/channel targets, as Photoshop |
| Curves Show Clipping (check box, Alt on the endpoints) | missing | `CurvesPanel` has no check box and no Alt reporting; `levels_clipping::dialog` (line 220) accepts `levels` only |
| Show Amount of Light / Pigment-Ink % | missing, **framework-blocked** | `CurveEditor`/the curve graph (`CL/imaging/src/ui/curve/graph.rs:180`) draws a fixed axis orientation and tone bars |
| Simple / Detailed grid | missing, **framework-blocked** | the quarter grid is hard-coded (`graph.rs:186` to 192, `for i in 1..4`) |
| Show Channel Overlays | missing, **framework-blocked** | `CurvesPanel` computes overlays itself (`overlays_for`, `curves_panel.rs:52`) with no prop |
| Show Histogram | missing, buildable | pass `&[]` histograms to `CurvesPanel` (the `curves` arm of `adjust_editors.rs::show`) |
| Show Baseline | missing, **framework-blocked** | the diagonal is always drawn (`graph.rs:194`) |
| Show Intersection Line | missing, **framework-blocked** | no such line in `graph.rs` |

The Levels half of "Show Clipping" is dropped because upstream's display already does what Photoshop's does (Alt
while dragging the input thumbs, per channel colours) and it is tested.

### Where things are now
| The spec names | Now |
|---|---|
| `curves.rs` lines 404 to 440 (drawing) | gone: drawing is `CL/imaging/src/ui/curve/graph.rs` (`CurveLook::backdrop` 180) and `CurvesPanel::show` (`curves_panel.rs:287`) |
| `levels.rs` (no Alt handling) | gone; Alt is handled by the framework `LevelsEditor`, and the display by upstream's `levels_clipping.rs` |
| `app.ui.clipping_display = Some(ClipDisplay{..})` | the dialog's own state: `AdjustDialogCx::clipping: &mut Option<LevelsClip>` (in the closure), `HostedAdjustDialog::clipping()` / `set_clipping()` (from the app) |
| `adjust_preview.rs` substitution with a Threshold-like map | not needed: `levels_clipping.rs` draws the display as a texture over the canvas from per-block min/max stats (`scan` 122, `thresholds` 66, `image` 182, `shapes` 293) |
| `Preferences.adjustments.curves_display` (D3) | `Preferences` line 1538; A3 adds the `adjustments` section, A4 adds the field |

### The plan, adjusted
**Buildable now, in Pigment (1 day):**
- `Preferences.adjustments.curves_display` exactly as the spec says (all six options stored, with `amount` per colour
  mode), so options that the framework cannot draw yet are kept and take effect once it can.
- A `Curve Display Options…` button in the `curves` arm of `adjust_editors.rs::show` that opens a small `HostedParamDialog`
  (radio Amount, radio grid, four check boxes) writing `prefs.set adjustments.curvesDisplay.*`. In Properties, add the item to
  the Properties panel menu (A2's rows) as Photoshop does. The rows the framework cannot honour yet are shown
  disabled with a caption ("Needs a newer craft framework"), or hidden. The engineer chooses and records the choice in
  FORK.md.
- **Show Histogram**: off passes `&[]` to `CurvesPanel::histograms`.
- **Curves Show Clipping**: a `Checkbox` under the panel in the `curves` arm (dialog only, as in Photoshop and JS). While it is
  on, or Alt is held, and the pass's edit events show the first or last point's input moving (compare the event's `before`
  and `after` for the shown channel), set `*cx.clipping = Some(LevelsClip::Shadows | Highlights)`. Clear it when the gesture
  commits or cancels. In `levels_clipping.rs`, extend `dialog` (line 220) to accept `curves`, and `request` (227) to turn the
  Curves params into an `Adjustment::Levels` whose per-channel `in_black`/`in_white` are each curve's first and last point
  inputs. `thresholds`, `scan`, `image` and the texture are then reused unchanged. Upstream file hooks: two short
  changes in `levels_clipping.rs`, and the arm in `adjust_editors.rs`.

**Blocked on craft-libs** (grid, baseline, overlays, intersection line, Pigment/Ink %): these need props on
`CurveEditor`/`CurveGraph` (`grid: Simple|Detailed`, `baseline: bool`, `intersection: bool`, `amount: Light|Pigment`,
mirroring the plot and the tone bars while the stored values stay light-based) and on `CurvesPanel` (`overlays: bool`, and
pass-through of the rest). That is a craft-libs change (about 1 day there, with its story tests), and Pigment only picks it
up when upstream PhotoCraft moves its pin past it. Ask the project's owner whether to propose it to craft-libs. Until
then these options are stored only. Do not fork craft-libs and do not redraw Curves in Pigment (a second curve editor
would drift from upstream's).

**Tests**: prefs round trip through `SavedPrefs` (TOML); the options dialog writes the prefs; Show Histogram off draws no
histogram (the panel gets an empty slice; assert on `EditorSetup`/the arm's arguments, or count the histogram shapes as
`levels_clipping_tests.rs` inspects output); Curves Show Clipping sets `HostedAdjustDialog::clipping()` only while an
endpoint is dragged (harness drag as in `adjust_dialog/tests.rs::curves_pointer_drag_previews_until_confirm_and_cancel_preserves_document`);
`levels_clipping::request` for a Curves value equals the request for the Levels value with the same end points (unit
test beside `levels_clipping_tests.rs`). The spec's grid-line count test and the Pigment-mode mapping test wait for the
framework props.

**Effort**: S+, 1 day in Pigment now. The rest is about 1 day in craft-libs, if the owner agrees.

---

## A5: on-image tools and eyedroppers (rows 3, 4, 7, 12, 13)

### Status of each row
| Row | Now | Evidence |
|---|---|---|
| 12 Curves on-image tool (hand: click a tone, drag up/down) | missing | only Cmd-click adds a point (`adjust_dialog::add_point` line 317 → `CurvesPanel::add_point_from_sample`, `curves_panel.rs:237`); no drag tool |
| 3 Hue/Sat on-image tool (drag saturation, Ctrl hue) | missing | `HueSaturationEditor` has no tool; no `DialogPick` for it |
| 4 B&W on-image tool | missing | `BlackWhiteEditor`: weights, Tint, Auto, Default only |
| 13 Hue/Sat range eyedroppers (pick, add, subtract) | missing | none in `HueSaturationEditor`; the engine has no `hue_saturation_eyedropper` |
| 7 Exposure eyedroppers (black, gray, white) | missing | `adjustment_eyedropper` (`adjust_params.rs:869`) takes levels/curves; `adjust_dialog::pick` returns early for other kinds (line 245); the `exposure` params string (`cmd.rs`, ADJ) has no `eyedropper` |

### Where things are now
| The spec names | Now |
|---|---|
| `adjust_dialog.rs` `picker_armed` 45, `sample_at` 58, `add_point_at` 143, `picker_controls` 243 | `picker_applies` 161, `pick` 240, `add_point` 317; the picker buttons are the framework's `TonePickerRow` inside the panels |
| engine `eyedropper_from_params` 930, `destructive_eyedropper` 944, `layer_eyedropper` 978, `adjustment_eyedropper` 869 | unchanged |
| `hue_saturation.rs` `move_hue_range_handle` 25, `move_hue_range_zone` 77 | gone: `HueRangeValue::move_bound`/`canonical_bounds` in `CL/imaging/src/ui/adjust/hue_saturation.rs:74`, 92 |
| `cmd.rs` ADJ table 1217 (exposure, hueSaturation strings) | `cmd.rs:1226`: exposure (line 1238), hueSaturation (1241) |
| canvas routing "grep `crates/ui-egui/src/canvas/` and `input/`" | `dialogs/canvas_input.rs` (`DialogPick`, `armed`, `follows_drag` 107, `resample` 117, `cursor` 233) and `canvas/tools/dialog.rs` (press, drag, release). Pattern to copy for a press-and-drag pick: `DialogPick::ShadowDrag` → `canvas_input::drag_shadow(app, at, delta)` |
| `session::layer_mem`, `properties_coalesce` | gone. Properties arming lives in `dialogs/layer_picker.rs` (`arm`/`armed`/`sample_at`); one history step per gesture is `commit(…, crate::history_keys::coalesce(GESTURE_KEY, &event))` or `Some(layer_key(id))` in `session.rs` |
| `picker_button` with icon `hand-pointer` | `craft::ui::buttons::ToggleButton::new(label, Bind::given(on)).icon(IconId::new("hand")).icon_only().escape_disarms()` (framework icon `hand`, `CL/ui-contract/icons/icons.toml`); example of a Pigment-drawn toggle row: `filter_dialog/rows.rs:422` `droppers_row` (pick/add/subtract with `IconSpec::mark(CursorBadge::Add/Subtract)`) |
| the targeted-adjustment cursor via `crates/ui-egui/src/canvas` cursor mapping | `canvas_input::cursor` (line 233): add an arm returning `Cursor::Painted(PaintedCursor::tool(IconId::new("<pigment icon>"), hotspot, None))`; put a hand-with-arrows SVG in `assets/icons/` and `icon_data.rs` |
| `canvas_menu_tests.rs`-style press and drag | `canvas_menu_tests.rs` still exists; the dialog press/drag tests are in `dialogs/adjust_dialog/tests.rs` (`curves_eyedroppers_sample_repeatedly_without_editing_the_document`, `input`, `arm`, `sample_at`) |

### The plan, adjusted
- **Engine** (`adjust_params.rs`), as the spec says: `exposure_eyedropper`; `hue_saturation_eyedropper` (port of JS
  `rangeForColor`, `addHueToRange`, `subtractHueFromRange`) with the new `edit` key and `rangeEyedropper` params;
  `on_image_curves`, `on_image_hue_sat`, `on_image_black_white` as pure functions reachable through `"onImage"` params.
  Extend `adjustment_eyedropper` and `eyedropper_from_params` to `exposure`; add `"eyedropper":json` to the exposure string
  and `"edit"`, `"rangeEyedropper"`, `"onImage"` to the hueSaturation, curves and blackWhite strings (`cmd.rs:1226`). Run the panic
  hunt.
- **Exposure eyedroppers: reuse the tone picker.** In the `exposure` arm of `adjust_editors.rs::show`, draw
  `TonePickerRow::new(Bind::bound(&mut *cx.picker)).canvas(..)` above `AdjustSliders`. `cx.picker` is the dialog's own
  picker state, so `canvas_input::armed` already returns `DialogPick::TonePicker` for it. Then let `adjust_dialog::pick`
  (line 245) and `picker_applies` (161) accept `exposure`, and in Properties `layer_picker::sample_at`. This needs no new
  canvas routing.
- **Hue/Sat range eyedroppers and the three hand tools** need a new arm state. Keep it in `OpenAdjust`
  (`adjust_dialog.rs:64`), as a new `on_image: Option<OnImageTool>` (`Hand`, `RangePick | RangeAdd | RangeSubtract`), set from
  a new `AdjustAsk::ArmOnImage(Option<OnImageTool>)` that the Pigment-drawn toggle row returns. For Properties, extend
  `layer_picker` with the same tool. The toggle row is drawn in the `curves`, `hueSaturation` and `blackWhite` arms;
  while a tool is armed it calls `cx.pass_canvas_gesture(canvas, CanvasGesture::PRIMARY)` from its `Row`'s `cx`.
  The armed state must reach the closure: put it in `EditorSetup` (replaced through `open.setup`) or in egui temp
  memory keyed by the dialog id.
- **Canvas routing**: add `DialogPick::OnImage(OnImageTool)` to `canvas_input.rs`. `armed` returns it when `open.on_image`
  is set. New functions `on_image_press(app, at)` (sample once, remember the base params), `on_image_drag(app, at, delta,
  mods)` (recompute from the base every step and write through `apply_params`), `on_image_release`. Map them in
  `canvas/tools/dialog.rs` the way `ShadowDrag` is mapped (press line 86, drag line 118). `follows_drag` is false for
  the hand tools (a drag changes the value, it does not resample) and true for the range eyedroppers. Add the
  cursor arm. Hue/Sat's picked range is shown through `HueSaturationEditor::range(Some(i))` (host-kept,
  `hue_saturation.rs:286`), so keep the shown range in the setup and pass it in the arm.
- **Properties**: on release run `commit(..., Some(layer_key(id)))` (one step); while dragging update `app.live_adjust`.
- **Hooks**: `adjust_params.rs` (new functions plus two match arms), `cmd.rs` (four param strings), `adjust_editors.rs`
  (three arms, asks), `adjust_dialog.rs` (`OpenAdjust` field, `pick`/`picker_applies` kinds, `answer_asks` arm),
  `canvas_input.rs` (enum arm, `armed`, `cursor`), `canvas/tools/dialog.rs` (three match arms), `layer_picker.rs`,
  `session.rs`. List them in FORK.md. Put Pigment's own logic in a new `crates/ui-egui/src/dialogs/adjust_on_image.rs` so the
  hooks stay one-liners.
- **Tests**: engine as the spec says (each pure function and the params paths through `image.adjustments.*` and
  `layer.newAdjustmentLayer.*`). UI with the `adjust_dialog/tests.rs` harness: arm the hand in Curves, press and drag on
  the canvas (`input(h, mods, &[PointerButton.., PointerMoved..])`), and a point appears; OK records one history
  step. The Properties variant commits once. Exposure gray picker on a 0.09 linear sample gives +1 stop through the
  dialog. The Hue/Sat Add eyedropper widens the bounds through the canvas.
- **Effort**: L, 2.5 days (the spec said 2). The canvas routing is new code across three modules, and the hand
  buttons must be drawn outside the framework editors.

---

## A6: Color and Vibrance, Clarity and Dehaze, Grain (row 17)

### Status of each row
| Row | Now | Evidence |
|---|---|---|
| 17 Newer adjustments as Image › Adjustments and adjustment layers | missing | `photocraft_doc::Adjustment` (`crates/doc/src/adjust.rs:215`) has no such variants; `grep -rn ColorVibrance crates` is empty; the importer keeps them as `Adjustment::Unsupported { psd_key: "pcJS" }` (`crates/io/src/legacy_pigment/adjust.rs:21`, 468 to 475; test at line 678) |

### Where things are now
| The spec names | Now |
|---|---|
| `crates/doc/src/adjust.rs` | `Adjustment` enum at line 215 |
| `compose/src/adjust.rs` (`apply_adjustment` family) | evaluation dispatch is `Ctx::apply_adjustment` (`compose/src/ctx.rs:145`); kernels in `compose/src/adjust.rs` |
| `composite.rs` line 428 `cx.apply_adjustment(adj, &mut adjusted)` | **three** places now: Blend If's own colour (`composite.rs:230`), the main adjustment-layer path (486), clipped atop a base (656). A spatial kind needs the margin path in all three |
| `compose/src/reduced.rs` proxies | `render_reduced*` (lines 47 to 112), including `render_reduced_in_bands` (80); tiles also come from `render.rs::render_tiled_with_alloc` (50) and bands from `render_bands_with_alloc` (213) |
| `compose/src/cmyk.rs` `ink_adjustment` | line 136 |
| `gpu/src/plan/lower.rs` ColorLookup/Unsupported arm 331 | still line 331 |
| `gpu/src/plan/planner.rs` `check_advanced` 351 | still 351; adjustment refusals also at 791 |
| `algo/src/camera_raw.rs` `develop` 684, `white_balance_gains` 676, `dehaze` 967 | reshaped: `white_balance_gains` 478, `develop` 486 (now takes `DevelopInputs`), `dehaze` 769 (private); Clarity/Dehaze constants moved to `algo/src/camera_raw/spatial.rs` (`Clarity::new`, `Dehaze::new`) |
| `cmd.rs` ADJ 1217 | `cmd.rs:1226` |
| `adjust_editors.rs` `KINDS`, `basic.rs` `sliders` helper line 24 | `KINDS` line 44 (an array of 14: grow it), `AdjustValue` enum (add three variants), `show` (three arms with `AdjustSliders::new(title, &fields, Bind::bound(values))` and Pigment-built `AdjustField::new(key, label, range, default)` tables, as the Exposure arm does); `values.rs` `from_params`/`to_params`/`kind_name` (lines 250, 434, 411). `basic.rs` is gone |
| `menu_catalog.rs` (Image › Adjustments, Layer › New Adjustment Layer) | not needed: the ADJ table's specs carry menu paths and become rows automatically (`menus/items.rs:181` to 186); place them after Selective Color/Color Lookup through `PLACE_AFTER` (`menus/items.rs`) or a Pigment function as `ai_ui::place_after` |
| `properties.rs` `adjustments_grid` line 228 (array of 16) | the framework `AdjustmentsPanel` with `AdjustmentKind::ALL` (`CL/imaging/src/ui/adjust/kinds.rs`, `#[non_exhaustive]`, cannot be extended from Pigment). Add three `craft::ui::buttons::IconButton`s after the grid in `panels/properties/adjustments.rs`, running `layer.newAdjustmentLayer.<kind>` |
| `crates/io/src/adjust_map.rs` + `psd_export` (`pcAd`) | `adjust_map.rs` unchanged; PSD export at `io/src/psd_export.rs:513`/533 (`adjust_map::write`); import at `io/src/psd_import.rs:522`; precedent `io/src/vector_preview.rs:11` (`pcVP`) |
| `legacy_pigment/adjust.rs` (one arm) | the arm is at lines 468 to 475 (`color-vibrance`/`clarity-dehaze`/`grain` → `unsupported`) |
| `presets/adjustments.rs` seven panel presets | A2's file |

### The plan, adjusted
The spec's design stands, with five corrections:
1. **Do not wrap Camera Raw for Clarity and Dehaze.** Camera Raw's are frame-global: Clarity's radius is 2 % of the
   frame's long side (`spatial.rs:104`), and Dehaze measures the atmospheric light on a reduced copy of the whole frame
   (`Dehaze::new`, `spatial.rs:58`). Run per band or tile, they would change with the band size, which breaks the
   spec's own seam test. Port the JS `clarityDehaze` instead (a fixed neighbourhood of about 24 px, white haze, no
   global estimate), so `spatial_margin(scale) = 24 × scale` is exact. Put it in the new compose module below. Reuse only
   local building blocks (a box/guided filter) if they are made `pub`.
2. **compose does not depend on algo** (`crates/compose/Cargo.toml:10` to 16; `xtask layers` would allow L3 → L2, but it
   adds a crate edge). Put the three kernels in a new Pigment-owned `crates/compose/src/adjust_extra.rs`. White balance gains
   is about 8 lines; copy `camera_raw::white_balance_gains` (`camera_raw.rs:478`) with a comment naming its source and a
   test that the two agree. The JS `grainNoise` port goes in the same file.
3. **Three compositor sites**: write `backdrop_with_margin` once. Call it from `composite.rs:486`. For Blend If (230) and
   clipped-atop (656), which get only the `before`/`base` buffer, either use the same margin backdrop or (simpler,
   recorded) evaluate ClarityDehaze without the margin there, with a test showing it matches in the interior. Tiles
   (`render_tiled_with_alloc`) and bands (`render_bands_with_alloc`) both go through `composite`, so one margin path
   covers them. Add a tile-seam test beside the band test.
4. **The interface**: three new `AdjustValue` variants of `values: Vec<f64>` (like Exposure) and three `show` arms; three
   `IconButton`s after the framework grid (icons: the framework has `sun`, `cloud`, `droplet`, `sparkles`; or add Pigment
   SVGs to `assets/icons/` + `icon_data.rs`).
5. **Old documents**: besides the `legacy_pigment/adjust.rs` arm (which now builds the real variants), add one upgrade:
   a document that a Pigment 0.5 session opened and saved (PSD or native) holds `Adjustment::Unsupported { psd_key: "pcJS", raw:
   {"kind": "grain"|…, "params"} }`. On load (in `psd_import.rs`, where an `Unsupported` block is read back at lines 536/635, and wherever the native format
   restores `Unsupported`), turn such blocks into the new variants through the same mapper. Test: a 0.5-saved fixture
   opens as live Grain.

The rest is as the spec says: doc variants and `spatial_margin`; GPU kernels for ColorVibrance and Grain in `lower.rs`, and an
`Unsupported(..)` refusal for ClarityDehaze in `planner.rs` (the stack composites on the CPU while one is visible); CMYK/Lab
treats them as RGB-only (`ink_adjustment`); ADJ rows with the given ranges; `pcAd` PSD block with the empty pixel layer and
the export notice; panel presets (Bright and Warm, Soft Skin, Vivid, Clear Distance, Remove Warm Cast, Vintage Fade, Film
Grain) in A2's `PANEL_PRESETS`.
- **Hooks into upstream files** (list in FORK.md): `doc/src/adjust.rs` (three variants, label, `spatial_margin`),
  `compose/src/ctx.rs` (dispatch), `composite.rs` (the margin call), `reduced.rs` (margin scale), `cmyk.rs` (one match), `gpu/src/plan/lower.rs`
  and `planner.rs` (arms), `cmd.rs` ADJ (three rows), `adjust_params.rs` (`from_params`/`to_params`), `commands::adjustment_kind`,
  `io/src/adjust_map.rs` + `psd_export.rs`/`psd_import.rs` (`pcAd`), `legacy_pigment/adjust.rs` (one arm), `adjust_editors.rs`/`values.rs`
  (variants, arms), `panels/properties/adjustments.rs` (three buttons), `menus/items.rs` (`PLACE_AFTER` or the Pigment place hook).
  Every exhaustive `match` on `Adjustment` in the workspace must get its arm (`grep -rln "Adjustment::Vibrance" crates`:
  doc, engine `adjust_params.rs` and `cmd/adjust_params.rs`, compose, gpu lower, io `adjust_map.rs`, `legacy_pigment/{adjust,filters}.rs`).
- **Tests**: as the spec says (Grain deterministic and position-locked; ClarityDehaze band **and tile** seams ≤ 1/255; ColorVibrance
  warms a grey; GPU fallback in `crates/gpu/tests/it/` (`parity.rs` style); `pcAd` round trip and an ignoring reader sees an
  empty layer; engine commands and actions). Also the `pcJS` upgrade test and the two-copies agreement test for the white-balance
  gains. Run the panic hunt (three new commands), `cargo xtask layers` if any crate edge changes, and `cargo xtask scorecard
  --check`.
- **Effort**: L, 3 days (the spec said 2 to 2.5). The added time is the JS algorithm port in place of the Camera Raw
  wrapper, three compositor sites, and the `pcJS` upgrade.

---

## A7: HDR Toning methods, Match Color statistics, Replace Color preview, solid fill in Properties (rows 9, 18, 19, 20)

### Status of each row
| Row | Now | Evidence |
|---|---|---|
| 9 HDR Toning Method menu and presets | missing | `image.adjustments.hdrToning` (`adjust_cmds.rs:700`) params: radius, strength, gamma, exposure, detail, shadow, highlight, vibrance, saturation, curve, with no `method`; `tone::HdrToning` (`algo/src/tone.rs:197`) has no method; not mapped in `.atn` (`grep hdrToning crates/engine/src/cmd/atn_cmds` is empty) |
| 18 Match Color Save/Load Statistics | missing | `matchColor` params (`adjust_cmds.rs:692`) have no `sourceStatistics`; Match Color rows (`filter_dialog/rows.rs:359`) have Source and Source Layer only |
| 19 Replace Color Selection/Image preview | missing | Replace Color rows (`rows.rs:408`): colour, eyedroppers (#6280), Result swatch (#6278); no thumbnail |
| 20 Properties: solid colour fill swatch | missing | `layer_props_ui.rs::properties` (line 185) draws the gradient for gradient fills (191) and nothing for `Fill::Solid`; the colour is reachable only through Layer Content Options / the thumbnail (`menus/invoke.rs:461`, `solid_fill_ui::open`) |

### Where things are now
| The spec names | Now |
|---|---|
| `algo/src/tone.rs` `HdrToning` 197, `hdr_toning` 257, `lab_stats` 123, `LabStats` 117 | unchanged lines |
| `adjust_cmds.rs` `match_color` 592, hdrToning spec ~700 | `match_color` 592, `hdr_toning` 623, specs 692 (matchColor) and 700 (hdrToning) |
| `filter_dialog.rs` schema dialog, "a `visible_when` hint", Match Color body near line 1375 | the dialogs are framework `HostedParamDialog`s; custom rows in `dialogs/filter_dialog/rows.rs` (`custom_rows` 56, `match_color` 359, `replace_color` 408, `replace_color_sample` 529); Match Color's source bookkeeping in `filter_dialog.rs` (`MATCH_COLOR` 28, `reconcile_match_color` 697, `refresh_match_color_sources` 723). `Param::visible_when` exists in the framework (`param.rs:737`, one value) and `enabled_when_in` (621) |
| `color_range_ui.rs` `preview` 304, `proxy_mask` 223, radio 556 to 560, `pick_top` 646 | Color Range is the framework's `HostedColorRange` (`CL/imaging/src/ui/color_range/`); Pigment's `color_range_ui.rs` (448 lines) now only feeds it: `proxy_mask` 226, `ensure_proxy` 319, `refresh` 354 (`dialog.set_preview(mask, image, k, error)`). The thumbnail is the framework's `PreviewPane` (`craft::ui::patterns::form_dialogs::{PreviewPane, PreviewState, PreviewView}`; used at `CL/imaging/src/ui/color_range/dialog.rs:282`, with `pane.pressed` for picking) |
| `crates/color/src/convert.rs` line 201 white point | PhotoCraft's Lab is D50 (`convert.rs:174` `D50`, Bradford-adapted sRGB, header line 9). Check JS `toLab`; if it is D65, convert the loaded/saved statistics |
| `layer_props_ui.rs` line ~244, `widgets::color_swatch_button`, `color_picker_ui` bound to the layer, `solid_fill_ui.rs:140 app.run(cmds::SET, …)` | `layer_props_ui.rs:185` `properties`; `widgets` deleted, so use `craft::ui::choice::Swatch` (as `rows.rs:484`); the layer's picker with live preview and one OK step is already `solid_fill_ui::open` (line 30) → `confirm` (97, `app.run(cmds::SET, …)` line 112), reached by the command `layer.layerContentOptions` (`menus/invoke.rs:461`) |
| history label "Modify Fill Layer" | upstream's `layer.fill.solidColor.set` records "Solid Color" (`engine/src/cmd/solid_fill_cmds.rs:72`) |
| `atn_cmds/events.rs` `hdrToning` (add `Mthd` if mapped) | not mapped, so nothing to add |

### The plan, adjusted
- **HDR Toning (row 9)**: engine and algo as the spec says (`HdrMethod`, three branches ported from JS hdr.js 287 to
  330, the `method` param). Dialog: an `"image.adjustments.hdrToning"` arm in `rows.rs::custom_rows` that adds the `method`
  choice first and sets `visible_when("method", "localAdaptation")` on radius, strength, detail, shadow, highlight, vibrance,
  saturation, curve, and `enabled_when_in("method", ["localAdaptation", "exposureGamma"])` on exposure and gamma. Use
  `visible_when` with one value each, or one custom row, since the framework's `visible_when` takes a single value.
  Presets: A1's `hdrToning` kind with the 8 JS built-ins (JS `strength` 0..100 → `strength/25`), shown through A2's
  `preset_row` inside a `Param::custom` row; its events go to the pump through a private key.
- **Match Color statistics (row 18)**: engine as the spec says (`sourceStatistics`, `image.adjustments.matchColor.statistics`,
  the JS JSON format). Dialog: in `rows.rs::match_color`, a `Param::custom("__statistics", …)` row with `Button`s "Load
  Statistics…" and "Save Statistics…". The row writes a private field (`__statisticsAsk: "load"|"save"`), and the
  filter dialog's pump (next to `reconcile_match_color`, `filter_dialog.rs:697`) runs `app.pick_file_bytes_filtered(&["json"], …)` or
  the statistics command plus `app.pick_save`. A loaded file adds `("stats", "Statistics: {name}")` to the Source choice
  and stores `sourceStatistics` in a private field that `command_params` maps to the parameter. Keep the Lab check above.
- **Replace Color preview (row 19)**: there is nothing in Pigment to extract any more; the preview widget is the
  framework's `PreviewPane`. Add a `Param::custom("__preview", …)` row in `rows.rs::replace_color` that draws `PreviewPane::state(…)` with
  a `Segmented` Selection/Image control (`craft::ui::choice::Segmented`, as Color Range's dialog). The picture comes from
  `color_range_ui`'s proxy: make `ensure_proxy`/`proxy_mask` `pub(crate)` (or add `color_range_ui::mask_preview(app, params) ->
  (mask, image, k)`). The row is built with `app` (in `custom_rows`), so capture an `Arc<Mutex<PreviewState>>` that the filter
  dialog's pump refreshes from the dialog's params mapped to `select.colorRange` params (`points`, `subtractPoints`, `order`,
  `fuzziness`, `localized`, `range`, `color`). A press on the pane (`pane.pressed`, proxy pixel × k + k/2 as Color Range does)
  calls `replace_color_sample(app, id, at, mods)` (`rows.rs:529`) through the pump, so the thumbnail and the canvas
  share one sampling rule.
- **Solid fill in Properties (row 20)**: small now. In `layer_props_ui::properties` (line 185), for `LayerContent::Fill(Fill::Solid(c))`,
  draw a `Section::new(tl!("Color"))` holding a `Swatch` of the layer colour. A click runs `menus::invoke(app, ctx,
  "layer.layerContentOptions", json!({}))`, which opens the layer's Color Picker with its live preview, Cancel, and one OK
  step (`solid_fill_ui::open` / `confirm`). That satisfies panel-commands. The history label stays upstream's "Solid Color".
  Record that choice; changing it would touch an upstream engine string.
- **Hooks**: `algo/src/tone.rs` (method enum and branches), `adjust_cmds.rs` (two params strings, one new spec,
  `match_color` reading `sourceStatistics`), `filter_dialog/rows.rs` (three arms), `filter_dialog.rs` (the pump's two asks),
  `color_range_ui.rs` (two visibilities), `layer_props_ui.rs` (one branch). List them in FORK.md.
- **Tests**: algo, Equalize Histogram flattens a ramp, Exposure and Gamma +1 doubles linear values, Highlight Compression
  is ≤ 1 and monotonic. Engine: the `method` param round trips through an action, and the statistics save/load equals
  using the document as the source; the JS fixture loads; bad JSON errors. UI (`filter_dialog/tests.rs` harness, e.g.
  `match_color_control` line 579): HDR hides the Local Adaptation rows for Equalize Histogram; Match Color Load adds
  the Statistics source; Replace Color shows a preview texture of the proxy size, and a press on it with Add grows
  `points`; Properties of a solid fill: click the swatch, pick a colour, OK changes the layer in one undo step, Cancel
  changes nothing (as `solid_fill_ui/tests.rs` drives the picker). Run the panic hunt for the new command and `method`.
- **Effort**: M+, 2 days (unchanged). Row 20 shrinks to about 1 hour, and Replace Color grows (the pump and the
  shared preview state).

---

## Order and shared files, adjusted

The order A1 → A2 → A3 → A4 → A5 → A6 → A7 still holds. The shared-file table of PORTS-A §9 now reads:

| Shared file | Edited by (place) |
|---|---|
| `crates/engine/src/presets.rs` | A1 only |
| `crates/engine/src/prefs.rs` (`Preferences` line 1538) | A3 adds `adjustments` with `auto_options`; A4 adds `curves_display` |
| `crates/engine/src/cmd.rs` ADJ (line 1226) | A5 (exposure, hueSaturation, curves, blackWhite strings), A6 (three rows) |
| `crates/engine/src/adjust_params.rs` | A3, A5, A6 as in the spec |
| `crates/ui-egui/src/dialogs/adjust_editors.rs` (`AdjustAsk`, `EditorSetup`, `show` arms, `KINDS`) | A2 (`Preset` ask, preset fields), A3 (levels/curves/B-C arms, `AutoTone`/`PickTarget` asks), A4 (curves arm), A5 (curves/hueSaturation/blackWhite/exposure arms, `ArmOnImage`), A6 (three kinds) |
| `crates/ui-egui/src/dialogs/adjust_dialog.rs` (`shared_editor`, `build_setup`, `answer_asks`, `pick`, `OpenAdjust`) | A2, A3, A5 |
| `crates/ui-egui/src/dialogs/adjust_editors/session.rs` | A2, A3, A5 |
| `crates/ui-egui/src/dialogs/canvas_input.rs`, `canvas/tools/dialog.rs` | A5 only |
| `crates/ui-egui/src/levels_clipping.rs` | A4 only |
| `crates/ui-egui/src/panels/properties/adjustments.rs` | A2 (preset groups, hover), A6 (three buttons) |
| `crates/ui-egui/src/panels/registry.rs` (Properties menu rows) | A2 (Save Adjustment Preset…), A4 (Curves Display Options…) |
| `crates/ui-egui/src/dialogs/filter_dialog/rows.rs`, `filter_dialog.rs` | A7 only (HDR preset row reuses A2's `preset_row`) |
| `crates/io/src/adjust_map.rs`, `encode.rs` | A1 (visibility + `preset_files`), A6 (`pcAd`) |
| `crates/io/src/legacy_pigment/adjust.rs` | A6 (one arm and the `pcJS` upgrade) |
| `crates/compose/src/*` | A6 only (new `adjust_extra.rs` + the hooks) |
| `menu_catalog.rs` | nobody (see "What changed", 6) |

Effort in all: A1 2, A2 1.5, A3 2, A4 1 (plus about 1 in craft-libs if agreed), A5 2.5, A6 3, A7 2, about 14 days
(the spec said about 12). One question goes to the project's owner before A4: whether to propose the Curves display
props to craft-libs.
