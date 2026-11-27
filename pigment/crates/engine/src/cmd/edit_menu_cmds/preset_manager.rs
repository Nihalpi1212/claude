//! Pigment: Edit › Presets › Preset Manager for every preset kind (PORTS-A §3.1, rows 21 and 23).
//!
//! One command, `edit.presets.presetManager`, lists and edits the nine libraries Photoshop's
//! Preset Manager shows: brushes, swatches, gradients, styles, patterns, contours, custom shapes,
//! tool presets and (Pigment's own) adjustment presets. Each kind is a [`Library`] that
//! delegates to the kind's own commands (`swatches.*`, `gradient.presets.*`,
//! `style.presets.*`, …) through [`crate::presets::call`], so every rule those commands keep
//! (unique names, the current brush following a rename, the pattern folders, the built-in
//! adjustment presets that come back on Reset) holds here too, and the outer command is the one
//! step an action records.
//!
//! A preset is addressed by its position in the kind's list (`index`, or `indices` for several:
//! the manager's multi-select), or by `name` (and `group`). `load` and `saveSet` dispatch by the
//! file's extension to the kind's import and export; `reset` runs the kind's reset where one
//! exists.

use serde_json::{Map, Value, json};

use super::{EngineError, PRESET_FORMAT, PresetFile, Result, Session, bad, str_or};
use crate::presets::call;

const CMD: &str = "edit.presets.presetManager";

/// The kinds, in Photoshop's Preset Type order (adjustments, Pigment's own, last).
pub const PRESET_KINDS: [&str; 9] = ["brushes", "swatches", "gradients", "styles", "patterns", "contours", "customShapes", "tools", "adjustments"];

/// One preset as the manager lists it.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    /// The folder it is in (empty for the flat kinds: contours, tools).
    pub group: String,
    /// Its name.
    pub name: String,
    /// What the kind's commands call it: a pattern's id, an adjustment preset's kind, else the
    /// name.
    pub key: String,
    /// A thumbnail hint the interface needs and cannot look up by `key`: a swatch's colour
    /// (`#rrggbb`).
    pub hint: Option<String>,
}

impl Row {
    fn new(group: impl Into<String>, name: impl Into<String>) -> Self {
        let name = name.into();
        Row { group: group.into(), key: name.clone(), name, hint: None }
    }

    fn json(&self, index: usize) -> Value {
        let mut v = json!({"index": index, "group": self.group, "name": self.name, "key": self.key});
        if let Some(h) = &self.hint {
            v["hint"] = json!(h);
        }
        v
    }
}

/// A preset library the manager edits. Every method delegates to the kind's own commands; the
/// rows are in the order the kind's panel shows them.
pub trait Library: Sync {
    /// The kind's id in `edit.presets.presetManager`.
    fn id(&self) -> &'static str;
    /// The thumbnail the interface draws (`brush|swatch|gradient|style|pattern|contour|shape|tool|adjustment`).
    fn thumb(&self) -> &'static str;
    /// The presets, in display order.
    fn rows(&self, s: &mut Session) -> Result<Vec<Row>>;
    /// Renames `row` to `to`.
    fn rename(&self, s: &mut Session, row: &Row, to: &str) -> Result<()>;
    /// Deletes `rows` (all exist: the caller resolved them).
    fn delete(&self, s: &mut Session, rows: &[Row]) -> Result<()>;
    /// Moves `row` to `dest`; `rest` is the list without it.
    fn move_to(&self, s: &mut Session, row: &Row, rest: &[Row], dest: &Dest) -> Result<()>;
    /// The kind's reset command, `None` when it has none.
    fn reset_command(&self) -> Option<&'static str> {
        None
    }
    /// Empties the library before a Replace whose import cannot replace on its own.
    fn clear(&self, s: &mut Session) -> Result<()>;
    /// The extensions Save Set… writes, the first the default (the kind's Photoshop file,
    /// else `.pcpresets`).
    fn save_extensions(&self) -> &'static [&'static str];
    /// The extension Save Set… of `rows` writes when none is asked for.
    fn save_extension_for(&self, _rows: &[Row]) -> &'static str {
        self.save_extensions()[0]
    }
    /// Writes `rows` as a file of `ext`: `{data (base64), bytes, count}`.
    fn save_set(&self, s: &mut Session, rows: &[Row], ext: &str) -> Result<Value>;
}

/// The library of `kind`.
pub fn library(kind: &str) -> Option<&'static dyn Library> {
    Some(match kind {
        "brushes" => &Brushes,
        "swatches" => &Swatches,
        "gradients" => &Gradients,
        "styles" => &Styles,
        "patterns" => &Patterns,
        "contours" => &Contours,
        "customShapes" => &Shapes,
        "tools" => &Tools,
        "adjustments" => &Adjustments,
        _ => return None,
    })
}

fn library_or_err(kind: &str) -> Result<&'static dyn Library> {
    library(kind).ok_or_else(|| bad(CMD, format!("unknown preset kind `{kind}` ({})", PRESET_KINDS.join("|"))))
}

/// A file the manager loads: its extension, the kind it holds and the command that imports it.
/// Commands a later package adds (`tool.presets.importTpl`, P2) count only once they exist.
const LOADERS: &[(&str, &str, &str)] = &[
    ("abr", "brushes", "brush.presets.importAbr"),
    ("aco", "swatches", "swatches.import"),
    ("ase", "swatches", "swatches.import"),
    ("act", "swatches", "swatches.import"),
    ("gpl", "swatches", "swatches.import"),
    ("grd", "gradients", "gradient.presets.importGrd"),
    ("asl", "styles", "style.presets.importAsl"),
    ("pat", "patterns", "pattern.import"),
    ("shc", "contours", "layer.layerStyle.contours.load"),
    ("csh", "customShapes", "shape.presets.importCsh"),
    ("tpl", "tools", "tool.presets.importTpl"),
    ("alv", "adjustments", "adjustment.presets.load"),
    ("acv", "adjustments", "adjustment.presets.load"),
    ("ahu", "adjustments", "adjustment.presets.load"),
    ("cha", "adjustments", "adjustment.presets.load"),
    ("asv", "adjustments", "adjustment.presets.load"),
    ("blw", "adjustments", "adjustment.presets.load"),
    ("pcpresets", "brushes", "edit.presets.exportImportPresets"),
    ("pcpresets", "customShapes", "edit.presets.exportImportPresets"),
    ("pcpresets", "tools", "edit.presets.exportImportPresets"),
];

