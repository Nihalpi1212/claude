//! Pigment: the Info panel's colour readout modes and 16-bit and 32-bit values (PORTS-A rows 41 and 42, package U1).
//!
//! Photoshop's Info panel has two colour readouts, each in one of ten modes (Actual Color, Proof Color, Grayscale, RGB
//! Color, Web Color, HSB Color, CMYK Color, Lab Color, Total Ink, Opacity), and every Color Sampler can have its own.
//! 16-bit documents read 0–32768 (or 0–65535 with Panel Options' choice) and 32-bit documents read floats, over 1 for
//! HDR. The framework's panel (`craft::color_ui::ui::InfoPanel`, pinned craft-libs) draws fixed 8-bit RGB and CMYK
//! lines, so **Pigment draws its own grid, in the same layout, whenever the readouts are not that**: `info.rs`
//! `info_panel` asks [`custom`] first. With the default options in an 8-bit RGB document the framework's panel stays.
//!
//! - The modes live in the panel menu (First Color Readout ▸, Second Color Readout ▸; Photoshop's eyedropper icons,
//!   which the framework's grid has no place for) and in Panel Options…, which also has the 16-bit range and a mode per
//!   Color Sampler. Units & Rulers… opens Preferences at the unit the X/Y and W/H cells use.
//! - The options are kept as JSON in `Preferences.dialogs["infoPanel"]`, as the Histogram panel keeps its own, and read
//!   from there each frame (no copy in the app): `{"first","second","sixteenBit":"32768"|"65535","samplers":[mode|""]}`.
//! - Values: Actual is the document's own channels (RGB, K for Grayscale, Bitmap and Duotone, CMYK, Lab); RGB in the
//!   depth's scale; Proof Color through View › Proof Setup's profile (its CMYK, RGB or gray numbers); CMYK and Total
//!   Ink through the document's CMYK profile (the same conversion as the framework's CMYK); Lab and HSB of the composite
//!   as sRGB, as upstream's Lab documents composite. Percent-like values are whole numbers like the framework's CMYK.

use std::cell::RefCell;
use std::sync::Arc;

use craft::behavior::ColumnWidth;
use craft::cms::Transform;
use craft::color_ui::ui::{InfoMeasure, InfoWords, SamplerReadout};
use craft::ui::contract::{Bind, CommandSet, Props as _, Show as _, ShowContainer as _};
use craft::ui::display::Text;
use craft::ui::layout_components::{Grid, Stack};
use craft::ui::menu::PanelRow;
use craft::ui::patterns::form_dialogs::{DialogFields, Param, ParamDialog, ParamKind, ParamResult};
use craft::ui::runtime::commands::{CommandRef, CommandState};
use craft::ui::runtime::env::{Env, Label};
use photocraft_color::convert::{CmykSpace, rgb_to_gray, rgb_to_hsb, srgb_to_lab, with_cmyk_space};
use photocraft_color::{ColorMode, SampleType};
use serde_json::{Value, json};

use super::info;
use crate::PhotocraftApp;
use crate::dialogs::params::{self, ParamFamily};

/// Where the options are kept (`Preferences.dialogs`).
pub(crate) const OPTIONS_PREF: &str = "infoPanel";

/// Panel Options…'s dialog key.
pub(crate) const KEY: &str = "pigment.infoPanelOptions";

/// One colour readout's mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Mode {
    Actual,
    Proof,
    Gray,
    Rgb,
    Web,
    Hsb,
    Cmyk,
    Lab,
    TotalInk,
    Opacity,
}

impl Mode {
    /// Photoshop's menu order.
    pub(crate) const ALL: [Mode; 10] =
        [Mode::Actual, Mode::Proof, Mode::Gray, Mode::Rgb, Mode::Web, Mode::Hsb, Mode::Cmyk, Mode::Lab, Mode::TotalInk, Mode::Opacity];

    /// The mode's key in the saved options and the dialog.
    pub(crate) fn key(self) -> &'static str {
        match self {
            Mode::Actual => "actual",
            Mode::Proof => "proof",
            Mode::Gray => "gray",
            Mode::Rgb => "rgb",
            Mode::Web => "web",
            Mode::Hsb => "hsb",
            Mode::Cmyk => "cmyk",
            Mode::Lab => "lab",
            Mode::TotalInk => "totalInk",
            Mode::Opacity => "opacity",
        }
    }

    pub(crate) fn from_key(key: &str) -> Option<Mode> {
        Mode::ALL.into_iter().find(|m| m.key() == key)
    }

    /// The mode's name, as Photoshop's menu words it.
    pub(crate) fn label(self) -> String {
        match self {
            Mode::Actual => tl!("Actual Color"),
            Mode::Proof => tl!("Proof Color"),
            Mode::Gray => tl!("Grayscale"),
            Mode::Rgb => tl!("RGB Color"),
            Mode::Web => tl!("Web Color"),
            Mode::Hsb => tl!("HSB Color"),
            Mode::Cmyk => tl!("CMYK Color"),
            Mode::Lab => tl!("Lab Color"),
            Mode::TotalInk => tl!("Total Ink"),
            Mode::Opacity => tl!("Opacity"),
        }
        .to_owned()
    }
}

