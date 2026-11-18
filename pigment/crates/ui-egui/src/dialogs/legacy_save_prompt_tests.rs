//! The question before the first Save over a file of Pigment 0.1–0.4.

use std::cell::RefCell;
use std::rc::Rc;

use serde_json::json;

use crate::{PhotocraftApp, Services, menus};

/// Written by Pigment 0.4.0 itself (`crates/io/tests/fixtures/pigment-0.4/README.md`).
const GROUPS: &[u8] = include_bytes!("../../../io/tests/fixtures/pigment-0.4/v3-groups.pigment");

type Asked = Rc<RefCell<Vec<crate::FileDialogRequest>>>;

/// An app with the real importer and exporter, writing to disk, and a file dialog that records
/// what it was asked.
fn app() -> (PhotocraftApp, Rc<RefCell<Vec<String>>>, Asked) {
    let (written, asked): (Rc<RefCell<Vec<String>>>, Asked) = Default::default();
    let (w, a) = (written.clone(), asked.clone());
    let services = Services {
        import: Some(Box::new(|name: &str, bytes: &[u8], opts: &photocraft_io::ImportOptions| {
            photocraft_io::import_with_options(name, bytes, opts).map(|r| (r.document, r.warnings)).map_err(|e| e.to_string())
        })),
        export: Some(Box::new(|doc: &photocraft_doc::Document, path: &str, _: &crate::ExportSettings| {
            photocraft_io::export(doc, path, &Default::default()).map(|r| (r.bytes, r.warnings)).map_err(|e| e.to_string())
        })),
        write: Some(Box::new(move |path: &str, bytes: &[u8]| {
            std::fs::write(path, bytes).map_err(|e| e.to_string())?;
            w.borrow_mut().push(path.to_string());
            Ok(())
        })),
        file_dialog: Some(Box::new(move |request, _parent, _reply| a.borrow_mut().push(request))),
        ..Default::default()
    };
    (PhotocraftApp::new(photocraft_engine::Session::new(), services), written, asked)
}

fn prompt(app: &PhotocraftApp) -> Option<&crate::state::Dialog> {
    app.ui.dialogs.iter().find(|d| super::owns(&d.fields))
}

/// A Pigment 0.4 document in a folder of its own.
fn legacy_file(name: &str) -> (std::path::PathBuf, String) {
    let dir = std::env::temp_dir().join(format!("pigment-legacy-save-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("poster.pigment");
    std::fs::write(&path, GROUPS).unwrap();
    let s = path.to_string_lossy().into_owned();
    (dir, s)
}

#[test]
fn the_first_save_over_a_pigment_0_4_file_asks_once() {
    let ctx = egui::Context::default();
    let (mut app, written, _) = app();
    let (dir, path) = legacy_file("once");
    app.open_file(&path, GROUPS).unwrap();
    // The document keeps its file.
    assert_eq!(app.session.active().unwrap().path.as_deref(), Some(path.as_str()));
    app.run("layer.new.layer", json!({})).unwrap();

    let r = menus::invoke(&mut app, &ctx, "file.save", json!({})).unwrap();
    assert_eq!(r["confirmationPending"], true);
    assert!(written.borrow().is_empty(), "nothing is written before the answer");
    let p = prompt(&app).expect("Save asks first");
    assert!(p.fields["message"].as_str().unwrap().contains("poster.pigment"), "{:?}", p.fields);

    // Cancel leaves the old file and the document as they are.
    let id = p.id;
    app.ui.close_dialog(id);
    assert!(written.borrow().is_empty());
    assert!(photocraft_io::legacy_pigment::is_legacy(&std::fs::read(&path).unwrap()));
    assert!(app.session.active().unwrap().is_dirty());

    // Save writes the new format over it, and the next Save doesn't ask again.
    let id = menus::invoke(&mut app, &ctx, "file.save", json!({})).unwrap()["dialog"].as_u64().unwrap();
    crate::dialogs::confirm(&mut app, id).unwrap();
    assert_eq!(*written.borrow(), std::slice::from_ref(&path));
    let saved = std::fs::read(&path).unwrap();
    assert!(!photocraft_io::legacy_pigment::is_legacy(&saved) && photocraft_format::is_pcraft(&saved));
    assert!(!app.session.active().unwrap().is_dirty());
    app.run("layer.new.layer", json!({})).unwrap();
    menus::invoke(&mut app, &ctx, "file.save", json!({})).unwrap();
    assert!(prompt(&app).is_none());
    assert_eq!(written.borrow().len(), 2);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn save_as_keeps_the_old_file_and_dont_show_again_is_kept() {
    let ctx = egui::Context::default();
    let (mut app, written, asked) = app();
    let (dir, path) = legacy_file("save-as");
    app.open_file(&path, GROUPS).unwrap();

    // Save As…: the save dialog, the old file untouched.
    let id = menus::invoke(&mut app, &ctx, "file.save", json!({})).unwrap()["dialog"].as_u64().unwrap();
    app.ui.dialog_mut(id).unwrap().fields.insert("choice".into(), json!("saveAs"));
    crate::dialogs::confirm(&mut app, id).unwrap();
    app.poll_file_dialog(&ctx, None);
    assert!(matches!(asked.borrow().as_slice(), [crate::FileDialogRequest::Save { .. }]), "{:?}", asked.borrow().len());
    assert!(written.borrow().is_empty());
    assert!(photocraft_io::legacy_pigment::is_legacy(&std::fs::read(&path).unwrap()));

    // "Don't show again": the next Save writes at once.
    let id = menus::invoke(&mut app, &ctx, "file.save", json!({})).unwrap()["dialog"].as_u64().unwrap();
    app.ui.dialog_mut(id).unwrap().fields.insert("skip".into(), json!(true));
    app.ui.close_dialog(id);
    assert!(!super::dont_show_again::dismissed(&app, super::PREF), "Cancel keeps nothing");
    let id = menus::invoke(&mut app, &ctx, "file.save", json!({})).unwrap()["dialog"].as_u64().unwrap();
    app.ui.dialog_mut(id).unwrap().fields.insert("skip".into(), json!(true));
    crate::dialogs::confirm(&mut app, id).unwrap();
    assert!(super::dont_show_again::dismissed(&app, super::PREF));
    std::fs::write(&path, GROUPS).unwrap();
    app.run("layer.new.layer", json!({})).unwrap();
    menus::invoke(&mut app, &ctx, "file.save", json!({})).unwrap();
    assert!(prompt(&app).is_none());
    assert_eq!(written.borrow().len(), 2);
    std::fs::remove_dir_all(dir).unwrap();
}

/// An action's Save step plays without the question (the module says so): it used to open the
/// prompt in the middle of the action and go on without saving, so a Save and Close action or a
/// Batch stopped at a document it had not saved.
#[test]
fn a_played_save_step_writes_without_asking() {
    let (mut app, written, _) = app();
    let (dir, path) = legacy_file("played");
    app.open_file(&path, GROUPS).unwrap();
    app.run("layer.new.layer", json!({})).unwrap();
    app.replay_save("file.save", &json!({})).unwrap();
    assert!(prompt(&app).is_none());
    assert_eq!(*written.borrow(), std::slice::from_ref(&path));
    assert!(photocraft_format::is_pcraft(&std::fs::read(&path).unwrap()));
    assert!(!app.session.active().unwrap().is_dirty());
    std::fs::remove_dir_all(dir).unwrap();
}
