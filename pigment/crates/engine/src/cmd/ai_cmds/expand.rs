//! Generative Expand: grow the canvas (as Image › Canvas Size with a transparent extension) and
//! fill the transparent area of the composite, in one step. Without a larger size it fills the
//! transparent area the canvas already has (JS behaviour).

use photocraft_doc::Document;
use serde_json::{Value, json};

use super::{
    bad, check_keys, composite_rgba8, generative_error, has_backend, insert_layers, layer_format, layer_surface, layered_doc, prepare, prompt, region,
};
use crate::commands::CommandSpec;
use crate::generative::{ModelKind, kind};
use crate::{EngineError, Result, Session};

const CMD: &str = "ai.generativeExpand";

/// The prompt when none is given (JS `lastExpandPrompt`'s default).
pub const DEFAULT_PROMPT: &str = "Continue the image naturally into the empty area, matching its style, lighting and perspective.";

/// Image › Canvas Size's anchors, and the short compass names.
fn anchor(p: &Value) -> Result<&'static str> {
    const NAMES: [(&str, &str); 9] = [
        ("topLeft", "nw"),
        ("top", "n"),
        ("topRight", "ne"),
        ("left", "w"),
        ("center", "c"),
        ("right", "e"),
        ("bottomLeft", "sw"),
        ("bottom", "s"),
        ("bottomRight", "se"),
    ];
    match p.get("anchor") {
        None | Some(Value::Null) => Ok("center"),
        Some(Value::String(a)) => {
            NAMES.iter().find(|(long, short)| a == long || a == short).map(|(long, _)| *long).ok_or_else(|| {
                bad(CMD, "`anchor` must be one of topLeft|top|topRight|left|center|right|bottomLeft|bottom|bottomRight (or nw|n|ne|w|c|e|sw|s|se)")
            })
        }
        Some(_) => Err(bad(CMD, "`anchor` must be text")),
    }
}

/// A new side: at least the current one, at most Canvas Size's limit.
fn side(p: &Value, key: &str, current: u32) -> Result<u32> {
    match p.get(key) {
        None | Some(Value::Null) => Ok(current),
        Some(v) => {
            let n = v.as_f64().filter(|f| f.is_finite()).ok_or_else(|| bad(CMD, format!("`{key}` must be a number of pixels")))?.round();
            if n < f64::from(current) {
                return Err(bad(CMD, format!("`{key}` must be at least the document's {key} ({current} px)")));
            }
            if n > 300_000.0 {
                return Err(bad(CMD, format!("`{key}` must be at most 300000 px")));
            }
            Ok(n as u32)
        }
    }
}

/// `doc` with its canvas grown to `w` × `h` exactly as Image › Canvas Size grows it (transparent
/// extension; an opaque Background becomes a normal layer), and the offset of the old canvas.
fn grow(doc: &Document, w: u32, h: u32, anchor: &str) -> Result<(Document, i32, i32)> {
    let mut scratch = Session::new();
    scratch.add_document(doc.clone(), None);
    let r = scratch.execute("image.canvasSize", json!({"width": w, "height": h, "anchor": anchor, "extensionColor": "transparent"}))?;
    let offset = |i: usize| r.get("offset").and_then(|o| o.get(i)).and_then(Value::as_i64).unwrap_or(0) as i32;
    let grown = scratch.active().ok_or(EngineError::NoDocument)?.doc.as_ref().clone();
    Ok((grown, offset(0), offset(1)))
}

fn run(s: &mut Session, p: &Value) -> Result<Value> {
    check_keys(CMD, p, &["width", "height", "anchor", "prompt", "provider", "model"])?;
    let doc = layered_doc(s).map_err(|why| EngineError::Disabled(CMD.into(), why))?;
    let (ow, oh) = (doc.size.width, doc.size.height);
    let (w, h) = (side(p, "width", ow)?, side(p, "height", oh)?);
    let anchor = anchor(p)?;
    let prompt = prompt(CMD, p, Some(DEFAULT_PROMPT))?;
    let (backend, choice) = prepare(s, CMD, p, ModelKind::Image)?;
    crate::allocation::check_dense(photocraft_geom::Rect::from_xywh(0, 0, w, h), 24, "Generative Expand")?;
    let doc = s.active().ok_or(EngineError::NoDocument)?.doc.clone();
    crate::jobs::run(
        s,
        "Generative Expand",
        true,
        move |ctx| {
            ctx.progress(0.0, "Preparing");
            let grown = if (w, h) != (ow, oh) { Some(grow(&doc, w, h, anchor)?) } else { None };
            let target = grown.as_ref().map_or(doc.as_ref(), |(g, _, _)| g);
            let canvas = target.bounds();
            let original = composite_rgba8(target, canvas, ctx)?;
            let cov = region::transparent_area_mask(&original);
            if cov.iter().all(|c| *c <= 0.0) {
                return Err(generative_error(
                    kind::DOCUMENT,
                    "Nothing to expand: enter a larger size, or enlarge the canvas with a transparent extension (Image › Canvas Size)",
                ));
            }
            let mut images = super::fill::fill_layers(&*backend, &choice, &prompt, &original, &cov, 1, ctx)?;
            let image = images.pop().ok_or_else(|| generative_error(kind::BAD_RESPONSE, "The AI provider returned no image"))?;
            let surface = layer_surface(&image, canvas, layer_format(target))?;
            Ok((grown, surface))
        },
        move |s, (grown, surface)| {
            let offset = grown.as_ref().map(|(_, dx, dy)| (*dx, *dy));
            if let Some((dx, dy)) = offset {
                // The Color Sampler points move with the pixels, as Canvas Size moves them.
                s.set_sampler_map(photocraft_geom::Affine::translate(f64::from(dx), f64::from(dy)));
            }
            let ids = s.edit("Generative Expand", move |doc, active| {
                if let Some((g, _, _)) = grown {
                    *doc = g;
                }
                insert_layers(doc, active, None, vec![("Generative Expand".to_string(), surface)])
            })?;
            let d = s.active().ok_or(EngineError::NoDocument)?;
            let (dx, dy) = offset.unwrap_or((0, 0));
            Ok(json!({ "layer": ids.first().map(|id| id.0), "width": d.doc.size.width, "height": d.doc.size.height, "offset": [dx, dy] }))
        },
    )
}

fn enabled(s: &Session) -> std::result::Result<(), String> {
    layered_doc(s)?;
    has_backend(s)
}

pub(super) fn specs() -> Vec<CommandSpec> {
    vec![CommandSpec {
        id: CMD,
        label: "Generative Expand…",
        menu: &[],
        shortcut: None,
        params: r##"{"width":int? (at least the document's; default unchanged),"height":int?,"anchor":"topLeft|top|topRight|left|center|right|bottomLeft|bottom|bottomRight"="center" (or nw|n|…|se),"prompt":str="Continue the image naturally into the empty area, matching its style, lighting and perspective.","provider":"openai|gemini"?,"model":str?} → {layer,width,height,offset} (grows the canvas with a transparent extension, as Canvas Size does, then sends the composite, its transparent area and the prompt to the AI provider; a new document-size layer holds the generated pixels in that area; one step; without a larger size it fills the transparent area the canvas has)"##,
        enabled,
        run,
        journal: true,
    }]
}
