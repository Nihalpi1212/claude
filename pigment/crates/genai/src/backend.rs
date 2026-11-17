//! [`GenAiBackend`]: `photocraft_engine::generative::GenerativeBackend` over [`AiAccounts`].
//!
//! The engine's `ai.*` commands choose the region, send sRGB images of at most 2048 px a side and
//! composite the answer through their mask; everything provider-specific happens here, as
//! JavaScript Pigment's `providers.js` did it:
//!
//! * **Edits:** the image (and mask) scaled to the provider's longest side (OpenAI 1536, Gemini
//!   2048), padded, centred, to the provider's aspect ratio (OpenAI's nearest size with transparent
//!   padding, Gemini's nearest ratio with white padding; the mask's padding is "keep"), sent with
//!   the provider's mask convention; the answer resampled to the padded size, the original's
//!   rectangle cropped and scaled back to exactly the size sent. The answer is **not** composited
//!   through the mask here: the engine does that once (`docs/generative-ai.md`).
//! * **New images:** the provider's nearest size or aspect ratio; the answer cover-fit to the size
//!   asked and centre-cropped, never stretched. Transparency: gpt-image-1 and 1.5 return alpha;
//!   other models are asked for a plain white background, which is keyed out when the answer is
//!   opaque.
//! * **Describe** is one chat round with the image; **chat** is one round of the Assistant's loop.
//! * **Models:** the request's, else the person's choice, else the catalog's preferred model,
//!   else a known one.
//!
//! A ChatGPT sign-in (`crate::chatgpt`) serves chat models only: the status says so
//! (`imageCapable: false`), so an image request goes to a provider with a key or is refused
//! before anything is sent.
//!
//! **Who may send** ([`Caller`]): the person in the app always (after the one-time consent); an
//! agent (MCP, the control channel, `pigment-cli serve`) only while "Allow agents to run AI
//! commands" is on; `pigment-cli run` only with `--allow-ai`. A refused call sends nothing and is
//! a `notAllowed` error. Status and the checks before sending re-read `ai.json` each time, so a
//! long-running server follows what the person changes in AI Accounts.

use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};

use photocraft_engine::ai_cmds::region;
use photocraft_engine::generative::{
    self, BackendStatus, ChatRequest, ChatTurn, Choice, Describe, GenError, GenerativeBackend, ImageEdit, ImageGen, ModelEntry, ProviderStatus,
};
use photocraft_raster::Rgba8Image;

use crate::accounts::{AiAccounts, Method};
use crate::cancel::{Cancelled, check};
use crate::provider::{self, EditRequest, ImageRequest, ModelKind, Provider};
use crate::{AiError, ErrorKind, ProviderId, Result};

/// What a model without real transparency is asked for (JS `generateImage` on Gemini).
pub const WHITE_BACKGROUND: &str = "Render the subject alone on a plain, pure white (#ffffff) background with nothing else: no shadow, no floor, no frame.";

/// The keying threshold for a white background (JS `keyWhiteBorder`'s default).
const KEY_THRESHOLD: u8 = 232;

/// Who the backend works for, which decides whether it may send (and so spend money).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Caller {
    /// The person, in Pigment's own interface (the menus, the windows, the Assistant).
    Person,
    /// An agent: MCP, the control channel, `pigment-cli serve`. Needs "Allow agents to run AI
    /// commands" (`allowAgents` in `ai.json`).
    Agent,
    /// `pigment-cli run` (and the other command-line subcommands). Needs `--allow-ai`.
    CommandLine { allow_ai: bool },
}

/// Where a backend's accounts come from when it first needs them.
type OpenAccounts = Box<dyn Fn() -> AiAccounts + Send + Sync>;

/// The engine's generative backend over the person's AI accounts.
pub struct GenAiBackend {
    accounts: OnceLock<Arc<Mutex<AiAccounts>>>,
    /// Opens the accounts on first use ([`GenAiBackend::deferred`]).
    open: Option<OpenAccounts>,
    caller: Caller,
}

fn lock(a: &Mutex<AiAccounts>) -> MutexGuard<'_, AiAccounts> {
    a.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The engine's kind of model for ours.
fn engine_kind(kind: ModelKind) -> generative::ModelKind {
    if kind == ModelKind::Image { generative::ModelKind::Image } else { generative::ModelKind::Chat }
}

impl GenAiBackend {
    /// A backend over `accounts`, shared with whoever edits them (AI Accounts).
    pub fn new(accounts: Arc<Mutex<AiAccounts>>, caller: Caller) -> Self {
        Self { accounts: OnceLock::from(accounts), open: None, caller }
    }

    /// A backend over the accounts kept in `config_dir` (`ai.json`, the key store).
    pub fn from_config_dir(config_dir: &Path, caller: Caller) -> Self {
        Self::new(Arc::new(Mutex::new(AiAccounts::new(config_dir))), caller)
    }

