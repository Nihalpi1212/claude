//! Pigment's side of agents in the open desktop app: its agent settings as `pigment-cli mcp` reads
//! them from the saved preferences, and whether the person lets agents in now: Pigment's own
//! switch, Preferences › AI Integrations › Let AI apps use this window (`connectAgents`, off by
//! default; docs/FORK.md). PhotoCraft's ArtCraft Launcher switch and the suite's `AI-MCP` flag are
//! never read: [`mcp_flag`] and [`launcher_allows_agents`] are always false, and nothing here calls
//! `craft::automation::agents::mcp_flag` or `launcher_allows`.
//!
//! The connection file and the link host are the framework's (`craft::automation::agents`): the
//! app serves its control channel on loopback while agents may connect and publishes where in its
//! settings folder, and `pigment-cli mcp` ([`crate::live`]) reads that file on every tool call, so
//! MCP client configurations never hold a port or a token. Nothing here writes an MCP client's
//! configuration.

use std::path::Path;

use craft::automation::agents;
use photocraft_engine::prefs::Integrations;

/// The MCP preferences saved in `dir`, read as the app's settings store loads them
/// (`photocraft_engine::prefs::read_saved`: `config.toml`, or before it the older
/// `preferences.json`). Defaults when nothing is saved or the file is unreadable: the CLI must not
/// fail over the app's settings.
pub fn read_integrations(dir: &Path) -> Integrations {
    photocraft_engine::prefs::read_saved(Some(dir)).prefs.integrations
}

// ---- The agents switch -------------------------------------------------------------------------

/// The id the ArtCraft Launcher's app list names PhotoCraft by. Pigment never reads that list.
pub const LAUNCHER_APP_ID: &str = "photocraft";

/// The server name MCP clients list Pigment under (`serverInfo.name`).
pub const SERVER_NAME: &str = "pigment";

/// The suite's `AI-MCP` feature flag. Pigment reads no suite flags file (`ArtCraft/flags.toml`,
/// `CRAFT_FLAGS`): always off, so PhotoCraft's launcher-switch mode never applies (docs/FORK.md).
pub fn mcp_flag() -> bool {
    false
}

/// The ArtCraft Launcher's switch. Pigment never reads the launcher's files (`craft-ai-agents`):
/// always off. Pigment's own switch is Preferences › AI Integrations › Let AI apps use this
/// window (`connectAgents`).
pub fn launcher_allows_agents() -> bool {
    false
}

/// Whether agents may use the open window now ([`agents::agents_allowed`] with Pigment's
/// [`mcp_flag`] and [`launcher_allows_agents`], both off): Pigment's own preference alone,
/// `connect_agents` (Let AI apps use this window, also set from a Control Port saved by an older
/// version), off by default. Allow Agent Control off still refuses agents.
pub fn agents_allowed_now(integrations: &Integrations) -> bool {
    agents::agents_allowed(mcp_flag(), launcher_allows_agents(), integrations.connect_agents)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn temp(tag: &str) -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let d = std::env::temp_dir().join(format!("photocraft-agent-link-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn pigment_reads_neither_the_suite_flag_nor_the_launcher() {
        assert!(!mcp_flag() && !launcher_allows_agents());
        assert!(!agents_allowed_now(&Integrations::default()), "off by default");
        assert!(agents_allowed_now(&Integrations { connect_agents: true, ..Default::default() }), "Pigment's own switch");
        // The source never asks the framework for the suite flag or the launcher's list.
        let src = include_str!("agent_link.rs");
        let call = |name: &str| format!("agents::{name}(");
        assert!(!src.contains(&call("mcp_flag")) && !src.contains(&call("launcher_allows")));
    }

    #[test]
    fn mcp_clients_list_pigment_as_pigment() {
        assert_eq!(SERVER_NAME, "pigment");
    }

    #[test]
    fn integrations_come_from_the_saved_preferences_or_default() {
        let dir = temp("prefs");
        assert_eq!(read_integrations(&dir), Integrations::default());
        std::fs::write(dir.join("preferences.json"), "not json").unwrap();
        assert_eq!(read_integrations(&dir), Integrations::default());
        // A section of the wrong type doesn't fail the CLI either.
        std::fs::write(dir.join("preferences.json"), r#"{"integrations": {"connectAgents": "yes"}}"#).unwrap();
        assert_eq!(read_integrations(&dir), Integrations::default());
        std::fs::write(
            dir.join("preferences.json"),
            r#"{"general": {}, "integrations": {"connectAgents": true, "whenAppClosed": "headless", "readRoot": "/in"}}"#,
        )
        .unwrap();
        let i = read_integrations(&dir);
        assert!(i.connect_agents);
        assert_eq!(i.agents.when_app_closed, photocraft_engine::prefs::WhenAppClosed::Headless);
        assert_eq!(i.agents.read_folder(), Some(PathBuf::from("/in")));
        assert_eq!(i.agents.write_folder(), None);
        // A Control Port saved before the agents switch reads as on, as the app reads it.
        std::fs::write(dir.join("preferences.json"), r#"{"integrations": {"controlPort": 7878}}"#).unwrap();
        assert!(read_integrations(&dir).connect_agents);
        std::fs::write(dir.join("preferences.json"), r#"{"integrations": {"controlPort": 7878, "connectAgents": false}}"#).unwrap();
        assert!(!read_integrations(&dir).connect_agents);
        // One bad value resets only itself, as in the app: the saved closed-app choice stays.
        std::fs::write(dir.join("preferences.json"), r#"{"integrations": {"whenAppClosed": "error", "readRoot": 5}}"#).unwrap();
        assert_eq!(read_integrations(&dir).agents.when_app_closed, photocraft_engine::prefs::WhenAppClosed::Error);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
