//! Pigment: Edit › Presets › Preset Manager for every preset kind (PORTS-A §3.1, rows 21 and 23).
//!
//! Photoshop's dialog: a Preset Type select over the presets of that kind, shown as thumbnails or names in one of five
//! views (Text Only, Small and Large Thumbnail, Small and Large List), with Shift/Cmd multi-select, drag to reorder,
//! and Done, Load…, Save Set…, Rename… and Delete; a ⚙ menu holds Reset {kind}…, Replace {kind}… and the views.
//!
//! The body is the framework's `PresetBrowser` (the same one the preset panels use), so it is a `StackDialog` of its
//! own: the framework's `PresetManager` fixes the list view and has no thumbnails, views or reorder. The browser
//! selects one preset; the dialog keeps its own selection set on top (Shift for a range, Cmd/Ctrl to toggle), draws a
//! ring around its members and acts on it (Delete, Save Set…). Each kind's view persists in `ui.ron` as the browser
//! state `presetManager.<kind>`.
//!
//! Every change runs `edit.presets.presetManager` (the engine's `Library` per kind) through [`take`], which also
//! refreshes the rows whenever the libraries change (after a Load…, or an agent's edit). Load… goes through
//! `preset_files_ui::open` for the files File › Open imports, so the group-name prompt and the status line behave as
//! they do there; the other files (and Replace…) go to the engine's `load`.

use std::collections::BTreeSet;

use craft::behavior::{GesturePhase, IconId};
use craft::color_ui::ui::gradient::GradientRamp;
use craft::keymap::Mods;
use craft::theme::Srgba;
use craft::ui::buttons::IconButton;
use craft::ui::contract::{Bind, Entry, Props as _, Show as _, ShowContainer as _, Trigger};
use craft::ui::dialog::{Dialog, DialogId, DialogResult, DialogStack, PromptAnswer, PromptChoice, StackDialog, StandardPrompt, dialog_id};
use craft::ui::layout_components::Stack;
use craft::ui::menu::Menu;
use craft::ui::patterns::presets::{PresetBrowser, PresetEvent, PresetFooterEvent, PresetFooterOptions, PresetReorder, PresetRow, PresetState, PresetView};
use craft::ui::pickers::Select;
use craft::ui::primitives::{ContentPainterCx, IconSpec};
use craft::ui::primitives::textures::TextureCache;
use craft::ui::runtime::access::PopupKind;
use craft::ui::runtime::overlay::CloseReason;
use craft::ui::sections::{DialogRole, FooterButton};
use craft::ui::tile_grid::TileZoom;
use egui::{Color32, Pos2, Rect, Stroke, pos2};
use serde_json::{Value, json};

use crate::PhotocraftApp;
use crate::panels::preset_browser::PresetKey;

/// The engine command every change runs.
const CMD: &str = "edit.presets.presetManager";

/// The kinds, in Photoshop's Preset Type order, with their names.
const KINDS: [(&str, &str); 9] = [
    ("brushes", "Brushes"),
    ("swatches", "Swatches"),
    ("gradients", "Gradients"),
    ("styles", "Styles"),
    ("patterns", "Patterns"),
    ("contours", "Contours"),
    ("customShapes", "Custom Shapes"),
    ("tools", "Tools"),
    ("adjustments", "Adjustments"),
];

/// The kind's name, translated.
fn kind_label(kind: &str) -> &'static str {
    KINDS.iter().find(|(k, _)| *k == kind).map_or("Presets", |(_, label)| tl!(label))
}

/// Photoshop's five views of the Preset Manager.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum View {
    TextOnly,
    SmallThumbnail,
    LargeThumbnail,
    SmallList,
    LargeList,
}

impl View {
    const ALL: [View; 5] = [View::TextOnly, View::SmallThumbnail, View::LargeThumbnail, View::SmallList, View::LargeList];

