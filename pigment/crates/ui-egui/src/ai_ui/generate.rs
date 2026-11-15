//! The Generate window: one floating window for Generative Fill, Generative Expand, Generate
//! Image, Generate Background and Sky Replacement, its feature chosen by the command that opened
//! it. It holds the prompt (prefilled with the feature's last one), the feature's options, the
//! provider (shown when two have keys) and model, **Generate**, which becomes **Stop** with the
//! elapsed time while the request runs, the error of the last request with what fixes it, and a
//! line saying what this feature sends.
//!
//! The window never blocks the app: the request is the engine command run as a background job
//! (the status bar shows it with Cancel too), and its result lands in the document as one undo
//! step. Closing the window leaves a running request alone.

use std::time::Instant;

use photocraft_engine::generative::{ModelKind, ProviderId};
use photocraft_engine::jobs::{JobEvent, JobId, JobOutcome};
use pigment_genai::settings::PromptFeature;
use serde_json::{Map, Value, json};

use super::{BACKGROUND, EXPAND, FILL, GENERATE_IMAGE, SKY, account_blocker, fitting, fixed_in_accounts, message, refresh, retryable, with_accounts};
use crate::PhotocraftApp;
use crate::theme::Tokens;

/// The window's content width.
const WIDTH: f32 = 360.0;
/// Generative Expand's anchors as the engine names them, in a 3 × 3 grid.
pub const ANCHORS: [&str; 9] = ["topLeft", "top", "topRight", "left", "center", "right", "bottomLeft", "bottom", "bottomRight"];
/// Sky Replacement's prompt before one was ever typed (JavaScript Pigment's).
pub const SKY_PROMPT: &str = "A dramatic sunset sky with warm clouds";

/// The last request's failure.
#[derive(Clone, Debug)]
pub struct Failure {
    pub kind: Option<&'static str>,
    pub message: String,
}

/// The Generate window's state. Nothing here is saved, but the last prompt per feature and the
/// provider chosen (in `ai.json`, when Generate is pressed).
pub struct Panel {
    pub open: bool,
    /// The engine command the window runs.
    pub feature: &'static str,
    pub prompt: String,
    /// Generative Fill: 1 to 3 layers.
    pub variations: u8,
    /// Generative Expand: the new canvas size and where the image stays; Generate Image: a new
    /// document's size.
    pub width: u32,
    pub height: u32,
    pub anchor: &'static str,
    /// Generate Image: a new document rather than a layer.
    pub new_document: bool,
    pub transparent: bool,
    /// The provider chosen in the window; `None`: the preferred one.
    pub provider: Option<ProviderId>,
    /// A model for this request; empty: the one AI Accounts sets.
    pub model: String,
    /// The request running and when it started.
    pub job: Option<(JobId, Instant)>,
    pub error: Option<Failure>,
    /// What happened last.
    pub note: Option<String>,
}

impl Default for Panel {
    fn default() -> Self {
        Self {
            open: false,
            feature: FILL,
            prompt: String::new(),
            variations: 1,
            width: 1024,
            height: 1024,
            anchor: "center",
            new_document: false,
            transparent: false,
            provider: None,
            model: String::new(),
            job: None,
            error: None,
            note: None,
        }
    }
}

/// The feature's title.
pub fn title(feature: &str) -> &'static str {
    match feature {
        FILL => tl!("Generative Fill"),
        EXPAND => tl!("Generative Expand"),
        GENERATE_IMAGE => tl!("Generate Image"),
        BACKGROUND => tl!("Generate Background"),
        SKY => tl!("Sky Replacement"),
        _ => tl!("Generate"),
    }
}

/// The feature asks for a prompt (Expand's is optional: the engine has a default).
fn needs_prompt(feature: &str) -> bool {
    feature != EXPAND
}

/// The window starts on the provider the last image request chose (JS `imageProvider`).
pub(crate) fn starting_provider(app: &mut PhotocraftApp) {
    app.ai.generate.provider = with_accounts(app, |a| a.settings.image_provider).flatten();
}

