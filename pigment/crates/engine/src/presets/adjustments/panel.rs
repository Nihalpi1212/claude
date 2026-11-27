//! The Adjustments panel's adjustment presets (Pigment): Photoshop's "Adjustment Presets" groups
//! under the panel's icons, as the JavaScript Pigment had them (`ADJUSTMENT_PANEL_PRESETS`,
//! `adjust/color-formats.js`). A preset adds one or several adjustment layers above the active
//! layer in one history step, grouped in a layer group named after the preset when there are
//! several (`layer.adjustmentPreset`).
//!
//! "Your Presets" are the user's: saved from the selected adjustment layers
//! (`layer.saveAdjustmentPreset`) under the pseudo-kind [`PANEL_KIND`] of the adjustment presets,
//! so they persist with the others (`presets.adjustments` in the settings file). Their params are
//! `{"layers": [{"kind", "params", "name"?}, …]}`, bottom layer first.
//!
//! The JavaScript app's 18 presets in six groups, all of them: seven use Color and Vibrance,
//! Clarity and Dehaze or Grain (Bright and Warm, Soft Skin, Vivid, Clear Distance, Remove Warm
//! Cast, Vintage Fade, Film Grain), added with those kinds.

use photocraft_color::ColorMode;
use serde_json::{Value, json};

use super::AdjustmentPresets;

/// The pseudo-kind of the adjustment presets that holds "Your Presets".
pub const PANEL_KIND: &str = "__panel";
/// The `group` of `layer.adjustmentPreset` that names one of "Your Presets".
pub const YOUR_PRESETS: &str = "yours";
/// Most layers one panel preset adds.
pub const MAX_LAYERS: usize = 64;

/// One built-in panel preset: its stable id, its name and its layers, bottom first, as
/// `(kind, params as JSON text)` (the params of `layer.newAdjustmentLayer.<kind>`).
pub struct PanelPreset {
    pub id: &'static str,
    pub name: &'static str,
    pub layers: &'static [(&'static str, &'static str)],
}

/// One group of built-in panel presets.
pub struct PanelGroup {
    pub id: &'static str,
    pub name: &'static str,
    pub presets: &'static [PanelPreset],
}

