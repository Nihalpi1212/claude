//! Layer styles of Pigment 0.1–0.4 (`styles` of a layer, `shared/pixels/styles.js` and
//! `styles-more.js`) as PhotoCraft effects.
//!
//! The app's effects are Photoshop's, with its units: spread and choke in pixels (Photoshop's are
//! a percentage of the size, which is how they are converted), Bevel depth in percent, offsets of
//! gradients in percent of the box, colours whose alpha multiplies the opacity. 0.4 allowed
//! several drop shadows, inner shadows, colour and gradient overlays and strokes (an array, the
//! top one first, as PhotoCraft keeps them) and `hidden: true` for Hide All Effects.

use photocraft_color::{BlendMode, Color};
use photocraft_doc::Effects;
use photocraft_doc::adjust::CurvePoint;
use photocraft_doc::effects::{
    Bevel, BevelContour, BevelStyle, BevelTechnique, BevelTexture, Contour, Effect, FxCommon, FxPaint, Glow, GlowSource, GlowTechnique, Gradient,
    GradientStyle, Satin, Shadow, StrokeFx, StrokePosition,
};
use serde_json::{Map, Value};

use super::blend;
use super::gradient::{self, Def};
use super::paint::Patterns;

/// Instances of one effect read from a file (`MAX_INSTANCES` of styles.js).
const MAX_INSTANCES: usize = 10;
const KEYS: [&str; 10] =
    ["dropShadow", "innerShadow", "outerGlow", "innerGlow", "bevel", "satin", "colorOverlay", "gradientOverlay", "patternOverlay", "stroke"];

fn num(o: &Map<String, Value>, key: &str) -> Option<f64> {
    o.get(key).and_then(Value::as_f64).filter(|n| n.is_finite())
}

fn get(o: &Map<String, Value>, key: &str, default: f64, lo: f64, hi: f64) -> f32 {
    num(o, key).unwrap_or(default).clamp(lo, hi) as f32
}

fn flag(o: &Map<String, Value>, key: &str, default: bool) -> bool {
    o.get(key).and_then(Value::as_bool).unwrap_or(default)
}

/// A colour and the alpha it carries (which multiplies the effect's opacity).
fn color(o: &Map<String, Value>, key: &str, default: [f64; 3]) -> (Color, f32) {
    let c = o.get(key).and_then(gradient::parse_color).unwrap_or([default[0], default[1], default[2], 1.0]);
    let [r, g, b] = [c[0], c[1], c[2]].map(|v| (v.clamp(0.0, 255.0) / 255.0) as f32);
    (Color::rgb(r, g, b), c[3].clamp(0.0, 1.0) as f32)
}

/// The angle as PhotoCraft keeps it, -180..180.
fn angle(o: &Map<String, Value>, key: &str, default: f64) -> f32 {
    let a = num(o, key).unwrap_or(default).rem_euclid(360.0);
    (if a > 180.0 { a - 360.0 } else { a }) as f32
}

/// `contour` (`{ name?, points: [{ x, y, corner }] }`, `normalizeContour` of contour.js).
fn contour(v: Option<&Value>) -> Contour {
    let Some(points) = v.and_then(|v| v.get("points")).and_then(Value::as_array) else { return Contour::Linear };
    let mut pts: Vec<(f64, f64, bool)> = points
        .iter()
        .take(64)
        .filter_map(|p| {
            let (x, y) = (p.get("x")?.as_f64()?, p.get("y")?.as_f64()?);
            (x.is_finite() && y.is_finite()).then(|| (x.clamp(0.0, 1.0), y.clamp(0.0, 1.0), p.get("corner").and_then(Value::as_bool).unwrap_or(false)))
        })
        .collect();
    pts.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut out: Vec<(f64, f64, bool)> = Vec::new();
    for p in pts {
        match out.last_mut() {
            Some(last) if p.0 - last.0 < 1e-3 => *last = p,
            _ => out.push(p),
        }
    }
    if out.len() < 2 {
        return Contour::Linear;
    }
    out[0].0 = 0.0;
    if let Some(last) = out.last_mut() {
        last.0 = 1.0;
    }
    if out.len() == 2 && out[0].1 == 0.0 && out[1].1 == 1.0 {
        return Contour::Linear;
    }
    let name = v.and_then(|v| v.get("name")).and_then(Value::as_str).unwrap_or("Custom").chars().take(200).collect();
    Contour::Custom {
        name,
        points: out.iter().map(|p| CurvePoint { input: p.0 as f32, output: p.1 as f32 }).collect(),
        corners: out.iter().map(|p| p.2).collect(),
    }
}

/// The effects of a layer; `notes` gets one line for each thing that is not what the app showed.
pub(crate) struct StyleReader<'a> {
    pub(crate) patterns: &'a mut Patterns,
    pub(crate) notes: Vec<String>,
}

