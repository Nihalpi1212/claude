//! Pigment's rows in three Image › Adjustments parameter dialogs, as the JavaScript Pigment 0.4 had them:
//!
//! - **HDR Toning**: the Preset row (A1's `hdrToning` presets through A2's row, [`preset_row::params_row`]), the
//!   Method menu first, the Local Adaptation rows shown only for it, Exposure and Gamma enabled for the methods that
//!   use them, and a note for Equalize Histogram, which has no settings.
//! - **Match Color**: Load Statistics… and Save Statistics… under the source; a loaded file adds
//!   "Statistics: {name}" to the Source menu (`image.adjustments.matchColor`'s `sourceStatistics`).
//! - **Replace Color**: the Selection / Image preview, the Color Range proxy's picture of the colours the dialog
//!   matches; a press on it samples as a press on the canvas does ([`super::rows::replace_color_sample`]).
//!
//! The rows draw without the app, so what they need from it goes through private fields (`__hdrPresetAsk`,
//! `__statisticsAsk`, `__previewPick`, which `params_of` leaves out of the command) to [`pump`], which runs before
//! the dialogs each pass, and comes back through the egui context's data (the HDR presets, the preview pictures).

use std::borrow::Cow;
use std::hash::{Hash, Hasher};
use std::sync::Arc;

use craft::keymap::Mods;
use craft::ui::buttons::Button;
use craft::ui::choice::Segmented;
use craft::ui::contract::{Bind, Entry, Props as _, Show as _, ShowContainer as _, clicked};
use craft::ui::dialog::{StackDialog as _, dialog_id};
use craft::ui::layout_components::{Row, Stack};
use craft::ui::patterns::form_dialogs::{DialogFields, FieldValue, HostedParamDialog, Param, ParamKind, PreviewPane, PreviewState, PreviewView};
use craft::ui::primitives::TextureCache;
use craft::ui::runtime::env::Label;
use craft::ui::runtime::pointer;
use egui::load::SizedTexture;
use egui::{Color32, ColorImage, Vec2};
use photocraft_algo::tone::hdr_methods::HdrMethod;
use photocraft_doc::{DocId, Document};
use serde_json::{Map, Value, json};

use super::rows::{REPLACE_COLOR, SAMPLE_TOOL};
use super::{MATCH_COLOR, command_params, field_for};
use crate::PhotocraftApp;
use crate::dialogs::adjust_editors::preset_row::{self, PresetAsk, PresetEntry};

pub(super) const HDR_TONING: &str = "image.adjustments.hdrToning";
/// The HDR preset row's ask for the app, as JSON (`{"create":name}`, `{"rename":[from,to]}`, `{"delete":name}`,
/// `{"reset":true}`).
const PRESET_ASK: &str = "__hdrPresetAsk";
/// Match Color's Load (`load`) or Save (`save`) Statistics… press, for the app.
const STATISTICS_ASK: &str = "__statisticsAsk";
/// The statistics a file gave Match Color: `{name, mean, std}` (D50, as the engine answers them).
pub(super) const STATISTICS: &str = "__statistics";
/// The Source menu's id of the loaded statistics.
pub(super) const STATISTICS_SOURCE: &str = "stats";
/// Replace Color's preview: `image` while it shows the image, else the selection.
const PREVIEW_VIEW: &str = "__previewView";
/// A press on Replace Color's preview: `[x, y]` in document pixels, then Shift, Alt.
const PREVIEW_PICK: &str = "__previewPick";
/// The JavaScript app's HDR settings that only Local Adaptation uses.
const LOCAL_ONLY: [&str; 7] = ["radius", "strength", "detail", "shadow", "highlight", "vibrance", "saturation"];
/// The settings an HDR preset keeps.
const HDR_KEYS: [&str; 11] = ["method", "radius", "strength", "gamma", "exposure", "detail", "shadow", "highlight", "vibrance", "saturation", "curve"];

/// The context data the HDR preset row reads: the presets, listed again when `presets.rev` moves.
#[derive(Clone)]
struct HdrPresets {
    rev: u64,
    entries: Arc<Vec<PresetEntry>>,
}

/// The context data Replace Color's preview reads, kept current by [`pump`].
#[derive(Clone, Default)]
pub(crate) struct ReplacePreview {
    /// The document and revision the proxy was reduced from.
    source: Option<(DocId, u64)>,
    proxy: Option<Arc<Document>>,
    /// The proxy's reduction.
    pub(crate) k: u32,
    image: Option<Arc<ColorImage>>,
    /// What `mask` was made for.
    key: u64,
    mask: Option<Arc<ColorImage>>,
    error: Option<String>,
}