/// How 16-bit values read.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum SixteenBit {
    /// 0–32768, Photoshop's default.
    #[default]
    Half,
    /// 0–65535.
    Full,
}

impl SixteenBit {
    fn key(self) -> &'static str {
        match self {
            SixteenBit::Half => "32768",
            SixteenBit::Full => "65535",
        }
    }

    fn scale(self) -> f32 {
        match self {
            SixteenBit::Half => 32768.0,
            SixteenBit::Full => 65535.0,
        }
    }
}

/// The panel's options.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct InfoOptions {
    pub(crate) first: Mode,
    pub(crate) second: Mode,
    pub(crate) sixteen: SixteenBit,
    /// Color Sampler `i`'s own mode; `None` (or past the end) shows the panel's two readouts.
    pub(crate) samplers: Vec<Option<Mode>>,
}

impl Default for InfoOptions {
    fn default() -> Self {
        InfoOptions { first: Mode::Actual, second: Mode::Cmyk, sixteen: SixteenBit::Half, samplers: Vec::new() }
    }
}

impl InfoOptions {
    /// The options `v` holds; a missing or unknown value keeps its default.
    pub(crate) fn from_value(v: &Value) -> Self {
        let d = InfoOptions::default();
        let mode = |key: &str, default: Mode| v.get(key).and_then(Value::as_str).and_then(Mode::from_key).unwrap_or(default);
        let sixteen = match v.get("sixteenBit") {
            Some(Value::String(s)) if s == "65535" => SixteenBit::Full,
            Some(Value::Number(n)) if n.as_u64() == Some(65535) => SixteenBit::Full,
            _ => SixteenBit::Half,
        };
        let samplers = v
            .get("samplers")
            .and_then(Value::as_array)
            .map(|list| list.iter().take(photocraft_engine::sampler_cmds::MAX_SAMPLERS).map(|m| m.as_str().and_then(Mode::from_key)).collect())
            .unwrap_or_default();
        let mut o = InfoOptions { first: mode("first", d.first), second: mode("second", d.second), sixteen, samplers };
        o.trim();
        o
    }

    /// The options as saved: no nulls (the preferences are TOML), `""` for a sampler without its own mode.
    pub(crate) fn to_value(&self) -> Value {
        let samplers: Vec<&str> = self.samplers.iter().map(|m| m.map_or("", Mode::key)).collect();
        json!({"first": self.first.key(), "second": self.second.key(), "sixteenBit": self.sixteen.key(), "samplers": samplers})
    }

    /// Color Sampler `index`'s own mode.
    pub(crate) fn sampler(&self, index: usize) -> Option<Mode> {
        self.samplers.get(index).copied().flatten()
    }

    /// Drops the samplers without a mode of their own at the end.
    fn trim(&mut self) {
        while self.samplers.last().is_some_and(Option::is_none) {
            self.samplers.pop();
        }
    }
}

/// The saved options.
pub(crate) fn options(app: &PhotocraftApp) -> InfoOptions {
    app.session.prefs().dialogs.get(OPTIONS_PREF).map(InfoOptions::from_value).unwrap_or_default()
}

/// Saves `o`; the Info panel shows it at once.
pub(crate) fn set_options(app: &mut PhotocraftApp, mut o: InfoOptions) {
    o.trim();
    if options(app) == o {
        return;
    }
    let value = o.to_value();
    app.session.prefs.edit(|p| {
        p.dialogs.insert(OPTIONS_PREF.into(), value);
    });
    // The panel's settling region redraws on a command run (`region_versions::version`).
    app.commands_run += 1;
    app.ctx().request_repaint();
}

