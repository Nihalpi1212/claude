//! Where generated art goes: fitting it into the selected shape or artboard, and the pixel size
//! asked of an image model for a target area.

use vectorcraft_geom::{Affine, Rect};

/// How art is fitted into a target.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FitMode {
    /// Wholly inside the target, centred (Text to Vector Graphic into an area).
    Contain,
    /// Covering the target, centred, the overflow clipped by the caller (Shape Fill).
    Cover,
}

/// Whether a rectangle has a finite, positive area.
pub fn usable(r: Rect) -> bool {
    [r.x0, r.y0, r.x1, r.y1].iter().all(|v| v.is_finite()) && r.width() > 1e-6 && r.height() > 1e-6
}

/// The uniform scale and translation that puts `content` in `target` (centres matched), as
/// `object.transform`'s `[a, b, c, d, e, f]`. `None` when either has no area.
pub fn fit_matrix(content: Rect, target: Rect, mode: FitMode) -> Option<[f64; 6]> {
    if !usable(content) || !usable(target) {
        return None;
    }
    let (sx, sy) = (target.width() / content.width(), target.height() / content.height());
    let s = match mode {
        FitMode::Contain => sx.min(sy),
        FitMode::Cover => sx.max(sy),
    };
    if !(s.is_finite() && s > 0.0) {
        return None;
    }
    let (c, t) = (content.center(), target.center());
    let m = Affine::translate((t.x, t.y)) * Affine::scale(s) * Affine::translate((-c.x, -c.y));
    Some(m.as_coeffs())
}

/// `r` shrunk by `ratio` of its smaller side on every edge (a margin inside an artboard).
pub fn inset(r: Rect, ratio: f64) -> Rect {
    let m = r.width().min(r.height()) * ratio.clamp(0.0, 0.45);
    Rect::new(r.x0 + m, r.y0 + m, r.x1 - m, r.y1 - m)
}

/// A pixel size with `target`'s shape whose long side is `long` (what an image model is asked
/// for). A target without area gives a square.
pub fn pixel_size(target: Rect, long: u32) -> (u32, u32) {
    if !usable(target) {
        return (long, long);
    }
    let (w, h) = (target.width(), target.height());
    let l = f64::from(long.max(1));
    if w >= h { (long.max(1), ((l * h / w).round() as u32).max(1)) } else { (((l * w / h).round() as u32).max(1), long.max(1)) }
}

/// The aspect of `target` as words for a prompt ("square", "landscape 3:2", "portrait 2:3").
pub fn aspect_words(target: Rect) -> String {
    if !usable(target) {
        return "square".into();
    }
    let r = target.width() / target.height();
    let ratio = crate::provider::nearest_ratio(
        (r * 1000.0).round().clamp(1.0, 1.0e7) as u32,
        1000,
        &["1:1", "5:4", "4:3", "3:2", "16:9", "21:9", "4:5", "3:4", "2:3", "9:16"],
    );
    if ratio == "1:1" {
        "square".into()
    } else if r > 1.0 {
        format!("landscape {ratio}")
    } else {
        format!("portrait {ratio}")
    }
}
