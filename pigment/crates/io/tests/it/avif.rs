//! Pigment: AVIF opens (rows 27 and 28 of the port, F3). photocraft-io's `avif` feature, on by
//! default, turns on craft-image-codecs' decoder (craft-video's pure-Rust AV1 decoder); these tests
//! open the fixtures of `tests/fixtures/avif/` (their README names the encoder and the commands)
//! through [`import`], the path File › Open takes.

use photocraft_codecs::{CodecError, Format};
use photocraft_doc::{ColorMode, Document, SampleType};
use photocraft_io::{ImportOptions, ImportPreflight, IoError, import, import_preflight, import_with_options};

const QUAD_420: &[u8] = include_bytes!("../fixtures/avif/quad-420-bt709.avif");
const QUAD_420_DAV1D: &[u8] = include_bytes!("../fixtures/avif/quad-420-bt709.dav1d.yuv");
const QUAD_LOSSLESS: &[u8] = include_bytes!("../fixtures/avif/quad-444-gbr-lossless.avif");
const QUAD_SOURCE: &[u8] = include_bytes!("../fixtures/avif/quad-source.rgb");
const ALPHA: &[u8] = include_bytes!("../fixtures/avif/quad-444-alpha-lossless.avif");
const ALPHA_SOURCE: &[u8] = include_bytes!("../fixtures/avif/alpha-source.rgba");
const CARD_10: &[u8] = include_bytes!("../fixtures/avif/card-444-10bit-lossless.avif");
const CARD_10_SOURCE: &[u8] = include_bytes!("../fixtures/avif/card-source.gbrp10le");
const GRID: &[u8] = include_bytes!("../fixtures/avif/grid-2x2.avif");
const IROT_XMP: &[u8] = include_bytes!("../fixtures/avif/irot-90-xmp.avif");
const HUGE_ISPE: &[u8] = include_bytes!("../fixtures/avif/huge-ispe.avif");

const W: usize = 33;
const H: usize = 17;

fn open(name: &str, bytes: &[u8]) -> Document {
    import(name, bytes).unwrap_or_else(|e| panic!("{name}: {e}")).document
}

/// The pixel at (x, y) of the document's one layer, each channel on its 0..=`max` scale.
fn px(d: &Document, x: usize, y: usize, max: f32) -> Vec<f32> {
    let [layer] = &d.layers[..] else { panic!("{} layers", d.layers.len()) };
    layer.surface().expect("a raster layer").pixel(x as i32, y as i32).into_iter().map(|v| v * max).collect()
}

/// Asserts every colour channel of the document is within `tol` (0..255) of `want(x, y)`.
fn assert_rgb8(d: &Document, want: impl Fn(usize, usize) -> [u8; 3], tol: f32, what: &str) {
    for y in 0..d.size.height as usize {
        for x in 0..d.size.width as usize {
            let got = px(d, x, y, 255.0);
            let want = want(x, y);
            for c in 0..3 {
                assert!((got[c] - f32::from(want[c])).abs() <= tol, "{what} ({x}, {y}): {:?} vs {want:?}", &got[..3]);
            }
        }
    }
}

fn source(x: usize, y: usize) -> [u8; 3] {
    let i = (y * W + x) * 3;
    [QUAD_SOURCE[i], QUAD_SOURCE[i + 1], QUAD_SOURCE[i + 2]]
}

