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
//!
//! **Sign in with ChatGPT** (OpenAI's tab, marked experimental; `pigment_genai::chatgpt`) uses
//! the person's ChatGPT plan for chat models only. The button starts the attempt and opens the
//! browser; while it waits the tab shows Copy Link, Cancel and a field for the address the
//! browser landed on (a browser on another computer, or every loopback port taken). The tokens
//! stay in the key store: the interface holds the address to open and, afterwards, the account's
//! e-mail address. With the feature off ([`pigment_genai::chatgpt::ENABLED`], or
//! `"chatgptSignIn": false` in `ai.json`) the tab has no such rows.

use std::collections::BTreeMap;
use std::sync::mpsc::{Receiver, TryRecvError};
use std::time::Duration;

use photocraft_engine::generative::ProviderId;
use pigment_genai::provider::{ModelInfo, ModelKind, pick_model};
use pigment_genai::{AccountStatus, AiError, CancelToken, Method};

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
    /// Finishing Sign in with ChatGPT with the pasted address (the code exchange).
    SignIn,
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
    /// Sign in with ChatGPT: the pasted address of the page the browser landed on. Wiped once
    /// used, and with the dialog.
    pub callback: String,
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
        wipe(&mut self.callback);
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
            callback: String::new(),
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
    // A model that is not a model id keeps the dialog open, with why, so it isn't lost unseen.
    if !save_models(app) {
        return;
    }
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

/// Whether AI Accounts offers Sign in with ChatGPT (the feature is on for these accounts).
pub fn sign_in_offered(app: &PhotocraftApp) -> bool {
    app.ai.chatgpt.as_ref().is_some_and(|c| c.enabled())
}

/// The sign-in attempt in progress, as the dialog shows it.
pub fn sign_in_status(app: &PhotocraftApp) -> pigment_genai::chatgpt::SignInStatus {
    app.ai.chatgpt.as_ref().map(|c| c.status()).unwrap_or_default()
}

/// Sign in with ChatGPT: start the attempt (the loopback listener) and return the address to
/// open in a browser. Nothing is sent from here; the browser does the signing in.
pub fn start_sign_in(app: &mut PhotocraftApp) -> Option<String> {
    match with_accounts(app, |a| a.sign_in(None))? {
        Ok(st) => {
            app.ai.sign_in_watch = true;
            if let Some(f) = app.ai.accounts.as_mut() {
                f.message = None;
            }
            st.url
        }
        Err(e) => {
            note(app, true, message(&e.message));
            None
        }
    }
}

/// Cancel the sign-in attempt in progress.
pub fn cancel_sign_in(app: &mut PhotocraftApp) {
    if let Some(c) = &app.ai.chatgpt {
        c.cancel();
    }
    if let Some(f) = app.ai.accounts.as_mut() {
        wipe(&mut f.callback);
        f.message = None;
    }
}

/// Type `address` into the pasted-address field (tests).
pub fn set_pasted_address(app: &mut PhotocraftApp, address: &str) {
    if let Some(f) = app.ai.accounts.as_mut() {
        wipe(&mut f.callback);
        f.callback.push_str(address);
    }
}

/// Use: finish the sign-in with the pasted address. The code exchange runs on a worker thread.
pub fn use_pasted_address(app: &mut PhotocraftApp) {
    let Some(chatgpt) = app.ai.chatgpt.clone() else { return };
    let Some(f) = app.ai.accounts.as_mut() else { return };
    if f.busy.is_some() {
        return;
    }
    let mut pasted = std::mem::take(&mut f.callback);
    let p = f.provider;
    let (tx, rx) = std::sync::mpsc::channel();
    let spawned = std::thread::Builder::new().name("pigment-ai-sign-in-paste".into()).spawn(move || {
        let r = chatgpt.complete_manual(&pasted).map(|_| Vec::new());
        wipe(&mut pasted);
        let _ = tx.send(r);
    });
    match spawned {
        Ok(_) => {
            app.ai.sign_in_watch = true;
            if let Some(f) = app.ai.accounts.as_mut() {
                f.busy = Some(Busy { work: Work::SignIn, provider: p, rx, cancel: CancelToken::new() });
                f.message = None;
            }
        }
        Err(e) => note(app, true, e.to_string()),
    }
}

