//! Remove Background (`ai.removeBackground`): a layer mask on the layer, in place, as Photoshop's
//! Quick Action and PhotoCraft's `layer.removeBackground` make it. `method` picks how the
//! subject is found:
//!
//! - `local` (the default): PhotoCraft's Select Subject with edge refinement, no network and no
//!   key (`layer.removeBackground`, run as it is);
//! - `provider`: the layer's pixels go to the AI provider, which answers with the subject on
//!   transparency (an opaque answer is keyed off its white border); its alpha, intersected with
//!   the layer's enabled mask, becomes the mask.

use photocraft_doc::{Layer, LayerContent, LayerMask};
use photocraft_raster::{Rgba8Image, Surface};
use serde_json::{Value, json};

use super::{SEND_MAX_EDGE, bad, call, check_answer, check_keys, generative_error, prepare, region};
use crate::commands::{CommandSpec, layer_param};
use crate::generative::{ImageEdit, ModelKind, kind};
use crate::{EngineError, Result, Session};

const CMD: &str = "ai.removeBackground";
const LOCAL: &str = "layer.removeBackground";

/// What the provider is asked (JS).
pub const PROMPT: &str = "Remove the background. Keep the subject exactly as it is, with its edges intact, on a fully transparent background.";

/// An unlocked pixel layer, as `layer.removeBackground` needs.
fn check(doc: &photocraft_doc::Document, l: &Layer) -> std::result::Result<(), String> {
    if !matches!(l.content, LayerContent::Raster(_)) {
        return Err(format!("the layer is {} {} layer, not a pixel layer", l.content.article(), l.content.kind_name()));
    }
    let locks = doc.effective_locks(l.id);
    if locks.pixels || locks.all {
        return Err(format!("Could not complete your request because the layer \"{}\" is locked", l.name));
    }
    Ok(())
}

fn enabled(s: &Session) -> std::result::Result<(), String> {
    let d = s.active().ok_or("no document open")?;
    check(&d.doc, crate::active_layer_of(s)?)
}

fn run(s: &mut Session, p: &Value) -> Result<Value> {
    check_keys(CMD, p, &["layer", "method", "sampleAllLayers", "refine", "provider", "model"])?;
    match p.get("method") {
        None | Some(Value::Null) => local(s, p),
        Some(Value::String(m)) if m == "local" => local(s, p),
        Some(Value::String(m)) if m == "provider" => provider(s, p),
        Some(_) => Err(bad(CMD, "`method` must be \"local\" or \"provider\"")),
    }
}

/// PhotoCraft's own Remove Background, run as that command runs (as a job when this one is).
fn local(s: &mut Session, p: &Value) -> Result<Value> {
    if p.get("provider").is_some() || p.get("model").is_some() {
        return Err(bad(CMD, "`provider` and `model` are for \"method\":\"provider\""));
    }
    let mut params = serde_json::Map::new();
    for key in ["layer", "sampleAllLayers", "refine"] {
        if let Some(v) = p.get(key) {
            params.insert(key.into(), v.clone());
        }
    }
    let spec = crate::commands::find(LOCAL).ok_or_else(|| EngineError::UnknownCommand(LOCAL.into()))?;
    let mut r = (spec.run)(s, &Value::Object(params))?;
    if let Some(o) = r.as_object_mut()
        && !o.contains_key("job")
    {
        o.insert("method".into(), json!("local"));
    }
    Ok(r)
}

