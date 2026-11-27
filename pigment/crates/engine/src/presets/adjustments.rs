//! Adjustment presets (Pigment): the Preset menu of every adjustment dialog and of an adjustment
//! layer's Properties, as the JavaScript Pigment had them and Photoshop has them.
//!
//! A preset is a name and the adjustment's settings as its command takes them (the params of
//! `image.adjustments.<kind>` / `layer.newAdjustmentLayer.<kind>`, `image.adjustments.hdrToning`
//! for HDR Toning): what the dialogs, actions and agents already speak, and what survives model
//! changes. Applying one is not a command of its own: the interface sets the dialog or layer to
//! the preset's params (read over the kind's defaults, so a preset that names only the composite
//! leaves the channels neutral), and an action records the resulting settings, as Photoshop
//! records values, not preset names.
//!
//! Each kind has the built-in list the JavaScript app had (Photoshop's names; ids copied from the
//! app, `TONAL_BUILTINS` and `COLOR_BUILTINS`), generated here and never saved. What is saved
//! (under `presets.adjustments` in the settings file) is the user's presets, in groups, and what
//! the user did to the built-ins: the ids deleted (`hidden_builtins`) and the names given
//! (`renamed`). Reset brings the built-ins back and keeps the user's presets.
//!
//! The commands are `adjustment.presets.*` (`crate::cmd::adjust_preset_cmds`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::{Group, Named};

pub mod panel;

/// Every kind that has presets: the adjustment kinds of `layer.newAdjustmentLayer.*` that have
/// settings (Invert has none), and HDR Toning (`image.adjustments.hdrToning`).
pub const KINDS: &[&str] = &[
    "brightnessContrast",
    "levels",
    "curves",
    "exposure",
    "vibrance",
    "hueSaturation",
    "colorBalance",
    "blackWhite",
    "photoFilter",
    "channelMixer",
    "posterize",
    "threshold",
    "gradientMap",
    "selectiveColor",
    "colorLookup",
    "hdrToning",
];

/// The group the built-in presets are listed in.
pub const BUILTIN_GROUP: &str = "Built-in";
/// The group a saved or loaded preset goes to when none is named.
pub const USER_GROUP: &str = "My Presets";
/// Longest preset or group name.
pub const MAX_NAME_CHARS: usize = 255;
/// Most presets one kind keeps (a hand-edited settings file can't make the list unbounded).
pub const MAX_PRESETS: usize = 1000;
/// Largest params of one preset, as JSON (a Color Lookup preset may hold its table's text).
pub const MAX_PARAMS_BYTES: usize = 4 << 20;

/// One preset: a name, the built-in's stable id, and the command's params.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AdjustmentPreset {
    pub name: String,
    /// The built-in's id (`None` for the user's presets).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub params: Value,
}

impl Named for AdjustmentPreset {
    fn name(&self) -> &str {
        &self.name
    }
    fn set_name(&mut self, n: String) {
        self.name = n;
    }
}

/// What the user changed of one kind's presets.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct KindPresets {
    /// The user's presets (saved, or loaded from files), in groups.
    #[serde(default)]
    pub groups: Vec<Group<AdjustmentPreset>>,
    /// Built-in ids the user deleted.
    #[serde(default)]
    pub hidden_builtins: Vec<String>,
    /// Built-in id → the name the user gave it.
    #[serde(default)]
    pub renamed: BTreeMap<String, String>,
}

/// One preset as the lists show it.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub group: String,
    pub preset: AdjustmentPreset,
    pub builtin: bool,
}

impl Entry {
    /// `{group, name, id?, builtin}`, with the params when asked.
    pub fn to_json(&self, with_params: bool) -> Value {
        let mut v = json!({"group": self.group, "name": self.preset.name, "builtin": self.builtin});
        if let Some(id) = &self.preset.id {
            v["id"] = json!(id);
        }
        if with_params {
            v["params"] = self.preset.params.clone();
        }
        v
    }
}

/// The adjustment presets of every kind.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AdjustmentPresets {
    pub kinds: BTreeMap<String, KindPresets>,
}

impl AdjustmentPresets {
    /// The user's changes of `kind` (empty when there are none).
    pub fn kind(&self, kind: &str) -> KindPresets {
        self.kinds.get(kind).cloned().unwrap_or_default()
    }

