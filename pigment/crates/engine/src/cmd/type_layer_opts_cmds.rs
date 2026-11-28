//! Pigment: the Character and Paragraph panel menus' toggles as commands (PORTS-B B1), and the
//! `type.setStyle` / `type.edit` keys of the type settings Pigment adds to the model: No Break,
//! hyphenation and justification settings, the composer, Roman Hanging Punctuation, lists, and the
//! layer's Fractional Widths and System Layout.
//!
//! Every toggle is one journaled history step on the Character panel's targets (the selected type
//! layers, or one layer and a character range), so it records into Actions and runs from the CLI
//! and MCP. An omitted `on` toggles from the style where the edit starts, as `type.openType.*` do.

use photocraft_doc::text::{
    Caps, CharStyle, Composer, FontBaseline, Hyphenation, Justification, LIST_NUMBER_STYLES, ListKind, ListStyle, ParagraphStyle, SingleWord,
};
use photocraft_doc::{LayerContent, TextLayer};
use serde_json::{Value, json};

use crate::commands::CommandSpec;
use crate::type_cmds::{format_targets, has_format_target, style_paragraphs, style_range, with_text_targets};
use crate::{EngineError, Result, Session};

fn bad(cmd: &str, msg: impl Into<String>) -> EngineError {
    EngineError::BadParams { cmd: cmd.into(), msg: msg.into() }
}

// ---------- the keys ----------

/// The `"hyphenation"` object's integer keys: key, the field's range.
const HYPHENATION_INTS: [(&str, std::ops::RangeInclusive<u8>); 4] = [
    ("wordsLongerThan", Hyphenation::WORDS_LONGER_THAN),
    ("afterFirst", Hyphenation::AFTER_FIRST),
    ("beforeLast", Hyphenation::BEFORE_LAST),
    ("hyphenLimit", Hyphenation::HYPHEN_LIMIT),
];
const HYPHENATION_BOOLS: [&str; 3] = ["capitalized", "lastWord", "acrossColumn"];
/// The `"justification"` object's triples: key, the range of its percentages.
const JUSTIFICATION_TRIPLES: [(&str, std::ops::RangeInclusive<f32>); 3] =
    [("wordSpacing", Justification::WORD), ("letterSpacing", Justification::LETTER), ("glyphScaling", Justification::GLYPH)];

fn single_word(v: &str) -> Option<SingleWord> {
    Some(match v {
        "justify" => SingleWord::Justify,
        "left" => SingleWord::Left,
        "center" => SingleWord::Center,
        "right" => SingleWord::Right,
        _ => return None,
    })
}

fn composer(v: &str) -> Option<Composer> {
    match v {
        "singleLine" => Some(Composer::SingleLine),
        "everyLine" => Some(Composer::EveryLine),
        _ => None,
    }
}

fn triple(v: &Value) -> Option<[f32; 3]> {
    let a = v.as_array().filter(|a| a.len() == 3)?;
    let mut out = [0.0f32; 3];
    for (o, x) in out.iter_mut().zip(a) {
        *o = x.as_f64().map(|x| x as f32).filter(|x| x.is_finite())?;
    }
    Some(out)
}

