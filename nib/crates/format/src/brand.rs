//! Nib's identity: the product name, its version, the upstream VectorCraft release it is based on,
//! and Nib's own native file extension (see `docs/FORK.md`). Nib saves VectorCraft's native format
//! unchanged, so files exchange with VectorCraft; only the extension and the names differ.

/// The product name users see.
pub const NAME: &str = "Nib";
/// Nib's own version (the workspace version).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// The upstream project Nib is based on.
pub const UPSTREAM_NAME: &str = "VectorCraft"; // upstream-ok
/// The VectorCraft release this copy of Nib is based on (`UPSTREAM-REVISION`).
pub const UPSTREAM_VERSION: &str = "0.24.1";
/// Nib's native document extension (without the dot). Nib also opens [`crate::EXTENSION`] and
/// [`crate::LEGACY_EXTENSION`] files, which hold the same format.
pub const EXTENSION: &str = "nibart";
/// The MIME type of [`EXTENSION`] files.
pub const MIME: &str = "application/x-nib-art";
/// What file managers call [`EXTENSION`] files.
pub const DOCUMENT_KIND: &str = "Nib Artwork";

/// `Nib 0.1.0 (based on VectorCraft 0.24.1)`: `--version`, About and bug reports.
pub fn version_line() -> String {
    format!("{NAME} {VERSION} (based on {UPSTREAM_NAME} {UPSTREAM_VERSION})")
}

/// The native file's `generator`. It names the VectorCraft release first, so VectorCraft and Nib
/// read the file as that release wrote it (Twist angles turn by its version), then Nib's own.
pub fn generator() -> String {
    format!("{UPSTREAM_NAME} {UPSTREAM_VERSION} ({NAME} {VERSION})")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_version_line_names_nib_and_its_upstream() {
        assert_eq!(version_line(), format!("Nib {} (based on VectorCraft 0.24.1)", env!("CARGO_PKG_VERSION")));
    }

    #[test]
    fn the_generator_reads_as_the_upstream_release() {
        assert!(vectorcraft_doc::twist::written_clockwise(Some(&generator())), "{}", generator());
    }
}
