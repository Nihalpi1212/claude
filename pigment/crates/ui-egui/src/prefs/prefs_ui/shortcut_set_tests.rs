//! Edit › Keyboard Shortcuts › Set through the dialog's session: a set made in the dialog is saved
//! with OK and in use, an action's function key travels with every set, and a set saves no action
//! keys. Making, choosing and deleting sets is craft-keymap's `Profiles` and the dialog's own.

use craft::keymap::{Binding, CommandRef, Overrides, Policy};
use egui::{Key, Modifiers};
use egui_kittest::Harness;
use photocraft_engine::shortcut_sets::{DEFAULTS_NAME, ShortcutSet, modified};
use serde_json::json;

use super::shortcut_capture_tests::{harness, tap};
use super::shortcuts::{press_ok, rebind};
use crate::PhotocraftApp;

/// Makes the dialog's draft use the set `name`, as choosing it in the Set row does.
fn choose(app: &mut PhotocraftApp, name: &str) {
    let session = app.prefs_rt.shortcuts.as_mut().expect("the dialog is open");
    let builtins = [(DEFAULTS_NAME, Overrides::new())];
    session.profiles.select(name, &builtins).unwrap();
    let overrides = session.profiles.active_overrides(&builtins).clone();
    session.keymap.set_overrides(overrides);
}

fn open(h: &mut Harness<'_, Box<PhotocraftApp>>) {
    crate::prefs_ui::open_shortcuts(h.state_mut(), 0);
}

fn ok(h: &mut Harness<'_, Box<PhotocraftApp>>) {
    let ctx = h.ctx.clone();
    press_ok(h.state_mut(), &ctx);
    h.run_steps(2);
}

