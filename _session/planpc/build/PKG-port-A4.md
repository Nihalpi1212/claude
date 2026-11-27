# PKG-port-A4: Curves display options and Show Clipping (row 11)

Built on `claude/pigment-photocraft` (PhotoCraft 057297b), after A1 to A3. Spec: PORTS-A §2.5, §9 A4;
REBASE-A "A4" (it wins). Read with PKG-port-A3.md.

## CI at the start

The newest finished Pigment CI run was red: 45973984660 (A3's engine commit `975b565`), 14 failures, all
`photocraft-ui-egui::it tone_targets::*`. A3 had already fixed exactly those in its own commit `e98b7a1`
("tone_targets reads the channel dropdowns without the Preset row's picker"), so there was nothing left to fix. Its
run (45982850686) and A3's last one (45983939731) were still running when A4 pushed. Here, `--test it tone_targets`
(with A4's changes) passes 30/30. A4 did not wait for CI on its own pushes.

## Commits (pushed)

- `d110494` Pigment Curve Display Options (A4), engine: Preferences.adjustments.curvesDisplay
- `867cd68` Pigment Curve Display Options (A4), interface: the options dialog, Show Histogram, Curves' Show Clipping,
  the Properties menu row

## What was built

1. **Preference** `Preferences.adjustments.curvesDisplay` (`crates/engine/src/cmd/auto_options_cmds/curves_display.rs`,
   type `CurvesDisplay`, a field of A3's `AdjustmentPrefs`). It stores all six options:
   `{"amount":{"rgb","cmyk","gray","lab"}: "light|pigment","grid":"simple|detailed","channelOverlays","histogram",
   "baseline","intersectionLine"}`. **Choice recorded:** Show Amount of is kept per colour-mode family (RGB/Indexed, CMYK/
   Multichannel, Gray/Duotone/Bitmap, Lab). The defaults follow Photoshop as the spec says: Pigment for CMYK, Light for
   the rest. `CurvesAmounts::of(mode)` and `slot(mode)` give access. Validation is its serde (`try_from`), the same
   pattern as A3, so `prefs.set` on any sub-path checks it and needed no `validate.rs` hook. When read, `amount` may also
   be one word for every mode. **The JavaScript app's keys are read too** (`pigment`, `detailed`, `overlays`,
   `intersection` from `settings.adjust.curvesDisplay`). JS's `pigment` applied to every mode, so it maps to every mode,
   CMYK included. P4 can therefore hand JS's object to `prefs.set adjustments.curvesDisplay` unchanged.
2. **Curves editor** (`crates/ui-egui/src/dialogs/adjust_editors/curves_display.rs`, drawn in the `curves` arm of
   `adjust_editors::show` under the framework's `CurvesPanel`):
   - `View {histogram, show_clipping}` is in `EditorSetup.curves_display`.
   - **Show Histogram** off gives the panel `&[]` (`histograms`).
   - In the dialog only, a row holds **Show Clipping** (a framework `Checkbox`) and **Curve Display Options…**. Their
     asks go out as `AdjustAsk::CurvesDisplay(CurvesAsk::{Options, ShowClipping(bool)})`.
   - `clipping(on, shown, start, edit, cx.clipping)` reads the pass's edit events. An `Update` that moves the shown
     channel's first point's input gives Shadows, and the last point's input gives Highlights. It only does this while
     Show Clipping is on or Alt is held. A pause keeps the display. Releasing Alt, or a Commit, Cancel or Set, clears
     it. A pass with no edits leaves it alone, so a display set by automation stays.
   - Drawn (pencil) curves have no end points and show nothing.
   - `clipping_levels(adj)` turns Curves into the Levels whose per-channel and master `in_black`/`in_white` are each
     curve's first and last point inputs.
3. **Host** (`crates/ui-egui/src/dialogs/curves_display_ui.rs`, `app.curves_display: State {show_clipping, open}`):
   - Show Clipping belongs to the open dialog (`show_clipping: Option<DialogId>`), so each new Curves dialog starts with
     it off, as in JS and Photoshop.
   - `follow_dialog` runs first in `answer_asks` and syncs the setup's view each pass.
   - **Curve Display Options** is a framework `HostedParamDialog` (`KEY = "pigment.curveDisplayOptions"`). From the
     Curves dialog it opens as its child. From Properties it opens on its own, through the new panel menu row
     **Curves Display Options…** (`PropertiesCommand::CurvesDisplayOptions` in `panels/adjustment_presets.rs`), which is
     enabled when the active layer is a Curves layer.
   - The dialog has radio Show Amount of (for the active document's mode), a Grid radio, and Show: Channel Overlays,
     Histogram, Baseline, Intersection Line, plus a note.
   - **Choice recorded (REBASE left it to the engineer):** the five options the framework's curve graph cannot draw are
     **shown disabled**, each with a tooltip and a full-width note ("Kept for a later version: this Curves graph cannot
     draw it yet."). They keep their saved values. Only Histogram is enabled.
   - While the dialog is open, both the Curves dialog and Properties' Curves follow its fields. OK saves through
     `prefs.set adjustments.curvesDisplay`. Cancel saves nothing, and the saved view comes back.
4. **The canvas display** reuses upstream's Levels clipping display. In `levels_clipping.rs`, `dialog` now accepts
   `curves`, and `request` reads the open kind's params and passes them through `clipping_levels`. Thresholds, scan,
   texture and eligibility rules (RGB and Grayscale pixel layers only) are unchanged.

## Hooks into upstream files (all in FORK.md, "What Pigment added › Curve Display Options and Curves' Show Clipping")

| File | Hook |
|---|---|
| `crates/ui-egui/src/dialogs/adjust_editors.rs` | `pub mod curves_display;`; `AdjustAsk::CurvesDisplay`; `EditorSetup.curves_display` + `Default`; `curves` arm: histograms through `curves_display::histograms`, then `controls` and (dialog only) `clipping` |
| `crates/ui-egui/src/dialogs/adjust_dialog.rs` | `build_setup` field; `answer_asks`: `curves_display_ui::follow_dialog` first, and the `CurvesDisplay` arm |
| `crates/ui-egui/src/dialogs/adjust_editors/session.rs` | `layer_editor` setup: `curves_display` |
| `crates/ui-egui/src/levels_clipping.rs` | `dialog` accepts curves; `request` uses the open kind and `clipping_levels` |
| `crates/ui-egui/src/levels_clipping_tests.rs` | the added test `curves_show_the_clipping_of_their_end_points` (it needs the module's private `request`) |
| `crates/ui-egui/src/dialogs.rs` | `pub mod curves_display_ui;`; `FAMILY` in `PARAM_FAMILIES` |
| `crates/ui-egui/src/lib.rs`, `app.rs` | field `curves_display` + `Default` |

Pigment's own files changed: `crates/engine/src/cmd/auto_options_cmds.rs` (`pub mod curves_display;`, the
`AdjustmentPrefs` field), `crates/ui-egui/src/panels/adjustment_presets.rs` (the menu row, its state and run).

## Files

New: `crates/engine/src/cmd/auto_options_cmds/curves_display.rs` (with tests),
`crates/ui-egui/src/dialogs/adjust_editors/curves_display.rs` (with tests), `crates/ui-egui/src/dialogs/curves_display_ui.rs`,
`crates/ui-egui/src/dialogs/curves_display_ui_tests.rs`. Edited: the hook files above, `docs/FORK.md`.

## Tests (all green here)

- engine `cmd::auto_options_cmds::curves_display::tests` (3):
  - defaults and the preference form, including per-mode amounts and one word for every mode;
  - bad values refused;
  - the JS app's keys read;
  - `prefs.set` on sub-paths, validated;
  - a round trip **through the real `SettingsStore` (config.toml)**;
  - reset.

  Also engine `prefs` + `curves_display` lib (75) and `--test it prefs` (6, including `prefs_usage`). The new key's
  reader is the interface's `prefs().adjustments.curves_display`.
- ui-egui `adjust_editors::curves_display::tests` (3):
  - an end point's input drag gives shadows or highlights until commit;
  - output moves, middle points, another channel, or Show Clipping off give nothing;
  - releasing Alt clears;
  - `clipping_levels` equals the Levels with the same ends.
- ui-egui `dialogs::curves_display_ui::tests` (4):
  - **By pointer in the Curves dialog:**
    - dragging the black point without Show Clipping shows nothing;
    - ticking **Show Clipping** turns it on for that dialog;
    - dragging the black point gives Shadows while held and none after release; the white point gives Highlights;
    - adding a middle point by click and dragging it gives none;
    - the document is never edited;
    - Alt-drag with the box off shows it;
    - a new Curves dialog opens with it off.
  - **The options dialog by pointer:**
    - it is a child of Curves;
    - Channel Overlays, Baseline and Intersection Line are disabled, Histogram is enabled;
    - unticking Histogram previews at once, and the panel gets no histogram;
    - Cancel restores and saves nothing;
    - OK saves `histogram=false` and keeps a stored `amount.rgb = pigment`;
    - no history entry.
  - **Properties menu row:** disabled on a pixel layer and a Levels layer, enabled on a Curves layer; it opens the
    dialog, Properties' view follows the fields, and OK saves.
  - Fields keep Show Amount of per mode.
- ui-egui `levels_clipping::tests::curves_show_the_clipping_of_their_end_points`: for a Curves dialog (composite
  60..200, red 20..240) and the Levels with the same input levels, for both ends, the request is that Levels, the
  thresholds match, and **the painted display is identical**.
- Unchanged and green:
  - ui-egui `levels_clipping` (all 18 upstream tests);
  - ui-egui lib `adjust properties auto_options preset_row adjustment_presets registry dock menus:: panels::` (574);
  - ui-egui `--test it tone_targets adjust curves properties` (37);
  - xtask (108).

## Checks

- Green:
  - `cargo fmt --all -- --check`;
  - `cargo clippy -p photocraft-engine -p photocraft-ui-egui --all-targets -- -D warnings`;
  - `python3 scripts/pigment-rebrand.py --check`;
  - `cargo xtask scorecard --check` (up to date: the new key is inside the existing `adjustments` section, so the
    prefs count did not move);
  - `cargo xtask panel-commands` (the new menu row dispatches its command id), `cargo xtask layers`,
    `cargo xtask egui-fork`;
  - `cargo test -p xtask`.
- Not run: the panic hunt. A4 adds no engine command.

## Rows done and not done

- Done:
  - Curve Display Options stored (all six);
  - the options dialog (Curves dialog and Properties menu);
  - Show Histogram;
  - Curves Show Clipping (box and Alt) on the canvas.
- Levels Alt-drag clipping: upstream already does it (`levels_clipping.rs`, #3328), so it was dropped as REBASE says.
- **Not done, blocked on craft-libs** (stored only, shown disabled): Pigment/Ink % (mirrored axes and tone bars),
  Detailed grid, Channel Overlays off, Baseline off, Intersection Line. They need props on `CurveEditor`/`CurveGraph`
  (`grid`, `baseline`, `intersection`, `amount`) and on `CurvesPanel` (`overlays`, and passing the rest through). That
  is about 1 day in craft-libs with story tests, and Pigment picks it up only when upstream moves its pin. REBASE says to
  ask the project's owner whether to propose it. **That question is still open**: it was not asked in this package.
  With those props, the spec's grid-line count test and the Pigment-mode mapping test become possible. Enabling the
  rows is then removing `not_drawn(…)` in `curves_display_ui::rows` and passing `display(app)` through to the panel.
- Show Clipping in Properties: not built (Photoshop and JS have it in the dialog only).
- Known approximation (in `clipping_levels`'s doc): when a channel curve and the composite curve are both edited, the
  channel's shape between its ends is treated as straight when classifying the composite's clipping. The display is
  exact when only one of the two is edited.
- New English strings, left to the catalogue fallback:
  - "Show Clipping", "Curve Display Options…", "Curve Display Options", "Curves Display Options…";
  - "Show Amount of:", "Light (0-255)", "Pigment/Ink %";
  - "Grid:", "Simple grid", "Detailed grid";
  - "Show:", "Channel Overlays", "Histogram", "Baseline", "Intersection Line";
  - the note.

## For the next package (A5 and later)

- `AdjustAsk` has a new variant `CurvesDisplay`. `answer_asks` matches it, and `session.rs` uses `_`.
- `EditorSetup` has a new field `curves_display`. Literal `EditorSetup {…}` needs it or `..Default::default()`.
- A5 edits the same `curves` arm: Pigment's row (Show Clipping, Curve Display Options…) sits right after
  `panel.show(ui)`, before A3's Auto/Options… row. `start` (the curves before the pass) is already cloned there if A5
  needs a before-value. The asks are chained with `.or(…)`, Auto first.
- `levels_clipping::request` now works for any kind `clipping_levels` maps. A5 or A6 can add a kind there.
- P4 (Migrate Presets): `settings.adjust.curvesDisplay` → `prefs.set {"path":"adjustments.curvesDisplay","value":<the JS
  object>}` works as is.
