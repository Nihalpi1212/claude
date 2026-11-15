//! Google Gemini: `POST /models/{model}:generateContent` for images (an image model answers with
//! `inlineData` parts), chat with function declarations and Describe; `GET /models` for the
//! catalog. Authorization: the `x-goog-api-key` header (never the `?key=` query, which would put
//! the key in URLs). The request shapes are JavaScript Pigment's (`providers.js`): the nearest
//! aspect ratio, `imageSize` 1K/2K/4K for gemini-3 models, `IMAGE` alone for gemini-3 and
//! `TEXT`+`IMAGE` for older models, an edit as the image plus a white-on-black mask and an
//! instruction.

use photocraft_engine::generative::{ChatMessage, ChatRequest, ChatTurn, ToolCall};
use photocraft_raster::Rgba8Image;
use serde_json::{Value, json};

use super::{EditRequest, ImageRequest, ModelInfo, ModelKind, Provider, ProviderConfig, call_json, clients, clip, nearest_ratio, ratio_of, state_provider};
use crate::cancel::Cancelled;
use crate::chat::{gemini_declaration, parse_args};
use crate::http::{Body, Http};
use crate::image_util::{base64_decode, base64_encode, decode, encode_png, white_mask};
use crate::keys::ApiKey;
use crate::{AiError, ErrorKind, ProviderId, Result};

/// The aspect ratios Gemini's image models take.
pub const RATIOS: [&str; 10] = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
/// The longest side an edit sends (JS `PROVIDERS.gemini.maxEdge`).
pub const MAX_EDGE: u32 = 2048;
/// What an edit with a mask adds to the prompt (JS `editImage`).
pub const MASK_INSTRUCTION: &str = "Edit the first image. The second image is a mask: change only the white area of the first image and keep everything outside it exactly as it is. Answer with the whole edited image, same framing and size.";

pub struct Gemini {
    cfg: ProviderConfig,
    key: ApiKey,
    http: Http,
    catalog: Http,
}

impl Gemini {
    pub fn new(cfg: ProviderConfig, key: ApiKey) -> Self {
        let (http, catalog) = clients(&cfg);
        Self { cfg, key, http, catalog }
    }

    fn headers(&self) -> Vec<(&'static str, String)> {
        vec![("x-goog-api-key", self.key.expose().to_string()), ("Accept", "application/json".into())]
    }

    fn generate(&self, model: &str, body: &Value, cancelled: Cancelled<'_>) -> Result<Value> {
        let body = Body::Json(serde_json::to_vec(body).unwrap_or_default());
        call_json(&self.http, &self.cfg, &self.key, self.headers(), &generate_path(model), body, cancelled)
    }
}

/// `/models/{model}:generateContent`, the model id percent-encoded where needed.
pub fn generate_path(model: &str) -> String {
    let enc: String = model
        .bytes()
        .map(|b| if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_') { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect();
    format!("/models/{enc}:generateContent")
}

fn is_gemini_3(model: &str) -> bool {
    model.starts_with("gemini-3")
}

/// Older image models answer only in TEXT+IMAGE mode; gemini-3 takes IMAGE alone.
pub fn modalities(model: &str) -> Value {
    if is_gemini_3(model) { json!(["IMAGE"]) } else { json!(["TEXT", "IMAGE"]) }
}

/// `imageSize` for a long edge, gemini-3 models only (JS `geminiImageSize`): over 2048 px 4K, over
/// 1024 px 2K, else 1K.
pub fn image_size(model: &str, long_edge: u32) -> Option<&'static str> {
    is_gemini_3(model).then_some(if long_edge > 2048 {
        "4K"
    } else if long_edge > 1024 {
        "2K"
    } else {
        "1K"
    })
}

fn image_config(model: &str, w: u32, h: u32) -> Value {
    let mut cfg = json!({ "responseModalities": modalities(model), "imageConfig": { "aspectRatio": nearest_ratio(w, h, &RATIOS) } });
    if let Some(size) = image_size(model, w.max(h)) {
        cfg["imageConfig"]["imageSize"] = json!(size);
    }
    cfg
}

fn inline(img: &Rgba8Image) -> Result<Value> {
    Ok(json!({ "inline_data": { "mime_type": "image/png", "data": base64_encode(&encode_png(img)?) } }))
}

/// The generateContent body for a new image.
pub fn image_body(model: &str, req: &ImageRequest) -> Value {
    json!({ "contents": [{ "role": "user", "parts": [{ "text": req.prompt }] }], "generationConfig": image_config(model, req.width, req.height) })
}

