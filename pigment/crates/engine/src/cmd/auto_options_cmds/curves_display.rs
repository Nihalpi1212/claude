//! Pigment: Curves › Curve Display Options (PORTS-A row 11), kept in `Preferences.adjustments.curvesDisplay` like
//! Photoshop keeps them between sessions.
//!
//! The six options are all stored, in this form:
//! `{"amount":{"rgb":"light","cmyk":"pigment","gray":"light","lab":"light"},"grid":"simple|detailed",
//! "channelOverlays":bool,"histogram":bool,"baseline":bool,"intersectionLine":bool}`. Show Amount of is kept per colour
//! mode, defaulting as Photoshop does: Pigment/Ink % for CMYK, Light (0-255) for the others. When read, `amount` may also
//! be one word for every mode, and the JavaScript Pigment's keys (`pigment`, `detailed`, `overlays`, `intersection`,
//! settings `adjust.curvesDisplay`) are accepted, for migrated settings.
//!
//! The craft framework's Curves graph (pinned craft-libs) draws only the histogram option today; the other five are
//! kept and take effect once the framework draws them (planpc REBASE-A, A4).

use photocraft_color::ColorMode;
use serde::{Deserialize, Serialize};

/// Show Amount of: what the graph's axes count.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CurvesAmount {
    /// Light (0-255): black at the lower left, values grow with light.
    #[default]
    Light,
    /// Pigment/Ink %: both axes mirrored, values grow with ink (the stored curve stays light-based).
    Pigment,
}

impl CurvesAmount {
    /// The preference's word.
    pub fn id(self) -> &'static str {
        match self {
            CurvesAmount::Light => "light",
            CurvesAmount::Pigment => "pigment",
        }
    }

    /// The amount `id` names.
    pub fn parse(id: &str) -> Option<Self> {
        match id {
            "light" => Some(CurvesAmount::Light),
            "pigment" => Some(CurvesAmount::Pigment),
            _ => None,
        }
    }
}

/// Show Amount of for each colour mode family.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CurvesAmounts {
    /// RGB (and Indexed).
    pub rgb: CurvesAmount,
    /// CMYK and Multichannel (ink modes).
    pub cmyk: CurvesAmount,
    /// Grayscale, Duotone and Bitmap.
    pub gray: CurvesAmount,
    /// Lab.
    pub lab: CurvesAmount,
}

impl Default for CurvesAmounts {
    fn default() -> Self {
        Self { rgb: CurvesAmount::Light, cmyk: CurvesAmount::Pigment, gray: CurvesAmount::Light, lab: CurvesAmount::Light }
    }
}

impl CurvesAmounts {
    /// Every mode the same.
    pub fn all(amount: CurvesAmount) -> Self {
        Self { rgb: amount, cmyk: amount, gray: amount, lab: amount }
    }

    /// The slot of `mode`.
    pub fn slot(&mut self, mode: ColorMode) -> &mut CurvesAmount {
        match mode {
            ColorMode::Cmyk | ColorMode::Multichannel => &mut self.cmyk,
            ColorMode::Grayscale | ColorMode::Duotone | ColorMode::Bitmap => &mut self.gray,
            ColorMode::Lab => &mut self.lab,
            ColorMode::Rgb | ColorMode::Indexed => &mut self.rgb,
        }
    }

    /// The amount shown in a document of `mode`.
    pub fn of(mut self, mode: ColorMode) -> CurvesAmount {
        *self.slot(mode)
    }
}

/// The graph's grid: Photoshop's two icon buttons.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CurvesGrid {
    /// Quarter lines (4×4).
    #[default]
    Simple,
    /// Ten per cent lines (10×10).
    Detailed,
}

impl CurvesGrid {
    /// The preference's word.
    pub fn id(self) -> &'static str {
        match self {
            CurvesGrid::Simple => "simple",
            CurvesGrid::Detailed => "detailed",
        }
    }

    /// The grid `id` names.
    pub fn parse(id: &str) -> Option<Self> {
        match id {
            "simple" => Some(CurvesGrid::Simple),
            "detailed" => Some(CurvesGrid::Detailed),
            _ => None,
        }
    }
}

/// `Preferences.adjustments.curvesDisplay`: Curve Display Options.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "RawDisplay", into = "RawDisplay")]
pub struct CurvesDisplay {
    /// Show Amount of, per colour mode.
    pub amount: CurvesAmounts,
    /// Simple or detailed grid.
    pub grid: CurvesGrid,
    /// Show: Channel Overlays (the other channels' curves over the composite).
    pub channel_overlays: bool,
    /// Show: Histogram.
    pub histogram: bool,
    /// Show: Baseline (the diagonal of the unchanged curve).
    pub baseline: bool,
    /// Show: Intersection Line (guides through the point being dragged).
    pub intersection_line: bool,
}

