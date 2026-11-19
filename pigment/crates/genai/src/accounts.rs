//! AI Accounts: which providers have a key, which one is preferred, their models, consent and
//! whether agents may run AI commands. What AI Accounts, `ai.status`, the control protocol and MCP
//! show comes from [`AiAccounts::status`], which says whether a key is stored and never what it is.
//!
//! OpenAI is connected with an API key **or** with a ChatGPT sign-in ([`crate::chatgpt`],
//! experimental, chat models only), never both: storing a key drops the sign-in and signing in
//! drops the key, as in the JavaScript app. [`Method`] says which.
//!
//! Models chosen as "automatic" (`null` in `ai.json`) resolve as JavaScript Pigment's did: the
//! first preferred model the provider's catalog lists. The catalog is fetched once and kept for ten
//! minutes ([`CATALOG_TTL`]); without one, a known model is used ([`provider::fallback_model`]).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::cancel::Cancelled;
use crate::chatgpt::{self, ChatGpt, SignInStatus};
use crate::keys::{ApiKey, MemoryStore, SecretStore, default_store};
use crate::provider::{self, ModelInfo, ModelKind, Provider, is_loopback};
use crate::{AiError, AiSettings, ErrorKind, ProviderId, Result};

/// How long a model catalog is trusted (JS: 10 minutes).
pub const CATALOG_TTL: Duration = Duration::from_secs(600);

/// `PIGMENT_AI_BASE_URL_OPENAI` / `PIGMENT_AI_BASE_URL_GEMINI`: a loopback address to send requests
/// to instead of the provider (the end-to-end tests' mock server, a local gateway). Anything that
/// is not loopback is ignored, so the variable can't send a key to another host.
pub fn base_url_env(p: ProviderId) -> &'static str {
    match p {
        ProviderId::OpenAi => "PIGMENT_AI_BASE_URL_OPENAI",
        ProviderId::Gemini => "PIGMENT_AI_BASE_URL_GEMINI",
    }
}

/// How a provider is connected.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Method {
    /// The person's API key: chat and image models.
    ApiKey,
    /// A ChatGPT sign-in (OpenAI only): chat models only.
    Chatgpt,
}

/// One provider's row in AI Accounts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub provider: ProviderId,
    pub label: &'static str,
    /// A key (or a ChatGPT sign-in) is stored and readable.
    pub connected: bool,
    /// How: an API key or a ChatGPT sign-in. `None` when not connected.
    pub method: Option<Method>,
    /// The e-mail address of a ChatGPT sign-in, when the sign-in named one.
    pub email: Option<String>,
    /// A ChatGPT sign-in: whether the plan may be used from this app (`false`: "plan access not
    /// granted"). `None` with a key, or when the sign-in did not say.
    pub plan: Option<bool>,
    /// The key's last four characters (empty for short keys or without one).
    pub hint: String,
    /// Where keys are kept ("macOS Keychain", "Windows Credential Manager", "a file only you can
    /// read", "memory").
    pub backend: &'static str,
    /// Requests that name no provider go here first.
    pub is_default: bool,
    /// The chat model requests use, and whether it is chosen automatically.
    pub chat_model: String,
    pub chat_model_automatic: bool,
    pub image_model: String,
    pub image_model_automatic: bool,
}

pub struct AiAccounts {
    store: Arc<dyn SecretStore>,
    pub settings: AiSettings,
    /// Where `ai.json` is saved and re-read; `None`: settings are kept for the session only.
    config_dir: Option<PathBuf>,
    base_urls: BTreeMap<&'static str, String>,
    /// Each provider's catalog: when it was read, and for OpenAI under which credential
    /// ([`ChatGpt::generation`]: a key's catalog is not a sign-in's).
    catalogs: BTreeMap<&'static str, (Instant, u64, Vec<ModelInfo>)>,
    /// The ChatGPT sign-in over the same key store, shared with the providers built for it and
    /// with the interface.
    chatgpt: Arc<ChatGpt>,
}

impl AiAccounts {
    /// Pigment's accounts: keys in the platform store, settings in `config_dir`, and the base-URL
    /// variables honoured (loopback only).
    pub fn new(config_dir: &Path) -> Self {
        let mut a = Self::with_store(default_store(config_dir), AiSettings::load(config_dir), Some(config_dir.to_path_buf()));
        for p in ProviderId::ALL {
            if let Ok(url) = std::env::var(base_url_env(p))
                && a.set_base_url(p, &url).is_err()
            {
                log::warn!("genai: {} is not a loopback address; ignored", base_url_env(p));
            }
        }
        if let Ok(url) = std::env::var(chatgpt::AUTH_URL_ENV)
            && a.chatgpt.set_auth_base(&url).is_err()
        {
            log::warn!("genai: {} is not a loopback address; ignored", chatgpt::AUTH_URL_ENV);
        }
        a
    }

