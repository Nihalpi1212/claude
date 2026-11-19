//! Generative Fill, Generate Background (`ai.replaceBackground`) and Sky Replacement
//! (`ai.replaceSky`): a mask, the composite under it sent with the prompt, and the answer landed
//! as new layers holding only the masked pixels.

use std::sync::Arc;

use photocraft_algo::segment::sky::{self, SkyParams};
use photocraft_algo::segment::{Sampler, SurfaceSampler, subject};
use photocraft_doc::{Document, LayerId};
use photocraft_geom::Rect;
use photocraft_raster::{Rgba8Image, Surface};
use serde_json::{Value, json};

use super::{
    FILL_REGION_MAX, SEND_MAX_EDGE, call, check_answer, check_keys, composite_rgba8, generative_error, has_backend, insert_layers, layer_format, layer_surface,
    layered_doc, prepare, prompt, region, selection_bounds,
};
use crate::commands::{CommandSpec, layer_param};
use crate::generative::{Choice, GenerativeBackend, ImageEdit, ModelKind, kind};
use crate::jobs::{self, JobCtx};
use crate::{EngineError, Result, Session};

const FILL: &str = "ai.generativeFill";
const BACKGROUND: &str = "ai.replaceBackground";
const SKY: &str = "ai.replaceSky";

/// The pixels of the new layers for `n` variations of an edit of `original` (a region's
/// composite) under the coverage `cov` (the same size): each answer scaled back to the region,
/// with its alpha multiplied by the coverage. One backend call per variation, in order.
///
/// A variation failing after others arrived ends the requests but keeps those (each was billed):
/// they come back with the error. The first failing, or a cancel at any point, is an error.
#[allow(clippy::too_many_arguments)]
pub(super) fn fill_layers(
    backend: &dyn GenerativeBackend,
    choice: &Choice,
    prompt: &str,
    original: &Rgba8Image,
    cov: &[f32],
    n: u32,
    ctx: &JobCtx,
) -> Result<(Vec<Rgba8Image>, Option<EngineError>)> {
    let (w, h) = (original.width, original.height);
    let (sw, sh) = region::fit_within(w, h, SEND_MAX_EDGE);
    let image = region::resize_rgba8(original, sw, sh);
    let mask = region::resize_rgba8(&region::mask_image(cov, w, h), sw, sh);
    let req = ImageEdit { choice: choice.clone(), prompt: prompt.to_string(), image, mask: Some(mask), transparent: false };
    let mut out = Vec::new();
    for i in 0..n {
        ctx.check()?;
        ctx.progress(i as f32 / n as f32, if n > 1 { "Generating variations" } else { "Generating" });
        let answer = match call(ctx, |cancelled| backend.edit_image(&req, cancelled)).and_then(|a| check_answer(&a, sw, sh).map(|()| a)) {
            Ok(a) => a,
            Err(e) if !out.is_empty() && !matches!(e, EngineError::Cancelled) => return Ok((out, Some(e))),
            Err(e) => return Err(e),
        };
        out.push(region::masked_layer(&region::resize_rgba8(&answer, w, h), cov));
    }
    Ok((out, None))
}

/// The selection's coverage over `rect`, feathered by 1 px as if the canvas went on beyond its
/// border (JS `selectionMaskCanvas`), so a selection touching the border keeps full coverage
/// there.
fn selection_coverage(doc: &Document, rect: Rect) -> Vec<f32> {
    let n = rect.width() as usize * rect.height() as usize;
    let Some(sel) = doc.selection.as_ref() else { return vec![0.0; n] };
    // Read a little around the rect (the blur reaches 2 px), within the canvas.
    let read = rect.inflate(4).intersect(&doc.bounds());
    let channels = sel.channels().max(1);
    let raw = sel.read_region(read);
    let v: Vec<f32> = raw.chunks_exact(channels).map(|p| p.first().copied().unwrap_or(0.0)).collect();
    let feathered = region::feather_keeping_border(&v, read.width() as usize, read.height() as usize, 1.0);
    crop_coverage(&feathered, read, rect)
}