/// Open the window on `feature` (an `ai.*` command id), with `prompt` when given. Refused when the
/// document doesn't suit the feature, as the dimmed menu item says.
pub fn open(app: &mut PhotocraftApp, feature: &'static str, prompt: Option<&str>) -> Result<Value, String> {
    if let Some(why) = app.session.disabled_reason(feature) {
        return Err(why);
    }
    refresh(app);
    let switching = !app.ai.generate.open || app.ai.generate.feature != feature;
    if switching {
        let last = PromptFeature::of_command(feature).and_then(|f| with_accounts(app, |a| a.settings.last_prompt(f).map(str::to_string)).flatten());
        let size = app.session.active().map(|st| (st.doc.size.width, st.doc.size.height));
        let g = &mut app.ai.generate;
        g.feature = feature;
        g.error = None;
        g.note = None;
        g.prompt = last.unwrap_or_else(|| if feature == SKY { SKY_PROMPT.to_string() } else { String::new() });
        g.anchor = "center";
        g.new_document = size.is_none();
        let (w, h) = size.unwrap_or((1024, 1024));
        g.width = w;
        g.height = h;
    }
    if let Some(p) = prompt {
        app.ai.generate.prompt = p.chars().take(photocraft_engine::ai_cmds::PROMPT_LIMIT).collect();
    }
    app.ai.generate.open = true;
    Ok(json!({"feature": feature, "open": true}))
}

/// Close the window. A request still running goes on (the status bar shows it with Cancel).
pub fn close(app: &mut PhotocraftApp) {
    let g = &mut app.ai.generate;
    g.open = false;
    g.error = None;
    g.note = None;
}

/// Why Generate can't run now (also its tooltip), or `None`.
pub fn blocked(app: &PhotocraftApp) -> Option<String> {
    let g = &app.ai.generate;
    if g.job.is_some() {
        return Some(tl!("A request is running. Stop it to start another.").to_string());
    }
    if let Some(why) = account_blocker(app, ModelKind::Image) {
        return Some(why.to_string());
    }
    if g.feature == GENERATE_IMAGE && !g.new_document && app.session.active().is_none() {
        return Some(tl!("Open a document first, or choose a new document.").to_string());
    }
    if let Some(why) = app.session.disabled_reason(g.feature) {
        return Some(why);
    }
    if needs_prompt(g.feature) && g.prompt.trim().is_empty() {
        return Some(tl!("Describe what to generate.").to_string());
    }
    None
}

/// The provider chosen in the window while it still has a key; `None`: the preferred one.
fn provider(app: &PhotocraftApp) -> Option<ProviderId> {
    app.ai.generate.provider.filter(|p| fitting(app, ModelKind::Image).contains(p))
}

/// The command's params, as the window's fields describe them.
pub fn params(app: &PhotocraftApp) -> Value {
    let g = &app.ai.generate;
    let mut p = Map::new();
    let prompt = g.prompt.trim();
    if !prompt.is_empty() {
        p.insert("prompt".into(), json!(prompt));
    }
    if let Some(id) = provider(app) {
        p.insert("provider".into(), json!(id.id()));
    }
    let model = g.model.trim();
    if !model.is_empty() {
        p.insert("model".into(), json!(model));
    }
    let size = app.session.active().map(|st| (st.doc.size.width, st.doc.size.height));
    match g.feature {
        FILL => {
            p.insert("variations".into(), json!(g.variations.clamp(1, 3)));
        }
        EXPAND => {
            if let Some((w, h)) = size {
                if g.width > w {
                    p.insert("width".into(), json!(g.width));
                }
                if g.height > h {
                    p.insert("height".into(), json!(g.height));
                }
            }
            p.insert("anchor".into(), json!(g.anchor));
        }
        GENERATE_IMAGE => {
            let document = g.new_document || size.is_none();
            p.insert("target".into(), json!(if document { "document" } else { "layer" }));
            if document {
                p.insert("width".into(), json!(g.width.clamp(16, 8192)));
                p.insert("height".into(), json!(g.height.clamp(16, 8192)));
            }
            p.insert("transparent".into(), json!(g.transparent));
        }
        _ => {}
    }
    Value::Object(p)
}

/// Generate: send the request the window describes.
pub fn start(app: &mut PhotocraftApp) -> Result<Value, String> {
    refresh(app);
    if let Some(why) = blocked(app) {
        return Err(why);
    }
    let feature = app.ai.generate.feature;
    let params = params(app);
    // The last prompt of the feature and the provider chosen, as JavaScript Pigment kept them.
    let (prompt, chosen) = (app.ai.generate.prompt.clone(), provider(app));
    with_accounts(app, |a| {
        if let Some(f) = PromptFeature::of_command(feature) {
            a.settings.set_last_prompt(f, &prompt);
        }
        if chosen.is_some() {
            a.settings.image_provider = chosen;
        }
        if let Err(e) = a.save() {
            log::warn!("ai: could not save the AI settings: {e}");
        }
    });
    let g = &mut app.ai.generate;
    g.error = None;
    g.note = None;
    match app.run(feature, params) {
        Ok(v) => {
            let g = &mut app.ai.generate;
            match v.get("pending").and_then(Value::as_bool).filter(|p| *p).and_then(|_| v.get("job")?.as_u64()) {
                Some(job) => g.job = Some((JobId(job), Instant::now())),
                None => g.note = Some(done_note(feature)),
            }
            Ok(v)
        }
        Err(e) => {
            app.ai.generate.error = Some(Failure { kind: None, message: e.clone() });
            Err(e)
        }
    }
}

