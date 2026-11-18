//! The container of a Pigment 0.1–0.4 document: a ZIP (`src/shared/zip.js`, stored or deflated
//! entries) holding `document.json` and the pixels next to it. Everything is read within
//! limits: entry count, the size of each entry, the bytes all entries may expand to, and the
//! pixel memory the document may take.
//!
//! | Entry | Holds |
//! |---|---|
//! | `mimetype` | `application/x-pigment` (ignored) |
//! | `document.json` | the description (`Document.describe()`) |
//! | `layers/<id>.png` | a raster layer's pixels, 8-bit straight RGBA |
//! | `layers/<id>.u16`, `.f32` | the same layer at 16 or 32 bits: straight RGBA, little-endian |
//! | `masks/<id>.png` | a layer mask (grey in RGB), document-sized |
//! | `selection.bin`, `channels/<id>.bin` | width × height bytes each |
//! | `profile.icc` | the document profile (written by the unfinished 0.5 only) |
//! | `patterns/<id>.png`, `smart/<id>.pigment`, `smart/<id>.png` | pattern fills and smart objects |
//! | `thumbnail.png` | a preview (ignored) |

use photocraft_codecs::{self as codecs, ChannelLayout, SampleType as CSample};
use photocraft_color::PixelFormat;
use photocraft_geom::Rect;
use photocraft_raster::Surface;
use serde_json::Value;

use super::damaged;
use crate::IoError;

/// The description of the document.
pub(crate) const DOCUMENT: &str = photocraft_format::brand::LEGACY_DOCUMENT_ENTRY;
/// Entries one archive may declare: a document holds up to three per layer.
const MAX_ENTRIES: u64 = 65_535;
/// What all the entries read may expand to together.
const MAX_TOTAL_BYTES: u64 = 4 << 30;
/// `document.json`.
const MAX_DOCUMENT_BYTES: u64 = 64 << 20;
/// One PNG file, or one plane of raw samples.
pub(crate) const MAX_ENTRY_BYTES: u64 = 1 << 30;
/// Canvas and layer side limit (Photoshop's PSB limit, as for the other importers).
pub(crate) const MAX_SIDE: u32 = 300_000;
/// Pixel memory one document may take (the tiles its layers, masks and channels keep).
pub(crate) const MAX_PIXEL_BYTES: u64 = 2 << 30;

fn too_large(what: &str) -> IoError {
    IoError::Unsupported(format!("this Pigment 0.4 document is too large to open: {what}"))
}

/// An 8-bit RGBA image decoded from one of the document's PNG files.
pub(crate) struct Rgba8 {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) data: Vec<u8>,
}

/// The open archive and the pixel memory still available.
pub(crate) struct Container<'a> {
    archive: craft_zip::Archive<'a>,
    /// Bytes of [`MAX_PIXEL_BYTES`] not yet taken.
    pub(crate) pixel_budget: u64,
}

impl<'a> Container<'a> {
    pub(crate) fn open(bytes: &'a [u8]) -> Result<Self, IoError> {
        let archive =
            craft_zip::Archive::open(bytes, craft_zip::Limits { max_entries: MAX_ENTRIES, max_total_bytes: MAX_TOTAL_BYTES }).map_err(|e| match e {
                craft_zip::Error::TooManyEntries { .. } => too_large(&e.to_string()),
                e => damaged(e.to_string()),
            })?;
        Ok(Container { archive, pixel_budget: MAX_PIXEL_BYTES })
    }

    pub(crate) fn contains(&self, name: &str) -> bool {
        self.archive.contains(name)
    }

    /// The size entry `name` says it has, without reading it.
    pub(crate) fn declared_size(&mut self, name: &str) -> Option<u64> {
        self.archive.declared_size(name)
    }

