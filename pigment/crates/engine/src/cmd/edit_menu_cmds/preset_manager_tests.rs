//! Pigment: the Preset Manager over every kind (P1a).

use serde_json::{Value, json};

use super::PRESET_KINDS;
use crate::Session;

mod csh {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/common/csh_fixture.rs"));
}

const CMD: &str = "edit.presets.presetManager";

fn names(s: &mut Session, kind: &str) -> Vec<String> {
    let out = s.execute(CMD, json!({"kind": kind})).unwrap();
    serde_json::from_value(out[kind].clone()).unwrap()
}

fn rows(s: &mut Session, kind: &str) -> Vec<Value> {
    let out = s.execute(CMD, json!({"kind": kind})).unwrap();
    out["info"][kind]["rows"].as_array().unwrap().clone()
}

fn index_of(s: &mut Session, kind: &str, name: &str) -> usize {
    names(s, kind).iter().position(|n| n == name).unwrap_or_else(|| panic!("no {kind} preset {name}"))
}

/// A session with one user contour and one tool preset, so every kind has presets.
fn session() -> Session {
    let mut s = Session::new();
    s.execute("layer.layerStyle.contours.new", json!({"contour": {"name": "Bump", "points": [[0, 0], [0.5, 1], [1, 0]]}, "name": "Bump"})).unwrap();
    s.execute("layer.layerStyle.contours.new", json!({"contour": {"name": "Ramp", "points": [[0, 0], [1, 0.5]]}, "name": "Ramp"})).unwrap();
    s
}

fn data(out: &Value) -> String {
    out["data"].as_str().unwrap_or_else(|| panic!("no data in {out}")).to_string()
}

#[test]
fn list_covers_all_nine_kinds_with_their_hints() {
    let mut s = session();
    let out = s.execute(CMD, json!({})).unwrap();
    for kind in PRESET_KINDS {
        let names = out[kind].as_array().unwrap_or_else(|| panic!("{kind} listed"));
        assert!(!names.is_empty(), "{kind} has presets");
        let info = &out["info"][kind];
        assert!(info["thumb"].is_string(), "{kind}");
        assert_eq!(info["rows"].as_array().unwrap().len(), names.len(), "{kind}");
        assert!(!info["save"].as_array().unwrap().is_empty(), "{kind} saves");
        assert!(!info["load"].as_array().unwrap().is_empty(), "{kind} loads");
    }
    let thumbs: Vec<&str> = PRESET_KINDS.iter().map(|k| out["info"][k]["thumb"].as_str().unwrap()).collect();
    assert_eq!(thumbs, ["brush", "swatch", "gradient", "style", "pattern", "contour", "shape", "tool", "adjustment"]);
    // Rows carry their group; swatches their colour.
    let sw = &out["info"]["swatches"]["rows"][0];
    assert!(sw["group"].is_string() && sw["hint"].as_str().is_some_and(|h| h.starts_with('#')), "{sw}");
    let adj = rows(&mut s, "adjustments");
    assert!(adj.iter().any(|r| r["group"] == "Curves" && r["key"] == "curves"), "adjustments are grouped by kind");
    assert_eq!(out["info"]["brushes"]["canReset"], false);
    assert_eq!(out["info"]["patterns"]["canReset"], false);
    assert_eq!(out["info"]["contours"]["canReset"], false);
    for kind in ["swatches", "gradients", "styles", "customShapes", "tools", "adjustments"] {
        assert_eq!(out["info"][kind]["canReset"], true, "{kind}");
    }
    assert!(s.execute(CMD, json!({"kind": "nope"})).is_err());
    assert!(s.execute(CMD, json!({"action": "explode", "kind": "brushes"})).is_err());
}