impl ReplacePreview {
    /// The picture size (the proxy's), when there is one.
    pub(crate) fn size(&self) -> Option<[usize; 2]> {
        self.mask.as_ref().or(self.image.as_ref()).map(|i| i.size)
    }
}

fn hdr_presets_id() -> egui::Id {
    egui::Id::unique("pigment.hdrToning.presets")
}

pub(crate) fn replace_preview_id() -> egui::Id {
    egui::Id::unique("pigment.replaceColor.preview")
}

/// The open parameter dialog of `command`.
fn open_dialog<'a>(app: &'a PhotocraftApp, command: &str) -> Option<&'a HostedParamDialog> {
    app.framework.dialogs.get_by_id::<HostedParamDialog>(dialog_id(command)).filter(|d| d.key() == Some(command))
}

// --- HDR Toning ----------------------------------------------------------------------------------------------

/// HDR Toning's rows: the Preset row and the Method menu first, the rows of the other settings shown or enabled for
/// the methods that use them (`HdrMethod::uses`), and Equalize Histogram's note.
pub(super) fn hdr_toning(app: &PhotocraftApp, params: &mut Vec<Param>) {
    let options = HdrMethod::ALL
        .into_iter()
        .map(|m| {
            let label = match m {
                HdrMethod::LocalAdaptation => tl!("Local Adaptation"),
                HdrMethod::EqualizeHistogram => tl!("Equalize Histogram"),
                HdrMethod::ExposureGamma => tl!("Exposure and Gamma"),
                HdrMethod::HighlightCompression => tl!("Highlight Compression"),
            };
            (m.id().to_owned(), Label::from(label))
        })
        .collect();
    let local = HdrMethod::LocalAdaptation.id();
    params.retain(|p| p.key != "method");
    let mut out = vec![hdr_preset_row(params), Param::new("method", Label::from(tl!("Method:")), ParamKind::choice(options, Some(local.to_owned())))];
    for p in params.drain(..) {
        let users: Vec<&str> = HdrMethod::ALL.into_iter().filter(|m| m.uses(&p.key)).map(HdrMethod::id).collect();
        out.push(if LOCAL_ONLY.contains(&p.key.as_str()) {
            p.visible_when("method", local)
        } else if users.len() < HdrMethod::ALL.len() {
            p.enabled_when_in("method", users.into_iter().map(str::to_owned))
        } else {
            p
        });
    }
    out.push(
        Param::read_only_text("__equalizeNote", Label::Empty, Label::from(tl!("Spreads the luminance histogram evenly. This method has no settings.")))
            .full_width()
            .visible_when("method", HdrMethod::EqualizeHistogram.id()),
    );
    *params = out;
    // The row reads the presets from the context; the pump lists them again when they change.
    let presets = HdrPresets { rev: app.session.presets.rev, entries: Arc::new(preset_row::entries(app, "hdrToning")) };
    app.ctx().data_mut(|d| d.insert_temp(hdr_presets_id(), presets));
}

/// The dialog's settings as an HDR preset keeps them.
fn hdr_settings(fields: &DialogFields) -> Value {
    let mut v = command_params(HDR_TONING, fields);
    if let Some(m) = v.as_object_mut() {
        m.retain(|k, _| HDR_KEYS.contains(&k.as_str()));
    }
    v
}

