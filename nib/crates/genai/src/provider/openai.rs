//! OpenAI: text through the Responses API (`POST /responses`), images through the Images API
//! (`POST /images/generations`, and `POST /images/edits` with a mask or with reference images),
//! the catalog through `GET /models`. Authorization: `Bearer <key>`.

use serde_json::{Value, json};

use super::{
    EditRequest, ImageData, ImageRequest, ModelInfo, ModelKind, Provider, ProviderConfig, ProviderKind, TextRequest, check, nearest_ratio, parse_json,
};
use crate::http::{Body, Http, Multipart, Request};
use crate::keys::ApiKey;
use crate::{AiError, CancelToken, ErrorKind, Result};

pub struct OpenAi {
    cfg: ProviderConfig,
    key: ApiKey,
    http: Http,
}

impl OpenAi {
    pub fn new(cfg: ProviderConfig, key: ApiKey) -> Self {
        let http = Http::new(&cfg.base_url, cfg.timeout, cfg.max_response_bytes);
        Self { cfg, key, http }
    }

    fn call(&self, path: &str, body: Body, cancel: &CancelToken) -> Result<Value> {
        let req = Request {
            post: !matches!(body, Body::None),
            url: self.cfg.url(path),
            headers: vec![("Authorization", format!("Bearer {}", self.key.expose())), ("Accept", "application/json".into())],
            body,
        };
        let resp = self.http.send(req, cancel)?;
        parse_json(&check(ProviderKind::OpenAi, resp, &self.key)?)
    }
}

fn json_body(v: &Value) -> Body {
    Body::Json(serde_json::to_vec(v).unwrap_or_default())
}

fn data_url(img: &super::InputImage) -> String {
    format!("data:{};base64,{}", img.mime, vectorcraft_format::base64_encode(&img.bytes))
}

/// The `POST /responses` body.
pub fn text_body(model: &str, req: &TextRequest) -> Value {
    let mut content = vec![json!({ "type": "input_text", "text": req.prompt })];
    for img in &req.images {
        content.push(json!({ "type": "input_image", "image_url": data_url(img), "detail": "auto" }));
    }
    let mut body = json!({
        "model": model,
        "input": [{ "role": "user", "content": content }],
        // Nothing is kept on OpenAI's side for later turns.
        "store": false,
    });
    if !req.instructions.is_empty() {
        body["instructions"] = json!(req.instructions);
    }
    if req.json {
        body["text"] = json!({ "format": { "type": "json_object" } });
    }
    if let Some(n) = req.max_output_tokens {
        body["max_output_tokens"] = json!(n);
    }
    body
}

/// The text of a Responses API answer; a refusal or a content-filter stop is a safety error.
pub fn parse_text(v: &Value) -> Result<String> {
    if let Some(e) = v.get("error").filter(|e| e.is_object()) {
        let msg = e.get("message").and_then(Value::as_str).unwrap_or("The request failed");
        return Err(AiError::bad_response(format!("OpenAI: {}", super::clip(msg, 300))));
    }
    let output = v.get("output").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut text = String::new();
    for item in output.iter().filter(|it| it.get("type").and_then(Value::as_str) == Some("message")) {
        for c in item.get("content").and_then(Value::as_array).into_iter().flatten() {
            match c.get("type").and_then(Value::as_str) {
                Some("output_text") => text.push_str(c.get("text").and_then(Value::as_str).unwrap_or_default()),
                Some("refusal") => {
                    let why = c.get("refusal").and_then(Value::as_str).unwrap_or_default();
                    return Err(AiError::new(ErrorKind::Safety, format!("OpenAI declined: {}", super::clip(why, 300))));
                }
                _ => {}
            }
        }
    }
    if text.is_empty() {
        text = v.get("output_text").and_then(Value::as_str).unwrap_or_default().to_string();
    }
    let reason = v.pointer("/incomplete_details/reason").and_then(Value::as_str);
    if reason == Some("content_filter") {
        return Err(AiError::new(ErrorKind::Safety, "OpenAI stopped the answer for safety reasons. Try a different prompt."));
    }
    if text.trim().is_empty() {
        return Err(match reason {
            Some("max_output_tokens") => AiError::bad_response("OpenAI ran out of output tokens before answering. Ask for less detail."),
            _ => AiError::bad_response("OpenAI answered with no text."),
        });
    }
    Ok(text)
}

fn is_gpt_image(model: &str) -> bool {
    model.starts_with("gpt-image")
}

/// `background` and `input_fidelity` exist on gpt-image-1 and gpt-image-1.5.
fn is_gpt_image_1(model: &str) -> bool {
    model == "gpt-image-1" || model.starts_with("gpt-image-1-") || model.starts_with("gpt-image-1.5")
}

/// The size an image model is asked for: the accepted size nearest in shape to `w × h`.
pub fn image_size(model: &str, w: u32, h: u32) -> &'static str {
    if model.starts_with("dall-e-2") {
        "1024x1024"
    } else if model.starts_with("dall-e-3") {
        nearest_ratio(w, h, &["1024x1024", "1792x1024", "1024x1792"])
    } else {
        nearest_ratio(w, h, &["1024x1024", "1536x1024", "1024x1536"])
    }
}

/// The `POST /images/generations` body.
pub fn generation_body(model: &str, req: &ImageRequest) -> Value {
    let mut body = json!({ "model": model, "prompt": req.prompt, "n": 1, "size": image_size(model, req.width, req.height) });
    if is_gpt_image(model) {
        body["quality"] = json!("auto");
        body["output_format"] = json!("png");
        if is_gpt_image_1(model) {
            body["background"] = json!(if req.transparent { "transparent" } else { "auto" });
        }
    } else {
        body["response_format"] = json!("b64_json");
    }
    body
}

