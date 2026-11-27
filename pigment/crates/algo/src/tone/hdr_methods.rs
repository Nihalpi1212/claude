//! Pigment: HDR Toning's Method menu (Image › Adjustments › HDR Toning), as Photoshop's dialog and
//! the JavaScript Pigment 0.4 had it: Local Adaptation, Equalize Histogram, Exposure and Gamma and
//! Highlight Compression.
//!
//! Local Adaptation is upstream's [`super::hdr_toning`], unchanged. The other three are ports of the
//! JavaScript app's `toneMap` branches (`src/shared/pixels/hdr.js`, branch `claude/fervent-newton-263lz3`,
//! lines 287 to 349): they decode the pixels to linear light, map them, and encode the display
//! result with the sRGB curve. `js-cases.json` beside this file holds that app's own output for a
//! test image (`make-cases.mjs`, README), and the tests check every pixel against it.
//!
//! The method is a separate argument, not a field of [`HdrToning`]: upstream builds that struct
//! for Merge to HDR Pro and its checked replay, and they stay as they are.

use photocraft_color::convert::{linear_to_srgb, srgb_to_linear};
use serde::{Deserialize, Serialize};

use super::HdrToning;
use crate::photo_util::par_rows;

/// HDR Toning's Method menu, in Photoshop's order.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HdrMethod {
    /// Upstream's local adaptation tone mapping (radius, strength, detail, curve…).
    #[default]
    LocalAdaptation,
    /// Luminance histogram equalisation, hue kept; no settings.
    EqualizeHistogram,
    /// A linear-light gain of 2^exposure and a power of 1/gamma.
    ExposureGamma,
    /// Reinhard's curve with the brightest luminance as the white point (after the exposure gain).
    HighlightCompression,
}

impl HdrMethod {
    pub const ALL: [HdrMethod; 4] = [HdrMethod::LocalAdaptation, HdrMethod::EqualizeHistogram, HdrMethod::ExposureGamma, HdrMethod::HighlightCompression];

    /// The id the `method` parameter takes.
    pub fn id(self) -> &'static str {
        match self {
            HdrMethod::LocalAdaptation => "localAdaptation",
            HdrMethod::EqualizeHistogram => "equalizeHistogram",
            HdrMethod::ExposureGamma => "exposureGamma",
            HdrMethod::HighlightCompression => "highlightCompression",
        }
    }

    /// The English menu label.
    pub fn label(self) -> &'static str {
        match self {
            HdrMethod::LocalAdaptation => "Local Adaptation",
            HdrMethod::EqualizeHistogram => "Equalize Histogram",
            HdrMethod::ExposureGamma => "Exposure and Gamma",
            HdrMethod::HighlightCompression => "Highlight Compression",
        }
    }

    /// The method of `id`: this crate's ids, and the JavaScript app's (`local-adaptation`, …).
    pub fn parse(id: &str) -> Option<HdrMethod> {
        HdrMethod::ALL.into_iter().find(|m| m.id() == id || m.id().chars().flat_map(kebab).eq(id.chars()))
    }

    /// Whether the setting `key` of `image.adjustments.hdrToning` acts with this method. Exposure acts on
    /// Highlight Compression too, as it did in the JavaScript app.
    pub fn uses(self, key: &str) -> bool {
        match self {
            HdrMethod::LocalAdaptation => true,
            HdrMethod::EqualizeHistogram => false,
            HdrMethod::ExposureGamma => matches!(key, "exposure" | "gamma"),
            HdrMethod::HighlightCompression => key == "exposure",
        }
    }
}

/// `localAdaptation` → `local-adaptation`, one char at a time.
fn kebab(c: char) -> Vec<char> {
    if c.is_ascii_uppercase() { vec!['-', c.to_ascii_lowercase()] } else { vec![c] }
}

