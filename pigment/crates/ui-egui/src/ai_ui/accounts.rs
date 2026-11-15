//! AI Accounts (Edit › AI Accounts…, Preferences › AI Integrations' button, and the windows'
//! Open AI Accounts…): the person's own OpenAI or Google Gemini key, which provider the AI
//! commands prefer, their models and the request timeout, the one-time agreement that requests
//! go to the provider (and are billed by it, a stopped one too), and whether agents may run AI
//! commands.
//!
//! The key is typed into a masked field whose text lives only in [`Form`], never in a dialog's
//! fields, [`crate::UiState`] or the preferences. **Connect** checks it with the provider (one
//! model list, on a worker thread) and stores it only when the provider accepts it; the field is
//! wiped either way, and afterwards the dialog shows only the key's last four characters. Nothing
//! but that check goes to a provider from here.

use std::collections::BTreeMap;
use std::sync::mpsc::{Receiver, TryRecvError};
use std::time::Duration;

use photocraft_engine::generative::ProviderId;
use pigment_genai::provider::{ModelInfo, ModelKind, pick_model};
use pigment_genai::{AccountStatus, AiError, CancelToken};

use super::{message, refresh, with_accounts};
use crate::PhotocraftApp;
use crate::theme::Tokens;

/// Where to make a key, opened only when its link is clicked.
pub fn key_page(p: ProviderId) -> &'static str {
    match p {
        ProviderId::OpenAi => "https://platform.openai.com/api-keys",
        ProviderId::Gemini => "https://aistudio.google.com/apikey",
    }
}

/// The agreement, given once. Nothing is sent before it.
pub const CONSENT: &str = "I agree that the AI commands send my prompt and, where a feature needs it, the image, layer or selection, to the provider I chose, and that the provider bills my account for every request, including one I stop after it was sent.";

/// What a worker thread is doing for the dialog.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Work {
    /// Checking a typed key, then storing it.
    Connect,
    /// Listing the models with the stored key.
    Test,
}

/// A worker thread's request and how to stop it.
pub(crate) struct Busy {
    pub work: Work,
    pub provider: ProviderId,
    rx: Receiver<Result<Vec<ModelInfo>, AiError>>,
    cancel: CancelToken,
}

/// AI Accounts while it is open.
pub(crate) struct Form {
    /// The provider whose key and models the dialog shows.
    pub provider: ProviderId,
    /// The key being typed (masked). Wiped once sent to be checked, and with the dialog.
    pub key: String,
    pub chat_model: String,
    pub image_model: String,
    pub timeout: u64,
    /// Why the dialog opened (a feature needed a provider), shown at its top.
    pub reason: Option<String>,
    pub busy: Option<Busy>,
    /// What the last action did: (is an error, text).
    pub message: Option<(bool, String)>,
    /// The models a check or Test Connection listed, per provider.
    pub catalog: BTreeMap<&'static str, Vec<ModelInfo>>,
    /// The status as last read (no key, only its last four characters).
    pub status: Vec<AccountStatus>,
}

impl Drop for Form {
    /// The typed key doesn't outlive the dialog in memory more than it must: its bytes are
    /// overwritten, not only forgotten.
    fn drop(&mut self) {
        wipe(&mut self.key);
        if let Some(b) = &self.busy {
            b.cancel.cancel();
        }
    }
}

/// Overwrite `s`'s bytes with zeros and empty it.
pub(crate) fn wipe(s: &mut String) {
    let mut bytes = std::mem::take(s).into_bytes();
    bytes.fill(0);
    std::hint::black_box(&bytes);
}

/// The key field's widget id. Its egui state (which keeps earlier texts for undo) is dropped
/// whenever the field is empty, so no copy of the key stays in egui's memory.
pub fn key_field_id() -> egui::Id {
    egui::Id::unique("pigment-ai-accounts-key")
}

