//! Generative Expand: a placed raster image grows to a larger canvas, the new area painted by the
//! image model through a mask (the image edit endpoint). The result replaces the image, at the
//! same place in the stacking order, with the original pixels exactly where they were.

use serde::{Deserialize, Serialize};
use serde_json::json;
use vectorcraft_doc::{NodeId, NodeKind};
use vectorcraft_engine::Session;
use vectorcraft_geom::{Affine, Point, Rect};

use super::{Applied, Feature, Inputs, Prepared, exec, move_below, paste_import};
use crate::image_util::{ExpandPlan, decode, encode_png, parse_size, ratio_size};
use crate::provider::{EditRequest, ProviderKind, gemini, openai};
use crate::{AiError, CancelToken, Provider, Result};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExpandSpec {
    /// What to put in the new area (optional).
    pub prompt: String,
    /// Points to add on the left, top, right and bottom.
    pub margins: [f64; 4],
    /// Instead of `margins`: grow the image to cover the artboard it lies on (an artboard
    /// background).
    pub fill_artboard: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct ExpandJob {
    image: u64,
    key: String,
    png: Vec<u8>,
    margins_px: [u32; 4],
    prompt: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ExpandResult {
    pub doc_uid: u64,
    /// The image replaced.
    pub image: u64,
    /// Its pixels' key when the job started (a changed image isn't replaced).
    pub key: String,
    /// The new image.
    pub png: Vec<u8>,
    /// Where the original's top-left pixel is in the new image.
    pub offset: (u32, u32),
}

/// The selected image (one embedded or linked raster image).
fn selected_image(s: &Session) -> Result<(NodeId, vectorcraft_doc::ImageObject)> {
    let ids = super::selection(s)?;
    let [id] = ids.as_slice() else {
        return Err(AiError::document("Select one placed image to expand."));
    };
    match super::kind_of(s, *id) {
        Some(NodeKind::Image(img)) => Ok((*id, *img)),
        _ => Err(AiError::document("Select one placed image to expand.")),
    }
}

/// Pixels per point along each image axis.
fn px_per_pt(xf: Affine) -> (f64, f64) {
    let [a, b, c, d, ..] = xf.as_coeffs();
    let (sx, sy) = (a.hypot(b), c.hypot(d));
    (if sx > 1e-9 { 1.0 / sx } else { 1.0 }, if sy > 1e-9 { 1.0 / sy } else { 1.0 })
}

/// The margins (pixels) that grow the image to cover `board`. Only an unrotated image can.
fn margins_to_cover(img: &vectorcraft_doc::ImageObject, board: Rect) -> Result<[u32; 4]> {
    let [a, b, c, d, ..] = img.xf.as_coeffs();
    if b.abs() > 1e-9 || c.abs() > 1e-9 || a <= 0.0 || d <= 0.0 {
        return Err(AiError::document("Only an unrotated, unflipped image can be expanded to its artboard."));
    }
    let p0 = img.xf * Point::new(0.0, 0.0);
    let p1 = img.xf * Point::new(f64::from(img.width), f64::from(img.height));
    let (kx, ky) = (1.0 / a, 1.0 / d);
    let px = |v: f64, k: f64| (v.max(0.0) * k).ceil().min(f64::from(crate::image_util::MAX_SIDE)) as u32;
    Ok([px(p0.x - board.x0, kx), px(p0.y - board.y0, ky), px(board.x1 - p1.x, kx), px(board.y1 - p1.y, ky)])
}

pub(crate) fn prepare(s: &mut Session, spec: &ExpandSpec) -> Result<Prepared> {
    let (id, img) = selected_image(s)?;
    let bytes = {
        let st = s.doc().map_err(|_| super::no_document())?;
        st.doc.images.get(&img.key).map(|b| b.bytes.clone()).ok_or_else(|| AiError::document("The image's pixels are missing (relink it first)."))?
    };
    let original = decode(&bytes).map_err(|_| AiError::document("This image's format can't be expanded."))?;
    if original.width() != img.width || original.height() != img.height {
        // A linked image shown from a smaller preview: its placement is in its own pixels.
        return Err(AiError::document("The image's pixels aren't loaded at full size (update its link first)."));
    }
    let margins_px = if spec.fill_artboard {
        let board = image_artboard(s, &img).ok_or_else(|| AiError::document("The image isn't on an artboard."))?;
        margins_to_cover(&img, board)?
    } else {
        let (kx, ky) = px_per_pt(img.xf);
        let [l, t, r, b] = spec.margins;
        if [l, t, r, b].iter().any(|m| !m.is_finite() || *m < 0.0) {
            return Err(AiError::bad_request("Margins are points to add, 0 or more."));
        }
        let px = |m: f64, k: f64| (m * k).round().min(f64::from(crate::image_util::MAX_SIDE)) as u32;
        [px(l, kx), px(t, ky), px(r, kx), px(b, ky)]
    };
    if margins_px.iter().all(|m| *m == 0) {
        return Err(AiError::bad_request("Make the image larger on at least one side."));
    }
    // Checks the size now, with any send size.
    ExpandPlan::new(img.width, img.height, margins_px, (1024, 1024))?;
    let job =
        ExpandJob { image: id.0, key: img.key.clone(), png: encode_png(&original)?, margins_px, prompt: crate::prompts::expand_prompt(&spec.prompt) };
    Ok(Prepared { feature: Feature::Expand, doc_uid: super::active_uid(s)?, inputs: Inputs::Expand(job) })
}

/// The artboard the image's centre lies on.
fn image_artboard(s: &Session, img: &vectorcraft_doc::ImageObject) -> Option<Rect> {
    let c = img.xf * Point::new(f64::from(img.width) / 2.0, f64::from(img.height) / 2.0);
    s.active()?.doc.artboards.iter().map(|a| a.rect).find(|r| r.contains(c))
}

/// The size the provider is sent for a canvas.
fn send_size(provider: &dyn Provider, w: u32, h: u32) -> (u32, u32) {
    match provider.kind() {
        ProviderKind::OpenAi => parse_size(openai::image_size(&provider.config().image_model, w, h)).unwrap_or((1024, 1024)),
        ProviderKind::Gemini => ratio_size(crate::provider::nearest_ratio(w, h, &gemini::RATIOS), 1024),
    }
}

pub(crate) fn run(p: &Prepared, job: &ExpandJob, provider: &dyn Provider, cancel: &CancelToken) -> Result<ExpandResult> {
    let original = decode(&job.png)?;
    let (w, h) = (original.width(), original.height());
    let [l, t, r, b] = job.margins_px;
    let send = send_size(provider, w.saturating_add(l).saturating_add(r), h.saturating_add(t).saturating_add(b));
    let plan = ExpandPlan::new(w, h, job.margins_px, send)?;
    let (image, mask) = plan.inputs(&original)?;
    let answer = provider.edit_image(&EditRequest { prompt: job.prompt.clone(), image, mask: Some(mask) }, cancel)?;
    cancel.check()?;
    let out = plan.compose(&original, &decode(&answer.bytes)?);
    Ok(ExpandResult { doc_uid: p.doc_uid, image: job.image, key: job.key.clone(), png: encode_png(&out)?, offset: (plan.ox, plan.oy) })
}

pub(crate) fn apply(s: &mut Session, r: &ExpandResult) -> Result<Applied> {
    let old = NodeId(r.image);
    let Some(NodeKind::Image(img)) = super::kind_of(s, old) else {
        return Err(AiError::document("The image to expand is gone."));
    };
    if img.key != r.key {
        return Err(AiError::document("The image changed while it was being expanded."));
    }
    let ids = paste_import(s, "clipboard.importImage", json!({ "dataBase64": vectorcraft_format::base64_encode(&r.png) }))?;
    let new = ids.first().copied().ok_or_else(|| AiError::bad_response("The expanded image could not be placed."))?;
    let Some(NodeKind::Image(pasted)) = super::kind_of(s, NodeId(new)) else {
        return Err(AiError::bad_response("The expanded image could not be placed."));
    };
    // The new pixel (ox, oy) lands where the old pixel (0, 0) was, at the old pixel size.
    let target = img.xf * Affine::translate((-f64::from(r.offset.0), -f64::from(r.offset.1)));
    let m = target * pasted.xf.inverse();
    if !m.as_coeffs().iter().all(|v| v.is_finite()) {
        return Err(AiError::document("The image's placement can't be inverted."));
    }
    exec(s, "object.transform", json!({ "ids": [new], "matrix": m.as_coeffs() }))?;
    move_below(s, new, old)?;
    exec(s, "edit.clear", json!({ "ids": [old.0] }))?;
    exec(s, "select.set", json!({ "ids": [new] }))?;
    Ok(Applied { ids: vec![new], swatch: None })
}
