//! Pigment (PORTS-B B2): the Character panel's Superscript, Subscript and Language, its panel menu,
//! and the superscript, subscript and small caps chords while type is edited.

use craft::keymap::{CommandDef, Scope};
use craft::ui::menu::PanelRow;
use craft::ui::runtime::commands::{CommandRef, CommandState};
use egui::Modifiers;
use egui::accesskit::{Role, Toggled};
use egui::vec2;
use egui_kittest::Harness;
use egui_kittest::kittest::{NodeT, Queryable};
use photocraft_doc::text::{Caps, CharStyle, FontBaseline};
use photocraft_doc::{LayerContent, LayerId, TextLayer};
use serde_json::json;

use super::commit_tests::type_new;
use super::panel_menu::{CHARACTER_ITEMS, character_rows, character_states};
use crate::PhotocraftApp;
use crate::app::framework::BuildApp;
use crate::canvas::testing;

fn app_with_layer(text: &str) -> (Box<PhotocraftApp>, LayerId) {
    let mut app = PhotocraftApp::new(photocraft_engine::Session::new(), crate::Services::default());
    app.run("file.new", json!({"width": 300, "height": 120})).unwrap();
    app.run("type.create", json!({"text": text, "font": "Inter", "size": 18})).unwrap();
    let id = app.session.active().unwrap().active_layer.unwrap();
    app.ui.tool = crate::state::Tool::Type;
    app.sync_views();
    (app, id)
}

fn text(app: &PhotocraftApp, id: LayerId) -> TextLayer {
    match &app.session.active().unwrap().doc.layer(id).unwrap().content {
        LayerContent::Text(t) => t.clone(),
        other => panic!("{}", other.kind_name()),
    }
}

fn first_run(app: &PhotocraftApp, id: LayerId) -> CharStyle {
    text(app, id).char_runs()[0].style.clone()
}

fn history(app: &PhotocraftApp) -> Vec<String> {
    app.session.active().unwrap().history.entries()
}

/// The Character panel alone, as Window › Character shows it.
fn panel_harness(app: Box<PhotocraftApp>) -> Harness<'static, Box<PhotocraftApp>> {
    let _ = photocraft_text::shared();
    let mut h = Harness::builder().with_context(app.ctx().clone()).with_size(vec2(900.0, 900.0)).with_max_steps(16).build_app(
        |ui, app: &mut PhotocraftApp| {
            ui.set_width(600.0);
            super::character_panel(app, ui, false);
        },
        app,
    );
    h.run_steps(4);
    h
}

/// The toggle button labelled `label` (its tooltip, once shown, has the same label).
fn toggle<'a>(h: &'a Harness<'static, Box<PhotocraftApp>>, label: &'a str) -> egui_kittest::Node<'a> {
    h.query_all_by_label(label).find(|n| n.accesskit_node().role() == Role::Button).unwrap_or_else(|| panic!("the {label} toggle"))
}

fn toggle_pressed(h: &Harness<'static, Box<PhotocraftApp>>, label: &str) -> bool {
    toggle(h, label).accesskit_node().toggled() == Some(Toggled::True)
}

#[test]
fn superscript_and_subscript_follow_small_caps_in_the_panel() {
    let (app, _) = app_with_layer("H2O");
    let h = panel_harness(app);
    let at = |label: &str| {
        let r = toggle(&h, label).rect();
        (r.min.y.round() as i32, r.min.x.round() as i32)
    };
    let order = ["Faux Bold", "Faux Italic", "All Caps", "Small Caps", "Superscript", "Subscript", "Underline", "Strikethrough"];
    let places: Vec<(i32, i32)> = order.iter().map(|l| at(l)).collect();
    let mut sorted = places.clone();
    sorted.sort();
    assert_eq!(places, sorted, "the toggles in Photoshop's order: {order:?} at {places:?}");
}

#[test]
fn clicking_subscript_sets_the_baseline_and_shows_it_pressed() {
    let (app, id) = app_with_layer("H2O");
    let mut h = panel_harness(app);
    assert!(!toggle_pressed(&h, "Subscript"));
    toggle(&h, "Subscript").click();
    h.run();
    assert_eq!(first_run(h.state(), id).baseline, FontBaseline::Subscript);
    assert!(toggle_pressed(&h, "Subscript"));
    toggle(&h, "Superscript").click();
    h.run();
    assert_eq!(first_run(h.state(), id).baseline, FontBaseline::Superscript, "one replaces the other");
    assert!(toggle_pressed(&h, "Superscript") && !toggle_pressed(&h, "Subscript"));
    toggle(&h, "Superscript").click();
    h.run();
    assert_eq!(first_run(h.state(), id).baseline, FontBaseline::Normal);
}

#[test]
fn the_language_select_lists_the_table_and_sets_the_run_language() {
    let (app, id) = app_with_layer("Wasserstoff");
    let mut h = panel_harness(app);
    h.get_by_role_and_label(Role::ComboBox, "Language").click();
    h.run();
    // The table's rows, in its order; one without a dictionary is marked.
    assert!(h.query_by_label("English: USA").is_some());
    assert!(h.query_by_label("Arabic (no dictionary)").is_some());
    h.get_by_label("English: UK").click();
    h.run();
    assert_eq!(first_run(h.state(), id).language.as_deref(), Some("en-GB"));
}