fn done_note(feature: &str) -> String {
    crate::i18n::fmt(tl!("{feature} is done. Edit › Undo takes it back."), &[("feature", title(feature))])
}

/// The note after Stop: the provider may bill a request already sent.
fn stopped_note() -> String {
    tl!("Stopped. Nothing was changed; a request already sent may still be billed by your provider.").to_string()
}

/// Stop: cancel the running request (its answer, if any, is dropped).
pub fn stop(app: &mut PhotocraftApp) -> bool {
    let Some((job, _)) = app.ai.generate.job else { return false };
    let stopped = crate::jobs_ui::cancel(app, job);
    if stopped {
        app.ai.generate.job = None;
        app.ai.generate.note = Some(stopped_note());
    }
    stopped
}

/// The window's request ended. `true` when the window shows the outcome (a failure or a stop
/// while it is open); a result lands as usual and the shell reports it.
pub(crate) fn on_job_event(app: &mut PhotocraftApp, e: &JobEvent) -> bool {
    let g = &mut app.ai.generate;
    if !g.job.is_some_and(|(j, _)| j == e.id) {
        return false;
    }
    g.job = None;
    match &e.outcome {
        JobOutcome::Done(_) => {
            g.note = Some(done_note(g.feature));
            false
        }
        JobOutcome::Failed(err) => {
            g.error = Some(Failure { kind: super::error_kind(e), message: err.clone() });
            g.open
        }
        JobOutcome::Cancelled => {
            g.note = Some(stopped_note());
            g.open
        }
    }
}

/// What a click in the window asked for, done after it is drawn.
enum Act {
    Generate,
    Stop,
    Accounts,
}

/// Draw the window while it is open.
pub(crate) fn show(app: &mut PhotocraftApp, ctx: &egui::Context) {
    if !app.ai.generate.open {
        return;
    }
    let mut open = true;
    let mut act = None;
    let canvas = app.last_canvas_rect;
    let at = if canvas.is_positive() { canvas.right_top() + egui::vec2(-WIDTH - 40.0, 40.0) } else { egui::pos2(200.0, 120.0) };
    egui::Window::new(title(app.ai.generate.feature))
        .id(egui::Id::unique("pigment-ai-generate"))
        .open(&mut open)
        .collapsible(false)
        .resizable(false)
        .default_pos(at)
        .show(ctx, |ui| {
            ui.set_width(WIDTH);
            act = body(app, ui);
        });
    match act {
        Some(Act::Generate) => {
            let _ = start(app);
        }
        Some(Act::Stop) => {
            stop(app);
        }
        Some(Act::Accounts) => super::accounts::open(app, None),
        None => {}
    }
    if !open {
        close(app);
    }
    if app.ai.generate.job.is_some() {
        // The elapsed time moves.
        ctx.request_repaint_after(std::time::Duration::from_millis(250));
    }
}

fn body(app: &mut PhotocraftApp, ui: &mut egui::Ui) -> Option<Act> {
    let t = Tokens::get(ui.ctx());
    let feature = app.ai.generate.feature;
    ui.label(egui::RichText::new(intro(app, feature)).color(t.text_dim));
    ui.add_space(6.0);
    let mut act = account_notice(app, ui);
    prompt_field(app, ui);
    options(app, ui);
    provider_rows(app, ui);
    ui.add_space(8.0);
    act = action_row(app, ui).or(act);
    act = error_line(app, ui).or(act);
    if let Some(note) = &app.ai.generate.note {
        ui.label(egui::RichText::new(note.as_str()).color(t.text_dim));
    }
    ui.add_space(4.0);
    ui.label(egui::RichText::new(sends(feature)).color(t.text_faint).small());
    act
}

