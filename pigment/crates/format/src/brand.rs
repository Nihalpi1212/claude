//! Pigment's identity: the product name, its version, the upstream PhotoCraft release it is based
//! on, its application id and its own native file extension (see `docs/FORK.md`). Pigment saves
//! PhotoCraft's native format unchanged (craft-pcraft-format's `manifest.json` and tiles), so files
//! exchange with PhotoCraft; only the extension and the names differ.
//!
//! Pigment 0.1 to 0.4 were a different program (an Electron app) whose `.pigment` files hold
//! another format: [`is_legacy_pigment`] tells them apart, and `photocraft-io` converts them
//! (`legacy_pigment`). One that cannot be read fails with [`LEGACY_PIGMENT_DAMAGED`] and why.

/// The product name users see.
pub const NAME: &str = "Pigment";
/// Pigment's own version (the workspace version).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// The upstream project Pigment is based on.
pub const UPSTREAM_NAME: &str = "PhotoCraft"; // upstream-ok
/// The PhotoCraft release this copy of Pigment is based on (`UPSTREAM-REVISION`).
pub const UPSTREAM_VERSION: &str = "0.23.1";
/// The upstream commit this copy is built on, short (the first 7 characters of
/// `UPSTREAM-REVISION`): upstream's version moves slowly while its tree moves fast, so the
/// version line names both.
pub const UPSTREAM_REVISION: &str = "057297b";
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

/// How the error for a document saved by Pigment 0.1 to 0.4 that cannot be read begins (see
/// [`is_legacy_pigment`]); the reason follows after a colon.
pub const LEGACY_PIGMENT_DAMAGED: &str = "This Pigment 0.4 file is damaged";

/// `Pigment 0.5.0 (based on PhotoCraft 0.23.1+057297b)`: `--version`, About and logs.
pub fn version_line() -> String {
    format!("{NAME} {}", version_detail())
}

/// [`version_line`] without the leading name, as clap prints after the command's name.
pub fn version_detail() -> &'static str {
    static DETAIL: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    DETAIL.get_or_init(|| format!("{} (based on {UPSTREAM_NAME} {UPSTREAM_VERSION}+{UPSTREAM_REVISION})", crate_version()))
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

