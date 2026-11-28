//! Pigment (F2, row 29): the Targa variants the `image` crate misreads open through craft-tga
//! (`crates/io/src/tga_more.rs`), as the JavaScript Pigment's reader opened them. Every file is
//! written byte by byte here.

use photocraft_color::ColorMode;
use photocraft_io::*;

/// A Targa header: image type `kind`, a colour map of `map_len` entries of `map_depth` bits
/// from index `map_first` (none when `map_len` is 0), `w`×`h` pixels of `depth` bits and the
/// image descriptor `desc` (attribute bits, 0x20 top-left origin).
#[allow(clippy::too_many_arguments)]
fn header(kind: u8, map_first: u16, map_len: u16, map_depth: u8, w: u16, h: u16, depth: u8, desc: u8) -> Vec<u8> {
    let mut b = vec![0, u8::from(map_len > 0), kind];
    b.extend_from_slice(&map_first.to_le_bytes());
    b.extend_from_slice(&map_len.to_le_bytes());
    b.push(map_depth);
    b.extend_from_slice(&[0, 0, 0, 0]);
    b.extend_from_slice(&w.to_le_bytes());
    b.extend_from_slice(&h.to_le_bytes());
    b.extend_from_slice(&[depth, desc]);
    b
}

/// A 5-5-5 value with the top (attribute) bit `a`.
fn rgb555(r: u16, g: u16, b: u16, a: bool) -> [u8; 2] {
    (u16::from(a) << 15 | r << 10 | g << 5 | b).to_le_bytes()
}

/// A 5-bit component as craft-tga widens it to 8 bits, as a document value.
fn five(c: u8) -> f32 {
    f32::from((c << 3) | (c >> 2)) / 255.0
}

/// The RGB of every pixel of the document's one layer, top row first, and its alpha channel.
fn opened(name: &str, bytes: &[u8]) -> (photocraft_doc::Document, Vec<[f32; 3]>, Option<Vec<f32>>) {
    let d = import(name, bytes).expect("the Targa opens").document;
    assert_eq!(d.mode, ColorMode::Rgb);
    let [layer] = &d.layers[..] else { panic!("one layer, got {}", d.layers.len()) };
    let s = layer.surface().expect("a raster layer");
    let ch = s.format().channels();
    let px = s.read_region(d.bounds());
    let rgb = px.chunks_exact(ch).map(|p| [p[0], p[1], p[2]]).collect();
    let alpha = match &d.channels[..] {
        [] => None,
        [a] => {
            assert_eq!(a.name, "Alpha 1");
            Some(a.surface.read_region(d.bounds()))
        }
        more => panic!("at most one channel, got {}", more.len()),
    };
    (d, rgb, alpha)
}

fn close(a: [f32; 3], b: [f32; 3]) -> bool {
    a.iter().zip(&b).all(|(x, y)| (x - y).abs() < 1e-4)
}

/// 2×2, 16-bit true colour with one attribute bit, bottom-left origin: the file's first row is the
/// picture's bottom row. Top row: red (opaque), green (transparent); bottom: blue (opaque),
/// mid grey (transparent).
fn alpha_555(kind_rle: bool, top_left: bool) -> Vec<u8> {
    let (red, green, blue, grey) = (rgb555(31, 0, 0, true), rgb555(0, 31, 0, false), rgb555(0, 0, 31, true), rgb555(16, 16, 16, false));
    let rows = if top_left { [[red, green], [blue, grey]] } else { [[blue, grey], [red, green]] };
    let mut b = header(if kind_rle { 10 } else { 2 }, 0, 0, 0, 2, 2, 16, 1 | if top_left { 0x20 } else { 0 });
    for row in rows {
        if kind_rle {
            // One raw packet of two pixels a row.
            b.push(1);
        }
        for p in row {
            b.extend_from_slice(&p);
        }
    }
    b
}

#[test]
fn a_16_bit_targa_with_an_alpha_bit_opens_with_alpha_1() {
    for (rle, top_left) in [(false, false), (false, true), (true, false)] {
        let (d, rgb, alpha) = opened("a.tga", &alpha_555(rle, top_left));
        let what = format!("rle {rle}, top-left {top_left}");
        assert_eq!(d.layers[0].name, "Background", "{what}");
        let g = five(16);
        let want = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [g, g, g]];
        for (i, (got, want)) in rgb.iter().zip(want).enumerate() {
            assert!(close(*got, want), "{what}: pixel {i} {got:?}, want {want:?}");
        }
        assert_eq!(alpha.as_deref(), Some(&[1.0, 0.0, 1.0, 0.0][..]), "{what}: the attribute bit is Alpha 1");
    }
}

#[test]
fn a_16_bit_targa_whose_alpha_bits_are_all_set_opens_without_a_channel() {
    let mut b = header(2, 0, 0, 0, 2, 1, 16, 1);
    b.extend_from_slice(&rgb555(31, 31, 31, true));
    b.extend_from_slice(&rgb555(0, 0, 0, true));
    let (_, rgb, alpha) = opened("a.tga", &b);
    assert!(alpha.is_none());
    assert!(close(rgb[0], [1.0; 3]) && close(rgb[1], [0.0; 3]));
    // Without the attribute bit in the descriptor the top bit stays an attribute (the old path).
    let mut b = header(2, 0, 0, 0, 1, 1, 16, 0);
    b.extend_from_slice(&rgb555(31, 0, 0, false));
    let (_, rgb, alpha) = opened("a.tga", &b);
    assert!(alpha.is_none(), "no attribute bit declared: opaque");
    assert!(close(rgb[0], [1.0, 0.0, 0.0]), "{:?}", rgb[0]);
}

