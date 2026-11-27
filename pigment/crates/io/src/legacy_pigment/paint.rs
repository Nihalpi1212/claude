//! Fill layers, shape layers and vector masks of Pigment 0.1–0.4, and the patterns they and the
//! layer styles use.
//!
//! Paints (`renderer/lib/paint.js`, `gradient-paint.js`, `pattern-paint.js`): a solid colour, a
//! gradient placed by document-space `from` / `to` points (fill layers, 0.3's gradients) or by an
//! angle, scale and offset against a box (0.4's shape paints), or a pattern tile. A gradient's
//! geometry is turned into PhotoCraft's angle, scale and offset over the same frame, so it
//! lands where it was: the canvas for fill layers (Align with Layer off: the app measured them
//! against the document whatever their masks showed), the path's bounds for shapes.
//!
//! Paths of shapes and vector masks (`renderer/lib/path-ops.js`, `mask-render.js`): without
//! operations the app filled the whole path at once (non-zero), so an inner subpath wound the
//! other way cuts a hole; PhotoCraft fills such subpaths together when they are one component
//! ([`PathOp::Join`]). With operations each subpath was composited in turn onto an empty start
//! (or, for a vector mask added with Reveal All, a full one), which PhotoCraft's convention (the
//! first subpath combines, `inverted` turns the result over) expresses as the PSD importer does.

use photocraft_color::{Color, PixelFormat, SampleType};
use photocraft_doc::vector::{LineCap, LineJoin, LiveShape, Path, PathOp, ShapeLayer, ShapeStroke, StrokeAlign, VectorMask};
use photocraft_doc::{Fill, GradientStyle, Pattern};
use photocraft_geom::Rect;
use photocraft_raster::Surface;
use serde_json::{Map, Value};

use super::container::{self, Rgba8};
use super::gradient::{self, Def};
use super::path::to_path;

/// Patterns one document may bring (fills, shapes and effects together).
const MAX_PATTERNS: usize = 256;
/// Largest data URL decoded (a pattern tile as a base64 PNG).
const MAX_DATA_URL: usize = 64 << 20;

/// The patterns the document's layers use, added to [`photocraft_doc::Document::patterns`].
#[derive(Default)]
pub(crate) struct Patterns {
    pub(crate) list: Vec<Pattern>,
    /// Pixel memory left for tiles (decoded PNGs are charged here, not to the layers' budget).
    spent: u64,
}

impl Patterns {
    /// Adds a tile and gives its name and id (the same tile twice is one pattern).
    pub(crate) fn add(&mut self, png: Rgba8, name: Option<&str>) -> Result<(String, String), String> {
        let Rgba8 { width, height, data } = png;
        if width == 0 || height == 0 || width > photocraft_doc::pattern::MAX_EDGE || height > photocraft_doc::pattern::MAX_EDGE {
            return Err("is too large".into());
        }
        self.spent += data.len() as u64;
        if self.spent > container::MAX_PATTERN_BYTES {
            return Err("does not fit in the memory left for patterns".into());
        }
        let name =
            name.map(str::trim).filter(|s| !s.is_empty()).map_or_else(|| format!("Pigment pattern {}", self.list.len() + 1), |s| s.chars().take(255).collect());
        let mut surface = Surface::new(PixelFormat::new(photocraft_color::ColorMode::Rgb, SampleType::U8, true));
        surface.try_write_interleaved(Rect::new(0, 0, width as i32, height as i32), &data).map_err(|e| format!("could not be stored ({e})"))?;
        let pattern = Pattern::new(name, surface, width, height);
        if let Some(p) = self.list.iter().find(|p| p.id == pattern.id) {
            return Ok((p.name.clone(), p.id.clone()));
        }
        if self.list.len() >= MAX_PATTERNS {
            return Err(format!("is past the {MAX_PATTERNS} patterns one document may bring"));
        }
        let found = (pattern.name.clone(), pattern.id.clone());
        self.list.push(pattern);
        Ok(found)
    }

