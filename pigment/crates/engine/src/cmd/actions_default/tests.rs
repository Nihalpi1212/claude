use serde_json::{Value, json};

use super::{SET, default_actions, seeded};
use crate::Session;
use crate::actions_cmds::Action;
use crate::preset_store::{ACTIONS_FILE, INDEX_FILE, MAX_ACTIONS_BYTES, MemBackend, PresetBackend, open};

fn names(actions: &[Action]) -> Vec<String> {
    actions.iter().map(|action| action.name.clone()).collect()
}

/// Photoshop's Default Actions, less Save As Photoshop PDF (see the module notes), in its order.
const PHOTOSHOP_ORDER: [&str; 12] = [
    "Vignette (selection)",
    "Frame Channel – 50 pixel",
    "Wood Frame – 50 pixel",
    "Cast Shadow (type)",
    "Water Reflection (type)",
    "Custom RGB to Grayscale",
    "Molten Lead",
    "Make Clip Path (selection)",
    "Sepia Toning (layer)",
    "Quadrant Colors",
    "Gradient Map",
    "Mixer Brush Cloning Paint Setup",
];

#[test]
fn the_set_holds_photoshops_actions_in_its_order() {
    let actions = default_actions(SET);
    assert_eq!(names(&actions), PHOTOSHOP_ORDER);
    assert!(actions.iter().all(|action| action.set.as_deref() == Some(SET) && !action.steps.is_empty()));
    assert!(actions.iter().all(|action| action.disabled.is_empty() && action.dialogs.is_empty()));
    assert_eq!(default_actions("Other")[0].set.as_deref(), Some("Other"));
}

#[test]
fn every_step_is_a_registered_command_with_object_params() {
    for action in default_actions(SET) {
        for step in &action.steps {
            assert!(crate::commands::find(&step.command).is_some(), "{}: {} is not a command", action.name, step.command);
            assert!(step.params.is_object(), "{}: {}", action.name, step.command);
        }
    }
}

/// A 400×300 RGB document with a mid-grey Background, plus what the action's name asks for: a
/// type layer, a selection.
fn fixture(action: &str) -> Session {
    let mut s = Session::new();
    s.execute("file.new", json!({"width": 400, "height": 300})).unwrap();
    s.execute("edit.fill", json!({"contents": "color", "color": "#808080"})).unwrap();
    if action.ends_with("(type)") {
        s.execute("type.create", json!({"x": 60, "y": 160, "text": "Pigment", "size": 64, "color": "#204080"})).unwrap();
    }
    if action.ends_with("(selection)") {
        s.execute("select.rect", json!({"x": 100, "y": 75, "width": 200, "height": 150})).unwrap();
    }
    s
}

fn play(s: &mut Session, action: &str) -> Value {
    let played = s.execute("actions.play", json!({"action": action})).unwrap();
    assert!(played.get("failed").is_none_or(Value::is_null), "{action}: {played}");
    played
}

fn layer_names(s: &Session) -> Vec<String> {
    s.active().unwrap().doc.walk().into_iter().map(|(_, _, layer)| layer.name.clone()).collect()
}

#[test]
fn every_default_action_plays_on_a_fixture_document() {
    for action in default_actions(SET) {
        let mut s = fixture(&action.name);
        s.execute("actions.reset", json!({"confirm": true, "mode": "replace"})).unwrap();
        let history = s.active().unwrap().history.past_len();
        let played = play(&mut s, &action.name);
        assert_eq!(played["ran"], action.steps.len(), "{}: {played}", action.name);
        // One history entry for the whole action.
        assert_eq!(s.active().unwrap().history.past_len(), history + 1, "{}", action.name);
    }
}

#[test]
fn the_actions_do_what_their_names_say() {
    let mut s = fixture("Vignette (selection)");
    s.execute("actions.reset", json!({"confirm": true, "mode": "replace"})).unwrap();
    let before = layer_names(&s).len();
    play(&mut s, "Vignette (selection)");
    let after = layer_names(&s);
    assert_eq!(after.len(), before + 2, "{after:?}");
    assert!(after.iter().any(|name| name == "Vignette Background"), "{after:?}");
    assert!(s.active().unwrap().doc.selection.is_none());

    let mut s = fixture("Frame Channel – 50 pixel");
    s.execute("actions.reset", json!({"confirm": true, "mode": "replace"})).unwrap();
    play(&mut s, "Frame Channel – 50 pixel");
    let doc = &s.active().unwrap().doc;
    assert!(doc.channels.iter().any(|channel| channel.name == "Frame"));
    assert!(doc.walk().into_iter().any(|(_, _, layer)| layer.name == "Frame"));

    let mut s = fixture("Wood Frame – 50 pixel");
    s.execute("actions.reset", json!({"confirm": true, "mode": "replace"})).unwrap();
    play(&mut s, "Wood Frame – 50 pixel");
    let size = s.active().unwrap().doc.size;
    assert_eq!((size.width, size.height), (500, 400));

    let mut s = fixture("Make Clip Path (selection)");
    s.execute("actions.reset", json!({"confirm": true, "mode": "replace"})).unwrap();
    play(&mut s, "Make Clip Path (selection)");
    let paths = s.execute("path.list", json!({})).unwrap();
    assert_eq!(paths["clippingPath"]["name"].as_str().or(paths["clippingPath"].as_str()), Some("Path 1"), "{paths}");

    for (action, added) in [("Gradient Map", 1), ("Sepia Toning (layer)", 2), ("Cast Shadow (type)", 1), ("Water Reflection (type)", 1), ("Mixer Brush Cloning Paint Setup", 1)] {
        let mut s = fixture(action);
        s.execute("actions.reset", json!({"confirm": true, "mode": "replace"})).unwrap();
        let before = layer_names(&s).len();
        play(&mut s, action);
        assert_eq!(layer_names(&s).len(), before + added, "{action}: {:?}", layer_names(&s));
    }
    assert!(s_mixer_options());
}

