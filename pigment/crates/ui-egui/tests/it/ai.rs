//! Pigment: generative AI in the app (`src/ai_ui*`, docs/generative-ai.md). The menu places, the
//! Generate window (nothing sent before Generate, one undo step, Stop, the status bar instead of a
//! modal), AI Accounts (a key checked against a local mock server, the agreement, the key never
//! shown, saved or reported), Describe Image, the task bars and the agents' gate.
//!
//! No request leaves this machine: the engine's `MockBackend` answers the features, and AI
//! Accounts talks to a `TcpListener` on 127.0.0.1.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use egui::vec2;
use egui_kittest::kittest::{By, Queryable};
use photocraft_engine::Session;
use photocraft_engine::generative::ProviderId;
use photocraft_engine::generative::mock::{MockAnswer, MockBackend};
use photocraft_ui_egui::PhotocraftApp;
use photocraft_ui_egui::ai_ui::{self, accounts, describe, generate, task_bar};
use photocraft_ui_egui::control::{ControlRequest, Outcome, handle};
use photocraft_ui_egui::menus;
use pigment_genai::AiAccounts;
use serde_json::{Value, json};

type Harness = egui_kittest::Harness<'static, PhotocraftApp>;

const KEY: &str = "sk-test-0123456789abcdefWXYZ";

/// The app in English with a 200 × 160 white document; `prepare` runs on it before the first
/// frame. The AI task bar is off unless a test turns it on (its Generate button would share a
/// label with the window's).
fn harness(prepare: impl FnOnce(&mut PhotocraftApp) + 'static) -> Harness {
    let mut h = Harness::builder().with_size(vec2(1280.0, 900.0)).with_max_steps(64).build_eframe(|cc| {
        PhotocraftApp::setup_context(&cc.egui_ctx, Default::default());
        let mut app = PhotocraftApp::new(Session::new(), Default::default());
        app.session.prefs.edit(|p| p.interface.language = "en".into());
        app.run("file.new", json!({"width": 200, "height": 160, "background": "white"})).expect("new");
        app.ui.panels.context_task_bar = false;
        prepare(&mut app);
        app
    });
    h.run_steps(4);
    h
}

/// Install `mock` as the session's backend (behind the app's agents gate, as the real one is).
fn with_mock(app: &mut PhotocraftApp, mock: &Arc<MockBackend>) {
    ai_ui::install_backend(app, Arc::clone(mock) as Arc<dyn photocraft_engine::generative::GenerativeBackend>);
}

/// Run menu command `id` as a menu click does.
fn invoke(h: &mut Harness, id: &str) -> Result<Value, String> {
    let ctx = h.ctx.clone();
    let r = menus::invoke(h.state_mut(), &ctx, id, json!({}));
    h.run_steps(3);
    r
}

fn layer_names(app: &PhotocraftApp) -> Vec<String> {
    app.session.active().map(|st| st.doc.layers.iter().map(|l| l.name.clone()).collect()).unwrap_or_default()
}

