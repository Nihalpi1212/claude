//! Type layers of Pigment 0.1–0.4 (`TextLayer` in `renderer/lib/document.js`, the rich-text model
//! of `renderer/lib/type/model.js`), as editable PhotoCraft type.
//!
//! Version 3 files (0.4) describe the text as `content` `{ v: 1, text, runs: [{ len, style }],
//! paras: [{ style }] }`: runs over UTF-16 code units, sparse styles over `CHAR_DEFAULTS` and
//! `PARA_DEFAULTS`. Versions 1 and 2 (0.1–0.3) have one `font` for the whole text, which 0.4 read
//! through `fromLegacy`; this does the same. Sizes, leading, indents and shifts were pixels in the
//! app; PhotoCraft keeps points, so they are divided by the resolution.
//!
//! Where the type sits: the app put the first baseline 0.8 × the largest size of the first line
//! below `y` (`layout.js` "First baseline"); point text began at `x` and centred or right-aligned
//! lines in the width of the widest one, where PhotoCraft aligns each line about the point the
//! text hangs from. The layout of the converted layer is measured once to put the text where the
//! app drew it.

use photocraft_color::{Color, ColorMode};
use photocraft_doc::TextLayer;
use photocraft_doc::effects::{Effect, FxCommon, FxPaint, StrokeFx, StrokePosition};
use photocraft_doc::text::{
    AntiAlias, Caps, CharStyle, FontBaseline, FontFeature, Kerning, Orientation, ParagraphRun, ParagraphStyle, TextAlign, TextRun, TextShape,
};
use photocraft_geom::Affine;
use serde_json::{Map, Value};

use super::{hex_rgb, path};

/// Characters one type layer may hold (the app had no limit; a document this long is not type).
const MAX_TEXT: usize = 1 << 20;
/// Runs and paragraphs one layer may hold.
const MAX_RUNS: usize = 65_536;

/// A type layer as converted, and the type's stroke, which PhotoCraft draws as a layer effect.
pub(crate) struct Converted {
    pub(crate) text: TextLayer,
    /// A Stroke effect that draws what the app's stroked type drew.
    pub(crate) stroke: Option<Effect>,
}

fn num(o: &Map<String, Value>, key: &str) -> Option<f64> {
    o.get(key).and_then(Value::as_f64).filter(|n| n.is_finite())
}

fn clamp(v: Option<f64>, default: f64, lo: f64, hi: f64) -> f64 {
    v.map_or(default, |n| n.clamp(lo, hi))
}

/// A character style of the file: the sparse style over the app's defaults (`CHAR_DEFAULTS`).
struct Char<'a>(&'a Map<String, Value>);

impl Char<'_> {
    fn size(&self) -> f64 {
        clamp(num(self.0, "size"), 48.0, 0.1, 10_000.0)
    }
    fn bool(&self, key: &str) -> bool {
        self.0.get(key).and_then(Value::as_bool).unwrap_or(false)
    }
    fn str(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
    }
    /// `stroke: { color, width }`, when it draws.
    fn stroke(&self) -> Option<([u8; 3], f64)> {
        let s = self.0.get("stroke")?.as_object()?;
        let width = clamp(num(s, "width"), 0.0, 0.0, 1000.0);
        (width > 0.0).then(|| (s.get("color").and_then(Value::as_str).and_then(hex_rgb).unwrap_or([0, 0, 0]), width))
    }
}

/// What the conversion leaves out or draws another way, said once per layer.
#[derive(Default)]
struct Losses {
    lost: Vec<&'static str>,
}

impl Losses {
    fn add(&mut self, what: &'static str) {
        if !self.lost.contains(&what) {
            self.lost.push(what);
        }
    }
}