/// HDR Toning of straight RGBA `px` (`w × h`) with `method`. `linear`: the pixels are linear light (a
/// 32-bit document) and the result is written back linear; otherwise they are sRGB-encoded, as 8- and
/// 16-bit documents hold them. Transparent pixels are left alone. Local Adaptation is
/// [`super::hdr_toning`] (which works on the values as stored).
pub fn hdr_toning_with(px: &mut [[f32; 4]], w: usize, h: usize, p: &HdrToning, method: HdrMethod, linear: bool) {
    if px.is_empty() || w == 0 || px.len() != w * h {
        return;
    }
    let decode = |v: f32| if linear { v.max(0.0) } else { srgb_to_linear(v.clamp(0.0, 1.0)) };
    let store = |display: f32| {
        let d = display.clamp(0.0, 1.0);
        if linear { srgb_to_linear(d) } else { d }
    };
    let encode = |v: f32| linear_to_srgb(v.clamp(0.0, 1.0));
    match method {
        HdrMethod::LocalAdaptation => super::hdr_toning(px, w, h, p),
        HdrMethod::ExposureGamma => {
            let gain = 2f32.powf(p.exposure);
            let power = 1.0 / p.gamma.max(0.01);
            par_rows(px, w, 1, |_, row| {
                for q in row.iter_mut().filter(|q| q[3] > 0.0) {
                    for v in &mut q[..3] {
                        *v = store(encode((decode(*v) * gain).clamp(0.0, 1.0).powf(power)));
                    }
                }
            });
        }
        HdrMethod::HighlightCompression => {
            let gain = 2f32.powf(p.exposure);
            let y = |c: [f32; 3]| 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
            let brightest = px.iter().filter(|q| q[3] > 0.0).map(|q| y([decode(q[0]), decode(q[1]), decode(q[2])])).fold(0.0f32, f32::max);
            let white = brightest * gain;
            let white = if white > 1e-6 && white.is_finite() { white } else { 1.0 };
            let w2 = white * white;
            par_rows(px, w, 1, |_, row| {
                for q in row.iter_mut().filter(|q| q[3] > 0.0) {
                    let c = [decode(q[0]) * gain, decode(q[1]) * gain, decode(q[2]) * gain];
                    let l = y(c);
                    let k = (1.0 + l / w2) / (1.0 + l);
                    for (v, c) in q[..3].iter_mut().zip(c) {
                        *v = store(encode(c * k));
                    }
                }
            });
        }
        HdrMethod::EqualizeHistogram => equalize(px, w, &decode, &store, &encode),
    }
}

/// The JavaScript app's Equalize Histogram: a 4096-bin histogram of the display luma (Rec. 601 on the
/// encoded values), alpha-weighted, mapped through its cumulative sum so the darkest occupied bin goes to
/// 0 and the brightest to 1; each pixel's encoded colour is scaled to the new luma.
fn equalize(px: &mut [[f32; 4]], w: usize, decode: &(impl Fn(f32) -> f32 + Sync), store: &(impl Fn(f32) -> f32 + Sync), encode: &(impl Fn(f32) -> f32 + Sync)) {
    const BINS: usize = 4096;
    // The app read the display values from a 65536-step table of the linear value; the same steps keep each pixel in
    // the app's histogram bin (a bin is 1/4095 wide, so a pixel on a boundary would land one bin over).
    let step = |v: f32| ((v.clamp(0.0, 1.0) * 65535.0 + 0.5) as u32) as f32 / 65535.0;
    let shown = |q: &[f32; 4]| [encode(step(decode(q[0]))), encode(step(decode(q[1]))), encode(step(decode(q[2])))];
    let luma = |e: [f32; 3]| 0.299 * e[0] + 0.587 * e[1] + 0.114 * e[2];
    let bin = |l: f32| ((l.clamp(0.0, 1.0) * (BINS - 1) as f32 + 0.5) as usize).min(BINS - 1);
    let mut hist = vec![0f64; BINS];
    let mut total = 0f64;
    for q in px.iter().filter(|q| q[3] > 0.0) {
        let a = f64::from(q[3].min(1.0));
        hist[bin(luma(shown(q)))] += a;
        total += a;
    }
    if total <= 0.0 {
        return;
    }
    let first = hist.iter().copied().find(|v| *v > 0.0).unwrap_or(0.0);
    let mut map = vec![0f32; BINS];
    let mut cum = 0f64;
    for (b, m) in map.iter_mut().enumerate() {
        cum += hist[b];
        *m = if total - first > 0.0 { ((cum - first) / (total - first)).max(0.0) as f32 } else { b as f32 / (BINS - 1) as f32 };
    }
    par_rows(px, w, 1, |_, row| {
        for q in row.iter_mut().filter(|q| q[3] > 0.0) {
            let e = shown(q);
            let l = luma(e);
            let target = map[bin(l)];
            let out = if l > 1e-4 { e.map(|v| v * target / l) } else { [target; 3] };
            for (v, o) in q[..3].iter_mut().zip(out) {
                *v = store(o);
            }
        }
    });
}

#[cfg(test)]
mod tests;
