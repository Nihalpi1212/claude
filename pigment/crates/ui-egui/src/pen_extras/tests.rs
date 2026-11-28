//! Pigment (U3): Windows Ink's tilt and rotation and the stylus wheel reach `paint.stroke`.

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use super::*;
use crate::canvas::{ToolEvent, tool_event};
use crate::state::Tool;
use crate::stylus::Stylus;

const M: egui::Modifiers = egui::Modifiers::NONE;

#[test]
fn merge_adds_the_platform_pose_only_to_a_reading_without_one() {
    let touch = PenSample { pressure: 0.4, ..Default::default() };
    let ink = PenExtras { pose: Some([30.0, -10.0, 45.0]), wheel: None };
    assert_eq!(merge(touch, &ink), PenSample { pressure: 0.4, tilt_x: 30.0, tilt_y: -10.0, rotation: 45.0, eraser: false }, "winit's pressure stays");
    let tilted = PenSample { pressure: 0.4, tilt_x: 5.0, ..Default::default() };
    assert_eq!(merge(tilted, &ink), tilted, "a reading with its own tilt (macOS, X11, WinTab, the web) keeps it");
    assert_eq!(merge(touch, &PenExtras::default()), touch);
    let wild = PenExtras { pose: Some([400.0, f32::NAN, -90.0]), wheel: None };
    assert_eq!(merge(touch, &wild), PenSample { pressure: 0.4, tilt_x: 90.0, tilt_y: 0.0, rotation: 270.0, eraser: false });
}

#[test]
fn the_wheel_is_full_for_a_mouse_and_without_one() {
    let mut s = PenState { extras: PenExtras { pose: None, wheel: Some(0.3) }, wheels: Vec::new() };
    assert_eq!((s.wheel_now(true), s.wheel_now(false)), (0.3, 1.0));
    s.extras.wheel = Some(f32::NAN);
    assert_eq!(s.wheel_now(true), 1.0);
    s.extras.wheel = Some(7.0);
    assert_eq!(s.wheel_now(true), 1.0);
    s.extras.wheel = None;
    assert_eq!(s.wheel_now(true), 1.0);
    assert!(!s.has_wheel() && s.wheel_at(3) == 1.0);
    s.wheels = vec![1.0, 0.5];
    assert!(s.has_wheel());
    assert_eq!((s.wheel_at(0), s.wheel_at(1), s.wheel_at(9)), (1.0, 0.5, 0.5));
}

/// An app whose platform reports `extras` through the service, as the desktop app's does.
fn app_with(extras: &Arc<Mutex<PenExtras>>) -> Box<crate::PhotocraftApp> {
    let mut app = crate::PhotocraftApp::new(photocraft_engine::Session::new(), Default::default());
    app.session.execute("file.new", json!({"width": 120, "height": 80})).unwrap();
    app.session.execute("layer.new.layer", json!({})).unwrap();
    app.ui.tool = Tool::Brush;
    let shared = Arc::clone(extras);
    app.services.pen_extras = Some(Box::new(move || *shared.lock().unwrap_or_else(std::sync::PoisonError::into_inner)));
    app
}

fn last_stroke(app: &crate::PhotocraftApp) -> Value {
    app.session.journal.iter().rev().find(|(id, _)| id == "paint.stroke").cloned().expect("a stroke").1
}

fn column(p: &Value, point: usize) -> Vec<f64> {
    p["points"][point].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect()
}

