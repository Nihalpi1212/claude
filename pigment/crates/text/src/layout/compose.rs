//! Pigment (PORTS-B B3): Adobe's two paragraph composers and automatic hyphenation for box text.
//!
//! parley shapes the paragraph; this module chooses where its lines break. A paragraph composes
//! when its settings ask for more than parley's greedy breaker gives: the Every-line composer
//! (Photoshop's default) or Hyphenate. Point, path, area and vertical type, and a box paragraph
//! with the Single-line composer and no hyphenation, keep parley's breaks unchanged (the fast path).
//!
//! The pipeline (PORTS-B decision 2):
//! 1. the shaped paragraph is broken once without a width, so its clusters and advances can be
//!    read in logical order;
//! 2. each cluster becomes a box, each space glue, and each line-break opportunity (UAX #14 from
//!    `craft::text::segment`, plus the hyphenation points of `craft::text::hyphen` in each run's
//!    language) a penalty, as `craft::text::linebreak` items;
//! 3. Every-line runs Knuth and Plass's total fit (`linebreak::knuth_plass`, then
//!    `break_paragraph`) with the JavaScript Pigment's TeX costs; Single-line is that app's greedy
//!    `composeSingle`, ported below;
//! 4. parley breaks the paragraph again, one line at a time, each line given exactly the width the
//!    composer chose, so its own breaker ends the line at the chosen opportunity and parley still
//!    aligns and justifies it. A hyphenated word is set `WordBreak::BreakAll` when shaped, so parley
//!    may end a line inside it; the hyphen itself is drawn after the line's last glyph
//!    ([`Para::place_hyphen`]) and belongs to no layer-text offset, so carets, selections and
//!    `LineInfo.range` stay in layer offsets with no offset map.
//!
//! If parley's lines do not start where the composer's do (an opportunity only one of the two
//! breakers sees), the paragraph is broken by parley's greedy breaker instead.
//!
//! `craft::text::composer` (a glyph-level Every-line composer) is not used: it has its own costs
//! and no tiers, hanging punctuation or Hyphen Limit, which B4 and the Hyphenation dialog need.
//!
//! B3 does not shrink word spaces: parley's justification only stretches them, so a composed line
//! is never wider than its box. B4 adds shrinking and letter and glyph tiers with its own
//! justification of composed lines.

use std::ops::Range;

use craft::text::hyphen::{Lang, Limits, hyphen_points_in};
use craft::text::linebreak::{self, INFINITE_PENALTY, Item, Kind as ItemKind, Params, Rag};
use craft::text::segment;
use parley::{BreakReason, FontData, Layout, StyleProperty};
use photocraft_doc::text::{Composer, ParagraphStyle, TextAlign};

use super::shaping::Para;
use super::{GlyphOrient, PlacedGlyph, RunBrush, TextLayout};

// The JavaScript Pigment's costs (`lib/type/paragraph.js`, TeX's values).
const LINE_PENALTY: f64 = 10.0;
const HYPHEN_PENALTY: f64 = 50.0;
const EXPLICIT_HYPHEN_PENALTY: f64 = 50.0;
const DOUBLE_HYPHEN_DEMERITS: f64 = 3000.0;
const FITNESS_DEMERITS: f64 = 3000.0;
/// TeX's `\pretolerance` 100 and `\tolerance` 200 as adjustment ratios (badness = 100·r³).
const PRETOLERANCE: f64 = 1.0;
const TOLERANCE: f64 = 1.259_921_049_894_873;
/// The last pass accepts any ratio (and overfull lines), as JS's emergency pass.
const EMERGENCY_TOLERANCE: f64 = 1.0e6;
/// Ragged lines are rated against a stretch of six spaces (JS `ragStretch`).
const RAG_SPACES: f64 = 6.0;

/// What a line may end with right before a unit.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Before {
    /// No break.
    None,
    /// A line-break opportunity (UAX #14).
    Break,
    /// After a hyphen in the text ("well-known"): no hyphen is drawn.
    Explicit,
    /// An automatic hyphenation point; a hyphen this wide (px) ends the line.
    Hyphen(f64),
    /// After a discretionary (soft) hyphen: a hyphen this wide is drawn.
    Discretionary(f64),
    /// Inside a word no line can hold.
    Emergency,
}

