//! Pigment: generative AI. The seam between the engine's `ai.*` commands
//! ([`crate::ai_cmds`]) and whatever talks to an AI provider.
//!
//! The engine never touches the network. It defines [`GenerativeBackend`] and calls the one
//! installed with [`Session::set_generative`]: the desktop app and `pigment-cli` install the
//! `pigment-genai` backend (OpenAI, Gemini), tests install [`mock::MockBackend`]. Without a
//! backend the `ai.*` commands that need a provider are disabled, so this module compiles and
//! behaves the same on the web build.
//!
//! The contract, in both directions:
//!
//! - Images cross as sRGB, straight-alpha [`Rgba8Image`]s. A mask uses Pigment's convention:
//!   **alpha 255 = may change**, alpha 0 = keep (the backend converts it to the provider's).
//! - Every call blocks and polls `cancelled` before sending, between response chunks and between
//!   steps; a cancelled call returns a [`GenError`] of kind [`kind::CANCELLED`].
//! - An image answer has exactly the size asked for ([`ImageEdit::image`]'s size, or
//!   [`ImageGen`]'s `width` × `height`). Padding to the provider's aspect ratio, provider sizes,
//!   mask conventions, PNG and base64, keying white for transparency and resampling back all
//!   happen inside the backend. The engine checks the size and refuses anything else.
//! - [`GenerativeBackend::status`] never carries a key: at most a hint such as `…abcd`, which
//!   `ai.status` shortens again before showing it.

use std::sync::Arc;

use photocraft_raster::Rgba8Image;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{EngineError, Session};

#[cfg(any(test, feature = "testgen"))]
pub mod mock;

/// An AI provider a backend can talk to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ProviderId {
    #[serde(rename = "openai")]
    OpenAi,
    #[serde(rename = "gemini")]
    Gemini,
}

impl ProviderId {
    pub const ALL: [ProviderId; 2] = [ProviderId::OpenAi, ProviderId::Gemini];

    /// The id commands take and answer with (`"openai"`, `"gemini"`).
    pub fn id(self) -> &'static str {
        match self {
            ProviderId::OpenAi => "openai",
            ProviderId::Gemini => "gemini",
        }
    }

    /// The provider's name for people.
    pub fn label(self) -> &'static str {
        match self {
            ProviderId::OpenAi => "OpenAI",
            ProviderId::Gemini => "Google Gemini",
        }
    }

    pub fn parse(s: &str) -> Option<ProviderId> {
        ProviderId::ALL.into_iter().find(|p| p.id() == s)
    }
}

/// What a request needs from a provider: an image model or a chat (text and vision) model. A
/// ChatGPT sign-in serves chat only; images need an API key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelKind {
    Image,
    Chat,
}

impl ModelKind {
    fn noun(self) -> &'static str {
        match self {
            ModelKind::Image => "image",
            ModelKind::Chat => "chat",
        }
    }
}

/// One provider as AI Accounts shows it. No secrets.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub id: ProviderId,
    pub label: String,
    /// A key (or sign-in) is stored and readable.
    pub connected: bool,
    /// The end of the stored key (`…abcd`), never the key.
    pub hint: Option<String>,
    /// Where the key lives ("macOS Keychain", "a file only you can read").
    pub store: Option<String>,
    /// Can run image models (an API key; a ChatGPT sign-in can't).
    pub image_capable: bool,
    /// Can run chat models.
    pub chat_capable: bool,
    /// The image model used when a request names none.
    pub image_model: Option<String>,
    /// The chat model used when a request names none.
    pub chat_model: Option<String>,
}

impl ProviderStatus {
    /// A provider with nothing stored.
    pub fn disconnected(id: ProviderId) -> Self {
        Self {
            id,
            label: id.label().into(),
            connected: false,
            hint: None,
            store: None,
            image_capable: false,
            chat_capable: false,
            image_model: None,
            chat_model: None,
        }
    }

    /// Whether this provider can serve a request of `kind` now.
    pub fn fits(&self, kind: ModelKind) -> bool {
        self.connected
            && match kind {
                ModelKind::Image => self.image_capable,
                ModelKind::Chat => self.chat_capable,
            }
    }
}