/// The options when Pigment's grid draws the panel: `None` while the framework's would show the same thing (a
/// document in 8 bits, the first readout RGB, or Actual in an RGB-like document, the second CMYK, and no sampler with a
/// mode of its own) and without a document.
pub(crate) fn custom(app: &PhotocraftApp) -> Option<InfoOptions> {
    let st = app.session.active()?;
    let o = options(app);
    let rgb_doc = actual_mode(st.doc.mode) == Mode::Rgb;
    let framework_first = o.first == Mode::Rgb || (o.first == Mode::Actual && rgb_doc);
    let same = framework_first && o.second == Mode::Cmyk && st.doc.depth == SampleType::U8 && o.samplers.iter().all(Option::is_none);
    (!same).then_some(o)
}

// ---------------------------------------------------------------------------------------------
// Values

/// What a readout's values depend on besides the colour.
#[derive(Clone)]
pub(crate) struct Space {
    pub(crate) depth: SampleType,
    pub(crate) mode: ColorMode,
    pub(crate) sixteen: SixteenBit,
    /// The document's CMYK profile, for a CMYK document.
    pub(crate) cmyk: Option<Arc<CmykSpace>>,
    /// The composite → Proof Setup transform, when a Proof Color readout needs it and it could be built.
    pub(crate) proof: Option<Proof>,
    /// The composite is linear light (an OpenEXR or Radiance file, a linear profile): the readouts that
    /// read it as sRGB (Grayscale, Lab, HSB, Web, CMYK, Total Ink) take it through the sRGB curve first,
    /// as the canvas shows it. RGB shows the stored values, as Photoshop's 32-bit readout does.
    pub(crate) linear: bool,
}

impl Space {
    /// An 8-bit RGB document's.
    #[cfg(test)]
    pub(crate) fn rgb(depth: SampleType) -> Space {
        Space { depth, mode: ColorMode::Rgb, sixteen: SixteenBit::Half, cmyk: None, proof: None, linear: false }
    }
}

/// View › Proof Setup's transform from the composite.
#[derive(Clone)]
pub(crate) struct Proof {
    transform: Arc<Transform>,
    /// The proof profile's channels: 4 CMYK, 3 RGB, 1 gray.
    channels: usize,
    /// The composite is linear and the transform's source is its sRGB-curve twin (`CanvasDisplay::encode_srgb`).
    encode_srgb: bool,
}

/// The name of one readout value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Name {
    R,
    G,
    B,
    C,
    M,
    Y,
    K,
    L,
    LabA,
    LabB,
    Hue,
    Saturation,
    Brightness,
    Hex,
    TotalInk,
    Opacity,
}

impl Name {
    /// The name as the panel shows it: the framework's words where it has them.
    pub(crate) fn text(self, words: &InfoWords) -> String {
        let lang = crate::i18n::current();
        let own = |s: &'static str| crate::i18n::tr_ctx(lang, "infoPanel", s).to_owned();
        match self {
            Name::R => words.r.as_str().to_owned(),
            Name::G => words.g.as_str().to_owned(),
            Name::B => words.b.as_str().to_owned(),
            Name::C => words.c.as_str().to_owned(),
            Name::M => words.m.as_str().to_owned(),
            Name::Y => words.y.as_str().to_owned(),
            Name::K => words.k.as_str().to_owned(),
            Name::L => own("L"),
            Name::LabA => own("a"),
            Name::LabB => own("b"),
            Name::Hue => own("H"),
            Name::Saturation => own("S"),
            Name::Brightness => own("B"),
            Name::Hex => own("#"),
            Name::TotalInk => tl!("Total Ink").to_owned(),
            Name::Opacity => tl!("Opacity").to_owned(),
        }
    }
}

/// The readout a document in `mode` shows as Actual Color.
fn actual_mode(mode: ColorMode) -> Mode {
    match mode {
        ColorMode::Grayscale | ColorMode::Bitmap | ColorMode::Duotone => Mode::Gray,
        ColorMode::Cmyk => Mode::Cmyk,
        ColorMode::Lab => Mode::Lab,
        ColorMode::Rgb | ColorMode::Indexed | ColorMode::Multichannel => Mode::Rgb,
    }
}

/// `v` as a unit value: clamped, 0 when not finite.
fn unit(v: f32) -> f32 {
    if v.is_finite() { v.clamp(0.0, 1.0) } else { 0.0 }
}

/// A whole percent of the unit value `v`.
fn percent(v: f32) -> i32 {
    (unit(v) * 100.0).round() as i32
}

/// An 8-bit level.
fn byte(v: f32) -> u8 {
    (unit(v) * 255.0).round() as u8
}

/// A channel in the depth's scale: 0–255; 0–32768 or 0–65535; a float with four decimals, not clamped.
pub(crate) fn deep(v: f32, depth: SampleType, sixteen: SixteenBit) -> String {
    match depth {
        SampleType::U8 => byte(v).to_string(),
        SampleType::U16 => ((unit(v) * sixteen.scale()).round() as u32).to_string(),
        SampleType::F32 => format!("{:.4}", if v.is_finite() { v } else { 0.0 }),
    }
}

