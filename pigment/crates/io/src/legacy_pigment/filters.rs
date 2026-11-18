//! Smart filters of Pigment 0.1–0.4 (`layer.filters` of `SmartLayer` in
//! `renderer/lib/smart-object.js`): `{ kind, params, enabled }`, a kind of the app's filter
//! registry (`shared/pixels/filters.js` and the 0.3 tables) or `adjust:<kind>` for an adjustment.
//! Each becomes the PhotoCraft command that does the same, with that command's parameters, so the
//! smart object draws through PhotoCraft's own filters and stays editable. A kind PhotoCraft has
//! no counterpart for is left out and reported; the source and the other filters are kept.

use photocraft_color::BlendMode;
use photocraft_doc::SmartFilter;
use photocraft_doc::adjust::{Adjustment, CurvePoint, LevelsChannel, ToneSpace};
use serde_json::{Map, Value, json};

use super::{adjust, blend};

fn num(p: &Map<String, Value>, key: &str, default: f64) -> f64 {
    p.get(key).and_then(Value::as_f64).filter(|n| n.is_finite()).unwrap_or(default)
}

fn text<'a>(p: &'a Map<String, Value>, key: &str, default: &'a str) -> &'a str {
    p.get(key).and_then(Value::as_str).unwrap_or(default)
}

/// The command and parameters of filter `kind` with the app's `p` (merged over its defaults, as
/// `applyFilter` merged them); `None` when PhotoCraft has no such filter.
fn filter(kind: &str, p: &Map<String, Value>) -> Option<(String, Value)> {
    let n = |key: &str, default: f64| num(p, key, default);
    let (id, params) = match kind {
        "gaussian-blur" => ("filter.blur.gaussianBlur", json!({"radius": n("radius", 2.0).clamp(0.1, 1000.0)})),
        "box-blur" => ("filter.blur.boxBlur", json!({"radius": n("radius", 3.0).clamp(1.0, 2000.0)})),
        "motion-blur" => ("filter.blur.motionBlur", json!({"angle": n("angle", 0.0).clamp(-360.0, 360.0), "distance": n("distance", 10.0).clamp(1.0, 2000.0)})),
        "radial-blur" => {
            let center = p.get("center").and_then(Value::as_object);
            let c = |key: &str| center.map_or(0.5, |c| num(c, key, 0.5)).clamp(0.0, 1.0);
            let method = if text(p, "method", "spin") == "zoom" { "zoom" } else { "spin" };
            ("filter.blur.radialBlur", json!({"amount": n("amount", 10.0).clamp(1.0, 100.0), "method": method, "centerX": c("x"), "centerY": c("y")}))
        }
        "surface-blur" => {
            ("filter.blur.surfaceBlur", json!({"radius": n("radius", 5.0).clamp(1.0, 100.0), "threshold": n("threshold", 15.0).clamp(2.0, 255.0)}))
        }
        // The app's Sharpen was an Unsharp Mask of radius 1 with the amount it was given.
        "sharpen" => ("filter.sharpen.unsharpMask", json!({"amount": n("amount", 50.0).clamp(1.0, 500.0), "radius": 1.0, "threshold": 0.0})),
        "unsharp-mask" => (
            "filter.sharpen.unsharpMask",
            json!({"amount": n("amount", 100.0).clamp(1.0, 500.0), "radius": n("radius", 1.0).clamp(0.1, 1000.0), "threshold": n("threshold", 0.0).clamp(0.0, 255.0)}),
        ),
        "smart-sharpen" => (
            "filter.sharpen.smartSharpen",
            json!({"amount": n("amount", 100.0).clamp(1.0, 500.0), "radius": n("radius", 1.0).clamp(0.1, 64.0), "reduceNoise": n("reduceNoise", 10.0).clamp(0.0, 100.0)}),
        ),
        "high-pass" => ("filter.other.highPass", json!({"radius": n("radius", 10.0).clamp(0.1, 1000.0)})),
        "add-noise" => (
            "filter.noise.addNoise",
            json!({
                "amount": n("amount", 12.5).clamp(0.1, 400.0),
                "distribution": if text(p, "distribution", "uniform") == "gaussian" { "gaussian" } else { "uniform" },
                "monochromatic": p.get("monochromatic").and_then(Value::as_bool).unwrap_or(false),
                "seed": n("seed", 1.0).clamp(0.0, f64::from(u32::MAX)).round(),
            }),
        ),
        "median" => ("filter.noise.median", json!({"radius": n("radius", 1.0).clamp(1.0, 500.0)})),
        "despeckle" => ("filter.noise.despeckle", json!({})),
        "dust-scratches" => {
            ("filter.noise.dustAndScratches", json!({"radius": n("radius", 1.0).clamp(1.0, 500.0), "threshold": n("threshold", 0.0).clamp(0.0, 255.0)}))
        }
        "mosaic" => ("filter.pixelate.mosaic", json!({"cellSize": n("size", 10.0).clamp(2.0, 200.0)})),
        "fragment" => ("filter.pixelate.fragment", json!({})),
        "facet" => ("filter.pixelate.facet", json!({})),
        "emboss" => (
            "filter.stylize.emboss",
            json!({"angle": n("angle", 135.0).clamp(-180.0, 180.0), "height": n("height", 3.0).clamp(1.0, 100.0), "amount": n("amount", 100.0).clamp(1.0, 500.0)}),
        ),
        "find-edges" => ("filter.stylize.findEdges", json!({})),
        "solarize" => ("filter.stylize.solarize", json!({})),
        "maximum" => ("filter.other.maximum", json!({"radius": n("radius", 1.0).clamp(0.2, 500.0)})),
        "minimum" => ("filter.other.minimum", json!({"radius": n("radius", 1.0).clamp(0.2, 500.0)})),
        "offset" => {
            let undefined = if p.get("wrap").and_then(Value::as_bool).unwrap_or(true) {
                "wrap"
            } else if text(p, "edge", "transparent") == "repeat" {
                "repeat"
            } else {
                "transparent"
            };
            (
                "filter.other.offset",
                json!({"horizontal": n("dx", 0.0).clamp(-1.0e6, 1.0e6).round(), "vertical": n("dy", 0.0).clamp(-1.0e6, 1.0e6).round(), "undefinedAreas": undefined}),
            )
        }
        "twirl" => ("filter.distort.twirl", json!({"angle": n("angle", 50.0).clamp(-999.0, 999.0)})),
        "pinch" => ("filter.distort.pinch", json!({"amount": n("amount", 50.0).clamp(-100.0, 100.0)})),
        "spherize" => ("filter.distort.spherize", json!({"amount": n("amount", 100.0).clamp(-100.0, 100.0)})),
        "ripple" => {
            let size = match text(p, "size", "medium") {
                "small" => "small",
                "large" => "large",
                _ => "medium",
            };
            ("filter.distort.ripple", json!({"amount": n("amount", 100.0).clamp(-999.0, 999.0), "size": size}))
        }
        "polar" => {
            let to_polar = p.get("toPolar").and_then(Value::as_bool).unwrap_or(true);
            ("filter.distort.polarCoordinates", json!({"mode": if to_polar { "rectangularToPolar" } else { "polarToRectangular" }}))
        }
        // 0.3's filters without settings.
        "blur" => ("filter.blur.blur", json!({})),
        "blur-more" => ("filter.blur.blurMore", json!({})),
        "sharpen-more" => ("filter.sharpen.sharpenMore", json!({})),
        "sharpen-edges" => ("filter.sharpen.sharpenEdges", json!({})),
        _ => return None,
    };
    Some((id.to_string(), params))
}

