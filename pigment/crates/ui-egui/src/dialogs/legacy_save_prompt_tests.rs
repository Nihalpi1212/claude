//! The question before the first Save over a file of Pigment 0.1–0.4.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use craft::host::{PickKind, ScriptedFiles};
use craft::ui::dialog::{StackDialog as _, StandardPrompt};
use serde_json::json;

use crate::{PhotocraftApp, Services, menus};

/// Written by Pigment 0.4.0 itself (`crates/io/tests/fixtures/pigment-0.4/README.md`).
const GROUPS: &[u8] = include_bytes!("../../../io/tests/fixtures/pigment-0.4/v3-groups.pigment");

type Asked = Arc<ScriptedFiles>;

/// An app with the real importer and exporter, writing to disk, and a file dialog that records
/// what it was asked.
fn app() -> (Box<PhotocraftApp>, Rc<RefCell<Vec<String>>>, Asked) {
    let written: Rc<RefCell<Vec<String>>> = Default::default();
    let asked: Asked = Arc::new(ScriptedFiles::held());
    let w = written.clone();
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
        files: Some(asked.clone()),
        ..Default::default()
    };
    (PhotocraftApp::new(photocraft_engine::Session::new(), services), written, asked)
}

fn prompt(app: &PhotocraftApp) -> Option<craft::ui::dialog::DialogId> {
    super::open_id(app)
}

/// The open prompt, which the `file.save` reply `r` names.
fn dialog_of(app: &PhotocraftApp, r: &serde_json::Value) -> craft::ui::dialog::DialogId {
    let id = prompt(app).expect("a prompt");
    assert_eq!(r["dialog"].as_u64(), Some(id.value()), "{r}");
    id
}

/// The kinds of the file dialogs asked for so far.
fn asked_kinds(asked: &ScriptedFiles) -> Vec<PickKind> {
    asked.requests().iter().map(|r| r.kind).collect()
}