impl Default for CurvesDisplay {
    fn default() -> Self {
        Self { amount: CurvesAmounts::default(), grid: CurvesGrid::Simple, channel_overlays: true, histogram: true, baseline: true, intersection_line: true }
    }
}

/// `amount` as read: one word for every mode, or the per-mode table.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
enum RawAmount {
    All(String),
    ByMode(RawAmounts),
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct RawAmounts {
    rgb: Option<String>,
    cmyk: Option<String>,
    gray: Option<String>,
    lab: Option<String>,
}

/// The serialized form of [`CurvesDisplay`]; every key optional when read.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct RawDisplay {
    #[serde(skip_serializing_if = "Option::is_none")]
    amount: Option<RawAmount>,
    #[serde(skip_serializing_if = "Option::is_none")]
    grid: Option<String>,
    #[serde(alias = "overlays", skip_serializing_if = "Option::is_none")]
    channel_overlays: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    histogram: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    baseline: Option<bool>,
    #[serde(alias = "intersection", skip_serializing_if = "Option::is_none")]
    intersection_line: Option<bool>,
    /// The JavaScript Pigment's Show Amount of (one for every mode).
    #[serde(skip_serializing)]
    pigment: Option<bool>,
    /// The JavaScript Pigment's grid.
    #[serde(skip_serializing)]
    detailed: Option<bool>,
}

fn amount(key: &str, v: Option<String>, fallback: CurvesAmount) -> Result<CurvesAmount, String> {
    match v {
        None => Ok(fallback),
        Some(s) => CurvesAmount::parse(&s).ok_or_else(|| format!("`{key}` must be light or pigment (got `{s}`)")),
    }
}

impl TryFrom<RawDisplay> for CurvesDisplay {
    type Error = String;
    fn try_from(raw: RawDisplay) -> Result<Self, String> {
        let base = CurvesDisplay::default();
        let js = raw.pigment.map(|p| CurvesAmounts::all(if p { CurvesAmount::Pigment } else { CurvesAmount::Light }));
        let amount = match raw.amount {
            None => js.unwrap_or(base.amount),
            Some(RawAmount::All(s)) => CurvesAmounts::all(amount("amount", Some(s), CurvesAmount::Light)?),
            Some(RawAmount::ByMode(m)) => {
                let d = base.amount;
                CurvesAmounts {
                    rgb: amount("amount.rgb", m.rgb, d.rgb)?,
                    cmyk: amount("amount.cmyk", m.cmyk, d.cmyk)?,
                    gray: amount("amount.gray", m.gray, d.gray)?,
                    lab: amount("amount.lab", m.lab, d.lab)?,
                }
            }
        };
        let grid = match (raw.grid, raw.detailed) {
            (Some(g), _) => CurvesGrid::parse(&g).ok_or_else(|| format!("`grid` must be simple or detailed (got `{g}`)"))?,
            (None, Some(true)) => CurvesGrid::Detailed,
            (None, _) => base.grid,
        };
        Ok(CurvesDisplay {
            amount,
            grid,
            channel_overlays: raw.channel_overlays.unwrap_or(base.channel_overlays),
            histogram: raw.histogram.unwrap_or(base.histogram),
            baseline: raw.baseline.unwrap_or(base.baseline),
            intersection_line: raw.intersection_line.unwrap_or(base.intersection_line),
        })
    }
}

