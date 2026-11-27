//! Pigment: Photoshop's Auto Color Correction Options, the algorithms behind Auto in Levels, Curves
//! and Brightness/Contrast and behind Image › Auto Tone, Auto Contrast and Auto Color once options
//! are saved as the defaults.
//!
//! Ported line for line from the JavaScript Pigment 0.4 (`src/shared/pixels/adjust-tonal.js`:
//! `AUTO_DEFAULTS`, `autoOptions`, `clipRange`, `gammaFor`, `autoLevelsParams`, `darkLightColors`,
//! `neutralSample`, `autoTonalParams`, `curvePointsFromLevels`; `autoBrightnessContrast` from
//! `src/renderer/lib/adjust/simple-editors.js`), so a user of that app gets the same Auto results.
//! Everything is in 8-bit levels (0..=255), as there, and pure: the caller samples the image
//! ([`Sample`]) and turns the result into its own adjustment.

/// The four algorithms of the dialog.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum AutoAlgorithm {
    /// Enhance Monochromatic Contrast: one stretch of the luminosity for every channel (Auto Contrast).
    Monochromatic,
    /// Enhance Per Channel Contrast: each channel stretched on its own (Auto Tone, the default).
    #[default]
    PerChannel,
    /// Find Dark & Light Colors: the average darkest and lightest colours become the targets (Auto Color).
    DarkLight,
    /// Enhance Brightness and Contrast: the monochromatic stretch, then a gamma that brings the median to the middle.
    BrightnessContrast,
}

impl AutoAlgorithm {
    /// Every algorithm, in the dialog's order (Photoshop's).
    pub const ALL: [AutoAlgorithm; 4] = [AutoAlgorithm::BrightnessContrast, AutoAlgorithm::Monochromatic, AutoAlgorithm::PerChannel, AutoAlgorithm::DarkLight];

    /// The id in preferences and command params.
    pub fn id(self) -> &'static str {
        match self {
            AutoAlgorithm::Monochromatic => "monochromatic",
            AutoAlgorithm::PerChannel => "perChannel",
            AutoAlgorithm::DarkLight => "darkLight",
            AutoAlgorithm::BrightnessContrast => "brightnessContrast",
        }
    }

    /// The algorithm of an id; the JavaScript app's own ids (`mono`, `brightness`) are read too.
    pub fn parse(id: &str) -> Option<AutoAlgorithm> {
        Some(match id {
            "monochromatic" | "mono" => AutoAlgorithm::Monochromatic,
            "perChannel" => AutoAlgorithm::PerChannel,
            "darkLight" => AutoAlgorithm::DarkLight,
            "brightnessContrast" | "brightness" => AutoAlgorithm::BrightnessContrast,
            _ => return None,
        })
    }
}

/// The largest clipping percentage (Photoshop's fields stop at 9.99 %).
pub const MAX_CLIP: f32 = 9.99;
/// The default clipping percentage at each end.
pub const DEFAULT_CLIP: f32 = 0.1;

/// Auto Color Correction Options. `Default` is the dialog's defaults (JS `AUTO_DEFAULTS`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AutoOptions {
    pub algorithm: AutoAlgorithm,
    /// Snap Neutral Midtones.
    pub snap_neutral: bool,
    /// Shadows Clip, percent (0..=9.99).
    pub shadow_clip: f32,
    /// Highlights Clip, percent (0..=9.99).
    pub highlight_clip: f32,
    /// The target colours, 8-bit RGB.
    pub shadow: [u8; 3],
    pub midtone: [u8; 3],
    pub highlight: [u8; 3],
}

impl Default for AutoOptions {
    fn default() -> Self {
        AutoOptions {
            algorithm: AutoAlgorithm::PerChannel,
            snap_neutral: false,
            shadow_clip: DEFAULT_CLIP,
            highlight_clip: DEFAULT_CLIP,
            shadow: [0; 3],
            midtone: [128; 3],
            highlight: [255; 3],
        }
    }
}

/// A clipping percentage as the dialog keeps it: within 0..=9.99, the default for a non-number (JS `autoOptions`).
pub fn clamp_clip(v: f64) -> f32 {
    if v.is_finite() { v.clamp(0.0, f64::from(MAX_CLIP)) as f32 } else { DEFAULT_CLIP }
}