/// Mixer Brush Cloning Paint Setup leaves the Mixer Brush sampling all layers, cleaning after
/// each stroke and not reloading.
fn s_mixer_options() -> bool {
    let mut s = fixture("");
    s.execute("actions.reset", json!({"confirm": true, "mode": "replace"})).unwrap();
    s.execute("brush.mixer.sampleAllLayers", json!({"on": false})).unwrap();
    s.execute("brush.mixer.autoLoad", json!({"on": true})).unwrap();
    s.execute("brush.mixer.autoClean", json!({"on": false})).unwrap();
    play(&mut s, "Mixer Brush Cloning Paint Setup");
    let toggle = |s: &mut Session, id: &str| {
        // A toggle without `on` flips it: read it back by flipping twice.
        let once = s.execute(id, json!({})).unwrap()["on"].as_bool().unwrap();
        s.execute(id, json!({})).unwrap();
        !once
    };
    toggle(&mut s, "brush.mixer.sampleAllLayers") && !toggle(&mut s, "brush.mixer.autoLoad") && toggle(&mut s, "brush.mixer.autoClean")
}

#[test]
fn reset_restores_default_actions_and_append_keeps_the_users_actions() {
    let mut s = Session::new();
    s.actions.list.push(Action::new("Mine", Vec::new())).unwrap();
    let replaced = s.execute("actions.reset", json!({"confirm": true, "mode": "replace"})).unwrap();
    assert_eq!(replaced["set"], SET);
    assert_eq!(s.actions.list.sets(), [SET]);
    assert_eq!(names(s.actions.list.actions()), PHOTOSHOP_ORDER);
    assert_eq!(replaced["actions"], json!(PHOTOSHOP_ORDER));

    let mut s = Session::new();
    s.actions.list.push(Action::new("Mine", Vec::new())).unwrap();
    s.execute("actions.reset", json!({"confirm": true, "mode": "append"})).unwrap();
    let appended = s.execute("actions.reset", json!({"confirm": true, "mode": "append"})).unwrap();
    assert_eq!(appended["set"], format!("{SET} 2"));
    assert_eq!(s.actions.list.actions()[0].name, "Mine");
    assert_eq!(s.actions.list.actions().len(), 1 + 2 * PHOTOSHOP_ORDER.len());
}

#[test]
fn the_set_saves_as_atn_and_loads_back() {
    let mut s = Session::new();
    s.execute("actions.reset", json!({"confirm": true, "mode": "replace"})).unwrap();
    let saved = s.execute("actions.save", json!({"set": SET})).unwrap();
    let data = saved["data"].as_str().unwrap().to_owned();
    let mut other = Session::new();
    other.execute("actions.load", json!({"data": data})).unwrap();
    assert_eq!(names(other.actions.list.actions()), PHOTOSHOP_ORDER);
    for (loaded, original) in other.actions.list.actions().iter().zip(s.actions.list.actions()) {
        assert_eq!(loaded.steps.len(), original.steps.len(), "{}", original.name);
    }
}

#[test]
fn a_new_store_is_seeded_only_with_the_flag() {
    let store = MemBackend::default();
    assert!(seeded(&store, false).actions().is_empty());
    assert!(store.list().unwrap().is_empty(), "nothing written without the flag");

    let list = seeded(&store, true);
    assert_eq!(names(list.actions()), PHOTOSHOP_ORDER);
    assert_eq!(list.sets(), [SET]);
    // Written at once: the store opens with it from then on, flag or not.
    assert!(store.read(ACTIONS_FILE, MAX_ACTIONS_BYTES).is_ok());
    let opened = open(Box::new(store.clone()));
    assert!(opened.warnings.is_empty(), "{:?}", opened.warnings);
    assert_eq!(names(opened.actions.actions()), PHOTOSHOP_ORDER);
    let mut session = Session::new();
    assert!(session.attach_preset_store(open(Box::new(store))).is_empty());
    assert_eq!(session.actions.list.actions(), list.actions());
}

#[test]
fn a_store_that_was_used_is_never_seeded() {
    // Clear All Actions leaves an empty actions.json: the panel stays empty.
    let cleared = MemBackend::default();
    cleared.write(ACTIONS_FILE, br#"{"version":1,"actions":[]}"#).unwrap();
    assert!(seeded(&cleared, true).actions().is_empty());
    assert!(open(Box::new(cleared)).actions.actions().is_empty());
    // A store with brush presets but no actions file is not new either.
    let brushes = MemBackend::default();
    brushes.write(INDEX_FILE, br#"{"version":1,"groups":[]}"#).unwrap();
    assert!(seeded(&brushes, true).actions().is_empty());
    assert!(brushes.read(ACTIONS_FILE, MAX_ACTIONS_BYTES).is_err());
}

#[test]
fn deleting_the_set_is_kept() {
    let store = MemBackend::default();
    let mut s = Session::new();
    s.attach_preset_store(open(Box::new(store.clone())));
    s.execute("actions.reset", json!({"confirm": true, "mode": "replace"})).unwrap();
    s.execute("actions.clearAll", json!({"confirm": true})).unwrap();
    s.sync_preset_store();
    assert!(seeded(&store, true).actions().is_empty());
    let mut reopened = Session::new();
    reopened.attach_preset_store(open(Box::new(store)));
    assert!(reopened.actions.list.actions().is_empty());
}
