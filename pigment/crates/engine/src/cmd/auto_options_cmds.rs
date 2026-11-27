//! Pigment: Auto Color Correction Options (Photoshop's dialog behind Alt-click on Auto in Levels and Curves, and its
//! Options… button), Auto in Curves and Brightness/Contrast, and the options Image › Auto Tone, Auto Contrast and
//! Auto Color use once they are saved as the defaults. The algorithms are `photocraft_algo::tone::auto_options`
//! (ported from the JavaScript Pigment 0.4); the eyedroppers' target colours are
//! [`crate::adjust_params::targets`].
//!
//! - `Preferences.adjustments` ([`AdjustmentPrefs`]): the options and whether they were saved as the defaults, kept in
//!   `config.toml` under `[adjustments]` like every preference.
//! - `image.adjustments.autoOptions`: reads or saves the options (no document change, not journaled).
//! - `image.adjustments.auto`: the Levels, Curves or Brightness/Contrast settings Auto gives for a layer (what the
//!   dialogs' Auto buttons apply; nothing changes, not journaled).
//! - [`auto_adjust`]: Image › Auto Tone/Contrast/Color with explicit options, or with the saved ones.

use photocraft_algo::tone::auto_options::{self as algo, AutoAlgorithm, AutoLevels, AutoOptions, Levels5, Sample};
use photocraft_color::ColorMode;
use photocraft_doc::{Adjustment, Layer, LayerContent, LayerId};
use photocraft_geom::Rect;
use photocraft_raster::Surface;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::commands::CommandSpec;
use crate::{EngineError, Result, Session};

/// `Preferences.adjustments`: state of the adjustment dialogs kept across restarts (PORTS-A D3).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AdjustmentPrefs {
    /// Auto Color Correction Options: what the Auto buttons of Levels and Curves use once saved, and the target colours
    /// of the Levels and Curves eyedroppers.
    pub auto_options: AutoOptionsPrefs,
    /// "Save as defaults" was used: Image › Auto Tone, Auto Contrast and Auto Color then take the saved clipping and
    /// targets (with their own algorithm), and the dialogs' Auto takes the saved options. Until then they keep
    /// PhotoCraft's own Auto (0.1 % clipping).
    pub auto_options_saved: bool,
}

/// [`AutoOptions`] as the preferences and the commands write them:
/// `{"algorithm":"monochromatic|perChannel|darkLight|brightnessContrast","snapNeutralMidtones":bool,"shadowClip":%,
/// "highlightClip":%,"shadowColor":"#rrggbb","midtoneColor":"#rrggbb","highlightColor":"#rrggbb"}`. The clipping
/// percentages are clamped to 0..=9.99 (Photoshop's fields); an unknown algorithm or a bad colour is refused. The
/// JavaScript Pigment's own keys (`snap`, `midColor`, `mono`, `brightness`) are read too, for migrated settings.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "RawOptions", into = "RawOptions")]
pub struct AutoOptionsPrefs(pub AutoOptions);

/// The serialized form of [`AutoOptionsPrefs`]; every key optional when read.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct RawOptions {
    algorithm: Option<String>,
    #[serde(alias = "snap")]
    snap_neutral_midtones: Option<bool>,
    shadow_clip: Option<f64>,
    highlight_clip: Option<f64>,
    shadow_color: Option<String>,
    #[serde(alias = "midColor")]
    midtone_color: Option<String>,
    highlight_color: Option<String>,
}

impl RawOptions {
    /// These keys laid over `base`.
    fn over(self, base: AutoOptions) -> std::result::Result<AutoOptions, String> {
        let color = |key: &str, v: Option<String>, fallback: [u8; 3]| match v {
            None => Ok(fallback),
            Some(s) => crate::prefs::parse_hex(&s).ok_or_else(|| format!("`{key}` must be a #rrggbb colour (got `{s}`)")),
        };
        let algorithm = match self.algorithm {
            None => base.algorithm,
            Some(a) => AutoAlgorithm::parse(&a)
                .ok_or_else(|| format!("`algorithm` must be one of {} (got `{a}`)", AutoAlgorithm::ALL.map(AutoAlgorithm::id).join("|")))?,
        };
        Ok(AutoOptions {
            algorithm,
            snap_neutral: self.snap_neutral_midtones.unwrap_or(base.snap_neutral),
            shadow_clip: self.shadow_clip.map_or(base.shadow_clip, algo::clamp_clip),
            highlight_clip: self.highlight_clip.map_or(base.highlight_clip, algo::clamp_clip),
            shadow: color("shadowColor", self.shadow_color, base.shadow)?,
            midtone: color("midtoneColor", self.midtone_color, base.midtone)?,
            highlight: color("highlightColor", self.highlight_color, base.highlight)?,
        }
        .clamped())
    }
}

