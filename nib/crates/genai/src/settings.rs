//! AI preferences: the default provider and each provider's models. Kept in `ai.json` in Nib's
//! config folder, apart from the app preferences. Never holds a key (keys are in [`crate::keys`]),
//! and never a base URL: a settings file can't send a key elsewhere.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{AiError, ErrorKind, ProviderConfig, ProviderKind, Result};

pub const SETTINGS_FILE: &str = "ai.json";

/// One provider's models.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Models {
    pub text: String,
    pub image: String,
}

impl Models {
    pub fn defaults(kind: ProviderKind) -> Self {
        Self { text: kind.default_text_model().into(), image: kind.default_image_model().into() }
    }
}

impl Default for Models {
    fn default() -> Self {
        Self::defaults(ProviderKind::OpenAi)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiSettings {
    /// The provider the AI commands use; `None`: the first one with a key.
    pub default_provider: Option<ProviderKind>,
    pub openai: Models,
    pub gemini: Models,
    /// Seconds a request may take (10–600).
    pub timeout_secs: u64,
    /// Whether the person agreed that the AI commands send the prompt and, where a feature needs
    /// it, the selected artwork or image to the provider (asked once, in AI Accounts).
    pub consented: bool,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            default_provider: None,
            openai: Models::defaults(ProviderKind::OpenAi),
            gemini: Models::defaults(ProviderKind::Gemini),
            timeout_secs: crate::provider::DEFAULT_TIMEOUT.as_secs(),
            consented: false,
        }
    }
}

impl AiSettings {
    pub fn path(config_dir: &Path) -> PathBuf {
        config_dir.join(SETTINGS_FILE)
    }

    /// The settings in `config_dir`, the defaults when there are none or they can't be read.
    pub fn load(config_dir: &Path) -> Self {
        let p = Self::path(config_dir);
        match std::fs::metadata(&p) {
            Ok(m) if m.len() <= 64 * 1024 => {}
            _ => return Self::default(),
        }
        std::fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    /// Written atomically.
    pub fn save(&self, config_dir: &Path) -> Result<()> {
        let err = |e: &dyn std::fmt::Display| AiError::new(ErrorKind::KeyStore, format!("Nib could not save the AI settings: {e}."));
        std::fs::create_dir_all(config_dir).map_err(|e| err(&e))?;
        let text = serde_json::to_string_pretty(self).map_err(|e| err(&e))?;
        let tmp = config_dir.join(format!(".{SETTINGS_FILE}.{}.tmp", std::process::id()));
        std::fs::write(&tmp, text).map_err(|e| err(&e))?;
        std::fs::rename(&tmp, Self::path(config_dir)).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            err(&e)
        })
    }

    pub fn models(&self, kind: ProviderKind) -> &Models {
        match kind {
            ProviderKind::OpenAi => &self.openai,
            ProviderKind::Gemini => &self.gemini,
        }
    }

    pub fn models_mut(&mut self, kind: ProviderKind) -> &mut Models {
        match kind {
            ProviderKind::OpenAi => &mut self.openai,
            ProviderKind::Gemini => &mut self.gemini,
        }
    }

    /// The configuration requests to `kind` use.
    pub fn provider_config(&self, kind: ProviderKind) -> ProviderConfig {
        let m = self.models(kind);
        let mut cfg = ProviderConfig::new(kind);
        if !m.text.trim().is_empty() {
            cfg.text_model = m.text.trim().to_string();
        }
        if !m.image.trim().is_empty() {
            cfg.image_model = m.image.trim().to_string();
        }
        cfg.timeout = std::time::Duration::from_secs(self.timeout_secs.clamp(10, 600));
        cfg
    }
}
