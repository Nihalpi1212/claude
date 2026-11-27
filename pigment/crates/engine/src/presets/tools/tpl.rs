//! Pigment: Photoshop tool presets (`.tpl`) for Window › Tool Presets (P2): Load Tool Presets…,
//! Replace Tool Presets… (`tool.presets.importTpl`) and Save Tool Presets…
//! (`tool.presets.exportTpl`). Reset Tool Presets… is `tool.presets.reset`.
//!
//! The file is read and written by `photocraft_io::tpl_map`. A preset's brush comes in as its
//! settings in `options.brush`, sampled tip included, as the + button stores the current brush
//! (`tool.presets.new`); it is checked as `tools.setBrush` would check it, and a brush that would
//! not apply is left out with a warning. Tips the preset store keeps outside the settings are
//! loaded before a preset is written, so the file holds the bitmap.

use serde_json::{Value, json};

use super::{MAX_PRESETS, ToolPreset, checked_name};
use crate::commands::CommandSpec;
use crate::presets::{always, bad, str_param, unique_name_by};
use crate::{Result, Session};

pub(crate) const IMPORT: &str = "tool.presets.importTpl";
pub(crate) const EXPORT: &str = "tool.presets.exportTpl";

/// A file's preset as the library keeps it, or why it cannot be kept.
fn preset_of(p: photocraft_io::tpl_map::TplPreset, warnings: &mut Vec<String>) -> Option<ToolPreset> {
    let name = match checked_name(&p.name.chars().take(crate::brush_preset_cmds::MAX_NAME).collect::<String>(), IMPORT) {
        Ok(n) => n,
        Err(_) => {
            warnings.push("a preset without a name was left out".into());
            return None;
        }
    };
    let mut options = if p.options.is_object() { p.options } else { json!({}) };
    if let Some(b) = options.get("brush") {
        let ok = crate::brush_cmds::merge_brush(&photocraft_paint::BrushSettings::default(), b, IMPORT)
            .and_then(|m| crate::brush_cmds::validate_brush(&m, IMPORT).map(|()| m));
        if let Err(e) = ok {
            warnings.push(format!("\"{name}\": its brush could not be used ({e}); the preset keeps the current brush"));
            if let Some(o) = options.as_object_mut() {
                o.remove("brush");
            }
        }
    }
    if let Some(f) = options.get("foreground") {
        let valid = f.as_array().is_some_and(|c| matches!(c.len(), 3 | 4) && c.iter().all(|v| v.as_f64().is_some_and(|x| (0.0..=1.0).contains(&x))));
        if !valid {
            warnings.push(format!("\"{name}\": its colour could not be read and was left out"));
            if let Some(o) = options.as_object_mut() {
                o.remove("foreground");
            }
        }
    }
    Some(ToolPreset { name, tool: p.tool, options })
}

/// `{"path"|"data", "replace"=false}` → `{added: [names], count, skipped, warnings}`.
fn import(s: &mut Session, p: &Value) -> Result<Value> {
    let replace = match p.get("replace") {
        None | Some(Value::Null) => false,
        Some(v) => v.as_bool().ok_or_else(|| bad(IMPORT, "`replace` must be a boolean"))?,
    };
    let (bytes, _) = crate::preset_import_cmds::file_bytes(p, IMPORT, ".tpl file")?;
    let imp = photocraft_io::tpl_map::read_tpl(&bytes).map_err(|e| bad(IMPORT, e))?;
    let mut warnings = imp.warnings;
    let incoming: Vec<ToolPreset> = imp.presets.into_iter().filter_map(|t| preset_of(t, &mut warnings)).collect();
    if incoming.is_empty() {
        let why = warnings.first().cloned().unwrap_or_else(|| "the file holds no tool presets".into());
        return Err(bad(IMPORT, format!("no tool preset could be read: {why}")));
    }
    let mut library = if replace { Vec::new() } else { s.presets.tool_presets.clone() };
    let (mut added, mut skipped, mut over) = (Vec::new(), 0usize, 0usize);
    for mut t in incoming {
        // Loading the same file twice adds nothing: a preset already here as it is stays one.
        if library.iter().any(|have| have.tool == t.tool && have.options == t.options && (have.name == t.name || numbered(&have.name, &t.name))) {
            skipped += 1;
            continue;
        }
        if library.len() >= MAX_PRESETS {
            over += 1;
            continue;
        }
        t.name = unique_name_by(&t.name, |n| library.iter().any(|x| x.name == n));
        added.push(t.name.clone());
        library.push(t);
    }
    if over > 0 {
        warnings.push(format!("at most {MAX_PRESETS} tool presets are kept; {over} were left out"));
    }
    s.presets.tool_presets = library;
    s.presets_changed();
    Ok(json!({"added": added, "count": added.len(), "skipped": skipped, "warnings": warnings}))
}

