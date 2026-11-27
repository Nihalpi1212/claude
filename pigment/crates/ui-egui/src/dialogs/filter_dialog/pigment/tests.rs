//! HDR Toning's Method menu and Preset row, Match Color's Load/Save Statistics… and Replace Color's preview,
//! through the dialogs as the window draws them.

use std::sync::Arc;

use craft::host::{Picked, ScriptedFiles};
use egui::vec2;
use egui_kittest::Harness;
use egui_kittest::kittest::{NodeT, Queryable};

use super::*;

type H = Harness<'static, Box<PhotocraftApp>>;

fn harness(app: Box<PhotocraftApp>) -> H {
    let h = Harness::builder()
        .with_context(app.ctx().clone())
        .with_size(vec2(1200.0, 1100.0))
        .with_step_dt(1.0 / 60.0)
        .build_ui_state(|ui, app| crate::dialogs::run(app, ui), app);
    PhotocraftApp::setup_context(&h.ctx, crate::theme::AppTheme::pro());
    h
}

/// An app whose file dialogs answer `answers` in turn, and whose writes go to disk.
fn app_with(answers: Vec<Picked>) -> Box<PhotocraftApp> {
    let services = crate::Services {
        write: Some(Box::new(|path, bytes| std::fs::write(path, bytes).map_err(|e| e.to_string()))),
        files: Some(Arc::new(ScriptedFiles::answering(answers))),
        ..Default::default()
    };
    let mut app = PhotocraftApp::new(photocraft_engine::Session::new(), services);
    app.background_jobs = false;
    app
}

/// A new document painted by `f`.
fn document(app: &mut PhotocraftApp, w: i32, h: i32, f: impl Fn(i32, i32) -> [f32; 4]) {
    app.run("file.new", json!({"width": w, "height": h})).unwrap();
    app.session
        .edit("setup", |doc, active| {
            let b = doc.bounds();
            let surf = doc.layer_mut(active.unwrap()).unwrap().surface_mut().unwrap();
            let fmt = surf.format();
            let mut data = Vec::new();
            for y in b.y0..b.y1 {
                for x in b.x0..b.x1 {
                    data.extend(photocraft_raster::from_rgba(&fmt, f(x, y)));
                }
            }
            surf.write_region(b, &data);
            Ok(())
        })
        .unwrap();
}

fn fields(app: &PhotocraftApp, command: &str) -> DialogFields {
    open_dialog(app, command).expect("the dialog is open").fields().clone()
}

fn set(h: &mut H, command: &str, key: &str, value: Value) {
    let ctx = h.ctx.clone();
    h.state_mut().framework.dialogs.set_json_field(&ctx, dialog_id(command), key, value).unwrap_or_else(|e| panic!("{key}: {e}"));
    h.run_steps(3);
}

fn click(h: &mut H, at: egui::Pos2) {
    h.hover_at(at);
    h.run_steps(1);
    h.drag_at(at);
    h.run_steps(1);
    h.drop_at(at);
    h.run_steps(3);
}

/// Whether a row labelled `label` is drawn.
fn shown(h: &H, label: &str) -> bool {
    h.query_all_by_label(label).next().is_some()
}

/// Whether the control labelled `label` takes input.
fn enabled(h: &H, label: &str) -> bool {
    h.query_all_by_label(label).filter(|n| n.accesskit_node().role() != egui::accesskit::Role::Label).any(|n| !n.accesskit_node().is_disabled())
}

fn ok(h: &mut H, command: &str) {
    let ctx = h.ctx.clone();
    crate::dialogs::confirm(h.state_mut(), &ctx, dialog_id(command)).expect("OK");
    h.run_steps(4);
}

// --- HDR Toning --------------------------------------------------------------------------------------------

