//! The port against the JavaScript Pigment 0.4's own results (`js-cases.json`, written by `make-cases.mjs` with the
//! app's functions; README.md names the commit).

use super::*;
use serde_json::Value;

const CASES: &str = include_str!("js-cases.json");

fn cases() -> Value {
    serde_json::from_str(CASES).unwrap_or(Value::Null)
}

fn image(all: &Value, name: &str) -> Sample {
    let rgba = all["images"][name]["rgba"].as_str().unwrap_or_default();
    let bytes: Vec<u8> = (0..rgba.len() / 2).filter_map(|i| u8::from_str_radix(rgba.get(i * 2..i * 2 + 2)?, 16).ok()).collect();
    let px: Vec<[u8; 4]> = bytes.chunks_exact(4).map(|c| [c[0], c[1], c[2], c[3]]).collect();
    assert_eq!(px.len(), 24 * 24, "image {name}");
    Sample::from_rgba8(&px)
}

fn hex(v: &Value, fallback: [u8; 3]) -> [u8; 3] {
    let Some(s) = v.as_str().and_then(|s| s.strip_prefix('#')) else { return fallback };
    let b = |i: usize| s.get(i..i + 2).and_then(|x| u8::from_str_radix(x, 16).ok());
    match (b(0), b(2), b(4)) {
        (Some(r), Some(g), Some(b)) => [r, g, b],
        _ => fallback,
    }
}

/// The options as JS `autoOptions` reads its keys.
fn options(o: &Value) -> AutoOptions {
    let d = AutoOptions::default();
    AutoOptions {
        algorithm: o["algorithm"].as_str().and_then(AutoAlgorithm::parse).unwrap_or(d.algorithm),
        snap_neutral: o["snap"].as_bool().unwrap_or(false),
        shadow_clip: clamp_clip(o["shadowClip"].as_f64().unwrap_or(0.1)),
        highlight_clip: clamp_clip(o["highlightClip"].as_f64().unwrap_or(0.1)),
        shadow: hex(&o["shadowColor"], d.shadow),
        midtone: hex(&o["midColor"], d.midtone),
        highlight: hex(&o["highlightColor"], d.highlight),
    }
}

fn levels(v: &Value) -> Levels5 {
    let f = |k: &str| v[k].as_f64().unwrap_or(f64::NAN);
    Levels5 { in_black: f("inBlack"), in_white: f("inWhite"), gamma: f("gamma"), out_black: f("outBlack"), out_white: f("outWhite") }
}

fn same(a: &Levels5, b: &Levels5) -> bool {
    [(a.in_black, b.in_black), (a.in_white, b.in_white), (a.gamma, b.gamma), (a.out_black, b.out_black), (a.out_white, b.out_white)]
        .iter()
        .all(|(x, y)| (x - y).abs() < 1e-9)
}

fn points(v: &Value) -> Vec<[f64; 2]> {
    v.as_array().into_iter().flatten().filter_map(|p| Some([p.get(0)?.as_f64()?, p.get(1)?.as_f64()?])).collect()
}

#[test]
fn every_levels_case_matches_the_javascript_app() {
    let all = cases();
    let list = all["levels"].as_array().cloned().unwrap_or_default();
    assert!(list.len() >= 6, "the fixture has its cases");
    for case in &list {
        let name = case["name"].as_str().unwrap_or_default();
        let got = auto_levels(&image(&all, case["image"].as_str().unwrap_or_default()), &options(&case["options"]));
        let want = &case["result"];
        assert!(same(&got.composite, &levels(&want["rgb"])), "{name}: composite {:?} vs {}", got.composite, want["rgb"]);
        match got.channels {
            None => assert!(want["r"].is_null() && want["g"].is_null() && want["b"].is_null(), "{name}: JS has channels {want}"),
            Some(ch) => {
                for (c, key) in ch.iter().zip(["r", "g", "b"]) {
                    assert!(same(c, &levels(&want[key])), "{name}: {key} {c:?} vs {}", want[key]);
                }
            }
        }
    }
}

#[test]
fn curves_and_other_spaces_match_the_javascript_app() {
    let all = cases();
    for case in all["curves"].as_array().cloned().unwrap_or_default() {
        let name = case["name"].as_str().unwrap_or_default();
        let sample = image(&all, case["image"].as_str().unwrap_or_default());
        let o = options(&case["options"]);
        let want = &case["result"];
        if case["space"] == "gray" {
            let got = auto_levels(&sample, &luminosity_options(&o));
            assert!(got.channels.is_none(), "{name}");
            assert!(same(&got.composite, &levels(&want["gray"])), "{name}: {:?} vs {}", got.composite, want["gray"]);
            continue;
        }
        let got = auto_levels(&sample, &o);
        assert_eq!(curve_points(&got.composite), points(&want["rgb"]), "{name}: composite");
        match got.channels {
            None => assert!(want["r"].is_null(), "{name}"),
            Some(ch) => {
                for (c, key) in ch.iter().zip(["r", "g", "b"]) {
                    assert_eq!(curve_points(c), points(&want[key]), "{name}: {key}");
                }
            }
        }
    }
}

