use photocraft_algo::tone::auto_options::{AutoAlgorithm, AutoOptions};
use serde_json::{Value, json};

use super::{AdjustmentPrefs, AutoOptionsPrefs};
use crate::Session;

fn paint(s: &mut Session, f: impl Fn(i32, i32) -> [f32; 4]) {
    s.edit("setup", |doc, active| {
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

/// A low-contrast image with a blue cast: every channel about 0.3..0.65, blue higher.
fn cast_image(x: i32, y: i32) -> [f32; 4] {
    let v = 0.3 + (x + y * 32) as f32 / (32.0 * 24.0) * 0.3;
    [v, v * 0.95 + 0.01, (v * 1.1 + 0.03).min(1.0), 1.0]
}

fn doc(f: impl Fn(i32, i32) -> [f32; 4]) -> Session {
    let mut s = Session::new();
    s.execute("file.new", json!({"width": 32, "height": 24})).unwrap();
    paint(&mut s, f);
    s
}

fn pixels(s: &Session) -> Vec<[f32; 4]> {
    let d = s.active().unwrap();
    let surf = d.doc.layer(d.active_layer.unwrap()).unwrap().surface().unwrap();
    let b = d.doc.bounds();
    (b.y0..b.y1).flat_map(|y| (b.x0..b.x1).map(move |x| (x, y))).map(|(x, y)| surf.rgba(x, y)).collect()
}

fn history(s: &Session) -> usize {
    s.active().unwrap().history.entries().len()
}

#[test]
fn options_are_read_clamped_and_written_in_the_preferences_form() {
    let o: AutoOptionsPrefs =
        serde_json::from_value(json!({"algorithm": "darkLight", "shadowClip": 50, "highlightClip": -1, "midtoneColor": "#8a8080"})).unwrap();
    assert_eq!(o.0.algorithm, AutoAlgorithm::DarkLight);
    assert_eq!((o.0.shadow_clip, o.0.highlight_clip), (9.99, 0.0));
    assert_eq!(o.0.midtone, [0x8a, 0x80, 0x80]);
    assert_eq!(
        serde_json::to_value(AutoOptionsPrefs::default()).unwrap(),
        json!({"algorithm": "perChannel", "snapNeutralMidtones": false, "shadowClip": 0.1, "highlightClip": 0.1, "shadowColor": "#000000", "midtoneColor": "#808080", "highlightColor": "#ffffff"})
    );
    // The JavaScript app's keys (settings migrated from Pigment 0.4).
    let js: AutoOptionsPrefs = serde_json::from_value(json!({"algorithm": "mono", "snap": true, "midColor": "#7f7f7f"})).unwrap();
    assert_eq!((js.0.algorithm, js.0.snap_neutral, js.0.midtone), (AutoAlgorithm::Monochromatic, true, [0x7f; 3]));
    assert!(serde_json::from_value::<AutoOptionsPrefs>(json!({"algorithm": "best"})).is_err());
    assert!(serde_json::from_value::<AutoOptionsPrefs>(json!({"shadowColor": "black"})).is_err());

    // prefs.set validates through the same type: 50 % is clamped to 9.99, a bad colour refused.
    let mut s = Session::new();
    s.execute("prefs.set", json!({"path": "adjustments.autoOptions.shadowClip", "value": 50})).unwrap();
    assert_eq!(s.prefs().adjustments.auto_options.0.shadow_clip, 9.99);
    assert_eq!(s.execute("prefs.get", json!({"path": "adjustments.autoOptions.shadowClip"})).unwrap(), json!(9.99));
    assert!(s.execute("prefs.set", json!({"path": "adjustments.autoOptions.highlightColor", "value": "white"})).is_err());
    assert!(s.execute("prefs.set", json!({"path": "adjustments.autoOptions.algorithm", "value": 3})).is_err());
    s.execute("prefs.reset", json!({"path": "adjustments"})).unwrap();
    assert_eq!(s.prefs().adjustments, AdjustmentPrefs::default());
}

#[test]
fn the_options_command_reads_saves_and_resets() {
    let mut s = Session::new();
    let r = s.execute("image.adjustments.autoOptions", json!({})).unwrap();
    assert_eq!(r["saved"], json!(false));
    assert_eq!(r["options"]["algorithm"], json!("perChannel"));
    // Options alone are only checked and merged.
    let r = s.execute("image.adjustments.autoOptions", json!({"options": {"algorithm": "monochromatic", "shadowClip": 12}})).unwrap();
    assert_eq!(
        (r["options"]["algorithm"].clone(), r["options"]["shadowClip"].clone(), r["saved"].clone()),
        (json!("monochromatic"), json!(9.99), json!(false))
    );
    assert_eq!(s.prefs().adjustments, AdjustmentPrefs::default());
    let r = s
        .execute("image.adjustments.autoOptions", json!({"options": {"algorithm": "darkLight", "snapNeutralMidtones": true}, "saveAsDefaults": true}))
        .unwrap();
    assert_eq!(r["saved"], json!(true));
    assert!(s.prefs().adjustments.auto_options_saved);
    assert_eq!(s.prefs().adjustments.auto_options.0.algorithm, AutoAlgorithm::DarkLight);
    // Later options lie over the saved ones.
    let r = s.execute("image.adjustments.autoOptions", json!({"options": {"highlightClip": 1}})).unwrap();
    assert_eq!((r["options"]["algorithm"].clone(), r["options"]["highlightClip"].clone()), (json!("darkLight"), json!(1.0)));
    for bad in [json!({"options": 3}), json!({"options": {"algorithm": "x"}}), json!({"saveAsDefaults": "yes"}), json!({"options": {"shadowColor": "#12"}})] {
        assert!(s.execute("image.adjustments.autoOptions", bad.clone()).is_err(), "{bad}");
    }
    assert!(s.prefs().adjustments.auto_options_saved, "a refused call changes nothing");
    s.execute("image.adjustments.autoOptions", json!({"reset": true})).unwrap();
    assert_eq!(s.prefs().adjustments, AdjustmentPrefs::default());
    assert!(s.journal.is_empty(), "never journaled");
}

#[test]
fn saved_options_survive_the_settings_store() {
    let mut s = Session::new();
    let o = json!({"algorithm": "brightnessContrast", "snapNeutralMidtones": true, "shadowClip": 0.5, "highlightClip": 2.25, "shadowColor": "#101010", "midtoneColor": "#8c8080", "highlightColor": "#f0f0f0"});
    s.execute("image.adjustments.autoOptions", json!({"options": o, "saveAsDefaults": true})).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let (mut store, _) = craft::settings::SettingsStore::<crate::prefs::SavedPrefs>::open_at(dir.path());
    store.set(s.saved_prefs());
    store.flush().unwrap();
    let text = std::fs::read_to_string(dir.path().join("config.toml")).unwrap();
    assert!(text.contains("autoOptionsSaved") && text.contains("brightnessContrast"), "{text}");
    let (store, _) = craft::settings::SettingsStore::<crate::prefs::SavedPrefs>::open_at(dir.path());
    let mut t = Session::new();
    t.set_saved_prefs(store.get().clone());
    assert_eq!(t.prefs().adjustments, s.prefs().adjustments);
    assert_eq!(t.execute("image.adjustments.autoOptions", json!({})).unwrap()["options"], o);
}

#[test]
fn auto_params_read_the_layer_and_change_nothing() {
    let mut s = doc(cast_image);
    let rev = s.active().unwrap().revision;
    let levels = s.execute("image.adjustments.auto", json!({"kind": "levels"})).unwrap();
    // Per Channel Contrast (the default): each channel's own ends.
    for key in ["red", "green", "blue"] {
        let ch = &levels[key];
        assert!(ch["inBlack"].as_f64().unwrap() > 60.0 && ch["inWhite"].as_f64().unwrap() < 200.0, "{key}: {ch}");
    }
    assert!(levels["blue"]["inBlack"].as_f64() > levels["red"]["inBlack"].as_f64());
    // Curves: the same ends as points, and the curve is applied by image.adjustments.curves.
    let curves = s.execute("image.adjustments.auto", json!({"kind": "curves"})).unwrap();
    assert_eq!(curves["red"][0][0], levels["red"]["inBlack"]);
    assert_eq!(curves["red"][1], json!([levels["red"]["inWhite"], 255.0]));
    assert_eq!(curves["points"], json!([[0.0, 0.0], [255.0, 255.0]]));
    // Brightness/Contrast: a dark low-contrast image gets brighter and more contrasty.
    let bc = s.execute("image.adjustments.auto", json!({"kind": "brightnessContrast"})).unwrap();
    assert!(bc["contrast"].as_i64().unwrap() > 0 && bc["brightness"].as_i64().unwrap() > 0, "{bc}");
    assert_eq!(bc["legacy"], json!(false));
    // Explicit options: Monochromatic puts one stretch in the composite.
    let mono = s.execute("image.adjustments.auto", json!({"kind": "levels", "options": {"algorithm": "monochromatic"}})).unwrap();
    assert!(mono.get("red").is_none() && mono["inBlack"].as_f64().unwrap() > 60.0, "{mono}");
    assert_eq!(s.active().unwrap().revision, rev, "nothing changes");
    // Each result is valid params of its command.
    for (kind, p) in [("levels", &levels), ("curves", &curves), ("brightnessContrast", &bc), ("levels", &mono)] {
        crate::adjust_params::from_params(kind, p, None, photocraft_color::ColorMode::Rgb).unwrap_or_else(|e| panic!("{kind}: {e}"));
    }
    for bad in [json!({"kind": "hueSaturation"}), json!({"layer": 999}), json!({"layer": "x"}), json!({"filter": 0}), json!({"options": {"algorithm": 1}})] {
        assert!(s.execute("image.adjustments.auto", bad.clone()).is_err(), "{bad}");
    }
}

#[test]
fn auto_on_an_adjustment_layer_reads_the_image_below() {
    let mut s = doc(cast_image);
    let base = s.execute("image.adjustments.auto", json!({"kind": "levels"})).unwrap();
    let id = s.execute("layer.newAdjustmentLayer.levels", json!({})).unwrap()["layer"].as_u64().unwrap();
    assert_eq!(s.execute("image.adjustments.auto", json!({"kind": "levels", "layer": id})).unwrap(), base);
    // A layer above it is not what it adjusts.
    s.execute("layer.new.layer", json!({})).unwrap();
    paint(&mut s, |_, _| [0.0, 0.0, 0.0, 1.0]);
    assert_eq!(s.execute("image.adjustments.auto", json!({"kind": "levels", "layer": id})).unwrap(), base);
}

#[test]
fn auto_is_a_no_op_on_an_image_that_spans_the_range() {
    let mut s = doc(|x, _| {
        let v = x as f32 / 31.0;
        [v, v, v, 1.0]
    });
    let levels = s.execute("image.adjustments.auto", json!({"kind": "levels"})).unwrap();
    for key in ["red", "green", "blue"] {
        assert_eq!((levels[key]["inBlack"].as_f64(), levels[key]["inWhite"].as_f64()), (Some(0.0), Some(255.0)), "{levels}");
    }
    let curves = s.execute("image.adjustments.auto", json!({"kind": "curves"})).unwrap();
    assert_eq!(curves["red"], json!([[0.0, 0.0], [255.0, 255.0]]));
    let bc = s.execute("image.adjustments.auto", json!({"kind": "brightnessContrast"})).unwrap();
    assert_eq!(bc["contrast"], json!(0));
    // The median of a 32-step ramp is a few levels off the middle: Brightness moves by as little.
    assert!(bc["brightness"].as_i64().unwrap().abs() <= 5, "{bc}");
}

#[test]
fn image_auto_keeps_upstreams_rule_until_options_are_saved() {
    // Nothing saved and no options: upstream's Auto runs (the hook steps aside).
    let s = doc(cast_image);
    assert_eq!(super::command_options(&s, "color", &json!({})).unwrap(), None);
    assert_eq!(super::command_options(&s, "color", &json!({"target": "pixels"})).unwrap(), None);
    let mut upstream = doc(cast_image);
    upstream.execute("image.autoColor", json!({})).unwrap();
    // Saved options change what Auto Color does.
    let mut saved = doc(cast_image);
    saved.execute("image.adjustments.autoOptions", json!({"saveAsDefaults": true})).unwrap();
    saved.execute("image.autoColor", json!({})).unwrap();
    assert_ne!(pixels(&upstream), pixels(&saved));
    assert_ne!(pixels(&upstream), pixels(&doc(cast_image)));
}

#[test]
fn image_auto_color_with_saved_options_is_levels_with_the_auto_params() {
    for (cmd, algorithm, snap) in
        [("image.autoColor", "darkLight", true), ("image.autoTone", "perChannel", false), ("image.autoContrast", "monochromatic", false)]
    {
        let mut s = doc(cast_image);
        let saved = json!({"shadowClip": 1.5, "highlightClip": 0.5, "shadowColor": "#100808", "highlightColor": "#f8f0f0"});
        s.execute("image.adjustments.autoOptions", json!({"options": saved, "saveAsDefaults": true})).unwrap();
        let mut options = saved.clone();
        options["algorithm"] = json!(algorithm);
        options["snapNeutralMidtones"] = json!(snap);
        let params = s.execute("image.adjustments.auto", json!({"kind": "levels", "options": options})).unwrap();
        let mut t = doc(cast_image);
        t.execute("image.adjustments.levels", params.clone()).unwrap();
        let before = history(&s);
        s.execute(cmd, json!({})).unwrap();
        assert_eq!(history(&s), before + 1, "{cmd}: one history step");
        assert_eq!(pixels(&s), pixels(&t), "{cmd} with saved options = Levels {params}");
        // Undo and redo.
        let after = pixels(&s);
        s.undo();
        assert_eq!(pixels(&s), pixels(&doc(cast_image)));
        s.redo();
        assert_eq!(pixels(&s), after);
    }
}

#[test]
fn image_auto_takes_explicit_options_for_actions() {
    let mut s = doc(cast_image);
    let p = json!({"algorithm": "monochromatic", "shadowClip": 2, "highlightClip": 2});
    s.execute("image.autoTone", p.clone()).unwrap();
    assert_eq!(s.journal.last().map(|(id, p)| (id.clone(), p.clone())), Some(("image.autoTone".to_string(), p.clone())));
    let params = doc(cast_image).execute("image.adjustments.auto", json!({"kind": "levels", "options": p})).unwrap();
    let mut t = doc(cast_image);
    t.execute("image.adjustments.levels", params).unwrap();
    assert_eq!(pixels(&s), pixels(&t));
    assert!(s.execute("image.autoTone", json!({"algorithm": "nope"})).is_err());
    assert!(s.execute("image.autoTone", json!({"shadowColor": 7})).is_err());
}

#[test]
fn command_options_follow_photoshops_per_command_algorithms() {
    let mut s = Session::new();
    assert_eq!(super::command_options(&s, "tone", &json!({})).unwrap(), None);
    s.execute("image.adjustments.autoOptions", json!({"options": {"algorithm": "brightnessContrast", "shadowClip": 3}, "saveAsDefaults": true})).unwrap();
    let tone = super::command_options(&s, "tone", &json!({})).unwrap().unwrap();
    let contrast = super::command_options(&s, "contrast", &Value::Null).unwrap().unwrap();
    let color = super::command_options(&s, "color", &json!({})).unwrap().unwrap();
    assert_eq!((tone.algorithm, tone.snap_neutral, tone.shadow_clip), (AutoAlgorithm::PerChannel, false, 3.0));
    assert_eq!((contrast.algorithm, contrast.snap_neutral), (AutoAlgorithm::Monochromatic, false));
    assert_eq!((color.algorithm, color.snap_neutral), (AutoAlgorithm::DarkLight, true));
    let explicit = super::command_options(&s, "color", &json!({"snapNeutralMidtones": false})).unwrap().unwrap();
    assert!(!explicit.snap_neutral);
    assert_eq!(AutoOptions::default().algorithm, AutoAlgorithm::PerChannel);
}

#[test]
fn hostile_params_never_panic() {
    let mut s = doc(cast_image);
    let wild = [
        json!(null),
        json!([]),
        json!({"options": {"shadowClip": 1e308, "highlightClip": -1e308}}),
        json!({"options": {"shadowClip": "x"}}),
        json!({"kind": 5}),
        json!({"layer": -1}),
        json!({"layer": u64::MAX}),
        json!({"filter": 1e20}),
        json!({"options": {"algorithm": null, "snapNeutralMidtones": 3}}),
    ];
    for p in &wild {
        for cmd in ["image.adjustments.auto", "image.adjustments.autoOptions", "image.autoTone", "image.autoColor", "image.autoContrast"] {
            let _ = s.execute(cmd, p.clone());
        }
    }
    // An empty (transparent) layer gives the identity, not an error.
    let mut t = Session::new();
    t.execute("file.new", json!({"width": 8, "height": 8, "background": "transparent"})).unwrap();
    let r = t.execute("image.adjustments.auto", json!({})).unwrap();
    assert_eq!(r, json!({"inBlack": 0.0, "inWhite": 255.0, "gamma": 1.0, "outBlack": 0.0, "outWhite": 255.0}));
}

#[test]
fn other_modes_take_the_luminosity_stretch() {
    let mut s = Session::new();
    s.execute("file.new", json!({"width": 32, "height": 24, "mode": "grayscale"})).unwrap();
    paint(&mut s, cast_image);
    let r = s.execute("image.adjustments.auto", json!({"kind": "levels", "options": {"algorithm": "darkLight"}})).unwrap();
    assert!(r.get("red").is_none() && r["inBlack"].as_f64().unwrap() > 50.0, "{r}");
    crate::adjust_params::from_params("levels", &r, None, photocraft_color::ColorMode::Grayscale).unwrap();
}