/// The extensions Load… of `kind` reads (lowercase, no dot).
pub fn load_extensions(kind: &str) -> Vec<&'static str> {
    LOADERS.iter().filter(|(_, k, cmd)| *k == kind && crate::commands::find(cmd).is_some()).map(|(ext, ..)| *ext).collect()
}

/// The kind a file of `ext` loads into, when only one kind takes it.
fn kind_of_extension(ext: &str) -> Option<&'static str> {
    let mut kinds = LOADERS.iter().filter(|(e, _, cmd)| *e == ext && crate::commands::find(cmd).is_some()).map(|(_, k, _)| *k);
    let first = kinds.next()?;
    kinds.all(|k| k == first).then_some(first)
}

/// The lowercase extension of `name`.
fn extension(name: &str) -> Option<String> {
    let file = name.rsplit(['/', '\\']).next().unwrap_or(name);
    file.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).filter(|e| !e.is_empty())
}

/// The file's name without folders and extension.
fn stem(name: &str) -> String {
    let file = name.rsplit(['/', '\\']).next().unwrap_or(name);
    file.rsplit_once('.').map_or(file, |(s, _)| s).trim().to_string()
}

// ------------------------------------------------------------------ the command

pub(crate) fn preset_manager(s: &mut Session, p: &Value) -> Result<Value> {
    match str_or(p, "action", "list") {
        "list" => list(s, p),
        "rename" => rename(s, p),
        "delete" => delete(s, p),
        "move" => move_preset(s, p),
        "load" => load(s, p),
        "saveSet" => save_set(s, p),
        "reset" => reset(s, p),
        other => Err(bad(CMD, format!("unknown action `{other}` (list|rename|delete|move|load|saveSet|reset)"))),
    }
}

/// `{<kind>: [names]}` for the kinds asked (all without `kind`), and under `info.<kind>` the rows
/// with their groups and keys, the thumbnail, the files Load… reads and Save Set… writes, and
/// whether the kind resets and reorders.
fn list(s: &mut Session, p: &Value) -> Result<Value> {
    let kinds: Vec<&str> = match p.get("kind") {
        None | Some(Value::Null) => PRESET_KINDS.to_vec(),
        Some(Value::String(k)) => vec![library_or_err(k)?.id()],
        Some(_) => return Err(bad(CMD, "`kind` must be a string")),
    };
    let mut out = Map::new();
    let mut info = Map::new();
    for kind in kinds {
        let lib = library_or_err(kind)?;
        let rows = lib.rows(s)?;
        out.insert(kind.to_string(), json!(rows.iter().map(|r| r.name.clone()).collect::<Vec<_>>()));
        info.insert(
            kind.to_string(),
            json!({
                "thumb": lib.thumb(),
                "rows": rows.iter().enumerate().map(|(i, r)| r.json(i)).collect::<Vec<_>>(),
                "canReset": lib.reset_command().is_some(),
                "canMove": kind != "adjustments",
                "load": load_extensions(kind),
                "save": lib.save_extensions(),
            }),
        );
    }
    out.insert("info".into(), Value::Object(info));
    Ok(Value::Object(out))
}

fn kind_param(p: &Value) -> Result<&'static dyn Library> {
    let kind = p.get("kind").and_then(Value::as_str).ok_or_else(|| bad(CMD, "missing `kind`"))?;
    library_or_err(kind)
}

/// The row `p` names: `index`, else `name` (within `group` when given).
fn row_of(rows: &[Row], p: &Value) -> Result<usize> {
    if let Some(v) = p.get("index") {
        let i = v.as_u64().ok_or_else(|| bad(CMD, "`index` must be a non-negative integer"))?;
        return usize::try_from(i).ok().filter(|&i| i < rows.len()).ok_or_else(|| bad(CMD, format!("no preset {i}")));
    }
    let name = p.get("name").and_then(Value::as_str).ok_or_else(|| bad(CMD, "give `index` or `name`"))?;
    let group = p.get("group").and_then(Value::as_str);
    rows.iter()
        .position(|r| r.name == name && group.is_none_or(|g| r.group == g))
        .ok_or_else(|| bad(CMD, format!("no preset named `{name}`")))
}

/// The rows `p` names: `indices` (several, all or none), else one by `index` or `name`.
fn rows_of(rows: &[Row], p: &Value) -> Result<Vec<Row>> {
    let Some(v) = p.get("indices") else { return row_of(rows, p).map(|i| vec![rows[i].clone()]) };
    let list = v.as_array().ok_or_else(|| bad(CMD, "`indices` must be a list of preset positions"))?;
    if list.is_empty() {
        return Err(bad(CMD, "`indices` is empty"));
    }
    let mut at: Vec<usize> = Vec::with_capacity(list.len());
    for i in list {
        let i = i.as_u64().and_then(|i| usize::try_from(i).ok()).ok_or_else(|| bad(CMD, "`indices` must be non-negative integers"))?;
        if i >= rows.len() {
            return Err(bad(CMD, format!("no preset {i}")));
        }
        at.push(i);
    }
    at.sort_unstable();
    at.dedup();
    Ok(at.into_iter().map(|i| rows[i].clone()).collect())
}

/// `{<kind>: [names]}` after an edit, and the kind's rows under `info`.
fn changed(s: &mut Session, lib: &dyn Library) -> Result<Value> {
    s.presets_changed();
    list(s, &json!({"kind": lib.id()}))
}

