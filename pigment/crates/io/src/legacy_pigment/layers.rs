//! The layer tree of a Pigment 0.1–0.4 document (`Layer.describe()` in
//! `renderer/lib/document.js`, pixels from `renderer/lib/io.js`): raster layers, groups and layer
//! masks. The other layer kinds (adjustment, fill, shape, text, smart object) and the layer
//! styles, vector masks and advanced blending are not converted here yet: such a layer opens as
//! an empty pixel layer in its place with its common properties, and the report says so.

use photocraft_color::{BlendMode, PixelFormat, SampleType};
use photocraft_doc::{LabelColor, Layer, LayerContent, LayerId, LayerMask};
use photocraft_geom::Rect;
use photocraft_raster::{Interrupt, Surface};
use serde_json::Value;

use super::container::{Container, MAX_ENTRY_BYTES, Rgba8};
use super::{blend, damaged};
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
        let [r, g, b, a] = [src.get(4 * p), src.get(4 * p + 1), src.get(4 * p + 2), src.get(4 * p + 3)];
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
                other => {
                    let what = match other {
                        "adjustment" => "adjustment layers are not converted yet; the layer opens as an empty layer".to_string(),
                        "fill" => "fill layers are not converted yet; the layer opens as an empty layer".to_string(),
                        "shape" => "shape layers are not converted yet; the layer opens as an empty layer".to_string(),
                        "text" => "text layers are not converted yet; the layer opens as an empty layer".to_string(),
                        "smart" => "smart objects are not converted yet; the layer opens as an empty layer".to_string(),
                        "" => "the layer has no type; it opens as an empty layer".to_string(),
                        other => format!("layers of type \"{}\" are not known; the layer opens as an empty layer", other.chars().take(40).collect::<String>()),
                    };
                    self.warnings.layer(&name, &what);
                    Layer::raster("", self.fmt)
                }
            };
            layer.name = name;
            self.common(&mut layer, desc, id.as_deref())?;
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
        // What the next parts of the importer convert.
        if desc.get("vectorMask").is_some_and(|v| !v.is_null()) {
            self.warnings.layer(&layer.name, "the vector mask is not converted yet and was left out");
        }
        if desc.get("styles").is_some_and(|v| v.as_object().is_some_and(|m| !m.is_empty())) {
            self.warnings.layer(&layer.name, "the layer styles are not converted yet and were left out");
        }
        if desc.get("blending").is_some_and(|v| !v.is_null()) {
            self.warnings.layer(&layer.name, "the advanced blending options are not converted yet; the defaults are used");
        }
        Ok(())
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
        // The deep samples have the size the description gives, when both are right: no PNG is decoded then.
        if let (Some((entry, bytes, u16s)), Some(w), Some(h)) = (&deep, side("width"), side("height"))
            && self.container.declared_size(entry) == Some(w * h * 4 * bytes)
            && w * h * 4 * bytes <= MAX_ENTRY_BYTES
            && let Ok(Some(data)) = self.container.read(entry, MAX_ENTRY_BYTES).or_else(|e| e.map(|_| None))
            && data.len() as u64 == w * h * 4 * bytes
        {
            let samples = if *u16s { Samples::U16(&data) } else { Samples::F32(&data) };
            self.place(&mut layer, x, y, w as u32, h as u32, samples)?;
            return Ok(layer);
        }
        let png = match self.container.png(&format!("layers/{id}.png"))? {
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
        let bytes = encode(samples, width as usize * height as usize, self.tone, self.fmt);
        let rect = Rect::new(x, y, x + width as i32, y + height as i32);
        if let LayerContent::Raster(surface) = &mut layer.content {
            self.container.write(surface, rect, &bytes)?;
        }
        Ok(())
    }

    /// `masks/<id>.png`: the red channel is the mask. The app kept masks document-sized at the
    /// origin; outside the image the mask reveals.
    fn mask(&mut self, desc: &serde_json::Map<String, Value>, id: Option<&str>, name: &str) -> Result<Option<LayerMask>, IoError> {
        let Some(id) = id else { return Ok(None) };
        let png = match self.container.png(&format!("masks/{id}.png"))? {
            Ok(png) => png,
            Err(why) => {
                self.warnings.layer(name, &format!("the layer mask's image {why}; the layer opens without its mask"));
                return Ok(None);
            }
        };
        let pixels = png.width as usize * png.height as usize;
        let bytes = encode_gray(png.data.iter().step_by(4).copied(), pixels, self.mask_fmt, false);
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
