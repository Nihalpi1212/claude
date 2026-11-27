//! The Preset row: which preset a value shows, picks in the Curves dialog and in a Levels
//! layer's Properties through real pointer input, and the asks the hosts answer.

use egui::vec2;
use egui_kittest::Harness;
use egui_kittest::kittest::{NodeT, Queryable};
use photocraft_doc::{ColorMode, LayerContent};
use serde_json::{Value, json};

use super::*;
use crate::adjust_editors::values::ValueCx;

fn cx() -> ValueCx {
    ValueCx::new(ColorMode::Rgb, json!({}))
}

fn curves_entries() -> Vec<PresetEntry> {
    let s = photocraft_engine::Session::new();
    s.presets.adjustments.list("curves").into_iter().map(|e| PresetEntry { group: e.group, name: e.preset.name, builtin: e.builtin, params: e.preset.params }).collect()
}

fn strong_contrast() -> Value {
    json!({"points": [[0, 0], [64, 32], [192, 224], [255, 255]]})
}

#[test]
fn a_value_shows_the_preset_whose_keys_it_matches_else_custom() {
    let entries = curves_entries();
    let value = preset_value("curves", &strong_contrast(), &cx()).unwrap();
    assert_eq!(held("curves", &entries, &value, &cx()).as_deref(), Some("Strong Contrast (RGB)"));
    // The defaults are Default.
    let defaults = default_value("curves", &cx()).unwrap();
    assert_eq!(held("curves", &entries, &defaults, &cx()).as_deref(), Some(DEFAULT_KEY));
    // A point moved: Custom.
    let moved = preset_value("curves", &json!({"points": [[0, 0], [64, 30], [192, 224], [255, 255]]}), &cx()).unwrap();
    assert_eq!(held("curves", &entries, &moved, &cx()), None);
    // Only the preset's keys count: a composite preset still shows over an edited red channel (the app's rule).
    let red = preset_value("curves", &json!({"points": [[0, 0], [64, 32], [192, 224], [255, 255]], "red": [[0, 20], [255, 255]]}), &cx()).unwrap();
    assert_eq!(held("curves", &entries, &red, &cx()).as_deref(), Some("Strong Contrast (RGB)"));
    // Numbers compare by value: Levels' `15` and `15.0`.
    let s = photocraft_engine::Session::new();
    let levels: Vec<PresetEntry> =
        s.presets.adjustments.list("levels").into_iter().map(|e| PresetEntry { group: e.group, name: e.preset.name, builtin: e.builtin, params: e.preset.params }).collect();
    let darker = preset_value("levels", &json!({"inBlack": 15.0, "gamma": 0.85}), &cx()).unwrap();
    assert_eq!(held("levels", &levels, &darker, &cx()).as_deref(), Some("Darker"));
}

#[test]
fn rows_list_default_then_each_group_and_its_presets() {
    let mut entries = curves_entries();
    entries.push(PresetEntry { group: USER_GROUP.into(), name: "Mine".into(), builtin: false, params: json!({}) });
    let rows = rows(&entries);
    assert_eq!(rows[0].key, DEFAULT_KEY);
    let groups: Vec<&str> = rows.iter().filter(|r| r.is_group()).map(|r| r.label.as_str()).collect();
    assert_eq!(groups, ["Built-in", "My Presets"]);
    assert_eq!(rows.last().unwrap().key, "Mine");
    assert_eq!(rows.len(), 1 + 2 + entries.len());
}

#[test]
fn a_saved_file_is_photoshops_and_named_after_the_preset() {
    let value = preset_value("curves", &strong_contrast(), &cx()).unwrap();
    let file = file_of("curves", &value, &cx(), Some("Strong / Contrast")).unwrap();
    assert_eq!(file.file_name, "Strong _ Contrast.acv");
    let (adj, _) = photocraft_io::adjust_presets::read("curves", &file.bytes).unwrap();
    assert!(matches!(adj, photocraft_doc::Adjustment::Curves { .. }));
    // Kinds without a Photoshop file have no Save….
    let exposure = preset_value("exposure", &json!({"exposure": 1}), &cx()).unwrap();
    assert!(file_of("exposure", &exposure, &cx(), None).is_none());
}