/// The colour's CMYK percentages through the document's CMYK profile, as the framework's readout has them.
fn cmyk(rgb: [f32; 3], space: &Space) -> [i32; 4] {
    with_cmyk_space(space.cmyk.as_ref(), || photocraft_engine::sampler_cmds::device_cmyk(rgb[0], rgb[1], rgb[2])).map(|v| v.clamp(0, 100))
}

/// The values readout `mode` shows for the straight RGBA composite colour `rgba` (0..1; over 1 in 32 bits).
pub(crate) fn readout(mode: Mode, rgba: [f32; 4], space: &Space) -> Vec<(Name, String)> {
    let rgb = [rgba[0], rgba[1], rgba[2]];
    let unit_rgb = rgb.map(unit);
    // Review FU: a linear composite read as sRGB showed mid grey (0.2159) as 363636 and L 22.
    let encoded = if space.linear { unit_rgb.map(photocraft_color::convert::linear_to_srgb) } else { unit_rgb };
    match mode {
        Mode::Actual => readout(actual_mode(space.mode), rgba, space),
        Mode::Rgb => [Name::R, Name::G, Name::B].into_iter().zip(rgb).map(|(n, v)| (n, deep(v, space.depth, space.sixteen))).collect(),
        Mode::Cmyk => [Name::C, Name::M, Name::Y, Name::K].into_iter().zip(cmyk(encoded, space)).map(|(n, v)| (n, v.to_string())).collect(),
        Mode::Gray => vec![(Name::K, percent(1.0 - rgb_to_gray(encoded)).to_string())],
        Mode::Lab => {
            let lab = srgb_to_lab(encoded).map(|v| (v.round() as i32).to_string());
            [Name::L, Name::LabA, Name::LabB].into_iter().zip(lab).collect()
        }
        Mode::Hsb => {
            let [h, s, b] = rgb_to_hsb(encoded);
            let degrees = (h.round() as i32).rem_euclid(360);
            vec![(Name::Hue, format!("{degrees}°")), (Name::Saturation, format!("{}%", percent(s))), (Name::Brightness, format!("{}%", percent(b)))]
        }
        Mode::Web => {
            let [r, g, b] = encoded.map(byte);
            vec![(Name::Hex, format!("{r:02X}{g:02X}{b:02X}"))]
        }
        Mode::TotalInk => vec![(Name::TotalInk, format!("{}%", cmyk(encoded, space).iter().sum::<i32>()))],
        Mode::Opacity => vec![(Name::Opacity, format!("{}%", percent(rgba[3])))],
        Mode::Proof => match &space.proof {
            Some(proof) => proof_readout(proof, unit_rgb, space),
            None => readout(Mode::Cmyk, rgba, space),
        },
    }
}

/// Proof Color: the colour's numbers in the proof profile.
fn proof_readout(proof: &Proof, rgb: [f32; 3], space: &Space) -> Vec<(Name, String)> {
    let input = if proof.encode_srgb { rgb.map(photocraft_color::convert::linear_to_srgb) } else { rgb };
    let mut out = [0.0f32; 16];
    if proof.transform.eval(&input, &mut out).is_err() {
        return readout(Mode::Cmyk, [rgb[0], rgb[1], rgb[2], 1.0], space);
    }
    match proof.channels {
        4 => [Name::C, Name::M, Name::Y, Name::K].into_iter().zip(out).map(|(n, v)| (n, percent(v).to_string())).collect(),
        1 => vec![(Name::K, percent(1.0 - out[0]).to_string())],
        _ => [Name::R, Name::G, Name::B].into_iter().zip(out).map(|(n, v)| (n, deep(v, space.depth, space.sixteen))).collect(),
    }
}

/// What a Proof Color transform is built from: the source and proof profiles' hashes, the intent, BPC.
type ProofKey = (u64, u64, String, bool);

thread_local! {
    /// The last Proof Color transform and what it was built from.
    static PROOF: RefCell<Option<(ProofKey, Arc<Transform>)>> = const { RefCell::new(None) };
}

