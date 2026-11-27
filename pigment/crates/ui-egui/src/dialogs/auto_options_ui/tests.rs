//! Auto Color Correction Options in the adjustment dialogs and Properties, driven through real pointer input where the
//! control is Pigment's (Auto, Options…, the eyedroppers), and through the dialog's fields as automation sets them.

use craft::imaging::ui::adjust::TonePicker;
use craft::theme::Srgba;
use craft::ui::patterns::form_dialogs::{FieldValue, HostedParamDialog};
use egui::vec2;
use egui_kittest::Harness;
use egui_kittest::kittest::{NodeT, Queryable};
use photocraft_doc::{Adjustment, ColorMode, LayerContent};
use serde_json::{Value, json};

use super::*;

type H = Harness<'static, Box<PhotocraftApp>>;

/// A low-contrast image with a cast: four bands of greyish colours.
fn app_with_image() -> Box<PhotocraftApp> {
    let mut s = photocraft_engine::Session::new();
    s.execute("file.new", json!({"width": 64, "height": 48})).unwrap();
    for (i, color) in ["#5a4a50", "#6e6068", "#827880", "#969098"].iter().enumerate() {
        s.execute("select.rect", json!({"x": i * 16, "y": 0, "width": 16, "height": 48})).unwrap();
        s.execute("edit.fill", json!({"color": color})).unwrap();
    }
    s.execute("select.deselect", json!({})).unwrap();
    PhotocraftApp::new(s, crate::Services::default())
}

/// A dark image (Brightness/Contrast's Auto brightens it).
fn app_with_dark_image() -> Box<PhotocraftApp> {
    let mut s = photocraft_engine::Session::new();
    s.execute("file.new", json!({"width": 64, "height": 48})).unwrap();
    for (i, color) in ["#080808", "#141414", "#202020", "#303030"].iter().enumerate() {
        s.execute("select.rect", json!({"x": i * 16, "y": 0, "width": 16, "height": 48})).unwrap();
        s.execute("edit.fill", json!({"color": color})).unwrap();
    }
    s.execute("select.deselect", json!({})).unwrap();
    PhotocraftApp::new(s, crate::Services::default())
}

fn dialog_harness(app: Box<PhotocraftApp>) -> H {
    let h = Harness::builder()
        .with_context(app.ctx().clone())
        .with_size(vec2(1200.0, 900.0))
        .with_step_dt(1.0 / 60.0)
        .build_ui_state(|ui, app| crate::dialogs::run(app, ui), app);
    PhotocraftApp::setup_context(&h.ctx, crate::theme::AppTheme::pro());
    h
}

fn click(h: &mut H, at: egui::Pos2) {
    h.hover_at(at);
    h.run_steps(1);
    h.drag_at(at);
    h.run_steps(1);
    h.drop_at(at);
    h.run_steps(3);
}

/// Two presses at `at` within the double-click time.
fn double_click(h: &mut H, at: egui::Pos2) {
    h.hover_at(at);
    h.run_steps(1);
    for _ in 0..2 {
        h.drag_at(at);
        h.run_steps(1);
        h.drop_at(at);
        h.run_steps(1);
    }
    h.run_steps(3);
}

fn button(h: &H, label: &str) -> egui::Pos2 {
    h.query_all_by_label(label)
        .find(|n| n.accesskit_node().role() == egui::accesskit::Role::Button)
        .unwrap_or_else(|| panic!("a {label} button"))
        .rect()
        .center()
}

fn params(app: &PhotocraftApp) -> Value {
    crate::adjust_dialog::open_params(app).expect("an adjustment dialog is open")
}

fn adjustment(kind: &str, p: &Value) -> Adjustment {
    photocraft_engine::adjust_params::from_params(kind, p, None, ColorMode::Rgb).unwrap_or_else(|e| panic!("{kind} {p}: {e}"))
}

fn engine_auto(app: &mut PhotocraftApp, kind: &str, options: Value) -> Value {
    app.run("image.adjustments.auto", json!({"kind": kind, "options": options})).unwrap()
}

