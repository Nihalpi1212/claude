//! Pigment: Edit › Presets › Migrate Presets from the JavaScript Pigment (0.1 to 0.5; PORTS-A
//! §3.3, row 22 second half). Photoshop's Migrate Presets brings the presets of an earlier
//! version; for Pigment, the earlier versions are the Electron app, whose preset store kept each
//! kind in its settings folder (`%APPDATA%\Pigment\presets`, `~/Library/Application
//! Support/Pigment/presets`, `~/.config/Pigment/presets`):
//!
//! - `<kind>.json` (`:` written `__`): `{ format: 'pigment-presets', version: 1, kind,
//!   kindVersion, groups: [{ id, name, parent }], items, hidden }`, the items in order, built-ins
//!   as shipped as `{ ref: id }` (not migrated: Pigment has its own), the user's presets and the
//!   built-ins they changed in full (`{ id, name, group, data }`);
//! - `<kind>/<name>`: side files (a pattern's pixels, a brush's sampled tip, as PNG);
//! - `settings.json` beside the folder: Pigment 0.4's own brush presets (`brushPresets`) and
//!   swatches (`swatches`), `adjust.autoOptions` (Auto Color Correction Options), `adjust.curvesDisplay`
//!   (Curve Display Options) and the Actions panel's sets (`actions`), which are reported, not
//!   converted: the JS command ids and arguments do not map onto Pigment's commands.
//!
//! A `.pigment-bundle` (the JS Export/Import Presets file: a ZIP of `bundle.json` = `{ format:
//! 'pigment-bundle', version: 1, kinds: { <kind>: { groups, items } }, settings? }` and
//! `blobs/<kind>/<name>`) holds the same items and is read the same way ([`import_bundle`]).
//!
//! Each kind's items go through the document importer's mappers
//! (`photocraft_io::legacy_pigment::presets`) and then through Export/Import Presets' merge
//! (`preset_file::Staged`): appended to the group of the same name, a preset already in the
//! library (same data, its name or the number an earlier import gave it) skipped. Migrating twice
//! adds nothing. Brushes and tool presets follow the same rule here. A kind file that cannot be
//! read, and a preset that cannot be converted, are skipped with a line in the reply's `skipped`.
//! The JS files are only read.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use craft::color_ui::palette::{SwatchColor, SwatchEntry, SwatchGroup};
use photocraft_io::legacy_pigment::presets as js;
use serde_json::{Map, Value, json};

use crate::cmd::edit_menu_cmds::PresetFile;
use crate::cmd::edit_menu_cmds::preset_file::{AdjustmentEntry, PatternEntry, Staged};
use crate::presets::gradients::{GradientPreset, StopColor};
use crate::presets::shapes::ShapePreset;
use crate::presets::styles::StylePreset;
use crate::presets::tools::ToolPreset;
use crate::presets::{Group, group_index, unique_name_by};
use crate::{EngineError, Result, Session};

pub(crate) const CMD: &str = "edit.presets.migratePresets";
/// The JS store's file format and the bundle's.
const STORE_FORMAT: &str = "pigment-presets";
const BUNDLE_FORMAT: &str = "pigment-bundle";
/// The group migrated presets that were in no group of their own go to.
pub(crate) const DEFAULT_GROUP: &str = "Pigment 0.4";
/// Largest kind file and side file read (the JS store's own limits).
const MAX_KIND_FILE: u64 = 64 << 20;
const MAX_BLOB: u64 = 256 << 20;
/// Largest bundle, and the side files one bundle may expand to.
const MAX_BUNDLE: usize = 1 << 30;
/// Presets of one kind read; more are left out with a line.
const MAX_ITEMS: usize = crate::cmd::edit_menu_cmds::preset_file::MAX_ENTRIES;
/// Why the JS Actions panel's own sets are not converted.
const ACTIONS: &str =
    "the JavaScript Pigment's actions name its own commands, which do not map onto Pigment's; record the action again (recorded .atn files keep working)";

/// One preset of a JS kind file or bundle.
struct Item {
    name: String,
    group: String,
    data: Value,
}

/// A preset or a file that was not migrated.
struct Skip {
    kind: String,
    name: String,
    reason: String,
}

/// Where the side files are.
enum Blobs {
    /// `<folder>/<kind>/<name>`.
    Dir(PathBuf),
    /// A bundle's `blobs/<kind>/<name>`, read.
    Map(HashMap<String, Vec<u8>>),
}

