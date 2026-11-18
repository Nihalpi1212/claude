//! The importer against documents the JavaScript Pigment's own writer wrote
//! (`tests/fixtures/pigment-0.4/`, whose README says how they were made), and against damaged
//! and hostile files built here.

use photocraft_color::{BlendMode, ColorMode, SampleType};
use photocraft_doc::vector::{Knot, PathOp, Subpath};
use photocraft_doc::{Document, LabelColor, Layer, LayerContent};
use photocraft_geom::Point;
use photocraft_raster::Surface;

use super::*;
use crate::ImportResult;

/// The writers: document format 1 (Pigment 0.2), 2 (0.3.1) and 3 (0.4.0).
const VERSIONS: [&str; 3] = ["v1", "v2", "v3"];

fn fixture_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pigment-0.4")
}

fn fixture(name: &str) -> Vec<u8> {
    let path = fixture_dir().join(format!("{name}.pigment"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn open(name: &str) -> ImportResult {
    let bytes = fixture(name);
    assert!(is_legacy(&bytes), "{name}");
    crate::import(&format!("{name}.pigment"), &bytes).unwrap_or_else(|e| panic!("{name}: {e}"))
}

/// The layer called `name`, wherever it is in the tree.
fn layer<'a>(layers: &'a [Layer], name: &str) -> &'a Layer {
    fn find<'a>(layers: &'a [Layer], name: &str) -> Option<&'a Layer> {
        layers.iter().find_map(|l| if l.name == name { Some(l) } else { l.children().and_then(|c| find(c, name)) })
    }
    find(layers, name).unwrap_or_else(|| panic!("no layer \"{name}\""))
}

fn names(layers: &[Layer]) -> Vec<&str> {
    layers.iter().map(|l| l.name.as_str()).collect()
}

fn raster(l: &Layer) -> &Surface {
    match &l.content {
        LayerContent::Raster(s) => s,
        other => panic!("\"{}\" is {}", l.name, other.kind_name()),
    }
}

/// A pixel as 8-bit values.
fn px8(s: &Surface, x: i32, y: i32) -> Vec<u8> {
    s.pixel(x, y).iter().map(|v| (v * 255.0).round() as u8).collect()
}

/// A pixel as 16-bit values.
fn px16(s: &Surface, x: i32, y: i32) -> Vec<u16> {
    s.pixel(x, y).iter().map(|v| (v * 65535.0).round() as u16).collect()
}

/// `patternPixel` of make-fixtures.mjs.
fn pattern(x: i32, y: i32) -> Vec<u8> {
    vec![((x * 37 + 11) & 255) as u8, ((y * 53 + 29) & 255) as u8, (((x + y) * 17 + 5) & 255) as u8, 255]
}

/// `luma` of shared/pixels/modes.js.
fn luma(r: i32, g: i32, b: i32) -> u8 {
    ((r * 299 + g * 587 + b * 114 + 500) / 1000) as u8
}

fn zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut w = craft_zip::Writer::new();
    for (name, data) in entries {
        w.add(name, data, craft_zip::Compression::Deflated).unwrap();
    }
    w.finish().unwrap()
}

