# PKG-port-A1: adjustment presets, model, files, commands (rows 1 to 8, preset half)

Built on `claude/pigment-photocraft` after `03ccb71` (PhotoCraft 057297b). Spec: PORTS-A §2.1, §2.3,
§9 A1; REBASE-A "A1" (it wins). CI on `03ccb71` finished green (run 45949506290) before this
package pushed anything, so there was no red run to fix first.

## What was built

1. **Photoshop's preset files**, `photocraft_io::adjust_presets` (`crates/io/src/adjust_map/preset_files.rs`):
   `read(kind, bytes) -> Result<(Adjustment, Vec<String> /*report*/), String>`, `write(&Adjustment) ->
   Result<Vec<u8>, String>`, `KINDS` (kind, extension, file-dialog label), `extension(kind)`,
   `kind_for_extension(ext)`. Kinds: levels `.alv`, curves `.acv`, hueSaturation `.ahu`, channelMixer
   `.cha`, selectiveColor `.asv`, blackWhite `.blw`.
   - **Differs from the spec (followed the code):** the spec and REBASE said to make the six `encode`
     functions `pub(crate)` (and maybe `parse_any`/`parse_black_white`). Not needed: `adjust_map::parse`
     and `adjust_map::write` are already public and give exactly these blocks, so `preset_files` calls
     them and no upstream visibility changed. It is a child module of `adjust_map`, so it reads the
     private block helpers (`be16`, `put16`, `levels_write`, `BW_KEYS`) without hooks.
   - `.acv` holds points only: a pencil curve, or one with more than 19 points (files may claim up to 64,
     as the JS app accepted), is written/read as 17 sampled points (JS `pointsFromTable(ch, 17)`).
     Lab curves are written with an identity composite first; CMYK with the black record (5 curves).
   - Records past RGB (a CMYK file's 5th curve or Levels record) are reported: "1 more channel curve
     skipped", as JS `readAcv`/`readAlv`.
   - `.ahu` version 1 reads with the later layout and reports it (as JS).
   - **`.cha` gray mix, a choice recorded:** PSD `mixr` (and PhotoCraft's writer, which writes it in
     records 0 and 3) keeps the monochrome gray mix in record 0; the JS app wrote the red output in
     record 0 and gray in record 3. Rule: monochrome, record 0 is the untouched red row `[100,0,0,0,0]`
     and record 3 holds a mix → take record 3; else record 0. A short (14-byte) file → record 0, as JS.
   - Errors, never panics, on any damaged input (truncation and byte-flip loops in the tests).
2. **The model**, `crates/engine/src/presets/adjustments.rs`: `AdjustmentPreset { name, id, params }`,
   `KindPresets { groups (user presets), hidden_builtins, renamed (id → name) }`, `AdjustmentPresets
   { kinds: BTreeMap }` with `list`, `find`, `save`, `rename`, `delete`, `reset`, `unique_name`,
   `to_json`, `load`; `builtin(kind)`; `KINDS` (16: every `layer.newAdjustmentLayer.*` kind but Invert,
   plus `hdrToning`); `BUILTIN_GROUP = "Built-in"`, `USER_GROUP = "My Presets"`.
   - Refinement of D1 (`groups: BTreeMap<kind, Vec<Group>>`): built-ins are generated, never saved;
     saved are the user's groups, the built-in ids deleted and the names given to built-ins (`renamed`,
     so a renamed built-in keeps its menu place; the JS store kept "modified built-ins" in full).
   - Built-ins translated from JS `TONAL_BUILTINS`/`COLOR_BUILTINS` (ids kept). Curves `rgb`→`points`,
     `r/g/b`→`red/green/blue`; Hue/Sat colorize → `colorize:true` + hue/saturation/lightness, ranges as
     `"reds":{…}` (default bounds left out); Channel Mixer `{monochrome:true, gray:[r,g,b,0]}`; B&W
     with `tint:false`. **HDR Toning (choice recorded):** JS Strength 0..100 (default 50) became
     PhotoCraft's 0.1..4 divided by 100 (default 0.5); radius and the rest unchanged; no `method` key
     (A7 adds it; the built-ins are all JS's "local-adaptation", which is what PhotoCraft does now).
   - Saving a taken name replaces: a user preset in place, a built-in by hiding it. Reset brings back
     the built-ins (and their names) and keeps user presets, numbering a user preset that now shares a
     built-in's name ("Midtones Darker 2").
   - Persistence: `PresetState.adjustments`, saved under `presets.adjustments` in `config.toml`; loaded
     entry by entry (a bad preset, group or kind is skipped, #5602), names kept unique, kinds this build
     doesn't know are kept (A6's kinds survive an older build). Limits: 255-char names, 1000 presets a
     kind, 4 MiB of params a preset.
3. **Commands**, `crates/engine/src/cmd/adjust_preset_cmds.rs` (all `journal: false`, `enabled: always`,
   each change calls `presets_changed`): `adjustment.presets.list {"kind"?,"params"?}`, `get
   {"kind","name"|"id"}`, `save {"kind","name","params","group"?}`, `edit {"kind","action":"rename|delete",
   "name"|[names],"newName"?}`, `reset {"kind"}`, `load {"path"|"data","fileName"?,"kind"?,"name"?,"group"?}`
   (kind from the extension when not given; named after the file; a taken name gets " 2"), `export
   {"kind","params"|"name"|"id","path"?}` (base64 + fileName without a path). Public helpers for A2:
   `preset_params(kind, params, cmd)` (what a save keeps: object, no nulls, no `eyedropper`/`__*` keys,
   validated by `from_params`, or HDR's own check) and `file_params(&Adjustment)` (params of a loaded
   file: neutral Levels/Curves channels dropped so the preset applies in any mode, numbers to 4 decimals).
4. **Automation policy** (not in the spec, needed): `load` with a `path` and `export` with a `path` touch
   the disk, so they are in `crates/automation/src/workspace.rs` `command_uses_ambient_path`; upstream's
   `registry_filesystem_path_params_are_classified` test would otherwise fail.

## Hooks into upstream files (all in FORK.md, "What Pigment added › Adjustment presets")

| File | Hook |
|---|---|
| `crates/io/src/adjust_map.rs` | `pub mod preset_files;` beside `mod encode;` |
| `crates/io/src/lib.rs` | `pub use adjust_map::preset_files as adjust_presets;` |
| `crates/engine/src/presets.rs` | `pub mod adjustments;`; `PresetState.adjustments` + `Default`; `Persisted.adjustments: Option<Value>`; its line in `to_json`, in `load_presets_json`'s `take`, and the 3-line load |
| `crates/engine/src/cmd.rs` | `pub mod adjust_preset_cmds;`; `v.extend(adjust_preset_cmds::specs());` after `adjust_cmds::specs()` |
| `crates/automation/src/workspace.rs` | `adjustment.presets.load` and `adjustment.presets.export` in `command_uses_ambient_path` |

## Files

New: `crates/io/src/adjust_map/preset_files.rs`, `crates/io/src/adjust_map/preset_files/tests.rs`,
`crates/io/tests/fixtures/adjust-presets/` (`make-fixtures.mjs`, `README.md`, `settings.json`,
`curves.acv`, `levels.alv`, `hue-saturation.ahu`, `sepia.ahu`, `channel-mixer.cha`,
`selective-color.asv`, `black-white.blw`; written by JS 0.4.0 `99dbdee`'s own writers, identical at the
branch head), `crates/engine/src/presets/adjustments.rs`, `crates/engine/src/cmd/adjust_preset_cmds.rs`,
`crates/engine/src/cmd/adjust_preset_cmds/tests.rs`. Edited: the five hook files, `docs/FORK.md`.

## Tests (all green here)

- io `adjust_map::preset_files::tests` (14): write→read identity per kind (Curves 4 points + red/blue,
  Levels per channel, Hue/Sat colorize with moved reds bounds, Mixer monochrome, Selective absolute,
  B&W with tint); golden sizes (292, 100, 44, 84, acv by count, blw header); every JS fixture read and
  checked against `settings.json`; pencil and >19-point curves → 17 points; CMYK records reported;
  version 1/3 `.ahu`, short `.cha`, short `.alv`; wrong files refused; truncation + byte-flip loop (no
  panic, whatever reads also writes).
- engine `cmd::adjust_preset_cmds::tests` (11): built-in names per kind; every built-in passes
  `preset_params` unchanged; every adjustment-layer kind but Invert has presets (catches a new kind);
  save/replace/rename (user and built-in)/delete (all-or-none, built-in hidden)/save-over-built-in/reset
  with numbering; `presets.rev` bumps; bad settings refused; `.acv` load named after the file, `data` +
  `fileName`, every fixture loads and applies as an adjustment layer; export by name, by params to a
  path and loaded back; **`SavedPrefs` through the real `craft::settings::SettingsStore` (config.toml in a
  temp dir) keeps user presets, groups, hidden and renamed built-ins**; damaged saved entries skipped;
  adversarial kind/data/params never panic; no history entry, no command journaled.
- automation `workspace` (56, incl. `registry_filesystem_path_params_are_classified`).
- engine `presets`, `prefs`, `adjust` filters (272) unchanged and green.
- Panic hunt: see "Checks".

## Not done (with why)

- The optional File › Open / drop routing of `.acv .alv .ahu .cha .asv .blw` to `adjustment.presets.load`
  (`crates/ui-egui/src/preset_files_ui.rs`): optional in REBASE, the JS app did not have it; it is
  interface work and fits A2 (which builds the Load Preset… file dialog anyway).
- Interface, i18n strings, panel presets: A2 (rows 1 and 10). The command labels are English in the
  specs, as every engine label is.

## For A2 (and later packages)

- Apply a preset as `from_params(kind, &preset.params, None, mode)` (base `None`), not merged over the
  current value: built-ins name only what they change (most Curves/Levels name only the composite).
- Curves/Levels built-ins and loaded files use `red/green/blue` keys; in a CMYK or Lab document those keys
  switch `space_of` to RGB. The JS app remapped (`remapTonalSpace`); A2 should do the same for channel
  presets in other modes (or offer composite-only ones there). Composite-only presets work in any mode.
- "Custom" detection (JS `sameSettings`): compare the preset's keys only; `list {"params":true}` or
  `session.presets.adjustments.list(kind)` gives everything in one call.
- Save Preset… → `adjustment.presets.save` (it validates and strips; pass the dialog's params as they are);
  Load Preset… → `load` with `path` (kind from the extension, or pass `kind`); Save to File… → `export`
  with `params` and `path`; Delete Current Preset → `edit delete`; Reset → `reset`; Rename → `edit rename`.
  File-dialog filters: `photocraft_io::adjust_presets::KINDS` (`(kind, ext, label)`).
- `hdrToning` is in `KINDS` with 8 built-ins; A7 may add `"method"` to them (the HDR check already
  accepts a string `method`).
- A6: add the three new kinds to `presets::adjustments::KINDS` (the test
  `every_adjustment_layer_kind_with_settings_has_presets` fails until you do) and their panel presets.
- P1b (`.pcpresets`): `AdjustmentPresets::to_json`/`load` are the per-kind form to embed.
