use photocraft_color::{ColorMode, SampleType};
use photocraft_doc::{Adjustment, LayerContent};
use serde_json::{Value, json};

use super::*;
use crate::Session;
use crate::adjust_params::CurvesEyedropper;

fn rgb_transfer() -> Transfer {
    exposure_transfer(ColorMode::Rgb, SampleType::U8)
}

/// An 8-bit RGB value whose linear light (through Exposure's curve) is `lin`.
fn encoded(lin: f32) -> [f32; 3] {
    [rgb_transfer().encode(lin); 3]
}

fn exposure(adj: &Adjustment) -> (f32, f32, f32) {
    let Adjustment::Exposure { exposure, offset, gamma } = adj else { panic!("not Exposure: {adj:?}") };
    (*exposure, *offset, *gamma)
}

#[test]
fn exposure_eyedroppers_set_black_gray_and_white() {
    // Gray on a sample of 0.09 linear: +1 stop makes it 0.18.
    let gray = exposure_eyedropper(&json!({}), CurvesEyedropper::NeutralGray, encoded(0.09), rgb_transfer()).unwrap();
    assert_eq!(exposure(&gray), (1.0, 0.0, 1.0));
    // White: 2^e · 0.25 = 1.
    assert_eq!(exposure(&exposure_eyedropper(&json!({}), CurvesEyedropper::White, encoded(0.25), rgb_transfer()).unwrap()).0, 2.0);
    // Black: the offset takes the sample (after the current exposure) to 0.
    let (e, o, _) = exposure(&exposure_eyedropper(&json!({"exposure": 1}), CurvesEyedropper::Black, encoded(0.1), rgb_transfer()).unwrap());
    assert_eq!(e, 1.0, "black keeps Exposure");
    assert!((o + 0.2).abs() < 1e-3, "{o}");
    // The applied adjustment maps the sample where the picker said.
    let v = encoded(0.09);
    let mut buf = photocraft_compose::Buffer::filled(photocraft_geom::Rect::from_xywh(0, 0, 1, 1), [v[0], v[1], v[2], 1.0]);
    photocraft_compose::adjust::apply_with(&gray, &mut buf, Transfer::Srgb);
    assert!((rgb_transfer().decode(buf.px[0][0]) - 0.18).abs() < 0.003, "{:?}", buf.px[0]);
    // A black sample cannot be lifted; finite only.
    assert!(exposure_eyedropper(&json!({}), CurvesEyedropper::White, [0.0; 3], rgb_transfer()).is_err());
    assert!(exposure_eyedropper(&json!({}), CurvesEyedropper::White, [f32::NAN; 3], rgb_transfer()).is_err());
    // An offset already past the target.
    assert!(exposure_eyedropper(&json!({"offset": 0.5}), CurvesEyedropper::NeutralGray, encoded(0.09), rgb_transfer()).is_err());
}

fn range(p: &Value, key: &str) -> [f32; 4] {
    serde_json::from_value(p[key]["range"].clone()).unwrap()
}

