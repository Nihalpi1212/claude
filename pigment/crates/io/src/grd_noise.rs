//! Pigment: Photoshop's noise gradients (Gradient Type: Noise) in the files that store them, as
//! [`NoiseGradient`]s.
//!
//! - **Descriptors** (`GdFl` gradient fills, the `Grad` of Gradient Overlay, glows and gradient
//!   strokes, `.grd` gradient files): the `Grdn` object has `GrdF` = `ClNs` and `ShTr` (Add
//!   Transparency), `VctC` (Restrict Colors), `ClrS` (colour model `RGBC`, `HSBl`, `LbCl`), `RndS`
//!   (seed), `Smth` (roughness, 0..4096) and `Mnm ` / `Mxm ` (four longs 0..100 each), and no
//!   colour stops.
//! - **`grdm`** (Gradient Map): after the stops, the gradient's 32 bytes of noise settings: mode
//!   (1 = noise), seed (u32), show transparency and restrict colours (u16 each), roughness (u32,
//!   4096ths), colour model (u16: 3 RGB, 4 HSB, 6 Lab), then the minimum and maximum (four u16 each,
//!   0..32768).
//!
//! `craft_psd::grd` reads only the noise flag, so `.grd` files are read again here with
//! `craft_psd::descriptor` (rather than a craft-libs change). A noise gradient renders through its
//! bake (see [`photocraft_doc::noise_gradient`]); one whose settings do not parse keeps
//! upstream's handling (the placeholder ramp and the raw block, #6272).

use craft_psd::descriptor::{Descriptor, Id, UnicodeString, Value, VersionedDescriptor};
use craft_psd::grd::GrdGradient;
use photocraft_color::Color;
use photocraft_doc::adjust::GradientSource;
use photocraft_doc::{Adjustment, NoiseGradient, NoiseModel};

use crate::blocks::{enum_of, num};

/// The noise settings of a `Grdn` gradient object, when it is a noise gradient (`GrdF` = `ClNs`)
/// in a colour model PhotoCraft draws. Missing settings take Photoshop's defaults.
pub fn noise_from_grad(g: &Descriptor) -> Option<NoiseGradient> {
    if enum_of(g, "GrdF")? != b"ClNs" {
        return None;
    }
    let model = match enum_of(g, "ClrS") {
        None | Some(b"RGBC") => NoiseModel::Rgb,
        Some(b"HSBl") => NoiseModel::Hsb,
        Some(b"LbCl") => NoiseModel::Lab,
        // HSL and anything else: not a model the walk knows.
        Some(_) => return None,
    };
    let four = |key: &str, default: f32| -> Option<[f32; 4]> {
        match g.get(key) {
            None => Some([default; 4]),
            Some(Value::List(items)) if items.len() == 4 => {
                let mut out = [default; 4];
                for (slot, v) in out.iter_mut().zip(items) {
                    *slot = (num(Some(v)).filter(|v| v.is_finite())? / 100.0).clamp(0.0, 1.0) as f32;
                }
                Some(out)
            }
            Some(_) => None,
        }
    };
    let flag = |key: &str| matches!(g.get(key), Some(Value::Boolean(true)));
    Some(NoiseGradient {
        roughness: num(g.get("Smth")).filter(|v| v.is_finite()).map_or(0.5, |v| (v / 4096.0).clamp(0.0, 1.0) as f32),
        model,
        min: four("Mnm ", 0.0)?,
        max: four("Mxm ", 1.0)?,
        restrict: flag("VctC"),
        transparency: flag("ShTr"),
        seed: num(g.get("RndS")).map_or(0, photocraft_doc::noise_gradient::seed_of),
    })
}