impl AutoOptions {
    /// The options with the clipping percentages held to 0..=9.99.
    pub fn clamped(self) -> Self {
        AutoOptions { shadow_clip: clamp_clip(f64::from(self.shadow_clip)), highlight_clip: clamp_clip(f64::from(self.highlight_clip)), ..self }
    }

    /// Black shadows and white highlights (the targets Photoshop starts with).
    pub fn neutral_ends(&self) -> bool {
        self.shadow == [0; 3] && self.highlight == [255; 3]
    }
}

/// One Levels record in 8-bit levels: input black and white (0..=255), midtone gamma, output black and white.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Levels5 {
    pub in_black: f64,
    pub in_white: f64,
    pub gamma: f64,
    pub out_black: f64,
    pub out_white: f64,
}

impl Levels5 {
    /// The identity record.
    pub const IDENTITY: Levels5 = Levels5 { in_black: 0.0, in_white: 255.0, gamma: 1.0, out_black: 0.0, out_white: 255.0 };

    /// JS `levelsOf`: the gamma held to hundredths.
    fn of(lo: f64, hi: f64, out_black: f64, out_white: f64, gamma: f64) -> Levels5 {
        Levels5 { in_black: lo, in_white: hi, gamma: js_round(gamma * 100.0) / 100.0, out_black, out_white }
    }

    /// The record as a 256-entry table (JS `levelsLut`, rounded half up and clamped as its `Uint8ClampedArray`).
    pub fn lut(&self) -> [u8; 256] {
        let num = |v: f64, fallback: f64| if v.is_finite() { v } else { fallback };
        let in_b = num(self.in_black, 0.0).clamp(0.0, 255.0);
        let mut in_w = num(self.in_white, 255.0).clamp(0.0, 255.0);
        if in_w <= in_b {
            in_w = in_b + 1.0;
        }
        let gamma = num(self.gamma, 1.0).clamp(0.01, 9.99);
        let out_b = num(self.out_black, 0.0).clamp(0.0, 255.0);
        let out_w = num(self.out_white, 255.0).clamp(0.0, 255.0);
        let (inv, range, out_range) = (1.0 / gamma, in_w - in_b, out_w - out_b);
        let mut lut = [0u8; 256];
        for (v, slot) in lut.iter_mut().enumerate() {
            let mut t = ((v as f64 - in_b) / range).clamp(0.0, 1.0);
            if gamma != 1.0 {
                t = t.powf(inv);
            }
            *slot = js_round(out_b + t * out_range).clamp(0.0, 255.0) as u8;
        }
        lut
    }
}

/// What [`auto_levels`] sets: the composite record and, when the result differs per channel, the red, green and
/// blue records (JS `rgb` and `r`/`g`/`b`, which it leaves `null` otherwise).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AutoLevels {
    pub composite: Levels5,
    pub channels: Option<[Levels5; 3]>,
}

impl AutoLevels {
    const NONE: AutoLevels = AutoLevels { composite: Levels5::IDENTITY, channels: None };
}

/// JS `Math.round`: halves round up.
fn js_round(v: f64) -> f64 {
    (v + 0.5).floor()
}

/// Integer Rec. 601 luma of 8-bit channels (JS `lumaInt`).
pub fn luma(rgb: [u8; 3]) -> u8 {
    (0.299 * f64::from(rgb[0]) + 0.587 * f64::from(rgb[1]) + 0.114 * f64::from(rgb[2]) + 0.5).floor().clamp(0.0, 255.0) as u8
}

/// The most pixels a [`Sample`] keeps; a larger image is sampled on a grid before it is given.
pub const MAX_SAMPLE_PIXELS: usize = 4_000_000;

/// The pixels Auto reads: the visible ones (transparent pixels never count), 8-bit RGB, with their red, green, blue
/// and luma histograms (JS `weightedHistogram`).
#[derive(Clone, Debug)]
pub struct Sample {
    pixels: Vec<[u8; 3]>,
    /// Red, green, blue, luma.
    hist: [[u64; 256]; 4],
}

