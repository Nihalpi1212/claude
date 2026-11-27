#![cfg(not(target_arch = "wasm32"))]
//! Agents in the open window (`agents.rs`): the agent link follows the preferences, Pigment's own
//! switch alone lets agents in (never the ArtCraft Launcher's or the suite's `AI-MCP` flag), and
//! agent requests get the app's policy while it runs. The link, the switch and the framework's
//! Agents page have their own trials in craft-automation (`tests/it/agents.rs`).

use super::tests::app_with_store;
use super::*;
use craft::automation::agents::{AgentLink, AgentSettings, AgentSwitch, LinkProblem};
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// One upkeep pass.
fn tick(app: &mut PhotocraftApp, ctx: &egui::Context) {
    super::save::tick(app, ctx, Instant::now());
}

/// An app whose agent link keeps its files in a fresh folder, with `switch` as the launcher's
/// switch. The policy it installs refuses commands, names a folder `/missing` as not used, and
/// records the settings it was asked for.
fn linked_app(switch: AgentSwitch) -> (Box<PhotocraftApp>, tempfile::TempDir, Arc<Mutex<Vec<AgentSettings>>>) {
    let (mut app, _) = app_with_store();
    let dir = tempfile::tempdir().unwrap();
    app.services.agent_link = Some(AgentLink::new(Some(dir.path().to_path_buf()), "Pigment test"));
    app.services.agent_switch = Some(switch);
    let asked: Arc<Mutex<Vec<AgentSettings>>> = Arc::default();
    let seen = asked.clone();
    app.services.agent_automation = Some(Box::new(move |settings: &AgentSettings| {
        seen.lock().unwrap().push(settings.clone());
        let services = crate::AutomationServices { command: Some(Box::new(|_, _| Err("policy".into()))), authorize: Some(|_, _| Ok(())), ..Default::default() };
        (services, (settings.read_root == "/missing").then(|| "Automation Read Folder is not used".to_string()))
    }));
    (app, dir, asked)
}

fn port(app: &PhotocraftApp) -> Option<u16> {
    app.services.agent_link.as_ref().and_then(|link| link.status().port)
}

#[test]
fn preferences_start_and_stop_the_agent_link_and_the_policy_follows() {
    let (mut app, _dir, asked) = linked_app(AgentSwitch::fixed(false, false));
    let ctx = egui::Context::default();
    // Off as saved: nothing listens, agent requests get nothing.
    tick(&mut app, &ctx);
    tick(&mut app, &ctx);
    assert!(app.control.is_none() && port(&app).is_none() && app.services.automation_command.is_none());
    assert!(asked.lock().unwrap().is_empty());
    // On: the control channel and the policy over the chosen folder, without a restart.
    app.run("prefs.set", json!({"values": {"integrations.connectAgents": true, "integrations.readRoot": "/work"}})).unwrap();
    tick(&mut app, &ctx);
    assert!(port(&app).is_some() && app.control.is_some());
    assert!(app.services.automation_command.is_some());
    assert!(app.session.automation_gate.is_some(), "actions agents record keep the policy");
    assert_eq!(asked.lock().unwrap().last().map(|s| s.read_root.clone()).as_deref(), Some("/work"));
    // An unrelated preference doesn't touch the link.
    app.run("prefs.set", json!({"values": {"performance.historyStates": 12}})).unwrap();
    tick(&mut app, &ctx);
    assert_eq!(asked.lock().unwrap().len(), 1);
    // A folder the policy can't use is named on the page, and the server keeps running.
    let running = port(&app);
    app.run("prefs.set", json!({"values": {"integrations.readRoot": "/missing"}})).unwrap();
    tick(&mut app, &ctx);
    assert_eq!(port(&app), running);
    let problem = app.services.agent_link.as_ref().and_then(|link| link.status().problem.clone());
    assert!(matches!(problem, Some(LinkProblem::App(_))), "{problem:?}");
    // ui.inspect reports the link.
    let inspected = crate::control::inspect(&app, &ctx);
    assert_eq!(inspected["agentLink"]["port"], json!(running));
    assert_eq!(inspected["agentLink"]["mcpFlag"], json!(false));
    // Off: the channel and the policy go.
    app.run("prefs.set", json!({"values": {"integrations.connectAgents": false}})).unwrap();
    tick(&mut app, &ctx);
    assert!(app.control.is_none() && port(&app).is_none() && app.services.automation_command.is_none());
}