    /// A backend whose accounts `open` reads only when an AI command first needs them, so a
    /// session that never runs one (every headless session gets a backend) reads nothing.
    pub fn deferred(caller: Caller, open: impl Fn() -> AiAccounts + Send + Sync + 'static) -> Self {
        Self { accounts: OnceLock::new(), open: Some(Box::new(open)), caller }
    }

    pub fn accounts(&self) -> &Arc<Mutex<AiAccounts>> {
        self.accounts.get_or_init(|| Arc::new(Mutex::new(self.open.as_ref().map_or_else(AiAccounts::in_memory, |open| open()))))
    }

    pub fn caller(&self) -> Caller {
        self.caller
    }

    /// The refusal for a caller that may not send, if this one may not.
    fn allowed(&self, a: &AiAccounts) -> Result<()> {
        let refuse = |m: &str| Err(AiError::new(ErrorKind::NotAllowed, m));
        match self.caller {
            Caller::Person => Ok(()),
            Caller::Agent if a.settings.allow_agents => Ok(()),
            Caller::Agent => refuse(
                "Agents may not run AI commands: they send your images and prompts to your AI provider, billed to your account. Turn on \"Allow agents to run AI commands\" in Pigment's Edit › AI Accounts… (or run `pigment-cli ai agents on`).",
            ),
            Caller::CommandLine { allow_ai: true } => Ok(()),
            Caller::CommandLine { allow_ai: false } => refuse(
                "AI commands send your image or prompt to your AI provider and are billed to your account: add --allow-ai to `pigment-cli run` to run them.",
            ),
        }
    }

    /// The provider and model a request goes to, after the checks before sending: who may send,
    /// consent, and a provider with a key for the kind of model. Reads the catalog (without the
    /// lock) when the model is automatic and no catalog is cached.
    fn prepare(&self, choice: &Choice, kind: ModelKind, cancelled: Cancelled<'_>) -> Result<(Arc<dyn Provider>, String)> {
        check(cancelled)?;
        let (p, provider, known) = {
            let mut a = lock(self.accounts());
            a.reload();
            self.allowed(&a)?;
            let status = status_of(&a);
            let p = generative::resolve_provider(&status, choice, engine_kind(kind)).map_err(from_gen)?;
            let provider = a.provider(p)?;
            let known = choice.model.clone().or_else(|| a.known_model(p, kind));
            (p, provider, known)
        };
        let model = match known {
            Some(m) => m,
            None => {
                // Automatic: the catalog's preferred model (JS `app.ai.model`); a catalog that
                // can't be read leaves a known model.
                match provider.list_models(cancelled) {
                    Ok(models) => {
                        let pick = provider::pick_model(p, &models, kind);
                        lock(self.accounts()).cache_catalog(p, models);
                        pick.unwrap_or_else(|| provider::fallback_model(p, kind).to_string())
                    }
                    Err(e) if e.kind == ErrorKind::Cancelled => return Err(e),
                    Err(e) if e.kind == ErrorKind::InvalidKey => return Err(e),
                    Err(e) => {
                        log::warn!("genai: could not list {}'s models ({}); using the known model", p.id(), e.kind.id());
                        provider::fallback_model(p, kind).to_string()
                    }
                }
            }
        };
        provider::check_model_id(&model)?;
        log::info!("genai: {} request to {}", if kind == ModelKind::Image { "image" } else { "chat" }, p.id());
        Ok((provider, model))
    }

    fn edit(&self, req: &ImageEdit, cancelled: Cancelled<'_>) -> Result<Rgba8Image> {
        let (w, h) = (req.image.width, req.image.height);
        if w == 0 || h == 0 || req.image.pixels.len() != w as usize * h as usize * 4 {
            return Err(AiError::bad_request("No image to edit."));
        }
        let (provider, model) = self.prepare(&req.choice, ModelKind::Image, cancelled)?;
        let (sw, sh) = region::fit_within(w, h, provider.max_edge());
        let small = region::resize_rgba8(&req.image, sw, sh);
        let small_mask = req.mask.as_ref().map(|m| region::resize_rgba8(m, sw, sh));
        let (aspect, fill) = provider.edit_frame(&model, sw, sh);
        let (image, mask, at) = region::pad_to_aspect(&small, small_mask.as_ref(), aspect, fill);
        let (pw, ph) = (image.width, image.height);
        let prompt =
            if req.transparent && !provider.native_transparency(&model) { format!("{}\n\n{WHITE_BACKGROUND}", req.prompt) } else { req.prompt.clone() };
        let answer = provider.edit_image(&model, &EditRequest { prompt, image, mask, transparent: req.transparent }, cancelled)?;
        check(cancelled)?;
        let answer = region::crop(&region::resize_rgba8(&answer, pw, ph), at);
        Ok(region::resize_rgba8(&answer, w, h))
    }

