# PKG-port-A6: Color and Vibrance, Clarity and Dehaze, Grain (row 17)

Built on `claude/pigment-photocraft` (PhotoCraft 057297b), after A1 to A5. Spec: PORTS-A §2.7, §2.12 (the seven panel
presets), §9 A6; REBASE-A "A6" (it wins). Read with PKG-port-A2.md (panel presets) and FORK.md
"What Pigment added › Color and Vibrance, Clarity and Dehaze, Grain" (the full hook table).

## CI at the start

The newest finished Pigment CI run was red: 45989095632, on A4's engine commit `d110494`. Its one failure was
`photocraft-engine::it prefs_usage::every_preference_is_read_or_hidden`: the A4 preference's reader landed in the next
commit (`867cd68`), as A5's notes say. At HEAD (`7c96e78`) that test passes here, so there was nothing to fix and no fix
commit. (The runs on A3's and A4's interface commits were cancelled by later pushes; A5's were still running.)

## Commits (pushed together; CI on the last push not waited for)

- `51007ac` Pigment Color and Vibrance, Clarity and Dehaze, Grain (A6), engine: the adjustments, the compositor's tile
  margin, GPU programs, PSD pcAd, the .pigment and pcJS upgrade, the panel presets
- `0581bde` Pigment Color and Vibrance, Clarity and Dehaze, Grain (A6), interface: the editors in the dialogs and
  Properties, the Adjustments panel buttons, the menus

Both were verified on the whole tree and pushed together (CI runs on `0581bde`; the engine commit alone was not run).

## What was built

1. **Model** (`crates/doc/src/adjust.rs`): `Adjustment::ColorVibrance {temperature, tint, vibrance, saturation}`,
   `ClarityDehaze {clarity, dehaze}`, `Grain {amount, size, roughness, seed}` (seed `#[serde(default)]` 1), labels,
   `spatial_margin(scale)` (24 px × scale for a set Clarity and Dehaze, else 0), `CLARITY_DEHAZE_MARGIN`.
   `crates/doc/src/adjust_pigment.rs`: `from_js(kind, params)` (the JS kinds `color-vibrance`, `clarity-dehaze`, `grain`,
   read as the app read them) and `upgrade(&Adjustment)` (a `pcJS` `Unsupported` block of those kinds → live; trims the
   zero padding PSD adds).
2. **Evaluation** (`crates/compose/src/adjust_extra.rs`, tests in `adjust_extra/tests.rs`):
   - Color and Vibrance = Camera Raw's `white_balance_gains` (copied; compose has no algo edge) normalised by Rec. 709
     luminance, in linear light through the document transfer, then upstream's `vibrance_lin` and Vibrance Saturation.
   - Clarity and Dehaze = a port of JS `clarityDehaze` (3 box passes r 8 on alpha-weighted Rec. 601 luma; dark channel
     min r 4 + 3 box passes r 6; white haze; saturation × (1 + 0.2 dehaze)), over the whole buffer, edges replicated.
   - Grain = a port of JS `grain`/`grainNoise` (value noise on a 1 + size/16 cell, triangular hash, roughness mix,
     weaker in shadows and highlights), from the buffer's document position; `seed` offsets the hash salt (seed 1 = the
     JS noise; salt kept below 2^24 so the GPU's f32 parameter is exact).
   - Both ports match Pigment 0.4's own output within one level (`js-cases.txt`, written by `make-cases.mjs` from the
     JS branch at `5305a81`; README beside it).
