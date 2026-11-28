//! Pigment (PORTS-B B2): No Break, Fractional Widths and System Layout in the layout.

use photocraft_doc::TextLayer;
use photocraft_doc::text::{AntiAlias, CharStyle, TextRun, TextShape};

use crate::TextEngine;

fn inter(size_pt: f32) -> CharStyle {
    CharStyle { font_family: "Inter".into(), size_pt, ..Default::default() }
}

fn layer(text: &str, size_pt: f32) -> TextLayer {
    TextLayer { text: text.into(), font_family: "Inter".into(), size_pt, ..Default::default() }
}

/// `text` in runs: each piece with No Break on or off.
fn runs(pieces: &[(&str, bool)], size_pt: f32) -> TextLayer {
    let text: String = pieces.iter().map(|p| p.0).collect();
    let runs = pieces.iter().map(|&(s, nb)| TextRun { len: s.len(), style: CharStyle { no_break: nb, ..inter(size_pt) } }).collect();
    TextLayer { runs, ..layer(&text, size_pt) }
}

fn lines_text(t: &TextLayer, l: &crate::TextLayout) -> Vec<String> {
    l.lines.iter().map(|li| t.text[li.range.clone()].trim().to_string()).collect()
}

fn is_whole(v: f32) -> bool {
    (v - v.round()).abs() < 1e-4
}

#[test]
fn fractional_widths_off_puts_every_glyph_on_a_whole_pixel() {
    let mut e = TextEngine::new();
    let on = layer("illicit", 9.0);
    let off = TextLayer { fractional_widths: false, ..on.clone() };
    let lo = e.layout(&on, 72.0);
    let lf = e.layout(&off, 72.0);
    assert_eq!(lo.glyphs.len(), lf.glyphs.len());
    assert!(lo.glyphs.iter().any(|g| !is_whole(g.x)), "the fractional layout already sits on whole pixels: no test");
    for g in &lf.glyphs {
        assert!(is_whole(g.x), "glyph at {}", g.x);
    }
    for c in &lf.clusters {
        assert!(is_whole(c.x) && is_whole(c.advance), "{c:?}");
    }
    let n = lf.glyphs.len() as f32;
    let (wo, wf) = (lo.lines[0].x1 - lo.lines[0].x0, lf.lines[0].x1 - lf.lines[0].x0);
    assert!(wf >= wo - 0.5 * n, "{wf} < {wo} - {n}/2");
    assert!(is_whole(lf.lines[0].x1 - lf.lines[0].x0), "the line's extent is whole advances: {wf}");
    // Fractional Widths on is today's layout, glyph for glyph.
    let plain = e.layout(&layer("illicit", 9.0), 72.0);
    assert_eq!(plain.glyphs.iter().map(|g| g.x).collect::<Vec<_>>(), lo.glyphs.iter().map(|g| g.x).collect::<Vec<_>>());
}

#[test]
fn fractional_widths_off_keeps_box_lines_and_decorations_whole() {
    let mut e = TextEngine::new();
    let mut t = layer("The quick brown fox jumps over the lazy dog", 9.0);
    t.runs = vec![TextRun { len: t.text.len(), style: CharStyle { underline: true, ..inter(9.0) } }];
    t.shape = TextShape::Box { x: 3.3, y: 2.0, width: 80.0, height: 200.0 };
    t.fractional_widths = false;
    let l = e.layout(&t, 72.0);
    assert!(l.lines.len() >= 2);
    assert!(l.glyphs.iter().all(|g| is_whole(g.x)));
    assert!(!l.decorations.is_empty());
    for d in &l.decorations {
        assert!(is_whole(d.x0) && is_whole(d.x1), "{d:?}");
    }
}

#[test]
fn system_layout_snaps_glyphs_and_baselines_and_turns_off_cleanly() {
    let mut e = TextEngine::new();
    let mut t = layer("Mock-up label\nSecond line", 9.3);
    t.shape = TextShape::Box { x: 0.4, y: 0.7, width: 200.0, height: 200.0 };
    let before = e.layout(&t, 72.0);
    t.system_layout = true;
    let l = e.layout(&t, 72.0);
    assert!(l.glyphs.iter().all(|g| is_whole(g.x) && is_whole(g.y)), "{:?}", l.glyphs.iter().map(|g| (g.x, g.y)).collect::<Vec<_>>());
    assert!(l.lines.iter().all(|li| is_whole(li.baseline)));
    assert_eq!(crate::layout::drawn_antialias(&t), AntiAlias::Sharp);
    t.system_layout = false;
    let after = e.layout(&t, 72.0);
    assert_eq!(before.glyphs.iter().map(|g| (g.x, g.y)).collect::<Vec<_>>(), after.glyphs.iter().map(|g| (g.x, g.y)).collect::<Vec<_>>());
    assert_eq!(crate::layout::drawn_antialias(&t), AntiAlias::Smooth);
    // None stays None under System Layout.
    let none = TextLayer { system_layout: true, antialias: AntiAlias::None, ..t };
    assert_eq!(crate::layout::drawn_antialias(&none), AntiAlias::None);
}

#[test]
fn no_break_moves_the_break_before_the_kept_words() {
    let mut e = TextEngine::new();
    // A box as wide as "aaa bbb" (plus a little): "ccc" goes to the next line.
    let w = {
        let l = e.layout(&layer("aaa bbb", 12.0), 72.0);
        l.lines[0].x1 - l.lines[0].x0 + 2.0
    };
    let boxed = |mut t: TextLayer| {
        t.shape = TextShape::Box { x: 0.0, y: 0.0, width: w, height: 500.0 };
        t
    };
    let plain = boxed(runs(&[("aaa bbb ccc", false)], 12.0));
    assert_eq!(lines_text(&plain, &e.layout(&plain, 72.0)), ["aaa bbb", "ccc"]);
    let kept = boxed(runs(&[("aaa ", false), ("bbb ccc", true)], 12.0));
    assert_eq!(lines_text(&kept, &e.layout(&kept, 72.0)), ["aaa", "bbb ccc"]);
}

#[test]
fn a_no_break_word_wider_than_the_box_runs_out_of_it() {
    let mut e = TextEngine::new();
    let shape = TextShape::Box { x: 0.0, y: 0.0, width: 30.0, height: 500.0 };
    // Without No Break, a word wider than the box breaks at the box edge (#6694).
    let plain = TextLayer { shape: shape.clone(), ..runs(&[("abcdefghijkl", false)], 12.0) };
    assert!(e.layout(&plain, 72.0).lines.len() > 1);
    let kept = TextLayer { shape, ..runs(&[("abcdefghijkl", true)], 12.0) };
    let l = e.layout(&kept, 72.0);
    assert_eq!(lines_text(&kept, &l), ["abcdefghijkl"]);
    assert!(l.lines[0].x1 > 30.0);
}
