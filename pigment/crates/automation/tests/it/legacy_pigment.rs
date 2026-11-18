//! Pigment: documents of Pigment 0.1–0.4 through automation's open paths (the CLI, MCP, the
//! headless sessions): recognised by their content whatever they are called, and their smart
//! objects drawn with their smart filters, as the app's File › Open draws them.

use std::path::PathBuf;

use photocraft_automation::files;
use photocraft_color::{ColorMode, PixelFormat, SampleType};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../io/tests/fixtures/pigment-0.4").join(name)
}

/// A 0.4 document named `.pcraft` (the native extension) opens from bytes, as from a workspace
/// folder of MCP or `serve`.
#[test]
fn a_pigment_0_4_document_named_pcraft_opens_from_bytes() {
    let bytes = std::fs::read(fixture("v3-groups.pigment")).unwrap();
    let expected = photocraft_io::import_with_options("x.pigment", &bytes, &Default::default()).unwrap().document;
    let opened = files::open_bytes("drawing.pcraft", &bytes).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(opened.document.layers.len(), expected.layers.len());
    assert_eq!(opened.document.size, expected.size);
}

/// The smart object of a 0.4 document opened by `files::open` shows its four smart filters: the
/// picture is within a few levels of the JavaScript app's.
#[test]
fn files_open_draws_the_smart_filters_of_a_pigment_0_4_document() {
    for v in ["v2", "v3"] {
        let opened = files::open(&fixture(&format!("{v}-smart-filters.pigment"))).unwrap();
        let ours = photocraft_compose::flatten_to_surface(&opened.document, PixelFormat::new(ColorMode::Rgb, SampleType::U8, true), None);
        let js = photocraft_codecs::decode(&std::fs::read(fixture(&format!("{v}-smart-filters.png"))).unwrap()).unwrap();
        let js = js.converted(photocraft_codecs::ChannelLayout::Rgba, photocraft_codecs::SampleType::U8);
        let (w, h) = js.dimensions();
        let mut sum = 0u64;
        for y in 0..h as i32 {
            for x in 0..w as i32 {
                let at = (y as usize * w as usize + x as usize) * 4;
                for c in 0..4 {
                    let level = (ours.pixel(x, y).get(c).copied().unwrap_or(0.0) * 255.0).round() as u8;
                    sum += u64::from(level.abs_diff(js.data()[at + c]));
                }
            }
        }
        let mean = sum as f64 / f64::from(w * h * 4);
        assert!(mean < 3.0, "{v}: mean {mean}");
    }
}
