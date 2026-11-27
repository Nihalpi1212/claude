//! Pigment: the on-image adjustment tools and the new eyedroppers in the adjustment editors (PORTS-A rows 3, 4, 7, 12,
//! 13), in the Image › Adjustments dialogs and an adjustment layer's Properties:
//!
//! - **the hand** (Photoshop's targeted adjustment tool) in Curves, Hue/Saturation and Black & White: press on the image
//!   and drag. Curves: a point at the tone under the pointer, up or down; Hue/Saturation: the range under the pointer,
//!   left or right for its saturation, with Ctrl/Cmd its hue; Black & White: the colour slider of the hue under it;
//! - **Hue/Saturation's range eyedroppers**: pick the range of a colour (Shift adds, Alt subtracts), Add to Sample,
//!   Subtract from Sample;
//! - **Exposure's eyedroppers** (black, gray, white): the dialog's tone picker (`cx.picker`), so upstream's canvas
//!   routing of `DialogPick::TonePicker` reaches [`pick_exposure`].
//!
//! The framework's editors cannot be changed here (pinned craft-libs), so the controls are a row Pigment draws above
//! each editor ([`row`], [`exposure_pickers`]), and the state they arm is a [`View`] shared between the editor's setup
//! and the app. The settings come from the engine's pure functions (`photocraft_engine::adjust_params::on_image`),
//! recomputed from the settings before the press on every drag step. In the dialog each step is an edit of its value
//! (the preview follows; OK is the one history step); in Properties the steps preview (`app.live_adjust`) and the
//! release is one `layer.setAdjustment`.

use std::sync::{Arc, Mutex};

use craft::behavior::{CursorBadge, IconId};
use craft::imaging::ui::adjust::{AdjustDialogCx, ToneChannel, TonePicker};
use craft::keymap::Mods;
use craft::ui::buttons::ToggleButton;
use craft::ui::contract::{Bind, CanvasGesture, Props as _, Sampler as _, Show as _, ShowContainer as _};
use craft::ui::display::{Shade, Text};
use craft::ui::layout_components::Row;
use craft::ui::primitives::IconSpec;
use craft::ui::style::{DataColor, TypeRole};
use egui::Ui;
use photocraft_doc::{Adjustment, ColorMode, LayerContent, LayerId};
use photocraft_engine::adjust_params::on_image::{self as engine, CurveChannel, RangeDropper};
use photocraft_engine::adjust_params::{self, CurvesEyedropper, HUE_RANGES};
use serde_json::{Value, json};

use super::adjust_dialog;
use super::adjust_editors::EditorSetup;
use crate::PhotocraftApp;
use crate::state::Tool;

/// An on-image tool armed in an editor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OnImageTool {
    /// The targeted adjustment tool.
    Hand,
    /// One of Hue/Saturation's range eyedroppers.
    Range(RangeDropper),
}

/// What an editor's row shows and the app reads: the armed tool, and Hue/Saturation's shown range (kept here so a
/// sample can show the range it picked).
#[derive(Debug, Default)]
pub struct View {
    /// The armed tool.
    pub tool: Option<OnImageTool>,
    /// Hue/Saturation's shown range: `None` for Master, else 0 Reds … 5 Magentas.
    pub range: Option<usize>,
    /// The tone picker the row saw armed on its last pass: one armed since puts the tool away.
    last_picker: Option<TonePicker>,
}

/// A [`View`] shared by an editor's setup and the app.
#[derive(Clone, Debug, Default)]
pub struct Shared(Arc<Mutex<View>>);

impl Shared {
    fn with<R>(&self, f: impl FnOnce(&mut View) -> R) -> R {
        match self.0.lock() {
            Ok(mut view) => f(&mut view),
            Err(poisoned) => f(&mut poisoned.into_inner()),
        }
    }

    /// The armed tool.
    pub fn tool(&self) -> Option<OnImageTool> {
        self.with(|view| view.tool)
    }

    /// Arms `tool` (or puts the armed one away).
    pub fn arm(&self, tool: Option<OnImageTool>) {
        self.with(|view| view.tool = tool);
    }

    /// Hue/Saturation's shown range.
    pub fn range(&self) -> Option<usize> {
        self.with(|view| view.range)
    }

