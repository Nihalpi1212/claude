# PORTS-A: porting the Pigment-ahead rows of Image and Layer, presets, formats and metadata, panels, and the `.pigment` 0.1–0.4 importer

Scope: 46 of the 93 Pigment-ahead rows (`photocraft-eval/pigment-ahead.md`) plus the importer for
`.pigment` files written by the JavaScript Pigment 0.1–0.4. The generative-AI rows are the AI team's
(`planpc/ai/`); the type, select-filter-view and other tools rows are another planner's.

Sources read for this plan (all paths are real and were opened):

- JavaScript Pigment 0.4: `git show claude/fervent-newton-263lz3:pigment/<path>` (abbreviated **JS** below,
  paths relative to `pigment/src/`). Its 0.5 work: `origin/claude/fervent-newton-263lz3-wip05` (**JS 0.5**),
  the same tree as `stash@{0}` (the local branch name `claude/fervent-newton-263lz3-wip05` does not
  exist; only the `origin/` ref does).
- Rust tree: `/home/user/claude/pigment` on `claude/pigment-photocraft` at `ffb311f` (**PC** below, paths
  relative to the repository root). craft-libs is pinned at `e2dc681a3` (`Cargo.toml` lines 13–52), which
  is also the head of `/home/user/storytold/craft-libs`, so every craft crate cited below exists at the
  pinned revision.
- The evaluation map (`photocraft-eval/map/*.jsonl`): every PhotoCraft file/command it names was checked
  in the code; corrections are noted in the rows.

Nothing in the repository was edited and no cargo was run.

## 0. Decisions shared by several rows

These hold for every package below; each row refers back to them.

**D1. Adjustment presets are a preset kind of their own, persisted with the preferences.** A new
`crates/engine/src/presets/adjustments.rs` holds `AdjustmentPresets { groups: BTreeMap<String /*kind*/,
Vec<Group<AdjustmentPreset>>> }` with `AdjustmentPreset { name, id: Option<String> /*stable built-in
id*/, params: Value /*the command's own params, as image.adjustments.<kind> takes them*/ }`. It is a field
`adjustments` of `PresetState` (`crates/engine/src/presets.rs:47`) and of its `Persisted` mirror, so it
saves in `preferences.json` under `presets.adjustments` like gradients do. Params are the engine's
command params (not `Adjustment`), because those are what the dialogs, actions and agents already speak
(`crates/engine/src/adjust_params.rs` `from_params`/`to_params`), and they survive model changes.
Built-ins are generated in code (never written), keyed by stable ids copied from JS
(`renderer/lib/adjust/tonal-formats.js` `TONAL_BUILTINS`, `adjust/color-formats.js` `COLOR_BUILTINS`), and
the user's deletions of built-ins are remembered (`hidden_builtins: Vec<String>` per kind) as JS did.

**D2. Photoshop's adjustment preset files are the PSD adjustment block bodies.** `.alv` = `levl` data,
`.ahu` = `hue2`, `.cha` = `mixr`, `.asv` = `selc`, `.blw` = a `blwh`-style descriptor with a 2-byte
version and 4-byte descriptor version prefix; `.acv` differs from `curv` only in its header (version u16,
curve count u16, then point lists; `curv` has a pad byte, version and a channel bit mask). PhotoCraft
already parses and encodes all of these blocks (`crates/io/src/adjust_map.rs` `parse` line 169,
`crates/io/src/adjust_map/encode.rs` `levels` line 78, `curves` 93, `hue_saturation` 39,
`selective_color` 113, `black_white` 198, `channel_mixer` 227). The preset files are a thin wrapper:
new `crates/io/src/adjust_map/preset_files.rs`, exported from `crates/io/src/lib.rs` as
`pub mod adjust_presets` (re-export), with `read(kind, bytes) -> Result<(Adjustment, Vec<String> /*report*/),
String>` and `write(&Adjustment) -> Result<Vec<u8>, String>` for kinds `levels|curves|hueSaturation|
channelMixer|selectiveColor|blackWhite`. The engine turns the `Adjustment` into params with
`adjust_params::to_params` (line 275). Exposure, Brightness/Contrast, Threshold, Vibrance, Photo Filter,
Color Balance and HDR Toning had no Photoshop preset file in the JS app (their Photoshop files, where
they exist, have no public layout); their presets travel in the `.pcpresets` JSON (D4) only.

**D3. Dialog-only state lives in a new `Preferences.adjustments` section** (`crates/engine/src/prefs.rs`
struct `Preferences` line 1368): `auto_options: AutoOptions` (D-row "Auto Color Correction Options"),
`curves_display: CurvesDisplay`, `info_panel: InfoPanelOptions` (Info rows; or a separate `info` section
if the Info package goes first — whoever lands first adds the section, the other adds a field). Each gets
validation in `crates/engine/src/prefs/validate.rs` and a `prefs.set` path like the other sections.

**D4. One JSON exchange format for presets Photoshop has no file for.** Extend the existing `.pcpresets`
`PresetFile` (`crates/engine/src/cmd/edit_menu_cmds/presets.rs` line 140, `PRESET_FORMAT =
"photocraft-presets"`) with optional `swatches`, `gradients`, `styles`, `patterns` (base64 `.pat` bytes per
pattern), `contours`, `shapes`, `adjustments` (D1) fields, `#[serde(default)]` so old files load. Keep the
format string (files written by PhotoCraft upstream must keep loading); it is a Pigment-internal name.

**D5. JS→PhotoCraft mapping code lives once, in `crates/io/src/legacy_pigment/`**, because the `.pigment`
importer (L-packages) and Migrate Presets (P4) both need it: `adjust.rs` (JS adjustment kind+params →
`photocraft_doc::Adjustment`), `styles.rs` (JS layer styles → `photocraft_doc::effects::Effects`),
`gradient.rs` (JS gradient v2 incl. noise → `Fill::Gradient` / `GradientSource` / engine
`GradientPreset` stops), `path.rs` (JS `{subpaths:[{closed, points:[{x,y,in,out}]}]}` → `photocraft_doc`
`Path`), `brush.rs` (JS brush preset → `photocraft_paint::BrushSettings`), `blend.rs` (JS blend names →
`BlendMode`). `crates/io` cannot depend on the engine (the engine depends on io), so these map straight
to document/paint types.

**D6. Private PSD data uses PhotoCraft's `pc**` tagged-block convention** (precedent:
`crates/io/src/vector_preview.rs` `PSD_KEY = *b"pcVP"`, a versioned header then the payload). New keys in
this plan: `pcAd` (adjustments Photoshop cannot store, row "Newer adjustments").

**D7. i18n.** English strings in code via `tl!()` (`crates/ui-egui/src/lib.rs:25`); translations go to
storytold/craft-i18n `locales/<code>/photocraft.tsv` later (`crates/ui-egui/src/i18n.rs` header). Each row
lists its new English strings; `cargo xtask i18n-report` lists what each language lacks.

**D8. Every new engine command has a `CommandSpec` with a params string, is journaled when it changes a
document (so Actions record it), and gets an engine test in the command family's `tests.rs`; every
dialog gets a ui-egui test that drives it through `crate::dialogs::open_command_dialog` and
`ui.dialog.set` like `crates/ui-egui/src/dialogs/adjust_editors/ui_tests.rs`.**

## 1. Summary

| # | Row (area) | Verdict | Package | Effort |
|---|---|---|---|---|
| 1 | Adjustment presets: save, load, built-in lists (image-layer) | port | A1, A2 | L |
| 2 | Curves: presets and Auto | port | A1, A2, A3 | S (on top of A1) |
| 3 | Hue/Saturation: on-image tool and presets (.ahu) | port | A1, A5 | M |
| 4 | Black & White: on-image tool, presets/.blw | port | A1, A5 | S |
| 5 | Brightness/Contrast: Auto, presets | port | A1, A3 | S |
| 6 | Channel Mixer: presets/.cha | port | A1 | S |
| 7 | Exposure: eyedroppers, presets | port | A1, A5 | S |
| 8 | Threshold: presets | port | A1 | S |
| 9 | HDR Toning: Method menu, presets | port | A7 | M |
| 10 | Adjustments panel: adjustment presets | port | A2 | M |
| 11 | Curves: display options and Show Clipping | port | A4 | M |
| 12 | Curves: on-image adjustment tool | port | A5 | M |
| 13 | Hue/Saturation: range eyedroppers | port | A5 | S |
| 14 | Auto Color Correction Options | port | A3 | M |
| 15 | Levels: Auto and Auto Options | port | A3 | S |
| 16 | Levels: eyedroppers (target-colour editing) | port (folded into 14) | A3 | S |
| 17 | Newer adjustments: Color and Vibrance, Clarity and Dehaze, Grain | port | A6 | L |
| 18 | Match Color: Save/Load Statistics | port | A7 | S |
| 19 | Replace Color: Selection/Image preview | port | A7 | S |
| 20 | Properties: fill layer (solid colour in Properties) | port | A7 | S |
| 21 | Preset management (tools) | port (same as 23) | P1a | — |
| 22 | Presets › Export/Import Presets and Migrate Presets | port | P1b, P4 | M + M |
| 23 | Presets › Preset Manager (every kind) | port | P1a | L |
| 24 | Tool Presets: .tpl import/export (tools) | port | P2 | L |
| 25 | Tool presets: load/save/replace/reset, .tpl (panels) | port (same as 24) | P2 | — |
| 26 | Noise gradients | port | P3 | L |
| 27 | Open: AVIF (file-edit) | port (same as 28) | F3 | — |
| 28 | AVIF (formats) | port | F3 | L |
| 29 | Targa: 15/16-bit and colour-mapped | port | F2 | S |
| 30 | Export As: GIF | port | F2 | S |
| 31 | Color Lookup Tables (file-edit) | port (same as 32) | F2 | — |
| 32 | Export Color Lookup Tables: .3dl/.csp/ICC, copyright | port | F2 | M |
| 33 | File Info: Basic, rating | port | F1 | S |
| 34 | File Info: Origin, IPTC, IPTC Extension, GPS … (file-edit) | port (Audio/Video, DICOM, Raw Data tabs: partly, see row) | F1 | L |
| 35 | File Info: Origin, IPTC and IPTC Extension tabs (formats) | port (same as 34) | F1 | — |
| 36 | EXIF reading (Camera Data): 17+ tags | port | F1 | S |
| 37 | Actions: default and bundled action sets (formats) | port the Default Actions set; Adobe's other sets dropped | U2 | M |
| 38 | Actions: Default Actions set (panels) | port (same as 37) | U2 | — |
| 39 | Actions: Clear All Actions, Reset Actions | port | U2 | S |
| 40 | Actions: Insert Conditional dialog | port | U2 | S |
| 41 | Info panel: second colour readout modes | port | U1 | S |
| 42 | Info panel: 16-bit and 32-bit values | port | U1 | S |
| 43 | Pen tablet: tilt, rotation, barrel wheel, eraser end, side buttons (panels) | port Windows Ink tilt/rotation, macOS rotation; native Wayland dropped | U3 | M |
| 44 | Pen tilt, barrel rotation and stylus wheel input (tools) | port (same as 43) | U3 | — |
| 45 | Select Similar Layers | port | U4 | S |
| 46 | Operating-system recent documents | port | U4 | S |
| + | `.pigment` 0.1–0.4 importer | port | L1, L2, L3 | 3 × L |

Packages (section 9), recommended order: L1 → L2 → L3 (old documents first), A1 → A2 → A3 → A4 → A5 →
A6 → A7, P1a → P1b → P2 → P3 → P4, F1, F2, F3, U1, U2, U3, U4 (the F and U packages are independent and
can go anywhere). P4 needs L2's mapping modules (D5). About 37 engineer-days in all.

## 2. Image and Layer: adjustments

### 2.1 Adjustment presets: save, load, built-in lists (rows 1, 2, 3, 4, 5, 6, 7, 8 — the preset half)

**Photoshop.** Every adjustment dialog and the adjustment layer's Properties panel have a Preset menu
(Default, the built-ins, Custom) and a gear menu (Save Preset…, Load Preset…, Delete Current Preset,
Reset to Default…). Files: `.alv` Levels, `.acv` Curves, `.ahu` Hue/Saturation, `.cha` Channel Mixer,
`.asv` Selective Color, `.blw` Black & White, plus `.hdt` HDR Toning, Exposure files. Photoshop's built-in
lists ship in `Presets/` (Curves: Color Negative, Cross Process, Darker, Increase Contrast, Lighter,
Linear Contrast, Medium Contrast, Negative, Strong Contrast; Levels: Darker, Increase Contrast 1–3,
Lighten Shadows, Lighter, Midtones Brighter/Darker; etc.).

**JS.** `renderer/lib/adjust/presets.js` (`registerAdjustmentPresets`, `registerAdjustmentFormat`,
`registerTonalPresets`) registers preset kinds `adjustment:<kind>` in the generic preset store
(`renderer/lib/presets.js`); `adjust/tonal-formats.js` (`writeAcv`/`readAcv`, `writeAlv`/`readAlv`,
`TONAL_BUILTINS` for levels, curves, exposure, brightness-contrast, threshold, `normalizeTonalPreset`);
`adjust/color-formats.js` (`writeAhu`/`readAhu`, `writeCha`/`readCha`, `writeAsv`/`readAsv`,
`writeBlw`/`readBlw`, `COLOR_BUILTINS` for hue-saturation, black-white, channel-mixer, hdr-toning);
`adjust/color.js` `registerColorPresets`; UI `adjust/preset-widget.js` (`presetWidget`: preset select,
⋯ menu Save Preset…, Load Preset…, Save to File…, Rename…, Delete Current Preset, Reset Presets…;
`sameSettings` flips the menu to "Custom" when the settings leave the preset; `loadPresetFile`,
`savePresetFile`) placed by `adjust/frame.js` `buildAdjustmentFrame` above every editor, in dialogs and in
Properties.

**PhotoCraft now.** None. `crates/engine/src/presets/` has clone_source, gradients, patterns, shapes,
styles, swatches, tools only; no adjustment preset code anywhere (checked `grep -ri "acv\|alv\|ahu"`).
The dialogs (`crates/ui-egui/src/dialogs/adjust_dialog.rs` `body` line 602) and Properties
(`crates/ui-egui/src/dialogs/adjust_editors/session.rs` `layer_editor` line 84) share the editors in
`crates/ui-egui/src/dialogs/adjust_editors.rs` (`editor` line 152, `KINDS` line 58).

**Build (A1: engine + io).**
- `crates/io/src/adjust_map/preset_files.rs` (D2): `pub fn read(kind: &str, bytes: &[u8]) ->
  Result<(Adjustment, Vec<String>), String>` and `pub fn write(adj: &Adjustment) -> Result<Vec<u8>, String>`.
  - `.acv`: version 1 or 4, count 1..=32, per curve n (2..=19, accept up to 64 like JS) points as
    (output, input) i16 0..255; records = composite, then channels (RGB assumed; extra records reported,
    as JS `readAcv`). Write version 1; a pencil curve is fitted to ≤ 19 points with
    `crate::adjust_params::map_to_points`-equivalent logic (copy it into io or reuse `curve_map_outputs`
    from `photocraft_doc::adjust` then sample 17 points as JS `pointsFromTable(ch, 17)`).
  - `.alv`: version 1|2, 29 records × 5 i16 (in floor, in ceiling, out floor, out ceiling, gamma×100);
    reuse `encode::levels` / `levels_rec`.
  - `.ahu`: 100 bytes, version 1|2, = `hue2` (reuse `encode::hue_saturation` and the `b"hue2"` arm of
    `parse_any`). Report "version 1 file read with the later layout" as JS.
  - `.cha`: 44 bytes = `mixr`; `.asv`: 84 bytes = `selc`; `.blw`: u16 version 1, u32 16, descriptor with
    `Rd  `,`Yllw`,`Grn `,`Cyn `,`Bl  `,`Mgnt`, `useTint`, `tintColor` (reuse `encode::black_white` and
    `parse_black_white`).
  - Make the needed `encode` fns `pub(crate)` (they are `pub(super)`).
- `crates/engine/src/presets/adjustments.rs` (D1): `builtin(kind) -> Vec<Group<AdjustmentPreset>>` with
  the JS lists translated to PhotoCraft params (JS `levels({inBlack:15,gamma:0.85})` → `{"inBlack":15,
  "gamma":0.85}`; JS curves `{rgb:[[0,0],[128,96],[255,255]]}` → `{"points":[[0,0],[128,96],[255,255]]}`
  and `r/g/b` → `red/green/blue`; JS hue-sat `colorizeHue/colorizeSat/colorizeLight` → PhotoCraft
  colorize `hue/saturation/lightness` with `colorize:true`; JS ranges `{base:'reds',…}` → `"reds":{…}`;
  B&W `reds…magentas` same keys; Channel Mixer `{gray:{r,g,b,constant}, monochrome}` →
  `{"gray":[r,g,b,constant],"monochrome":true}`; HDR presets after A7 adds `method`). Kinds with built-ins:
  levels, curves, exposure, brightnessContrast, threshold, hueSaturation, blackWhite, channelMixer,
  hdrToning; kinds with an empty list but presets allowed: every other `ADJ` kind (`crates/engine/src/cmd.rs`
  line 1217) and the A6 kinds.
- Commands (new `crates/engine/src/cmd/adjust_preset_cmds.rs`, registered next to `adjust_cmds::specs`):
  - `adjustment.presets.list {"kind":k?}` → `{kind: [{group, name, id?, builtin}]}`;
  - `adjustment.presets.get {"kind","name"|"id"}` → `{params}` (the dialog applies it like an edit);
  - `adjustment.presets.save {"kind","name","params":json}` (a taken name replaces, as Photoshop asks
    "Replace?" in the UI first);
  - `adjustment.presets.edit {"kind","action":"rename|delete","name","newName"?}`;
  - `adjustment.presets.reset {"kind"}` (built-ins back, user presets kept, like Photoshop's Reset);
  - `adjustment.presets.load {"kind","path"|"data":base64,"fileName"?}` → `{added:[names], report}` (file
    name without extension becomes the preset name, as JS `registerAdjustmentFormat.read`);
  - `adjustment.presets.export {"kind","params"|"name","path"?}` → bytes (base64) when no path.
  All `journal: false` (they do not change a document) and `enabled: always`; they call
  `s.presets_changed()` so preferences save.
- Apply a preset to a new adjustment layer: no new command; the UI passes the preset's params to
  `layer.newAdjustmentLayer.<kind>` / the dialog fields, so Actions record the resulting settings, as
  Photoshop records the values, not the preset name.

**Build (A2: UI).**
- `crates/ui-egui/src/dialogs/adjust_editors/preset_row.rs` (new): `preset_row(app, ui, kind, v: &mut Value,
  mem: egui::Id) -> Edit` draws `Preset: [Default ▾] [⚙]` (a `widgets::dropdown` of Default, groups and
  presets, "Custom" shown when the settings differ from every preset; comparison = the preset's keys
  only, JS `sameSettings`) and the gear menu Save Preset…, Load Preset…, Delete Current Preset, Reset to
  Default…, Rename Preset…; file dialogs through `crate::file_dialog` with filter by kind (`.acv` etc.
  plus `.pcpresets`).
- Call it at the top of `adjust_dialog::body` (line 602) and of `session::layer_editor` (line 84) for
  every kind in `adjust_editors::KINDS` plus `hdrToning` (filter dialog, A7) and the A6 kinds.
- Picking a preset writes its params over the editor value (`merge` in `adjust_params`), marking an
  `Edit { changed, commit }` so Properties coalesces one history step ("Preset" label, like Photoshop's
  "Modify … Layer").
- i18n: "Preset:", "Default", "Custom", "Save Preset…", "Load Preset…", "Delete Current Preset",
  "Reset to Default…", "Rename Preset…", "Replace the preset “{name}”?", "Preset name", "Curves presets",
  "Levels presets", "Hue/Saturation presets", "Channel Mixer presets", "Selective Color presets",
  "Black & White presets", and every built-in preset name (Darker, Increase Contrast 1, …).

**PSD.** Presets are not stored in a PSD. The preset files are as above.

**Tests.**
- io `adjust_map/preset_files.rs`: for each format, write → read is identity on a non-trivial setting
  (Curves 4-point + red channel; Levels per channel; Hue/Sat with moved reds bounds and colorize; Mixer
  monochrome; Selective Color absolute; B&W with tint); golden byte sizes (100, 44, 84, 2+29·10); reading
  a byte-for-byte copy of the JS writer's output for one setting (generate it once with
  `node -e` from JS `writeAcv`/`writeAhu` in a scratch checkout, commit as a fixture under
  `crates/io/tests/fixtures/adjust-presets/`); truncated and wrong-version files return errors, never
  panic (fuzz-ish loop over truncations).
