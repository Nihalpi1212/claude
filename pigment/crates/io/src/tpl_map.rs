//! Photoshop tool presets (`.tpl`) ↔ Window › Tool Presets (Pigment's).
//!
//! The layout read and written here is the one the JavaScript Pigment 0.5 used
//! (`src/renderer/lib/preset-files/tpl.js` on its `wip05` branch): `8BTP`, version 1 and minor
//! version 2, then `8BIM` sections as in an `.abr` file of version 6.2:
//!
//! ```text
//! "samp"  the sampled brush tips (as in .abr 6.2; read through craft-psd's .abr reader)
//! "patt"  patterns that textured brushes use (the `Patt` block layout)
//! "desc"  a version-16 descriptor whose list `Prst` holds one object per preset:
//!           "Nm  "        the name
//!           "Tool"        an object whose class is Photoshop's tool class ("paintbrushTool"),
//!                         holding the tool options: "Md  " mode, "Opct" opacity, "flow", and for
//!                         the type tools "TxtS" (font "FntN", size "Sz  ")
//!           "Brsh"        a painting tool's brush, a `brushPreset` descriptor as in an .abr file
//!           "pigmentData" Pigment's own options as JSON text
//! ```
//!
//! The reader is lenient, as the JavaScript one was: sections in any order, any list of named
//! objects in the descriptor, unknown keys skipped, and a file without sections scanned for
//! descriptors. Photoshop does not publish the layout; this follows the `.abr` structure.
//!
//! `pigmentData` takes three forms. Files this module writes hold
//! `{"format":"pigment-tool-preset","version":1,"tool","options"}`: the tool preset exactly as the
//! engine keeps it, with each sampled tip replaced by `{"tplSample": id}`, the id of its tip in
//! `samp` (written at 16 bits, so it comes back exactly). Files the JavaScript Pigment 0.5 wrote
//! hold `{"tool", "options", "type"?, "color"?}` in that app's terms (tool ids such as
//! `spot-heal`, options such as `blend: "multiply"`), mapped through [`JS_TOOLS`]. Photoshop's
//! own files have none: their keys are mapped. Options that have no equivalent are counted in a
//! warning.
//!
//! A preset's brush goes to `options.brush` (the brush settings JSON the engine applies with
//! `tools.setBrush`), its tool options to `options.toolOptions` under the desktop shell's keys
//! (`fill_opacity`, `gradient_blend_mode`, `type_font`…). Opacity, flow and mode of a painting
//! tool are brush settings in PhotoCraft, so they go to the brush.

use craft_psd::abr::{self, AbrFile, AbrSample};
use craft_psd::descriptor::{Descriptor, Id, UnicodeString, Value as DValue, VersionedDescriptor};
use photocraft_color::BlendMode;
use photocraft_paint::{BrushSettings, GrayTile, TipShape};
use serde_json::{Map, Value, json};

/// The `format` of the `pigmentData` this module writes.
pub const PIGMENT_FORMAT: &str = "pigment-tool-preset";
/// Most presets read from one file (the engine keeps at most 1000 tool presets in all).
pub const MAX_PRESETS: usize = 10_000;
/// Longest `pigmentData` text read (characters).
const MAX_PIGMENT_DATA: usize = 64 << 20;

/// PhotoCraft's tool names (as the engine and `Tool::from_name` spell them) and Photoshop's tool
/// classes. A class listed twice reads as its first tool (Star is a Polygon in Photoshop).
pub const TOOL_CLASSES: &[(&str, &str)] = &[
    ("move", "moveTool"),
    ("artboard", "artboardTool"),
    ("rectMarquee", "marqueeRectTool"),
    ("ellipseMarquee", "marqueeEllipTool"),
    ("singleRowMarquee", "marqueeSingleRowTool"),
    ("singleColumnMarquee", "marqueeSingleColumnTool"),
    ("lasso", "lassoTool"),
    ("polygonLasso", "polySelTool"),
    ("magneticLasso", "magneticLassoTool"),
    ("magicWand", "magicWandTool"),
    ("quickSelection", "quickSelectTool"),
    ("objectSelection", "magicLassoTool"),
    ("crop", "cropTool"),
    ("perspectiveCrop", "perspectiveCropTool"),
    ("slice", "sliceTool"),
    ("sliceSelect", "sliceSelectTool"),
    ("frame", "framedGroupTool"),
    ("eyedropper", "eyedropperTool"),
    ("colorSampler", "colorSamplerTool"),
    ("ruler", "rulerTool"),
    ("note", "textAnnotTool"),
    ("count", "countTool"),
    ("spotHealing", "spotHealingBrushTool"),
    ("remove", "removeTool"),
    ("healing", "magicStampTool"),
    ("patch", "patchSelection"),
    ("contentAwareMove", "recomposeSelection"),
    ("redEye", "redEyeTool"),
    ("brush", "paintbrushTool"),
    ("pencil", "pencilTool"),
    ("colorReplacement", "colorReplacementBrushTool"),
    ("mixerBrush", "wetBrushTool"),
    ("cloneStamp", "cloneStampTool"),
    ("patternStamp", "patternStampTool"),
    ("historyBrush", "historyBrushTool"),
    ("artHistoryBrush", "artBrushTool"),
    ("eraser", "eraserTool"),
    ("backgroundEraser", "backgroundEraserTool"),
    ("magicEraser", "magicEraserTool"),
    ("gradient", "gradientTool"),
    ("paintBucket", "bucketTool"),
    ("blur", "blurTool"),
    ("sharpen", "sharpenTool"),
    ("smudge", "smudgeTool"),
    ("dodge", "dodgeTool"),
    ("burn", "burnInTool"),
    ("sponge", "saturationTool"),
    ("pen", "penTool"),
    ("freeformPen", "freeformPenTool"),
    ("curvaturePen", "curvaturePenTool"),
    ("addAnchorPoint", "addKnotTool"),
    ("deleteAnchorPoint", "deleteKnotTool"),
    ("convertPoint", "convertKnotTool"),
    ("type", "typeCreateOrEditTool"),
    ("verticalType", "typeVerticalCreateOrEditTool"),
    ("horizontalTypeMask", "typeCreateMaskTool"),
    ("verticalTypeMask", "typeVerticalCreateMaskTool"),
    ("pathSelection", "pathComponentSelectTool"),
    ("directSelection", "directSelectTool"),
    ("rectangle", "rectangleTool"),
    ("ellipseShape", "ellipseTool"),
    ("triangle", "triangleTool"),
    ("polygon", "polygonTool"),
    ("star", "polygonTool"),
    ("line", "lineTool"),
    ("customShape", "customShapeTool"),
    ("hand", "handTool"),
    ("rotateView", "rotateTool"),
    ("zoom", "zoomTool"),
];

