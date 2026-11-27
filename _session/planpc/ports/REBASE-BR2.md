# REBASE-BR2: group BR2 (B14, B15, B16, B17, B18) re-checked against Pigment on PhotoCraft 057297b

Read each section beside its package in `PORTS-B.md` (rows 29 to 34 and 36 to 38 in section 2, the package table in
section 3). **Where the two disagree, this file wins.** The spec's intent and its tests' intent still hold. Where this
file says nothing about a point, the spec stands as written.

**Tree checked:** `/home/user/claude/pigment` on `claude/pigment-photocraft` at `03ccb71` (`UPSTREAM-REVISION` =
`057297b`). craft-libs is pinned at `18ffc07` (`Cargo.toml:15`) and was read in the cargo checkout
`~/.cargo/git/checkouts/craft-libs-d830b991a08c6c3d/18ffc07`. Below, `CL/` means that folder's `crates/`. Paths
without a prefix are relative to `pigment/`. No cargo was run and nothing in the repository was changed.

**The JS references moved.** On `claude/fervent-newton-263lz3` the files the spec names are under
`pigment/src/renderer/` and `pigment/src/shared/`. For example, `lib/scripted-patterns.js` is
`pigment/src/renderer/lib/scripted-patterns.js` (347 lines), `lib/tools/adjustment-brush.js` is
`pigment/src/renderer/lib/tools/adjustment-brush.js`, `shared/pixels/matte.js` is `pigment/src/shared/pixels/matte.js`,
and `shared/defaults.js` is `pigment/src/shared/defaults.js`. They are still readable with `git show`.

**Upstream's measured documents** say almost nothing about this group:
- `docs/gaps.md:81` and `docs/target-app-parity.md:617` still list "Object Aware refine mode (#2788)" as missing.
  `docs/scorecard.md:184` (TOOL-214-1) is "partial" for the same reason.
- `docs/scorecard.md:195` (TOOL-214-12) covers polygon corner radius handles. Smooth corners and indents are not mentioned.
- `docs/scorecard.md:174` (TOOL-213-6) says the Fill dialog is done. It has no scripts.
- Focus Area views and options, Object Selection lasso and Object Subtract, the Adjustment Brush, the brush leash
  colour and scripted patterns appear in none of `target-app-parity.md`, `gaps.md`, `scorecard.md` or
  `parity-checklist.md`. That last file counts menu items only: 664 of 664 live.
- Pigment's own `docs/parity/README.md` lists every row of this group as still open (lines 154, 158, 176 to 178, 196,
  197, 200 and 203). Update those lines when a package lands.

The code shows one part that upstream built: **Object Selection's Hard Edge** (#12855). It has the engine key
`select.object {"hardEdge":bool=true}` (`crates/engine/src/cmd/smartselect_cmds.rs:360-365`, spec line 673), an
options-bar check box (`crates/ui-egui/src/tools/retouch_ui/bar/select.rs:40`), the tool option
`ToolOptions.object_hard_edge` (`state/tool_options.rs:22`, default on at :415), and tests
(`smartselect_cmds/object_hard_edge_tests.rs`). That part is dropped from B16. Nothing else in this group was built
upstream.

## What changed for every package

1. **Interface pieces come from the framework, and Pigment cannot change them.** craft-libs is a pinned git
   dependency, and `docs/FORK.md` treats a change to craft-libs as a question for the project's owner. These
   framework pieces block parts of this group:
   - **Select and Mask** is craft-imaging's `SelectMaskWorkspace` (`CL/imaging/src/ui/select_mask/`). Its Properties
     panel draws Refine Mode with Object Aware disabled and the reason "Object Aware needs a segmentation model…"
     (`panel.rs:155-165`, words in `words.rs:35-38`). `RefineSettings` (`session.rs:96`) and `SelectMaskCommand`
     (`session.rs:165`) have no refine mode. B14 row 31's switch is therefore blocked (see B14).
   - **Mask views** are the framework's `MaskViewMode` (`CL/imaging/src/ui/mask_view/state.rs:15`): Onion Skin,
     Marching Ants, Overlay, On Black, On White, Black & White and On Layers. **Pigment cannot add a `RevealLayer`
     variant.** For B14, Reveal Layer is the recipe with `hidden` set, which already exists (X held).
   - **The Create Polygon dialog** is the framework's `CreateShapeDialog`
     (`CL/draw/src/ui/shape_drag/dialog.rs`, opened by `dialogs/shape_dialog.rs:15`). **The Shape Properties panel**
     is the framework's `ShapePanel` (`CL/draw/src/ui/shape/panel.rs:493-500`), and its `ShapeChange` enum is
     `#[non_exhaustive]` with no smooth variants (`CL/draw/src/ui/shape/mod.rs:217-265`). Neither can take Smooth
     Corners or Smooth Star Indents (see B15).
   - **The smoothing string** (the brush leash) is the framework's `StraightLinePreview`
     (`CL/ui-canvas/src/canvas_controls/line_preview.rs`). Its colour comes from the theme's overlay tokens, with no
     per-instance colour (see B17).
2. **Form dialogs** are `ParamDialog`s of `Param` rows (`CL/ui-patterns/src/patterns/form_dialogs/param.rs`).
   - Open them with `crate::dialogs::params::open_param` (`dialogs.rs:133`).
   - A `ParamFamily` in `PARAM_FAMILIES` (`dialogs.rs:68-115`) answers each one, with `owns` and `run`, plus an optional
     `check` (holds OK with a message), `cancel` (undoes a live preview) and `footer` (a footer button; example:
     `color_table_ui::footer_action`, `dialogs/color_table_ui.rs:98`).
   - Row conditions: `visible_when` takes one key and one value (`param.rs:737`), `enabled_when_in` takes several
     values (:621), and `resets` (:603) drops dependent keys when a row changes. There is no and-condition.
   - The closest model is the Fill dialog itself (`dialogs/fill_ui.rs`, 156 lines). A framework pattern dialog is
     opened on `app.framework.dialogs` and taken by a function in `TAKERS` (`dialogs.rs:438`).
3. **Menu routing.** A command opened with no params goes through an arm in `menus/invoke.rs` (the Fill arm at
   :539-545 and Select and Mask at :547-549 are the models). Do not add rows to `menu_catalog.rs`: it is Photoshop's
   tree. "Focus Area…" (:550) and every other item this group needs are already there.