3. **The neighbourhood (followed the code, not REBASE's `backdrop_with_margin` at `composite.rs:486`)**: instead of
   re-compositing the layers below at the adjustment, `render_tiled_with_alloc` renders every tile (and the one-tile
   path) grown by `stack_margin` (the summed margins of the visible Clarity and Dehaze layers, ≤ 240) and cuts it back
   (`adjust_extra::with_margin`, `grow` stops at a canvas edge the tile lies within, so the canvas edge replicates as in
   the JS app). Effect maps are prepared and clipped over the grown rect. This covers all three places that apply an
   adjustment (plain, clipped atop a base, Blend If's own colour), nested groups and stacked Clarity layers exactly, in one
   hook; bands and reduced renders go through it. Proxies (`proxy_faithful`) and one-colour-area shortcuts
   (`uniform::per_pixel`) are off while Grain or a set Clarity and Dehaze is visible (REBASE's "scale the margin" for
   proxies: refused instead, exact). CMYK/Lab need no hook: `ink_adjustment` and the native paths already fall back for
   kinds they don't list.
4. **Destructive** (Image › Adjustments on a pixel layer): `crates/engine/src/pixels/newer.rs` `apply_around` reads the
   tile grown by the margin from a copy of the untouched surface; `with_canvas` (set by `destructive_adjust` for a layer)
   stops it at the canvas edges like the compositor. Masks/channels/smart filters read past the surface as its default.
5. **GPU** (`crates/gpu/src/plan/pigment_lower.rs`, `compose.wgsl`): Color and Vibrance = the Vibrance kernel (9) with
   gains in `p3` when `p2.w` is set; Grain = kernel 18 (`pigment_grain`, `pigment_hash01`); the planner refuses a set
   Clarity and Dehaze ("Clarity and Dehaze (composited on the CPU)").
6. **Files**: PSD `pcAd` block (`crates/io/src/adjust_map/pcad.rs`, header `PCAD\0\0\0\x01` + JSON, padded to 4) on a
   layer with no pixels; `pcAd` is the 17th `ADJUSTMENT_KEYS` entry, so import, re-save dedup and the unknown-block
   warning work through upstream's own code. Export warns per layer: `layer "X": Grain layers open in Pigment; other apps
   show them as empty layers`. `.pcraft` stores the variants by serde; `format/src/convert.rs` runs `upgrade` on load, and
   `psd_import` runs it on an unknown-key `pcJS` block (no warning, the old block dropped). `.pigment` 0.4 layers open
   live (`legacy_pigment/adjust.rs` arm), smart filters `adjust:<kind>` convert too.
7. **Engine**: three ADJ rows (`image.adjustments.*`, `layer.newAdjustmentLayer.*`), `adjust_params/newer.rs`
   (`from_params`/`to_params`), `adjustment_kind` arms, `presets::adjustments::KINDS` + the three (no built-ins: the JS app
   had none), the seven panel presets in JS order (Bright and Warm, Soft Skin, Vivid, Clear Distance, Remove Warm Cast,
   Vintage Fade, Film Grain) — all 18 now.
8. **Interface**: `dialogs/adjust_editors/newer.rs` (slider tables over `AdjustSliders`, labels through `tl!`, Grain's
   Seed is a row), three `AdjustValue` variants, `KINDS` 17 (so the Preset row, dialogs and Properties come for free);
   three `IconButton`s after the Adjustments grid (`sun`, `cloud`, `sparkles`, `adjustment_presets::newer_buttons`);
   menus placed through `newer::place_after` (Image › Adjustments after Selective Color…, Layer › New Adjustment Layer
   after Color Lookup…).

## Choices recorded

- **Color and Vibrance follows the spec (Camera Raw gains + upstream Vibrance), not the JS formulas**: a 0.4 document's
  Color and Vibrance layer draws up to 75 levels (mean 3.1) off the app's picture on saturated colours
  (`layer_kinds_tests` `DIFFERENT_BY_DESIGN` now (75, 3.25); it was 41/5.0 when the layer drew nothing). Clarity and
  Dehaze and Grain fixtures now draw within the default 3 levels / 0.5 mean and left that list.
- The `pcJS` mapper lives in `photocraft_doc::adjust_pigment` (not `io/legacy_pigment`, D5) because the native loader in
  `photocraft-format` must call it and format cannot depend on io. `legacy_pigment/adjust.rs` calls it.
- The 0.5-saved fixture is made in the test (`pcad.rs` `pcjs_blocks_saved_by_pigment_0_5_open_live`): a document with
  L2's `Unsupported{pcJS}` saved by today's writers (unchanged for `Unsupported`) as PSD and `.pcraft`.
- No icons added; the framework's `sun`, `cloud`, `sparkles`.
- The dialog's live preview of Clarity and Dehaze on a **masked** target differs from the command near the mask (the
  clipping base's alpha includes the mask, as in Photoshop, and weights the blur): the two upstream
  preview-against-command tests leave the kind out; `newer::tests::clarity_dehaze_previews_like_the_command` checks it
  on an unmasked target (≤ 1/255).

## Tests (green here)

- doc `adjust::tests::newer_adjustments_margin_labels_and_serde`, `adjust_pigment::tests` (83 doc tests).
- compose `adjust_extra::tests` (8): JS cases (7 + 6 noise values); no tile (16/64/100/256) or band (3×256 rows) or part
  seams for single, negative and stacked Clarity and Dehaze; clipped + Blend If-in-group seams; Grain position-locked
  (overlapping renders equal, tile 17 = whole, seed moves it, amount 0 = none); Color and Vibrance warms a grey keeping
  its luminance, Tint lowers green, = Vibrance at T=0; margins/grow; proxies and uniform areas off; hostile values. Whole
  compose lib 504; `--test it` 9 (serially: `shape_split_cache` flakes in one process when two tests purge the global
  cache; nextest isolates).
- io: `pcad::tests` + `file_tests` (round trip, notice, empty layers for other readers, merged image, no duplicate on
  re-save; `pcJS` upgrade in PSD and `.pcraft`, unknown kind kept), `legacy_pigment` (live arm, fixtures), `--test it
  adjust_blend_roundtrip` (the three in 8- and 16-bit). io lib 822, it 600; format 98 + 130.
- engine `adjust_params::newer::tests` (6): params/clamps/round trip, commands make layers (one step), destructive edit +
  undo, Actions record and play back, destructive Clarity tile seams (canvas edges included), panel presets (Film Grain
  group, Remove Warm Cast, all 18), gains equal Camera Raw's, hostile params. Whole engine (nextest) 4958 passed; panic
  hunt 1/1; automation lib 149, it 130 (nextest).
- gpu (nextest) 196/197: `parity::pigment` (skips here: llvmpipe has no Rgba32Float; the plan refusal part runs);
  `bounded_readback_preserves_effect_halos_across_seams` fails here with and without this package (GL downlevel
  R32Float), container-only.
- ui-egui: `adjust_editors::newer::tests` (dialogs show rows, OK one step; Properties drag one step in RGB 8/32, CMYK,
  Lab; menus order; preview = command unmasked), `panels::adjustment_presets::tests` (the three buttons), the adjust,
  properties, menus, adjustment_presets subsets. Whole ui-egui `--lib --test it` (nextest, 3 threads): 3760 of 3761
  passed; `it ai_assistant::adjustments_and_filters_are_clamped_and_take_json_text` fails here on its Gaussian Blur
  radius 99999 step ("not enough working memory", `raster::memory::try_reserve_operation` against this container's
  memory budget), a filter path A6 does not touch; container-only as far as checked (not re-run on the old HEAD).
- **Disk**: a full test build here fills the ~39 GB quota (`target/debug/examples` held 7.9 GB of example binaries; the
  brief's cleanup only names `deps`). Delete large executables in `target/debug/examples` too before a big run.

## Checks

`cargo fmt --all -- --check`; `cargo clippy --workspace --all-targets -- -D warnings`; `python3
scripts/pigment-rebrand.py --check`; panic hunt; `cargo xtask egui-fork`, `layers`, `panel-commands`, `test-binaries`,
`scorecard --check` (up to date: no preference or crate added). `cargo test -p xtask` not run (no crate, preference or
panel command added).

## Not done (with why)

- A GPU kernel for Clarity and Dehaze (the spec calls it a later optimisation): the planner sends the stack to the CPU.
- Clarity and Dehaze on a mask or channel **with a selection** reads neighbours `adjust_mask` already wrote (it adjusts
  tile by tile in place): small seams are possible there. Layers, smart objects and masks without a selection are exact.
- Clarity and Dehaze in CMYK split stand-ins (`cmyk_split`) never happens: a CMYK stack holding it falls back to the RGB
  compositor, which grows tiles.
- Translations: new English strings use the catalogue fallback ("Color and Vibrance", "Clarity and Dehaze", "Grain",
  "Temperature", "Tint", "Clarity", "Dehaze", "Amount", "Size", "Roughness", "Seed", the export notice).
- No on-image tool for the three (none in the JS app).

## For the next package (A7)

- `AdjustValue` has three more variants and `adjust_editors::KINDS` is 17: exhaustive matches on `AdjustValue` need arms
  (`values.rs` has them). Tests that copy `KINDS` into a fixed-size array (`adjust_preview/tests.rs`) need the length.
- `ADJUSTMENT_KEYS` is `[&[u8; 4]; 17]` (`pcAd` last).
- A new neighbourhood adjustment only needs a `spatial_margin` > 0: the compositor's tile growth, the destructive path
  and the GPU refusal all key on it.
- `presets::adjustments::panel::PANEL_PRESETS` is complete (18).
