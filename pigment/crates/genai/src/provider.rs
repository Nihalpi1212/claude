//! The provider abstraction: a new image from a prompt, an edit of an image through an optional
//! mask, one round of a chat with function tools (which also serves Describe), and the model
//! catalog. Two implementations: [`openai`] (Images API, Responses API) and [`gemini`]
//! (generateContent).
//!
//! Request bodies are built and answers parsed by pure functions in each module, so the tests
//! check them against recorded answers; [`Provider`] wires them to [`crate::http`]. The
//! provider-independent pixel steps (scaling, padding, keying, resampling back) are the
//! backend's ([`crate::backend`]); a provider says what it needs ([`Provider::max_edge`],
//! [`Provider::edit_frame`], [`Provider::native_transparency`]).

pub mod gemini;
pub mod openai;

use std::sync::Arc;
use std::time::Duration;

use photocraft_engine::generative::{ChatRequest, ChatTurn};
use photocraft_raster::Rgba8Image;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::cancel::Cancelled;
use crate::keys::ApiKey;
use crate::{AiError, ErrorKind, ProviderId, Result};

pub use crate::http::is_loopback;

/// The API root of `p`.
pub fn default_base_url(p: ProviderId) -> &'static str {
    match p {
        ProviderId::OpenAi => "https://api.openai.com/v1",
        ProviderId::Gemini => "https://generativelanguage.googleapis.com/v1beta",
    }
}

/// The model used when the person chose none and the catalog can't be read.
pub fn fallback_model(p: ProviderId, kind: ModelKind) -> &'static str {
    match (p, kind) {
        (ProviderId::OpenAi, ModelKind::Image) => "gpt-image-1",
        (ProviderId::OpenAi, _) => "gpt-5.1",
        (ProviderId::Gemini, ModelKind::Image) => "gemini-2.5-flash-image",
        (ProviderId::Gemini, _) => "gemini-2.5-flash",
    }
}

/// Models preferred when a catalog lists them, best first (JavaScript Pigment's
/// `PREFERRED_MODELS`; [`pick_model`]).
pub fn preferred_models(p: ProviderId, kind: ModelKind) -> &'static [&'static str] {
    match (p, kind) {
        (ProviderId::OpenAi, ModelKind::Chat) => &["gpt-5.5", "gpt-5.1", "gpt-5", "gpt-4.1", "gpt-4o"],
        (ProviderId::OpenAi, ModelKind::Image) => &["gpt-image-1.5", "gpt-image-1", "gpt-image-2"],
        (ProviderId::Gemini, ModelKind::Chat) => &["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
        (ProviderId::Gemini, ModelKind::Image) => {
            &["gemini-3.1-flash-image", "gemini-3.1-flash-image-preview", "gemini-3-pro-image-preview", "gemini-2.5-flash-image"]
        }
        (_, ModelKind::Other) => &[],
    }
}

/// How one provider is reached.
#[derive(Clone, Debug, PartialEq)]
pub struct ProviderConfig {
    pub id: ProviderId,
    /// The API root (`https://api.openai.com/v1`). Only HTTPS, or a loopback address for tests.
    pub base_url: String,
    /// An image or chat request, connection to last byte.
    pub timeout: Duration,
    /// Answers larger than this are refused (images come base64-encoded in JSON).
    pub max_response_bytes: usize,
}

/// 64 MiB: a 4096² PNG in base64 is about 30 MB.
pub const DEFAULT_MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
/// Image models can take a few minutes (JS: 300 s).
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(300);
/// Model lists and key checks (JS: 30 s).
pub const CATALOG_TIMEOUT: Duration = Duration::from_secs(30);

impl ProviderConfig {
    pub fn new(id: ProviderId) -> Self {
        Self { id, base_url: default_base_url(id).to_string(), timeout: DEFAULT_TIMEOUT, max_response_bytes: DEFAULT_MAX_RESPONSE_BYTES }
    }

    /// Refuses a base URL that is neither HTTPS nor loopback.
    pub fn validate(&self) -> Result<()> {
        if !(self.base_url.starts_with("https://") || is_loopback(&self.base_url)) {
            return Err(AiError::bad_request("The provider address must start with https://."));
        }
        Ok(())
    }

    pub(crate) fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base_url.trim_end_matches('/'))
    }
}

