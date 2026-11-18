//! The layer tree of a Pigment 0.1–0.4 document (`Layer.describe()` in
//! `renderer/lib/document.js`, pixels from `renderer/lib/io.js`): raster, group, adjustment,
//! fill and shape layers, with their layer masks, vector masks, layer styles and advanced
//! blending, type layers (`text.rs`) and smart objects (`smart.rs`). A layer of a kind this does
//! not know opens as an empty pixel layer in its place with its common properties, reported.

use photocraft_color::{BlendMode, ColorMode, PixelFormat, SampleType};
use photocraft_doc::advanced::{AdvancedBlending, Knockout};
use photocraft_doc::blend_if::{BlendIf, BlendRange};
use photocraft_doc::{LabelColor, Layer, LayerContent, LayerId, LayerMask};
use photocraft_geom::Rect;
use photocraft_raster::{Interrupt, Surface};
use serde_json::Value;

use super::container::{Container, MAX_ENTRY_BYTES, Rgba8};
use super::paint::{self, Patterns, Place};
use super::styles::StyleReader;
use super::{adjust, blend, damaged, text};
use crate::IoError;
use crate::ora::Warnings;

/// Layers and groups in one document, as for the other layered importers.
const MAX_NODES: usize = 8192;
/// Group nesting. `document.json` cannot nest deeper than this anyway (the JSON parser stops at
/// 128 levels, two per group).
const MAX_DEPTH: usize = 64;
/// Layer offsets are whole pixels within this distance of the origin.
const MAX_OFFSET: f64 = 16_777_216.0;

/// What the document's mode makes of the RGBA pixels the JavaScript app stored for every mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Tone {
    /// RGB, and Indexed Color (kept expanded).
    Color,
    /// Grayscale and Duotone: the Rec. 601 luma, which is the pixel itself where R = G = B.
    Gray,
    /// Bitmap: black or white at 50 %.
    Bitmap,
}

