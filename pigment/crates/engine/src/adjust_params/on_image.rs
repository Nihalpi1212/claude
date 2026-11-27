//! Pigment: the on-image adjustment tools and the new eyedroppers (PORTS-A rows 3, 4, 7, 12, 13).
//!
//! - **Exposure's eyedroppers** ([`exposure_eyedropper`]): black sets Offset so the sample becomes black, gray sets
//!   Exposure so it becomes middle grey (18 % in linear light), white so it becomes white. Params `"eyedropper"` as
//!   Levels and Curves have it.
//! - **Hue/Saturation's range eyedroppers** ([`hue_saturation_eyedropper`]): pick (the range of the sample's hue,
//!   centred on it), Add to Sample (widen the edited range to the hue), Subtract from Sample (narrow it). A port of the
//!   JavaScript Pigment's `rangeForColor`, `addHueToRange` and `subtractHueFromRange`
//!   (`shared/pixels/adjust-color.js`). Params `"rangeEyedropper":{"mode","at"|"color","size"}`; the range the dialog
//!   edits is the new `"edit"` key.
//! - **The targeted adjustment tool** (the hand): [`on_image_curves`] (a point at the sample's tone, dragged up or down
//!   one level per two pixels), [`on_image_hue_sat`] (the range under the pointer, drag for saturation, with `hue` for
//!   hue), [`on_image_black_white`] (the colour slider nearest the sample's hue). Params
//!   `"onImage":{"at"|"color","size","drag":[dx,dy],"hue":bool,"channel"}`.
//!
//! The functions over a sample are pure and return complete params, so the interface calls them on every drag step
//! from the params before the press, and agents reach them through the commands' params ([`image`], [`layer`]).

use photocraft_color::{ColorMode, SampleType};
use photocraft_compose::adjust::Transfer;
use photocraft_doc::adjust::{CurvePoint, HueRange};
use photocraft_doc::{Adjustment, Document, LayerContent, LayerId};
use serde_json::{Map, Value, json};

use super::{CURVE_POINT_DUPLICATE_DISTANCE, CurvesEyedropper, HUE_RANGES, MAX_CURVE_POINTS, Result, bad, from_params, rgb_luma, to_params, user_keys};
use crate::EngineError;
use crate::cmd::adjustment_kind;

/// The params key of the on-image tool.
pub const ON_IMAGE: &str = "onImage";
/// The params key of Hue/Saturation's range eyedroppers.
pub const RANGE_EYEDROPPER: &str = "rangeEyedropper";
/// The params key of the range Hue/Saturation edits: `"master"` or one of [`HUE_RANGES`].
pub const EDIT: &str = "edit";
/// The eyedropper key (Levels' and Curves' upstream, Exposure's here).
const EYEDROPPER: &str = "eyedropper";

/// Photoshop's middle grey in linear light.
const MIDDLE_GRAY: f64 = 0.18;
/// A sample darker than this (linear) cannot be lifted by Exposure.
const DARKEST: f64 = 1e-6;
/// A press this close (in levels) to a point of the curve takes that point instead of adding one.
const NEAR_POINT: f32 = 4.0;
/// Below this saturation (HSV, 0..1) the on-image tool edits Master: the sample has no usable hue.
const GRAY_SATURATION: f32 = 0.05;

// ---------------------------------------------------------------------------------------------
// Exposure

