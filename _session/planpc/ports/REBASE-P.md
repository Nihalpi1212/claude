# REBASE-P: group P (presets) on Pigment after the 057297b merge

Packages P1a, P1b, P2, P3, P4 of `PORTS-A.md` (sections 3.1 to 3.5 and section 9), re-checked on
Nov 27 against `claude/pigment-photocraft` at `03ccb71` (PhotoCraft `057297b`, craft-libs
`18ffc07`). Read each package's section here beside its spec section. **This file wins where the
two differ.** Where this file says nothing, the spec stands as written, tests included.

Method: every file, type, function and command the five sections name was looked up in
`/home/user/claude/pigment` at `03ccb71`. Upstream's own change was diffed with
`git diff abb30df 057297b` in `/home/user/storytold/photocraft`. The framework was read in
`~/.cargo/git/checkouts/craft-libs-d830b991a08c6c3d/18ffc07`. Upstream's measured documents were
also read: `docs/scorecard.md` and its source `scorecard/ui.toml`, `docs/gaps.md`,
`docs/target-app-parity.md`, `docs/parity-checklist.md` and `docs/file-format-parity.md`. No cargo
was run and nothing in the repository was changed. Paths are relative to `pigment/`.

## 0. What changed for the whole group

**Upstream built none of the five packages.** No row is dropped as a whole.
- **Preset Manager (UI-217-21):** still `partial` in the scorecard (`scorecard/ui.toml:149`). Its
  note is stale: it cites `edit_menu_cmds.rs:714`.
- **`.tpl`:** `file-format-parity.md:140` still says "no", for `.csh` too, but `.csh` now imports
  (`shape.presets.importCsh`).
- **Noise gradients:** only named as oracle work in `target-app-parity.md:330`.
- **Migrate Presets:** listed in `target-app-parity.md:318` among the niche menu items.
- `parity-checklist.md` counts every menu item as live, these included, because each one has a
  command id.

What upstream did change around these packages:

1. **The engine side barely moved.** `edit_menu_cmds/presets.rs`, `migrate_cmds.rs`,
   `presets/tools.rs`, `preset_import_cmds.rs`, `contour_lib_cmds.rs`, `style_asl_cmds.rs` and
   `pattern_cmds.rs` are unchanged apart from line shifts (current lines are given below).
   What did change:
   - **Swatches moved to the framework's model.** `PresetState.swatches` is now
     `Vec<craft::color_ui::palette::SwatchGroup>` (`presets.rs:93`). A group holds `entries` of
     `SwatchEntry { name, color: SwatchColor, kind }`, no longer a `Group<Swatch>` with `items`.
     The defaults come from `craft::color_ui::palette::default_swatches()`.
   - **New lookup helpers** for libraries that are not a `Group<T>`: `presets::find_in`,
     `unique_name_by` and `unique_group` (`presets.rs:315-350`).
   - **`swatches.import` and `swatches.export` also take `gpl`**, and export takes `css`.
   - **The Gradient Editor now commits through `gradient.presets.stop`** with
     `{"action":"set","stops":…,"transparency":…}` (`presets/gradients.rs:397` `STOP`, `:644`).
   - **Placed custom shapes are numbered** ("Heart 1").
2. **Preferences are no longer `preferences.json`.** They live in `config.toml` through
   `craft::settings::SettingsStore<SavedPrefs>` (MERGE-PLAN §5.3, FORK.md "The settings folder and
   Pigment 0.1–0.4").
   - The preset libraries still persist inside it, under the `presets` key: `SavedPrefs`
     serialization in `prefs.rs:1806`, `Session::prefs_value` in `prefs.rs:2010`, and
     `PresetState::to_json` and `load_presets_json` in `presets.rs:157` and `:182`.
   - **TOML has no null.** `SavedPrefs` goes through `strip_nulls`, so any new `Option` field
     must load correctly when its key is missing. Write it with
     `#[serde(default, skip_serializing_if = "Option::is_none")]`.
   - "Saves in `preferences.json` under `presets.…`" in the spec now reads "persists in the
     preferences document under `presets.…`".
3. **The interface is on the framework.** For this group that means:
   - **Preset panels.** Gradients, Patterns, Styles, Shapes and Tool Presets are drawn by
     `craft::ui::patterns::presets::PresetBrowser` in `crates/ui-egui/src/panels/preset_browser.rs`.
     That file is new; `panels/preset_panels/panels.rs` is gone. The shared `show` (`:119`) takes
     these thumbnail painters:
     - `paint_gradient` (`:220`);
     - `paint_pattern` (`:213`) and `pattern_texture` (`:209`);
     - `style_image` (`:291`);
     - `shape_image` (`:449`).

     The browser's events go through `act` (`:619`) and `apply` (`:695`). Per-panel view state
     (`PresetState`: grid or list, zoom) is kept in `app.ui.presets_ui.browsers`, which persists in
     `ui.ron` (`panels/preset_panels.rs:48`).
   - **Panel menus** are `PanelEntry { rows, states, run }` rows in `panels/registry.rs`, built
     from `PresetPanelMenu` and `PresetFiles`. The Styles panel is the model: `registry.rs:181-186`,
     plus `styles_rows`, `styles_states`, `styles_run`, `style_files`, `export_styles` and
     `style_file` in `preset_browser.rs:327-439`. The Swatches panel (`swatches_ui.rs:237-260`)
     shows how an app adds rows of its own, such as Reset.
   - **Dialogs** are `StackDialog`s opened on `app.framework.dialogs`. Their results are read by
     a taker in `dialogs.rs` `TAKERS` (`:455-475`, e.g. `crate::prefs_ui::take_presets`) or a
     `ParamFamily` (`dialogs.rs:95-115`). Form dialogs use
     `craft::ui::patterns::form_dialogs::{HostedParamDialog, ParamDialog, Param, ParamKind}`.
     Prompts use `craft::ui::dialog::StandardPrompt` (example: `tools/tool_reset.rs:46-57`).
   - **File pickers** live on the app (`file_dialog.rs`): `pick_file_bytes_filtered(&exts, …)`
     (`:288`), `pick_save(name, …)` (`:216`) and `ask_folder(…)` (`:196`).
   - **Tests** script the host with `craft::host::ScriptedFiles` (see the tests of
     `preset_files_ui.rs`). They close dialogs with `crate::dialogs::testing::{confirm, cancel}`
     (`dialogs.rs:778`) and drive fields with the control command `ui.dialog.set`. A
     `StackDialog` answers it through `json_fields` and `set_json_field`.
   - **`cargo xtask panel-commands` has an empty allow-list.** Every click handler must dispatch a
     command (`app.run`, `menus::invoke`).
   - **`tl!`** is still `crates/ui-egui/src/lib.rs:25`.
4. **Preset files opened like documents** go through one shell module, `crates/ui-egui/src/preset_files_ui.rs`.
   It was already there at abb30df; the spec did not name it.
   - `PRESET_EXTS` (`:20`) lists `abr grd asl pat aco act ase kys psp`.
   - `open` (`:88`) dispatches by extension. The `.abr` and `.grd` imports first ask about a group
     name that clashes (`preset_group_prompt`).
   - File › Open and drag-and-drop reach it through `is_preset_file` (`file_open.rs:46`,
     `control/dispatch.rs:1364`).
   - **The Preset Manager's Load… should use it**, not a second dispatcher in the engine (P1a
     below).