/// Other spellings of Photoshop's classes read (the four-letter ids the JavaScript reader took).
const CLASS_ALIASES: &[(&str, &str)] = &[
    ("PbTl", "brush"),
    ("PcTl", "pencil"),
    ("ErTl", "eraser"),
    ("ClTl", "cloneStamp"),
    ("PaTl", "patternStamp"),
    ("HstB", "historyBrush"),
    ("BlTl", "blur"),
    ("ShTl", "sharpen"),
    ("SmTl", "smudge"),
    ("DdTl", "dodge"),
    ("BrTl", "burn"),
    ("GrTl", "gradient"),
    ("BckT", "paintBucket"),
    ("TxtT", "type"),
    ("MvTl", "move"),
    ("CrpT", "crop"),
    ("EyDr", "eyedropper"),
    ("roundedRectangleTool", "rectangle"),
];

/// The JavaScript Pigment's tool ids (0.4 and 0.5) and PhotoCraft's tool names. Its Adjustment
/// Brush has no tool here yet.
pub const JS_TOOLS: &[(&str, &str)] = &[
    ("move", "move"),
    ("marquee-rect", "rectMarquee"),
    ("marquee-ellipse", "ellipseMarquee"),
    ("marquee-row", "singleRowMarquee"),
    ("marquee-column", "singleColumnMarquee"),
    ("lasso", "lasso"),
    ("lasso-poly", "polygonLasso"),
    ("lasso-magnetic", "magneticLasso"),
    ("wand", "magicWand"),
    ("quick-select", "quickSelection"),
    ("object-select", "objectSelection"),
    ("crop", "crop"),
    ("perspective-crop", "perspectiveCrop"),
    ("eyedropper", "eyedropper"),
    ("color-sampler", "colorSampler"),
    ("ruler", "ruler"),
    ("brush", "brush"),
    ("pencil", "pencil"),
    ("color-replace", "colorReplacement"),
    ("eraser", "eraser"),
    ("eraser-bg", "backgroundEraser"),
    ("eraser-magic", "magicEraser"),
    ("gradient", "gradient"),
    ("bucket", "paintBucket"),
    ("type", "type"),
    ("type-horizontal", "type"),
    ("type-vertical", "verticalType"),
    ("type-mask", "horizontalTypeMask"),
    ("type-mask-horizontal", "horizontalTypeMask"),
    ("type-mask-vertical", "verticalTypeMask"),
    ("spot-heal", "spotHealing"),
    ("heal", "healing"),
    ("patch", "patch"),
    ("red-eye", "redEye"),
    ("clone", "cloneStamp"),
    ("pattern-stamp", "patternStamp"),
    ("history-brush", "historyBrush"),
    ("blur", "blur"),
    ("sharpen", "sharpen"),
    ("smudge", "smudge"),
    ("dodge", "dodge"),
    ("burn", "burn"),
    ("sponge", "sponge"),
    ("pen-tool", "pen"),
    ("pen-free", "freeformPen"),
    ("pen-add", "addAnchorPoint"),
    ("pen-delete", "deleteAnchorPoint"),
    ("pen-convert", "convertPoint"),
    ("path-selection", "pathSelection"),
    ("direct-selection", "directSelection"),
    ("shape-rect", "rectangle"),
    ("shape-rrect", "rectangle"),
    ("shape-ellipse", "ellipseShape"),
    ("shape-triangle", "triangle"),
    ("shape-polygon", "polygon"),
    ("shape-line", "line"),
    ("shape-custom", "customShape"),
    ("hand", "hand"),
    ("rotate-view", "rotateView"),
    ("zoom", "zoom"),
];

/// The tools whose opacity, flow and mode are brush settings (the engine's painting tools).
const PAINTING: &[&str] = &[
    "brush",
    "pencil",
    "eraser",
    "cloneStamp",
    "patternStamp",
    "healing",
    "spotHealing",
    "historyBrush",
    "artHistoryBrush",
    "blur",
    "sharpen",
    "smudge",
    "dodge",
    "burn",
    "sponge",
    "mixerBrush",
    "colorReplacement",
    "backgroundEraser",
];

/// Brush settings a preset never sets: the colours are the foreground's and background's.
const BRUSH_KEYS_LEFT_OUT: &[&str] = &["color", "colorCmyk", "background", "seed"];