/// The Preset row over the dialog's settings: a pick writes the preset's settings over the defaults of `params`.
fn hdr_preset_row(params: &[Param]) -> Param {
    let mut opening = DialogFields::new();
    for p in params {
        if let Some(value) = p.kind.default_value() {
            opening.set(p.key.clone(), value);
        }
    }
    opening.set("method", FieldValue::Text(HdrMethod::LocalAdaptation.id().to_owned()));
    let defaults = hdr_settings(&opening);
    let rows: Vec<Param> = params.to_vec();
    Param::custom(PRESET_ASK, Label::from(tl!("Preset")), move |ui, fields, _| {
        let presets: Option<HdrPresets> = ui.ctx().data(|d| d.get_temp(hdr_presets_id()));
        let entries = presets.map(|p| p.entries).unwrap_or_default();
        let current = hdr_settings(fields);
        let response = ui.vertical(|ui| {
            let out = preset_row::params_row(ui, "hdrToning", &entries, &current, &defaults);
            if let Some(Value::Object(apply)) = out.apply {
                // A preset's settings replace the dialog's (a curve the preset has none of goes).
                fields.remove("curve");
                for (key, value) in apply {
                    let field = match rows.iter().find(|p| p.key == key) {
                        Some(row) => field_for(row, &value),
                        None if key == "method" => value.as_str().map(|s| FieldValue::Text(s.to_owned())),
                        None => Some(FieldValue::Json(value)),
                    };
                    if let Some(field) = field {
                        fields.set(key, field);
                    }
                }
            }
            if let Some(ask) = out.asks.into_iter().next().and_then(|ask| match ask {
                PresetAsk::Create(name) => Some(json!({"create": name})),
                PresetAsk::Rename { from, to } => Some(json!({"rename": [from, to]})),
                PresetAsk::Delete(name) => Some(json!({"delete": name})),
                PresetAsk::Reset => Some(json!({"reset": true})),
                PresetAsk::File(_) => None,
            }) {
                fields.set(PRESET_ASK, FieldValue::Json(ask));
            }
        });
        response.response
    })
    .full_width()
    .not_remembered()
}

/// Answers the HDR dialog's preset ask and keeps the row's list current.
fn pump_hdr(app: &mut PhotocraftApp) {
    let Some(dialog) = open_dialog(app, HDR_TONING) else { return };
    let ask = dialog.fields().get(PRESET_ASK).and_then(|v| serde_json::to_value(v).ok()).filter(|v| v.is_object());
    let settings = hdr_settings(dialog.fields());
    if ask.is_some()
        && let Some(dialog) = app.framework.dialogs.get_mut_by_id::<HostedParamDialog>(dialog_id(HDR_TONING))
    {
        dialog.clear_field(PRESET_ASK);
    }
    let text = |v: &Value| v.as_str().map(str::to_owned);
    let ask = ask.and_then(|a| {
        if let Some(name) = a.get("create").and_then(text) {
            Some(PresetAsk::Create(name))
        } else if let Some([from, to]) = a.get("rename").and_then(Value::as_array).map(Vec::as_slice) {
            Some(PresetAsk::Rename { from: text(from)?, to: text(to)? })
        } else if let Some(name) = a.get("delete").and_then(text) {
            Some(PresetAsk::Delete(name))
        } else {
            a.get("reset").map(|_| PresetAsk::Reset)
        }
    });
    if let Some(ask) = ask {
        preset_row::answer(app, "hdrToning", ask, settings, |_, _| {});
    }
    let rev = app.session.presets.rev;
    let stale = app.ctx().data(|d| d.get_temp::<HdrPresets>(hdr_presets_id())).is_none_or(|p| p.rev != rev);
    if stale {
        let presets = HdrPresets { rev, entries: Arc::new(preset_row::entries(app, "hdrToning")) };
        app.ctx().data_mut(|d| d.insert_temp(hdr_presets_id(), presets));
    }
}

// --- Match Color ---------------------------------------------------------------------------------------------

/// Match Color's Load Statistics… and Save Statistics… row, and under it the loaded statistics while they are the
/// source.
pub(super) fn match_color(params: &mut Vec<Param>) {
    let at = params.iter().position(|p| p.key == "sourceLayer").map_or(params.len(), |i| i + 1);
    let row = Param::custom(STATISTICS_ASK, Label::from(tl!("Statistics")), |ui, fields, _| {
        let source = fields.text("source").unwrap_or("-1").to_owned();
        let can_save = source == STATISTICS_SOURCE || source.parse::<i64>().is_ok_and(|i| i >= 0);
        let loaded = fields.get(STATISTICS).and_then(|v| serde_json::to_value(v).ok());
        ui.vertical(|ui| {
            ui.horizontal(|ui| {
                if clicked(&Button::new(tl!("Load Statistics…")).id_salt("pigment.loadStatistics").show(ui)) {
                    fields.set(STATISTICS_ASK, FieldValue::Text("load".into()));
                }
                if clicked(&Button::new(tl!("Save Statistics…")).id_salt("pigment.saveStatistics").enabled(can_save).show(ui)) {
                    fields.set(STATISTICS_ASK, FieldValue::Text("save".into()));
                }
            });
            if source == STATISTICS_SOURCE
                && let Some(s) = loaded
            {
                let f = |key: &str, k: usize| s[key][k].as_f64().map_or_else(String::new, |v| format!("{v:.1}"));
                ui.weak(format!("L {} ± {}, a {} ± {}, b {} ± {}", f("mean", 0), f("std", 0), f("mean", 1), f("std", 1), f("mean", 2), f("std", 2)));
            }
        })
        .response
    })
    .not_remembered();
    params.insert(at.min(params.len()), row);
}

