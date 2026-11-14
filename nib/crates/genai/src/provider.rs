//! The provider abstraction: text (and strict JSON) from a prompt with optional images, an image
//! from a prompt with optional reference images, and an image edit through a mask. Two
//! implementations: [`openai`] (Responses API, Images API) and [`gemini`] (generateContent).
//!
//! Request bodies are built and answers parsed by pure functions in each module, so the tests
//! check them against recorded answers; [`Provider`] wires them to [`crate::http`].

pub mod gemini;
pub mod openai;

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::keys::ApiKey;
use crate::{AiError, CancelToken, ErrorKind, Result};

pub use crate::http::is_loopback;

/// Which service a request goes to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    #[serde(rename = "openai")]
    OpenAi,
    Gemini,
}

impl ProviderKind {
    pub const ALL: [ProviderKind; 2] = [ProviderKind::OpenAi, ProviderKind::Gemini];

    /// `openai` / `gemini`: the id in settings, the key store, the control protocol and MCP.
    pub fn id(self) -> &'static str {
        match self {
            ProviderKind::OpenAi => "openai",
            ProviderKind::Gemini => "gemini",
        }
    }

    /// The name shown in AI Accounts and in messages.
    pub fn label(self) -> &'static str {
        match self {
            ProviderKind::OpenAi => "OpenAI",
            ProviderKind::Gemini => "Google Gemini",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        match id.trim().to_ascii_lowercase().as_str() {
            "openai" => Some(ProviderKind::OpenAi),
            "gemini" | "google" => Some(ProviderKind::Gemini),
            _ => None,
        }
    }

    pub fn default_base_url(self) -> &'static str {
        match self {
            ProviderKind::OpenAi => "https://api.openai.com/v1",
            ProviderKind::Gemini => "https://generativelanguage.googleapis.com/v1beta",
        }
    }

    /// The text model used until the person picks one.
    pub fn default_text_model(self) -> &'static str {
        match self {
            ProviderKind::OpenAi => "gpt-5.1",
            ProviderKind::Gemini => "gemini-2.5-flash",
        }
    }

    /// The image model used until the person picks one.
    pub fn default_image_model(self) -> &'static str {
        match self {
            ProviderKind::OpenAi => "gpt-image-1",
            ProviderKind::Gemini => "gemini-2.5-flash-image",
        }
    }

    /// Models preferred when a catalog lists them, best first ([`pick_model`]).
    pub fn preferred_models(self, kind: ModelKind) -> &'static [&'static str] {
        match (self, kind) {
            (ProviderKind::OpenAi, ModelKind::Text) => &["gpt-5.5", "gpt-5.1", "gpt-5", "gpt-4.1", "gpt-4o"],
            (ProviderKind::OpenAi, ModelKind::Image) => &["gpt-image-1.5", "gpt-image-1", "gpt-image-2"],
            (ProviderKind::Gemini, ModelKind::Text) => &["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
            (ProviderKind::Gemini, ModelKind::Image) => &["gemini-2.5-flash-image", "gemini-3-pro-image-preview"],
            (_, ModelKind::Other) => &[],
        }
    }
}

/// How one provider is reached.
#[derive(Clone, Debug, PartialEq)]
pub struct ProviderConfig {
    pub kind: ProviderKind,
    /// The API root (`https://api.openai.com/v1`). Only HTTPS, or a loopback address for tests.
    pub base_url: String,
    pub text_model: String,
    pub image_model: String,
    /// The whole request, connection to last byte.
    pub timeout: Duration,
    /// Answers larger than this are refused (images come base64-encoded in JSON).
    pub max_response_bytes: usize,
}

/// 64 MiB: a 4096² PNG in base64 is about 30 MB.
pub const DEFAULT_MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
/// Image models can take a few minutes.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(300);

impl ProviderConfig {
    pub fn new(kind: ProviderKind) -> Self {
        Self {
            kind,
            base_url: kind.default_base_url().to_string(),
            text_model: kind.default_text_model().to_string(),
            image_model: kind.default_image_model().to_string(),
            timeout: DEFAULT_TIMEOUT,
            max_response_bytes: DEFAULT_MAX_RESPONSE_BYTES,
        }
    }

    /// Refuses a base URL that is neither HTTPS nor loopback, and models that aren't plain ids.
    pub fn validate(&self) -> Result<()> {
        if !(self.base_url.starts_with("https://") || is_loopback(&self.base_url)) {
            return Err(AiError::bad_request("The provider address must start with https://."));
        }
        for m in [&self.text_model, &self.image_model] {
            if m.is_empty() || m.len() > 128 || !m.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b':')) {
                return Err(AiError::bad_request(format!("`{m}` is not a model id.")));
            }
        }
        Ok(())
    }

    pub(crate) fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base_url.trim_end_matches('/'))
    }
}

/// An image sent with a request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InputImage {
    pub mime: String,
    pub bytes: Vec<u8>,
}

impl InputImage {
    pub fn png(bytes: Vec<u8>) -> Self {
        Self { mime: "image/png".into(), bytes }
    }
}

/// Text (or JSON) from a prompt.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TextRequest {
    /// The system / developer instructions.
    pub instructions: String,
    pub prompt: String,
    pub images: Vec<InputImage>,
    /// Ask for a JSON object (the prompt must say which).
    pub json: bool,
    pub max_output_tokens: Option<u32>,
}

/// An image from a prompt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImageRequest {
    pub prompt: String,
    /// The size wanted; the provider's nearest size is asked for and the caller fits the answer.
    pub width: u32,
    pub height: u32,
    /// A transparent background (gpt-image-1); other models are asked for plain white.
    pub transparent: bool,
    /// Style references (the selected artwork rendered).
    pub references: Vec<InputImage>,
}

