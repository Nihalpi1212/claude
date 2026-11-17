//! Pigment: generative AI in the interface (`docs/generative-ai.md`), on top of the engine's
//! `ai.*` commands and the `pigment-genai` backend.
//!
//! * **Where the features are** (Photoshop's places; there is no AI menu): Edit › Generative
//!   Fill…, Generate Image…, Sky Replacement… and AI Accounts…; Layer › Remove Background,
//!   Remove Background with AI Provider and Generate Background…; Image › Describe Image…;
//!   Window › Assistant; Generative Expand in the Crop tool's contextual task bar. Every one is also in the command
//!   palette ([`menu_items`]), Generative Fill in the selection context menu and in the task bar
//!   under a selection, Generate Background in the task bar after Remove Background.
//! * **Nothing is sent before Generate.** A menu item opens the Generate window
//!   ([`generate`]) on its feature; typing, choosing options and saving a key send nothing.
//!   Remove Background runs locally unless "with AI Provider" is chosen, and Describe Image asks
//!   at once (both after checking a provider and the one-time agreement first).
//! * **Requests run as background jobs** (the engine's `ai.*` commands through
//!   [`crate::jobs_ui::run`]): the status bar shows the progress and Cancel, nothing modal, and
//!   the result lands as one undo step. The Generate window shows Stop, the elapsed time, the
//!   error with what fixes it (Open AI Accounts…, Try Again).
//! * **AI Accounts** ([`accounts`]): the keys, typed into a masked field kept here (never in
//!   [`crate::UiState`], a dialog's fields or the preferences), the models, the timeout, the
//!   one-time agreement and "Allow agents to run AI commands"; and for OpenAI the experimental
//!   Sign in with ChatGPT (chat models only), whose tokens the interface never holds.
//! * **Window › Assistant** ([`assistant`]): a chat about the active document whose model edits
//!   it through tools ([`assistant_tools`]), each an ordinary undoable command; a conversation
//!   per document, kept in memory only.
//! * **Agents** (the control channel, MCP through the open window, synthetic input) may run a
//!   command that sends only while "Allow agents to run AI commands" is on: [`gate`] refuses the
//!   agent's own request, and the session's backend (`AppBackend`) a command the agent reaches
//!   through another one (a script's step). An action never sends, whoever plays it (the engine).
//!
//! The browser build has no provider: this module keeps its signatures there and does nothing.

#[cfg(not(target_arch = "wasm32"))]
pub mod accounts;
#[cfg(not(target_arch = "wasm32"))]
pub mod assistant;
#[cfg(not(target_arch = "wasm32"))]
pub mod assistant_tools;
#[cfg(not(target_arch = "wasm32"))]
pub mod describe;
#[cfg(not(target_arch = "wasm32"))]
pub mod generate;
#[cfg(not(target_arch = "wasm32"))]
pub mod task_bar;

use serde_json::Value;

use crate::PhotocraftApp;
use crate::menus::MenuItem;

/// Edit › AI Accounts… (also Preferences › AI Integrations' button).
pub const ACCOUNTS: &str = "ai.accounts";
/// Layer › Remove Background with AI Provider: `ai.removeBackground` with `"method":"provider"`.
pub const REMOVE_WITH_PROVIDER: &str = "ai.removeBackgroundWithProvider";
pub const FILL: &str = "ai.generativeFill";
pub const EXPAND: &str = "ai.generativeExpand";
pub const GENERATE_IMAGE: &str = "ai.generateImage";
pub const REMOVE_BACKGROUND: &str = "ai.removeBackground";
/// Layer › Generate Background… (the engine's `ai.replaceBackground`).
pub const BACKGROUND: &str = "ai.replaceBackground";
/// Edit › Sky Replacement… (the engine's `ai.replaceSky`).
pub const SKY: &str = "ai.replaceSky";
pub const DESCRIBE: &str = "ai.describe";
/// Window › Assistant: the chat that edits the document.
pub const ASSISTANT: &str = "window.panel.aiAssistant";

/// Where AI Accounts is, as messages name it.
pub const ACCOUNTS_PATH: &str = "Edit › AI Accounts…";