#[test]
fn brightness_contrast_auto_matches_the_javascript_app() {
    let all = cases();
    for case in all["brightnessContrast"].as_array().cloned().unwrap_or_default() {
        let img = case["image"].as_str().unwrap_or_default();
        let (brightness, contrast) = auto_brightness_contrast(&image(&all, img));
        assert_eq!(i64::from(brightness), case["result"]["brightness"].as_i64().unwrap_or(i64::MIN), "{img}");
        assert_eq!(i64::from(contrast), case["result"]["contrast"].as_i64().unwrap_or(i64::MIN), "{img}");
    }
    // A dark image is brightened; an empty one left alone.
    assert!(auto_brightness_contrast(&image(&all, "dark")).0 > 0);
    assert_eq!(auto_brightness_contrast(&Sample::new(Vec::new())), (0, 0));
}

#[test]
fn defaults_and_clamping_are_the_javascript_apps() {
    let all = cases();
    assert_eq!(options(&all["defaults"]), AutoOptions::default());
    let clamped = options(&all["clamped"]);
    assert_eq!((clamped.algorithm, clamped.shadow_clip, clamped.highlight_clip), (AutoAlgorithm::PerChannel, 9.99, 0.0));
    let wild = AutoOptions { shadow_clip: 50.0, highlight_clip: f32::NAN, ..AutoOptions::default() }.clamped();
    assert_eq!((wild.shadow_clip, wild.highlight_clip), (9.99, DEFAULT_CLIP));
    for a in AutoAlgorithm::ALL {
        assert_eq!(AutoAlgorithm::parse(a.id()), Some(a));
    }
    assert_eq!(AutoAlgorithm::parse("mono"), Some(AutoAlgorithm::Monochromatic));
    assert_eq!(AutoAlgorithm::parse("brightness"), Some(AutoAlgorithm::BrightnessContrast));
    assert_eq!(AutoAlgorithm::parse("nope"), None);
}

#[test]
fn clipping_zero_and_two_percent_differ() {
    let all = cases();
    let sample = image(&all, "lowContrast");
    let at = |clip: f32| {
        let o = AutoOptions { algorithm: AutoAlgorithm::Monochromatic, shadow_clip: clip, highlight_clip: clip, ..AutoOptions::default() };
        auto_levels(&sample, &o).composite
    };
    let (none, two) = (at(0.0), at(2.0));
    assert!(two.in_black > none.in_black && two.in_white < none.in_white, "{none:?} {two:?}");
}

#[test]
fn snap_neutral_midtones_takes_the_cast_out_of_a_grey() {
    // A warm cast over a ramp, black and white present so the stretch leaves the ends alone.
    let mut px: Vec<[u8; 3]> = (0..=200u16).map(|v| [(v + 30).min(255) as u8, (v + 20) as u8, v as u8]).collect();
    px.extend([[0, 0, 0], [255, 255, 255]].repeat(20));
    let grey = [150u8, 140, 120];
    px.extend(std::iter::repeat_n(grey, 400));
    let sample = Sample::new(px);
    let o = AutoOptions { algorithm: AutoAlgorithm::Monochromatic, snap_neutral: true, ..AutoOptions::default() };
    let got = auto_levels(&sample, &o);
    let ch = got.channels.unwrap_or([Levels5::IDENTITY; 3]);
    let out: Vec<i32> = ch.iter().zip(grey).map(|(l, v)| i32::from(l.lut()[usize::from(v)])).collect();
    let before = i32::from(grey[0]) - i32::from(grey[2]);
    let after = out.iter().max().copied().unwrap_or(0) - out.iter().min().copied().unwrap_or(0);
    assert!(after * 4 < before, "the grey {grey:?} became {out:?}");
    // A coloured midtone target tints the grey instead.
    let warm = AutoOptions { midtone: [150, 128, 110], ..o };
    let tinted = auto_levels(&sample, &warm).channels.unwrap_or([Levels5::IDENTITY; 3]);
    let t: Vec<i32> = tinted.iter().zip(grey).map(|(l, v)| i32::from(l.lut()[usize::from(v)])).collect();
    assert!(t[0] > t[2] + 20, "{t:?}");
}

#[test]
fn an_empty_or_transparent_sample_is_the_identity() {
    let none = Sample::from_rgba8(&[[10, 20, 30, 0]; 16]);
    assert_eq!(none.count(), 0);
    for a in AutoAlgorithm::ALL {
        let o = AutoOptions { algorithm: a, snap_neutral: true, ..AutoOptions::default() };
        assert_eq!(auto_levels(&none, &o), AutoLevels { composite: Levels5::IDENTITY, channels: None });
    }
    // A flat image: no range to stretch, so nothing moves.
    let flat = Sample::new(vec![[90, 90, 90]; 100]);
    let got = auto_levels(&flat, &AutoOptions::default());
    assert!(got.channels.is_some_and(|c| c.iter().all(|l| same(l, &Levels5::IDENTITY))), "{got:?}");
    // Huge inputs are thinned, not refused.
    assert!(Sample::new(vec![[1, 2, 3]; MAX_SAMPLE_PIXELS + 10]).count() <= MAX_SAMPLE_PIXELS as u64);
    assert!(Sample::from_rgba_f32(&[[f32::NAN, 2.0, -1.0, 1.0], [0.0, 0.0, 0.0, f32::NAN]]).count() == 1);
}