/// Open AI Accounts, saying `reason` at the top (a feature that needs a provider).
pub fn open(app: &mut PhotocraftApp, reason: Option<String>) {
    refresh(app);
    if app.ai.accounts.is_none() {
        let status = with_accounts(app, |a| a.status()).unwrap_or_default();
        let provider = status.iter().find(|s| s.is_default).map_or(ProviderId::OpenAi, |s| s.provider);
        let timeout = with_accounts(app, |a| a.settings.timeout_secs).unwrap_or(300);
        let mut f = Form {
            provider,
            key: String::new(),
            chat_model: String::new(),
            image_model: String::new(),
            timeout,
            reason: None,
            busy: None,
            message: None,
            catalog: BTreeMap::new(),
            status,
        };
        load_models(app, &mut f);
        app.ai.accounts = Some(f);
    }
    if let Some(f) = app.ai.accounts.as_mut() {
        f.reason = reason;
    }
}

/// AI Accounts is open.
pub fn is_open(app: &PhotocraftApp) -> bool {
    app.ai.accounts.is_some()
}

/// The models chosen for the provider shown (empty: automatic).
fn load_models(app: &PhotocraftApp, f: &mut Form) {
    let p = f.provider;
    let (chat, image) = with_accounts(app, |a| {
        let m = a.settings.models(p);
        (m.chat_model.clone().unwrap_or_default(), m.image_model.clone().unwrap_or_default())
    })
    .unwrap_or_default();
    f.chat_model = chat;
    f.image_model = image;
}

/// Read the accounts' status again, for the dialog and the windows.
fn reread(app: &mut PhotocraftApp) {
    let status = with_accounts(app, |a| a.status()).unwrap_or_default();
    if let Some(f) = app.ai.accounts.as_mut() {
        f.status = status;
    }
    refresh(app);
}

/// Close it: the models typed are kept, a key typed and not connected is dropped, a check
/// running is stopped.
pub fn close(app: &mut PhotocraftApp) {
    save_models(app);
    app.ai.accounts = None;
    refresh(app);
}

fn note(app: &mut PhotocraftApp, error: bool, text: String) {
    if let Some(f) = app.ai.accounts.as_mut() {
        f.message = Some((error, text));
    }
}

/// Type `key` into the key field (tests, the control channel never: keys are typed by people).
pub fn set_typed_key(app: &mut PhotocraftApp, key: &str) {
    if let Some(f) = app.ai.accounts.as_mut() {
        wipe(&mut f.key);
        f.key.push_str(key);
    }
}

/// Connect: check the typed key with the provider on a worker thread and store it when the
/// provider accepts it. The field is wiped at once.
pub fn connect(app: &mut PhotocraftApp) {
    let Some(store) = app.ai.store.clone() else { return note(app, true, tl!("AI Accounts are not available in this build.").into()) };
    let Some(f) = app.ai.accounts.as_mut() else { return };
    if f.busy.is_some() {
        return;
    }
    let p = f.provider;
    let mut typed = std::mem::take(&mut f.key);
    if typed.trim().is_empty() {
        return note(app, true, tl!("Enter an API key.").into());
    }
    let provider = with_accounts(app, |a| a.provider_with_key(p, typed.trim()));
    let provider = match provider {
        Some(Ok(provider)) => provider,
        Some(Err(e)) => {
            wipe(&mut typed);
            return note(app, true, message(&e.message));
        }
        None => return,
    };
    let cancel = CancelToken::new();
    let token = cancel.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let spawned = std::thread::Builder::new().name("pigment-ai-connect".into()).spawn(move || {
        let stop = || token.is_cancelled();
        let r = provider.list_models(&stop).and_then(|models| {
            let mut a = store.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            a.set_key(p, typed.trim())?;
            a.cache_catalog(p, models.clone());
            Ok(models)
        });
        wipe(&mut typed);
        let _ = tx.send(r);
    });
    match spawned {
        Ok(_) => {
            if let Some(f) = app.ai.accounts.as_mut() {
                f.busy = Some(Busy { work: Work::Connect, provider: p, rx, cancel });
                f.message = None;
            }
        }
        Err(e) => note(app, true, e.to_string()),
    }
}

