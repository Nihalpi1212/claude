//! Documents saved by Pigment 0.1 to 0.4, the Electron app that came before Pigment on PhotoCraft:
//! a ZIP with `document.json` and `layers/<id>.png`, under the same `.pigment` extension that
//! Pigment now saves PhotoCraft's native format with (docs/FORK.md). They are recognised by their
//! content ([`photocraft_format::brand::is_legacy_pigment`]), whatever the file is called, before
//! any other importer sees them.
//!
//! [`import`] is the one place their importer lives: every open path (File › Open, Place, the CLI,
//! MCP, scripts) reaches it through `import_stages`. It reads the three versions of
//! `document.json` the app wrote: 1 (Pigment 0.1 and 0.2), 2 (0.3: image modes and bit depth)
//! and 3 (0.4: the document store, mask density and feather; the unfinished 0.5 added the
//! document profile).
//!
//! Everything the app saved is read: the document (size, resolution, image mode and bit depth,
//! colour table, duotone inks, profile), raster, group, adjustment, fill, shape, type and
//! smart-object layers with their common properties, layer masks, vector masks, layer styles and
//! advanced blending, smart filters, the patterns fills and styles use, colour labels and link
//! sets, the selection, saved channels, guides and the ruler origin, saved paths and the work
//! path, the global light, and File Info. What PhotoCraft draws another way, and what it has no
//! place for, is reported one line each in the import warnings and kept in the document's import
//! report ([`photocraft_doc::import_conversion`]), which says the document came from Pigment
//! 0.1–0.4. A file that is one of these documents but cannot be read at all fails with
//! [`IoError::LegacyPigment`].
//!
//! The document keeps its file: File › Save in the interface first asks whether to write the new
//! format over it, which Pigment 0.4 cannot open (`legacy_save_prompt` in photocraft-ui-egui).

mod adjust;
pub(crate) mod blend;
mod container;
mod filters;
mod gradient;
mod info;
mod layers;
mod paint;
mod path;
mod smart;
mod styles;
mod text;

pub use smart::{Renderer, set_renderer as set_smart_object_renderer};

#[cfg(test)]
mod layer_kinds_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod text_smart_tests;

use std::sync::Arc;

use photocraft_color::{Color, ColorMode, PixelFormat, SampleType};
use photocraft_doc::adjust::CurvePoint;
use photocraft_doc::import_conversion::{ConversionDisposition, ConversionEntry, ConversionReason, ConversionReport, ImportConversion, SourceItemRef};
use photocraft_doc::mode::{ColorTable, Duotone, DuotoneInk};
use photocraft_doc::vector::NamedPath;
use photocraft_doc::{AlphaChannel, Document, GlobalLight};
use photocraft_geom::{Rect, Size};
use photocraft_raster::{Interrupt, Surface};
use serde_json::{Map, Value};

use self::container::{Budget, Container, MAX_SIDE};
use self::layers::{LayerReader, Tone, encode_gray};
use crate::ora::Warnings;
use crate::{ImportResult, IoError};

/// The newest `document.json` version this importer knows (Pigment 0.4).
const NEWEST_VERSION: u64 = 3;
/// Saved channels and saved paths one document may hold.
const MAX_CHANNELS: usize = 512;
const MAX_PATHS: usize = 4096;
const MAX_GUIDES: usize = 16_384;

/// Whether `bytes` are a Pigment 0.1–0.4 document.
pub fn is_legacy(bytes: &[u8]) -> bool {
    photocraft_format::brand::is_legacy_pigment(bytes)
}

/// The error for a Pigment 0.1–0.4 document that cannot be read: `why` finishes the sentence
/// "This Pigment 0.4 file is damaged: …".
pub(crate) fn damaged(why: impl Into<String>) -> IoError {
    IoError::LegacyPigment(why.into())
}

