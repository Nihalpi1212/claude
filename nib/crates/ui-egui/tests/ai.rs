//! Nib's generative AI in the app (src/ai.rs, docs/generative-ai.md): the commands that open the
//! Generate window and when they are dimmed, AI Accounts, a whole Generate → place → Undo run
//! against a local mock provider, and the API key never showing up in what the app draws, saves
//! or reports. No request ever leaves this machine: providers point at a `TcpListener` on
//! 127.0.0.1.
// Integration tests: unwrapping and panicking on failure is fine here, unlike in shipped code (AGENTS.md › Robustness).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#![cfg(not(target_arch = "wasm32"))]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use egui::accesskit::Role;
use egui_kittest::kittest::{By, NodeT, Queryable};
use serde_json::{Value, json};
use vectorcraft_engine::Session;
use vectorcraft_ui_egui::VectorcraftApp;
use vectorcraft_ui_egui::ai::nib_genai::{AiAccounts, Feature, GenAi, ProviderKind};
use vectorcraft_ui_egui::ai::{self, AiUi};
use vectorcraft_ui_egui::menus;

const KEY: &str = "sk-test-0123456789abcdefWXYZ";

const SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" width="100" height="50"><rect x="0" y="0" width="100" height="50" fill="#204060"/><circle cx="50" cy="25" r="20" fill="#e0a030"/></svg>"##;

/// A local HTTP server answering every request with `body` (status 200), recording the paths.
struct Mock {
    base: String,
    paths: Arc<Mutex<Vec<String>>>,
}

fn mock(body: Value) -> Mock {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let paths = Arc::new(Mutex::new(vec![]));
    let log = paths.clone();
    let body = serde_json::to_vec(&body).unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let (log, body) = (log.clone(), body.clone());
            std::thread::spawn(move || serve(stream, &log, &body));
        }
    });
    Mock { base, paths }
}

fn serve(stream: TcpStream, log: &Mutex<Vec<String>>, body: &[u8]) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut line = String::new();
    if reader.read_line(&mut line).unwrap_or(0) == 0 {
        return;
    }
    let path = line.split_whitespace().nth(1).unwrap_or_default().to_string();
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
    log.lock().unwrap().push(path);
    let mut out = stream;
    let head = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    let _ = out.write_all(head.as_bytes());
    let _ = out.write_all(body);
}

/// An OpenAI Responses answer with `text`.
fn openai_text(text: &str) -> Value {
    json!({
        "id": "resp_1", "object": "response", "status": "completed",
        "output": [{"type": "message", "id": "msg_1", "role": "assistant", "status": "completed",
                    "content": [{"type": "output_text", "text": text, "annotations": []}]}],
        "usage": {"input_tokens": 10, "output_tokens": 20, "total_tokens": 30}
    })
}

/// An app with a document; AI accounts in memory, without a key.
fn app() -> VectorcraftApp {
    let mut app = VectorcraftApp::new(Session::new(), Default::default());
    app.run("file.new", json!({"width": 400, "height": 300})).unwrap();
    app
}

/// An app whose OpenAI key works against `server`, with the agreement given.
fn app_with(server: &Mock) -> VectorcraftApp {
    let mut app = app();
    let mut a = AiAccounts::in_memory();
    a.set_key(ProviderKind::OpenAi, KEY).unwrap();
    a.set_base_url(ProviderKind::OpenAi, &server.base).unwrap();
    a.settings.consented = true;
    app.ai = AiUi::new(GenAi::new(a));
    app
}

/// A harness drawing the AI windows (and the dialogs) of `app`.
fn harness(app: VectorcraftApp) -> egui_kittest::Harness<'static, VectorcraftApp> {
    let mut fonts = false;
    let mut h = egui_kittest::Harness::builder().with_size(egui::vec2(1280.0, 900.0)).with_accessibility_check(false).build_ui_state(
        move |ui, app: &mut VectorcraftApp| {
            if !std::mem::replace(&mut fonts, true) {
                vectorcraft_ui_egui::theme::install_fonts(ui.ctx());
                return;
            }
            vectorcraft_ui_egui::dialogs::show(app, ui.ctx());
            ai::show(app, ui.ctx());
            ai::poll(app);
        },
        app,
    );
    h.run_steps(3);
    h
}