fn open(h: &mut H, kind: &str) -> DialogId {
    let id = crate::adjust_dialog::open(h.state_mut(), &format!("image.adjustments.{kind}")).unwrap();
    h.run_steps(4);
    id
}

#[test]
fn levels_auto_keeps_the_framework_rule_until_options_apply() {
    let mut h = dialog_harness(app_with_image());
    open(&mut h, "levels");
    let at = button(&h, "Auto");
    click(&mut h, at);
    // PhotoCraft's own Auto: the composite's 0.1 % ends, no channels.
    let framework = params(h.state());
    assert!(framework["inBlack"].as_f64().unwrap() > 50.0, "{framework}");
    assert!(framework.get("red").is_none_or(|r| r.get("inBlack").is_none_or(|v| v.as_f64() == Some(0.0))), "{framework}");
    // With options saved, Auto is Auto Color Correction Options': Per Channel Contrast here.
    h.state_mut().run("image.adjustments.autoOptions", json!({"saveAsDefaults": true})).unwrap();
    let id = crate::adjust_dialog::open_value(h.state()).unwrap().id;
    crate::adjust_dialog::apply_params(h.state_mut(), id, &json!({}));
    h.run_steps(2);
    click(&mut h, at);
    let want = engine_auto(h.state_mut(), "levels", json!({}));
    assert_eq!(adjustment("levels", &params(h.state())), adjustment("levels", &want));
    assert!(want["red"]["inBlack"].as_f64().unwrap() > 50.0, "{want}");
    // The document is untouched until OK.
    assert_eq!(h.state().session.active().unwrap().doc.layers.len(), 1);
}

#[test]
fn alt_click_on_levels_auto_opens_the_options_and_cancel_restores_the_fields() {
    let mut h = dialog_harness(app_with_image());
    let id = open(&mut h, "levels");
    crate::adjust_dialog::apply_params(h.state_mut(), id, &json!({"inBlack": 12, "gamma": 1.3}));
    h.run_steps(2);
    let before = adjustment("levels", &params(h.state()));
    let at = button(&h, "Auto");
    h.input_mut().modifiers = egui::Modifiers::ALT;
    click(&mut h, at);
    h.input_mut().modifiers = egui::Modifiers::NONE;
    h.run_steps(2);
    let options = open_id(h.state()).expect("Alt-click on Auto opens Auto Color Correction Options");
    assert!(h.query_all_by_label("Snap Neutral Midtones").next().is_some());
    // The dialog previews: Levels shows the options' Auto.
    let want = engine_auto(h.state_mut(), "levels", json!({}));
    assert_eq!(adjustment("levels", &params(h.state())), adjustment("levels", &want));
    // A change of algorithm previews again.
    h.state_mut().framework.dialogs.get_mut_by_id::<HostedParamDialog>(options).unwrap().set_field("algorithm", FieldValue::Text("monochromatic".into()));
    h.run_steps(3);
    let mono = engine_auto(h.state_mut(), "levels", json!({"algorithm": "monochromatic"}));
    assert_eq!(adjustment("levels", &params(h.state())), adjustment("levels", &mono));
    // Cancel: the Levels fields are back.
    crate::dialogs::testing::cancel(h.state_mut(), options).unwrap();
    h.run_steps(3);
    assert_eq!(adjustment("levels", &params(h.state())), before);
    assert!(open_id(h.state()).is_none());
    assert!(h.state().auto_options.session.is_none(), "Cancel keeps no options");
}