    /// Accounts with keys in memory and nothing saved (tests, sessions without preferences).
    pub fn in_memory() -> Self {
        Self::with_store(Box::new(MemoryStore::default()), AiSettings::default(), None)
    }

    pub fn with_store(store: Box<dyn SecretStore>, settings: AiSettings, config_dir: Option<PathBuf>) -> Self {
        let store: Arc<dyn SecretStore> = Arc::from(store);
        let chatgpt = Arc::new(ChatGpt::new(Arc::clone(&store)));
        chatgpt.set_enabled(settings.chatgpt_sign_in);
        Self { store, settings, config_dir, base_urls: BTreeMap::new(), catalogs: BTreeMap::new(), chatgpt }
    }

    /// The ChatGPT sign-in of these accounts: its attempt in progress, the manual completion,
    /// Cancel. Starting one is [`AiAccounts::sign_in`], ending one [`AiAccounts::sign_out`].
    pub fn chatgpt(&self) -> &Arc<ChatGpt> {
        &self.chatgpt
    }

    pub fn config_dir(&self) -> Option<&Path> {
        self.config_dir.as_deref()
    }

    /// Re-read `ai.json`, so a long-running server sees what the person changed in AI Accounts
    /// (consent, "Allow agents", models). Settings kept only in memory stay as they are.
    pub fn reload(&mut self) {
        if let Some(d) = &self.config_dir {
            self.settings = AiSettings::load(d);
        }
        self.chatgpt.set_enabled(self.settings.chatgpt_sign_in);
    }

    /// Send `p`'s requests to `url`, which must be a loopback address.
    pub fn set_base_url(&mut self, p: ProviderId, url: &str) -> Result<()> {
        if !is_loopback(url) {
            return Err(AiError::bad_request("Only a loopback address can replace the provider's address."));
        }
        self.base_urls.insert(p.id(), url.trim_end_matches('/').to_string());
        Ok(())
    }