/// A tool preset read from a file.
#[derive(Clone, Debug, PartialEq)]
pub struct TplPreset {
    pub name: String,
    /// PhotoCraft's tool name (`"brush"`, `"spotHealing"`…).
    pub tool: String,
    /// Photoshop's tool class the file named (empty for a preset read from `pigmentData` alone).
    pub class: String,
    /// The engine's tool preset options: `brush`, `toolOptions`, `foreground`.
    pub options: Value,
}

/// The presets of one file and what could not be mapped.
#[derive(Clone, Debug, Default)]
pub struct TplImport {
    pub presets: Vec<TplPreset>,
    pub warnings: Vec<String>,
}

/// A tool preset to write.
#[derive(Clone, Copy, Debug)]
pub struct TplEntry<'a> {
    pub name: &'a str,
    pub tool: &'a str,
    /// The engine's options; sampled tips must be loaded (`sampled`, not `stored`).
    pub options: &'a Value,
}

fn norm(t: &str) -> String {
    t.to_ascii_lowercase().replace([' ', '_', '-'], "").trim_end_matches("tool").to_string()
}

/// PhotoCraft's name for a tool `name` spells in any case (`"Clone Stamp"`, `"clonestamp"`).
fn canonical_tool(name: &str) -> Option<&'static str> {
    let n = norm(name);
    TOOL_CLASSES.iter().map(|(t, _)| *t).find(|t| norm(t) == n)
}

/// The PhotoCraft tool of Photoshop's tool class `class`.
pub fn tool_for_class(class: &str) -> Option<&'static str> {
    TOOL_CLASSES.iter().find(|(_, c)| *c == class).map(|(t, _)| *t).or_else(|| CLASS_ALIASES.iter().find(|(c, _)| *c == class).map(|(_, t)| *t))
}

/// Photoshop's tool class of a PhotoCraft tool (any spelling), or `None` for a tool Photoshop
/// has no class for.
pub fn class_for_tool(tool: &str) -> Option<&'static str> {
    let t = canonical_tool(tool)?;
    TOOL_CLASSES.iter().find(|(n, _)| *n == t).map(|(_, c)| *c)
}

/// The PhotoCraft tool of a JavaScript Pigment tool id.
pub fn tool_for_js(id: &str) -> Option<&'static str> {
    JS_TOOLS.iter().find(|(j, _)| *j == id).map(|(_, t)| *t)
}

fn is_painting(tool: &str) -> bool {
    PAINTING.contains(&tool)
}

// ------------------------------------------------------------------ descriptor helpers

fn num(v: Option<&DValue>) -> Option<f64> {
    v?.as_number().filter(|n| n.is_finite())
}
fn text(d: &Descriptor, k: &str) -> Option<String> {
    match d.get(k)? {
        DValue::Text(t) => Some(t.to_string_lossy()),
        _ => None,
    }
}
fn obj<'a>(d: &'a Descriptor, k: &str) -> Option<&'a Descriptor> {
    match d.get(k)? {
        DValue::Descriptor(o) | DValue::GlobalObject(o) => Some(o),
        _ => None,
    }
}
fn enum_value(d: &Descriptor, k: &str) -> Option<Vec<u8>> {
    match d.get(k)? {
        DValue::Enumerated { value, .. } => Some(value.as_bytes().to_vec()),
        _ => None,
    }
}
fn id_string(id: &Id) -> String {
    String::from_utf8_lossy(id.as_bytes()).to_string()
}
fn unit(code: &[u8; 4], value: f64) -> DValue {
    DValue::UnitFloat { unit: *code, value }
}
fn text_value(s: &str) -> DValue {
    DValue::Text(UnicodeString::new_nul(s))
}

/// A name without Photoshop's localisation prefix (`$$$/Presets/…=Name`) and trailing NULs.
fn strip_localized(s: &str) -> String {
    let s = s.trim_end_matches('\0');
    let s = if s.starts_with("$$$/") { s.split_once('=').map_or(s, |(_, n)| n) } else { s };
    s.trim().to_string()
}

// ------------------------------------------------------------------ reading

struct Sections<'a> {
    samp: Option<&'a [u8]>,
    patt: Option<&'a [u8]>,
    desc: Vec<&'a [u8]>,
    found: bool,
}

/// The `8BIM` sections after the header, tolerant of writers that do not pad to 4 bytes.
fn sections<'a>(b: &'a [u8], warnings: &mut Vec<String>) -> Sections<'a> {
    let mut out = Sections { samp: None, patt: None, desc: Vec::new(), found: false };
    let mut p = 8usize;
    while b.len().saturating_sub(p) >= 12 && &b[p..p + 4] == b"8BIM" {
        out.found = true;
        let key = [b[p + 4], b[p + 5], b[p + 6], b[p + 7]];
        let len = u32::from_be_bytes([b[p + 8], b[p + 9], b[p + 10], b[p + 11]]) as usize;
        let start = p + 12;
        let end = start.saturating_add(len).min(b.len());
        if start.saturating_add(len) > b.len() {
            warnings.push(format!("the {} section is truncated", String::from_utf8_lossy(&key)));
        }
        let data = &b[start..end];
        match &key {
            b"samp" if out.samp.is_none() => out.samp = Some(data),
            b"patt" if out.patt.is_none() => out.patt = Some(data),
            b"desc" => out.desc.push(data),
            _ => {}
        }
        let padded = start.saturating_add(len.saturating_add(3) & !3);
        p = if b.get(end..end + 4) == Some(b"8BIM") { end } else { padded };
    }
    out
}

