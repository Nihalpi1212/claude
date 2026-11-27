//! Pigment: Curves › Curve Display Options and Show Clipping (PORTS-A row 11, package A4), the host side of the Curves
//! editor's display controls (`adjust_editors::curves_display`).
//!
//! - **Curve Display Options…** (a button in the Curves dialog; Properties › panel menu › Curves Display Options… on a
//!   Curves layer, as in Photoshop) opens a framework parameter dialog: Show Amount of (Light / Pigment/Ink %, kept for
//!   the document's colour mode), the grid, and Show: Channel Overlays, Histogram, Baseline, Intersection Line. The
//!   Curves graph follows it while it is open; OK saves the options in `Preferences.adjustments.curvesDisplay`, Cancel
//!   leaves them. **Choice recorded:** the framework's curve graph (pinned craft-libs) draws only the histogram option,
//!   so the other rows are shown disabled with a note, and keep what is saved (from the JavaScript Pigment's settings or
//!   `prefs.set`), until the framework draws them.
//! - **Show Clipping** is the open Curves dialog's own state, off in every new dialog (as the JavaScript Pigment and
//!   Photoshop open it).

use craft::ui::contract::Bind;
use craft::ui::dialog::DialogId;
use craft::ui::patterns::form_dialogs::{DialogFields, FieldValue, HostedParamDialog, Param, ParamDialog, ParamKind, ParamResult};
use craft::ui::runtime::env::Label;
use photocraft_color::ColorMode;
use photocraft_doc::{Adjustment, LayerContent};
use photocraft_engine::cmd::auto_options_cmds::curves_display::{CurvesAmount, CurvesDisplay, CurvesGrid};
use serde_json::json;

use super::alerts;
use super::params::ParamFamily;
use crate::PhotocraftApp;
use crate::adjust_editors::curves_display::{CurvesAsk, View};

/// The options dialog's key.
pub const KEY: &str = "pigment.curveDisplayOptions";

/// A field no dialog holds: a row enabled only while it holds one of no values is always disabled.
const NOT_DRAWN: &str = "pigment.notDrawnYet";

/// Where the options dialog opens: over the Curves dialog, or on its own for a Curves layer's Properties.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Host {
    Dialog(DialogId),
    Properties,
}

/// The A4 state of the app (`PhotocraftApp::curves_display`).
#[derive(Clone, Debug, Default)]
pub struct State {
    /// The Curves dialog whose Show Clipping is on.
    show_clipping: Option<DialogId>,
    /// The open options dialog and the colour mode its Show Amount of row is for.
    open: Option<(DialogId, ColorMode)>,
}

/// The active document's colour mode (RGB without one).
fn mode(app: &PhotocraftApp) -> ColorMode {
    app.session.active().map_or(ColorMode::Rgb, |st| st.doc.mode)
}

/// The open options dialog's fields, while it is open.
fn open_fields(app: &PhotocraftApp) -> Option<(DialogFields, ColorMode)> {
    let (id, mode) = app.curves_display.open?;
    Some((app.framework.dialogs.get_by_id::<HostedParamDialog>(id)?.fields().clone(), mode))
}

/// The display options Curves shows: the open options dialog's (it previews), else the saved ones.
pub fn display(app: &PhotocraftApp) -> CurvesDisplay {
    let saved = app.session.prefs().adjustments.curves_display;
    open_fields(app).map_or(saved, |(fields, mode)| display_of(&fields, saved, mode))
}

/// What the Curves editor of the dialog `dialog` (None: Properties) shows.
pub fn view(app: &PhotocraftApp, dialog: Option<DialogId>) -> View {
    View { histogram: display(app).histogram, show_clipping: dialog.is_some() && app.curves_display.show_clipping == dialog }
}

/// Each pass of an open adjustment dialog (`adjust_dialog::answer_asks`): a Curves dialog's editor reads the view.
pub(crate) fn follow_dialog(app: &mut PhotocraftApp, id: DialogId) {
    let Some(open) = app.adjust_open.as_ref().filter(|open| open.id == id && open.kind == "curves") else { return };
    let setup = open.setup.clone();
    let view = view(app, Some(id));
    if let Ok(mut setup) = setup.lock()
        && setup.curves_display != view
    {
        setup.curves_display = view;
    }
}

/// Answers the Curves dialog `id`'s display ask.
pub(crate) fn answer_dialog(app: &mut PhotocraftApp, id: DialogId, ask: CurvesAsk) {
    match ask {
        CurvesAsk::Options => {
            open(app, Host::Dialog(id));
        }
        CurvesAsk::ShowClipping(on) => {
            app.curves_display.show_clipping = on.then_some(id);
            follow_dialog(app, id);
        }
    }
}

/// The dialog's fields for `d` in a document of `mode`.
pub(crate) fn fields_of(d: &CurvesDisplay, mode: ColorMode) -> DialogFields {
    let mut f = DialogFields::new();
    f.set("amount", d.amount.of(mode).id());
    f.set("grid", d.grid.id());
    f.set("channelOverlays", d.channel_overlays);
    f.set("histogram", d.histogram);
    f.set("baseline", d.baseline);
    f.set("intersectionLine", d.intersection_line);
    f
}