fn levels_obj(c: &LevelsChannel) -> Value {
    let q = |v: f32| (f64::from(v) * 255.0 * 100.0).round() / 100.0;
    json!({"inBlack": q(c.in_black), "gamma": (f64::from(c.gamma) * 1000.0).round() / 1000.0, "inWhite": q(c.in_white), "outBlack": q(c.out_black), "outWhite": q(c.out_white)})
}

fn channel_keys(space: ToneSpace) -> &'static [&'static str] {
    match space {
        ToneSpace::Rgb => &["red", "green", "blue"],
        ToneSpace::Cmyk => &["cyan", "magenta", "yellow", "black"],
        ToneSpace::Lab => &["lightness", "a", "b"],
    }
}

fn curve(c: &[CurvePoint]) -> Value {
    let c: Vec<CurvePoint> = if c.len() >= 2 { c.to_vec() } else { vec![CurvePoint { input: 0.0, output: 0.0 }, CurvePoint { input: 1.0, output: 1.0 }] };
    json!(c.iter().map(|p| [(f64::from(p.input) * 25_500.0).round() / 100.0, (f64::from(p.output) * 25_500.0).round() / 100.0]).collect::<Vec<_>>())
}

/// A drawn curve: its 256 outputs, when it is a full table.
fn table(c: &[CurvePoint]) -> Option<Value> {
    (c.len() == 256).then(|| json!(c.iter().map(|p| (f64::from(p.output) * 25_500.0).round() / 100.0).collect::<Vec<_>>()))
}

fn hex(c: [f32; 3]) -> String {
    let b = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", b(c[0]), b(c[1]), b(c[2]))
}

