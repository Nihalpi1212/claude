//! Palette JSON, fitting geometry, the Generative Expand canvas, prompts and settings.

use nib_genai::ErrorKind;
use nib_genai::fit::{FitMode, aspect_words, fit_matrix, inset, pixel_size};
use nib_genai::image_util::{ExpandPlan, decode, parse_size, png_size, ratio_size};
use nib_genai::palette::{assign_by_lightness, extract_json, lightness, parse_hex, parse_palettes, to_hex};
use nib_genai::prompts::{self, Tone};
use vectorcraft_geom::{Affine, Point, Rect};

use crate::common::png;

#[test]
fn hex_colours() {
    assert_eq!(parse_hex("#FFaa00"), Some([255, 170, 0]));
    assert_eq!(parse_hex("0a0"), Some([0, 170, 0]));
    assert_eq!(parse_hex(" #123456 "), Some([0x12, 0x34, 0x56]));
    for bad in ["", "#12", "#1234", "#12345g", "red", "#ffffffff", "#ééé"] {
        assert_eq!(parse_hex(bad), None, "{bad}");
    }
    assert_eq!(to_hex([1, 2, 255]), "#0102ff");
    assert!(lightness([0, 0, 0]) < 1.0 && lightness([255, 255, 255]) > 99.0);
    assert!(lightness([255, 255, 0]) > lightness([0, 0, 255]));
}

#[test]
fn palettes_from_model_answers() {
    let answer = "```json\n{\"palettes\": [{\"name\": \"Dusk\", \"colors\": [\"#112233\", \"#AABBCC\", \"nope\", \"#abc\"]}, {\"name\": \"\", \"colors\": [\"#000000\"]}, {\"name\": \"Empty\", \"colors\": []}]}\n```";
    let p = parse_palettes(answer).unwrap();
    assert_eq!(p.len(), 2);
    assert_eq!(p[0].name, "Dusk");
    assert_eq!(p[0].colors, vec!["#112233".to_string(), "#aabbcc".to_string()]);
    assert_eq!(p[1].name, "Palette 2");
    // A bare array of colour arrays.
    let bare = parse_palettes("[[\"#ff0000\", \"#00ff00\"], [\"#0000ff\"]]").unwrap();
    assert_eq!(bare.len(), 2);
    assert_eq!(bare[1].colors, vec!["#0000ff"]);
    // A single palette object.
    assert_eq!(parse_palettes("{\"name\": \"One\", \"colours\": [\"#010101\"]}").unwrap()[0].name, "One");
    for bad in ["no json here", "{\"palettes\": []}", "{\"palettes\": [{\"colors\": [\"blue\"]}]}", "{not json}", "42"] {
        assert_eq!(parse_palettes(bad).unwrap_err().kind, ErrorKind::BadResponse, "{bad}");
    }
    // Bounded.
    let many = format!("{{\"palettes\": [{}]}}", vec!["{\"colors\": [\"#000000\"]}"; 50].join(","));
    assert_eq!(parse_palettes(&many).unwrap().len(), nib_genai::palette::MAX_PALETTES);
    let long = format!("[[{}]]", (0..100).map(|i| format!("\"#{:06x}\"", i * 1000)).collect::<Vec<_>>().join(","));
    assert_eq!(parse_palettes(&long).unwrap()[0].colors.len(), nib_genai::palette::MAX_COLORS);
    assert_eq!(extract_json("x {\"a\": 1} y"), Some("{\"a\": 1}"));
}

#[test]
fn rows_take_palette_colours_by_lightness() {
    let rows = [[250, 250, 250], [10, 10, 10], [128, 128, 128]];
    let palette = [[200, 0, 0], [0, 0, 60], [255, 230, 200]];
    let got = assign_by_lightness(&rows, &palette);
    let of = |row: usize| got.iter().find(|(r, _)| *r == row).map(|(_, c)| *c).unwrap();
    assert_eq!(of(1), [0, 0, 60], "the darkest row takes the darkest colour");
    assert_eq!(of(0), [255, 230, 200], "the lightest takes the lightest");
    assert_eq!(of(2), [200, 0, 0]);
    // Fewer colours than rows: the rows share them, spread from dark to light.
    let two = assign_by_lightness(&rows, &[[0, 0, 0], [255, 255, 255]]);
    assert_eq!(two.len(), 3);
    assert!(assign_by_lightness(&[], &palette).is_empty());
    assert_eq!(assign_by_lightness(&rows[..1], &palette).len(), 1);
}

