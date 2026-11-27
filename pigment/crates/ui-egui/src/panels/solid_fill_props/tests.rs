//! A Solid Color fill's swatch in Properties, by pointer: it opens the layer's Color Picker, OK changes the fill in
//! one history step and Cancel changes nothing.

use egui::vec2;
use egui_kittest::Harness;
use egui_kittest::kittest::{NodeT, Queryable};
use photocraft_doc::LayerId;

use super::*;
use crate::color_picker_ui::testing;

type H = Harness<'static, Box<PhotocraftApp>>;

/// Properties of the active layer and the dialogs, as the window draws them.
fn harness() -> (H, LayerId) {
    let mut s = photocraft_engine::Session::new();
    s.execute("file.new", json!({"width": 32, "height": 24})).unwrap();
    let id = LayerId(s.execute("layer.newFillLayer.solidColor", json!({"color": "#336699"})).unwrap()["layer"].as_u64().unwrap());
    let app = PhotocraftApp::new(s, crate::Services::default());
    let h = Harness::builder().with_context(app.ctx().clone()).with_size(vec2(1200.0, 900.0)).with_step_dt(1.0 / 60.0).build_ui_state(
        |ui, app: &mut Box<PhotocraftApp>| {
            let layer = app.session.active().and_then(|st| st.doc.layer(st.active_layer?)).cloned();
            ui.allocate_ui(vec2(300.0, 860.0), |ui| {
                if let Some(layer) = layer {
                    crate::layer_props_ui::properties(app, ui, &layer);
                }
            });
            crate::dialogs::run(app, ui);
        },
        app,
    );
    PhotocraftApp::setup_context(&h.ctx, crate::theme::AppTheme::pro());
    (h, id)
}

fn fill(app: &PhotocraftApp, id: LayerId) -> String {
    match &app.session.active().unwrap().doc.layer(id).unwrap().content {
        LayerContent::Fill(Fill::Solid(c)) => crate::color_picker_ui::rgb_hex(Srgba::from_rgb_array(c.to_rgb())),
        _ => panic!("not a solid fill"),
    }
}

/// Clicks the fill's swatch and returns the picker that opened.
fn open_picker(h: &mut H) -> craft::ui::dialog::DialogId {
    let swatch =
        h.query_all_by_role(egui::accesskit::Role::ColorWell).find(|n| n.accesskit_node().label().as_deref() == Some("Color")).expect("the fill's swatch");
    assert_eq!(swatch.value().as_deref(), Some("#336699"), "it shows the fill's colour");
    swatch.click();
    h.run_steps(4);
    let picker = h.state().framework.dialogs.stack().top().expect("the Color Picker opened");
    assert!(h.state().framework.dialogs.get_by_id::<craft::color_ui::ui::ColorPickerDialog>(picker).is_some());
    picker
}

#[test]
fn the_swatch_opens_the_picker_and_ok_is_one_history_step() {
    let (mut h, id) = harness();
    h.run_steps(3);
    let before = h.state().session.active().unwrap().history.past_len();
    let picker = open_picker(&mut h);
    testing::set_color(h.state_mut(), picker, "#ff8800");
    h.run_steps(3);
    assert_eq!(fill(h.state(), id), "#336699", "the document waits for OK");
    let shown = h.query_all_by_role(egui::accesskit::Role::ColorWell).find(|n| n.accesskit_node().label().as_deref() == Some("Color")).and_then(|n| n.value());
    assert_eq!(shown.as_deref(), Some("#ff8800"), "the swatch follows the live preview");
    crate::dialogs::testing::confirm(h.state_mut(), picker).unwrap();
    h.run_steps(3);
    assert_eq!(fill(h.state(), id), "#ff8800");
    let st = h.state().session.active().unwrap();
    assert_eq!(st.history.past_len(), before + 1, "one history step");
    h.state_mut().run("edit.undo", json!({})).unwrap();
    assert_eq!(fill(h.state(), id), "#336699", "one undo restores it");
}

#[test]
fn cancel_changes_nothing() {
    let (mut h, id) = harness();
    h.run_steps(3);
    let before = h.state().session.active().unwrap().history.past_len();
    let picker = open_picker(&mut h);
    testing::set_color(h.state_mut(), picker, "#00ff00");
    h.run_steps(2);
    crate::dialogs::testing::cancel(h.state_mut(), picker).unwrap();
    h.run_steps(3);
    assert_eq!(fill(h.state(), id), "#336699");
    assert_eq!(h.state().session.active().unwrap().history.past_len(), before);
}

#[test]
fn other_layers_have_no_fill_swatch() {
    let (mut h, _) = harness();
    h.state_mut().run("layer.new.layer", json!({})).unwrap();
    h.run_steps(3);
    assert!(h.query_all_by_role(egui::accesskit::Role::ColorWell).all(|n| n.accesskit_node().label().as_deref() != Some("Color")));
}