/// What menus, dialogs and `ai.status` need to know about the backend. No secrets.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendStatus {
    pub providers: Vec<ProviderStatus>,
    /// AI Accounts' "Use this provider": tried first when a request names none.
    pub default_provider: Option<ProviderId>,
    /// The person agreed, once, that AI commands send prompts and pixels to their provider.
    /// Nothing is sent before.
    pub consented: bool,
}

impl BackendStatus {
    pub fn provider(&self, id: ProviderId) -> Option<&ProviderStatus> {
        self.providers.iter().find(|p| p.id == id)
    }
}

/// Which provider and model a request uses. `None` = the defaults; the engine fills in the
/// provider ([`resolve_provider`]) before calling the backend, the backend the model.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Choice {
    pub provider: Option<ProviderId>,
    pub model: Option<String>,
}

/// Change part of an image (`image.inpaint`), or all of it when there is no mask.
#[derive(Clone, Debug, PartialEq)]
pub struct ImageEdit {
    pub choice: Choice,
    pub prompt: String,
    /// sRGB, straight alpha: the region being edited.
    pub image: Rgba8Image,
    /// The image's size; alpha 255 = may change, 0 = keep.
    pub mask: Option<Rgba8Image>,
    /// Ask for transparency (gpt-image models return alpha; others are asked for a plain white
    /// background, which the backend keys out).
    pub transparent: bool,
}

/// Make a new image from a prompt (`image.generate`), covering `width` × `height` (cover-fit and
/// centre-cropped by the backend, never stretched).
#[derive(Clone, Debug, PartialEq)]
pub struct ImageGen {
    pub choice: Choice,
    pub prompt: String,
    pub width: u32,
    pub height: u32,
    pub transparent: bool,
}

/// Describe an image in words.
#[derive(Clone, Debug, PartialEq)]
pub struct Describe {
    pub choice: Choice,
    pub image: Rgba8Image,
    /// What to ask; `None` asks for a plain-prose description.
    pub prompt: Option<String>,
}

/// A function the chat model may call (the Assistant's tools).
#[derive(Clone, Debug, PartialEq)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    /// A JSON schema; backends clean it for their provider.
    pub parameters: Value,
}

/// A call the model asked for.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolCall {
    /// The provider's call id (OpenAI `call_id`; Gemini has none, so the backend makes one).
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

/// What a tool call returned, sent back on the next round.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolResult {
    pub call_id: String,
    pub name: String,
    pub output: Value,
}

/// One entry of a chat history.
#[derive(Clone, Debug, PartialEq)]
pub enum ChatMessage {
    /// The person's message, with any attached images.
    User { text: String, images: Vec<Rgba8Image> },
    /// An earlier plain answer.
    Assistant { text: String },
    /// An earlier model turn sent back verbatim (its `provider_state`), as the provider needs
    /// for tool calls: OpenAI output items, Gemini parts with their thought signatures.
    Turn(ChatTurn),
    /// The results of the previous turn's tool calls.
    ToolResults(Vec<ToolResult>),
}

/// One round of a chat: the backend sends the history once and answers; the tool loop lives in
/// the caller, because tools run on the UI thread.
#[derive(Clone, Debug, PartialEq)]
pub struct ChatRequest {
    pub choice: Choice,
    pub instructions: String,
    pub messages: Vec<ChatMessage>,
    pub tools: Vec<ToolSpec>,
}

/// The model's answer to one round.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ChatTurn {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    /// Opaque to the engine: what the backend needs to send this turn back.
    pub provider_state: Value,
}

/// The error kinds the engine itself produces. Backends use the same ids (Nib's `ErrorKind::id`):
/// `invalidKey`, `quota`, `safety`, `network`, `timeout`, `notFound`, `server`, `keyStore`, …
pub mod kind {
    /// No backend is installed (the web build, a headless session without one).
    pub const UNAVAILABLE: &str = "unavailable";
    /// The person hasn't agreed to send prompts and pixels to a provider yet.
    pub const NEEDS_CONSENT: &str = "needsConsent";
    /// No provider that can serve the request has a key.
    pub const MISSING_KEY: &str = "missingKey";
    /// Stopped by the person; nothing was changed.
    pub const CANCELLED: &str = "cancelled";
    /// The answer can't be used (wrong size, not an image, empty text).
    pub const BAD_RESPONSE: &str = "badResponse";
    /// The request was invalid before sending (an empty prompt).
    pub const BAD_REQUEST: &str = "badRequest";
    /// The feature can't run on this document, layer or selection.
    pub const DOCUMENT: &str = "document";
    /// The caller may not spend the person's money: an agent while "Allow agents to run AI
    /// commands" is off, `pigment-cli run` without `--allow-ai`, a step of a playing action or of
    /// an event's script.
    pub const NOT_ALLOWED: &str = "notAllowed";
}

