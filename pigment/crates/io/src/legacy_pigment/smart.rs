//! Smart objects of Pigment 0.1–0.4 (`SmartLayer` in `renderer/lib/smart-object.js`): a source
//! that is a nested document (`smart/<id>.pigment`, written by the same `writePigment`) or an
//! image (`smart/<id>.png`), a matrix from the source's pixels to the document's, and smart
//! filters. Instances made by Duplicate Layer share one source: the file holds it once, under the
//! first instance's id, and the others name it in `sourceRef`.
//!
//! A nested document is opened by this importer (at most [`MAX_SMART_DEPTH`] deep, within the
//! host's budget) and kept in the smart object as a PhotoCraft document (`.pcraft`), the source
//! Convert to Smart Object makes; an image source keeps its PNG. Instances sharing a source share
//! one `SmartContentsId`, so editing the contents of one updates them all, as in the app.
//!
//! The app saved no pixels for a smart object: its appearance is drawn here when the document
//! has been read ([`render`]).

use std::sync::{Arc, OnceLock};

use photocraft_color::PixelFormat;
use photocraft_doc::{Document, Layer, LayerContent, SmartContentsId, SmartObject, SmartSource, StackMode};
use photocraft_geom::{Affine, Rect};
use photocraft_raster::{Cancelled, Interrupt, Surface};
use serde_json::{Map, Value};

use super::container::{MAX_ENTRY_BYTES, MAX_SIDE, Rgba8, png_size};
use super::layers::{LayerReader, Samples, Tone, encode};
use super::{filters, import_at, text};
use crate::IoError;

/// Smart objects nested in smart objects: the app had no limit, a file that nests deeper than
/// this is not a document anyone made.
pub(crate) const MAX_SMART_DEPTH: usize = 8;

/// A source read once and shared by every instance that names it.
pub(crate) struct Shared {
    /// The id the file keeps it under (`smart/<id>.…`).
    key: String,
    contents: SmartContentsId,
    source: SmartSource,
    /// The source's pixels at its own size (a nested document's canvas, an image's size from its
    /// header), for pricing a placement before it is drawn; `None` when it cannot be told.
    bounds: Option<Rect>,
}

/// The size of each source, by the contents its instances share.
pub(crate) fn source_bounds(shared: &[Shared]) -> Vec<(SmartContentsId, Rect)> {
    shared.iter().filter_map(|s| Some((s.contents, s.bounds?))).collect()
}

/// Draws a smart object's appearance from its source and smart filters, as the engine draws it;
/// `Ok(false)` when it cannot, and `Err` when the import is cancelled meanwhile (it stops as soon
/// as the interrupt says so). The engine installs it ([`set_renderer`]): this crate has no
/// filters of its own.
pub type Renderer = fn(&Document, &mut Layer, &Interrupt) -> Result<bool, Cancelled>;

static RENDERER: OnceLock<Renderer> = OnceLock::new();

/// Installs the engine's smart-object renderer. The first one installed stays.
pub fn set_renderer(render: Renderer) {
    let _ = RENDERER.set(render);
}

fn file_name(name: Option<&str>, fallback: &str, ext: &str) -> String {
    let base: String = name.map(str::trim).filter(|n| !n.is_empty()).unwrap_or(fallback).chars().filter(|c| !matches!(c, '/' | '\\')).take(120).collect();
    if base.to_ascii_lowercase().ends_with(&format!(".{ext}")) { base } else { format!("{base}.{ext}") }
}

