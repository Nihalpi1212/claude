//! Pigment: Auto Color Correction Options (PORTS-A rows 2, 5, 14, 15, 16), the host side of the editors' Auto
//! controls (`adjust_editors::auto_row`).
//!
//! - **Auto** in Levels, Curves and Brightness/Contrast applies `image.adjustments.auto` (the engine's port of the
//!   JavaScript Pigment's algorithms) with the options in use: the session's ([`State::session`]) or the saved ones.
//!   Levels keeps the framework's own Auto (PhotoCraft's 0.1 % rule) until options were saved or chosen this session.
//! - **Alt-click on Auto** (Levels, Curves) and **Options…** open the dialog, a framework parameter dialog stacked
//!   over the adjustment dialog (or on its own over an adjustment layer's Properties): Algorithms, Snap Neutral
//!   Midtones, the three target colours with the two clipping percentages, and Save as defaults. Every change
//!   re-runs Auto and shows it in the parent (the layer's live preview in Properties); Cancel puts the parent back; OK
//!   keeps it, and saves the options as the defaults when the box is ticked (else they stay for this session).
//! - **Double-clicking an eyedropper** (Levels, Curves) opens the Color Picker for its target colour; Photoshop then
//!   asks "Save the new target colors as defaults?" (a prompt with "Don't show again"). No keeps them for this session.
//!
//! The eyedroppers read the targets through [`targets`] (the dialog) and [`with_targets`] (Properties).

use craft::imaging::ui::adjust::TonePicker;
use craft::theme::Srgba;
use craft::ui::contract::Bind;
use craft::ui::dialog::{DialogId, PromptAnswer, PromptChoice, StandardPrompt};
use craft::ui::patterns::form_dialogs::{DialogFields, FieldValue, HostedParamDialog, Param, ParamDialog, ParamKind, ParamResult};
use craft::ui::runtime::env::Label;
use craft::ui::runtime::requests::ColorRequest;
use photocraft_algo::tone::auto_options::{AutoAlgorithm, AutoOptions, MAX_CLIP, clamp_clip};
use photocraft_doc::LayerId;
use photocraft_engine::adjust_params::targets::Targets;
use photocraft_engine::cmd::auto_options_cmds as engine;
use serde_json::{Value, json};

use super::alerts;
use super::params::ParamFamily;
use crate::PhotocraftApp;
use crate::adjust_editors::AdjustValue;
use crate::adjust_editors::auto_row::AutoAsk;
use crate::adjust_editors::values::{self, ValueCx};
use crate::color_picker_ui::{self, PickWindow};

/// The options dialog's key.
pub const KEY: &str = "pigment.autoColorCorrectionOptions";
/// "Don't show again" of "Save the new target colors as defaults?" (one of `dialogs::dont_show_again_keys`).
pub const PREF: &str = "pigment.saveTargetColors";
/// The Color Picker request key of a target colour (the picker's name follows).
const TARGET_KEY: &str = "pigment.target.";

/// Where the Auto controls and the options dialog act: the open Image › Adjustments dialog or an adjustment layer's
/// Properties.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Host {
    Dialog(DialogId),
    Layer(LayerId),
}

/// The open options dialog.
#[derive(Clone, Debug)]
struct OpenOptions {
    id: DialogId,
    host: Host,
    kind: &'static str,
    /// The parent's params when the dialog opened (Cancel puts them back).
    before: Value,
    /// The options the parent shows now.
    shown: Option<AutoOptions>,
}

/// The A3 state of the app (`PhotocraftApp::auto_options`).
#[derive(Clone, Debug, Default)]
pub struct State {
    /// Options chosen this session without saving them as the defaults (OK without Save as defaults, a target colour
    /// answered "No"): the Auto buttons and the eyedroppers use them until options are saved or the app quits.
    pub session: Option<AutoOptions>,
    open: Option<OpenOptions>,
    /// Properties' open Color Picker of a target colour (its answers wait under `PickWindow::Properties`).
    picking: Option<DialogId>,
}

/// The options in use: this session's, else the saved ones (the defaults until something was saved).
pub fn options(app: &PhotocraftApp) -> AutoOptions {
    app.auto_options.session.unwrap_or_else(|| engine::current(&app.session))
}

/// Whether Auto uses Auto Color Correction Options: something was saved or chosen this session.
fn options_apply(app: &PhotocraftApp) -> bool {
    app.auto_options.session.is_some() || engine::saved(&app.session)
}

/// The eyedroppers' target colours.
pub fn targets(app: &PhotocraftApp) -> Targets {
    Targets::of(&options(app))
}

