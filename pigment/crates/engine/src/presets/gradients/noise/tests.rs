use serde_json::json;

use crate::Session;
use photocraft_doc::effects::{Effect, FxPaint};
use photocraft_doc::{Adjustment, Fill, LayerContent, NoiseGradient, NoiseModel};

fn session() -> Session {
    let mut s = Session::new();
    s.execute("file.new", json!({"width": 64, "height": 16})).unwrap();
    s
}

fn history_len(s: &Session) -> usize {
    s.active().unwrap().history.past_len()
}

fn active_content(s: &Session) -> LayerContent {
    let d = s.active().unwrap();
    d.doc.layer(d.active_layer.unwrap()).unwrap().content.clone()
}

fn fill_noise(s: &Session) -> (Vec<(f32, photocraft_doc::Color)>, Option<NoiseGradient>) {
    match active_content(s) {
        LayerContent::Fill(Fill::Gradient { stops, noise, .. }) => (stops, noise),
        other => panic!("not a gradient fill: {}", other.kind_name()),
    }
}

/// How many neighbouring pixels of the composite's first row differ visibly.
fn changes_along_row(s: &Session) -> usize {
    let px = photocraft_compose::flatten(&s.active().unwrap().doc).into_px();
    px.iter().take(64).collect::<Vec<_>>().windows(2).filter(|w| (0..3).any(|c| (w[0][c] - w[1][c]).abs() > 0.02)).count()
}

const NOISE: &str = "noise";

#[test]
fn the_tool_gradient_takes_noise_through_stop_set_and_it_persists() {
    let mut s = Session::new();
    let r = s.execute("gradient.presets.stop", json!({"action": "set", NOISE: {"roughness": 80, "model": "hsb", "seed": 9, "restrict": true}})).unwrap();
    let n = s.presets.gradient.noise.clone().expect("a noise gradient");
    assert_eq!((n.model, n.seed, n.restrict, (n.roughness * 100.0).round()), (NoiseModel::Hsb, 9, true, 80.0));
    assert_eq!(r["current"][NOISE]["seed"], 9);
    assert_eq!(s.presets.gradient.stops.len(), n.bake().0.len(), "the stops are its bake");
    // Partial settings keep the rest (Randomize sends a seed only).
    s.execute("gradient.presets.stop", json!({"action": "set", NOISE: {"seed": 10}})).unwrap();
    let m = s.presets.gradient.noise.clone().unwrap();
    assert_eq!((m.seed, m.model, m.restrict), (10, NoiseModel::Hsb, true));
    // Saved with the preferences and loaded back.
    let saved = s.prefs_value();
    let mut t = Session::new();
    t.load_prefs_json(&saved.to_string()).unwrap();
    assert_eq!(t.presets.gradient, s.presets.gradient);
    // Solid again: the knots become stops; a stop edit of a noise gradient makes it solid too.
    s.execute("gradient.presets.stop", json!({"action": "set", NOISE: false})).unwrap();
    assert!(s.presets.gradient.noise.is_none());
    assert_eq!(s.presets.gradient.stops.len(), m.knot_stops().len());
    s.execute("gradient.presets.stop", json!({"action": "set", NOISE: {"seed": 3}})).unwrap();
    s.execute("gradient.presets.stop", json!({"action": "color", "index": 0, "color": "#ff0000"})).unwrap();
    assert!(s.presets.gradient.noise.is_none());
    // Preferences without noise are written exactly as before.
    let plain = Session::new().prefs_value();
    assert!(plain["presets"]["gradient"].get("noise").is_none(), "no noise key for solid gradients: {}", plain["presets"]["gradient"]);
}

