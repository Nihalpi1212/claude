//! Pigment: Edit › Presets › Migrate Presets from the JavaScript Pigment's settings folder and
//! `.pigment-bundle` (P4). The fixture is `tests/fixtures/pigment-0.4-presets` (README there).

use std::path::{Path, PathBuf};

use photocraft_engine::Session;
use photocraft_format::zip::ZipWriter;
use serde_json::{Value, json};

const CMD: &str = "edit.presets.migratePresets";

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pigment-0.4-presets")
}

/// A copy of the fixture in a fresh temporary folder.
fn copy_fixture(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pigment-migrate-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    fn copy(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for e in std::fs::read_dir(from).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                copy(&p, &to.join(e.file_name()));
            } else {
                std::fs::copy(&p, to.join(e.file_name())).unwrap();
            }
        }
    }
    copy(&fixture(), &dir);
    dir
}

fn migrate(s: &mut Session, path: &Path) -> Value {
    s.execute(CMD, json!({"path": path.to_string_lossy()})).unwrap()
}

fn names<T>(groups: &[photocraft_engine::presets::Group<T>], name: impl Fn(&T) -> &str) -> Vec<(String, String)> {
    groups.iter().flat_map(|g| g.items.iter().map(|i| (g.name.clone(), name(i).to_string()))).collect()
}

fn skipped(r: &Value) -> Vec<(String, String)> {
    r["skipped"].as_array().unwrap().iter().map(|k| (k["kind"].as_str().unwrap().to_string(), k["name"].as_str().unwrap().to_string())).collect()
}