/// Draw frames until no job runs and the windows have taken their answers.
fn until_idle(h: &mut Harness) {
    for _ in 0..1000 {
        h.run_steps(1);
        let app = h.state();
        if !app.session.has_jobs() && app.ai.generate.job.is_none() && app.ai.describe.job.is_none() {
            h.run_steps(2);
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("the request never ended");
}

/// Click the field labelled `label` and type `text` into it.
fn type_into(h: &mut Harness, label: &str, text: &str) {
    h.get_by_label(label).click();
    h.run_steps(2);
    h.get_by_label(label).type_text(text);
    h.run_steps(2);
}

fn control(h: &mut Harness, method: &str, params: Value) -> Value {
    let ctx = h.ctx.clone();
    let (req, _rx) = ControlRequest::new(method, params.clone());
    let Outcome::Done(v) = handle(h.state_mut(), &ctx, &req) else { panic!("{method} {params}: not done") };
    h.run_steps(3);
    v
}

/// Every AI item sits in Photoshop's place, is live, and is in the command palette.
#[test]
fn menus_put_each_feature_in_its_photoshop_place() {
    let app = PhotocraftApp::new(Session::new(), Default::default());
    let items = menus::menu_items(&app);
    let at = |id: &str| items.iter().position(|i| i.id == id).unwrap_or_else(|| panic!("{id} is not in the menus"));
    let path = |id: &str| items[at(id)].path.join(" › ");
    for (id, after, menu) in [
        ("ai.generativeFill", "edit.contentAwareFill", "Edit"),
        ("ai.generateImage", "ai.generativeFill", "Edit"),
        ("ai.replaceSky", "ai.generateImage", "Edit"),
        ("ai.accounts", "edit.toolbar", "Edit"),
        ("ai.removeBackground", "layer.maskAllObjects", "Layer"),
        ("ai.removeBackgroundWithProvider", "ai.removeBackground", "Layer"),
        ("ai.replaceBackground", "ai.removeBackgroundWithProvider", "Layer"),
        ("ai.describe", "image.calculations", "Image"),
    ] {
        assert_eq!(at(id), at(after) + 1, "{id} follows {after}");
        assert_eq!(path(id), menu, "{id}");
        assert!(menus::is_live(id), "{id}");
    }
    assert_eq!(items[at("ai.replaceBackground")].label, "Generate Background…");
    assert_eq!(items[at("ai.replaceSky")].label, "Sky Replacement…");
    // Generative Expand: the Crop tool's bar and the palette, no menu.
    assert!(items[at("ai.generativeExpand")].path.is_empty());
    assert!(!items.iter().any(|i| i.path.first().is_some_and(|p| p == "AI")), "no AI menu");
    // The selection context menu offers Generative Fill after Content-Aware Fill.
    let rows: Vec<&str> = photocraft_ui_egui::canvas_tool_menu::SELECTION_MENU.iter().flatten().map(|r| r.1).collect();
    let caf = rows.iter().position(|r| *r == "edit.contentAwareFill").expect("Content-Aware Fill row");
    assert_eq!(rows.get(caf + 1), Some(&"ai.generativeFill"));
}

/// Items are dimmed with the engine's reason (no backend, no selection), never for a missing key.
#[test]
fn items_dim_for_the_document_not_for_a_missing_key() {
    let mut app = PhotocraftApp::new(Session::new(), Default::default());
    app.run("file.new", json!({"width": 40, "height": 30})).unwrap();
    assert!(!menus::is_enabled(&app, "ai.generativeFill"), "no backend");
    assert_eq!(app.session.disabled_reason("ai.describe").as_deref(), Some(photocraft_engine::ai_cmds::NO_BACKEND));
    assert!(menus::is_enabled(&app, "ai.accounts"));
    let mock = Arc::new(MockBackend::disconnected());
    with_mock(&mut app, &mock);
    assert!(!menus::is_enabled(&app, "ai.generativeFill"), "no selection");
    app.run("select.rect", json!({"x": 2, "y": 2, "width": 10, "height": 10})).unwrap();
    assert!(menus::is_enabled(&app, "ai.generativeFill"), "a missing key doesn't dim it");
    assert!(menus::is_enabled(&app, "ai.describe") && menus::is_enabled(&app, "ai.removeBackgroundWithProvider"));
}

/// Generative Fill: the window sends nothing while it is filled in; Generate runs the request in the
/// background (the status bar shows it, no modal), and the result lands as one undo step.
#[test]
fn generative_fill_sends_nothing_before_generate_and_lands_as_one_step() {
    let mock = Arc::new(MockBackend::connected());
    let m = Arc::clone(&mock);
    let mut h = harness(move |app| {
        with_mock(app, &m);
        app.background_jobs = true;
        app.run("select.rect", json!({"x": 40, "y": 40, "width": 60, "height": 50})).unwrap();
    });
    invoke(&mut h, "ai.generativeFill").unwrap();
    assert!(h.state().ai.generate.open);
    assert_eq!(generate::blocked(h.state()).as_deref(), Some("Describe what to generate."));
    type_into(&mut h, "Describe what to generate", "a red fox");
    assert!(mock.calls().is_empty(), "nothing sent while typing");
    mock.set_delay(Duration::from_millis(600));
    h.get_by_label("Generate").click();
    h.run_steps(3);
    assert!(h.state().ai.generate.job.is_some(), "running");
    std::thread::sleep(Duration::from_millis(350));
    h.run_steps(3);
    assert!(h.query_by_label("Esc to cancel").is_none(), "no modal progress window");
    assert!(h.query_by_label("Stop").is_some(), "the window offers Stop");
    until_idle(&mut h);
    let calls = mock.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].prompt, "a red fox");
    assert_eq!(layer_names(h.state()).iter().filter(|n| *n == "Generative Fill").count(), 1);
    let note = h.state().ai.generate.note.clone().unwrap_or_default();
    assert!(note.contains("Undo"), "{note}");
    h.state_mut().run("edit.undo", json!({})).unwrap();
    assert!(!layer_names(h.state()).iter().any(|n| n == "Generative Fill"), "one undo step takes it back");
}