impl Blobs {
    fn get(&self, kind: &str, name: &str) -> Option<Vec<u8>> {
        if !blob_name_ok(name) {
            return None;
        }
        match self {
            Blobs::Dir(root) => {
                let path = root.join(kind.replacen(':', "__", 1)).join(name);
                (std::fs::metadata(&path).ok()?.len() <= MAX_BLOB).then(|| std::fs::read(&path).ok()).flatten()
            }
            Blobs::Map(m) => m.get(&format!("{kind}/{name}")).cloned(),
        }
    }
}

/// What a folder or a bundle holds.
struct Source {
    kinds: Vec<(String, Vec<Item>)>,
    blobs: Blobs,
    settings: Option<Value>,
    skipped: Vec<Skip>,
    notes: Vec<String>,
    /// Kind files (and a settings file) found.
    found: usize,
}

/// `PRESET_KIND_RE` of the JS store: `^[a-z][a-z0-9-]*(:[a-z0-9-]+)?$`.
fn kind_ok(k: &str) -> bool {
    let word = |w: &str, first: bool| {
        !w.is_empty() && w.bytes().enumerate().all(|(i, b)| b.is_ascii_lowercase() || ((!first || i > 0) && (b.is_ascii_digit() || b == b'-')))
    };
    match k.split_once(':') {
        Some((a, b)) => word(a, true) && word(b, false),
        None => word(k, true),
    }
}

/// `BLOB_NAME_RE` of the JS store: `^[A-Za-z0-9._-]{1,128}$`, not `.` or `..`.
fn blob_name_ok(n: &str) -> bool {
    (1..=128).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')) && n != "." && n != ".."
}

fn clip(s: &str) -> String {
    s.trim().chars().take(255).collect()
}

/// The presets of one kind entry (`{ groups, items }`): user presets and changed built-ins, with
/// their group's name; built-ins as shipped (`{ ref }`) left out.
fn items_of(kind: &str, entry: &Value, out: &mut Source) -> Vec<Item> {
    let groups: HashMap<String, String> = entry
        .get("groups")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|g| g.get("hidden").and_then(Value::as_bool) != Some(true))
        .filter_map(|g| Some((g.get("id")?.as_str()?.to_string(), clip(g.get("name").and_then(Value::as_str).unwrap_or("")))))
        .filter(|(_, n)| !n.is_empty())
        .collect();
    let all: Vec<&Value> = entry.get("items").and_then(Value::as_array).into_iter().flatten().filter(|it| it.get("ref").is_none()).collect();
    if all.len() > MAX_ITEMS {
        out.notes.push(format!("{kind}: only the first {MAX_ITEMS} of {} presets were read", all.len()));
    }
    all.into_iter()
        .take(MAX_ITEMS)
        .filter_map(|it| {
            let data = it.get("data").filter(|d| !d.is_null())?.clone();
            let name = clip(it.get("name").and_then(Value::as_str).unwrap_or(""));
            let group = it.get("group").and_then(Value::as_str).and_then(|g| groups.get(g)).cloned().unwrap_or_else(|| DEFAULT_GROUP.into());
            Some(Item { name: if name.is_empty() { "Preset".into() } else { name }, group, data })
        })
        .collect()
}

