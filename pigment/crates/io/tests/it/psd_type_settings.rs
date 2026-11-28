//! Pigment (PORTS-B B1): a type layer's settings survive a PSD round trip, those with an
//! EngineData key there and the others in the layer's XMP, with a packet the layer already had
//! kept as it was.

use std::sync::Arc;

use photocraft_doc::text::{CharStyle, Composer, Hyphenation, Justification, ListKind, ListStyle, ParagraphRun, ParagraphStyle, SingleWord, TextRun};
use photocraft_doc::{Document, Layer, LayerContent, TextLayer};

const OTHER: &str = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:app="http://example.com/app/1.0/"><app:arc>120</app:arc></rdf:Description></rdf:RDF></x:xmpmeta>"#;

fn layer() -> TextLayer {
    let text = "First paragraph\nSecond";
    let first = ParagraphStyle {
        hyphenate: true,
        hyphenation: Hyphenation { words_longer_than: 8, hyphen_limit: 2, capitalized: false, last_word: false, ..Default::default() },
        justification: Justification { word: [75.0, 100.0, 125.0], single_word: SingleWord::Left, ..Default::default() },
        composer: Composer::SingleLine,
        hanging_punctuation: true,
        ..Default::default()
    };
    let second = ParagraphStyle { list: Some(ListStyle { kind: ListKind::Bullet, marker: "\u{2013}".into(), start: 1, level: 1 }), ..Default::default() };
    let base = CharStyle { font_family: "Inter".into(), size_pt: 24.0, ..Default::default() };
    let mut t = TextLayer {
        text: text.into(),
        runs: vec![TextRun { len: 6, style: CharStyle { no_break: true, ..base.clone() } }, TextRun { len: text.len() - 6, style: base }],
        paragraphs: vec![ParagraphRun { len: 16, style: first }, ParagraphRun { len: text.len() - 16, style: second }],
        fractional_widths: false,
        system_layout: true,
        ..Default::default()
    };
    t.sync_summary();
    t
}

#[test]
fn type_settings_round_trip_through_psd_with_the_layer_packet_kept() {
    let mut doc = Document::new("t", photocraft_geom::Size::new(200, 80), photocraft_color::ColorMode::Rgb, photocraft_color::SampleType::U8);
    let want = layer();
    let mut t = want.clone();
    photocraft_text::TextEngine::new().render_layer(&mut t, doc.resolution_dpi, doc.pixel_format());
    let mut l = Layer::new("Type", LayerContent::Text(t));
    l.xmp = Some(Arc::from(OTHER));
    doc.layers.push(l);
    let out = photocraft_io::export(&doc, "t.psd", &Default::default()).unwrap();
    assert!(out.warnings.iter().any(|w| w.contains("\"Type\"") && w.contains("list markers")), "{:?}", out.warnings);
    let back = photocraft_io::import("t.psd", &out.bytes).unwrap().document;
    let l = &back.layers[0];
    assert!(l.xmp.as_deref().is_some_and(|x| x.contains("<app:arc>120</app:arc>")), "{:?}", l.xmp);
    let LayerContent::Text(b) = &l.content else { panic!("not text") };
    assert_eq!((b.fractional_widths, b.system_layout), (false, true));
    assert_eq!(b.char_runs().iter().map(|r| (r.len, r.style.no_break)).collect::<Vec<_>>(), [(6, true), (16, false)]);
    let (got, want) = (b.paragraph_runs(), want.paragraph_runs());
    assert_eq!(got.len(), 2);
    for (g, w) in got.iter().zip(&want) {
        let (g, w) = (&g.style, &w.style);
        assert_eq!(
            (g.hyphenate, g.hyphenation, g.justification, g.composer, g.hanging_punctuation, &g.list),
            (w.hyphenate, w.hyphenation, w.justification, w.composer, w.hanging_punctuation, &w.list)
        );
    }
}

#[test]
fn a_type_layer_without_extras_saves_no_packet() {
    let mut doc = Document::new("t", photocraft_geom::Size::new(200, 80), photocraft_color::ColorMode::Rgb, photocraft_color::SampleType::U8);
    let mut t =
        TextLayer { text: "Plain".into(), runs: vec![TextRun { len: 5, style: CharStyle { size_pt: 24.0, ..Default::default() } }], ..Default::default() };
    t.sync_summary();
    photocraft_text::TextEngine::new().render_layer(&mut t, doc.resolution_dpi, doc.pixel_format());
    doc.layers.push(Layer::new("Plain", LayerContent::Text(t)));
    let out = photocraft_io::export(&doc, "t.psd", &Default::default()).unwrap();
    assert!(!out.warnings.iter().any(|w| w.contains("list markers")));
    let back = photocraft_io::import("t.psd", &out.bytes).unwrap().document;
    assert_eq!(back.layers[0].xmp, None);
}
