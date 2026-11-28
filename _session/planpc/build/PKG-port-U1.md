# PKG-port-U1: Info panel readout modes and 16-bit and 32-bit values (rows 41, 42)

Built on `claude/pigment-photocraft` after `58a4854` (U2; PhotoCraft 057297b, craft-libs 18ffc07). Spec: PORTS-A §5.1
and §9 U1; REBASE-FU "U1" (it wins). Sixth package of group FU (F3, F2, F1, U4, U2 before it; U3 not built yet).

**CI first.** At the start (08:05 UTC) the newest finished runs were 46121376495 (`a123260`, **cancelled**: superseded
by the next push, not red) and 46115758573 (`e8ec9d5`, **green**); 46118018605 (`53805fb`) then finished **green**.
46123186831 (`58a4854`, U2's last) was still in progress when I last looked (09:30). Nothing red, so no CI commit. **The next
engineer checks 46123186831 and the runs on this package's commit first.**

**REBASE-FU's line numbers** checked against the tree: `info.rs` `info_panel` is at :162 (REBASE said :176), `byte`
:80 (:86), `readings` :88 (:95), `sampler_rows` :140 (:153), `sampler_readouts` :177 (:197), `pointer_sample` :16
(matched); `registry.rs` `info` entry :154 (:147; the Histogram entry above it is now 148-153); `sampler_cmds.rs`
`device_cmyk` :37, `readout` :48, `point_json` :57 (matched); `dialogs.rs` `PARAM_FAMILIES` now has U2's
Insert Conditional line, mine is right after it; `app.rs` histogram restore is :245 (:237; not used, see below);
`histogram_panel.rs:34` `OPTIONS_PREF` and `persist_options`/`restore_options` :157/:166 (matched);
`CL/color-ui/src/ui/info.rs` `InfoPanel` :187, `InfoWords` :27-51, `InfoColor` :57 (matched); `convert.rs`
`srgb_to_lab` :201, `rgb_to_hsb` :251, `with_cmyk_space` :78 (matched).

## Commit (pushed)

- `b7ea01f` Pigment Info panel readout modes and deep values (U1), engine, interface and docs: two readouts in ten
  modes, a mode per Color Sampler, 16-bit and 32-bit values

## What was built

### `crates/ui-egui/src/panels/info_readout.rs` (new; `pub(crate) mod info_readout;` in `panels.rs`)

- `Mode` (the ten readouts, keys `actual|proof|gray|rgb|web|hsb|cmyk|lab|totalInk|opacity`, Photoshop's menu order and
  words), `SixteenBit` (`32768`/`65535`), `InfoOptions { first, second, sixteen, samplers: Vec<Option<Mode>> }`
  (defaults Actual / CMYK / 32768 / none), `from_value` (lenient: a bad value keeps its default) and `to_value` (no
  nulls: `""` for a sampler that follows the panel; TOML).
- `readout(mode, rgba, &Space) -> Vec<(Name, String)>`, pure: Actual = the document's own channels (RGB for RGB,
  Indexed, Multichannel; K for Grayscale, Bitmap, Duotone; CMYK; Lab); RGB in the depth's scale (`deep`: 8-bit 0–255,
  16-bit `round(v·32768)` or `round(v·65535)`, 32-bit `{v:.4}` unclamped, NaN → 0); CMYK and Total Ink through the
  document's CMYK profile (`with_cmyk_space` + `sampler_cmds::device_cmyk`, the framework's conversion); Grayscale K =
  100 − gray %; Lab via `srgb_to_lab`, HSB via `rgb_to_hsb` (H in °, S/B in %), Web = `RRGGBB` hex, Opacity = alpha %;
  Proof Color through a cached `craft::cms::Transform` from `CanvasDisplay::source` (sRGB-encoded first when
  `encode_srgb`) to View › Proof Setup's profile, intent and BPC, **whether Proof Colors is on or not** (Photoshop reads
  the proof setup either way): 4 channels → CMYK %, 1 → K, 3 → RGB in the depth's scale; if no transform, CMYK.
- **Choices recorded:** whole numbers without `%` for CMYK and Grayscale K, as the framework's CMYK cells show them;
  HSB, Total Ink and Opacity carry `°`/`%` (spec). Lab/HSB/Web/Gray read the composite as sRGB, clamped, as upstream's
  own Lab documents composite (`photocraft_raster::from_rgba_into`); the document's RGB profile is not used for Lab.
