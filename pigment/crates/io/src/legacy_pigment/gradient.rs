//! Gradients of Pigment 0.1–0.4 (`shared/pixels/gradient-model.js`): 0.3's stop lists
//! (`{ kind, stops: [{ pos | offset | position, color (#rrggbb or #rrggbbaa), opacity? }], from, to,
//! reverse }`) and 0.4's version 2 definitions (`{ gradientVersion: 2, type: 'solid' | 'noise',
//! interpolation, smoothness, stops: [{ pos, mid, color }], opacityStops: [{ pos, mid, opacity }],
//! noise? }`).
//!
//! The app drew a gradient through its own model: a midpoint bends a segment by a power curve,
//! Smoothness eases it, and the interpolation methods mix in sRGB (classic), Oklab (perceptual,
//! smooth: a monotone cubic through the stops), linear light (linear), or not at all (stripes);
//! noise gradients are seeded random walks. PhotoCraft's gradients interpolate their stops
//! linearly, so a definition that bends its segments is sampled here into dense stops (what the
//! app showed), and one that does not keeps its own stops. [`Def::source`] gives the stops as the
//! Gradient Editor shows them where PhotoCraft has the method.

use photocraft_color::Color;
use photocraft_doc::adjust::GradientSource;
use photocraft_doc::{NoiseGradient, NoiseModel};
use serde_json::Value;

/// Stops read from one gradient; more are left out.
const MAX_STOPS: usize = 256;
/// Samples across a bent gradient (PhotoCraft interpolates linearly between them).
const SAMPLES: usize = 128;
/// Half the gap between the two samples on each side of a stop (a hard stop stays hard).
const EPS: f64 = 1e-4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Method {
    Classic,
    Perceptual,
    Linear,
    Smooth,
    Stripes,
}

impl Method {
    fn from_name(s: &str) -> Option<Method> {
        Some(match s {
            "classic" => Method::Classic,
            "perceptual" => Method::Perceptual,
            "linear" => Method::Linear,
            "smooth" => Method::Smooth,
            "stripes" => Method::Stripes,
            _ => return None,
        })
    }
    fn name(self) -> &'static str {
        match self {
            Method::Classic => "classic",
            Method::Perceptual => "perceptual",
            Method::Linear => "linear",
            Method::Smooth => "smooth",
            Method::Stripes => "stripes",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Stop {
    pos: f64,
    mid: f64,
    /// 0..255, whole numbers (the app kept colours as `#rrggbb`).
    rgb: [f64; 3],
    /// A `{ ref: 'fg' | 'bg' }` stop (`rgb` is then black or white); presets keep the reference.
    refers: Option<StopRef>,
}

/// The colour a preset's stop refers to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopRef {
    Foreground,
    Background,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct OpacityStop {
    pos: f64,
    mid: f64,
    opacity: f64,
}

/// Colour stops `(location, sRGB 0..1)` and opacity stops `(location, opacity)`.
type Sampled = (Vec<(f64, [f64; 3])>, Vec<(f64, f64)>);
/// Colour stops and opacity stops as PhotoCraft's fills and effects keep them.
pub(crate) type Stops = (Vec<(f32, Color)>, Vec<(f32, f32)>);

/// A gradient as a preset keeps it ([`Def::preset`]).
#[derive(Clone, Debug, PartialEq)]
pub struct PresetStops {
    /// `(location 0..1, sRGB 0..1, the colour a stop refers to)`, sorted.
    pub colors: Vec<(f32, [f32; 3], Option<StopRef>)>,
    /// `(location, opacity 0..1)`, sorted.
    pub opacity: Vec<(f32, f32)>,
    /// A noise gradient's settings; the stops are its bake.
    pub noise: Option<NoiseGradient>,
    /// The stops are samples of a gradient PhotoCraft's linear stops cannot draw as it was.
    pub sampled: bool,
}

/// A gradient as the app's model held it after `normalizeGradient`.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Def {
    stops: Vec<Stop>,
    opacity: Vec<OpacityStop>,
    pub(crate) method: Method,
    smoothness: f64,
    /// A noise gradient's settings (`NOISE_DEFAULTS` of gradient-model.js; the sampler is
    /// [`photocraft_doc::noise_gradient`]).
    pub(crate) noise: Option<NoiseGradient>,
}

fn num(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64().filter(|n| n.is_finite()),
        Value::String(s) if !s.trim().is_empty() => s.trim().parse::<f64>().ok().filter(|n| n.is_finite()),
        _ => None,
    }
}

fn clamp01(v: f64) -> f64 {
    v.clamp(0.0, 1.0)
}

