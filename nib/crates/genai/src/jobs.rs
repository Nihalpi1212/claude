//! Jobs: each request runs on a worker thread of its own, and its result comes back to the thread
//! that polls ([`Jobs::poll`], once per UI frame). Cancelling a job answers at once: the job is
//! reported cancelled, its worker stops at the next check (between chunks of the answer, between
//! variations) and whatever it still produces is dropped.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::ops::{Feature, Generated, Prepared};
use crate::provider::ModelInfo;
use crate::{AiError, CancelToken, Provider, ProviderKind, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
pub struct JobId(pub u64);

/// What a job does.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum JobKind {
    Generate(Feature),
    /// AI Accounts › Test Connection.
    TestConnection,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobInfo {
    pub id: JobId,
    pub kind: JobKind,
    pub provider: ProviderKind,
    /// The document a generation belongs to (0 for a connection test).
    pub doc_uid: u64,
    #[serde(skip)]
    pub started: Instant,
}

/// What a finished job made.
#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    Generated(Generated),
    Models(Vec<ModelInfo>),
}

/// A job that ended: done, failed or cancelled.
#[derive(Clone, Debug)]
pub struct JobEvent {
    pub info: JobInfo,
    pub result: Result<Outcome>,
}

type Waker = Arc<dyn Fn() + Send + Sync>;

pub struct Jobs {
    next: u64,
    running: BTreeMap<JobId, (JobInfo, CancelToken)>,
    tx: Sender<(JobId, Result<Outcome>)>,
    rx: Receiver<(JobId, Result<Outcome>)>,
    /// Events to hand out at the next poll (cancellations).
    ready: Vec<JobEvent>,
    waker: Option<Waker>,
}

impl Default for Jobs {
    fn default() -> Self {
        Self::new()
    }
}

impl Jobs {
    pub fn new() -> Self {
        let (tx, rx) = channel();
        Self { next: 1, running: BTreeMap::new(), tx, rx, ready: vec![], waker: None }
    }

    /// Called from the worker when a job ends (the UI passes egui's `request_repaint`).
    pub fn set_waker(&mut self, waker: impl Fn() + Send + Sync + 'static) {
        self.waker = Some(Arc::new(waker));
    }

    fn start(
        &mut self,
        kind: JobKind,
        provider: ProviderKind,
        doc_uid: u64,
        work: impl FnOnce(&CancelToken) -> Result<Outcome> + Send + 'static,
    ) -> JobId {
        let id = JobId(self.next);
        self.next += 1;
        let cancel = CancelToken::new();
        self.running.insert(id, (JobInfo { id, kind, provider, doc_uid, started: Instant::now() }, cancel.clone()));
        let tx = self.tx.clone();
        let waker = self.waker.clone();
        let spawned = std::thread::Builder::new().name(format!("genai-job-{}", id.0)).spawn(move || {
            let result = vectorcraft_engine::guard::catch_panic(|| work(&cancel))
                .unwrap_or_else(|panic| Err(AiError::bad_response(format!("Nib hit an internal error while talking to the provider ({panic})."))));
            // The receiver is gone when the Jobs were dropped: nobody wants the result.
            let _ = tx.send((id, result));
            if let Some(w) = waker {
                w();
            }
        });
        if let Err(e) = spawned
            && let Some((info, _)) = self.running.remove(&id)
        {
            self.ready.push(JobEvent { info, result: Err(AiError::bad_request(format!("Nib could not start the request ({e})."))) });
        }
        id
    }

    /// Run `prepared` with `provider` on a worker.
    pub fn spawn(&mut self, prepared: Prepared, provider: Arc<dyn Provider>) -> JobId {
        let kind = JobKind::Generate(prepared.feature);
        let doc = prepared.doc_uid;
        self.start(kind, provider.kind(), doc, move |cancel| crate::ops::run(&prepared, provider.as_ref(), cancel).map(Outcome::Generated))
    }

    /// List the provider's models on a worker (the key works when this succeeds).
    pub fn spawn_test_connection(&mut self, provider: Arc<dyn Provider>) -> JobId {
        self.start(JobKind::TestConnection, provider.kind(), 0, move |cancel| provider.list_models(cancel).map(Outcome::Models))
    }

    /// Stop a job. It is reported cancelled by the next [`Self::poll`]; `false` when it already ended.
    pub fn cancel(&mut self, id: JobId) -> bool {
        let Some((info, token)) = self.running.remove(&id) else { return false };
        token.cancel();
        self.ready.push(JobEvent { info, result: Err(AiError::cancelled()) });
        true
    }

    pub fn cancel_all(&mut self) {
        let ids: Vec<JobId> = self.running.keys().copied().collect();
        for id in ids {
            self.cancel(id);
        }
    }

    /// The jobs still running, oldest first.
    pub fn running(&self) -> Vec<JobInfo> {
        self.running.values().map(|(i, _)| i.clone()).collect()
    }

    pub fn is_running(&self, id: JobId) -> bool {
        self.running.contains_key(&id)
    }

    fn take(&mut self, id: JobId, result: Result<Outcome>) -> Option<JobEvent> {
        // A cancelled job's late result is dropped: it was reported already.
        let (info, _) = self.running.remove(&id)?;
        Some(JobEvent { info, result })
    }

    /// The jobs that ended since the last poll. Never blocks.
    pub fn poll(&mut self) -> Vec<JobEvent> {
        let mut out = std::mem::take(&mut self.ready);
        while let Ok((id, result)) = self.rx.try_recv() {
            out.extend(self.take(id, result));
        }
        out
    }

    /// Wait up to `timeout` for job `id` to end (the CLI, MCP and tests). Events of other jobs that
    /// end meanwhile are kept for the next [`Self::poll`].
    pub fn wait(&mut self, id: JobId, timeout: Duration) -> Option<JobEvent> {
        if let Some(i) = self.ready.iter().position(|e| e.info.id == id) {
            return Some(self.ready.remove(i));
        }
        let deadline = Instant::now() + timeout;
        while self.running.contains_key(&id) {
            let left = deadline.checked_duration_since(Instant::now())?;
            let Ok((got, result)) = self.rx.recv_timeout(left) else { return None };
            if let Some(e) = self.take(got, result) {
                if got == id {
                    return Some(e);
                }
                self.ready.push(e);
            }
        }
        None
    }
}
