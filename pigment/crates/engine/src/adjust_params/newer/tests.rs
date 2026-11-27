use photocraft_color::{ColorMode, PixelFormat};
use photocraft_doc::{Adjustment, LayerContent, LayerId};
use photocraft_geom::Rect;
use serde_json::{Value, json};

use crate::Session;

fn doc(w: u32, h: u32) -> Session {
    let mut s = Session::new();
    s.execute("file.new", json!({"width": w, "height": h})).unwrap();
    s
}

fn active_adjustment(s: &Session) -> Adjustment {
    let d = s.active().unwrap();
    match &d.doc.layer(d.active_layer.unwrap()).unwrap().content {
        LayerContent::Adjustment(a) => a.clone(),
        other => panic!("not an adjustment layer: {}", other.kind_name()),
    }
}

/// A busy pixel layer over the canvas, the active layer.
fn busy(s: &mut Session) -> LayerId {
    let d = s.active_mut().unwrap();
    let (w, h) = (d.doc.size.width, d.doc.size.height);
    let mut l = photocraft_doc::Layer::raster("busy", PixelFormat::RGBA8);
    let data: Vec<f32> = (0..w * h)
        .flat_map(|i| {
            let (x, y) = (i % w, i / w);
            [((x * 37 + y * 11) & 255) as f32 / 255.0, ((x * 5 + y * 23 + 40) & 255) as f32 / 255.0, (((x ^ y) * 9) & 255) as f32 / 255.0, 1.0]
        })
        .collect();
    l.surface_mut().unwrap().write_region(Rect::new(0, 0, w as i32, h as i32), &data);
    let id = l.id;
    std::sync::Arc::make_mut(&mut d.doc).layers.push(l);
    d.active_layer = Some(id);
    id
}

#[test]
fn params_read_clamp_and_round_trip() {
    for (kind, params, want) in [
        (
            "colorVibrance",
            json!({"temperature": 30, "tint": -10, "vibrance": 40}),
            Adjustment::ColorVibrance { temperature: 30.0, tint: -10.0, vibrance: 40.0, saturation: 0.0 },
        ),
        ("clarityDehaze", json!({"dehaze": -20}), Adjustment::ClarityDehaze { clarity: 0.0, dehaze: -20.0 }),
        ("grain", json!({"amount": 35, "seed": 7.4}), Adjustment::Grain { amount: 35.0, size: 25.0, roughness: 50.0, seed: 7 }),
    ] {
        let a = crate::adjust_params::from_params(kind, &params, None, ColorMode::Rgb).unwrap();
        assert_eq!(a, want, "{kind}");
        assert_eq!(crate::commands::adjustment_kind(&a), kind);
        let back = crate::adjust_params::from_params(kind, &crate::adjust_params::to_params(&a), None, ColorMode::Rgb).unwrap();
        assert_eq!(back, a, "{kind}: to_params is the inverse");
        // Over a base, only what is given changes.
        let over = crate::adjust_params::from_params(kind, &json!({}), Some(&a), ColorMode::Rgb).unwrap();
        assert_eq!(over, a);
    }
    for bad in [json!({"vibrance": "x"}), json!({"tint": [1]}), json!(5)] {
        assert!(crate::adjust_params::from_params("colorVibrance", &bad, None, ColorMode::Rgb).is_err(), "{bad}");
    }
    // Out of range is clamped, as every adjustment's numbers are.
    let clamped = |kind: &str, p: Value| crate::adjust_params::from_params(kind, &p, None, ColorMode::Rgb).unwrap();
    assert!(matches!(clamped("colorVibrance", json!({"temperature": 101})), Adjustment::ColorVibrance { temperature: 100.0, .. }));
    assert!(matches!(clamped("grain", json!({"seed": 0, "amount": -1})), Adjustment::Grain { seed: 1, amount: 0.0, .. }));
    assert!(matches!(clamped("grain", json!({"seed": 1e12})), Adjustment::Grain { seed: 99_999, .. }));
    // Defaults are neutral.
    assert_eq!(crate::adjust_params::default_for("grain", ColorMode::Rgb).unwrap(), Adjustment::Grain { amount: 0.0, size: 25.0, roughness: 50.0, seed: 1 });
}