/// What the feature does.
fn intro(app: &PhotocraftApp, feature: &str) -> &'static str {
    match feature {
        FILL => tl!("Fills the selection with what you describe, taking the surrounding image into account."),
        EXPAND => tl!(
            "Enlarges the canvas and fills the new area so the picture continues. Without a larger size it fills the transparent area the image already has."
        ),
        GENERATE_IMAGE => tl!("Makes a new image from your description."),
        BACKGROUND => tl!("The subject of the active layer is kept; everything around it is generated from your description."),
        SKY if app.session.active().is_some_and(|st| st.doc.selection.is_some()) => tl!("The selection marks the sky."),
        SKY => tl!("The sky is found automatically (Select › Sky); make a selection to mark it yourself."),
        _ => "",
    }
}

/// What the feature sends to the provider.
fn sends(feature: &str) -> &'static str {
    match feature {
        FILL => tl!("When you press Generate, the image around the selection, the selection and your prompt go to your AI provider."),
        EXPAND => tl!("When you press Generate, the whole image, its empty area and your prompt go to your AI provider."),
        GENERATE_IMAGE => tl!("When you press Generate, only your prompt goes to your AI provider."),
        BACKGROUND => tl!("When you press Generate, the image, the area around the subject and your prompt go to your AI provider."),
        SKY => tl!("When you press Generate, the image, the sky's mask and your prompt go to your AI provider."),
        _ => "",
    }
}

/// No key or no agreement yet: what to do, with a link to AI Accounts.
fn account_notice(app: &PhotocraftApp, ui: &mut egui::Ui) -> Option<Act> {
    let why = account_blocker(app, ModelKind::Image)?;
    if app.session.generative().is_none() {
        ui.label(why);
        return None;
    }
    let t = Tokens::get(ui.ctx());
    let mut act = None;
    egui::Frame::new().fill(t.field).corner_radius(t.radius).inner_margin(8.0).show(ui, |ui| {
        ui.label(why);
        if ui.link(tl!("Open AI Accounts…")).clicked() {
            act = Some(Act::Accounts);
        }
    });
    ui.add_space(6.0);
    act
}

fn prompt_field(app: &mut PhotocraftApp, ui: &mut egui::Ui) {
    let g = &mut app.ai.generate;
    let (label, hint) = match g.feature {
        FILL => (tl!("Describe what to generate"), tl!("e.g. a red fox curled up asleep")),
        EXPAND => (tl!("Describe the expansion (optional)"), tl!("e.g. continue the scene")),
        GENERATE_IMAGE => (tl!("Describe the image"), tl!("e.g. a lighthouse at dawn, watercolour")),
        BACKGROUND => (tl!("Describe the new background"), tl!("e.g. a sunlit beach")),
        _ => (tl!("Describe the new sky"), SKY_PROMPT),
    };
    let l = ui.label(label);
    ui.add(
        egui::TextEdit::multiline(&mut g.prompt)
            .id(egui::Id::unique("pigment-ai-prompt"))
            .desired_rows(3)
            .desired_width(WIDTH)
            .hint_text(hint)
            .char_limit(photocraft_engine::ai_cmds::PROMPT_LIMIT),
    )
    .labelled_by(l.id);
}

fn options(app: &mut PhotocraftApp, ui: &mut egui::Ui) {
    let doc = app.session.active().map(|st| (st.doc.size.width, st.doc.size.height));
    let g = &mut app.ai.generate;
    match g.feature {
        FILL => {
            ui.horizontal(|ui| {
                ui.label(tl!("Variations:"));
                for n in 1..=3u8 {
                    ui.selectable_value(&mut g.variations, n, n.to_string());
                }
            });
        }
        EXPAND => {
            let (w0, h0) = doc.unwrap_or((1, 1));
            ui.horizontal(|ui| {
                let l = ui.label(tl!("New width:"));
                ui.add(egui::DragValue::new(&mut g.width).range(w0..=30_000).suffix(" px")).labelled_by(l.id);
                let l = ui.label(tl!("New height:"));
                ui.add(egui::DragValue::new(&mut g.height).range(h0..=30_000).suffix(" px")).labelled_by(l.id);
            });
            ui.horizontal(|ui| {
                ui.label(tl!("Keep the image:"));
                egui::Grid::new("pigment-ai-anchor").spacing([2.0, 2.0]).show(ui, |ui| {
                    for (i, a) in ANCHORS.iter().enumerate() {
                        let r = ui.selectable_label(g.anchor == *a, if g.anchor == *a { "●" } else { "○" });
                        let name = anchor_label(a);
                        r.widget_info(|| egui::WidgetInfo::selected(egui::Role::RadioButton, true, g.anchor == *a, name));
                        if r.clicked() {
                            g.anchor = a;
                        }
                        if i % 3 == 2 {
                            ui.end_row();
                        }
                    }
                });
            });
        }
        GENERATE_IMAGE => {
            if doc.is_some() {
                ui.horizontal(|ui| {
                    ui.label(tl!("Place in:"));
                    ui.selectable_value(&mut g.new_document, false, tl!("New layer (document size)"));
                    ui.selectable_value(&mut g.new_document, true, tl!("New document"));
                });
            }
            if g.new_document || doc.is_none() {
                ui.horizontal(|ui| {
                    let l = ui.label(tl!("Width:"));
                    ui.add(egui::DragValue::new(&mut g.width).range(16..=8192).suffix(" px")).labelled_by(l.id);
                    let l = ui.label(tl!("Height:"));
                    ui.add(egui::DragValue::new(&mut g.height).range(16..=8192).suffix(" px")).labelled_by(l.id);
                });
            }
            ui.checkbox(&mut g.transparent, tl!("Transparent background")).on_hover_text(tl!(
                "gpt-image models return real transparency; other models are asked for a plain white background, which is keyed out afterwards."
            ));
        }
        _ => {}
    }
}

