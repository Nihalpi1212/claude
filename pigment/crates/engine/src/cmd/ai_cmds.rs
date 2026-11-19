//! Pigment: generative AI commands. Generative Fill, Generative Expand, Generate Image, Remove
//! Background, Generate Background, Sky Replacement and Describe Image as ordinary engine
//! commands (`ai.*`), plus `ai.status` and `ai.testConnection`.
//!
//! They talk to a provider only through the installed [`GenerativeBackend`]
//! ([`crate::generative`]); without one they are disabled ("Generative AI is available in the
//! desktop app"), except `ai.status` and the local Remove Background.
//!
//! Every command follows the same rules (`docs/generative-ai.md`):
//!
//! - **Nothing is sent before the checks pass:** a backend, the person's one-time consent, a
//!   provider with a key for the kind of model, a prompt where one is needed, a document, layer
//!   or selection that suits. A refusal sends nothing and changes nothing.
//! - **The work runs as a job** ([`crate::jobs::run`]): on a worker thread when started in the
//!   background, with progress and Cancel; the document is locked while the request runs, and the
//!   result lands as **one undo step** named after the feature. A cancelled request's answer is
//!   dropped (the provider may still bill it).
//! - **The document's own pixels are never changed by a fill.** The answer lands as a new layer
//!   holding only the masked pixels (alpha = answer alpha × mask), so everything outside the mask
//!   stays exact.
//! - Images go out as sRGB 8-bit, at most [`SEND_MAX_EDGE`] pixels a side (the backend may scale
//!   further); answers are checked for size and scaled back to the region.
//! - **Never from an action.** A command that sends is not recorded into Actions
//!   ([`unrecorded`]) and is refused while an action, a batch, a droplet or an event's script
//!   plays ([`NOT_FROM_ACTIONS`]), whoever plays it: playing one never spends money.
//! - **The backend admits the caller** ([`GenerativeBackend::admit`]) before the job starts, with
//!   whether the session runs under an automation gate: agents and the command line opt in.

use std::sync::Arc;

use photocraft_color::PixelFormat;
use photocraft_doc::{Document, LayerId};
use photocraft_geom::Rect;
use photocraft_raster::{Rgba8Image, Surface};
use serde_json::Value;

use crate::commands::CommandSpec;
use crate::generative::{Choice, GenError, GenerativeBackend, ModelKind, ProviderId, kind};
use crate::jobs::JobCtx;
use crate::{EngineError, Result, Session};

mod background;
mod describe;
mod expand;
mod fill;
mod generate;
pub mod region;
#[cfg(test)]
mod tests;

/// The longest side of an image sent to a backend. Providers take at most 1536 (OpenAI) or 2048
/// (Gemini) pixels; the backend scales further where its provider needs it.
pub const SEND_MAX_EDGE: u32 = 2048;
/// The largest region a fill sends (JS `fillRegion`'s cap, before a larger selection widens it).
pub const FILL_REGION_MAX: u32 = 1536;
/// Generative Expand's largest side: Image › Canvas Size's limit.
pub const EXPAND_MAX_SIDE: u32 = 300_000;
/// Describe Image's answer is cut to this many characters, an ellipsis included (as the
/// Assistant cuts its answers), so the window, an agent and the document's description get a text
/// of a sensible size whatever the provider sent.
pub const DESCRIBE_LIMIT: usize = 20_000;
/// Prompts are cut to this many characters (JS `PROMPT_LIMIT`).
pub const PROMPT_LIMIT: usize = 4000;
/// Why the provider commands are disabled when no backend is installed.
pub const NO_BACKEND: &str = "Generative AI is available in the desktop app";

/// Every command id this module registers.
pub const COMMANDS: &[&str] = &[
    "ai.generativeFill",
    "ai.generativeExpand",
    "ai.generateImage",
    "ai.removeBackground",
    "ai.replaceBackground",
    "ai.replaceSky",
    "ai.describe",
    "ai.status",
    "ai.testConnection",
];

/// Why a command that sends is refused while an action or an event's script plays.
pub const NOT_FROM_ACTIONS: &str = "AI commands that send to your AI provider do not run from an action, a batch, a droplet or a script event, so playing one never spends money. Run the command itself.";

/// Whether a journal entry stays out of a recorded action: every command that may send
/// ([`may_send`]), so playing an action (or a batch, or a droplet) never calls a provider by
/// surprise. The local Remove Background sends nothing and is recorded, as PhotoCraft's own is.
pub fn unrecorded(id: &str, params: &Value) -> bool {
    may_send(id, params)
}

/// Whether running `id` with `params` may send something to an AI provider (and so be billed):
/// the gate agents and the command line ask before letting a caller run it. `ai.status` and the
/// local Remove Background never do.
pub fn may_send(id: &str, params: &Value) -> bool {
    match id {
        "ai.status" => false,
        "ai.removeBackground" => params.get("method").and_then(Value::as_str) == Some("provider"),
        _ => id.starts_with("ai."),
    }
}

