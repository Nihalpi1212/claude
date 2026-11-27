# PKG-port-A3: Auto Color Correction Options, Auto in Curves and Brightness/Contrast, eyedropper targets (rows 2, 5, 14, 15, 16)

Built on `claude/pigment-photocraft` (PhotoCraft 057297b), after A1/A2. Spec: PORTS-A §2.2, §2.4, §9 A3;
REBASE-A "A3" (it wins). CI at the start: the newest finished Pigment CI run was green (45959676448, A1's model
commit) while A2's runs were still going. **A2's run then finished red** (45965030354, and 45973984660 on this
package's engine commit): 14 `photocraft-ui-egui::it tone_targets::*` tests failed because their `names` helper
listed every dropdown of the dialog, and A2 added the Preset dropdown. Fixed in its own commit `e98b7a1`.

## Commits (pushed)

- `975b565` Pigment Auto Color Correction Options (A3), engine: the algorithms, the preference,
  image.adjustments.autoOptions and .auto, Image › Auto with options, eyedropper targets
- `e98b7a1` Pigment CI: tone_targets reads the channel dropdowns without the Preset row's picker (the red CI)
- `2d1fc97` Pigment Auto Color Correction Options (A3), interface: Auto in Levels, Curves and Brightness/Contrast,
  the options dialog, eyedropper target colours

CI on the last push was not waited for.

## What was built

1. **Algorithms**, `crates/algo/src/tone/auto_options.rs` (pure): `AutoAlgorithm` (`monochromatic`, `perChannel`,
   `darkLight`, `brightnessContrast`; JS ids `mono`/`brightness` parse too), `AutoOptions` (Default = JS
   `AUTO_DEFAULTS`; colours are `[u8;3]`, as the JS app's `rgbOf`, not the spec's `[f32;3]`), `Levels5` (8-bit
   levels, JS `levelsLut`), `Sample` (visible pixels, RGB + luma histograms, thinned past 4 M), `auto_levels(sample,
   o) -> AutoLevels {composite, channels: Option<[Levels5;3]>}` (JS returns `rgb` + nullable `r/g/b`; the spec's
   `[Levels5;4]` could not say "no channels"), `luminosity_options` (non-RGB documents: JS `autoTonalParams`),
   `curve_points` (JS `curvePointsFromLevels`), `auto_brightness_contrast`, `gamma_for`, `clamp_clip`.
   Ported line for line, JS rounding (`Math.round` = half up) included. **Every one of the 12 Levels cases, 3
   Curves/Gray cases and 4 B/C cases equals the JS app's own output** (`auto_options/js-cases.json`, written by
   `make-cases.mjs` with Pigment 0.4.0's functions on five synthetic 24×24 images; README names the commit).
2. **Engine**, `crates/engine/src/cmd/auto_options_cmds.rs`:
   - `Preferences.adjustments: AdjustmentPrefs {auto_options: AutoOptionsPrefs, auto_options_saved: bool}`
     (`[adjustments]` in config.toml). `AutoOptionsPrefs` serializes camelCase
     `{"algorithm","snapNeutralMidtones","shadowClip","highlightClip","shadowColor","midtoneColor","highlightColor"}`;
     **validation is its serde** (`try_from`): clips clamp to 0..9.99 (50 → 9.99), unknown algorithm or bad colour is
     refused; so `prefs.set` needed no `validate.rs` hook (REBASE listed one). JS keys `snap`, `midColor` accepted
     (for P4's migration of `settings.adjust.autoOptions`).
   - `image.adjustments.autoOptions {"options"?,"saveAsDefaults"?,"reset"?} → {options, saved}` (journal false).
   - `image.adjustments.auto {"kind":"levels|curves|brightnessContrast","layer"?,"filter"?,"options"?}` → the params
     of that command (journal false; reads like `blackWhite.auto`: below an adjustment layer, below a smart filter,
     or a pixel layer's own pixels; whole canvas). This is the spec's `auto_params` as a command, so agents can do
     what the buttons do; `auto_params(kind, &AutoLevels)` / `auto_levels(sample, o, mode)` are the pub fns.
   - Image › Auto Tone/Contrast/Color (`edit_cmds::auto_adjust` hook): explicit option params (recorded by Actions)
     → else saved clip/targets with Photoshop's per-command algorithm (Tone PerChannel, Contrast Monochromatic,
     Color DarkLight + snap; the JS app's rule) → else **upstream's own Auto, unchanged**.
   - Eyedropper targets, `crates/engine/src/adjust_params/targets.rs`: `Targets`, `adjustment_eyedropper_with`
     (upstream's eyedropper, then output ends moved to the shadow/highlight target per channel; a coloured midtone
     target re-anchors each channel at the target's channel), `of_param` (the new optional `eyedropper.targets`
     `{"shadow","midtone","highlight"}` param, else the saved targets). **Neutral targets = upstream exactly**
     (tested against `adjustment_eyedropper`). Grayscale uses the target's luma. A Curves end point that upstream
     kept as a "plateau" (its fallback when moving would merge points) keeps its output (recorded).
3. **Interface**:
   - `adjust_editors/auto_row.rs`: Pigment's eyedropper row (a copy of the framework's `TonePickerRow`, same labels,
     icon, `escape_disarms`, canvas pass-through) that reports a double-click (`AutoAsk::PickTarget`, the picker
     stays armed); `levels_auto` takes the framework's "Auto" `Set` out of the pass (and the value back) and hands it
     to the host; `buttons` draws Auto (Curves, B/C) and Options… (Levels, Curves) **in a row below the editor**
     (choice recorded: Photoshop has them beside the Channel select, inside the framework panel). Alt-click on Auto
     (Levels, Curves) = options dialog.
   - `dialogs/auto_options_ui.rs`: `State {session, open, picking}` on `app.auto_options`. Auto applies
     `image.adjustments.auto` with the options in use (session's, else saved). **Levels keeps the framework's Auto
     (PhotoCraft's 0.1 % composite rule) until options were saved or chosen this session** (REBASE's rule); Curves
     and B/C always use the engine (they had no Auto). The options dialog is a framework `HostedParamDialog`
     (`open_child` over the adjustment dialog; alone over Properties): radio Algorithm, Snap Neutral Midtones, three
     colour rows, two Clip numbers (0..9.99), Save as defaults. Each change previews in the parent (dialog value /
     Properties' `live_adjust`); Cancel restores; OK keeps it, saves with the box, **else the options stay for the app
     session** (`State::session`, choice recorded: Photoshop keeps them for the open dialog only). Double-clicking an
     eyedropper opens the Color Picker for its target (dialog: child of the adjustment dialog; Properties:
     `PickWindow::Properties`), then the `StandardPrompt` "Save the new target colors as defaults?" Yes/No with
     "Don't show again" (`PREF = "pigment.saveTargetColors"`); No keeps them for the session. Properties'
     eyedropper gets session targets through `with_targets` (`eyedropper.targets`).
   - A gray plane target (mask, channel, Quick Mask) in the dialog: the options' Auto refuses with a status line
     (they read colour); Levels' framework Auto still works there when no options apply.

## Hooks into upstream files (all in FORK.md, "What Pigment added › Auto Color Correction Options")

| File | Hook |
|---|---|
| `crates/algo/src/tone.rs` | `pub mod auto_options;` |
| `crates/engine/src/prefs.rs` | field `adjustments` |
| `crates/engine/src/cmd.rs` | `pub mod auto_options_cmds;`, `v.extend(auto_options_cmds::specs());` |
| `crates/engine/src/cmd/edit_cmds.rs` | `AUTO_PARAMS` const; `auto_adjust` takes `p` and calls `auto_options_cmds::auto_adjust` first; three specs' params |
| `crates/engine/src/adjust_params.rs` | `pub mod targets;`; two eyedropper calls go through `targets::adjustment_eyedropper_with` |
| `crates/ui-egui/src/dialogs/adjust_editors.rs` | `pub mod auto_row;`; `AdjustAsk::AutoOptions`; B/C, Levels, Curves arms (pickers row, Auto hand-off, buttons) |
| `crates/ui-egui/src/dialogs/adjust_dialog.rs` | `answer_asks` arm + `answer_target` in the colour loop; `pick` uses targets |
| `crates/ui-egui/src/dialogs/adjust_editors/session.rs` | `layer_editor` ask arm (commit, one step) |
| `crates/ui-egui/src/dialogs/layer_picker.rs` | `sample_at`: `with_targets` |
| `crates/ui-egui/src/dialogs.rs` | module, `FAMILY` in `PARAM_FAMILIES`, `take` in `TAKERS`, `answer_prompt` in `PROMPTS`, `PREF` in `dont_show_again_keys` (array 5 → 6) |
| `crates/ui-egui/src/lib.rs`, `app.rs` | field `auto_options` + `Default` |
| `crates/ui-egui/tests/it/tone_targets.rs` | the CI fix: `names` leaves out the Preset picker (listed under "Adjustment presets" in FORK.md) |

Also regenerated `docs/scorecard.md` (prefs count 202 → 203).

## Tests (green here)

- algo `tone::auto_options::tests` (7): all JS cases; defaults/clamping; clip 0 vs 2 % differ; Snap Neutral takes the
  cast out of a grey (and a coloured midtone target tints it); empty/transparent/flat/huge samples.
- engine `cmd::auto_options_cmds::tests` (12): prefs form, clamp 50 → 9.99 via `prefs.set`, JS keys, refusals;
  command read/save/reset, never journaled; **through the real `SettingsStore` (config.toml)**; `auto` reads the
  layer / below an adjustment layer (layers above ignored), no-op on a full-range image (B/C brightness within a few
  levels: the JS formula on a 32-step ramp); upstream Auto kept until saved; **`image.autoColor`/`autoTone`/
  `autoContrast` with saved options = `image.adjustments.levels` with the `auto` params**, one history step,
  undo/redo; explicit options journaled for Actions; per-command algorithms; hostile params; Grayscale.
- engine `adjust_params::targets::tests` (5): neutral = upstream; black/white map to targets (Levels, Curves,
  Grayscale); coloured midtone; `eyedropper.targets` and saved targets through `image.adjustments.levels`; hostile.
- engine: `auto adjust` lib filters (239), `prefs` + `eyedropper` (124), all `--test it` (741, incl.
  `prefs_usage`), panic hunt (1/1). automation lib (149).
- ui-egui `dialogs::auto_options_ui::tests` (8), by pointer: Levels Auto keeps the framework rule then uses saved
  options; **Alt-click Auto opens the dialog, it previews, a changed algorithm previews again, Cancel restores the
  Levels fields**; Options… OK keeps the session options (clip clamped), Save as defaults saves; **Curves Auto sets
  each channel's ends at the clip**; **B/C Auto brightens a dark image**; **double-click on Set White Point keeps it
  armed, opens the Color Picker, the answer becomes the highlight target, Yes saves it, the white eyedropper then
  maps to it**; No keeps session targets and Properties' eyedropper carries them; **Levels Auto in Properties is one
  history step**.
- ui-egui whole lib: 3519 passed, 7 ignored (the run was OOM-killed here near its end with 4 test threads; the 95
  tests it had not reached were run on their own with 2 threads: all passed). ui-egui `--test it tone_targets`
  30/30 (with the fix and this package's eyedropper row, which tests click by "Set White Point").

## Checks

All green: `cargo fmt --all -- --check`; clippy `-D warnings --all-targets` on photocraft-algo, photocraft-engine,
photocraft-ui-egui; `python3 scripts/pigment-rebrand.py --check`; panic hunt (`--ignored`, 1/1, with the two new
commands and the three Image › Auto commands' new params); `cargo xtask scorecard --check` (regenerated: prefs
202 → 203), `panel-commands`, `layers`, `egui-fork`; `cargo test -p xtask` (108).
Memory: a full ui-egui lib run with `--test-threads 4` can be OOM-killed in this container; use 2.

## Not done (with why)

- Auto/Options… beside the Channel select (inside the framework panel): needs a craft-libs change; drawn below.
- Per-dialog lifetime of unsaved options (Photoshop): kept for the app session instead (simpler, and the Properties
  panel has no dialog to scope them to).
- Image › Auto from the menu with saved options records `{}` in an action (playback uses whatever is saved then);
  explicit options record and replay exactly.
- The options' Auto on a gray plane target (mask/channel): refused with a status line.

## For the next package (A4 and later)

- `Preferences.adjustments` exists (`AdjustmentPrefs` in `auto_options_cmds.rs`): A4 adds `curves_display` there
  (and keeps `#[serde(default)]`; regenerate `docs/scorecard.md`; `prefs_usage` needs a reader).
- The Levels/Curves arms now draw `auto_row::pickers` (Pigment's eyedropper row) and no longer pass `.pickers(…)` to
  the framework panels; A5's on-image picker kinds can extend that row instead of the framework's.
- `AdjustAsk::AutoOptions` is a new variant: exhaustive `match`es on `AdjustAsk` need it.
- P4 (migrate presets): `settings.adjust.autoOptions` → `image.adjustments.autoOptions {"options": <JS object>,
  "saveAsDefaults": true}` works as is (JS keys and ids are accepted).
