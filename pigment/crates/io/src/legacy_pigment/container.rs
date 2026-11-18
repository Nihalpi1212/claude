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

pub(crate) fn too_large(what: &str) -> IoError {
    IoError::Unsupported(format!("this Pigment 0.4 document is too large to open: {what}"))
}

/// An 8-bit RGBA image decoded from one of the document's PNG files.
pub(crate) struct Rgba8 {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) data: Vec<u8>,
}

/// Pixel memory the patterns of one document may take (decoded tiles).
pub(crate) const MAX_PATTERN_BYTES: u64 = 256 << 20;

/// PNG `data` as 8-bit RGBA; the decoder allocates at most `budget` bytes. `Err(why)` finishes
/// "the image …". The caller checks the result against what it may keep.
pub(crate) fn decode_png(data: &[u8], budget: u64) -> Result<Rgba8, String> {
    let mut opts = codecs::DecodeOptions::default();
    opts.limits.max_width = MAX_SIDE;
    opts.limits.max_height = MAX_SIDE;
    opts.limits.max_alloc = budget;
    let image = codecs::decode_as_with(codecs::Format::Png, data, &opts).map_err(|e| format!("could not be decoded ({e})"))?;
    let (width, height) = image.dimensions();
    let bytes = u64::from(width) * u64::from(height) * 4;
    // The decoded samples are taken as they are when they already are 8-bit RGBA, not copied.
    let converted = match image.converted(ChannelLayout::Rgba, CSample::U8) {
        std::borrow::Cow::Owned(rgba) => Some(rgba),
        std::borrow::Cow::Borrowed(_) => None,
    };
    let data = match converted {
        Some(rgba) => {
            drop(image);
            rgba.into_data()
        }
        None => image.into_data(),
    };
    if data.len() as u64 != bytes {
        return Err("could not be decoded (its size is inconsistent)".into());
    }
    Ok(Rgba8 { width, height, data })
}

/// The width and height a PNG's header gives (`IHDR`, which comes first), from the first
/// [`PNG_HEAD`] bytes of the file; `None` when they are not a PNG's.
pub(crate) fn png_size(head: &[u8]) -> Option<(u32, u32)> {
    let head = head.get(..PNG_HEAD)?;
    if &head[..8] != b"\x89PNG\r\n\x1a\n" || &head[12..16] != b"IHDR" {
        return None;
    }
    let be = |i: usize| u32::from_be_bytes([head[i], head[i + 1], head[i + 2], head[i + 3]]);
    Some((be(16), be(20)))
}

/// The bytes of a PNG that hold its size.
pub(crate) const PNG_HEAD: usize = 24;

/// What one document may still take: the bytes its entries expand to and the pixel memory. A
/// smart object's nested document takes from its host's.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Budget {
    /// Of [`MAX_TOTAL_BYTES`].
    pub(crate) bytes: u64,
    /// Of [`MAX_PIXEL_BYTES`].
    pub(crate) pixels: u64,
}

impl Default for Budget {
    fn default() -> Self {
        Budget { bytes: MAX_TOTAL_BYTES, pixels: MAX_PIXEL_BYTES }
    }
}

/// The open archive and the pixel memory still available.
pub(crate) struct Container<'a> {
    archive: craft_zip::Archive<'a>,
    /// Bytes of [`MAX_PIXEL_BYTES`] not yet taken.
    pub(crate) pixel_budget: u64,
    /// Bytes of [`MAX_TOTAL_BYTES`] not yet read (entries of nested documents included).
    bytes_left: u64,
}

impl<'a> Container<'a> {
    pub(crate) fn open(bytes: &'a [u8], budget: Budget) -> Result<Self, IoError> {
        let archive = craft_zip::Archive::open(bytes, craft_zip::Limits { max_entries: MAX_ENTRIES, max_total_bytes: budget.bytes }).map_err(|e| match e {
            craft_zip::Error::TooManyEntries { .. } => too_large(&e.to_string()),
            e => damaged(e.to_string()),
        })?;
        Ok(Container { archive, pixel_budget: budget.pixels, bytes_left: budget.bytes })
    }