/// The rows the builder shows this pass: Match Color's Source menu gains the loaded statistics.
pub(super) fn params_for<'p>(command: &str, params: &'p [Param], fields: &DialogFields) -> Cow<'p, [Param]> {
    let name = (command == MATCH_COLOR)
        .then(|| fields.get(STATISTICS).and_then(|v| serde_json::to_value(v).ok()))
        .flatten()
        .and_then(|v| v.get("name").and_then(Value::as_str).map(str::to_owned));
    let Some(name) = name else { return Cow::Borrowed(params) };
    let mut rows = params.to_vec();
    if let Some(ParamKind::Choice { options, .. }) = rows.iter_mut().find(|p| p.key == "source").map(|p| &mut p.kind) {
        options.push((STATISTICS_SOURCE.to_owned(), Label::from(crate::i18n::fmt(tl!("Statistics: {name}"), &[("name", &name)]))));
    }
    Cow::Owned(rows)
}

/// The command's params from the dialog's: Match Color's loaded statistics as `sourceStatistics`.
pub(super) fn command_params_of(command: &str, map: &mut Map<String, Value>) {
    if command != MATCH_COLOR || map.get("source").and_then(Value::as_str) != Some(STATISTICS_SOURCE) {
        return;
    }
    map.remove("source");
    map.remove("sourceLayer");
    if let Some(s) = map.get(STATISTICS) {
        let stats = json!({"mean": s["mean"], "std": s["std"]});
        map.insert("sourceStatistics".into(), stats);
    }
}

fn status_error(app: &mut PhotocraftApp, error: String) {
    if error != crate::file_dialog::CANCELLED {
        app.ui.status = error;
        app.ui.status_error = true;
    }
}

/// Answers Match Color's Load and Save Statistics… presses.
fn pump_match_color(app: &mut PhotocraftApp) {
    let Some(dialog) = open_dialog(app, MATCH_COLOR) else { return };
    let Some(ask) = dialog.fields().text(STATISTICS_ASK).map(str::to_owned) else { return };
    let map = super::fields_map(dialog.fields());
    if let Some(dialog) = app.framework.dialogs.get_mut_by_id::<HostedParamDialog>(dialog_id(MATCH_COLOR)) {
        dialog.clear_field(STATISTICS_ASK);
    }
    let result = match ask.as_str() {
        "load" => app
            .pick_file_bytes_filtered(&["json"], move |app, name, bytes| {
                let text = String::from_utf8_lossy(&bytes).into_owned();
                let file = crate::file_open::display_name(&name);
                let stats = app.run(photocraft_engine::adjust_cmds::match_statistics::STATISTICS, json!({"data": text, "fileName": file}))?;
                let dialog = app.framework.dialogs.get_mut_by_id::<HostedParamDialog>(dialog_id(MATCH_COLOR)).ok_or("the Match Color dialog closed")?;
                dialog.set_field(STATISTICS, FieldValue::Json(stats.clone()));
                dialog.set_field("source", FieldValue::Text(STATISTICS_SOURCE.into()));
                dialog.clear_field("sourceLayer");
                app.ui.status_error = false;
                app.ui.status = crate::i18n::fmt(tl!("Loaded {file}"), &[("file", &file)]);
                Ok(stats)
            })
            .map(|_| ()),
        "save" => save_statistics(app, &map),
        _ => Ok(()),
    };
    if let Err(error) = result {
        status_error(app, error);
    }
}

