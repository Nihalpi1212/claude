//! Pigment's identity: the product name, its version, the upstream PhotoCraft release it is based
//! on, its application id and its own native file extension (see `docs/FORK.md`). Pigment saves
//! PhotoCraft's native format unchanged (craft-pcraft-format's `manifest.json` and tiles), so files
//! exchange with PhotoCraft; only the extension and the names differ.
//!
//! Pigment 0.1 to 0.4 were a different program (an Electron app) whose `.pigment` files hold
//! another format: [`is_legacy_pigment`] tells them apart, and opening one fails with
//! [`LEGACY_PIGMENT_MESSAGE`] until an importer is added.

/// The product name users see.
pub const NAME: &str = "Pigment";
/// Pigment's own version (the workspace version).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// The upstream project Pigment is based on.
pub const UPSTREAM_NAME: &str = "PhotoCraft"; // upstream-ok
/// The PhotoCraft release this copy of Pigment is based on (`UPSTREAM-REVISION`).
pub const UPSTREAM_VERSION: &str = "0.23.1";
/// The application id: Wayland/X11 app id, desktop entry, AppStream, MIME, macOS bundle id,
/// Flatpak id and Windows AppUserModelID.
pub const APP_ID: &str = "io.github.nihalpi1212.pigment";
/// Pigment's native document extension (without the dot). Pigment also opens [`crate::EXTENSION`]
/// files, which hold the same format.
pub const EXTENSION: &str = "pigment";
/// The MIME type of [`EXTENSION`] files.
pub const MIME: &str = "application/x-pigment";
/// What file managers call [`EXTENSION`] files.
pub const DOCUMENT_KIND: &str = "Pigment Image";

/// What opening a document saved by Pigment 0.1 to 0.4 says (see [`is_legacy_pigment`]).
pub const LEGACY_PIGMENT_MESSAGE: &str = "This file was saved by Pigment 0.4 or earlier. Opening these files is coming in a later update.";

/// `Pigment 0.5.0 (based on PhotoCraft 0.23.1)`: `--version`, About and logs.
pub fn version_line() -> String {
    format!("{NAME} {} (based on {UPSTREAM_NAME} {UPSTREAM_VERSION})", crate_version())
}

/// [`version_line`] without the leading name, as clap prints after the command's name.
pub fn version_detail() -> &'static str {
    static DETAIL: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    DETAIL.get_or_init(|| format!("{} (based on {UPSTREAM_NAME} {UPSTREAM_VERSION})", crate_version()))
}

fn crate_version() -> &'static str {
    match option_env!("PHOTOCRAFT_OVERRIDE_VERSION") {
        Some(v) => v,
        None => VERSION,
    }
}

/// Whether `ext` (without the dot, any case) names the native format: `.pigment` or PhotoCraft's
/// `.pcraft`.
pub fn is_native_extension(ext: &str) -> bool {
    let ext = ext.trim_start_matches('.');
    ext.eq_ignore_ascii_case(EXTENSION) || ext.eq_ignore_ascii_case(crate::EXTENSION)
}

/// Whether `name` (a file name or path) ends in `.pigment`, in any case.
pub fn has_pigment_extension(name: &str) -> bool {
    name.rsplit(['/', '\\']).next().and_then(|n| n.rsplit_once('.')).is_some_and(|(base, ext)| !base.is_empty() && ext.eq_ignore_ascii_case(EXTENSION))
}

/// The entry every Pigment 0.1–0.4 document holds (its layers are `layers/<id>.png`).
pub const LEGACY_DOCUMENT_ENTRY: &str = "document.json";

/// Whether `bytes` are a document saved by Pigment 0.1 to 0.4: a ZIP archive with a
/// [`LEGACY_DOCUMENT_ENTRY`] and no PhotoCraft manifest. Reads only the archive's directory.
/// Never panics.
pub fn is_legacy_pigment(bytes: &[u8]) -> bool {
    if !bytes.starts_with(b"PK\x03\x04") {
        return false;
    }
    craft_zip::Archive::open(bytes, craft_zip::Limits { max_entries: u16::MAX.into(), max_total_bytes: 0 })
        .is_ok_and(|archive| archive.contains(LEGACY_DOCUMENT_ENTRY) && !archive.contains(craft_pcraft_format::MANIFEST))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_version_line_names_pigment_and_its_upstream() {
        assert_eq!(version_line(), format!("Pigment {} (based on PhotoCraft 0.23.1)", env!("CARGO_PKG_VERSION")));
        assert_eq!(format!("{NAME} {}", version_detail()), version_line());
    }

    #[test]
    fn native_extensions() {
        for ext in ["pigment", "PIGMENT", ".pigment", "pcraft", "PCraft"] {
            assert!(is_native_extension(ext), "{ext}");
        }
        for ext in ["psd", "pigments", ""] {
            assert!(!is_native_extension(ext), "{ext}");
        }
        assert!(has_pigment_extension("/a/b/Poster.Pigment"));
        assert!(!has_pigment_extension(".pigment"));
        assert!(!has_pigment_extension("poster.pcraft"));
    }

    #[test]
    fn legacy_documents_are_told_apart_from_native_ones() {
        let zip = |names: &[&str]| {
            let mut w = craft_zip::Writer::new();
            for n in names {
                w.add(n, b"{}", craft_zip::Compression::Stored).unwrap();
            }
            w.finish().unwrap()
        };
        assert!(is_legacy_pigment(&zip(&["document.json", "layers/1.png"])));
        assert!(!is_legacy_pigment(&zip(&["manifest.json", "document.json"])));
        assert!(!is_legacy_pigment(&zip(&["layers/1.png"])));
        assert!(!is_legacy_pigment(b"PK\x03\x04 not really a zip"));
        assert!(!is_legacy_pigment(b""));
        let doc = photocraft_doc::Document::new(
            "Native",
            photocraft_doc::Size { width: 4, height: 4 },
            photocraft_color::ColorMode::Rgb,
            photocraft_color::SampleType::U8,
        );
        let native = crate::save_to_bytes(&doc, &crate::SaveOptions::default()).unwrap();
        assert!(!is_legacy_pigment(&native));
    }
}