/// Type 1 with a 16-bit index into 15-bit entries, which the `image` crate refuses. The map starts
/// at index 300, so the indices really need 16 bits.
#[test]
fn a_colour_map_with_16_bit_indices_into_15_bit_entries_opens() {
    let entries = [rgb555(31, 0, 0, false), rgb555(0, 31, 0, false), rgb555(0, 0, 31, false), rgb555(31, 31, 0, false)];
    for top_left in [false, true] {
        let mut b = header(1, 300, 4, 15, 2, 2, 16, if top_left { 0x20 } else { 0 });
        for e in entries {
            b.extend_from_slice(&e);
        }
        // Stored rows, first row first: indices 300 301 / 302 303.
        for i in [300u16, 301, 302, 303] {
            b.extend_from_slice(&i.to_le_bytes());
        }
        let (_, rgb, alpha) = opened("m.tga", &b);
        assert!(alpha.is_none());
        let (r, g, bl, y) = ([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 1.0, 0.0]);
        let want = if top_left { [r, g, bl, y] } else { [bl, y, r, g] };
        for (i, (got, want)) in rgb.iter().zip(want).enumerate() {
            assert!(close(*got, want), "top-left {top_left}: pixel {i} {got:?}, want {want:?}");
        }
    }
}

/// Type 9: run-length colour-mapped, 8-bit indices into 24-bit entries (the `image` crate's path,
/// checked here beside the others), with a packet that runs over the end of the first row.
#[test]
fn a_run_length_colour_mapped_targa_opens_as_rgb() {
    let mut b = header(9, 0, 3, 24, 3, 2, 8, 0x20);
    for bgr in [[0, 0, 255], [0, 255, 0], [255, 0, 0]] {
        b.extend_from_slice(&bgr);
    }
    // Run of 2 × index 0, raw packet of 3 (indices 1, 2, 2), run of 1 × index 1.
    b.extend_from_slice(&[0x81, 0, 2, 1, 2, 2, 0x80, 1]);
    let (d, rgb, alpha) = opened("r.tga", &b);
    assert!(alpha.is_none());
    assert_eq!((d.size.width, d.size.height), (3, 2));
    let (r, g, bl) = ([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]);
    for (i, (got, want)) in rgb.iter().zip([r, r, g, bl, bl, g]).enumerate() {
        assert!(close(*got, want), "pixel {i} {got:?}, want {want:?}");
    }
}

/// A 24-bit Targa whose descriptor claims 8 attribute bits: the `image` crate refuses it ("more
/// alpha bits than pixel bits"), craft-tga reads the colours, as the JavaScript app did.
#[test]
fn a_targa_the_image_crate_refuses_falls_back_to_craft_tga() {
    let mut b = header(2, 0, 0, 0, 2, 1, 24, 8 | 0x20);
    b.extend_from_slice(&[255, 0, 0, 0, 255, 0]);
    let (_, rgb, alpha) = opened("f.tga", &b);
    assert!(alpha.is_none());
    assert!(close(rgb[0], [0.0, 0.0, 1.0]) && close(rgb[1], [0.0, 1.0, 0.0]), "{rgb:?}");
}

#[test]
fn a_damaged_targa_variant_is_an_error_not_a_panic() {
    let files = [alpha_555(false, false), alpha_555(true, true), {
        let mut b = header(1, 300, 2, 15, 2, 1, 16, 0);
        b.extend_from_slice(&rgb555(1, 2, 3, false));
        b.extend_from_slice(&rgb555(4, 5, 6, false));
        b.extend_from_slice(&[44, 1, 45, 1]);
        b
    }];
    for f in &files {
        assert!(import("a.tga", f).is_ok());
        for n in 18..f.len() {
            assert!(import("a.tga", &f[..n]).is_err(), "a {n}-byte prefix of a {}-byte file", f.len());
        }
    }
    // An index outside the colour map.
    let mut b = header(1, 300, 1, 15, 1, 1, 16, 0);
    b.extend_from_slice(&rgb555(1, 2, 3, false));
    b.extend_from_slice(&7u16.to_le_bytes());
    assert!(import("a.tga", &b).is_err());
}

#[test]
fn the_import_size_limit_holds_for_the_variants() {
    let mut b = header(2, 0, 0, 0, 64, 64, 16, 1);
    for _ in 0..64 * 64 {
        b.extend_from_slice(&rgb555(1, 2, 3, true));
    }
    assert!(import("a.tga", &b).is_ok());
    let tight = ImportOptions { flat_max_pixel_bytes: 1024, ..ImportOptions::default() };
    let err = import_with_options("a.tga", &b, &tight).expect_err("over the limit");
    assert!(matches!(err, IoError::Codec(photocraft_codecs::CodecError::LimitExceeded(_))), "{err:?}");
}
