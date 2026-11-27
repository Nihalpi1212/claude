//! Adjustment presets (Pigment): `adjustment.presets.*`, the commands behind the Preset menu of
//! the adjustment dialogs and of an adjustment layer's Properties (the model is
//! [`crate::presets::adjustments`], Photoshop's files `photocraft_io::adjust_presets`).
//!
//! None of them changes a document, so none is journaled: applying a preset is setting the
//! dialog or layer to its params, which records those settings as Photoshop does. Every change
//! marks the preferences dirty, so the presets are saved with them.

use photocraft_color::ColorMode;
use serde_json::{Value, json};

use crate::commands::CommandSpec;
use crate::presets::adjustments::{self, Entry, KINDS, MAX_PARAMS_BYTES};
use crate::presets::{always, bad, req_str, str_param};
use crate::{EngineError, Result, Session};

pub mod panel;

/// Largest preset file `adjustment.presets.load` reads (Photoshop's are a few hundred bytes).
const MAX_FILE_BYTES: u64 = 1 << 20;

fn kind_param<'a>(p: &'a Value, cmd: &str) -> Result<&'a str> {
    let kind = req_str(p, "kind", cmd)?;
    known_kind(kind, cmd)
}

fn known_kind<'a>(kind: &'a str, cmd: &str) -> Result<&'a str> {
    if KINDS.contains(&kind) { Ok(kind) } else { Err(bad(cmd, format!("unknown adjustment kind `{kind}` (one of {})", KINDS.join(", ")))) }
}

fn name_param(p: &Value, key: &str, cmd: &str) -> Result<String> {
    let n = p.get(key).and_then(Value::as_str).ok_or_else(|| bad(cmd, format!("missing `{key}`")))?;
    adjustments::clean_name(n).ok_or_else(|| bad(cmd, format!("`{key}` must be 1..{} characters", adjustments::MAX_NAME_CHARS)))
}

/// The mode a preset's Levels and Curves channels are read in when it names none.
fn mode(s: &Session) -> ColorMode {
    s.active().map_or(ColorMode::Rgb, |d| d.doc.mode)
}

/// `params` as a preset keeps them: an object without nulls (the settings file is TOML), without
/// the one-shot `eyedropper` and the internal `__` keys, and read by the kind's command.
pub fn preset_params(kind: &str, params: &Value, cmd: &str) -> Result<Value> {
    let Value::Object(m) = params else { return Err(bad(cmd, "`params` must be an object")) };
    let mut v = Value::Object(m.iter().filter(|(k, _)| *k != "eyedropper" && !k.starts_with("__")).map(|(k, v)| (k.clone(), v.clone())).collect());
    crate::prefs::strip_nulls(&mut v);
    if serde_json::to_vec(&v).map_or(usize::MAX, |b| b.len()) > MAX_PARAMS_BYTES {
        return Err(bad(cmd, "`params` is too large"));
    }
    match kind {
        "hdrToning" => hdr_params(&v, cmd)?,
        _ => {
            crate::adjust_params::from_params(kind, &v, None, ColorMode::Rgb).map_err(|e| bad(cmd, e.to_string()))?;
        }
    }
    Ok(v)
}

/// HDR Toning's params (`image.adjustments.hdrToning`): numbers, the `curve` points and a `method`.
fn hdr_params(v: &Value, cmd: &str) -> Result<()> {
    const NUMBERS: [&str; 9] = ["radius", "strength", "gamma", "exposure", "detail", "shadow", "highlight", "vibrance", "saturation"];
    for (k, x) in v.as_object().into_iter().flatten() {
        let ok = match k.as_str() {
            k if NUMBERS.contains(&k) => x.as_f64().is_some_and(f64::is_finite),
            "curve" => {
                x.as_array().is_some_and(|a| a.len() <= 64 && a.iter().all(|p| p.as_array().is_some_and(|p| p.len() == 2 && p.iter().all(|n| n.is_number()))))
            }
            "method" => x.as_str().and_then(photocraft_algo::tone::hdr_methods::HdrMethod::parse).is_some(),
            _ => return Err(bad(cmd, format!("HDR Toning has no setting `{k}`"))),
        };
        if !ok {
            return Err(bad(cmd, format!("HDR Toning's `{k}` has the wrong type")));
        }
    }
    Ok(())
}