    /// Every preset of `kind` in menu order: the built-ins the user kept, then the user's groups.
    pub fn list(&self, kind: &str) -> Vec<Entry> {
        let k = self.kinds.get(kind);
        let mut out: Vec<Entry> = builtin(kind)
            .into_iter()
            .filter(|b| k.is_none_or(|k| !b.id.as_ref().is_some_and(|id| k.hidden_builtins.contains(id))))
            .map(|mut preset| {
                if let Some(name) = k.and_then(|k| preset.id.as_ref().and_then(|id| k.renamed.get(id))) {
                    preset.name = name.clone();
                }
                Entry { group: BUILTIN_GROUP.into(), preset, builtin: true }
            })
            .collect();
        for g in k.map(|k| k.groups.as_slice()).unwrap_or_default() {
            out.extend(g.items.iter().map(|p| Entry { group: g.name.clone(), preset: p.clone(), builtin: false }));
        }
        out
    }

    /// The preset of `kind` named `name` (exactly), or whose built-in id is `id`.
    pub fn find(&self, kind: &str, name: Option<&str>, id: Option<&str>) -> Option<Entry> {
        self.list(kind).into_iter().find(|e| name.is_some_and(|n| e.preset.name == n) || id.is_some_and(|i| e.preset.id.as_deref() == Some(i)))
    }

    fn taken(&self, kind: &str, name: &str) -> bool {
        self.list(kind).iter().any(|e| e.preset.name == name)
    }

    /// `base`, or `base 2`, `base 3`… the first name no preset of `kind` has.
    pub fn unique_name(&self, kind: &str, base: &str) -> String {
        let names: Vec<String> = self.list(kind).into_iter().map(|e| e.preset.name).collect();
        super::unique_name_by(base, |n| names.iter().any(|x| x == n))
    }

    /// Saves `params` as `name` in `group` (or [`USER_GROUP`]). A preset of that name is
    /// replaced: a user preset in place, a built-in by hiding it. Returns whether one was.
    pub fn save(&mut self, kind: &str, name: &str, params: Value, group: Option<&str>) -> Result<bool, String> {
        let existing = self.find(kind, Some(name), None);
        let replaced = existing.is_some();
        let count = self.list(kind).len();
        let k = self.kinds.entry(kind.to_string()).or_default();
        match existing {
            Some(Entry { builtin: false, .. }) => {
                if let Some(p) = k.groups.iter_mut().flat_map(|g| g.items.iter_mut()).find(|p| p.name == name) {
                    p.params = params;
                }
                return Ok(true);
            }
            Some(Entry { builtin: true, preset, .. }) => {
                if let Some(id) = preset.id {
                    k.renamed.remove(&id);
                    k.hidden_builtins.push(id);
                }
            }
            None if count >= MAX_PRESETS => return Err(format!("a kind keeps at most {MAX_PRESETS} presets")),
            None => {}
        }
        let gi = super::group_index(&mut k.groups, Some(group.unwrap_or(USER_GROUP)));
        k.groups[gi].items.push(AdjustmentPreset { name: name.to_string(), id: None, params });
        Ok(replaced)
    }

    /// Renames the preset `name` of `kind` to `to` (taken names are refused).
    pub fn rename(&mut self, kind: &str, name: &str, to: &str) -> Result<(), String> {
        let e = self.find(kind, Some(name), None).ok_or_else(|| format!("no {kind} preset \"{name}\""))?;
        if name != to && self.taken(kind, to) {
            return Err(format!("a {kind} preset named \"{to}\" already exists"));
        }
        let k = self.kinds.entry(kind.to_string()).or_default();
        match e.preset.id.filter(|_| e.builtin) {
            Some(id) => {
                k.renamed.insert(id, to.to_string());
            }
            None => {
                if let Some(p) = k.groups.iter_mut().flat_map(|g| g.items.iter_mut()).find(|p| p.name == name) {
                    p.name = to.to_string();
                }
            }
        }
        Ok(())
    }

    /// Deletes the presets `names` of `kind`, all or none. Built-ins are remembered as deleted.
    pub fn delete(&mut self, kind: &str, names: &[String]) -> Result<usize, String> {
        let entries: Vec<Entry> =
            names.iter().map(|n| self.find(kind, Some(n), None).ok_or_else(|| format!("no {kind} preset \"{n}\""))).collect::<Result<_, _>>()?;
        let k = self.kinds.entry(kind.to_string()).or_default();
        let mut deleted = 0;
        for e in entries {
            match e.preset.id.filter(|_| e.builtin) {
                Some(id) if !k.hidden_builtins.contains(&id) => {
                    k.renamed.remove(&id);
                    k.hidden_builtins.push(id);
                    deleted += 1;
                }
                Some(_) => {}
                None => {
                    for g in &mut k.groups {
                        let before = g.items.len();
                        g.items.retain(|p| p.name != e.preset.name);
                        deleted += before - g.items.len();
                    }
                }
            }
        }
        k.groups.retain(|g| !g.items.is_empty());
        Ok(deleted)
    }