/// The open prompt's fields as automation reads them (`choice`, `skip` when it has the box).
fn fields(app: &PhotocraftApp, id: craft::ui::dialog::DialogId) -> serde_json::Value {
    app.framework.dialogs.get_by_id::<StandardPrompt>(id).and_then(|p| p.json_fields()).expect("the prompt")
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
    let (mut app, written, _) = app();
    let ctx = app.ctx().clone();
    let (dir, path) = legacy_file("once");
    app.open_file(&path, GROUPS).unwrap();
    // The document keeps its file.
    assert_eq!(app.session.active().unwrap().path.as_deref(), Some(path.as_str()));
    app.run("layer.new.layer", json!({})).unwrap();

    let r = menus::invoke(&mut app, &ctx, "file.save", json!({})).unwrap();
    assert_eq!(r["confirmationPending"], true);
    assert!(written.borrow().is_empty(), "nothing is written before the answer");
    let id = prompt(&app).expect("Save asks first");
    assert_eq!(dialog_of(&app, &r), id);
    assert_eq!(super::pending(&app).unwrap().path, path);
    // Asked again while it is open: the same prompt.
    assert_eq!(
        {
            let r = menus::invoke(&mut app, &ctx, "file.save", json!({})).unwrap();
            dialog_of(&app, &r)
        },
        id
    );

    // Cancel leaves the old file and the document as they are.
    crate::dialogs::cancel(&mut app, &ctx, id).unwrap();
    assert!(prompt(&app).is_none());
    assert!(written.borrow().is_empty());
    assert!(photocraft_io::legacy_pigment::is_legacy(&std::fs::read(&path).unwrap()));
    assert!(app.session.active().unwrap().is_dirty());

    // Save writes the new format over it, and the next Save doesn't ask again.
    let id = {
        let r = menus::invoke(&mut app, &ctx, "file.save", json!({})).unwrap();
        dialog_of(&app, &r)
    };
    crate::dialogs::confirm(&mut app, &ctx, id).unwrap();
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
    let (mut app, written, asked) = app();
    let ctx = app.ctx().clone();
    let (dir, path) = legacy_file("save-as");
    app.open_file(&path, GROUPS).unwrap();

    // Save As…: the save dialog, the old file untouched.
    let id = {
        let r = menus::invoke(&mut app, &ctx, "file.save", json!({})).unwrap();
        dialog_of(&app, &r)
    };
    app.framework.dialogs.set_json_field(&ctx, id, "choice", json!("alternate")).unwrap();
    crate::dialogs::confirm(&mut app, &ctx, id).unwrap();
    app.poll_file_dialog();
    assert_eq!(asked_kinds(&asked), [PickKind::Save]);
    assert!(written.borrow().is_empty());
    assert!(photocraft_io::legacy_pigment::is_legacy(&std::fs::read(&path).unwrap()));

    // "Don't show again": the next Save writes at once.
    let id = {
        let r = menus::invoke(&mut app, &ctx, "file.save", json!({})).unwrap();
        dialog_of(&app, &r)
    };
    app.framework.dialogs.set_json_field(&ctx, id, "skip", json!(true)).unwrap();
    crate::dialogs::cancel(&mut app, &ctx, id).unwrap();
    assert!(!super::alerts::dismissed(&app, super::PREF), "Cancel keeps nothing");
    let id = {
        let r = menus::invoke(&mut app, &ctx, "file.save", json!({})).unwrap();
        dialog_of(&app, &r)
    };
    app.framework.dialogs.set_json_field(&ctx, id, "skip", json!(true)).unwrap();
    crate::dialogs::confirm(&mut app, &ctx, id).unwrap();
    assert!(super::alerts::dismissed(&app, super::PREF));
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

/// A document whose import left parts out loses them for good when it is saved over its file: the
/// question says so, Save As… is its default (Enter), and it is asked even after "Don't show
/// again". A document that lost nothing is asked as before.
#[test]
fn saving_over_a_file_whose_import_left_parts_out_says_so() {
    let (mut app, written, asked) = app();
    let ctx = app.ctx().clone();

    let (dir, path) = legacy_file("nothing-left-out");
    app.open_file(&path, GROUPS).unwrap();
    let id = {
        let r = menus::invoke(&mut app, &ctx, "file.save", json!({})).unwrap();
        dialog_of(&app, &r)
    };
    assert!(!super::pending(&app).unwrap().left_out);
    let shown = fields(&app, id);
    assert_eq!(shown["choice"], "proceed");
    assert!(shown.get("skip").is_some(), "it has \"Don't show again\": {shown}");
    crate::dialogs::cancel(&mut app, &ctx, id).unwrap();
    std::fs::remove_dir_all(dir).unwrap();

    // Data of a later 0.4 build this version does not know: the import leaves it out.
    let json = br#"{"version":3,"app":"pigment","width":4,"height":4,"layers":[{"id":"a","type":"raster","name":"A"}],"store":{"timeline":{"data":[]}}}"#;
    let mut zip = photocraft_format::zip::ZipWriter::new();
    zip.add("document.json", json).unwrap();
    let bytes = zip.finish().unwrap();
    let (dir, path) = legacy_file("left-out");
    std::fs::write(&path, &bytes).unwrap();
    app.open_file(&path, &bytes).unwrap();
    super::alerts::remember_skip(&mut app, super::PREF);

    let r = menus::invoke(&mut app, &ctx, "file.save", json!({})).unwrap();
    assert!(written.borrow().is_empty(), "{r}");
    let id = prompt(&app).expect("asked although \"Don't show again\" was ticked");
    assert!(super::pending(&app).unwrap().left_out);
    let shown = fields(&app, id);
    assert!(shown.get("skip").is_none(), "no \"Don't show again\": {shown}");
    // Its default answer (Save As…) keeps the old file.
    crate::dialogs::confirm(&mut app, &ctx, id).unwrap();
    app.poll_file_dialog();
    assert_eq!(asked_kinds(&asked), [PickKind::Save]);
    assert!(written.borrow().is_empty());
    assert!(photocraft_io::legacy_pigment::is_legacy(&std::fs::read(&path).unwrap()));
    std::fs::remove_dir_all(dir).unwrap();
}
