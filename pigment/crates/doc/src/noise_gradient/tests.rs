use super::*;

/// `seededRandom(7)` and `seededRandom(42)` × 2³², from the app's code under Node.
const MULBERRY_7: [u64; 3] = [50_271_532, 266_108_690, 4_195_786_334];
const MULBERRY_42: [u64; 3] = [2_581_720_956, 1_925_393_290, 3_661_312_704];

#[test]
fn mulberry32_gives_the_apps_sequence() {
    for (seed, want) in [(7, MULBERRY_7), (42, MULBERRY_42)] {
        let mut r = Mulberry(seed);
        let got: Vec<u64> = (0..3).map(|_| (r.next() * 4_294_967_296.0) as u64).collect();
        assert_eq!(got, want, "seed {seed}");
    }
    assert_eq!(seed_of(7.9), 7);
    assert_eq!(seed_of(-1.0), u32::MAX);
    assert_eq!(seed_of(f64::NAN), 0);
}

const TS: [f64; 5] = [0.0, 0.125, 0.5, 0.8125, 1.0];

/// `sampleGradient({gradientVersion: 2, type: 'noise', noise}, t)` in Node (gradient-model.js of
/// the JavaScript Pigment), at [`TS`]: `[r, g, b]` 0..255 and the opacity.
fn js_cases() -> Vec<(NoiseGradient, [[f64; 4]; 5])> {
    vec![
        (
            NoiseGradient {
                roughness: 0.4,
                model: NoiseModel::Rgb,
                min: [0.0, 0.2, 0.0, 0.0],
                max: [1.0, 0.8, 1.0, 1.0],
                restrict: true,
                transparency: false,
                seed: 7,
            },
            [
                [34.923583708, 176.634937135, 232.823891389, 1.0],
                [246.118484676, 177.904504727, 137.547870893, 1.0],
                [151.555847437, 58.006036219, 89.018524941, 1.0],
                [173.673604398, 155.688003412, 241.344114677, 1.0],
                [21.576429574, 72.859386925, 81.232942712, 1.0],
            ],
        ),
        (
            NoiseGradient { roughness: 0.75, model: NoiseModel::Hsb, min: [0.0, 0.5, 0.25, 0.0], max: [1.0; 4], restrict: false, transparency: true, seed: 42 },
            [
                [28.866765299, 49.634005655, 81.658907617, 0.68613679],
                [175.100939589, 86.356033379, 78.172316481, 0.785547655],
                [163.827597286, 222.946008015, 17.94205633, 0.033757814],
                [70.382270781, 151.656727601, 220.720136617, 0.050139886],
                [87.585527383, 15.840656027, 4.331219264, 0.122567049],
            ],
        ),
        (
            NoiseGradient {
                roughness: 0.25,
                model: NoiseModel::Lab,
                min: [0.25, 0.0, 0.0, 0.0],
                max: [0.75, 1.0, 1.0, 1.0],
                restrict: false,
                transparency: false,
                seed: 2024,
            },
            [
                [0.0, 205.353534916, 255.0, 1.0],
                [0.0, 189.712107779, 255.0, 1.0],
                [0.0, 165.944150595, 232.453225221, 1.0],
                [0.0, 161.749137419, 150.633934651, 1.0],
                [0.0, 186.079811767, 255.0, 1.0],
            ],
        ),
    ]
}

#[test]
fn samples_match_the_apps_noise_knots_for_three_seeds() {
    for (n, rows) in js_cases() {
        for (t, want) in TS.iter().zip(rows) {
            let got = n.sample(*t);
            for c in 0..3 {
                // The settings are f32 here (0.4 is not 0.4 in f32): a few thousandths of a level.
                assert!((got[c] * 255.0 - want[c]).abs() < 0.02, "seed {} t {t} channel {c}: {} vs {}", n.seed, got[c] * 255.0, want[c]);
            }
            assert!((got[3] - want[3]).abs() < 1e-4, "seed {} t {t} alpha", n.seed);
        }
    }
}

/// The piecewise-linear value of sorted stops at `t`.
fn at<V: Copy>(stops: &[(f32, V)], t: f32, f: impl Fn(V) -> [f32; 3]) -> [f32; 3] {
    let i = stops.iter().rposition(|s| s.0 <= t).unwrap_or(0).min(stops.len() - 2);
    let ((t0, a), (t1, b)) = (stops[i], stops[i + 1]);
    let u = if t1 > t0 { ((t - t0) / (t1 - t0)).clamp(0.0, 1.0) } else { 0.0 };
    let (a, b) = (f(a), f(b));
    [0, 1, 2].map(|c| a[c] + (b[c] - a[c]) * u)
}

