//! Pigment (B3): the composers on fixed advances, ported from the JavaScript Pigment's
//! `tests/unit/type-paragraph-panel.test.mjs` (every character `ch` px, a space `sp` px).

use craft::text::hyphen::{Lang, Limits};
use craft::text::segment;

use super::{Before, LineBreak, Setting, Unit, UnitKind, compose_units, hyphen_points, set_befores};

struct Case<'a> {
    text: &'a str,
    width: f64,
    ch: f64,
    sp: f64,
    hyphenate: bool,
    lim: Limits,
    last_word: bool,
    no_break: Option<std::ops::Range<usize>>,
}

impl<'a> Case<'a> {
    fn new(text: &'a str, width: f64) -> Self {
        Self { text, width, ch: 10.0, sp: 5.0, hyphenate: false, lim: js_limits(), last_word: true, no_break: None }
    }
}

/// The JavaScript Pigment's hyphenation defaults (`HYPHENATION_DEFAULTS` 7/2/2).
fn js_limits() -> Limits {
    Limits { min_word: 7, after_first: 2, before_last: 2, capitalized: true }
}

fn setting(every_line: bool, justified: bool) -> Setting {
    Setting { every_line, justified, hyphen_limit: 0, zone: 0.0, word: [0.8, 1.0, 1.33], shrink: false }
}

fn units(c: &Case<'_>) -> Vec<Unit> {
    let mut units: Vec<Unit> = c
        .text
        .char_indices()
        .map(|(i, ch)| {
            let kind = if ch == ' ' { UnitKind::Space } else { UnitKind::Box };
            let width = match ch {
                ' ' => c.sp,
                '\u{AD}' => 0.0,
                _ => c.ch,
            };
            Unit { range: i..i + ch.len_utf8(), width, kind, before: Before::None }
        })
        .collect();
    let opps: Vec<usize> = segment::line_breaks(c.text, &segment::Options::default()).into_iter().filter(|b| !b.mandatory).map(|b| b.offset).collect();
    let nb = c.no_break.clone();
    let no_break = move |o: usize| nb.as_ref().is_some_and(|r| r.contains(&o));
    let points = if c.hyphenate { hyphen_points(c.text, &c.lim, c.last_word, &|_| Some(Lang::English), &no_break).points } else { Vec::new() };
    set_befores(c.text, &mut units, &opps, &points, &no_break, &|_| c.ch, c.width);
    units
}

fn lines(c: &Case<'_>, s: &Setting) -> Vec<String> {
    let us = units(c);
    let breaks = compose_units(&us, s, &|_| c.width, 0);
    show(c.text, &us, &breaks)
}

fn show(text: &str, us: &[Unit], breaks: &[LineBreak]) -> Vec<String> {
    let mut out = Vec::new();
    let mut a = 0;
    for b in breaks {
        let from = us.get(a).map_or(text.len(), |u| u.range.start);
        let to = us.get(b.next).map_or(text.len(), |u| u.range.start);
        out.push(format!("{}{}", text[from..to].trim_end(), if b.hyphen { "-" } else { "" }));
        a = b.next;
    }
    out
}

#[test]
fn every_line_finds_the_classic_minimum_raggedness_where_single_line_is_ragged() {
    // Line width 6 characters, a space is one: greedy sets "aaa bb" / "cc" / "ddddd", the optimum
    // "aaa" / "bb cc" / "ddddd".
    let c = Case { sp: 10.0, ..Case::new("aaa bb cc ddddd", 60.0) };
    assert_eq!(lines(&c, &setting(false, false)), ["aaa bb", "cc", "ddddd"]);
    assert_eq!(lines(&c, &setting(true, false)), ["aaa", "bb cc", "ddddd"]);
}