/// Stop cancels a request that never answers: nothing lands, and the window says a request
/// already sent may still be billed.
#[test]
fn stop_cancels_a_request_that_never_answers() {
    let mock = Arc::new(MockBackend::connected());
    let m = Arc::clone(&mock);
    let mut h = harness(move |app| {
        with_mock(app, &m);
        app.background_jobs = true;
        app.run("select.rect", json!({"x": 10, "y": 10, "width": 30, "height": 30})).unwrap();
    });
    mock.set_delay(Duration::from_secs(60));
    ai_ui::menu(h.state_mut(), "ai.generativeFill", &json!({"prompt": "clouds"})).unwrap().unwrap();
    h.run_steps(2);
    h.get_by_label("Generate").click();
    h.run_steps(3);
    assert!(h.state().ai.generate.job.is_some());
    h.get_by_label("Stop").click();
    until_idle(&mut h);
    assert_eq!(layer_names(h.state()).len(), 1, "nothing landed");
    let note = h.state().ai.generate.note.clone().unwrap_or_default();
    assert!(note.contains("billed"), "{note}");
}

/// Without a key, Generate is dimmed with the reason and the window links to AI Accounts; without
/// the agreement likewise. Nothing is sent either way.
#[test]
fn without_a_key_or_the_agreement_generate_is_dimmed_and_links_to_ai_accounts() {
    let mock = Arc::new(MockBackend::disconnected());
    let m = Arc::clone(&mock);
    let mut h = harness(move |app| {
        with_mock(app, &m);
        app.run("select.rect", json!({"x": 10, "y": 10, "width": 30, "height": 30})).unwrap();
    });
    ai_ui::menu(h.state_mut(), "ai.generativeFill", &json!({"prompt": "clouds"})).unwrap().unwrap();
    h.run_steps(3);
    let why = generate::blocked(h.state()).unwrap();
    assert!(why.contains("API key"), "{why}");
    assert!(generate::start(h.state_mut()).is_err());
    h.get_by_label("Open AI Accounts…").click();
    h.run_steps(3);
    assert!(accounts::is_open(h.state()));
    // A key but no agreement.
    let connected = MockBackend::connected();
    connected.set_consented(false);
    let mock2 = Arc::new(connected);
    with_mock(h.state_mut(), &mock2);
    let why = generate::blocked(h.state()).unwrap();
    assert!(why.contains("Agree"), "{why}");
    assert!(mock.calls().is_empty() && mock2.calls().is_empty());
}

/// A local HTTP server answering every request with the OpenAI model list (status 200).
fn models_server() -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let paths = Arc::new(Mutex::new(vec![]));
    let log = Arc::clone(&paths);
    let body = serde_json::to_vec(&json!({"data": [{"id": "gpt-5.1"}, {"id": "gpt-image-1"}, {"id": "gpt-image-1.5"}]})).unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let (log, body) = (Arc::clone(&log), body.clone());
            std::thread::spawn(move || serve(stream, &log, &body));
        }
    });
    (base, paths)
}

fn serve(stream: TcpStream, log: &Mutex<Vec<String>>, body: &[u8]) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut line = String::new();
    if reader.read_line(&mut line).unwrap_or(0) == 0 {
        return;
    }
    let mut len = 0usize;
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
            break;
        }
        if let Some((k, v)) = h.trim_end().split_once(':')
            && k.trim().eq_ignore_ascii_case("content-length")
        {
            len = v.trim().parse().unwrap_or(0);
        }
    }
    let mut req = vec![0u8; len];
    let _ = reader.read_exact(&mut req);
    log.lock().unwrap().push(line.split_whitespace().nth(1).unwrap_or_default().to_string());
    let mut out = stream;
    let head = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    let _ = out.write_all(head.as_bytes());
    let _ = out.write_all(body);
}

