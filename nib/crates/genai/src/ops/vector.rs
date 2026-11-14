//! Vector art from a prompt: Text to Vector Graphic, Generative Shape Fill and Generative Pattern.
//!
//! Two methods: **Vector (SVG)** asks the text model for one standalone SVG, which is sanitized
//! ([`crate::sanitize`]) and imported through Nib's SVG importer; **Image + Trace** asks the image
//! model for a PNG, which Image Trace turns into paths with a preset chosen by type and detail.

use serde::{Deserialize, Serialize};
use serde_json::json;
use vectorcraft_doc::{NodeId, NodeKind};
use vectorcraft_engine::Session;
use vectorcraft_geom::Rect;

use super::{Applied, Feature, Inputs, Prepared, exec, fit_into, id_of, move_below, node_bounds, paste_import};
use crate::fit::{FitMode, aspect_words, inset, pixel_size, usable};
use crate::prompts::{self, ArtBrief, Detail, VectorKind};
use crate::provider::{ImageRequest, InputImage, TextRequest};
use crate::{AiError, CancelToken, Provider, Result};

/// How the art is made.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VectorMethod {
    /// The text model writes SVG.
    #[default]
    Svg,
    /// The image model paints a PNG; Image Trace makes paths of it.
    ImageTrace,
}

/// Text to Vector Graphic.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TextToVectorSpec {
    pub prompt: String,
    pub kind: VectorKind,
    pub detail: Detail,
    pub method: VectorMethod,
    /// 1–4.
    pub variations: u8,
    /// `#rrggbb` colours to use.
    pub palette: Vec<String>,
    /// Send the selected artwork, rendered, as a style reference.
    pub style_reference: bool,
}

/// Generative Shape Fill: the selected closed path filled with art clipped to it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ShapeFillSpec {
    pub prompt: String,
    pub detail: Detail,
    pub method: VectorMethod,
    pub variations: u8,
    /// Ask for art in the shape's own colours.
    pub use_shape_colors: bool,
    pub palette: Vec<String>,
}

/// Generative Pattern: a seamless tile made a pattern swatch.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PatternSpec {
    pub prompt: String,
    pub detail: Detail,
    pub method: VectorMethod,
    pub variations: u8,
    pub palette: Vec<String>,
    /// The tile's side in points (default 100).
    pub tile_size: Option<f64>,
    /// Also fill the selected objects with the new pattern.
    pub apply_to_selection: bool,
}

/// What the worker asks for.
#[derive(Clone, Debug)]
pub(crate) struct VectorJob {
    method: VectorMethod,
    variations: usize,
    text: TextRequest,
    image: ImageRequest,
    place: Placement,
}

/// Where the art goes.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Placement {
    /// Fitted into an area (the selection's bounds or the artboard).
    Area { target: Rect, kind: VectorKind, detail: Detail },
    /// Covering a closed path and clipped to it.
    Shape { shape: NodeId, target: Rect, detail: Detail },
    /// Made a pattern swatch of `tile` points.
    Pattern { tile: f64, name: String, fill: Vec<u64>, detail: Detail },
}

/// A generated variation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VectorArt {
    /// Sanitized SVG.
    Svg(String),
    /// A PNG to trace.
    Image(Vec<u8>),
}

#[derive(Clone, Debug, PartialEq)]
pub struct VectorResult {
    pub feature: Feature,
    pub doc_uid: u64,
    pub art: Vec<VectorArt>,
    pub(crate) place: Placement,
}

fn need_prompt(p: &str) -> Result<()> {
    if p.trim().is_empty() {
        return Err(AiError::bad_request("Describe what to make."));
    }
    if p.chars().count() > 4000 {
        return Err(AiError::bad_request("The prompt is too long (at most 4000 characters)."));
    }
    Ok(())
}

fn clean_palette(p: &[String]) -> Vec<String> {
    let mut out: Vec<String> = p.iter().filter_map(|c| crate::palette::parse_hex(c)).map(crate::palette::to_hex).collect();
    out.dedup();
    out.truncate(crate::palette::MAX_COLORS);
    out
}

/// The SVG view size and pixel size for an area.
fn view_of(target: Rect) -> (u32, u32) {
    pixel_size(target, 512)
}