/// `parseColor` of shared/pixels/color.js: `[r, g, b, a]`, channels 0..255, alpha 0..1.
pub(crate) fn parse_color(v: &Value) -> Option<[f64; 4]> {
    match v {
        Value::Array(a) => {
            let c = |i: usize, d: f64| a.get(i).and_then(Value::as_f64).filter(|n| n.is_finite()).unwrap_or(d);
            Some([c(0, 0.0), c(1, 0.0), c(2, 0.0), c(3, 1.0)])
        }
        Value::String(s) => parse_color_str(s),
        _ => None,
    }
}

fn parse_color_str(s: &str) -> Option<[f64; 4]> {
    let s = s.trim().to_ascii_lowercase();
    if let Some(h) = s.strip_prefix('#') {
        if !h.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let byte = |i: usize| u8::from_str_radix(h.get(i..i + 2)?, 16).ok().map(f64::from);
        let nibble = |i: usize| u8::from_str_radix(h.get(i..i + 1)?, 16).ok().map(|v| f64::from(v * 17));
        return match h.len() {
            3 => Some([nibble(0)?, nibble(1)?, nibble(2)?, 1.0]),
            4 => Some([nibble(0)?, nibble(1)?, nibble(2)?, nibble(3)? / 255.0]),
            6 => Some([byte(0)?, byte(2)?, byte(4)?, 1.0]),
            8 => Some([byte(0)?, byte(2)?, byte(4)?, byte(6)? / 255.0]),
            _ => None,
        };
    }
    if let Some(inner) = s.strip_prefix("rgba(").or_else(|| s.strip_prefix("rgb(")).and_then(|r| r.strip_suffix(')')) {
        let parts: Vec<&str> = inner.split(|c: char| c == ',' || c == '/' || c.is_whitespace()).filter(|p| !p.is_empty()).collect();
        let n = |i: usize| parts.get(i).and_then(|p| p.parse::<f64>().ok()).filter(|n| n.is_finite());
        let a = match parts.get(3) {
            Some(p) if p.ends_with('%') => p.trim_end_matches('%').parse::<f64>().ok()? / 100.0,
            Some(p) => p.parse::<f64>().ok()?,
            None => 1.0,
        };
        return Some([n(0)?, n(1)?, n(2)?, a]);
    }
    match s.as_str() {
        "black" => Some([0.0, 0.0, 0.0, 1.0]),
        "white" => Some([255.0, 255.0, 255.0, 1.0]),
        "red" => Some([255.0, 0.0, 0.0, 1.0]),
        "green" => Some([0.0, 128.0, 0.0, 1.0]),
        "blue" => Some([0.0, 0.0, 255.0, 1.0]),
        "transparent" => Some([0.0, 0.0, 0.0, 0.0]),
        _ => None,
    }
}

/// A colour as the app stored it after `toHex`: whole numbers in 0..255.
fn hex_rounded(c: [f64; 4]) -> [f64; 3] {
    [c[0], c[1], c[2]].map(|v| v.clamp(0.0, 255.0).round())
}

/// A stop colour: a colour, or a reference to the foreground (black) or background (white).
fn stop_color(v: Option<&Value>) -> [f64; 4] {
    match v {
        Some(Value::Object(o)) => match o.get("ref").and_then(Value::as_str) {
            Some("bg") => [255.0, 255.0, 255.0, 1.0],
            _ => [0.0, 0.0, 0.0, 1.0],
        },
        Some(v) => parse_color(v).unwrap_or([0.0, 0.0, 0.0, 1.0]),
        None => [0.0, 0.0, 0.0, 1.0],
    }
}

/// The colour a `{ ref }` stop refers to.
fn stop_ref(v: Option<&Value>) -> Option<StopRef> {
    match v?.as_object()?.get("ref")?.as_str()? {
        "bg" => Some(StopRef::Background),
        _ => Some(StopRef::Foreground),
    }
}

fn sort_stable<T>(list: &mut [T], pos: impl Fn(&T) -> f64) {
    list.sort_by(|a, b| pos(a).total_cmp(&pos(b)));
}

fn default_stops() -> (Vec<Stop>, Vec<OpacityStop>) {
    (
        vec![Stop { pos: 0.0, mid: 0.5, rgb: [0.0; 3], refers: None }, Stop { pos: 1.0, mid: 0.5, rgb: [255.0; 3], refers: None }],
        vec![OpacityStop { pos: 0.0, mid: 0.5, opacity: 1.0 }, OpacityStop { pos: 1.0, mid: 0.5, opacity: 1.0 }],
    )
}

