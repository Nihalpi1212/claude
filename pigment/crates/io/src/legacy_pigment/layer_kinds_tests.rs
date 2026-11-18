//! Adjustment, fill and shape layers, vector masks, layer styles and advanced blending, against
//! documents the JavaScript Pigment's own writer wrote (`tests/fixtures/pigment-0.4/`, made by
//! `make-fixtures-layers.mjs`). Next to each document is `<name>.png`, the picture the app's own
//! compositor made of it; the picture of the opened document is compared with it.

use photocraft_color::{BlendMode, ColorMode, PixelFormat, SampleType};
use photocraft_doc::adjust::ToneSpace;
use photocraft_doc::effects::{BevelStyle, BevelTechnique, Contour, Effect, FxPaint, GlowSource, GlowTechnique, GradientStyle, StrokePosition};
use photocraft_doc::vector::{LineCap, LineJoin, LiveShape, PathOp, StrokeAlign};
use photocraft_doc::{Adjustment, Fill, Knockout, Layer, LayerContent};

use super::container::{Rgba8, decode_png};
use crate::ImportResult;

fn fixture_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pigment-0.4")
}

fn open(name: &str) -> ImportResult {
    let path = fixture_dir().join(format!("{name}.pigment"));
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    crate::import(&format!("{name}.pigment"), &bytes).unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn layer<'a>(layers: &'a [Layer], name: &str) -> &'a Layer {
    fn find<'a>(layers: &'a [Layer], name: &str) -> Option<&'a Layer> {
        layers.iter().find_map(|l| if l.name == name { Some(l) } else { l.children().and_then(|c| find(c, name)) })
    }
    find(layers, name).unwrap_or_else(|| panic!("no layer \"{name}\""))
}

/// The JavaScript app's picture of the fixture.
fn js_picture(name: &str) -> Rgba8 {
    let bytes = std::fs::read(fixture_dir().join(format!("{name}.png"))).unwrap();
    decode_png(&bytes, 1 << 26).unwrap()
}

/// How far the opened document's picture is from the app's: the largest difference of any
/// channel of any pixel, and the mean difference, both in 8-bit levels.
fn difference(name: &str) -> (u8, f64) {
    let doc = open(name).document;
    let ours = photocraft_compose::flatten_to_surface(&doc, PixelFormat::new(ColorMode::Rgb, SampleType::U8, true), None);
    let js = js_picture(name);
    assert_eq!((js.width, js.height), (doc.size.width, doc.size.height), "{name}");
    let (mut max, mut sum) = (0u8, 0u64);
    for y in 0..js.height as i32 {
        for x in 0..js.width as i32 {
            let p = ours.pixel(x, y);
            for c in 0..4 {
                let a = (p.get(c).copied().unwrap_or(0.0) * 255.0).round() as u8;
                let b = js.data[(y as usize * js.width as usize + x as usize) * 4 + c];
                max = max.max(a.abs_diff(b));
                sum += u64::from(a.abs_diff(b));
            }
        }
    }
    (max, sum as f64 / f64::from(js.width * js.height * 4))
}

/// Every fixture that has the app's picture next to it.
fn pictured() -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(fixture_dir())
        .unwrap()
        .filter_map(|e| {
            let p = e.ok()?.path();
            (p.extension()? == "png").then(|| p.file_stem()?.to_str().map(str::to_string))?
        })
        .collect();
    names.sort();
    names
}