impl LayerReader<'_, '_, '_> {
    /// A smart-object layer; `None` when its source is not in the file or nests too deep (the
    /// caller then opens an empty layer in its place, reported).
    pub(crate) fn smart(&mut self, desc: &Map<String, Value>, id: Option<&str>, name: &str) -> Result<Option<Layer>, IoError> {
        let key = desc.get("sourceRef").and_then(Value::as_str).filter(|s| !s.is_empty()).or(id).map(str::to_string);
        let Some(key) = key else {
            self.warnings.layer(name, "the smart object has no id, so its contents cannot be found; it opens as an empty layer");
            return Ok(None);
        };
        let shared = match self.smart_sources.iter().position(|s| s.key == key) {
            Some(i) => i,
            None => match self.read_source(&key, desc, name)? {
                Some((source, bounds)) => {
                    self.smart_sources.push(Shared { key: key.clone(), contents: SmartContentsId::fresh(), source, bounds });
                    self.smart_sources.len() - 1
                }
                None => return Ok(None),
            },
        };
        let Shared { contents, source, .. } = &self.smart_sources[shared];
        let transform = text::matrix(desc.get("transform")).unwrap_or(Affine::IDENTITY);
        let mut sm = SmartObject::new(source.clone(), transform, None);
        sm.contents_id = *contents;
        let mut notes = Vec::new();
        if let Some(list) = desc.get("filters").and_then(Value::as_array) {
            sm.smart_filters = filters::smart_filters(list, &mut notes);
        }
        sm.filters_enabled = desc.get("filtersEnabled").and_then(Value::as_bool).unwrap_or(true);
        sm.stack_mode = desc.get("stackMode").and_then(Value::as_str).and_then(|m| match m {
            "standard-deviation" => Some(StackMode::StandardDeviation),
            other => StackMode::from_id(other),
        });
        for n in notes {
            self.warnings.layer(name, &n);
        }
        Ok(Some(Layer::new("", LayerContent::Smart(sm))))
    }

    /// The source the file keeps under `key`, a nested document or an image, and its size.
    fn read_source(&mut self, key: &str, desc: &Map<String, Value>, name: &str) -> Result<Option<(SmartSource, Option<Rect>)>, IoError> {
        let source_name = desc.get("source").and_then(|s| s.get("name")).and_then(Value::as_str);
        let nested = format!("smart/{key}.pigment");
        if self.container.contains(&nested) {
            if self.depth >= MAX_SMART_DEPTH {
                self.warnings.layer(name, &format!("smart objects nest more than {MAX_SMART_DEPTH} deep here; this one opens as an empty layer"));
                return Ok(None);
            }
            let bytes = match self.container.read(&nested, MAX_ENTRY_BYTES) {
                Ok(Some(bytes)) => bytes,
                Ok(None) | Err(Ok(_)) => {
                    self.warnings.layer(name, "the smart object's contents could not be read; it opens as an empty layer");
                    return Ok(None);
                }
                Err(Err(limit)) => return Err(limit),
            };
            let file = file_name(source_name, name, "pigment");
            let mut budget = self.container.budget();
            let opened = import_at(&file, &bytes, self.ctl, self.depth + 1, &mut budget);
            self.container.spent_nested(budget);
            let r = match opened {
                Ok(r) => r,
                // A limit of the whole document stays one.
                Err(e @ (IoError::Unsupported(_) | IoError::Cancelled | IoError::OutOfMemory(_))) => return Err(e),
                Err(e) => {
                    self.warnings.layer(name, &format!("the smart object's contents could not be read ({e}); it opens as an empty layer"));
                    return Ok(None);
                }
            };
            for w in r.warnings.iter().take(64) {
                self.warnings.layer(name, &format!("in the smart object's contents: {w}"));
            }
            let bytes = match photocraft_format::save_to_bytes(&r.document, &Default::default()) {
                Ok(bytes) => bytes,
                Err(e) => {
                    self.warnings.layer(name, &format!("the smart object's contents could not be kept ({e}); it opens as an empty layer"));
                    return Ok(None);
                }
            };
            let source =
                SmartSource::Embedded { file_name: file_name(source_name, name, "pcraft").replace(".pigment.pcraft", ".pcraft"), bytes: Arc::new(bytes) };
            return Ok(Some((source, Some(r.document.bounds()))));
        }
        let image = format!("smart/{key}.png");
        match self.container.read(&image, MAX_ENTRY_BYTES) {
            Ok(Some(bytes)) => {
                let bounds = png_size(&bytes).map(|(w, h)| Rect::new(0, 0, w.min(MAX_SIDE) as i32, h.min(MAX_SIDE) as i32));
                Ok(Some((SmartSource::Embedded { file_name: file_name(source_name, name, "png"), bytes: Arc::new(bytes) }, bounds)))
            }
            Ok(None) => {
                self.warnings.layer(name, "the smart object's contents are not in the file; it opens as an empty layer");
                Ok(None)
            }
            Err(Ok(_)) => {
                self.warnings.layer(name, "the smart object's contents could not be read; it opens as an empty layer");
                Ok(None)
            }
            Err(Err(limit)) => Err(limit),
        }
    }
}

