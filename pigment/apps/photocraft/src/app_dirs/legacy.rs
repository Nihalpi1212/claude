//! Pigment: where the JavaScript Pigment (0.1 to 0.5, the Electron app) kept its presets, for
//! Edit › Presets › Migrate Presets (P4). Electron's `userData` folder is the platform's
//! application-data folder plus the product name, `Pigment`; the preset store wrote
//! `<userData>/presets/<kind>.json` and `settings.json` beside the folder:
//! - Windows `%APPDATA%\Pigment\presets`, macOS `~/Library/Application Support/Pigment/presets`
//!   (the folder Pigment 0.5 uses for its own settings, which keep their presets in
//!   `Preset Library/` and `config.toml`, so nothing clashes: docs/FORK.md);
//! - Linux `$XDG_CONFIG_HOME/Pigment/presets`, by default `~/.config/Pigment/presets`, with a
//!   capital P (Pigment 0.5's folder is `~/.config/pigment`).
//!
//! The platform rule, never [`super::current`]: a portable copy or a `PIGMENT_CONFIG_DIR`
//! override moves where Pigment 0.5 keeps its settings, not where the old app left its files.

use std::ffi::OsString;
use std::path::PathBuf;

/// The old app's presets folder, when there is one.
pub fn legacy_pigment_dir() -> Option<PathBuf> {
    legacy_pigment_dir_in(|k| std::env::var_os(k)).filter(|d| d.is_dir())
}

/// Where the old app's presets folder is by the platform's rule, for the environment `env`
/// (whether or not it exists).
pub fn legacy_pigment_dir_in(env: impl Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    let set = |k: &str| env(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    let app_data = if cfg!(target_os = "macos") {
        set("HOME").map(|h| h.join("Library").join("Application Support"))
    } else if cfg!(windows) {
        set("APPDATA")
    } else {
        // Electron takes XDG_CONFIG_HOME as it is (an absolute path, as the spec asks).
        set("XDG_CONFIG_HOME").filter(|x| x.is_absolute()).or_else(|| set("HOME").map(|h| h.join(".config")))
    };
    app_data.map(|d| d.join("Pigment").join("presets"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> + use<> {
        let m: HashMap<String, OsString> = pairs.iter().map(|(k, v)| (k.to_string(), OsString::from(v))).collect();
        move |k| m.get(k).cloned()
    }

    #[test]
    fn the_old_apps_folder_follows_the_platform_rule() {
        let all = env(&[("HOME", "/home/ann"), ("APPDATA", "C:\\Users\\ann\\AppData\\Roaming"), ("XDG_CONFIG_HOME", "/home/ann/.cfg")]);
        let got = legacy_pigment_dir_in(&all).unwrap();
        if cfg!(target_os = "macos") {
            assert_eq!(got, PathBuf::from("/home/ann/Library/Application Support/Pigment/presets"));
        } else if cfg!(windows) {
            assert_eq!(got, PathBuf::from("C:\\Users\\ann\\AppData\\Roaming").join("Pigment").join("presets"));
        } else {
            assert_eq!(got, PathBuf::from("/home/ann/.cfg/Pigment/presets"));
            // No (or a relative) XDG_CONFIG_HOME: ~/.config, capital P.
            assert_eq!(legacy_pigment_dir_in(env(&[("HOME", "/home/ann")])), Some(PathBuf::from("/home/ann/.config/Pigment/presets")));
            assert_eq!(
                legacy_pigment_dir_in(env(&[("HOME", "/home/ann"), ("XDG_CONFIG_HOME", "rel")])),
                Some(PathBuf::from("/home/ann/.config/Pigment/presets"))
            );
        }
        // Pigment 0.5's own overrides do not move it.
        let with_override = env(&[("HOME", "/home/ann"), ("APPDATA", "C:\\A"), ("PIGMENT_CONFIG_DIR", "/elsewhere")]);
        assert!(!legacy_pigment_dir_in(with_override).unwrap().starts_with("/elsewhere"));
        // Nothing to go on: none.
        assert_eq!(legacy_pigment_dir_in(|_| None), None);
        assert_eq!(legacy_pigment_dir_in(env(&[("HOME", ""), ("APPDATA", "")])), None);
    }
}