    /// Where keys are kept, for AI Accounts.
    pub fn store_backend(&self) -> &'static str {
        self.store.backend()
    }

    pub fn has_key(&self, p: ProviderId) -> bool {
        matches!(self.store.get(p), Ok(Some(_)))
    }

    /// How `p` is connected: with a key, or (OpenAI, without a key) with a ChatGPT sign-in.
    pub fn method(&self, p: ProviderId) -> Option<Method> {
        if self.has_key(p) {
            Some(Method::ApiKey)
        } else if p == ProviderId::OpenAi && self.chatgpt.signed_in().is_some() {
            Some(Method::Chatgpt)
        } else {
            None
        }
    }

    /// `p` has a key or a sign-in.
    pub fn connected(&self, p: ProviderId) -> bool {
        self.method(p).is_some()
    }

    /// Start Sign in with ChatGPT (or return the attempt in progress): binds the loopback
    /// listener and gives the address to open in a browser. `port`: the loopback port to try
    /// first. The installation id is made and saved the first time.
    pub fn sign_in(&mut self, port: Option<u16>) -> Result<SignInStatus> {
        if !self.chatgpt.enabled() {
            return self.chatgpt.start(port, "");
        }
        self.reload();
        let host_id = match self.settings.host_id.clone().filter(|h| h.starts_with("urn:uuid:")) {
            Some(h) => h,
            None => {
                let h = chatgpt::new_host_id()?;
                if let Err(e) = self.update(|s| s.host_id = Some(h.clone())) {
                    log::warn!("genai: could not save the installation id ({})", e.kind.id());
                }
                h
            }
        };
        self.chatgpt.start(port, &host_id)
    }

    /// Sign out of ChatGPT: the tokens are removed from the key store and an attempt in progress
    /// ends. Nothing is revoked at OpenAI.
    pub fn sign_out(&mut self) -> Result<()> {
        self.chatgpt.sign_out()?;
        self.catalogs.remove(ProviderId::OpenAi.id());
        log::info!("genai: signed out of ChatGPT");
        Ok(())
    }

    /// Store `raw` (as pasted) as `p`'s key without asking the provider (shape checked only).
    /// An OpenAI key replaces a ChatGPT sign-in.
    pub fn set_key(&mut self, p: ProviderId, raw: &str) -> Result<()> {
        let key = ApiKey::new(raw)?;
        self.store.set(p, &key)?;
        if p == ProviderId::OpenAi {
            self.chatgpt.sign_out()?;
        }
        self.catalogs.remove(p.id());
        log::info!("genai: stored an API key for {} in the {}", p.id(), self.store.backend());
        Ok(())
    }

    /// The provider `p` with the key `raw`, unsaved: for checking a key before it is stored.
    pub fn provider_with_key(&self, p: ProviderId, raw: &str) -> Result<Arc<dyn Provider>> {
        self.build(p, ApiKey::new(raw)?)
    }

    /// Remember `p`'s catalog (from a key check or Test Connection).
    pub fn cache_catalog(&mut self, p: ProviderId, models: Vec<ModelInfo>) {
        self.catalogs.insert(p.id(), (Instant::now(), self.credential(p), models));
    }

    /// Which credential `p` has now, as a count that changes when it is replaced.
    fn credential(&self, p: ProviderId) -> u64 {
        if p == ProviderId::OpenAi { self.chatgpt.generation() } else { 0 }
    }

    /// Check `raw` with the provider (it lists its models), then store it: JavaScript Pigment's
    /// Connect. A key the provider refuses is not stored. Blocks: run it off the interface thread.
    pub fn connect(&mut self, p: ProviderId, raw: &str, cancelled: Cancelled<'_>) -> Result<Vec<ModelInfo>> {
        let models = self.provider_with_key(p, raw)?.list_models(cancelled)?;
        self.set_key(p, raw)?;
        self.cache_catalog(p, models.clone());
        Ok(models)
    }

    pub fn clear_key(&mut self, p: ProviderId) -> Result<()> {
        self.store.clear(p)?;
        if p == ProviderId::OpenAi && self.chatgpt.signed_in().is_none() {
            // Ends a sign-in attempt in progress, as the JavaScript app's Sign out did.
            self.chatgpt.cancel();
        }
        self.catalogs.remove(p.id());
        log::info!("genai: removed the API key for {}", p.id());
        Ok(())
    }

    /// The provider requests that name none use: the preferred provider when it is connected
    /// (a key or a sign-in), else the first connected provider, else the preferred one (whose
    /// requests then report the missing key). A request for a kind of model the provider can't
    /// serve (images with a sign-in) goes to the next that can (the engine's `resolve_provider`).
    pub fn default_provider(&self) -> Option<ProviderId> {
        let chosen = self.settings.default_provider;
        if chosen.is_some_and(|p| self.connected(p)) {
            return chosen;
        }
        ProviderId::ALL.into_iter().find(|p| self.connected(*p)).or(chosen)
    }

    /// AI Accounts' "Preferred provider": also where the feature windows start (JS resets
    /// `imageProvider` and `chatProvider` with it).
    pub fn set_default_provider(&mut self, p: ProviderId) -> Result<()> {
        self.update(|s| {
            s.default_provider = Some(p);
            s.image_provider = Some(p);
            s.chat_provider = Some(p);
        })
    }

    /// Choose `p`'s models: `None` keeps one, an empty string makes it automatic.
    pub fn set_models(&mut self, p: ProviderId, chat: Option<&str>, image: Option<&str>) -> Result<()> {
        let pick = |m: &str| -> Result<Option<String>> {
            let m = m.trim();
            if m.is_empty() {
                return Ok(None);
            }
            provider::check_model_id(m)?;
            Ok(Some(m.to_string()))
        };
        let chat = chat.map(pick).transpose()?;
        let image = image.map(pick).transpose()?;
        self.update(|s| {
            let models = s.models_mut(p);
            if let Some(c) = chat {
                models.chat_model = c;
            }
            if let Some(i) = image {
                models.image_model = i;
            }
        })
    }

    /// Record that the person agreed to send prompts and images to their provider (or withdrew).
    pub fn set_consented(&mut self, yes: bool) -> Result<()> {
        self.update(|s| s.consented = yes)
    }

    /// "Allow agents to run AI commands".
    pub fn set_allow_agents(&mut self, yes: bool) -> Result<()> {
        self.update(|s| s.allow_agents = yes)
    }

    /// Change one setting and save: `ai.json` is read again first, so what another process (the
    /// command line's `ai agents off`, `ai consent --revoke`) or another window wrote since this
    /// one last read it is kept, and only what `f` changes is written over it.
    pub fn update(&mut self, f: impl FnOnce(&mut AiSettings)) -> Result<()> {
        self.reload();
        f(&mut self.settings);
        self.save()
    }

    /// Save the settings held in memory as they are, over whatever `ai.json` holds now. To change
    /// a setting, use [`AiAccounts::update`], which keeps other processes' changes.
    pub fn save(&self) -> Result<()> {
        match &self.config_dir {
            Some(d) => self.settings.save(d),
            None => Ok(()),
        }
    }

    /// `p`'s catalog when one was read in the last ten minutes.
    pub fn cached_catalog(&self, p: ProviderId) -> Option<&[ModelInfo]> {
        let credential = self.credential(p);
        self.catalogs.get(p.id()).filter(|(at, c, _)| at.elapsed() < CATALOG_TTL && *c == credential).map(|(_, _, m)| m.as_slice())
    }

    /// The model requests of `kind` to `p` use, without asking the provider: the person's choice,
    /// else the cached catalog's pick, else `None` (the backend then reads the catalog).
    pub fn known_model(&self, p: ProviderId, kind: ModelKind) -> Option<String> {
        self.settings.chosen_model(p, kind).map(str::to_string).or_else(|| self.cached_catalog(p).and_then(|c| provider::pick_model(p, c, kind)))
    }

    /// The model AI Accounts shows, and whether it is chosen automatically.
    pub fn shown_model(&self, p: ProviderId, kind: ModelKind) -> (String, bool) {
        match self.settings.chosen_model(p, kind) {
            Some(m) => (m.to_string(), false),
            None => (self.known_model(p, kind).unwrap_or_else(|| provider::fallback_model(p, kind).to_string()), true),
        }
    }

    pub fn status(&self) -> Vec<AccountStatus> {
        let default = self.default_provider();
        ProviderId::ALL
            .into_iter()
            .map(|p| {
                let key = self.store.get(p).ok().flatten();
                let sign_in = if key.is_none() && p == ProviderId::OpenAi { self.chatgpt.signed_in() } else { None };
                let method = if key.is_some() { Some(Method::ApiKey) } else { sign_in.as_ref().map(|_| Method::Chatgpt) };
                let (chat_model, chat_model_automatic) = self.shown_model(p, ModelKind::Chat);
                let (image_model, image_model_automatic) = self.shown_model(p, ModelKind::Image);
                AccountStatus {
                    provider: p,
                    label: p.label(),
                    connected: method.is_some(),
                    method,
                    email: sign_in.as_ref().and_then(|s| s.email.clone()),
                    plan: sign_in.as_ref().and_then(|s| s.plan),
                    hint: key.map(|k| k.hint()).unwrap_or_default(),
                    backend: self.store.backend(),
                    is_default: default == Some(p),
                    chat_model,
                    chat_model_automatic,
                    image_model,
                    image_model_automatic,
                }
            })
            .collect()
    }

    /// How `p` is reached: the settings' timeout, and the loopback address standing in for it.
    fn config(&self, p: ProviderId) -> provider::ProviderConfig {
        let mut cfg = self.settings.provider_config(p);
        if let Some(url) = self.base_urls.get(p.id()) {
            cfg.base_url = url.clone();
        }
        cfg
    }

    fn build(&self, p: ProviderId, key: ApiKey) -> Result<Arc<dyn Provider>> {
        provider::build(self.config(p), key)
    }

    /// `p` with its stored key, or OpenAI with the ChatGPT sign-in when it has no key.
    pub fn provider(&self, p: ProviderId) -> Result<Arc<dyn Provider>> {
        if let Some(key) = self.store.get(p)? {
            return self.build(p, key);
        }
        if p == ProviderId::OpenAi && self.chatgpt.signed_in().is_some() {
            return provider::build_signed_in(self.config(p), Arc::clone(&self.chatgpt));
        }
        Err(missing(p))
    }

    /// Ask `p` for its models with the stored key: the key works when this does. Blocks; the
    /// interface runs it as a job (`ai.testConnection`).
    pub fn test_connection(&mut self, p: ProviderId, cancelled: Cancelled<'_>) -> Result<Vec<ModelInfo>> {
        let models = self.provider(p)?.list_models(cancelled)?;
        self.cache_catalog(p, models.clone());
        Ok(models)
    }
}

pub(crate) fn missing(p: ProviderId) -> AiError {
    AiError::new(ErrorKind::MissingKey, format!("{} is not connected. Add an API key in Edit › AI Accounts…", p.label()))
}
