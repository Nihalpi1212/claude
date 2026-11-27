# PKG-port-P3: noise gradients (row 26)

Built on `claude/pigment-photocraft` after `5a5cceb` (P2; PhotoCraft 057297b). Spec: PORTS-A §3.5 and §9 P3; REBASE-P
"P3" (it wins).

**CI first.** At the start the newest finished run was 46055487780 (`007cd8b`, P1b), **green**; P2's runs (46061145778
on `4fa6da5`, 46066083083 on `5a5cceb`) were running and have since finished **green**. Nothing red, so no CI commit.
**The next engineer checks CI first**: the run on `d54176d` (46074153799, in progress when this package returned) and
the run on this package's second commit (see "Commits"). Not waited for, as the brief says.

## Commits (pushed)

- `d54176d` Pigment noise gradients (P3), document, io and engine: NoiseGradient with the JavaScript Pigment's sampler,
  PSD/GRD/grdm noise keys, noise in the gradient commands
- the interface commit: see `git log` (subject "Pigment noise gradients (P3), interface: …")

## What was built

1. **Document**, `crates/doc/src/noise_gradient.rs` (new, Pigment's), tests in `noise_gradient/tests.rs`:
   - `NoiseGradient { roughness 0..1, model: NoiseModel { Rgb, Hsb, Lab }, min: [f32; 4], max: [f32; 4] (alpha last,
     default 0..1), restrict, transparency, seed: u32 }`, `#[serde(default)]` (JS `NOISE_DEFAULTS`: roughness 0.5, RGB,
     0..1, restrict off, transparency off, seed 1).
   - L2's sampler **moved here** (REBASE §P3 1): mulberry32 (`Mulberry`), the `noiseKnots` walk, `noiseSample`,
     `hsv_to_rgb`, `lab_to_rgb`. `sample(t)`, `bake() -> (colour stops sRGB 0..1, opacity stops)`, `fill_stops()`
     (as `Color`), `knot_stops()` (≤ 64), `sanitized()`, `to_json`/`from_json`/`from_json_over` (the command form:
     roughness and ranges in %, model name, 3 or 4 range values, seed any number → `Math.trunc(seed) | 0`), `seed_of`.
   - **The bake**: every knot; between knots, where straight RGB lines would not draw it (HSB, Lab, Restrict Colors),
     halves until the middle is within a third of an 8-bit level (depth ≤ 6). RGB without Restrict is the knots
     exactly. Opacity stops at the knots (empty when no transparency). A flat gradient (min = max on the three colour
     channels) is two stops of that colour exactly.
   - `noise: Option<NoiseGradient>` with `#[serde(default, skip_serializing_if = "Option::is_none")]` on
     `Fill::Gradient`, `GradientSource` and `effects::Gradient` (Overlay, glows, gradient strokes). Renderers unchanged:
     the stops are the bake.
2. **io**, `crates/io/src/grd_noise.rs` (new), tests in `grd_noise/tests.rs` and `tests/it/psd_noise_gradients.rs`:
   - descriptors: `noise_from_grad` / `noise_grad_desc` (`GrdF ClNs`, `ShTr`, `VctC`, `ClrS RGBC|HSBl|LbCl`, `RndS` long
     (the seed's bits), `Smth` /4096, `Mnm `/`Mxm ` four longs /100, as ag-psd 31's `serializeGradient`);
     `noise_stops` (read hook), `grad_or_noise` (write hook) for `GdFl` (`blocks.rs`) and the effects' `Grad`
     (`effects_map.rs`);
   - `.grd`: `grd_noise(bytes)` (aligned with `craft_psd::grd::parse`), `write_grd(grads, noise)` (patches
     `craft_psd::grd::write`'s output; no craft-libs bump);
   - `grdm`: `grdm_noise` (the 32 bytes after the expansion count and length: mode 1 = noise, seed u32, transparency,
     restrict, roughness u32 /4096, model 3 RGB / 4 HSB / 6 Lab, min/max four u16 /32768; layout as ag-psd 31's
     `grdm` handler), `patch_grdm` (writes them over `write_grdm`'s output of the knots), `noise_source`, `noise_map`;
     `gradient_bake::bake_source` bakes a noise source.
   - The `.pigment` importer (`legacy_pigment/gradient.rs`): `Noise` is now a thin parse into `NoiseGradient`;
     `Def::paint(reverse)` gives a noise gradient's bake, its Reverse as a flag and its settings (`paint.rs`, `styles.rs`
     use it); `source()` of a noise Gradient Map is `noise_source`; `map_stops` the bake.
3. **Engine**, `crates/engine/src/presets/gradients/noise.rs` (new), tests in `noise/tests.rs`:
   - `"noise": {…}` (read over the current settings) or `false` (solid: the knots become stops) in
     `gradient.presets.new`, `select` (shape and fill layer get it), `apply`, `stop {"action": "set"}`;
     `gradient.fill.create` (a preset's noise is kept), `gradient.fill.set`, `gradient.fill.get` (reports `noise`);
     `paint.gradient`; `layer.layerStyle.gradientOverlay` and `stroke`, and `layer.layerStyle.replace`'s in-place edit
     (`after_effect_edit`: an edit that changes the stops drops the noise; one that does not keeps it); a Gradient Map's
     `source: {"noise": …}` (`adjust_params`). Any other stop edit (`gradient.fill.stop`, `gradient.presets.stop` add,
     move, colour…) makes the gradient solid.
   - `GradientPreset.noise` (serde default, skipped when `None`): persists in the preferences (TOML-safe) and in
     `.pcpresets` (P1b's `tidy_gradient` rebakes it on import).
   - `gradient.presets.importGrd` imports noise gradients (no "skipped" warning; a noise gradient whose settings do not
     parse, e.g. HSL, is still skipped with a new wording); `gradient.presets.exportGrd` writes them as noise gradients.
   - Panic hunt: two param sets with adversarial noise for every command.
4. **Interface**, `crates/ui-egui/src/tools/gradient_ui/noise.rs` (new), tests in `noise/tests.rs`: the Gradient Editor
   panel's Gradient Type (`Segmented` Solid/Noise), Roughness (`SliderField`), Color Model (`Select` in a `Field`), a
   `RangeSlider` per channel (in `Field`s named R/G/B, H/S/B, L/a/b), Restrict Colors and Add Transparency
   (`Checkbox`), Randomize (`Button`; the next seed is a step of the gradient's own generator). Each change is one
   command on commit (tool: `gradient.presets.stop` `set`; fill layer: `gradient.fill.set`, one history step); a drag
   in progress shows through egui temp memory. Shown in `editor.rs` (tool gradient; the stop bar is hidden for a noise
   gradient) and `properties_panel.rs` (fill layer; above the framework's rows). Checked visually with a temporary
   wgpu render (not committed).
5. Docs: `docs/FORK.md` "Noise gradients" with every hook.

## Choices recorded (where the spec/REBASE and the code differ)

- **The `.pigment` importer now renders a JS noise gradient through the doc bake** (REBASE §7 said keep L2's 128
  samples and also set `noise`). One bake for every caller keeps "the stops are the bake" true, so a PSD save and a
  later edit agree; the bake is closer to the JS app than the samples were (knots exact). The L2 fixture
  (`v3-fill-gradient-noise`) still matches the JS PNG within its tolerance, and its settings now come back
  (`layer_kinds_tests.rs`).
- **A flat noise gradient ignores Restrict Colors** (the JS walk would desaturate it): upstream's constant-colour
  reading of Photoshop files (`constant_rgb_noise_color`, its test) is kept exactly, and the bake of min = max agrees.
- **Upstream's #6272 placeholder** now applies only to noise gradients whose settings do not parse (HSL model, broken
  `Mnm `/`Mxm `); `variable_or_transparent_noise_stays_a_fill_with_the_placeholder_ramp` was changed to expect the bake
  and to check the HSL placeholder. The raw `GdFl` round trip (`psd_noise_fill_roundtrip.rs`) is unchanged and green:
  the parsed fill equals itself, so the raw block is kept.
- **Upstream's `grd_import_adds_a_gradient_group`** expected the noise gradient skipped; it now imports (Photoshop's
  defaults for a file without settings). Changed and listed in FORK.md.
- **Gradient Map**: the editable `GradientSource.stops` of a noise map are its knots (≤ 64, classic, midpoints 50 %),
  so unaware code (the dialog, `adjust_params`' 64-stop limit) sees a sensible gradient; `grdm` is written with those
  stops plus the noise settings, so other readers get the knots. Editing noise in the Gradient Map dialog is not built
  (the spec's UI is the Gradient Editor's); a dialog edit of the stops drops the noise.
- **Layer styles**: the effects' own numeric `noise` (Noise %) shares the key; only an *object* `noise` is a noise
  gradient. `layer.layerStyle.gradientOverlay` builds a fresh effect (upstream), so its in-place edits go through
  `layer.layerStyle.replace`; noise is kept there unless the stops change. Glows read and write noise in PSD but have
  no noise param (not asked for).
- **The fill layer's stop bar stays** under the noise rows: the framework's `GradientFillEditor` cannot hide its stops
  (REBASE: do not patch craft). It shows the bake; editing a stop there makes the gradient solid.
- **Solid again** (`noise: false`): the knots become the stops (Photoshop keeps the previous solid gradient; we have no
  record of it).
- **No gradient `TrackFace` on the channel sliders**: building one needs a painter component; the tracks are plain (the
  fill layer's own preview strip shows the result; the canvas shows it for the tool).
- **Randomize** is deterministic (a mulberry32 step of the current seed): no clock on wasm, and tests can check it.
- **Seeds**: `u32` (the spec); Photoshop's `RndS` long is written as the same bits.

## Hooks into upstream files

All in FORK.md, "What Pigment added › Noise gradients" (two tables' rows): `doc/src/{lib,adjust,effects}.rs` (the
fields, `pub mod noise_gradient`), the `noise: None`/`noise: _` lines in `vector/src/lib.rs`, `io/src/{affinity,svg}.rs`,
`engine/src/cmd/vector_cmds/params.rs`, `ui-egui/src/tools/shape_paint_ui.rs` and test literals; `io/src/lib.rs`,
`blocks.rs` (read and write), `effects_map.rs` (read and write), `adjust_map.rs` (`grdm` read and write),
`gradient_bake.rs` (`bake_source`); `engine/src/presets/gradients.rs` (`pub mod noise`, the field, `to_json`,
`from_params`, `tool_preset`, `preset_param`, `select`, `apply`, `new_preset`, `apply_preset_stop`, params strings),
`gradient_fill_cmds.rs` (`preset_param`, `apply_set`, `new_layer`, `apply_stop`, `describe_fill`, params strings),
`preset_import_cmds.rs` (`import_grd` + its test), `layer_style.rs` (`gradient()`, `overlay_stroke`, the overlay arm,
params strings), `adjust_params.rs` (`source_params`, `gradient_source`), `paint_cmds.rs` (params string),
`tests/panic_hunt.rs`; `io/src/blocks/tests.rs` (the #6272 placeholder test), `io/tests/it/main.rs`;
`ui-egui/src/tools/gradient_ui.rs` (`mod noise`), `gradient_ui/editor.rs`, `gradient_ui/properties_panel.rs`.
Pigment's own files touched: `legacy_pigment/{gradient,paint,styles,layer_kinds_tests}.rs`,
`presets/gradients/export_grd.rs` (P1a), `edit_menu_cmds/preset_file.rs` (P1b).

## Tests (all green here)

- doc `noise_gradient::tests` (6): mulberry32 = the app's sequence for seeds 7 (L2's constants) and 42; **samples equal
  JS `sampleGradient` for three seeds/models** (7 RGB+Restrict, 42 HSB+Transparency, 2024 Lab; generated with node 22
  from the JS 0.5 tree's `gradient-model.js`, within 0.02 of a level); the bake draws the gradient within 0.02 and is
  deterministic per seed, another seed differs, RGB without Restrict is the knots; **min = max is flat** in every model
  (exact colour, constant opacity); **Restrict keeps saturation ≤ 0.85** (40 seeds × 3 models); JSON round trip,
  clamping, hostile values (NaN, ∞), missing keys load.
- io `grd_noise::tests` (5): descriptor settings round trip in every model, defaults for missing keys, HSL and broken
  ranges refused; **a noise `GdFl` fill round trips** (every key, the bake) and Photoshop sees `ClNs` with no stops;
  **a noise Gradient Overlay round trips** (`lfx2`); **a noise Gradient Map round trips its `grdm`** in every model, renders
  its bake, the knots are the editable stops, a solid map is mode 0, every prefix and flipped byte reads without panic;
  **`.grd`** with a noise gradient: craft-psd sees the flag, `grd_noise` the settings, no noise = craft-psd's bytes.
  `tests/it/psd_noise_gradients.rs` (2): **a document with a noise fill, a noise Gradient Map and a noise Gradient Overlay
  through PSD and back keeps every setting** (twice); **a noise Gradient Overlay renders non-uniformly**.
  `legacy_pigment::layer_kinds_tests`: the 0.4 fixture opens with `noise` set (the JS settings) and its stops the bake,
  pixels within the JS PNG tolerance. io lib all (834) and it (600 + the new ones): green, including the #6272 test.
- engine `presets::gradients::noise::tests` (5): `gradient.presets.stop set` with noise, partial settings, **persists
  through `prefs_value` → `load_prefs_json`**, `false` → knots, a stop edit drops it, solid prefs have no `noise` key;
  a preset → `gradient.fill.create` keeps noise (**one history step**), `gradient.fill.set {noise}` rebakes (one step),
  `.pcraft` keeps it, undo/redo, `gradient.fill.stop` drops it, `paint.gradient` with noise paints deterministically
  and non-uniformly; **a Gradient Overlay with noise renders non-uniformly**, an in-place edit keeps it, new stops drop
  it, a stroke takes it, a Gradient Map source takes it; **`.grd` import no longer warns "skipped"**, exportGrd writes it,
  `.pcpresets` carry it; bad noise params are errors and change nothing, extremes are clamped. Engine lib all: 4233
  passed, 17 ignored (upstream's `grd_import_adds_a_gradient_group` adjusted). Panic hunt: 1 passed.
- ui-egui `tools::gradient_ui::noise::tests` (2): **switching a fill layer to Noise is one history entry; Randomize
  changes the seed** (to `next_seed`), Restrict Colors, undo, Solid; the tool gradient turns noise, its stop bar is
  hidden, Randomize, Add Transparency gives opacity stops, Solid brings the stop bar back. `gradient_ui` filter: 15
  passed; ui-egui `--lib --tests` whole suite through nextest -j 3: see "Checks".
- compose, vector, format, doc through nextest: green; gpu: 196 of 197, the one failure
  (`bounded_readback_preserves_effect_halos_across_seams`) fails the same without this package (container GPU).

## Checks

`cargo fmt --all -- --check`; `cargo clippy -p photocraft-doc -p photocraft-io -p photocraft-engine -p
photocraft-compose -p photocraft-vector -p photocraft-gpu -p photocraft-format -p photocraft-ui-egui --all-targets -- -D
warnings`; `python3 scripts/pigment-rebrand.py --check`; panic hunt; `cargo xtask panel-commands`: all green. No crate,
preference or panel command added, so `layers`/`scorecard` were not needed.

Disk: a ui-egui test build with examples hit a full disk (bus error in the linker); the brief's cleanup (test
executables over 20 MB, `incremental`, and the large example executables) freed it. Run ui-egui through
`cargo nextest run -p photocraft-ui-egui --lib --tests -j 3` here to skip the examples (clippy `--all-targets` checks
they build).

## Not done (with why)

- Editing noise in the Gradient Map dialog and in the Layer Style dialog's gradient picker: not in the spec's UI (REBASE
  says out of scope for the overlay); both keep a noise gradient and show its knots / bake.
- Gradient-coloured channel tracks: no `TrackFace` painter for it without a component; plain tracks (see Choices).
- Hiding the fill layer's stop editor in noise mode: needs a framework option (`GradientFillEditor`); a craft-libs
  request, not forked.
- Photoshop's own noise algorithm: unknown; Pigment draws Photoshop's settings with the JS app's walk, so a noise
  gradient from Photoshop looks different (same settings, other noise). Photoshop's pixels still ride along as the
  fill cache where the file has them.
- New strings ("Gradient Type:", "Solid", "Noise", "Roughness:", "Color Model:", "RGB", "HSB", "LAB", "Restrict
  Colors", "Add Transparency", "Randomize", channel letters) are English through `tl!`.

## For the next package

- **P4** (Migrate Presets): JS gradient presets go through `legacy_pigment::gradient::Def`; for a preset use
  `Def::paint(false)` (or `def.noise` directly) and `crate::presets::gradients::noise::preset(name, n)` on the engine
  side to make a noise `GradientPreset`; a solid one through `Def::source()`/`fill_stops`. `photocraft_doc::NoiseGradient`
  is public; `legacy_pigment` is still `pub(crate)` there, P4 adds the public wrapper REBASE asks for.
- Any new code that writes the stops of a `Fill::Gradient`, `effects::Gradient` or `GradientPreset` must clear `noise`
  (or set it with `NoiseGradient::fill_stops`), or a PSD save writes the old noise settings: the invariant is "the stops
  are the bake".