/// What a unit is to the breaker.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum UnitKind {
    Box,
    Space,
    /// A no-break space: it stretches but never breaks.
    Fixed,
    /// A forced line break inside the paragraph.
    Newline,
}

/// One cluster of the paragraph, in logical order.
#[derive(Clone, Debug)]
pub(super) struct Unit {
    /// Byte range in the paragraph text.
    pub(super) range: Range<usize>,
    /// Width on the line (px).
    pub(super) width: f64,
    pub(super) kind: UnitKind,
    pub(super) before: Before,
}

/// The paragraph settings the breakers use.
#[derive(Clone, Copy, Debug)]
pub(super) struct Setting {
    pub(super) every_line: bool,
    pub(super) justified: bool,
    /// Most consecutive hyphenated lines (0 = no limit).
    pub(super) hyphen_limit: usize,
    /// Hyphenation Zone (px; ragged text).
    pub(super) zone: f64,
    /// Word Spacing minimum, desired and maximum, as fractions.
    pub(super) word: [f64; 3],
    /// Whether word spaces may close up to the minimum (B4; parley cannot shrink them).
    pub(super) shrink: bool,
}

impl Setting {
    pub(super) fn of(ps: &ParagraphStyle, k: f32) -> Self {
        let w = ps.justification.word;
        Self {
            every_line: ps.composer == Composer::EveryLine,
            justified: !matches!(ps.align, TextAlign::Left | TextAlign::Center | TextAlign::Right),
            hyphen_limit: usize::from(ps.hyphenation.hyphen_limit),
            zone: f64::from((ps.hyphenation.zone_pt * k).max(0.0)),
            word: [f64::from(w[0]) / 100.0, f64::from(w[1]) / 100.0, f64::from(w[2]) / 100.0],
            shrink: false,
        }
    }
}

/// Where one composed line ends: the unit that starts the next line (the unit count after the
/// last line), and whether a hyphen ends it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct LineBreak {
    pub(super) next: usize,
    pub(super) hyphen: bool,
}

/// The breaker's items for `units` (with or without the automatic hyphenation points and the
/// emergency breaks), and the
/// unit each item stands for (`units.len()` for the closing fill).
fn items(units: &[Unit], s: &Setting, hyphens: bool, emergency: bool) -> (Vec<Item>, Vec<usize>) {
    let n = units.len();
    let mut items = Vec::with_capacity(n * 2 + 1);
    let mut owner = Vec::with_capacity(n * 2 + 1);
    let stretch = |w: f64| w * (s.word[2] - s.word[1]).max(0.0) / s.word[1].max(1e-3);
    let shrink = |w: f64| if s.shrink { w * (s.word[1] - s.word[0]).max(0.0) / s.word[1].max(1e-3) } else { 0.0 };
    let mut i = 0;
    while i < n {
        let u = &units[i];
        if u.kind == UnitKind::Space {
            let mut j = i;
            while j < n && units[j].kind == UnitKind::Space {
                j += 1;
            }
            // A space run is a break when the line may end before the unit after it.
            let breakable = i > 0 && j < n && units[j].kind != UnitKind::Newline && units[j].before != Before::None;
            if !breakable {
                items.push(Item::no_break());
                owner.push(i);
            }
            for (k, sp) in units.iter().enumerate().take(j).skip(i) {
                items.push(Item::glue(sp.width, stretch(sp.width), shrink(sp.width)));
                owner.push(k);
            }
            i = j;
            continue;
        }
        if i > 0 && !matches!(units[i - 1].kind, UnitKind::Space | UnitKind::Newline) {
            let p = match u.before {
                Before::Break => Some(Item::penalty(0.0, 0.0, false)),
                Before::Explicit => Some(Item::penalty(0.0, EXPLICIT_HYPHEN_PENALTY, false)),
                Before::Hyphen(w) if hyphens => Some(Item { hyphenation: true, ..Item::penalty(w, HYPHEN_PENALTY, true) }),
                Before::Discretionary(w) => Some(Item { hyphenation: true, ..Item::penalty(w, HYPHEN_PENALTY, true) }),
                Before::Emergency if emergency => Some(Item::emergency()),
                Before::None | Before::Hyphen(_) | Before::Emergency => None,
            };
            if let Some(p) = p {
                items.push(p);
                owner.push(i);
            }
        }
        match u.kind {
            UnitKind::Box => {
                items.push(Item::boxed(u.width));
                owner.push(i);
            }
            UnitKind::Fixed => {
                items.push(Item::no_break());
                owner.push(i);
                items.push(Item::glue(u.width, stretch(u.width), shrink(u.width)));
                owner.push(i);
            }
            UnitKind::Newline => {
                items.push(Item::no_break());
                owner.push(i);
                items.push(Item::fill());
                owner.push(i);
                items.push(Item::forced());
                owner.push(i);
            }
            UnitKind::Space => {}
        }
        i += 1;
    }
    // TeX's `\parfillskip`, behind a penalty so the paragraph cannot break before it.
    items.push(Item::no_break());
    owner.push(n);
    items.push(Item::fill());
    owner.push(n);
    (items, owner)
}

