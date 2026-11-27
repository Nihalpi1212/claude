use serde_json::{Value, json};

use crate::Session;
use crate::presets::adjustments::{BUILTIN_GROUP, KINDS, USER_GROUP, builtin};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../io/tests/fixtures/adjust-presets");

fn names(s: &mut Session, kind: &str) -> Vec<String> {
    let v = s.execute("adjustment.presets.list", json!({"kind": kind})).unwrap();
    v[kind].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap().to_string()).collect()
}

fn b64(bytes: &[u8]) -> String {
    photocraft_paint::tile::b64_encode(bytes)
}

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!("{FIXTURES}/{name}")).unwrap()
}

#[test]
fn built_in_lists_are_the_javascript_apps() {
    let mut s = Session::new();
    assert_eq!(
        names(&mut s, "curves"),
        [
            "Color Negative (RGB)",
            "Cross Process (RGB)",
            "Darker (RGB)",
            "Increase Contrast (RGB)",
            "Lighter (RGB)",
            "Linear Contrast (RGB)",
            "Medium Contrast (RGB)",
            "Negative (RGB)",
            "Strong Contrast (RGB)"
        ]
    );
    assert_eq!(
        names(&mut s, "levels"),
        ["Darker", "Increase Contrast 1", "Increase Contrast 2", "Increase Contrast 3", "Lighten Shadows", "Lighter", "Midtones Brighter", "Midtones Darker"]
    );
    assert_eq!(names(&mut s, "exposure"), ["Minus 2.0", "Minus 1.0", "Plus 1.0", "Plus 2.0"]);
    assert_eq!(names(&mut s, "brightnessContrast"), ["Brighter", "Darker", "More Contrast", "Less Contrast"]);
    assert_eq!(names(&mut s, "threshold"), ["Dark (96)", "Middle (128)", "Light (160)"]);
    assert_eq!(names(&mut s, "hueSaturation").len(), 8);
    assert_eq!(names(&mut s, "blackWhite").len(), 12);
    assert_eq!(names(&mut s, "channelMixer").len(), 6);
    assert_eq!(names(&mut s, "hdrToning").len(), 8);
    for kind in ["vibrance", "colorBalance", "photoFilter", "posterize", "gradientMap", "selectiveColor", "colorLookup"] {
        assert!(names(&mut s, kind).is_empty(), "{kind}");
    }
    let all = s.execute("adjustment.presets.list", json!({})).unwrap();
    assert_eq!(all.as_object().unwrap().len(), KINDS.len());
    let v = s.execute("adjustment.presets.list", json!({"kind": "threshold", "params": true})).unwrap();
    assert_eq!(v["threshold"][0], json!({"group": BUILTIN_GROUP, "name": "Dark (96)", "id": "dark", "builtin": true, "params": {"level": 96}}));
}

#[test]
fn every_built_in_is_a_valid_setting_of_its_kind() {
    for kind in KINDS {
        for p in builtin(kind) {
            let kept = super::preset_params(kind, &p.params, "test").unwrap_or_else(|e| panic!("{kind} {}: {e}", p.name));
            assert_eq!(kept, p.params, "{kind} {}", p.name);
        }
    }
    // Strong Contrast is the JavaScript app's curve.
    let mut s = Session::new();
    let v = s.execute("adjustment.presets.get", json!({"kind": "curves", "name": "Strong Contrast (RGB)"})).unwrap();
    assert_eq!(v["params"], json!({"points": [[0, 0], [64, 32], [192, 224], [255, 255]]}));
    let v = s.execute("adjustment.presets.get", json!({"kind": "hdrToning", "id": "surrealistic"})).unwrap();
    assert_eq!((v["params"]["radius"].clone(), v["params"]["strength"].clone()), (json!(40), json!(1.0)));
}