// ---------------------------------------------------------------- shared checks

fn generative_error(kind: &'static str, message: impl Into<String>) -> EngineError {
    EngineError::Generative { kind, message: message.into() }
}

fn bad(cmd: &str, msg: impl Into<String>) -> EngineError {
    EngineError::BadParams { cmd: cmd.into(), msg: msg.into() }
}

/// The installed backend, or the refusal every provider command gives without one.
fn backend(s: &Session) -> Result<Arc<dyn GenerativeBackend>> {
    s.generative().ok_or_else(|| generative_error(kind::UNAVAILABLE, NO_BACKEND))
}

fn has_backend(s: &Session) -> std::result::Result<(), String> {
    s.generative().map(|_| ()).ok_or_else(|| NO_BACKEND.to_string())
}

/// A document open in a mode that takes layers (RGB, CMYK, Lab, Grayscale).
fn layered_doc(s: &Session) -> std::result::Result<&Document, String> {
    let d = s.active().ok_or("no document open")?;
    if !crate::layer_copy_cmds::layered(d.doc.mode) {
        return Err("Generative AI needs an RGB, CMYK, Lab or Grayscale document".into());
    }
    Ok(&d.doc)
}

/// The selection's bounds within the canvas, if it selects anything there.
fn selection_bounds(doc: &Document) -> Option<Rect> {
    let b = doc.selection.as_ref()?.content_bounds().intersect(&doc.bounds());
    (!b.is_empty()).then_some(b)
}

/// Refuse keys a command does not take: a misspelt `"promt"` must not run a billed request on
/// the defaults. `coalesce` and `target` are accepted by every command.
fn check_keys(cmd: &str, p: &Value, keys: &[&str]) -> Result<()> {
    let Some(map) = p.as_object() else { return Ok(()) };
    for k in map.keys() {
        if !keys.contains(&k.as_str()) && !["coalesce", "target"].contains(&k.as_str()) {
            return Err(bad(cmd, format!("unknown key `{k}`; it takes {}", keys.join(", "))));
        }
    }
    Ok(())
}

/// The `provider` and `model` params.
fn choice(cmd: &str, p: &Value) -> Result<Choice> {
    let provider = match p.get("provider") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(ProviderId::parse(s).ok_or_else(|| bad(cmd, format!("unknown provider \"{s}\"; use \"openai\" or \"gemini\"")))?),
        Some(_) => return Err(bad(cmd, "`provider` must be \"openai\" or \"gemini\"")),
    };
    let model = match p.get("model") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Some(_) => return Err(bad(cmd, "`model` must be a model id")),
    };
    Ok(Choice { provider, model })
}

/// The `prompt` param, trimmed and cut to [`PROMPT_LIMIT`] characters; `default` when missing or
/// empty, or the "Enter a prompt" refusal when there is none.
fn prompt(cmd: &str, p: &Value, default: Option<&str>) -> Result<String> {
    let text = match p.get("prompt") {
        None | Some(Value::Null) => "",
        Some(Value::String(s)) => s.trim(),
        Some(_) => return Err(bad(cmd, "`prompt` must be text")),
    };
    let text = if text.is_empty() { default.unwrap_or("") } else { text };
    if text.is_empty() {
        return Err(generative_error(kind::BAD_REQUEST, "Enter a prompt that describes what to generate"));
    }
    Ok(text.chars().take(PROMPT_LIMIT).collect())
}

/// The installed backend, for a command that is about to send. Refused while an action (also a
/// batch's or a droplet's) or an event's script plays, whoever started it: nobody watches each
/// step of one, and an action can come from a file or from an agent. Then the backend admits the
/// caller ([`GenerativeBackend::admit`]), asked here, on the calling thread, with whether the
/// session runs under an automation gate, so a command an agent reaches through another one (a
/// script's step) is held to the same rule as the agent's own request.
fn admitted(s: &Session) -> Result<Arc<dyn GenerativeBackend>> {
    let b = backend(s)?;
    if s.actions.playing > 0 || s.file_menu.firing {
        return Err(generative_error(kind::NOT_ALLOWED, NOT_FROM_ACTIONS));
    }
    b.admit(s.authorize.is_some())?;
    Ok(b)
}

/// The backend and the choice a request goes out with, after the checks every provider command
/// makes before sending: a backend that admits the caller, consent and a provider that fits
/// `kind`.
fn prepare(s: &Session, cmd: &str, p: &Value, kind: ModelKind) -> Result<(Arc<dyn GenerativeBackend>, Choice)> {
    let b = admitted(s)?;
    let mut choice = choice(cmd, p)?;
    choice.provider = Some(crate::generative::resolve_provider(&b.status(), &choice, kind)?);
    Ok((b, choice))
}

