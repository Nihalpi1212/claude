//! Pigment: generative AI in headless sessions (docs/generative-ai.md). Every session the MCP
//! server, `pigment-cli serve` and the command line build gets the `pigment-genai` backend over
//! the person's AI accounts (`ai.json` and the key store in the folder [`crate::app_dirs`]
//! resolves), opened only when an `ai.*` command first needs it. Who may send is the caller's:
//! agents need "Allow agents to run AI commands" (`allowAgents`), the command line `--allow-ai`.

use std::sync::Arc;

use photocraft_engine::Session;
pub use pigment_genai::Caller;
use pigment_genai::{AiAccounts, GenAiBackend};

/// The backend for `caller` over the accounts in Pigment's config folder (none without one:
/// requests then report the missing key).
pub fn backend(caller: Caller) -> GenAiBackend {
    GenAiBackend::deferred(caller, || match crate::app_dirs::from_env().dir {
        Some(dir) => AiAccounts::new(&dir),
        None => AiAccounts::in_memory(),
    })
}

/// A new session with the backend for `caller` installed.
pub fn session(caller: Caller) -> Session {
    let mut s = Session::new();
    install(&mut s, caller);
    s
}

/// Install the backend for `caller` on `session`.
pub fn install(session: &mut Session, caller: Caller) {
    session.set_generative(Some(Arc::new(backend(caller))));
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::Headless;
    use pigment_genai::ProviderId;
    use serde_json::json;

    /// MCP's and `serve`'s sessions have the backend (so `ai.status` answers), and agents don't
    /// send while "Allow agents to run AI commands" is off, even with consent and a key.
    #[test]
    fn headless_sessions_have_the_backend_and_agents_need_permission() {
        let mut h = Headless::new();
        assert_eq!(h.command_run("ai.status", json!({})).unwrap()["installed"], true);
        let accounts = || {
            let mut a = AiAccounts::in_memory();
            a.set_key(ProviderId::OpenAi, "sk-test-0123456789abcdefWXYZ").unwrap();
            a.settings.consented = true;
            a
        };
        h.session.set_generative(Some(Arc::new(GenAiBackend::deferred(Caller::Agent, accounts))));
        let e = h.command_run("ai.generateImage", json!({"prompt": "x", "target": "document"})).unwrap_err();
        assert!(e.to_string().contains("Allow agents to run AI commands"), "{e}");
        assert!(h.session.documents().is_empty(), "nothing was made");
        let local = Headless::trusted_local();
        assert!(local.session.generative().is_some(), "the command line's sessions too");
    }
}