/// Where PhotoCraft draws a fixture differently from the app by design: (fixture, largest
/// difference of one channel, mean difference) in 8-bit levels. Every other fixture is drawn
/// within 3 levels everywhere and 0.5 on average.
const DIFFERENT_BY_DESIGN: &[(&str, u8, f64)] = &[
    // Pigment approximated these adjustments its own way, PhotoCraft evaluates Photoshop's: Brightness/Contrast's
    // curves, Photo Filter in linear light, Colorize at the HSL lightness, Color Balance with luminosity, Vibrance,
    // Selective Color, Exposure's tone curve, the CMYK and Lab conversions, the B&W tint as a Color blend, the Curves
    // spline, Hue/Saturation's range fall-off. The method differs, not the settings (each has its own field test).
    ("v2-adjust-black-white-tint", 52, 13.50),
    ("v2-adjust-brightness-contrast", 49, 22.25),
    ("v2-adjust-brightness-contrast-legacy", 25, 4.75),
    ("v2-adjust-color-balance", 44, 11.50),
    ("v2-adjust-curves", 12, 1.25),
    ("v2-adjust-exposure", 29, 2.25),
    ("v2-adjust-hue-saturation", 36, 4.75),
    ("v2-adjust-hue-saturation-colorize", 141, 12.75),
    ("v2-adjust-hue-saturation-one-range", 56, 1.25),
    ("v2-adjust-photo-filter", 100, 12.50),
    ("v2-adjust-photo-filter-no-luminosity", 107, 11.25),
    ("v2-adjust-selective-color", 41, 5.50),
    ("v2-adjust-vibrance", 87, 5.75),
    ("v3-adjust-black-white-tint", 52, 13.50),
    ("v3-adjust-brightness-contrast", 49, 22.25),
    ("v3-adjust-brightness-contrast-legacy", 25, 4.75),
    ("v3-adjust-color-balance", 44, 11.50),
    ("v3-adjust-curves", 12, 1.25),
    ("v3-adjust-curves-lab", 33, 2.00),
    ("v3-adjust-exposure", 29, 2.25),
    ("v3-adjust-hue-saturation", 36, 4.75),
    ("v3-adjust-hue-saturation-colorize", 141, 12.75),
    ("v3-adjust-hue-saturation-one-range", 56, 1.25),
    ("v3-adjust-hue-saturation-ranges", 60, 2.75),
    ("v3-adjust-levels-cmyk", 110, 12.75),
    ("v3-adjust-photo-filter", 100, 12.50),
    ("v3-adjust-photo-filter-no-luminosity", 107, 11.25),
    ("v3-adjust-selective-color", 41, 5.50),
    ("v3-adjust-vibrance", 87, 5.75),
    // Kinds PhotoCraft does not have yet: the layer changes nothing, the app's picture is the adjusted one.
    ("v3-adjust-clarity-dehaze", 34, 10.50),
    ("v3-adjust-color-vibrance", 41, 5.00),
    ("v3-adjust-grain", 23, 3.75),
    // Pigment 0.3 drew an adjustment layer's blend mode as Normal; 0.4 and PhotoCraft draw Luminosity.
    ("v2-adjust-masked", 136, 14.00),
    // Gradients: PhotoCraft samples a linear gradient half a pixel earlier and puts its ends on whole pixels
    // (fitted to Photoshop), so steep ramps (noise, stripes, short gradients) differ along their edges.
    ("v2-fill-gradient-linear", 24, 7.25),
    ("v2-fill-gradient-plain", 12, 3.00),
    ("v2-fill-gradient-reflected", 41, 10.25),
    ("v2-shape-gradient-fill", 36, 3.50),
    ("v3-fill-gradient-linear", 24, 7.25),
    ("v3-fill-gradient-noise", 53, 16.50),
    ("v3-fill-gradient-plain", 12, 3.00),
    ("v3-fill-gradient-reflected", 41, 10.25),
    ("v3-fill-gradient-v2", 54, 5.00),
    ("v3-fill-gradient-v2-linear", 106, 4.50),
    ("v3-fill-gradient-v2-perceptual", 47, 4.25),
    ("v3-fill-gradient-v2-smooth", 52, 4.25),
    ("v3-fill-gradient-v2-stripes", 232, 5.00),
    ("v3-fill-pattern-placed", 26, 5.75),
    ("v3-shape-gradient-fill", 19, 2.75),
    // Shapes and vector masks: anti-aliasing along the outline, round joins and caps, and the vector mask feather.
    ("v2-shape-open-curve", 89, 1.25),
    ("v3-shape-custom", 28, 0.50),
    ("v3-shape-ellipse", 27, 0.75),
    ("v3-shape-line", 30, 0.75),
    ("v3-shape-line-arrow", 14, 0.50),
    ("v3-shape-open-curve", 89, 1.25),
    ("v3-shape-polygon", 12, 0.50),
    ("v3-shape-rect", 25, 0.50),
    ("v3-shape-rect-turned", 22, 0.50),
    ("v3-shape-star", 28, 0.50),
    ("v3-shape-star-smooth", 34, 0.50),
    ("v3-shape-stroke-options", 59, 1.00),
    ("v3-shape-triangle", 29, 0.50),
    ("v3-vector-masks", 45, 3.00),
    // Layer styles: Pigment approximated each effect (blur radii, bevel lighting, glow fall-off, contours) and drew
    // the Angle gradient's seam on another pixel; the effect, its colour, blend mode and placement match.
    ("v2-style-bevel-emboss", 160, 8.25),
    ("v2-style-bevel-inner-bevel", 83, 3.50),
    ("v2-style-bevel-outer-bevel", 166, 11.50),
    ("v2-style-bevel-pillow-emboss", 168, 10.00),
    ("v2-style-drop-shadow", 34, 2.00),
    ("v2-style-gradient-overlay", 52, 2.25),
    ("v2-style-gradient-overlay-angle", 255, 1.25),
    ("v2-style-inner-glow", 82, 3.50),
    ("v2-style-inner-glow-center", 65, 4.25),
    ("v2-style-inner-shadow", 104, 2.25),
    ("v2-style-outer-glow", 113, 5.25),
    ("v2-style-satin", 13, 0.75),
    ("v2-style-several", 113, 6.50),
    ("v2-style-stroke-center", 103, 4.50),
    ("v2-style-stroke-inside", 76, 3.50),
    ("v2-style-stroke-outside", 118, 3.25),
    ("v3-style-bevel-emboss", 160, 7.75),
    ("v3-style-bevel-inner-bevel", 83, 3.50),
    ("v3-style-bevel-options", 199, 15.25),
    ("v3-style-bevel-outer-bevel", 166, 10.25),
    ("v3-style-bevel-pillow-emboss", 168, 9.50),
    ("v3-style-drop-shadow", 34, 2.00),
    ("v3-style-gradient-overlay", 52, 2.25),
    ("v3-style-gradient-overlay-angle", 255, 1.25),
    ("v3-style-gradient-overlay-v2", 52, 2.25),
    ("v3-style-group-shape", 25, 1.25),
    ("v3-style-inner-glow", 82, 3.50),
    ("v3-style-inner-glow-center", 65, 4.25),
    ("v3-style-inner-shadow", 104, 2.25),
    ("v3-style-outer-glow", 113, 5.25),
    ("v3-style-outer-glow-gradient", 135, 8.50),
    ("v3-style-outer-glow-precise", 80, 10.00),
    ("v3-style-satin", 13, 0.75),
    ("v3-style-satin-contour", 132, 9.50),
    ("v3-style-several", 118, 8.00),
    ("v3-style-shadow-options", 103, 6.00),
    ("v3-style-stroke-center", 103, 4.50),
    ("v3-style-stroke-gradient", 140, 3.25),
    ("v3-style-stroke-inside", 76, 3.50),
    ("v3-style-stroke-outside", 118, 3.25),
    ("v3-style-stroke-pattern", 127, 3.25),
    ("v3-style-strokes", 162, 5.50),
];

