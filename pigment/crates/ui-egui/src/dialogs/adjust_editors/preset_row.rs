//! The Preset row above every adjustment editor (Pigment): Photoshop's Preset menu and its gear
//! menu, as the JavaScript Pigment had them above every adjustment editor, in the Image ›
//! Adjustments dialogs and in an adjustment layer's Properties.
//!
//! The row is the framework's `NamedPresetRow` around a `PresetPicker`: Default, the built-ins
//! and the user's groups, "Custom" when the settings are none of them (the JavaScript app's
//! `sameSettings` rule: the settings match a preset when every key the preset names matches),
//! New… (Save Preset), Rename…, Delete, and for the kinds with a Photoshop file (`.acv`, `.alv`,
//! `.ahu`, `.cha`, `.asv`, `.blw`) Load… and Save…. "Reset Presets" brings the built-ins back.
//!
//! The function reads no app: a pick comes back as the value to show ([`RowOut::apply`]), the
//! rest as [`PresetAsk`]s the host answers with the `adjustment.presets.*` commands
//! ([`answer`]), so the dialog's closure and the Properties panel share it.

use craft::ui::buttons::Button;
use craft::ui::contract::{Bind, Props as _, Show as _, clicked};
use craft::ui::patterns::presets::{
    NamedPresetEvent, NamedPresetRow, PickerField, PresetError, PresetExport, PresetFileRequest, PresetFiles, PresetPicker, PresetRow, PresetState, PresetView,
};
use photocraft_engine::presets::adjustments::{self as model, BUILTIN_GROUP, USER_GROUP};
use serde_json::{Value, json};

use super::AdjustValue;
use super::values::{self, ValueCx};
use crate::PhotocraftApp;

/// The picker's key of the Default entry (no preset name starts with a control character).
const DEFAULT_KEY: &str = "\u{1}default";
/// The picker's key prefix of a group header.
const GROUP_KEY: &str = "\u{1}group:";

/// One preset as the row lists it.
#[derive(Clone, Debug, PartialEq)]
pub struct PresetEntry {
    /// The group: [`BUILTIN_GROUP`] or one of the user's.
    pub group: String,
    /// The name, unique within the kind.
    pub name: String,
    /// A built-in (shown translated).
    pub builtin: bool,
    /// The params of `image.adjustments.<kind>` it applies, over the kind's defaults.
    pub params: Value,
}

/// What the row asks of the app.
#[derive(Clone, Debug, PartialEq)]
pub enum PresetAsk {
    /// Save the current settings as a preset of this name.
    Create(String),
    /// Rename a preset.
    Rename {
        /// The preset's name.
        from: String,
        /// The new name.
        to: String,
    },
    /// Delete a preset (a built-in comes back with Reset Presets).
    Delete(String),
    /// Load… or Save… asks for its file dialog.
    File(PresetFileRequest),
    /// Bring the built-ins back (the user's presets stay).
    Reset,
}

/// What one pass of the row reports.
#[derive(Debug, Default)]
pub struct RowOut {
    /// A preset was picked: the value to show (the preset's settings over the kind's defaults).
    pub apply: Option<AdjustValue>,
    /// What the host carries out, in order.
    pub asks: Vec<PresetAsk>,
}

/// Whether `kind` has presets (every adjustment kind with settings, and HDR Toning).
pub fn has_presets(kind: &str) -> bool {
    model::KINDS.contains(&kind)
}

/// The presets of `kind` as the row lists them, in menu order.
pub fn entries(app: &PhotocraftApp, kind: &str) -> Vec<PresetEntry> {
    app.session
        .presets
        .adjustments
        .list(kind)
        .into_iter()
        .map(|e| PresetEntry { group: e.group, name: e.preset.name, builtin: e.builtin, params: e.preset.params })
        .collect()
}

/// The value a preset's params give in `cx`: its settings over the kind's defaults, its Levels and
/// Curves channels following the document's mode (`panel::for_mode`).
pub fn preset_value(kind: &str, params: &Value, cx: &ValueCx) -> Option<AdjustValue> {
    let params = model::panel::for_mode(kind, params, tone_mode(cx));
    values::from_params(kind, &params, cx).ok()
}

/// The mode Levels and Curves channels are read in: Grayscale for a gray plane (a mask, a saved
/// channel) or document, else the document's.
fn tone_mode(cx: &ValueCx) -> photocraft_doc::ColorMode {
    if cx.isolated.as_ref().is_some_and(|c| c.gray.is_some()) { photocraft_doc::ColorMode::Grayscale } else { cx.mode }
}

