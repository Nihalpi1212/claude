//! OpenAI: images through the Images API (`POST /images/generations`, `POST /images/edits`), chat
//! and Describe through the Responses API (`POST /responses`, `store: false`), the catalog through
//! `GET /models`. Authorization: `Bearer <key>`. The request shapes are JavaScript Pigment's
//! (`providers.js`): the nearest accepted size, `background` and `input_fidelity` only for
//! gpt-image-1 and 1.5, `response_format: b64_json` for DALL·E, the mask with alpha 0 where the
//! image may change.

use photocraft_engine::generative::{ChatMessage, ChatRequest, ChatTurn, ToolCall};
use photocraft_raster::Rgba8Image;
use serde_json::{Value, json};

use super::{
    EditRequest, ImageRequest, ModelInfo, ModelKind, Provider, ProviderConfig, call_json, clients, clip, ratio_of, state_provider,
};
use crate::cancel::Cancelled;
use crate::chat::{parse_args, result_text};
use crate::http::{Body, Http, Multipart};
use crate::image_util::{base64_decode, base64_encode, decode, encode_png, openai_mask};
use crate::keys::ApiKey;
use crate::{AiError, ErrorKind, ProviderId, Result};

/// gpt-image models (and anything that is not DALL·E).
pub const GPT_IMAGE_SIZES: [&str; 3] = ["1024x1024", "1536x1024", "1024x1536"];
pub const DALLE3_SIZES: [&str; 3] = ["1024x1024", "1792x1024", "1024x1792"];
pub const DALLE2_SIZES: [&str; 3] = ["256x256", "512x512", "1024x1024"];
/// The longest side an edit sends (JS `PROVIDERS.openai.maxEdge`).
pub const MAX_EDGE: u32 = 1536;

pub struct OpenAi {
    cfg: ProviderConfig,
    key: ApiKey,
    http: Http,
    catalog: Http,
}

impl OpenAi {
    pub fn new(cfg: ProviderConfig, key: ApiKey) -> Self {
        let (http, catalog) = clients(&cfg);
        Self { cfg, key, http, catalog }
    }

    fn headers(&self) -> Vec<(&'static str, String)> {
        vec![("Authorization", format!("Bearer {}", self.key.expose())), ("Accept", "application/json".into())]
    }

    fn call(&self, path: &str, body: Body, cancelled: Cancelled<'_>) -> Result<Value> {
        call_json(&self.http, &self.cfg, &self.key, self.headers(), path, body, cancelled)
    }
}

fn json_body(v: &Value) -> Body {
    Body::Json(serde_json::to_vec(v).unwrap_or_default())
}

fn is_gpt_image(model: &str) -> bool {
    model.starts_with("gpt-image")
}

/// `background` and `input_fidelity` exist on gpt-image-1 and gpt-image-1.5 only (JS
/// `/^gpt-image-1(\.5)?(-|$)/`).
pub fn is_gpt_image_1(model: &str) -> bool {
    ["gpt-image-1", "gpt-image-1.5"].iter().any(|m| model == *m || model.strip_prefix(m).is_some_and(|rest| rest.starts_with('-')))
}

/// The sizes `model` accepts.
pub fn sizes_for(model: &str) -> &'static [&'static str] {
    if model.starts_with("dall-e-3") {
        &DALLE3_SIZES
    } else if model.starts_with("dall-e-2") {
        &DALLE2_SIZES
    } else {
        &GPT_IMAGE_SIZES
    }
}