#[test]
fn every_fixture_draws_as_the_app_drew_it() {
    let names = pictured();
    assert!(names.len() > 150, "{} pictures", names.len());
    let mut failures = Vec::new();
    for name in &names {
        let (max, mean) = difference(name);
        let (bound_max, bound_mean) = DIFFERENT_BY_DESIGN.iter().find(|(n, ..)| n == name).map_or((3, 0.5), |(_, m, a)| (*m, *a));
        if max > bound_max || mean > bound_mean {
            failures.push(format!("{name}: max {max} (at most {bound_max}), mean {mean:.3} (at most {bound_mean})"));
        }
    }
    for (name, ..) in DIFFERENT_BY_DESIGN {
        assert!(names.contains(&name.to_string()), "{name} has no picture");
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

fn adjustment(name: &str) -> (Adjustment, Vec<String>) {
    let r = open(name);
    let l = layer(&r.document.layers, "Adjustment");
    match &l.content {
        LayerContent::Adjustment(a) => (a.clone(), r.warnings),
        other => panic!("{name}: {}", other.kind_name()),
    }
}

#[test]
fn tonal_adjustment_layers_keep_their_settings() {
    for v in ["v2", "v3"] {
        let (a, w) = adjustment(&format!("{v}-adjust-brightness-contrast-legacy"));
        assert_eq!((a, w.len()), (Adjustment::BrightnessContrast { brightness: -25.0, contrast: 35.0, legacy: true }, 0));
        let Adjustment::Levels { master, per_channel, space, .. } = adjustment(&format!("{v}-adjust-levels")).0 else { panic!() };
        assert_eq!(
            (master.in_black * 255.0, master.in_white * 255.0, master.gamma, master.out_black * 255.0, master.out_white * 255.0),
            (20.0, 230.0, 1.4, 10.0, 240.0)
        );
        assert_eq!((per_channel[0].gamma, per_channel[1].clone(), per_channel[2].in_white * 255.0, space), (0.8, Default::default(), 200.0, ToneSpace::Rgb));
        let Adjustment::Levels { per_channel, .. } = adjustment(&format!("{v}-adjust-levels-composite-only")).0 else { panic!() };
        assert_eq!(per_channel[0], Default::default(), "0.3's perChannel: false");
        let Adjustment::Curves { master, per_channel, pencil: false, .. } = adjustment(&format!("{v}-adjust-curves")).0 else { panic!() };
        assert_eq!(master.iter().map(|p| (p.input * 255.0, p.output * 255.0)).collect::<Vec<_>>(), [(0.0, 0.0), (64.0, 40.0), (192.0, 220.0), (255.0, 255.0)]);
        assert_eq!((per_channel[0][0].output * 255.0, per_channel[1].len(), per_channel[2][1].output * 255.0), (20.0, 2, 90.0));
        assert_eq!(adjustment(&format!("{v}-adjust-exposure")).0, Adjustment::Exposure { exposure: 0.8, offset: -0.05, gamma: 1.2 });
        assert_eq!(adjustment(&format!("{v}-adjust-vibrance")).0, Adjustment::Vibrance { vibrance: 60.0, saturation: -20.0 });
    }
}

#[test]
fn colour_adjustment_layers_keep_their_settings() {
    for v in ["v2", "v3"] {
        let Adjustment::HueSaturation { hue: 40.0, saturation: 20.0, lightness: -10.0, colorize: false, ranges } =
            adjustment(&format!("{v}-adjust-hue-saturation")).0
        else {
            panic!()
        };
        assert!(ranges.iter().all(|r| r.is_neutral()));
        assert!(matches!(
            adjustment(&format!("{v}-adjust-hue-saturation-colorize")).0,
            Adjustment::HueSaturation { hue: 210.0, saturation: 50.0, lightness: -10.0, colorize: true, .. }
        ));
        let Adjustment::HueSaturation { hue, ranges, .. } = adjustment(&format!("{v}-adjust-hue-saturation-one-range")).0 else { panic!() };
        assert_eq!((hue, ranges[2].hue, ranges[2].saturation, ranges[2].bounds), (0.0, -60.0, 30.0, [75.0, 105.0, 135.0, 165.0]));
        assert_eq!(
            adjustment(&format!("{v}-adjust-color-balance")).0,
            Adjustment::ColorBalance { shadows: [20.0, -10.0, 5.0], midtones: [-30.0, 0.0, 40.0], highlights: [0.0, 15.0, -25.0], preserve_luminosity: true }
        );
        assert!(matches!(adjustment(&format!("{v}-adjust-color-balance-no-luminosity")).0, Adjustment::ColorBalance { preserve_luminosity: false, .. }));
        assert_eq!(adjustment(&format!("{v}-adjust-black-white")).0, Adjustment::BlackWhite { weights: [80.0, 10.0, 120.0, -50.0, 200.0, 30.0], tint: None });
        assert!(matches!(adjustment(&format!("{v}-adjust-black-white-tint")).0, Adjustment::BlackWhite { tint: Some(_), .. }));
        let Adjustment::PhotoFilter { color, density, preserve_luminosity: true } = adjustment(&format!("{v}-adjust-photo-filter")).0 else { panic!() };
        assert_eq!((color.map(|c| (c * 255.0).round()), density), ([0.0, 160.0, 255.0], 0.6));
        let Adjustment::ChannelMixer { matrix, monochrome: false } = adjustment(&format!("{v}-adjust-channel-mixer")).0 else { panic!() };
        assert_eq!(matrix, [[0.8, 0.3, -0.1, 0.05], [0.0, 1.1, 0.0, -0.04], [0.2, 0.2, 0.6, 0.0]]);
        let Adjustment::ChannelMixer { matrix, monochrome: true } = adjustment(&format!("{v}-adjust-channel-mixer-monochrome")).0 else { panic!() };
        assert_eq!(matrix[0], [0.3, 0.6, 0.1, -0.05]);
    }
}

#[test]
fn other_adjustment_layers_keep_their_settings() {
    for v in ["v2", "v3"] {
        assert_eq!(adjustment(&format!("{v}-adjust-invert")).0, Adjustment::Invert);
        assert_eq!(adjustment(&format!("{v}-adjust-posterize")).0, Adjustment::Posterize { levels: 5 });
        assert_eq!(adjustment(&format!("{v}-adjust-threshold")).0, Adjustment::Threshold { level: 100.0 / 255.0 });
        let Adjustment::GradientMap { stops, reverse: true, .. } = adjustment(&format!("{v}-adjust-gradient-map-reverse")).0 else { panic!() };
        assert_eq!(stops, [(0.0, [0.0, 0.0, 0.0]), (1.0, [0.0, 1.0, 128.0 / 255.0])]);
        let Adjustment::SelectiveColor { relative: false, adjustments } = adjustment(&format!("{v}-adjust-selective-color")).0 else { panic!() };
        assert_eq!((adjustments[0], adjustments[8]), ([-50.0, 20.0, 0.0, 10.0], [0.0, 0.0, 0.0, 15.0]));
        assert!(matches!(adjustment(&format!("{v}-adjust-selective-color-relative")).0, Adjustment::SelectiveColor { relative: true, .. }));
        // The layer's own properties and its mask.
        let r = open(&format!("{v}-adjust-masked"));
        let l = layer(&r.document.layers, "Adjustment");
        assert_eq!((l.opacity, l.blend, l.mask.as_ref().map(|m| m.surface.pixel(3, 3)[0])), (0.5, BlendMode::Luminosity, Some(1.0)));
        assert_eq!(l.mask.as_ref().map(|m| m.surface.pixel(20, 3)[0]), Some(0.0));
    }
}

#[test]
fn adjustments_pigment_0_4_added() {
    let Adjustment::Curves { master, per_channel, pencil: true, .. } = adjustment("v3-adjust-curves-pencil").0 else { panic!() };
    assert_eq!((master.len(), (master[100].output * 255.0).round(), (master[200].output * 255.0).round()), (256, 150.0, 237.0));
    assert_eq!((per_channel[1][100].output * 255.0).round(), 160.0);
    let Adjustment::HueSaturation { hue, ranges, .. } = adjustment("v3-adjust-hue-saturation-ranges").0 else { panic!() };
    assert_eq!(
        (hue, ranges[0].hue, ranges[0].bounds, ranges[4].saturation, ranges[4].bounds),
        (10.0, -60.0, [-45.0, -15.0, 15.0, 45.0], -80.0, [200.0, 230.0, 260.0, 290.0])
    );
    let Adjustment::GradientMap { source: Some(src), .. } = adjustment("v3-adjust-gradient-map-v2").0 else { panic!() };
    assert_eq!((src.method.as_str(), src.smoothness, src.midpoints.as_slice()), ("perceptual", 1.0, [0.3f32, 0.5].as_slice()));
    let (Adjustment::ColorLookup { name, lut: Some(_), size: 33, .. }, w) = adjustment("v3-adjust-color-lookup-preset") else { panic!() };
    assert_eq!((name.as_str(), w.len()), ("Teal Orange", 0));
    let Adjustment::ColorLookup { name, size: 5, .. } = adjustment("v3-adjust-color-lookup-table").0 else { panic!() };
    assert_eq!(name, "Swapped");
    let Adjustment::Levels { space: ToneSpace::Rgb, master, .. } = adjustment("v3-adjust-levels-gray").0 else { panic!() };
    assert_eq!((master.in_black * 255.0, master.gamma), (30.0, 1.3));
    let Adjustment::Levels { space: ToneSpace::Cmyk, per_channel, black, .. } = adjustment("v3-adjust-levels-cmyk").0 else { panic!() };
    assert_eq!((per_channel[0].gamma, black.in_black * 255.0), (1.5, 20.0));
    let Adjustment::Curves { space: ToneSpace::Lab, per_channel, black, .. } = adjustment("v3-adjust-curves-lab").0 else { panic!() };
    assert_eq!((per_channel[0].len(), per_channel[1].len(), per_channel[2][0].output * 255.0, black.len()), (3, 2, 30.0, 0));
    for (kind, what) in [("color-vibrance", "Color and Vibrance"), ("clarity-dehaze", "Clarity and Dehaze"), ("grain", "Grain")] {
        let (a, w) = adjustment(&format!("v3-adjust-{kind}"));
        let Adjustment::Unsupported { psd_key, raw } = a else { panic!() };
        let kept: serde_json::Value = serde_json::from_slice(&raw).unwrap();
        assert_eq!((psd_key.as_str(), kept["kind"].as_str()), ("pcJS", Some(kind)));
        assert_eq!(w, [format!("{what} adjustments are not in Pigment yet; the layer keeps its settings and changes nothing (\"Adjustment\")")]);
    }
}

fn fill(name: &str) -> Fill {
    let r = open(name);
    assert_eq!(r.warnings, Vec::<String>::new(), "{name}");
    match &layer(&r.document.layers, "Fill").content {
        LayerContent::Fill(f) => f.clone(),
        other => panic!("{name}: {}", other.kind_name()),
    }
}

#[test]
fn fill_layers() {
    for v in ["v2", "v3"] {
        let r = open(&format!("{v}-fill-solid"));
        let l = layer(&r.document.layers, "Fill");
        assert_eq!((&l.content, l.opacity), (&LayerContent::Fill(Fill::Solid(photocraft_color::Color::rgb(0.2, 0.4, 0.8))), 0.75));
        // From (4, 4) to (28, 20) on 32 × 24: the angle, the length over the canvas's chord along
        // it (32 / cos 33.69° = 38.46), the centre.
        let Fill::Gradient { style: GradientStyle::Linear, angle, scale, offset, stops, align: false, .. } = fill(&format!("{v}-fill-gradient-linear")) else {
            panic!()
        };
        assert!((angle - (-33.69)).abs() < 0.01 && (offset.0, offset.1) == (0.0, 0.0), "{angle} {offset:?}");
        assert!((scale - 28.844 / 38.459).abs() < 1e-3, "{scale}");
        assert_eq!(stops.iter().map(|s| s.0).collect::<Vec<_>>(), [0.0, 0.4, 1.0]);
        for (kind, style) in
            [("radial", GradientStyle::Radial), ("angle", GradientStyle::Angle), ("reflected", GradientStyle::Reflected), ("diamond", GradientStyle::Diamond)]
        {
            let Fill::Gradient { style: s, .. } = fill(&format!("{v}-fill-gradient-{kind}")) else { panic!() };
            assert_eq!(s, style);
        }
        let Fill::Gradient { opacity_stops, .. } = fill(&format!("{v}-fill-gradient-plain")) else { panic!() };
        assert_eq!(opacity_stops, [(0.0, 0.0), (1.0, 1.0)]);
        let Fill::Pattern { scale, link: false, phase, .. } = fill(&format!("{v}-fill-pattern")) else { panic!() };
        assert_eq!((scale, phase), (2.0, (0.0, 0.0)));
        let doc = open(&format!("{v}-fill-pattern")).document;
        assert_eq!((doc.patterns.len(), doc.patterns[0].width, doc.patterns[0].height), (1, 4, 4));
    }
    let Fill::Pattern { name, scale, angle, link: true, phase, .. } = fill("v3-fill-pattern-placed") else { panic!() };
    assert_eq!((name.as_str(), scale, angle, phase), ("Quarters", 1.5, 0.0, (1.0, 2.0)));
    let Fill::Pattern { angle, link: false, .. } = fill("v3-fill-pattern-turned") else { panic!() };
    assert_eq!(angle, 90.0);
    // A gradient Pigment drew in a way PhotoCraft does not: sampled into stops.
    let Fill::Gradient { stops, opacity_stops, .. } = fill("v3-fill-gradient-v2-perceptual") else { panic!() };
    assert!(stops.len() > 100 && opacity_stops.len() == stops.len());
    let Fill::Gradient { stops, opacity_stops, .. } = fill("v3-fill-gradient-v2") else { panic!() };
    assert!(stops.len() > 100 && opacity_stops.iter().any(|s| (s.1 - 0.4).abs() < 1e-3));
    assert!(matches!(fill("v3-fill-gradient-noise"), Fill::Gradient { .. }));
}

fn shape_of<'a>(doc: &'a photocraft_doc::Document, name: &str) -> &'a photocraft_doc::vector::ShapeLayer {
    match &layer(&doc.layers, name).content {
        LayerContent::Shape(s) => s,
        other => panic!("{name}: {}", other.kind_name()),
    }
}

