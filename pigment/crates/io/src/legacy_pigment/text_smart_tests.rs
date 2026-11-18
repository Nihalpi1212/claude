//! Type layers and smart objects (with their smart filters), against documents the JavaScript
//! Pigment's own writer wrote (`tests/fixtures/pigment-0.4/`, made by `make-fixtures-l3.mjs`).
//! The smart objects' pictures are compared with the app's in `layer_kinds_tests.rs`, the
//! filtered one in the engine (`legacy_pigment_render.rs`), which draws smart filters.

use std::sync::Arc;

use photocraft_doc::effects::{Effect, StrokePosition};
use photocraft_doc::import_conversion::{ConversionDisposition, ImportConversion};
use photocraft_doc::text::{AntiAlias, Caps, FontBaseline, Kerning, Orientation, TextAlign, TextShape};
use photocraft_doc::{Layer, LayerContent, SmartObject, SmartSource, TextLayer};

use crate::ImportResult;

fn open(name: &str) -> ImportResult {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/fixtures/pigment-0.4/{name}.pigment"));
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    crate::import(&format!("{name}.pigment"), &bytes).unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn layer<'a>(layers: &'a [Layer], name: &str) -> &'a Layer {
    layers.iter().find(|l| l.name == name).unwrap_or_else(|| panic!("no layer \"{name}\""))
}

fn text<'a>(r: &'a ImportResult, name: &str) -> &'a TextLayer {
    match &layer(&r.document.layers, name).content {
        LayerContent::Text(t) => t,
        other => panic!("{name}: {}", other.kind_name()),
    }
}

fn smart<'a>(r: &'a ImportResult, name: &str) -> &'a SmartObject {
    match &layer(&r.document.layers, name).content {
        LayerContent::Smart(s) => s,
        other => panic!("{name}: {}", other.kind_name()),
    }
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-3
}

#[test]
fn point_type_of_0_3_and_0_4_keeps_its_font_and_place() {
    for v in ["v2", "v3"] {
        let r = open(&format!("{v}-text-point"));
        let t = text(&r, "Point");
        assert_eq!(t.text, "Hello", "{v}");
        let runs = t.char_runs();
        assert_eq!(runs.len(), 1, "{v}");
        let s = &runs[0].style;
        // 16 px at 144 ppi is 8 pt; letter spacing 2 px is 2 / 16 em.
        assert_eq!((s.font_family.as_str(), s.weight, s.italic, s.underline, s.size_pt, s.tracking), ("Arial", 700, true, true, 8.0, 125.0), "{v}");
        assert_eq!(s.color.c[..3], [0xc0 as f32 / 255.0, 0x30 as f32 / 255.0, 0x20 as f32 / 255.0], "{v}");
        assert_eq!((t.paragraph_runs()[0].style.auto_leading, t.shape.clone()), (1.5, TextShape::Point), "{v}");
        // The first baseline 0.8 × the size below `y`.
        let [a, b, c, d, e, f] = t.transform.m;
        assert!((a, b, c, d) == (1.0, 0.0, 0.0, 1.0) && close(e, 4.0) && close(f, 6.0 + 12.8), "{v}: {:?}", t.transform);
        // The stroke drawn under the glyphs: its outer half, as a Stroke effect.
        let l = layer(&r.document.layers, "Point");
        match l.effects.items.as_slice() {
            [Effect::Stroke(s)] => assert_eq!((s.size, s.position), (0.5, StrokePosition::Outside), "{v}"),
            other => panic!("{v}: {other:?}"),
        }
        // Drawn by PhotoCraft's type engine, so the layer shows at once.
        assert!(t.cache.is_some(), "{v}");
    }
}

#[test]
fn paragraph_and_turned_type() {
    for v in ["v2", "v3"] {
        let r = open(&format!("{v}-text-box"));
        let t = text(&r, "Box");
        assert_eq!(t.text, "One two three four\nFive", "{v}");
        let TextShape::Box { x, y, width, height } = t.shape else { panic!("{v}: {:?}", t.shape) };
        assert_eq!((x, y, width), (0.0, 0.0, 60.0), "{v}");
        // 0.4 kept the box's height; 0.3's grew with the text, so it is the text's.
        if v == "v3" {
            assert_eq!(height, 36.0);
        } else {
            assert!(height > 10.0 && height < 60.0, "{height}");
        }
        let paras = t.paragraph_runs();
        assert_eq!(paras.len(), 2, "{v}");
        assert!(paras.iter().all(|p| p.style.align == TextAlign::Center), "{v}");
        assert!(close(t.transform.m[4], 10.0), "{v}: {:?}", t.transform);
        // The first baseline where the app put it: 0.8 × 10 px below the box's top.
        let layout = photocraft_text::shared().lock().unwrap().layout(t, r.document.resolution_dpi);
        let baseline = t.transform.m[5] + f64::from(layout.lines[0].baseline);
        assert!(close(baseline, 4.0 + 8.0), "{v}: {baseline}");

        // Point type turned and scaled by its matrix, right-aligned: the app's right edge is
        // PhotoCraft's anchor.
        let turned = text(&r, "Turned");
        assert_eq!(turned.paragraph_runs()[0].style.align, TextAlign::Right, "{v}");
        let [a, b, ..] = turned.transform.m;
        assert!(close(a, 1.5 * (std::f64::consts::PI / 6.0).cos()) && close(b, 1.5 * 0.5), "{v}: {:?}", turned.transform);
    }
}

