//! The Adjustments panel's presets through real pointer input, the hover preview and Save
//! Adjustment Preset… of the Properties panel menu.

use egui::vec2;
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;
use photocraft_doc::LayerContent;
use serde_json::json;

use super::*;

fn app() -> Box<PhotocraftApp> {
    let mut s = photocraft_engine::Session::new();
    s.execute("file.new", json!({"width": 32, "height": 24})).unwrap();
    PhotocraftApp::new(s, crate::Services::default())
}

/// The Adjustments panel alone, as the dock draws it.
fn harness(app: Box<PhotocraftApp>) -> Harness<'static, Box<PhotocraftApp>> {
    let h = Harness::builder()
        .with_context(app.ctx().clone())
        .with_size(vec2(320.0, 1400.0))
        .with_step_dt(1.0 / 60.0)
        .build_ui_state(|ui, app| super::super::properties::adjustments::panel(app, ui), app);
    PhotocraftApp::setup_context(&h.ctx, crate::theme::AppTheme::pro());
    h
}

fn rect_of(h: &Harness<'static, Box<PhotocraftApp>>, text: &str) -> egui::Rect {
    h.query_all_by_label(text).last().unwrap_or_else(|| panic!("no \"{text}\"")).rect()
}

fn click(h: &mut Harness<'static, Box<PhotocraftApp>>, at: egui::Pos2) {
    h.hover_at(at);
    h.run_steps(1);
    h.drag_at(at);
    h.run_steps(1);
    h.drop_at(at);
    h.run_steps(3);
}

fn history(app: &PhotocraftApp) -> usize {
    app.session.active().unwrap().history.past_len()
}

#[test]
fn every_built_in_group_and_preset_is_listed() {
    let mut h = harness(app());
    h.run_steps(3);
    for group in PANEL_PRESETS {
        let at = rect_of(&h, group.name).center();
        click(&mut h, at);
        for p in group.presets {
            assert!(h.query_all_by_label(p.name).next().is_some(), "{} / {}", group.name, p.name);
        }
    }
    assert!(h.query_all_by_label("Your Presets").next().is_none(), "no Your Presets before one is saved");
}

#[test]
fn a_preset_button_adds_its_layers_in_one_step_and_hovering_previews_them() {
    let mut h = harness(app());
    h.run_steps(3);
    let at = rect_of(&h, "Cinematic").center();
    click(&mut h, at);
    let moody = rect_of(&h, "Moody").center();
    let doc_layers = h.state().session.active().unwrap().doc.layers.len();
    // Hovering previews the group on the canvas, and changes nothing.
    h.hover_at(moody);
    h.run_steps(2);
    assert!(h.state().adjust_panel_hover.is_some(), "hovering sets the preview");
    let (shown, key) = display_doc(h.state_mut(), 0).expect("a preview document");
    assert!(is_preview_key(key));
    assert_eq!(shown.layers.len(), doc_layers + 1);
    assert_eq!(shown.layers.last().unwrap().name, "Moody");
    assert_eq!(h.state().session.active().unwrap().doc.layers.len(), doc_layers, "the document is untouched");
    // Leaving clears it.
    h.hover_at(egui::pos2(300.0, 1390.0));
    h.run_steps(2);
    assert!(h.state().adjust_panel_hover.is_none(), "leaving clears the preview");
    assert!(display_doc(h.state_mut(), 0).is_none());
    // A click adds the group in one history step; one undo removes it.
    let steps = history(h.state());
    click(&mut h, moody);
    let st = h.state().session.active().unwrap();
    assert_eq!(st.history.past_len(), steps + 1);
    let group = st.doc.layers.last().unwrap();
    assert_eq!(group.name, "Moody");
    let kinds: Vec<&str> = group
        .children()
        .unwrap()
        .iter()
        .map(|l| match &l.content {
            LayerContent::Adjustment(a) => photocraft_engine::commands::adjustment_kind(a),
            _ => "?",
        })
        .collect();
    assert_eq!(kinds, ["curves", "hueSaturation"]);
    h.state_mut().run("edit.undo", json!({})).unwrap();
    assert_eq!(h.state().session.active().unwrap().doc.layers.len(), doc_layers);
}

#[test]
fn a_single_layer_preset_adds_no_group() {
    let mut h = harness(app());
    h.run_steps(3);
    let at = rect_of(&h, "Photo Repair").center();
    click(&mut h, at);
    let at = rect_of(&h, "Lift Shadows").center();
    click(&mut h, at);
    let st = h.state().session.active().unwrap();
    let top = st.doc.layers.last().unwrap();
    assert!(!top.is_group());
    assert!(matches!(top.content, LayerContent::Adjustment(photocraft_doc::Adjustment::Curves { .. })));
}

#[test]
fn save_adjustment_preset_saves_the_selected_layers_as_your_presets() {
    let mut app = app();
    assert!(!command_states(&app)[0].1.is_enabled(), "no adjustment layer is selected");
    app.run("layer.newAdjustmentLayer.threshold", json!({"level": 90})).unwrap();
    assert!(command_states(&app)[0].1.is_enabled());
    let ctx = app.ctx().clone();
    assert!(run_fired(&mut app, &ctx, &CommandRef::from(PropertiesCommand::SaveAdjustmentPreset)));
    crate::dialogs::testing::show(&mut app);
    let id = app.framework.dialogs.stack().top().expect("the name dialog");
    crate::dialogs::testing::confirm(&mut app, id).unwrap();
    let yours = panel::yours(&app.session.presets.adjustments);
    assert_eq!(yours.len(), 1);
    assert_eq!(yours[0].0, "Adjustment Preset 1");
    assert_eq!(yours[0].1[0].kind, "threshold");
    // The panel lists it under Your Presets, and its button adds it.
    let mut h = harness(app);
    h.run_steps(3);
    let at = rect_of(&h, "Adjustment Preset 1").center();
    let n = h.state().session.active().unwrap().doc.layers.len();
    click(&mut h, at);
    assert_eq!(h.state().session.active().unwrap().doc.layers.len(), n + 1);
}

#[test]
fn a_preview_is_dropped_once_the_panel_is_no_longer_drawn() {
    let mut app = app();
    hover(&mut app, Some(("cinematic".into(), "moody".into())));
    assert!(display_doc(&mut app, 0).is_some());
    app.frame += 2;
    assert!(display_doc(&mut app, 0).is_none(), "a panel not drawn for a frame previews nothing");
    // An edit of the document drops it too.
    hover(&mut app, Some(("cinematic".into(), "moody".into())));
    app.run("layer.new.layer", json!({})).unwrap();
    assert!(display_doc(&mut app, 0).is_none());
}

fn is_preview_key(key: u64) -> bool {
    (BASE..BASE << 1).contains(&key)
}