    /// A tile kept as `data:image/png;base64,…`.
    pub(crate) fn add_data_url(&mut self, url: &str, name: Option<&str>, _preset: Option<&str>) -> Result<(String, String), String> {
        if url.len() > MAX_DATA_URL {
            return Err("is too large".into());
        }
        let Some((head, body)) = url.split_once(',') else { return Err("is not a data URL".into()) };
        if !head.starts_with("data:") || !head.ends_with(";base64") {
            return Err("is not a base64 data URL".into());
        }
        let bytes = base64(body).ok_or("is not valid base64")?;
        let png = container::decode_png(&bytes, container::MAX_PATTERN_BYTES.saturating_sub(self.spent))?;
        self.add(png, name)
    }
}

/// Standard base64 (padding optional, whitespace ignored).
fn base64(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0u32);
    for b in s.bytes() {
        let v = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            b' ' | b'\n' | b'\r' | b'\t' => continue,
            _ => return None,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

fn num(o: &Map<String, Value>, key: &str) -> Option<f64> {
    o.get(key).and_then(Value::as_f64).filter(|n| n.is_finite())
}

fn point(v: Option<&Value>) -> Option<(f64, f64)> {
    let a = v?.as_array()?;
    let (x, y) = (a.first()?.as_f64()?, a.get(1)?.as_f64()?);
    (x.is_finite() && y.is_finite() && x.abs() < 1.0e7 && y.abs() < 1.0e7).then_some((x, y))
}

/// A box `(x, y, width, height)` in document pixels.
pub(crate) type Box2 = (f64, f64, f64, f64);

/// What a paint is placed against: the box of the app's placement and PhotoCraft's frame, and
/// whether the gradient aligns with the layer.
pub(crate) struct Place {
    pub(crate) bx: Box2,
    pub(crate) frame: Box2,
    pub(crate) align: bool,
}

/// `style`, `from` and `to` (document pixels) as PhotoCraft's angle, scale and centre offset
/// over `frame` (the inverse of `photocraft_compose::gradient_fill::handles`).
fn from_handles(style: GradientStyle, from: (f64, f64), to: (f64, f64), frame: Box2) -> (f32, f32, (f32, f32)) {
    let (dx, dy) = (to.0 - from.0, to.1 - from.1);
    let len = dx.hypot(dy);
    let angle = if len > 1e-4 { (-dy).atan2(dx).to_degrees() } else { 0.0 };
    let len = len.max(0.5);
    let c = if style == GradientStyle::Linear { ((from.0 + to.0) / 2.0, (from.1 + to.1) / 2.0) } else { from };
    let (w, h) = (frame.2.max(1.0), frame.3.max(1.0));
    let offset = ((c.0 - frame.0 - w / 2.0) / w, (c.1 - frame.1 - h / 2.0) / h);
    // `gradient_units` of photocraft-compose: the chord through the centre and the ellipse norm.
    let (s, co) = angle.to_radians().sin_cos();
    let chord = (w / co.abs().max(1e-6)).min(h / s.abs().max(1e-6)).max(1.0);
    let ellipse = ((co * w).powi(2) + (s * h).powi(2)).sqrt().max(1.0);
    let reach = match style {
        GradientStyle::Linear => chord,
        GradientStyle::Reflected => chord / 2.0,
        _ => ellipse / 2.0,
    };
    (angle as f32, (len / reach) as f32, (offset.0 as f32, offset.1 as f32))
}

fn style_of(g: &Map<String, Value>) -> GradientStyle {
    match g.get("kind").and_then(Value::as_str) {
        Some("radial") => GradientStyle::Radial,
        Some("angle") => GradientStyle::Angle,
        Some("reflected") => GradientStyle::Reflected,
        Some("diamond") => GradientStyle::Diamond,
        _ => GradientStyle::Linear,
    }
}

/// A gradient paint (`paint.gradient`) as a gradient fill.
fn gradient_fill(g: &Map<String, Value>, place: &Place) -> Fill {
    let def = Def::parse(&Value::Object(g.clone()));
    let style = style_of(g);
    let v2 = g.get("gradientVersion").and_then(Value::as_u64) == Some(2);
    let ends = point(g.get("from")).zip(point(g.get("to")));
    let legacy = ends.is_none() && ["angle", "scale", "offset"].iter().all(|k| g.get(*k).is_none_or(Value::is_null));
    // `canvasCanDraw`: 0.3's shapes and classic solid definitions without dither.
    let canvas = !v2 || (def.noise.is_none() && def.method == gradient::Method::Classic && g.get("dither").and_then(Value::as_bool) != Some(true));
    let (bx, by, bw, bh) = place.bx;
    let mut flip = false;
    let (from, to) = match ends {
        Some(ends) => ends,
        // 0.3: left to right across the box through its middle (radial and diamond from its left).
        None if legacy && canvas => ((bx, by + bh / 2.0), (bx + bw, by + bh / 2.0)),
        None => {
            // `gradientT` / `boxEnds`: around the box centre moved by `offset` (percent of the
            // box), along `angle` (counter-clockwise; a paint without one runs left to right).
            let off = g.get("offset").and_then(Value::as_array);
            let o = |i: usize| off.and_then(|a| a.get(i)).and_then(Value::as_f64).filter(|n| n.is_finite()).unwrap_or(0.0);
            let (cx, cy) = (bx + bw / 2.0 + o(0) / 100.0 * bw, by + bh / 2.0 + o(1) / 100.0 * bh);
            let a = num(g, "angle").unwrap_or(0.0).to_radians();
            let (ux, uy) = (a.cos(), -a.sin());
            let scale = num(g, "scale").unwrap_or(1.0).max(0.01);
            let len = ((bw * ux).abs() + (bh * uy).abs()).max(1e-6) * scale;
            let rad = (bw.max(bh) / 2.0).max(1e-6) * scale;
            match style {
                GradientStyle::Linear => ((cx - ux * len / 2.0, cy - uy * len / 2.0), (cx + ux * len / 2.0, cy + uy * len / 2.0)),
                GradientStyle::Reflected => ((cx, cy), (cx + ux * len / 2.0, cy + uy * len / 2.0)),
                // The app's box Angle gradient turns counter-clockwise, PhotoCraft's clockwise.
                GradientStyle::Angle => {
                    flip = true;
                    ((cx, cy), (cx + ux, cy + uy))
                }
                _ => ((cx, cy), (cx + ux * rad, cy + uy * rad)),
            }
        }
    };
    let (angle, scale, offset) = from_handles(style, from, to, place.frame);
    let reverse = g.get("reverse").and_then(Value::as_bool).unwrap_or(false);
    // A noise gradient keeps its settings and Reverse; others are reversed in the stops.
    let ((stops, opacity_stops), reverse, noise) = def.paint(reverse != flip);
    Fill::Gradient {
        stops,
        angle,
        scale,
        style,
        reverse,
        opacity_stops,
        midpoints: Vec::new(),
        offset,
        dither: g.get("dither").and_then(Value::as_bool).unwrap_or(false),
        align: place.align,
        noise,
    }
}

/// The pattern placement of a paint: Link with Layer, the origin and the scale.
fn pattern_fill(p: &Map<String, Value>, name: String, id: String) -> Fill {
    let origin = point(p.get("origin")).unwrap_or((0.0, 0.0));
    Fill::Pattern {
        name,
        scale: num(p, "scale").filter(|s| *s > 0.0).unwrap_or(1.0).clamp(0.01, 10.0) as f32,
        id,
        angle: num(p, "angle").unwrap_or(0.0).rem_euclid(360.0) as f32,
        // 0.3's pattern had no link: it tiled from the document origin.
        link: p.get("link").and_then(Value::as_bool).unwrap_or(false),
        phase: (origin.0 as f32, origin.1 as f32),
    }
}

/// A solid colour of a paint.
fn solid(v: Option<&Value>) -> Color {
    let c = v.and_then(gradient::parse_color).unwrap_or([0.0, 0.0, 0.0, 1.0]);
    let [r, g, b] = [c[0], c[1], c[2]].map(|v| (v.clamp(0.0, 255.0) / 255.0) as f32);
    Color::rgba(r, g, b, c[3].clamp(0.0, 1.0) as f32)
}

/// A paint as a PhotoCraft fill; `tile` gives the pattern of a pattern paint (or why there is
/// none). `None`: no paint, or one that draws nothing.
pub(crate) fn fill_of(
    paint: &Value,
    place: &Place,
    tile: impl FnOnce(&Map<String, Value>) -> Result<(String, String), String>,
    notes: &mut Vec<String>,
) -> Option<Fill> {
    let p = paint.as_object()?;
    match p.get("type").and_then(Value::as_str) {
        Some("solid") => Some(Fill::Solid(solid(p.get("color")))),
        Some("gradient") => Some(gradient_fill(p.get("gradient").and_then(Value::as_object).unwrap_or(&Map::new()), place)),
        Some("pattern") => {
            let pat = p.get("pattern").and_then(Value::as_object)?;
            match tile(pat) {
                Ok((name, id)) => Some(pattern_fill(pat, name, id)),
                Err(why) => {
                    notes.push(format!("the pattern {why}; nothing is drawn with it"));
                    None
                }
            }
        }
        other => {
            notes.push(format!("the paint \"{}\" is not known; nothing is drawn with it", other.unwrap_or("").chars().take(40).collect::<String>()));
            None
        }
    }
}

// ---- paths of shapes and vector masks ---------------------------------------------------------

/// The area of a path as the app drew it (`drawPathArea`), from an empty start.
pub(crate) fn area(v: &Value) -> Path {
    let mut path = to_path(v).unwrap_or_default();
    let ops = path.subpaths.iter().any(|s| s.op != PathOp::Combine);
    if !ops {
        // One non-zero fill of the whole path.
        for s in path.subpaths.iter_mut().skip(1) {
            s.op = PathOp::Join;
        }
        return path;
    }
    // Subtracting from or intersecting with nothing leaves nothing.
    let skip = path.subpaths.iter().take_while(|s| matches!(s.op, PathOp::Subtract | PathOp::Intersect)).count();
    path.subpaths.drain(..skip);
    if let Some(first) = path.subpaths.first_mut() {
        first.op = PathOp::Combine;
    }
    path
}

/// The area of a vector mask's path: `reveal` starts from everything shown (`initialFill:
/// 'reveal'`). In PhotoCraft an empty vector mask reveals everything unless inverted.
pub(crate) fn mask_area(v: &Value, reveal: bool, notes: &mut Vec<String>) -> Path {
    if !reveal {
        let mut p = area(v);
        if p.subpaths.is_empty() {
            p.inverted = true;
        }
        return p;
    }
    let mut path = to_path(v).unwrap_or_default();
    // On a full start, combining adds nothing.
    let skip = path.subpaths.iter().take_while(|s| s.op == PathOp::Combine).count();
    path.subpaths.drain(..skip);
    let Some(first) = path.subpaths.first().map(|s| s.op) else { return path };
    if first == PathOp::Intersect {
        // Everything intersected with the first subpath is that subpath.
        if let Some(s) = path.subpaths.first_mut() {
            s.op = PathOp::Combine;
        }
        return path;
    }
    // Subtract (or exclude) from everything: the rest of the path, inverted, with every later
    // operation replaced by its complement (combine ↔ subtract; exclude is its own).
    path.inverted = true;
    for (i, s) in path.subpaths.iter_mut().enumerate() {
        s.op = match (i, s.op) {
            (0, _) => PathOp::Combine,
            (_, PathOp::Combine) => PathOp::Subtract,
            (_, PathOp::Subtract) => PathOp::Combine,
            (_, op) => op,
        };
    }
    if path.subpaths.iter().skip(1).any(|s| s.op == PathOp::Intersect) {
        notes.push("the vector mask intersects a shape after Reveal All, which Pigment draws differently".into());
    }
    path
}

/// `vectorMask` (`{ path, enabled, linked, density, feather, initialFill }`).
pub(crate) fn vector_mask(v: &Map<String, Value>, notes: &mut Vec<String>) -> VectorMask {
    let reveal = v.get("initialFill").and_then(Value::as_str) == Some("reveal");
    VectorMask {
        path: mask_area(v.get("path").unwrap_or(&Value::Null), reveal, notes),
        enabled: v.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        linked: v.get("linked").and_then(Value::as_bool).unwrap_or(true),
        density: num(v, "density").unwrap_or(1.0).clamp(0.0, 1.0) as f32,
        feather: num(v, "feather").unwrap_or(0.0).clamp(0.0, 1000.0) as f32,
    }
}

/// The box of a path's anchors and handles (`pathBounds`: at least 1 px each way).
pub(crate) fn path_box(path: &Path) -> Option<Box2> {
    let (x0, y0, x1, y1) = path.control_bounds()?;
    Some((x0, y0, (x1 - x0).max(1.0), (y1 - y0).max(1.0)))
}

/// The stroke of a shape (`{ color | paint, width, align, dash, dashOffset?, cap?, join?,
/// miterLimit? }`). Before version 3 dashes were in pixels, since in stroke widths.
fn stroke_of(
    s: &Map<String, Value>,
    place: &Place,
    version: u64,
    tile: impl FnOnce(&Map<String, Value>) -> Result<(String, String), String>,
    notes: &mut Vec<String>,
) -> Option<ShapeStroke> {
    let width = num(s, "width").filter(|w| *w > 0.0)?.min(1.0e6);
    let paint = match s.get("paint") {
        Some(Value::Null) => return None,
        Some(p) => fill_of(p, place, tile, notes)?,
        None => Fill::Solid(solid(s.get("color").or(Some(&Value::String("#000000".into()))))),
    };
    let mut dashes: Vec<f32> = s
        .get("dash")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .take(32)
                .map(|v| v.as_f64().filter(|n| n.is_finite()).unwrap_or(0.0).max(0.0))
                .map(|v| if version < 3 { v / width } else { v })
                .map(|v| v.min(10_000.0) as f32)
                .collect()
        })
        .unwrap_or_default();
    if dashes.iter().all(|d| *d == 0.0) {
        dashes.clear();
    }
    Some(ShapeStroke {
        width: width as f32,
        paint,
        opacity: 1.0,
        align: match s.get("align").and_then(Value::as_str) {
            Some("inside") => StrokeAlign::Inside,
            Some("outside") => StrokeAlign::Outside,
            _ => StrokeAlign::Center,
        },
        cap: match s.get("cap").and_then(Value::as_str) {
            Some("round") => LineCap::Round,
            Some("square") => LineCap::Square,
            _ => LineCap::Butt,
        },
        join: match s.get("join").and_then(Value::as_str) {
            Some("round") => LineJoin::Round,
            Some("bevel") => LineJoin::Bevel,
            _ => LineJoin::Miter,
        },
        // The canvas default the app drew with.
        miter_limit: num(s, "miterLimit").unwrap_or(4.0).clamp(1.0, 500.0) as f32,
        dash_offset: if dashes.is_empty() { 0.0 } else { num(s, "dashOffset").unwrap_or(0.0).clamp(-1.0e6, 1.0e6) as f32 },
        dashes,
    })
}