impl Def {
    /// Any gradient the app stored (every 0.3 shape and version 2), as `normalizeGradient` reads it.
    pub(crate) fn parse(v: &Value) -> Def {
        match v.as_object() {
            Some(o) if o.get("gradientVersion").and_then(Value::as_u64) == Some(2) => Self::v2(o),
            Some(o) => Self::legacy(o),
            // Photoshop's new gradient, the app's default.
            None => {
                let (stops, opacity) = default_stops();
                Def { stops, opacity, method: Method::Perceptual, smoothness: 1.0, noise: None }
            }
        }
    }

    fn legacy(o: &serde_json::Map<String, Value>) -> Def {
        let fg = serde_json::json!({ "ref": "fg" });
        let bg = serde_json::json!({ "ref": "bg" });
        let raw: Vec<Value> = match o.get("stops") {
            // 0.3 tool presets named two stop lists
            Some(Value::String(s)) if s == "fgbg" => vec![serde_json::json!({"pos": 0, "color": fg}), serde_json::json!({"pos": 1, "color": bg})],
            Some(Value::String(s)) if s == "fgt" => {
                vec![serde_json::json!({"pos": 0, "color": fg}), serde_json::json!({"pos": 1, "color": fg, "opacity": 0})]
            }
            Some(Value::Array(a)) => a.iter().take(MAX_STOPS).cloned().collect(),
            _ => Vec::new(),
        };
        let (mut stops, mut opacity) = (Vec::new(), Vec::new());
        for s in &raw {
            let (pos, color, extra) = match s {
                Value::Array(a) => (num(a.first()), a.get(1), 1.0),
                Value::Object(m) => (
                    num(m.get("pos").or_else(|| m.get("offset")).or_else(|| m.get("position"))),
                    m.get("color"),
                    m.get("opacity").map_or(1.0, |v| clamp01(num(Some(v)).unwrap_or(1.0))),
                ),
                _ => continue,
            };
            let Some(pos) = pos else { continue };
            let pos = clamp01(pos);
            let rgba = stop_color(color);
            stops.push(Stop { pos, mid: 0.5, rgb: hex_rounded(rgba), refers: stop_ref(color) });
            opacity.push(OpacityStop { pos, mid: 0.5, opacity: clamp01(rgba[3]) * extra });
        }
        if stops.is_empty() {
            (stops, opacity) = default_stops();
        }
        sort_stable(&mut stops, |s| s.pos);
        sort_stable(&mut opacity, |s| s.pos);
        Def { stops, opacity, method: Method::Classic, smoothness: 0.0, noise: None }
    }

    fn v2(o: &serde_json::Map<String, Value>) -> Def {
        let list = |key: &str| {
            o.get(key).and_then(Value::as_array).map(|a| a.iter().take(MAX_STOPS).filter_map(Value::as_object).collect::<Vec<_>>()).unwrap_or_default()
        };
        let mid = |m: &serde_json::Map<String, Value>| num(m.get("mid")).unwrap_or(0.5).clamp(0.05, 0.95);
        let mut stops: Vec<Stop> = list("stops")
            .into_iter()
            .filter_map(|m| {
                Some(Stop { pos: clamp01(num(m.get("pos"))?), mid: mid(m), rgb: hex_rounded(stop_color(m.get("color"))), refers: stop_ref(m.get("color")) })
            })
            .collect();
        let mut opacity: Vec<OpacityStop> = list("opacityStops")
            .into_iter()
            .filter_map(|m| Some(OpacityStop { pos: clamp01(num(m.get("pos"))?), mid: mid(m), opacity: clamp01(num(m.get("opacity")).unwrap_or(1.0)) }))
            .collect();
        let (default_colors, default_opacity) = default_stops();
        if stops.is_empty() {
            stops = default_colors;
        }
        if opacity.is_empty() {
            opacity = default_opacity;
        }
        sort_stable(&mut stops, |s| s.pos);
        sort_stable(&mut opacity, |s| s.pos);
        let noisy = o.get("type").and_then(Value::as_str) == Some("noise");
        let noise = (noisy || o.get("noise").is_some_and(Value::is_object)).then(|| {
            let n = o.get("noise").and_then(Value::as_object);
            let get = |k: &str| n.and_then(|n| n.get(k));
            let triple = |k: &str, d: [f64; 3]| match get(k).and_then(Value::as_array) {
                Some(a) if a.len() >= 3 => [0, 1, 2].map(|i| clamp01(num(a.get(i)).unwrap_or(d[i]))),
                _ => d,
            };
            let (min, max) = (triple("min", [0.0; 3]), triple("max", [1.0; 3]));
            NoiseGradient {
                roughness: clamp01(num(get("roughness")).unwrap_or(0.5)) as f32,
                model: match get("model").and_then(Value::as_str) {
                    Some("hsb") => NoiseModel::Hsb,
                    Some("lab") => NoiseModel::Lab,
                    _ => NoiseModel::Rgb,
                },
                // The app's alpha walk spans 0..1.
                min: [min[0] as f32, min[1] as f32, min[2] as f32, 0.0],
                max: [max[0] as f32, max[1] as f32, max[2] as f32, 1.0],
                restrict: get("restrict").is_some_and(truthy),
                transparency: get("transparency").is_some_and(truthy),
                seed: photocraft_doc::noise_gradient::seed_of(num(get("seed")).unwrap_or(1.0)),
            }
        });
        Def {
            stops,
            opacity,
            method: o.get("interpolation").and_then(Value::as_str).and_then(Method::from_name).unwrap_or(Method::Perceptual),
            smoothness: clamp01(num(o.get("smoothness")).unwrap_or(1.0)),
            noise: if noisy { noise } else { None },
        }
    }