#[test]
fn a_defined_custom_shape_is_listed_once() {
    let mut s = Session::new();
    s.execute("file.new", json!({"width": 32, "height": 32})).unwrap();
    s.edit("path", |doc, _| {
        doc.work_path = Some(photocraft_doc::Path::new(vec![photocraft_doc::Subpath::polygon(&[(4.0, 4.0), (20.0, 4.0), (12.0, 20.0)])]));
        Ok(())
    })
    .unwrap();
    s.execute("edit.defineCustomShape", json!({"name": "Wedge"})).unwrap();
    let all = names(&mut s, "customShapes");
    assert_eq!(all.iter().filter(|n| *n == "Wedge").count(), 1);
    let row = rows(&mut s, "customShapes").into_iter().find(|r| r["name"] == "Wedge").unwrap();
    assert_eq!(row["group"], crate::presets::shapes::CUSTOM_GROUP);
    // Rename and delete reach the Define Custom Shape library.
    let i = index_of(&mut s, "customShapes", "Wedge");
    s.execute(CMD, json!({"action": "rename", "kind": "customShapes", "index": i, "newName": "Spike"})).unwrap();
    assert_eq!(crate::edit_menu_cmds::custom_shapes(&s)[0].name, "Spike");
    // A custom shape stays in its group.
    assert!(s.execute(CMD, json!({"action": "move", "kind": "customShapes", "name": "Spike", "to": 0})).is_err());
    s.execute(CMD, json!({"action": "delete", "kind": "customShapes", "name": "Spike"})).unwrap();
    assert!(crate::edit_menu_cmds::custom_shapes(&s).is_empty());
}

#[test]
fn multi_delete_removes_exactly_those_presets() {
    let mut s = session();
    for kind in ["brushes", "swatches", "gradients", "styles", "patterns", "contours", "customShapes", "tools", "adjustments"] {
        let before = names(&mut s, kind);
        let n = before.len();
        let pick: Vec<usize> = if n >= 3 { vec![0, n - 1] } else { vec![0] };
        s.execute(CMD, json!({"action": "delete", "kind": kind, "indices": pick})).unwrap_or_else(|e| panic!("{kind}: {e}"));
        let after = names(&mut s, kind);
        let expect: Vec<String> = before.iter().enumerate().filter(|(i, _)| !pick.contains(i)).map(|(_, n)| n.clone()).collect();
        assert_eq!(after, expect, "{kind}");
    }
    // All or none: one bad index deletes nothing.
    let before = names(&mut s, "gradients");
    assert!(s.execute(CMD, json!({"action": "delete", "kind": "gradients", "indices": [0, 99999]})).is_err());
    assert_eq!(names(&mut s, "gradients"), before);
    assert!(s.execute(CMD, json!({"action": "delete", "kind": "gradients", "indices": []})).is_err());
    assert!(s.execute(CMD, json!({"action": "delete", "kind": "gradients", "indices": "0"})).is_err());
}

#[test]
fn rename_and_move_in_every_kind_that_reorders() {
    let mut s = session();
    for kind in PRESET_KINDS {
        let first = names(&mut s, kind)[0].clone();
        s.execute(CMD, json!({"action": "rename", "kind": kind, "index": 0, "newName": "Renamed One"})).unwrap_or_else(|e| panic!("{kind}: {e}"));
        let after = names(&mut s, kind);
        assert!(after.contains(&"Renamed One".to_string()) && !after.contains(&first), "{kind}: {after:?}");
    }
    // Move the first preset to the second place, within its folder.
    for kind in ["brushes", "swatches", "gradients", "styles", "patterns", "contours", "customShapes", "tools"] {
        let before = rows(&mut s, kind);
        let (a, b) = (before[0]["name"].clone(), before[1]["name"].clone());
        assert_eq!(before[0]["group"], before[1]["group"], "{kind}: the first two share a folder");
        s.execute(CMD, json!({"action": "move", "kind": kind, "index": 0, "to": 1})).unwrap_or_else(|e| panic!("{kind}: {e}"));
        let after = rows(&mut s, kind);
        assert_eq!((after[0]["name"].clone(), after[1]["name"].clone()), (b, a), "{kind}");
    }
    // Into another folder, by name and position.
    let g = rows(&mut s, "gradients");
    let other = g.iter().map(|r| r["group"].as_str().unwrap().to_string()).find(|n| *n != g[0]["group"]).unwrap();
    let name = g[0]["name"].as_str().unwrap().to_string();
    s.execute(CMD, json!({"action": "move", "kind": "gradients", "index": 0, "toGroup": other, "position": 0})).unwrap();
    let moved = rows(&mut s, "gradients").into_iter().find(|r| r["name"] == name.as_str()).unwrap();
    assert_eq!(moved["group"], other.as_str());
    assert!(s.execute(CMD, json!({"action": "move", "kind": "adjustments", "index": 0, "to": 1})).is_err(), "adjustment presets keep their order");
    assert!(s.execute(CMD, json!({"action": "move", "kind": "gradients", "index": 0, "toGroup": "No such group"})).is_err());
}

