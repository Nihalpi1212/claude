//! Pigment: smart objects of documents saved by Pigment 0.1–0.4. Those files hold no pixels for
//! a smart object, only its source and smart filters; photocraft-io's importer
//! (`legacy_pigment`) asks the engine to draw them, with the engine's filters, through the
//! renderer installed here. Every open path installs it before it imports (`jobs::import_options`
//! and `file_cmds::open::import_result_for_open`; automation's `files` for the CLI and MCP).

use photocraft_doc::{Document, Layer};

/// Installs the renderer once per process. Call it before importing a document with
/// `photocraft_io` directly.
pub fn install() {
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

    /// A Pigment 0.4 document holding `png` as the source `s`, and `layers` (JSON).
    fn with_source(png: &[u8], layers: &[String]) -> Vec<u8> {
        let json = format!(r#"{{"version":3,"app":"pigment","width":64,"height":64,"dpi":72,"layers":[{}]}}"#, layers.join(","));
        let mut w = photocraft_format::zip::ZipWriter::new();
        w.add("document.json", json.as_bytes()).unwrap();
        w.add("smart/s.png", png).unwrap();
        w.finish().unwrap()
    }

    /// How many layers the warning that says `what` names (it shows five, and "and N more").
    fn named(warnings: &[String], what: &str) -> usize {
        warnings
            .iter()
            .filter(|w| w.contains(what))
            .map(|w| w.matches(", \"").count() + 1 + w.rsplit_once(" and ").and_then(|(_, n)| n.split(' ').next()?.parse::<usize>().ok()).unwrap_or(0))
            .sum()
    }

    /// An opaque 64 px PNG.
    fn opaque_png() -> Vec<u8> {
        let image = photocraft_codecs::Image::from_u8(64, 64, photocraft_codecs::ChannelLayout::Rgba, [40, 120, 200, 255].repeat(64 * 64)).unwrap();
        photocraft_codecs::encode(&image, photocraft_codecs::Format::Png, &Default::default()).unwrap()
    }

    /// Each smart object the engine draws when a Pigment 0.4 document opens takes from the
    /// document's pixel memory. Instances of one small source, placed large, each keep their own
    /// pixels (here 2242 x 2242 px, 20 MB, each within Memory Usage): those past what the
    /// document may take stay undrawn, reported, instead of filling memory.
    #[test]
    fn smart_objects_drawn_when_a_pigment_0_4_document_opens_take_from_its_pixel_memory() {
        super::install();
        let layers: Vec<String> = (0..16)
            .map(|k| {
                format!(
                    r#"{{"id":"l{k}","name":"S{k}","type":"smart","sourceRef":"s","source":{{"kind":"image","name":"x"}},"transform":[35,0,0,35,{},0]}}"#,
                    k * 3
                )
            })
            .collect();
        let bytes = with_source(&opaque_png(), &layers);
        let limit = 100u64 << 20;
        let r = photocraft_io::legacy_pigment::import_within("many.pigment", &bytes, &photocraft_raster::Interrupt::NONE, limit).unwrap();
        let caches: Vec<_> = r.document.layers.iter().filter_map(|l| if let LayerContent::Smart(sm) = &l.content { sm.cache.as_ref() } else { None }).collect();
        let kept: u64 = caches.iter().map(|c| photocraft_raster::stored_tiles_bytes(c.tile_count() as u64, &c.format())).sum();
        assert!(kept <= limit, "{} smart objects keep {kept} bytes", caches.len());
        assert!(!caches.is_empty());
        assert_eq!(named(&r.warnings, "contents could not be drawn"), 16 - caches.len(), "{:?}", r.warnings);
    }

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