fn apply(m: [f64; 6], p: Point) -> Point {
    Affine::new(m) * p
}

#[test]
fn fitting_into_areas() {
    let content = Rect::new(0.0, 0.0, 100.0, 50.0);
    let target = Rect::new(10.0, 10.0, 110.0, 210.0);
    let m = fit_matrix(content, target, FitMode::Contain).unwrap();
    let (a, b) = (apply(m, Point::new(0.0, 0.0)), apply(m, Point::new(100.0, 50.0)));
    assert!((a.x - 10.0).abs() < 1e-9 && (b.x - 110.0).abs() < 1e-9, "{a:?} {b:?}");
    assert!((a.y - 85.0).abs() < 1e-9 && (b.y - 135.0).abs() < 1e-9, "centred vertically: {a:?} {b:?}");
    let c = fit_matrix(content, target, FitMode::Cover).unwrap();
    let (a, b) = (apply(c, Point::new(0.0, 0.0)), apply(c, Point::new(100.0, 50.0)));
    assert!((a.y - 10.0).abs() < 1e-9 && (b.y - 210.0).abs() < 1e-9, "{a:?} {b:?}");
    assert!(a.x < 10.0 && b.x > 110.0, "covers the width too: {a:?} {b:?}");
    assert!(fit_matrix(Rect::new(0.0, 0.0, 0.0, 5.0), target, FitMode::Contain).is_none());
    assert!(fit_matrix(content, Rect::new(f64::NAN, 0.0, 1.0, 1.0), FitMode::Cover).is_none());
    assert_eq!(inset(Rect::new(0.0, 0.0, 100.0, 50.0), 0.1), Rect::new(5.0, 5.0, 95.0, 45.0));
    assert_eq!(pixel_size(Rect::new(0.0, 0.0, 300.0, 150.0), 1024), (1024, 512));
    assert_eq!(pixel_size(Rect::new(0.0, 0.0, 10.0, 40.0), 1024), (256, 1024));
    assert_eq!(pixel_size(Rect::ZERO, 512), (512, 512));
    assert_eq!(aspect_words(Rect::new(0.0, 0.0, 300.0, 200.0)), "landscape 3:2");
    assert_eq!(aspect_words(Rect::new(0.0, 0.0, 90.0, 160.0)), "portrait 9:16");
    assert_eq!(aspect_words(Rect::new(0.0, 0.0, 5.0, 5.0)), "square");
}

#[test]
fn expand_canvas_keeps_the_original_pixels() {
    let original = decode(&png(40, 20, |x, y| [x as u8 * 5, y as u8 * 10, 100, 255])).unwrap();
    let plan = ExpandPlan::new(40, 20, [10, 0, 30, 20], (1024, 1024)).unwrap();
    assert_eq!((plan.canvas_w, plan.canvas_h), (80, 40));
    assert_eq!((plan.ox, plan.oy), (10, 0));
    assert!((plan.scale - 12.8).abs() < 1e-9);
    assert_eq!((plan.pad_x, plan.pad_y), (0, 256));
    let (image, mask) = plan.inputs(&original).unwrap();
    assert_eq!(png_size(&image), Some((1024, 1024)));
    let m = decode(&mask).unwrap();
    // Inside the original: kept (opaque); the new area and the letterbox: may change (clear).
    assert_eq!(m.get_pixel(128 + 256, 256 + 128).0[3], 255);
    assert_eq!(m.get_pixel(900, 400).0[3], 0);
    assert_eq!(m.get_pixel(500, 10).0[3], 0);
    let answer = image::RgbaImage::from_pixel(1024, 1024, image::Rgba([0, 200, 0, 255]));
    let out = plan.compose(&original, &answer);
    assert_eq!(out.dimensions(), (80, 40));
    for (x, y) in [(0, 0), (39, 19), (17, 7)] {
        assert_eq!(out.get_pixel(10 + x, y), original.get_pixel(x, y), "original pixel {x},{y}");
    }
    assert_eq!(out.get_pixel(70, 30).0, [0, 200, 0, 255], "the new area comes from the answer");
    assert_eq!(ExpandPlan::new(40, 20, [0; 4], (1024, 1024)).unwrap_err().kind, ErrorKind::BadRequest);
    assert!(ExpandPlan::new(4000, 4000, [500, 0, 0, 0], (1024, 1024)).is_err(), "over the pixel cap");
    assert!(ExpandPlan::new(u32::MAX, 1, [5, 0, 0, 0], (1024, 1024)).is_err(), "overflow");
}