    /// Whether PhotoCraft's linear interpolation between the stops draws the gradient exactly.
    fn is_plain(&self) -> bool {
        self.noise.is_none()
            && self.method == Method::Classic
            && self.smoothness == 0.0
            && self.stops.iter().all(|s| s.mid == 0.5)
            && self.opacity.iter().all(|s| s.mid == 0.5)
    }

    /// The colour at `t` (0..1): `[r, g, b]` in 0..255 and the opacity in 0..1 (`sampleGradient`).
    pub(crate) fn sample(&self, t: f64) -> [f64; 4] {
        let t = if t.is_finite() { clamp01(t) } else { 0.0 };
        if let Some(n) = &self.noise {
            let c = n.sample(t);
            return [c[0] * 255.0, c[1] * 255.0, c[2] * 255.0, c[3]];
        }
        let [r, g, b] = self.solid_rgb(t);
        [r, g, b, self.solid_alpha(t)]
    }

    fn solid_rgb(&self, t: f64) -> [f64; 3] {
        let list = &self.stops;
        if self.method == Method::Classic {
            let (a, b, f) = segment(list, t, |s| s.pos, |s| s.mid, self.smoothness);
            return [0, 1, 2].map(|c| a.rgb[c] + (b.rgb[c] - a.rgb[c]) * f);
        }
        let Some((k, f)) = locate(list, t, |s| s.pos) else {
            let k = if t <= list.first().map_or(0.0, |s| s.pos) { 0 } else { list.len().saturating_sub(1) };
            return list.get(k).map_or([0.0; 3], |s| s.rgb);
        };
        let (s0, s1) = (list[k], list[k + 1]);
        if self.method == Method::Stripes {
            return if f < s1.mid { s0.rgb } else { s1.rgb };
        }
        let u = bend(f, s1.mid, 0.0);
        match self.method {
            Method::Linear => {
                let (a, b) = (s0.rgb.map(to_lin), s1.rgb.map(to_lin));
                [0, 1, 2].map(|c| from_lin(a[c] + (b[c] - a[c]) * u).clamp(0.0, 255.0))
            }
            Method::Smooth => {
                let labs: Vec<[f64; 3]> = list.iter().map(|s| rgb_to_oklab(s.rgb)).collect();
                let xs: Vec<f64> = list.iter().map(|s| s.pos).collect();
                let h = s1.pos - s0.pos;
                let l = [0, 1, 2].map(|c| {
                    let ys: Vec<f64> = labs.iter().map(|v| v[c]).collect();
                    let m = monotone_tangents(&xs, &ys);
                    hermite(ys[k], ys[k + 1], m[k], m[k + 1], h, u)
                });
                oklab_to_rgb(l)
            }
            _ => {
                let (a, b) = (rgb_to_oklab(s0.rgb), rgb_to_oklab(s1.rgb));
                oklab_to_rgb([0, 1, 2].map(|c| a[c] + (b[c] - a[c]) * u))
            }
        }
    }

