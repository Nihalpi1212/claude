//! Brush presets of the JavaScript Pigment (`renderer/lib/brush/preset.js`, `normalizeBrush`):
//! `{ brushVersion: 1, tip: { kind, size, hardness, sample: { blob, width, height }, angle,
//! roundness, flipX, flipY, spacing, spacingOn }, shapeDynamics, scattering, texture, dualBrush,
//! colorDynamics, transfer, brushPose, noise, wetEdges, buildUp, smoothCurves, protectTexture,
//! tool: { opacity, flow, blend, smoothing, color }, extras }`, and Pigment 0.4's flat objects
//! (`{ id, name, size, hardness, spacing, angle, roundness, flow }`, `brushFromLegacy`).
//!
//! Sizes are pixels and angles degrees; every other amount is a fraction 0..1 unless the JS
//! `RANGES` say otherwise. A missing key takes the JS default (`defaults()` of preset.js), not
//! PhotoCraft's. A sampled tip is a grey PNG side file (`tip-<sha1>.png`, the coverage as grey)
//! that the caller reads by name.

use photocraft_paint::brush::{Control, Dynamic, MaskMode, Pattern};
use photocraft_paint::tile::GrayTile;
use photocraft_paint::{BrushSettings, TipShape};
use serde_json::{Map, Value};

use super::container;

/// Pixel memory one tip may take when decoded.
const MAX_TIP_BYTES: u64 = 256 << 20;

fn num(o: &Map<String, Value>, k: &str, default: f64, lo: f64, hi: f64) -> f64 {
    let n = match o.get(k) {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) if !s.trim().is_empty() => s.trim().parse::<f64>().ok(),
        _ => None,
    };
    n.filter(|n| n.is_finite()).map_or(default, |n| n.clamp(lo, hi))
}

fn flag(o: &Map<String, Value>, k: &str, default: bool) -> bool {
    o.get(k).and_then(Value::as_bool).unwrap_or(default)
}

fn section<'a>(v: &'a Map<String, Value>, k: &str) -> Option<&'a Map<String, Value>> {
    v.get(k).and_then(Value::as_object)
}

/// A JS control (`'off'`, `'pen-pressure'`… or `{ type, fadeSteps }`).
fn control(v: Option<&Value>, notes: &mut Vec<String>, what: &str) -> (Control, u32) {
    let (kind, steps) = match v {
        Some(Value::String(s)) => (s.as_str(), 25.0),
        Some(Value::Object(o)) => (o.get("type").and_then(Value::as_str).unwrap_or("off"), num(o, "fadeSteps", 25.0, 1.0, 9999.0)),
        _ => ("off", 25.0),
    };
    let c = match kind {
        "fade" => Control::Fade,
        "pen-pressure" => Control::PenPressure,
        "pen-tilt" => Control::PenTilt,
        "stylus-wheel" => Control::StylusWheel,
        "rotation" => Control::Rotation,
        "initial-direction" => Control::InitialDirection,
        "direction" => Control::Direction,
        "off" => Control::Off,
        other => {
            notes.push(format!("{what}'s control \"{}\" has no equivalent; it is off", other.chars().take(40).collect::<String>()));
            Control::Off
        }
    };
    (c, steps.round() as u32)
}

/// A JS dynamic: `<jitter key>`, `<control key>` and an optional minimum key, all in 0..1.
fn dynamic(o: &Map<String, Value>, jitter: &str, ctl: &str, minimum: Option<&str>, notes: &mut Vec<String>, jitter_max: f64) -> Dynamic {
    let (control, fade_steps) = control(o.get(ctl), notes, ctl.trim_end_matches("Control"));
    Dynamic {
        jitter: num(o, jitter, 0.0, 0.0, jitter_max) as f32,
        control,
        fade_steps,
        minimum: minimum.map_or(0.0, |m| num(o, m, 0.0, 0.0, 1.0)) as f32,
        ..Dynamic::default()
    }
}