/// A document with `layers` (JSON) and no pixels.
fn described(layers: &str) -> Vec<u8> {
    let json = format!(r#"{{"version":3,"app":"pigment","width":4,"height":4,"dpi":72,"layers":{layers}}}"#);
    zip(&[("mimetype", b"application/x-pigment"), ("document.json", json.as_bytes())])
}

fn damage_of(bytes: &[u8]) -> String {
    match crate::import("old.pigment", bytes) {
        Err(IoError::LegacyPigment(why)) => why,
        other => panic!("expected the typed error, got {:?}", other.map(|r| r.warnings)),
    }
}

// ---- documents the JavaScript app wrote -----------------------------------------------------

#[test]
fn raster_layers_keep_their_place_pixels_and_properties() {
    for v in VERSIONS {
        let name = format!("{v}-raster-offset");
        let r = open(&name);
        let doc = &r.document;
        assert_eq!(r.warnings, Vec::<String>::new(), "{v}");
        // Save must not put the new format over the old file by itself.
        assert!(r.source_read_only && !r.preview_only);
        assert_eq!(doc.name, format!("{name}.pigment"));
        assert_eq!((doc.size.width, doc.size.height, doc.resolution_dpi), (16, 12, 144.0));
        assert_eq!((doc.mode, doc.depth), (ColorMode::Rgb, SampleType::U8));
        assert_eq!(doc.icc_profile, None);
        // Bottom to top, as the app listed them.
        assert_eq!(names(&doc.layers), ["Background", "Paint", "Half", "Corner"]);

        let bg = layer(&doc.layers, "Background");
        assert_eq!((bg.opacity, bg.fill_opacity, bg.blend, bg.visible, bg.clipped), (1.0, 1.0, BlendMode::Normal, true, false));
        assert!(!bg.locks.any() && bg.mask.is_none() && bg.label == LabelColor::None && bg.link_group.is_none());
        for (x, y) in [(0, 0), (15, 11), (7, 5)] {
            assert_eq!(px8(raster(bg), x, y), [255, 255, 255, 255]);
        }
        assert_eq!(px8(raster(bg), 16, 0), [0, 0, 0, 0]);

        let paint = layer(&doc.layers, "Paint");
        assert_eq!((paint.opacity, paint.fill_opacity, paint.blend), (0.6, 0.8, BlendMode::Multiply));
        // Lock Image Pixels includes Lock Transparent Pixels in PhotoCraft's model.
        assert!(paint.locks.pixels && !paint.locks.transparency && !paint.locks.position && !paint.locks.all);
        for y in 0..5 {
            for x in 0..6 {
                assert_eq!(px8(raster(paint), 3 + x, 2 + y), pattern(x, y), "{v} ({x}, {y})");
            }
        }
        for (x, y) in [(2, 2), (9, 2), (3, 1), (3, 7)] {
            assert_eq!(px8(raster(paint), x, y), [0, 0, 0, 0], "{v} ({x}, {y})");
        }

        let half = layer(&doc.layers, "Half");
        assert!(half.clipped && !half.visible);
        // Partly left of the canvas: its pixels are kept there.
        assert_eq!(px8(raster(half), -2, 9), [255, 0, 0, 128]);
        assert_eq!(px8(raster(half), -1, 12), [255, 0, 0, 128]);
        assert_eq!(px8(raster(half), 0, 9)[3], 0);

        let corner = layer(&doc.layers, "Corner");
        assert_eq!(corner.blend, BlendMode::LinearDodge);
        assert!(corner.locks.all && corner.locks.position && !corner.locks.pixels);
        assert_eq!(px8(raster(corner), 14, 10), [0, 128, 255, 255]);
        assert_eq!(px8(raster(corner), 17, 13), [0, 128, 255, 255]);
    }
}

#[test]
fn groups_keep_their_tree_blending_and_folding() {
    for v in VERSIONS {
        let r = open(&format!("{v}-groups"));
        let doc = &r.document;
        assert_eq!(r.warnings, Vec::<String>::new(), "{v}");
        assert_eq!(names(&doc.layers), ["Background", "Outer", "Top"]);
        let outer = layer(&doc.layers, "Outer");
        let LayerContent::Group(g) = &outer.content else { panic!("Outer is not a group") };
        assert!(g.expanded && g.artboard.is_none());
        assert_eq!(outer.blend, BlendMode::PassThrough);
        assert_eq!(names(&g.children), ["Red", "Inner", "Empty"]);
        let inner = layer(&doc.layers, "Inner");
        let LayerContent::Group(g) = &inner.content else { panic!("Inner is not a group") };
        assert!(!g.expanded);
        assert_eq!((inner.blend, inner.opacity), (BlendMode::Normal, 0.5));
        assert_eq!(names(&g.children), ["Green", "Blue"]);
        assert_eq!(px8(raster(layer(&doc.layers, "Green")), 2, 2), [0, 255, 0, 255]);
        assert_eq!(px8(raster(layer(&doc.layers, "Green")), 6, 6), [0, 0, 0, 0]);
        let blue = layer(&doc.layers, "Blue");
        assert_eq!(blue.blend, BlendMode::Screen);
        assert_eq!(px8(raster(blue), 6, 6), [0, 0, 255, 255]);
        let empty = layer(&doc.layers, "Empty");
        assert_eq!((empty.blend, empty.visible, empty.children().map(<[Layer]>::len)), (BlendMode::Multiply, false, Some(0)));
        assert_eq!(px8(raster(layer(&doc.layers, "Top")), 7, 0), [0, 0, 0, 255]);

        // The picture: red over white, the half-opaque group's green and blue over it, a black pixel.
        let image = crate::document_to_image(doc, &mut Vec::new()).unwrap().to_rgba8();
        let at = |x: usize, y: usize| image[(y * 8 + x) * 4..(y * 8 + x) * 4 + 4].to_vec();
        assert_eq!(at(0, 0), [255, 0, 0, 255], "{v}");
        assert_eq!(at(7, 0), [0, 0, 0, 255], "{v}");
        let green = at(3, 3);
        assert!(green[0].abs_diff(128) <= 1 && green[1].abs_diff(128) <= 1 && green[2] == 0, "{v}: {green:?}");
        // Screen inside the isolated group: blue over green is cyan, at half opacity over red.
        let cyan = at(5, 5);
        assert!(cyan[0].abs_diff(128) <= 1 && cyan[1].abs_diff(128) <= 1 && cyan[2].abs_diff(128) <= 1, "{v}: {cyan:?}");
    }
}

#[test]
fn layer_masks_with_density_and_feather() {
    for v in VERSIONS {
        let r = open(&format!("{v}-masks"));
        let doc = &r.document;
        assert_eq!(r.warnings, Vec::<String>::new(), "{v}");
        let ramp = layer(&doc.layers, "Ramp mask").mask.as_ref().expect("a mask");
        assert!(ramp.enabled && ramp.linked);
        // Density and feather came with Pigment 0.4.
        assert_eq!((ramp.density, ramp.feather), if v == "v3" { (0.5, 2.5) } else { (1.0, 0.0) }, "{v}");
        for x in 0..8 {
            for y in [0, 7] {
                assert_eq!(px8(&ramp.surface, x, y), [(x * 36) as u8], "{v} ({x}, {y})");
            }
        }
        // Outside the canvas a mask reveals.
        assert_eq!(px8(&ramp.surface, 8, 0), [255]);
        assert_eq!(px8(&ramp.surface, -1, 3), [255]);
        assert_eq!(ramp.surface.format().sample, SampleType::U8);

        let off = layer(&doc.layers, "Disabled unlinked mask");
        let mask = off.mask.as_ref().expect("a mask");
        assert!(!mask.enabled && !mask.linked);
        assert_eq!((px8(&mask.surface, 0, 0), px8(&mask.surface, 0, 4)), (vec![255], vec![0]));
        assert_eq!(px8(raster(off), 2, 2), [0, 0, 255, 255]);

        let group = layer(&doc.layers, "Masked group");
        let mask = group.mask.as_ref().expect("a mask on the group");
        assert!(group.is_group() && mask.enabled);
        assert_eq!((px8(&mask.surface, 3, 6), px8(&mask.surface, 4, 6)), (vec![0], vec![255]));
        assert!(layer(&doc.layers, "Inside").mask.is_none() && layer(&doc.layers, "Background").mask.is_none());
    }
}

#[test]
fn the_selection_and_saved_channels() {
    for v in VERSIONS {
        let r = open(&format!("{v}-selection-channels"));
        let doc = &r.document;
        assert_eq!(r.warnings, Vec::<String>::new(), "{v}");
        let sel = doc.selection.as_ref().expect("a selection");
        for y in 0..6 {
            for x in 0..8 {
                let want = if (2..6).contains(&x) && (1..4).contains(&y) { if x == 2 { 128 } else { 255 } } else { 0 };
                assert_eq!(px8(sel, x, y), [want], "{v} ({x}, {y})");
            }
        }
        assert_eq!(doc.channels.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["Alpha 1", "Left half"]);
        for (i, c) in doc.channels.iter().enumerate() {
            assert!(c.spot.is_none() && c.opacity == 0.5, "{v}");
            for p in 0..48i32 {
                let want = if i == 0 {
                    ((p * 5) & 255) as u8
                } else if p % 8 < 4 {
                    255
                } else {
                    0
                };
                assert_eq!(px8(&c.surface, p % 8, p / 8), [want], "{v} channel {i} pixel {p}");
            }
        }
    }
}

#[test]
fn guides_the_ruler_origin_paths_and_the_global_light() {
    for v in VERSIONS {
        let r = open(&format!("{v}-guides-paths"));
        let doc = &r.document;
        // `axis: "x"` is a vertical guide.
        assert_eq!(doc.guides.vertical, [8.0, 20.0], "{v}");
        if v == "v3" {
            // The document store of 0.4: a coloured guide, an artboard's guide, the ruler origin.
            assert_eq!(doc.guides.horizontal, [12.5, 3.0]);
            assert_eq!(doc.guides.color(true, 20.0), Some([255, 128, 0]));
            assert_eq!(doc.guides.colors.len(), 1);
            assert_eq!(doc.ruler_origin, [4.0, 6.0]);
            assert_eq!(r.warnings, ["guides that belonged to an artboard open as guides of the document"]);
        } else {
            assert_eq!(doc.guides.horizontal, [12.5]);
            assert!(doc.guides.colors.is_empty());
            assert_eq!(doc.ruler_origin, [0.0, 0.0]);
            assert_eq!(r.warnings, Vec::<String>::new(), "{v}");
        }

        assert_eq!(doc.paths.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["Triangle with a hole", "Curve"]);
        let triangle = &doc.paths[0].path;
        assert_eq!(triangle.subpaths[0], Subpath::polygon(&[(2.0, 2.0), (14.0, 2.0), (8.0, 12.0)]));
        assert_eq!(triangle.subpaths[1], Subpath::polygon(&[(6.0, 4.0), (10.0, 4.0), (8.0, 8.0)]).with_op(PathOp::Subtract));
        assert!(!triangle.inverted && doc.paths[0].psd_raw.is_none());
        let curve = &doc.paths[1].path.subpaths[0];
        assert!(!curve.closed);
        let p = Point::new;
        assert_eq!(
            curve.knots,
            [
                Knot { anchor: p(4.0, 20.0), in_ctrl: p(4.0, 20.0), out_ctrl: p(8.0, 14.0), smooth: false },
                Knot { anchor: p(16.0, 20.0), in_ctrl: p(12.0, 14.0), out_ctrl: p(20.0, 26.0), smooth: true },
                Knot { anchor: p(28.0, 20.0), in_ctrl: p(24.0, 26.0), out_ctrl: p(28.0, 20.0), smooth: false },
            ]
        );
        assert_eq!(doc.work_path.as_ref().map(|w| w.subpaths.clone()), Some(vec![Subpath::polygon(&[(20.0, 2.0), (30.0, 2.0), (30.0, 10.0), (20.0, 10.0)])]));
        assert_eq!((doc.global_light.angle, doc.global_light.altitude), (45.0, 60.0));
        assert_eq!(doc.clipping_path, None);
    }
}

#[test]
fn colour_labels_link_sets_and_file_info() {
    for v in VERSIONS {
        let r = open(&format!("{v}-tags-info"));
        let doc = &r.document;
        for (name, label) in [
            ("Background", LabelColor::None),
            ("Red", LabelColor::Red),
            ("Orange", LabelColor::Orange),
            ("Yellow", LabelColor::Yellow),
            ("Green", LabelColor::Green),
            ("Blue", LabelColor::Blue),
            ("Violet", LabelColor::Violet),
            ("Gray", LabelColor::Gray),
            ("Plain", LabelColor::None),
        ] {
            assert_eq!(layer(&doc.layers, name).label, label, "{v} {name}");
        }
        let link = |name: &str| layer(&doc.layers, name).link_group;
        assert!(link("Red").is_some() && link("Red") == link("Yellow"), "{v}");
        assert!(link("Green").is_some() && link("Green") == link("Plain"), "{v}");
        assert_ne!(link("Red"), link("Green"));
        // Alone in its set: linked to nothing, as the app treated it.
        for name in ["Violet", "Orange", "Blue", "Gray", "Background"] {
            assert_eq!(link(name), None, "{v} {name}");
        }

        let xmp = doc.metadata.xmp.as_deref().expect("File Info");
        for part in [
            "<dc:title><rdf:Alt><rdf:li xml:lang=\"x-default\">A title</rdf:li></rdf:Alt></dc:title>",
            "<dc:creator><rdf:Seq><rdf:li>An author</rdf:li></rdf:Seq></dc:creator>",
            "<rdf:li xml:lang=\"x-default\">A description\nin two lines</rdf:li>",
            "<rdf:li xml:lang=\"x-default\">© 2026 Somebody</rdf:li>",
            "<dc:subject><rdf:Bag><rdf:li>one</rdf:li><rdf:li>two</rdf:li><rdf:li>three</rdf:li></rdf:Bag></dc:subject>",
            "<xmp:Rating>4</xmp:Rating>",
            "<photoshop:Credit>A credit</photoshop:Credit>",
            "<photoshop:Source>A source</photoshop:Source>",
            "<xmpRights:Marked>True</xmpRights:Marked>",
            "<xmpRights:WebStatement>https://example.com/rights</xmpRights:WebStatement>",
            "<tiff:Make>Camera maker</tiff:Make>",
            "<tiff:Model>Camera model</tiff:Model>",
            "<aux:Lens>35mm F2.8</aux:Lens>",
            "<exif:ExposureTime>0.004</exif:ExposureTime>",
            "<exif:FNumber>2.8</exif:FNumber>",
            "<rdf:li>200</rdf:li>",
            "<exif:FocalLength>35</exif:FocalLength>",
            "<exif:FocalLengthIn35mmFilm>52</exif:FocalLengthIn35mmFilm>",
            "<exif:DateTimeOriginal>2026-01-02T03:04:05</exif:DateTimeOriginal>",
        ] {
            assert!(xmp.contains(part), "{v}: {part} is not in\n{xmp}");
        }
        // Internal state of the app is not File Info.
        assert!(!xmp.contains("ignored") && !xmp.contains("layerTags"));
        assert_eq!(doc.metadata.exif, None);
        assert_eq!(r.warnings, ["the camera data is kept in File Info; the photograph's original EXIF block was not in the file"], "{v}");
    }
}

#[test]
fn sixteen_bit_documents_take_their_deep_pixels() {
    // `sample` of make-fixtures.mjs.
    let sample = |x: i32, y: i32, c: i32| ((x * 8000 + y * 300 + c * 77 + 1) & 65535) as u16;
    for v in ["v2", "v3"] {
        let r = open(&format!("{v}-deep-u16"));
        let doc = &r.document;
        assert_eq!((doc.mode, doc.depth), (ColorMode::Rgb, SampleType::U16));
        assert_eq!(names(&doc.layers), ["Deep background", "Deep offset", "Proxy only"]);
        let bg = raster(layer(&doc.layers, "Deep background"));
        assert_eq!(bg.format().sample, SampleType::U16);
        for y in 0..4 {
            for x in 0..8 {
                assert_eq!(px16(bg, x, y), [sample(x, y, 0), sample(x, y, 1), sample(x, y, 2), 65535], "{v} ({x}, {y})");
            }
        }
        let off = raster(layer(&doc.layers, "Deep offset"));
        for y in 0..2 {
            for x in 0..3 {
                let alpha = if x == 0 { 32767 } else { 65535 };
                assert_eq!(px16(off, 4 + x, 1 + y), [sample(x, y, 0), sample(x, y, 1), sample(x, y, 2), alpha], "{v} ({x}, {y})");
            }
        }
        assert_eq!(px16(off, 3, 1), [0, 0, 0, 0]);
        // A layer whose 16-bit pixels the file lacks: its 8-bit pixels, and the report says so.
        assert_eq!(px16(raster(layer(&doc.layers, "Proxy only")), 1, 3), [10 * 257, 20 * 257, 30 * 257, 65535]);
        assert_eq!(r.warnings, ["the layer's 16-bit pixels are not in the file; its 8-bit pixels were used (\"Proxy only\")"], "{v}");
    }
}

#[test]
fn thirty_two_bit_documents_keep_their_values() {
    let sample = |x: i32, y: i32, c: i32| (f64::from(x) / 7.0 + f64::from(y) * 0.001 + f64::from(c) * 0.0001 + if x == 7 && c == 0 { 1.5 } else { 0.0 }) as f32;
    for v in ["v2", "v3"] {
        let r = open(&format!("{v}-deep-f32"));
        let doc = &r.document;
        assert_eq!((doc.mode, doc.depth), (ColorMode::Rgb, SampleType::F32));
        let bg = raster(layer(&doc.layers, "Deep background"));
        for y in 0..4 {
            for x in 0..8 {
                assert_eq!(bg.pixel(x, y), [sample(x, y, 0), sample(x, y, 1), sample(x, y, 2), 1.0], "{v} ({x}, {y})");
            }
        }
        // Brighter than white is kept.
        assert_eq!(bg.pixel(7, 0)[0], 2.5);
        let off = raster(layer(&doc.layers, "Deep offset"));
        assert_eq!(off.pixel(4, 1), [sample(0, 0, 0), sample(0, 0, 1), sample(0, 0, 2), 0.5]);
        assert_eq!(off.pixel(6, 2), [sample(2, 1, 0), sample(2, 1, 1), sample(2, 1, 2), 1.0]);
        let proxy = raster(layer(&doc.layers, "Proxy only")).pixel(0, 2);
        assert_eq!(proxy, [10.0 / 255.0, 20.0 / 255.0, 30.0 / 255.0, 1.0]);
        assert_eq!(
            r.warnings,
            [
                "32-bit documents of Pigment 0.4 held display values (sRGB-encoded, not linear light); the values are kept as they were",
                "the layer's 32-bit pixels are not in the file; its 8-bit pixels were used (\"Proxy only\")",
            ],
            "{v}"
        );
    }
}

#[test]
fn grayscale_and_indexed_colour() {
    for v in ["v2", "v3"] {
        // Grayscale: grey pixels with alpha.
        let r = open(&format!("{v}-mode-grayscale"));
        assert_eq!((r.document.mode, r.document.depth, r.warnings.len()), (ColorMode::Grayscale, SampleType::U8, 0));
        let s = raster(layer(&r.document.layers, "Background"));
        assert_eq!((s.format().mode, s.channels()), (ColorMode::Grayscale, 2));
        for y in 0..8 {
            for x in 0..8 {
                assert_eq!(px8(s, x, y), [luma(x * 36, y * 36, (x + y) * 18), 255], "{v} ({x}, {y})");
            }
        }

        // Indexed Color: the table, its transparent entry, and the pixels expanded.
        let r = open(&format!("{v}-mode-indexed"));
        assert_eq!((r.document.mode, r.warnings.len()), (ColorMode::Indexed, 0));
        let table = r.document.color_table.as_ref().expect("a colour table");
        assert_eq!(table.colors, [[0, 0, 255], [0, 255, 0], [255, 0, 0], [255, 255, 0], [0, 0, 0]]);
        assert_eq!(table.transparent, Some(4));
        let s = raster(layer(&r.document.layers, "Background"));
        assert_eq!(s.channels(), 4);
        let columns = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
        for x in 0..8 {
            let c = columns[(x as usize >> 1) % 4];
            assert_eq!(px8(s, x, 3), [c[0], c[1], c[2], 255], "{v} column {x}");
        }
        assert_eq!(px8(s, 7, 7)[3], 0);
    }
}

#[test]
fn duotone_and_bitmap() {
    for v in ["v2", "v3"] {
        // Duotone: grey pixels and the inks with their curves.
        let r = open(&format!("{v}-mode-duotone"));
        assert_eq!((r.document.mode, r.warnings.len()), (ColorMode::Duotone, 0));
        let duotone = r.document.duotone.as_ref().expect("inks");
        assert_eq!(duotone.inks.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), ["Black", "Sepia"]);
        assert_eq!(duotone.inks[0].color, [0.0, 0.0, 0.0]);
        assert_eq!(duotone.inks[1].color, [168.0 / 255.0, 113.0 / 255.0, 63.0 / 255.0]);
        let curve = |i: usize| duotone.inks[i].curve.iter().map(|p| (p.input, p.output)).collect::<Vec<_>>();
        assert_eq!(curve(0), [(0.0, 0.0), (0.5, 0.3), (1.0, 1.0)]);
        assert_eq!(curve(1), [(0.0, 0.0), (0.5, 0.65), (1.0, 1.0)]);
        let s = raster(layer(&r.document.layers, "Background"));
        assert_eq!(px8(s, 5, 2), [luma(5 * 36, 2 * 36, 7 * 18), 255]);

        // Bitmap: black and white.
        let r = open(&format!("{v}-mode-bitmap"));
        assert_eq!((r.document.mode, r.document.depth, r.warnings.len()), (ColorMode::Bitmap, SampleType::U8, 0));
        let s = raster(layer(&r.document.layers, "Background"));
        for y in 0..8 {
            for x in 0..8 {
                let white = f64::from(luma(x * 36, y * 36, (x + y) * 18)) >= 127.5;
                assert_eq!(px8(s, x, y), [if white { 255 } else { 0 }, 255], "{v} ({x}, {y})");
            }
        }
    }
}