#[test]
fn bake_draws_the_gradient_and_is_deterministic_per_seed() {
    for (n, _) in js_cases() {
        let (colors, opacity) = n.bake();
        assert_eq!(n.bake(), (colors.clone(), opacity.clone()), "the same seed bakes the same stops");
        assert!(colors.windows(2).all(|w| w[0].0 < w[1].0), "sorted, no duplicates");
        assert_eq!((colors[0].0, colors.last().unwrap().0), (0.0, 1.0));
        assert_eq!(opacity.is_empty(), !n.transparency);
        // Linear interpolation between the baked stops draws the gradient closely.
        for i in 0..=400 {
            let t = i as f32 / 400.0;
            let want = n.sample(f64::from(t));
            let got = at(&colors, t, |c| c);
            for c in 0..3 {
                assert!((got[c] - want[c] as f32).abs() < 0.02, "seed {} t {t}: {got:?} vs {want:?}", n.seed);
            }
            if n.transparency {
                let a = at(&opacity, t, |a| [a; 3])[0];
                assert!((a - want[3] as f32).abs() < 1e-4);
            }
        }
        let mut other = n.clone();
        other.seed += 1;
        assert_ne!(other.bake().0, colors, "another seed, another gradient");
    }
    // In RGB without Restrict Colors the knots are the gradient exactly.
    let rgb = NoiseGradient { roughness: 1.0, ..NoiseGradient::default() };
    assert_eq!(rgb.bake().0.len(), 64);
    assert_eq!(rgb.knot_stops(), rgb.bake().0);
}

#[test]
fn min_equal_to_max_gives_a_flat_gradient() {
    for model in [NoiseModel::Rgb, NoiseModel::Hsb, NoiseModel::Lab] {
        let n = NoiseGradient { model, min: [0.2, 0.6, 0.4, 0.5], max: [0.2, 0.6, 0.4, 0.5], transparency: true, seed: 99, ..NoiseGradient::default() };
        let (colors, opacity) = n.bake();
        assert_eq!(colors.len(), 2);
        assert_eq!(colors[0].1, colors[1].1);
        assert_eq!(opacity, vec![(0.0, 0.5), (1.0, 0.5)]);
    }
    let n = NoiseGradient { min: [0.2, 0.6, 0.4, 0.0], max: [0.2, 0.6, 0.4, 1.0], ..NoiseGradient::default() };
    assert_eq!(n.bake().0, vec![(0.0, [0.2, 0.6, 0.4]), (1.0, [0.2, 0.6, 0.4])], "an RGB colour exactly");
}

#[test]
fn restrict_keeps_the_saturation_under_85_percent() {
    for seed in 0..40 {
        for model in [NoiseModel::Rgb, NoiseModel::Hsb, NoiseModel::Lab] {
            let n = NoiseGradient { roughness: 1.0, model, restrict: true, seed, ..NoiseGradient::default() };
            for (_, c) in n.bake().0 {
                let (max, min) = (c[0].max(c[1]).max(c[2]), c[0].min(c[1]).min(c[2]));
                let s = if max > 0.0 { (max - min) / max } else { 0.0 };
                assert!(s <= 0.85 + 1e-4, "seed {seed} {model:?}: {c:?} is {s} saturated");
            }
        }
    }
    // Without it the walk reaches fully saturated colours.
    let free = NoiseGradient { roughness: 1.0, seed: 3, ..NoiseGradient::default() };
    assert!(free.bake().0.iter().any(|(_, c)| {
        let (max, min) = (c[0].max(c[1]).max(c[2]), c[0].min(c[1]).min(c[2]));
        max > 0.0 && (max - min) / max > 0.85
    }));
}

#[test]
fn settings_round_trip_through_json_and_hostile_values_stay_in_range() {
    let n = NoiseGradient {
        roughness: 0.3,
        model: NoiseModel::Lab,
        min: [0.1, 0.2, 0.3, 0.4],
        max: [0.9, 0.8, 0.7, 0.6],
        restrict: true,
        transparency: true,
        seed: 12345,
    };
    assert_eq!(NoiseGradient::from_json(&n.to_json()).unwrap(), n);
    let p = NoiseGradient::from_json(&json!({"roughness": 250, "min": [-5, 50, 1e300], "seed": -1, "model": "HSB"})).unwrap();
    assert_eq!((p.roughness, p.min[..3].to_vec(), p.seed, p.model), (1.0, vec![0.0, 0.5, 1.0], u32::MAX, NoiseModel::Hsb));
    for bad in [json!(3), json!({"model": "cmyk"}), json!({"min": [1, 2]}), json!({"seed": "x"}), json!({"restrict": 1}), json!({"max": [0, 0, "a"]})] {
        assert!(NoiseGradient::from_json(&bad).is_err(), "{bad}");
    }
    let wild = NoiseGradient { roughness: f32::NAN, min: [f32::INFINITY, -3.0, f32::NAN, 2.0], max: [f32::NEG_INFINITY; 4], ..NoiseGradient::default() };
    let (c, o) = wild.bake();
    assert!(c.iter().all(|(t, c)| t.is_finite() && c.iter().all(|v| (0.0..=1.0).contains(v))));
    assert!(o.is_empty());
    let s = wild.sanitized();
    assert!(s.roughness == 0.5 && s.min.iter().chain(&s.max).all(|v| (0.0..=1.0).contains(v)));
    // Missing keys load (TOML has no null) and old records without noise stay without it.
    let back: NoiseGradient = serde_json::from_value(json!({"seed": 5})).unwrap();
    assert_eq!(back, NoiseGradient { seed: 5, ..NoiseGradient::default() });
}