    fn solid_alpha(&self, t: f64) -> f64 {
        let list = &self.opacity;
        if self.method == Method::Classic {
            let (a, b, g) = segment(list, t, |s| s.pos, |s| s.mid, self.smoothness);
            return a.opacity + (b.opacity - a.opacity) * g;
        }
        let Some((k, f)) = locate(list, t, |s| s.pos) else {
            let k = if t <= list.first().map_or(0.0, |s| s.pos) { 0 } else { list.len().saturating_sub(1) };
            return list.get(k).map_or(1.0, |s| s.opacity);
        };
        let (s0, s1) = (list[k], list[k + 1]);
        if self.method == Method::Stripes {
            return if f < s1.mid { s0.opacity } else { s1.opacity };
        }
        let u = bend(f, s1.mid, 0.0);
        if self.method == Method::Smooth {
            let xs: Vec<f64> = list.iter().map(|s| s.pos).collect();
            let ys: Vec<f64> = list.iter().map(|s| s.opacity).collect();
            let m = monotone_tangents(&xs, &ys);
            return clamp01(hermite(s0.opacity, s1.opacity, m[k], m[k + 1], s1.pos - s0.pos, u));
        }
        s0.opacity + (s1.opacity - s0.opacity) * u
    }

    /// Where PhotoCraft needs stops: the gradient's own when they draw it exactly, else samples
    /// of what the app drew (both sides of every stop, so hard stops stay hard). Colour stops
    /// in 0..1 sRGB, opacity stops `(location, opacity)`; `reverse` runs them backwards.
    fn stops_and_opacity(&self, reverse: bool) -> Sampled {
        let flip = |t: f64| if reverse { 1.0 - t } else { t };
        let (mut colors, mut alphas): Sampled = if self.is_plain() {
            (self.stops.iter().map(|s| (flip(s.pos), s.rgb.map(|v| v / 255.0))).collect(), self.opacity.iter().map(|s| (flip(s.pos), s.opacity)).collect())
        } else {
            let mut marks: Vec<f64> = (0..=SAMPLES).map(|i| i as f64 / SAMPLES as f64).collect();
            let mut edges: Vec<f64> = self.stops.iter().map(|s| s.pos).chain(self.opacity.iter().map(|s| s.pos)).collect();
            if self.method == Method::Stripes {
                // Stripes change colour at each segment's midpoint.
                edges.extend(self.stops.windows(2).map(|w| w[0].pos + w[1].mid * (w[1].pos - w[0].pos)));
                edges.extend(self.opacity.windows(2).map(|w| w[0].pos + w[1].mid * (w[1].pos - w[0].pos)));
            }
            for p in edges {
                marks.extend([p - EPS, p + EPS].into_iter().filter(|v| (0.0..=1.0).contains(v)));
            }
            marks.sort_by(f64::total_cmp);
            marks.dedup();
            let samples: Vec<(f64, [f64; 4])> = marks.into_iter().map(|t| (flip(t), self.sample(t))).collect();
            (
                samples.iter().map(|(t, c)| (*t, [c[0], c[1], c[2]].map(|v| v.clamp(0.0, 255.0) / 255.0))).collect(),
                samples.iter().map(|(t, c)| (*t, clamp01(c[3]))).collect(),
            )
        };
        if reverse {
            colors.reverse();
            alphas.reverse();
        }
        (colors, alphas)
    }

    /// A fill's, a stroke's or an effect's colour and opacity stops, its Reverse and its noise:
    /// a noise gradient keeps its settings, with its bake as the stops and `reverse` as the
    /// flag; any other gradient is [`Self::fill_stops`] (reversed into the stops).
    pub(crate) fn paint(&self, reverse: bool) -> (Stops, bool, Option<NoiseGradient>) {
        match &self.noise {
            Some(n) => (n.fill_stops(), reverse, Some(n.clone())),
            None => (self.fill_stops(reverse), false, None),
        }
    }

    /// Colour stops (opaque) and opacity stops for a fill, a stroke or an effect.
    pub(crate) fn fill_stops(&self, reverse: bool) -> Stops {
        let (colors, alphas) = self.stops_and_opacity(reverse);
        (
            colors.into_iter().map(|(t, c)| (t as f32, Color::rgb(c[0] as f32, c[1] as f32, c[2] as f32))).collect(),
            alphas.into_iter().map(|(t, a)| (t as f32, a as f32)).collect(),
        )
    }

