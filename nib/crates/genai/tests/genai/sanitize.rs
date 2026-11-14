//! The SVG sanitizer against hostile and sloppy model answers.

use nib_genai::ErrorKind;
use nib_genai::sanitize::{MAX_DEPTH, MAX_ELEMENTS, extract_svg, sanitize_svg};

fn clean(svg: &str) -> String {
    sanitize_svg(svg).unwrap_or_else(|e| panic!("{e}: {svg}"))
}

#[test]
fn keeps_drawing() {
    let out = clean(crate::common::SVG);
    assert!(out.starts_with("<svg xmlns=\"http://www.w3.org/2000/svg\""), "{out}");
    assert!(out.contains("<rect x=\"0\" y=\"0\" width=\"100\" height=\"50\" fill=\"#204060\">"), "{out}");
    assert!(out.contains("<circle cx=\"50\" cy=\"25\" r=\"20\" fill=\"#e0a030\">"), "{out}");
    assert!(out.contains("viewBox=\"0 0 100 50\""), "{out}");
}

#[test]
fn finds_the_svg_in_prose_and_fences() {
    let answer = format!("Here you go:\n```svg\n{}\n```\nEnjoy!", crate::common::SVG);
    assert_eq!(extract_svg(&answer), Some(crate::common::SVG));
    assert!(sanitize_svg(&answer).is_ok());
    assert_eq!(sanitize_svg("Sorry, I can't draw that.").unwrap_err().kind, ErrorKind::BadResponse);
}