/// Test Connection: list the provider's models with the stored key, on a worker thread.
pub fn test(app: &mut PhotocraftApp) {
    let Some(store) = app.ai.store.clone() else { return };
    let Some(p) = app.ai.accounts.as_ref().filter(|f| f.busy.is_none()).map(|f| f.provider) else { return };
    let provider = match with_accounts(app, |a| a.provider(p)) {
        Some(Ok(provider)) => provider,
        Some(Err(e)) => return note(app, true, message(&e.message)),
        None => return,
    };
    let cancel = CancelToken::new();
    let token = cancel.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let spawned = std::thread::Builder::new().name("pigment-ai-test".into()).spawn(move || {
        let stop = || token.is_cancelled();
        let r = provider.list_models(&stop);
        if let Ok(models) = &r {
            store.lock().unwrap_or_else(std::sync::PoisonError::into_inner).cache_catalog(p, models.clone());
        }
        let _ = tx.send(r);
    });
    match spawned {
        Ok(_) => {
            if let Some(f) = app.ai.accounts.as_mut() {
                f.busy = Some(Busy { work: Work::Test, provider: p, rx, cancel });
                f.message = None;
            }
        }
        Err(e) => note(app, true, e.to_string()),
    }
}

/// What the worker is doing, if anything.
pub fn busy(app: &PhotocraftApp) -> Option<Work> {
    app.ai.accounts.as_ref().and_then(|f| f.busy.as_ref()).map(|b| b.work)
}

/// Take the worker's answer when it has one (once per frame).
pub fn poll(app: &mut PhotocraftApp) {
    let Some(f) = app.ai.accounts.as_mut() else { return };
    let Some(b) = &f.busy else { return };
    let r = match b.rx.try_recv() {
        Ok(r) => r,
        Err(TryRecvError::Empty) => return,
        Err(TryRecvError::Disconnected) => Err(AiError::cancelled()),
    };
    let (work, p) = (b.work, b.provider);
    f.busy = None;
    finished(app, work, p, r);
}

/// Wait up to `timeout` for the worker's answer and take it (tests). `false` when none came.
pub fn wait(app: &mut PhotocraftApp, timeout: Duration) -> bool {
    let Some(f) = app.ai.accounts.as_mut() else { return false };
    let Some(b) = &f.busy else { return false };
    let r = match b.rx.recv_timeout(timeout) {
        Ok(r) => r,
        Err(_) => return false,
    };
    let (work, p) = (b.work, b.provider);
    f.busy = None;
    finished(app, work, p, r);
    true
}

fn finished(app: &mut PhotocraftApp, work: Work, p: ProviderId, r: Result<Vec<ModelInfo>, AiError>) {
    reread(app);
    match r {
        Ok(models) => {
            let n = models.len();
            if let Some(f) = app.ai.accounts.as_mut() {
                f.catalog.insert(p.id(), models);
            }
            let text = match work {
                Work::Connect => crate::i18n::fmt(tl!("{provider} connected."), &[("provider", p.label())]),
                Work::Test => crate::i18n::fmt(
                    &crate::i18n::trn(
                        crate::i18n::current(),
                        n as u64,
                        "Connected to {provider}: {n} model available.",
                        "Connected to {provider}: {n} models available.",
                    ),
                    &[("provider", p.label())],
                ),
            };
            note(app, false, text);
        }
        Err(e) if e.kind == pigment_genai::ErrorKind::Cancelled => {}
        Err(e) => note(app, true, message(&e.message)),
    }
}

/// Remove Key ("Sign out" in JavaScript Pigment).
pub fn remove_key(app: &mut PhotocraftApp) {
    let Some(p) = app.ai.accounts.as_ref().map(|f| f.provider) else { return };
    let r = with_accounts(app, |a| a.clear_key(p));
    reread(app);
    match r {
        Some(Ok(())) => note(app, false, crate::i18n::fmt(tl!("Key removed for {provider}."), &[("provider", p.label())])),
        Some(Err(e)) => note(app, true, message(&e.message)),
        None => {}
    }
}

