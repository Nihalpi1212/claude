//! Pigment (PORTS-B B1): the Character and Paragraph panel menu commands and the new
//! `type.setStyle` / `type.edit` keys.

use photocraft_doc::LayerId;
use photocraft_doc::text::{Caps, Composer, FontBaseline, Hyphenation, Justification, ListKind, ListStyle, SingleWord};

use super::*;

fn session() -> Session {
    let mut s = Session::new();
    s.execute("file.new", json!({"width": 300, "height": 160, "depth": 8, "background": "white"})).unwrap();
    s
}

fn text_layer(s: &mut Session, text: &str) -> LayerId {
    let r = s.execute("type.create", json!({"x": 20, "y": 70, "text": text, "size": 24})).unwrap();
    LayerId(r["layer"].as_u64().unwrap())
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
fn each_character_toggle_is_one_labelled_step_and_toggles_back() {
    let mut s = session();
    let id = text_layer(&mut s, "Hello world");
    for (cmd, name, on) in [
        ("type.character.fauxBold", "Faux Bold", (|c: &CharStyle| c.faux_bold) as fn(&CharStyle) -> bool),
        ("type.character.fauxItalic", "Faux Italic", |c| c.faux_italic),
        ("type.character.allCaps", "All Caps", |c| c.caps == Caps::AllCaps),
        ("type.character.smallCaps", "Small Caps", |c| c.caps == Caps::SmallCaps),
        ("type.character.superscript", "Superscript", |c| c.baseline == FontBaseline::Superscript),
        ("type.character.subscript", "Subscript", |c| c.baseline == FontBaseline::Subscript),
        ("type.character.underline", "Underline", |c| c.underline),
        ("type.character.strikethrough", "Strikethrough", |c| c.strikethrough),
        ("type.noBreak", "No Break", |c| c.no_break),
    ] {
        assert_eq!(s.execute(cmd, json!({})).unwrap()["on"], json!(true), "{cmd}");
        assert!(text(&s, id).char_runs().iter().all(|r| on(&r.style)), "{cmd}");
        assert_eq!(label(&s), name);
        s.execute(cmd, json!({})).unwrap();
        assert!(text(&s, id).char_runs().iter().all(|r| !on(&r.style)), "{cmd} off");
        assert!(s.undo());
        assert!(text(&s, id).char_runs().iter().all(|r| on(&r.style)), "{cmd} undo");
        assert!(s.undo());
    }
}

#[test]
fn a_range_toggle_follows_where_it_starts_and_pairs_share_a_field() {
    let mut s = session();
    let id = text_layer(&mut s, "H2O and x2");
    s.execute("type.character.subscript", json!({"layer": id.0, "range": [1, 2]})).unwrap();
    let runs = text(&s, id).char_runs();
    assert_eq!(
        runs.iter().map(|r| (r.len, r.style.baseline)).collect::<Vec<_>>(),
        [(1, FontBaseline::Normal), (1, FontBaseline::Subscript), (8, FontBaseline::Normal)]
    );
    // Superscript on the same character replaces subscript (one field, as Photoshop's buttons).
    s.execute("type.character.superscript", json!({"layer": id.0, "range": [1, 2]})).unwrap();
    assert_eq!(text(&s, id).char_runs()[1].style.baseline, FontBaseline::Superscript);
    // Turning subscript off leaves the superscript.
    s.execute("type.character.subscript", json!({"layer": id.0, "range": [1, 2], "on": false})).unwrap();
    assert_eq!(text(&s, id).char_runs()[1].style.baseline, FontBaseline::Superscript);
    // An explicit `on` must be a boolean.
    assert!(s.execute("type.character.superscript", json!({"on": "yes"})).is_err());
}

#[test]
fn fractional_widths_and_system_layout_are_layer_flags() {
    let mut s = session();
    let a = text_layer(&mut s, "One");
    let b = text_layer(&mut s, "Two");
    s.execute("type.fractionalWidths", json!({"layers": [a.0, b.0]})).unwrap();
    assert!(!text(&s, a).fractional_widths && !text(&s, b).fractional_widths);
    assert_eq!(label(&s), "Fractional Widths");
    assert!(s.undo());
    assert!(text(&s, a).fractional_widths && text(&s, b).fractional_widths);
    s.execute("type.systemLayout", json!({"layer": a.0, "on": true})).unwrap();
    assert!(text(&s, a).system_layout && !text(&s, b).system_layout);
    assert_eq!(label(&s), "System Layout");
    // type.edit takes the same flags, and type.info reports them.
    s.execute("type.edit", json!({"layer": b.0, "fractionalWidths": false, "systemLayout": true})).unwrap();
    let info = s.execute("type.info", json!({"layer": b.0})).unwrap();
    assert_eq!((info["fractionalWidths"].clone(), info["systemLayout"].clone()), (json!(false), json!(true)));
    assert!(s.execute("type.edit", json!({"layer": b.0, "systemLayout": 1})).is_err());
}

#[test]
fn set_style_takes_the_paragraph_settings_and_merges_partial_objects() {
    let mut s = session();
    let id = text_layer(&mut s, "Hello");
    s.execute("type.setStyle", json!({"layer": id.0, "hyphenation": {"afterFirst": 3, "zone": 18}, "justification": {"wordSpacing": [70, 90, 120], "singleWord": "center"}, "composer": "singleLine", "hangingPunctuation": true, "noBreak": true}))
        .unwrap();
    let t = text(&s, id);
    let p = &t.paragraph_runs()[0].style;
    assert_eq!(p.hyphenation, Hyphenation { after_first: 3, zone_pt: 18.0, ..Default::default() });
    assert_eq!(p.justification, Justification { word: [70.0, 90.0, 120.0], single_word: SingleWord::Center, ..Default::default() });
    assert_eq!((p.composer, p.hanging_punctuation), (Composer::SingleLine, true));
    assert!(t.char_runs()[0].style.no_break);
    // A second partial object keeps what the first set.
    s.execute("type.setStyle", json!({"layer": id.0, "hyphenation": {"hyphenLimit": 1}})).unwrap();
    let h = text(&s, id).paragraph_runs()[0].style.hyphenation;
    assert_eq!((h.after_first, h.hyphen_limit, h.zone_pt), (3, 1, 18.0));
    s.execute("type.setStyle", json!({"layer": id.0, "list": {"type": "number", "marker": "upperRoman", "start": 4}})).unwrap();
    assert_eq!(text(&s, id).paragraph_runs()[0].style.list, Some(ListStyle { kind: ListKind::Number, marker: "upperRoman".into(), start: 4, level: 0 }));
    s.execute("type.setStyle", json!({"layer": id.0, "list": null})).unwrap();
    assert_eq!(text(&s, id).paragraph_runs()[0].style.list, None);
}

#[test]
fn out_of_range_paragraph_settings_are_errors_and_change_nothing() {
    let mut s = session();
    let id = text_layer(&mut s, "Hello");
    let before = text(&s, id).clone();
    for bad in [
        json!({"hyphenation": {"wordsLongerThan": 1}}),
        json!({"hyphenation": {"afterFirst": 16}}),
        json!({"hyphenation": {"hyphenLimit": 2.5}}),
        json!({"hyphenation": {"zone": -1}}),
        json!({"hyphenation": {"capitalized": "yes"}}),
        json!({"hyphenation": 3}),
        json!({"justification": {"wordSpacing": [90, 80, 100]}}),
        json!({"justification": {"letterSpacing": [-101, 0, 0]}}),
        json!({"justification": {"glyphScaling": [100, 100]}}),
        json!({"justification": {"singleWord": "full"}}),
        json!({"composer": "every"}),
        json!({"hangingPunctuation": 1}),
        json!({"noBreak": "on"}),
        json!({"list": {"type": "roman"}}),
        json!({"list": {"type": "number", "marker": "bogus"}}),
        json!({"list": {"type": "bullet", "marker": "abc"}}),
        json!({"list": {"start": 10000}}),
        json!({"list": {"level": 9}}),
        json!({"list": 5}),
    ] {
        let mut p = bad.clone();
        p["layer"] = json!(id.0);
        assert!(s.execute("type.setStyle", p).is_err(), "{bad}");
        assert_eq!(text(&s, id), &before, "{bad}");
    }
    assert!(s.execute("type.create", json!({"x": 1, "y": 1, "text": "x", "composer": "fast"})).is_err());
}

#[test]
fn hanging_punctuation_and_the_composers_act_on_the_targeted_paragraphs() {
    let mut s = session();
    let id = text_layer(&mut s, "One\nTwo\nThree");
    s.execute("type.hangingPunctuation", json!({"layer": id.0, "range": [4, 5]})).unwrap();
    let hang: Vec<bool> = photocraft_io::type_xmp::paragraph_styles(text(&s, id)).iter().map(|(_, p)| p.hanging_punctuation).collect();
    assert_eq!(hang, [false, true, false]);
    assert_eq!(label(&s), "Roman Hanging Punctuation");
    // Toggling from the second paragraph turns it off again.
    assert_eq!(s.execute("type.hangingPunctuation", json!({"layer": id.0, "range": [4, 5]})).unwrap()["on"], json!(false));
    s.execute("type.composer.singleLine", json!({"layer": id.0, "range": [0, 1]})).unwrap();
    let c: Vec<Composer> = photocraft_io::type_xmp::paragraph_styles(text(&s, id)).iter().map(|(_, p)| p.composer).collect();
    assert_eq!(c, [Composer::SingleLine, Composer::EveryLine, Composer::EveryLine]);
    assert_eq!(label(&s), "Composer");
    s.execute("type.composer.everyLine", json!({})).unwrap();
    assert!(text(&s, id).paragraph_runs().iter().all(|p| p.style.composer == Composer::EveryLine));
}

#[test]
fn type_list_turns_lists_on_with_an_indent_and_off() {
    let mut s = session();
    let id = text_layer(&mut s, "One\nTwo");
    s.execute("type.list", json!({"layer": id.0, "type": "number"})).unwrap();
    assert_eq!(label(&s), "Numbering");
    let paras = text(&s, id).paragraph_runs();
    assert_eq!(paras.len(), 1, "one run for two equal paragraphs");
    let p = &paras[0].style;
    assert_eq!(p.list, Some(ListStyle::new(ListKind::Number)));
    // 1.5 em of the 24 pt type, for level 0.
    assert_eq!(p.start_indent_pt, 36.0);
    // A level 2 bullet on the second paragraph: its indent is kept (it has one now).
    s.execute("type.list", json!({"layer": id.0, "range": [4, 5], "type": "bullet", "level": 2, "marker": "\u{2013}"})).unwrap();
    assert_eq!(label(&s), "Bullets");
    let paras = text(&s, id).paragraph_runs();
    assert_eq!(paras[1].style.list, Some(ListStyle { kind: ListKind::Bullet, marker: "\u{2013}".into(), start: 1, level: 2 }));
    assert_eq!(paras[1].style.start_indent_pt, 36.0);
    s.execute("type.list", json!({"layer": id.0, "type": "none"})).unwrap();
    assert!(text(&s, id).paragraph_runs().iter().all(|p| p.style.list.is_none()));
    assert!(s.execute("type.list", json!({"type": "roman"})).is_err());
    assert!(s.execute("type.list", json!({"type": "none", "level": 1})).is_err());
    assert!(s.execute("type.list", json!({"type": "bullet", "level": 12})).is_err());
    // Without the indent rule a paragraph keeps no indent.
    let id2 = text_layer(&mut s, "Plain");
    s.execute("type.list", json!({"layer": id2.0, "type": "bullet", "indent": false})).unwrap();
    assert_eq!(text(&s, id2).paragraph_runs()[0].style.start_indent_pt, 0.0);
}

#[test]
fn the_commands_record_into_the_journal() {
    let mut s = session();
    text_layer(&mut s, "Hello");
    for cmd in ["type.noBreak", "type.fractionalWidths", "type.systemLayout", "type.hangingPunctuation", "type.composer.singleLine", "type.character.allCaps"] {
        let spec = crate::commands::command_specs().iter().find(|c| c.id == cmd).unwrap();
        assert!(spec.journal && spec.menu.is_empty() && spec.shortcut.is_none(), "{cmd}");
        assert!(s.is_enabled(cmd), "{cmd}");
    }
}