    pub fn id(self) -> &'static str {
        match self {
            View::TextOnly => "textOnly",
            View::SmallThumbnail => "smallThumbnail",
            View::LargeThumbnail => "largeThumbnail",
            View::SmallList => "smallList",
            View::LargeList => "largeList",
        }
    }

    fn parse(id: &str) -> Option<View> {
        View::ALL.into_iter().find(|v| v.id() == id)
    }

    fn label(self) -> &'static str {
        match self {
            View::TextOnly => tl!("Text Only"),
            View::SmallThumbnail => tl!("Small Thumbnail"),
            View::LargeThumbnail => tl!("Large Thumbnail"),
            View::SmallList => tl!("Small List"),
            View::LargeList => tl!("Large List"),
        }
    }

    /// The browser state that shows this view. Text Only is a list at the medium zoom, which no other view uses (the
    /// framework's list shows its small thumbnail up to 0.75 and its large one from 1.5).
    fn state(self, mut state: PresetState<PresetKey>) -> PresetState<PresetKey> {
        (state.view, state.zoom) = match self {
            View::TextOnly => (PresetView::List, 1.0),
            View::SmallThumbnail => (PresetView::Grid, SMALL),
            View::LargeThumbnail => (PresetView::Grid, LARGE),
            View::SmallList => (PresetView::List, SMALL),
            View::LargeList => (PresetView::List, LARGE),
        };
        state
    }

    /// The view a browser state shows (a new state: Small Thumbnail).
    fn of(state: &PresetState<PresetKey>) -> View {
        match state.view {
            PresetView::List if state.zoom <= 0.75 => View::SmallList,
            PresetView::List if state.zoom >= 1.5 => View::LargeList,
            PresetView::List => View::TextOnly,
            _ if state.zoom >= 1.5 => View::LargeThumbnail,
            _ => View::SmallThumbnail,
        }
    }
}

/// The zooms of the small and large views.
const SMALL: f64 = 0.5;
const LARGE: f64 = 2.0;
/// The zoom range of the browser: the five views only (the footer has no slider).
const ZOOMS: TileZoom = TileZoom::bounded(SMALL, LARGE, 0.25, SMALL);

/// The key a kind's view state persists under in `PresetUi::browsers`.
fn state_key(kind: &str) -> String {
    format!("presetManager.{kind}")
}

/// What a preset's thumbnail shows, read from the session when the rows load (the dialog draws without the app).
#[derive(Clone)]
enum Thumb {
    None,
    Color(Color32),
    Gradient(Vec<(f32, Srgba)>),
    Texture(egui::TextureId),
    Curve(Vec<[f32; 2]>),
    Icon(IconId),
}

/// One preset of the shown kind.
#[derive(Clone)]
struct Row {
    group: String,
    name: String,
    thumb: Thumb,
}

/// A press of the dialog's footer or ⚙ menu, or what the browser reported, for [`take`] to run.
#[derive(Clone, Debug, PartialEq)]
enum Ask {
    Kind,
    Rename { index: usize, text: String },
    Delete(Vec<usize>),
    Move(Value),
    Load,
    Replace,
    SaveSet(Vec<usize>),
    Reset,
}

/// The footer buttons, in order (Done closes).
const LOAD: usize = 0;
const SAVE_SET: usize = 1;
const RENAME: usize = 2;
const DELETE: usize = 3;

/// The open Preset Manager.
pub struct PresetManagerDialog {
    id: DialogId,
    kind: String,
    rows: Vec<Row>,
    /// The shown kind's facts from the engine: `canReset`, `canMove`, `load`, `save`.
    info: Value,
    /// The view state of each kind shown so far (written back to `PresetUi::browsers` by [`take`]).
    states: std::collections::BTreeMap<String, PresetState<PresetKey>>,
    /// The selection set (row indices) and the row a Shift-click extends from.
    selected: BTreeSet<usize>,
    anchor: Option<usize>,
    /// The library revision the rows were read at.
    rev: (u64, u64),
    queued: Vec<Ask>,
}

impl PresetManagerDialog {
    fn state(&self) -> PresetState<PresetKey> {
        self.states.get(&self.kind).cloned().unwrap_or_else(|| View::SmallThumbnail.state(PresetState::new()))
    }

    fn view(&self) -> View {
        View::of(&self.state())
    }

    fn set_view(&mut self, view: View) {
        let state = view.state(self.state());
        self.states.insert(self.kind.clone(), state);
    }

    /// The browser's rows: each folder (when the kind has folders) followed by its presets, keyed by index.
    fn browser_rows(&self) -> Vec<PresetRow<PresetKey>> {
        let grouped = self.rows.iter().any(|r| !r.group.is_empty());
        let mut out = Vec::with_capacity(self.rows.len() + 8);
        let mut last: Option<&str> = None;
        for (i, row) in self.rows.iter().enumerate() {
            if grouped && last != Some(row.group.as_str()) {
                let label = if row.group.is_empty() { tl!("Ungrouped").to_string() } else { row.group.clone() };
                out.push(PresetRow::group(PresetKey::Group(row.group.clone()), label, 0));
                last = Some(row.group.as_str());
            }
            let mut item = PresetRow::item(PresetKey::Item(i.to_string()), row.name.clone(), usize::from(grouped));
            if self.selected.contains(&i) && self.view() == View::TextOnly {
                item = item.caption(tl!("selected"));
            }
            out.push(item);
        }
        out
    }