#[test]
fn hdr_toning_shows_the_rows_of_the_chosen_method() {
    let mut app = app_with(Vec::new());
    document(&mut app, 32, 8, |x, _| [x as f32 / 31.0, 0.4, 0.2, 1.0]);
    let mut h = harness(app);
    crate::filter_dialog::open(h.state_mut(), HDR_TONING).unwrap();
    h.run_steps(4);
    assert_eq!(fields(h.state(), HDR_TONING).text("method"), Some("localAdaptation"), "Local Adaptation, as before the menu");
    let note = "Spreads the luminance histogram evenly. This method has no settings.";
    assert!(shown(&h, "Radius") && shown(&h, "Detail") && shown(&h, "Saturation") && !shown(&h, note));
    assert!(enabled(&h, "Exposure") && enabled(&h, "Gamma"));
    set(&mut h, HDR_TONING, "method", json!("equalizeHistogram"));
    assert!(!shown(&h, "Radius") && !shown(&h, "Detail") && !shown(&h, "Saturation"), "the Local Adaptation rows are hidden");
    assert!(shown(&h, note), "and the note says there are no settings");
    assert!(!enabled(&h, "Exposure") && !enabled(&h, "Gamma"));
    set(&mut h, HDR_TONING, "method", json!("exposureGamma"));
    assert!(!shown(&h, "Radius") && !shown(&h, note));
    assert!(enabled(&h, "Exposure") && enabled(&h, "Gamma"));
    set(&mut h, HDR_TONING, "method", json!("highlightCompression"));
    assert!(enabled(&h, "Exposure") && !enabled(&h, "Gamma"), "Highlight Compression takes the exposure, as the JavaScript app did");
    // OK runs the method, one history step.
    set(&mut h, HDR_TONING, "method", json!("exposureGamma"));
    set(&mut h, HDR_TONING, "exposure", json!(1.0));
    let before = h.state().session.active().unwrap().history.past_len();
    ok(&mut h, HDR_TONING);
    let st = h.state().session.active().unwrap();
    assert_eq!(st.history.past_len(), before + 1);
    let px = st.doc.layers[0].surface().unwrap().rgba(10, 4);
    let start = 10.0f32 / 31.0;
    let want = photocraft_color::convert::linear_to_srgb((2.0 * photocraft_color::convert::srgb_to_linear(start)).min(1.0));
    assert!((px[0] - want).abs() < 2.0 / 255.0, "+1 stop: {} → {} (want {want})", start, px[0]);
}

