//! Pigment (U3, #1301): the pen's barrel rotation turns the brush tip, through the whole platform
//! path minus the OS: raw AppKit values → the crate's mapping → this module's sink → the stylus
//! feed → window pointer input on the whole app → `paint.stroke` → the brush engine's angle
//! (Shape Dynamics › Angle Jitter › Control: Rotation) → pixels.

use super::*;
use photocraft_tablet::{Update, appkit};
use photocraft_ui_egui::PhotocraftApp;
use photocraft_ui_egui::state::Tool;
use serde_json::{Value, json};

/// Taps the pen once at the middle of a white 240×80 document with a 40 px, 4:1 elliptical tip
/// whose angle follows the pen's rotation, the pen turned `rotation`° as AppKit reports it. Returns
/// the darkness 9 px along each screen diagonal of the dab: (down-right, up-right).
fn tap(rotation: f32, brush_projection: bool) -> (f64, f64) {
    use egui_kittest::Harness;
    let mut session = photocraft_engine::Session::new();
    session.execute("file.new", json!({"width": 240, "height": 80, "background": "white"})).unwrap();
    let mut h = Harness::builder().with_size(egui::vec2(1280.0, 800.0)).with_max_steps(64).build_eframe(move |cc| {
        PhotocraftApp::setup_context(&cc.egui_ctx, Default::default());
        PhotocraftApp::with_context(cc.egui_ctx.clone(), session, Default::default())
    });
    let sink = sink(h.state().stylus.feed.clone());
    h.state_mut().sync_views();
    h.run_steps(4);
    h.state_mut().ui.tool = Tool::Brush;
    h.run_steps(2);
    h.state_mut().session.execute("tools.setColors", json!({"foreground": [0.0, 0.0, 0.0, 1.0]})).unwrap();
    let angle = if brush_projection { json!({}) } else { json!({"control": "rotation"}) };
    let brush = json!({"size": 40, "roundness": 0.25, "hardness": 1.0, "pressureSize": false, "pressureOpacity": false, "smoothing": {"amount": 0},
        "shapeDynamics": {"enabled": true, "angle": angle, "brushProjection": brush_projection}});
    h.state_mut().session.execute("tools.setBrush", json!({ "brush": brush })).unwrap();
    {
        let v = &mut h.state_mut().ui.views[0];
        v.zoom = 1.0;
        v.center = [120.0, 40.0];
        v.clear_pending();
    }
    h.run_steps(2);
    let mut st = appkit::State::default();
    let e = appkit::RawEvent {
        kind: appkit::event_type::LEFT_MOUSE_DRAGGED,
        subtype: appkit::subtype::TABLET_POINT,
        pressure: 1.0,
        rotation,
        ..Default::default()
    };
    if let Update::Set(s) = st.handle(&e) {
        sink(s);
    }
    let p = h.state().last_canvas_rect.center();
    h.event(egui::Event::PointerMoved(p));
    h.run_steps(1);
    h.event(egui::Event::PointerButton { pos: p, button: egui::PointerButton::Primary, pressed: true, modifiers: egui::Modifiers::NONE });
    h.run_steps(1);
    h.event(egui::Event::PointerButton { pos: p, button: egui::PointerButton::Primary, pressed: false, modifiers: egui::Modifiers::NONE });
    h.run_steps(3);
    sink(None);
    let app = h.state_mut();
    let committed = app.session.journal.iter().rev().find(|(id, _)| id == "paint.stroke").map(|(_, p)| p.clone()).expect("the tap committed a stroke");
    let first = committed["points"][0].as_array().cloned().unwrap_or_default();
    assert!(
        first.get(5).and_then(Value::as_f64).is_some_and(|r| (r - f64::from(rotation)).abs() < 0.01 || rotation == 0.0),
        "the stroke carries the rotation: {first:?}"
    );
    let mut dark = |x: i32, y: i32| -> f64 {
        let px: Value = app.session.execute("document.pixel", json!({"x": x, "y": y})).unwrap();
        1.0 - px[0].as_f64().unwrap()
    };
    (dark(129, 49), dark(129, 31))
}

#[test]
fn the_pens_rotation_turns_the_tip_the_way_the_pen_turns() {
    for projection in [false, true] {
        // y grows downwards: a tip turned 45° clockwise lies along the down-right diagonal.
        let (down_right, up_right) = tap(45.0, projection);
        assert!(down_right > 0.9 && up_right < 0.1, "projection {projection}: 45° clockwise: down-right {down_right}, up-right {up_right}");
        let (down_right, up_right) = tap(315.0, projection);
        assert!(up_right > 0.9 && down_right < 0.1, "projection {projection}: 45° anticlockwise: down-right {down_right}, up-right {up_right}");
    }
    // Unturned: along x, on neither diagonal.
    let (down_right, up_right) = tap(0.0, false);
    assert!(down_right < 0.1 && up_right < 0.1, "{down_right} / {up_right}");
}