#[test]
fn single_line_on_ragged_text_is_first_fit() {
    let c = Case::new("The quick brown fox jumps over the lazy dog and then it runs far away into the woods tonight", 250.0);
    let got = lines(&c, &setting(false, false));
    // First fit by hand: each line takes every word that still fits.
    let mut want: Vec<String> = Vec::new();
    let mut cur = String::new();
    for w in c.text.split(' ') {
        let next = if cur.is_empty() { w.to_string() } else { format!("{cur} {w}") };
        let width = next.chars().map(|ch| if ch == ' ' { c.sp } else { c.ch }).sum::<f64>();
        if width <= c.width || cur.is_empty() {
            cur = next;
        } else {
            want.push(std::mem::take(&mut cur));
            cur = w.to_string();
        }
    }
    want.push(cur);
    assert_eq!(got, want);
}

#[test]
fn every_line_justified_breaks_differ_from_greedy_and_fit_the_box() {
    let c = Case { sp: 6.0, ..Case::new("The quick brown fox jumps over the lazy dog and then it runs far away into the woods tonight", 250.0) };
    // With B4's shrinking, as the JavaScript test: Every-line takes a tighter line where greedy is loose.
    let s = Setting { word: [0.5, 1.0, 2.0], shrink: true, ..setting(true, true) };
    let every = lines(&c, &s);
    let single = lines(&c, &Setting { every_line: false, ..s });
    assert_ne!(every, single);
    for l in &every {
        let spaces = l.matches(' ').count() as f64;
        let w: f64 = l.chars().map(|ch| if ch == ' ' { c.sp } else { c.ch }).sum();
        assert!(w - spaces * c.sp * 0.5 <= c.width + 1e-6, "{l:?} is {w} wide");
    }
    // Without shrinking (B3's layout) no line is wider than the box.
    for l in lines(&c, &Setting { shrink: false, ..s }) {
        let w: f64 = l.chars().map(|ch| if ch == ' ' { c.sp } else { c.ch }).sum();
        assert!(w <= c.width + 1e-6, "{l:?} is {w} wide");
    }
}

#[test]
fn single_line_prefers_spacing_within_its_range_to_a_hyphen() {
    let text = "abc hyphenation";
    // Justified, 120 px: "abc" alone would need its one space stretched far past Maximum.
    let c = Case { hyphenate: true, ..Case::new(text, 120.0) };
    let got = lines(&c, &setting(false, true));
    assert_eq!(got.len(), 2);
    assert!(got[0].starts_with("abc hyph") && got[0].ends_with('-'), "{got:?}");
    // Room for the whole line once its space closes up (B4's shrinking): no hyphen.
    let c = Case { hyphenate: true, ..Case::new(text, 144.0) };
    assert_eq!(lines(&c, &Setting { shrink: true, ..setting(false, true) }), ["abc hyphenation"]);
}

#[test]
fn ragged_single_line_hyphenates_only_past_the_zone() {
    let text = "abc hyphenation";
    let c = Case { hyphenate: true, ..Case::new(text, 120.0) };
    // "abc" leaves 90 px: a wider zone keeps the word whole, a narrower one hyphenates.
    assert_eq!(lines(&c, &Setting { zone: 100.0, ..setting(false, false) }), ["abc", "hyphenation"]);
    let got = lines(&c, &Setting { zone: 20.0, ..setting(false, false) });
    assert!(got[0].starts_with("abc hyph") && got[0].ends_with('-'), "{got:?}");
    // A word longer than the line is hyphenated whatever the zone.
    let c = Case { hyphenate: true, ..Case::new(text, 100.0) };
    let got = lines(&c, &Setting { zone: 100.0, ..setting(false, false) });
    assert_eq!(got[0], "abc");
    assert!(got[1].ends_with('-') && got.len() == 3, "{got:?}");
}

fn max_hyphen_run(ls: &[String]) -> usize {
    let (mut n, mut best) = (0, 0);
    for l in ls {
        n = if l.ends_with('-') { n + 1 } else { 0 };
        best = best.max(n);
    }
    best
}