/// The params a preset read from a file keeps: the setting's full params, less Levels and Curves
/// channels left neutral (so the preset applies in any document mode, as the app's did), with
/// numbers held to four decimals.
pub fn file_params(adj: &photocraft_doc::Adjustment) -> Value {
    let kind = crate::commands::adjustment_kind(adj);
    let mut v = crate::adjust_params::to_params(adj);
    if let (Ok(neutral), Some(m)) = (crate::adjust_params::default_for(kind, ColorMode::Rgb), v.as_object_mut())
        && matches!(kind, "levels" | "curves")
    {
        let neutral = crate::adjust_params::to_params(&neutral);
        m.retain(|k, x| !matches!(k.as_str(), "red" | "green" | "blue") || neutral.get(k) != Some(x));
    }
    tidy_numbers(&mut v);
    v
}

fn tidy_numbers(v: &mut Value) {
    match v {
        Value::Number(n) if n.is_f64() => {
            if let Some(x) = n.as_f64() {
                let r = (x * 1e4).round() / 1e4;
                *v = if r.fract() == 0.0 && r.abs() < 1e15 { json!(r as i64) } else { json!(r) };
            }
        }
        Value::Array(a) => a.iter_mut().for_each(tidy_numbers),
        Value::Object(m) => m.values_mut().for_each(tidy_numbers),
        _ => {}
    }
}

fn find(s: &Session, kind: &str, p: &Value, cmd: &str) -> Result<Entry> {
    let (name, id) = (str_param(p, "name"), str_param(p, "id"));
    if name.is_none() && id.is_none() {
        return Err(bad(cmd, "give `name` or `id`"));
    }
    s.presets.adjustments.find(kind, name, id).ok_or_else(|| bad(cmd, format!("no {kind} preset \"{}\"", name.or(id).unwrap_or_default())))
}

fn list(s: &mut Session, p: &Value) -> Result<Value> {
    let cmd = "adjustment.presets.list";
    let with = p.get("params").and_then(Value::as_bool).unwrap_or(false);
    let kinds: Vec<&str> = match str_param(p, "kind") {
        Some(k) => vec![known_kind(k, cmd)?],
        None => KINDS.to_vec(),
    };
    let out: serde_json::Map<String, Value> =
        kinds.into_iter().map(|k| (k.to_string(), Value::Array(s.presets.adjustments.list(k).iter().map(|e| e.to_json(with)).collect()))).collect();
    Ok(Value::Object(out))
}

fn get(s: &mut Session, p: &Value) -> Result<Value> {
    let cmd = "adjustment.presets.get";
    let kind = kind_param(p, cmd)?;
    Ok(find(s, kind, p, cmd)?.to_json(true))
}

fn save(s: &mut Session, p: &Value) -> Result<Value> {
    let cmd = "adjustment.presets.save";
    let kind = kind_param(p, cmd)?;
    let name = name_param(p, "name", cmd)?;
    let params = preset_params(kind, p.get("params").unwrap_or(&Value::Null), cmd)?;
    let group = match p.get("group") {
        None | Some(Value::Null) => None,
        Some(_) => Some(name_param(p, "group", cmd)?),
    };
    let replaced = s.presets.adjustments.save(kind, &name, params, group.as_deref()).map_err(|e| bad(cmd, e))?;
    s.presets_changed();
    Ok(json!({"kind": kind, "name": name, "replaced": replaced}))
}