    /// The gradient as a preset of the Gradients panel: colour stops `(location, sRGB 0..1,
    /// reference)`, opacity stops and the noise settings, and whether the stops are samples.
    /// PhotoCraft's presets interpolate linearly: a gradient whose midpoints are all centred
    /// keeps its own stops (and its foreground / background references) whatever its
    /// interpolation method; one with moved midpoints or stripes is sampled ([`Self::fill_stops`]).
    pub(crate) fn preset(&self) -> PresetStops {
        if let Some(n) = &self.noise {
            let (c, a) = n.fill_stops();
            return PresetStops {
                colors: c.into_iter().map(|(t, c)| (t, [c.c[0], c.c[1], c.c[2]], None)).collect(),
                opacity: a,
                noise: Some(n.clone()),
                sampled: false,
            };
        }
        let centred = self.stops.iter().all(|s| s.mid == 0.5) && self.opacity.iter().all(|s| s.mid == 0.5) && self.method != Method::Stripes;
        if centred {
            return PresetStops {
                colors: self.stops.iter().map(|s| (s.pos as f32, s.rgb.map(|v| (v / 255.0) as f32), s.refers)).collect(),
                opacity: self.opacity.iter().map(|s| (s.pos as f32, s.opacity as f32)).collect(),
                noise: None,
                sampled: false,
            };
        }
        let (c, a) = self.fill_stops(false);
        PresetStops { colors: c.into_iter().map(|(t, c)| (t, [c.c[0], c.c[1], c.c[2]], None)).collect(), opacity: a, noise: None, sampled: true }
    }

    /// Gradient Map stops: the colours the app mapped grey levels to, in 0..1 sRGB, not
    /// reversed (the adjustment reverses them itself).
    pub(crate) fn map_stops(&self) -> Vec<(f32, [f32; 3])> {
        if let Some(n) = &self.noise {
            return n.bake().0;
        }
        self.stops_and_opacity(false).0.into_iter().map(|(t, c)| (t as f32, c.map(|v| v as f32))).collect()
    }

    /// The stops as PhotoCraft's Gradient Editor holds them, for the methods it has (not
    /// stripes); a noise gradient's knots with its settings.
    pub(crate) fn source(&self) -> Option<GradientSource> {
        if let Some(n) = &self.noise {
            let knots = n.knot_stops();
            return Some(GradientSource {
                midpoints: vec![0.5; knots.len().saturating_sub(1)],
                stops: knots,
                smoothness: 0.0,
                method: "classic".into(),
                noise: Some(n.clone()),
            });
        }
        if self.method == Method::Stripes {
            return None;
        }
        Some(GradientSource {
            stops: self.stops.iter().map(|s| (s.pos as f32, s.rgb.map(|v| (v / 255.0) as f32))).collect(),
            // The `mid` of a stop bends the segment that ends at it.
            midpoints: self.stops.iter().skip(1).map(|s| s.mid as f32).collect(),
            smoothness: self.smoothness as f32,
            method: self.method.name().to_string(),
            noise: None,
        })
    }

    /// The editable colour stops and method of an effect's gradient (see
    /// [`photocraft_doc::effects::GradientInterpolation`]), for the methods PhotoCraft has.
    pub(crate) fn interpolation(&self) -> Option<photocraft_doc::effects::GradientInterpolation> {
        if self.noise.is_some() {
            return None;
        }
        let src = self.source()?;
        Some(photocraft_doc::effects::GradientInterpolation {
            method: src.method,
            smoothness: src.smoothness,
            stops: src.stops.into_iter().map(|(t, c)| (t, Color::rgb(c[0], c[1], c[2]))).collect(),
        })
    }
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Null => false,
        _ => true,
    }
}

/// The interpolation parameter of a segment after its midpoint and Smoothness.
fn bend(u: f64, mid: f64, smoothness: f64) -> f64 {
    let mut v = if mid == 0.5 { u } else { u.powf(0.5f64.ln() / mid.ln()) };
    if smoothness > 0.0 {
        v += (v * v * (3.0 - 2.0 * v) - v) * smoothness;
    }
    v
}

/// The segment of `t`: (index of its first stop, unbent fraction), or `None` outside the stops.
fn locate<T>(list: &[T], t: f64, pos: impl Fn(&T) -> f64) -> Option<(usize, f64)> {
    let last = list.len().checked_sub(1)?;
    if t <= pos(&list[0]) || t >= pos(&list[last]) {
        return None;
    }
    let mut k = 0;
    while k + 1 < last && pos(&list[k + 1]) < t {
        k += 1;
    }
    let (p0, p1) = (pos(&list[k]), pos(&list[k + 1]));
    Some((k, if p1 > p0 { (t - p0) / (p1 - p0) } else { 1.0 }))
}

fn segment<T: Copy>(list: &[T], t: f64, pos: impl Fn(&T) -> f64, mid: impl Fn(&T) -> f64, smoothness: f64) -> (T, T, f64) {
    match locate(list, t, &pos) {
        Some((k, f)) => (list[k], list[k + 1], bend(f, mid(&list[k + 1]), smoothness)),
        None => {
            let s = if t <= pos(&list[0]) { list[0] } else { list[list.len() - 1] };
            (s, s, 0.0)
        }
    }
}