/// Exposure's eyedroppers on the Exposure in `base` (params), from a colour sample (0..1, as the document stores it).
/// `transfer` is the curve Exposure linearises through ([`exposure_transfer`]). Black: Offset = −(sample × 2^Exposure)
/// so the sample maps to black; gray: Exposure so the sample maps to 18 % grey; white: so it maps to white (both with
/// the current Offset and Gamma kept). Exposure is rounded to hundredths and Offset to 1/10000, as the JavaScript app.
pub fn exposure_eyedropper(base: &Value, picker: CurvesEyedropper, sample: [f32; 3], transfer: Transfer) -> Result<Adjustment> {
    const CMD: &str = "exposure eyedropper";
    if sample.iter().any(|v| !v.is_finite()) {
        return Err(bad(CMD, "sample components must be finite"));
    }
    let Adjustment::Exposure { exposure, offset, gamma } = from_params("exposure", base, None, ColorMode::Rgb)? else {
        return Err(bad(CMD, "expected an Exposure adjustment"));
    };
    let lin = f64::from(transfer.decode(rgb_luma(sample.map(|v| v.clamp(0.0, 1.0)))));
    let multiplier = 2f64.powf(f64::from(exposure));
    let (mut exposure, mut offset) = (f64::from(exposure), f64::from(offset));
    match picker {
        CurvesEyedropper::Black => offset = (-lin * multiplier).clamp(-0.5, 0.5),
        CurvesEyedropper::NeutralGray | CurvesEyedropper::White => {
            if lin <= DARKEST {
                return Err(bad(CMD, "the sample is black: no exposure makes it lighter"));
            }
            let target = if picker == CurvesEyedropper::White { 1.0 } else { MIDDLE_GRAY };
            // (lin · 2^e + offset)^(1/gamma) = target in linear light.
            let want = target.powf(f64::from(gamma)) - offset;
            if want <= 0.0 {
                return Err(bad(CMD, "the offset already makes the sample lighter than the target"));
            }
            exposure = (want / lin).log2().clamp(-20.0, 20.0);
        }
    }
    exposure = (exposure * 100.0).round() / 100.0;
    offset = (offset * 10000.0).round() / 10000.0;
    Ok(Adjustment::Exposure { exposure: exposure as f32, offset: offset as f32, gamma })
}

/// The curve Exposure linearises through in a document of `mode` and `depth` (the compositor's).
pub fn exposure_transfer(mode: ColorMode, depth: SampleType) -> Transfer {
    Transfer::for_document(mode, depth).for_exposure()
}

// ---------------------------------------------------------------------------------------------
// Hue

/// The HSL hue (degrees, 0..360) of a colour, or `None` for a grey (the JavaScript app's `hueOf`).
pub fn hue_of(rgb: [f32; 3]) -> Option<f32> {
    let [r, g, b] = rgb;
    let (max, min) = (r.max(g).max(b), r.min(g).min(b));
    let delta = max - min;
    if !(delta > 0.0) {
        return None;
    }
    let h = if max == r {
        (g - b) / delta + if g < b { 6.0 } else { 0.0 }
    } else if max == g {
        (b - r) / delta + 2.0
    } else {
        (r - g) / delta + 4.0
    };
    Some(wrap360(h * 60.0))
}

/// The HSV saturation of a colour, 0..1.
fn saturation_of(rgb: [f32; 3]) -> f32 {
    let [r, g, b] = rgb.map(|v| v.clamp(0.0, 1.0));
    let max = r.max(g).max(b);
    if max <= 0.0 { 0.0 } else { (max - r.min(g).min(b)) / max }
}

fn wrap360(v: f32) -> f32 {
    let x = v.rem_euclid(360.0);
    if x >= 360.0 { 0.0 } else { x }
}

/// The range (index into [`HUE_RANGES`]) whose default centre is nearest a colour's hue (`rangeForColor`), `None` for a
/// grey.
pub fn range_for_color(rgb: [f32; 3]) -> Option<usize> {
    hue_of(rgb).map(|h| ((h / 60.0).round() as usize) % 6)
}

/// Bounds as four numbers in 0..360 in order around the circle from the first (`normalizeBounds`).
fn wrapped(bounds: [f32; 4]) -> [f32; 4] {
    bounds.map(wrap360)
}

/// Weight 0..1 of hue `h` in wrapped bounds (`boundsWeight`).
fn bounds_weight(bounds: [f32; 4], h: f32) -> f32 {
    let [a, b, c, d] = bounds;
    let (hh, bb, cc, dd) = (wrap360(h - a), wrap360(b - a), wrap360(c - a), wrap360(d - a));
    if hh > dd {
        0.0
    } else if hh < bb {
        if bb > 0.0 { hh / bb } else { 1.0 }
    } else if hh <= cc {
        1.0
    } else if dd > cc {
        (dd - hh) / (dd - cc)
    } else {
        0.0
    }
}

/// Bounds centred on hue `h` with the default widths (the pick eyedropper moves a range to the sampled colour).
fn centred_on(h: f32) -> [f32; 4] {
    let h = h.round();
    [h - 45.0, h - 15.0, h + 15.0, h + 45.0]
}

