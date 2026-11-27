//! Pigment: Color and Vibrance, Clarity and Dehaze, and Grain, the adjustment layers the
//! JavaScript Pigment 0.4 added (`shared/pixels/adjust-color.js` `colorVibrance`,
//! `clarityDehaze`, `grain`).
//!
//! - Color and Vibrance: Camera Raw's white-balance gains ([`white_balance_gains`], a copy of
//!   `photocraft_algo::camera_raw::white_balance_gains`, since compose does not depend on algo),
//!   normalised so a grey keeps its luminance as Camera Raw's develop does, in linear light; then
//!   the Vibrance adjustment's own Vibrance and Saturation ([`crate::adjust::vibrance_lin`]).
//! - Clarity and Dehaze: the JavaScript app's algorithm, which reads a fixed neighbourhood of
//!   [`CLARITY_DEHAZE_MARGIN`] pixels and assumes white haze (no measurement over the whole frame),
//!   so a tile with that margin around it renders what the whole image does. The compositor grows
//!   each tile by [`stack_margin`] ([`with_margin`]); Camera Raw's own Clarity and Dehaze are
//!   frame-global and could not be cut into tiles.
//! - Grain: the app's value noise, a function of the document position (`grainNoise`), so the
//!   grain stays put whatever is rendered; [`Adjustment::Grain`]'s `seed` moves it (1 is the app's).

use photocraft_color::SampleType;
use photocraft_doc::adjust::CLARITY_DEHAZE_MARGIN;
use photocraft_doc::{Adjustment, Document, Layer, LayerContent};
use photocraft_geom::Rect;

use crate::adjust::{Transfer, VIBRANCE_GREY, vibrance_lin};
use crate::{Buffer, BufferAlloc};

#[cfg(test)]
mod tests;

/// Camera Raw's white-balance channel gains for Temperature / Tint (−100…100). A copy of
/// `photocraft_algo::camera_raw::white_balance_gains` (camera_raw.rs; compose does not depend on
/// algo); a test in photocraft-algo's callers keeps the two equal (`gains_match_camera_raw`).
pub fn white_balance_gains(temperature: f32, tint: f32) -> [f32; 3] {
    let t = temperature / 100.0;
    let tn = tint / 100.0;
    [1.0 + 0.35 * t, 1.0 - 0.25 * tn, 1.0 - 0.35 * t]
}

/// Color and Vibrance's linear-light channel gains: [`white_balance_gains`] divided by their
/// Rec. 709 luminance (a grey keeps its luminance, as Camera Raw's develop does); `None` at rest.
pub fn color_vibrance_gains(temperature: f32, tint: f32) -> Option<[f32; 3]> {
    if temperature == 0.0 && tint == 0.0 {
        return None;
    }
    let g = white_balance_gains(temperature.clamp(-100.0, 100.0), tint.clamp(-100.0, 100.0));
    let lum = 0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2];
    (lum > 0.0).then(|| g.map(|v| v / lum))
}

/// One pixel of Color and Vibrance: `gains` in linear light (through `transfer`), then Vibrance
/// `v` and Saturation `s` (−1…1) as [`crate::adjust::vibrance_px`] does them; `hi` the ceiling.
pub fn color_vibrance_px(c: [f32; 3], gains: Option<[f32; 3]>, v: f32, s: f32, transfer: Transfer, hi: f32) -> [f32; 3] {
    let mut l = c.map(|x| transfer.decode(x));
    if let Some(g) = gains {
        l = [l[0] * g[0], l[1] * g[1], l[2] * g[2]].map(|x| x.clamp(0.0, hi));
    }
    if v != 0.0 {
        l = vibrance_lin(l, v);
    }
    if s != 0.0 {
        let g = VIBRANCE_GREY[0] * l[0] + VIBRANCE_GREY[1] * l[1];
        l = l.map(|x| (g + (1.0 + s) * (x - g)).clamp(0.0, hi));
    }
    l.map(|x| transfer.encode(x.clamp(0.0, hi)))
}

/// Grain's noise salt for `seed` (seed 1 is the JavaScript app's noise). Below 2^24, so the GPU
/// gets it exactly as an f32 parameter.
pub fn seed_salt(seed: u32) -> i32 {
    (seed.wrapping_sub(1) % 100_000 * 163) as i32
}

/// The app's `hash01`: an integer hash of a document position and a salt, in 0..1, kept to 24
/// bits so the GPU's f32 gets the same value.
#[inline]
pub fn hash01(x: i32, y: i32, salt: i32) -> f32 {
    let mut h = (x as u32).wrapping_mul(374_761_393) ^ (y as u32).wrapping_mul(668_265_263) ^ (salt as u32).wrapping_mul(1_274_126_177);
    h = (h ^ (h >> 13)).wrapping_mul(1_103_515_245);
    h ^= h >> 16;
    (h >> 8) as f32 / 16_777_216.0
}