#[test]
fn mixed_runs_keep_their_characters_and_paragraphs() {
    let r = open("v3-text-runs");
    let t = text(&r, "Runs");
    assert_eq!(t.text, "Mixed runs here\nSecond line");
    let runs = t.char_runs();
    let lens: Vec<usize> = runs.iter().map(|r| r.len).collect();
    assert_eq!(lens, [5, 1, 4, 1, 4, 1, 6, 5]);
    let s = &runs[0].style;
    assert_eq!((s.font_family.as_str(), s.postscript_name.as_deref(), s.weight, s.size_pt, s.tracking), ("Georgia", Some("Georgia-Bold"), 700, 10.0, 50.0));
    let s = &runs[2].style;
    assert_eq!((s.baseline_shift_pt, s.faux_bold, s.kern, s.kerning, s.horizontal_scale, s.vertical_scale), (1.5, true, -20.0, Kerning::Optical, 1.2, 0.9));
    assert_eq!(s.color.c[..3], [0.0, 0.0, 1.0]);
    let s = &runs[4].style;
    assert!(s.italic && s.underline && s.strikethrough && !s.ligatures);
    assert_eq!((s.caps, s.baseline, s.language.as_deref(), s.leading_pt), (Caps::AllCaps, FontBaseline::Superscript, Some("de-DE"), Some(15.0)));
    assert_eq!(s.features.iter().map(|f| (f.tag.as_str(), f.value)).collect::<Vec<_>>(), [("ss01", 1)]);
    let s = &runs[6].style;
    assert_eq!((s.caps, s.faux_italic, s.size_pt), (Caps::SmallCaps, true, 24.0));
    let paras = t.paragraph_runs();
    assert_eq!(paras.iter().map(|p| p.len).collect::<Vec<_>>(), [16, 11]);
    let p = &paras[0].style;
    assert_eq!(
        (p.align, p.start_indent_pt, p.end_indent_pt, p.first_line_indent_pt, p.space_before_pt, p.space_after_pt, p.hyphenate),
        (TextAlign::JustifyLeft, 2.0, 1.0, 3.0, 1.5, 2.5, true)
    );
    assert_eq!((paras[1].style.align, paras[1].style.auto_leading), (TextAlign::Right, 1.4));
    assert_eq!(t.antialias, AntiAlias::Crisp);
    // What PhotoCraft's type does not have is named, once.
    let w = r.warnings.join("\n");
    for what in [
        "No Break",
        "bulleted and numbered lists",
        "Roman Hanging Punctuation",
        "Justification word, letter and glyph spacing",
        "stroke differed between characters",
    ] {
        assert!(w.contains(what), "{what}: {w}");
    }
}

#[test]
fn vertical_type_and_type_on_a_path() {
    let r = open("v3-text-vertical");
    let stacked = text(&r, "Stacked");
    assert_eq!(stacked.orientation, Orientation::Vertical);
    // Two columns 12 px apart: the first column's centre 12 + 6 right of `x`.
    assert!(close(stacked.transform.m[4], 70.0 + 18.0) && close(stacked.transform.m[5], 4.0), "{:?}", stacked.transform);
    // 0.4's "vertical" was horizontal type turned a quarter, and stays so.
    let turned = text(&r, "Turned vertical");
    assert_eq!(turned.orientation, Orientation::Horizontal);
    assert!(close(turned.transform.m[0], 0.0) && close(turned.transform.m[1], 1.0), "{:?}", turned.transform);

    let r = open("v3-text-path");
    let on = text(&r, "On path");
    let TextShape::Path { path, start, end: None, flip: false } = &on.shape else { panic!("{:?}", on.shape) };
    assert_eq!((path.knots.len(), path.knots[0].anchor.x, path.knots[1].anchor.x), (2, 6.0, 90.0));
    let length = photocraft_text::warp::PathGeometry::new(path, false).unwrap().length();
    assert!(length > 84.0 && close(f64::from(*start), 0.2 * length), "{start} of {length}");
    let flipped = text(&r, "On path flipped");
    assert!(matches!(&flipped.shape, TextShape::Path { flip: true, .. }));
    assert_eq!(flipped.paragraph_runs()[0].style.align, TextAlign::Center);
}

