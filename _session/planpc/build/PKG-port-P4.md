# PKG-port-P4: Migrate Presets from Pigment 0.4 (row 22, second half)

Built on `claude/pigment-photocraft` after `4fa297d` (P3; PhotoCraft 057297b). Spec: PORTS-A §3.3 and §9 P4;
REBASE-P "P4" (it wins). Group A has landed, so the A1, A3 and A4 parts are built: nothing is skipped for want of them.

**CI first.** At the start the newest finished run was 46066083083 (`5a5cceb`, P2), **green**; P3's 46074153799
(`d54176d`) has since finished **green**, and 46078146087 (`4fa297d`) was still running. Nothing red, so no CI commit.
**The next engineer checks CI first**: 46078146087 (`4fa297d`) and the runs on this package's `f983827` and `31d2422`
(the second push may cancel the first's run). Not waited for, as the brief says.

## Commits (pushed)

- `f983827` Pigment Migrate Presets from Pigment 0.4 (P4), io and engine: the JavaScript preset folder, settings.json
  and .pigment-bundle
- `31d2422` Pigment Migrate Presets from Pigment 0.4 (P4), app and interface: the old app's folder offered, else a
  folder dialog

## What was built

1. **io** (`crates/io/src/legacy_pigment/`, all Pigment's files):
   - `presets.rs` (new, `pub mod presets`): the public face of L2's mappers, one preset's `data` at a time; document and
     paint types only. `gradient(v) -> PresetStops {colors: (t, rgb, Option<StopRef>), opacity, noise, sampled}`,
     `gradient_noise`, `style(v) -> Option<Style {effects, blend, opacity, fill_opacity, patterns, notes}>`,
     `shape(v) -> Option<Path>` (scaled ×100 into the Shapes library's 0..100 box), `path`, `adjustment(kind, params,
     notes)`, `contour`, `brush(v, tips)`, `pattern(name, png) -> Pattern` (deterministic id: same pixels + name = same
     pattern, which is what makes patterns idempotent).
   - `brush.rs` (new): `to_brush(v, tips: &mut dyn FnMut(&str) -> Option<Vec<u8>>) -> (BrushSettings, notes)` after JS
     `brush/preset.js` `normalizeBrush`: tip (size, hardness, spacing, spacingOn, angle, roundness, flips; JS defaults
     24 px / 0.8 / 12 % when missing), sampled tip from its grey PNG side file (or `sample.dataUrl`), Shape Dynamics,
     Scattering, Texture (pattern from `dataUrl` only), Dual Brush (its own sampled tip), Color Dynamics, Transfer,
     Brush Pose (JS tilt −1..1 → ±90°), Noise / Wet Edges / Build-up / Protect Texture, `tool` opacity, flow, blend,
     smoothing; Pigment 0.4's flat presets (`brushFromLegacy`: tip keys + the preset's flow, 1 when absent).
   - `gradient.rs`: `Stop.refers: Option<StopRef>` keeps a `{ref:'fg'|'bg'}` stop; `Def::preset()` (below);
     `PresetStops`. `styles.rs`: `contour` is `pub(crate)`. `mod.rs`: `mod brush; pub mod presets;`.
   - `tpl_map.rs` (P2's): `pub fn js_tool_preset(tool, options, type, color, brush) -> Option<(tool, options, skipped)>`
     over P2's `common_from_js` + `place` (no second table, as P2 asked).
2. **Engine**, `crates/engine/src/cmd/migrate_cmds/legacy.rs` (new):
   - `edit.presets.migratePresets {path}`: a **directory** → the JS preset store (the folder itself, or a settings
     folder holding `presets/`, as JS `folderBundle`); `settings.json` in the folder or beside a folder named
     `presets`; a **ZIP** → `.pigment-bundle` (`import_bundle`); anything else → upstream's JSON merge, unchanged. No
     `path` → "no Pigment 0.4 presets folder given (`path`)": the engine never looks for the old folder itself.
   - Kind files `<kind>.json` (`:` as `__`) with `format: 'pigment-presets'` and `items`; `{ref}` items (built-ins as
     shipped) left out; changed built-ins and user presets migrate; group ids → group names (hidden groups dropped;
     no group → **"Pigment 0.4"**, adjustments → A1's "My Presets"). Side files `<kind>/<name>` (JS `BLOB_NAME_RE`
     checked, ≤ 256 MB); tool presets' tips are in `brushes/` (JS `blobRefs`).
   - Kinds: `swatches` (rgb 0..255, cmyk/gray %, lab), `gradients` (→ `GradientPreset`, `StopColor::Foreground/
     Background` kept; noise via P3's `noise::preset`), `styles` (→ `StylePreset`, their patterns added to the library),
     `patterns`, `contours` (→ `contour_param`), `shapes` (→ Shapes library), `adjustment:<kind>` (→ A1's library via
     `adjust_preset_cmds::file_params` + `preset_params`; `hdr-toning` keeps its params with Strength /100, as A1's
     built-ins), `brushes`, `tool-presets` (→ `tpl::preset_of`, so the brush is checked as `.tpl` imports check it).
     Other JS kinds (`stroke-styles`, camera-raw, fonts, keymaps…) and adjustments Pigment has no presets of
     (Shadows/Highlights) → one `skipped` line per kind.
   - **Merge**: the six kinds P1b handles go through `preset_file::Staged::read`/`apply`, **one kind at a time**
     (patterns first, styles name them), so a kind that cannot be merged is skipped and the rest go in. Brushes and
     tool presets use the same rule here (`merge_brushes`, `merge_tools`): same data under its name or an import's
     number → unchanged; a taken name → next number.
   - `settings.json`: `brushPresets` and `swatches` (+`swatchesEdited`) — Pigment 0.4's own (the `brushes`/`swatches`
     store kinds are 0.5's) → brushes / a "Pigment 0.4" swatch group; `adjust.autoOptions` → A3's
     `Preferences.adjustments.auto_options` **saved as the defaults** (`auto_options_saved = true`, as the JS app used
     them once saved); `adjust.curvesDisplay` → A4's `curves_display` (both deserialize the JS keys, as A3/A4 said);
     each only when it differs. `actions.sets` → one `skipped` line per set with the reason (spec §8 item 5).
   - Reply `{migrated, found, added: {brushes, swatches, gradients, styles, patterns, contours, customShapes, tools,
     adjustments, settings}, unchanged: {…}, skipped: [{kind, name, reason}], notes: […]}`. Not journaled (upstream's
     spec), no document history.
   - `import_bundle(s, bytes, kinds)`: `bundle.json` (`format: 'pigment-bundle'`, `kinds`) + `blobs/<kind>/<name>`;
     a later bundle version and the bundle's `settings` are noted, not converted.
   - **Export/Import Presets' Import** (`edit_menu_cmds.rs` `export_import`): a base64 ZIP → `import_bundle` with the
     checked kinds (P1b's refusal is gone; `preset_file::bundle_bytes`).
3. **App**: `apps/photocraft/src/app_dirs/legacy.rs` `legacy_pigment_dir()` (Some only when the folder exists) and
   `legacy_pigment_dir_in(env)` (pure): Windows `%APPDATA%\Pigment\presets`, macOS `~/Library/Application
   Support/Pigment/presets`, else `$XDG_CONFIG_HOME` (absolute) or `~/.config` + `Pigment/presets`. Not `current()`:
   `PIGMENT_CONFIG_DIR` and portable mode do not move it. Filled into `Services::legacy_presets_dir`.
4. **Interface**, `crates/ui-egui/src/dialogs/migrate_presets_ui.rs` (new): the menu item (no params) → a
   `StandardPrompt` "Migrate presets from Pigment 0.4 at {folder}?" tagged `MigratePrompt`, answered by
   `answer_prompt` in `dialogs::PROMPTS`; without the folder → `app.ask_folder`. Status: "{n} presets migrated." (+
   "{k} not migrated (first: {reason})."), or "No Pigment 0.4 presets were found." (nothing migrated and no file found).
   With params the engine runs directly.
5. Docs: `docs/FORK.md` "Migrate Presets from Pigment 0.4" (hooks table) and a line in "The settings folder and
   Pigment 0.1–0.4" (read only); P1b's FORK line about the bundle refusal updated; `docs/parity/README.md` row
   "Presets › Export/Import Presets and Migrate Presets" → done in 0.6.

## Choices recorded (where the spec/REBASE and the code differ)

- **`brush(v, tips)` takes a reader closure**, not REBASE's `tip: Option<&[u8]>`: a preset can name two side files
  (tip and Dual Brush tip).
- **Gradients keep their own stops** whenever every midpoint is centred, whatever the JS interpolation (perceptual,
  linear, smooth, classic): PhotoCraft's presets interpolate linearly and have no method; sampling every perceptual
  preset into ~130 stops would make them uneditable. Moved midpoints and stripes are sampled (`Def::fill_stops`; refs
  then become black/white). Noise → P3's bake + settings.
- **Shapes are scaled ×100** (JS kept a 0..1 box; the library's built-ins are 0..100).
- **Contour points are 0..1** in the JS code (the spec said 0..255): followed the code (`styles::contour`).
- **settings.json `brushPresets` and `swatches` are migrated too** (not in the spec's list): they are where Pigment
  0.4 itself kept brush presets and the palette (`shared/defaults.js`, `panels/brushes.js`, `panels/swatches.js`);
  the store's `brushes`/`swatches` kinds are 0.5's.
- **Auto options are saved as the defaults** (A3's `saveAsDefaults`), since the JS app only stored them on "Save as
  defaults". Set through `edit_prefs` directly (not `image.adjustments.autoOptions`/`prefs.set`) so an unchanged value
  bumps nothing and migrating twice changes no preference.
- **Texture with a pattern named only by `presetId`** is turned off with a note (the pattern is not in the brush
  data); one with a `dataUrl` keeps it as a tile. JS `smoothCurves`, Dual Brush Count Jitter and `initial-rotation`
  controls have no equivalent: noted.
- **Migrated with no group → "Pigment 0.4"** (`legacy::DEFAULT_GROUP`); nested JS groups are flattened to their own
  name.
- **`unchanged` counts** are a reply key the spec did not have (P1b's "skipped" sense: already in the library), so the
  status line and agents can tell "nothing new" from "nothing found".
- **Brushes and patterns are re-added after a restart in a session whose brush/pattern stores are empty** (they live in
  the preset store, not the preferences); in the app they persist, so the rule holds. Tool presets with a sampled tip
  compare by options JSON; if the preset store later turns their tip into `{"stored": …}` a second migration after a
  restart could add a copy — not seen in tests (the tests round-trip through `prefs_to_json`), noted as a watch item.

## Hooks into upstream files (all in FORK.md, "What Pigment added › Migrate Presets from Pigment 0.4")

| File | Hook |
|---|---|
| `crates/engine/src/cmd/migrate_cmds.rs` | `mod legacy; pub use legacy::import_bundle;`, `bad`; `migrate`: folder → `legacy::migrate_folder`, ZIP → `import_bundle`, no `path` → error; params string |
| `crates/engine/src/cmd/edit_menu_cmds.rs` | `export_import` import: `preset_file::bundle_bytes` → `migrate_cmds::import_bundle` |
| `crates/engine/tests/it/main.rs` | `mod migrate_pigment_04;` |
| `apps/photocraft/src/app_dirs.rs` | `mod legacy; pub use legacy::legacy_pigment_dir;` |
| `apps/photocraft/src/services.rs` | `legacy_presets_dir: crate::app_dirs::legacy_pigment_dir()` |
| `crates/ui-egui/src/services.rs` | `Services::legacy_presets_dir` |
| `crates/ui-egui/src/dialogs.rs` | `pub(crate) mod migrate_presets_ui;`; `migrate_presets_ui::answer_prompt` in `PROMPTS` |
| `crates/ui-egui/src/prefs/prefs_ui/dialogs.rs` | `invoke` arm for `edit.presets.migratePresets` |

Pigment's own files touched: `presets/tools/tpl.rs` (`preset_of` pub(crate)), `edit_menu_cmds/preset_file.rs`
(`bundle_bytes`) and `preset_file_tests.rs` (the refusal test now expects a damaged bundle's error),
`prefs_ui/presets_io_tests.rs` (same, in the status), `io/src/tpl_map.rs`, `legacy_pigment/{gradient,styles,mod}.rs`.

## Files

New: `crates/io/src/legacy_pigment/{presets,brush}.rs`, `crates/engine/src/cmd/migrate_cmds/legacy.rs`,
`crates/engine/tests/it/migrate_pigment_04.rs`, `crates/engine/tests/fixtures/pigment-0.4-presets/` (README,
`settings.json`, `presets/{swatches,gradients,adjustment__curves,adjustment__hue-saturation,
adjustment__shadows-highlights,tool-presets,patterns,brushes,styles,shapes,contours,stroke-styles}.json`,
`presets/patterns/p1.png`, `presets/brushes/tip-….png`; hand-written from the JS formats, PNGs by a few lines of
Python), `apps/photocraft/src/app_dirs/legacy.rs`, `crates/ui-egui/src/dialogs/migrate_presets_ui.rs` and
`migrate_presets_ui/tests.rs`.

## Tests (all green here)

- io `legacy_pigment::brush::tests` (4): the JS schema maps tip, sampled tip (from the side file), dynamics, pose,
  tool; JS defaults and clamping, hostile values; a 0.4 flat preset keeps tip and flow (1 without one); a missing tip,
  bristle tip, Texture by preset id, smoothCurves, extras are reported, a `dataUrl` tip serves. `legacy_pigment::presets
  ::tests` (3): gradient refs/opacity kept, moved midpoint sampled, noise; style/shape/contour/adjustment map; a
  pattern is the same pattern twice. io lib `legacy_pigment:: tpl_map` filter: 84 passed.
- engine `tests/it/migrate_pigment_04.rs` (7): **every kind of the folder migrates** (22 presets: 6 swatches, 3
  gradients, 1 style, 1 pattern, 1 contour, 1 shape, 3 tool presets, 2 adjustment presets, 2 brushes, 2 settings; each
  checked: groups, colours, fg/bg stops, noise seed, curves and hue/sat params in A1's library, tool options, sampled
  tips, the flat 0.4 brush, pattern size and folder, style, shape box, contour, auto options saved, curve display);
  what is skipped has a reason (missing side file, the Adjustment Brush preset, stroke styles, Shadows/Highlights, the
  action set; `{ref}` built-ins neither added nor reported); **migrating twice adds nothing** (preferences JSON and
  preset revision unchanged; after a preferences round trip only brushes and patterns, which live in their own stores);
  the `presets` folder itself reads its parent's `settings.json`; **a corrupt kind file is skipped with a report
  entry** (bad JSON, wrong format) and the rest migrates; no `path` is an error, an empty folder finds nothing; **a
  `.pigment-bundle` built with `ZipWriter` imports** through Migrate Presets and through Export/Import Presets (base64,
  checked kinds only), twice adds nothing; hostile folders and bundles never panic.
- engine lib `migrate_cmds preset_file preset_manager presets::tools edit_menu_cmds`: 84 passed (upstream's three
  migrate tests unchanged and green; P1b's bundle test adjusted). Panic hunt (`--test panic_hunt -- --ignored`): 1
  passed. automation `workspace`: 56 passed.
- app `app_dirs` (nextest, 22): `the_old_apps_folder_follows_the_platform_rule` (XDG, relative XDG, no home, Pigment's
  overrides do not move it) and upstream's.
- ui-egui (nextest -j 3): `migrate_presets_ui::tests` (3): **with a scripted `legacy_presets_dir` the menu item opens
  the prompt; Cancel migrates nothing; OK migrates and sets "22 presets migrated."**, again "0 presets migrated.";
  **without it the folder dialog is asked (`ScriptedFiles`)** and migrates, an empty folder says "No Pigment 0.4 presets
  were found."; with `path` the engine runs directly. Plus `prefs_ui`, `io_tests` (bundle test adjusted),
  `preset_manager_ui`, `preset_files_ui`, `tool_presets_menu`: 87 + 19 passed. A wider run (`menus commands registry
  keymap dialogs i18n control`) was started before returning; see "Checks".

## Checks

`cargo fmt --all -- --check`; `cargo clippy -p photocraft-io -p photocraft-engine -p photocraft-ui-egui -p photocraft
--all-targets -- -D warnings`; `python3 scripts/pigment-rebrand.py --check`; panic hunt; `cargo xtask panel-commands`,
`test-binaries`, `layers`: all green. No crate, preference or panel command added, so `scorecard` was not needed (no
scorecard row names Migrate Presets).

## Not done (with why)

- **Stroke styles** (`stroke-styles` kind): Pigment has no stroke-style presets; reported per kind.
- **Shadows/Highlights adjustment presets**: A1's library has no such kind; reported.
- **The JS Actions panel's sets**: dropped by the spec (§8 item 5); reported per set with the reason.
- **Camera Raw presets/snapshots/profiles, fonts, keyboard shortcut and menu sets, colour books and profiles** (0.5
  kinds): not in the spec's mapping; reported per kind ("Pigment has no presets of this kind").
- **A bundle's `settings`** (`tools`, `brushes`, `painting`, `colorUI`, `typeFonts`, `keymap`): JS-only settings, not in
  the spec; noted in the reply.
- New strings ("Migrate presets from Pigment 0.4 at {folder}?", "Migrate Presets", "{n} preset(s) migrated.", "{message}
  {n} not migrated (first: {reason}).", "No Pigment 0.4 presets were found.") are English through `tl!`/`trn`,
  catalogues left to their fallback. The engine's skip reasons and notes are English (engine strings are not
  translated).

## For the next package

- `photocraft_io::legacy_pigment::presets` is now public: F/U/B packages that need a JS preset's mapping use it rather
  than reaching into `pub(crate)` mappers.
- A later package adding a preset kind Pigment did not have (e.g. stroke styles with B15, Camera Raw presets) adds an
  arm in `legacy::kind_for` and `run`'s `match`, and its fixture file to `tests/fixtures/pigment-0.4-presets/presets/`;
  the "Pigment has no presets of this kind" line in `migrating`'s test then goes away.
- **B18** (Adjustment Brush): once `adjustment-brush` is in `tpl_map::JS_TOOLS`, the fixture's "Adjust Brush" tool
  preset migrates; update `every_kind_of_the_folder_migrates` (tools 3 → 4, the `skipped` list).
- Export/Import Presets' Import of a `.pigment-bundle` now migrates (P1b's refusal is gone).