/// Adds the session's target colours to a Properties eyedropper's `layer.setAdjustment` params (the engine reads the
/// saved ones itself).
pub fn with_targets(app: &PhotocraftApp, params: &mut Value) {
    if app.auto_options.session.is_some()
        && let Some(e) = params.get_mut("eyedropper").and_then(Value::as_object_mut)
    {
        e.insert("targets".into(), targets(app).to_json());
    }
}

/// The parent's current params.
fn host_params(app: &PhotocraftApp, host: Host) -> Option<Value> {
    match host {
        Host::Dialog(_) => crate::adjust_dialog::open_params(app),
        Host::Layer(id) => {
            if let Some((layer, params)) = &app.live_adjust
                && *layer == id
            {
                return Some(params.clone());
            }
            let st = app.session.active()?;
            match &st.doc.layer(id)?.content {
                photocraft_doc::LayerContent::Adjustment(adj) => Some(photocraft_engine::adjust_params::to_params(adj)),
                _ => None,
            }
        }
    }
}

/// The engine's Auto settings of `kind` for the host's image, with `o`; `None` (and the status says why) when Auto
/// can't read it.
fn auto_params(app: &mut PhotocraftApp, host: Host, kind: &str, o: &AutoOptions) -> Option<Value> {
    let mut p = json!({"kind": kind, "options": engine::options_json(o)});
    match host {
        Host::Dialog(_) => {
            let open = crate::adjust_dialog::open_value(app)?;
            // A mask, saved channel or Quick Mask holds its own gray levels: Auto Color Correction Options read colour.
            if open.target.channel.as_ref().is_some_and(|c| c.gray.is_some()) {
                app.ui.status = tl!("Auto Color Correction Options work on the image's colours, not on a mask or channel.").into();
                return None;
            }
            if let Some(layer) = open.target.layer {
                p["layer"] = json!(layer.0);
            }
            if let Some((index, _)) = &open.smart_filter {
                p["filter"] = json!(index);
            }
        }
        Host::Layer(id) => p["layer"] = json!(id.0),
    }
    match app.run("image.adjustments.auto", p) {
        Ok(v) => Some(v),
        Err(error) => {
            app.ui.status = error;
            app.ui.status_error = true;
            None
        }
    }
}

/// `auto` laid over the parent's `current` params: Brightness/Contrast keeps nothing else; Levels and Curves replace
/// their tone settings (a drawn curve becomes points).
fn merged(kind: &str, current: &Value, auto: &Value) -> Value {
    let mut out = current.clone();
    let Some(o) = out.as_object_mut() else { return auto.clone() };
    if kind != "brightnessContrast" {
        const TONE: [&str; 17] = [
            "inBlack", "inWhite", "gamma", "outBlack", "outWhite", "points", "red", "green", "blue", "gray", "cyan", "magenta", "yellow", "black",
            "lightness", "a", "b",
        ];
        o.retain(|k, _| !TONE.contains(&k.as_str()) && k != "pencil" && k != "smooth" && k != "eyedropper");
    }
    if let Some(a) = auto.as_object() {
        o.extend(a.clone());
    }
    out
}

/// Shows `params` in the parent: the dialog's value (one edit), or the layer's live preview.
fn show_in(app: &mut PhotocraftApp, host: Host, params: &Value) {
    match host {
        Host::Dialog(id) => {
            crate::adjust_dialog::apply_params(app, id, params);
        }
        Host::Layer(id) => app.live_adjust = Some((id, params.clone())),
    }
}

/// Auto with the options in use (`framework`: what Levels' own Auto set, kept when no options apply). The settings to
/// show, `None` for nothing.
fn auto_value(app: &mut PhotocraftApp, host: Host, kind: &'static str, framework: Option<Value>) -> Option<Value> {
    if let Some(framework) = framework
        && !options_apply(app)
    {
        return Some(framework);
    }
    let o = options(app);
    let auto = auto_params(app, host, kind, &o)?;
    Some(merged(kind, &host_params(app, host)?, &auto))
}

// ------------------------------------------------------------------ the editors' asks

/// The Image › Adjustments dialog `id` answers an Auto ask (`adjust_dialog::answer_asks`).
pub(crate) fn answer_dialog(app: &mut PhotocraftApp, id: DialogId, ask: AutoAsk) {
    let host = Host::Dialog(id);
    let Some(cx) = crate::adjust_dialog::hosted(app, id).map(|d| d.value().cx.clone()) else { return };
    answer(app, host, ask, &cx);
}