/// The active document's Proof Color transform: from its composite to View › Proof Setup's profile, with its intent
/// and black point compensation (whether or not View › Proof Colors is on, as Photoshop reads it).
fn proof(app: &PhotocraftApp) -> Option<Proof> {
    let st = app.session.active()?;
    let display = app.session.color.canvas_display_for(&st.doc, None).ok()?;
    let setup = app.session.color.proof(st.doc.id).setup;
    let key = (display.source.content_hash(), setup.profile.content_hash(), format!("{:?}", setup.intent), setup.bpc);
    let transform = PROOF.with(|cache| {
        let mut cache = cache.borrow_mut();
        if let Some((k, t)) = cache.as_ref()
            && *k == key
        {
            return Some(t.clone());
        }
        let t = Arc::new(Transform::new(&display.source, &setup.profile, setup.intent, setup.bpc).ok()?);
        *cache = Some((key, t.clone()));
        Some(t)
    })?;
    Some(Proof { transform, channels: setup.profile.channels(), encode_srgb: display.encode_srgb })
}

/// The active document's [`Space`] under `o`.
fn space(app: &PhotocraftApp, o: &InfoOptions) -> Option<Space> {
    let st = app.session.active()?;
    let uses_proof = o.first == Mode::Proof || o.second == Mode::Proof || o.samplers.contains(&Some(Mode::Proof));
    Some(Space {
        depth: st.doc.depth,
        mode: st.doc.mode,
        sixteen: o.sixteen,
        cmyk: photocraft_compose::cmyk_space(&st.doc),
        proof: if uses_proof { proof(app) } else { None },
        linear: app.session.color.canvas_display_for(&st.doc, None).is_ok_and(|d| d.encode_srgb),
    })
}

// ---------------------------------------------------------------------------------------------
// The grid

/// A name and its value (`None` for a dash), or an empty pair.
pub(crate) type Cell = Option<(String, Option<String>)>;

/// One line of the grid: two pairs.
pub(crate) type Line = [Cell; 2];

/// What Pigment's grid shows, in the framework panel's layout.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Panel {
    /// The two readouts side by side, the Ruler tool's measure, X/Y beside W/H.
    pub(crate) lines: Vec<Line>,
    /// "Doc: W x H".
    pub(crate) document: String,
    /// Each Color Sampler: "#n" and its lines.
    pub(crate) samplers: Vec<(String, Vec<Line>)>,
}

/// `cells` two to a line.
fn in_pairs(cells: Vec<(String, Option<String>)>) -> Vec<Line> {
    let mut cells = cells.into_iter();
    let mut lines = Vec::new();
    while let Some(left) = cells.next() {
        lines.push([Some(left), cells.next()]);
    }
    lines
}

/// Readout `mode`'s names with `rgba`'s values, or dashes without a colour.
fn cells(mode: Mode, rgba: Option<[f32; 4]>, space: &Space, words: &InfoWords) -> Vec<(String, Option<String>)> {
    readout(mode, rgba.unwrap_or_default(), space).into_iter().map(|(n, v)| (n.text(words), rgba.map(|_| v))).collect()
}

/// A Color Sampler's colour before rounding: its `float`, else its 8-bit `rgb`.
fn sampler_rgba(readouts: &[Value], number: usize) -> Option<[f32; 4]> {
    let s = readouts.iter().find(|s| s["number"].as_u64() == Some(number as u64))?;
    let list = |key: &str| -> Option<Vec<f32>> { s[key].as_array()?.iter().map(|v| v.as_f64().map(|f| f as f32)).collect() };
    if let Some(f) = list("float").filter(|f| f.len() >= 4) {
        return Some([f[0], f[1], f[2], f[3]]);
    }
    let rgb = list("rgb").filter(|v| v.len() >= 3)?;
    Some([rgb[0] / 255.0, rgb[1] / 255.0, rgb[2] / 255.0, 1.0])
}