/// The JS store's folder `dir`, or a settings folder holding it as `presets`.
fn read_folder(dir: &Path) -> Result<Source> {
    // As the JS `folderBundle`: a folder without the store's kind files but with `presets` is
    // the settings folder (`settings.json`, `recent.json` and the like are not kind files).
    let has_kind_files = |d: &Path| {
        std::fs::read_dir(d).is_ok_and(|rd| {
            rd.flatten().any(|e| {
                e.file_name()
                    .to_str()
                    .and_then(|n| n.strip_suffix(".json"))
                    .is_some_and(|k| kind_for(&k.replacen("__", ":", 1)).is_some() || k == "stroke-styles")
            })
        })
    };
    let (root, settings_at) = if !has_kind_files(dir) && dir.join("presets").is_dir() {
        (dir.join("presets"), vec![dir.join("settings.json")])
    } else {
        let mut at = vec![dir.join("settings.json")];
        if dir.file_name().is_some_and(|n| n == "presets")
            && let Some(parent) = dir.parent()
        {
            at.push(parent.join("settings.json"));
        }
        (dir.to_path_buf(), at)
    };
    let mut src = Source { kinds: Vec::new(), blobs: Blobs::Dir(root.clone()), settings: None, skipped: Vec::new(), notes: Vec::new(), found: 0 };
    let mut files: Vec<(String, PathBuf)> = std::fs::read_dir(&root)
        .map_err(|e| EngineError::Other(format!("{}: {e}", root.display())))?
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| {
            let name = e.file_name().to_str()?.to_string();
            let kind = name.strip_suffix(".json")?.replacen("__", ":", 1);
            (kind_ok(&kind) && !matches!(kind.as_str(), "settings" | "recent")).then(|| (kind, e.path()))
        })
        .collect();
    files.sort();
    for (kind, path) in files {
        src.found += 1;
        let file = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let read = std::fs::metadata(&path)
            .map_err(|e| e.to_string())
            .and_then(|m| if m.len() > MAX_KIND_FILE { Err("is too large".into()) } else { std::fs::read_to_string(&path).map_err(|e| e.to_string()) })
            .and_then(|t| serde_json::from_str::<Value>(&t).map_err(|e| format!("is not JSON ({e})")))
            .and_then(|v| {
                let ok = v.get("format").and_then(Value::as_str) == Some(STORE_FORMAT) && v.get("items").is_some_and(Value::is_array);
                if ok { Ok(v) } else { Err("is not a Pigment presets file".into()) }
            });
        match read {
            Ok(v) => {
                let items = items_of(&kind, &v, &mut src);
                src.kinds.push((kind, items));
            }
            Err(why) => src.skipped.push(Skip { kind, name: file.clone(), reason: format!("{file} {why}; it was skipped") }),
        }
    }
    if let Some(path) = settings_at.into_iter().find(|p| p.is_file()) {
        src.found += 1;
        let small = std::fs::metadata(&path).is_ok_and(|m| m.len() <= MAX_KIND_FILE);
        match small.then(|| std::fs::read_to_string(&path).ok()).flatten().and_then(|t| serde_json::from_str::<Value>(&t).ok()).filter(Value::is_object) {
            Some(v) => src.settings = Some(v),
            None => src.skipped.push(Skip {
                kind: "settings".into(),
                name: "settings.json".into(),
                reason: "settings.json could not be read; it was skipped".into(),
            }),
        }
    }
    Ok(src)
}

/// A `.pigment-bundle`'s contents.
fn read_bundle(bytes: &[u8]) -> Result<Source> {
    let zip = photocraft_format::zip::ZipReader::new(bytes).map_err(|e| super::bad(format!("not a Pigment bundle ({e})")))?;
    let main = zip.read_by_name("bundle.json", MAX_KIND_FILE as usize).map_err(|_| super::bad("not a Pigment bundle (bundle.json is missing)"))?;
    let v: Value = serde_json::from_slice(&main).map_err(|e| super::bad(format!("not a Pigment bundle (bundle.json: {e})")))?;
    let Some(kinds) = v.get("kinds").and_then(Value::as_object).filter(|_| v.get("format").and_then(Value::as_str) == Some(BUNDLE_FORMAT)) else {
        return Err(super::bad("not a Pigment bundle (bundle.json is damaged)"));
    };
    let mut blobs = HashMap::new();
    let mut total = 0usize;
    for e in &zip.entries {
        let Some(rest) = e.name.strip_prefix("blobs/") else { continue };
        let Some((kind, name)) = rest.split_once('/') else { continue };
        if !blob_name_ok(name) {
            continue;
        }
        let data = zip.read(e, MAX_BLOB as usize).map_err(|err| super::bad(format!("the bundle's {} could not be read ({err})", e.name)))?;
        total += data.len();
        if total > MAX_BUNDLE {
            return Err(super::bad("the bundle's side files are too large"));
        }
        blobs.insert(format!("{kind}/{name}"), data);
    }
    let mut src = Source { kinds: Vec::new(), blobs: Blobs::Map(blobs), settings: None, skipped: Vec::new(), notes: Vec::new(), found: kinds.len() };
    if v.get("version").and_then(Value::as_u64).is_some_and(|n| n > 1) {
        src.notes.push("the bundle was written by a later Pigment: what this one knows was read".into());
    }
    if let Some(keys) = v.get("settings").and_then(Value::as_object).filter(|o| !o.is_empty()) {
        let names: Vec<&str> = keys.keys().map(String::as_str).collect();
        src.notes.push(format!("the bundle's settings ({}) are the JavaScript app's and were not converted", names.join(", ")));
    }
    for (kind, entry) in kinds {
        if !kind_ok(kind) {
            continue;
        }
        let items = items_of(kind, entry, &mut src);
        src.kinds.push((kind.clone(), items));
    }
    Ok(src)
}

/// Pigment's kind for a JS kind (`added`'s keys), or `None` when Pigment has no such presets.
fn kind_for(js_kind: &str) -> Option<&'static str> {
    Some(match js_kind {
        "brushes" => "brushes",
        "swatches" => "swatches",
        "gradients" => "gradients",
        "styles" => "styles",
        "patterns" => "patterns",
        "contours" => "contours",
        "shapes" => "customShapes",
        "tool-presets" => "tools",
        k if k.starts_with("adjustment:") => "adjustments",
        _ => return None,
    })
}

