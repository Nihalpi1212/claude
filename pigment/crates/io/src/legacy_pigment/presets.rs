//! The presets of the JavaScript Pigment (0.1 to 0.5), one at a time, for Edit › Presets ›
//! Migrate Presets (`edit.presets.migratePresets` in the engine). The JS preset store kept each
//! kind as `<presets folder>/<kind>.json`: `{ format: 'pigment-presets', version: 1, kind,
//! kindVersion, groups, items, hidden }` (JS `renderer/lib/presets.js`), and a
//! `.pigment-bundle` carries the same items. This module is the public face of the document
//! importer's mappers ([`super`]) for each kind's `data`: it returns document and paint types,
//! as the io crate cannot see the engine's preset types.
//!
//! Every function takes the item's `data` as the JS app normalised it and never panics on
//! hostile values; what does not map is reported, one line each, where a function returns notes.

use photocraft_color::BlendMode;
use photocraft_doc::Effects;
use photocraft_doc::vector::Path;
use photocraft_doc::{Adjustment, Contour, NoiseGradient, Pattern};
use photocraft_paint::BrushSettings;
use serde_json::Value;

pub use super::gradient::{PresetStops, StopRef};

/// A gradient preset (`gradients` kind: JS `normalizeGradient` data, 0.3 stop lists or version
/// 2 definitions, noise included). See [`PresetStops`].
pub fn gradient(data: &Value) -> PresetStops {
    super::gradient::Def::parse(data).preset()
}

/// A noise gradient's settings, if `data` is one.
pub fn gradient_noise(data: &Value) -> Option<NoiseGradient> {
    super::gradient::Def::parse(data).noise
}

/// A layer style preset (`styles` kind: `{ styles, blend?, opacity?, fillOpacity? }`).
#[derive(Clone, Debug)]
pub struct Style {
    pub effects: Effects,
    pub blend: Option<BlendMode>,
    /// Layer opacity, 0..1.
    pub opacity: Option<f32>,
    /// Fill opacity, 0..1.
    pub fill_opacity: Option<f32>,
    /// The patterns the effects paint with (each with the id the effects name).
    pub patterns: Vec<Pattern>,
    pub notes: Vec<String>,
}

/// A layer style preset; `None` when `data` holds no `styles` object.
pub fn style(data: &Value) -> Option<Style> {
    let styles = data.get("styles")?.as_object()?;
    let mut patterns = super::paint::Patterns::default();
    let mut reader = super::styles::StyleReader { patterns: &mut patterns, notes: Vec::new() };
    let effects = reader.effects(styles);
    let mut notes = reader.notes;
    let fraction = |k: &str| data.get(k).and_then(Value::as_f64).filter(|v| v.is_finite()).map(|v| v.clamp(0.0, 1.0) as f32);
    let blend = data.get("blend").and_then(Value::as_str).and_then(|b| {
        let mode = super::blend::blend_mode(b);
        if mode.is_none() {
            notes.push(format!("the blend mode \"{}\" is not known and was left out", b.chars().take(40).collect::<String>()));
        }
        mode
    });
    Some(Style { effects, blend, opacity: fraction("opacity"), fill_opacity: fraction("fillOpacity"), patterns: patterns.list, notes })
}

/// A shape preset (`shapes` kind: `{ path: PathData }` in a 0..1 box), in the 0..100 box of
/// PhotoCraft's Shapes library. `None` when `data` holds no usable path.
pub fn shape(data: &Value) -> Option<Path> {
    let mut p = path(data.get("path")?)?;
    for sp in &mut p.subpaths {
        for k in &mut sp.knots {
            for pt in [&mut k.anchor, &mut k.in_ctrl, &mut k.out_ctrl] {
                pt.x *= 100.0;
                pt.y *= 100.0;
            }
        }
    }
    (!p.subpaths.is_empty()).then_some(p)
}

/// A JS `PathData` (`{ subpaths: [{ closed, op?, points }] }`) as it is.
pub fn path(data: &Value) -> Option<Path> {
    super::path::to_path(data)
}

/// An adjustment preset (`adjustment:<kind>` kinds: the adjustment's own params, as JS
/// adjustment layers kept them). `kind` is the JS kind (`curves`, `hue-saturation`…).
pub fn adjustment(kind: &str, params: &Value, notes: &mut Vec<String>) -> Adjustment {
    super::adjust::to_adjustment(kind, params, notes)
}

/// A contour preset (`contours` kind: `{ name, points: [{ x, y, corner }] }`, x and y 0..1).
pub fn contour(data: &Value) -> Contour {
    super::styles::contour(Some(data))
}

