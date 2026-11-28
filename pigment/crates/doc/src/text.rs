//! Typed style model for type (text) layers: character runs, paragraph runs, point/box shape and
//! warp. Pure data; layout and rendering live in `photocraft-text`.
//!
//! Units follow Photoshop's Character/Paragraph panels: sizes, leading, indents and spacing are in
//! **points** (converted to pixels with the document resolution: `px = pt * dpi / 72`), tracking
//! is in 1/1000 em, and box bounds are in text-space **pixels** (before the layer transform).
//!
//! Runs cover the text by **UTF-8 byte length**, in order. A run list whose lengths don't add up
//! to `text.len()` is normalised by [`crate::TextLayer::char_runs`] (the last run is stretched or
//! truncated), so edits never produce unstyled text.

use photocraft_color::Color;
use serde::{Deserialize, Serialize};

/// Kerning mode (Photoshop: Metrics, Optical, 0).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Kerning {
    /// Font kerning (`kern` feature).
    #[default]
    Metrics,
    /// Photoshop's optical kerning: pair spacing computed from the glyph outlines.
    Optical,
    /// No automatic kerning (Photoshop's "0" / manual kerning).
    Off,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Caps {
    #[default]
    Normal,
    SmallCaps,
    AllCaps,
}

/// Superscript / subscript (Photoshop's `FontBaseline`). The run is drawn smaller and raised or
/// lowered; `size_pt` and `baseline_shift_pt` keep their own values.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum FontBaseline {
    #[default]
    Normal,
    Superscript,
    Subscript,
}

/// An OpenType feature setting, e.g. `{ tag: "ss01", value: 1 }`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FontFeature {
    pub tag: String,
    pub value: u16,
}

/// A variable-font axis setting, e.g. `{ axis: "wght", value: 650.0 }`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FontVariation {
    pub axis: String,
    pub value: f32,
}

/// Character style (Photoshop's Character panel).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CharStyle {
    /// Family name ("Inter"). Empty = the default family.
    pub font_family: String,
    /// Face style name as shown in the UI ("Bold Italic"); informational, `weight`/`italic` rule.
    pub font_style: String,
    /// PostScript name from a PSD (`ArialMT`), used to find the exact face when present.
    pub postscript_name: Option<String>,
    /// CSS-style weight, 100–900.
    pub weight: u16,
    pub italic: bool,
    pub size_pt: f32,
    pub color: Color,
    /// Letter spacing in 1/1000 em.
    pub tracking: f32,
    /// Baseline-to-baseline distance in points; `None` = auto (paragraph `auto_leading` × size).
    pub leading_pt: Option<f32>,
    /// Positive raises the text.
    pub baseline_shift_pt: f32,
    pub horizontal_scale: f32,
    pub vertical_scale: f32,
    pub underline: bool,
    pub strikethrough: bool,
    pub faux_bold: bool,
    pub faux_italic: bool,
    /// Automatic (pair) kerning mode.
    pub kerning: Kerning,
    /// Manual kerning in 1/1000 em between this character and the next one (Photoshop stores it
    /// per character run as `Kerning`). Added to the automatic kerning of the pair.
    pub kern: f32,
    pub caps: Caps,
    /// Superscript or subscript.
    pub baseline: FontBaseline,
    /// Standard ligatures (`liga`/`clig`).
    pub ligatures: bool,
    /// Discretionary ligatures (`dlig`).
    pub discretionary_ligatures: bool,
    /// Extra OpenType features (`ss01`, `onum`, `tnum`, …).
    pub features: Vec<FontFeature>,
    /// Variable-font axis values.
    pub variations: Vec<FontVariation>,
    /// BCP-47 language tag (affects shaping and line breaking).
    pub language: Option<String>,
    /// Vertical type: roman text (Latin, digits) runs rotated 90° clockwise along the column
    /// (PSD `BaselineDirection` 2) instead of standing upright one character per em
    /// (`BaselineDirection` 1, what Photoshop's Vertical Type tool sets, #9470). CJK text stands
    /// upright either way.
    pub rotate_roman: bool,
    /// No Break (Character panel menu): these characters never break across lines and are
    /// never hyphenated (PSD `NoBreak`).
    pub no_break: bool,
    /// Applied character style (id in [`crate::TextStyles`]); `None` = "None". Attributes above
    /// stay fully resolved; differences from the style are local overrides.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style_sheet: Option<u32>,
}