impl StyleReader<'_> {
    pub(crate) fn effects(&mut self, styles: &Map<String, Value>) -> Effects {
        let mut items = Vec::new();
        for key in KEYS {
            let list: Vec<&Map<String, Value>> = match styles.get(key) {
                Some(Value::Array(a)) => a.iter().take(MAX_INSTANCES).filter_map(Value::as_object).collect(),
                Some(Value::Object(o)) => vec![o],
                _ => continue,
            };
            for fx in list {
                if let Some(e) = self.effect(key, fx) {
                    items.push(e);
                }
            }
        }
        let known: Vec<&String> = styles.keys().filter(|k| !KEYS.contains(&k.as_str()) && *k != "hidden" && !k.starts_with('_')).collect();
        if !known.is_empty() {
            let names: Vec<String> = known.iter().take(5).map(|k| k.chars().take(40).collect()).collect();
            self.notes.push(format!("layer style settings that are not known were left out ({})", names.join(", ")));
        }
        Effects { enabled: !flag(styles, "hidden", false), items, psd_raw: None, reference: None }
    }

    fn blend(&mut self, o: &Map<String, Value>, key: &str, default: BlendMode) -> BlendMode {
        match o.get(key).and_then(Value::as_str) {
            None => default,
            Some(name) => blend::blend_mode(name).unwrap_or_else(|| {
                self.notes.push(format!("an effect's blend mode \"{}\" is not known; it blends as Normal", name.chars().take(40).collect::<String>()));
                BlendMode::Normal
            }),
        }
    }

    fn common(&mut self, o: &Map<String, Value>, blend: BlendMode, opacity: f64, alpha: f32) -> FxCommon {
        FxCommon { enabled: flag(o, "enabled", false), blend: self.blend(o, "blend", blend), opacity: get(o, "opacity", opacity, 0.0, 1.0) * alpha }
    }

    fn effect(&mut self, key: &str, o: &Map<String, Value>) -> Option<Effect> {
        Some(match key {
            "dropShadow" | "innerShadow" => {
                let (c, alpha) = color(o, "color", [0.0; 3]);
                let size = get(o, "size", 5.0, 0.0, 250.0);
                Shadow {
                    common: self.common(o, BlendMode::Multiply, 0.75, alpha),
                    color: c,
                    angle: angle(o, "angle", 120.0),
                    use_global_light: flag(o, "useGlobalLight", false),
                    distance: get(o, "distance", 5.0, 0.0, 30_000.0),
                    spread: fraction(num(o, "spread").or_else(|| num(o, "choke")).unwrap_or(0.0), size),
                    size,
                    contour: contour(o.get("contour")),
                    anti_alias: flag(o, "antiAlias", false),
                    noise: get(o, "noise", 0.0, 0.0, 1.0),
                    knocks_out: key == "dropShadow" && flag(o, "knocksOut", true),
                }
                .into_effect(key == "innerShadow")
            }
            "outerGlow" | "innerGlow" => {
                let inner = key == "innerGlow";
                let (c, alpha) = color(o, "color", [255.0, 255.0, 190.0]);
                let size = get(o, "size", 5.0, 0.0, 250.0);
                let paint = match (o.get("fill").and_then(Value::as_str), o.get("gradient")) {
                    (Some("gradient"), Some(g)) if g.is_object() => {
                        let def = Def::parse(g);
                        let (stops, opacity_stops) = def.fill_stops(false);
                        FxPaint::Gradient(Gradient { stops, opacity_stops, ..Gradient::default() })
                    }
                    _ => FxPaint::Color(c),
                };
                let glow = Glow {
                    common: self.common(o, BlendMode::Screen, 0.75, alpha),
                    paint,
                    technique: if o.get("technique").and_then(Value::as_str) == Some("precise") { GlowTechnique::Precise } else { GlowTechnique::Softer },
                    spread: fraction(num(o, if inner { "choke" } else { "spread" }).unwrap_or(0.0), size),
                    size,
                    contour: contour(o.get("contour")),
                    anti_alias: flag(o, "antiAlias", false),
                    range: get(o, "range", 0.5, 0.01, 1.0),
                    jitter: get(o, "jitter", 0.0, 0.0, 1.0),
                    noise: get(o, "noise", 0.0, 0.0, 1.0),
                    source: if o.get("source").and_then(Value::as_str) == Some("center") { GlowSource::Center } else { GlowSource::Edge },
                };
                if inner { Effect::InnerGlow(glow) } else { Effect::OuterGlow(glow) }
            }
            "bevel" => Effect::BevelEmboss(self.bevel(o)),
            "satin" => {
                let (c, alpha) = color(o, "color", [0.0; 3]);
                Effect::Satin(Satin {
                    common: self.common(o, BlendMode::Multiply, 0.5, alpha),
                    color: c,
                    angle: angle(o, "angle", 19.0),
                    distance: get(o, "distance", 11.0, 0.0, 250.0),
                    size: get(o, "size", 14.0, 0.0, 250.0),
                    contour: contour(o.get("contour")),
                    anti_alias: flag(o, "antiAlias", false),
                    invert: flag(o, "invert", true),
                })
            }
            "colorOverlay" => {
                let (c, alpha) = color(o, "color", [255.0, 0.0, 0.0]);
                Effect::ColorOverlay { common: self.common(o, BlendMode::Normal, 1.0, alpha), color: c }
            }
            "gradientOverlay" => {
                // 0.4: `gradient` (a version 2 definition); 0.3: the stops on the effect itself.
                let def = Def::parse(o.get("gradient").filter(|g| g.is_object()).unwrap_or(&Value::Object(o.clone())));
                let reverse = flag(o, "reverse", false) != turns_back(o);
                let (stops, opacity_stops) = def.fill_stops(reverse);
                Effect::GradientOverlay {
                    common: self.common(o, BlendMode::Normal, 1.0, 1.0),
                    gradient: placed(o, stops, opacity_stops, 90.0),
                    dither: flag(o, "dither", false),
                    interpolation: if def.method == gradient::Method::Classic { None } else { def.interpolation() },
                }
            }
            "patternOverlay" => {
                let (name, id) = self.pattern(o.get("pattern"))?;
                let origin = pair(o.get("origin"));
                Effect::PatternOverlay {
                    common: self.common(o, BlendMode::Normal, 1.0, 1.0),
                    name,
                    id,
                    scale: get(o, "scale", 1.0, 0.01, 10.0),
                    angle: angle(o, "angle", 0.0),
                    link: flag(o, "link", true),
                    phase: (origin.0 as f32, origin.1 as f32),
                }
            }
            "stroke" => {
                let (c, alpha) = color(o, "color", [0.0; 3]);
                let paint = match o.get("fill").and_then(Value::as_str) {
                    Some("gradient") => {
                        let def = Def::parse(o.get("gradient").unwrap_or(&Value::Null));
                        let (stops, opacity_stops) = def.fill_stops(flag(o, "reverse", false) != turns_back(o));
                        FxPaint::Gradient(placed(o, stops, opacity_stops, 90.0))
                    }
                    Some("pattern") => match self.pattern(o.get("pattern")) {
                        Some((name, id)) => FxPaint::Pattern { name, id, scale: get(o, "patternScale", 1.0, 0.01, 10.0) },
                        None => FxPaint::Color(c),
                    },
                    _ => FxPaint::Color(c),
                };
                Effect::Stroke(StrokeFx {
                    common: self.common(o, BlendMode::Normal, 1.0, if matches!(paint, FxPaint::Color(_)) { alpha } else { 1.0 }),
                    size: get(o, "size", 3.0, 0.0, 250.0),
                    position: match o.get("position").and_then(Value::as_str) {
                        Some("inside") => StrokePosition::Inside,
                        Some("center") => StrokePosition::Center,
                        _ => StrokePosition::Outside,
                    },
                    paint,
                    overprint: false,
                })
            }
            _ => return None,
        })
    }

    fn bevel(&mut self, o: &Map<String, Value>) -> Bevel {
        let (highlight_color, ha) = color(o, "highlightColor", [255.0; 3]);
        let (shadow_color, sa) = color(o, "shadowColor", [0.0; 3]);
        let highlight =
            FxCommon { enabled: true, blend: self.blend(o, "highlightBlend", BlendMode::Screen), opacity: get(o, "highlightOpacity", 0.75, 0.0, 1.0) * ha };
        let shadow =
            FxCommon { enabled: true, blend: self.blend(o, "shadowBlend", BlendMode::Multiply), opacity: get(o, "shadowOpacity", 0.75, 0.0, 1.0) * sa };
        let contour_sub = o.get("contourSub").and_then(Value::as_object).filter(|c| flag(c, "enabled", false));
        let texture = o.get("texture").and_then(Value::as_object).filter(|t| flag(t, "enabled", false));
        Bevel {
            enabled: flag(o, "enabled", false),
            style: match o.get("style").and_then(Value::as_str) {
                Some("outer-bevel") => BevelStyle::OuterBevel,
                Some("emboss") => BevelStyle::Emboss,
                Some("pillow-emboss") => BevelStyle::PillowEmboss,
                Some("stroke-emboss") => BevelStyle::StrokeEmboss,
                _ => BevelStyle::InnerBevel,
            },
            technique: match o.get("technique").and_then(Value::as_str) {
                Some("chisel-hard") => BevelTechnique::ChiselHard,
                Some("chisel-soft") => BevelTechnique::ChiselSoft,
                _ => BevelTechnique::Smooth,
            },
            depth: (num(o, "depth").unwrap_or(100.0).clamp(1.0, 1000.0) / 100.0) as f32,
            up: o.get("direction").and_then(Value::as_str) != Some("down"),
            size: get(o, "size", 5.0, 0.0, 250.0),
            soften: get(o, "soften", 0.0, 0.0, 16.0),
            angle: angle(o, "angle", 120.0),
            altitude: get(o, "altitude", 30.0, 0.0, 90.0),
            use_global_light: flag(o, "useGlobalLight", false),
            gloss_contour: contour(o.get("glossContour")),
            gloss_anti_alias: flag(o, "antiAlias", false),
            highlight,
            highlight_color,
            shadow,
            shadow_color,
            contour: contour_sub.map(|c| BevelContour {
                contour: contour(c.get("contour")),
                range: get(c, "range", 0.5, 0.01, 1.0),
                anti_alias: flag(c, "antiAlias", false),
            }),
            texture: texture.and_then(|t| {
                let (name, id) = self.pattern(t.get("pattern"))?;
                let origin = pair(t.get("origin"));
                Some(BevelTexture {
                    name,
                    id,
                    scale: get(t, "scale", 1.0, 0.01, 10.0),
                    depth: get(t, "depth", 1.0, -10.0, 10.0),
                    invert: flag(t, "invert", false),
                    link: flag(t, "link", true),
                    phase: (origin.0 as f32, origin.1 as f32),
                })
            }),
        }
    }

    /// A pattern an effect names: 0.3's data URL, or 0.4's `{ dataUrl, presetId?, name? }`.
    fn pattern(&mut self, v: Option<&Value>) -> Option<(String, String)> {
        let (url, name, preset) = match v? {
            Value::String(url) => (url.as_str(), None, None),
            Value::Object(o) => (o.get("dataUrl")?.as_str()?, o.get("name").and_then(Value::as_str), o.get("presetId").and_then(Value::as_str)),
            _ => return None,
        };
        match self.patterns.add_data_url(url, name, preset) {
            Ok(found) => Some(found),
            Err(why) => {
                self.notes.push(format!("an effect's pattern {why}; the effect was left out"));
                None
            }
        }
    }
}

