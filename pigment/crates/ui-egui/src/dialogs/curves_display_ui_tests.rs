//! Curve Display Options and Curves' Show Clipping, driven through real pointer input in the Curves dialog (Pigment's
//! controls and the framework's curve graph) and through the Properties panel menu.

use craft::imaging::ui::adjust::LevelsClip;
use craft::ui::patterns::form_dialogs::HostedParamDialog;
use craft::ui::runtime::commands::CommandRef;
use egui::{Pos2, vec2};
use egui_kittest::Harness;
use egui_kittest::kittest::{NodeT, Queryable};
use photocraft_engine::cmd::auto_options_cmds::curves_display::CurvesAmount;
use serde_json::json;

use super::*;
use crate::adjust_dialog::HostedAdjustDialog;
use crate::panels::adjustment_presets::{PropertiesCommand, command_states, run_fired};

type H = Harness<'static, Box<PhotocraftApp>>;

/// A grey ramp, dark at the left.
fn app_with_ramp() -> Box<PhotocraftApp> {
    let mut s = photocraft_engine::Session::new();
    s.execute("file.new", json!({"width": 64, "height": 48})).unwrap();
    for i in 0..8 {
        let v = 16 + i * 30;
        s.execute("select.rect", json!({"x": i * 8, "y": 0, "width": 8, "height": 48})).unwrap();
        s.execute("edit.fill", json!({"color": format!("#{v:02x}{v:02x}{v:02x}")})).unwrap();
    }
    s.execute("select.deselect", json!({})).unwrap();
    PhotocraftApp::new(s, crate::Services::default())
}

fn harness(app: Box<PhotocraftApp>) -> H {
    let h = Harness::builder()
        .with_context(app.ctx().clone())
        .with_size(vec2(1200.0, 900.0))
        .with_step_dt(1.0 / 60.0)
        .build_ui_state(|ui, app| crate::dialogs::run(app, ui), app);
    PhotocraftApp::setup_context(&h.ctx, crate::theme::AppTheme::pro());
    h
}

fn click(h: &mut H, at: Pos2) {
    h.hover_at(at);
    h.run_steps(1);
    h.drag_at(at);
    h.run_steps(1);
    h.drop_at(at);
    h.run_steps(3);
}

fn node_center(h: &H, label: &str, role: egui::accesskit::Role) -> Pos2 {
    h.query_all_by_label(label)
        .find(|n| n.accesskit_node().role() == role)
        .unwrap_or_else(|| panic!("a {label} {role:?}"))
        .rect()
        .center()
}

fn open_curves(h: &mut H) -> DialogId {
    let id = crate::adjust_dialog::open(h.state_mut(), "image.adjustments.curves").unwrap();
    h.run_steps(4);
    id
}

fn clipping(h: &H, id: DialogId) -> Option<LevelsClip> {
    h.state().framework.dialogs.get_by_id::<HostedAdjustDialog>(id).and_then(HostedAdjustDialog::clipping)
}

fn setup_view(h: &H) -> View {
    h.state().adjust_open.as_ref().unwrap().setup.lock().unwrap().curves_display
}

/// The screen position of the composite curve's point `i` of `n`.
fn point(h: &H, i: usize, n: usize) -> Pos2 {
    node_center(h, &format!("Point {i} of {n}"), egui::accesskit::Role::GraphicsObject)
}

/// Presses at `from`, moves to `to` in steps, and reports the clipping display while the button is held; then releases
/// and returns it with the display after the release.
fn drag(h: &mut H, id: DialogId, from: Pos2, to: Pos2, alt: bool) -> (Option<LevelsClip>, Option<LevelsClip>) {
    let mods = if alt { egui::Modifiers::ALT } else { egui::Modifiers::NONE };
    h.hover_at(from);
    h.event(egui::Event::ModifiersChanged(mods));
    h.run_steps(1);
    h.event(egui::Event::PointerButton { pos: from, button: egui::PointerButton::Primary, pressed: true, modifiers: mods });
    h.run_steps(1);
    for k in 1..=6 {
        let at = from + (to - from) * (k as f32 / 6.0);
        h.event(egui::Event::PointerMoved(at));
        h.run_steps(1);
    }
    let held = clipping(h, id);
    h.event(egui::Event::PointerButton { pos: to, button: egui::PointerButton::Primary, pressed: false, modifiers: mods });
    h.run_steps(2);
    h.event(egui::Event::ModifiersChanged(egui::Modifiers::NONE));
    h.run_steps(2);
    (held, clipping(h, id))
}