/// The "+" range eyedropper (`addHueToRange`): bounds widened so that hue `h` gets the full effect. The nearer end of
/// the full-effect part moves to `h`, its fall-off edge with it, so the fall-off keeps its width; a range that would
/// then cover the whole circle is kept.
pub fn add_hue_to_range(bounds: [f32; 4], h: f32) -> [f32; 4] {
    let nb = wrapped(bounds);
    let [a, b, c, d] = nb;
    if bounds_weight(nb, h) >= 1.0 {
        return bounds;
    }
    let (left, right) = (wrap360(b - h), wrap360(h - c));
    let full = wrap360(c - b);
    let falloff = wrap360(d - c) + wrap360(b - a);
    let widened = if left <= right {
        (full + left + falloff < 359.0).then(|| [wrap360(a - left), wrap360(h), c, d])
    } else {
        (full + right + falloff < 359.0).then(|| [a, b, wrap360(h), wrap360(d + right)])
    };
    widened.map_or(bounds, HueRange::canonical_bounds)
}

/// The "−" range eyedropper (`subtractHueFromRange`): bounds narrowed so that hue `h` is no longer affected. In the
/// fall-off the outer edge moves to `h`; in the full-effect part the nearer side is cut off at `h`, the fall-off
/// keeping its width where it can.
pub fn subtract_hue_from_range(bounds: [f32; 4], h: f32) -> [f32; 4] {
    let nb = wrapped(bounds);
    let [a, b, c, d] = nb;
    let (hh, bb, cc, dd) = (wrap360(h - a), wrap360(b - a), wrap360(c - a), wrap360(d - a));
    let narrowed = if hh > dd {
        return bounds;
    } else if hh < bb {
        [wrap360(h), b, c, d]
    } else if hh > cc {
        [a, b, c, wrap360(h)]
    } else if hh - bb <= cc - hh {
        let nb = (hh + bb).min(cc);
        [wrap360(h), wrap360(a + nb), c, d]
    } else {
        let nc = (hh - (dd - cc)).max(bb);
        [a, b, wrap360(a + nc), wrap360(h)]
    };
    HueRange::canonical_bounds(narrowed)
}

/// The range a Hue/Saturation `edit` key names: `None` for Master (or no key).
pub fn edit_of(p: &Value) -> Result<Option<usize>> {
    match p.get(EDIT) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s == "master" => Ok(None),
        Some(Value::String(s)) if HUE_RANGES.contains(&s.as_str()) => Ok(HUE_RANGES.iter().position(|k| k == s)),
        Some(_) => Err(bad("hueSaturation adjustment", "`edit` must be \"master\" or one of reds|yellows|greens|cyans|blues|magentas")),
    }
}

fn edit_name(edit: Option<usize>) -> &'static str {
    edit.and_then(|i| HUE_RANGES.get(i).copied()).unwrap_or("master")
}

/// Hue/Saturation's range eyedroppers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RangeDropper {
    /// The range of the sample's hue becomes the edited one, centred on the hue.
    Pick,
    /// Add to Sample: the edited range widens to the sample's hue (from Master: the sample's range is picked first).
    Add,
    /// Subtract from Sample: the edited range narrows to leave the sample's hue out (nothing from Master).
    Subtract,
}

impl RangeDropper {
    /// The mode named in `rangeEyedropper.mode`.
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "pick" => Some(Self::Pick),
            "add" => Some(Self::Add),
            "subtract" => Some(Self::Subtract),
            _ => None,
        }
    }
}

/// The Hue/Saturation of `base` with its ranges, colorize refused.
fn hue_saturation_of(cmd: &str, base: &Value) -> Result<(Adjustment, Option<usize>)> {
    let edit = edit_of(base)?;
    let adj = from_params("hueSaturation", base, None, ColorMode::Rgb)?;
    if matches!(adj, Adjustment::HueSaturation { colorize: true, .. }) {
        return Err(bad(cmd, "Colorize is on: there are no colour ranges to sample"));
    }
    Ok((adj, edit))
}

/// The params of a Hue/Saturation adjustment and the range it edits.
fn hue_saturation_params(adj: &Adjustment, edit: Option<usize>) -> Value {
    let mut p = to_params(adj);
    p[EDIT] = json!(edit_name(edit));
    p
}

