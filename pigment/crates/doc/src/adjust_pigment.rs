//! Pigment: the JavaScript Pigment's (0.1–0.4) Color and Vibrance, Clarity and Dehaze and Grain
//! (`color-vibrance`, `clarity-dehaze`, `grain`, `shared/pixels/adjust-color.js`) as
//! [`Adjustment`]s, read the way the app read their params: a missing or non-number value takes
//! the app's default, numbers are clamped to its ranges.
//!
//! Before these kinds existed here, the `.pigment` importer kept such a layer as an
//! [`Adjustment::Unsupported`] block with the key [`UNSUPPORTED_KEY`] (`pcJS`) and the raw JSON
//! `{"kind", "params"}`; a document opened that way and saved (PSD or `.pcraft`) still holds it.
//! [`upgrade`] turns such a block into the live adjustment; the PSD importer and the native
//! loader call it.

use serde_json::{Map, Value};

use crate::Adjustment;

/// The private block key the `.pigment` importer kept unknown adjustments under.
pub const UNSUPPORTED_KEY: &str = "pcJS";

fn val(p: &Map<String, Value>, key: &str, default: f64, lo: f64, hi: f64) -> f32 {
    p.get(key).and_then(Value::as_f64).filter(|n| n.is_finite()).unwrap_or(default).clamp(lo, hi) as f32
}

/// The adjustment of a JavaScript Pigment layer of `kind` with `params`, for the three kinds.
pub fn from_js(kind: &str, params: &Value) -> Option<Adjustment> {
    let empty = Map::new();
    let p = params.as_object().unwrap_or(&empty);
    Some(match kind {
        "color-vibrance" => Adjustment::ColorVibrance {
            temperature: val(p, "temperature", 0.0, -100.0, 100.0),
            tint: val(p, "tint", 0.0, -100.0, 100.0),
            vibrance: val(p, "vibrance", 0.0, -100.0, 100.0),
            saturation: val(p, "saturation", 0.0, -100.0, 100.0),
        },
        "clarity-dehaze" => Adjustment::ClarityDehaze { clarity: val(p, "clarity", 0.0, -100.0, 100.0), dehaze: val(p, "dehaze", 0.0, -100.0, 100.0) },
        "grain" => Adjustment::Grain {
            amount: val(p, "amount", 0.0, 0.0, 100.0),
            size: val(p, "size", 25.0, 0.0, 100.0),
            roughness: val(p, "roughness", 50.0, 0.0, 100.0),
            seed: 1,
        },
        _ => return None,
    })
}

/// The live adjustment an `Unsupported` `pcJS` block of one of the three kinds stands for; `None`
/// for anything else (which stays as it is).
pub fn upgrade(adj: &Adjustment) -> Option<Adjustment> {
    let Adjustment::Unsupported { psd_key, raw } = adj else { return None };
    if psd_key != UNSUPPORTED_KEY || raw.len() > 1 << 20 {
        return None;
    }
    // A PSD pads its blocks with zeros.
    let end = raw.iter().rposition(|b| !matches!(b, 0 | b' ' | b'\n' | b'\r' | b'\t')).map_or(0, |i| i + 1);
    let v: Value = serde_json::from_slice(&raw[..end]).ok()?;
    from_js(v.get("kind")?.as_str()?, v.get("params").unwrap_or(&Value::Null))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(json: &str) -> Adjustment {
        Adjustment::Unsupported { psd_key: UNSUPPORTED_KEY.into(), raw: json.as_bytes().into() }
    }

    #[test]
    fn pcjs_blocks_of_the_three_kinds_become_live() {
        assert_eq!(
            upgrade(&block(r#"{"kind":"grain","params":{"amount":35,"size":"x","roughness":250}}"#)),
            Some(Adjustment::Grain { amount: 35.0, size: 25.0, roughness: 100.0, seed: 1 })
        );
        assert_eq!(upgrade(&block(r#"{"kind":"clarity-dehaze","params":{"clarity":-30}}"#)), Some(Adjustment::ClarityDehaze { clarity: -30.0, dehaze: 0.0 }));
        assert_eq!(
            upgrade(&block(r#"{"kind":"color-vibrance","params":{"temperature":18,"vibrance":10}}"#)),
            Some(Adjustment::ColorVibrance { temperature: 18.0, tint: 0.0, vibrance: 10.0, saturation: 0.0 })
        );
        assert_eq!(upgrade(&block(r#"{"kind":"grain"}"#)), Some(Adjustment::Grain { amount: 0.0, size: 25.0, roughness: 50.0, seed: 1 }));
        // A PSD block padded with zeros.
        assert_eq!(upgrade(&block("{\"kind\":\"clarity-dehaze\"}\0\0\0")), Some(Adjustment::ClarityDehaze { clarity: 0.0, dehaze: 0.0 }));
        // Unknown kinds, other keys, damaged JSON and live adjustments stay.
        for keep in [
            block(r#"{"kind":"shadows-highlights","params":{}}"#),
            block("{not json"),
            block(r#"{"params":{}}"#),
            Adjustment::Unsupported { psd_key: "abcd".into(), raw: br#"{"kind":"grain"}"#.as_slice().into() },
            Adjustment::Invert,
        ] {
            assert_eq!(upgrade(&keep), None, "{keep:?}");
        }
    }
}