/// The three commands make adjustment layers (one history step each) and edit pixels
/// destructively; Actions record them and play them back.
#[test]
fn commands_make_layers_edit_pixels_and_are_recorded() {
    let mut s = doc(40, 30);
    busy(&mut s);
    s.execute("actions.record", json!({"name": "Newer"})).unwrap();
    for (kind, params, label) in [
        ("colorVibrance", json!({"temperature": 40}), "Color and Vibrance"),
        ("clarityDehaze", json!({"clarity": 60, "dehaze": 30}), "Clarity and Dehaze"),
        ("grain", json!({"amount": 50}), "Grain"),
    ] {
        let before = s.active().unwrap().history.entries().len();
        s.execute(&format!("layer.newAdjustmentLayer.{kind}"), params.clone()).unwrap();
        assert_eq!(active_adjustment(&s).label(), label);
        assert_eq!(s.active().unwrap().history.entries().len(), before + 1, "{kind}: one step");
        let name = &s.active().unwrap().doc.layer(s.active().unwrap().active_layer.unwrap()).unwrap().name;
        assert!(name.starts_with(label), "{name}");
    }
    // Destructive on the pixel layer.
    let pixel = busy(&mut s);
    let read = |s: &Session| s.active().unwrap().doc.layer(pixel).unwrap().surface().unwrap().read_region(Rect::new(0, 0, 40, 30));
    let start = read(&s);
    s.execute("image.adjustments.grain", json!({"amount": 80, "size": 0})).unwrap();
    let grained = read(&s);
    assert_ne!(grained, start);
    s.execute("edit.undo", json!({})).unwrap();
    assert_eq!(read(&s), start, "one undo");
    s.execute("actions.stop", json!({})).unwrap();
    let steps: Vec<String> = s.execute("actions.get", json!({"action": "Newer"})).unwrap()["steps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|step| step[0].as_str().unwrap().to_string())
        .collect();
    for id in ["layer.newAdjustmentLayer.colorVibrance", "layer.newAdjustmentLayer.clarityDehaze", "layer.newAdjustmentLayer.grain", "image.adjustments.grain"]
    {
        assert!(steps.iter().any(|s| s == id), "{id} recorded: {steps:?}");
    }
    // Played back on a new document, the same layers appear.
    s.execute("file.new", json!({"width": 40, "height": 30})).unwrap();
    busy(&mut s);
    s.execute("actions.play", json!({"action": "Newer"})).unwrap();
    let kinds: Vec<&str> = s
        .active()
        .unwrap()
        .doc
        .layers
        .iter()
        .filter_map(|l| if let LayerContent::Adjustment(a) = &l.content { Some(crate::commands::adjustment_kind(a)) } else { None })
        .collect();
    assert_eq!(kinds, ["colorVibrance", "clarityDehaze", "grain"]);
}

/// Image › Adjustments › Clarity and Dehaze on a layer larger than a tile: tile by tile, each
/// tile reads its neighbours, so it equals the adjustment applied to the whole layer at once, the
/// canvas's edges included.
#[test]
fn destructive_clarity_dehaze_has_no_tile_seams() {
    let mut s = doc(300, 200);
    let id = busy(&mut s);
    let whole = {
        let surf = s.active().unwrap().doc.layer(id).unwrap().surface().unwrap().clone();
        let fmt = surf.format();
        let raw = surf.read_region(Rect::new(0, 0, 300, 200));
        let mut buf =
            photocraft_compose::Buffer { rect: Rect::new(0, 0, 300, 200), px: raw.chunks_exact(4).map(|p| photocraft_raster::to_rgba(&fmt, p)).collect() };
        let adj = Adjustment::ClarityDehaze { clarity: 70.0, dehaze: 40.0 };
        photocraft_compose::adjust::apply_in(&adj, &mut buf, photocraft_compose::adjust::Transfer::Srgb, None, ColorMode::Rgb);
        buf
    };
    s.execute("image.adjustments.clarityDehaze", json!({"clarity": 70, "dehaze": 40})).unwrap();
    let got = s.active().unwrap().doc.layer(id).unwrap().surface().unwrap().read_region(Rect::new(0, 0, 300, 200));
    // The canvas's edges replicate, as one pass over the whole image does (and the compositor).
    let mut worst = 0.0f32;
    for y in 0..200 {
        for x in 0..300 {
            let i = (y * 300 + x) as usize;
            for c in 0..3 {
                worst = worst.max((got[i * 4 + c] - whole.px[i][c]).abs());
            }
        }
    }
    assert!(worst <= 1.0 / 255.0, "{worst}");
}

/// The Adjustments panel's Film Grain adds Curves and Grain in a group; Vivid, Color and
/// Vibrance with Clarity and Dehaze; Remove Warm Cast a single Color and Vibrance.
#[test]
fn panel_presets_of_the_newer_kinds() {
    let mut s = doc(16, 12);
    let out = s.execute("layer.adjustmentPreset", json!({"group": "cinematic", "preset": "film-grain"})).unwrap();
    let d = &s.active().unwrap().doc;
    let group = d.layer(LayerId(out["layer"].as_u64().unwrap())).unwrap();
    assert_eq!(group.name, "Film Grain");
    let kinds: Vec<&str> = group
        .children()
        .unwrap()
        .iter()
        .map(|l| match &l.content {
            LayerContent::Adjustment(a) => crate::commands::adjustment_kind(a),
            _ => "?",
        })
        .collect();
    assert_eq!(kinds, ["curves", "grain"]);
    let out = s.execute("layer.adjustmentPreset", json!({"group": "photo-repair", "preset": "cool-cast"})).unwrap();
    assert_eq!(out["layers"].as_array().map(Vec::len), Some(1));
    assert_eq!(active_adjustment(&s), Adjustment::ColorVibrance { temperature: -20.0, tint: 0.0, vibrance: 0.0, saturation: 0.0 });
    let names: Vec<&str> = crate::presets::adjustments::panel::PANEL_PRESETS.iter().flat_map(|g| g.presets.iter().map(|p| p.name)).collect();
    assert_eq!(names.len(), 18, "the JavaScript app's 18");
    for n in ["Bright and Warm", "Soft Skin", "Vivid", "Clear Distance", "Remove Warm Cast", "Vintage Fade", "Film Grain"] {
        assert!(names.contains(&n), "{n}");
    }
}

/// The compositor's copy of Camera Raw's white-balance gains (compose does not depend on algo)
/// is Camera Raw's.
#[test]
fn gains_match_camera_raw() {
    for (t, n) in [(0.0, 0.0), (50.0, 0.0), (-100.0, 30.0), (12.5, -80.0), (100.0, 100.0)] {
        assert_eq!(photocraft_compose::adjust_extra::white_balance_gains(t, n), photocraft_algo::camera_raw::white_balance_gains(t, n), "{t} {n}");
    }
}

/// Adversarial params never panic (the panic hunt covers the commands too).
#[test]
fn hostile_params_are_refused_not_panics() {
    let mut s = doc(8, 8);
    for kind in ["colorVibrance", "clarityDehaze", "grain"] {
        for p in [json!({"temperature": f64::MAX}), json!({"seed": 1e300}), json!({"clarity": null}), json!([1]), Value::Null] {
            let _ = s.execute(&format!("layer.newAdjustmentLayer.{kind}"), p.clone());
            let _ = s.execute(&format!("image.adjustments.{kind}"), p);
        }
    }
}