/// The generateContent body for an edit: the instruction, the (padded) image, then the mask as
/// white (may change) on black.
pub fn edit_body(model: &str, req: &EditRequest) -> Result<Value> {
    let text = if req.mask.is_some() { format!("{}\n\n{MASK_INSTRUCTION}", req.prompt) } else { req.prompt.clone() };
    let mut parts = vec![json!({ "text": text }), inline(&req.image)?];
    if let Some(mask) = &req.mask {
        parts.push(inline(&white_mask(mask))?);
    }
    Ok(json!({ "contents": [{ "role": "user", "parts": parts }], "generationConfig": image_config(model, req.image.width, req.image.height) }))
}

fn parts(v: &Value) -> Vec<Value> {
    v.pointer("/candidates/0/content/parts").and_then(Value::as_array).cloned().unwrap_or_default()
}

fn text_of(parts: &[Value]) -> String {
    parts.iter().filter(|p| p.get("thought").and_then(Value::as_bool) != Some(true)).filter_map(|p| p.get("text").and_then(Value::as_str)).collect()
}

/// A blocked prompt or a safety stop.
fn blocked(v: &Value) -> Option<AiError> {
    if let Some(r) = v.pointer("/promptFeedback/blockReason").and_then(Value::as_str) {
        return Some(AiError::new(ErrorKind::Safety, format!("Gemini blocked the request ({r}). Try a different prompt.")));
    }
    let reason = v.pointer("/candidates/0/finishReason").and_then(Value::as_str)?;
    matches!(reason, "SAFETY" | "PROHIBITED_CONTENT" | "BLOCKLIST" | "SPII" | "IMAGE_SAFETY" | "RECITATION" | "IMAGE_PROHIBITED_CONTENT")
        .then(|| AiError::new(ErrorKind::Safety, format!("Gemini stopped the answer ({reason}). Try a different prompt.")))
}

/// The first image of a generateContent answer, decoded.
pub fn parse_image(v: &Value) -> Result<Rgba8Image> {
    if let Some(e) = blocked(v) {
        return Err(e);
    }
    let parts = parts(v);
    for p in &parts {
        let Some(d) = p.get("inlineData").or_else(|| p.get("inline_data")) else { continue };
        let Some(data) = d.get("data").and_then(Value::as_str) else { continue };
        return decode(&base64_decode(data).ok_or_else(|| AiError::bad_response("Gemini sent an image that isn't valid base64."))?);
    }
    let text = text_of(&parts);
    let reason = v.pointer("/candidates/0/finishReason").and_then(Value::as_str).filter(|r| *r != "STOP");
    Err(AiError::bad_response(if !text.trim().is_empty() {
        format!("The model answered with text instead of an image: {}", clip(text.trim(), 300))
    } else if let Some(r) = reason {
        format!("The model returned no image ({r}).")
    } else {
        "The model returned no image.".to_string()
    }))
}

/// The `contents` for a chat history. A turn this provider produced goes back verbatim (thought
/// signatures included) and its tool results as `functionResponse` parts; another provider's turn
/// and results go back as text.
pub fn contents(messages: &[ChatMessage]) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    let mut native_turn = false;
    for m in messages {
        match m {
            ChatMessage::User { text, images } => {
                let mut parts = Vec::new();
                if !text.is_empty() {
                    parts.push(json!({ "text": text }));
                }
                for img in images {
                    parts.push(inline(img)?);
                }
                if parts.is_empty() {
                    parts.push(json!({ "text": "" }));
                }
                out.push(json!({ "role": "user", "parts": parts }));
                native_turn = false;
            }
            ChatMessage::Assistant { text } => {
                out.push(json!({ "role": "model", "parts": [{ "text": text }] }));
                native_turn = false;
            }
            ChatMessage::Turn(t) => {
                native_turn = state_provider(&t.provider_state) == Some(ProviderId::Gemini);
                if native_turn {
                    let parts = t.provider_state.get("parts").cloned().unwrap_or_else(|| json!([]));
                    out.push(json!({ "role": "model", "parts": parts }));
                } else {
                    let calls: Vec<String> = t.tool_calls.iter().map(|c| format!("{}({})", c.name, c.arguments)).collect();
                    let text = if calls.is_empty() { t.text.clone() } else { format!("{}\n[called {}]", t.text, calls.join(", ")).trim().to_string() };
                    out.push(json!({ "role": "model", "parts": [{ "text": text }] }));
                }
            }
            ChatMessage::ToolResults(results) if native_turn => {
                let parts: Vec<Value> =
                    results.iter().map(|r| json!({ "functionResponse": { "name": r.name, "response": { "result": r.output } } })).collect();
                out.push(json!({ "role": "user", "parts": parts }));
            }
            ChatMessage::ToolResults(results) => {
                let list: Vec<Value> = results.iter().map(|r| json!({ "tool": r.name, "result": r.output })).collect();
                out.push(json!({ "role": "user", "parts": [{ "text": format!("Tool results: {}", Value::Array(list)) }] }));
            }
        }
    }
    Ok(out)
}