impl Default for CharStyle {
    fn default() -> Self {
        Self {
            font_family: String::new(),
            font_style: String::new(),
            postscript_name: None,
            weight: 400,
            italic: false,
            size_pt: 12.0,
            color: Color::BLACK,
            tracking: 0.0,
            leading_pt: None,
            baseline_shift_pt: 0.0,
            horizontal_scale: 1.0,
            vertical_scale: 1.0,
            underline: false,
            strikethrough: false,
            faux_bold: false,
            faux_italic: false,
            kerning: Kerning::Metrics,
            kern: 0.0,
            caps: Caps::Normal,
            baseline: FontBaseline::Normal,
            ligatures: true,
            discretionary_ligatures: false,
            features: Vec::new(),
            variations: Vec::new(),
            language: None,
            rotate_roman: false,
            no_break: false,
            style_sheet: None,
        }
    }
}

/// A character style applied to `len` UTF-8 bytes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TextRun {
    pub len: usize,
    pub style: CharStyle,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum TextAlign {
    #[default]
    Left,
    Center,
    Right,
    /// Justified, last line left.
    JustifyLeft,
    /// Justified, last line centered.
    JustifyCenter,
    /// Justified, last line right.
    JustifyRight,
    /// Justified including the last line.
    JustifyAll,
}

impl TextAlign {
    pub fn is_justified(self) -> bool {
        matches!(self, Self::JustifyLeft | Self::JustifyCenter | Self::JustifyRight | Self::JustifyAll)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum TextDirection {
    /// From the first strong character (Unicode bidi rules).
    #[default]
    Auto,
    Ltr,
    Rtl,
}

/// Paragraph style (Photoshop's Paragraph panel).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ParagraphStyle {
    pub align: TextAlign,
    pub first_line_indent_pt: f32,
    pub start_indent_pt: f32,
    pub end_indent_pt: f32,
    pub space_before_pt: f32,
    pub space_after_pt: f32,
    /// Auto leading as a multiple of the font size (Photoshop default 1.2).
    pub auto_leading: f32,
    pub direction: TextDirection,
    pub hyphenate: bool,
    /// The Hyphenation dialog's settings; [`Self::hyphenate`] stays the on/off.
    pub hyphenation: Hyphenation,
    /// The Justification dialog's word, letter and glyph spacing (Auto Leading is
    /// [`Self::auto_leading`]).
    pub justification: Justification,
    /// Adobe Single-line or Every-line Composer. A new paragraph gets Every-line, as in Photoshop;
    /// a document saved before the field existed reads as Single-line, so it keeps its breaks.
    #[serde(default = "legacy_composer")]
    pub composer: Composer,
    /// Roman Hanging Punctuation.
    pub hanging_punctuation: bool,
    /// Bulleted or numbered list; `None` = not a list item.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub list: Option<ListStyle>,
    /// Applied paragraph style (id in [`crate::TextStyles`]); `None` = Basic Paragraph.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style_sheet: Option<u32>,
}

/// The composer of a paragraph that has no `composer` field: one saved before the field existed
/// was laid out greedily, line by line, which is what Single-line does.
fn legacy_composer() -> Composer {
    Composer::SingleLine
}

/// Adobe's two paragraph composers (Paragraph panel menu). The JSON names (`singleLine`,
/// `everyLine`) are also `type.setStyle`'s values.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Composer {
    /// Adobe Single-line Composer: each line broken on its own.
    SingleLine,
    /// Adobe Every-line Composer: the breaks of the whole paragraph chosen together.
    #[default]
    EveryLine,
}