/// `#rrggbb` (or `#rgb`) as 8-bit RGB.
fn hex_rgb(s: &str) -> Option<[u8; 3]> {
    let h = s.trim().strip_prefix('#')?;
    if !h.is_ascii() {
        return None;
    }
    let byte = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok();
    match h.len() {
        6 | 8 => Some([byte(0)?, byte(2)?, byte(4)?]),
        3 => {
            let nibble = |i: usize| u8::from_str_radix(&h[i..i + 1], 16).ok().map(|v| v * 17);
            Some([nibble(0)?, nibble(1)?, nibble(2)?])
        }
        _ => None,
    }
}

/// A colour of the description: `#rrggbb`, or `[r, g, b]` in 0–255.
fn rgb_of(v: &Value) -> Option<[u8; 3]> {
    match v {
        Value::String(s) => hex_rgb(s),
        Value::Array(a) if a.len() >= 3 => {
            let c = |i: usize| a[i].as_f64().filter(|n| n.is_finite()).map(|n| n.round().clamp(0.0, 255.0) as u8);
            Some([c(0)?, c(1)?, c(2)?])
        }
        _ => None,
    }
}

/// The document's size: `width` and `height`, rounded as the app rounded them.
fn size_of(d: &Map<String, Value>) -> Result<Size, IoError> {
    let side = |key: &str| -> Result<u32, IoError> {
        let n = d.get(key).and_then(Value::as_f64).filter(|n| n.is_finite()).ok_or_else(|| damaged(format!("{} has no {key}", container::DOCUMENT)))?;
        let n = n.round().max(1.0);
        if n > f64::from(MAX_SIDE) {
            return Err(IoError::Unsupported(format!("this Pigment 0.4 document is too large to open: its {key} is more than {MAX_SIDE} pixels")));
        }
        Ok(n as u32)
    };
    Ok(Size::new(side("width")?, side("height")?))
}

/// The duotone inks (`normalizeDuotone` in shared/pixels/modes.js): each ink's colour and a
/// curve from the grey's ink percentage (0 = paper, 100 = black) to how much of the ink prints.
fn duotone_of(v: Option<&Value>) -> Option<Duotone> {
    let inks = v?.get("inks")?.as_array()?;
    let mut out = Vec::new();
    for (i, ink) in inks.iter().take(4).enumerate() {
        let name = ink
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map_or_else(|| if i == 0 { "Black".to_string() } else { format!("Ink {}", i + 1) }, str::to_string);
        let color = ink.get("color").and_then(rgb_of).unwrap_or([0, 0, 0]).map(|c| f32::from(c) / 255.0);
        let mut curve: Vec<CurvePoint> = ink
            .get("curve")
            .and_then(Value::as_array)
            .map(|points| {
                points
                    .iter()
                    .take(64)
                    .filter_map(|p| {
                        let p = p.as_array()?;
                        let v = |i: usize| p.get(i)?.as_f64().filter(|n| n.is_finite()).map(|n| (n.clamp(0.0, 100.0) / 100.0) as f32);
                        Some(CurvePoint { input: v(0)?, output: v(1)? })
                    })
                    .collect()
            })
            .unwrap_or_default();
        curve.sort_by(|a, b| a.input.total_cmp(&b.input));
        let mut ink = DuotoneInk::new(name, color);
        if curve.len() >= 2 {
            ink.curve = curve;
        }
        out.push(ink);
    }
    (!out.is_empty()).then_some(Duotone { inks: out, psd_raw: None })
}

/// The colour table of an Indexed Color document: up to 256 `[r, g, b]` entries.
fn color_table_of(v: Option<&Value>) -> Option<Vec<[u8; 3]>> {
    let colors: Vec<[u8; 3]> = v?.as_array()?.iter().take(256).filter_map(rgb_of).collect();
    (!colors.is_empty()).then_some(colors)
}