fn char_style(c: &Char<'_>, pt: f64, mode: ColorMode, losses: &mut Losses) -> CharStyle {
    let o = c.0;
    let mut s = CharStyle {
        font_family: c.str("fontFamily").unwrap_or("Arial").chars().take(256).collect(),
        postscript_name: c.str("postScriptName").map(|p| p.chars().take(256).collect()),
        weight: clamp(num(o, "fontWeight"), 400.0, 100.0, 900.0).round() as u16,
        italic: c.bool("fontItalic"),
        size_pt: (c.size() * pt) as f32,
        color: Color::rgb(0.0, 0.0, 0.0),
        tracking: clamp(num(o, "tracking"), 0.0, -1000.0, 10_000.0) as f32,
        leading_pt: num(o, "leading").map(|l| (l.clamp(0.1, 20_000.0) * pt) as f32),
        baseline_shift_pt: (clamp(num(o, "baselineShift"), 0.0, -10_000.0, 10_000.0) * pt) as f32,
        horizontal_scale: (clamp(num(o, "scaleX"), 100.0, 1.0, 1000.0) / 100.0) as f32,
        vertical_scale: (clamp(num(o, "scaleY"), 100.0, 1.0, 1000.0) / 100.0) as f32,
        underline: c.bool("underline"),
        strikethrough: c.bool("strike"),
        faux_bold: c.bool("fauxBold"),
        faux_italic: c.bool("fauxItalic"),
        kerning: match c.str("autoKern") {
            Some("optical") => Kerning::Optical,
            Some("none") => Kerning::Off,
            _ => Kerning::Metrics,
        },
        kern: clamp(num(o, "kern"), 0.0, -1000.0, 10_000.0) as f32,
        caps: match c.str("caps") {
            Some("all") => Caps::AllCaps,
            Some("small") => Caps::SmallCaps,
            _ => Caps::Normal,
        },
        baseline: match c.str("position") {
            Some("super") => FontBaseline::Superscript,
            Some("sub") => FontBaseline::Subscript,
            _ => FontBaseline::Normal,
        },
        // The app's default language; PhotoCraft's is no language.
        language: c.str("language").filter(|l| *l != "en-US").map(|l| l.chars().take(64).collect()),
        ..Default::default()
    };
    let [r, g, b] = c.str("color").and_then(hex_rgb).unwrap_or([0, 0, 0]);
    s.color = Color::rgb(f32::from(r) / 255.0, f32::from(g) / 255.0, f32::from(b) / 255.0).in_mode(mode);
    if let Some(features) = o.get("features").and_then(Value::as_object) {
        for (tag, value) in features.iter().take(64) {
            let Some(v) = value.as_f64().filter(|n| n.is_finite()) else { continue };
            match tag.as_str() {
                "liga" | "clig" => s.ligatures = v != 0.0,
                "dlig" => s.discretionary_ligatures = v != 0.0,
                // Kerning is `autoKern` in PhotoCraft as in the app's panel.
                "kern" => {}
                tag if tag.len() == 4 && tag.is_ascii() => s.features.push(FontFeature { tag: tag.to_string(), value: v.clamp(0.0, 65_535.0) as u16 }),
                _ => {}
            }
        }
    }
    if c.bool("noBreak") {
        losses.add("No Break");
    }
    if o.get("fractionalWidths").and_then(Value::as_bool) == Some(false) {
        losses.add("Fractional Widths off");
    }
    s
}