/// Straight RGBA samples as the file holds them.
#[derive(Clone, Copy)]
pub(crate) enum Samples<'a> {
    U8(&'a [u8]),
    /// Little-endian.
    U16(&'a [u8]),
    /// Little-endian.
    F32(&'a [u8]),
}

impl Samples<'_> {
    fn scale(&self) -> f64 {
        match self {
            Samples::U8(_) => 255.0,
            Samples::U16(_) => 65535.0,
            Samples::F32(_) => 1.0,
        }
    }
    /// Sample `i` in the file's own scale.
    fn get(&self, i: usize) -> f64 {
        match self {
            Samples::U8(d) => f64::from(d[i]),
            Samples::U16(d) => f64::from(u16::from_le_bytes([d[2 * i], d[2 * i + 1]])),
            Samples::F32(d) => {
                let v = f32::from_le_bytes([d[4 * i], d[4 * i + 1], d[4 * i + 2], d[4 * i + 3]]);
                if v.is_finite() { f64::from(v) } else { 0.0 }
            }
        }
    }
}

fn push(out: &mut Vec<u8>, v: f64, from: f64, to: SampleType) {
    match to {
        SampleType::U8 => out.push(if from == 255.0 { v as u8 } else { ((v / from).clamp(0.0, 1.0) * 255.0 + 0.5) as u8 }),
        SampleType::U16 => {
            let s = if from == 65535.0 { v as u16 } else { ((v / from).clamp(0.0, 1.0) * 65535.0 + 0.5) as u16 };
            out.extend_from_slice(&s.to_ne_bytes());
        }
        SampleType::F32 => out.extend_from_slice(&((v / from) as f32).to_ne_bytes()),
    }
}

/// `pixels` RGBA pixels of `src` as encoded samples of `fmt` (colour or grey, with alpha).
pub(crate) fn encode(src: Samples<'_>, pixels: usize, tone: Tone, fmt: PixelFormat) -> Vec<u8> {
    if let (Samples::U8(d), Tone::Color, SampleType::U8) = (src, tone, fmt.sample) {
        return d[..pixels * 4].to_vec();
    }
    let scale = src.scale();
    let mut out = Vec::with_capacity(pixels * fmt.bytes_per_pixel());
    for p in 0..pixels {
        let [r, g, b] = [src.get(4 * p), src.get(4 * p + 1), src.get(4 * p + 2)];
        // Colour may be brighter than white in a 32-bit document; coverage may not.
        let a = src.get(4 * p + 3).clamp(0.0, scale);
        if tone == Tone::Color {
            for v in [r, g, b] {
                push(&mut out, v, scale, fmt.sample);
            }
        } else {
            // `luma()` of shared/pixels/modes.js for 8 bits, `greyDeep()` of lib/modes.js above.
            let luma = match src {
                Samples::U8(_) => ((r * 299.0 + g * 587.0 + b * 114.0 + 500.0) / 1000.0).floor(),
                Samples::U16(_) => (r * 0.299 + g * 0.587 + b * 0.114).round(),
                Samples::F32(_) => r * 0.299 + g * 0.587 + b * 0.114,
            };
            let v = match tone {
                Tone::Bitmap if luma >= scale / 2.0 => scale,
                Tone::Bitmap => 0.0,
                _ => luma,
            };
            push(&mut out, v, scale, fmt.sample);
        }
        push(&mut out, a, scale, fmt.sample);
    }
    out
}

/// One byte per pixel (a mask, a channel, the selection) as encoded grey samples of `fmt`;
/// `invert` gives ink density from the "white is no ink" planes of a Multichannel document.
pub(crate) fn encode_gray(bytes: impl Iterator<Item = u8>, pixels: usize, fmt: PixelFormat, invert: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(pixels * fmt.bytes_per_pixel());
    for v in bytes.take(pixels) {
        push(&mut out, f64::from(if invert { 255 - v } else { v }), 255.0, fmt.sample);
    }
    out
}

/// A whole number from the description, rounded as the JavaScript app's canvases round.
fn offset(v: Option<&Value>) -> i32 {
    v.and_then(Value::as_f64).filter(|n| n.is_finite()).map_or(0, |n| n.round().clamp(-MAX_OFFSET, MAX_OFFSET) as i32)
}

fn unit(v: Option<&Value>, default: f32) -> f32 {
    v.and_then(Value::as_f64).filter(|n| n.is_finite()).map_or(default, |n| n.clamp(0.0, 1.0) as f32)
}

/// A layer id: a string in every file the app wrote; a number is read too.
pub(crate) fn id_of(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// What the layer tree needs from the document.
pub(crate) struct LayerReader<'a, 'b, 'c> {
    pub(crate) container: &'b mut Container<'a>,
    pub(crate) ctl: &'c Interrupt<'c>,
    pub(crate) warnings: &'b mut Warnings,
    /// The document's layer pixel format.
    pub(crate) fmt: PixelFormat,
    /// Masks, channels and the selection: grey at the document depth.
    pub(crate) mask_fmt: PixelFormat,
    pub(crate) tone: Tone,
    /// `meta.layerTags`: colour labels and link sets by layer id.
    pub(crate) tags: Option<&'b serde_json::Map<String, Value>>,
    /// Layers read so far.
    pub(crate) nodes: usize,
    /// The link set each linked layer names, in tree order.
    pub(crate) links: Vec<(LayerId, String)>,
    /// Each layer's id in the file and in the document, in tree order.
    pub(crate) ids: Vec<(String, LayerId)>,
    /// `document.json`'s version (1, 2 or 3): shape dashes were in pixels before 3.
    pub(crate) version: u64,
    /// The document's mode and size (fill layers cover the canvas).
    pub(crate) mode: ColorMode,
    pub(crate) canvas: (u32, u32),
    /// The patterns fills, shapes and styles bring.
    pub(crate) patterns: Patterns,
    /// The document's resolution: type sizes were pixels in the app, they are points here.
    pub(crate) dpi: f32,
    /// How deep in smart objects this document is (0: the file opened).
    pub(crate) depth: usize,
    /// Smart-object sources read so far, shared by the instances that name them.
    pub(crate) smart_sources: Vec<super::smart::Shared>,
}

impl LayerReader<'_, '_, '_> {
    /// `list` (bottom to top, as the file and the document both keep layers) as layers.
    pub(crate) fn layers(&mut self, list: &[Value], depth: usize) -> Result<Vec<Layer>, IoError> {
        if depth > MAX_DEPTH {
            return Err(damaged(format!("its layer groups are nested deeper than {MAX_DEPTH}")));
        }
        let mut out = Vec::with_capacity(list.len().min(MAX_NODES));
        for desc in list {
            self.ctl.check().map_err(|_| IoError::Cancelled)?;
            let Some(desc) = desc.as_object() else {
                self.warnings.note("an entry of the layer list is not a layer and was skipped");
                continue;
            };
            self.nodes += 1;
            if self.nodes > MAX_NODES {
                return Err(IoError::Unsupported(format!("this Pigment 0.4 document is too large to open: it has more than {MAX_NODES} layers")));
            }
            let id = id_of(desc.get("id"));
            let name =
                desc.get("name").and_then(Value::as_str).filter(|s| !s.trim().is_empty()).map_or_else(|| format!("Layer {}", self.nodes), str::to_string);
            let kind = desc.get("type").and_then(Value::as_str).unwrap_or("");
            // A type layer's stroke, which becomes a layer effect.
            let mut stroke = None;
            let mut layer = match kind {
                "raster" => self.raster(desc, id.as_deref(), &name)?,
                "group" => {
                    let children = match desc.get("children").and_then(Value::as_array) {
                        Some(children) => self.layers(children, depth + 1)?,
                        None => Vec::new(),
                    };
                    let mut group = Layer::group("", children);
                    if let LayerContent::Group(g) = &mut group.content {
                        g.expanded = desc.get("expanded").and_then(Value::as_bool).unwrap_or(true);
                    }
                    group
                }
                "adjustment" => {
                    let mut notes = Vec::new();
                    let kind = desc.get("kind").and_then(Value::as_str).unwrap_or("levels");
                    let adjustment = adjust::to_adjustment(kind, desc.get("params").unwrap_or(&Value::Null), &mut notes);
                    self.notes(&name, notes);
                    Layer::new("", LayerContent::Adjustment(adjustment))
                }
                "fill" => self.fill(desc, id.as_deref(), &name)?,
                "shape" => self.shape(desc, &name)?,
                "text" => {
                    let mut notes = Vec::new();
                    let converted = text::text_layer(desc, self.dpi, self.mode, &mut notes);
                    self.notes(&name, notes);
                    stroke = converted.stroke;
                    Layer::new("", LayerContent::Text(converted.text))
                }
                "smart" => match self.smart(desc, id.as_deref(), &name)? {
                    Some(layer) => layer,
                    None => Layer::raster("", self.fmt),
                },
                other => {
                    let what = match other {
                        "" => "the layer has no type; it opens as an empty layer".to_string(),
                        other => format!("layers of type \"{}\" are not known; the layer opens as an empty layer", other.chars().take(40).collect::<String>()),
                    };
                    self.warnings.layer(&name, &what);
                    Layer::raster("", self.fmt)
                }
            };
            layer.name = name;
            self.common(&mut layer, desc, id.as_deref())?;
            if let Some(stroke) = stroke {
                // Drawn with the glyphs, under the layer's own styles.
                layer.effects.items.insert(0, stroke);
                if layer.effects.items.len() > 1 {
                    self.warnings.layer(
                        &layer.name,
                        "the type's stroke and its layer styles are drawn together as layer effects, which can differ a little from Pigment 0.4",
                    );
                }
            }
            if let Some(id) = id {
                self.ids.push((id, layer.id));
            }
            out.push(layer);
        }
        Ok(out)
    }

    /// The properties every layer kind has.
    fn common(&mut self, layer: &mut Layer, desc: &serde_json::Map<String, Value>, id: Option<&str>) -> Result<(), IoError> {
        layer.visible = desc.get("visible").and_then(Value::as_bool).unwrap_or(true);
        layer.opacity = unit(desc.get("opacity"), 1.0);
        layer.fill_opacity = unit(desc.get("fillOpacity"), 1.0);
        layer.clipped = desc.get("clip").and_then(Value::as_bool).unwrap_or(false);
        let group = layer.is_group();
        layer.blend = match desc.get("blend").and_then(Value::as_str) {
            None => layer.blend,
            // Only groups pass through.
            Some("pass-through") if !group => BlendMode::Normal,
            Some(name) => blend::blend_mode(name).unwrap_or_else(|| {
                let shown: String = name.chars().take(40).collect();
                self.warnings.layer(&layer.name, &format!("the blend mode \"{shown}\" is not known; the layer blends as Normal"));
                BlendMode::Normal
            }),
        };
        if let Some(locked) = desc.get("locked").and_then(Value::as_object) {
            // Lock Image Pixels includes Lock Transparent Pixels (`Locks::set`), so pixels go first.
            for key in ["pixels", "transparency", "position", "all"] {
                layer.locks.set(key, locked.get(key).and_then(Value::as_bool).unwrap_or(false));
            }
        }
        if desc.get("hasMask").and_then(Value::as_bool).unwrap_or(false) {
            layer.mask = self.mask(desc, id, &layer.name)?;
        }
        if let Some(tag) = id.and_then(|id| self.tags?.get(id)) {
            // `LABEL_COLORS` of lib/layers-extras/tags.js: red, orange, yellow, green, blue, violet, gray.
            if let Some(color) = tag.get("color").and_then(Value::as_str).and_then(LabelColor::from_id) {
                layer.label = color;
            }
            if let Some(set) = tag.get("linked").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                self.links.push((layer.id, set.to_string()));
            }
        }
        let mut notes = Vec::new();
        if let Some(vm) = desc.get("vectorMask").and_then(Value::as_object) {
            layer.vector_mask = Some(paint::vector_mask(vm, &mut notes));
        }
        if let Some(styles) = desc.get("styles").and_then(Value::as_object).filter(|m| !m.is_empty()) {
            let mut reader = StyleReader { patterns: &mut self.patterns, notes: Vec::new() };
            layer.effects = reader.effects(styles);
            // Effect colours are in the document's mode.
            layer.effects.items = std::mem::take(&mut layer.effects.items).into_iter().map(|e| e.in_mode(self.mode)).collect();
            // The app tiled linked patterns from the layer's pixels' top-left.
            if matches!(layer.content, LayerContent::Raster(_)) {
                layer.effects.reference = Some((f64::from(offset(desc.get("x"))), f64::from(offset(desc.get("y")))));
            }
            notes.append(&mut reader.notes);
        }
        if let Some(b) = desc.get("blending").and_then(Value::as_object) {
            self.blending(layer, b, &mut notes);
        }
        let name = layer.name.clone();
        self.notes(&name, notes);
        Ok(())
    }

    fn notes(&mut self, layer: &str, notes: Vec<String>) {
        for n in notes {
            self.warnings.layer(layer, &n);
        }
    }

    /// `blending` (`DEFAULT_BLENDING` of lib/document.js): channels, knockout, the advanced
    /// options and Blend If (`[black low, black high, white low, white high]` in 0..255 per
    /// channel, this layer and the one beneath).
    fn blending(&mut self, layer: &mut Layer, b: &serde_json::Map<String, Value>, notes: &mut Vec<String>) {
        let rgb = self.mode == ColorMode::Rgb;
        if let Some(ch) = b.get("channels").and_then(Value::as_object) {
            let off: Vec<usize> =
                ["r", "g", "b"].iter().enumerate().filter(|(_, k)| ch.get(**k).and_then(Value::as_bool) == Some(false)).map(|(i, _)| i).collect();
            if rgb {
                layer.excluded_channels = off.iter().fold(0, |bits, i| bits | (1 << i));
            } else if !off.is_empty() {
                notes.push("the channels left out of blending were red, green or blue, which this image mode does not have; every channel blends".into());
            }
        }
        let flag = |k: &str, d: bool| b.get(k).and_then(Value::as_bool).unwrap_or(d);
        layer.advanced = AdvancedBlending {
            knockout: b.get("knockout").and_then(Value::as_str).and_then(Knockout::from_name).unwrap_or(Knockout::None),
            blend_interior: flag("interiorAsGroup", false),
            blend_clipped: flag("clippedAsGroup", true),
            transparency_shapes: flag("transparencyShapes", true),
            layer_mask_hides_effects: flag("maskHidesEffects", false),
            vector_mask_hides_effects: flag("vectorMaskHidesEffects", false),
        };
        if let Some(bi) = b.get("blendIf").and_then(Value::as_object) {
            let range = |v: Option<&Value>| -> BlendRange {
                match v.and_then(Value::as_array) {
                    Some(a) if a.len() == 4 && a.iter().all(|v| v.as_f64().is_some_and(f64::is_finite)) => {
                        let mut r = [0, 1, 2, 3].map(|i| a[i].as_f64().unwrap_or(0.0).round().clamp(0.0, 255.0) as u8);
                        // Each half of a split point stays on its side.
                        r[1] = r[1].max(r[0]);
                        r[3] = r[3].max(r[2]);
                        BlendRange::from_bytes(r)
                    }
                    _ => BlendRange::FULL,
                }
            };
            let mut out = BlendIf::default();
            let keys: &[&str] = if rgb { &["gray", "r", "g", "b"] } else { &["gray"] };
            for (i, key) in keys.iter().enumerate() {
                let c = bi.get(*key).and_then(Value::as_object);
                out.set(i, [range(c.and_then(|c| c.get("this"))), range(c.and_then(|c| c.get("under")))]);
            }
            if !rgb
                && ["r", "g", "b"].iter().any(|k| bi.get(*k).is_some_and(|c| [c.get("this"), c.get("under")].into_iter().any(|r| range(r) != BlendRange::FULL)))
            {
                notes.push("Blend If on red, green or blue was left out: this image mode does not have them".into());
            }
            layer.blend_if = out;
        }
    }

    /// A shape layer, drawn once into its cache as the other importers do. A pattern-filled
    /// shape is a pattern fill layer seen through its path, as PhotoCraft (and Photoshop) keep it.
    fn shape(&mut self, desc: &serde_json::Map<String, Value>, name: &str) -> Result<Layer, IoError> {
        let mut notes = Vec::new();
        let mut shape = paint::shape(desc, self.version, &mut self.patterns, &mut notes);
        shape.fill = shape.fill.map(|f| f.in_mode(self.mode));
        if let Some(stroke) = &mut shape.stroke {
            stroke.paint = stroke.paint.clone().in_mode(self.mode);
        }
        let has_vector_mask = desc.get("vectorMask").is_some_and(Value::is_object);
        if let Some(fill @ photocraft_doc::Fill::Pattern { .. }) = &shape.fill
            && !has_vector_mask
        {
            if shape.stroke.is_some() {
                notes.push("the stroke of a pattern-filled shape was left out: the shape opens as a pattern fill layer with a vector mask".into());
            }
            self.notes(name, notes);
            let mut layer = Layer::new("", LayerContent::Fill(fill.clone()));
            layer.vector_mask = Some(photocraft_doc::vector::VectorMask::new(std::mem::take(&mut shape.path)));
            return Ok(layer);
        }
        self.notes(name, notes);
        let canvas = Rect::new(0, 0, self.canvas.0 as i32, self.canvas.1 as i32);
        let compiled = photocraft_vector::CompiledShape::new(&shape, photocraft_vector::DEFAULT_TOLERANCE, canvas);
        if let Some(bounds) = compiled.bounds().map(|b| b.intersect(&canvas)).filter(|b| !b.is_empty()) {
            let cost = photocraft_raster::tile_storage_bytes(bounds, &self.fmt);
            if cost > self.container.pixel_budget {
                return Err(IoError::Unsupported(
                    "this Pigment 0.4 document is too large to open: its layers need more pixel memory than the 2 GiB limit".into(),
                ));
            }
            self.container.pixel_budget -= cost;
            self.ctl.check().map_err(|_| IoError::Cancelled)?;
            shape.cache = Some(compiled.render(self.fmt, bounds));
        }
        Ok(Layer::new("", LayerContent::Shape(shape)))
    }

    /// A fill layer (`paint`): it covers the canvas; a pattern's tile is `patterns/<id>.png`.
    fn fill(&mut self, desc: &serde_json::Map<String, Value>, id: Option<&str>, name: &str) -> Result<Layer, IoError> {
        let (w, h) = (f64::from(self.canvas.0), f64::from(self.canvas.1));
        // The app laid a fill layer's gradient out over the document, whatever its masks show.
        let place = Place { bx: (0.0, 0.0, w, h), frame: (0.0, 0.0, w, h), align: false };
        let mut notes = Vec::new();
        let mut tile_error = None;
        let mut tile = |p: &serde_json::Map<String, Value>| -> Result<(String, String), String> {
            let id = id.ok_or("cannot be found (the layer has no id)")?;
            match self.container.png(&format!("patterns/{id}.png")) {
                Ok(Ok(png)) => self.patterns.add(png, p.get("name").and_then(Value::as_str)),
                Ok(Err(why)) => Err(why),
                Err(e) => {
                    tile_error = Some(e);
                    Err("could not be read".into())
                }
            }
        };
        let fill = paint::fill_of(desc.get("paint").unwrap_or(&Value::Null), &place, &mut tile, &mut notes);
        if let Some(e) = tile_error {
            return Err(e);
        }
        self.notes(name, notes);
        Ok(match fill {
            // A fill layer's colours are in the document's mode.
            Some(fill) => Layer::new("", LayerContent::Fill(fill.in_mode(self.mode))),
            None => {
                self.warnings.layer(name, "the fill layer has no paint Pigment can draw; it opens as an empty layer");
                Layer::raster("", self.fmt)
            }
        })
    }

    /// A raster layer: `layers/<id>.png`, or its 16/32-bit samples next to it in a deep document.
    fn raster(&mut self, desc: &serde_json::Map<String, Value>, id: Option<&str>, name: &str) -> Result<Layer, IoError> {
        let mut layer = Layer::raster("", self.fmt);
        let Some(id) = id else {
            self.warnings.layer(name, "the layer has no id, so its image cannot be found; the layer opens empty");
            return Ok(layer);
        };
        let (x, y) = (offset(desc.get("x")), offset(desc.get("y")));
        let side = |key: &str| desc.get(key).and_then(Value::as_u64).filter(|n| (1..=u64::from(super::container::MAX_SIDE)).contains(n));
        let deep = match desc.get("deep").and_then(Value::as_str) {
            Some(kind @ ("u16" | "f32")) if self.fmt.sample != SampleType::U8 => {
                Some((format!("layers/{id}.{kind}"), if kind == "u16" { 2u64 } else { 4u64 }, kind == "u16"))
            }
            _ => None,
        };
        let rect = |w: u64, h: u64| Rect::new(x, y, x + w as i32, y + h as i32);
        // The deep samples have the size the description gives, when both are right: no PNG is decoded then.
        if let (Some((entry, bytes, u16s)), Some(w), Some(h)) = (&deep, side("width"), side("height"))
            && self.container.declared_size(entry) == Some(w * h * 4 * bytes)
            && w * h * 4 * bytes <= MAX_ENTRY_BYTES
            && self.container.price(rect(w, h), &self.fmt).map(|()| true)?
            && let Ok(Some(data)) = self.container.read(entry, MAX_ENTRY_BYTES).or_else(|e| e.map(|_| None))
            && data.len() as u64 == w * h * 4 * bytes
        {
            let samples = if *u16s { Samples::U16(&data) } else { Samples::F32(&data) };
            self.place(&mut layer, x, y, w as u32, h as u32, samples)?;
            return Ok(layer);
        }
        let image = format!("layers/{id}.png");
        let fmt = self.fmt;
        self.container.price_png(&image, |w, h| photocraft_raster::tile_storage_bytes(rect(w.into(), h.into()), &fmt))?;
        let png = match self.container.png(&image)? {
            Ok(png) => png,
            Err(why) => {
                self.warnings.layer(name, &format!("the layer's image {why}; the layer opens empty"));
                return Ok(layer);
            }
        };
        let Rgba8 { width, height, data } = png;
        let pixels = u64::from(width) * u64::from(height);
        if let Some((entry, bytes, u16s)) = &deep
            && self.container.declared_size(entry) == Some(pixels * 4 * bytes)
            && pixels * 4 * bytes <= MAX_ENTRY_BYTES
            && let Ok(Some(deep_data)) = self.container.read(entry, MAX_ENTRY_BYTES).or_else(|e| e.map(|_| None))
            && deep_data.len() as u64 == pixels * 4 * bytes
        {
            drop(data);
            let samples = if *u16s { Samples::U16(&deep_data) } else { Samples::F32(&deep_data) };
            self.place(&mut layer, x, y, width, height, samples)?;
            return Ok(layer);
        }
        if self.fmt.sample != SampleType::U8 {
            let bits = if self.fmt.sample == SampleType::U16 { 16 } else { 32 };
            self.warnings.layer(name, &format!("the layer's {bits}-bit pixels are not in the file; its 8-bit pixels were used"));
        }
        self.place(&mut layer, x, y, width, height, Samples::U8(&data))?;
        Ok(layer)
    }

    fn place(&mut self, layer: &mut Layer, x: i32, y: i32, width: u32, height: u32, samples: Samples<'_>) -> Result<(), IoError> {
        let rect = Rect::new(x, y, x + width as i32, y + height as i32);
        // Converted to a deeper document, the pixels take more than the image: asked first.
        self.container.price(rect, &self.fmt)?;
        let bytes = encode(samples, width as usize * height as usize, self.tone, self.fmt);
        if let LayerContent::Raster(surface) = &mut layer.content {
            self.container.write(surface, rect, &bytes)?;
        }
        Ok(())
    }

    /// `masks/<id>.png`: the alpha channel is the mask (the app's masks are white with the mask
    /// in their alpha, which its compositor masks with). The app kept masks document-sized at
    /// the origin; outside the image the mask reveals.
    fn mask(&mut self, desc: &serde_json::Map<String, Value>, id: Option<&str>, name: &str) -> Result<Option<LayerMask>, IoError> {
        let Some(id) = id else { return Ok(None) };
        let image = format!("masks/{id}.png");
        let fmt = self.mask_fmt;
        self.container.price_png(&image, |w, h| photocraft_raster::tile_storage_bytes(Rect::new(0, 0, w as i32, h as i32), &fmt))?;
        let png = match self.container.png(&image)? {
            Ok(png) => png,
            Err(why) => {
                self.warnings.layer(name, &format!("the layer mask's image {why}; the layer opens without its mask"));
                return Ok(None);
            }
        };
        let pixels = png.width as usize * png.height as usize;
        self.container.price(Rect::new(0, 0, png.width as i32, png.height as i32), &self.mask_fmt)?;
        let bytes = encode_gray(png.data.iter().skip(3).step_by(4).copied(), pixels, self.mask_fmt, false);
        let mut surface = Surface::with_default(self.mask_fmt, &[1.0]);
        self.container.write(&mut surface, Rect::new(0, 0, png.width as i32, png.height as i32), &bytes)?;
        let feather = desc.get("maskFeather").and_then(Value::as_f64).filter(|n| n.is_finite()).map_or(0.0, |n| n.clamp(0.0, 1000.0) as f32);
        Ok(Some(LayerMask {
            surface,
            enabled: desc.get("maskEnabled").and_then(Value::as_bool).unwrap_or(true),
            linked: desc.get("maskLinked").and_then(Value::as_bool).unwrap_or(true),
            density: unit(desc.get("maskDensity"), 1.0),
            feather,
        }))
    }
}

/// Runs `f` on every layer of the tree.
pub(crate) fn for_each_layer_mut(layers: &mut [Layer], f: &mut impl FnMut(&mut Layer)) {
    for layer in layers {
        f(layer);
        if let Some(children) = layer.children_mut() {
            for_each_layer_mut(children, f);
        }
    }
}

/// Gives the layers of each link set with at least two members one link group. A set with one
/// member links nothing, as in the app (`dropLoneLinks` in lib/layers-extras/tags.js).
pub(crate) fn apply_links(layers: &mut [Layer], links: &[(LayerId, String)]) {
    let mut sets: Vec<(&str, usize)> = Vec::new();
    for (_, set) in links {
        match sets.iter_mut().find(|(s, _)| s == set) {
            Some((_, n)) => *n += 1,
            None => sets.push((set, 1)),
        }
    }
    sets.retain(|(_, n)| *n >= 2);
    if sets.is_empty() {
        return;
    }
    for_each_layer_mut(layers, &mut |layer| {
        if let Some((_, set)) = links.iter().find(|(id, _)| *id == layer.id) {
            layer.link_group = sets.iter().position(|(s, _)| s == set).map(|i| i as u64 + 1);
        }
    });
}
