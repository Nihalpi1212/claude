//! AI Accounts: which providers have a key, which one is the default, and their models. What the
//! UI's AI Accounts dialog, the control protocol and MCP show comes from [`AiAccounts::status`],
//! which says whether a key is stored and never what it is.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;

use crate::keys::{ApiKey, MemoryStore, SecretStore, default_store};
use crate::provider::{ModelInfo, is_loopback};
use crate::{AiError, AiSettings, CancelToken, ErrorKind, Provider, ProviderKind, Result};

/// `NIB_AI_BASE_URL_OPENAI` / `NIB_AI_BASE_URL_GEMINI`: a loopback address to send requests to
/// instead of the provider (the end-to-end tests' mock server, a local gateway). Anything that is
/// not loopback is ignored, so the variable can't send a key to another host.
pub fn base_url_env(kind: ProviderKind) -> &'static str {
    match kind {
        ProviderKind::OpenAi => "NIB_AI_BASE_URL_OPENAI",
        ProviderKind::Gemini => "NIB_AI_BASE_URL_GEMINI",
    }
}

/// One provider's row in AI Accounts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub provider: ProviderKind,
    pub label: &'static str,
    /// A key is stored.
    pub connected: bool,
    /// The key's last four characters (empty for short keys or without one).
    pub hint: String,
    /// Where keys are kept ("macOS Keychain", "Windows Credential Manager", "file", "memory").
    pub backend: &'static str,
    /// The AI commands use this provider.
    pub is_default: bool,
    pub text_model: String,
    pub image_model: String,
}

pub struct AiAccounts {
    store: Box<dyn SecretStore>,
    pub settings: AiSettings,
    /// Where `ai.json` is saved; `None`: settings are kept for the session only.
    config_dir: Option<PathBuf>,
    base_urls: BTreeMap<ProviderKind, String>,
}

impl AiAccounts {
    /// Nib's accounts: keys in the platform store, settings in `config_dir`.
    pub fn new(config_dir: &Path) -> Self {
        let mut a = Self::with_store(default_store(config_dir), AiSettings::load(config_dir), Some(config_dir.to_path_buf()));
        for kind in ProviderKind::ALL {
            if let Ok(url) = std::env::var(base_url_env(kind)) {
                let _ = a.set_base_url(kind, &url);
            }
        }
        a
    }

    /// Accounts with keys in memory and nothing saved (tests, sessions without preferences).
    pub fn in_memory() -> Self {
        Self::with_store(Box::new(MemoryStore::default()), AiSettings::default(), None)
    }

    pub fn with_store(store: Box<dyn SecretStore>, settings: AiSettings, config_dir: Option<PathBuf>) -> Self {
        Self { store, settings, config_dir, base_urls: BTreeMap::new() }
    }

    /// Send `kind`'s requests to `url`, which must be a loopback address.
    pub fn set_base_url(&mut self, kind: ProviderKind, url: &str) -> Result<()> {
        if !is_loopback(url) {
            return Err(AiError::bad_request("Only a loopback address can replace the provider's address."));
        }
        self.base_urls.insert(kind, url.trim_end_matches('/').to_string());
        Ok(())
    }

    pub fn has_key(&self, kind: ProviderKind) -> bool {
        matches!(self.store.get(kind), Ok(Some(_)))
    }

    /// Store `raw` (as pasted) as `kind`'s key. It is checked for shape only; [`Self::test_connection`]
    /// checks it with the provider.
    pub fn set_key(&mut self, kind: ProviderKind, raw: &str) -> Result<()> {
        let key = ApiKey::new(raw)?;
        self.store.set(kind, &key)?;
        log::info!("genai: stored an API key for {} in the {}", kind.id(), self.store.backend());
        Ok(())
    }

    pub fn clear_key(&mut self, kind: ProviderKind) -> Result<()> {
        self.store.clear(kind)?;
        log::info!("genai: removed the API key for {}", kind.id());
        Ok(())
    }

    /// The provider the AI commands use: the chosen default when it has a key, else the first
    /// provider with a key, else the chosen default (whose requests then report the missing key).
    pub fn default_provider(&self) -> Option<ProviderKind> {
        let chosen = self.settings.default_provider;
        if chosen.is_some_and(|k| self.has_key(k)) {
            return chosen;
        }
        ProviderKind::ALL.into_iter().find(|k| self.has_key(*k)).or(chosen)
    }

    pub fn set_default_provider(&mut self, kind: ProviderKind) -> Result<()> {
        self.settings.default_provider = Some(kind);
        self.save()
    }

    /// Choose `kind`'s models (`None` keeps one; an empty string goes back to the default).
    pub fn set_models(&mut self, kind: ProviderKind, text: Option<&str>, image: Option<&str>) -> Result<()> {
        let m = self.settings.models_mut(kind);
        if let Some(t) = text {
            m.text = if t.trim().is_empty() { kind.default_text_model().into() } else { t.trim().into() };
        }
        if let Some(i) = image {
            m.image = if i.trim().is_empty() { kind.default_image_model().into() } else { i.trim().into() };
        }
        self.settings.provider_config(kind).validate()?;
        self.save()
    }

    /// Record that the person agreed to send prompts and artwork to their provider.
    pub fn set_consented(&mut self, yes: bool) -> Result<()> {
        self.settings.consented = yes;
        self.save()
    }

    pub fn save(&self) -> Result<()> {
        match &self.config_dir {
            Some(d) => self.settings.save(d),
            None => Ok(()),
        }
    }

    pub fn status(&self) -> Vec<AccountStatus> {
        let default = self.default_provider();
        ProviderKind::ALL
            .into_iter()
            .map(|kind| {
                let key = self.store.get(kind).ok().flatten();
                let m = self.settings.models(kind);
                AccountStatus {
                    provider: kind,
                    label: kind.label(),
                    connected: key.is_some(),
                    hint: key.map(|k| k.hint()).unwrap_or_default(),
                    backend: self.store.backend(),
                    is_default: default == Some(kind),
                    text_model: m.text.clone(),
                    image_model: m.image.clone(),
                }
            })
            .collect()
    }

    /// The provider for `kind` (default: [`Self::default_provider`]) with its stored key.
    pub fn provider(&self, kind: Option<ProviderKind>) -> Result<Arc<dyn Provider>> {
        let kind = kind.or_else(|| self.default_provider()).ok_or_else(missing_any)?;
        let key = self.store.get(kind)?.ok_or_else(|| missing(kind))?;
        let mut cfg = self.settings.provider_config(kind);
        if let Some(url) = self.base_urls.get(&kind) {
            cfg.base_url = url.clone();
        }
        crate::provider::build(cfg, key)
    }

    /// Ask the provider for its models with the stored key: the key works when this does. Blocks;
    /// run it as a job ([`crate::Jobs::spawn_test_connection`]) from the UI.
    pub fn test_connection(&self, kind: ProviderKind, cancel: &CancelToken) -> Result<Vec<ModelInfo>> {
        self.provider(Some(kind))?.list_models(cancel)
    }
}

pub(crate) fn missing(kind: ProviderKind) -> AiError {
    AiError::new(ErrorKind::MissingKey, format!("No {} API key is set. Add one in AI › AI Accounts.", kind.label()))
}

fn missing_any() -> AiError {
    AiError::new(ErrorKind::MissingKey, "No AI provider is set up. Add an OpenAI or Google Gemini API key in AI › AI Accounts.")
}