/// Save Set… of two presets writes the kind's file, and Load… of that file brings back the same names.
#[test]
fn save_set_writes_a_file_that_loads_back_with_the_same_names() {
    for (kind, ext) in [("swatches", "aco"), ("styles", "asl"), ("patterns", "pat"), ("contours", "shc"), ("gradients", "grd"), ("tools", "pcpresets")] {
        let mut s = session();
        let all = names(&mut s, kind);
        let chosen = [all[0].clone(), all[1].clone()];
        let out = s.execute(CMD, json!({"action": "saveSet", "kind": kind, "indices": [0, 1]})).unwrap_or_else(|e| panic!("{kind}: {e}"));
        assert_eq!(out["count"], 2, "{kind}");
        let file = out["fileName"].as_str().unwrap();
        assert!(file.ends_with(&format!(".{ext}")), "{kind}: {file}");
        // Replace in another session: the library is exactly the file's presets.
        let mut t = session();
        let r = t
            .execute(CMD, json!({"action": "load", "kind": kind, "data": data(&out), "fileName": file, "replace": true}))
            .unwrap_or_else(|e| panic!("{kind}: {e}"));
        assert_eq!(r["kind"], kind);
        let mut back = names(&mut t, kind);
        back.sort();
        let mut want = chosen.to_vec();
        want.sort();
        assert_eq!(back, want, "{kind}: Replace… keeps only the file's presets");
        // Load… adds them beside what is there.
        let n = names(&mut s, kind).len();
        s.execute(CMD, json!({"action": "load", "kind": kind, "data": data(&out), "fileName": file})).unwrap();
        assert!(names(&mut s, kind).len() >= n, "{kind}");
    }
}

#[test]
fn save_set_to_a_path_and_one_preset_names_the_file() {
    let mut s = session();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("two.grd");
    let out = s.execute(CMD, json!({"action": "saveSet", "kind": "gradients", "indices": [0, 1], "path": path.to_str().unwrap()})).unwrap();
    assert_eq!(out["path"], json!(path.to_str().unwrap()));
    assert!(out.get("data").is_none());
    assert_eq!(craft_psd::grd::parse(&std::fs::read(&path).unwrap()).unwrap().len(), 2);
    let first = names(&mut s, "gradients")[0].clone();
    let one = s.execute(CMD, json!({"action": "saveSet", "kind": "gradients", "index": 0})).unwrap();
    assert_eq!(one["fileName"], json!(format!("{first}.grd")));
    let all = s.execute(CMD, json!({"action": "saveSet", "kind": "swatches", "format": "ase"})).unwrap();
    assert!(all["fileName"].as_str().unwrap().ends_with(".ase"));
    assert!(s.execute(CMD, json!({"action": "saveSet", "kind": "gradients", "format": "aco"})).is_err(), "gradients don't save as swatches");
    // Brushes and custom shapes travel in .pcpresets; Photoshop's adjustment files hold one preset.
    let b = s.execute(CMD, json!({"action": "saveSet", "kind": "brushes", "indices": [0]})).unwrap();
    assert!(b["fileName"].as_str().unwrap().ends_with(".pcpresets"));
    let i = index_of(&mut s, "adjustments", "Strong Contrast (RGB)");
    let acv = s.execute(CMD, json!({"action": "saveSet", "kind": "adjustments", "index": i})).unwrap();
    assert_eq!(acv["fileName"], "Strong Contrast (RGB).acv");
    assert!(s.execute(CMD, json!({"action": "saveSet", "kind": "adjustments", "indices": [i, i + 1], "format": "acv"})).is_err());
    // P1b: several adjustment presets travel together in a .pcpresets.
    let two = s.execute(CMD, json!({"action": "saveSet", "kind": "adjustments", "indices": [i, i + 1]})).unwrap();
    assert_eq!(two["fileName"], "Presets.pcpresets");
    assert_eq!(two["count"], 2);
}

