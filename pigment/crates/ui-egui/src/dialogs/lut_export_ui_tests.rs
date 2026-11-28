//! Pigment (F2): the Color Lookup Tables form's Photoshop rows and what OK sends.

use super::*;
use craft::ui::dialog::DialogId;

use crate::PhotocraftApp;

/// An app with one document holding an Invert adjustment.
fn app() -> (Box<PhotocraftApp>, egui::Context) {
    let mut app = PhotocraftApp::new(photocraft_engine::Session::new(), crate::Services::default());
    app.run("file.new", json!({"width": 40, "height": 30})).unwrap();
    app.run("layer.newAdjustmentLayer.invert", json!({})).unwrap();
    app.sync_views();
    let ctx = app.ctx().clone();
    (app, ctx)
}

fn frame(app: &mut PhotocraftApp, ctx: &egui::Context) {
    let mut output = ctx.run_ui(Default::default(), |ui| {
        let mut frame = eframe::Frame::_new_kittest();
        app.logic_frame(ui.ctx(), &mut frame);
        app.ui_frame(ui, &mut frame);
    });
    output.textures_delta.clear();
}

/// Opens the form from the menu, after the frame that shows it.
fn open(app: &mut PhotocraftApp, ctx: &egui::Context) -> DialogId {
    let reply = crate::menus::invoke(app, ctx, COMMAND, json!({})).unwrap();
    let want = reply["dialog"].as_str().expect("the reply names a dialog").to_owned();
    let id = app.framework.dialogs.open_dialogs().into_iter().map(|d| d.id).find(|id| id.value().to_string() == want).expect("the form is open");
    frame(app, ctx);
    id
}

fn fields(app: &PhotocraftApp, id: DialogId) -> Value {
    app.framework.dialogs.open_dialogs().into_iter().find(|open| open.id == id).and_then(|open| open.fields).expect("the form lists its fields")
}

fn set(app: &mut PhotocraftApp, ctx: &egui::Context, id: DialogId, key: &str, value: Value) {
    app.framework.dialogs.set_json_field(ctx, id, key, value).unwrap_or_else(|e| panic!("{key}: {e}"));
}

fn tmp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("pigment-lut-ui-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn the_form_has_photoshops_rows_and_defaults() {
    let (mut app, ctx) = app();
    let id = open(&mut app, &ctx);
    let f = fields(&app, id);
    assert_eq!(f["quality"], "medium");
    assert_eq!(f["size"], 33, "upstream's key and default stay");
    assert_eq!((f["lowercase"].as_bool(), f["copyright"].as_str()), (Some(true), Some("")));
    assert_eq!(
        (f["formats/3dl"].as_bool(), f["formats/cube"].as_bool(), f["formats/csp"].as_bool(), f["formats/icc"].as_bool()),
        (Some(false), Some(true), Some(false), Some(false))
    );
    assert!(f["path"].as_str().unwrap().ends_with(".cube"));
    let keys: Vec<String> = rows("p".into(), "t".into(), "all").iter().map(|p| p.key.clone()).collect();
    let want = ["path", "title", "copyright", "lowercase", "quality", "size", "formats/3dl", "formats/cube", "formats/csp", "formats/icc", "scope"];
    assert!(want.iter().all(|k| keys.iter().any(|key| key == k)), "{keys:?}");
    crate::dialogs::cancel(&mut app, &ctx, id).unwrap();
}

#[test]
fn quality_and_the_boxes_fold_into_size_and_formats() {
    let map = |v: Value| v.as_object().unwrap().clone();
    let mut m = map(json!({"quality": "maximum", "size": 33, "formats/cube": true, "formats/icc": true, "formats/csp": false, "copyright": ""}));
    fold(&mut m);
    assert_eq!(Value::Object(m), json!({"size": 256, "formats": ["cube", "icc"]}));
    let mut m = map(json!({"quality": "custom", "size": 9, "formats/3dl": true, "copyright": "(c)"}));
    fold(&mut m);
    assert_eq!(Value::Object(m), json!({"size": 9, "formats": ["3dl"], "copyright": "(c)"}));
    for (id, points) in [("poor", 7), ("low", 17), ("medium", 33), ("high", 64)] {
        let mut m = map(json!({"quality": id}));
        fold(&mut m);
        assert_eq!(m["size"], points, "{id}");
    }
}

/// OK writes one file per ticked format beside the chosen path, at Quality's grid points.
#[test]
fn ok_writes_every_ticked_format() {
    let dir = tmp("ok");
    let (mut app, ctx) = app();
    let id = open(&mut app, &ctx);
    set(&mut app, &ctx, id, "path", json!(dir.join("look.cube").to_string_lossy()));
    for key in ["formats/3dl", "formats/csp", "formats/icc"] {
        set(&mut app, &ctx, id, key, json!(true));
    }
    set(&mut app, &ctx, id, "quality", json!("low"));
    set(&mut app, &ctx, id, "copyright", json!("(c) Tester"));
    crate::dialogs::confirm(&mut app, &ctx, id).unwrap();
    frame(&mut app, &ctx);
    for ext in ["3dl", "cube", "csp", "icc"] {
        assert!(dir.join(format!("look.{ext}")).is_file(), "look.{ext}");
    }
    let cube = std::fs::read_to_string(dir.join("look.cube")).unwrap();
    assert!(cube.contains("LUT_3D_SIZE 17") && cube.contains("#Copyright: (c) Tester"), "{}", &cube[..200]);
    assert_eq!(craft::cms::Profile::parse(&std::fs::read(dir.join("look.icc")).unwrap()).unwrap().copyright, "(c) Tester");

    // Custom takes the Grid Points row; lowercase off writes upper-case extensions.
    let id = open(&mut app, &ctx);
    set(&mut app, &ctx, id, "path", json!(dir.join("custom").to_string_lossy()));
    set(&mut app, &ctx, id, "quality", json!("custom"));
    set(&mut app, &ctx, id, "size", json!(9));
    set(&mut app, &ctx, id, "lowercase", json!(false));
    for key in ["formats/3dl", "formats/csp", "formats/icc"] {
        set(&mut app, &ctx, id, key, json!(false));
    }
    crate::dialogs::confirm(&mut app, &ctx, id).unwrap();
    frame(&mut app, &ctx);
    let cube = std::fs::read_to_string(dir.join("custom.CUBE")).unwrap();
    assert!(cube.contains("LUT_3D_SIZE 9"));
    let _ = std::fs::remove_dir_all(&dir);
}