#[test]
fn every_adjustment_layer_kind_with_settings_has_presets() {
    // The kinds of `layer.newAdjustmentLayer.*`: a kind added there (A6's) is added to KINDS too.
    let layer_kinds: Vec<&str> = crate::commands::command_specs().iter().filter_map(|c| c.id.strip_prefix("layer.newAdjustmentLayer.")).collect();
    assert!(layer_kinds.len() >= 16, "{layer_kinds:?}");
    for kind in layer_kinds.iter().filter(|k| **k != "invert") {
        assert!(KINDS.contains(kind), "{kind} has no presets");
    }
    for kind in KINDS.iter().filter(|k| **k != "hdrToning") {
        assert!(layer_kinds.contains(kind), "{kind}");
    }
    assert!(crate::commands::find("image.adjustments.hdrToning").is_some());
}

#[test]
fn save_rename_delete_and_reset() {
    let mut s = Session::new();
    let rev = s.presets.rev;
    let r = s.execute("adjustment.presets.save", json!({"kind": "levels", "name": "Mine", "params": {"inBlack": 4, "red": {"gamma": 1.1}, "eyedropper": null}})).unwrap();
    assert_eq!(r, json!({"kind": "levels", "name": "Mine", "replaced": false}));
    assert!(s.presets.rev > rev, "presets_changed bumps the revision");
    let v = s.execute("adjustment.presets.get", json!({"kind": "levels", "name": "Mine"})).unwrap();
    assert_eq!(v, json!({"group": USER_GROUP, "name": "Mine", "builtin": false, "params": {"inBlack": 4, "red": {"gamma": 1.1}}}));
    // A taken name is replaced in place.
    let r = s.execute("adjustment.presets.save", json!({"kind": "levels", "name": "Mine", "params": {"inBlack": 8}})).unwrap();
    assert_eq!(r["replaced"], json!(true));
    assert_eq!(names(&mut s, "levels").iter().filter(|n| *n == "Mine").count(), 1);
    assert_eq!(s.execute("adjustment.presets.get", json!({"kind": "levels", "name": "Mine"})).unwrap()["params"], json!({"inBlack": 8}));

    // Rename a user preset and a built-in; taken names are refused.
    s.execute("adjustment.presets.edit", json!({"kind": "levels", "action": "rename", "name": "Mine", "newName": "Ours"})).unwrap();
    s.execute("adjustment.presets.edit", json!({"kind": "levels", "action": "rename", "name": "Darker", "newName": "Dim"})).unwrap();
    assert!(s.execute("adjustment.presets.edit", json!({"kind": "levels", "action": "rename", "name": "Dim", "newName": "Lighter"})).is_err());
    let list = names(&mut s, "levels");
    assert_eq!(list[0], "Dim", "a renamed built-in keeps its place");
    assert!(list.contains(&"Ours".to_string()) && !list.contains(&"Darker".to_string()));
    assert_eq!(s.execute("adjustment.presets.get", json!({"kind": "levels", "id": "darker"})).unwrap()["name"], json!("Dim"));

    // Delete: all or none, built-ins remembered.
    assert!(s.execute("adjustment.presets.edit", json!({"kind": "levels", "action": "delete", "name": ["Ours", "Nope"]})).is_err());
    assert!(names(&mut s, "levels").contains(&"Ours".to_string()));
    let r = s.execute("adjustment.presets.edit", json!({"kind": "levels", "action": "delete", "name": ["Ours", "Lighter"]})).unwrap();
    assert_eq!(r["deleted"], json!(2));
    assert_eq!(s.presets.adjustments.kind("levels").hidden_builtins, ["lighter"]);

    // Saving under a built-in's name hides the built-in.
    s.execute("adjustment.presets.save", json!({"kind": "levels", "name": "Midtones Darker", "params": {"gamma": 0.5}})).unwrap();
    let list = s.execute("adjustment.presets.list", json!({"kind": "levels"})).unwrap();
    let md: Vec<&Value> = list["levels"].as_array().unwrap().iter().filter(|e| e["name"] == "Midtones Darker").collect();
    assert_eq!(md.len(), 1);
    assert_eq!(md[0]["builtin"], json!(false));

    // Reset: built-ins back with their names, the user's preset kept with a number.
    let r = s.execute("adjustment.presets.reset", json!({"kind": "levels"})).unwrap();
    assert_eq!(r["renamed"], json!([["Midtones Darker", "Midtones Darker 2"]]));
    let list = names(&mut s, "levels");
    assert_eq!(&list[..8], &builtin("levels").iter().map(|b| b.name.clone()).collect::<Vec<_>>()[..]);
    assert_eq!(&list[8..], ["Midtones Darker 2"]);
}

