# REBASE-BR1: group BR1 (B9, B10, B11, B12, B13) re-checked against Pigment on PhotoCraft 057297b

Read each section beside its package in `PORTS-B.md`:
- B9: rows 22 and 35;
- B10: row 23;
- B11: row 24;
- B12: rows 25, 26 and 27;
- B13: row 28;
- and the package table in section 3.

**Where the two disagree, this file wins.** The spec's intent and its tests' intent still hold. Where this file says
nothing about a point, the spec stands as written.

**Tree checked:** `/home/user/claude/pigment` on `claude/pigment-photocraft` at `03ccb71` (`UPSTREAM-REVISION` =
`057297b`). The spec was written against abb30df. Upstream's change was compared in `/home/user/storytold/photocraft`
(`git diff abb30df 057297b`). craft-libs is pinned at `18ffc07` (`Cargo.toml:15`) and was read in the cargo checkout
`~/.cargo/git/checkouts/craft-libs-d830b991a08c6c3d/18ffc07`. Below, `CL/` means that folder's `crates/`, and paths
without a prefix are relative to `pigment/`.

The JS references are still readable with `git show claude/fervent-newton-263lz3:<path>`. The spec's short paths are
under `pigment/src/`:
- `lib/*.js` is `pigment/src/renderer/lib/*.js`;
- `shared/pixels/*.js` is `pigment/src/shared/pixels/*.js`.

The functions the spec names are all there:
- `smart-guides.js`: `spacingTargets` at 58, `distances` at 87, `spacingMarks` at 108, `drawSmartOverlay` at 118;
- `blur-gallery.js`: `bokehLuts` at 68, `addGrain` at 565;
- `lens.js`: `chromaGM` at 37 and 231;
- `filters-more-a.js`: `lineKernel` at 660, `estimateShakeKernel` at 685, `noiseConstant` at 793, `wienerDeconvolve` at 815;
- `lens-correction.js`: `ZOOMS` at 29, `TOOLS` at 65, the grid prefs at 86.

No cargo was run and nothing in the repository was changed.

## Upstream's measured documents

What `docs/target-app-parity.md`, `docs/gaps.md`, `docs/scorecard.md`, `docs/parity-checklist.md` and
`docs/ui-parity.md` say about this group:

- **Smart guides.**
  - `ui-parity.md:171`: "Smart guides (magenta alignment lines) | done".
  - `ui-parity.md:172`: "Smart guide distance and spacing labels | partial … no distances during an ordinary Move
    drag, and no spacing labels".
- **Blur Gallery.** `gaps.md:89-91` (G7, 2026-10-11, #3373): Field, Iris, Tilt-Shift and Spin Blur are edited on the
  image with Photoshop's pins and handles. Tilt-Shift has one band, and "Path Blur (#1759) is still a parameter
  dialog". No document mentions Effects, Bokeh, Motion Effects or Blur Gallery noise.
- **Lens Correction.** Only a performance line (`target-app-parity.md:573`). No document mentions a workspace, tools,
  a grid or a Green/Magenta fringe.
- **Shake Reduction.** Not in any document. It is not in `menu_catalog.rs` either. `parity-checklist.md` counts only
  the catalogue: 664 of 664, Filter 75/75.

Pigment's own page `docs/parity/README.md` lists every row of this group as still open:
- rows 169-175 (Select, Filter and View);
- row 201 ("Smart guides and measurement labels | Done | Partial: no spacing labels | B9").

Each package updates its rows there when it lands.

**Upstream built none of these rows.** One part of one row is done: row 35's third bullet (the W/H readout while
drawing a marquee or a shape). It is dropped, see B9.

## What changed for every package in this group

The general rules in `REBASE-FU.md` "What changed for every package" (framework pieces, dialogs on
`app.framework.dialogs`, menus, preferences in `config.toml`, no `unsafe`, one test binary per crate, upstream tests
must pass, engine module registration) apply here too. These points are the ones that matter for BR1:

1. **Snapping is the framework's.**
   - `crates/engine/src/snap.rs` lost 362 lines. It is now 40 lines: `layer_rect`, `target_rect_of` and `union`.
   - `SnapTargets`, `SnapLine`, `SnapKind`, `SnapOptions` and `snap_rect` are `craft::behavior::geometry::*`
     (`CL/behavior/src/geometry/snap.rs`), which has no spacing at all.
   - The canvas `Snap` (`craft::ui::canvas::Snap`, `CL/ui-canvas/src/canvas/snap.rs`) is built by
     `crates/ui-egui/src/canvas/snap_ui.rs`.
   - The lines that snapped are painted by the tool host (`CL/ui-canvas/src/canvas/tool_host.rs:615`
     `paint_smart_lines`).
   - Distances are the framework's `craft::ui::canvas_controls::{SmartGuides, SmartLine, Measure}`
     (`CL/ui-canvas/src/canvas_controls/smart_guides/mod.rs`) and `craft::draw::ui::measure::box_distances`
     (`CL/draw/src/ui/measure/distances.rs:27`).
2. **The Blur Gallery dialogs are framework `HostedParamDialog`s.**
   - Their rows come from the command's params notation (`Param::parse_list` in
     `crates/ui-egui/src/dialogs/filter_dialog.rs:279`), then `filter_dialog/rows.rs::custom_rows` (line 56).
   - For Field, Iris, Spin and Tilt-Shift, custom_rows adds the pins row (`rows.rs:64-68` → `blur_pins::blur_row`).
   - The pins themselves are `craft::imaging::ui::{BlurPins, BlurPinsPanel, BlurPinsOverlay, BlurKind}`
     (`CL/imaging/src/ui/blur_pins/`). `BlurKind` has no Path variant, and Pigment cannot add one.
   - `crates/ui-egui/src/dialogs/blur_pins.rs` is now 216 lines of glue (was ~860). It is an upstream file.
3. **Full-window workspaces** (Liquify, Adaptive Wide Angle, Vanishing Point, Camera Raw, Content-Aware Fill, Select
   and Mask, Filter Gallery) are `craft::ui::dialog::HostedWorkspace<W: FullWindowWorkspace>`
   (`CL/ui-canvas/src/canvas/full_window/hosted.rs:26`, `:174`).
   - Every one of upstream's workspaces is a framework type. Pigment has none of its own yet.
   - The trait is public. The framework's own sample implementation is `BrushWorkspace` in
     `CL/ui-canvas/src/canvas/full_window/stories.rs:105-176`.
4. **Menus.**
   - An engine `CommandSpec` with a `menu` path becomes a menu row by itself (`crates/ui-egui/src/menus/items.rs:181-188`).
   - Its place comes from `PLACE_AFTER` (`items.rs:40`) or a Pigment place hook (`ai_ui::place_after`, called at
     `items.rs:201`; REBASE-FU proposes a shared `crate::pigment_menus::place_after` beside it. Use it if group
     A or FU created it, else create it).
   - Do not add rows to `menu_catalog.rs`: it is Photoshop 2026's tree, and `parity-checklist.md` is generated from it.
