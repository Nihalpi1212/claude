//! Pigment (F1): IPTC-IIM (image resource 1028) through PSD and JPEG: kept as the file had it while File Info
//! is not edited, seeded into XMP for an IIM-only JPEG, and written into a JPEG export's APP13.

use std::sync::Arc;

use crate::common;

use common::*;
use photocraft_color::{ColorMode, SampleType};
use photocraft_io::*;

fn doc() -> photocraft_doc::Document {
    let mut d = photocraft_doc::Document::new("iim", photocraft_geom::Size::new(9, 6), ColorMode::Rgb, SampleType::U8);
    let fmt = d.pixel_format();
    d.layers.push(raster("Background", fmt, d.bounds(), 3, false));
    d
}

/// A record-2 IIM stream of `(dataset, text)`, Latin-1 bytes as given (no 1:90).
fn iim(sets: &[(u8, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    for (ds, text) in sets {
        out.extend_from_slice(&[0x1c, 2, *ds]);
        out.extend_from_slice(&(text.len() as u16).to_be_bytes());
        out.extend_from_slice(text);
    }
    out
}

#[test]
fn a_psd_whose_file_info_is_unchanged_saves_byte_identical() {
    let mut d = doc();
    // Photoshop's own odd bytes: a Latin-1 caption with no character set, and a dataset File Info does not map.
    let raw = iim(&[(120, b"Caf\xe9"), (15, b"ART")]);
    d.metadata.psd_resources.push((iptc_iim::RESOURCE, String::new(), Arc::new(raw.clone())));
    let first = export(&d, "a.psd", &ExportOptions::default()).unwrap().bytes;
    let back = import("a.psd", &first).unwrap().document;
    assert_eq!(back.metadata.psd_resources.iter().find(|r| r.0 == iptc_iim::RESOURCE).map(|r| r.2.to_vec()), Some(raw.clone()));
    let second = export(&back, "a.psd", &ExportOptions::default()).unwrap().bytes;
    assert!(first == second, "the second save is the first, byte for byte");
    // A sync with no mapped change leaves the resource alone, even when the packets differ.
    let mut res = back.metadata.psd_resources.clone();
    iptc_iim::sync_resource(&mut res, None, Some("<x:xmpmeta xmlns:x='adobe:ns:meta/'/>"));
    assert_eq!(res, back.metadata.psd_resources);
}

#[test]
fn a_jpeg_with_only_iim_seeds_the_xmp_and_keeps_the_stream() {
    let plain = export(&doc(), "a.jpg", &ExportOptions::default()).unwrap().bytes;
    let stream = iim(&[(5, b"Title"), (25, b"one"), (25, b"two"), (80, b"Ann"), (120, b"Caf\xe9"), (55, b"20240217"), (60, b"124019+0100")]);
    let jpeg = iptc_iim::insert_app13(&plain, &stream);
    let d = import("old.jpg", &jpeg).unwrap().document;
    let xmp = d.metadata.xmp.as_deref().expect("seeded");
    let x = craft_metadata::parse_xmp(xmp).unwrap();
    assert_eq!(x.values["dc:title"].text(), Some("Title"));
    let subjects: Vec<_> = x.values["dc:subject"].items().iter().filter_map(|v| v.text()).collect();
    assert_eq!(subjects, ["one", "two"]);
    assert_eq!(x.values["dc:creator"].text(), Some("Ann"));
    assert_eq!(x.values["dc:description"].text(), Some("Café"), "Latin-1 without 1:90");
    assert_eq!(x.values["photoshop:DateCreated"].text(), Some("2024-02-17T12:40:19+01:00"));
    assert_eq!(d.metadata.psd_resources.iter().find(|r| r.0 == iptc_iim::RESOURCE).map(|r| r.2.to_vec()), Some(stream));
}

#[test]
fn a_jpeg_with_xmp_keeps_its_packet() {
    let mut d = doc();
    d.metadata.xmp = Some("<x:xmpmeta xmlns:x='adobe:ns:meta/'><rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'/></x:xmpmeta>".into());
    let with_xmp = export(&d, "a.jpg", &ExportOptions::default()).unwrap().bytes;
    let jpeg = iptc_iim::insert_app13(&with_xmp, &iim(&[(5, b"IIM title")]));
    let back = import("b.jpg", &jpeg).unwrap().document;
    assert!(!back.metadata.xmp.as_deref().unwrap_or_default().contains("IIM title"), "XMP wins over IIM");
}

#[test]
fn a_jpeg_export_with_metadata_carries_app13() {
    let mut d = doc();
    let stream = iptc_iim::encode(&[(5, "Nuit étoilée".into()), (105, "Ciel".into())], None);
    d.metadata.psd_resources.push((iptc_iim::RESOURCE, String::new(), Arc::new(stream.clone())));
    let out = export(&d, "c.jpg", &ExportOptions::default()).unwrap().bytes;
    let e = craft_metadata::jpeg_segments(&out);
    assert_eq!(e.iptc.as_deref(), Some(stream.as_slice()));
    assert_eq!(craft_metadata::parse_iptc(&stream).title.as_deref(), Some("Nuit étoilée"));
    // Still a JPEG that opens, with the same pixels as without the segment.
    let plain = {
        let mut p = d.clone();
        p.metadata.psd_resources.clear();
        export(&p, "c.jpg", &ExportOptions::default()).unwrap().bytes
    };
    let a = import("c.jpg", &out).unwrap().document;
    let b = import("c.jpg", &plain).unwrap().document;
    assert_eq!(a.layers[0].surface().unwrap().read_region(a.bounds()), b.layers[0].surface().unwrap().read_region(b.bounds()));
    // Metadata off, and other formats: no IIM.
    let off = ExportOptions { xmp: XmpEmbed::None, ..Default::default() };
    assert!(craft_metadata::jpeg_segments(&export(&d, "c.jpg", &off).unwrap().bytes).iptc.is_none());
    let png = export(&d, "c.png", &ExportOptions::default()).unwrap().bytes;
    assert!(!png.windows(4).any(|w| w == b"8BIM"));
}

#[test]
fn a_stream_above_one_segment_is_split_over_app13_segments() {
    let big = iptc_iim::encode(&[(120, "x".repeat(70_000))], None);
    let plain = export(&doc(), "a.jpg", &ExportOptions::default()).unwrap().bytes;
    let jpeg = iptc_iim::insert_app13(&plain, &big);
    let segments = jpeg.windows(16).filter(|w| w[0] == 0xff && w[1] == 0xed && &w[4..16] == b"Photoshop 3.").count();
    assert_eq!(segments, 2);
    assert!(import("big.jpg", &jpeg).is_ok());
}