/// Grain's noise at a document position, −1…1 (the app's `grainNoise`): value noise on a lattice
/// of `cell` px mixed with per-pixel noise by `roughness` (0…1), triangular (two hashes summed).
pub fn grain_noise(x: i32, y: i32, cell: f32, roughness: f32, seed: u32) -> f32 {
    let s = seed_salt(seed);
    let tri = |x: i32, y: i32, salt: i32| hash01(x, y, salt.wrapping_add(s)) + hash01(x, y, salt.wrapping_add(101).wrapping_add(s)) - 1.0;
    let smooth = if cell <= 1.0 {
        tri(x, y, 1)
    } else {
        let (gx, gy) = (x as f32 / cell, y as f32 / cell);
        let (ix, iy) = (gx.floor(), gy.floor());
        let (fx, fy) = (gx - ix, gy - iy);
        let (fx, fy) = (fx * fx * (3.0 - 2.0 * fx), fy * fy * (3.0 - 2.0 * fy));
        let (ix, iy) = (ix as i32, iy as i32);
        let a = tri(ix, iy, 1);
        let b = tri(ix.wrapping_add(1), iy, 1);
        let c = tri(ix, iy.wrapping_add(1), 1);
        let e = tri(ix.wrapping_add(1), iy.wrapping_add(1), 1);
        // Interpolation flattens the amplitude.
        ((a + (b - a) * fx) * (1.0 - fy) + (c + (e - c) * fx) * fy) * 1.6
    };
    if roughness <= 0.0 {
        return smooth;
    }
    smooth * (1.0 - roughness) + tri(x, y, 3) * roughness
}

/// Grain's lattice cell for Size 0…100 (the app's `1 + size / 16`).
pub fn grain_cell(size: f32) -> f32 {
    1.0 + size.clamp(0.0, 100.0) / 16.0
}

/// Grain's settings as the noise takes them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GrainSettings {
    /// Amount, 0…1.
    pub amount: f32,
    /// The lattice cell ([`grain_cell`]).
    pub cell: f32,
    /// Roughness, 0…1.
    pub roughness: f32,
    pub seed: u32,
}

/// One pixel of Grain at document position (`x`, `y`). Weaker in deep shadows and highlights,
/// like film.
pub fn grain_px(c: [f32; 3], x: i32, y: i32, g: &GrainSettings, hi: f32) -> [f32; 3] {
    let l = (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]).clamp(0.0, 1.0);
    let k = grain_noise(x, y, g.cell, g.roughness, g.seed) * g.amount * 0.18 * (0.4 + 0.6 * (std::f32::consts::PI * l).sin());
    c.map(|v| (v + k).clamp(0.0, hi))
}

/// Clarity's blur: three box passes of this radius (about a Gaussian of sigma 14 px).
const CLARITY_PASS: usize = 8;
/// Dehaze's dark channel: a minimum over this radius, then three box passes of [`DEHAZE_PASS`].
const DEHAZE_MIN: usize = 4;
const DEHAZE_PASS: usize = 6;

/// Separable box blur (radius `rad`, edges replicated) of a `w`×`h` field, in place.
fn box_blur(f: &mut [f32], w: usize, h: usize, rad: usize, tmp: &mut [f32]) {
    if rad == 0 || w == 0 || h == 0 {
        return;
    }
    let win = (2 * rad + 1) as f64;
    let at = |k: isize, last: usize| k.clamp(0, last as isize) as usize;
    for y in 0..h {
        let row = &f[y * w..(y + 1) * w];
        let out = &mut tmp[y * w..(y + 1) * w];
        let mut sum = 0.0f64;
        for k in -(rad as isize)..=rad as isize {
            sum += f64::from(row[at(k, w - 1)]);
        }
        for (x, o) in out.iter_mut().enumerate() {
            *o = (sum / win) as f32;
            let add = at(x as isize + rad as isize + 1, w - 1);
            let sub = at(x as isize - rad as isize, w - 1);
            sum += f64::from(row[add]) - f64::from(row[sub]);
        }
    }
    let mut col = vec![0.0f64; w];
    for k in -(rad as isize)..=rad as isize {
        let r = at(k, h - 1) * w;
        for (c, t) in col.iter_mut().zip(&tmp[r..r + w]) {
            *c += f64::from(*t);
        }
    }
    for y in 0..h {
        for (o, c) in f[y * w..(y + 1) * w].iter_mut().zip(&col) {
            *o = (*c / win) as f32;
        }
        let ra = at(y as isize + rad as isize + 1, h - 1) * w;
        let rs = at(y as isize - rad as isize, h - 1) * w;
        for (x, c) in col.iter_mut().enumerate() {
            *c += f64::from(tmp[ra + x]) - f64::from(tmp[rs + x]);
        }
    }
}