impl TryFrom<RawOptions> for AutoOptionsPrefs {
    type Error = String;
    fn try_from(raw: RawOptions) -> std::result::Result<Self, String> {
        raw.over(AutoOptions::default()).map(AutoOptionsPrefs)
    }
}

impl From<AutoOptionsPrefs> for RawOptions {
    fn from(o: AutoOptionsPrefs) -> Self {
        let o = o.0;
        let hex = |c: [u8; 3]| format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2]);
        RawOptions {
            algorithm: Some(o.algorithm.id().into()),
            snap_neutral_midtones: Some(o.snap_neutral),
            // Hundredths, as the dialog's fields: an `f32` would otherwise save as 0.10000000149011612.
            shadow_clip: Some((f64::from(o.shadow_clip) * 100.0).round() / 100.0),
            highlight_clip: Some((f64::from(o.highlight_clip) * 100.0).round() / 100.0),
            shadow_color: Some(hex(o.shadow)),
            midtone_color: Some(hex(o.midtone)),
            highlight_color: Some(hex(o.highlight)),
        }
    }
}

/// The option keys of command params (as [`AutoOptionsPrefs`] writes them).
pub const OPTION_KEYS: [&str; 7] = ["algorithm", "snapNeutralMidtones", "shadowClip", "highlightClip", "shadowColor", "midtoneColor", "highlightColor"];

fn bad(cmd: &str, msg: impl Into<String>) -> EngineError {
    EngineError::BadParams { cmd: cmd.into(), msg: msg.into() }
}

/// The option keys of `v` (an object; other keys are ignored) laid over `base`.
pub fn options_over(v: &Value, base: AutoOptions, cmd: &str) -> Result<AutoOptions> {
    let Some(m) = v.as_object() else { return Err(bad(cmd, "the options must be an object")) };
    let keys: Map<String, Value> =
        m.iter().filter(|(k, _)| OPTION_KEYS.contains(&k.as_str()) || matches!(k.as_str(), "snap" | "midColor")).map(|(k, v)| (k.clone(), v.clone())).collect();
    let raw: RawOptions = serde_json::from_value(Value::Object(keys)).map_err(|e| bad(cmd, e.to_string()))?;
    raw.over(base).map_err(|e| bad(cmd, e))
}

/// The options as JSON (the preference's form).
pub fn options_json(o: &AutoOptions) -> Value {
    serde_json::to_value(AutoOptionsPrefs(*o)).unwrap_or(Value::Null)
}

/// The options the Auto buttons and the eyedroppers use: the saved ones (the defaults until something was saved).
pub fn current(s: &Session) -> AutoOptions {
    s.prefs().adjustments.auto_options.0
}

/// Whether options were saved as the defaults.
pub fn saved(s: &Session) -> bool {
    s.prefs().adjustments.auto_options_saved
}

/// `image.adjustments.autoOptions`.
fn auto_options(s: &mut Session, p: &Value) -> Result<Value> {
    const CMD: &str = "image.adjustments.autoOptions";
    if p.get("reset").and_then(Value::as_bool) == Some(true) {
        s.edit_prefs(|prefs| prefs.adjustments = AdjustmentPrefs::default());
        return Ok(json!({"options": options_json(&current(s)), "saved": false}));
    }
    let options = match p.get("options") {
        None | Some(Value::Null) => current(s),
        Some(v) => options_over(v, current(s), CMD)?,
    };
    let save = match p.get("saveAsDefaults") {
        None | Some(Value::Null) => false,
        Some(v) => v.as_bool().ok_or_else(|| bad(CMD, "`saveAsDefaults` must be true or false"))?,
    };
    if save {
        s.edit_prefs(|prefs| {
            prefs.adjustments.auto_options = AutoOptionsPrefs(options);
            prefs.adjustments.auto_options_saved = true;
        });
    }
    Ok(json!({"options": options_json(&options), "saved": saved(s)}))
}