/// The live shape PhotoCraft can keep editable for the app's `shapeKind` and `shapeProps`
/// (`normalizeShapeProps` of path-ops.js), or why the shape opens as a plain path.
fn live_of(kind: &str, p: &Map<String, Value>) -> Result<Option<LiveShape>, &'static str> {
    let n = |k: &str, d: f64| num(p, k).unwrap_or(d);
    let rect = [n("x", 0.0), n("y", 0.0), n("width", 0.0), n("height", 0.0)];
    let turned = n("angle", 0.0).rem_euclid(360.0) != 0.0;
    Ok(Some(match kind {
        "path" | "" => return Ok(None),
        _ if turned => return Err("turned"),
        "rect" => {
            let r = n("radius", 0.0);
            let radii = match p.get("radii").and_then(Value::as_array) {
                Some(a) if a.len() == 4 => [0, 1, 2, 3].map(|i| a[i].as_f64().filter(|v| v.is_finite()).unwrap_or(0.0)),
                _ => [r; 4],
            };
            LiveShape::Rect { rect, radii }
        }
        "ellipse" => LiveShape::Ellipse { rect },
        "triangle" => LiveShape::Triangle { rect, corner_radius: n("radius", 0.0) },
        "polygon" => {
            if p.get("smoothCorners").and_then(Value::as_bool) == Some(true) || p.get("smoothIndents").and_then(Value::as_bool) == Some(true) {
                return Err("smooth");
            }
            let star = match num(p, "starRatio") {
                Some(r) => r,
                None if p.get("star").and_then(Value::as_bool) == Some(true) => 100.0 - n("inset", 50.0),
                None => 100.0,
            };
            LiveShape::Polygon {
                rect,
                sides: n("sides", 5.0).round().clamp(3.0, 100.0) as u32,
                star_ratio: (star / 100.0).clamp(0.01, 1.0),
                corner_radius: n("cornerRadius", 0.0),
            }
        }
        "line" => {
            let (from, to, weight) = ([n("x1", 0.0), n("y1", 0.0)], [n("x2", 0.0), n("y2", 0.0)], n("weight", 1.0));
            // 0.3's arrows were `true`: a head five times the weight, flat.
            let arrow = |k: &str| match p.get(k) {
                Some(Value::Bool(true)) => Some((500.0, 500.0, 0.0)),
                Some(Value::Object(a)) => Some((num(a, "width").unwrap_or(500.0), num(a, "length").unwrap_or(500.0), num(a, "concavity").unwrap_or(0.0))),
                _ => None,
            };
            match (arrow("arrowStart"), arrow("arrowEnd")) {
                (None, None) => LiveShape::Line { from, to, weight },
                (s, e) => {
                    let (w, l, c) = e.or(s).unwrap_or((500.0, 500.0, 0.0));
                    LiveShape::ArrowLine {
                        from,
                        to,
                        weight,
                        start: s.is_some(),
                        end: e.is_some(),
                        width: w * weight / 100.0,
                        length: l * weight / 100.0,
                        concavity: c.clamp(-50.0, 50.0),
                    }
                }
            }
        }
        _ => return Err("custom"),
    }))
}