#[test]
fn shape_layers() {
    for v in ["v2", "v3"] {
        let doc = open(&format!("{v}-shape-path-subtract")).document;
        let s = shape_of(&doc, "Shape");
        assert_eq!(s.path.subpaths.iter().map(|p| p.op).collect::<Vec<_>>(), [PathOp::Combine, PathOp::Subtract]);
        let stroke = s.stroke.as_ref().unwrap();
        assert_eq!((stroke.width, stroke.align, stroke.miter_limit, stroke.dashes.len()), (2.0, StrokeAlign::Center, 4.0, 0));
        assert!(s.cache.is_some() && s.live.is_none());
        // Without operations the whole path is one fill: the inner box wound the other way is a hole.
        let doc = open(&format!("{v}-shape-path-winding")).document;
        assert_eq!(shape_of(&doc, "Shape").path.subpaths.iter().map(|p| p.op).collect::<Vec<_>>(), [PathOp::Combine, PathOp::Join]);
        let doc = open(&format!("{v}-shape-no-fill-stroke-inside")).document;
        let s = shape_of(&doc, "Shape");
        assert!(s.fill.is_none() && s.stroke.as_ref().unwrap().align == StrokeAlign::Inside);
        // 0.3's dashes were in pixels, 0.4's in stroke widths.
        let doc = open(&format!("{v}-shape-stroke-outside-dashed")).document;
        let stroke = shape_of(&doc, "Shape").stroke.clone().unwrap();
        assert_eq!((stroke.align, stroke.dashes), (StrokeAlign::Outside, if v == "v2" { vec![2.0 / 3.0, 1.0 / 3.0] } else { vec![2.0, 1.0] }));
        let doc = open(&format!("{v}-shape-rect-03")).document;
        assert_eq!(shape_of(&doc, "Shape").live, Some(LiveShape::Rect { rect: [6.0, 5.0, 26.0, 20.0], radii: [0.0; 4] }));
    }
    let live = |name: &str| shape_of(&open(name).document, "Shape").live.clone();
    assert_eq!(live("v3-shape-rect"), Some(LiveShape::Rect { rect: [5.0, 4.0, 30.0, 22.0], radii: [6.0, 0.0, 3.0, 9.0] }));
    assert_eq!(live("v3-shape-ellipse"), Some(LiveShape::Ellipse { rect: [4.0, 6.0, 32.0, 20.0] }));
    assert_eq!(live("v3-shape-triangle"), Some(LiveShape::Triangle { rect: [6.0, 4.0, 28.0, 24.0], corner_radius: 3.0 }));
    assert_eq!(live("v3-shape-polygon"), Some(LiveShape::Polygon { rect: [8.0, 4.0, 24.0, 24.0], sides: 6, star_ratio: 1.0, corner_radius: 0.0 }));
    assert_eq!(live("v3-shape-star"), Some(LiveShape::Polygon { rect: [8.0, 4.0, 24.0, 24.0], sides: 5, star_ratio: 0.45, corner_radius: 0.0 }));
    assert_eq!(live("v3-shape-line"), Some(LiveShape::Line { from: [5.0, 26.0], to: [34.0, 6.0], weight: 4.0 }));
    assert!(matches!(live("v3-shape-line-arrow"), Some(LiveShape::ArrowLine { start: false, end: true, width: 12.0, length: 15.0, concavity: 20.0, .. })));
    // What PhotoCraft's live shapes cannot be opens as a path, and says so.
    for (name, why) in [("v3-shape-rect-turned", "the rectangle is turned"), ("v3-shape-star-smooth", "the polygon is smoothed")] {
        let r = open(name);
        assert_eq!(shape_of(&r.document, "Shape").live, None);
        assert_eq!(r.warnings, [format!("{why}, which Pigment's live shapes are not; it opens as a path (\"Shape\")")]);
    }
    assert_eq!(live("v3-shape-custom"), None);
    let doc = open("v3-shape-stroke-options").document;
    let stroke = shape_of(&doc, "Shape").stroke.clone().unwrap();
    assert_eq!((stroke.cap, stroke.join, stroke.dashes.as_slice(), stroke.dash_offset), (LineCap::Round, LineJoin::Round, [1.0f32, 2.0].as_slice(), 0.5));
    assert!(matches!(stroke.paint, Fill::Gradient { .. }));
    // A pattern-filled shape is a pattern fill layer seen through its path.
    let doc = open("v3-shape-pattern-fill").document;
    let l = layer(&doc.layers, "Shape");
    assert!(matches!(l.content, LayerContent::Fill(Fill::Pattern { .. })) && l.vector_mask.is_some());
    assert_eq!(doc.patterns.len(), 1);
}

