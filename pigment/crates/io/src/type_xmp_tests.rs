use photocraft_doc::text::{ListKind, ListStyle, ParagraphRun, ParagraphStyle, SingleWord, TextRun};
use serde_json::json;

use super::*;

const OTHER: &str = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:app="http://example.com/app/1.0/"><app:arc>120</app:arc></rdf:Description></rdf:RDF></x:xmpmeta>"#;

fn three_paragraphs() -> TextLayer {
    let text = "One\nTwo\nThree";
    TextLayer {
        text: text.into(),
        runs: vec![TextRun { len: text.len(), style: Default::default() }],
        paragraphs: vec![ParagraphRun { len: text.len(), style: ParagraphStyle::default() }],
        ..Default::default()
    }
}

fn extras() -> TextLayer {
    let mut t = three_paragraphs();
    let mut styles = paragraph_styles(&t);
    styles[1].1.list = Some(ListStyle { kind: ListKind::Number, marker: "lowerRoman".into(), start: 4, level: 1 });
    styles[2].1.hyphenation.capitalized = false;
    styles[2].1.justification.single_word = SingleWord::Right;
    set_paragraph_styles(&mut t, styles);
    t.system_layout = true;
    t
}

#[test]
fn only_settings_off_their_defaults_are_written() {
    assert_eq!(write(&three_paragraphs()), None);
    let v = write(&extras()).unwrap();
    assert_eq!(
        v,
        json!({"systemLayout": true, "paragraphs": [
            {"index": 1, "list": {"type": "number", "marker": "lowerRoman", "start": 4, "level": 1}},
            {"index": 2, "capitalized": false, "singleWord": "right"},
        ]})
    );
    let mut back = three_paragraphs();
    apply(&mut back, &v);
    assert_eq!(paragraph_styles(&back), paragraph_styles(&extras()));
    assert!(back.system_layout);
    // An index the layer doesn't have, or a list of no known type, changes nothing.
    let mut t = three_paragraphs();
    apply(&mut t, &json!({"paragraphs": [{"index": 7, "capitalized": false}, {"index": 0, "list": {"type": "roman"}}]}));
    assert_eq!(paragraph_styles(&t), paragraph_styles(&three_paragraphs()));
}

#[test]
fn paragraph_styles_split_and_merge_like_the_engine() {
    let mut t = three_paragraphs();
    t.text.push('\n');
    t.paragraphs = vec![ParagraphRun { len: t.text.len(), style: ParagraphStyle::default() }];
    let styles = paragraph_styles(&t);
    assert_eq!(styles.iter().map(|(r, _)| r.clone()).collect::<Vec<_>>(), [0..4, 4..8, 8..14, 14..14]);
    set_paragraph_styles(&mut t, styles);
    assert_eq!(t.paragraphs.iter().map(|p| p.len).collect::<Vec<_>>(), [14, 0]);
    assert_eq!(t.paragraph_runs().iter().map(|p| p.len).sum::<usize>(), t.text.len());
}

#[test]
fn merge_keeps_every_other_property_and_replaces_its_own() {
    let v = write(&extras()).unwrap();
    let merged = merge_into(Some(OTHER), Some(&v)).unwrap();
    assert!(merged.contains("<app:arc>120</app:arc>"), "{merged}");
    assert_eq!(read(&merged), Some(v.clone()));
    // Merging again replaces the property instead of adding a second one.
    let v2 = json!({"systemLayout": true});
    let again = merge_into(Some(&merged), Some(&v2)).unwrap();
    assert_eq!(again.matches("typeExtra>").count(), 2, "one element: {again}");
    assert_eq!(read(&again), Some(v2));
    // No value: the property goes, the rest stays; a packet without one comes back unchanged.
    let cleared = merge_into(Some(&again), None).unwrap();
    assert!(read(&cleared).is_none() && cleared.contains("<app:arc>120</app:arc>"));
    assert_eq!(merge_into(Some(OTHER), None).as_deref(), Some(OTHER));
    // No packet: one is made only when there is something to keep.
    assert_eq!(merge_into(None, None), None);
    let fresh = merge_into(None, Some(&v)).unwrap();
    assert!(fresh.starts_with("<?xpacket") && read(&fresh) == Some(v));
}

#[test]
fn the_attribute_form_and_another_prefix_are_read_and_replaced() {
    // As an XMP toolkit may write it back: an attribute, under a prefix of its own.
    let packet = format!(
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:pt="{NAMESPACE}" pt:typeExtra="{{&quot;systemLayout&quot;:true}}" xmlns:app="http://example.com/app/1.0/" app:x="1"/></rdf:RDF></x:xmpmeta>"#
    );
    assert_eq!(read(&packet), Some(json!({"systemLayout": true})));
    let replaced = merge_into(Some(&packet), Some(&json!({"paragraphs": []}))).unwrap();
    assert!(!replaced.contains("pt:typeExtra") && replaced.contains(r#"app:x="1""#), "{replaced}");
    assert_eq!(read(&replaced), Some(json!({"paragraphs": []})));
    // A packet with no RDF element is left alone.
    assert_eq!(merge_into(Some("not xmp"), Some(&json!({}))).as_deref(), Some("not xmp"));
}

#[test]
fn only_type_layers_get_the_extras_and_lists_warn() {
    let mut l = Layer::new("Type", LayerContent::Text(extras()));
    l.xmp = Some(std::sync::Arc::from(OTHER));
    let packet = export_packet(&l).unwrap();
    assert!(read(&packet).is_some() && packet.contains("app:arc"));
    let LayerContent::Text(t) = &l.content else { panic!("not text") };
    assert!(export_warning(&l, t).is_some_and(|w| w.contains("list markers")));
    assert!(export_warning(&l, &three_paragraphs()).is_none());
    let mut raster = Layer::raster("Pixels", photocraft_color::PixelFormat::RGBA8);
    raster.xmp = Some(std::sync::Arc::from(OTHER));
    assert_eq!(export_packet(&raster).as_deref(), Some(OTHER));
    // Import applies them to the layer.
    let mut back = Layer::new("Type", LayerContent::Text(three_paragraphs()));
    back.xmp = Some(std::sync::Arc::from(packet.as_ref()));
    import_packet(&mut back);
    let LayerContent::Text(t) = &back.content else { panic!("not text") };
    assert!(t.system_layout);
    assert_eq!(paragraph_styles(t), paragraph_styles(&extras()));
}