    /// A click on row `i` with `mods`: alone it selects only that row; Cmd/Ctrl toggles it; Shift selects the range
    /// from the anchor.
    fn select(&mut self, i: usize, mods: Mods) {
        if mods.shift
            && let Some(a) = self.anchor
        {
            let (lo, hi) = (a.min(i), a.max(i));
            if !mods.cmd {
                self.selected.clear();
            }
            self.selected.extend(lo..=hi);
            return;
        }
        if mods.cmd || mods.ctrl {
            if !self.selected.remove(&i) {
                self.selected.insert(i);
            }
        } else {
            self.selected = BTreeSet::from([i]);
        }
        self.anchor = Some(i);
    }

    fn index(key: &PresetKey) -> Option<usize> {
        match key {
            PresetKey::Item(i) => i.parse().ok(),
            PresetKey::Group(_) => None,
        }
    }

    /// What the browser reported, as asks (selection changes are the dialog's own).
    fn event(&mut self, event: PresetEvent<PresetKey>, rows: &[PresetRow<PresetKey>]) {
        match event {
            PresetEvent::Select { key, mods, .. } | PresetEvent::Activate { key, mods, .. } => {
                if let Some(i) = Self::index(&key) {
                    self.select(i, mods);
                }
            }
            PresetEvent::Rename { key, text, .. } => {
                if let Some(index) = Self::index(&key) {
                    self.queued.push(Ask::Rename { index, text });
                }
            }
            PresetEvent::Delete(key) => {
                if let Some(i) = Self::index(&key) {
                    self.queued.push(Ask::Delete(vec![i]));
                }
            }
            PresetEvent::Footer(PresetFooterEvent::Delete) => self.delete_selected(),
            PresetEvent::MoveTo { key, group: PresetKey::Group(group), .. } => {
                if let Some(i) = Self::index(&key) {
                    self.queued.push(Ask::Move(json!({"index": i, "toGroup": group})));
                }
            }
            PresetEvent::Reorder(edit) if matches!(edit.phase(), Some(GesturePhase::Commit) | None) => {
                let Some(mv) = edit.value() else { return };
                let Some(i) = Self::index(&mv.key) else { return };
                // `to` counts the browser rows left once the moved one is out.
                let rest: Vec<&PresetKey> = rows.iter().map(|r| &r.key).filter(|k| !mv.keys.contains(k)).collect();
                let head = &rest[..mv.to.min(rest.len())];
                let ask = match head.iter().rposition(|k| matches!(k, PresetKey::Group(_))) {
                    Some(folder) => {
                        let PresetKey::Group(group) = head[folder] else { return };
                        json!({"index": i, "toGroup": group, "position": head.len() - folder - 1})
                    }
                    None => json!({"index": i, "to": head.len()}),
                };
                self.queued.push(Ask::Move(ask));
            }
            _ => {}
        }
    }

    fn delete_selected(&mut self) {
        if !self.selected.is_empty() {
            self.queued.push(Ask::Delete(self.selected.iter().copied().collect()));
        }
    }

    /// Presses footer button `at` (a pass's pick, or `press` from automation).
    fn press(&mut self, ctx: &egui::Context, at: usize) {
        match at {
            LOAD => self.queued.push(Ask::Load),
            SAVE_SET => {
                let rows: Vec<usize> = if self.selected.is_empty() { (0..self.rows.len()).collect() } else { self.selected.iter().copied().collect() };
                self.queued.push(Ask::SaveSet(rows));
            }
            RENAME => {
                if let Some(&i) = self.selected.iter().next() {
                    PresetBrowser::request_rename(ctx, browser_id(), &PresetKey::Item(i.to_string()));
                }
            }
            DELETE => self.delete_selected(),
            _ => {}
        }
    }

    fn flag(&self, key: &str) -> bool {
        self.info.get(key).and_then(Value::as_bool).unwrap_or(false)
    }