const HUE_RANGES: [&str; 6] = ["reds", "yellows", "greens", "cyans", "blues", "magentas"];
const SELECTIVE_RANGES: [&str; 9] = ["reds", "yellows", "greens", "cyans", "blues", "magentas", "whites", "neutrals", "blacks"];

/// The `image.adjustments.<kind>` command and its parameters (what `adjust_params::to_params` in
/// the engine writes) for an adjustment; `None` for one that has no command parameters for it.
fn adjustment(a: &Adjustment) -> Option<(&'static str, Value)> {
    Some(match a {
        Adjustment::Invert => ("invert", json!({})),
        Adjustment::BrightnessContrast { brightness, contrast, legacy } => {
            ("brightnessContrast", json!({"brightness": brightness, "contrast": contrast, "legacy": legacy}))
        }
        Adjustment::Threshold { level } => ("threshold", json!({"level": (level * 255.0).round().clamp(1.0, 255.0)})),
        Adjustment::Posterize { levels } => ("posterize", json!({"levels": levels})),
        Adjustment::Exposure { exposure, offset, gamma } => ("exposure", json!({"exposure": exposure, "offset": offset, "gamma": gamma})),
        Adjustment::Vibrance { vibrance, saturation } => ("vibrance", json!({"vibrance": vibrance, "saturation": saturation})),
        Adjustment::HueSaturation { hue, saturation, lightness, colorize, ranges } => {
            let mut v = json!({"hue": hue, "saturation": saturation, "lightness": lightness, "colorize": colorize});
            for (key, r) in HUE_RANGES.iter().zip(ranges.iter()) {
                v[*key] = json!({"hue": r.hue, "saturation": r.saturation, "lightness": r.lightness, "range": r.bounds});
            }
            ("hueSaturation", v)
        }
        Adjustment::Levels { master, per_channel, space, black } => {
            let mut v = levels_obj(master);
            for (key, c) in channel_keys(*space).iter().zip([&per_channel[0], &per_channel[1], &per_channel[2], black]) {
                v[*key] = levels_obj(c);
            }
            // No composite in Lab: the top-level keys are the lightness channel.
            if *space == ToneSpace::Lab
                && let (Value::Object(top), Some(rest)) = (levels_obj(&per_channel[0]), v.as_object_mut())
            {
                rest.extend(top);
            }
            ("levels", v)
        }
        Adjustment::Curves { master, per_channel, space, black, pencil } => {
            let arr = |c: &[CurvePoint]| if *pencil { table(c).unwrap_or_else(|| curve(c)) } else { curve(c) };
            let mut v = json!({"points": arr(master)});
            let chans = per_channel.iter().map(Vec::as_slice).chain(std::iter::once(black.as_slice()));
            for (key, c) in channel_keys(*space).iter().zip(chans) {
                v[*key] = arr(c);
            }
            if *space == ToneSpace::Lab {
                v["points"] = arr(&per_channel[0]);
            }
            if *pencil {
                v["pencil"] = json!(true);
            }
            ("curves", v)
        }
        Adjustment::ColorBalance { shadows, midtones, highlights, preserve_luminosity } => {
            ("colorBalance", json!({"shadows": shadows, "midtones": midtones, "highlights": highlights, "preserveLuminosity": preserve_luminosity}))
        }
        Adjustment::BlackWhite { weights, tint } => {
            let mut v = json!({"tint": tint.is_some(), "tintColor": hex(tint.unwrap_or([0.882, 0.827, 0.702]))});
            for (key, w) in HUE_RANGES.iter().zip(weights.iter()) {
                v[*key] = json!(w);
            }
            ("blackWhite", v)
        }
        Adjustment::PhotoFilter { color, density, preserve_luminosity } => {
            ("photoFilter", json!({"color": hex(*color), "density": (f64::from(*density) * 1000.0).round() / 10.0, "preserveLuminosity": preserve_luminosity}))
        }
        Adjustment::ChannelMixer { matrix, monochrome } => {
            let row = |r: &[f32; 4]| json!(r.map(|x| (f64::from(x) * 1000.0).round() / 10.0));
            let mut v = json!({"red": row(&matrix[0]), "green": row(&matrix[1]), "blue": row(&matrix[2]), "monochrome": monochrome});
            if *monochrome {
                v["gray"] = row(&matrix[0]);
            }
            ("channelMixer", v)
        }
        Adjustment::GradientMap { stops, reverse, dither, .. } if (2..=64).contains(&stops.len()) => {
            ("gradientMap", json!({"stops": stops.iter().map(|(t, c)| json!([t, hex(*c)])).collect::<Vec<_>>(), "reverse": reverse, "dither": dither}))
        }
        Adjustment::SelectiveColor { relative, adjustments } => {
            let mut v = json!({"method": if *relative { "relative" } else { "absolute" }});
            for (i, key) in SELECTIVE_RANGES.iter().enumerate() {
                v[*key] = json!(adjustments[i]);
            }
            ("selectiveColor", v)
        }
        _ => return None,
    })
}

