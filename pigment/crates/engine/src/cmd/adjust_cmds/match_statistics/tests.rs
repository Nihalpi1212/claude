//! Match Color's statistics (Load/Save Statistics…) and HDR Toning's Method menu, through the commands.

use super::*;

const JS_STATISTICS: &str = include_str!("js-statistics.json");
const JS_SOURCE: &str = include_str!("js-source.json");

/// A new RGB document `w × h` (8-bit unless `depth`) painted by `f`.
fn document(s: &mut Session, w: i32, h: i32, depth: u64, f: impl Fn(i32, i32) -> [f32; 4]) {
    s.execute("file.new", json!({"width": w, "height": h, "depth": depth})).unwrap();
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

fn warm(x: i32, y: i32) -> [f32; 4] {
    [0.85 - y as f32 * 0.02, 0.45 + x as f32 * 0.01, 0.2, 1.0]
}

fn cool(x: i32, y: i32) -> [f32; 4] {
    [0.2 + x as f32 * 0.01, 0.35, 0.75 - y as f32 * 0.015, 1.0]
}

fn pixels(s: &Session) -> Vec<[f32; 4]> {
    let d = s.active().unwrap();
    let b = d.doc.bounds();
    let surf = d.doc.layer(d.active_layer.unwrap()).unwrap().surface().unwrap();
    (b.y0..b.y1).flat_map(|y| (b.x0..b.x1).map(move |x| (x, y))).map(|(x, y)| surf.rgba(x, y)).collect()
}

fn worst(a: &[[f32; 4]], b: &[[f32; 4]]) -> f32 {
    a.iter().zip(b).flat_map(|(p, q)| (0..3).map(move |c| (p[c] - q[c]).abs())).fold(0.0, f32::max)
}

fn stats_of(v: &Value) -> LabStats {
    read(v).expect("statistics")
}

/// Save Statistics… from a document, load the file into another session, and Match Color with the loaded
/// statistics: the result equals Match Color with that document as the source.
#[test]
fn saved_statistics_load_and_match_like_the_source_document() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("warm statistics.json");
    let path = path.to_str().unwrap();
    let mut s = Session::new();
    document(&mut s, 24, 16, 8, warm);
    document(&mut s, 24, 16, 8, cool);
    let saved = s.execute(STATISTICS, json!({"source": 0, "path": path})).unwrap();
    assert_eq!(saved["name"], json!(s.documents()[0].doc.name));
    let text = std::fs::read_to_string(path).unwrap();
    assert_eq!(saved["file"].as_str(), Some(text.as_str()));
    let file: Value = serde_json::from_str(&text).unwrap();
    assert_eq!((file["format"].as_str(), file["version"].as_i64()), (Some(FORMAT), Some(1)), "the JavaScript app's format");
    // The source by document, then the same statistics read back from the file.
    let before = pixels(&s);
    s.execute("image.adjustments.matchColor", json!({"source": 0, "luminance": 120})).unwrap();
    let by_document = pixels(&s);
    assert!(worst(&before, &by_document) > 0.05, "the match moves the colours");
    s.execute("edit.undo", json!({})).unwrap();
    let mut other = Session::new();
    document(&mut other, 24, 16, 8, cool);
    let loaded = other.execute(STATISTICS, json!({"path": path})).unwrap();
    assert_eq!(loaded["name"], json!(s.documents()[0].doc.name));
    for k in 0..3 {
        for key in ["mean", "std"] {
            let (a, b) = (saved[key][k].as_f64().unwrap(), loaded[key][k].as_f64().unwrap());
            assert!((a - b).abs() < 0.05, "{key}[{k}]: saved {a}, loaded {b} (through the file's D65)");
        }
    }
    let history = other.active().unwrap().history.past_len();
    other.execute("image.adjustments.matchColor", json!({"sourceStatistics": {"mean": loaded["mean"], "std": loaded["std"]}, "luminance": 120})).unwrap();
    assert_eq!(other.active().unwrap().history.past_len(), history + 1, "one history step");
    assert!(worst(&pixels(&other), &by_document) <= 1.0 / 255.0 + 1e-6, "the loaded statistics match as the document does");
    // The statistics command changes nothing and is not journaled.
    assert_eq!(s.active().unwrap().history.past_len(), 1, "the document's setup only");
    assert!(!crate::commands::find(STATISTICS).unwrap().journal);
}