/// AI Accounts: Connect checks the key with the provider and stores it; Test Connection lists the
/// models; the agreement is given once. The key never shows in the accessibility tree, the
/// interface state, the preferences, `ai.status` or the menus.
#[test]
fn ai_accounts_connects_a_key_that_never_shows_anywhere() {
    let (base, paths) = models_server();
    let mut h = harness(move |app| {
        let mut a = AiAccounts::in_memory();
        a.set_base_url(ProviderId::OpenAi, &base).unwrap();
        ai_ui::install_accounts(app, a);
    });
    invoke(&mut h, "ai.accounts").unwrap();
    assert!(accounts::is_open(h.state()));
    assert!(paths.lock().unwrap().is_empty(), "opening sends nothing");
    type_into(&mut h, "API key", KEY);
    // While it is typed the key is in the masked field only: not in the accessibility tree, not in
    // what an agent can read of the interface.
    let shown = h
        .query_all(By::new().include_labels().predicate(|n| {
            n.label().is_some_and(|l| l.contains(KEY)) || n.value().is_some_and(|v| v.contains(KEY)) || n.description().is_some_and(|d| d.contains(KEY))
        }))
        .count();
    assert_eq!(shown, 0, "the accessibility tree while typing");
    assert!(!photocraft_ui_egui::control::inspect(h.state(), &h.ctx).to_string().contains(KEY), "ui.inspect while typing");
    assert!(!serde_json::to_string(&h.state().ui).unwrap().contains(KEY), "the interface state while typing");
    h.get_by_label("Connect").click();
    h.run_steps(2);
    for _ in 0..500 {
        if accounts::busy(h.state()).is_none() {
            break;
        }
        accounts::wait(h.state_mut(), Duration::from_millis(20));
        h.run_steps(1);
    }
    h.run_steps(3);
    assert_eq!(paths.lock().unwrap().as_slice(), ["/v1/models"], "one check");
    assert!(h.query_by_label_contains("Connected with an API key (ends in …WXYZ)").is_some());
    assert!(h.query_by_label("OpenAI connected.").is_some());
    // The key, nowhere.
    let leaks = h
        .query_all(By::new().include_labels().predicate(|n| {
            n.label().is_some_and(|l| l.contains(KEY)) || n.value().is_some_and(|v| v.contains(KEY)) || n.description().is_some_and(|d| d.contains(KEY))
        }))
        .count();
    assert_eq!(leaks, 0, "the accessibility tree");
    let app = h.state();
    assert!(!photocraft_ui_egui::control::inspect(app, &h.ctx).to_string().contains(KEY), "ui.inspect");
    assert!(!serde_json::to_string(&app.ui).unwrap().contains(KEY), "the interface state");
    assert!(!serde_json::to_string(app.session.prefs()).unwrap().contains(KEY), "the preferences");
    assert!(!format!("{:?}", menus::menu_items(app)).contains(KEY), "the menus");
    let status = h.state_mut().run("ai.status", json!({})).unwrap();
    assert_eq!(status["providers"][0]["connected"], true);
    assert!(!status.to_string().contains(KEY), "ai.status");
    // Test Connection lists the models.
    h.get_by_label("Test Connection").click();
    h.run_steps(2);
    for _ in 0..500 {
        if accounts::busy(h.state()).is_none() {
            break;
        }
        accounts::wait(h.state_mut(), Duration::from_millis(20));
        h.run_steps(1);
    }
    h.run_steps(2);
    assert!(h.query_by_label("Connected to OpenAI: 3 models available.").is_some());
    // The agreement, once.
    assert!(!ai_ui::consented(h.state()));
    h.get_by_label(accounts::CONSENT).click();
    h.run_steps(3);
    assert!(ai_ui::consented(h.state()));
    assert!(ai_ui::with_accounts(h.state(), |a| a.settings.consented).unwrap());
    h.get_by_label("Done").click();
    h.run_steps(3);
    assert!(!accounts::is_open(h.state()));
}

/// Preferences › AI Integrations opens AI Accounts too.
#[test]
fn preferences_open_ai_accounts() {
    let mut h = harness(|app| ai_ui::install_accounts(app, AiAccounts::in_memory()));
    invoke(&mut h, "edit.preferences.integrations").unwrap();
    h.run_steps(4);
    h.get_by_label("AI Accounts…").click();
    h.run_steps(4);
    assert!(accounts::is_open(h.state()));
}

