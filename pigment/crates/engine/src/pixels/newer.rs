//! Pigment: destructive Clarity and Dehaze (Image › Adjustments on a layer, mask or smart object)
//! reads [`photocraft_doc::adjust::CLARITY_DEHAZE_MARGIN`] pixels around each tile from the
//! surface, so tile by tile is what one pass over the whole layer gives (no seams).

use photocraft_color::{ColorMode, SampleType};
use photocraft_compose::{Buffer, adjust};
use photocraft_doc::Adjustment;
use photocraft_geom::Rect;
use photocraft_raster::{Surface, to_rgba};

/// When `adj` reads a neighbourhood: `buf` (the pixels of `s` over `buf.rect`) adjusted from the
/// surface read around it, and `true`; otherwise `false` and `buf` untouched.
pub(super) fn apply_around(s: &Surface, buf: &mut Buffer, adj: &Adjustment, transfer: adjust::Transfer, depth: Option<SampleType>, mode: ColorMode) -> bool {
    let margin = adj.spatial_margin(1.0);
    if margin == 0 || buf.rect.is_empty() {
        return false;
    }
    // Past the layer's pixels the surface reads as its default (transparent for most layers), the
    // same for every tile.
    let everywhere = Rect::new(i32::MIN, i32::MIN, i32::MAX, i32::MAX);
    let grown = photocraft_compose::adjust_extra::grow(buf.rect, margin, everywhere);
    let fmt = s.format();
    let n = fmt.channels().max(1);
    let raw = s.read_region(grown);
    let mut around = Buffer { rect: grown, px: raw.chunks_exact(n).map(|p| to_rgba(&fmt, p)).collect() };
    adjust::apply_in(adj, &mut around, transfer, depth, mode);
    let (gw, w) = (grown.width() as usize, buf.rect.width() as usize);
    let (dx, dy) = ((buf.rect.x0 - grown.x0) as usize, (buf.rect.y0 - grown.y0) as usize);
    for (row, dst) in buf.px.chunks_exact_mut(w.max(1)).enumerate() {
        let o = (dy + row) * gw + dx;
        if let Some(src) = around.px.get(o..o + w) {
            dst.copy_from_slice(src);
        }
    }
    true
}