#[test]
fn cmyk_lab_and_multichannel() {
    for v in ["v2", "v3"] {
        // CMYK and Lab were views of RGB pixels: RGB, and the report says so.
        for (mode, label) in [("cmyk", "CMYK"), ("lab", "Lab")] {
            let r = open(&format!("{v}-mode-{mode}"));
            assert_eq!(r.document.mode, ColorMode::Rgb);
            assert_eq!(px8(raster(layer(&r.document.layers, "Background")), 2, 3), pattern(2, 3));
            assert_eq!(
                r.warnings,
                [format!("{label} documents of Pigment 0.4 held RGB pixels with a {label} view of them; the document opens in RGB with the same pixels")]
            );
        }

        // Multichannel: the inks are the picture.
        let r = open(&format!("{v}-mode-multichannel"));
        let doc = &r.document;
        assert_eq!(doc.mode, ColorMode::Multichannel);
        assert!(doc.layers.is_empty());
        assert_eq!(doc.channels.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["Cyan", "Magenta", "Yellow", "Alpha 1"]);
        let ink = |i: usize| doc.channels[i].spot.map(|(c, solidity)| (c.to_rgba8(), solidity));
        assert_eq!(ink(0), Some(([0, 255, 255, 255], 0.0)));
        assert_eq!(ink(1), Some(([255, 0, 255, 255], 0.0)));
        assert_eq!(ink(2), Some(([255, 255, 0, 255], 0.0)));
        assert_eq!(ink(3), None);
        for y in 0..8 {
            for x in 0..8 {
                // Ink density: cyan prints where red is missing, and so on.
                assert_eq!(px8(&doc.channels[0].surface, x, y), [(255 - x * 36) as u8], "{v} cyan ({x}, {y})");
                assert_eq!(px8(&doc.channels[1].surface, x, y), [(255 - y * 36) as u8], "{v} magenta ({x}, {y})");
                assert_eq!(px8(&doc.channels[2].surface, x, y), [(255 - (x + y) * 18) as u8], "{v} yellow ({x}, {y})");
                assert_eq!(px8(&doc.channels[3].surface, x, y), [((y * 8 + x) * 4) as u8], "{v} alpha ({x}, {y})");
            }
        }
        assert_eq!(r.warnings.len(), 1);
        assert!(r.warnings[0].starts_with("Multichannel documents open as their ink channels"), "{:?}", r.warnings);
    }
}

