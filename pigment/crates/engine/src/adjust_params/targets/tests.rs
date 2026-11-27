use photocraft_color::ColorMode;
use photocraft_doc::Adjustment;
use serde_json::json;

use super::{Targets, adjustment_eyedropper_with};
use crate::Session;
use crate::adjust_params::{CurvesEyedropper, adjustment_eyedropper};

const SAMPLE: [f32; 3] = [0.3, 0.35, 0.4];

fn coloured() -> Targets {
    Targets { shadow: [0.1, 0.05, 0.0], midtone: [0.6, 0.5, 0.4], highlight: [0.95, 0.9, 0.85] }
}

#[test]
fn default_targets_are_upstreams_eyedroppers() {
    for kind in ["levels", "curves"] {
        for picker in [CurvesEyedropper::Black, CurvesEyedropper::NeutralGray, CurvesEyedropper::White] {
            let want = adjustment_eyedropper(kind, &json!({}), picker, SAMPLE, ColorMode::Rgb).unwrap();
            let got = adjustment_eyedropper_with(kind, &json!({}), picker, SAMPLE, ColorMode::Rgb, &Targets::default()).unwrap();
            assert_eq!(got, want, "{kind} {picker:?}");
        }
    }
    // Any neutral midtone keeps the sample's brightness, as upstream's (and Photoshop's) grey picker does.
    let grey = Targets { midtone: [0.3; 3], ..Targets::default() };
    assert!(grey.neutral());
}

#[test]
fn black_and_white_map_the_sample_to_the_targets() {
    let t = coloured();
    let Adjustment::Levels { per_channel, .. } = adjustment_eyedropper_with("levels", &json!({}), CurvesEyedropper::Black, SAMPLE, ColorMode::Rgb, &t).unwrap()
    else {
        panic!("levels")
    };
    for ((c, s), out) in per_channel.iter().zip(SAMPLE).zip(t.shadow) {
        assert!((c.in_black - s).abs() < 1e-6 && (c.out_black - out).abs() < 1e-6, "{c:?}");
    }
    let Adjustment::Levels { per_channel, .. } = adjustment_eyedropper_with("levels", &json!({}), CurvesEyedropper::White, SAMPLE, ColorMode::Rgb, &t).unwrap()
    else {
        panic!("levels")
    };
    for ((c, s), out) in per_channel.iter().zip(SAMPLE).zip(t.highlight) {
        assert!((c.in_white - s).abs() < 1e-6 && (c.out_white - out).abs() < 1e-6, "{c:?}");
    }
    let Adjustment::Curves { per_channel, .. } = adjustment_eyedropper_with("curves", &json!({}), CurvesEyedropper::Black, SAMPLE, ColorMode::Rgb, &t).unwrap()
    else {
        panic!("curves")
    };
    for ((curve, s), out) in per_channel.iter().zip(SAMPLE).zip(t.shadow) {
        let first = curve.first().unwrap();
        assert!((first.input - s).abs() < 1e-3 && (first.output - out).abs() < 1e-6, "{curve:?}");
    }
    let Adjustment::Curves { per_channel, .. } = adjustment_eyedropper_with("curves", &json!({}), CurvesEyedropper::White, SAMPLE, ColorMode::Rgb, &t).unwrap()
    else {
        panic!("curves")
    };
    for ((curve, s), out) in per_channel.iter().zip(SAMPLE).zip(t.highlight) {
        let last = curve.last().unwrap();
        assert!((last.input - s).abs() < 1e-3 && (last.output - out).abs() < 1e-6, "{curve:?}");
    }
    // Grayscale: the target's luma on the composite.
    let Adjustment::Levels { master, .. } =
        adjustment_eyedropper_with("levels", &json!({}), CurvesEyedropper::Black, [0.2; 3], ColorMode::Grayscale, &t).unwrap()
    else {
        panic!("levels")
    };
    assert!((master.out_black - (0.299 * 0.1 + 0.587 * 0.05)).abs() < 1e-5, "{master:?}");
}

