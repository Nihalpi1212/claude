//! Pigment: Insert Conditional… in the Actions panel menu (PORTS-A row 40, §5.4).
//!
//! Photoshop's dialog: If Current (a document or layer condition), Then Play Action and Else Play
//! Action (an action of the panel, or None). The engine already plays and round-trips the step
//! (`actions.conditional`); this adds the dialog, the menu row after Insert Stop…, and editing:
//! Record Again on a conditional step opens the dialog on its values (the framework's list has no
//! double-click on a step), and OK replaces the step in place.
//!
//! The JavaScript Pigment had it as `actions:insert-conditional` (`renderer/lib/actions/dialogs.js`,
//! the condition words in `renderer/lib/actions/model.js` `CONDITIONS`).

use craft::automation::actions::ActionStep;
use craft::automation::ui::actions::{ActionSelection, ActionsPanelCommands};
use craft::ui::contract::{Bind, CommandSet};
use craft::ui::menu::PanelRow;
use craft::ui::patterns::form_dialogs::{DialogFields, Param, ParamDialog, ParamKind, ParamResult};
use craft::ui::runtime::commands::{CommandRef, CommandState};
use craft::ui::runtime::env::Label;
use photocraft_engine::{actions_cmds, actions_edit_cmds};
use serde_json::{Value, json};

use crate::PhotocraftApp;
use crate::dialogs::params::{self, ParamFamily};

/// The step's command.
pub(crate) const COMMAND: &str = "actions.conditional";
/// The key of the dialog.
const KEY: &str = "actionsPanel.insertConditional";

/// The Actions panel menu's Pigment rows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, CommandSet)]
#[command(prefix = "actionsPanel.pigment", scope = "app")]
pub(crate) enum ActionsExtraCommand {
    /// Open the Conditional Action dialog for a step after the selected one.
    #[command(label = "Insert Conditional…")]
    InsertConditional,
}

/// The dialog's result handler.
pub(crate) const FAMILY: ParamFamily = ParamFamily::new(|key| key == KEY, run);

/// Puts Insert Conditional… right after the framework's Insert Stop… (at the end when that row is
/// not there).
pub(super) fn splice(rows: &mut Vec<PanelRow>) {
    let stop = CommandRef::from(ActionsPanelCommands::InsertStop);
    let at = rows.iter().position(|row| matches!(row, PanelRow::Command(command) if *command == stop)).map_or(rows.len(), |i| i + 1);
    rows.insert(at, PanelRow::Command(CommandRef::from(ActionsExtraCommand::InsertConditional)));
}

/// The row's state is Insert Stop…'s: on with a selected action or step, off while recording.
pub(super) fn add_state(states: &mut Vec<(CommandRef, CommandState)>) {
    let stop = CommandRef::from(ActionsPanelCommands::InsertStop);
    if let Some(state) = states.iter().find(|(command, _)| *command == stop).map(|(_, state)| state.clone()) {
        states.push((CommandRef::from(ActionsExtraCommand::InsertConditional), state));
    }
}

/// Runs the row when `command` is it.
pub(super) fn run_fired(app: &mut PhotocraftApp, command: &CommandRef) -> bool {
    let Some(ActionsExtraCommand::InsertConditional) = ActionsExtraCommand::from_ref(command) else { return false };
    if let Err(error) = open(app, None) {
        super::dialogs::report(app, error);
    }
    true
}

/// Photoshop's words for the engine's conditions (`actions_edit_cmds::CONDITIONS`), in its order.
pub(crate) fn condition_label(condition: &str) -> String {
    match condition {
        "always" => tl!("Always"),
        "never" => tl!("Never"),
        "isOpen" => tl!("Document Is Open"),
        "landscape" => tl!("Document Is Landscape"),
        "square" => tl!("Document Is Square"),
        "portrait" => tl!("Document Is Portrait"),
        "modeIsRGB" => tl!("Document Mode Is RGB"),
        "modeIsCMYK" => tl!("Document Mode Is CMYK"),
        "modeIsGrayscale" => tl!("Document Mode Is Grayscale"),
        "modeIsLab" => tl!("Document Mode Is Lab"),
        "modeIsBitmap" => tl!("Document Mode Is Bitmap"),
        "modeIsIndexed" => tl!("Document Mode Is Indexed Color"),
        "modeIsDuotone" => tl!("Document Mode Is Duotone"),
        "modeIsMultichannel" => tl!("Document Mode Is Multichannel"),
        "depth8" => tl!("Document Depth Is 8 Bits/Channel"),
        "depth16" => tl!("Document Depth Is 16 Bits/Channel"),
        "depth32" => tl!("Document Depth Is 32 Bits/Channel"),
        "unsaved" => tl!("Document Has Unsaved Changes"),
        "hasSelection" => tl!("Document Has A Selection"),
        "hasLayers" => tl!("Document Has Layers"),
        "hasAlphaChannels" => tl!("Document Has Alpha Channels"),
        "isBackground" => tl!("Layer Is Background"),
        "isPixelLayer" => tl!("Layer Is Pixel Layer"),
        "isAdjustmentLayer" => tl!("Layer Is Adjustment Layer"),
        "isShapeLayer" => tl!("Layer Is Shape Layer"),
        "isTypeLayer" => tl!("Layer Is Type Layer"),
        "isSmartObject" => tl!("Layer Is Smart Object"),
        "isLayerGroup" => tl!("Layer Is Layer Group"),
        "isLocked" => tl!("Layer Is Locked"),
        "isVisible" => tl!("Layer Is Visible"),
        "hasPixelMask" => tl!("Layer Has Pixel Mask"),
        "hasVectorMask" => tl!("Layer Has Vector Mask"),
        "hasEffects" => tl!("Layer Has Effects"),
        other => return other.to_owned(),
    }
    .to_string()
}

