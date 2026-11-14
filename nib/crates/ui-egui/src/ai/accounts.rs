//! AI Accounts: the person's own OpenAI or Google Gemini key, which provider the AI commands use,
//! their models and request timeout, the one-time agreement that requests go to the provider, and
//! Test Connection.
//!
//! The key is typed into a masked field whose text lives only in [`Form::key`], never in a
//! dialog's fields or the UI state, and is cleared as soon as it is stored: afterwards the dialog
//! says only that a key is saved, with its last four characters. Nothing goes to a provider until
//! the person presses Test Connection (or Generate in the Generate window).

use std::collections::BTreeMap;

use nib_genai::jobs::{JobId, Outcome};
use nib_genai::provider::{ModelInfo, ModelKind, pick_model};
use nib_genai::ProviderKind;

use super::message;
use crate::VectorcraftApp;
use crate::theme::Tokens;
use crate::widgets;

/// Where to make a key, opened only when its link is clicked.
fn key_page(kind: ProviderKind) -> &'static str {
    match kind {
        ProviderKind::OpenAi => "https://platform.openai.com/api-keys",
        ProviderKind::Gemini => "https://aistudio.google.com/apikey",
    }
}

/// AI Accounts while it is open.
pub(crate) struct Form {
    /// The provider whose key and models the dialog shows.
    pub provider: ProviderKind,
    /// The key being typed (masked). Cleared once stored, and dropped with the dialog.
    pub key: String,
    pub text_model: String,
    pub image_model: String,
    pub timeout: u64,
    /// Test Connection running: for which provider, as which job.
    pub test: Option<(ProviderKind, JobId)>,
    /// What the last action did: (is an error, text).
    pub message: Option<(bool, String)>,
    /// The models Test Connection listed, per provider.
    pub catalog: BTreeMap<ProviderKind, Vec<ModelInfo>>,
}

impl Form {
    fn new(app: &VectorcraftApp) -> Self {
        let provider = app.ai.default_provider().unwrap_or(ProviderKind::OpenAi);
        let mut f = Self {
            provider,
            key: String::new(),
            text_model: String::new(),
            image_model: String::new(),
            timeout: app.ai.genai.accounts.settings.timeout_secs,
            test: None,
            message: None,
            catalog: BTreeMap::new(),
        };
        f.load_models(app);
        f
    }

    fn load_models(&mut self, app: &VectorcraftApp) {
        let m = app.ai.genai.accounts.settings.models(self.provider);
        self.text_model = m.text.clone();
        self.image_model = m.image.clone();
    }
}

impl Drop for Form {
    /// The typed key doesn't outlive the dialog in memory more than it must.
    fn drop(&mut self) {
        self.key.clear();
    }
}

/// Open AI Accounts (`ai.accounts`).
pub(crate) fn open(app: &mut VectorcraftApp) {
    app.ai.refresh();
    if app.ai.accounts.is_none() {
        app.ai.accounts = Some(Form::new(app));
    }
}

/// Close it: the models typed are kept, the key typed and not saved is dropped.
fn close(app: &mut VectorcraftApp) {
    save_models(app);
    if let Some((_, job)) = app.ai.accounts.as_ref().and_then(|f| f.test) {
        app.ai.genai.cancel(job);
    }
    app.ai.accounts = None;
}

fn note(app: &mut VectorcraftApp, error: bool, text: String) {
    if let Some(f) = app.ai.accounts.as_mut() {
        f.message = Some((error, text));
    }
}

/// Save Key: store the typed key in the platform's key store and clear the field.
fn save_key(app: &mut VectorcraftApp) {
    let Some(f) = app.ai.accounts.as_mut() else { return };
    let kind = f.provider;
    let typed = std::mem::take(&mut f.key);
    let r = app.ai.genai.accounts.set_key(kind, &typed);
    drop(typed);
    app.ai.refresh();
    match r {
        Ok(()) => note(app, false, crate::i18n::fmt(tl!("Key saved for {provider}."), &[("provider", kind.label())])),
        Err(e) => note(app, true, message(&e)),
    }
}