impl Sample {
    /// A sample of opaque pixels. Past [`MAX_SAMPLE_PIXELS`], every n-th one is kept.
    pub fn new(pixels: Vec<[u8; 3]>) -> Sample {
        let pixels = if pixels.len() > MAX_SAMPLE_PIXELS {
            let step = pixels.len().div_ceil(MAX_SAMPLE_PIXELS);
            pixels.into_iter().step_by(step).collect()
        } else {
            pixels
        };
        let mut hist = [[0u64; 256]; 4];
        for p in &pixels {
            for (h, v) in hist.iter_mut().zip([p[0], p[1], p[2], luma(*p)]) {
                if let Some(n) = h.get_mut(usize::from(v)) {
                    *n += 1;
                }
            }
        }
        Sample { pixels, hist }
    }

    /// The visible pixels of straight RGBA8 (alpha 0 left out).
    pub fn from_rgba8(px: &[[u8; 4]]) -> Sample {
        Sample::new(px.iter().filter(|p| p[3] != 0).map(|p| [p[0], p[1], p[2]]).collect())
    }

    /// The visible pixels of straight RGBA in 0..=1 (alpha 0 or NaN left out; channels rounded to 8 bits).
    pub fn from_rgba_f32(px: &[[f32; 4]]) -> Sample {
        let level = |v: f32| if v.is_finite() { (v.clamp(0.0, 1.0) * 255.0).round() as u8 } else { 0 };
        Sample::new(px.iter().filter(|p| p[3] > 0.0).map(|p| [level(p[0]), level(p[1]), level(p[2])]).collect())
    }

    /// How many pixels count.
    pub fn count(&self) -> u64 {
        self.pixels.len() as u64
    }

    /// The red, green, blue and luma histograms.
    pub fn histograms(&self) -> &[[u64; 256]; 4] {
        &self.hist
    }
}

/// `[lo, hi]` of a histogram clipping `low_pct` / `high_pct` percent of `count` at each end; `None` when what is left
/// is less than two levels wide (JS `clipRange`).
fn clip_range(hist: &[u64; 256], count: u64, low_pct: f32, high_pct: f32) -> Option<(f64, f64)> {
    let n_lo = count as f64 * f64::from(low_pct) / 100.0;
    let n_hi = count as f64 * f64::from(high_pct) / 100.0;
    let (mut lo, mut hi) = (0usize, 255usize);
    let mut cum = 0u64;
    for (v, n) in hist.iter().enumerate() {
        cum += n;
        if cum as f64 > n_lo {
            lo = v;
            break;
        }
    }
    cum = 0;
    for (v, n) in hist.iter().enumerate().rev() {
        cum += n;
        if cum as f64 > n_hi {
            hi = v;
            break;
        }
    }
    (hi > lo + 1).then_some((lo as f64, hi as f64))
}

/// The gamma that maps input `s` (after the black and white points of `lvl`) to `target`: 0.1..=9.99, 1 when no
/// gamma can (JS `gammaFor`).
pub fn gamma_for(s: f64, lvl: &Levels5, target: f64) -> f64 {
    let (range, out_range) = (lvl.in_white - lvl.in_black, lvl.out_white - lvl.out_black);
    if range <= 0.0 || out_range == 0.0 {
        return 1.0;
    }
    let (t, u) = ((s - lvl.in_black) / range, (target - lvl.out_black) / out_range);
    if !(t > 0.002 && t < 0.998 && u > 0.002 && u < 0.998) {
        return 1.0;
    }
    (t.ln() / u.ln()).clamp(0.1, 9.99)
}

fn is_neutral(c: [u8; 3]) -> bool {
    c[0] == c[1] && c[1] == c[2]
}