/// The generateContent body for one chat round.
pub fn chat_body(req: &ChatRequest) -> Result<Value> {
    let mut body = json!({ "contents": contents(&req.messages)? });
    if !req.instructions.is_empty() {
        body["systemInstruction"] = json!({ "parts": [{ "text": req.instructions }] });
    }
    if !req.tools.is_empty() {
        let decls: Vec<Value> = req.tools.iter().map(|t| gemini_declaration(&t.name, &t.description, &t.parameters)).collect();
        body["tools"] = json!([{ "functionDeclarations": decls }]);
    }
    Ok(body)
}

/// One chat round's answer: the text (thoughts left out), the function calls, and the parts to
/// send back verbatim.
pub fn parse_turn(v: &Value) -> Result<ChatTurn> {
    if let Some(e) = v.get("error").filter(|e| e.is_object()) {
        let msg = e.get("message").and_then(Value::as_str).unwrap_or("The model request failed");
        return Err(AiError::bad_response(format!("Gemini: {}", clip(msg, 300))));
    }
    if let Some(e) = blocked(v) {
        return Err(e);
    }
    let parts = parts(v);
    let text = text_of(&parts);
    let tool_calls: Vec<ToolCall> = parts
        .iter()
        .filter_map(|p| p.get("functionCall"))
        .enumerate()
        .filter_map(|(i, c)| {
            let name = c.get("name").and_then(Value::as_str)?;
            let id = c.get("id").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("gemini-call-{i}"));
            let args = c.get("args").filter(|a| a.is_object()).map(parse_args).unwrap_or_else(|| json!({}));
            Some(ToolCall { id, name: name.to_string(), arguments: args })
        })
        .collect();
    Ok(ChatTurn { text, tool_calls, provider_state: json!({ "provider": "gemini", "parts": parts }) })
}

/// What kind of model a Gemini model is (JS `geminiKind`).
pub fn model_kind(m: &Value) -> ModelKind {
    let name = m.get("name").and_then(Value::as_str).unwrap_or_default().trim_start_matches("models/").to_ascii_lowercase();
    let methods: Vec<&str> = m.get("supportedGenerationMethods").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
    if name.contains("image") || name.contains("imagen") {
        ModelKind::Image
    } else if methods.contains(&"generateContent") && !["embedding", "aqa", "tts", "audio", "veo", "live"].iter().any(|w| name.contains(w)) {
        ModelKind::Chat
    } else {
        ModelKind::Other
    }
}

/// The `GET /models` answer.
pub fn parse_models(v: &Value) -> Vec<ModelInfo> {
    let mut out: Vec<ModelInfo> = v
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let id = m.get("name").and_then(Value::as_str)?.trim_start_matches("models/");
            (!id.is_empty()).then(|| ModelInfo { id: id.to_string(), kind: model_kind(m) })
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out.dedup_by(|a, b| a.id == b.id);
    out
}

impl Provider for Gemini {
    fn id(&self) -> ProviderId {
        ProviderId::Gemini
    }

    fn config(&self) -> &ProviderConfig {
        &self.cfg
    }

    fn max_edge(&self) -> u32 {
        MAX_EDGE
    }

    fn edit_frame(&self, _model: &str, w: u32, h: u32) -> (f64, [u8; 4]) {
        (ratio_of(nearest_ratio(w, h, &RATIOS)), [255, 255, 255, 255])
    }

    fn native_transparency(&self, _model: &str) -> bool {
        false
    }

    fn generate_image(&self, model: &str, req: &ImageRequest, cancelled: Cancelled<'_>) -> Result<Rgba8Image> {
        parse_image(&self.generate(model, &image_body(model, req), cancelled)?)
    }

    fn edit_image(&self, model: &str, req: &EditRequest, cancelled: Cancelled<'_>) -> Result<Rgba8Image> {
        parse_image(&self.generate(model, &edit_body(model, req)?, cancelled)?)
    }

    fn chat(&self, model: &str, req: &ChatRequest, cancelled: Cancelled<'_>) -> Result<ChatTurn> {
        parse_turn(&self.generate(model, &chat_body(req)?, cancelled)?)
    }

    fn list_models(&self, cancelled: Cancelled<'_>) -> Result<Vec<ModelInfo>> {
        Ok(parse_models(&call_json(&self.catalog, &self.cfg, &self.key, self.headers(), "/models?pageSize=200", Body::None, cancelled)?))
    }
}
