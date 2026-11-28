//! Pigment: Export/Import Presets for every kind (P1b).

use serde_json::{Value, json};

use super::KINDS;
use crate::Session;
use crate::cmd::edit_menu_cmds::{CustomShape, PRESET_FORMAT};

const CMD: &str = "edit.presets.exportImportPresets";

/// A session with a preset of its own in every kind but brushes (whose built-ins it keeps).
fn source() -> Session {
    let mut s = Session::new();
    s.execute("swatches.add", json!({"name": "Ink", "group": "Print", "color": {"model": "cmyk", "values": [100, 0, 0, 0]}})).unwrap();
    s.execute("gradient.presets.new", json!({"name": "My Gradient", "group": "Mine"})).unwrap();
    s.execute("file.new", json!({"width": 16, "height": 16})).unwrap();
    s.execute("style.presets.new", json!({"name": "Pending", "group": "Mine", "effects": [["stroke", {"size": 6, "color": "#123456"}]]})).unwrap();
    s.execute("pattern.presets.new", json!({"name": "Mine", "rect": [0, 0, 8, 8], "group": "Custom"})).unwrap();
    s.execute("layer.layerStyle.contours.new", json!({"contour": {"name": "Bump", "points": [[0, 0], [0.5, 1], [1, 0]]}, "name": "Bump"})).unwrap();
    s.execute("shape.presets.new", json!({"name": "Tri", "group": "Mine", "path": "M 0 0 L 10 0 L 5 10 Z"})).unwrap();
    let path = s.presets.shapes[0].items[0].path.clone();
    s.edit_state.custom_shapes.push(CustomShape { name: "Defined".into(), path });
    s.execute("tool.presets.new", json!({"name": "2 : 3", "tool": "crop", "options": {"toolOptions": {"crop_ratio": "2:3"}}})).unwrap();
    s.execute("adjustment.presets.save", json!({"kind": "curves", "name": "My Curve", "params": {"points": [[0, 0], [128, 160], [255, 255]]}})).unwrap();
    s.execute("adjustment.presets.save", json!({"kind": "levels", "name": "Lift", "group": "Tone", "params": {"inputBlack": 10}})).unwrap();
    s
}

fn export_all(s: &mut Session) -> Value {
    s.execute(CMD, json!({"action": "export", "kinds": KINDS})).unwrap()
}

fn import(s: &mut Session, data: &Value) -> Value {
    s.execute(CMD, json!({"action": "import", "kinds": KINDS, "data": data})).unwrap()
}

/// Every library the file covers, comparable (patterns by their pixels).
fn libraries(s: &mut Session) -> Value {
    crate::presets::patterns::sync(s);
    let patterns: Vec<Value> = s
        .patterns
        .items
        .iter()
        .map(|p| {
            let full = crate::pattern_cmds::full(s, p).unwrap();
            json!({"id": p.id, "name": p.name, "size": [p.width, p.height], "pixels": full.surface.read_region(photocraft_doc::Rect::new(0, 0, p.width as i32, p.height as i32))})
        })
        .collect();
    json!({
        "swatches": s.presets.swatches,
        "gradients": s.presets.gradients,
        "styles": s.presets.styles,
        "shapes": s.presets.shapes,
        "customShapes": s.edit_state.custom_shapes,
        "patterns": patterns,
        // An empty folder holds no preset (Define Pattern can leave an empty "Patterns" behind).
        "patternGroups": s.presets.pattern_groups.iter().filter(|g| !g.items.is_empty()).collect::<Vec<_>>(),
        "contours": crate::contour_lib_cmds::to_json(&s.presets.contours),
        "tools": s.presets.tool_presets,
        "adjustments": s.presets.adjustments.to_json(),
        "brushes": s.tools.presets.iter().map(|b| b.name.clone()).collect::<Vec<_>>(),
    })
}