#[test]
fn options_ok_keeps_the_result_and_save_as_defaults_saves_them() {
    let mut h = dialog_harness(app_with_image());
    open(&mut h, "curves");
    let at = button(&h, "Options…");
    click(&mut h, at);
    let options = open_id(h.state()).expect("Options… opens the dialog");
    let dialog = h.state_mut().framework.dialogs.get_mut_by_id::<HostedParamDialog>(options).unwrap();
    dialog.set_field("algorithm", FieldValue::Text("darkLight".into()));
    dialog.set_field("shadowClip", FieldValue::Number(50.0));
    dialog.set_field("highlightColor", FieldValue::Color([0.9, 0.85, 0.8]));
    h.run_steps(3);
    crate::dialogs::testing::confirm(h.state_mut(), options).unwrap();
    h.run_steps(3);
    // Not saved: the options stay for this session (the clip clamped to 9.99).
    let session = h.state().auto_options.session.expect("session options");
    assert_eq!((session.algorithm, session.shadow_clip, session.highlight), (AutoAlgorithm::DarkLight, 9.99, [230, 217, 204]));
    assert!(!photocraft_engine::cmd::auto_options_cmds::saved(&h.state().session));
    let want = engine_auto(h.state_mut(), "curves", engine::options_json(&session));
    assert_eq!(adjustment("curves", &params(h.state())), adjustment("curves", &merged("curves", &json!({}), &want)));
    // Again, with Save as defaults.
    click(&mut h, at);
    let options = open_id(h.state()).unwrap();
    let dialog = h.state_mut().framework.dialogs.get_mut_by_id::<HostedParamDialog>(options).unwrap();
    dialog.set_field("algorithm", FieldValue::Text("perChannel".into()));
    dialog.set_field("saveAsDefaults", FieldValue::Bool(true));
    h.run_steps(2);
    crate::dialogs::testing::confirm(h.state_mut(), options).unwrap();
    assert!(photocraft_engine::cmd::auto_options_cmds::saved(&h.state().session));
    let saved = photocraft_engine::cmd::auto_options_cmds::current(&h.state().session);
    assert_eq!((saved.algorithm, saved.highlight), (AutoAlgorithm::PerChannel, [230, 217, 204]));
    assert!(h.state().auto_options.session.is_none());
}

#[test]
fn curves_auto_sets_the_end_points_at_the_clip() {
    let mut h = dialog_harness(app_with_image());
    open(&mut h, "curves");
    let at = button(&h, "Auto");
    click(&mut h, at);
    let got = params(h.state());
    let want = engine_auto(h.state_mut(), "curves", json!({}));
    assert_eq!(adjustment("curves", &got), adjustment("curves", &want), "{got}");
    // Per Channel Contrast: each channel's ends are its darkest and lightest values (the bands').
    let red = want["red"].as_array().unwrap();
    assert_eq!(red.first().unwrap()[0], json!(0x5a as f64));
    assert_eq!(red.last().unwrap()[0], json!(0x96 as f64));
    assert_eq!(h.state().session.active().unwrap().doc.layers.len(), 1, "the document is untouched until OK");
}

#[test]
fn brightness_contrast_auto_brightens_a_dark_image() {
    let mut h = dialog_harness(app_with_dark_image());
    open(&mut h, "brightnessContrast");
    let at = button(&h, "Auto");
    click(&mut h, at);
    let got = params(h.state());
    assert!(got["brightness"].as_f64().unwrap() > 20.0 && got["contrast"].as_f64().unwrap() > 0.0, "{got}");
    assert_eq!(got["legacy"], json!(false));
}