/// Save Statistics…: the source's statistics (a document's, or the loaded ones) in the JavaScript app's file.
fn save_statistics(app: &mut PhotocraftApp, map: &Map<String, Value>) -> Result<(), String> {
    let source = map.get("source").and_then(Value::as_str).unwrap_or("-1");
    let params = if source == STATISTICS_SOURCE {
        let s = map.get(STATISTICS).ok_or("no statistics are loaded")?;
        json!({"statistics": {"mean": s["mean"], "std": s["std"]}, "name": s["name"]})
    } else {
        let index = source.parse::<i64>().ok().filter(|i| *i >= 0).ok_or("choose a source document first")?;
        let mut p = json!({"source": index, "useSelectionInSource": map.get("useSelectionInSource").cloned().unwrap_or(json!(false))});
        if let Some(layer) = map.get("sourceLayer").filter(|l| l.is_u64()) {
            p["sourceLayer"] = layer.clone();
        }
        p
    };
    let out = app.run(photocraft_engine::adjust_cmds::match_statistics::STATISTICS, params)?;
    let text = out["file"].as_str().unwrap_or_default().to_owned();
    let name: String = out["name"]
        .as_str()
        .unwrap_or("Match Color")
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c })
        .collect();
    app.pick_save(&format!("{name} statistics.json"), move |app, path| {
        let write = app.services.write.as_mut().ok_or("no writer configured")?;
        write(&path, text.as_bytes())?;
        app.ui.status_error = false;
        app.ui.status = crate::i18n::fmt(tl!("Saved {file}"), &[("file", &crate::file_open::display_name(&path))]);
        Ok(json!({"path": path}))
    })
    .map(|_| ())
}

// --- Replace Color ---------------------------------------------------------------------------------------------

/// Longest side of the preview, in proxy pixels.
const PREVIEW: u32 = 200;

/// Replace Color's preview row: Selection / Image, then the picture; a press samples.
pub(super) fn replace_color(params: &mut Vec<Param>) {
    let at = params.iter().position(|p| p.key == "range").map_or(params.len(), |i| i + 1);
    let row = Param::custom(PREVIEW_VIEW, Label::from(tl!("Preview")), |ui, fields, _| {
        let preview: ReplacePreview = ui.ctx().data(|d| d.get_temp(replace_preview_id())).unwrap_or_default();
        let image_shown = fields.text(PREVIEW_VIEW) == Some("image");
        let picture = if image_shown { preview.image.clone() } else { preview.mask.clone() };
        let state = match (&preview.error, picture) {
            (Some(error), _) => PreviewState::Failed(Label::from(error.clone())),
            (None, Some(image)) => {
                let [w, h] = image.size;
                let id = TextureCache::texture(ui.ctx(), ("pigment.replaceColor", image_shown, preview.key, w, h), || (*image).clone());
                PreviewState::Ready(SizedTexture::new(id, Vec2::new(w as f32, h as f32)))
            }
            (None, None) => PreviewState::Pending(None),
        };
        let aspect = preview.size().map_or(1.0, |[w, h]| w as f32 / h.max(1) as f32);
        // As Color Range's dialog lays its preview out: the picture, and beside it Selection / Image.
        Row::new()
            .show(ui, |ui, _| {
                let pane = PreviewPane::state(Label::from(tl!("Preview")), state.clone(), &PreviewView::fixed()).aspect(aspect).click_centres(false).show(ui);
                if let Some(p) = pane.pressed
                    && !fields.text(SAMPLE_TOOL).unwrap_or_default().is_empty()
                {
                    // The picture is the proxy, `k` times smaller: the sample is the proxy pixel's centre, as Color Range's.
                    let k = f64::from(preview.k.max(1));
                    let at = [f64::from(p.x.floor().max(0.0)) * k + (k / 2.0).floor(), f64::from(p.y.floor().max(0.0)) * k + (k / 2.0).floor()];
                    let mods = pointer::frame(ui.ctx()).mods;
                    fields.set(PREVIEW_PICK, FieldValue::Json(json!([at[0], at[1], mods.shift, mods.alt])));
                }
                Stack::new().show(ui, |ui, _| {
                    let views = [Entry::new(false, Label::from(tl!("Selection"))), Entry::new(true, Label::from(tl!("Image")))];
                    if let Some(&shown) =
                        Segmented::new(Label::from(tl!("View")), Bind::given(image_shown), &views).id_salt("pigment.replaceColor.view").show(ui).value()
                    {
                        fields.set(PREVIEW_VIEW, FieldValue::Text(if shown { "image" } else { "selection" }.into()));
                    }
                });
            })
            .output
    })
    .full_width()
    .not_remembered();
    params.insert(at.min(params.len()), row);
}

