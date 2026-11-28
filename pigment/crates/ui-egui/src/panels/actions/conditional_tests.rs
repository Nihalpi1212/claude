//! Pigment: Insert Conditional… (`conditional.rs`): the row, the dialog, inserting and editing.
use super::*;
use craft::automation::ui::actions::{ActionSelection, ActionsPanelCommands as C};
use craft::ui::dialog::DialogId;
use craft::ui::menu::PanelRow;
use craft::ui::patterns::form_dialogs::HostedParamDialog;
use craft::ui::runtime::commands::{CommandRef, CommandState};
use photocraft_engine::actions_cmds::ActionStep;

use conditional::ActionsExtraCommand;

fn app() -> Box<PhotocraftApp> {
    let mut app = PhotocraftApp::new(photocraft_engine::Session::new(), crate::Services::default());
    app.run("file.new", json!({"width": 8, "height": 8})).unwrap();
    for name in ["A", "Landscape", "Portrait"] {
        app.session.actions.list.push(Action::new(name, vec![ActionStep::new("select.all", json!({})), ActionStep::new("select.inverse", json!({}))])).unwrap();
    }
    app
}

fn fire(app: &mut PhotocraftApp, command: CommandRef) {
    let app_ctx = app.ctx().clone();
    assert!(menu::run_fired(app, &app_ctx, &command));
}

fn control(app: &mut PhotocraftApp, method: &str, params: Value) -> Value {
    let (request, _reply) = crate::control::ControlRequest::new(method, params);
    let app_ctx = app.ctx().clone();
    match crate::control::handle(app, &app_ctx, &request) {
        crate::control::Reply::Done(v) => v,
        _ => panic!("{method} answers at once"),
    }
}

fn top_dialog(app: &PhotocraftApp) -> DialogId {
    app.framework.dialogs.stack().top().expect("a dialog is open")
}

fn set(app: &mut PhotocraftApp, id: DialogId, field: &str, value: Value) {
    let reply = control(app, "ui.dialog.set", json!({"dialog": id, "field": field, "value": value}));
    assert_eq!(reply["ok"], true, "{field}: {reply}");
}

fn field(app: &mut PhotocraftApp, id: DialogId, key: &str) -> Option<String> {
    crate::smart_filter_dialog::tests::pass(app);
    app.framework.dialogs.get_by_id::<HostedParamDialog>(id).and_then(|d| d.fields().text(key).map(str::to_owned))
}

fn ok(app: &mut PhotocraftApp, id: DialogId) {
    let app_ctx = app.ctx().clone();
    crate::dialogs::confirm(app, &app_ctx, id).unwrap();
}

fn conditional_row() -> CommandRef {
    CommandRef::from(ActionsExtraCommand::InsertConditional)
}

fn state(app: &PhotocraftApp) -> CommandState {
    menu::states(app).into_iter().find(|(row, _)| *row == conditional_row()).map(|(_, state)| state).expect("the row has a state")
}

#[test]
fn the_row_follows_insert_stop_with_its_state() {
    let mut app = app();
    let rows: Vec<CommandRef> = menu::panel_rows(&app)
        .into_iter()
        .filter_map(|row| match row {
            PanelRow::Command(command) => Some(command),
            _ => None,
        })
        .collect();
    let stop = rows.iter().position(|row| *row == CommandRef::from(C::InsertStop)).expect("Insert Stop… is offered");
    assert_eq!(rows[stop + 1], conditional_row());
    assert_eq!(rows.iter().filter(|row| **row == conditional_row()).count(), 1);
    // Off with nothing selected, on with an action, off while recording: Insert Stop…'s state.
    assert_eq!(state(&app), CommandState::new().enabled(false));
    fire(&mut app, conditional_row());
    assert!(!app.dialog_open(), "Insert Conditional… needs a selected action");
    app.ui.actions.panel.selected = Some(ActionSelection::Action(0));
    assert_eq!(state(&app), CommandState::new().enabled(true));
    app.run("actions.record", json!({"name": "Rec"})).unwrap();
    let stop = menu::states(&app).into_iter().find(|(row, _)| *row == CommandRef::from(C::InsertStop)).unwrap().1;
    assert_eq!(state(&app), stop);
    app.run("actions.stop", json!({})).unwrap();
    // A click on the row goes through the menus' one dispatcher, as the framework's rows do.
    let reply = control(&mut app, "ui.menu.invoke", json!({"id": conditional_row().id}));
    assert_ne!(reply["ok"], false, "{reply}");
    assert!(app.dialog_open(), "the row opened the Conditional Action dialog: {reply}");
}