/// An adjustment layer's Properties answers an Auto ask (`adjust_editors::session::layer_editor`): the value to commit
/// (one `layer.setAdjustment`), if any.
pub(crate) fn answer_properties(app: &mut PhotocraftApp, id: LayerId, kind: &str, cx: &ValueCx, ask: AutoAsk) -> Option<AdjustValue> {
    let shown = answer(app, Host::Layer(id), ask, cx)?;
    app.live_adjust = None;
    values::from_params(kind, &shown, cx).ok()
}

/// The params Auto gives (Properties commits them; the dialog has them applied already).
fn answer(app: &mut PhotocraftApp, host: Host, ask: AutoAsk, cx: &ValueCx) -> Option<Value> {
    match ask {
        AutoAsk::Auto { kind, options: true, .. } | AutoAsk::Options { kind } => {
            open(app, host, kind);
            None
        }
        AutoAsk::Auto { kind, framework, options: false } => {
            let framework = framework.map(|v| values::to_params(&v, cx, true));
            let shown = auto_value(app, host, kind, framework)?;
            if let Host::Dialog(_) = host {
                show_in(app, host, &shown);
            }
            Some(shown)
        }
        AutoAsk::PickTarget(picker) => {
            pick_target(app, host, picker);
            None
        }
    }
}

// ------------------------------------------------------------------ the options dialog

fn algorithm_label(a: AutoAlgorithm) -> &'static str {
    match a {
        AutoAlgorithm::BrightnessContrast => tl!("Enhance Brightness and Contrast"),
        AutoAlgorithm::Monochromatic => tl!("Enhance Monochromatic Contrast"),
        AutoAlgorithm::PerChannel => tl!("Enhance Per Channel Contrast"),
        AutoAlgorithm::DarkLight => tl!("Find Dark & Light Colors"),
    }
}

fn rgb(c: [u8; 3]) -> [f32; 3] {
    c.map(|v| f32::from(v) / 255.0)
}

fn bytes(c: [f32; 3]) -> [u8; 3] {
    c.map(|v| if v.is_finite() { (v.clamp(0.0, 1.0) * 255.0).round() as u8 } else { 0 })
}

/// The dialog's fields for `o`.
pub(crate) fn fields_of(o: &AutoOptions) -> DialogFields {
    let mut f = DialogFields::new();
    f.set("algorithm", o.algorithm.id());
    f.set("snapNeutralMidtones", o.snap_neutral);
    f.set("shadowColor", FieldValue::Color(rgb(o.shadow)));
    f.set("shadowClip", f64::from(o.shadow_clip));
    f.set("midtoneColor", FieldValue::Color(rgb(o.midtone)));
    f.set("highlightColor", FieldValue::Color(rgb(o.highlight)));
    f.set("highlightClip", f64::from(o.highlight_clip));
    f.set("saveAsDefaults", false);
    f
}

/// The options the fields hold (a missing or bad field keeps `base`'s).
pub(crate) fn options_of(f: &DialogFields, base: &AutoOptions) -> AutoOptions {
    AutoOptions {
        algorithm: f.text("algorithm").and_then(AutoAlgorithm::parse).unwrap_or(base.algorithm),
        snap_neutral: f.bool("snapNeutralMidtones").unwrap_or(base.snap_neutral),
        shadow_clip: f.number("shadowClip").map_or(base.shadow_clip, clamp_clip),
        highlight_clip: f.number("highlightClip").map_or(base.highlight_clip, clamp_clip),
        shadow: f.color("shadowColor").map_or(base.shadow, bytes),
        midtone: f.color("midtoneColor").map_or(base.midtone, bytes),
        highlight: f.color("highlightColor").map_or(base.highlight, bytes),
    }
}

fn rows(o: &AutoOptions) -> Vec<Param> {
    let algorithms = AutoAlgorithm::ALL.iter().map(|a| (a.id().to_string(), Label::from(algorithm_label(*a)))).collect();
    let clip = |key: &str, v: f32| Param::new(key, tl!("Clip:"), ParamKind::number(Some(0.0), Some(f64::from(MAX_CLIP)), f64::from(v), 0.01, 2));
    vec![
        Param::section(tl!("Algorithms")),
        Param::new("algorithm", tl!("Algorithm:"), ParamKind::radio(algorithms, Some(o.algorithm.id().into()))),
        Param::new("snapNeutralMidtones", tl!("Snap Neutral Midtones"), ParamKind::bool(o.snap_neutral)),
        Param::section(tl!("Target Colors & Clipping")),
        Param::new("shadowColor", tl!("Shadows:"), ParamKind::color(Some(rgb(o.shadow)))),
        clip("shadowClip", o.shadow_clip),
        Param::new("midtoneColor", tl!("Midtones:"), ParamKind::color(Some(rgb(o.midtone)))),
        Param::new("highlightColor", tl!("Highlights:"), ParamKind::color(Some(rgb(o.highlight)))),
        clip("highlightClip", o.highlight_clip),
        Param::new("saveAsDefaults", tl!("Save as defaults"), ParamKind::bool(false)),
    ]
}

