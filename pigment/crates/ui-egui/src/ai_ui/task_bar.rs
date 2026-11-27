//! The generative AI contexts of the contextual task bar (the framework's
//! `craft::ui::canvas_controls::TaskBar`, as the Crop tool's in `tools/crop_task_bar.rs`), shown
//! only once a provider has a key, so the bar stays as it was for people who don't use AI:
//!
//! * under a **selection**: a prompt field and **Generate** (Generative Fill), as in Photoshop's
//!   selection bar;
//! * after **Remove Background**: **Generate Background…**, while the document is as Remove
//!   Background left it;
//! * in the **Crop tool's** bar, the slot it keeps for it: **Generative Expand**, which takes the
//!   crop frame's size and side as the new canvas.
//!
//! The bars share the Crop tool's place, pin and Hide setting (`app.ui.panels.task_bar`), follow
//! Window › Contextual Task Bar and hide behind dialogs. One bar shows at a time: the AI's never
//! with the Crop, Perspective Crop or Frame tool, whose bars have the place.

use craft::behavior::geometry::CropBox;
use craft::behavior::kurbo::Point;
use craft::ui::buttons::Button;
use craft::ui::canvas_controls::TaskBar;
use craft::ui::contract::{Bind, Props as _, Show as _};
use craft::ui::runtime::env::Label;
use craft::ui::text::TextField;
use photocraft_engine::generative::ModelKind;

use super::{BACKGROUND, EXPAND, FILL, fits, generate};
use crate::PhotocraftApp;
use crate::state::Tool;

/// Which bar shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bar {
    /// Generative Fill under the selection.
    Selection,
    /// Generate Background after Remove Background.
    AfterRemove,
}

/// The bar the AI shows now, if any.
pub fn which(app: &PhotocraftApp) -> Option<Bar> {
    if !fits(app, ModelKind::Image)
        || !app.ui.panels.context_task_bar
        || app.dialog_open()
        || app.ui.transform.is_some()
        || app.ui.text_edit.is_some()
        || matches!(app.ui.tool, Tool::Crop | Tool::PerspectiveCrop | Tool::Frame)
    {
        return None;
    }
    let st = app.session.active()?;
    if st.doc.selection.as_ref().is_some_and(|s| !s.content_bounds().intersect(&st.doc.bounds()).is_empty()) {
        return Some(Bar::Selection);
    }
    (app.ai.after_remove == Some((st.doc.id, st.revision))).then_some(Bar::AfterRemove)
}

/// The anchor of `bar` in document points: the corners of the selection's bounds, or of the canvas.
fn anchor(app: &PhotocraftApp, bar: Bar) -> Option<[Point; 4]> {
    let st = app.session.active()?;
    let r = match bar {
        Bar::Selection => st.doc.selection.as_ref()?.content_bounds().intersect(&st.doc.bounds()),
        Bar::AfterRemove => st.doc.bounds(),
    };
    let (x0, y0, x1, y1) = (f64::from(r.x0), f64::from(r.y0), f64::from(r.x1), f64::from(r.y1));
    Some([Point::new(x0, y0), Point::new(x1, y0), Point::new(x1, y1), Point::new(x0, y1)])
}

/// Draw the AI's task bar over the active document inside `area` (its tile's rect), when one
/// applies. The framework's bar maps the anchor through the pass's canvas view itself.
pub(crate) fn draw(app: &mut PhotocraftApp, ui: &mut egui::Ui, area: egui::Rect) {
    let Some(bar) = which(app) else { return };
    let Some(anchor) = anchor(app, bar) else { return };
    // The body borrows `app`, so the place lives in a local while the bar is shown.
    let mut place = app.ui.panels.task_bar;
    let shown = TaskBar::new(label(tl!("Contextual Task Bar")), &anchor, Bind::bound(&mut place)).show(ui, area, |ui, cx| {
        contents(app, ui, bar);
        cx.more_menu(ui);
    });
    app.ui.panels.task_bar = place;
    if shown.output.hide {
        app.ui.panels.context_task_bar = false;
        return;
    }
    let r = shown.output.rect;
    app.ui.task_bar_shown = Some([r.min.x, r.min.y, r.max.x, r.max.y]);
}