#[test]
fn range_eyedroppers_pick_add_and_subtract() {
    // Pick: yellow is the yellows range, centred on 60°: the default bounds.
    let p = hue_saturation_eyedropper(&json!({}), RangeDropper::Pick, [1.0, 1.0, 0.0]).unwrap();
    assert_eq!(p["edit"], "yellows");
    assert_eq!(range(&p, "yellows"), [15.0, 45.0, 75.0, 105.0]);
    // An orange pick centres the reds on 30°.
    let p = hue_saturation_eyedropper(&json!({}), RangeDropper::Pick, [1.0, 0.5, 0.0]).unwrap();
    assert_eq!((p["edit"].as_str(), range(&p, "yellows")), (Some("yellows"), [-15.0, 15.0, 45.0, 75.0]), "30° rounds to the yellows");
    // Add: the reds widen to take 70° at full effect, the fall-off kept.
    let base = json!({"edit": "reds"});
    let yellowish = [1.0, 1.0 - 10.0 / 60.0, 0.0]; // hue 50°
    assert_eq!(hue_of(yellowish).map(f32::round), Some(50.0));
    let green_yellow = [1.0 - 10.0 / 60.0, 1.0, 0.0]; // hue 70°
    assert_eq!(hue_of(green_yellow).map(f32::round), Some(70.0));
    let p = hue_saturation_eyedropper(&base, RangeDropper::Add, green_yellow).unwrap();
    assert_eq!(p["edit"], "reds");
    let added = range(&p, "reds");
    assert_eq!(added, [-45.0, -15.0, 70.0, 100.0]);
    let adj = from_params("hueSaturation", &p, None, ColorMode::Rgb).unwrap();
    let Adjustment::HueSaturation { ranges, .. } = &adj else { panic!() };
    assert_eq!(ranges[0].weight(70.0), 1.0);
    // Subtract: 50° (inside the widened full-effect part, nearer its top) is cut out of it.
    let p = hue_saturation_eyedropper(&p, RangeDropper::Subtract, yellowish).unwrap();
    let narrowed = range(&p, "reds");
    let adj = from_params("hueSaturation", &p, None, ColorMode::Rgb).unwrap();
    let Adjustment::HueSaturation { ranges, .. } = &adj else { panic!() };
    assert_eq!(ranges[0].weight(50.0), 0.0, "{narrowed:?}");
    assert!(narrowed[3] - narrowed[0] < added[3] - added[0]);
    // In the fall-off the outer edge moves to the hue.
    assert_eq!(subtract_hue_from_range([-45.0, -15.0, 15.0, 45.0], 30.0), [-45.0, -15.0, 15.0, 30.0]);
    // Add from Master picks the sample's range first; Subtract from Master changes nothing.
    let p = hue_saturation_eyedropper(&json!({}), RangeDropper::Add, [0.0, 0.0, 1.0]).unwrap();
    assert_eq!(p["edit"], "blues");
    let p = hue_saturation_eyedropper(&json!({"edit": "master"}), RangeDropper::Subtract, [0.0, 0.0, 1.0]).unwrap();
    assert_eq!(p["edit"], "master");
    assert_eq!(range(&p, "blues"), [195.0, 225.0, 255.0, 285.0]);
    // A grey pick edits Master; Add of a grey changes nothing.
    assert_eq!(hue_saturation_eyedropper(&json!({"edit": "reds"}), RangeDropper::Pick, [0.5; 3]).unwrap()["edit"], "master");
    assert_eq!(hue_saturation_eyedropper(&json!({"edit": "reds"}), RangeDropper::Add, [0.5; 3]).unwrap()["edit"], "reds");
    // A range that would cover the circle is kept.
    let wide = [0.0, 100.0, 300.0, 340.0];
    assert_eq!(add_hue_to_range(wide, 350.0), wide);
    // Colorize has no ranges; bad edit names are refused.
    assert!(hue_saturation_eyedropper(&json!({"colorize": true}), RangeDropper::Pick, [1.0, 0.0, 0.0]).is_err());
    assert!(hue_saturation_eyedropper(&json!({"edit": "pinks"}), RangeDropper::Pick, [1.0, 0.0, 0.0]).is_err());
}

fn points(p: &Value, key: &str) -> Vec<[f32; 2]> {
    serde_json::from_value(p[key].clone()).unwrap()
}