/// Clicks the Preset picker's field and then the preset named `name` in its list.
fn pick(h: &mut H, name: &str) {
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

#[test]
fn hdr_toning_presets_apply_and_save_through_the_preset_row() {
    let mut app = app_with(Vec::new());
    document(&mut app, 16, 8, |x, _| [x as f32 / 15.0, 0.4, 0.2, 1.0]);
    let mut h = harness(app);
    crate::filter_dialog::open(h.state_mut(), HDR_TONING).unwrap();
    h.run_steps(4);
    set(&mut h, HDR_TONING, "method", json!("exposureGamma"));
    pick(&mut h, "Monochromatic High Contrast");
    let f = command_params(HDR_TONING, &fields(h.state(), HDR_TONING));
    assert_eq!(f["method"], "localAdaptation", "the preset sets its method back: {f}");
    for (key, want) in [("radius", 60.0), ("strength", 0.8), ("detail", 120.0), ("saturation", -100.0), ("shadow", -30.0), ("highlight", 20.0), ("gamma", 1.0)]
    {
        assert!((f[key].as_f64().unwrap() - want).abs() < 1e-6, "{key}: {f}");
    }
    assert!(shown(&h, "Radius"), "its rows are shown again");
    // New… saves the dialog's settings (here through the row's ask, as New… files it).
    set(&mut h, HDR_TONING, "detail", json!(140.0));
    h.state_mut()
        .framework
        .dialogs
        .get_mut_by_id::<HostedParamDialog>(dialog_id(HDR_TONING))
        .unwrap()
        .set_field(PRESET_ASK, FieldValue::Json(json!({"create": "Mine"})));
    h.run_steps(3);
    let saved = h.state().session.presets.adjustments.find("hdrToning", Some("Mine"), None).expect("saved");
    assert_eq!((saved.preset.params["detail"].as_f64(), saved.preset.params["method"].as_str()), (Some(140.0), Some("localAdaptation")));
    assert!(saved.preset.params.as_object().unwrap().keys().all(|k| !k.starts_with("__")), "settings only: {}", saved.preset.params);
    assert!(fields(h.state(), HDR_TONING).get(PRESET_ASK).is_none(), "the ask was answered");
    // The row lists it at once.
    let listed: Option<HdrPresets> = h.ctx.data(|d| d.get_temp(hdr_presets_id()));
    assert!(listed.unwrap().entries.iter().any(|e| e.name == "Mine"));
    // A JavaScript id in a preset is the same method.
    assert!(preset_row::params_match(&json!({"method": "localAdaptation", "detail": 140}), &command_params(HDR_TONING, &fields(h.state(), HDR_TONING))));
}

// --- Match Color --------------------------------------------------------------------------------------------

fn warm(x: i32, y: i32) -> [f32; 4] {
    [0.85 - y as f32 * 0.02, 0.45 + x as f32 * 0.01, 0.2, 1.0]
}

fn cool(x: i32, y: i32) -> [f32; 4] {
    [0.2 + x as f32 * 0.01, 0.35, 0.75 - y as f32 * 0.015, 1.0]
}

#[test]
fn match_color_saves_statistics_and_loads_them_as_a_source() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("warm statistics.json");
    let path_text = path.to_str().unwrap().to_owned();
    let js = include_str!("../../../../../engine/src/cmd/adjust_cmds/match_statistics/js-statistics.json");
    let mut app = app_with(vec![Picked::Paths(vec![path.clone()]), Picked::Contents(vec![("sunset.json".into(), js.as_bytes().to_vec())])]);
    document(&mut app, 20, 12, warm);
    document(&mut app, 20, 12, cool);
    let mut h = harness(app);
    crate::filter_dialog::open(h.state_mut(), MATCH_COLOR).unwrap();
    h.run_steps(4);
    assert!(!enabled(&h, "Save Statistics…"), "no source, nothing to save");
    set(&mut h, MATCH_COLOR, "source", json!("0"));
    assert!(enabled(&h, "Save Statistics…"));
    // Save Statistics… writes the JavaScript app's file for the source document.
    h.get_by_label("Save Statistics…").click();
    h.run_steps(3);
    h.state_mut().poll_file_dialog();
    h.run_steps(2);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path_text}: {e} ({})", h.state().ui.status));
    let file: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(file["format"], "pigment-match-color-statistics");
    let by_document = h.state_mut().session.execute(photocraft_engine::adjust_cmds::match_statistics::STATISTICS, json!({"source": 0})).unwrap();
    assert_eq!(file["name"], by_document["name"]);
    // Load Statistics… adds the file's statistics to the Source menu and chooses them.
    h.get_by_label("Load Statistics…").click();
    h.run_steps(3);
    h.state_mut().poll_file_dialog();
    h.run_steps(3);
    let f = fields(h.state(), MATCH_COLOR);
    assert_eq!(f.text("source"), Some(STATISTICS_SOURCE), "{}", h.state().ui.status);
    let combo = h.query_all_by_role(egui::accesskit::Role::ComboBox).filter_map(|n| n.value()).find(|v| v.contains("Statistics: Sunset"));
    assert!(combo.is_some(), "the Source menu shows the loaded statistics");
    let params = command_params(MATCH_COLOR, &f);
    assert!(params.get("source").is_none() && params["sourceStatistics"]["mean"].as_array().is_some_and(|m| m.len() == 3), "{params}");
    assert!(shown(
        &h,
        &format!(
            "L {:.1} ± {:.1}, a {:.1} ± {:.1}, b {:.1} ± {:.1}",
            params["sourceStatistics"]["mean"][0].as_f64().unwrap(),
            params["sourceStatistics"]["std"][0].as_f64().unwrap(),
            params["sourceStatistics"]["mean"][1].as_f64().unwrap(),
            params["sourceStatistics"]["std"][1].as_f64().unwrap(),
            params["sourceStatistics"]["mean"][2].as_f64().unwrap(),
            params["sourceStatistics"]["std"][2].as_f64().unwrap()
        )
    ));
    // OK matches the colours to them: one history step, recorded with the statistics.
    let before = h.state().session.active().unwrap().history.past_len();
    let start = h.state().session.active().unwrap().doc.layers[0].surface().unwrap().rgba(5, 5);
    ok(&mut h, MATCH_COLOR);
    let st = h.state().session.active().unwrap();
    assert_eq!(st.history.past_len(), before + 1);
    let after = st.doc.layers[0].surface().unwrap().rgba(5, 5);
    assert!(after[0] > start[0] + 0.1 && after[2] < start[2] - 0.1, "warmer, as the sunset: {start:?} → {after:?}");
}

#[test]
fn match_color_refuses_a_file_without_statistics() {
    let mut app = app_with(vec![Picked::Contents(vec![("notes.json".into(), b"{\"hello\": 1}".to_vec())])]);
    document(&mut app, 8, 8, warm);
    let mut h = harness(app);
    crate::filter_dialog::open(h.state_mut(), MATCH_COLOR).unwrap();
    h.run_steps(4);
    h.get_by_label("Load Statistics…").click();
    h.run_steps(3);
    h.state_mut().poll_file_dialog();
    h.run_steps(2);
    assert!(h.state().ui.status_error && h.state().ui.status.contains("statistics"), "{}", h.state().ui.status);
    assert_eq!(fields(h.state(), MATCH_COLOR).text("source"), Some("-1"), "the source stays");
}

// --- Replace Color ------------------------------------------------------------------------------------------

fn preview(h: &H) -> ReplacePreview {
    h.ctx.data(|d| d.get_temp(replace_preview_id())).expect("the preview")
}