5. **Integration tests are one binary per crate**: `crates/<crate>/tests/it/main.rs` lists the
   modules. Add each new test file there.
6. **Group A has not been built.** It comes before P in PORTS.md's order, and P depends on it:
   - A1 (adjustment presets) comes before the `adjustments` kind of P1a and P1b and before P4's
     adjustment presets;
   - A3 and A4 come before P4's `settings.json` part.

   If P starts before A lands, leave those parts out and say so in the package's notes.
7. **Group L is built** (`crates/io/src/legacy_pigment/`, L1–L3). P4 and P3 use it. Its mappers
   are all `pub(crate)` and the module exports only `is_legacy`, `import_within`,
   `came_from_legacy`, `SOURCE_FORMAT` and the smart-object renderer (`mod.rs:27-40`, `:74`,
   `:402-458`). The engine cannot call them yet: P4 adds the public entry points.
   - There is no `legacy_pigment/brush.rs` (D5's list included it); P4 writes it.
   - The noise-gradient sampler P3 needs already exists, ported from the JS code in L2:
     `legacy_pigment/gradient.rs` `Mulberry` (`:566`), `noise_sample` (`:583`) and the `Noise`
     struct (`:64`), with tests (`:727` `stripes_and_noise`, `:744`
     `mulberry32_gives_the_apps_sequence`).

---

## P1a: Preset Manager for every kind (rows 21, 23)

### Status of the rows now

| Row | Now | Evidence |
|---|---|---|
| 21, 23: one Preset Manager for every kind | **partly done** (upstream made it a framework dialog; still 3 of 9 kinds) | **Engine.** `edit.presets.presetManager` (`crates/engine/src/cmd/edit_menu_cmds.rs:438`, params `list\|rename\|delete\|move`). `PRESET_KINDS = ["brushes","customShapes","patterns"]` (`edit_menu_cmds/presets.rs:67`), and `customShapes` there still reads only `edit_state.custom_shapes` (`:72`). **UI.** `crates/ui-egui/src/prefs/prefs_ui/presets.rs`, new upstream: the framework's `HostedPresetManager<String, usize>` (`:13`, `open_manager` `:46`, `take_manager` `:92`) with three kinds (`kinds()` `:20`). It shows a **list only** (the framework's `PresetManager` locks `PresetView::List`) with Rename and Delete; Load… appears for Brushes only and opens File › Open (`:29`, `:117`). **Missing:** swatches, gradients, styles, contours, tools and adjustments; thumbnails and the five views; multi-select; Save Set…; Reset and Replace; Load… for the other kinds; `gradient.presets.exportGrd`. Scorecard UI-217-21 `partial`. |

Nothing is dropped. The Shapes "two libraries" problem is half solved upstream:
`presets::shapes::all_groups` (`presets/shapes.rs:287`) shows the Define Custom Shape results as a
`Custom Shapes` group (`CUSTOM_GROUP`, `:26`) in the Shapes panel and the Custom Shape picker.
`shape.presets.edit` (`:439`) renames and deletes them in `edit_state.custom_shapes`. **One
library is therefore already what the user sees, except in the Preset Manager.**

### Where things are now

| Spec names | Now |
|---|---|
| `edit_menu_cmds.rs` line 424 `edit.presets.presetManager` | `edit_menu_cmds.rs:438` (spec), `preset_manager` in `edit_menu_cmds/presets.rs:87` |
| `edit_menu_cmds/presets.rs` `PRESET_KINDS` line 66 | `:67` |
| `crates/ui-egui/src/prefs/prefs_ui/dialogs.rs` lines 240–275 (the text list) | **gone.** `prefs_ui/dialogs.rs:78` routes the menu item to `super::presets::open_manager`, the framework manager in `prefs_ui/presets.rs`. Its results are read by `take` (`:85`), registered as `crate::prefs_ui::take_presets` (`prefs_ui.rs:67`, `dialogs.rs:467`) |
| `crates/ui-egui/src/panels/preset_panels.rs` `paint_gradient` line 210 | moved: `panels/preset_browser.rs:220` (private) |
| brush, swatch, style, pattern, shape painters in `preset_panels/panels.rs` | `preset_panels/panels.rs` is **gone**. Painters in `preset_browser.rs`: `paint_pattern` `:213`, `pattern_texture` `:209` (pub(crate)), `style_image` `:291` (pub(crate)), `shape_image` `:449` (pub(crate)), `paint_gradient` `:220`. Brushes: `panels/brush_panel` and `panels/brush_preview.rs`. Swatches: `panels/swatches_ui.rs`, drawn with `craft::ui::choice::Swatch` / `SwatchTable` |
| `edit_menu_cmds::custom_shapes()`, `define_custom_shape` | `edit_menu_cmds.rs:459`, `edit_menu_cmds/presets.rs:46` (unchanged) |
| `brush.presets.*`, `brush.presets.importAbr` | `brush.presets.{rename,move,moveGroup,renameGroup,deleteGroup}` (`cmd/brush_preset_cmds.rs`), `importAbr` and `importImage` (`preset_import_cmds.rs:286`, `:296`). No `brush.presets.reset` |
| `swatches.*`, `swatches.import`/`export` (swatch_cmds.rs line 869) | `cmd/swatch_cmds.rs:565-705`: `import` (aco, act, ase, gpl; `mode: append\|replace`) and `export` (aco, act, ase, gpl, css; `group`, `swatches: [names]`), plus `reset`. The model is craft's `SwatchGroup` (§0.1) |
| `gradient.presets.*`, `importGrd` | `presets/gradients.rs:712-776` (list, apply, new, edit, reset), `stop` `:397`/`:644`, `importGrd` `preset_import_cmds.rs:306`, `import_grd` `:369` |
| `style.presets.*`, `importAsl`/`exportAsl` | `presets/styles.rs:362-402`, `cmd/style_asl_cmds.rs:33-34` (`importAsl` takes `replace: bool = true`; `exportAsl` takes `group` and `styles: [names]`) |
| `pattern.presets.*`, `pattern.import`/`export` (line 590) | `presets/patterns.rs:180-220` (list, select, apply, new, edit), `cmd/pattern_cmds.rs:590`, `:600` (`export` takes `patterns: [id\|name]`). No pattern reset |
| `layer.layerStyle.contours.*` (line 180–220) | `cmd/contour_lib_cmds.rs:180-220` (unchanged; `load` takes `mode: append\|replace`, `save` takes `names`). No reset |
| `shape.presets.*`, `importCsh` | `presets/shapes.rs:485-525`, `presets/shapes/csh.rs:10` |
| `tool.presets.*` | `presets/tools.rs:205-245` (unchanged) |
| `GROUP_EDIT_PARAMS` (not in the spec) | `presets.rs:449`: every `*.presets.edit` already takes `"preset": [names]`, so multi-delete is one call per kind |
| `craft_psd::grd::write` (grd.rs line 188) | unchanged at craft-libs `18ffc07` (`crates/psd/src/grd.rs:188`, `GrdGradient` `:50`) |
| `preset_import_cmds.rs` test builders (.abr/.grd in code) | still there (`preset_import_cmds.rs:462` onwards: `write_v12`, `write_v6`) |
| `file_dialog` tests | the host is scripted with `craft::host::ScriptedFiles` (tests at the end of `preset_files_ui.rs`) |
| `ui.ron` per-kind view | `app.ui.presets_ui.browsers` (`panels/preset_panels.rs:48`), persisted. Key the manager's states `"presetManager.<kind>"` |

