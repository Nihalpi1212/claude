//! The SVG a model writes is untrusted. [`sanitize_svg`] parses it and writes a new document from
//! an allowlist of drawing elements and presentation attributes, so what reaches Nib's SVG importer
//! has no scripts, event handlers, external references (`href`s and `url()`s that don't point
//! inside the document), `foreignObject`, embedded images, animations, CSS or entities, and stays
//! within size limits. Anything not on the list is dropped, not repaired.

use std::fmt::Write as _;

use crate::{AiError, Result};

/// Longest SVG text accepted from a model.
pub const MAX_SVG_BYTES: usize = 2 * 1024 * 1024;
/// Most elements kept.
pub const MAX_ELEMENTS: usize = 20_000;
/// Deepest nesting kept.
pub const MAX_DEPTH: usize = 32;
/// Largest absolute coordinate or size accepted in `width`, `height` and `viewBox`.
pub const MAX_EXTENT: f64 = 100_000.0;

/// Elements kept, with their children.
const ELEMENTS: &[&str] = &[
    "svg",
    "g",
    "defs",
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "linearGradient",
    "radialGradient",
    "stop",
    "clipPath",
    "use",
    "symbol",
    "text",
    "tspan",
];

/// Elements whose children are kept without them (a link's art stays, the link goes).
const UNWRAP: &[&str] = &["a", "switch"];

/// Attributes kept on any element.
const ATTRIBUTES: &[&str] = &[
    "id",
    "d",
    "x",
    "y",
    "width",
    "height",
    "rx",
    "ry",
    "cx",
    "cy",
    "r",
    "x1",
    "y1",
    "x2",
    "y2",
    "points",
    "fill",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-miterlimit",
    "stroke-dasharray",
    "stroke-dashoffset",
    "fill-rule",
    "clip-rule",
    "opacity",
    "fill-opacity",
    "stroke-opacity",
    "transform",
    "viewBox",
    "preserveAspectRatio",
    "offset",
    "stop-color",
    "stop-opacity",
    "gradientUnits",
    "gradientTransform",
    "spreadMethod",
    "fx",
    "fy",
    "fr",
    "clip-path",
    "clipPathUnits",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "text-anchor",
    "dominant-baseline",
    "letter-spacing",
    "dx",
    "dy",
    "visibility",
    "display",
    "color",
    "paint-order",
    "vector-effect",
];

/// CSS properties kept from a `style` attribute (as attributes).
const STYLE_PROPERTIES: &[&str] = &[
    "fill",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-miterlimit",
    "stroke-dasharray",
    "stroke-dashoffset",
    "fill-rule",
    "clip-rule",
    "opacity",
    "fill-opacity",
    "stroke-opacity",
    "stop-color",
    "stop-opacity",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "text-anchor",
    "visibility",
    "display",
    "clip-path",
];

const SVG_NS: &str = "http://www.w3.org/2000/svg";

/// The SVG part of a model's answer: from the first `<svg` to the last `</svg>` (models wrap it in
/// Markdown fences or prose).
pub fn extract_svg(text: &str) -> Option<&str> {
    let start = text.find("<svg")?;
    let end = text.rfind("</svg>")? + "</svg>".len();
    text.get(start..end)
}

/// A safe, standalone SVG from `text` (a model's answer), or why there is none.
pub fn sanitize_svg(text: &str) -> Result<String> {
    if text.len() > MAX_SVG_BYTES {
        return Err(AiError::bad_response("The model's SVG is too large."));
    }
    if text.contains("<!DOCTYPE") || text.contains("<!ENTITY") {
        return Err(AiError::bad_response("The model's SVG declares a DTD or entities, which Nib does not read."));
    }
    let svg = extract_svg(text).ok_or_else(|| AiError::bad_response("The model's answer has no SVG in it."))?;
    let opts = roxmltree::ParsingOptions { allow_dtd: false, nodes_limit: (MAX_ELEMENTS * 4) as u32, entity_resolver: None };
    let doc = roxmltree::Document::parse_with_options(svg, opts)
        .map_err(|e| AiError::bad_response(format!("The model's SVG is not well-formed XML ({e}).")))?;
    let root = doc.root_element();
    if root.tag_name().name() != "svg" {
        return Err(AiError::bad_response("The model's answer is not an SVG."));
    }
    let mut w = Writer { out: String::with_capacity(svg.len()), elements: 0, drawn: 0 };
    w.element(root, 0, true)?;
    if w.drawn == 0 {
        return Err(AiError::bad_response("The model's SVG has nothing to draw."));
    }
    Ok(w.out)
}

struct Writer {
    out: String,
    elements: usize,
    /// Shapes and text kept.
    drawn: usize,
}

fn is_svg_ns(n: roxmltree::Node) -> bool {
    matches!(n.tag_name().namespace(), None | Some(SVG_NS))
}