/// [`is_legacy_pigment`] for the archive `r` holds, from its directory alone: the end record (and
/// its ZIP64 counterpart) and the central directory are read, never the entries, so a large file
/// is told apart in a few reads. `Ok(None)` when the directory cannot be read that way (a damaged
/// archive, or one with data before it): the caller then asks [`is_legacy_pigment`] of the whole
/// file.
pub fn is_legacy_pigment_reader<R: std::io::Read + std::io::Seek>(r: &mut R) -> std::io::Result<Option<bool>> {
    use std::io::{Read, SeekFrom};
    /// The end record, and the comment that may follow it.
    const END: u64 = 22;
    const MAX_COMMENT: u64 = 65_535;
    /// A central directory larger than this is read with the whole file.
    const MAX_DIRECTORY: u64 = 256 << 20;
    let u16_at = |b: &[u8], o: usize| b.get(o..o + 2).map(|s| u16::from_le_bytes([s[0], s[1]]));
    let u32_at = |b: &[u8], o: usize| b.get(o..o + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]));
    let u64_at = |b: &[u8], o: usize| b.get(o..o + 8).and_then(|s| <[u8; 8]>::try_from(s).ok()).map(u64::from_le_bytes);
    let read_at = |r: &mut R, at: u64, n: u64| -> std::io::Result<Vec<u8>> {
        r.seek(SeekFrom::Start(at))?;
        let mut out = Vec::new();
        r.by_ref().take(n).read_to_end(&mut out)?;
        Ok(out)
    };

    let len = r.seek(SeekFrom::End(0))?;
    if len < END || read_at(r, 0, 4)? != b"PK\x03\x04" {
        return Ok(Some(false));
    }
    let tail_at = len - len.min(END + MAX_COMMENT);
    let tail = read_at(r, tail_at, len - tail_at)?;
    let Some(end) = (0..=tail.len().saturating_sub(END as usize)).rev().find(|&i| tail[i..].starts_with(b"PK\x05\x06")) else { return Ok(None) };
    let (Some(count), Some(size), Some(offset)) = (u16_at(&tail, end + 10), u32_at(&tail, end + 12), u32_at(&tail, end + 16)) else { return Ok(None) };
    let (mut count, mut size, mut offset) = (u64::from(count), u64::from(size), u64::from(offset));
    let end_at = tail_at + end as u64;
    if count == 0xffff || size == 0xffff_ffff || offset == 0xffff_ffff {
        // ZIP64: the locator right before the end record gives the ZIP64 end record.
        let Some(locator_at) = end_at.checked_sub(20) else { return Ok(None) };
        let locator = read_at(r, locator_at, 20)?;
        let (Some(0x0706_4b50), Some(record_at)) = (u32_at(&locator, 0), u64_at(&locator, 8)) else { return Ok(None) };
        let record = read_at(r, record_at, 56)?;
        let (Some(0x0606_4b50), Some(c), Some(sz), Some(o)) = (u32_at(&record, 0), u64_at(&record, 32), u64_at(&record, 40), u64_at(&record, 48)) else {
            return Ok(None);
        };
        (count, size, offset) = (c, sz, o);
    }
    if size > MAX_DIRECTORY || offset.checked_add(size).is_none_or(|e| e > end_at) {
        return Ok(None);
    }
    let directory = read_at(r, offset, size)?;
    let (mut document, mut manifest, mut at) = (false, false, 0usize);
    for _ in 0..count {
        let (Some(0x0201_4b50), Some(name), Some(extra), Some(comment)) =
            (u32_at(&directory, at), u16_at(&directory, at + 28), u16_at(&directory, at + 30), u16_at(&directory, at + 32))
        else {
            return Ok(None);
        };
        let start = at + 46;
        let Some(name) = directory.get(start..start + usize::from(name)) else { return Ok(None) };
        document |= name == LEGACY_DOCUMENT_ENTRY.as_bytes();
        manifest |= name == craft_pcraft_format::MANIFEST.as_bytes();
        at = start + name.len() + usize::from(extra) + usize::from(comment);
    }
    Ok(Some(document && !manifest))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A reader that counts the bytes read through it.
    struct Counted<R> {
        inner: R,
        read: u64,
    }

    impl<R: std::io::Read> std::io::Read for Counted<R> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let n = self.inner.read(buf)?;
            self.read += n as u64;
            Ok(n)
        }
    }

    impl<R: std::io::Seek> std::io::Seek for Counted<R> {
        fn seek(&mut self, pos: std::io::SeekFrom) -> std::io::Result<u64> {
            self.inner.seek(pos)
        }
    }

    fn by_reader(bytes: &[u8]) -> (Option<bool>, u64) {
        let mut r = Counted { inner: std::io::Cursor::new(bytes), read: 0 };
        (is_legacy_pigment_reader(&mut r).unwrap(), r.read)
    }

    /// File › Save asks whether the file is still a Pigment 0.1–0.4 document before it writes over
    /// it: a large file in the new format is told apart from its directory alone.
    #[test]
    fn a_legacy_document_is_told_from_its_directory_alone() {
        let fixture = |name: &str| std::fs::read(format!("{}/../io/tests/fixtures/pigment-0.4/{name}.pigment", env!("CARGO_MANIFEST_DIR"))).unwrap();
        for name in ["v1-raster-offset", "v3-groups", "v3-smart-filters"] {
            let bytes = fixture(name);
            assert!(is_legacy_pigment(&bytes), "{name}");
            assert_eq!(by_reader(&bytes).0, Some(true), "{name}");
        }

        // 64 MB in the new format, with a comment after the end record.
        let mut w = craft_zip::Writer::new();
        w.add(craft_pcraft_format::MANIFEST, b"{}", craft_zip::Compression::Stored).unwrap();
        w.add(LEGACY_DOCUMENT_ENTRY, b"{}", craft_zip::Compression::Stored).unwrap();
        let tile = vec![7u8; 1 << 20];
        for i in 0..64 {
            w.add(&format!("tiles/{i}"), &tile, craft_zip::Compression::Stored).unwrap();
        }
        let native = w.finish().unwrap();
        assert!(native.len() > 64 << 20);
        let (legacy, read) = by_reader(&native);
        assert_eq!(legacy, Some(false));
        assert!(read < 80 << 10, "{read} bytes were read");
        // A document of the new format saved by Pigment.
        let doc = photocraft_doc::Document::new("x", photocraft_geom::Size::new(8, 8), photocraft_color::ColorMode::Rgb, photocraft_color::SampleType::U8);
        assert_eq!(by_reader(&crate::save_to_bytes(&doc, &Default::default()).unwrap()).0, Some(false));

        // Not an archive, or one whose directory does not read: the whole file decides.
        assert_eq!(by_reader(b"").0, Some(false));
        assert_eq!(by_reader(b"\x89PNG\r\n\x1a\n and more bytes than an end record").0, Some(false));
        let groups = fixture("v3-groups");
        assert_eq!(by_reader(&groups[..groups.len() - 30]).0, None);
        let mut shifted = groups.clone();
        let end = shifted.windows(4).rposition(|w| w == b"PK\x05\x06").unwrap();
        shifted[end + 16] ^= 0x01;
        assert!(matches!(by_reader(&shifted).0, None | Some(true)));
    }

    #[test]
    fn the_version_line_names_pigment_and_its_upstream() {
        assert_eq!(version_line(), format!("Pigment {} (based on PhotoCraft 0.23.1+057297b)", env!("CARGO_PKG_VERSION")));
        assert_eq!(format!("{NAME} {}", version_detail()), version_line());
    }

    #[test]
    fn the_short_revision_is_the_one_in_upstream_revision() {
        let full = include_str!("../../../UPSTREAM-REVISION").trim();
        assert_eq!(full.len(), 40, "{full}");
        assert!(full.starts_with(UPSTREAM_REVISION), "UPSTREAM-REVISION {full} vs brand::UPSTREAM_REVISION {UPSTREAM_REVISION}");
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