/// RGB from libdav1d's planes of `quad-420-bt709.avif`: BT.709 limited range (ITU-T H.273 matrix 1),
/// chroma upsampled bilinearly from sites centred between their luma pairs (libavif's 3:1 filter).
fn dav1d_rgb(x: usize, y: usize) -> [u8; 3] {
    let (cw, ch) = (W.div_ceil(2), H.div_ceil(2));
    let (yp, cb, cr) = (&QUAD_420_DAV1D[..W * H], &QUAD_420_DAV1D[W * H..][..cw * ch], &QUAD_420_DAV1D[W * H + cw * ch..][..cw * ch]);
    let site = |v: usize, n: usize| {
        let f = ((v as f32 + 0.5) / 2.0 - 0.5).max(0.0);
        let i = f as usize;
        (i.min(n - 1), (i + 1).min(n - 1), f - i as f32)
    };
    let ((x0, x1, fx), (y0, y1, fy)) = (site(x, cw), site(y, ch));
    let at = |p: &[u8], xx: usize, yy: usize| f32::from(p[yy * cw + xx]);
    let chroma = |p: &[u8]| (at(p, x0, y0) * (1.0 - fx) + at(p, x1, y0) * fx) * (1.0 - fy) + (at(p, x0, y1) * (1.0 - fx) + at(p, x1, y1) * fx) * fy;
    let (kr, kb) = (0.2126f32, 0.0722f32);
    let luma = (f32::from(yp[y * W + x]) - 16.0) / 219.0;
    let (b_, r_) = ((chroma(cb) - 128.0) / 224.0, (chroma(cr) - 128.0) / 224.0);
    let r = luma + 2.0 * (1.0 - kr) * r_;
    let b = luma + 2.0 * (1.0 - kb) * b_;
    let g = (luma - kr * r - kb * b) / (1.0 - kr - kb);
    [r, g, b].map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8)
}

#[test]
fn an_8_bit_420_avif_opens_with_libdav1d_s_pixels() {
    let d = open("photo.avif", QUAD_420);
    assert_eq!((d.size.width, d.size.height), (33, 17));
    assert_eq!((d.mode, d.depth), (ColorMode::Rgb, SampleType::U8));
    assert_eq!(d.layers[0].name, "Background", "an opaque AVIF opens as a Background");
    // BT.709 SDR stays untagged (read as sRGB), as for HEIF.
    assert!(d.icc_profile.is_none());
    assert_rgb8(&d, dav1d_rgb, 1.0, "4:2:0 against libdav1d");
}

#[test]
fn a_lossless_444_avif_opens_exactly() {
    let d = open("photo.AVIF", QUAD_LOSSLESS);
    assert_eq!((d.size.width, d.size.height, d.depth), (33, 17, SampleType::U8));
    assert_rgb8(&d, source, 0.0, "lossless GBR");
}

#[test]
fn a_10_bit_avif_opens_as_a_16_bit_document() {
    let d = open("card.avif", CARD_10);
    assert_eq!((d.size.width, d.size.height), (33, 17));
    assert_eq!((d.mode, d.depth), (ColorMode::Rgb, SampleType::U16));
    // The source is planar G, B, R; each 10-bit level v is v / 1023 of the 16-bit range.
    let plane = |p: usize, x: usize, y: usize| {
        let i = 2 * (p * W * H + y * W + x);
        f32::from(u16::from_le_bytes([CARD_10_SOURCE[i], CARD_10_SOURCE[i + 1]]))
    };
    for y in 0..H {
        for x in 0..W {
            let got = px(&d, x, y, 65535.0);
            let want = [plane(2, x, y), plane(0, x, y), plane(1, x, y)].map(|v| v / 1023.0 * 65535.0);
            for c in 0..3 {
                assert!((got[c] - want[c]).abs() <= 1.0, "({x}, {y}): {:?} vs {want:?}", &got[..3]);
            }
        }
    }
}

