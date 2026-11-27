//! Pigment: the Preset Manager dialog (P1a).

use std::sync::{Arc, Mutex};

use craft::host::{Picked, ScriptedFiles};
use craft::keymap::Mods;
use craft::ui::dialog::{PromptChoice, StandardPrompt};
use serde_json::json;

use super::*;

fn app_with(files: Vec<Picked>) -> (PhotocraftApp, Arc<Mutex<Vec<(String, Vec<u8>)>>>) {
    let written = Arc::new(Mutex::new(Vec::new()));
    let sink = written.clone();
    let services = crate::Services {
        files: Some(Arc::new(ScriptedFiles::answering(files))),
        write: Some(Box::new(move |path, data| {
            sink.lock().unwrap().push((path.to_string(), data.to_vec()));
            Ok(())
        })),
        ..Default::default()
    };
    (*PhotocraftApp::new(photocraft_engine::Session::new(), services), written)
}

/// Opens the manager from the Edit › Presets menu item.
fn open_from_menu(app: &mut PhotocraftApp) {
    let ctx = app.ctx().clone();
    crate::menus::invoke(app, &ctx, "edit.presets.presetManager", json!({})).unwrap();
    assert!(app.framework.dialogs.get_mut::<PresetManagerDialog>().is_some(), "the Preset Manager is open");
}

fn dialog(app: &mut PhotocraftApp) -> &mut PresetManagerDialog {
    app.framework.dialogs.get_mut::<PresetManagerDialog>().expect("the Preset Manager is open")
}

fn fields(app: &mut PhotocraftApp) -> Value {
    dialog(app).json_fields().unwrap()
}

fn set(app: &mut PhotocraftApp, field: &str, value: Value) {
    let ctx = app.ctx().clone();
    dialog(app).set_json_field(&ctx, field, value).unwrap();
    take(app, &ctx);
}

fn names(app: &mut PhotocraftApp) -> Vec<String> {
    fields(app)["rows"].as_array().unwrap().iter().map(|r| r["name"].as_str().unwrap().to_string()).collect()
}

#[test]
fn opens_from_the_menu_and_lists_swatches_with_their_colours() {
    let (mut app, _) = app_with(Vec::new());
    open_from_menu(&mut app);
    assert_eq!(fields(&mut app)["kind"], "brushes");
    set(&mut app, "kind", json!("swatches"));
    let f = fields(&mut app);
    assert_eq!(f["kind"], "swatches");
    let swatches: Vec<String> = app.session.presets.swatches.iter().flat_map(|g| g.entries.iter().map(|e| e.name.clone())).collect();
    assert_eq!(names(&mut app), swatches);
    // Each swatch row carries its colour for the thumbnail.
    assert!(dialog(&mut app).rows.iter().all(|r| matches!(r.thumb, Thumb::Color(_))), "every swatch has a colour chip");
    // The dialog draws (grid and list) without panicking.
    crate::dialogs::testing::show(&mut app);
    set(&mut app, "view", json!("largeList"));
    crate::dialogs::testing::show(&mut app);
    // Every kind lists rows.
    for (kind, _) in KINDS {
        set(&mut app, "kind", json!(kind));
        assert!(!names(&mut app).is_empty() || kind == "contours", "{kind} lists its presets");
        crate::dialogs::testing::show(&mut app);
    }
    let ctx = app.ctx().clone();
    assert!(dialog(&mut app).set_json_field(&ctx, "kind", json!("nope")).is_err());
}

#[test]
fn cmd_selecting_two_presets_and_delete_removes_both() {
    let (mut app, _) = app_with(Vec::new());
    open_from_menu(&mut app);
    set(&mut app, "kind", json!("gradients"));
    let before = names(&mut app);
    let ctx = app.ctx().clone();
    // A click, then Cmd-clicks: two presets selected.
    let cmd = Mods { cmd: true, ..Mods::default() };
    dialog(&mut app).select(0, Mods::default());
    dialog(&mut app).select(2, cmd);
    assert_eq!(fields(&mut app)["selected"], json!([0, 2]));
    // Cmd-click again toggles off; Shift extends a range from the anchor.
    dialog(&mut app).select(2, cmd);
    assert_eq!(fields(&mut app)["selected"], json!([0]));
    dialog(&mut app).select(2, Mods { shift: true, ..Mods::default() });
    assert_eq!(fields(&mut app)["selected"], json!([0, 1, 2]));
    dialog(&mut app).select(1, cmd);
    dialog(&mut app).press(&ctx, DELETE);
    take(&mut app, &ctx);
    let mut want = before.clone();
    want.remove(2);
    want.remove(0);
    assert_eq!(names(&mut app), want, "both selected presets are gone");
    let lib: Vec<String> = app.session.presets.gradients.iter().flat_map(|g| g.items.iter().map(|i| i.name.clone())).collect();
    assert_eq!(lib, want);
    assert_eq!(fields(&mut app)["selected"], json!([]));
}

#[test]
fn save_set_writes_the_selected_presets_through_the_file_dialog() {
    let (mut app, written) = app_with(vec![Picked::Paths(vec!["/tmp/Two.asl".into()])]);
    open_from_menu(&mut app);
    set(&mut app, "kind", json!("styles"));
    let first_two: Vec<String> = names(&mut app).into_iter().take(2).collect();
    set(&mut app, "selected", json!([0, 1]));
    set(&mut app, "press", json!("saveSet"));
    app.poll_file_dialog();
    let files = written.lock().unwrap().clone();
    let [(path, bytes)] = files.as_slice() else { panic!("one file written, got {}", files.len()) };
    assert_eq!(path, "/tmp/Two.asl");
    let read = photocraft_io::asl_map::read_asl(bytes).unwrap();
    assert_eq!(read.styles.iter().map(|s| s.name.clone()).collect::<Vec<_>>(), first_two);
    assert!(app.ui.status.contains("Saved 2 presets"), "{}", app.ui.status);
}