/// Sign Out of ChatGPT: the tokens leave the key store. Nothing is revoked at OpenAI.
pub fn sign_out(app: &mut PhotocraftApp) {
    let r = with_accounts(app, |a| a.sign_out());
    reread(app);
    super::assistant::forget_models(app);
    match r {
        Some(Ok(())) => note(app, false, tl!("Signed out of ChatGPT.").into()),
        Some(Err(e)) => note(app, true, message(&e.message)),
        None => {}
    }
}

/// Take the outcome of a sign-in attempt started here, once it has one: the account shows in
/// the dialog, the menus and the windows, and a failure is said (in the dialog, or in the
/// status bar when it is closed).
fn poll_sign_in(app: &mut PhotocraftApp) {
    if !app.ai.sign_in_watch {
        return;
    }
    let Some(chatgpt) = app.ai.chatgpt.clone() else { return };
    if chatgpt.status().pending {
        return;
    }
    app.ai.sign_in_watch = false;
    let Some(outcome) = chatgpt.take_outcome() else { return };
    reread(app);
    let (error, text) = match outcome {
        Ok(who) => {
            let text = match who.email.as_deref() {
                Some(email) => crate::i18n::fmt(tl!("Signed in with ChatGPT as {email}."), &[("email", email)]),
                None => tl!("Signed in with ChatGPT.").to_string(),
            };
            (false, text)
        }
        Err(e) if e.kind == pigment_genai::ErrorKind::Cancelled => return,
        Err(e) => (true, message(&e.message)),
    };
    if app.ai.accounts.is_some() {
        note(app, error, text);
    } else {
        app.ui.status = text;
    }
}

/// What the worker is doing, if anything.
pub fn busy(app: &PhotocraftApp) -> Option<Work> {
    app.ai.accounts.as_ref().and_then(|f| f.busy.as_ref()).map(|b| b.work)
}