/// A `Grdn` object for a noise gradient named `name`.
pub fn noise_grad_desc(n: &NoiseGradient, name: &str) -> Descriptor {
    let n = n.sanitized();
    let longs = |v: [f32; 4]| Value::List(v.into_iter().map(|x| Value::Integer((x * 100.0).round() as i32)).collect());
    let model = match n.model {
        NoiseModel::Rgb => "RGBC",
        NoiseModel::Hsb => "HSBl",
        NoiseModel::Lab => "LbCl",
    };
    Descriptor::new("Grdn")
        .with("Nm  ", Value::Text(UnicodeString::new_nul(name)))
        .with("GrdF", Value::Enumerated { type_id: Id::new("GrdF"), value: Id::new("ClNs") })
        .with("ShTr", Value::Boolean(n.transparency))
        .with("VctC", Value::Boolean(n.restrict))
        .with("ClrS", Value::Enumerated { type_id: Id::new("ClrS"), value: Id::new(model) })
        // A long: the seed's bits.
        .with("RndS", Value::Integer(n.seed as i32))
        .with("Smth", Value::Integer((n.roughness * 4096.0).round() as i32))
        .with("Mnm ", longs(n.min))
        .with("Mxm ", longs(n.max))
}

/// The `Grad` object to write: the noise gradient's when there is one, else `stops()`.
pub fn grad_or_noise(noise: Option<&NoiseGradient>, stops: impl FnOnce() -> Descriptor) -> Descriptor {
    match noise {
        Some(n) => noise_grad_desc(n, "Custom"),
        None => stops(),
    }
}

/// A gradient fill's or effect's colour and opacity stops from its `Grad` object, when that is a
/// noise gradient: they become its bake, and the settings come back.
pub fn noise_stops(grad: Option<&Descriptor>, stops: &mut Vec<(f32, Color)>, opacity: &mut Vec<(f32, f32)>) -> Option<NoiseGradient> {
    let n = noise_from_grad(grad?)?;
    (*stops, *opacity) = n.fill_stops();
    Some(n)
}

/// The noise settings of each gradient of a `.grd` file, in the order `craft_psd::grd::parse`
/// returns them (`None` for a solid gradient or unreadable settings; empty when the file does not
/// parse).
pub fn grd_noise(data: &[u8]) -> Vec<Option<NoiseGradient>> {
    let Some(body) = data.get(6..).filter(|_| data.starts_with(b"8BGR")) else { return Vec::new() };
    let Ok((vd, _)) = VersionedDescriptor::parse_prefix(body) else { return Vec::new() };
    let Some(Value::List(items)) = vd.descriptor.get("GrdL") else { return Vec::new() };
    items
        .iter()
        .take(craft_psd::grd::MAX_GRADIENTS)
        // The same items `craft_psd::grd::parse` keeps (a `Grad` object or global object), so
        // the settings stay beside their gradient.
        .filter_map(|v| match v {
            Value::Descriptor(d) => d.get_object("Grad").map(noise_from_grad),
            _ => None,
        })
        .collect()
}

/// `craft_psd::grd::write` with the noise settings of the gradients that have them (`noise[i]`
/// for `grads[i]`).
pub fn write_grd(grads: &[GrdGradient], noise: &[Option<NoiseGradient>]) -> Vec<u8> {
    let plain = craft_psd::grd::write(grads);
    if noise.iter().all(Option::is_none) {
        return plain;
    }
    let Some(Ok((mut vd, _))) = plain.get(6..).map(VersionedDescriptor::parse_prefix) else { return plain };
    if let Some((_, Value::List(items))) = vd.descriptor.items.iter_mut().find(|(k, _)| k.is("GrdL")) {
        for ((item, n), g) in items.iter_mut().zip(noise).zip(grads) {
            if let (Value::Descriptor(d), Some(n)) = (item, n) {
                *d = Descriptor::new("Grdn").with("Grad", Value::Descriptor(noise_grad_desc(n, &g.name)));
            }
        }
    }
    let mut out = b"8BGR".to_vec();
    out.extend_from_slice(&5u16.to_be_bytes());
    out.extend_from_slice(&vd.to_bytes());
    out
}

fn be16(d: &[u8], at: usize) -> Option<u16> {
    d.get(at..at.checked_add(2)?).map(|b| u16::from_be_bytes([b[0], b[1]]))
}

fn be32(d: &[u8], at: usize) -> Option<u32> {
    d.get(at..at.checked_add(4)?).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
}

