//! Pigment: noise gradients (the Gradient Editor's Gradient Type: Noise), as the JavaScript
//! Pigment drew them (`shared/pixels/gradient-model.js`: `NOISE_DEFAULTS`, `seededRandom`,
//! `noiseKnots`, `noiseSample`).
//!
//! A noise gradient is a seeded random walk per channel (three colour channels in its colour
//! model, and alpha) over a number of knots that grows with the roughness, kept inside each
//! channel's minimum and maximum and joined by straight lines; Restrict Colors pulls the
//! saturation under 85 %. The same settings and seed give the same gradient, so a Pigment 0.4
//! noise gradient looks the same here.
//!
//! The renderers know nothing of noise: a fill, an effect, a Gradient Map or a preset that holds
//! a [`NoiseGradient`] holds its [`NoiseGradient::bake`] as its stops, and whoever changes the
//! settings rebakes them (whoever edits the stops drops the noise).

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::Color;

/// Between two knots of a gradient that straight RGB lines do not draw (HSB, Lab, Restrict
/// Colors; PhotoCraft interpolates its stops linearly in RGB), halves are added until the middle
/// is within [`TOLERANCE`] of the line, at most this deep (64 stops per knot).
const MAX_DEPTH: u32 = 6;
/// A third of an 8-bit level.
const TOLERANCE: f64 = 1.0 / 765.0;

/// Appends the stops after `a` up to `b` (included) that draw `f` between them within
/// [`TOLERANCE`].
fn refine(f: &impl Fn(f64) -> [f64; 3], a: (f64, [f64; 3]), b: (f64, [f64; 3]), depth: u32, out: &mut Vec<(f64, [f64; 3])>) {
    let tm = (a.0 + b.0) / 2.0;
    let m = f(tm);
    let off = (0..3).map(|c| (m[c] - (a.1[c] + b.1[c]) / 2.0).abs()).fold(0.0, f64::max);
    if depth > 0 && off > TOLERANCE {
        refine(f, a, (tm, m), depth - 1, out);
        refine(f, (tm, m), b, depth - 1, out);
    } else {
        out.push(b);
    }
}

/// Colour stops `(location, sRGB 0..1)` and opacity stops `(location, opacity)`.
pub type MapStops = (Vec<(f32, [f32; 3])>, Vec<(f32, f32)>);
/// Colour stops and opacity stops as fills and effects keep them.
pub type FillStops = (Vec<(f32, Color)>, Vec<(f32, f32)>);

/// The colour model a noise gradient walks in (Photoshop's `ClrS`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoiseModel {
    #[default]
    Rgb,
    Hsb,
    Lab,
}

impl NoiseModel {
    /// `rgb`, `hsb` or `lab`.
    pub fn name(self) -> &'static str {
        match self {
            NoiseModel::Rgb => "rgb",
            NoiseModel::Hsb => "hsb",
            NoiseModel::Lab => "lab",
        }
    }
    pub fn from_name(s: &str) -> Option<NoiseModel> {
        Some(match s.to_ascii_lowercase().as_str() {
            "rgb" => NoiseModel::Rgb,
            "hsb" | "hsv" => NoiseModel::Hsb,
            "lab" => NoiseModel::Lab,
            _ => return None,
        })
    }
}

/// A noise gradient's settings. Channel ranges are 0..1 of the model's channel (R, G, B; H, S, B;
/// L, a, b), alpha last (used with `transparency`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct NoiseGradient {
    /// 0..1 (Photoshop's Roughness 0..100 %).
    pub roughness: f32,
    pub model: NoiseModel,
    pub min: [f32; 4],
    pub max: [f32; 4],
    /// Restrict Colors: no colour more than 85 % saturated.
    pub restrict: bool,
    /// Add Transparency: the alpha walks too.
    pub transparency: bool,
    pub seed: u32,
}

impl Default for NoiseGradient {
    /// The JavaScript Pigment's new noise gradient (`NOISE_DEFAULTS`).
    fn default() -> Self {
        NoiseGradient { roughness: 0.5, model: NoiseModel::Rgb, min: [0.0; 4], max: [1.0; 4], restrict: false, transparency: false, seed: 1 }
    }
}