    /// The ⚙ menu: Reset and Replace, then the views.
    fn gear(&mut self, ui: &mut egui::Ui) {
        #[derive(Clone, PartialEq)]
        enum Gear {
            Reset,
            Replace,
            View(&'static str),
        }
        let label = tl!("Preset Manager options").to_string();
        let button = IconButton::new(IconId::new("settings")).label(label.clone()).popup(PopupKind::Menu).show(ui);
        let kind = kind_label(&self.kind);
        let can_replace = self.kind != "adjustments";
        let view = self.view();
        let mut entries = vec![
            Entry::new(Gear::Reset, crate::i18n::fmt(tl!("Reset {kind}…"), &[("kind", kind)])).enabled(self.flag("canReset")),
            Entry::new(Gear::Replace, crate::i18n::fmt(tl!("Replace {kind}…"), &[("kind", kind)])).enabled(can_replace),
            Entry::separator(),
        ];
        entries.extend(View::ALL.into_iter().map(|v| Entry::new(Gear::View(v.id()), v.label().to_string()).checked(v == view)));
        match Menu::new(label).opened_by(&button, Trigger::Press).pick(ui, &entries).picked {
            Some(Gear::Reset) => self.queued.push(Ask::Reset),
            Some(Gear::Replace) => self.queued.push(Ask::Replace),
            Some(Gear::View(v)) => {
                if let Some(v) = View::parse(v) {
                    self.set_view(v);
                }
            }
            None => {}
        }
    }
}

/// The browser's id, which Rename… asks to rename in.
fn browser_id() -> egui::Id {
    egui::Id::unique("pigment-preset-manager-browser")
}

/// The ring around the presets in the selection set.
const SELECTED: Color32 = Color32::from_rgb(56, 132, 255);

/// Paints a row's thumbnail into `rect`, with a ring when it is in the selection set.
fn paint(cx: &ContentPainterCx, rect: Rect, thumb: &Thumb, selected: bool) {
    let full = Rect::from_min_max(Pos2::ZERO, pos2(1.0, 1.0));
    match thumb {
        Thumb::None => {}
        Thumb::Color(c) => {
            cx.painter.rect_filled(rect.shrink(1.0), 2.0, *c);
        }
        Thumb::Gradient(stops) => {
            let (radius, edge) = GradientRamp::chip_look(&cx.style_cx());
            GradientRamp::paint_chip(cx, rect, radius, stops, edge);
        }
        Thumb::Texture(t) => cx.picture(*t, rect.shrink(1.0), full, 0.0),
        Thumb::Curve(points) => {
            let inner = rect.shrink(rect.width().min(rect.height()) * 0.15);
            let line: Vec<Pos2> = points.iter().map(|[x, y]| pos2(inner.left() + x * inner.width(), inner.bottom() - y * inner.height())).collect();
            cx.painter.rect_stroke(inner, 0.0, Stroke::new(1.0, Color32::from_gray(110)), egui::StrokeKind::Inside);
            cx.painter.add(egui::Shape::line(line, Stroke::new(1.5, Color32::from_gray(200))));
        }
        Thumb::Icon(icon) => {
            let side = rect.width().min(rect.height()) * 0.6;
            cx.icon(Rect::from_center_size(rect.center(), egui::vec2(side, side)), &IconSpec::svg(icon.clone()));
        }
    }
    if selected {
        cx.painter.rect_stroke(rect, 3.0, Stroke::new(2.0, SELECTED), egui::StrokeKind::Inside);
    }
}

impl StackDialog for PresetManagerDialog {
    type Result = ();

    fn id(&self) -> DialogId {
        self.id
    }

