//! What Nib asks the models. Every instruction here is Nib's own wording.

use serde::{Deserialize, Serialize};

use crate::palette::Palette;

/// What Text to Vector Graphic makes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VectorKind {
    /// One subject on its own, no background.
    #[default]
    Subject,
    /// A whole scene with its background.
    Scene,
    /// A simple, bold icon.
    Icon,
    /// A seamless tile.
    Pattern,
}

impl VectorKind {
    pub fn id(self) -> &'static str {
        match self {
            VectorKind::Subject => "subject",
            VectorKind::Scene => "scene",
            VectorKind::Icon => "icon",
            VectorKind::Pattern => "pattern",
        }
    }

    fn svg_brief(self) -> &'static str {
        match self {
            VectorKind::Subject => "a single subject on its own, centred, with no background shape behind it",
            VectorKind::Scene => "a complete scene that fills the whole canvas, background included",
            VectorKind::Icon => "a simple flat icon: bold shapes, at most six colours, centred, no background, readable at small sizes",
            VectorKind::Pattern => {
                "one seamless tile of a repeating pattern: it fills the whole canvas edge to edge, and whatever leaves one edge continues on the opposite edge so that copies placed side by side join without seams"
            }
        }
    }

    fn image_brief(self) -> &'static str {
        match self {
            VectorKind::Subject => "the subject alone on a plain pure white background, no shadow, no ground",
            VectorKind::Scene => "a full scene filling the frame",
            VectorKind::Icon => "a simple flat icon, bold shapes, few colours, on a plain pure white background",
            VectorKind::Pattern => "a seamless, tileable pattern that fills the frame edge to edge",
        }
    }
}

/// How much detail generated art has.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Detail {
    Low,
    #[default]
    Medium,
    High,
}

impl Detail {
    fn svg_brief(self) -> &'static str {
        match self {
            Detail::Low => "Keep it minimal: fewer than 30 shapes.",
            Detail::Medium => "Use moderate detail: roughly 30 to 120 shapes.",
            Detail::High => "Use rich detail: up to about 400 shapes.",
        }
    }

    fn image_brief(self) -> &'static str {
        match self {
            Detail::Low => "very simple, few large shapes",
            Detail::Medium => "moderately detailed",
            Detail::High => "richly detailed",
        }
    }
}

/// What the art is made for.
pub struct ArtBrief<'a> {
    pub prompt: &'a str,
    pub kind: VectorKind,
    pub detail: Detail,
    /// `#rrggbb` colours the art should use.
    pub palette: &'a [String],
    /// "square", "landscape 3:2"…
    pub aspect: &'a str,
    /// The canvas size in the viewBox.
    pub view: (u32, u32),
    /// A style reference image comes with the request.
    pub style_reference: bool,
    /// Shape Fill: the art is clipped to a shape, so it must reach every edge.
    pub full_bleed: bool,
}

pub const SVG_INSTRUCTIONS: &str = "You are an expert vector artist. Answer with exactly one complete, standalone SVG document and nothing else: no Markdown fences, no explanation. Use only these elements: svg, g, path, rect, circle, ellipse, line, polyline, polygon, defs, linearGradient, radialGradient, stop, clipPath. Do not use text, images, scripts, style elements, CSS classes, filters, masks, animation or any external reference. Give every shape its paint with fill and stroke attributes. Prefer closed paths with solid fills; keep coordinates within the viewBox.";

/// The prompt asking a text model for SVG art.
pub fn svg_prompt(b: &ArtBrief) -> String {
    let (w, h) = b.view;
    let mut p = format!(
        "Draw {} as vector art. Subject: {}\nCanvas: viewBox=\"0 0 {w} {h}\" ({}), with width=\"{w}\" and height=\"{h}\".\n{}",
        b.kind.svg_brief(),
        b.prompt.trim(),
        b.aspect,
        b.detail.svg_brief()
    );
    if b.full_bleed {
        p.push_str("\nThe art will be clipped to a shape: make it cover the entire canvas edge to edge, with no empty margin.");
    }
    if !b.palette.is_empty() {
        p.push_str(&format!("\nUse only these colours (and tints of them): {}.", b.palette.join(", ")));
    }
    if b.style_reference {
        p.push_str(
            "\nThe attached image is the person's own artwork: match its drawing style, line weight and colour mood, without copying its content.",
        );
    }
    p
}

