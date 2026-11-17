//! Pigment: Window › Assistant (`src/ai_ui/assistant*`, docs/generative-ai.md › The Assistant).
//! The tools (each maps to its engine command and is one undo step; ids, ranges, rectangles and
//! JSON-text arguments are checked; blocked commands are refused and the model is told), the turn
//! (the image and the tools go out, tool results come back, twelve rounds at most, Stop, a
//! dialog the person has to finish), a conversation per document, and who may send.
//!
//! No request leaves this machine: the engine's `MockBackend` plays the chat model, with its
//! turns scripted in advance.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use egui_kittest::kittest::Queryable;
use photocraft_engine::Session;
use photocraft_engine::generative::mock::{MockAnswer, MockBackend};
use photocraft_engine::generative::{
    BackendStatus, ChatMessage, ChatRequest, ChatTurn, Describe, GenError, GenerativeBackend, ImageEdit, ImageGen, ModelEntry, ProviderId, ToolCall,
};
use photocraft_raster::Rgba8Image;
use photocraft_ui_egui::PhotocraftApp;
use photocraft_ui_egui::ai_ui::assistant_tools::{self as tools, Outcome};
use photocraft_ui_egui::ai_ui::{self, accounts, assistant};
use photocraft_ui_egui::menus;
use pigment_genai::AiAccounts;
use serde_json::{Value, json};

use super::ai::{Harness, harness, layer_names, synthetic_click, type_into, with_mock};

/// The mock backend, keeping every chat request whole (the mock itself only counts them).
struct Recorder {
    mock: Arc<MockBackend>,
    requests: Mutex<Vec<ChatRequest>>,
}

impl Recorder {
    fn new(mock: MockBackend) -> Arc<Self> {
        Arc::new(Self { mock: Arc::new(mock), requests: Mutex::new(Vec::new()) })
    }

    fn connected() -> Arc<Self> {
        Self::new(MockBackend::connected())
    }

    fn requests(&self) -> Vec<ChatRequest> {
        self.requests.lock().unwrap().clone()
    }

    /// Script the model's next answer: `text` and tool calls (name, arguments).
    fn answer(&self, text: &str, calls: &[(&str, Value)]) {
        let tool_calls = calls
            .iter()
            .enumerate()
            .map(|(i, (name, arguments))| ToolCall { id: format!("call_{i}"), name: (*name).into(), arguments: arguments.clone() })
            .collect();
        self.mock.push(MockAnswer::Turn(ChatTurn { text: text.into(), tool_calls, provider_state: json!({"kept": text}) }));
    }

    fn install(self: &Arc<Self>, app: &mut PhotocraftApp) {
        ai_ui::install_backend(app, Arc::clone(self) as Arc<dyn GenerativeBackend>);
    }
}

impl GenerativeBackend for Recorder {
    fn status(&self) -> BackendStatus {
        self.mock.status()
    }

    fn admit(&self, automated: bool) -> Result<(), GenError> {
        self.mock.admit(automated)
    }

    fn edit_image(&self, req: &ImageEdit, cancelled: &dyn Fn() -> bool) -> Result<Rgba8Image, GenError> {
        self.mock.edit_image(req, cancelled)
    }

    fn generate_image(&self, req: &ImageGen, cancelled: &dyn Fn() -> bool) -> Result<Rgba8Image, GenError> {
        self.mock.generate_image(req, cancelled)
    }

    fn describe(&self, req: &Describe, cancelled: &dyn Fn() -> bool) -> Result<String, GenError> {
        self.mock.describe(req, cancelled)
    }

    fn chat(&self, req: &ChatRequest, cancelled: &dyn Fn() -> bool) -> Result<ChatTurn, GenError> {
        self.requests.lock().unwrap().push(req.clone());
        self.mock.chat(req, cancelled)
    }

    fn list_models(&self, provider: ProviderId, cancelled: &dyn Fn() -> bool) -> Result<Vec<ModelEntry>, GenError> {
        self.mock.list_models(provider, cancelled)
    }
}

/// The app without a window: a 200 × 160 white document with its Background layer.
fn app() -> PhotocraftApp {
    let mut app = PhotocraftApp::new(Session::new(), Default::default());
    app.session.prefs.edit(|p| p.interface.language = "en".into());
    app.run("file.new", json!({"width": 200, "height": 160, "background": "white"})).expect("new");
    app
}

/// Run a tool as the Assistant does; its result, or what the model is told went wrong.
fn tool(app: &mut PhotocraftApp, name: &str, args: Value) -> Result<Value, String> {
    match tools::run(app, &egui::Context::default(), name, &args)? {
        Outcome::Done(v) => Ok(v),
        Outcome::Job { .. } => panic!("{name} started a job"),
        Outcome::Dialog { .. } => panic!("{name} opened a dialog"),
    }
}

fn history(app: &PhotocraftApp) -> Vec<String> {
    let doc = photocraft_engine::inspect::document(app.session.active().expect("a document"));
    doc["history"]
        .as_array()
        .expect("history")
        .iter()
        .map(|h| h.as_str().map_or_else(|| h["name"].as_str().unwrap_or_default().to_string(), str::to_string))
        .collect()
}

/// The composite's pixel at (x, y), 8-bit RGBA.
fn pixel(app: &PhotocraftApp, x: u32, y: u32) -> [u8; 4] {
    let doc = &app.session.active().expect("a document").doc;
    let img = photocraft_compose::thumbnail(doc, doc.size.width.max(doc.size.height));
    let i = (y * img.width + x) as usize * 4;
    [img.pixels[i], img.pixels[i + 1], img.pixels[i + 2], img.pixels[i + 3]]
}

fn size(app: &PhotocraftApp) -> (u32, u32) {
    let doc = &app.session.active().expect("a document").doc;
    (doc.size.width, doc.size.height)
}

fn active_layer(app: &PhotocraftApp) -> u64 {
    app.session.active().and_then(|st| st.active_layer).expect("an active layer").0
}

/// Run `name`, check it made exactly one history step, and that one Undo takes it back.
fn one_step(app: &mut PhotocraftApp, name: &str, args: Value) -> Value {
    let before = history(app);
    let r = tool(app, name, args.clone()).unwrap_or_else(|e| panic!("{name} {args}: {e}"));
    let after = history(app);
    assert_eq!(after.len(), before.len() + 1, "{name} is one undo step: {before:?} -> {after:?}");
    app.run("edit.undo", json!({})).expect("undo");
    app.run("edit.redo", json!({})).expect("redo");
    assert_eq!(history(app), after, "{name}: undo and redo");
    r
}