fn check_list(l: &Value) -> std::result::Result<(), String> {
    let Some(o) = l.as_object() else {
        return if l.is_null() { Ok(()) } else { Err("list must be null or {\"type\":\"bullet|number\",\"marker\",\"start\",\"level\"}".into()) };
    };
    let kind = match o.get("type").map(|v| v.as_str()) {
        None | Some(Some("bullet")) => ListKind::Bullet,
        Some(Some("number")) => ListKind::Number,
        _ => return Err("list.type must be \"bullet\" or \"number\"".into()),
    };
    if let Some(m) = o.get("marker") {
        let ok = match (kind, m.as_str()) {
            (ListKind::Number, Some(m)) => LIST_NUMBER_STYLES.contains(&m),
            (ListKind::Bullet, Some(m)) => (1..=2).contains(&m.chars().count()) && !m.chars().any(char::is_control),
            _ => false,
        };
        if !ok {
            return Err(match kind {
                ListKind::Number => format!("list.marker of a numbered list must be one of {}", LIST_NUMBER_STYLES.join(", ")),
                ListKind::Bullet => "list.marker of a bulleted list must be one or two characters".into(),
            });
        }
    }
    if let Some(v) = o.get("start")
        && !v.as_u64().is_some_and(|n| n <= u64::from(ListStyle::MAX_START))
    {
        return Err(format!("list.start must be a whole number from 0 to {}", ListStyle::MAX_START));
    }
    if let Some(v) = o.get("level")
        && !v.as_u64().is_some_and(|n| n <= u64::from(ListStyle::MAX_LEVEL))
    {
        return Err(format!("list.level must be a whole number from 0 to {}", ListStyle::MAX_LEVEL));
    }
    Ok(())
}

/// Validates the keys this module adds (out of range is an error, never a clamp): `noBreak`,
/// `hyphenation`, `justification`, `composer`, `hangingPunctuation`, `list`, `fractionalWidths`,
/// `systemLayout`. Called from `type_cmds::check_size_tracking`.
pub(crate) fn check_extra(p: &Value) -> std::result::Result<(), String> {
    for key in ["noBreak", "hangingPunctuation", "fractionalWidths", "systemLayout"] {
        if p.get(key).is_some_and(|v| !v.is_boolean()) {
            return Err(format!("{key} must be true or false"));
        }
    }
    if let Some(h) = p.get("hyphenation") {
        let o = h.as_object().ok_or("hyphenation must be an object")?;
        for (key, range) in HYPHENATION_INTS {
            if let Some(v) = o.get(key)
                && !v.as_u64().and_then(|n| u8::try_from(n).ok()).is_some_and(|n| range.contains(&n))
            {
                return Err(format!("hyphenation.{key} must be a whole number from {} to {}", range.start(), range.end()));
            }
        }
        if let Some(v) = o.get("zone")
            && !v.as_f64().is_some_and(|z| Hyphenation::ZONE_PT.contains(&(z as f32)))
        {
            return Err(format!("hyphenation.zone must be from {} to {} pt", Hyphenation::ZONE_PT.start(), Hyphenation::ZONE_PT.end()));
        }
        for key in HYPHENATION_BOOLS {
            if o.get(key).is_some_and(|v| !v.is_boolean()) {
                return Err(format!("hyphenation.{key} must be true or false"));
            }
        }
    }
    if let Some(j) = p.get("justification") {
        let o = j.as_object().ok_or("justification must be an object")?;
        for (key, range) in JUSTIFICATION_TRIPLES {
            let Some(v) = o.get(key) else { continue };
            let t = triple(v).ok_or_else(|| format!("justification.{key} must be [minimum, desired, maximum] in %"))?;
            if !t.iter().all(|x| range.contains(x)) {
                return Err(format!("justification.{key} values must be from {} to {} %", range.start(), range.end()));
            }
            if !(t[0] <= t[1] && t[1] <= t[2]) {
                return Err(format!("justification.{key}: the minimum must not exceed the desired value, nor the desired the maximum"));
            }
        }
        if let Some(v) = o.get("singleWord")
            && v.as_str().and_then(single_word).is_none()
        {
            return Err("justification.singleWord must be \"justify\", \"left\", \"center\" or \"right\"".into());
        }
    }
    if let Some(v) = p.get("composer")
        && v.as_str().and_then(composer).is_none()
    {
        return Err("composer must be \"singleLine\" or \"everyLine\"".into());
    }
    if let Some(l) = p.get("list") {
        check_list(l)?;
    }
    Ok(())
}