/// Keep the models typed for the provider shown (an empty field goes back to automatic).
fn save_models(app: &mut PhotocraftApp) {
    let Some(f) = app.ai.accounts.as_ref() else { return };
    let (p, chat, image) = (f.provider, f.chat_model.trim().to_string(), f.image_model.trim().to_string());
    let changed = with_accounts(app, |a| {
        let m = a.settings.models(p);
        m.chat_model.as_deref().unwrap_or_default() != chat || m.image_model.as_deref().unwrap_or_default() != image
    });
    if changed != Some(true) {
        return;
    }
    if let Some(Err(e)) = with_accounts(app, |a| a.set_models(p, Some(&chat), Some(&image))) {
        note(app, true, message(&e.message));
    }
    reread(app);
}

/// Saves a setting through `f`, reporting a failed save in the dialog.
fn save_with(app: &mut PhotocraftApp, f: impl FnOnce(&mut pigment_genai::AiAccounts) -> pigment_genai::Result<()>) {
    if let Some(Err(e)) = with_accounts(app, f) {
        note(app, true, message(&e.message));
    }
    reread(app);
}

/// The one-time agreement (and its withdrawal).
pub fn set_consent(app: &mut PhotocraftApp, yes: bool) {
    save_with(app, |a| a.set_consented(yes));
}

/// "Allow agents to run AI commands".
pub fn set_allow_agents(app: &mut PhotocraftApp, yes: bool) {
    save_with(app, |a| a.set_allow_agents(yes));
}

fn switch(app: &mut PhotocraftApp, p: ProviderId) {
    save_models(app);
    let Some(mut f) = app.ai.accounts.take() else { return };
    wipe(&mut f.key);
    f.provider = p;
    f.message = None;
    load_models(app, &mut f);
    app.ai.accounts = Some(f);
}

/// Choose the provider the dialog shows.
pub fn show_provider(app: &mut PhotocraftApp, p: ProviderId) {
    switch(app, p);
}

/// What a click in AI Accounts asked for, done after it is drawn.
enum Act {
    Switch(ProviderId),
    Connect,
    RemoveKey,
    Test,
    Default(ProviderId),
    Consent(bool),
    Agents(bool),
    Timeout(u64),
    SaveModels,
    Link(&'static str),
    Close,
}

/// Draw AI Accounts while it is open.
pub(crate) fn show(app: &mut PhotocraftApp, ctx: &egui::Context) {
    poll(app);
    if app.ai.accounts.is_none() {
        return;
    }
    let id = egui::Id::unique("pigment-ai-accounts");
    let mut acts = vec![];
    let modal = egui::Modal::new(id).show(ctx, |ui| {
        ui.set_width(500.0);
        ui.label(egui::RichText::new(tl!("AI Accounts")).font(crate::theme::semibold(15.0)));
        crate::widgets::hairline(ui);
        ui.add_space(8.0);
        body(app, ui, &mut acts);
    });
    // Above Preferences when it was opened from there.
    ctx.move_to_top(modal.response.layer_id);
    let typing = app.ai.accounts.as_ref().is_some_and(|f| !f.key.is_empty());
    if modal.should_close() && !typing {
        acts.push(Act::Close);
    }
    // Keys, the agreement and the agents' permission are the person's: synthetic input (an agent
    // clicking through the control channel) only switches tabs and closes.
    if app.automation_input {
        acts.retain(|a| matches!(a, Act::Switch(_) | Act::Close));
    }
    for act in acts {
        match act {
            Act::Switch(p) => switch(app, p),
            Act::Connect => connect(app),
            Act::RemoveKey => remove_key(app),
            Act::Test => test(app),
            Act::Default(p) => save_with(app, |a| a.set_default_provider(p)),
            Act::Consent(yes) => set_consent(app, yes),
            Act::Agents(yes) => set_allow_agents(app, yes),
            Act::Timeout(secs) => save_with(app, |a| {
                a.settings.timeout_secs = secs.clamp(10, 600);
                a.save()
            }),
            Act::SaveModels => save_models(app),
            Act::Link(url) => {
                crate::links::open(app, ctx, url);
            }
            Act::Close => close(app),
        }
    }
    if app.ai.accounts.as_ref().is_none_or(|f| f.key.is_empty()) {
        ctx.data_mut(|d| d.remove::<egui::text_edit::TextEditState>(key_field_id()));
    }
    if app.ai.accounts.as_ref().is_some_and(|f| f.busy.is_some()) {
        ctx.request_repaint_after(Duration::from_millis(100));
    }
}

fn body(app: &mut PhotocraftApp, ui: &mut egui::Ui, acts: &mut Vec<Act>) {
    let t = Tokens::get(ui.ctx());
    let dim = |s: &str| egui::RichText::new(s).color(t.text_dim);
    if app.ai.store.is_none() {
        ui.label(tl!("AI Accounts are not available in this build."));
        ui.add_space(8.0);
        if crate::widgets::primary_button(ui, tl!("Done"), 72.0).clicked() {
            acts.push(Act::Close);
        }
        return;
    }
    if let Some(reason) = app.ai.accounts.as_ref().and_then(|f| f.reason.clone()) {
        ui.label(egui::RichText::new(reason).color(t.accent_text));
        ui.add_space(4.0);
    }
    ui.label(tl!("Pigment's AI commands use your own OpenAI or Google Gemini account."));
    ui.label(dim(tl!(
        "Requests go straight from this computer to the provider you choose; Pigment has no server in between. The provider bills your account for each request, including one you stop after it was sent."
    )));
    ui.label(dim(tl!("What is sent: your prompt and, when a feature needs it, the image, the layer or the selection. Never your key or your files.")));
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
        if crate::widgets::primary_button(ui, tl!("Done"), 72.0).clicked() {
            acts.push(Act::Close);
        }
    });
}