/// The built-in panel presets, the JavaScript app's (ids kept), in its order.
pub const PANEL_PRESETS: &[PanelGroup] = &[
    PanelGroup {
        id: "portraits",
        name: "Portraits",
        presets: &[
            PanelPreset {
                id: "bright-warm",
                name: "Bright and Warm",
                layers: &[("curves", r#"{"points":[[0,0],[120,140],[255,255]]}"#), ("colorVibrance", r#"{"temperature":18,"vibrance":10}"#)],
            },
            PanelPreset {
                id: "soft-skin",
                name: "Soft Skin",
                layers: &[("clarityDehaze", r#"{"clarity":-30}"#), ("vibrance", r#"{"vibrance":-10,"saturation":0}"#)],
            },
            PanelPreset {
                id: "warm-contrast",
                name: "Warm Contrast",
                layers: &[
                    ("curves", r#"{"points":[[0,0],[64,52],[192,205],[255,255]]}"#),
                    ("photoFilter", r##"{"color":"#ec8a00","density":15,"preserveLuminosity":true}"##),
                ],
            },
        ],
    },
    PanelGroup {
        id: "landscape",
        name: "Landscape",
        presets: &[
            PanelPreset {
                id: "vivid",
                name: "Vivid",
                layers: &[("colorVibrance", r#"{"vibrance":35,"saturation":5}"#), ("clarityDehaze", r#"{"clarity":25}"#)],
            },
            PanelPreset { id: "clear-distance", name: "Clear Distance", layers: &[("clarityDehaze", r#"{"dehaze":35,"clarity":10}"#)] },
            PanelPreset {
                id: "golden-hour",
                name: "Golden Hour",
                layers: &[("photoFilter", r##"{"color":"#fa9600","density":30,"preserveLuminosity":true}"##), ("curves", r#"{"points":[[0,10],[255,250]]}"#)],
            },
        ],
    },
    PanelGroup {
        id: "photo-repair",
        name: "Photo Repair",
        presets: &[
            PanelPreset { id: "lift-shadows", name: "Lift Shadows", layers: &[("curves", r#"{"points":[[0,0],[50,75],[255,255]]}"#)] },
            PanelPreset {
                id: "restore-faded",
                name: "Restore Faded Colors",
                layers: &[
                    ("levels", r#"{"inBlack":20,"inWhite":235,"gamma":1,"outBlack":0,"outWhite":255}"#),
                    ("vibrance", r#"{"vibrance":40,"saturation":10}"#),
                ],
            },
            PanelPreset { id: "cool-cast", name: "Remove Warm Cast", layers: &[("colorVibrance", r#"{"temperature":-20}"#)] },
        ],
    },
    PanelGroup {
        id: "creative",
        name: "Creative",
        presets: &[
            PanelPreset {
                id: "cross-process",
                name: "Cross Process",
                layers: &[(
                    "curves",
                    r#"{"points":[[0,0],[255,255]],"red":[[0,0],[64,50],[192,210],[255,255]],"green":[[0,0],[64,70],[192,200],[255,255]],"blue":[[0,40],[255,215]]}"#,
                )],
            },
            PanelPreset {
                id: "vintage-fade",
                name: "Vintage Fade",
                layers: &[
                    ("curves", r#"{"points":[[0,30],[128,128],[255,235]]}"#),
                    ("hueSaturation", r#"{"saturation":-30}"#),
                    ("grain", r#"{"amount":25,"size":30,"roughness":50}"#),
                ],
            },
            PanelPreset {
                id: "duotone-blue",
                name: "Duotone Blue",
                layers: &[("gradientMap", r##"{"stops":[[0,"#0b1e3f"],[1,"#d8ecff"]],"reverse":false}"##)],
            },
        ],
    },
    PanelGroup {
        id: "black-white",
        name: "Black & White",
        presets: &[
            PanelPreset { id: "classic", name: "Classic", layers: &[("blackWhite", "{}")] },
            PanelPreset {
                id: "high-contrast",
                name: "High Contrast",
                layers: &[
                    ("blackWhite", r#"{"reds":120,"yellows":120,"greens":-10,"cyans":-50,"blues":-50,"magentas":120}"#),
                    ("curves", r#"{"points":[[0,0],[64,48],[192,210],[255,255]]}"#),
                ],
            },
            PanelPreset {
                id: "infrared",
                name: "Infrared",
                layers: &[("blackWhite", r#"{"reds":-40,"yellows":235,"greens":144,"cyans":-68,"blues":-3,"magentas":-107}"#)],
            },
        ],
    },
    PanelGroup {
        id: "cinematic",
        name: "Cinematic",
        presets: &[
            PanelPreset {
                id: "teal-orange",
                name: "Teal and Orange",
                layers: &[("colorBalance", r#"{"shadows":[-15,0,20],"midtones":[0,0,0],"highlights":[15,0,-15],"preserveLuminosity":true}"#)],
            },
            PanelPreset {
                id: "moody",
                name: "Moody",
                layers: &[("curves", r#"{"points":[[0,15],[128,110],[255,240]]}"#), ("hueSaturation", r#"{"saturation":-25}"#)],
            },
            PanelPreset {
                id: "film-grain",
                name: "Film Grain",
                layers: &[("curves", r#"{"points":[[0,12],[255,245]]}"#), ("grain", r#"{"amount":35,"size":25,"roughness":60}"#)],
            },
        ],
    },
];

/// One layer a panel preset adds: its kind, its params and the name the user gave it.
#[derive(Clone, Debug, PartialEq)]
pub struct PresetLayer {
    pub kind: String,
    pub params: Value,
    pub name: Option<String>,
}

impl PresetLayer {
    /// The saved form, `{"kind", "params", "name"?}`.
    pub fn to_json(&self) -> Value {
        let mut v = json!({"kind": self.kind, "params": self.params});
        if let Some(name) = &self.name {
            v["name"] = json!(name);
        }
        v
    }
}

/// The layers of a built-in panel preset.
pub fn builtin_layers(p: &PanelPreset) -> Vec<PresetLayer> {
    p.layers
        .iter()
        .map(|(kind, params)| PresetLayer { kind: (*kind).to_string(), params: serde_json::from_str(params).unwrap_or_else(|_| json!({})), name: None })
        .collect()
}

/// The layers a user's panel preset holds (`{"layers": […]}`); entries that are not a kind and
/// params are left out.
pub fn saved_layers(params: &Value) -> Vec<PresetLayer> {
    params
        .get("layers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(MAX_LAYERS)
        .filter_map(|l| {
            let kind = l.get("kind")?.as_str()?.to_string();
            let params = l.get("params").filter(|p| p.is_object())?.clone();
            let name = l.get("name").and_then(Value::as_str).and_then(super::clean_name);
            Some(PresetLayer { kind, params, name })
        })
        .collect()
}

/// The saved params of a user's panel preset made of `layers`.
pub fn saved_params(layers: &[PresetLayer]) -> Value {
    json!({"layers": layers.iter().map(PresetLayer::to_json).collect::<Vec<_>>()})
}

/// The panel preset `preset` of `group` (a [`PANEL_PRESETS`] id, or [`YOUR_PRESETS`] with the
/// preset's name): its name and layers.
pub fn find(presets: &AdjustmentPresets, group: &str, preset: &str) -> Option<(String, Vec<PresetLayer>)> {
    if group == YOUR_PRESETS {
        let e = presets.find(PANEL_KIND, Some(preset), None)?;
        return Some((e.preset.name, saved_layers(&e.preset.params)));
    }
    let p = PANEL_PRESETS.iter().find(|g| g.id == group)?.presets.iter().find(|p| p.id == preset)?;
    Some((p.name.to_string(), builtin_layers(p)))
}

/// The user's panel presets ("Your Presets"), in order: each name and its layers.
pub fn yours(presets: &AdjustmentPresets) -> Vec<(String, Vec<PresetLayer>)> {
    presets.list(PANEL_KIND).into_iter().map(|e| (e.preset.name, saved_layers(&e.preset.params))).collect()
}

/// Levels or Curves params made in RGB, for a document of `mode`: the `red`, `green` and `blue`
/// channels go to the mode's channels by position (CMYK cyan, magenta, yellow; Lab a, b), as the
/// JavaScript app remapped a preset picked in another mode (`remapTonalSpace`); a mode without
/// colour channels (Grayscale, Duotone, Bitmap) keeps the composite only. Other kinds, and
/// params that name no RGB channel, are returned as they are.
pub fn for_mode(kind: &str, params: &Value, mode: ColorMode) -> Value {
    const RGB: [&str; 3] = ["red", "green", "blue"];
    let Some(m) = params.as_object().filter(|m| matches!(kind, "levels" | "curves") && RGB.iter().any(|k| m.contains_key(*k))) else {
        return params.clone();
    };
    let to: &[&str] = match mode {
        ColorMode::Rgb | ColorMode::Indexed => return params.clone(),
        ColorMode::Cmyk => &["cyan", "magenta", "yellow"],
        ColorMode::Lab => &["a", "b"],
        _ => &[],
    };
    let mut out = m.clone();
    let channels: Vec<Option<Value>> = RGB.iter().map(|k| out.remove(*k)).collect();
    for (key, channel) in to.iter().zip(channels) {
        if let Some(c) = channel {
            out.insert((*key).to_string(), c);
        }
    }
    Value::Object(out)
}
