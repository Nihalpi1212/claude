//! Preferences › AI Integrations and the agents in the open window. Pigment: whether agents can
//! use the open window is Pigment's own switch, "Let AI apps use this window" (`connectAgents`,
//! off by default); PhotoCraft leaves it to the ArtCraft Launcher, which Pigment never reads, nor
//! the suite's `AI-MCP` flag (docs/FORK.md, decision D1 of the 057297b merge). The page is the
//! framework's (`craft::automation::ui::agents::AgentsPage`) drawn under Pigment's switch with the
//! folders and When Closed shown and its two words that name the launcher replaced ([`page`]);
//! the agent link is the framework's; PhotoCraft supplies what agent requests may read, write and
//! run (`Services::agent_automation`).

use craft::automation::agents::{AgentLinkStatus, LinkProblem};
use craft::automation::control::ControlChannel;
use craft::automation::ui::agents::{AgentsPage, AgentsWords};
use craft::ui::choice::Checkbox;
use craft::ui::contract::{Bind, FieldLayout, Props as _, Show as _, ShowContainer as _};
use craft::ui::form::Field;
use craft::ui::patterns::preferences::SettingsDraft;
use craft::ui::runtime::env::{WordRows, WordSet, WordsOverride, with_env};
use craft::ui::runtime::windows::WindowHost;

use super::PhotocraftApp;
use crate::AutomationServices;

/// Brings the agent link in line with the saved agent settings: the link starts, moves or stops its
/// control server, and does nothing while they didn't change. Pigment's switch (`connect_agents`)
/// alone lets agents in: the framework's rule with no `AI-MCP` flag and no launcher switch, whatever
/// `Services::agent_switch` holds. While the server runs, agent requests get the automation policy
/// over the folders chosen; a folder that can't be used is named on the page.
pub(super) fn sync_agent_link(app: &mut PhotocraftApp, ctx: &egui::Context) {
    let integrations = app.session.prefs().integrations.clone();
    let allowed = craft::automation::agents::agents_allowed(false, false, integrations.connect_agents);
    let Some(link) = app.services.agent_link.as_mut() else { return };
    let update = link.sync(allowed.then_some(&integrations.agents), &WindowHost::of(ctx));
    if update.stopped {
        app.control = None;
    }
    if let Some(requests) = update.requests {
        app.control = Some(ControlChannel::new(requests));
    }
    if !update.changed {
        return;
    }
    let (automation, problem) = match app.services.agent_automation.as_ref() {
        Some(policy) if link.status().port.is_some() => policy(&integrations.agents),
        _ => (AutomationServices::default(), None),
    };
    if let Some(problem) = problem {
        link.note(LinkProblem::App(problem));
    }
    app.services.set_automation(automation);
    // Actions automation records keep the policy as their gate when the user plays them, as they
    // do with `--control` (`PhotocraftApp::new`); the gate stays once agents have connected.
    app.session.automation_gate = app.session.automation_gate.or(app.services.automation_authorize);
}

/// Pigment's switch: the draft key of "Let AI apps use this window".
pub(super) const SWITCH: &str = "integrations.connectAgents";

/// The framework page's words that name the ArtCraft Launcher, as Pigment says them: the switch is
/// on this page.
pub(super) fn pigment_words() -> WordRows {
    let mut rows = WordRows::new();
    let words = [
        (
            "agents.intro",
            tl!(
                "AI apps such as Claude can open, edit and save documents in this window while Let AI apps use this window is on. Only programs on this computer can connect."
            ),
        ),
        ("agents.off", tl!("Off: AI apps get a session without a window.")),
    ];
    for (id, text) in words {
        if let Some(word) = AgentsWords::word(id) {
            rows = rows.row(word, text);
        }
    }
    rows
}

/// Preferences › AI Integrations: Pigment's switch, then the framework's page (status, Control
/// Port, the two folders, When Closed) in Pigment's words, then generative AI's rows (AI Accounts…,
/// whose click `ai` keeps for `ai_ui`, and "Allow agents to run AI commands"). Every edit but that
/// permission (AI Accounts' own setting) goes into the window's `draft`.
pub(super) fn page(ui: &mut egui::Ui, page: &str, draft: &mut SettingsDraft, status: &AgentLinkStatus, ai: &crate::ai_ui::PrefsAi) {
    // Off by default: then `pigment-cli mcp` serves a session without a window, as it always did.
    let on = draft.get::<bool>(SWITCH).unwrap_or(false);
    let mut next = None;
    Field::new(tl!("Let AI apps use this window").to_owned()).id_salt("pigment-connect-agents").layout(FieldLayout::After).show(ui, |ui, _| {
        next = Checkbox::new(Bind::given(on)).show(ui).events.landed().cloned();
    });
    if let Some(next) = next.filter(|next| *next != on) {
        draft.set(SWITCH, &next);
    }
    let rows = pigment_words();
    with_env(
        ui,
        |o| o.words = Some(WordsOverride::Overlay(rows)),
        |ui| {
            AgentsPage::new(page, draft, status).mcp_flag(true).show(ui);
        },
    );
    // Pigment: generative AI's accounts and the agents' permission to run AI commands.
    crate::ai_ui::preferences_rows(ui, ai);
}
