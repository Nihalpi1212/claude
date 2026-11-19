//! Photoshop keyboard shortcut sets (`.kys`, Edit › Keyboard Shortcuts › Save Set) imported
//! into Edit › Keyboard Shortcuts (#1163): the dialog's Import button (the dialog's own, in
//! `prefs_ui::shortcuts`), File › Open and a drop on the window. Reading a set and matching its
//! rows to commands are craft-keymap's (`craft::keymap::import::kys::read`, `craft::keymap::plan`);
//! the headless `edit.keyboardShortcuts {"importKys": …}` plans the same way over the same
//! catalog.
//!
//! File › Open opens the dialog and queues the set for review, so OK applies it like hand-made
//! changes (a shortcut moved to a command is taken from its old owner) and Cancel discards it.
//!
//! At first launch beside Photoshop, its live set is offered, never applied unasked: a hosted
//! prompt names the set, and Import applies it ([`offer`], [`take`]).

use craft::keymap::import::kys;
use craft::menu::shortcuts::{ImportOffer, OfferAnswer, OfferRecord};
use craft::ui::dialog::{DialogResult, StartupStage};
use serde_json::{Value, json};

use crate::PhotocraftApp;
<<<<<<< ours
pub use photocraft_engine::kys::{KysCommand, KysSet, MAX_BYTES, Plan, parse};

/// Match the rows to our commands: the menus' items first, then engine commands the menus list
/// under another label (Preferences › General… is the Settings… item).
pub fn plan(app: &PhotocraftApp, set: &KysSet) -> Plan {
    use photocraft_engine::kys::Candidate;
    let items = crate::menus::menu_items(app);
    let menu = items.iter().filter(|i| i.label != "---" && crate::menus::is_live(&i.id)).map(|i| Candidate {
        id: i.id.clone(),
        label: i.label.clone(),
        default: crate::shortcuts::default_shortcut(&i.id),
    });
    let specs = photocraft_engine::kys::command_candidates().into_iter().map(|c| Candidate { default: crate::shortcuts::default_shortcut(&c.id), ..c });
    photocraft_engine::kys::plan(menu.chain(specs), set)
}

/// The set's tool keys matched to our tools by name (Photoshop's names are ours): tool
/// shortcut id (`tools.select.move`) → letter, and the tools PhotoCraft doesn't have.
pub fn plan_tools(set: &KysSet) -> (BTreeMap<String, String>, Vec<String>) {
    photocraft_engine::kys::plan_tools(photocraft_engine::shell_commands::TOOLS.iter().map(|t| (t.0, t.1)), set)
}