#[test]
fn vector_masks() {
    let r = open("v3-vector-masks");
    assert_eq!(r.warnings, Vec::<String>::new());
    let doc = &r.document;
    let vm = |name: &str| layer(&doc.layers, name).vector_mask.clone().unwrap_or_else(|| panic!("{name}"));
    let hide = vm("Hide");
    assert!(hide.enabled && hide.linked && !hide.path.inverted);
    assert_eq!(hide.path.subpaths.iter().map(|s| s.op).collect::<Vec<_>>(), [PathOp::Combine, PathOp::Subtract]);
    // Reveal All, then three subtracted boxes: the boxes, inverted.
    let reveal = vm("Reveal");
    assert!(reveal.path.inverted);
    assert_eq!(reveal.path.subpaths.iter().map(|s| s.op).collect::<Vec<_>>(), [PathOp::Combine, PathOp::Combine, PathOp::Combine]);
    let soft = vm("Soft");
    assert_eq!((soft.density, soft.feather, soft.linked), (0.75, 1.5, false));
    assert!(!vm("Disabled").enabled);
    let all = vm("Reveal all");
    assert!(all.path.subpaths.is_empty() && !all.path.inverted);
    assert!(vm("Group").path.subpaths.len() == 1 && layer(&doc.layers, "Both masks").mask.is_some());
}