#[test]
fn presets_fills_and_the_gradient_tool_paint_noise() {
    let mut s = session();
    s.execute("gradient.presets.new", json!({"name": "Noisy", "group": "Mine", NOISE: {"roughness": 100, "seed": 4}})).unwrap();
    let g = s.presets.gradients.iter().flat_map(|g| &g.items).find(|g| g.name == "Noisy").unwrap().clone();
    assert!(g.noise.is_some());
    // A Gradient Fill layer from the preset keeps the settings.
    let h = history_len(&s);
    s.execute("gradient.fill.create", json!({"from": [0, 8], "to": [64, 8], "gradient": "Noisy"})).unwrap();
    assert_eq!(history_len(&s), h + 1);
    let (stops, noise) = fill_noise(&s);
    assert_eq!(noise, g.noise);
    assert!(stops.len() > 20);
    assert!(changes_along_row(&s) > 20, "a rough noise gradient changes colour along the row");
    // Editing the settings is one history step, rebakes the stops, and reads back.
    let h = history_len(&s);
    let got = s.execute("gradient.fill.set", json!({NOISE: {"seed": 5}})).unwrap();
    assert_eq!(history_len(&s), h + 1);
    assert_eq!(got[NOISE]["seed"], 5);
    let (stops2, noise2) = fill_noise(&s);
    assert_eq!(noise2.as_ref().map(|n| n.seed), Some(5));
    assert_ne!(stops2, stops);
    // `.pcraft` keeps the settings, and undo and redo step over the edit.
    let bytes = photocraft_format::save_to_bytes(&s.active().unwrap().doc, &Default::default()).unwrap();
    let doc = photocraft_format::load_from_bytes(&bytes).unwrap();
    let back = doc.layers.iter().find(|l| matches!(l.content, LayerContent::Fill(_))).unwrap();
    assert_eq!(back.content, active_content(&s));
    s.execute("edit.undo", json!({})).unwrap();
    assert_eq!(fill_noise(&s).1, g.noise);
    s.execute("edit.redo", json!({})).unwrap();
    assert_eq!(fill_noise(&s).1.map(|n| n.seed), Some(5));
    // A stop edit makes it solid; `noise: false` too, with the knots as stops.
    s.execute("gradient.fill.set", json!({NOISE: {"seed": 6}})).unwrap();
    s.execute("gradient.fill.stop", json!({"action": "color", "index": 0, "color": "#00ff00"})).unwrap();
    assert!(fill_noise(&s).1.is_none());
    s.execute("gradient.fill.set", json!({NOISE: {"roughness": 0}})).unwrap();
    s.execute("gradient.fill.set", json!({NOISE: false})).unwrap();
    let (stops, noise) = fill_noise(&s);
    assert!(noise.is_none() && stops.len() == 3, "roughness 0: three knots");
    assert!(s.execute("gradient.fill.get", json!({})).unwrap().get(NOISE).is_none());
    // The destructive Gradient tool paints the same gradient, deterministically.
    s.execute("layer.new.layer", json!({})).unwrap();
    let paint = json!({"from": [0, 8], "to": [64, 8], NOISE: {"roughness": 100, "seed": 4}});
    s.execute("paint.gradient", paint.clone()).unwrap();
    let a = photocraft_compose::flatten(&s.active().unwrap().doc).into_px();
    s.execute("paint.gradient", paint).unwrap();
    let b = photocraft_compose::flatten(&s.active().unwrap().doc).into_px();
    assert_eq!(a, b);
    assert!(changes_along_row(&s) > 20);
}

#[test]
fn a_gradient_overlay_and_a_gradient_map_take_noise() {
    let mut s = session();
    s.execute("layer.new.layer", json!({})).unwrap();
    s.execute("edit.fill", json!({"contents": "color", "color": "#808080"})).unwrap();
    assert!(changes_along_row(&s) == 0);
    s.execute("layer.layerStyle.gradientOverlay", json!({"angle": 0, NOISE: {"roughness": 100, "seed": 2}})).unwrap();
    assert!(changes_along_row(&s) > 20, "a Gradient Overlay with noise renders non-uniformly");
    let fx = |s: &Session| {
        let d = s.active().unwrap();
        d.doc.layer(d.active_layer.unwrap()).unwrap().effects.items.clone()
    };
    let Some(Effect::GradientOverlay { gradient, interpolation: None, .. }) = fx(&s).first().cloned() else { panic!("overlay") };
    let n = gradient.noise.clone().expect("noise");
    assert_eq!(gradient.stops, n.fill_stops().0);
    // Editing something else in place (the Layer Style dialog's path) keeps the noise; new stops
    // make it solid.
    let edit = |s: &mut Session, params: serde_json::Value| {
        let snapshot = serde_json::to_value(&fx(s)[0]).unwrap();
        s.execute("layer.layerStyle.replace", json!({"effects": [{"kind": "gradientOverlay", "fx": snapshot, "params": params}]})).unwrap();
    };
    edit(&mut s, json!({"opacity": 50, "angle": 30}));
    let Some(Effect::GradientOverlay { gradient, .. }) = fx(&s).first().cloned() else { panic!() };
    assert_eq!((gradient.noise, gradient.angle), (Some(n.clone()), 30.0));
    edit(&mut s, json!({NOISE: {"seed": 3}}));
    let Some(Effect::GradientOverlay { gradient, .. }) = fx(&s).first().cloned() else { panic!() };
    assert_eq!(gradient.noise.map(|g| (g.seed, g.roughness)), Some((3, n.roughness)), "over the current settings");
    edit(&mut s, json!({"stops": [[0, "#000000"], [1, "#ffffff"]]}));
    let Some(Effect::GradientOverlay { gradient, .. }) = fx(&s).first().cloned() else { panic!() };
    assert!(gradient.noise.is_none());
    s.execute("layer.layerStyle.stroke", json!({"size": 3, NOISE: {"seed": 8}})).unwrap();
    assert!(
        fx(&s).iter().any(|e| matches!(e, Effect::Stroke(st) if matches!(&st.paint, FxPaint::Gradient(g) if g.noise.as_ref().is_some_and(|n| n.seed == 8))))
    );

    s.execute("layer.newAdjustmentLayer.gradientMap", json!({"source": {NOISE: {"model": "lab", "seed": 12}}})).unwrap();
    let LayerContent::Adjustment(Adjustment::GradientMap { stops, source: Some(src), .. }) = active_content(&s) else { panic!("gradient map") };
    let n = src.noise.clone().expect("noise");
    assert_eq!((n.model, n.seed), (NoiseModel::Lab, 12));
    assert_eq!(stops, n.bake().0);
    assert_eq!(crate::adjust_params::source_params(&src)[NOISE]["seed"], 12);
}