#[test]
fn every_kind_exports_and_imports_into_a_fresh_session_equal() {
    let mut s = source();
    let out = export_all(&mut s);
    // Only what the user made: the built-ins as shipped are in every library already.
    for (kind, n) in [
        ("swatches", 1),
        ("gradients", 1),
        ("styles", 1),
        ("patterns", 1),
        ("contours", 1),
        ("customShapes", 2),
        ("tools", 1),
        ("adjustments", 2),
        ("brushes", 0),
    ] {
        assert_eq!(out[kind], n, "{kind} in {out}");
    }
    let data = &out["data"];
    assert_eq!(data["patterns"][0]["name"], "Mine");
    assert_eq!(data["patternGroups"], json!([{"name": "Custom", "items": [data["patterns"][0]["id"].clone()]}]));
    assert_eq!(data["shapes"][0]["name"], "Mine");
    assert_eq!(data["customShapes"][0]["name"], "Defined");
    // In the kinds' order (Levels before Curves).
    assert_eq!(data["adjustments"][0], json!({"kind": "levels", "group": "Tone", "name": "Lift", "params": {"inputBlack": 10}}));
    // The text of the file imports as the object does.
    let mut t = Session::new();
    let r = t.execute(CMD, json!({"action": "import", "kinds": KINDS, "data": data.to_string()})).unwrap();
    for kind in ["swatches", "gradients", "styles", "patterns", "contours", "tools", "adjustments"] {
        assert!(r[kind].as_u64().unwrap() >= 1, "{kind} added: {r}");
    }
    assert_eq!(r["customShapes"], 2, "the Define Custom Shape result and the Shapes group's shape");
    let (got, want) = (libraries(&mut t), libraries(&mut s));
    for key in want.as_object().unwrap().keys() {
        assert!(got[key] == want[key], "{key} differs:\n{}\n{}", got[key], want[key]);
    }
    assert!(t.presets.rev > 0);
}

#[test]
fn importing_twice_adds_nothing() {
    let mut s = source();
    let data = export_all(&mut s)["data"].clone();
    let mut t = Session::new();
    import(&mut t, &data);
    let once = libraries(&mut t);
    let again = import(&mut t, &data);
    for kind in ["swatches", "gradients", "styles", "patterns", "contours", "adjustments"] {
        assert_eq!(again[kind], 0, "{kind}: {again}");
        assert!(again["skipped"][kind].as_u64().unwrap() >= 1, "{kind} skipped: {again}");
    }
    assert_eq!(libraries(&mut t), once);
    // And into the session the file came from.
    let before = libraries(&mut s);
    import(&mut s, &data);
    assert_eq!(libraries(&mut s), before);
}

#[test]
fn a_different_preset_of_a_taken_name_gets_a_number_once() {
    let mut s = source();
    let data = export_all(&mut s)["data"].clone();
    let mut t = Session::new();
    t.execute("gradient.presets.new", json!({"name": "My Gradient", "group": "Mine", "stops": [[0, "#ff0000"], [1, "#00ff00"]]})).unwrap();
    t.execute("adjustment.presets.save", json!({"kind": "curves", "name": "My Curve", "params": {"points": [[0, 20], [255, 255]]}})).unwrap();
    t.execute("layer.layerStyle.contours.new", json!({"contour": {"name": "Bump", "points": [[0, 1], [1, 0]]}, "name": "Bump"})).unwrap();
    for _ in 0..2 {
        import(&mut t, &data);
        let mine: Vec<&str> = t.presets.gradients.iter().find(|g| g.name == "Mine").unwrap().items.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(mine, ["My Gradient", "My Gradient 2"]);
        let curves: Vec<String> = t.presets.adjustments.list("curves").into_iter().filter(|e| !e.builtin).map(|e| e.preset.name).collect();
        assert_eq!(curves, ["My Curve", "My Curve 2"]);
        let contours = crate::contour_lib_cmds::to_json(&t.presets.contours);
        assert_eq!(contours.as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap()).collect::<Vec<_>>(), ["Bump", "Bump 2"]);
    }
}

#[test]
fn an_upstream_three_kind_file_still_imports_and_exports_unchanged() {
    // As PhotoCraft 057297b writes it: no keys of the six other kinds.
    let mut s = Session::new();
    let out = s.execute(CMD, json!({"action": "export"})).unwrap();
    let keys: Vec<&String> = out["data"].as_object().unwrap().keys().collect();
    assert_eq!(keys, ["brushes", "customShapes", "format", "toolPresets", "version"]);
    let path = s.presets.shapes[0].items[0].path.clone();
    let old = json!({
        "format": PRESET_FORMAT, "version": 1, "brushes": [],
        "customShapes": [{"name": "Old Shape", "path": path}],
        "toolPresets": [{"name": "Square", "tool": "crop", "options": {"toolOptions": {"crop_ratio": "1:1"}}}],
    });
    let mut t = Session::new();
    let r = t.execute(CMD, json!({"action": "import", "data": old.to_string()})).unwrap();
    assert_eq!((r["customShapes"].as_u64(), r["tools"].as_u64()), (Some(1), Some(1)));
    assert!(t.edit_state.custom_shapes.iter().any(|c| c.name == "Old Shape"));
    // Asking for every kind of an old file adds what it has and nothing else.
    let mut u = Session::new();
    let before = libraries(&mut u);
    let r = u.execute(CMD, json!({"action": "import", "kinds": KINDS, "data": old})).unwrap();
    assert_eq!(r["gradients"], 0);
    let after = libraries(&mut u);
    assert_eq!(after["gradients"], before["gradients"]);
    assert_eq!(after["swatches"], before["swatches"]);
}