/// The list a `"list"` object makes: its keys over a new list of its type (a `"list"` value
/// replaces the paragraph's list, as the JavaScript app's did).
fn list_of(v: &Value) -> Option<ListStyle> {
    let o = v.as_object()?;
    let kind = if o.get("type").and_then(Value::as_str) == Some("number") { ListKind::Number } else { ListKind::Bullet };
    let mut l = ListStyle::new(kind);
    if let Some(m) = o.get("marker").and_then(Value::as_str) {
        l.marker = m.to_string();
    }
    if let Some(n) = o.get("start").and_then(Value::as_u64) {
        l.start = u32::try_from(n.min(u64::from(ListStyle::MAX_START))).unwrap_or(ListStyle::MAX_START);
    }
    if let Some(n) = o.get("level").and_then(Value::as_u64) {
        l.level = u8::try_from(n.min(u64::from(ListStyle::MAX_LEVEL))).unwrap_or(ListStyle::MAX_LEVEL);
    }
    Some(l)
}

/// Applies the paragraph keys this module adds (a partial `hyphenation` or `justification` object
/// merges into the paragraph's own). Returns true if any key was present. Values are expected to
/// have passed [`check_extra`]; one that didn't is skipped.
pub(crate) fn apply_para_extra(s: &mut ParagraphStyle, p: &Value) -> bool {
    let mut any = false;
    if let Some(o) = p.get("hyphenation").and_then(Value::as_object) {
        let h = &mut s.hyphenation;
        for (key, range) in HYPHENATION_INTS {
            let Some(n) = o.get(key).and_then(Value::as_u64).and_then(|n| u8::try_from(n).ok()).filter(|n| range.contains(n)) else { continue };
            match key {
                "wordsLongerThan" => h.words_longer_than = n,
                "afterFirst" => h.after_first = n,
                "beforeLast" => h.before_last = n,
                _ => h.hyphen_limit = n,
            }
        }
        if let Some(z) = o.get("zone").and_then(Value::as_f64).map(|z| z as f32).filter(|z| Hyphenation::ZONE_PT.contains(z)) {
            h.zone_pt = z;
        }
        for (key, field) in [("capitalized", &mut h.capitalized), ("lastWord", &mut h.last_word), ("acrossColumn", &mut h.across_column)] {
            if let Some(b) = o.get(key).and_then(Value::as_bool) {
                *field = b;
            }
        }
        any = true;
    }
    if let Some(o) = p.get("justification").and_then(Value::as_object) {
        let j = &mut s.justification;
        for ((key, range), field) in JUSTIFICATION_TRIPLES.into_iter().zip([&mut j.word, &mut j.letter, &mut j.glyph]) {
            if let Some(t) = o.get(key).and_then(triple).filter(|t| t.iter().all(|x| range.contains(x)) && t[0] <= t[1] && t[1] <= t[2]) {
                *field = t;
            }
        }
        if let Some(w) = o.get("singleWord").and_then(Value::as_str).and_then(single_word) {
            j.single_word = w;
        }
        any = true;
    }
    if let Some(c) = p.get("composer").and_then(Value::as_str).and_then(composer) {
        s.composer = c;
        any = true;
    }
    if let Some(b) = p.get("hangingPunctuation").and_then(Value::as_bool) {
        s.hanging_punctuation = b;
        any = true;
    }
    match p.get("list") {
        Some(Value::Null) => {
            s.list = None;
            any = true;
        }
        Some(v) if check_list(v).is_ok() => {
            s.list = list_of(v);
            any = true;
        }
        _ => {}
    }
    any
}

/// Applies `type.edit`'s layer keys `fractionalWidths` and `systemLayout`.
pub(crate) fn apply_layer_keys(t: &mut TextLayer, p: &Value) {
    if let Some(b) = p.get("fractionalWidths").and_then(Value::as_bool) {
        t.fractional_widths = b;
    }
    if let Some(b) = p.get("systemLayout").and_then(Value::as_bool) {
        t.system_layout = b;
    }
}