/// The prompt asking an image model for art that Image Trace turns into paths.
pub fn trace_prompt(b: &ArtBrief) -> String {
    let mut p = format!(
        "Flat vector-style illustration of {}: {}. {}, {} composition. Clean geometric shapes, solid flat colours, crisp edges, no gradients, no texture, no photographic detail, no text or lettering.",
        b.prompt.trim(),
        b.kind.image_brief(),
        b.detail.image_brief(),
        b.aspect
    );
    if b.full_bleed {
        p.push_str(" The picture covers the whole frame edge to edge, with no empty margin.");
    }
    if !b.palette.is_empty() {
        p.push_str(&format!(" Use only these colours: {}.", b.palette.join(", ")));
    }
    if b.style_reference {
        p.push_str(" Match the drawing style and colour mood of the reference image, without copying its content.");
    }
    p
}

pub const PALETTE_INSTRUCTIONS: &str = "You are a colour designer for illustration and branding. Answer with a single JSON object and nothing else.";

/// The prompt asking for recolour palettes.
pub fn palette_prompt(prompt: &str, samples: &[String], current: &[String], count: usize, variations: usize) -> String {
    let mut p = format!(
        "The artwork currently uses these colours, most used first: {}.\nCreate {variations} different colour palettes for the artwork, each with exactly {count} colours, for this theme: {}.",
        if current.is_empty() { "(unknown)".to_string() } else { current.join(", ") },
        prompt.trim()
    );
    for s in samples.iter().filter(|s| !s.trim().is_empty()).take(8) {
        p.push_str(&format!("\nAlso consider: {}.", s.trim()));
    }
    p.push_str(
        "\nKeep enough contrast between the colours that the artwork stays readable. Order each palette's colours from darkest to lightest.\nAnswer as JSON: {\"palettes\": [{\"name\": \"short evocative name\", \"colors\": [\"#rrggbb\", …]}]}",
    );
    p
}

/// A palette hint for prompts, from a [`Palette`].
pub fn palette_words(p: &Palette) -> String {
    format!("{} ({})", p.name, p.colors.join(", "))
}

/// How Rewrite Text changes the text.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Tone {
    #[default]
    Shorter,
    Longer,
    Formal,
    Casual,
    FixSpelling,
    /// The person's own instruction.
    Custom(String),
}

impl Tone {
    pub fn instruction(&self) -> String {
        match self {
            Tone::Shorter => "Make it shorter and punchier while keeping its meaning.".into(),
            Tone::Longer => "Make it somewhat longer and more descriptive while keeping its meaning.".into(),
            Tone::Formal => "Make it more formal and professional.".into(),
            Tone::Casual => "Make it more casual and friendly.".into(),
            Tone::FixSpelling => {
                "Correct only spelling, grammar and punctuation mistakes; change nothing else, and keep it exactly as it is when it has none.".into()
            }
            Tone::Custom(s) => s.trim().to_string(),
        }
    }
}

pub const REWRITE_INSTRUCTIONS: &str = "You rewrite short texts used in graphic design (headlines, labels, body copy). Answer with a single JSON object and nothing else. Keep the language of the original text. Add no quotation marks, notes or commentary.";

/// The prompt asking for rewritten text; `segments` > 1 asks for the text split as the original's
/// styled runs are.
pub fn rewrite_prompt(tone: &Tone, segments: &[String]) -> String {
    let instruction = tone.instruction();
    if segments.len() <= 1 {
        let text = segments.first().map(String::as_str).unwrap_or_default();
        return format!(
            "{instruction}\nOriginal text:\n{}\nAnswer as JSON: {{\"text\": \"the rewritten text\"}}",
            serde_json::to_string(text).unwrap_or_default()
        );
    }
    format!(
        "{instruction}\nThe original text is split into {} segments, each with its own styling (font, size, colour), in reading order:\n{}\nAnswer as JSON: {{\"segments\": [...]}} with exactly {} strings. Segment i of the answer takes the styling of segment i of the original, so put each part of the rewrite in the segment whose styling suits it (a segment may become empty). Joined together, the segments are the whole rewritten text.",
        segments.len(),
        serde_json::to_string(segments).unwrap_or_default(),
        segments.len()
    )
}

/// The prompt for Generative Expand.
pub fn expand_prompt(prompt: &str) -> String {
    let mut p = String::from(
        "Extend this picture beyond its edges: fill the transparent area so that it continues the existing image seamlessly, with the same scene, style, lighting and perspective. Keep the existing part exactly as it is.",
    );
    if !prompt.trim().is_empty() {
        p.push_str(&format!(" In the new area: {}.", prompt.trim()));
    }
    p
}
