//! Pigment (PORTS-B B1): the type settings' JSON is `type.setStyle`'s, and old documents keep
//! their composer.

use serde_json::json;

use super::*;

#[test]
fn the_settings_serialize_under_the_command_keys() {
    let p = ParagraphStyle { list: Some(ListStyle::new(ListKind::Number)), ..Default::default() };
    let v = serde_json::to_value(&p).unwrap();
    assert_eq!(
        v["hyphenation"],
        json!({"wordsLongerThan": 6, "afterFirst": 2, "beforeLast": 2, "hyphenLimit": 8, "zone": 36.0, "capitalized": true, "lastWord": true, "acrossColumn": true})
    );
    assert_eq!(
        v["justification"],
        json!({"wordSpacing": [80.0, 100.0, 133.0], "letterSpacing": [0.0, 0.0, 0.0], "glyphScaling": [100.0, 100.0, 100.0], "singleWord": "justify"})
    );
    assert_eq!(v["composer"], json!("everyLine"));
    assert_eq!(v["list"], json!({"type": "number", "marker": "decimal", "start": 1, "level": 0}));
    assert_eq!(serde_json::from_value::<ParagraphStyle>(v).unwrap(), p);
    // No list is not written at all.
    assert!(serde_json::to_value(ParagraphStyle::default()).unwrap().get("list").is_none());
}

#[test]
fn a_paragraph_saved_without_a_composer_reads_as_single_line() {
    let p: ParagraphStyle = serde_json::from_value(json!({"align": "Center"})).unwrap();
    assert_eq!((p.composer, p.align), (Composer::SingleLine, TextAlign::Center));
    assert_eq!(ParagraphStyle::default().composer, Composer::EveryLine);
    // A partial settings object keeps the defaults for the rest.
    let p: ParagraphStyle = serde_json::from_value(json!({"hyphenation": {"afterFirst": 3}, "composer": "everyLine"})).unwrap();
    assert_eq!(p.hyphenation, Hyphenation { after_first: 3, ..Default::default() });
    assert_eq!(p.composer, Composer::EveryLine);
}

#[test]
fn defaults_are_photoshops() {
    let j = Justification::default();
    assert_eq!((j.word, j.letter, j.glyph, j.single_word), ([80.0, 100.0, 133.0], [0.0; 3], [100.0; 3], SingleWord::Justify));
    let h = Hyphenation::default();
    assert_eq!((h.words_longer_than, h.after_first, h.before_last, h.hyphen_limit, h.zone_pt), (6, 2, 2, 8, 36.0));
    let c = CharStyle::default();
    assert!(!c.no_break);
    let t = crate::TextLayer::default();
    assert!(t.fractional_widths && !t.system_layout);
    assert_eq!(ListStyle::new(ListKind::Bullet).marker, "\u{2022}");
}