#[test]
fn swatches_in_the_old_items_shape_load() {
    let mut s = source();
    let data = export_all(&mut s)["data"].clone();
    let mut old = json!({"format": PRESET_FORMAT, "version": 1});
    // Before craft-color's model a group held `items`.
    old["swatches"] = json!([{"name": "Print", "items": data["swatches"][0]["entries"].clone()}]);
    let mut t = Session::new();
    let r = t.execute(CMD, json!({"action": "import", "kinds": ["swatches"], "data": old})).unwrap();
    assert_eq!(r["swatches"], 1);
    let print = t.presets.swatches.iter().find(|g| g.name == "Print").unwrap();
    assert_eq!(print.entries[0].name, "Ink");
}

#[test]
fn a_damaged_file_changes_nothing() {
    let mut s = source();
    let data = export_all(&mut s)["data"].clone();
    let mut t = Session::new();
    let before = libraries(&mut t);
    let mut bad_pattern = data.clone();
    bad_pattern["patterns"][0]["data"] = json!("not base64 at all!");
    let mut bad_adjustment = data.clone();
    bad_adjustment["adjustments"][0]["params"] = json!([1, 2]);
    let mut bad_contour = data.clone();
    bad_contour["contours"] = json!(["Linear"]);
    let mut bad_tool = data.clone();
    bad_tool["toolPresets"][0]["tool"] = json!(" ");
    for (what, file) in [("pattern", bad_pattern), ("adjustment", bad_adjustment), ("contour", bad_contour), ("tool", bad_tool)] {
        assert!(t.execute(CMD, json!({"action": "import", "kinds": KINDS, "data": file})).is_err(), "a damaged {what} is refused");
        assert_eq!(libraries(&mut t), before, "a damaged {what} changes nothing");
    }
    for p in [
        json!({"action": "import", "kinds": ["brushes", "nope"], "data": data}),
        json!({"action": "import", "kinds": "swatches", "data": data}),
        json!({"action": "export", "kinds": [7]}),
        json!({"action": "import", "data": "{"}),
    ] {
        assert!(t.execute(CMD, p.clone()).is_err(), "{p}");
    }
    assert_eq!(libraries(&mut t), before);
}

#[test]
fn a_pigment_bundle_is_told_apart_and_a_damaged_one_refused() {
    // P4 (Migrate Presets) reads bundles (`tests/it/migrate_pigment_04.rs` imports a whole one).
    let mut s = Session::new();
    let zip = b"PK\x03\x04\x14\x00\x00\x00bundle.json";
    for data in [String::from_utf8_lossy(zip).into_owned(), photocraft_paint::tile::b64_encode(zip)] {
        let e = s.execute(CMD, json!({"action": "import", "kinds": KINDS, "data": data})).unwrap_err().to_string();
        assert!(e.contains("not a Pigment bundle"), "{e}");
    }
}

#[test]
fn include_builtins_exports_every_preset_and_a_fresh_library_skips_them() {
    let mut s = Session::new();
    let all =
        s.execute(CMD, json!({"action": "export", "kinds": ["gradients", "styles", "swatches", "patterns", "adjustments"], "includeBuiltins": true})).unwrap();
    let gradients: usize = s.presets.gradients.iter().map(|g| g.items.len()).sum();
    assert_eq!(all["gradients"].as_u64().unwrap() as usize, gradients);
    assert_eq!(all["patterns"].as_u64().unwrap() as usize, s.patterns.items.len());
    assert!(all["adjustments"].as_u64().unwrap() > 10, "the built-in adjustment presets: {}", all["adjustments"]);
    let none = s.execute(CMD, json!({"action": "export", "kinds": ["gradients", "styles", "swatches", "patterns", "adjustments"]})).unwrap();
    assert_eq!(none["gradients"], 0);
    assert!(none["data"].get("gradients").is_none(), "empty kinds are left out of the file");
    let mut t = Session::new();
    let before = libraries(&mut t);
    let r = t.execute(CMD, json!({"action": "import", "kinds": KINDS, "data": all["data"]})).unwrap();
    for kind in ["gradients", "styles", "swatches", "patterns", "adjustments"] {
        assert_eq!(r[kind], 0, "{kind}: {r}");
    }
    assert_eq!(libraries(&mut t), before);
}