// ---------- the commands ----------

/// The character where an edit on `p`'s targets starts: the range start on one layer, else 0.
fn start_char(p: &Value) -> usize {
    if p.get("layers").is_none() || p.get("layer").is_some() {
        p.get("range").and_then(Value::as_array).filter(|r| r.len() == 2).map_or(0, |r| {
            let a = r.first().and_then(Value::as_u64).unwrap_or(0);
            let b = r.get(1).and_then(Value::as_u64).unwrap_or(a);
            usize::try_from(a.min(b)).unwrap_or(usize::MAX)
        })
    } else {
        0
    }
}

/// The layer whose state an omitted `on` toggles from: the active layer when it is a target, else
/// the first target.
fn representative<'a>(s: &'a Session, p: &Value) -> Result<&'a TextLayer> {
    let ids = format_targets(s, p)?;
    let st = s.active().ok_or(EngineError::NoDocument)?;
    let id = st.active_layer.filter(|id| ids.contains(id)).or_else(|| ids.first().copied()).ok_or(EngineError::NoDocument)?;
    match st.doc.layer(id).map(|l| &l.content) {
        Some(LayerContent::Text(t)) => Ok(t),
        _ => Err(EngineError::NoLayer(id)),
    }
}

fn byte_at(text: &str, ci: usize) -> usize {
    text.char_indices().nth(ci).map_or(text.len(), |(b, _)| b)
}

/// The character style at character `ci` (past the end: the last run's).
fn char_style_at(t: &TextLayer, ci: usize) -> CharStyle {
    let at = byte_at(&t.text, ci);
    let mut end = 0usize;
    let runs = t.char_runs();
    for r in &runs {
        end = end.saturating_add(r.len);
        if at < end {
            return r.style.clone();
        }
    }
    runs.last().map(|r| r.style.clone()).unwrap_or_default()
}

/// The paragraph style at character `ci`.
fn para_style_at(t: &TextLayer, ci: usize) -> ParagraphStyle {
    let at = byte_at(&t.text, ci);
    let mut start = 0usize;
    let runs = t.paragraph_runs();
    let mut last = None;
    for r in runs {
        let end = start.saturating_add(r.len);
        if at < end {
            return r.style;
        }
        start = end;
        last = Some(r.style);
    }
    last.unwrap_or_default()
}

/// A Character panel menu toggle: what it reads and writes on a character style.
#[derive(Clone, Copy)]
enum CharToggle {
    FauxBold,
    FauxItalic,
    AllCaps,
    SmallCaps,
    Superscript,
    Subscript,
    Underline,
    Strikethrough,
    NoBreak,
}

impl CharToggle {
    fn label(self) -> &'static str {
        match self {
            Self::FauxBold => "Faux Bold",
            Self::FauxItalic => "Faux Italic",
            Self::AllCaps => "All Caps",
            Self::SmallCaps => "Small Caps",
            Self::Superscript => "Superscript",
            Self::Subscript => "Subscript",
            Self::Underline => "Underline",
            Self::Strikethrough => "Strikethrough",
            Self::NoBreak => "No Break",
        }
    }

    fn is_on(self, s: &CharStyle) -> bool {
        match self {
            Self::FauxBold => s.faux_bold,
            Self::FauxItalic => s.faux_italic,
            Self::AllCaps => s.caps == Caps::AllCaps,
            Self::SmallCaps => s.caps == Caps::SmallCaps,
            Self::Superscript => s.baseline == FontBaseline::Superscript,
            Self::Subscript => s.baseline == FontBaseline::Subscript,
            Self::Underline => s.underline,
            Self::Strikethrough => s.strikethrough,
            Self::NoBreak => s.no_break,
        }
    }

    /// Turning All Caps on turns Small Caps off and the reverse, as do Superscript and Subscript:
    /// each pair is one field. Turning one off leaves the other as it was.
    fn set(self, s: &mut CharStyle, on: bool) {
        let pair = |field: &mut Caps, mine: Caps| {
            if on {
                *field = mine;
            } else if *field == mine {
                *field = Caps::Normal;
            }
        };
        match self {
            Self::FauxBold => s.faux_bold = on,
            Self::FauxItalic => s.faux_italic = on,
            Self::AllCaps => pair(&mut s.caps, Caps::AllCaps),
            Self::SmallCaps => pair(&mut s.caps, Caps::SmallCaps),
            Self::Superscript | Self::Subscript => {
                let mine = if matches!(self, Self::Superscript) { FontBaseline::Superscript } else { FontBaseline::Subscript };
                if on {
                    s.baseline = mine;
                } else if s.baseline == mine {
                    s.baseline = FontBaseline::Normal;
                }
            }
            Self::Underline => s.underline = on,
            Self::Strikethrough => s.strikethrough = on,
            Self::NoBreak => s.no_break = on,
        }
    }
}

