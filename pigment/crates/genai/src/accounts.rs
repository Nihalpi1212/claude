//! AI Accounts: which providers have a key, which one is preferred, their models, consent and
//! whether agents may run AI commands. What AI Accounts, `ai.status`, the control protocol and MCP
//! show comes from [`AiAccounts::status`], which says whether a key is stored and never what it is.
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

/// One provider's row in AI Accounts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub provider: ProviderId,
    pub label: &'static str,
    /// A key is stored (and readable).
    pub connected: bool,
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
    store: Box<dyn SecretStore>,
    pub settings: AiSettings,
    /// Where `ai.json` is saved and re-read; `None`: settings are kept for the session only.
    config_dir: Option<PathBuf>,
    base_urls: BTreeMap<&'static str, String>,
    catalogs: BTreeMap<&'static str, (Instant, Vec<ModelInfo>)>,
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
        a
    }

    /// Accounts with keys in memory and nothing saved (tests, sessions without preferences).
    pub fn in_memory() -> Self {
        Self::with_store(Box::new(MemoryStore::default()), AiSettings::default(), None)
    }

    pub fn with_store(store: Box<dyn SecretStore>, settings: AiSettings, config_dir: Option<PathBuf>) -> Self {
        Self { store, settings, config_dir, base_urls: BTreeMap::new(), catalogs: BTreeMap::new() }
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

    /// Store `raw` (as pasted) as `p`'s key without asking the provider (shape checked only).
    pub fn set_key(&mut self, p: ProviderId, raw: &str) -> Result<()> {
        let key = ApiKey::new(raw)?;
        self.store.set(p, &key)?;
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
        self.catalogs.insert(p.id(), (Instant::now(), models));
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
        self.catalogs.remove(p.id());
        log::info!("genai: removed the API key for {}", p.id());
        Ok(())
    }

    /// The provider requests that name none use: the preferred provider when it has a key, else
    /// the first provider with a key, else the preferred one (whose requests then report the
    /// missing key).
    pub fn default_provider(&self) -> Option<ProviderId> {
        let chosen = self.settings.default_provider;
        if chosen.is_some_and(|p| self.has_key(p)) {
            return chosen;
        }
        ProviderId::ALL.into_iter().find(|p| self.has_key(*p)).or(chosen)
    }

    /// AI Accounts' "Preferred provider": also where the feature windows start (JS resets
    /// `imageProvider` and `chatProvider` with it).
    pub fn set_default_provider(&mut self, p: ProviderId) -> Result<()> {
        self.settings.default_provider = Some(p);
        self.settings.image_provider = Some(p);
        self.settings.chat_provider = Some(p);
        self.save()
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
        let models = self.settings.models_mut(p);
        if let Some(c) = chat {
            models.chat_model = c;
        }
        if let Some(i) = image {
            models.image_model = i;
        }
        self.save()
    }

    /// Record that the person agreed to send prompts and images to their provider (or withdrew).
    pub fn set_consented(&mut self, yes: bool) -> Result<()> {
        self.settings.consented = yes;
        self.save()
    }

    /// "Allow agents to run AI commands".
    pub fn set_allow_agents(&mut self, yes: bool) -> Result<()> {
        self.settings.allow_agents = yes;
        self.save()
    }

    pub fn save(&self) -> Result<()> {
        match &self.config_dir {
            Some(d) => self.settings.save(d),
            None => Ok(()),
        }
    }

    /// `p`'s catalog when one was read in the last ten minutes.
    pub fn cached_catalog(&self, p: ProviderId) -> Option<&[ModelInfo]> {
        self.catalogs.get(p.id()).filter(|(at, _)| at.elapsed() < CATALOG_TTL).map(|(_, m)| m.as_slice())
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
                let (chat_model, chat_model_automatic) = self.shown_model(p, ModelKind::Chat);
                let (image_model, image_model_automatic) = self.shown_model(p, ModelKind::Image);
                AccountStatus {
                    provider: p,
                    label: p.label(),
                    connected: key.is_some(),
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

    fn build(&self, p: ProviderId, key: ApiKey) -> Result<Arc<dyn Provider>> {
        let mut cfg = self.settings.provider_config(p);
        if let Some(url) = self.base_urls.get(p.id()) {
            cfg.base_url = url.clone();
        }
        provider::build(cfg, key)
    }

    /// `p` with its stored key.
    pub fn provider(&self, p: ProviderId) -> Result<Arc<dyn Provider>> {
        let key = self.store.get(p)?.ok_or_else(|| missing(p))?;
        self.build(p, key)
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