/// Composes `units` into lines, line `k` being `width(k)` wide (px).
pub(super) fn compose_units(units: &[Unit], s: &Setting, width: &dyn Fn(usize) -> f64, uniform_from: usize) -> Vec<LineBreak> {
    if units.is_empty() {
        return vec![LineBreak { next: 0, hyphen: false }];
    }
    let spaces: Vec<f64> = units.iter().filter(|u| u.kind == UnitKind::Space).map(|u| u.width).collect();
    let space = if spaces.is_empty() { units.iter().map(|u| u.width).fold(0.0, f64::max) * 0.5 } else { spaces.iter().sum::<f64>() / spaces.len() as f64 };
    let rag = (!s.justified).then(|| Rag { stretch: RAG_SPACES * space.max(1e-3), width_fraction: 0.0, hyphenation_zone: s.zone, ..Rag::default() });
    let params = Params {
        line_penalty: LINE_PENALTY,
        flagged_demerits: DOUBLE_HYPHEN_DEMERITS,
        fitness_demerits: FITNESS_DEMERITS,
        hyphen_limit: s.hyphen_limit,
        uniform_from,
        rag,
        ..Params::default()
    };
    let hyphenates = units.iter().any(|u| matches!(u.before, Before::Hyphen(_)));
    if !s.every_line {
        let (it, owner) = items(units, s, true, true);
        let ends = single_line(&it, width, s, &params);
        return ends.into_iter().map(|(end, next)| to_break(&it, &owner, units.len(), end, next)).collect();
    }
    // TeX's and the JavaScript composer's passes: without hyphenation, with it, then accepting
    // anything (breaks inside overlong words, overfull lines).
    let mut passes = vec![(false, PRETOLERANCE)];
    if hyphenates {
        passes.push((true, TOLERANCE));
    }
    for (hyphens, tolerance) in passes {
        let (it, owner) = items(units, s, hyphens, false);
        if let Some(lines) = linebreak::knuth_plass(&it, width, &Params { tolerance, overfull: false, ..params }) {
            return lines.iter().map(|l| to_break(&it, &owner, units.len(), l.end, l.next)).collect();
        }
    }
    let (it, owner) = items(units, s, true, true);
    let b = linebreak::break_paragraph(&it, width, &params, &[EMERGENCY_TOLERANCE]);
    b.lines.iter().map(|l| to_break(&it, &owner, units.len(), l.end, l.next)).collect()
}

fn to_break(it: &[Item], owner: &[usize], n: usize, end: usize, next: usize) -> LineBreak {
    let hyphen = it.get(end).is_some_and(|i| i.kind == ItemKind::Penalty && i.hyphenation);
    LineBreak { next: owner.get(next).copied().unwrap_or(n).min(n), hyphen }
}