#[test]
fn curves_on_image_adds_a_point_at_the_tone_and_moves_it() {
    // Mid grey: a point at 128 on the straight composite, dragged up 20 px = 10 levels.
    let p = on_image_curves(&json!({}), CurveChannel::Composite, [0.5; 3], -20.0, ColorMode::Rgb).unwrap();
    assert_eq!(points(&p, "points"), vec![[0.0, 0.0], [128.0, 138.0], [255.0, 255.0]]);
    // A second press near it moves that point, from where it is.
    let again = on_image_curves(&p, CurveChannel::Composite, [130.0 / 255.0; 3], 10.0, ColorMode::Rgb).unwrap();
    assert_eq!(points(&again, "points"), vec![[0.0, 0.0], [128.0, 133.0], [255.0, 255.0]]);
    // The red channel uses the sample's red; the composite its luma.
    let p = on_image_curves(&json!({}), CurveChannel::Color(0), [0.2, 0.9, 0.9], 0.0, ColorMode::Rgb).unwrap();
    assert_eq!(points(&p, "red"), vec![[0.0, 0.0], [51.0, 51.0], [255.0, 255.0]]);
    assert_eq!(points(&p, "points").len(), 2);
    let p = on_image_curves(&json!({}), CurveChannel::Composite, [1.0, 0.0, 0.0], 0.0, ColorMode::Rgb).unwrap();
    assert_eq!(points(&p, "points")[1][0], (0.2126f32 * 255.0).round());
    // On a bent curve the new point sits on the curve (output where the curve passes).
    let bent = json!({"points": [[0, 0], [64, 128], [255, 255]]});
    let p = on_image_curves(&bent, CurveChannel::Composite, [0.5; 3], 0.0, ColorMode::Rgb).unwrap();
    let pts = points(&p, "points");
    assert_eq!(pts.len(), 4);
    assert!(pts[2][1] > 160.0, "{pts:?}");
    // Dragging is clamped to the graph; Grayscale uses the gray curve; pencil, CMYK and red in Grayscale refused.
    let p = on_image_curves(&json!({}), CurveChannel::Composite, [0.5; 3], -1000.0, ColorMode::Rgb).unwrap();
    assert_eq!(points(&p, "points")[1], [128.0, 255.0]);
    let p = on_image_curves(&json!({}), CurveChannel::Composite, [0.25; 3], 0.0, ColorMode::Grayscale).unwrap();
    assert_eq!(points(&p, "points")[1][0], 64.0);
    assert!(on_image_curves(&json!({"pencil": true}), CurveChannel::Composite, [0.5; 3], 0.0, ColorMode::Rgb).is_err());
    assert!(on_image_curves(&json!({}), CurveChannel::Composite, [0.5; 3], 0.0, ColorMode::Cmyk).is_err());
    assert!(on_image_curves(&json!({}), CurveChannel::Color(0), [0.5; 3], 0.0, ColorMode::Grayscale).is_err());
    // A full curve takes no new point, but still moves its existing ones.
    let full: Vec<[u32; 2]> = (0..19).map(|i| [i * 14, i * 14]).collect();
    let full = json!({ "points": full });
    assert!(on_image_curves(&full, CurveChannel::Composite, [7.0 / 255.0; 3], 0.0, ColorMode::Rgb).is_err());
    assert!(on_image_curves(&full, CurveChannel::Composite, [14.0 / 255.0; 3], -4.0, ColorMode::Rgb).is_ok());
}

#[test]
fn hue_saturation_and_black_white_on_image_drags() {
    // Yellow: the yellows range, saturation + dx/2.
    let p = on_image_hue_sat(&json!({}), [1.0, 1.0, 0.0], 20.0, false).unwrap();
    assert_eq!(p["edit"], "yellows");
    assert_eq!(p["yellows"]["saturation"], 10.0);
    assert_eq!(p["saturation"], 0.0);
    // With hue: its hue.
    let p = on_image_hue_sat(&json!({}), [0.0, 0.0, 1.0], -30.0, true).unwrap();
    assert_eq!((p["edit"].as_str(), p["blues"]["hue"].as_f64()), (Some("blues"), Some(-15.0)));
    // A grey (under 5 % saturation) edits Master.
    let p = on_image_hue_sat(&json!({}), [0.5, 0.5, 0.51], 40.0, false).unwrap();
    assert_eq!((p["edit"].as_str(), p["saturation"].as_f64()), (Some("master"), Some(20.0)));
    // The range with the largest weight at the hue wins: reds widened to 70° take a 65° sample from the yellows.
    let base = json!({"reds": {"range": [-45, -15, 70, 100]}});
    let p = on_image_hue_sat(&base, [1.0 - 5.0 / 60.0, 1.0, 0.0], 10.0, false).unwrap();
    assert_eq!(p["edit"], "reds");
    // Clamped; colorize refused.
    assert_eq!(on_image_hue_sat(&json!({}), [1.0, 0.0, 0.0], 1000.0, false).unwrap()["reds"]["saturation"], 100.0);
    assert!(on_image_hue_sat(&json!({"colorize": true}), [1.0, 0.0, 0.0], 10.0, false).is_err());

    // Black & White: yellow drags the yellows slider (60 → 70).
    let p = on_image_black_white(&json!({}), [0.9, 0.85, 0.1], 20.0).unwrap();
    assert_eq!(p["yellows"], 70.0);
    assert_eq!(p["reds"], 40.0);
    assert_eq!(on_image_black_white(&json!({}), [0.0, 0.0, 1.0], -2000.0).unwrap()["blues"], -200.0);
    assert!(on_image_black_white(&json!({}), [0.5; 3], 20.0).is_err(), "grey has no slider");
}

