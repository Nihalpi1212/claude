//! Pigment (PORTS-B B1): the EngineData keys of No Break, Fractional Widths, the hyphenation and
//! justification settings, Roman Hanging Punctuation and the composer, written and read back.

use std::sync::Arc;

use photocraft_doc::TextLayer;
use photocraft_doc::text::{CharStyle, Composer, Hyphenation, Justification, ParagraphRun, ParagraphStyle, SingleWord, TextRun};

use super::super::{E, build_engine_data, build_tysh, engine_data, parse_tysh, text_layer_from_tysh};

fn layer(text: &str, run: CharStyle, para: ParagraphStyle) -> TextLayer {
    TextLayer {
        text: text.into(),
        runs: vec![TextRun { len: text.len(), style: run }],
        paragraphs: vec![ParagraphRun { len: text.len(), style: para }],
        ..Default::default()
    }
}

fn styled() -> (CharStyle, ParagraphStyle) {
    let run = CharStyle { size_pt: 12.0, no_break: true, ..Default::default() };
    let para = ParagraphStyle {
        hyphenate: true,
        hyphenation: Hyphenation { words_longer_than: 9, after_first: 3, before_last: 4, hyphen_limit: 1, zone_pt: 18.0, ..Default::default() },
        justification: Justification { word: [70.0, 90.0, 120.0], letter: [-5.0, 0.0, 10.0], glyph: [95.0, 100.0, 105.0], ..Default::default() },
        composer: Composer::SingleLine,
        hanging_punctuation: true,
        ..Default::default()
    };
    (run, para)
}

fn engine(t: &TextLayer, dpi: f32) -> E {
    engine_data(&parse_tysh(&build_tysh(t, dpi, None).unwrap()).unwrap().text).unwrap()
}

#[test]
fn the_keys_round_trip_through_engine_data() {
    let (run, para) = styled();
    let mut t = layer("Hyphenation", run.clone(), para.clone());
    t.fractional_widths = false;
    // At 144 dpi, so the zone scales like the indents.
    for dpi in [72.0, 144.0] {
        let back = text_layer_from_tysh(&build_tysh(&t, dpi, None).unwrap(), dpi).unwrap();
        assert!(!back.fractional_widths, "{dpi}");
        assert!(back.char_runs()[0].style.no_break, "{dpi}");
        let p = &back.paragraph_runs()[0].style;
        assert_eq!((p.hyphenation, p.justification, p.composer, p.hanging_punctuation), (para.hyphenation, para.justification, para.composer, true), "{dpi}");
    }
    let e = engine(&t, 144.0);
    let props = e.path(&["EngineDict", "ParagraphRun", "RunArray"]).and_then(|a| a.index(0)).and_then(|r| r.path(&["ParagraphSheet", "Properties"])).unwrap();
    assert_eq!(props.get("Zone").and_then(E::as_f64), Some(36.0), "18 pt at 144 dpi");
    let fractions: Vec<f64> = props.get("WordSpacing").and_then(E::as_array).unwrap().iter().filter_map(E::as_f64).collect();
    assert!(fractions.iter().zip([0.7, 0.9, 1.2]).all(|(a, b)| (a - b).abs() < 1e-6), "{fractions:?}");
    // Photoshop's order: the hyphenation keys after AutoHyphenate, the composer last.
    let E::Dict(items) = props else { panic!() };
    let keys: Vec<&str> = items.iter().map(|(k, _)| k.as_str()).collect();
    let at = |k: &str| keys.iter().position(|x| *x == k).unwrap();
    assert_eq!(at("HyphenatedWordSize"), at("AutoHyphenate") + 1);
    assert_eq!(keys.last(), Some(&"EveryLineComposer"));
    assert_eq!(e.path(&["EngineDict", "UseFractionalGlyphWidths"]).and_then(E::as_bool), Some(false));
}

#[test]
fn photoshops_defaults_and_the_every_line_composer_are_written() {
    let t = layer("Plain", CharStyle { size_pt: 12.0, ..Default::default() }, ParagraphStyle::default());
    let back = text_layer_from_tysh(&build_tysh(&t, 72.0, None).unwrap(), 72.0).unwrap();
    assert!(back.fractional_widths);
    let p = &back.paragraph_runs()[0].style;
    assert_eq!((p.composer, p.hyphenation, p.justification), (Composer::EveryLine, Hyphenation::default(), Justification::default()));
    let e = engine(&t, 72.0);
    let props = e.path(&["EngineDict", "ParagraphRun", "RunArray"]).and_then(|a| a.index(0)).and_then(|r| r.path(&["ParagraphSheet", "Properties"])).unwrap();
    for (key, want) in [("HyphenatedWordSize", 6.0), ("PreHyphen", 2.0), ("PostHyphen", 2.0), ("ConsecutiveHyphens", 8.0), ("Zone", 36.0)] {
        assert_eq!(props.get(key).and_then(E::as_f64), Some(want), "{key}");
    }
    assert_eq!(props.get("EveryLineComposer").and_then(E::as_bool), Some(true));
    // Single-word justification has no known key: the XMP keeps it (photocraft_io::type_xmp).
    let mut single = ParagraphStyle::default();
    single.justification.single_word = SingleWord::Center;
    let e = engine(&layer("A", CharStyle::default(), single), 72.0);
    assert!(!String::from_utf8_lossy(&crate::engine_data::write(&e)).contains("SingleWord"));
}

