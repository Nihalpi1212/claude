//! Pigment: the params of Color and Vibrance, Clarity and Dehaze and Grain (`colorVibrance`,
//! `clarityDehaze`, `grain`), as `image.adjustments.*`, `layer.newAdjustmentLayer.*` and
//! `layer.setAdjustment` take them. Ranges are the JavaScript Pigment's.

use photocraft_doc::Adjustment;
use serde_json::{Value, json};

use super::Reader;
use crate::Result;

/// The adjustment of `kind` read from `r` over `base` (or the kind's defaults).
pub(super) fn from_params(kind: &str, r: &Reader, base: Option<&Adjustment>) -> Result<Adjustment> {
    Ok(match kind {
        "colorVibrance" => {
            let (t, n, v, s) = match base {
                Some(Adjustment::ColorVibrance { temperature, tint, vibrance, saturation }) => (*temperature, *tint, *vibrance, *saturation),
                _ => (0.0, 0.0, 0.0, 0.0),
            };
            Adjustment::ColorVibrance {
                temperature: r.num("temperature", t, -100.0, 100.0)?,
                tint: r.num("tint", n, -100.0, 100.0)?,
                vibrance: r.num("vibrance", v, -100.0, 100.0)?,
                saturation: r.num("saturation", s, -100.0, 100.0)?,
            }
        }
        "clarityDehaze" => {
            let (c, d) = match base {
                Some(Adjustment::ClarityDehaze { clarity, dehaze }) => (*clarity, *dehaze),
                _ => (0.0, 0.0),
            };
            Adjustment::ClarityDehaze { clarity: r.num("clarity", c, -100.0, 100.0)?, dehaze: r.num("dehaze", d, -100.0, 100.0)? }
        }
        _ => {
            let (a, z, g, s) = match base {
                Some(Adjustment::Grain { amount, size, roughness, seed }) => (*amount, *size, *roughness, *seed),
                _ => (0.0, 25.0, 50.0, 1),
            };
            Adjustment::Grain {
                amount: r.num("amount", a, 0.0, 100.0)?,
                size: r.num("size", z, 0.0, 100.0)?,
                roughness: r.num("roughness", g, 0.0, 100.0)?,
                seed: r.num("seed", s.clamp(1, 99_999) as f32, 1.0, 99_999.0)?.round() as u32,
            }
        }
    })
}

/// The complete params of one of the three kinds (`None` for any other).
pub fn to_params(adj: &Adjustment) -> Option<Value> {
    Some(match adj {
        Adjustment::ColorVibrance { temperature, tint, vibrance, saturation } => {
            json!({"temperature": temperature, "tint": tint, "vibrance": vibrance, "saturation": saturation})
        }
        Adjustment::ClarityDehaze { clarity, dehaze } => json!({"clarity": clarity, "dehaze": dehaze}),
        Adjustment::Grain { amount, size, roughness, seed } => json!({"amount": amount, "size": size, "roughness": roughness, "seed": seed}),
        _ => return None,
    })
}

/// The engine kinds of the three, with their JavaScript Pigment names.
pub const KINDS: [(&str, &str); 3] = [("colorVibrance", "color-vibrance"), ("clarityDehaze", "clarity-dehaze"), ("grain", "grain")];

#[cfg(test)]
mod tests;