/// Describe Image asks at once and shows the answer; Use as Document Description makes it the
/// document's description in one undo step.
#[test]
fn describe_image_shows_the_answer_and_can_become_the_description() {
    let mock = Arc::new(MockBackend::connected());
    mock.push(MockAnswer::Text("A plain white square.".into()));
    let m = Arc::clone(&mock);
    let mut h = harness(move |app| {
        with_mock(app, &m);
        app.background_jobs = true;
    });
    invoke(&mut h, "ai.describe").unwrap();
    until_idle(&mut h);
    assert_eq!(mock.calls().len(), 1);
    assert_eq!(describe::text(h.state()), Some("A plain white square."));
    assert!(h.query_by_label("Use as Document Description").is_some());
    h.get_by_label("Use as Document Description").click();
    h.run_steps(3);
    let info = h.state_mut().run("file.fileInfo", json!({})).unwrap();
    assert_eq!(info["description"], "A plain white square.");
    h.state_mut().run("edit.undo", json!({})).unwrap();
    let info = h.state_mut().run("file.fileInfo", json!({})).unwrap();
    assert_ne!(info["description"], "A plain white square.");
}

/// Describe without a chat provider opens AI Accounts and sends nothing.
#[test]
fn describe_without_a_provider_opens_ai_accounts() {
    let mock = Arc::new(MockBackend::disconnected());
    let m = Arc::clone(&mock);
    let mut h = harness(move |app| with_mock(app, &m));
    assert!(invoke(&mut h, "ai.describe").is_err());
    assert!(accounts::is_open(h.state()));
    assert!(mock.calls().is_empty());
}

/// The task bars: Generative Fill under a selection and Generative Expand in the Crop tool's bar
/// appear only once a provider has a key; Generate Background follows Remove Background.
#[test]
fn task_bar_items_appear_only_with_a_key() {
    let mock = Arc::new(MockBackend::disconnected());
    let m = Arc::clone(&mock);
    let mut h = harness(move |app| {
        with_mock(app, &m);
        app.ui.panels.context_task_bar = true;
        app.run("select.rect", json!({"x": 20, "y": 20, "width": 40, "height": 40})).unwrap();
    });
    assert_eq!(task_bar::which(h.state()), None, "no key: the bar stays as it was");
    let connected = Arc::new(MockBackend::connected());
    with_mock(h.state_mut(), &connected);
    h.run_steps(4);
    assert_eq!(task_bar::which(h.state()), Some(task_bar::Bar::Selection));
    assert!(h.query_by_label("Generate").is_some(), "the bar's Generate");
    // Generate from the bar with a prompt runs Generative Fill at once.
    h.state_mut().ai.bar_prompt = "a moon".into();
    task_bar::fill_from_bar(h.state_mut());
    h.run_steps(3);
    assert_eq!(connected.calls().len(), 1);
    assert!(layer_names(h.state()).iter().any(|n| n == "Generative Fill"));
    // Remove Background with the provider, then the bar offers Generate Background.
    h.state_mut().run("select.deselect", json!({})).unwrap();
    connected.push(MockAnswer::Pattern(|x, _| if x < 50 { [0, 0, 0, 0] } else { [10, 200, 30, 255] }));
    let r = ai_ui::menu(h.state_mut(), "ai.removeBackgroundWithProvider", &json!({})).unwrap();
    assert!(r.is_ok(), "{r:?}");
    h.run_steps(4);
    assert_eq!(task_bar::which(h.state()), Some(task_bar::Bar::AfterRemove));
    assert!(h.query_by_label("Generate Background…").is_some());
    // The Crop tool's bar: Generative Expand, which takes the frame's size and side.
    control(&mut h, "ui.set", json!({"tool": "crop"}));
    h.state_mut().ui.crop_rect = Some([-50.0, 0.0, 200.0, 160.0]);
    h.run_steps(4);
    assert!(h.query_by_label("Generative Expand").is_some());
    h.get_by_label("Generative Expand").click();
    h.run_steps(3);
    let g = &h.state().ai.generate;
    assert!(g.open && g.feature == "ai.generativeExpand");
    assert_eq!((g.width, g.height, g.anchor), (250, 160, "right"));
    assert!(h.state().ui.crop_rect.is_none(), "the frame is let go");
}

