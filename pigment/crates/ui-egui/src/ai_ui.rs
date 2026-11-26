//! Pigment: generative AI in the interface (`docs/generative-ai.md`), on top of the engine's
//! `ai.*` commands and the `pigment-genai` backend.
//!
//! **A stub for the merge of PhotoCraft 057297b** (step 5 of the merge plan): upstream rebuilt
//! the interface on the craft framework, so the AI windows (Generate, Describe, AI Accounts, the
//! Assistant, the task bars) are ported in the steps after the desktop app's. Until then this
//! module keeps every hook the rest of the interface calls, with the same signatures, and does
//! nothing: no window, no menu item, no backend on the session (so an engine `ai.*` command
//! refuses with the engine's "no backend" error and nothing is sent). The agents gate ([`gate`],
//! [`as_agent`]) keeps its rule: with no accounts installed, an agent's command that would send
//! is refused.
//!
//! The ported code waits in `ai_ui/*.rs` (not compiled until then) and in Pigment 0.5.0's
//! `ai_ui.rs` (`git show f4e3ffa:pigment/crates/ui-egui/src/ai_ui.rs`).

use craft::menu::Row;
use serde_json::Value;

use crate::PhotocraftApp;

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
/// palette only. Order matters: an item may follow one listed before it. (Not shown while this
/// module is a stub: [`menu_items`] returns none.)
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

/// What the app holds for generative AI. Nothing here is saved with the interface state.
#[derive(Default)]
pub struct AiUi {
    /// A control request (an agent) is being handled ([`as_agent`]).
    pub(crate) agent: bool,
    /// Whether the command running now runs for an agent, as [`gate`] (asked for every command
    /// the app runs) and [`as_agent`] last found it: the session's backend reads it when a
    /// command that sends starts, so one an agent reaches through another command (a script's
    /// step, which [`gate`] never sees) is held to the same rule.
    pub(crate) agent_now: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// Preferences › AI Integrations' AI Accounts… was clicked: the window has no app to call, so
    /// [`show`] opens AI Accounts on the next pass.
    pub(crate) accounts_asked: std::sync::Arc<std::sync::atomic::AtomicBool>,
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

/// "Allow agents to run AI commands", as saved. The stub installs no accounts: never.
pub fn agents_allowed(_: &PhotocraftApp) -> bool {
    false
}

/// Whether `id` is one of this module's shell commands (none while it is a stub).
pub fn handles(_: &str) -> bool {
    false
}

/// The item `id` follows in its menu, for this module's items.
pub fn place_after(id: &str) -> Option<&'static str> {
    if cfg!(target_arch = "wasm32") {
        return None;
    }
    ITEMS.iter().find(|i| i.0 == id).map(|i| i.3).filter(|a| !a.is_empty())
}

/// The AI menu items (none while this module is a stub).
pub fn menu_items(_: &PhotocraftApp) -> Vec<Row> {
    Vec::new()
}

/// Whether menu item `id` shows a check mark, for this module's items (Window › Assistant while
/// its window is open). `None` for the rest.
pub fn checked(_: &PhotocraftApp, _: &str) -> Option<bool> {
    None
}

/// Whether menu item `id` is enabled, for this module's shell commands; `None` for the rest.
pub fn is_enabled(_: &PhotocraftApp, _: &str) -> Option<bool> {
    None
}

/// Keep the AI accounts in Pigment's settings folder `dir` and install the provider backend on
/// the session (the desktop app, at start-up). The stub installs nothing.
pub fn install(_: &mut PhotocraftApp, _: &std::path::Path) {}

/// Open AI Accounts (`ai.accounts`).
pub fn open_accounts(_: &mut PhotocraftApp) {}

/// Run one of the AI menu commands; `None` for other ids (all ids while this module is a stub:
/// an `ai.*` id then runs as the engine's command, which refuses without a backend).
pub fn menu(_: &mut PhotocraftApp, _: &str, _: &Value) -> Option<Result<Value, String>> {
    None
}

/// A background job ended: the AI windows take the ones they started. `true` when the event is
/// handled (the shell's generic report is skipped: the window shows it).
pub fn on_job_event(_: &mut PhotocraftApp, _: &photocraft_engine::jobs::JobEvent) -> bool {
    false
}

/// Draw the AI windows (after the hosted dialogs, so AI Accounts opened from Preferences is on top).
pub fn show(app: &mut PhotocraftApp, _: &mut egui::Ui) {
    if app.ai.accounts_asked.swap(false, std::sync::atomic::Ordering::SeqCst) {
        open_accounts(app);
    }
}

/// The task bars under a selection (Generative Fill) and after Remove Background (Generate
/// Background), drawn by the canvas over the active document's tile `rect`, in `space`'s view.
pub fn task_bars(_: &mut PhotocraftApp, _: &mut egui::Ui, _: egui::Rect, _: &craft::ui::canvas::CanvasSpace) {}

/// The Crop tool's task bar slot: Generative Expand, before the preset list.
pub fn crop_task_bar_item(_: &mut PhotocraftApp, _: &mut egui::Ui) {}

/// Preferences › AI Integrations' Generative AI rows: `true` when AI Accounts… was clicked.
pub fn preferences_button(_: &mut egui::Ui) -> bool {
    false
}