#[test]
fn new_text_is_in_the_interface_language() {
    let app = PhotocraftApp::new(photocraft_engine::Session::new(), crate::Services::default());
    let p = super::default_style_params(&app);
    assert_eq!(p["language"], json!(super::languages::for_interface(crate::i18n::current().code())));
}

// ---------------------------------------------------------------- the panel menu

fn row_ids(app: &PhotocraftApp) -> Vec<Option<String>> {
    character_rows(app)
        .into_iter()
        .filter_map(|row| match row {
            PanelRow::Command(c) => Some(Some(c.id.clone())),
            PanelRow::Separator => Some(None),
            _ => None,
        })
        .collect()
}

fn state(app: &PhotocraftApp, id: &str) -> CommandState {
    character_states(app).into_iter().find(|(c, _)| c.id == id).map(|(_, s)| s).unwrap_or_else(|| panic!("no state for {id}"))
}

fn fire(app: &mut PhotocraftApp, id: &str) {
    let ctx = app.ctx().clone();
    assert!(crate::panels::registry::run_fired(app, &ctx, &CommandRef::new(id)), "{id} is the Character menu's");
}

#[test]
fn the_character_menu_lists_photoshops_rows_in_order() {
    let (app, _) = app_with_layer("abc");
    let ids = row_ids(&app);
    let want: Vec<Option<String>> = CHARACTER_ITEMS.iter().map(|i| i.map(str::to_string)).collect();
    assert_eq!(ids, want);
    assert_eq!(ids.iter().filter(|r| r.is_none()).count(), 2);
    // The registry entry carries the rows, and every row is an engine command with a label.
    let entry = crate::panels::registry::entry("character").expect("the Character panel");
    assert_eq!((entry.rows)(&app).len(), ids.len());
    let specs = photocraft_engine::command_specs();
    for id in ids.iter().flatten() {
        assert!(specs.iter().any(|s| s.id == id), "{id} is an engine command");
    }
}

#[test]
fn no_break_from_the_menu_is_one_history_step_and_checks() {
    let (mut app, id) = app_with_layer("abc def");
    assert_eq!(state(&app, "type.noBreak"), CommandState::new().enabled(true).checked(false));
    let before = history(&app).len();
    fire(&mut app, "type.noBreak");
    assert!(first_run(&app, id).no_break);
    let h = history(&app);
    assert_eq!(h.len(), before + 1);
    assert_eq!(h.last().map(String::as_str), Some("No Break"));
    assert_eq!(state(&app, "type.noBreak"), CommandState::new().enabled(true).checked(true));
    fire(&mut app, "type.noBreak");
    assert!(!first_run(&app, id).no_break, "a second click turns it off");
}

#[test]
fn checkmarks_follow_the_selection() {
    let (mut app, id) = app_with_layer("abcdef");
    app.run("type.setStyle", json!({"layer": id.0, "range": [0, 3], "fauxBold": true, "caps": "smallCaps"})).unwrap();
    // The whole layer mixes them: unchecked.
    assert_eq!(state(&app, "type.character.fauxBold"), CommandState::new().enabled(true).checked(false));
    // Edit the layer with the bold characters selected: checked.
    app.ui.text_edit =
        Some(crate::state::TextEdit { layer: id.0, document: None, caret: 3, anchor: 0, session: "menu-test".into(), created: false, mask: false });
    assert_eq!(state(&app, "type.character.fauxBold"), CommandState::new().enabled(true).checked(true));
    assert_eq!(state(&app, "type.character.smallCaps"), CommandState::new().enabled(true).checked(true));
    assert_eq!(state(&app, "type.character.allCaps"), CommandState::new().enabled(true).checked(false));
    // A click on the checked row turns it off on the selection only.
    fire(&mut app, "type.character.smallCaps");
    let t = text(&app, id);
    assert!(t.char_runs().iter().all(|r| r.style.caps == Caps::Normal));
    assert!(t.char_runs()[0].style.faux_bold);
}

#[test]
fn fractional_widths_is_disabled_under_system_layout() {
    let (mut app, id) = app_with_layer("abc");
    assert_eq!(state(&app, "type.fractionalWidths"), CommandState::new().enabled(true).checked(true));
    fire(&mut app, "type.fractionalWidths");
    assert!(!text(&app, id).fractional_widths);
    fire(&mut app, "type.fractionalWidths");
    fire(&mut app, "type.systemLayout");
    assert!(text(&app, id).system_layout);
    assert_eq!(state(&app, "type.systemLayout"), CommandState::new().enabled(true).checked(true));
    assert_eq!(state(&app, "type.fractionalWidths"), CommandState::new().enabled(false).checked(true));
    let steps = history(&app).len();
    fire(&mut app, "type.fractionalWidths");
    assert_eq!(history(&app).len(), steps, "a greyed row does nothing");
}