/// A range eyedropper on the Hue/Saturation in `base` (params, its `edit` key the edited range), from a colour sample.
/// Returns the complete params with `edit` set to the range edited after the sample. A grey sample picks Master
/// (Pick) or changes nothing (Add, Subtract).
pub fn hue_saturation_eyedropper(base: &Value, mode: RangeDropper, sample: [f32; 3]) -> Result<Value> {
    const CMD: &str = "hueSaturation range eyedropper";
    if sample.iter().any(|v| !v.is_finite()) {
        return Err(bad(CMD, "sample components must be finite"));
    }
    let (mut adj, mut edit) = hue_saturation_of(CMD, base)?;
    let Adjustment::HueSaturation { ranges, .. } = &mut adj else { return Err(bad(CMD, "expected a Hue/Saturation adjustment")) };
    let Some(h) = hue_of(sample) else {
        if mode == RangeDropper::Pick {
            edit = None;
        }
        return Ok(hue_saturation_params(&adj, edit));
    };
    let mut pick = |edit: &mut Option<usize>| -> Option<usize> {
        let i = range_for_color(sample)?;
        let range = ranges.get_mut(i)?;
        range.bounds = HueRange::canonical_bounds(centred_on(h));
        *edit = Some(i);
        Some(i)
    };
    match mode {
        RangeDropper::Pick => {
            pick(&mut edit);
        }
        RangeDropper::Add => {
            let target = match edit {
                Some(i) => Some(i),
                None => pick(&mut edit),
            };
            if let Some(range) = target.and_then(|i| ranges.get_mut(i)) {
                range.bounds = add_hue_to_range(range.bounds, h.round());
            }
        }
        RangeDropper::Subtract => {
            if let Some(range) = edit.and_then(|i| ranges.get_mut(i)) {
                range.bounds = subtract_hue_from_range(range.bounds, h.round());
            }
        }
    }
    Ok(hue_saturation_params(&adj, edit))
}

// ---------------------------------------------------------------------------------------------
// The targeted adjustment tool

/// A Curves channel the on-image tool edits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CurveChannel {
    /// The composite (RGB: its luma; Grayscale: the gray curve).
    Composite,
    /// Red, green or blue (0, 1, 2).
    Color(usize),
}

impl CurveChannel {
    /// The channel `onImage.channel` names (`"composite"`, `"red"`, `"green"`, `"blue"`; `"gray"` = composite).
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "composite" | "rgb" | "gray" => Some(Self::Composite),
            "red" => Some(Self::Color(0)),
            "green" => Some(Self::Color(1)),
            "blue" => Some(Self::Color(2)),
            _ => None,
        }
    }
}

/// The curve's output (0..1) at `input` (0..1), through the compositor's interpolation.
fn curve_at(curve: &[CurvePoint], input: f32) -> f32 {
    let lut = photocraft_compose::adjust::curve_lut(curve);
    let last = lut.len().saturating_sub(1) as f32;
    lut.get((input.clamp(0.0, 1.0) * last).round() as usize).copied().unwrap_or(input)
}

/// The on-image tool in Curves: the point of the `channel` curve at the sample's tone (an existing point within four
/// levels, else a new one on the curve), moved by the vertical drag `dy` (screen pixels, down positive): one level per
/// two pixels, as Photoshop. RGB and Grayscale documents; a pencil curve is refused (the tool places points).
pub fn on_image_curves(base: &Value, channel: CurveChannel, sample: [f32; 3], dy: f64, mode: ColorMode) -> Result<Value> {
    const CMD: &str = "curves on-image tool";
    if sample.iter().any(|v| !v.is_finite()) || !dy.is_finite() {
        return Err(bad(CMD, "sample and drag must be finite"));
    }
    if !matches!(mode, ColorMode::Rgb | ColorMode::Grayscale) {
        return Err(bad(CMD, "only RGB and Grayscale documents are supported"));
    }
    let mut adj = from_params("curves", base, None, mode)?;
    let Adjustment::Curves { master, per_channel, pencil, .. } = &mut adj else { return Err(bad(CMD, "expected a Curves adjustment")) };
    if *pencil {
        return Err(bad(CMD, "the curve is drawn with the pencil: switch to points first"));
    }
    let sample = sample.map(|v| v.clamp(0.0, 1.0));
    let gray = mode == ColorMode::Grayscale;
    let (curve, tone) = match channel {
        CurveChannel::Composite if gray => (master, (sample[0] + sample[1] + sample[2]) / 3.0),
        CurveChannel::Composite => (master, rgb_luma(sample)),
        CurveChannel::Color(_) if gray => return Err(bad(CMD, "a Grayscale document has only the gray curve")),
        CurveChannel::Color(i) => match (per_channel.get_mut(i), sample.get(i)) {
            (Some(curve), Some(&v)) => (curve, v),
            _ => return Err(bad(CMD, "no such channel")),
        },
    };
    let input = (tone * 255.0).round() / 255.0;
    let near = curve.iter().enumerate().filter(|(_, p)| (p.input - input).abs() <= NEAR_POINT / 255.0).min_by(|(_, a), (_, b)| {
        (a.input - input).abs().total_cmp(&(b.input - input).abs())
    });
    let index = match near.map(|(i, _)| i) {
        Some(i) => i,
        None => {
            if curve.len() >= MAX_CURVE_POINTS {
                return Err(bad(CMD, format!("the curve already has {MAX_CURVE_POINTS} points")));
            }
            let output = (curve_at(curve, input) * 255.0).round() / 255.0;
            let at = curve.iter().position(|p| p.input > input).unwrap_or(curve.len());
            curve.insert(at, CurvePoint { input, output });
            at
        }
    };
    if let Some(point) = curve.get_mut(index) {
        let level = (point.output * 255.0 - (dy / 2.0) as f32).round().clamp(0.0, 255.0);
        point.output = level / 255.0;
    }
    debug_assert!(curve.windows(2).all(|w| w[1].input - w[0].input >= CURVE_POINT_DUPLICATE_DISTANCE));
    Ok(to_params(&adj))
}

