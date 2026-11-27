//! Pigment: the Gradient Editor's noise controls (P3): Gradient Type (Solid or Noise) and, for a noise gradient,
//! Roughness, Color Model, each channel's range, Restrict Colors, Add Transparency and Randomize. The framework's stop
//! bar has no noise mode, so these rows are Pigment's own, above it.
//!
//! Every change is one command, on commit: `gradient.presets.stop {"action": "set", "noise": …}` for the Gradient
//! tool's gradient, `gradient.fill.set {"layer", "noise": …}` for a gradient fill layer (one history step). A drag
//! shows through egui's memory until it lands.

use craft::behavior::{EditEvent, EditEvents, Mixed};
use craft::ui::buttons::Button;
use craft::ui::choice::{Checkbox, Segmented};
use craft::ui::contract::{Bind, Entry, Props as _, Show as _, ShowContainer as _};
use craft::ui::form::{Field, SliderField};
use craft::ui::pickers::Select;
use craft::ui::runtime::env::{Label, UnitKind};
use craft::ui::value_drag::RangeSlider;
use photocraft_doc::{LayerId, NoiseGradient, NoiseModel};
use serde_json::{Value, json};

use super::cmds;
use crate::PhotocraftApp;

/// The gradient the rows edit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Target {
    /// The Gradient tool's current gradient.
    Tool,
    /// A gradient fill layer.
    Layer(LayerId),
}

/// The edited gradient's noise settings, when it is a noise gradient.
fn current(app: &PhotocraftApp, target: Target) -> Option<NoiseGradient> {
    match target {
        Target::Tool => app.session.presets.gradient.noise.clone(),
        Target::Layer(id) => {
            let layer = app.session.active()?.doc.layer(id)?;
            match super::fill_of(layer)? {
                photocraft_doc::Fill::Gradient { noise, .. } => noise.clone(),
                _ => None,
            }
        }
    }
}

/// Runs the command that sets `noise` (settings, or `false` for solid) on `target`.
pub(super) fn apply(app: &mut PhotocraftApp, target: Target, noise: Value) {
    let (cmd, params) = match target {
        Target::Tool => (photocraft_engine::presets::gradients::STOP, json!({"action": "set", "noise": noise})),
        Target::Layer(id) => (cmds::SET, json!({"layer": id.0, "noise": noise})),
    };
    if let Err(error) = app.run(cmd, params) {
        app.ui.status = error;
        app.ui.status_error = true;
    }
}

/// The next seed Randomize picks: a step of the gradient's own generator, so it looks random and tests can tell.
pub(super) fn next_seed(seed: u32) -> u32 {
    let mut t = seed.wrapping_add(0x6d2b_79f5);
    t = (t ^ (t >> 15)).wrapping_mul(t | 1);
    t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
    t ^ (t >> 14)
}

/// The value a row shows: the one a drag in progress holds (kept in egui's memory under `id`), else `value`; and,
/// after the row's events, the value it committed this pass.
fn gesture<T: Clone + Send + Sync + 'static>(ui: &mut egui::Ui, id: egui::Id, value: T, show: impl FnOnce(&mut egui::Ui, T) -> EditEvents<T>) -> Option<T> {
    let shown = ui.data(|d| d.get_temp::<T>(id)).unwrap_or(value);
    let events = show(ui, shown);
    let mut landed = None;
    for event in events.iter() {
        match event {
            EditEvent::Update { value, .. } => {
                ui.data_mut(|d| d.insert_temp(id, value.clone()));
            }
            EditEvent::Commit { after, .. } | EditEvent::Set { after, .. } => {
                ui.data_mut(|d| d.remove::<T>(id));
                landed = Some(after.clone());
            }
            EditEvent::Cancel { .. } => {
                ui.data_mut(|d| d.remove::<T>(id));
            }
            _ => {}
        }
    }
    landed
}

/// The names of a model's three channels.
fn channels(model: NoiseModel) -> [&'static str; 3] {
    match model {
        NoiseModel::Rgb => [tl!("R"), tl!("G"), tl!("B")],
        NoiseModel::Hsb => [tl!("H"), tl!("S"), tl!("B")],
        NoiseModel::Lab => [tl!("L"), tl!("a"), tl!("b")],
    }
}

