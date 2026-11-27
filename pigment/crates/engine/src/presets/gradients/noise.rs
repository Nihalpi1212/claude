//! Pigment: noise gradients in the gradient commands (P3).
//!
//! The commands that take a gradient also take `"noise": {"roughness": 0..100, "model":
//! "rgb|hsb|lab", "min": [0..100 × 3 or 4], "max": […], "restrict": bool, "transparency": bool,
//! "seed": int}` (see [`NoiseGradient::from_json`]; missing keys keep the gradient's current
//! noise settings, or the defaults), and `"noise": false` (or `null`) to make a noise gradient
//! solid again. A noise gradient holds its bake as its stops, so the renderers and every caller
//! that reads stops keep working; editing the stops of one drops its noise.
//!
//! - presets (the Gradient tool's current gradient, `gradient.presets.new`, `stop {"action":
//!   "set"}`, `select`, `apply`): [`preset`], [`set_preset`];
//! - Gradient Fill layers (`gradient.fill.create`, `set`, `stop`, `get`): [`apply_fill_params`],
//!   [`drop_fill_noise`], [`describe`];
//! - Gradient Overlay and gradient strokes (`layer.layerStyle.*`): [`effect_params`],
//!   [`after_effect_edit`].
//!
//! Solid again, a noise gradient's knots become its stops (at most 64, the same look in RGB).

use photocraft_doc::effects::{Gradient, GradientInterpolation};
use photocraft_doc::{Color, Fill, NoiseGradient};
use serde_json::Value;

use super::{GradientPreset, StopColor};
use crate::Result;
use crate::presets::bad;

/// Whether `p` asks for a noise gradient (`"noise"` is an object).
pub fn has(p: &Value) -> bool {
    p.get("noise").is_some_and(Value::is_object)
}

/// `"noise"` of `p`: `None` when absent (no change), `Some(None)` for `false`/`null` (solid),
/// `Some(Some(n))` for settings, read over `base` (else the defaults).
pub fn param(p: &Value, base: Option<&NoiseGradient>, cmd: &str) -> Result<Option<Option<NoiseGradient>>> {
    match p.get("noise") {
        None => Ok(None),
        Some(Value::Null | Value::Bool(false)) => Ok(Some(None)),
        Some(v @ Value::Object(_)) => {
            let n = NoiseGradient::from_json_over(&base.cloned().unwrap_or_default(), v).map_err(|e| bad(cmd, e))?;
            Ok(Some(Some(n)))
        }
        Some(_) => Err(bad(cmd, "`noise` is {roughness, model, min, max, restrict, transparency, seed} or false")),
    }
}

/// A preset of noise gradient `n` named `name`: its bake as the stops.
pub fn preset(name: &str, n: NoiseGradient) -> GradientPreset {
    let (colors, opacity) = n.bake();
    GradientPreset { name: name.into(), stops: colors.into_iter().map(|(t, c)| (t, StopColor::Rgb(c))).collect(), opacity, noise: Some(n) }
}

/// `g` solid: a noise gradient's knots become its stops (its transparency kept at the knots).
fn solid(g: &GradientPreset) -> GradientPreset {
    match &g.noise {
        Some(n) => GradientPreset {
            name: g.name.clone(),
            stops: n.knot_stops().into_iter().map(|(t, c)| (t, StopColor::Rgb(c))).collect(),
            opacity: g.opacity.clone(),
            noise: None,
        },
        None => g.clone(),
    }
}

/// `gradient.presets.stop {"action": "set"}` with `"noise"`: the noise settings (read over `g`'s)
/// or, for `false`, `g` solid (explicit `stops` then replace the knots). `None` without `"noise"`.
pub fn set_preset(g: &GradientPreset, p: &Value, cmd: &str) -> Result<Option<GradientPreset>> {
    Ok(match param(p, g.noise.as_ref(), cmd)? {
        None => None,
        Some(Some(n)) => Some(preset(&g.name, n)),
        Some(None) if p.get("stops").is_some() => None,
        Some(None) => Some(solid(g)),
    })
}

/// A gradient fill's colour stops, opacity stops, midpoints and noise.
type FillParts<'a> = (&'a mut Vec<(f32, Color)>, &'a mut Vec<(f32, f32)>, &'a mut Vec<f32>, &'a mut Option<NoiseGradient>);

fn fill_parts(f: &mut Fill) -> Option<FillParts<'_>> {
    match f {
        Fill::Gradient { stops, opacity_stops, midpoints, noise, .. } => Some((stops, opacity_stops, midpoints, noise)),
        _ => None,
    }
}

/// Makes gradient fill `f` noise gradient `n` (its bake as the stops), or solid.
pub fn set_fill_noise(f: &mut Fill, n: Option<NoiseGradient>) {
    let Some((stops, opacity, midpoints, noise)) = fill_parts(f) else { return };
    match n {
        Some(n) => {
            (*stops, *opacity) = n.fill_stops();
            midpoints.clear();
            *noise = Some(n);
        }
        None => {
            if let Some(old) = noise.take() {
                *stops = old.knot_stops().into_iter().map(|(t, c)| (t, Color::rgb(c[0], c[1], c[2]))).collect();
                midpoints.clear();
            }
        }
    }
}

/// A stop edit on gradient fill `f` makes it solid (the stops edited are its bake).
pub fn drop_fill_noise(f: &mut Fill) {
    if let Some((_, _, _, noise)) = fill_parts(f) {
        *noise = None;
    }
}

/// `gradient.fill.create` and `set`: `"noise"` applied to `f`; explicit `stops`, `transparency`
/// or `midpoints` without it make `f` solid (those are what it then shows).
pub fn apply_fill_params(f: &mut Fill, p: &Value, cmd: &str) -> Result<()> {
    let current = fill_parts(f).and_then(|(_, _, _, n)| n.clone());
    match param(p, current.as_ref(), cmd)? {
        Some(n) => set_fill_noise(f, n),
        None if ["stops", "transparency", "midpoints"].iter().any(|k| p.get(*k).is_some()) => drop_fill_noise(f),
        None => {}
    }
    Ok(())
}

/// `gradient.fill.get` and friends: the fill's noise settings, when it has them.
pub fn describe(v: &mut Value, noise: Option<&NoiseGradient>) {
    if let Some(n) = noise {
        v["noise"] = n.to_json();
    }
}

/// A new Gradient Overlay's or gradient stroke's gradient with the params' `"noise"` (an object;
/// the effects' own numeric `noise` is something else and ignored here).
pub fn effect_params(mut g: Gradient, p: &Value) -> Gradient {
    if has(p)
        && let Ok(Some(Some(n))) = param(p, None, "layer.layerStyle")
    {
        (g.stops, g.opacity_stops) = n.fill_stops();
        g.noise = Some(n);
    }
    g
}

/// After an effect's gradient is edited (`before` = its stops then): `"noise"` settings are
/// applied over its own (and the editable interpolation record goes, the bake replacing it);
/// any other edit that changed the stops makes it solid.
pub fn after_effect_edit(g: &mut Gradient, interpolation: &mut Option<GradientInterpolation>, before: &[(f32, Color)], p: &Value) {
    if has(p) {
        if let Ok(Some(Some(n))) = param(p, g.noise.as_ref(), "layer.layerStyle") {
            (g.stops, g.opacity_stops) = n.fill_stops();
            g.noise = Some(n);
            *interpolation = None;
        }
    } else if matches!(p.get("noise"), Some(Value::Bool(false))) || g.stops != before {
        g.noise = None;
    }
}

#[cfg(test)]
mod tests;