- `custom(app)` decides who draws: `None` (framework's `InfoPanel`) without a document, or for an 8-bit document whose
  first readout is RGB Color, or Actual Color of an RGB-like document, with the second CMYK Color and no sampler mode.
  **Deviation from REBASE-FU (followed the code/spec):** REBASE said "Actual → framework" for any mode; but the spec
  says Actual is the document's own channels, so a Grayscale, CMYK or Lab document with the default options draws
  Pigment's grid (K / CMYK / Lab under Actual, as Photoshop). No upstream test draws the panel for those modes.
- `panel_lines(app, samplers, options, words) -> Panel` builds what is drawn (the two readouts side by side, then the
  Ruler measure, X/Y beside W/H from upstream's `info::readings`, `Doc: W x H`, each sampler `#n` with X/Y and either
  its own mode or the two panel readouts in pairs); `show_panel` draws it with `Grid` (4 `Content` columns, the
  framework's layout) and `Text` inside a labelled `Stack`, words from `Env::of(ui).words::<InfoWords>()`; `lines(app)`
  (test-only) gives the same with English words. Pigment's own short names (L, a, b, H, S, B, #) go through
  `i18n::tr_ctx(lang, "infoPanel", ..)`; "Total Ink", "Opacity" through `tl!`.
- **Panel menu** (`InfoPanelCommand`, `#[derive(CommandSet)]`, prefix `infoPanel`, scope `app`): First Color Readout ▸
  and Second Color Readout ▸ submenus (`PanelRow::Submenu`) of ten radio rows each (20 unit variants; the derive takes
  unit variants only and the command board keys states by id, not params, so parameterised rows would share one
  check). Each row's state is `checked` + `title(mode label)` (so the submenu says "Lab Color"; the catalog label is
  "Second Color Readout: Lab Color", unambiguous in the shortcut editor). Then Panel Options… and **Units & Rulers…**
  (`edit.preferences.unitsAndRulers`, an engine row; REBASE: link to the preference rather than duplicate it).
- **Panel Options…** (`KEY = "pigment.infoPanelOptions"`, `open_param_unsaved`, `FAMILY` in `PARAM_FAMILIES`): First
  Color Readout and Second Color Readout (choices of the ten), the 16-bit radio ("16-bit values: 0–32768/0–65535"), and
  a Color Samplers section with "Sampler #n:" ("Same as the Panel" + the ten) for each sampler of the active document.
  **Deviation from REBASE-FU:** the per-sampler modes are in this dialog, not "Sampler #n ▸" menu rows (10 × 11 more
  unit variants; same CommandSet limit). Sampler modes are kept by index, globally, not per document (Photoshop ties a
  mode to the sampler).
- **Persistence:** `Preferences.dialogs["infoPanel"]`, read from the preferences each frame (`options(app)`), written
  by `set_options` (which bumps `commands_run` so the settling Info region redraws). So **no `app.rs` restore hook**
  (REBASE planned one) and no field on the app.

### Engine (`crates/engine/src/cmd/sampler_cmds.rs`)

- `deep_readout(doc, pos, size) -> [f32; 4]`: the same composite average as `readout` (same Bitmap/Multichannel Point
  Sample rule) before rounding, not clamped, non-finite → 0. `point_json` adds `"float"` (so `add`, `move` and `list`
  all report it); the list's params text names it. The sample is taken twice per point (once by upstream's `readout`)
  to keep upstream's function untouched; samplers are read once per revision, so the cost is small.

## Spec rows

- 41 second colour readout modes: **done** (both readouts, ten modes, Proof Color, per-sampler modes in Panel Options,
  the 16-bit range, Units & Rulers link). Photoshop's eyedropper-icon menus next to each readout: **not done** (the grid
  is the framework's style and has no clickable label; the panel menu has the same rows). Status Information choices of
  Photoshop's Panel Options: not in the spec, not built.
- 42 16-bit and 32-bit values: **done** for the pointer and the samplers.

## Tests

- `crates/engine/src/cmd/sampler_cmds/deep_tests.rs` (3): a 16-bit 0.3/0.5/0.7 reads back within 1/32768 (the 8-bit
  `rgb` unchanged, the list the same); a 32-bit 1.5 stays 1.5; an 8-bit fill reads its levels.