fn rename(s: &mut Session, p: &Value) -> Result<Value> {
    let lib = kind_param(p)?;
    let rows = lib.rows(s)?;
    let row = rows[row_of(&rows, p)?].clone();
    let to = p.get("newName").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty()).ok_or_else(|| bad(CMD, "missing `newName`"))?;
    if to != row.name {
        lib.rename(s, &row, to)?;
    }
    changed(s, lib)
}

fn delete(s: &mut Session, p: &Value) -> Result<Value> {
    let lib = kind_param(p)?;
    let rows = lib.rows(s)?;
    let gone = rows_of(&rows, p)?;
    lib.delete(s, &gone)?;
    changed(s, lib)
}

fn move_preset(s: &mut Session, p: &Value) -> Result<Value> {
    let lib = kind_param(p)?;
    let rows = lib.rows(s)?;
    let from = row_of(&rows, p)?;
    let row = rows[from].clone();
    let mut rest = rows;
    rest.remove(from);
    let dest = match (p.get("toGroup"), p.get("to")) {
        // `toGroup` (and `position` in it, else its end).
        (Some(g), _) => {
            let group = g.as_str().ok_or_else(|| bad(CMD, "`toGroup` must be a group name"))?.to_string();
            if !rest.iter().any(|r| r.group == group) && row.group != group {
                return Err(bad(CMD, format!("no group \"{group}\"")));
            }
            let index = match p.get("position") {
                None | Some(Value::Null) => None,
                Some(v) => Some(v.as_u64().and_then(|i| usize::try_from(i).ok()).ok_or_else(|| bad(CMD, "`position` must be a non-negative integer"))?),
            };
            Dest::new(&rest, group, index)
        }
        // `to`: the position in the whole list the preset ends up at; it joins the folder of the
        // preset it lands before (at the end: the last folder).
        (None, Some(v)) => {
            let to = v.as_u64().and_then(|i| usize::try_from(i).ok()).ok_or_else(|| bad(CMD, "`to` must be a non-negative integer"))?;
            match rest.get(to) {
                Some(before) => {
                    let index = rest.iter().filter(|r| r.group == before.group).position(|r| r == before);
                    Dest::new(&rest, before.group.clone(), index)
                }
                None => Dest::new(&rest, rest.last().map_or_else(|| row.group.clone(), |r| r.group.clone()), None),
            }
        }
        (None, None) => return Err(bad(CMD, "give `to` (a position in the list) or `toGroup` (and `position`)")),
    };
    lib.move_to(s, &row, &rest, &dest)?;
    changed(s, lib)
}

/// Where a moved preset goes: a folder, its position there among the other presets (`None` =
/// the end), the preset it lands before, and its position in the whole list without it.
#[derive(Clone, Debug)]
pub struct Dest {
    pub group: String,
    pub index: Option<usize>,
    pub before: Option<Row>,
    pub flat: usize,
}

impl Dest {
    fn new(rest: &[Row], group: String, index: Option<usize>) -> Self {
        let in_group: Vec<usize> = rest.iter().enumerate().filter(|(_, r)| r.group == group).map(|(i, _)| i).collect();
        let index = index.filter(|&i| i < in_group.len());
        let before = index.map(|i| rest[in_group[i]].clone());
        let flat = match index {
            Some(i) => in_group[i],
            None => in_group.last().map_or(rest.len(), |&last| last + 1),
        };
        Dest { group, index, before, flat }
    }
}

/// What a session's libraries hold, so a Replace that fails part way changes nothing.
struct Backup {
    presets: crate::presets::PresetState,
    brushes: Vec<photocraft_paint::BrushPreset>,
    current_brush: Option<String>,
    patterns: crate::pattern_cmds::PatternLibrary,
    custom_shapes: Vec<super::CustomShape>,
}

impl Backup {
    fn take(s: &Session) -> Self {
        Backup {
            presets: s.presets.clone(),
            brushes: s.tools.presets.clone(),
            current_brush: s.tools.current_preset.clone(),
            patterns: s.patterns.clone(),
            custom_shapes: s.edit_state.custom_shapes.clone(),
        }
    }

    fn restore(self, s: &mut Session) {
        let rev = s.presets.rev;
        s.presets = self.presets;
        s.presets.rev = rev + 1;
        s.tools.presets = self.brushes;
        s.tools.current_preset = self.current_brush;
        s.patterns = self.patterns;
        s.edit_state.custom_shapes = self.custom_shapes;
        s.brush_presets_changed();
    }
}