/// `get_document` is the short form the model needs; `new_layer`, `set_layer_props` and
/// `set_active_layer` run their commands, each one undo step, and check what they are given.
#[test]
fn the_layer_tools_run_their_commands_and_check_ids() {
    let mut app = app();
    let background = active_layer(&app);
    let doc = tool(&mut app, "get_document", json!({})).unwrap();
    assert_eq!((doc["width"].as_u64(), doc["height"].as_u64()), (Some(200), Some(160)));
    assert_eq!((doc["activeLayer"].clone(), doc["selection"].clone()), (json!(background), Value::Null));
    let layer = &doc["layers"][0];
    assert_eq!(
        (layer["id"].clone(), layer["type"].as_str(), layer["opacity"].as_f64(), layer["blend"].as_str()),
        (json!(background), Some("pixel"), Some(100.0), Some("Normal"))
    );
    assert_eq!((layer["active"].as_bool(), layer["visible"].as_bool(), layer["background"].as_bool()), (Some(true), Some(true), Some(true)));
    assert!(doc.get("history").is_none(), "the model gets the short form, not document.inspect");

    // new_layer: a layer above, active, named.
    let made = one_step(&mut app, "new_layer", json!({"name": "  Sky  "}));
    let sky = made["id"].as_u64().expect("the new layer's id");
    assert_eq!((made["name"].as_str(), active_layer(&app)), (Some("Sky"), sky));
    assert_eq!(layer_names(&app), ["Background", "Sky"]);

    // set_layer_props: opacity 0-100, a blend mode, `null` meaning "leave it".
    let r = one_step(&mut app, "set_layer_props", json!({"id": sky, "opacity": 250, "blend": "multiply", "visible": null, "name": null}));
    let r = r.as_str().unwrap();
    assert!(r.starts_with("Updated Sky: ") && r.contains("opacity") && r.contains("blend") && !r.contains("visible"), "{r}");
    let l = tool(&mut app, "get_document", json!({})).unwrap()["layers"][0].clone();
    assert_eq!((l["opacity"].as_f64(), l["blend"].as_str()), (Some(100.0), Some("Multiply")), "opacity is clamped to 100");
    for (args, error) in [
        (json!({"id": sky, "name": "  "}), "name is empty"),
        (json!({"id": sky, "opacity": null}), "Nothing to change"),
        (json!({"id": 999_999, "opacity": 5}), "No layer with id \"999999\" (call get_document for the ids)"),
        (json!({"id": sky, "opacity": "half"}), "opacity must be a number"),
    ] {
        assert_eq!(tool(&mut app, "set_layer_props", args).unwrap_err(), error);
    }
    assert!(tool(&mut app, "set_layer_props", json!({"id": sky, "blend": "sparkle"})).unwrap_err().contains("sparkle"));

    // set_active_layer: by id, by the id as text, by a name.
    assert_eq!(tool(&mut app, "set_active_layer", json!({"id": background.to_string()})).unwrap(), format!("Active layer: Background ({background})"));
    assert_eq!(active_layer(&app), background);
    assert_eq!(tool(&mut app, "set_active_layer", json!({"id": "Sky"})).unwrap(), format!("Active layer: Sky ({sky})"));
    assert_eq!(tool(&mut app, "set_active_layer", json!({"id": null})).unwrap_err(), "id must be a layer id (a number; call get_document for the ids)");
    assert_eq!(tool(&mut app, "paint_everything", json!({})).unwrap_err(), "Unknown tool \"paint_everything\"");
    assert!(app.ui.status.is_empty() && !app.ui.status_error, "a tool's failure is the model's to read, not the status bar's: {}", app.ui.status);
}

/// `fill_selection` fills the layer or the selection; the colour's alpha is the fill's opacity,
/// and a transparent colour clears.
#[test]
fn fill_selection_honours_alpha() {
    let mut app = app();
    tool(&mut app, "new_layer", json!({})).unwrap();
    assert_eq!(one_step(&mut app, "fill_selection", json!({"color": "#ff0000"})), "Filled the layer with #ff0000");
    assert_eq!(pixel(&app, 100, 80), [255, 0, 0, 255]);
    assert_eq!(one_step(&mut app, "fill_selection", json!({"color": "transparent"})), "Cleared the layer to transparent");
    assert_eq!(pixel(&app, 100, 80), [255, 255, 255, 255], "the white Background shows again");
    assert_eq!(one_step(&mut app, "fill_selection", json!({"color": "rgba(0, 0, 255, 0.5)"})), "Filled the layer with #0000ff at 50 % opacity");
    let half = pixel(&app, 100, 80);
    assert!((120..=135).contains(&half[0]) && half[2] == 255, "blue at half opacity over white: {half:?}");
    tool(&mut app, "select", json!({"kind": "rect", "rect": {"x": 0, "y": 0, "width": 20, "height": 20}})).unwrap();
    assert_eq!(one_step(&mut app, "fill_selection", json!({"color": "Lime"})), "Filled the selection with #00ff00");
    assert_eq!((pixel(&app, 5, 5), pixel(&app, 100, 80)), ([0, 255, 0, 255], half), "inside the selection only");
    assert_eq!(tool(&mut app, "fill_selection", json!({"color": "blurple"})).unwrap_err(), "Unknown colour \"blurple\"");
    // The Background's transparency is locked: clearing it is refused, as in JavaScript Pigment.
    let background = tool(&mut app, "get_document", json!({})).unwrap()["layers"][1]["id"].clone();
    tool(&mut app, "set_active_layer", json!({"id": background})).unwrap();
    assert_eq!(tool(&mut app, "fill_selection", json!({"color": "transparent"})).unwrap_err(), "Layer \"Background\" has its transparency locked");
}

/// `apply_adjustment` and `apply_filter`: the kind however it is spelt, params as an object or as
/// JSON text, numbers clamped to the command's own range (the engine refuses a radius of 99999).
#[test]
fn adjustments_and_filters_are_clamped_and_take_json_text() {
    let mut app = app();
    let before = pixel(&app, 10, 10);
    assert_eq!(one_step(&mut app, "apply_adjustment", json!({"kind": "invert"})), "Applied Invert to \"Background\"");
    assert_ne!(pixel(&app, 10, 10), before);
    assert_eq!(history(&app).last().map(String::as_str), Some("Invert"));
    let r = one_step(&mut app, "apply_adjustment", json!({"kind": "brightness-contrast", "params": {"brightness": "40", "contrast": 9999}}));
    assert_eq!(r, "Applied Brightness/Contrast to \"Background\"");
    assert!(app.session.execute("filter.blur.gaussianBlur", json!({"radius": 99999})).is_err(), "the engine refuses what the tool clamps");
    let r = one_step(&mut app, "apply_filter", json!({"kind": "gaussian-blur", "params": "{\"radius\": 99999}"}));
    assert_eq!(r, "Applied Gaussian Blur to \"Background\"");
    assert_eq!(history(&app).last().map(String::as_str), Some("Gaussian Blur"));
    assert_eq!(tool(&mut app, "apply_filter", json!({"kind": "sparkle"})).unwrap_err(), "Unknown filter \"sparkle\"");
    assert_eq!(tool(&mut app, "apply_adjustment", json!({"kind": "levels", "params": [1]})).unwrap_err(), "params must be an object");
    assert!(tool(&mut app, "apply_adjustment", json!({"kind": "levels", "params": "{gamma"})).unwrap_err().starts_with("params must be a JSON object such as"));
    // Adjustments want pixels: the model is told what to do about a type layer.
    tool(&mut app, "add_text", json!({"text": "Hello"})).unwrap();
    let e = tool(&mut app, "apply_adjustment", json!({"kind": "invert"})).unwrap_err();
    assert_eq!(e, "The active layer is a type layer; run_command layer.rasterize.layer first or activate a pixel layer");
}