/// The grid for the active document under `o`, worded with `words`.
pub(crate) fn panel_lines(app: &mut PhotocraftApp, samplers: &[(SamplerReadout, [Label; 2])], o: &InfoOptions, words: &InfoWords) -> Panel {
    let Some(space) = space(app, o) else { return Panel { lines: Vec::new(), document: String::new(), samplers: Vec::new() } };
    let rgba = info::hover_pixel(app).and_then(|p| info::pointer_sample(app, p));
    let readings = info::readings(app, samplers);
    let (first, second) = (cells(o.first, rgba, &space, words), cells(o.second, rgba, &space, words));
    let mut lines: Vec<Line> = (0..first.len().max(second.len())).map(|i| [first.get(i).cloned(), second.get(i).cloned()]).collect();
    let name = |label: &Label| label.as_str().to_owned();
    let some = |label: &Label| Some(name(label));
    match &readings.measure {
        Some(InfoMeasure::Line { angle, length, .. }) => lines.push([Some((name(&words.angle), some(angle))), Some((name(&words.length), some(length)))]),
        Some(InfoMeasure::Protractor { angle, first, second, .. }) => {
            lines.push([Some((name(&words.angle), some(angle))), Some((name(&words.length1), some(first)))]);
            lines.push([None, Some((name(&words.length2), some(second)))]);
        }
        _ => {}
    }
    let axes = [(&words.x, &words.w), (&words.pos_y, &words.h)];
    for (axis, (position, extent)) in axes.into_iter().enumerate() {
        lines.push([
            Some((name(position), readings.position.as_ref().map(|at| name(&at[axis])))),
            Some((name(extent), readings.extent.as_ref().map(|size| name(&size[axis])))),
        ]);
    }
    let [width, height] = readings.document.unwrap_or_default();
    let document = words.document.fill(&[("width", &width.to_string()), ("height", &height.to_string())]);
    let readouts = info::sampler_readouts(app);
    let samplers = samplers
        .iter()
        .map(|(readout, position)| {
            let rgba = sampler_rgba(&readouts, readout.number);
            let mut lines = vec![[Some((name(&words.x), some(&position[0]))), Some((name(&words.pos_y), some(&position[1])))]];
            let modes = match o.sampler(readout.number.saturating_sub(1)) {
                Some(mode) => vec![mode],
                None => vec![o.first, o.second],
            };
            for mode in modes {
                lines.extend(in_pairs(cells(mode, rgba, &space, words)));
            }
            (format!("#{}", readout.number), lines)
        })
        .collect();
    Panel { lines, document, samplers }
}

/// The grid of the active document as the panel shows it now, in English, or `None` while the framework's panel
/// draws it: what the tests read.
#[cfg(test)]
pub(crate) fn lines(app: &mut PhotocraftApp) -> Option<Panel> {
    let o = custom(app)?;
    let samplers = info::sampler_rows(app);
    Some(panel_lines(app, &samplers, &o, &InfoWords::default()))
}

/// The columns: a name and its value, twice, as the framework's grid has them.
static COLUMNS: [ColumnWidth; 4] = [ColumnWidth::Content, ColumnWidth::Content, ColumnWidth::Content, ColumnWidth::Content];

/// What a missing value shows (the framework's dash).
const DASH: &str = "–";

fn table(ui: &mut egui::Ui, lines: &[Line]) {
    let _ = Grid::new(&COLUMNS).show(ui, |ui, _| {
        for line in lines {
            for cell in line {
                let (name, value) = match cell {
                    Some((name, value)) => (name.clone(), value.clone().unwrap_or_else(|| DASH.to_owned())),
                    None => (String::new(), String::new()),
                };
                Text::new(Label::from(name)).show(ui);
                Text::new(Label::from(value)).show(ui);
            }
        }
    });
}

/// Draws Pigment's grid (the hook in `info::info_panel`).
pub(crate) fn show_panel(app: &mut PhotocraftApp, ui: &mut egui::Ui, samplers: &[(SamplerReadout, [Label; 2])], o: InfoOptions) {
    let words = Env::of(ui).words::<InfoWords>().clone();
    let panel = panel_lines(app, samplers, &o, &words);
    Stack::new().label(tl!("Info")).show(ui, |ui, _| {
        table(ui, &panel.lines);
        Text::new(Label::from(panel.document.clone())).show(ui);
        for (number, lines) in &panel.samplers {
            Text::new(Label::from(number.clone())).show(ui);
            table(ui, lines);
        }
    });
}

// ---------------------------------------------------------------------------------------------
// The panel menu

/// The Info panel menu's rows (Pigment's: upstream's Info panel has none).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, CommandSet)]
#[command(prefix = "infoPanel", scope = "app")]
pub(crate) enum InfoPanelCommand {
    /// Panel Options…: both readouts' modes, the 16-bit range and the Color Samplers' modes.
    #[command(label = "Panel Options…")]
    PanelOptions,
    #[command(label = "First Color Readout: Actual Color")]
    FirstActual,
    #[command(label = "First Color Readout: Proof Color")]
    FirstProof,
    #[command(label = "First Color Readout: Grayscale")]
    FirstGray,
    #[command(label = "First Color Readout: RGB Color")]
    FirstRgb,
    #[command(label = "First Color Readout: Web Color")]
    FirstWeb,
    #[command(label = "First Color Readout: HSB Color")]
    FirstHsb,
    #[command(label = "First Color Readout: CMYK Color")]
    FirstCmyk,
    #[command(label = "First Color Readout: Lab Color")]
    FirstLab,
    #[command(label = "First Color Readout: Total Ink")]
    FirstTotalInk,
    #[command(label = "First Color Readout: Opacity")]
    FirstOpacity,
    #[command(label = "Second Color Readout: Actual Color")]
    SecondActual,
    #[command(label = "Second Color Readout: Proof Color")]
    SecondProof,
    #[command(label = "Second Color Readout: Grayscale")]
    SecondGray,
    #[command(label = "Second Color Readout: RGB Color")]
    SecondRgb,
    #[command(label = "Second Color Readout: Web Color")]
    SecondWeb,
    #[command(label = "Second Color Readout: HSB Color")]
    SecondHsb,
    #[command(label = "Second Color Readout: CMYK Color")]
    SecondCmyk,
    #[command(label = "Second Color Readout: Lab Color")]
    SecondLab,
    #[command(label = "Second Color Readout: Total Ink")]
    SecondTotalInk,
    #[command(label = "Second Color Readout: Opacity")]
    SecondOpacity,
}

