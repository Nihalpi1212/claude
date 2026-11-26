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

/// The About window's links: (label, url), in their order.
pub const ABOUT: &[(&str, &str)] = &[
    ("Report an Issue", ISSUES),
    ("Pigment on GitHub", GITHUB),
    ("Pigment Releases", RELEASES),
    ("PhotoCraft (upstream project)", UPSTREAM),
];

/// The About window's credit line: what Pigment is based on, and its licence.
pub fn credit() -> &'static str {
    tl!("Pigment is based on PhotoCraft by the ArtCraft team and the PhotoCraft contributors (MIT OR Apache-2.0)")
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

    #[test]
    fn help_menu_lists_links_then_separator_then_system_info_and_about() {
        let app = PhotocraftApp::new(photocraft_engine::Session::new(), Default::default());
        let help: Vec<String> = crate::menus::menu_rows(&app)
            .into_iter()
            .filter(|i| i.path == ["Help"])
            .map(|i| if i.command.id.is_empty() { "---".to_string() } else { i.command.id })
            .collect();
        assert_eq!(
            help,
            ["help.reportIssue", "help.github", "help.website", "help.artcraftWebsite", "help.checkForUpdates", "---", "help.systemInfo", "help.about"]
        );
        for (id, _) in COMMANDS {
            assert!(crate::menus::is_live(id) && crate::menus::is_enabled(&app, id), "{id}");
        }
    }

    #[test]
    fn repository_links_name_this_release_s_tag_not_the_default_branch() {
        // The repository's default branch holds the JavaScript app (Pigment 0.1 to 0.4), so a link
        // to `HEAD` or the bare repository opens its tree and README, and `pigment/docs/user` is a
        // 404 there. The release workflow tags the commit it builds `pigment-v<version>`.
        let tree = format!("https://github.com/Nihalpi1212/claude/tree/pigment-v{}/pigment", photocraft_format::brand::VERSION);
        assert_eq!(GITHUB, tree);
        assert_eq!(TUTORIALS, format!("{tree}/docs/user"));
        for url in [ISSUES, GITHUB, RELEASES, TUTORIALS, APP_PAGE] {
            assert!(!url.contains("/HEAD/"), "{url}");
        }
        // The engine's link (memory messages, docs/FORK.md) is the same releases page.
        assert_eq!(photocraft_engine::build_info::RELEASES, RELEASES);
    }

    #[test]
    fn link_commands_open_their_urls() {
        let mut app = PhotocraftApp::new(photocraft_engine::Session::new(), Default::default());
        let ctx = egui::Context::default();
        for (id, url) in [
            ("help.reportIssue", "https://github.com/Nihalpi1212/claude/issues"),
            ("help.github", concat!("https://github.com/Nihalpi1212/claude/tree/pigment-v", env!("CARGO_PKG_VERSION"), "/pigment")),
            ("help.website", "https://github.com/Nihalpi1212/claude/releases"),
            ("help.artcraftWebsite", "https://github.com/storytold/photocraft"),
        ] {
            let r = crate::menus::invoke(&mut app, &ctx, id, serde_json::json!({})).unwrap();
            assert_eq!(r["url"], url);
            assert_eq!(app.ui.status, format!("Opened {url}"));
        }
    }

    #[test]
    fn about_and_home_name_pigment_s_pages_only() {
        let app = PhotocraftApp::new(photocraft_engine::Session::new(), Default::default());
        let about = crate::dialogs::credits::about_info(&app);
        assert_eq!(about.app_name.as_str(), "Pigment");
        assert!(about.community.is_none(), "no Discord button");
        let urls: Vec<&str> = about.links.iter().map(|l| l.url.as_str()).collect();
        assert_eq!(urls, [ISSUES, GITHUB, RELEASES, UPSTREAM]);
        assert!(about.blurb.as_str().contains(&photocraft_format::brand::version_line()), "{}", about.blurb.as_str());
        assert!(about.blurb.as_str().contains("MIT OR Apache-2.0"));
        let home = crate::canvas::start_screen::links();
        let urls: Vec<&str> = home
            .iter()
            .filter_map(|l| match &l.target {
                craft::ui::shell::StartLinkTarget::Url(url) => Some(url.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(urls, [TUTORIALS, RELEASES, ISSUES, GITHUB]);
    }
}