fn para_style(p: &Map<String, Value>, pt: f64, losses: &mut Losses) -> ParagraphStyle {
    let px = |key: &str| (clamp(num(p, key), 0.0, -10_000.0, 10_000.0) * pt) as f32;
    let justification = p.get("justification").and_then(Value::as_object);
    let auto_leading = justification.and_then(|j| num(j, "autoLeading")).map_or(120.0, |a| a.clamp(0.0, 500.0));
    if p.get("list").is_some_and(Value::is_object) {
        losses.add("bulleted and numbered lists");
    }
    if p.get("hangingPunctuation").and_then(Value::as_bool) == Some(true) {
        losses.add("Roman Hanging Punctuation");
    }
    if let Some(j) = justification {
        let three = |key: &str, default: [f64; 3]| j.get(key).and_then(Value::as_array).is_some_and(|a| a.iter().map(Value::as_f64).ne(default.map(Some)));
        if three("word", [80.0, 100.0, 133.0]) || three("letter", [0.0, 0.0, 0.0]) || three("glyph", [100.0, 100.0, 100.0]) {
            losses.add("Justification word, letter and glyph spacing");
        }
    }
    let hyphenate = p.get("hyphenate").and_then(Value::as_bool).unwrap_or(false);
    if hyphenate && p.get("hyphenation").is_some_and(Value::is_object) {
        losses.add("Hyphenation settings");
    }
    if num(p, "tabStop").is_some_and(|t| t != 36.0) {
        losses.add("tab stops");
    }
    ParagraphStyle {
        align: match p.get("align").and_then(Value::as_str) {
            Some("center") => TextAlign::Center,
            Some("right") => TextAlign::Right,
            Some("justify-left") => TextAlign::JustifyLeft,
            Some("justify-center") => TextAlign::JustifyCenter,
            Some("justify-right") => TextAlign::JustifyRight,
            Some("justify-all") => TextAlign::JustifyAll,
            _ => TextAlign::Left,
        },
        first_line_indent_pt: px("indentFirst"),
        start_indent_pt: px("indentLeft"),
        end_indent_pt: px("indentRight"),
        space_before_pt: px("spaceBefore"),
        space_after_pt: px("spaceAfter"),
        auto_leading: (auto_leading / 100.0) as f32,
        hyphenate,
        ..Default::default()
    }
}

/// A layer's text, its character runs (UTF-16 lengths, sparse styles) and paragraph styles.
type Content = (String, Vec<(usize, Map<String, Value>)>, Vec<Map<String, Value>>);

/// The content of a 0.1–0.3 layer: `text` and one `font` (`fromLegacy` in type/model.js).
fn from_legacy(desc: &Map<String, Value>) -> Content {
    let text: String = desc.get("text").and_then(Value::as_str).unwrap_or("").chars().take(MAX_TEXT).collect();
    let f = desc.get("font").and_then(Value::as_object).cloned().unwrap_or_default();
    let mut char = Map::new();
    for (from, to) in [
        ("family", "fontFamily"),
        ("weight", "fontWeight"),
        ("italic", "fontItalic"),
        ("size", "size"),
        ("color", "color"),
        ("underline", "underline"),
        ("stroke", "stroke"),
    ] {
        if let Some(v) = f.get(from) {
            char.insert(to.into(), v.clone());
        }
    }
    let size = num(&f, "size").filter(|s| *s > 0.0).unwrap_or(48.0);
    if let Some(ls) = num(&f, "letterSpacing").filter(|l| *l != 0.0) {
        char.insert("tracking".into(), Value::from(ls * 1000.0 / size));
    }
    let mut para = Map::new();
    if let Some(a) = f.get("align") {
        para.insert("align".into(), a.clone());
    }
    if let Some(lh) = num(&f, "lineHeight") {
        para.insert("justification".into(), serde_json::json!({ "autoLeading": lh * 100.0 }));
    }
    let utf16 = text.encode_utf16().count();
    let paras = text.split('\n').count();
    (text, vec![(utf16, char)], vec![para; paras.min(MAX_RUNS)])
}

/// The content of a 0.4 layer: its text, runs (UTF-16 lengths) and paragraph styles.
fn content(c: &Map<String, Value>) -> Content {
    let text: String = c.get("text").and_then(Value::as_str).unwrap_or("").chars().take(MAX_TEXT).collect();
    let runs = c
        .get("runs")
        .and_then(Value::as_array)
        .map(|runs| {
            runs.iter()
                .take(MAX_RUNS)
                .filter_map(|r| Some((r.get("len")?.as_u64()? as usize, r.get("style").and_then(Value::as_object).cloned().unwrap_or_default())))
                .collect()
        })
        .unwrap_or_default();
    let paras = c
        .get("paras")
        .and_then(Value::as_array)
        .map(|p| p.iter().take(MAX_RUNS).map(|p| p.get("style").and_then(Value::as_object).cloned().unwrap_or_default()).collect())
        .unwrap_or_default();
    (text, runs, paras)
}