    fn show(&mut self, ui: &mut egui::Ui, _: &DialogStack) -> Option<DialogResult<()>> {
        let kinds: Vec<Entry<String>> = KINDS.iter().map(|(k, label)| Entry::new(k.to_string(), tl!(label).to_string())).collect();
        let any = !self.selected.is_empty();
        let buttons = [
            FooterButton::new(tl!("Load…"), DialogRole::Other).stays_open(true),
            FooterButton::new(tl!("Save Set…"), DialogRole::Other).stays_open(true).enabled(!self.rows.is_empty()),
            FooterButton::new(tl!("Rename…"), DialogRole::Other).stays_open(true).enabled(self.selected.len() == 1),
            FooterButton::new(tl!("Delete"), DialogRole::Other).stays_open(true).enabled(any),
            FooterButton::new(tl!("Done"), DialogRole::Accept),
        ];
        let rows = self.browser_rows();
        let selected_key = self.anchor.filter(|a| self.selected.contains(a)).map(|a| PresetKey::Item(a.to_string()));
        let mut state = self.state();
        let view = View::of(&state);
        let thumbs: Vec<Thumb> = self.rows.iter().map(|r| r.thumb.clone()).collect();
        let members = self.selected.clone();
        let can_move = self.flag("canMove");
        let mut kind = self.kind.clone();
        let shown = Dialog::new(tl!("Preset Manager")).buttons(buttons).show(ui, |ui, _| {
            let mut gear_ui = None;
            ui.horizontal(|ui| {
                let picked = Select::new(tl!("Preset Type:"), Bind::bound(&mut kind), &kinds).show(ui).value().cloned();
                gear_ui = Some(picked);
            });
            let events = Stack::new()
                .id_salt(("pigment-preset-manager", kind.clone()))
                .fill_width()
                .show(ui, |ui, _| {
                    let mut browser = PresetBrowser::new(tl!("Presets"), Bind::bound(&mut state), &rows)
                        .browser_id(browser_id())
                        // The search field; the view comes from the ⚙ menu (`view_lock` hides the view buttons).
                        .toolbar(true)
                        .row_menu(true)
                        .view_lock(if view == View::TextOnly || matches!(view, View::SmallList | View::LargeList) { PresetView::List } else { PresetView::Grid })
                        .thumb_range(ZOOMS)
                        .max_rows(12)
                        .can_rename(|key| matches!(key, PresetKey::Item(_)))
                        .can_delete(|key| matches!(key, PresetKey::Item(_)))
                        .footer(PresetFooterOptions::new().slider(false).can_delete(!members.is_empty()))
                        .empty(tl!("No presets of this kind."));
                    if let Some(key) = selected_key.clone() {
                        browser = browser.selected(key);
                    }
                    if can_move {
                        browser = browser.reorder(PresetReorder::items_and_groups());
                    }
                    if view != View::TextOnly {
                        browser = browser.thumb(|cx, rect, info| {
                            if let PresetKey::Item(i) = info.key
                                && let Ok(i) = i.parse::<usize>()
                                && let Some(thumb) = thumbs.get(i)
                            {
                                paint(cx, rect, thumb, members.contains(&i));
                            }
                        });
                    }
                    browser.show(ui).events
                })
                .inner
                .unwrap_or_default();
            (gear_ui.flatten(), events)
        });
        self.states.insert(self.kind.clone(), state);
        let (picked_kind, events) = shown.inner.unwrap_or_default();
        if let Some(k) = picked_kind.filter(|k| *k != self.kind) {
            self.kind = k;
            self.selected.clear();
            self.anchor = None;
            self.queued.push(Ask::Kind);
        } else {
            for event in events {
                self.event(event, &rows);
            }
        }
        // The ⚙ menu sits under the Preset Type row.
        self.gear(ui);
        if let Some(at) = shown.output.picked.filter(|at| *at < DELETE + 1) {
            self.press(ui.ctx(), at);
        }
        match shown.output.closed? {
            CloseReason::Enter | CloseReason::Activated => Some(DialogResult::Ok(())),
            _ => Some(DialogResult::Cancel),
        }
    }

    fn confirm(&mut self, _: &egui::Context) -> Option<()> {
        Some(())
    }

    fn json_fields(&self) -> Option<Value> {
        let rows: Vec<Value> = self.rows.iter().map(|r| json!({"group": r.group, "name": r.name})).collect();
        Some(json!({"kind": self.kind, "view": self.view().id(), "rows": rows, "selected": self.selected.iter().collect::<Vec<_>>()}))
    }