/// The Hyphenation dialog (Paragraph panel menu › Hyphenation…). Ranges are Photoshop's; the
/// engine rejects values outside them. The JSON field names are `type.setStyle`'s
/// `"hyphenation"` keys, so a model value and a command value read the same.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Hyphenation {
    /// Words Longer Than _ letters (2..=25; PSD `HyphenatedWordSize`).
    pub words_longer_than: u8,
    /// After First _ letters (1..=15; PSD `PreHyphen`).
    pub after_first: u8,
    /// Before Last _ letters (1..=15; PSD `PostHyphen`).
    pub before_last: u8,
    /// Hyphen Limit _ hyphens in a row (0..=25, 0 = no limit; PSD `ConsecutiveHyphens`).
    pub hyphen_limit: u8,
    /// Hyphenation Zone in points (ragged text; PSD `Zone`).
    #[serde(rename = "zone")]
    pub zone_pt: f32,
    /// Hyphenate Capitalized Words.
    pub capitalized: bool,
    /// Hyphenate Last Word.
    pub last_word: bool,
    /// Hyphenate Across Column (stored only: PhotoCraft type has no columns).
    pub across_column: bool,
}

impl Hyphenation {
    pub const WORDS_LONGER_THAN: std::ops::RangeInclusive<u8> = 2..=25;
    pub const AFTER_FIRST: std::ops::RangeInclusive<u8> = 1..=15;
    pub const BEFORE_LAST: std::ops::RangeInclusive<u8> = 1..=15;
    pub const HYPHEN_LIMIT: std::ops::RangeInclusive<u8> = 0..=25;
    /// Hyphenation Zone range in points (0 to 120 inches).
    pub const ZONE_PT: std::ops::RangeInclusive<f32> = 0.0..=8640.0;
}

impl Default for Hyphenation {
    /// The ParagraphSheet values Photoshop files commonly hold: HyphenatedWordSize 6, PreHyphen 2,
    /// PostHyphen 2, ConsecutiveHyphens 8, Zone 36, capitalized words, last word and across column
    /// on. Not yet checked against a Photoshop 2026 sample.
    fn default() -> Self {
        Self { words_longer_than: 6, after_first: 2, before_last: 2, hyphen_limit: 8, zone_pt: 36.0, capitalized: true, last_word: true, across_column: true }
    }
}

/// How a justified line with a single word aligns (Justification dialog).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SingleWord {
    /// Full Justify: the word's letters spread to both edges.
    #[default]
    Justify,
    Left,
    Center,
    Right,
}

/// The Justification dialog: minimum, desired and maximum spacing, in percent. The JSON field
/// names are `type.setStyle`'s `"justification"` keys.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Justification {
    /// Word Spacing, % of the space's width (0..=1000; PSD `WordSpacing`, as fractions).
    #[serde(rename = "wordSpacing")]
    pub word: [f32; 3],
    /// Letter Spacing, % of a space (-100..=500; PSD `LetterSpacing`).
    #[serde(rename = "letterSpacing")]
    pub letter: [f32; 3],
    /// Glyph Scaling, % of the glyph's width (50..=200; PSD `GlyphSpacing`).
    #[serde(rename = "glyphScaling")]
    pub glyph: [f32; 3],
    #[serde(rename = "singleWord")]
    pub single_word: SingleWord,
}

impl Justification {
    pub const WORD: std::ops::RangeInclusive<f32> = 0.0..=1000.0;
    pub const LETTER: std::ops::RangeInclusive<f32> = -100.0..=500.0;
    pub const GLYPH: std::ops::RangeInclusive<f32> = 50.0..=200.0;
}

impl Default for Justification {
    /// Photoshop's defaults: words 80/100/133 %, letters 0/0/0 %, glyphs 100/100/100 %.
    fn default() -> Self {
        Self { word: [80.0, 100.0, 133.0], letter: [0.0; 3], glyph: [100.0; 3], single_word: SingleWord::Justify }
    }
}

/// A bulleted or numbered list item.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ListKind {
    #[default]
    Bullet,
    Number,
}