/// One plane of `size` bytes (the selection, a channel) from entry `name`, to be kept in `fmt`;
/// `Ok(Err(why))` when the entry is not that plane. A plane the pixel budget cannot keep is
/// refused before it is read.
fn plane(container: &mut Container<'_>, name: &str, size: Size, fmt: &PixelFormat) -> Result<Result<Vec<u8>, String>, IoError> {
    let expected = u64::from(size.width) * u64::from(size.height);
    match container.declared_size(name) {
        None => return Ok(Err("is missing from the file".into())),
        Some(declared) if declared != expected => return Ok(Err(format!("holds {declared} bytes where the canvas has {expected} pixels"))),
        Some(_) => {}
    }
    container.price(Rect::from_size(size), fmt)?;
    match container.read(name, expected) {
        Ok(Some(data)) if data.len() as u64 == expected => Ok(Ok(data)),
        Ok(_) => Ok(Err("does not hold one byte per pixel".into())),
        Err(Ok(why)) => Ok(Err(format!("could not be read ({why})"))),
        Err(Err(limit)) => Err(limit),
    }
}

/// The image mode, what it makes of the stored RGBA pixels, and the bit depth. The app stored
/// RGBA pixels for every mode, with a mode flag.
struct Model {
    mode: ColorMode,
    tone: Tone,
    depth: SampleType,
    color_table: Option<Vec<[u8; 3]>>,
    duotone: Option<Duotone>,
}

fn model_of(d: &Map<String, Value>, has_ink_channels: bool, warnings: &mut Warnings) -> Model {
    let depth = match d.get("depth").and_then(Value::as_u64) {
        Some(16) => SampleType::U16,
        Some(32) => SampleType::F32,
        _ => SampleType::U8,
    };
    let color_table = color_table_of(d.get("colorTable"));
    let duotone = duotone_of(d.get("duotone"));
    let name = d.get("mode").and_then(Value::as_str).unwrap_or("rgb");
    let (mode, tone, depth) = match name {
        "rgb" => (ColorMode::Rgb, Tone::Color, depth),
        "grayscale" => (ColorMode::Grayscale, Tone::Gray, depth),
        "bitmap" => (ColorMode::Bitmap, Tone::Bitmap, SampleType::U8),
        "duotone" if duotone.is_some() => (ColorMode::Duotone, Tone::Gray, SampleType::U8),
        // Without inks the app showed the grey pixels.
        "duotone" => (ColorMode::Grayscale, Tone::Gray, depth),
        "indexed" if color_table.is_some() => (ColorMode::Indexed, Tone::Color, SampleType::U8),
        // The pixels of the mode the image was split from, which the app showed through the ink
        // channels that were left: with every ink there, the picture is those pixels.
        "multichannel" if has_ink_channels => {
            warnings.note("Multichannel documents open in RGB with the pixels Pigment 0.4 kept under the inks; the ink channels are kept as spot channels");
            (ColorMode::Rgb, Tone::Color, depth)
        }
        // As the app did for a mode that lost its colour table or its channel state.
        "indexed" | "multichannel" => (ColorMode::Rgb, Tone::Color, depth),
        "cmyk" | "lab" => {
            let label = if name == "cmyk" { "CMYK" } else { "Lab" };
            warnings
                .note(&format!("{label} documents of Pigment 0.4 held RGB pixels with a {label} view of them; the document opens in RGB with the same pixels"));
            (ColorMode::Rgb, Tone::Color, depth)
        }
        other => {
            let shown: String = other.chars().take(40).collect();
            warnings.note(&format!("the image mode \"{shown}\" is not known; the document opens in RGB"));
            (ColorMode::Rgb, Tone::Color, depth)
        }
    };
    if depth == SampleType::F32 {
        warnings.note("32-bit documents of Pigment 0.4 held display values (sRGB-encoded, not linear light); the values are kept as they were");
    }
    Model { mode, tone, depth, color_table, duotone }
}