/// Separable minimum filter (radius `rad`, edges replicated) of a `w`×`h` field, in place.
fn min_filter(f: &mut [f32], w: usize, h: usize, rad: usize, tmp: &mut [f32]) {
    if rad == 0 || w == 0 || h == 0 {
        return;
    }
    for y in 0..h {
        let row = &f[y * w..(y + 1) * w];
        for x in 0..w {
            let (a, b) = (x.saturating_sub(rad), (x + rad).min(w - 1));
            tmp[y * w + x] = row[a..=b].iter().copied().fold(f32::INFINITY, f32::min);
        }
    }
    for y in 0..h {
        let (a, b) = (y.saturating_sub(rad), (y + rad).min(h - 1));
        for x in 0..w {
            f[y * w + x] = (a..=b).map(|yy| tmp[yy * w + x]).fold(f32::INFINITY, f32::min);
        }
    }
}

/// Rec. 601 luma, as the app's Clarity and Grain weigh it.
fn luma601(c: [f32; 4]) -> f32 {
    0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
}

/// Clarity and Dehaze over the whole of `buf` (its edges replicated): Dehaze removes white haze
/// by the dark channel prior (or adds it when negative), Clarity adds (or removes) midtone local
/// contrast from the luma's 24 px blur. `clarity` and `dehaze` are −100…100.
pub fn clarity_dehaze(buf: &mut Buffer, clarity: f32, dehaze: f32, hi: f32) {
    let (clarity, dehaze) = (clarity.clamp(-100.0, 100.0) / 100.0, dehaze.clamp(-100.0, 100.0) / 100.0);
    let (w, h) = (buf.rect.width() as usize, buf.rect.height() as usize);
    if (clarity == 0.0 && dehaze == 0.0) || w == 0 || h == 0 || buf.px.len() != w * h {
        return;
    }
    let mut tmp = vec![0.0f32; w * h];
    let trans = (dehaze > 0.0).then(|| {
        let mut dark: Vec<f32> = buf.px.iter().map(|p| p[0].min(p[1]).min(p[2])).collect();
        min_filter(&mut dark, w, h, DEHAZE_MIN, &mut tmp);
        for _ in 0..3 {
            box_blur(&mut dark, w, h, DEHAZE_PASS, &mut tmp);
        }
        let omega = 0.75 * dehaze;
        dark.iter_mut().for_each(|d| *d = (1.0 - omega * *d).max(0.2));
        dark
    });
    let blur = (clarity != 0.0).then(|| {
        // Alpha-weighted, so transparent neighbours count as nothing.
        let mut lum: Vec<f32> = buf.px.iter().map(|p| luma601(*p) * p[3]).collect();
        for _ in 0..3 {
            box_blur(&mut lum, w, h, CLARITY_PASS, &mut tmp);
        }
        lum
    });
    let haze = if dehaze < 0.0 { -dehaze * 0.35 } else { 0.0 };
    let sat_k = 1.0 + 0.2 * dehaze;
    for (i, p) in buf.px.iter_mut().enumerate() {
        if p[3] <= 0.0 {
            continue;
        }
        let mut c = [p[0], p[1], p[2]];
        if let Some(blur) = &blur {
            let a = p[3];
            let l = luma601(*p);
            let lb = blur[i];
            let mw = 1.0 - (2.0 * l - 1.0) * (2.0 * l - 1.0);
            let delta = clarity * 0.8 * (l * a - lb) * (0.25 + 0.75 * mw);
            c = c.map(|v| v + delta);
        }
        if let Some(trans) = &trans {
            let t = trans[i];
            c = c.map(|v| (v - (1.0 - t)) / t);
        } else if haze > 0.0 {
            c = c.map(|v| v * (1.0 - haze) + haze);
        }
        if dehaze != 0.0 {
            let l = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
            c = c.map(|v| l + (v - l) * sat_k);
        }
        p[0] = c[0].clamp(0.0, hi);
        p[1] = c[1].clamp(0.0, hi);
        p[2] = c[2].clamp(0.0, hi);
    }
}