#[test]
fn replace_color_previews_the_selection_and_a_press_on_it_samples() {
    let mut app = app_with(Vec::new());
    // Red on the left, blue on the right.
    document(&mut app, 40, 30, |x, _| if x < 20 { [1.0, 0.0, 0.0, 1.0] } else { [0.0, 0.0, 1.0, 1.0] });
    app.run("tools.setColors", json!({"foreground": "#0000ff"})).unwrap();
    let mut h = harness(app);
    crate::filter_dialog::open(h.state_mut(), REPLACE_COLOR).unwrap();
    h.run_steps(5);
    let p = preview(&h);
    assert_eq!(p.size(), Some([40, 30]), "the picture is the proxy's size");
    assert_eq!(p.k, 1);
    let mask = p.mask.clone().unwrap();
    let at = |m: &ColorImage, x: usize, y: usize| m.pixels[y * m.size[0] + x].r();
    assert!(at(&mask, 30, 10) > 200 && at(&mask, 5, 10) < 50, "the foreground blue is selected: the right half");
    // Image shows the picture.
    set(&mut h, REPLACE_COLOR, PREVIEW_VIEW, json!("image"));
    let image = preview(&h).image.unwrap();
    assert!(image.pixels[10 * 40 + 5].r() > 200 && image.pixels[10 * 40 + 5].b() < 50, "the image's red");
    set(&mut h, REPLACE_COLOR, PREVIEW_VIEW, json!("selection"));
    // A press on the red half with Add to Sample adds that sample.
    set(&mut h, REPLACE_COLOR, SAMPLE_TOOL, json!("add"));
    let pane = h
        .query_all_by_label("Preview")
        .filter(|n| n.accesskit_node().role() != egui::accesskit::Role::Label)
        .max_by(|a, b| (a.rect().area()).total_cmp(&b.rect().area()))
        .expect("the preview pane")
        .rect();
    for n in h.query_all_by_label("Preview") {
        eprintln!("DBG {:?} {:?}", n.accesskit_node().role(), n.rect());
    }
    eprintln!("DBG tool {:?}", fields(h.state(), REPLACE_COLOR).text(SAMPLE_TOOL));
    for n in h.query_all(egui_kittest::kittest::by()) {
        if let Some(r) = n.accesskit_node().bounding_box() && r.y0 > 440.0 && r.y0 < 700.0 {
            eprintln!("DBG node {:?} {:?} {:?}", n.accesskit_node().role(), n.accesskit_node().label(), r);
        }
    }
    click(&mut h, egui::pos2(pane.left() + pane.width() * 0.2, pane.center().y));
    h.run_steps(3);
    let f = fields(h.state(), REPLACE_COLOR);
    eprintln!("DBG fields {}", serde_json::to_string(&f).unwrap());
    let points = command_params(REPLACE_COLOR, &f)["points"].clone();
    assert_eq!(points.as_array().map(Vec::len), Some(1), "one sample: {points}");
    assert!(points[0][0].as_f64().unwrap() < 20.0, "on the red half: {points}");
    assert_eq!(f.color("color"), Some([1.0, 0.0, 0.0]), "the first sample sets the From colour too");
    let mask = preview(&h).mask.unwrap();
    assert!(at(&mask, 5, 10) > 200 && at(&mask, 30, 10) < 50, "the preview follows: the red half now");
    // The preview is what the command does: OK changes the red half only.
    set(&mut h, REPLACE_COLOR, "hue", json!(120));
    ok(&mut h, REPLACE_COLOR);
    let st = h.state().session.active().unwrap();
    let surf = st.doc.layers[0].surface().unwrap();
    assert!(surf.rgba(5, 10)[1] > 0.5 && surf.rgba(30, 10)[2] > 0.9, "{:?} {:?}", surf.rgba(5, 10), surf.rgba(30, 10));
}

#[test]
fn replace_color_preview_params_follow_the_command() {
    let one = color_range_params(&json!({"color": "#ff0000", "fuzziness": 50, "points": [[1, 2]]}));
    assert_eq!(one, json!({"color": "#ff0000", "fuzziness": 50}));
    let many = color_range_params(&json!({"color": "#ff0000", "points": [[1, 2], [3, 4]], "order": ["+", "+"]}));
    assert_eq!(many, json!({"points": [[1, 2], [3, 4]], "order": ["+", "+"], "fuzziness": 40}));
    let minus = color_range_params(&json!({"color": "#ff0000", "subtractPoints": [[3, 4]], "order": ["-"]}));
    assert_eq!(minus, json!({"color": "#ff0000", "subtractPoints": [[3, 4]], "order": ["-"], "fuzziness": 40}));
    let local = color_range_params(&json!({"color": "#ff0000", "points": [[1, 2]], "localized": true, "range": 30}));
    assert_eq!(local, json!({"points": [[1, 2]], "localized": true, "range": 30, "fuzziness": 40}));
}