#[test]
fn grd_files_import_and_export_noise_gradients() {
    let n = NoiseGradient { roughness: 0.5, model: NoiseModel::Rgb, min: [0.0, 0.25, 0.5, 0.0], max: [1.0; 4], restrict: true, transparency: false, seed: 77 };
    let grads = [craft_psd::grd::GrdGradient { name: "Static".into(), noise: true, ..Default::default() }];
    let bytes = photocraft_io::grd_noise::write_grd(&grads, &[Some(n.clone())]);
    let mut s = Session::new();
    let data = photocraft_paint::tile::b64_encode(&bytes);
    let r = s.execute("gradient.presets.importGrd", json!({"data": data, "group": "Noise"})).unwrap();
    assert_eq!(r["warnings"], json!([]), "no longer skipped");
    let g = s.presets.gradients.iter().find(|g| g.name == "Noise").unwrap().items[0].clone();
    assert_eq!((g.name.as_str(), g.noise.as_ref()), ("Static", Some(&n)));
    // Save Gradients… writes it back as a noise gradient.
    let out = s.execute("gradient.presets.exportGrd", json!({"group": "Noise"})).unwrap();
    let back = photocraft_paint::tile::b64_decode(out["data"].as_str().unwrap()).unwrap();
    assert_eq!(photocraft_io::grd_noise::grd_noise(&back), vec![Some(n.clone())]);
    assert!(craft_psd::grd::parse(&back).unwrap()[0].noise);
    // .pcpresets carry it too (P1b).
    let file = s.execute("edit.presets.exportImportPresets", json!({"action": "export", "kinds": ["gradients"]})).unwrap();
    let mut t = Session::new();
    t.presets.gradients.clear();
    t.execute("edit.presets.exportImportPresets", json!({"action": "import", "data": file["data"], "kinds": ["gradients"]})).unwrap();
    assert!(t.presets.gradients.iter().flat_map(|g| &g.items).any(|g| g.noise.as_ref() == Some(&n)));
}

#[test]
fn bad_noise_params_are_errors_and_change_nothing() {
    let mut s = session();
    s.execute("gradient.fill.create", json!({"from": [0, 0], "to": [10, 0]})).unwrap();
    let before = active_content(&s);
    let current = s.presets.gradient.clone();
    for bad in
        [json!(3), json!("x"), json!({"model": "cmyk"}), json!({"seed": "a"}), json!({"min": [1]}), json!({"restrict": 2}), json!({"roughness": "rough"})]
    {
        assert!(s.execute("gradient.fill.set", json!({NOISE: bad.clone()})).is_err(), "{bad}");
        assert!(s.execute("gradient.presets.stop", json!({"action": "set", NOISE: bad.clone()})).is_err(), "{bad}");
        assert!(s.execute("gradient.presets.new", json!({NOISE: bad.clone()})).is_err() || !bad.is_object(), "{bad}");
        assert!(s.execute("layer.newAdjustmentLayer.gradientMap", json!({"source": {NOISE: bad.clone()}})).is_err() || !bad.is_object(), "{bad}");
    }
    assert_eq!(active_content(&s), before);
    assert_eq!(s.presets.gradient, current);
    // Out-of-range numbers are clamped, not refused.
    s.execute("gradient.fill.set", json!({NOISE: {"roughness": 1e300, "min": [-1e9, 0, 0], "seed": -5}})).unwrap();
    let n = fill_noise(&s).1.unwrap();
    assert!(n.roughness == 1.0 && n.min[0] == 0.0 && n.seed == u32::MAX - 4);
}
