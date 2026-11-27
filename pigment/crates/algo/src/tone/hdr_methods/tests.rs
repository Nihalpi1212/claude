//! The three methods against the JavaScript Pigment 0.4's own results (`js-cases.json`, written by
//! `make-cases.mjs`; README.md names the commit), and the properties the spec asks of each.

use super::*;
use serde_json::Value;

const CASES: &str = include_str!("js-cases.json");

fn bytes(hex: &str) -> Vec<u8> {
    (0..hex.len() / 2).filter_map(|i| u8::from_str_radix(hex.get(i * 2..i * 2 + 2)?, 16).ok()).collect()
}

fn pixels(hex: &str) -> Vec<[f32; 4]> {
    bytes(hex).chunks_exact(4).map(|c| [c[0], c[1], c[2], c[3]].map(|v| f32::from(v) / 255.0)).collect()
}

fn settings(params: &Value) -> HdrToning {
    let f = |k: &str, d: f32| params.get(k).and_then(Value::as_f64).map_or(d, |v| v as f32);
    HdrToning { exposure: f("exposure", 0.0), gamma: f("gamma", 1.0), ..Default::default() }
}

#[test]
fn every_method_matches_the_javascript_app_within_one_level() {
    let all: Value = serde_json::from_str(CASES).unwrap_or(Value::Null);
    let (w, h) = (all["width"].as_u64().unwrap_or(0) as usize, all["height"].as_u64().unwrap_or(0) as usize);
    let input = pixels(all["input"].as_str().unwrap_or_default());
    assert_eq!(input.len(), w * h);
    let cases = all["cases"].as_array().cloned().unwrap_or_default();
    assert_eq!(cases.len(), 5);
    for case in cases {
        let method = HdrMethod::parse(case["method"].as_str().unwrap_or_default()).expect("a JS method id");
        let expected = bytes(case["output"].as_str().unwrap_or_default());
        let mut px = input.clone();
        hdr_toning_with(&mut px, w, h, &settings(&case["params"]), method, false);
        let mut worst = 0i32;
        for (i, (q, e)) in px.iter().zip(expected.chunks_exact(4)).enumerate() {
            for c in 0..3 {
                let got = (q[c] * 255.0).round() as i32;
                let d = (got - i32::from(e[c])).abs();
                worst = worst.max(d);
                assert!(d <= 1, "{method:?} {}: pixel {i} channel {c}: {got} vs JS {}", case["params"], e[c]);
            }
            assert_eq!((q[3] * 255.0).round() as u8, e[3], "alpha is kept");
        }
        assert!(worst <= 1, "{method:?}");
    }
}

/// A ramp whose luma histogram is skewed into the shadows (x²).
fn skewed_ramp(n: usize) -> Vec<[f32; 4]> {
    (0..n)
        .map(|i| {
            let x = (i as f32 / (n - 1) as f32).powi(2);
            [x, x, x, 1.0]
        })
        .collect()
}

#[test]
fn equalize_histogram_flattens_the_luma_histogram_of_a_ramp() {
    let n = 1024;
    let mut px = skewed_ramp(n);
    let before: Vec<f32> = px.iter().map(|q| q[0]).collect();
    hdr_toning_with(&mut px, n, 1, &HdrToning::default(), HdrMethod::EqualizeHistogram, false);
    // Eight equal luma bins: before, most pixels sit in the darkest; after, each holds about an eighth.
    let counts = |v: &[f32]| {
        let mut c = [0usize; 8];
        for x in v {
            c[((x * 8.0) as usize).min(7)] += 1;
        }
        c
    };
    let skewed = counts(&before);
    assert!(skewed[0] > n / 3, "{skewed:?}");
    let after: Vec<f32> = px.iter().map(|q| 0.299 * q[0] + 0.587 * q[1] + 0.114 * q[2]).collect();
    for (b, c) in counts(&after).into_iter().enumerate() {
        assert!((c as f32 - n as f32 / 8.0).abs() < n as f32 / 8.0 * 0.15, "bin {b}: {c} of {n}");
    }
    // Monotonic, black stays black and the brightest goes to white; greys stay grey.
    assert!(after.windows(2).all(|p| p[1] >= p[0] - 1e-6));
    assert!(after[0] < 1e-3 && after[n - 1] > 0.999);
    assert!(px.iter().all(|q| (q[0] - q[1]).abs() < 1e-5 && (q[1] - q[2]).abs() < 1e-5));
}

#[test]
fn exposure_and_gamma_plus_one_stop_doubles_linear_values() {
    let mut px: Vec<[f32; 4]> = (0..64).map(|i| [linear_to_srgb(i as f32 / 140.0), linear_to_srgb(i as f32 / 200.0), 0.3, 1.0]).collect();
    let before = px.clone();
    hdr_toning_with(&mut px, 64, 1, &HdrToning { exposure: 1.0, gamma: 1.0, ..Default::default() }, HdrMethod::ExposureGamma, false);
    for (q, b) in px.iter().zip(&before) {
        for c in 0..3 {
            let want = (2.0 * srgb_to_linear(b[c])).min(1.0);
            assert!((srgb_to_linear(q[c]) - want).abs() < 1e-4, "{b:?} → {q:?}");
        }
    }
    // Linear pixels (a 32-bit document) double as they are, past 1 clipped to white; gamma < 1 darkens.
    let mut lin = vec![[0.1, 0.4, 0.7, 1.0]];
    hdr_toning_with(&mut lin, 1, 1, &HdrToning { exposure: 1.0, gamma: 1.0, ..Default::default() }, HdrMethod::ExposureGamma, true);
    assert!((lin[0][0] - 0.2).abs() < 1e-4 && (lin[0][1] - 0.8).abs() < 1e-4 && (lin[0][2] - 1.0).abs() < 1e-6, "{lin:?}");
    let mut dark = vec![[0.25, 0.25, 0.25, 1.0]];
    hdr_toning_with(&mut dark, 1, 1, &HdrToning { gamma: 0.5, ..Default::default() }, HdrMethod::ExposureGamma, true);
    assert!((dark[0][0] - 0.0625).abs() < 1e-4, "{dark:?}");
}