/// Load… and Replace…: `{"kind"?, "path"|"data", "fileName"?, "replace":bool=false}`.
fn load(s: &mut Session, p: &Value) -> Result<Value> {
    let name = p.get("fileName").or_else(|| p.get("path")).and_then(Value::as_str).unwrap_or_default().to_string();
    let ext = extension(&name).ok_or_else(|| bad(CMD, "give `path`, or `data` with a `fileName`: the extension says what the file holds"))?;
    let kind = match p.get("kind").and_then(Value::as_str) {
        Some(k) => library_or_err(k)?.id(),
        None => kind_of_extension(&ext).ok_or_else(|| bad(CMD, format!("give `kind`: .{ext} is not a preset file the manager reads, or several kinds take it")))?,
    };
    let (_, _, command) = LOADERS
        .iter()
        .find(|(e, k, cmd)| *e == ext && *k == kind && crate::commands::find(cmd).is_some())
        .ok_or_else(|| bad(CMD, format!("{kind} do not load from .{ext} files (they load from {})", load_extensions(kind).join(", "))))?;
    let replace = match p.get("replace") {
        None | Some(Value::Null) => false,
        Some(v) => v.as_bool().ok_or_else(|| bad(CMD, "`replace` must be a boolean"))?,
    };
    if replace && kind == "adjustments" {
        return Err(bad(CMD, "an adjustment preset file holds one preset: load it, there is no library to replace"));
    }
    let mut q = Map::new();
    match (p.get("data"), p.get("path")) {
        (Some(d), _) => {
            let d = d.as_str().ok_or_else(|| bad(CMD, "`data` must be a base64 string"))?;
            q.insert("data".into(), json!(d));
        }
        (None, Some(path)) => {
            q.insert("path".into(), path.clone());
        }
        (None, None) => return Err(bad(CMD, "give `path` or `data`")),
    }
    let group = stem(&name);
    let lib = library_or_err(kind)?;
    // The commands that keep the file's name as the new group's take it from `path` only.
    let named_group = matches!(*command, "brush.presets.importAbr" | "swatches.import" | "gradient.presets.importGrd" | "style.presets.importAsl" | "shape.presets.importCsh");
    if named_group && p.get("data").is_some() && !group.is_empty() {
        q.insert("group".into(), json!(group));
    }
    let mut own_replace = false;
    match *command {
        "swatches.import" => {
            q.insert("format".into(), json!(ext));
            q.insert("mode".into(), json!(if replace { "replace" } else { "append" }));
            own_replace = true;
        }
        "layer.layerStyle.contours.load" => {
            q.insert("mode".into(), json!(if replace { "replace" } else { "append" }));
            own_replace = true;
        }
        // Load… adds beside a group of the same name; Replace… has emptied the library first.
        "style.presets.importAsl" => drop(q.insert("replace".into(), json!(false))),
        "adjustment.presets.load" => drop(q.insert("fileName".into(), json!(name))),
        "edit.presets.exportImportPresets" => {
            let bytes = match q.remove("data") {
                Some(Value::String(d)) => photocraft_paint::tile::b64_decode(&d).ok_or_else(|| bad(CMD, "`data` is not valid base64"))?,
                _ => {
                    let path = q.remove("path").and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
                    std::fs::read(&path).map_err(|e| EngineError::Other(format!("{path}: {e}")))?
                }
            };
            let text = String::from_utf8(bytes).map_err(|_| bad(CMD, format!("{name} is not a preset file")))?;
            q.insert("action".into(), json!("import"));
            q.insert("kinds".into(), json!([kind]));
            q.insert("data".into(), json!(text));
        }
        _ => {}
    }
    // A brush import can finish on a worker (`jobs::run`), after this command returns: read the file
    // first, so a Replace… of a damaged file never empties the library.
    if replace && *command == "brush.presets.importAbr" {
        let (bytes, _) = crate::preset_import_cmds::file_bytes(&Value::Object(q.clone()), CMD, ".abr file")?;
        photocraft_io::abr_map::read_abr(&bytes, &group).map_err(|e| bad(CMD, e))?;
    }
    let backup = (replace && !own_replace).then(|| Backup::take(s));
    let result = (|| {
        if replace && !own_replace {
            lib.clear(s)?;
        }
        call(s, command, Value::Object(q))
    })();
    let reply = match result {
        Ok(reply) => reply,
        Err(e) => {
            if let Some(b) = backup {
                b.restore(s);
            }
            return Err(e);
        }
    };
    if kind == "brushes" {
        s.brush_presets_changed();
    }
    let mut out = changed(s, lib)?;
    out["kind"] = json!(kind);
    out["loaded"] = reply;
    Ok(out)
}

/// Save Set…: `{"kind","indices"?=all,"path"?,"format"?}` → `{fileName, count, bytes, path | data}`.
fn save_set(s: &mut Session, p: &Value) -> Result<Value> {
    let lib = kind_param(p)?;
    let rows = lib.rows(s)?;
    let chosen = if p.get("indices").is_some() || p.get("index").is_some() || p.get("name").is_some() { rows_of(&rows, p)? } else { rows };
    if chosen.is_empty() {
        return Err(bad(CMD, format!("there are no {} to save", lib.id())));
    }
    let path = p.get("path").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
    let exts = lib.save_extensions();
    let ext = match p.get("format").and_then(Value::as_str).map(str::to_ascii_lowercase).or_else(|| path.and_then(extension)) {
        Some(e) if exts.contains(&e.as_str()) => e,
        Some(e) => return Err(bad(CMD, format!("{} save as {}, not .{e}", lib.id(), exts.iter().map(|x| format!(".{x}")).collect::<Vec<_>>().join(", ")))),
        None => lib.save_extension_for(&chosen).to_string(),
    };
    let out = lib.save_set(s, &chosen, &ext)?;
    let data = out.get("data").and_then(Value::as_str).ok_or_else(|| EngineError::Other("the export returned no data".into()))?;
    let bytes = photocraft_paint::tile::b64_decode(data).ok_or_else(|| EngineError::Other("the export returned damaged data".into()))?;
    let base = if chosen.len() == 1 { chosen[0].name.clone() } else { default_set_name(lib.id()).to_string() };
    let base: String = base.chars().filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')).collect();
    let base = if base.trim().is_empty() { default_set_name(lib.id()) } else { base.trim() };
    let mut reply = json!({"kind": lib.id(), "fileName": format!("{base}.{ext}"), "count": chosen.len(), "bytes": bytes.len()});
    match path {
        Some(path) => {
            crate::file_cmds::write_file(path, &bytes)?;
            reply["path"] = json!(path);
        }
        None => reply["data"] = json!(data),
    }
    Ok(reply)
}

/// The file name Save Set… suggests for several presets of `kind`.
fn default_set_name(kind: &str) -> &'static str {
    match kind {
        "brushes" => "Brushes",
        "swatches" => "Swatches",
        "gradients" => "Gradients",
        "styles" => "Styles",
        "patterns" => "Patterns",
        "contours" => "Contours",
        "customShapes" => "Custom Shapes",
        "tools" => "Tool Presets",
        _ => "Presets",
    }
}

fn reset(s: &mut Session, p: &Value) -> Result<Value> {
    let lib = kind_param(p)?;
    if lib.id() == "adjustments" {
        // Every kind's built-ins come back; the user's own presets stay (`adjustment.presets.reset`).
        for kind in crate::presets::adjustments::KINDS {
            call(s, "adjustment.presets.reset", json!({"kind": kind}))?;
        }
        return changed(s, lib);
    }
    let command = lib.reset_command().ok_or_else(|| bad(CMD, format!("{} have no default set to reset to", lib.id())))?;
    call(s, command, json!({}))?;
    changed(s, lib)
}