/// Every version-16 descriptor of a file without sections (a lenient scan; at most 64).
fn scan_descriptors(b: &[u8]) -> Vec<Descriptor> {
    let mut found = Vec::new();
    let (mut o, mut tries) = (8usize, 0usize);
    while o + 16 < b.len() && found.len() < 64 && tries < 4096 {
        if b[o..o + 4] == [0, 0, 0, 16] {
            tries += 1;
            if let Ok((vd, used)) = VersionedDescriptor::parse_prefix(&b[o..]) {
                found.push(vd.descriptor);
                o += used.max(1);
                continue;
            }
        }
        o += 1;
    }
    found
}

/// The sampled tips of `samp`, read by craft-psd's `.abr` reader (the layout is .abr 6's).
fn read_samples(data: &[u8], minor: u16, warnings: &mut Vec<String>) -> Vec<AbrSample> {
    let mut abr_bytes = Vec::with_capacity(data.len() + 16);
    abr_bytes.extend_from_slice(&6u16.to_be_bytes());
    abr_bytes.extend_from_slice(&(if minor == 1 { 1u16 } else { 2u16 }).to_be_bytes());
    abr_bytes.extend_from_slice(b"8BIMsamp");
    abr_bytes.extend_from_slice(&(data.len() as u32).to_be_bytes());
    abr_bytes.extend_from_slice(data);
    match abr::parse(&abr_bytes) {
        Ok(f) => {
            warnings.extend(f.warnings.into_iter().filter(|w| !w.contains("(desc)")));
            f.samples
        }
        Err(e) => {
            warnings.push(format!("the brush tips could not be read ({e})"));
            Vec::new()
        }
    }
}

/// The preset objects of a descriptor: its `Prst` list, else the first list of named objects,
/// else the descriptor itself when it is one preset.
fn preset_list(d: &Descriptor) -> Vec<&Descriptor> {
    fn objects(items: &[DValue]) -> Vec<&Descriptor> {
        items
            .iter()
            .filter_map(|v| match v {
                DValue::Descriptor(o) => Some(o),
                _ => None,
            })
            .collect()
    }
    let named = |v: &DValue| matches!(v, DValue::Descriptor(o) if o.get("Nm  ").is_some());
    if let Some(DValue::List(items)) = d.get("Prst") {
        return objects(items);
    }
    for (_, v) in &d.items {
        if let DValue::List(items) = v
            && items.iter().any(named)
        {
            return objects(items);
        }
    }
    if d.get("Nm  ").is_some() && (d.get("Tool").is_some() || d.get("Brsh").is_some()) { vec![d] } else { Vec::new() }
}

/// Options before they are placed: the keys every format shares.
#[derive(Default)]
struct Common {
    size: Option<f64>,
    hardness: Option<f64>,
    /// 0..1.
    opacity: Option<f64>,
    /// 0..1.
    flow: Option<f64>,
    mode: Option<BlendMode>,
    behind: bool,
    airbrush: Option<bool>,
    smoothing: Option<f64>,
    pressure_size: Option<bool>,
    pressure_opacity: Option<bool>,
    /// The shell's tool options (`toolOptions`).
    shell: Map<String, Value>,
    /// Options read that have no equivalent.
    skipped: usize,
}

fn fraction(v: f64) -> f64 {
    v.clamp(0.0, 1.0)
}

/// Photoshop's tool object: `Opct`, `flow`, `Md  `, `Rpt `, the type tools' `TxtS`.
fn common_from_tool(tool: &str, t: &Descriptor) -> Common {
    let mut c = Common { opacity: num(t.get("Opct")).map(|v| fraction(v / 100.0)), flow: num(t.get("flow")).map(|v| fraction(v / 100.0)), ..Common::default() };
    if let Some(m) = enum_value(t, "Md  ") {
        match crate::effects_map::blend_from_id(&m) {
            Some(b) => c.mode = Some(b),
            None if m == b"Bhnd" => c.behind = true,
            None => c.skipped += 1,
        }
    }
    if let Some(DValue::Boolean(b)) = t.get("Rpt ") {
        c.airbrush = Some(*b);
    }
    if let Some(s) = obj(t, "TxtS") {
        let font = text(s, "FntN").filter(|f| !f.trim().is_empty());
        type_options(tool, font, num(s.get("Sz  ")), &mut c);
    }
    c
}

fn type_options(tool: &str, font: Option<String>, size: Option<f64>, c: &mut Common) {
    let is_type = matches!(tool, "type" | "verticalType" | "horizontalTypeMask" | "verticalTypeMask");
    if let Some(f) = font {
        if is_type {
            c.shell.insert("type_font".into(), json!(f));
        } else {
            c.skipped += 1;
        }
    }
    if let Some(s) = size.filter(|s| *s > 0.0) {
        if is_type {
            c.shell.insert("type_size".into(), json!(s.min(10_000.0)));
        } else {
            c.skipped += 1;
        }
    }
}