/// The first readout's rows, in [`Mode::ALL`]'s order.
const FIRST: [InfoPanelCommand; 10] = [
    InfoPanelCommand::FirstActual,
    InfoPanelCommand::FirstProof,
    InfoPanelCommand::FirstGray,
    InfoPanelCommand::FirstRgb,
    InfoPanelCommand::FirstWeb,
    InfoPanelCommand::FirstHsb,
    InfoPanelCommand::FirstCmyk,
    InfoPanelCommand::FirstLab,
    InfoPanelCommand::FirstTotalInk,
    InfoPanelCommand::FirstOpacity,
];

/// The second readout's rows, in [`Mode::ALL`]'s order.
const SECOND: [InfoPanelCommand; 10] = [
    InfoPanelCommand::SecondActual,
    InfoPanelCommand::SecondProof,
    InfoPanelCommand::SecondGray,
    InfoPanelCommand::SecondRgb,
    InfoPanelCommand::SecondWeb,
    InfoPanelCommand::SecondHsb,
    InfoPanelCommand::SecondCmyk,
    InfoPanelCommand::SecondLab,
    InfoPanelCommand::SecondTotalInk,
    InfoPanelCommand::SecondOpacity,
];

/// Preferences › Units & Rulers, where the X/Y and W/H unit is chosen (Photoshop's Panel Options has it as Mouse
/// Coordinates; Pigment links to the one setting instead of keeping a second).
pub(crate) const UNITS: &str = "edit.preferences.unitsAndRulers";

/// Which readout (0 first, 1 second) and mode a row sets.
fn mode_of(command: InfoPanelCommand) -> Option<(usize, Mode)> {
    let at = |table: &[InfoPanelCommand; 10]| table.iter().position(|c| *c == command).map(|i| Mode::ALL[i]);
    at(&FIRST).map(|m| (0, m)).or_else(|| at(&SECOND).map(|m| (1, m)))
}

/// The Info panel menu's rows.
pub(crate) fn panel_rows(_app: &PhotocraftApp) -> Vec<PanelRow> {
    let rows = |table: &[InfoPanelCommand; 10]| table.iter().map(|c| PanelRow::Command(CommandRef::from(*c))).collect();
    vec![
        PanelRow::Submenu(Label::from(tl!("First Color Readout")), rows(&FIRST)),
        PanelRow::Submenu(Label::from(tl!("Second Color Readout")), rows(&SECOND)),
        PanelRow::Separator,
        PanelRow::Command(CommandRef::from(InfoPanelCommand::PanelOptions)),
        PanelRow::Command(CommandRef::new(UNITS)),
    ]
}

/// The mode rows are radio rows worded by their mode alone; each submenu checks its readout's mode.
pub(crate) fn command_states(app: &PhotocraftApp) -> Vec<(CommandRef, CommandState)> {
    let o = options(app);
    let mut states = vec![(CommandRef::from(InfoPanelCommand::PanelOptions), CommandState::new())];
    for (table, current) in [(&FIRST, o.first), (&SECOND, o.second)] {
        for (command, mode) in table.iter().zip(Mode::ALL) {
            states.push((CommandRef::from(*command), CommandState::new().checked(mode == current).title(mode.label())));
        }
    }
    states
}

/// Runs a fired row of the Info panel menu; `false` for another panel's command.
pub(crate) fn run_fired(app: &mut PhotocraftApp, _ctx: &egui::Context, command: &CommandRef) -> bool {
    let Some(command) = InfoPanelCommand::from_ref(command) else { return false };
    match mode_of(command) {
        Some((readout, mode)) => {
            let mut o = options(app);
            if readout == 0 {
                o.first = mode;
            } else {
                o.second = mode;
            }
            set_options(app, o);
        }
        None => {
            open_options(app);
        }
    }
    true
}