/// The numbering styles of a numbered list (the `marker` of a [`ListKind::Number`] list).
pub const LIST_NUMBER_STYLES: [&str; 5] = ["decimal", "lowerAlpha", "upperAlpha", "lowerRoman", "upperRoman"];

/// A paragraph's list settings: Photoshop's Paragraph panel list controls. The JSON shape is
/// `type.setStyle`'s `"list"` value: `{"type":"bullet|number","marker","start","level"}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ListStyle {
    #[serde(rename = "type")]
    pub kind: ListKind,
    /// The bullet character for a bulleted list, or one of [`LIST_NUMBER_STYLES`] for a numbered one.
    pub marker: String,
    /// The number of the first item (0..=9999).
    pub start: u32,
    /// Nesting level, 0 (top) ..= 8.
    pub level: u8,
}

impl ListStyle {
    pub const MAX_START: u32 = 9999;
    pub const MAX_LEVEL: u8 = 8;

    /// A list of `kind` with its default marker ("•" or decimal), starting at 1, at the top level.
    pub fn new(kind: ListKind) -> Self {
        Self { marker: Self::default_marker(kind).into(), kind, start: 1, level: 0 }
    }

    /// The marker a new list of `kind` gets.
    pub fn default_marker(kind: ListKind) -> &'static str {
        match kind {
            ListKind::Bullet => "\u{2022}",
            ListKind::Number => "decimal",
        }
    }
}

impl Default for ListStyle {
    fn default() -> Self {
        Self::new(ListKind::Bullet)
    }
}

impl Default for ParagraphStyle {
    fn default() -> Self {
        Self {
            align: TextAlign::Left,
            first_line_indent_pt: 0.0,
            start_indent_pt: 0.0,
            end_indent_pt: 0.0,
            space_before_pt: 0.0,
            space_after_pt: 0.0,
            auto_leading: 1.2,
            direction: TextDirection::Auto,
            hyphenate: false,
            hyphenation: Hyphenation::default(),
            justification: Justification::default(),
            composer: Composer::EveryLine,
            hanging_punctuation: false,
            list: None,
            style_sheet: None,
        }
    }
}

/// A paragraph style applied to `len` UTF-8 bytes (whole paragraphs, including the break).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ParagraphRun {
    pub len: usize,
    pub style: ParagraphStyle,
}

/// Point text grows from its anchor (text-space origin = first baseline at the anchor);
/// paragraph (box) text wraps inside a rectangle; path text runs along a curve; area text
/// wraps inside a closed path.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub enum TextShape {
    #[default]
    Point,
    /// Text-space pixels, before the layer transform.
    Box { x: f32, y: f32, width: f32, height: f32 },
    /// Type on a path: one line laid out like point text, then each glyph is placed on `path`
    /// (text-space pixels, before the layer transform) by arc length and turned to follow the
    /// curve. `start` is the arc-length offset (px) of the text origin along the path; `flip`
    /// puts the text on the other side of the path.
    Path {
        path: super::vector::Subpath,
        start: f32,
        /// Unwrapped arc-length end offset in text-space pixels, measured in the current
        /// travel direction (`flip` reverses that direction). It may exceed the path length
        /// on closed paths: for a 100 px loop, start 80 and end 120 cross the seam by 20 px.
        /// End equal to start is empty; start plus the path length permits one full lap.
        /// `None` preserves legacy unbounded clipping and alignment around the start anchor.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        end: Option<f32>,
        flip: bool,
    },
    /// Area type: paragraph text that wraps inside the closed subpaths of `path` (text-space
    /// pixels, before the layer transform), combined with their path operations and fill rule.
    /// Text that doesn't fit is hidden, as in a text box.
    Area { path: super::vector::Path },
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Orientation {
    #[default]
    Horizontal,
    /// Vertical type (tategaki): columns top to bottom, advancing right to left.
    Vertical,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum AntiAlias {
    None,
    Sharp,
    Crisp,
    Strong,
    #[default]
    Smooth,
    /// Photoshop's "Windows" (platform grayscale) anti-aliasing; rendered like `Sharp`.
    Windows,
    /// Photoshop's "Windows LCD" (platform subpixel) anti-aliasing; rendered like `Sharp` (we
    /// never produce colour-fringed subpixel text in document pixels).
    WindowsLcd,
}

/// Warp text settings (Photoshop `warp` descriptor), applied to the glyph outlines by
/// `photocraft-text` (see its `warp` module) and round-tripped through PSD.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct TextWarp {
    /// `warpNone`, `warpArc`, `warpFlag`, …
    pub style: String,
    /// Bend in percent (-100..100).
    pub value: f32,
    pub horizontal_distortion: f32,
    pub vertical_distortion: f32,
    /// Horizontal (true) or vertical warp axis.
    pub horizontal: bool,
}