    fn show_range(&self, range: Option<usize>) {
        self.with(|view| view.range = range);
    }
}

/// The app's state of the tools: the Properties editor's view and the gesture in progress.
#[derive(Default)]
pub struct State {
    /// The Properties editor's view, for `properties_layer`.
    properties: Shared,
    properties_layer: Option<LayerId>,
    /// The tool that was current when the Properties tool was armed: another tool puts it away, as the Properties
    /// eyedroppers (`layer_picker`).
    armed_under: Option<Tool>,
    /// The press in progress.
    drag: Option<Drag>,
}

/// A press of an on-image tool, until its release.
struct Drag {
    kind: String,
    tool: OnImageTool,
    /// Properties: the layer; the dialog: none.
    layer: Option<LayerId>,
    /// The parameters before the press.
    base: Value,
    /// The colour under the press.
    sample: [f32; 3],
    /// Curves: the channel shown at the press.
    channel: CurveChannel,
    /// The parameters the last step gave.
    last: Option<Value>,
}

/// Whether `kind`'s editor has the hand.
fn has_hand(kind: &str) -> bool {
    matches!(kind, "curves" | "hueSaturation" | "blackWhite")
}

/// The hand's tooltip in `kind`'s editor.
fn hand_label(kind: &str) -> String {
    match kind {
        "curves" => tl!("Click and drag in image to modify the curve").to_string(),
        "hueSaturation" if cfg!(target_os = "macos") => tl!("Click and drag in image to modify saturation. Cmd-click and drag to modify hue.").to_string(),
        "hueSaturation" => tl!("Click and drag in image to modify saturation. Ctrl-click and drag to modify hue.").to_string(),
        _ => tl!("Click and drag in image to modify a slider").to_string(),
    }
}

/// The row of on-image tools above `kind`'s editor: the hand (Curves, Hue/Saturation, Black & White) and Hue/Saturation's
/// three range eyedroppers. Arming one puts the dialog's tone picker away; arming a tone picker puts the tool away.
/// While a tool is armed, a press on the image passes through the modal dialog to the canvas.
pub fn row(ui: &mut Ui, kind: &str, setup: &EditorSetup, cx: &mut AdjustDialogCx<'_>) {
    if !has_hand(kind) {
        return;
    }
    let shared = &setup.on_image;
    let (mut armed, last) = shared.with(|view| (view.tool, view.last_picker));
    if cx.picker.is_some() && *cx.picker != last {
        armed = None;
    }
    let canvas = cx.canvas;
    let mut next = None;
    Row::new().show(ui, |ui, row| {
        if let (Some(canvas), Some(_)) = (canvas, armed) {
            row.pass_canvas_gesture(canvas, CanvasGesture::PRIMARY);
        }
        let mut tools = vec![(OnImageTool::Hand, hand_label(kind), IconSpec::svg(IconId::new("hand")))];
        if kind == "hueSaturation" {
            tools.push((OnImageTool::Range(RangeDropper::Pick), tl!("Eyedropper").to_string(), IconSpec::svg(IconId::new("eyedropper"))));
            tools.push((OnImageTool::Range(RangeDropper::Add), tl!("Add to Sample").to_string(), IconSpec::mark(CursorBadge::Add)));
            tools.push((OnImageTool::Range(RangeDropper::Subtract), tl!("Subtract from Sample").to_string(), IconSpec::mark(CursorBadge::Subtract)));
        }
        for (i, (tool, label, icon)) in tools.into_iter().enumerate() {
            let toggle =
                ToggleButton::new(label, Bind::given(armed == Some(tool))).icon(icon).icon_only().id_salt(("pigment.onImage", i)).escape_disarms().show(ui);
            if let Some(on) = toggle.value().copied() {
                next = Some(on.then_some(tool));
            }
        }
    });
    if let Some(next) = next {
        armed = next;
        if next.is_some() {
            *cx.picker = None;
        }
    }
    let picker = *cx.picker;
    shared.with(|view| {
        view.tool = armed;
        view.last_picker = picker;
    });
}

