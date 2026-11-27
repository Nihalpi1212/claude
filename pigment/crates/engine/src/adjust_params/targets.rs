//! Pigment: the target colours of the Levels and Curves eyedroppers (Photoshop's Auto Color Correction Options ›
//! Target Colors, also set by double-clicking an eyedropper). Set Black Point maps the sample to the shadow target in
//! each channel, Set White Point to the highlight target; Set Neutral Gray Point with a coloured midtone target maps
//! the sample to that colour instead of to a neutral of its own brightness. With Photoshop's default targets (black,
//! a neutral grey, white) the eyedroppers are upstream's, unchanged.

use photocraft_algo::tone::auto_options::AutoOptions;
use photocraft_color::ColorMode;
use photocraft_doc::Adjustment;
use serde_json::{Value, json};

use super::{CurvesEyedropper, Result, adjustment_eyedropper, anchor_curve, bad, check_eyedropper, from_params, inverse_master_target, set_levels_gamma};

/// The three target colours, RGB in 0..=1.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Targets {
    pub shadow: [f32; 3],
    pub midtone: [f32; 3],
    pub highlight: [f32; 3],
}

impl Default for Targets {
    fn default() -> Self {
        Targets::of(&AutoOptions::default())
    }
}

impl Targets {
    /// The targets of Auto Color Correction Options.
    pub fn of(o: &AutoOptions) -> Targets {
        let f = |c: [u8; 3]| c.map(|v| f32::from(v) / 255.0);
        Targets { shadow: f(o.shadow), midtone: f(o.midtone), highlight: f(o.highlight) }
    }

    /// Black shadows, white highlights and a neutral midtone: the eyedroppers need no targets.
    pub fn neutral(&self) -> bool {
        self.shadow == [0.0; 3] && self.highlight == [1.0; 3] && self.midtone[0] == self.midtone[1] && self.midtone[1] == self.midtone[2]
    }

    /// As `{"shadow","midtone","highlight"}` `#rrggbb` (the `eyedropper.targets` param).
    pub fn to_json(&self) -> Value {
        let hex = |c: [f32; 3]| {
            let b = c.map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8);
            format!("#{:02x}{:02x}{:02x}", b[0], b[1], b[2])
        };
        json!({"shadow": hex(self.shadow), "midtone": hex(self.midtone), "highlight": hex(self.highlight)})
    }
}

/// Rec. 601 luma: a target colour in a Grayscale document (the JavaScript app's `sampleInSpace('gray')`).
fn luma(c: [f32; 3]) -> f32 {
    0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
}

/// The targets an eyedropper param `e` uses: its `targets` (`{"shadow","midtone","highlight"}` `#rrggbb`, each
/// optional), over the ones saved in Auto Color Correction Options.
pub fn of_param(s: &crate::Session, e: &Value) -> Result<Targets> {
    let saved = Targets::of(&crate::cmd::auto_options_cmds::current(s));
    let Some(t) = e.get("targets").filter(|t| !t.is_null()) else { return Ok(saved) };
    let obj = t.as_object().ok_or_else(|| bad("eyedropper", "`eyedropper.targets` must be {\"shadow\",\"midtone\",\"highlight\"}"))?;
    let read = |key: &str, fallback: [f32; 3]| -> Result<[f32; 3]> {
        match obj.get(key) {
            None | Some(Value::Null) => Ok(fallback),
            Some(v) => v
                .as_str()
                .and_then(crate::prefs::parse_hex)
                .map(|c| c.map(|x| f32::from(x) / 255.0))
                .ok_or_else(|| bad("eyedropper", format!("`eyedropper.targets.{key}` must be a #rrggbb colour"))),
        }
    };
    Ok(Targets { shadow: read("shadow", saved.shadow)?, midtone: read("midtone", saved.midtone)?, highlight: read("highlight", saved.highlight)? })
}