/// Refuses a model id that is not a plain id (it goes into a URL path for Gemini).
pub fn check_model_id(m: &str) -> Result<()> {
    if m.is_empty() || m.len() > 128 || !m.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b':' | b'/')) {
        return Err(AiError::bad_request(format!("`{m}` is not a model id.")));
    }
    Ok(())
}

/// A new image from a prompt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImageRequest {
    pub prompt: String,
    /// The size wanted; the provider's nearest size or aspect ratio is asked for, and the backend
    /// fits the answer.
    pub width: u32,
    pub height: u32,
    /// Ask for a transparent background where the model has one ([`Provider::native_transparency`]).
    pub transparent: bool,
}

/// An edit of `image`, already scaled and padded to the provider's frame by the backend.
#[derive(Clone, Debug, PartialEq)]
pub struct EditRequest {
    pub prompt: String,
    pub image: Rgba8Image,
    /// The same size; Pigment's convention (alpha 255 = may change). Each provider converts it:
    /// OpenAI's alpha 0 = may change, Gemini's white (may change) on black.
    pub mask: Option<Rgba8Image>,
    pub transparent: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelKind {
    Chat,
    Image,
    Other,
}

impl ModelKind {
    /// What the engine's `list_models` calls it: `text`, `image` or `other`.
    pub fn engine_id(self) -> &'static str {
        match self {
            ModelKind::Chat => "text",
            ModelKind::Image => "image",
            ModelKind::Other => "other",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub kind: ModelKind,
}

/// The model of `want` a catalog offers by default (JS `pickPreferred`): a preferred id the
/// catalog lists exactly, else the first listed id that starts with a preferred id, else the
/// first model of that kind.
pub fn pick_model(p: ProviderId, models: &[ModelInfo], want: ModelKind) -> Option<String> {
    let of_kind: Vec<&str> = models.iter().filter(|m| m.kind == want).map(|m| m.id.as_str()).collect();
    let preferred = preferred_models(p, want);
    preferred
        .iter()
        .find(|pref| of_kind.contains(pref))
        .map(|s| (*s).to_string())
        .or_else(|| preferred.iter().find_map(|pref| of_kind.iter().find(|id| id.starts_with(pref)).map(|s| (*s).to_string())))
        .or_else(|| of_kind.first().map(|s| (*s).to_string()))
}

/// A generative service. Implementations block: call them from a worker thread.
pub trait Provider: Send + Sync {
    fn id(&self) -> ProviderId;
    fn config(&self) -> &ProviderConfig;
    /// The longest side of an image an edit sends (JS: OpenAI 1536, Gemini 2048).
    fn max_edge(&self) -> u32;
    /// The aspect ratio (width / height) an edit of a `w` × `h` image is padded to for `model`,
    /// and the padding's colour.
    fn edit_frame(&self, model: &str, w: u32, h: u32) -> (f64, [u8; 4]);
    /// Whether `model` returns real transparency when asked; otherwise the backend asks for a
    /// plain white background and keys it out.
    fn native_transparency(&self, model: &str) -> bool;
    /// The answer as the provider sent it, decoded.
    fn generate_image(&self, model: &str, req: &ImageRequest, cancelled: Cancelled<'_>) -> Result<Rgba8Image>;
    /// The answer as the provider sent it, decoded (any size: the backend scales it back).
    fn edit_image(&self, model: &str, req: &EditRequest, cancelled: Cancelled<'_>) -> Result<Rgba8Image>;
    /// One round: the history goes out, the model's text and tool calls come back.
    fn chat(&self, model: &str, req: &ChatRequest, cancelled: Cancelled<'_>) -> Result<ChatTurn>;
    /// The models the key may use: the cheapest authenticated call, so it is also the key check.
    fn list_models(&self, cancelled: Cancelled<'_>) -> Result<Vec<ModelInfo>>;
}

/// The provider for `cfg` with `key`.
pub fn build(cfg: ProviderConfig, key: ApiKey) -> Result<Arc<dyn Provider>> {
    cfg.validate()?;
    Ok(match cfg.id {
        ProviderId::OpenAi => Arc::new(openai::OpenAi::new(cfg, key)),
        ProviderId::Gemini => Arc::new(gemini::Gemini::new(cfg, key)),
    })
}

/// Most JSON values an answer may hold. A real answer has a few hundred (a model list) or a few big
/// strings (an image); without a bound, a 64 MiB `[0,0,…]` from a hostile endpoint would build
/// tens of millions of `Value`s (about 1 GB) before anything looked at it.
pub const MAX_JSON_VALUES: usize = 1_000_000;

/// An upper bound on the values in JSON text `body`: every value but the first follows a `,`, `[`
/// or `{` outside a string.
pub fn json_value_bound(body: &[u8]) -> usize {
    let (mut count, mut in_string, mut escaped) = (1usize, false, false);
    for &b in body {
        if in_string {
            match b {
                _ if escaped => escaped = false,
                b'\\' => escaped = true,
                b'"' => in_string = false,
                _ => {}
            }
        } else {
            match b {
                b'"' => in_string = true,
                b',' | b'[' | b'{' => count += 1,
                _ => {}
            }
        }
    }
    count
}

/// The JSON of an answer body, or a readable error.
pub(crate) fn parse_json(body: &[u8]) -> Result<Value> {
    if json_value_bound(body) > MAX_JSON_VALUES {
        return Err(AiError::bad_response("The provider's answer has too many values."));
    }
    serde_json::from_slice(body).map_err(|_| AiError::bad_response("The provider's answer was not valid JSON."))
}

/// The messages of the ChatGPT plan route's own error codes (JS `SUBSCRIPTION_HINTS`), with the
/// kind each is.
const SUBSCRIPTION_HINTS: [(&str, ErrorKind, &str); 6] = [
    (
        "subscription_sharing_user_not_eligible",
        ErrorKind::InvalidKey,
        "Your ChatGPT plan does not include use in third-party apps (a Plus or Pro plan is required). You can use an OpenAI API key instead.",
    ),
    (
        "subscription_sharing_usage_limit_exceeded",
        ErrorKind::Quota,
        "You have reached the usage limit of your ChatGPT plan. Try again later or use an OpenAI API key.",
    ),
    ("subscription_sharing_usage_unavailable", ErrorKind::Server, "ChatGPT could not check the usage of your plan right now. Try again in a moment."),
    (
        "subscription_sharing_route_not_supported",
        ErrorKind::BadRequest,
        "This kind of request is not available through a ChatGPT plan. Use an OpenAI API key for it.",
    ),
    (
        "subscription_sharing_unsupported_capability",
        ErrorKind::BadRequest,
        "This capability (for example image generation) is not available through a ChatGPT plan. Use an OpenAI API key for it.",
    ),
    ("subscription_sharing_invalid_user", ErrorKind::InvalidKey, "ChatGPT rejected this sign-in. Sign out and sign in with ChatGPT again."),
];

/// The error a non-2xx answer means. `body` is the provider's error JSON (or anything else).
pub fn translate_error(p: ProviderId, status: u16, body: &[u8]) -> AiError {
    let v: Value = if json_value_bound(body) > MAX_JSON_VALUES { Value::Null } else { serde_json::from_slice(body).unwrap_or(Value::Null) };
    let e = v.get("error").filter(|e| e.is_object()).unwrap_or(&v);
    let field = |k: &str| e.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    let (code, ty, gstatus) = (field("code"), field("type"), field("status"));
    if let Some((_, kind, msg)) = SUBSCRIPTION_HINTS.iter().find(|(c, ..)| *c == code || *c == field("error")) {
        return AiError::new(*kind, *msg).with_status(status);
    }
    let reasons: Vec<String> = e
        .get("details")
        .and_then(Value::as_array)
        .map(|d| d.iter().filter_map(|x| x.get("reason").and_then(Value::as_str)).map(str::to_string).collect())
        .unwrap_or_default();
    let provider_message = clip(field("message").trim(), 300);
    let all = format!("{code} {ty} {gstatus} {} {}", reasons.join(" "), provider_message).to_ascii_lowercase();
    let name = p.label();
    let (k, msg) = if all.contains("api_key_invalid") || all.contains("invalid_api_key") || all.contains("api key not valid") || status == 401 {
        (ErrorKind::InvalidKey, format!("{name} rejected the API key. Check it in Edit › AI Accounts…"))
    } else if all.contains("insufficient_quota") || all.contains("billing") {
        (ErrorKind::Quota, format!("The {name} account has no quota left. Check its plan and billing."))
    } else if status == 429 || all.contains("resource_exhausted") || all.contains("rate_limit") {
        (ErrorKind::Quota, format!("{name} is limiting requests (rate limit or quota). Wait a moment and try again."))
    } else if all.contains("moderation") || all.contains("content_policy") || all.contains("safety") || all.contains("blocked") {
        (ErrorKind::Safety, format!("{name} refused the request for safety reasons. Try a different prompt."))
    } else if status == 403 || gstatus == "PERMISSION_DENIED" {
        (ErrorKind::InvalidKey, format!("{name} refused this request for the API key (permission denied)."))
    } else if status == 404 {
        (ErrorKind::NotFound, format!("{name} doesn't know the model or endpoint. Pick another model in Edit › AI Accounts…"))
    } else if status >= 500 {
        (ErrorKind::Server, format!("{name} is having trouble (error {status}). Try again later."))
    } else {
        (ErrorKind::BadRequest, format!("{name} refused the request (error {status})."))
    };
    let message = if provider_message.is_empty() || k == ErrorKind::InvalidKey {
        // A key error's message may quote the key: it is left out.
        msg
    } else {
        format!("{msg} {name} said: {provider_message}")
    };
    AiError::new(k, message).with_status(status)
}

/// `s` cut to at most `max` characters, with an ellipsis when cut.
pub(crate) fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

/// A response with a 2xx status, else its translated error with the key redacted.
pub(crate) fn check(p: ProviderId, resp: crate::http::Response, key: &ApiKey) -> Result<Vec<u8>> {
    if (200..300).contains(&resp.status) { Ok(resp.body) } else { Err(translate_error(p, resp.status, &resp.body).redact(key.expose())) }
}

/// `r` with the key in use taken out of an error's message. [`check`] does this for a provider's
/// error answers; this also covers what is read out of a 2xx answer and quoted in a message (an
/// `error` object, a refusal, text sent instead of an image), so no route puts the key in one.
pub(crate) fn redacted<T>(r: Result<T>, key: &ApiKey) -> Result<T> {
    r.map_err(|e| e.redact(key.expose()))
}

/// The ratio closest to `w:h` in log aspect among `ratios` (`"16:9"` or `"1536x1024"`).
pub fn nearest_ratio<'a>(w: u32, h: u32, ratios: &[&'a str]) -> &'a str {
    let want = f64::from(w.max(1)).ln() - f64::from(h.max(1)).ln();
    let value = |r: &str| (ratio_of(r).ln() - want).abs();
    ratios.iter().copied().min_by(|a, b| value(a).total_cmp(&value(b))).unwrap_or("1:1")
}

/// `"16:9"` or `"1536x1024"` as width / height.
pub fn ratio_of(r: &str) -> f64 {
    let mut it = r.split([':', 'x']).map(|n| n.parse::<f64>().unwrap_or(1.0).max(1.0));
    let (a, b) = (it.next().unwrap_or(1.0), it.next().unwrap_or(1.0));
    a / b
}

/// A provider's JSON request: POST `body` (or GET without one) to `path`, the 2xx answer parsed.
pub(crate) fn call_json(
    http: &crate::http::Http,
    cfg: &ProviderConfig,
    key: &ApiKey,
    headers: Vec<(&'static str, String)>,
    path: &str,
    body: crate::http::Body,
    cancelled: Cancelled<'_>,
) -> Result<Value> {
    let req = crate::http::Request { url: cfg.url(path), headers, body };
    let resp = http.send(req, cancelled)?;
    parse_json(&check(cfg.id, resp, key)?)
}

/// The HTTP clients a provider uses: one for image and chat requests, one with the shorter
/// timeout for the catalog.
pub(crate) fn clients(cfg: &ProviderConfig) -> (crate::http::Http, crate::http::Http) {
    (
        crate::http::Http::new(&cfg.base_url, cfg.timeout, cfg.max_response_bytes),
        crate::http::Http::new(&cfg.base_url, cfg.timeout.min(CATALOG_TIMEOUT), cfg.max_response_bytes),
    )
}

/// The `{"provider": …}` an opaque [`ChatTurn::provider_state`] carries, so a turn is only sent
/// back verbatim to the provider that produced it.
pub(crate) fn state_provider(state: &Value) -> Option<ProviderId> {
    state.get("provider").and_then(Value::as_str).and_then(ProviderId::parse)
}
