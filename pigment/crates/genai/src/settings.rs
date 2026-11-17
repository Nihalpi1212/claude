//! AI settings: the preferred provider, each provider's models, consent, whether agents may run
//! AI commands, and the last prompt of each feature. Kept in [`SETTINGS_FILE`] in Pigment's config
//! folder, apart from the app preferences (the engine's preferences never hold AI settings).
//!
//! Never holds a key (keys are in [`crate::keys`]), and never a base URL: a settings file can't
//! send a key elsewhere. The fields follow the JavaScript Pigment's `ai` settings
//! (`openaiChat`, `defaultProvider`, `imageProvider`, `lastSkyPrompt`, …), regrouped:
//!
//! ```json
//! {"defaultProvider":"openai","imageProvider":null,"chatProvider":null,
//!  "openai":{"chatModel":null,"imageModel":null},"gemini":{"chatModel":null,"imageModel":null},
//!  "timeoutSecs":300,"consented":false,"allowAgents":false,
//!  "lastFillPrompt":null,"lastExpandPrompt":null,"lastGeneratePrompt":null,
//!  "lastBackgroundPrompt":null,"lastSkyPrompt":null,"assistantAttach":true}
//! ```
//!
//! A model of `null` means "automatic": the first of the provider's preferred models its catalog
//! lists ([`crate::provider::pick_model`]), as JavaScript Pigment chose when nothing was saved.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::provider::{self, ModelKind, ProviderConfig};
use crate::{AiError, ErrorKind, ProviderId, Result};

pub const SETTINGS_FILE: &str = "ai.json";
/// Largest settings file read (five prompts of 4000 characters fit many times over).
const MAX_FILE: u64 = 256 * 1024;

/// One provider's chosen models; `None` = automatic.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Models {
    pub chat_model: Option<String>,
    pub image_model: Option<String>,
}

impl Models {
    pub fn get(&self, kind: ModelKind) -> Option<&str> {
        match kind {
            ModelKind::Chat => self.chat_model.as_deref(),
            ModelKind::Image => self.image_model.as_deref(),
            ModelKind::Other => None,
        }
    }
}

/// The features that remember their last prompt (JS `lastFillPrompt` …).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptFeature {
    Fill,
    Expand,
    Generate,
    Background,
    Sky,
}