/// Prefix sums of the items' widths and tier-0 elasticity.
struct Sums {
    w: Vec<f64>,
    y: Vec<f64>,
    z: Vec<f64>,
}

impl Sums {
    fn new(it: &[Item]) -> Self {
        let (mut w, mut y, mut z) = (vec![0.0], vec![0.0], vec![0.0]);
        let (mut sw, mut sy, mut sz) = (0.0, 0.0, 0.0);
        for i in it {
            if i.kind != ItemKind::Penalty {
                sw += i.width;
                sy += i.stretch[0];
                sz += i.shrink[0];
            }
            w.push(sw);
            y.push(sy);
            z.push(sz);
        }
        Self { w, y, z }
    }
}

/// Adobe's Single-line composer as the JavaScript Pigment set it (`composeSingle`): each line
/// ends at the last whole-word break that fits; a hyphen is taken only when the whole-word line
/// would be spaced outside Minimum..Maximum (justified) or end further than the Hyphenation Zone
/// from the margin (ragged), or when no whole word fits. Returns each line's break item and the
/// first item of the next line.
fn single_line(it: &[Item], width: &dyn Fn(usize) -> f64, s: &Setting, p: &Params) -> Vec<(usize, usize)> {
    let len = it.len();
    let sums = Sums::new(it);
    let forced = |k: usize| it.get(k).is_some_and(|i| i.kind == ItemKind::Penalty && i.cost <= -INFINITE_PENALTY);
    let is_break = |k: usize| match it.get(k) {
        None => true,
        Some(i) => match i.kind {
            ItemKind::Penalty => i.cost < INFINITE_PENALTY,
            ItemKind::Glue => k > 0 && it[k - 1].kind == ItemKind::Box,
            _ => false,
        },
    };
    let hyph = |k: usize| it.get(k).is_some_and(|i| i.kind == ItemKind::Penalty && i.hyphenation);
    let emergency = |k: usize| it.get(k).is_some_and(|i| i.emergency);
    let natural = |a: usize, b: usize| {
        let pw = it.get(b).filter(|i| i.kind == ItemKind::Penalty).map_or(0.0, |i| i.width);
        sums.w[b.min(len)] - sums.w[a] + pw
    };
    let fits = |a: usize, b: usize, l: f64| {
        let w = natural(a, b);
        w <= l + p.overrun.max(1e-6) || (s.justified && s.shrink && w - (sums.z[b.min(len)] - sums.z[a]) <= l + 1e-6)
    };
    let ratio = |a: usize, b: usize, l: f64| {
        let d = l - natural(a, b);
        if d >= 0.0 {
            let y = sums.y[b.min(len)] - sums.y[a];
            if y > 0.0 {
                d / y
            } else if d > 1e-6 {
                f64::INFINITY
            } else {
                0.0
            }
        } else {
            let z = sums.z[b.min(len)] - sums.z[a];
            if z > 0.0 { d / z } else { f64::NEG_INFINITY }
        }
    };
    let next_start = |b: usize| {
        let mut j = b + 1;
        while j < len && it[j].kind != ItemKind::Box && !forced(j) {
            j += 1;
        }
        j.min(len)
    };
    let mut out = Vec::new();
    let (mut start, mut line, mut run) = (0usize, 0usize, 0usize);
    loop {
        let l = width(line);
        let (mut best, mut over) = (None, None);
        let mut k = start + 1;
        while k <= len {
            if k == len {
                if fits(start, len, l) {
                    best = Some(len);
                } else {
                    over = Some(len);
                }
                break;
            }
            if is_break(k) && !hyph(k) && !emergency(k) {
                if fits(start, k, l) {
                    best = Some(k);
                    if forced(k) {
                        break;
                    }
                } else {
                    over = Some(k);
                    break;
                }
            }
            k += 1;
        }
        let mut choice = best;
        if over.is_some() || best.is_none() {
            let lo = best.unwrap_or(start);
            let hi = over.unwrap_or(len);
            let allowed = s.hyphen_limit == 0 || run < s.hyphen_limit;
            let hy = (lo + 1..hi).rev().find(|&h| allowed && hyph(h) && fits(start, h, l));
            if let Some(h) = hy {
                let take = match best {
                    None => true,
                    Some(b) if s.justified => !(-1.0..=1.0).contains(&ratio(start, b, l)),
                    Some(b) => l - natural(start, b) >= s.zone,
                };
                if take {
                    choice = Some(h);
                }
            }
            if choice.is_none() {
                choice = (start + 1..hi).rev().find(|&e| emergency(e) && fits(start, e, l)).or(over).or(Some(len));
            }
        }
        let b = choice.unwrap_or(len);
        let next = if b >= len { len } else { next_start(b) };
        out.push((b, next));
        run = if hyph(b) { run + 1 } else { 0 };
        if b >= len || next >= len {
            break;
        }
        start = next;
        line += 1;
    }
    out
}