/// Runs over UTF-16 code units as runs over UTF-8 bytes of `text` (an index inside a surrogate
/// pair snaps to the pair's start, as in the app). What the runs leave uncovered takes the last
/// run's style.
fn byte_runs<T: Clone>(text: &str, runs: &[(usize, T)]) -> Vec<(usize, T)> {
    let mut out: Vec<(usize, T)> = Vec::new();
    let mut chars = text.chars().peekable();
    for (len, style) in runs {
        let (mut units, mut bytes) = (0usize, 0usize);
        while units < *len {
            let Some(c) = chars.next() else { break };
            units += c.len_utf16();
            bytes += c.len_utf8();
        }
        if bytes > 0 {
            out.push((bytes, style.clone()));
        }
    }
    let rest: usize = chars.map(char::len_utf8).sum();
    match out.last_mut() {
        Some(last) if rest > 0 => last.0 += rest,
        None => {
            if let Some((_, style)) = runs.first() {
                out.push((text.len(), style.clone()));
            }
        }
        _ => {}
    }
    out
}

/// Byte lengths of the paragraphs of `text` (each with its `\n`).
fn paragraph_lengths(text: &str) -> Vec<usize> {
    let mut out: Vec<usize> = text.split_inclusive('\n').map(str::len).collect();
    if text.is_empty() || text.ends_with('\n') {
        out.push(0);
    }
    out
}

/// The JavaScript `transform` `[a, b, c, d, e, f]`, or the identity.
pub(crate) fn matrix(v: Option<&Value>) -> Option<Affine> {
    let a = v?.as_array().filter(|a| a.len() == 6)?;
    let m: Vec<f64> = a.iter().filter_map(|n| n.as_f64().filter(|n| n.is_finite() && n.abs() <= 1.0e7)).collect();
    let m: [f64; 6] = m.try_into().ok()?;
    let det = m[0] * m[3] - m[1] * m[2];
    (det.is_finite() && det.abs() > 1.0e-9).then_some(Affine { m })
}