/// `hue-saturation` → `hueSaturation`.
fn camel(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut up = false;
    for c in s.chars() {
        if c == '-' {
            up = true;
        } else if up {
            out.extend(c.to_uppercase());
            up = false;
        } else {
            out.push(c);
        }
    }
    out
}

/// What the migration adds, kind by kind, before anything changes.
#[derive(Default)]
struct Plan {
    files: BTreeMap<&'static str, PresetFile>,
    brushes: Vec<photocraft_paint::BrushPreset>,
    tools: Vec<ToolPreset>,
    skipped: Vec<Skip>,
    notes: Vec<String>,
}

impl Plan {
    fn file(&mut self, kind: &'static str) -> &mut PresetFile {
        self.files.entry(kind).or_default()
    }
    fn skip(&mut self, kind: &str, name: &str, reason: impl Into<String>) {
        self.skipped.push(Skip { kind: kind.into(), name: name.into(), reason: reason.into() });
    }
    fn note(&mut self, name: &str, notes: Vec<String>) {
        self.notes.extend(notes.into_iter().map(|n| format!("\"{name}\": {n}")));
    }
}

/// Pushes `item` into the group `group` of `groups` (made when missing).
fn grouped<T>(groups: &mut Vec<Group<T>>, group: &str, item: T) {
    let gi = group_index(groups, Some(group));
    groups[gi].items.push(item);
}

/// A JS colour (`{ space, values }`, rgb 0..255, cmyk and gray in percent, lab L a b).
fn swatch_color(c: &Value) -> Option<SwatchColor> {
    let v: Vec<f32> = c.get("values")?.as_array()?.iter().map(|n| n.as_f64().filter(|n| n.is_finite()).map(|n| n as f32)).collect::<Option<_>>()?;
    let at = |i: usize| v.get(i).copied();
    Some(match c.get("space")?.as_str()? {
        "rgb" => SwatchColor::Rgb([at(0)?, at(1)?, at(2)?].map(|x| (x / 255.0).clamp(0.0, 1.0))),
        "cmyk" => SwatchColor::Cmyk([at(0)?, at(1)?, at(2)?, at(3)?].map(|x| (x / 100.0).clamp(0.0, 1.0))),
        "gray" => SwatchColor::Gray((at(0)? / 100.0).clamp(0.0, 1.0)),
        "lab" => SwatchColor::Lab([at(0)?.clamp(0.0, 100.0), at(1)?.clamp(-128.0, 127.0), at(2)?.clamp(-128.0, 127.0)]),
        _ => return None,
    })
}

/// `#rrggbb` as a swatch colour.
fn hex_swatch(s: &str) -> Option<SwatchColor> {
    crate::prefs::parse_hex(s).map(|c| SwatchColor::Rgb(c.map(|x| f32::from(x) / 255.0)))
}

fn swatch_groups(groups: Vec<Group<SwatchEntry>>) -> Vec<SwatchGroup> {
    groups.into_iter().map(|g| SwatchGroup { name: g.name, entries: g.items }).collect()
}

impl Plan {
    fn swatches(&mut self, items: Vec<Item>) {
        let mut groups: Vec<Group<SwatchEntry>> = Vec::new();
        for it in items {
            match it.data.get("color").and_then(swatch_color) {
                Some(c) => grouped(&mut groups, &it.group, SwatchEntry::new(it.name, c)),
                None => self.skip("swatches", &it.name, "its colour could not be read"),
            }
        }
        self.file("swatches").swatches.extend(swatch_groups(groups));
    }

    fn gradients(&mut self, items: Vec<Item>) {
        let mut groups = Vec::new();
        for it in items {
            if !it.data.is_object() {
                self.skip("gradients", &it.name, "its gradient could not be read");
                continue;
            }
            let g = js::gradient(&it.data);
            let preset = match g.noise {
                Some(n) => crate::presets::gradients::noise::preset(&it.name, n),
                None => GradientPreset {
                    name: it.name.clone(),
                    stops: g
                        .colors
                        .into_iter()
                        .map(|(t, c, r)| {
                            (
                                t,
                                match r {
                                    Some(js::StopRef::Foreground) => StopColor::Foreground,
                                    Some(js::StopRef::Background) => StopColor::Background,
                                    None => StopColor::Rgb(c),
                                },
                            )
                        })
                        .collect(),
                    opacity: g.opacity,
                    noise: None,
                },
            };
            grouped(&mut groups, &it.group, preset);
        }
        self.file("gradients").gradients.extend(groups);
    }

