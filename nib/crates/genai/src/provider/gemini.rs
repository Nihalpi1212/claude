//! Google Gemini: `POST /models/{model}:generateContent` for text, JSON and images (an image model
//! answers with `inlineData` parts), `GET /models` for the catalog. Authorization: the
//! `x-goog-api-key` header (never the `?key=` query, which would put the key in URLs).

use serde_json::{Value, json};

use super::{
    EditRequest, ImageData, ImageRequest, InputImage, ModelInfo, ModelKind, Provider, ProviderConfig, ProviderKind, TextRequest, check,
    nearest_ratio, parse_json,
};
use crate::http::{Body, Http, Request};
use crate::keys::ApiKey;
use crate::{AiError, CancelToken, ErrorKind, Result};

/// The aspect ratios Gemini's image models take.
pub const RATIOS: [&str; 10] = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

pub struct Gemini {
    cfg: ProviderConfig,
    key: ApiKey,
    http: Http,
}

impl Gemini {
    pub fn new(cfg: ProviderConfig, key: ApiKey) -> Self {
        let http = Http::new(&cfg.base_url, cfg.timeout, cfg.max_response_bytes);
        Self { cfg, key, http }
    }

    fn call(&self, path: &str, body: Option<&Value>, cancel: &CancelToken) -> Result<Value> {
        let req = Request {
            post: body.is_some(),
            url: self.cfg.url(path),
            headers: vec![("x-goog-api-key", self.key.expose().to_string()), ("Accept", "application/json".into())],
            body: match body {
                Some(v) => Body::Json(serde_json::to_vec(v).unwrap_or_default()),
                None => Body::None,
            },
        };
        let resp = self.http.send(req, cancel)?;
        parse_json(&check(ProviderKind::Gemini, resp, &self.key)?)
    }

