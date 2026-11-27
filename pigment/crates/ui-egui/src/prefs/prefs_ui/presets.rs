//! Edit › Presets › Preset Manager and Export/Import Presets, as hosted dialogs read back by `take`.

use craft::ui::contract::{Bind, Entry};
use craft::ui::dialog::DialogId;
use craft::ui::patterns::form_dialogs::{DialogFields, FieldValue, HostedParamDialog, Param, ParamDialog, ParamKind, ParamResult};
use craft::ui::patterns::presets::{HostedPresetManager, PresetEvent, PresetRow};
use craft::ui::runtime::env::Label;
use serde_json::{Value, json};

use crate::PhotocraftApp;
use crate::dialogs::params::ParamFamily;

/// The Preset Manager: the preset kind picked by its id, and the preset by its index in that kind's list.
type Manager = HostedPresetManager<String, usize>;

/// The command and dialog key of Export/Import Presets.
const IO: &str = "edit.presets.exportImportPresets";

/// The kinds the manager lists, with their ids in `edit.presets.presetManager`.
fn kinds() -> Vec<Entry<String>> {
    vec![
        Entry::new("brushes".to_string(), tl!("Brushes")),
        Entry::new("customShapes".to_string(), tl!("Custom Shapes")),
        Entry::new("patterns".to_string(), tl!("Patterns")),
    ]
}

/// The footer buttons of `kind`: Load… imports Photoshop brushes (.abr), so only Brushes has it.
fn actions_for(kind: &str) -> Vec<(Label, Option<Label>)> {
    if kind == "brushes" { vec![(tl!("Load…").into(), Some(tl!("Import brushes (.abr)").into()))] } else { Vec::new() }
}

/// The presets of `kind`, one row per name, keyed by index.
fn load_rows(app: &mut PhotocraftApp, kind: &str) -> Vec<PresetRow<usize>> {
    let names = app
        .session
        .execute("edit.presets.presetManager", json!({"kind": kind}))
        .ok()
        .and_then(|v| v.get(kind).cloned())
        .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
        .unwrap_or_default();
    names.into_iter().enumerate().map(|(index, name)| PresetRow::item(index, name, 0)).collect()
}

/// Opens the Preset Manager on Brushes.
// Pigment: the menu opens `dialogs::preset_manager_ui` (P1a); this one stays for upstream merges.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn open_manager(app: &mut PhotocraftApp) -> DialogId {
    let mut manager = Manager::new(tl!("Preset Manager"), kinds(), "brushes".to_string());
    manager.rows(load_rows(app, "brushes"));
    manager.actions(actions_for("brushes"));
    app.framework.dialogs.open(manager)
}

// Pigment: Export/Import Presets for every kind (P1b): the nine kinds of the Preset Manager, in its order.
/// The kinds Export/Import Presets offers, with their ids in `edit.presets.exportImportPresets`.
pub(crate) fn io_kinds() -> [(&'static str, &'static str); 9] {
    [
        ("brushes", tl!("Brushes")),
        ("swatches", tl!("Swatches")),
        ("gradients", tl!("Gradients")),
        ("styles", tl!("Styles")),
        ("patterns", tl!("Patterns")),
        ("contours", tl!("Contours")),
        ("customShapes", tl!("Custom Shapes")),
        ("tools", tl!("Tool Presets")),
        ("adjustments", tl!("Adjustments")),
    ]
}

/// The rows of Export/Import Presets.
pub(crate) fn io_params() -> Vec<Param> {
    vec![Param::new(
        "action",
        tl!("Action"),
        ParamKind::radio(
            vec![("export".to_string(), tl!("Export Presets").into()), ("import".to_string(), tl!("Import Presets").into())],
            Some("export".to_string()),
        ),
    )]
    .into_iter()
    // Pigment (P1b): one check box per kind.
    .chain(io_kinds().into_iter().map(|(id, label)| Param::new(id, label, ParamKind::bool(true))))
    .collect()
}