#[test]
fn double_clicking_the_white_eyedropper_picks_the_highlight_target() {
    let mut h = dialog_harness(app_with_image());
    let id = open(&mut h, "levels");
    let at = h.get_by_label("Set White Point").rect().center();
    double_click(&mut h, at);
    assert_eq!(crate::adjust_dialog::hosted(h.state(), id).unwrap().picker(), Some(TonePicker::White), "the picker stays armed");
    let picker = h.state().framework.dialogs.stack().top().unwrap();
    assert_ne!(picker, id, "the Color Picker opened over Levels");
    // The picker's answer becomes the highlight target, then the question.
    assert!(answer_target(h.state_mut(), "pigment.target.highlight", Srgba::from_rgb_array([0.94, 0.94, 0.9])));
    assert_eq!(targets(h.state()).highlight, [240.0 / 255.0, 240.0 / 255.0, 230.0 / 255.0]);
    let prompt = crate::dialogs::alerts::prompt_tagged::<SaveTargets>(h.state()).expect("Save the new target colors as defaults?");
    crate::dialogs::testing::confirm(h.state_mut(), prompt).unwrap();
    let saved = photocraft_engine::cmd::auto_options_cmds::current(&h.state().session);
    assert_eq!(saved.highlight, [240, 240, 230], "Yes saves the targets");
    // The white eyedropper now maps the sample to that target.
    let sample = crate::canvas::composite_color(h.state_mut(), 40.0, 10.0).unwrap();
    assert!(crate::adjust_dialog::pick(h.state_mut(), [40.0, 10.0]));
    let Adjustment::Levels { per_channel, .. } = adjustment("levels", &params(h.state())) else { panic!("levels") };
    assert!((per_channel[0].in_white - sample[0]).abs() < 0.01 && (per_channel[2].out_white - 230.0 / 255.0).abs() < 0.01, "{per_channel:?}");
}

#[test]
fn a_target_answered_no_stays_for_the_session() {
    let mut app = app_with_image();
    assert!(answer_target(&mut app, "pigment.target.shadow", Srgba::from_rgb_array([0.1, 0.1, 0.1])));
    let prompt = crate::dialogs::alerts::prompt_tagged::<SaveTargets>(&app).unwrap();
    crate::dialogs::testing::cancel(&mut app, prompt).unwrap();
    assert_eq!(app.auto_options.session.map(|o| o.shadow), Some([26, 26, 26]));
    assert!(!photocraft_engine::cmd::auto_options_cmds::saved(&app.session));
    // Properties' eyedropper carries them.
    let mut p = json!({"layer": 1, "eyedropper": {"point": "black", "at": [1, 1]}});
    with_targets(&app, &mut p);
    assert_eq!(p["eyedropper"]["targets"]["shadow"], json!("#1a1a1a"));
    assert!(!answer_target(&mut app, "blackWhite.tint", Srgba::from_rgb_array([0.0; 3])), "another well's colour is not ours");
}

#[test]
fn levels_auto_in_properties_is_one_history_step() {
    let mut h = Harness::builder().with_size(vec2(1440.0, 900.0)).with_max_steps(64).with_step_dt(1.0 / 60.0).build_eframe(|cc| {
        PhotocraftApp::setup_context(&cc.egui_ctx, Default::default());
        let mut s = photocraft_engine::Session::new();
        s.execute("file.new", json!({"width": 64, "height": 48})).unwrap();
        for (i, color) in ["#5a4a50", "#969098"].iter().enumerate() {
            s.execute("select.rect", json!({"x": i * 32, "y": 0, "width": 32, "height": 48})).unwrap();
            s.execute("edit.fill", json!({"color": color})).unwrap();
        }
        s.execute("select.deselect", json!({})).unwrap();
        s.execute("image.adjustments.autoOptions", json!({"saveAsDefaults": true})).unwrap();
        s.execute("layer.newAdjustmentLayer.levels", json!({})).unwrap();
        let mut app = PhotocraftApp::with_context(cc.egui_ctx.clone(), s, crate::Services::default());
        crate::panel_docking::apply(&mut app, vec![craft::behavior::dock::Action::resize_group("properties".to_owned(), Some(560.0))]).unwrap();
        app
    });
    h.run_steps(8);
    let steps = h.state().session.active().unwrap().history.past_len();
    let at = button(&h, "Auto");
    click(&mut h, at);
    let st = h.state().session.active().unwrap();
    assert_eq!(st.history.past_len(), steps + 1, "one history step");
    let id = st.active_layer.unwrap();
    let LayerContent::Adjustment(adj) = &st.doc.layer(id).unwrap().content else { panic!("an adjustment layer") };
    let adj = adj.clone();
    let want = h.state_mut().run("image.adjustments.auto", json!({"kind": "levels", "layer": id.0})).unwrap();
    assert_eq!(adj, adjustment("levels", &want));
    assert!(h.state().live_adjust.is_none());
}