/// `select.colorRange`'s params for Replace Color's `p`: the colours Replace Color matches, as the command matches
/// them (several samples through Color Range's matcher, one through its colour).
pub(crate) fn color_range_params(p: &Value) -> Value {
    let points = p.get("points").and_then(Value::as_array).map_or(0, Vec::len);
    let subtracted = p.get("subtractPoints").and_then(Value::as_array).is_some_and(|a| !a.is_empty());
    let localized = p.get("localized").and_then(Value::as_bool).unwrap_or(false);
    let mut q = json!({"fuzziness": p.get("fuzziness").cloned().unwrap_or(json!(40))});
    let samples = subtracted || points > 1 || (localized && points > 0);
    if samples {
        for key in ["points", "subtractPoints", "order", "localized", "range"] {
            if let Some(v) = p.get(key) {
                q[key] = v.clone();
            }
        }
    }
    // One colour, or subtractions from it: the From colour.
    if (!samples || points == 0)
        && let Some(c) = p.get("color")
    {
        q["color"] = c.clone();
    }
    q
}

/// The proxy's picture, as Color Range's Image view shows it.
fn picture(app: &PhotocraftApp, proxy: &Document) -> Result<ColorImage, String> {
    let buf = photocraft_compose::thumbnail_buffer(proxy, proxy.size.width.max(proxy.size.height));
    let thumb = app.session.color.canvas_display(proxy).map_err(|e| e.to_string())?.to_rgba8(&buf);
    let size = [thumb.width as usize, thumb.height as usize];
    if thumb.pixels.len() != size[0] * size[1] * 4 {
        return Err("the image preview could not be made".into());
    }
    Ok(ColorImage::from_rgba_unmultiplied(size, &thumb.pixels))
}

/// Keeps Replace Color's preview current and answers a press on it.
fn pump_replace_color(app: &mut PhotocraftApp) {
    let id = dialog_id(REPLACE_COLOR);
    let Some(dialog) = open_dialog(app, REPLACE_COLOR) else { return };
    let pick = dialog.fields().get(PREVIEW_PICK).and_then(|v| serde_json::to_value(v).ok());
    let params = command_params(REPLACE_COLOR, dialog.fields());
    if let Some(pick) = pick {
        if let Some(dialog) = app.framework.dialogs.get_mut_by_id::<HostedParamDialog>(id) {
            dialog.clear_field(PREVIEW_PICK);
        }
        if let (Some(x), Some(y)) = (pick[0].as_f64(), pick[1].as_f64()) {
            let mut mods = Mods::NONE;
            mods.shift = pick[2].as_bool().unwrap_or(false);
            mods.alt = pick[3].as_bool().unwrap_or(false);
            super::rows::replace_color_sample(app, id, [x, y], mods);
        }
        // The next pass previews the new samples.
        app.ctx().request_repaint();
    }
    let Some((doc, revision, document)) = app.session.active().map(|st| (st.doc.id, st.revision, st.doc.clone())) else { return };
    let mut preview: ReplacePreview = app.ctx().data(|d| d.get_temp(replace_preview_id())).unwrap_or_default();
    if preview.source != Some((doc, revision)) || preview.proxy.is_none() {
        let side = document.size.width.max(document.size.height).max(1);
        let k = side.div_ceil(PREVIEW).max(1);
        let proxy = Arc::new(crate::proxy::proxy_document(&document, k));
        let (image, error) = match picture(app, &proxy) {
            Ok(image) => (Some(Arc::new(image)), None),
            Err(e) => (None, Some(e)),
        };
        preview = ReplacePreview { source: Some((doc, revision)), proxy: Some(proxy), k, image, key: 0, mask: None, error };
    }
    let q = color_range_params(&params);
    let key = {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        (doc.0, revision, q.to_string()).hash(&mut h);
        h.finish().max(1)
    };
    if preview.key != key
        && let Some(proxy) = preview.proxy.clone()
    {
        let (w, h) = (proxy.size.width as usize, proxy.size.height as usize);
        match crate::dialogs::color_range_ui::proxy_mask(app, &proxy, preview.k, &q) {
            Ok(mask) if mask.len() == w * h => {
                let px: Vec<Color32> = mask.iter().map(|v| Color32::from_gray((v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8)).collect();
                preview.mask = Some(Arc::new(ColorImage::new([w, h], px)));
                preview.error = None;
            }
            Ok(_) => preview.error = Some("the selection preview has the wrong size".into()),
            Err(e) => preview.error = Some(e),
        }
        preview.key = key;
    }
    app.ctx().data_mut(|d| d.insert_temp(replace_preview_id(), preview));
}

/// Pigment's turn before the dialogs run, each pass.
pub(crate) fn pump(app: &mut PhotocraftApp) {
    pump_hdr(app);
    pump_match_color(app);
    pump_replace_color(app);
}

#[cfg(test)]
mod tests;