/// Saved channels (`channels/<id>.bin`) and the selection (`selection.bin`, written only when
/// something is selected): one byte per pixel each.
fn channels_and_selection(
    d: &Map<String, Value>,
    spots: Option<&Map<String, Value>>,
    container: &mut Container<'_>,
    document: &mut Document,
    warnings: &mut Warnings,
    ctl: &Interrupt,
) -> Result<(), IoError> {
    let size = document.size;
    let mask_fmt = PixelFormat::new(ColorMode::Grayscale, document.depth, false);
    let canvas = Rect::new(0, 0, size.width as i32, size.height as i32);
    let pixels = size.width as usize * size.height as usize;
    for ch in d.get("channels").and_then(Value::as_array).map_or(&[][..], Vec::as_slice).iter().take(MAX_CHANNELS) {
        ctl.check().map_err(|_| IoError::Cancelled)?;
        let Some(id) = layers::id_of(ch.get("id")) else { continue };
        let name = ch
            .get("name")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map_or_else(|| format!("Alpha {}", document.channels.len() + 1), str::to_string);
        let data = match plane(container, &format!("channels/{id}.bin"), size, &mask_fmt)? {
            Ok(data) => data,
            Err(why) => {
                warnings.note(&format!("the channel \"{name}\" {why} and was left out"));
                continue;
            }
        };
        // An ink of a Multichannel document. The app drew ink planes with white as no ink; a
        // spot channel holds ink density.
        let ink = spots.and_then(|s| s.get(&id)).and_then(|s| s.get("color")).and_then(rgb_of);
        let mut surface = Surface::new(mask_fmt);
        container.write(&mut surface, canvas, &encode_gray(data.into_iter(), pixels, mask_fmt, ink.is_some()))?;
        let mut channel = AlphaChannel::new(name, surface);
        if let Some([r, g, b]) = ink {
            channel.spot = Some((Color::rgb(f32::from(r) / 255.0, f32::from(g) / 255.0, f32::from(b) / 255.0), 0.0));
        }
        document.channels.push(channel);
    }
    if container.contains("selection.bin") {
        match plane(container, "selection.bin", size, &mask_fmt)? {
            Ok(data) if data.iter().any(|v| *v != 0) => {
                let mut surface = Surface::new(mask_fmt);
                container.write(&mut surface, canvas, &encode_gray(data.into_iter(), pixels, mask_fmt, false))?;
                document.selection = Some(surface);
            }
            Ok(_) => {}
            Err(why) => warnings.note(&format!("the selection {why} and was left out")),
        }
    }
    Ok(())
}

/// Guides and the ruler origin: in `store` since 0.4, guides as a plain list before.
fn guides_and_origin(d: &Map<String, Value>, document: &mut Document, warnings: &mut Warnings) {
    let store = d.get("store").and_then(Value::as_object);
    let stored = |name: &str| store.and_then(|s| s.get(name)).and_then(|c| c.get("data"));
    let guides = stored("guides").or_else(|| d.get("guides")).and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    let mut artboard_guides = false;
    for g in guides.iter().take(MAX_GUIDES) {
        let Some(pos) = g.get("pos").and_then(Value::as_f64).filter(|n| n.is_finite() && n.abs() <= 1.0e7) else { continue };
        // `axis: 'x'` is a position along x: a vertical guide.
        let vertical = match g.get("axis").and_then(Value::as_str) {
            Some("x") => true,
            Some("y") => false,
            _ => continue,
        };
        let list = if vertical { &mut document.guides.vertical } else { &mut document.guides.horizontal };
        if !list.contains(&pos) {
            list.push(pos);
        }
        if let Some(rgb) = g.get("color").and_then(Value::as_str).and_then(hex_rgb) {
            document.guides.set_color(vertical, pos, Some(rgb));
        }
        artboard_guides |= g.get("artboard").is_some_and(|a| !a.is_null());
    }
    if artboard_guides {
        warnings.note("guides that belonged to an artboard open as guides of the document");
    }
    if let Some(origin) = stored("rulerOrigin") {
        let c = |key: &str| origin.get(key).and_then(Value::as_f64).filter(|n| n.is_finite() && n.abs() <= 1.0e7);
        if let (Some(x), Some(y)) = (c("x"), c("y")) {
            document.ruler_origin = [x, y];
        }
    }
    let unknown: Vec<String> = store
        .into_iter()
        .flat_map(Map::keys)
        .filter(|k| !matches!(k.as_str(), "guides" | "rulerOrigin"))
        .take(8)
        .map(|k| format!("\"{}\"", k.chars().take(40).collect::<String>()))
        .collect();
    if !unknown.is_empty() {
        warnings.note(&format!("document data this version does not know was left out: {}", unknown.join(", ")));
    }
}

