//! The Adjustments panel's adjustment presets (Pigment): Photoshop's "Adjustment Presets" groups
//! under the panel's icons, as the JavaScript Pigment had them, and "Your Presets", saved from
//! the selected adjustment layers by the Properties panel menu's Save Adjustment Preset….
//!
//! A preset button runs `layer.adjustmentPreset` (one history step: its layers above the active
//! one, grouped when there are several). Hovering one previews it on the canvas, built as the
//! command builds it (`photocraft_engine::cmd::adjust_preset_cmds::panel::preview`); leaving it,
//! or a panel no longer drawn, shows the document again. The engine model is
//! `photocraft_engine::presets::adjustments::panel`.

use std::sync::Arc;

use craft::ui::buttons::Button;
use craft::ui::contract::{Bind, CommandSet, Outcome as _, Props as _, Show as _, ShowContainer as _, Sizing, Trigger, clicked};
use craft::ui::dialog::DialogId;
use craft::ui::menu::{Menu, MenuItem, PanelRow};
use craft::ui::patterns::form_dialogs::{DialogFields, Param, ParamDialog, ParamKind, ParamResult};
use craft::ui::runtime::commands::{CommandRef, CommandState};
use craft::ui::sections::Section;
use photocraft_doc::{DocId, Document, LayerContent};
use photocraft_engine::presets::adjustments::panel::{self, PANEL_PRESETS, PresetLayer, YOUR_PRESETS};
use serde_json::{Value, json};

use crate::PhotocraftApp;
use crate::dialogs::curves_display_ui;
use crate::dialogs::params::{self, ParamFamily};

/// Preview keys (`canvas::display_doc`) are `BASE` plus a hash of the document, its revision and
/// the preset.
const BASE: u64 = 1 << 39;

/// The key of the Save Adjustment Preset… dialog.
const SAVE_DIALOG: &str = "pigment.saveAdjustmentPreset";

/// The preset hovered in the panel, for a document at a revision.
pub(crate) struct Hover {
    doc: DocId,
    revision: u64,
    group: String,
    preset: String,
    /// The frame the panel last drew the button in.
    frame: u64,
    /// The document shown, with its key.
    shown: Option<(u64, Arc<Document>)>,
}

/// What a preset adds, for its tooltip: "Adds Curves, Photo Filter".
fn adds(layers: &[PresetLayer]) -> String {
    let names: Vec<String> = layers
        .iter()
        .map(|l| {
            photocraft_engine::commands::find(&format!("layer.newAdjustmentLayer.{}", l.kind))
                .map_or_else(|| l.kind.clone(), |spec| tl!(spec.label.trim_end_matches('…')).to_owned())
        })
        .collect();
    crate::i18n::fmt(tl!("Adds {layers}"), &[("layers", &names.join(", "))])
}

/// One preset button: whether it was clicked, whether it is hovered, and its response.
fn preset_button(ui: &mut egui::Ui, label: &str, tip: &str, salt: (&str, &str)) -> (bool, bool, egui::Response) {
    let out = Button::new(label.to_owned()).sizing(Sizing::FillWidth).tooltip(tip.to_owned()).id_salt(("pigment.adjustmentPreset", salt.0, salt.1)).show(ui);
    (clicked(&out), out.response().hovered(), out.response().clone())
}

/// The presets section, drawn after the Adjustments panel's grid
/// (`panels::properties::adjustments::panel`).
/// Pigment (A6): Color and Vibrance, Clarity and Dehaze and Grain, which the framework's grid
/// (`AdjustmentKind::ALL`, closed to Pigment) leaves out: three icon buttons in a row after it, each
/// naming the kind of `layer.newAdjustmentLayer.<kind>` the panel runs.
pub(crate) fn newer_buttons(ui: &mut egui::Ui) -> Option<&'static str> {
    let mut picked = None;
    craft::ui::layout_components::Row::new().show(ui, |ui, _| {
        for (kind, icon, label) in [
            ("colorVibrance", "sun", tl!("Color and Vibrance")),
            ("clarityDehaze", "cloud", tl!("Clarity and Dehaze")),
            ("grain", "sparkles", tl!("Grain")),
        ] {
            let response = craft::ui::buttons::IconButton::new(craft::behavior::IconId::new(icon)).label(label).tooltip(label).show(ui);
            if clicked(&response) {
                picked = Some(kind);
            }
        }
    });
    picked
}