    fn generate(&self, model: &str, body: &Value, cancel: &CancelToken) -> Result<Value> {
        self.call(&generate_path(model), Some(body), cancel)
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

fn inline(img: &InputImage) -> Value {
    json!({ "inline_data": { "mime_type": img.mime, "data": vectorcraft_format::base64_encode(&img.bytes) } })
}

/// The generateContent body for text or JSON.
pub fn text_body(req: &TextRequest) -> Value {
    let mut parts = vec![json!({ "text": req.prompt })];
    parts.extend(req.images.iter().map(inline));
    let mut body = json!({ "contents": [{ "role": "user", "parts": parts }] });
    if !req.instructions.is_empty() {
        body["systemInstruction"] = json!({ "parts": [{ "text": req.instructions }] });
    }
    let mut config = serde_json::Map::new();
    if req.json {
        config.insert("responseMimeType".into(), json!("application/json"));
    }
    if let Some(n) = req.max_output_tokens {
        config.insert("maxOutputTokens".into(), json!(n));
    }
    if !config.is_empty() {
        body["generationConfig"] = Value::Object(config);
    }
    body
}

/// Older image models answer only in TEXT+IMAGE mode; gemini-3 takes IMAGE alone.
fn modalities(model: &str) -> Value {
    if model.starts_with("gemini-3") { json!(["IMAGE"]) } else { json!(["TEXT", "IMAGE"]) }
}

fn image_config(model: &str, w: u32, h: u32) -> Value {
    json!({ "responseModalities": modalities(model), "imageConfig": { "aspectRatio": nearest_ratio(w, h, &RATIOS) } })
}

/// The generateContent body for a new image.
pub fn image_body(model: &str, req: &ImageRequest) -> Value {
    // Gemini has no transparent output: a plain white background is asked for, which the trace
    // leaves out.
    let text = if req.transparent {
        format!("{}\n\nDraw the subject alone on a plain pure white (#ffffff) background: no shadow, no floor, no frame.", req.prompt)
    } else {
        req.prompt.clone()
    };
    let mut parts = vec![json!({ "text": text })];
    parts.extend(req.references.iter().map(inline));
    json!({ "contents": [{ "role": "user", "parts": parts }], "generationConfig": image_config(model, req.width, req.height) })
}

/// The generateContent body for an edit: the image, then the mask as white (may change) on black.
pub fn edit_body(model: &str, req: &EditRequest) -> Result<Value> {
    let (w, h) = crate::image_util::png_size(&req.image).ok_or_else(|| AiError::bad_request("The image to edit is not a PNG."))?;
    let mut parts = vec![];
    match &req.mask {
        Some(mask) => {
            let text = format!(
                "{}\n\nEdit the first image. The second image is a mask: change only its white area, and keep everything in its black area exactly as it is. Answer with the whole edited image, with the same framing.",
                req.prompt
            );
            parts.push(json!({ "text": text }));
            parts.push(inline(&InputImage::png(req.image.clone())));
            parts.push(inline(&InputImage::png(crate::image_util::white_mask(mask)?)));
        }
        None => {
            parts.push(json!({ "text": req.prompt }));
            parts.push(inline(&InputImage::png(req.image.clone())));
        }
    }
    Ok(json!({ "contents": [{ "role": "user", "parts": parts }], "generationConfig": image_config(model, w, h) }))
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
        return Some(AiError::new(ErrorKind::Safety, format!("Gemini blocked the prompt ({r}). Try a different prompt.")));
    }
    let reason = v.pointer("/candidates/0/finishReason").and_then(Value::as_str)?;
    matches!(reason, "SAFETY" | "PROHIBITED_CONTENT" | "BLOCKLIST" | "SPII" | "IMAGE_SAFETY" | "RECITATION" | "IMAGE_PROHIBITED_CONTENT")
        .then(|| AiError::new(ErrorKind::Safety, format!("Gemini stopped the answer ({reason}). Try a different prompt.")))
}

/// The text of a generateContent answer.
pub fn parse_text(v: &Value) -> Result<String> {
    if let Some(e) = blocked(v) {
        return Err(e);
    }
    let text = text_of(&parts(v));
    if text.trim().is_empty() {
        let reason = v.pointer("/candidates/0/finishReason").and_then(Value::as_str).unwrap_or("no text");
        return Err(AiError::bad_response(format!("Gemini answered with no text ({reason}).")));
    }
    Ok(text)
}

/// The first image of a generateContent answer.
pub fn parse_image(v: &Value) -> Result<ImageData> {
    if let Some(e) = blocked(v) {
        return Err(e);
    }
    let parts = parts(v);
    for p in &parts {
        let Some(d) = p.get("inlineData").or_else(|| p.get("inline_data")) else { continue };
        let Some(data) = d.get("data").and_then(Value::as_str) else { continue };
        let mime = d.get("mimeType").or_else(|| d.get("mime_type")).and_then(Value::as_str).unwrap_or("image/png");
        let bytes = vectorcraft_format::base64_decode(data).ok_or_else(|| AiError::bad_response("Gemini sent an image that isn't valid base64."))?;
        return Ok(ImageData { mime: mime.to_string(), bytes });
    }
    let text = text_of(&parts);
    Err(if text.trim().is_empty() {
        AiError::bad_response("Gemini returned no image.")
    } else {
        AiError::bad_response(format!("Gemini answered with text instead of an image: {}", super::clip(text.trim(), 300)))
    })
}

/// What kind of model a Gemini model is.
pub fn model_kind(m: &Value) -> ModelKind {
    let name = m.get("name").and_then(Value::as_str).unwrap_or_default().trim_start_matches("models/").to_ascii_lowercase();
    let methods: Vec<&str> = m.get("supportedGenerationMethods").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
    if name.contains("image") || name.contains("imagen") {
        ModelKind::Image
    } else if methods.contains(&"generateContent") && !["embedding", "aqa", "tts", "audio", "veo", "live"].iter().any(|w| name.contains(w)) {
        ModelKind::Text
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
    fn kind(&self) -> ProviderKind {
        ProviderKind::Gemini
    }

    fn config(&self) -> &ProviderConfig {
        &self.cfg
    }

    fn generate_text(&self, req: &TextRequest, cancel: &CancelToken) -> Result<String> {
        parse_text(&self.generate(&self.cfg.text_model, &text_body(req), cancel)?)
    }

    fn generate_image(&self, req: &ImageRequest, cancel: &CancelToken) -> Result<ImageData> {
        let model = &self.cfg.image_model;
        parse_image(&self.generate(model, &image_body(model, req), cancel)?)
    }

    fn edit_image(&self, req: &EditRequest, cancel: &CancelToken) -> Result<ImageData> {
        let model = &self.cfg.image_model;
        parse_image(&self.generate(model, &edit_body(model, req)?, cancel)?)
    }

    fn list_models(&self, cancel: &CancelToken) -> Result<Vec<ModelInfo>> {
        Ok(parse_models(&self.call("/models?pageSize=200", None, cancel)?))
    }
}