#[cfg(test)]
#[path = "text_pigment_tests.rs"]
mod pigment_tests;

#[cfg(test)]
mod tests {
    /// Ensures `TextShape::Path` serializes backward-compatibly without an `"end"` field when `end` is `None`.
    #[test]
    fn path_end_is_backward_compatible() {
        let shape = super::TextShape::Path { path: Default::default(), start: 2.0, end: None, flip: false };
        let value = serde_json::to_value(&shape).unwrap();
        assert!(value.get("Path").unwrap().get("end").is_none());
        assert_eq!(serde_json::from_value::<super::TextShape>(value).unwrap(), shape);
    }

    use super::*;
    use crate::TextLayer;

    fn run(len: usize, size: f32) -> TextRun {
        TextRun { len, style: CharStyle { size_pt: size, ..Default::default() } }
    }

    #[test]
    fn runs_are_normalized_to_the_text() {
        let base = TextLayer { text: "héllo".into(), size_pt: 9.0, ..Default::default() };
        // No runs: one run from the summary fields.
        let r = base.char_runs();
        assert_eq!(r.len(), 1);
        assert_eq!((r[0].len, r[0].style.size_pt), (6, 9.0));
        // Too short: last run stretched. Split inside 'é' snaps to the char boundary.
        let t = TextLayer { runs: vec![run(2, 10.0), run(1, 20.0)], ..base.clone() };
        let r = t.char_runs();
        assert_eq!(r.iter().map(|r| r.len).collect::<Vec<_>>(), vec![3, 3]);
        // Too long: truncated; empty runs dropped.
        let t = TextLayer { runs: vec![run(0, 1.0), run(100, 10.0), run(5, 20.0)], ..base.clone() };
        let r = t.char_runs();
        assert_eq!(r.len(), 1);
        assert_eq!((r[0].len, r[0].style.size_pt), (6, 10.0));
        // Empty text keeps the first run's style.
        let t = TextLayer { text: String::new(), runs: vec![run(0, 33.0)], ..base.clone() };
        assert_eq!(t.char_runs()[0].style.size_pt, 33.0);
        assert_eq!(t.paragraph_runs().len(), 1);
    }

    #[test]
    fn summary_follows_first_run() {
        let mut t = TextLayer {
            text: "ab".into(),
            runs: vec![TextRun { len: 2, style: CharStyle { font_family: "X".into(), size_pt: 7.0, ..Default::default() } }],
            ..Default::default()
        };
        t.sync_summary();
        assert_eq!((t.font_family.as_str(), t.size_pt), ("X", 7.0));
    }

    #[test]
    fn styles_serialize() {
        let s = CharStyle { features: vec![FontFeature { tag: "ss01".into(), value: 1 }], ..Default::default() };
        let v = serde_json::to_value(&s).unwrap();
        let back: CharStyle = serde_json::from_value(v).unwrap();
        assert_eq!(back, s);
        // Missing keys take defaults.
        let p: ParagraphStyle = serde_json::from_str(r#"{"align":"Center"}"#).unwrap();
        assert_eq!((p.align, p.auto_leading), (TextAlign::Center, 1.2));
    }
}