/// The part of coverage `v` (over `from`) inside `to`; zero outside `from`.
pub(super) fn crop_coverage(v: &[f32], from: Rect, to: Rect) -> Vec<f32> {
    let mut out = vec![0.0; to.width() as usize * to.height() as usize];
    let fw = from.width() as usize;
    for y in to.y0..to.y1 {
        for x in to.x0..to.x1 {
            if from.contains(x, y)
                && let Some(c) = v.get((y - from.y0) as usize * fw + (x - from.x0) as usize)
                && let Some(o) = out.get_mut((y - to.y0) as usize * to.width() as usize + (x - to.x0) as usize)
            {
                *o = *c;
            }
        }
    }
    out
}

/// What the new layers are called: the feature's name, numbered when there are several.
fn names(label: &str, n: usize) -> Vec<String> {
    if n == 1 { vec![label.to_string()] } else { (1..=n).map(|i| format!("{label} {i}")).collect() }
}

/// A fill: `mask` (run on the worker) gives the region and the coverage over it; the composite
/// there goes to the backend with `prompt`, `n` times; the answers land as layers named `label`
/// above `anchor` (or the active layer), in one step named `label`.
#[allow(clippy::too_many_arguments)]
fn run_fill(
    s: &mut Session,
    label: &'static str,
    anchor: Option<LayerId>,
    n: u32,
    backend: Arc<dyn GenerativeBackend>,
    choice: Choice,
    prompt: String,
    mask: impl FnOnce(&Document, &JobCtx) -> Result<(Rect, Vec<f32>)> + Send + 'static,
) -> Result<Value> {
    let doc = s.active().ok_or(EngineError::NoDocument)?.doc.clone();
    let format = layer_format(&doc);
    jobs::run(
        s,
        label,
        true,
        move |ctx| {
            ctx.progress(0.0, "Preparing");
            let (rect, cov) = mask(&doc, ctx)?;
            ctx.check()?;
            let original = composite_rgba8(&doc, rect, ctx)?;
            let (images, failed) = fill_layers(&*backend, &choice, &prompt, &original, &cov, n, ctx)?;
            let surfaces = images.iter().map(|img| layer_surface(img, rect, format)).collect::<Result<Vec<Surface>>>()?;
            Ok((rect, surfaces, failed))
        },
        move |s, (rect, surfaces, failed)| {
            let layers = names(label, surfaces.len()).into_iter().zip(surfaces).collect();
            let ids = s.edit(label, |doc, active| insert_layers(doc, active, anchor, layers))?;
            let mut r = json!({ "layers": ids.iter().map(|id| id.0).collect::<Vec<_>>(), "bounds": [rect.x0, rect.y0, rect.width(), rect.height()] });
            // The variations that arrived landed; say why the next did not.
            if let Some(e) = failed {
                let kind = match &e {
                    EngineError::Generative { kind, .. } => json!(kind),
                    _ => Value::Null,
                };
                r["failed"] = json!({ "kind": kind, "message": e.to_string() });
            }
            Ok(r)
        },
    )
}

fn variations(p: &Value) -> Result<u32> {
    match p.get("variations") {
        None | Some(Value::Null) => Ok(1),
        // JS clamps a rounded number into 1..3.
        Some(v) => v
            .as_f64()
            .filter(|f| f.is_finite())
            .map(|f| f.round().clamp(1.0, 3.0) as u32)
            .ok_or_else(|| super::bad(FILL, "`variations` must be a number from 1 to 3")),
    }
}

fn generative_fill(s: &mut Session, p: &Value) -> Result<Value> {
    check_keys(FILL, p, &["prompt", "variations", "provider", "model", "layer"])?;
    let doc = layered_doc(s).map_err(|why| EngineError::Disabled(FILL.into(), why))?;
    let bounds = selection_bounds(doc).ok_or_else(|| generative_error(kind::DOCUMENT, "Make a selection first"))?;
    let (w, h) = (doc.size.width, doc.size.height);
    let anchor = if p.get("layer").is_some_and(|l| !l.is_null()) { Some(layer_param(s, p)?) } else { None };
    let n = variations(p)?;
    let prompt = prompt(FILL, p, None)?;
    let (backend, choice) = prepare(s, FILL, p, ModelKind::Image)?;
    let rect = region::fill_region(bounds, w, h, FILL_REGION_MAX);
    crate::allocation::check_dense(rect, 24, "Generative Fill")?;
    run_fill(s, "Generative Fill", anchor, n, backend, choice, prompt, move |doc, _| Ok((rect, selection_coverage(doc, rect))))
}