- engine `adjust_preset_cmds` tests: list has the JS built-in names; save/rename/delete/reset round
  trip; `presets_changed` bumps `presets.rev`; a preferences save and reload keeps user presets and
  hidden built-ins; load of a fixture `.acv` adds a preset named after the file.
- ui: open Curves, pick "Strong Contrast (RGB)" → the dialog's `points` equal the built-in; edit a point
  → label shows "Custom"; Properties panel of a Levels layer applies a preset in one history step.

**Effort.** A1 L (2 days), A2 M (1 day, shared with row 10).

### 2.2 Curves: presets and Auto (row 2), Brightness/Contrast: Auto and presets (row 5)

**Photoshop.** Curves has Preset, Auto and Options… (Auto Color Correction Options). Brightness/Contrast
has Auto (since CS6) and presets.

**JS.** Curves Auto: `adjust/curves-editor.js` calls `autoTonalParams` (`shared/pixels/adjust-tonal.js`
line 663) with `savedAutoOptions`; Brightness/Contrast Auto: `adjust/simple-editors.js`
`autoBrightnessContrast` (0.5 % / 99.5 % luma clip → contrast, median → brightness).

**PhotoCraft now.** Curves: no Auto (`crates/ui-egui/src/dialogs/adjust_editors/curves.rs` `curves`
line 347 has no Auto button); Brightness/Contrast `basic.rs` `brightness_contrast` line 53: Brightness,
Contrast, Use Legacy only. Levels Auto exists (`levels.rs` `auto_levels` line 42, 0.1 % clip).

**Build.** Presets: A1/A2. Auto: A3 (section 2.4) adds `adjust_params::auto_curves(hist, options)` →
curve points (the Levels result expressed as a curve: black/white input points and, for gamma, a
midpoint, as Photoshop's Auto Curves writes `[[inBlack,0],[mid,128],[inWhite,255]]`) and
`adjust_params::auto_brightness_contrast(hist) -> (brightness, contrast)` ported from JS
`autoBrightnessContrast`. UI: an "Auto" button in `curves.rs` (beside the channel picker, like
`levels.rs` line 82) and in `basic.rs::brightness_contrast`; Alt/Option-click on Auto opens the A3
options dialog (Curves; B/C has no options in Photoshop).

**Tests.** Auto Curves on a low-contrast gradient fixture gives end points at the 0.1 % clip; Auto
B/C on a dark image raises brightness; both are no-ops on an image that already spans 0..255.

**Effort.** S each (inside A3).

### 2.3 Threshold, Channel Mixer, Exposure, Black & White, Hue/Saturation presets (rows 3–8, preset half)

All covered by A1/A2: the editors get the preset row; Channel Mixer `.cha`, B&W `.blw`, Hue/Sat `.ahu`
files; Threshold, Exposure built-ins from JS `TONAL_BUILTINS` (Dark (96)/Middle (128)/Light (160);
Minus 2.0/Minus 1.0/Plus 1.0/Plus 2.0). The on-image tools and eyedroppers of these rows are in 2.6.

### 2.4 Auto Color Correction Options (row 14), Levels: Auto Options (row 15), Levels eyedropper target colours (row 16)

**Photoshop.** Alt-click Auto or the Options… button in Levels/Curves: Algorithms (Enhance Monochromatic
Contrast, Enhance Per Channel Contrast, Find Dark & Light Colors, Enhance Brightness and Contrast), Snap
Neutral Midtones, Target Colors & Clipping (Shadows colour + clip %, Midtones colour, Highlights colour
+ clip %), Save as defaults (then Image › Auto Tone/Contrast/Color use them). Double-clicking a Levels or
Curves eyedropper opens the Color Picker for its target colour (the same targets).

**JS.** `adjust/auto-options.js` (`openAutoOptions`, `saveAutoOptions` into `settings.adjust.autoOptions`,
`savedAutoOptions`); algorithms in `shared/pixels/adjust-tonal.js`: `AUTO_DEFAULTS` (line 480),
`AUTO_ALGORITHMS`, `autoOptions`, `clipRange`, `gammaFor`, `autoLevelsParams` (line ~545:
mono/brightness/perChannel/darkLight, `darkLightColors`, `neutralSample` for Snap Neutral Midtones),
`autoTonalParams` (line 663). The eyedroppers (`adjust/eyedroppers.js` `tonalEyedroppers`) use the target
colours.

**PhotoCraft now.** `crates/engine/src/cmd/edit_cmds.rs` `auto_adjust` (line 843): fixed 0.1 % clip, tone =
per channel, contrast = combined, color = per channel + median gamma; specs `image.autoTone`
(Cmd+Shift+L), `image.autoContrast`, `image.autoColor` (line 1273). Levels Auto in the editor
(`levels.rs` line 82). Eyedroppers: `adjust_params::levels_eyedropper` (line 836) and
`curves_eyedropper` (line 880) set black/white to 0/255 and gray to neutral luma; no target colours.

**Build (A3).**
- `crates/algo/src/auto_tone.rs` (new, pure, no engine types): `pub struct AutoOptions { algorithm:
  AutoAlgorithm { Monochromatic, PerChannel, DarkLight, BrightnessContrast }, snap_neutral: bool,
  shadow_clip: f32 /*%, 0..9.99*/, highlight_clip: f32, shadow: [f32;3], midtone: [f32;3], highlight:
  [f32;3] }` with `Default` = JS `AUTO_DEFAULTS` (PerChannel, false, 0.1, 0.1, black, 50 % grey, white);
  `pub fn auto_levels(hists: &[[u64;256];4] /*r,g,b,luma*/, px_sample: &[[f32;3]], o: &AutoOptions) ->
  [Levels5; 4]` (composite + three channels) ported line for line from `autoLevelsParams`,
  `clipRange`, `gammaFor`, `darkLightColors`, `neutralSample`.
- `crates/engine/src/prefs.rs`: `Preferences.adjustments.auto_options` (D3), serde camelCase
  `{"algorithm":"monochromatic|perChannel|darkLight|brightnessContrast","snapNeutralMidtones":bool,
  "shadowClip":%,"highlightClip":%,"shadowColor":"#rrggbb","midtoneColor":"#rrggbb","highlightColor":"#rrggbb"}`;
  validation clamps.
- `crates/engine/src/cmd/edit_cmds.rs` `auto_adjust`: build `AutoOptions` from Preferences when the user
  saved defaults (`auto_options_saved: bool`), else Photoshop's per-command defaults (Auto Tone =
  PerChannel, Auto Contrast = Monochromatic, Auto Color = DarkLight + snap), then call
  `photocraft_algo::auto_tone::auto_levels`. Params grow `{"algorithm"?, "snapNeutralMidtones"?,
  "shadowClip"?, …}` so actions can record explicit options (Photoshop records `AutoCorrection`
  descriptors this way).
- `crates/engine/src/adjust_params.rs`: `pub fn auto_params(kind: "levels"|"curves", hist, sample,
  options) -> Value` used by the dialogs' Auto, and the eyedroppers read the targets:
  `levels_eyedropper`/`curves_eyedropper` map the sample to `shadow`/`highlight`/`midtone` targets
  instead of 0/255/neutral.
- New command `image.adjustments.autoOptions {"options":json?,"saveAsDefaults":bool=false}` →
  `{options}` (get/set; journal false). The UI uses it so agents can do the same.
