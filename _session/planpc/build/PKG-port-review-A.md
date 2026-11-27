# Review of group A (A1 to A7): adjustment presets, Auto options, Curves display, on-image tools, the newer adjustments, HDR, Match and Replace Color

Reviewed on branch `claude/pigment-photocraft` from `03ccb71c` (the start of the group) to `75ec4482` (A7's interface
commit), against PORTS.md, PORTS-A.md sections 0 and 2.1 to 2.12, and REBASE-A.md (which wins where they differ).
The engineers' notes are `PKG-port-A1.md` to `PKG-port-A7.md` beside this file.

## Verdict

The group is sound. Each row the spec gives A1 to A7 is either built or recorded with a reason (the framework-blocked
Curves display options, the placement of the hand and Auto rows, the dropped `.hdt`/`.sta` files, the seven panel
presets now complete). The hooks into upstream files are small and every one is in `docs/FORK.md` (checked
mechanically: each upstream file the group changed is named there; the only ones not named are Pigment-owned
`legacy_pigment/*` files). The new readers (`.alv/.acv/.ahu/.cha/.asv/.blw`, `pcAd`, the `pcJS` upgrade, the Match
Color statistics file, the saved presets in `config.toml`) bound their input, refuse bad values and have truncation or
hostile-value tests. One history step per action holds where I looked (dialog OK, a Properties pick, a panel preset,
the hand's gesture, Auto in Properties, the solid fill's OK).

I found two real defects, both fixed with a test each, and several minor gaps that I recorded below rather than fixed.

## Found and fixed

1. **Exposure's eyedroppers could not reach a 32-bit highlight** (major for 32-bit documents, A5).
   `adjust_params::on_image::exposure_eyedropper` held the sample to 0..1 before linearising it. A 32-bit document
   stores linear light above 1, which is where Exposure is used most; the white eyedropper on a pixel of 4.0 gave
   Exposure 0 instead of -2, and the gray one was off by the same factor. The sample is now only held at 0 (8- and
   16-bit samples are never above 1, so nothing changes there). The dialog's picker goes through
   `document.sampleColor` (float composite) and Properties through `layer.setAdjustment`, so both get the fix.
   Test: `adjust_params::on_image::tests::exposure_eyedroppers_read_32_bit_highlights_above_white` (the pure function,
   and the command on a 32-bit document lifted above white).
2. **"Your Presets" lost a Color Lookup layer's look** (minor/major, A2). `layer.saveAdjustmentPreset` stored each
   layer through upstream's `adjust_params::to_params`, which keeps only a Color Lookup's interpolation and dither, so
   the preset came back as a Color Lookup with no table. `panel::layer_params` now adds the table: the loaded file's
   bytes (`data`, base64, with its `lutFormat` and name) or the built-in look's id (`lut`). Test:
   `cmd::adjust_preset_cmds::panel::tests::your_presets_keep_a_color_lookup_layers_look` (a built-in look and a
   `.cube` file, through the settings file).

## Minor, recorded, not fixed

- **Grain and Clarity and Dehaze in 32-bit documents work on linear values** (A6). `compose::adjust_extra::apply`
  runs Grain and Clarity and Dehaze on the buffer as stored; in a 32-bit document that is linear light, so grain is
  much stronger in the shadows than in an 8-bit document, and Clarity's midtone weight `1 - (2l - 1)^2` turns
  negative above about l = 1.58, reversing the local contrast in bright HDR highlights. Color and Vibrance does
  decode through the transfer. The JavaScript app had no 32-bit documents and Photoshop has no such layers, so there is
  no reference; a fix means encoding to display values around the two kernels on the CPU and in `compose.wgsl`
  (kind 18) together. Left for whoever next touches A6's kernels.
- **Auto with saved options reads 8-bit histograms** (A3): `auto_options_cmds::sample_surface` uses
  `read_rgba8_into`, so 16-bit documents lose precision and 32-bit values above 1 clip at 255. Upstream's own Auto
  does the same.
- **A Smart Filter of the three newer kinds is not written to PSD** (A6): `smart_map::export::item_for_filter` has no
  PSD equivalent for them, so a PSD save warns and drops the filter, as upstream already does for Vibrance and the
  other adjustments Photoshop cannot hold as smart filters. Layers are kept through `pcAd`; smart filters are not.
- **`AdjustmentPresets::load`** keeps unknown kinds without a bound on how many (each kind is bounded to 1000
  presets). The file is the user's own `config.toml`, so this is hardening, not a defect.
- Recorded choices I checked and agree with: HDR built-in Strength `/100` instead of REBASE's `/25` (it maps the JS
  default 50 to PhotoCraft's default 0.5); Levels Auto keeps the framework's rule until options are saved; the Auto,
  Show Clipping and hand rows below the framework editors; built-ins not marked built-in so they can be renamed and
  deleted; the five Curves display options stored but disabled until craft-libs has props.

## Checks run

See the final section of this file, filled in once the runs ended.

## What the next group should know

- The open question for the project's owner from A4 is still open: whether to propose the Curves display props
  (grid, baseline, intersection line, amount, overlays) to craft-libs.
- P1b (`.pcpresets`): user adjustment presets are `session.presets.adjustments`, and the Adjustments panel's "Your
  Presets" are its pseudo-kind `__panel`. A panel preset's Color Lookup layer now carries its table (`data` base64 or
  `lut` id), so a `.pcpresets` export of `__panel` can be large (MAX_PARAMS_BYTES is 4 MB per preset).
- P4 (Migrate Presets): JS HDR method ids are accepted by the engine; the dialog's menu holds camelCase ids
  (`HdrMethod::parse(js).id()`). JS `settings.adjust.autoOptions` and `curvesDisplay` can be passed as they are
  (A3, A4 notes).
- Memory and disk: a full ui-egui lib run with 4 test threads can be OOM-killed here; use `--test-threads 2`. A full
  ui-egui test build is close to the disk quota; check `df -h /` first.