fn unit(v: f32, default: f32) -> f64 {
    f64::from(if v.is_finite() { v.clamp(0.0, 1.0) } else { default })
}

/// mulberry32, as `seededRandom` (the same sequence for the same seed).
struct Mulberry(u32);

impl Mulberry {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }
}

/// A seed as the app took one: `Math.trunc(seed) | 0`, the seed modulo 2³² (0 for NaN).
pub fn seed_of(v: f64) -> u32 {
    if v.is_finite() { v.trunc().rem_euclid(4_294_967_296.0) as u32 } else { 0 }
}

/// The knots of a noise gradient (`noiseKnots`): per channel (three colour channels, then
/// alpha) `count` values in 0..1.
struct Knots {
    count: usize,
    ch: [Vec<f64>; 4],
}

impl NoiseGradient {
    fn knots(&self) -> Knots {
        let rough = unit(self.roughness, 0.5);
        let count = 3 + (rough * 61.0).round() as usize;
        let step = 0.12 + 0.88 * rough;
        let mut rand = Mulberry(self.seed);
        let mut ch = [vec![0.0; count], vec![0.0; count], vec![0.0; count], vec![0.0; count]];
        for c in &mut ch {
            let mut v = rand.next();
            for (i, k) in c.iter_mut().enumerate() {
                if i > 0 {
                    v += (rand.next() * 2.0 - 1.0) * step;
                    // Reflected at the edges, so the walk keeps moving.
                    if v < 0.0 {
                        v = -v;
                    }
                    if v > 1.0 {
                        v = 2.0 - v;
                    }
                    v = v.clamp(0.0, 1.0);
                }
                *k = v;
            }
        }
        Knots { count, ch }
    }

    fn range(&self, c: usize) -> (f64, f64) {
        let lo = self.min.get(c).copied().unwrap_or(0.0);
        let hi = self.max.get(c).copied().unwrap_or(1.0);
        (unit(lo, 0.0), unit(hi, 1.0))
    }

    /// The colour at `t` (0..1) from the knots: sRGB 0..1 and the opacity (`noiseSample`).
    fn sample_with(&self, k: &Knots, t: f64) -> [f64; 4] {
        let t = if t.is_finite() { t.clamp(0.0, 1.0) } else { 0.0 };
        let x = t * (k.count - 1) as f64;
        let i = (x.floor() as usize).min(k.count - 2);
        let f = x - i as f64;
        let at = |c: usize| {
            let (a, b) = (k.ch[c].get(i).copied().unwrap_or(0.0), k.ch[c].get(i + 1).copied().unwrap_or(0.0));
            a + (b - a) * f
        };
        let v = [0, 1, 2].map(|c| {
            let (lo, hi) = self.range(c);
            lo + (hi - lo) * at(c)
        });
        let mut rgb = match self.model {
            NoiseModel::Hsb => hsv_to_rgb(v[0] * 360.0, v[1], v[2]).map(|c| c / 255.0),
            NoiseModel::Lab => lab_to_rgb(v[0] * 100.0, v[1] * 255.0 - 128.0, v[2] * 255.0 - 128.0).map(|c| c / 255.0),
            NoiseModel::Rgb => v,
        };
        if self.restrict {
            let (max, min) = (rgb[0].max(rgb[1]).max(rgb[2]), rgb[0].min(rgb[1]).min(rgb[2]));
            let s = if max > 0.0 { (max - min) / max } else { 0.0 };
            if s > 0.85 {
                let k = 0.85 / s;
                rgb = rgb.map(|c| max - (max - c) * k);
            }
        }
        let alpha = if self.transparency {
            let (lo, hi) = self.range(3);
            lo + (hi - lo) * at(3)
        } else {
            1.0
        };
        [rgb[0].clamp(0.0, 1.0), rgb[1].clamp(0.0, 1.0), rgb[2].clamp(0.0, 1.0), alpha.clamp(0.0, 1.0)]
    }

    /// The colour at `t` (0..1): sRGB `[r, g, b]` 0..1 and the opacity 0..1.
    pub fn sample(&self, t: f64) -> [f64; 4] {
        self.sample_with(&self.knots(), t)
    }

    /// Whether every colour channel's minimum equals its maximum (one colour, whatever the seed).
    fn flat_color(&self) -> bool {
        (0..3).all(|c| {
            let (lo, hi) = self.range(c);
            lo == hi
        })
    }