4. **The canvas shows a dialog's preview document** through `canvas/display.rs:110` `display_doc_live`, a chain of
   `if let Some(shown) = crate::<module>::display_doc(app, idx) { return shown; }`. Each preview is one line there.
   The Selection Preview overlay (no ants, a `PreviewMode` tint) is drawn at `canvas/document_display.rs:324-331`
   for Color Range.
5. **Canvas tools are framework `CanvasTool`s.**
   - Object Selection is in `canvas/tools/retouch.rs` (`RetouchTool`). It already owns a framework `LassoTool`
     (`retouch.rs:35`) that Patch and Content-Aware Move use.
   - Painting tools go through `canvas/paint_tool.rs` and `canvas/strokes.rs`.
   - Tool icons are `ToolCommand` attributes (`panels/tool_commands.rs`), read by `icons::tool_icon`
     (`icons.rs:33`). App-only icons are SVGs in `assets/icons/`, listed in `icon_data.rs:10-41`.
6. **Preferences** live in `config.toml` (TOML has no null).
   - The Preferences window builds its rows from the engine's structs (`prefs/prefs_ui/fields.rs:16` `PrefPages`).
   - A colour row is any string preference whose leaf is in `prefs::is_color` (`engine/src/prefs/validate.rs:139-158`).
     Labels are spelled out from the key unless overridden in `label_override` (`fields.rs:199`).
   - The `prefs_usage` test fails for a preference nothing reads, unless it is in `HIDDEN_UNTIL_IMPLEMENTED`
     (`validate.rs:38`).
   - After adding one, run `cargo xtask scorecard --check` and `cargo test -p xtask`.
7. **Engine command rule 9:** any changed command runs the panic hunt
   (`cargo test -p photocraft-engine --test panic_hunt -- --ignored`). Out-of-range values are errors, never clamps.
   Some upstream params here still clamp (`select.focusArea` `range`). Keep that for the old keys and make the new
   keys strict.
8. **Integration tests** are one binary per crate: `crates/<crate>/tests/it/main.rs` lists the modules. Unit tests
   sit beside the code as `<module>/<name>_tests.rs`, declared from the parent with `#[cfg(test)] mod …;`. That is
   the upstream pattern, for example `smartselect_cmds.rs:706-717`.
9. **Words** are `tl!()` (English). `cargo xtask i18n-report` lists untranslated strings. The spec's
   `every_tl_literal_is_translated` test no longer exists.
10. **Hooks:** mark every edited upstream line `// Pigment: …` and list it in `docs/FORK.md` under "What Pigment
    added" (FORK.md:366). Pigment's own files (`crates/io/src/legacy_pigment*`, `docs/parity/`) need no entry.

---

## B14: Focus Area and Object Aware (rows 29, 30, 31)

### Status of each row