/// A session with an 8×8 RGB document filled with `color`.
fn filled(color: [f32; 3]) -> Session {
    let mut s = Session::new();
    s.execute("file.new", json!({"width": 8, "height": 8})).unwrap();
    s.execute("edit.fill", json!({"color": color})).unwrap();
    s
}

fn top_adjustment(s: &Session) -> Adjustment {
    let d = s.active().unwrap();
    match &d.doc.layers.last().unwrap().content {
        LayerContent::Adjustment(adj) => adj.clone(),
        other => panic!("not an adjustment layer: {other:?}"),
    }
}

fn pixel(s: &mut Session) -> Vec<f32> {
    serde_json::from_value(s.execute("document.pixel", json!({"x": 2, "y": 2})).unwrap()).unwrap()
}

#[test]
fn the_tools_through_the_commands() {
    // Exposure's gray eyedropper on the image: one step, the sample becomes middle grey.
    let v = rgb_transfer().encode(0.09);
    let mut s = filled([v; 3]);
    let steps = s.active().unwrap().history.past_len();
    s.execute("image.adjustments.exposure", json!({"eyedropper": {"point": "gray", "at": [2, 2], "size": 3}})).unwrap();
    assert_eq!(s.active().unwrap().history.past_len(), steps + 1);
    let px = pixel(&mut s);
    assert!((rgb_transfer().decode(px[0]) - 0.18).abs() < 0.01, "{px:?}");

    // As a new adjustment layer, and through layer.setAdjustment (sampling below the layer: the same each time).
    let mut s = filled([v; 3]);
    s.execute("layer.newAdjustmentLayer.exposure", json!({"eyedropper": {"point": "white", "color": [v, v, v]}})).unwrap();
    assert!((exposure(&top_adjustment(&s)).0 - (1.0f32 / 0.09).log2()).abs() < 0.01);
    s.execute("layer.setAdjustment", json!({"eyedropper": {"point": "gray", "at": [1, 1]}})).unwrap();
    let first = exposure(&top_adjustment(&s)).0;
    assert!((first - 1.0).abs() < 0.03, "+1 stop on the 8-bit sample: {first}");
    s.execute("layer.setAdjustment", json!({"eyedropper": {"point": "gray", "at": [1, 1]}})).unwrap();
    assert_eq!(exposure(&top_adjustment(&s)).0, first, "sampled below the layer");

    // Hue/Saturation: the range eyedropper and the hand through a layer.
    let mut s = filled([1.0, 1.0, 0.0]);
    s.execute("layer.newAdjustmentLayer.hueSaturation", json!({"edit": "reds", "rangeEyedropper": {"mode": "add", "at": [1, 1]}})).unwrap();
    let Adjustment::HueSaturation { ranges, .. } = top_adjustment(&s) else { panic!() };
    assert_eq!(ranges[0].weight(60.0), 1.0, "reds widened to yellow");
    let steps = s.active().unwrap().history.past_len();
    s.execute("layer.setAdjustment", json!({"onImage": {"at": [1, 1], "drag": [-40, 0]}})).unwrap();
    assert_eq!(s.active().unwrap().history.past_len(), steps + 1);
    let Adjustment::HueSaturation { ranges, .. } = top_adjustment(&s) else { panic!() };
    assert_eq!(ranges[0].saturation, -20.0, "the widened reds weigh most at 60°");

    // Curves on the image: a point at the grey's tone, one history step, undo.
    let mut s = filled([0.5; 3]);
    let before = pixel(&mut s);
    s.execute("image.adjustments.curves", json!({"onImage": {"at": [2, 2], "drag": [0, -40]}})).unwrap();
    let after = pixel(&mut s);
    assert!((after[0] - before[0] - 20.0 / 255.0).abs() < 2.0 / 255.0, "{before:?} → {after:?}");
    s.execute("edit.undo", json!({})).unwrap();
    assert_eq!(pixel(&mut s), before);

    // Black & White as a new layer: the yellows slider.
    let mut s = filled([0.9, 0.85, 0.1]);
    s.execute("layer.newAdjustmentLayer.blackWhite", json!({"onImage": {"color": [0.9, 0.85, 0.1], "drag": [30, 0]}})).unwrap();
    let Adjustment::BlackWhite { weights, .. } = top_adjustment(&s) else { panic!() };
    assert_eq!(weights[1], 75.0);
}