fn on_param(cmd: &str, p: &Value) -> Result<Option<bool>> {
    match p.get("on") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        Some(_) => Err(bad(cmd, "on must be true or false")),
    }
}

fn toggle_char(s: &mut Session, p: &Value, cmd: &str, which: CharToggle) -> Result<Value> {
    let on = match on_param(cmd, p)? {
        Some(on) => on,
        None => !which.is_on(&char_style_at(representative(s, p)?, start_char(p))),
    };
    with_text_targets(s, p, which.label(), |t, (a, b)| {
        style_range(t, a.min(b), a.max(b), &|st| which.set(st, on));
        Ok(())
    })?;
    Ok(json!({ "on": on }))
}

/// A per-layer flag of the Character panel menu.
#[derive(Clone, Copy)]
enum LayerFlag {
    FractionalWidths,
    SystemLayout,
}

impl LayerFlag {
    fn get(self, t: &TextLayer) -> bool {
        match self {
            Self::FractionalWidths => t.fractional_widths,
            Self::SystemLayout => t.system_layout,
        }
    }
    fn set(self, t: &mut TextLayer, on: bool) {
        match self {
            Self::FractionalWidths => t.fractional_widths = on,
            Self::SystemLayout => t.system_layout = on,
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::FractionalWidths => "Fractional Widths",
            Self::SystemLayout => "System Layout",
        }
    }
}

fn toggle_layer(s: &mut Session, p: &Value, cmd: &str, which: LayerFlag) -> Result<Value> {
    let on = match on_param(cmd, p)? {
        Some(on) => on,
        None => !which.get(representative(s, p)?),
    };
    with_text_targets(s, p, which.label(), |t, _| {
        which.set(t, on);
        Ok(())
    })?;
    Ok(json!({ "on": on }))
}

fn toggle_hanging(s: &mut Session, p: &Value) -> Result<Value> {
    let cmd = "type.hangingPunctuation";
    let on = match on_param(cmd, p)? {
        Some(on) => on,
        None => !para_style_at(representative(s, p)?, start_char(p)).hanging_punctuation,
    };
    with_text_targets(s, p, "Roman Hanging Punctuation", |t, (a, b)| {
        style_paragraphs(t, a.min(b), a.max(b), &|st| st.hanging_punctuation = on);
        Ok(())
    })?;
    Ok(json!({ "on": on }))
}

fn set_composer(s: &mut Session, p: &Value, c: Composer) -> Result<Value> {
    with_text_targets(s, p, "Composer", |t, (a, b)| {
        style_paragraphs(t, a.min(b), a.max(b), &|st| st.composer = c);
        Ok(())
    })?;
    Ok(json!({ "composer": if c == Composer::SingleLine { "singleLine" } else { "everyLine" } }))
}