/// Hides `id` and everything composited above it (what an adjustment layer receives). Returns whether `id` is in
/// `layers`.
fn hide_from(layers: &mut [Layer], id: LayerId) -> bool {
    let mut found = false;
    for l in layers.iter_mut() {
        if found || l.id == id {
            found = true;
            l.visible = false;
        } else if l.children_mut().is_some_and(|c| hide_from(c, id)) {
            found = true;
        }
    }
    found
}

/// The visible pixels of `surf` inside `area`, on a grid of at most about [`algo::MAX_SAMPLE_PIXELS`] (upstream's
/// Auto Tone sampling policy).
fn sample_surface(surf: &Surface, area: Rect) -> Sample {
    let (w, h) = (area.width() as usize, area.height() as usize);
    if w == 0 || h == 0 {
        return Sample::new(Vec::new());
    }
    let step = ((w as u64 * h as u64) / algo::MAX_SAMPLE_PIXELS as u64).max(1).isqrt().max(1) as usize;
    let mut row = vec![[0u8; 4]; w];
    let mut px = Vec::new();
    for y in (area.y0..area.y1).step_by(step) {
        surf.read_rgba8_into(Rect::new(area.x0, y, area.x1, y + 1), &mut row);
        px.extend(row.iter().step_by(step).filter(|p| p[3] != 0).map(|p| [p[0], p[1], p[2]]));
    }
    Sample::new(px)
}

/// What Auto reads for layer `id` (default the active one), as `image.adjustments.blackWhite.auto` does: the image
/// below an adjustment layer, a smart object's pixels below its smart filter `filter`, or a pixel layer's own pixels.
/// The whole canvas counts, as for the dialogs' histograms.
fn sample_for(s: &Session, p: &Value, cmd: &str) -> Result<Sample> {
    let st = s.active().ok_or(EngineError::NoDocument)?;
    let id = match p.get("layer") {
        None | Some(Value::Null) => st.active_layer.ok_or_else(|| EngineError::Other("no active layer".into()))?,
        Some(v) => LayerId(v.as_u64().ok_or_else(|| bad(cmd, "`layer` must be a layer id"))?),
    };
    let filter = match p.get("filter") {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.as_u64().and_then(|i| usize::try_from(i).ok()).ok_or_else(|| bad(cmd, "`filter` must be a smart filter index"))?),
    };
    let layer = st.doc.layer(id).ok_or(EngineError::NoLayer(id))?;
    let area = st.doc.bounds();
    if u64::from(area.width()) * u64::from(area.height()) > photocraft_compose::MAX_RENDER_PIXELS {
        return Err(bad(cmd, "the canvas is too large to analyse"));
    }
    Ok(match (&layer.content, filter) {
        (LayerContent::Smart(sm), Some(i)) => {
            if i >= sm.smart_filters.len() {
                return Err(bad(cmd, format!("layer \"{}\" has no smart filter {i}", layer.name)));
            }
            let below = crate::smart_cmds::render_below_filter(&st.doc, sm, i)?
                .ok_or_else(|| EngineError::Other("the smart object's contents are unavailable".into()))?;
            sample_surface(&below, area)
        }
        (_, Some(_)) => return Err(bad(cmd, "`filter` needs a smart object layer")),
        (LayerContent::Adjustment(_), None) => {
            let mut below = (*st.doc).clone();
            hide_from(&mut below.layers, id);
            Sample::from_rgba_f32(&photocraft_compose::render(&below, area).into_px())
        }
        (_, None) => sample_surface(layer.surface().ok_or_else(|| EngineError::Other(format!("layer \"{}\" has no pixels", layer.name)))?, area),
    })
}