// ------------------------------------------------------------------ helpers shared by the kinds

/// The names of `rows`.
fn names(rows: &[Row]) -> Vec<String> {
    rows.iter().map(|r| r.name.clone()).collect()
}

/// `{data, bytes, count}` of `bytes`.
fn data_reply(bytes: &[u8], count: usize) -> Value {
    json!({"data": photocraft_paint::tile::b64_encode(bytes), "bytes": bytes.len(), "count": count})
}

/// A `.pcpresets` file of the given presets (the format `edit.presets.exportImportPresets` reads).
fn pcpresets(file: PresetFile, count: usize) -> Result<Value> {
    let text = serde_json::to_vec_pretty(&file).map_err(|e| EngineError::Other(e.to_string()))?;
    Ok(data_reply(&text, count))
}

fn empty_file() -> PresetFile {
    PresetFile { format: PRESET_FORMAT.into(), version: 1, ..PresetFile::default() }
}

/// A group edit (`<prefix>.edit`) of the kinds whose presets are `Group<T>`s with names unique
/// across the library: gradients, styles.
fn group_rename(s: &mut Session, edit: &str, row: &Row, to: &str) -> Result<()> {
    call(s, edit, json!({"action": "rename", "preset": row.key, "group": row.group, "name": to})).map(drop)
}

fn group_delete(s: &mut Session, edit: &str, rows: &[Row]) -> Result<()> {
    let keys: Vec<&str> = rows.iter().map(|r| r.key.as_str()).collect();
    call(s, edit, json!({"action": "delete", "preset": keys})).map(drop)
}

fn group_move(s: &mut Session, edit: &str, row: &Row, dest: &Dest) -> Result<()> {
    let mut q = json!({"action": "move", "preset": row.key, "group": row.group, "to": dest.group});
    if let Some(i) = dest.index {
        q["index"] = json!(i);
    }
    call(s, edit, q).map(drop)
}

/// Moves `row` of a flat list (rows in library order) to `dest.flat`.
fn flat_move<T>(v: &mut Vec<T>, all: &[Row], row: &Row, dest: &Dest) {
    if let Some(from) = all.iter().position(|r| r == row) {
        crate::move_item(v, from, dest.flat);
    }
}

// ------------------------------------------------------------------ the kinds

struct Brushes;

impl Library for Brushes {
    fn id(&self) -> &'static str {
        "brushes"
    }
    fn thumb(&self) -> &'static str {
        "brush"
    }
    fn rows(&self, s: &mut Session) -> Result<Vec<Row>> {
        Ok(s.tools.presets.iter().map(|b| Row::new(b.group.clone(), b.name.clone())).collect())
    }
    fn rename(&self, s: &mut Session, row: &Row, to: &str) -> Result<()> {
        let i = s.tools.presets.iter().position(|b| b.name == row.name).ok_or_else(|| bad(CMD, format!("no brush `{}`", row.name)))?;
        // Same rules as Brush Settings: no duplicate names (case-insensitive), the current
        // preset follows, a renamed built-in is the user's preset now.
        crate::brush_preset_cmds::rename_at(s, i, to, CMD)?;
        s.brush_presets_changed();
        Ok(())
    }
    fn delete(&self, s: &mut Session, rows: &[Row]) -> Result<()> {
        for row in rows {
            if let Some(i) = s.tools.presets.iter().position(|b| b.name == row.name) {
                let gone = s.tools.presets.remove(i);
                crate::brush_cmds::forget_deleted_preset(s, &gone.name);
            }
        }
        s.brush_presets_changed();
        Ok(())
    }
    fn move_to(&self, s: &mut Session, row: &Row, _: &[Row], dest: &Dest) -> Result<()> {
        let mut q = json!({"name": row.name, "group": dest.group});
        if let Some(before) = &dest.before {
            q["before"] = json!(before.name);
        }
        call(s, "brush.presets.move", q).map(drop)
    }
    fn clear(&self, s: &mut Session) -> Result<()> {
        let all: Vec<String> = s.tools.presets.iter().map(|b| b.name.clone()).collect();
        s.tools.presets.clear();
        for name in all {
            crate::brush_cmds::forget_deleted_preset(s, &name);
        }
        Ok(())
    }
    fn save_extensions(&self) -> &'static [&'static str] {
        // No BrushSettings → descriptor encoder exists for a Photoshop .abr.
        &["pcpresets"]
    }
    fn save_set(&self, s: &mut Session, rows: &[Row], _: &str) -> Result<Value> {
        let mut file = empty_file();
        for row in rows {
            let Some(b) = s.tools.presets.iter().find(|b| b.name == row.name) else { continue };
            let mut b = b.clone();
            // The file embeds every bitmap: load the tips the preset store keeps.
            s.load_brush_tips(&mut b.brush).map_err(|e| bad(CMD, format!("brush preset `{}`: {e}", b.name)))?;
            file.brushes.push(b);
        }
        let n = file.brushes.len();
        pcpresets(file, n)
    }
}

struct Swatches;

