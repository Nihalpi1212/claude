//! The generative AI contexts of the contextual task bar (`widgets::task_bar`), shown only once a
//! provider has a key, so the bar stays as it was for people who don't use AI:
//!
//! * under a **selection**: a prompt field and **Generate** (Generative Fill), as in Photoshop's
//!   selection bar;
//! * after **Remove Background**: **Generate Background…**, while the document is as Remove
//!   Background left it;
//! * in the **Crop tool's** bar, the slot it keeps for it: **Generative Expand**, which takes the
//!   crop frame's size and side as the new canvas.
//!
//! Like the Crop tool's, the bars follow Window › Contextual Task Bar and hide behind dialogs.

use photocraft_engine::generative::ModelKind;

use super::{BACKGROUND, EXPAND, FILL, fits, generate};
use crate::PhotocraftApp;
use crate::canvas::ViewXform;
use crate::state::Tool;
use crate::widgets::task_bar;

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
        || !app.ui.dialogs.is_empty()
        || app.ui.transform.is_some()
        || app.ui.text_edit.is_some()
        || matches!(app.ui.tool, Tool::Crop | Tool::PerspectiveCrop)
    {
        return None;
    }
    let st = app.session.active()?;
    if st.doc.selection.as_ref().is_some_and(|s| !s.content_bounds().intersect(&st.doc.bounds()).is_empty()) {
        return Some(Bar::Selection);
    }
    (app.ai.after_remove == Some((st.doc.id, st.revision))).then_some(Bar::AfterRemove)
}

/// The anchor of `bar` on screen: the selection's bounds, or the canvas.
fn anchor(app: &PhotocraftApp, bar: Bar, xf: &ViewXform) -> Option<egui::Rect> {
    let st = app.session.active()?;
    let r = match bar {
        Bar::Selection => st.doc.selection.as_ref()?.content_bounds().intersect(&st.doc.bounds()),
        Bar::AfterRemove => st.doc.bounds(),
    };
    let pts = [(r.x0, r.y0), (r.x1, r.y0), (r.x1, r.y1), (r.x0, r.y1)].map(|(x, y)| xf.to_screen(x as f32, y as f32));
    Some(egui::Rect::from_points(&pts))
}

/// Draw the AI's task bar over the active document, when one applies.
pub(crate) fn draw(app: &mut PhotocraftApp, ui: &mut egui::Ui, xf: &ViewXform) {
    let Some(bar) = which(app) else { return };
    let Some(anchor) = anchor(app, bar, xf) else { return };
    let ctx = ui.ctx().clone();
    let mut place = app.ui.panels.task_bar;
    let shown = task_bar::show(&ctx, &mut place, anchor, xf.rect, |ui, more| contents(app, ui, more, bar));
    app.ui.panels.task_bar = place;
    let Some(shown) = shown else { return };
    if shown.hide {
        app.ui.panels.context_task_bar = false;
        return;
    }
    let r = shown.rect;
    app.ui.task_bar_shown = Some([r.min.x, r.min.y, r.max.x, r.max.y]);
}

fn contents(app: &mut PhotocraftApp, ui: &mut egui::Ui, more: &mut task_bar::MoreMenu, bar: Bar) {
    match bar {
        Bar::Selection => {
            let r = ui.add(
                egui::TextEdit::singleline(&mut app.ai.bar_prompt)
                    .id(egui::Id::unique("pigment-ai-bar-prompt"))
                    .desired_width(220.0)
                    .hint_text(tl!("Describe what to generate"))
                    .char_limit(photocraft_engine::ai_cmds::PROMPT_LIMIT),
            );
            let enter = r.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
            if ui.button(tl!("Generate")).clicked() || (enter && !app.ai.bar_prompt.trim().is_empty()) {
                fill_from_bar(app);
            }
        }
        Bar::AfterRemove => {
            if ui.button(tl!("Generate Background…")).clicked() {
                let _ = generate::open(app, BACKGROUND, None);
            }
        }
    }
    more.show(ui);
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
    if ui.button(tl!("Generative Expand")).clicked() {
        expand_from_crop(app);
    }
}

/// Generative Expand from the crop frame: the canvas grows to take in the frame, on the sides it
/// reaches past; the frame is let go and the Generate window opens with that size.
pub fn expand_from_crop(app: &mut PhotocraftApp) {
    let Some(st) = app.session.active() else { return };
    let (w, h) = (f64::from(st.doc.size.width), f64::from(st.doc.size.height));
    let frame = app.ui.crop_rect;
    crate::crop_ui::dismiss(app);
    if generate::open(app, EXPAND, None).is_err() {
        return;
    }
    let Some([x0, y0, x1, y1]) = frame else { return };
    let (left, right) = ((-x0).max(0.0), (x1 - w).max(0.0));
    let (top, bottom) = ((-y0).max(0.0), (y1 - h).max(0.0));
    let side = |before: f64, after: f64| match (before > 0.0, after > 0.0) {
        (true, false) => 2,
        (false, true) => 0,
        _ => 1,
    };
    let g = &mut app.ai.generate;
    g.width = (w + left + right).round().clamp(w, 30_000.0) as u32;
    g.height = (h + top + bottom).round().clamp(h, 30_000.0) as u32;
    g.anchor = generate::ANCHORS[side(top, bottom) * 3 + side(left, right)];
}