    /// Brings back `kind`'s built-ins with their names; the user's presets stay. A user preset
    /// that now shares a built-in's name gets a number (`Darker 2`). Returns how many built-ins
    /// came back and the user presets renamed, as `[old, new]`.
    pub fn reset(&mut self, kind: &str) -> (usize, Vec<(String, String)>) {
        let Some(k) = self.kinds.get_mut(kind) else { return (0, Vec::new()) };
        let restored = k.hidden_builtins.len() + k.renamed.len();
        k.hidden_builtins.clear();
        k.renamed.clear();
        let builtins: Vec<String> = builtin(kind).into_iter().map(|b| b.name).collect();
        let mut taken: Vec<String> = builtins.clone();
        taken.extend(k.groups.iter().flat_map(|g| g.items.iter().map(|p| p.name.clone())));
        let mut renamed = Vec::new();
        for p in k.groups.iter_mut().flat_map(|g| g.items.iter_mut()) {
            if builtins.contains(&p.name) {
                let to = super::unique_name_by(&p.name, |n| taken.iter().any(|t| t == n));
                taken.push(to.clone());
                renamed.push((std::mem::replace(&mut p.name, to.clone()), to));
            }
        }
        if *k == KindPresets::default() {
            self.kinds.remove(kind);
        }
        (restored, renamed)
    }

    /// The saved form (`presets.adjustments`): the kinds the user changed.
    pub fn to_json(&self) -> Value {
        let m: Map<String, Value> = self
            .kinds
            .iter()
            .filter(|(_, k)| **k != KindPresets::default())
            .map(|(kind, k)| (kind.clone(), serde_json::to_value(k).unwrap_or(Value::Null)))
            .collect();
        Value::Object(m)
    }

    /// Reads [`to_json`](Self::to_json)'s form entry by entry: a damaged preset, group or kind is
    /// left out and the rest loads (#5602). Names stay unique within a kind; kinds this build
    /// does not know are kept, so a newer build's presets survive a run of this one.
    pub fn load(v: &Value) -> Self {
        let mut out = AdjustmentPresets::default();
        let Some(kinds) = v.as_object() else { return out };
        for (kind, kv) in kinds {
            let mut k = KindPresets::default();
            let ids: Vec<String> = builtin(kind).into_iter().filter_map(|b| b.id).collect();
            for id in kv.get("hidden_builtins").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
                if !k.hidden_builtins.iter().any(|h| h == id) && (ids.is_empty() || ids.iter().any(|i| i == id)) {
                    k.hidden_builtins.push(id.to_string());
                }
            }
            for (id, name) in kv.get("renamed").and_then(Value::as_object).into_iter().flatten() {
                if let Some(name) = name.as_str().and_then(clean_name)
                    && (ids.is_empty() || ids.contains(id))
                {
                    k.renamed.insert(id.clone(), name);
                }
            }
            out.kinds.insert(kind.clone(), k);
            let mut count = out.list(kind).len();
            for g in kv.get("groups").and_then(Value::as_array).into_iter().flatten() {
                let Some(group) = g.get("name").and_then(Value::as_str).and_then(clean_name) else { continue };
                for item in g.get("items").and_then(Value::as_array).into_iter().flatten() {
                    let (Some(name), Some(params)) =
                        (item.get("name").and_then(Value::as_str).and_then(clean_name), item.get("params").filter(|p| p.is_object()))
                    else {
                        continue;
                    };
                    if count >= MAX_PRESETS {
                        break;
                    }
                    let name = out.unique_name(kind, &name);
                    let k = out.kinds.entry(kind.clone()).or_default();
                    let gi = super::group_index(&mut k.groups, Some(&group));
                    k.groups[gi].items.push(AdjustmentPreset { name, id: None, params: params.clone() });
                    count += 1;
                }
            }
            if out.kinds.get(kind).is_some_and(|k| *k == KindPresets::default()) {
                out.kinds.remove(kind);
            }
        }
        out
    }
}

/// `name` trimmed, if it is a usable preset name.
pub fn clean_name(name: &str) -> Option<String> {
    let n = name.trim();
    (!n.is_empty() && n.chars().count() <= MAX_NAME_CHARS).then(|| n.to_string())
}

// ------------------------------------------------------------------ built-ins

fn preset(id: &str, name: &str, params: Value) -> AdjustmentPreset {
    AdjustmentPreset { name: name.into(), id: Some(id.into()), params }
}

