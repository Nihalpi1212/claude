//! Blend mode names of Pigment 0.1–0.4 (`shared/pixels/blend.js`, `BLEND_MODES`): Photoshop's
//! names in kebab-case, plus `pass-through` on groups.

use photocraft_color::BlendMode;

/// The blend mode a Pigment 0.1–0.4 layer names, or `None` for a name that app never wrote.
pub(crate) fn blend_mode(name: &str) -> Option<BlendMode> {
    use BlendMode as B;
    Some(match name {
        "pass-through" => B::PassThrough,
        "normal" => B::Normal,
        "dissolve" => B::Dissolve,
        "darken" => B::Darken,
        "multiply" => B::Multiply,
        "color-burn" => B::ColorBurn,
        "linear-burn" => B::LinearBurn,
        "darker-color" => B::DarkerColor,
        "lighten" => B::Lighten,
        "screen" => B::Screen,
        "color-dodge" => B::ColorDodge,
        "linear-dodge" => B::LinearDodge,
        "lighter-color" => B::LighterColor,
        "overlay" => B::Overlay,
        "soft-light" => B::SoftLight,
        "hard-light" => B::HardLight,
        "vivid-light" => B::VividLight,
        "linear-light" => B::LinearLight,
        "pin-light" => B::PinLight,
        "hard-mix" => B::HardMix,
        "difference" => B::Difference,
        "exclusion" => B::Exclusion,
        "subtract" => B::Subtract,
        "divide" => B::Divide,
        "hue" => B::Hue,
        "saturation" => B::Saturation,
        "color" => B::Color,
        "luminosity" => B::Luminosity,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `BLEND_MODES` of `shared/pixels/blend.js` at Pigment 0.4.0, in its order.
    const JS_BLEND_MODES: [&str; 27] = [
        "normal",
        "dissolve",
        "darken",
        "multiply",
        "color-burn",
        "linear-burn",
        "darker-color",
        "lighten",
        "screen",
        "color-dodge",
        "linear-dodge",
        "lighter-color",
        "overlay",
        "soft-light",
        "hard-light",
        "vivid-light",
        "linear-light",
        "pin-light",
        "hard-mix",
        "difference",
        "exclusion",
        "subtract",
        "divide",
        "hue",
        "saturation",
        "color",
        "luminosity",
    ];

    #[test]
    fn every_blend_mode_of_the_javascript_app_maps_to_its_own_mode() {
        let mut seen = Vec::new();
        for name in JS_BLEND_MODES {
            let mode = blend_mode(name).unwrap_or_else(|| panic!("{name} has no mode"));
            assert!(!seen.contains(&mode), "{name} maps to a mode another name took");
            // Photoshop's label of the mode is the name with spaces and capitals.
            assert_eq!(mode.label().to_ascii_lowercase().replace(' ', "-").replace("(add)", "").trim_end_matches('-'), name, "{name}");
            seen.push(mode);
        }
        assert_eq!(blend_mode("pass-through"), Some(BlendMode::PassThrough));
        for name in ["", "Normal", "plus-lighter", "pass_through"] {
            assert_eq!(blend_mode(name), None, "{name}");
        }
    }
}