/// The pipette with a dot of the picker's tone, as the Levels and Curves rows draw it.
fn pipette(picker: TonePicker) -> IconSpec<'static> {
    IconSpec::svg(IconId::new("eyedropper")).badge(DataColor::new(egui::Color32::from_gray(picker.tone())))
}

/// Exposure's three eyedroppers (black, gray, white) over its sliders: they arm the editor's tone picker, which the
/// canvas routes to [`pick_exposure`] (dialog) or `layer_picker::sample_at` (Properties).
pub fn exposure_pickers(ui: &mut Ui, setup: &EditorSetup, cx: &mut AdjustDialogCx<'_>) {
    let (usable, current, canvas) = (!setup.pickers_unavailable, *cx.picker, cx.canvas);
    let mut next = None;
    Row::new().show(ui, |ui, row| {
        if let (Some(canvas), Some(_)) = (canvas, current) {
            row.pass_canvas_gesture(canvas, CanvasGesture::PRIMARY);
        }
        Text::new(tl!("Eyedroppers")).shade(Shade::Muted).role(TypeRole::Label).show(ui);
        let pickers = [
            (TonePicker::Black, tl!("Sample in image to set black point")),
            (TonePicker::Gray, tl!("Sample in image to set gray point")),
            (TonePicker::White, tl!("Sample in image to set white point")),
        ];
        for (picker, label) in pickers {
            let toggle = ToggleButton::new(label.to_string(), Bind::given(current == Some(picker)))
                .icon(pipette(picker))
                .icon_only()
                .enabled(usable)
                .id_salt(("pigment.exposurePicker", picker as u8))
                .escape_disarms()
                .show(ui);
            if let Some(on) = toggle.value().copied() {
                next = Some(on.then_some(picker));
            }
        }
    });
    if let Some(next) = next {
        *cx.picker = next;
    }
}

/// Hue/Saturation's shown range for the editor (host-kept, so a sample can change it).
pub fn shown_range(setup: &EditorSetup) -> Option<usize> {
    setup.on_image.range()
}

/// Keeps the range the Hue/Saturation editor showed after its pass.
pub fn keep_range(setup: &EditorSetup, shown: Option<usize>) {
    setup.on_image.show_range(shown);
}

/// The Properties editor's view for layer `id`: a new one when another layer shows; the tool is put away when the
/// current tool changed since it was armed.
pub fn properties_view(app: &mut PhotocraftApp, id: LayerId) -> Shared {
    let state = &mut app.on_image;
    if state.properties_layer != Some(id) {
        state.properties = Shared::default();
        state.properties_layer = Some(id);
        state.armed_under = None;
    }
    match (state.properties.tool(), state.armed_under) {
        (None, _) => state.armed_under = None,
        (Some(_), None) => state.armed_under = Some(app.ui.tool),
        (Some(_), Some(tool)) if tool != app.ui.tool => {
            state.properties.arm(None);
            state.armed_under = None;
        }
        _ => {}
    }
    state.properties.clone()
}

/// The on-image tool the open adjustment dialog arms, when its kind and target take one.
pub(crate) fn armed_dialog(open: &adjust_dialog::OpenAdjust) -> Option<OnImageTool> {
    if !has_hand(&open.kind) {
        return None;
    }
    let tool = open.setup.lock().ok()?.on_image.tool()?;
    (tool == OnImageTool::Hand || open.kind == "hueSaturation").then_some(tool)
}

/// The on-image tool the Properties editor arms, while its layer is the active adjustment layer of a kind with the
/// tool and the current tool is the one it was armed under.
pub(crate) fn armed_properties(app: &PhotocraftApp) -> Option<OnImageTool> {
    let state = &app.on_image;
    let tool = state.properties.tool()?;
    let st = app.session.active()?;
    let layer = state.properties_layer.filter(|id| st.active_layer == Some(*id))?;
    let kind = match &st.doc.layer(layer)?.content {
        LayerContent::Adjustment(adj) => photocraft_engine::commands::adjustment_kind(adj),
        _ => return None,
    };
    let fits = has_hand(kind) && (tool == OnImageTool::Hand || kind == "hueSaturation");
    let same_tool = state.armed_under.is_none_or(|t| t == app.ui.tool);
    (fits && same_tool).then_some(tool)
}