/// Windows Ink: the feed carries pressure only (the framework's touch reading); the pointer hooks'
/// tilt and rotation come through the service and land in the stroke's points.
#[test]
fn windows_ink_tilt_and_rotation_reach_the_stroke() {
    let extras = Arc::new(Mutex::new(PenExtras { pose: Some([30.0, -10.0, 45.0]), wheel: None }));
    let mut app = app_with(&extras);
    tool_event(&mut app, ToolEvent::Down { x: 10.0, y: 40.0, pressure: 0.5 }, M);
    *extras.lock().unwrap() = PenExtras { pose: Some([20.0, 5.0, 90.0]), wheel: None };
    tool_event(&mut app, ToolEvent::Move { x: 100.0, y: 40.0, pressure: 0.8 }, M);
    tool_event(&mut app, ToolEvent::Up { x: 100.0, y: 40.0 }, M);
    let p = last_stroke(&app);
    let (a, b) = (column(&p, 0), column(&p, 1));
    assert_eq!(a.len(), 7, "no wheel column without a wheel: {a:?}");
    let near = |got: &[f64], want: [f64; 4]| got.iter().zip(want).all(|(g, w)| (g - w).abs() < 1e-3);
    assert!(near(&a[2..6], [0.5, 30.0, -10.0, 45.0]), "{a:?}");
    assert!(near(&b[2..6], [0.8, 20.0, 5.0, 90.0]), "{b:?}");
    // The pen leaving (the hooks clear the reading): a mouse stroke paints upright.
    *extras.lock().unwrap() = PenExtras::default();
    tool_event(&mut app, ToolEvent::Down { x: 10.0, y: 60.0, pressure: 1.0 }, M);
    tool_event(&mut app, ToolEvent::Up { x: 90.0, y: 60.0 }, M);
    let a = column(&last_stroke(&app), 0);
    assert!(a.iter().skip(3).take(3).all(|v| *v == 0.0), "{a:?}");
}

/// The stylus wheel (macOS, WinTab) is each point's 8th column, and the engine paints with it.
#[test]
fn the_stylus_wheel_is_the_strokes_eighth_column() {
    let extras = Arc::new(Mutex::new(PenExtras { pose: None, wheel: Some(0.25) }));
    let mut app = app_with(&extras);
    app.stylus.feed.set(Some(PenSample { pressure: 0.6, tilt_x: 10.0, ..Default::default() }));
    tool_event(&mut app, ToolEvent::Down { x: 10.0, y: 40.0, pressure: 0.6 }, M);
    *extras.lock().unwrap() = PenExtras { pose: None, wheel: Some(0.75) };
    tool_event(&mut app, ToolEvent::Move { x: 100.0, y: 40.0, pressure: 0.6 }, M);
    tool_event(&mut app, ToolEvent::Up { x: 100.0, y: 40.0 }, M);
    let p = last_stroke(&app);
    let (a, b) = (column(&p, 0), column(&p, 1));
    assert_eq!((a.len(), b.len()), (8, 8), "{a:?} {b:?}");
    assert!((a[7] - 0.25).abs() < 1e-6 && (b[7] - 0.75).abs() < 1e-6, "{a:?} {b:?}");
    assert!((a[3] - 10.0).abs() < 1e-3, "the feed's own tilt stays: {a:?}");
    // The engine reads the column: Opacity Jitter's control on Stylus Wheel paints the low-wheel
    // end fainter than the high-wheel end.
    let brush = json!({"size": 20, "hardness": 1.0, "pressureSize": false, "pressureOpacity": false,
        "transfer": {"enabled": true, "opacity": {"control": "stylusWheel"}}});
    let mut session = photocraft_engine::Session::new();
    session.execute("file.new", json!({"width": 120, "height": 80, "background": "transparent"})).unwrap();
    session.execute("tools.setBrush", json!({ "brush": brush })).unwrap();
    session.execute("paint.stroke", json!({"points": p["points"], "color": "#000000"})).unwrap();
    let mut alpha = |x: i32| -> f64 { session.execute("document.pixel", json!({"x": x, "y": 40})).unwrap()[3].as_f64().unwrap() };
    let (low, high) = (alpha(20), alpha(90));
    assert!(high > low + 0.2, "the wheel drives the opacity: {low} → {high}");
}

#[test]
fn no_service_no_wheel_and_use_tablet_pressure_off_ignores_it() {
    let mut s = Stylus::default();
    s.pigment.extras = PenExtras { pose: Some([10.0, 0.0, 0.0]), wheel: Some(0.5) };
    s.use_pressure = false;
    s.record_pointer(0.0, Some(craft::behavior::PointerSample::new(0.4)));
    s.begin_stroke();
    assert_eq!(s.stroke_points(&[[1.0, 2.0, 1.0]]), vec![vec![1.0, 2.0, 1.0]], "a pen paints like a mouse");
    let mut app = crate::PhotocraftApp::new(photocraft_engine::Session::new(), Default::default());
    app.stylus.pigment.extras = PenExtras { pose: None, wheel: Some(0.5) };
    refresh(&mut app);
    assert_eq!(app.stylus.pigment.extras, PenExtras::default(), "no service: nothing");
}