/// The on-image tool in Hue/Saturation: the range whose weight is largest at the sample's hue (Master for a sample
/// under 5 % saturation) becomes the edited one, and the horizontal drag `dx` (screen pixels) moves its saturation, or
/// its hue with `hue` (Photoshop's Ctrl/Cmd-drag), by one per two pixels. Returns the params with `edit` set.
pub fn on_image_hue_sat(base: &Value, sample: [f32; 3], dx: f64, hue: bool) -> Result<Value> {
    const CMD: &str = "hueSaturation on-image tool";
    if sample.iter().any(|v| !v.is_finite()) || !dx.is_finite() {
        return Err(bad(CMD, "sample and drag must be finite"));
    }
    let (mut adj, _) = hue_saturation_of(CMD, base)?;
    let Adjustment::HueSaturation { hue: master_hue, saturation: master_saturation, ranges, .. } = &mut adj else {
        return Err(bad(CMD, "expected a Hue/Saturation adjustment"));
    };
    let edit = match hue_of(sample).filter(|_| saturation_of(sample) >= GRAY_SATURATION) {
        None => None,
        Some(h) => {
            let best = ranges.iter().enumerate().map(|(i, r)| (i, r.weight(h))).fold((None, 0.0f32), |(bi, bw), (i, w)| if w > bw { (Some(i), w) } else { (bi, bw) });
            best.0.or_else(|| range_for_color(sample))
        }
    };
    let step = (dx / 2.0) as f32;
    let (h, s) = match edit.and_then(|i| ranges.get_mut(i)) {
        Some(range) => (&mut range.hue, &mut range.saturation),
        None => (master_hue, master_saturation),
    };
    if hue {
        *h = (*h + step).round().clamp(-180.0, 180.0);
    } else {
        *s = (*s + step).round().clamp(-100.0, 100.0);
    }
    Ok(hue_saturation_params(&adj, edit))
}

/// The on-image tool in Black & White: the colour slider (reds…magentas) nearest the sample's hue moves by the
/// horizontal drag `dx` (screen pixels), one percent per two pixels (−200..300). A grey sample is refused: it has no
/// colour slider.
pub fn on_image_black_white(base: &Value, sample: [f32; 3], dx: f64) -> Result<Value> {
    const CMD: &str = "blackWhite on-image tool";
    if sample.iter().any(|v| !v.is_finite()) || !dx.is_finite() {
        return Err(bad(CMD, "sample and drag must be finite"));
    }
    let mut adj = from_params("blackWhite", base, None, ColorMode::Rgb)?;
    let Adjustment::BlackWhite { weights, .. } = &mut adj else { return Err(bad(CMD, "expected a Black & White adjustment")) };
    let i = range_for_color(sample).ok_or_else(|| bad(CMD, "the sample is grey: it has no colour slider"))?;
    if let Some(w) = weights.get_mut(i) {
        *w = (*w + (dx / 2.0) as f32).round().clamp(-200.0, 300.0);
    }
    Ok(to_params(&adj))
}