### The plan, adjusted

**Engine** (`crates/engine/src/cmd/edit_menu_cmds/presets.rs`, as in the spec):

1. **Kinds.** `PRESET_KINDS` lists the nine kinds of the spec. `adjustments` is present only once
   A1 has landed.
2. **`customShapes` lists `presets::shapes::all_groups(s)`** rather than
   `edit_state.custom_shapes` alone: the panel's groups, with the Define Custom Shape results as
   the `Custom Shapes` group. Rename, delete and move go through `shape.presets.edit`, which already
   finds the custom ones.
   - **Drop the spec's storage merge** of `edit_state.custom_shapes` into `s.presets.shapes`.
     Upstream's view-level merge gives the user one library, and moving the storage would touch
     the PSD/ATN paths that read `custom_shapes`.
   - Keep the spec's test in this form: after `edit.defineCustomShape`, the manager's
     `customShapes` list contains the new shape exactly once.
3. **The `Library` trait** stays as specified: each kind delegates to its own commands. Group
   kinds (gradients, styles, shapes, patterns, brushes, swatches) return `(group, name)` rows;
   contours and tools are flat. Swatches use `find_in` over `SwatchGroup.entries`.
4. **List and edit actions.** `list` gains the `group` and `thumb` hints. `delete` takes
   `"indices":[…]`, as the spec says, and calls each kind's edit command once with
   `"preset":[names]`.
5. **`load {"kind","path"|"data","replace":bool=false}`.** It dispatches by extension, as the spec
   says, to these per-kind commands:

   | Extension | Command | Replace |
   |---|---|---|
   | `.abr` | `brush.presets.importAbr` | |
   | `.aco`, `.act`, `.ase`, `.gpl` | `swatches.import` | `mode:"replace"` |
   | `.grd` | `gradient.presets.importGrd` | |
   | `.asl` | `style.presets.importAsl` | `replace` |
   | `.pat` | `pattern.import` | |
   | `.shc` | `layer.layerStyle.contours.load` | `mode` |
   | `.csh` | `shape.presets.importCsh` | |
   | `.tpl` | `tool.presets.importTpl` (P2) | |
   | `.alv`, `.acv`, … | `adjustment.presets.load` (A1) | |
   | `.pcpresets` | `edit.presets.exportImportPresets` import | |

   For kinds whose import has no replace, Replace… first runs the kind's reset (or delete-all),
   then the load, under one history entry.
6. **`saveSet {"kind","indices","path"?}`** follows the spec's per-kind table.
   - Without `path`, it returns base64 `data` (the convention of `swatches.export`, `exportAsl`
     and `contours.save`), so the shell can write through `pick_save`.
   - Brushes and custom shapes still write `.pcpresets`. There is still no `BrushSettings` →
     descriptor encoder, and craft-psd still has no `.csh` writer: `craft_psd::csh` only has
     `parse`.
7. **`reset {"kind"}`.** It calls each kind's reset command where one exists: `swatches.reset`,
   `gradient.presets.reset`, `style.presets.reset`, `shape.presets.reset` and
   `tool.presets.reset`. Brushes, patterns and contours have no reset command: `list` reports
   `"canReset": false` for them, and the UI greys the item. Do not invent resets.
8. **New `gradient.presets.exportGrd`** in `presets/gradients.rs`, as in the spec. Register it in
   `specs()` and add a panic-hunt entry (rule 9).

**UI.** The Pigment dialog is a new file, **`crates/ui-egui/src/dialogs/preset_manager_ui.rs`**
(the spec's name and place). It is a `StackDialog` of its own on `app.framework.dialogs`, because
the framework's `PresetManager` fixes the list view and has no thumbnails, view menu or reorder.
Build its body from the same framework pieces upstream's preset panels use:

1. **Kind and body.** A `craft::ui::pickers::Select` of the kinds sits above a
   `craft::ui::patterns::presets::PresetBrowser`. The pattern to copy is
   `panels/preset_browser.rs` `show` (`:119`).
   - Pass `.thumb(…)` with the painters listed above. Make the private `paint_gradient` and
     `paint_pattern` `pub(crate)`: that is a one-word hook in an upstream file.
   - Pass `.reorder(PresetReorder::items_and_groups())` for drag to reorder (the `move` action),
     `.row_menu(true)` for Rename and Delete, and `.footer(PresetFooterOptions::new().can_delete(..))`.
2. **The five views.** They map onto `PresetState { view, zoom }`:

   | Photoshop view | `PresetState` |
   |---|---|
   | Large Thumbnail | `Grid`, zoom ≥ 1.5 |
   | Small Thumbnail | `Grid`, zoom ≤ 0.75 |
   | Large List | `List`, zoom ≥ 1.5 |
   | Small List | `List`, zoom ≤ 0.75 |
   | Text Only | `List` with no thumbnail painter |

   The list's thumbnail size follows the zoom (`LARGE_FROM`, `SMALL_UNTIL` in craft's
   `browser.rs`). The view menu is a `craft::ui::menu::Menu` on a ⚙ `Button`. Keep each kind's
   state in `app.ui.presets_ui.browsers["presetManager.<kind>"]` so it persists in `ui.ron`.
3. **Multi-select.** The framework's `PresetBrowser` is `SelectMode::Single` (craft `browser.rs`
   lines 694 and 756). Keep the browser's single selection and add Pigment's own selection set in
   the dialog:
   - Shift-click (range in display order) and Cmd/Ctrl-click (toggle) on
     `PresetEvent::Select { mods }` change the set.
   - The thumbnail painter draws a selection ring for members, since it knows the set.
   - In Text Only, members get a `PresetRow::caption`.
   - Delete and Save Set… act on the set.

   The cleaner fix would be a framework change, `PresetBrowser::select_mode(Multi)`. Note it in
   the package notes as an upstream request; do not fork craft.