fn remove_key(app: &mut VectorcraftApp) {
    let Some(kind) = app.ai.accounts.as_ref().map(|f| f.provider) else { return };
    let r = app.ai.genai.accounts.clear_key(kind);
    app.ai.refresh();
    match r {
        Ok(()) => note(app, false, crate::i18n::fmt(tl!("Key removed for {provider}."), &[("provider", kind.label())])),
        Err(e) => note(app, true, message(&e)),
    }
}

/// Test Connection: list the provider's models with the stored key, on a worker.
fn test(app: &mut VectorcraftApp) {
    let Some(kind) = app.ai.accounts.as_ref().map(|f| f.provider) else { return };
    match app.ai.genai.test_connection(kind) {
        Ok(job) => {
            if let Some(f) = app.ai.accounts.as_mut() {
                f.test = Some((kind, job));
                f.message = None;
            }
        }
        Err(e) => note(app, true, message(&e)),
    }
}

/// Test Connection ended.
pub(crate) fn tested(app: &mut VectorcraftApp, job: JobId, result: nib_genai::Result<Outcome>) {
    let Some(f) = app.ai.accounts.as_mut() else { return };
    let Some((kind, _)) = f.test.filter(|(_, j)| *j == job) else { return };
    f.test = None;
    match result {
        Ok(Outcome::Models(models)) => {
            let n = models.len();
            f.catalog.insert(kind, models);
            f.message =
                Some((false, crate::i18n::fmt(tl!("Connected to {provider}: {n} models available."), &[("provider", kind.label()), ("n", n.to_string().as_str())])));
        }
        Ok(Outcome::Generated(_)) => {}
        Err(e) => f.message = Some((true, message(&e))),
    }
}

/// Keep the models typed for the provider shown (an empty field goes back to the default).
fn save_models(app: &mut VectorcraftApp) {
    let Some(f) = app.ai.accounts.as_ref() else { return };
    let (kind, text, image) = (f.provider, f.text_model.clone(), f.image_model.clone());
    let m = app.ai.genai.accounts.settings.models(kind);
    if m.text == text.trim() && m.image == image.trim() {
        return;
    }
    let r = app.ai.genai.accounts.set_models(kind, Some(&text), Some(&image));
    app.ai.refresh();
    if let Err(e) = r {
        note(app, true, message(&e));
    }
    if let Some(f) = app.ai.accounts.as_mut() {
        let m = app.ai.genai.accounts.settings.models(kind);
        f.text_model = m.text.clone();
        f.image_model = m.image.clone();
    }
}

fn set_timeout(app: &mut VectorcraftApp, secs: u64) {
    app.ai.genai.accounts.settings.timeout_secs = secs.clamp(10, 600);
    if let Err(e) = app.ai.genai.accounts.save() {
        note(app, true, message(&e));
    }
}

fn set_default(app: &mut VectorcraftApp, kind: ProviderKind) {
    let r = app.ai.genai.accounts.set_default_provider(kind);
    app.ai.refresh();
    if let Err(e) = r {
        note(app, true, message(&e));
    }
}

fn set_consent(app: &mut VectorcraftApp, yes: bool) {
    let r = app.ai.genai.accounts.set_consented(yes);
    if let Err(e) = r {
        note(app, true, message(&e));
    }
}

fn switch(app: &mut VectorcraftApp, kind: ProviderKind) {
    save_models(app);
    let Some(f) = app.ai.accounts.as_mut() else { return };
    f.provider = kind;
    f.key.clear();
    f.message = None;
    let m = app.ai.genai.accounts.settings.models(kind);
    f.text_model = m.text.clone();
    f.image_model = m.image.clone();
}

