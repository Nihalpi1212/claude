//! Pigment: a document opened from a file that Pigment 0.1–0.4 saved keeps that file, and File ›
//! Save writes Pigment's new format there, which Pigment 0.4 cannot open. The first Save over such
//! a file asks first, as Photoshop asks before saving over a file of an older format: "Save in
//! the new Pigment format?", with Save (the default), Save As… and Cancel, and a "Don't show
//! again" box kept with the other dialog preferences. Once the file holds the new format, Save
//! does not ask again. When the import left parts of the document out (its report has entries
//! skipped), saving over the file loses them for good: the prompt says so, Save As… is its
//! default, and it asks whatever "Don't show again" says.
//!
//! The prompt is a framework prompt on the dialog host (`StandardPrompt`, as upstream's own
//! prompts are): `ui.dialog.confirm` gives its default answer, `ui.dialog.set` with `"choice"`
//! (`"proceed"`, `"alternate"`) and `"skip"` then `ui.dialog.confirm` gives the other, and
//! `ui.dialog.cancel` leaves both. Its answer is taken by [`answer`], a row of `dialogs::PROMPTS`.
//! Recorded actions and automation saves (the engine's `file.save`) don't ask.

use craft::ui::dialog::{PromptAnswer, PromptChoice, StandardPrompt};
use photocraft_doc::DocId;
use serde_json::{Value, json};

use super::alerts;
use crate::PhotocraftApp;

/// Its "Don't show again", under `Preferences::dialogs` (one of `dialogs::dont_show_again_keys`).
pub const PREF: &str = "file.save.legacyPigment";

/// What the prompt holds back: the save of document `doc` over `path`, with a script's format
/// answers, and whether the import left parts out (then Save As… is the default answer).
pub(crate) struct PendingLegacySave {
    pub(crate) doc: DocId,
    pub(crate) path: String,
    pub(crate) left_out: bool,
    choices: crate::FormatChoices,
}

/// The tag of the open prompt, when it is this one.
#[cfg(test)]
pub(crate) fn pending(app: &PhotocraftApp) -> Option<&PendingLegacySave> {
    alerts::prompt_tag::<PendingLegacySave>(app)
}

/// The open prompt's id, when it is this one.
pub(crate) fn open_id(app: &PhotocraftApp) -> Option<craft::ui::dialog::DialogId> {
    alerts::prompt_tagged::<PendingLegacySave>(app)
}

/// Whether the file at `path` is still one Pigment 0.1–0.4 saved. Every Save of a document
/// opened from one asks this on the UI thread, also once the file holds the new format, so only
/// the archive's directory is read; the whole file only when that cannot tell.
#[cfg(not(target_arch = "wasm32"))]
fn still_legacy(path: &str) -> bool {
    let by_directory = std::fs::File::open(path).and_then(|f| photocraft_format::brand::is_legacy_pigment_reader(&mut std::io::BufReader::new(f)));
    match by_directory {
        Ok(Some(legacy)) => legacy,
        Ok(None) => std::fs::read(path).is_ok_and(|bytes| photocraft_io::legacy_pigment::is_legacy(&bytes)),
        Err(_) => false,
    }
}

#[cfg(target_arch = "wasm32")]
fn still_legacy(_path: &str) -> bool {
    false
}

/// Whether the import of `doc` left parts of it out, which saving over its file loses.
fn left_out(doc: &photocraft_doc::Document) -> bool {
    use photocraft_doc::import_conversion::{ConversionDisposition, ImportConversion};
    matches!(doc.metadata.import_conversion.as_deref(), Some(ImportConversion::Report(r))
        if r.entries.iter().any(|e| e.disposition == ConversionDisposition::SkippedNonessential))
}

/// Opens the prompt instead of saving the active document over its own file at `path` when
/// that file is still the Pigment 0.1–0.4 document it was opened from; `None` saves as usual.
pub(crate) fn intercept(app: &mut PhotocraftApp, path: &str, choices: crate::FormatChoices) -> Option<Result<Value, String>> {
    let st = app.session.active()?;
    let left_out = left_out(&st.doc);
    if !photocraft_io::legacy_pigment::came_from_legacy(&st.doc) || (!left_out && alerts::dismissed(app, PREF)) || !still_legacy(path) {
        return None;
    }
    let doc = st.doc.id;
    if let Some(id) = open_id(app) {
        return Some(Ok(json!({"dialog": id.value(), "confirmationPending": true})));
    }
    let name = crate::file_open::display_name(path);
    let message = crate::i18n::fmt(tl!("{name} was saved by Pigment 0.4 or earlier."), &[("name", name.as_str())]);
    let mut prompt = StandardPrompt::custom(message)
        .title(tl!("Save").to_owned())
        .paragraph(tl!("Save in the new Pigment format? Pigment 0.4 will no longer be able to open this file.").to_owned());
    if left_out {
        prompt = prompt.paragraph(
            tl!("Parts of this document could not be opened and were left out (they are listed in the import warnings). Saving over the file loses them for good.")
                .to_owned(),
        );
    }
    prompt = prompt.paragraph(tl!("Save As… keeps the old file and saves the document as a new one.").to_owned());
    // The default (Enter) is Save, or Save As… when saving over the file loses what the import left out.
    let (save, save_as) = if left_out { (PromptChoice::Alternate, PromptChoice::Proceed) } else { (PromptChoice::Proceed, PromptChoice::Alternate) };
    let ordered = if left_out { [(save_as, tl!("Save As…")), (save, tl!("Save"))] } else { [(save, tl!("Save")), (save_as, tl!("Save As…"))] };
    for (choice, label) in ordered {
        prompt = prompt.button(choice, label.to_owned());
    }
    prompt = prompt.button(PromptChoice::Cancel, tl!("Cancel").to_owned());
    if !left_out {
        prompt = prompt.dont_show_again();
    }
    // A script's format answers are kept for the save the prompt holds back.
    let prompt = prompt.tag(PendingLegacySave { doc, path: path.to_string(), left_out, choices });
    Some(Ok(match alerts::open_prompt(app, prompt) {
        Ok(id) => json!({"dialog": id.value(), "confirmationPending": true}),
        Err(_) => json!({"confirmationPending": true}),
    }))
}

/// The `PROMPTS` entry: Save writes the new format over the file, Save As… asks for another one,
/// Cancel leaves both. A ticked "Don't show again" (it comes with Save only: the framework keeps
/// the box for the default answer) is kept once the save went through. `false` for another
/// family's answer.
pub(crate) fn answer(app: &mut PhotocraftApp, _ctx: &egui::Context, answer: &mut PromptAnswer) -> bool {
    let Some(pending) = answer.take_tag::<PendingLegacySave>() else { return false };
    let save_as = match (answer.choice, pending.left_out) {
        (PromptChoice::Cancel, _) => return true,
        (PromptChoice::Proceed, left_out) => left_out,
        (_, left_out) => !left_out,
    };
    let PendingLegacySave { doc, path, choices, .. } = pending;
    let saved = app.with_document(doc, |app| if save_as { app.save_dialog_flow(None, choices, false) } else { app.save_in_place_unasked(path, choices) });
    match saved {
        Ok(_) if answer.skip => alerts::remember_skip(app, PREF),
        Ok(_) => {}
        Err(error) => alerts::report_error(app, error),
    }
    true
}

#[cfg(test)]
#[path = "legacy_save_prompt_tests.rs"]
mod tests;