/// A failure from a backend or from the checks before sending. `kind` is a stable id
/// ([`kind`]) the interface picks a button by (Open AI Accounts…, Try Again).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GenError {
    pub kind: &'static str,
    pub message: String,
    /// The provider's HTTP status, 0 without one.
    pub status: u16,
}

impl GenError {
    pub fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self { kind, message: message.into(), status: 0 }
    }

    pub fn cancelled() -> Self {
        Self::new(kind::CANCELLED, "Stopped.")
    }

    pub fn bad_response(message: impl Into<String>) -> Self {
        Self::new(kind::BAD_RESPONSE, message)
    }
}

impl std::fmt::Display for GenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for GenError {}

impl From<GenError> for EngineError {
    fn from(e: GenError) -> Self {
        if e.kind == kind::CANCELLED { EngineError::Cancelled } else { EngineError::Generative { kind: e.kind, message: e.message } }
    }
}

/// A model listed by [`GenerativeBackend::list_models`]: its id and `"text"`, `"image"` or
/// `"other"`.
pub type ModelEntry = (String, &'static str);

/// What talks to the AI providers. Each call blocks (the engine calls it on a job's worker
/// thread) and polls `cancelled`.
pub trait GenerativeBackend: Send + Sync {
    fn status(&self) -> BackendStatus;
    /// Whether this caller may send now, asked on the calling thread when a command that sends
    /// starts, before its job: also for a command another one runs (a script's step), which no
    /// interface gate sees. `automated` is true while an automation gate is installed
    /// ([`Session::authorize`]: a control, MCP or synthetic-input request). A refusal (kind
    /// [`kind::NOT_ALLOWED`]) sends nothing. The default admits every call.
    fn admit(&self, automated: bool) -> Result<(), GenError> {
        let _ = automated;
        Ok(())
    }
    fn edit_image(&self, req: &ImageEdit, cancelled: &dyn Fn() -> bool) -> Result<Rgba8Image, GenError>;
    fn generate_image(&self, req: &ImageGen, cancelled: &dyn Fn() -> bool) -> Result<Rgba8Image, GenError>;
    fn describe(&self, req: &Describe, cancelled: &dyn Fn() -> bool) -> Result<String, GenError>;
    fn chat(&self, req: &ChatRequest, cancelled: &dyn Fn() -> bool) -> Result<ChatTurn, GenError>;
    fn list_models(&self, provider: ProviderId, cancelled: &dyn Fn() -> bool) -> Result<Vec<ModelEntry>, GenError>;
}

/// The provider a request of `kind` goes to, checked before anything is sent: consent first,
/// then a provider that fits. A named provider must fit; otherwise the default provider, then
/// OpenAI, then Gemini, the first that fits (JavaScript Pigment's `ensureConnected` order).
pub fn resolve_provider(status: &BackendStatus, choice: &Choice, kind: ModelKind) -> Result<ProviderId, GenError> {
    if !status.consented {
        return Err(GenError::new(
            kind::NEEDS_CONSENT,
            "Generative AI sends your prompt and, where a feature needs it, the image or selection to your AI provider. Agree to this once in Edit › AI Accounts…, then try again.",
        ));
    }
    let fits = |id: ProviderId| status.provider(id).is_some_and(|p| p.fits(kind));
    if let Some(id) = choice.provider {
        return if fits(id) {
            Ok(id)
        } else {
            Err(GenError::new(kind::MISSING_KEY, format!("{} is not connected for {} models. Add an API key in Edit › AI Accounts…", id.label(), kind.noun())))
        };
    }
    status.default_provider.into_iter().chain(ProviderId::ALL).find(|id| fits(*id)).ok_or_else(|| {
        GenError::new(kind::MISSING_KEY, format!("No AI provider is connected for {} models. Add an API key in Edit › AI Accounts…", kind.noun()))
    })
}

impl Session {
    /// Install (or remove, with `None`) the backend the `ai.*` commands use.
    pub fn set_generative(&mut self, backend: Option<Arc<dyn GenerativeBackend>>) {
        self.generative = backend;
    }

    /// The installed backend, if any.
    pub fn generative(&self) -> Option<Arc<dyn GenerativeBackend>> {
        self.generative.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(consented: bool, openai: (bool, bool, bool), gemini: (bool, bool, bool), default: Option<ProviderId>) -> BackendStatus {
        let p = |id, (connected, image, chat): (bool, bool, bool)| ProviderStatus {
            connected,
            image_capable: image,
            chat_capable: chat,
            ..ProviderStatus::disconnected(id)
        };
        BackendStatus { providers: vec![p(ProviderId::OpenAi, openai), p(ProviderId::Gemini, gemini)], default_provider: default, consented }
    }

    #[test]
    fn consent_comes_before_any_provider() {
        let s = status(false, (true, true, true), (true, true, true), None);
        assert_eq!(resolve_provider(&s, &Choice::default(), ModelKind::Image).unwrap_err().kind, kind::NEEDS_CONSENT);
    }

    #[test]
    fn the_default_provider_wins_when_it_fits_else_openai_then_gemini() {
        let both = status(true, (true, true, true), (true, true, true), Some(ProviderId::Gemini));
        assert_eq!(resolve_provider(&both, &Choice::default(), ModelKind::Image), Ok(ProviderId::Gemini));
        let no_default = status(true, (true, true, true), (true, true, true), None);
        assert_eq!(resolve_provider(&no_default, &Choice::default(), ModelKind::Image), Ok(ProviderId::OpenAi));
        // A ChatGPT sign-in (chat only) never serves images: Gemini's key does.
        let chatgpt = status(true, (true, false, true), (true, true, true), Some(ProviderId::OpenAi));
        assert_eq!(resolve_provider(&chatgpt, &Choice::default(), ModelKind::Image), Ok(ProviderId::Gemini));
        assert_eq!(resolve_provider(&chatgpt, &Choice::default(), ModelKind::Chat), Ok(ProviderId::OpenAi));
    }

    #[test]
    fn a_named_provider_must_fit_and_nothing_connected_is_a_missing_key() {
        let s = status(true, (true, false, true), (false, false, false), None);
        let named = Choice { provider: Some(ProviderId::OpenAi), model: None };
        let e = resolve_provider(&s, &named, ModelKind::Image).unwrap_err();
        assert_eq!(e.kind, kind::MISSING_KEY);
        assert!(e.message.contains("OpenAI") && e.message.contains("AI Accounts"), "{e}");
        assert_eq!(resolve_provider(&s, &Choice { provider: Some(ProviderId::Gemini), model: None }, ModelKind::Chat).unwrap_err().kind, kind::MISSING_KEY);
        let none = status(true, (false, false, false), (false, false, false), Some(ProviderId::OpenAi));
        assert_eq!(resolve_provider(&none, &Choice::default(), ModelKind::Chat).unwrap_err().kind, kind::MISSING_KEY);
    }

    #[test]
    fn provider_ids_round_trip() {
        for p in ProviderId::ALL {
            assert_eq!(ProviderId::parse(p.id()), Some(p));
            assert_eq!(serde_json::to_value(p).unwrap(), serde_json::json!(p.id()));
        }
        assert_eq!(ProviderId::parse("OpenAI"), None);
    }

    #[test]
    fn a_cancelled_backend_call_is_the_engine_cancel_and_others_keep_their_kind() {
        assert_eq!(EngineError::from(GenError::cancelled()), EngineError::Cancelled);
        let e = EngineError::from(GenError::new("quota", "Your OpenAI quota is used up."));
        assert_eq!(e, EngineError::Generative { kind: "quota", message: "Your OpenAI quota is used up.".into() });
        assert_eq!(e.to_string(), "Your OpenAI quota is used up.");
    }
}