fn contents(app: &mut PhotocraftApp, ui: &mut egui::Ui, bar: Bar) {
    match bar {
        Bar::Selection => {
            // The field's name is its accessible name only: the placeholder is what shows.
            let what = tl!("Describe what to generate");
            let field = TextField::new(label(what), Bind::bound(&mut app.ai.bar_prompt))
                .id_salt("pigment-ai-bar-prompt")
                .placeholder(label(what))
                .limit(photocraft_engine::ai_cmds::PROMPT_LIMIT)
                .submits()
                .show(ui);
            let enter = field.submitted && !app.ai.bar_prompt.trim().is_empty();
            if Button::new(label(tl!("Generate"))).show(ui).clicked() || enter {
                fill_from_bar(app);
            }
        }
        Bar::AfterRemove => {
            if Button::new(label(tl!("Generate Background…"))).show(ui).clicked() {
                let _ = generate::open(app, BACKGROUND, None);
            }
        }
    }
}

/// The selection bar's Generate: Generative Fill with the bar's prompt. When something stops it
/// (no prompt, no agreement yet), the Generate window opens and says what.
pub fn fill_from_bar(app: &mut PhotocraftApp) {
    let prompt = app.ai.bar_prompt.trim().to_string();
    let opened = generate::open(app, FILL, (!prompt.is_empty()).then_some(prompt.as_str()));
    if opened.is_ok() && generate::blocked(app).is_none() && generate::start(app).is_ok() {
        app.ai.bar_prompt.clear();
        // The window opened only to run the request: the status bar shows it.
        if app.ai.generate.error.is_none() {
            app.ai.generate.open = false;
        }
    }
}

/// The Crop tool's bar: Generative Expand, once a provider has a key.
pub(crate) fn crop_item(app: &mut PhotocraftApp, ui: &mut egui::Ui) {
    if !fits(app, ModelKind::Image) {
        return;
    }
    // Dimmed, with the engine's reason, where the document can't take it (Indexed Color, …).
    let why = app.session.disabled_reason(EXPAND);
    let button = Button::new(label(tl!("Generative Expand"))).enabled(why.is_none());
    let button = match why {
        Some(why) => button.tooltip(why),
        None => button,
    };
    if button.show(ui).clicked() {
        expand_from_crop(app);
    }
}

/// Generative Expand from the Crop tool's frame: the canvas grows to take in the frame, on the
/// sides it reaches past; the frame is let go and the Generate window opens with that size. When
/// the window can't open, the frame stays and the status bar says why.
pub fn expand_from_crop(app: &mut PhotocraftApp) {
    let frame = crate::crop_ui::frame(app);
    if open_expand(app, frame) {
        crate::crop_ui::discard(app);
    }
}

/// Open the Generate window on Generative Expand with the canvas grown to take in `frame`
/// (document points; a turned frame by its bounds). False, with the reason in the status bar,
/// when it can't open.
fn open_expand(app: &mut PhotocraftApp, frame: Option<CropBox>) -> bool {
    let Some(st) = app.session.active() else { return false };
    let (w, h) = (f64::from(st.doc.size.width), f64::from(st.doc.size.height));
    if let Err(why) = generate::open(app, EXPAND, None) {
        app.ui.status = why;
        return false;
    }
    let Some(frame) = frame.filter(CropBox::is_finite) else { return true };
    let corners = frame.corners();
    let fold = |pick: fn(f64, f64) -> f64, axis: fn(&Point) -> f64| corners.iter().map(axis).reduce(pick).unwrap_or(0.0);
    let (x0, x1) = (fold(f64::min, |p| p.x), fold(f64::max, |p| p.x));
    let (y0, y1) = (fold(f64::min, |p| p.y), fold(f64::max, |p| p.y));
    let (left, right) = ((-x0).max(0.0), (x1 - w).max(0.0));
    let (top, bottom) = ((-y0).max(0.0), (y1 - h).max(0.0));
    let side = |before: f64, after: f64| match (before > 0.0, after > 0.0) {
        (true, false) => 2,
        (false, true) => 0,
        _ => 1,
    };
    // At least the document (which may be up to Canvas Size's limit itself), at most that limit.
    let max = f64::from(photocraft_engine::ai_cmds::EXPAND_MAX_SIDE);
    let g = &mut app.ai.generate;
    g.width = (w + left + right).round().min(max).max(w) as u32;
    g.height = (h + top + bottom).round().min(max).max(h) as u32;
    g.anchor = generate::ANCHORS[side(top, bottom) * 3 + side(left, right)];
    true
}

fn label(text: &str) -> Label {
    Label::from(text.to_string())
}