    /// The gradient as dense stops: colour stops `(location, sRGB 0..1)` at every knot (and, where
    /// straight RGB lines between knots would not draw it, as many between as it takes), and opacity stops
    /// `(location, opacity)` at every knot, empty when opaque. One colour (each channel's minimum
    /// equal to its maximum) gives two stops of exactly that colour.
    pub fn bake(&self) -> MapStops {
        let k = self.knots();
        let knot_at: Vec<f64> = (0..k.count).map(|i| i as f64 / (k.count - 1) as f64).collect();
        let colors: Vec<(f32, [f32; 3])> = if self.flat_color() {
            // One colour exactly, as chosen (Restrict Colors leaves it; upstream reads
            // Photoshop's constant noise gradients so, `blocks::constant_rgb_noise_color`).
            let flat = NoiseGradient { restrict: false, ..self.clone() };
            let c = flat.sample_with(&k, 0.0);
            let c = [c[0] as f32, c[1] as f32, c[2] as f32];
            vec![(0.0, c), (1.0, c)]
        } else {
            let rgb = |t: f64| {
                let c = self.sample_with(&k, t);
                [c[0], c[1], c[2]]
            };
            let mut out = vec![(0.0, rgb(0.0))];
            for w in knot_at.windows(2) {
                let (t0, t1) = (w[0], w[1]);
                if self.model == NoiseModel::Rgb && !self.restrict {
                    out.push((t1, rgb(t1)));
                } else {
                    refine(&rgb, (t0, rgb(t0)), (t1, rgb(t1)), MAX_DEPTH, &mut out);
                }
            }
            out.into_iter().map(|(t, c)| (t as f32, c.map(|v| v as f32))).collect()
        };
        let opacity: Vec<(f32, f32)> = if !self.transparency {
            Vec::new()
        } else {
            let (lo, hi) = self.range(3);
            if lo == hi {
                if lo >= 1.0 { Vec::new() } else { vec![(0.0, lo as f32), (1.0, lo as f32)] }
            } else {
                knot_at.iter().map(|&t| (t as f32, self.sample_with(&k, t)[3] as f32)).collect()
            }
        };
        (colors, opacity)
    }

    /// [`Self::bake`] as a fill's or an effect's colour and opacity stops.
    pub fn fill_stops(&self) -> FillStops {
        let (c, o) = self.bake();
        (c.into_iter().map(|(t, c)| (t, Color::rgb(c[0], c[1], c[2]))).collect(), o)
    }

    /// The colour at each knot (at most 64, so a Gradient Map's editable stops can show them).
    pub fn knot_stops(&self) -> Vec<(f32, [f32; 3])> {
        let k = self.knots();
        (0..k.count)
            .map(|i| {
                let t = i as f64 / (k.count - 1) as f64;
                let c = self.sample_with(&k, t);
                (t as f32, [c[0] as f32, c[1] as f32, c[2] as f32])
            })
            .collect()
    }

    /// This gradient with every number in range (non-finite ones at their defaults).
    pub fn sanitized(&self) -> NoiseGradient {
        let d = NoiseGradient::default();
        NoiseGradient {
            roughness: unit(self.roughness, d.roughness) as f32,
            min: std::array::from_fn(|c| unit(self.min[c], d.min[c]) as f32),
            max: std::array::from_fn(|c| unit(self.max[c], d.max[c]) as f32),
            ..self.clone()
        }
    }

    /// The settings as commands take them: `{"roughness": 0..100, "model": "rgb|hsb|lab",
    /// "min": [4 × 0..100], "max": [4 × 0..100], "restrict", "transparency", "seed"}`.
    pub fn to_json(&self) -> Value {
        let pct = |v: f32| f64::from((v * 1000.0).round() / 10.0);
        json!({
            "roughness": pct(self.roughness),
            "model": self.model.name(),
            "min": self.min.map(pct),
            "max": self.max.map(pct),
            "restrict": self.restrict,
            "transparency": self.transparency,
            "seed": self.seed,
        })
    }

