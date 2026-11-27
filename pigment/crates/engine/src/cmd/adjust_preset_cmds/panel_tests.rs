use photocraft_doc::{Adjustment, LayerContent, LayerId};
use serde_json::{Value, json};

use crate::Session;
use crate::presets::adjustments::panel::{PANEL_KIND, PANEL_PRESETS, YOUR_PRESETS, builtin_layers, for_mode};

fn doc(mode: Option<&str>) -> Session {
    let mut s = Session::new();
    let mut p = json!({"width": 16, "height": 12});
    if let Some(mode) = mode {
        p["mode"] = json!(mode);
    }
    s.execute("file.new", p).unwrap();
    s
}

fn history(s: &Session) -> usize {
    s.active().unwrap().history.entries().len()
}

fn top_names(s: &Session) -> Vec<String> {
    s.active().unwrap().doc.layers.iter().map(|l| l.name.clone()).collect()
}

fn adjustment(s: &Session, id: u64) -> Adjustment {
    match &s.active().unwrap().doc.layer(LayerId(id)).unwrap().content {
        LayerContent::Adjustment(a) => a.clone(),
        other => panic!("not an adjustment layer: {other:?}"),
    }
}

#[test]
fn every_built_in_panel_preset_adds_its_layers() {
    for group in PANEL_PRESETS {
        for preset in group.presets {
            let mut s = doc(None);
            let before = history(&s);
            let out = s.execute("layer.adjustmentPreset", json!({"group": group.id, "preset": preset.id})).unwrap_or_else(|e| panic!("{}: {e}", preset.name));
            let layers: Vec<u64> = out["layers"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap()).collect();
            assert_eq!(layers.len(), preset.layers.len(), "{}", preset.name);
            for (id, layer) in layers.iter().zip(builtin_layers(preset)) {
                let a = adjustment(&s, *id);
                assert_eq!(crate::commands::adjustment_kind(&a), layer.kind, "{}", preset.name);
                // The preset's settings, over the kind's defaults.
                let expected = crate::adjust_params::from_params(&layer.kind, &layer.params, None, photocraft_color::ColorMode::Rgb).unwrap();
                assert_eq!(a, expected, "{}", preset.name);
                assert!(s.active().unwrap().doc.layer(LayerId(*id)).unwrap().mask.is_some(), "{}: a new adjustment layer has a mask", preset.name);
            }
            assert_eq!(history(&s), before + 1, "{}: one history step", preset.name);
            assert_eq!(s.active().unwrap().active_layer, Some(LayerId(out["layer"].as_u64().unwrap())));
        }
    }
}

#[test]
fn several_layers_go_into_a_group_named_after_the_preset_and_undo_in_one_step() {
    let mut s = doc(None);
    let before = top_names(&s);
    let out = s.execute("layer.adjustmentPreset", json!({"group": "cinematic", "preset": "moody"})).unwrap();
    assert_eq!(out["name"], "Moody");
    let d = &s.active().unwrap().doc;
    let group = d.layer(LayerId(out["layer"].as_u64().unwrap())).unwrap();
    assert_eq!(group.name, "Moody");
    let children: Vec<&str> = group.children().unwrap().iter().map(|l| l.name.as_str()).collect();
    // Bottom first: Curves under Hue/Saturation.
    assert_eq!(children, ["Curves 1", "Hue/Saturation 1"]);
    assert_eq!(s.active().unwrap().history.entries().last().map(|e| e.to_string()).as_deref(), Some("Adjustment Preset: Moody"));
    s.execute("edit.undo", json!({})).unwrap();
    assert_eq!(top_names(&s), before, "one undo removes the group and its layers");
    s.execute("edit.redo", json!({})).unwrap();
    assert_eq!(top_names(&s).last().unwrap(), "Moody");
}