#[test]
fn a_smart_filter_records_the_resolved_settings() {
    let mut s = filled([0.5; 3]);
    s.execute("layer.smartObjects.convertToSmartObject", json!({})).unwrap();
    s.execute("image.adjustments.curves", json!({"onImage": {"at": [2, 2], "drag": [0, -40]}})).unwrap();
    let px = pixel(&mut s);
    assert!(px[0] > 0.55, "the filter applies the moved point: {px:?}");
    let d = s.active().unwrap();
    let recorded = format!("{:?}", d.doc.layers);
    assert!(!recorded.contains("onImage"), "no tool keys in the smart filter's params");
}

#[test]
fn refusals_and_hostile_params() {
    let mut s = filled([0.5, 0.4, 0.3]);
    for (cmd, bad) in [
        ("image.adjustments.levels", json!({"onImage": {"at": [1, 1]}})),
        ("image.adjustments.exposure", json!({"rangeEyedropper": {"mode": "pick", "at": [1, 1]}})),
        ("image.adjustments.hueSaturation", json!({"rangeEyedropper": {"mode": "grab", "at": [1, 1]}})),
        ("image.adjustments.hueSaturation", json!({"rangeEyedropper": {"mode": "pick"}})),
        ("image.adjustments.hueSaturation", json!({"onImage": {"at": [99, 1]}})),
        ("image.adjustments.hueSaturation", json!({"onImage": {"at": [1, 1], "drag": [1]}})),
        ("image.adjustments.hueSaturation", json!({"onImage": {"at": [1, 1], "hue": "yes"}})),
        ("image.adjustments.curves", json!({"onImage": {"at": [1, 1], "channel": "cyan"}})),
        ("image.adjustments.exposure", json!({"eyedropper": {"point": "x", "at": [1, 1]}})),
        ("image.adjustments.exposure", json!({"eyedropper": {"point": "gray", "at": [1, 1], "size": 2}})),
        ("layer.newAdjustmentLayer.curves", json!({"onImage": {"color": [f64::MAX, 0, 0], "drag": [0, 1e308]}})),
    ] {
        assert!(s.execute(cmd, bad.clone()).is_err(), "{cmd} {bad}");
    }
    // A mask target is refused (the tools read the colour image).
    s.execute("layer.layerMask.revealAll", json!({})).unwrap();
    assert!(s.active().unwrap().doc.layers.last().unwrap().mask.is_some());
    assert!(s.execute("image.adjustments.curves", json!({"target": "mask", "onImage": {"at": [1, 1]}})).is_err());
    assert!(s.execute("image.adjustments.curves", json!({"target": "mask", "points": [[0, 0], [128, 140], [255, 255]]})).is_ok(), "upstream's mask edit");
    // Nothing above panics on any mix of hostile values.
    let wild = [json!(null), json!(1), json!("x"), json!([f64::MAX, -1]), json!({"at": [0, 0], "drag": [f64::MAX, f64::MIN]}), json!({"color": [1, 2, 3]})];
    for kind in ["curves", "hueSaturation", "blackWhite", "exposure", "levels"] {
        for key in ["onImage", "rangeEyedropper", "eyedropper", "edit"] {
            for v in &wild {
                let _ = s.execute(&format!("image.adjustments.{kind}"), json!({ key: v }));
                let _ = s.execute(&format!("layer.newAdjustmentLayer.{kind}"), json!({ key: v, "pencil": true }));
                let _ = s.execute("layer.setAdjustment", json!({ key: v }));
            }
        }
    }
}