#[test]
fn reset_character_from_the_menu() {
    let (mut app, id) = app_with_layer("abc");
    app.run("type.setStyle", json!({"layer": id.0, "fauxBold": true, "tracking": 50, "baseline": "superscript"})).unwrap();
    fire(&mut app, "type.resetCharacter");
    let st = first_run(&app, id);
    assert!(!st.faux_bold && st.tracking == 0.0 && st.baseline == FontBaseline::Normal);
    assert_eq!(history(&app).last().map(String::as_str), Some("Reset Character"));
}

#[test]
fn without_a_type_layer_the_toggles_set_the_defaults() {
    let mut app = PhotocraftApp::new(photocraft_engine::Session::new(), crate::Services::default());
    app.run("file.new", json!({"width": 64, "height": 64})).unwrap();
    assert!(state(&app, "type.noBreak").is_enabled());
    assert!(!state(&app, "type.resetCharacter").is_enabled());
    assert!(!state(&app, "type.systemLayout").is_enabled());
    let steps = history(&app).len();
    fire(&mut app, "type.character.superscript");
    assert_eq!(app.ui.tool_options.type_style_defaults.get("baseline"), Some(&json!("superscript")));
    assert_eq!(history(&app).len(), steps, "defaults are not a document edit");
    assert_eq!(state(&app, "type.character.superscript"), CommandState::new().enabled(true).checked(true));
}

// ---------------------------------------------------------------- the chords

/// REBASE-BT B2 step 3 asked for the chords (⇧⌘= Superscript, ⌥⇧⌘= Subscript, ⇧⌘H Small Caps) as
/// `textEditor` rows of the app's command catalog. The framework's `AppCatalog` refuses a row outside
/// the app scope (`CommandDefError::NotApp`), and a refused catalog leaves the runtime with none of
/// the app's rows.
#[test]
fn a_text_editor_row_in_the_app_catalog_is_refused() {
    let row = CommandDef::new(craft::keymap::CommandRef::new("type.character.superscript"), "Superscript", Scope::new("textEditor").expect("a scope name"));
    assert!(crate::shortcut_dispatch::catalog(vec![row], 1).is_none());
}

/// A probe: Photoshop's chords as a command set of the editor's typing scope, linked into the test
/// binary only.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, craft::ui::contract::CommandSet)]
#[command(prefix = "pigmentChordProbe", scope = "textEditor", typing)]
enum ChordProbe {
    #[command(label = "Superscript", default = "Cmd+Shift+=")]
    Superscript,
    #[command(label = "Small Caps", default = "Cmd+Shift+H")]
    SmallCaps,
}

fn edited(text: &str) -> (Box<PhotocraftApp>, LayerId) {
    let mut app = PhotocraftApp::new(photocraft_engine::Session::new(), crate::Services::default());
    app.run("file.new", json!({"width": 400, "height": 200})).unwrap();
    app.sync_views();
    app.ui.tool = crate::state::Tool::Type;
    let id = type_new(&mut app, text);
    testing::key(&mut app, egui::Key::A, Modifiers::COMMAND);
    (app, id)
}

/// Nor does a command set of that scope reach the app: the runtime reports only app-scope commands
/// to the app (`FrameOutput::fired`) and gives the others to the component that takes them, and the
/// editor takes only its own `TextEditorCommand`s. So the three commands ship with no default chord,
/// and Pigment asks craft-libs for them (`CharToggle::{Superscript, Subscript, SmallCaps}`). If this
/// test fails, the framework now passes such commands on: give `type.character.superscript`,
/// `.subscript` and `.smallCaps` their chords that way.
#[test]
fn a_text_editor_scope_chord_never_reaches_the_app() {
    let probes = [CommandRef::from(ChordProbe::Superscript), CommandRef::from(ChordProbe::SmallCaps)];
    let (mut app, id) = edited("H2O");
    let ed = app.ui.text_edit.as_ref().expect("editing");
    assert_ne!(ed.caret, ed.anchor, "the text is selected");
    let ctx = app.ctx().clone();
    let _ = crate::shortcut_dispatch::take_log(&ctx);
    testing::key(&mut app, egui::Key::H, Modifiers::COMMAND | Modifiers::SHIFT);
    testing::key(&mut app, egui::Key::Equals, Modifiers::COMMAND | Modifiers::SHIFT);
    let ran: Vec<String> = crate::shortcut_dispatch::take_log(&ctx).into_iter().map(|(id, _)| id).collect();
    for probe in &probes {
        assert!(!ran.contains(&probe.id), "{} reached the app: {ran:?}", probe.id);
    }
    assert!(app.ui.text_edit.is_some(), "still editing");
    // The editor's own chords do work: ⇧⌘K is All Caps.
    testing::key(&mut app, egui::Key::K, Modifiers::COMMAND | Modifiers::SHIFT);
    assert_eq!(first_run(&app, id).caps, Caps::AllCaps);
}