/// `type.list`: turns a bulleted or numbered list on (`"type":"bullet|number"`, with the other
/// `"list"` keys) or off (`"none"`). Turning one on keeps a paragraph's level, and its marker and
/// start when it already is a list of that type; a paragraph without a left indent gets 1.5 em of
/// its first character's size per level, so the marker sits inside the box (the JavaScript app's
/// `listPatch`), unless `"indent":false`.
fn set_list(s: &mut Session, p: &Value) -> Result<Value> {
    let cmd = "type.list";
    let kind = match p.get("type").and_then(Value::as_str) {
        Some("bullet") => Some(ListKind::Bullet),
        Some("number") => Some(ListKind::Number),
        Some("none") => None,
        _ => return Err(bad(cmd, "type must be \"bullet\", \"number\" or \"none\"")),
    };
    let mut given = p.clone();
    if let Some(o) = given.as_object_mut() {
        o.retain(|k, _| matches!(k.as_str(), "marker" | "start" | "level"));
        if let Some(k) = kind {
            o.insert("type".into(), json!(if k == ListKind::Number { "number" } else { "bullet" }));
        }
    }
    if kind.is_some() {
        check_list(&given).map_err(|m| bad(cmd, m))?;
    } else if given.as_object().is_some_and(|o| !o.is_empty()) {
        return Err(bad(cmd, "marker, start and level need a list type"));
    }
    if p.get("indent").is_some_and(|v| !v.is_boolean()) {
        return Err(bad(cmd, "indent must be true or false"));
    }
    let indent = p.get("indent").and_then(Value::as_bool) != Some(false);
    let label = match kind {
        Some(ListKind::Number) => "Numbering",
        _ => "Bullets",
    };
    with_text_targets(s, p, label, |t, (a, b)| {
        let (a, b) = (a.min(b), a.max(b));
        // The size the indent is measured in: each paragraph's first character's.
        let runs = t.char_runs();
        let size_at = |off: usize| {
            let mut end = 0usize;
            for r in &runs {
                end = end.saturating_add(r.len);
                if off < end {
                    return r.style.size_pt;
                }
            }
            runs.last().map_or(12.0, |r| r.style.size_pt)
        };
        let paras = photocraft_text::layout::split_paragraphs(&t.text);
        for para in paras {
            let touches = (para.start < b && para.end > a) || (a == b && a >= para.start && a <= para.end);
            if !touches {
                continue;
            }
            let size = size_at(para.start);
            // One paragraph: its first byte (an empty one: its caret position).
            let pa = para.start.min(t.text.len());
            let pb = if para.end > pa { pa + 1 } else { pa };
            style_paragraphs(t, pa, pb, &|st| match kind {
                None => st.list = None,
                Some(k) => {
                    let current = st.list.clone();
                    let mut l = match &current {
                        Some(c) if c.kind == k => c.clone(),
                        Some(c) => ListStyle { level: c.level, ..ListStyle::new(k) },
                        None => ListStyle::new(k),
                    };
                    if let Some(m) = given.get("marker").and_then(Value::as_str) {
                        l.marker = m.to_string();
                    }
                    if let Some(n) = given.get("start").and_then(Value::as_u64) {
                        l.start = u32::try_from(n).unwrap_or(ListStyle::MAX_START);
                    }
                    if let Some(n) = given.get("level").and_then(Value::as_u64) {
                        l.level = u8::try_from(n).unwrap_or(ListStyle::MAX_LEVEL);
                    }
                    if indent && st.start_indent_pt == 0.0 {
                        st.start_indent_pt = (size * 1.5).round() * f32::from(l.level + 1);
                    }
                    st.list = Some(l);
                }
            });
        }
        Ok(())
    })?;
    Ok(json!({ "type": p.get("type") }))
}

const TOGGLE_PARAMS: &str = r##"{"layer":id? or "layers":[id,…]? (default selected Type layers),"range":[startChar,endChar]? (single layer; default all),"on":bool? (default: toggle from where the edit starts)}"##;
const LAYER_PARAMS: &str = r##"{"layer":id? or "layers":[id,…]? (default selected Type layers),"on":bool? (default: toggle the active layer's)}"##;
const PARA_PARAMS: &str = r##"{"layer":id? or "layers":[id,…]? (default selected Type layers),"range":[startChar,endChar]? (single layer; default all)}"##;