/// Run one backend call under the job's cancel flag. A call that answers after Cancel is
/// dropped.
fn call<T>(ctx: &JobCtx, f: impl FnOnce(&dyn Fn() -> bool) -> std::result::Result<T, GenError>) -> Result<T> {
    let cancelled = || ctx.cancelled();
    let r = f(&cancelled).map_err(EngineError::from)?;
    if ctx.cancelled() {
        return Err(EngineError::Cancelled);
    }
    Ok(r)
}

/// The layer's pixel mask over `r` as the compositor draws it on `canvas`: density and feather
/// applied (`LayerMask::values_into` leaves the feather out), all ones without an enabled mask.
/// The vector mask is left out.
fn mask_shown(layer: &photocraft_doc::Layer, canvas: Rect, r: Rect, out: &mut Vec<f32>) {
    match &layer.mask {
        Some(m) if m.enabled && photocraft_compose::masks::feather_sigma(m.feather) > 0.0 => {
            let mut mask_only = layer.clone();
            mask_only.vector_mask = None;
            match photocraft_compose::masks::combined_mask(&mask_only, canvas) {
                Some(soft) => soft.read_region_into(r, out),
                None => m.values_into(r, out),
            }
        }
        Some(m) => m.values_into(r, out),
        None => {
            out.clear();
            out.resize(r.width() as usize * r.height() as usize, 1.0);
        }
    }
}

/// Refuse an answer that is not the size asked for.
fn check_answer(img: &Rgba8Image, w: u32, h: u32) -> Result<()> {
    if img.width != w || img.height != h || img.pixels.len() != w as usize * h as usize * 4 {
        return Err(generative_error(
            kind::BAD_RESPONSE,
            format!("The AI provider returned an image of the wrong size ({} × {} px, {w} × {h} px expected); nothing was changed", img.width, img.height),
        ));
    }
    Ok(())
}

/// The composite of `doc` over `rect` as sRGB 8-bit, rendered in bands so no full-size float
/// buffer is held; stops between bands when the job is cancelled.
fn composite_rgba8(doc: &Document, rect: Rect, ctx: &JobCtx) -> Result<Rgba8Image> {
    const BAND: i32 = 256;
    let mut img = Rgba8Image::new(rect.width(), rect.height());
    let row = rect.width() as usize * 4;
    let mut y = rect.y0;
    while y < rect.y1 {
        ctx.check()?;
        let band = Rect::new(rect.x0, y, rect.x1, (y + BAND).min(rect.y1));
        let px = photocraft_compose::render(doc, band).to_rgba8();
        let at = (y - rect.y0) as usize * row;
        if let Some(dst) = img.pixels.get_mut(at..at + px.pixels.len()) {
            dst.copy_from_slice(&px.pixels);
        }
        y = band.y1;
    }
    Ok(img)
}

/// A layer surface in `target` holding `img` at `at` (document pixels).
fn layer_surface(img: &Rgba8Image, at: Rect, target: PixelFormat) -> Result<Surface> {
    crate::allocation::checkpoint("a generated layer")?;
    let s = Surface::from_interleaved(PixelFormat::RGBA8, at, &img.pixels);
    let mut s = if s.format() == target { s } else { s.try_convert(target)? };
    s.prune();
    Ok(s)
}

/// The format a new layer of `doc` takes: the document's model and depth, with transparency.
fn layer_format(doc: &Document) -> PixelFormat {
    let f = doc.pixel_format();
    PixelFormat::new(f.mode, f.sample, true)
}

/// Insert raster layers holding `images` at `at`, the first above `anchor` (or the active
/// layer), each next one above the last; the last becomes active. Returns their ids.
fn insert_layers(doc: &mut Document, active: &mut Option<LayerId>, anchor: Option<LayerId>, layers: Vec<(String, Surface)>) -> Result<Vec<LayerId>> {
    let fmt = layer_format(doc);
    let mut ids = Vec::new();
    let mut prev = anchor.or(*active);
    for (i, (name, surface)) in layers.into_iter().enumerate() {
        let mut l = photocraft_doc::Layer::raster(name, fmt);
        *crate::pixels_mut(&mut l)? = surface;
        let place = if i == 0 { crate::layer_place::Place::AutoEditable } else { crate::layer_place::Place::Above };
        let id = crate::layer_place::insert_new(doc, prev, l, place);
        prev = Some(id);
        ids.push(id);
    }
    if let Some(last) = ids.last() {
        *active = Some(*last);
    }
    Ok(ids)
}

/// Every `ai.*` command.
pub fn specs() -> Vec<CommandSpec> {
    let mut v = Vec::new();
    v.extend(fill::specs());
    v.extend(expand::specs());
    v.extend(generate::specs());
    v.extend(background::specs());
    v.extend(describe::specs());
    v
}
