//! Errors a person can act on. Every failure of a request, a key store or an operation becomes an
//! [`AiError`] whose message says what happened and what to do; its [`ErrorKind`] lets the UI pick a
//! button (open AI Accounts, try again). No message ever carries an API key: provider error bodies
//! are reduced to their message, and a message that contains the key in use is replaced
//! ([`AiError::redact`]).

use std::fmt;

/// What kind of failure an [`AiError`] is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    /// No API key is stored for the provider (open AI Accounts).
    MissingKey,
    /// The provider rejected the key (401, an invalid-key error).
    InvalidKey,
    /// The account's quota is used up or requests come too fast (429).
    Quota,
    /// The provider refused the prompt or its answer for safety reasons.
    Safety,
    /// The provider could not be reached (DNS, connection, TLS).
    Network,
    /// The request took longer than the timeout.
    Timeout,
    /// The provider answered with something this crate can't use (not JSON, no image, an SVG with
    /// no drawable art, a body over the size cap).
    BadResponse,
    /// The request was stopped by the person (or the job was dropped).
    Cancelled,
    /// The request was refused as malformed (400), or the input was invalid before sending.
    BadRequest,
    /// The model or endpoint does not exist for this key (404).
    NotFound,
    /// The provider failed on its side (5xx).
    Server,
    /// The feature can't run on this selection or document (nothing selected, not a closed path…).
    Document,
    /// The key store failed (the OS credential store is locked or unavailable, the file can't be
    /// written).
    KeyStore,
    /// The person hasn't yet agreed that prompts and artwork go to their provider (AI Accounts
    /// asks once).
    NeedsConsent,
}

impl ErrorKind {
    /// A stable id for the control protocol and MCP (`missingKey`, `quota`…).
    pub fn id(self) -> &'static str {
        match self {
            ErrorKind::MissingKey => "missingKey",
            ErrorKind::InvalidKey => "invalidKey",
            ErrorKind::Quota => "quota",
            ErrorKind::Safety => "safety",
            ErrorKind::Network => "network",
            ErrorKind::Timeout => "timeout",
            ErrorKind::BadResponse => "badResponse",
            ErrorKind::Cancelled => "cancelled",
            ErrorKind::BadRequest => "badRequest",
            ErrorKind::NotFound => "notFound",
            ErrorKind::Server => "server",
            ErrorKind::Document => "document",
            ErrorKind::KeyStore => "keyStore",
            ErrorKind::NeedsConsent => "needsConsent",
        }
    }

    /// Whether trying the same request again later may work.
    pub fn retryable(self) -> bool {
        matches!(self, ErrorKind::Quota | ErrorKind::Network | ErrorKind::Timeout | ErrorKind::Server)
    }
}

/// A failure, with a message for the person and the HTTP status when there was one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AiError {
    pub kind: ErrorKind,
    pub message: String,
    /// The HTTP status of the provider's answer, 0 without one.
    pub status: u16,
}

impl AiError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into(), status: 0 }
    }

    pub fn with_status(mut self, status: u16) -> Self {
        self.status = status;
        self
    }

    pub fn cancelled() -> Self {
        Self::new(ErrorKind::Cancelled, "Stopped.")
    }

    pub fn document(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Document, message)
    }

    pub fn bad_response(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::BadResponse, message)
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::BadRequest, message)
    }

    /// The error with every occurrence of `secret` in its message replaced. Providers sometimes
    /// echo part of a rejected key; the key in use never reaches a message.
    pub fn redact(mut self, secret: &str) -> Self {
        if secret.len() >= 4 && self.message.contains(secret) {
            self.message = self.message.replace(secret, "[redacted]");
        }
        self
    }

    /// `{kind, message, status?}` for the control protocol and MCP.
    pub fn to_json(&self) -> serde_json::Value {
        let mut v = serde_json::json!({ "kind": self.kind.id(), "message": self.message });
        if self.status != 0 {
            v["status"] = serde_json::json!(self.status);
        }
        v
    }
}

impl fmt::Display for AiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AiError {}

impl From<vectorcraft_engine::EngineError> for AiError {
    fn from(e: vectorcraft_engine::EngineError) -> Self {
        AiError::document(e.to_string())
    }
}