impl From<CurvesDisplay> for RawDisplay {
    fn from(d: CurvesDisplay) -> Self {
        let id = |a: CurvesAmount| Some(a.id().to_owned());
        RawDisplay {
            amount: Some(RawAmount::ByMode(RawAmounts { rgb: id(d.amount.rgb), cmyk: id(d.amount.cmyk), gray: id(d.amount.gray), lab: id(d.amount.lab) })),
            grid: Some(d.grid.id().into()),
            channel_overlays: Some(d.channel_overlays),
            histogram: Some(d.histogram),
            baseline: Some(d.baseline),
            intersection_line: Some(d.intersection_line),
            pigment: None,
            detailed: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::Session;

    #[test]
    fn the_options_have_photoshops_defaults_and_their_preferences_form() {
        let d = CurvesDisplay::default();
        assert_eq!(d.amount.of(ColorMode::Cmyk), CurvesAmount::Pigment, "ink modes count ink");
        for mode in [ColorMode::Rgb, ColorMode::Grayscale, ColorMode::Lab] {
            assert_eq!(d.amount.of(mode), CurvesAmount::Light, "{mode:?}");
        }
        assert_eq!(
            serde_json::to_value(d).unwrap(),
            json!({"amount": {"rgb": "light", "cmyk": "pigment", "gray": "light", "lab": "light"}, "grid": "simple", "channelOverlays": true,
                   "histogram": true, "baseline": true, "intersectionLine": true})
        );
        // Every key optional; one word sets every mode.
        let d: CurvesDisplay = serde_json::from_value(json!({"amount": "pigment", "grid": "detailed", "histogram": false})).unwrap();
        assert_eq!((d.amount, d.grid, d.histogram, d.baseline), (CurvesAmounts::all(CurvesAmount::Pigment), CurvesGrid::Detailed, false, true));
        let d: CurvesDisplay = serde_json::from_value(json!({"amount": {"rgb": "pigment"}})).unwrap();
        assert_eq!((d.amount.rgb, d.amount.cmyk), (CurvesAmount::Pigment, CurvesAmount::Pigment));
        assert_eq!(d.amount.gray, CurvesAmount::Light);
        for bad in [
            json!({"amount": "ink"}),
            json!({"amount": {"rgb": "dark"}}),
            json!({"amount": {"hsl": "light"}}),
            json!({"grid": "fine"}),
            json!({"histogram": 1}),
        ] {
            assert!(serde_json::from_value::<CurvesDisplay>(bad.clone()).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_javascript_apps_settings_are_read() {
        // settings.adjust.curvesDisplay of Pigment 0.4 (`DISPLAY_DEFAULTS` keys).
        let js = json!({"pigment": true, "detailed": true, "overlays": false, "histogram": false, "baseline": false, "intersection": false});
        let d: CurvesDisplay = serde_json::from_value(js).unwrap();
        assert_eq!(
            d,
            CurvesDisplay {
                amount: CurvesAmounts::all(CurvesAmount::Pigment),
                grid: CurvesGrid::Detailed,
                channel_overlays: false,
                histogram: false,
                baseline: false,
                intersection_line: false
            }
        );
        // The JS app's Light applied to every mode, CMYK included.
        let d: CurvesDisplay = serde_json::from_value(json!({"pigment": false})).unwrap();
        assert_eq!(d.amount.of(ColorMode::Cmyk), CurvesAmount::Light);
    }

    #[test]
    fn prefs_set_validates_and_the_settings_store_keeps_them() {
        let mut s = Session::new();
        s.execute("prefs.set", json!({"path": "adjustments.curvesDisplay.grid", "value": "detailed"})).unwrap();
        s.execute("prefs.set", json!({"path": "adjustments.curvesDisplay.amount.rgb", "value": "pigment"})).unwrap();
        s.execute("prefs.set", json!({"path": "adjustments.curvesDisplay.histogram", "value": false})).unwrap();
        assert!(s.execute("prefs.set", json!({"path": "adjustments.curvesDisplay.grid", "value": "fine"})).is_err());
        assert!(s.execute("prefs.set", json!({"path": "adjustments.curvesDisplay.amount.cmyk", "value": 3})).is_err());
        let d = s.prefs().adjustments.curves_display;
        assert_eq!((d.grid, d.amount.rgb, d.amount.cmyk, d.histogram), (CurvesGrid::Detailed, CurvesAmount::Pigment, CurvesAmount::Pigment, false));
        assert_eq!(s.execute("prefs.get", json!({"path": "adjustments.curvesDisplay.grid"})).unwrap(), json!("detailed"));

        // Through the real store (config.toml), as the app saves and reloads its preferences.
        let dir = tempfile::tempdir().unwrap();
        let (mut store, _) = craft::settings::SettingsStore::<crate::prefs::SavedPrefs>::open_at(dir.path());
        store.set(s.saved_prefs());
        store.flush().unwrap();
        let text = std::fs::read_to_string(dir.path().join("config.toml")).unwrap();
        assert!(text.contains("curvesDisplay") && text.contains("detailed"), "{text}");
        let (store, _) = craft::settings::SettingsStore::<crate::prefs::SavedPrefs>::open_at(dir.path());
        let mut t = Session::new();
        t.set_saved_prefs(store.get().clone());
        assert_eq!(t.prefs().adjustments.curves_display, d);
        // Older files without the section load the defaults; a reset restores them.
        s.execute("prefs.reset", json!({"path": "adjustments"})).unwrap();
        assert_eq!(s.prefs().adjustments.curves_display, CurvesDisplay::default());
    }
}
