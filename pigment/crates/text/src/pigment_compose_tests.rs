//! Pigment (PORTS-B B3): the Single-line and Every-line composers and hyphenation in the layout
//! of box text (Inter, 72 dpi, so a point is a pixel).

use photocraft_doc::TextLayer;
use photocraft_doc::text::{CharStyle, Composer, Hyphenation, ParagraphRun, ParagraphStyle, TextAlign, TextRun, TextShape};

use crate::{TextEngine, TextLayout};

fn inter(size_pt: f32) -> CharStyle {
    CharStyle { font_family: "Inter".into(), size_pt, ..Default::default() }
}

fn boxed(text: &str, size_pt: f32, width: f32, ps: ParagraphStyle) -> TextLayer {
    TextLayer {
        text: text.into(),
        font_family: "Inter".into(),
        size_pt,
        shape: TextShape::Box { x: 0.0, y: 0.0, width, height: 5000.0 },
        runs: vec![TextRun { len: text.len(), style: inter(size_pt) }],
        paragraphs: vec![ParagraphRun { len: text.len(), style: ps }],
        ..Default::default()
    }
}

fn hyphenating() -> ParagraphStyle {
    ParagraphStyle { hyphenate: true, ..Default::default() }
}

fn lines_text(t: &TextLayer, l: &TextLayout) -> Vec<String> {
    l.lines.iter().map(|li| t.text[li.range.clone()].trim().to_string()).collect()
}

/// Whether line `i` ends with a drawn hyphen: a glyph with no text at the line's end.
fn hyphenated(l: &TextLayout, i: usize) -> bool {
    let end = l.lines[i].range.end;
    let g0 = l.glyphs.iter().zip(&l.glyph_ranges).filter(|(_, r)| r.is_empty() && r.start == end).count();
    g0 > 0 && i + 1 < l.lines.len()
}

const LONG: &str = "Typography is the art and technique of arranging type to make written language legible, readable and appealing when displayed. \
The arrangement of type involves selecting typefaces, point sizes, line lengths, line spacing and letter spacing, and adjusting the space between pairs of letters. \
Characteristically, internationalization and standardization demand extraordinarily comprehensive considerations.";

#[test]
fn a_long_word_hyphenates_in_a_narrow_box_and_offsets_stay_in_layer_text() {
    let mut e = TextEngine::new();
    let t = boxed("internationalization", 12.0, 60.0, hyphenating());
    let l = e.layout(&t, 72.0);
    assert!(l.lines.len() >= 2, "{:?}", lines_text(&t, &l));
    assert!(hyphenated(&l, 0), "the first line ends with a hyphen: {:?}", lines_text(&t, &l));
    // Every line, hyphen included, fits the box.
    for li in &l.lines {
        assert!(li.x1 <= 60.5, "{li:?}");
    }
    let hy = l.glyphs.iter().zip(&l.glyph_ranges).find(|(_, r)| r.is_empty()).map(|(g, _)| *g).expect("hyphen glyph");
    assert!(hy.x > 0.0 && hy.x < 60.0);
    // Lines and clusters cover the text exactly once, in layer offsets; the hyphen is no cluster.
    assert_eq!(l.lines[0].range.start, 0);
    for w in l.lines.windows(2) {
        assert_eq!(w[0].range.end, w[1].range.start);
    }
    assert_eq!(l.lines.last().map(|li| li.range.end), Some(t.text.len()));
    let covered: usize = l.clusters.iter().map(|c| c.range.len()).sum();
    assert_eq!(covered, t.text.len());
    assert!(l.clusters.iter().all(|c| !c.range.is_empty()));
    // The caret at the break shows at the start of the next line.
    let b = l.lines[0].range.end;
    let (x, top, _) = l.caret(b);
    assert!(top > l.lines[0].baseline, "caret {x} {top} on the second line");
    // Hyphenation points come from craft-text's English dictionary.
    let pts = craft::text::hyphen::hyphen_points_in(
        "internationalization",
        &craft::text::hyphen::Limits { min_word: 6, after_first: 2, before_last: 2, capitalized: true },
        craft::text::hyphen::Lang::English,
    );
    assert!(pts.contains(&b), "{b} in {pts:?}");
}

#[test]
fn words_longer_than_25_letters_take_no_hyphen() {
    let mut e = TextEngine::new();
    let ps = ParagraphStyle { hyphenation: Hyphenation { words_longer_than: 25, ..Default::default() }, ..hyphenating() };
    let t = boxed("internationalization", 12.0, 60.0, ps);
    let l = e.layout(&t, 72.0);
    assert!(l.lines.len() >= 2, "the word still breaks: it is wider than the box");
    assert!(l.glyph_ranges.iter().all(|r| !r.is_empty()), "no hyphen is drawn");
}

