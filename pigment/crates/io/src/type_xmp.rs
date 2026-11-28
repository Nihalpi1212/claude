//! Pigment: the type settings Photoshop's EngineData has no verified key for, kept in the type
//! layer's XMP packet (`shmd` › `layerXMP`) as the JSON value of `pigment:typeExtra` in namespace
//! `urn:x-pigment:type:1` (PORTS-B decision 5).
//!
//! What goes here: System Layout, and per paragraph the bulleted or numbered list, Hyphenate
//! Capitalized Words, Hyphenate Last Word, Hyphenate Across Column and Single Word Justification.
//! Photoshop keeps a layer's XMP, so a round trip through Photoshop keeps them, but Photoshop does
//! not apply them. When a Photoshop sample shows the EngineData key of one of them, map the key in
//! `photocraft_text::psd` and take it out of here.
//!
//! The value: `{"systemLayout":true?,"paragraphs":[{"index":n,"list":{…}?,"capitalized":bool?,
//! "lastWord":bool?,"acrossColumn":bool?,"singleWord":"left|center|right|justify"?}]}`, with only
//! the settings that differ from the defaults. `index` counts the layer's paragraphs from 0.

use std::borrow::Cow;
use std::ops::Range;

use photocraft_doc::{Layer, LayerContent, TextLayer};
use photocraft_doc::text::{Hyphenation, LIST_NUMBER_STYLES, ListKind, ListStyle, ParagraphRun, ParagraphStyle, SingleWord};
use serde_json::{Map, Value, json};

/// The XMP namespace of the property.
pub const NAMESPACE: &str = "urn:x-pigment:type:1";
/// The property's local name.
const PROPERTY: &str = "typeExtra";
/// A packet larger than this is kept as it is, never searched or rewritten.
const MAX_PACKET: usize = 16 << 20;

/// The paragraphs of `t` (byte ranges, as the layout splits them) with the style of each.
pub fn paragraph_styles(t: &TextLayer) -> Vec<(Range<usize>, ParagraphStyle)> {
    let runs = t.paragraph_runs();
    let mut starts = Vec::with_capacity(runs.len());
    let mut at = 0usize;
    for r in &runs {
        starts.push(at);
        at = at.saturating_add(r.len);
    }
    let trailing_break = t.text.ends_with(['\r', '\n']);
    photocraft_text::layout::split_paragraphs(&t.text)
        .into_iter()
        .map(|p| {
            let i = if trailing_break && p.start == t.text.len() { runs.len().saturating_sub(1) } else { starts.iter().rposition(|&s| s <= p.start).unwrap_or(0) };
            let style = runs.get(i).map(|r| r.style.clone()).unwrap_or_default();
            (p, style)
        })
        .collect()
}

/// Sets the paragraph runs of `t` from one style per paragraph (as [`paragraph_styles`] gives
/// them), merging neighbours with the same style; an empty last paragraph after a line break keeps
/// its own zero-length run, as the engine's paragraph styling does.
pub fn set_paragraph_styles(t: &mut TextLayer, styles: Vec<(Range<usize>, ParagraphStyle)>) {
    let trailing_break = t.text.ends_with(['\r', '\n']);
    let mut out: Vec<ParagraphRun> = Vec::new();
    for (range, style) in styles {
        let len = range.end.saturating_sub(range.start);
        if len == 0 {
            if trailing_break || out.is_empty() {
                out.push(ParagraphRun { len: 0, style });
            }
            continue;
        }
        match out.last_mut() {
            Some(last) if last.style == style && last.len > 0 => last.len += len,
            _ => out.push(ParagraphRun { len, style }),
        }
    }
    t.paragraphs = out;
}

fn single_word_name(s: SingleWord) -> &'static str {
    match s {
        SingleWord::Justify => "justify",
        SingleWord::Left => "left",
        SingleWord::Center => "center",
        SingleWord::Right => "right",
    }
}

/// The list as JSON: `{"type":"bullet|number","marker":str,"start":n,"level":0..=8}` (the model's
/// own shape).
pub fn list_json(l: &ListStyle) -> Value {
    serde_json::to_value(l).unwrap_or(Value::Null)
}

/// A list from [`list_json`]'s shape, or `None` when it is not one; an invalid marker takes the
/// type's default, and numbers out of range are brought into it.
pub fn list_from_json(v: &Value) -> Option<ListStyle> {
    let o = v.as_object()?;
    let kind = match o.get("type").and_then(Value::as_str)? {
        "bullet" => ListKind::Bullet,
        "number" => ListKind::Number,
        _ => return None,
    };
    let mut l = ListStyle::new(kind);
    if let Some(m) = o.get("marker").and_then(Value::as_str) {
        let ok = match kind {
            ListKind::Number => LIST_NUMBER_STYLES.contains(&m),
            ListKind::Bullet => (1..=2).contains(&m.chars().count()) && !m.chars().any(char::is_control),
        };
        if ok {
            l.marker = m.to_string();
        }
    }
    if let Some(s) = o.get("start").and_then(Value::as_u64) {
        l.start = u32::try_from(s.min(u64::from(ListStyle::MAX_START))).unwrap_or(ListStyle::MAX_START);
    }
    if let Some(n) = o.get("level").and_then(Value::as_u64) {
        l.level = u8::try_from(n.min(u64::from(ListStyle::MAX_LEVEL))).unwrap_or(ListStyle::MAX_LEVEL);
    }
    Some(l)
}

