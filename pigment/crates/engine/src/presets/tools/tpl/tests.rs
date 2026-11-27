use serde_json::{Value, json};

use super::{EXPORT, IMPORT};
use crate::Session;

/// Written by the JavaScript Pigment 0.5 (`crates/io/tests/fixtures/pigment-0.4/README.md`).
const JS_FILE: &[u8] = include_bytes!("../../../../../io/tests/fixtures/pigment-0.4/wip05-tool-presets.tpl");

fn js_data() -> Value {
    json!(photocraft_paint::tile::b64_encode(JS_FILE))
}

fn names(s: &Session) -> Vec<String> {
    s.presets.tool_presets.iter().map(|t| t.name.clone()).collect()
}

#[test]
fn import_tpl_adds_replace_replaces_and_twice_adds_nothing() {
    let mut s = Session::new();
    let before = names(&s);
    let r = s.execute(IMPORT, json!({"data": js_data()})).unwrap();
    assert_eq!(r["count"], 7, "{r}");
    assert!(r["warnings"].as_array().unwrap().iter().any(|w| w.as_str().unwrap().contains("Adjust Brush")), "{r}");
    let after = names(&s);
    assert_eq!(&after[..before.len()], &before[..], "Load… adds after the presets already there");
    assert_eq!(after.len(), before.len() + 7);
    // The same file again: every preset is already here.
    let again = s.execute(IMPORT, json!({"data": js_data()})).unwrap();
    assert_eq!((again["count"].as_u64(), again["skipped"].as_u64()), (Some(0), Some(7)), "{again}");
    assert_eq!(names(&s), after);
    // Replace…: the file's presets alone.
    let r = s.execute(IMPORT, json!({"data": js_data(), "replace": true})).unwrap();
    assert_eq!(r["count"], 7);
    assert_eq!(names(&s), ["Soft Round 30", "Sampled Pencil", "Block Eraser", "Red Gradient", "Headline", "Spot Heal 20", "Dodge Highlights"]);
    // Reset Tool Presets… brings the built-ins back.
    s.execute("tool.presets.reset", json!({})).unwrap();
    assert_eq!(names(&s), before);
}

#[test]
fn an_imported_preset_applies_its_brush_and_colour() {
    let mut s = Session::new();
    s.execute(IMPORT, json!({"data": js_data()})).unwrap();
    let r = s.execute("tool.presets.select", json!({"preset": "Soft Round 30"})).unwrap();
    assert_eq!(r["tool"], "brush");
    let b = &s.tools.brush;
    assert_eq!((b.size, b.mode), (30.0, photocraft_color::BlendMode::Multiply));
    assert!((b.opacity - 0.6).abs() < 1e-6 && (b.flow - 0.4).abs() < 1e-6 && (b.hardness - 0.25).abs() < 1e-6);
    s.execute("tool.presets.select", json!({"preset": "Sampled Pencil"})).unwrap();
    assert!(matches!(s.tools.brush.tip, photocraft_paint::TipShape::Sampled(ref t) if (t.width, t.height) == (6, 4)), "{:?}", s.tools.brush.tip);
    let r = s.execute("tool.presets.select", json!({"preset": "Red Gradient"})).unwrap();
    assert_eq!(r["options"]["toolOptions"]["gradient_style"], "radial");
    assert_eq!(s.tools.foreground, [1.0, 0.0, 0.0, 1.0]);
}

