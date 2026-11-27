//! Pigment: the editors of Color and Vibrance, Clarity and Dehaze and Grain, framework slider tables
//! (`AdjustSliders`) over the rows the JavaScript Pigment had (`adjust-color.js` `fields`), and their
//! params. Grain's Seed is a row too, so an agent's or an action's seed can be seen and changed.

use craft::imaging::ui::adjust::{AdjustContext, AdjustField, AdjustSliders};
use craft::ui::contract::Bind;
use egui::Ui;
use serde_json::{Map, Value, json};

use super::{AdjustOut, AdjustValue, lifted};

/// The three kinds.
pub const KINDS: [&str; 3] = ["colorVibrance", "clarityDehaze", "grain"];

/// The menu item each of the three follows: in Image › Adjustments after Selective Color…, in Layer › New
/// Adjustment Layer after Color Lookup… (where the JavaScript Pigment's `LAYER_ADJUSTMENTS` put them), in this order.
pub fn place_after(id: &str) -> Option<&'static str> {
    Some(match id {
        "image.adjustments.colorVibrance" => "image.adjustments.selectiveColor",
        "image.adjustments.clarityDehaze" => "image.adjustments.colorVibrance",
        "image.adjustments.grain" => "image.adjustments.clarityDehaze",
        "layer.newAdjustmentLayer.colorVibrance" => "layer.newAdjustmentLayer.colorLookup",
        "layer.newAdjustmentLayer.clarityDehaze" => "layer.newAdjustmentLayer.colorVibrance",
        "layer.newAdjustmentLayer.grain" => "layer.newAdjustmentLayer.clarityDehaze",
        _ => return None,
    })
}

/// The rows of `kind`: (engine key, English label, range, default).
fn rows(kind: &str) -> &'static [(&'static str, &'static str, f64, f64, f64)] {
    match kind {
        "colorVibrance" => &[
            ("temperature", "Temperature", -100.0, 100.0, 0.0),
            ("tint", "Tint", -100.0, 100.0, 0.0),
            ("vibrance", "Vibrance", -100.0, 100.0, 0.0),
            ("saturation", "Saturation", -100.0, 100.0, 0.0),
        ],
        "clarityDehaze" => &[("clarity", "Clarity", -100.0, 100.0, 0.0), ("dehaze", "Dehaze", -100.0, 100.0, 0.0)],
        "grain" => &[
            ("amount", "Amount", 0.0, 100.0, 0.0),
            ("size", "Size", 0.0, 100.0, 25.0),
            ("roughness", "Roughness", 0.0, 100.0, 50.0),
            ("seed", "Seed", 1.0, 99_999.0, 1.0),
        ],
        _ => &[],
    }
}

/// The slider rows of `kind`, labels in the interface's language.
pub fn fields(kind: &str) -> Vec<AdjustField> {
    rows(kind).iter().map(|&(key, label, lo, hi, default)| AdjustField::new(key, tl!(label), lo..=hi, default).step(1.0)).collect()
}

/// The dialog title of `kind`.
fn title(kind: &str) -> &'static str {
    match kind {
        "colorVibrance" => tl!("Color and Vibrance"),
        "clarityDehaze" => tl!("Clarity and Dehaze"),
        _ => tl!("Grain"),
    }
}

fn wrap(kind: &str, values: Vec<f64>) -> AdjustValue {
    match kind {
        "colorVibrance" => AdjustValue::ColorVibrance { values },
        "clarityDehaze" => AdjustValue::ClarityDehaze { values },
        _ => AdjustValue::Grain { values },
    }
}

/// The value of `kind` from the engine's complete params `v`.
pub fn value(kind: &str, v: &Value) -> AdjustValue {
    wrap(kind, rows(kind).iter().map(|(key, _, _, _, default)| v.get(*key).and_then(Value::as_f64).unwrap_or(*default)).collect())
}

/// `value`'s kind and rows, when it is one of the three.
pub fn parts(value: &AdjustValue) -> Option<(&'static str, &[f64])> {
    match value {
        AdjustValue::ColorVibrance { values } => Some(("colorVibrance", values)),
        AdjustValue::ClarityDehaze { values } => Some(("clarityDehaze", values)),
        AdjustValue::Grain { values } => Some(("grain", values)),
        _ => None,
    }
}

/// Writes `value`'s rows into `out` (the seed as a whole number).
pub fn write(value: &AdjustValue, out: &mut Map<String, Value>) {
    let Some((kind, values)) = parts(value) else { return };
    for ((key, ..), x) in rows(kind).iter().zip(values) {
        out.insert((*key).into(), if *key == "seed" { json!(x.round()) } else { json!(x) });
    }
}

/// The editor of one of the three kinds for one pass.
pub fn show(kind: &str, ui: &mut Ui, value: &mut AdjustValue, context: AdjustContext) -> AdjustOut {
    let values = match value {
        AdjustValue::ColorVibrance { values } | AdjustValue::ClarityDehaze { values } | AdjustValue::Grain { values } => values,
        _ => return AdjustOut::default(),
    };
    let fields = fields(kind);
    let out = AdjustSliders::new(title(kind), &fields, Bind::bound(values)).context(context).show(ui);
    let kind = kind.to_owned();
    lifted(out.events, move |values| wrap(&kind, values))
}

#[cfg(test)]
mod tests;