#[test]
fn load_reads_a_file_of_the_kind_into_its_library() {
    // A contour file, written by the library itself.
    let mut src = photocraft_engine::Session::new();
    src.execute("layer.layerStyle.contours.new", json!({"contour": {"name": "Bump", "points": [[0, 0], [0.5, 1], [1, 0]]}, "name": "Bump"})).unwrap();
    let shc = src.execute("layer.layerStyle.contours.save", json!({})).unwrap();
    let shc = photocraft_engine::paint::tile::b64_decode(shc["data"].as_str().unwrap()).unwrap();
    let (mut app, _) = app_with(vec![Picked::Contents(vec![("Bumps.shc".into(), shc.clone())])]);
    open_from_menu(&mut app);
    set(&mut app, "kind", json!("contours"));
    assert!(names(&mut app).is_empty());
    set(&mut app, "press", json!("load"));
    app.poll_file_dialog();
    let ctx = app.ctx().clone();
    take(&mut app, &ctx);
    assert_eq!(names(&mut app), ["Bump"], "{}", app.ui.status);
    assert!(matches!(dialog(&mut app).rows[0].thumb, Thumb::Curve(_)));
    // File › Open of a .shc goes to the same library.
    assert!(crate::preset_files_ui::is_preset_file("More.shc"));
    crate::preset_files_ui::open(&mut app, "More.shc", &shc).unwrap().unwrap();
    take(&mut app, &ctx);
    assert_eq!(names(&mut app), ["Bump", "Bump 2"]);
}

#[test]
fn reset_asks_first_and_restores_the_defaults() {
    let (mut app, _) = app_with(Vec::new());
    open_from_menu(&mut app);
    set(&mut app, "kind", json!("tools"));
    let defaults = names(&mut app);
    set(&mut app, "selected", json!([0]));
    set(&mut app, "press", json!("delete"));
    assert_eq!(names(&mut app).len(), defaults.len() - 1);
    set(&mut app, "press", json!("reset"));
    let id = crate::dialogs::alerts::prompt_tagged::<ManagerPrompt>(&app).expect("Reset asks first");
    app.framework.dialogs.get_mut_by_id::<StandardPrompt>(id).unwrap().set_choice(PromptChoice::Proceed);
    crate::dialogs::testing::confirm(&mut app, id).unwrap();
    assert_eq!(names(&mut app), defaults);
    // Kinds without a reset refuse it.
    set(&mut app, "kind", json!("patterns"));
    let ctx = app.ctx().clone();
    assert!(dialog(&mut app).set_json_field(&ctx, "press", json!("reset")).is_err());
}

#[test]
fn the_view_is_remembered_per_kind() {
    let (mut app, _) = app_with(Vec::new());
    open_from_menu(&mut app);
    assert_eq!(fields(&mut app)["view"], "smallThumbnail");
    set(&mut app, "view", json!("textOnly"));
    set(&mut app, "kind", json!("gradients"));
    assert_eq!(fields(&mut app)["view"], "smallThumbnail", "each kind has its own view");
    set(&mut app, "view", json!("largeThumbnail"));
    set(&mut app, "kind", json!("brushes"));
    assert_eq!(fields(&mut app)["view"], "textOnly");
    // Kept in the panel state that persists in ui.ron, and used when the manager opens again.
    let ctx = app.ctx().clone();
    take(&mut app, &ctx);
    assert_eq!(View::of(&app.ui.presets_ui.browsers[&state_key("gradients")]), View::LargeThumbnail);
    let id = dialog(&mut app).id;
    crate::dialogs::testing::confirm(&mut app, id).unwrap();
    assert!(app.framework.dialogs.get_mut::<PresetManagerDialog>().is_none(), "Done closes it");
    open_from_menu(&mut app);
    assert_eq!(fields(&mut app)["kind"], "brushes");
    assert_eq!(fields(&mut app)["view"], "textOnly");
    set(&mut app, "kind", json!("gradients"));
    assert_eq!(fields(&mut app)["view"], "largeThumbnail");
    assert!(dialog(&mut app).set_json_field(&ctx, "view", json!("huge")).is_err());
}

#[test]
fn a_reorder_runs_the_engines_move() {
    let (mut app, _) = app_with(Vec::new());
    open_from_menu(&mut app);
    set(&mut app, "kind", json!("tools"));
    let before = names(&mut app);
    let rows = dialog(&mut app).browser_rows();
    let ctx = app.ctx().clone();
    // A flat kind: the browser rows are the presets; moving the first one to the third place.
    let mv = craft::ui::contract::ReorderMove { key: PresetKey::Item("0".into()), keys: vec![PresetKey::Item("0".into())], to: 2, copy: false, parent: None };
    let edit = craft::behavior::EditEvent::set(craft::behavior::Mixed::Same(mv.clone()), mv, std::sync::Arc::from("Reorder"), None);
    dialog(&mut app).event(PresetEvent::Reorder(edit), &rows);
    take(&mut app, &ctx);
    let after = names(&mut app);
    assert_eq!(after[2], before[0]);
    assert_eq!(after[0], before[1]);
}
