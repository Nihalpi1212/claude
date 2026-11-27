//! Color and Vibrance, Clarity and Dehaze and Grain through the interface: the Image › Adjustments
//! dialogs (OK is one history step), the Properties editor by pointer, the Adjustments panel's
//! three buttons and the menus.

use craft::behavior::dock::Action;
use egui::accesskit::Role;
use egui::{Pos2, vec2};
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;
use photocraft_doc::{Adjustment, LayerContent};
use serde_json::json;

use crate::PhotocraftApp;

fn app_with_image() -> Box<PhotocraftApp> {
    let mut s = photocraft_engine::Session::new();
    s.execute("file.new", json!({"width": 64, "height": 48})).unwrap();
    s.execute("select.rect", json!({"x": 0, "y": 0, "width": 32, "height": 48})).unwrap();
    s.execute("edit.fill", json!({"color": "#6a3020"})).unwrap();
    s.execute("select.deselect", json!({})).unwrap();
    PhotocraftApp::new(s, crate::Services::default())
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

fn history(app: &PhotocraftApp) -> usize {
    app.session.active().unwrap().history.past_len()
}

fn pixels(app: &PhotocraftApp) -> Vec<f32> {
    let st = app.session.active().unwrap();
    st.doc.layers[0].surface().unwrap().read_region(photocraft_geom::Rect::new(0, 0, 64, 48))
}

/// Each dialog shows its rows, takes settings and applies them on OK in one history step.
#[test]
fn the_dialogs_show_their_rows_and_ok_is_one_step() {
    for (kind, rows, params) in [
        ("colorVibrance", &["Temperature", "Tint", "Vibrance", "Saturation"][..], json!({"temperature": 60, "vibrance": 30})),
        ("clarityDehaze", &["Clarity", "Dehaze"][..], json!({"clarity": 80, "dehaze": 40})),
        ("grain", &["Amount", "Size", "Roughness", "Seed"][..], json!({"amount": 70, "size": 0, "seed": 9})),
    ] {
        let mut h = dialog_harness(app_with_image());
        let before = (history(h.state()), pixels(h.state()));
        let id = crate::adjust_dialog::open(h.state_mut(), &format!("image.adjustments.{kind}")).unwrap();
        h.run_steps(4);
        for row in rows {
            assert!(h.query_all_by_label(row).next().is_some(), "{kind}: the {row} row");
        }
        assert!(crate::adjust_dialog::apply_params(h.state_mut(), id, &params), "{kind}: the dialog takes the settings");
        h.run_steps(3);
        let shown = crate::adjust_dialog::command_params(h.state(), id);
        for (key, v) in params.as_object().unwrap() {
            assert_eq!(shown[key].as_f64(), v.as_f64(), "{kind}: {key}");
        }
        assert_eq!(pixels(h.state()), before.1, "{kind}: the document is untouched before OK");
        crate::dialogs::testing::confirm(h.state_mut(), id).unwrap();
        h.run_steps(3);
        assert_eq!(history(h.state()), before.0 + 1, "{kind}: one history step");
        assert_ne!(pixels(h.state()), before.1, "{kind}: OK changed the pixels");
    }
}

/// The whole app with a `kind` adjustment layer, Properties sized to show its editor.
fn app_harness(kind: &str, mode: &str, depth: u32) -> Harness<'static, Box<PhotocraftApp>> {
    let (kind, mode) = (kind.to_string(), mode.to_string());
    let mut h = Harness::builder().with_size(vec2(1440.0, 900.0)).with_max_steps(64).with_step_dt(1.0 / 60.0).build_eframe(move |cc| {
        PhotocraftApp::setup_context(&cc.egui_ctx, Default::default());
        let mut s = photocraft_engine::Session::new();
        s.execute("file.new", json!({"width": 96, "height": 64, "mode": mode, "depth": depth})).unwrap();
        s.execute(&format!("layer.newAdjustmentLayer.{kind}"), json!({})).unwrap();
        let mut app = PhotocraftApp::with_context(cc.egui_ctx.clone(), s, crate::Services::default());
        crate::panel_docking::apply(&mut app, vec![Action::resize_group("properties".to_owned(), Some(560.0))]).unwrap();
        app
    });
    let ctx = h.ctx.clone();
    let (request, _) = crate::control::ControlRequest::new("ui.set", json!({"dock": {"collapsed": ["color"]}}));
    crate::control::handle(h.state_mut(), &ctx, &request);
    h.run_steps(8);
    h
}