5. **`FilterParams` is not stored in documents.**
   - Smart filters keep the command id and its JSON params (`crates/doc/src/lib.rs:584` `SmartFilter { command,
     params, .. }`), so a new variant or a new field never breaks a saved file.
   - Struct literals of the existing variants in upstream tests and examples do break, though. Examples:
     `crates/algo/src/gallery/tilt_shift_tests.rs:29,33,87`, `crates/algo/src/tests/ext.rs:102,699`,
     `crates/algo/examples/bench_filters2.rs:66-70`.
   - **So B10, B11 and B13 add new variants** and leave the existing ones unchanged. Details are in each package.
     `FilterParams::label` (`crates/algo/src/lib.rs:727`) and `kernel` (`lib.rs:872`) are exhaustive, so a new variant
     needs an arm in both, plus a halo (`halo`/`halo_ext`, `lib.rs:614`, `:810`).
6. **The engine's filter parameter chain** is `filters::params_for` (`crates/engine/src/filters.rs:82`) →
   `filters_ext::params_for` (`filters_ext.rs:237`) → `gallery_cmds::params_for`. The one-line Pigment hooks of
   B10, B11 and B13 go at `filters_ext.rs:239-240`.
7. **i18n.** English `tl!("…")` only. The spec's `every_tl_literal_is_translated` test no longer exists. Catalogues
   come from craft-i18n (`crates/ui-egui/src/i18n.rs` header).
8. **New engine commands and new params** must pass the panic hunt
   (`cargo test -p photocraft-engine --test panic_hunt -- --ignored`, `crates/engine/tests/panic_hunt.rs`). Clamp
   every count and length: flashes, knots, regions, trace bounds, noise size.

---

## B9: smart-guide equal spacing and measurement labels (rows 22, 35)

### 1. Status of each row now