/// Agents run AI commands that send only with "Allow agents to run AI commands"; the person's own
/// clicks always may.
#[test]
fn agents_need_permission_to_run_ai_commands() {
    let mock = Arc::new(MockBackend::connected());
    let m = Arc::clone(&mock);
    let mut h = harness(move |app| {
        with_mock(app, &m);
        app.run("select.rect", json!({"x": 10, "y": 10, "width": 30, "height": 30})).unwrap();
    });
    let call = json!({"command": "ai.generativeFill", "params": {"prompt": "x"}});
    let v = control(&mut h, "engine.execute", call.clone());
    assert_eq!(v["ok"], false, "{v}");
    assert!(v["error"].as_str().unwrap_or_default().contains("Allow agents to run AI commands"), "{v}");
    assert!(mock.calls().is_empty(), "nothing sent");
    // Status and the local Remove Background never send: they pass.
    let v = control(&mut h, "engine.execute", json!({"command": "ai.status", "params": {}}));
    assert_eq!(v["ok"], true, "{v}");
    // Allowed in AI Accounts: the agent's call goes through.
    let mut a = AiAccounts::in_memory();
    a.settings.allow_agents = true;
    ai_ui::install_accounts(h.state_mut(), a);
    with_mock(h.state_mut(), &mock);
    let v = control(&mut h, "engine.execute", call);
    assert_eq!(v["ok"], true, "{v}");
    assert_eq!(mock.calls().len(), 1);
    // The person never needs it.
    let mut a = AiAccounts::in_memory();
    a.settings.allow_agents = false;
    ai_ui::install_accounts(h.state_mut(), a);
    with_mock(h.state_mut(), &mock);
    h.state_mut().run("ai.generativeFill", json!({"prompt": "y"})).unwrap();
    assert_eq!(mock.calls().len(), 2);
}

/// An agent can't get around the gate through another command: a script it runs with a step
/// that sends is refused at that step while "Allow agents to run AI commands" is off (as the
/// agent's own request is), and sends with it on. The person's own command right after is not
/// taken for the agent's.
#[test]
fn an_agent_running_a_script_with_an_ai_step_needs_permission_too() {
    let mock = Arc::new(MockBackend::connected());
    let m = Arc::clone(&mock);
    let mut h = harness(move |app| {
        ai_ui::install_accounts(app, AiAccounts::in_memory());
        with_mock(app, &m);
        app.run("select.rect", json!({"x": 10, "y": 10, "width": 30, "height": 30})).unwrap();
    });
    let script = json!({"command": "file.scripts.browse", "params": {"steps": [["ai.generativeFill", {"prompt": "x"}]]}});
    let v = control(&mut h, "engine.execute", script.clone());
    until_idle(&mut h);
    assert!(v.to_string().contains("Allow agents to run AI commands"), "the step is refused: {v}");
    assert!(mock.calls().is_empty(), "nothing sent: {:?}", mock.calls());
    assert_eq!(layer_names(h.state()).len(), 1, "nothing changed");
    // The person's own command right after is theirs.
    h.state_mut().run("ai.generativeFill", json!({"prompt": "y"})).unwrap();
    until_idle(&mut h);
    assert_eq!(mock.calls().len(), 1);
    // With "Allow agents to run AI commands" on, the agent's script sends.
    ai_ui::with_accounts(h.state(), |a| a.settings.allow_agents = true);
    let v = control(&mut h, "engine.execute", script);
    until_idle(&mut h);
    assert!(!v.to_string().contains("Allow agents"), "{v}");
    assert_eq!(mock.calls().len(), 2);
}

/// Playing an action never sends, whoever plays it and whatever the agents may do: a hand-built
/// action holding a step that sends stops at that step, from the control channel and from the
/// person's own Play alike.
#[test]
fn an_action_with_an_ai_step_never_sends() {
    let mock = Arc::new(MockBackend::connected());
    let m = Arc::clone(&mock);
    let mut h = harness(move |app| {
        let mut a = AiAccounts::in_memory();
        a.settings.allow_agents = true;
        ai_ui::install_accounts(app, a);
        with_mock(app, &m);
        app.run("select.rect", json!({"x": 10, "y": 10, "width": 30, "height": 30})).unwrap();
        app.session.actions.list.push(photocraft_engine::actions_cmds::Action::new("Built", Vec::new()));
    });
    let insert = json!({"command": "actions.insert", "params": {"action": "Built", "id": "ai.generativeFill", "params": {"prompt": "x"}}});
    let v = control(&mut h, "engine.execute", insert);
    assert_eq!(v["ok"], true, "{v}");
    let v = control(&mut h, "engine.execute", json!({"command": "actions.play", "params": {"action": "Built"}}));
    until_idle(&mut h);
    assert!(v.to_string().contains("do not run from an action"), "the agent's play stops at the step: {v}");
    let v = h.state_mut().run("actions.play", json!({"action": "Built"}));
    until_idle(&mut h);
    assert!(format!("{v:?}").contains("do not run from an action"), "the person's play too: {v:?}");
    assert!(mock.calls().is_empty(), "nothing sent: {:?}", mock.calls());
    assert_eq!(layer_names(h.state()).len(), 1, "nothing changed");
}