/// `select`: a rectangle cut to the canvas, all, inverse, none. `add_text`: a type layer with
/// defaults from the canvas, `null` meaning "the default".
#[test]
fn select_and_add_text() {
    let mut app = app();
    let r = one_step(&mut app, "select", json!({"kind": "rect", "rect": {"x": -20, "y": 10, "width": 70, "height": 40}}));
    assert_eq!(r, json!({"selection": {"x": 0, "y": 10, "width": 50, "height": 40}}));
    assert_eq!(
        tool(&mut app, "select", json!({"kind": "rect", "rect": {"x": 500, "y": 0, "width": 5, "height": 5}})).unwrap_err(),
        "rect lies outside the canvas (200 × 160)"
    );
    assert_eq!(tool(&mut app, "select", json!({"kind": "none"})).unwrap(), "No selection");
    assert_eq!(tool(&mut app, "select", json!({"kind": "none"})).unwrap(), "No selection", "nothing to deselect is not an error");
    let all = json!({"selection": {"x": 0, "y": 0, "width": 200, "height": 160}});
    assert_eq!(tool(&mut app, "select", json!({"kind": "inverse"})).unwrap(), all, "the inverse of nothing is everything");
    assert_eq!(tool(&mut app, "select", json!({"kind": "all"})).unwrap(), all);
    assert_eq!(tool(&mut app, "select", json!({"kind": "lasso"})).unwrap_err(), "kind must be 'all', 'none', 'inverse' or 'rect'");
    tool(&mut app, "select", json!({"kind": "none"})).unwrap();

    let text = one_step(&mut app, "add_text", json!({"text": "Hello", "x": null, "size": null, "color": "tomato"}));
    let id = text["id"].as_u64().expect("the text layer's id");
    assert_eq!(active_layer(&app), id);
    let doc = tool(&mut app, "get_document", json!({})).unwrap();
    let l = doc["layers"].as_array().unwrap().iter().find(|l| l["id"] == json!(id)).expect("the text layer").clone();
    assert_eq!((l["type"].as_str(), l["text"].as_str()), (Some("type"), Some("Hello")));
    assert_eq!(tool(&mut app, "add_text", json!({"text": "   "})).unwrap_err(), "text is empty");
    assert_eq!(tool(&mut app, "add_text", json!({"text": "Hi", "size": "big"})).unwrap_err(), "size must be a number");
}

/// `canvas_size` extends a Background with the background colour, like the dialog; `crop` and
/// `resize_image` take pixels, cut or clamped to what a document can be.
#[test]
fn canvas_size_crop_and_resize() {
    let mut app = app();
    app.run("tools.setColors", json!({"background": "#00ff00"})).unwrap();
    let r = one_step(&mut app, "canvas_size", json!({"width": 300, "height": 200.4, "anchor": "nw"}));
    assert_eq!(r, "Canvas is now 300 × 200; the added area is filled with the background colour");
    assert_eq!(size(&app), (300, 200));
    assert_eq!((pixel(&app, 290, 190), pixel(&app, 10, 10)), ([0, 255, 0, 255], [255, 255, 255, 255]), "the image stays at the top left");
    assert_eq!(one_step(&mut app, "crop", json!({"rect": {"x": 250, "y": 150, "width": 500, "height": 500}})), "Cropped to 50 × 50");
    assert_eq!(size(&app), (50, 50));
    assert_eq!(tool(&mut app, "crop", json!({"rect": {"x": 0, "y": 0, "width": -5, "height": 5}})).unwrap_err(), "rect.width and rect.height must be positive");
    assert_eq!(tool(&mut app, "crop", json!({})).unwrap_err(), "rect must be { x, y, width, height }");
    assert_eq!(one_step(&mut app, "resize_image", json!({"width": "120", "height": 90})), "Image is now 120 × 90");
    assert_eq!(size(&app), (120, 90));
    assert_eq!(tool(&mut app, "resize_image", json!({"width": "wide", "height": 9})).unwrap_err(), "width must be a number");
}

/// Without a Background, a larger canvas is transparent.
#[test]
fn canvas_size_without_a_background_adds_transparency() {
    let mut app = PhotocraftApp::new(Session::new(), Default::default());
    app.run("file.new", json!({"width": 40, "height": 30, "background": "transparent"})).unwrap();
    let r = tool(&mut app, "canvas_size", json!({"width": 60, "height": 30, "anchor": "sideways"})).unwrap();
    assert_eq!(r, "Canvas is now 60 × 30; the added area is transparent");
    assert_eq!(pixel(&app, 2, 2)[3], 0);
}

/// `list_commands` finds commands by every word of the filter, says which can't run now, and
/// never offers a blocked one.
#[test]
fn list_commands_finds_commands_and_never_offers_a_blocked_one() {
    let mut app = app();
    let found = tool(&mut app, "list_commands", json!({"filter": "gaussian blur"})).unwrap();
    let row = found["commands"].as_array().unwrap().iter().find(|c| c["id"] == "filter.blur.gaussianBlur").expect("Gaussian Blur").clone();
    assert_eq!((row["name"].as_str(), row["params"].as_str()), (Some("Gaussian Blur"), Some("{\"radius\":0.1..1000=1}")));
    let ids = |v: &Value| -> Vec<String> { v["commands"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap().to_string()).collect() };
    for (filter, blocked) in [
        ("save", "file.save"),
        ("close", "file.close"),
        ("generate", "ai.generateImage"),
        ("preferences", "edit.preferences.general"),
        ("play", "actions.play"),
    ] {
        let listed = ids(&tool(&mut app, "list_commands", json!({"filter": filter})).unwrap());
        assert!(!listed.iter().any(|id| id == blocked || tools::blocked(id, &json!({})).is_err()), "{filter}: {listed:?}");
    }
    assert!(ids(&tool(&mut app, "list_commands", json!({"filter": "generative"})).unwrap()).contains(&"ai.generativeFill".to_string()));
    let unavailable = tool(&mut app, "list_commands", json!({"filter": "select.deselect"})).unwrap();
    assert!(unavailable["commands"][0]["unavailable"].is_string(), "why it can't run now: {unavailable}");
    let all = tool(&mut app, "list_commands", json!({"filter": " "})).unwrap();
    assert!(all["groups"]["layer"].as_u64().unwrap() > 100 && all["groups"].get("help").is_none(), "{all}");
    let many = tool(&mut app, "list_commands", json!({"filter": "layer"})).unwrap();
    assert_eq!(many["commands"].as_array().unwrap().len(), 30);
    assert!(many["more"].as_u64().unwrap() > 50);
}