/// [`adjustment_eyedropper`] with target colours: upstream's eyedropper, then the output ends moved to the targets
/// (Black/White), or each channel anchored at the midtone target's channel (Neutral Gray with a coloured target).
pub fn adjustment_eyedropper_with(kind: &str, base: &Value, picker: CurvesEyedropper, sample: [f32; 3], mode: ColorMode, t: &Targets) -> Result<Adjustment> {
    if t.neutral() || !t.shadow.iter().chain(&t.midtone).chain(&t.highlight).all(|v| v.is_finite()) {
        return adjustment_eyedropper(kind, base, picker, sample, mode);
    }
    let coloured_midtone = t.midtone[0] != t.midtone[1] || t.midtone[1] != t.midtone[2];
    if picker == CurvesEyedropper::NeutralGray && mode == ColorMode::Rgb && coloured_midtone {
        return coloured_gray(kind, base, sample, t.midtone.map(|v| v.clamp(0.0, 1.0)));
    }
    let mut adj = adjustment_eyedropper(kind, base, picker, sample, mode)?;
    if picker == CurvesEyedropper::NeutralGray {
        return Ok(adj);
    }
    let black = picker == CurvesEyedropper::Black;
    let target = if black { t.shadow } else { t.highlight }.map(|v| v.clamp(0.0, 1.0));
    let sample = sample.map(|v| v.clamp(0.0, 1.0));
    match &mut adj {
        Adjustment::Levels { master, per_channel, .. } => {
            if mode == ColorMode::Grayscale {
                set_out(master, luma(target), black);
            } else {
                for (c, v) in per_channel.iter_mut().zip(target) {
                    set_out(c, v, black);
                }
            }
        }
        Adjustment::Curves { master, per_channel, .. } => {
            let end = |curve: &mut Vec<photocraft_doc::adjust::CurvePoint>, at: f32, v: f32| {
                let point = if black { curve.first_mut() } else { curve.last_mut() };
                // Only where the eyedropper put the end point at the sample (it keeps a plateau instead when moving
                // the end would merge points: that case keeps its outputs).
                if let Some(p) = point.filter(|p| (p.input - at).abs() < 1e-3) {
                    p.output = v;
                }
            };
            if mode == ColorMode::Grayscale {
                end(master, (sample[0] + sample[1] + sample[2]) / 3.0, luma(target));
            } else {
                for ((curve, at), v) in per_channel.iter_mut().zip(sample).zip(target) {
                    end(curve, at, v);
                }
            }
        }
        _ => {}
    }
    Ok(adj)
}

fn set_out(c: &mut photocraft_doc::adjust::LevelsChannel, v: f32, black: bool) {
    if black {
        c.out_black = v;
    } else {
        c.out_white = v;
    }
}

/// Set Neutral Gray Point with a coloured midtone target: each channel maps the sample's value to the target's
/// (Levels: the channel's gamma; Curves: a point), so the sample takes the target colour.
fn coloured_gray(kind: &str, base: &Value, sample: [f32; 3], target: [f32; 3]) -> Result<Adjustment> {
    const CMD: &str = "eyedropper";
    check_eyedropper(CMD, CurvesEyedropper::NeutralGray, sample, ColorMode::Rgb)?;
    let sample = sample.map(|v| v.clamp(0.0, 1.0));
    match kind {
        "levels" => {
            let mut adj = from_params("levels", base, None, ColorMode::Rgb)?;
            if let Adjustment::Levels { per_channel, .. } = &mut adj {
                for ((c, v), t) in per_channel.iter_mut().zip(sample).zip(target) {
                    set_levels_gamma(c, v, t);
                }
            }
            Ok(adj)
        }
        "curves" => {
            let mut base = base.clone();
            if let Some(o) = base.as_object_mut() {
                o.remove("smooth");
                if o.get("pencil").and_then(Value::as_bool) == Some(true) {
                    o.insert("pencil".into(), json!(false));
                }
            }
            let mut adj = from_params("curves", &base, None, ColorMode::Rgb)?;
            if let Adjustment::Curves { master, per_channel, .. } = &mut adj {
                for ((curve, v), t) in per_channel.iter_mut().zip(sample).zip(target) {
                    anchor_curve(curve, v, inverse_master_target(master, t));
                }
            }
            Ok(adj)
        }
        _ => Err(bad(CMD, "`eyedropper` applies to Levels and Curves only")),
    }
}

#[cfg(test)]
mod tests;
