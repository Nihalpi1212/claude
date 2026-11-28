//! Pigment: the Character and Paragraph panel menus' Reset Character and Reset Paragraph (PORTS-B
//! rows 5 and 16).
//!
//! Photoshop's reset puts every attribute back to its default, font, size and colour included
//! (the JavaScript app kept those three; Pigment follows Photoshop). An applied character or
//! paragraph style stays applied and its overrides go: a run takes what its styles give it, which
//! with no styles in the document is [`CharStyle::default`] / [`ParagraphStyle::default`].

use photocraft_doc::text::{CharStyle, ParagraphStyle};
use serde_json::{Value, json};

use crate::commands::CommandSpec;
use crate::type_cmds::{has_format_target, style_paragraphs, style_range, with_text_targets};
use crate::{EngineError, Result, Session};

fn reset_character(s: &mut Session, p: &Value) -> Result<Value> {
    let styles = s.active().ok_or(EngineError::NoDocument)?.doc.text_styles.clone();
    let ids = with_text_targets(s, p, "Reset Character", |t, (a, b)| {
        let (a, b) = (a.min(b), a.max(b));
        // A run resets to what its paragraph's and its own styles give it, so each paragraph is
        // reset with its own paragraph style.
        let paras = photocraft_io::type_xmp::paragraph_styles(t);
        for (range, para) in paras {
            let (ra, rb) = (a.max(range.start), b.min(range.end));
            let caret = a == b && (range.start..=range.end).contains(&a);
            if ra >= rb && !caret {
                continue;
            }
            let (ra, rb) = if ra >= rb { (a, a) } else { (ra, rb) };
            style_range(t, ra, rb, &|st: &mut CharStyle| *st = styles.resolve_char(para.style_sheet, st.style_sheet, ""));
        }
        Ok(())
    })?;
    Ok(json!({ "layers": ids.iter().map(|id| id.0).collect::<Vec<_>>() }))
}

fn reset_paragraph(s: &mut Session, p: &Value) -> Result<Value> {
    let styles = s.active().ok_or(EngineError::NoDocument)?.doc.text_styles.clone();
    let ids = with_text_targets(s, p, "Reset Paragraph", |t, (a, b)| {
        style_paragraphs(t, a.min(b), a.max(b), &|st: &mut ParagraphStyle| *st = styles.resolve_para(st.style_sheet));
        Ok(())
    })?;
    Ok(json!({ "layers": ids.iter().map(|id| id.0).collect::<Vec<_>>() }))
}

const PARAMS: &str = r##"{"layer":id? or "layers":[id,…]? (default selected Type layers),"range":[startChar,endChar]? (single layer; default all)}"##;

/// Reset Character and Reset Paragraph.
pub fn specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec {
            id: "type.resetCharacter",
            label: "Reset Character",
            menu: &[],
            shortcut: None,
            params: PARAMS,
            enabled: has_format_target,
            journal: true,
            run: reset_character,
        },
        CommandSpec {
            id: "type.resetParagraph",
            label: "Reset Paragraph",
            menu: &[],
            shortcut: None,
            params: PARAMS,
            enabled: has_format_target,
            journal: true,
            run: reset_paragraph,
        },
    ]
}

#[cfg(test)]
#[path = "type_reset_cmds_tests.rs"]
mod tests;