/// Auto's Levels for `sample` in a document of `mode`: per channel in RGB; the luminosity stretch in the composite
/// elsewhere (Grayscale, CMYK, Lab), as the JavaScript app did.
pub fn auto_levels(sample: &Sample, options: &AutoOptions, mode: ColorMode) -> AutoLevels {
    if mode == ColorMode::Rgb { algo::auto_levels(sample, options) } else { algo::auto_levels(sample, &algo::luminosity_options(options)) }
}

fn levels_json(l: &Levels5) -> Value {
    json!({"inBlack": l.in_black, "inWhite": l.in_white, "gamma": l.gamma, "outBlack": l.out_black, "outWhite": l.out_white})
}

const RGB_KEYS: [&str; 3] = ["red", "green", "blue"];

/// The params of `image.adjustments.levels` (`kind` "levels") or `.curves` ("curves") that set `levels`: the
/// composite at the top level, the channels under red/green/blue. A Curves channel is the Levels record as points
/// (`curve_points`).
pub fn auto_params(kind: &str, levels: &AutoLevels) -> Value {
    let mut out = Map::new();
    match kind {
        "curves" => {
            let pts = |l: &Levels5| json!(algo::curve_points(l));
            out.insert("points".into(), pts(&levels.composite));
            for (l, key) in levels.channels.iter().flatten().zip(RGB_KEYS) {
                out.insert(key.into(), pts(l));
            }
        }
        _ => {
            if let Value::Object(m) = levels_json(&levels.composite) {
                out.extend(m);
            }
            for (l, key) in levels.channels.iter().flatten().zip(RGB_KEYS) {
                out.insert(key.into(), levels_json(l));
            }
        }
    }
    Value::Object(out)
}

/// `image.adjustments.auto`.
fn auto(s: &mut Session, p: &Value) -> Result<Value> {
    const CMD: &str = "image.adjustments.auto";
    let kind = p.get("kind").and_then(Value::as_str).unwrap_or("levels");
    if !matches!(kind, "levels" | "curves" | "brightnessContrast") {
        return Err(bad(CMD, "`kind` must be levels, curves or brightnessContrast"));
    }
    let options = match p.get("options") {
        None | Some(Value::Null) => current(s),
        Some(v) => options_over(v, current(s), CMD)?,
    };
    let mode = s.active().ok_or(EngineError::NoDocument)?.doc.mode;
    let sample = sample_for(s, p, CMD)?;
    if kind == "brightnessContrast" {
        let (brightness, contrast) = algo::auto_brightness_contrast(&sample);
        return Ok(json!({"brightness": brightness, "contrast": contrast, "legacy": false}));
    }
    Ok(auto_params(kind, &auto_levels(&sample, &options, mode)))
}

/// Photoshop's algorithm of each Image › Auto command, and whether it snaps neutral midtones.
fn command_algorithm(kind: &str) -> (AutoAlgorithm, bool) {
    match kind {
        "contrast" => (AutoAlgorithm::Monochromatic, false),
        "color" => (AutoAlgorithm::DarkLight, true),
        _ => (AutoAlgorithm::PerChannel, false),
    }
}

/// The options Image › Auto `kind` ("tone", "contrast", "color") runs with: its own algorithm (and Snap Neutral
/// Midtones for Auto Color) with the saved clipping and targets, then the explicit option keys of `p`. `None` when `p`
/// names none and nothing was saved: upstream's own Auto then runs, unchanged.
pub fn command_options(s: &Session, kind: &str, p: &Value) -> Result<Option<AutoOptions>> {
    let explicit = p.as_object().is_some_and(|m| m.keys().any(|k| OPTION_KEYS.contains(&k.as_str())));
    if !explicit && !saved(s) {
        return Ok(None);
    }
    let (algorithm, snap_neutral) = command_algorithm(kind);
    let base = if saved(s) { AutoOptions { algorithm, snap_neutral, ..current(s) } } else { AutoOptions { algorithm, snap_neutral, ..AutoOptions::default() } };
    let cmd = format!(
        "image.auto{}",
        if kind == "contrast" {
            "Contrast"
        } else if kind == "color" {
            "Color"
        } else {
            "Tone"
        }
    );
    // Upstream's commands took `{}`; anything but an object names no options.
    if p.is_object() { options_over(p, base, &cmd).map(Some) } else { Ok(Some(base)) }
}