pub(crate) fn section(app: &mut PhotocraftApp, ui: &mut egui::Ui) {
    let has_doc = app.session.active().is_some();
    let mut hovered: Option<(String, String)> = None;
    let mut run: Option<Value> = None;
    let mut delete: Option<String> = None;
    ui.add_space(10.0);
    Section::new(tl!("Adjustment Presets")).show(ui, |ui, _| {
        for group in PANEL_PRESETS {
            Section::new(tl!(group.name)).initially_open(false).show(ui, |ui, _| {
                for p in group.presets {
                    let (click, hover, _) = preset_button(ui, tl!(p.name), &adds(&panel::builtin_layers(p)), (group.id, p.id));
                    if click && has_doc {
                        run = Some(json!({"group": group.id, "preset": p.id}));
                    }
                    if hover {
                        hovered = Some((group.id.to_owned(), p.id.to_owned()));
                    }
                }
            });
        }
        let yours = panel::yours(&app.session.presets.adjustments);
        if !yours.is_empty() {
            Section::new(tl!("Your Presets")).show(ui, |ui, _| {
                for (name, layers) in &yours {
                    let (click, hover, response) = preset_button(ui, name, &adds(layers), (YOUR_PRESETS, name));
                    if click && has_doc {
                        run = Some(json!({"group": YOUR_PRESETS, "preset": name}));
                    }
                    if hover {
                        hovered = Some((YOUR_PRESETS.to_owned(), name.clone()));
                    }
                    let _ = Menu::new(tl!("Your Presets")).opened_by(&response, Trigger::Context).show(ui, |ui, _| {
                        if MenuItem::new(tl!("Delete")).show(ui).ran {
                            delete = Some(name.clone());
                        }
                    });
                }
            });
        }
    });
    hover(app, hovered.filter(|_| has_doc));
    let ran = match (run, delete) {
        (Some(p), _) => Some(app.run("layer.adjustmentPreset", p)),
        (None, Some(name)) => Some(app.run("layer.deleteAdjustmentPreset", json!({"name": name}))),
        _ => None,
    };
    if let Some(Err(error)) = ran {
        app.ui.status = error;
        app.ui.status_error = true;
    }
}

/// Records the preset under the pointer this frame (`None`: none).
pub(crate) fn hover(app: &mut PhotocraftApp, preset: Option<(String, String)>) {
    let frame = app.frame;
    let Some(st) = app.session.active() else {
        app.adjust_panel_hover = None;
        return;
    };
    let (doc, revision) = (st.doc.id, st.revision);
    app.adjust_panel_hover = preset.map(|(group, preset)| match app.adjust_panel_hover.take() {
        Some(mut h) if h.doc == doc && h.revision == revision && h.group == group && h.preset == preset => {
            h.frame = frame;
            h
        }
        _ => Hover { doc, revision, group, preset, frame, shown: None },
    });
}

/// The document to show while a preset is hovered in document `idx` (`canvas::display_doc`).
pub(crate) fn display_doc(app: &mut PhotocraftApp, idx: usize) -> Option<(Arc<Document>, u64)> {
    let frame = app.frame;
    let st = app.session.documents().get(idx)?;
    let h = app.adjust_panel_hover.as_ref().filter(|h| h.doc == st.doc.id && h.revision == st.revision && h.frame + 1 >= frame)?;
    let key = preview_key(h);
    if let Some((k, shown)) = &h.shown
        && *k == key
    {
        return Some((shown.clone(), key));
    }
    let (group, preset) = (h.group.clone(), h.preset.clone());
    let shown = photocraft_engine::cmd::adjust_preset_cmds::panel::preview(&st.doc, st.active_layer, &app.session.presets.adjustments, &group, &preset)?;
    // Duotone documents display through their inks.
    let shown = Arc::new(photocraft_engine::mode_cmds::display_document(&shown).unwrap_or(shown));
    if let Some(h) = app.adjust_panel_hover.as_mut() {
        h.shown = Some((key, shown.clone()));
    }
    Some((shown, key))
}

fn preview_key(h: &Hover) -> u64 {
    use std::hash::{Hash as _, Hasher as _};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    (h.doc.0, h.revision, &h.group, &h.preset).hash(&mut hasher);
    (hasher.finish() & (BASE - 1)) | BASE
}

// ------------------------------------------------------------------ the Properties panel menu