fn layer(h: &Harness<'_, Box<PhotocraftApp>>) -> Adjustment {
    let st = h.state().session.active().unwrap();
    match &st.doc.layer(st.active_layer.unwrap()).unwrap().content {
        LayerContent::Adjustment(a) => a.clone(),
        other => panic!("{}", other.kind_name()),
    }
}

fn drag(h: &mut Harness<'_, Box<PhotocraftApp>>, from: Pos2, to: Pos2) {
    h.hover_at(from);
    h.run_steps(1);
    h.drag_at(from);
    h.run_steps(1);
    for i in 1..=3 {
        h.hover_at(from + (to - from) * (i as f32 / 3.0));
        h.run_steps(1);
    }
    h.drop_at(to);
    h.run_steps(3);
}

/// Each kind's Properties editor takes a slider drag as one history step, in RGB 8 and 32 bits and in
/// CMYK and Lab documents.
#[test]
fn properties_edits_each_kind_in_one_step() {
    for (mode, depth) in [("rgb", 8), ("rgb", 32), ("cmyk", 8), ("lab", 16)] {
        for kind in super::KINDS {
            let mut h = app_harness(kind, mode, depth);
            let before = layer(&h);
            let steps = history(h.state());
            let mut sliders: Vec<egui::Rect> = h.query_all_by_role(Role::Slider).map(|n| n.rect()).collect();
            sliders.sort_by(|a, b| a.top().total_cmp(&b.top()));
            let r = *sliders.first().unwrap_or_else(|| panic!("{kind} {mode}: no slider"));
            drag(&mut h, r.center(), r.center() + vec2(r.width() * 0.3, 0.0));
            h.run_steps(4);
            assert_ne!(layer(&h), before, "{kind} {mode}@{depth}: the edit reached the layer");
            assert_eq!(history(h.state()), steps + 1, "{kind} {mode}: one history step");
            assert!(h.state().live_adjust.is_none(), "{kind} {mode}: the preview ended");
        }
    }
}

/// Image › Adjustments lists them after Selective Color…, Layer › New Adjustment Layer after Color
/// Lookup…, in this order.
#[test]
fn the_menus_place_them_after_selective_color_and_color_lookup() {
    let app = app_with_image();
    let rows = crate::menus::base_rows(&app);
    let order = |path: &str| -> Vec<String> { rows.iter().filter(|r| r.path.join(" › ") == path).map(|r| r.command.id.to_string()).collect() };
    let image = order("Image › Adjustments");
    let at = image.iter().position(|id| id == "image.adjustments.selectiveColor").unwrap();
    assert_eq!(image[at + 1..at + 4], ["image.adjustments.colorVibrance", "image.adjustments.clarityDehaze", "image.adjustments.grain"]);
    let layer = order("Layer › New Adjustment Layer");
    let at = layer.iter().position(|id| id == "layer.newAdjustmentLayer.colorLookup").unwrap();
    assert_eq!(layer[at + 1..at + 4], ["layer.newAdjustmentLayer.colorVibrance", "layer.newAdjustmentLayer.clarityDehaze", "layer.newAdjustmentLayer.grain"]);
}

/// The dialog's live preview of Clarity and Dehaze (the adjustment clipped to the target) is the
/// command's result on an unmasked target. On a masked one the clipping base's alpha (its mask
/// included, as in Photoshop) weights the blur, so the two differ near the mask (the upstream
/// preview-vs-command tests leave the kind out for that).
#[test]
fn clarity_dehaze_previews_like_the_command() {
    use photocraft_color::{ColorMode, SampleType};
    for selection in [false, true] {
        let (mut doc, target) = crate::dialogs::adjust_preview::tests::document(ColorMode::Rgb, SampleType::U8, selection);
        doc.layer_mut(target).unwrap().mask = None;
        let p = json!({"clarity": 60, "dehaze": 30});
        let want = crate::dialogs::adjust_preview::tests::destructive(&doc, target, "clarityDehaze", &p).unwrap();
        let got = crate::adjust_preview::preview_document(&doc, target, "clarityDehaze", &p).unwrap();
        let d = crate::dialogs::adjust_preview::tests::max_diff(&got, &want);
        assert!(d <= 1.0 / 255.0 + 1e-4, "selection {selection}: {:.2}/255", d * 255.0);
    }
}