/// The settings of `t` that only the XMP property keeps, or `None` when all are at their defaults.
pub fn write(t: &TextLayer) -> Option<Value> {
    let d = Hyphenation::default();
    let mut paras = Vec::new();
    for (i, (_, p)) in paragraph_styles(t).into_iter().enumerate() {
        let mut o = Map::new();
        if let Some(l) = &p.list {
            o.insert("list".into(), list_json(l));
        }
        for (key, have, default) in [
            ("capitalized", p.hyphenation.capitalized, d.capitalized),
            ("lastWord", p.hyphenation.last_word, d.last_word),
            ("acrossColumn", p.hyphenation.across_column, d.across_column),
        ] {
            if have != default {
                o.insert(key.into(), Value::Bool(have));
            }
        }
        if p.justification.single_word != SingleWord::Justify {
            o.insert("singleWord".into(), json!(single_word_name(p.justification.single_word)));
        }
        if !o.is_empty() {
            o.insert("index".into(), json!(i));
            paras.push(Value::Object(o));
        }
    }
    let mut out = Map::new();
    if t.system_layout {
        out.insert("systemLayout".into(), Value::Bool(true));
    }
    if !paras.is_empty() {
        out.insert("paragraphs".into(), Value::Array(paras));
    }
    (!out.is_empty()).then_some(Value::Object(out))
}

/// Applies a value [`write`] made to `t` (a paragraph index the layer doesn't have is ignored).
pub fn apply(t: &mut TextLayer, v: &Value) {
    if let Some(on) = v.get("systemLayout").and_then(Value::as_bool) {
        t.system_layout = on;
    }
    let Some(entries) = v.get("paragraphs").and_then(Value::as_array) else { return };
    let mut styles = paragraph_styles(t);
    let mut changed = false;
    for e in entries {
        let Some(style) = e.get("index").and_then(Value::as_u64).and_then(|i| usize::try_from(i).ok()).and_then(|i| styles.get_mut(i)).map(|s| &mut s.1) else {
            continue;
        };
        if let Some(l) = e.get("list").and_then(list_from_json) {
            style.list = Some(l);
        }
        for (key, field) in [
            ("capitalized", &mut style.hyphenation.capitalized),
            ("lastWord", &mut style.hyphenation.last_word),
            ("acrossColumn", &mut style.hyphenation.across_column),
        ] {
            if let Some(b) = e.get(key).and_then(Value::as_bool) {
                *field = b;
            }
        }
        style.justification.single_word = match e.get("singleWord").and_then(Value::as_str) {
            Some("left") => SingleWord::Left,
            Some("center") => SingleWord::Center,
            Some("right") => SingleWord::Right,
            _ => style.justification.single_word,
        };
        changed = true;
    }
    if changed {
        set_paragraph_styles(t, styles);
    }
}

/// Whether a type layer has list markers Photoshop will not draw (the export warns about them).
pub fn has_list(t: &TextLayer) -> bool {
    t.paragraphs.iter().any(|p| p.style.list.is_some())
}

/// The prefixes `packet` binds to [`NAMESPACE`].
fn prefixes(packet: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = packet;
    while let Some(at) = rest.find("xmlns:") {
        let after = &rest[at + 6..];
        let Some(eq) = after.find('=') else { break };
        let prefix = after[..eq].trim();
        let value = after[eq + 1..].trim_start();
        let quote = value.chars().next();
        if let Some(q @ ('"' | '\'')) = quote
            && let Some(end) = value[1..].find(q)
            && &value[1..1 + end] == NAMESPACE
            && !prefix.is_empty()
            && !out.iter().any(|p| p == prefix)
        {
            out.push(prefix.to_string());
        }
        rest = after;
    }
    out
}