#[test]
fn show_clipping_shows_an_end_points_clipping_only_while_it_is_dragged() {
    let mut h = harness(app_with_ramp());
    let id = open_curves(&mut h);
    let original = h.state().session.active().unwrap().doc.clone();
    // Without Show Clipping or Alt, dragging the black point shows the preview, not the display.
    let (black, white) = (point(&h, 1, 2), point(&h, 2, 2));
    let (held, after) = drag(&mut h, id, black, black + vec2(40.0, 0.0), false);
    assert_eq!((held, after), (None, None));
    assert_ne!(point(&h, 1, 2), black, "the drag moved the black point");

    // Show Clipping, by pointer: the dialog's own state, read back by the editor.
    {
        let at = node_center(&h, "Show Clipping", egui::accesskit::Role::CheckBox);
        click(&mut h, at);
    }
    assert_eq!(h.state().curves_display.show_clipping, Some(id));
    assert!(setup_view(&h).show_clipping);
    let black = point(&h, 1, 2);
    let (held, after) = drag(&mut h, id, black, black + vec2(30.0, 0.0), false);
    assert_eq!((held, after), (Some(LevelsClip::Shadows), None), "shadows while the black point moves, off at the release");
    let (held, after) = drag(&mut h, id, white, white - vec2(40.0, 0.0), false);
    assert_eq!((held, after), (Some(LevelsClip::Highlights), None));
    // A middle point's drag shows nothing.
    let mid = point(&h, 1, 2) + (point(&h, 2, 2) - point(&h, 1, 2)) * 0.5;
    click(&mut h, mid);
    assert!(h.query_by_label("Point 3 of 3").is_some(), "the click added a point");
    let at = point(&h, 2, 3);
    let (held, _) = drag(&mut h, id, at, at + vec2(0.0, -30.0), false);
    assert_eq!(held, None);
    assert!(std::sync::Arc::ptr_eq(&original, &h.state().session.active().unwrap().doc), "the display never edits the document");

    // Off again: Alt alone shows it, as in Photoshop.
    {
        let at = node_center(&h, "Show Clipping", egui::accesskit::Role::CheckBox);
        click(&mut h, at);
    }
    assert_eq!(h.state().curves_display.show_clipping, None);
    let black = point(&h, 1, 3);
    let (held, after) = drag(&mut h, id, black, black + vec2(20.0, 0.0), true);
    assert_eq!((held, after), (Some(LevelsClip::Shadows), None));

    // A new Curves dialog opens with Show Clipping off.
    let ctx = h.ctx.clone();
    crate::dialogs::confirm(h.state_mut(), &ctx, id).unwrap();
    h.run_steps(2);
    let id = open_curves(&mut h);
    assert!(!setup_view(&h).show_clipping);
    assert_ne!(h.state().curves_display.show_clipping, Some(id));
}

