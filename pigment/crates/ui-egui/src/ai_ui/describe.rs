//! Image › Describe Image…: sends the composite (at most 1024 px a side) to the provider's chat
//! model at once (no window to fill first, as in JavaScript Pigment) and shows the answer in a
//! small window with **Copy**, **Use as Document Description** (File › File Info's description,
//! one undo step) and **Close**. A failure shows there too, with Open AI Accounts… when that fixes
//! it.

use photocraft_doc::DocId;
use photocraft_engine::generative::ModelKind;
use photocraft_engine::jobs::{JobEvent, JobId, JobOutcome};
use serde_json::{Value, json};

use super::{DESCRIBE, account_blocker, fixed_in_accounts, message, refresh};
use crate::PhotocraftApp;
use crate::theme::Tokens;

/// The window's content width.
const WIDTH: f32 = 520.0;

/// Describe Image's request and answer.
#[derive(Default)]
pub struct State {
    /// The request running.
    pub job: Option<JobId>,
    /// The window is shown.
    pub open: bool,
    /// The answer, and the document it describes.
    pub text: Option<(String, Option<DocId>)>,
    /// The failure: its kind (when known) and message.
    pub error: Option<(Option<&'static str>, String)>,
    pub note: Option<String>,
}

/// Describe Image (`ai.describe` from a menu): checks a chat provider and the agreement (AI
/// Accounts opens when one is missing, nothing is sent), then asks.
pub fn start(app: &mut PhotocraftApp) -> Result<Value, String> {
    if let Some(why) = app.session.disabled_reason(DESCRIBE) {
        return Err(why);
    }
    refresh(app);
    if let Some(why) = account_blocker(app, ModelKind::Chat) {
        super::accounts::open(app, Some(why.to_string()));
        return Err(why.to_string());
    }
    if app.ai.describe.job.is_some() {
        return Err(tl!("Describe Image is still running.").to_string());
    }
    let doc = app.session.active().map(|st| st.doc.id);
    app.ai.describe = State::default();
    let r = app.run(DESCRIBE, json!({}));
    let d = &mut app.ai.describe;
    match &r {
        Ok(v) => match v.get("pending").and_then(Value::as_bool).filter(|p| *p).and_then(|_| v.get("job")?.as_u64()) {
            Some(job) => d.job = Some(JobId(job)),
            None => answered(d, v, doc),
        },
        Err(e) => {
            d.open = true;
            d.error = Some((None, e.clone()));
        }
    }
    r
}

fn answered(d: &mut State, v: &Value, doc: Option<DocId>) {
    d.open = true;
    match v.get("text").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty()) {
        Some(text) => d.text = Some((text.to_string(), doc)),
        None => d.error = Some((None, tl!("The model returned no description.").to_string())),
    }
}

/// Describe's request ended: the window shows the answer or the failure.
pub(crate) fn on_job_event(app: &mut PhotocraftApp, e: &JobEvent) -> bool {
    if app.ai.describe.job != Some(e.id) {
        return false;
    }
    let d = &mut app.ai.describe;
    d.job = None;
    match &e.outcome {
        JobOutcome::Done(v) => answered(d, v, e.document),
        JobOutcome::Failed(err) => {
            d.open = true;
            d.error = Some((super::error_kind(e), err.clone()));
        }
        JobOutcome::Cancelled => {}
    }
    app.ui.status = if matches!(e.outcome, JobOutcome::Cancelled) { crate::i18n::fmt(tl!("Canceled {label}"), &[("label", &e.label)]) } else { String::new() };
    app.ui.status_error = false;
    true
}

/// Use as Document Description: File › File Info's description, as one undo step.
pub fn use_as_description(app: &mut PhotocraftApp) -> Result<Value, String> {
    let Some((text, doc)) = app.ai.describe.text.clone() else { return Err(tl!("There is no description yet.").into()) };
    if doc.is_some() && app.session.active().map(|st| st.doc.id) != doc {
        return Err(tl!("Switch back to the document that was described first.").into());
    }
    let r = app.run("file.fileInfo", json!({"description": text}));
    if r.is_ok() {
        app.ai.describe.note = Some(tl!("Saved as the document description (File › File Info…).").to_string());
    }
    r
}

/// The description shown, if any.
pub fn text(app: &PhotocraftApp) -> Option<&str> {
    app.ai.describe.text.as_ref().map(|(t, _)| t.as_str())
}

enum Act {
    Copy,
    Use,
    Accounts,
    Close,
}

/// Draw the window while it is open.
pub(crate) fn show(app: &mut PhotocraftApp, ctx: &egui::Context) {
    if !app.ai.describe.open {
        return;
    }
    let mut open = true;
    let mut act = None;
    egui::Window::new(tl!("Describe Image"))
        .id(egui::Id::unique("pigment-ai-describe"))
        .open(&mut open)
        .collapsible(false)
        .resizable(false)
        .default_pos(ctx.content_rect().center() - egui::vec2(WIDTH / 2.0, 160.0))
        .show(ctx, |ui| {
            ui.set_width(WIDTH);
            act = body(app, ui);
        });
    match act {
        Some(Act::Copy) => {
            if let Some(t) = text(app) {
                ctx.copy_text(t.to_string());
                app.ai.describe.note = Some(tl!("Description copied.").to_string());
            }
        }
        Some(Act::Use) => {
            if let Err(e) = use_as_description(app) {
                app.ai.describe.note = Some(e);
            }
        }
        Some(Act::Accounts) => super::accounts::open(app, None),
        Some(Act::Close) => open = false,
        None => {}
    }
    if !open {
        app.ai.describe.open = false;
    }
}

fn body(app: &PhotocraftApp, ui: &mut egui::Ui) -> Option<Act> {
    let t = Tokens::get(ui.ctx());
    let d = &app.ai.describe;
    let mut act = None;
    if let Some((text, _)) = &d.text {
        let mut shown = text.as_str();
        egui::ScrollArea::vertical().max_height(260.0).show(ui, |ui| {
            ui.add(egui::TextEdit::multiline(&mut shown).id(egui::Id::unique("pigment-ai-description")).desired_rows(10).desired_width(WIDTH));
        });
    }
    if let Some((kind, e)) = &d.error {
        ui.label(egui::RichText::new(message(e)).color(ui.visuals().error_fg_color));
        if fixed_in_accounts(*kind, e) && ui.link(tl!("Open AI Accounts…")).clicked() {
            act = Some(Act::Accounts);
        }
    }
    if let Some(note) = &d.note {
        ui.label(egui::RichText::new(note.as_str()).color(t.text_dim));
    }
    ui.add_space(8.0);
    ui.horizontal(|ui| {
        if d.text.is_some() {
            if crate::widgets::secondary_button(ui, tl!("Copy"), 72.0).clicked() {
                act = Some(Act::Copy);
            }
            if crate::widgets::secondary_button(ui, tl!("Use as Document Description"), 0.0).clicked() {
                act = Some(Act::Use);
            }
        }
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if crate::widgets::primary_button(ui, tl!("Close"), 72.0).clicked() {
                act = Some(Act::Close);
            }
        });
    });
    act
}