/// A file whose paragraph sheet says nothing of the composer was laid out line by line
/// (PhotoCraft's own PSDs before the key): it opens Single-line. Out-of-range values keep the
/// defaults.
#[test]
fn a_file_without_the_keys_opens_single_line_with_the_defaults() {
    let (run, para) = styled();
    let t = layer("Old", run, para);
    let mut e = build_engine_data(&t, None, 72.0);
    let props = e
        .get_mut("EngineDict")
        .and_then(|d| d.get_mut("ParagraphRun"))
        .and_then(|r| r.get_mut("RunArray"))
        .and_then(|a| match a {
            E::Array(a) => a.first_mut(),
            _ => None,
        })
        .and_then(|r| r.get_mut("ParagraphSheet"))
        .and_then(|s| s.get_mut("Properties"))
        .unwrap();
    let E::Dict(items) = props else { panic!() };
    items.retain(|(k, _)| !matches!(k.as_str(), "EveryLineComposer" | "Hanging" | "Zone"));
    for (k, v) in items.iter_mut() {
        match k.as_str() {
            "HyphenatedWordSize" => *v = E::Int(99),
            "WordSpacing" => *v = E::Array(vec![E::Real(1.2), E::Real(1.0), E::Real(0.8)]),
            _ => {}
        }
    }
    let p = super::super::para_style(&[], props, 1.0);
    assert_eq!((p.composer, p.hanging_punctuation), (Composer::SingleLine, false));
    assert_eq!(p.hyphenation, Hyphenation { after_first: 3, before_last: 4, hyphen_limit: 1, ..Default::default() });
    assert_eq!(p.justification.word, Justification::default().word);
    assert_eq!(p.justification.letter, [-5.0, 0.0, 10.0]);
}

#[test]
fn a_file_s_fractional_widths_value_is_written_back_from_the_layer() {
    let t = layer("Edit", CharStyle { size_pt: 12.0, ..Default::default() }, ParagraphStyle::default());
    let mut from_file = text_layer_from_tysh(&build_tysh(&t, 72.0, None).unwrap(), 72.0).unwrap();
    from_file.psd_raw = Some(Arc::new(build_tysh(&t, 72.0, None).unwrap()));
    assert!(from_file.fractional_widths);
    from_file.fractional_widths = false;
    let e = engine(&from_file, 72.0);
    assert_eq!(e.path(&["EngineDict", "UseFractionalGlyphWidths"]).and_then(E::as_bool), Some(false));
}

/// A `Language` code the table can't name yet imports as no language and survives an edit of
/// the layer on the runs that still have none.
#[test]
fn an_unknown_language_code_survives_an_edit() {
    let t = layer("Hello world", CharStyle { size_pt: 12.0, ..Default::default() }, ParagraphStyle::default());
    let mut e = build_engine_data(&t, None, 72.0);
    let data = e
        .get_mut("EngineDict")
        .and_then(|d| d.get_mut("StyleRun"))
        .and_then(|r| r.get_mut("RunArray"))
        .and_then(|a| match a {
            E::Array(a) => a.first_mut(),
            _ => None,
        })
        .and_then(|r| r.get_mut("StyleSheet"))
        .and_then(|s| s.get_mut("StyleSheetData"))
        .unwrap();
    data.set("Language", E::Int(4242));
    let read = super::super::char_style(&[], data, &[], 1.0);
    assert_eq!(read.language, None);
    // Re-written from that template with one character added: the code is kept.
    let mut edited = t.clone();
    edited.text.push('!');
    edited.runs[0].len += 1;
    edited.paragraphs[0].len += 1;
    let out = build_engine_data(&edited, Some(e.clone()), 72.0);
    let lang = out.path(&["EngineDict", "StyleRun", "RunArray"]).and_then(|a| a.index(0)).and_then(|r| r.path(&["StyleSheet", "StyleSheetData", "Language"]));
    assert_eq!(lang.and_then(E::as_i64), Some(4242));
    // A run given a language in Pigment doesn't take the file's code for another one.
    edited.runs[0].style.language = Some("de".into());
    let out = build_engine_data(&edited, Some(e), 72.0);
    let lang = out.path(&["EngineDict", "StyleRun", "RunArray"]).and_then(|a| a.index(0)).and_then(|r| r.path(&["StyleSheet", "StyleSheetData", "Language"]));
    assert_eq!(lang, None);
}