/// The menu items: id, label, menu path, the item it follows. An empty path is the command
/// palette only. Order matters: an item may follow one listed before it.
pub const ITEMS: &[(&str, &str, &[&str], &str)] = &[
    (FILL, "Generative Fill…", &["Edit"], "edit.contentAwareFill"),
    (GENERATE_IMAGE, "Generate Image…", &["Edit"], FILL),
    (SKY, "Sky Replacement…", &["Edit"], GENERATE_IMAGE),
    (ACCOUNTS, "AI Accounts…", &["Edit"], "edit.toolbar"),
    (REMOVE_BACKGROUND, "Remove Background", &["Layer"], "layer.maskAllObjects"),
    (REMOVE_WITH_PROVIDER, "Remove Background with AI Provider", &["Layer"], REMOVE_BACKGROUND),
    (BACKGROUND, "Generate Background…", &["Layer"], REMOVE_WITH_PROVIDER),
    (DESCRIBE, "Describe Image…", &["Image"], "image.calculations"),
    (EXPAND, "Generative Expand…", &[], ""),
    (ASSISTANT, "Assistant", &["Window"], "window.panel.adjustments"),
];

/// The commands of the shell's own (not engine commands).
const SHELL: &[&str] = &[ACCOUNTS, REMOVE_WITH_PROVIDER, ASSISTANT];

/// What the app holds for generative AI. Nothing here is saved with the interface state.
#[derive(Default)]
pub struct AiUi {
    /// The person's accounts, shared with the backend installed on the session ([`install`]).
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) store: Option<std::sync::Arc<std::sync::Mutex<pigment_genai::AiAccounts>>>,
    /// The backend's status as last read ([`refresh`]): reading it may touch the key store, which
    /// the menus and task bars, asked every frame, should not.
    #[cfg(not(target_arch = "wasm32"))]
    pub status: Option<photocraft_engine::generative::BackendStatus>,
    #[cfg(not(target_arch = "wasm32"))]
    pub generate: generate::Panel,
    /// AI Accounts while it is open.
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) accounts: Option<accounts::Form>,
    /// The accounts' ChatGPT sign-in (AI Accounts' experimental row), and whether an attempt
    /// started here is still to be heard of ([`accounts::poll`] takes its outcome, also while
    /// the dialog is closed, so the menus and windows learn of the new account).
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) chatgpt: Option<std::sync::Arc<pigment_genai::chatgpt::ChatGpt>>,
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) sign_in_watch: bool,
    #[cfg(not(target_arch = "wasm32"))]
    pub describe: describe::State,
    /// Window › Assistant: its window, the conversations and the turn being worked on.
    #[cfg(not(target_arch = "wasm32"))]
    pub assistant: assistant::State,
    /// The task bar's Generative Fill prompt.
    #[cfg(not(target_arch = "wasm32"))]
    pub bar_prompt: String,
    /// Remove Background just ran: (document, revision after it). The task bar offers Generate
    /// Background while that document is unchanged.
    #[cfg(not(target_arch = "wasm32"))]
    pub after_remove: Option<(photocraft_doc::DocId, u64)>,
    /// A control request (an agent) is being handled ([`as_agent`]).
    pub(crate) agent: bool,
    /// Whether the command running now runs for an agent, as [`gate`] (asked for every command
    /// the app runs) and [`as_agent`] last found it: the session's backend reads it when a
    /// command that sends starts, so one an agent reaches through another command (a script's
    /// step, which [`gate`] never sees) is held to the same rule.
    pub(crate) agent_now: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

/// Why an agent's AI command is refused.
pub const AGENTS_REFUSED: &str = "Agents may not run AI commands: they send your images and prompts to your AI provider, billed to your account. Turn on \"Allow agents to run AI commands\" in Edit › AI Accounts…";

/// Run `f` as an agent's request: commands that send need "Allow agents to run AI commands".
pub fn as_agent<R>(app: &mut PhotocraftApp, f: impl FnOnce(&mut PhotocraftApp) -> R) -> R {
    let was = std::mem::replace(&mut app.ai.agent, true);
    set_agent_now(app, true);
    let r = f(app);
    app.ai.agent = was;
    set_agent_now(app, was || app.automation_input);
    r
}

pub(crate) fn set_agent_now(app: &PhotocraftApp, agent: bool) {
    app.ai.agent_now.store(agent, std::sync::atomic::Ordering::SeqCst);
}