fn edit(s: &mut Session, p: &Value) -> Result<Value> {
    let cmd = "adjustment.presets.edit";
    let kind = kind_param(p, cmd)?;
    let out = match req_str(p, "action", cmd)? {
        "rename" => {
            let name = req_str(p, "name", cmd)?;
            let to = name_param(p, "newName", cmd)?;
            s.presets.adjustments.rename(kind, name, &to).map_err(|e| bad(cmd, e))?;
            json!({"name": to})
        }
        "delete" => {
            let names: Vec<String> = match p.get("name") {
                Some(Value::Array(a)) => a
                    .iter()
                    .map(|n| n.as_str().map(str::to_string).ok_or_else(|| bad(cmd, "`name` must be a name or a list of names")))
                    .collect::<Result<_>>()?,
                _ => vec![req_str(p, "name", cmd)?.to_string()],
            };
            let deleted = s.presets.adjustments.delete(kind, &names).map_err(|e| bad(cmd, e))?;
            json!({"deleted": deleted})
        }
        other => return Err(bad(cmd, format!("unknown action `{other}` (rename or delete)"))),
    };
    s.presets_changed();
    Ok(out)
}

fn reset(s: &mut Session, p: &Value) -> Result<Value> {
    let cmd = "adjustment.presets.reset";
    let kind = kind_param(p, cmd)?;
    let (restored, renamed) = s.presets.adjustments.reset(kind);
    s.presets_changed();
    Ok(json!({"restored": restored, "renamed": renamed}))
}

fn load(s: &mut Session, p: &Value) -> Result<Value> {
    let cmd = "adjustment.presets.load";
    let file_name = str_param(p, "fileName");
    let ext = str_param(p, "path").or(file_name).and_then(|f| std::path::Path::new(f).extension()).and_then(|e| e.to_str());
    let kind = match (str_param(p, "kind"), ext.and_then(photocraft_io::adjust_presets::kind_for_extension)) {
        (Some(k), _) => known_kind(k, cmd)?,
        (None, Some(k)) => k,
        (None, None) => return Err(bad(cmd, "give `kind`, or a file whose extension names it (.alv, .acv, .ahu, .cha, .asv, .blw)")),
    };
    if photocraft_io::adjust_presets::extension(kind).is_none() {
        return Err(bad(cmd, format!("{kind} has no Photoshop preset file")));
    }
    let (bytes, stem) = crate::preset_import_cmds::file_bytes_limited(p, cmd, "an adjustment preset file", MAX_FILE_BYTES)?;
    let stem = if stem.is_empty() {
        file_name.and_then(|f| std::path::Path::new(f).file_stem()).and_then(|s| s.to_str()).unwrap_or_default().to_string()
    } else {
        stem
    };
    let (adj, report) = photocraft_io::adjust_presets::read(kind, &bytes).map_err(|e| bad(cmd, e))?;
    // A file holds one setting; the preset is named after the file, as the app named it.
    let base = match p.get("name") {
        None | Some(Value::Null) => adjustments::clean_name(&stem).unwrap_or_else(|| "Preset".into()),
        Some(_) => name_param(p, "name", cmd)?,
    };
    let name = s.presets.adjustments.unique_name(kind, &base);
    let group = match p.get("group") {
        None | Some(Value::Null) => None,
        Some(_) => Some(name_param(p, "group", cmd)?),
    };
    s.presets.adjustments.save(kind, &name, file_params(&adj), group.as_deref()).map_err(|e| bad(cmd, e))?;
    s.presets_changed();
    Ok(json!({"kind": kind, "added": [name], "report": report}))
}

fn export(s: &mut Session, p: &Value) -> Result<Value> {
    let cmd = "adjustment.presets.export";
    let kind = kind_param(p, cmd)?;
    let ext = photocraft_io::adjust_presets::extension(kind).ok_or_else(|| bad(cmd, format!("{kind} has no Photoshop preset file")))?;
    let (params, base) = match p.get("params").filter(|v| !v.is_null()) {
        Some(params) => (preset_params(kind, params, cmd)?, str_param(p, "name").unwrap_or(kind).to_string()),
        None => {
            let e = find(s, kind, p, cmd)?;
            (e.preset.params, e.preset.name)
        }
    };
    let adj = crate::adjust_params::from_params(kind, &params, None, mode(s)).map_err(|e| bad(cmd, e.to_string()))?;
    let bytes = photocraft_io::adjust_presets::write(&adj).map_err(|e| bad(cmd, e))?;
    match str_param(p, "path") {
        Some(path) => {
            std::fs::write(path, &bytes).map_err(|e| EngineError::Other(format!("{path}: {e}")))?;
            Ok(json!({"path": path, "bytes": bytes.len()}))
        }
        None => {
            let file: String = base.chars().map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c }).collect();
            Ok(json!({"data": photocraft_paint::tile::b64_encode(&bytes), "fileName": format!("{file}.{ext}"), "bytes": bytes.len()}))
        }
    }
}

