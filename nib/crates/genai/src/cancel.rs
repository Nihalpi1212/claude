//! A flag a worker checks between steps of a request.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// Shared by a job and whoever may stop it. Cloning shares the flag.
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
    pub fn check(&self) -> crate::Result<()> {
        if self.is_cancelled() { Err(crate::AiError::cancelled()) } else { Ok(()) }
    }
}