/// The JavaScript Pigment's options (`pigmentData.options` of its files) and its `type`.
fn common_from_js(tool: &str, o: &Map<String, Value>, js_type: Option<&Value>) -> Common {
    let mut c = Common::default();
    let f = |k: &str| o.get(k).and_then(Value::as_f64).filter(|v| v.is_finite());
    let b = |k: &str| o.get(k).and_then(Value::as_bool);
    let s = |k: &str| o.get(k).and_then(Value::as_str);
    let mut used = 0usize;
    let mut take = |cond: bool| used += usize::from(cond);
    c.size = f("size").filter(|v| *v > 0.0);
    take(c.size.is_some());
    c.hardness = f("hardness").map(fraction);
    take(c.hardness.is_some());
    c.opacity = f("opacity").map(fraction);
    take(c.opacity.is_some());
    c.flow = f("flow").map(fraction);
    take(c.flow.is_some());
    c.smoothing = f("smoothing").map(fraction);
    take(c.smoothing.is_some());
    c.pressure_size = b("pressureSize");
    take(c.pressure_size.is_some());
    c.pressure_opacity = b("pressureOpacity");
    take(c.pressure_opacity.is_some());
    c.airbrush = b("airbrush");
    take(c.airbrush.is_some());
    if let Some(m) = s("blend") {
        match crate::legacy_pigment::blend::blend_mode(m) {
            Some(b) => {
                c.mode = Some(b);
                take(true);
            }
            None if m == "behind" => {
                c.behind = true;
                take(true);
            }
            None => {}
        }
    }
    // Each tool's own options, under the shell's keys.
    let mut shell = |key: &str, v: Option<Value>| {
        if let Some(v) = v {
            c.shell.insert(key.into(), v);
            used += 1;
        }
    };
    let pct = |k: &str| f(k).map(|v| json!((fraction(v) * 100.0).round()));
    match tool {
        "eraser" => {
            shell("eraser_mode", s("mode").filter(|m| matches!(*m, "brush" | "pencil")).map(|m| json!(m)));
            shell("erase_to_history", b("eraseToHistory").map(Value::Bool));
        }
        "pencil" => shell("pencil_auto_erase", b("autoErase").map(Value::Bool)),
        "blur" | "sharpen" | "smudge" => shell("strength", pct("strength")),
        "dodge" | "burn" => {
            shell("exposure", pct("exposure"));
            shell("tone_range", s("range").filter(|r| matches!(*r, "shadows" | "midtones" | "highlights")).map(|r| json!(r)));
        }
        "sponge" => shell("sponge_mode", s("mode").filter(|m| matches!(*m, "saturate" | "desaturate")).map(|m| json!(m))),
        "gradient" => {
            shell("gradient_style", s("type").filter(|t| matches!(*t, "linear" | "radial" | "angle" | "reflected" | "diamond")).map(|t| json!(t)));
            shell("gradient_reverse", b("reverse").map(Value::Bool));
            shell("gradient_dither", b("dither").map(Value::Bool));
        }
        "paintBucket" | "magicWand" | "magicEraser" => {
            shell("tolerance", f("tolerance").filter(|t| (0.0..=255.0).contains(t)).map(|t| json!(t)));
            shell("contiguous", b("contiguous").map(Value::Bool));
            shell("anti_alias", b("antiAlias").map(Value::Bool));
        }
        _ => {}
    }
    c.skipped = o.len().saturating_sub(used);
    if let Some(ch) = js_type.and_then(|t| t.get("char")) {
        let font = ch.get("fontFamily").and_then(Value::as_str).filter(|f| !f.trim().is_empty()).map(str::to_string);
        type_options(tool, font, ch.get("size").and_then(Value::as_f64), &mut c);
    }
    c
}

/// `#rrggbb` as `[r, g, b, 1]` (the engine's `foreground`).
fn hex_color(s: &str) -> Option<Value> {
    let h = s.strip_prefix('#')?;
    if h.len() != 6 || !h.is_ascii() {
        return None;
    }
    let c = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok().map(|v| f64::from(v) / 255.0);
    Some(json!([c(0)?, c(2)?, c(4)?, 1.0]))
}

/// The options of `tool` from `c`, over `brush` (the preset's brush, if any).
fn place(tool: &str, mut c: Common, brush: Option<Value>) -> (Value, usize) {
    let mut options = Map::new();
    let mut brush = brush.and_then(|b| match b {
        Value::Object(m) => Some(m),
        _ => None,
    });
    let painting = is_painting(tool);
    let mut set_brush = |k: &str, v: Value| {
        brush.get_or_insert_with(Map::new).insert(k.into(), v);
    };
    // The tip's size and hardness are the brush's whatever the tool.
    if let Some(v) = c.size {
        set_brush("size", json!(v.clamp(1.0, 5000.0)));
    }
    if let Some(v) = c.hardness {
        set_brush("hardness", json!(v));
    }
    if painting {
        if let Some(v) = c.opacity {
            set_brush("opacity", json!(v.max(0.01)));
        }
        if let Some(v) = c.flow {
            set_brush("flow", json!(v.max(0.01)));
        }
        if let Some(m) = c.mode {
            set_brush("mode", serde_json::to_value(m).unwrap_or(Value::Null));
        }
        if c.behind {
            set_brush("behind", Value::Bool(true));
        }
        if let Some(v) = c.airbrush {
            set_brush("buildUp", Value::Bool(v));
        }
        if let Some(v) = c.smoothing {
            set_brush("smoothing", json!({"enabled": v > 0.0, "amount": v}));
        }
        if let Some(v) = c.pressure_size {
            set_brush("pressureSize", Value::Bool(v));
        }
        if let Some(v) = c.pressure_opacity {
            set_brush("pressureOpacity", Value::Bool(v));
        }
    } else {
        let fill_mode = match tool {
            "gradient" => Some("gradient_blend_mode"),
            "paintBucket" => Some("bucket_blend_mode"),
            _ => None,
        };
        match (fill_mode, c.opacity) {
            (Some(_), Some(v)) => {
                c.shell.insert("fill_opacity".into(), json!((v * 100.0).round().max(1.0)));
            }
            (None, Some(_)) => c.skipped += 1,
            _ => {}
        }
        match (fill_mode, c.mode) {
            (Some(k), Some(m)) => {
                c.shell.insert(k.into(), serde_json::to_value(m).unwrap_or(Value::Null));
            }
            (None, Some(_)) => c.skipped += 1,
            _ => {}
        }
        c.skipped += usize::from(c.flow.is_some()) + usize::from(c.behind) + usize::from(c.airbrush.is_some());
        c.skipped += usize::from(c.smoothing.is_some()) + usize::from(c.pressure_size.is_some()) + usize::from(c.pressure_opacity.is_some());
    }
    if let Some(mut b) = brush {
        for k in BRUSH_KEYS_LEFT_OUT {
            b.remove(*k);
        }
        options.insert("brush".into(), Value::Object(b));
    }
    if !c.shell.is_empty() {
        options.insert("toolOptions".into(), Value::Object(c.shell));
    }
    (Value::Object(options), c.skipped)
}