/// Opens Auto Color Correction Options for `kind` in `host` (over the adjustment dialog when that is the host).
pub(crate) fn open(app: &mut PhotocraftApp, host: Host, kind: &'static str) -> Option<DialogId> {
    let before = host_params(app, host)?;
    let start = options(app);
    let rows = rows(&start);
    let title = Label::from(tl!("Auto Color Correction Options"));
    let canvas = app.session.active_index().map(|idx| crate::canvas::document_display::CanvasHost::primary(app, idx).canvas_id());
    let ctx = app.ctx().clone();
    let dialog = HostedParamDialog::new(&ctx, KEY, fields_of(&start), move |fields| {
        let dialog = ParamDialog::command(KEY, title.clone(), rows.clone()).values(Bind::bound(fields)).history(true);
        // The colour rows' eyedropper samples the document.
        match canvas {
            Some(canvas) => dialog.canvas(canvas),
            None => dialog,
        }
    });
    let id = match host {
        Host::Dialog(parent) => app.framework.dialogs.open_child(dialog, parent),
        Host::Layer(_) => app.framework.dialogs.open(dialog),
    };
    app.auto_options.open = Some(OpenOptions { id, host, kind, before, shown: None });
    // The parent shows the Auto of the options the dialog opens with, as Photoshop's does.
    follow(app);
    Some(id)
}

/// The open dialog's fields, while it is open.
fn open_fields(app: &PhotocraftApp) -> Option<(OpenOptions, DialogFields)> {
    let open = app.auto_options.open.clone()?;
    let fields = app.framework.dialogs.get_by_id::<HostedParamDialog>(open.id)?.fields().clone();
    Some((open, fields))
}

/// Each pass (`dialogs::TAKERS`): while the options dialog is open, a change of its options re-runs Auto in the parent;
/// a target colour's Color Picker answers into the options.
pub(crate) fn take(app: &mut PhotocraftApp, _ctx: &egui::Context) {
    follow(app);
    take_target(app);
}

fn follow(app: &mut PhotocraftApp) {
    let Some((open, fields)) = open_fields(app) else { return };
    let o = options_of(&fields, &options(app));
    if open.shown == Some(o) {
        return;
    }
    if let Some(slot) = app.auto_options.open.as_mut() {
        slot.shown = Some(o);
    }
    if let Some(auto) = auto_params(app, open.host, open.kind, &o) {
        let shown = merged(open.kind, &open.before, &auto);
        show_in(app, open.host, &shown);
    }
}

/// OK (`PARAM_FAMILIES`): the parent keeps the result; Save as defaults saves the options, else they stay for this
/// session.
fn run(app: &mut PhotocraftApp, _ctx: &egui::Context, result: ParamResult) {
    let Some(open) = app.auto_options.open.take() else { return };
    let o = options_of(&result.fields, &options(app));
    if result.fields.bool("saveAsDefaults") == Some(true) {
        match app.run("image.adjustments.autoOptions", json!({"options": engine::options_json(&o), "saveAsDefaults": true})) {
            Ok(_) => app.auto_options.session = None,
            Err(error) => alerts::report_error(app, error),
        }
    } else {
        app.auto_options.session = Some(o);
    }
    let Some(auto) = auto_params(app, open.host, open.kind, &o) else { return };
    let shown = merged(open.kind, &open.before, &auto);
    match open.host {
        Host::Dialog(_) => show_in(app, open.host, &shown),
        Host::Layer(id) => {
            app.live_adjust = None;
            let mut p = shown;
            p["layer"] = json!(id.0);
            if let Err(error) = app.run("layer.setAdjustment", p) {
                alerts::report_error(app, error);
            }
        }
    }
}

/// Cancel: the parent goes back to what it showed when the dialog opened.
fn cancel(app: &mut PhotocraftApp, _ctx: &egui::Context, _id: DialogId) {
    let Some(open) = app.auto_options.open.take() else { return };
    match open.host {
        Host::Dialog(_) => show_in(app, open.host, &open.before),
        Host::Layer(_) => app.live_adjust = None,
    }
}

