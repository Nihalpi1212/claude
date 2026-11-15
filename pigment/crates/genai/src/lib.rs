//! Pigment's generative AI providers: OpenAI and Google Gemini, with the person's own API key,
//! called from their machine. Ported from Nib's `nib-genai` (the provider layer, HTTP, keys,
//! settings, consent and errors) and from the JavaScript Pigment's `providers.js` (the raster
//! request shapes, chat with function tools, Describe and the model catalogs).
//!
//! The engine never talks to the network: [`GenAiBackend`] implements
//! [`photocraft_engine::generative::GenerativeBackend`], and the desktop app, `pigment-cli` and the
//! headless MCP sessions install it with `Session::set_generative`. The contract is
//! `docs/generative-ai.md`. In short:
//!
//! * [`provider`]: the [`Provider`] trait and its [`provider::openai`] and [`provider::gemini`]
//!   implementations. Request bodies are built and answers parsed by pure functions, so the tests
//!   check them against recorded answers; HTTP is [`http`] (blocking, on the engine job's worker
//!   thread, bounded by a timeout and a size cap, stopped between chunks once cancelled).
//! * [`keys`], [`settings`] and [`accounts`]: API keys live in the OS credential store (macOS
//!   Keychain, Windows Credential Manager) or in a 0600 file in Pigment's config folder, never in
//!   documents, settings, logs, MCP output or the control protocol. `ai.json` holds the choices
//!   (provider, models, consent, `allowAgents`, the last prompt of each feature), never a key.
//! * [`backend`]: the engine trait, with the provider-specific pixel steps (scaling to the
//!   provider's edge, padding to its aspect ratio, its mask convention, keying a white background,
//!   resampling back) and who may send ([`Caller`]: the person, an agent, the command line).
//!
//! Native only: the browser build has no AI provider, so this crate is empty on wasm32.
#![cfg(not(target_arch = "wasm32"))]
#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unimplemented, clippy::todo, clippy::unreachable)]

pub mod accounts;
pub mod backend;
pub mod cancel;
pub mod chat;
pub mod error;
mod http;
pub mod image_util;
pub mod keys;
pub mod provider;
pub mod settings;

pub use accounts::{AccountStatus, AiAccounts};
pub use backend::{Caller, GenAiBackend};
pub use cancel::{CancelToken, Cancelled};
pub use error::{AiError, ErrorKind};
pub use photocraft_engine::generative::ProviderId;
pub use provider::{ModelInfo, ModelKind, Provider, ProviderConfig};
pub use settings::AiSettings;

/// The result type of this crate.
pub type Result<T> = std::result::Result<T, AiError>;