#[test]
fn bad_settings_are_refused() {
    let mut s = Session::new();
    for p in [
        json!({"kind": "levels", "name": "x", "params": "dark"}),
        json!({"kind": "levels", "name": "x", "params": {"inBlack": "dark"}}),
        json!({"kind": "levels", "name": "", "params": {}}),
        json!({"kind": "levels", "name": "x".repeat(256), "params": {}}),
        json!({"kind": "invert", "name": "x", "params": {}}),
        json!({"kind": "sharpen", "name": "x", "params": {}}),
        json!({"kind": "hdrToning", "name": "x", "params": {"glow": 1}}),
        json!({"kind": "hdrToning", "name": "x", "params": {"radius": "big"}}),
        json!({"kind": "hdrToning", "name": "x", "params": {"curve": [[0, 0, 0]]}}),
        json!({"kind": "curves", "name": "x", "params": {"points": [[0, 0]]}}),
    ] {
        assert!(s.execute("adjustment.presets.save", p.clone()).is_err(), "{p}");
    }
    assert!(names(&mut s, "levels").len() == 8);
    s.execute("adjustment.presets.save", json!({"kind": "hdrToning", "name": "Glow", "params": {"radius": 50, "method": "localAdaptation", "curve": [[0, 0], [255, 255]]}})).unwrap();
}

#[test]
fn loading_a_file_names_the_preset_after_it() {
    let mut s = Session::new();
    let path = format!("{FIXTURES}/curves.acv");
    let r = s.execute("adjustment.presets.load", json!({"path": path})).unwrap();
    assert_eq!(r, json!({"kind": "curves", "added": ["curves"], "report": []}));
    let v = s.execute("adjustment.presets.get", json!({"kind": "curves", "name": "curves"})).unwrap();
    // The identity green channel is left out, so the preset applies in any mode.
    assert_eq!(v["params"], json!({"points": [[0, 0], [64, 40], [192, 220], [255, 255]], "red": [[0, 0], [128, 150], [255, 255]], "blue": [[0, 20], [255, 235]]}));
    // Again: a number. From bytes: the kind and name from `fileName`.
    let r = s.execute("adjustment.presets.load", json!({"path": path})).unwrap();
    assert_eq!(r["added"], json!(["curves 2"]));
    let r = s.execute("adjustment.presets.load", json!({"data": b64(&fixture("sepia.ahu")), "fileName": "Sepia Tone.ahu"})).unwrap();
    assert_eq!((r["kind"].clone(), r["added"].clone()), (json!("hueSaturation"), json!(["Sepia Tone"])));
    let v = s.execute("adjustment.presets.get", json!({"kind": "hueSaturation", "name": "Sepia Tone"})).unwrap();
    assert_eq!((v["params"]["colorize"].clone(), v["params"]["hue"].clone()), (json!(true), json!(205)));
    // Every fixture loads, and what it holds applies as a layer.
    s.execute("file.new", json!({"width": 8, "height": 8})).unwrap();
    for (file, kind) in [("levels.alv", "levels"), ("channel-mixer.cha", "channelMixer"), ("selective-color.asv", "selectiveColor"), ("black-white.blw", "blackWhite")] {
        let r = s.execute("adjustment.presets.load", json!({"data": b64(&fixture(file)), "kind": kind, "name": "Loaded"})).unwrap();
        let name = r["added"][0].as_str().unwrap().to_string();
        let params = s.execute("adjustment.presets.get", json!({"kind": kind, "name": name})).unwrap()["params"].clone();
        s.execute(&format!("layer.newAdjustmentLayer.{kind}"), params).unwrap_or_else(|e| panic!("{kind}: {e}"));
    }
    // A file of another kind, or of none, is refused.
    assert!(s.execute("adjustment.presets.load", json!({"data": b64(&fixture("levels.alv")), "kind": "curves"})).is_err());
    assert!(s.execute("adjustment.presets.load", json!({"data": b64(&fixture("levels.alv"))})).is_err());
    assert!(s.execute("adjustment.presets.load", json!({"data": b64(b"x"), "kind": "exposure"})).is_err());
}

