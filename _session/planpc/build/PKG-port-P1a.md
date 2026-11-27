# PKG-port-P1a: the Preset Manager for every kind (rows 21, 23)

Built on `claude/pigment-photocraft` after `8821fdf` (group A's review; PhotoCraft 057297b). Spec: PORTS-A §3.1 and §9
P1a; REBASE-P "P1a" (it wins). Group A has landed, so the `adjustments` kind is in (A1's
`presets/adjustments.rs`, `adjustment.presets.*`).

**CI first.** At the start the run on `8821fdf` (46041402514) was still queued and the one on `75ec448` (46038027153)
still running (expected red on `every_adjustment_command_runs`, fixed by `90265ff`). Neither had finished when this
package pushed, so there was no red run on `8821fdf` or later to fix. **The next engineer checks CI first**: the runs
on `8821fdf` and on this package's commits (see "Commits").

## What was built

1. **Engine**, `crates/engine/src/cmd/edit_menu_cmds/preset_manager.rs` (new, Pigment's): `edit.presets.presetManager`
   over nine kinds, `PRESET_KINDS = [brushes, swatches, gradients, styles, patterns, contours, customShapes, tools,
   adjustments]`. A `Library` trait (rows, rename, delete, move_to, reset_command, clear, save_extensions,
   save_extension_for, save_set) with one implementation per kind, each delegating to the kind's own commands through
   `presets::call` (so it stays one journaled step; nested calls are not journaled):
   - `list {"kind"?}` → `{<kind>: [names], info: {<kind>: {thumb, rows: [{index, group, name, key, hint?}], canReset,
     canMove, load: [ext], save: [ext]}}}`. `key` is what the kind's commands call a preset (a pattern's id, an
     adjustment preset's kind); `hint` is a swatch's `#rrggbb` or a tool preset's tool. The `{<kind>: [names]}` part
     is upstream's form, kept for upstream's callers.
   - `rename {index|name(+group), newName}`, `delete {indices|index|name}` (all or none; per-group calls for swatches,
     per-kind for adjustments), `move {index, to}` (the position in the list, joining the folder of the preset it lands
     before) or `{index, toGroup, position?}`.
   - `load {"kind"?, "path"|"data"+"fileName", "replace"}` by extension: `.abr` importAbr, `.aco .ase .act .gpl`
     swatches.import (`mode`), `.grd` importGrd, `.asl` importAsl (`replace:false` on Load…), `.pat` pattern.import,
     `.shc` contours.load (`mode`), `.csh` importCsh, `.alv .acv .ahu .cha .asv .blw` adjustment.presets.load,
     `.pcpresets` exportImportPresets import (brushes, customShapes or tools: give `kind`), `.tpl` →
     `tool.presets.importTpl` **once P2 adds it** (an extension counts only when its command exists). With `data`, the
     file's stem names the new group (as a path does). `replace` empties the library first (swatches and contours use
     their own `mode:"replace"`) and puts every library back if the import fails (a `Backup` of `PresetState`, the
     brushes, the pattern library and the custom shapes). A brush Replace reads the `.abr` first, because the import
     can finish on a worker after the command returns.
   - `saveSet {"kind", "indices"?=all, "path"?, "format"?}` → `{fileName (the preset's name for one, else "Gradients"…),
     count, bytes, path | data}`: swatches `.aco/.ase/.act/.gpl/.css`, gradients `.grd`, styles `.asl`, patterns `.pat`,
     contours `.shc`, adjustments one preset in its Photoshop file, brushes, custom shapes and tools `.pcpresets` (tools
     `.tpl` once P2's `exportTpl` exists).
   - `reset {"kind"}`: swatches, gradients, styles, customShapes (shape.presets.reset), tools; adjustments resets every
     kind (`adjustment.presets.reset`). Brushes, patterns and contours have no reset: `canReset:false`, `reset` errors.
2. **`gradient.presets.exportGrd {"group"?, "names"?, "path"?}`** (`crates/engine/src/presets/gradients/export_grd.rs`,
   new): `GradientPreset` → `craft_psd::grd::GrdGradient` (RGB / foreground / background stops, opacity stops, midpoints
   50 %; no transparency stops → opaque at both ends). Not journaled. Noise gradients: P3.
3. **`pattern.export` without `path`** returns base64 `data` (a 3-line hook), so Save Set… works on the web too.
4. **Interface**, `crates/ui-egui/src/dialogs/preset_manager_ui.rs` (new): `PresetManagerDialog`, a `StackDialog` over
   the framework's `PresetBrowser`:
   - Preset Type `Select`; the browser with its search toolbar (view buttons hidden by `view_lock`), row menu (Rename,
     Delete), drag to reorder (`PresetReorder::items_and_groups`, off for adjustments), the footer's Delete;
   - footer buttons Load…, Save Set…, Rename… (asks the browser to rename the selected row), Delete, Done;
   - a ⚙ menu (`IconButton` + `Menu`): Reset {kind}… (greyed without a reset), Replace {kind}… (greyed for
     adjustments), and the five views, checked;
   - **views**: Text Only = list at zoom 1.0 without a thumbnail painter, Small/Large Thumbnail = grid at 0.5/2.0,
     Small/Large List = list at 0.5/2.0 (the footer slider is off, so the zoom only takes those values); kept per kind
     in `app.ui.presets_ui.browsers["presetManager.<kind>"]` (persists in `ui.ron`); the last kind shown in
     `presets_ui.selected["presetManager"]`;
   - **multi-select** on top of the browser's single selection: click selects one, Cmd/Ctrl toggles, Shift selects the
     range from the anchor (row order); members get a ring in the thumbnail painter, a "selected" caption in Text Only;
   - thumbnails read from the session when rows load (the dialog draws without the app): swatch colour, gradient chip
     (`GradientRamp::paint_chip`), pattern texture, style and shape images (the panels' `pattern_texture`,
     `style_image`, `shape_image`), brush tip (`brush_preview::tip_image`), contour curve, tool icon, an adjustments
     icon;
   - `take` (in `dialogs::TAKERS`) runs the queued asks as `edit.presets.presetManager` and reloads the rows when the
     libraries' revisions moved (after a Load… that finished later, an agent's edit); Reset/Replace confirm with a
     `StandardPrompt` answered by `answer_prompt` (in `dialogs::PROMPTS`);
   - Load… uses `pick_file_bytes_filtered` with the kind's extensions and `preset_files_ui::open` for the files File ›
     Open imports (so the group-clash prompt and status line are File › Open's); the rest and every Replace… go to the
     engine's `load`. Save Set… runs `saveSet` and writes through `pick_save` + `services.write`.
   - Agents: `json_fields` = `{kind, view, rows: [{group, name}], selected}`; `set_json_field` takes `kind`, `view`,
     `selected` and `press` (`load`, `saveSet`, `rename`, `delete`, `reset`, `replace`).
5. **File › Open / drag-and-drop** take `.shc`, `.csh` and `.alv .acv .ahu .cha .asv .blw` (REBASE §5), through
   `preset_manager_ui::open_file` → the engine's `load`.
6. Docs: `scorecard/ui.toml` UI-217-21 `done` (new note); `docs/file-format-parity.md` `.csh` row; `docs/FORK.md`
   "The Preset Manager for every kind".

## Choices recorded (where the spec/REBASE and the code differ)

- **The manager is in its own file** (`edit_menu_cmds/preset_manager.rs`), not in upstream's `edit_menu_cmds/presets.rs`:
  upstream's three-kind `PRESET_KINDS`, `preset_names`, `preset_index` and `preset_manager` were removed from that file
  (they would be dead code), a comment points to the new one. Upstream's test `define_custom_shape_and_preset_manager`
  was adjusted (the custom shapes are now the last of the Shapes library; a move names its group; the refused kind is an
  unknown one).
- **Rows are addressed by position** (`index`/`indices`), as upstream's manager did; names repeat across groups
  (swatches, a renamed custom shape "Star" beside the built-in "Star"), so `name` lookups take `group` too.
- **Custom shapes**: Define Custom Shape results move only inside their `Custom Shapes` group (they live in
  `edit_state.custom_shapes`); moving a preset into or out of it is refused (REBASE dropped the storage merge).
- **Contours have no rename command**: the manager renames them in place with the library's rules (unique, not a
  standard contour's name, 255 characters).
- **Tool presets and contours reorder in place** (`move_item`): `tool.presets.edit` and the contour commands have no
  move.
- **Adjustment presets**: listed by kind (group = the kind's menu name, e.g. "Curves"), built-ins included; no
  reorder (the dialogs list built-ins first), no Replace (a Photoshop adjustment file holds one preset), Save Set… of one
  preset only. The Adjustments panel's "Your Presets" (`__panel`) are not listed: `adjustment.presets.*` refuses that
  pseudo-kind (they have the panel's own Delete). P1b's `.pcpresets` can carry several.
- **Search**: the browser's search field is on (the scorecard row asks for it; Photoshop has none).
- **The selection ring colour** is a fixed accent (`SELECTED`), as the painter has no theme token for a selection.
- **Replace…** empties the whole library (Photoshop's Replace), not only a same-named group as `importAsl`'s
  `replace` does.
- **Upstream's `prefs_ui/presets.rs` manager** (`open_manager`, `take_manager`) is kept, unused outside its test
  (`#[cfg_attr(not(test), allow(dead_code))]`); `prefs_ui/tests.rs` `edit_dialogs_open` still opens it.

## Hooks into upstream files (all in FORK.md, "What Pigment added › The Preset Manager for every kind")

| File | Hook |
|---|---|
| `crates/engine/src/cmd/edit_menu_cmds.rs` | `pub mod preset_manager;`; `use preset_manager::preset_manager;`; the params string |
| `crates/engine/src/cmd/edit_menu_cmds/presets.rs` | the three-kind manager removed, a comment; `str_or` import dropped |
| `crates/engine/src/cmd/edit_menu_cmds/tests.rs` | `define_custom_shape_and_preset_manager` adjusted (above) |
| `crates/engine/src/presets/gradients.rs` | `pub mod export_grd;`; `export_grd::spec()` in `specs()` |
| `crates/engine/src/cmd/pattern_cmds.rs` | `pattern.export`: no `path` → `data`; params string |
| `crates/automation/src/workspace.rs` | `edit.presets.presetManager`, `gradient.presets.exportGrd` with `path` in `command_uses_ambient_path` |
| `crates/ui-egui/src/dialogs.rs` | `pub mod preset_manager_ui;`; `take` in `TAKERS`; `answer_prompt` in `PROMPTS` |
| `crates/ui-egui/src/prefs/prefs_ui/dialogs.rs` | the menu route opens `preset_manager_ui::open` |
| `crates/ui-egui/src/prefs/prefs_ui/presets.rs` | `open_manager`: `#[cfg_attr(not(test), allow(dead_code))]` |
| `crates/ui-egui/src/preset_files_ui.rs` | `PRESET_EXTS` + 8 extensions; `open`'s last arm → `preset_manager_ui::open_file` |

## Files

New: `crates/engine/src/cmd/edit_menu_cmds/preset_manager.rs`, `.../preset_manager_tests.rs`,
`crates/engine/src/presets/gradients/export_grd.rs` (tests inside), `crates/ui-egui/src/dialogs/preset_manager_ui.rs`,
`crates/ui-egui/src/dialogs/preset_manager_ui/tests.rs`. Edited: the hook files, `docs/FORK.md`, `scorecard/ui.toml`,
`docs/scorecard.md` (regenerated), `docs/file-format-parity.md`.

TESTS_AND_CHECKS

## Not done (with why)

- `.tpl` load/save: P2 (`tool.presets.importTpl`/`exportTpl`); the dispatch picks them up when the commands exist.
- `.abr` and `.csh` writers: none exist (no `BrushSettings` → descriptor encoder; craft-psd's `csh` only parses), so
  brushes and custom shapes save as `.pcpresets`, as the spec and REBASE say.
- `.pcpresets` carrying swatches, gradients, styles, patterns, contours, adjustments: P1b (D4).
- Noise gradients in `exportGrd`: P3.
- The JS app's bundled `.pigment-presets` libraries in the ⚙ menu (Photoshop's bundled libraries): not in REBASE's
  plan; P4 (migration) may bring them.
- A framework multi-select (`PresetBrowser::select_mode(Multi)`): **an upstream request for craft-libs**, not forked;
  the dialog keeps its own set meanwhile.
- New strings are English through `tl!` (i18n catalogues left to their fallback).

## For the next packages

- **P1b**: `PresetFile` is still in `edit_menu_cmds/presets.rs`; the manager builds `.pcpresets` with
  `preset_manager::{pcpresets, empty_file}` for brushes, custom shapes and tools. When P1b adds kinds to `PresetFile`,
  add `("pcpresets", "<kind>", "edit.presets.exportImportPresets")` rows to `LOADERS` and let those kinds' `save_set`
  write `.pcpresets` too (adjustments: several presets in one file). The import's `kinds` param is set to `[kind]` by
  the manager's load.
- **P2**: add `tool.presets.importTpl` (taking `path`|`data`, and `replace` or the manager empties first) and
  `tool.presets.exportTpl {"names"}` returning `{data}`; the manager's `LOADERS` row and `Tools::save_extensions`
  already look for them. Add `"tpl"` to `preset_files_ui::PRESET_EXTS` and `open` then.
- **P3**: `export_grd::to_grd` is where noise goes (`GrdGradient.noise` + the `ClNs` keys).
- The manager's `load` passes `data` + the file's stem as `group`; a path keeps the importer's own naming.