/// Put the plan into the open Keyboard Shortcuts dialog (opening one when none is), as
/// overrides the OK button applies: a key equal to the command's default clears its override.
/// Returns the dialog id and the plan as JSON.
pub fn import_text(app: &mut PhotocraftApp, file_name: &str, text: &str) -> Result<Value, String> {
    let set = parse(text).map_err(|e| format!("{file_name}: {e}"))?;
    let plan = plan(app, &set);
    let (tool_keys, unknown_tools) = plan_tools(&set);
    let id = match app.ui.dialogs.iter().find(|d| d.fields.get("__prefsui").and_then(Value::as_str) == Some("shortcuts")) {
        Some(d) => d.id,
        None => crate::prefs_ui::open_shortcuts(app, 0),
    };
    let f = &mut app.ui.dialog_mut(id).ok_or("the Keyboard Shortcuts dialog is gone")?.fields;
    let mut overrides: BTreeMap<String, String> = f.get("overrides").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
    for (cmd, sc) in &plan.set {
        let default = crate::shortcuts::default_shortcut(cmd).and_then(|d| photocraft_engine::prefs::normalize_shortcut(&d));
        if default.as_deref() == Some(sc.as_str()) {
            overrides.remove(cmd);
        } else {
            overrides.insert(cmd.clone(), sc.clone());
        }
    }
    // Tool keys (#5036): a letter other than the tool's own becomes its override; its own
    // letter clears one, so the tool keeps cycling with the others that share it.
    for tool in crate::state::Tool::ALL {
        let id = crate::tool_shortcuts::id(tool);
        let Some(key) = tool_keys.get(&id) else { continue };
        if crate::tool_shortcuts::default(tool).is_some_and(|d| d.eq_ignore_ascii_case(key)) {
            overrides.remove(&id);
        } else {
            overrides.insert(id, key.clone());
        }
    }
    // A row's other keys are the command's further keys (#3665): Copy's F3 beside ⌘C.
    let mut alternates: BTreeMap<String, Vec<String>> = f.get("alternates").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
    for (cmd, keys) in &plan.alternate_keys {
        let main = plan.set.get(cmd).map(String::as_str);
        if photocraft_engine::prefs::Preferences::default().alternates(cmd, main) == *keys {
            alternates.remove(cmd);
        } else {
            alternates.insert(cmd.clone(), keys.clone());
        }
    }
    let shown = std::path::Path::new(file_name).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| file_name.to_string());
    let n = (plan.set.len() + tool_keys.len()).to_string();
    let mut message = crate::i18n::fmt(tl!("Imported {n} shortcuts from {file}. Click OK to keep them."), &[("n", &n), ("file", &shown)]);
    if !plan.unknown.is_empty() || !unknown_tools.is_empty() {
        let u = (plan.unknown.len() + unknown_tools.len()).to_string();
        message.push(' ');
        message.push_str(&crate::i18n::fmt(tl!("{n} commands are not in Pigment."), &[("n", &u)]));
    }
    f.insert("tab".into(), json!(0));
    f.insert("overrides".into(), json!(overrides));
    f.insert("alternates".into(), json!(alternates));
    f.insert("selected".into(), json!(""));
    f.insert("capture".into(), json!(false));
    f.insert("message".into(), json!(message));
    f.insert("messageWarning".into(), json!(false));
    Ok(json!({
        "dialog": id,
        "name": set.name,
        "imported": plan.set.len(),
        "set": plan.set,
        "unknown": plan.unknown,
        "unreadable": plan.unreadable,
        "alternates": plan.alternates,
        "alternateKeys": plan.alternate_keys,
        "toolKeys": set.tool_keys,
        "tools": tool_keys,
        "unknownTools": unknown_tools,
        "windows": set.windows,
    }))
}
=======
use crate::prefs_ui::shortcuts::{draft_keymap, import_options, kys_text, profiles_of, queue_import, save_keys};
>>>>>>> theirs

/// Preferences › `dialogs` key that records the first-launch offer (an [`OfferRecord`]: the source
/// and whether it was imported), so it is made once.
pub const IMPORTED_PREF: &str = "photoshopShortcuts";

/// A `.kys` opened like a document (File › Open, a drop): its bytes are text. The dialog opens on
/// Keyboard Shortcuts and reviews the set on its next pass.
pub fn open_bytes(app: &mut PhotocraftApp, name: &str, bytes: &[u8]) -> Result<Value, String> {
    let text = kys_text(name, bytes)?;
    queue_import(app, text);
    Ok(json!({"dialog": "shortcuts"}))
}

fn remember(app: &mut PhotocraftApp, record: &OfferRecord) {
    let record = serde_json::to_value(record).unwrap_or_default();
    app.session.edit_prefs(|p| {
        p.dialogs.insert(IMPORTED_PREF.into(), record);
    });
}

fn not_imported(app: &mut PhotocraftApp, error: &str) {
    app.ui.status = crate::i18n::fmt(tl!("The keyboard shortcut set was not imported: {error}"), &[("error", error)]);
    app.ui.status_error = true;
}

/// Photoshop's live set ([`crate::Services::photoshop_shortcuts`]) as its source path and text.
fn live_set(app: &mut PhotocraftApp) -> Option<(String, String)> {
    app.services.photoshop_shortcuts.as_mut().and_then(|find| find())
}

/// First launch on a machine with Photoshop: its live set is offered once, as a prompt hosted at
/// the startup stage for offers. Someone who already changed a shortcut keeps their own set and is
/// not asked; a set that changes nothing (Photoshop's defaults are ours too) is not offered
/// either. The preferences remember each outcome, so a later launch never asks again.
pub fn offer(app: &mut PhotocraftApp) {
    if app.session.prefs().dialogs.contains_key(IMPORTED_PREF) {
        return;
    }
    let Some((source, text)) = live_set(app) else { return };
    let set = match kys::read(&text) {
        Ok(set) => set,
        Err(e) => {
            remember(app, &OfferRecord::new(&source, false));
            return not_imported(app, &e.to_string());
        }
    };
    let keymap = draft_keymap(app);
    match ImportOffer::prepare(&source, &set, &keymap, &import_options(&Default::default()), None) {
        Ok(offer) => app.framework.dialogs.enqueue(StartupStage::Offer, offer),
        Err(no) => {
            if let Some(record) = no.record(&source) {
                remember(app, &record);
            }
        }
    }
}