#[test]
fn load_dispatches_each_extension_to_its_kind() {
    let mut s = session();
    let mut src = session();
    // Files made by each kind's own writer (and the importers' fixtures for .abr and .csh).
    let abr = craft_psd::abr::write_v12(
        2,
        &[craft_psd::abr::LegacyBrush {
            name: "Round Nine".into(),
            spacing: 10,
            anti_alias: true,
            tip: craft_psd::abr::LegacyTip::Computed { diameter: 9, hardness: 100, angle: 0, roundness: 100 },
        }],
        true,
    )
    .unwrap();
    let b64 = photocraft_paint::tile::b64_encode;
    let file = |out: Value| data(&out);
    let cases: Vec<(&str, String, &str)> = vec![
        ("Nine.abr", b64(&abr), "brushes"),
        ("Two.aco", file(src.execute("swatches.export", json!({"format": "aco"})).unwrap()), "swatches"),
        ("Two.ase", file(src.execute("swatches.export", json!({"format": "ase"})).unwrap()), "swatches"),
        ("Two.gpl", file(src.execute("swatches.export", json!({"format": "gpl"})).unwrap()), "swatches"),
        ("Two.grd", file(src.execute("gradient.presets.exportGrd", json!({})).unwrap()), "gradients"),
        ("Two.asl", file(src.execute("style.presets.exportAsl", json!({})).unwrap()), "styles"),
        ("Two.pat", file(src.execute("pattern.export", json!({})).unwrap()), "patterns"),
        ("Two.shc", file(src.execute("layer.layerStyle.contours.save", json!({})).unwrap()), "contours"),
        ("Tri.csh", b64(&csh::triangle_csh()), "customShapes"),
        ("Contrast.acv", file(src.execute("adjustment.presets.export", json!({"kind": "curves", "name": "Strong Contrast (RGB)"})).unwrap()), "adjustments"),
    ];
    for (name, bytes, kind) in cases {
        let before = names(&mut s, kind).len();
        let out = s.execute(CMD, json!({"action": "load", "data": bytes, "fileName": name})).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(out["kind"], kind, "{name}");
        assert!(names(&mut s, kind).len() > before || kind == "patterns", "{name} adds presets");
    }
    // A loaded .abr, .grd or .asl names its group after the file.
    assert!(s.tools.presets.iter().any(|b| b.group == "Nine"), "{:?}", s.tools.presets.iter().map(|b| (&b.name, &b.group)).collect::<Vec<_>>());
    assert!(s.presets.gradients.iter().any(|g| g.name == "Two"));
    assert!(s.presets.styles.iter().any(|g| g.name == "Two"));
    assert!(names(&mut s, "adjustments").iter().any(|n| n == "Contrast"));
    // .pcpresets: the kind says which part of the file to read.
    let set = s.execute(CMD, json!({"action": "saveSet", "kind": "tools", "indices": [0]})).unwrap();
    let mut t = session();
    t.presets.tool_presets.clear();
    t.execute(CMD, json!({"action": "load", "kind": "tools", "data": data(&set), "fileName": "T.pcpresets"})).unwrap();
    assert_eq!(names(&mut t, "tools").len(), 1);
    assert!(t.execute(CMD, json!({"action": "load", "data": data(&set), "fileName": "T.pcpresets"})).is_err(), "several kinds read .pcpresets: give the kind");
    // Unknown and mismatched extensions, missing data.
    assert!(s.execute(CMD, json!({"action": "load", "data": "AAAA", "fileName": "x.doc"})).is_err());
    assert!(s.execute(CMD, json!({"action": "load", "kind": "gradients", "data": "AAAA", "fileName": "x.aco"})).is_err());
    assert!(s.execute(CMD, json!({"action": "load", "fileName": "x.grd"})).is_err());
    assert!(s.execute(CMD, json!({"action": "load", "data": 5, "fileName": "x.grd"})).is_err());
    assert!(s.execute(CMD, json!({"action": "load", "kind": "adjustments", "data": "AAAA", "fileName": "x.acv", "replace": true})).is_err());
}