fn effects(name: &str) -> (photocraft_doc::Effects, Vec<String>) {
    let r = open(name);
    (layer(&r.document.layers, "Styled").effects.clone(), r.warnings)
}

#[test]
fn layer_styles() {
    for v in ["v2", "v3"] {
        let (fx, w) = effects(&format!("{v}-style-drop-shadow"));
        assert_eq!(w, Vec::<String>::new());
        let Effect::DropShadow(s) = &fx.items[0] else { panic!() };
        assert_eq!((s.common.enabled, s.common.blend, s.common.opacity, s.angle, s.distance, s.size), (true, BlendMode::Multiply, 0.8, 135.0, 4.0, 3.0));
        // Spread in pixels becomes Photoshop's percentage of the size.
        assert!((s.spread - 1.0 / 3.0).abs() < 1e-6 && s.knocks_out);
        let Effect::InnerShadow(s) = &effects(&format!("{v}-style-inner-shadow")).0.items[0] else { panic!() };
        assert_eq!((s.angle, s.spread, s.knocks_out), (60.0, 0.5, false));
        let Effect::OuterGlow(g) = &effects(&format!("{v}-style-outer-glow")).0.items[0] else { panic!() };
        assert_eq!((g.common.blend, g.spread, g.size, g.technique), (BlendMode::Normal, 0.25, 4.0, GlowTechnique::Softer));
        let Effect::InnerGlow(g) = &effects(&format!("{v}-style-inner-glow-center")).0.items[0] else { panic!() };
        assert_eq!((g.source, g.size), (GlowSource::Center, 5.0));
        for (style, want, tech) in [
            ("inner-bevel", BevelStyle::InnerBevel, BevelTechnique::Smooth),
            ("outer-bevel", BevelStyle::OuterBevel, BevelTechnique::Smooth),
            ("emboss", BevelStyle::Emboss, BevelTechnique::ChiselHard),
            ("pillow-emboss", BevelStyle::PillowEmboss, BevelTechnique::Smooth),
        ] {
            let Effect::BevelEmboss(b) = &effects(&format!("{v}-style-bevel-{style}")).0.items[0] else { panic!() };
            assert_eq!(
                (b.style, b.technique, b.depth, b.up, b.altitude, b.highlight.blend),
                (want, tech, 1.5, style != "outer-bevel", 40.0, BlendMode::Screen)
            );
        }
    }
}

