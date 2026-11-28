# Review of group P (P1a to P4): Preset Manager, Export/Import Presets, .tpl, noise gradients, Migrate Presets

Reviewed on branch `claude/pigment-photocraft` from `8821fdfd` (the end of group A's review) to `31d24228` (P4's
interface commit), against PORTS.md, PORTS-A.md sections 0 and 3.1 to 3.5, and REBASE-P.md (which wins where they
differ). The engineers' notes are `PKG-port-P1a.md` to `PKG-port-P4.md` beside this file.

## Verdict

The group is sound. Each row the spec gives P1a to P4 (21 to 26) is built or recorded with a reason: the options-bar
tool preset picker (dropped by REBASE), Photoshop's two moving lists in Export/Import (REBASE's choice of one
parameter dialog), the missing `.abr`/`.csh` writers (brushes and custom shapes save as `.pcpresets`), the full brush
dynamics in a `.tpl`'s `Brsh` (no encoder), the framework-fixed menu labels, the Shadows/Highlights and stroke-style
presets Pigment has no kind for, and the JS Actions sets (spec section 8). The hooks into upstream files are small and
every upstream file the group changed is named in `docs/FORK.md` (checked mechanically against PhotoCraft `057297b`).
The new readers (`.tpl`, `.grd`/`grdm`/`ClNs` noise, `.pcpresets` with nine kinds, the JS preset folder and
`.pigment-bundle`) bound their input and have truncation, flipped-byte or hostile-value tests; I found no panic. One
history step per action holds where I looked (each noise control commits once, on release; a fill layer's noise edit
is one step and survives `.pcraft`, undo and redo). PSD round trips of noise fills, Gradient Overlays, strokes and
Gradient Maps keep every key; the HSL model keeps upstream's placeholder and raw block.

I found three real defects and fixed them, each with a test, plus one hardening fix. CI was green on arrival (the P4
run 46084412661 on `31d2422` finished green).

## Found and fixed

1. **The Preset Manager's selection pointed at other presets after the rows moved** (major, P1a, interface).
   `preset_manager_ui::refresh` kept the selection as row positions (`retain(i < n)`). After a drag reorder, a move into
   another group, or a change made elsewhere while the dialog is open (a preset added in a panel), the ring and the
   selection marked different presets, and Delete or Save Set... then acted on presets the user had not chosen. Now the
   selection and the Shift-click anchor are kept by group, name and occurrence (names repeat, swatches' even in one
   group), and a rename or a move into a group updates the row before the rows are read again.
   Test: `dialogs::preset_manager_ui::tests::the_selection_follows_its_presets_when_the_rows_move` (reorder, rename, a
   preset added elsewhere at the top, then Delete removes exactly the chosen two).
2. **A noise preset with transparency stops of its own kept its noise settings** (major for PSD, P3).
   `GradientPreset::with_transparency` replaced the opacity stops but kept `noise`, so `gradient.fill.create
   {"gradient": <a noise preset>, "transparency": [...]}` (and the fill command on the current noise gradient) made a
   fill whose stops were no longer the bake: a PSD save then wrote `ClNs` and lost the transparency, breaking P3's own
   invariant ("a gradient's stops are its noise bake"). Transparency stops of their own now make it solid, as
   `apply_fill_params` already did for `gradient.fill.set`. Hook added to FORK.md's `presets/gradients.rs` row.
   Test: `presets::gradients::noise::tests::a_noise_preset_with_transparency_stops_of_its_own_is_solid`.
3. **A `.pcpresets` file's gradients went in as written** (minor/major, P1b; also P4, which merges through it).
   `preset_file::tidy_gradient` held locations but not colours to 0..1, and a gradient with no colour stops, or one,
   was added (`gradient.presets.new` and the editor never make those; upstream's `from_params` refuses fewer than two).
   Nothing panicked when such a preset was painted, filled, selected or exported (I probed each), but the panel showed
   broken presets from a shared file. Now: no colour stops refuses the file with nothing changed (as a damaged pattern
   or contour does), one stop becomes that colour all along (Photoshop's drawing, and how a one-stop JS gradient
   migrates), colours are held to 0..1, and at most 1024 stops are read (the editor's limit).
   Test: `cmd::edit_menu_cmds::preset_file::tests::a_files_gradients_are_tidied_and_one_without_stops_is_refused`.
4. **`.grd` noise settings could go to the wrong gradient** (minor, P3). `grd_noise::grd_noise` matched only a `Grad`
   object, while `craft_psd::grd::parse` also keeps a `Grad` global object; the two lists were paired by position in
   `import_grd`, so after such an item the next noise gradient's settings went to this one (and the noise gradient fell
   back to "skipped"). It now uses `get_object`, the same test craft-psd uses.
   Test: `grd_noise::tests::settings_stay_beside_their_gradient_when_a_grad_is_a_global_object`.
5. Hardening, no test: Migrate Presets read `settings.json` without the size limit its kind files have (64 MB); now it
   has it.

## Minor, recorded, not fixed

- **A `.pcpresets` pattern whose id is already in the library with other pixels or another name replaces it**
  (P1b, `Staged::read_patterns` then `patterns.upsert`). After exporting, renaming a pattern and importing the old file
  again, the rename is undone and the import counts it as added. Photoshop would add a copy. Giving the incoming one a
  new id would break styles in the same file that name it, so it needs the styles' pattern references remapped too;
  left for whoever next touches `preset_file.rs`.
- **The JS 0.5 bundled libraries** (`src/renderer/presets/*.pigment-presets` on `origin/claude/fervent-newton-263lz3-wip05`:
  dry-media brushes, gradients, patterns, shapes, styles, the grays, hue-wheel and web-safe swatches) are not in the
  Preset Manager's menu. They exist only on the unreleased 0.5 work branch (not on `fervent-newton-263lz3`, which
  Pigment 0.1 to 0.4 shipped from), so no released user had them; Photoshop's bundled libraries are in the same row.
  A follow-up: read them through P4's `import_bundle` path once their data is checked into `assets/`.