fn provider(s: &mut Session, p: &Value) -> Result<Value> {
    if p.get("sampleAllLayers").is_some() || p.get("refine").is_some() {
        return Err(bad(CMD, "`sampleAllLayers` and `refine` are for \"method\":\"local\""));
    }
    let id = layer_param(s, p)?;
    let d = s.active().ok_or(EngineError::NoDocument)?;
    let layer = d.doc.layer(id).ok_or(EngineError::NoLayer(id))?;
    check(&d.doc, layer).map_err(|why| EngineError::Disabled(CMD.into(), why))?;
    let surface = layer.surface().ok_or_else(|| generative_error(kind::DOCUMENT, "Select a layer with pixels"))?;
    let rect = surface.content_bounds().intersect(&d.doc.bounds());
    if rect.is_empty() {
        return Err(generative_error(kind::DOCUMENT, "Select a layer with pixels"));
    }
    crate::allocation::check_dense(rect, 16, "Remove Background")?;
    let doc = d.doc.clone();
    let (backend, choice) = prepare(s, CMD, p, ModelKind::Image)?;
    crate::jobs::run(
        s,
        "Remove Background",
        true,
        move |ctx| {
            ctx.progress(0.0, "Removing background");
            let layer = doc.layer(id).ok_or(EngineError::NoLayer(id))?;
            let surface = layer.surface().ok_or_else(|| generative_error(kind::DOCUMENT, "Select a layer with pixels"))?;
            // What the layer shows: its pixels with its enabled mask applied (JS `activePixels`).
            let (w, h) = (rect.width(), rect.height());
            let mut px = vec![[0u8; 4]; w as usize * h as usize];
            surface.read_rgba8_into(rect, &mut px);
            let mut shown = Vec::new();
            super::mask_shown(layer, doc.bounds(), rect, &mut shown);
            let mut image = Rgba8Image::new(w, h);
            for ((o, p), m) in image.pixels.chunks_exact_mut(4).zip(&px).zip(&shown) {
                o.copy_from_slice(&[p[0], p[1], p[2], (f32::from(p[3]) * m.clamp(0.0, 1.0) + 0.5) as u8]);
            }
            let (sw, sh) = region::fit_within(w, h, SEND_MAX_EDGE);
            let req = ImageEdit { choice, prompt: PROMPT.into(), image: region::resize_rgba8(&image, sw, sh), mask: None, transparent: true };
            let mut answer = call(ctx, |cancelled| backend.edit_image(&req, cancelled))?;
            check_answer(&answer, sw, sh)?;
            if region::is_opaque(&answer) {
                region::key_white_border(&mut answer, 232);
            }
            let alpha = region::alpha_to_mask(&region::resize_rgba8(&answer, w, h));
            // The new mask: the subject, inside what the old mask already hid.
            let bytes: Vec<u8> = alpha.iter().zip(&shown).map(|(a, m)| (a * m.clamp(0.0, 1.0) * 255.0 + 0.5) as u8).collect();
            let mut mask = Surface::from_interleaved(photocraft_color::PixelFormat::GRAY8, rect, &bytes);
            mask.prune();
            // The old mask's feather and density are in `shown`; its link stays as it was.
            Ok((mask, layer.mask.as_ref().is_none_or(|m| m.linked)))
        },
        move |s, (mask, linked)| {
            let bounds = s.edit("Remove Background", |doc, _| {
                crate::extra_cmds::background_to_layer_for_mask(doc, id);
                let b = mask.content_bounds();
                let mask = crate::commands::mask_at_depth(LayerMask { surface: mask, linked, ..LayerMask::reveal_all() }, doc.depth)?;
                doc.layer_mut(id).ok_or(EngineError::NoLayer(id))?.mask = Some(mask);
                doc.selection = None;
                Ok([b.x0, b.y0, b.width() as i32, b.height() as i32])
            })?;
            Ok(json!({ "layer": id.0, "bounds": bounds, "method": "provider" }))
        },
    )
}

pub(super) fn specs() -> Vec<CommandSpec> {
    vec![CommandSpec {
        id: CMD,
        label: "Remove Background",
        menu: &[],
        shortcut: None,
        params: r##"{"layer":id?,"method":"local|provider"="local","sampleAllLayers":bool=false,"refine":bool=true (local only),"provider":"openai|gemini"?,"model":str? (provider only)} → {layer,bounds,method} (a layer mask on the layer, in place, in one step; the Background becomes a normal layer. local: Select Subject with edge refinement, nothing is sent; provider: sends the layer's pixels to the AI provider and masks by the subject it returns, within the layer's existing mask)"##,
        enabled,
        run,
        journal: true,
    }]
}