impl PromptFeature {
    /// The feature of an `ai.*` command id, if it remembers prompts.
    pub fn of_command(id: &str) -> Option<Self> {
        Some(match id {
            "ai.generativeFill" => Self::Fill,
            "ai.generativeExpand" => Self::Expand,
            "ai.generateImage" => Self::Generate,
            "ai.replaceBackground" => Self::Background,
            "ai.replaceSky" => Self::Sky,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiSettings {
    /// AI Accounts' "Preferred provider": tried first by a request that names none. `None`: the
    /// first provider with a key.
    pub default_provider: Option<ProviderId>,
    /// The provider the last image-feature window used (JS `imageProvider`); a window starts there.
    pub image_provider: Option<ProviderId>,
    /// The provider the last chat window used (JS `chatProvider`).
    pub chat_provider: Option<ProviderId>,
    pub openai: Models,
    pub gemini: Models,
    /// Seconds an image request may take (10–600). Model lists take at most 30 s.
    pub timeout_secs: u64,
    /// The person agreed, once, that the AI commands send their prompt and, where a feature needs
    /// it, the image or selection to the provider they chose. Nothing is sent before.
    pub consented: bool,
    /// Agents (MCP, the control channel, `pigment-cli serve`) may run AI commands, which are
    /// billed to the person's account. Off until the person turns it on in AI Accounts.
    pub allow_agents: bool,
    pub last_fill_prompt: Option<String>,
    pub last_expand_prompt: Option<String>,
    pub last_generate_prompt: Option<String>,
    pub last_background_prompt: Option<String>,
    pub last_sky_prompt: Option<String>,
    /// The Assistant's "Attach image": send a downscaled copy of the image with each message
    /// (JS `assistantAttach`; on until the person turns it off).
    pub assistant_attach: bool,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            default_provider: None,
            image_provider: None,
            chat_provider: None,
            openai: Models::default(),
            gemini: Models::default(),
            timeout_secs: provider::DEFAULT_TIMEOUT.as_secs(),
            consented: false,
            allow_agents: false,
            last_fill_prompt: None,
            last_expand_prompt: None,
            last_generate_prompt: None,
            last_background_prompt: None,
            last_sky_prompt: None,
            assistant_attach: true,
        }
    }
}

impl AiSettings {
    pub fn path(config_dir: &Path) -> PathBuf {
        config_dir.join(SETTINGS_FILE)
    }

    /// The settings in `config_dir`; the defaults when there are none or they can't be read.
    pub fn load(config_dir: &Path) -> Self {
        let p = Self::path(config_dir);
        match std::fs::metadata(&p) {
            Ok(m) if m.len() <= MAX_FILE => {}
            _ => return Self::default(),
        }
        std::fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    /// Written atomically (a temporary file renamed over the old one).
    pub fn save(&self, config_dir: &Path) -> Result<()> {
        let err = |e: &dyn std::fmt::Display| AiError::new(ErrorKind::KeyStore, format!("Pigment could not save the AI settings: {e}."));
        std::fs::create_dir_all(config_dir).map_err(|e| err(&e))?;
        let text = serde_json::to_string_pretty(self).map_err(|e| err(&e))?;
        let tmp = config_dir.join(format!(".{SETTINGS_FILE}.{}.tmp", std::process::id()));
        std::fs::write(&tmp, text).map_err(|e| err(&e))?;
        std::fs::rename(&tmp, Self::path(config_dir)).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            err(&e)
        })
    }

    pub fn models(&self, p: ProviderId) -> &Models {
        match p {
            ProviderId::OpenAi => &self.openai,
            ProviderId::Gemini => &self.gemini,
        }
    }

    pub fn models_mut(&mut self, p: ProviderId) -> &mut Models {
        match p {
            ProviderId::OpenAi => &mut self.openai,
            ProviderId::Gemini => &mut self.gemini,
        }
    }

    /// The model the person chose for `p` and `kind`, if any (`None`: automatic).
    pub fn chosen_model(&self, p: ProviderId, kind: ModelKind) -> Option<&str> {
        self.models(p).get(kind).map(str::trim).filter(|m| !m.is_empty())
    }

    /// The last prompt `feature` ran with.
    pub fn last_prompt(&self, feature: PromptFeature) -> Option<&str> {
        match feature {
            PromptFeature::Fill => self.last_fill_prompt.as_deref(),
            PromptFeature::Expand => self.last_expand_prompt.as_deref(),
            PromptFeature::Generate => self.last_generate_prompt.as_deref(),
            PromptFeature::Background => self.last_background_prompt.as_deref(),
            PromptFeature::Sky => self.last_sky_prompt.as_deref(),
        }
    }

    /// Remember `prompt` (trimmed, cut to the engine's 4000 characters; empty forgets it).
    pub fn set_last_prompt(&mut self, feature: PromptFeature, prompt: &str) {
        let text: String = prompt.trim().chars().take(photocraft_engine::ai_cmds::PROMPT_LIMIT).collect();
        let v = (!text.is_empty()).then_some(text);
        match feature {
            PromptFeature::Fill => self.last_fill_prompt = v,
            PromptFeature::Expand => self.last_expand_prompt = v,
            PromptFeature::Generate => self.last_generate_prompt = v,
            PromptFeature::Background => self.last_background_prompt = v,
            PromptFeature::Sky => self.last_sky_prompt = v,
        }
    }

    /// How requests to `p` are made: its address and the request timeout.
    pub fn provider_config(&self, p: ProviderId) -> ProviderConfig {
        let mut cfg = ProviderConfig::new(p);
        cfg.timeout = std::time::Duration::from_secs(self.timeout_secs.clamp(10, 600));
        cfg
    }
}