/// What a click in AI Accounts asked for, done after it is drawn.
enum Act {
    Switch(ProviderKind),
    SaveKey,
    RemoveKey,
    Test,
    Default(ProviderKind),
    Consent(bool),
    Timeout(u64),
    SaveModels,
    Link(&'static str),
    Close,
}

/// Draw AI Accounts while it is open.
pub(crate) fn show(app: &mut VectorcraftApp, ctx: &egui::Context) {
    if app.ai.accounts.is_none() {
        return;
    }
    let id = egui::Id::new("nib-ai-accounts");
    let mut acts = vec![];
    let shown = crate::dialogs::modal::show(ctx, tl!("AI Accounts"), id, 0.0, 22, |ui| {
        ui.set_width(440.0);
        crate::dialogs::modal::heading(ui, tl!("AI Accounts"));
        ui.add_space(8.0);
        body(app, ui, &mut acts);
    });
    // Above Preferences when it was opened from there.
    if shown.is_some() {
        ctx.move_to_top(egui::LayerId::new(egui::Order::Foreground, id));
    }
    if ctx.input(|i| i.key_pressed(egui::Key::Escape)) && app.ai.accounts.as_ref().is_some_and(|f| f.key.is_empty()) {
        acts.push(Act::Close);
    }
    for act in acts {
        match act {
            Act::Switch(kind) => switch(app, kind),
            Act::SaveKey => save_key(app),
            Act::RemoveKey => remove_key(app),
            Act::Test => test(app),
            Act::Default(kind) => set_default(app, kind),
            Act::Consent(yes) => set_consent(app, yes),
            Act::Timeout(secs) => set_timeout(app, secs),
            Act::SaveModels => save_models(app),
            Act::Link(url) => app.open_url(url),
            Act::Close => close(app),
        }
    }
}

fn body(app: &mut VectorcraftApp, ui: &mut egui::Ui, acts: &mut Vec<Act>) {
    let t = Tokens::get(ui.ctx());
    let dim = |s: &str| egui::RichText::new(s).color(t.text_dim);
    ui.label(tl!("Nib's AI commands use your own OpenAI or Google Gemini account."));
    ui.label(dim(tl!("Requests go straight from this computer to the provider you choose; Nib has no server in between. The provider bills your account for each request.")));
    ui.label(dim(tl!("What is sent: your prompt and, when a feature uses it, a rendering of the selection, its colours, the selected text or the selected image. Never your key or your files.")));
    ui.add_space(10.0);
    provider_tabs(app, ui, acts);
    ui.add_space(6.0);
    key_rows(app, ui, acts);
    ui.add_space(8.0);
    model_rows(app, ui, acts);
    ui.add_space(8.0);
    general_rows(app, ui, acts);
    if let Some((error, text)) = app.ai.accounts.as_ref().and_then(|f| f.message.clone()) {
        ui.add_space(6.0);
        let color = if error { ui.visuals().error_fg_color } else { t.text };
        ui.label(egui::RichText::new(text).color(color));
    }
    ui.add_space(12.0);
    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
        if widgets::primary_button(ui, tl!("Done")).clicked() {
            acts.push(Act::Close);
        }
    });
}

fn provider_tabs(app: &VectorcraftApp, ui: &mut egui::Ui, acts: &mut Vec<Act>) {
    let shown = app.ai.accounts.as_ref().map_or(ProviderKind::OpenAi, |f| f.provider);
    ui.horizontal(|ui| {
        for kind in ProviderKind::ALL {
            if ui.selectable_label(shown == kind, kind.label()).clicked() && shown != kind {
                acts.push(Act::Switch(kind));
            }
        }
    });
}