/// The Gradient Type row and, for a noise gradient, its settings. Returns whether the gradient is a noise gradient
/// (the caller then hides the stop bar where it can).
pub(super) fn show(app: &mut PhotocraftApp, ui: &mut egui::Ui, target: Target) -> bool {
    let noise = current(app, target);
    let salt = match target {
        Target::Tool => ("pigment.noise", 0),
        Target::Layer(id) => ("pigment.noise", id.0),
    };
    let mut edits: Vec<Value> = Vec::new();
    ui.push_id(salt, |ui| {
        let kinds = [Entry::new(false, Label::from(tl!("Solid"))), Entry::new(true, Label::from(tl!("Noise")))];
        if let Some(&noisy) = Segmented::new(Label::from(tl!("Gradient Type:")), Bind::given(noise.is_some()), &kinds).id_salt("type").show(ui).value()
            && noisy != noise.is_some()
        {
            edits.push(if noisy { NoiseGradient::default().to_json() } else { json!(false) });
        }
        let Some(n) = &noise else { return };
        let rough = f64::from((n.roughness * 100.0).round());
        let id = ui.scope_id().with("roughness");
        if let Some(r) = gesture(ui, id, rough, |ui, v| {
            SliderField::new(tl!("Roughness:"), Bind::given(v).reset(50.0), 0.0..=100.0).unit_kind(UnitKind::Percent).show(ui).events.clone()
        }) {
            edits.push(json!({"roughness": r}));
        }
        let models = [
            Entry::new(NoiseModel::Rgb.name().to_string(), Label::from(tl!("RGB"))),
            Entry::new(NoiseModel::Hsb.name().to_string(), Label::from(tl!("HSB"))),
            Entry::new(NoiseModel::Lab.name().to_string(), Label::from(tl!("LAB"))),
        ];
        let mut model = None;
        Field::new(tl!("Color Model:").to_string()).id_salt("model-field").show(ui, |ui, _| {
            model = Select::new(tl!("Color Model:").to_string(), Bind::given(n.model.name().to_string()), &models).id_salt("model").show(ui).value().cloned();
        });
        if let Some(m) = model
            && m != n.model.name()
        {
            edits.push(json!({"model": m}));
        }
        for (c, name) in channels(n.model).into_iter().enumerate() {
            let pct = |v: f32| f64::from((v * 100.0).round());
            let pair = (Mixed::Same(pct(n.min[c])), Mixed::Same(pct(n.max[c])));
            let id = ui.scope_id().with(("channel", c));
            let mut landed = None;
            Field::new(name.to_string()).id_salt(("channel-field", c)).show(ui, |ui, _| {
                landed = gesture(ui, id, pair, |ui, v| RangeSlider::new(Bind::given(v), 0.0..=100.0).label(name).show(ui).events.clone());
            });
            if let Some((lo, hi)) = landed {
                let (mut min, mut max) = (n.min.map(|v| f64::from(v) * 100.0), n.max.map(|v| f64::from(v) * 100.0));
                if let (Some(lo), Some(hi)) = (lo.same(), hi.same()) {
                    min[c] = *lo;
                    max[c] = *hi;
                    edits.push(json!({"min": min, "max": max}));
                }
            }
        }
        for (key, label, on) in [("restrict", tl!("Restrict Colors"), n.restrict), ("transparency", tl!("Add Transparency"), n.transparency)] {
            if let Some(&v) = Checkbox::new(Bind::given(on)).label(label).id_salt(key).show(ui).events.landed()
                && v != on
            {
                edits.push(json!({ key: v }));
            }
        }
        if Button::new(tl!("Randomize")).show(ui).clicked() {
            edits.push(json!({"seed": next_seed(n.seed)}));
        }
    });
    let noisy = noise.is_some();
    for edit in edits {
        apply(app, target, edit);
    }
    noisy
}

#[cfg(test)]
mod tests;
