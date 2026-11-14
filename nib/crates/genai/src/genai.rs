//! [`GenAi`]: what the app holds for the AI commands: the accounts, the running jobs and the
//! results waiting to be placed. The UI calls [`GenAi::start`] from a dialog, [`GenAi::poll`] once
//! per frame, shows the variations of a finished job, and calls [`GenAi::apply`] with the one the
//! person picks (as often as they like: each apply is its own undo step).

use std::collections::BTreeMap;
use std::time::Duration;

use vectorcraft_engine::Session;

use crate::jobs::{JobEvent, JobId, Outcome};
use crate::ops::{Applied, FeatureRequest, Generated};
use crate::{AccountStatus, AiAccounts, AiError, ErrorKind, Jobs, ProviderKind, Result};

pub struct GenAi {
    pub accounts: AiAccounts,
    pub jobs: Jobs,
    results: BTreeMap<JobId, Generated>,
}

/// Results kept at most (the oldest go first).
const MAX_RESULTS: usize = 16;

impl GenAi {
    pub fn new(accounts: AiAccounts) -> Self {
        Self { accounts, jobs: Jobs::new(), results: BTreeMap::new() }
    }

    pub fn status(&self) -> Vec<AccountStatus> {
        self.accounts.status()
    }

    /// Read what `request` works on from the active document and start it with `provider`
    /// (default: the default provider). Fails at once, before any request, without a key, without
    /// consent, or when the selection doesn't suit the feature.
    pub fn start(&mut self, session: &mut Session, request: &FeatureRequest, provider: Option<ProviderKind>) -> Result<JobId> {
        if !self.accounts.settings.consented {
            return Err(AiError::new(
                ErrorKind::NeedsConsent,
                "The AI commands send your prompt, and for some features the selected artwork or image, to the AI provider you choose. Agree to this in AI › AI Accounts first.",
            ));
        }
        let provider = self.accounts.provider(provider)?;
        let prepared = crate::ops::prepare(session, request)?;
        log::info!("genai: {} started with {}", prepared.feature.id(), provider.kind().id());
        Ok(self.jobs.spawn(prepared, provider))
    }

    /// Test `kind`'s stored key on a worker; the event's outcome lists the models.
    pub fn test_connection(&mut self, kind: ProviderKind) -> Result<JobId> {
        let provider = self.accounts.provider(Some(kind))?;
        Ok(self.jobs.spawn_test_connection(provider))
    }

    fn keep(&mut self, events: &[JobEvent]) {
        for e in events {
            if let Ok(Outcome::Generated(g)) = &e.result {
                self.results.insert(e.info.id, g.clone());
                log::info!("genai: job {} made {} variation(s)", e.info.id.0, g.variations());
            } else if let Err(err) = &e.result {
                log::info!("genai: job {} ended: {} ({})", e.info.id.0, err.kind.id(), err.status);
            }
        }
        while self.results.len() > MAX_RESULTS {
            let Some(first) = self.results.keys().next().copied() else { break };
            self.results.remove(&first);
        }
    }

    /// The jobs that ended since the last poll; their results are kept for [`Self::apply`].
    pub fn poll(&mut self) -> Vec<JobEvent> {
        let events = self.jobs.poll();
        self.keep(&events);
        events
    }

    /// Block until job `id` ends, up to `timeout` (CLI, MCP, tests).
    pub fn wait(&mut self, id: JobId, timeout: Duration) -> Option<JobEvent> {
        let e = self.jobs.wait(id, timeout)?;
        self.keep(std::slice::from_ref(&e));
        Some(e)
    }

    pub fn result(&self, id: JobId) -> Option<&Generated> {
        self.results.get(&id)
    }

    /// Place variation `variation` of job `id`'s result as one undo step.
    pub fn apply(&mut self, session: &mut Session, id: JobId, variation: usize) -> Result<Applied> {
        let g = self.results.get(&id).ok_or_else(|| AiError::bad_request("That result is no longer available. Generate again."))?;
        crate::ops::apply(session, g, variation)
    }

    /// Forget job `id`'s result.
    pub fn discard(&mut self, id: JobId) {
        self.results.remove(&id);
    }

    pub fn cancel(&mut self, id: JobId) -> bool {
        self.jobs.cancel(id)
    }
}
