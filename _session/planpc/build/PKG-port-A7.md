# PKG-port-A7: HDR Toning methods, Match Color statistics, Replace Color preview, solid fill in Properties (rows 9, 18, 19, 20)

Built on `claude/pigment-photocraft` (PhotoCraft 057297b), after A1 to A6. Spec: PORTS-A §2.8 to §2.11, §9 A7;
REBASE-A "A7" (it wins). Read with PKG-port-A1.md (presets) and PKG-port-A2.md (the Preset row).

## CI at the start

The newest finished Pigment CI run was green (45998648821, A5's interface commit); A6's run (46022906062) was still
running. It then finished red, but in "Install Linux build dependencies" (apt, exit 127), not in the code. Commit
`611e2b2` "Pigment CI: leave Microsoft's package repository out of apt-get update" (not this package's; it appeared in
the shared checkout while A7 worked) fixed it, and its run (46027202552) is green. So there was nothing for A7 to fix.
CI on A7's pushes was not waited for (46032481221 on the engine commit was still running, 46038027153 on the
interface commit pending).

## Commits (both pushed)

- `9f07b56` Pigment HDR Toning methods and Match Color statistics (A7), engine: the Method menu's three methods,
  sourceStatistics, image.adjustments.matchColor.statistics
- `75ec448` Pigment HDR Toning methods, Match Color statistics, Replace Color preview, solid fill in Properties (A7),
  interface

(Three release commits by someone else, `ce7b7b8`, `c5ec363`, `3a8a4e9`, landed between the two.)

## What was built