/// Whether the Exposure dialog's eyedroppers can sample now: an RGB or Grayscale document.
pub(crate) fn exposure_applies(app: &PhotocraftApp) -> bool {
    app.session.active().is_some_and(|s| matches!(s.doc.mode, ColorMode::Rgb | ColorMode::Grayscale))
}

/// Whether `content` is an Exposure adjustment layer (its Properties eyedroppers are `layer_picker`'s).
pub fn exposure_layer(content: &LayerContent) -> bool {
    matches!(content, LayerContent::Adjustment(Adjustment::Exposure { .. }))
}

fn eyedropper_of(picker: TonePicker) -> CurvesEyedropper {
    match picker {
        TonePicker::Black => CurvesEyedropper::Black,
        TonePicker::Gray => CurvesEyedropper::NeutralGray,
        _ => CurvesEyedropper::White,
    }
}

fn status(app: &mut PhotocraftApp, error: impl ToString) {
    app.ui.status = error.to_string();
}

/// A press at `at` with one of the Exposure dialog's eyedroppers armed: the sample becomes black, middle grey or white.
/// The press is the dialog's even when nothing changes (off the image, a transparent pixel, a black sample).
pub(crate) fn pick_exposure(app: &mut PhotocraftApp, picker: TonePicker, at: [f64; 2]) -> bool {
    let Some(id) = adjust_dialog::open_value(app).map(|open| open.id) else { return false };
    if !exposure_applies(app) {
        status(app, tl!("Unavailable in this color mode"));
        return true;
    }
    let Some(sample) = crate::canvas::composite_color(app, at[0], at[1]) else { return true };
    let Some(base) = adjust_dialog::open_params(app) else { return true };
    let Some((mode, depth)) = app.session.active().map(|s| (s.doc.mode, s.doc.depth)) else { return true };
    match engine::exposure_eyedropper(&base, eyedropper_of(picker), sample, engine::exposure_transfer(mode, depth)) {
        Ok(adjustment) => {
            let mut params = base;
            if let (Some(object), Value::Object(set)) = (params.as_object_mut(), adjust_params::to_params(&adjustment)) {
                object.extend(set);
            }
            adjust_dialog::apply_params(app, id, &params);
        }
        Err(error) => status(app, error),
    }
    true
}

/// The Curves channel the dialog or Properties shows (`shown` in `channels`), if the hand can edit it.
fn curve_channel(channels: &craft::imaging::ui::adjust::ToneChannels, shown: usize) -> Option<CurveChannel> {
    match channels.as_slice().get(shown)? {
        ToneChannel::Composite(_) | ToneChannel::Gray => Some(CurveChannel::Composite),
        ToneChannel::Red => Some(CurveChannel::Color(0)),
        ToneChannel::Green => Some(CurveChannel::Color(1)),
        ToneChannel::Blue => Some(CurveChannel::Color(2)),
        _ => None,
    }
}

/// The parameters a step of `drag` gives for the screen travel `total` (points; right and down positive) with `mods`.
fn step(drag: &Drag, total: [f64; 2], mods: Mods, mode: ColorMode) -> Result<Value, String> {
    let result = match drag.tool {
        OnImageTool::Hand => match drag.kind.as_str() {
            "curves" => engine::on_image_curves(&drag.base, drag.channel, drag.sample, total[1], mode),
            "hueSaturation" => engine::on_image_hue_sat(&drag.base, drag.sample, total[0], mods.cmd || mods.ctrl),
            _ => engine::on_image_black_white(&drag.base, drag.sample, total[0]),
        },
        OnImageTool::Range(dropper) => {
            // Photoshop's plain eyedropper adds with Shift and subtracts with Alt.
            let dropper = match dropper {
                RangeDropper::Pick if mods.shift => RangeDropper::Add,
                RangeDropper::Pick if mods.alt => RangeDropper::Subtract,
                other => other,
            };
            engine::hue_saturation_eyedropper(drag.last.as_ref().unwrap_or(&drag.base), dropper, drag.sample)
        }
    };
    result.map_err(|error| error.to_string())
}