    /// [`Self::to_json`] read back: missing keys keep `base`'s value; `min`/`max` take three
    /// (colour) or four (with alpha) numbers; the seed any number (taken modulo 2³²).
    pub fn from_json_over(base: &NoiseGradient, v: &Value) -> Result<NoiseGradient, String> {
        let o = v.as_object().ok_or("`noise` must be {roughness, model, min, max, restrict, transparency, seed}")?;
        let mut n = base.clone();
        let num = |k: &str| -> Result<Option<f64>, String> {
            match o.get(k) {
                None | Some(Value::Null) => Ok(None),
                Some(x) => x.as_f64().filter(|x| x.is_finite()).map(Some).ok_or_else(|| format!("`noise.{k}` must be a number")),
            }
        };
        if let Some(r) = num("roughness")? {
            n.roughness = (r / 100.0).clamp(0.0, 1.0) as f32;
        }
        if let Some(m) = o.get("model") {
            n.model = m.as_str().and_then(NoiseModel::from_name).ok_or("`noise.model` must be rgb, hsb or lab")?;
        }
        for (key, slot) in [("min", &mut n.min), ("max", &mut n.max)] {
            match o.get(key) {
                None | Some(Value::Null) => {}
                Some(Value::Array(a)) if a.len() == 3 || a.len() == 4 => {
                    for (i, x) in a.iter().enumerate() {
                        let x = x.as_f64().filter(|x| x.is_finite()).ok_or_else(|| format!("`noise.{key}` holds numbers 0..100"))?;
                        if let Some(s) = slot.get_mut(i) {
                            *s = (x / 100.0).clamp(0.0, 1.0) as f32;
                        }
                    }
                }
                Some(_) => return Err(format!("`noise.{key}` must be 3 or 4 numbers 0..100")),
            }
        }
        for (key, slot) in [("restrict", &mut n.restrict), ("transparency", &mut n.transparency)] {
            match o.get(key) {
                None | Some(Value::Null) => {}
                Some(Value::Bool(b)) => *slot = *b,
                Some(_) => return Err(format!("`noise.{key}` must be true or false")),
            }
        }
        if let Some(s) = num("seed")? {
            n.seed = seed_of(s);
        }
        Ok(n)
    }

    /// [`Self::from_json_over`] the defaults.
    pub fn from_json(v: &Value) -> Result<NoiseGradient, String> {
        Self::from_json_over(&NoiseGradient::default(), v)
    }
}

/// `hsvToRgb` of the app's color.js: hue in degrees, `s`, `v` 0..1; 0..255.
pub fn hsv_to_rgb(h: f64, s: f64, v: f64) -> [f64; 3] {
    let hh = h.rem_euclid(360.0) / 60.0;
    let i = hh.floor();
    let f = hh - i;
    let (p, q, t) = (v * (1.0 - s), v * (1.0 - s * f), v * (1.0 - s * (1.0 - f)));
    let [r, g, b] = match (i as i64).rem_euclid(6) {
        0 => [v, t, p],
        1 => [q, v, p],
        2 => [p, v, t],
        3 => [p, q, v],
        4 => [t, p, v],
        _ => [v, p, q],
    };
    [r * 255.0, g * 255.0, b * 255.0]
}

/// `labToRgb` of the app's color.js (D65, sRGB): 0..255.
pub fn lab_to_rgb(l: f64, a: f64, b: f64) -> [f64; 3] {
    const XN: f64 = 0.95047;
    const ZN: f64 = 1.08883;
    let finv = |t: f64| if t > 0.206_893 { t * t * t } else { (t - 16.0 / 116.0) / 7.787 };
    let fy = (l + 16.0) / 116.0;
    let (fx, fz) = (fy + a / 500.0, fy - b / 200.0);
    let (x, y, z) = (finv(fx) * XN, finv(fy), finv(fz) * ZN);
    let r = x * 3.240_454_2 + y * -1.537_138_5 + z * -0.498_531_4;
    let g = x * -0.969_266 + y * 1.876_010_8 + z * 0.041_556;
    let bb = x * 0.055_643_4 + y * -0.204_025_9 + z * 1.057_225_2;
    [r, g, bb].map(|v| {
        let s = if v <= 0.003_130_8 { 12.92 * v } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 };
        (s * 255.0).clamp(0.0, 255.0)
    })
}

#[cfg(test)]
mod tests;