/// The source's pixels in `fmt`, at the source's own size: a `.pcraft` composited, a PNG decoded.
fn source_pixels(source: &SmartSource, fmt: PixelFormat, budget: u64) -> Option<(Surface, Rect)> {
    let SmartSource::Embedded { bytes, .. } = source else { return None };
    if photocraft_format::is_pcraft(bytes) {
        let doc = photocraft_format::load_from_bytes(bytes).ok()?;
        let bounds = doc.bounds();
        if photocraft_raster::tile_storage_bytes(bounds, &fmt) > budget {
            return None;
        }
        return Some((photocraft_compose::flatten_to_surface(&doc, fmt, None), bounds));
    }
    let Rgba8 { width, height, data } = super::container::decode_png(bytes, budget).ok()?;
    let rect = Rect::new(0, 0, width as i32, height as i32);
    let tone = if fmt.mode.color_channels() == 1 { Tone::Gray } else { Tone::Color };
    let mut surface = Surface::new(fmt);
    surface.try_write_interleaved(rect, &encode(Samples::U8(&data), width as usize * height as usize, tone, fmt)).ok()?;
    Some((surface, rect))
}

/// What placing `rect` of a source by `transform` takes in `fmt` (with alpha): the tiles of the
/// placed stage, which is not clipped to the canvas, wherever it lands. `None`: it cannot be
/// priced.
fn placement_cost(rect: Rect, transform: &Affine, fmt: PixelFormat) -> Option<u64> {
    let [a, b, c, d, e, f] = transform.m;
    let h = photocraft_algo::transform::Homography([a, c, e, b, d, f, 0.0, 0.0, 1.0]);
    let (w, ht) = photocraft_algo::transform::warp_output_size(rect, &h)?;
    let tile = photocraft_geom::TILE_SIZE as u64;
    let tiles = w.div_ceil(tile).saturating_add(1).saturating_mul(ht.div_ceil(tile).saturating_add(1));
    Some(photocraft_raster::stored_tiles_bytes(tiles, &PixelFormat::new(fmt.mode, fmt.sample, true)))
}

/// Draws the appearance of every smart object of `document`: through the engine's renderer
/// when one is installed (smart filters included), else the source placed by its matrix, without
/// its filters, which is reported. Each placement is priced against what is left of `budget`
/// before it is drawn, from its source's size in `sources`, and charged once drawn: a large
/// placement fills memory (and takes minutes) before anything could fail, and instances of one
/// source each keep their own. One that does not fit stays undrawn, reported. `ctl` is asked
/// before each smart object, and the engine's renderer asks it while it draws.
pub(crate) fn render(
    document: &mut Document,
    sources: &[(SmartContentsId, Rect)],
    budget: &mut u64,
    warnings: &mut crate::ora::Warnings,
    ctl: &Interrupt,
) -> Result<(), IoError> {
    let ids = smart_layers(&document.layers);
    if ids.is_empty() {
        return Ok(());
    }
    let snapshot = document.clone();
    let fmt = document.pixel_format();
    for id in ids {
        ctl.check().map_err(|_| IoError::Cancelled)?;
        let Some(layer) = document.layer_mut(id) else { continue };
        let LayerContent::Smart(sm) = &layer.content else { continue };
        let cost = sources.iter().find(|(c, _)| *c == sm.contents_id).and_then(|(_, rect)| placement_cost(*rect, &sm.transform, fmt));
        let Some(cost) = cost.filter(|cost| *cost <= *budget) else {
            let name = layer.name.clone();
            warnings.layer(&name, "the smart object's contents could not be drawn; they show once the smart object is edited");
            continue;
        };
        if let Some(render) = RENDERER.get()
            && render(&snapshot, layer, ctl).map_err(|_| IoError::Cancelled)?
        {
            *budget = budget.saturating_sub(cost);
            continue;
        }
        let LayerContent::Smart(sm) = &mut layer.content else { continue };
        let unfiltered = sm.filters_enabled && !sm.smart_filters.is_empty();
        let placed =
            source_pixels(&sm.source, fmt, *budget).and_then(|(pixels, rect)| photocraft_algo::warp::place_source(&pixels, rect, &sm.transform, None).ok());
        match placed {
            Some(surface) => {
                *budget = budget.saturating_sub(cost);
                sm.cache = Some(surface);
                if unfiltered {
                    warnings.layer(&layer.name, "the smart filters could not be drawn; the smart object shows without them until it is edited");
                }
            }
            None => {
                let name = layer.name.clone();
                warnings.layer(&name, "the smart object's contents could not be drawn; they show once the smart object is edited");
            }
        }
    }
    Ok(())
}

fn smart_layers(layers: &[Layer]) -> Vec<photocraft_doc::LayerId> {
    let mut out = Vec::new();
    for l in layers {
        if matches!(l.content, LayerContent::Smart(_)) {
            out.push(l.id);
        }
        if let Some(children) = l.children() {
            out.extend(smart_layers(children));
        }
    }
    out
}