#[test]
fn layer_styles_of_0_3_and_0_4() {
    for v in ["v2", "v3"] {
        let Effect::Satin(s) = &effects(&format!("{v}-style-satin")).0.items[0] else { panic!() };
        assert_eq!((s.angle, s.distance, s.invert), (45.0, 5.0, false));
        let Effect::GradientOverlay { gradient, .. } = &effects(&format!("{v}-style-gradient-overlay")).0.items[0] else { panic!() };
        assert_eq!((gradient.angle, gradient.scale, gradient.style), (30.0, 0.8, GradientStyle::Linear));
        // Reversed in its stops; the middle stop's own opacity kept.
        assert_eq!(gradient.stops[0].1, photocraft_color::Color::rgb(0.0, 0.0, 1.0));
        assert_eq!(gradient.opacity_stops[1], (0.5, 0.5));
        for position in ["outside", "inside", "center"] {
            let Effect::Stroke(s) = &effects(&format!("{v}-style-stroke-{position}")).0.items[0] else { panic!() };
            assert_eq!((s.size, s.common.opacity), (3.0, 0.8));
            assert_eq!(
                s.position,
                match position {
                    "outside" => StrokePosition::Outside,
                    "inside" => StrokePosition::Inside,
                    _ => StrokePosition::Center,
                }
            );
        }
        let (fx, _) = effects(&format!("{v}-style-several"));
        assert_eq!(
            fx.items.iter().map(|e| (e.label(), e.enabled())).collect::<Vec<_>>(),
            [("Drop Shadow", true), ("Inner Shadow", false), ("Color Overlay", true), ("Stroke", true)]
        );
    }
}

#[test]
fn layer_styles_pigment_0_4_added() {
    let (fx, _) = effects("v3-style-drop-shadows");
    assert_eq!(fx.items.len(), 3);
    let Effect::DropShadow(top) = &fx.items[0] else { panic!() };
    assert_eq!((top.angle, top.knocks_out, fx.items[2].enabled()), (0.0, true, false));
    let (fx, _) = effects("v3-style-strokes");
    assert_eq!(fx.items.iter().map(|e| if let Effect::Stroke(s) = e { s.size } else { 0.0 }).collect::<Vec<_>>(), [2.0, 5.0]);
    let Effect::DropShadow(s) = &effects("v3-style-shadow-options").0.items[0] else { panic!() };
    assert!(s.use_global_light && s.anti_alias && (s.noise - 0.3).abs() < 1e-6);
    assert!(matches!(&s.contour, Contour::Custom { name, points, corners } if name == "Cone" && points.len() == 3 && corners == &[false, true, false]));
    let Effect::OuterGlow(g) = &effects("v3-style-outer-glow-precise").0.items[0] else { panic!() };
    assert_eq!((g.technique, g.range), (GlowTechnique::Precise, 0.7));
    let Effect::OuterGlow(g) = &effects("v3-style-outer-glow-gradient").0.items[0] else { panic!() };
    assert!(matches!(&g.paint, FxPaint::Gradient(gr) if gr.opacity_stops.last() == Some(&(1.0, 0.2))));
}

#[test]
fn layer_style_options_patterns_and_where_styles_go() {
    let (fx, _) = effects("v3-style-bevel-options");
    let Effect::BevelEmboss(b) = &fx.items[0] else { panic!() };
    assert_eq!(
        (b.technique, b.depth, b.contour.as_ref().map(|c| c.range), b.texture.as_ref().map(|t| (t.scale, t.depth, t.invert, t.phase))),
        (BevelTechnique::ChiselSoft, 2.0, Some(0.6), Some((2.0, 0.5, true, (1.0, 1.0))))
    );
    let Effect::GradientOverlay { gradient, dither: true, .. } = &effects("v3-style-gradient-overlay-v2").0.items[0] else { panic!() };
    assert_eq!((gradient.offset, gradient.align, gradient.scale), ((0.1, -0.2), false, 1.5));
    let Effect::PatternOverlay { link: false, phase, common, .. } = &effects("v3-style-pattern-overlay-v2").0.items[0] else { panic!() };
    assert_eq!((*phase, common.blend), ((2.0, 1.0), BlendMode::Multiply));
    assert!(matches!(&effects("v3-style-stroke-gradient").0.items[0], Effect::Stroke(s) if matches!(s.paint, FxPaint::Gradient(_))));
    assert!(matches!(&effects("v3-style-stroke-pattern").0.items[0], Effect::Stroke(s) if matches!(s.paint, FxPaint::Pattern { .. })));
    let (fx, _) = effects("v3-style-hidden");
    assert!(!fx.enabled && fx.items.len() == 2);
    // The patterns the styles use are the document's.
    let doc = open("v3-style-bevel-options").document;
    assert_eq!(doc.patterns.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["Quarters"]);
    // On a group and on a shape.
    let doc = open("v3-style-group-shape").document;
    assert!(matches!(layer(&doc.layers, "Group").effects.items[..], [Effect::Stroke(_)]));
    assert!(matches!(layer(&doc.layers, "Shape").effects.items[..], [Effect::DropShadow(_)]));
}

#[test]
fn advanced_blending() {
    let blended = |name: &str| layer(&open(name).document.layers, "Blended").clone();
    assert_eq!(blended("v3-blending-channels").excluded_channels, 0b010);
    let l = blended("v3-blending-blend-if");
    let [this, under] = l.blend_if.get(0);
    assert_eq!((this.to_bytes(), under.to_bytes()), ([40, 90, 255, 255], [0, 0, 150, 220]));
    let l = blended("v3-blending-blend-if-channels");
    assert_eq!(
        (l.blend_if.get(1)[0].to_bytes(), l.blend_if.get(3)[1].to_bytes(), l.blend_if.get(2)[0].is_full()),
        ([100, 100, 255, 255], [0, 60, 255, 255], true)
    );
    let l = blended("v3-blending-knockout-shallow");
    assert_eq!((l.advanced.knockout, l.fill_opacity), (Knockout::Shallow, 0.3));
    let a = blended("v3-blending-flags").advanced;
    assert_eq!(
        (a.knockout, a.blend_interior, a.blend_clipped, a.transparency_shapes, a.layer_mask_hides_effects, a.vector_mask_hides_effects),
        (Knockout::Deep, true, false, false, true, true)
    );
    // The bottom "Background" is Photoshop's Background (what a knockout reveals).
    let doc = open("v3-blending-knockout-shallow").document;
    assert!(doc.layers[0].has_background_traits() && doc.is_background(doc.layers[0].id));
}