fn mask_mode(s: Option<&str>, default: MaskMode) -> MaskMode {
    match s {
        Some("multiply") => MaskMode::Multiply,
        Some("subtract") => MaskMode::Subtract,
        Some("darken") => MaskMode::Darken,
        Some("overlay") => MaskMode::Overlay,
        Some("color-dodge") => MaskMode::ColorDodge,
        Some("color-burn") => MaskMode::ColorBurn,
        Some("linear-burn") => MaskMode::LinearBurn,
        Some("hard-mix") => MaskMode::HardMix,
        Some("linear-height") => MaskMode::LinearHeight,
        Some("height") => MaskMode::Height,
        _ => default,
    }
}

/// A grey PNG as coverage 0..1 (grey times alpha).
fn grey_tile(png: &[u8]) -> Result<GrayTile, String> {
    let img = container::decode_png(png, MAX_TIP_BYTES)?;
    let px = |x: u32, y: u32| {
        let i = ((y * img.width + x) * 4) as usize;
        let [r, g, b, a] = [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]].map(f32::from);
        (0.299 * r + 0.587 * g + 0.114 * b) / 255.0 * (a / 255.0)
    };
    let t = GrayTile::from_fn(img.width, img.height, px);
    if t.is_valid() { Ok(t) } else { Err("is not a usable tip".into()) }
}

/// `data:image/png;base64,…` as bytes.
fn data_url(s: &str) -> Option<Vec<u8>> {
    let (head, body) = s.split_once(',')?;
    (head.starts_with("data:") && head.ends_with(";base64")).then(|| photocraft_paint::tile::b64_decode(body)).flatten()
}

/// A tip's sampled bitmap: the side file its `sample.blob` names, else its `dataUrl`.
fn sampled(t: &Map<String, Value>, tips: &mut dyn FnMut(&str) -> Option<Vec<u8>>, notes: &mut Vec<String>, what: &str) -> Option<TipShape> {
    let s = section(t, "sample")?;
    let blob = s.get("blob").and_then(Value::as_str).unwrap_or("");
    let bytes = (!blob.is_empty()).then(|| tips(blob)).flatten().or_else(|| s.get("dataUrl").and_then(Value::as_str).and_then(data_url));
    let Some(bytes) = bytes else {
        notes.push(format!("{what}'s sampled tip ({}) is missing; a round tip is used", blob.chars().take(80).collect::<String>()));
        return None;
    };
    match grey_tile(&bytes) {
        Ok(tile) => Some(TipShape::Sampled(tile)),
        Err(e) => {
            notes.push(format!("{what}'s sampled tip {e}; a round tip is used"));
            None
        }
    }
}

/// The tip of `tip` (Brush Tip Shape or the Dual Brush's): its shape and the numbers.
struct Tip {
    shape: TipShape,
    size: f32,
    hardness: f32,
    angle: f32,
    roundness: f32,
    spacing: f32,
}

fn tip(t: Option<&Map<String, Value>>, default_size: f64, tips: &mut dyn FnMut(&str) -> Option<Vec<u8>>, notes: &mut Vec<String>, what: &str) -> Tip {
    let empty = Map::new();
    let t = t.unwrap_or(&empty);
    let shape = match t.get("kind").and_then(Value::as_str).unwrap_or("computed") {
        "computed" => TipShape::Round,
        "sampled" => sampled(t, tips, notes, what).unwrap_or(TipShape::Round),
        other => {
            notes.push(format!("{what} is a {} tip, which has no equivalent; a round tip is used", other.chars().take(40).collect::<String>()));
            TipShape::Round
        }
    };
    Tip {
        shape,
        size: num(t, "size", default_size, 1.0, 5000.0) as f32,
        hardness: num(t, "hardness", 0.8, 0.0, 1.0) as f32,
        angle: num(t, "angle", 0.0, -180.0, 180.0) as f32,
        roundness: num(t, "roundness", 1.0, 0.01, 1.0) as f32,
        spacing: num(t, "spacing", 0.12, 0.01, 10.0) as f32,
    }
}