    fn set_json_field(&mut self, ctx: &egui::Context, field: &str, value: Value) -> Result<(), String> {
        match field {
            "kind" => {
                let k = value.as_str().filter(|k| KINDS.iter().any(|(id, _)| id == k)).ok_or_else(|| {
                    format!("`kind` can't take {value}: one of {}", KINDS.iter().map(|(k, _)| *k).collect::<Vec<_>>().join(", "))
                })?;
                if k != self.kind {
                    self.kind = k.to_string();
                    self.selected.clear();
                    self.anchor = None;
                    self.queued.push(Ask::Kind);
                }
                Ok(())
            }
            "view" => {
                let v = value.as_str().and_then(View::parse).ok_or_else(|| {
                    format!("`view` can't take {value}: one of {}", View::ALL.iter().map(|v| v.id()).collect::<Vec<_>>().join(", "))
                })?;
                self.set_view(v);
                Ok(())
            }
            "selected" => {
                let list = value.as_array().ok_or("`selected` takes a list of row positions")?;
                let mut set = BTreeSet::new();
                for v in list {
                    let i = v.as_u64().and_then(|i| usize::try_from(i).ok()).filter(|&i| i < self.rows.len()).ok_or_else(|| format!("no row {v}"))?;
                    set.insert(i);
                }
                self.anchor = set.iter().next().copied();
                self.selected = set;
                Ok(())
            }
            // The footer and ⚙ menu, for agents: "load", "saveSet", "rename", "delete", "reset", "replace".
            "press" => {
                match value.as_str() {
                    Some("load") => self.press(ctx, LOAD),
                    Some("saveSet") => self.press(ctx, SAVE_SET),
                    Some("rename") => self.press(ctx, RENAME),
                    Some("delete") => self.press(ctx, DELETE),
                    Some("reset") if self.flag("canReset") => self.queued.push(Ask::Reset),
                    Some("replace") if self.kind != "adjustments" => self.queued.push(Ask::Replace),
                    _ => return Err(format!("`press` can't take {value}: load, saveSet, rename, delete, reset or replace")),
                }
                Ok(())
            }
            _ => Err(format!("unknown field `{field}`")),
        }
    }
}

// ------------------------------------------------------------------ the app side

/// The rows of `kind` with their thumbnails, and the kind's facts.
fn load_rows(app: &mut PhotocraftApp, ctx: &egui::Context, kind: &str) -> (Vec<Row>, Value) {
    let Ok(out) = app.session.execute(CMD, json!({"kind": kind})) else { return (Vec::new(), Value::Null) };
    let info = out["info"][kind].clone();
    let thumb_kind = info["thumb"].as_str().unwrap_or_default().to_string();
    let rows = info["rows"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|r| {
            let (group, name, key) = (r["group"].as_str().unwrap_or_default(), r["name"].as_str().unwrap_or_default(), r["key"].as_str().unwrap_or_default());
            Row { group: group.to_string(), name: name.to_string(), thumb: thumb(app, ctx, &thumb_kind, group, name, key, r["hint"].as_str()) }
        })
        .collect();
    (rows, info)
}

/// The thumbnail of one preset, read from the session.
fn thumb(app: &PhotocraftApp, ctx: &egui::Context, kind: &str, group: &str, name: &str, key: &str, hint: Option<&str>) -> Thumb {
    let s = &app.session;
    match kind {
        "swatch" => hint.and_then(|h| Color32::from_hex(h).ok()).map_or(Thumb::None, Thumb::Color),
        "gradient" => s
            .presets
            .gradients
            .iter()
            .filter(|g| g.name == group)
            .flat_map(|g| &g.items)
            .find(|g| g.name == name)
            .map_or(Thumb::None, |g| Thumb::Gradient(g.resolve(s.tools.foreground, s.tools.background).iter().map(|&(at, c)| (at, Srgba::new(c[0], c[1], c[2], c[3]))).collect())),
        "pattern" => s.patterns.items.iter().find(|p| p.id == key).map_or(Thumb::None, |p| Thumb::Texture(crate::panels::preset_browser::pattern_texture(ctx, p))),
        "style" => s.presets.styles.iter().flat_map(|g| &g.items).find(|st| st.name == name).map_or(Thumb::None, |st| {
            let cache = ("pigment-preset-manager-style", st.name.clone(), st.effects.len(), s.presets.rev);
            Thumb::Texture(TextureCache::texture(ctx, cache, || crate::panels::preset_browser::style_image(s, st)))
        }),
        "shape" => photocraft_engine::presets::shapes::all_groups(s)
            .iter()
            .filter(|g| g.name == group)
            .flat_map(|g| &g.items)
            .find(|sh| sh.name == name)
            .map_or(Thumb::None, |sh| {
                let cache = ("pigment-preset-manager-shape", sh.name.clone(), sh.path.subpaths.iter().map(|p| p.knots.len()).sum::<usize>());
                Thumb::Texture(TextureCache::texture(ctx, cache, || crate::panels::preset_browser::shape_image(sh)))
            }),
        "brush" => s.tools.presets.iter().find(|b| b.name == name).map_or(Thumb::None, |b| {
            let br = &b.brush;
            let sig = crate::panels::brush_preview::tip_sig(&br.tip, br.hardness, br.angle, br.roundness, (false, false));
            Thumb::Texture(TextureCache::texture(ctx, ("pigment-preset-manager-brush", sig), || {
                crate::panels::brush_preview::tip_image(&br.tip, (br.hardness, br.angle, br.roundness), 48, Color32::from_gray(170))
            }))
        }),
        "contour" => s
            .presets
            .contours
            .iter()
            .find_map(|c| match c {
                photocraft_doc::Contour::Custom { name: n, points, .. } if n == name => Some(Thumb::Curve(points.iter().map(|p| [p.input, p.output]).collect())),
                _ => None,
            })
            .unwrap_or(Thumb::None),
        "tool" => hint.and_then(crate::state::Tool::from_name).map_or(Thumb::Icon(IconId::new("settings")), |t| Thumb::Icon(crate::icons::tool_icon(t))),
        "adjustment" => Thumb::Icon(IconId::new("adjustments")),
        _ => Thumb::None,
    }
}

/// The revisions that change what the manager lists.
fn revision(app: &PhotocraftApp) -> (u64, u64) {
    (app.session.presets.rev, app.session.tools.presets_rev)
}

/// Opens the Preset Manager on Brushes (or the kind last shown).
pub(crate) fn open(app: &mut PhotocraftApp) -> DialogId {
    let ctx = app.ctx().clone();
    let kind = app.ui.presets_ui.selected.get("presetManager").cloned().filter(|k| KINDS.iter().any(|(id, _)| id == k)).unwrap_or_else(|| "brushes".into());
    let (rows, info) = load_rows(app, &ctx, &kind);
    let states = KINDS.iter().filter_map(|(k, _)| app.ui.presets_ui.browsers.get(&state_key(k)).map(|s| (k.to_string(), s.clone()))).collect();
    let dialog = PresetManagerDialog {
        id: dialog_id("pigment-preset-manager"),
        kind,
        rows,
        info,
        states,
        selected: BTreeSet::new(),
        anchor: None,
        rev: revision(app),
        queued: Vec::new(),
    };
    app.framework.dialogs.open(dialog)
}

/// Tags the Reset and Replace confirmations.
struct ManagerPrompt {
    kind: String,
    replace: bool,
}

/// Reads what the Preset Manager did since the last pass and runs it, then refreshes its rows when the libraries
/// changed.
pub(crate) fn take(app: &mut PhotocraftApp, ctx: &egui::Context) {
    let rev = revision(app);
    let Some(dialog) = app.framework.dialogs.get_mut::<PresetManagerDialog>() else { return };
    let asks = std::mem::take(&mut dialog.queued);
    let kind = dialog.kind.clone();
    let states = dialog.states.clone();
    let stale = dialog.rev != rev;
    for (k, state) in states {
        app.ui.presets_ui.browsers.insert(state_key(&k), state);
    }
    app.ui.presets_ui.selected.insert("presetManager".into(), kind.clone());
    let mut reload = stale || asks.contains(&Ask::Kind);
    for ask in asks {
        reload = true;
        if let Err(error) = run_ask(app, &kind, ask)
            && error != crate::file_dialog::CANCELLED
        {
            app.ui.status = error;
            app.ui.status_error = true;
        }
    }
    if reload {
        refresh(app, ctx);
    }
}

/// Reads the shown kind's rows again, keeping the selection where the rows still exist.
fn refresh(app: &mut PhotocraftApp, ctx: &egui::Context) {
    let Some(kind) = app.framework.dialogs.get_mut::<PresetManagerDialog>().map(|d| d.kind.clone()) else { return };
    let (rows, info) = load_rows(app, ctx, &kind);
    let rev = revision(app);
    if let Some(dialog) = app.framework.dialogs.get_mut::<PresetManagerDialog>() {
        let n = rows.len();
        dialog.rows = rows;
        dialog.info = info;
        dialog.rev = rev;
        dialog.selected.retain(|&i| i < n);
        dialog.anchor = dialog.anchor.filter(|&a| a < n);
    }
}

fn run_ask(app: &mut PhotocraftApp, kind: &str, ask: Ask) -> Result<Value, String> {
    match ask {
        Ask::Kind => Ok(Value::Null),
        Ask::Rename { index, text } => app.run(CMD, json!({"action": "rename", "kind": kind, "index": index, "newName": text})),
        Ask::Delete(indices) => {
            let r = app.run(CMD, json!({"action": "delete", "kind": kind, "indices": indices}));
            if r.is_ok()
                && let Some(d) = app.framework.dialogs.get_mut::<PresetManagerDialog>()
            {
                d.selected.clear();
                d.anchor = None;
            }
            r
        }
        Ask::Move(mut q) => {
            q["action"] = json!("move");
            q["kind"] = json!(kind);
            app.run(CMD, q)
        }
        Ask::Load => load(app, kind, false),
        Ask::Replace | Ask::Reset => {
            let label = kind_label(kind);
            let replace = ask == Ask::Replace;
            let (title, text) = if replace {
                (crate::i18n::fmt(tl!("Replace {kind}"), &[("kind", label)]), crate::i18n::fmt(tl!("Replace current {kind} with the presets from a file?"), &[("kind", label)]))
            } else {
                (crate::i18n::fmt(tl!("Reset {kind}"), &[("kind", label)]), crate::i18n::fmt(tl!("Replace current {kind} with the default {kind}?"), &[("kind", label)]))
            };
            let prompt = StandardPrompt::custom(text)
                .title(title)
                .button(PromptChoice::Proceed, tl!("OK"))
                .button(PromptChoice::Cancel, tl!("Cancel"))
                .tag(ManagerPrompt { kind: kind.to_string(), replace });
            app.framework.dialogs.open(prompt);
            Ok(Value::Null)
        }
        Ask::SaveSet(indices) => {
            let out = app.run(CMD, json!({"action": "saveSet", "kind": kind, "indices": indices}))?;
            let bytes = out["data"].as_str().and_then(photocraft_engine::paint::tile::b64_decode).ok_or("the presets could not be written")?;
            let file = out["fileName"].as_str().unwrap_or("Presets").to_string();
            let count = out["count"].as_u64().unwrap_or(0);
            app.pick_save(&file, move |app, path| {
                let write = app.services.write.as_mut().ok_or("no writer configured")?;
                write(&path, &bytes)?;
                app.ui.status_error = false;
                app.ui.status = crate::i18n::fmt(
                    &crate::i18n::trn(crate::i18n::current(), count, "Saved {n} preset to {file}", "Saved {n} presets to {file}"),
                    &[("file", &crate::file_open::display_name(&path))],
                );
                Ok(json!({"path": path, "count": count}))
            })
        }
    }
}

/// Load… (or Replace…) of `kind`: a file of the kind's extensions. Load… of a file File › Open imports goes through
/// `preset_files_ui::open`; the rest, and every Replace…, through the engine's `load`.
fn load(app: &mut PhotocraftApp, kind: &str, replace: bool) -> Result<Value, String> {
    let exts: Vec<String> = app
        .session
        .execute(CMD, json!({"kind": kind}))
        .ok()
        .and_then(|out| serde_json::from_value(out["info"][kind]["load"].clone()).ok())
        .unwrap_or_default();
    let filter: Vec<String> = exts.clone();
    let filter: Vec<&str> = filter.iter().map(String::as_str).collect();
    let kind = kind.to_string();
    app.pick_file_bytes_filtered(&filter, move |app, name, bytes| {
        let ext = std::path::Path::new(&name).extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
        if !exts.contains(&ext) {
            let file = crate::file_open::display_name(&name);
            return Err(crate::i18n::fmt(tl!("{file} holds no {kind}"), &[("file", &file), ("kind", kind_label(&kind))]));
        }
        if !replace && let Some(done) = crate::preset_files_ui::open(app, &name, &bytes) {
            return done.map(|()| Value::Null);
        }
        let file = crate::file_open::display_name(&name);
        let out = app.run(
            CMD,
            json!({"action": "load", "kind": kind, "data": photocraft_engine::paint::tile::b64_encode(&bytes), "fileName": file, "replace": replace}),
        )?;
        app.ui.status_error = false;
        app.ui.status = crate::i18n::fmt(tl!("Loaded {kind} from {file}"), &[("kind", kind_label(&kind)), ("file", &file)]);
        Ok(out)
    })
}

/// Answers the Reset and Replace confirmations: OK resets the kind, or picks the file whose presets replace it.
pub(crate) fn answer_prompt(app: &mut PhotocraftApp, ctx: &egui::Context, answer: &mut PromptAnswer) -> bool {
    let Some(prompt) = answer.take_tag::<ManagerPrompt>() else { return false };
    if answer.choice != PromptChoice::Proceed {
        return true;
    }
    let result = if prompt.replace { load(app, &prompt.kind, true) } else { app.run(CMD, json!({"action": "reset", "kind": prompt.kind})) };
    if let Err(error) = result
        && error != crate::file_dialog::CANCELLED
    {
        app.ui.status = error;
        app.ui.status_error = true;
    }
    refresh(app, ctx);
    true
}

/// File › Open and drag-and-drop of a preset file only the Preset Manager loads (contours, custom shapes, Photoshop's
/// adjustment presets): its presets join the library of their kind. `None` when `name` is not one.
pub(crate) fn open_file(app: &mut PhotocraftApp, name: &str, bytes: &[u8]) -> Option<Result<(), String>> {
    let ext = std::path::Path::new(name).extension().map(|e| e.to_string_lossy().to_ascii_lowercase())?;
    let kind = match ext.as_str() {
        "shc" => "contours",
        "csh" => "customShapes",
        "alv" | "acv" | "ahu" | "cha" | "asv" | "blw" => "adjustments",
        _ => return None,
    };
    let file = crate::file_open::display_name(name);
    let request = json!({"action": "load", "kind": kind, "data": photocraft_engine::paint::tile::b64_encode(bytes), "fileName": file});
    Some(app.run(CMD, request).map(|_| {
        app.ui.status_error = false;
        app.ui.status = crate::i18n::fmt(tl!("Loaded {kind} from {file}"), &[("kind", kind_label(kind)), ("file", &file)]);
    }))
}

#[cfg(test)]
#[path = "preset_manager_ui/tests.rs"]
mod tests;
