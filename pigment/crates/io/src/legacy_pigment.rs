//! Documents saved by Pigment 0.1 to 0.4, the Electron app that came before Pigment on PhotoCraft:
//! a ZIP with `document.json` and `layers/<id>.png`, under the same `.pigment` extension that
//! Pigment now saves PhotoCraft's native format with (docs/FORK.md). They are recognised by their
//! content ([`photocraft_format::brand::is_legacy_pigment`]), whatever the file is called, before
//! any other importer sees them.
//!
//! [`import`] is the one place their importer goes: every open path (File › Open, Place, the CLI,
//! MCP, scripts) reaches it through `import_stages`. Until it exists, opening one fails with
//! [`IoError::LegacyPigment`].

use crate::{ImportResult, IoError};

/// Whether `bytes` are a Pigment 0.1–0.4 document.
pub fn is_legacy(bytes: &[u8]) -> bool {
    photocraft_format::brand::is_legacy_pigment(bytes)
}

/// Opens a Pigment 0.1–0.4 document. Not written yet: always [`IoError::LegacyPigment`].
pub(crate) fn import(_name: &str, _bytes: &[u8], _ctl: &photocraft_raster::Interrupt) -> Result<ImportResult, IoError> {
    Err(IoError::LegacyPigment)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What Pigment 0.4 saved: `document.json` and one PNG per layer, no `manifest.json`.
    fn legacy_file() -> Vec<u8> {
        let mut w = craft_zip::Writer::new();
        w.add("document.json", br#"{"version":4,"width":4,"height":4,"layers":[{"id":1}]}"#, craft_zip::Compression::Deflated).unwrap();
        w.add("layers/1.png", b"\x89PNG\r\n\x1a\n", craft_zip::Compression::Stored).unwrap();
        w.finish().unwrap()
    }

    #[test]
    fn a_pigment_0_4_document_fails_with_the_typed_error_whatever_its_name() {
        let bytes = legacy_file();
        assert!(is_legacy(&bytes));
        for name in ["poster.pigment", "poster.PIGMENT", "poster.zip", "poster"] {
            let e = crate::import(name, &bytes).err().unwrap();
            assert!(matches!(e, IoError::LegacyPigment), "{name}: {e:?}");
            assert_eq!(e.to_string(), "This file was saved by Pigment 0.4 or earlier. Opening these files is coming in a later update.");
        }
        // File › Open As Pigment, and preflight, see it too.
        assert!(matches!(crate::import_with_options_as("poster.pigment", &bytes, Some("pigment"), &Default::default()), Err(IoError::LegacyPigment)));
        assert_eq!(crate::import_preflight("poster.pigment", &bytes), crate::ImportPreflight::Unbounded);
    }

    #[test]
    fn pigment_saves_the_native_format_and_opens_it_again() {
        let doc = photocraft_doc::Document::new(
            "Native",
            photocraft_doc::Size { width: 4, height: 4 },
            photocraft_color::ColorMode::Rgb,
            photocraft_color::SampleType::U8,
        );
        let opts = crate::ExportOptions::default();
        let saved = crate::export(&doc, "poster.pigment", &opts).unwrap();
        assert!(!is_legacy(&saved.bytes));
        let opened = crate::import("poster.pigment", &saved.bytes).unwrap();
        assert_eq!((opened.document.size.width, opened.document.size.height), (4, 4));
        // A `.pcraft` still opens.
        let pcraft = crate::export(&doc, "poster.pcraft", &opts).unwrap();
        assert!(crate::import("poster.pcraft", &pcraft.bytes).is_ok());
    }
}