fn to_lin(c: f64) -> f64 {
    let v = c / 255.0;
    if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
}

fn from_lin(v: f64) -> f64 {
    255.0 * if v <= 0.003_130_8 { 12.92 * v } else { 1.055 * v.max(0.0).powf(1.0 / 2.4) - 0.055 }
}

fn rgb_to_oklab(c: [f64; 3]) -> [f64; 3] {
    let [r, g, b] = c.map(to_lin);
    let l = (0.412_221_470_8 * r + 0.536_332_536_3 * g + 0.051_445_992_9 * b).cbrt();
    let m = (0.211_903_498_2 * r + 0.680_699_545_1 * g + 0.107_396_956_6 * b).cbrt();
    let s = (0.088_302_461_9 * r + 0.281_718_837_6 * g + 0.629_978_700_5 * b).cbrt();
    [
        0.210_454_255_3 * l + 0.793_617_785 * m - 0.004_072_046_8 * s,
        1.977_998_495_1 * l - 2.428_592_205 * m + 0.450_593_709_9 * s,
        0.025_904_037_1 * l + 0.782_771_766_2 * m - 0.808_675_766 * s,
    ]
}

fn oklab_to_rgb(p: [f64; 3]) -> [f64; 3] {
    let l = (p[0] + 0.396_337_777_4 * p[1] + 0.215_803_757_3 * p[2]).powi(3);
    let m = (p[0] - 0.105_561_345_8 * p[1] - 0.063_854_172_8 * p[2]).powi(3);
    let s = (p[0] - 0.089_484_177_5 * p[1] - 1.291_485_548 * p[2]).powi(3);
    [
        4.076_741_662_1 * l - 3.307_711_591_3 * m + 0.230_969_929_2 * s,
        -1.268_438_004_6 * l + 2.609_757_401_1 * m - 0.341_319_396_5 * s,
        -0.004_196_086_3 * l - 0.703_418_614_7 * m + 1.707_614_701 * s,
    ]
    .map(|v| from_lin(v).clamp(0.0, 255.0))
}

/// Fritsch–Carlson tangents: the curve through every stop without overshoot.
fn monotone_tangents(xs: &[f64], ys: &[f64]) -> Vec<f64> {
    let n = xs.len();
    let mut m = vec![0.0; n];
    if n < 2 {
        return m;
    }
    let d: Vec<f64> = (0..n - 1).map(|i| if xs[i + 1] - xs[i] > 1e-9 { (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]) } else { 0.0 }).collect();
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for i in 1..n - 1 {
        m[i] = if d[i - 1] * d[i] <= 0.0 { 0.0 } else { (d[i - 1] + d[i]) / 2.0 };
    }
    for i in 0..n - 1 {
        if d[i] == 0.0 {
            m[i] = 0.0;
            m[i + 1] = 0.0;
            continue;
        }
        let (a, b) = (m[i] / d[i], m[i + 1] / d[i]);
        let r = a * a + b * b;
        if r > 9.0 {
            let tau = 3.0 / r.sqrt();
            m[i] = tau * a * d[i];
            m[i + 1] = tau * b * d[i];
        }
    }
    m
}

fn hermite(y0: f64, y1: f64, m0: f64, m1: f64, h: f64, u: f64) -> f64 {
    let (u2, u3) = (u * u, u * u * u);
    (2.0 * u3 - 3.0 * u2 + 1.0) * y0 + (u3 - 2.0 * u2 + u) * h * m0 + (-2.0 * u3 + 3.0 * u2) * y1 + (u3 - u2) * h * m1
}

