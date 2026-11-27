# PKG-port-A5: on-image tools and eyedroppers (rows 3, 4, 7, 12, 13)

Built on `claude/pigment-photocraft` (PhotoCraft 057297b), after A1 to A4. Spec: PORTS-A §2.6, §9 A5; REBASE-A "A5"
(it wins). Read with PKG-port-A3.md and PKG-port-A4.md.

## CI at the start

The newest finished Pigment CI run was 45989566716 (A4's interface commit `867cd68`), **cancelled** by the next push,
not red. The one before it, 45989095632 (A4's engine commit `d110494`), was red: one test,
`photocraft-engine::it prefs_usage::every_preference_is_read_or_hidden` ("adjustments.curvesDisplay" had no reader).
That reader is the interface's `prefs().adjustments.curves_display`, which A4's next commit `867cd68` added, so the
failure belonged to that intermediate commit only. Here at `a9630c3` the whole engine `--test it` passes (741, with
`prefs_usage`). Nothing needed fixing. CI on this package's pushes was not waited for.

## Commits (pushed)

- `a9630c3` Pigment on-image tools and eyedroppers (A5), engine: Exposure's eyedroppers, Hue/Saturation's range
  eyedroppers, the hand in Curves, Hue/Saturation and Black & White
- `7c96e78` Pigment on-image tools and eyedroppers (A5), interface: the hand in Curves, Hue/Saturation and Black &
  White, Hue/Saturation's range eyedroppers, Exposure's eyedroppers

## What was built

1. **Engine**, `crates/engine/src/adjust_params/on_image.rs` (tests in `on_image/tests.rs`). The pure functions over a
   colour sample return complete params:
   - `exposure_eyedropper(base, picker, sample, transfer)`. Black sets Offset = −(sample × 2^Exposure). Gray sets
     Exposure so the sample becomes 18 % in linear light; white so it becomes 1. Both keep Offset and Gamma, solving
     `(lin·2^e + offset)^(1/gamma) = target`. The linearisation is the compositor's Exposure curve
     (`exposure_transfer(mode, depth)`: 2.2 power in RGB, 1.732 in Gray, linear at 32 bits). Rounding is the JS app's:
     Exposure to 1/100, Offset to 1/10000. A black sample, or an Offset already past the target, is refused.
   - `hue_saturation_eyedropper(base, RangeDropper::{Pick, Add, Subtract}, sample)`, with the edited range in `base`'s
     new `"edit"` key and returned in it:
     - Pick: the range of the sample's hue (`range_for_color`), its bounds centred on the hue (JS `centredOn`). A grey
       picks Master.
     - Add: widens the edited range (`add_hue_to_range`). From Master it first picks the sample's range, as JS did.
     - Subtract: narrows the edited range (`subtract_hue_from_range`). It does nothing from Master.
     - These are ports of JS `rangeForColor` / `addHueToRange` / `subtractHueFromRange`. Results go through
       `HueRange::canonical_bounds`. Colorize on is refused.
   - `on_image_curves(base, CurveChannel, sample, dy, mode)`:
     - The tone is the composite's Rec.709 luma (RGB) or the average (Gray), or the channel's own value. This is what
       upstream's Cmd-click uses (`CurvesPanel::add_point_from_sample`).
     - An existing point within 4 levels is taken; otherwise a point is added on the curve (the compositor's
       `curve_lut`).
     - Output = output − dy/2 levels, clamped.
     - Refused: pencil curves, CMYK and Lab, a full 19-point curve with no point near.
   - `on_image_hue_sat(base, sample, dx, hue)`. The edited range is the one with the largest weight at the sample's hue,
     or Master when the sample's saturation is under 5 %. Saturation (or Hue with `hue`) changes by dx/2.
   - `on_image_black_white(base, sample, dx)`. The colour slider nearest the sample's hue changes by dx/2, clamped to
     −200..300. A grey sample is refused.
   - Params, through `image.adjustments.*`, `layer.newAdjustmentLayer.*` and `layer.setAdjustment`:
     - Exposure's `"eyedropper":{"point","at"|"color","size"}`;
     - Hue/Saturation's `"rangeEyedropper":{"mode":"pick|add|subtract","at"|"color","size"}` and `"edit"`;
     - `"onImage":{"at"|"color","size","drag":[dx,dy],"hue","channel"}` on Curves, Hue/Saturation and Black & White.
   - `on_image::image` samples the composite. `on_image::layer` samples below the layer, over the layer's adjustment
     merged with the other keys, as upstream's `layer_eyedropper` does.
   - Refusals: a mask, channel or Quick Mask target (the tools read colour), a tool key on the wrong kind, or bad
     values.
   - A Smart Filter records the resolved settings (`on_image::strip` drops the tool keys, beside upstream's
     `eyedropper` removal).
   - Helpers for the UI: `sample(doc, hide, spec)`, `edit_of`, `hue_of`, `RangeDropper`, `CurveChannel`, `names_tool`.
2. **Interface**, `crates/ui-egui/src/dialogs/adjust_on_image.rs` (tests in `adjust_on_image_tests.rs`):
   - `row` is drawn **below** the editor in the `curves`, `hueSaturation` and `blackWhite` arms. It holds the hand
     (framework icon `hand`, tooltip per kind as the spec's words) and, for Hue/Saturation, Eyedropper, Add to Sample and
     Subtract from Sample (the `droppers_row` icons). They are `ToggleButton`s with `escape_disarms`. While one is armed
     the row passes the canvas press through the modal dialog (`pass_canvas_gesture`). Arming one puts the dialog's tone
     picker away; arming a tone picker puts the tool away (`View::last_picker`).
   - `exposure_pickers` is drawn under Exposure's sliders: black, gray and white, tooltips "Sample in image to set
     black/gray/white point". They arm the editor's own tone picker (`cx.picker`), so upstream's routing
     (`DialogPick::TonePicker`) reaches them. In the dialog, `adjust_dialog::pick` hands Exposure to `pick_exposure`. In
     Properties, `layer_picker::sample_at` sends `layer.setAdjustment {"eyedropper"}`, which the engine resolves.
   - **The armed state is a `Shared` `View`** (an `Arc<Mutex>`) in `EditorSetup.on_image`, shared between the editor's
     closure and the app. It holds the tool and Hue/Saturation's shown range. The dialog's lives in the open dialog's
     setup. The Properties one is `app.on_image.properties`, renewed when another layer shows and put away when the
     current tool changes (as `layer_picker`). **Choice recorded:** REBASE proposed an `AdjustAsk::ArmOnImage` ask and an
     `OpenAdjust` field. The shared view needs neither, so it adds no `AdjustAsk` variant and no `OpenAdjust` hook.
   - Hue/Saturation's shown range is now host-kept (`HueSaturationEditor::range(shown)`, then `keep_range` with
     `shown_range`), so a pick or the hand shows the range it edits. The Edit select still works as before. It starts
     at Master for each dialog and each Properties layer.
   - Canvas routing: `DialogPick::OnImage(OnImageTool)`. `canvas_input::armed` asks the tools first (Properties when
     no dialog is open, the adjustment dialog otherwise). `canvas/tools/dialog.rs` maps the gesture:
     - **press**: `adjust_on_image::press` samples once (the Eyedropper's Sample Size) and applies the press's own step,
       so the point appears or the range is picked;
     - **drag**: the hand recomputes from the settings before the press with the travel **measured on screen**
       (`view.to_screen` of the press), as Photoshop's pixels; the range eyedroppers sample again, so a held drag keeps
       adding;
     - **release**: Properties commits.
     - Shift adds and Alt subtracts with the plain Eyedropper, as in Photoshop. Ctrl/Cmd held at the press drags hue.
   - Dialog: each step is `adjust_dialog::apply_params` (an edit; the preview follows; OK is the one history step).
     Curves selects the point the step moved.
   - Properties: steps preview through `app.live_adjust`, and the release is **one `layer.setAdjustment`** with no
     coalesce key.
   - Cursor: the framework's `hand` with `CursorBadge::Move` (no new SVG), or the pipette with Add or Subtract.
   - Failures go to the status bar: off the image, transparent, a grey for Black & White, a mask or channel target, or
     an unsupported mode.

## Hooks into upstream files (all in FORK.md, "What Pigment added › On-image adjustment tools and the new eyedroppers")

| File | Hook |
|---|---|
| `crates/engine/src/adjust_params.rs` | `pub mod on_image;` |
| `crates/engine/src/cmd.rs` | `layer.setAdjustment`: `on_image::layer` before `layer_eyedropper` (one line); `layer.newAdjustmentLayer.*` and `image.adjustments.*`: `on_image::image` when upstream's eyedropper gave nothing (one line each); `on_image::strip` in the Smart Filter record; the params strings of `exposure`, `hueSaturation`, `curves`, `blackWhite`, `layer.setAdjustment` |
| `crates/ui-egui/src/dialogs.rs` | `pub mod adjust_on_image;` |
| `crates/ui-egui/src/dialogs/adjust_editors.rs` | `EditorSetup.on_image` + `Default`; `row` after the editor in the `curves`, `hueSaturation`, `blackWhite` arms; `exposure_pickers` after Exposure's sliders; Hue/Saturation's `.range(shown_range)` and `keep_range` |
| `crates/ui-egui/src/dialogs/adjust_dialog.rs` | `build_setup` field; `picker_applies` and `pick`: an `exposure` arm first |
| `crates/ui-egui/src/dialogs/adjust_editors/session.rs` | `layer_editor` setup: `on_image: properties_view(app, id)` |
| `crates/ui-egui/src/dialogs/layer_picker.rs` | `armed`: Exposure layers take all three pickers in RGB and Grayscale |
| `crates/ui-egui/src/dialogs/canvas_input.rs` | `DialogPick::OnImage`; `armed` (two early returns); `follows_drag`, `release`, `cursor` arms |
| `crates/ui-egui/src/canvas/tools/dialog.rs` | press arm, the screen travel and the drag arm, `takes_every_move`, `samples` |
| `crates/ui-egui/src/lib.rs`, `app.rs` | field `on_image` + `Default` |

The changes follow the code rather than REBASE in two places:

- Upstream's `adjustment_eyedropper` and `eyedropper_from_params` were **not** extended to `exposure`. Exposure's
  eyedropper lives in the Pigment module, reached by the one-line `on_image::image`/`layer` hooks. Upstream's
  "Levels and Curves only" refusal for a Hue/Saturation layer's `eyedropper` still holds (its test passes).
- No `AdjustAsk` variant was added (see the shared view above).

## Choices recorded

- **Exposure gray target 18 %** linear, as the spec says. The JS app used `srgbToLinear(128/255)` ≈ 21.6 %. Black
  uses the current Exposure's multiplier and the white/gray solve keeps Offset, as JS; Gamma is solved for too (JS
  ignored it).
- **Hue/Saturation's hand**: the range with the largest weight at the sample's hue (spec). JS took the nearest default
  centre, which is still the fallback when no range weighs anything. The **dx/2** step is the spec's; JS used dx.
- **The tool rows are below the editors.** Photoshop puts Curves' hand in its tool column and Black & White's at the
  top. The framework's editors are closed to Pigment, and a row above them moved upstream's controls out of the
  Properties panel's view (it broke `black_white_auto_button_sets_the_weights`). Hue/Saturation's tools are under its
  range bars in Photoshop too.
- The hand on a mask, channel or Quick Mask target is refused, as upstream's Cmd-click Curves point is.

## Tests (green here)

- engine `adjust_params::on_image::tests` (10):
  - Exposure: gray on 0.09 linear gives +1 stop (and the applied adjustment maps the sample to 0.18); white; black
    keeps Exposure; refusals;
  - range eyedroppers: yellow picks the yellows; orange centres; Add widens the reds to take 70° at full effect;
    Subtract takes 50° out; Master and grey cases; a range covering the circle is kept; refusals;
  - Curves: mid grey gives a point at 128, 20 px up = +10; a second press near it moves it; a channel's own value;
    luma; a bent curve; clamping; Grayscale; refusals; a full curve;
  - Hue/Saturation and Black & White drags: yellows; hue with `hue`; a grey edits Master; the widened range wins;
    clamping; B&W yellows 60 → 70;
  - commands: `image.adjustments.exposure` eyedropper (one step); `layer.newAdjustmentLayer.exposure`;
    `layer.setAdjustment` repeated gives the same result (sampled below the layer);
    `layer.newAdjustmentLayer.hueSaturation` with `rangeEyedropper`; `layer.setAdjustment` `onImage` (one step);
    `image.adjustments.curves` `onImage` (one step, undo); B&W as a new layer;
  - a Smart Filter records no tool keys;
  - refusals, a mask target, and a hostile-values loop with no panic.
- engine lib filters `adjust eyedropper hue curves exposure` (157), engine `--test it` (741), panic hunt (`--ignored`,
  1/1).
- ui-egui `dialogs::adjust_on_image::tests` (4), whole app (eframe harness), real pointer input on the canvas:
  - **Curves dialog**: click the hand, press on the red, drag 40 px up gives the point [59, 79]; a second drag moves it
    to [59, 69]; the document is untouched; OK is one history step;
  - **Hue/Saturation dialog**: the Eyedropper on the red shows the reds, centred [-32, -2, 28, 58]; Add to Sample on
    the 70° half widens the reds to full effect at 70°; the hand drag 40 px right gives reds saturation +20; OK is one
    step;
  - **Exposure dialog**: gray on 0.09 linear gives +1 stop; white gives log2(1/0.09); OK is one step;
  - **Properties**:
    - the Curves hand drag is one step, gives the point [59, 79], and ends the preview; another tool puts the hand
      away;
    - the B&W hand on the 70° half gives yellows 80, in one step;
    - Exposure's gray eyedropper arms `layer_picker` and gives +1 stop in one step.
- ui-egui lib `adjust properties auto_options preset_row adjustment_presets curves_display canvas_input dialog
  layer_picker levels_clipping hue exposure curves canvas::tools` (880 + the 4 above, 3 threads), ui-egui `--test it
  tone_targets adjust curves properties hue exposure black dialog` (44).

## Checks

All green:

- `cargo fmt --all -- --check`;
- `cargo clippy -p photocraft-engine -p photocraft-ui-egui --all-targets -- -D warnings`;
- `python3 scripts/pigment-rebrand.py --check`;
- the panic hunt;
- `cargo xtask egui-fork`, `layers`, `panel-commands`, `test-binaries`, `scorecard --check`.

`cargo test -p xtask` was not run: no crate, preference or panel command was added.

## Not done (with why)

- The hand inside Curves' tool column, and at the top of Black & White: these need craft-libs props (the editors are
  the framework's). The tools are drawn in a row below instead.
- Translations: the new English strings use the catalogue fallback. They are the hand's three tooltips (Ctrl and Cmd
  variants), "Eyedropper", "Add to Sample", "Subtract from Sample", "Eyedroppers", the three Exposure tooltips, and
  "The on-image tool samples the color image, not a mask or channel".
- Not tested by pointer: Esc on an armed Properties tool (the toggle's `escape_disarms`), the Ctrl-drag hue in the
  dialog, Shift/Alt with the plain Eyedropper, and Hue/Saturation's tools in Properties. The engine covers their
  maths.
- Upstream's measured `docs/target-app-parity.md` still leaves "Targeted Adjustment" out of its toolbox count. It is
  upstream's document, so it was not edited.

## For the next package (A6, A7)

- `EditorSetup` has a new field `on_image` (`adjust_on_image::Shared`). A literal `EditorSetup {…}` needs it or
  `..Default::default()`.
- `DialogPick` has a new variant `OnImage`, so exhaustive matches on it need an arm (`canvas_input::cursor` and the
  dialog tool's press have them).
- Hue/Saturation's editor is host-kept now (`shown_range` / `keep_range`). Keep that if A6 touches the arm.
- A6's new kinds get no on-image tool. To give one, add the kind to `adjust_on_image::has_hand` and a branch in `step`
  and in `engine::resolve`.
- A row drawn above a framework editor pushes upstream's controls down in Properties (the B&W Auto test broke). Draw
  Pigment rows below the editor.
- CI note: on the newest finished A4 run, a preference that only the interface reads fails `prefs_usage` on the engine
  commit alone. Land the reader in the same push, or accept a red intermediate run.