/// Click `label` as an agent does: `ui.click` through the control channel, its events delivered
/// in one frame the way the app's input hook delivers them (as automation's input).
fn synthetic_click(h: &mut Harness, label: &str) {
    let at = h.get_by_label(label).rect().center();
    let ctx = h.ctx.clone();
    let (req, _rx) = ControlRequest::new("ui.click", json!({"x": at.x, "y": at.y}));
    assert!(matches!(handle(h.state_mut(), &ctx, &req), Outcome::AfterInput), "ui.click on {label}");
    let events = h.state_mut().take_synthetic_step();
    assert!(!events.is_empty());
    h.input_mut().events.extend(events);
    h.step();
    h.run_steps(2);
}

/// The same click from the person's own pointer: the same events at the same place, in one
/// frame, not marked as automation's.
fn pointer_click(h: &mut Harness, label: &str) {
    let pos = h.get_by_label(label).rect().center();
    let button = |pressed| egui::Event::PointerButton { pos, button: egui::PointerButton::Primary, pressed, modifiers: Default::default() };
    h.input_mut().events.extend([egui::Event::PointerMoved(pos), button(true), button(false)]);
    h.step();
    h.run_steps(2);
}

/// Synthetic input can't spend the person's money or give itself the right to: an agent's click
/// on Generate sends nothing while "Allow agents to run AI commands" is off, and its clicks in AI
/// Accounts change neither the agreement nor that permission (it can still close the dialog). The
/// person's own clicks do both.
#[test]
fn synthetic_input_neither_sends_nor_grants_itself_permission() {
    let mock = Arc::new(MockBackend::connected());
    let m = Arc::clone(&mock);
    let mut h = harness(move |app| {
        ai_ui::install_accounts(app, AiAccounts::in_memory());
        with_mock(app, &m);
        app.run("select.rect", json!({"x": 10, "y": 10, "width": 30, "height": 30})).unwrap();
    });
    ai_ui::menu(h.state_mut(), "ai.generativeFill", &json!({"prompt": "clouds"})).unwrap().unwrap();
    h.run_steps(3);
    synthetic_click(&mut h, "Generate");
    until_idle(&mut h);
    assert!(mock.calls().is_empty(), "nothing sent: {:?}", mock.calls());
    let refused = h.state().ai.generate.error.as_ref().map(|e| e.message.clone()).unwrap_or_default();
    assert!(refused.contains("Allow agents to run AI commands"), "the click reached Generate and was refused: {refused:?}");
    assert_eq!(layer_names(h.state()).len(), 1, "nothing changed");

    invoke(&mut h, "ai.accounts").unwrap();
    let settings = |h: &Harness| ai_ui::with_accounts(h.state(), |a| (a.settings.consented, a.settings.allow_agents)).unwrap();
    assert_eq!(settings(&h), (false, false));
    synthetic_click(&mut h, accounts::CONSENT);
    synthetic_click(&mut h, "Allow agents to run AI commands");
    assert_eq!(settings(&h), (false, false), "an agent's clicks grant nothing");
    // The person's clicks do: the very same pointer events, when they are not automation's.
    pointer_click(&mut h, "Allow agents to run AI commands");
    assert_eq!(settings(&h), (false, true));
    pointer_click(&mut h, accounts::CONSENT);
    assert_eq!(settings(&h), (true, true));
    // And an agent can't take them back either.
    synthetic_click(&mut h, accounts::CONSENT);
    assert_eq!(settings(&h), (true, true));
    // Closing is all synthetic input may do there.
    synthetic_click(&mut h, "Done");
    assert!(!accounts::is_open(h.state()), "the synthetic click does reach the dialog");
    // With the permission given, the agent's Generate sends.
    synthetic_click(&mut h, "Generate");
    until_idle(&mut h);
    assert_eq!(mock.calls().len(), 1);
}