/// The options the fields hold over `base` (a missing or bad field keeps `base`'s); Show Amount of is `mode`'s.
pub(crate) fn display_of(f: &DialogFields, base: CurvesDisplay, mode: ColorMode) -> CurvesDisplay {
    let mut d = base;
    if let Some(amount) = f.text("amount").and_then(CurvesAmount::parse) {
        *d.amount.slot(mode) = amount;
    }
    d.grid = f.text("grid").and_then(CurvesGrid::parse).unwrap_or(base.grid);
    d.channel_overlays = f.bool("channelOverlays").unwrap_or(base.channel_overlays);
    d.histogram = f.bool("histogram").unwrap_or(base.histogram);
    d.baseline = f.bool("baseline").unwrap_or(base.baseline);
    d.intersection_line = f.bool("intersectionLine").unwrap_or(base.intersection_line);
    d
}

/// The options' rows. Those the framework's curve graph cannot draw yet are disabled.
fn rows() -> Vec<Param> {
    let later = Label::from(tl!("Kept for a later version: this Curves graph cannot draw it yet."));
    let not_drawn = |p: Param| p.enabled_when_in(NOT_DRAWN, std::iter::empty::<FieldValue>()).tooltip(later.clone()).not_remembered();
    let radio = |options: [(&str, Label); 2]| ParamKind::radio(options.into_iter().map(|(id, label)| (id.to_owned(), label)).collect(), None);
    vec![
        not_drawn(Param::new(
            "amount",
            tl!("Show Amount of:"),
            radio([("light", Label::from(tl!("Light (0-255)"))), ("pigment", Label::from(tl!("Pigment/Ink %")))]),
        )),
        not_drawn(Param::new("grid", tl!("Grid:"), radio([("simple", Label::from(tl!("Simple grid"))), ("detailed", Label::from(tl!("Detailed grid")))]))),
        Param::section(tl!("Show:")),
        not_drawn(Param::new("channelOverlays", tl!("Channel Overlays"), ParamKind::bool(true))),
        Param::new("histogram", tl!("Histogram"), ParamKind::bool(true)).not_remembered(),
        not_drawn(Param::new("baseline", tl!("Baseline"), ParamKind::bool(true))),
        not_drawn(Param::new("intersectionLine", tl!("Intersection Line"), ParamKind::bool(true))),
        Param::read_only_text("note", "", later).full_width(),
    ]
}

/// Opens Curve Display Options over `host` (or brings the open one back).
pub(crate) fn open(app: &mut PhotocraftApp, host: Host) -> DialogId {
    if let Some((id, _)) = app.curves_display.open.filter(|(id, _)| app.framework.dialogs.get_by_id::<HostedParamDialog>(*id).is_some()) {
        return id;
    }
    let mode = mode(app);
    let start = fields_of(&app.session.prefs().adjustments.curves_display, mode);
    let rows = rows();
    let title = Label::from(tl!("Curve Display Options"));
    let ctx = app.ctx().clone();
    let dialog = HostedParamDialog::command(&ctx, KEY, start, move |fields| ParamDialog::command(KEY, title.clone(), rows.clone()).values(Bind::bound(fields)));
    let id = match host {
        Host::Dialog(parent) => app.framework.dialogs.open_child(dialog, parent),
        Host::Properties => app.framework.dialogs.open(dialog),
    };
    app.curves_display.open = Some((id, mode));
    id
}

/// OK (`PARAM_FAMILIES`): the options are saved.
fn run(app: &mut PhotocraftApp, _ctx: &egui::Context, result: ParamResult) {
    let Some((_, mode)) = app.curves_display.open.take() else { return };
    let d = display_of(&result.fields, app.session.prefs().adjustments.curves_display, mode);
    let value = serde_json::to_value(d).unwrap_or_default();
    if let Err(error) = app.run("prefs.set", json!({"path": "adjustments.curvesDisplay", "value": value})) {
        alerts::report_error(app, error);
    }
}

/// Cancel: the saved options stay; Curves shows them again.
fn cancel(app: &mut PhotocraftApp, _ctx: &egui::Context, _id: DialogId) {
    app.curves_display.open = None;
}

/// The dialog's result handler (`dialogs::params::PARAM_FAMILIES`).
pub(crate) const FAMILY: ParamFamily = ParamFamily { cancel: Some(cancel), ..ParamFamily::new(|key| key == KEY, run) };

/// Whether the active layer is a Curves adjustment layer (Properties shows its Curves).
pub(crate) fn curves_layer_active(app: &PhotocraftApp) -> bool {
    app.session.active().is_some_and(|st| {
        st.active_layer.and_then(|id| st.doc.layer(id)).is_some_and(|l| matches!(&l.content, LayerContent::Adjustment(Adjustment::Curves { .. })))
    })
}

#[cfg(test)]
#[path = "curves_display_ui_tests.rs"]
mod tests;
