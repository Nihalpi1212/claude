//! Nib's generative AI: Text to Vector Graphic, Generative Recolor, Generative Shape Fill,
//! Generative Pattern, Generative Expand and Rewrite Text, run with the user's own OpenAI or
//! Google Gemini API key, straight from the user's machine to the provider they chose.
//!
//! The contract is `docs/generative-ai.md`. In short:
//!
//! * [`provider`]: the [`Provider`] trait and its OpenAI and Gemini implementations (blocking HTTP
//!   on a worker thread, timeouts, cancellation, a response size cap, readable [`AiError`]s).
//! * [`keys`] and [`accounts`]: API keys live in the OS credential store (macOS Keychain, Windows
//!   Credential Manager) or in a 0600 file in Nib's config folder, never in documents,
//!   preferences, logs, crash reports, MCP output or the control protocol.
//! * [`ops`]: the six features as three steps each: *prepare* reads the document on the UI thread,
//!   *run* talks to the provider on a worker thread, *apply* places the chosen result as one undo
//!   step through the engine's ordinary commands.
//! * [`jobs`] and [`GenAi`]: pending jobs, cancellation, and results handed back to the UI thread.
//!
//! Native only: the browser build has no AI commands, so this crate is empty on wasm32.
#![cfg(not(target_arch = "wasm32"))]
#![forbid(unsafe_code)]

pub mod accounts;
pub mod cancel;
pub mod error;
pub mod fit;
mod genai;
mod http;
pub mod image_util;
pub mod jobs;
pub mod keys;
pub mod ops;
pub mod palette;
pub mod prompts;
pub mod provider;
pub mod sanitize;
pub mod settings;

pub use accounts::{AccountStatus, AiAccounts};
pub use cancel::CancelToken;
pub use error::{AiError, ErrorKind};
pub use genai::GenAi;
pub use jobs::{JobEvent, JobId, JobInfo, Jobs};
pub use ops::{Applied, Feature, FeatureRequest, Generated, Prepared};
pub use provider::{Provider, ProviderConfig, ProviderKind};
pub use settings::AiSettings;

/// The result type of this crate.
pub type Result<T> = std::result::Result<T, AiError>;
