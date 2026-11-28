//! Pigment (PORTS-B B1): Reset Character and Reset Paragraph.

use photocraft_doc::text::{Composer, FontBaseline, ListKind, ListStyle, TextAlign};
use photocraft_doc::{LayerContent, LayerId, TextLayer};

use super::*;

fn session() -> Session {
    let mut s = Session::new();
    s.execute("file.new", json!({"width": 300, "height": 160, "depth": 8, "background": "white"})).unwrap();
    s
}

fn text(s: &Session, id: LayerId) -> &TextLayer {
    match &s.active().unwrap().doc.layer(id).unwrap().content {
        LayerContent::Text(t) => t,
        c => panic!("not text: {}", c.kind_name()),
    }
}

fn label(s: &Session) -> String {
    s.active().unwrap().history.undo_label().unwrap_or_default().to_string()
}

#[test]
fn reset_character_puts_every_attribute_back_font_size_and_colour_too() {
    let mut s = session();
    let r = s.execute("type.create", json!({"x": 20, "y": 70, "text": "Styled text", "size": 30, "color": "#ff0000", "fauxBold": true, "tracking": 50, "baseline": "superscript", "noBreak": true})).unwrap();
    let id = LayerId(r["layer"].as_u64().unwrap());
    let styled = text(&s, id).char_runs()[0].style.clone();
    assert!(styled.faux_bold && styled.baseline == FontBaseline::Superscript && styled.tracking == 50.0 && styled.no_break);
    // A range: only it changes.
    s.execute("type.resetCharacter", json!({"layer": id.0, "range": [0, 6]})).unwrap();
    assert_eq!(label(&s), "Reset Character");
    let runs = text(&s, id).char_runs();
    assert_eq!(runs.iter().map(|r| r.len).collect::<Vec<_>>(), [6, 5]);
    assert_eq!(runs[0].style, CharStyle::default());
    assert_eq!(runs[1].style, styled);
    assert!(s.undo());
    assert_eq!(text(&s, id).char_runs()[0].style, styled);
    // The whole layer.
    s.execute("type.resetCharacter", json!({})).unwrap();
    assert!(text(&s, id).char_runs().iter().all(|r| r.style == CharStyle::default()));
}

#[test]
fn reset_paragraph_resets_only_the_targeted_paragraphs() {
    let mut s = session();
    let r = s.execute("type.create", json!({"box": [10, 10, 200, 120], "text": "First\nSecond", "align": "justifyAll", "startIndent": 12, "hyphenate": true, "composer": "singleLine", "list": {"type": "number"}})).unwrap();
    let id = LayerId(r["layer"].as_u64().unwrap());
    let styled = text(&s, id).paragraph_runs()[0].style.clone();
    assert_eq!((styled.align, styled.start_indent_pt, styled.hyphenate, styled.composer), (TextAlign::JustifyAll, 12.0, true, Composer::SingleLine));
    assert_eq!(styled.list, Some(ListStyle::new(ListKind::Number)));
    s.execute("type.resetParagraph", json!({"layer": id.0, "range": [7, 8]})).unwrap();
    assert_eq!(label(&s), "Reset Paragraph");
    let paras = text(&s, id).paragraph_runs();
    assert_eq!(paras.len(), 2);
    assert_eq!(paras[0].style, styled);
    assert_eq!(paras[1].style, ParagraphStyle::default());
    assert!(s.undo());
    assert!(text(&s, id).paragraph_runs().iter().all(|p| p.style == styled));
}

#[test]
fn an_applied_style_stays_and_its_overrides_go() {
    let mut s = session();
    let r = s.execute("type.create", json!({"x": 20, "y": 70, "text": "Headline", "size": 30})).unwrap();
    let id = LayerId(r["layer"].as_u64().unwrap());
    let made = s.execute("type.characterStyle.new", json!({"name": "Red", "fromSelection": false, "attrs": {"color": "#ff0000", "size": 40}})).unwrap();
    let style = made["id"].as_u64().unwrap() as u32;
    s.execute("type.characterStyle.apply", json!({"id": style, "layer": id.0})).unwrap();
    s.execute("type.setStyle", json!({"layer": id.0, "fauxItalic": true})).unwrap();
    s.execute("type.resetCharacter", json!({"layer": id.0})).unwrap();
    let st = &text(&s, id).char_runs()[0].style;
    assert_eq!(st.style_sheet, Some(style));
    assert!(!st.faux_italic);
    assert_eq!(st.size_pt, 40.0);
    assert_eq!(st.color.to_rgb(), [1.0, 0.0, 0.0]);
}