/// The Levels Photoshop's Auto sets for `sample` with options `o` (JS `autoLevelsParams`). With black and white
/// targets, the Monochromatic and Brightness and Contrast stretches go into the composite alone; everything else is
/// per channel.
pub fn auto_levels(sample: &Sample, o: &AutoOptions) -> AutoLevels {
    let o = o.clamped();
    let count = sample.count();
    if count == 0 {
        return AutoLevels::NONE;
    }
    let [hr, hg, hb, hl] = &sample.hist;
    let (sh, mid, hi) = (o.shadow, o.midtone, o.highlight);
    let neutral_ends = o.neutral_ends();
    // [lo, hi, gamma] per channel
    let per: [(f64, f64, f64); 3] = match o.algorithm {
        AutoAlgorithm::Monochromatic | AutoAlgorithm::BrightnessContrast => {
            let (lo, top) = clip_range(hl, count, o.shadow_clip, o.highlight_clip).unwrap_or((0.0, 255.0));
            let mut gamma = 1.0;
            if o.algorithm == AutoAlgorithm::BrightnessContrast {
                let mut cum = 0u64;
                let mut median = 128.0;
                for (v, n) in hl.iter().enumerate() {
                    cum += n;
                    if cum as f64 >= count as f64 / 2.0 {
                        median = v as f64;
                        break;
                    }
                }
                let stretched = Levels5::of(lo, top, 0.0, 255.0, 1.0);
                gamma = gamma_for(median, &stretched, 128.0).clamp(0.5, 2.0);
                if neutral_ends && !o.snap_neutral {
                    return AutoLevels { composite: Levels5::of(lo, top, 0.0, 255.0, gamma), channels: None };
                }
            }
            if o.algorithm == AutoAlgorithm::Monochromatic && neutral_ends && !o.snap_neutral {
                return AutoLevels { composite: Levels5::of(lo, top, 0.0, 255.0, 1.0), channels: None };
            }
            [(lo, top, gamma); 3]
        }
        AutoAlgorithm::PerChannel => [hr, hg, hb].map(|h| {
            let (lo, top) = clip_range(h, count, o.shadow_clip, o.highlight_clip).unwrap_or((0.0, 255.0));
            (lo, top, 1.0)
        }),
        AutoAlgorithm::DarkLight => dark_light_colors(sample, &o).map(|(lo, top)| (lo, top, 1.0)),
    };
    let mut channels = [Levels5::IDENTITY; 3];
    for (c, slot) in channels.iter_mut().enumerate() {
        let (lo, top, gamma) = per.get(c).copied().unwrap_or((0.0, 255.0, 1.0));
        let at = |rgb: [u8; 3]| f64::from(rgb.get(c).copied().unwrap_or(0));
        *slot = Levels5::of(lo, top, at(sh), at(hi), gamma);
    }
    if o.snap_neutral
        && let Some(s) = neutral_sample(sample)
    {
        // Snap Neutral Midtones: the average of the nearly neutral midtones becomes neutral (the target midtone
        // colour; with a grey target, the colour's own brightness, so only the cast goes).
        let mapped: Vec<f64> = channels.iter().zip(s).map(|(l, v)| f64::from(l.lut()[usize::from(v)])).collect();
        let target: [f64; 3] = if is_neutral(mid) {
            let m =
                mapped.first().copied().unwrap_or(0.0) * 299.0 + mapped.get(1).copied().unwrap_or(0.0) * 587.0 + mapped.get(2).copied().unwrap_or(0.0) * 114.0;
            [m / 1000.0; 3]
        } else {
            mid.map(f64::from)
        };
        for ((l, v), t) in channels.iter_mut().zip(s).zip(target) {
            let flat = Levels5 { gamma: 1.0, ..*l };
            *l = Levels5 { gamma: js_round(gamma_for(f64::from(v), &flat, t) * 100.0) / 100.0, ..flat };
        }
    }
    AutoLevels { composite: Levels5::IDENTITY, channels: Some(channels) }
}

/// Find Dark & Light Colors: per channel, the average colour of the darkest and of the lightest clip-percent pixels
/// (JS `darkLightColors`).
fn dark_light_colors(sample: &Sample, o: &AutoOptions) -> [(f64, f64); 3] {
    let lum = sample.hist.get(3).copied().unwrap_or([0; 256]);
    let (lo, top) = clip_range(&lum, sample.count(), o.shadow_clip.max(0.01), o.highlight_clip.max(0.01)).unwrap_or((0.0, 255.0));
    let (mut dark, mut light) = ([0f64; 3], [0f64; 3]);
    let (mut nd, mut nl) = (0u64, 0u64);
    for p in &sample.pixels {
        let l = f64::from(luma(*p));
        if l <= lo {
            for (d, v) in dark.iter_mut().zip(p) {
                *d += f64::from(*v);
            }
            nd += 1;
        }
        if l >= top {
            for (d, v) in light.iter_mut().zip(p) {
                *d += f64::from(*v);
            }
            nl += 1;
        }
    }
    let mut out = [(0.0, 255.0); 3];
    for ((slot, d), l) in out.iter_mut().zip(dark).zip(light) {
        let lo = if nd > 0 { js_round(d / nd as f64) } else { 0.0 };
        let hi = if nl > 0 { js_round(l / nl as f64) } else { 255.0 };
        if hi > lo + 1.0 {
            *slot = (lo, hi);
        }
    }
    out
}

