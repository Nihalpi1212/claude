//! Pigment: a document opened from a file that Pigment 0.1–0.4 saved keeps that file, and File ›
//! Save writes Pigment's new format there, which Pigment 0.4 cannot open. The first Save over such
//! a file asks first, as Photoshop asks before saving over a file of an older format: "Save in
//! the new Pigment format?", with Save (the default), Save As… and Cancel, and a "Don't show
//! again" box kept with the other dialog preferences. Once the file holds the new format, Save
//! does not ask again.
//!
//! The prompt is an ordinary dialog in the UI state: `ui.dialog.confirm` saves,
//! `ui.dialog.set` with `"choice": "saveAs"` then `ui.dialog.confirm` asks for another file, and
//! `ui.dialog.cancel` leaves both. Recorded actions and automation saves (the engine's
//! `file.save`) don't ask.

use photocraft_doc::DocId;
use serde_json::{Map, Value, json};

use super::dont_show_again;
use crate::PhotocraftApp;
use crate::state::DialogKind;

const MARK: &str = "__legacyPigmentSave";

/// Its "Don't show again", under `Preferences::dialogs`.
pub const PREF: &str = "file.save.legacyPigment";

pub fn owns(fields: &Map<String, Value>) -> bool {
    fields.contains_key(MARK)
}

/// Whether the file at `path` is still one Pigment 0.1–0.4 saved.
#[cfg(not(target_arch = "wasm32"))]
fn still_legacy(path: &str) -> bool {
    std::fs::read(path).is_ok_and(|bytes| photocraft_io::legacy_pigment::is_legacy(&bytes))
}

#[cfg(target_arch = "wasm32")]
fn still_legacy(_path: &str) -> bool {
    false
}

/// Opens the prompt instead of saving the active document over its own file at `path` when
/// that file is still the Pigment 0.1–0.4 document it was opened from; `None` saves as usual.
pub(crate) fn intercept(app: &mut PhotocraftApp, path: &str, choices: crate::FormatChoices) -> Option<Result<Value, String>> {
    let st = app.session.active()?;
    if !photocraft_io::legacy_pigment::came_from_legacy(&st.doc) || dont_show_again::dismissed(app, PREF) || !still_legacy(path) {
        return None;
    }
    let doc = st.doc.id;
    if app.ui.dialogs.iter().any(|d| owns(&d.fields)) {
        return Some(Ok(json!({"confirmationPending": true})));
    }
    let name = crate::file_open::display_name(path);
    let message = crate::i18n::fmt(tl!("{name} was saved by Pigment 0.4 or earlier."), &[("name", name.as_str())]);
    let mut fields = json!({
        MARK: true,
        "__label": "Save",
        "message": message,
        "document": doc.0,
        "path": path,
        "choice": "save",
        "__dontShowAgain": PREF,
        "skip": false,
    });
    // A script's format answers are kept for the save the prompt holds back.
    choices.record(&mut fields);
    let id = app.ui.open_dialog(DialogKind::Command, fields.as_object().cloned().unwrap_or_default());
    Some(Ok(json!({"dialog": id, "confirmationPending": true})))
}

pub fn body(ui: &mut egui::Ui, fields: &mut Map<String, Value>) {
    ui.label(fields.get("message").and_then(Value::as_str).unwrap_or_default());
    ui.add_space(6.0);
    ui.label(tl!("Save in the new Pigment format? Pigment 0.4 will no longer be able to open this file."));
    ui.add_space(4.0);
    ui.label(tl!("Save As… keeps the old file and saves the document as a new one."));
    dont_show_again::body(ui, fields);
}

/// Save writes the new format over the file; Save As… asks for another one. A ticked "Don't
/// show again" is kept either way.
pub fn confirm(app: &mut PhotocraftApp, fields: &Map<String, Value>) -> Result<Value, String> {
    let doc = fields.get("document").and_then(Value::as_u64).map(DocId).ok_or(tl!("The document is closed"))?;
    let path = fields.get("path").and_then(Value::as_str).unwrap_or_default().to_string();
    let choices = crate::FormatChoices::from_step(&Value::Object(fields.clone()), "file.save")?;
    if fields.get("skip").and_then(Value::as_bool) == Some(true) {
        dont_show_again::remember(app, PREF);
    }
    let save_as = fields.get("choice").and_then(Value::as_str) == Some("saveAs");
    app.with_document(doc, |app| if save_as { app.save_dialog_flow(None, choices, false) } else { app.save_in_place_unasked(path, choices) })
}

#[cfg(test)]
#[path = "legacy_save_prompt_tests.rs"]
mod tests;