/// Where a `grdm` block's noise settings start (after the expansion count, smoothness and
/// length), walking its header, name, colour stops and transparency stops.
fn grdm_noise_at(d: &[u8]) -> Option<usize> {
    let mut at = match be16(d, 0)? {
        1 => 4,
        3 => 8,
        _ => return None,
    };
    at = (be32(d, at)? as usize).checked_mul(2)?.checked_add(at.checked_add(4)?)?;
    let n = usize::from(be16(d, at)?);
    at = at.checked_add(2)?.checked_add(n.checked_mul(20)?)?;
    let nt = usize::from(be16(d, at)?);
    at = at.checked_add(2)?.checked_add(nt.checked_mul(10)?)?;
    // Expansion count (2) and the settings' length (32 bytes).
    if be16(d, at)? != 2 || be16(d, at.checked_add(4)?)? != 32 {
        return None;
    }
    at.checked_add(6)
}

/// A `grdm` block's noise gradient, when its mode is noise.
pub fn grdm_noise(d: &[u8]) -> Option<NoiseGradient> {
    let at = grdm_noise_at(d)?;
    if be16(d, at)? != 1 {
        return None;
    }
    let model = match be16(d, at + 14)? {
        3 => NoiseModel::Rgb,
        4 => NoiseModel::Hsb,
        6 => NoiseModel::Lab,
        _ => return None,
    };
    let four = |from: usize| -> Option<[f32; 4]> {
        let mut out = [0.0; 4];
        for (k, slot) in out.iter_mut().enumerate() {
            *slot = (f32::from(be16(d, from + 2 * k)?) / 32768.0).clamp(0.0, 1.0);
        }
        Some(out)
    };
    Some(NoiseGradient {
        seed: be32(d, at + 2)?,
        transparency: be16(d, at + 6)? != 0,
        restrict: be16(d, at + 8)? != 0,
        roughness: (be32(d, at + 10)? as f32 / 4096.0).clamp(0.0, 1.0),
        model,
        min: four(at + 16)?,
        max: four(at + 24)?,
    })
}

/// A Gradient Map's editor record of a noise gradient: its knots as the stops (classic, midpoints
/// halfway) and its settings.
pub fn noise_source(n: NoiseGradient) -> GradientSource {
    let knots = n.knot_stops();
    GradientSource { midpoints: vec![0.5; knots.len().saturating_sub(1)], stops: knots, smoothness: 0.0, method: "classic".into(), noise: Some(n) }
}

/// A Gradient Map of a noise gradient: its bake renders; the editable stops are its knots.
pub fn noise_map(n: NoiseGradient, reverse: bool, dither: bool) -> Adjustment {
    Adjustment::GradientMap { stops: n.bake().0, reverse, dither, source: Some(noise_source(n)) }
}

/// A `grdm` block written for `n`'s knots (`plain`) with `n`'s noise settings in place of the
/// solid ones.
pub fn patch_grdm(mut plain: Vec<u8>, n: &NoiseGradient) -> Vec<u8> {
    let n = n.sanitized();
    let Some(at) = grdm_noise_at(&plain) else { return plain };
    let model: u16 = match n.model {
        NoiseModel::Rgb => 3,
        NoiseModel::Hsb => 4,
        NoiseModel::Lab => 6,
    };
    let mut fields = Vec::with_capacity(32);
    fields.extend_from_slice(&1u16.to_be_bytes());
    fields.extend_from_slice(&n.seed.to_be_bytes());
    fields.extend_from_slice(&u16::from(n.transparency).to_be_bytes());
    fields.extend_from_slice(&u16::from(n.restrict).to_be_bytes());
    fields.extend_from_slice(&((n.roughness * 4096.0).round() as u32).to_be_bytes());
    fields.extend_from_slice(&model.to_be_bytes());
    for v in n.min.into_iter().chain(n.max) {
        fields.extend_from_slice(&((v * 32768.0).round() as u16).to_be_bytes());
    }
    if let Some(slot) = plain.get_mut(at..at + fields.len()) {
        slot.copy_from_slice(&fields);
    }
    plain
}

#[cfg(test)]
mod tests;