// ------------------------------------------------------------------ through the interface

/// Clicks the Preset picker's field (the combo box beside the "Preset" caption) and then the
/// preset named `name` in its list.
fn pick(h: &mut Harness<'static, Box<PhotocraftApp>>, name: &str) {
    let field = h
        .query_all_by_role(egui::accesskit::Role::ComboBox)
        .find(|n| n.accesskit_node().label().is_some_and(|l| l.contains("Preset")))
        .or_else(|| h.query_all_by_label("Preset").find(|n| n.accesskit_node().role() != egui::accesskit::Role::Label))
        .expect("the Preset field")
        .rect();
    click(h, field.center());
    let item = h.query_all_by_label(name).last().unwrap_or_else(|| panic!("{name} in the Preset list")).rect();
    click(h, item.center());
    h.run_steps(4);
}

fn click(h: &mut Harness<'static, Box<PhotocraftApp>>, at: egui::Pos2) {
    h.hover_at(at);
    h.run_steps(1);
    h.drag_at(at);
    h.run_steps(1);
    h.drop_at(at);
    h.run_steps(3);
}

fn dialog_harness(app: Box<PhotocraftApp>) -> Harness<'static, Box<PhotocraftApp>> {
    let h = Harness::builder()
        .with_context(app.ctx().clone())
        .with_size(vec2(1200.0, 900.0))
        .with_step_dt(1.0 / 60.0)
        .build_ui_state(|ui, app| crate::dialogs::run(app, ui), app);
    PhotocraftApp::setup_context(&h.ctx, crate::theme::AppTheme::pro());
    h
}

fn app_with_image() -> Box<PhotocraftApp> {
    let mut s = photocraft_engine::Session::new();
    s.execute("file.new", json!({"width": 64, "height": 48})).unwrap();
    PhotocraftApp::new(s, crate::Services::default())
}

fn dialog_points(app: &PhotocraftApp) -> Value {
    crate::adjust_dialog::open_params(app).unwrap()["points"].clone()
}

#[test]
fn picking_a_preset_in_the_curves_dialog_sets_its_curve_and_an_edit_shows_custom() {
    let mut h = dialog_harness(app_with_image());
    let id = crate::adjust_dialog::open(h.state_mut(), "image.adjustments.curves").unwrap();
    h.run_steps(4);
    pick(&mut h, "Strong Contrast (RGB)");
    assert_eq!(dialog_points(h.state()), strong_contrast(), "the dialog's points are the built-in's");
    let setup = h.state().adjust_open.as_ref().unwrap().setup.lock().unwrap().clone();
    let value = crate::adjust_dialog::hosted(h.state(), id).unwrap().value().clone();
    assert_eq!(held("curves", &setup.presets, &value.value, &value.cx).as_deref(), Some("Strong Contrast (RGB)"));
    // An edit of the curve leaves the preset: the field shows Custom.
    crate::adjust_dialog::apply_params(h.state_mut(), id, &json!({"points": [[0, 0], [64, 40], [192, 224], [255, 255]]}));
    h.run_steps(3);
    let value = crate::adjust_dialog::hosted(h.state(), id).unwrap().value().clone();
    assert_eq!(held("curves", &setup.presets, &value.value, &value.cx), None);
    assert!(h.query_all_by_role(egui::accesskit::Role::ComboBox).any(|n| n.value().is_some_and(|v| v.contains("Custom"))), "the picker shows Custom");
    // The document is untouched until OK.
    assert_eq!(h.state().session.active().unwrap().doc.layers.len(), 1);
}