/// Take the worker's answer when it has one (once per frame), and a sign-in attempt's outcome.
pub fn poll(app: &mut PhotocraftApp) {
    poll_sign_in(app);
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
    super::assistant::forget_models(app);
    if work == Work::SignIn {
        // A sign-in that ended (signed in, or failed for good) is said by `poll_sign_in`; an
        // address that was refused while the attempt goes on (another attempt's, unreadable)
        // is said here.
        if let Err(e) = r {
            note(app, true, message(&e.message));
        }
        return poll_sign_in(app);
    }
    match r {
        Ok(models) => {
            let n = models.len();
            if let Some(f) = app.ai.accounts.as_mut() {
                f.catalog.insert(p.id(), models);
            }
            let text = match work {
                Work::Connect => crate::i18n::fmt(tl!("{provider} connected."), &[("provider", p.label())]),
                Work::SignIn => return,
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
    super::assistant::forget_models(app);
    match r {
        Some(Ok(())) => note(app, false, crate::i18n::fmt(tl!("Key removed for {provider}."), &[("provider", p.label())])),
        Some(Err(e)) => note(app, true, message(&e.message)),
        None => {}
    }
}

/// Keep the models typed for the provider shown (an empty field goes back to automatic). Each
/// field is saved on its own, so a valid one is kept beside one that is not a model id. `false`
/// when one could not be saved: the dialog says why.
fn save_models(app: &mut PhotocraftApp) -> bool {
    let Some(f) = app.ai.accounts.as_ref() else { return true };
    let (p, chat, image) = (f.provider, f.chat_model.trim().to_string(), f.image_model.trim().to_string());
    let Some((chat_changed, image_changed)) = with_accounts(app, |a| {
        let m = a.settings.models(p);
        (m.chat_model.as_deref().unwrap_or_default() != chat, m.image_model.as_deref().unwrap_or_default() != image)
    }) else {
        return true;
    };
    if !chat_changed && !image_changed {
        return true;
    }
    let mut error = None;
    if chat_changed && let Some(Err(e)) = with_accounts(app, |a| a.set_models(p, Some(&chat), None)) {
        error = Some(e);
    }
    if image_changed && let Some(Err(e)) = with_accounts(app, |a| a.set_models(p, None, Some(&image))) {
        error = error.or(Some(e));
    }
    reread(app);
    match error {
        Some(e) => {
            note(app, true, message(&e.message));
            false
        }
        None => true,
    }
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
    if !save_models(app) {
        return;
    }
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
    /// Sign in with ChatGPT: start, copy the address to open, use the pasted one, cancel, sign out.
    SignIn,
    SignInCopy,
    SignInUse,
    SignInCancel,
    SignOut,
    Close,
}

/// Draw AI Accounts while it is open.
pub(crate) fn show(app: &mut PhotocraftApp, ctx: &egui::Context) {
    poll(app);
    if app.ai.sign_in_watch {
        // The callback lands without any input here: look again soon.
        ctx.request_repaint_after(Duration::from_millis(250));
    }
    if app.ai.accounts.is_none() {
        return;
    }
    let id = egui::Id::unique("pigment-ai-accounts");
    let mut acts = vec![];
    let before = app.ai.accounts.as_ref().map(|f| (f.chat_model.clone(), f.image_model.clone(), f.timeout));
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
    // The model fields and the timeout are edited while drawn: what synthetic input typed into
    // them is put back, so Switch and Close (which keep the models) save only the person's.
    if app.automation_input {
        acts.retain(|a| matches!(a, Act::Switch(_) | Act::Close));
        if let (Some(f), Some((chat, image, timeout))) = (app.ai.accounts.as_mut(), before) {
            (f.chat_model, f.image_model, f.timeout) = (chat, image, timeout);
        }
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
            Act::Timeout(secs) => save_with(app, |a| a.update(|s| s.timeout_secs = secs.clamp(10, 600))),
            Act::SaveModels => {
                save_models(app);
            }
            Act::Link(url) => {
                crate::links::open(app, ctx, url);
            }
            Act::SignIn => {
                if let Some(url) = start_sign_in(app) {
                    open_sign_in_page(app, ctx, &url);
                }
            }
            Act::SignInCopy => match sign_in_status(app).url {
                Some(url) => {
                    ctx.copy_text(url);
                    note(app, false, tl!("Link copied; open it in any browser.").into());
                }
                None => note(app, true, tl!("The sign-in link is not ready yet.").into()),
            },
            Act::SignInUse => use_pasted_address(app),
            Act::SignInCancel => cancel_sign_in(app),
            Act::SignOut => sign_out(app),
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

/// Open the sign-in page in the system browser. The address is not written to the status bar
/// (it names the attempt, which is nobody else's business); Copy Link gives it to the person.
fn open_sign_in_page(app: &mut PhotocraftApp, ctx: &egui::Context, url: &str) {
    let opened = app.services.open_url.as_ref().map(|f| f(url).is_ok()).unwrap_or(false);
    if !opened {
        ctx.open_url(egui::OpenUrl::new_tab(url));
    }
    app.ui.status = tl!("Opened the ChatGPT sign-in page in your browser").to_string();
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
    let method = status.as_ref().and_then(|s| s.method);
    let state = match &status {
        Some(s) if method == Some(Method::Chatgpt) => {
            let mut text = tl!("Signed in with ChatGPT").to_string();
            if let Some(email) = &s.email {
                text.push_str(" · ");
                text.push_str(email);
            }
            if s.plan == Some(false) {
                text.push_str(" · ");
                text.push_str(tl!("plan access not granted"));
            }
            text.push_str(". ");
            text.push_str(&crate::i18n::fmt(tl!("The sign-in is kept in {store}."), &[("store", store_name(s.backend))]));
            text
        }
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
        if ui.add_enabled(method == Some(Method::ApiKey) && busy.is_none(), egui::Button::new(tl!("Remove Key"))).clicked() {
            acts.push(Act::RemoveKey);
        }
        let page = key_page(p);
        if ui.link(tl!("Get a key…")).on_hover_text(page).clicked() {
            acts.push(Act::Link(page));
        }
    });
    if p == ProviderId::OpenAi && sign_in_offered(app) {
        sign_in_rows(app, ui, acts, method);
    }
    let mut use_it = status.as_ref().is_some_and(|s| s.is_default);
    if ui.checkbox(&mut use_it, tl!("Preferred provider for the AI commands")).changed() && use_it {
        acts.push(Act::Default(p));
    }
}

/// OpenAI's Sign in with ChatGPT rows: the button, the waiting card, or Sign Out.
fn sign_in_rows(app: &mut PhotocraftApp, ui: &mut egui::Ui, acts: &mut Vec<Act>, method: Option<Method>) {
    let t = Tokens::get(ui.ctx());
    let faint = |s: &str| egui::RichText::new(s).color(t.text_faint).small();
    let pending = sign_in_status(app);
    let Some(f) = app.ai.accounts.as_mut() else { return };
    let busy = f.busy.is_some();
    ui.add_space(4.0);
    if method == Some(Method::Chatgpt) {
        ui.horizontal(|ui| {
            if ui.add_enabled(!busy, egui::Button::new(tl!("Sign Out"))).clicked() {
                acts.push(Act::SignOut);
            }
            ui.label(egui::RichText::new(tl!("Experimental")).color(t.accent_text).small());
        });
        ui.label(faint(tl!(
            "A ChatGPT plan covers chat models only: the Assistant and Describe Image. Image models (Generative Fill, Generate Image and the others) need an API key; connecting one replaces the sign-in."
        )));
    } else if pending.pending {
        ui.label(tl!("Waiting for your browser… finish signing in to ChatGPT there, then come back."));
        if let Some(warning) = &pending.warning {
            ui.label(egui::RichText::new(warning).color(ui.visuals().warn_fg_color));
        }
        ui.horizontal(|ui| {
            if ui.button(tl!("Copy Link")).clicked() {
                acts.push(Act::SignInCopy);
            }
            if ui.button(tl!("Cancel")).clicked() {
                acts.push(Act::SignInCancel);
            }
            if busy {
                ui.add(egui::Spinner::new().size(14.0));
            }
        });
        let label = ui.label(tl!("Browser on another computer? Paste the callback address here:"));
        ui.horizontal(|ui| {
            let hint = tl!("Paste the address of the page the browser landed on");
            let r = ui.add(egui::TextEdit::singleline(&mut f.callback).desired_width(330.0).hint_text(hint).char_limit(8192)).labelled_by(label.id);
            let enter = r.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
            let can = !f.callback.trim().is_empty() && !busy;
            let clicked = ui.add_enabled(can, egui::Button::new(tl!("Use"))).clicked();
            if (clicked || enter) && can {
                acts.push(Act::SignInUse);
            }
        });
    } else if method.is_none() {
        ui.horizontal(|ui| {
            if ui.add_enabled(!busy, egui::Button::new(tl!("Sign in with ChatGPT"))).clicked() {
                acts.push(Act::SignIn);
            }
            ui.label(egui::RichText::new(tl!("Experimental")).color(t.accent_text).small());
        });
        ui.label(faint(tl!(
            "Uses your ChatGPT Plus or Pro plan for chat models: the Assistant and Describe Image. Image models need an API key. This sign-in is not a documented OpenAI service and may stop working."
        )));
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
        // A ChatGPT sign-in runs no image model: the field says so and takes nothing.
        let chat_only = status.as_ref().is_some_and(|s| s.method == Some(Method::Chatgpt));
        for (label, field, want, shown) in rows {
            let l = ui.label(label);
            let needs_key = chat_only && want == ModelKind::Image;
            let hint = if needs_key { tl!("Needs an API key").to_string() } else { crate::i18n::fmt(tl!("automatic ({model})"), &[("model", &shown)]) };
            let edit = egui::TextEdit::singleline(field).hint_text(hint).char_limit(120).interactive(!needs_key);
            let r = ui.add_sized(egui::vec2(230.0, 22.0), edit).labelled_by(l.id);
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