/// The kind's default settings as a value in `cx`.
fn default_value(kind: &str, cx: &ValueCx) -> Option<AdjustValue> {
    let defaults = photocraft_engine::adjust_params::default_for(kind, cx.mode).ok()?;
    values::from_params(kind, &photocraft_engine::adjust_params::to_params(&defaults), cx).ok()
}

/// Whether `value` still has a preset's settings: every key the preset names has the preset's
/// value (both read through the engine, so `15` and `15.0`, or a curve given as two points and its
/// normal form, compare equal).
fn matches(kind: &str, value: &AdjustValue, preset: &Value, cx: &ValueCx) -> bool {
    let Some(shown) = preset_value(kind, preset, cx) else { return false };
    if shown == *value {
        return true;
    }
    let (now, theirs) = (values::to_params(value, cx, true), values::to_params(&shown, cx, true));
    let keys = model::panel::for_mode(kind, preset, tone_mode(cx));
    keys.as_object().is_some_and(|keys| keys.keys().all(|k| now.get(k) == theirs.get(k)))
}

/// The preset `value` shows: Default, else the first preset whose settings it has; `None` is Custom.
fn held(kind: &str, entries: &[PresetEntry], value: &AdjustValue, cx: &ValueCx) -> Option<String> {
    if default_value(kind, cx).as_ref() == Some(value) {
        return Some(DEFAULT_KEY.to_owned());
    }
    entries.iter().find(|e| matches(kind, value, &e.params, cx)).map(|e| e.name.clone())
}

/// A group's name as the picker shows it.
fn group_label(group: &str) -> String {
    match group {
        BUILTIN_GROUP => tl!("Built-in").to_owned(),
        USER_GROUP => tl!("My Presets").to_owned(),
        other => other.to_owned(),
    }
}

/// The picker's rows: Default, then each group with its presets.
fn rows(entries: &[PresetEntry]) -> Vec<PresetRow<String>> {
    let mut out = vec![PresetRow::item(DEFAULT_KEY.to_owned(), tl!("Default").to_owned(), 0)];
    let mut groups: Vec<&str> = Vec::new();
    for e in entries {
        if !groups.contains(&e.group.as_str()) {
            groups.push(&e.group);
        }
    }
    for group in groups {
        let items: Vec<&PresetEntry> = entries.iter().filter(|e| e.group == group).collect();
        out.push(PresetRow::group(format!("{GROUP_KEY}{group}"), group_label(group), 0).count(items.len()));
        out.extend(items.into_iter().map(|e| PresetRow::item(e.name.clone(), if e.builtin { tl!(&e.name).to_owned() } else { e.name.clone() }, 1)));
    }
    out
}

/// The title of a kind's preset files in the file dialog.
fn files_title(kind: &str) -> &'static str {
    match kind {
        "levels" => tl!("Levels presets"),
        "curves" => tl!("Curves presets"),
        "hueSaturation" => tl!("Hue/Saturation presets"),
        "channelMixer" => tl!("Channel Mixer presets"),
        "selectiveColor" => tl!("Selective Color presets"),
        "blackWhite" => tl!("Black & White presets"),
        _ => tl!("Presets"),
    }
}

/// The bytes of Photoshop's preset file of `value`, and its suggested name: the shown preset's,
/// else the kind's.
fn file_of(kind: &str, value: &AdjustValue, cx: &ValueCx, name: Option<&str>) -> Option<PresetExport> {
    let ext = photocraft_io::adjust_presets::extension(kind)?;
    let params = values::to_params(value, cx, true);
    let adj = photocraft_engine::adjust_params::from_params(kind, &params, None, tone_mode(cx)).ok()?;
    let bytes = photocraft_io::adjust_presets::write(&adj).ok()?;
    let stem: String =
        name.unwrap_or(files_title(kind)).chars().map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c }).collect();
    Some(PresetExport::new(format!("{stem}.{ext}"), bytes))
}

/// Shows the row for `kind` over `value` (in `cx`) for one pass. `entries` are the kind's presets
/// ([`entries`]).
pub fn preset_row(ui: &mut egui::Ui, kind: &str, entries: &[PresetEntry], value: &AdjustValue, cx: &ValueCx) -> RowOut {
    let held = held(kind, entries, value, cx);
    let shown_name = held.as_deref().filter(|k| *k != DEFAULT_KEY).map(str::to_owned);
    let (picked, asks) = draw(ui, kind, entries, held, |_| file_of(kind, value, cx, shown_name.as_deref()));
    let apply = picked.and_then(|key| match key.as_str() {
        DEFAULT_KEY => default_value(kind, cx),
        name => entries.iter().find(|e| e.name == name).and_then(|e| preset_value(kind, &e.params, cx)),
    });
    RowOut { apply, asks }
}