#[test]
fn exporting_writes_photoshops_file() {
    let mut s = Session::new();
    let r = s.execute("adjustment.presets.export", json!({"kind": "curves", "name": "Strong Contrast (RGB)"})).unwrap();
    assert_eq!(r["fileName"], json!("Strong Contrast (RGB).acv"));
    let bytes = photocraft_paint::tile::b64_decode(r["data"].as_str().unwrap()).unwrap();
    assert_eq!(bytes.len(), r["bytes"].as_u64().unwrap() as usize);
    let (adj, _) = photocraft_io::adjust_presets::read("curves", &bytes).unwrap();
    assert_eq!(super::file_params(&adj)["points"], json!([[0, 0], [64, 32], [192, 224], [255, 255]]));
    // Current settings to a file, and that file loaded back.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mix.cha");
    let r = s
        .execute("adjustment.presets.export", json!({"kind": "channelMixer", "params": {"monochrome": true, "gray": [30, 50, 20, 0]}, "path": path.to_string_lossy()}))
        .unwrap();
    assert_eq!(r["bytes"], json!(44));
    let r = s.execute("adjustment.presets.load", json!({"path": path.to_string_lossy()})).unwrap();
    assert_eq!(r["added"], json!(["mix"]));
    let v = s.execute("adjustment.presets.get", json!({"kind": "channelMixer", "name": "mix"})).unwrap();
    assert_eq!((v["params"]["monochrome"].clone(), v["params"]["gray"].clone()), (json!(true), json!([30, 50, 20, 0])));
    assert!(s.execute("adjustment.presets.export", json!({"kind": "exposure", "name": "Plus 1.0"})).is_err(), "no Photoshop file");
    assert!(s.execute("adjustment.presets.export", json!({"kind": "curves", "name": "Nope"})).is_err());
}

#[test]
fn presets_survive_the_settings_file() {
    let mut s = Session::new();
    s.execute("adjustment.presets.save", json!({"kind": "curves", "name": "S", "params": {"points": [[0, 0], [64, 50.5], [255, 255]], "red": [[0, 10], [255, 255]]}})).unwrap();
    s.execute("adjustment.presets.save", json!({"kind": "blackWhite", "name": "Warm", "params": {"reds": 70, "tint": true, "tintColor": "#e0c090"}, "group": "Toned"})).unwrap();
    s.execute("adjustment.presets.save", json!({"kind": "hdrToning", "name": "Soft", "params": {"radius": 80, "strength": 0.3}})).unwrap();
    s.execute("adjustment.presets.edit", json!({"kind": "curves", "action": "delete", "name": "Negative (RGB)"})).unwrap();
    s.execute("adjustment.presets.edit", json!({"kind": "threshold", "action": "rename", "name": "Dark (96)", "newName": "Night"})).unwrap();
    let before = s.presets.adjustments.clone();

    // Through the real store: config.toml, written and read back.
    let dir = tempfile::tempdir().unwrap();
    let (mut store, _) = craft::settings::SettingsStore::<crate::prefs::SavedPrefs>::open_at(dir.path());
    store.set(s.saved_prefs());
    store.flush().unwrap();
    let text = std::fs::read_to_string(dir.path().join("config.toml")).unwrap();
    assert!(text.contains("adjustments"), "{text}");
    let (store, report) = craft::settings::SettingsStore::<crate::prefs::SavedPrefs>::open_at(dir.path());
    assert!(format!("{report:?}").len() < 10_000);
    let mut t = Session::new();
    t.set_saved_prefs(store.get().clone());
    assert_eq!(t.presets.adjustments, before);
    assert!(!names(&mut t, "curves").contains(&"Negative (RGB)".to_string()));
    assert_eq!(names(&mut t, "threshold")[0], "Night");
    assert_eq!(t.execute("adjustment.presets.get", json!({"kind": "blackWhite", "name": "Warm"})).unwrap()["group"], json!("Toned"));
}