impl Library for Swatches {
    fn id(&self) -> &'static str {
        "swatches"
    }
    fn thumb(&self) -> &'static str {
        "swatch"
    }
    fn rows(&self, s: &mut Session) -> Result<Vec<Row>> {
        let listed = call(s, "swatches.list", json!({}))?;
        let mut rows = Vec::new();
        for g in listed["groups"].as_array().into_iter().flatten() {
            let group = g["name"].as_str().unwrap_or_default();
            for sw in g["swatches"].as_array().into_iter().flatten() {
                let mut row = Row::new(group, sw["name"].as_str().unwrap_or_default());
                row.hint = sw["hex"].as_str().map(str::to_string);
                rows.push(row);
            }
        }
        Ok(rows)
    }
    fn rename(&self, s: &mut Session, row: &Row, to: &str) -> Result<()> {
        call(s, "swatches.rename", json!({"swatch": row.name, "group": row.group, "name": to})).map(drop)
    }
    fn delete(&self, s: &mut Session, rows: &[Row]) -> Result<()> {
        // One call per group: a name narrows to its group, all or none within it.
        let mut groups: Vec<&str> = rows.iter().map(|r| r.group.as_str()).collect();
        groups.dedup();
        for g in groups {
            let names: Vec<&str> = rows.iter().filter(|r| r.group == g).map(|r| r.name.as_str()).collect();
            call(s, "swatches.delete", json!({"swatch": names, "group": g}))?;
        }
        Ok(())
    }
    fn move_to(&self, s: &mut Session, row: &Row, _: &[Row], dest: &Dest) -> Result<()> {
        let mut q = json!({"swatch": row.name, "group": row.group, "to": dest.group});
        if let Some(i) = dest.index {
            q["position"] = json!(i);
        }
        call(s, "swatches.move", q).map(drop)
    }
    fn reset_command(&self) -> Option<&'static str> {
        Some("swatches.reset")
    }
    fn clear(&self, s: &mut Session) -> Result<()> {
        s.presets.swatches.clear();
        Ok(())
    }
    fn save_extensions(&self) -> &'static [&'static str] {
        &["aco", "ase", "act", "gpl", "css"]
    }
    fn save_set(&self, s: &mut Session, rows: &[Row], ext: &str) -> Result<Value> {
        let mut q = json!({"format": ext, "swatches": names(rows)});
        let mut groups: Vec<&str> = rows.iter().map(|r| r.group.as_str()).collect();
        groups.dedup();
        if let [g] = groups.as_slice() {
            q["group"] = json!(g);
        }
        call(s, "swatches.export", q)
    }
}

struct Gradients;

impl Library for Gradients {
    fn id(&self) -> &'static str {
        "gradients"
    }
    fn thumb(&self) -> &'static str {
        "gradient"
    }
    fn rows(&self, s: &mut Session) -> Result<Vec<Row>> {
        Ok(s.presets.gradients.iter().flat_map(|g| g.items.iter().map(|i| Row::new(g.name.clone(), i.name.clone()))).collect())
    }
    fn rename(&self, s: &mut Session, row: &Row, to: &str) -> Result<()> {
        group_rename(s, "gradient.presets.edit", row, to)
    }
    fn delete(&self, s: &mut Session, rows: &[Row]) -> Result<()> {
        group_delete(s, "gradient.presets.edit", rows)
    }
    fn move_to(&self, s: &mut Session, row: &Row, _: &[Row], dest: &Dest) -> Result<()> {
        group_move(s, "gradient.presets.edit", row, dest)
    }
    fn reset_command(&self) -> Option<&'static str> {
        Some("gradient.presets.reset")
    }
    fn clear(&self, s: &mut Session) -> Result<()> {
        s.presets.gradients.clear();
        Ok(())
    }
    fn save_extensions(&self) -> &'static [&'static str] {
        &["grd"]
    }
    fn save_set(&self, s: &mut Session, rows: &[Row], _: &str) -> Result<Value> {
        call(s, "gradient.presets.exportGrd", json!({"names": names(rows)}))
    }
}

struct Styles;

impl Library for Styles {
    fn id(&self) -> &'static str {
        "styles"
    }
    fn thumb(&self) -> &'static str {
        "style"
    }
    fn rows(&self, s: &mut Session) -> Result<Vec<Row>> {
        Ok(s.presets.styles.iter().flat_map(|g| g.items.iter().map(|i| Row::new(g.name.clone(), i.name.clone()))).collect())
    }
    fn rename(&self, s: &mut Session, row: &Row, to: &str) -> Result<()> {
        group_rename(s, "style.presets.edit", row, to)
    }
    fn delete(&self, s: &mut Session, rows: &[Row]) -> Result<()> {
        group_delete(s, "style.presets.edit", rows)
    }
    fn move_to(&self, s: &mut Session, row: &Row, _: &[Row], dest: &Dest) -> Result<()> {
        group_move(s, "style.presets.edit", row, dest)
    }
    fn reset_command(&self) -> Option<&'static str> {
        Some("style.presets.reset")
    }
    fn clear(&self, s: &mut Session) -> Result<()> {
        s.presets.styles.clear();
        Ok(())
    }
    fn save_extensions(&self) -> &'static [&'static str] {
        &["asl"]
    }
    fn save_set(&self, s: &mut Session, rows: &[Row], _: &str) -> Result<Value> {
        call(s, "style.presets.exportAsl", json!({"styles": names(rows)}))
    }
}

struct Patterns;

impl Library for Patterns {
    fn id(&self) -> &'static str {
        "patterns"
    }
    fn thumb(&self) -> &'static str {
        "pattern"
    }
    fn rows(&self, s: &mut Session) -> Result<Vec<Row>> {
        crate::presets::patterns::sync(s);
        let lib = &s.patterns.items;
        Ok(s.presets
            .pattern_groups
            .iter()
            .flat_map(|g| {
                g.items.iter().filter_map(|id| lib.iter().find(|p| &p.id == id)).map(|p| Row { group: g.name.clone(), name: p.display_name().to_string(), key: p.id.clone(), hint: None })
            })
            .collect())
    }
    fn rename(&self, s: &mut Session, row: &Row, to: &str) -> Result<()> {
        call(s, "pattern.presets.edit", json!({"action": "rename", "preset": row.key, "name": to})).map(drop)
    }
    fn delete(&self, s: &mut Session, rows: &[Row]) -> Result<()> {
        let keys: Vec<&str> = rows.iter().map(|r| r.key.as_str()).collect();
        call(s, "pattern.presets.edit", json!({"action": "delete", "preset": keys})).map(drop)
    }
    fn move_to(&self, s: &mut Session, row: &Row, _: &[Row], dest: &Dest) -> Result<()> {
        group_move(s, "pattern.presets.edit", row, dest)
    }
    fn clear(&self, s: &mut Session) -> Result<()> {
        let ids: Vec<String> = s.patterns.items.iter().map(|p| p.id.clone()).collect();
        for id in ids {
            call(s, "pattern.delete", json!({"pattern": id}))?;
        }
        Ok(())
    }
    fn save_extensions(&self) -> &'static [&'static str] {
        &["pat"]
    }
    fn save_set(&self, s: &mut Session, rows: &[Row], _: &str) -> Result<Value> {
        let keys: Vec<&str> = rows.iter().map(|r| r.key.as_str()).collect();
        call(s, "pattern.export", json!({"patterns": keys}))
    }
}