// ---------------------------------------------------------------------------------------------
// Panel Options…

/// The field of Color Sampler `index`'s mode.
fn sampler_key(index: usize) -> String {
    format!("sampler{index}")
}

/// A sampler's choice of keeping the panel's readouts.
const PANEL_READOUTS: &str = "panel";

/// The dialog's fields for `o` with `count` Color Samplers.
pub(crate) fn fields_of(o: &InfoOptions, count: usize) -> DialogFields {
    let mut f = DialogFields::new();
    f.set("first", o.first.key());
    f.set("second", o.second.key());
    f.set("sixteenBit", o.sixteen.key());
    for i in 0..count {
        f.set(sampler_key(i), o.sampler(i).map_or(PANEL_READOUTS, Mode::key));
    }
    f
}

/// The options the fields hold over `base` (a missing or bad field keeps `base`'s).
pub(crate) fn options_of(f: &DialogFields, base: &InfoOptions, count: usize) -> InfoOptions {
    let mode = |key: &str| f.text(key).and_then(Mode::from_key);
    let mut o = base.clone();
    o.first = mode("first").unwrap_or(base.first);
    o.second = mode("second").unwrap_or(base.second);
    o.sixteen = match f.text("sixteenBit") {
        Some("65535") => SixteenBit::Full,
        Some("32768") => SixteenBit::Half,
        _ => base.sixteen,
    };
    for i in 0..count {
        let key = sampler_key(i);
        let Some(value) = f.text(&key) else { continue };
        if o.samplers.len() <= i {
            o.samplers.resize(i + 1, None);
        }
        o.samplers[i] = Mode::from_key(value);
    }
    o.trim();
    o
}

/// The dialog's rows with `count` Color Samplers.
fn rows(count: usize) -> Vec<Param> {
    let modes = || Mode::ALL.iter().map(|m| (m.key().to_owned(), Label::from(m.label()))).collect::<Vec<_>>();
    let mut rows = vec![
        Param::section(tl!("First Color Readout")),
        Param::new("first", tl!("Mode:"), ParamKind::choice(modes(), None)),
        Param::section(tl!("Second Color Readout")),
        Param::new("second", tl!("Mode:"), ParamKind::choice(modes(), None)),
        Param::new(
            "sixteenBit",
            "",
            ParamKind::radio(
                vec![("32768".to_owned(), Label::from(tl!("16-bit values: 0–32768"))), ("65535".to_owned(), Label::from(tl!("16-bit values: 0–65535")))],
                None,
            ),
        ),
    ];
    if count > 0 {
        rows.push(Param::section(tl!("Color Samplers")));
        for i in 0..count {
            let mut choices = vec![(PANEL_READOUTS.to_owned(), Label::from(tl!("Same as the Panel")))];
            choices.extend(modes());
            let label = crate::i18n::fmt(tl!("Sampler #{n}:"), &[("n", &(i + 1).to_string())]);
            rows.push(Param::new(sampler_key(i), label, ParamKind::choice(choices, None)));
        }
    }
    rows
}

/// The active document's Color Sampler count.
fn sampler_count(app: &PhotocraftApp) -> usize {
    app.session.active().map_or(0, |st| st.color_samplers.len())
}

/// Opens Panel Options… on the saved options.
pub(crate) fn open_options(app: &mut PhotocraftApp) -> craft::ui::dialog::DialogId {
    let count = sampler_count(app);
    let fields = fields_of(&options(app), count);
    let rows = rows(count);
    let title = Label::from(tl!("Info Panel Options"));
    params::open_param_unsaved(app, KEY, fields, json!({"samplers": count}), move |fields: &mut DialogFields| {
        ParamDialog::command(KEY, title.clone(), rows.clone()).values(Bind::bound(fields))
    })
}

/// OK: the options are saved.
fn run_options(app: &mut PhotocraftApp, _ctx: &egui::Context, result: ParamResult) {
    let count = params::captured(app, KEY)["samplers"].as_u64().map_or(0, |n| n as usize);
    let o = options_of(&result.fields, &options(app), count);
    set_options(app, o);
}

/// Panel Options…'s result handler (`dialogs::params::PARAM_FAMILIES`).
pub(crate) const FAMILY: ParamFamily = ParamFamily::new(|key| key == KEY, run_options);

#[cfg(test)]
#[path = "info_readout_tests.rs"]
mod tests;