- **Preset Manager Load... of a `.pcpresets` path** reads the file with `std::fs::read` without a size limit
  (`preset_manager::load`); the other loaders go through `preset_import_cmds::file_bytes`. Hardening only.
- **A noise gradient fill in a CMYK or Lab document** (not checked): `gradient.presets.select` on a fill layer
  converts the bake to the document's mode, while a PSD reopen rebakes it as sRGB colours; whether the two render the
  same is untested. Worth a test in a CMYK document when someone next touches noise.
- Recorded choices I checked and agree with: opacity, flow and mode of painting tools in `options.brush` (PhotoCraft
  keeps them in `BrushSettings`); tips kept inside the tool preset, not added to the Brushes library; Load twice adds
  nothing (Photoshop appends copies; the JS bundle rule); importer noise gradients drawn from the new bake, not L2's 128
  samples; flat noise ignoring Restrict Colors (keeps upstream's constant-colour reading); contour points 0..1 (the code)
  rather than the spec's 0..255; shapes scaled x100 into the Shapes box; ungrouped migrated presets in "Pigment 0.4".
- P4's "watch item" (a migrated tool preset added twice once the preset store rewrites its tip as `{"stored": ...}`)
  does not happen: the preset store links stored tips only for the Brushes library and the tool's current brush, never
  for tool presets (`preset_store.rs` has no `tool_presets`).

## Checks run

All with `-j 4`, `CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_STRIP=symbols`, one cargo process at
a time, the brief's TMPDIR/CRAFT_* variables.

- doc lib `noise_gradient`: 6 passed.
- io lib `tpl_map grd_noise legacy_pigment`: 89 passed; after the fix `grd_noise`: 6 passed (the new test included).
- io it `psd_noise noise 6272`: 3 passed (upstream's #6272 placeholder test included).
- engine lib `preset_manager preset_file presets:: migrate_cmds edit_menu_cmds every_ gradient_fill layer_style`:
  356 passed before the fixes (upstream's `every_*` registry tests included); after them
  `preset_file gradients::noise preset_manager migrate`: 38 passed.
- engine it `migrate_pigment_04`: 7 passed (before and after).
- engine panic hunt (`--test panic_hunt -- --ignored`): 1 passed after the fixes.
- ui-egui lib `preset_manager_ui preset_files_ui tool_presets_menu migrate_presets_ui prefs_ui gradient_ui::noise`
  (`--test-threads 2`): 90 passed, the new test included.
- `cargo clippy -p photocraft-io -p photocraft-engine --all-targets -- -D warnings` and `cargo clippy -p
  photocraft-ui-egui --all-targets -- -D warnings`: clean. `cargo fmt --all -- --check`: clean.
  `python3 scripts/pigment-rebrand.py --check`: exit 0.
- FORK.md: every upstream file the group changed (`git diff 8821fdfd..31d24228` against PhotoCraft `057297b`) is named.
- Not run here: the whole ui-egui suite (CI runs it; P3 ran it through nextest, 3789 passed) and the xtask checks (no
  crate, preference, panel command or click handler was added by the review).
- CI: 46084412661 (`31d2422`, P4) green. 46089736315 (`e44d7b9`) and 46090349536 (`fb7ecac`) were running when these
  notes were written.

## Commits

- `e44d7b9` Pigment review P, engine and io: imported gradients tidied, a noise preset with its own transparency is
  solid, .grd noise beside its gradient
- `fb7ecac` Pigment review P, interface: the Preset Manager's selection follows its presets

## What the next group should know

- **Check CI first**: the runs on `e44d7b9` and `fb7ecac`.
- **P3's invariant** holds one more place now: any code that replaces a gradient's colour or opacity stops must clear
  `noise` or set the stops from `NoiseGradient::fill_stops`/`bake`. `with_transparency` was the one that did not.
- **Index-addressed UIs**: the Preset Manager addresses rows by position (the engine's `index`/`indices`); anything that
  keeps positions across a re-read must map them by identity, as `refresh` now does.
- From P2 (already in PORTS.md for BR2): B18 adds the Adjustment Brush to `tpl_map::TOOL_CLASSES` and `JS_TOOLS`, and
  P4's `every_kind_of_the_folder_migrates` counts change (tools 3 to 4, total 22 to 23).
- `docs/parity/README.md`: P4 marked Export/Import and Migrate Presets done; rows 21 to 26 can be checked there before
  0.6.
- Memory and disk: a ui-egui lib test build plus engine tests fit after deleting the test executables over 20 MB
  (about 10 GB free then); run ui-egui with `--test-threads 2`.