/// A file the JavaScript Pigment 0.4 wrote loads: its D65 statistics become PhotoCraft's D50 statistics of
/// the same pixels.
#[test]
fn a_file_the_javascript_app_wrote_loads_as_photocrafts_statistics() {
    let mut s = Session::new();
    let v = s.execute(STATISTICS, json!({"data": JS_STATISTICS, "fileName": "sunset.json"})).unwrap();
    assert_eq!(v["name"], "Sunset");
    let image: Value = serde_json::from_str(JS_SOURCE).unwrap();
    let hex = image["rgba"].as_str().unwrap();
    let px: Vec<[f32; 4]> = (0..hex.len() / 8)
        .map(|i| {
            let b = |k: usize| f32::from(u8::from_str_radix(&hex[i * 8 + k * 2..i * 8 + k * 2 + 2], 16).unwrap()) / 255.0;
            [b(0), b(1), b(2), b(3)]
        })
        .collect();
    assert_eq!(px.len(), 120);
    let ours = tone::lab_stats(&px, None).unwrap();
    let loaded = stats_of(&v);
    let raw: Value = serde_json::from_str(JS_STATISTICS).unwrap();
    let js = stats_of(&raw);
    let (mut converted, mut unconverted) = (0f32, 0f32);
    for k in 0..3 {
        assert!((loaded.mean[k] - ours.mean[k]).abs() < 0.05, "mean[{k}]: loaded {loaded:?}, PhotoCraft {ours:?}");
        assert!((loaded.std[k] - ours.std[k]).abs() < 0.03 * ours.std[k] + 0.1, "std[{k}]: loaded {loaded:?}, PhotoCraft {ours:?}");
        converted += (loaded.mean[k] - ours.mean[k]).abs();
        unconverted += (js.mean[k] - ours.mean[k]).abs();
    }
    assert!(unconverted > 1.0 && converted < unconverted / 10.0, "the white point matters: {unconverted} off unconverted, {converted} converted");
    // Saved again, the file holds the JavaScript app's numbers back.
    let again = s.execute(STATISTICS, json!({"statistics": {"mean": v["mean"], "std": v["std"]}, "name": "Sunset"})).unwrap();
    let file: Value = serde_json::from_str(again["file"].as_str().unwrap()).unwrap();
    for key in ["mean", "std"] {
        for k in 0..3 {
            assert!((file[key][k].as_f64().unwrap() - raw[key][k].as_f64().unwrap()).abs() < 0.05, "{key}[{k}]: {file} vs {raw}");
        }
    }
    // A file without a name is named after the file.
    let v = s.execute(STATISTICS, json!({"data": r#"{"mean":[50,0,0],"std":[10,2,2]}"#, "fileName": "/tmp/Look 2.json"})).unwrap();
    assert_eq!(v["name"], "Look 2");
}

#[test]
fn bad_statistics_are_errors() {
    let mut s = Session::new();
    document(&mut s, 8, 8, 8, warm);
    let big = format!("{{\"mean\":[1,2,3],\"std\":[1,2,3],\"pad\":\"{}\"}}", "x".repeat(70_000));
    for data in [
        "not json",
        "",
        "{}",
        "[1,2,3]",
        r#"{"mean":[1,2],"std":[1,2,3]}"#,
        r#"{"mean":[1,2,3],"std":[1,-2,3]}"#,
        r#"{"mean":["a",2,3],"std":[1,2,3]}"#,
        r#"{"mean":[1,2,3]}"#,
        r#"{"mean":[1e308,2,3],"std":[1,2,3]}"#,
        big.as_str(),
    ] {
        let e = s.execute(STATISTICS, json!({"data": data})).unwrap_err().to_string();
        assert!(e.contains("statistics") || e.contains("JSON"), "{data:.40}: {e}");
    }
    let missing = tempfile::tempdir().unwrap().path().join("none.json");
    assert!(s.execute(STATISTICS, json!({"path": missing.to_str().unwrap()})).is_err());
    assert!(s.execute(STATISTICS, json!({})).is_err(), "nothing to read or compute");
    assert!(s.execute(STATISTICS, json!({"source": 5})).is_err(), "no such document");
    assert!(s.execute(STATISTICS, json!({"source": 0, "statistics": {"mean": [1, 2, 3], "std": [1, 2, 3]}})).is_err());
    assert!(s.execute(STATISTICS, json!({"statistics": {"mean": [1, 2, 3]}})).is_err());
    // Match Color refuses malformed statistics, and statistics beside a source document.
    for bad in [json!({"mean": [1, 2, 3]}), json!({"mean": [1, 2, 3], "std": [-1, 0, 0]}), json!("x"), json!([1, 2])] {
        assert!(s.execute("image.adjustments.matchColor", json!({"sourceStatistics": bad})).is_err(), "{bad}");
    }
    let good = json!({"mean": [60, 10, 20], "std": [10, 5, 5]});
    assert!(s.execute("image.adjustments.matchColor", json!({"source": 0, "sourceStatistics": good})).is_err());
    assert_eq!(s.active().unwrap().history.past_len(), 1, "nothing changed after the setup");
    // None (-1) beside statistics is no source document.
    s.execute("image.adjustments.matchColor", json!({"source": -1, "sourceStatistics": good})).unwrap();
}

/// An action records the statistics Match Color used, so it plays back with no source open.
#[test]
fn actions_record_the_statistics_and_play_them_back() {
    let mut s = Session::new();
    document(&mut s, 16, 12, 8, cool);
    let stats = json!({"mean": [62.5, 18.0, 40.0], "std": [12.0, 8.0, 9.0]});
    s.execute("actions.record", json!({"name": "Warm Look"})).unwrap();
    s.execute("image.adjustments.matchColor", json!({"sourceStatistics": stats, "fade": 10})).unwrap();
    s.execute("actions.stop", json!({})).unwrap();
    let recorded = pixels(&s);
    let steps = s.execute("actions.get", json!({"action": "Warm Look"})).unwrap()["steps"].clone();
    let step = steps.as_array().unwrap().iter().find(|st| st[0] == "image.adjustments.matchColor").expect("recorded").clone();
    assert_eq!(step[1]["sourceStatistics"], stats, "{step}");
    document(&mut s, 16, 12, 8, cool);
    s.execute("actions.play", json!({"action": "Warm Look"})).unwrap();
    assert_eq!(pixels(&s), recorded);
}

#[test]
fn the_white_point_conversion_round_trips_and_keeps_greys() {
    for lab in [[50.0, 0.0, 0.0], [70.0, 30.0, -40.0], [20.0, -50.0, 60.0], [95.0, 5.0, 80.0], [3.0, 1.0, -1.0]] {
        let back = d65_to_d50(d50_to_d65(lab));
        assert!(lab.iter().zip(back).all(|(a, b)| (a - b).abs() < 1e-3), "{lab:?} → {back:?}");
    }
    let grey = d50_to_d65([42.0, 0.0, 0.0]);
    assert!((grey[0] - 42.0).abs() < 1e-3 && grey[1].abs() < 0.02 && grey[2].abs() < 0.02, "{grey:?}");
    // Deviations follow the slope: zero stays zero, a grey's spread in L keeps its size.
    let c = convert(&LabStats { mean: [50.0, 0.0, 0.0], std: [10.0, 0.0, 0.0] }, d50_to_d65);
    assert!((c.std[0] - 10.0).abs() < 0.05 && c.std[1] < 0.05 && c.std[2] < 0.05, "{c:?}");
}

// --- HDR Toning's Method menu ------------------------------------------------------------------------------

fn ramp(x: i32, y: i32) -> [f32; 4] {
    let v = x as f32 / 31.0;
    [v, v * 0.8, (v * 0.5 + y as f32 * 0.02).min(1.0), 1.0]
}

#[test]
fn hdr_toning_methods_run_and_the_method_round_trips_through_an_action() {
    let mut s = Session::new();
    document(&mut s, 32, 8, 8, ramp);
    let start = pixels(&s);
    let mut results = Vec::new();
    for method in ["localAdaptation", "equalizeHistogram", "exposureGamma", "highlightCompression"] {
        s.execute("image.adjustments.hdrToning", json!({"method": method, "exposure": 0.5, "gamma": 1.2})).unwrap();
        results.push(pixels(&s));
        assert_eq!(s.active().unwrap().history.past_len(), 2, "{method}: one step after the setup");
        s.execute("edit.undo", json!({})).unwrap();
        assert_eq!(pixels(&s), start, "{method}: undone");
    }
    for i in 0..4 {
        for j in i + 1..4 {
            assert!(worst(&results[i], &results[j]) > 0.02, "methods {i} and {j} differ");
        }
    }
    // No method is Local Adaptation, as before the menu.
    s.execute("image.adjustments.hdrToning", json!({"exposure": 0.5, "gamma": 1.2})).unwrap();
    assert_eq!(pixels(&s), results[0]);
    s.execute("edit.undo", json!({})).unwrap();
    // The JavaScript app's ids are taken too; a wrong one is refused.
    s.execute("image.adjustments.hdrToning", json!({"method": "exposure-gamma", "exposure": 0.5, "gamma": 1.2})).unwrap();
    assert_eq!(pixels(&s), results[2]);
    s.execute("edit.undo", json!({})).unwrap();
    for bad in [json!("glow"), json!(3), json!(["exposureGamma"])] {
        assert!(s.execute("image.adjustments.hdrToning", json!({"method": bad})).is_err(), "{bad}");
    }
    // Recorded with its method, played back on a new document.
    s.execute("actions.record", json!({"name": "HDR"})).unwrap();
    s.execute("image.adjustments.hdrToning", json!({"method": "highlightCompression", "exposure": 0.5})).unwrap();
    s.execute("actions.stop", json!({})).unwrap();
    let steps = s.execute("actions.get", json!({"action": "HDR"})).unwrap()["steps"].clone();
    let step = steps.as_array().unwrap().iter().find(|st| st[0] == "image.adjustments.hdrToning").expect("recorded").clone();
    assert_eq!(step[1]["method"], "highlightCompression", "{step}");
    document(&mut s, 32, 8, 8, ramp);
    s.execute("actions.play", json!({"action": "HDR"})).unwrap();
    assert!(worst(&pixels(&s), &results[3]) < 1e-6);
}

/// In a 32-bit document the pixels are linear light: Exposure and Gamma +1 doubles them.
#[test]
fn hdr_exposure_and_gamma_doubles_a_32_bit_documents_linear_values() {
    let mut s = Session::new();
    document(&mut s, 4, 2, 32, |x, _| [0.05 * (x + 1) as f32, 0.1, 0.3, 1.0]);
    let before = pixels(&s);
    s.execute("image.adjustments.hdrToning", json!({"method": "exposureGamma", "exposure": 1, "gamma": 1})).unwrap();
    let after = pixels(&s);
    for (a, b) in after.iter().zip(&before) {
        for c in 0..3 {
            assert!((a[c] - (2.0 * b[c]).min(1.0)).abs() < 1e-3, "{b:?} → {a:?}");
        }
    }
}

/// The built-in HDR presets are Local Adaptation, and a preset's method must be one of the menu's.
#[test]
fn hdr_presets_name_their_method() {
    let mut s = Session::new();
    let v = s.execute("adjustment.presets.list", json!({"kind": "hdrToning", "params": true})).unwrap();
    let all = v["hdrToning"].as_array().unwrap();
    assert_eq!(all.len(), 8);
    assert!(all.iter().all(|p| p["params"]["method"] == "localAdaptation"), "{v}");
    s.execute("adjustment.presets.save", json!({"kind": "hdrToning", "name": "Flat EG", "params": {"method": "exposureGamma", "exposure": 1}})).unwrap();
    assert!(s.execute("adjustment.presets.save", json!({"kind": "hdrToning", "name": "x", "params": {"method": "glow"}})).is_err());
}