/// The range a result's `edit` names.
fn edit_index(params: &Value) -> Option<usize> {
    params.get(engine::EDIT).and_then(Value::as_str).and_then(|name| HUE_RANGES.iter().position(|k| *k == name))
}

/// The Eyedropper's Sample Size, which the tools sample with as Photoshop's do.
fn sample_spec(app: &PhotocraftApp, at: [f64; 2]) -> Value {
    json!({"at": at, "size": app.ui.tool_options.eyedropper.size.pixels()})
}

/// A press at `at` with `tool` armed (the open dialog's, else the Properties editor's): samples the image once and
/// applies the press's own step (the hand's point appears, a range is picked). Returns whether the press is the tool's:
/// it is even when the sample fails (off the image, transparent, a grey for Black & White), which the status bar
/// reports.
pub(crate) fn press(app: &mut PhotocraftApp, tool: OnImageTool, at: [f64; 2], mods: Mods) -> bool {
    app.on_image.drag = None;
    let Some((mode, doc)) = app.session.active().map(|s| (s.doc.mode, s.doc.clone())) else { return false };
    let spec = sample_spec(app, at);
    let drag = if app.framework.dialogs.stack().top().is_some() {
        let Some(open) = adjust_dialog::open_value(app) else { return false };
        if open.target.channel.is_some() {
            status(app, tl!("The on-image tool samples the color image, not a mask or channel"));
            return true;
        }
        let kind = open.kind.clone();
        let channel = adjust_dialog::hosted(app, open.id)
            .and_then(|dialog| open.setup.lock().ok().and_then(|setup| curve_channel(&setup.channels, dialog.channel())))
            .unwrap_or(CurveChannel::Composite);
        let range = open.setup.lock().ok().and_then(|setup| setup.on_image.range());
        let Some(mut base) = adjust_dialog::open_params(app) else { return false };
        if kind == "hueSaturation" {
            base[engine::EDIT] = json!(range.and_then(|i| HUE_RANGES.get(i).copied()).unwrap_or("master"));
        }
        let sample = match engine::sample(&doc, None, &spec) {
            Ok(sample) => sample,
            Err(error) => {
                status(app, error);
                return true;
            }
        };
        Drag { kind, tool, layer: None, base, sample, channel, last: None }
    } else {
        let Some(layer) = app.on_image.properties_layer else { return false };
        let Some(LayerContent::Adjustment(adj)) = doc.layer(layer).map(|l| l.content.clone()) else { return false };
        let kind = photocraft_engine::commands::adjustment_kind(&adj).to_owned();
        let mut base = adjust_params::to_params(&adj);
        if kind == "hueSaturation" {
            base[engine::EDIT] = json!(app.on_image.properties.range().and_then(|i| HUE_RANGES.get(i).copied()).unwrap_or("master"));
        }
        let space = adjust_params::default_space(mode);
        let channels = super::adjust_editors::values::tone_channels(space, super::adjust_editors::is_gray(mode), None);
        let shown = app.adjust_session.as_ref().filter(|record| record.layer == layer).map_or(0, |record| record.channel);
        let channel = curve_channel(&channels, shown).unwrap_or(CurveChannel::Composite);
        let sample = match engine::sample(&doc, Some(layer), &spec) {
            Ok(sample) => sample,
            Err(error) => {
                status(app, error);
                return true;
            }
        };
        Drag { kind, tool, layer: Some(layer), base, sample, channel, last: None }
    };
    let first = match step(&drag, [0.0, 0.0], mods, mode) {
        Ok(first) => first,
        Err(error) => {
            status(app, error);
            return true;
        }
    };
    let drag = Drag { last: Some(first.clone()), ..drag };
    show_step(app, &drag, &first);
    app.on_image.drag = Some(drag);
    true
}