    fn styles(&mut self, items: Vec<Item>) {
        let mut groups = Vec::new();
        for it in items {
            let Some(st) = js::style(&it.data) else {
                self.skip("styles", &it.name, "its layer style could not be read");
                continue;
            };
            for p in &st.patterns {
                self.pattern_entry(p);
            }
            self.note(&it.name, st.notes);
            grouped(
                &mut groups,
                &it.group,
                StylePreset { name: it.name, effects: st.effects.items, blend: st.blend, fill_opacity: st.fill_opacity, opacity: st.opacity },
            );
        }
        self.file("styles").styles.extend(groups);
    }

    /// A pattern for the pattern library, written as Export/Import Presets carries it.
    fn pattern_entry(&mut self, p: &photocraft_doc::Pattern) -> bool {
        match photocraft_io::pattern_map::write_pat(std::slice::from_ref(p)) {
            Ok(bytes) => {
                let f = self.file("patterns");
                if !f.patterns.iter().any(|e| e.id == p.id) {
                    f.patterns.push(PatternEntry { id: p.id.clone(), name: p.name.clone(), data: photocraft_paint::tile::b64_encode(&bytes) });
                }
                true
            }
            Err(e) => {
                self.skip("patterns", &p.name, format!("its pixels could not be kept ({e})"));
                false
            }
        }
    }

    fn patterns(&mut self, items: Vec<Item>, blobs: &Blobs) {
        let mut groups: Vec<Group<String>> = Vec::new();
        for it in items {
            let Some(blob) = it.data.get("blob").and_then(Value::as_str) else {
                let why = if it.data.get("builtin").is_some() { "it is one of the JavaScript app's built-in patterns" } else { "it names no pixels" };
                self.skip("patterns", &it.name, why);
                continue;
            };
            let Some(png) = blobs.get("patterns", blob) else {
                self.skip("patterns", &it.name, format!("its pixels (patterns/{blob}) are missing"));
                continue;
            };
            match js::pattern(&it.name, &png) {
                Ok(p) => {
                    if self.pattern_entry(&p) {
                        grouped(&mut groups, &it.group, p.id);
                    }
                }
                Err(e) => self.skip("patterns", &it.name, e),
            }
        }
        self.file("patterns").pattern_groups.extend(groups);
    }

    fn contours(&mut self, items: Vec<Item>) {
        for it in items {
            match js::contour(&it.data) {
                photocraft_doc::Contour::Custom { points, corners, .. } => {
                    let c = photocraft_doc::Contour::Custom { name: it.name, points, corners };
                    self.file("contours").contours.push(crate::layer_style::contour_param(&c));
                }
                _ => self.skip("contours", &it.name, "it is the Linear contour Pigment already has"),
            }
        }
    }

    fn shapes(&mut self, items: Vec<Item>) {
        let mut groups = Vec::new();
        for it in items {
            match js::shape(&it.data) {
                Some(path) => grouped(&mut groups, &it.group, ShapePreset { name: it.name, path, id: None }),
                None => self.skip("shapes", &it.name, "its path could not be read"),
            }
        }
        self.file("customShapes").shapes.extend(groups);
    }

    fn adjustments(&mut self, js_kind: &str, items: Vec<Item>) {
        let kind = format!("adjustment:{js_kind}");
        let pc = if js_kind == "hdr-toning" { "hdrToning".to_string() } else { camel(js_kind) };
        if !crate::presets::adjustments::KINDS.contains(&pc.as_str()) || matches!(js_kind, "invert") {
            let n = items.len();
            self.skip(&kind, "", format!("{n} preset{}: Pigment has no presets of this adjustment", if n == 1 { "" } else { "s" }));
            return;
        }
        for it in items {
            let params = if pc == "hdrToning" {
                hdr_params(&it.data)
            } else {
                let mut notes = Vec::new();
                let adj = js::adjustment(js_kind, &it.data, &mut notes);
                self.note(&it.name, notes);
                if matches!(adj, photocraft_doc::Adjustment::Unsupported { .. }) {
                    self.skip(&kind, &it.name, "its settings could not be read");
                    continue;
                }
                crate::cmd::adjust_preset_cmds::file_params(&adj)
            };
            match crate::cmd::adjust_preset_cmds::preset_params(&pc, &params, CMD) {
                Ok(params) => {
                    let group = if it.group == DEFAULT_GROUP { crate::presets::adjustments::USER_GROUP.to_string() } else { it.group };
                    self.file("adjustments").adjustments.push(AdjustmentEntry { kind: pc.clone(), group, name: it.name, params });
                }
                Err(e) => self.skip(&kind, &it.name, format!("its settings could not be used ({e})")),
            }
        }
    }