impl Writer {
    fn element(&mut self, n: roxmltree::Node, depth: usize, root: bool) -> Result<()> {
        if depth > MAX_DEPTH {
            return Err(AiError::bad_response("The model's SVG is nested too deeply."));
        }
        let name = n.tag_name().name();
        if !is_svg_ns(n) {
            return Ok(());
        }
        if UNWRAP.contains(&name) {
            return self.children(n, depth);
        }
        if !ELEMENTS.contains(&name) {
            return Ok(());
        }
        self.elements += 1;
        if self.elements > MAX_ELEMENTS {
            return Err(AiError::bad_response("The model's SVG has too many elements."));
        }
        if matches!(name, "path" | "rect" | "circle" | "ellipse" | "line" | "polyline" | "polygon" | "text" | "use") {
            self.drawn += 1;
        }
        self.out.push('<');
        self.out.push_str(name);
        if root {
            let _ = write!(self.out, " xmlns=\"{SVG_NS}\"");
        }
        let attrs = attributes(n, root)?;
        for (k, v) in &attrs {
            let _ = write!(self.out, " {k}=\"{}\"", escape(v));
        }
        self.out.push('>');
        if matches!(name, "text" | "tspan") {
            for c in n.children().filter(|c| c.is_text()) {
                self.out.push_str(&escape(c.text().unwrap_or_default()));
            }
        }
        self.children(n, depth)?;
        let _ = write!(self.out, "</{name}>");
        Ok(())
    }

    fn children(&mut self, n: roxmltree::Node, depth: usize) -> Result<()> {
        for c in n.children().filter(roxmltree::Node::is_element) {
            self.element(c, depth + 1, false)?;
        }
        Ok(())
    }
}

/// The element's kept attributes (style properties included), in order.
fn attributes(n: roxmltree::Node, root: bool) -> Result<Vec<(String, String)>> {
    let mut out: Vec<(String, String)> = vec![];
    let mut push = |k: &str, v: &str| {
        if let Some(v) = clean_value(k, v)
            && !out.iter().any(|(e, _)| e == k)
        {
            out.push((k.to_string(), v));
        }
    };
    for a in n.attributes() {
        let (ns, k, v) = (a.namespace(), a.name(), a.value());
        if k == "href" && matches!(ns, None | Some("http://www.w3.org/1999/xlink")) {
            // Only a reference to an element of this document.
            if n.tag_name().name() == "use" && local_ref(v) {
                push("href", v);
            }
            continue;
        }
        if ns.is_some() {
            continue;
        }
        if k == "style" {
            for decl in v.split(';') {
                if let Some((p, val)) = decl.split_once(':') {
                    let p = p.trim();
                    if STYLE_PROPERTIES.contains(&p) {
                        push(p, val.trim());
                    }
                }
            }
        } else if ATTRIBUTES.contains(&k) {
            push(k, v);
        }
    }
    if root {
        check_extent(&out)?;
    }
    Ok(out)
}

/// `#id` (an element of this document).
fn local_ref(v: &str) -> bool {
    v.trim()
        .strip_prefix('#')
        .is_some_and(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':')))
}

/// The value, or `None` when it must go: `url()` other than `url(#id)`, script-like or control
/// characters, absurd lengths.
fn clean_value(k: &str, v: &str) -> Option<String> {
    let max = if matches!(k, "d" | "points") { 1024 * 1024 } else { 4096 };
    if v.len() > max || v.chars().any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t')) {
        return None;
    }
    let lower = v.to_ascii_lowercase();
    if lower.contains("javascript:") || lower.contains("expression(") || lower.contains('<') || lower.contains("@import") {
        return None;
    }
    // Every url( must be url(#id).
    let mut rest = lower.as_str();
    while let Some(i) = rest.find("url(") {
        let inner = rest.get(i + 4..)?;
        let end = inner.find(')')?;
        let target = inner.get(..end)?.trim().trim_matches(['"', '\'']);
        if !local_ref(target) {
            return None;
        }
        rest = inner.get(end..)?;
    }
    Some(v.trim().to_string())
}

/// Refuses a root `width`, `height` or `viewBox` that isn't a finite size within [`MAX_EXTENT`].
fn check_extent(attrs: &[(String, String)]) -> Result<()> {
    let bad = || AiError::bad_response("The model's SVG has an impossible size.");
    for (k, v) in attrs {
        let numbers: Vec<f64> = match k.as_str() {
            "width" | "height" => {
                let t = v.trim().trim_end_matches("px").trim_end_matches("pt").trim();
                if t.ends_with('%') {
                    continue;
                }
                vec![t.parse::<f64>().map_err(|_| bad())?]
            }
            "viewBox" => {
                let n: Vec<f64> =
                    v.split([' ', ',']).filter(|s| !s.is_empty()).map(|s| s.parse::<f64>().map_err(|_| bad())).collect::<Result<_>>()?;
                if n.len() != 4 || n.get(2).is_some_and(|w| *w <= 0.0) || n.get(3).is_some_and(|h| *h <= 0.0) {
                    return Err(bad());
                }
                n
            }
            _ => continue,
        };
        if numbers.iter().any(|x| !x.is_finite() || x.abs() > MAX_EXTENT) {
            return Err(bad());
        }
    }
    Ok(())
}

fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}