/// A shape layer (`path`, `fill`, `stroke`, `shapeKind`, `shapeProps`).
pub(crate) fn shape(d: &Map<String, Value>, version: u64, patterns: &mut Patterns, notes: &mut Vec<String>) -> ShapeLayer {
    let path = area(d.get("path").unwrap_or(&Value::Null));
    let bx = path_box(&path).unwrap_or((0.0, 0.0, 1.0, 1.0));
    let place = Place { bx, frame: bx, align: true };
    let mut tile = |p: &Map<String, Value>| -> Result<(String, String), String> {
        let url = p.get("dataUrl").and_then(Value::as_str).ok_or("is not in the file")?;
        patterns.add_data_url(url, p.get("name").and_then(Value::as_str), p.get("presetId").and_then(Value::as_str))
    };
    // A missing fill is the app's default blue; `null` is no fill.
    let fill = match d.get("fill") {
        None => Some(Fill::Solid(Color::rgb(0x4f as f32 / 255.0, 0x81 as f32 / 255.0, 1.0))),
        Some(Value::Null) => None,
        Some(p) => fill_of(p, &place, &mut tile, notes),
    };
    let stroke = d.get("stroke").and_then(Value::as_object).and_then(|s| stroke_of(s, &place, version, &mut tile, notes));
    let kind = d.get("shapeKind").and_then(Value::as_str).unwrap_or("path");
    let props = d.get("shapeProps").and_then(Value::as_object).cloned().unwrap_or_default();
    let live = match live_of(kind, &props) {
        Ok(live) => live,
        Err(why) => {
            let what = match kind {
                "rect" => "rectangle",
                "ellipse" => "ellipse",
                "triangle" => "triangle",
                "polygon" => "polygon",
                "line" => "line",
                _ => "custom shape",
            };
            if why != "custom" {
                notes.push(format!(
                    "the {what} is {}, which Pigment's live shapes are not; it opens as a path",
                    if why == "turned" { "turned" } else { "smoothed" }
                ));
            }
            None
        }
    };
    ShapeLayer { path, fill, stroke, live, cache: None, psd_raw: None, density: 1.0, feather: 0.0 }
}