/// The layer's visible pixels as coverage over `canvas`: its alpha times its enabled mask, as
/// drawn (feather included).
fn visible_alpha(doc: &Document, id: LayerId, canvas: Rect) -> Option<Vec<f32>> {
    let l = doc.layer(id)?;
    let surface = l.surface()?;
    let mut px = vec![[0u8; 4]; canvas.width() as usize * canvas.height() as usize];
    surface.read_rgba8_into(canvas, &mut px);
    let mut mask = Vec::new();
    super::mask_shown(l, doc.bounds(), canvas, &mut mask);
    Some(px.iter().zip(mask.iter().chain(std::iter::repeat(&1.0))).map(|(p, m)| f32::from(p[3]) / 255.0 * m.clamp(0.0, 1.0)).collect())
}

/// The subject of layer `id` over `canvas`: what the layer shows when it is already cut out (a
/// mask, as Remove Background leaves, or transparency), else Select Subject on its pixels.
fn subject_coverage(doc: &Document, id: LayerId, canvas: Rect, ctx: &JobCtx) -> Result<Vec<f32>> {
    let l = doc.layer(id).ok_or(EngineError::NoLayer(id))?;
    let visible = visible_alpha(doc, id, canvas).ok_or_else(|| generative_error(kind::DOCUMENT, "Select a layer with pixels"))?;
    let masked = l.mask.as_ref().is_some_and(|m| m.enabled);
    if masked || visible.iter().any(|a| *a < 1.0) {
        return Ok(visible);
    }
    let surface = l.surface().ok_or_else(|| generative_error(kind::DOCUMENT, "Select a layer with pixels"))?;
    let found = ctx
        .stage(0.0, 0.1, "Finding subject", |ctl| subject::select_subject_with(&SurfaceSampler(surface), canvas, ctl))
        .map_err(|_| EngineError::Cancelled)?
        .ok_or_else(|| generative_error(kind::DOCUMENT, "No subject was found in the layer; select the background to replace and use Generative Fill"))?;
    let mut cov = vec![0.0; visible.len()];
    for y in canvas.y0..canvas.y1 {
        for x in canvas.x0..canvas.x1 {
            if let Some(c) = cov.get_mut((y - canvas.y0) as usize * canvas.width() as usize + (x - canvas.x0) as usize) {
                *c = found.at(x, y);
            }
        }
    }
    Ok(cov)
}

fn replace_background(s: &mut Session, p: &Value) -> Result<Value> {
    check_keys(BACKGROUND, p, &["prompt", "provider", "model", "layer"])?;
    let doc = layered_doc(s).map_err(|why| EngineError::Disabled(BACKGROUND.into(), why))?;
    let canvas = doc.bounds();
    let id = layer_param(s, p)?;
    let doc = &s.active().ok_or(EngineError::NoDocument)?.doc;
    if doc.layer(id).and_then(|l| l.surface()).is_none() {
        return Err(generative_error(kind::DOCUMENT, "Select a layer with pixels"));
    }
    let prompt = prompt(BACKGROUND, p, None)?;
    let (backend, choice) = prepare(s, BACKGROUND, p, ModelKind::Image)?;
    crate::allocation::check_dense(canvas, 28, "Generate Background")?;
    run_fill(s, "Generate Background", Some(id), 1, backend, choice, prompt, move |doc, ctx| {
        let cov = region::invert_mask(&subject_coverage(doc, id, canvas, ctx)?);
        if cov.iter().all(|c| *c <= 0.0) {
            return Err(generative_error(kind::DOCUMENT, "The layer covers the whole image; there is no background to generate"));
        }
        Ok((canvas, cov))
    })
}

struct CompositeSampler<'a>(&'a Document);

impl Sampler for CompositeSampler<'_> {
    fn rgba(&self, r: Rect) -> Vec<[f32; 4]> {
        photocraft_compose::render(self.0, r).into_px()
    }
}