1. **HDR Toning's Method menu** (row 9).
   - algo `crates/algo/src/tone/hdr_methods.rs`: `HdrMethod {LocalAdaptation (default), EqualizeHistogram,
     ExposureGamma, HighlightCompression}` (camelCase serde; `parse` reads the JS ids `local-adaptation`… too; `uses(key)`
     says which settings act), `hdr_toning_with(px, w, h, &HdrToning, method, linear)`. Local Adaptation is upstream's
     `tone::hdr_toning`, unchanged. The other three are ports of JS `hdr.js` `toneMap` branches: decode to linear (sRGB
     curve; a 32-bit document is linear already and is written back linear), map, encode. Equalize Histogram is a
     4096-bin alpha-weighted histogram of the encoded Rec. 601 luma; to land each pixel in the JS bin it quantises the
     linear value to the JS app's 65536-step table first.
   - **Every pixel of the three methods equals Pigment 0.4's own output within one level** (`hdr_methods/js-cases.json`,
     written by `make-cases.mjs` from `99dbdee`'s `hdr.js`; README beside it).
   - engine `image.adjustments.hdrToning` takes `"method"` (spec string `"localAdaptation|equalizeHistogram|exposureGamma|
     highlightCompression"="localAdaptation"`); an unknown one is refused. Journaled as before, so Actions record it.
     Not mapped in `.atn` (REBASE: `atn_cmds` has no hdrToning), so no `Mthd`.
   - The 8 built-in HDR presets (A1's) now name `"method":"localAdaptation"`; an HDR preset's `method` must parse.
2. **Match Color statistics** (row 18), engine `crates/engine/src/cmd/adjust_cmds/match_statistics.rs`:
   - `image.adjustments.matchColor` takes `"sourceStatistics":{"mean":[L,a,b],"std":[L,a,b]}` in place of `source`
     (both given → refused; `source: -1` beside it is fine). Recorded by Actions, so a played-back step needs no source.
   - `image.adjustments.matchColor.statistics` (not journaled): with `source` (+ `sourceLayer`,
     `useSelectionInSource`) or given `statistics` → `{name, mean, std, file}` (`file` = the JS file's text; written to
     `path` when given); without them reads `data` (text, + `fileName`) or the file at `path` → `{name, mean, std}`.
     Files up to 64 KiB; malformed JSON, missing/short arrays, negative std, huge numbers refused.
   - The file is JS's: `{"format":"pigment-match-color-statistics","version":1,"name","mean","std"}` (3 decimals).
   - **White point**: JS Lab is D65 (plain sRGB XYZ over the D65 white), PhotoCraft's D50 (Bradford, the ICC PCS). The
     file keeps D65; params and answers are D50. Converted through linear sRGB (both apps' starting point): means exactly,
     std through the conversion's slope at the mean (channels independent). Exact for a colour; for a broad bimodal image
     no mean/std conversion is exact (the fixture was first oranges + blues and the conversion did not help there; it is
     now a unimodal sunset, where it does — see Tests).
   - Automation policy: the command with a `path` is in `command_uses_ambient_path`.
3. **Interface** (`crates/ui-egui/src/dialogs/filter_dialog/pigment.rs`, tests in `pigment/tests.rs`):
   - **HDR Toning** dialog: the Preset row first (A2's row through the new `preset_row::params_row`, a params-based form:
     Default when the settings have every default, else the first preset whose keys match, numbers to 1/1000; a pick
     writes the preset over the defaults; New/Rename/Delete/Reset go to the pump as `__hdrPresetAsk`), then
     `Method:` (Photoshop's order, `tl!` labels), the Local Adaptation rows (`radius strength detail shadow highlight
     vibrance saturation`) `visible_when` Local Adaptation, Exposure `enabled_when_in` Local/Exposure-Gamma/Highlight
     Compression, Gamma Local/Exposure-Gamma, and a full-width note for Equalize Histogram.
   - **Match Color**: a `Statistics` row after Source Layer with Load Statistics… / Save Statistics… (Save enabled with a
     document or the loaded statistics as source) and, while the loaded ones are the source, their numbers. The press
     writes `__statisticsAsk`; the pump runs `pick_file_bytes_filtered(&["json"])` → the statistics command (`data`) →
     fields `__statistics` (the D50 answer) and `source = "stats"`; or the command (source/loaded) → `pick_save("{name}
     statistics.json")` + `services.write` (works on the web too). The builder hook adds `("stats", "Statistics:
     {name}")` to the Source choice while `__statistics` is held; `command_params` maps `source:"stats"` to
     `sourceStatistics` (and drops `source`/`sourceLayer`), so the live preview and OK use them.
   - **Replace Color**: a full-width `Preview` row after Range: the framework's `PreviewPane` (fixed view, the proxy's
     aspect) with a `Segmented` Selection / Image beside it, in a `Row`/`Stack` as Color Range's dialog lays it out (a
     plain `ui.vertical` overlapped the next rows: the form measures custom rows in a first run). The pump keeps a
     `ReplacePreview` (proxy at most 200 px, its picture, the mask) in the egui context's data, rebuilt when the
     document revision or the matching params change; the mask is `color_range_ui::proxy_mask` with
     `color_range_params` (Replace Color's matching mapped as the engine does: one colour → `color`; several or
     subtracted samples, or localized with a point → the samples; subtractions from no samples keep `color`). A press on
     the pane with a dropper armed writes `__previewPick` (proxy pixel centre × k, Shift/Alt); the pump calls
     `rows::replace_color_sample`, the canvas's rule.
   - **Solid fill in Properties** (`crates/ui-egui/src/panels/solid_fill_props.rs`): a `Color` section with a `Swatch`
     (showing the live picker colour while it edits the fill, via `solid_fill_ui::thumbnail_color`) and the hex; a click
     runs `menus::invoke("layer.layerContentOptions")` → the layer's Color Picker (live preview, Cancel, OK one step).

## Choices recorded (where the spec/REBASE and the code differ)

- **The method is an argument, not a field of `HdrToning`** (spec: `HdrToning.method`). Upstream builds `HdrToning`
  literally for Merge to HDR Pro (`photo_cmds.rs`) and replays it in `checked_hdr`; a field would have meant hooks
  there and a method the checked path ignores.
- **HDR strength in the presets stays A1's `/100`** (spec said `/25`): A1 already translated the built-ins that way and
  recorded it; A7 only added `method`.
- **Exposure acts on Highlight Compression**, as the JS app did (REBASE: enabled for Local Adaptation and Exposure and
  Gamma only, Photoshop's). JS users had it; the brief keeps what they had.
- **The HDR dialog has no Toning Curve row**: upstream's spec parser makes no row for `curve` (`[[in,out],…]`), as
  before A7. Presets with a curve still carry it (a pick sets it as a field without a row, a pick without one removes
  it).
- **History label "Solid Color"** for the Properties swatch's OK (upstream's `layer.fill.solidColor.set`), not
  Photoshop's "Modify Fill Layer", as REBASE says.
- **The swatch's section comes first** in a solid fill's Properties, as a gradient fill's gradient does.
- **Replace Color's thumbnail is built in Pigment's module** (six lines like `color_range_ui::thumbnail`) and only
  `proxy_mask` was made `pub(crate)` (REBASE: `ensure_proxy`/`proxy_mask`): `ensure_proxy` caches into
  `app.color_range`, which Color Range's `take` clears every pass its dialog is not open.
- **Pump → rows through the egui context's data** (HDR preset list, Replace Color pictures) instead of an app field or
  REBASE's `Arc<Mutex<PreviewState>>`: no `PhotocraftApp` field, no lib.rs/app.rs hook.

## Hooks into upstream files (all in FORK.md, "What Pigment added › HDR Toning's methods, Match Color's statistics, Replace Color's preview, a solid fill in Properties")

| File | Hook |
|---|---|
| `crates/algo/src/tone.rs` | `pub mod hdr_methods;` |
| `crates/engine/src/cmd/adjust_cmds.rs` | `pub mod match_statistics;`; `match_color` reads `match_statistics::given` first; `hdr_toning` reads `method`, calls `hdr_toning_with`; the two params strings; `specs()` chains `match_statistics::specs()` |
| `crates/automation/src/workspace.rs` | the statistics command with a `path` in `command_uses_ambient_path` |
| `crates/ui-egui/src/dialogs/filter_dialog.rs` | `mod pigment;` + `pigment_pump` re-export; the builder's rows via `pigment::params_for`; `command_params` calls `pigment::command_params_of` |
| `crates/ui-egui/src/dialogs/filter_dialog/rows.rs` | `custom_rows` HDR arm; one line at the end of `match_color` and of `replace_color` |
| `crates/ui-egui/src/dialogs.rs` | `run`: `filter_dialog::pigment_pump(app)` after `reconcile_match_color` |
| `crates/ui-egui/src/dialogs/color_range_ui.rs` | `proxy_mask` `pub(crate)` |
| `crates/ui-egui/src/panels.rs` | `pub(crate) mod solid_fill_props;` |
| `crates/ui-egui/src/panels/layer_props_ui.rs` | `properties`: `solid_fill_props::section` before the gradient branch |

Pigment's own files changed: `presets/adjustments.rs` (HDR built-ins' `method`), `cmd/adjust_preset_cmds.rs` (HDR
`method` validated), `dialogs/adjust_editors/preset_row.rs` (drawing shared by `preset_row` and the new `params_row`,
`params_match`, `ParamsRowOut`).

## Files

New: `crates/algo/src/tone/hdr_methods.rs`, `crates/algo/src/tone/hdr_methods/{tests.rs, js-cases.json,
make-cases.mjs, README.md}`, `crates/engine/src/cmd/adjust_cmds/match_statistics.rs`,
`crates/engine/src/cmd/adjust_cmds/match_statistics/{tests.rs, js-statistics.json, js-source.json, make-fixture.mjs,
README.md}`, `crates/ui-egui/src/dialogs/filter_dialog/pigment.rs`, `crates/ui-egui/src/dialogs/filter_dialog/pigment/tests.rs`,
`crates/ui-egui/src/panels/solid_fill_props.rs`, `crates/ui-egui/src/panels/solid_fill_props/tests.rs`. Edited: the
hook files above, the three Pigment files, `docs/FORK.md`.

## Tests (all green here)

- algo `tone::hdr_methods::tests` (6): the three methods equal the JS app's output within a level (5 cases, every
  pixel, alpha kept); Equalize Histogram flattens a skewed (x²) ramp into 8 equal bins ±15 %, monotonic, black to 0,
  brightest to 1, greys stay grey; Exposure and Gamma +1 doubles linear values (encoded and 32-bit linear), gamma 0.5
  squares; Highlight Compression ≤ 1 and monotonic for exposures −3..5, 32-bit radiance compressed in order;
  Local Adaptation = upstream's; transparent pixels kept; empty/mismatched buffers; ids/labels/`uses`. Whole algo lib
  988 passed.