// ---------------------------------------------------------------------------------------------
// Params

/// What the tool keys of `p` ask for `kind`, and the sampled colour, as params over `base` (the adjustment before the
/// tool, as params). `None` when `p` names no tool of this kind.
fn resolve(kind: &str, base: &Value, p: &Value, sample: impl Fn(&Value) -> Result<[f32; 3]>, mode: ColorMode, depth: SampleType) -> Result<Option<Value>> {
    if kind == "exposure"
        && let Some(e) = p.get(EYEDROPPER)
    {
        let picker = match e.get("point").and_then(Value::as_str) {
            Some("black") => CurvesEyedropper::Black,
            Some("gray") => CurvesEyedropper::NeutralGray,
            Some("white") => CurvesEyedropper::White,
            _ => return Err(bad(EYEDROPPER, "`eyedropper.point` must be \"black\", \"gray\" or \"white\"")),
        };
        return Ok(Some(to_params(&exposure_eyedropper(base, picker, sample(e)?, exposure_transfer(mode, depth))?)));
    }
    if let Some(e) = p.get(RANGE_EYEDROPPER) {
        if kind != "hueSaturation" {
            return Err(bad(RANGE_EYEDROPPER, "`rangeEyedropper` applies to Hue/Saturation only"));
        }
        let mode = e.get("mode").and_then(Value::as_str).and_then(RangeDropper::parse);
        let mode = mode.ok_or_else(|| bad(RANGE_EYEDROPPER, "`rangeEyedropper.mode` must be \"pick\", \"add\" or \"subtract\""))?;
        return hue_saturation_eyedropper(base, mode, sample(e)?).map(Some);
    }
    let Some(e) = p.get(ON_IMAGE) else { return Ok(None) };
    let drag = match e.get("drag") {
        None | Some(Value::Null) => [0.0, 0.0],
        Some(v) => v
            .as_array()
            .filter(|a| a.len() == 2)
            .and_then(|a| Some([a.first()?.as_f64()?, a.get(1)?.as_f64()?]))
            .filter(|d| d.iter().all(|v| v.is_finite()))
            .ok_or_else(|| bad(ON_IMAGE, "`onImage.drag` must be [dx, dy] in screen pixels"))?,
    };
    let hue = match e.get("hue") {
        None | Some(Value::Null) => false,
        Some(v) => v.as_bool().ok_or_else(|| bad(ON_IMAGE, "`onImage.hue` must be true or false"))?,
    };
    match kind {
        "curves" => {
            let channel = match e.get("channel") {
                None | Some(Value::Null) => CurveChannel::Composite,
                Some(v) => v.as_str().and_then(CurveChannel::parse).ok_or_else(|| bad(ON_IMAGE, "`onImage.channel` must be composite, red, green or blue"))?,
            };
            on_image_curves(base, channel, sample(e)?, drag[1], mode).map(Some)
        }
        "hueSaturation" => on_image_hue_sat(base, sample(e)?, drag[0], hue).map(Some),
        "blackWhite" => on_image_black_white(base, sample(e)?, drag[0]).map(Some),
        _ => Err(bad(ON_IMAGE, "`onImage` applies to Curves, Hue/Saturation and Black & White only")),
    }
}

/// The colour at `e`'s `"color"` ([r, g, b] in 0..1) or `"at"` ([x, y] document pixels, with the Eyedropper's
/// `"size"`) of `doc` with layer `hide` hidden.
pub fn sample(doc: &Document, hide: Option<LayerId>, e: &Value) -> Result<[f32; 3]> {
    const CMD: &str = "sample";
    let pair = |v: &Value, n: usize| -> Option<Vec<f64>> { v.as_array().filter(|a| a.len() == n)?.iter().map(Value::as_f64).collect::<Option<Vec<f64>>>() };
    if let Some(c) = e.get("color") {
        let c = pair(c, 3).filter(|c| c.iter().all(|v| v.is_finite())).ok_or_else(|| bad(CMD, "`color` must be [r, g, b] in 0..1"))?;
        return Ok([c[0] as f32, c[1] as f32, c[2] as f32]);
    }
    let at = e.get("at").ok_or_else(|| bad(CMD, "a tool needs `at` [x, y] or `color` [r, g, b]"))?;
    let xy = pair(at, 2).filter(|xy| xy.iter().all(|v| v.is_finite())).ok_or_else(|| bad(CMD, "`at` must be [x, y] in document pixels"))?;
    let (x, y) = (xy[0], xy[1]);
    if x < 0.0 || y < 0.0 || x >= f64::from(doc.size.width) || y >= f64::from(doc.size.height) {
        return Err(bad(CMD, "`at` is outside the image"));
    }
    let size = crate::sample_cmds::size_param(CMD, e)?;
    let all = crate::sample_cmds::SampleLayers::All;
    let [r, g, b, a] = match hide {
        Some(id) => {
            let mut below = doc.clone();
            if let Some(l) = below.layer_mut(id) {
                l.visible = false;
            }
            crate::sample_cmds::sample_color(&below, None, x, y, size, all)
        }
        None => crate::sample_cmds::sample_color(doc, None, x, y, size, all),
    };
    if a <= 0.0 {
        return Err(bad(CMD, "the sampled pixel is transparent"));
    }
    Ok([r, g, b])
}

