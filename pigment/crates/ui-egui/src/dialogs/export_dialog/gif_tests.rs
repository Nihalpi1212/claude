//! Pigment (F2, row 30): GIF in File › Export › Export As, with Transparency as its only option, as
//! in Photoshop and the JavaScript Pigment.

use super::*;

use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;

/// A 4×2 document, left half red, right half blue, with the top-right pixel transparent.
fn two_colour_doc() -> Document {
    let mut session = photocraft_engine::Session::new();
    session.execute("file.new", json!({"width": 4, "height": 2, "background": "transparent"})).unwrap();
    let mut doc = (*session.active().unwrap().doc).clone();
    let id = doc.layers[0].id;
    let surf = doc.layer_mut(id).unwrap().surface_mut().unwrap();
    surf.fill_rect(photocraft_geom::Rect::new(0, 0, 2, 2), &[1.0, 0.0, 0.0, 1.0]);
    surf.fill_rect(photocraft_geom::Rect::new(2, 0, 4, 2), &[0.0, 0.0, 1.0, 1.0]);
    surf.fill_rect(photocraft_geom::Rect::new(3, 0, 4, 1), &[0.0, 0.0, 0.0, 0.0]);
    doc
}

/// The GIF Export As writes for `doc` with `transparency`, decoded to RGBA8.
fn exported_gif(doc: &Document, transparency: bool) -> (Vec<u8>, Vec<u8>) {
    let f = Map::from_iter([("format".into(), json!("gif")), ("scale".into(), json!(100)), ("transparency".into(), json!(transparency))]);
    let out = export_document(doc, &f, None, &photocraft_engine::color_cmds::document_profile(doc)).unwrap();
    let bytes = photocraft_io::export(&out, "x.gif", &settings(&f).io_options()).unwrap().bytes;
    let img = photocraft_codecs::decode(&bytes).expect("the GIF decodes");
    assert_eq!(img.dimensions(), (4, 2));
    (bytes, img.to_rgba8())
}

#[test]
fn gif_is_offered_after_jpg_with_transparency_only() {
    let formats = dialog_formats();
    let ids: Vec<&str> = formats.iter().map(|f| f.id).collect();
    assert_eq!(&ids[..3], &["png", "jpg", "gif"]);
    let gif = &formats[2];
    assert_eq!((gif.name, gif.extension), ("GIF", "gif"));
    assert!(gif.transparency && !gif.quality && !gif.lossless && gif.bits.is_empty());
    assert!(valid_setting("format", &json!("gif")));
    assert!(FORMATS.iter().any(|(k, name)| (*k, *name) == ("gif", "GIF")));
    let s = settings(&Map::from_iter([("format".into(), json!("gif")), ("quality".into(), json!(40))]));
    assert_eq!((s.jpeg_quality, s.webp_quality, s.tga_bits), (None, None, None), "GIF takes no quality");
}

/// Picking GIF in the Format list hides Quality, which JPG shows.
#[test]
fn choosing_gif_in_the_dialog_hides_quality() {
    let services =
        crate::Services { export: Some(Box::new(|_, _, _| Ok((Vec::new(), Vec::new())))), write: Some(Box::new(|_, _| Ok(()))), ..Default::default() };
    let mut app = Box::new(PhotocraftApp::new(photocraft_engine::Session::new(), services));
    app.run("file.new", json!({"width": 20, "height": 10})).unwrap();
    let mut h = Harness::builder()
        .with_size(egui::vec2(900.0, 700.0))
        .with_step_dt(1.0 / 60.0)
        .with_context(app.ctx().clone())
        .build_ui_state(|ui, app: &mut Box<PhotocraftApp>| crate::dialogs::run(app, ui), app);
    h.run_steps(2);
    open(h.state_mut()).unwrap();
    h.run_steps(3);
    for (label, quality) in [("JPG", true), ("GIF", false)] {
        h.get_by_role_and_label(egui::accesskit::Role::ComboBox, "Format").click();
        h.run_steps(3);
        h.get_by_label(label).click();
        h.run_steps(3);
        let options = h.state().framework.dialogs.get::<HostedExportAs>().expect("Export As is open").options().clone();
        assert_eq!(options.format, label.to_ascii_lowercase());
        assert_eq!(h.query_by_label("Quality").is_some(), quality, "{label}: Quality shown");
    }
}

/// Transparency on: the GIF holds the two colours and the transparent pixel; off: that pixel is
/// the matte Export As flattens on (white).
#[test]
fn an_exported_gif_decodes_to_the_document() {
    let doc = two_colour_doc();
    let (bytes, px) = exported_gif(&doc, true);
    assert!(bytes.starts_with(b"GIF89a"), "a GIF89a");
    let (red, blue, clear) = ([255, 0, 0, 255], [0, 0, 255, 255], [0, 0, 0, 0]);
    let want = [red, red, blue, clear, red, red, blue, blue];
    for (i, (got, want)) in px.as_chunks::<4>().0.iter().zip(want).enumerate() {
        if want[3] == 0 {
            assert_eq!(got[3], 0, "pixel {i} is transparent");
        } else {
            assert_eq!(*got, want, "pixel {i}");
        }
    }
    let (_, px) = exported_gif(&doc, false);
    let want = [red, red, blue, [255, 255, 255, 255], red, red, blue, blue];
    for (i, (got, want)) in px.as_chunks::<4>().0.iter().zip(want).enumerate() {
        assert_eq!(*got, want, "pixel {i}, Transparency off");
    }
}

/// An Export As preset with GIF saves (the engine's list of formats has it too).
#[test]
fn a_gif_export_preset_saves() {
    let mut session = photocraft_engine::Session::new();
    let r = session.execute("file.export.presets.save", json!({"name": "Web GIF", "settings": {"format": "gif", "transparency": false}})).unwrap();
    assert_eq!(r["preset"]["settings"]["format"], "gif");
    assert_eq!(options_of(r["preset"]["settings"].as_object().unwrap()).format, "gif");
}