/// `run_command` runs a command as the command palette would, with params given as an object or
/// as JSON text, and answers with the command's own result.
#[test]
fn run_command_runs_commands_and_reads_json_text() {
    let mut app = app();
    let before = pixel(&app, 5, 5);
    assert_eq!(tool(&mut app, "run_command", json!({"id": "image.adjustments.invert"})).unwrap(), "ok", "a command without a result");
    assert_ne!(pixel(&app, 5, 5), before);
    let blurred = tool(&mut app, "run_command", json!({"id": "filter.blur.gaussianBlur", "params": "{\"radius\": 3}"})).unwrap();
    assert_eq!(blurred["filter"]["radius"], 3.0, "the command's own result: {blurred}");
    assert_eq!(history(&app).last().map(String::as_str), Some("Gaussian Blur"));
    assert_eq!(tool(&mut app, "run_command", json!({"id": "edit.undo", "arg": null})).unwrap(), true);
    let made = tool(&mut app, "run_command", json!({"id": "layer.new.layer", "params": {"name": "From a command"}})).unwrap();
    assert!(made["layer"].is_u64(), "{made}");
    let info = tool(&mut app, "run_command", json!({"id": "file.fileInfo", "params": {"description": "A white card"}})).unwrap();
    assert_eq!(info["description"], "A white card");
    assert_eq!(tool(&mut app, "get_document", json!({})).unwrap()["description"], "A white card");
    // A view command of the shell's, not the engine's.
    assert!(tool(&mut app, "run_command", json!({"id": "view.fitOnScreen"})).is_ok());
}

/// `run_command` refuses what is not the Assistant's to run, unknown ids, commands that can't run
/// now and params it can't read; the document stays as it was.
#[test]
fn run_command_refuses_what_the_assistant_may_not_run() {
    let mut app = app();
    let layers = layer_names(&app);
    for id in [
        "file.close",
        "file.exit",
        "file.saveAs",
        "edit.preferences.general",
        "help.about",
        "window.panel.layers",
        "actions.play",
        "jobs.cancel",
        "tools.select.move",
    ] {
        assert_eq!(tool(&mut app, "run_command", json!({"id": id})).unwrap_err(), format!("Command \"{id}\" cannot be run by the assistant"));
    }
    assert_eq!(app.session.documents().len(), 1, "the document is still open");
    for (args, error) in [
        (json!({"id": "edit.sparkle"}), "Unknown command \"edit.sparkle\" (find one with list_commands)"),
        (json!({}), "id must be a command id (see list_commands)"),
        (json!({"id": "edit.undo", "params": 7}), "params must be a JSON object such as {\"radius\": 4}"),
    ] {
        assert_eq!(tool(&mut app, "run_command", args).unwrap_err(), error);
    }
    assert!(tool(&mut app, "run_command", json!({"id": "select.deselect"})).unwrap_err().starts_with("Command \"select.deselect\" is not available right now"));
    assert!(tool(&mut app, "run_command", json!({"id": "edit.undo", "params": "{\"a\":"})).unwrap_err().contains("looks like JSON but could not be read"));
    let e = tool(&mut app, "run_command", json!({"id": "filter.blur.gaussianBlur", "params": {"radius": "wide"}})).unwrap_err();
    assert!(e.contains("radius"), "the engine's own check of the params: {e}");
    let e = tool(&mut app, "run_command", json!({"id": "image.adjustments.colorLookup", "params": {"file": "/etc/hostname"}})).unwrap_err();
    assert!(e.contains("open document only"), "{e}");
    assert_eq!(layer_names(&app), layers);
    assert_eq!(history(&app).len(), 1, "nothing ran");
}

/// Among the `ai.*` commands the Assistant runs Generative Fill only, by its own tool or through
/// `run_command` (no window opens for it); every other one is refused before anything is sent.
#[test]
fn among_the_ai_commands_only_generative_fill_runs() {
    let rec = Recorder::connected();
    let mut app = app();
    rec.install(&mut app);
    for id in photocraft_engine::ai_cmds::COMMANDS.iter().filter(|id| **id != "ai.generativeFill").chain(&["ai.accounts", "ai.removeBackgroundWithProvider"]) {
        let e = tool(&mut app, "run_command", json!({"id": id, "params": {"prompt": "a castle"}})).unwrap_err();
        assert_eq!(e, format!("Command \"{id}\" cannot be run by the assistant"));
    }
    assert!(rec.mock.calls().is_empty(), "nothing was sent: {:?}", rec.mock.calls());
    assert_eq!(tool(&mut app, "generative_fill", json!({"prompt": "a fox"})).unwrap_err(), "Generative fill needs a selection: call select first");
    tool(&mut app, "select", json!({"kind": "rect", "rect": {"x": 20, "y": 20, "width": 60, "height": 50}})).unwrap();
    assert_eq!(tool(&mut app, "generative_fill", json!({"prompt": "  "})).unwrap_err(), "prompt is empty");
    let filled = one_step(&mut app, "generative_fill", json!({"prompt": "a fox"}));
    assert_eq!(filled["layers"].as_array().map(Vec::len), Some(1));
    let filled = tool(&mut app, "run_command", json!({"id": "ai.generativeFill", "params": {"prompt": "a second fox"}})).unwrap();
    assert_eq!(filled["layers"].as_array().map(Vec::len), Some(1));
    assert!(!app.ai.generate.open, "the command runs; the Generate window stays shut");
    let calls = rec.mock.calls();
    assert_eq!(calls.iter().map(|c| (c.op, c.prompt.as_str())).collect::<Vec<_>>(), [("edit", "a fox"), ("edit", "a second fox")]);
    assert_eq!(layer_names(&app).iter().filter(|n| n.starts_with("Generative Fill")).count(), 2);
    // Without a provider the model is told why, and the document is left alone.
    let nobody = Recorder::new(MockBackend::disconnected());
    nobody.install(&mut app);
    let e = tool(&mut app, "generative_fill", json!({"prompt": "a fox"})).unwrap_err();
    assert!(e.contains("AI Accounts"), "{e}");
    assert!(nobody.mock.calls().is_empty());
}

/// Save what the window looks like, when `PIGMENT_AI_EVIDENCE_DIR` names a folder for it.
fn evidence(h: &mut Harness, name: &str) {
    if let Some(dir) = std::env::var_os("PIGMENT_AI_EVIDENCE_DIR") {
        std::fs::create_dir_all(&dir).unwrap();
        h.render().expect("offscreen UI render").save(std::path::Path::new(&dir).join(format!("{name}.png"))).unwrap();
    }
}