/// Whether step `step` of `action` is a conditional (Record Again opens this dialog for it).
pub(crate) fn is_conditional(app: &PhotocraftApp, action: usize, step: usize) -> bool {
    app.session.actions.list.action(action).and_then(|a| a.steps.get(step)).is_some_and(|s| s.command == COMMAND)
}

/// Where a new step goes: after the selected step, or last in the selected action (pending
/// recorded steps count), as Insert Stop… does.
fn insert_place(app: &PhotocraftApp) -> Result<(usize, usize), String> {
    let (action, step) = match app.ui.actions.panel.selected.as_ref() {
        Some(ActionSelection::Action(action)) => (*action, None),
        Some(ActionSelection::Step(action, step)) => (*action, Some(*step)),
        _ => return Err(tl!("Select an action first").to_string()),
    };
    app.session.actions.list.action(action).ok_or_else(|| tl!("Select an action first").to_string())?;
    let len = app.session.actions.list.step_count(action) + actions_cmds::pending_steps(&app.session, action).count();
    Ok((action, step.map_or(len, |step| (step + 1).min(len))))
}

/// Opens the dialog: for a new step after the selection (`edit` none), or on the values of step
/// `edit.1` of action `edit.0`, which OK then replaces.
pub(crate) fn open(app: &mut PhotocraftApp, edit: Option<(usize, usize)>) -> Result<Value, String> {
    let (captured, current) = match edit {
        None => {
            let (action, at) = insert_place(app)?;
            (json!({"action": action, "at": at, "replace": false}), Value::Null)
        }
        Some((action, step)) => {
            let params = app.session.actions.list.action(action).and_then(|a| a.steps.get(step)).filter(|s| s.command == COMMAND).map(|s| s.params.clone());
            let params = params.ok_or_else(|| tl!("The step is not a conditional").to_string())?;
            (json!({"action": action, "at": step, "replace": true, "revision": app.session.actions.list.revision()}), params)
        }
    };
    let text = |key: &str| current.get(key).and_then(Value::as_str).filter(|v| !v.is_empty()).map(str::to_owned);
    let condition = text("if").filter(|c| actions_edit_cmds::CONDITIONS.contains(&c.as_str())).unwrap_or_else(|| "isOpen".to_owned());
    let conditions: Vec<(String, Label)> = actions_edit_cmds::CONDITIONS.iter().map(|c| ((*c).to_owned(), Label::from(condition_label(c)))).collect();
    // The actions of the panel plus None (an empty value); a branch naming an action the list no
    // longer has keeps its name, so editing shows what the step plays.
    let (mut names, _) = super::action_form_choices(app);
    for branch in [text("then"), text("else")].into_iter().flatten() {
        if !names.contains(&branch) {
            names.push(branch);
        }
    }
    let mut actions = vec![(String::new(), Label::from(tl!("None").to_string()))];
    actions.extend(names.into_iter().map(|name| (name.clone(), Label::from(name))));
    let (then, otherwise) = (text("then").unwrap_or_default(), text("else").unwrap_or_default());
    let id = params::open_param(app, KEY, DialogFields::new(), captured, move |fields: &mut DialogFields| {
        let rows = vec![
            Param::new("if", tl!("If Current:"), ParamKind::choice(conditions.clone(), Some(condition.clone()))).searchable(),
            Param::new("then", tl!("Then Play Action:"), ParamKind::choice(actions.clone(), Some(then.clone()))),
            Param::new("else", tl!("Else Play Action:"), ParamKind::choice(actions.clone(), Some(otherwise.clone()))),
        ];
        ParamDialog::command(KEY, tl!("Conditional Action"), rows).values(Bind::bound(fields))
    });
    Ok(json!({"dialog": id.value()}))
}

/// The step the dialog's answer makes.
fn step_of(result: &ParamResult) -> ActionStep {
    let branch = |key: &str| result.fields.text(key).filter(|name| !name.is_empty()).map_or(Value::Null, |name| json!(name));
    ActionStep::new(COMMAND, json!({"if": result.fields.text("if").unwrap_or("isOpen"), "then": branch("then"), "else": branch("else")}))
}

/// Inserts the step (or replaces the edited one), selects it and opens its action. Both are list
/// edits, not document history.
fn run(app: &mut PhotocraftApp, _ctx: &egui::Context, result: ParamResult) {
    let captured = params::captured(app, KEY);
    let (Some(action), Some(at)) = (
        captured["action"].as_u64().and_then(|n| usize::try_from(n).ok()),
        captured["at"].as_u64().and_then(|n| usize::try_from(n).ok()),
    ) else {
        return super::dialogs::report(app, tl!("The dialog names no action").to_string());
    };
    let step = step_of(&result);
    if captured["replace"].as_bool() == Some(true) {
        if captured["revision"].as_u64() != Some(app.session.actions.list.revision()) || !is_conditional(app, action, at) {
            return super::dialogs::report(app, tl!("The actions changed. Request Record Again again.").to_string());
        }
        if let Err(error) = app.run("actions.delete", json!({"action": action, "step": at})) {
            return super::dialogs::report(app, error);
        }
    }
    match app.run("actions.insert", json!({"action": action, "at": at, "id": step.command, "params": step.params})) {
        Ok(inserted) => {
            let Some(step) = inserted["step"].as_u64().and_then(|step| usize::try_from(step).ok()) else { return };
            app.ui.actions.panel.selected = Some(ActionSelection::Step(action, step));
            if let Some(held) = app.session.actions.list.action(action) {
                app.ui.actions.panel.expanded.insert(held.name.clone());
            }
        }
        Err(error) => super::dialogs::report(app, error),
    }
}