/// Every `adjustment.presets.*` command, and the Adjustments panel's preset commands ([`panel`]).
pub fn specs() -> Vec<CommandSpec> {
    let mut v = vec![
        CommandSpec {
            id: "adjustment.presets.list",
            label: "Adjustment Presets",
            menu: &[],
            shortcut: None,
            params: r##"{"kind":adjustment kind? (levels, curves, hueSaturation, hdrToning…; all kinds when absent),"params":bool=false (include each preset's params)} → {kind: [{group, name, id? (built-ins), builtin, params?}]}"##,
            enabled: always,
            run: list,
            journal: false,
        },
        CommandSpec {
            id: "adjustment.presets.get",
            label: "Get Adjustment Preset",
            menu: &[],
            shortcut: None,
            params: r##"{"kind":adjustment kind,"name":str? | "id":built-in id?} → {group, name, id?, builtin, params} (params as image.adjustments.<kind> takes them; apply them over the kind's defaults)"##,
            enabled: always,
            run: get,
            journal: false,
        },
        CommandSpec {
            id: "adjustment.presets.save",
            label: "Save Adjustment Preset…",
            menu: &[],
            shortcut: None,
            params: r##"{"kind":adjustment kind,"name":str (1..255 characters; a taken name is replaced, a built-in of that name hidden),"params":{…} (as image.adjustments.<kind> takes them),"group":str?="My Presets"} → {kind, name, replaced}"##,
            enabled: always,
            run: save,
            journal: false,
        },
        CommandSpec {
            id: "adjustment.presets.edit",
            label: "Edit Adjustment Presets",
            menu: &[],
            shortcut: None,
            params: r##"{"kind":adjustment kind,"action":"rename|delete","name":str|[names] (delete takes several, all or none),"newName":str (rename)} → {name} | {deleted}"##,
            enabled: always,
            run: edit,
            journal: false,
        },
        CommandSpec {
            id: "adjustment.presets.reset",
            label: "Reset Adjustment Presets",
            menu: &[],
            shortcut: None,
            params: r##"{"kind":adjustment kind} → {restored, renamed:[[old, new]]} (the built-ins come back with their names; your presets stay, renamed with a number where they share a built-in's name)"##,
            enabled: always,
            run: reset,
            journal: false,
        },
        CommandSpec {
            id: "adjustment.presets.load",
            label: "Load Adjustment Preset…",
            menu: &[],
            shortcut: None,
            params: r##"{"path":".alv/.acv/.ahu/.cha/.asv/.blw file"?,"data":base64 bytes?,"fileName":str? (with data: the file's name, for its kind and the preset's name),"kind":adjustment kind? (default: from the extension),"name":str?=the file's name,"group":str?="My Presets"} → {kind, added:[name], report:[notes]} (a taken name gets " 2", " 3"…)"##,
            enabled: always,
            run: load,
            journal: false,
        },
        CommandSpec {
            id: "adjustment.presets.export",
            label: "Save Adjustment Preset File…",
            menu: &[],
            shortcut: None,
            params: r##"{"kind":"levels|curves|hueSaturation|channelMixer|selectiveColor|blackWhite","params":{…}? (the settings to write) | "name":str? | "id":built-in id? (a preset to write),"path":file to write?} → {path, bytes} | {data: base64, fileName, bytes} (Photoshop's file of the kind: .alv, .acv, .ahu, .cha, .asv or .blw)"##,
            enabled: always,
            run: export,
            journal: false,
        },
    ];
    v.extend(panel::specs());
    v
}

#[cfg(test)]
mod tests;