/// A brush preset of the JS app as PhotoCraft's brush settings, with one note for each setting
/// that is not what the app painted. `tips` reads a side file of the `brushes` kind by name
/// (`None` when it is missing).
pub(crate) fn to_brush(v: &Value, tips: &mut dyn FnMut(&str) -> Option<Vec<u8>>) -> (BrushSettings, Vec<String>) {
    let mut notes = Vec::new();
    let empty = Map::new();
    let o = v.as_object().unwrap_or(&empty);
    // Pigment 0.4's flat object (`brushFromLegacy`): the tip keys, and a preset's flow.
    if !o.get("tip").is_some_and(Value::is_object) && o.contains_key("size") {
        let tip_keys: Map<String, Value> =
            ["size", "hardness", "spacing", "angle", "roundness"].iter().filter_map(|k| o.get(*k).map(|v| (k.to_string(), v.clone()))).collect();
        let is_preset = (o.get("id").is_some_and(Value::is_string) || o.get("name").is_some_and(Value::is_string))
            && !o.contains_key("mode")
            && !o.contains_key("color")
            && !o.contains_key("opacity");
        let mut flat = serde_json::json!({ "tip": tip_keys });
        if is_preset {
            flat["tool"] = serde_json::json!({ "flow": o.get("flow").and_then(Value::as_f64).filter(|f| f.is_finite()).unwrap_or(1.0) });
        }
        let (b, n) = to_brush(&flat, tips);
        return (b, n);
    }

    let mut b = BrushSettings::default();
    let t = tip(section(o, "tip"), 24.0, tips, &mut notes, "the brush tip");
    b.tip = t.shape;
    b.size = t.size;
    b.hardness = t.hardness;
    b.angle = t.angle;
    b.roundness = t.roundness;
    b.spacing = t.spacing;
    let tip_obj = section(o, "tip").unwrap_or(&empty);
    b.spacing_enabled = flag(tip_obj, "spacingOn", true);
    b.flip_x = flag(tip_obj, "flipX", false);
    b.flip_y = flag(tip_obj, "flipY", false);

    if let Some(s) = section(o, "shapeDynamics") {
        let d = &mut b.shape_dynamics;
        d.enabled = flag(s, "enabled", false);
        d.size = dynamic(s, "sizeJitter", "sizeControl", Some("minimumDiameter"), &mut notes, 1.0);
        d.tilt_scale = num(s, "tiltScale", 0.0, 0.0, 2.0) as f32;
        d.angle = dynamic(s, "angleJitter", "angleControl", None, &mut notes, 1.0);
        d.roundness = dynamic(s, "roundnessJitter", "roundnessControl", None, &mut notes, 1.0);
        d.roundness.minimum = num(s, "minimumRoundness", 0.25, 0.0, 1.0) as f32;
        d.flip_x_jitter = flag(s, "flipXJitter", false);
        d.flip_y_jitter = flag(s, "flipYJitter", false);
        d.brush_projection = flag(s, "brushProjection", false);
    }
    if let Some(s) = section(o, "scattering") {
        let d = &mut b.scattering;
        d.enabled = flag(s, "enabled", false);
        d.scatter = dynamic(s, "scatter", "scatterControl", None, &mut notes, f64::from(photocraft_paint::brush::MAX_SCATTER));
        d.both_axes = flag(s, "bothAxes", false);
        d.count = num(s, "count", 1.0, 1.0, 16.0).round() as u32;
        d.count_jitter = dynamic(s, "countJitter", "countControl", None, &mut notes, 1.0);
    }
    if let Some(s) = section(o, "texture") {
        let d = &mut b.texture;
        d.enabled = flag(s, "enabled", false);
        d.invert = flag(s, "invert", false);
        d.scale = num(s, "scale", 1.0, 0.01, 10.0) as f32;
        d.brightness = (num(s, "brightness", 0.0, -150.0, 150.0) / 150.0) as f32;
        let c = num(s, "contrast", 0.0, -50.0, 100.0);
        d.contrast = (if c < 0.0 { c / 50.0 } else { c / 100.0 }) as f32;
        d.each_tip = flag(s, "eachTip", false);
        d.mode = mask_mode(s.get("mode").and_then(Value::as_str), MaskMode::Multiply);
        d.depth = num(s, "depth", 1.0, 0.0, 1.0) as f32;
        d.depth_jitter = dynamic(s, "depthJitter", "depthControl", Some("minimumDepth"), &mut notes, 1.0);
        let pattern = section(s, "pattern");
        let tile = pattern.and_then(|p| p.get("dataUrl")).and_then(Value::as_str).and_then(data_url).and_then(|png| grey_tile(&png).ok());
        match tile {
            Some(t) => d.pattern = Pattern::Tile(t),
            None if d.enabled => {
                let name = pattern.and_then(|p| p.get("name")).and_then(Value::as_str).unwrap_or("");
                notes.push(format!(
                    "the Texture's pattern {}was not kept with the preset; Texture is off",
                    if name.is_empty() { String::new() } else { format!("\"{name}\" ") }
                ));
                d.enabled = false;
            }
            None => {}
        }
    }
    if let Some(s) = section(o, "dualBrush") {
        let t = tip(section(s, "tip"), 25.0, tips, &mut notes, "the Dual Brush tip");
        let d = &mut b.dual_brush;
        d.enabled = flag(s, "enabled", false);
        d.mode = mask_mode(s.get("mode").and_then(Value::as_str), MaskMode::ColorBurn);
        d.flip = flag(s, "flip", false);
        d.tip = t.shape;
        d.size = t.size;
        d.hardness = t.hardness;
        d.roundness = t.roundness;
        d.angle = t.angle;
        d.spacing = t.spacing;
        d.scatter = num(s, "scatter", 0.0, 0.0, f64::from(photocraft_paint::brush::MAX_SCATTER)) as f32;
        d.both_axes = flag(s, "bothAxes", false);
        d.count = num(s, "count", 1.0, 1.0, 16.0).round() as u32;
        if num(s, "countJitter", 0.0, 0.0, 1.0) > 0.0 {
            notes.push("the Dual Brush's Count Jitter has no equivalent and was left out".into());
        }
    }
    if let Some(s) = section(o, "colorDynamics") {
        let d = &mut b.color_dynamics;
        d.enabled = flag(s, "enabled", false);
        d.per_tip = flag(s, "perTip", true);
        d.fg_bg = dynamic(s, "fbJitter", "fbControl", None, &mut notes, 1.0);
        d.hue_jitter = num(s, "hueJitter", 0.0, 0.0, 1.0) as f32;
        d.saturation_jitter = num(s, "saturationJitter", 0.0, 0.0, 1.0) as f32;
        d.brightness_jitter = num(s, "brightnessJitter", 0.0, 0.0, 1.0) as f32;
        d.purity = num(s, "purity", 0.0, -1.0, 1.0) as f32;
    }
    if let Some(s) = section(o, "transfer") {
        let d = &mut b.transfer;
        d.enabled = flag(s, "enabled", false);
        d.opacity = dynamic(s, "opacityJitter", "opacityControl", Some("minimumOpacity"), &mut notes, 1.0);
        d.flow = dynamic(s, "flowJitter", "flowControl", Some("minimumFlow"), &mut notes, 1.0);
        d.wetness = dynamic(s, "wetnessJitter", "wetnessControl", None, &mut notes, 1.0);
        d.mix = dynamic(s, "mixJitter", "mixControl", None, &mut notes, 1.0);
    }
    if let Some(s) = section(o, "brushPose") {
        let d = &mut b.pose;
        d.enabled = flag(s, "enabled", false);
        // The JS tilt is -1..1 of a quarter turn; PhotoCraft's is degrees.
        d.tilt_x = (num(s, "tiltX", 0.0, -1.0, 1.0) * 90.0) as f32;
        d.tilt_y = (num(s, "tiltY", 0.0, -1.0, 1.0) * 90.0) as f32;
        d.rotation = num(s, "rotation", 0.0, 0.0, 360.0) as f32;
        d.pressure = num(s, "pressure", 1.0, 0.0, 1.0) as f32;
        let tilt = flag(s, "overrideTilt", false);
        d.override_tilt_x = tilt;
        d.override_tilt_y = tilt;
        d.override_rotation = flag(s, "overrideRotation", false);
        d.override_pressure = flag(s, "overridePressure", false);
    }
    b.noise = flag(o, "noise", false);
    b.wet_edges = flag(o, "wetEdges", false);
    b.build_up = flag(o, "buildUp", false);
    b.protect_texture = flag(o, "protectTexture", false);
    if flag(o, "smoothCurves", false) {
        notes.push("Smoothing (of the stroke's curves) has no equivalent and was left out".into());
    }
    if let Some(t) = section(o, "tool") {
        if t.contains_key("opacity") {
            b.opacity = num(t, "opacity", 1.0, 0.01, 1.0) as f32;
        }
        if t.contains_key("flow") {
            b.flow = num(t, "flow", 1.0, 0.01, 1.0) as f32;
        }
        if let Some(m) = t.get("blend").and_then(Value::as_str) {
            match super::blend::blend_mode(m) {
                Some(mode) => b.mode = mode,
                None if m == "behind" => b.behind = true,
                None => notes.push(format!("the blend mode \"{}\" is not known; the brush paints Normal", m.chars().take(40).collect::<String>())),
            }
        }
        if t.contains_key("smoothing") {
            let s = num(t, "smoothing", 0.0, 0.0, 1.0) as f32;
            b.smoothing.amount = s;
            b.smoothing.enabled = s > 0.0;
        }
    }
    if o.get("extras").and_then(Value::as_object).is_some_and(|e| !e.is_empty()) {
        notes.push("settings of a later Pigment that this one does not know were left out".into());
    }
    (b, notes)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    fn no_tips(_: &str) -> Option<Vec<u8>> {
        None
    }

    /// A grey PNG (8-bit RGB, R = G = B) of `w × h` values.
    pub(crate) fn grey_png(w: u32, h: u32, v: &[u8]) -> Vec<u8> {
        use photocraft_codecs::{ChannelLayout, EncodeOptions, Format, Image, SampleType};
        let data: Vec<u8> = v.iter().flat_map(|g| [*g, *g, *g]).collect();
        let img = Image::from_raw(w, h, ChannelLayout::Rgb, SampleType::U8, data).unwrap();
        photocraft_codecs::encode(&img, Format::Png, &EncodeOptions::default()).unwrap()
    }

    #[test]
    fn the_js_schema_maps_tip_and_sections() {
        let png = grey_png(3, 2, &[0, 128, 255, 255, 128, 0]);
        let v = json!({
            "brushVersion": 1,
            "tip": {"kind": "sampled", "size": 40, "hardness": 0.3, "sample": {"blob": "tip-abc.png", "width": 3, "height": 2},
                    "angle": 30, "roundness": 0.5, "flipX": true, "spacing": 0.4, "spacingOn": false},
            "shapeDynamics": {"enabled": true, "sizeJitter": 0.5, "sizeControl": {"type": "pen-pressure", "fadeSteps": 10}, "minimumDiameter": 0.2,
                              "angleControl": "direction", "minimumRoundness": 0.4},
            "scattering": {"enabled": true, "scatter": 2, "bothAxes": true, "count": 3},
            "transfer": {"enabled": true, "opacityControl": "pen-pressure", "minimumOpacity": 0.1},
            "colorDynamics": {"enabled": true, "hueJitter": 0.25, "purity": -0.5},
            "brushPose": {"enabled": true, "tiltX": 0.5, "overrideTilt": true},
            "wetEdges": true,
            "tool": {"opacity": 0.6, "flow": 0.7, "blend": "multiply", "smoothing": 0.3}
        });
        let mut asked = Vec::new();
        let (b, notes) = to_brush(&v, &mut |name: &str| {
            asked.push(name.to_string());
            Some(png.clone())
        });
        assert!(notes.is_empty(), "{notes:?}");
        assert_eq!(asked, ["tip-abc.png"]);
        assert_eq!((b.size, b.hardness, b.spacing, b.angle, b.roundness), (40.0, 0.3, 0.4, 30.0, 0.5));
        assert!(b.flip_x && !b.flip_y && !b.spacing_enabled);
        let TipShape::Sampled(t) = &b.tip else { panic!("sampled tip") };
        assert_eq!((t.width, t.height), (3, 2));
        assert!((t.get(0, 0) - 0.0).abs() < 1e-3 && (t.get(2, 0) - 1.0).abs() < 1e-3 && (t.get(1, 0) - 128.0 / 255.0).abs() < 1e-2);
        let sd = &b.shape_dynamics;
        assert!(sd.enabled);
        assert_eq!((sd.size.jitter, sd.size.control, sd.size.fade_steps, sd.size.minimum), (0.5, Control::PenPressure, 10, 0.2));
        assert_eq!(sd.angle.control, Control::Direction);
        assert_eq!(sd.roundness.minimum, 0.4);
        assert!(b.scattering.enabled && b.scattering.both_axes);
        assert_eq!((b.scattering.scatter.jitter, b.scattering.count), (2.0, 3));
        assert_eq!((b.transfer.opacity.control, b.transfer.opacity.minimum), (Control::PenPressure, 0.1));
        assert_eq!((b.color_dynamics.hue_jitter, b.color_dynamics.purity), (0.25, -0.5));
        assert_eq!(b.pose.tilt_x, 45.0);
        assert!(b.pose.override_tilt_x && b.pose.override_tilt_y);
        assert!(b.wet_edges && !b.noise);
        assert_eq!((b.opacity, b.flow, b.mode), (0.6, 0.7, photocraft_doc::BlendMode::Multiply));
        assert_eq!(b.smoothing.amount, 0.3);
    }

    #[test]
    fn defaults_are_the_js_apps_and_values_are_clamped() {
        let (b, notes) = to_brush(&json!({"tip": {}}), &mut no_tips);
        assert!(notes.is_empty());
        assert_eq!((b.size, b.hardness, b.spacing, b.angle, b.roundness), (24.0, 0.8, 0.12, 0.0, 1.0));
        assert!(matches!(b.tip, TipShape::Round) && b.spacing_enabled);
        let (b, _) = to_brush(&json!({"tip": {"size": 1e9, "hardness": -3, "spacing": 0, "angle": 999, "roundness": 0}}), &mut no_tips);
        assert_eq!((b.size, b.hardness, b.spacing, b.angle, b.roundness), (5000.0, 0.0, 0.01, 180.0, 0.01));
        // Hostile values never panic.
        for v in [json!(null), json!([]), json!("x"), json!({"tip": "x", "shapeDynamics": 4, "tool": {"blend": 7}}), json!({"tip": {"size": "NaN"}})] {
            let _ = to_brush(&v, &mut no_tips);
        }
    }

    #[test]
    fn a_pigment_04_flat_preset_keeps_its_tip_and_flow() {
        let (b, _) = to_brush(
            &json!({"id": "u1", "name": "Mine", "size": 60, "hardness": 0.2, "spacing": 0.3, "angle": -45, "roundness": 0.7, "flow": 0.4}),
            &mut no_tips,
        );
        assert_eq!((b.size, b.hardness, b.spacing, b.angle, b.roundness, b.flow), (60.0, 0.2, 0.3, -45.0, 0.7, 0.4));
        // A preset without a flow takes the tool's full flow, as 0.4's Brushes panel did.
        let (b, _) = to_brush(&json!({"name": "No flow", "size": 10}), &mut no_tips);
        assert_eq!(b.flow, 1.0);
    }

    #[test]
    fn a_missing_tip_or_an_unknown_setting_is_reported() {
        let (b, notes) = to_brush(&json!({"tip": {"kind": "sampled", "sample": {"blob": "tip-gone.png"}}}), &mut no_tips);
        assert!(matches!(b.tip, TipShape::Round));
        assert!(notes.iter().any(|n| n.contains("tip-gone.png") && n.contains("missing")), "{notes:?}");
        let (b, notes) = to_brush(
            &json!({"tip": {"kind": "bristle"}, "texture": {"enabled": true, "pattern": {"presetId": "p1", "name": "Bricks"}}, "smoothCurves": true, "extras": {"x": 1}}),
            &mut no_tips,
        );
        assert!(!b.texture.enabled);
        assert_eq!(notes.len(), 4, "{notes:?}");
        assert!(notes[1].contains("\"Bricks\""));
        // The sample's data URL serves when the side file is gone.
        let png = grey_png(1, 1, &[200]);
        let url = format!("data:image/png;base64,{}", photocraft_paint::tile::b64_encode(&png));
        let (b, notes) = to_brush(&json!({"tip": {"kind": "sampled", "sample": {"blob": "", "dataUrl": url}}}), &mut no_tips);
        assert!(notes.is_empty() && matches!(b.tip, TipShape::Sampled(_)));
    }
}
