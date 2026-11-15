//! Stopping a request. The engine hands each backend call a `&dyn Fn() -> bool` that reads its
//! job's Cancel; HTTP polls it before sending and between response chunks, the backend between
//! steps. [`CancelToken`] is the same thing as a shareable flag, for callers that own the request
//! (the command line, the interface's Test Connection).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::{AiError, Result};

/// Whether the request was stopped: polled, never blocks.
pub type Cancelled<'a> = &'a dyn Fn() -> bool;

/// A request that is never stopped.
pub fn never() -> bool {
    false
}

/// `Err(Cancelled)` once `cancelled` says so.
pub fn check(cancelled: Cancelled<'_>) -> Result<()> {
    if cancelled() { Err(AiError::cancelled()) } else { Ok(()) }
}

/// A flag shared by a request and whoever may stop it. Cloning shares the flag.
#[derive(Clone, Debug, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    /// `Err(Cancelled)` once cancelled.
    pub fn check(&self) -> Result<()> {
        check(&|| self.is_cancelled())
    }
}