/// Image › Auto Tone / Auto Contrast / Auto Color with Auto Color Correction Options (the hook at the top of
/// `edit_cmds::auto_adjust`). `Ok(None)`: no options apply ([`command_options`]); the caller runs upstream's Auto.
/// Reads the active layer inside the selection's bounds and applies the Levels as one history step, as upstream does.
pub fn auto_adjust(s: &mut Session, kind: &str, p: &Value) -> Result<Option<Value>> {
    let Some(options) = command_options(s, kind, p)? else { return Ok(None) };
    let d = s.active().ok_or(EngineError::NoDocument)?;
    let id = d.active_layer.ok_or_else(|| EngineError::Other("no active layer".into()))?;
    let surf = d.doc.layer(id).and_then(Layer::surface).ok_or(EngineError::Other("the active layer has no pixels".into()))?;
    let area = d.doc.selection.as_ref().map_or(d.doc.bounds(), |m| m.content_bounds()).intersect(&d.doc.bounds());
    let mode = d.doc.mode;
    let params = auto_params("levels", &auto_levels(&sample_surface(surf, area), &options, mode));
    let adj: Adjustment = crate::adjust_params::from_params("levels", &params, None, mode)?;
    let label = match kind {
        "contrast" => "Auto Contrast",
        "color" => "Auto Color",
        _ => "Auto Tone",
    };
    s.edit(label, |doc, _| {
        let sel = doc.selection.clone();
        let mode = doc.mode;
        let surf = crate::commands::paint_surface(doc, id, &Value::Null)?;
        crate::pixels::adjust_surface(surf, &adj, sel.as_ref(), mode).map_err(EngineError::Other)?;
        Ok(())
    })?;
    Ok(Some(Value::Null))
}

/// The params string of Image › Auto Tone, Auto Contrast and Auto Color (the options they take).
pub const AUTO_COMMAND_PARAMS: &str = r##"{"algorithm":"monochromatic|perChannel|darkLight|brightnessContrast"?,"snapNeutralMidtones":bool?,"shadowClip":0..9.99?,"highlightClip":0..9.99?,"shadowColor":"#rrggbb"?,"midtoneColor":"#rrggbb"?,"highlightColor":"#rrggbb"?} (Auto Color Correction Options; without any, the options saved as the defaults with the command's own algorithm, or Pigment's 0.1 % Auto when none were saved)"##;

fn always(_: &Session) -> std::result::Result<(), String> {
    Ok(())
}

fn has_doc(s: &Session) -> std::result::Result<(), String> {
    s.active().map(|_| ()).ok_or_else(|| "no document open".into())
}

pub fn specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec {
            id: "image.adjustments.autoOptions",
            label: "Auto Color Correction Options…",
            menu: &[],
            shortcut: None,
            params: r##"{"options":{"algorithm":"monochromatic|perChannel|darkLight|brightnessContrast","snapNeutralMidtones":bool,"shadowClip":0..9.99,"highlightClip":0..9.99,"shadowColor":"#rrggbb","midtoneColor":"#rrggbb","highlightColor":"#rrggbb"}? (laid over the current ones; clips are clamped),"saveAsDefaults":bool=false (then Image › Auto Tone/Contrast/Color and the Auto buttons use them),"reset":bool=false (back to Photoshop's defaults, nothing saved)} → {options, saved}"##,
            enabled: always,
            run: auto_options,
            journal: false,
        },
        CommandSpec {
            id: "image.adjustments.auto",
            label: "Auto Adjustment Settings",
            menu: &[],
            shortcut: None,
            params: r##"{"kind":"levels|curves|brightnessContrast"="levels","layer":id?,"filter":index?,"options":{…}? (as image.adjustments.autoOptions, over the saved ones)} → the params of image.adjustments.<kind> that Auto sets for the image an adjustment layer sees, a smart object's pixels below smart filter `filter`, or a pixel layer's own pixels (nothing changes)"##,
            enabled: has_doc,
            run: auto,
            journal: false,
        },
    ]
}

#[cfg(test)]
mod tests;