struct Contours;

impl Library for Contours {
    fn id(&self) -> &'static str {
        "contours"
    }
    fn thumb(&self) -> &'static str {
        "contour"
    }
    fn rows(&self, s: &mut Session) -> Result<Vec<Row>> {
        let listed = call(s, "layer.layerStyle.contours.list", json!({}))?;
        Ok(listed["contours"].as_array().into_iter().flatten().map(|c| Row::new("", c["name"].as_str().unwrap_or_default())).collect())
    }
    fn rename(&self, s: &mut Session, row: &Row, to: &str) -> Result<()> {
        // The contour library has no rename command: the Contour Editor names a contour when it
        // is made. Rename keeps the library's rules (unique, never a standard contour's name).
        let lib = &s.presets.contours;
        let taken = |n: &str| lib.iter().any(|c| matches!(c, photocraft_doc::Contour::Custom { name, .. } if name == n));
        if taken(to) || crate::layer_style::builtin_contour(to).is_some() {
            return Err(bad(CMD, format!("a contour named \"{to}\" already exists")));
        }
        let to: String = to.chars().take(crate::contour_lib_cmds::MAX_NAME).collect();
        for c in &mut s.presets.contours {
            if let photocraft_doc::Contour::Custom { name, .. } = c
                && *name == row.name
            {
                *name = to;
                return Ok(());
            }
        }
        Err(bad(CMD, format!("no user contour \"{}\"", row.name)))
    }
    fn delete(&self, s: &mut Session, rows: &[Row]) -> Result<()> {
        for row in rows {
            call(s, "layer.layerStyle.contours.delete", json!({"name": row.name}))?;
        }
        Ok(())
    }
    fn move_to(&self, s: &mut Session, row: &Row, _: &[Row], dest: &Dest) -> Result<()> {
        let all = self.rows(s)?;
        flat_move(&mut s.presets.contours, &all, row, dest);
        Ok(())
    }
    fn clear(&self, s: &mut Session) -> Result<()> {
        s.presets.contours.clear();
        Ok(())
    }
    fn save_extensions(&self) -> &'static [&'static str] {
        &["shc"]
    }
    fn save_set(&self, s: &mut Session, rows: &[Row], _: &str) -> Result<Value> {
        call(s, "layer.layerStyle.contours.save", json!({"names": names(rows)}))
    }
}

struct Shapes;

impl Shapes {
    fn is_custom(s: &Session, row: &Row) -> bool {
        row.group == crate::presets::shapes::CUSTOM_GROUP && s.edit_state.custom_shapes.iter().any(|c| c.name == row.name)
    }
}

impl Library for Shapes {
    fn id(&self) -> &'static str {
        "customShapes"
    }
    fn thumb(&self) -> &'static str {
        "shape"
    }
    fn rows(&self, s: &mut Session) -> Result<Vec<Row>> {
        // The Shapes panel's library: its groups and the Define Custom Shape results.
        Ok(crate::presets::shapes::all_groups(s).iter().flat_map(|g| g.items.iter().map(|i| Row::new(g.name.clone(), i.name.clone()))).collect())
    }
    fn rename(&self, s: &mut Session, row: &Row, to: &str) -> Result<()> {
        call(s, "shape.presets.edit", json!({"action": "rename", "preset": row.name, "group": row.group, "name": to})).map(drop)
    }
    fn delete(&self, s: &mut Session, rows: &[Row]) -> Result<()> {
        for row in rows {
            call(s, "shape.presets.edit", json!({"action": "delete", "preset": row.name, "group": row.group}))?;
        }
        Ok(())
    }
    fn move_to(&self, s: &mut Session, row: &Row, _: &[Row], dest: &Dest) -> Result<()> {
        let custom = crate::presets::shapes::CUSTOM_GROUP;
        let from_custom = Self::is_custom(s, row);
        if from_custom != (dest.group == custom) {
            // Define Custom Shape results stay in their own group, which reorders on its own.
            return Err(bad(CMD, format!("shapes go into and out of the \"{custom}\" group with Define Custom Shape only")));
        }
        if from_custom {
            let mine = s.edit_state.custom_shapes.iter().position(|c| c.name == row.name).unwrap_or(0);
            let to = dest.index.unwrap_or(usize::MAX);
            crate::move_item(&mut s.edit_state.custom_shapes, mine, to);
            return Ok(());
        }
        group_move(s, "shape.presets.edit", row, dest)
    }
    fn reset_command(&self) -> Option<&'static str> {
        Some("shape.presets.reset")
    }
    fn clear(&self, s: &mut Session) -> Result<()> {
        s.presets.shapes.clear();
        s.edit_state.custom_shapes.clear();
        Ok(())
    }
    fn save_extensions(&self) -> &'static [&'static str] {
        // craft-psd reads .csh but has no writer.
        &["pcpresets"]
    }
    fn save_set(&self, s: &mut Session, rows: &[Row], _: &str) -> Result<Value> {
        let groups = crate::presets::shapes::all_groups(s);
        let mut file = empty_file();
        for row in rows {
            if let Some(shape) = groups.iter().filter(|g| g.name == row.group).flat_map(|g| &g.items).find(|i| i.name == row.name) {
                file.custom_shapes.push(super::CustomShape { name: shape.name.clone(), path: shape.path.clone() });
            }
        }
        let n = file.custom_shapes.len();
        pcpresets(file, n)
    }
}