    /// The bytes of entry `name` (`None`: no such entry). A limit that is reached is an error for
    /// the whole document; an entry that does not decode is `Err(Ok(why))`, for the caller to
    /// report and carry on without it.
    pub(crate) fn read(&mut self, name: &str, max: u64) -> Result<Option<Vec<u8>>, Result<String, IoError>> {
        match self.archive.read(name, max) {
            Ok(data) => Ok(data),
            Err(e @ craft_zip::Error::BudgetSpent { .. }) => Err(Err(too_large(&e.to_string()))),
            Err(e @ craft_zip::Error::EntryTooLarge { .. }) if max >= MAX_ENTRY_BYTES => Err(Err(too_large(&e.to_string()))),
            Err(e) => Err(Ok(e.to_string())),
        }
    }

    /// `document.json`, parsed. Without it, or when it is not JSON, the file is damaged.
    pub(crate) fn document(&mut self) -> Result<Value, IoError> {
        let data = match self.read(DOCUMENT, MAX_DOCUMENT_BYTES) {
            Ok(Some(data)) => data,
            Ok(None) => return Err(damaged(format!("{DOCUMENT} is missing"))),
            Err(Ok(why)) => return Err(damaged(why)),
            Err(Err(limit)) => return Err(limit),
        };
        // serde_json refuses nesting deeper than 128 levels, so no description can overflow the stack.
        serde_json::from_slice(&data).map_err(|e| damaged(format!("{DOCUMENT} is not valid JSON ({e})")))
    }

    /// The PNG entry `name` as 8-bit RGBA. `Ok(Err(why))`: it is missing or does not decode.
    pub(crate) fn png(&mut self, name: &str) -> Result<Result<Rgba8, String>, IoError> {
        let data = match self.read(name, MAX_ENTRY_BYTES) {
            Ok(Some(data)) => data,
            Ok(None) => return Ok(Err("is missing from the file".into())),
            Err(Ok(why)) => return Ok(Err(format!("could not be read ({why})"))),
            Err(Err(limit)) => return Err(limit),
        };
        let mut opts = codecs::DecodeOptions::default();
        opts.limits.max_width = MAX_SIDE;
        opts.limits.max_height = MAX_SIDE;
        // The decoded image and its 8-bit RGBA copy live together for a moment.
        opts.limits.max_alloc = self.pixel_budget;
        let image = match codecs::decode_as_with(codecs::Format::Png, &data, &opts) {
            Ok(image) => image,
            Err(e) => return Ok(Err(format!("could not be decoded ({e})"))),
        };
        drop(data);
        let (width, height) = image.dimensions();
        let bytes = u64::from(width) * u64::from(height) * 4;
        if bytes > self.pixel_budget {
            return Err(too_large("its layers need more pixel memory than the 2 GiB limit"));
        }
        let rgba = image.converted(ChannelLayout::Rgba, CSample::U8);
        let data = rgba.data().to_vec();
        if data.len() as u64 != bytes {
            return Ok(Err("could not be decoded (its size is inconsistent)".into()));
        }
        Ok(Ok(Rgba8 { width, height, data }))
    }

    /// Writes `bytes` (encoded samples of `surface`'s format, row-major over `rect`) into
    /// `surface` and charges the tiles it keeps to the pixel budget.
    pub(crate) fn write(&mut self, surface: &mut Surface, rect: Rect, bytes: &[u8]) -> Result<(), IoError> {
        let fmt: PixelFormat = surface.format();
        if photocraft_raster::tile_storage_bytes(rect, &fmt) > self.pixel_budget {
            return Err(too_large("its layers need more pixel memory than the 2 GiB limit"));
        }
        let before = surface.tile_count();
        surface.try_write_interleaved(rect, bytes).map_err(|e| IoError::OutOfMemory(e.to_string()))?;
        surface.prune();
        let kept = surface.tile_count().saturating_sub(before) as u64;
        self.pixel_budget = self.pixel_budget.saturating_sub(photocraft_raster::stored_tiles_bytes(kept, &fmt));
        Ok(())
    }
}