    fn brushes(&mut self, items: Vec<Item>, blobs: &Blobs) {
        for it in items {
            let (brush, notes) = js::brush(&it.data, &mut |name| blobs.get("brushes", name));
            self.note(&it.name, notes);
            if let Err(e) = crate::brush_cmds::validate_brush(&brush, CMD) {
                self.skip("brushes", &it.name, format!("its brush could not be used ({e})"));
                continue;
            }
            self.brushes.push(photocraft_paint::BrushPreset {
                name: it.name,
                brush,
                builtin: false,
                group: it.group,
                folder: Vec::new(),
                captures: Default::default(),
            });
        }
    }

    fn tools(&mut self, items: Vec<Item>, blobs: &Blobs) {
        for it in items {
            let d = &it.data;
            let Some(tool) = d.get("tool").and_then(Value::as_str) else {
                self.skip("tool-presets", &it.name, "it names no tool");
                continue;
            };
            let empty = Map::new();
            let options = d.get("options").and_then(Value::as_object).unwrap_or(&empty);
            let brush = d.get("brush").or_else(|| options.get("brush")).filter(|b| b.is_object()).map(|b| {
                let (b, notes) = js::brush(b, &mut |name| blobs.get("brushes", name));
                self.note(&it.name, notes);
                serde_json::to_value(b).unwrap_or(Value::Null)
            });
            let color = d.get("color").and_then(Value::as_str);
            let Some((tool, options, skipped)) = photocraft_io::tpl_map::js_tool_preset(tool, options, d.get("type"), color, brush) else {
                self.skip("tool-presets", &it.name, format!("it is a preset of a tool Pigment does not have ({})", tool.chars().take(40).collect::<String>()));
                continue;
            };
            if skipped > 0 {
                self.notes.push(format!("\"{}\": {skipped} options of {tool} have no equivalent and were skipped", it.name));
            }
            let mut warnings = Vec::new();
            let preset = crate::presets::tools::tpl::preset_of(
                photocraft_io::tpl_map::TplPreset { name: it.name, tool: tool.into(), class: String::new(), options },
                &mut warnings,
            );
            self.notes.extend(warnings);
            if let Some(p) = preset {
                self.tools.push(p);
            }
        }
    }

    /// `settings.json`: Pigment 0.4's brush presets and swatches, and the Actions panel's sets.
    fn settings(&mut self, v: &Value, blobs: &Blobs) {
        if let Some(list) = v.get("brushPresets").and_then(Value::as_array) {
            let items = list
                .iter()
                .filter(|p| p.get("size").is_some_and(Value::is_number))
                .map(|p| Item {
                    name: Some(clip(p.get("name").and_then(Value::as_str).unwrap_or(""))).filter(|n| !n.is_empty()).unwrap_or_else(|| "Brush".into()),
                    group: DEFAULT_GROUP.into(),
                    data: p.clone(),
                })
                .take(MAX_ITEMS)
                .collect();
            self.brushes(items, blobs);
        }
        let edited = v.get("swatchesEdited").and_then(Value::as_bool) == Some(true);
        if let Some(list) = v.get("swatches").and_then(Value::as_array).filter(|l| edited || !l.is_empty()) {
            let mut entries = Vec::new();
            for s in list.iter().take(MAX_ITEMS) {
                let (hex, name) = match s {
                    Value::String(h) => (h.as_str(), h.as_str()),
                    Value::Object(o) => {
                        let h = o.get("color").and_then(Value::as_str).unwrap_or("");
                        (h, o.get("name").and_then(Value::as_str).filter(|n| !n.trim().is_empty()).unwrap_or(h))
                    }
                    _ => continue,
                };
                match hex_swatch(hex) {
                    Some(c) => entries.push(SwatchEntry::new(clip(name), c)),
                    None => self.skip("swatches", hex, "its colour could not be read"),
                }
            }
            if !entries.is_empty() {
                self.file("swatches").swatches.push(SwatchGroup { name: DEFAULT_GROUP.into(), entries });
            }
        }
        for set in v.get("actions").and_then(|a| a.get("sets")).and_then(Value::as_array).into_iter().flatten() {
            let name = set.get("name").and_then(Value::as_str).unwrap_or("Set");
            self.skip("actions", &clip(name), ACTIONS);
        }
    }
}