    /// What is left of the budget.
    pub(crate) fn budget(&self) -> Budget {
        Budget { bytes: self.bytes_left, pixels: self.pixel_budget }
    }

    /// Takes what a nested document used: the budget it had left is what this one has left.
    pub(crate) fn spent_nested(&mut self, left: Budget) {
        self.bytes_left = self.bytes_left.min(left.bytes);
        self.pixel_budget = self.pixel_budget.min(left.pixels);
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
        if self.bytes_left == 0 {
            return Err(Err(too_large("its entries expand to more than 4 GiB")));
        }
        // The whole budget is what may still be read, whatever one entry may hold.
        let limited = max > self.bytes_left;
        match self.archive.read(name, max.min(self.bytes_left)) {
            Ok(data) => {
                self.bytes_left = self.bytes_left.saturating_sub(data.as_ref().map_or(0, |d| d.len() as u64));
                Ok(data)
            }
            Err(e @ craft_zip::Error::BudgetSpent { .. }) => Err(Err(too_large(&e.to_string()))),
            Err(e @ craft_zip::Error::EntryTooLarge { .. }) if max >= MAX_ENTRY_BYTES || limited => Err(Err(too_large(&e.to_string()))),
            Err(e) => Err(Ok(e.to_string())),
        }
    }

    /// Refuses the document when the PNG entry `name` says it is larger than `cost` (what its
    /// pixels will take, from its width and height) lets the pixel budget hold. Only the PNG's
    /// header is read: an image that cannot be kept is neither inflated nor decoded. An entry
    /// that is missing or is not a PNG passes, for [`Self::png`] to report.
    pub(crate) fn price_png(&mut self, name: &str, cost: impl FnOnce(u32, u32) -> u64) -> Result<(), IoError> {
        let want = (PNG_HEAD as u64).min(self.declared_size(name).unwrap_or(0));
        if want > self.bytes_left {
            // Reading it fails the document, as it is.
            return Ok(());
        }
        let head = match self.archive.read_head(name, PNG_HEAD) {
            Ok(Some(head)) => head,
            Ok(None) | Err(_) => return Ok(()),
        };
        self.bytes_left = self.bytes_left.saturating_sub(head.len() as u64);
        match png_size(&head) {
            Some((w, h)) if cost(w, h) > self.pixel_budget => Err(too_large("its layers need more pixel memory than the 2 GiB limit")),
            _ => Ok(()),
        }
    }

    /// Refuses the document when `rect` in `fmt` takes more than the pixel budget has left:
    /// asked before the pixels are read and converted, which takes as much memory again.
    pub(crate) fn price(&self, rect: Rect, fmt: &PixelFormat) -> Result<(), IoError> {
        if photocraft_raster::tile_storage_bytes(rect, fmt) > self.pixel_budget {
            return Err(too_large("its layers need more pixel memory than the 2 GiB limit"));
        }
        Ok(())
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
        // The decoded image and its 8-bit RGBA copy live together for a moment.
        let png = match decode_png(&data, self.pixel_budget) {
            Ok(png) => png,
            Err(why) => return Ok(Err(why)),
        };
        if png.data.len() as u64 > self.pixel_budget {
            return Err(too_large("its layers need more pixel memory than the 2 GiB limit"));
        }
        Ok(Ok(png))
    }

    /// Writes `bytes` (encoded samples of `surface`'s format, row-major over `rect`) into
    /// `surface` and charges the tiles it keeps to the pixel budget.
    pub(crate) fn write(&mut self, surface: &mut Surface, rect: Rect, bytes: &[u8]) -> Result<(), IoError> {
        let fmt: PixelFormat = surface.format();
        self.price(rect, &fmt)?;
        let before = surface.tile_count();
        surface.try_write_interleaved(rect, bytes).map_err(|e| IoError::OutOfMemory(e.to_string()))?;
        surface.prune();
        let kept = surface.tile_count().saturating_sub(before) as u64;
        self.pixel_budget = self.pixel_budget.saturating_sub(photocraft_raster::stored_tiles_bytes(kept, &fmt));
        Ok(())
    }
}