/// The offer's answer. The record is stored first, as the offer is answered, whatever follows;
/// Import then applies the set, saves it as OK would and says so. A prompt closed from outside
/// records nothing, so the next launch asks again.
pub fn take(app: &mut PhotocraftApp, _ctx: &egui::Context) {
    let Some(DialogResult::Ok(answer)) = app.framework.dialogs.take::<ImportOffer>() else { return };
    answered(app, answer);
}

/// What an answer of the prompt does ([`take`]).
fn answered(app: &mut PhotocraftApp, answer: OfferAnswer) {
    let Some((source, text)) = live_set(app) else { return };
    remember(app, &OfferRecord::new(&source, answer == OfferAnswer::Import));
    if answer != OfferAnswer::Import {
        return;
    }
    // The plan is made again from the file and the preferences: the hosted prompt keeps no plan after it answers, and
    // nothing has changed the bindings since it was offered.
    let applied = kys::read(&text).map_err(|e| e.to_string()).and_then(|set| {
        let mut keymap = draft_keymap(app);
        let offer = ImportOffer::prepare(&source, &set, &keymap, &import_options(&Default::default()), None).map_err(|_| "nothing to import".to_owned())?;
        offer.plan.apply(&mut keymap);
        let profiles = profiles_of(app.session.prefs());
        save_keys(app, &keymap, &profiles)?;
        Ok((offer.set_name, keymap.overrides().len()))
    });
    let (name, changed) = match applied {
        Ok(done) => done,
        Err(e) => return not_imported(app, &e),
    };
    let id = crate::notices::post(
        app,
        "Keyboard shortcuts imported",
        vec!["Your keyboard shortcut set {set} is in use here: {n} shortcuts differ from the defaults. Edit › Keyboard Shortcuts shows them; Reset All to Defaults undoes this.".to_owned()],
        craft::theme::variant::Tone::Neutral,
        None,
    );
    if let Some(n) = app.ui.notices.iter_mut().find(|n| n.id == id) {
<<<<<<< ours
        n.args = vec![("set".to_owned(), offer.set), ("n".to_owned(), changed.to_string())];
    }
}

/// The first-launch prompt: which set was found, and Import / Don't Import.
pub fn show_offer(app: &mut PhotocraftApp, ctx: &egui::Context) {
    let Some(offer) = &app.ui.kys_offer else { return };
    let n = offer.changes.to_string();
    let line = crate::i18n::fmt(
        tl!(
            "Pigment found your keyboard shortcut set {set} from another image editor on this computer: {n} of its shortcuts differ from Pigment's. Import it?"
        ),
        &[("set", &offer.set), ("n", &n)],
    );
    let mut answer = None;
    egui::Window::new(tl!("Import keyboard shortcuts?"))
        .id(egui::Id::unique("kys-offer"))
        .collapsible(false)
        .resizable(false)
        .default_width(440.0)
        .anchor(egui::Align2::CENTER_CENTER, egui::Vec2::ZERO)
        .show(ctx, |ui| {
            ui.label(line);
            ui.label(tl!("Edit › Keyboard Shortcuts › Reset All to Defaults undoes an import."));
            ui.add_space(8.0);
            ui.horizontal(|ui| {
                use crate::widgets::{ButtonRole, DialogButton};
                let buttons =
                    [DialogButton::new(ButtonRole::Default, tl!("Import"), 100.0), DialogButton::new(ButtonRole::Alternate, tl!("Don't Import"), 120.0)];
                if let Some(role) = crate::widgets::dialog_buttons(ui, &buttons) {
                    answer = Some(role == ButtonRole::Default);
                }
            });
        });
    if let Some(import) = answer {
        answer_offer(app, import);
=======
        n.args = vec![("set".to_owned(), name), ("n".to_owned(), changed.to_string())];
>>>>>>> theirs
    }
}

#[cfg(test)]
mod tests;