#[test]
fn hyphen_limit_and_hyphenate_last_word() {
    let text = "hyphenation hyphenation hyphenation hyphenation";
    for limit in [1, 2] {
        for every in [true, false] {
            let c = Case { hyphenate: true, ..Case::new(text, 160.0) };
            let got = lines(&c, &Setting { hyphen_limit: limit, ..setting(every, false) });
            assert!(max_hyphen_run(&got) <= limit, "{limit} {every}: {got:?}");
        }
    }
    let unlimited = lines(&Case { hyphenate: true, ..Case::new(text, 160.0) }, &setting(false, false));
    assert!(max_hyphen_run(&unlimited) > 1, "the limit test needs consecutive hyphens: {unlimited:?}");
    // Hyphenate Last Word off: the last word stays whole.
    let c = Case { hyphenate: true, last_word: false, ..Case::new(text, 160.0) };
    let got = lines(&c, &setting(true, false));
    assert!(got.last().is_some_and(|l| l.ends_with("hyphenation")), "{got:?}");
    assert!(!got[got.len() - 2].ends_with('-'), "{got:?}");
}

#[test]
fn words_longer_than_and_the_letter_limits_filter_hyphenation_points() {
    let text = "abc hyphenation";
    let c = Case { hyphenate: true, lim: Limits { min_word: 25, ..js_limits() }, ..Case::new(text, 120.0) };
    assert!(lines(&c, &setting(false, false)).iter().all(|l| !l.ends_with('-')));
    let pts = |lim: Limits| hyphen_points("hyphenation", &lim, true, &|_| Some(Lang::English), &|_| false).points;
    let all = pts(Limits { after_first: 1, before_last: 1, ..js_limits() });
    let strict = pts(Limits { after_first: 4, before_last: 4, ..js_limits() });
    assert!(!strict.is_empty() && strict.len() < all.len(), "{all:?} {strict:?}");
    assert!(strict.iter().all(|&p| p >= 4 && "hyphenation".len() - p >= 4));
}

#[test]
fn no_break_ranges_take_no_hyphen_and_no_break() {
    let text = "abc hyphenation";
    let c = Case { hyphenate: true, no_break: Some(4..15), ..Case::new(text, 120.0) };
    assert_eq!(lines(&c, &setting(true, false)), ["abc", "hyphenation"]);
    // "aaa bbb ccc" in a box fitting "aaa bbb": with "bbb ccc" no-break the line ends after "aaa".
    let c = Case { sp: 10.0, ..Case::new("aaa bbb ccc", 70.0) };
    assert_eq!(lines(&c, &setting(true, false)), ["aaa bbb", "ccc"]);
    let c = Case { sp: 10.0, no_break: Some(4..11), ..Case::new("aaa bbb ccc", 70.0) };
    assert_eq!(lines(&c, &setting(true, false)), ["aaa", "bbb ccc"]);
}

#[test]
fn a_word_wider_than_the_line_breaks_inside() {
    let c = Case::new("aa bbbbbbbbbbbbbbbbbbbb", 100.0);
    for every in [true, false] {
        let got = lines(&c, &setting(every, false));
        assert!(got.len() >= 3, "{got:?}");
        assert!(got.iter().all(|l| l.chars().count() <= 10), "{got:?}");
        assert!(got.iter().all(|l| !l.ends_with('-')), "an emergency break draws no hyphen: {got:?}");
    }
}

#[test]
fn explicit_and_soft_hyphens_are_breaks_and_only_soft_ones_draw() {
    let c = Case::new("aaaa well-known", 100.0);
    let got = lines(&c, &setting(true, false));
    assert_eq!(got, ["aaaa well-", "known"]);
    let c = Case::new("aaaa well\u{AD}known", 100.0);
    let got = lines(&c, &setting(true, false));
    assert_eq!(got.len(), 2);
    assert!(got[0].ends_with('-'), "{got:?}");
}
