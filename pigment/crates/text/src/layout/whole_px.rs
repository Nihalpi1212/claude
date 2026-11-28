//! Pigment (PORTS-B B2): whole-pixel glyph positions for a type layer with Fractional Widths off
//! or System Layout on.
//!
//! Photoshop's Fractional Widths off rounds each character's advance to whole pixels (useful for
//! small screen text); the JavaScript Pigment rounded each shaped unit's advance
//! (`shaper.js:360`). Here each caret cluster's advance on a placed line (horizontal scale, kerning
//! and tracking included) is rounded, the line starts on a whole pixel, and every glyph after a
//! cluster moves by what the rounding added before it. Line breaking still measures the shaped
//! (fractional) widths: under one pixel per glyph, as the spec allows for the parley path.

use super::TextLayout;

/// Where a layer's lines are snapped to whole pixels.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct WholePixels {
    /// Fractional Widths off or System Layout on: whole-pixel advances and glyph x.
    pub(super) advances: bool,
    /// System Layout on: baselines (and so glyph y) on whole pixels too.
    pub(super) baselines: bool,
}

impl WholePixels {
    pub(super) fn of(t: &photocraft_doc::TextLayer) -> Self {
        Self { advances: !t.fractional_widths || t.system_layout, baselines: t.system_layout }
    }

    /// A baseline as this layer places it.
    pub(super) fn baseline(self, b: f32) -> f32 {
        if self.baselines && b.is_finite() { b.round() } else { b }
    }
}

/// The anti-aliasing a type layer is drawn with: System Layout draws with the Sharp curve (the
/// platform's text rendering, as `AntiAlias::Windows` is drawn), except None stays None. The stored
/// setting is kept, so turning System Layout off restores the look.
pub fn drawn_antialias(t: &photocraft_doc::TextLayer) -> photocraft_doc::text::AntiAlias {
    use photocraft_doc::text::AntiAlias;
    match t.antialias {
        AntiAlias::None => AntiAlias::None,
        _ if t.system_layout => AntiAlias::Sharp,
        a => a,
    }
}

/// Snaps the clusters from `c0`, the glyphs from `g0` and the decorations from `d0` (one
/// horizontal line) to whole-pixel advances. Returns how far the line's start and end moved.
pub(super) fn snap_line(out: &mut TextLayout, c0: usize, g0: usize, d0: usize) -> (f32, f32) {
    let Some(first) = out.clusters.get(c0) else {
        return (0.0, 0.0);
    };
    if !first.x.is_finite() {
        return (0.0, 0.0);
    }
    // The old start and the shift of each cluster, in line order.
    let mut pen = first.x.round();
    let start_shift = pen - first.x;
    let mut starts = Vec::with_capacity(out.clusters.len() - c0);
    let mut shifts = Vec::with_capacity(out.clusters.len() - c0);
    let mut old_end = first.x;
    for c in &mut out.clusters[c0..] {
        let adv = if c.advance.is_finite() { c.advance.round() } else { 0.0 };
        starts.push(c.x);
        shifts.push(pen - c.x);
        old_end = c.x + c.advance;
        c.x = pen;
        c.advance = adv;
        pen += adv;
    }
    let end_shift = pen - old_end;
    let shift_at = |x: f32| -> f32 {
        if x >= old_end - 1e-3 {
            return end_shift;
        }
        let i = starts.iter().rposition(|&s| s <= x + 1e-3).unwrap_or(0);
        shifts.get(i).copied().unwrap_or(start_shift)
    };
    for g in &mut out.glyphs[g0..] {
        // A glyph belongs to the cluster it starts in, never to the line's end.
        let i = starts.iter().rposition(|&s| s <= g.x + 1e-3).unwrap_or(0);
        let x = g.x + shifts.get(i).copied().unwrap_or(start_shift);
        g.x = if x.is_finite() { x.round() } else { x };
    }
    for d in out.decorations.iter_mut().skip(d0) {
        let (x0, x1) = (d.x0 + shift_at(d.x0), d.x1 + shift_at(d.x1));
        d.x0 = x0.round();
        d.x1 = x1.round();
    }
    (start_shift, end_shift)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::{ClusterInfo, DecorationRect, GlyphOrient, PlacedGlyph};

    fn cluster(x: f32, advance: f32) -> ClusterInfo {
        ClusterInfo { range: 0..1, x, advance, line: 0, rtl: false }
    }

    fn glyph(x: f32) -> PlacedGlyph {
        PlacedGlyph { face: 0, id: 1, x, y: 10.3, style: 0, orient: GlyphOrient::Horizontal, line_center: None }
    }

    #[test]
    fn advances_round_and_glyphs_follow() {
        let mut out = TextLayout {
            clusters: vec![cluster(0.4, 5.4), cluster(5.8, 5.4), cluster(11.2, 5.4)],
            glyphs: vec![glyph(0.4), glyph(5.8), glyph(11.2)],
            decorations: vec![DecorationRect { x0: 0.4, y0: 0.0, x1: 16.6, y1: 1.0, style: 0 }],
            ..Default::default()
        };
        let (s, e) = snap_line(&mut out, 0, 0, 0);
        let xs: Vec<f32> = out.glyphs.iter().map(|g| g.x).collect();
        assert_eq!(xs, vec![0.0, 5.0, 10.0]);
        assert_eq!(out.clusters.iter().map(|c| c.advance).collect::<Vec<_>>(), vec![5.0, 5.0, 5.0]);
        assert!((s + 0.4).abs() < 1e-4 && (e + 1.6).abs() < 1e-4, "{s} {e}");
        assert_eq!((out.decorations[0].x0, out.decorations[0].x1), (0.0, 15.0));
        // y stays (only System Layout snaps baselines, in frame_line).
        assert!((out.glyphs[0].y - 10.3).abs() < 1e-6);
    }

    #[test]
    fn an_empty_line_moves_nothing() {
        let mut out = TextLayout::default();
        assert_eq!(snap_line(&mut out, 0, 0, 0), (0.0, 0.0));
    }

    #[test]
    fn system_layout_snaps_baselines() {
        let w = WholePixels { advances: true, baselines: true };
        assert_eq!(w.baseline(10.6), 11.0);
        assert_eq!(WholePixels::default().baseline(10.6), 10.6);
    }
}