struct Tools;

impl Library for Tools {
    fn id(&self) -> &'static str {
        "tools"
    }
    fn thumb(&self) -> &'static str {
        "tool"
    }
    fn rows(&self, s: &mut Session) -> Result<Vec<Row>> {
        Ok(s.presets.tool_presets.iter().map(|t| Row { group: String::new(), name: t.name.clone(), key: t.name.clone(), hint: Some(t.tool.clone()) }).collect())
    }
    fn rename(&self, s: &mut Session, row: &Row, to: &str) -> Result<()> {
        call(s, "tool.presets.edit", json!({"action": "rename", "preset": row.name, "name": to})).map(drop)
    }
    fn delete(&self, s: &mut Session, rows: &[Row]) -> Result<()> {
        call(s, "tool.presets.edit", json!({"action": "delete", "preset": names(rows)})).map(drop)
    }
    fn move_to(&self, s: &mut Session, row: &Row, _: &[Row], dest: &Dest) -> Result<()> {
        let all = self.rows(s)?;
        flat_move(&mut s.presets.tool_presets, &all, row, dest);
        Ok(())
    }
    fn reset_command(&self) -> Option<&'static str> {
        Some("tool.presets.reset")
    }
    fn clear(&self, s: &mut Session) -> Result<()> {
        s.presets.tool_presets.clear();
        Ok(())
    }
    fn save_extensions(&self) -> &'static [&'static str] {
        // P2 adds Photoshop's .tpl (`tool.presets.exportTpl`).
        if crate::commands::find("tool.presets.exportTpl").is_some() { &["tpl", "pcpresets"] } else { &["pcpresets"] }
    }
    fn save_set(&self, s: &mut Session, rows: &[Row], ext: &str) -> Result<Value> {
        if ext == "tpl" {
            return call(s, "tool.presets.exportTpl", json!({"names": names(rows)}));
        }
        let mut file = empty_file();
        file.tool_presets = s.presets.tool_presets.iter().filter(|t| rows.iter().any(|r| r.name == t.name)).cloned().collect();
        let n = file.tool_presets.len();
        pcpresets(file, n)
    }
}

struct Adjustments;

/// The name of an adjustment kind as the menus show it.
pub fn adjustment_label(kind: &str) -> String {
    if kind == "hdrToning" {
        return "HDR Toning".into();
    }
    crate::commands::find(&format!("layer.newAdjustmentLayer.{kind}")).map_or_else(|| kind.to_string(), |spec| spec.label.trim_end_matches('…').to_string())
}

impl Adjustments {
    /// The kind of `row` (its key).
    fn kinds(rows: &[Row]) -> Vec<&str> {
        let mut kinds: Vec<&str> = rows.iter().map(|r| r.key.as_str()).collect();
        kinds.sort_unstable();
        kinds.dedup();
        kinds
    }
}

impl Library for Adjustments {
    fn id(&self) -> &'static str {
        "adjustments"
    }
    fn thumb(&self) -> &'static str {
        "adjustment"
    }
    fn rows(&self, s: &mut Session) -> Result<Vec<Row>> {
        let mut rows = Vec::new();
        for kind in crate::presets::adjustments::KINDS {
            let label = adjustment_label(kind);
            for e in s.presets.adjustments.list(kind) {
                rows.push(Row { group: label.clone(), name: e.preset.name, key: kind.to_string(), hint: None });
            }
        }
        Ok(rows)
    }
    fn rename(&self, s: &mut Session, row: &Row, to: &str) -> Result<()> {
        call(s, "adjustment.presets.edit", json!({"kind": row.key, "action": "rename", "name": row.name, "newName": to})).map(drop)
    }
    fn delete(&self, s: &mut Session, rows: &[Row]) -> Result<()> {
        for kind in Self::kinds(rows) {
            let names: Vec<&str> = rows.iter().filter(|r| r.key == kind).map(|r| r.name.as_str()).collect();
            call(s, "adjustment.presets.edit", json!({"kind": kind, "action": "delete", "name": names}))?;
        }
        Ok(())
    }
    fn reset_command(&self) -> Option<&'static str> {
        Some("adjustment.presets.reset")
    }
    fn save_extension_for(&self, rows: &[Row]) -> &'static str {
        rows.first().and_then(|r| photocraft_io::adjust_presets::extension(&r.key)).unwrap_or("acv")
    }
    fn move_to(&self, _: &mut Session, _: &Row, _: &[Row], _: &Dest) -> Result<()> {
        // The dialogs list built-ins first, then the user's groups: the order is fixed.
        Err(bad(CMD, "adjustment presets keep their order (built-in presets first, then yours)"))
    }
    fn clear(&self, _: &mut Session) -> Result<()> {
        Err(bad(CMD, "adjustment presets cannot be replaced"))
    }
    fn save_extensions(&self) -> &'static [&'static str] {
        &["alv", "acv", "ahu", "cha", "asv", "blw"]
    }
    fn save_set(&self, s: &mut Session, rows: &[Row], ext: &str) -> Result<Value> {
        // Photoshop's adjustment files hold one preset each.
        let [row] = rows else { return Err(bad(CMD, "Photoshop's adjustment preset files hold one preset: select one")) };
        let file_ext = photocraft_io::adjust_presets::extension(&row.key)
            .ok_or_else(|| bad(CMD, format!("{} presets have no Photoshop file (they travel in .pcpresets)", adjustment_label(&row.key))))?;
        if file_ext.trim_start_matches('.') != ext {
            return Err(bad(CMD, format!("{} presets save as .{}", adjustment_label(&row.key), file_ext.trim_start_matches('.'))));
        }
        let mut out = call(s, "adjustment.presets.export", json!({"kind": row.key, "name": row.name}))?;
        out["count"] = json!(1);
        Ok(out)
    }
}

#[cfg(test)]
#[path = "preset_manager_tests.rs"]
mod tests;
