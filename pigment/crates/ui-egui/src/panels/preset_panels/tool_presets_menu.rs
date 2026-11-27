//! Pigment: the Tool Presets panel menu (P2): Load…, Replace… and Save… of Photoshop tool preset
//! files (`.tpl`, the framework's `PresetFiles` rows) and Reset Tool Presets…, as Photoshop's
//! Tool Presets panel menu has them. The panel is a list, so the menu has no Grid/List rows.
//!
//! Load… adds the file's presets (`tool.presets.importTpl`, as File › Open and drag-and-drop of a
//! `.tpl` do), Replace… asks first and then puts them in place of every tool preset, Save… writes
//! every tool preset (`tool.presets.exportTpl`), and Reset Tool Presets… asks before
//! `tool.presets.reset` brings the built-ins back.

use craft::ui::contract::CommandSet;
use craft::ui::dialog::{PromptAnswer, PromptChoice, StandardPrompt};
use craft::ui::menu::PanelRow;
use craft::ui::patterns::presets::{PresetCommands, PresetExport, PresetFileRequest, PresetFiles};
use craft::ui::runtime::commands::{CommandRef, CommandState};
use serde_json::{Value, json};

use crate::PhotocraftApp;
use crate::panels::preset_browser::PresetKey;

/// The Tool Presets panel menu's own row.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, CommandSet)]
#[command(prefix = "toolPresetsPanel", scope = "app")]
pub(crate) enum ToolPresetsCommand {
    /// Put the built-in tool presets in place of the list (asks first).
    #[command(label = "Reset Tool Presets…")]
    Reset,
}

/// The pick purpose of tool preset files, which keeps their last folder.
const FILES: &str = "tool presets";

/// The `.tpl` entries: Load…, Replace…, and Save… while there are presets.
fn files(any: bool, export: Option<PresetExport>) -> PresetFiles<'static, PresetKey> {
    PresetFiles::new(FILES, tl!("Tool Presets"), &["tpl"]).replace(true).export(move |_| export.clone()).can_export(move |_| any)
}

fn any(app: &PhotocraftApp) -> bool {
    !app.session.presets.tool_presets.is_empty()
}

/// The rows of the panel menu: the file entries, then Reset Tool Presets….
pub(crate) fn rows(app: &PhotocraftApp) -> Vec<PanelRow> {
    let mut rows: Vec<PanelRow> = files(any(app), None).commands().into_iter().map(|c| PanelRow::Command(CommandRef::from(c))).collect();
    rows.push(PanelRow::Separator);
    rows.push(PanelRow::Command(CommandRef::from(ToolPresetsCommand::Reset)));
    rows
}

/// The state of each row: Save… waits for a preset.
pub(crate) fn states(app: &PhotocraftApp) -> Vec<(CommandRef, CommandState)> {
    let f = files(any(app), None);
    let mut out: Vec<(CommandRef, CommandState)> =
        f.commands().into_iter().map(|c| (CommandRef::from(c), CommandState::new().enabled(f.enabled(c, None)))).collect();
    out.push((CommandRef::from(ToolPresetsCommand::Reset), CommandState::new().enabled(true)));
    out
}

/// Tags the Reset Tool Presets… confirmation.
struct ResetPrompt;

/// Tags the Replace… confirmation, holding the picked file.
struct ReplacePrompt {
    file: String,
    bytes: Vec<u8>,
}

/// Runs a fired row of the panel menu; `false` for another panel's command.
pub(crate) fn run(app: &mut PhotocraftApp, _ctx: &egui::Context, cmd: &CommandRef) -> bool {
    if ToolPresetsCommand::from_ref(cmd) == Some(ToolPresetsCommand::Reset) {
        let prompt = StandardPrompt::custom(tl!("Replace current tool presets with the default tool presets?"))
            .title(tl!("Reset Tool Presets"))
            .button(PromptChoice::Proceed, tl!("OK"))
            .button(PromptChoice::Cancel, tl!("Cancel"))
            .tag(ResetPrompt);
        if app.framework.dialogs.open_unless_open(prompt).is_err() {
            fail(app, tl!("command is unavailable while a modal dialog is open").into());
        }
        return true;
    }
    let Some(command) = PresetCommands::from_ref(cmd) else { return false };
    let request = match command {
        PresetCommands::Save => export(app).and_then(|export| files(true, Some(export)).request(PresetCommands::Save, None)),
        command => files(any(app), None).request(command, None),
    };
    let result =
        match request {
            Some(PresetFileRequest::Open { replace, .. }) => app.pick_file_bytes_filtered(&["tpl"], move |app, name, bytes| {
                if replace { ask_replace(app, &name, bytes) } else { open_file(app, &name, &bytes).map(|()| Value::Null) }
            }),
            Some(PresetFileRequest::Save { file_name, bytes, .. }) => {
                let count = app.session.presets.tool_presets.len() as u64;
                app.pick_save(&file_name, move |app, path| {
                    let write = app.services.write.as_mut().ok_or("no writer configured")?;
                    write(&path, &bytes)?;
                    app.ui.status_error = false;
                    app.ui.status = crate::i18n::fmt(
                        &crate::i18n::trn(crate::i18n::current(), count, "Saved {n} tool preset to {file}", "Saved {n} tool presets to {file}"),
                        &[("file", &crate::file_open::display_name(&path))],
                    );
                    Ok(json!({"path": path, "count": count}))
                })
            }
            _ => Ok(Value::Null),
        };
    if let Err(error) = result
        && error != crate::file_dialog::CANCELLED
    {
        fail(app, error);
    }
    true
}