#[test]
fn an_avif_with_alpha_opens_with_its_transparency() {
    let d = open("cutout.avif", ALPHA);
    assert_eq!((d.size.width, d.size.height, d.depth), (33, 17, SampleType::U8));
    let layer = &d.layers[0];
    assert_eq!(layer.name, "Layer 0", "a transparent AVIF opens as an unlocked layer");
    assert!(!layer.locks.transparency);
    for y in 0..H {
        for x in 0..W {
            let i = (y * W + x) * 4;
            let got = px(&d, x, y, 255.0);
            let alpha = f32::from(ALPHA_SOURCE[i + 3]);
            assert!((got[3] - alpha).abs() <= 0.0, "alpha ({x}, {y}): {} vs {alpha}", got[3]);
            if alpha > 0.0 {
                for c in 0..3 {
                    assert!((got[c] - f32::from(ALPHA_SOURCE[i + c])).abs() <= 0.0, "colour ({x}, {y}): {:?}", &got[..3]);
                }
            }
        }
    }
    assert_eq!(px(&d, 32, 1, 255.0)[3], 0.0, "the right column is clear");
}

#[test]
fn a_grid_avif_opens_as_one_image_of_its_tiles() {
    let d = open("grid.avif", GRID);
    assert_eq!((d.size.width, d.size.height), (64, 32), "the grid's size, which crops the 66 × 34 of the tiles");
    // Tile k is the quadrants with their channels permuted, in rows: 0 1 / 2 3.
    let perms = [[0, 1, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    assert_rgb8(
        &d,
        |x, y| {
            let s = source(x % W, y % H);
            perms[(y / H) * 2 + x / W].map(|c| s[c])
        },
        0.0,
        "grid",
    );
}

#[test]
fn irot_is_applied_and_the_xmp_item_reaches_the_document() {
    let d = open("turned.avif", IROT_XMP);
    assert_eq!((d.size.width, d.size.height), (17, 33), "turned a quarter");
    // 90° anticlockwise: the stored (sx, sy) shows at (sy, 32 - sx).
    assert_rgb8(&d, |x, y| source(W - 1 - y, x), 0.0, "irot 1");
    let xmp = d.metadata.xmp.as_deref().expect("the XMP item");
    assert!(xmp.contains("Pigment AVIF fixture"), "{xmp}");
}

#[test]
fn an_oversized_ispe_is_refused_before_decoding() {
    let err = import("huge.avif", HUGE_ISPE).map(|_| ()).unwrap_err();
    assert!(matches!(err, IoError::Codec(CodecError::LimitExceeded(_))), "{err}");
    // The import's own allowance bounds the decoded pixels too: 33 × 17 at 16-bit RGB (the decoder's
    // intermediate) does not fit in 1 KB.
    let tight = ImportOptions { flat_max_pixel_bytes: 1024, ..ImportOptions::default() };
    let err = import_with_options("photo.avif", QUAD_420, &tight).map(|_| ()).unwrap_err();
    assert!(matches!(err, IoError::Codec(CodecError::LimitExceeded(_))), "{err}");
    assert!(import_with_options("photo.avif", QUAD_420, &ImportOptions::default()).is_ok());
    // The preflight counts an AVIF as a flat raster, and its header gives the size.
    assert_eq!(import_preflight("photo.avif", QUAD_420), ImportPreflight::Flat);
    assert_eq!(photocraft_codecs::probe_size(GRID).unwrap(), (64, 32));
}

#[test]
fn every_truncated_avif_is_an_error_not_a_panic() {
    for (name, file) in [("quad-420", QUAD_420), ("alpha", ALPHA), ("grid", GRID), ("irot", IROT_XMP)] {
        for n in 0..file.len() {
            assert!(import("cut.avif", &file[..n]).is_err(), "{name} cut at {n} of {}", file.len());
        }
    }
}

#[test]
fn avif_is_detected_by_its_contents_and_stays_read_only() {
    assert!(Format::Avif.caps().read, "the avif feature turns the decoder on");
    // Named otherwise, the brand still says AVIF.
    let d = open("photo.png", QUAD_LOSSLESS);
    assert_eq!((d.size.width, d.size.height), (33, 17));
    // Pigment does not write AVIF (neither did the JavaScript app).
    let err = photocraft_io::export(&d, "photo.avif", &photocraft_io::ExportOptions::default());
    assert!(err.is_err());
}