/// A type layer of the file (`desc`); `dpi` is the document's resolution, `mode` its image mode.
pub(crate) fn text_layer(desc: &Map<String, Value>, dpi: f32, mode: ColorMode, notes: &mut Vec<String>) -> Converted {
    let pt = 72.0 / f64::from(dpi.max(1.0));
    let (text, runs, paras) = match desc.get("content").and_then(Value::as_object).filter(|c| c.get("text").is_some_and(Value::is_string)) {
        Some(c) => content(c),
        None => from_legacy(desc),
    };
    let empty = Map::new();
    let runs = if runs.is_empty() { vec![(0, empty.clone())] } else { runs };
    let byte_runs = byte_runs(&text, &runs);
    let mut losses = Losses::default();

    let mut char_runs = Vec::with_capacity(byte_runs.len());
    let mut strokes: Vec<Option<([u8; 3], f64)>> = Vec::new();
    for (len, style) in &byte_runs {
        let c = Char(style);
        char_runs.push(TextRun { len: *len, style: char_style(&c, pt, mode, &mut losses) });
        strokes.push(c.stroke());
    }
    let para_runs: Vec<ParagraphRun> = paragraph_lengths(&text)
        .into_iter()
        .enumerate()
        .map(|(i, len)| ParagraphRun { len, style: para_style(paras.get(i).or(paras.last()).unwrap_or(&empty), pt, &mut losses) })
        .collect();

    // The first line's largest size: the app's first baseline sits 0.8 × that below `y`.
    let first_line = text.find(['\n', '\u{2028}']).unwrap_or(text.len());
    let mut at = 0usize;
    let mut first_size = 0.0f64;
    for (len, style) in &byte_runs {
        if at <= first_line {
            first_size = first_size.max(Char(style).size());
        }
        at += len;
    }
    if first_size == 0.0 {
        first_size = Char(&runs[0].1).size();
    }

    let options = desc.get("typeOptions").and_then(Value::as_object);
    let orientation = options
        .and_then(|o| o.get("orientation"))
        .or_else(|| desc.get("font").and_then(|f| f.get("orientation")))
        .and_then(Value::as_str)
        .unwrap_or("horizontal");
    let antialias = match options.and_then(|o| o.get("antiAlias")).and_then(Value::as_str) {
        Some("none") => AntiAlias::None,
        Some("sharp") => AntiAlias::Sharp,
        Some("crisp") => AntiAlias::Crisp,
        Some("strong") => AntiAlias::Strong,
        _ => AntiAlias::Smooth,
    };
    let mut t = TextLayer { text, runs: char_runs, paragraphs: para_runs, antialias, ..Default::default() };
    t.sync_summary();

    let n = |key: &str| num(desc, key).filter(|v| v.abs() <= 1.0e7);
    let (x, y) = (n("x").unwrap_or(0.0), n("y").unwrap_or(0.0));
    let m = matrix(desc.get("transform"));
    let place = |local: Affine| m.map_or(local, |m| m.mul(&local));
    let path_text = desc.get("pathText").and_then(Value::as_object).and_then(|p| {
        let path = path::to_path(p.get("path")?)?;
        let sub = path.subpaths.into_iter().find(|s| s.knots.len() >= 2)?;
        Some((sub, p))
    });

    if let Some((mut sub, p)) = path_text {
        // The path is in document pixels, moved by the layer's x and y (`samplePath` offsets).
        for k in &mut sub.knots {
            for q in [&mut k.anchor, &mut k.in_ctrl, &mut k.out_ctrl] {
                q.x += x;
                q.y += y;
            }
        }
        let flip = p.get("flip").and_then(Value::as_bool).unwrap_or(false);
        let offset = num(p, "startOffset").map_or(0.0, |o| o.clamp(0.0, 1.0));
        let length = photocraft_text::warp::PathGeometry::new(&sub, flip).map_or(0.0, |g| g.length());
        t.shape = TextShape::Path { path: sub, start: (offset * length) as f32, end: None, flip };
        t.transform = place(Affine::IDENTITY);
    } else if orientation == "vertical-stacked" {
        // Upright characters in columns from right to left, the first column's centre
        // `(lines - 1) × pitch + pitch / 2` right of `x` (`layoutStacked` in lib/text-path.js);
        // PhotoCraft's vertical point type hangs from the top of the first column's centre line.
        t.orientation = Orientation::Vertical;
        let lines = t.text.split('\n').count().max(1) as f64;
        let line_height =
            paras.first().and_then(|p| p.get("justification")).and_then(|j| j.get("autoLeading")).and_then(Value::as_f64).map_or(1.2, |a| a / 100.0);
        let pitch = first_size * line_height;
        t.transform = place(Affine::translate(x + (lines - 1.0) * pitch + pitch / 2.0, y));
        notes.push("vertical type is laid out by Pigment's type engine, so its columns may sit a little differently".into());
    } else {
        // 0.4's "vertical" was horizontal type turned a quarter (`setOrientation` in
        // lib/text-path.js put the turn in `transform`): it stays that.
        match n("width").filter(|w| *w > 0.0) {
            Some(width) => {
                let height = n("height").filter(|h| *h > 0.0);
                t.shape = TextShape::Box { x: 0.0, y: 0.0, width: width as f32, height: height.unwrap_or(1.0e5) as f32 };
                t.transform = place(Affine::translate(x, y));
                fit_box(&mut t, dpi, first_size, height.is_none());
            }
            None => {
                t.transform = place(Affine::translate(x, y + first_size * 0.8));
                align_point(&mut t, dpi);
            }
        }
    }

    // The app drew a stroke under the fill of each glyph: what shows is its outer half.
    let stroked: Vec<_> = strokes.iter().flatten().collect();
    let stroke = match stroked.first() {
        Some(&&(rgb, width)) => {
            if stroked.len() != strokes.len() || stroked.iter().any(|s| **s != (rgb, width)) {
                notes.push("the type's stroke differed between characters; the whole layer has the first one, as a Stroke layer effect".into());
            }
            let color = Color::rgb(f32::from(rgb[0]) / 255.0, f32::from(rgb[1]) / 255.0, f32::from(rgb[2]) / 255.0).in_mode(mode);
            Some(Effect::Stroke(StrokeFx {
                common: FxCommon::new(photocraft_color::BlendMode::Normal, 1.0),
                size: ((width / 2.0) as f32).clamp(0.5, 250.0),
                position: StrokePosition::Outside,
                paint: FxPaint::Color(color),
                overprint: false,
            }))
        }
        None => None,
    };
    if !losses.lost.is_empty() {
        notes.push(format!("type settings Pigment does not have were left out: {}", losses.lost.join(", ")));
    }
    Converted { text: t, stroke }
}