/// The accepted size nearest in shape to `w × h` (JS `nearestOpenaiSize`); among sizes of the
/// same shape (DALL·E 2's squares) the smallest that holds the image's long edge, else the
/// largest.
pub fn nearest_size(w: u32, h: u32, sizes: &[&'static str]) -> &'static str {
    let r = (f64::from(w.max(1)) / f64::from(h.max(1))).ln();
    let edge = w.max(h);
    let mut best = sizes.first().copied().unwrap_or("1024x1024");
    let (mut best_d, mut best_edge) = (f64::INFINITY, 0u32);
    for s in sizes {
        let (sw, sh) = crate::image_util::parse_size(s).unwrap_or((1024, 1024));
        let d = (r - (f64::from(sw) / f64::from(sh)).ln()).abs();
        let e = sw.max(sh);
        let same = (d - best_d).abs() <= 1e-9;
        let better = d < best_d - 1e-9 || (same && ((e >= edge && (best_edge < edge || e < best_edge)) || (e < edge && best_edge < edge && e > best_edge)));
        if better {
            (best, best_d, best_edge) = (s, d, e);
        }
    }
    best
}

/// The size an image model is asked for.
pub fn image_size(model: &str, w: u32, h: u32) -> &'static str {
    nearest_size(w, h, sizes_for(model))
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

/// The `POST /images/edits` form: the text fields in order, then `image[]` (DALL·E 2: `image`) and
/// the mask.
pub(crate) fn edit_form(model: &str, req: &EditRequest) -> Result<Body> {
    if model.starts_with("dall-e-3") {
        return Err(AiError::bad_request("dall-e-3 cannot edit images; choose a gpt-image model (or dall-e-2) for this feature."));
    }
    let mut form = Multipart::new();
    form.text("model", model);
    form.text("prompt", &req.prompt);
    form.text("n", "1");
    form.text("size", image_size(model, req.image.width, req.image.height));
    if is_gpt_image(model) {
        form.text("output_format", "png");
        form.text("quality", "auto");
        if is_gpt_image_1(model) {
            form.text("input_fidelity", "high");
            form.text("background", if req.transparent { "transparent" } else { "auto" });
        }
    } else {
        form.text("response_format", "b64_json");
    }
    // dall-e-2 takes exactly one image under `image`; gpt-image models take a list under `image[]`.
    let field = if model.starts_with("dall-e-2") { "image" } else { "image[]" };
    form.file(field, "image.png", "image/png", &encode_png(&req.image)?);
    if let Some(mask) = &req.mask {
        form.file("mask", "mask.png", "image/png", &encode_png(&openai_mask(mask))?);
    }
    Ok(form.finish())
}

/// The image of an Images API answer, decoded.
pub fn parse_image(v: &Value) -> Result<Rgba8Image> {
    let first = v.pointer("/data/0");
    match first.and_then(|d| d.get("b64_json")).and_then(Value::as_str) {
        Some(b64) => decode(&base64_decode(b64).ok_or_else(|| AiError::bad_response("OpenAI sent an image that isn't valid base64."))?),
        None if first.and_then(|d| d.get("url")).is_some() => {
            Err(AiError::bad_response("The model returned a link instead of image data; choose a gpt-image model in Edit › AI Accounts…"))
        }
        None => Err(AiError::bad_response("The model returned no image.")),
    }
}

fn data_url(img: &Rgba8Image) -> Result<String> {
    Ok(format!("data:image/png;base64,{}", base64_encode(&encode_png(img)?)))
}

fn assistant_text(text: &str) -> Value {
    json!({ "role": "assistant", "content": [{ "type": "output_text", "text": text }] })
}

/// The `input` items for a chat history. A turn this provider produced goes back verbatim and its
/// tool results as `function_call_output`s; another provider's turn and results go back as text.
pub fn input_items(messages: &[ChatMessage]) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    let mut native_turn = false;
    for m in messages {
        match m {
            ChatMessage::User { text, images } => {
                let mut content = Vec::new();
                if !text.is_empty() {
                    content.push(json!({ "type": "input_text", "text": text }));
                }
                for img in images {
                    content.push(json!({ "type": "input_image", "image_url": data_url(img)?, "detail": "auto" }));
                }
                if content.is_empty() {
                    content.push(json!({ "type": "input_text", "text": "" }));
                }
                out.push(json!({ "role": "user", "content": content }));
                native_turn = false;
            }
            ChatMessage::Assistant { text } => {
                out.push(assistant_text(text));
                native_turn = false;
            }
            ChatMessage::Turn(t) => {
                native_turn = state_provider(&t.provider_state) == Some(ProviderId::OpenAi);
                if native_turn {
                    out.extend(t.provider_state.get("items").and_then(Value::as_array).cloned().unwrap_or_default());
                } else {
                    let calls: Vec<String> = t.tool_calls.iter().map(|c| format!("{}({})", c.name, c.arguments)).collect();
                    let text = if calls.is_empty() { t.text.clone() } else { format!("{}\n[called {}]", t.text, calls.join(", ")).trim().to_string() };
                    out.push(assistant_text(&text));
                }
            }
            ChatMessage::ToolResults(results) if native_turn => {
                for r in results {
                    out.push(json!({ "type": "function_call_output", "call_id": r.call_id, "output": result_text(&r.output) }));
                }
            }
            ChatMessage::ToolResults(results) => {
                let list: Vec<Value> = results.iter().map(|r| json!({ "tool": r.name, "result": r.output })).collect();
                out.push(json!({ "role": "user", "content": [{ "type": "input_text", "text": format!("Tool results: {}", Value::Array(list)) }] }));
            }
        }
    }
    Ok(out)
}

/// The `POST /responses` body for one chat round.
pub fn chat_body(model: &str, req: &ChatRequest) -> Result<Value> {
    let mut body = json!({ "model": model, "input": input_items(&req.messages)?, "store": false });
    if !req.instructions.is_empty() {
        body["instructions"] = json!(req.instructions);
    }
    if !req.tools.is_empty() {
        let tools: Vec<Value> = req
            .tools
            .iter()
            .map(|t| {
                let params = if t.parameters.is_null() { json!({ "type": "object", "properties": {} }) } else { t.parameters.clone() };
                json!({ "type": "function", "name": t.name, "description": t.description, "parameters": params, "strict": false })
            })
            .collect();
        body["tools"] = Value::Array(tools);
        body["tool_choice"] = json!("auto");
    }
    Ok(body)
}

/// An output item as it is sent back in the next round's input (JS `replayableItem`): messages
/// reduced to their text, function calls with their arguments as text, reasoning only with
/// encrypted content (never asked for, so in practice dropped).
fn replayable(it: &Value) -> Option<Value> {
    match it.get("type").and_then(Value::as_str) {
        Some("message") => {
            let parts: Vec<Value> = it
                .get("content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|c| c.get("type").and_then(Value::as_str) == Some("output_text"))
                .map(|c| json!({ "type": "output_text", "text": c.get("text").and_then(Value::as_str).unwrap_or_default() }))
                .collect();
            Some(json!({ "role": it.get("role").and_then(Value::as_str).unwrap_or("assistant"), "content": parts }))
        }
        Some("function_call") => {
            let args = match it.get("arguments") {
                Some(Value::String(s)) => s.clone(),
                Some(other) => other.to_string(),
                None => "{}".into(),
            };
            Some(json!({ "type": "function_call", "call_id": it.get("call_id"), "name": it.get("name"), "arguments": args }))
        }
        Some("reasoning") => it.get("encrypted_content").is_some().then(|| it.clone()),
        _ => Some(it.clone()),
    }
}

/// One chat round's answer: its text, the tool calls, and the items to send back.
pub fn parse_turn(v: &Value) -> Result<ChatTurn> {
    if let Some(e) = v.get("error").filter(|e| e.is_object()) {
        let msg = e.get("message").and_then(Value::as_str).unwrap_or("The model request failed");
        return Err(AiError::bad_response(format!("OpenAI: {}", clip(msg, 300))));
    }
    let output = v.get("output").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut text = String::new();
    let mut tool_calls = Vec::new();
    for item in &output {
        match item.get("type").and_then(Value::as_str) {
            Some("message") => {
                for c in item.get("content").and_then(Value::as_array).into_iter().flatten() {
                    match c.get("type").and_then(Value::as_str) {
                        Some("output_text") => text.push_str(c.get("text").and_then(Value::as_str).unwrap_or_default()),
                        Some("refusal") => {
                            let why = c.get("refusal").and_then(Value::as_str).unwrap_or_default();
                            return Err(AiError::new(ErrorKind::Safety, format!("OpenAI declined: {}", clip(why, 300))));
                        }
                        _ => {}
                    }
                }
            }
            Some("function_call") => {
                let Some(name) = item.get("name").and_then(Value::as_str) else { continue };
                let id = item.get("call_id").and_then(Value::as_str).unwrap_or_default().to_string();
                tool_calls.push(ToolCall { id, name: name.to_string(), arguments: parse_args(item.get("arguments").unwrap_or(&Value::Null)) });
            }
            _ => {}
        }
    }
    if text.is_empty() {
        text = v.get("output_text").and_then(Value::as_str).unwrap_or_default().to_string();
    }
    let reason = v.pointer("/incomplete_details/reason").and_then(Value::as_str);
    if reason == Some("content_filter") {
        return Err(AiError::new(ErrorKind::Safety, "OpenAI stopped the answer for safety reasons. Try a different prompt."));
    }
    if text.trim().is_empty() && tool_calls.is_empty() && reason == Some("max_output_tokens") {
        return Err(AiError::bad_response("OpenAI ran out of output tokens before answering. Ask for less detail."));
    }
    let items: Vec<Value> = output.iter().filter_map(replayable).collect();
    Ok(ChatTurn { text, tool_calls, provider_state: json!({ "provider": "openai", "items": items }) })
}

/// What kind of model an OpenAI model id is (JS `openaiKind`).
pub fn model_kind(id: &str) -> ModelKind {
    let s = id.to_ascii_lowercase();
    if s.contains("image") || s.contains("dall-e") {
        ModelKind::Image
    } else if [
        "embed",
        "tts",
        "whisper",
        "transcri",
        "audio",
        "realtime",
        "moderation",
        "search",
        "babbage",
        "davinci",
        "instruct",
        "computer-use",
        "sora",
        "codex-mini",
    ]
    .iter()
    .any(|w| s.contains(w))
    {
        ModelKind::Other
    } else if s.starts_with("gpt") || s.starts_with("chatgpt") || (s.starts_with('o') && s.chars().nth(1).is_some_and(|c| c.is_ascii_digit())) {
        ModelKind::Chat
    } else {
        ModelKind::Other
    }
}

/// The `GET /models` answer (JS `normalizeCatalog`): `{data: [{id}]}` with an API key, `{models:
/// [{slug}]}` on the ChatGPT plan route, or plain strings; sorted, without duplicates.
pub fn parse_models(v: &Value) -> Vec<ModelInfo> {
    let list = v.get("data").and_then(Value::as_array).or_else(|| v.get("models").and_then(Value::as_array));
    let mut out: Vec<ModelInfo> = list
        .into_iter()
        .flatten()
        .filter_map(|m| m.as_str().or_else(|| m.get("id").and_then(Value::as_str)).or_else(|| m.get("slug").and_then(Value::as_str)))
        .map(|id| ModelInfo { id: id.to_string(), kind: model_kind(id) })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out.dedup_by(|a, b| a.id == b.id);
    out
}

impl Provider for OpenAi {
    fn id(&self) -> ProviderId {
        ProviderId::OpenAi
    }

    fn config(&self) -> &ProviderConfig {
        &self.cfg
    }

    fn max_edge(&self) -> u32 {
        MAX_EDGE
    }

    fn edit_frame(&self, model: &str, w: u32, h: u32) -> (f64, [u8; 4]) {
        (ratio_of(image_size(model, w, h)), [0, 0, 0, 0])
    }

    fn native_transparency(&self, model: &str) -> bool {
        is_gpt_image_1(model)
    }

    fn generate_image(&self, model: &str, req: &ImageRequest, cancelled: Cancelled<'_>) -> Result<Rgba8Image> {
        parse_image(&self.call("/images/generations", json_body(&generation_body(model, req)), cancelled)?)
    }

    fn edit_image(&self, model: &str, req: &EditRequest, cancelled: Cancelled<'_>) -> Result<Rgba8Image> {
        parse_image(&self.call("/images/edits", edit_form(model, req)?, cancelled)?)
    }

    fn chat(&self, model: &str, req: &ChatRequest, cancelled: Cancelled<'_>) -> Result<ChatTurn> {
        parse_turn(&self.call("/responses", json_body(&chat_body(model, req)?), cancelled)?)
    }

    fn list_models(&self, cancelled: Cancelled<'_>) -> Result<Vec<ModelInfo>> {
        Ok(parse_models(&call_json(&self.catalog, &self.cfg, &self.key, self.headers(), "/models", Body::None, cancelled)?))
    }
}