/// A set made in the dialog is saved with OK, becomes the set in use, and its keys run.
#[test]
<<<<<<< ours
fn a_new_set_saves_the_dialogs_bindings_and_ok_keeps_it() {
    let (mut h, id, _) = dialog(vec![]);
    // An edit in the dialog, then New Set… with a name.
    set_field(&mut h, id, "overrides", json!({"edit.copy": "F9"}));
    click(&mut h, "New Set…");
    set_field(&mut h, id, "newSetName", json!("  Painting "));
    click(&mut h, "Create");
    assert_eq!(field(&h, id, "activeSet"), json!("Painting"));
    assert_eq!(field(&h, id, "sets")["Painting"]["shortcuts"], json!({"edit.copy": "F9"}));
    assert!(field(&h, id, "newSetName").is_null());
    // A bad name is refused with a message.
    click(&mut h, "New Set…");
    set_field(&mut h, id, "newSetName", json!("Pigment Defaults"));
    click(&mut h, "Create");
    assert!(field(&h, id, "message").as_str().unwrap_or_default().contains("built-in"), "{:?}", field(&h, id, "message"));
    click(&mut h, "Cancel");
    // Nothing is saved before OK; OK saves the set and keeps it in use.
=======
fn sets_saved_in_the_dialog_persist_and_the_active_sets_keys_run() {
    let mut h = harness();
    let ctx = h.ctx.clone();
    open(&mut h);
    // An edit in the dialog, then New Set… with a name: the set holds the edited bindings.
    rebind(h.state_mut(), &CommandRef::new("edit.copy"), Binding::parse("F9").unwrap(), Policy::Steal).unwrap();
    {
        let session = h.state_mut().prefs_rt.shortcuts.as_mut().unwrap();
        let builtins = [(DEFAULTS_NAME, Overrides::new())];
        let overrides = session.keymap.overrides().clone();
        assert_eq!(session.profiles.save_as("Painting", overrides, &builtins).unwrap(), "Painting");
        // The built-in's name is refused.
        assert!(session.profiles.save_as(DEFAULTS_NAME, Overrides::new(), &builtins).is_err());
    }
    // Nothing is saved before OK.
>>>>>>> theirs
    assert!(h.state().session.prefs().shortcut_sets.is_empty());
    ok(&mut h);
    let p = h.state().session.prefs();
    assert_eq!((p.shortcut_set.as_str(), p.shortcuts.get("edit.copy").map(String::as_str)), ("Painting", Some("F9")));
    assert_eq!(p.shortcut_sets["Painting"].shortcuts.get("edit.copy").map(String::as_str), Some("F9"));
    assert!(!modified(p), "the bindings are the set's");
    // The active set's key runs the command.
    crate::shortcut_dispatch::set_dry_run(&ctx, true);
    tap(&mut h, Key::F9, Modifiers::NONE);
    let log = crate::shortcut_dispatch::take_log(&ctx);
    assert!(log.iter().any(|(id, _)| id == "edit.copy"), "{log:?}");

    // Choosing the defaults and deleting the set wait for OK too; the bindings stay as they were chosen.
    open(&mut h);
    choose(h.state_mut(), DEFAULTS_NAME);
    {
        let session = h.state_mut().prefs_rt.shortcuts.as_mut().unwrap();
        let builtins = [(DEFAULTS_NAME, Overrides::new())];
        session.profiles.delete("Painting", &builtins).unwrap();
    }
    assert!(!h.state().session.prefs().shortcut_sets.is_empty(), "not before OK");
    ok(&mut h);
    let p = h.state().session.prefs();
    assert!(p.shortcut_sets.is_empty() && p.shortcut_set.is_empty());
    assert!(p.shortcuts.is_empty(), "the defaults' bindings are in use: {:?}", p.shortcuts);
}

<<<<<<< ours
#[test]
fn export_and_summarize_write_the_dialogs_bindings() {
    let (mut h, id, written) = dialog(vec!["Mine.kys", "Mine.html"]);
    set_field(&mut h, id, "overrides", json!({"edit.copy": "F9", "tools.select.pencil": "F6"}));
    set_field(&mut h, id, "alternates", json!({"edit.copy": []}));
    let ctx = h.ctx.clone();
    click(&mut h, "Export…");
    h.state_mut().poll_file_dialog(&ctx, None);
    click(&mut h, "Summarize…");
    h.state_mut().poll_file_dialog(&ctx, None);
    let written = written.borrow();
    assert_eq!(written.len(), 2, "{:?}", written.iter().map(|w| &w.0).collect::<Vec<_>>());
    let kys = String::from_utf8(written[0].1.clone()).unwrap();
    assert!(kys.contains("pc-id=\"edit.copy\"><shortcut>F9</shortcut></command>"), "{kys}");
    assert!(kys.contains("pc-id=\"tools.select.pencil\">F6</tool>"), "tools as <tool> rows: {kys}");
    assert!(kys.contains("KeyboardCustomization/Pigment Defaults="), "{kys}");
    // The file reads back with the same bindings.
    let set = photocraft_engine::kys::parse(&kys).unwrap();
    assert!(set.commands.iter().any(|c| c.id.as_deref() == Some("edit.copy") && c.shortcuts == ["F9"]));
    let html = String::from_utf8(written[1].1.clone()).unwrap();
    assert!(html.contains("<td>Copy</td><td>F9</td>") && html.contains("<h2>Edit</h2>"), "{html}");
    // Nothing changed the preferences.
    assert!(h.state().session.prefs().shortcuts.is_empty());
}

/// The Set dropdown's shown label: the set in use, with "(modified)" after an edit.
fn shown_set(h: &Harness<'_, PhotocraftApp>) -> String {
    let at = h.query_all_by_label("Set:").next().expect("the Set label").rect().center();
    let combo = h
        .query_all_by_role(egui::accesskit::Role::ComboBox)
        .min_by(|a, b| a.rect().center().distance(at).total_cmp(&b.rect().center().distance(at)))
        .expect("the Set dropdown");
    let node = combo.accesskit_node();
    node.value().or(node.label()).map(|s| s.to_string()).unwrap_or_default()
}

/// Pick `label` in the Set dropdown, as the user does: open it, click the option.
fn pick_set(h: &mut Harness<'_, PhotocraftApp>, label: &str) {
    // The dialog settles where it opens first.
    h.run_steps(6);
    let at = h.query_all_by_label("Set:").next().expect("the Set label").rect().center();
    let at = h
        .query_all_by_role(egui::accesskit::Role::ComboBox)
        .min_by(|a, b| a.rect().center().distance(at).total_cmp(&b.rect().center().distance(at)))
        .expect("the Set dropdown")
        .rect()
        .center();
    h.hover_at(at);
    h.run_steps(1);
    h.drag_at(at);
    h.run_steps(1);
    h.drop_at(at);
    h.run_steps(3);
    // The list rows are buttons; the combo's own value and any plain text also carry the name.
    // A shortcut key in the table below may be labelled "A" too, so take the row nearest the
    // combo that just opened, not the last match in the whole dialog.
    let option = h
        .query_all_by_label(label)
        .filter(|n| n.accesskit_node().role() == egui::accesskit::Role::Button)
        .min_by(|a, b| a.rect().center().distance(at).total_cmp(&b.rect().center().distance(at)));
    option.expect("the set in the open list").click();
    h.run_steps(3);
}

/// #7004: an action's F-key belongs to the action, so picking another set in the dialog keeps
/// it (as `useSet` does) and assigning one doesn't mark the set "(modified)".
=======
/// #7004: an action's F-key belongs to the action, so picking another set in the dialog keeps it
/// (as `useSet` does) and assigning one doesn't mark the set modified.
>>>>>>> theirs
#[test]
fn the_set_dropdown_keeps_action_function_keys_like_use_set() {
    let mut h = harness();
    h.state_mut().run("edit.keyboardShortcuts", json!({"set": {"edit.copy": "F9"}, "saveSet": "A"})).unwrap();
    // B, from a settings file written before sets left action keys out: it holds an old key for
    // the action, and gives F2 to a command.
    h.state_mut().session.edit_prefs(|p| {
        let b = ShortcutSet {
            shortcuts: [("actions.play:Sepia".to_string(), "F5".to_string()), ("layer.renameLayer".to_string(), "F2".to_string())].into(),
            alternate_shortcuts: Default::default(),
        };
        p.shortcut_sets.insert("B".into(), b);
    });
    h.state_mut().run("edit.keyboardShortcuts", json!({"useSet": ""})).unwrap();
    crate::actions::assign_shortcut(h.state_mut(), "Sepia", "F2").unwrap();
<<<<<<< ours
    let ctx = h.ctx.clone();
    let id = crate::menus::invoke(h.state_mut(), &ctx, "edit.keyboardShortcuts", json!({})).unwrap()["dialog"].as_u64().unwrap();
    h.run_steps(4);
    assert_eq!(shown_set(&h), "Pigment Defaults", "an action key doesn't modify the defaults");
    pick_set(&mut h, "A");
    assert_eq!(field(&h, id, "activeSet"), json!("A"));
    assert_eq!(field(&h, id, "overrides"), json!({"edit.copy": "F9", "actions.play:Sepia": "F2"}), "A's keys, and the action's");
    assert_eq!(shown_set(&h), "A");
    pick_set(&mut h, "Pigment Defaults");
    assert_eq!(field(&h, id, "overrides"), json!({"actions.play:Sepia": "F2"}), "kept switching to the defaults");
    pick_set(&mut h, "B");
    // What wins is what `useSet` gives: the action keeps F2, B's old action key is dropped and
=======
    assert!(!modified(h.state().session.prefs()), "an action key doesn't modify the defaults");

    open(&mut h);
    choose(h.state_mut(), "A");
    let (shortcuts, _) = photocraft_engine::keymap_defs::overrides_to_prefs(h.state().prefs_rt.shortcuts.as_ref().unwrap().keymap.overrides());
    assert_eq!(shortcuts.get("edit.copy").map(String::as_str), Some("F9"), "A's keys are the draft's");
    ok(&mut h);
    let p = h.state().session.prefs();
    assert_eq!((p.shortcut_set.as_str(), p.shortcuts.get("edit.copy").map(String::as_str)), ("A", Some("F9")));
    assert_eq!(p.shortcuts.get("actions.play:Sepia").map(String::as_str), Some("F2"), "the action keeps its key");
    assert!(!modified(p));

    // Back to the defaults: the action's key stays.
    open(&mut h);
    choose(h.state_mut(), DEFAULTS_NAME);
    ok(&mut h);
    let p = h.state().session.prefs();
    assert!(p.shortcut_set.is_empty());
    assert_eq!(p.shortcuts.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect::<Vec<_>>(), [("actions.play:Sepia", "F2")]);

    // B: what wins is what `useSet` gives: the action keeps F2, B's old action key is dropped and
>>>>>>> theirs
    // its own F2 binding stays.
    open(&mut h);
    choose(h.state_mut(), "B");
    ok(&mut h);
    let mut engine = h.state().session.prefs().clone();
    photocraft_engine::shortcut_sets::load(&mut engine, &json!({"useSet": "B"})).unwrap();
    let p = h.state().session.prefs();
    assert_eq!(p.shortcuts, engine.shortcuts);
    assert_eq!(p.shortcuts.get("actions.play:Sepia").map(String::as_str), Some("F2"));
    assert_eq!(p.shortcuts.get("layer.renameLayer").map(String::as_str), Some("F2"));
    assert_eq!(p.shortcut_set, "B");
    assert!(p.shortcut_sets.values().all(|s| !s.shortcuts.keys().any(|k| k.starts_with("actions.play:"))), "OK saves no action key in a set");
}

/// A real edit still counts as a change of the set; saving it stores the set without the actions'
/// F-keys.
#[test]
fn an_edit_still_marks_the_set_modified_and_sets_save_no_action_keys() {
    let mut h = harness();
    h.state_mut().run("edit.keyboardShortcuts", json!({"set": {"edit.copy": "F9"}, "saveSet": "A"})).unwrap();
    crate::actions::assign_shortcut(h.state_mut(), "Sepia", "F2").unwrap();
    assert!(!modified(h.state().session.prefs()), "A's keys are the bindings");
    open(&mut h);
    rebind(h.state_mut(), &CommandRef::new("edit.copy"), Binding::parse("F8").unwrap(), Policy::Steal).unwrap();
    ok(&mut h);
    let p = h.state().session.prefs();
    assert_eq!(p.shortcut_sets["A"].shortcuts, [("edit.copy".to_string(), "F8".to_string())].into(), "the set holds the edit and no action key");
    assert_eq!(p.shortcuts.get("actions.play:Sepia").map(String::as_str), Some("F2"));
    assert!(!modified(p), "OK saved the edit into the set in use");
    // An edit made through the engine, outside the set, is a modification.
    h.state_mut().run("edit.keyboardShortcuts", json!({"set": {"edit.cut": "F7"}})).unwrap();
    assert!(modified(h.state().session.prefs()));
}
