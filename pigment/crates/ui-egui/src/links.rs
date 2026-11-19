//! Project links: the Help menu, the About dialog and the start screen open these. Pigment points
//! them at its own repository, issues and releases, and at the upstream PhotoCraft project it is
//! based on (docs/FORK.md). The command ids are PhotoCraft's, kept so upstream changes merge:
//! `help.reportIssue` opens Pigment's issues, `help.github` its repository, `help.website` its
//! releases and `help.artcraftWebsite` the upstream project. PhotoCraft's Discord and
//! getartcraft.com links are gone.

use serde_json::{Value, json};

use crate::PhotocraftApp;

/// Where Pigment's bugs and ideas are reported.
pub const ISSUES: &str = "https://github.com/Nihalpi1212/claude/issues";
/// Pigment's source, as this version was released: the tree of its tag `pigment-v<version>` (the
/// release workflow creates it). Not the bare repository or `HEAD`: the repository's default branch
/// holds the JavaScript app (Pigment 0.1 to 0.4), whose tree has no `pigment/docs/user`.
pub const GITHUB: &str = concat!("https://github.com/Nihalpi1212/claude/tree/pigment-v", env!("CARGO_PKG_VERSION"), "/pigment");
/// Pigment's releases (tags `pigment-vX.Y.Z`, assets `pigment-*`); Help › Check for Updates opens it.
pub const RELEASES: &str = "https://github.com/Nihalpi1212/claude/releases";
/// The upstream project Pigment is based on.
pub const UPSTREAM: &str = "https://github.com/storytold/photocraft";
/// The user guide (Learn on the start screen), as this version was released.
pub const TUTORIALS: &str = concat!("https://github.com/Nihalpi1212/claude/tree/pigment-v", env!("CARGO_PKG_VERSION"), "/pigment/docs/user");
/// The app's page: its releases.
pub const APP_PAGE: &str = RELEASES;

/// Help-menu link commands: (id, url). Labels live in `menus::UI_COMMANDS`.
pub const COMMANDS: &[(&str, &str)] = &[("help.reportIssue", ISSUES), ("help.github", GITHUB), ("help.website", RELEASES), ("help.artcraftWebsite", UPSTREAM)];

pub fn url_for(id: &str) -> Option<&'static str> {
    COMMANDS.iter().find(|c| c.0 == id).map(|c| c.1)
}

/// Open `url` in the system browser (a new tab on the web) and note it in the status bar. Prefers
/// the platform `open_url` service (reliable on Windows/macOS/Linux); falls back to `ctx.open_url`.
pub fn open(app: &mut PhotocraftApp, ctx: &egui::Context, url: &str) -> Value {
    let opened = app.services.open_url.as_ref().map(|f| f(url).is_ok()).unwrap_or(false);
    if !opened {
        ctx.open_url(egui::OpenUrl::new_tab(url));
    }
    let template = "Opened {url}";
    app.ui.status = crate::i18n::fmt(tl!(template), &[("url", url)]);
    json!({"url": url})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_open_through_the_platform_service() {
        // Issue #14: links (Help menu, About, start-page links) must open in the browser.
        // They route through the `open_url` service rather than the unreliable `ctx.open_url`.
        use std::sync::{Arc, Mutex};
        let opened: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let rec = opened.clone();
        let services = crate::Services {
            open_url: Some(Box::new(move |u: &str| {
                rec.lock().unwrap().push(u.to_string());
                Ok(())
            })),
            ..Default::default()
        };
        let mut app = PhotocraftApp::new(photocraft_engine::Session::new(), services);
        let ctx = app.ctx().clone();
        // Every Help-menu link id reaches the service with its URL.
        for (id, url) in COMMANDS {
            crate::menus::invoke(&mut app, &ctx, id, json!({})).unwrap();
            assert_eq!(opened.lock().unwrap().last().map(String::as_str), Some(*url), "{id}");
        }
        // The direct open() helper (start-page links) also uses it.
        open(&mut app, &ctx, ISSUES);
        assert_eq!(opened.lock().unwrap().last().map(String::as_str), Some(ISSUES));
    }
}