/// Point type: the app centred and right-aligned lines in the width of the widest line from `x`,
/// PhotoCraft aligns them about the point. The text moves by half that width, or all of it.
fn align_point(t: &mut TextLayer, dpi: f32) {
    let align = t.paragraphs.first().map_or(TextAlign::Left, |p| p.style.align);
    let share = match align {
        TextAlign::Center | TextAlign::JustifyCenter => 0.5,
        TextAlign::Right | TextAlign::JustifyRight => 1.0,
        _ => return,
    };
    let mut left = t.clone();
    for p in &mut left.paragraphs {
        p.style.align = TextAlign::Left;
    }
    let layout = photocraft_text::shared().lock().unwrap_or_else(|e| e.into_inner()).layout(&left, dpi);
    let width = layout.lines.iter().map(|l| l.x1).fold(0.0f32, f32::max);
    if width.is_finite() && width > 0.0 {
        t.transform = t.transform.mul(&Affine::translate(f64::from(width) * share, 0.0));
    }
}

/// Paragraph type: the first baseline goes where the app put it (0.8 × the first size below the
/// box's top), and a box that grew with its text (`height: null`) gets the height of the text.
fn fit_box(t: &mut TextLayer, dpi: f32, first_size: f64, grows: bool) {
    let layout = photocraft_text::shared().lock().unwrap_or_else(|e| e.into_inner()).layout(t, dpi);
    let Some(first) = layout.lines.first() else { return };
    let shift = first_size * 0.8 - f64::from(first.baseline);
    if shift.is_finite() && shift.abs() < 1.0e4 {
        t.transform = t.transform.mul(&Affine::translate(0.0, shift));
    }
    if grows && let TextShape::Box { height, .. } = &mut t.shape {
        let bottom = layout.lines.iter().map(|l| l.baseline + l.descent).fold(0.0f32, f32::max);
        *height = (bottom + first_size as f32 * 0.25).ceil().clamp(1.0, 1.0e5);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn runs_of_utf16_units_become_runs_of_bytes() {
        // "é" is one unit and two bytes; "😀" two units and four bytes.
        let runs = byte_runs("aé😀b", &[(2, 'x'), (2, 'y'), (5, 'z')]);
        assert_eq!(runs, vec![(3, 'x'), (4, 'y'), (1, 'z')]);
        // A run that ends inside a surrogate pair takes the pair; what is left over joins the last run.
        assert_eq!(byte_runs("😀ab", &[(1, 'x')]), vec![(6, 'x')]);
        assert_eq!(byte_runs("", &[(0, 'x')]), vec![(0, 'x')]);
        assert_eq!(paragraph_lengths("ab\ncd\n"), vec![3, 3, 0]);
    }

    #[test]
    fn legacy_font_is_read_as_0_4_read_it() {
        let desc = json!({"text": "Hi\nthere", "font": {"family": "Georgia", "size": 20, "letterSpacing": 2, "lineHeight": 1.5, "align": "center"}});
        let (text, runs, paras) = from_legacy(desc.as_object().unwrap());
        assert_eq!((text.as_str(), runs.len(), paras.len()), ("Hi\nthere", 1, 2));
        assert_eq!(runs[0].1.get("tracking"), Some(&json!(100.0)));
        assert_eq!(paras[1].get("justification").and_then(|j| j.get("autoLeading")), Some(&json!(150.0)));
    }

    #[test]
    fn transforms_that_are_not_one_are_ignored() {
        assert_eq!(matrix(Some(&json!([1, 0, 0, 1, 5, 6]))), Some(Affine::translate(5.0, 6.0)));
        assert_eq!(matrix(Some(&json!([0, 0, 0, 0, 5, 6]))), None);
        assert_eq!(matrix(Some(&json!([1, 0, 0, "1", 5, 6]))), None);
        assert_eq!(matrix(Some(&json!(null))), None);
    }
}
