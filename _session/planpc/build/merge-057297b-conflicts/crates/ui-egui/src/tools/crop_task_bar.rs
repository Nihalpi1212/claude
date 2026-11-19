//! The Crop tool's contextual task bar (#10890): what the Crop tool puts in the framework's `TaskBar`,
//! under the crop frame, as in the reference application. Left to right:
//!
//! 1. the grip (the bar's);
//! 2. *Generative Expand goes here* once generative fill comes through the shared AI layer (#41,
//!    #1199); until then it is left out, not shown disabled;
//! 3. the preset list: the options bar's own (`crop_ui::bar::preset_list`), so the two stay in sync;
//! 4. Straighten: the options bar's Straighten button;
//! 5. the ⋯ menu (the bar's);
//! 6. while a crop is pending ([`crop_ui::pending`]): Cancel and Done, which the options bar's
//!    cancel and commit buttons do.
//!
//! Shown while the Crop tool shows a frame on the active document, Window › Contextual Task Bar
//! is ticked and no dialog is open.

use craft::behavior::IconId;
use craft::ui::buttons::{Button, ToggleButton};
use craft::ui::canvas_controls::TaskBar;
use craft::ui::contract::{Bind, Show as _};
use craft::ui::runtime::env::Label;

use crate::PhotocraftApp;
use crate::crop_ui;
use crate::state::Tool;

/// The bar shows: the Crop tool with a frame, the Window toggle on, no dialog over the canvas.
fn wanted(app: &PhotocraftApp) -> bool {
    app.ui.tool == Tool::Crop && app.ui.panels.context_task_bar && !app.dialog_open() && app.session.active().is_some()
}

/// Whether the bar can show now: [`wanted`] and a crop frame. `ui.inspect` checks it, so a bar
/// hidden by `ui.set` before the next draw no longer reports last frame's rect.
pub fn eligible(app: &PhotocraftApp) -> bool {
    wanted(app) && app.canvas_tools.crop.tool.frame().is_some()
}

/// Shows the bar under the active document's crop frame, inside `area` (the canvas body's rect).
pub fn show(app: &mut PhotocraftApp, ui: &mut egui::Ui, area: egui::Rect) {
    if !wanted(app) {
        return;
    }
    let Some(frame) = app.canvas_tools.crop.tool.frame() else { return };
    let corners = frame.corners();
    // The body borrows `app`, so the place lives in a local while the bar is shown.
    let mut place = app.ui.panels.task_bar;
    let output = TaskBar::new(label(tl!("Contextual Task Bar")), &corners, Bind::bound(&mut place)).show(ui, area, |ui, cx| {
        // Generative Expand (#41) goes here, before the preset list.
        crop_ui::bar::preset_list(app, ui);
        let armed = app.canvas_tools.crop.tool.straighten_armed();
        let straighten = ToggleButton::new(label(tl!("Straighten")), Bind::given(armed)).icon(IconId::new("ruler")).icon_only().show(ui);
        if straighten.events.committed().is_some() {
            crop_ui::toggle_straighten(app);
        }
        cx.more_menu(ui);
        if crop_ui::pending(app) {
            if Button::new(label(tl!("Cancel"))).show(ui).clicked() {
                crop_ui::discard(app);
            }
            if Button::new(label(tl!("Done"))).show(ui).clicked() {
                crop_ui::apply(app);
            }
        }
    });
    app.ui.panels.task_bar = place;
    if output.output.hide {
        app.ui.panels.context_task_bar = false;
        return;
    }
    let r = output.output.rect;
    app.ui.task_bar_shown = Some([r.min.x, r.min.y, r.max.x, r.max.y]);
}

<<<<<<< ours
/// The Crop tool's controls in the bar.
fn contents(app: &mut PhotocraftApp, ui: &mut egui::Ui, more: &mut task_bar::MoreMenu) {
    // Generative Expand (#41) goes here, before the preset dropdown. Pigment: generative AI.
    crate::ai_ui::crop_task_bar_item(app, ui);
    let before_ratio = crop_ui::preset_ratio(app);
    // Its own id: the options bar shows the same dropdown.
    ui.push_id("crop-task-bar", |ui| crate::crop_presets::dropdown(app, ui));
    if crop_ui::preset_ratio(app) != before_ratio {
        crop_ui::apply_ratio(app);
    }
    let armed = app.crop.straighten.armed;
    if crate::icons::button_with_icon_size_tip(ui, STRAIGHTEN_ICON, task_bar::BUTTON, 14.0, armed, tl!("Straighten"), false).clicked() {
        crate::crop_straighten::toggle(app);
    }
    more.show(ui);
    if crop_ui::pending(app) {
        if ui.button(tl!("Cancel")).clicked() {
            crop_ui::dismiss(app);
        }
        if ui.button(tl!("Done")).clicked() {
            crate::canvas::commit_crop(app);
        }
    }
=======
fn label(text: &str) -> Label {
    Label::from(text.to_string())
>>>>>>> theirs
}