#[test]
fn smart_object_instances_share_one_source() {
    for v in ["v2", "v3"] {
        let r = open(&format!("{v}-smart-instances"));
        assert_eq!(r.warnings, Vec::<String>::new(), "{v}");
        let (first, second) = (smart(&r, "First"), smart(&r, "Second"));
        assert_eq!(first.contents_id, second.contents_id, "{v}");
        let (SmartSource::Embedded { file_name, bytes }, SmartSource::Embedded { bytes: other, .. }) = (&first.source, &second.source) else { panic!() };
        assert!(Arc::ptr_eq(bytes, other), "{v}");
        assert_eq!(file_name, "Contents.pcraft", "{v}");
        // The contents: the nested document, as a PhotoCraft document.
        let contents = photocraft_format::load_from_bytes(bytes).unwrap();
        assert_eq!((contents.size.width, contents.size.height), (16, 12));
        assert_eq!(contents.layers.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(), ["Red", "Square"]);
        assert_eq!(first.transform.m, [1.0, 0.0, 0.0, 1.0, 2.0, 3.0], "{v}");
        assert!(close(second.transform.m[0], 1.25 * 0.4f64.cos()) && second.transform.m[4] == 22.0, "{v}");
        assert!(first.cache.is_some() && second.cache.is_some(), "{v}");
        assert_eq!(layer(&r.document.layers, "Second").opacity, 0.8);
    }
}

#[test]
fn image_sources_keep_their_png() {
    let r = open("v3-smart-image");
    let s = smart(&r, "Image");
    let SmartSource::Embedded { file_name, bytes } = &s.source else { panic!() };
    assert_eq!(file_name, "pattern.png");
    assert!(bytes.starts_with(b"\x89PNG"));
    assert_eq!(s.transform.m, [2.0, 0.0, 0.0, 2.0, 4.0, 4.0]);
    // No matrix: the source at its own size at the origin.
    assert_eq!(smart(&r, "Image at origin").transform, photocraft_geom::Affine::IDENTITY);
}

#[test]
fn smart_filters_map_to_pigments_and_the_others_are_reported() {
    for v in ["v2", "v3"] {
        let r = open(&format!("{v}-smart-filters"));
        let s = smart(&r, "Filtered");
        let ids: Vec<(&str, bool)> = s.smart_filters.iter().map(|f| (f.command.as_str(), f.visible)).collect();
        assert_eq!(
            ids,
            [("filter.blur.gaussianBlur", true), ("filter.sharpen.unsharpMask", true), ("image.adjustments.levels", true), ("image.adjustments.invert", false)],
            "{v}"
        );
        assert!(s.filters_enabled);

        let r = open(&format!("{v}-smart-filters-unmapped"));
        let s = smart(&r, "Unmapped");
        assert_eq!(s.smart_filters.iter().map(|f| f.command.as_str()).collect::<Vec<_>>(), ["filter.blur.boxBlur", "filter.pixelate.mosaic"], "{v}");
        assert_eq!(s.smart_filters[1].params, serde_json::json!({"cellSize": 4.0}));
        assert!(!s.filters_enabled, "{v}");
        assert!(r.warnings.iter().any(|w| w.contains("\"glowing-edges\"") && w.contains("(\"Unmapped\")")), "{v}: {:?}", r.warnings);
        // The import report says it was left out.
        let Some(ImportConversion::Report(report)) = r.document.metadata.import_conversion.as_deref() else { panic!() };
        let entry = report.entries.iter().find(|e| e.source_description.contains("glowing-edges")).unwrap();
        assert_eq!(entry.disposition, ConversionDisposition::SkippedNonessential);
        assert!(report.entries.iter().any(|e| e.disposition == ConversionDisposition::NativeApproximation), "{v}");
    }
}

#[test]
fn smart_objects_nested_too_deep_stop_at_eight() {
    for v in ["v2", "v3"] {
        let r = open(&format!("{v}-smart-deep"));
        // Each level holds the next in a smart object, kept as a PhotoCraft document.
        let mut doc = r.document.clone();
        let mut levels = 0;
        while let Some(LayerContent::Smart(sm)) = doc.layers.first().map(|l| &l.content) {
            let SmartSource::Embedded { bytes, .. } = &sm.source else { panic!() };
            doc = photocraft_format::load_from_bytes(bytes).unwrap();
            levels += 1;
        }
        assert_eq!(levels, super::smart::MAX_SMART_DEPTH, "{v}");
        assert!(r.warnings.iter().any(|w| w.contains("nest more than 8 deep")), "{v}: {:?}", r.warnings);
    }
}