struct JobArgs<'a> {
    prompt: &'a str,
    kind: VectorKind,
    detail: Detail,
    method: VectorMethod,
    variations: u8,
    palette: Vec<String>,
    reference: Option<Vec<u8>>,
    full_bleed: bool,
    target: Rect,
}

fn job(a: JobArgs, place: Placement) -> VectorJob {
    let aspect = aspect_words(a.target);
    let brief = ArtBrief {
        prompt: a.prompt,
        kind: a.kind,
        detail: a.detail,
        palette: &a.palette,
        aspect: &aspect,
        view: view_of(a.target),
        style_reference: a.reference.is_some(),
        full_bleed: a.full_bleed,
    };
    let refs: Vec<InputImage> = a.reference.into_iter().map(InputImage::png).collect();
    let (w, h) = pixel_size(a.target, 1024);
    VectorJob {
        method: a.method,
        variations: super::clamp_variations(a.variations),
        text: TextRequest {
            instructions: prompts::SVG_INSTRUCTIONS.into(),
            prompt: prompts::svg_prompt(&brief),
            images: refs.clone(),
            json: false,
            max_output_tokens: Some(32_000),
        },
        image: ImageRequest {
            prompt: prompts::trace_prompt(&brief),
            width: w,
            height: h,
            transparent: matches!(a.kind, VectorKind::Subject | VectorKind::Icon) && !a.full_bleed,
            references: refs,
        },
        place,
    }
}

fn prepared(s: &Session, feature: Feature, job: VectorJob) -> Result<Prepared> {
    Ok(Prepared { feature, doc_uid: super::active_uid(s)?, inputs: Inputs::Vector(job) })
}

pub(crate) fn prepare_text_to_vector(s: &mut Session, spec: &TextToVectorSpec) -> Result<Prepared> {
    need_prompt(&spec.prompt)?;
    super::active_uid(s)?;
    // Into the selection's area when something is selected, else the artboard with a margin.
    let target = super::selection_bounds(s).or_else(|| super::artboard_rect(s).map(|r| inset(r, 0.1))).filter(|r| usable(*r));
    let target = target.unwrap_or_else(|| Rect::new(0.0, 0.0, 300.0, 300.0));
    let reference = if spec.style_reference { super::selection_png(s, 512)? } else { None };
    if spec.style_reference && reference.is_none() {
        return Err(AiError::document("Select the artwork to use as a style reference."));
    }
    let args = JobArgs {
        prompt: &spec.prompt,
        kind: spec.kind,
        detail: spec.detail,
        method: spec.method,
        variations: spec.variations,
        palette: clean_palette(&spec.palette),
        reference,
        full_bleed: false,
        target,
    };
    let place = Placement::Area { target, kind: spec.kind, detail: spec.detail };
    prepared(s, Feature::TextToVector, job(args, place))
}

/// The one selected closed path (or compound path).
fn selected_shape(s: &Session) -> Result<NodeId> {
    let ids = super::selection(s)?;
    let [id] = ids.as_slice() else {
        return Err(AiError::document("Select one closed path to fill."));
    };
    match super::kind_of(s, *id) {
        Some(NodeKind::Path { path, .. }) if path.subpaths.iter().all(|sp| sp.closed) && !path.subpaths.is_empty() => Ok(*id),
        Some(NodeKind::Compound { .. }) => Ok(*id),
        Some(NodeKind::Path { .. }) => Err(AiError::document("The selected path is open. Close it to fill it.")),
        _ => Err(AiError::document("Select one closed path (a shape) to fill.")),
    }
}

/// The colours an object uses (`recolor.colors`), as `#rrggbb`.
pub(crate) fn colors_of(s: &mut Session, ids: Option<&[u64]>) -> Result<Vec<String>> {
    let params = match ids {
        Some(ids) => json!({ "ids": ids }),
        None => json!({}),
    };
    let v = exec(s, "recolor.colors", params)?;
    Ok(v.get("colors")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|c| c.get("hex").and_then(serde_json::Value::as_str))
        .map(str::to_string)
        .collect())
}