/// A brush preset (`brushes` kind: JS `normalizeBrush` data, or Pigment 0.4's flat brush
/// presets of `settings.brushPresets`). `tips` reads a sampled tip's side file by name.
pub fn brush(data: &Value, tips: &mut dyn FnMut(&str) -> Option<Vec<u8>>) -> (BrushSettings, Vec<String>) {
    super::brush::to_brush(data, tips)
}

/// A pattern preset's pixels (`patterns` kind: the PNG side file its `blob` names) as a
/// pattern called `name`. The id is the one [`Pattern::new`] gives these pixels and this name,
/// so migrating the same pattern twice gives the same pattern.
pub fn pattern(name: &str, png: &[u8]) -> Result<Pattern, String> {
    let img = super::container::decode_png(png, super::container::MAX_PATTERN_BYTES).map_err(|e| format!("the image {e}"))?;
    let mut list = super::paint::Patterns::default();
    list.add(img, Some(name)).map_err(|e| format!("the image {e}"))?;
    list.list.pop().ok_or_else(|| "the image could not be read".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_gradient_keeps_its_stops_and_references() {
        let g = gradient(&json!({"gradientVersion": 2, "type": "solid", "interpolation": "perceptual",
            "stops": [{"pos": 0, "color": {"ref": "fg"}}, {"pos": 0.5, "color": "#ff0000"}, {"pos": 1, "color": {"ref": "bg"}}],
            "opacityStops": [{"pos": 0, "opacity": 1}, {"pos": 1, "opacity": 0.25}]}));
        assert!(!g.sampled && g.noise.is_none());
        assert_eq!(g.colors.iter().map(|c| c.2).collect::<Vec<_>>(), [Some(StopRef::Foreground), None, Some(StopRef::Background)]);
        assert_eq!(g.colors[1].1, [1.0, 0.0, 0.0]);
        assert_eq!(g.opacity, [(0.0, 1.0), (1.0, 0.25)]);
        // A moved midpoint bends the segment: sampled.
        let g = gradient(&json!({"gradientVersion": 2, "stops": [{"pos": 0, "color": "#000000"}, {"pos": 1, "mid": 0.2, "color": "#ffffff"}]}));
        assert!(g.sampled && g.colors.len() > 10);
        // Noise: its settings, the bake as the stops.
        let g = gradient(&json!({"gradientVersion": 2, "type": "noise", "noise": {"roughness": 0.8, "seed": 9}}));
        assert!(g.noise.is_some() && !g.colors.is_empty());
        assert_eq!(gradient_noise(&json!({"gradientVersion": 2, "type": "noise"})).map(|n| n.seed), Some(1));
    }

    #[test]
    fn styles_shapes_contours_and_adjustments_map() {
        let s = style(&json!({"styles": {"dropShadow": {"enabled": true, "distance": 8}}, "blend": "multiply", "opacity": 0.5, "fillOpacity": 2})).unwrap();
        assert_eq!(s.effects.items.len(), 1);
        assert_eq!((s.blend, s.opacity, s.fill_opacity), (Some(BlendMode::Multiply), Some(0.5), Some(1.0)));
        assert!(style(&json!({"nope": 1})).is_none());
        let p = shape(&json!({"path": {"subpaths": [{"closed": true, "points": [{"x": 0, "y": 0}, {"x": 1, "y": 0}, {"x": 0.5, "y": 1}]}]}})).unwrap();
        assert_eq!(p.subpaths[0].knots[1].anchor.x, 100.0);
        assert!(shape(&json!({"path": {"subpaths": []}})).is_none() && shape(&json!(3)).is_none());
        let c = contour(&json!({"name": "Dip", "points": [{"x": 0, "y": 0}, {"x": 0.5, "y": 1, "corner": true}, {"x": 1, "y": 0}]}));
        assert!(matches!(c, Contour::Custom { ref name, ref points, .. } if name == "Dip" && points.len() == 3));
        let mut notes = Vec::new();
        assert!(matches!(adjustment("curves", &json!({"space": "rgb", "rgb": [[0, 0], [128, 160], [255, 255]]}), &mut notes), Adjustment::Curves { .. }));
    }

    #[test]
    fn a_pattern_is_the_same_pattern_twice() {
        let png = super::super::brush::tests::grey_png(2, 2, &[0, 255, 255, 0]);
        let a = pattern("Checks", &png).unwrap();
        let b = pattern("Checks", &png).unwrap();
        assert_eq!((a.id.clone(), a.width, a.name.as_str()), (b.id, 2, "Checks"));
        assert!(pattern("Bad", b"not a png").is_err());
    }
}