/// HDR Toning's JS settings as the engine's: Strength 0..100 becomes 0..1 (as A1's built-ins).
fn hdr_params(v: &Value) -> Value {
    let mut p = v.clone();
    if let Some(o) = p.as_object_mut() {
        if let Some(s) = o.get("strength").and_then(Value::as_f64) {
            o.insert("strength".into(), json!(s / 100.0));
        }
        if o.get("curve").is_some_and(Value::is_null) {
            o.remove("curve");
        }
    }
    p
}

/// Whether `have` is `want`, or the name an import gave it (`want 2`).
fn same_name(have: &str, want: &str) -> bool {
    have == want || have.strip_prefix(want).and_then(|r| r.strip_prefix(' ')).is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// `added`/`unchanged` bump.
fn bump(m: &mut Map<String, Value>, kind: &str, n: u64) {
    if n > 0 {
        let e = m.entry(kind.to_string()).or_insert(json!(0));
        *e = json!(e.as_u64().unwrap_or(0) + n);
    }
}

/// Migrates what `src` holds; `kinds` (Pigment's kind ids) keeps only those.
fn run(s: &mut Session, src: Source, kinds: Option<&[String]>) -> Result<Value> {
    let wanted = |k: &str| kinds.is_none_or(|ks| ks.iter().any(|x| x == k));
    let Source { kinds: files, blobs, settings, mut skipped, notes, found } = src;
    let mut plan = Plan { notes, ..Plan::default() };
    for (kind, items) in files {
        let Some(pc) = kind_for(&kind) else {
            let n = items.len();
            if n > 0 {
                plan.skip(&kind, "", format!("{n} preset{}: Pigment has no presets of this kind", if n == 1 { "" } else { "s" }));
            }
            continue;
        };
        if !wanted(pc) {
            continue;
        }
        match kind.as_str() {
            "swatches" => plan.swatches(items),
            "gradients" => plan.gradients(items),
            "styles" => plan.styles(items),
            "patterns" => plan.patterns(items, &blobs),
            "contours" => plan.contours(items),
            "shapes" => plan.shapes(items),
            "brushes" => plan.brushes(items, &blobs),
            "tool-presets" => plan.tools(items, &blobs),
            k => plan.adjustments(k.trim_start_matches("adjustment:"), items),
        }
    }
    let mut added = Map::new();
    let mut unchanged = Map::new();
    if let Some(v) = &settings {
        if wanted("brushes") || wanted("swatches") {
            plan.settings(v, &blobs);
        }
        settings_prefs(s, v, &mut added, &mut unchanged, &mut plan);
    }
    // The six kinds Export/Import Presets merges, one at a time: a kind that cannot be merged
    // is skipped, the rest go in.
    let staged_kinds: Vec<(&'static str, PresetFile)> = std::mem::take(&mut plan.files).into_iter().collect();
    // Styles name their patterns: patterns first.
    let mut staged_kinds = staged_kinds;
    staged_kinds.sort_by_key(|(k, _)| *k != "patterns");
    for (kind, mut file) in staged_kinds {
        if kind == "patterns" && !wanted("patterns") && !wanted("styles") {
            continue;
        }
        let ks = [kind.to_string()];
        match Staged::read(s, &mut file, &ks, CMD) {
            Ok(staged) => {
                let mut reply = json!({});
                staged.apply(s, &mut reply);
                bump(&mut added, kind, reply.get(kind).and_then(Value::as_u64).unwrap_or(0));
                let key = if kind == "customShapes" { "shapes" } else { kind };
                bump(&mut unchanged, kind, reply["skipped"].get(key).and_then(Value::as_u64).unwrap_or(0));
            }
            Err(e) => plan.skip(kind, "", format!("could not be migrated ({e})")),
        }
    }
    let (b_added, b_same) = merge_brushes(s, std::mem::take(&mut plan.brushes));
    bump(&mut added, "brushes", b_added);
    bump(&mut unchanged, "brushes", b_same);
    let (t_added, t_same, over) = merge_tools(s, std::mem::take(&mut plan.tools));
    bump(&mut added, "tools", t_added);
    bump(&mut unchanged, "tools", t_same);
    if over > 0 {
        plan.notes.push(format!("at most {} tool presets are kept; {over} were left out", crate::presets::tools::MAX_PRESETS));
    }
    skipped.append(&mut plan.skipped);
    let total: u64 = added.values().filter_map(Value::as_u64).sum();
    Ok(json!({
        "migrated": total,
        "found": found,
        "added": added,
        "unchanged": unchanged,
        "skipped": skipped.iter().map(|k| json!({"kind": k.kind, "name": k.name, "reason": k.reason})).collect::<Vec<_>>(),
        "notes": plan.notes,
    }))
}

/// `settings.json`'s `adjust.autoOptions` (Auto Color Correction Options, saved as the
/// defaults, as the JS app used them once saved) and `adjust.curvesDisplay` (Curve Display
/// Options), when they differ from Pigment's.
fn settings_prefs(s: &mut Session, v: &Value, added: &mut Map<String, Value>, unchanged: &mut Map<String, Value>, plan: &mut Plan) {
    use crate::cmd::auto_options_cmds::{AutoOptionsPrefs, curves_display::CurvesDisplay};
    let adjust = v.get("adjust");
    if let Some(o) = adjust.and_then(|a| a.get("autoOptions")).filter(|o| o.is_object()) {
        match serde_json::from_value::<AutoOptionsPrefs>(o.clone()) {
            Ok(want) => {
                let p = &s.prefs().adjustments;
                if p.auto_options_saved && p.auto_options == want {
                    bump(unchanged, "settings", 1);
                } else {
                    s.edit_prefs(|p| {
                        p.adjustments.auto_options = want;
                        p.adjustments.auto_options_saved = true;
                    });
                    bump(added, "settings", 1);
                }
            }
            Err(e) => plan.skip("settings", "adjust.autoOptions", format!("the Auto Color Correction Options could not be read ({e})")),
        }
    }
    if let Some(o) = adjust.and_then(|a| a.get("curvesDisplay")).filter(|o| o.is_object()) {
        match serde_json::from_value::<CurvesDisplay>(o.clone()) {
            Ok(want) if s.prefs().adjustments.curves_display == want => bump(unchanged, "settings", 1),
            Ok(want) => {
                s.edit_prefs(|p| p.adjustments.curves_display = want);
                bump(added, "settings", 1);
            }
            Err(e) => plan.skip("settings", "adjust.curvesDisplay", format!("the Curve Display Options could not be read ({e})")),
        }
    }
}

/// Adds brush presets not already in the Brushes panel (same brush under its name or an
/// import's number); a taken name gets the next number. Returns (added, unchanged).
fn merge_brushes(s: &mut Session, incoming: Vec<photocraft_paint::BrushPreset>) -> (u64, u64) {
    let (mut added, mut same) = (0, 0);
    for mut b in incoming {
        let want = serde_json::to_value(&b.brush).ok();
        let here = s.tools.presets.iter().filter(|x| same_name(&x.name, &b.name)).any(|x| {
            let mut have = x.brush.clone();
            s.load_brush_tips(&mut have).is_ok() && serde_json::to_value(&have).ok() == want
        });
        if here {
            same += 1;
            continue;
        }
        b.name = unique_name_by(&b.name, |n| s.tools.presets.iter().any(|x| x.name == n));
        s.tools.presets.push(b);
        added += 1;
    }
    if added > 0 {
        s.brush_presets_changed();
    }
    (added, same)
}

/// Adds tool presets not already in the list, as `tool.presets.importTpl` does. Returns
/// (added, unchanged, left out past the cap).
fn merge_tools(s: &mut Session, incoming: Vec<ToolPreset>) -> (u64, u64, u64) {
    let (mut added, mut same, mut over) = (0, 0, 0);
    let mut library = s.presets.tool_presets.clone();
    for mut t in incoming {
        if library.iter().any(|have| have.tool == t.tool && have.options == t.options && same_name(&have.name, &t.name)) {
            same += 1;
            continue;
        }
        if library.len() >= crate::presets::tools::MAX_PRESETS {
            over += 1;
            continue;
        }
        t.name = unique_name_by(&t.name, |n| library.iter().any(|x| x.name == n));
        library.push(t);
        added += 1;
    }
    if added > 0 {
        s.presets.tool_presets = library;
        s.presets_changed();
    }
    (added, same, over)
}

/// Migrates the JS preset store's folder `dir` (or the settings folder holding it).
pub(crate) fn migrate_folder(s: &mut Session, dir: &Path) -> Result<Value> {
    let src = read_folder(dir)?;
    run(s, src, None)
}

/// Imports a `.pigment-bundle` (Export/Import Presets' Import, and Migrate Presets given one);
/// `kinds` (Pigment's kind ids) keeps only those.
pub fn import_bundle(s: &mut Session, bytes: &[u8], kinds: Option<&[String]>) -> Result<Value> {
    let src = read_bundle(bytes)?;
    run(s, src, kinds)
}

/// Whether `bytes` are a ZIP (a bundle).
pub(crate) fn is_zip(bytes: &[u8]) -> bool {
    bytes.starts_with(b"PK\x03\x04")
}
