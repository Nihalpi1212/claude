//! Pigment: Edit › Presets › Migrate Presets (P4).

use std::path::PathBuf;
use std::sync::Arc;

use craft::host::{Picked, ScriptedFiles};

use super::*;

/// The engine's fixture: a JavaScript Pigment settings folder (its README says what is there).
fn fixture() -> PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../engine/tests/fixtures/pigment-0.4-presets")
}

fn app_with(legacy: Option<PathBuf>, files: Vec<Picked>) -> PhotocraftApp {
    let services = crate::Services { files: Some(Arc::new(ScriptedFiles::answering(files))), legacy_presets_dir: legacy, ..Default::default() };
    *PhotocraftApp::new(photocraft_engine::Session::new(), services)
}

fn menu(app: &mut PhotocraftApp) -> Value {
    let ctx = app.ctx().clone();
    crate::menus::invoke(app, &ctx, COMMAND, json!({})).unwrap()
}

fn gradient_names(app: &PhotocraftApp) -> Vec<String> {
    app.session.presets.gradients.iter().flat_map(|g| g.items.iter().map(|p| p.name.clone())).collect()
}

#[test]
fn the_old_apps_folder_is_offered_and_ok_migrates() {
    let mut app = app_with(Some(fixture().join("presets")), vec![]);
    let r = menu(&mut app);
    assert_eq!(r["confirmationPending"], true, "{r}");
    let id = crate::dialogs::alerts::prompt_tagged::<MigratePrompt>(&app).expect("the menu item asks first");
    crate::dialogs::testing::cancel(&mut app, id).unwrap();
    assert!(!gradient_names(&app).iter().any(|n| n == "Sunset"), "Cancel migrates nothing");

    menu(&mut app);
    let id = crate::dialogs::alerts::prompt_tagged::<MigratePrompt>(&app).unwrap();
    crate::dialogs::testing::confirm(&mut app, id).unwrap();
    assert!(gradient_names(&app).iter().any(|n| n == "Sunset"));
    assert!(app.session.presets.tool_presets.iter().any(|t| t.name == "Inked Pencil"));
    assert!(!app.ui.status_error);
    assert!(app.ui.status.starts_with("22 presets migrated."), "{}", app.ui.status);
    assert!(app.ui.status.contains("not migrated"), "{}", app.ui.status);

    // Again: nothing new.
    menu(&mut app);
    let id = crate::dialogs::alerts::prompt_tagged::<MigratePrompt>(&app).unwrap();
    crate::dialogs::testing::confirm(&mut app, id).unwrap();
    assert!(app.ui.status.starts_with("0 presets migrated."), "{}", app.ui.status);
}

#[test]
fn without_the_old_folder_a_folder_is_asked_for() {
    let mut app = app_with(None, vec![Picked::Paths(vec![fixture()])]);
    let r = menu(&mut app);
    assert_eq!(r, json!({"fileDialog": "folder"}));
    assert!(crate::dialogs::alerts::prompt_tagged::<MigratePrompt>(&app).is_none());
    app.poll_file_dialog();
    assert!(gradient_names(&app).iter().any(|n| n == "Sunset"));
    assert!(app.ui.status.starts_with("22 presets migrated."), "{}", app.ui.status);

    // A folder without any of the old app's files.
    let empty = std::env::temp_dir().join(format!("pigment-migrate-ui-{}", std::process::id()));
    std::fs::create_dir_all(&empty).unwrap();
    let mut app = app_with(None, vec![Picked::Paths(vec![empty.clone()])]);
    menu(&mut app);
    app.poll_file_dialog();
    assert_eq!(app.ui.status, "No Pigment 0.4 presets were found.");
    let _ = std::fs::remove_dir_all(empty);
}

#[test]
fn the_engine_command_with_a_path_runs_directly() {
    let mut app = app_with(Some(fixture()), vec![]);
    let ctx = app.ctx().clone();
    let r = crate::menus::invoke(&mut app, &ctx, COMMAND, json!({"path": fixture().to_string_lossy()})).unwrap();
    assert_eq!(r["migrated"], 22, "{r}");
    assert!(crate::dialogs::alerts::prompt_tagged::<MigratePrompt>(&app).is_none());
}