trait IntoEffect {
    fn into_effect(self, inner: bool) -> Effect;
}

impl IntoEffect for Shadow {
    fn into_effect(self, inner: bool) -> Effect {
        if inner { Effect::InnerShadow(self) } else { Effect::DropShadow(self) }
    }
}

/// The app's Angle gradient of an effect turns counter-clockwise from its angle, PhotoCraft's
/// clockwise: the stops run backwards.
fn turns_back(o: &Map<String, Value>) -> bool {
    o.get("kind").and_then(Value::as_str) == Some("angle")
}

/// Spread or choke in pixels as Photoshop's percentage of the size.
fn fraction(px: f64, size: f32) -> f32 {
    if size <= 0.0 || !px.is_finite() { if px > 0.0 { 1.0 } else { 0.0 } } else { (px / f64::from(size)).clamp(0.0, 1.0) as f32 }
}

fn pair(v: Option<&Value>) -> (f64, f64) {
    let a = v.and_then(Value::as_array);
    let at = |i: usize| a.and_then(|a| a.get(i)).and_then(Value::as_f64).filter(|n| n.is_finite()).unwrap_or(0.0).clamp(-1.0e6, 1.0e6);
    (at(0), at(1))
}

/// A gradient effect's placement: `kind`, `angle` (counter-clockwise), `scale` (a fraction),
/// `offset` (percent of the box), `align`.
fn placed(o: &Map<String, Value>, stops: Vec<(f32, Color)>, opacity_stops: Vec<(f32, f32)>, default_angle: f64) -> Gradient {
    let (ox, oy) = pair(o.get("offset"));
    Gradient {
        stops,
        opacity_stops,
        style: match o.get("kind").and_then(Value::as_str) {
            Some("radial") => GradientStyle::Radial,
            Some("angle") => GradientStyle::Angle,
            Some("reflected") => GradientStyle::Reflected,
            Some("diamond") => GradientStyle::Diamond,
            _ => GradientStyle::Linear,
        },
        angle: angle(o, "angle", default_angle),
        scale: get(o, "scale", 1.0, 0.1, 1.5),
        // Reversed in the stops already.
        reverse: false,
        align: flag(o, "align", true),
        offset: ((ox / 100.0) as f32, (oy / 100.0) as f32),
    }
}