/// A brush descriptor mapped as an `.abr` preset is (craft-psd tips and patterns of the file).
fn brush_json(d: &Descriptor, file: &AbrFile, label: &str, warnings: &mut Vec<String>) -> Option<Value> {
    let (brush, lines) = crate::abr_map::brush_from_descriptor(d, file);
    warnings.extend(lines.into_iter().map(|l| format!("\"{label}\": {l}")));
    match brush {
        Some(b) => serde_json::to_value(&b).ok(),
        None => {
            warnings.push(format!("\"{label}\": its sampled tip is missing from the file; the preset keeps the current brush"));
            None
        }
    }
}

/// A sample as a tile (16-bit samples exactly, 8-bit ones scaled).
fn sample_tile(s: &AbrSample) -> GrayTile {
    let data: Vec<u16> = if s.depth == 16 {
        s.data.as_chunks::<2>().0.iter().map(|c| u16::from_be_bytes(*c)).collect()
    } else {
        s.data.iter().map(|&v| u16::from(v) * 257).collect()
    };
    GrayTile { width: s.width, height: s.height, data: data.into() }
}

/// Puts the tips Pigment's own `pigmentData` names (`{"tplSample": id}`) back from `samp`.
fn restore_tips(options: &mut Value, samples: &[AbrSample], label: &str, warnings: &mut Vec<String>) {
    let Some(brush) = options.get_mut("brush") else { return };
    for path in [&["tip"][..], &["dualBrush", "tip"][..]] {
        let Some(slot) = path.iter().try_fold(&mut *brush, |v, k| v.get_mut(*k)) else { continue };
        let Some(id) = slot.get("tplSample").and_then(Value::as_str).map(str::to_string) else { continue };
        *slot = match samples.iter().find(|s| s.id == id) {
            Some(s) => json!({"sampled": sample_tile(s)}),
            None => {
                warnings.push(format!("\"{label}\": a brush tip is missing from the file; a round tip stands in"));
                json!("round")
            }
        };
    }
}

/// Reads a `.tpl` file. Errors only when it is not one; damaged parts become warnings.
pub fn read_tpl(bytes: &[u8]) -> Result<TplImport, String> {
    if bytes.len() < 8 || &bytes[..4] != b"8BTP" {
        return Err("not a Photoshop tool presets file (.tpl)".into());
    }
    let minor = u16::from_be_bytes([bytes[6], bytes[7]]);
    let mut out = TplImport::default();
    let secs = sections(bytes, &mut out.warnings);
    let mut file = AbrFile::default();
    let mut descs: Vec<Descriptor> = Vec::new();
    if secs.found {
        if let Some(s) = secs.samp {
            file.samples = read_samples(s, minor, &mut out.warnings);
        }
        if let Some(p) = secs.patt {
            match craft_psd::patterns::parse_pattern_block(p) {
                Ok(p) => file.patterns = p,
                Err(e) => out.warnings.push(format!("the brushes' patterns could not be read ({e})")),
            }
        }
        for d in secs.desc {
            match VersionedDescriptor::parse_prefix(d) {
                Ok((vd, _)) => descs.push(vd.descriptor),
                Err(e) => out.warnings.push(format!("the presets could not be read ({e})")),
            }
        }
    } else {
        descs = scan_descriptors(bytes);
    }
    let mut count = 0usize;
    'files: for d in &descs {
        for entry in preset_list(d) {
            if out.presets.len() >= MAX_PRESETS {
                out.warnings.push(format!("the file holds more than {MAX_PRESETS} presets; the rest were left out"));
                break 'files;
            }
            count += 1;
            if let Some(p) = read_preset(entry, &file, count, &mut out.warnings) {
                out.presets.push(p);
            }
        }
    }
    if out.presets.is_empty() && out.warnings.is_empty() {
        out.warnings.push("the file holds no tool presets".into());
    }
    Ok(out)
}