#[test]
fn hyphen_limit_one_never_hyphenates_two_lines_in_a_row() {
    let mut e = TextEngine::new();
    for composer in [Composer::EveryLine, Composer::SingleLine] {
        let free = e.layout(&boxed(LONG, 12.0, 110.0, ParagraphStyle { composer, ..hyphenating() }), 72.0);
        let hyphens: Vec<bool> = (0..free.lines.len()).map(|i| hyphenated(&free, i)).collect();
        assert!(hyphens.iter().filter(|&&h| h).count() >= 2, "{composer:?}: the box should hyphenate");
        let ps = ParagraphStyle { composer, hyphenation: Hyphenation { hyphen_limit: 1, ..Default::default() }, ..hyphenating() };
        let l = e.layout(&boxed(LONG, 12.0, 110.0, ps), 72.0);
        let hyphens: Vec<bool> = (0..l.lines.len()).map(|i| hyphenated(&l, i)).collect();
        assert!(hyphens.windows(2).all(|w| !(w[0] && w[1])), "{composer:?}: {hyphens:?}");
    }
}

#[test]
fn each_run_hyphenates_in_its_own_language() {
    use craft::text::hyphen::{Lang, Limits, hyphen_points_in};
    let lim = Limits { min_word: 6, after_first: 2, before_last: 2, capitalized: true };
    let de = hyphen_points_in("Wasserstoff", &lim, Lang::for_language("de").expect("German patterns"));
    let en = hyphen_points_in("Wasserstoff", &lim, Lang::for_language("en-US").expect("English"));
    assert_ne!(de, en, "German and English hyphenate Wasserstoff differently");
    let mut e = TextEngine::new();
    let text = "Wasserstoffbetankungsanlage";
    let mut ends = |lang: &str| {
        let mut t = boxed(text, 12.0, 70.0, hyphenating());
        t.runs[0].style.language = Some(lang.into());
        let l = e.layout(&t, 72.0);
        assert!(hyphenated(&l, 0), "{lang}: {:?}", lines_text(&t, &l));
        l.lines[0].range.end
    };
    let de_end = ends("de");
    let de_pts = hyphen_points_in(text, &lim, Lang::for_language("de").expect("German"));
    assert!(de_pts.contains(&de_end), "{de_end} in {de_pts:?}");
}

#[test]
fn a_no_break_word_takes_no_hyphen() {
    let mut e = TextEngine::new();
    let mut t = boxed("abc internationalization", 12.0, 120.0, hyphenating());
    let on = e.layout(&t, 72.0);
    assert!(hyphenated(&on, 0), "{:?}", lines_text(&t, &on));
    t.runs = vec![TextRun { len: 4, style: inter(12.0) }, TextRun { len: t.text.len() - 4, style: CharStyle { no_break: true, ..inter(12.0) } }];
    let l = e.layout(&t, 72.0);
    assert!(l.glyph_ranges.iter().all(|r| !r.is_empty()), "{:?}", lines_text(&t, &l));
    assert_eq!(lines_text(&t, &l), ["abc", "internationalization"]);
}

/// Sum of the squared space left on each line but the last (box `w` wide).
fn raggedness(l: &TextLayout, w: f32) -> f32 {
    l.lines[..l.lines.len() - 1].iter().map(|li| (w - li.x1).powi(2)).sum()
}

#[test]
fn every_line_sets_a_more_even_rag_than_single_line() {
    let mut e = TextEngine::new();
    let single = boxed(LONG, 12.0, 150.0, ParagraphStyle { composer: Composer::SingleLine, ..Default::default() });
    let every = boxed(LONG, 12.0, 150.0, ParagraphStyle { composer: Composer::EveryLine, ..Default::default() });
    let ls = e.layout(&single, 72.0);
    let le = e.layout(&every, 72.0);
    assert_ne!(lines_text(&single, &ls), lines_text(&every, &le), "the composers should differ on this paragraph");
    assert!(raggedness(&le, 150.0) < raggedness(&ls, 150.0), "{} vs {}", raggedness(&le, 150.0), raggedness(&ls, 150.0));
    for li in le.lines.iter().chain(&ls.lines) {
        assert!(li.x1 <= 150.5, "{li:?}");
    }
}

#[test]
fn single_line_without_hyphenation_is_parleys_greedy_layout() {
    // The fast path: a Single-line paragraph that doesn't hyphenate breaks as before the port.
    let mut e = TextEngine::new();
    let t = boxed(LONG, 12.0, 150.0, ParagraphStyle { composer: Composer::SingleLine, ..Default::default() });
    let l = e.layout(&t, 72.0);
    // Greedy: no line could take the next line's first word.
    assert!(l.lines.len() > 3);
    for (i, li) in l.lines.iter().enumerate().take(l.lines.len() - 1) {
        let next_first = t.text[l.lines[i + 1].range.clone()].split(' ').next().unwrap_or("");
        let mut probe = boxed(
            &format!("{} {next_first}", t.text[li.range.clone()].trim()),
            12.0,
            10_000.0,
            ParagraphStyle { composer: Composer::SingleLine, ..Default::default() },
        );
        probe.shape = TextShape::Point;
        let w = e.layout(&probe, 72.0).lines[0].x1;
        assert!(w > 150.0, "line {i} could take {next_first:?}: {w}");
    }
}