4. **Footer and ⚙ menu.**
   - The footer buttons are the dialog's `FooterButton`s, as `craft` `manager.rs` does: Load…,
     Save Set…, Rename…, Delete and Done.
   - The ⚙ menu holds Reset {kind}…, Replace {kind}… and the views. Reset and Replace confirm with
     `StandardPrompt` and its i18n strings (pattern: `tools/tool_reset.rs:46`).
5. **File handling.** Load… and Replace… use `app.pick_file_bytes_filtered(exts, …)` with the
   kind's extensions, then run the engine's `load`.
   - For the extensions the shell already imports, call `crate::preset_files_ui::open`, so the
     group-name clash prompt (`preset_group_prompt`) and the status line behave as File › Open
     does.
   - Add `.shc`, `.csh`, `.tpl` (P2) and the adjustment extensions (A1) to
     `preset_files_ui::PRESET_EXTS` and to `open`. File › Open and drag-and-drop then take them
     too, which is Photoshop's behaviour. This is a small hook in an upstream file: list it in
     FORK.md.
   - Save Set… runs `saveSet` and writes the bytes with `app.pick_save`.
6. **Routing.** Change the menu route in `prefs_ui/dialogs.rs:78` to Pigment's
   `preset_manager_ui::open` (one-line hook).
   - Add `preset_manager_ui::take` to `dialogs.rs` `TAKERS` beside `take_presets`.
   - Leave upstream's `open_manager` and `take_manager` in place but unused. Do not delete them:
     upstream merges stay easy. Point `prefs_ui/tests.rs:1520` `edit_dialogs_open` at the new
     opener, or keep it on upstream's.
7. **Agent fields.** Implement `json_fields` (`kind`, `view`, `rows`, `selected`) and
   `set_json_field` (`kind`, `view`, `selected`) so agents and tests can drive the dialog with
   `ui.dialog.set`.