fn fail(app: &mut PhotocraftApp, error: String) {
    app.ui.status = error;
    app.ui.status_error = true;
}

/// Every tool preset as a `.tpl`, named "Tool Presets.tpl".
fn export(app: &mut PhotocraftApp) -> Option<PresetExport> {
    let reply = match app.run("tool.presets.exportTpl", json!({})) {
        Ok(r) => r,
        Err(error) => {
            fail(app, error);
            return None;
        }
    };
    let bytes = reply["data"].as_str().and_then(photocraft_engine::paint::tile::b64_decode)?;
    Some(PresetExport::new(format!("{}.tpl", tl!("Tool Presets")), bytes))
}

/// Replace…: asks before the file's presets take the place of every tool preset.
fn ask_replace(app: &mut PhotocraftApp, name: &str, bytes: Vec<u8>) -> Result<Value, String> {
    let file = crate::file_open::display_name(name);
    let prompt = StandardPrompt::custom(crate::i18n::fmt(tl!("Replace current tool presets with the presets from {file}?"), &[("file", &file)]))
        .title(tl!("Replace Tool Presets"))
        .button(PromptChoice::Proceed, tl!("OK"))
        .button(PromptChoice::Cancel, tl!("Cancel"))
        .tag(ReplacePrompt { file, bytes });
    app.framework.dialogs.open_unless_open(prompt).map_err(|_| tl!("command is unavailable while a modal dialog is open").to_string())?;
    Ok(Value::Null)
}

/// Answers the Reset and Replace prompts (`dialogs::PROMPTS`); `false` for another prompt.
pub(crate) fn answer(app: &mut PhotocraftApp, _ctx: &egui::Context, answer: &mut PromptAnswer) -> bool {
    if answer.take_tag::<ResetPrompt>().is_some() {
        if answer.choice == PromptChoice::Proceed {
            match app.run("tool.presets.reset", json!({})) {
                Ok(_) => {
                    app.ui.status_error = false;
                    app.ui.status = tl!("Tool presets reset to the defaults").into();
                }
                Err(error) => fail(app, error),
            }
        }
        return true;
    }
    let Some(held) = answer.take_tag::<ReplacePrompt>() else { return false };
    if answer.choice == PromptChoice::Proceed
        && let Err(error) = import(app, &held.file, &held.bytes, true)
    {
        fail(app, error);
    }
    true
}

/// File › Open, drag-and-drop and Load… of a `.tpl`: its presets join the list.
pub(crate) fn open_file(app: &mut PhotocraftApp, name: &str, bytes: &[u8]) -> Result<(), String> {
    import(app, &crate::file_open::display_name(name), bytes, false)
}

fn import(app: &mut PhotocraftApp, file: &str, bytes: &[u8], replace: bool) -> Result<(), String> {
    let r = app.run("tool.presets.importTpl", json!({"data": photocraft_engine::paint::tile::b64_encode(bytes), "replace": replace}))?;
    let n = r["count"].as_u64().unwrap_or(0);
    let loaded = crate::i18n::fmt(
        &crate::i18n::trn(crate::i18n::current(), n, "Loaded {n} tool preset from {file}", "Loaded {n} tool presets from {file}"),
        &[("file", file)],
    );
    let warnings: Vec<String> = r.get("warnings").and_then(|w| serde_json::from_value(w.clone()).ok()).unwrap_or_default();
    app.ui.status_error = false;
    app.ui.status = match warnings.first() {
        Some(warning) => {
            let template = "{message} (notes: {n}; {warning})";
            crate::i18n::fmt(tl!(template), &[("message", &loaded), ("n", &warnings.len().to_string()), ("warning", warning)])
        }
        None => loaded,
    };
    let _ = crate::panel_docking::show_panel(app, "toolPresets", Some(true));
    Ok(())
}

#[cfg(test)]
mod tests;