/// Saved paths, the work path and the global light.
fn paths_and_light(d: &Map<String, Value>, document: &mut Document) {
    for p in d.get("paths").and_then(Value::as_array).map_or(&[][..], Vec::as_slice).iter().take(MAX_PATHS) {
        let Some(path) = p.get("path").and_then(path::to_path) else { continue };
        let name =
            p.get("name").and_then(Value::as_str).filter(|s| !s.trim().is_empty()).map_or_else(|| format!("Path {}", document.paths.len() + 1), str::to_string);
        document.paths.push(NamedPath { name, path, psd_raw: None });
    }
    document.work_path = d.get("workPath").and_then(path::to_path).filter(|p| !p.is_empty());
    if let Some(light) = d.get("globalLight").filter(|l| l.is_object()) {
        let n = |key: &str| light.get(key).and_then(Value::as_f64).filter(|n| n.is_finite());
        if let Some(angle) = n("angle") {
            document.global_light = GlobalLight { angle: angle.clamp(-360.0, 360.0) as f32, altitude: n("altitude").unwrap_or(30.0).clamp(0.0, 90.0) as f32 };
        }
    }
}

/// The document profile (written by the unfinished 0.5 only): `profile.icc`, or a built-in
/// named by its id.
fn profile(d: &Map<String, Value>, container: &mut Container<'_>, document: &mut Document, warnings: &mut Warnings) -> Result<(), IoError> {
    let Some(profile) = d.get("profile").filter(|p| p.is_object()) else { return Ok(()) };
    let channels = document.pixel_format().mode.color_channels();
    let fits = |p: &craft_cms::Profile| p.channels() == channels;
    let embedded = match container.read("profile.icc", 64 << 20) {
        Ok(Some(icc)) => craft_cms::Profile::parse(&icc).ok().filter(fits).map(|_| icc),
        Ok(None) | Err(Ok(_)) => None,
        Err(Err(limit)) => return Err(limit),
    };
    let builtin = || {
        let id = profile.get("wellKnown").and_then(Value::as_str).or_else(|| profile.get("id").and_then(Value::as_str))?;
        let builtin = craft_cms::Builtin::from_id(id)?.profile();
        fits(builtin).then(|| builtin.to_bytes().to_vec())
    };
    match embedded.or_else(builtin) {
        Some(icc) => document.icc_profile = Some(Arc::new(icc)),
        None => {
            let label: String = profile.get("name").or_else(|| profile.get("id")).and_then(Value::as_str).unwrap_or("").chars().take(80).collect();
            warnings.note(&format!("the colour profile \"{label}\" is not in the file or does not fit the image mode; the document opens without a profile"));
        }
    }
    Ok(())
}

/// Pigment 0.4 treated the bottom pixel layer called "Background" as Photoshop's Background
/// (`isBackgroundLayer` in lib/layers-extras/structure.js): fixed in place, without a mask, and
/// what a knockout reveals. PhotoCraft's Background is the bottom layer with transparency and
/// position locked.
fn background(layers: &mut [photocraft_doc::Layer]) {
    if let Some(bottom) = layers.first_mut()
        && bottom.name == "Background"
        && matches!(bottom.content, photocraft_doc::LayerContent::Raster(_))
        && bottom.mask.is_none()
        && bottom.vector_mask.is_none()
        && !bottom.clipped
    {
        bottom.locks.set("transparency", true);
        bottom.locks.set("position", true);
    }
}

/// What [`ImportConversion`](photocraft_doc::import_conversion::ImportConversion) calls the
/// documents this importer reads.
pub const SOURCE_FORMAT: &str = "pigment-0.1-0.4";