/// Opens Export/Import Presets, set to export everything.
pub(crate) fn open_io(app: &mut PhotocraftApp) -> DialogId {
    // Pigment (P1b): every kind checked.
    let fields = DialogFields::from_pairs(
        std::iter::once(("action", FieldValue::Text("export".into()))).chain(io_kinds().into_iter().map(|(id, _)| (id, FieldValue::Bool(true)))),
    );
    let dialog = HostedParamDialog::command(app.ctx(), IO, fields, |fields| {
        ParamDialog::command(IO, tl!("Export/Import Presets"), io_params()).values(Bind::bound(fields))
    });
    app.framework.dialogs.open(dialog)
}

/// Reads what the preset dialogs did since the last pass and runs it.
pub(crate) fn take(app: &mut PhotocraftApp, _ctx: &egui::Context) {
    take_manager(app);
}

/// Export/Import Presets as a family of the parameter dialogs: OK runs the export or import.
pub(crate) const PRESETS_FAMILY: ParamFamily = ParamFamily::new(|key| key == IO, run_io);

fn take_manager(app: &mut PhotocraftApp) {
    let Some(manager) = app.framework.dialogs.get_mut::<Manager>() else { return };
    let taken = manager.take();
    let shown = manager.kind().clone();
    if taken.kind.is_none() && taken.events.is_empty() && taken.actions.is_empty() {
        return;
    }
    let kind_changed = taken.kind.is_some();
    let kind = taken.kind.unwrap_or(shown);
    // Events of a pass that also changed the kind name rows of the old list, which the new kind's rows replace.
    if !kind_changed {
        for event in taken.events {
            let request = match event {
                PresetEvent::Rename { key, text, .. } => json!({"action": "rename", "kind": kind, "index": key, "newName": text}),
                PresetEvent::Delete(key) => json!({"action": "delete", "kind": kind, "index": key}),
                _ => continue,
            };
            if let Err(error) = app.run("edit.presets.presetManager", request) {
                app.ui.status = error;
            }
        }
    }
    // Load… is the first and only action, offered for Brushes.
    if taken.actions.contains(&0) {
        let _ = app.open_dialog_file();
    }
    let rows = load_rows(app, &kind);
    if let Some(manager) = app.framework.dialogs.get_mut::<Manager>() {
        manager.rows(rows);
        if kind_changed {
            manager.actions(actions_for(&kind));
        }
    }
}

fn run_io(app: &mut PhotocraftApp, _ctx: &egui::Context, result: ParamResult) {
    if let Err(error) = confirm_io(app, &result.fields) {
        app.ui.status = error;
    }
}

/// OK on Export/Import Presets.
fn confirm_io(app: &mut PhotocraftApp, f: &DialogFields) -> Result<Value, String> {
    // Pigment (P1b): the nine kinds; Import reads .pcpresets and tells a Pigment 0.1–0.4 bundle apart.
    let kinds: Vec<&str> = io_kinds().into_iter().map(|(id, _)| id).filter(|k| f.bool(k).unwrap_or(true)).collect();
    if f.text("action") == Some("import") {
        app.pick_file_bytes_filtered(&["pcpresets", "pigment-bundle"], move |app, name, bytes| {
            let text = if bytes.starts_with(b"PK\x03\x04") {
                photocraft_engine::paint::tile::b64_encode(&bytes)
            } else {
                String::from_utf8(bytes).map_err(|_| format!("{name} is not a preset file"))?
            };
            app.run("edit.presets.exportImportPresets", json!({"action": "import", "kinds": kinds, "data": text}))
        })
    } else {
        let out = app.run("edit.presets.exportImportPresets", json!({"action": "export", "kinds": kinds}))?;
        let text = serde_json::to_string_pretty(&out["data"]).map_err(|e| e.to_string())?;
        app.pick_save("Presets.pcpresets", move |app, path| {
            let write = app.services.write.as_mut().ok_or("no writer configured")?;
            write(&path, text.as_bytes())?;
            let template = "Exported presets to {path}";
            app.ui.status = crate::i18n::fmt(tl!(template), &[("path", &path)]);
            Ok(json!({"path": path}))
        })
    }
}

// Pigment: Export/Import Presets for every kind (P1b)
#[cfg(test)]
#[path = "presets_io_tests.rs"]
mod io_tests;
