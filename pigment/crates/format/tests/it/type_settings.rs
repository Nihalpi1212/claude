//! Pigment (PORTS-B B1): the type settings Pigment adds to the model survive a save, and a file
//! saved before they existed opens with what it had: Fractional Widths on, System Layout off and
//! the Single-line Composer (the breaks it was laid out with).

use photocraft_color::{ColorMode, SampleType};
use photocraft_doc::text::{Composer, Hyphenation, Justification, ListKind, ListStyle, ParagraphRun, ParagraphStyle, SingleWord, TextRun};
use photocraft_doc::{Document, Layer, LayerContent, TextLayer};
use photocraft_format::manifest::ContentM;
use photocraft_format::*;

fn document() -> Document {
    let mut doc = Document::new("Type", photocraft_doc::Size::new(200, 100), ColorMode::Rgb, SampleType::U8);
    let mut run = photocraft_doc::text::CharStyle::default();
    run.no_break = true;
    let para = ParagraphStyle {
        hyphenate: true,
        hyphenation: Hyphenation { words_longer_than: 9, after_first: 3, before_last: 4, hyphen_limit: 1, zone_pt: 18.0, capitalized: false, last_word: false, across_column: false },
        justification: Justification { word: [70.0, 90.0, 120.0], letter: [-5.0, 0.0, 10.0], glyph: [95.0, 100.0, 105.0], single_word: SingleWord::Center },
        composer: Composer::SingleLine,
        hanging_punctuation: true,
        list: Some(ListStyle { kind: ListKind::Number, marker: "lowerRoman".into(), start: 4, level: 2 }),
        ..Default::default()
    };
    let t = TextLayer {
        text: "Hello".into(),
        runs: vec![TextRun { len: 5, style: run }],
        paragraphs: vec![ParagraphRun { len: 5, style: para }],
        fractional_widths: false,
        system_layout: true,
        ..Default::default()
    };
    doc.layers.push(Layer::new("Hello", LayerContent::Text(t)));
    doc
}

#[test]
fn the_type_settings_round_trip_through_pcraft() {
    let doc = document();
    let bytes = save_to_bytes(&doc, &SaveOptions::default()).unwrap();
    assert_eq!(load_from_bytes(&bytes).unwrap(), doc);
}

#[test]
fn a_type_layer_saved_before_the_settings_opens_as_it_was() {
    let bytes = save_to_bytes(&document(), &SaveOptions::default()).unwrap();
    let mut content = serde_json::to_value(read_manifest(&bytes).unwrap()).unwrap()["document"]["layers"][0]["content"].clone();
    let o = content.as_object_mut().unwrap();
    o.remove("fractional_widths");
    o.remove("system_layout");
    for key in ["hyphenation", "justification", "composer", "hanging_punctuation", "list"] {
        o["paragraphs"][0]["style"].as_object_mut().unwrap().remove(key);
    }
    o["runs"][0]["style"].as_object_mut().unwrap().remove("no_break");
    let ContentM::Text { fractional_widths, system_layout, paragraphs, runs, .. } = serde_json::from_value(content).unwrap() else { panic!("a type layer") };
    assert!(fractional_widths && !system_layout);
    let p = &paragraphs[0].style;
    assert_eq!((p.composer, p.hyphenation, p.justification, p.hanging_punctuation, &p.list), (Composer::SingleLine, Hyphenation::default(), Justification::default(), false, &None));
    assert!(!runs[0].style.no_break);
    // A new paragraph gets Photoshop's Every-line Composer.
    assert_eq!(ParagraphStyle::default().composer, Composer::EveryLine);
}