/// What one pass of [`params_row`] reports.
#[derive(Debug, Default)]
pub struct ParamsRowOut {
    /// A preset was picked: the params to show (the preset's over `defaults`).
    pub apply: Option<Value>,
    /// What the host carries out, in order.
    pub asks: Vec<PresetAsk>,
}

/// Whether the settings `current` have the preset `preset`'s: every key the preset names has its value (numbers to
/// 1/1000, so `15` and `15.0` are one).
pub fn params_match(preset: &Value, current: &Value) -> bool {
    fn same(a: &Value, b: &Value) -> bool {
        match (a, b) {
            (Value::Number(x), Value::Number(y)) => x.as_f64().zip(y.as_f64()).is_some_and(|(x, y)| (x - y).abs() < 1e-3),
            (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same(x, y)),
            _ => a == b,
        }
    }
    preset.as_object().is_some_and(|keys| keys.iter().all(|(k, v)| current.get(k).is_some_and(|c| same(v, c))))
}

/// The row for a kind whose dialog keeps command params, not an [`AdjustValue`] (HDR Toning, a parameter dialog):
/// the preset shown is Default when `current` has every one of `defaults`, else the first whose settings it has
/// ([`params_match`]); a pick gives the preset's params over `defaults`.
pub fn params_row(ui: &mut egui::Ui, kind: &str, entries: &[PresetEntry], current: &Value, defaults: &Value) -> ParamsRowOut {
    let held = if params_match(defaults, current) {
        Some(DEFAULT_KEY.to_owned())
    } else {
        entries.iter().find(|e| params_match(&e.params, current)).map(|e| e.name.clone())
    };
    let (picked, asks) = draw(ui, kind, entries, held, |_| None);
    let apply = picked.and_then(|key| {
        let mut out = defaults.clone();
        if key != DEFAULT_KEY {
            let e = entries.iter().find(|e| e.name == key)?;
            if let (Some(m), Some(p)) = (out.as_object_mut(), e.params.as_object()) {
                m.extend(p.iter().map(|(k, v)| (k.clone(), v.clone())));
            }
        }
        Some(out)
    });
    ParamsRowOut { apply, asks }
}

/// The row's picker and buttons for one pass: the key picked (a preset's name or [`DEFAULT_KEY`]) and the asks.
/// `export` makes the Save… file (Photoshop's), for the kinds that have one.
fn draw(
    ui: &mut egui::Ui,
    kind: &str,
    entries: &[PresetEntry],
    held: Option<String>,
    export: impl Fn(Option<&String>) -> Option<PresetExport>,
) -> (Option<String>, Vec<PresetAsk>) {
    let mut asks = Vec::new();
    let mut picked = None;
    let rows = rows(entries);
    let state_id = egui::Id::unique(("pigment.adjustPresets", kind));
    let mut state: PresetState<String> = ui.data(|d| d.get_temp(state_id)).unwrap_or_else(|| {
        let mut s = PresetState::new();
        s.view = PresetView::List;
        s
    });
    let ext = photocraft_io::adjust_presets::extension(kind);
    let extensions: Vec<&str> = ext.into_iter().collect();
    let files = PresetFiles::new(format!("adjustment.{kind}"), files_title(kind), &extensions).export(export);
    let suggestion = {
        let base = tl!("Preset");
        let taken = |n: &str| entries.iter().any(|e| e.name.eq_ignore_ascii_case(n));
        if taken(base) { (2..).map(|n| format!("{base} {n}")).find(|n| !taken(n)).unwrap_or_default() } else { base.to_owned() }
    };
    let picker = PresetPicker::new(tl!("Preset"), Bind::given(held.clone()), &rows, Bind::bound(&mut state))
        .field(PickerField::Name)
        .view(PresetView::List)
        .search(false)
        .row_menu(false);
    let mut row = NamedPresetRow::new(tl!("Preset"), picker)
        .suggest_name(suggestion)
        .check_name(|typed: &str| entries.iter().any(|e| e.name.eq_ignore_ascii_case(typed.trim())).then_some(PresetError::NameTaken))
        .built_in(|key: &String| key == DEFAULT_KEY);
    if ext.is_some() {
        row = row.files(&files);
    }
    let shown = row.show(ui);
    for event in shown.events {
        match event {
            NamedPresetEvent::Apply(key) => picked = Some(key),
            NamedPresetEvent::Create { name, .. } => asks.push(PresetAsk::Create(name)),
            NamedPresetEvent::Rename { key, text, .. } if key != DEFAULT_KEY => asks.push(PresetAsk::Rename { from: key, to: text }),
            NamedPresetEvent::Delete(key) if key != DEFAULT_KEY => asks.push(PresetAsk::Delete(key)),
            NamedPresetEvent::File(request) => asks.push(PresetAsk::File(request)),
            _ => {}
        }
    }
    if clicked(&Button::new(tl!("Reset Presets")).id_salt(("pigment.adjustPresets.reset", kind)).show(ui)) {
        asks.push(PresetAsk::Reset);
    }
    ui.data_mut(|d| d.insert_temp(state_id, state));
    (picked, asks)
}