#[test]
fn the_document_profile_of_the_unfinished_0_5() {
    // Its bytes are in the file.
    let r = open("wip05-profile");
    assert_eq!(r.warnings, Vec::<String>::new());
    let icc = r.document.icc_profile.as_ref().expect("a profile");
    let parsed = craft_cms::Profile::parse(icc).unwrap();
    assert!(parsed.same_colors(craft_cms::Builtin::DisplayP3.profile()));
    assert!(!parsed.same_colors(craft_cms::Builtin::Srgb.profile()));
    assert_eq!(px8(raster(layer(&r.document.layers, "Background")), 0, 0), [200, 100, 50, 255]);

    // Described only: a built-in found by its id.
    let r = open("wip05-profile-id-only");
    assert_eq!(r.warnings, Vec::<String>::new());
    assert_eq!(r.document.icc_profile.as_deref(), Some(&craft_cms::Builtin::AdobeRgbCompat.profile().to_bytes().to_vec()));

    // A profile that is neither in the file nor known, and one for another colour model.
    for profile in [r#"{"id":"0f3a","name":"Scanner"}"#, r#"{"id":"gray-gamma-2.2","name":"Gray Gamma 2.2","wellKnown":"gray-gamma-2.2"}"#] {
        let json = format!(r#"{{"version":3,"app":"pigment","width":2,"height":2,"profile":{profile},"layers":[]}}"#);
        let r = crate::import("p.pigment", &zip(&[("document.json", json.as_bytes())])).unwrap();
        assert_eq!(r.document.icc_profile, None);
        assert!(r.warnings.iter().any(|w| w.starts_with("the colour profile \"") && w.ends_with("the document opens without a profile")), "{:?}", r.warnings);
    }
}

#[test]
fn an_opened_document_saves_in_the_new_format_and_opens_again() {
    for name in ["v1-groups", "v3-masks", "v3-deep-u16", "v2-mode-duotone", "v3-selection-channels", "v3-guides-paths", "v3-tags-info"] {
        let first = open(name).document;
        let saved = crate::export(&first, "new.pigment", &crate::ExportOptions::default()).unwrap();
        assert!(!is_legacy(&saved.bytes), "{name}");
        let again = crate::import("new.pigment", &saved.bytes).unwrap().document;
        let strip = |d: &Document| {
            let mut d = d.clone();
            d.id = first.id;
            d.name.clear();
            d
        };
        assert_eq!(strip(&again), strip(&first), "{name}");
    }
}

// ---- layers and data this part of the importer does not convert yet --------------------------

#[test]
fn layers_not_converted_yet_keep_their_place_and_are_reported() {
    let bytes = described(
        r##"[
        {"id":"a","type":"adjustment","name":"Levels 1","kind":"levels","params":{},"opacity":0.5,"blend":"screen","clip":true,"hasMask":false},
        {"id":"f","type":"fill","name":"Colour","paint":{"type":"solid","color":"#ff0000"},"visible":false},
        {"id":"s","type":"shape","name":"Box","path":{"subpaths":[]},"styles":{"dropShadow":[{}]},"vectorMask":{"path":{"subpaths":[]}},"blending":{"knockout":"deep"}},
        {"id":"t","type":"text","name":"Hello","text":"Hello","locked":{"all":true}},
        {"id":"o","type":"smart","name":"Placed"},
        {"id":"x","type":"hologram","name":"From the future","blend":"plus-lighter"},
        {"id":"n","name":"No type"},
        "not a layer",
        {"id":7,"type":"group","blend":"pass-through","children":[{"id":8,"type":"raster","blend":"pass-through","opacity":7,"fillOpacity":-1}]}
    ]"##,
    );
    let r = crate::import("old.pigment", &bytes).unwrap();
    let doc = &r.document;
    assert_eq!(names(&doc.layers), ["Levels 1", "Colour", "Box", "Hello", "Placed", "From the future", "No type", "Layer 8"]);
    for l in &doc.layers[..7] {
        assert!(matches!(&l.content, LayerContent::Raster(s) if s.tile_count() == 0), "{}", l.name);
    }
    let levels = &doc.layers[0];
    assert_eq!((levels.opacity, levels.blend, levels.clipped), (0.5, BlendMode::Screen, true));
    assert!(!doc.layers[1].visible && doc.layers[3].locks.all);
    assert_eq!(doc.layers[5].blend, BlendMode::Normal);
    let group = &doc.layers[7];
    assert_eq!(group.blend, BlendMode::PassThrough);
    // Only groups pass through; opacities stay within 0 to 1.
    let child = &group.children().unwrap()[0];
    assert_eq!((child.name.as_str(), child.blend, child.opacity, child.fill_opacity), ("Layer 9", BlendMode::Normal, 1.0, 0.0));
    assert_eq!(
        r.warnings,
        [
            "an entry of the layer list is not a layer and was skipped",
            "adjustment layers are not converted yet; the layer opens as an empty layer (\"Levels 1\")",
            "fill layers are not converted yet; the layer opens as an empty layer (\"Colour\")",
            "shape layers are not converted yet; the layer opens as an empty layer (\"Box\")",
            "the vector mask is not converted yet and was left out (\"Box\")",
            "the layer styles are not converted yet and were left out (\"Box\")",
            "the advanced blending options are not converted yet; the defaults are used (\"Box\")",
            "text layers are not converted yet; the layer opens as an empty layer (\"Hello\")",
            "smart objects are not converted yet; the layer opens as an empty layer (\"Placed\")",
            "layers of type \"hologram\" are not known; the layer opens as an empty layer (\"From the future\")",
            "the blend mode \"plus-lighter\" is not known; the layer blends as Normal (\"From the future\")",
            "the layer has no type; it opens as an empty layer (\"No type\")",
            "the layer's image is missing from the file; the layer opens empty (\"Layer 9\")",
        ]
    );
}

