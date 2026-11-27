//! Pigment: Curves display options and Show Clipping in the Curves editor (PORTS-A row 11, package A4).
//!
//! The framework's `CurvesPanel` cannot be changed here (craft-libs is a pinned dependency), so Pigment draws its
//! controls under it, in the `curves` arm of `adjust_editors::show`, and reads what the panel reports:
//!
//! - **Show Histogram** off hands the panel no histograms ([`View::histogram`], from Curve Display Options).
//! - **Show Clipping** (a check box, dialog only, as in Photoshop and the JavaScript Pigment): while it is on, or Alt is
//!   held, and a drag moves the shown curve's first or last point's input, the dialog's clipping display is set to
//!   shadows or highlights; the gesture's end clears it. The canvas draws it with upstream's Levels display
//!   (`levels_clipping`), from the Levels that has each curve's end points as its input levels ([`clipping_levels`]).
//! - **Curve Display Options…** (a button in the dialog; Properties has it in its panel menu) asks the host to open the
//!   options (`dialogs::curves_display_ui`).
//!
//! The rest of Photoshop's options (Pigment/Ink %, the detailed grid, channel overlays, the baseline and the
//! intersection line) need props on the framework's curve graph; they are stored and shown disabled until then.

use craft::behavior::{EditEvent, EditEvents};
use craft::imaging::ui::adjust::{AdjustDialogCx, LevelsClip, ToneCurves};
use craft::imaging::ui::curve::Curve;
use craft::ui::buttons::Button;
use craft::ui::choice::Checkbox;
use craft::ui::contract::{Bind, Props as _, Show as _, ShowContainer as _, clicked};
use craft::ui::layout_components::Row;
use egui::Ui;
use photocraft_doc::Adjustment;
use photocraft_doc::adjust::{CurvePoint, LevelsChannel};

/// What the Curves editor shows of the display options, set by the host each pass.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct View {
    /// Show: Histogram.
    pub histogram: bool,
    /// The dialog's Show Clipping check box.
    pub show_clipping: bool,
}

impl Default for View {
    fn default() -> Self {
        Self { histogram: true, show_clipping: false }
    }
}

/// What the Curves display controls ask of the host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CurvesAsk {
    /// Curve Display Options… was pressed.
    Options,
    /// Show Clipping was turned on or off.
    ShowClipping(bool),
}

/// The histograms the panel draws: none with Show Histogram off.
pub fn histograms<'a>(view: &View, histograms: &'a [[u32; 256]]) -> &'a [[u32; 256]] {
    if view.histogram { histograms } else { &[] }
}

/// The input of the first and last point of `curve` (whole levels, 0..=255); `None` for a drawn curve.
fn ends(curve: &Curve) -> Option<(f32, f32)> {
    let points = curve.points()?;
    Some((points.first()?[0], points.last()?[0]))
}

/// The end whose input moved from `before` to `after` in channel `shown`: the first point's (shadows) or the last's
/// (highlights).
fn moved(before: &ToneCurves, after: &ToneCurves, shown: usize) -> Option<LevelsClip> {
    let (b, a) = (ends(before.curves.get(shown)?)?, ends(after.curves.get(shown)?)?);
    if a.0 != b.0 {
        Some(LevelsClip::Shadows)
    } else if a.1 != b.1 {
        Some(LevelsClip::Highlights)
    } else {
        None
    }
}

/// Show Clipping's display for one pass of the panel's `edit` of channel `shown`, starting from `before` (the curves
/// when the pass began): while `on` (the check box, or Alt held) a drag of an end point's input shows that end's
/// clipping; a drag without it, a commit, a cancel or a single-step edit clears it. A pass without edits keeps it, so
/// a display automation set stays until the next drag.
pub fn clipping(on: bool, shown: usize, before: &ToneCurves, edit: &EditEvents<ToneCurves>, display: &mut Option<LevelsClip>) {
    let mut last = before;
    for event in edit.iter() {
        match event {
            EditEvent::Update { value, .. } => {
                match (on, moved(last, value, shown)) {
                    (true, Some(end)) => *display = Some(end),
                    // A pause in the drag keeps the display; Alt released turns it off.
                    (true, None) => {}
                    (false, _) => *display = None,
                }
                last = value;
            }
            EditEvent::Commit { .. } | EditEvent::Cancel { .. } | EditEvent::Set { .. } => *display = None,
            _ => {}
        }
    }
}

/// The row under the Curves panel in a dialog: Show Clipping and Curve Display Options…. Nothing in Properties (its
/// panel menu has the options; Photoshop has no Show Clipping there).
pub fn controls(ui: &mut Ui, view: &View, cx: &AdjustDialogCx<'_>) -> (bool, Option<CurvesAsk>) {
    if !cx.context.is_dialog() {
        return (false, None);
    }
    let mut on = view.show_clipping;
    let mut ask = None;
    Row::new().show(ui, |ui, _| {
        Checkbox::new(Bind::bound(&mut on)).label(tl!("Show Clipping")).id_salt("pigment.curvesShowClipping").show(ui);
        if clicked(&Button::new(tl!("Curve Display Options…")).id_salt("pigment.curveDisplayOptions").show(ui)) {
            ask = Some(CurvesAsk::Options);
        }
    });
    if on != view.show_clipping && ask.is_none() {
        ask = Some(CurvesAsk::ShowClipping(on));
    }
    (on, ask)
}