/// The commands: Character and Paragraph panel menu toggles, the composers and lists.
pub fn specs() -> Vec<CommandSpec> {
    macro_rules! char_toggle {
        ($id:literal, $label:literal, $which:expr) => {
            CommandSpec {
                id: $id,
                label: $label,
                menu: &[],
                shortcut: None,
                params: TOGGLE_PARAMS,
                enabled: has_format_target,
                journal: true,
                run: |s, p| toggle_char(s, p, $id, $which),
            }
        };
    }
    vec![
        char_toggle!("type.character.fauxBold", "Faux Bold", CharToggle::FauxBold),
        char_toggle!("type.character.fauxItalic", "Faux Italic", CharToggle::FauxItalic),
        char_toggle!("type.character.allCaps", "All Caps", CharToggle::AllCaps),
        char_toggle!("type.character.smallCaps", "Small Caps", CharToggle::SmallCaps),
        char_toggle!("type.character.superscript", "Superscript", CharToggle::Superscript),
        char_toggle!("type.character.subscript", "Subscript", CharToggle::Subscript),
        char_toggle!("type.character.underline", "Underline", CharToggle::Underline),
        char_toggle!("type.character.strikethrough", "Strikethrough", CharToggle::Strikethrough),
        char_toggle!("type.noBreak", "No Break", CharToggle::NoBreak),
        CommandSpec {
            id: "type.fractionalWidths",
            label: "Fractional Widths",
            menu: &[],
            shortcut: None,
            params: LAYER_PARAMS,
            enabled: has_format_target,
            journal: true,
            run: |s, p| toggle_layer(s, p, "type.fractionalWidths", LayerFlag::FractionalWidths),
        },
        CommandSpec {
            id: "type.systemLayout",
            label: "System Layout",
            menu: &[],
            shortcut: None,
            params: LAYER_PARAMS,
            enabled: has_format_target,
            journal: true,
            run: |s, p| toggle_layer(s, p, "type.systemLayout", LayerFlag::SystemLayout),
        },
        CommandSpec {
            id: "type.hangingPunctuation",
            label: "Roman Hanging Punctuation",
            menu: &[],
            shortcut: None,
            params: TOGGLE_PARAMS,
            enabled: has_format_target,
            journal: true,
            run: toggle_hanging,
        },
        CommandSpec {
            id: "type.composer.singleLine",
            label: "Single-line Composer",
            menu: &[],
            shortcut: None,
            params: PARA_PARAMS,
            enabled: has_format_target,
            journal: true,
            run: |s, p| set_composer(s, p, Composer::SingleLine),
        },
        CommandSpec {
            id: "type.composer.everyLine",
            label: "Every-line Composer",
            menu: &[],
            shortcut: None,
            params: PARA_PARAMS,
            enabled: has_format_target,
            journal: true,
            run: |s, p| set_composer(s, p, Composer::EveryLine),
        },
        CommandSpec {
            id: "type.list",
            label: "Bullets and Numbering",
            menu: &[],
            shortcut: None,
            params: r##"{"layer":id? or "layers":[id,…]? (default selected Type layers),"range":[startChar,endChar]? (single layer; default all),"type":"bullet|number|none","marker":str? (bullet: 1-2 characters; number: decimal|lowerAlpha|upperAlpha|lowerRoman|upperRoman),"start":0..=9999?,"level":0..=8?,"indent":bool=true (a paragraph without a left indent gets 1.5 em per level)}"##,
            enabled: has_format_target,
            journal: true,
            run: set_list,
        },
    ]
}

#[cfg(test)]
#[path = "type_layer_opts_cmds_tests.rs"]
mod tests;