/// The dialog's result handler (`dialogs::params::PARAM_FAMILIES`).
pub(crate) const FAMILY: ParamFamily = ParamFamily { cancel: Some(cancel), ..ParamFamily::new(|key| key == KEY, run) };

/// The open options dialog, for tests.
#[cfg(test)]
pub(crate) fn open_id(app: &PhotocraftApp) -> Option<DialogId> {
    app.auto_options.open.as_ref().map(|o| o.id)
}

// ------------------------------------------------------------------ target colours

fn picker_name(picker: TonePicker) -> &'static str {
    match picker {
        TonePicker::Black => "shadow",
        TonePicker::Gray => "midtone",
        _ => "highlight",
    }
}

/// Opens the Color Picker for `picker`'s target colour.
fn pick_target(app: &mut PhotocraftApp, host: Host, picker: TonePicker) {
    let t = targets(app);
    let (color, title) = match picker {
        TonePicker::Black => (t.shadow, tl!("Select target shadow color:")),
        TonePicker::Gray => (t.midtone, tl!("Select target midtone color:")),
        _ => (t.highlight, tl!("Select target highlight color:")),
    };
    let request = ColorRequest::new(format!("{TARGET_KEY}{}", picker_name(picker)), Srgba::from_rgb_array(color)).title(title.to_string());
    match host {
        Host::Dialog(parent) => {
            color_picker_ui::open_for_request(app, parent, request);
        }
        Host::Layer(_) => app.auto_options.picking = Some(color_picker_ui::open_for_window(app, PickWindow::Properties, request)),
    }
}

/// A colour the Color Picker answered to the adjustment dialog `id` (`adjust_dialog::answer_asks`, before the editor's
/// own colour wells): `true` when it was a target colour's.
pub(crate) fn answer_target(app: &mut PhotocraftApp, key: &str, color: Srgba) -> bool {
    let Some(which) = key.strip_prefix(TARGET_KEY) else { return false };
    let mut o = options(app);
    let c = bytes(color.to_rgb_array());
    match which {
        "shadow" => o.shadow = c,
        "midtone" => o.midtone = c,
        "highlight" => o.highlight = c,
        _ => return true,
    }
    if alerts::dismissed(app, PREF) {
        // "Don't show again" was ticked with Yes: the new targets are the defaults.
        save_targets(app, o);
        return true;
    }
    app.auto_options.session = Some(o);
    let prompt = StandardPrompt::custom(tl!("Save the new target colors as defaults?").to_owned())
        .title(tl!("Auto Color Correction Options").to_owned())
        .button(PromptChoice::Proceed, tl!("Yes").to_owned())
        .button(PromptChoice::Cancel, tl!("No").to_owned())
        .dont_show_again()
        .tag(SaveTargets(o));
    let _ = alerts::open_prompt(app, prompt);
    true
}

/// Properties' target colour, once its Color Picker answered (Properties' colour wells take their own answers while
/// one of theirs is open).
fn take_target(app: &mut PhotocraftApp) {
    let Some(id) = app.auto_options.picking else { return };
    if app.framework.dialogs.stack().ids().any(|open| open == id) {
        return;
    }
    app.auto_options.picking = None;
    // Closed: OK left its colour (Cancel nothing).
    if let Some((key, color)) = color_picker_ui::answer_for_window(app, PickWindow::Properties) {
        answer_target(app, &key, color);
    }
}

fn save_targets(app: &mut PhotocraftApp, o: AutoOptions) {
    match app.run("image.adjustments.autoOptions", json!({"options": engine::options_json(&o), "saveAsDefaults": true})) {
        Ok(_) => app.auto_options.session = None,
        Err(error) => alerts::report_error(app, error),
    }
}

/// The prompt's tag: the options with the new targets.
struct SaveTargets(AutoOptions);

/// The `PROMPTS` row of "Save the new target colors as defaults?": Yes saves them (and a ticked "Don't show again"
/// saves later ones without asking), No keeps them for this session.
pub(crate) fn answer_prompt(app: &mut PhotocraftApp, _ctx: &egui::Context, answer: &mut PromptAnswer) -> bool {
    let Some(SaveTargets(o)) = answer.take_tag::<SaveTargets>() else { return false };
    if answer.choice == PromptChoice::Proceed {
        save_targets(app, o);
        if answer.skip {
            alerts::remember_skip(app, PREF);
        }
    }
    true
}

#[cfg(test)]
mod tests;