/// A drag step of the press in progress: the hand recomputes from the settings before the press with the screen travel
/// `total`; a range eyedropper samples again at `at` (a held drag keeps adding or subtracting).
pub(crate) fn drag(app: &mut PhotocraftApp, at: [f64; 2], total: [f64; 2], mods: Mods) {
    let Some(mut drag) = app.on_image.drag.take() else { return };
    let Some((mode, doc)) = app.session.active().map(|s| (s.doc.mode, s.doc.clone())) else { return };
    if matches!(drag.tool, OnImageTool::Range(_)) {
        match engine::sample(&doc, drag.layer, &sample_spec(app, at)) {
            Ok(sample) => drag.sample = sample,
            Err(_) => {
                app.on_image.drag = Some(drag);
                return;
            }
        }
    }
    if let Ok(next) = step(&drag, total, mods, mode)
        && drag.last.as_ref() != Some(&next)
    {
        show_step(app, &drag, &next);
        drag.last = Some(next);
    }
    app.on_image.drag = Some(drag);
}

/// Shows a step's parameters: the dialog's value (and, for Hue/Saturation, the range the step edits; for Curves, the
/// point it moves selected), or the Properties preview.
fn show_step(app: &mut PhotocraftApp, drag: &Drag, params: &Value) {
    let range = edit_index(params);
    match drag.layer {
        Some(layer) => {
            if drag.kind == "hueSaturation" {
                app.on_image.properties.show_range(range);
            }
            app.live_adjust = Some((layer, params.clone()));
        }
        None => {
            let Some(open) = adjust_dialog::open_value(app) else { return };
            let id = open.id;
            if drag.kind == "hueSaturation"
                && let Ok(setup) = open.setup.lock()
            {
                setup.on_image.show_range(range);
            }
            let mut merged = drag.base.clone();
            if let (Some(object), Some(set)) = (merged.as_object_mut(), params.as_object()) {
                object.extend(set.clone());
                object.remove(engine::EDIT);
            }
            adjust_dialog::apply_params(app, id, &merged);
            if drag.kind == "curves"
                && let Some(index) = moved_point(&drag.base, params, drag.channel)
                && let Some(dialog) = app.framework.dialogs.get_mut_by_id::<adjust_dialog::HostedAdjustDialog>(id)
            {
                dialog.select_point(index);
            }
        }
    }
}

/// The index of the point a Curves step added or moved on `channel`'s curve.
fn moved_point(base: &Value, params: &Value, channel: CurveChannel) -> Option<usize> {
    let key = match channel {
        CurveChannel::Composite => "points",
        CurveChannel::Color(i) => ["red", "green", "blue"].get(i)?,
    };
    let points = |p: &Value| -> Vec<[f64; 2]> { serde_json::from_value(p.get(key).cloned().unwrap_or(Value::Null)).unwrap_or_default() };
    let (before, after) = (points(base), points(params));
    after.iter().position(|p| !before.contains(p))
}

/// The release of the press in progress: in Properties, one `layer.setAdjustment` with the last step's settings (one
/// history step); the dialog keeps its value until OK.
pub(crate) fn release(app: &mut PhotocraftApp) {
    let Some(drag) = app.on_image.drag.take() else { return };
    let Some(layer) = drag.layer else { return };
    app.live_adjust = None;
    let Some(mut params) = drag.last.filter(|last| *last != drag.base) else { return };
    if let Some(object) = params.as_object_mut() {
        object.remove(engine::EDIT);
    }
    params["layer"] = json!(layer.0);
    if let Err(error) = app.run("layer.setAdjustment", params) {
        status(app, error);
    }
}

/// The cursor over the image while `tool` is armed: the hand with the move mark, or the pipette (with Add or Subtract).
pub(crate) fn cursor(tool: OnImageTool) -> craft::behavior::Cursor {
    use craft::behavior::PaintedCursor;
    match tool {
        OnImageTool::Hand => craft::behavior::Cursor::Painted(PaintedCursor::tool(IconId::new("hand"), egui::vec2(10.0, 4.0), Some(CursorBadge::Move))),
        OnImageTool::Range(dropper) => {
            let badge = match dropper {
                RangeDropper::Pick => None,
                RangeDropper::Add => Some(CursorBadge::Add),
                RangeDropper::Subtract => Some(CursorBadge::Subtract),
            };
            craft::behavior::Cursor::Painted(PaintedCursor::tool(IconId::new("eyedropper"), egui::vec2(2.0, 22.0), badge))
        }
    }
}

#[cfg(test)]
#[path = "adjust_on_image_tests.rs"]
mod tests;