/// Whether `doc` was opened from a Pigment 0.1–0.4 document (its import report says so; the
/// report stays with the document when it is saved in the new format).
pub fn came_from_legacy(doc: &Document) -> bool {
    matches!(doc.metadata.import_conversion.as_deref(), Some(ImportConversion::Report(r)) if r.source_format == SOURCE_FORMAT)
}

/// The import report of a document: each warning line, as converted another way, kept but not
/// applied, or left out.
fn report(version: u64, lines: &[String]) -> ImportConversion {
    let entries = lines
        .iter()
        .take(4096)
        .enumerate()
        .map(|(i, line)| {
            let has = |words: &[&str]| words.iter().any(|w| line.contains(w));
            let (disposition, reason) = if has(&["changes nothing"]) {
                (ConversionDisposition::RetainedUnapplied, ConversionReason::NativeLimitation)
            } else if has(&["could not", "not in the file", "is missing", "has no id", "damaged"]) {
                (ConversionDisposition::SkippedNonessential, ConversionReason::ResourceUnavailable)
            } else if has(&["left out", "was skipped", "empty layer", "opens empty", "nothing is drawn", "opens without", "not known", "no paint"]) {
                (ConversionDisposition::SkippedNonessential, ConversionReason::MissingMapping)
            } else {
                (ConversionDisposition::NativeApproximation, ConversionReason::NativeLimitation)
            };
            let line: String = line.chars().take(4096).collect();
            ConversionEntry {
                feature_code: format!("pigment.{}", i + 1),
                source: SourceItemRef { kind: "document".into(), ..Default::default() },
                targets: Vec::new(),
                disposition,
                reason,
                source_description: line.clone(),
                native_description: line,
                attachments: Vec::new(),
            }
        })
        .collect();
    ImportConversion::Report(ConversionReport {
        source_format: SOURCE_FORMAT.into(),
        source_version: u32::try_from(version).ok(),
        policy_version: 1,
        entries,
        attachments: Vec::new(),
    })
}

/// Opens a Pigment 0.1–0.4 document.
pub(crate) fn import(name: &str, bytes: &[u8], ctl: &Interrupt) -> Result<ImportResult, IoError> {
    import_at(name, bytes, ctl, 0, &mut Budget::default())
}

/// Opens a Pigment 0.1–0.4 document whose pixels may take at most `pixels` bytes (of the 2 GiB a
/// document may take): for the engine's tests of what the smart objects it draws take.
#[doc(hidden)]
pub fn import_within(name: &str, bytes: &[u8], ctl: &Interrupt, pixels: u64) -> Result<ImportResult, IoError> {
    let mut budget = Budget::default();
    budget.pixels = budget.pixels.min(pixels);
    import_at(name, bytes, ctl, 0, &mut budget)
}

/// Opens a document `depth` smart objects deep, within what is left of `budget` (a nested
/// document takes from its host's), and leaves in `budget` what it did not take.
fn import_at(name: &str, bytes: &[u8], ctl: &Interrupt, depth: usize, budget: &mut Budget) -> Result<ImportResult, IoError> {
    let mut container = Container::open(bytes, *budget)?;
    let result = read(name, &mut container, ctl, depth);
    *budget = container.budget();
    result
}