/// `hslToRgb` of shared/pixels/color.js (`s`, `l` in 0..1): 0..255.
pub(crate) fn hsl_to_rgb(h: f64, s: f64, l: f64) -> [f64; 3] {
    let hh = h.rem_euclid(360.0) / 360.0;
    if s <= 0.0 {
        return [l * 255.0; 3];
    }
    let q = if l < 0.5 { l * (1.0 + s) } else { l + s - l * s };
    let p = 2.0 * l - q;
    let f = |mut t: f64| {
        if t < 0.0 {
            t += 1.0;
        }
        if t > 1.0 {
            t -= 1.0;
        }
        if t < 1.0 / 6.0 {
            p + (q - p) * 6.0 * t
        } else if t < 0.5 {
            q
        } else if t < 2.0 / 3.0 {
            p + (q - p) * (2.0 / 3.0 - t) * 6.0
        } else {
            p
        }
    };
    [f(hh + 1.0 / 3.0) * 255.0, f(hh) * 255.0, f(hh - 1.0 / 3.0) * 255.0]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_03_gradient_keeps_its_stops_and_their_alpha() {
        let d = Def::parse(&json!({"kind": "linear", "stops": [{"pos": 1, "color": "#0000ff"}, {"offset": 0, "color": "#ff000080"}, [0.5, "#00ff00"]]}));
        assert_eq!(d.method, Method::Classic);
        let (colors, alphas) = d.fill_stops(false);
        assert_eq!(colors.iter().map(|s| s.0).collect::<Vec<_>>(), [0.0, 0.5, 1.0]);
        assert_eq!(colors[0].1, Color::rgb(1.0, 0.0, 0.0));
        assert!((alphas[0].1 - 128.0 / 255.0).abs() < 1e-6 && alphas[2].1 == 1.0);
        let (rev, _) = d.fill_stops(true);
        assert_eq!(rev.iter().map(|s| s.0).collect::<Vec<_>>(), [0.0, 0.5, 1.0]);
        assert_eq!(rev[0].1, Color::rgb(0.0, 0.0, 1.0));
        // Midway between red and green, in sRGB, as 0.3 drew it.
        let mid = d.sample(0.25);
        assert_eq!([mid[0].round(), mid[1].round(), mid[2].round()], [128.0, 128.0, 0.0]);
    }

    #[test]
    fn a_bent_gradient_is_sampled() {
        let d = Def::parse(&json!({"gradientVersion": 2, "interpolation": "perceptual", "smoothness": 1,
            "stops": [{"pos": 0, "mid": 0.5, "color": "#000000"}, {"pos": 1, "mid": 0.3, "color": "#ffffff"}]}));
        assert_eq!(d.method, Method::Perceptual);
        let (colors, alphas) = d.fill_stops(false);
        assert!(colors.len() > SAMPLES && alphas.len() == colors.len());
        // A midpoint at 30 %: the middle grey is reached before the middle.
        let at = d.sample(0.3);
        let half = oklab_to_rgb([0.5 * rgb_to_oklab([255.0; 3])[0], 0.0, 0.0]);
        assert!((at[0] - half[0]).abs() < 1.0, "{at:?} {half:?}");
        let src = d.source().unwrap();
        assert_eq!((src.method.as_str(), src.smoothness, src.midpoints.as_slice()), ("perceptual", 1.0, [0.3f32].as_slice()));
        // Missing fields take Photoshop's new-gradient defaults.
        let e = Def::parse(&json!({"gradientVersion": 2}));
        assert_eq!((e.method, e.smoothness, e.stops.len()), (Method::Perceptual, 1.0, 2));
    }

    #[test]
    fn stripes_and_noise() {
        let d = Def::parse(&json!({"gradientVersion": 2, "interpolation": "stripes", "smoothness": 0,
            "stops": [{"pos": 0, "mid": 0.5, "color": "#ff0000"}, {"pos": 1, "mid": 0.25, "color": "#0000ff"}]}));
        assert_eq!(d.sample(0.2)[..3], [255.0, 0.0, 0.0]);
        assert_eq!(d.sample(0.3)[..3], [0.0, 0.0, 255.0]);
        assert!(d.source().is_none());
        let n = Def::parse(&json!({"gradientVersion": 2, "type": "noise", "noise": {"roughness": 0.4, "seed": 7}}));
        assert!(n.noise.is_some() && n.source().is_some_and(|s| s.noise == n.noise && s.stops.len() == 27));
        // The same seed, the same gradient; another seed, another one.
        assert_eq!(n.sample(0.37), Def::parse(&json!({"gradientVersion": 2, "type": "noise", "noise": {"roughness": 0.4, "seed": 7}})).sample(0.37));
        assert_ne!(n.sample(0.37), Def::parse(&json!({"gradientVersion": 2, "type": "noise", "noise": {"roughness": 0.4, "seed": 8}})).sample(0.37));
        for t in [0.0, 0.5, 1.0, f64::NAN] {
            assert!(n.sample(t).iter().all(|v| v.is_finite()));
        }
    }

    #[test]
    fn colours_the_app_read() {
        assert_eq!(parse_color(&json!("#abc")), Some([170.0, 187.0, 204.0, 1.0]));
        assert_eq!(parse_color(&json!("rgba(1, 2, 3, 50%)")), Some([1.0, 2.0, 3.0, 0.5]));
        assert_eq!(parse_color(&json!([1, 2])), Some([1.0, 2.0, 0.0, 1.0]));
        assert_eq!(parse_color(&json!("#é1234")), None);
        assert_eq!(parse_color(&json!("chartreuse")), None);
    }
}