/// The average colour of the nearly neutral midtones (the average of everything when too few are), `None` for an
/// empty sample (JS `neutralSample`).
fn neutral_sample(sample: &Sample) -> Option<[u8; 3]> {
    let (mut s, mut a) = ([0f64; 3], [0f64; 3]);
    let (mut n, mut all) = (0u64, 0u64);
    for p in &sample.pixels {
        all += 1;
        for (x, v) in a.iter_mut().zip(p) {
            *x += f64::from(*v);
        }
        let (max, min) = (p.iter().max().copied().unwrap_or(0), p.iter().min().copied().unwrap_or(0));
        let l = luma(*p);
        if max - min < 48 && l > 40 && l < 215 {
            for (x, v) in s.iter_mut().zip(p) {
                *x += f64::from(*v);
            }
            n += 1;
        }
    }
    if all == 0 {
        return None;
    }
    let avg = |sum: [f64; 3], k: u64| sum.map(|v| js_round(v / k as f64).clamp(0.0, 255.0) as u8);
    Some(if n as f64 >= (all as f64 * 0.001).max(1.0) { avg(s, n) } else { avg(a, all) })
}

/// Options for a document without RGB channels (Grayscale, CMYK, Lab): Photoshop's Auto stretches the luminosity
/// there, as JS `autoTonalParams` does for its other spaces: Monochromatic, no snap, black and white targets.
pub fn luminosity_options(o: &AutoOptions) -> AutoOptions {
    AutoOptions { algorithm: AutoAlgorithm::Monochromatic, snap_neutral: false, shadow: [0; 3], highlight: [255; 3], ..*o }
}

/// Curve points equivalent to a Levels record: its black and white points and, for a gamma, the midpoint of its curve
/// (JS `curvePointsFromLevels`; the curve is flat outside its first and last point, as Levels is outside its input).
pub fn curve_points(l: &Levels5) -> Vec<[f64; 2]> {
    let mut pts = vec![[js_round(l.in_black), js_round(l.out_black)], [js_round(l.in_white), js_round(l.out_white)]];
    if l.gamma != 1.0 && l.in_white - l.in_black > 4.0 {
        let x = js_round((l.in_black + l.in_white) / 2.0);
        let t = (x - l.in_black) / (l.in_white - l.in_black);
        pts.insert(1, [x, js_round(l.out_black + t.powf(1.0 / l.gamma) * (l.out_white - l.out_black))]);
    }
    pts
}

/// Brightness/Contrast's Auto (Photoshop CS6 and later): contrast from how much of the range the image uses, brightness
/// from how far its median luma is from the middle (JS `autoBrightnessContrast`). `(brightness, contrast)`, `(0, 0)`
/// for an empty sample.
pub fn auto_brightness_contrast(sample: &Sample) -> (i32, i32) {
    let count = sample.count();
    if count == 0 {
        return (0, 0);
    }
    let lum = sample.hist.get(3).copied().unwrap_or([0; 256]);
    let at = |frac: f64| {
        let mut cum = 0u64;
        for (v, n) in lum.iter().enumerate() {
            cum += n;
            if cum as f64 >= count as f64 * frac {
                return v as f64;
            }
        }
        255.0
    };
    let (lo, hi, median) = (at(0.005), at(0.995), at(0.5));
    let spread = (hi - lo).max(1.0);
    let contrast = js_round(((255.0 / spread - 1.0) * 40.0).clamp(-50.0, 100.0));
    let brightness = js_round(((128.0 - median) / 0.6 / 2.0).clamp(-150.0, 150.0));
    (brightness as i32, contrast as i32)
}

#[cfg(test)]
mod tests;