#[test]
fn a_single_layer_preset_adds_no_group() {
    let mut s = doc(None);
    let n = s.active().unwrap().doc.layers.len();
    let out = s.execute("layer.adjustmentPreset", json!({"group": "photo-repair", "preset": "lift-shadows"})).unwrap();
    let d = &s.active().unwrap().doc;
    assert_eq!(d.layers.len(), n + 1);
    let l = d.layer(LayerId(out["layer"].as_u64().unwrap())).unwrap();
    assert!(!l.is_group());
    assert_eq!(l.name, "Curves 1");
    // A second one is numbered on.
    s.execute("layer.adjustmentPreset", json!({"group": "photo-repair", "preset": "lift-shadows"})).unwrap();
    assert_eq!(top_names(&s).last().unwrap(), "Curves 2");
}

#[test]
fn every_layer_of_a_preset_takes_the_selection_as_its_mask() {
    let mut s = doc(None);
    s.execute("select.rect", json!({"x": 2, "y": 2, "width": 4, "height": 4})).unwrap();
    let out = s.execute("layer.adjustmentPreset", json!({"group": "cinematic", "preset": "moody"})).unwrap();
    let d = &s.active().unwrap().doc;
    for id in out["layers"].as_array().unwrap() {
        let mask = d.layer(LayerId(id.as_u64().unwrap())).unwrap().mask.as_ref().unwrap();
        assert_eq!(mask.value(3, 3), 1.0);
        assert_eq!(mask.value(10, 10), 0.0);
    }
    assert!(d.selection.is_none(), "the selection went into the masks");
}

#[test]
fn channel_curves_follow_the_document_mode() {
    let p = json!({"points": [[0, 0], [255, 255]], "red": [[0, 10], [255, 255]], "green": [[0, 20], [255, 255]], "blue": [[0, 30], [255, 255]]});
    let cmyk = for_mode("curves", &p, photocraft_color::ColorMode::Cmyk);
    assert_eq!((cmyk.get("red"), &cmyk["cyan"], &cmyk["yellow"]), (None, &p["red"], &p["blue"]));
    let lab = for_mode("curves", &p, photocraft_color::ColorMode::Lab);
    assert_eq!((&lab["a"], &lab["b"], lab.get("blue")), (&p["red"], &p["green"], None));
    let gray = for_mode("curves", &p, photocraft_color::ColorMode::Grayscale);
    assert_eq!(gray, json!({"points": [[0, 0], [255, 255]]}));
    assert_eq!(for_mode("curves", &p, photocraft_color::ColorMode::Rgb), p);
    assert_eq!(for_mode("hueSaturation", &json!({"red": 1}), photocraft_color::ColorMode::Cmyk), json!({"red": 1}));
    // Cross Process in a CMYK document is a CMYK curve.
    let mut s = doc(Some("cmyk"));
    let out = s.execute("layer.adjustmentPreset", json!({"group": "creative", "preset": "cross-process"})).unwrap();
    let a = adjustment(&s, out["layer"].as_u64().unwrap());
    assert!(matches!(a, Adjustment::Curves { space: photocraft_doc::adjust::ToneSpace::Cmyk, .. }), "{a:?}");
}