/// An edit of `image` through `mask`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EditRequest {
    pub prompt: String,
    /// PNG, at the provider size chosen by the caller.
    pub image: Vec<u8>,
    /// PNG of the same size; alpha 0 marks the pixels the model may change (OpenAI's convention;
    /// the Gemini request turns it into a white-on-black mask image).
    pub mask: Option<Vec<u8>>,
}

/// An image a provider returned.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImageData {
    pub mime: String,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelKind {
    Text,
    Image,
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub kind: ModelKind,
}

/// The first of the kind's preferred models the catalog lists, else the first model of that kind.
pub fn pick_model(kind: ProviderKind, models: &[ModelInfo], want: ModelKind) -> Option<String> {
    let of_kind: Vec<&ModelInfo> = models.iter().filter(|m| m.kind == want).collect();
    kind.preferred_models(want)
        .iter()
        .find_map(|p| of_kind.iter().find(|m| m.id == *p).map(|m| m.id.clone()))
        .or_else(|| of_kind.first().map(|m| m.id.clone()))
}

/// A generative service. Implementations block: call them from a worker thread.
pub trait Provider: Send + Sync {
    fn kind(&self) -> ProviderKind;
    fn config(&self) -> &ProviderConfig;
    fn generate_text(&self, req: &TextRequest, cancel: &CancelToken) -> Result<String>;
    fn generate_image(&self, req: &ImageRequest, cancel: &CancelToken) -> Result<ImageData>;
    fn edit_image(&self, req: &EditRequest, cancel: &CancelToken) -> Result<ImageData>;
    /// The models the key may use: the cheapest authenticated call, so it is also the connection test.
    fn list_models(&self, cancel: &CancelToken) -> Result<Vec<ModelInfo>>;
}

/// The provider for `cfg` with `key`.
pub fn build(cfg: ProviderConfig, key: ApiKey) -> Result<Arc<dyn Provider>> {
    cfg.validate()?;
    Ok(match cfg.kind {
        ProviderKind::OpenAi => Arc::new(openai::OpenAi::new(cfg, key)),
        ProviderKind::Gemini => Arc::new(gemini::Gemini::new(cfg, key)),
    })
}

/// The JSON of an answer body, or a readable error.
pub(crate) fn parse_json(body: &[u8]) -> Result<Value> {
    serde_json::from_slice(body).map_err(|_| AiError::bad_response("The provider's answer was not valid JSON."))
}

/// The error a non-2xx answer means. `body` is the provider's error JSON (or anything else).
pub fn translate_error(kind: ProviderKind, status: u16, body: &[u8]) -> AiError {
    let v: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let e = v.get("error").filter(|e| e.is_object()).unwrap_or(&v);
    let field = |k: &str| e.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    let (code, ty, gstatus) = (field("code"), field("type"), field("status"));
    let reasons: Vec<String> = e
        .get("details")
        .and_then(Value::as_array)
        .map(|d| d.iter().filter_map(|x| x.get("reason").and_then(Value::as_str)).map(str::to_string).collect())
        .unwrap_or_default();
    let provider_message = clip(field("message").trim(), 300);
    let all = format!("{code} {ty} {gstatus} {} {}", reasons.join(" "), provider_message).to_ascii_lowercase();
    let name = kind.label();
    let (k, msg) = if all.contains("api_key_invalid") || all.contains("invalid_api_key") || all.contains("api key not valid") || status == 401 {
        (ErrorKind::InvalidKey, format!("{name} rejected the API key. Check it in AI Accounts."))
    } else if all.contains("insufficient_quota") || all.contains("billing") {
        (ErrorKind::Quota, format!("The {name} account has no quota left. Check its plan and billing."))
    } else if status == 429 || all.contains("resource_exhausted") || all.contains("rate_limit") {
        (ErrorKind::Quota, format!("{name} is limiting requests (rate limit or quota). Wait a moment and try again."))
    } else if all.contains("moderation") || all.contains("content_policy") || all.contains("safety") || all.contains("blocked") {
        (ErrorKind::Safety, format!("{name} refused the request for safety reasons. Try a different prompt."))
    } else if status == 403 || gstatus == "PERMISSION_DENIED" {
        (ErrorKind::InvalidKey, format!("{name} refused this request for the API key (permission denied)."))
    } else if status == 404 {
        (ErrorKind::NotFound, format!("{name} doesn't know the model or endpoint. Pick another model in AI Accounts."))
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
pub(crate) fn check(kind: ProviderKind, resp: crate::http::Response, key: &ApiKey) -> Result<Vec<u8>> {
    if (200..300).contains(&resp.status) { Ok(resp.body) } else { Err(translate_error(kind, resp.status, &resp.body).redact(key.expose())) }
}

/// The aspect ratio closest to `w:h` among `ratios` (`"16:9"`).
pub(crate) fn nearest_ratio<'a>(w: u32, h: u32, ratios: &[&'a str]) -> &'a str {
    let want = f64::from(w.max(1)).ln() - f64::from(h.max(1)).ln();
    let value = |r: &str| {
        let mut it = r.split([':', 'x']).map(|n| n.parse::<f64>().unwrap_or(1.0).max(1.0));
        let (a, b) = (it.next().unwrap_or(1.0), it.next().unwrap_or(1.0));
        (a.ln() - b.ln() - want).abs()
    };
    ratios.iter().copied().min_by(|a, b| value(a).total_cmp(&value(b))).unwrap_or("1:1")
}
