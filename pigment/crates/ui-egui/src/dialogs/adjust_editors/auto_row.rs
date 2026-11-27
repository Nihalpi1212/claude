//! Pigment: Auto Color Correction Options in the Levels, Curves and Brightness/Contrast editors (PORTS-A rows 2, 5,
//! 14, 15, 16). The framework's editors cannot be changed here (craft-libs is a pinned dependency), so Pigment draws
//! its controls around them, in the `show` arms of `adjust_editors`:
//!
//! - **Levels**: the framework's Auto stays where it is; its "Auto" `Set` is taken out of the pass and handed to the
//!   host as [`AutoAsk::Auto`] with what the framework set, so the host keeps it (no options saved) or replaces it
//!   with Auto Color Correction Options' result, in one edit either way. Alt-click opens the options dialog instead.
//! - **Curves** and **Brightness/Contrast**: an Auto button (and, for Curves and Levels, Options…) in a row below the
//!   editor: Photoshop puts them beside the Channel select, inside the framework's panel, where Pigment cannot draw.
//! - **The eyedroppers** of Levels and Curves: Pigment's own copy of the framework's `TonePickerRow` (same labels,
//!   icons and canvas pass-through), which also reports a double-click: Photoshop's way to pick a target colour.

use craft::behavior::{EditEvent, EditEvents, IconId};
use craft::imaging::ui::adjust::{AdjustDialogCx, AdjustWords, Levels, TonePicker};
use craft::ui::buttons::{Button, ToggleButton};
use craft::ui::contract::{Bind, CanvasGesture, Outcome as _, Props as _, Sampler as _, Show as _, ShowContainer as _, clicked};
use craft::ui::display::{Shade, Text};
use craft::ui::layout_components::Row;
use craft::ui::primitives::IconSpec;
use craft::ui::runtime::env::Env;
use craft::ui::style::{DataColor, TypeRole};
use egui::Ui;

use super::{AdjustValue, EditorSetup};

/// What the Auto controls ask of the host.
#[derive(Clone, Debug, PartialEq)]
pub enum AutoAsk {
    /// Auto was pressed on `kind` ("levels", "curves", "brightnessContrast"). `framework`: what the framework's Levels
    /// Auto set (taken back out of the value), for the host to keep when no options apply. `options`: Alt was held,
    /// so the host opens Auto Color Correction Options instead (Photoshop's Alt-click on Auto).
    Auto { kind: &'static str, framework: Option<AdjustValue>, options: bool },
    /// Options… was pressed on `kind`.
    Options { kind: &'static str },
    /// An eyedropper was double-clicked: the host opens the Color Picker for its target colour.
    PickTarget(TonePicker),
}

/// The framework's pipette with a dot of the picker's tone (the framework keeps its own `icon` private).
fn icon(picker: TonePicker) -> IconSpec<'static> {
    IconSpec::svg(IconId::new("eyedropper")).badge(DataColor::new(egui::Color32::from_gray(picker.tone())))
}

/// The "Eyedroppers:" row of Levels and Curves, as the framework's `TonePickerRow` draws it, plus the double-click.
/// A click arms or disarms a picker (written to `cx.picker`); a double-click keeps it armed and asks for its target.
pub fn pickers(ui: &mut Ui, setup: &EditorSetup, cx: &mut AdjustDialogCx<'_>) -> Option<AutoAsk> {
    let words = Env::of(ui).words::<AdjustWords>();
    // A grey document has no Neutral Gray point.
    let gray = setup.channels.is_gray() || cx.context.is_gray();
    let (unavailable, current, canvas) = (setup.pickers_unavailable, *cx.picker, cx.canvas);
    let (mut next, mut double) = (None, None);
    Row::new().label(words.eyedroppers.clone()).show(ui, |ui, row| {
        if let (Some(canvas), Some(_)) = (canvas, current) {
            row.pass_canvas_gesture(canvas, CanvasGesture::PRIMARY);
        }
        Text::new(words.eyedroppers.clone()).shade(Shade::Muted).role(TypeRole::Label).show(ui);
        for picker in TonePicker::ALL {
            let usable = !unavailable && !(picker == TonePicker::Gray && gray);
            let toggle = ToggleButton::new(picker.label(&words), Bind::given(current == Some(picker)))
                .icon(icon(picker))
                .icon_only()
                .enabled(usable)
                .id_salt(picker as u8)
                .escape_disarms()
                .show(ui);
            if let Some(on) = toggle.value().copied() {
                next = Some(on.then_some(picker));
            }
            if usable && toggle.response().double_clicked() {
                double = Some(picker);
            }
        }
        if unavailable {
            Text::new(words.unavailable_mode.clone()).shade(Shade::Faint).role(TypeRole::Caption).show(ui);
        }
    });
    if let Some(picker) = double {
        // The double-click's second click toggled the picker off again: it stays armed, as in Photoshop.
        *cx.picker = Some(picker);
        return Some(AutoAsk::PickTarget(picker));
    }
    if let Some(next) = next {
        *cx.picker = next;
    }
    None
}

/// Takes the framework's Levels Auto out of `edit` (and `levels` back to `before`), as [`AutoAsk::Auto`].
pub fn levels_auto(ui: &Ui, levels: &mut Vec<Levels>, before: Vec<Levels>, edit: EditEvents<Vec<Levels>>) -> (EditEvents<Vec<Levels>>, Option<AutoAsk>) {
    let mut kept = EditEvents::new();
    let mut auto = None;
    for event in edit {
        match event {
            EditEvent::Set { after, label, .. } if &*label == "Auto" => auto = Some(after),
            other => kept.push(other),
        }
    }
    let Some(after) = auto else { return (kept, None) };
    *levels = before;
    let options = ui.input(|i| i.modifiers.alt);
    (kept, Some(AutoAsk::Auto { kind: "levels", framework: Some(AdjustValue::Levels { levels: after }), options }))
}

/// The row below an editor: Auto (Curves, Brightness/Contrast) and Options… (Levels, Curves).
pub fn buttons(ui: &mut Ui, kind: &'static str, auto: bool, options: bool) -> Option<AutoAsk> {
    let words = Env::of(ui).words::<AdjustWords>();
    let mut ask = None;
    Row::new().show(ui, |ui, _| {
        if auto && clicked(&Button::new(words.auto.clone()).id_salt("pigment.auto").show(ui)) {
            ask = Some(AutoAsk::Auto { kind, framework: None, options: ui.input(|i| i.modifiers.alt) && options });
        }
        if options && clicked(&Button::new(tl!("Options…")).id_salt("pigment.autoOptions").show(ui)) {
            ask = Some(AutoAsk::Options { kind });
        }
    });
    ask
}