#[test]
fn highlight_compression_keeps_the_brightest_pixel_at_most_white_and_is_monotonic() {
    let n = 256;
    for exposure in [0.0, 2.0, 5.0, -3.0] {
        let mut px: Vec<[f32; 4]> = (0..n).map(|i| [i as f32 / (n - 1) as f32, i as f32 / (n - 1) as f32 * 0.8, 0.1, 1.0]).collect();
        hdr_toning_with(&mut px, n, 1, &HdrToning { exposure, ..Default::default() }, HdrMethod::HighlightCompression, false);
        let l: Vec<f32> = px.iter().map(|q| 0.2126 * q[0] + 0.7152 * q[1] + 0.0722 * q[2]).collect();
        assert!(px.iter().all(|q| q[..3].iter().all(|v| (0.0..=1.0).contains(v))), "exposure {exposure}");
        assert!(l.windows(2).all(|p| p[1] >= p[0] - 1e-6), "exposure {exposure}: not monotonic");
        // The white point is the brightest luminance: it maps to (about) 1, nothing is pushed past.
        assert!(px[n - 1][0] <= 1.0 && px[n - 1][0] > 0.95, "exposure {exposure}: {:?}", px[n - 1]);
    }
    // 32-bit radiance past 1 is compressed into range, ordered.
    let mut hdr = vec![[0.5, 0.5, 0.5, 1.0], [4.0, 4.0, 4.0, 1.0], [16.0, 16.0, 16.0, 1.0]];
    hdr_toning_with(&mut hdr, 3, 1, &HdrToning::default(), HdrMethod::HighlightCompression, true);
    assert!(hdr[0][0] < hdr[1][0] && hdr[1][0] < hdr[2][0] && (hdr[2][0] - 1.0).abs() < 1e-4, "{hdr:?}");
}

#[test]
fn local_adaptation_is_upstreams_and_transparent_pixels_are_kept() {
    let mut a: Vec<[f32; 4]> = (0..40).map(|i| [i as f32 / 39.0, 0.4, 0.2, 1.0]).collect();
    let mut b = a.clone();
    let p = HdrToning { strength: 2.0, ..Default::default() };
    hdr_toning_with(&mut a, 40, 1, &p, HdrMethod::LocalAdaptation, false);
    super::super::hdr_toning(&mut b, 40, 1, &p);
    assert_eq!(a, b);
    for m in HdrMethod::ALL {
        let mut px = vec![[0.3, 0.6, 0.9, 0.0], [0.2, 0.2, 0.2, 1.0]];
        hdr_toning_with(&mut px, 2, 1, &p, m, false);
        assert_eq!(px[0], [0.3, 0.6, 0.9, 0.0], "{m:?}");
        // Empty, mismatched and fully transparent buffers do nothing and never panic.
        hdr_toning_with(&mut [], 0, 0, &p, m, false);
        hdr_toning_with(&mut px, 5, 3, &p, m, false);
        let mut clear = vec![[0.5; 4].map(|_| 0.0); 4];
        hdr_toning_with(&mut clear, 2, 2, &p, m, true);
        assert!(clear.iter().all(|q| *q == [0.0; 4]));
    }
}

#[test]
fn ids_labels_and_the_settings_each_method_uses() {
    for m in HdrMethod::ALL {
        assert_eq!(HdrMethod::parse(m.id()), Some(m));
        assert_eq!(serde_json::to_value(m).ok(), Some(Value::from(m.id())));
    }
    assert_eq!(HdrMethod::parse("local-adaptation"), Some(HdrMethod::LocalAdaptation));
    assert_eq!(HdrMethod::parse("exposure-gamma"), Some(HdrMethod::ExposureGamma));
    assert_eq!(HdrMethod::parse("highlight-compression"), Some(HdrMethod::HighlightCompression));
    assert_eq!(HdrMethod::parse("equalize-histogram"), Some(HdrMethod::EqualizeHistogram));
    assert_eq!(HdrMethod::parse("Exposure"), None);
    assert_eq!(HdrMethod::default(), HdrMethod::LocalAdaptation);
    assert_eq!(HdrMethod::ExposureGamma.label(), "Exposure and Gamma");
    assert!(HdrMethod::LocalAdaptation.uses("radius") && !HdrMethod::ExposureGamma.uses("radius"));
    assert!(HdrMethod::ExposureGamma.uses("gamma") && !HdrMethod::HighlightCompression.uses("gamma"));
    assert!(HdrMethod::HighlightCompression.uses("exposure") && !HdrMethod::EqualizeHistogram.uses("exposure"));
}