#[test]
fn a_coloured_midtone_target_gives_the_sample_that_colour() {
    let t = coloured();
    for kind in ["levels", "curves"] {
        let adj = adjustment_eyedropper_with(kind, &json!({}), CurvesEyedropper::NeutralGray, SAMPLE, ColorMode::Rgb, &t).unwrap();
        let mut buf = photocraft_compose::Buffer { rect: photocraft_geom::Rect::new(0, 0, 1, 1), px: vec![[SAMPLE[0], SAMPLE[1], SAMPLE[2], 1.0]] };
        photocraft_compose::adjust::apply(&adj, &mut buf);
        let out = buf.px[0];
        for (o, want) in out.iter().zip(t.midtone) {
            assert!((o - want).abs() < 0.02, "{kind}: {out:?} vs {:?}", t.midtone);
        }
    }
}

#[test]
fn the_eyedropper_param_reads_saved_and_given_targets() {
    let mut s = Session::new();
    s.execute("file.new", json!({"width": 4, "height": 4})).unwrap();
    s.execute("image.adjustments.autoOptions", json!({"options": {"shadowColor": "#141414"}, "saveAsDefaults": true})).unwrap();
    let saved = super::of_param(&s, &json!({})).unwrap();
    assert!((saved.shadow[0] - 20.0 / 255.0).abs() < 1e-6);
    let given = super::of_param(&s, &json!({"targets": {"highlight": "#f0f0f0"}})).unwrap();
    assert_eq!(given.shadow, saved.shadow);
    assert!((given.highlight[0] - 240.0 / 255.0).abs() < 1e-6);
    assert!(super::of_param(&s, &json!({"targets": {"shadow": "dark"}})).is_err());
    assert!(super::of_param(&s, &json!({"targets": 3})).is_err());
    assert_eq!(given.to_json()["highlight"], json!("#f0f0f0"));

    // Through the command: the saved shadow target becomes each channel's output black, so a pixel of the sampled
    // grey turns into the target.
    s.edit("setup", |doc, active| {
        let b = doc.bounds();
        let surf = doc.layer_mut(active.unwrap()).unwrap().surface_mut().unwrap();
        let fmt = surf.format();
        let data: Vec<f32> = (0..b.width() * b.height()).flat_map(|_| photocraft_raster::from_rgba(&fmt, [0.3, 0.3, 0.3, 1.0])).collect();
        surf.write_region(b, &data);
        Ok(())
    })
    .unwrap();
    s.execute("image.adjustments.levels", json!({"eyedropper": {"point": "black", "color": [0.3, 0.3, 0.3]}})).unwrap();
    let d = s.active().unwrap();
    let px = d.doc.layer(d.active_layer.unwrap()).unwrap().surface().unwrap().rgba(1, 1);
    assert!((px[0] - 20.0 / 255.0).abs() < 0.01, "{px:?}");
    // Given targets win over the saved ones (the dialog's targets for this session).
    let p = json!({"eyedropper": {"point": "black", "color": [0.3, 0.3, 0.3], "targets": {"shadow": "#000000"}}});
    let adj = crate::adjust_params::eyedropper_from_params(&s, "levels", &p).unwrap().unwrap();
    let Adjustment::Levels { per_channel, .. } = adj else { panic!("levels") };
    assert!(per_channel.iter().all(|c| c.out_black == 0.0));
}

#[test]
fn hostile_targets_never_panic() {
    let wild = Targets { shadow: [f32::NAN, 2.0, -1.0], midtone: [f32::INFINITY, 0.0, 0.5], highlight: [-3.0, 0.0, 9.0] };
    for kind in ["levels", "curves", "hueSaturation"] {
        for picker in [CurvesEyedropper::Black, CurvesEyedropper::NeutralGray, CurvesEyedropper::White] {
            for mode in [ColorMode::Rgb, ColorMode::Grayscale, ColorMode::Cmyk] {
                for t in [wild, coloured(), Targets { midtone: [1.0, 0.0, 0.0], ..Targets::default() }] {
                    for sample in [SAMPLE, [0.0; 3], [1.0; 3], [f32::NAN; 3]] {
                        let _ = adjustment_eyedropper_with(kind, &json!({"pencil": true}), picker, sample, mode, &t);
                    }
                }
            }
        }
    }
}