pub(crate) fn prepare_shape_fill(s: &mut Session, spec: &ShapeFillSpec) -> Result<Prepared> {
    need_prompt(&spec.prompt)?;
    let shape = selected_shape(s)?;
    let target = node_bounds(s, shape).ok_or_else(|| AiError::document("The selected shape has no area."))?;
    let mut palette = clean_palette(&spec.palette);
    if spec.use_shape_colors && palette.is_empty() {
        palette = clean_palette(&colors_of(s, Some(&[shape.0]))?);
        // One flat colour is a hint, not a rule: add nothing that would make the art monochrome.
        if palette.len() < 2 {
            palette.clear();
        }
    }
    let args = JobArgs {
        prompt: &spec.prompt,
        kind: VectorKind::Scene,
        detail: spec.detail,
        method: spec.method,
        variations: spec.variations,
        palette,
        reference: None,
        full_bleed: true,
        target,
    };
    let place = Placement::Shape { shape, target, detail: spec.detail };
    prepared(s, Feature::ShapeFill, job(args, place))
}

/// A swatch name from the prompt: "AI Pattern: " and its first words.
fn pattern_name(prompt: &str) -> String {
    let words: Vec<&str> = prompt.split_whitespace().take(5).collect();
    let mut name = words.join(" ");
    if name.chars().count() > 40 {
        name = name.chars().take(40).collect();
    }
    format!("AI Pattern: {name}")
}

pub(crate) fn prepare_pattern(s: &mut Session, spec: &PatternSpec) -> Result<Prepared> {
    need_prompt(&spec.prompt)?;
    super::active_uid(s)?;
    let tile = spec.tile_size.filter(|t| t.is_finite() && *t >= 4.0 && *t <= 4000.0).unwrap_or(100.0);
    let fill = if spec.apply_to_selection { super::selection(s)?.iter().map(|n| n.0).collect() } else { vec![] };
    let target = Rect::new(0.0, 0.0, tile, tile);
    let args = JobArgs {
        prompt: &spec.prompt,
        kind: VectorKind::Pattern,
        detail: spec.detail,
        method: spec.method,
        variations: spec.variations,
        palette: clean_palette(&spec.palette),
        reference: None,
        full_bleed: true,
        target,
    };
    let place = Placement::Pattern { tile, name: pattern_name(&spec.prompt), fill, detail: spec.detail };
    prepared(s, Feature::Pattern, job(args, place))
}

pub(crate) fn run(p: &Prepared, job: &VectorJob, provider: &dyn Provider, cancel: &CancelToken) -> Result<VectorResult> {
    let mut art = Vec::with_capacity(job.variations);
    let mut last_err = None;
    for _ in 0..job.variations {
        cancel.check()?;
        let one = match job.method {
            VectorMethod::Svg => provider.generate_text(&job.text, cancel).and_then(|t| crate::sanitize::sanitize_svg(&t)).map(VectorArt::Svg),
            VectorMethod::ImageTrace => provider.generate_image(&job.image, cancel).and_then(|img| trace_input(&img.bytes)).map(VectorArt::Image),
        };
        match one {
            Ok(a) => art.push(a),
            // A variation the model got wrong is skipped while others work; a key, quota or
            // network failure stops the job.
            Err(e) if e.kind == crate::ErrorKind::BadResponse => last_err = Some(e),
            Err(e) => return Err(e),
        }
    }
    if art.is_empty() {
        return Err(last_err.unwrap_or_else(|| AiError::bad_response("The model made nothing.")));
    }
    Ok(VectorResult { feature: p.feature, doc_uid: p.doc_uid, art, place: job.place.clone() })
}

/// The image as a PNG of at most 1024 pixels a side (Image Trace's time grows with the pixels).
fn trace_input(bytes: &[u8]) -> Result<Vec<u8>> {
    let img = crate::image_util::decode(bytes)?;
    let long = img.width().max(img.height());
    let img = if long > 1024 {
        let s = 1024.0 / f64::from(long);
        let (w, h) = (((f64::from(img.width()) * s).round() as u32).max(1), ((f64::from(img.height()) * s).round() as u32).max(1));
        image::imageops::resize(&img, w, h, image::imageops::FilterType::Triangle)
    } else {
        img
    };
    crate::image_util::encode_png(&img)
}