#[test]
fn a_replace_that_fails_changes_nothing() {
    let mut s = session();
    let before = names(&mut s, "gradients");
    let r =
        s.execute(CMD, json!({"action": "load", "data": photocraft_paint::tile::b64_encode(b"not a gradient file"), "fileName": "Bad.grd", "replace": true}));
    assert!(r.is_err());
    assert_eq!(names(&mut s, "gradients"), before);
    let before = names(&mut s, "brushes");
    assert!(s.execute(CMD, json!({"action": "load", "data": "AAAA", "fileName": "Bad.abr", "replace": true})).is_err());
    assert_eq!(names(&mut s, "brushes"), before);
}

#[test]
fn reset_runs_the_kinds_reset_and_refuses_kinds_without_one() {
    let mut s = session();
    let defaults = names(&mut s, "gradients");
    s.execute(CMD, json!({"action": "delete", "kind": "gradients", "indices": [0, 1, 2]})).unwrap();
    s.execute(CMD, json!({"action": "reset", "kind": "gradients"})).unwrap();
    assert_eq!(names(&mut s, "gradients"), defaults);
    let curves = names(&mut s, "adjustments");
    s.execute(CMD, json!({"action": "delete", "kind": "adjustments", "index": 0})).unwrap();
    s.execute(CMD, json!({"action": "reset", "kind": "adjustments"})).unwrap();
    assert_eq!(names(&mut s, "adjustments"), curves, "the built-in comes back");
    for kind in ["brushes", "patterns", "contours"] {
        let before = names(&mut s, kind);
        let e = s.execute(CMD, json!({"action": "reset", "kind": kind})).unwrap_err().to_string();
        assert!(e.contains("no default set"), "{kind}: {e}");
        assert_eq!(names(&mut s, kind), before);
    }
}

#[test]
fn the_manager_changes_the_libraries_not_the_documents_history() {
    let mut s = session();
    s.execute("file.new", json!({"width": 8, "height": 8})).unwrap();
    let steps = s.active().unwrap().history.entries().len();
    let rev = s.presets.rev;
    s.execute(CMD, json!({"action": "delete", "kind": "styles", "index": 0})).unwrap();
    s.execute(CMD, json!({"action": "rename", "kind": "swatches", "index": 0, "newName": "Mine"})).unwrap();
    assert!(s.presets.rev > rev, "the preferences are marked changed");
    assert_eq!(s.active().unwrap().history.entries().len(), steps);
}

#[test]
fn adversarial_params_are_errors() {
    let mut s = session();
    for p in [
        json!({"action": "rename", "kind": "gradients"}),
        json!({"action": "rename", "kind": "gradients", "index": 0}),
        json!({"action": "rename", "kind": "gradients", "index": -1, "newName": "x"}),
        json!({"action": "rename", "kind": "gradients", "index": 0, "newName": ""}),
        json!({"action": "delete", "kind": 5, "index": 0}),
        json!({"action": "delete", "kind": "tools", "name": "No such preset"}),
        json!({"action": "move", "kind": "tools", "index": 0}),
        json!({"action": "move", "kind": "tools", "index": 0, "to": -3}),
        json!({"action": "move", "kind": "swatches", "index": 0, "toGroup": 7}),
        json!({"action": "saveSet", "kind": "tools", "indices": [1e9]}),
        json!({"action": "load", "data": "%%%", "fileName": "a.grd"}),
        json!({"action": "load", "data": "AAAA", "fileName": "a.grd", "replace": "yes"}),
        json!({"action": "reset"}),
        json!({"kind": []}),
    ] {
        assert!(s.execute(CMD, p.clone()).is_err(), "{p}");
    }
    // Moving past the end lands at the end.
    let n = names(&mut s, "tools").len();
    let first = names(&mut s, "tools")[0].clone();
    s.execute(CMD, json!({"action": "move", "kind": "tools", "index": 0, "to": 9999})).unwrap();
    assert_eq!(names(&mut s, "tools")[n - 1], first);
}