#[test]
fn drops_scripts_handlers_and_foreign_content() {
    let svg = r#"<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)" viewBox="0 0 10 10">
        <script>alert(1)</script>
        <script xlink:href="https://evil.example/x.js" xmlns:xlink="http://www.w3.org/1999/xlink"/>
        <foreignObject width="10" height="10"><iframe xmlns="http://www.w3.org/1999/xhtml" src="https://evil.example"/></foreignObject>
        <rect width="10" height="10" fill="red" onclick="steal()" onmouseover="x()"/>
        <style>rect { fill: url(https://evil.example/track) }</style>
        <animate attributeName="fill" to="blue"/>
        <set attributeName="href" to="javascript:alert(1)"/>
        <image href="https://evil.example/pixel.png" width="1" height="1"/>
        <image href="data:image/png;base64,AAAA" width="1" height="1"/>
        <a href="javascript:alert(1)"><circle r="3" cx="5" cy="5" fill="blue"/></a>
    </svg>"#;
    let out = clean(svg);
    for bad in
        ["script", "onload", "onclick", "onmouseover", "foreignObject", "iframe", "style", "animate", "<set", "<image", "javascript", "evil", "<a"]
    {
        assert!(!out.contains(bad), "{bad} survived: {out}");
    }
    // The link's art stays.
    assert!(out.contains("<circle r=\"3\" cx=\"5\" cy=\"5\" fill=\"blue\">"), "{out}");
}

#[test]
fn only_local_references_survive() {
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">
        <defs><linearGradient id="g"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient>
        <path id="p" d="M0 0L5 5Z"/></defs>
        <rect width="10" height="10" fill="url(#g)"/>
        <rect width="10" height="10" fill="url(https://evil.example/a.svg#g)"/>
        <rect width="10" height="10" style="fill: url('http://evil.example/'); stroke: #123456; behavior: url(x.htc)"/>
        <use href="#p"/>
        <use xlink:href="https://evil.example/sprite.svg#icon"/>
        <use href="other.svg#p"/>
    </svg>"##;
    let out = clean(svg);
    assert!(out.contains("fill=\"url(#g)\""), "{out}");
    assert!(!out.contains("evil"), "{out}");
    assert!(!out.contains("behavior") && !out.contains(".htc"), "{out}");
    assert!(out.contains("stroke=\"#123456\""), "the style's safe property becomes an attribute: {out}");
    assert_eq!(out.matches("href=").count(), 1, "{out}");
    assert!(out.contains("<use href=\"#p\">"), "{out}");
}

#[test]
fn refuses_dtds_and_entities() {
    let svg = r#"<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><svg xmlns="http://www.w3.org/2000/svg"><text>&lol2;</text></svg>"#;
    assert_eq!(sanitize_svg(svg).unwrap_err().kind, ErrorKind::BadResponse);
    let ext = r#"<!DOCTYPE svg SYSTEM "file:///etc/passwd"><svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>"#;
    assert!(sanitize_svg(ext).is_err());
}

#[test]
fn refuses_impossible_sizes() {
    for root in [
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="1e300" height="10"><rect width="1" height="1"/></svg>"#,
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 -5 10"><rect width="1" height="1"/></svg>"#,
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 NaN 10"><rect width="1" height="1"/></svg>"#,
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10"><rect width="1" height="1"/></svg>"#,
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="900000"><rect width="1" height="1"/></svg>"#,
    ] {
        assert!(sanitize_svg(root).is_err(), "{root}");
    }
    // Percentages are left to the importer.
    assert!(sanitize_svg(r#"<svg xmlns="http://www.w3.org/2000/svg" width="100%"><rect width="1" height="1"/></svg>"#).is_ok());
}

#[test]
fn bounds_nesting_and_element_count() {
    let deep = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\">{}<rect width=\"1\" height=\"1\"/>{}</svg>",
        "<g>".repeat(MAX_DEPTH + 5),
        "</g>".repeat(MAX_DEPTH + 5)
    );
    assert!(sanitize_svg(&deep).unwrap_err().message.contains("nested"));
    let many = format!("<svg xmlns=\"http://www.w3.org/2000/svg\">{}</svg>", "<rect width=\"1\" height=\"1\"/>".repeat(MAX_ELEMENTS + 1));
    assert!(sanitize_svg(&many).is_err());
    let huge = format!("<svg xmlns=\"http://www.w3.org/2000/svg\"><path d=\"{}\"/></svg>", "M0 0 ".repeat(500_000));
    assert!(sanitize_svg(&huge).is_err(), "over the size cap");
}

#[test]
fn refuses_what_is_not_svg_or_draws_nothing() {
    assert!(sanitize_svg("<svg xmlns=\"http://www.w3.org/2000/svg\"><g/></svg>").unwrap_err().message.contains("nothing to draw"));
    assert!(sanitize_svg("<svg><rect width=\"1\"></svg>").is_err(), "not well-formed");
    assert!(
        sanitize_svg("<html><svg xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"1\" height=\"1\"/></svg></html>").is_ok(),
        "the svg inside is taken"
    );
    // Elements of another namespace are dropped.
    let out =
        clean("<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:x=\"urn:x\"><x:rect width=\"1\" height=\"1\"/><rect width=\"2\" height=\"2\"/></svg>");
    assert_eq!(out.matches("<rect").count(), 1, "{out}");
}

#[test]
fn escapes_text_and_attribute_values() {
    let out =
        clean("<svg xmlns=\"http://www.w3.org/2000/svg\"><text x=\"1\" y=\"2\" font-family=\"A &amp; B\">1 &lt; 2 &amp; &quot;q&quot;</text></svg>");
    assert!(out.contains("font-family=\"A &amp; B\""), "{out}");
    assert!(out.contains(">1 &lt; 2 &amp; &quot;q&quot;</text>"), "{out}");
    // A control character in a value drops the attribute.
    let out = clean("<svg xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"1\" height=\"1\" fill=\"red&#127;\"/></svg>");
    assert!(!out.contains("fill="), "{out}");
}

#[test]
fn every_sanitized_svg_imports() {
    let mut s = crate::common::session();
    let out = clean(crate::common::SVG);
    let r = crate::common::exec(&mut s, "clipboard.importSvg", serde_json::json!({ "svg": out }));
    assert!(r["count"].as_u64().unwrap() >= 1, "{r}");
}