#[test]
fn your_presets_save_the_selected_adjustment_layers_and_add_them_again() {
    let mut s = doc(None);
    let before = history(&s);
    s.execute("layer.newAdjustmentLayer.levels", json!({"inBlack": 12})).unwrap();
    s.execute("layer.newAdjustmentLayer.exposure", json!({"exposure": 0.5, "name": "Brighter"})).unwrap();
    let ids: Vec<u64> = s.active().unwrap().doc.layers.iter().rev().take(2).map(|l| l.id.0).collect();
    s.execute("layer.select", json!({"layers": ids})).unwrap();
    let steps = history(&s);
    let saved = s.execute("layer.saveAdjustmentPreset", json!({"name": "Mine"})).unwrap();
    assert_eq!(saved, json!({"name": "Mine", "layers": 2, "replaced": false}));
    assert_eq!(history(&s), steps, "saving a preset is no document edit");
    assert!(s.presets.adjustments.find(PANEL_KIND, Some("Mine"), None).is_some());
    let out = s.execute("layer.adjustmentPreset", json!({"group": YOUR_PRESETS, "preset": "Mine"})).unwrap();
    let group = s.active().unwrap().doc.layer(LayerId(out["layer"].as_u64().unwrap())).unwrap();
    let kids: Vec<(&str, &str)> = group
        .children()
        .unwrap()
        .iter()
        .map(|l| match &l.content {
            LayerContent::Adjustment(a) => (crate::commands::adjustment_kind(a), l.name.as_str()),
            _ => ("?", ""),
        })
        .collect();
    assert_eq!(kids, [("levels", "Levels 1"), ("exposure", "Brighter")]);
    let levels = adjustment(&s, out["layers"][0].as_u64().unwrap());
    assert_eq!(crate::adjust_params::to_params(&levels)["inBlack"], json!(12.0));
    assert!(history(&s) > before);
    // Delete removes it.
    s.execute("layer.deleteAdjustmentPreset", json!({"name": "Mine"})).unwrap();
    assert!(s.execute("layer.adjustmentPreset", json!({"group": YOUR_PRESETS, "preset": "Mine"})).is_err());
}

#[test]
fn your_presets_survive_the_settings_file() {
    let mut s = doc(None);
    s.execute("layer.newAdjustmentLayer.threshold", json!({"level": 100})).unwrap();
    s.execute("layer.saveAdjustmentPreset", json!({"name": "Hard"})).unwrap();
    let saved = s.presets.to_json(&s);
    let mut t = Session::new();
    t.load_presets_json(saved);
    t.execute("file.new", json!({"width": 4, "height": 4})).unwrap();
    let out = t.execute("layer.adjustmentPreset", json!({"group": YOUR_PRESETS, "preset": "Hard"})).unwrap();
    assert!(matches!(adjustment(&t, out["layer"].as_u64().unwrap()), Adjustment::Threshold { .. }));
}

#[test]
fn saving_needs_adjustment_layers() {
    let mut s = doc(None);
    let e = s.execute("layer.saveAdjustmentPreset", json!({"name": "None"})).unwrap_err().to_string();
    assert!(e.contains("adjustment layers"), "{e}");
    let bg = s.active().unwrap().doc.layers[0].id.0;
    assert!(s.execute("layer.saveAdjustmentPreset", json!({"name": "X", "layers": [bg]})).is_err());
    assert!(s.execute("layer.saveAdjustmentPreset", json!({"name": "X", "layers": [987654]})).is_err());
    assert!(s.execute("layer.saveAdjustmentPreset", json!({"name": "  "})).is_err());
}

#[test]
fn bad_panel_preset_params_are_errors_not_panics() {
    let mut s = doc(None);
    for p in [
        json!({}),
        json!({"group": "cinematic"}),
        json!({"group": "cinematic", "preset": "nope"}),
        json!({"group": "nope", "preset": "moody"}),
        json!({"group": YOUR_PRESETS, "preset": "nope"}),
        json!({"group": 3, "preset": []}),
    ] {
        assert!(s.execute("layer.adjustmentPreset", p.clone()).is_err(), "{p}");
    }
    // A damaged saved preset (an unknown kind, bad settings) is refused when applied, not saved over.
    let _ = s.presets.adjustments.save(PANEL_KIND, "Broken", json!({"layers": [{"kind": "nope", "params": {}}]}), None);
    let _ = s.presets.adjustments.save(PANEL_KIND, "Bad", json!({"layers": [{"kind": "levels", "params": {"gamma": "x"}}]}), None);
    let _ = s.presets.adjustments.save(PANEL_KIND, "Empty", json!({"layers": Value::Null}), None);
    let steps = history(&s);
    for name in ["Broken", "Bad", "Empty"] {
        assert!(s.execute("layer.adjustmentPreset", json!({"group": YOUR_PRESETS, "preset": name})).is_err(), "{name}");
    }
    assert_eq!(history(&s), steps);
}