/// The sky, from Select › Sky's segmentation of the composite.
fn sky_coverage(doc: &Document, canvas: Rect) -> Result<Vec<f32>> {
    let found = sky::select_sky(&CompositeSampler(doc), canvas, SkyParams { threshold: 50.0, softness: 50.0 })
        .ok_or_else(|| generative_error(kind::DOCUMENT, "No sky was found in the image; select the sky and try again"))?;
    let mut cov = vec![0.0; canvas.width() as usize * canvas.height() as usize];
    for y in found.bbox.y0.max(canvas.y0)..found.bbox.y1.min(canvas.y1) {
        for x in found.bbox.x0.max(canvas.x0)..found.bbox.x1.min(canvas.x1) {
            if let Some(c) = cov.get_mut((y - canvas.y0) as usize * canvas.width() as usize + (x - canvas.x0) as usize) {
                *c = found.at(x, y);
            }
        }
    }
    Ok(cov)
}

fn replace_sky(s: &mut Session, p: &Value) -> Result<Value> {
    check_keys(SKY, p, &["prompt", "provider", "model"])?;
    let doc = layered_doc(s).map_err(|why| EngineError::Disabled(SKY.into(), why))?;
    let canvas = doc.bounds();
    let selected = selection_bounds(doc).is_some();
    let prompt = prompt(SKY, p, None)?;
    let (backend, choice) = prepare(s, SKY, p, ModelKind::Image)?;
    crate::allocation::check_dense(canvas, 28, "Sky Replacement")?;
    run_fill(s, "Sky Replacement", None, 1, backend, choice, prompt, move |doc, _| {
        let cov = if selected { selection_coverage(doc, canvas) } else { sky_coverage(doc, canvas)? };
        if cov.iter().all(|c| *c <= 0.0) {
            return Err(generative_error(kind::DOCUMENT, "No sky was found in the image; select the sky and try again"));
        }
        Ok((canvas, cov))
    })
}

fn fill_enabled(s: &Session) -> std::result::Result<(), String> {
    let doc = layered_doc(s)?;
    selection_bounds(doc).ok_or("no selection: make a selection first")?;
    has_backend(s)
}

fn background_enabled(s: &Session) -> std::result::Result<(), String> {
    layered_doc(s)?;
    let l = crate::active_layer_of(s)?;
    l.surface().ok_or_else(|| format!("the layer is {} {} layer, without pixels of its own", l.content.article(), l.content.kind_name()))?;
    has_backend(s)
}

fn sky_enabled(s: &Session) -> std::result::Result<(), String> {
    layered_doc(s)?;
    has_backend(s)
}

pub(super) fn specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec {
            id: FILL,
            label: "Generative Fill…",
            menu: &[],
            shortcut: None,
            params: r##"{"prompt":str,"variations":1..3=1,"provider":"openai|gemini"?,"model":str?,"layer":id? (the new layers go above it; default the active layer)} → {layers:[id],bounds} (sends the composite around the selection, the selection and the prompt to the AI provider; one new layer per variation holds the generated pixels inside the feathered selection; one step; the selection stays; when a later variation fails, those that arrived still land and `failed`:{kind,message} says why the next did not)"##,
            enabled: fill_enabled,
            run: generative_fill,
            journal: true,
        },
        CommandSpec {
            id: BACKGROUND,
            label: "Generate Background…",
            menu: &[],
            shortcut: None,
            params: r##"{"prompt":str,"provider":"openai|gemini"?,"model":str?,"layer":id? (the subject's layer; default the active layer)} → {layers:[id],bounds} (keeps the layer's subject, from its mask or transparency or else Select Subject, and sends the composite, the area around the subject and the prompt to the AI provider; a new layer above holds the generated surroundings)"##,
            enabled: background_enabled,
            run: replace_background,
            journal: true,
        },
        CommandSpec {
            id: SKY,
            label: "Sky Replacement…",
            menu: &[],
            shortcut: None,
            params: r##"{"prompt":str,"provider":"openai|gemini"?,"model":str?} → {layers:[id],bounds} (the sky is the selection, or else Select › Sky's; sends the composite, the sky mask and the prompt to the AI provider; a new layer holds the generated sky inside the mask)"##,
            enabled: sky_enabled,
            run: replace_sky,
            journal: true,
        },
    ]
}