/// The smart filters of a smart object; what cannot be converted is said in `notes`.
pub(crate) fn smart_filters(list: &[Value], notes: &mut Vec<String>) -> Vec<SmartFilter> {
    let empty = Map::new();
    let mut out = Vec::new();
    let mut left_out: Vec<String> = Vec::new();
    for f in list.iter().take(256) {
        let Some(kind) = f.get("kind").and_then(Value::as_str) else { continue };
        let p = f.get("params").and_then(Value::as_object).unwrap_or(&empty);
        let converted = match kind.strip_prefix("adjust:") {
            Some(adj) => {
                let mut adjust_notes = Vec::new();
                let a = adjust::to_adjustment(adj, &Value::Object(p.clone()), &mut adjust_notes);
                adjustment(&a).map(|(id, params)| (format!("image.adjustments.{id}"), params))
            }
            None => filter(kind, p),
        };
        let Some((command, params)) = converted else {
            let shown: String = kind.chars().take(40).collect();
            if !left_out.contains(&shown) {
                left_out.push(shown);
            }
            continue;
        };
        // 0.4 kept no blend mode or opacity per filter (`normaliseFilter`); read them if a file has them.
        let blend = f.get("blend").and_then(Value::as_str).and_then(blend::blend_mode).unwrap_or(BlendMode::Normal);
        let opacity = f.get("opacity").and_then(Value::as_f64).filter(|o| o.is_finite()).map_or(1.0, |o| o.clamp(0.0, 1.0) as f32);
        out.push(SmartFilter { command, params, blend, opacity, visible: f.get("enabled").and_then(Value::as_bool) != Some(false) });
    }
    if !left_out.is_empty() {
        let names = left_out.iter().map(|k| format!("\"{k}\"")).collect::<Vec<_>>().join(", ");
        notes.push(format!("smart filters Pigment does not have were left out: {names}"));
    }
    if !out.is_empty() {
        notes.push("the smart filters are drawn by Pigment's own filters, so the result can differ a little from Pigment 0.4's".into());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_map_to_commands_and_unknown_ones_are_reported() {
        let list = json!([
            {"kind": "gaussian-blur", "params": {"radius": 1.5}, "enabled": true},
            {"kind": "unsharp-mask", "params": {"amount": 80, "radius": 1, "threshold": 2}, "enabled": true},
            {"kind": "adjust:levels", "params": {"rgb": {"inBlack": 20, "inWhite": 220, "gamma": 1.4, "outBlack": 0, "outWhite": 255}}, "enabled": true},
            {"kind": "adjust:invert", "params": {}, "enabled": false},
            {"kind": "glowing-edges", "params": {}, "enabled": true},
            {"kind": "offset", "params": {"dx": 3, "dy": -2, "wrap": false, "edge": "repeat"}},
            {"params": {}},
        ]);
        let mut notes = Vec::new();
        let f = smart_filters(list.as_array().unwrap(), &mut notes);
        let ids: Vec<&str> = f.iter().map(|f| f.command.as_str()).collect();
        assert_eq!(
            ids,
            ["filter.blur.gaussianBlur", "filter.sharpen.unsharpMask", "image.adjustments.levels", "image.adjustments.invert", "filter.other.offset"]
        );
        assert_eq!(f[0].params, json!({"radius": 1.5}));
        assert_eq!(f[1].params, json!({"amount": 80.0, "radius": 1.0, "threshold": 2.0}));
        assert_eq!((f[2].params["inBlack"].as_f64(), f[2].params["inWhite"].as_f64(), f[2].params["gamma"].as_f64()), (Some(20.0), Some(220.0), Some(1.4)));
        assert!(!f[3].visible && f[2].visible);
        assert_eq!(f[4].params, json!({"horizontal": 3.0, "vertical": -2.0, "undefinedAreas": "repeat"}));
        assert!(notes[0].contains("\"glowing-edges\""), "{notes:?}");
    }

    #[test]
    fn every_adjustment_kind_has_command_parameters() {
        for kind in [
            "brightness-contrast",
            "levels",
            "curves",
            "exposure",
            "vibrance",
            "hue-saturation",
            "color-balance",
            "black-white",
            "photo-filter",
            "channel-mixer",
            "invert",
            "posterize",
            "threshold",
            "gradient-map",
            "selective-color",
        ] {
            let a = adjust::to_adjustment(kind, &json!({}), &mut Vec::new());
            assert!(adjustment(&a).is_some(), "{kind}");
        }
    }
}