/// Evaluates the three kinds on `buf` (whose rect is in document pixels); other kinds are left
/// alone. Called by `adjust::apply_depth_mode`.
pub(crate) fn apply(adj: &Adjustment, buf: &mut Buffer, transfer: Transfer, depth: Option<SampleType>) {
    let hi = if depth == Some(SampleType::F32) { f32::MAX } else { 1.0 };
    match adj {
        Adjustment::ColorVibrance { temperature, tint, vibrance, saturation } => {
            let gains = color_vibrance_gains(*temperature, *tint);
            let (v, s) = (vibrance.clamp(-100.0, 100.0) / 100.0, saturation.clamp(-100.0, 100.0) / 100.0);
            if gains.is_none() && v == 0.0 && s == 0.0 {
                return;
            }
            for p in &mut buf.px {
                if p[3] > 0.0 {
                    let o = color_vibrance_px([p[0], p[1], p[2]], gains, v, s, transfer, hi);
                    p[..3].copy_from_slice(&o);
                }
            }
        }
        Adjustment::ClarityDehaze { clarity, dehaze } => clarity_dehaze(buf, *clarity, *dehaze, hi),
        Adjustment::Grain { amount, size, roughness, seed } => {
            let amount = amount.clamp(0.0, 100.0) / 100.0;
            if amount.is_nan() || amount <= 0.0 {
                return;
            }
            let g = GrainSettings { amount, cell: grain_cell(*size), roughness: roughness.clamp(0.0, 100.0) / 100.0, seed: *seed };
            let (w, x0, y0) = (buf.rect.width().max(1) as usize, buf.rect.x0, buf.rect.y0);
            for (i, p) in buf.px.iter_mut().enumerate() {
                if p[3] > 0.0 {
                    let (x, y) = (x0.wrapping_add((i % w) as i32), y0.wrapping_add((i / w) as i32));
                    let o = grain_px([p[0], p[1], p[2]], x, y, &g, hi);
                    p[..3].copy_from_slice(&o);
                }
            }
        }
        _ => {}
    }
}

/// Whether `adj` changes a pixel by more than its own colour: by its position (Grain) or its
/// neighbours (Clarity and Dehaze). One-colour areas and downsampled proxies can't stand in for
/// such a stack.
pub fn positional(adj: &Adjustment) -> bool {
    match adj {
        Adjustment::Grain { amount, .. } => *amount != 0.0,
        a => a.spatial_margin(1.0) > 0,
    }
}

/// Whether a visible layer of `doc` holds a [`positional`] adjustment (groups included).
pub fn has_positional(doc: &Document) -> bool {
    crate::visible_layers(&doc.layers).iter().any(|l| matches!(&l.content, LayerContent::Adjustment(a) if positional(a)))
}

/// Most margin a render grows its tiles by (ten Clarity and Dehaze layers on top of each other).
pub const MAX_STACK_MARGIN: u32 = 10 * CLARITY_DEHAZE_MARGIN;

/// How far around a tile `layers` read: the margins of their visible Clarity and Dehaze layers
/// added up (each reads the result of the ones below), at most [`MAX_STACK_MARGIN`].
pub fn stack_margin(layers: &[Layer]) -> u32 {
    crate::visible_layers(layers)
        .iter()
        .filter_map(|l| match &l.content {
            LayerContent::Adjustment(a) => Some(a.spatial_margin(1.0)),
            _ => None,
        })
        .fold(0u32, u32::saturating_add)
        .min(MAX_STACK_MARGIN)
}

/// `rect` grown by `margin` on each side, but not past an edge of `canvas` it lies within (the
/// whole image replicates its edges there, so a tile must too).
pub fn grow(rect: Rect, margin: u32, canvas: Rect) -> Rect {
    if margin == 0 || rect.is_empty() {
        return rect;
    }
    let m = i32::try_from(margin).unwrap_or(i32::MAX);
    let lo = |r: i32, c: i32| if r > c { r.saturating_sub(m).max(c) } else { r };
    let hi = |r: i32, c: i32| if r < c { r.saturating_add(m).min(c) } else { r };
    Rect::new(lo(rect.x0, canvas.x0), lo(rect.y0, canvas.y0), hi(rect.x1, canvas.x1), hi(rect.y1, canvas.y1))
}

/// `render(rect)`, rendered over `rect` grown by `margin` ([`grow`]) and cut back, so a
/// neighbourhood adjustment sees what lies around the tile.
pub(crate) fn with_margin<A: BufferAlloc>(
    rect: Rect,
    margin: u32,
    canvas: Rect,
    alloc: &A,
    render: impl FnOnce(Rect) -> Result<Buffer, A::Error>,
) -> Result<Buffer, A::Error> {
    let grown = grow(rect, margin, canvas);
    if grown == rect {
        return render(rect);
    }
    let big = render(grown)?;
    let mut out = alloc.filled(rect, [0.0; 4])?;
    let (bw, w) = (big.rect.width() as usize, rect.width() as usize);
    for (row, dst) in out.px.chunks_exact_mut(w.max(1)).enumerate() {
        let y = rect.y0 as i64 + row as i64 - big.rect.y0 as i64;
        let o = y as usize * bw + (rect.x0 - big.rect.x0) as usize;
        if let Some(src) = big.px.get(o..o + w) {
            dst.copy_from_slice(src);
        }
    }
    Ok(out)
}