/// Whether a character is Hangul (Korean is set between words, as parley sets it: `hangul_runs`).
fn is_hangul(c: char) -> bool {
    matches!(c as u32, 0x1100..=0x11FF | 0x3130..=0x318F | 0xA960..=0xA97F | 0xAC00..=0xD7AF | 0xD7B0..=0xD7FF)
}

/// Fills in each unit's `before`: UAX #14 opportunities `opps` (sorted text offsets), the
/// automatic hyphenation `points` (sorted), no breaks where `no_break(offset)` holds on either
/// side (`no_break(offset)` of the character before a break), and emergency breaks inside words wider than `narrow` px. `hyphen(i)` is the width of a
/// hyphen after unit `i`.
pub(super) fn set_befores(
    text: &str,
    units: &mut [Unit],
    opps: &[usize],
    points: &[usize],
    no_break: &dyn Fn(usize) -> bool,
    hyphen: &dyn Fn(usize) -> f64,
    narrow: f64,
) {
    for i in 1..units.len() {
        let at = units[i].range.start;
        let prev_at = units[i - 1].range.start;
        // No break inside a No Break range or at its end; one may start a line (as parley's wrap
        // mode, which lags a cluster, allows).
        units[i].before = if no_break(prev_at) {
            Before::None
        } else if opps.binary_search(&at).is_ok() {
            let prev = text.get(..at).and_then(|t| t.chars().next_back());
            let cur = text.get(at..).and_then(|t| t.chars().next());
            match prev {
                Some('\u{AD}') => Before::Discretionary(hyphen(i - 1)),
                Some('-' | '\u{2010}') => Before::Explicit,
                Some(p) if is_hangul(p) && cur.is_some_and(is_hangul) => Before::None,
                _ => Before::Break,
            }
        } else if points.binary_search(&at).is_ok() {
            Before::Hyphen(hyphen(i - 1))
        } else {
            Before::None
        };
    }
    // Emergency breaks inside pieces (between opportunities) wider than the narrowest line.
    let mut i = 0;
    while i < units.len() {
        if units[i].kind != UnitKind::Box {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        let mut w = units[i].width;
        while j < units.len() && units[j].kind == UnitKind::Box && matches!(units[j].before, Before::None | Before::Hyphen(_)) {
            w += units[j].width;
            j += 1;
        }
        if w > narrow {
            for k in i + 1..j {
                let u = &units[k];
                if u.before == Before::None && !no_break(u.range.start) && !no_break(units[k - 1].range.start) {
                    units[k].before = Before::Emergency;
                }
            }
        }
        i = j;
    }
}

/// The automatic hyphenation points of a paragraph (offsets in its text) and the words that hold
/// them.
#[derive(Clone, Debug, Default)]
pub(super) struct Hyphens {
    pub(super) points: Vec<usize>,
    pub(super) words: Vec<Range<usize>>,
}

/// Hyphenation limits from the paragraph's Hyphenation settings.
fn limits(ps: &ParagraphStyle) -> Limits {
    let h = &ps.hyphenation;
    Limits {
        min_word: usize::from(h.words_longer_than),
        after_first: usize::from(h.after_first),
        before_last: usize::from(h.before_last),
        capitalized: h.capitalized,
    }
}

/// Right-to-left scripts: their paragraphs are composed without hyphenation.
fn is_rtl_script(c: char) -> bool {
    matches!(c as u32, 0x0590..=0x08FF | 0xFB1D..=0xFDFF | 0xFE70..=0xFEFF | 0x10800..=0x10FFF | 0x1E800..=0x1EFFF)
}

/// The hyphenation points of `text`: whitespace-delimited words, split where the language
/// changes, hyphenated by the language of `lang_at(offset)` (none: no points). `skip(offset)`
/// leaves a word out (No Break). Without Hyphenate Last Word the paragraph's last word keeps whole.
pub(super) fn hyphen_points(text: &str, lim: &Limits, last_word: bool, lang_at: &dyn Fn(usize) -> Option<Lang>, skip: &dyn Fn(usize) -> bool) -> Hyphens {
    let mut out = Hyphens::default();
    if text.chars().any(is_rtl_script) {
        return out;
    }
    let mut words: Vec<Range<usize>> = Vec::new();
    let mut start: Option<(usize, Option<Lang>)> = None;
    for (i, c) in text.char_indices().chain(std::iter::once((text.len(), ' '))) {
        let lang = if i < text.len() { lang_at(i) } else { None };
        let word_char = !c.is_whitespace() && c != '\u{AD}';
        match start {
            Some((s, l)) if !word_char || l != lang => {
                words.push(s..i);
                start = word_char.then_some((i, lang));
            }
            None if word_char => start = Some((i, lang)),
            _ => {}
        }
    }
    let last = words.iter().rposition(|w| text[w.clone()].chars().any(char::is_alphabetic));
    for (wi, w) in words.iter().enumerate() {
        if (!last_word && Some(wi) == last) || w.clone().any(|o| text.is_char_boundary(o) && skip(o)) {
            continue;
        }
        let Some(lang) = lang_at(w.start) else { continue };
        let pts = hyphen_points_in(&text[w.clone()], lim, lang);
        if !pts.is_empty() {
            out.points.extend(pts.into_iter().map(|p| w.start + p));
            out.words.push(w.clone());
        }
    }
    out.points.sort_unstable();
    out
}

/// The glyph and advance (px, at `size`) of a hyphen in a font: U+2010, else the hyphen-minus.
pub(super) fn hyphen_glyph(font: &FontData, coords: &[i16], size: f32) -> Option<(u32, f32)> {
    use skrifa::MetadataProvider;
    let f = skrifa::FontRef::from_index(font.data.as_ref(), font.index).ok()?;
    let coords: Vec<skrifa::instance::NormalizedCoord> = coords.iter().map(|&c| skrifa::instance::NormalizedCoord::from_bits(c)).collect();
    let gm = f.glyph_metrics(skrifa::instance::Size::new(size), skrifa::instance::LocationRef::new(&coords));
    let cmap = f.charmap();
    ['\u{2010}', '-'].into_iter().find_map(|c| cmap.map(c)).map(|g| (g.to_u32(), gm.advance_width(g).unwrap_or(0.0)))
}

/// One cluster of the unbroken layout.
struct Raw {
    range: Range<usize>,
    advance: f32,
    kind: UnitKind,
    style: usize,
    /// The width (px, unscaled) of a hyphen in the cluster's font.
    hyphen: f32,
}

/// A horizontal scale's factor (unset is 100%).
fn scale(st: &photocraft_doc::text::CharStyle) -> f32 {
    if st.horizontal_scale > 0.0 { st.horizontal_scale } else { 1.0 }
}

impl Para<'_> {
    /// Whether this paragraph's lines are chosen here rather than by parley's greedy breaker.
    pub(super) fn composes(&self) -> bool {
        let env = self.env;
        env.is_box && env.wraps && !env.vertical && env.area.is_none() && self.avail.is_some() && (self.ps.composer == Composer::EveryLine || self.ps.hyphenate)
    }

    /// The paragraph's text as shaped.
    fn para_text(&self) -> &str {
        self.text_of(0..self.prefix.len() + (self.content_end - self.start))
    }

    /// The paragraph's hyphenation points (found once).
    pub(super) fn hyphens(&self) -> &Hyphens {
        self.hyphens.get_or_init(|| {
            if !self.composes() || !self.ps.hyphenate {
                return Hyphens::default();
            }
            let env = self.env;
            let text = self.para_text();
            let style = |o: usize| &env.styles[env.style_at(self.map_offset(o))];
            let lang_at = |o: usize| Lang::for_language(style(o).language.as_deref().unwrap_or("en-US"));
            let skip = |o: usize| o < self.prefix.len() || style(o).no_break;
            hyphen_points(text, &limits(&self.ps), self.ps.hyphenation.last_word, &lang_at, &skip)
        })
    }

    /// Sets the words that hold hyphenation points `WordBreak::BreakAll`, so parley may end a line
    /// inside them (where the composer chose a hyphenation point).
    pub(super) fn push_hyphen_words(&self, b: &mut parley::RangedBuilder<'_, RunBrush>) {
        for w in &self.hyphens().words {
            b.push(StyleProperty::WordBreak(parley::WordBreak::BreakAll), w.clone());
        }
    }

    /// The clusters of the unbroken `layout`, in logical order (ligature pieces merged).
    fn raw_clusters(&self, layout: &Layout<RunBrush>) -> Vec<Raw> {
        let text = self.para_text();
        let mut raw: Vec<(Raw, bool)> = Vec::new();
        for line in layout.lines() {
            for run in line.runs() {
                let hyphen = hyphen_glyph(run.font(), run.normalized_coords(), run.font_size()).map_or(0.0, |h| h.1);
                for c in run.clusters() {
                    let range = c.text_range();
                    let kind = if c.is_hard_line_break() {
                        UnitKind::Newline
                    } else if c.is_space_or_nbsp() {
                        if text.get(range.start..).is_some_and(|t| t.starts_with(' ')) { UnitKind::Space } else { UnitKind::Fixed }
                    } else {
                        UnitKind::Box
                    };
                    let advance = if kind == UnitKind::Newline { 0.0 } else { c.advance() };
                    let r = Raw { range, advance, kind, style: c.first_style().brush.0 as usize, hyphen };
                    raw.push((r, c.is_ligature_continuation()));
                }
            }
        }
        raw.sort_by_key(|(r, _)| r.range.start);
        let mut out: Vec<Raw> = Vec::with_capacity(raw.len());
        for (r, cont) in raw {
            match out.last_mut() {
                Some(prev) if cont => {
                    prev.range.end = prev.range.end.max(r.range.end);
                    prev.advance += r.advance;
                }
                _ => out.push(r),
            }
        }
        out
    }

    /// Breaks `layout` with this paragraph's composer; false when it doesn't compose (parley's
    /// greedy breaker then breaks it).
    pub(super) fn compose_lines(&self, layout: &mut Layout<RunBrush>) -> bool {
        if !self.composes() {
            return false;
        }
        let Some(avail) = self.avail else { return false };
        let env = self.env;
        layout.break_all_lines(None);
        let raw = self.raw_clusters(layout);
        let text = self.para_text();
        let round = env.whole_px.advances;
        let hs = |r: &Raw| env.styles.get(r.style).map_or(1.0, scale);
        let mut units: Vec<Unit> = raw
            .iter()
            .map(|r| {
                let w = f64::from(r.advance * hs(r));
                Unit { range: r.range.clone(), width: if round { w.round() } else { w }, kind: r.kind, before: Before::None }
            })
            .collect();
        let first_style = self.first_style();
        let opts = segment::Options::for_language(first_style.language.as_deref());
        let opps: Vec<usize> = segment::line_breaks(text, &opts).into_iter().filter(|b| !b.mandatory).map(|b| b.offset).collect();
        let no_break = |o: usize| o >= self.prefix.len() && env.styles[env.style_at(self.map_offset(o))].no_break;
        let hyphen_w = |i: usize| raw.get(i).map_or(0.0, |r| f64::from(r.hyphen * hs(r)));
        let width = |n: usize| f64::from(if n == 0 { avail - self.first_indent } else { avail }).max(1.0);
        let narrow = width(0).min(width(1));
        set_befores(text, &mut units, &opps, &self.hyphens().points, &no_break, &hyphen_w, narrow);
        let uniform_from = usize::from(self.first_indent != 0.0);
        let lines = compose_units(&units, &Setting::of(&self.ps, env.k), &width, uniform_from);
        // Each line's width as parley measures it (unscaled advances): to its last box, or through its
        // spaces when more than one ends it (parley hangs a single overflowing space).
        let starts: Vec<usize> = std::iter::once(0).chain(lines.iter().map(|l| l.next)).collect();
        let mut targets = Vec::with_capacity(lines.len());
        for (li, l) in lines.iter().enumerate() {
            let (a, mut e) = (starts[li], l.next.min(raw.len()));
            let trailing = raw[a..e].iter().rev().take_while(|r| r.kind == UnitKind::Space).count();
            if trailing == 1 {
                e -= 1;
            }
            let w: f64 = raw[a..e].iter().map(|r| f64::from(r.advance)).sum();
            let hyphen = if l.hyphen && e > a { hyphen_w(e - 1) } else { 0.0 };
            targets.push((w, hyphen));
        }
        let indent = self.first_indent / self.break_scale;
        let full = avail / self.break_scale;
        {
            let mut br = layout.break_lines();
            br.state_mut().set_layout_max_advance(f32::INFINITY);
            for (li, &(w, hyphen)) in targets.iter().enumerate() {
                let eps = 1e-3 * w.abs().max(1.0);
                let max = (w + eps) as f32 + if li == 0 { indent } else { 0.0 };
                br.state_mut().set_line_max_advance(max.max(0.0));
                if br.break_next().is_none() {
                    break;
                }
                br.set_prior_line_width((full - hyphen as f32 / self.break_scale).max(0.0));
            }
            while !br.is_done() {
                br.state_mut().set_line_max_advance(full);
                if br.break_next().is_none() {
                    break;
                }
                br.set_prior_line_width(full);
            }
            br.finish();
        }
        let want: Vec<usize> = starts[..lines.len()].iter().map(|&u| raw.get(u).map_or(text.len(), |r| r.range.start)).collect();
        let got: Vec<usize> = layout.lines().map(|l| l.text_range().start).collect();
        if want != got {
            // An opportunity only one of the two breakers sees: parley's greedy lines.
            layout.break_all_lines(Some(full));
        }
        true
    }

    /// The hyphen at the end of a composed line broken at a hyphenation point or soft hyphen:
    /// drawn after the line's last glyph in its face, with no layer-text offset. Returns its width.
    pub(super) fn place_hyphen(&self, out: &mut TextLayout, line: &parley::Line<'_, RunBrush>, c0: usize, g0: usize) -> f32 {
        if !self.composes() || line.break_reason() != BreakReason::Regular {
            return 0.0;
        }
        let end = line.text_range().end;
        let soft = self.para_text().get(..end).is_some_and(|t| t.ends_with('\u{AD}'));
        if !soft && self.hyphens().points.binary_search(&end).is_err() {
            return 0.0;
        }
        let b = self.map_offset(end);
        let Some(x) = out.clusters[c0..].iter().filter(|c| c.range.end == b && !c.rtl).map(|c| c.x + c.advance).reduce(f32::max) else {
            return 0.0;
        };
        let Some(g) = out.glyphs[g0..].iter().zip(&out.glyph_ranges[g0..]).rev().find(|(_, r)| r.end == b).map(|(g, _)| *g) else {
            return 0.0;
        };
        let Some(face) = out.faces.get(g.face as usize) else { return 0.0 };
        let Some((id, advance)) = hyphen_glyph(&face.font, &face.coords, face.size_px) else {
            return 0.0;
        };
        let hs = self.env.styles.get(g.style as usize).map_or(1.0, scale);
        out.glyphs.push(PlacedGlyph { id, x, orient: GlyphOrient::Horizontal, line_center: None, ..g });
        out.glyph_ranges.push(b..b);
        advance * hs
    }
}

#[cfg(test)]
#[path = "compose_tests.rs"]
mod tests;