#[test]
fn every_kind_of_the_folder_migrates() {
    let mut s = Session::new();
    let r = migrate(&mut s, &fixture());
    let added = &r["added"];
    for (kind, n) in [
        ("swatches", 6),
        ("gradients", 3),
        ("styles", 1),
        ("patterns", 1),
        ("contours", 1),
        ("customShapes", 1),
        ("tools", 3),
        ("adjustments", 2),
        ("brushes", 2),
        ("settings", 2),
    ] {
        assert_eq!(added[kind], n, "{kind}: {r:#}");
    }
    assert_eq!(r["migrated"], 22, "{r:#}");
    assert!(r["found"].as_u64().unwrap() >= 13);

    // Swatches: the store's groups and colours, and Pigment 0.4's own palette from settings.json.
    let sw = serde_json::to_value(&s.presets.swatches).unwrap();
    let group = |name: &str| sw.as_array().unwrap().iter().find(|g| g["name"] == name).cloned().unwrap_or_else(|| panic!("{name}: {sw}"));
    let brand = group("Brand");
    assert_eq!(brand["entries"][0]["name"], "Brand Red");
    let ink = brand["entries"][1]["color"].to_string().to_lowercase();
    assert!(ink.contains("cmyk") && ink.contains("[1.0,0.8") && ink.contains("0.2"), "{ink}");
    let old = group("Pigment 0.4");
    let old_names: Vec<&str> = old["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
    assert_eq!(old_names, ["Paper", "Half Grey", "#112233", "#ffcc00"]);

    // Gradients: groups kept, foreground/background references kept, the noise gradient's settings.
    let grads = names(&s.presets.gradients, |g| &g.name);
    assert!(grads.contains(&("Skies".into(), "Sunset".into())) && grads.contains(&("Pigment 0.4".into(), "Ink to Paper".into())), "{grads:?}");
    let ink = s.presets.gradients.iter().flat_map(|g| &g.items).find(|g| g.name == "Ink to Paper").unwrap();
    assert!(matches!(ink.stops[..], [(_, photocraft_engine::presets::gradients::StopColor::Foreground), (_, photocraft_engine::presets::gradients::StopColor::Background)]));
    let sunset = s.presets.gradients.iter().flat_map(|g| &g.items).find(|g| g.name == "Sunset").unwrap();
    assert_eq!(sunset.stops.len(), 3);
    assert_eq!(sunset.opacity, [(0.0, 1.0), (1.0, 0.5)]);
    let noise = s.presets.gradients.iter().flat_map(|g| &g.items).find(|g| g.name == "Static").unwrap();
    assert_eq!(noise.noise.as_ref().map(|n| (n.seed, n.restrict)), Some((42, true)));

    // Adjustment presets (A1's library): Curves and Hue/Saturation; Shadows/Highlights has none.
    let curves = s.execute("adjustment.presets.list", json!({"kind": "curves", "params": true})).unwrap();
    let soft = curves["curves"].as_array().unwrap().iter().find(|p| p["name"] == "Soft Matte").unwrap_or_else(|| panic!("{curves}"));
    assert!(soft["params"].to_string().contains("32"), "{soft}");
    let hs = s.execute("adjustment.presets.list", json!({"kind": "hueSaturation", "params": true})).unwrap();
    assert!(hs["hueSaturation"].as_array().unwrap().iter().any(|p| p["name"] == "Muted" && p["params"]["saturation"] == -40), "{hs}");

    // Tool presets: options mapped, the pencil's sampled tip read from brushes/, the colour.
    let tool = |n: &str| s.presets.tool_presets.iter().find(|t| t.name == n).unwrap_or_else(|| panic!("{n}")).clone();
    let air = tool("Soft Airbrush 40");
    assert_eq!(air.tool, "brush");
    assert_eq!((air.options["brush"]["size"].as_f64(), air.options["brush"]["buildUp"].as_bool()), (Some(40.0), Some(true)));
    let pencil = tool("Inked Pencil");
    assert_eq!(pencil.options["brush"]["tip"]["sampled"]["width"], 5, "{}", pencil.options);
    assert_eq!(pencil.options["foreground"][2].as_f64().map(|b| (b * 255.0).round()), Some(128.0));
    assert_eq!(tool("Wand 20").options["toolOptions"]["tolerance"], 20.0);

    // Brushes: the store's (sampled tip, dynamics, group) and settings.json's flat one.
    let ink = s.tools.presets.iter().find(|b| b.name == "Grainy Ink").unwrap();
    assert_eq!(ink.group, "Inking");
    assert!(matches!(ink.brush.tip, photocraft_engine::paint::TipShape::Sampled(ref t) if (t.width, t.height) == (5, 3)) || matches!(ink.brush.tip, photocraft_engine::paint::TipShape::Stored(_)));
    assert_eq!((ink.brush.size, ink.brush.angle, ink.brush.scattering.count), (30.0, 15.0, 2));
    let big = s.tools.presets.iter().find(|b| b.name == "Big Soft").unwrap();
    assert_eq!((big.brush.size, big.brush.hardness, big.brush.flow), (120.0, 0.1, 0.5));

    // Patterns, styles, shapes, contours.
    assert!(s.patterns.items.iter().any(|p| p.name == "Checks" && (p.width, p.height) == (4, 4)));
    assert!(names(&s.presets.pattern_groups, |id| id).iter().any(|(g, _)| g == "Textures"));
    let style = s.presets.styles.iter().flat_map(|g| &g.items).find(|p| p.name == "Lifted").unwrap();
    assert_eq!((style.effects.len(), style.fill_opacity), (1, Some(0.8)));
    let kite = s.presets.shapes.iter().find(|g| g.name == "My Shapes").and_then(|g| g.items.iter().find(|p| p.name == "Kite")).unwrap();
    assert_eq!(kite.path.subpaths[0].knots[1].anchor.x, 100.0, "shapes come into the library's 0..100 box");
    assert!(s.presets.contours.iter().any(|c| matches!(c, photocraft_engine::doc::Contour::Custom { name, .. } if name == "Double Dip")));

    // settings.json: Auto Color Correction Options saved as the defaults, Curve Display Options.
    let a = &s.prefs().adjustments;
    assert!(a.auto_options_saved);
    assert_eq!((a.auto_options.0.shadow, a.auto_options.0.snap_neutral), ([16, 16, 16], true));
    let shown = serde_json::to_value(&a.curves_display).unwrap();
    assert_eq!((shown["grid"].as_str(), shown["baseline"].as_bool(), shown["channelOverlays"].as_bool()), (Some("detailed"), Some(false), Some(false)), "{shown}");

    // What was not migrated, each with a reason.
    let sk = skipped(&r);
    for want in [
        ("patterns", "Lost"),
        ("tool-presets", "Adjust Brush"),
        ("stroke-styles", ""),
        ("adjustment:shadows-highlights", ""),
        ("actions", "My Actions"),
    ] {
        assert!(sk.contains(&(want.0.into(), want.1.into())), "{want:?} in {sk:?}");
    }
    assert!(r["skipped"].as_array().unwrap().iter().all(|k| !k["reason"].as_str().unwrap().is_empty()));
    assert!(r["skipped"].to_string().contains("record the action again"));
    // Built-ins as shipped (`{ref}`) are neither added nor reported.
    assert!(!sk.iter().any(|(_, n)| n == "darker" || n == "soft-round"));
}

#[test]
fn migrating_twice_adds_nothing() {
    let mut s = Session::new();
    migrate(&mut s, &fixture());
    let prefs = s.prefs_to_json();
    let (brushes, rev) = (s.tools.presets.len(), s.presets.rev);
    let r = migrate(&mut s, &fixture());
    assert_eq!(r["migrated"], 0, "{r:#}");
    assert_eq!(r["added"], json!({}));
    assert!(r["unchanged"]["gradients"].as_u64().unwrap() >= 3 && r["unchanged"]["brushes"] == 2 && r["unchanged"]["settings"] == 2, "{r:#}");
    assert_eq!((s.tools.presets.len(), s.presets.rev), (brushes, rev));
    assert_eq!(s.prefs_to_json(), prefs, "nothing changes the second time");
    // Through the preferences and back (as after a restart) still nothing.
    // (Brush presets and patterns live in their own stores, not the preferences: a fresh session
    // has none of them, so they are added again.)
    let mut t = Session::new();
    t.load_prefs_json(&prefs).unwrap();
    let r = migrate(&mut t, &fixture());
    let added: Vec<&String> = r["added"].as_object().unwrap().keys().collect();
    assert_eq!(added, ["brushes", "patterns"], "{r:#}");
}

#[test]
fn the_presets_folder_itself_reads_its_parents_settings() {
    let mut s = Session::new();
    let r = migrate(&mut s, &fixture().join("presets"));
    assert_eq!(r["added"]["settings"], 2, "{r:#}");
    assert_eq!(r["added"]["gradients"], 3);
}

#[test]
fn a_corrupt_kind_file_is_skipped_with_a_report_entry() {
    let dir = copy_fixture("corrupt");
    std::fs::write(dir.join("presets/gradients.json"), b"{ not json").unwrap();
    std::fs::write(dir.join("presets/contours.json"), br#"{"format":"something-else","items":[]}"#).unwrap();
    let mut s = Session::new();
    let before = names(&s.presets.gradients, |g| &g.name);
    let r = migrate(&mut s, &dir);
    let sk = skipped(&r);
    assert!(sk.contains(&("gradients".into(), "gradients.json".into())) && sk.contains(&("contours".into(), "contours.json".into())), "{sk:?}");
    assert_eq!(names(&s.presets.gradients, |g| &g.name), before);
    assert_eq!(r["added"]["swatches"], 6, "the other kinds still migrate: {r:#}");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn no_folder_is_an_error_and_an_empty_folder_finds_nothing() {
    let mut s = Session::new();
    let e = s.execute(CMD, json!({})).unwrap_err().to_string();
    assert!(e.contains("no Pigment 0.4 presets folder"), "{e}");
    let dir = std::env::temp_dir().join(format!("pigment-migrate-empty-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let r = migrate(&mut s, &dir);
    assert_eq!((r["migrated"].as_u64(), r["found"].as_u64()), (Some(0), Some(0)));
    let _ = std::fs::remove_dir_all(dir);
}

/// A `.pigment-bundle` as the JS Export/Import Presets wrote it, from the fixture's files.
fn bundle() -> Vec<u8> {
    let read = |name: &str| -> Value { serde_json::from_slice(&std::fs::read(fixture().join("presets").join(name)).unwrap()).unwrap() };
    let entry = |v: Value| json!({"kindVersion": 1, "groups": v["groups"], "items": v["items"].as_array().unwrap().iter().filter(|i| i.get("ref").is_none()).cloned().collect::<Vec<_>>()});
    let manifest = json!({
        "format": "pigment-bundle", "version": 1, "created": "2026-01-01T00:00:00.000Z",
        "kinds": {
            "gradients": entry(read("gradients.json")),
            "patterns": entry(read("patterns.json")),
            "adjustment:curves": entry(read("adjustment__curves.json")),
            "camera-raw-presets": {"kindVersion": 1, "groups": [], "items": [{"id": "cr", "name": "Warm", "group": null, "data": {"params": {}}}]},
        },
        "settings": {"tools": {}},
    });
    let mut z = ZipWriter::new();
    z.add("bundle.json", manifest.to_string().as_bytes()).unwrap();
    z.add("blobs/patterns/p1.png", &std::fs::read(fixture().join("presets/patterns/p1.png")).unwrap()).unwrap();
    z.finish().unwrap()
}

#[test]
fn a_pigment_bundle_imports_through_migrate_presets_and_export_import() {
    let bytes = bundle();
    let file = std::env::temp_dir().join(format!("pigment-migrate-{}.pigment-bundle", std::process::id()));
    std::fs::write(&file, &bytes).unwrap();
    let mut s = Session::new();
    let r = migrate(&mut s, &file);
    assert_eq!((r["added"]["gradients"].as_u64(), r["added"]["patterns"].as_u64(), r["added"]["adjustments"].as_u64()), (Some(3), Some(1), Some(1)), "{r:#}");
    assert!(skipped(&r).contains(&("camera-raw-presets".into(), String::new())), "{r:#}");
    assert!(r["notes"].to_string().contains("settings"), "{r:#}");
    assert!(s.patterns.items.iter().any(|p| p.name == "Checks"));
    // Again: nothing more.
    assert_eq!(migrate(&mut s, &file)["migrated"], 0);

    // Edit › Presets › Export/Import Presets › Import of the same bundle (base64, as the dialog sends it).
    let mut t = Session::new();
    let data = photocraft_engine::paint::tile::b64_encode(&bytes);
    let kinds = ["gradients", "patterns"];
    let r = t.execute("edit.presets.exportImportPresets", json!({"action": "import", "kinds": kinds, "data": data})).unwrap();
    assert_eq!((r["added"]["gradients"].as_u64(), r["added"]["patterns"].as_u64()), (Some(3), Some(1)), "{r:#}");
    assert_eq!(r["added"].get("adjustments"), None, "unchecked kinds stay out: {r:#}");
    let r = t.execute("edit.presets.exportImportPresets", json!({"action": "import", "kinds": kinds, "data": data})).unwrap();
    assert_eq!(r["migrated"], 0);
    let _ = std::fs::remove_file(file);
}

#[test]
fn hostile_folders_and_bundles_never_panic() {
    let dir = std::env::temp_dir().join(format!("pigment-migrate-hostile-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("patterns")).unwrap();
    for (name, text) in [
        ("gradients.json", r#"{"format":"pigment-presets","items":[{"id":"a","name":"x","data":7},{"id":"b","data":{"gradientVersion":2,"stops":"no"}}]}"#),
        ("patterns.json", r#"{"format":"pigment-presets","items":[{"id":"a","name":"p","data":{"blob":"../../etc/passwd"}},{"id":"b","name":"q","data":{"blob":"x.png"}}]}"#),
        ("brushes.json", r#"{"format":"pigment-presets","items":[{"id":"a","name":"b","data":{"tip":{"kind":"sampled","size":"huge","sample":{"blob":"x.png"}}}}]}"#),
        ("tool-presets.json", r#"{"format":"pigment-presets","items":[{"id":"a","data":{"tool":7}},{"id":"b","data":{"tool":"brush","options":{"size":-5,"opacity":"x"}}}]}"#),
        ("adjustment__levels.json", r#"{"format":"pigment-presets","items":[{"id":"a","name":"L","data":{"rgb":{"inBlack":"x"}}}]}"#),
        ("swatches.json", r#"{"format":"pigment-presets","items":[{"id":"a","data":{"color":{"space":"rgb","values":[1e308,"x"]}}}]}"#),
        ("settings.json", r##"{"adjust":{"autoOptions":{"algorithm":"nope"},"curvesDisplay":{"grid":5}},"swatches":[3,"#zz"],"brushPresets":[{"size":"x"}],"actions":{"sets":7}}"##),
    ] {
        std::fs::write(dir.join(name), text).unwrap();
    }
    std::fs::write(dir.join("patterns/x.png"), b"\x89PNG not really").unwrap();
    let mut s = Session::new();
    let r = migrate(&mut s, &dir);
    assert!(r["skipped"].as_array().unwrap().len() >= 3, "{r:#}");
    for bytes in [b"PK\x03\x04".to_vec(), bundle()[..40].to_vec()] {
        let f = dir.join("b.pigment-bundle");
        std::fs::write(&f, bytes).unwrap();
        assert!(s.execute(CMD, json!({"path": f.to_string_lossy()})).is_err());
    }
    let _ = std::fs::remove_dir_all(dir);
}
