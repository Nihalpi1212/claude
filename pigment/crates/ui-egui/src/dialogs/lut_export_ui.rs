//! Pigment: the rows of File › Export › Color Lookup Tables… (F2, rows 31 and 32), as Photoshop's
//! dialog has them: the file, Description (the command's `title`), Copyright, Quality with its grid
//! points, Use lowercase file extensions and the four formats. Upstream's form had the file, Grid
//! Size, Title and Scope; its keys (`path`, `size`, `title`, `scope`) are kept, so its tests and
//! recorded steps still hold.
//!
//! Quality is a choice of Photoshop's grid sizes (Poor 7, Low 17, Medium 33, High 64, Maximum 256)
//! or Custom, which takes the Grid Points row. [`fold`] turns Quality and the four check boxes into
//! the command's `size` and `formats` when the form is confirmed.

use craft::ui::patterns::form_dialogs::{Param, ParamKind};
use craft::ui::runtime::env::Label;
use serde_json::{Map, Value, json};

/// The command whose form this is.
pub(crate) const COMMAND: &str = "file.export.colorLookupTables";

/// Quality's choices: id, label, grid points (`None`: Custom, the Grid Points row).
fn qualities() -> [(&'static str, &'static str, Option<i64>); 6] {
    [
        ("poor", tl!("Poor"), Some(7)),
        ("low", tl!("Low"), Some(17)),
        ("medium", tl!("Medium"), Some(33)),
        ("high", tl!("High"), Some(64)),
        ("maximum", tl!("Maximum"), Some(256)),
        ("custom", tl!("Custom"), None),
    ]
}

/// The format check boxes: field key, label, the command's format id. Photoshop's order.
fn formats() -> [(&'static str, &'static str, &'static str); 4] {
    [("formats/3dl", tl!("3DL"), "3dl"), ("formats/cube", tl!("CUBE"), "cube"), ("formats/csp", tl!("CSP"), "csp"), ("formats/icc", tl!("ICC Profile"), "icc")]
}

/// The form's rows. `path` is the suggested file, `title` the suggested description, `scope` the
/// layers to bake ("all" or "selected").
pub(crate) fn rows(path: String, title: String, scope: &str) -> Vec<Param> {
    let choice = |list: Vec<(String, Label)>, default: &str| ParamKind::choice(list, Some(default.to_owned()));
    let mut rows = vec![
        Param::new("path", tl!("File"), ParamKind::text(path)),
        Param::new("title", tl!("Description"), ParamKind::text(title)),
        Param::new("copyright", tl!("Copyright"), ParamKind::text("")),
        Param::new("lowercase", tl!("Use lowercase file extensions"), ParamKind::bool(true)),
        Param::new("quality", tl!("Quality"), choice(qualities().iter().map(|(id, label, _)| ((*id).to_owned(), Label::from(*label))).collect(), "medium")),
        Param::new("size", tl!("Grid Points"), ParamKind::int(Some(2), Some(256), 33)).enabled_when("quality", "custom"),
        Param::section(tl!("Formats")),
    ];
    for (key, label, id) in formats() {
        rows.push(Param::new(key, label, ParamKind::bool(id == "cube")));
    }
    rows.push(Param::new(
        "scope",
        tl!("Scope"),
        choice(vec![("all".into(), Label::from(tl!("All Visible Layers"))), ("selected".into(), Label::from(tl!("Selected Adjustments")))], scope),
    ));
    rows
}

/// The confirmed form as the command's params: Quality's grid points as `size` (Custom keeps the
/// Grid Points row), and the ticked boxes as `formats`.
pub(crate) fn fold(map: &mut Map<String, Value>) {
    if let Some(quality) = map.remove("quality")
        && let Some((_, _, Some(points))) = qualities().into_iter().find(|(id, _, _)| quality.as_str() == Some(*id))
    {
        map.insert("size".into(), json!(points));
    }
    let mut chosen = Vec::new();
    for (key, _, id) in formats() {
        if map.remove(key).and_then(|v| v.as_bool()) == Some(true) {
            chosen.push(json!(id));
        }
    }
    map.insert("formats".into(), Value::Array(chosen));
    if map.get("copyright").and_then(Value::as_str).is_some_and(str::is_empty) {
        map.remove("copyright");
    }
}

#[cfg(test)]
#[path = "lut_export_ui_tests.rs"]
mod tests;