#[test]
fn the_preset_manager_saves_a_set_of_any_kind_as_pcpresets() {
    const PM: &str = "edit.presets.presetManager";
    let mut s = source();
    let rows = |s: &mut Session, kind: &str| s.execute(PM, json!({"kind": kind})).unwrap()["info"][kind]["rows"].as_array().unwrap().clone();
    let at = |rows: &[Value], name: &str| rows.iter().position(|r| r["name"] == name).unwrap();
    // Two adjustment presets of two kinds in one file; Load… of it into another session.
    let adj = rows(&mut s, "adjustments");
    let set = s.execute(PM, json!({"action": "saveSet", "kind": "adjustments", "indices": [at(&adj, "My Curve"), at(&adj, "Lift")]})).unwrap();
    assert_eq!(set["fileName"], "Presets.pcpresets");
    let mut t = Session::new();
    t.execute(PM, json!({"action": "load", "kind": "adjustments", "data": set["data"], "fileName": "Presets.pcpresets"})).unwrap();
    assert!(t.presets.adjustments.find("curves", Some("My Curve"), None).is_some());
    assert!(t.presets.adjustments.find("levels", Some("Lift"), None).is_some_and(|e| e.group == "Tone"));
    // Every kind offers .pcpresets and reads it back (Replace… included).
    for kind in ["swatches", "gradients", "styles", "patterns", "contours", "customShapes"] {
        let r = rows(&mut s, kind);
        let last = r.len() - 1;
        let set = s.execute(PM, json!({"action": "saveSet", "kind": kind, "index": last, "format": "pcpresets"})).unwrap();
        assert_eq!(set["count"], 1, "{kind}");
        let mut t = Session::new();
        t.execute(PM, json!({"action": "load", "kind": kind, "data": set["data"], "fileName": "One.pcpresets", "replace": true})).unwrap();
        let names: Vec<Value> = rows(&mut t, kind).iter().map(|r| r["name"].clone()).collect();
        assert_eq!(names, [r[last]["name"].clone()], "{kind} replaced by the file's one preset");
    }
    // A Shapes panel preset keeps its group; a Define Custom Shape result stays one.
    let shapes = rows(&mut s, "customShapes");
    let set = s.execute(PM, json!({"action": "saveSet", "kind": "customShapes", "indices": [at(&shapes, "Tri"), at(&shapes, "Defined")]})).unwrap();
    let file: Value = serde_json::from_slice(&photocraft_paint::tile::b64_decode(set["data"].as_str().unwrap()).unwrap()).unwrap();
    assert_eq!(file["shapes"][0]["name"], "Mine");
    assert_eq!(file["customShapes"][0]["name"], "Defined");
}

#[test]
fn a_files_gradients_are_tidied_and_one_without_stops_is_refused() {
    // Review P: a shared file's gradient went in as written: without colour stops, with one
    // stop, or with colours outside 0..1, which the Gradient tool and the editor never make.
    let mut s = Session::new();
    let file = |items: Value| json!({"format": PRESET_FORMAT, "version": 1, "gradients": [{"name": "Odd", "items": items}]}).to_string();
    let before = s.presets.gradients.clone();
    let err = s
        .execute(
            CMD,
            json!({"action": "import", "kinds": ["gradients"], "data": file(json!([
                {"name": "Fine", "stops": [[0, "foreground"], [1, "background"]]},
                {"name": "Empty", "stops": []}
            ]))}),
        )
        .unwrap_err();
    assert!(err.to_string().contains("\"Empty\": it has no colour stops"), "{err}");
    assert_eq!(s.presets.gradients, before, "nothing changes");
    s.execute(
        CMD,
        json!({"action": "import", "kinds": ["gradients"], "data": file(json!([
            {"name": "One", "stops": [[0.5, {"rgb": [1.0, 0.0, 0.0]}]]},
            {"name": "Far", "stops": [[-3.0, {"rgb": [9.0, -1.0, 0.5]}], [7.0, "foreground"]]}
        ]))}),
    )
    .unwrap();
    let find = |s: &Session, n: &str| s.presets.gradients.iter().flat_map(|g| &g.items).find(|g| g.name == n).unwrap().clone();
    let one = find(&s, "One");
    assert_eq!(one.stops.iter().map(|(t, _)| *t).collect::<Vec<_>>(), [0.0, 1.0], "one stop: its colour all along");
    assert!(one.stops.iter().all(|(_, c)| *c == crate::presets::gradients::StopColor::Rgb([1.0, 0.0, 0.0])));
    let far = find(&s, "Far");
    assert_eq!(far.stops[0], (0.0, crate::presets::gradients::StopColor::Rgb([1.0, 0.0, 0.5])));
    assert_eq!(far.stops[1].0, 1.0);
}