#[test]
fn image_helpers() {
    assert_eq!(png_size(&png(3, 7, |_, _| [0; 4])), Some((3, 7)));
    assert_eq!(png_size(b"GIF89a"), None);
    assert_eq!(png_size(&[]), None);
    assert_eq!(parse_size("1536x1024"), Some((1536, 1024)));
    assert_eq!(parse_size("auto"), None);
    assert_eq!(ratio_size("16:9", 1024), (1024, 576));
    assert_eq!(ratio_size("2:3", 1024), (683, 1024));
    assert_eq!(decode(b"not an image").unwrap_err().kind, ErrorKind::BadResponse);
    // A header claiming a huge image is refused before decoding.
    let mut huge = png(1, 1, |_, _| [0; 4]);
    huge[16..20].copy_from_slice(&100_000u32.to_be_bytes());
    assert!(decode(&huge).is_err());
}

#[test]
fn prompts_say_what_was_asked() {
    let palette = vec!["#112233".to_string()];
    let b = prompts::ArtBrief {
        prompt: "a red fox",
        kind: prompts::VectorKind::Icon,
        detail: prompts::Detail::Low,
        palette: &palette,
        aspect: "square",
        view: (512, 512),
        style_reference: true,
        full_bleed: false,
    };
    let svg = prompts::svg_prompt(&b);
    for want in ["a red fox", "viewBox=\"0 0 512 512\"", "icon", "#112233", "fewer than 30", "attached image"] {
        assert!(svg.contains(want), "{want} in {svg}");
    }
    let trace = prompts::trace_prompt(&b);
    assert!(trace.contains("a red fox") && trace.contains("white background"), "{trace}");
    let p = prompts::palette_prompt("ocean", &["calm".into(), " ".into()], &["#000000".into()], 3, 2);
    assert!(p.contains("2 different") && p.contains("exactly 3") && p.contains("calm") && p.contains("JSON"), "{p}");
    let r = prompts::rewrite_prompt(&Tone::Shorter, &["Big ".into(), "Sale".into()]);
    assert!(r.contains("2 segments") && r.contains("[\"Big \",\"Sale\"]"), "{r}");
    let one = prompts::rewrite_prompt(&Tone::Custom("Make it rhyme".into()), &["Hello".into()]);
    assert!(one.starts_with("Make it rhyme") && one.contains("\"Hello\"") && one.contains("{\"text\""), "{one}");
    assert!(prompts::expand_prompt("a beach").contains("a beach"));
}

#[test]
fn feature_requests_read_from_json() {
    let r: nib_genai::FeatureRequest = serde_json::from_value(serde_json::json!({
        "feature": "textToVector", "prompt": "fox", "kind": "icon", "detail": "high", "method": "imageTrace", "variations": 3
    }))
    .unwrap();
    let nib_genai::FeatureRequest::TextToVector(spec) = &r else { panic!("{r:?}") };
    assert_eq!(
        (spec.kind, spec.detail, spec.method, spec.variations),
        (prompts::VectorKind::Icon, prompts::Detail::High, nib_genai::ops::VectorMethod::ImageTrace, 3)
    );
    let t: nib_genai::FeatureRequest = serde_json::from_value(serde_json::json!({"feature": "rewrite", "tone": {"custom": "pirate"}})).unwrap();
    assert_eq!(t.feature(), nib_genai::Feature::Rewrite);
    let e: nib_genai::FeatureRequest = serde_json::from_value(serde_json::json!({"feature": "expand", "margins": [10, 0, 10, 0]})).unwrap();
    assert_eq!(e.feature().id(), "expand");
    assert!(serde_json::from_value::<nib_genai::FeatureRequest>(serde_json::json!({"feature": "teleport"})).is_err());
}