fn read_preset(entry: &Descriptor, file: &AbrFile, n: usize, warnings: &mut Vec<String>) -> Option<TplPreset> {
    let name = text(entry, "Nm  ").map(|s| strip_localized(&s)).filter(|s| !s.is_empty()).unwrap_or_else(|| format!("Tool Preset {n}"));
    let name: String = name.chars().take(255).collect();
    let pigment: Option<Value> = text(entry, "pigmentData").filter(|s| s.len() <= MAX_PIGMENT_DATA).and_then(|s| serde_json::from_str(&s).ok()).filter(Value::is_object);
    let tool_obj = obj(entry, "Tool");
    let class = match entry.get("Tool") {
        Some(DValue::Descriptor(t) | DValue::GlobalObject(t)) => id_string(&t.class_id),
        Some(DValue::Enumerated { value, .. }) => id_string(value),
        Some(DValue::Class(c) | DValue::GlobalClass(c)) => id_string(&c.class_id),
        _ => String::new(),
    };
    // Pigment's own file: the preset as the engine keeps it.
    if let Some(p) = pigment.as_ref().filter(|p| p.get("format").and_then(Value::as_str) == Some(PIGMENT_FORMAT)) {
        let tool = p.get("tool").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty());
        let Some(tool) = tool else {
            warnings.push(format!("\"{name}\" names no tool and was left out"));
            return None;
        };
        let tool = canonical_tool(tool).map_or_else(|| tool.to_string(), str::to_string);
        let mut options = p.get("options").cloned().filter(Value::is_object).unwrap_or_else(|| json!({}));
        restore_tips(&mut options, &file.samples, &name, warnings);
        return Some(TplPreset { name, tool, class, options });
    }
    let js_tool = pigment.as_ref().and_then(|p| p.get("tool")).and_then(Value::as_str);
    let tool = match js_tool {
        Some(j) => tool_for_js(j).or_else(|| canonical_tool(j)),
        None => tool_for_class(&class),
    };
    let Some(tool) = tool else {
        let what = js_tool.map_or_else(|| if class.is_empty() { "unknown".to_string() } else { class.clone() }, str::to_string);
        warnings.push(format!("\"{name}\" is a preset of a tool Pigment does not have ({what}); left out"));
        return None;
    };
    let common = match pigment.as_ref().and_then(|p| p.get("options")).and_then(Value::as_object) {
        Some(o) => common_from_js(tool, o, pigment.as_ref().and_then(|p| p.get("type"))),
        None => tool_obj.map(|t| common_from_tool(tool, t)).unwrap_or_default(),
    };
    let brush = obj(entry, "Brsh").and_then(|b| brush_json(b, file, &name, warnings));
    let (mut options, skipped) = place(tool, common, brush);
    if let Some(c) = pigment.as_ref().and_then(|p| p.get("color")).and_then(Value::as_str).and_then(hex_color) {
        options["foreground"] = c;
    }
    if skipped > 0 {
        warnings.push(format!("\"{name}\": {skipped} options of {tool} have no equivalent and were skipped"));
    }
    Some(TplPreset { name, tool: tool.to_string(), class, options })
}

// ------------------------------------------------------------------ writing