#[test]
fn composed_justified_lines_stay_flush_with_the_box() {
    let mut e = TextEngine::new();
    for composer in [Composer::EveryLine, Composer::SingleLine] {
        let ps = ParagraphStyle { composer, align: TextAlign::JustifyLeft, ..hyphenating() };
        let t = boxed(LONG, 12.0, 150.0, ps);
        let l = e.layout(&t, 72.0);
        assert!(l.lines.len() > 4);
        // Justified: each line's last letter (its hyphen, on a hyphenated line) ends at the box's
        // right edge. (`LineInfo.x1` is parley's unjustified extent, as on the fast path.)
        let ink = |i: usize| {
            let text_end =
                l.clusters.iter().filter(|c| c.line == i && !t.text[c.range.clone()].trim().is_empty()).map(|c| c.x + c.advance).fold(f32::MIN, f32::max);
            let hyphen = l.glyphs.iter().zip(&l.glyph_ranges).find(|(g, r)| r.is_empty() && (g.y - l.lines[i].baseline).abs() < 1e-3).map(|(g, _)| g.x);
            (text_end, hyphen)
        };
        for (i, li) in l.lines.iter().enumerate().take(l.lines.len() - 1) {
            let (end, hyphen) = ink(i);
            match hyphen {
                // The hyphen (about 4.3 px at 12 pt) follows the last letter and ends at the edge.
                Some(x) => assert!((x - end).abs() < 1e-3 && (150.0 - end - 4.3).abs() < 0.6, "{composer:?} line {i}: {end} {x}"),
                None => assert!((end - 150.0).abs() < 0.6, "{composer:?} line {i} ends at {end} ({:?})", &t.text[li.range.clone()]),
            }
        }
        let last = l.lines.len() - 1;
        assert!(ink(last).0 < 149.0, "the last line stays ragged");
    }
}

#[test]
fn whole_pixel_layers_compose_with_rounded_widths_and_stay_inside_the_box() {
    let mut e = TextEngine::new();
    let mut t = boxed(LONG, 9.0, 120.0, hyphenating());
    t.fractional_widths = false;
    let l = e.layout(&t, 72.0);
    assert!(l.lines.len() > 4);
    for li in &l.lines {
        assert!(li.x1 <= 120.5, "{li:?} {:?}", &t.text[li.range.clone()]);
    }
    assert!(l.glyphs.iter().all(|g| (g.x - g.x.round()).abs() < 1e-4), "hyphens too sit on whole pixels");
}

#[test]
fn first_line_indent_and_forced_line_breaks_compose() {
    let mut e = TextEngine::new();
    let text = format!("{}\u{3}{}", &LONG[..120], &LONG[120..300]);
    let ps = ParagraphStyle { first_line_indent_pt: 20.0, ..hyphenating() };
    let t = boxed(&text, 12.0, 140.0, ps);
    let l = e.layout(&t, 72.0);
    assert!(l.lines[0].x0 >= 19.5, "{:?}", l.lines[0]);
    // The forced break ends a line.
    let brk = text.find('\u{3}').unwrap_or(0);
    assert!(l.lines.iter().any(|li| li.range.end == brk + 1 || li.range.end == brk), "{:?}", l.lines.iter().map(|li| li.range.clone()).collect::<Vec<_>>());
    for li in &l.lines {
        assert!(li.x1 <= 140.5, "{li:?}");
    }
}

/// Performance: a 2,000-word box lays out in under 50 ms in a release build.
#[test]
#[ignore = "bench: cargo test --release -p photocraft-text pigment_compose -- --ignored"]
fn a_two_thousand_word_box_lays_out_quickly() {
    let words: Vec<&str> = LONG.split(' ').collect();
    let text: String = (0..2000).map(|i| words[i % words.len()]).collect::<Vec<_>>().join(" ");
    let mut e = TextEngine::new();
    let t = boxed(&text, 10.0, 300.0, ParagraphStyle { align: TextAlign::JustifyLeft, ..hyphenating() });
    let _ = e.layout(&t, 72.0);
    let start = std::time::Instant::now();
    let l = e.layout(&t, 72.0);
    let ms = start.elapsed().as_secs_f64() * 1000.0;
    assert!(l.lines.len() > 100);
    let fast = boxed(&text, 10.0, 300.0, ParagraphStyle { align: TextAlign::JustifyLeft, composer: Composer::SingleLine, ..Default::default() });
    let _ = e.layout(&fast, 72.0);
    let start = std::time::Instant::now();
    let _ = e.layout(&fast, 72.0);
    let parley_ms = start.elapsed().as_secs_f64() * 1000.0;
    eprintln!("2,000 words: {ms:.1} ms, {} lines (parley's greedy breaker alone: {parley_ms:.1} ms)", l.lines.len());
    assert!(ms < 50.0, "{ms} ms");
}