fn read(name: &str, container: &mut Container<'_>, ctl: &Interrupt, nesting: usize) -> Result<ImportResult, IoError> {
    let description = container.document()?;
    let d = description.as_object().ok_or_else(|| damaged(format!("{} does not hold a document", container::DOCUMENT)))?;
    // `readPigment` in lib/io.js: anything else "is not a Pigment document".
    if d.get("app").and_then(Value::as_str) != Some("pigment") {
        return Err(damaged(format!("{} does not say it is a Pigment document", container::DOCUMENT)));
    }
    let mut warnings = Warnings::default();
    if let Some(version) = d.get("version").and_then(Value::as_u64).filter(|v| *v > NEWEST_VERSION) {
        warnings.note(&format!("the file was saved by a newer Pigment (document format {version}); what Pigment 0.4 wrote was read, the rest was left out"));
    }
    let size = size_of(d)?;
    let meta = d.get("meta").and_then(Value::as_object);
    let image_mode = meta.and_then(|m| m.get("imageMode")).and_then(Value::as_object);
    let multichannel = image_mode.and_then(|m| m.get("multichannel")).and_then(Value::as_object);
    let Model { mode, tone, depth, color_table, duotone } = model_of(d, multichannel.is_some(), &mut warnings);

    let mut document = Document::new(name, size, mode, depth);
    if name.trim().is_empty()
        && let Some(own) = d.get("name").and_then(Value::as_str).filter(|s| !s.trim().is_empty())
    {
        document.name = own.chars().take(255).collect();
    }
    if let Some(dpi) = d.get("dpi").and_then(Value::as_f64).filter(|n| n.is_finite() && *n >= 1.0 && *n <= 1.0e6) {
        document.resolution_dpi = dpi as f32;
    }
    match mode {
        ColorMode::Indexed => {
            let transparent = image_mode.and_then(|m| m.get("transparentIndex")).and_then(Value::as_u64).and_then(|i| u8::try_from(i).ok());
            let colors = color_table.unwrap_or_default();
            document.color_table = Some(ColorTable { transparent: transparent.filter(|i| usize::from(*i) < colors.len()), colors });
        }
        ColorMode::Duotone => document.duotone = duotone,
        _ => {}
    }

    let version = d.get("version").and_then(Value::as_u64).unwrap_or(1);
    let mut reader = LayerReader {
        container: &mut *container,
        ctl,
        warnings: &mut warnings,
        fmt: document.pixel_format(),
        mask_fmt: PixelFormat::new(ColorMode::Grayscale, depth, false),
        tone,
        tags: meta.and_then(|m| m.get("layerTags")).and_then(Value::as_object),
        nodes: 0,
        links: Vec::new(),
        ids: Vec::new(),
        version,
        mode,
        canvas: (size.width, size.height),
        patterns: paint::Patterns::default(),
        dpi: document.resolution_dpi,
        depth: nesting,
        smart_sources: Vec::new(),
    };
    let mut layers = reader.layers(d.get("layers").and_then(Value::as_array).map_or(&[][..], Vec::as_slice), 1)?;
    layers::apply_links(&mut layers, &reader.links);
    document.patterns = std::mem::take(&mut reader.patterns.list);
    let smart_sources = smart::source_bounds(&reader.smart_sources);
    background(&mut layers);
    document.layers = layers;
    if document.layers.is_empty() {
        warnings.note("the document has no layers");
    }
    ctl.progress(0.8);

    // The inks of a Multichannel document: `meta.imageMode.multichannel.spots` has their colours.
    let spots = multichannel.filter(|_| d.get("mode").and_then(Value::as_str) == Some("multichannel")).and_then(|m| m.get("spots")).and_then(Value::as_object);
    channels_and_selection(d, spots, container, &mut document, &mut warnings, ctl)?;
    guides_and_origin(d, &mut document, &mut warnings);
    paths_and_light(d, &mut document);
    profile(d, container, &mut document, &mut warnings)?;

    // Type and smart objects: the app saved no pixels for them.
    let skipped = crate::text_import::prepare_within(&mut document, None, &mut container.pixel_budget, ctl).map_err(|_| IoError::Cancelled)?;
    if skipped > 0 {
        warnings.note("some type layers are too large to draw within the memory limit; they show once they are edited");
    }
    smart::render(&mut document, &smart_sources, &mut container.pixel_budget, &mut warnings, ctl)?;
    ctl.progress(0.95);

    // File Info and the camera data.
    if let Some((packet, camera)) = meta.and_then(info::xmp_packet) {
        document.metadata.xmp = Some(packet.into());
        if camera {
            warnings.note("the camera data is kept in File Info; the photograph's original EXIF block was not in the file");
        }
    }

    let warnings = warnings.finish();
    document.metadata.import_conversion = Some(Arc::new(report(version, &warnings)));
    // The document keeps its file; the interface asks before the first save writes over it.
    Ok(ImportResult { document, warnings, source_read_only: false, preview_only: false })
}