/// A stable uuid-shaped id of a tip's samples (FNV-1a over them, two seeds), with the `$` the
/// JavaScript writer put first.
fn tip_id(t: &GrayTile) -> String {
    let hash = |seed: u64| {
        let mut h = 0xcbf2_9ce4_8422_2325u64 ^ seed;
        for b in t.width.to_le_bytes().into_iter().chain(t.height.to_le_bytes()).chain(t.data.iter().flat_map(|v| v.to_le_bytes())) {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
        h
    };
    let h = format!("{:016x}{:016x}", hash(0), hash(0x9e37_79b9_7f4a_7c15));
    format!("${}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// The tip of `t` in `samples` (added once), or `None` for a computed tip.
fn sample_for(t: &TipShape, samples: &mut Vec<AbrSample>) -> Option<String> {
    let tile = match t {
        TipShape::Sampled(g) => g,
        TipShape::Stored(r) => r.full.as_deref()?,
        TipShape::Round => return None,
    };
    if !tile.is_valid() || tile.width > abr::MAX_EDGE || tile.height > abr::MAX_EDGE {
        return None;
    }
    let id = tip_id(tile);
    if !samples.iter().any(|s| s.id == id) {
        let data = tile.data.iter().flat_map(|v| v.to_be_bytes()).collect();
        samples.push(AbrSample { id: id.clone(), width: tile.width, height: tile.height, depth: 16, data });
    }
    Some(id)
}

/// Photoshop's `brushPreset` for a brush: the tip (`computedBrush` or `sampledBrush`), so
/// Photoshop gets a brush of the right size and shape; the rest is in `pigmentData`.
fn brush_descriptor(name: &str, b: &BrushSettings, sample: Option<&str>) -> Descriptor {
    let mut tip = Descriptor::new(if sample.is_some() { "sampledBrush" } else { "computedBrush" })
        .with("Dmtr", unit(b"#Pxl", f64::from(b.size)))
        .with("Angl", unit(b"#Ang", f64::from(b.angle)))
        .with("Rndn", unit(b"#Prc", f64::from(b.roundness) * 100.0))
        .with("Spcn", unit(b"#Prc", f64::from(b.spacing) * 100.0))
        .with("Intr", DValue::Boolean(b.spacing_enabled))
        .with("flipX", DValue::Boolean(b.flip_x))
        .with("flipY", DValue::Boolean(b.flip_y));
    match sample {
        Some(id) => tip = tip.with("sampledData", text_value(id)),
        None => tip = tip.with("Hrdn", unit(b"#Prc", f64::from(b.hardness) * 100.0)),
    }
    Descriptor::new("brushPreset")
        .with("Nm  ", text_value(name))
        .with("Brsh", DValue::Descriptor(tip))
        .with("Spcn", unit(b"#Prc", f64::from(b.spacing) * 100.0))
        .with("Wtdg", DValue::Boolean(b.wet_edges))
        .with("Nose", DValue::Boolean(b.noise))
        .with("Rpt ", DValue::Boolean(b.build_up))
        .with("useBrushSize", DValue::Boolean(true))
}

/// The tip slot of `options.brush` at `path` replaced by `{"tplSample": id}`.
fn mark_tip(options: &mut Value, path: &[&str], id: &str) {
    if let Some(v) = path.iter().try_fold(options, |v, k| v.get_mut(*k)) {
        *v = json!({ "tplSample": id });
    }
}

/// Writes a `.tpl` file of `presets`, and lines about what Photoshop's part of the file leaves
/// out (Pigment reads everything back from `pigmentData`).
pub fn write_tpl(presets: &[TplEntry<'_>]) -> Result<(Vec<u8>, Vec<String>), String> {
    let mut samples: Vec<AbrSample> = Vec::new();
    let mut entries = Vec::with_capacity(presets.len());
    let mut report = Vec::new();
    for p in presets {
        let tool = canonical_tool(p.tool).map_or_else(|| p.tool.to_string(), str::to_string);
        let class = class_for_tool(&tool).map_or_else(|| tool.clone(), str::to_string);
        let mut own = if p.options.is_object() { p.options.clone() } else { json!({}) };
        let brush: Option<BrushSettings> = match own.get("brush").filter(|b| b.is_object()) {
            Some(b) => match serde_json::from_value(b.clone()) {
                Ok(b) => Some(b),
                Err(e) => {
                    report.push(format!("\"{}\": its brush could not be read ({e}); written without one", p.name));
                    None
                }
            },
            None => None,
        };
        let mut tool_obj = Descriptor::new(&class);
        let shell = own.get("toolOptions").and_then(Value::as_object).cloned().unwrap_or_default();
        let (opacity, flow, mode) = match (&brush, tool.as_str()) {
            (Some(b), t) if is_painting(t) => (Some(f64::from(b.opacity)), Some(f64::from(b.flow)), Some(b.mode)),
            (_, "gradient" | "paintBucket") => {
                let key = if tool == "gradient" { "gradient_blend_mode" } else { "bucket_blend_mode" };
                (
                    shell.get("fill_opacity").and_then(Value::as_f64).map(|v| v / 100.0),
                    None,
                    shell.get(key).and_then(|m| serde_json::from_value::<BlendMode>(m.clone()).ok()),
                )
            }
            _ => (None, None, None),
        };
        if let Some(v) = opacity {
            tool_obj = tool_obj.with("Opct", unit(b"#Prc", (v * 100.0).clamp(0.0, 100.0)));
        }
        if let Some(v) = flow {
            tool_obj = tool_obj.with("flow", unit(b"#Prc", (v * 100.0).clamp(0.0, 100.0)));
        }
        if let Some(m) = mode {
            tool_obj = tool_obj.with("Md  ", crate::effects_map::blend_value(m));
        }
        if brush.as_ref().is_some_and(|b| b.build_up) {
            tool_obj = tool_obj.with("Rpt ", DValue::Boolean(true));
        }
        let font = shell.get("type_font").and_then(Value::as_str);
        let size = shell.get("type_size").and_then(Value::as_f64);
        if font.is_some() || size.is_some() {
            let mut s = Descriptor::new("TxtS");
            if let Some(f) = font {
                s = s.with("FntN", text_value(f));
            }
            if let Some(z) = size {
                s = s.with("Sz  ", unit(b"#Pnt", z));
            }
            tool_obj = tool_obj.with("TxtS", DValue::Descriptor(s));
        }
        let mut items = Descriptor::new("toolPreset").with("Nm  ", text_value(p.name)).with("Tool", DValue::Descriptor(tool_obj));
        if let Some(b) = &brush {
            let tip = sample_for(&b.tip, &mut samples);
            if matches!(b.tip, TipShape::Stored(ref r) if r.full.is_none()) {
                report.push(format!("\"{}\": its tip image is not loaded; written as a round tip", p.name));
            }
            if let Some(id) = &tip {
                mark_tip(&mut own, &["brush", "tip"], id);
            }
            if b.dual_brush.enabled
                && let Some(id) = sample_for(&b.dual_brush.tip, &mut samples)
            {
                mark_tip(&mut own, &["brush", "dualBrush", "tip"], &id);
            }
            items = items.with("Brsh", DValue::Descriptor(brush_descriptor(p.name, b, tip.as_deref())));
        }
        let data = json!({"format": PIGMENT_FORMAT, "version": 1, "tool": tool, "options": own});
        items = items.with("pigmentData", text_value(&data.to_string()));
        entries.push(DValue::Descriptor(items));
    }
    let mut o = Vec::new();
    o.extend_from_slice(b"8BTP");
    o.extend_from_slice(&1u16.to_be_bytes());
    o.extend_from_slice(&2u16.to_be_bytes());
    if !samples.is_empty() {
        // craft-psd writes the tips as an .abr 6.2 file does; its `samp` section is ours.
        let abr_bytes = abr::write_v6(2, &samples, &[], &[], false).map_err(|e| format!("the brush tips could not be written ({e})"))?;
        let samp = section_of(&abr_bytes[4..], b"samp").ok_or("the brush tips could not be written")?;
        o.extend_from_slice(samp);
    }
    let desc = VersionedDescriptor::new(Descriptor::new("null").with("Prst", DValue::List(entries))).to_bytes();
    put_section(&mut o, b"desc", &desc);
    Ok((o, report))
}

/// The whole `8BIM` section `key` (header included) of a run of sections.
fn section_of<'a>(b: &'a [u8], key: &[u8; 4]) -> Option<&'a [u8]> {
    let mut p = 0usize;
    while b.len().saturating_sub(p) >= 12 && &b[p..p + 4] == b"8BIM" {
        let len = u32::from_be_bytes([b[p + 8], b[p + 9], b[p + 10], b[p + 11]]) as usize;
        let end = p.checked_add(12)?.checked_add(len)?;
        if &b[p + 4..p + 8] == key {
            return b.get(p..end);
        }
        p = end;
    }
    None
}

fn put_section(o: &mut Vec<u8>, key: &[u8; 4], data: &[u8]) {
    o.extend_from_slice(b"8BIM");
    o.extend_from_slice(key);
    let pad = (4 - data.len() % 4) % 4;
    o.extend_from_slice(&((data.len() + pad) as u32).to_be_bytes());
    o.extend_from_slice(data);
    o.extend(std::iter::repeat_n(0u8, pad));
}

#[cfg(test)]
mod tests;
