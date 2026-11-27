# PKG-port-P1b: Export/Import Presets for every kind (row 22, first half)

Built on `claude/pigment-photocraft` after `1c92254` (P1a; PhotoCraft 057297b). Spec: PORTS-A §3.2 and §9 P1b;
REBASE-P "P1b" (it wins). Group A has landed, so the `adjustments` kind is in.

**CI first.** The newest finished run at the start was 46038027153 (`75ec448`), red only on
`engine tests::every_adjustment_command_runs`, already fixed on the branch by `90265ff` (group A's review). The runs
on `8821fdf` (46041402514) and on P1a's `1c92254` (46050395075) were still running/queued, so nothing red on a
newer commit to fix and no CI commit. **The next engineer checks CI first**: 46041402514, 46050395075, and the runs
on this package's two commits.

## Commits (pushed)

- `4ca9356` Pigment Export/Import Presets for every kind (P1b), engine: .pcpresets with swatches, gradients,
  styles, patterns, contours, shapes and adjustments
- `007cd8b` Pigment Export/Import Presets for every kind (P1b), interface: a check box per kind, Import of
  .pcpresets and .pigment-bundle

## What was built

1. **Engine**, `crates/engine/src/cmd/edit_menu_cmds/preset_file.rs` (new, Pigment's), tests in
   `preset_file_tests.rs`:
   - `PresetFile` (still in `edit_menu_cmds/presets.rs`) gains `swatches: Vec<SwatchGroup>` (craft-color's type as
     it is), `gradients`, `styles` (`Group<…>`), `patterns: Vec<PatternEntry {id, name, data}>` (`data` = the
     pattern, pixels included, as a base64 one-pattern `.pat` written by `pattern_map::write_pat`) with
     `patternGroups: Vec<Group<String>>` (ids), `contours: Vec<Value>` (the contour library's saved curve objects,
     `layer_style::contour_param`), `shapes: Vec<Group<ShapePreset>>` (the Shapes panel's groups) and
     `adjustments: Vec<AdjustmentEntry {kind, group, name, params}>`. All `#[serde(skip_serializing_if =
     "Vec::is_empty")]` (the struct is `#[serde(default)]`), so a three-kind export is exactly upstream's file.
   - `kinds_param`: the nine ids (`KINDS` = the manager's `PRESET_KINDS`); the default stays upstream's three;
     unknown or non-string kinds are refused (upstream ignored them).
   - `export_kind(s, file, kind, Pick, cmd)`: `Pick::All{builtins}` for the command (built-ins as shipped left out
     unless `includeBuiltins`: compared with `gradients::builtin()`, `styles::builtin()`, `shapes::builtin()`,
     `default_swatches()`, `pattern_cmds::is_pristine_builtin`, the adjustment built-ins), `Pick::Rows(&[Row])` for
     the Preset Manager's Save Set….
   - Import: `read_data` (JSON text or object; `swatches::upgrade_saved` on `swatches`; a ZIP, raw or base64, is a
     `.pigment-bundle` and is refused with "use Edit › Presets › Migrate Presets"), then `Staged::read` merges the
     six kinds into copies of the libraries, checking everything (pattern data, contour curves,
     `adjust_preset_cmds::preset_params` of each adjustment preset, limits) before `Staged::apply` puts them in
     place, after upstream's tool validation and brush/custom-shape/tool import. Rule: append to the group of the
     same name (made at the end when missing); skip a preset whose data is already in the library under the same
     name **or the numbered name an import gave it** (`Name 2`), so importing twice adds nothing even after a name
     clash; a taken name with different data gets the next number. Names stay unique across each library, as the
     kinds' own imports keep them. Patterns: same id with the same name, size and pixels → skipped; same id,
     different pixels → replaced (as `pattern.import` does); folders appended by name, ids already in a folder left
     there, then `patterns::sync`. Contours never take a standard contour's name. Adjustment presets of a kind this
     build does not know are left out (`skipped.adjustmentKindsUnknown`); group "Built-in" imports into "My Presets".
   - Replies: export `{data, brushes, customShapes, tools, <kind>: count…}`; import `{brushes, customShapes, tools,
     <kind>: added…, skipped: {<kind>: n}}` (`customShapes` = upstream's count + Shapes-group shapes added).
2. **`edit.presets.exportImportPresets`** (`edit_menu_cmds.rs` `export_import`): the hooks above and a new params
   string. Upstream's three kinds keep upstream's code and rules (replace by name; tools validated first).
3. **Preset Manager** (`preset_manager.rs`, P1a's): `LOADERS` gains `pcpresets` rows for swatches, gradients,
   styles, patterns, contours, adjustments; every kind lists `pcpresets` among its Save Set… extensions (after the
   Photoshop format); `pcpresets_of` writes them through `export_kind` with the manager's rows. Custom Shapes' Save
   Set… now writes Shapes-panel rows into `shapes` (their group kept) and Define Custom Shape rows into
   `customShapes`. Adjustments: Save Set… of several presets (or of a kind without a Photoshop file) writes
   `.pcpresets` by default; with `format` of a Photoshop file it still wants one preset. P1a's test asserting that
   two adjustment presets refuse was changed to the new behaviour.
4. **Interface**, `crates/ui-egui/src/prefs/prefs_ui/presets.rs` (upstream's): `io_kinds()` (nine ids and labels,
   the manager's order), `io_params` = Action radio + nine check boxes, `open_io` all checked, `confirm_io` exports
   the checked kinds / imports with `pick_file_bytes_filtered(["pcpresets", "pigment-bundle"])`, a file starting with
   `PK\x03\x04` sent as base64. Tests in `prefs_ui/presets_io_tests.rs`.
5. `docs/FORK.md`: "Export/Import Presets for every kind" with its hooks.

## Choices recorded (where the spec/REBASE and the code differ)

- **No new dialog file**: REBASE's choice, upstream's `ParamDialog` with more rows; Photoshop's two moving lists are
  not reproduced (one check box per kind).
- **`contours` is `Vec<Value>`**, not `Vec<Contour>`: the library's own saved form, read back through
  `contour_from_param`, so a hand-edited file is checked like the preferences are.
- **`shapes` holds the Shapes panel's groups only**; Define Custom Shape results stay in upstream's `customShapes`
  (so upstream and Pigment 0.5 files load, and nothing is written twice). A `shapes` group named "Custom Shapes" in a
  file is read into the Define Custom Shape results.
- **`migrate_cmds::merge_groups` is not used**: it appends whole groups only when the name is new; P1b's rule merges
  into a group of the same name item by item. `migrate_cmds.rs` is untouched (P4 owns it).
- **`find_in`/`unique_group` (REBASE) are not needed**: swatches are converted to `Group<SwatchEntry>` (a local `impl
  Named for SwatchEntry`) and go through the same merge as gradients and styles (`unique_name_by` across the library,
  `group_index` for the group).
- **Old `items` swatches load** (REBASE asked to choose): `upgrade_saved`, tested.
- **Imported gradients are tidied** (stop locations clamped to 0..1 and sorted); styles and shapes are taken as the
  preferences loader takes them (no further validation exists for them).
- **Bundle hook**: the refusal is in `preset_file::read_data` (a comment says P4 calls its `import_bundle` there);
  no stub was added to `migrate_cmds.rs`.
- **Limits**: at most 10 000 presets of one kind per file (`MAX_ENTRIES`); swatches also the panel's 100 000 / 10 000
  groups; contours the library's 1 000; adjustment presets 1 000 per kind (`AdjustmentPresets::save`).
- Empty groups are not exported (an empty folder holds no preset).
- Adjustment presets: Replace… from a `.pcpresets` stays refused in the manager (P1a: there is no adjustment library
  to empty; built-ins come back on Reset).

## Hooks into upstream files (all in FORK.md, "What Pigment added › Export/Import Presets for every kind")

| File | Hook |
|---|---|
| `crates/engine/src/cmd/edit_menu_cmds.rs` | `pub mod preset_file;`; `export_import`: `kinds_param`; `..PresetFile::default()` + the `export_kind` loop + `export_counts`; `read_data`; `Staged::read` before the tool validation; `Staged::apply` at the end; params string |
| `crates/engine/src/cmd/edit_menu_cmds/presets.rs` | `PresetFile`: eight new fields |
| `crates/ui-egui/src/prefs/prefs_ui/presets.rs` | `io_kinds`; `io_params`, `open_io`, `confirm_io` over nine kinds; filtered Import, ZIP as base64; `io_tests` module |

## Files

New: `crates/engine/src/cmd/edit_menu_cmds/preset_file.rs`, `.../preset_file_tests.rs`,
`crates/ui-egui/src/prefs/prefs_ui/presets_io_tests.rs`. Edited: the hook files, `preset_manager.rs`,
`preset_manager_tests.rs`, `docs/FORK.md`.

## Tests (all green here)

- engine `cmd::edit_menu_cmds::preset_file::tests` (9): **export every kind → import into a fresh `Session` → every
  library equal** (patterns by id, name, size and pixels; text and object `data` both); **importing twice adds
  nothing** (also into the source session); a different preset of a taken name gets `Name 2` once and only once
  (gradients, curves presets, contours); **an upstream three-kind file imports** and a default export has exactly
  upstream's keys; **old `items` swatches load**; a damaged pattern, adjustment, contour or tool preset changes nothing,
  and bad `kinds` / `data` are errors; a `.pigment-bundle` (raw or base64) is refused naming Migrate Presets;
  `includeBuiltins` exports everything and a fresh library skips all of it; the Preset Manager saves `.pcpresets` of
  every kind and loads/Replaces from it, two adjustment presets of two kinds in one file, shapes keep their groups.
- engine `edit_menu_cmds`, `preset_store`, `presets::` filters: 171 passed (upstream's
  `tool_presets_round_trip_through_export_import`, `tool_preset_import_is_validated_before_mutation_and_accepts_old_files`,
  the preset-store export tests, P1a's manager tests with the one adjusted assertion).
- engine panic hunt (`--test panic_hunt -- --ignored`): 1 passed.
- ui-egui `prefs_ui`, `preset_manager_ui`, `preset_files_ui` filters: 78 passed, including
  `prefs_ui::presets::io_tests` (3): the dialog offers the nine kinds; **Export through `ScriptedFiles` writes every
  kind and Import of that file restores a deleted gradient** (and the curves preset; the open request filters
  `pcpresets` and `pigment-bundle`); unchecked kinds stay out of the file and a bundle is refused with its reason in
  the status line.
- automation `workspace` (56), with `registry_filesystem_path_params_are_classified` (the params string names no `path`).

## Checks

`cargo fmt --all -- --check`; `cargo clippy -p photocraft-engine -p photocraft-ui-egui --all-targets -- -D warnings`;
`python3 scripts/pigment-rebrand.py --check`; panic hunt: all green. No crate, preference or panel command added, so
the xtask checks were not needed (no new click handler: the dialog's OK goes through upstream's `ParamFamily`).

## Not done (with why)

- `.pigment-bundle` import itself: P4 (REBASE §P1b 3: it maps the bundle's kinds through P4's mappers). The hook is
  the refusal in `preset_file::read_data`.
- `docs/parity/README.md` row "Presets › Export/Import Presets and Migrate Presets" still says Partial: group A and
  P1a left their rows too; whoever closes 0.6's docs updates the page (this row after P4).
- New strings ("Swatches", "Gradients", "Styles", "Patterns", "Contours", "Adjustments") are English through `tl!`,
  catalogues left to their fallback.

## For the next packages

- **P2** (`.tpl`): nothing here changes; the manager's `Tools` save list still puts `tpl` first when
  `tool.presets.exportTpl` exists.
- **P3** (noise gradients): `GradientPreset` travels in `.pcpresets` as serde JSON, so a noise field added to it
  round-trips here; extend `preset_file::tidy_gradient` if noise needs checking on import.
- **P4** (Migrate Presets): replace the bundle refusal in `preset_file::read_data` with a call to
  `migrate_cmds::import_bundle`; it can build a `PresetFile` from the bundle and reuse `Staged::read`/`apply` (the
  append-and-skip rule the JS `bundle.js` had). `preset_file::KINDS` and `Pick` are public to the crate.