#[test]
fn a_newer_format_unknown_data_and_missing_pieces_are_reported() {
    let json = r#"{"version":7,"app":"pigment","width":3.4,"height":2,"dpi":-5,"mode":"hsb","depth":12,"name":"Own name",
        "store":{"guides":{"v":1,"data":[{"axis":"x","pos":1},{"axis":"z","pos":1},{"axis":"y","pos":"2"},{"axis":"x","pos":1}]},"comps":{"v":1,"data":[]},"notes":{"v":2,"data":[]}},
        "guides":[{"axis":"y","pos":9}],
        "channels":[{"id":"gone","name":"Lost"},{"id":"short","name":"Short"},{"name":"No id"}],
        "paths":[{"name":"Broken","path":7},{"path":{"subpaths":[]}}],
        "globalLight":{"angle":"north"},
        "layers":[{"id":"m","type":"raster","name":"Masked","hasMask":true}]}"#;
    let bytes =
        zip(&[("document.json", json.as_bytes()), ("channels/short.bin", &[1, 2, 3]), ("selection.bin", &[0; 5]), ("layers/m.png", b"\x89PNG\r\n\x1a\n")]);
    // Without a file name the document takes the name it had.
    let r = crate::import("", &bytes).unwrap();
    let doc = &r.document;
    assert_eq!(doc.name, "Own name");
    assert_eq!((doc.size.width, doc.size.height, doc.resolution_dpi, doc.mode, doc.depth), (3, 2, 72.0, ColorMode::Rgb, SampleType::U8));
    // The store wins over the plain list of older versions; a guide is listed once.
    assert_eq!((doc.guides.vertical.clone(), doc.guides.horizontal.clone()), (vec![1.0], vec![]));
    assert!(doc.channels.is_empty() && doc.selection.is_none());
    assert_eq!(doc.paths.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["Path 1"]);
    assert_eq!(doc.global_light, GlobalLight::default());
    assert!(doc.layers[0].mask.is_none());
    assert_eq!(
        r.warnings,
        [
            "the file was saved by a newer Pigment (document format 7); what Pigment 0.4 wrote was read, the rest was left out",
            "the image mode \"hsb\" is not known; the document opens in RGB",
            "the channel \"Lost\" is missing from the file and was left out",
            "the channel \"Short\" holds 3 bytes where the canvas has 6 pixels and was left out",
            "the selection holds 5 bytes where the canvas has 6 pixels and was left out",
            "document data this version does not know was left out: \"comps\", \"notes\"",
            "the layer's image could not be decoded (Png: malformed data: unexpected end of file); the layer opens empty (\"Masked\")",
            "the layer mask's image is missing from the file; the layer opens without its mask (\"Masked\")",
        ]
    );
}