/// Generative Expand's anchor names for screen readers.
fn anchor_label(a: &str) -> &'static str {
    match a {
        "topLeft" => tl!("Top left"),
        "top" => tl!("Top"),
        "topRight" => tl!("Top right"),
        "left" => tl!("Left"),
        "right" => tl!("Right"),
        "bottomLeft" => tl!("Bottom left"),
        "bottom" => tl!("Bottom"),
        "bottomRight" => tl!("Bottom right"),
        _ => tl!("Centre"),
    }
}

/// The provider (when two have keys) and the model for this request.
fn provider_rows(app: &mut PhotocraftApp, ui: &mut egui::Ui) {
    let fitting = fitting(app, ModelKind::Image);
    if fitting.is_empty() {
        return;
    }
    let preferred = app.ai.status.as_ref().and_then(|s| s.default_provider).filter(|p| fitting.contains(p)).or(fitting.first().copied());
    let chosen = provider(app).or(preferred);
    if fitting.len() > 1 {
        ui.horizontal(|ui| {
            ui.label(tl!("Provider:"));
            for id in &fitting {
                if ui.selectable_label(chosen == Some(*id), id.label()).clicked() {
                    app.ai.generate.provider = Some(*id);
                }
            }
        });
    }
    let automatic = chosen.and_then(|id| app.ai.status.as_ref()?.provider(id)?.image_model.clone()).unwrap_or_default();
    let hint = crate::i18n::fmt(tl!("automatic ({model})"), &[("model", &automatic)]);
    ui.horizontal(|ui| {
        let l = ui.label(tl!("Model:"));
        ui.add(egui::TextEdit::singleline(&mut app.ai.generate.model).desired_width(200.0).hint_text(hint).char_limit(120)).labelled_by(l.id);
    });
}

/// Generate, or Stop with the time the request has taken.
fn action_row(app: &PhotocraftApp, ui: &mut egui::Ui) -> Option<Act> {
    let t = Tokens::get(ui.ctx());
    let mut act = None;
    ui.horizontal(|ui| {
        if let Some((_, started)) = app.ai.generate.job {
            if crate::widgets::secondary_button(ui, tl!("Stop"), 72.0).clicked() {
                act = Some(Act::Stop);
            }
            ui.add(egui::Spinner::new().size(14.0).color(t.accent));
            let secs = started.elapsed().as_secs().to_string();
            ui.label(crate::i18n::fmt(tl!("Generating… {s} s"), &[("s", &secs)]));
            return;
        }
        let why = blocked(app);
        let r = ui.add_enabled_ui(why.is_none(), |ui| crate::widgets::primary_button(ui, tl!("Generate"), 96.0)).inner;
        if let Some(why) = why {
            let _ = r.on_disabled_hover_text(why);
        } else if r.clicked() {
            act = Some(Act::Generate);
        }
    });
    act
}

/// The last request's error, with what fixes it.
fn error_line(app: &PhotocraftApp, ui: &mut egui::Ui) -> Option<Act> {
    let e = app.ai.generate.error.as_ref()?;
    let mut act = None;
    ui.add_space(4.0);
    ui.label(egui::RichText::new(message(&e.message)).color(ui.visuals().error_fg_color));
    ui.horizontal(|ui| {
        if fixed_in_accounts(e.kind, &e.message) && ui.link(tl!("Open AI Accounts…")).clicked() {
            act = Some(Act::Accounts);
        }
        if retryable(e.kind) && blocked(app).is_none() && ui.link(tl!("Try Again")).clicked() {
            act = Some(Act::Generate);
        }
    });
    act
}