/// Whether `p` names one of this module's tools for `kind`.
pub fn names_tool(kind: &str, p: &Value) -> bool {
    p.get(ON_IMAGE).is_some() || p.get(RANGE_EYEDROPPER).is_some() || (kind == "exposure" && p.get(EYEDROPPER).is_some())
}

/// Removes the tool keys from recorded params (what a Smart Filter re-runs): the resolved settings replace them.
pub fn strip(q: &mut Map<String, Value>) {
    for key in [ON_IMAGE, RANGE_EYEDROPPER, EDIT] {
        q.remove(key);
    }
}

/// The tools of `image.adjustments.<kind>` and `layer.newAdjustmentLayer.<kind>`: the adjustment `p` asks for with
/// the composite colour image sampled. A mask, channel or Quick Mask target is refused (the tools read colour).
/// `None` when `p` names no tool.
pub fn image(s: &crate::Session, kind: &str, p: &Value) -> Result<Option<Adjustment>> {
    if !names_tool(kind, p) {
        return Ok(None);
    }
    let targeted = crate::channel_cmds::inject_target(s, &format!("image.adjustments.{kind}"), p.clone());
    if crate::channel_cmds::gray_target(&targeted).is_some() {
        return Err(bad(kind, "the on-image tools and eyedroppers sample the colour image, not a mask, channel or Quick Mask"));
    }
    let d = s.active().ok_or(EngineError::NoDocument)?;
    let mut base = p.clone();
    if let Some(o) = base.as_object_mut() {
        o.remove(EYEDROPPER);
        o.remove(ON_IMAGE);
        o.remove(RANGE_EYEDROPPER);
    }
    let mode = d.doc.mode;
    let params = resolve(kind, &base, p, |e| sample(&d.doc, None, e), mode, d.doc.depth)?;
    params.map(|params| from_params(kind, &params, None, mode)).transpose()
}

/// The tools of `layer.setAdjustment` on adjustment layer `layer`: the image below the layer is sampled, and the
/// layer's adjustment with the other keys of `p` merged over it is what the tool edits. `None` when `p` names no tool.
pub fn layer(s: &crate::Session, layer: LayerId, p: &Value) -> Result<Option<Adjustment>> {
    let d = s.active().ok_or(EngineError::NoDocument)?;
    let l = d.doc.layer(layer).ok_or(EngineError::NoLayer(layer))?;
    let LayerContent::Adjustment(adj) = &l.content else { return Ok(None) };
    let kind = adjustment_kind(adj);
    if !names_tool(kind, p) {
        return Ok(None);
    }
    let mut rest = p.clone();
    if let Some(o) = rest.as_object_mut() {
        for key in [EYEDROPPER, ON_IMAGE, RANGE_EYEDROPPER, EDIT] {
            o.remove(key);
        }
    }
    let mode = d.doc.mode;
    let current = if user_keys(&rest).is_empty() { adj.clone() } else { from_params(kind, &rest, Some(adj), mode)? };
    let mut base = to_params(&current);
    if let Some(edit) = p.get(EDIT) {
        base[EDIT] = edit.clone();
    }
    let params = resolve(kind, &base, p, |e| sample(&d.doc, Some(layer), e), mode, d.doc.depth)?;
    params.map(|params| from_params(kind, &params, None, mode)).transpose()
}

#[cfg(test)]
mod tests;