/// HDR Toning's settings with the JavaScript app's defaults under `o`. The app's Strength
/// (0..100, default 50) is PhotoCraft's 0.1..4 (default 0.5) divided by 100.
fn hdr(id: &str, name: &str, o: Value) -> AdjustmentPreset {
    let mut p = json!({"radius": 100, "strength": 0.5, "gamma": 1, "exposure": 0, "detail": 30, "shadow": 0, "highlight": 0, "vibrance": 0, "saturation": 20});
    if let (Some(m), Value::Object(o)) = (p.as_object_mut(), o) {
        m.extend(o);
    }
    preset(id, name, p)
}

/// The built-in presets of `kind`, in menu order (empty for a kind without any).
pub fn builtin(kind: &str) -> Vec<AdjustmentPreset> {
    let curve = |pts: &[[u8; 2]]| json!(pts);
    match kind {
        "levels" => vec![
            preset("darker", "Darker", json!({"inBlack": 15, "gamma": 0.85})),
            preset("increase-contrast-1", "Increase Contrast 1", json!({"inBlack": 10, "inWhite": 245})),
            preset("increase-contrast-2", "Increase Contrast 2", json!({"inBlack": 20, "inWhite": 235})),
            preset("increase-contrast-3", "Increase Contrast 3", json!({"inBlack": 30, "inWhite": 225})),
            preset("lighten-shadows", "Lighten Shadows", json!({"gamma": 1.25, "outBlack": 25})),
            preset("lighter", "Lighter", json!({"inWhite": 230, "gamma": 1.15})),
            preset("midtones-brighter", "Midtones Brighter", json!({"gamma": 1.4})),
            preset("midtones-darker", "Midtones Darker", json!({"gamma": 0.7})),
        ],
        "curves" => vec![
            preset(
                "color-negative",
                "Color Negative (RGB)",
                json!({"points": curve(&[[0, 255], [255, 0]]), "red": curve(&[[0, 0], [255, 235]]), "green": curve(&[[0, 10], [255, 245]]), "blue": curve(&[[0, 40], [255, 255]])}),
            ),
            preset(
                "cross-process",
                "Cross Process (RGB)",
                json!({
                    "points": curve(&[[0, 0], [255, 255]]),
                    "red": curve(&[[0, 0], [64, 40], [192, 222], [255, 255]]),
                    "green": curve(&[[0, 0], [64, 52], [192, 210], [255, 255]]),
                    "blue": curve(&[[0, 40], [255, 210]]),
                }),
            ),
            preset("darker", "Darker (RGB)", json!({"points": curve(&[[0, 0], [128, 96], [255, 255]])})),
            preset("increase-contrast", "Increase Contrast (RGB)", json!({"points": curve(&[[0, 0], [64, 54], [192, 202], [255, 255]])})),
            preset("lighter", "Lighter (RGB)", json!({"points": curve(&[[0, 0], [128, 160], [255, 255]])})),
            preset("linear-contrast", "Linear Contrast (RGB)", json!({"points": curve(&[[0, 0], [48, 32], [208, 224], [255, 255]])})),
            preset("contrast", "Medium Contrast (RGB)", json!({"points": curve(&[[0, 0], [64, 48], [192, 208], [255, 255]])})),
            preset("negative", "Negative (RGB)", json!({"points": curve(&[[0, 255], [255, 0]])})),
            preset("strong-contrast", "Strong Contrast (RGB)", json!({"points": curve(&[[0, 0], [64, 32], [192, 224], [255, 255]])})),
        ],
        "exposure" => [("minus-2", "Minus 2.0", -2), ("minus-1", "Minus 1.0", -1), ("plus-1", "Plus 1.0", 1), ("plus-2", "Plus 2.0", 2)]
            .into_iter()
            .map(|(id, name, e)| preset(id, name, json!({"exposure": e, "offset": 0, "gamma": 1})))
            .collect(),
        "brightnessContrast" => [
            ("brighter", "Brighter", 30, 0),
            ("darker", "Darker", -30, 0),
            ("more-contrast", "More Contrast", 0, 30),
            ("less-contrast", "Less Contrast", 0, -30),
        ]
        .into_iter()
        .map(|(id, name, b, c)| preset(id, name, json!({"brightness": b, "contrast": c, "legacy": false})))
        .collect(),
        "threshold" => [("dark", "Dark (96)", 96), ("middle", "Middle (128)", 128), ("light", "Light (160)", 160)]
            .into_iter()
            .map(|(id, name, level)| preset(id, name, json!({"level": level})))
            .collect(),
        "hueSaturation" => {
            let master = |s: i32| json!({"hue": 0, "saturation": s, "lightness": 0, "colorize": false});
            let colorize = |h: i32, s: i32| json!({"hue": h, "saturation": s, "lightness": 0, "colorize": true});
            let range = |v: Value, key: &str, h: i32, s: i32| {
                let mut v = v;
                v[key] = json!({"hue": h, "saturation": s, "lightness": 0});
                v
            };
            vec![
                preset("cyanotype", "Cyanotype", colorize(205, 30)),
                preset("further-increase-saturation", "Further Increase Saturation", master(40)),
                preset("increase-saturation", "Increase Saturation", master(20)),
                preset("old-style", "Old Style", range(range(master(-55), "yellows", 0, 25), "reds", 8, 10)),
                preset("red-boost", "Red Boost", range(master(0), "reds", 0, 40)),
                preset("sepia", "Sepia", colorize(35, 25)),
                preset("strong-saturation", "Strong Saturation", master(60)),
                preset("yellow-boost", "Yellow Boost", range(master(0), "yellows", 0, 40)),
            ]
        }
        "blackWhite" => [
            ("blue-filter", "Blue Filter", [0, 0, 0, 100, 150, 100]),
            ("darker", "Darker", [20, 40, 20, 40, 0, 60]),
            ("green-filter", "Green Filter", [40, 100, 150, 60, 0, 40]),
            ("high-contrast-blue-filter", "High Contrast Blue Filter", [-50, -50, -50, 150, 200, 150]),
            ("high-contrast-red-filter", "High Contrast Red Filter", [120, 120, -10, -50, -50, 120]),
            ("infrared", "Infrared", [-40, 235, 144, -68, -3, -107]),
            ("lighter", "Lighter", [60, 80, 60, 80, 40, 100]),
            ("maximum-black", "Maximum Black", [0, 0, 0, 0, 0, 0]),
            ("maximum-white", "Maximum White", [100, 100, 100, 100, 100, 100]),
            ("neutral-density", "Neutral Density", [128, 128, 100, 100, 128, 100]),
            ("red-filter", "Red Filter", [120, 110, -10, -50, -50, 120]),
            ("yellow-filter", "Yellow Filter", [120, 110, 40, -30, 0, 70]),
        ]
        .into_iter()
        .map(|(id, name, [r, y, g, c, b, m])| {
            preset(id, name, json!({"reds": r, "yellows": y, "greens": g, "cyans": c, "blues": b, "magentas": m, "tint": false}))
        })
        .collect(),
        "channelMixer" => [
            ("bw-infrared", "Black & White Infrared (RGB)", [-70, 200, -30]),
            ("bw-blue-filter", "Black & White with Blue Filter (RGB)", [0, 0, 100]),
            ("bw-green-filter", "Black & White with Green Filter (RGB)", [0, 100, 0]),
            ("bw-orange-filter", "Black & White with Orange Filter (RGB)", [50, 50, 0]),
            ("bw-red-filter", "Black & White with Red Filter (RGB)", [100, 0, 0]),
            ("bw-yellow-filter", "Black & White with Yellow Filter (RGB)", [34, 66, 0]),
        ]
        .into_iter()
        .map(|(id, name, [r, g, b])| preset(id, name, json!({"monochrome": true, "gray": [r, g, b, 0]})))
        .collect(),
        "hdrToning" => vec![
            hdr("flat", "Flat", json!({"strength": 0.2, "detail": 0, "saturation": 0})),
            hdr("monochromatic", "Monochromatic", json!({"detail": 60, "saturation": -100})),
            hdr(
                "monochromatic-high-contrast",
                "Monochromatic High Contrast",
                json!({"radius": 60, "strength": 0.8, "detail": 120, "saturation": -100, "shadow": -30, "highlight": 20}),
            ),
            hdr("photorealistic", "Photorealistic", json!({"radius": 150, "strength": 0.4, "detail": 20, "saturation": 15})),
            hdr(
                "photorealistic-high-contrast",
                "Photorealistic High Contrast",
                json!({"radius": 120, "strength": 0.6, "detail": 50, "shadow": -20, "highlight": 10, "saturation": 20}),
            ),
            hdr("saturated", "Saturated", json!({"detail": 50, "vibrance": 40, "saturation": 40})),
            hdr("more-saturated", "More Saturated", json!({"detail": 70, "vibrance": 60, "saturation": 60})),
            hdr("surrealistic", "Surrealistic", json!({"radius": 40, "strength": 1.0, "detail": 200, "vibrance": 30, "saturation": 30})),
        ],
        _ => Vec::new(),
    }
}