    fn generate(&self, req: &ImageGen, cancelled: Cancelled<'_>) -> Result<Rgba8Image> {
        let (w, h) = (req.width.max(1), req.height.max(1));
        let (provider, model) = self.prepare(&req.choice, ModelKind::Image, cancelled)?;
        let keyed = req.transparent && !provider.native_transparency(&model);
        let prompt = if keyed { format!("{}\n\n{WHITE_BACKGROUND}", req.prompt) } else { req.prompt.clone() };
        let mut answer = provider.generate_image(&model, &ImageRequest { prompt, width: w, height: h, transparent: req.transparent }, cancelled)?;
        check(cancelled)?;
        if keyed && region::is_opaque(&answer) {
            region::key_white_border(&mut answer, KEY_THRESHOLD);
        }
        Ok(region::cover_to(&answer, w, h))
    }

    fn chat_round(&self, req: &ChatRequest, cancelled: Cancelled<'_>) -> Result<ChatTurn> {
        let (provider, model) = self.prepare(&req.choice, ModelKind::Chat, cancelled)?;
        let turn = provider.chat(&model, req, cancelled)?;
        check(cancelled)?;
        Ok(turn)
    }

    fn models(&self, p: ProviderId, cancelled: Cancelled<'_>) -> Result<Vec<ModelEntry>> {
        check(cancelled)?;
        let provider = {
            let mut a = lock(self.accounts());
            a.reload();
            self.allowed(&a)?;
            a.provider(p)?
        };
        let models = provider.list_models(cancelled)?;
        let entries = models.iter().map(|m| (m.id.clone(), m.kind.engine_id())).collect();
        lock(self.accounts()).cache_catalog(p, models);
        Ok(entries)
    }
}

/// An engine error back as ours (the engine's checks before sending).
fn from_gen(e: GenError) -> AiError {
    let kind = match e.kind {
        generative::kind::NEEDS_CONSENT => ErrorKind::NeedsConsent,
        generative::kind::MISSING_KEY => ErrorKind::MissingKey,
        generative::kind::CANCELLED => ErrorKind::Cancelled,
        _ => ErrorKind::BadRequest,
    };
    AiError::new(kind, e.message).with_status(e.status)
}

/// What the engine needs to know about `a`. No secrets: the hint is the key's last four
/// characters at most.
fn status_of(a: &AiAccounts) -> BackendStatus {
    let providers = a
        .status()
        .into_iter()
        .map(|s| ProviderStatus {
            id: s.provider,
            label: s.label.to_string(),
            connected: s.connected,
            hint: (!s.hint.is_empty()).then(|| format!("…{}", s.hint)),
            store: Some(s.backend.to_string()),
            // An API key runs image and chat models; a ChatGPT sign-in chat models only.
            image_capable: s.method == Some(Method::ApiKey),
            chat_capable: s.connected,
            image_model: Some(s.image_model),
            chat_model: Some(s.chat_model),
        })
        .collect();
    BackendStatus { providers, default_provider: a.default_provider(), consented: a.settings.consented }
}

impl GenerativeBackend for GenAiBackend {
    fn status(&self) -> BackendStatus {
        let mut a = lock(self.accounts());
        a.reload();
        status_of(&a)
    }

    /// The caller check, before the job starts (it is made again before sending). The person's
    /// interface holds its agents to "Allow agents to run AI commands" itself (`ai_ui`).
    fn admit(&self, _automated: bool) -> std::result::Result<(), GenError> {
        let mut a = lock(self.accounts());
        a.reload();
        self.allowed(&a).map_err(GenError::from)
    }

    fn edit_image(&self, req: &ImageEdit, cancelled: &dyn Fn() -> bool) -> std::result::Result<Rgba8Image, GenError> {
        self.edit(req, cancelled).map_err(GenError::from)
    }

    fn generate_image(&self, req: &ImageGen, cancelled: &dyn Fn() -> bool) -> std::result::Result<Rgba8Image, GenError> {
        self.generate(req, cancelled).map_err(GenError::from)
    }

    fn describe(&self, req: &Describe, cancelled: &dyn Fn() -> bool) -> std::result::Result<String, GenError> {
        let turn = self.chat_round(&crate::chat::describe_request(req), cancelled).map_err(GenError::from)?;
        Ok(turn.text.trim().to_string())
    }

    fn chat(&self, req: &ChatRequest, cancelled: &dyn Fn() -> bool) -> std::result::Result<ChatTurn, GenError> {
        self.chat_round(req, cancelled).map_err(GenError::from)
    }

    fn list_models(&self, provider: ProviderId, cancelled: &dyn Fn() -> bool) -> std::result::Result<Vec<ModelEntry>, GenError> {
        self.models(provider, cancelled).map_err(GenError::from)
    }
}