/// The Properties panel menu's own rows (Pigment's: upstream's Properties has none).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, CommandSet)]
#[command(prefix = "propertiesPanel", scope = "app")]
pub(crate) enum PropertiesCommand {
    /// Save the selected adjustment layers as one of the Adjustments panel's Your Presets.
    #[command(label = "Save Adjustment Preset…")]
    SaveAdjustmentPreset,
    /// Curve Display Options of the Curves layer Properties shows (A4; Photoshop's panel menu item).
    #[command(label = "Curves Display Options…")]
    CurvesDisplayOptions,
}

/// The Properties panel menu's rows.
pub(crate) fn panel_rows(_app: &PhotocraftApp) -> Vec<PanelRow> {
    vec![
        PanelRow::Command(CommandRef::from(PropertiesCommand::SaveAdjustmentPreset)),
        PanelRow::Command(CommandRef::from(PropertiesCommand::CurvesDisplayOptions)),
    ]
}

/// Whether the selected layers hold an adjustment layer the app can edit.
fn adjustment_selected(app: &PhotocraftApp) -> bool {
    app.session.active().is_some_and(|st| {
        st.selected_layers().iter().any(|id| {
            st.doc.layer(*id).is_some_and(|l| matches!(&l.content, LayerContent::Adjustment(a) if !matches!(a, photocraft_doc::Adjustment::Unsupported { .. })))
        })
    })
}

/// The rows' states: Save Adjustment Preset… needs a selected adjustment layer, Curves Display Options… a Curves layer.
pub(crate) fn command_states(app: &PhotocraftApp) -> Vec<(CommandRef, CommandState)> {
    vec![
        (CommandRef::from(PropertiesCommand::SaveAdjustmentPreset), CommandState::new().enabled(adjustment_selected(app))),
        (CommandRef::from(PropertiesCommand::CurvesDisplayOptions), CommandState::new().enabled(curves_display_ui::curves_layer_active(app))),
    ]
}

/// Runs a fired row of the Properties panel menu; `false` for another panel's command.
pub(crate) fn run_fired(app: &mut PhotocraftApp, _ctx: &egui::Context, command: &CommandRef) -> bool {
    match PropertiesCommand::from_ref(command) {
        Some(PropertiesCommand::SaveAdjustmentPreset) if adjustment_selected(app) => {
            open_save_dialog(app);
        }
        Some(PropertiesCommand::CurvesDisplayOptions) if curves_display_ui::curves_layer_active(app) => {
            curves_display_ui::open(app, curves_display_ui::Host::Properties);
        }
        Some(_) => {}
        None => return false,
    }
    true
}

/// The name dialog of Save Adjustment Preset…, suggesting the first free "Adjustment Preset N".
pub(crate) fn open_save_dialog(app: &mut PhotocraftApp) -> DialogId {
    let taken: Vec<String> = panel::yours(&app.session.presets.adjustments).into_iter().map(|(n, _)| n).collect();
    let base = tl!("Adjustment Preset");
    let name = (1u32..).map(|n| format!("{base} {n}")).find(|n| !taken.contains(n)).unwrap_or_default();
    params::open_param_unsaved(app, SAVE_DIALOG, DialogFields::new(), Value::Null, move |fields: &mut DialogFields| {
        let rows = vec![Param::new("name", tl!("Name:"), ParamKind::text(name.clone()))];
        ParamDialog::command(SAVE_DIALOG, tl!("Save Adjustment Preset"), rows).values(Bind::bound(fields))
    })
}

/// The Save Adjustment Preset… dialog's result handler (`dialogs::params::PARAM_FAMILIES`).
pub(crate) const SAVE_FAMILY: ParamFamily = ParamFamily::new(|key| key == SAVE_DIALOG, run_save);

fn run_save(app: &mut PhotocraftApp, _ctx: &egui::Context, result: ParamResult) {
    let name = result.fields.text("name").unwrap_or_default().to_owned();
    match app.run("layer.saveAdjustmentPreset", json!({"name": name})) {
        Ok(_) => {
            app.ui.status_error = false;
            app.ui.status = crate::i18n::fmt(tl!("Saved the adjustment preset “{name}”"), &[("name", name.trim())]);
        }
        Err(error) => {
            app.ui.status = error;
            app.ui.status_error = true;
        }
    }
}

#[cfg(test)]
mod tests;