/// Numbers held to four decimals: the editors keep `f32`s, whose `1.2` reads back as
/// `1.2000000476837158` (the settings file then keeps what the user typed).
fn tidy_numbers(v: &mut Value) {
    match v {
        Value::Number(n) if n.is_f64() => {
            if let Some(x) = n.as_f64().filter(|x| x.is_finite()) {
                let r = (x * 1e4).round() / 1e4;
                *v = if r.fract() == 0.0 && r.abs() < 1e15 { json!(r as i64) } else { json!(r) };
            }
        }
        Value::Array(a) => a.iter_mut().for_each(tidy_numbers),
        Value::Object(m) => m.values_mut().for_each(tidy_numbers),
        _ => {}
    }
}

/// Answers one ask of the row for `kind`: `params` are the current settings (a new preset's, a
/// saved file's). `loaded` is called with a loaded file's preset params, to show them.
pub fn answer(app: &mut PhotocraftApp, kind: &str, ask: PresetAsk, params: Value, loaded: impl FnOnce(&mut PhotocraftApp, Value) + 'static) {
    let kind_owned = kind.to_owned();
    let result = match ask {
        PresetAsk::Create(name) => {
            let mut params = params;
            tidy_numbers(&mut params);
            app.run("adjustment.presets.save", json!({"kind": kind, "name": name, "params": params})).map(|_| ())
        }
        PresetAsk::Rename { from, to } => {
            app.run("adjustment.presets.edit", json!({"kind": kind, "action": "rename", "name": from, "newName": to})).map(|_| ())
        }
        PresetAsk::Delete(name) => app.run("adjustment.presets.edit", json!({"kind": kind, "action": "delete", "name": name})).map(|_| ()),
        PresetAsk::Reset => app.run("adjustment.presets.reset", json!({"kind": kind})).map(|_| ()),
        PresetAsk::File(PresetFileRequest::Open { extensions, .. }) => {
            let extensions: Vec<&str> = extensions.iter().map(String::as_str).collect();
            app.pick_file_bytes_filtered(&extensions, move |app, name, bytes| {
                let file = crate::file_open::display_name(&name);
                let data = photocraft_engine::paint::tile::b64_encode(&bytes);
                let added = app.run("adjustment.presets.load", json!({"kind": kind_owned, "data": data, "fileName": file}))?;
                // The loaded preset is shown, as the app picked it after Load Preset….
                if let Some(name) = added["added"][0].as_str()
                    && let Some(e) = app.session.presets.adjustments.find(&kind_owned, Some(name), None)
                {
                    loaded(app, e.preset.params);
                }
                let report: Vec<&str> = added["report"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
                app.ui.status_error = false;
                app.ui.status = if report.is_empty() { crate::i18n::fmt(tl!("Loaded {file}"), &[("file", &file)]) } else { report.join(" · ") };
                Ok(added)
            })
            .map(|_| ())
        }
        PresetAsk::File(PresetFileRequest::Save { file_name, bytes, .. }) => app
            .pick_save(&file_name, move |app, path| {
                let write = app.services.write.as_mut().ok_or("no writer configured")?;
                write(&path, &bytes)?;
                app.ui.status_error = false;
                app.ui.status = crate::i18n::fmt(tl!("Saved {file}"), &[("file", &crate::file_open::display_name(&path))]);
                Ok(json!({"path": path}))
            })
            .map(|_| ()),
        PresetAsk::File(_) => Ok(()),
    };
    if let Err(error) = result
        && error != crate::file_dialog::CANCELLED
    {
        app.ui.status = error;
        app.ui.status_error = true;
    }
}

// ------------------------------------------------------------------ hosts

/// The row in an Image › Adjustments dialog's closure (`adjust_dialog::shared_editor`): a pick
/// writes the preset into the dialog's value (an edit the dialog previews); the rest is asked of
/// the app as [`AdjustAsk::Preset`](super::AdjustAsk::Preset).
pub(crate) fn in_dialog(ui: &mut egui::Ui, kind: &str, entries: &[PresetEntry], value: &mut crate::adjust_dialog::DialogValue) -> Option<super::AdjustAsk> {
    if !has_presets(kind) {
        return None;
    }
    let out = preset_row(ui, kind, entries, &value.value, &value.cx);
    if let Some(applied) = out.apply {
        value.value = applied;
    }
    out.asks.into_iter().next().map(super::AdjustAsk::Preset)
}

/// Lists the presets again in the open dialog `id` once they changed (a save, a load, an agent's
/// edit), as `follow_target` rebuilds the rest of the setup.
pub(crate) fn follow_dialog(app: &mut PhotocraftApp, id: craft::ui::dialog::DialogId) {
    let rev = app.session.presets.rev;
    let Some(open) = app.adjust_open.as_ref().filter(|open| open.id == id) else { return };
    if open.setup.lock().is_ok_and(|setup| setup.presets_rev == rev) {
        return;
    }
    let (kind, setup) = (open.kind.clone(), open.setup.clone());
    let presets = entries(app, &kind);
    if let Ok(mut setup) = setup.lock() {
        (setup.presets, setup.presets_rev) = (presets, rev);
    }
}

/// Answers the dialog `id`'s Preset ask: a new preset holds the dialog's settings, and a loaded
/// file's preset is shown in the dialog.
pub(crate) fn answer_dialog(app: &mut PhotocraftApp, id: craft::ui::dialog::DialogId, ask: PresetAsk) {
    let Some(open) = app.adjust_open.as_ref().filter(|open| open.id == id) else { return };
    let (kind, mode) = (open.kind.clone(), open.mode);
    let mut params = crate::adjust_dialog::open_params(app).unwrap_or(Value::Null);
    if let Some(m) = params.as_object_mut() {
        m.retain(|k, _| !matches!(k.as_str(), "target" | "layer" | "document"));
    }
    let shown = kind.clone();
    answer(app, &kind, ask, params, move |app, preset| {
        let mut preset = model::panel::for_mode(&shown, &preset, mode);
        // The dialog's address stays: a preset is settings only.
        if let (Some(m), Some(base)) = (preset.as_object_mut(), crate::adjust_dialog::open_value(app).and_then(|_| crate::adjust_dialog::open_params(app))) {
            for key in ["target", "layer", "document"] {
                if let Some(v) = base.get(key) {
                    m.insert(key.to_owned(), v.clone());
                }
            }
        }
        crate::adjust_dialog::apply_params(app, id, &preset);
    });
    follow_dialog(app, id);
}

/// The row in an adjustment layer's Properties (`session::layer_editor`), over the layer's
/// `value`: answers the asks here and returns a picked preset's value, which the editor commits.
pub(crate) fn in_properties(
    app: &mut PhotocraftApp,
    ui: &mut egui::Ui,
    id: photocraft_doc::LayerId,
    kind: &str,
    value: &AdjustValue,
    cx: &ValueCx,
) -> Option<AdjustValue> {
    if !has_presets(kind) {
        return None;
    }
    let list = entries(app, kind);
    let out = preset_row(ui, kind, &list, value, cx);
    let params = values::to_params(value, cx, true);
    for ask in out.asks {
        let shown = kind.to_owned();
        answer(app, kind, ask, params.clone(), move |app, preset| apply_to_layer(app, id, &shown, &preset));
    }
    ui.add_space(4.0);
    out.apply
}

/// Sets the adjustment layer `id` to a preset's settings (one `layer.setAdjustment`).
fn apply_to_layer(app: &mut PhotocraftApp, id: photocraft_doc::LayerId, kind: &str, preset: &Value) {
    let Some(st) = app.session.active() else { return };
    let mode = st.doc.mode;
    let Some(photocraft_doc::LayerContent::Adjustment(adj)) = st.doc.layer(id).map(|l| &l.content) else { return };
    let cx = ValueCx::new(mode, photocraft_engine::adjust_params::to_params(adj));
    let Some(value) = preset_value(kind, preset, &cx) else { return };
    let mut params = values::to_params(&value, &cx, true);
    params["layer"] = json!(id.0);
    if let Err(error) = app.run("layer.setAdjustment", params) {
        app.ui.status = error;
        app.ui.status_error = true;
    }
}

#[cfg(test)]
mod tests;