fn image_fields(form: &mut Multipart, model: &str, prompt: &str, size: &str) {
    form.text("model", model);
    form.text("prompt", prompt);
    form.text("n", "1");
    form.text("size", size);
    if is_gpt_image(model) {
        form.text("quality", "auto");
        form.text("output_format", "png");
        if is_gpt_image_1(model) {
            form.text("input_fidelity", "high");
        }
    } else {
        form.text("response_format", "b64_json");
    }
}

/// The `POST /images/edits` form for an edit through a mask.
pub(crate) fn edit_form(model: &str, req: &EditRequest) -> Result<Body> {
    if model.starts_with("dall-e-3") {
        return Err(AiError::bad_request("dall-e-3 can't edit images. Pick a gpt-image model in AI Accounts."));
    }
    let (w, h) = crate::image_util::png_size(&req.image).ok_or_else(|| AiError::bad_request("The image to edit is not a PNG."))?;
    let mut form = Multipart::new();
    image_fields(&mut form, model, &req.prompt, image_size(model, w, h));
    let field = if model.starts_with("dall-e-2") { "image" } else { "image[]" };
    form.file(field, "image.png", "image/png", &req.image);
    if let Some(mask) = &req.mask {
        form.file("mask", "mask.png", "image/png", mask);
    }
    Ok(form.finish())
}

/// The `POST /images/edits` form for a new image guided by reference images (no mask).
pub(crate) fn reference_form(model: &str, req: &ImageRequest) -> Result<Body> {
    if !is_gpt_image(model) {
        return Err(AiError::bad_request("A style reference needs a gpt-image model. Pick one in AI Accounts."));
    }
    let mut form = Multipart::new();
    image_fields(&mut form, model, &req.prompt, image_size(model, req.width, req.height));
    if is_gpt_image_1(model) {
        form.text("background", if req.transparent { "transparent" } else { "auto" });
    }
    for (i, r) in req.references.iter().enumerate() {
        form.file("image[]", &format!("reference{i}.png"), &r.mime, &r.bytes);
    }
    Ok(form.finish())
}

/// The image of an Images API answer.
pub fn parse_image(v: &Value) -> Result<ImageData> {
    let first = v.pointer("/data/0");
    match first.and_then(|d| d.get("b64_json")).and_then(Value::as_str) {
        Some(b64) => {
            let bytes =
                vectorcraft_format::base64_decode(b64).ok_or_else(|| AiError::bad_response("OpenAI sent an image that isn't valid base64."))?;
            Ok(ImageData { mime: "image/png".into(), bytes })
        }
        None if first.and_then(|d| d.get("url")).is_some() => {
            Err(AiError::bad_response("OpenAI returned a link instead of the image. Pick a gpt-image model in AI Accounts."))
        }
        None => Err(AiError::bad_response("OpenAI returned no image.")),
    }
}

/// What kind of model an OpenAI model id is.
pub fn model_kind(id: &str) -> ModelKind {
    let s = id.to_ascii_lowercase();
    if s.contains("image") || s.contains("dall-e") {
        ModelKind::Image
    } else if ["embed", "tts", "whisper", "transcri", "audio", "realtime", "moderation", "search", "babbage", "davinci", "instruct", "sora"]
        .iter()
        .any(|w| s.contains(w))
    {
        ModelKind::Other
    } else if s.starts_with("gpt") || s.starts_with("chatgpt") || (s.starts_with('o') && s.chars().nth(1).is_some_and(|c| c.is_ascii_digit())) {
        ModelKind::Text
    } else {
        ModelKind::Other
    }
}

/// The `GET /models` answer.
pub fn parse_models(v: &Value) -> Vec<ModelInfo> {
    let mut out: Vec<ModelInfo> = v
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|m| m.get("id").and_then(Value::as_str))
        .map(|id| ModelInfo { id: id.to_string(), kind: model_kind(id) })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out.dedup_by(|a, b| a.id == b.id);
    out
}

impl Provider for OpenAi {
    fn kind(&self) -> ProviderKind {
        ProviderKind::OpenAi
    }

    fn config(&self) -> &ProviderConfig {
        &self.cfg
    }

    fn generate_text(&self, req: &TextRequest, cancel: &CancelToken) -> Result<String> {
        let v = self.call("/responses", json_body(&text_body(&self.cfg.text_model, req)), cancel)?;
        parse_text(&v)
    }

    fn generate_image(&self, req: &ImageRequest, cancel: &CancelToken) -> Result<ImageData> {
        let model = &self.cfg.image_model;
        let v = if req.references.is_empty() {
            self.call("/images/generations", json_body(&generation_body(model, req)), cancel)?
        } else {
            self.call("/images/edits", reference_form(model, req)?, cancel)?
        };
        parse_image(&v)
    }

    fn edit_image(&self, req: &EditRequest, cancel: &CancelToken) -> Result<ImageData> {
        let v = self.call("/images/edits", edit_form(&self.cfg.image_model, req)?, cancel)?;
        parse_image(&v)
    }

    fn list_models(&self, cancel: &CancelToken) -> Result<Vec<ModelInfo>> {
        let v = self.call("/models", Body::None, cancel)?;
        Ok(parse_models(&v))
    }
}