/// `name` is `base` with the number a clash gave it (`Soft 2`).
fn numbered(name: &str, base: &str) -> bool {
    name.strip_prefix(base).and_then(|r| r.strip_prefix(' ')).is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// A brush whose tip, Dual Brush tip or texture the preset store keeps (`{"stored": …}`).
fn has_stored_tip(b: &Value) -> bool {
    [&["tip"][..], &["dualBrush", "tip"], &["texture", "pattern"]]
        .iter()
        .any(|path| path.iter().try_fold(b, |v, k| v.get(*k)).is_some_and(|v| v.get("stored").is_some()))
}

/// `{"names"?, "path"?}` → `{count, bytes, warnings, path | data}`.
fn export(s: &mut Session, p: &Value) -> Result<Value> {
    let chosen: Vec<ToolPreset> = match p.get("names") {
        None | Some(Value::Null) => s.presets.tool_presets.clone(),
        Some(Value::Array(names)) => {
            let mut out = Vec::with_capacity(names.len());
            for n in names {
                let n = n.as_str().ok_or_else(|| bad(EXPORT, "`names` must be tool preset names"))?;
                let t = s
                    .presets
                    .tool_presets
                    .iter()
                    .find(|t| t.name == n)
                    .ok_or_else(|| bad(EXPORT, format!("no tool preset \"{n}\" (see tool.presets.list)")))?;
                out.push(t.clone());
            }
            out
        }
        Some(_) => return Err(bad(EXPORT, "`names` must be a list of tool preset names")),
    };
    if chosen.is_empty() {
        return Err(bad(EXPORT, "there are no tool presets to save"));
    }
    let mut warnings = Vec::new();
    // Tips the preset store keeps outside the settings: loaded, so the file holds the bitmap.
    let chosen: Vec<ToolPreset> = chosen
        .into_iter()
        .map(|mut t| {
            if let Some(b) = t.options.get("brush").filter(|b| has_stored_tip(b)) {
                let loaded = serde_json::from_value::<photocraft_paint::BrushSettings>(b.clone()).ok().and_then(|mut brush| {
                    s.load_brush_tips(&mut brush).ok()?;
                    serde_json::to_value(&brush).ok()
                });
                match loaded {
                    Some(v) => t.options["brush"] = v,
                    None => warnings.push(format!("\"{}\": its brush tip could not be loaded", t.name)),
                }
            }
            t
        })
        .collect();
    let entries: Vec<photocraft_io::tpl_map::TplEntry> =
        chosen.iter().map(|t| photocraft_io::tpl_map::TplEntry { name: &t.name, tool: &t.tool, options: &t.options }).collect();
    let (bytes, report) = photocraft_io::tpl_map::write_tpl(&entries).map_err(|e| bad(EXPORT, e))?;
    warnings.extend(report);
    let mut out = json!({"count": entries.len(), "bytes": bytes.len(), "warnings": warnings});
    match str_param(p, "path") {
        Some(path) => {
            crate::file_cmds::write_file(path, &bytes)?;
            out["path"] = json!(path);
        }
        None => out["data"] = json!(photocraft_paint::tile::b64_encode(&bytes)),
    }
    Ok(out)
}

pub(crate) fn specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec {
            id: IMPORT,
            label: "Load Tool Presets…",
            menu: &[],
            shortcut: None,
            params: r##"{"path":".tpl file"|"data":base64,"replace":bool=false (Replace Tool Presets…: the file's presets take the place of every tool preset)} → {added:[names],count,skipped (already here),warnings} (Photoshop .tpl; a taken name gets " 2")"##,
            enabled: always,
            run: import,
            journal: true,
        },
        CommandSpec {
            id: EXPORT,
            label: "Save Tool Presets…",
            menu: &[],
            shortcut: None,
            params: r##"{"names":[tool preset names]? (default every tool preset),"path":".tpl file"? (else the bytes come back as base64 `data`)} → {count,bytes,warnings,path | data} (Photoshop .tpl; Pigment's own options ride along)"##,
            enabled: always,
            run: export,
            journal: false,
        },
    ]
}

#[cfg(test)]
mod tests;