fn key_rows(app: &mut VectorcraftApp, ui: &mut egui::Ui, acts: &mut Vec<Act>) {
    let t = Tokens::get(ui.ctx());
    let Some(kind) = app.ai.accounts.as_ref().map(|f| f.provider) else { return };
    let status = app.ai.status().iter().find(|s| s.provider == kind).cloned();
    let connected = status.as_ref().is_some_and(|s| s.connected);
    let state = match &status {
        Some(s) if s.connected && !s.hint.is_empty() => {
            crate::i18n::fmt(tl!("Key saved (ends in …{hint}), kept in the {store}."), &[("hint", s.hint.as_str()), ("store", store_name(s.backend))])
        }
        Some(s) if s.connected => crate::i18n::fmt(tl!("Key saved, kept in the {store}."), &[("store", store_name(s.backend))]),
        _ => tl!("No key saved.").to_string(),
    };
    ui.label(egui::RichText::new(state).color(if connected { t.text } else { t.text_dim }));
    let testing = app.ai.accounts.as_ref().is_some_and(|f| f.test.is_some());
    let Some(f) = app.ai.accounts.as_mut() else { return };
    ui.horizontal(|ui| {
        let label = ui.label(tl!("API key"));
        // Masked and never filled in: a saved key is not shown again.
        ui.add(egui::TextEdit::singleline(&mut f.key).password(true).desired_width(220.0).hint_text(tl!("Paste your key"))).labelled_by(label.id);
        if widgets::primary_button_enabled(ui, tl!("Save Key"), !f.key.trim().is_empty()).clicked() {
            acts.push(Act::SaveKey);
        }
    });
    ui.horizontal(|ui| {
        let r = ui.add_enabled(connected && !testing, egui::Button::new(tl!("Test Connection")));
        if r.clicked() {
            acts.push(Act::Test);
        }
        let _ = r.on_disabled_hover_text(tl!("Save a key first"));
        if testing {
            ui.add(egui::Spinner::new().size(14.0));
        }
        if ui.add_enabled(connected, egui::Button::new(tl!("Remove Key"))).clicked() {
            acts.push(Act::RemoveKey);
        }
        if ui.link(tl!("Get a key…")).on_hover_text(key_page(kind)).clicked() {
            acts.push(Act::Link(key_page(kind)));
        }
    });
    let is_default = status.as_ref().is_some_and(|s| s.is_default);
    let mut use_it = is_default;
    if ui.checkbox(&mut use_it, tl!("Use this provider for the AI commands")).changed() && use_it {
        acts.push(Act::Default(kind));
    }
}

/// What AI Accounts calls the place keys are kept in.
fn store_name(backend: &str) -> &'static str {
    match backend {
        "macOS Keychain" => tl!("macOS Keychain"),
        "Windows Credential Manager" => tl!("Windows Credential Manager"),
        "memory" => tl!("memory, for this session only"),
        _ => tl!("key file in Nib's settings folder (readable only by you)"),
    }
}

fn model_rows(app: &mut VectorcraftApp, ui: &mut egui::Ui, acts: &mut Vec<Act>) {
    let Some(f) = app.ai.accounts.as_mut() else { return };
    let kind = f.provider;
    let catalog = f.catalog.get(&kind).cloned().unwrap_or_default();
    egui::Grid::new("nib-ai-models").num_columns(3).spacing([8.0, 6.0]).show(ui, |ui| {
        for (label, field, want, default) in [
            (tl!("Text model"), &mut f.text_model, ModelKind::Text, kind.default_text_model()),
            (tl!("Image model"), &mut f.image_model, ModelKind::Image, kind.default_image_model()),
        ] {
            let l = ui.label(label);
            let r = ui.add(egui::TextEdit::singleline(field).desired_width(200.0).hint_text(default).char_limit(120)).labelled_by(l.id);
            if r.lost_focus() {
                acts.push(Act::SaveModels);
            }
            let suggested = pick_model(kind, &catalog, want);
            match suggested {
                Some(m) if *field != m => {
                    if ui.small_button(tl!("Use Suggested")).on_hover_text(m.as_str()).clicked() {
                        *field = m;
                        acts.push(Act::SaveModels);
                    }
                }
                _ => {
                    if ui.small_button(tl!("Default")).on_hover_text(default).clicked() {
                        *field = default.to_string();
                        acts.push(Act::SaveModels);
                    }
                }
            }
            ui.end_row();
        }
    });
}

fn general_rows(app: &mut VectorcraftApp, ui: &mut egui::Ui, acts: &mut Vec<Act>) {
    let Some(f) = app.ai.accounts.as_mut() else { return };
    ui.horizontal(|ui| {
        ui.label(tl!("Request timeout:"));
        let r = ui.add(egui::DragValue::new(&mut f.timeout).range(10..=600).suffix(" s"));
        if r.changed() {
            acts.push(Act::Timeout(f.timeout));
        }
    });
    ui.add_space(6.0);
    let mut agreed = app.ai.genai.accounts.settings.consented;
    let r = ui.checkbox(
        &mut agreed,
        tl!("I agree that the AI commands send my prompt and, where a feature needs it, the selected artwork, image or text to the provider I chose."),
    );
    if r.changed() {
        acts.push(Act::Consent(agreed));
    }
}
