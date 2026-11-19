//! Generate Image: a new document-size layer, or a new document, from a prompt.

use photocraft_color::PixelFormat;
use photocraft_geom::Rect;
use serde_json::{Value, json};

use super::{SEND_MAX_EDGE, bad, call, check_answer, check_keys, has_backend, insert_layers, layer_format, layer_surface, prepare, prompt, region};
use crate::commands::CommandSpec;
use crate::document_preset_cmds::MAX_RESOLUTION;
use crate::generative::{ImageGen, ModelKind};
use crate::{EngineError, Result, Session};

const CMD: &str = "ai.generateImage";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Target {
    Layer,
    Document,
}

fn size_param(p: &Value, key: &str, default: u32) -> Result<u32> {
    match p.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(v) => v
            .as_f64()
            .filter(|f| f.is_finite() && (16.0..=8192.0).contains(&f.round()))
            .map(|f| f.round() as u32)
            .ok_or_else(|| bad(CMD, format!("`{key}` must be a number of pixels from 16 to 8192"))),
    }
}

fn transparent(p: &Value) -> Result<bool> {
    match p.get("transparent") {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => Err(bad(CMD, "`transparent` must be true or false")),
    }
}

/// A new document's name: the prompt's first 40 characters (JS).
fn document_name(prompt: &str) -> String {
    let name: String = prompt.chars().take(40).collect::<String>().trim().to_string();
    if name.is_empty() { "Generated image".into() } else { name }
}

fn run(s: &mut Session, p: &Value) -> Result<Value> {
    check_keys(CMD, p, &["prompt", "target", "width", "height", "transparent", "provider", "model"])?;
    let open = s.active().map(|d| (d.doc.size.width, d.doc.size.height, d.doc.resolution_dpi, crate::layer_copy_cmds::layered(d.doc.mode)));
    let target = match p.get("target").and_then(Value::as_str) {
        None if open.is_some() => Target::Layer,
        None => Target::Document,
        Some("layer") => Target::Layer,
        Some("document") => Target::Document,
        Some(other) => return Err(bad(CMD, format!("`target` must be \"layer\" or \"document\", not \"{other}\""))),
    };
    let (w, h) = match (target, open) {
        (Target::Layer, None) => return Err(EngineError::NoDocument),
        (Target::Layer, Some((_, _, _, false))) => {
            return Err(EngineError::Disabled(CMD.into(), "Generative AI needs an RGB, CMYK, Lab or Grayscale document".into()));
        }
        (Target::Layer, Some((w, h, _, _))) => {
            if p.get("width").is_some_and(|v| !v.is_null()) || p.get("height").is_some_and(|v| !v.is_null()) {
                return Err(bad(CMD, "a generated layer is document-sized; `width` and `height` are for \"target\":\"document\""));
            }
            (w, h)
        }
        (Target::Document, open) => {
            let (dw, dh) = open.map_or((1024, 1024), |(w, h, _, _)| (w.clamp(16, 8192), h.clamp(16, 8192)));
            (size_param(p, "width", dw)?, size_param(p, "height", dh)?)
        }
    };
    // A new document takes the open one's resolution where `file.new` accepts it: an imported
    // file can hold 0, NaN or more than 30,000 ppi, and the apply step runs after billing.
    let dpi = open.map(|(_, _, dpi, _)| f64::from(dpi)).filter(|d| d.is_finite() && *d > 0.0).map_or(72.0, |d| d.clamp(1.0, MAX_RESOLUTION));
    let transparent = transparent(p)?;
    let prompt = prompt(CMD, p, None)?;
    let (backend, choice) = prepare(s, CMD, p, ModelKind::Image)?;
    let rect = Rect::from_xywh(0, 0, w, h);
    crate::allocation::check_dense(rect, 16, "Generate Image")?;
    // The layer takes the document's format; a new document is RGB 8-bit.
    let format = match target {
        Target::Layer => s.active().map_or(PixelFormat::RGBA8, |d| layer_format(&d.doc)),
        Target::Document => PixelFormat::RGBA8,
    };
    let (aw, ah) = region::fit_within(w, h, SEND_MAX_EDGE);
    let req = ImageGen { choice, prompt: prompt.clone(), width: aw, height: ah, transparent };
    crate::jobs::run(
        s,
        "Generate Image",
        target == Target::Layer,
        move |ctx| {
            ctx.progress(0.0, "Generating");
            let answer = call(ctx, |cancelled| backend.generate_image(&req, cancelled))?;
            check_answer(&answer, aw, ah)?;
            layer_surface(&region::resize_rgba8(&answer, w, h), rect, format)
        },
        move |s, surface| match target {
            Target::Layer => {
                let ids = s.edit("Generate Image", |doc, active| {
                    let name = doc.next_layer_name("Generated");
                    insert_layers(doc, active, None, vec![(name, surface)])
                })?;
                Ok(json!({ "layer": ids.first().map(|id| id.0) }))
            }
            Target::Document => {
                let created = s.execute(
                    "file.new",
                    json!({"width": w, "height": h, "background": "transparent", "resolution": dpi, "name": document_name(&prompt), "mode": "rgb", "depth": 8}),
                )?;
                let id = s.edit("Generate Image", |doc, active| {
                    let id = active.or_else(|| doc.layers.first().map(|l| l.id)).ok_or(EngineError::Other("the new document has no layer".into()))?;
                    let l = doc.layer_mut(id).ok_or(EngineError::NoLayer(id))?;
                    l.name = "Generated".into();
                    let px = crate::pixels_mut(l)?;
                    *px = if px.format() == surface.format() { surface } else { surface.try_convert(px.format())? };
                    // The prompt becomes the document's description (File › File Info).
                    let xmp = crate::file_cmds::write_file_info(doc.metadata.xmp.as_deref(), &json!({ "description": prompt }));
                    doc.metadata.xmp = Some(xmp.into());
                    *active = Some(id);
                    Ok(id)
                })?;
                Ok(json!({ "document": created.get("document").cloned().unwrap_or(Value::Null), "layer": id.0 }))
            }
        },
    )
}

fn enabled(s: &Session) -> std::result::Result<(), String> {
    has_backend(s)
}

pub(super) fn specs() -> Vec<CommandSpec> {
    vec![CommandSpec {
        id: CMD,
        label: "Generate Image…",
        menu: &[],
        shortcut: None,
        params: r##"{"prompt":str,"target":"layer|document" (default layer with a document open, else document),"width":16..8192?,"height":16..8192? (a new document's size; default the open document's or 1024),"transparent":bool=false,"provider":"openai|gemini"?,"model":str?} → {layer}|{document,layer} (sends the prompt to the AI provider; the image covers the size, cropped, never stretched; a layer "Generated N" above the active one, or a new RGB document whose description is the prompt; one step "Generate Image")"##,
        enabled,
        run,
        journal: true,
    }]
}