fn provider_tabs(app: &PhotocraftApp, ui: &mut egui::Ui, acts: &mut Vec<Act>) {
    let shown = app.ai.accounts.as_ref().map_or(ProviderId::OpenAi, |f| f.provider);
    ui.horizontal(|ui| {
        for p in ProviderId::ALL {
            if ui.selectable_label(shown == p, p.label()).clicked() && shown != p {
                acts.push(Act::Switch(p));
            }
        }
    });
}

/// What AI Accounts calls the place keys are kept in.
pub fn store_name(backend: &str) -> &'static str {
    match backend {
        "macOS Keychain" => tl!("the macOS Keychain"),
        "Windows Credential Manager" => tl!("the Windows Credential Manager"),
        "memory" => tl!("memory, for this session only"),
        _ => tl!("ai-keys.json in Pigment's settings folder, readable only by you (not encrypted)"),
    }
}

fn key_rows(app: &mut PhotocraftApp, ui: &mut egui::Ui, acts: &mut Vec<Act>) {
    let t = Tokens::get(ui.ctx());
    let Some(f) = app.ai.accounts.as_mut() else { return };
    let p = f.provider;
    let status = f.status.iter().find(|s| s.provider == p).cloned();
    let connected = status.as_ref().is_some_and(|s| s.connected);
    let state = match &status {
        Some(s) if s.connected && !s.hint.is_empty() => crate::i18n::fmt(
            tl!("Connected with an API key (ends in …{hint}), kept in {store}."),
            &[("hint", s.hint.as_str()), ("store", store_name(s.backend))],
        ),
        Some(s) if s.connected => crate::i18n::fmt(tl!("Connected with an API key, kept in {store}."), &[("store", store_name(s.backend))]),
        _ => tl!("Not connected.").to_string(),
    };
    ui.label(egui::RichText::new(state).color(if connected { t.text } else { t.text_dim }));
    if p == ProviderId::Gemini {
        ui.label(
            egui::RichText::new(tl!("Google offers no plan-based sign-in for other apps, so Gemini always uses an API key from Google AI Studio."))
                .color(t.text_faint)
                .small(),
        );
    }
    let busy = f.busy.as_ref().map(|b| b.work);
    ui.horizontal(|ui| {
        let label = ui.label(tl!("API key"));
        // Masked and never filled in: a saved key is not shown again.
        let hint = if p == ProviderId::OpenAi { "sk-…" } else { "AIza…" };
        let r = ui.add(egui::TextEdit::singleline(&mut f.key).id(key_field_id()).password(true).desired_width(250.0).hint_text(hint)).labelled_by(label.id);
        let enter = r.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
        let label = if busy == Some(Work::Connect) { tl!("Checking…") } else { tl!("Connect") };
        let can = !f.key.trim().is_empty() && busy.is_none();
        let clicked = ui.add_enabled_ui(can, |ui| crate::widgets::primary_button(ui, label, 84.0)).inner.clicked();
        if (clicked || enter) && can {
            acts.push(Act::Connect);
        }
    });
    ui.horizontal(|ui| {
        let r = ui.add_enabled(connected && busy.is_none(), egui::Button::new(tl!("Test Connection")));
        if r.clicked() {
            acts.push(Act::Test);
        }
        if busy.is_some() {
            ui.add(egui::Spinner::new().size(14.0));
        }
        if ui.add_enabled(connected && busy.is_none(), egui::Button::new(tl!("Remove Key"))).clicked() {
            acts.push(Act::RemoveKey);
        }
        let page = key_page(p);
        if ui.link(tl!("Get a key…")).on_hover_text(page).clicked() {
            acts.push(Act::Link(page));
        }
    });
    let mut use_it = status.as_ref().is_some_and(|s| s.is_default);
    if ui.checkbox(&mut use_it, tl!("Preferred provider for the AI commands")).changed() && use_it {
        acts.push(Act::Default(p));
    }
}