#[test]
fn saving_renaming_and_deleting_a_preset_from_the_dialog() {
    let mut h = dialog_harness(app_with_image());
    let id = crate::adjust_dialog::open(h.state_mut(), "image.adjustments.levels").unwrap();
    h.run_steps(3);
    crate::adjust_dialog::apply_params(h.state_mut(), id, &json!({"inBlack": 33, "gamma": 1.2}));
    h.run_steps(2);
    answer_dialog(h.state_mut(), id, PresetAsk::Create("Mine".into()));
    h.run_steps(3);
    let saved = h.state().session.presets.adjustments.find("levels", Some("Mine"), None).expect("saved");
    assert_eq!((saved.preset.params["inBlack"].as_f64(), saved.preset.params["gamma"].as_f64()), (Some(33.0), Some(1.2)));
    assert!(saved.preset.params.get("target").is_none() && saved.preset.params.get("layer").is_none(), "settings only");
    // The dialog lists it at once and shows it as the current preset.
    let setup = h.state().adjust_open.as_ref().unwrap().setup.lock().unwrap().clone();
    assert!(setup.presets.iter().any(|e| e.name == "Mine"));
    let value = crate::adjust_dialog::hosted(h.state(), id).unwrap().value().clone();
    assert_eq!(held("levels", &setup.presets, &value.value, &value.cx).as_deref(), Some("Mine"));
    answer_dialog(h.state_mut(), id, PresetAsk::Rename { from: "Mine".into(), to: "Ours".into() });
    assert!(h.state().session.presets.adjustments.find("levels", Some("Ours"), None).is_some());
    answer_dialog(h.state_mut(), id, PresetAsk::Delete("Darker".into()));
    assert!(h.state().session.presets.adjustments.find("levels", Some("Darker"), None).is_none(), "a built-in can be deleted");
    answer_dialog(h.state_mut(), id, PresetAsk::Reset);
    assert!(h.state().session.presets.adjustments.find("levels", Some("Darker"), None).is_some(), "Reset Presets brings it back");
    assert!(h.state().session.presets.adjustments.find("levels", Some("Ours"), None).is_some(), "and keeps the user's");
}

#[test]
fn every_dialog_kind_shows_the_preset_row() {
    let mut h = dialog_harness(app_with_image());
    for kind in crate::adjust_editors::KINDS {
        crate::adjust_dialog::open(h.state_mut(), &format!("image.adjustments.{kind}")).unwrap();
        h.run_steps(3);
        assert!(h.query_all_by_label("Reset Presets").next().is_some(), "{kind}: no Preset row");
        let id = crate::adjust_dialog::open_value(h.state()).unwrap().id;
        let ctx = h.ctx.clone();
        crate::dialogs::cancel(h.state_mut(), &ctx, id).unwrap();
        h.run_steps(2);
    }
}

#[test]
fn a_preset_picked_in_properties_is_one_history_step() {
    let mut h = Harness::builder().with_size(vec2(1440.0, 900.0)).with_max_steps(64).with_step_dt(1.0 / 60.0).build_eframe(|cc| {
        PhotocraftApp::setup_context(&cc.egui_ctx, Default::default());
        let mut s = photocraft_engine::Session::new();
        s.execute("file.new", json!({"width": 64, "height": 48})).unwrap();
        s.execute("layer.newAdjustmentLayer.levels", json!({})).unwrap();
        let mut app = PhotocraftApp::with_context(cc.egui_ctx.clone(), s, crate::Services::default());
        crate::panel_docking::apply(&mut app, vec![craft::behavior::dock::Action::resize_group("properties".to_owned(), Some(560.0))]).unwrap();
        app
    });
    h.run_steps(8);
    let steps = h.state().session.active().unwrap().history.past_len();
    pick(&mut h, "Increase Contrast 2");
    let st = h.state().session.active().unwrap();
    assert_eq!(st.history.past_len(), steps + 1, "one history step");
    let LayerContent::Adjustment(adj) = &st.doc.layer(st.active_layer.unwrap()).unwrap().content else { panic!("an adjustment layer") };
    let expected = photocraft_engine::adjust_params::from_params("levels", &json!({"inBlack": 20, "inWhite": 235}), None, ColorMode::Rgb).unwrap();
    assert_eq!(*adj, expected);
    assert!(h.state().live_adjust.is_none());
}