fn unescape(s: &str) -> Option<String> {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let after = &rest[at + 1..];
        let semi = after.find(';')?;
        let name = &after[..semi];
        let c = match name {
            "amp" => '&',
            "lt" => '<',
            "gt" => '>',
            "quot" => '"',
            "apos" => '\'',
            _ => {
                let n = name.strip_prefix('#')?;
                let code = match n.strip_prefix('x').or_else(|| n.strip_prefix('X')) {
                    Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                    None => n.parse().ok()?,
                };
                char::from_u32(code)?
            }
        };
        out.push(c);
        rest = &after[semi + 1..];
    }
    out.push_str(rest);
    Some(out)
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Where the property is in `packet`: `(byte range to remove, its escaped value)`, in element form
/// (`<p:typeExtra>…</p:typeExtra>`) or attribute form (` p:typeExtra="…"`, which XMP toolkits write
/// for simple properties).
fn find(packet: &str) -> Vec<(Range<usize>, String)> {
    let mut out = Vec::new();
    for p in prefixes(packet) {
        let name = format!("{p}:{PROPERTY}");
        let (open, close) = (format!("<{name}>"), format!("</{name}>"));
        let mut from = 0;
        while let Some(a) = packet[from..].find(&open).map(|i| i + from) {
            let body = a + open.len();
            let Some(b) = packet[body..].find(&close).map(|i| i + body) else { break };
            out.push((a..b + close.len(), packet[body..b].to_string()));
            from = b + close.len();
        }
        let mut from = 0;
        while let Some(a) = packet[from..].find(&name).map(|i| i + from) {
            let after = &packet[a + name.len()..];
            let preceded = packet[..a].ends_with(char::is_whitespace);
            let value = after.trim_start().strip_prefix('=').map(str::trim_start);
            match (preceded, value.and_then(|v| v.chars().next())) {
                (true, Some(q @ ('"' | '\''))) => {
                    let v = value.unwrap_or_default();
                    let start = packet.len() - v.len() + 1;
                    let Some(end) = packet[start..].find(q).map(|i| i + start) else { break };
                    let ws = packet[..a].trim_end().len();
                    out.push((ws..end + 1, packet[start..end].to_string()));
                    from = end + 1;
                }
                _ => from = a + name.len(),
            }
        }
    }
    out.sort_by_key(|(r, _)| r.start);
    out
}

/// The value of `pigment:typeExtra` in a layer's XMP packet, if it has a readable one.
pub fn read(packet: &str) -> Option<Value> {
    if packet.len() > MAX_PACKET {
        return None;
    }
    find(packet).into_iter().find_map(|(_, raw)| unescape(&raw).and_then(|s| serde_json::from_str(&s).ok()))
}

/// The end of the packet's `rdf:RDF` element (any prefix): where a new description goes.
fn rdf_end(packet: &str) -> Option<usize> {
    let mut best = None;
    let mut from = 0;
    while let Some(a) = packet[from..].find("</").map(|i| i + from) {
        let rest = &packet[a + 2..];
        let name_len = rest.find(|c: char| c == '>' || c.is_whitespace()).unwrap_or(rest.len());
        let name = &rest[..name_len];
        if name == "RDF" || name.ends_with(":RDF") {
            best = Some(a);
        }
        from = a + 2;
    }
    best
}

const EMPTY_PACKET: &str = "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n </rdf:RDF>\n</x:xmpmeta>\n<?xpacket end=\"w\"?>";

/// `packet` with `pigment:typeExtra` set to `value` (or removed when `value` is `None`), every other
/// property kept as it was. A layer without a packet gets a minimal one when there is a value.
/// `None` means there is nothing to write (no packet and no value). A packet whose RDF element
/// can't be found, or that is too large to search, comes back unchanged.
pub fn merge_into(packet: Option<&str>, value: Option<&Value>) -> Option<String> {
    let Some(packet) = packet else {
        return value.and_then(|v| merge_into(Some(EMPTY_PACKET), Some(v)));
    };
    if packet.len() > MAX_PACKET {
        return Some(packet.to_string());
    }
    let found = find(packet);
    if found.is_empty() && value.is_none() {
        return Some(packet.to_string());
    }
    let mut x = packet.to_string();
    for (r, _) in found.iter().rev() {
        x.replace_range(r.clone(), "");
    }
    let Some(v) = value else { return Some(x) };
    let Some(at) = rdf_end(&x) else { return Some(packet.to_string()) };
    let desc = format!(
        "  <rdf:Description rdf:about=\"\" xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" xmlns:pigment=\"{NAMESPACE}\">\n   <pigment:{PROPERTY}>{}</pigment:{PROPERTY}>\n  </rdf:Description>\n ",
        escape(&v.to_string())
    );
    x.insert_str(at, &desc);
    Some(x)
}

/// The XMP packet PSD export writes for type layer content `t` whose packet is `xmp`: the packet
/// with the type extras of `t` merged in (see [`merge_into`]).
pub fn packet_for(t: &TextLayer, xmp: Option<&str>) -> Option<String> {
    merge_into(xmp, write(t).as_ref())
}

/// The XMP packet PSD export writes for layer `l`: its own, with a type layer's extras merged in.
pub fn export_packet(l: &Layer) -> Option<Cow<'_, str>> {
    match &l.content {
        LayerContent::Text(t) => packet_for(t, l.xmp.as_deref()).map(Cow::Owned),
        _ => l.xmp.as_deref().map(Cow::Borrowed),
    }
}

/// Takes the type extras out of a type layer's imported XMP packet (the packet stays as it is, so
/// an unedited layer saves it back unchanged).
pub fn import_packet(l: &mut Layer) {
    if let (LayerContent::Text(t), Some(xmp)) = (&mut l.content, l.xmp.as_deref())
        && let Some(v) = read(xmp)
    {
        apply(t, &v);
    }
}

/// The export warning for a type layer whose list markers Photoshop will not draw.
pub fn export_warning(l: &Layer, t: &TextLayer) -> Option<String> {
    has_list(t).then(|| format!("layer \"{}\": Photoshop will not show its list markers (Pigment keeps the lists in the layer's metadata)", l.name))
}

#[cfg(test)]
#[path = "type_xmp_tests.rs"]
mod tests;