#[test]
fn insert_conditional_adds_the_step_after_the_selected_step() {
    let mut app = app();
    app.ui.actions.panel.selected = Some(ActionSelection::Step(0, 0));
    fire(&mut app, conditional_row());
    let id = top_dialog(&app);
    // A new step starts on Document Is Open and None.
    assert_eq!(field(&mut app, id, "if").as_deref(), Some("isOpen"));
    assert_eq!(field(&mut app, id, "then").as_deref(), Some(""));
    set(&mut app, id, "if", json!("landscape"));
    set(&mut app, id, "then", json!("Landscape"));
    set(&mut app, id, "else", json!("Portrait"));
    ok(&mut app, id);
    let action = app.session.actions.list.action(0).unwrap();
    assert_eq!(action.steps.len(), 3);
    assert_eq!(action.steps[1], ActionStep::new("actions.conditional", json!({"if": "landscape", "then": "Landscape", "else": "Portrait"})));
    assert_eq!(app.ui.actions.panel.selected, Some(ActionSelection::Step(0, 1)));
    assert!(app.ui.actions.panel.expanded.contains("A"));

    // With the action selected the step goes last; None is a null branch.
    app.ui.actions.panel.selected = Some(ActionSelection::Action(0));
    fire(&mut app, conditional_row());
    let id = top_dialog(&app);
    set(&mut app, id, "if", json!("hasSelection"));
    set(&mut app, id, "else", json!("A"));
    ok(&mut app, id);
    let steps = &app.session.actions.list.action(0).unwrap().steps;
    assert_eq!(steps.len(), 4);
    assert_eq!(steps[3].params, json!({"if": "hasSelection", "then": null, "else": "A"}));

    // The step plays: an 8×8 document is square, so neither branch is landscape or portrait.
    let played = app.run("actions.conditional", steps[1].params.clone()).unwrap();
    assert_eq!(played["holds"], false);
}

#[test]
fn record_again_on_a_conditional_step_edits_it_in_place() {
    let mut app = app();
    app.run("actions.insert", json!({"action": 0, "at": 1, "id": "actions.conditional", "params": {"if": "isTypeLayer", "then": "Landscape", "else": null}}))
        .unwrap();
    app.run("actions.toggle", json!({"action": 0, "step": 2, "enabled": false})).unwrap();
    let history = app.session.active().unwrap().history.past_len();
    app.ui.actions.panel.selected = Some(ActionSelection::Step(0, 1));
    fire(&mut app, CommandRef::from(C::RecordAgain));
    let id = top_dialog(&app);
    assert_eq!(field(&mut app, id, "if").as_deref(), Some("isTypeLayer"));
    assert_eq!(field(&mut app, id, "then").as_deref(), Some("Landscape"));
    assert_eq!(field(&mut app, id, "else").as_deref(), Some(""));
    set(&mut app, id, "if", json!("depth16"));
    set(&mut app, id, "then", json!(""));
    set(&mut app, id, "else", json!("Portrait"));
    ok(&mut app, id);
    let action = app.session.actions.list.action(0).unwrap();
    assert_eq!(action.steps.len(), 3, "replaced, not added");
    assert_eq!(action.steps[1].params, json!({"if": "depth16", "then": null, "else": "Portrait"}));
    assert_eq!(action.steps[2].command, "select.inverse");
    assert!(action.disabled.contains(&2), "the other steps keep their flags");
    assert_eq!(app.ui.actions.panel.selected, Some(ActionSelection::Step(0, 1)));
    // No document edit.
    assert_eq!(app.session.active().unwrap().history.past_len(), history);
}

#[test]
fn record_again_on_another_step_still_opens_its_own_editor() {
    let mut app = app();
    app.ui.actions.panel.selected = Some(ActionSelection::Step(0, 0));
    assert!(!conditional::is_conditional(&app, 0, 0));
    assert!(!conditional::is_conditional(&app, 0, 9));
    assert!(!conditional::is_conditional(&app, 9, 0));
    fire(&mut app, CommandRef::from(C::RecordAgain));
    assert!(app.held_record_again.is_some() || !app.dialog_open(), "Record Again's own path");
}

#[test]
fn every_condition_has_photoshops_words() {
    for condition in photocraft_engine::actions_edit_cmds::CONDITIONS {
        let label = conditional::condition_label(condition);
        assert_ne!(label, *condition, "{condition}");
        assert!(label.chars().next().is_some_and(char::is_uppercase), "{label}");
    }
    assert_eq!(conditional::condition_label("landscape"), "Document Is Landscape");
}
