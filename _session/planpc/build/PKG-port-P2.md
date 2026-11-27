# PKG-port-P2: tool presets in Photoshop's `.tpl` files (rows 24, 25)

Built on `claude/pigment-photocraft` after `007cd8b` (P1b; PhotoCraft 057297b). Spec: PORTS-A §3.4 and §9 P2;
REBASE-P "P2" (it wins).

**CI first.** At the start the newest finished run was 46041402514 (`8821fdf`), **green**; P1a's 46050395075
(`1c92254`) and P1b's 46055487780 (`007cd8b`) were still running and have since finished **green**. Nothing red, so no
CI commit. **The next engineer checks CI first**: the runs on this package's two commits (see "Commits"): 46061145778 on `4fa6da5` was in progress when the second
push went out (it may be cancelled by it); the run on `5a5cceb` was queued. Not waited for, as the brief says.

## Commits (pushed)

- `4fa6da5` Pigment .tpl tool presets (P2), io and engine: tpl_map reads and writes Photoshop tool presets,
  tool.presets.importTpl and exportTpl
- `5a5cceb` Pigment .tpl tool presets (P2), interface: the Tool Presets panel menu, File › Open of a .tpl

## What was built

1. **io**, `crates/io/src/tpl_map.rs` (new, Pigment's), tests in `tpl_map/tests.rs`:
   - `read_tpl(bytes) -> Result<TplImport { presets: Vec<TplPreset { name, tool, class, options }>, warnings }, String>`
     (errors only when the bytes are not `8BTP`; everything else is a warning). Layout as JS 0.5's `tpl.js`: `8BTP`,
     version, minor, then `8BIM` sections in any order (`samp`, `patt`, `desc`; unpadded writers tolerated), the `desc`
     a version-16 descriptor with a `Prst` list (else the first list of named objects, else the descriptor itself); a
     file without sections is scanned for descriptors (at most 64, 4096 tries). Names lose Photoshop's `$$$/…=` prefix.
   - Tips: the `samp` section is wrapped as a one-section `.abr` 6.x file and read by `craft_psd::abr::parse` (no
     port of JS `readSamples` needed); `patt` by `craft_psd::patterns::parse_pattern_block`.
   - Three `pigmentData` forms: **Pigment's own** (`{"format":"pigment-tool-preset","version":1,"tool","options"}`,
     the preset exactly as the engine keeps it, sampled tips as `{"tplSample": id}` pointing into `samp`, written at 16
     bits, so they come back exactly); **JS 0.5's** (`{tool, options, type?, color?}`: tool ids through `JS_TOOLS`, its
     option names mapped: size, hardness, opacity, flow, blend, smoothing, pressure, airbrush; Eraser mode and Erase to
     History, Pencil Auto Erase, Blur/Sharpen/Smudge strength, Dodge/Burn exposure and range, Sponge mode, Gradient
     type/reverse/dither, Bucket/Wand tolerance/contiguous/anti-alias; `type.char` font family and size; `color` →
     `foreground`); **none** (Photoshop's keys: `Tool` class through `TOOL_CLASSES`/aliases, `Opct`, `flow`, `Md  `,
     `Rpt `, `TxtS` `FntN`/`Sz  `). Unmapped options are counted: `"{name}": {n} options of {tool} have no equivalent
     and were skipped`. A tool Pigment lacks (the JS Adjustment Brush, Photoshop's 3D tools) leaves the preset out with
     a warning.
   - Where options go (the code, not the spec's wording): opacity, flow and mode of a **painting tool** are brush
     settings in PhotoCraft (`BrushSettings.opacity/flow/mode`), so they go to `options.brush`; for Gradient and Paint
     Bucket to `options.toolOptions.fill_opacity` (%) and `gradient_blend_mode`/`bucket_blend_mode`; type font and size
     to `type_font`/`type_size`. `Brsh` → `options.brush` through `abr_map::brush_from_descriptor` (full mapping:
     dynamics, texture, dual brush…), without the colour keys (`color`, `colorCmyk`, `background`, `seed`).
   - `write_tpl(&[TplEntry { name, tool, options }]) -> Result<(bytes, report), String>`: `Tool` with the class,
     `Opct`/`flow`/`Md  `/`Rpt ` (painting tools from the brush, Gradient/Bucket from their tool options), `TxtS`;
     `Brsh` a `brushPreset` with a `computedBrush`/`sampledBrush` tip (`Dmtr`, `Hrdn`, `Angl`, `Rndn`, `Spcn`, `Intr`,
     flips, `sampledData`) plus `Spcn`, `Wtdg`, `Nose`, `Rpt `, `useBrushSize`; sampled tips in `samp`
     (`craft_psd::abr::write_v6` writes them, its `samp` section is copied out); `pigmentData` as above. A tool without a
     Photoshop class is written under its own name as the class (as JS did); Pigment reads it back from `pigmentData`.
   - `TOOL_CLASSES` (69 tools, PhotoCraft's spelling ↔ Photoshop class), `CLASS_ALIASES` (four-letter ids,
     `roundedRectangleTool`), `JS_TOOLS` (JS ids → PhotoCraft names), `tool_for_class`, `class_for_tool`, `tool_for_js`.
2. **`abr_map::brush_from_descriptor(d, &AbrFile) -> (Option<BrushSettings>, Vec<String>)`** (upstream file, a small
   wrapper of the private `Mapper::preset`; `useBrushSize` is not reported as unknown).
3. **Engine**, `crates/engine/src/presets/tools/tpl.rs` (new), tests in `tpl/tests.rs`:
   - `tool.presets.importTpl {"path"|"data", "replace"=false}` → `{added, count, skipped, warnings}`; journaled (like
     `tool.presets.new`). Each preset's name checked (`checked_name`), its brush checked as `tools.setBrush` would
     (`merge_brush` + `validate_brush`; a refused brush is dropped with a warning), its `foreground` checked. A preset
     already in the list with the same tool and options (same name, or the number an earlier import gave it) is
     skipped, so loading a file twice adds nothing; a taken name with other options gets " 2". At most `MAX_PRESETS`.
     Nothing changes when no preset can be read.
   - `tool.presets.exportTpl {"names"?, "path"?}` → `{count, bytes, warnings, path | data}`; not journaled. Brushes
     whose tip, dual tip or texture the preset store keeps (`{"stored": …}`) are loaded first.
   - The Preset Manager (P1a) now lists `.tpl` for tools (load and save, `.tpl` first); its two tests that assumed
     `.pcpresets` for tools were adjusted (`preset_manager_tests.rs`: Save Set… round trip uses `tpl`; the `.pcpresets`
     case passes `format`).
4. **Interface**, `crates/ui-egui/src/panels/preset_panels/tool_presets_menu.rs` (new), tests in
   `tool_presets_menu/tests.rs`: the Tool Presets panel menu, the framework's `PresetFiles` rows **Load…, Replace…,
   Save…** (`.tpl`) and Pigment's **Reset Tool Presets…** (`ToolPresetsCommand::Reset`, prefix `toolPresetsPanel`).
   Replace… picks the file, then asks "Replace current tool presets with the presets from {file}?"; Reset asks
   "Replace current tool presets with the default tool presets?" (both `StandardPrompt`s answered by
   `tool_presets_menu::answer` in `dialogs::PROMPTS`). Save… writes every tool preset ("Tool Presets.tpl") through
   `pick_save` + `services.write`. Load…, File › Open and drag-and-drop go through `preset_files_ui::open` →
   `tool_presets_menu::open_file` (status "Loaded {n} tool presets from {file}", with the first note), and show the
   panel.
5. **Fixture**: `crates/io/tests/fixtures/pigment-0.4/wip05-tool-presets.tpl`, written by JS 0.5's own `writeTplFile`
   (`make-fixture-tpl.mjs` beside it, run with node 22 on a `git archive` of `origin/claude/fervent-newton-263lz3-wip05`
   (`e9845fc`) with `npm install --ignore-scripts` for ag-psd 31.0.3). Eight presets: brush (mode, opacity, flow,
   smoothing, one unmapped option), sampled-tip pencil (6 × 4 grey PNG), eraser (Pencil mode, to history), radial
   gradient (Overlay 50 %, Include Color), type (Inter 36), Spot Healing, Dodge (highlights), Adjustment Brush. README
   section "Tool presets".
6. Docs: `docs/FORK.md` "Tool presets in Photoshop's `.tpl` files" with the hooks; `docs/file-format-parity.md` `.tpl`
   row: read and write.

## Choices recorded (where the spec/REBASE and the code differ)

- **The io API holds no engine type** (io cannot depend on the engine): `TplPreset`/`TplEntry` carry the engine's
  `options` JSON, the brush inside it (`options.brush`), instead of the spec's `(ToolPreset, Option<BrushSettings>)`.
- **Opacity, flow and mode go to the brush** for painting tools (PhotoCraft keeps them in `BrushSettings`, not in the
  shell's `ToolOptions`); the spec said `options.toolOptions`. Gradient/Bucket do use `toolOptions`.
- **Brush tips stay inside the tool preset** (`options.brush.tip` = the sampled bitmap), as upstream's `tool.presets.new`
  stores them and as the JS app kept them with the preset; they are not added to the Brushes library (the spec's
  "through the brush preset store like `.abr`"). Patterns of the `patt` section become the brush texture's tile (as
  `.abr` import does), not Patterns panel entries (JS added them there).
- **The `samp` section is read through craft-psd's `.abr` reader** (wrapped as a one-section `.abr`) rather than a port
  of JS `readSamples`; it reads the subversion's skip (264 for minor 2, 10 for minor 1) where JS tried both.
- **Full brush export** (dynamics etc. in Photoshop's keys) is not written: no `BrushSettings` → descriptor encoder
  exists (spec's follow-up). Photoshop gets the tip, size, hardness, angle, roundness, spacing, flips, noise, wet edges
  and build-up; Pigment gets everything from `pigmentData`.
- **The panel menu labels are the framework's** "Load…", "Replace…", "Save…" (`PresetCommands`), not Photoshop's
  "Load Tool Presets…" etc.; only "Reset Tool Presets…" is Pigment's own row. No Grid/List rows: the panel is a list.
- **Save… writes every tool preset** (Photoshop's Save Tool Presets…); Save Set… of chosen ones is the Preset Manager's.
- **Loading twice adds nothing** (identical presets skipped), as P1b's `.pcpresets` import; Photoshop appends copies.
- **Dropped (REBASE)**: the options-bar tool preset picker (PhotoCraft has none); follow-up.
- Tool ids of the JS app with no PhotoCraft tool: `adjustment-brush` (B18 adds it; add it to `JS_TOOLS` and
  `TOOL_CLASSES` then).
- Some Photoshop tool classes are best knowledge, not checked against files Photoshop wrote (none available): e.g.
  `polySelTool`, `recomposeSelection`, `removeTool`, `triangleTool`, `framedGroupTool`.

## Hooks into upstream files (all in FORK.md, "What Pigment added › Tool presets in Photoshop's `.tpl` files")

| File | Hook |
|---|---|
| `crates/io/src/abr_map.rs` | `pub fn brush_from_descriptor` |
| `crates/io/src/lib.rs` | `pub mod tpl_map;` |
| `crates/engine/src/presets/tools.rs` | `pub mod tpl;` |
| `crates/engine/src/presets.rs` | `tools::tpl::specs()` in `specs()` |
| `crates/automation/src/workspace.rs` | `tool.presets.importTpl`, `tool.presets.exportTpl` in `command_uses_ambient_path` |
| `crates/ui-egui/src/panels/preset_panels.rs` | `pub(crate) mod tool_presets_menu;` |
| `crates/ui-egui/src/panels/registry.rs` | `toolPresets` becomes a `PanelEntry { rows, states, run, .. }` |
| `crates/ui-egui/src/dialogs.rs` | `tool_presets_menu::answer` in `PROMPTS` |
| `crates/ui-egui/src/preset_files_ui.rs` | `PRESET_EXTS` + `tpl`; `open`'s `"tpl"` arm |

Pigment's own files touched: `crates/io/src/legacy_pigment/mod.rs` (`pub(crate) mod blend;`, for the JS blend names),
`crates/engine/src/cmd/edit_menu_cmds/preset_manager_tests.rs` (above).

## Tests (all green here)

- io `tpl_map::tests` (8): the JS 0.5 file reads with its `pigmentData` (seven presets, every mapped option, the sampled
  tip's 24 values, the Adjustment Brush left out with a warning, the unmapped-option count); with `pigmentData`
  stripped the Photoshop keys map (opacity, flow, mode, tip, gradient opacity/mode, type font/size); a hand-built
  Photoshop-style file (localised name, `long` opacity, a class the table lacks, a non-painting tool's opacity counted);
  **write → read keeps every preset exactly** (sampled tip, partial brush, tool options, foreground, Star, a tool
  without a class); what Photoshop reads of a written file (pigmentData stripped); every prefix of a file (errors only
  under 8 bytes, otherwise warnings) and flipped bytes never panic; a file without sections is scanned; the tool tables
  agree. io lib all: 830 passed.
- engine `presets::tools::tpl::tests` (6): import adds after the existing presets, the same file again adds nothing,
  `replace` gives the file's seven, `tool.presets.reset` the built-ins; selecting an imported preset sets size, mode,
  opacity, flow, hardness, the sampled tip and the foreground; **exportTpl → importTpl round trip** (a sampled-tip preset
  made with `tool.presets.new`, a crop preset, the built-ins), to a `path` with `names`; a taken name is numbered once;
  bad params change nothing; the Preset Manager loads and saves `.tpl`. Engine lib all: 4227 passed, 17 ignored
  (`cancelling_the_open_stops_the_smart_filters` skipped, container speed). Panic hunt: 1 passed.
- automation `workspace` (56) with `registry_filesystem_path_params_are_classified`.
- ui-egui `tool_presets_menu::tests` (6): **the tool-class table resolves through `Tool::from_name`** (and every tool
  of `Tool::ALL` has a class, `JS_TOOLS` targets resolve); the menu lists Load…, Replace…, Save…, Reset Tool Presets…
  (Save… disabled with no presets; the registry entry carries the rows); **Save… writes the `.tpl` through
  `ScriptedFiles`** and Load… of it restores the list; Replace… asks (Cancel keeps, OK replaces; the note is in the
  status; choosing the imported eraser switches tool, `eraser_mode`, `erase_to_history`); Reset asks then restores;
  File › Open of a `.tpl` loads it. Plus `tool_presets`, `preset_files_ui`, `preset_manager_ui` filters (20 in all).
  ui-egui lib, every test of `panels dialogs preset file_open menus keymap commands registry` (1298 passed, with
  `--test-threads 2`). A full ui-egui lib run here showed only the two container-only type-tool font failures
  (`temporary_type_transform_imported_psd_retains_editability_and_styles`,
  `caret_font_and_face_persist_across_more_font_choices_and_paste`) before the kernel killed it for memory; run the
  whole ui-egui suite with `--test-threads 2` here.

## Checks

`cargo fmt --all -- --check`; `cargo clippy -p photocraft-io -p photocraft-engine -p photocraft-automation
-p photocraft-ui-egui --all-targets -- -D warnings`; `python3 scripts/pigment-rebrand.py --check`; panic hunt;
`cargo xtask layers`, `panel-commands`, `scorecard --check`, `test-binaries`; `cargo test -p xtask`: all green.

## Not done (with why)

- A `BrushSettings` → Photoshop brush descriptor encoder (full dynamics in `Brsh`): none exists in PhotoCraft (no
  `.abr` export either); `pigmentData` keeps everything for Pigment.
- The options-bar tool preset picker: dropped by REBASE (PhotoCraft has no picker); follow-up.
- Photoshop's "Load Tool Presets…"-style labels on the panel menu: the framework's file rows are "Load…", "Replace…",
  "Save…"; changing them is a craft-libs request.
- Adding `.tpl` patterns to the Patterns panel and brush tips to the Brushes library (JS added patterns): left out, see
  Choices.
- New strings are English through `tl!` (catalogues left to their fallback).

## For the next packages

- **P3** (noise gradients): nothing here touches gradients.
- **P4** (Migrate Presets): JS `tool-presets` entries can go through `tpl_map`'s JS mapping: `tool_for_js` gives the
  PhotoCraft tool, and the option mapping (`common_from_js` + `place`, private) is what P4 needs for the JS
  `tool-presets.json` store; make a `pub fn js_tool_preset(tool, options, type, color) -> Option<(tool, Value, skipped)>`
  wrapper in `tpl_map.rs` rather than writing a second table. The JS preset's `data.brush` (normalizeBrush schema) is
  not mapped here (`.tpl` brushes come from `Brsh`); P4's `legacy_pigment::brush` mapper is the place for it.
- B18 (Adjustment Brush): add `("adjustmentBrush", "adjustmentBrushTool")` to `TOOL_CLASSES` and
  `("adjustment-brush", "adjustmentBrush")` to `JS_TOOLS`; the ui test then checks it against `Tool::ALL`.
