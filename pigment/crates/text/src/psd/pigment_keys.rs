//! Pigment: the EngineData keys of the type settings PORTS-B B1 adds to the model, written and
//! read beside the keys `build.rs` and `import.rs` already handle (one hook line each there).
//!
//! Character (`StyleSheetData`): `NoBreak`, and `Language` through [`super::language`].
//! Paragraph (`ParagraphSheet` `Properties`): `HyphenatedWordSize`, `PreHyphen`, `PostHyphen`,
//! `ConsecutiveHyphens`, `Zone`, `WordSpacing`, `LetterSpacing`, `GlyphSpacing` (fractions:
//! 0.8 / 1.0 / 1.33), `Hanging` and `EveryLineComposer`, in the order Photoshop writes them.
//! These are the key names Photoshop's files are known to use; their default values have not yet
//! been checked against a Photoshop 2026 sample. The settings with no known key (Hyphenate
//! Capitalized Words, Last Word, Across Column, Single Word Justification, lists, System Layout)
//! are kept in the layer's XMP by `photocraft_io::type_xmp` instead.

use photocraft_doc::text::{CharStyle, Composer, Hyphenation, Justification, ParagraphStyle};

use super::E;
use super::import::real;

/// Adds the Pigment character keys to a `StyleSheetData` dictionary being written.
pub(super) fn put_char(dict: &mut Vec<(String, E)>, s: &CharStyle) {
    dict.push(("NoBreak".into(), E::Bool(s.no_break)));
    if let Some(code) = s.language.as_deref().and_then(super::language::code_for) {
        dict.push(("Language".into(), E::Int(code)));
    }
}

/// Adds the Pigment paragraph keys to a `ParagraphSheet` `Properties` dictionary being written,
/// at the places Photoshop writes them (`k` = 72 / dpi, as for the indents).
pub(super) fn put_para(dict: &mut Vec<(String, E)>, p: &ParagraphStyle, k: f32) {
    let h = &p.hyphenation;
    let j = &p.justification;
    let fractions = |v: &[f32; 3]| E::Array(v.iter().map(|x| real(x / 100.0)).collect());
    let after_hyphenate = dict.iter().position(|(key, _)| key == "AutoHyphenate").map_or(dict.len(), |i| i + 1);
    let hyphenation = [
        ("HyphenatedWordSize", E::Int(i64::from(h.words_longer_than))),
        ("PreHyphen", E::Int(i64::from(h.after_first))),
        ("PostHyphen", E::Int(i64::from(h.before_last))),
        ("ConsecutiveHyphens", E::Int(i64::from(h.hyphen_limit))),
        ("Zone", real(h.zone_pt / k)),
        ("WordSpacing", fractions(&j.word)),
        ("LetterSpacing", fractions(&j.letter)),
        ("GlyphSpacing", fractions(&j.glyph)),
    ];
    for (i, (key, v)) in hyphenation.into_iter().enumerate() {
        dict.insert(after_hyphenate + i, (key.into(), v));
    }
    dict.push(("Hanging".into(), E::Bool(p.hanging_punctuation)));
    dict.push(("EveryLineComposer".into(), E::Bool(p.composer == Composer::EveryLine)));
}

/// Reads the Pigment character keys (`g` looks a key up through the run's sheets).
pub(super) fn read_char<'a>(s: &mut CharStyle, g: &dyn Fn(&str) -> Option<&'a E>) {
    s.no_break = g("NoBreak").and_then(E::as_bool).unwrap_or(false);
    s.language = g("Language").and_then(E::as_i64).and_then(super::language::tag_for).map(str::to_string);
}

/// A whole number of `key` inside `range`, else `None` (a file's out-of-range value is not taken).
fn whole<'a>(g: &dyn Fn(&str) -> Option<&'a E>, key: &str, range: std::ops::RangeInclusive<u8>) -> Option<u8> {
    let v = g(key).and_then(E::as_f64).filter(|v| v.is_finite() && v.fract() == 0.0)?;
    u8::try_from(v as i64).ok().filter(|n| range.contains(n))
}