#[test]
fn the_options_dialog_previews_saves_and_keeps_what_it_cannot_draw() {
    let mut h = harness(app_with_ramp());
    // A setting this version can't draw, saved before (a migrated JS setting, or prefs.set).
    h.state_mut().run("prefs.set", json!({"path": "adjustments.curvesDisplay.amount.rgb", "value": "pigment"})).unwrap();
    let steps = h.state().session.active().unwrap().history.past_len();
    let id = open_curves(&mut h);
    assert!(setup_view(&h).histogram, "Show Histogram is on by default");
    assert!(!h.state().adjust_open.as_ref().unwrap().setup.lock().unwrap().histograms.is_empty());

    // Curve Display Options…, by pointer: a child of the Curves dialog.
    {
        let at = node_center(&h, "Curve Display Options…", egui::accesskit::Role::Button);
        click(&mut h, at);
    }
    let (options, _) = h.state().curves_display.open.expect("the options dialog");
    assert_eq!(h.state().framework.dialogs.stack().top(), Some(options));
    for label in ["Channel Overlays", "Baseline", "Intersection Line"] {
        let node = h.query_all_by_label(label).find(|n| n.accesskit_node().role() == egui::accesskit::Role::CheckBox).unwrap();
        assert!(node.accesskit_node().is_disabled(), "{label} waits for the framework");
    }
    let histogram = h.query_all_by_label("Histogram").find(|n| n.accesskit_node().role() == egui::accesskit::Role::CheckBox).unwrap();
    assert!(!histogram.accesskit_node().is_disabled());

    // Unticking Histogram previews at once; Cancel puts it back and saves nothing.
    {
        let at = node_center(&h, "Histogram", egui::accesskit::Role::CheckBox);
        click(&mut h, at);
    }
    assert!(!setup_view(&h).histogram, "the graph follows the open options");
    assert_eq!(crate::adjust_editors::curves_display::histograms(&setup_view(&h), &[[1; 256]]).len(), 0, "the panel gets no histogram");
    let ctx = h.ctx.clone();
    h.state_mut().framework.dialogs.cancel_by_id(&ctx, options);
    h.run_steps(3);
    assert!(h.state().curves_display.open.is_none());
    assert!(setup_view(&h).histogram);
    assert!(h.state().session.prefs().adjustments.curves_display.histogram);

    // Again, with OK: saved, and the stored Pigment/Ink % is kept.
    {
        let at = node_center(&h, "Curve Display Options…", egui::accesskit::Role::Button);
        click(&mut h, at);
    }
    let (options, _) = h.state().curves_display.open.unwrap();
    {
        let at = node_center(&h, "Histogram", egui::accesskit::Role::CheckBox);
        click(&mut h, at);
    }
    let ctx = h.ctx.clone();
    crate::dialogs::confirm(h.state_mut(), &ctx, options).unwrap();
    h.run_steps(3);
    let saved = h.state().session.prefs().adjustments.curves_display;
    assert!(!saved.histogram);
    assert_eq!(saved.amount.rgb, CurvesAmount::Pigment);
    assert!(!setup_view(&h).histogram);
    assert!(h.state().framework.dialogs.get_by_id::<HostedAdjustDialog>(id).is_some(), "the Curves dialog stays open");
    // The options don't touch the document or its history.
    assert_eq!(h.state().session.active().unwrap().history.past_len(), steps);
}

#[test]
fn properties_has_curves_display_options_for_a_curves_layer() {
    let mut app = app_with_ramp();
    let row = |app: &PhotocraftApp| command_states(app).into_iter().find(|(c, _)| *c == CommandRef::from(PropertiesCommand::CurvesDisplayOptions)).unwrap().1;
    assert!(!row(&app).is_enabled(), "a pixel layer");
    app.run("layer.newAdjustmentLayer.levels", json!({})).unwrap();
    assert!(!row(&app).is_enabled(), "a Levels layer");
    app.run("layer.newAdjustmentLayer.curves", json!({})).unwrap();
    assert!(row(&app).is_enabled());
    let ctx = app.ctx().clone();
    assert!(run_fired(&mut app, &ctx, &CommandRef::from(PropertiesCommand::CurvesDisplayOptions)));
    let (id, mode) = app.curves_display.open.expect("opened on its own");
    assert_eq!(mode, ColorMode::Rgb);
    assert!(app.framework.dialogs.get_by_id::<HostedParamDialog>(id).is_some());
    // Properties' Curves follows the open options, then the saved ones.
    app.framework.dialogs.set_json_field(&ctx, id, "histogram", json!(false)).unwrap();
    assert!(!view(&app, None).histogram);
    crate::dialogs::confirm(&mut app, &ctx, id).unwrap();
    assert!(!app.session.prefs().adjustments.curves_display.histogram);
    assert!(!view(&app, None).histogram);
}

#[test]
fn fields_keep_show_amount_of_per_colour_mode() {
    let d = CurvesDisplay::default();
    let f = fields_of(&d, ColorMode::Cmyk);
    assert_eq!(f.text("amount"), Some("pigment"));
    let mut light = f.clone();
    light.set("amount", "light");
    let after = display_of(&light, d, ColorMode::Cmyk);
    assert_eq!(after.amount.of(ColorMode::Cmyk), CurvesAmount::Light);
    assert_eq!(after.amount.of(ColorMode::Rgb), CurvesAmount::Light, "RGB keeps its own");
    let mut grid = DialogFields::new();
    grid.set("grid", "detailed");
    assert_eq!(display_of(&grid, d, ColorMode::Rgb).grid, CurvesGrid::Detailed);
    grid.set("grid", "fine");
    assert_eq!(display_of(&grid, d, ColorMode::Rgb).grid, CurvesGrid::Simple, "a bad field keeps the base");
}