/// Draw frames until the turn has ended and no job runs.
fn until_done(h: &mut Harness) {
    for _ in 0..2000 {
        h.run_steps(1);
        if !assistant::running(h.state()) && !h.state().session.has_jobs() {
            h.run_steps(2);
            return;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    panic!("the turn never ended");
}

/// Draw frames until `ready`.
fn until(h: &mut Harness, what: &str, ready: impl Fn(&PhotocraftApp) -> bool) {
    for _ in 0..2000 {
        h.run_steps(1);
        if ready(h.state()) {
            return;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    panic!("never: {what}");
}

fn send(h: &mut Harness, text: &str) {
    assert_eq!(assistant::send(h.state_mut(), text), Ok(true), "{text}");
    until_done(h);
}

fn user(m: &ChatMessage) -> (&str, &[Rgba8Image]) {
    match m {
        ChatMessage::User { text, images } => (text, images),
        other => panic!("not a user message: {other:?}"),
    }
}

fn results(m: &ChatMessage) -> Vec<(String, Value)> {
    match m {
        ChatMessage::ToolResults(r) => r.iter().map(|r| (r.call_id.clone(), r.output.clone())).collect(),
        other => panic!("not tool results: {other:?}"),
    }
}

/// A turn: the conversation goes out with the image and the tools, the model's tool call runs as
/// one undo step, its result goes back with the model's own turn, and the final text is shown.
#[test]
fn a_turn_sends_the_image_runs_the_tools_and_shows_the_answer() {
    let rec = Recorder::connected();
    let r = Arc::clone(&rec);
    let mut h = harness(move |app| {
        r.install(app);
        // A document larger than the attached image may be: 2048 × 512.
        app.run("file.new", json!({"width": 2048, "height": 512, "background": "white"})).unwrap();
    });
    let ctx = h.ctx.clone();
    menus::invoke(h.state_mut(), &ctx, "window.panel.aiAssistant", json!({})).unwrap();
    h.run_steps(3);
    assert!(assistant::is_open(h.state()));
    assert!(h.query_by_label_contains("Ask about the image or describe an edit").is_some(), "the empty conversation says what to do");
    assert!(rec.requests().is_empty(), "opening sends nothing");
    evidence(&mut h, "assistant-empty");

    rec.answer("", &[("apply_adjustment", json!({"kind": "invert"}))]);
    rec.answer("Inverted the image.", &[]);
    let steps = history(h.state()).len();
    type_into(&mut h, "Message", "invert it");
    assert!(rec.requests().is_empty(), "typing sends nothing");
    h.key_press(egui::Key::Enter);
    h.run_steps(2);
    assert!(h.state().ai.assistant.input.is_empty(), "Enter sent the message");
    until_done(&mut h);

    let sent = rec.requests();
    assert_eq!(sent.len(), 2, "the request, and the one with the tool's result");
    assert!(sent[0].instructions.starts_with("You are the assistant inside Pigment"));
    assert_eq!(sent[0].tools.len(), 15);
    assert_eq!(sent[0].messages.len(), 1);
    let (text, images) = user(&sent[0].messages[0]);
    assert_eq!(text, "invert it");
    assert_eq!(images.iter().map(|i| (i.width, i.height)).collect::<Vec<_>>(), [(1024, 256)], "the composite, at most 1024 px a side");
    // The second request: the same message, the model's turn as it came, the tool's result.
    assert_eq!(sent[1].messages.len(), 3);
    let ChatMessage::Turn(turn) = &sent[1].messages[1] else { panic!("the model's turn goes back: {:?}", sent[1].messages[1]) };
    assert_eq!(turn.provider_state, json!({"kept": ""}), "with what the provider needs to see again");
    assert_eq!(results(&sent[1].messages[2]), [("call_0".to_string(), json!("Applied Invert to \"Background\""))]);

    // One undo step, and the conversation shows the step and the answer.
    let after = history(h.state());
    assert_eq!((after.len(), after.last().map(String::as_str)), (steps + 1, Some("Invert")));
    let convo = assistant::messages(h.state());
    assert_eq!(convo.len(), 2);
    assert_eq!((convo[0].role, convo[0].text.as_str(), convo[0].image.is_some()), (assistant::Role::User, "invert it", true));
    assert_eq!((convo[1].text.as_str(), convo[1].calls.len(), convo[1].pending), ("Inverted the image.", 1, false));
    assert!(!convo[1].calls[0].failed());
    for label in ["invert it", "Inverted the image.", "Applied Invert"] {
        assert!(h.query_by_label(label).is_some(), "{label} is shown");
    }
    assert_eq!(pixel(h.state(), 3, 3), [0, 0, 0, 255], "white, inverted");
    h.state_mut().run("edit.undo", json!({})).unwrap();
    assert_eq!(pixel(h.state(), 3, 3), [255, 255, 255, 255], "one Undo takes the edit back");
}

/// Later messages: the conversation goes out as text, with the latest message's image only.
/// Attach image off sends no image. Shift+Enter is a new line, not Send.
#[test]
fn later_messages_send_only_the_latest_image() {
    let rec = Recorder::connected();
    let r = Arc::clone(&rec);
    let mut h = harness(move |app| {
        r.install(app);
        assistant::open(app);
    });
    rec.answer("It is white.", &[]);
    send(&mut h, "what colour is it?");
    rec.answer("Still white.", &[]);
    send(&mut h, "and now?");
    let second = rec.requests().pop().unwrap();
    assert_eq!(second.messages.len(), 3, "user, assistant, user: {:?}", second.messages);
    assert!(user(&second.messages[0]).1.is_empty(), "the first message's image stays home");
    assert!(matches!(&second.messages[1], ChatMessage::Assistant { text } if text == "It is white."));
    assert_eq!(user(&second.messages[2]).1.iter().map(|i| (i.width, i.height)).collect::<Vec<_>>(), [(200, 160)], "a small image is not enlarged");

    h.get_by_label("Attach image").click();
    h.run_steps(2);
    assert!(!h.state().ai.assistant.attach);
    rec.answer("", &[]);
    type_into(&mut h, "Message", "two");
    h.key_press_modifiers(egui::Modifiers::SHIFT, egui::Key::Enter);
    h.run_steps(2);
    assert_eq!(h.state().ai.assistant.input, "two\n");
    assert_eq!(rec.requests().len(), 2, "nothing sent");
    h.get_by_label("Send").click();
    until_done(&mut h);
    let third = rec.requests().pop().unwrap();
    assert_eq!(user(third.messages.last().unwrap()), ("two", &[][..]), "trimmed, and without an image");
    assert!(third.messages.iter().all(|m| !matches!(m, ChatMessage::User { images, .. } if !images.is_empty())), "no image at all");
    assert_eq!(assistant::messages(h.state()).last().unwrap().text, "(no answer)", "a model that says nothing");
}

/// The model wanted more than twelve tool rounds: the turn ends and says so, instead of a silent
/// "Done."; a model that only called tools gets "Done.".
#[test]
fn the_tool_round_limit_is_reported() {
    let rec = Recorder::connected();
    let r = Arc::clone(&rec);
    let mut h = harness(move |app| r.install(app));
    for _ in 0..12 {
        rec.answer("", &[("new_layer", json!({}))]);
    }
    rec.answer("Almost there", &[("new_layer", json!({}))]);
    send(&mut h, "add layers forever");
    assert_eq!(rec.requests().len(), 13, "twelve rounds of tools, and the answer that wanted a thirteenth");
    assert_eq!(layer_names(h.state()).len(), 13, "the thirteenth round's tool never ran");
    let m = assistant::messages(h.state()).last().unwrap();
    assert_eq!(m.text, "Almost there\n\nStopped after 12 tool steps; say “continue” to go on.");
    assert!(m.truncated && !m.error && m.calls.len() == 12);

    rec.answer("", &[("select", json!({"kind": "all"}))]);
    rec.answer("", &[]);
    send(&mut h, "select everything");
    assert_eq!(assistant::messages(h.state()).last().unwrap().text, "Done.");
}

/// Stop while a request is in flight ends the turn at once: its answer is dropped and its tools
/// never run. Stop between steps: no further tool, no further request.
#[test]
fn stop_ends_the_turn_and_nothing_runs_after_it() {
    let rec = Recorder::connected();
    let r = Arc::clone(&rec);
    let mut h = harness(move |app| {
        r.install(app);
        assistant::open(app);
    });
    // In flight: the provider never answers.
    rec.mock.set_delay(Duration::from_secs(60));
    assert_eq!(assistant::send(h.state_mut(), "add a layer"), Ok(true));
    h.run_steps(3);
    assert!(assistant::running(h.state()));
    assert_eq!(assistant::send(h.state_mut(), "and another"), Err("The assistant is still working.".to_string()), "one turn at a time");
    assert!(h.query_by_label("Working…").is_some() && h.query_by_label("Thinking…").is_some());
    assert!(h.query_by_label("Esc to cancel").is_none(), "no modal: the request is a background job");
    evidence(&mut h, "assistant-working");
    h.get_by_label("Stop").click();
    h.run_steps(2);
    assert!(!assistant::running(h.state()), "at once, not when the provider answers");
    until_done(&mut h);
    let m = assistant::messages(h.state()).last().unwrap();
    assert_eq!((m.text.as_str(), m.stopped, m.calls.len()), ("Stopped.", true, 0));
    assert_eq!((rec.requests().len(), layer_names(h.state()).len()), (1, 1), "nothing ran");
    assert!(!h.state().ui.status_error, "a dropped request is not a failure: {}", h.state().ui.status);

    // Between steps: three calls came; Stop after the first.
    rec.mock.set_delay(Duration::ZERO);
    assistant::clear(h.state_mut());
    assert!(assistant::messages(h.state()).is_empty());
    rec.answer("", &[("new_layer", json!({"name": "One"})), ("new_layer", json!({"name": "Two"})), ("new_layer", json!({"name": "Three"}))]);
    rec.answer("never asked for", &[]);
    assert_eq!(assistant::send(h.state_mut(), "three layers"), Ok(true));
    until(&mut h, "the first step", |app| assistant::messages(app).last().is_some_and(|m| !m.calls.is_empty()));
    let ran = assistant::messages(h.state()).last().unwrap().calls.len();
    assert!(assistant::stop(h.state_mut()));
    until_done(&mut h);
    h.run_steps(5);
    let m = assistant::messages(h.state()).last().unwrap();
    assert!(m.stopped && m.calls.len() == ran && ran < 3, "{ran} of 3 steps ran");
    assert_eq!(layer_names(h.state()).len(), 1 + ran);
    assert_eq!(rec.requests().len(), 2, "no request after Stop");
}

/// A conversation per document: each document's messages are its own, a tool refuses once its
/// document is no longer the active one, and closing the document drops its conversation.
#[test]
fn conversations_belong_to_their_document() {
    let rec = Recorder::connected();
    let r = Arc::clone(&rec);
    let mut h = harness(move |app| r.install(app));
    let a = h.state().session.active().unwrap().doc.id;
    rec.answer("About A.", &[]);
    send(&mut h, "first");
    h.state_mut().run("file.new", json!({"width": 64, "height": 48})).unwrap();
    let b = h.state().session.active().unwrap().doc.id;
    assert!(assistant::messages(h.state()).is_empty(), "a new document starts an empty conversation");
    rec.answer("About B.", &[]);
    send(&mut h, "second");
    let sent = rec.requests().pop().unwrap();
    assert_eq!(sent.messages.len(), 1, "B's request carries nothing of A's");
    assert_eq!(user(&sent.messages[0]).0, "second");
    assert_eq!(assistant::conversation(h.state(), a).iter().map(|m| m.text.as_str()).collect::<Vec<_>>(), ["first", "About A."]);
    assert_eq!(assistant::conversation(h.state(), b).iter().map(|m| m.text.as_str()).collect::<Vec<_>>(), ["second", "About B."]);

    // The model answers for B after the person went back to A: its tool does not touch A.
    rec.mock.set_delay(Duration::from_millis(150));
    rec.answer("", &[("new_layer", json!({"name": "Stray"}))]);
    rec.answer("Could not.", &[]);
    assert_eq!(assistant::send(h.state_mut(), "add a layer"), Ok(true));
    h.state_mut().run("document.activate", json!({"document": 0})).unwrap();
    assert_eq!(h.state().session.active().unwrap().doc.id, a);
    until_done(&mut h);
    rec.mock.set_delay(Duration::ZERO);
    let told = results(&rec.requests().pop().unwrap().messages[4]);
    assert_eq!(told, [("call_0".to_string(), json!({"error": "The document is no longer active"}))]);
    assert_eq!(layer_names(h.state()), ["Background"], "A is untouched");
    let last = assistant::conversation(h.state(), b).last().unwrap();
    assert!(last.calls[0].failed() && last.text == "Could not.");
    assert!(tools::describe_call(&last.calls[0].name, &last.calls[0].args, true).starts_with("Failed: New layer"));

    // Clear empties the active document's conversation only; closing B drops B's.
    assistant::clear(h.state_mut());
    assert!(assistant::conversation(h.state(), a).is_empty());
    assert_eq!(assistant::conversation(h.state(), b).len(), 4);
    h.state_mut().run("document.activate", json!({"document": 1})).unwrap();
    h.state_mut().run("file.close", json!({})).unwrap();
    h.run_steps(3);
    assert!(assistant::conversation(h.state(), b).is_empty(), "closed with its document");
}

/// At most forty messages are kept per document, the oldest dropped first.
#[test]
fn a_conversation_keeps_forty_messages() {
    let rec = Recorder::connected();
    let r = Arc::clone(&rec);
    let mut h = harness(move |app| {
        r.install(app);
        assistant::set_attach(app, false);
    });
    for i in 0..22 {
        rec.answer(&format!("answer {i}"), &[]);
        send(&mut h, &format!("message {i}"));
    }
    let convo = assistant::messages(h.state());
    assert_eq!(convo.len(), 40);
    assert_eq!((convo[0].text.as_str(), convo[39].text.as_str()), ("message 2", "answer 21"));
    assert!(rec.requests().last().unwrap().messages.len() <= 40);
}

/// The model's refusals: a blocked command and a provider command other than Generative Fill are
/// refused, the model is told so in the tool results, and nothing but chat is ever sent.
#[test]
fn the_model_sees_refusals_and_only_generative_fill_reaches_a_provider() {
    let rec = Recorder::connected();
    let r = Arc::clone(&rec);
    let mut h = harness(move |app| {
        r.install(app);
        assistant::open(app);
    });
    rec.answer(
        "",
        &[
            ("run_command", json!({"id": "file.close", "params": {"save": false}})),
            ("run_command", json!({"id": "ai.generateImage", "params": "{\"prompt\": \"a castle\"}"})),
            ("run_command", json!({"id": "ai.replaceSky", "params": {"prompt": "storm"}})),
            ("apply_filter", json!({"kind": "gaussianBlur", "params": "{\"radius\": 2.5}"})),
            ("select", json!("{\"kind\": \"rect\", \"rect\": {\"x\": 10, \"y\": 10, \"width\": 40, \"height\": 30}}")),
            ("generative_fill", json!({"prompt": "a fox"})),
        ],
    );
    // The mock answers in the order asked: the chat, Generative Fill's image, the chat again.
    rec.mock.push(MockAnswer::Solid([0, 0, 255, 255]));
    rec.answer("Blurred and filled; the rest is not mine to run.", &[]);
    send(&mut h, "close this, make a castle, a stormy sky, blur it, then a fox");
    let told = results(&rec.requests().pop().unwrap().messages[2]);
    assert_eq!(told[0].1, json!({"error": "Command \"file.close\" cannot be run by the assistant"}));
    assert_eq!(told[1].1, json!({"error": "Command \"ai.generateImage\" cannot be run by the assistant"}));
    assert_eq!(told[2].1, json!({"error": "Command \"ai.replaceSky\" cannot be run by the assistant"}));
    assert_eq!(told[3].1, json!("Applied Gaussian Blur to \"Background\""), "params as JSON text");
    assert_eq!(told[4].1, json!({"selection": {"x": 10, "y": 10, "width": 40, "height": 30}}), "arguments as JSON text");
    assert_eq!(told[5].1["layers"].as_array().map(Vec::len), Some(1), "{:?}", told[5]);
    assert_eq!(h.state().session.documents().len(), 1, "the document was not closed");
    let ops: Vec<&str> = rec.mock.calls().iter().map(|c| c.op).collect();
    assert_eq!(ops, ["chat", "edit", "chat"], "the only provider request beside the chat is Generative Fill's");
    let m = assistant::messages(h.state()).last().unwrap();
    assert_eq!(m.calls.iter().map(assistant::Call::failed).collect::<Vec<_>>(), [true, true, true, false, false, false]);
    assert!(h.query_by_label("Failed: Ran file.close").is_some() && h.query_by_label("Generative fill").is_some());
    evidence(&mut h, "assistant-turn");
}

/// A command that opens a dialog: the turn waits for the person to finish it instead of running
/// on behind it, and the model learns that a dialog was shown.
#[test]
fn a_command_that_opens_a_dialog_waits_for_the_person() {
    let rec = Recorder::connected();
    let r = Arc::clone(&rec);
    let mut h = harness(move |app| {
        r.install(app);
        assistant::open(app);
    });
    rec.answer("", &[("run_command", json!({"id": "filter.blur.gaussianBlur"})), ("new_layer", json!({"name": "After"}))]);
    rec.answer("Done after your dialog.", &[]);
    assert_eq!(assistant::send(h.state_mut(), "blur it, I will pick the radius"), Ok(true));
    until(&mut h, "the dialog", |app| !app.ui.dialogs.is_empty());
    h.run_steps(5);
    assert!(assistant::running(h.state()));
    let m = assistant::messages(h.state()).last().unwrap();
    assert_eq!((m.calls.len(), m.calls[0].waiting, m.calls[0].result.is_none()), (1, true, true), "the next tool waits too");
    assert_eq!(rec.requests().len(), 1);
    assert!(h.query_by_label_contains("waiting for you to finish the dialog").is_some());
    // Stop while the dialog is up: the turn ends once the dialog is done with.
    assistant::stop(h.state_mut());
    h.run_steps(2);
    assert!(assistant::running(h.state()) && assistant::stopping(h.state()));
    assert!(h.query_by_label("Stopping after the current step…").is_some());
    h.state_mut().ui.dialogs.clear();
    until_done(&mut h);
    let m = assistant::messages(h.state()).last().unwrap();
    assert_eq!(m.calls[0].result, Some(json!(tools::DIALOG_CLOSED)));
    assert_eq!((m.calls.len(), m.stopped, rec.requests().len()), (1, true, 1), "stopped: no further tool, no further request");
    assert_eq!(layer_names(h.state()), ["Background"]);
}

/// Who may send. An agent (synthetic input, a control request) sends nothing while "Allow agents
/// to run AI commands" is off; nothing connected opens AI Accounts and keeps what was typed; a
/// failed request shows why, with AI Accounts when that fixes it.
#[test]
fn agents_need_permission_and_a_missing_account_keeps_the_message() {
    let rec = Recorder::connected();
    let r = Arc::clone(&rec);
    let mut h = harness(move |app| {
        ai_ui::install_accounts(app, AiAccounts::in_memory());
        r.install(app);
        assistant::open(app);
    });
    // The agent types and clicks Send.
    type_into(&mut h, "Message", "make it pop");
    synthetic_click(&mut h, "Send");
    h.run_steps(3);
    assert!(rec.requests().is_empty() && assistant::messages(h.state()).is_empty(), "nothing sent");
    assert_eq!(h.state().ai.assistant.note.as_deref(), Some(ai_ui::AGENTS_REFUSED));
    assert_eq!(h.state().ai.assistant.input, "make it pop");
    let refused = ai_ui::as_agent(h.state_mut(), |app| assistant::send(app, "as a control request"));
    assert_eq!(refused, Err(ai_ui::AGENTS_REFUSED.to_string()));
    // With the permission, the agent's message goes; the person's always does.
    ai_ui::with_accounts(h.state(), |a| a.set_allow_agents(true)).unwrap().unwrap();
    rec.answer("For the agent.", &[]);
    assert_eq!(ai_ui::as_agent(h.state_mut(), |app| assistant::send(app, "as a control request")), Ok(true));
    until_done(&mut h);
    ai_ui::with_accounts(h.state(), |a| a.set_allow_agents(false)).unwrap().unwrap();
    rec.answer("For you.", &[]);
    h.get_by_label("Send").click();
    until_done(&mut h);
    assert_eq!(rec.requests().len(), 2);
    assert!(h.state().ai.assistant.input.is_empty() && h.state().ai.assistant.note.is_none());

    // A request that fails: the reason, and AI Accounts when that is the fix. The failure is not
    // sent again with the next message.
    rec.mock.push(MockAnswer::Error { kind: "invalidKey", message: "OpenAI did not accept the API key. Check it in Edit › AI Accounts…".into() });
    send(&mut h, "again");
    let m = assistant::messages(h.state()).last().unwrap();
    assert!(m.error && m.needs_accounts && m.text.starts_with("OpenAI did not accept the API key"), "{}", m.text);
    rec.answer("Fine now.", &[]);
    send(&mut h, "and again");
    let sent = rec.requests().pop().unwrap();
    assert!(!sent.messages.iter().any(|m| matches!(m, ChatMessage::Assistant { text } if text.contains("did not accept"))));
    h.get_by_label("Open AI Accounts…").click();
    h.run_steps(3);
    assert!(accounts::is_open(h.state()));
    accounts::close(h.state_mut());

    // Nothing connected: AI Accounts opens, nothing is sent, and the typed text stays.
    let nobody = Recorder::new(MockBackend::disconnected());
    nobody.install(h.state_mut());
    h.run_steps(2);
    assert!(h.query_by_label("Not connected").is_some());
    type_into(&mut h, "Message", "is anyone there?");
    h.get_by_label("Send").click();
    h.run_steps(3);
    assert!(accounts::is_open(h.state()), "AI Accounts instead of a failure");
    assert_eq!(h.state().ai.assistant.input, "is anyone there?", "the message survives");
    assert!(nobody.requests().is_empty());
    // No agreement yet: the same.
    accounts::close(h.state_mut());
    let unagreed = MockBackend::connected();
    unagreed.set_consented(false);
    let unagreed = Recorder::new(unagreed);
    unagreed.install(h.state_mut());
    assert_eq!(assistant::send(h.state_mut(), "hello"), Ok(false));
    assert!(accounts::is_open(h.state()) && unagreed.requests().is_empty());
}

/// Window › Assistant: where it is, its check mark, and the choices it saves (the provider, the
/// chat model, Attach image) and lists (the provider's chat models, on request).
#[test]
fn the_window_item_and_the_saved_choices() {
    let mut app = app();
    let items = menus::menu_items(&app);
    let at = |id: &str| items.iter().position(|i| i.id == id).unwrap_or_else(|| panic!("{id} is not in the menus"));
    let item = &items[at("window.panel.aiAssistant")];
    assert_eq!((item.label.as_str(), item.path.join(" › "), item.checked), ("Assistant", "Window".to_string(), Some(false)));
    assert_eq!(at("window.panel.aiAssistant"), at("window.panel.adjustments") + 1, "after Adjustments, in Photoshop's alphabetical list");
    assert!(menus::is_live("window.panel.aiAssistant") && menus::is_enabled(&app, "window.panel.aiAssistant"));
    let ctx = egui::Context::default();
    assert_eq!(menus::invoke(&mut app, &ctx, "window.panel.aiAssistant", json!({})).unwrap(), json!({"visible": true}));
    assert_eq!(menus::menu_items(&app)[at("window.panel.aiAssistant")].checked, Some(true));
    assert_eq!(menus::invoke(&mut app, &ctx, "window.panel.aiAssistant", json!({"show": false})).unwrap(), json!({"visible": false}));
    assert!(!assistant::is_open(&app));
    assert_eq!(assistant::send(&mut app, "hello"), Err("Generative AI is available in the desktop app.".to_string()), "no backend");

    ai_ui::install_accounts(&mut app, AiAccounts::in_memory());
    let mock = Arc::new(MockBackend::connected());
    with_mock(&mut app, &mock);
    assistant::open(&mut app);
    assert!(app.ai.assistant.attach, "Attach image is on until it is turned off");
    assert_eq!(assistant::provider(&app), Some(ProviderId::OpenAi), "the preferred provider");
    assistant::set_provider(&mut app, ProviderId::Gemini);
    assistant::set_model(&mut app, ProviderId::Gemini, " gemini-2.5-pro ");
    assistant::set_attach(&mut app, false);
    let saved = ai_ui::with_accounts(&app, |a| (a.settings.chat_provider, a.settings.gemini.chat_model.clone(), a.settings.assistant_attach)).unwrap();
    assert_eq!(saved, (Some(ProviderId::Gemini), Some("gemini-2.5-pro".to_string()), false));
    assert_eq!((assistant::provider(&app), assistant::model(&app, ProviderId::Gemini).as_deref()), (Some(ProviderId::Gemini), Some("gemini-2.5-pro")));
    assistant::set_model(&mut app, ProviderId::Gemini, "");
    assert_eq!(assistant::model(&app, ProviderId::Gemini), None, "empty is automatic");
    assistant::set_model(&mut app, ProviderId::Gemini, "not a model id!");
    assert!(app.ai.assistant.note.is_some() && assistant::model(&app, ProviderId::Gemini).is_none(), "a bad id is refused, not saved");

    // The saved choice is one with AI Accounts': its Preferred provider resets the chat provider,
    // and a chat model set there is the Assistant's.
    ai_ui::with_accounts(&app, |a| {
        a.set_default_provider(ProviderId::OpenAi).unwrap();
        a.set_models(ProviderId::OpenAi, Some("gpt-4.1"), None).unwrap();
        a.set_default_provider(ProviderId::Gemini).unwrap();
    });
    assert_eq!(assistant::model(&app, ProviderId::OpenAi).as_deref(), Some("gpt-4.1"));
    assert_eq!(assistant::provider(&app), Some(ProviderId::Gemini));
    app.ai.assistant.note = None;

    // The model list is asked for, not fetched behind the person's back.
    assert!(mock.calls().is_empty() && assistant::listed_models(&app, ProviderId::Gemini).is_none());
    mock.push(MockAnswer::Models(vec![("gemini-2.5-pro".into(), "text"), ("gemini-2.5-flash-image".into(), "image"), ("gemini-2.5-flash".into(), "text")]));
    assistant::list_models(&mut app).unwrap();
    assert_eq!(
        assistant::listed_models(&app, ProviderId::Gemini),
        Some(&["gemini-2.5-pro".to_string(), "gemini-2.5-flash".to_string()][..]),
        "chat models only"
    );
    assert_eq!(mock.calls().iter().map(|c| (c.op, c.provider)).collect::<Vec<_>>(), [("models", Some(ProviderId::Gemini))]);

    // The request names the provider and the model chosen here.
    assistant::set_model(&mut app, ProviderId::Gemini, "gemini-2.5-flash");
    assistant::send(&mut app, "hello").unwrap();
    for _ in 0..2000 {
        app.session.poll_jobs();
        if mock.calls().len() == 2 {
            break;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    let call = mock.calls().pop().unwrap();
    assert_eq!((call.op, call.provider, call.model.as_deref(), call.tools), ("chat", Some(ProviderId::Gemini), Some("gemini-2.5-flash"), 15));
}