- engine `cmd::adjust_cmds::match_statistics::tests` (8): Save from a document, load the file in another session,
  Match Color with the loaded statistics equals Match Color with the document (≤ 1/255), one history step, statistics
  command not journaled; **the JS-written file loads as PhotoCraft's own D50 statistics of the same pixels** (means
  within 0.05, std within 3 %, and at least 10× closer than the unconverted D65 numbers), saved back gives JS's numbers
  (±0.05), a file without a name is named after the file; bad statistics (10 malformed texts, missing file, nothing,
  bad source, both, malformed `sourceStatistics`, source + statistics) are errors with no history; an action records
  `sourceStatistics` and plays back; the D50↔D65 conversion round-trips and keeps greys; HDR: the four methods differ,
  each one step + undo, no method = Local Adaptation, JS id accepted, bad method refused, `method` recorded and played
  back; 32-bit Exposure and Gamma +1 doubles linear values; built-in HDR presets name their method, a bad method is
  refused. Engine lib filters `adjust_cmds adjust_preset presets hdr match` 318 passed; `--test it` filters `hdr
  match_color adjust prefs registry spec` 50 passed; panic hunt (`--ignored`) 1/1 with the new command and `method`.
- automation lib `workspace` 56 (incl. `registry_filesystem_path_params_are_classified`).
- ui-egui `dialogs::filter_dialog::pigment::tests` (6), real pointer input where it says so:
  - HDR rows by method: Radius/Detail/Saturation shown only for Local Adaptation, the note for Equalize Histogram,
    Exposure/Gamma enabled per method; OK with Exposure and Gamma +1 doubles the linear value, one step;
  - **picking "Monochromatic High Contrast" by pointer** sets its settings and the method back to Local Adaptation;
    New… (the row's ask) saves "Mine" with the dialog's settings only, the row lists it at once;
  - **Match Color by pointer**: Save Statistics… disabled with no source; with a document it writes the JS file (format,
    name) through the file dialog; **Load Statistics…** with the JS fixture makes "Statistics: Sunset" the source (shown
    in the Source menu), the numbers show, `command_params` sends `sourceStatistics`, OK warms the image in one step;
    a JSON file without statistics is refused in the status bar and the source stays;
  - **Replace Color**: the preview is the proxy's size (40×30, k 1); the mask selects the foreground's half; Image shows
    the picture; **a press on the preview's red half with Add to Sample adds one point there**, sets the From colour, the
    preview follows (the red half), OK with a hue shift changes only the red half; the preview params follow the
    command's matching rules (4 cases).
- ui-egui `panels::solid_fill_props::tests` (3), by pointer: the swatch shows the fill colour, opens the Color Picker,
  the swatch follows the live preview, the document waits for OK, OK changes the fill in one step, one undo restores;
  Cancel changes nothing; other layers have no fill swatch.
- Unchanged and green: ui-egui lib filters `preset_row filter_dialog adjust_dialog color_range solid_fill layer_props
  properties filter_preview adjustment_presets dialogs::tests menus::` (251), `assistant panel registry dock
  layers_tree i18n` (517), all with `--test-threads 2`.

## Checks

All green: `cargo fmt --all -- --check`; `cargo clippy -p photocraft-algo -p photocraft-engine -p photocraft-automation
-p photocraft-ui-egui --all-targets -- -D warnings`; `python3 scripts/pigment-rebrand.py --check` (it rewrote two
"PhotoCraft" words in the engine module's strings to "Pigment" before the engine commit); the panic hunt; `cargo xtask
egui-fork`, `layers`, `panel-commands` (the swatch dispatches `layer.layerContentOptions`), `test-binaries`, `scorecard
--check` (up to date). `cargo test -p xtask` not run: no crate, preference or panel command added. Not run: the whole
ui-egui suite and the whole workspace (CI runs them).

## Rows done and not done

- Row 9 HDR Toning Method menu and presets: done (three methods, the dialog's rows per method, the Preset row with
  the 8 built-ins). Not done: `.hdt` files (the spec drops them: no public layout, JS did not read them); a Toning Curve
  row (upstream's dialog has none).
- Row 18 Match Color Save/Load Statistics: done. `.sta` dropped as the spec says.
- Row 19 Replace Color Selection/Image preview: done. Approximation: Localized Color Clusters with one point preview
  the colour sampled at the point (Color Range's rule), while the command matches the dialog's From colour at that
  point; they differ only when the From colour was edited after the sample.
- Row 20 Solid colour in Properties: done (history label "Solid Color", see Choices).
- Translations: new English strings use the catalogue fallback: "Method:", "Local Adaptation", "Equalize Histogram",
  "Exposure and Gamma", "Highlight Compression", "Spreads the luminance histogram evenly. This method has no
  settings.", "Statistics", "Load Statistics…", "Save Statistics…", "Statistics: {name}", "Preview", "View",
  "Selection", "Image", "Color".

## For the next package (group P and later)

- `preset_row::params_row(ui, kind, entries, current, defaults)` is the Preset row for any dialog that keeps command
  params (no `AdjustValue`); `params_match` is the JS `sameSettings` rule on params.
- A parameter dialog's custom row that needs the app: write a private `__` field and answer it in
  `filter_dialog::pigment::pump` (runs each pass before the dialogs); hand data back through `ctx.data` (see
  `HdrPresets`, `ReplacePreview`). Draw complex rows inside craft `Row`/`Stack`, not `ui.vertical`: the form runs a
  custom row's body twice (measure, then draw).
- `set_json_field` on a custom row stores `FieldValue::Json`; `DialogFields::text` still reads a JSON string.
- P1b (`.pcpresets`): HDR presets now carry `method`; Match Color statistics are not presets (their file is the JS
  JSON), nothing to export there.
- P4 (Migrate Presets): the engine accepts JS HDR presets with `method:"exposure-gamma"` etc. (`HdrMethod::parse` reads
  the JS ids, `hdr_params` validates them), but the dialog's Method menu holds the camelCase ids, so a picked preset
  with a JS id would leave the menu unchanged: write `HdrMethod::parse(js).id()` when migrating.