// ---- files that cannot be read ------------------------------------------------------------------

#[test]
fn a_damaged_document_fails_with_the_typed_error_whatever_its_name() {
    let broken = zip(&[("document.json", br#"{"version":3,"app":"pigment","width":4"#), ("layers/1.png", b"\x89PNG\r\n\x1a\n")]);
    assert!(is_legacy(&broken));
    for name in ["poster.pigment", "poster.PIGMENT", "poster.zip", "poster"] {
        let e = crate::import(name, &broken).err().unwrap();
        assert!(matches!(e, IoError::LegacyPigment(_)), "{name}: {e:?}");
        let message = e.to_string();
        assert!(message.starts_with("This Pigment 0.4 file is damaged: document.json is not valid JSON ("), "{message}");
    }
    // File › Open As Pigment, and preflight, see it too.
    assert!(matches!(crate::import_with_options_as("poster.pigment", &broken, Some("pigment"), &Default::default()), Err(IoError::LegacyPigment(_))));
    assert_eq!(crate::import_preflight("poster.pigment", &broken), crate::ImportPreflight::Unbounded);

    for (json, why) in [
        (r#"[1, 2]"#, "document.json does not hold a document"),
        (r#"{"version":4,"width":4,"height":4,"layers":[{"id":1}]}"#, "document.json does not say it is a Pigment document"),
        (r#"{"app":"sketch","width":4,"height":4}"#, "document.json does not say it is a Pigment document"),
        (r#"{"app":"pigment","height":4}"#, "document.json has no width"),
        (r#"{"app":"pigment","width":4,"height":"tall"}"#, "document.json has no height"),
    ] {
        assert_eq!(damage_of(&zip(&[("document.json", json.as_bytes())])), why, "{json}");
    }
    // Groups nested deeper than any document: the JSON parser's own limit stops the description.
    let deep = format!("{}{}", r#"{"id":"g","type":"group","children":["#.repeat(70), "]}".repeat(70));
    assert!(damage_of(&described(&format!("[{deep}]"))).starts_with("document.json is not valid JSON ("));
    // Sixty levels is a document, if an odd one.
    let sixty = format!("{}{}", r#"{"id":"g","type":"group","children":["#.repeat(60), "]}".repeat(60));
    let r = crate::import("deep.pigment", &described(&format!("[{sixty}]"))).unwrap();
    assert_eq!(r.document.max_group_depth(), 59);
}

#[test]
fn hostile_sizes_are_refused_by_the_limits() {
    let too_large = |bytes: &[u8]| match crate::import("bomb.pigment", bytes) {
        Err(IoError::Unsupported(why)) => {
            assert!(why.starts_with("this Pigment 0.4 document is too large to open: "), "{why}");
            why
        }
        other => panic!("expected a refusal, got {:?}", other.map(|r| r.warnings)),
    };
    // A description that inflates to more than a description can be: refused by its declared size.
    let mut json = br#"{"app":"pigment","width":4,"height":4,"layers":["#.to_vec();
    json.resize(json.len() + (65 << 20), b' ');
    json.extend_from_slice(b"]}");
    let bomb = zip(&[("document.json", &json)]);
    assert!(bomb.len() < 1 << 20, "the archive is {} bytes", bomb.len());
    assert_eq!(damage_of(&bomb), "document.json is larger than 67108864 bytes");
    drop((json, bomb));

    // A canvas and a layer count no document has.
    too_large(&zip(&[("document.json", br#"{"app":"pigment","width":300001,"height":4}"#)]));
    let many = format!("[{}]", vec![r#"{"type":"group"}"#; 8193].join(","));
    assert!(too_large(&described(&many)).ends_with("it has more than 8192 layers"));

    // A PNG that claims 30000 × 30000 pixels in a few bytes: never allocated, the layer opens empty.
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut chunk = |kind: &[u8; 4], data: &[u8]| {
        png.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let mut body = kind.to_vec();
        body.extend_from_slice(data);
        png.extend_from_slice(&body);
        png.extend_from_slice(&crc32fast::hash(&body).to_be_bytes());
    };
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&30_000u32.to_be_bytes());
    ihdr.extend_from_slice(&30_000u32.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    chunk(b"IHDR", &ihdr);
    chunk(b"IDAT", &[0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]);
    chunk(b"IEND", &[]);
    let json =
        br#"{"app":"pigment","width":4,"height":4,"layers":[{"id":"big","type":"raster","name":"Big","hasMask":true}],"channels":[{"id":"c","name":"Huge"}]}"#;
    // A channel that inflates to far more than the canvas has pixels is not inflated at all.
    let huge = vec![0u8; 32 << 20];
    let started = std::time::Instant::now();
    let r =
        crate::import("bomb.pigment", &zip(&[("document.json", json), ("layers/big.png", &png), ("masks/big.png", &png), ("channels/c.bin", &huge)])).unwrap();
    assert!(started.elapsed() < std::time::Duration::from_secs(20));
    assert!(matches!(&r.document.layers[0].content, LayerContent::Raster(s) if s.tile_count() == 0));
    assert!(r.document.layers[0].mask.is_none() && r.document.channels.is_empty());
    assert_eq!(r.warnings.len(), 3, "{:?}", r.warnings);
    assert!(r.warnings[0].starts_with("the channel \"Huge\" holds 33554432 bytes where the canvas has 16 pixels"), "{:?}", r.warnings);
    assert!(r.warnings[1].starts_with("the layer's image could not be decoded ("), "{:?}", r.warnings);
    assert!(r.warnings[2].starts_with("the layer mask's image could not be decoded ("), "{:?}", r.warnings);
}

#[test]
fn truncated_and_bit_flipped_documents_never_panic() {
    // A small xorshift: the same damage on every run.
    let mut state = 0x9e37_79b9_7f4a_7c15u64;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    let mut opened = 0;
    let mut refused = 0;
    let mut tried = 0;
    for entry in std::fs::read_dir(fixture_dir()).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_none_or(|e| e != "pigment") {
            continue;
        }
        let good = std::fs::read(&path).unwrap();
        let mut count = |bytes: &[u8]| {
            tried += 1;
            match crate::import("damaged.pigment", bytes) {
                Ok(_) => opened += 1,
                Err(_) => refused += 1,
            }
        };
        for i in 0..24 {
            count(&good[..good.len() * i / 24]);
            count(&good[..good.len() - 1 - i]);
        }
        for _ in 0..120 {
            let mut bad = good.clone();
            for _ in 0..=(next() % 3) {
                let at = (next() % bad.len() as u64) as usize;
                bad[at] ^= 1 << (next() % 8);
            }
            count(&bad);
        }
        // The description itself, damaged inside an archive that is otherwise whole.
        let mut archive = craft_zip::Archive::open(&good, craft_zip::Limits { max_entries: 1000, max_total_bytes: 1 << 24 }).unwrap();
        let names: Vec<String> = archive.names().map(|n| n.to_string()).collect();
        let entries: Vec<(String, Vec<u8>)> = names.into_iter().map(|n| (n.clone(), archive.read(&n, 1 << 22).unwrap().unwrap())).collect();
        for _ in 0..40 {
            let rebuilt: Vec<(&str, Vec<u8>)> = entries
                .iter()
                .map(|(n, data)| {
                    let mut data = data.clone();
                    if n == "document.json" || next() % 4 == 0 {
                        let at = (next() % data.len() as u64) as usize;
                        match next() % 3 {
                            0 => data[at] = b"0123456789-e.{}[]\":,xn"[(next() % 22) as usize],
                            1 => data.truncate(at),
                            _ => data[at] ^= 1 << (next() % 8),
                        }
                    }
                    (n.as_str(), data)
                })
                .collect();
            let refs: Vec<(&str, &[u8])> = rebuilt.iter().map(|(n, d)| (*n, d.as_slice())).collect();
            count(&zip(&refs));
        }
    }
    assert!(tried > 5000 && opened > 0 && refused > 0, "{tried} tried, {opened} opened, {refused} refused");
}

#[test]
fn pigment_saves_the_native_format_and_opens_it_again() {
    let doc = Document::new("Native", photocraft_geom::Size { width: 4, height: 4 }, ColorMode::Rgb, SampleType::U8);
    let opts = crate::ExportOptions::default();
    let saved = crate::export(&doc, "poster.pigment", &opts).unwrap();
    assert!(!is_legacy(&saved.bytes));
    let opened = crate::import("poster.pigment", &saved.bytes).unwrap();
    assert_eq!((opened.document.size.width, opened.document.size.height), (4, 4));
    // A `.pcraft` still opens.
    let pcraft = crate::export(&doc, "poster.pcraft", &opts).unwrap();
    assert!(crate::import("poster.pcraft", &pcraft.bytes).is_ok());
}
