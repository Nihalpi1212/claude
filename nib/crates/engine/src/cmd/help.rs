//! Help → project links: Nib's repository, its issues and releases, and the upstream VectorCraft
//! project Nib is based on. The commands return the URL; the frontend opens it. The command ids
//! are VectorCraft's (`help.discord`, `help.website`, `help.appPage`, `help.github`), kept so
//! upstream changes merge; Nib points them at its own pages (see docs/FORK.md).

use serde_json::{Value, json};

use super::{CommandSpec, Result, always, cmd};

/// Nib's source repository.
pub const REPOSITORY_URL: &str = "https://github.com/Nihalpi1212/claude";
/// Where Nib's bugs and ideas are reported.
pub const ISSUES_URL: &str = "https://github.com/Nihalpi1212/claude/issues";
/// Nib's releases (tags `nib-vX.Y.Z`, assets `nib-*`).
pub const RELEASES_URL: &str = "https://github.com/Nihalpi1212/claude/releases";
/// The upstream project Nib is based on.
pub const UPSTREAM_URL: &str = "https://github.com/storytold/vectorcraft";

/// Nib's releases page (Help › Check for Updates opens it).
pub fn app_page_url() -> String {
    RELEASES_URL.into()
}

/// Nib's source repository.
pub fn github_url() -> String {
    REPOSITORY_URL.into()
}

pub fn specs() -> Vec<CommandSpec> {
    vec![
        cmd!(query "help.discord", "Report an Issue", ["Help"], None, "{} → {url} Nib's issue tracker", always, |_, _| url(ISSUES_URL.into())),
        cmd!(query "help.website", "VectorCraft (upstream project)", ["Help"], None, "{} → {url} the project Nib is based on", always, |_, _| url(UPSTREAM_URL.into())),
        cmd!(query "help.appPage", "Nib Releases", ["Help"], None, "{} → {url} Nib's releases", always, |_, _| url(app_page_url())),
        cmd!(query "help.github", "Nib on GitHub", ["Help"], None, "{} → {url} source code, issues and releases", always, |_, _| url(github_url())),
        cmd!(query "help.links", "Links", [], None, "{} → {issues, upstream, releases, github} (also as discord, website, appPage)", always, |_, _| {
            Ok(json!({
                "issues": ISSUES_URL, "upstream": UPSTREAM_URL, "releases": RELEASES_URL, "github": github_url(),
                "discord": ISSUES_URL, "website": UPSTREAM_URL, "appPage": app_page_url(),
            }))
        }),
    ]
}

fn url(u: String) -> Result<Value> {
    Ok(json!({ "url": u }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Session;

    #[test]
    fn links() {
        let mut s = Session::new();
        assert_eq!(s.execute("help.discord", &json!({})).unwrap()["url"], "https://github.com/Nihalpi1212/claude/issues");
        assert_eq!(s.execute("help.appPage", &json!({})).unwrap()["url"], "https://github.com/Nihalpi1212/claude/releases");
        assert_eq!(s.execute("help.github", &json!({})).unwrap()["url"], "https://github.com/Nihalpi1212/claude");
        assert_eq!(s.execute("help.website", &json!({})).unwrap()["url"], "https://github.com/storytold/vectorcraft");
        assert_eq!(s.execute("help.links", &json!({})).unwrap()["upstream"], "https://github.com/storytold/vectorcraft");
    }
}