#[test]
fn type_and_smart_objects_save_in_the_new_format_and_open_again() {
    for name in ["v3-text-runs", "v3-text-path", "v2-text-box", "v3-smart-instances", "v3-smart-filters"] {
        let first = open(name).document;
        let saved = crate::export(&first, "new.pigment", &crate::ExportOptions::default()).unwrap();
        let again = crate::import("new.pigment", &saved.bytes).unwrap().document;
        assert_eq!(again.layers.len(), first.layers.len(), "{name}");
        for (a, b) in again.layers.iter().zip(&first.layers) {
            match (&a.content, &b.content) {
                (LayerContent::Text(x), LayerContent::Text(y)) => {
                    assert_eq!((&x.text, &x.runs, &x.paragraphs, &x.shape, x.transform), (&y.text, &y.runs, &y.paragraphs, &y.shape, y.transform), "{name}")
                }
                (LayerContent::Smart(x), LayerContent::Smart(y)) => {
                    assert_eq!((&x.source, &x.smart_filters, x.transform, x.contents_id), (&y.source, &y.smart_filters, y.transform, y.contents_id), "{name}")
                }
                _ => assert_eq!(a.content.kind_name(), b.content.kind_name(), "{name}"),
            }
        }
        // Where it came from stays with it.
        assert!(super::came_from_legacy(&again), "{name}");
    }
}

#[test]
fn hostile_type_and_smart_objects() {
    let bytes = super::tests::described(
        r##"[
        {"id":"a","type":"text","content":{"v":1,"text":"ab😀","runs":[{"len":1e300,"style":{"size":-4,"color":7,"features":{"liga":"x","toolong":1}}},{"len":3}],"paras":"no"},"x":1e300,"width":-3,"transform":[1,2,2,4,0,0]},
        {"id":"b","type":"text","font":{"size":0,"lineHeight":"tall","stroke":{"width":1e9}},"text":7,"pathText":{"path":{"subpaths":[{"points":[{"x":1,"y":1}]}]}}},
        {"id":"c","type":"text","content":{"v":1,"text":"","runs":[],"paras":[]},"typeOptions":{"orientation":"vertical-stacked","antiAlias":1}},
        {"id":"d","type":"smart","sourceRef":"nowhere","transform":[1e300,0,0,1,0,0],"filters":[{"kind":"adjust:levels","params":{"rgb":"x"}},{"kind":7}],"stackMode":"chaos"},
        {"id":"e","type":"smart","transform":"no"}
    ]"##,
    );
    let r = crate::import("hostile.pigment", &bytes).unwrap();
    assert_eq!(r.document.layers.len(), 5);
    assert!(matches!(&r.document.layers[0].content, LayerContent::Text(t) if t.text == "ab😀"));
    assert!(matches!(&r.document.layers[1].content, LayerContent::Text(t) if t.text.is_empty()));
}

/// A smart object placed far larger than memory allows is reported and left undrawn, at once:
/// its placed source is not clipped to the canvas, so drawing it used to fill memory (a 64 px
/// image scaled 1000 times needs 16 GB) until the process was killed.
#[test]
fn a_smart_object_placed_too_large_is_reported_not_drawn() {
    let png = std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pigment-0.4/v3-smart-image.png")).unwrap();
    for t in ["[1000,0,0,1000,0,0]", "[1e7,0,0,1e7,0,0]", "[0,1e7,-1e7,0,5,5]"] {
        let json = format!(
            r#"{{"version":3,"app":"pigment","width":64,"height":64,"dpi":72,"layers":[{{"id":"s","name":"Big","type":"smart","source":{{"kind":"image","name":"x"}},"transform":{t}}}]}}"#
        );
        let bytes = super::tests::zip(&[("mimetype", b"application/x-pigment"), ("document.json", json.as_bytes()), ("smart/s.png", &png)]);
        let at = std::time::Instant::now();
        let r = crate::import("big.pigment", &bytes).unwrap();
        assert!(at.elapsed().as_secs() < 20, "{t}: {:?}", at.elapsed());
        assert!(smart(&r, "Big").cache.is_none(), "{t}");
        assert!(r.warnings.iter().any(|w| w.contains("Big") && w.contains("could not be drawn")), "{t}: {:?}", r.warnings);
    }
    // A placement that fits is drawn.
    let json = r#"{"version":3,"app":"pigment","width":64,"height":64,"dpi":72,"layers":[{"id":"s","name":"Fits","type":"smart","source":{"kind":"image","name":"x"},"transform":[2,0,0,2,0,0]}]}"#;
    let bytes = super::tests::zip(&[("mimetype", b"application/x-pigment"), ("document.json", json.as_bytes()), ("smart/s.png", &png)]);
    assert!(smart(&crate::import("fits.pigment", &bytes).unwrap(), "Fits").cache.is_some());
}
