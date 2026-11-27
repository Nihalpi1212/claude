//! Pigment: Export/Import Presets for every kind (P1b).

use std::sync::{Arc, Mutex};

use craft::host::{PickKind, Picked, ScriptedFiles};
use serde_json::{Value, json};

use super::*;

/// The files the app wrote: (path, bytes).
type Written = Arc<Mutex<Vec<(String, Vec<u8>)>>>;

fn app_with(files: Vec<Picked>) -> (Box<PhotocraftApp>, Written, Arc<ScriptedFiles>) {
    let written = Arc::new(Mutex::new(Vec::new()));
    let sink = written.clone();
    let scripted = Arc::new(ScriptedFiles::answering(files));
    let services = crate::Services {
        files: Some(scripted.clone()),
        write: Some(Box::new(move |path, data| {
            sink.lock().unwrap().push((path.to_string(), data.to_vec()));
            Ok(())
        })),
        ..Default::default()
    };
    (PhotocraftApp::new(photocraft_engine::Session::new(), services), written, scripted)
}

fn control(app: &mut PhotocraftApp, method: &str, params: Value) {
    let ctx = app.ctx().clone();
    let (request, _reply) = crate::control::ControlRequest::new(method, params);
    match crate::control::handle(app, &ctx, &request) {
        crate::control::Reply::Done(reply) => assert_eq!(reply["ok"], true, "{method}: {reply}"),
        _ => panic!("{method} answers at once"),
    }
}

/// Opens Export/Import Presets from its menu item, sets `fields` and presses OK.
fn run_dialog(app: &mut PhotocraftApp, fields: &[(&str, Value)]) {
    let ctx = app.ctx().clone();
    let id = crate::menus::invoke(app, &ctx, IO, json!({})).unwrap()["dialog"].clone();
    crate::dialogs::testing::show(app);
    for (field, value) in fields {
        control(app, "ui.dialog.set", json!({"dialog": id, "field": field, "value": value}));
    }
    control(app, "ui.dialog.confirm", json!({"dialog": id}));
    app.poll_file_dialog();
}

#[test]
fn the_dialog_offers_the_nine_kinds() {
    let names: Vec<String> = io_params().iter().map(|p| p.key.to_string()).collect();
    assert_eq!(names, ["action", "brushes", "swatches", "gradients", "styles", "patterns", "contours", "customShapes", "tools", "adjustments"]);
}

#[test]
fn export_writes_every_kind_and_import_of_it_restores_a_deleted_gradient() {
    let (mut a, written, _) = app_with(vec![Picked::Paths(vec!["/tmp/Presets.pcpresets".into()])]);
    a.run("gradient.presets.new", json!({"name": "Keep", "group": "Mine"})).unwrap();
    a.run("adjustment.presets.save", json!({"kind": "curves", "name": "My Curve", "params": {"points": [[0, 0], [128, 160], [255, 255]]}})).unwrap();
    run_dialog(&mut a, &[]);
    assert!(!a.ui.status_error, "{}", a.ui.status);
    let files = written.lock().unwrap().clone();
    let [(path, bytes)] = files.as_slice() else { panic!("one file written, got {}", files.len()) };
    assert_eq!(path, "/tmp/Presets.pcpresets");
    let file: Value = serde_json::from_slice(bytes).unwrap();
    assert_eq!(file["gradients"][0]["items"][0]["name"], "Keep");
    assert_eq!(file["adjustments"][0]["name"], "My Curve");

    // Another library that had the gradient and lost it: Import of the file brings it back,
    // and the open dialog read only preset files.
    let (mut b, _, scripted) = app_with(vec![Picked::Contents(vec![("Presets.pcpresets".into(), bytes.clone())])]);
    b.run("gradient.presets.new", json!({"name": "Keep", "group": "Mine"})).unwrap();
    b.run("gradient.presets.edit", json!({"action": "delete", "preset": "Keep"})).unwrap();
    run_dialog(&mut b, &[("action", json!("import"))]);
    assert!(!b.ui.status_error, "{}", b.ui.status);
    let mine = b.session.presets.gradients.iter().find(|g| g.name == "Mine").expect("the group is back");
    assert_eq!(mine.items.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), ["Keep"]);
    assert!(b.session.presets.adjustments.find("curves", Some("My Curve"), None).is_some());
    match scripted.requests().as_slice() {
        [request] if request.kind == PickKind::Open => {
            let exts: Vec<&str> = request.filters.iter().flat_map(|f| f.extensions.iter().map(String::as_str)).collect();
            assert!(exts.contains(&"pcpresets") && exts.contains(&"pigment-bundle"), "{exts:?}");
        }
        other => panic!("expected one filtered open request, got {other:?}"),
    }
}

#[test]
fn unchecked_kinds_stay_out_and_a_bundle_is_refused_with_a_reason() {
    let (mut a, written, _) = app_with(vec![Picked::Paths(vec!["/tmp/Only.pcpresets".into()])]);
    a.run("gradient.presets.new", json!({"name": "Keep", "group": "Mine"})).unwrap();
    let off: Vec<(&str, Value)> = io_kinds().into_iter().filter(|(id, _)| *id != "tools").map(|(id, _)| (id, json!(false))).collect();
    run_dialog(&mut a, &off);
    let files = written.lock().unwrap().clone();
    let file: Value = serde_json::from_slice(&files[0].1).unwrap();
    assert!(file.get("gradients").is_none(), "gradients were unchecked: {file}");

    let zip = b"PK\x03\x04\x14\x00\x00\x00bundle.json\xff\xfe".to_vec();
    let (mut b, _, _) = app_with(vec![Picked::Contents(vec![("Old.pigment-bundle".into(), zip)])]);
    run_dialog(&mut b, &[("action", json!("import"))]);
    assert!(b.ui.status.contains("Migrate Presets"), "{}", b.ui.status);
}