fn model_rows(app: &mut PhotocraftApp, ui: &mut egui::Ui, acts: &mut Vec<Act>) {
    let Some(f) = app.ai.accounts.as_mut() else { return };
    let p = f.provider;
    let catalog = f.catalog.get(p.id()).cloned().unwrap_or_default();
    let status = f.status.iter().find(|s| s.provider == p).cloned();
    egui::Grid::new("pigment-ai-models").num_columns(3).spacing([8.0, 6.0]).show(ui, |ui| {
        let rows = [
            (tl!("Chat model"), &mut f.chat_model, ModelKind::Chat, status.as_ref().map(|s| s.chat_model.clone()).unwrap_or_default()),
            (tl!("Image model"), &mut f.image_model, ModelKind::Image, status.as_ref().map(|s| s.image_model.clone()).unwrap_or_default()),
        ];
        for (label, field, want, shown) in rows {
            let l = ui.label(label);
            let hint = crate::i18n::fmt(tl!("automatic ({model})"), &[("model", &shown)]);
            let r = ui.add_sized(egui::vec2(230.0, 22.0), egui::TextEdit::singleline(field).hint_text(hint).char_limit(120)).labelled_by(l.id);
            if r.lost_focus() {
                acts.push(Act::SaveModels);
            }
            match pick_model(p, &catalog, want) {
                Some(m) if *field != m => {
                    if ui.small_button(tl!("Use Suggested")).on_hover_text(m.as_str()).clicked() {
                        *field = m;
                        acts.push(Act::SaveModels);
                    }
                }
                _ => {
                    if ui.small_button(tl!("Automatic")).clicked() {
                        field.clear();
                        acts.push(Act::SaveModels);
                    }
                }
            }
            ui.end_row();
        }
    });
}

fn general_rows(app: &mut PhotocraftApp, ui: &mut egui::Ui, acts: &mut Vec<Act>) {
    let t = Tokens::get(ui.ctx());
    let (consented, agents) = with_accounts(app, |a| (a.settings.consented, a.settings.allow_agents)).unwrap_or_default();
    let Some(f) = app.ai.accounts.as_mut() else { return };
    ui.horizontal(|ui| {
        let l = ui.label(tl!("Request timeout:"));
        if ui.add(egui::DragValue::new(&mut f.timeout).range(10..=600).suffix(" s")).labelled_by(l.id).changed() {
            acts.push(Act::Timeout(f.timeout));
        }
    });
    ui.add_space(6.0);
    let mut agreed = consented;
    if ui.checkbox(&mut agreed, tl!(CONSENT)).changed() {
        acts.push(Act::Consent(agreed));
    }
    let mut allow = agents;
    if ui.checkbox(&mut allow, tl!("Allow agents to run AI commands")).changed() {
        acts.push(Act::Agents(allow));
    }
    ui.label(
        egui::RichText::new(tl!("Agents (MCP, the control channel, pigment-cli) could otherwise spend money on your account. Off until you turn it on."))
            .color(t.text_faint)
            .small(),
    );
}