/// Generate Image into a new document, as a background job (how the app runs it): the document
/// appears with its one layer and the prompt as its description, the open document is left
/// alone, and a stopped request makes no document.
#[test]
fn generate_image_makes_a_new_document_in_the_background() {
    let mock = Arc::new(MockBackend::connected());
    let m = Arc::clone(&mock);
    let mut h = harness(move |app| {
        with_mock(app, &m);
        app.background_jobs = true;
    });
    invoke(&mut h, "ai.generateImage").unwrap();
    {
        let g = &mut h.state_mut().ai.generate;
        assert!(!g.new_document, "a layer by default with a document open");
        g.prompt = "a lighthouse at dawn".into();
        g.new_document = true;
        (g.width, g.height) = (96, 64);
    }
    generate::start(h.state_mut()).unwrap();
    assert!(h.state().ai.generate.job.is_some(), "a background job");
    until_idle(&mut h);
    assert_eq!(h.state().session.documents().len(), 2);
    let st = h.state().session.active().unwrap();
    assert_eq!((st.doc.size.width, st.doc.size.height), (96, 64));
    assert_eq!(layer_names(h.state()), ["Generated"]);
    let call = &mock.calls()[0];
    assert_eq!((call.op, call.width, call.height, call.prompt.as_str()), ("generate", 96, 64, "a lighthouse at dawn"));
    let info = h.state_mut().run("file.fileInfo", json!({})).unwrap();
    assert_eq!(info["description"], "a lighthouse at dawn");
    assert_eq!(h.state().session.documents()[0].doc.layers.len(), 1, "the open document is left alone");
    // Stopped: no document.
    mock.set_delay(Duration::from_secs(60));
    generate::start(h.state_mut()).unwrap();
    h.run_steps(2);
    assert!(generate::stop(h.state_mut()));
    until_idle(&mut h);
    assert_eq!(h.state().session.documents().len(), 2, "a stopped request makes nothing");
}

/// Generative Expand from its window, as a background job: the canvas grows and the new area is
/// filled in one undo step.
#[test]
fn generative_expand_grows_the_canvas_in_one_undo_step() {
    let mock = Arc::new(MockBackend::connected());
    let m = Arc::clone(&mock);
    let mut h = harness(move |app| {
        with_mock(app, &m);
        app.background_jobs = true;
    });
    invoke(&mut h, "ai.generativeExpand").unwrap();
    {
        let g = &mut h.state_mut().ai.generate;
        assert_eq!((g.feature, g.width, g.height, g.anchor), ("ai.generativeExpand", 200, 160, "center"));
        g.width = 260;
        g.anchor = "left";
    }
    generate::start(h.state_mut()).unwrap();
    until_idle(&mut h);
    let size = |h: &Harness| h.state().session.active().map(|st| (st.doc.size.width, st.doc.size.height));
    assert_eq!(size(&h), Some((260, 160)));
    assert!(layer_names(h.state()).iter().any(|n| n == "Generative Expand"));
    let call = &mock.calls()[0];
    assert_eq!((call.width, call.height), (260, 160));
    assert!(call.mask_coverage.is_some_and(|c| (c - 60.0 / 260.0).abs() < 0.02), "only the new band may change: {:?}", call.mask_coverage);
    h.state_mut().run("edit.undo", json!({})).unwrap();
    assert_eq!(size(&h), Some((200, 160)), "one undo step takes the canvas and the fill back");
    assert!(!layer_names(h.state()).iter().any(|n| n == "Generative Expand"));
}

/// The last prompt of each feature is kept in `ai.json` and fills the window next time.
#[test]
fn the_last_prompt_comes_back() {
    let mock = Arc::new(MockBackend::connected());
    let m = Arc::clone(&mock);
    let mut h = harness(move |app| {
        ai_ui::install_accounts(app, AiAccounts::in_memory());
        with_mock(app, &m);
        app.run("select.rect", json!({"x": 10, "y": 10, "width": 30, "height": 30})).unwrap();
    });
    ai_ui::menu(h.state_mut(), "ai.generativeFill", &json!({"prompt": "a lighthouse"})).unwrap().unwrap();
    generate::start(h.state_mut()).unwrap();
    generate::close(h.state_mut());
    assert_eq!(ai_ui::with_accounts(h.state(), |a| a.settings.last_fill_prompt.clone()).flatten().as_deref(), Some("a lighthouse"));
    invoke(&mut h, "ai.generativeFill").unwrap();
    assert_eq!(h.state().ai.generate.prompt, "a lighthouse");
    // Sky Replacement starts from JavaScript Pigment's prompt.
    generate::close(h.state_mut());
    invoke(&mut h, "ai.replaceSky").unwrap();
    assert_eq!(h.state().ai.generate.prompt, generate::SKY_PROMPT);
}