#[test]
fn opened_documents_save_in_the_new_format_and_open_again() {
    for name in [
        "v3-adjust-curves-pencil",
        "v3-fill-gradient-v2",
        "v3-shape-stroke-options",
        "v3-vector-masks",
        "v3-style-bevel-options",
        "v3-blending-flags",
        "v2-style-several",
    ] {
        let first = open(name).document;
        let saved = crate::export(&first, "new.pigment", &crate::ExportOptions::default()).unwrap();
        let again = crate::import("new.pigment", &saved.bytes).unwrap().document;
        let strip = |d: &photocraft_doc::Document| {
            let mut d = d.clone();
            d.id = first.id;
            d.name.clear();
            d
        };
        assert_eq!(strip(&again), strip(&first), "{name}");
    }
}

#[test]
fn hostile_descriptions_of_the_new_kinds() {
    let json = r##"{"version":3,"app":"pigment","width":4,"height":4,"layers":[
        {"id":"a","type":"adjustment","kind":"curves","params":{"rgb":{"table":[1,2]},"r":[[0,0]],"space":7}},
        {"id":"b","type":"adjustment","kind":"color-lookup","params":{"lut":{"type":"3d","size":100000,"data":[]}}},
        {"id":"c","type":"fill","paint":{"type":"gradient","gradient":{"gradientVersion":2,"type":"noise","noise":{"seed":1e300,"roughness":"x"},"from":[1e300,0],"to":[0,"y"]}}},
        {"id":"d","type":"fill","paint":{"type":"pattern","pattern":{"scale":-4}}},
        {"id":"e","type":"fill","paint":{"type":"plaid"}},
        {"id":"f","type":"shape","path":{"subpaths":[{"op":"subtract","points":[{"x":0,"y":0},{"x":4,"y":0},{"x":4,"y":4}]}]},"fill":{"type":"pattern","pattern":{"dataUrl":"data:image/png;base64,!!!"}},"stroke":{"width":1e300,"dash":[1e300,-1],"paint":{"type":"solid","color":"#zzz"}},"shapeKind":"polygon","shapeProps":{"sides":1e9,"starRatio":-5}},
        {"id":"g","type":"raster","styles":{"dropShadow":[{"enabled":true,"size":-1,"spread":1e300,"contour":{"points":[{"x":0,"y":0}]}}],"patternOverlay":{"enabled":true,"pattern":"data:text/plain;base64,AAAA"},"glitter":{}},"vectorMask":{"path":{"subpaths":[{"op":"intersect","points":[[0,0],[1,1],[0,1]]},{"op":"intersect","points":[[0,0],[1,1],[1,0]]}]},"initialFill":"reveal","density":-1},"blending":{"channels":{"r":false},"knockout":"total","blendIf":{"gray":{"this":[300,-5,"x",4],"under":[200,100,50,0]}}}}
    ]}"##;
    let mut w = craft_zip::Writer::new();
    w.add("document.json", json.as_bytes(), craft_zip::Compression::Deflated).unwrap();
    let r = crate::import("hostile.pigment", &w.finish().unwrap()).unwrap();
    assert_eq!(r.document.layers.len(), 7);
    let g = &r.document.layers[6];
    let [this, under] = g.blend_if.get(0);
    assert_eq!((this.to_bytes(), under.to_bytes()), ([0, 0, 255, 255], [200, 200, 50, 50]));
    assert_eq!((g.excluded_channels, g.advanced.knockout), (1, Knockout::None));
    assert!(r.warnings.iter().any(|w| w.contains("glitter")), "{:?}", r.warnings);
    assert!(r.warnings.iter().any(|w| w.contains("plaid")), "{:?}", r.warnings);
}

#[test]
fn colours_follow_the_document_mode() {
    let json = r##"{"version":3,"app":"pigment","width":4,"height":4,"mode":"grayscale","layers":[
        {"id":"f","type":"fill","name":"Fill","paint":{"type":"solid","color":"#ff0000"},"styles":{"colorOverlay":{"enabled":true,"color":"#00ff00"}}}
    ]}"##;
    let mut w = craft_zip::Writer::new();
    w.add("document.json", json.as_bytes(), craft_zip::Compression::Deflated).unwrap();
    let doc = crate::import("grey.pigment", &w.finish().unwrap()).unwrap().document;
    assert_eq!(doc.mode, ColorMode::Grayscale);
    let l = &doc.layers[0];
    assert!(matches!(&l.content, LayerContent::Fill(Fill::Solid(c)) if c.mode == ColorMode::Grayscale));
    assert!(matches!(&l.effects.items[0], Effect::ColorOverlay { color, .. } if color.mode == ColorMode::Grayscale));
}

#[test]
#[ignore = "prints how far each picture is from the app's; run by hand"]
fn print_differences() {
    for name in pictured() {
        let (max, mean) = difference(&name);
        println!("{name:48} max {max:3} mean {mean:7.3}");
    }
}

#[test]
#[ignore = "writes the opened documents' pictures to $PIGMENT_DUMP; run by hand"]
fn dump_pictures() {
    let Ok(dir) = std::env::var("PIGMENT_DUMP") else { return };
    for name in pictured() {
        let doc = open(&name).document;
        let ours = photocraft_compose::flatten_to_surface(&doc, PixelFormat::new(ColorMode::Rgb, SampleType::U8, true), None);
        let mut raw = Vec::new();
        for y in 0..doc.size.height as i32 {
            for x in 0..doc.size.width as i32 {
                raw.extend(ours.pixel(x, y).iter().map(|v| (v * 255.0).round() as u8));
            }
        }
        std::fs::write(format!("{dir}/{name}.{}x{}.rgba", doc.size.width, doc.size.height), raw).unwrap();
    }
}
