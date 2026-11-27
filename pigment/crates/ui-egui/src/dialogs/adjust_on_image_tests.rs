//! Pigment's on-image tools and eyedroppers through the whole app (eframe harness, CPU canvas) with real pointer
//! input: the tool's toggle is clicked, then the image is pressed and dragged on the canvas.

use craft::behavior::dock::Action;
use egui::{Pos2, vec2};
use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;
use photocraft_doc::{Adjustment, LayerContent};
use serde_json::{Value, json};

use super::{OnImageTool, RangeDropper};
use crate::PhotocraftApp;

/// The left half's colour: hue 13°, a red; luma 59.
const LEFT: &str = "#6a3020";
/// The right half's colour: hue 70°, between the yellows and the greens.
const RIGHT: [f32; 3] = [0.8333, 1.0, 0.0];

type H = Harness<'static, Box<PhotocraftApp>>;

/// The app on a 96×64 document (left half [`LEFT`], right half [`RIGHT`]), with `kind`'s adjustment layer when given.
fn harness(layer: Option<&str>, fill: Option<[f32; 3]>) -> H {
    let layer = layer.map(str::to_owned);
    let mut h = Harness::builder().with_size(vec2(1440.0, 900.0)).with_max_steps(64).with_step_dt(1.0 / 60.0).build_eframe(move |cc| {
        PhotocraftApp::setup_context(&cc.egui_ctx, Default::default());
        let mut s = photocraft_engine::Session::new();
        s.execute("file.new", json!({"width": 96, "height": 64})).unwrap();
        match fill {
            Some(color) => {
                s.execute("edit.fill", json!({ "color": color })).unwrap();
            }
            None => {
                s.execute("edit.fill", json!({ "color": RIGHT })).unwrap();
                s.execute("select.rect", json!({"x": 0, "y": 0, "width": 48, "height": 64})).unwrap();
                s.execute("edit.fill", json!({ "color": LEFT })).unwrap();
                s.execute("select.deselect", json!({})).unwrap();
            }
        }
        if let Some(kind) = &layer {
            s.execute(&format!("layer.newAdjustmentLayer.{kind}"), json!({})).unwrap();
        }
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

/// The screen point of document point (x, y).
fn screen(h: &H, x: f64, y: f64) -> Pos2 {
    let view = crate::canvas::testing::view(h.state()).expect("the canvas has a view");
    view.to_screen(craft::behavior::kurbo::Point::new(x, y))
}

/// Pans the view so document point `at` shows in the strip at the canvas's left edge, clear of the dialog that opens
/// centred over the canvas (as `canvas::testing::clear_of_dialogs`), and returns its screen point.
fn bring(h: &mut H, at: [f64; 2]) -> Pos2 {
    let view = crate::canvas::testing::view(h.state()).expect("the canvas has a view");
    let here = view.to_screen(craft::behavior::kurbo::Point::new(at[0], at[1]));
    let goal = Pos2::new(view.rect.left() + 60.0, view.rect.center().y);
    let moved = view.to_doc(goal) - view.to_doc(here);
    let app = h.state_mut();
    if let Some(i) = app.session.active_index().filter(|i| *i < app.ui.views.len()) {
        let v = &mut app.ui.views[i];
        v.center = [v.center[0] - moved.x as f32, v.center[1] - moved.y as f32];
        v.clear_pending();
    }
    h.run_steps(8);
    screen(h, at[0], at[1])
}

fn drag(h: &mut H, from: Pos2, to: Pos2) {
    h.hover_at(from);
    h.run_steps(1);
    h.drag_at(from);
    h.run_steps(1);
    for i in 1..=4 {
        h.hover_at(from + (to - from) * (i as f32 / 4.0));
        h.run_steps(1);
    }
    h.drop_at(to);
    h.run_steps(3);
}

fn click(h: &mut H, at: Pos2) {
    drag(h, at, at);
}

/// Clicks the toggle labelled `label` (the last one: the dialog's over the Properties panel's).
fn toggle(h: &mut H, label: &str) {
    h.query_all_by_label(label).last().unwrap_or_else(|| panic!("no control labelled {label:?}")).scroll_to_me();
    h.run_steps(4);
    let at = h.query_all_by_label(label).last().unwrap_or_else(|| panic!("no control labelled {label:?}")).rect().center();
    click(h, at);
}

fn history_len(h: &H) -> usize {
    h.state().session.active().unwrap().history.past_len()
}

fn top_adjustment(h: &H) -> Adjustment {
    let st = h.state().session.active().unwrap();
    match &st.doc.layers.last().unwrap().content {
        LayerContent::Adjustment(adj) => adj.clone(),
        other => panic!("not an adjustment layer: {other:?}"),
    }
}

/// Opens the Image › Adjustments dialog of `kind`.
fn open_dialog(h: &mut H, kind: &str) -> craft::ui::dialog::DialogId {
    let id = crate::adjust_dialog::open(h.state_mut(), &format!("image.adjustments.{kind}")).expect("the dialog opens");
    h.run_steps(6);
    id
}

fn dialog_params(h: &H) -> Value {
    crate::adjust_dialog::open_params(h.state()).expect("the dialog is open")
}

fn ok(h: &mut H, id: craft::ui::dialog::DialogId) {
    let ctx = h.ctx.clone();
    crate::dialogs::confirm(h.state_mut(), &ctx, id).expect("OK runs the command");
    h.run_steps(4);
}

fn points(p: &Value, key: &str) -> Vec<[f64; 2]> {
    serde_json::from_value(p[key].clone()).unwrap_or_default()
}

/// Row 12: with the hand armed in the Curves dialog, a press on the image adds a point at its luma and an upward drag
/// raises it, one level per two pixels; the document is untouched until OK, which is one history step.
#[test]
fn the_curves_hand_adds_and_drags_a_point_in_the_dialog() {
    let mut h = harness(None, None);
    let steps = history_len(&h);
    let id = open_dialog(&mut h, "curves");
    toggle(&mut h, "Click and drag in image to modify the curve");
    assert_eq!(crate::dialogs::canvas_input::armed(h.state()), Some(crate::dialogs::canvas_input::DialogPick::OnImage(OnImageTool::Hand)));
    let from = bring(&mut h, [10.0, 32.0]);
    drag(&mut h, from, from - vec2(0.0, 40.0));
    let shown = points(&dialog_params(&h), "points");
    assert_eq!(shown.len(), 3, "{shown:?}");
    assert_eq!(shown[1], [59.0, 79.0], "the point at the red's luma, 40 px up = 20 levels");
    assert_eq!(history_len(&h), steps, "nothing applied before OK");
    // A second drag on the same tone moves that point, from where it is.
    drag(&mut h, from, from + vec2(0.0, 20.0));
    assert_eq!(points(&dialog_params(&h), "points")[1], [59.0, 69.0]);
    ok(&mut h, id);
    assert_eq!(history_len(&h), steps + 1, "OK is one history step");
    let px: Vec<f32> = serde_json::from_value(h.state_mut().run("document.pixel", json!({"x": 10, "y": 10})).unwrap()).unwrap();
    assert!(px[0] > 106.0 / 255.0 + 0.02, "the curve lifted the red: {px:?}");
}

/// Rows 3 and 13: the Hue/Saturation dialog's Eyedropper picks the range of the colour under it (and shows it), Add to
/// Sample widens it to another colour, and the hand drags that range's saturation.
#[test]
fn hue_saturation_range_eyedroppers_and_hand_in_the_dialog() {
    let mut h = harness(None, None);
    let id = open_dialog(&mut h, "hueSaturation");
    toggle(&mut h, "Eyedropper");
    let left = bring(&mut h, [10.0, 32.0]);
    assert_eq!(crate::dialogs::canvas_input::armed(h.state()), Some(crate::dialogs::canvas_input::DialogPick::OnImage(OnImageTool::Range(RangeDropper::Pick))));
    click(&mut h, left);
    let shown_range = |h: &H| crate::adjust_dialog::open_value(h.state()).and_then(|open| open.setup.lock().ok().and_then(|s| s.on_image.range()));
    assert_eq!(shown_range(&h), Some(0), "the reds are shown");
    let reds: [f64; 4] = serde_json::from_value(dialog_params(&h)["reds"]["range"].clone()).unwrap();
    assert_eq!(reds, [-32.0, -2.0, 28.0, 58.0], "centred on the sample's 13°");
    toggle(&mut h, "Add to Sample");
    let right = bring(&mut h, [80.0, 32.0]);
    click(&mut h, right);
    let p = dialog_params(&h);
    let adj = photocraft_engine::adjust_params::from_params("hueSaturation", &p, None, photocraft_doc::ColorMode::Rgb).unwrap();
    let Adjustment::HueSaturation { ranges, .. } = adj else { panic!() };
    assert_eq!(ranges[0].weight(70.0), 1.0, "the reds take 70° at full effect: {:?}", ranges[0].bounds);
    // The hand on the red drags the reds' saturation (40 px right = +20).
    toggle(&mut h, "Click and drag in image to modify saturation. Ctrl-click and drag to modify hue.");
    let left = bring(&mut h, [10.0, 32.0]);
    drag(&mut h, left, left + vec2(40.0, 0.0));
    assert_eq!(dialog_params(&h)["reds"]["saturation"], 20.0);
    assert_eq!(shown_range(&h), Some(0));
    let steps = history_len(&h);
    ok(&mut h, id);
    assert_eq!(history_len(&h), steps + 1);
}

/// Row 7: Exposure's gray eyedropper on a grey of 0.09 linear light gives +1 stop, through the dialog.
#[test]
fn the_exposure_gray_eyedropper_gives_one_stop() {
    let grey = photocraft_compose::adjust::Transfer::Gamma(2.2).encode(0.09);
    let mut h = harness(None, Some([grey; 3]));
    let id = open_dialog(&mut h, "exposure");
    toggle(&mut h, "Sample in image to set gray point");
    let at = bring(&mut h, [20.0, 32.0]);
    click(&mut h, at);
    let exposure = dialog_params(&h)["exposure"].as_f64().unwrap();
    assert!((exposure - 1.0).abs() < 0.03, "{exposure}");
    // White: the grey becomes white; black: the offset takes it to black.
    toggle(&mut h, "Sample in image to set white point");
    click(&mut h, at);
    let exposure = dialog_params(&h)["exposure"].as_f64().unwrap();
    assert!((exposure - (1.0f64 / 0.09).log2()).abs() < 0.05, "{exposure}");
    let steps = history_len(&h);
    ok(&mut h, id);
    assert_eq!(history_len(&h), steps + 1);
}

/// Rows 4, 12 and 7 in Properties: the hand on a Curves and a Black & White layer, and Exposure's eyedropper, each
/// gesture one `layer.setAdjustment` (one history step), sampled below the layer.
#[test]
fn properties_hand_and_exposure_eyedropper_commit_once() {
    // Curves: a point at the red's luma, 40 px up.
    let mut h = harness(Some("curves"), None);
    let steps = history_len(&h);
    toggle(&mut h, "Click and drag in image to modify the curve");
    assert!(super::armed_properties(h.state()).is_some(), "armed from the Properties panel");
    let from = screen(&h, 10.0, 10.0);
    drag(&mut h, from, from - vec2(0.0, 40.0));
    assert_eq!(history_len(&h), steps + 1, "one history step for the gesture");
    let Adjustment::Curves { master, .. } = top_adjustment(&h) else { panic!() };
    let levels: Vec<[f32; 2]> = master.iter().map(|p| [(p.input * 255.0).round(), (p.output * 255.0).round()]).collect();
    assert_eq!(levels, vec![[0.0, 0.0], [59.0, 79.0], [255.0, 255.0]]);
    assert!(h.state().live_adjust.is_none(), "the preview ends with the commit");
    // Another tool puts it away.
    h.state_mut().ui.tool = crate::state::Tool::Brush;
    h.run_steps(3);
    assert!(super::armed_properties(h.state()).is_none());

    // Black & White: the right half (70°, nearest the yellows at 60°) drags the yellows slider.
    let mut h = harness(Some("blackWhite"), None);
    let steps = history_len(&h);
    toggle(&mut h, "Click and drag in image to modify a slider");
    let right = screen(&h, 80.0, 10.0);
    drag(&mut h, right, right + vec2(40.0, 0.0));
    assert_eq!(history_len(&h), steps + 1);
    let Adjustment::BlackWhite { weights, .. } = top_adjustment(&h) else { panic!() };
    assert_eq!(weights[1], 80.0, "yellows 60 + 20");

    // Exposure: the gray eyedropper, one step.
    let grey = photocraft_compose::adjust::Transfer::Gamma(2.2).encode(0.09);
    let mut h = harness(Some("exposure"), Some([grey; 3]));
    let steps = history_len(&h);
    toggle(&mut h, "Sample in image to set gray point");
    assert!(crate::layer_picker::armed(h.state()).is_some(), "Exposure's eyedropper arms the Properties picker");
    let at = screen(&h, 20.0, 20.0);
    click(&mut h, at);
    assert_eq!(history_len(&h), steps + 1);
    let Adjustment::Exposure { exposure, .. } = top_adjustment(&h) else { panic!() };
    assert!((exposure - 1.0).abs() < 0.03, "{exposure}");
}
