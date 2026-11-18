//! Pigment: smart objects of documents saved by Pigment 0.1–0.4. Those files hold no pixels for
//! a smart object, only its source and smart filters; photocraft-io's importer
//! (`legacy_pigment`) asks the engine to draw them, with the engine's filters, through the
//! renderer installed here. Every open path installs it before it imports (`jobs::import_options`
//! and `file_cmds::open::import_result_for_open`).

use photocraft_doc::{Document, Layer};

/// Installs the renderer once per process.
pub(crate) fn install() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| photocraft_io::legacy_pigment::set_smart_object_renderer(render));
}

/// Draws `layer` (a smart object of `doc`) from its source and smart filters; `false` when it
/// cannot, and the importer then places the source without its filters.
fn render(doc: &Document, layer: &mut Layer) -> bool {
    crate::smart_cmds::refresh_layer(doc, layer).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use photocraft_color::{ColorMode, PixelFormat, SampleType};
    use photocraft_doc::LayerContent;

    fn fixture(name: &str) -> String {
        format!("{}/../io/tests/fixtures/pigment-0.4/{name}", env!("CARGO_MANIFEST_DIR"))
    }

    /// A smart object's filters, drawn by the engine when the document opens, against the picture
    /// the JavaScript app made of it: within a few levels of 8 bits on average (the blur, the
    /// sharpening and the levels are PhotoCraft's; the app had its own).
    #[test]
    fn smart_filters_are_drawn_when_a_pigment_0_4_document_opens() {
        for v in ["v2", "v3"] {
            let name = format!("{v}-smart-filters");
            let bytes = std::fs::read(fixture(&format!("{name}.pigment"))).unwrap();
            let doc = crate::file_cmds::import("smart.pigment", &bytes).unwrap();
            let LayerContent::Smart(sm) = &doc.layers[1].content else { panic!("{v}") };
            assert_eq!(sm.smart_filters.len(), 4, "{v}");
            let ours = photocraft_compose::flatten_to_surface(&doc, PixelFormat::new(ColorMode::Rgb, SampleType::U8, true), None);
            let js = photocraft_codecs::decode(&std::fs::read(fixture(&format!("{name}.png"))).unwrap()).unwrap();
            let js = js.converted(photocraft_codecs::ChannelLayout::Rgba, photocraft_codecs::SampleType::U8);
            let (w, h) = js.dimensions();
            let (mut sum, mut unfiltered_sum) = (0u64, 0u64);
            // The same document without its filters, for scale: the filters must have run.
            let mut plain = doc.clone();
            if let LayerContent::Smart(sm) = &mut plain.layers[1].content {
                sm.filters_enabled = false;
            }
            let id = plain.layers[1].id;
            crate::smart_cmds::refresh(&mut plain, id).unwrap();
            let unfiltered = photocraft_compose::flatten_to_surface(&plain, PixelFormat::new(ColorMode::Rgb, SampleType::U8, true), None);
            for y in 0..h as i32 {
                for x in 0..w as i32 {
                    let at = (y as usize * w as usize + x as usize) * 4;
                    for c in 0..4 {
                        let theirs = js.data()[at + c];
                        let level = |s: &photocraft_raster::Surface| (s.pixel(x, y).get(c).copied().unwrap_or(0.0) * 255.0).round() as u8;
                        sum += u64::from(level(&ours).abs_diff(theirs));
                        unfiltered_sum += u64::from(level(&unfiltered).abs_diff(theirs));
                    }
                }
            }
            let (mean, unfiltered_mean) = (sum as f64 / f64::from(w * h * 4), unfiltered_sum as f64 / f64::from(w * h * 4));
            assert!(mean < 3.0, "{v}: mean {mean}");
            assert!(mean * 2.0 < unfiltered_mean, "{v}: mean {mean}, without the filters {unfiltered_mean}");
        }
    }
}
