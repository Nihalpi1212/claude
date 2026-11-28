//! Pigment: EngineData's `Language` number of a character run and the BCP 47 tag of
//! [`photocraft_doc::text::CharStyle::language`] (PORTS-B B1, row 7).
//!
//! The table holds only codes read from type layers Photoshop saved, one per language in its
//! Character panel menu. No Photoshop sample is in the tree yet, so it is empty: a `Language` the
//! table doesn't know imports as no language, and an edit of the layer keeps the number the file
//! had on the runs that still have no language (see `build_engine_data`). A run whose language was
//! set in Pigment writes no `Language` until its code is in the table, so Photoshop shows its
//! default language there. Never guess a code: add a row only with the sample it was read from.

/// `(EngineData Language, BCP 47 tag)`, each read from a Photoshop-saved sample.
const LANGUAGES: &[(i64, &str)] = &[];

/// The tag of EngineData `Language` `code`, when a sample has shown it.
pub fn tag_for(code: i64) -> Option<&'static str> {
    LANGUAGES.iter().find(|(c, _)| *c == code).map(|(_, t)| *t)
}

/// The EngineData `Language` of BCP 47 `tag` (case-insensitive), when a sample has shown it.
pub fn code_for(tag: &str) -> Option<i64> {
    LANGUAGES.iter().find(|(_, t)| t.eq_ignore_ascii_case(tag)).map(|(c, _)| *c)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_is_one_to_one() {
        for (i, (code, tag)) in LANGUAGES.iter().enumerate() {
            assert!(LANGUAGES[i + 1..].iter().all(|(c, t)| c != code && !t.eq_ignore_ascii_case(tag)), "{code} {tag} twice");
            assert_eq!(tag_for(*code), Some(*tag));
            assert_eq!(code_for(tag), Some(*code));
        }
    }

    #[test]
    fn an_unknown_code_or_tag_maps_to_nothing() {
        assert_eq!(tag_for(-12345), None);
        assert_eq!(code_for("x-unknown"), None);
    }
}