/// The refusal for an agent (a control request, synthetic input) running `id` with `params`
/// when it would send to a provider and "Allow agents to run AI commands" is off. The person's
/// own clicks and keys always pass.
pub fn gate(app: &PhotocraftApp, id: &str, params: &Value) -> Result<(), String> {
    let agent = app.ai.agent || app.automation_input;
    set_agent_now(app, agent);
    if !agent || !photocraft_engine::ai_cmds::may_send(id, params) {
        return Ok(());
    }
    if agents_allowed(app) {
        return Ok(());
    }
    Err(AGENTS_REFUSED.to_string())
}

/// "Allow agents to run AI commands", as saved (re-read, so `pigment-cli ai agents` counts too).
#[cfg(not(target_arch = "wasm32"))]
pub fn agents_allowed(app: &PhotocraftApp) -> bool {
    app.ai.store.as_ref().is_some_and(|s| {
        let mut a = s.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        a.reload();
        a.settings.allow_agents
    })
}

#[cfg(target_arch = "wasm32")]
pub fn agents_allowed(_: &PhotocraftApp) -> bool {
    false
}

/// Whether `id` is one of this module's shell commands.
pub fn handles(id: &str) -> bool {
    cfg!(not(target_arch = "wasm32")) && SHELL.contains(&id)
}

/// The item `id` follows in its menu, for this module's items.
pub fn place_after(id: &str) -> Option<&'static str> {
    if cfg!(target_arch = "wasm32") {
        return None;
    }
    ITEMS.iter().find(|i| i.0 == id).map(|i| i.3).filter(|a| !a.is_empty())
}

/// The AI menu items (none in the browser build).
pub fn menu_items(app: &PhotocraftApp) -> Vec<MenuItem> {
    if cfg!(target_arch = "wasm32") {
        return Vec::new();
    }
    ITEMS
        .iter()
        .map(|&(id, label, path, _)| MenuItem {
            id: id.into(),
            label: label.into(),
            path: path.iter().map(|s| s.to_string()).collect(),
            shortcut: None,
            enabled: crate::menus::is_enabled(app, id),
            checked: checked(app, id),
            color: None,
        })
        .collect()
}

/// Whether menu item `id` shows a check mark, for this module's items: Window › Assistant
/// while its window is open. `None` for the rest.
pub fn checked(app: &PhotocraftApp, id: &str) -> Option<bool> {
    #[cfg(not(target_arch = "wasm32"))]
    if id == ASSISTANT {
        return Some(app.ai.assistant.open);
    }
    let _ = (app, id);
    None
}

/// Whether menu item `id` is enabled, for this module's shell commands; `None` for the rest
/// (the engine's `ai.*` commands answer for themselves: a document, a selection, a layer with
/// pixels, a backend). A missing key never dims an item: the window says how to add one.
pub fn is_enabled(app: &PhotocraftApp, id: &str) -> Option<bool> {
    if !handles(id) {
        return None;
    }
    Some(match id {
        REMOVE_WITH_PROVIDER => app.session.generative().is_some() && app.session.is_enabled(REMOVE_BACKGROUND),
        _ => true,
    })
}

#[cfg(not(target_arch = "wasm32"))]
pub use native::*;

#[cfg(target_arch = "wasm32")]
pub use web::*;

#[cfg(target_arch = "wasm32")]
mod web {
    use serde_json::Value;

    use crate::PhotocraftApp;
    use crate::canvas::ViewXform;

    pub fn menu(_: &mut PhotocraftApp, _: &str, _: &Value) -> Option<Result<Value, String>> {
        None
    }

    pub fn on_job_event(_: &mut PhotocraftApp, _: &photocraft_engine::jobs::JobEvent) -> bool {
        false
    }

    pub fn show(_: &mut PhotocraftApp, _: &egui::Context) {}

    pub fn task_bars(_: &mut PhotocraftApp, _: &mut egui::Ui, _: &ViewXform) {}

    pub fn crop_task_bar_item(_: &mut PhotocraftApp, _: &mut egui::Ui) {}

    pub fn preferences_button(_: &mut egui::Ui) -> bool {
        false
    }