| Row | Status | Evidence |
|---|---|---|
| 22 Equal spacing (marks and snap while moving) | **missing** | `CL/behavior/src/geometry/snap.rs` has edges, centres, guides, grid and selection targets only (`SnapKind` at 24, `snap_rect_of` at 349). Nothing in `crates/` or `CL/` computes equal gaps (the only "equal spacing" hit is in stencilcraft-document, an unrelated app). `ui-parity.md:172`: "no spacing labels". |
| 35a Distance labels to neighbours during a Move drag | **missing** | `move_distance.rs:66-80` `current()` returns `None` while a button is down, except for the ⌥-drag duplicate (`duplicate_drag`, line 83). `ui-parity.md:172`: "no distances during an ordinary Move drag". |
| 35b Labels on equal-spacing gaps | **missing** | depends on row 22 |
| 35c ⌘-hover distances, ⌥-duplicate distance | **done upstream** (not in the spec's build list; keep it) | `move_distance.rs:1-12`, tests at `:116-200` (#4946) |
| 35d W/H while drawing a marquee or shape ("Show Transformation Values") | **done upstream, dropped** | the pref is `prefs.rs:505` `show_transformation_values`, fed to the framework at `app/framework.rs:336` (`ShowReadouts`); marquee readout `CL/imaging/src/ui/select/marquee.rs`, shape drag `CL/draw/src/ui/shape_drag/tool.rs:248`, the Move tool's ΔX/ΔY `canvas/tools/move_tool.rs:291`. The spec said "check it exists before adding": it exists. |

### 2. Where things are now

| Spec names | Now | Use instead |
|---|---|---|
| `crates/engine/src/snap.rs` `SnapTargets`, `snap_rect`, `SnapLine`, `SnapKind` | moved to the framework (engine file is 40 lines) | `craft::behavior::geometry::{SnapTargets, SnapLine, SnapKind, SnapOptions}`. Pigment cannot add a `boxes` list or a `spacing()` method to `SnapTargets`. |
| `SnapTargets::from_document` | gone | `snap_ui::build` (`canvas/snap_ui.rs:105`), cached by `snap_ui::targets` (`:133`), with `SnapTargets::with_document` |
| `layer_rect` | still there (`engine/src/snap.rs:10`); targets use `target_rect_of` (`:22`, artboards and whole layers); the Move tool's box uses `snap_ui::tree_rect` (`snap_ui.rs:182`) | use `target_rect_of` for neighbour boxes, as `build` does |
| `snap_rect` "folds the spacing offset in" | the Move tool snaps in Pigment-visible code: `canvas/tools/move_tool.rs:279` `delta += cx.snap_rect(…)` inside `follow` (line 269) | the hook goes right after that line |
| `canvas/snap_ui.rs draw()`, `smart_color(app)` | gone. The tool host paints snapped lines; the colour is `snap_ui::smart_guide_color` (`snap_ui.rs:196`), handed to the host at `canvas/tools/mod.rs:699` | the spacing marks are drawn with `SmartGuides` (next row) |
| `tools/move_distance.rs` label painter, `move_distance::Overlay` | `Overlay` gone. Labels are the framework's `Measure` (`Measure::new(a, b).labelled(..)`, `smart_guides/mod.rs:57-90`), painted by `SmartGuides::new(&lines, &measures).color(..).show_at(ui, canvas)`, with the label closure at `move_distance.rs:101-108` | no `distance_label` painter to factor out: build `Measure`s and let `SmartGuides` paint them |
| "the UI draw test style of `guide_ants_tests.rs`" | no such file | `canvas/snap_ui/tests.rs` (`move_drag` at :38 returns the snapped lines through `tool_event_response`), `tools/move_distance.rs` tests (:116), and `marquee_tests.rs` (egui_kittest `Harness`) for a real frame |

### 3. The plan, adjusted

The framework will not learn equal spacing, so Pigment owns it in a new file. The move tool, snap_ui and
move_distance are upstream's files and get one-line hooks only.

**New file `crates/ui-egui/src/canvas/snap_spacing.rs`** (declared `pub(crate) mod snap_spacing;` in `canvas.rs`,
`// Pigment: smart guide spacing`). It holds:
- `pub(crate) struct SpacingMark { along: Axis, gaps: Vec<(f64, f64)>, at: f64 }`, as the spec defines it.
- `pub(crate) fn spacing(r: [f64;4], boxes: &[[f64;4]], tol: f64) -> (Option<f64>, Option<f64>, Vec<SpacingMark>)`.
  This is pure geometry, ported from `spacingTargets`/`spacingMarks`. Only neighbours that overlap `r` on the other
  axis count. It finds the offset per axis that makes the gap on one side equal the gap on the other, or equal an
  existing gap between two other boxes on that axis.
- `fn boxes(app, idx) -> Arc<Vec<[f64;4]>>`. These are the visible layers' `target_rect_of` without the moving set,
  as `snap_ui::build` makes them (`snap_ui.rs:112-118`). Cache them under the same key `snap_ui::targets` uses
  (document, revision, exclude), so a large document does not walk its layers every pass.
- `pub(crate) fn follow(app, box_at_delta: kurbo::Rect, delta: Vec2, mods, view) -> Vec2`. It runs only when
  `options.on && options.smart_guides && options.layers` and Ctrl does not suspend snapping. Take the tolerance from
  `craft::ui::canvas::snap_tolerance(&view, mods, os, false)` (`CL/ui-canvas/src/canvas/snap.rs:158`): `ToolContext`
  has no getter for it.
  - Per axis, it replaces the alignment offset when the spacing candidate is closer than the alignment snap (or the
    alignment did not snap on that axis).
  - It stores the marks for the overlay in `app.snap_spacing` (the field described below).
- `pub(crate) fn show(app, ui, canvas)`. While the Move tool drags (`app.canvas_tools.mover.dragged_box()`,
  `move_tool.rs:92`) with Smart Guides on, it shows:
  - (row 35a) `box_distances(moving, nearest)` to the nearest neighbour box on each axis, falling back to the canvas
    edges as `move_distance::boxes` does;
  - (rows 22, 35b) one `Measure` per equal gap, labelled with the gap in the ruler unit. Copy the 8-line label closure
    of `move_distance.rs:101-108`; do not edit upstream's.

  It paints everything through `SmartGuides` with `snap_ui::smart_guide_color(app)`, as `move_distance::show` does.

**Hooks into upstream files** (each `// Pigment: smart guide spacing`, each listed in FORK.md):
- `canvas/tools/move_tool.rs:279`: after `delta += cx.snap_rect(…)`, add
  `delta = crate::snap_spacing::follow(app, moved_box, delta, pointer.mods, space.view);`.
- `canvas/snap_ui.rs`: make `moving_set` and `options` `pub(crate)` (lines 58, 81). That is two visibility words;
  the spacing boxes must exclude exactly what the snap targets exclude.
- `canvas/document_display.rs:535`: `crate::snap_spacing::show(app, ui, rect);` right after
  `crate::move_distance::show(app, ui, rect, pointer);`.
- `lib.rs` (the `PhotocraftApp` field `snap_spacing: canvas::snap_spacing::State`) and `app.rs` (its `Default`). The
  marks cannot ride on `MoveTool`'s private `Run`, which is upstream's.

**Tests** (unit tests in `snap_spacing.rs`, app tests modelled on `canvas/snap_ui/tests.rs`):
- the spec's geometry case: boxes at x 0–10 and 30–40, and a 10-wide box near 55 → offset to 60–70 with 2 gap marks;
- no spacing when the boxes don't overlap on y;
- (row 35a) a Move drag that leaves the mover 12 px right of the target makes a measure labelled "12 px";
- (row 35b) the spacing measures of an equal-gap snap carry equal labels;
- with Smart Guides off, or Extras off, no marks, no labels and no spacing snap. Alignment snapping is unchanged:
  the existing `snap_ui` tests and `move_distance` tests pass untouched;
- (spacing snap through the real tool) `tool_event_response` drag ends with the layer at the equal-gap position
  (`mover_bounds`, as `snap_ui/tests.rs:24`).

**Docs.**
- `docs/parity/README.md` rows 169 and 201.
- FORK.md hooks.
- `docs/ui-parity.md:172` is upstream's, so leave it. Pigment's parity page carries the change.

**Effort: 1.5 d** (unchanged). The W/H readout is already there. The framework split adds hook and cache work in
place of it.

---

## B10: Blur Gallery Effects (Bokeh), Motion Effects (strobe) and Noise (row 23)

### 1. Status of the row now

| Part | Status | Evidence |
|---|---|---|
| Effects: Light Bokeh, Bokeh Color, Light Range (Field/Iris/Tilt-Shift) | **missing** | the variants `crates/algo/src/lib.rs:526-545` carry only blur geometry; `crates/algo/src/gallery.rs` (403 lines) has no bokeh; specs `filters_ext.rs:829-858` have no such key |
| Motion Effects: Strobe Strength, Flashes, Flash Duration (Spin/Path) | **missing** | `gallery.rs:271` `spin`, `:340` `path`: no strobe |
| Noise: Uniform/Gaussian/Grain, Amount, Size, Roughness, Color, Highlights | **missing** | none in `gallery.rs`; the Blur Gallery dialogs show only the pins row and the notation's sliders |

Upstream's G7 work (#3373) put the pins on the image. It added no effects.

### 2. Where things are now

| Spec names | Now |
|---|---|
| `FilterParams::TiltShift/IrisBlur/FieldBlur/SpinBlur/PathBlur` (`lib.rs:524-545`) | same lines (526-545) |
| match arms `lib.rs:785, 839, 1046` | `label` 781-785, `halo_ext` 836-839, `kernel` 1040-1046 (Spin is `Halo::Bounds`, `lib.rs:825`) |
| `crates/algo/src/gallery.rs` | there. It already has a `gallery/` folder (`spin_plan.rs`, `tests.rs`, `tilt_shift_tests.rs`), so a `gallery/effects.rs` child module fits. As a child it may call the parent's private helpers (`sigma_of`, `pin_distance`, `short_side`, `variable_blur`, `fxutil::*`). |
| specs `filters_ext.rs:829-858`, parsers `:214-220` | same; the parsers are `tilt_shift` (385), `iris_blur` (397), the Field closure (216), `spin_blur` (420), `path_blur` (444); all go through `params_for` (237) |
| `crates/ui-egui/src/dialogs/blur_pins.rs`'s panel | rewritten. The "panel" is the framework's `BlurPinsPanel` inside a `Param::custom` row (`blur_pins.rs:156` `blur_row`) of the `HostedParamDialog`. Other rows come from the spec notation. Pigment's place for extra rows is the blur gallery arm of `filter_dialog/rows.rs:64-68`. |
| proxy previews | `filter_dialog.rs:1182-1185` calls `blur_pins::scale_for_proxy` for every `filter.blurGallery.*` command (it scales `pins[].blur` only) |
| PSD: "check `crates/io` smart filter mapping for `blurbTransform`" | there is none. The PSD smart-filter map (`crates/io/src/smart_map.rs`, `smart_map/{import,export}.rs`) maps no Blur Gallery or Lens Correction filter, and PSD export warns and omits unmapped live filters (`docs/smart-filters.md:38`). So the new params are Pigment-native only, as the spec says. Nothing to map. |

### 3. The plan, adjusted

**Algo: a wrapper variant, not a new field on five variants.** Adding `effects` to the five variants breaks upstream
struct literals in tests and examples (see "What changed", 5). Instead:
- `FilterParams::GalleryFx(Box<GalleryFx>)` with `pub struct GalleryFx { pub blur: FilterParams, pub effects:
  GalleryEffects }`, in the new `crates/algo/src/gallery/effects.rs`. `GalleryEffects { bokeh, strobe, noise }` is
  as the spec defines it, serde default all off.
- **The engine builds the wrapper only when some effect is on.** With every effect off, the parser returns the plain
  variant, so today's output, tests and benches stay byte-identical.
- Arms in `lib.rs`:
  - `label` (727): `GalleryFx(fx) => fx.blur.label()`;
  - `kernel` (872): `GalleryFx(fx) => gallery::effects::run(src, out, ctx, fx)`;
  - `halo_ext` (810): the inner blur's halo, plus the strobe reach for Path; Spin stays `Halo::Bounds`.
  - `gallery.rs`: one line, `mod effects;`, plus `pub use` of the types from `lib.rs` beside `IrisPin`'s.
- `effects::run`:
  1. bokeh boost of the source window (port `bokehLuts`: gain and saturation by luminance in the light range);
  2. `kernel(&fx.blur, &boosted, out, ctx)`;
  3. strobe for Spin/Path (blend `flashes` sharp offsets over the duration arc);
  4. noise.
- **Noise must not depend on the tiling.** Blur Gallery filters run in tiles (`apply_tiled_with_impl`), so a
  sequential RNG would seam. Hash `(seed, x, y)` in document coordinates for every noise sample, value noise
  included.
- **Noise strength follows the local blur amount**, as the spec says. Compute that map in `effects.rs` from the same
  geometry the parent uses:
  - Tilt-Shift: the band `smoothstep` of `gallery.rs:155-158`;
  - Iris: `pin_distance` and the feather;
  - Field: the inverse-distance mix of `:257-269`;
  - Spin: inside the ellipses;
  - Path: the speed.

  Do this by calling the private helpers, not by changing upstream's functions.

**Engine.**
- **The keys are flat**, not the spec's nested `"bokeh":{…}` objects. The generic dialog makes a row per key
  (`Param::parse_list`), so a flat key gets a slider, a remembered value and `ui.dialog.set` automation for free; a
  nested object would need custom JSON rows. The keys:
  - `bokehLight` 0..100, `bokehColor` 0..100, `lightRangeLow` 0..255=191, `lightRangeHigh` 0..255=255 (Field,
    Iris, Tilt-Shift);
  - `strobeStrength` 0..100, `strobeFlashes` 1..100=2, `strobeDuration` 1..360=10 (Spin, Path);
  - `noiseType` `uniform|gaussian|grain`, `noiseAmount` 0..100, `noiseSize` 0..100, `noiseRoughness` 0..100,
    `noiseColor` 0..100, `noiseHighlights` 0..100, `monochromatic` bool, `seed` u32 (all five).

  Also accept the spec's nested objects in the parser, for scripts written against the spec.
- Append these keys to the five notation strings in `filters_ext.rs:829-858`. That is an upstream-line change of five
  strings, listed in FORK.md.
- A new Pigment file `crates/engine/src/gallery_fx_params.rs`, declared in `engine/src/lib.rs`, or put it at
  `crates/engine/src/cmd/gallery_fx_cmds.rs` and declare it in `cmd.rs`. It holds
  `pub(crate) fn wrap(id, base: FilterParams, p: &Value) -> FilterParams`, which clamps every value
  (flashes 1..100, size 0..100) for the panic hunt.
- The one hook: `filters_ext.rs:239` becomes `Some((_, build)) => Some(crate::…::wrap(id, build(p), p)),`.

**UI** (no framework change; the rows are the notation's):
- In `filter_dialog/rows.rs:64-68`, the blur gallery arm, after `params.push(blur_row(..))`, add one line:
  `crate::gallery_fx_ui::arrange(command, params);`. New file `crates/ui-egui/src/dialogs/gallery_fx_ui.rs`.
- `arrange`:
  - moves the effect rows after the pins row;
  - puts `Param::section` headers "Effects", "Motion Effects" and "Noise" before them
    (`CL/ui-patterns/src/patterns/form_dialogs/param.rs:681`);
  - relabels them with Photoshop's words through `tl!`: Light Bokeh, Bokeh Color, Light Range, Strobe Strength,
    Strobe Flashes, Strobe Flash Duration, Amount, Size, Roughness, Color, Highlights;
  - shows Light Range as one row only if you build a `Param::custom` two-thumb slider; two number rows are acceptable;
  - uses `Param::visible_when("noiseType", …)` where a field applies to one noise type only.
- Proxy preview:
  - `noiseSize` is a pixel feature. Scale it by 1/k in `blur_pins::scale_for_proxy` (`blur_pins.rs:204`, one line,
    upstream file), or have `arrange`'s module provide `scale_for_proxy` and call it at `filter_dialog.rs:1184` beside
    upstream's.
  - Grain previews at reduced size look coarser. That is acceptable: the spec asks nothing more, and the Field
    preview already runs on a proxy.

**Tests.**
- algo, in `crates/algo/src/gallery/effects.rs`'s test module:
  - bokeh light 100 on a dark image with one bright dot makes the blurred dot's peak brighter than without;
  - effects all off: `GalleryFx` output equals the plain variant's, bit for bit;
  - noise amount 0 is identical to the old output;
  - a fixed seed is deterministic;
  - **tiled equals untiled** with noise on (apply with a small tile and with one tile, compare);
  - a 3-flash strobe on a point source shows 3 peaks along the arc.
- engine (`crates/engine/src/filters_ext/tests.rs` style, or the new module's tests):
  - the params round trip through the journal and a smart filter;
  - nested and flat forms parse alike;
  - a call without effect keys returns the plain variant.
- ui: the Iris dialog's rows include "Light Bokeh" after the pins row; `ui.dialog.set` of `noiseAmount` reaches the
  command's params on OK (pattern: `blur_pins_tests.rs:35`).
- the panic hunt.

**Effort: 2 d** (unchanged; the wrapper replaces the arm updates).

---

## B11: Path Blur on the image (row 24)

### 1. Status of the row now

| Part | Status | Evidence |
|---|---|---|
| Path editing on the canvas (anchors, curve handles, multiple paths) | **missing** | `gaps.md:90-91`: "Path Blur (#1759) is still a parameter dialog"; `blur_pins::kind_of` (`blur_pins.rs:33-41`) covers Field, Iris, Spin and Tilt-Shift only; `CL/imaging/src/ui/blur_pins/model.rs:23` `BlurKind` has no Path |
| Speed, Taper | **done** | `params_ext.rs:277-289` `BlurPath { points, speed, taper }`; `gallery.rs:340` |
| Centered Blur | **partly done** | `gallery.rs:384-386` already samples symmetrically (−len/2..+len/2), which is Photoshop's Centered Blur **on**. There is no off. |
| End Point Speed, Edit Blur Shapes, Basic/Rear Sync Flash, curves | **missing** | none in `BlurPath` or `gallery.rs` |

### 2. Where things are now

| Spec names | Now |
|---|---|
| `BlurPath` (`params_ext.rs:277`) | same place, same fields. Struct literals in upstream tests (`crates/algo/src/tests/ext.rs:102`, `:699`) and in `filters_ext.rs:455` would break on a new field. |
| `gallery.rs path` | `gallery.rs:340-399` |
| `pathBlur` notation | `filters_ext.rs:853-857`, parser `:444-461` (clamps speed to 0..500, #708) |
| path editing "in `blur_pins.rs`" | not there: `blur_pins.rs` is upstream glue around the framework's pins, which cannot edit paths. Pigment needs its own canvas control. |
| "dialog fields `paths`, as pins are today" | still right: the pins live in the `HostedParamDialog`'s fields (`blur_pins.rs:146` `write_pins`), and the overlay writes them with `dialog.set_field` (`:189-198`). Path Blur does the same with `paths`. |

The framework pieces to model on:
- **The overlay.** `BlurPinsOverlay` is an interactive canvas control: a `Component` with parts, `canvas_space`, and
  `PaintShape` drawing (`CL/imaging/src/ui/blur_pins/overlay.rs`, 605 lines; parts at 389, paint at 446). Pigment's
  own canvas controls (paint-only) show how a Pigment `Component` is declared:
  `crates/ui-egui/src/tools/analysis/canvas.rs:466-505` (`CountMarks`, `#[component(canvas_control)]`) and
  `canvas/tile_overlay.rs:196`.
- **The row** passes canvas presses through the modal dialog with `cx.pass_canvas_gesture(canvas,
  CanvasGesture::PRIMARY)`, as `BlurPinsPanel` does (`CL/imaging/src/ui/blur_pins/panel.rs:58`).

### 3. The plan, adjusted

**Algo: extras ride on B10's wrapper.** Do not add fields to `BlurPath` or to `FilterParams::PathBlur`.
- Give `GalleryFx` (B10) a `path: Option<PathExtras>`. It holds `centered: bool` (default **true**, today's output),
  `mode: Basic|RearSyncFlash`, and per path `knots: Vec<Knot{anchor, in, out}>`, `end_speeds: [f32;2]` and
  `end_shapes: [[f32;2];2]`.
- The per-path extras are read from the same `paths` JSON objects (`knots`, `endSpeeds`, `endShapes`). `BlurPath`'s
  serde ignores unknown keys, so `list::<BlurPath>` keeps reading the base.
- `gallery/path_fx.rs` (a child of `gallery`, beside B10's `effects.rs`) runs the extended path blur:
  - a knot path is flattened to a polyline;
  - the direction blends toward the end shapes near the ends;
  - the speed is interpolated between the end speeds;
  - non-centred samples run 0..len behind the pixel;
  - Rear Sync Flash weights the end sample.

  With no extras, the parser returns plain `PathBlur`, which is byte-identical to today's.
- Halo, in the `GalleryFx` arm: the maximum of the speeds and end speeds. That is the full length when not centred,
  half when centred, +1.
- Clamp knot counts (for example 64 per path, 16 paths) and the speeds (0..500, as #708) in the engine.

**Engine.**
- Add `"centered":bool=true,"mode":"basic|rearSyncFlash"="basic"` to the pathBlur notation (`filters_ext.rs:856`).
- Document `knots`, `endSpeeds` and `endShapes` in the `paths` objects.
- B10's `wrap` reads them. No further hook.

**UI.**
- New file `crates/ui-egui/src/dialogs/path_blur_ui.rs` with:
  - `PathBlurOverlay`: a Pigment `Component`, `#[component(canvas_control)]`, interactive, after `BlurPinsOverlay`.
    - A click adds an anchor, a drag makes handles, a double-click ends the path, and ⌥-click toggles a corner.
    - End arrows drag the end speed.
    - Red shape arrows show and drag while Edit Blur Shapes is checked.
  - `path_row(bounds)`: a `Param::custom("paths", …)` row with Centered Blur, Basic/Rear Sync Flash and Edit Blur
    Shapes (`craft::ui::choice::Checkbox`, `craft::ui::pickers::Select`), the selected path's Speed and Taper, and the
    `pass_canvas_gesture` call;
  - `overlay(app, ui, rect)`, mirroring `blur_pins::overlay` (`blur_pins.rs:182-198`), for the top
    `filter.blurGallery.pathBlur` dialog;
  - `scale_for_proxy(params, k)`: scale `paths[].speed` and `endSpeeds` by 1/k. Today the per-path speeds inside
    `paths` are **not** scaled for the proxy preview: `is_pixel_param` scales only the flat `speed`, and
    `blur_pins::scale_for_proxy` only `pins[].blur`.
- Hooks (each `// Pigment: Path Blur`):
  - `filter_dialog/rows.rs:64`: an arm `crate::path_blur_ui::PATH => params.push(crate::path_blur_ui::path_row(..))`
    before the `blur_pins::handles` arm;
  - `canvas/document_display.rs:517`: `crate::path_blur_ui::overlay(app, ui, rect);` after `blur_pins::overlay`;
  - `dialogs/filter_preview_ui.rs:138`: `&& !crate::path_blur_ui::handles(key)`. The image is the overlay's, not the
    preview locator's, as for the pins;
  - `filter_dialog.rs:1184`: call `path_blur_ui::scale_for_proxy` beside `blur_pins::scale_for_proxy`;
  - `dialogs.rs`: `pub mod path_blur_ui;` beside `pub mod blur_pins;` (line 699).

**Tests.**
- algo:
  - a straight path with no extras equals today's output (back-compat);
  - centred vs not shifts the centroid by about len/2;
  - end speed 0 at one end tapers the blur to zero there;
  - a 2-knot curve with zero handles equals the polyline.
- ui (an egui_kittest `Harness` as in `marquee_tests.rs:14-80`, with the dialog opened by
  `app.run("filter.blurGallery.pathBlur", json!({}))`'s menu path): click, click, double-click on the canvas makes a
  2-knot path in the dialog's `paths` field.
- ui unit: `path_row` writes what the engine takes (as `blur_pins_tests.rs:35`), and OK journals
  `filter.blurGallery.pathBlur` with `paths`.
- the proxy scaling test: speeds halve at k = 2.
- the panic hunt (knots and speeds hostile).

**Docs.** `docs/parity/README.md:171`; FORK.md hooks. Upstream's `gaps.md:90` stays upstream's.

**Effort: 2.5 d** (was 2 d). The framework pins cannot be reused for paths, so the interactive overlay is Pigment's
own `Component`.

---

## B12: Lens Correction workspace, Custom tab, grid (rows 25, 26, 27)

### 1. Status of each row now

| Row | Status | Evidence |
|---|---|---|
| 25 Tools: Remove Distortion, Straighten, Move Grid, Hand, Zoom | **missing** | `filter.lensCorrection` opens the generic `HostedParamDialog` through `dialogs.rs:590` `open_command_dialog`. The only special cases are `filter_dialog.rs:65` (its `horizontal`/`vertical` aren't pixel params) and its tests (`filter_dialog/tests.rs:150`, `:1072`). There is no lens entry among the workspaces (`dialogs.rs:440-470` `take` list, `control/dialogs.rs:467-475` `DESCRIBE`). The engine's `straighten` param and `lens::straighten_angle` are there (`lens_cmds.rs:69-75`, `algo/src/lens.rs:269`). |
| 26 Fix Green/Magenta Fringe | **missing** | `algo/src/lens.rs:99-101` has `red_cyan` and `blue_yellow` only, applied at `:187-188`; `LENS_DOC` (`lens_cmds.rs:453`) has no `greenMagenta` |
| 27 Preview, Show Grid, grid Size and Color | **partly done** | preview yes (generic dialog preview); no grid |

### 2. Where things are now

| Spec names | Now |
|---|---|
| `crates/engine/src/cmd/lens_cmds.rs`, `LENS_DOC` l.451 | `lens_cmds.rs:453`; `pub fn lens_params(cmd, p, frame, info)` at :44 (public, so the workspace can build a `LensCorrection` for its preview); `LENS` const at :24 |
| `dialogs/edit_history.rs:201 open_command_dialog` | moved to `crates/ui-egui/src/dialogs.rs:590` |
| `liquify_ui.rs`, `camera_raw_ui.rs` as the model | still Pigment-side adapters, but around framework workspaces (`LiquifyWorkspace`, `RawDevelopWorkspace`). The closest model is `dialogs/wide_angle_ui.rs`: proxy ≤ 800 px (`open` at :232), preview `Job`, `take` at :215 running the command on OK, `menu` at :277 (opens with empty params, else runs), `describe` at :203. |
| "the existing filter preview worker" | `dialogs/filter_preview_worker.rs` exists, but a workspace previews on its own proxy, as wide_angle_ui does (`preview_surface`, :55) |
| `algo/src/lens.rs:99-101, 187-188`, `straighten_angle` `lens.rs:259` | 99-101 and 187-188 unchanged; `straighten_angle` is at :269 |
| "remembered in UI prefs, `LensCorrectionUi` in `prefs.rs`" | use `Preferences.dialogs` (`engine/src/prefs.rs:1600`, a JSON map) under a key, as the Histogram panel does (`panels/histogram_panel.rs:34` `OPTIONS_PREF`, `:157` persist, `:166` restore). That needs no new `Preferences` section and no validation or scorecard change. |

The framework pieces Pigment's own workspace uses (no framework Lens Correction exists):
- **The workspace and its dialog shell.** `craft::ui::dialog::{FullWindowWorkspace, WorkspaceCx, WorkspacePass,
  HostedWorkspace, FullWindowDialog, FullWindowSide, FullWindowCanvas, FullWindowView, FullWindowZoomBar,
  FieldRefusal, serde_fields, set_serde_field}`. The sample implementation to copy is `BrushWorkspace`
  (`CL/ui-canvas/src/canvas/full_window/stories.rs:105-176`: `show`, `json_fields`, `set_json_field`, `confirm`,
  `ok_failed`). The import list is `CL/imaging/src/ui/wide_angle/mod.rs:39-55`.
- **The tool strip.** `craft::ui::rails::{ToolRail, ToolSlot, LastUsed, RailTool}`, as Wide Angle and Liquify use it
  (`CL/imaging/src/ui/liquify/mod.rs:444`).
- **Tools on the canvas.**
  - `FullWindowCanvas::tool(&mut dyn CanvasTool)` (`CL/ui-canvas/src/canvas/full_window_parts/canvas.rs:181`).
  - `craft::ui::canvas::{HandTool, ZoomTool, NavigationOptions, ToolHost}`.
  - A line-drawing `CanvasTool` to copy for Straighten: Wide Angle's `ConstraintTool`
    (`CL/imaging/src/ui/wide_angle/tool.rs:67`).
  - Shortcuts as a `CommandSet` scope (`FullWindowDialog::command_scope`, as `LiquifyCommands::SCOPE`).
- **The grid.** `craft::ui::canvas_controls::CanvasGrid` (`CL/ui-canvas/src/canvas_controls/grid/mod.rs:94`), drawn
  from `FullWindowCanvas::controls(|ui, rect| …)` (`canvas.rs:194`), offset by Move Grid.
- **Tabs and fields.** `craft::ui::tabs::{Tab, TabKind, TabStrip}` (example `panels/variables_ui.rs:395-406`),
  `craft::ui::form::SliderField`, `craft::ui::choice::{Checkbox, Swatch}`, `craft::ui::pickers::Select`.
- **The colour.** A `Swatch` that opens the app's colour picker through an event the Pigment adapter answers, as
  `AdjustAsk::PickColor` does in group A.

### 3. The plan, adjusted

**Algo (row 26).**
- Add `LensCorrection.green_magenta: f64` (default 0) in `algo/src/lens.rs`, applied at :187-188 as the spec says:
  `- lc.green_magenta * 4e-5` on both `ca_r` and `ca_b`.
- Every other construction uses `..Default::default()` or `..lc` (checked: `lens.rs:237, 532, 534, 562`,
  `lens_auto_scale_tests.rs:36, 108`), so no upstream literal breaks.
- Note that JS (`lens.js:231`) scaled green itself. The spec's form is equivalent relative to green and keeps green
  as the reference. Keep the spec's.

**Engine (row 26).**
- `green_magenta: num(p, "greenMagenta", 0.0).clamp(-100.0, 100.0)` in `lens_params` (`lens_cmds.rs:50`).
- Add `"greenMagenta":-100..100=0` to `LENS_DOC` (:453).
- `resolved_lens_params` keeps it as is.
- These are hooks in an upstream file (two lines); list them.

**UI: new file `crates/ui-egui/src/dialogs/lens_correction_ui.rs`** (and `lens_correction_ui/tests.rs`):
- `LensCorrectionWorkspace: FullWindowWorkspace` with `KEY = "filter.lensCorrection"`, `Source = dyn RasterSource
  + Send + Sync`, `Event = LensEvent` (preview wanted, colour pick wanted), and `Result = Value`, the command params.
  - Left: a `ToolRail` with Remove Distortion, Straighten, Move Grid, Hand and Zoom, plus `FullWindowZoomBar`.
  - Centre: `FullWindowCanvas` over the corrected proxy, with the active tool and a `CanvasGrid` control.
  - Right: a `FullWindowSide` with a `TabStrip`. The Auto Correction tab holds `profile`, `focalLength`, the three
    `correct*` toggles, `autoScale` and `edge`. The Custom tab holds `distortion`, `redCyan`, `greenMagenta`,
    `blueYellow`, `vignetteAmount`, `vignetteMidpoint`, `vertical`, `horizontal`, `angle` and `scale`.
  - Footer: Preview, Show Grid, Size (8–512 px), Color.
  - `json_fields`/`set_json_field` (use `serde_fields`/`set_serde_field`) expose every field and `grid`, `gridSize`
    and `gridColor`, so automation drives it through `control::dialogs::workspace_ui` (`control/dialogs.rs:509`).
- The tools (`CanvasTool`s in the same file):
  - **Remove Distortion:** a drag toward or away from the centre sets `distortion`, ±100 over half the preview.
  - **Straighten:** a line drag sets `angle += photocraft_algo::lens::straighten_angle(a, b)` in document pixels.
    Copy `ConstraintTool`.
  - **Move Grid:** offsets the grid.
  - **Hand / Zoom:** the framework's `HandTool`/`ZoomTool`, with Space and ⌥ as usual.
- The adapter, after `wide_angle_ui.rs`:
  - `open(app, ctx)`:
    - proxy ≤ 800 px;
    - `PcLensSource: RasterSource` whose preview job runs `lens::correct(proxy, proxy_frame,
      &lens_params(LENS, &fields, proxy_frame, exif))`. The distortion and CA terms are relative to the frame, so a
      proxy shows the same geometry;
    - it restores `grid`, `gridSize` and `gridColor` from `Preferences.dialogs["lensCorrection"]`.
  - `take`: on OK, `app.run(LENS, with_filter_target(params, target))`, as `wide_angle_ui::take` (:215-230); on any
    close, persist the grid prefs.
  - `menu`: an empty-params `filter.lensCorrection` opens the workspace, and one with params runs directly, as
    `wide_angle_ui::menu_with_workspace_request` (:285-302). Scripts, MCP and Actions keep running the command with
    no dialog.
  - `describe`.
- Hooks (each `// Pigment: Lens Correction workspace`):
  - `dialogs.rs`: `pub mod lens_correction_ui;` and `lens_correction_ui::take` in the take list (after
    `wide_angle_ui::take`, :453);
  - `menus/invoke.rs:234`: `if let Some(r) = crate::lens_correction_ui::menu(app, ctx, id, params) { return Some(r); }`
    beside wide_angle_ui's;
  - `control/dialogs.rs:473`: `(photocraft_engine::lens_cmds::LENS, crate::lens_correction_ui::describe),` in
    `DESCRIBE`;
  - `lib.rs` and `app.rs`: a `PhotocraftApp` field `lens_correction: Option<lens_correction_ui::LensApp>` (as
    `wide_angle`, `lib.rs:560`).
- **Check the upstream tests that open `filter.lensCorrection`'s generic dialog.** `filter_dialog/tests.rs:150` lists
  it among dialog commands, and `:1072` previews `{"vertical":-100,"horizontal":60}`. Both pass params or use the
  param path. If one opens the dialog by menu with empty params, keep that path for it (for example
  `open_command_dialog` still works when called directly) rather than editing the test. If an upstream test must
  change, name it in FORK.md.

**Tests** (`lens_correction_ui/tests.rs`; workspace access as `camera_raw_ui/tests.rs:30`
`app.framework.dialogs.get::<HostedWorkspace<…>>()`):
- the Straighten tool given a 10° drag sets `angle ≈ −10`;
- a distortion drag outward vs inward gives opposite signs;
- OK journals `filter.lensCorrection` with the fields (the last history entry's params), as one history step;
- the grid toggles on, and `gridSize` persists across a close and reopen (`Preferences.dialogs`);
- `ui.dialog.set`/`workspace_ui` sets `greenMagenta` and it reaches the params;
- `filter.lensCorrection` with params still runs without opening anything.
- algo (row 26): G/M +50 shifts red and blue edges outward relative to green by the same amount as R/C −50 with B/Y
  −50; 0 is identity (beside `lens.rs:548`).
- the panic hunt (a changed engine command).

**Docs.** `docs/parity/README.md:172-174`; FORK.md hooks. User guide: the Lens Correction page, if `docs/user` has one.

**Effort: 3 d** (was 2 d). Pigment implements its first `FullWindowWorkspace` itself (shell, tools, tabs,
automation fields). Row 26 is still S.

---

## B13: Shake Reduction (row 28)

### 1. Status of the row now

| Part | Status | Evidence |
|---|---|---|
| Filter › Sharpen › Shake Reduction (kernel estimate, Wiener deconvolution, smoothing, artifact suppression, regions) | **missing** | no `shake` anywhere in `crates/` (the only hits are `ServerHandshake`); not in `menu_catalog.rs:627-631` (Sharpen, Sharpen Edges, Sharpen More, Smart Sharpen, Unsharp Mask); not in any upstream document. Adobe dropped the filter, so upstream's Photoshop 2026 catalogue will not grow it. |

### 2. Where things are now

| Spec names | Now |
|---|---|
| new `crates/algo/src/sharpen/shake.rs` | `crates/algo/src/sharpen.rs` is a module file with a `sharpen/` folder (`exact.rs`, `fft.rs`, `reference.rs`, `tests.rs`), so `sharpen/shake.rs` fits with one `pub(crate) mod shake;` line in `sharpen.rs` |
| `rustfft` "used by `blur/motion_fft.rs`" | `crates/algo/Cargo.toml:18` `rustfft = "6.4.1"`; also used by `sharpen/fft.rs` |
| `FilterParams::ShakeReduction` in `algo/src/lib.rs` | to add. The precedent for a whole-image filter that must see the whole region at once, with cancellation, is `checked_native_filter` (`lib.rs:1191-1212`: `HdrToning`, `Percentile`, `ChannelNoise` and `Convolution` are tuple variants with an options struct, routed there to `<module>::apply_with(surface, options, area, domain, selection, ctl)`; signature example `channel_noise.rs:92`). |
| `crates/engine/src/filters.rs` `filter_cmd!` "like the sharpen ones at l.480", parse at l.106 | `filters.rs:480-482` and `:106`. `filter_cmd!` takes a literal notation string; `run_filter` (:269) and `has_filterable_layer` (:245) are `pub(crate)`. The parameter chain ends at `filters_ext.rs:240`. |
| menu row in `menu_catalog.rs` | **do not add** ("What changed", 4). The spec's `["Filter","Sharpen"]` menu path makes the row. Place it with the Pigment place hook. Photoshop listed Shake Reduction **first** in Sharpen; the menu builder can only place after an item. So place it after `filter.sharpen.sharpenMore`, as the spec says, and record that choice in the hand-off note. |
| "the generic filter dialog first" | the generic `HostedParamDialog` from the notation, as for Unsharp Mask. Custom rows go in `filter_dialog/rows.rs::custom_rows` (:56). |

### 3. The plan, adjusted

**Algo.**
- New `crates/algo/src/sharpen/shake.rs` with:
  - `pub struct ShakeOptions { trace_bounds, source_noise: Auto|Low|Medium|High, smoothing, artifact_suppression,
    regions: Vec<ShakeRegion{rect, bounds}> }`;
  - `estimate_kernel(img, rect, trace_bounds) -> Option<Kernel>` (the cepstrum of the sharpest tile ≤ 512 px, on
    rustfft; port `estimateShakeKernel`);
  - `wiener(img, rect, &kernel, k)`, `smooth`, `suppress_artifacts`;
  - `pub fn apply_with(surface, &ShakeOptions, area, domain, selection, ctl) -> Result<Surface, Error>`.
- The kernel is estimated **once per apply** over the domain. Deconvolve in overlapping tiles (about 512 px plus the
  kernel margin, windowed), so a 24 MP image does not need one whole-image FFT.
- `ctl.check()` between tiles.
- Each region gets its own kernel, blended by inverse distance to the region centres, as the spec says.
- `lib.rs`:
  - the variant `ShakeReduction(sharpen::shake::ShakeOptions)`;
  - `halo` → `Halo::Bounds` (add it beside `ChannelNoise`/`Convolution` at `lib.rs:650-652`);
  - `label` → "Shake Reduction";
  - `kernel` → `src.crop(out)` (unreachable, as for the other checked native filters);
  - `checked_native_filter` → `FilterParams::ShakeReduction(o) => sharpen::shake::apply_with(..).map_err(ApplyError::Native)`;
  - `working_bytes` (:1233) must admit the FFT buffers. The `Halo::Bounds` branch already counts the whole domain;
    add the per-tile complex buffers.

**Engine.**
- New Pigment module `crates/engine/src/cmd/shake_cmds.rs`. It holds `ID = "filter.sharpen.shakeReduction"`, its
  `CommandSpec`, and `params_for(id, p)`.
  - The `CommandSpec`: `label "Shake Reduction…"`, `menu &["Filter","Sharpen"]`, the notation
    `{"traceBounds":10..199=41,"sourceNoise":"auto|low|medium|high"="auto","smoothing":0..100=30,"artifactSuppression":0..100=30,"regions":json?}`,
    `enabled: crate::filters::has_filterable_layer`, `run: |s, p| crate::filters::run_filter(s, ID, p)`,
    `journal: true`.
  - `params_for` clamps everything: at most 8 regions, rects inside the canvas, bounds 10..199. A bad type is
    `BadParams`, for the panic hunt.
- Hooks (`// Pigment: Shake Reduction`):
  - `cmd.rs`: `pub mod shake_cmds;` beside `pub mod lens_cmds;` (:126), and `v.extend(crate::cmd::shake_cmds::specs());`
    beside the AI line (:1475);
  - `filters_ext.rs:240`: `None => crate::gallery_cmds::params_for(id, p).or_else(|| crate::cmd::shake_cmds::params_for(id, p)),`
    (the same `match` as B10's hook).
- Smart filter: the params serialise with the filter. Nothing extra.

**UI.**
- The generic dialog comes for free from the notation.
- `filter_dialog.rs:84` `FULL_RESOLUTION_PREVIEW`: add `"filter.sharpen.shakeReduction", // Pigment: Shake Reduction`.
  It is a sharpening filter, previewed at full resolution for the same reason as #3929. A proxy would also shrink the
  traces below `traceBounds`.
- Menu placement: one line in the Pigment place table (`("filter.sharpen.shakeReduction", "filter.sharpen.sharpenMore")`).
- The kernel trace preview (a small image of the estimated kernel) is a `Param::custom` row added by one arm in
  `filter_dialog/rows.rs::custom_rows`, `crate::shake_ui::rows(app, params)`, in a new
  `crates/ui-egui/src/dialogs/shake_ui.rs`.
  - It runs `estimate_kernel` on the selection's (or the canvas's) sharpest 512 px tile when `traceBounds` changes.
    Cache it by document revision and `traceBounds`, because it runs in the dialog's pass.
- The region rectangles on the image (click-drag adds a region) are the spec's in-package follow-up. They need their
  own canvas control, as B11's. Do them only if time allows, and say so in the hand-off note.

**Tests.**
- algo (`sharpen/shake.rs` tests):
  - a synthetic edge image blurred with a 15 px horizontal line kernel → the estimate finds length 15 ± 2 and
    angle 0 ± 5°;
  - the deconvolved MSE against the original is lower than the blurred MSE;
  - a sharp image comes back unchanged (`detected = false`);
  - determinism;
  - cancellation stops between tiles;
  - tiled deconvolution matches a single-tile run within 1/255.
- engine: the command runs as one history step and is journaled; the params round trip through a smart filter; the
  panic hunt.
- ui: the menu row sits in Filter › Sharpen after Sharpen More (check `menu_rows` order); the dialog opens with the
  four rows.

**Docs.** `docs/parity/README.md:175`; FORK.md: the new module, the three hooks, the full-resolution line and the
place-table line.

**Effort: 2 d** (unchanged).

---

## Order and shared files in this group

The order is B9 → B10 → B11 → B12 → B13, as in the spec. The shared upstream files now are:
- **`engine/src/filters_ext.rs:239-240`:** B10 adds `wrap` at line 239 (B11 reuses it), and B13 adds its
  `.or_else` at line 240. Both are in the same `match`; do B10 first.
- **`algo/src/lib.rs`:** B10 adds `GalleryFx`, B11 extends it inside `gallery/` only, and B13 adds `ShakeReduction`.
  The arms are in the same matches (`label`, `kernel`, halo), so B10 and B13 go in sequence.
- **`ui-egui/src/dialogs/filter_dialog/rows.rs::custom_rows`:** B10, B11 and B13 each add one line.
- **`ui-egui/src/dialogs/filter_dialog.rs`:** B10 and B11 touch line 1184; B13 touches line 84.
- **`ui-egui/src/canvas/document_display.rs`:** B9 adds a line at 535, B11 one at 517.
- **`ui-egui/src/lib.rs` and `app.rs`:** B9 and B12 each add one `PhotocraftApp` field.
- **The Pigment place table** (or `PLACE_AFTER`): B13.

Group total: about 11 engineer-days (spec: 9.5). B11 and B12 grew, because the framework has no Path Blur kind and no
Lens Correction workspace for Pigment to reuse.