#[test]
fn export_tpl_writes_what_import_tpl_reads_back() {
    let mut s = Session::new();
    // A preset with a sampled tip, as the + button stores the current brush.
    let tip = photocraft_paint::GrayTile::from_fn(7, 5, |x, y| ((x + y) as f32 / 10.0).min(1.0));
    s.execute("tools.setBrush", json!({"brush": {"tip": {"sampled": tip}, "size": 7.0, "opacity": 0.5}})).unwrap();
    s.execute("tool.presets.new", json!({"name": "Sampled", "tool": "brush"})).unwrap();
    s.execute("tool.presets.new", json!({"name": "Square", "tool": "crop", "options": {"toolOptions": {"crop_ratio": "1:1"}}})).unwrap();
    let all = s.presets.tool_presets.clone();
    let out = s.execute(EXPORT, json!({})).unwrap();
    assert_eq!(out["count"].as_u64(), Some(all.len() as u64));
    assert_eq!(out["warnings"], json!([]));
    let mut t = Session::new();
    let r = t.execute(IMPORT, json!({"data": out["data"], "replace": true})).unwrap();
    assert_eq!(r["warnings"], json!([]), "{r}");
    let mut want = all.clone();
    // Brush colours are the foreground's: a preset in a file leaves them out.
    for p in &mut want {
        if let Some(b) = p.options.get_mut("brush").and_then(Value::as_object_mut) {
            for k in ["color", "colorCmyk", "background", "seed"] {
                b.remove(k);
            }
        }
    }
    let got = t.presets.tool_presets.clone();
    let strip = |v: &[super::ToolPreset]| -> Vec<super::ToolPreset> {
        v.iter()
            .cloned()
            .map(|mut p| {
                if let Some(b) = p.options.get_mut("brush").and_then(Value::as_object_mut) {
                    for k in ["color", "colorCmyk", "background", "seed"] {
                        b.remove(k);
                    }
                }
                p
            })
            .collect()
    };
    assert_eq!(strip(&got), want);
    t.execute("tool.presets.select", json!({"preset": "Sampled"})).unwrap();
    assert!(matches!(t.tools.brush.tip, photocraft_paint::TipShape::Sampled(ref g) if *g == tip));

    // Only the named ones, to a path.
    let dir = std::env::temp_dir().join(format!("pigment-tpl-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("Two.tpl");
    let out = s.execute(EXPORT, json!({"names": ["Square", "Sampled"], "path": path.to_string_lossy()})).unwrap();
    assert_eq!(out["count"], 2);
    assert!(out.get("data").is_none());
    let mut u = Session::new();
    u.execute(IMPORT, json!({"path": path.to_string_lossy(), "replace": true})).unwrap();
    assert_eq!(names(&u), ["Square", "Sampled"]);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_taken_name_with_other_options_is_numbered_once() {
    let mut s = Session::new();
    s.execute("tool.presets.new", json!({"name": "Soft Round 30", "tool": "eraser", "options": {}})).unwrap();
    let r = s.execute(IMPORT, json!({"data": js_data()})).unwrap();
    assert!(r["added"].as_array().unwrap().contains(&json!("Soft Round 30 2")), "{r}");
    let again = s.execute(IMPORT, json!({"data": js_data()})).unwrap();
    assert_eq!(again["count"], 0, "{again}");
}

#[test]
fn bad_params_are_errors_and_change_nothing() {
    let mut s = Session::new();
    let before = s.presets.tool_presets.clone();
    for p in [
        json!({}),
        json!({"data": 5}),
        json!({"data": "not base64!"}),
        json!({"data": photocraft_paint::tile::b64_encode(b"8BPS not a tpl")}),
        json!({"data": photocraft_paint::tile::b64_encode(b"8BTP\0\x01\0\x02")}),
        json!({"data": js_data(), "replace": "yes"}),
        json!({"path": "/nonexistent/x.tpl"}),
    ] {
        assert!(s.execute(IMPORT, p.clone()).is_err(), "{p}");
        assert_eq!(s.presets.tool_presets, before, "{p}");
    }
    for p in [json!({"names": "Soft Round 100 px"}), json!({"names": [3]}), json!({"names": ["Nope"]}), json!({"names": []})] {
        assert!(s.execute(EXPORT, p.clone()).is_err(), "{p}");
    }
    s.presets.tool_presets.clear();
    assert!(s.execute(EXPORT, json!({})).is_err(), "nothing to save");
}

/// The Preset Manager loads and saves `.tpl` now that the commands exist (P1a's dispatch).
#[test]
fn the_preset_manager_loads_and_saves_tpl() {
    let mut s = Session::new();
    let list = s.execute("edit.presets.presetManager", json!({"action": "list", "kind": "tools"})).unwrap();
    let info = &list["info"]["tools"];
    assert!(info["load"].as_array().unwrap().contains(&json!("tpl")), "{info}");
    assert_eq!(info["save"][0], "tpl", "{info}");
    let saved = s.execute("edit.presets.presetManager", json!({"action": "saveSet", "kind": "tools", "indices": [0, 1]})).unwrap();
    assert!(saved["fileName"].as_str().unwrap().ends_with(".tpl"), "{saved}");
    let mut t = Session::new();
    t.execute("edit.presets.presetManager", json!({"action": "load", "kind": "tools", "data": saved["data"], "fileName": "Mine.tpl", "replace": true}))
        .unwrap();
    assert_eq!(names(&t), names(&s)[..2]);
}