    pub fn open_accounts(_: &mut PhotocraftApp) {}
}

#[cfg(not(target_arch = "wasm32"))]
mod native {
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, PoisonError};

    use photocraft_engine::generative::{
        BackendStatus, ChatRequest, ChatTurn, Describe, GenError, GenerativeBackend, ImageEdit, ImageGen, ModelEntry, ModelKind, ProviderId,
    };
    use photocraft_engine::jobs::{JobEvent, JobOutcome};
    use photocraft_raster::Rgba8Image;
    use pigment_genai::{AiAccounts, Caller, GenAiBackend};
    use serde_json::{Value, json};

    use super::{
        ACCOUNTS, ACCOUNTS_PATH, ASSISTANT, BACKGROUND, DESCRIBE, EXPAND, FILL, GENERATE_IMAGE, ITEMS, PhotocraftApp, REMOVE_BACKGROUND, REMOVE_WITH_PROVIDER,
        SKY, accounts, assistant, describe, generate, task_bar,
    };
    use crate::canvas::ViewXform;

    /// Keep the AI accounts in Pigment's settings folder `dir` (the desktop app, at start-up): keys
    /// in the OS credential store or the 0600 `ai-keys.json` there, settings in `ai.json`; and install
    /// the provider backend on the session.
    pub fn install(app: &mut PhotocraftApp, dir: &Path) {
        install_accounts(app, AiAccounts::new(dir));
    }

    /// Install `accounts` (tests: in memory, a local mock server) and the backend over them.
    pub fn install_accounts(app: &mut PhotocraftApp, accounts: AiAccounts) {
        app.ai.chatgpt = Some(Arc::clone(accounts.chatgpt()));
        let store = Arc::new(Mutex::new(accounts));
        app.ai.store = Some(Arc::clone(&store));
        install_backend(app, Arc::new(GenAiBackend::new(store, Caller::Person)));
        generate::starting_provider(app);
    }

    /// Install `backend` on the session (tests: a mock), behind the app's agents gate
    /// ([`AppBackend`]).
    pub fn install_backend(app: &mut PhotocraftApp, backend: Arc<dyn GenerativeBackend>) {
        let gated = AppBackend { inner: backend, agent: Arc::clone(&app.ai.agent_now), store: app.ai.store.clone() };
        app.session.set_generative(Some(Arc::new(gated)));
        refresh(app);
    }

    /// The app's backend: the person's, except that a command started for an agent (a control
    /// or MCP request, synthetic input), or under the session's automation gate, sends only
    /// while "Allow agents to run AI commands" is on. [`super::gate`] refuses an agent's own
    /// request with the same message before it starts; this catches what it never sees: a
    /// command that sends run by another command (a script's step).
    struct AppBackend {
        inner: Arc<dyn GenerativeBackend>,
        agent: Arc<AtomicBool>,
        store: Option<Arc<Mutex<AiAccounts>>>,
    }

    impl GenerativeBackend for AppBackend {
        fn status(&self) -> BackendStatus {
            self.inner.status()
        }

        fn admit(&self, automated: bool) -> Result<(), GenError> {
            if automated || self.agent.load(Ordering::SeqCst) {
                let allowed = self.store.as_ref().is_some_and(|s| {
                    let mut a = s.lock().unwrap_or_else(PoisonError::into_inner);
                    a.reload();
                    a.settings.allow_agents
                });
                if !allowed {
                    return Err(GenError::new(photocraft_engine::generative::kind::NOT_ALLOWED, super::AGENTS_REFUSED));
                }
            }
            self.inner.admit(automated)
        }

        fn edit_image(&self, req: &ImageEdit, cancelled: &dyn Fn() -> bool) -> Result<Rgba8Image, GenError> {
            self.inner.edit_image(req, cancelled)
        }

        fn generate_image(&self, req: &ImageGen, cancelled: &dyn Fn() -> bool) -> Result<Rgba8Image, GenError> {
            self.inner.generate_image(req, cancelled)
        }

        fn describe(&self, req: &Describe, cancelled: &dyn Fn() -> bool) -> Result<String, GenError> {
            self.inner.describe(req, cancelled)
        }

        fn chat(&self, req: &ChatRequest, cancelled: &dyn Fn() -> bool) -> Result<ChatTurn, GenError> {
            self.inner.chat(req, cancelled)
        }

        fn list_models(&self, provider: ProviderId, cancelled: &dyn Fn() -> bool) -> Result<Vec<ModelEntry>, GenError> {
            self.inner.list_models(provider, cancelled)
        }
    }

    /// The accounts AI Accounts edits, when installed.
    pub fn store(app: &PhotocraftApp) -> Option<Arc<Mutex<AiAccounts>>> {
        app.ai.store.clone()
    }

    /// `f` with the accounts locked, when installed.
    pub fn with_accounts<R>(app: &PhotocraftApp, f: impl FnOnce(&mut AiAccounts) -> R) -> Option<R> {
        let store = app.ai.store.as_ref()?;
        let mut a = store.lock().unwrap_or_else(PoisonError::into_inner);
        Some(f(&mut a))
    }

    /// Read the backend's status again (after a key or a setting changed, when a window opens).
    pub fn refresh(app: &mut PhotocraftApp) {
        app.ai.status = app.session.generative().map(|b| b.status());
    }

    /// The status as last read; read now when it never was.
    pub fn status(app: &mut PhotocraftApp) -> Option<&BackendStatus> {
        if app.ai.status.is_none() {
            refresh(app);
        }
        app.ai.status.as_ref()
    }

    /// A provider with a key can serve `kind` (as last read).
    pub fn fits(app: &PhotocraftApp, kind: ModelKind) -> bool {
        app.ai.status.as_ref().is_some_and(|s| s.providers.iter().any(|p| p.fits(kind)))
    }

    /// The providers that can serve `kind` (as last read).
    pub fn fitting(app: &PhotocraftApp, kind: ModelKind) -> Vec<ProviderId> {
        app.ai.status.as_ref().map(|s| s.providers.iter().filter(|p| p.fits(kind)).map(|p| p.id).collect()).unwrap_or_default()
    }

    /// The person agreed that requests go to their provider (as last read).
    pub fn consented(app: &PhotocraftApp) -> bool {
        app.ai.status.as_ref().is_some_and(|s| s.consented)
    }

    /// What stops a request of `kind` before anything is sent: no backend, no provider with a key,
    /// no agreement yet. `None` when one may go.
    pub fn account_blocker(app: &PhotocraftApp, kind: ModelKind) -> Option<&'static str> {
        if app.session.generative().is_none() {
            return Some(tl!("Generative AI is available in the desktop app."));
        }
        if !fits(app, kind) {
            return Some(match kind {
                ModelKind::Image => tl!("Add an OpenAI or Google Gemini API key in AI Accounts first."),
                ModelKind::Chat => tl!("Connect OpenAI or Google Gemini in AI Accounts first."),
            });
        }
        if !consented(app) {
            return Some(tl!("Agree in AI Accounts that requests go to your AI provider first."));
        }
        None
    }

    /// Open AI Accounts (`ai.accounts`).
    pub fn open_accounts(app: &mut PhotocraftApp) {
        accounts::open(app, None);
    }

    /// Run one of the AI menu commands; `None` for other ids. A feature window opens without
    /// params (or with only a `prompt`, which it is filled with); with others, the command runs
    /// as the engine's (scripts, `engine.execute`).
    pub fn menu(app: &mut PhotocraftApp, id: &str, params: &Value) -> Option<Result<Value, String>> {
        let window_call = params.as_object().is_none_or(|o| o.keys().all(|k| k == "prompt"));
        Some(match id {
            ACCOUNTS => {
                accounts::open(app, None);
                Ok(json!({"open": true}))
            }
            FILL | EXPAND | GENERATE_IMAGE | BACKGROUND | SKY if window_call => {
                let feature = ITEMS.iter().map(|i| i.0).find(|f| *f == id).unwrap_or(FILL);
                generate::open(app, feature, params.get("prompt").and_then(Value::as_str))
            }
            DESCRIBE if params.as_object().is_none_or(|o| o.is_empty()) => describe::start(app),
            REMOVE_BACKGROUND if params.as_object().is_none_or(|o| o.is_empty()) => remove_background(app, "local"),
            REMOVE_WITH_PROVIDER => remove_background(app, "provider"),
            ASSISTANT => assistant::toggle(app, params),
            _ => return None,
        })
    }

    /// Layer › Remove Background (local, nothing sent) or … with AI Provider (after the account
    /// checks; AI Accounts opens when they fail, as in JavaScript Pigment).
    fn remove_background(app: &mut PhotocraftApp, method: &str) -> Result<Value, String> {
        if method == "provider" {
            refresh(app);
            if let Some(why) = account_blocker(app, ModelKind::Image) {
                accounts::open(app, Some(why.to_string()));
                return Err(why.to_string());
            }
        }
        let r = app.run(REMOVE_BACKGROUND, json!({"method": method}))?;
        if r.get("pending").is_none() {
            removed_background(app);
        }
        Ok(r)
    }

    /// Remove Background landed: offer Generate Background in the task bar.
    fn removed_background(app: &mut PhotocraftApp) {
        app.ai.after_remove = app.session.active().map(|st| (st.doc.id, st.revision));
    }

    /// A background job ended: the AI windows take the ones they started. `true` when the event is
    /// handled (the shell's generic report is skipped: the window shows it).
    pub fn on_job_event(app: &mut PhotocraftApp, e: &JobEvent) -> bool {
        if matches!(e.outcome, JobOutcome::Done(_)) && matches!(e.command.as_str(), REMOVE_BACKGROUND | "layer.removeBackground") {
            app.sync_views();
            removed_background(app);
        }
        if describe::on_job_event(app, e) || assistant::on_job_event(app, e) {
            return true;
        }
        generate::on_job_event(app, e)
    }

    /// Draw the AI windows (after the dialogs, so AI Accounts opened from Preferences is on top).
    pub fn show(app: &mut PhotocraftApp, ctx: &egui::Context) {
        generate::show(app, ctx);
        describe::show(app, ctx);
        assistant::show(app, ctx);
        accounts::show(app, ctx);
    }

    /// The task bars under a selection (Generative Fill) and after Remove Background (Generate
    /// Background), drawn by the canvas over the active document.
    pub fn task_bars(app: &mut PhotocraftApp, ui: &mut egui::Ui, xf: &ViewXform) {
        task_bar::draw(app, ui, xf);
    }

    /// The Crop tool's task bar slot: Generative Expand.
    pub fn crop_task_bar_item(app: &mut PhotocraftApp, ui: &mut egui::Ui) {
        task_bar::crop_item(app, ui);
    }

    /// Preferences › AI Integrations' Generative AI rows: `true` when AI Accounts… was clicked.
    pub fn preferences_button(ui: &mut egui::Ui) -> bool {
        let t = crate::theme::Tokens::get(ui.ctx());
        ui.add_space(10.0);
        ui.label(egui::RichText::new(tl!("Generative AI")).strong());
        ui.label(
            egui::RichText::new(tl!(
                "Generative Fill, Generate Image, Sky Replacement and the other AI commands use your own OpenAI or Google Gemini account."
            ))
            .color(t.text_dim),
        );
        crate::widgets::secondary_button(ui, tl!("AI Accounts…"), 0.0).clicked()
    }

    /// The message of a failed request as the windows show it: AI Accounts' place in the menus.
    pub(crate) fn message(m: &str) -> String {
        m.replace("Edit › AI Accounts…", ACCOUNTS_PATH).replace("AI › AI Accounts…", ACCOUNTS_PATH)
    }

    /// Error kinds AI Accounts fixes; `kind` may be unknown (a refusal before the job started), so
    /// the message is read too.
    pub(crate) fn fixed_in_accounts(kind: Option<&str>, message: &str) -> bool {
        matches!(kind, Some("missingKey" | "invalidKey" | "needsConsent" | "notAllowed")) || message.contains("AI Accounts")
    }

    /// Error kinds worth trying again as they are.
    pub(crate) fn retryable(kind: Option<&str>) -> bool {
        matches!(kind, Some("network" | "timeout" | "server" | "quota" | "badResponse"))
    }

    /// The kind of a failed job's error, when the engine kept it.
    pub(crate) fn error_kind(e: &JobEvent) -> Option<&'static str> {
        match &e.error {
            Some(photocraft_engine::EngineError::Generative { kind, .. }) => Some(kind),
            _ => None,
        }
    }
}