/// Pigment: its switch ("Let AI apps use this window") alone decides. The launcher's switch and the
/// `AI-MCP` flag, whatever `Services::agent_switch` says, neither turn the link on nor keep it off
/// (docs/FORK.md, decision D1).
#[test]
fn pigment_s_switch_alone_turns_the_agent_link_on_and_off() {
    for switch in [AgentSwitch::fixed(true, true), AgentSwitch::fixed(true, false), AgentSwitch::fixed(false, true)] {
        let (mut app, _dir, _) = linked_app(switch);
        let ctx = egui::Context::default();
        tick(&mut app, &ctx);
        assert!(port(&app).is_none() && app.control.is_none(), "off by default, whatever the launcher says");
        app.run("prefs.set", json!({"values": {"integrations.connectAgents": true}})).unwrap();
        tick(&mut app, &ctx);
        assert!(port(&app).is_some() && app.control.is_some(), "Pigment's switch starts it");
        app.run("prefs.set", json!({"values": {"integrations.connectAgents": false}})).unwrap();
        tick(&mut app, &ctx);
        assert!(port(&app).is_none() && app.control.is_none(), "and stops it");
    }
}

/// The page never calls the suite's flag or the launcher's list (`agents::mcp_flag`,
/// `agents::launcher_allows`) nor starts the launcher's watch, and its words never name the
/// ArtCraft Launcher.
#[test]
fn the_agents_page_reads_neither_the_suite_flag_nor_the_launcher() {
    let source = concat!(include_str!("agents.rs"), include_str!("custom_rows.rs"));
    for call in ["agents::mcp_flag(", "launcher_allows(", "AgentSwitch::watch", "switch.mcp_flag()", "switch.allows("] {
        assert!(!source.contains(call), "{call}");
    }
    let rows = super::agents::pigment_words();
    let launcher = ["ArtCraft", "Launcher"].join(" ");
    for (word, text) in rows.iter() {
        assert!(!text.contains(&launcher), "{text}");
        assert!(word.english.contains(&launcher), "{} replaces a word that names the launcher", word.id);
    }
    assert_eq!(rows.iter().count(), 2, "agents.intro and agents.off");
}

/// Preferences › AI Integrations: Pigment's own switch over the framework's page, which shows the
/// port, the folders and When Pigment Is Closed, in words that never send anyone to the ArtCraft
/// Launcher.
#[test]
fn ai_integrations_have_pigments_own_switch_and_the_folders() {
    use egui_kittest::kittest::Queryable;
    let files = Arc::new(craft::settings::testing::MemoryFiles::new());
    let mut h = super::tests::prefs_harness(&files, "integrations", egui::vec2(1280.0, 800.0), |_| {});
    assert!(h.query_by_label("Let AI apps use this window").is_some(), "Pigment's own switch");
    assert!(h.query_all_by_label_contains("while Let AI apps use this window is on").next().is_some(), "the intro names it");
    assert!(h.query_all_by_label_contains("ArtCraft").next().is_none(), "no launcher");
    assert!(h.query_all_by_label("Off: AI apps get a session without a window.").next().is_some(), "Pigment's off line");
    assert!(h.query_all_by_label("Folder agents can open from").next().is_some(), "the folders stay");
    assert!(h.query_all_by_label_contains("When Pigment is closed").next().is_some(), "When Closed stays, with Pigment's name");
    for label in ["Copy Configuration", "Add to Claude Desktop", "Copy Prompt for an Agent"] {
        assert!(h.query_by_label(label).is_none(), "{label}");
    }
    // The switch edits the draft; OK saves it.
    assert!(!h.state().session.prefs().integrations.connect_agents, "off by default");
    h.get_by_label("Let AI apps use this window").click();
    h.run_steps(3);
    h.get_by_label("OK").click();
    h.run_steps(4);
    assert!(h.state().session.prefs().integrations.connect_agents);
}

#[test]
fn agent_choices_and_paths_validate_through_prefs_set() {
    let (mut app, _) = app_with_store();
    for v in ["launch", "headless", "error"] {
        app.run("prefs.set", json!({"values": {"integrations.whenAppClosed": v}})).unwrap();
        assert_eq!(app.session.prefs().integrations.agents.when_app_closed.name(), v);
    }
    assert!(app.run("prefs.set", json!({"values": {"integrations.whenAppClosed": "sometimes"}})).is_err());
    assert!(app.run("prefs.set", json!({"values": {"integrations.controlPort": 70000}})).is_err());
    app.run("prefs.set", json!({"values": {"integrations.writeRoot": "/tmp/out"}})).unwrap();
    assert_eq!(app.session.prefs().integrations.agents.write_root, "/tmp/out");
}