/// The Image Trace preset for a kind of art and detail level.
pub fn trace_preset(kind: VectorKind, detail: Detail) -> &'static str {
    match (kind, detail) {
        (VectorKind::Icon | VectorKind::Pattern, Detail::Low) => "3 Colors",
        (VectorKind::Icon | VectorKind::Pattern, Detail::Medium) => "6 Colors",
        (VectorKind::Icon | VectorKind::Pattern, Detail::High) => "16 Colors",
        (VectorKind::Subject, Detail::Low) => "6 Colors",
        (VectorKind::Subject, Detail::Medium) => "16 Colors",
        (VectorKind::Subject, Detail::High) => "Low Fidelity Photo",
        (VectorKind::Scene, Detail::Low) => "16 Colors",
        (VectorKind::Scene, Detail::Medium) => "Low Fidelity Photo",
        (VectorKind::Scene, Detail::High) => "High Fidelity Photo",
    }
}

/// Place one variation as a group, unfitted; returns its id.
fn place_art(s: &mut Session, art: &VectorArt, kind: VectorKind, detail: Detail) -> Result<u64> {
    let ids = match art {
        VectorArt::Svg(svg) => paste_import(s, "clipboard.importSvg", json!({ "svg": svg }))?,
        VectorArt::Image(png) => {
            let ids = paste_import(s, "clipboard.importImage", json!({ "dataBase64": vectorcraft_format::base64_encode(png) }))?;
            let image = ids.first().copied().ok_or_else(|| AiError::bad_response("The generated image could not be placed."))?;
            let mut p = json!({ "id": image, "preset": trace_preset(kind, detail) });
            if matches!(kind, VectorKind::Subject | VectorKind::Icon) {
                p["params"] = json!({ "ignoreWhite": true });
            }
            let traced = exec(s, "imageTrace.makeAndExpand", p)?;
            vec![id_of(&traced).ok_or_else(|| AiError::bad_response("Image Trace made nothing of the generated image."))?]
        }
    };
    match ids.as_slice() {
        [one] => Ok(*one),
        _ => id_of(&exec(s, "object.group", json!({ "ids": ids }))?).ok_or_else(|| AiError::bad_response("The art could not be grouped.")),
    }
}

pub(crate) fn apply(s: &mut Session, r: &VectorResult, i: usize) -> Result<Applied> {
    let art = r.art.get(i).ok_or_else(|| AiError::bad_request("No such variation."))?;
    match &r.place {
        Placement::Area { target, kind, detail } => {
            let id = place_art(s, art, *kind, *detail)?;
            fit_into(s, id, *target, FitMode::Contain)?;
            exec(s, "select.set", json!({ "ids": [id] }))?;
            Ok(Applied { ids: vec![id], swatch: None })
        }
        Placement::Shape { shape, target, detail } => {
            if node_bounds(s, *shape).is_none() {
                return Err(AiError::document("The shape to fill is gone."));
            }
            let id = place_art(s, art, VectorKind::Scene, *detail)?;
            fit_into(s, id, *target, FitMode::Cover)?;
            move_below(s, id, *shape)?;
            let clip = exec(s, "object.clippingMask.make", json!({ "ids": [shape.0, id] }))?;
            let group = id_of(&clip).ok_or_else(|| AiError::document("The clipping group could not be made."))?;
            exec(s, "select.set", json!({ "ids": [group] }))?;
            Ok(Applied { ids: vec![group], swatch: None })
        }
        Placement::Pattern { tile, name, fill, detail } => apply_pattern(s, art, *tile, name, fill, *detail),
    }
}

fn apply_pattern(s: &mut Session, art: &VectorArt, tile: f64, name: &str, fill: &[u64], detail: Detail) -> Result<Applied> {
    let id = place_art(s, art, VectorKind::Pattern, detail)?;
    let c = super::artboard_rect(s).map(|r| r.center()).unwrap_or_default();
    let cell = Rect::from_center_size(c, (tile, tile));
    fit_into(s, id, cell, FitMode::Contain)?;
    let made = exec(s, "object.pattern.make", json!({ "ids": [id], "name": name, "edit": false, "width": tile, "height": tile }))?;
    let swatch = made.get("name").and_then(serde_json::Value::as_str).unwrap_or(name).to_string();
    // The tile's art is in the swatch now; the copy on the artboard goes.
    exec(s, "edit.clear", json!({ "ids": [id] }))?;
    let live: Vec<u64> = fill.iter().copied().filter(|f| node_bounds(s, NodeId(*f)).is_some()).collect();
    if !live.is_empty() {
        exec(s, "paint.setFill", json!({ "ids": live, "swatch": swatch }))?;
        exec(s, "select.set", json!({ "ids": live }))?;
    }
    Ok(Applied { ids: live, swatch: Some(swatch) })
}
