//! Pigment: Edit › Presets › Migrate Presets (P4). Photoshop's item brings the presets of an
//! earlier version; Pigment's brings those of the JavaScript Pigment (0.1 to 0.5), which kept
//! them in its Electron settings folder. When that folder is there (`Services::legacy_presets_dir`,
//! filled by the app) the menu item asks "Migrate presets from Pigment 0.4 at {folder}?";
//! otherwise it asks for a folder (the old app's `presets` folder, or the settings folder holding
//! it). Either way the engine's `edit.presets.migratePresets {path}` does the work, and the status
//! line says what came in. The old app's files are only read.

use craft::ui::dialog::{PromptAnswer, PromptChoice, StandardPrompt};
use serde_json::{Value, json};

use crate::PhotocraftApp;

pub(crate) const COMMAND: &str = "edit.presets.migratePresets";

/// Tags the migration's confirmation, with the folder it names.
pub(crate) struct MigratePrompt {
    folder: String,
}

/// The menu item: the prompt when the old app's folder is there, else the folder dialog.
pub(crate) fn open(app: &mut PhotocraftApp) -> Result<Value, String> {
    let Some(dir) = app.services.legacy_presets_dir.clone() else {
        return app.ask_folder(|app, path| migrate(app, &path));
    };
    let folder = dir.to_string_lossy().to_string();
    let prompt = StandardPrompt::custom(crate::i18n::fmt(tl!("Migrate presets from Pigment 0.4 at {folder}?"), &[("folder", &folder)]))
        .title(tl!("Migrate Presets"))
        .button(PromptChoice::Proceed, tl!("OK"))
        .button(PromptChoice::Cancel, tl!("Cancel"))
        .tag(MigratePrompt { folder });
    match app.framework.dialogs.open_unless_open(prompt) {
        Ok(id) => Ok(json!({"dialog": id.value().to_string(), "confirmationPending": true})),
        Err(_) => Err(tl!("command is unavailable while a modal dialog is open").to_string()),
    }
}

/// Answers the confirmation (`dialogs::PROMPTS`): OK migrates, Cancel does nothing. `false` for
/// another prompt's answer.
pub(crate) fn answer_prompt(app: &mut PhotocraftApp, _ctx: &egui::Context, answer: &mut PromptAnswer) -> bool {
    let Some(held) = answer.take_tag::<MigratePrompt>() else { return false };
    if answer.choice == PromptChoice::Proceed {
        let _ = migrate(app, &held.folder);
    }
    true
}

/// Runs the migration of `folder` and says in the status line what it brought.
fn migrate(app: &mut PhotocraftApp, folder: &str) -> Result<Value, String> {
    match app.run(COMMAND, json!({"path": folder})) {
        Ok(r) => {
            app.ui.status_error = false;
            app.ui.status = status(&r);
            Ok(r)
        }
        Err(error) => {
            app.ui.status = error.clone();
            app.ui.status_error = true;
            Err(error)
        }
    }
}

/// "{n} presets migrated." (with what was skipped), or "No Pigment 0.4 presets were found."
fn status(r: &Value) -> String {
    let n = r["migrated"].as_u64().unwrap_or(0);
    let skipped = r["skipped"].as_array().map_or(0, Vec::len);
    if n == 0 && r["found"].as_u64().unwrap_or(0) == 0 {
        return tl!("No Pigment 0.4 presets were found.").into();
    }
    let done = crate::i18n::trn(crate::i18n::current(), n, "{n} preset migrated.", "{n} presets migrated.");
    let done = crate::i18n::fmt(&done, &[("n", &n.to_string())]);
    match r["skipped"].get(0).and_then(|k| k["reason"].as_str()) {
        Some(first) if skipped > 0 => {
            crate::i18n::fmt(tl!("{message} {n} not migrated (first: {reason})."), &[("message", &done), ("n", &skipped.to_string()), ("reason", first)])
        }
        _ => done,
    }
}

#[cfg(test)]
mod tests;