/// The Levels whose clipping display is a Curves adjustment's: each channel's input black and white are its curve's
/// first and last point inputs (what a curve flattens below and above). Other adjustments are returned as they are.
/// The display reads only the input levels, so the curve's shape between its ends does not matter, except where a
/// channel and the composite are both edited (the Levels' straight channel stands in for the curve there).
pub fn clipping_levels(adj: Adjustment) -> Adjustment {
    let Adjustment::Curves { master, per_channel, space, black, .. } = adj else { return adj };
    let ends = |points: &[CurvePoint]| LevelsChannel {
        in_black: points.first().map_or(0.0, |p| p.input),
        in_white: points.last().map_or(1.0, |p| p.input),
        ..LevelsChannel::default()
    };
    Adjustment::Levels { master: ends(&master), per_channel: per_channel.each_ref().map(|c| ends(c)), space, black: ends(&black) }
}

#[cfg(test)]
mod tests {
    use craft::behavior::{GestureId, Mixed};
    use craft::imaging::ui::adjust::CurvesMode;
    use photocraft_doc::adjust::ToneSpace;

    use super::*;

    fn curves(points: Vec<[f32; 2]>) -> ToneCurves {
        ToneCurves::new(vec![Curve::smooth(points.clone()), Curve::identity(255.0)], CurvesMode::Points)
    }

    fn update(value: ToneCurves) -> EditEvent<ToneCurves> {
        EditEvent::update(GestureId::new(1), value)
    }

    #[test]
    fn an_end_points_input_drag_shows_its_clipping_until_the_gesture_ends() {
        let start = curves(vec![[0.0, 0.0], [255.0, 255.0]]);
        let mut display = None;
        // Moving the black point right: shadows.
        let mut edit = EditEvents::new();
        edit.push(update(curves(vec![[20.0, 0.0], [255.0, 255.0]])));
        clipping(true, 0, &start, &edit, &mut display);
        assert_eq!(display, Some(LevelsClip::Shadows));
        // A pass with the pointer still: unchanged.
        clipping(true, 0, &curves(vec![[20.0, 0.0], [255.0, 255.0]]), &EditEvents::new(), &mut display);
        assert_eq!(display, Some(LevelsClip::Shadows));
        // The end committed: off.
        let mut edit = EditEvents::new();
        edit.push(EditEvent::commit(GestureId::new(1), Mixed::Same(start.clone()), curves(vec![[20.0, 0.0], [255.0, 255.0]])));
        clipping(true, 0, &start, &edit, &mut display);
        assert_eq!(display, None);
        // The white point: highlights.
        let mut edit = EditEvents::new();
        edit.push(update(curves(vec![[0.0, 0.0], [230.0, 255.0]])));
        clipping(true, 0, &start, &edit, &mut display);
        assert_eq!(display, Some(LevelsClip::Highlights));
    }

    #[test]
    fn outputs_middle_points_other_channels_and_no_show_clipping_show_nothing() {
        let start = curves(vec![[0.0, 0.0], [128.0, 128.0], [255.0, 255.0]]);
        for (on, shown, after) in [
            (true, 0, curves(vec![[0.0, 40.0], [128.0, 128.0], [255.0, 255.0]])),
            (true, 0, curves(vec![[0.0, 0.0], [100.0, 150.0], [255.0, 255.0]])),
            (true, 1, curves(vec![[20.0, 0.0], [128.0, 128.0], [255.0, 255.0]])),
            (false, 0, curves(vec![[20.0, 0.0], [128.0, 128.0], [255.0, 255.0]])),
        ] {
            let mut display = None;
            let mut edit = EditEvents::new();
            edit.push(update(after));
            clipping(on, shown, &start, &edit, &mut display);
            assert_eq!(display, None, "on {on}, channel {shown}");
        }
        // Alt let go during the drag clears what it showed.
        let mut display = Some(LevelsClip::Shadows);
        let mut edit = EditEvents::new();
        edit.push(update(curves(vec![[30.0, 0.0], [128.0, 128.0], [255.0, 255.0]])));
        clipping(false, 0, &start, &edit, &mut display);
        assert_eq!(display, None);
    }

    #[test]
    fn a_curves_clipping_is_the_levels_with_its_end_points() {
        let p = |input: f32, output: f32| CurvePoint { input, output };
        let adj = Adjustment::Curves {
            master: vec![p(0.1, 0.0), p(0.5, 0.6), p(0.9, 1.0)],
            per_channel: [vec![p(0.2, 0.3), p(1.0, 1.0)], Vec::new(), vec![p(0.0, 0.0), p(0.7, 0.9)]],
            space: ToneSpace::Rgb,
            black: Vec::new(),
            pencil: false,
        };
        let lv = |in_black: f32, in_white: f32| LevelsChannel { in_black, in_white, ..LevelsChannel::default() };
        assert_eq!(
            clipping_levels(adj),
            Adjustment::Levels { master: lv(0.1, 0.9), per_channel: [lv(0.2, 1.0), lv(0.0, 1.0), lv(0.0, 0.7)], space: ToneSpace::Rgb, black: lv(0.0, 1.0) }
        );
        let levels = Adjustment::identity_levels();
        assert_eq!(clipping_levels(levels.clone()), levels);
    }
}