- UI `crates/ui-egui/src/dialogs/auto_options_ui.rs` (new): the dialog (four radio buttons, check box,
  three colour swatches opening `color_picker_ui`, two % fields, Save as defaults, OK/Cancel) opened from
  Alt-click on Auto and an "Options…" button in `levels.rs` and `curves.rs`; while open, the parent
  dialog previews the Auto result (re-run `auto_params` on every change), Cancel restores.
  Double-click on a Levels/Curves eyedropper button (`adjust_dialog.rs` `picker_controls` line 243) opens
  the Color Picker for that target and stores it in the same options (Photoshop then asks "Save the new
  target colors as defaults?": a `dont_show_again` prompt).
- i18n: "Auto Color Correction Options", "Algorithms", "Enhance Monochromatic Contrast", "Enhance Per
  Channel Contrast", "Find Dark & Light Colors", "Enhance Brightness and Contrast", "Snap Neutral
  Midtones", "Target Colors & Clipping", "Shadows:", "Midtones:", "Highlights:", "Clip:", "Save as
  defaults", "Options…", "Save the new target colors as defaults?".

**PSD.** Nothing (Photoshop keeps these in its preferences). Actions: the explicit params.

**Tests.** algo: each algorithm on synthetic histograms against values computed by the JS function
(table of 6 cases generated from `autoLevelsParams` in node, pasted as constants); snap neutral moves a
cast grey to neutral; clip 0 vs 2 % differ. engine: `image.autoColor` with saved options equals
`image.adjustments.levels` with `auto_params` result; prefs validation clamps 50 % to 9.99. ui: Alt-click
Auto opens the dialog; Cancel restores the Levels fields.

**Effort.** M (1.5 days) for A3 including 2.2's Auto buttons.

### 2.5 Curves: display options and Show Clipping (row 11)

**Photoshop.** Curves › Curve Display Options: Show Amount of Light (0–255) / Pigment/Ink % (flips the
axes' meaning and the gradient bars), Simple (4×4) / Detailed (10×10) grid, Show: Channel Overlays,
Histogram, Baseline, Intersection Line; Show Clipping check box for black/white point sliders (and
Alt-drag) showing clipped pixels on the canvas (black/white threshold display).

**JS.** `adjust/curves-editor.js`: `DISPLAY_DEFAULTS` (line 15), `curvesDisplay(app)` (settings
`adjust.curvesDisplay`), options popover, `clip(which)` callback from the dialog that shows the clipping
display while a black/white slider moves with Show Clipping or Alt; Levels Alt-drag in
`adjust/levels-editor.js`.

**PhotoCraft now.** `curves.rs` line 404–440 always draws histogram, a fixed 4×4 grid and the
baseline; channel overlays only on the composite (`overlay_others`); no options, no intersection line,
no Pigment/Ink mode, no Show Clipping. Levels has no clipping display either (`levels.rs` has no Alt
handling), so the clipping overlay is new code for both.

**Build (A4).**
- `Preferences.adjustments.curves_display` (D3): `{"amount":"light|pigment","grid":"simple|detailed",
  "channelOverlays":bool=true,"histogram":bool=true,"baseline":bool=true,"intersectionLine":bool=true}`.
  In a CMYK document Photoshop defaults to pigment; keep that: `amount` is per colour mode
  (`lightRgb`, `pigmentCmyk` defaults) or simply default `light` for RGB/Gray/Lab and `pigment` for CMYK
  unless set.
- `curves.rs`: a `⚙` button (Photoshop puts "Curve Display Options" in the dialog's options; in
  Properties it is the panel menu item "Curves Display Options…") opening a small popup with the
  options; `curves()` draws a 10×10 grid when detailed, skips histogram/baseline/overlays per option,
  draws the intersection line (a horizontal and vertical guide through the dragged point while
  dragging), and in pigment mode mirrors both axes and swaps the gradient bars, reading/writing values
  as `255 - v` so the stored params stay light-based.
- Show Clipping: a check box under the graph (dialog only, as in Photoshop and JS); while it is on and
  the black or white point is being dragged, or Alt is held while dragging the black/white endpoint or
  the Levels input sliders, set `app.ui.clipping_display = Some(ClipDisplay { kind: Black|White, levels:
  [f32; 3] })`. The canvas draws it through the adjustment preview path: in `crates/ui-egui/src/dialogs/
  adjust_preview.rs` substitute the previewed adjustment with a Threshold-like per-channel map
  (black: pixels where any channel ≤ its input black → that channel's colour, else white; white: ≥ input
  white → colour, else black — Photoshop's display), so the GPU preview shows it with no new shader.
- i18n: "Curve Display Options", "Show Amount of:", "Light (0-255)", "Pigment/Ink %", "Show:", "Channel
  Overlays", "Histogram", "Baseline", "Intersection Line", "Simple grid", "Detailed grid", "Show
  Clipping".

**PSD.** None (Photoshop's display options are preferences).

**Tests.** ui: toggling Detailed draws 9 interior lines per axis (count `Shape::LineSegment`s in the
painter output, as `curve_polyline_*` tests do); pigment mode maps a drag to the mirrored stored point;
Show Clipping sets `clipping_display` only while dragging; adjust_preview renders the black clipping map
for a fixture (pixel test at 3 points). prefs round trip.

**Effort.** M (1 day).

### 2.6 On-image adjustment tools and eyedroppers (rows 3, 4, 7, 12, 13)

**Photoshop.** The hand icon (Targeted Adjustment) in Curves, Hue/Saturation and Black & White, in the
dialog and in Properties: Curves — click a tone in the image to add a point on the channel curve at that
input, drag up/down to move it; Hue/Saturation — click picks the colour range of the hue under the
pointer and drag left/right changes that range's saturation, Cmd/Ctrl-drag its hue; Black & White —
drag left/right changes the weight of the colour slider of the hue under the pointer. Hue/Saturation
eyedroppers: pick a range, Add to Sample, Subtract from Sample (Shift/Alt). Exposure: black (sets
Offset so the sample becomes black), gray (Exposure so the sample becomes middle grey), white
(Exposure so it becomes white) eyedroppers.

**JS.** `adjust/frame.js` `toolButton` (on-image tool row, canvas-capture handler) and `sampleBelow`;
`adjust/curves-editor.js` (on-image: click a tone, drag up or down); `adjust/hue-sat-editor.js`
(`rangeBars`, on-image drag saturation/Ctrl hue, eyedroppers through `shared/pixels/adjust-color.js`
`rangeForColor` line 241, `addHueToRange` 251, `subtractHueFromRange` 271); B&W in
`adjust/color-editors.js` `blackWhiteEditor`; Exposure eyedroppers `adjust/simple-editors.js`
`exposureEditor` → `adjust/eyedroppers.js` `tonalEyedroppers(app,'exposure',…)`.

**PhotoCraft now.** Levels/Curves eyedroppers and Ctrl-click to add a Curves point: `adjust_dialog.rs`
`picker_armed` (45), `sample_at` (58), `add_point_at` (143), `picker_controls` (243); engine
`adjust_params::eyedropper_from_params` (930), `destructive_eyedropper` (944), `layer_eyedropper` (978).
Hue/Sat range bar handles: `hue_saturation.rs` `move_hue_range_handle` (25), `move_hue_range_zone` (77).
No on-image drag tool; no Hue/Sat or Exposure eyedroppers.

**Build (A5).**
- Engine, `crates/engine/src/adjust_params.rs`:
  - extend `adjustment_eyedropper(kind, …)` (869) to `"exposure"`: `exposure_eyedropper(base, picker,
    sample)`: black → `offset = -luma(sample)` (Photoshop's), gray → `exposure = log2(0.18 / luma)` (in
    linear light, as Exposure works) clamped −20..20, white → `exposure = log2(1 / luma)`; params key
    `"eyedropper"` like Levels (add it to the `exposure` params string in `crates/engine/src/cmd.rs` ADJ
    table and to `eyedropper_from_params` kinds `levels|curves|exposure`).
  - `hue_saturation_eyedropper(base, mode: "pick|add|subtract", sample_rgb)`: port `rangeForColor`,
    `addHueToRange`, `subtractHueFromRange`; result sets `"edit":"reds|…"` (new params key: the range the
    dialog edits; Photoshop records it) and the range's `range:[4 degrees]`. Params
    `"rangeEyedropper":{"mode","at":[x,y],"size"}` on `image.adjustments.hueSaturation` /
    `layer.newAdjustmentLayer.hueSaturation`.
  - `on_image_curves(base, channel, sample, dy)`, `on_image_hue_sat(base, sample, dx, hue_mode)`,
    `on_image_black_white(base, sample, dx)` as pure functions returning params, so headless agents can
    call them through the eyedropper params (`"onImage":{"at":[x,y],"drag":[dx,dy],"hue":bool}`).
    Curves: input = the sample's channel value (composite = luma for RGB as Photoshop), add or move the
    point there; output = input − dy/2 levels (Photoshop's 1 level per 2 px). Hue/Sat: the range whose
    weight is largest at the sample hue (master if saturation of the sample < 5 %); saturation += dx/2,
    hue += dx/2 with `hue`. B&W: the slider among reds…magentas nearest the sample hue, += dx/2 %.
- UI:
  - `adjust_dialog.rs`: a third tool kind next to the pickers, `__onImage: bool` field; a hand button
    (`picker_button` with icon `hand-pointer`) in Curves, Hue/Sat, B&W; Hue/Sat gets three eyedropper
    buttons (pick, +, −) and Exposure three (black, gray, white) through `picker_controls`, gated by
    `picker_supported` (RGB/Gray).
  - Canvas routing: where the canvas input calls `adjust_dialog::picker_armed`/`sample_at` (grep the
    callers in `crates/ui-egui/src/canvas/` and `crates/ui-egui/src/input/`), add `on_image_armed`,
    `on_image_press(app, x, y)` (sample once, remember base params), `on_image_drag(app, dx, dy, ctrl)`
    (recompute params from the base each frame, update the dialog fields and the preview),
    `on_image_release`. Same for the Properties panel: arm state per layer editor mem
    (`session::layer_mem`), commit one history step on release (`properties_coalesce`).
  - Cursor: the targeted-adjustment cursor (hand with arrows) via `crates/ui-egui/src/canvas` cursor
    mapping.
- i18n: "Click and drag in image to modify the curve", "Click and drag in image to modify saturation.
  Ctrl-click and drag to modify hue." (macOS: Cmd), "Click and drag in image to modify a slider",
  "Eyedropper", "Add to Sample", "Subtract from Sample", "Sample in image to set black point" /
  "…gray point" / "…white point" (Exposure tooltips).

**PSD.** The resulting settings only (no tool state). Actions record the final params.

**Tests.** engine: each pure function (Curves point added at luma of a mid grey and moved by dy;
Hue/Sat picks yellows for #ffff00, Add widens bounds to include 70°, Subtract narrows; B&W drag
increases `yellows`; Exposure gray on 0.09 linear gives +1 stop) and the eyedropper params through
`image.adjustments.*` and `layer.newAdjustmentLayer.*`; ui: arm the hand in Curves, simulate press +
drag on the canvas test harness (`crates/ui-egui/src/canvas_menu_tests.rs` style) → a point appears and
OK records one history step; Properties variant commits once.

**Effort.** A5 L (2 days).

### 2.7 Newer adjustments: Color and Vibrance, Clarity and Dehaze, Grain (row 17)

**Photoshop.** Recent releases add these as Image › Adjustments and adjustment layers (Camera Raw
engine controls as live layers).

**JS.** `shared/pixels/adjust-color.js`: `colorVibrance` (line 800: temperature, tint, vibrance,
saturation), `clarityDehaze` (875, `clarityDehazeMargin` 863: fixed ~24 px neighbourhood, dehaze assumes
white haze), `grain` (972: amount, size, roughness; noise from document position via `grainNoise` 949);
registered as kinds `color-vibrance`, `clarity-dehaze`, `grain` (line 1027+); editors `fieldsEditor` in
`adjust/color.js`. PSD: saved as hidden empty layers with a notice (JS `docs/parity/image-layer.md` row
18).

**PhotoCraft now.** Only inside Camera Raw (`crates/algo/src/camera_raw.rs` `develop` line 684,
`white_balance_gains` 676, `dehaze` 967; spatial helpers `crates/algo/src/camera_raw/spatial.rs`). The
`Adjustment` enum (`crates/doc/src/adjust.rs`) has no such kinds; the compositor applies adjustments to
the band's backdrop only (`crates/compose/src/composite.rs` line 428 `cx.apply_adjustment(adj, &mut
adjusted)`), so a neighbourhood adjustment needs new plumbing.

**Build (A6).**
- `crates/doc/src/adjust.rs`: variants `ColorVibrance { temperature: f32, tint: f32, vibrance: f32,
  saturation: f32 }`, `ClarityDehaze { clarity: f32, dehaze: f32 }`, `Grain { amount: f32, size: f32,
  roughness: f32, seed: u32 }`; labels "Color and Vibrance", "Clarity and Dehaze", "Grain"; a method
  `pub fn spatial_margin(&self, scale: f32) -> u32` (24 px × scale for ClarityDehaze, 0 otherwise).
- Evaluation, `crates/compose/src/adjust.rs` (`apply_adjustment` family): ColorVibrance per pixel with
  `camera_raw::white_balance_gains` + the existing Vibrance code; Grain per pixel from document position
  (port `grainNoise`, seeded); ClarityDehaze: in `composite.rs`'s adjustment branch, when
  `spatial_margin > 0`, composite the layers below again for `rect.inflate(margin)` (a helper
  `backdrop_with_margin(stack, index, rect, margin, cx)` that reuses the band renderer), run
  `photocraft_algo::camera_raw` clarity/dehaze on it (expose `pub fn clarity_dehaze(px, w, h, clarity,
  dehaze)` from `camera_raw.rs` wrapping its existing local-contrast and dehaze stages), crop back.
  Proxy/reduced renders scale the margin (`crates/compose/src/reduced.rs`).
- GPU: `crates/gpu/src/plan/lower.rs` lowers each adjustment kind to a kernel (ColorLookup/Unsupported
  arm line 331). ColorVibrance and Grain get kernels (per-pixel, Grain from the pixel's document
  position); ClarityDehaze returns `Err(Unsupported("Clarity and Dehaze (composited on the CPU)"))` from
  the planner (`crates/gpu/src/plan/planner.rs`, as `check_advanced` line 351 does), so the whole stack
  composites on the CPU while such a layer is visible. A GPU kernel for it is a later optimisation.
- CMYK/Lab split paths (`crates/compose/src/cmyk.rs` `ink_adjustment`): treat the new kinds as RGB-only
  (not ink adjustments), as Vibrance is.
- Engine: add the three to the ADJ table in `crates/engine/src/cmd.rs` (line 1217):
  `("colorVibrance","Color and Vibrance…",{"temperature":-100..100=0,"tint":-100..100=0,"vibrance":-100..100=0,
  "saturation":-100..100=0})`, `("clarityDehaze","Clarity and Dehaze…",{"clarity":-100..100=0,
  "dehaze":-100..100=0})`, `("grain","Grain…",{"amount":0..100=0,"size":0..100=25,"roughness":0..100=50,
  "seed":1..99999=1})`; `adjust_params::from_params`/`to_params`/`adjustment_kind`; menus in
  `crates/ui-egui/src/menu_catalog.rs` (Image › Adjustments after Selective Color… / Layer › New
  Adjustment Layer, as JS's `shared/menu-template.js` `LAYER_ADJUSTMENTS` placed them after Color
  Lookup), Adjustments panel icons (`crates/ui-egui/src/panels/properties.rs` `adjustments_grid` line 228,
  array grows from 16).
- Editors: `adjust_editors.rs` `KINDS` + three slider editors in `basic.rs` (`sliders` helper line 24).
- PSD (D6): `crates/io/src/adjust_map.rs` + `psd_export`: write the layer as a pixel layer with empty
  pixels (so Photoshop and other readers composite nothing for it; the merged composite PhotoCraft writes
  already contains the effect) carrying a `pcAd` block: header `PCAD\0\0\0\x01`, then the JSON of the
  `Adjustment` (serde). The importer turns a layer with `pcAd` back into the adjustment (before the
  pixel-layer path). Export report: "Color and Vibrance, Clarity and Dehaze and Grain layers open in
  Pigment; other apps show them as empty layers" (JS showed a notice too). When Adobe's own block for
  these kinds becomes known, map it in `parse_any` and keep `pcAd` as the fallback.
- i18n: "Color and Vibrance…", "Clarity and Dehaze…", "Grain…", "Temperature", "Tint", "Clarity",
  "Dehaze", "Amount", "Size", "Roughness", "Seed", the export notice.

**Tests.** compose: Grain is deterministic and position-locked (render two overlapping bands, compare
the overlap); ClarityDehaze band-seam test (render 256×256 in one band vs four bands, max diff ≤ 1/255);
ColorVibrance temperature +50 warms a grey; GPU fallback test in `crates/gpu/tests/it` (canvas matches
CPU within tolerance); io: PSD round trip keeps the adjustment through `pcAd`, and a PSD reader that
ignores `pcAd` sees an empty pixel layer; engine: commands make layers and destructive edits, actions
record them.

**Effort.** L (2+ days); the compositor margin path is the risky part.

### 2.8 HDR Toning: Method menu and presets (row 9)

**Photoshop.** Image › Adjustments › HDR Toning: Method (Local Adaptation, Equalize Histogram, Exposure
and Gamma, Highlight Compression); Local Adaptation's Edge Glow, Tone and Detail, Advanced, Toning
Curve; Exposure and Gamma has Exposure and Gamma only; Preset menu (Flat, Monochromatic, …, Surrealistic)
with Save/Load (.hdt).

**JS.** `shared/pixels/hdr.js` `HDR_METHODS` (line 29), `HDR_DEFAULTS`, the method branches at lines 287
(exposure-gamma), 298 (highlight-compression), 323 (equalize-histogram); presets `COLOR_BUILTINS['hdr-toning']`;
.hdt not read.

**PhotoCraft now.** `image.adjustments.hdrToning` (`crates/engine/src/cmd/adjust_cmds.rs` spec ~line
700) with Local Adaptation params only; `crates/algo/src/tone.rs` `HdrToning` (197), `hdr_toning` (257);
schema dialog (`crates/ui-egui/src/dialogs/filter_dialog.rs`).

**Build (A7).** `HdrToning.method: HdrMethod { LocalAdaptation, EqualizeHistogram, ExposureGamma,
HighlightCompression }` (`#[serde(default)]`), the three new branches in `tone::hdr_toning` ported from
JS hdr.js lines 287–330; params `"method":"localAdaptation|equalizeHistogram|exposureGamma|highlightCompression"=
"localAdaptation"`; the schema dialog shows only the fields of the method (make the dialog hide
non-method keys: a `visible_when` hint in the params string, or a dedicated small body function like
other custom filter bodies in `filter_dialog.rs`). Presets via A1 kind `hdrToning` with the 8 JS
built-ins (JS values translated: JS `strength` 0..100 → PhotoCraft 0.1..4 as `strength/25`, JS `radius`
px same).
i18n: "Method:", "Local Adaptation", "Equalize Histogram", "Exposure and Gamma", "Highlight
Compression", built-in names.

**PSD.** Destructive; none. Actions record `method`.

**Tests.** algo: Equalize Histogram flattens the luma histogram of a ramp; Exposure and Gamma +1 doubles
linear values; Highlight Compression keeps the brightest pixel ≤ 1 and is monotonic. engine: the method
param round trips through actions (`atn_cmds` if the .atn mapping knows HDR toning — check
`crates/engine/src/cmd/atn_cmds/events.rs` for `hdrToning`; if mapped, add `Mthd`).

**Effort.** M (1 day) of A7.

### 2.9 Match Color: Save/Load Statistics (row 18)

**Photoshop.** Match Color › Image Statistics: Load Statistics… / Save Statistics… (`.sta`, layout not
public).

**JS.** `renderer/lib/adjust-more-ui.js` `matchColorEditor` (line ~340–490): Save writes JSON
`{format:'pigment-match-color-statistics', version:1, name, mean:[L,a,b], std:[L,a,b]}` (line 483);
Load adds a "Statistics: <name>" source.

**PhotoCraft now.** `image.adjustments.matchColor` (`adjust_cmds.rs` `match_color` line 592) computes
source stats with `photocraft_algo::tone::lab_stats` (`crates/algo/src/tone.rs` line 123, `LabStats {mean,
std}`); no save/load.

**Build (A7).** Params `"sourceStatistics":{"mean":[L,a,b],"std":[L,a,b]}?` (mutually exclusive with
`source`); new command `image.adjustments.matchColor.statistics {"source":doc,"sourceLayer":id?,
"useSelectionInSource":bool,"path":str?}` → `{name, mean, std}` and writes the JS JSON format to `path`
(same `format` string, so JS files load and Pigment files load in JS — harmless). UI: two buttons under
Source in the Match Color dialog (`filter_dialog.rs` Match Color body; find `MATCH_COLOR` near the
Replace Color code at line ~1375) and a "Statistics: <name>" entry in the Source dropdown after Load.
Check JS and PhotoCraft Lab units are the same (both CIE L\*a\*b\*, L 0..100; JS `toLab` uses D65 sRGB,
PhotoCraft `srgb_to_lab` — verify the white point in `crates/color/src/convert.rs` line 201; convert on
load if they differ). `.sta`: dropped (no public layout; JS did not read it either).
i18n: "Load Statistics…", "Save Statistics…", "Statistics: {name}", "Match Color statistics".

**Tests.** Save from a document, load into another, result equals using that document as the source;
a JS-written JSON fixture loads; bad JSON errors.

**Effort.** S.

### 2.10 Replace Color: Selection / Image preview (row 19)

**Photoshop.** Replace Color shows a preview thumbnail with Selection (the mask) / Image radio buttons;
the eyedroppers pick on it too.

**JS.** `adjust-more-ui.js` `replaceColorEditor`: Selection/Image preview canvas, eyedropper/add/subtract
on the preview, fuzziness, localized clusters, result swatch.

**PhotoCraft now.** Schema dialog (`filter_dialog.rs` ~line 1375–1430) with the three eyedroppers
(#6280) and result swatch; no thumbnail. Color Range already has exactly this preview:
`crates/ui-egui/src/dialogs/color_range_ui.rs` `preview` (line 304), `proxy_mask` (223), radio
Selection/Image (556–560), `pick_top` (646).

**Build (A7).** Extract the preview widget from `color_range_ui.rs` into `color_range_ui::preview_box(app,
ui, params_for_mask: Value, view: &mut String) -> Option<[f64;2] /*picked doc point*/>` and call it in
the Replace Color body with the mask of `select.colorRange` built from the Replace Color params (the
engine already matches "as select.colorRange does for the same samples", spec line 684). Picking on
the thumbnail adds the point to `points` / `subtractPoints` per active eyedropper.
i18n: reuse "Selection", "Image".

**Tests.** ui: the Replace Color dialog shows a texture of the proxy size; clicking the thumbnail with
the + eyedropper adds a point (field `points` grows).

**Effort.** S.

### 2.11 Properties: fill layer — solid colour (row 20)

**Photoshop.** Properties for a Solid Color fill layer shows the colour swatch (click → Color Picker);
gradient and pattern fills show their controls.

**JS.** `renderer/lib/properties/fill.js` `fillSection`: colour chip, gradient bar, pattern swatch,
Edit Fill….

**PhotoCraft now.** `crates/ui-egui/src/panels/layer_props_ui.rs` line ~244: gradient fills get
`gradient_ui::properties`; pattern fill position fields (~230); solid colour only via its dialog
(`crates/ui-egui/src/dialogs/solid_fill_ui.rs`).

**Build (A7).** In `layer_props_ui.rs` after the gradient branch: `LayerContent::Fill(Fill::Solid(c))` →
a `widgets::color_swatch_button`; click opens the Color Picker (`color_picker_ui`) bound to the layer
with live preview, OK runs the command the Solid Color dialog runs to change an existing fill
(`solid_fill_ui.rs` line 140 `app.run(cmds::SET, params)`), Cancel restores. One history step "Modify Fill Layer" as Photoshop.
i18n: "Color" (exists), "Modify Fill Layer".

**Tests.** ui: select a solid fill layer, click the swatch, pick a colour, OK → layer colour changed,
one undo step; Cancel → unchanged.

**Effort.** S.

### 2.12 Adjustments panel: adjustment presets (row 10)

**Photoshop.** Window › Adjustments shows, under the single-adjustment icons, Adjustment Presets groups
(Portraits, Landscape, Photo Repair, Creative, Black & White, Cinematic) that add one or several
adjustment layers (grouped when several), hover preview, and "Your Presets" (saved from Properties).

**JS.** `adjust/color-formats.js` `ADJUSTMENT_PANEL_PRESETS` (six groups, 18 presets, line ~400);
`renderer/lib/panels/adjustment-presets.js` (`adjustmentPresetsSection`, `addAdjustmentPanelPreset`,
command `layer:adjustment-preset`). No Your Presets, no hover preview (Pigment Partial).

**PhotoCraft now.** `crates/ui-egui/src/panels/properties.rs` `adjustments_grid` (line 228): 16 icons
only.

**Build (A2; the seven panel presets that use Color and Vibrance, Clarity and Dehaze or Grain — Bright and
Warm, Soft Skin, Vivid, Clear Distance, Remove Warm Cast, Vintage Fade, Film Grain — are added by A6, which
owns those kinds).**
- Engine: `crates/engine/src/presets/adjustments.rs` `PANEL_PRESETS: &[PanelGroup { id, name, presets:
  &[PanelPreset { id, name, layers: &[(kind, params_json)] }] }]` translated from JS (JS `curves {rgb:…}`
  → `points`, `color-vibrance` → `colorVibrance` etc.); command `layer.adjustmentPreset {"group","preset"}`
  (journal true, one history step "Adjustment Preset: {name}"): adds the layers above the active one,
  bottom first, wrapped in a group named after the preset when there are several (as Photoshop/JS).
  "Your Presets": `presets.adjustments` user group `__panel` saved by a new Properties panel menu item
  "Save Adjustment Preset…" for the selected adjustment layers (`layer.saveAdjustmentPreset {"name",
  "layers":[ids]?}`).
- UI: collapsible groups under the grid in `adjustments_grid`, each preset a row button; hover preview
  (Photoshop shows it on the canvas): on hover set the same temporary preview layer `adjust_preview.rs`
  uses for dialogs (several kinds: stack the previews) — if multi-layer preview is not supported by
  `adjust_preview`, preview the first layer only and note it.
- i18n: "Adjustment Presets", group and preset names, "Your Presets", "Save Adjustment Preset…".

**Tests.** engine: `layer.adjustmentPreset` "Film Grain" adds a group with Curves + Grain; single-layer
preset adds no group; undo removes all in one step. ui: hovering sets a preview, leaving clears it.

**Effort.** M (1 day, part of A2).

## 3. Presets

### 3.1 Preset Manager for every kind (rows 21, 23)

**Photoshop.** Edit › Presets › Preset Manager…: Preset Type (Brushes, Swatches, Gradients, Styles,
Patterns, Contours, Custom Shapes, Tools), thumbnails or names (view menu: Text Only, Small/Large
Thumbnail, Small/Large List), multi-select with Shift/Cmd, drag to reorder, Load…, Save Set… (writes the
selected presets in the kind's file format), Rename…, Delete, Done; the menu has Reset <kind>, Replace
<kind> and the bundled libraries.

**JS 0.5.** `renderer/lib/preset-manager.js` (`KIND_ORDER = ['brushes','swatches','gradients','styles',
'patterns','contours','shapes','tool-presets']`, `VIEWS`, Load…, Save Set…, Rename…, Delete, Reset,
Replace, Pigment libraries), file formats registered from `lib/preset-files/` (`aco-ase.js`, `pat.js`,
`grd.js`, `csh.js`, `asl.js`, `tpl.js`, `bundle.js`), bundled `.pigment-presets` libraries under
`src/renderer/presets/` (`index.json`: brushes-dry-media, gradients, patterns, shapes, styles,
swatches grays/hue-wheel/web-safe).

**PhotoCraft now.** `edit.presets.presetManager` (`crates/engine/src/cmd/edit_menu_cmds.rs` line 424;
`edit_menu_cmds/presets.rs` `PRESET_KINDS = ["brushes","customShapes","patterns"]` line 66,
`preset_manager` with list|rename|delete|move); UI a text list with Rename and Delete
(`crates/ui-egui/src/prefs/prefs_ui/dialogs.rs` lines 240–275). Each kind's own commands exist and are
richer: brushes `brush.presets.*` + `brush.presets.importAbr`; swatches `swatches.*` incl.
`swatches.import`/`swatches.export` (aco|act|ase, `crates/engine/src/cmd/swatch_cmds.rs` line 869);
gradients `gradient.presets.*` + `gradient.presets.importGrd`; styles `style.presets.*` +
`style.presets.importAsl`/`exportAsl` (`cmd/style_asl_cmds.rs`); patterns `pattern.presets.*` +
`pattern.import`/`pattern.export` (.pat, `cmd/pattern_cmds.rs` line 590); contours
`layer.layerStyle.contours.list|new|delete|load|save` (.shc, `cmd/contour_lib_cmds.rs` line 180–220);
shapes `shape.presets.*` + `shape.presets.importCsh`; tool presets `tool.presets.*`. Note two shape
libraries: `s.edit_state.custom_shapes` (what the Preset Manager lists now) and `s.presets.shapes`
(the Shapes panel / Custom Shape tool groups); Photoshop has one.

**Build (P1a).**
- `crates/engine/src/cmd/edit_menu_cmds/presets.rs`: `PRESET_KINDS` becomes `["brushes","swatches",
  "gradients","styles","patterns","contours","customShapes","tools","adjustments"]`. `customShapes` reads
  and edits `s.presets.shapes` (the Shapes panel library) and folds `edit_state.custom_shapes` into it
  on load (define-custom-shape keeps writing to the Shapes library; `edit_menu_cmds::custom_shapes()`
  becomes a view of it) — one library, as Photoshop. A small trait in that file,
  `trait Library { fn names(&self) -> Vec<(String /*group*/, String)>; fn rename(..); fn delete(..);
  fn move_to(..); fn reset(..); fn load(path) -> Result<Value>; fn save_set(indices, path) -> Result<Value> }`,
  implemented per kind by delegating to the commands above (no logic duplicated).
- Actions of `edit.presets.presetManager`: `list` (now with `group` and `thumbnail` hints:
  `"thumb":"brush|swatch|gradient|style|pattern|contour|shape|tool"`), `rename`, `delete` (an index list:
  `"indices":[…]` for multi-select), `move`, plus `load {"kind","path","replace":bool=false}` (Load… vs
  Replace…; dispatch by extension: .abr → `brush.presets.importAbr`, .aco/.ase/.act → `swatches.import`,
  .grd → `gradient.presets.importGrd`, .asl → `style.presets.importAsl`, .pat → `pattern.import`, .shc →
  `layer.layerStyle.contours.load`, .csh → `shape.presets.importCsh`, .tpl → P2's `tool.presets.importTpl`,
  .alv/.acv/… → `adjustment.presets.load`, .pcpresets → `edit.presets.exportImportPresets` import),
  `saveSet {"kind","indices","path"}` (dispatch: swatches → `swatches.export`, styles → `exportAsl`,
  patterns → `pattern.export`, contours → `contours.save`, gradients → new `gradient.presets.exportGrd`
  using `craft_psd::grd::write` (craft-psd `grd.rs` line 188), tools → P2's `exportTpl`, brushes →
  `.pcpresets` with brushes only until an `.abr` writer exists (no BrushSettings→descriptor encoder in
  PhotoCraft; `craft_psd::abr::write_v6` exists for the container), custom shapes → `.pcpresets` (no .csh
  writer in craft-psd; JS 0.5 `preset-files/csh.js` `writeCshFile` line 104 is a model to port into
  `crates/io/src/csh_write.rs` if wanted, S)), `reset {"kind"}` (each kind's reset command).
- New `gradient.presets.exportGrd {"group"?,"names"?,"path"?}` → bytes; map `GradientPreset` stops to
  `craft_psd::grd::GrdGradient` (RGB stops, opacity stops, midpoints 0.5; noise in P3).
- UI: replace the list in `crates/ui-egui/src/prefs/prefs_ui/dialogs.rs` with
  `crates/ui-egui/src/dialogs/preset_manager_ui.rs` (new): kind dropdown, a view menu (Text Only /
  Small Thumbnail / Large Thumbnail / Small List / Large List), a wrapped grid of thumbnails drawn with
  the panels' painters (`crates/ui-egui/src/panels/preset_panels.rs` `paint_gradient` line 210; brush,
  swatch, style, pattern, shape painters the panels already use in `preset_panels/panels.rs`), Shift/Cmd
  multi-select, drag to reorder (`move`), buttons Done, Load…, Save Set…, Rename…, Delete, and a ⚙ menu:
  Reset <kind>…, Replace <kind>…, the view choices. Remember view per kind in `ui.ron`.
- i18n: "Preset Manager", "Preset Type:", "Brushes", "Swatches", "Gradients", "Styles", "Patterns",
  "Contours", "Custom Shapes", "Tools", "Adjustments", "Text Only", "Small Thumbnail", "Large Thumbnail",
  "Small List", "Large List", "Load…", "Save Set…", "Rename…", "Delete", "Done", "Reset {kind}…",
  "Replace {kind}…", "Replace current {kind} with the presets from {file}?".

**PSD.** None (library files only).

**Tests.** engine: list covers all nine kinds; load dispatch per extension with the existing fixtures
of each importer (`crates/engine/src/cmd/preset_import_cmds.rs` tests build .abr/.grd in code; reuse
their builders); saveSet writes a file that loads back to the same names (.aco, .asl, .pat, .shc, .grd);
multi-delete; the Shapes library is one list after `edit.defineCustomShape`. ui: the dialog lists
swatches with thumbnails; Delete of two selected removes both; Save Set… writes the file (file dialog
stubbed as in `file_dialog` tests).

**Effort.** L (2 days).

### 3.2 Presets › Export/Import Presets (row 22, first half)

**Photoshop.** Export/Import Presets dialog: two lists (preset types, folders) to move across, then
Export Presets / Import Presets of a folder of preset files.

**JS 0.5.** `preset-manager.js` `edit:export-import-presets`; `preset-files/bundle.js` (`.pigment-bundle`
ZIP: `bundle.json` `{format:'pigment-bundle', version:1, kinds:{[kind]:{kindVersion, groups, items}},
settings}`, `blobs/<kind>/<name>`; `writeBundle`, `readBundle`, `bundleItems`, `bundleSettingsPatch`;
`BUNDLE_SETTINGS` in `preset-formats.js`).

**PhotoCraft now.** `edit.presets.exportImportPresets` (`edit_menu_cmds.rs` line 433, `export_import`
line 229): `.pcpresets` JSON with brushes, customShapes, tools only.

**Build (P1b).** D4: `PresetFile` gains `swatches`, `gradients`, `styles`, `patterns` (the pattern
library entries with their pixels as base64 `.pat` block bytes via `craft_psd::patterns::write_pattern_block`
line 588), `pattern_groups`, `contours`, `shapes` (the unified library), `adjustments`; kinds param
`["brushes","swatches","gradients","styles","patterns","contours","customShapes","tools","adjustments"]`;
import appends groups by name (as `migrate_cmds::merge_groups`) and skips presets that already exist
(same kind, name and data, as JS `bundle.js` does), so importing twice adds nothing. Also accept a
`.pigment-bundle` on import (P4 reads it). UI: the Photoshop dialog in
`crates/ui-egui/src/dialogs/export_import_presets_ui.rs` (new): checkboxes per kind, Export to file…,
Import from file….
i18n: "Export/Import Presets", "Export Presets", "Import Presets", "Presets to export", per-kind names.

**Tests.** Export all kinds → import into a fresh `Session` → every library equal (patterns compare
pixels); importing twice is idempotent; an old 3-kind `.pcpresets` file still imports.

**Effort.** M (1 day, P1b).

### 3.3 Migrate Presets (row 22, second half)

**Photoshop.** Edit › Presets › Migrate Presets: imports the presets of an earlier Photoshop version.

**JS 0.5.** `preset-files/migrate.js` `folderBundle(bridge, dir, kinds)`: reads an older Pigment's
presets folder (`<userData>/presets/<kind>.json`, `:` written `__`, side files in `<kind>/`) into a bundle
and imports it. The store's file format: `{format:'pigment-presets', version:1, kind, kindVersion,
groups, items, hidden}` (JS 0.5 `renderer/lib/presets.js` line 10–18).

**PhotoCraft now.** `edit.presets.migratePresets` (`crates/engine/src/cmd/migrate_cmds.rs` line 71)
merges another PhotoCraft preferences/presets JSON (gradients, styles, shapes, pattern groups, tool
presets) by group name.

**Build (P4).** For Pigment, "an earlier version" is Pigment 0.1–0.4, whose files are in the Electron
userData folder: `%APPDATA%\Pigment\presets` (Windows), `~/Library/Application Support/Pigment/presets`
(macOS), `~/.config/Pigment/presets` (Linux; capital P, unlike Pigment 0.5's `~/.config/pigment`), and
`settings.json` beside it (docs/FORK.md "The settings folder and Pigment 0.1–0.4"; Pigment 0.5 already
keeps its own presets in `Preset Library/` to avoid the clash).
- `crates/engine/src/cmd/migrate_cmds.rs`: `edit.presets.migratePresets {"path"?}`; with no path, look in
  the platform's Electron folder (the app passes it: `apps/photocraft/src/app_dirs.rs` gets
  `pub fn legacy_pigment_dir() -> Option<PathBuf>`; headless callers pass `path`). If `path` is a
  directory holding `<kind>.json` files (or a `presets` subfolder), read each `pigment-presets` file; if it
  is a `.pigment-bundle`, read `bundle.json` + `blobs/`; else keep today's JSON behaviour.
- Kind mapping (mappers in `crates/io/src/legacy_pigment/`, D5):
  - `brushes` → `BrushPreset` via `legacy_pigment::brush` (JS `renderer/lib/brush/preset.js`
    `normalizeBrush` schema: diameter, hardness, spacing, angle, roundness, tip blob, dynamics);
  - `swatches` → `presets.swatches` groups (`{name, color:'#rrggbb'}`);
  - `gradients` → `GradientPreset` (`legacy_pigment::gradient`; noise ones need P3);
  - `styles` → `StylePreset` (`legacy_pigment::styles`);
  - `patterns` → pattern library (PNG blobs in `patterns/` → `photocraft_paint::Pattern`);
  - `contours` → `photocraft_doc::Contour` (JS points 0..255);
  - `shapes` → shapes library (`legacy_pigment::path`);
  - `tool-presets` → `ToolPreset` (JS tool ids → PhotoCraft tool names with the same table as P2's
    `TOOL_CLASSES`; options mapped for brush/eraser/pencil size, opacity, flow, mode; the rest dropped with
    a report line);
  - `adjustment:<kind>` → `presets.adjustments` (`legacy_pigment::adjust` params translation, D1).
- `settings.json`: `adjust.autoOptions` → `Preferences.adjustments.auto_options` (A3), `adjust.curvesDisplay`
  → `curves_display` (A4), `actions` (the JS Actions panel's sets) → reported, not converted (JS command ids
  and arguments have no reliable mapping; the user re-records; say so in the report).
- Result `{migrated, added:{…per kind}, skipped:[{kind,name,reason}]}`; idempotent.
- UI: the menu item asks "Migrate presets from Pigment 0.4 at {folder}?" when the folder exists, else
  opens a folder dialog.
- i18n: "Migrate presets from Pigment 0.4 at {folder}?", "No Pigment 0.4 presets were found.",
  "{n} presets migrated."

**Tests.** A fixture folder under `crates/engine/tests/fixtures/pigment-0.4-presets/` (written by hand
from the JS formats: `swatches.json`, `gradients.json`, `adjustment__curves.json`, `tool-presets.json`,
`patterns.json` + `patterns/p1.png`) migrates every kind; migrating twice adds nothing; a corrupt kind
file is skipped with a report entry; a `.pigment-bundle` fixture (ZIP built in the test with `craft_zip`)
imports.

**Effort.** M (1.5 days), after L2 (mappers).

### 3.4 Tool presets: .tpl files, load/save/replace/reset (rows 24, 25)

**Photoshop.** Tool Presets panel and options-bar picker menu: New Tool Preset…, Rename, Delete, Reset
Tool, Reset All Tools, Current Tool Only, Load Tool Presets…, Save Tool Presets…, Replace Tool Presets…,
Reset Tool Presets…. Files `.tpl`.

**JS 0.5.** `renderer/lib/preset-files/tpl.js`: `readTplFile` (line 240), `writeTplFile` (370),
`TOOL_CLASSES` (Pigment tool id → Photoshop tool class), `optionsFromTool`, `typeFromTool`, layout
`8BTP` + version 1/minor 2 + `8BIM` sections `samp` (sampled tips), `patt` (patterns), `desc` (a v16
descriptor whose list holds presets: `Nm  `, `Tool` object (class = tool class; `Md  `, `Opct`, `flow`,
`TxtS` for type), `Brsh` (brush descriptor)), plus `pigmentData` (JSON of every option). Panel
`renderer/lib/panels/tool-presets.js`, model `renderer/lib/tool-presets.js`.

**PhotoCraft now.** `tool.presets.list|new|select|edit|reset` (`crates/engine/src/presets/tools.rs`
line 205–245; `ToolPreset { name, tool, options: Value }`, options opaque, the shell stores `"toolOptions"`,
the engine knows `"brush"` and `"foreground"`); panel `crates/ui-egui/src/panels/preset_panels/panels.rs`
`tool_presets_panel` (line 462). No .tpl code. `.abr` reading maps `brushPreset` descriptors to
`BrushSettings` in `crates/io/src/abr_map.rs` (`Mapper::preset` line 352, private).

**Build (P2).**
- `crates/io/src/tpl_map.rs` (new): `pub fn read_tpl(bytes) -> Result<TplImport { presets:
  Vec<TplPreset { name, tool: String /*PhotoCraft tool name*/, class: String, options: Value, brush:
  Option<BrushSettings> }>, warnings }, String>`: check `8BTP`, walk `8BIM` sections in any order (JS
  `sections`), decode `samp` and `patt` with craft-psd's ABR v6 helpers (`craft_psd::abr` parses the same
  sections for .abr v6.2; if the section walker is private there, port JS `sections`/`readSamples`, ~120
  lines), parse `desc` with `craft_psd::descriptor`, map each preset: tool class → PhotoCraft tool name
  (table ported from JS `TOOL_CLASSES` + `SHORT`, line 33–50, against the shell's tool names in
  `crates/ui-egui/src/state/tool.rs`), `Md  `/`Opct`/`flow` → `options.toolOptions` keys the shell's
  options bar uses (mode, opacity, flow, size), `Brsh` → `BrushSettings` through a new
  `pub fn brush_from_descriptor(d: &Descriptor, samples: &[AbrSample]) -> (BrushSettings, Vec<String>)`
  exported from `abr_map.rs` (wraps `Mapper::preset`), `pigmentData` (JSON) when present wins
  (round-trips Pigment's own files exactly).
- `pub fn write_tpl(presets: &[(&ToolPreset, Option<&BrushSettings>)]) -> Vec<u8>`: `8BTP` v1.2, `desc`
  with `Nm  `, `Tool` (class, `Md  `, `Opct`, `flow`), and `pigmentData` (the full options JSON); for
  painting presets a minimal `Brsh` computed-brush descriptor (`Dmtr`, `Hrdn`, `Angl`, `Rndn`, `Spcn`)
  so Photoshop gets a round brush of the right size; sampled tips in `samp` via
  `craft_psd::abr::write_v6`'s sample writer. Full brush-dynamics export needs a
  `BrushSettings`→descriptor encoder that PhotoCraft lacks (it has no .abr export); listed as a follow-up,
  the `pigmentData` keeps everything for Pigment.
- Engine (`crates/engine/src/presets/tools.rs`): `tool.presets.importTpl {"path"|"data","replace":bool=false}`
  → `{added, warnings}` (Load / Replace), `tool.presets.exportTpl {"names"?,"path"?}` (Save), keep
  `tool.presets.reset` (Reset Tool Presets); Reset Tool / Reset All Tools already exist in the shell
  (`crates/ui-egui/src/panels/options_bar.rs` line 102–109, `tool_memory.rs`).
  Brush tips of imported presets go through the brush preset store like `.abr` imports
  (`preset_import_cmds::add_abr_presets` line 153 pattern).
- UI: the Tool Presets panel menu and the options-bar picker get Load Tool Presets…, Save Tool Presets…,
  Replace Tool Presets…, Reset Tool Presets… through `preset_panels::menu` (line 152) dispatch.
- i18n: "Load Tool Presets…", "Save Tool Presets…", "Replace Tool Presets…", "Reset Tool Presets…",
  "Replace current tool presets with the presets from {file}?", warnings ("{n} options of {tool} have no
  equivalent and were skipped").

**PSD.** None.

**Tests.** io: write→read round trip keeps names, tools, options and brush size/hardness; a JS-written
`.tpl` fixture (produce with JS 0.5 `writeTplFile` in node from a checkout of the wip05 branch; commit the
bytes) reads with its `pigmentData`; a `.tpl` without `pigmentData` (strip it in the test) maps the
Photoshop keys; truncated files error. engine: importTpl adds presets, replace replaces, exportTpl writes
a file importTpl reads back.

**Effort.** L (1.5–2 days).

### 3.5 Noise gradients (row 26)

**Photoshop.** Gradient Editor › Gradient Type: Noise — Roughness 0–100 %, Color Model RGB/HSB/LAB with
per-channel min/max sliders, Restrict Colors, Add Transparency, Randomize (seed). Used by the Gradient
tool, Gradient fill layers, Gradient Overlay and Gradient Map. PSD/GRD: the gradient descriptor has
`GrdF = ClNs` with `ShTr` (transparency), `VctC` (restrict colours), `ClrS` (colour model), `RndS`
(seed), `Smth` (roughness, 0..4096), `Mnm ` and `Mxm ` (4 values each, 0..100).

**JS.** `shared/pixels/gradient-model.js`: `NOISE_DEFAULTS` (line 34: roughness 0.5, model rgb, min, max,
restrict, transparency, seed), `normalizeGradient` (172), `seededRandom` (mulberry32, 294), `noiseKnots`
(306: a random walk over knots, count grows with roughness, inside [min, max], straight lines between,
Restrict pulls saturation under 85 %); renderer `shared/pixels/gradient-render.js`; editor
`renderer/lib/gradient-editor.js`.

**PhotoCraft now.** No noise type: `crates/engine/src/cmd/preset_import_cmds.rs` line 416 skips them
("noise gradients are not supported and were skipped"); `craft_psd::grd::GrdGradient` has only
`noise: bool` (craft-psd `grd.rs` line 50). Gradients: engine `presets::gradients::GradientPreset {name,
stops, opacity}`; document `Fill::Gradient {stops, opacity_stops, midpoints, …}`
(`crates/doc/src/lib.rs` line 335); `GradientSource` for Gradient Map (`crates/doc/src/adjust.rs`).

**Build (P3).**
- `crates/doc/src/lib.rs` (or a new `crates/doc/src/noise_gradient.rs`): `pub struct NoiseGradient {
  roughness: f32 /*0..1*/, model: NoiseModel { Rgb, Hsb, Lab }, min: [f32; 4], max: [f32; 4] /*0..1,
  last = alpha*/, restrict: bool, transparency: bool, seed: u32 }` and `pub fn bake(&self) ->
  (Vec<(f32, [f32;3])>, Vec<(f32, f32)>)`: the knots as dense colour and opacity stops, ported from JS
  `noiseKnots` (mulberry32, same walk, so Pigment 0.4 noise gradients look the same). The renderers stay
  as they are: noise gradients render through their baked stops (as Gradient Map's `source` vs `stops`
  already does).
- Add `#[serde(default)] noise: Option<NoiseGradient>` to `Fill::Gradient`, `GradientSource`,
  engine `GradientPreset` and the gradient tool's current gradient (`PresetState.gradient`), and to the
  Gradient Overlay effect's gradient type (`crates/doc/src/effects.rs`); when `noise` is set the stops
  are its bake (kept in sync on edit).
- PSD (`crates/io/src/blocks.rs` gradient descriptors for `GdFl`, `crates/io/src/effects_map` for `GrFl`,
  `crates/io/src/adjust_map.rs` `parse_gradient_map`/`write_grdm` for `grdm` — grdm stores the noise
  fields: random seed, show transparency, use vector colour, roughness, colour model, min and max colour):
  read `ClNs` keys into `NoiseGradient`, write them back (`GrdF` enum `ClNs`, `ShTr`, `VctC`, `ClrS`
  enum `RGBC|HSBl|LbCl`, `RndS` long, `Smth` 0..4096, `Mnm `/`Mxm ` lists of 4 longs 0..100). GRD import
  (`preset_import_cmds::import_grd` line 369): parse the noise fields from the gradient descriptor
  (craft-psd exposes only the flag; read the descriptor in `crates/io/src/grd_noise.rs` with
  `craft_psd::descriptor`, or extend craft-psd upstream — do the local reader to avoid a craft-libs bump);
  `gradient.presets.exportGrd` (P1a) writes them.
- Gradient Editor UI (`crates/ui-egui/src/tools/gradient_ui.rs`, `pub mod gradient_ui` in `tools.rs` line 25, and the editor dialog it opens): Gradient Type
  Solid/Noise; for Noise: Roughness, Color Model, three channel range sliders with gradient tracks,
  Restrict Colors, Add Transparency, Randomize. Commands: `gradient.presets.new/edit` and the fill/tool
  params accept `"noise":{"roughness":0..100,"model":"rgb|hsb|lab","min":[…],"max":[…],"restrict":bool,
  "transparency":bool,"seed":int}`.
- i18n: "Gradient Type:", "Solid", "Noise", "Roughness:", "Color Model:", "RGB", "HSB", "LAB", "Restrict
  Colors", "Add Transparency", "Randomize".

**Tests.** doc: `bake` is deterministic per seed and matches JS `noiseKnots` output for 3 seeds
(constants generated from the JS code); min = max gives a flat gradient; restrict keeps saturation ≤ 0.85.
io: PSD round trip of a noise gradient fill and a noise Gradient Map; a GRD with a noise gradient imports
(build the GRD in the test with `craft_psd::grd::write` plus a hand-made `ClNs` descriptor). engine:
`.grd` import no longer warns "skipped"; a Gradient Overlay with noise renders.

**Effort.** L (2 days).

## 4. Formats and metadata

### 4.1 AVIF open (rows 27, 28)

**Photoshop.** Opens AVIF (8/10/12-bit, alpha, ICC/nclx, EXIF/XMP) since 2023.

**JS.** `renderer/lib/io.js` `OPEN_EXTENSIONS` includes `avif` (line 17); decoded by Chromium
(`decodeImage` → `createImageBitmap`), 8-bit sRGB only; no writer.

**PhotoCraft now.** craft-image-codecs `format.rs` line 294: `Format::Avif => FormatCaps { read: false,
write: cfg!(feature = "avif") }` (writing through `image/avif`, off by default); file-format-parity #463.
At the pinned craft-libs revision there is a clean-room pure-Rust AV1 decoder (`craft-video`, feature
`av1-decode`, `crates/video/src/av1/decode/`, conformance table in its README) and a HEIF metadata reader
(`craft-heif` `items.rs`, recognises the `avif`/`avis` brands, returns EXIF/XMP only); there is no AVIF
item/property parser.

**Build (F3).**
- `crates/io/src/avif.rs` (new, `#![forbid(unsafe_code)]`): an ISOBMFF reader for still AVIF: `ftyp`
  (major/compatible brand `avif`), `meta` → `hdlr` (`pict`), `pitm`, `iinf`/`infe` (item type `av01`,
  `grid`, `Exif`, `mime` XMP), `iloc` (versions 0–2, construction method 0 and 1 with `idat`), `iprp`/
  `ipco`/`ipma` properties `ispe`, `av1C`, `pixi`, `colr` (`nclx` and `prof`/`rICC`), `irot`, `imir`,
  `clap`, `auxC` (alpha: `urn:mpeg:mpegB:cicp:systems:auxiliary:alpha`), `iref` `auxl`/`dimg`/`cdsc`;
  bounded by `ImportOptions` limits (sizes, item count, total bytes) and never panicking.
- Decode the primary item's OBUs with `craft_video::av1::decode` (add `craft-video = { git, rev =
  "e2dc681a3", default-features = false, features = ["av1-decode"] }` to `crates/io/Cargo.toml`, behind a
  default-on `avif` feature), then YUV → RGB with the `nclx` matrix/range/transfer (BT.601/709/2020,
  full/limited; HDR transfer PQ/HLG → float document) — follow craft-heif's `ycc` module approach; grid
  items tile the decoded tiles; alpha from the auxiliary item; 10/12-bit → 16-bit document (or 32-bit
  float for PQ/HLG); ICC from `colr prof` → `Document.icc_profile`; EXIF/XMP via the `cdsc` items into
  `Metadata`; orientation from `irot`/`imir` applied (Photoshop applies them).
- Routing: `crates/io/src/lib.rs` route table (where `Route::LegacyPigment` is chosen, line ~967–1050):
  AVIF by sniffing `ftyp` brand before the generic codecs; preflight estimate from `ispe`.
  `craft-image-codecs` stays untouched (no craft-libs change); writing AVIF is out of scope (Pigment JS
  could not write it either).
- i18n: error texts ("This AVIF uses an AV1 feature Pigment cannot decode yet: {what}").

**PSD.** n/a.

**Tests.** Fixtures: tiny AVIFs (8-bit 4:2:0 opaque, 8-bit with alpha, 10-bit 4:4:4, a 2×2 grid,
`irot` 90°) generated once with `avifenc` outside the repo and committed under
`crates/io/tests/fixtures/avif/` with a README naming the generator and settings; pixel checks against
PNGs decoded by libavif (committed alongside); truncation fuzz loop; an oversize `ispe` refused by the
preflight.

**Effort.** L (2 days; more if the AV1 decoder's conformance table shows a needed tool missing —
check its README "Conformance status" first and size the package after that check).

### 4.2 Targa: 15/16-bit and colour-mapped (row 29)

**Photoshop.** Opens TGA 16/24/32-bit, colour-mapped, grey, RLE; saves 16/24/32.

**JS.** `shared/pixels/tga.js`: reads colour-mapped, true-colour and grey at 8/15/16/24/32 bpp, raw or
RLE; writes 24/32 (+RLE).

**PhotoCraft now.** Read via the `image` crate (`craft-image-codecs` `codecs/tga.rs` header: "The `image`
crate still reads Targa"), 24/32-bit only per the map; write own RLE encoder. At the pinned revision
craft-libs also has `craft-tga` (`crates/tga/src/lib.rs`: reads types 1, 2, 3, 9, 10, 11; 15/16-bit
5-5-5 with attribute alpha, 24/32-bit, 8-bit grey, 16-bit grey+alpha, colour maps of 15/16/24/32-bit
entries indexed by 8 or 16 bits, any origin; `decode(bytes, &Limits) -> Result<Picture>` line 184).

**Build (F2).** `crates/io/Cargo.toml`: `craft-tga` (git, same rev). `crates/io/src/flat.rs`
`import_flat_with` (line 71): when the sniffed format is Targa (`craft_tga::sniff(name, bytes)`, line
108), decode with `craft_tga::decode` and build the document from its RGBA8 picture
(`image_to_document`-like; keep today's alpha handling, `tga_alpha_channel_to_transparency` line 463);
a colour-mapped file opens as RGB (Photoshop opens it as RGB too; JS likewise). Fall back to the old path
on a craft-tga error so nothing that opens today stops opening. Optional: 16-bit (5-5-5) write in Save
As / Export As TGA options (`targa_options_ui.rs` "Bits/Pixel": 16) via `craft_tga::encode` if it
supports it (it lists 8-bit layouts only; then leave 16-bit write out, JS did not write it either).

**Tests.** Fixtures built in the test (tiny 2×2 files written byte by byte): type 1 colour-mapped 8-bit
index → 24-bit map; type 2 16-bit with attribute alpha; type 9 RLE colour-mapped; top-left origin; each
opens with the expected pixels. Existing 24/32-bit tests unchanged.

**Effort.** S.

### 4.3 Export As: GIF (row 30)

**Photoshop.** File › Export › Export As: PNG, JPG, GIF (+ WebP in newer releases); GIF has
Transparency only.

**JS.** `renderer/lib/file-ops.js` `exportAs`: PNG, PNG-8, 16-bit PNG, JPEG, WebP, GIF, TIFF, Targa.

**PhotoCraft now.** `crates/ui-egui/src/dialogs/export_dialog.rs` line 19 `FORMATS` has png, jpg, webp,
tif, tga, ico, jxl. GIF is written elsewhere already (Save As GIF, `file.export.saveForWebLegacy` in
`crates/engine/src/cmd/web_cmds.rs` line 79; craft-image-codecs `Format::Gif` caps line 282).

**Build (F2).** Add `("gif", "GIF")` to `FORMATS`; the dialog shows Transparency only for GIF (hide
quality/lossless/profile rows, as Photoshop); the export path converts to indexed with the quantiser Save for Web uses for GIF
(`crates/engine/src/cmd/web_cmds/optimizer.rs` line 232–296, `WebFormat::Gif`; Export As GIF in
Photoshop is adaptive 256 colours with no dither choice, so call it with `WebSettings` for "gif" from
`web_cmds/assets.rs` line 149) and writes the transparency index when Transparency is on, else mattes on the background
colour. Settings key `gif` in the remembered settings (`SETTINGS` line 28) needs nothing new beyond
`transparency`. i18n: "GIF".

**Tests.** ui: choosing GIF hides Quality; an export of a 2-colour document writes a GIF89a whose decode
equals the document; with Transparency off the transparent pixels are the matte colour.

**Effort.** S.

### 4.4 Export Color Lookup Tables: .3dl, .csp, ICC, copyright (rows 31, 32)

**Photoshop.** File › Export › Color Lookup Tables…: Description, Copyright, Use lowercase file
extensions, Quality (Poor/Low/Medium/High/Maximum = grid points 7–256), Formats: 3DL, CUBE, CSP, ICC
Profile (written together, one file each, same base name).

**JS.** `renderer/lib/adjust-more-ui.js` `exportLutsCommand` (`file:export-luts`, line 1325): .cube and
.3dl with description and 16/32/64 points; writers `shared/pixels/lut.js` `writeCube` (512),
`write3dl` (528: 10-bit input ramp, 12-bit output, blue fastest).

**PhotoCraft now.** `file.export.colorLookupTables` (`crates/engine/src/cmd/file_cmds.rs` line 413:
`{"path":.cube,"size":2..129=33,"title","scope","layers"}`), `crates/engine/src/cmd/file_cmds/export.rs`
`bake_cube_layers` (151), `bake_cube` (204), `color_lookup_tables` (211); writer `craft_cms::lutfile::
write_cube` (craft-cms `lutfile.rs` 522; readers for .3dl/.look exist, writers do not). craft-cms writes
ICC v4 profiles with `mAB` CLUT stages (`write.rs` `encode` line 254).

**Build (F2).**
- `crates/engine/src/cmd/file_cmds/export.rs`: bake once into a `size³` table (`bake_cube_layers` →
  return the table, not text), then writers:
  - `.cube`: existing, plus `# Copyright: …` comment line (Photoshop writes `TITLE` and a comment);
  - `.3dl`: port JS `write3dl` (mesh header `3DMESH`/`Mesh 10 12` as Photoshop writes; check what
    `craft_cms::lutfile::parse_3dl` accepts and write that, so our own reader round-trips);
  - `.csp`: `CSPLUTV100`, `3D`, `BEGIN METADATA … END METADATA` with title/copyright, three identity
    pre-LUTs (`2 / 0.0 1.0 / 0.0 1.0`), `N N N`, values red fastest;
  - `.icc`: a DeviceLink (class `link`, RGB→RGB, A2B0 = identity curves + `Clut` of the table + identity
    curves) through `craft_cms::write::encode`; `desc` = Description, `cprt` = Copyright. In a CMYK or Lab
    document Photoshop writes an abstract Lab profile; do the RGB case and refuse ICC elsewhere with a
    clear error until a Lab variant is added.
- Params: `{"path":base path,"formats":["cube","3dl","csp","icc"]=["cube"],"size":7..256=33 (Photoshop's
  Quality),"title":str?,"copyright":str?,"lowercase":bool=true,"scope","layers"}` → `{files:[…]}`;
  without `path` return `{cube, threeDl, csp, icc (base64)}`. Lift the 129 clamp for writing (the 129 cap
  is `craft_cms::lutfile::MAX_SIZE` for parsing); stream the text writers for 256³; ICC grid points ≤ 255
  (u8 in the CLUT header), so cap ICC at 255 and say so.
- UI: the export dialog gains Copyright, Use lowercase file extensions, Quality slider with Photoshop's
  names and the four format check boxes (the dialog is opened from
  `crates/ui-egui/src/menus/view_cmds/dialogs.rs`, which handles `file.export.colorLookupTables`).
- i18n: "Copyright:", "Use lowercase file extensions", "Quality:", "Poor", "Low", "Medium", "High",
  "Maximum", "Grid Points:", "Formats:", "3DL", "CUBE", "CSP", "ICC Profile".

**PSD.** n/a.

**Tests.** Each written format parses back with craft-cms's readers (.cube, .3dl) or a test parser (.csp)
to the same table within quantisation (12-bit for .3dl); the ICC opens with `craft_cms` and transforms a
few colours like the table; copyright appears in each file; `formats` writes 4 files with lowercase
extensions.

**Effort.** M (1 day).

### 4.5 File Info: Basic with Rating; Origin, IPTC, IPTC Extension, GPS; Camera Data tags (rows 33, 34, 35, 36)

**Photoshop.** File Info tabs: Basic (Document Title, Author, Author Title, Description, Rating 0–5
stars, Description Writer, Keywords, Copyright Status, Copyright Notice, Copyright Info URL, created /
modified / application / format read-outs), Camera Data (make, model, serial, date, exposure, program,
metering, ISO, flash, focal length, lens, white balance, …), Origin (Date Created, City, State, Country,
Credit Line, Source, Headline, Instructions, Transmission Reference, Urgency), IPTC (IPTC Core: creator
contact info, headline, subject code, description writer, date created, intellectual genre, scene,
location, ISO country code, title, job identifier, instructions, credit, source, copyright, rights usage
terms), IPTC Extension (person shown, location shown/created, organisation name/code, event, model and
property releases, model age, additional model info, licensor, image supplier/creator, copyright owner,
digital source type, max available size, registry entry, artwork or object), GPS Data (read-only
latitude, longitude, altitude, time, direction …), Audio Data, Video Data, Photoshop (history log),
DICOM, AEM, Raw Data (the packet).

**JS.** `renderer/lib/file-info.js`: Basic with rating, credit and source (`normaliseInfo`,
`xmpPacket`, `parseXmp` — 10 XMP fields), EXIF `readExif`/`readTiffExif` with 17 tags (`TAGS_EXIF` line
172: exposure time, f-number, exposure program, ISO, date original, exposure bias, metering, flash,
focal length, 35 mm, white balance, lens make, lens; IFD0 make, model, software, date), `describeExif`;
PSD XMP stamping `injectPsdXmp`, JPEG `injectJpegXmp`. No IPTC-IIM, no GPS.

**PhotoCraft now.** `file.fileInfo` (`crates/engine/src/cmd/file_cmds.rs` line 340) with title, author,
authorTitle, description, keywords, copyright, copyrightStatus, copyrightUrl; read-only `camera`
(9 fields). Implementation `crates/engine/src/cmd/file_cmds/info.rs` (`INFO_FIELDS` line 6, hand-rolled
XMP text search, `camera_data` 288 from `photocraft_algo::exif::read` (`crates/algo/src/exif.rs` line 113,
`CameraInfo` 9 fields), `write_file_info` 318, `file_info` 381). Storage `Metadata { xmp, exif,
psd_resources, … }` (`crates/doc/src/lib.rs` line 876). UI `crates/ui-egui/src/menus/view_cmds/dialogs.rs`
line 142/458. craft-libs at the pinned rev has `craft-metadata` (EXIF with GPS, flash, bias, program,
metering, white balance, software, serials; IPTC-IIM `parse_iptc`; XMP `parse_xmp`/`write_xmp`/`merge_xmp`
that keeps unknown properties) — not yet a Pigment dependency.

**Build (F1).**
- Dependency: `craft-metadata` (git, same rev) in `crates/engine/Cargo.toml` (and `crates/io` for export).
- Model: keep the XMP packet as the truth (`Metadata.xmp`), as today. Replace the text-search helpers in
  `info.rs` with `craft_metadata::parse_xmp` for reading and `merge_xmp` for writing (so properties
  PhotoCraft does not model survive, which the current code also intends). Field table
  `INFO_FIELDS` grows to a data-driven list `[(param, xmp_path, kind /*Alt|Seq|Bag|Text|Date|Int|Struct*/,
  tab)]`:
  - Basic: `rating` → `xmp:Rating` (0–5; −1 = rejected is not shown), `descriptionWriter` →
    `photoshop:CaptionWriter`, read-only `created` (`xmp:CreateDate`), `modified` (`xmp:ModifyDate`),
    `application` (`xmp:CreatorTool`), `format` (`dc:format`);
  - Origin: `dateCreated` (`photoshop:DateCreated`), `city`, `state`, `country` (`photoshop:*`),
    `credit` (`photoshop:Credit`), `source` (`photoshop:Source`), `headline` (`photoshop:Headline`),
    `instructions` (`photoshop:Instructions`), `transmissionReference` (`photoshop:TransmissionReference`),
    `urgency` (`photoshop:Urgency`, 1–8 or none);
  - IPTC Core: `creatorContactInfo` struct (`Iptc4xmpCore:CreatorContactInfo` with `CiAdrExtadr`,
    `CiAdrCity`, `CiAdrRegion`, `CiAdrPcode`, `CiAdrCtry`, `CiTelWork`, `CiEmailWork`, `CiUrlWork`),
    `subjectCode` (Bag), `intellectualGenre`, `scene` (Bag), `sublocation` (`Iptc4xmpCore:Location`),
    `countryCode`, `usageTerms` (`xmpRights:UsageTerms`), `altText` (`Iptc4xmpCore:AltTextAccessibility`,
    shared with the AI team's Describe Image, which writes the description/alt text: coordinate the key);
  - IPTC Extension: `personInImage` (Bag), `locationShown`/`locationCreated` (Bag/Seq of structs
    `Iptc4xmpExt:LocationDetails`: Sublocation, City, ProvinceState, CountryName, CountryCode,
    WorldRegion), `organisationInImageName`/`Code` (Bag), `event` (Alt), `modelReleaseStatus`
    (`plus:ModelReleaseStatus` URI), `modelReleaseId` (Bag), `propertyReleaseStatus`, `propertyReleaseId`,
    `modelAge` (Bag), `additionalModelInfo`, `licensor` (`plus:Licensor` Seq of structs: name, id, phone,
    email, URL), `imageSupplier`, `imageCreator`, `copyrightOwner` (`plus:*` Seq of {name,id}),
    `digitalSourceType` (`Iptc4xmpExt:DigitalSourceType` URI list), `maxAvailWidth`/`Height`,
    `registryId` (Bag of {item id, org id}), `artworkOrObject` (Bag of structs);
  - GPS (read-only): from EXIF (`craft_metadata` `Gps`) else XMP `exif:GPS*`;
  - Raw Data (read-only view of the packet, plus Copy); Audio/Video/DICOM/AEM/Photoshop history: show
    the XMP namespaces if present (`xmpDM:*`, `photoshop:History`) read-only. The history log tab ties to
    Preferences › History Log (`Preferences.history_log`): if it writes into metadata, show it.
- Camera Data: `camera_data` reads `craft_metadata::read_exif` and returns every field JS showed plus
  Photoshop's: make, model, serial, lens make/model, software, date original, exposure, f-number,
  exposure program (name), metering mode (name), ISO, flash (fired / mode / red-eye text), exposure bias,
  focal length (+35 mm), white balance, pixel dimensions, orientation. Keep `photocraft_algo::exif` for
  other callers or retire it if nothing else uses it.
- IPTC-IIM: on PSD import keep resource 1028 (already raw in `psd_resources`); on save, when the user
  edited File Info, rewrite 1028 from the XMP fields that have IIM datasets (2:05 object name, 2:80
  by-line, 2:85 by-line title, 2:120 caption, 2:122 caption writer, 2:25 keywords, 2:116 copyright,
  2:90 city, 2:92 sublocation, 2:95 state, 2:100 country code, 2:101 country, 2:105 headline, 2:110
  credit, 2:115 source, 2:40 instructions, 2:103 transmission reference, 2:10 urgency, 2:55/2:60 date and
  time created) with a small writer `crates/io/src/iptc_iim.rs` (tag 0x1C, record, dataset, u16 length,
  UTF-8 with the 1:90 coded-character-set ESC % G); JPEG export puts it in APP13 "Photoshop 3.0" IRB
  when Export's metadata setting includes it. Reading: when a file has IIM but no XMP (old JPEGs), seed
  the XMP from `parse_iptc` (Photoshop does the same reconciliation).
- `file.fileInfo` params grow with every key above (`"rating":0..5`, …, structs as JSON objects); no keys
  = read all, including read-only `camera`, `gps`, `raw` (packet text), `created`… One history step
  "File Info" as today.
- UI: `crates/ui-egui/src/menus/view_cmds/dialogs.rs` File Info dialog becomes tabbed
  (`crates/ui-egui/src/dialogs/file_info_ui.rs`, new): Basic (with a 5-star rating widget), Camera Data,
  Origin, IPTC, IPTC Extension, GPS Data, Raw Data, and Audio/Video/DICOM/Photoshop shown only when data
  exists; Template Folder / Import… / Export… (.xmp metadata templates: write/read an XMP packet file) as
  Photoshop's bottom-left menu — not a Pigment-ahead row, cheap to add (S).
- i18n: every tab and field label above in Photoshop's wording ("Document Title", "Author Title",
  "Rating", "Description Writer", "Date Created", "Credit Line", "Transmission Reference", "Urgency",
  "Headline", "Instructions", "Creator", "Creator's Job Title", "Address", "Postal Code", "Phone(s)",
  "Email(s)", "Website(s)", "IPTC Subject Code", "Intellectual Genre", "IPTC Scene Code", "Sublocation",
  "ISO Country Code", "Rights Usage Terms", "Person Shown", "Location Shown", "Location Created",
  "Organisation Name", "Organisation Code", "Event", "Model Release", "Property Release", "Model Age",
  "Additional Model Info", "Licensor", "Image Supplier", "Image Creator", "Copyright Owner", "Digital
  Source Type", "Max Avail Width", "Max Avail Height", "Registry Entry", "Artwork or Object", "Latitude",
  "Longitude", "Altitude", "GPS Time", "Raw Data", …).

**PSD.** XMP in image resource 1060 (as today), IPTC-IIM in resource 1028, EXIF in 1058 (kept, not
rewritten except Orientation as today). JPEG/TIFF/PNG/WebP export keep writing XMP the way the export
code already does (`metadata` export setting).

**Tests.** engine: set every field → read back identical; the written packet parses with
`craft_metadata::parse_xmp` and still holds an unknown property from the original packet; rating 7 →
clamped 5; IIM writer → `parse_iptc` round trip for the mapped datasets with UTF-8; a JPEG fixture with
IIM only seeds the fields; Camera Data of an EXIF fixture with GPS returns all JS's 17 tags and GPS.
io: PSD save rewrites 1028 only when File Info changed (byte-identical otherwise). ui: the tabbed dialog
edits the headline and OK writes one history step.

**Effort.** L (2 days).

## 5. Panels

### 5.1 Info panel: readout modes, 16-bit and 32-bit values (rows 41, 42)

**Photoshop.** Info panel: two colour readouts, each with a mode menu (eyedropper icon or Panel Options):
Actual Color, Proof Color, Grayscale, RGB Color, Web Color, HSB Color, CMYK Color, Lab Color, Total Ink,
Opacity; in 16-bit documents values read 0–32768 (or 0–65535 with the "16-bit (0–65535)" option in
Panel Options' readout menu — Photoshop's Info Panel Options › … "16-bit values"), 32-bit documents show
floats (0.0–1.0, over 1 for HDR); Panel Options also choose Mouse Coordinates units and Status
Information.

**JS.** `renderer/lib/panels/info.js`: second readout select CMYK/Lab/HSB (`settings.infoSecondary`);
`renderer/lib/depth.js` deep readout (0–32768 scale, or 0–65535 with `settings.info16Range`; floats for
32-bit).

**PhotoCraft now.** `crates/ui-egui/src/panels/info.rs` `info_panel` (line ~35): fixed RGB 0–255
(`q()` clamps `(v*255).round()`) and colour-managed CMYK % (`sampler_cmds::device_cmyk`); Color Sampler
rows the same. Sampling `document.sampleColor` returns floats 0..1 (`pointer_sample`). Conversions
exist: `photocraft_color::convert::srgb_to_lab` (`crates/color/src/convert.rs` line 201), `rgb_to_hsb`
(251).

**Build (U1).**
- `Preferences.adjustments.info_panel` (D3) or a new `Preferences.info` section:
  `{"first":"actual|proof|gray|rgb|web|hsb|cmyk|lab|totalInk|opacity"="actual","second":…="cmyk",
  "sixteenBit":"32768|65535"="32768","samplers":[mode per sampler]?}` (Photoshop also lets each Color
  Sampler choose its mode: store a mode per sampler index).
- `crates/ui-egui/src/panels/info_readout.rs` (new, pure): `fn readout(mode, rgba: [f32;4], depth:
  SampleType, doc_mode, cmyk_space, proof) -> Vec<(&'static str /*label*/, String)>`: Actual = the
  document's own channels (RGB/Gray/CMYK/Lab per `doc.mode`); Proof = through the View › Proof Setup
  transform (`crates/engine/src/proof_sim.rs`); Grayscale K %; RGB in the depth's scale; Web = hex;
  HSB °/%/%; CMYK %; Lab; Total Ink = C+M+Y+K %; Opacity = alpha %. Depth scaling: 8-bit 0–255, 16-bit
  `(v*32768).round()` or `(v*65535).round()`, 32-bit `format!("{v:.4}")` without clamping.
- `info.rs`: the two columns call `readout`; clicking the column's label opens the mode menu (Photoshop's
  eyedropper icon); a panel menu "Panel Options…" opens a small dialog with the two modes, the 16-bit
  range and (existing) unit choices. Color Sampler rows use their own mode (right-click a sampler row →
  mode menu).
- `sampler_cmds::point_json` (`crates/engine/src/cmd/sampler_cmds.rs` line 57) gains `"float":[r,g,b,a]`
  so the samplers can read deep values (today they return rounded 8-bit `rgb`).
- i18n: "Actual Color", "Proof Color", "Grayscale", "RGB Color", "Web Color", "HSB Color", "CMYK Color",
  "Lab Color", "Total Ink", "Opacity", "Panel Options…", "Info Panel Options", "First Color Readout",
  "Second Color Readout", "Mode:", "16-bit values: 0–32768", "16-bit values: 0–65535".

**Tests.** `info_readout` unit tests: 16-bit mid grey reads 16384 / 32768; 32-bit 1.5 reads 1.5000;
HSB of pure red 0°/100%/100%; Total Ink of black; Web hex. ui: switching the second readout to Lab shows
L/a/b labels; prefs round trip.

**Effort.** S–M (1 day).

### 5.2 Actions: Clear All Actions, Reset Actions, Replace Actions (row 39)

**Photoshop.** Actions panel menu: Clear All Actions, Reset Actions (back to Default Actions, with
Append/OK), Load Actions…, Replace Actions…, Save Actions…, and the bundled sets.

**JS.** `actions:clear`, `actions:reset` (restores the Default Actions set) — `renderer/lib/actions.js`,
`renderer/lib/panels/actions.js` context menu.

**PhotoCraft now.** `crates/ui-egui/src/panels/actions.rs` `panel_menu` (line 1585): New Action, New
Set, Duplicate, Delete, Play, Start/Stop Recording, Record Again, Insert Menu Item, Insert Stop, Insert
Path, Playback Options, Allow Tool Recording, Load Actions…, Save Actions…. Engine
`actions.load {"replace":bool=true}` (`crates/engine/src/cmd/atn_cmds.rs` line 133) replaces a set of
the same name only.

**Build (U2).**
- Engine `crates/engine/src/cmd/actions_edit_cmds.rs`: `actions.clearAll {}` (journal false; empties
  `s.actions.list`, refused while recording) and `actions.reset {"append":bool=false}` (replace the list
  with the Default Actions set of 5.3, or append it); `actions.load` gains `"replaceAll":bool=false` for
  Replace Actions… (clear, then load).
- UI `panel_menu`: after Save Actions…, "Clear All Actions", "Reset Actions", "Replace Actions…", with
  Photoshop's confirmation ("Delete all actions?"; "Replace current actions with the default actions?"
  OK / Cancel / Append).
- i18n: "Clear All Actions", "Reset Actions", "Replace Actions…", "Delete all actions?", "Replace current
  actions with the default actions?", "Append".

**Tests.** engine: clearAll empties and persists (`sync_actions`); reset restores the default set;
reset with append keeps user actions; refused while recording. ui: menu items call the commands after the
confirmation.

**Effort.** S.

### 5.3 Actions: Default Actions set and bundled sets (rows 37, 38)

**Photoshop.** The Default Actions set (Vignette (selection), Frame Channel – 50 pixel, Wood Frame – 50
pixel, Cast Shadow (type), Water Reflection (type), Custom RGB to Grayscale, Molten Lead, Make Clip Path
(selection), Sepia Toning (layer), Quadrant Colors, Save As Photoshop PDF, Gradient Map, Mixer Brush
Cloning Paint Setup) and bundled sets (Commands, Frames, Image Effects, LAB – Black & White Technique,
Production, Star Trails, Text Effects, Textures, Video Actions).

**JS.** `renderer/lib/actions/defaults.js` `defaultActions()`: ten actions under Photoshop's names
rebuilt from Pigment commands (Vignette (selection), Frame Channel – 50 pixel, Wood Frame – 50 pixel,
Cast Shadow (type), Water Reflection (type), Custom RGB to Grayscale, Molten Lead, Sepia Toning (layer),
Quadrant Colors, Gradient Map); re-created when no set is left.

**PhotoCraft now.** No bundled actions; `atn_cmds::DEFAULT_SET = "Pigment Actions"` (line 105) is only the
set name Save Actions uses.

**Build (U2).** `crates/engine/src/actions_default.rs` (new): `pub fn default_actions() -> Vec<Action>`
(set "Default Actions"), the JS ten translated step by step to PhotoCraft commands, e.g. Vignette:
`select.modify.feather {"radius":5}`, `layer.new.layerViaCopy`, `select.deselect`, `layer.new.layer
{"name":"Vignette Background"}`, `edit.fill {"use":"white"}`, `layer.arrange.sendBackward`; Frame
Channel: `layer.new.layer`, `select.all`, `edit.stroke {"width":50,"location":"inside","color":"#9c9c9c"}`,
`select.loadSelection` (layer transparency), `select.saveSelection {"name":"Frame"}`, `select.deselect`,
`layer.layerStyle.bevelEmboss {…}`; Wood Frame: `image.canvasSize {"relative":true,…}`, …,
`filter.render.fibers`; Cast Shadow / Water Reflection with `layer.duplicate`, `edit.transform` (matrix),
`filter.blur.gaussianBlur`, `filter.distort.ripple`; Custom RGB to Grayscale `image.adjustments.channelMixer
{"monochrome":true,"gray":[24,68,8,0]}`; Molten Lead (Chrome is a Filter Gallery kind: use PhotoCraft's
gallery command id), Levels, Hue/Saturation colorize; Sepia Toning, Quadrant Colors, Gradient Map likewise.
Add Photoshop's remaining three where PhotoCraft has the commands (Make Clip Path (selection):
`select.makeWorkPath` + clipping path; Save As Photoshop PDF: `file.saveAs {"format":"pdf"}` with dialog
on; Mixer Brush Cloning Paint Setup: tool selection steps, which PhotoCraft records as tool steps).
Every step id is validated in a test against the registry, and parameters by running the action on a
fixture document. Seeded on first launch (no `actions.json` in the preset store) and by Reset Actions;
not re-created automatically when the user deletes it (Photoshop does not either; JS did — drop that
quirk). The other bundled Adobe sets: dropped (Adobe content; JS had none of them).
i18n: action and set names stay English, as Photoshop's are localised by Adobe per language only in the
shipped files — translate them through `tl!` at display time like built-in preset names.

**Tests.** every default action plays without error on a 400×300 RGB document with a type layer and a
selection where it needs one; the step ids all exist; Reset Actions recreates the set.

**Effort.** M (1 day).

### 5.4 Actions: Insert Conditional (row 40)

**Photoshop.** Actions panel menu › Insert Conditional…: If Current (Document Mode Is RGB, Document Is
Landscape, Layer Is Background, Layer Has Pixel Mask, …), Then Play Action, Else Play Action.

**JS.** `actions:insert-conditional` with the condition list in `renderer/lib/actions/model.js` and its
dialog in `renderer/lib/actions/dialogs.js`.

**PhotoCraft now.** `actions.conditional` (`crates/engine/src/cmd/actions_edit_cmds.rs` line 483) plays
and round-trips .atn conditionals with 33 conditions (`always|never|isOpen|landscape|…|hasEffects`); no
panel dialog.

**Build (U2).** `crates/ui-egui/src/panels/actions/conditional.rs` (new, beside `menu_item.rs`): the
dialog (If Current: dropdown of the conditions with Photoshop's labels; Then Play Action / Else Play
Action: dropdowns of the actions in the panel plus None), inserting through `actions.insert` a step
`("actions.conditional", {"if","then","else"})` after the selected step (as Insert Stop does,
`actions.rs` line 1032). Double-clicking a conditional step re-opens the dialog to edit it. Menu item
"Insert Conditional…" after Insert Stop….
i18n: "Insert Conditional…", "Conditional Action", "If Current:", "Then Play Action:", "Else Play
Action:", "None", and the condition labels ("Document Is Open", "Document Is Landscape", "Document Is
Square", "Document Is Portrait", "Document Mode Is RGB", … "Layer Has Effects").

**Tests.** ui: the dialog inserts the step with the chosen params; editing changes it; engine already
tests playback.

**Effort.** S.

### 5.5 Pen tablet: tilt, rotation, barrel wheel, eraser end, side buttons (rows 43, 44)

**Photoshop.** Pressure, tilt, barrel rotation (Art Pen), stylus wheel (Airbrush), eraser end, side
buttons on every platform with Windows Ink or WinTab.

**JS.** Chromium pointer events give `pressure`, `tiltX/Y`, `twist`, `tangentialPressure`, the eraser
button (buttons bit 5) on Windows Ink, macOS, Linux; the 0.5 brush engine (JS 0.5 `renderer/lib/brush/
engine.js`, `tools/paint-gesture.js`) uses them.

**PhotoCraft now.** `crates/tablet` (`lib.rs` header): macOS AppKit monitor (pressure, tilt, rotation),
Windows WM_POINTER hooks reading only `PEN_FLAG_BARREL`/`PEN_FLAG_INVERTED` (`windows.rs`
`read_pen_flags` line ~227 already calls `GetPointerPenInfo` and gets a `POINTER_PEN_INFO` with
`rotation`, `tilt_x`, `tilt_y` fields, line 94–100, but returns only `pen_flags`), WinTab opt-in (tilt,
rotation), X11 XInput2; Wayland only via Xwayland. Engine controls `Control::PenTilt`, `Rotation`,
`StylusWheel` (`crates/paint/src/brush.rs` line 28, `dynamics.rs` line 461–463); UI
`crates/ui-egui/src/input/stylus.rs` pushes `[tilt_x, tilt_y, rotation]` (line 388).
`docs/hardware-parity.md` table: Windows Ink no tilt/rotation; macOS rotation not applied to the tip
angle (upstream #1301).

**Build (U3).**
- Windows Ink: `crates/tablet/src/windows.rs`: `read_pen_flags` → `read_pen_info(pointer_id) ->
  Option<PenInfo { flags, pressure: u32 /*0..1024*/, tilt_x: i32, tilt_y: i32, rotation: u32 }>` using
  `pen_mask` bits (`PEN_MASK_PRESSURE|ROTATION|TILT_X|TILT_Y`) to know which fields are valid; publish a
  `Sample` (tilt in degrees as the W3C convention the crate uses, rotation 0..360) through the same
  callback the macOS monitor uses, so `stylus.rs` gets tilt and rotation without WinTab. Keep winit's
  pressure if `PEN_MASK_PRESSURE` is unset. Pure mapping function `windows::sample_from_pen_info` with
  unit tests (runs on every OS, like `appkit`/`xi`).
- macOS rotation (#1301): reproduce with a test that feeds `appkit` samples with rotation into
  `stylus.rs` → stroke points → `dynamics.rs` angle with `Control::Rotation`; find where the rotation is
  dropped (candidates: `stylus.rs` interpolation line 302–308, the `StrokePoint` build, or AppKit giving
  rotation only on tablet-point events not mouse-drag events: `macos.rs` line 84 reads it only when
  `point`) and fix; confirm on hardware.
- Stylus wheel (tangential pressure, Airbrush): Windows `POINTER_PEN_INFO` has none; WinTab (`wintab.rs`)
  and macOS `tangentialPressure` do: map to `Control::StylusWheel` where present.
- Native Wayland: dropped (reason in section 8).
- Update `docs/hardware-parity.md` rows.

**Tests.** `windows::sample_from_pen_info` (mask bits, ranges, degrees); stylus pipeline test with a
synthetic rotation sample; manual check list on a Wacom/Surface pen (Windows Ink on) and a Mac.

**Effort.** M (1 day, plus hardware verification).

## 6. More

### 6.1 Select Similar Layers (row 45)

**Photoshop.** Select › Similar Layers: selects every layer of the same kind as the selected one(s)
(pixel, type, shape, adjustment, fill, smart object, group…).

**JS.** `renderer/lib/layer-dialogs.js` `selectSimilar` (line 254: `layers.filter(l => l.type ===
active.type)`), command `layer:select-similar`, menu `shared/menu-template.js` line 507.

**PhotoCraft now.** Select › Similar is the pixel command `select.similar`
(`crates/engine/src/cmd/selection_cmds.rs` line 785); no layer version. Layer selection helpers in
`crates/engine/src/cmd/layer_multi_cmds.rs` (`select.allLayers` line 96, `select_linked`,
`set_selection`).

**Build (U4).** `select.similarLayers` in `layer_multi_cmds.rs` specs (menu `["Select"]`, enabled when
a layer is active): collect the kinds of the selected layers (`LayerContent::kind_name`, with
adjustment layers of any kind and fill layers of any kind matching each other, as Photoshop), select every
layer in the tree (inside groups too) of those kinds through `set_selection`, keep the active layer.
`crates/ui-egui/src/menu_catalog.rs`: `(&["Select"], "Similar Layers", None, "select.similarLayers")`
in the Select menu's layer group (All Layers, Deselect Layers, Find Layers, Isolate Layers), right after
Deselect Layers, where Photoshop has listed it since CS6 (JS put it there too).
i18n: "Similar Layers".

**Tests.** a document with two text layers in different groups and a pixel layer: active text →
both text layers selected; an adjustment layer selects all adjustment layers.

**Effort.** S.

### 6.2 Operating-system recent documents (row 46)

**Photoshop.** Files opened or saved appear in the OS recent lists (Windows Jump List / Recent, macOS
Recent Items and the Dock menu, Linux recently-used).

**JS.** `src/main/ipc.js` line 191 calls Electron `app.addRecentDocument` for every file opened or saved.

**PhotoCraft now.** In-app list only: `crates/ui-egui/src/app/files.rs` `push_recent` (line 11, called
from `files.rs` 717 and `file_open.rs` 247), stored in `fileHandling.recentFiles`.

**Build (U4).**
- `apps/photocraft/src/os_recent.rs` (new): `pub fn note(path: &Path)`:
  - Windows: `SHAddToRecentDocs(SHARD_PATHW, path_wide)` (shell32; declare the extern like the tablet
    crate declares `GetPointerPenInfo`, with a `SAFETY:` comment) — this also feeds the taskbar Jump List
    when the app has an AppUserModelID (check the MSI/shortcut sets one; packaging in `packaging/`);
  - macOS: `NSDocumentController::sharedDocumentController().noteNewRecentDocumentURL(NSURL::fileURLWithPath)`
    (add `NSDocumentController` to the `objc2-app-kit` features and `NSURL` to `objc2-foundation` in
    `apps/photocraft/Cargo.toml` line 72–74);
  - Linux/FreeBSD: append a bookmark to `$XDG_DATA_HOME/recently-used.xbel` (default
    `~/.local/share/recently-used.xbel`) with mime type, application name "Pigment", exec
    `pigment %u`, and `visited/modified` times, written atomically with a lock (GTK's format; keep at most
    the last 500 entries of our own app), or skip silently when the file is not writable.
  - Respect Preferences: only when the recent list is on (`recent_file_count > 0`) and not for files in
    the crash-recovery folder.
- Hook: `PhotocraftApp` gets `pub os_recent: Option<fn(&std::path::Path)>` (ui-egui stays
  platform-free); `push_recent` calls it; `apps/photocraft/src/main.rs` sets it at startup. The web app
  leaves it `None`. Clear Recent (`clear_recent`) also clears our own entries on Linux; Windows/macOS
  have no per-app clear API besides `SHAddToRecentDocs(…, NULL)` (clears all; do not call it).
- i18n: none.

**Tests.** Linux writer unit test on a temp XDG_DATA_HOME (adds, de-duplicates, keeps others' bookmarks
byte-identical); a ui-egui test that `push_recent` calls the hook; Windows/macOS calls behind `cfg` with
a smoke test that they do not panic on a missing file.

**Effort.** S.

## 7. The `.pigment` importer for Pigment 0.1–0.4

### 7.1 The format, as the JavaScript app wrote it

Writer `renderer/lib/io.js` `writePigment` (line 198), reader `readPigment` (243); description
`renderer/lib/document.js` `Document.describe()` (line 735) and `Layer.describe()` (180); smart layers
`renderer/lib/smart-object.js` `registerLayerType('smart', …, {describe})` (line 395); collections
`renderer/lib/doc-store.js` (`guides`, `rulerOrigin`). `document.json` versions: **1** (0.1–0.2:
`describe` at commit 726b605), **2** (0.3: mode, depth, colorTable, duotone; text as `text` + `font`),
**3** (0.4: `store`, rich text `content`, `profile`, vector masks, blending, mask density/feather).

ZIP entries (store or deflate, `src/shared/zip.js`): `mimetype` (`application/x-pigment`, first),
`document.json`, `layers/<id>.png` (raster pixels, 8-bit RGBA, straight), `layers/<id>.u16|f32` (16/32-bit
straight RGBA, little-endian, deflated, same size as the PNG), `masks/<id>.png` (layer mask, grey in
RGBA), `patterns/<id>.png` (a pattern fill's tile), `smart/<id>.pigment` (nested document) or
`smart/<id>.png` (image source), `selection.bin` (w×h u8), `channels/<id>.bin` (w×h u8 each),
`profile.icc`, `thumbnail.png`.

PhotoCraft's hook: `crates/io/src/legacy_pigment.rs` `import(name, bytes, ctl)` returns
`IoError::LegacyPigment` today; every open path reaches it (`crates/io/src/lib.rs` routes
`Route::LegacyPigment` at lines ~967, 1029, 1050), recognised by content
(`photocraft_format::brand::is_legacy_pigment`). `craft_zip` is already a dependency (the module's test
writes a ZIP with it).

### 7.2 Field map

Module layout: `crates/io/src/legacy_pigment.rs` becomes `legacy_pigment/mod.rs` (`import`, `is_legacy`,
the report), `container.rs` (ZIP + `document.json` + entry lookup with size limits), `layers.rs`,
and the D5 mappers `adjust.rs`, `styles.rs`, `gradient.rs`, `path.rs`, `text.rs`, `blend.rs`, `brush.rs`
(the last for P4). Losses are collected in `ImportResult` warnings (the same list other importers fill)
as one line each, so File › Open shows them like the PSD import report.

**Document (`document.json` top level).**

| JS field (version) | PhotoCraft | Notes |
|---|---|---|
| `version` 1/2/3 | — | > 3: open with a warning "saved by a newer Pigment" and read what is known |
| `app` = `"pigment"` | — | anything else: not a legacy file (error, as JS) |
| `width`, `height` | `Document.size` | clamp to the import limits |
| `dpi` | `resolution_dpi` | default 72 |
| `name` | `Document.name` | else the file name |
| `mode` (2+) `rgb`, `grayscale`, `bitmap`, `duotone`, `indexed`, `cmyk`, `lab`, `multichannel` | `Document.mode` (`ColorMode`) | JS stored every mode as RGBA pixels with a mode flag; convert: RGB as is; grayscale → `Grayscale` from luma; indexed → Indexed with `colorTable` (+ `meta.imageMode.transparentIndex`); bitmap → Bitmap (threshold 50 %, as JS rendered); duotone → Duotone with `duotone` inks/curves mapped to PhotoCraft duotone data; cmyk/lab → open as **RGB** with a warning (JS's CMYK/Lab were "honest approximations" over RGB storage, its parity doc says; converting would invent ink values); multichannel → RGB + spot channels from `meta.imageMode` with a warning |
| `depth` 8/16/32 | `Document.depth` (`SampleType`) | 16/32: raster layers take their deep planes (below); 32-bit JS was display-referred: keep values, warn that it was not linear |
| `colorTable` (2+) | indexed palette | |
| `duotone` (2+) `{type, inks:[{name, color, curve}]}` | duotone model | curve points 0..255 → 0..1 |
| `active` | `DocState.active_layer` | by JS id → new id map |
| `store.guides` (3) / `guides` (1–2) `[{axis:'x'\|'y', pos, color?, artboard?}]` | `Document.guides` | `x` = vertical guide at pos; colour kept when PhotoCraft guides carry one, else dropped with a warning; `artboard` ignored (JS artboards were not real) |
| `store.rulerOrigin` (3) | `Document.ruler_origin` | |
| other `store.*` collections | — | unknown collections: warning listing their names |
| `channels` `[{id, name}]` + `channels/<id>.bin` | `Document.channels` (`AlphaChannel`) | length must be w×h, else skipped with a warning; spot flags from `meta.imageMode` |
| `selection.bin` | `Document.selection` | w×h u8 → mask 0..1 |
| `paths` `[{id, name, path}]` | `Document.paths` | `legacy_pigment::path`: JS PathData `{subpaths:[{closed, points:[{x,y,in?,out?, …}]}]}` → PhotoCraft `Path` (anchor + control points; operation per component if present) |
| `workPath` | `Document.work_path` | |
| `globalLight {angle, altitude}` | `Document.global_light` (`GlobalLight`, `crates/doc/src/lib.rs` line 915) | |
| `profile {id, name, colorSpace, wellKnown}` + `profile.icc` | `Document.icc_profile` | bytes when present; well-known id without bytes (`srgb`, `display-p3`, `adobe-rgb` …) → the matching built-in profile from craft-cms; else untagged with a warning |
| `meta.title/author/description/copyright/keywords/rating/credit/source/copyrightStatus/copyrightUrl` | XMP packet in `Metadata.xmp` | through F1's writer (or today's `file_cmds::info::write_file_info` equivalent in io: move the XMP writing helper to io so both use it); `copyrightStatus: 'public'` → `xmpRights:Marked False` |
| `meta.exif` | `Metadata.exif` | JS kept the parsed object, not bytes: write the values into XMP `exif:`/`tiff:` properties so Camera Data shows them; warn that the original EXIF block is gone |
| `meta.layerTags {[id]: {color?, linked?}}` | `Layer.label` (`LabelColor`), `Layer.link_group` | JS colour names `red, orange, yellow, green, blue, violet, gray` → PhotoCraft labels; linked layers sharing a link set → one `link_group` id |
| `meta.imageMode` | indexed `transparentIndex`, multichannel spot state | |
| `meta.url`, `meta.note`, `meta.adjustment` | — | dropped silently (internal UI state) |
| `thumbnail.png`, `mimetype` | — | ignored |

**Every layer (`Layer.describe`).**

| JS field | PhotoCraft `Layer` | Notes |
|---|---|---|
| `id` (string) | new `LayerId`; map kept for `active`, `sourceRef`, layer tags | |
| `type` `raster\|group\|text\|shape\|fill\|adjustment\|smart` | `LayerContent` variant | unknown type: an empty pixel layer named after it, warning |
| `name`, `visible` | `name`, `visible` | |
| `opacity`, `fillOpacity` (0..1) | `opacity`, `fill_opacity` | |
| `blend` (`normal` … `luminosity`, `pass-through` on groups) | `blend` (`BlendMode`) via `legacy_pigment::blend` | names are Photoshop's kebab-case (`shared/pixels/blend.js` `BLEND_MODES`) |
| `locked {pixels, position, transparency, all}` | `locks` | `all` → all locks; artboard lock n/a |
| `clip` | `clipped` | |
| `hasMask`, `maskEnabled`, `maskLinked`, `masks/<id>.png`, `maskDensity` (3), `maskFeather` (3) | `mask: Some(LayerMask { surface, enabled, linked, density, feather })` | the PNG's red channel is the mask; the JS mask canvas is document-sized at (0,0) — check the PNG size; another size is placed at (0,0) with the default colour (white) outside, warning |
| `vectorMask {path, enabled, linked, density, feather, initialFill}` (3) | `vector_mask: Some(VectorMask)` | `initialFill: 'reveal'` → the path inverted per PhotoCraft's vector-mask convention (Photoshop: "Reveal All" + subtract) |
| `styles` (`shared/pixels/styles.js` schema: `dropShadow`, `innerShadow`, `outerGlow`, `innerGlow`, `bevel`, `satin`, `colorOverlay`, `gradientOverlay`, `patternOverlay`, `stroke`; arrays for multi-instance kinds; `hidden`) | `effects: Effects` via `legacy_pigment::styles` | field by field (opacity 0..1, angle, distance, spread %, size px, blend, colour, gradient stops via `gradient.rs`, contour names → PhotoCraft contours, pattern by name/id into `doc.patterns`); `hidden: true` → effects hidden; unknown keys warned |
| `blending` (3, DEFAULT_BLENDING: channels, knockout, blendIf, blendClipped, blendInterior, transparencyShapes, layerMaskHides, vectorMaskHides) | `excluded_channels`, `advanced` (`AdvancedBlending`), `blend_if` (`BlendIf`) | Blend If ranges 0..255 with split points → PhotoCraft's 0..1 four-value form |

**Raster (`type: 'raster'`).** `x`, `y`, `width`, `height` + `layers/<id>.png` → `LayerContent::Raster`
surface at (x, y) (PNG decoded with the io PNG decoder; size must equal width×height, else take the
PNG's); `deep: 'u16'|'f32'` + `layers/<id>.u16|f32`: when present and of length w·h·4·(2|4), the surface
is built from the deep plane at the document depth (u16 → /65535, f32 as is), the PNG ignored; else the
PNG at 8 bits with a warning.

**Group.** `expanded`, `children` (recursive; depth limit 64 like other importers) → `LayerContent::Group`
(`Group { children, expanded, .. }`, `crates/doc/src/lib.rs` line 319).

**Adjustment (`type: 'adjustment'`, `kind`, `params`).** `legacy_pigment::adjust::to_adjustment(kind,
params, mode) -> Result<Adjustment, String>`:

| JS kind | PhotoCraft | Params |
|---|---|---|
| `brightness-contrast` | `BrightnessContrast` | `brightness`, `contrast`, `legacy` |
| `levels` | `Levels` | `space` (`rgb`/`gray`/`cmyk`/`lab`), composite `rgb` (`inBlack, inWhite, gamma, outBlack, outWhite` 0..255) → `master` /255, `r,g,b` (null = identity; `perChannel:false` (0.3) ignores them) → `per_channel`; CMYK/Lab per `ToneSpace` |
| `curves` | `Curves` | points `[[x,y]…]` 0..255 → `CurvePoint` /255; `{table:[256]}` (drawn) → `pencil: true` + `curve_map`; channels as Levels |
| `exposure` | `Exposure` | same keys |
| `vibrance` | `Vibrance` | same keys |
| `hue-saturation` | `HueSaturation` | `hue, saturation, lightness`; `colorize` with `colorizeHue/Sat/Light` → master values with `colorize: true`; `ranges:[{base, bounds:[4°], hue, saturation, lightness}]` → `ranges[i]` by base (reds=0 … magentas=5), bounds through `HueRange::canonical_bounds` |
| `color-balance` | `ColorBalance` | `shadows/midtones/highlights` arrays, `preserveLuminosity` |
| `black-white` | `BlackWhite` | `reds…magentas` weights, `tint` (null or colour) |
| `photo-filter` | `PhotoFilter` | `color`, `density` %→0..1, `preserveLuminosity` |
| `channel-mixer` | `ChannelMixer` | `r,g,b: {r,g,b,constant}` % → matrix rows /100; `gray` + `monochrome` → monochrome row |
| `color-lookup` | `ColorLookup` | `lut`/`preset` built-in id → nearest `craft_cms::lutfile::BUILTIN` id by name (JS names were Adobe-like and generated by Pigment, PhotoCraft's built-ins are its own, so the look differs: warn), loaded LUT data (`.cube`/`.3dl`/`.look`/`.csp` text) → `LutSource` + parsed table; `dither` |
| `invert`, `posterize` (`levels`), `threshold` (`level` 0..255 → /255) | same | |
| `gradient-map` | `GradientMap` | stops via `gradient.rs` (JS v2 gradient: stops `{pos, mid, color}`, opacity stops, method, smoothness → `GradientSource` + baked `stops`), `reverse`, `dither` |
| `selective-color` | `SelectiveColor` | `relative`/`method`, per range `[c,m,y,k]` |
| `color-vibrance`, `clarity-dehaze`, `grain` | A6's variants | same keys; before A6 lands: `Adjustment::Unsupported` with a warning |
| anything else | `Adjustment::Unsupported { psd_key: "pcJS", raw: params JSON }` | warning; keeps the data for a later version |

**Fill (`type: 'fill'`, `paint`).** `{type:'solid', color}` → `Fill::Solid`; `{type:'gradient', gradient,
kind:'linear|radial|angle|reflected|diamond', angle, scale, reverse, dither, align, offset}` →
`Fill::Gradient` (stops/opacity/midpoints from `gradient.rs`, noise → P3's `noise`); `{type:'pattern',
pattern:{id, name, width, height, …PATTERN_FIELDS}, scale, angle, link, snap}` + `patterns/<id>.png` →
the tile added to `Document.patterns` and `Fill::Pattern { name/id, scale, angle, link, … }`.

**Shape (`type: 'shape'`).** `path` (document space) → `ShapeLayer.path` (`path.rs`); `fill` (same paint
shapes as above, or `null` = no fill) → shape fill; `stroke {color|paint, width, align
'center|inside|outside', dash:[…], cap?, join?}` → shape stroke; `shapeKind` `rect|ellipse|polygon|line|
path` + `shapeProps` (corner radii, sides, star ratio, …) → PhotoCraft live-shape properties where they
exist, else a plain path shape (warning: "no longer a live rectangle").

**Text (`type: 'text'`).** Versions 1–2: `text`, `font {family, size, weight, italic, color, align,
lineHeight, letterSpacing, …}` (`DEFAULT_TEXT_STYLE`), `x`, `y`, `width` (null = point text) → a single-run
PhotoCraft `TextLayer`. Version 3: `content {v:1, text, runs:[{len, style}], paras:[{style}]}` with
sparse styles over `CHAR_DEFAULTS` (`type/model.js`: fontFamily, fontWeight, fontItalic, postScriptName,
size, leading 'auto'|pt, tracking, autoKern, kern, scaleX, scaleY, baselineShift, color, fauxBold,
fauxItalic, caps, position, underline, strike, language, features, fractionalWidths, noBreak, stroke) and
`PARA_DEFAULTS` (align, indents, space before/after, hyphenation, justification, composer, hanging
punctuation, list) → PhotoCraft runs/paragraph styles (`crates/doc/src/text.rs`, `text_styles.rs`)
key by key; UTF-16 run lengths converted to UTF-8 byte or char offsets as the PhotoCraft model counts;
`typeOptions` (orientation horizontal/vertical, anti-alias, warp), `width`/`height` (paragraph box),
`rotation`, `transform` (affine), `pathText` (text on a path: path + offset/flip) → the layer's
transform and path-text data. Fonts are matched by `postScriptName` then family/weight/italic through
PhotoCraft's font resolution; missing fonts are reported like a PSD's missing fonts.

**Smart object (`type: 'smart'`).** `source {kind:'document'|'image', width, height, name}` with
`smart/<ref>.pigment` (nested: import recursively with the same importer, depth limit 8, total-bytes
budget shared) → `SmartSource` embedded as a PhotoCraft document (the smart-object source type that
`file.placeEmbedded` creates), or `smart/<ref>.png` → image source; `sourceRef` (instances sharing a
source) → one `SmartContentsId` shared by the instances; `transform` (2×3 matrix, null = identity at
the source size) → `transform: Affine`; `filters [{kind, params, enabled, opacity?, blend?}]` →
`smart_filters: Vec<SmartFilter { command, params, blend, opacity, visible }>` through a table JS filter
kind → PhotoCraft command id + params translator (`legacy_pigment/filters.rs`; JS ids from
`shared/pixels/filter-def.js` and the `filters*.js` registries, `adjust:<kind>` → `image.adjustments.<kind>`
with `adjust.rs`'s params); a filter with no mapping is dropped with a warning (the source and the other
filters are kept); `filtersEnabled` → `filters_enabled`; `stackMode` → `stack_mode`.

**Not carried (warn once each when present).** JS-only image-mode approximations (CMYK/Lab as RGB),
generated Color Lookup presets (look differs), JS artboard guides, smart filters whose kinds PhotoCraft
lacks or whose in-memory maps were not saved (JS itself dropped Displace maps, `ARCHITECTURE.md` line
549), the original EXIF bytes, text features PhotoCraft lacks (listed by name), live-shape kinds it
lacks. History, samplers, view state and the thumbnail were never in the file.

**Saving.** The document opens as an ordinary PhotoCraft document named after the file. Its path is
kept, so ⌘S writes Pigment 0.5's native `.pigment` over the 0.4 file, which 0.4 can then no longer open:
on the first save of a document that came from a legacy file, ask once "Save in the new Pigment format?
Pigment 0.4 will no longer be able to open this file." with Save / Save As… / Cancel (a `dont_show_again`
prompt), as Photoshop asks when saving over an older format.

### 7.3 Build and tests per package

- **L1 (2 days): container, document, raster, groups, masks, channels, selection, guides, paths,
  colour modes and depth, File Info, layer tags.** Files: `crates/io/src/legacy_pigment/{mod,container,
  layers,path,blend}.rs`. Replace the test `a_pigment_0_4_document_fails_with_the_typed_error…` with
  opening tests; keep `IoError::LegacyPigment` for files that are legacy but unreadable (no
  `document.json`, bad JSON), with its message changed to "This Pigment 0.4 file is damaged: {why}".
  Update docs/FORK.md "Documents from Pigment 0.1–0.4" and the release notes.
  Tests: fixtures generated by the real JS writer — in a scratch checkout of
  `claude/fervent-newton-263lz3`, a node script that builds documents with `createDocument` and the layer
  classes and calls `writePigment` (it needs `canvas` in node; the JS unit tests already run io code
  under node, see `pigment/tests/unit`) — one per version (1, 2, 3) and feature (raster with offset,
  16-bit deep, 32-bit deep, mask with density/feather, group with pass-through, selection, two channels,
  guides, paths, indexed, grayscale, duotone, layer tags, File Info), committed under
  `crates/io/tests/fixtures/pigment-0.4/` (small: 8×8 to 32×32) with a README naming the script and the
  JS commit. Each test opens a fixture and checks the pixels and fields; a fuzz loop over truncated and
  bit-flipped fixtures never panics; a ZIP bomb (huge deflate ratio) is refused by the size limits.
- **L2 (2 days): adjustments, fills, shapes, vector masks, styles, blending; the D5 mappers.** Files:
  `legacy_pigment/{adjust,gradient,styles}.rs`, additions to `layers.rs`. Tests: per-kind fixtures
  (every JS adjustment kind, each fill type, each shape kind, every effect with non-default values,
  multiple drop shadows, Blend If split points) checked field by field and rendered: the PhotoCraft
  composite of each fixture against the JS render of the same document (export a PNG from the JS app in
  the fixture script with its compositor under node, commit next to the fixture) within a tolerance
  (ΔE or 3/255), so mapping errors show as pixel diffs.
- **L3 (2 days): text, smart objects and smart filters, filter table, report, save prompt.** Files:
  `legacy_pigment/{text,filters}.rs`, the save prompt in `crates/ui-egui/src/app/files.rs` (the save path)
  with a `Document`/`DocState` flag `from_legacy_pigment`. Tests: text fixtures (point, paragraph box,
  vertical, on a path, mixed runs with tracking/baseline/faux bold, v2 `font`-only text) open as editable
  type with the same runs; a smart object with a nested document and two instances shares one source;
  smart filters (Gaussian Blur, Unsharp Mask, an `adjust:levels`) map, an unmapped one warns; a nested
  depth bomb stops at 8; the save prompt appears once.

## 8. Dropped (with reasons)

No whole row is dropped. These parts of rows are:

1. **Native Wayland pen input** (rows 43, 44). PhotoCraft already opens its window through Xwayland when
   a pen is attached, where its X11 reader gives pressure, tilt, rotation and the eraser end
   (`crates/tablet/src/lib.rs` header; `docs/hardware-parity.md`). Binding `zwp_tablet_v2` on winit's own
   `wl_display` needs unsafe foreign-display interop and re-injecting pen motion into egui, for no
   capability a user lacks today. Revisit when winit exposes tablet events.
2. **Adobe's bundled action sets other than Default Actions** (row 37): Commands, Frames, Image Effects,
   LAB – Black & White, Production, Star Trails, Text Effects, Textures, Video Actions are Adobe content;
   the JS app had none of them (its parity doc: "No bundled sets beyond Default Actions"). Users load
   their own `.atn` files, which PhotoCraft plays.
3. **JS re-creating Default Actions whenever the list becomes empty** (row 38): a JS quirk; Photoshop
   keeps an empty panel until Reset Actions. Reset Actions is ported.
4. **Photoshop `.sta` (Match Color) and `.hdt` (HDR Toning) files** (rows 9, 18): no public layout; the JS
   app did not read or write them either. Statistics use the JS JSON format; HDR presets live in the
   adjustment preset store.
5. **Migrating the JS Actions panel's own actions** (`settings.json` `actions`, part of row 22's
   Migrate Presets): JS command ids and arguments do not map reliably onto PhotoCraft commands; a wrong
   replay edits documents silently. Migrate reports them instead. (Recorded `.atn` files keep working.)
6. **Editing the File Info Audio/Video Data, DICOM and AEM tabs** (row 34): shown read-only when the
   packet has those namespaces; the JS app had no such tabs, so nothing is lost.
7. **AVIF writing** (rows 27, 28): the JS app could not write AVIF either (Chromium has no AVIF encoder);
   only opening is ported.
8. **Converting the colours of JS CMYK and Lab documents** (importer): JS stored RGB pixels with a mode
   flag ("honest approximations", its parity doc); they open as RGB with a note instead of inventing ink
   or Lab values.

## 9. Packages

Each package is one engineer for about one to two days, ends with its tests passing for the crates it
touched (one cargo process at a time, `-j 4`, as `planpc/AI-PORT.md` "Rules for every package" says),
and is committed locally. "Owns" lists files the package creates or reshapes; "touches" lists shared
files it edits in a bounded place (named), so the packages that come later edit other places of them.

### Order

1. **L1 → L2 → L3**: opening old Pigment documents is what a returning user needs first. L2 maps the A6
   kinds to `Adjustment::Unsupported` and noise gradients to their baked stops until A6/P3 land; A6 and
   P3 then upgrade those two mapping arms (their packages own that edit).
2. **A1 → A2 → A3 → A4 → A5 → A6 → A7**: the adjustment rows; strictly in this order because A2–A5 all
   edit the adjustment editors and dialog in turn.
3. **P1a → P1b → P2 → P3 → P4**: presets; P4 needs L2's mappers and benefits from A3/A4 and P3.
4. **F1, F2, F3, U1, U2, U3, U4**: independent of everything above and of each other; slot them between
   the chains or give them to a second engineer.

### Shared files and who edits what

| Shared file | Edited by (place) |
|---|---|
| `crates/engine/src/presets.rs` (`PresetState`, `Persisted`) | A1 (`adjustments` field) only |
| `crates/engine/src/prefs.rs` (`Preferences`) | A3 adds the `adjustments` section with `auto_options`; A4 adds `curves_display`; U1 adds `info_panel` (or `info`) |
| `crates/engine/src/cmd.rs` ADJ table (line 1217) | A5 (exposure/hueSaturation params strings), A6 (three new rows) |
| `crates/engine/src/adjust_params.rs` | A3 (`auto_params`, eyedropper targets), A5 (new eyedropper/on-image fns), A6 (new kinds in `from_params`/`to_params`/`adjustment_kind`) |
| `crates/ui-egui/src/dialogs/adjust_dialog.rs` | A2 (top of `body`), A3 (`picker_controls` double-click), A5 (on-image arm + picker kinds) |
| `crates/ui-egui/src/dialogs/adjust_editors/curves.rs` | A3 (Auto/Options buttons), A4 (display options, Show Clipping) |
| `crates/ui-egui/src/dialogs/adjust_editors/basic.rs` | A3 (B/C Auto), A5 (B&W hand, Exposure eyedroppers), A6 (three editors) |
| `crates/ui-egui/src/panels/properties.rs` (`adjustments_grid`) | A2 (preset groups), A6 (icons + its panel presets) |
| `crates/ui-egui/src/dialogs/filter_dialog.rs` | A7 only (HDR method body, Match Color buttons, Replace Color preview) |
| `crates/io/src/adjust_map.rs`, `adjust_map/encode.rs` | A1 (visibility + `preset_files.rs`), A6 (`pcAd`), P3 (`grdm` noise) |
| `crates/io/src/legacy_pigment/adjust.rs`, `gradient.rs` | L2 (creates), A6 and P3 (upgrade one arm each) |
| `crates/engine/src/cmd/edit_menu_cmds/presets.rs` | P1a (`PRESET_KINDS`, `Library`), P1b (`PresetFile`, import/export) |
| `crates/engine/src/cmd/migrate_cmds.rs` | P4 only |
| `crates/ui-egui/src/panels/actions.rs` (`panel_menu`) | U2 only |
| `crates/ui-egui/src/menu_catalog.rs` | A6 (adjustment items), U4 (Similar Layers), P2 (if the Tool Presets items are menu entries) |
| `crates/io/Cargo.toml` | F2 (`craft-tga`), F3 (`craft-video`), F1 (`craft-metadata` in io for IIM/JPEG) |

### The packages

**L1 — Legacy `.pigment`: container, document, pixels** (2 days; rows: importer). Owns
`crates/io/src/legacy_pigment/{mod,container,layers,path,blend}.rs` (from `legacy_pigment.rs`), the
fixtures `crates/io/tests/fixtures/pigment-0.4/` and their generator README; touches `docs/FORK.md`.
Depends on nothing.

**L2 — Legacy `.pigment`: adjustments, fills, shapes, masks, styles, blending** (2 days). Owns
`legacy_pigment/{adjust,gradient,styles}.rs`; touches `layers.rs`. Depends on L1.

**L3 — Legacy `.pigment`: text, smart objects, filters, report, save prompt** (2 days). Owns
`legacy_pigment/{text,filters}.rs`; touches `crates/ui-egui/src/app/files.rs` (save prompt). Depends on L2.

**A1 — Adjustment presets: model, files, commands** (2 days; rows 1–8 preset half). Owns
`crates/io/src/adjust_map/preset_files.rs`, `crates/engine/src/presets/adjustments.rs`,
`crates/engine/src/cmd/adjust_preset_cmds.rs`; touches `presets.rs`, `adjust_map` visibility, the
command registry. Depends on nothing.

**A2 — Adjustment presets UI and Adjustments panel presets** (1.5 days; rows 1, 10). Owns
`crates/ui-egui/src/dialogs/adjust_editors/preset_row.rs`; touches `adjust_dialog.rs` (top of `body`),
`adjust_editors/session.rs`, `panels/properties.rs`, `presets/adjustments.rs` (`PANEL_PRESETS`,
`layer.adjustmentPreset`, `layer.saveAdjustmentPreset`). Depends on A1.

**A3 — Auto Color Correction Options, Auto in Curves and Brightness/Contrast, eyedropper targets**
(1.5 days; rows 2, 5, 14, 15, 16). Owns `crates/algo/src/auto_tone.rs`,
`crates/ui-egui/src/dialogs/auto_options_ui.rs`; touches `prefs.rs`, `edit_cmds.rs` `auto_adjust`,
`adjust_params.rs`, `levels.rs`, `curves.rs`, `basic.rs`, `adjust_dialog.rs` `picker_controls`.
Depends on nothing (after A2 in time).

**A4 — Curves display options and Show Clipping** (1 day; row 11). Touches `curves.rs`, `levels.rs`,
`adjust_preview.rs`, `prefs.rs`. Depends on A3 (prefs section).

**A5 — On-image tools and eyedroppers** (2 days; rows 3, 4, 7, 12, 13). Touches `adjust_params.rs`,
`cmd.rs` ADJ strings, `adjust_dialog.rs`, `hue_saturation.rs`, `basic.rs`, `session.rs`, the canvas
input routing. Depends on A4 in time only.

**A6 — Color and Vibrance, Clarity and Dehaze, Grain** (2–2.5 days, L; row 17). Touches
`crates/doc/src/adjust.rs`, `crates/compose/src/{adjust,composite,reduced,cmyk}.rs`,
`crates/gpu/src/plan/{lower,planner}.rs`, `crates/algo/src/camera_raw.rs` (one `pub fn`), `cmd.rs`,
`adjust_params.rs`, `adjust_editors.rs`/`basic.rs`, `menu_catalog.rs`, `properties.rs`,
`crates/io/src/adjust_map.rs` + PSD export (`pcAd`), `legacy_pigment/adjust.rs` (one arm),
`presets/adjustments.rs` (seven panel presets). Depends on A1, A2.

**A7 — HDR Toning methods, Match Color statistics, Replace Color preview, solid fill in Properties**
(2 days; rows 9, 18, 19, 20). Touches `crates/algo/src/tone.rs`, `adjust_cmds.rs`, `filter_dialog.rs`,
`color_range_ui.rs` (extract the preview), `layer_props_ui.rs`. Depends on A1 (HDR presets).

**P1a — Preset Manager for every kind** (2 days; rows 21, 23). Owns
`crates/ui-egui/src/dialogs/preset_manager_ui.rs`; touches `edit_menu_cmds/presets.rs`,
`prefs_ui/dialogs.rs` (remove the old list), `presets/gradients.rs` (`exportGrd`), the Shapes library
unification (`edit_menu_cmds.rs` `custom_shapes`, `define_custom_shape`). Depends on A1.

**P1b — Export/Import Presets** (1 day; row 22 first half). Owns
`crates/ui-egui/src/dialogs/export_import_presets_ui.rs`; touches `edit_menu_cmds/presets.rs`
(`PresetFile`), `edit_menu_cmds.rs` `export_import`. Depends on P1a.

**P2 — `.tpl` tool presets** (1.5–2 days; rows 24, 25). Owns `crates/io/src/tpl_map.rs`; touches
`abr_map.rs` (`brush_from_descriptor`), `presets/tools.rs`, `preset_panels` menus. Depends on P1a
(load dispatch) loosely.

**P3 — Noise gradients** (2 days; row 26). Owns `crates/doc/src/noise_gradient.rs`,
`crates/io/src/grd_noise.rs`; touches `Fill::Gradient`, `GradientSource`, `GradientPreset`, effects'
gradient, `blocks.rs`, `effects_map`, `adjust_map.rs` (`grdm`), `preset_import_cmds.rs`
(`import_grd`), the Gradient Editor, `legacy_pigment/gradient.rs` (one arm). Depends on P1a
(`exportGrd`).

**P4 — Migrate Presets from Pigment 0.4** (1.5 days; row 22 second half). Touches `migrate_cmds.rs`,
`apps/photocraft/src/app_dirs.rs` (`legacy_pigment_dir`), `legacy_pigment/brush.rs` (new). Depends on
P1b, L2; uses A3/A4 prefs and P3 when present.

**F1 — File Info tabs, rating, IPTC, GPS, Camera Data** (2 days; rows 33–36). Owns
`crates/ui-egui/src/dialogs/file_info_ui.rs`, `crates/io/src/iptc_iim.rs`; touches
`file_cmds/info.rs`, `file_cmds.rs` (params string), `menus/view_cmds/dialogs.rs`, PSD/JPEG export
metadata, Cargo (`craft-metadata`). Depends on nothing; tell the AI team (Describe Image writes the
description/alt text through `file.fileInfo`).

**F2 — Targa variants, GIF in Export As, Color Lookup Table formats** (1.5 days; rows 29–32). Touches
`crates/io/src/flat.rs` (Targa route), `export_dialog.rs`, `file_cmds/export.rs`, `file_cmds.rs`
(params), the CLUT dialog in `menus/view_cmds/dialogs.rs`, Cargo (`craft-tga`). Depends on nothing.

**F3 — AVIF open** (2 days, L; rows 27, 28). Owns `crates/io/src/avif.rs` and its fixtures; touches
`crates/io/src/lib.rs` routing, Cargo (`craft-video`). Depends on nothing. Check the AV1 decoder's
conformance table first; if it lacks a tool common in AVIF stills (e.g. 4:4:4, 10-bit, film grain
synthesis), size the gap before starting.

**U1 — Info panel readout modes and 16/32-bit values** (1 day; rows 41, 42). Owns
`crates/ui-egui/src/panels/info_readout.rs`; touches `panels/info.rs`, `sampler_cmds.rs`
(`point_json`), `prefs.rs`. Depends on nothing.

**U2 — Actions: Clear All, Reset, Replace, Insert Conditional, Default Actions** (2 days; rows 37–40).
Owns `crates/engine/src/actions_default.rs`, `crates/ui-egui/src/panels/actions/conditional.rs`;
touches `actions_edit_cmds.rs`, `atn_cmds.rs` (`replaceAll`), `panels/actions.rs` `panel_menu`.
Depends on nothing.

**U3 — Pen tablet: Windows Ink tilt and rotation, macOS rotation** (1 day + hardware check; rows 43,
44). Touches `crates/tablet/src/windows.rs` (+ a pure mapping fn), `macos.rs`/`appkit.rs` if the fix is
there, `crates/ui-egui/src/input/stylus.rs`, `docs/hardware-parity.md`. Depends on nothing; needs a
Windows pen and a Mac to sign off.

**U4 — Select Similar Layers and OS recent documents** (1 day; rows 45, 46). Owns
`apps/photocraft/src/os_recent.rs`; touches `layer_multi_cmds.rs`, `menu_catalog.rs`,
`crates/ui-egui/src/app/files.rs` (`push_recent` hook), `apps/photocraft/src/main.rs`,
`apps/photocraft/Cargo.toml` (AppKit features). Depends on nothing.
