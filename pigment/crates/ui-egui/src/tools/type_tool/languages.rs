//! Pigment (PORTS-B B2, row 7): the Character panel's Language select. Photoshop lists the
//! languages it has hyphenation and spelling dictionaries for; the run's language picks them
//! (hyphenation in B3, spelling in B8). A language Pigment has no dictionary for is listed with
//! "(no dictionary)" after its name.
//!
//! The list is Photoshop's Character panel menu as best known (names as Photoshop writes them),
//! not checked against a Photoshop 2026 install: correct it from one when one is at hand.

use std::sync::OnceLock;

/// Photoshop's languages: BCP 47 tag, English name (Photoshop's words).
pub(crate) const LANGUAGES: &[(&str, &str)] = &[
    ("en-US", "English: USA"),
    ("en-GB", "English: UK"),
    ("en-CA", "English: Canadian"),
    ("ar", "Arabic"),
    ("bg-BG", "Bulgarian"),
    ("ca-ES", "Catalan"),
    ("hr-HR", "Croatian"),
    ("cs-CZ", "Czech"),
    ("da-DK", "Danish"),
    ("nl-NL", "Dutch: 2005 Reform"),
    ("et-EE", "Estonian"),
    ("fi-FI", "Finnish"),
    ("fr-FR", "French"),
    ("fr-CA", "French: Canadian"),
    ("de-DE", "German: 2006 Reform"),
    ("de-CH", "German: Swiss 2006 Reform"),
    ("el-GR", "Greek"),
    ("he-IL", "Hebrew"),
    ("hi-IN", "Hindi"),
    ("hu-HU", "Hungarian"),
    ("it-IT", "Italian"),
    ("ja-JP", "Japanese"),
    ("ko-KR", "Korean"),
    ("lv-LV", "Latvian"),
    ("lt-LT", "Lithuanian"),
    ("nb-NO", "Norwegian: Bokmål"),
    ("nn-NO", "Norwegian: Nynorsk"),
    ("pl-PL", "Polish"),
    ("pt-PT", "Portuguese"),
    ("pt-BR", "Portuguese: Brazilian"),
    ("ro-RO", "Romanian"),
    ("ru-RU", "Russian"),
    ("sr-RS", "Serbian"),
    ("sk-SK", "Slovak"),
    ("sl-SI", "Slovenian"),
    ("es-ES", "Spanish"),
    ("sv-SE", "Swedish"),
    ("tr-TR", "Turkish"),
    ("uk-UA", "Ukrainian"),
    ("zh-Hans", "Chinese (Simplified)"),
    ("zh-Hant", "Chinese (Traditional)"),
];

/// The language new text gets when nothing else says: en-US.
pub(crate) const FALLBACK: &str = "en-US";

/// Whether Pigment hyphenates `tag`: craft-text has patterns (or its dictionary) for it.
pub(crate) fn has_hyphenation(tag: &str) -> bool {
    craft::text::hyphen::Lang::for_language(tag).is_some()
}

/// Whether Pigment can check spelling in `tag`. Package B8 brings per-language spelling
/// (craft-proof, behind an engine helper); until then English is what the checker knows.
pub(crate) fn has_spelling(tag: &str) -> bool {
    tag.split(['-', '_']).next().is_some_and(|l| l.eq_ignore_ascii_case("en"))
}

/// The select's rows, `(tag, shown name)`: a language with neither dictionary is marked.
pub(crate) fn rows() -> Vec<(String, String)> {
    static HAS: OnceLock<Vec<bool>> = OnceLock::new();
    let has = HAS.get_or_init(|| LANGUAGES.iter().map(|&(tag, _)| has_hyphenation(tag) || has_spelling(tag)).collect());
    let suffix = tl!("(no dictionary)");
    LANGUAGES
        .iter()
        .zip(has)
        .map(|(&(tag, name), &has)| (tag.to_string(), if has { name.to_string() } else { format!("{name} {suffix}") }))
        .collect()
}

/// The table's language for an interface language code (`de`, `pt-BR`, `zh-Hant`…): the exact
/// tag, else the first row with the same primary language, else [`FALLBACK`].
pub(crate) fn for_interface(code: &str) -> &'static str {
    let lower = code.replace('_', "-").to_ascii_lowercase();
    if let Some(&(tag, _)) = LANGUAGES.iter().find(|(tag, _)| tag.eq_ignore_ascii_case(&lower)) {
        return tag;
    }
    let primary = lower.split('-').next().unwrap_or_default();
    // Chinese by script: Taiwan, Hong Kong and Macao write Traditional.
    if primary == "zh" {
        return if ["hant", "tw", "hk", "mo"].iter().any(|r| lower.split('-').any(|p| p == *r)) { "zh-Hant" } else { "zh-Hans" };
    }
    LANGUAGES.iter().find(|(tag, _)| tag.split('-').next() == Some(primary)).map_or(FALLBACK, |&(tag, _)| tag)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tags_are_unique_and_english_comes_first() {
        let mut tags: Vec<&str> = LANGUAGES.iter().map(|l| l.0).collect();
        assert_eq!(tags[0], "en-US");
        tags.sort_unstable();
        let n = tags.len();
        tags.dedup();
        assert_eq!(tags.len(), n);
    }

    #[test]
    fn interface_languages_map_to_table_rows() {
        assert_eq!(for_interface("en"), "en-US");
        assert_eq!(for_interface("de"), "de-DE");
        assert_eq!(for_interface("pt-BR"), "pt-BR");
        assert_eq!(for_interface("pt_br"), "pt-BR");
        assert_eq!(for_interface("zh-TW"), "zh-Hant");
        assert_eq!(for_interface("zh"), "zh-Hans");
        assert_eq!(for_interface("xx"), FALLBACK);
    }

    #[test]
    fn english_has_a_dictionary_and_rows_mark_the_rest() {
        assert!(has_hyphenation("en-US") && has_spelling("en-GB"));
        let rows = rows();
        assert_eq!(rows.len(), LANGUAGES.len());
        assert_eq!(rows[0], ("en-US".to_string(), "English: USA".to_string()));
        // Japanese has neither hyphenation patterns nor a spelling dictionary.
        let ja = rows.iter().find(|r| r.0 == "ja-JP").map(|r| r.1.as_str());
        assert_eq!(ja, Some("Japanese (no dictionary)"));
    }
}