| Row | Now | Evidence |
|---|---|---|
| 29 Focus Area views | **missing** | No Focus Area dialog of its own. `select.focusArea` (`smartselect_cmds.rs:697-703`) is opened by the generic filter family (`dialogs/filter_dialog.rs:220` `owns`: any engine command), so it is a plain form with `range`, `noise`, `sampleAllLayers` and `mode`, with no preview and no views. |
| 30 Focus Area parameters and output | **partly** | `focus_area` (`smartselect_cmds.rs:481-485`) takes `range` and `noise` (both clamped) and selects only. No Auto range, no Auto noise, no Soften Edge, no Output To, no Select and Mask button. The algorithm is `algo/src/segment/focus.rs:42` `focus_area` (`sharpness` at :18). Its tests: `algo/src/segment/tests.rs:728` `focus_area_selects_sharp_half` and `smartselect_cmds/tests.rs:522` `focus_area_command`. `.atn` maps Photoshop's `focusMask` to it with no keys (`atn_cmds/events.rs:670`). |
| 31 Refine Mode (Color / Object Aware) | **missing** (engine), **blocked** (switch) | `select.refineEdge` has no `refineMode` (spec string :692). `algo/src/matting.rs` refines with the plain guided filter only (`refine_buffer_with` :315, `guided_filter_color` :146). The radio is drawn by the framework, disabled (see "What changed" 1). Upstream still lists it missing (#2788, `gaps.md:81`). |

No row is dropped.

### Where things are now

| Spec names | Now |
|---|---|
| new `ui-egui/src/dialogs/focus_area_ui.rs` | still to create. It is a `ParamFamily` dialog, not a free window (below). |
| `canvas/select_mask_view.rs` `Mode` enum (`:30`), add `RevealLayer` | **gone.** The file is now the preview *builder* for the framework's `MaskViewRecipe` (`select_mask_view.rs:155` `preview_proxy`, private `show` at :261, `Coverage` at :21). The view enum is the framework's `MaskViewMode` and cannot be extended. Reveal Layer is `MaskViewState { hide_view: true, .. }.recipe()` (`recipe.hidden`, which `preview_proxy` answers at :164). |
| "the existing preview worker pattern" | `dialogs/filter_preview_worker.rs`. The closest model for "compute a mask on a small proxy, show it on the canvas" is `dialogs/color_range_ui.rs` (proxy, `selection_preview` :413, drawn at `canvas/document_display.rs:324-331`). |
| route `select.focusArea` to the dialog (one arm) | an arm in `menus/invoke.rs` beside Fill (:539-545), plus a family line in `dialogs.rs` `PARAM_FAMILIES`, before the generic `filter_dialog` family (:113) |
| `smartselect_cmds.rs` focusArea `:604`, refineEdge output names `:598` | `focus_area` :481, spec :697-703; `refine_edge` :557, its output match :589-652, spec :689-694 |
| the refine output helper "factor out" | still inline in `refine_edge` (:589-652) |
| `segment/focus.rs sharpness` | `focus.rs:18` (pub). An Otsu threshold exists: `segment::subject::otsu` (`algo/src/segment/subject.rs:660`, pub) |
| Soften Edge (spec: feather 1 px + AA) | upstream now has `soften_edge(region, canvas)` (`smartselect_cmds.rs:298`, private), Photoshop's measured one-pixel rim for Object Selection's Hard Edge off. **Reuse it** for Focus Area's Soften Edge. |
| `select_mask_ui.rs` open function | `dialogs/select_mask_ui.rs:311` `pub fn open(app)`. It refuses while a workspace is open, and needs a selection or a mask. |
| `select_mask_ui.rs:23` greys Object Aware | **moved to craft-libs**: `CL/imaging/src/ui/select_mask/panel.rs:155-165`. `select_mask_ui.rs` now hosts the framework workspace. OK maps `SelectMaskCommand` → params in `command_params` (:285) and runs it in `run_held_ok` (:405). |
| `algo/src/matting.rs` | still there (1538 lines). `RefineParams` :26 (Copy, serde default, no mode field); `refine_buffer_with` :315 is where the guided filter is applied. |

### The plan, adjusted

**Engine, Focus Area (rows 29, 30).** Put it in Pigment's child module `crates/engine/src/cmd/smartselect_cmds/focus_more.rs`.
As a child module it can call the parent's private `with_sampler`, `apply`, `soften_edge`, `f`, `b` and `mode`
through `super::`, so nothing upstream has to become public.
- New keys, all strict (an error when the type or range is wrong):
  - `"autoRange":bool=false`: the threshold is `subject::otsu` on `focus::sharpness`. Expose a small
    `focus::focus_area_with(sampler, canvas, Threshold::Auto | Range(r), noise)` in `focus.rs`, keeping `focus_area` as
    the wrapper. That is a hook in an upstream file, so keep it small.
  - `"autoNoise":bool=false`: estimate the floor from the low percentile of the sharpness map.
  - `"softenEdge":bool=false`: `super::soften_edge(&region, canvas)`.
  - `"output":"selection|layerMask|newLayer|newLayerWithMask|newDocument|newDocumentWithMask"="selection"`.
- **Output helper:** move the `match output.as_str()` block of `refine_edge` (:589-652) unchanged into a
  `pub(super) fn output(s, label, output, region: Option<Surface>, pixels: impl FnOnce(&Surface, &Surface) -> Surface)`
  in a second Pigment child `smartselect_cmds/output.rs`. `refine_edge` then calls it, with decontamination as its
  `pixels` closure, and Focus Area calls it with the identity.
  - A Focus Area `Region` becomes the `Surface` that helper takes through `matting::region_surface`
    (`matting.rs:755`).
  - Label it "Focus Area", one history step.
  - This is the one sizeable upstream edit: list it in FORK.md as "moved, not changed". The alternative, a copy,
    would miss upstream's fixes to that block.
- Hook in `focus_area` (:481): `// Pigment:` one line, `return focus_more::run(s, p);`. Keep the old body as the
  `run` path for params without the new keys, so the `.atn` and existing tests stay byte-identical.
- Append the new keys to the spec string (:700, an upstream line, marked).

**Engine, Refine Mode (row 31).** This part is not blocked.
- `select.refineEdge` gets `"refineMode":"color|object"="color"`, parsed in `refine_params` (:487).
- Add `pub mode: RefineMode` (`#[serde(default)]`, default `Color`) to `matting::RefineParams`, and fill it in the
  struct literals that list every field: `algo/src/matting.rs` (4), `engine/src/cmd/smartselect_cmds.rs` (3) and
  `engine/src/cmd/cutout_cmds.rs` (1). Use `..RefineParams::default()` where possible.
- Put the JS `detectEdge` blend in a new Pigment file `algo/src/matting/object_aware.rs` (`matting/` already holds
  `brush.rs` and `morphology.rs`):
  - the trusted-pixel weighted guided filter (trust 1 outside the band, 0.02 inside);
  - the colour projection estimate;
  - weights object 0.75 / colour 0.25 (`pigment/src/shared/pixels/matte.js`, `MODE_COLOR_WEIGHT`).
- Hook one `if p.mode == RefineMode::Object { … }` branch at the guided-filter call in `refine_buffer_with`
  (:333). Colour mode stays today's code path exactly.
- The preview path needs nothing: `select_mask_view::refine` (:191) forwards the params.

**UI, Focus Area dialog (rows 29, 30)**: new `crates/ui-egui/src/dialogs/focus_area_ui.rs`.
- **Rows:**
  - View: a choice of Marching Ants, Overlay, On Black, On White, Black & White, On Layers and Reveal Layer, the
    Photoshop list with no Onion Skin, mapped to `MaskViewMode` + `hide_view`. Mark it `not_remembered` unless
    Photoshop remembers it.
  - In-Focus Range, Auto (bool).
  - A section "Advanced": Image Noise Level, Auto.
  - Soften Edge.
  - Output To (the six outputs).
- **The "Select and Mask…" button** is a footer button. Use the family's `footer` hook, as `color_table_ui` does. It
  runs `select.focusArea` with `output: "selection"` and the fields, closes the dialog, then calls
  `select_mask_ui::open`.
- **Family:** `owns(key) == "select.focusArea"`. `run` runs the command with the fields through a `params()` like
  `fill_ui::params`; `cancel` drops the preview.
- **Preview:** a reduced proxy of the document, as `color_range_ui` builds it.
  - Run `focus_more` on the proxy in the worker, keyed by the field values.
  - Build the shown document with the framework recipe of the chosen view (`MaskViewState { mode, hide_view, .. }.recipe()`).
  - Reuse `select_mask_view`'s private `show(doc, active, recipe, coverage)` (:261) through a new
    `pub(crate) fn show_coverage(proxy, active, recipe, coverage: Option<&Surface>) -> Document` in that file, a
    marked three-line wrapper.
  - Hand the result to the canvas with a `focus_area_ui::display_doc(app, idx)` line in `canvas/display.rs`
    `display_doc_live` (:110).
  - Marching Ants needs the ants on the canvas. Either use the recipe's `ants` (as `preview_proxy` does) or draw
    `SelectionOverlay` as Color Range does at `document_display.rs:325`.
- **Hooks:**
  - one `PARAM_FAMILIES` line (`dialogs.rs`);
  - one `menus/invoke.rs` arm (`"select.focusArea" if params.is_empty() => Ok(dialog_reply(crate::focus_area_ui::open(app)?))`);
  - one `display_doc_live` line;
  - the `show_coverage` wrapper;
  - the `mod focus_area_ui;` line wherever dialogs are declared.

**UI, Refine Mode switch (row 31): blocked on craft-libs.** Pigment cannot enable the framework's disabled radio,
and the workspace's command carries no mode.
- Write the change request for the project's owner: `RefineSettings.refine_mode`, an opt-in
  `SelectMaskOpen::object_aware(true)`, and a tooltip word saying it is a classical approximation.
- Until that lands, `refineMode:"object"` is reachable from MCP, the CLI and Actions only.
- When it lands, `command_params` (`select_mask_ui.rs:285`) adds the key: one line.
- Say this in `docs/parity/README.md:178`.

**Tests** (the spec's intent, new places):
- `smartselect_cmds/focus_more_tests.rs`:
  - `autoRange` on a half-sharp, half-blurred image selects the sharp half (IoU > 0.8);
  - `output:"newLayerWithMask"` makes a layer with a mask and hides the source;
  - `softenEdge` gives intermediate alpha on the edge;
  - every bad key or value is an error;
  - params without the new keys give the same selection as before.
- `smartselect_cmds/tests.rs` `focus_area_command` stays green.
- `algo/src/matting/object_aware_tests.rs`: on a soft-edged disc over texture, object mode's alpha error is at most
  colour mode's, and the two differ. Colour mode equals a golden of today's output.
- `dialogs/focus_area_ui/tests.rs`:
  - the View choice changes the preview document (On Black differs from Reveal Layer);
  - OK journals `select.focusArea` with the fields (`dialogs::testing::confirm`);
  - the footer button leaves the selection made and Select and Mask open;
  - Cancel leaves the document untouched.
- The panic hunt (rule 9).

**Effort:** 2–2.5 d. The engine part is as specced. The dialog is a family with a proxy preview rather than a bare
window. The workspace switch is moved to a craft-libs request.

---

## B15: shape pattern fill and polygon smoothing (rows 32, 33)

### Status of each row

| Row | Now | Evidence |
|---|---|---|
| 32 Shape fill: pattern | **partly**, unchanged since the spec | The engine takes a pattern (`vector_cmds/params.rs:216-225`), but only `{"pattern":name,"scale"}`, with `id: ""`, angle 0, link on and phase 0. `fill_json` (:150) writes back only name and scale. PSD writes vscg `patternLayer` (`io/src/vector_map.rs:314`). The chips offer None, Solid and Gradient only. `paint_of` shows a pattern as No Color (`tools/shape_paint_ui.rs:68-75`), `fill_param` sends `null` for it (:102-108), and `PaintChange` has no pattern (:53-58). |
| 33 Polygon Smooth Corners and Smooth Star Indents | **missing** | `LiveShape::Polygon { rect, sides, star_ratio, corner_radius }` (`doc/src/vector.rs:308-314`). `polygon_rounds_vertex` rounds only a star's outer points (`vector/src/shapes.rs:131`). `live_path` uses one radius (:318-320). No params, no UI. The legacy importer **refuses** a smoothed JS polygon and opens it as a plain path with a note (`io/src/legacy_pigment/paint.rs:422-425`, note text at :497-501, test `legacy_pigment/layer_kinds_tests.rs:420` for `v3-shape-star-smooth`). |

No row is dropped.

### Where things are now

| Spec names | Now |
|---|---|
| `tools/shape_paint_ui.rs:22-25` `PaintChange` | `shape_paint_ui.rs:53` `PaintChange { Color, Gradient(Fill), None }`. The chips are the framework's `PaintChip` (`CL/color-ui/src/ui/paint_chip.rs`), decorated by `decorate_chip` (:177). |
| "a Pattern tab reusing the pattern library grid (`paint_picker.rs library()` / `pattern_fill_ui.rs` picker)" | **the framework has it.** `PaintChip::pattern_editor(default: ImagePreview, editor)` (`paint_chip.rs:347-354`) adds the Pattern tab, and `Paint::Pattern(ImagePreview)` is a paint (:143). The editor body is craft-draw's `PatternFillEditor` (`CL/draw/src/ui/pattern/editor.rs:75`): pattern grid, Snap to Origin, Angle dial, Scale and Link with Layer, over `PatternFillOptions`. Swatches and thumbnails are built exactly as in `dialogs/pattern_fill_ui.rs:75-84` (`PatternSwatch::new(id, name)`, `preset_browser::pattern_texture`). `tools/paint_picker.rs` is now 52 lines with no `library()`. |
| `tools/vector_ui/options.rs` polygon gear | `options.rs` is the Path Selection / Shape tools bar. The Shape tools' fields are the framework's `ShapeBar` (`tools/shape_options.rs:219`). Pigment adds its own controls after it: the Triangle's "Align Edges" (:226-234) is the model. A gear is `IconButton::new(IconId::new("settings"))` plus `craft::ui::popover::Popover::new(..).opened_by(&gear)` (as `CL/draw/src/ui/shape/gear.rs:65-78`; a Pigment use is `tools/vector_ui/path_menus.rs`). |
| `dialogs/shape_dialog.rs` KEYS | **gone.** `shape_dialog.rs` (75 lines) opens the framework's `CreateShapeDialog` (:33), which has no smooth fields. It even opens polygons at star ratio 1 (":31 the options bar has no star ratio"). |
| Properties › shape | the framework `ShapePanel` (`tools/vector_ui/options.rs:450`, changes mapped in `edit_of` :345). No smooth fields; `ShapeChange` cannot be extended. |
| `doc/src/vector.rs:308` | `:308-314` unchanged |
| `vector/src/shapes.rs polygon_rounds_vertex` (l.131) | :131. `round_corners_where(path, r, rounds)` :197 takes **one** radius, and returns early for `r <= 0` (:198). `fillet` :153 caps at half of each edge (`INFINITY.min(cap)` works). `live_path` :318. |
| `vector_cmds/params.rs` `starRatio` l.358, `:150`, `:216` | polygon/star parse :351-364; `fill_json` :143-152; pattern parse :216-225 |
| `vector_map.rs:398–435` (no polygon live mapping) | still none: `vector_map.rs:495` returns `None` for Polygon and Triangle. Polygons export as paths, unchanged. |
| tool geometry params | `tools/vector_ui/shapes.rs:190` `geometry_params` is the one builder of `shape.create` geometry, used by the drag and by the Create dialog (`create_geometry` :341) |
| tool defaults for a paint | `shape_options.rs:355` `set_tool_paint` stores a gradient in `ToolOptions.shape_fill_gradient` / `shape_stroke_gradient` (`Option<Fill>`, `state/tool_options.rs:129`). A pattern `Fill` fits the same slot. |

### The plan, adjusted

**Row 32, engine** (`engine/src/cmd/vector_cmds/params.rs`, upstream, marked):
- The pattern branch (:216) also accepts `{"pattern":{"id","name","scale","angle","link","phase"}}`. Resolve `id`
  through `pattern_cmds::resolve_id`, as Pattern Fill does. The old string form keeps its defaults.
- `fill_json` (:150) writes the object form. Check every reader of `fill_json` output first: `shape.info`, Actions
  and the copy-shape paths.
- Stroke paint already goes through the same parser (`ShapeStroke.paint: Fill`, `doc/src/vector.rs:237`). Confirm that
  `compose` renders a pattern stroke (`compose/src/content.rs:135` handles `Fill::Pattern` in `render_fill_with`), and
  add a test.

**Row 32, UI** (`tools/shape_paint_ui.rs`, upstream, edited; the Pattern code in a new Pigment file
`tools/shape_pattern_ui.rs`):
- `PaintChange::Pattern(Fill)`.
- `ChipLibrary` gains the pattern swatches, thumbnails and an `edited_pattern: [Option<PatternFillOptions>; 2]`, as it
  holds gradients.
- `decorate_chip` adds `.pattern_editor(default_preview, |ui| PatternFillEditor::new(..).thumbnails(..).show(ui) → ImagePreview)`.
- `paint_of` shows `Fill::Pattern` as `Paint::Pattern(ImagePreview::new(name, texture))`.
- `fill_param` and `paint_param` emit the object form.
- `shape_options.rs` `paint_change` (:106) and `paint_edit` (:128) gain the Pattern arm, as does `set_tool_paint`
  (:355).
- `vector_ui/options.rs` `edit_of` (:345) maps `ShapeChange::Fill(Paint::Pattern)` and `Stroke { Paint::Pattern }`.
- That covers both the options bar and Properties, because both call `decorate_chip`.

**Row 33, model and engine:**
- `LiveShape::Polygon` gains `#[serde(default)] smooth_corners: bool, #[serde(default)] smooth_indents: bool`. That
  is an upstream file. About 33 `LiveShape::Polygon` patterns and literals exist (doc, vector, engine, io, ui-egui,
  format tests). Those without `..` must list the new fields.
- `shapes.rs`: add `round_corners_by(path, radius_of: impl Fn(usize) -> f64)`, the per-vertex form of
  `round_corners_where` with no early return on a zero base radius.
- `live_path` for Polygon: outer vertex radius is `if smooth_corners { INFINITY } else { corner_radius }`; inner is
  `if smooth_indents { INFINITY } else { 0.0 }`; a plain polygon uses the outer rule.
- `polygon_rounds_vertex` stays for `shape_controls.rs:307`'s corner handles.
- `params.rs` polygon branch (:351-364): `"smoothCorners":bool`, `"smoothIndents":bool`, kept from `prev` like
  `corner_radius`. Add them to the `shape.create` / `shape.edit` spec strings.

**Row 33, UI:**
- **Options bar:** for `Tool::Polygon` (and the Star kind), a gear popover after `ShapeBar` in `shape_options.rs`, at
  the "Align Edges" spot (:226). It holds "Smooth Corners" and "Smooth Star Indents" (enabled when the star ratio is
  below 100 %).
  - New tool options `polygon_smooth_corners`, `polygon_smooth_indents` (`state/tool_options.rs`, `#[serde(default)]`).
  - `geometry_params` (`vector_ui/shapes.rs:197-202`) adds both keys for Polygon geometry. The drag and the Create
    Polygon dialog then both honour the gear.
  - With a polygon shape layer selected from Path Selection, the same gear edits it through `shape.edit`, as the bar's
    other fields do.
- **Create Polygon dialog and Properties: blocked on craft-libs** (framework dialog and panel). Record a craft-libs
  request: "Smooth Star Indents" in `CreateShapeDialog`, and smooth flags in `ShapePanel`/`ShapeChange`. Until then,
  the dialog's polygons take the gear's values through `geometry_params`, and Properties shows no checkboxes.
- **Legacy importer (Pigment's file):** in `io/src/legacy_pigment/paint.rs` `live_of` (:422-425), map JS
  `smoothCorners` / `smoothIndents` into the new fields instead of returning `Err("smooth")`. Drop the "smoothed"
  arm of the note (:499). Update `layer_kinds_tests.rs:144` and `:420`: `v3-shape-star-smooth` now opens live with
  `smooth_indents`, and the expected note list loses that entry.

**Tests:**
- `vector/src/polygon_smooth_tests.rs`: a 5-point star with smooth indents has curve knots at inner vertices and sharp
  outer ones; smooth corners round a plain polygon's vertices with infinite radius capped by `fillet`.
- Serde back-compat: old JSON without the fields loads, beside `doc/src/vector.rs:403`.
- `vector_cmds/tests.rs`:
  - the pattern object form parses and round-trips through `fill_json`;
  - `smoothCorners` / `smoothIndents` parse and are kept by an edit that omits them.
- `io` PSD test: a shape with a pattern fill exports vscg `patternLayer` with the scale and angle; add the angle to
  the existing assertion.
- `tools/vector_ui/paint_tests.rs` (exists) or a new `shape_pattern_ui/tests.rs`: picking a pattern in the chip sets
  `Fill::Pattern` on the selected shape (one history step), and as the tool default.
- The polygon gear sets the tool options, and a drag creates a polygon with them.
- The legacy importer test above.
- The panic hunt (`shape.create` / `shape.edit` changed).

**Effort:** 1.5 d. Up from 1 d: more call sites for the new `LiveShape` fields, the legacy importer, and the chip
library work; the framework's ready Pattern tab saves the picker.

---

## B16: Object Selection modes (row 34)

### Status of each row

| Part of row 34 | Now | Evidence |
|---|---|---|
| Hard Edge | **done upstream** (dropped) | `select.object {"hardEdge":bool=true}` (`smartselect_cmds.rs:360-365` `object_edge`, spec :673); options-bar check box `retouch_ui/bar/select.rs:40`; `ToolOptions.object_hard_edge` (`tool_options.rs:22`, default on :415); sent by `finish_object_selection` (`tools/retouch_ui.rs:600`, 609, 623); tests `smartselect_cmds/object_hard_edge_tests.rs`. Upstream measured the reference application (#12855): on is the found object, off adds `soften_edge`'s rim. That replaces the spec's "threshold at 0.5", and the spec's "only 0/255 alpha" test is not carried. |
| Mode: Rectangle / Lasso | **missing** | `select.object` takes `rect` or `point` only (`object_selection` :410-428). `grabcut::object_select(sampler, canvas, rect, work_px)` (`algo/src/segment/grabcut.rs:90`), whose trimap comes from the `inside` rect test (:102-115). |
| Object Subtract | **missing** | Subtract mode always subtracts the found object, which is Object Subtract on. There is no plain-region subtract. |
| Sample All Layers, Object Finder | done (upstream) | `bar/select.rs:38-39` |

Dropped: **Hard Edge**, done upstream and measured. Upstream's semantics win.

### Where things are now

| Spec names | Now |
|---|---|
| `smartselect_cmds.rs:580` `select.object` | `object_selection` :410; spec :671-678; `object_at_point` :368 (Object Finder) |
| `algo/src/segment/grabcut.rs object_select` | `grabcut.rs:90`, unchanged signature |
| `tools/retouch_ui.rs:644–656` (the tool) | the press, drag and release are `canvas/tools/retouch.rs` (`RetouchTool`, framework `CanvasTool`). The rectangle finishes in `retouch_ui::finish_object_selection` (`tools/retouch_ui.rs:590`). `RetouchTools` already owns a framework `LassoTool` (`retouch.rs:35`) for Patch and Content-Aware Move. Their outlines come back as `SelectEvent::Commit { shape: SelectionShape::Polygon(points), operation }` in `drain` (`retouch.rs:112-139`). |
| options bar | `tools/retouch_ui/bar/select.rs:34-45` `object_selection`. A dropdown example: `bar/history.rs:70` (`Select::new(label, Bind::bound(&mut o.field), &entries)`). |
| `state/tool_options.rs` fields | `object_finder` :20, `object_hard_edge` :22. Add `object_mode` and `object_subtract` there (`#[serde(default)]` struct). |
| "a lasso drag … like the Lasso tool" | reuse `RetouchTools.lasso` (above), not a new collector |
| Select and Mask's own Object Selection tool | the framework workspace's (`select_mask_edits` `{"tool":"object","rect"|"point"}`); out of scope, unchanged |

### The plan, adjusted

**Engine** (`smartselect_cmds.rs`, upstream, a few marked lines; the new code in a Pigment child
`smartselect_cmds/object_lasso.rs`):
- `"lasso":[[x,y],…≥3]`:
  - the region is the polygon, rasterized with `photocraft_algo::selection` (the Lasso's own path);
  - GrabCut's probable foreground is inside it, background outside;
  - error on fewer than 3 points, non-finite points, or more than `select_mask_edits::MAX_EDIT_POINTS`;
  - checked like `rect` by `check_sampled_pixels` (:263) over the polygon's bounds.
  - In `grabcut.rs` add `object_select_in(sampler, canvas, bounds, inside: &dyn Fn(i32, i32) -> bool, work_px)`, and
    make `object_select` its rect wrapper (an upstream file; keep `object_select`'s behaviour byte-identical).
- `"objectSubtract":bool=true`: with mode `subtract` and false, apply the plain region (rect or polygon, through
  `apply(s, "Object Selection", Some(&region), SelectionMode::Subtract)`) with no GrabCut. It is ignored in other modes.
- Hook: one line at the top of `object_selection` (:414, after the refusal check):
  `if let Some(out) = object_lasso::try_run(s, p)? { return Ok(out); }`. That covers `lasso`, and `rect` with
  `objectSubtract:false`.
- Append the keys to the spec string (:673).
- `hardEdge` applies to the lasso result too, through `super::object_edge`.

**UI:**
- `tool_options.rs`: `object_mode: ObjectMode` (Rectangle | Lasso, default Rectangle) and `object_subtract: bool`
  (default true).
- `bar/select.rs`: a "Mode" `Select` after the operation segments, and an "Object Subtract" check box after Hard Edge.
  The hint (:41) reads "Draw a lasso around the object" in Lasso mode. That is an upstream file, marked.
- `canvas/tools/retouch.rs`:
  - `lassos()` (:154) is also true for `Tool::ObjectSelection` when `object_mode == Lasso` and the press is not the
    outline drag or ⌘. The press branch (:189) must not claim a rectangle press then.
  - In `drain` (:112), a Commit from Object Selection with `SelectionShape::Polygon(points)` calls a new
    `retouch_ui::finish_object_lasso(app, points, operation)` instead of `run_commit`. It runs `select.object` with
    `lasso`, `mode` (from the commit's operation), `sampleAllLayers`, `hardEdge` and `objectSubtract`.
  - A click with no outline keeps today's Object Finder and Quick Selection behaviour.
- `finish_object_selection` (`retouch_ui.rs:621-624`) adds `objectSubtract` to the rectangle call.

**Tests:**
- `smartselect_cmds/object_lasso_tests.rs`:
  - a lasso around a synthetic disc selects the disc (IoU > 0.9);
  - subtract with `objectSubtract:false` removes exactly the polygon, and with true removes the found object;
  - fewer than 3 points is an error;
  - rect calls without the new keys are unchanged (`object_hard_edge_tests.rs` stays green).
- `tools/object_selection_mode_tests.rs` (exists, its harness at :17-40) gets a lasso case: in Lasso mode a drag
  journals `select.object` with `lasso`; ⇧ adds and ⌥ subtracts; the Object Finder click still works.
- The panic hunt.

**Effort:** 0.75 d. Hard Edge is gone from the package, and the lasso gesture already exists in the tool.

---

## B17: Adjustment Brush and brush leash colour (rows 36, 38)

### Status of each row

| Row | Now | Evidence |
|---|---|---|
| 36 Adjustment Brush tool | **missing** | no `Tool::AdjustmentBrush` (`state/tool.rs`, `Tool::ALL` has 69 tools at :84); no `ToolCommand` (`panels/tool_commands.rs`) |
| 38 Brush leash colour, Show Leash | **missing** | `prefs::Cursors` (`engine/src/prefs.rs:907-926`) has `painting`, two crosshair flags, `other` and `brush_preview_color` (default `#ff0000`). The leash is the framework's `StraightLinePreview` in the theme's overlay colour (`tools/brush_feedback.rs:68-72` `show_smoothing_string`). No preference. |

No row is dropped.

### Where things are now

| Spec names | Now |
|---|---|
| `state/tool.rs` `Tool` enum, Brush slot list (l.104), name, key B | `state/tool.rs`: Brush group list :102-105; names :165; key :271 (`'B'`); `is_brushlike` :242; `Tool::ALL` :84 (count 69). The rail's sections are `panels/toolbar.rs:30-45` (Brush slot :40). Every tool also needs a `ToolCommand` variant (`panels/tool_commands.rs`, `#[command(label, icon, kind = "tool", group = "B", default = "B", alias = "tools.select.adjustmentBrush")]`, mapped at :224 and :299). Tests count `Tool::ALL` (`toolbar_custom_group_layout_tests.rs:96`, `tool_shift_cycle_order_tests.rs`). |
| toolbar icon (`icons`) | the `icon = "…"` attribute of the `ToolCommand` (`icons.rs:33` reads it). A new SVG goes in `assets/icons/` plus a row in `icon_data.rs:10-41` and `ATTRIBUTION.md`. craft's own catalogue has Lucide `brush` and Tabler `brush` (`CL/ui-contract/icons/`), so a framework name may do. |
| `layer.newAdjustmentLayer.<kind>`, `layer.layerMask.hideAll` (`menu_catalog.rs:323`) | both still engine commands (e.g. `engine/src/tests.rs:237`, `:618`) |
| `"coalesce"` | any command accepts it; consecutive commands with the same key share one history step (`engine/src/session/execute.rs:11-13`, :333-349). The step keeps the first command's label. |
| `canvas/strokes.rs:810` stroke `"target":"mask"` | `strokes.rs:396` `stroke_params` builds the `paint.stroke` params of every Brush-like stroke (live preview and commit alike). `paint_target` (:836) already answers `"mask"` for an adjustment layer with a mask (#4298). `paint.stroke` takes `"color"` (spec string `brush_cmds.rs:1455`), so add and subtract need no swatch change. |
| `window.panel.properties` | `panel_docking::show_panel(app, "properties", Some(true))` (as `menus/invoke.rs:469`). Use it, not the toggling command. |
| `engine/src/prefs.rs:851 Cursors` | `prefs.rs:907` |
| `prefs/validate.rs` paths | colour leaves `validate.rs:147-158` (`brushPreviewColor` :154); `HIDDEN_UNTIL_IMPLEMENTED` :38 |
| prefs UI Cursors page, "same widget as Brush Preview colour" | **automatic.** The page is built from `prefs::Cursors` through `PrefPages` (`prefs/prefs_ui/fields.rs:16`). A string whose leaf is in `is_color` becomes a colour row (`fields.rs:109-110`), and a `bool` a check box. Wording goes in `label_override` (:199). |
| `canvas/strokes.rs:725 draw_smoothing_string`, called from `canvas/paint.rs:608` | **gone.** `tools/brush_feedback.rs:68` `show_smoothing_string` draws `StraightLinePreview::new(..).dot()` from `live_stroke(..).smoothing_string()` (`strokes.rs:338`). |

### The plan, adjusted

**Row 36, the tool** (new Pigment file `crates/ui-egui/src/tools/adjustment_brush.rs`):
- **Registration (upstream files, one line each, marked):**
  - `Tool::AdjustmentBrush` in `state/tool.rs`: enum, `ALL` (70), the Brush group list (:102-105), name "Adjustment
    Brush Tool", key `'B'`, `is_brushlike`;
  - the `ToolCommand` variant and its two mapping arms (`tool_commands.rs:224`, :299);
  - the Brush slot in `panels/toolbar.rs:40`.
  - Update the two `Tool::ALL` count tests if they hard-code a number.
- **Options** (`state/tool_options.rs`, `#[serde(default)]`): `adjustment_brush_kind: String` (default
  `"brightnessContrast"`) and `adjustment_brush_mode: AddSubtract`.
- **Options bar:** a kind `Select` over the adjustment kinds `layer.newAdjustmentLayer.*` offers (read the ids from
  the command registry, not a copied list), and Add/Subtract. Put it beside the brush controls in the paint family's
  bar, following `tools/retouch_ui/bar/history.rs:70`.
- **Press:** a `// Pigment:` call from `canvas/paint_tool.rs`'s stroke start into `adjustment_brush::before_stroke(app)`.
  - If the active layer is not an adjustment of that kind with a mask, run `layer.newAdjustmentLayer.<kind>` then
    `layer.layerMask.hideAll`, both with `"coalesce": "adjustmentBrush:<n>"`.
  - Remember the key for this stroke, and remember that a layer was made.
- **Params:** a `// Pigment:` line in `stroke_params` (`strokes.rs:396`) for `Tool::AdjustmentBrush`:
  `"target": "mask"`, `"color"` `#ffffff` (add) or `#000000` (subtract, or with ⌥ held), and the same `"coalesce"`
  key on the stroke that created the layer.
  - That makes creation and first stroke one History step.
  - The live-stroke offer compares params exactly, so preview and commit must carry the same keys. They do, since
    both use `stroke_params`.
- **After the first stroke:** `panel_docking::show_panel(app, "properties", Some(true))`.
- Words: `tl!("Adjustment Brush Tool")`, `tl!("Adjustment")`, `tl!("Add")`, `tl!("Subtract")`.

**Row 38, the leash:**
- `prefs::Cursors` gains `show_brush_leash: bool` (default true) and `brush_leash_color: String`. The default is
  Photoshop's, from a Photoshop 2026 Preferences sample; failing that, JS's `#4080ff`
  (`pigment/src/shared/defaults.js:85`). Record the choice.
- `validate.rs`: add `"brushLeashColor"` to the `is_color` leaves (:147-158). The bool needs nothing.
- `fields.rs` `label_override`: "Show Leash While Smoothing", "Leash Color".
- **Drawing:** the framework line cannot take a colour. In `brush_feedback.rs` `show_smoothing_string`, return early
  when `show_brush_leash` is off. When the colour is not the theme default, draw the line and dot with egui's
  painter, in the preference colour over a dark halo, through the canvas transform
  (`craft::ui::canvas::canvas_space(&Env::of(ui).view())`, as `tools/type_transform.rs:76`).
  - Keep `StraightLinePreview` for the default, so upstream's look and tests stay.
  - Alternatively, ask craft-libs for a colour on `StraightLinePreview` and use only that.
- Run `cargo xtask scorecard --check` and `cargo test -p xtask` (new preferences).

**Tests:**
- `tools/adjustment_brush/tests.rs` (canvas harness as in `tools/object_selection_mode_tests.rs:17-40`,
  `tool_event` Down, Move, Up):
  - the first stroke creates one adjustment layer of the kind, its mask white along the stroke and black elsewhere,
    in one new History state;
  - a second stroke paints the same mask in its own state;
  - an ⌥ stroke paints black;
  - changing the kind and stroking makes a new layer;
  - the swatches are unchanged;
  - Properties is shown.
- `engine/src/prefs/tests.rs`: `cursors.brushLeashColor` accepts `#rrggbb` and rejects others;
  `cursors.showBrushLeash` round-trips through `config.toml`.
- `brush_feedback` test: with `showBrushLeash:false` nothing is drawn while a smoothed stroke runs, and with a
  colour set the painted line uses it (inspect the shapes of the pass).
- `prefs_usage` passes, because the new preferences are read.

**Effort:** 2 d, unchanged. The tool plumbing moved: `ToolCommand`, the icon catalogue and the canvas tool host.

---

## B18: scripted patterns (row 37)

### Status of each row

| Row | Now | Evidence |
|---|---|---|
| 37 Fill › Pattern › Script | **missing** | `edit.fill` contents `pattern` fills a tiled pattern only (`engine/src/cmd/fill_cmds.rs:115-123`, `CONTENTS` :20). "Bricks" and "Weave" are still plain procedural patterns (`pattern_cmds.rs:92-100`). The Fill dialog (`dialogs/fill_ui.rs`) has Contents, Color, Custom Pattern, Color Adaptation and blending, and no Script. |

No row is dropped.

### Where things are now

| Spec names | Now |
|---|---|
| `fill_cmds.rs` CONTENTS l.20 | :20, unchanged. The pattern arm is :115-123. It yields `Source::Pixels(area, Vec<[f32; 4]>)`: RGBA over the fill area, not a `Surface`. `blend_into` (:381) applies mode, opacity and Preserve Transparency to it. |
| `dialogs/fill_ui.rs` | now a framework `ParamDialog` (`rows` :46-55, `params` :108-135, family `owns`/`check`/`run` :138-153, listed in `PARAM_FAMILIES` `dialogs.rs:69`). The pattern row is `ParamKind::pattern` (:50). |
| `photocraft_paint::rng` | exists (`crates/paint/src/rng.rs`, counter-based `mix64`/`rand01`), but **`photocraft-algo` does not depend on `photocraft-paint`** (`algo/Cargo.toml:14-16`). Use algo's own SplitMix64 `photo_util::Rng` (`algo/src/photo_util.rs:316`, crate-internal), one RNG, documented. |
| "existing transform helpers" (bilinear) | `photocraft_algo::transform::Homography` (`algo/src/transform.rs`) for the per-copy mapping. Sample the tile yourself, bilinear with wrap-free edges: the tile is small. |
| the pattern's pixels | `photocraft_compose::pattern::pattern_rgba(&pattern, mode)` (`compose/src/pattern.rs:156`, pub). `Tile`'s texels are private. The engine reads the tile and hands RGBA to algo; algo does not depend on compose. |
| active or selected path (Place Along Path) | the work path or the Paths panel's selected path, read as `path.stroke` reads them (`engine/src/cmd/vector_cmds/paths.rs`) |

### The plan, adjusted

**Algo:** new `crates/algo/src/scripted_patterns.rs` (`pub mod scripted_patterns;` in `algo/src/lib.rs`, one marked
line).
- Port `scriptPlacements`, `symmetryOps` and `recolorTile` from `pigment/src/renderer/lib/scripted-patterns.js`
  verbatim.
- `Placement { x, y, angle, scale, flip_x, flip_y, hue, bright }`.
- `MAX_COPIES = 50_000`. An error past it, never a silent cap: the house style.
- `render(placements, tile: (&[[f32; 4]], w, h), area: Rect) -> Vec<[f32; 4]>`, composited premultiplied over
  transparent, row-major over `area`. That is the form `Source::Pixels` takes.
- Seeded with `photo_util::Rng`.

**Engine** (`fill_cmds.rs`, upstream, a marked hook; the parsing in a Pigment file `fill_cmds/script.rs`):
- In the pattern arm, before the tiled render:
  `if let Some(script) = p.get("script") { Source::Pixels(area, script::render(s, &pat, script, area)?) }`.
- The `script` object keys are exactly the spec's, each strict.
- `placeAlongPath` without a path is an error ("Place Along Path needs a path").
- The seed: when absent, draw one and **write it back** into the journaled params, so Actions replay exactly.
  Check how the session records params (`journal: true` specs record the params as given). If a command cannot
  rewrite its journaled params, return the seed in the result and have the dialog always send one.
  - The `contentAware` arm's `"seed"` (:141) is the precedent for a seed key.
- Append the keys to `edit.fill`'s spec string, `crates/engine/src/cmd.rs:375-383` (an upstream line, marked).

**UI** (`dialogs/fill_ui.rs`, upstream, marked; the script rows in a Pigment file `dialogs/fill_script_rows.rs`):
- **Rows:**
  - "Script" choice: None, Brick Fill, Cross Weave, Place Along Path, Random Fill, Spiral, Symmetry Fill. It is
    `visible_when("contents", "pattern")` and greys Place Along Path when no path is available, through
    `disabled_options`.
  - The shared rows (Pattern Scale, Spacing, Color Randomness, Brightness Randomness) are
    `visible_when("contents", "pattern")` plus `enabled_when_in("script", SCRIPT_IDS)`.
  - Each script's own rows are `visible_when("script", id)`, the field table ported from `SCRIPTS`.
  - The `contents` row gets `.resets(["script"])`, so leaving Pattern hides the per-script rows. `visible_when`
    has no and-condition.
- `params` (:108) builds the `script` object from those fields when Script is not None. A fresh seed is sent on every
  OK.
- `defaults` (:59) sets Script None.

**Tests:**
- `algo/src/scripted_patterns/tests.rs`:
  - brick 100×100 with a 10×10 tile at spacing 0 gives 100 copies, rows offset by 50 %;
  - spiral is monotonic in radius;
  - a symmetry rotate-90 set is invariant under a 90° turn about the area centre;
  - a fixed seed is deterministic;
  - more than `MAX_COPIES` is an error.
- `fill_cmds/tests.rs`:
  - `edit.fill` with each script changes pixels, as one "Fill" history step;
  - place-along-path without a path errors;
  - the same seed gives identical pixels twice;
  - bad keys and values error.
- `dialogs/fill_ui/tests.rs`: choosing a script shows its rows, and OK journals `script` with a seed; leaving Pattern
  hides them.
- The panic hunt (`edit.fill` changed).

**Effort:** 2 d, unchanged.

---

## Order and shared files

- `smartselect_cmds.rs`: B14 then B16, as the spec says. B14's output move and B16's one-line hook touch different
  functions.
- `state/tool_options.rs`: B15 (polygon smooth flags), B16 (object mode and subtract) and B17 (adjustment brush).
  These are appends to one `#[serde(default)]` struct and its `Default`: line-level conflicts only.
- `engine/src/prefs.rs`: only B17 in this group.
- `dialogs.rs` `PARAM_FAMILIES`: B14 adds one line.
- B18 is independent.
- craft-libs requests to record, all for the project's owner:
  1. Select and Mask Refine Mode (Object Aware) opt-in (B14);
  2. Smooth Star Indents in `CreateShapeDialog` and smooth flags in `ShapePanel`/`ShapeChange` (B15);
  3. optionally, a colour on `StraightLinePreview` (B17).