/// Three fractions as percentages inside `range`, in order, else `None`.
fn percents<'a>(g: &dyn Fn(&str) -> Option<&'a E>, key: &str, range: std::ops::RangeInclusive<f32>) -> Option<[f32; 3]> {
    let a = g(key)?.as_array().filter(|a| a.len() == 3)?;
    let mut out = [0.0f32; 3];
    for (o, v) in out.iter_mut().zip(a) {
        // Rounded to 1/100 %, so 1.33 reads back as 133 % and not 133.00000762939453.
        *o = ((v.as_f64()? * 100.0 * 100.0).round() / 100.0) as f32;
    }
    (out.iter().all(|x| range.contains(x)) && out[0] <= out[1] && out[1] <= out[2]).then_some(out)
}

/// Reads the Pigment paragraph keys (`g` looks a key up through the run's sheets; `k` = 72 / dpi).
/// A missing or out-of-range key keeps the default. A file that doesn't say which composer it
/// used gets Single-line: PhotoCraft's PSDs written before the key existed were laid out that way.
pub(super) fn read_para<'a>(p: &mut ParagraphStyle, g: &dyn Fn(&str) -> Option<&'a E>, k: f32) {
    let h = &mut p.hyphenation;
    if let Some(n) = whole(g, "HyphenatedWordSize", Hyphenation::WORDS_LONGER_THAN) {
        h.words_longer_than = n;
    }
    if let Some(n) = whole(g, "PreHyphen", Hyphenation::AFTER_FIRST) {
        h.after_first = n;
    }
    if let Some(n) = whole(g, "PostHyphen", Hyphenation::BEFORE_LAST) {
        h.before_last = n;
    }
    if let Some(n) = whole(g, "ConsecutiveHyphens", Hyphenation::HYPHEN_LIMIT) {
        h.hyphen_limit = n;
    }
    if let Some(z) = g("Zone").and_then(E::as_f64).map(|z| ((z * f64::from(k) * 1000.0).round() / 1000.0) as f32).filter(|z| Hyphenation::ZONE_PT.contains(z)) {
        h.zone_pt = z;
    }
    let j = &mut p.justification;
    for (key, range, field) in
        [("WordSpacing", Justification::WORD, &mut j.word), ("LetterSpacing", Justification::LETTER, &mut j.letter), ("GlyphSpacing", Justification::GLYPH, &mut j.glyph)]
    {
        if let Some(v) = percents(g, key, range) {
            *field = v;
        }
    }
    p.hanging_punctuation = g("Hanging").and_then(E::as_bool).unwrap_or(false);
    p.composer = if g("EveryLineComposer").and_then(E::as_bool) == Some(true) { Composer::EveryLine } else { Composer::SingleLine };
}

/// The `Language` of each style run of an EngineData template, as `(UTF-16 start, end, value)`.
pub(super) fn template_languages(e: &E) -> Vec<(usize, usize, E)> {
    let Some(run) = e.path(&["EngineDict", "StyleRun"]) else { return Vec::new() };
    let lens = run.get("RunLengthArray").and_then(E::as_array).unwrap_or(&[]);
    let sheets = run.get("RunArray").and_then(E::as_array).unwrap_or(&[]);
    let mut out = Vec::new();
    let mut at = 0usize;
    for (len, sheet) in lens.iter().zip(sheets) {
        let n = len.as_f64().filter(|n| n.is_finite() && *n > 0.0).map_or(0, |n| n as usize);
        if let Some(lang) = sheet.path(&["StyleSheet", "StyleSheetData", "Language"]).filter(|v| v.as_i64().is_some()) {
            out.push((at, at.saturating_add(n), lang.clone()));
        }
        at = at.saturating_add(n);
    }
    out
}

/// A run at UTF-16 offset `at` whose style names no language keeps the `Language` the file had
/// there (a code [`super::language`] can't name yet survives an edit of the layer).
pub(super) fn keep_language(data: &mut E, s: &CharStyle, kept: &[(usize, usize, E)], at: usize) {
    if s.language.is_some() || data.get("Language").is_some() {
        return;
    }
    if let Some((_, _, v)) = kept.iter().find(|(a, b, _)| (*a..*b).contains(&at)) {
        data.set("Language", v.clone());
    }
}

#[cfg(test)]
#[path = "pigment_keys_tests.rs"]
mod tests;