/// Click the text field labelled `label` and type `text` into it.
fn type_into(h: &mut egui_kittest::Harness<'static, VectorcraftApp>, label: &str, text: &str) {
    h.get_by_label(label).click();
    h.run_steps(2);
    h.get_by_label(label).type_text(text);
    h.run_steps(2);
}

/// Draw frames until the Generate window's request (or the connection test) has ended.
fn until_done(h: &mut egui_kittest::Harness<'static, VectorcraftApp>) {
    for _ in 0..1200 {
        h.run_steps(1);
        let a = &h.state().ai;
        if !menus::enabled(h.state(), ai::CANCEL) && !a.testing() {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    h.run_steps(3);
}

fn object_count(app: &VectorcraftApp) -> usize {
    app.session.active().unwrap().doc.node_count()
}

fn undo_steps(app: &VectorcraftApp) -> usize {
    app.session.doc().unwrap().history.undo.len()
}

fn select(app: &mut VectorcraftApp, id: &Value) {
    app.run("select.set", json!({"ids": [id]})).unwrap();
}

fn png(w: u32, h: u32) -> Vec<u8> {
    let img = image::RgbaImage::from_pixel(w, h, image::Rgba([200, 60, 40, 255]));
    let mut out = std::io::Cursor::new(vec![]);
    img.write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

/// Each feature command opens the Generate window on its feature, and is dimmed, saying why,
/// while the selection doesn't suit it. No key is needed to open the window.
#[test]
fn commands_open_the_generate_window_on_their_feature() {
    let mut app = app();
    assert!(!app.ai.has_key());
    // Text to Vector Graphic and Pattern work on nothing selected.
    for (id, feature) in [(ai::TEXT_TO_VECTOR, Feature::TextToVector), (ai::PATTERN, Feature::Pattern)] {
        assert!(menus::enabled(&app, id), "{id}");
        assert_eq!(app.run(id, json!({})).unwrap()["feature"], json!(feature.id()), "{id}");
        assert!(app.ai.generate_open());
        assert_eq!(app.ai.generate_feature(), feature);
    }
    // The others need a selection that suits them.
    for (id, feature) in
        [(ai::SHAPE_FILL, Feature::ShapeFill), (ai::EXPAND, Feature::Expand), (ai::RECOLOR, Feature::Recolor), (ai::REWRITE, Feature::Rewrite)]
    {
        assert!(!menus::enabled(&app, id), "{id} needs a selection");
        assert!(ai::unsuitable(&app, feature).is_some(), "{id} says why");
        assert!(app.run(id, json!({})).is_err(), "{id}");
    }
    // A closed shape: Shape Fill and Recolor.
    let rect = app.run("shape.rectangle", json!({"x": 20, "y": 20, "width": 100, "height": 60})).unwrap()["id"].clone();
    app.run("paint.setFill", json!({"color": "#cc6666"})).unwrap();
    select(&mut app, &rect);
    for (id, feature) in [(ai::SHAPE_FILL, Feature::ShapeFill), (ai::RECOLOR, Feature::Recolor)] {
        assert!(menus::enabled(&app, id), "{id}");
        app.run(id, json!({"prompt": "autumn leaves"})).unwrap();
        assert_eq!(app.ai.generate_feature(), feature);
    }
    assert!(!menus::enabled(&app, ai::EXPAND) && !menus::enabled(&app, ai::REWRITE));
    // A type object: Rewrite Text.
    let text = app.run("text.create", json!({"x": 30, "y": 200, "text": "Big sale today"})).unwrap()["id"].clone();
    select(&mut app, &text);
    assert!(menus::enabled(&app, ai::REWRITE));
    app.run(ai::REWRITE, json!({})).unwrap();
    assert_eq!(app.ai.generate_feature(), Feature::Rewrite);
    // A placed image: Generative Expand.
    app.run("file.place", json!({"name": "red.png", "dataBase64": vectorcraft_format::base64_encode(&png(40, 30)), "link": false})).unwrap();
    assert!(menus::enabled(&app, ai::EXPAND), "the placed image is selected");
    app.run(ai::EXPAND, json!({})).unwrap();
    assert_eq!(app.ai.generate_feature(), Feature::Expand);
    // Window › Generate shows Text to Vector Graphic and is checked while it shows; again hides it.
    app.run(ai::PANEL, json!({})).unwrap();
    assert_eq!(app.ai.generate_feature(), Feature::TextToVector);
    assert_eq!(menus::checked(&app, ai::PANEL, &Value::Null), Some(true));
    app.run(ai::PANEL, json!({})).unwrap();
    assert!(!app.ai.generate_open());
    // Every command is in the menus.
    let mut ids = vec![];
    fn walk(items: &[menus::Item], ids: &mut Vec<&'static str>) {
        for it in items {
            match it {
                menus::Item::Cmd(_, id, _) => ids.push(id),
                menus::Item::Sub(_, ch) => walk(ch, ids),
                _ => {}
            }
        }
    }
    for (_, items) in menus::menu_tree() {
        walk(&items, &mut ids);
    }
    for id in [ai::TEXT_TO_VECTOR, ai::SHAPE_FILL, ai::PATTERN, ai::EXPAND, ai::RECOLOR, ai::REWRITE, ai::PANEL, ai::ACCOUNTS] {
        assert!(ids.contains(&id), "{id} is in a menu");
        assert!(menus::UI_COMMANDS.iter().any(|c| c.0 == id), "{id} is a command (palette, control)");
    }
}

/// Without a key the Generate window says so and links to AI Accounts; Generate is dimmed with
/// the reason, and nothing is sent. Once a key is set but the agreement isn't given, Generate is
/// still dimmed.
#[test]
fn without_a_key_generate_is_dimmed_and_ai_accounts_opens_from_the_window() {
    let mut app = app();
    app.run(ai::TEXT_TO_VECTOR, json!({"prompt": "a fox"})).unwrap();
    assert!(!menus::enabled(&app, ai::GENERATE));
    assert!(app.run(ai::GENERATE, json!({})).unwrap_err().contains("API key"));
    let mut h = harness(app);
    let generate = h.get_by_role_and_label(Role::Button, "Generate");
    assert!(generate.accesskit_node().is_disabled(), "Generate is dimmed without a key");
    h.get_by_label_contains("No API key is set");
    h.get_by_label("Open AI Accounts…").click();
    h.run_steps(3);
    assert!(h.state().ai.accounts_open());
    // AI Accounts: both providers, the masked key field, the note on what is sent and billing.
    h.get_by_label("OpenAI");
    h.get_by_label("Google Gemini");
    h.get_by_label_contains("The provider bills your account");
    h.get_by_label_contains("What is sent");
    assert!(h.get_by_role_and_label(Role::Button, "Test Connection").accesskit_node().is_disabled(), "nothing to test without a key");
    assert!(h.get_by_role_and_label(Role::Button, "Remove Key").accesskit_node().is_disabled());
    // A key alone isn't enough: the agreement comes first.
    h.state_mut().ai.genai.accounts.set_key(ProviderKind::OpenAi, KEY).unwrap();
    h.state_mut().ai.refresh();
    h.get_by_label("Done").click();
    h.run_steps(3);
    assert!(!h.state().ai.accounts_open());
    assert!(!menus::enabled(h.state(), ai::GENERATE));
    assert!(ai::disabled_hint(h.state(), ai::GENERATE).unwrap().contains("Agree"));
    assert!(h.get_by_role_and_label(Role::Button, "Generate").accesskit_node().is_disabled());
}

/// Edit › AI Accounts… and Preferences' button open the dialog.
#[test]
fn ai_accounts_opens_from_the_edit_menu_and_preferences() {
    let mut app = app();
    app.run(ai::ACCOUNTS, json!({})).unwrap();
    assert!(app.ai.accounts_open());
    let mut h = harness(app);
    h.get_by_label("Done").click();
    h.run_steps(3);
    assert!(!h.state().ai.accounts_open());
    h.state_mut().run("edit.preferences", json!({})).unwrap();
    h.run_steps(3);
    h.get_by_role_and_label(Role::Button, "AI Accounts…").click();
    h.run_steps(3);
    assert!(h.state().ai.accounts_open(), "Preferences › AI Accounts…");
}

/// Type a prompt, press Generate: the request goes to the (mock) provider off the UI thread, the
/// results show as thumbnails, a click places one as one undo step, and Undo takes it back.
#[test]
fn generate_place_and_undo_with_a_mock_provider() {
    let server = mock(openai_text(SVG));
    let mut app = app_with(&server);
    app.run(ai::TEXT_TO_VECTOR, json!({})).unwrap();
    let mut h = harness(app);
    assert!(server.paths.lock().unwrap().is_empty(), "nothing is sent before Generate");
    type_into(&mut h, "Prompt", "a fox at dusk");
    assert!(server.paths.lock().unwrap().is_empty(), "typing sends nothing");
    let (before_count, before_steps) = (object_count(h.state()), undo_steps(h.state()));
    h.get_by_role_and_label(Role::Button, "Generate").click();
    h.run_steps(1);
    assert!(menus::enabled(h.state(), ai::CANCEL) || menus::enabled(h.state(), ai::PLACE), "the request started");
    // The request runs on a worker: the window keeps drawing until it ends.
    until_done(&mut h);
    assert!(menus::enabled(h.state(), ai::PLACE), "a result came back");
    let paths = server.paths.lock().unwrap().clone();
    assert!(!paths.is_empty() && paths.iter().all(|p| p == "/v1/responses"), "{paths:?}");
    assert_eq!(object_count(h.state()), before_count, "nothing placed before a click");
    h.get_by_label_contains("results. Click one to place it.");
    h.get_by_role_and_label(Role::Button, "Result 1").click();
    h.run_steps(3);
    assert!(object_count(h.state()) > before_count, "the art was placed");
    assert_eq!(undo_steps(h.state()), before_steps + 1, "one undo step");
    h.get_by_label_contains("Placed result 1");
    h.state_mut().run("edit.undo", json!({})).unwrap();
    assert_eq!(object_count(h.state()), before_count, "Undo takes it back");
    // Another result places again.
    h.run_steps(2);
    h.get_by_role_and_label(Role::Button, "Result 2").click();
    h.run_steps(3);
    assert!(object_count(h.state()) > before_count);
}

/// A slow provider: Stop answers at once, nothing is placed, and the late answer is dropped.
#[test]
fn stop_cancels_a_running_request() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    // Accepts and never answers.
    let held = Arc::new(Mutex::new(vec![]));
    let keep = held.clone();
    std::thread::spawn(move || {
        for s in listener.incoming().flatten() {
            keep.lock().unwrap().push(s);
        }
    });
    let mut app = app_with(&Mock { base, paths: Arc::new(Mutex::new(vec![])) });
    app.run(ai::TEXT_TO_VECTOR, json!({"prompt": "a fox"})).unwrap();
    app.run(ai::GENERATE, json!({})).unwrap();
    assert!(menus::enabled(&app, ai::CANCEL));
    let mut h = harness(app);
    h.get_by_role_and_label(Role::Button, "Stop").click();
    h.run_steps(3);
    assert!(!menus::enabled(h.state(), ai::CANCEL));
    h.get_by_label_contains("Stopped. Nothing was placed.");
    assert!(!menus::enabled(h.state(), ai::PLACE));
}

/// The key typed in AI Accounts is stored, the field is cleared, and the key appears nowhere the
/// app draws, saves or reports: not in the accessibility tree (what is drawn), the preferences,
/// `ai.json`, `ui.inspect` or the command list.
#[test]
fn the_key_never_appears_in_what_is_drawn_or_saved() {
    let dir = std::env::temp_dir().join(format!("nib-ui-ai-key-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut app = app();
    ai::use_config_dir(&mut app, &dir);
    app.run(ai::ACCOUNTS, json!({})).unwrap();
    let mut h = harness(app);
    type_into(&mut h, "API key", KEY);
    let shows_key = |h: &egui_kittest::Harness<'_, VectorcraftApp>| {
        h.query_all(By::new().include_labels().predicate(|n| {
            n.label().is_some_and(|l| l.contains(KEY))
                || n.value().is_some_and(|v| v.contains(KEY))
                || n.description().is_some_and(|d| d.contains(KEY))
        }))
        .count()
    };
    assert_eq!(shows_key(&h), 0, "the field is masked");
    // The field's egui state (whose undo history holds the typed text) is forgotten once the field
    // is empty again, so Undo can't put the key back.
    let key_field = egui::Id::new("nib-ai-accounts-key");
    assert!(egui::TextEdit::load_state(&h.ctx, key_field).is_some(), "the field keeps state while typing");
    h.get_by_role_and_label(Role::Button, "Save Key").click();
    h.run_steps(3);
    assert!(h.state().ai.connected(ProviderKind::OpenAi), "stored");
    assert!(egui::TextEdit::load_state(&h.ctx, key_field).is_none(), "no undo history of the key is left");
    h.get_by_label_contains("Key saved (ends in …WXYZ)");
    assert_eq!(shows_key(&h), 0);
    // The agreement and a default provider are saved to ai.json, without the key.
    h.get_by_label_contains("I agree that the AI commands send").click();
    h.get_by_label("Use this provider for the AI commands").click();
    h.run_steps(3);
    assert!(h.state().ai.consented());
    let settings = std::fs::read_to_string(dir.join("ai.json")).unwrap();
    assert!(settings.contains("consented") && !settings.contains(KEY), "{settings}");
    let app = h.state();
    let mut prefs = serde_json::to_value(&app.ui).unwrap();
    prefs["engine_prefs"] = app.session.prefs.to_json();
    assert!(!prefs.to_string().contains(KEY), "the preferences hold no key");
    assert!(!vectorcraft_ui_egui::control::inspect(app, &h.ctx).to_string().contains(KEY), "ui.inspect");
    assert!(!vectorcraft_ui_egui::control::all_commands(app).to_string().contains(KEY));
    assert!(!format!("{:?}", app.ai.status()).contains(KEY));
    // Removing the key: no key is left in the store.
    h.get_by_role_and_label(Role::Button, "Remove Key").click();
    h.run_steps(3);
    assert!(!h.state().ai.has_key());
    let _ = std::fs::remove_dir_all(&dir);
}

/// Test Connection lists the provider's models (the mock catalog) on a worker.
#[test]
fn test_connection_reports_the_models() {
    let server = mock(json!({"object": "list", "data": [{"id": "gpt-5.1", "object": "model"}, {"id": "gpt-image-1", "object": "model"}]}));
    let mut app = app_with(&server);
    app.run(ai::ACCOUNTS, json!({})).unwrap();
    let mut h = harness(app);
    h.get_by_role_and_label(Role::Button, "Test Connection").click();
    until_done(&mut h);
    h.get_by_label_contains("Connected to OpenAI: 2 models available.");
    assert_eq!(server.paths.lock().unwrap().as_slice(), ["/v1/models"]);
}

/// Run the Generate window's request to its end without drawing (as a script does).
fn generate_now(app: &mut VectorcraftApp) {
    app.run(ai::GENERATE, json!({})).unwrap();
    assert!(ai::wait(app, Duration::from_secs(20)), "the request ended");
    assert!(menus::enabled(app, ai::PLACE), "a result came back");
}

fn colors(app: &mut VectorcraftApp, ids: &[&Value]) -> Vec<String> {
    let v = app.run("recolor.colors", json!({"ids": ids})).unwrap();
    // The rectangles' black strokes aside.
    let mut out: Vec<String> =
        v["colors"].as_array().unwrap().iter().map(|c| c["hex"].as_str().unwrap().to_string()).filter(|c| c != "#000000").collect();
    out.sort();
    out
}

/// Trying a feature's results one after the other on the object it changes in place swaps them:
/// the second palette recolours the original art (it used to recolour nothing and still say it
/// was placed), and Undo then goes back to the original in one step.
#[test]
fn another_recolor_result_replaces_the_one_placed() {
    let palettes = json!({"palettes": [
        {"name": "Sea", "colors": ["#003049", "#fcbf49"]},
        {"name": "Forest", "colors": ["#1b4332", "#95d5b2"]}
    ]});
    let server = mock(openai_text(&palettes.to_string()));
    let mut app = app_with(&server);
    let a = app.run("shape.rectangle", json!({"x": 10, "y": 10, "width": 50, "height": 50})).unwrap()["id"].clone();
    app.run("paint.setFill", json!({"ids": [a], "color": "#ff0000"})).unwrap();
    let b = app.run("shape.rectangle", json!({"x": 100, "y": 10, "width": 50, "height": 50})).unwrap()["id"].clone();
    app.run("paint.setFill", json!({"ids": [b], "color": "#00ff00"})).unwrap();
    app.run("select.set", json!({"ids": [a, b]})).unwrap();
    let original = colors(&mut app, &[&a, &b]);
    app.run(ai::RECOLOR, json!({"prompt": "the sea"})).unwrap();
    generate_now(&mut app);
    let steps = undo_steps(&app);
    app.run(ai::PLACE, json!({"variation": 0})).unwrap();
    assert_eq!(colors(&mut app, &[&a, &b]), ["#003049", "#fcbf49"]);
    app.run(ai::PLACE, json!({"variation": 1})).unwrap();
    assert_eq!(colors(&mut app, &[&a, &b]), ["#1b4332", "#95d5b2"], "the second palette recolours the art");
    assert_eq!(undo_steps(&app), steps + 1, "the second result replaced the first");
    app.run("edit.undo", json!({})).unwrap();
    assert_eq!(colors(&mut app, &[&a, &b]), original);
    // After an Undo there is nothing to swap: the next result is placed as usual.
    app.run(ai::PLACE, json!({"variation": 0})).unwrap();
    assert_eq!(colors(&mut app, &[&a, &b]), ["#003049", "#fcbf49"]);
    assert_eq!(undo_steps(&app), steps + 1);
}

/// Generative Shape Fill's second result fills the shape in place of the first one, instead of
/// clipping the first result's clip group again (a nested clip group holding both).
#[test]
fn another_shape_fill_result_replaces_the_one_placed() {
    let server = mock(openai_text(SVG));
    let mut app = app_with(&server);
    let shape = app.run("shape.ellipse", json!({"x": 10, "y": 10, "width": 200, "height": 100})).unwrap()["id"].clone();
    select(&mut app, &shape);
    app.run(ai::SHAPE_FILL, json!({"prompt": "leaves"})).unwrap();
    generate_now(&mut app);
    let (count, steps) = (object_count(&app), undo_steps(&app));
    app.run(ai::PLACE, json!({"variation": 0})).unwrap();
    let placed = object_count(&app);
    assert!(placed > count);
    app.run(ai::PLACE, json!({"variation": 1})).unwrap();
    assert_eq!(object_count(&app), placed, "one clip group, holding one result");
    assert_eq!(undo_steps(&app), steps + 1);
    app.run("edit.undo", json!({})).unwrap();
    assert_eq!(object_count(&app), count, "Undo leaves the shape as it was");
}

/// A request whose document is closed while it runs is stopped (the provider would bill an answer
/// nothing can place), and the window says why.
#[test]
fn closing_the_document_stops_its_request() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let held = Arc::new(Mutex::new(vec![]));
    let keep = held.clone();
    std::thread::spawn(move || {
        for s in listener.incoming().flatten() {
            keep.lock().unwrap().push(s);
        }
    });
    let mut app = app_with(&Mock { base, paths: Arc::new(Mutex::new(vec![])) });
    app.run(ai::TEXT_TO_VECTOR, json!({"prompt": "a fox"})).unwrap();
    app.run(ai::GENERATE, json!({})).unwrap();
    assert!(menus::enabled(&app, ai::CANCEL));
    app.run("file.close", json!({})).unwrap();
    assert!(app.session.documents().is_empty());
    let mut h = harness(app);
    h.run_steps(2);
    assert!(!menus::enabled(h.state(), ai::CANCEL), "the request was stopped");
    assert!(h.state().ai.genai.jobs.running().is_empty());
    h.get_by_label_contains("The document was closed, so its request was stopped.");
}

/// Test Connection counts one model in the singular.
#[test]
fn test_connection_with_one_model() {
    let server = mock(json!({"object": "list", "data": [{"id": "gpt-5.1", "object": "model"}]}));
    let mut app = app_with(&server);
    app.run(ai::ACCOUNTS, json!({})).unwrap();
    let mut h = harness(app);
    h.get_by_role_and_label(Role::Button, "Test Connection").click();
    until_done(&mut h);
    h.get_by_label_contains("Connected to OpenAI: 1 model available.");
}

/// The provider picked in the Generate window loses its key in AI Accounts: Generate goes to the
/// provider that still has one, instead of staying dimmed ("Add an API key") with the Provider row,
/// shown only while both have a key, gone.
#[test]
fn a_picked_provider_whose_key_is_removed_falls_back_to_the_other() {
    let server = mock(openai_text(SVG));
    let mut app = app_with(&server);
    app.ai.genai.accounts.set_key(ProviderKind::Gemini, "AIzaTest0123456789abcdefQRST").unwrap();
    app.ai.genai.accounts.set_base_url(ProviderKind::Gemini, &server.base).unwrap();
    app.ai.refresh();
    app.run(ai::TEXT_TO_VECTOR, json!({"prompt": "a fox"})).unwrap();
    let mut h = harness(app);
    h.get_by_label("Google Gemini").click();
    h.run_steps(2);
    // Gemini is picked: its request goes out (and the OpenAI-shaped answer is refused).
    h.state_mut().run(ai::GENERATE, json!({})).unwrap();
    until_done(&mut h);
    assert!(server.paths.lock().unwrap().iter().all(|p| p.contains(":generateContent")), "{:?}", server.paths.lock().unwrap());
    server.paths.lock().unwrap().clear();
    h.state_mut().ai.genai.accounts.clear_key(ProviderKind::Gemini).unwrap();
    h.state_mut().ai.refresh();
    h.run_steps(2);
    assert!(menus::enabled(h.state(), ai::GENERATE), "{:?}", ai::disabled_hint(h.state(), ai::GENERATE));
    h.state_mut().run(ai::GENERATE, json!({})).unwrap();
    until_done(&mut h);
    assert!(menus::enabled(h.state(), ai::PLACE));
    let paths = server.paths.lock().unwrap().clone();
    assert!(!paths.is_empty() && paths.iter().all(|p| p == "/v1/responses"), "{paths:?}");
}