#[test]
fn a_damaged_saved_preset_does_not_discard_the_others() {
    let mut s = Session::new();
    s.load_presets_json(json!({
        "adjustments": {
            "levels": {
                "groups": [
                    {"name": "Mine", "items": [{"name": "Good", "params": {"gamma": 1.3}}, {"name": "", "params": {}}, {"name": "No params"}, {"name": "Good", "params": {"gamma": 2}}]},
                    {"name": 7, "items": [{"name": "Lost", "params": {}}]},
                    "junk"
                ],
                "hidden_builtins": ["darker", "no-such-id", 5],
                "renamed": {"lighter": "Bright", "nope": "X", "midtones-darker": ""}
            },
            "curves": "junk",
            "futureKind": {"groups": [{"name": "G", "items": [{"name": "Kept", "params": {"x": 1}}]}]}
        },
        "gradients": "junk"
    }));
    assert_eq!(names(&mut s, "levels"), ["Increase Contrast 1", "Increase Contrast 2", "Increase Contrast 3", "Lighten Shadows", "Bright", "Midtones Brighter", "Midtones Darker", "Good", "Good 2"]);
    assert_eq!(names(&mut s, "curves").len(), 9);
    // A kind this build doesn't know survives a save.
    assert!(s.presets.to_json(&s)["adjustments"]["futureKind"]["groups"][0]["items"][0]["name"] == "Kept");
}

#[test]
fn adversarial_params_are_errors_not_panics() {
    let ids = ["list", "get", "save", "edit", "reset", "load", "export"];
    let params = [
        json!({}),
        json!({"kind": 5, "name": [], "params": 1}),
        json!({"kind": "", "name": ""}),
        json!({"kind": "levels", "name": "\u{0}", "id": "\u{0}", "action": "rename", "newName": "\u{0}"}),
        json!({"kind": "curves", "data": "@@", "params": {"points": [[1e30, -1e30], [f64::MAX, 0]]}}),
        json!({"kind": "curves", "data": b64(&[0, 1, 0, 32]), "name": "x".repeat(10_000)}),
        json!({"kind": "blackWhite", "data": b64(&[0xff; 64]), "fileName": "../../x.blw"}),
        json!({"kind": "levels", "action": "delete", "name": [1, 2]}),
        json!({"kind": "selectiveColor", "params": {"reds": "x"}, "path": ""}),
        json!({"kind": "hdrToning", "name": "x", "params": {"curve": vec![[0, 0]; 100]}}),
    ];
    for id in ids {
        for p in &params {
            let mut s = Session::new();
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| s.execute(&format!("adjustment.presets.{id}"), p.clone())));
            assert!(r.is_ok(), "adjustment.presets.{id} panicked on {p}");
        }
    }
}

#[test]
fn preset_commands_leave_documents_and_history_alone() {
    let mut s = Session::new();
    s.execute("file.new", json!({"width": 8, "height": 8})).unwrap();
    let steps = s.active().unwrap().history.entries().len();
    s.execute("adjustment.presets.save", json!({"kind": "exposure", "name": "Up", "params": {"exposure": 0.5}})).unwrap();
    s.execute("adjustment.presets.reset", json!({"kind": "exposure"})).unwrap();
    assert_eq!(s.active().unwrap().history.entries().len(), steps);
    for spec in super::specs() {
        assert!(!spec.journal, "{}", spec.id);
    }
}