i18n: as in the spec. Many of the words exist already (`Load…`, `Rename…`, `Delete`, `Done` in
craft's `PresetWords`); use `tl!` for Pigment's own.

Docs:
- `scorecard/ui.toml:149` UI-217-21: change the status to `done` once everything lands, with a
  correct note, and run `cargo xtask scorecard`.
- `docs/file-format-parity.md:140`: `.csh` reads now.

### Tests (intent unchanged)

- **engine** (`edit_menu_cmds/tests.rs`, or a new `preset_manager_tests.rs` beside it):
  - `list` covers all nine kinds (eight until A1 lands);
  - `load` dispatches each extension, using the builders in the `preset_import_cmds.rs` tests and
    `crates/engine/tests/common/csh_fixture.rs`;
  - `saveSet` writes a file that loads back with the same names (.aco, .asl, .pat, .shc, .grd);
  - a multi-delete through `indices` removes exactly those presets;
  - `customShapes` lists a defined custom shape exactly once;
  - `reset` of a kind without a reset command errors cleanly;
  - `exportGrd` round-trips through `importGrd`.
- **ui** (`dialogs/preset_manager_ui.rs` `#[cfg(test)]`, or `crates/ui-egui/tests/it/preset_manager.rs`
  added to `tests/it/main.rs`):
  - the dialog opens from the menu and lists swatches with thumbnails (`json_fields` rows);
  - Cmd-selecting two presets and pressing Delete removes both;
  - Save Set… writes the file through `ScriptedFiles`;
  - `ui.dialog.set` of `kind` switches the rows;
  - the view is remembered per kind.
- Run `cargo xtask panel-commands`, the panel commands check.

### Effort

**L, 1.5 to 2 days** (was L, 2 days). The framework's browser, the painters and the shell's file
dispatch save about half a day; multi-select on top of a single-select browser costs some of that
back.

---

## P1b: Export/Import Presets (row 22, first half)

### Status of the row now

| Row | Now | Evidence |
|---|---|---|
| 22 (first half): Export/Import Presets | **partly done** (as on Nov 15) | `edit.presets.exportImportPresets` (`edit_menu_cmds.rs:447`, `export_import` `:243`) writes and reads `.pcpresets`. Its `PresetFile` (`edit_menu_cmds/presets.rs:142`, `PRESET_FORMAT` `:150`) holds brushes, `custom_shapes` and `tool_presets` only. Import replaces a tool preset of the same name and tool, and it validates before changing anything. **UI** (new upstream): a framework parameter dialog, `prefs_ui/presets.rs` `io_params` (`:54`), `open_io` (`:71`), `PRESETS_FAMILY` (`:90`), `confirm_io` (`:134`). It shows an Export or Import radio and three check boxes; Import opens `pick_file_bytes`, Export opens `pick_save("Presets.pcpresets")`. **Missing:** swatches, gradients, styles, patterns, contours, adjustments and the unified shapes; duplicate-skipping import; `.pigment-bundle`. |

Nothing is dropped.

### Where things are now

| Spec names | Now |
|---|---|
| `edit_menu_cmds.rs` line 433, `export_import` line 229 | `:447`, `:243` |
| `PresetFile` (presets.rs line 140) | `edit_menu_cmds/presets.rs:142` (unchanged) |
| `craft_psd::patterns::write_pattern_block` line 588 | still exported by craft-psd `18ffc07` (`abr.rs` imports it from `crate::patterns`) |
| `migrate_cmds::merge_groups` | `cmd/migrate_cmds.rs:11` (private; make it `pub(crate)` or move it to `presets.rs`) |
| `crates/ui-egui/src/dialogs/export_import_presets_ui.rs` (new) | **not needed.** Upstream's dialog is the framework's `ParamDialog` in `prefs_ui/presets.rs`, and the spec's dialog (check boxes per kind, Export…, Import…) is that dialog with more rows |
| swatches | `Vec<SwatchGroup>` (§0.1). Serialize the framework type as it is (it is `Serialize`/`Deserialize`); do not invent a `{name,color}` shape |

### The plan, adjusted

1. **Engine, the `PresetFile` fields.** Add these, all `#[serde(default)]`, as in D4:
   - `swatches: Vec<SwatchGroup>`;
   - `gradients: Vec<Group<GradientPreset>>`;
   - `styles: Vec<Group<StylePreset>>`;
   - `patterns`: entries of `{id, name, data: base64 .pat block}`, with `pattern_groups`;
   - `contours: Vec<Contour>`;
   - `shapes: Vec<Group<ShapePreset>>`: the `all_groups` view, whose `Custom Shapes` group goes
     back to `edit_state.custom_shapes` on import;
   - `adjustments`, once A1 lands.

   Keep `custom_shapes` as it is, so that files written by upstream and by Pigment 0.5 still load.
2. **The `kinds` param.** It takes the nine ids, and the default stays the old three. Import
   appends groups by name and skips a preset whose kind, name and data already exist, so
   importing twice adds nothing.
   - Swatches use `presets::find_in` and `unique_group`.
   - The tool-preset branch keeps upstream's "replace same name+tool" rule: it is upstream's
     behaviour and agents rely on it.
3. **`.pigment-bundle` import.** Accept it: `bundle.json` plus `blobs/`, read with
   `photocraft_format::zip` (the engine already uses `photocraft_format::zip::ZipWriter`, as in
   `legacy_pigment_render.rs:60`). Map the bundle's kinds through P4's mappers, so **this part
   belongs to P4**. P1b only leaves the hook: `import` recognises a ZIP and calls
   `migrate_cmds::import_bundle` once P4 adds it, and refuses such a file until then.
4. **UI** (`prefs_ui/presets.rs`, upstream's file; a bounded edit, so list it in FORK.md):
   - extend `io_params` and the `open_io` fields with the new kinds' check boxes;
   - extend the kind list in `confirm_io`;
   - let Import filter `pcpresets` and `pigment-bundle` (`pick_file_bytes_filtered`).

   This stays one framework parameter dialog. Photoshop's two moving lists are not worth a custom
   dialog; record that choice in the notes.

### Tests (intent unchanged)

- Export every kind, import into a fresh `Session`, and check that every library is equal
  (patterns compared by pixels).
- Importing twice is idempotent.
- An old three-kind `.pcpresets`, as written by upstream at `057297b`, still imports.
- A `.pcpresets` with swatches in the old `items` shape fails cleanly, or loads through
  `swatches::upgrade_saved` (`presets/swatches.rs:26`); choose and test.
- **ui:** the dialog lists the nine boxes. Export with `ScriptedFiles` writes a file; Import of
  that file restores a deleted gradient.

### Effort

**M, about 1 day** (unchanged). The UI is smaller; the swatch model and the bundle hook take the
time saved.

---

## P2: `.tpl` tool presets (rows 24, 25)

### Status of the rows now

| Row | Now | Evidence |
|---|---|---|
| 24: Tool Presets `.tpl` import and export | **missing** | No `tpl` code anywhere (`grep -rn tpl crates` finds none); `file-format-parity.md:140` says ".tpl … no". |
| 25: load, save, replace and reset in the Tool Presets panel | **partly done** | **Engine** `tool.presets.list\|new\|select\|edit\|reset` (`presets/tools.rs:205-245`; `reset` restores the built-ins, `:196`). **Panel** on the framework: `tool_presets_panel` (`panels/preset_browser.rs:565`), a `PresetBrowser` list with tool icons, Current Tool Only in its footer and a + button that stores the tool's own options (`preset_panels/tool_presets.rs` `new_params`). Applying a preset is `preset_panels/tool_presets.rs` `select`. **No panel menu**: `registry.rs:188` registers `toolPresets` with no rows. Reset Tool and Reset All Tools: `tools/tool_reset.rs` (`tool.reset`, `tool.resetAll` with a confirmation prompt), on the options bar's tool icon (`panels/options_bar.rs:183-200`). **Missing:** Load…, Save…, Replace…, Reset Tool Presets… in the panel menu, and `.tpl`. |

Dropped part: **the options-bar tool preset picker.** PhotoCraft has none. The options bar's left
end is the tool icon, whose context menu holds Reset Tool and Reset All Tools; the old
`panels/options_bar.rs` line 102–109 the spec cited is now `:183-200`. Building a picker is a new
control outside this row's scope, and Window › Tool Presets carries the same commands. Record it
as a follow-up.

### Where things are now

| Spec names | Now |
|---|---|
| `crates/engine/src/presets/tools.rs` line 205–245, `ToolPreset { name, tool, options }` | unchanged (`:19`, `MAX_PRESETS = 1000` `:37`, `load` (lenient) used by migrate) |
| `crates/ui-egui/src/panels/preset_panels/panels.rs` `tool_presets_panel` line 462 | **moved:** `panels/preset_browser.rs:565`; selection logic in `panels/preset_panels/tool_presets.rs` (new upstream) |
| `preset_panels::menu` (line 152) | **gone.** Panel menus are `PanelEntry { rows, states, run }` in `panels/registry.rs` built from `PresetPanelMenu` + `PresetFiles`; the model is Styles (`registry.rs:181-186`, `preset_browser.rs:327-439`) |
| `crates/io/src/abr_map.rs` `Mapper::preset` line 352 (private) | unchanged: `struct Mapper` `:254`, `fn preset` `:352`, public `read_abr` `:36`, `map_file` `:52` |
| `crates/ui-egui/src/state/tool.rs` (tool names) | still there; `Tool::from_name` `:322`. `preset_panels/tool_presets.rs` `tool_id` gives the engine's spelling |
| `crates/ui-egui/src/panels/options_bar.rs` line 102–109, `tool_memory.rs` | Reset Tool and Reset All Tools: `options_bar.rs:183-200` → `tools/tool_reset.rs`; `tool_memory.rs` still holds remembered options |
| `preset_import_cmds::add_abr_presets` line 153 | unchanged (`:153`); `file_bytes` `:36` |
| `craft_psd::abr` section walker, `write_v6` sample writer | craft-psd `18ffc07` `abr.rs`: `parse` `:495`, `write_v6` `:588`, `write_v6_folders` `:637`. The `8BIM` section walk is internal to `parse`, which expects an ABR header, so it cannot read an `8BTP` file: **port JS `sections`/`readSamples`** as the spec's fallback says. `write_v6` writes a whole ABR. Either write the `samp` section with your own few lines in the same layout, or call `write_v6` and copy its `samp` section out |
| `craft_psd::descriptor` | unchanged (`crates/psd/src/descriptor.rs`) |

### The plan, adjusted

1. **io.** `crates/io/src/tpl_map.rs`, as specified, exported from `crates/io/src/lib.rs` as
   `pub mod tpl_map` (beside `pub mod abr_map`, `lib.rs:37`).
   - Add `pub fn brush_from_descriptor` to `abr_map.rs`. It wraps `Mapper::preset`: a few lines
     in an upstream file, so list it in FORK.md.
   - Port the tool-class table from JS against `Tool` (`state/tool.rs`) and `tool_id`. The io
     crate cannot see the shell, so keep the table as a static of tool-name strings in io and test
     it against `Tool::from_name` in a ui-egui test.
2. **Engine.** `tool.presets.importTpl` and `tool.presets.exportTpl` in `presets/tools.rs`, as
   specified.
   - Imported brush tips go to the brush preset store as `.abr` tips do (`add_abr_presets`).
   - Option keys go under `options.toolOptions` with the shell's keys, which the shell upgrades
     with `tool_memory::upgrade` when applied (`preset_panels/tool_presets.rs` `select`).
   - Add both commands to the panic hunt.
3. **UI.** A Tool Presets panel menu on the framework:
   - `tool_presets_rows`, `tool_presets_states` and `tool_presets_run` in
     `panels/preset_browser.rs` (or a Pigment file `panels/preset_panels/tool_presets_menu.rs`,
     which is preferable), copying the Styles trio;
   - `PresetFiles::new("tool presets", tl!("Tool Presets"), &["tpl"]).replace(true)` gives Load…,
     Replace… and Save…;
   - the app adds Reset Tool Presets… (confirmed by `StandardPrompt`, running
     `tool.presets.reset`);
   - hook: `rows`, `states` and `run` on the `toolPresets` entry in `registry.rs:188` (one line
     becomes a `PanelEntry { .. }`).

   Replace… asks "Replace current tool presets with the presets from {file}?" first. Also route
   `.tpl` through `preset_files_ui` (`PRESET_EXTS` and `open`) so File › Open and drag-and-drop
   load tool presets; P1a's Load… uses the same path.
4. **Docs.** `docs/file-format-parity.md:140` gets ".tpl read and write"; FORK.md gets the hooks.

### Tests (intent unchanged)

- **io:** a write → read round trip keeps names, tools, options and brush size and hardness.
- **io:** a JS-written `.tpl` fixture is committed as bytes under
  `crates/io/tests/fixtures/pigment-0.4/`, made by node with JS 0.5 `writeTplFile` from
  `origin/claude/fervent-newton-263lz3-wip05:pigment/src/renderer/lib/preset-files/tpl.js` (the ref
  exists; node 22 is at `/opt/node22/bin/node`; the generator scripts of group L are in
  `$SCR/fixgen`). It reads with its `pigmentData`.
- **io:** with `pigmentData` stripped, the Photoshop keys map; truncated files error.
- **engine:** `importTpl` adds presets, `replace` replaces, and `exportTpl` writes what `importTpl`
  reads back.
- **ui:** the tool-class table resolves through `Tool::from_name`. The Tool Presets panel menu
  lists Load…, Replace…, Save… and Reset Tool Presets…, and Save… writes a file through
  `ScriptedFiles`.
- Run `cargo xtask panel-commands`.

### Effort

**L, 1.5 to 2 days** (unchanged).

---

## P3: Noise gradients (row 26)

### Status of the row now

| Row | Now | Evidence |
|---|---|---|
| 26: noise gradients | **missing** (two small pieces exist) | **Upstream:** the PSD reader turns the "constant-RGB" subset of noise gradient fills (every channel's min equal to its max) into one exact colour, and otherwise keeps a black-to-white placeholder plus the raw `GdFl` block for a byte-exact round trip (#6272) (`crates/io/src/blocks.rs:321` `constant_rgb_noise_color`, used at `:474-485`). `.grd` import still skips noise gradients (`preset_import_cmds.rs:416` "noise gradients are not supported and were skipped", `:422`). The `grdm` reader leaves them unsupported (`adjust_map.rs:292`). No document or engine type knows noise. **Pigment (L2):** the `.pigment` importer already reproduces JS `noiseKnots` exactly and bakes it into 128 samples plus edges (`legacy_pigment/gradient.rs:64` `Noise`, `:566` `Mulberry`, `:583` `noise_sample`, `:383` `stops_and_opacity`), so old documents look right but lose their noise settings. |

Nothing is dropped.

### Where things are now

| Spec names | Now |
|---|---|
| `preset_import_cmds.rs` line 416 | `:416` (unchanged), `import_grd` `:369` |
| `craft_psd::grd::GrdGradient` `noise: bool` (line 50) | unchanged at `18ffc07` (`grd.rs:50`, `write` `:188`) |
| `presets::gradients::GradientPreset {name, stops, opacity}` | `presets/gradients.rs:26` (unchanged); new `STOP` command `gradient.presets.stop` (`:397`) with `set` (`:529`), which is how the Gradient Editor commits |
| `Fill::Gradient` (`crates/doc/src/lib.rs` line 335) | `:335` (unchanged) |
| `GradientSource` (`crates/doc/src/adjust.rs`) | `adjust.rs:201`; `Adjustment::GradientMap { stops, reverse, dither, source }` `:310` |
| Gradient Overlay effect gradient (`crates/doc/src/effects.rs`) | `effects::Gradient` `:30`, `GradientInterpolation` `:48`, `Effect::GradientOverlay` `:291` |
| `crates/io/src/blocks.rs` gradient descriptors for `GdFl` | read `:465-500`, write `gradient_desc_with` `:386` (writes `GrdF = CstS`, `:419`) |
| `crates/io/src/effects_map` for `GrFl` | `effects_map.rs` `gradient_from` `:186` (read), `gradient_keys` `:399` (write; Gradient Overlay `:486`, stroke fill `:469`) |
| `adjust_map.rs` `parse_gradient_map` / `write_grdm` | `:293` / `:386` (bakes through `crate::gradient_bake`, an upstream module that predates abb30df) |
| `crates/ui-egui/src/tools/gradient_ui.rs` + "the editor dialog it opens" | **reshaped.** The Gradient Editor is a floating **panel** (`gradientEditor`, `registry.rs`, last rows) whose body is `tools/gradient_ui/editor.rs` `show`. With a gradient fill layer selected it shows `gradient_ui/properties_panel.rs`. Its stop bar is the framework's `craft::color_ui::ui::gradient::GradientEditor` (`editor.rs:6`), which has no noise mode. Stops helpers: `gradient_ui/stops.rs`. The shapes' Gradient tab: `tools/shape_gradient_ui.rs` |
| `legacy_pigment/gradient.rs` (one arm) | exists (L2); see above |

### The plan, adjusted

1. **doc** (`crates/doc/src/noise_gradient.rs`, new). Write `NoiseGradient` and `bake` as
   specified. **Move L2's sampler there rather than porting it again**: `Mulberry`,
   `noise_sample`, `hsv_to_rgb` and `lab_to_rgb` from `legacy_pigment/gradient.rs`.
   - `legacy_pigment::gradient::Noise` becomes a thin parse into `photocraft_doc::NoiseGradient`.
   - The JS model has three min/max channels plus an alpha walk; keep the spec's `[f32; 4]` with
     alpha last, and default the alpha range to 0..1.
   - L2's tests (`mulberry32_gives_the_apps_sequence` and the seeds) move with the code, so the
     "matches JS for 3 seeds" test exists from the start.
2. **Fields.** Add `#[serde(default, skip_serializing_if = "Option::is_none")] noise:
   Option<NoiseGradient>` to:
   - `Fill::Gradient`;
   - `GradientSource`;
   - `effects::Gradient`, which Gradient Overlay and the stroke's gradient paint use;
   - `GradientPreset`, and with it `PresetState.gradient`.

   The baked stops stay what renders. `skip_serializing_if` matters because the presets persist in
   TOML (§0.2) and `.pcraft` must stay unchanged for gradients without noise.
3. **PSD.**
   - **Read.** Parse the `ClNs` keys in `blocks.rs` (where `constant_rgb_noise_color` is today;
     keep it as the fast path, or replace it by the bake, since a constant noise gradient bakes to
     one colour anyway), in `effects_map.rs` `gradient_from` and in `adjust_map.rs`
     `parse_gradient_map`.
   - **Write.** `gradient_desc_with` and `gradient_keys` write `GrdF = ClNs` and the noise keys
     when `noise` is set. `write_grdm` writes the grdm noise fields.
   - **Keep upstream's raw-`GdFl` round trip** (#6272) for files whose noise parameters fail to
     parse.
   - These are hooks in upstream io files: keep each one small and list it in FORK.md.
4. **GRD.** Keep the spec's own reader of the noise fields, `crates/io/src/grd_noise.rs` over
   `craft_psd::descriptor`. In `import_grd` (`:369`), stop skipping noise gradients. P1a's
   `exportGrd` writes them.
5. **Engine.** These commands accept the spec's `"noise":{…}`:
   - `gradient.presets.new`, `edit` and `stop {"action":"set"}`. `set` is upstream's new editor
     commit path: carry `noise` through `GradientPreset::from_params` (`gradients.rs:144`).
   - The gradient fill and layer commands that take stops.
   - The gradient tool's `paint.gradient`.

   Add `paint.gradient` and the fill commands to the panic hunt with adversarial noise values.
6. **UI.** Noise controls Pigment draws itself, next to the framework's stop bar. The framework
   `GradientEditor` has no noise mode, so do not patch craft.
   - Put them in `tools/gradient_ui/noise.rs` (new, Pigment's file), with these widgets:
     - Gradient Type: `craft::ui::choice::Segmented` with Solid and Noise;
     - Roughness: `craft::ui::form::SliderField` (example: `panels/mask_props_ui.rs:7`, `:75`);
     - Color Model: `craft::ui::pickers::Select`;
     - each channel's min and max: `craft::ui::value_drag::RangeSlider`, with a gradient
       `TrackFace` if it takes one, else a plain track and a `paint_gradient` strip above;
     - Restrict Colors and Add Transparency: `craft::ui::choice::Checkbox`;
     - Randomize: `craft::ui::buttons::Button`, which picks a new seed.
   - Show them in `gradient_ui/editor.rs` `show` (the tool gradient) and in
     `gradient_ui/properties_panel.rs` (a gradient fill layer). When Noise is on, hide the stop
     bar.
   - Every change commits through the commands above (`gradient.presets.stop` `set` for the
     tool's gradient, and the layer's fill command for a fill layer), so it is undoable and passes
     `xtask panel-commands`.
   - The Gradient Overlay's gradient picker in the Layer Style dialog shows a noise preset through
     its baked stops; editing noise there is out of scope (the spec did not ask for it).
7. **L2's arms.** `legacy_pigment/{paint,styles,adjust}.rs` keep the dense samples for rendering
   and also set `noise: Some(..)`, so a JS noise gradient opens editable.

### Tests (intent unchanged)

- **doc:** `bake` is deterministic per seed and equals JS `noiseKnots` for three seeds; reuse the
  constants already in L2's tests and add two seeds generated with node. min = max gives a flat
  gradient; `restrict` keeps saturation ≤ 0.85.
- **io:** a PSD round trip of a noise gradient fill, of a noise Gradient Map and of a noise
  Gradient Overlay keeps every noise key. A file whose noise fails to parse still round-trips its
  raw `GdFl` (upstream's #6272 test must stay green). A GRD with a noise gradient imports.
- **engine:** `.grd` import no longer warns "skipped". A Gradient Overlay with noise renders
  non-uniformly. `gradient.presets.stop set` with `noise` persists through `prefs_value` →
  `load_prefs_json`.
- **io (legacy):** a 0.4 document with a noise gradient opens with `noise` set and the same pixels
  as before (the L2 fixture).
- **ui:** switching Gradient Type to Noise in the Gradient Editor panel commits one history entry
  for a fill layer; Randomize changes the seed.

### Effort

**L, about 1.75 days** (was L, 2 days). The JS sampler and its exactness tests are already ported.

---

## P4: Migrate Presets from Pigment 0.4 (row 22, second half)

### Status of the row now

| Row | Now | Evidence |
|---|---|---|
| 22 (second half): Migrate Presets | **partly done** (as on Nov 15) | `edit.presets.migratePresets` (`cmd/migrate_cmds.rs:71`) requires `path` (`:28-31`) and merges a PhotoCraft presets or preferences JSON by group name: gradients, styles, shapes, `pattern_groups` and `tool_presets`. Pigment 0.4's presets folder is not read. The menu item (`menu_catalog.rs:142`) has no shell front end (no arm in `prefs_ui/dialogs.rs` `invoke`), so the engine refuses it for lack of `path`. |

Nothing new is dropped; the spec's drop of the JS Actions panel's actions (section 8, item 5)
stands.

### Where things are now

| Spec names | Now |
|---|---|
| `crates/engine/src/cmd/migrate_cmds.rs` | unchanged (`merge_groups` `:11`, `groups` `:23`, `migrate` `:27`, spec `:71`) |
| `apps/photocraft/src/app_dirs.rs` `legacy_pigment_dir` | not there yet. `app_dirs.rs` has `current()` `:30`, `config_dir()` `:45` and the folder rules (`:7-11`) |
| `legacy_pigment::{brush, gradient, styles, adjust, path}` (D5) | `gradient.rs`, `styles.rs`, `adjust.rs` and `path.rs` exist (L2), all `pub(crate)`: `adjust::to_adjustment` `:429`, `styles::StyleReader` `:91`, `path::to_path` `:37`, `gradient::Def` and `fill_stops`/`map_stops`/`source`. `blend.rs` exists. **`brush.rs` does not exist.** |
| `presets.swatches` groups `{name, color}` | `Vec<SwatchGroup>` of `SwatchEntry::new(name, SwatchColor::Rgb([r,g,b]))` (craft `color-ui/src/palette.rs:164-189`) |
| `Preferences.adjustments.auto_options` / `curves_display` (A3, A4) | not built yet (group A pending) |
| `settings.json` | the JS file still sits in the JS userData folder (FORK.md table). Pigment's own preferences are now `config.toml` (§0.2); nothing changes for reading the JS file |
| the `.pigment-bundle` reader (`craft_zip`) | `photocraft_format::zip` (engine); `crates/io` has `craft-zip` |
| `legacy_pigment::adjust` params → `presets.adjustments` (D1) | needs A1's `presets/adjustments.rs`; the engine has `adjust_params::to_params` (`crates/engine/src/adjust_params.rs:275`) to turn the mapped `Adjustment` into params |

### The plan, adjusted

1. **Folder.** `apps/photocraft/src/app_dirs.rs`: add `pub fn legacy_pigment_dir() -> Option<PathBuf>`
   for the Electron `Pigment/presets` folder.
   - Windows and macOS: `config_dir()`'s platform folder plus `presets`. It is the same folder
     Pigment 0.5 uses, as FORK.md explains.
   - Linux: `~/.config/Pigment/presets`, with a capital P.
   - Use the platform rule, not `current()`: a portable copy or `PIGMENT_*` folder overrides must
     not move where the old app's files are looked for.
2. **Hand the folder to the shell.** `crates/ui-egui` cannot call `apps/`. Add one `Services`
   field (`crates/ui-egui/src/services.rs:503`):
   `pub legacy_presets_dir: Option<std::path::PathBuf>`. Set it in `apps/photocraft/src/services.rs`
   where the other services are filled; the precedent is `photoshop_shortcuts` (`:560`). Both are hooks:
   list them in FORK.md.
3. **io.** Add `crates/io/src/legacy_pigment/presets.rs` and re-export it as
   `pub mod presets` from `legacy_pigment/mod.rs`. It is the public face of L2's mappers for one
   preset at a time, and returns document and paint types only (the io crate cannot see the
   engine):
   - `pub fn gradient(v) -> (stops, opacity, Option<NoiseGradient>)`, with `NoiseGradient` once P3
     lands;
   - `pub fn style(v, patterns) -> Effects`;
   - `pub fn path(v) -> Option<Path>`;
   - `pub fn adjustment(kind, params, notes) -> Adjustment`;
   - `pub fn contour(points) -> Contour`;
   - `pub fn brush(v, tip: Option<&[u8]>) -> (BrushSettings, Vec<String>)`, from the new
     `legacy_pigment/brush.rs` that follows JS `renderer/lib/brush/preset.js` `normalizeBrush`
     (on `claude/fervent-newton-263lz3`).
4. **Engine** (`migrate_cmds.rs`). Implement the spec's folder and bundle reading.
   - `path` becomes optional; with no `path`, the error says "no Pigment 0.4 presets folder given".
   - The engine never reads platform folders itself, so CLI and MCP callers pass `path`.
   - Write `import_bundle`, which P1b's import calls for `.pigment-bundle`.
   - The kind mapping is as specified, with swatches going to `SwatchGroup` and `SwatchEntry`.
   - **A1, A3 and A4 parts:** when A1's `presets.adjustments` exists, migrate `adjustment:<kind>`.
     When A3's `auto_options` and A4's `curves_display` exist, migrate `settings.json`
     `adjust.autoOptions` and `adjust.curvesDisplay`. Otherwise report them as skipped with the
     reason "needs Pigment's adjustment presets", and record that in the notes so the A
     engineers, or a follow-up, wire them in.
   - The result shape is as specified, and the command is idempotent.
5. **UI.** Add an arm in `prefs_ui/dialogs.rs` `invoke` (`:36-82`) for
   `edit.presets.migratePresets` with no params, written as a call into a Pigment file
   `crates/ui-egui/src/dialogs/migrate_presets_ui.rs`.
   - If `services.legacy_presets_dir` exists, open a `StandardPrompt`: "Migrate presets from
     Pigment 0.4 at {folder}?", tagged like `ResetAllTools` in `tools/tool_reset.rs`, with its
     answer taken in `prompts_take`. Otherwise call `app.ask_folder`.
   - Then run the command with `path` and show "{n} presets migrated." or "No Pigment 0.4 presets
     were found." in the status bar.
6. **Docs.** FORK.md: the hooks, and a line in "The settings folder and Pigment 0.1–0.4" saying
   that Migrate Presets reads the JS `presets/` folder read-only.

### Tests (intent unchanged)

- The fixture folder goes in `crates/engine/tests/fixtures/pigment-0.4-presets/` (that directory
  holds only `atn/` today): `swatches.json`, `gradients.json`, `adjustment__curves.json`,
  `tool-presets.json` and `patterns.json` plus `patterns/p1.png`. A brush fixture `brushes.json`
  is new, for `legacy_pigment::brush`.
- The test goes in `crates/engine/tests/it/migrate_pigment_04.rs`, added to `tests/it/main.rs`.
  It checks that:
  - every kind present migrates;
  - migrating twice adds nothing;
  - a corrupt kind file is skipped with a report entry;
  - a `.pigment-bundle` built in the test with `photocraft_format::zip::ZipWriter` imports.

  While A1 is absent, `adjustment__curves.json` must show up in `skipped` with its reason.
- **io:** unit tests of `legacy_pigment::presets::brush` (diameter, hardness, spacing, angle,
  roundness and tip from the JS schema).
- **app:** `legacy_pigment_dir` follows the platform rules (a pure function of the environment,
  tested like `app_dirs::resolve_recovery`).
- **ui:** with a scripted `legacy_presets_dir`, the menu item opens the prompt, and OK migrates
  and sets the status. Without it, the folder dialog is asked for (`ScriptedFiles`).

### Effort

**M, about 1.5 days** (unchanged). The mappers exist but need public wrappers and a brush mapper.
Add about 0.25 day if A1, A3 and A4 have landed by then and their parts are wired in here.

---

## Order and shared files (section 9, adjusted)

The order is unchanged: P1a → P1b → P2 → P3 → P4, after group A. These rows replace or add to
the spec's shared-files table:

| Shared file | Edited by (place) |
|---|---|
| `crates/ui-egui/src/preset_files_ui.rs` (`PRESET_EXTS`, `open`) | P1a (`.shc`, `.csh`, adjustment extensions), P2 (`.tpl`) |
| `crates/ui-egui/src/prefs/prefs_ui/dialogs.rs` `invoke` | P1a (the manager's route, `:78`), P4 (the migrate arm) |
| `crates/ui-egui/src/prefs/prefs_ui/presets.rs` | P1b only (`io_params`, `open_io`, `confirm_io`) |
| `crates/ui-egui/src/dialogs.rs` `TAKERS` | P1a (`preset_manager_ui::take`), P4 if its prompt needs a taker |
| `crates/ui-egui/src/panels/registry.rs` | P2 (`toolPresets` entry) |
| `crates/ui-egui/src/panels/preset_browser.rs` | P1a (`paint_gradient`, `paint_pattern` to `pub(crate)`); P2 only if the menu trio goes there rather than in its own file |
| `crates/ui-egui/src/tools/gradient_ui/{editor,properties_panel}.rs` | P3 (show `noise.rs`) |
| `crates/ui-egui/src/services.rs` `Services` | P4 (`legacy_presets_dir`) |
| `crates/io/src/legacy_pigment/gradient.rs` | P3 (sampler moves to doc), P4 (public wrapper via `presets.rs`) |
| `scorecard/ui.toml` (UI-217-21), `docs/file-format-parity.md:140` | P1a, P2 |