- `crates/ui-egui/src/panels/info_readout_tests.rs` (15): 16-bit mid grey 16384 / 32768 (and 1.0 → 32768 / 65535);
  32-bit 1.5 → "1.5000", unclamped, NaN; HSB of red 0°/100%/100% (blue 240°); Web `FF8000`; Lab of white 100/0/0; grey
  K 50; Opacity 25%; Total Ink of black = the CMYK sum (>100%), white 0%; Actual per mode; options JSON round trip, no
  nulls, bad values, trailing sampler entries; the default 8-bit RGB document stays on the framework (and RGB Color),
  16-bit / Grayscale / another second readout go to Pigment's grid, no document → framework; **Second Color Readout ▸
  Lab Color fired through `run_fired` gives R|L, G|a, B|b, then X|W, Y|H**, dashes without a pointer, values over white;
  menu states (checked + title) and rows (two submenus of ten, Panel Options…, Units & Rulers… which is not the panel's
  own command); a 16-bit fill reads 16448, and 32896 after Panel Options sets 0–65535 (through `set_json_field` +
  `confirm`); a 32-bit document reads 1.0000; Panel Options' fields, two readouts and a sampler's own mode (HSB) shown
  in its block; a 16-bit sampler reads its unrounded 9831 (8-bit would give 9894); Proof Color reads Working CMYK's
  inks (0 on white) and RGB with an sRGB proof; the options survive `saved_prefs` → TOML → `set_saved_prefs`.

Results (nextest `--profile ci`, `TMPDIR=/dev/shm/pt`, CI's font and i18n dirs):
- `-p photocraft-engine --features photocraft-io/heif --lib -E 'test(/sampler_cmds/)'`: 36 passed.
- `-p photocraft-ui-egui --features photocraft-io/heif --lib -E 'test(/info_readout|panels::info|info_ruler|rulers::tests|panel_docking|registry/)'`:
  41 run; one of mine failed first (expected 9830, the 16-bit storage gives 9831; the expectation was wrong), fixed:
  `info_readout` 15 passed.
- Whole ui-egui suite (`-j 3 -p photocraft-ui-egui --features photocraft-io/heif --lib --bins --tests`): **3827 passed,
  1 failed**, 6 skipped (about 21 minutes). The failure was `it ai_assistant::adjustments_and_filters_are_clamped_and_take_json_text`
  ("not enough working memory" from `photocraft_raster::memory::try_reserve_operation` on a Gaussian Blur): **container
  only**, the page cache had filled RAM after the long build (`free`: 4 GB free, 10 GB cache) and the memory gate
  counted it. After `echo 1 > /proc/sys/vm/drop_caches` all 31 `ai_assistant` tests pass. Nothing of U1 is on that
  path. If it shows again, drop the caches and re-run.
- `cargo fmt --all -- --check`; `cargo clippy --locked --features heif -p photocraft-io -p photocraft-engine
  -p photocraft-ui-egui --all-targets -- -D warnings`; `python3 scripts/pigment-rebrand.py --check`; `cargo xtask
  layers`, `panel-commands`, `test-binaries`, `scorecard --check`: all clean. No engine command added (only a result
  field), so no panic hunt; no preference section (the options are in `dialogs`), so the scorecard is unchanged.

## Hooks into upstream files (FORK.md, "The Info panel's readout modes and 16-bit and 32-bit values")

- `crates/ui-egui/src/panels/info.rs` `info_panel`: the `custom`/`show_panel` early return (marked).
- `crates/ui-egui/src/panels.rs`: `pub(crate) mod info_readout;`.
- `crates/ui-egui/src/panels/registry.rs`: the `info` entry's `rows`/`states`/`run`.
- `crates/ui-egui/src/dialogs.rs`: `PARAM_FAMILIES` line after Insert Conditional's.
- `crates/engine/src/cmd/sampler_cmds.rs`: `deep_readout`, `"float"` in `point_json`, the list's params text,
  `#[cfg(test)] mod deep_tests;`.
- Docs: `docs/parity/README.md` (the two Info rows "Done in 0.6"), `docs/user/guides/adjust-colors-with-adjustment-layers.md`
  ("Read the colours in the Info panel"), FORK.md.

## For the next package

- **CI**: check 46123186831 (`58a4854`) and the run on `b7ea01f` first (not waited for).
- **Container**: the memory gate reads free memory, not available; after a long build drop the page cache before a
  big test run, or image-filter tests refuse work (see Tests).
- **U3** is the last of group FU; it touches nothing of mine.
- The Info panel menu now exists (`info_readout::panel_rows`): anything else for the Info panel menu goes there.
- A `CommandSet` takes unit variants only, and `CommandState` is keyed by command id (params ignored), so a menu of
  radio choices needs one variant per choice; `CommandState::title` rewords a row per frame.
- Possible follow-ups: Lab through the document's own profile (craft-cms Lab transform) instead of sRGB; per-document
  sampler modes; Photoshop's Status Information options.
- Disk: ~12 GB free during this package.
