//! Pigment: Edit › Presets › Export/Import Presets for every preset kind (PORTS-A §3.2, row 22,
//! first half).
//!
//! Upstream's `.pcpresets` file ([`PresetFile`]) carries brushes, custom shapes and tool presets.
//! Pigment adds the other six kinds the Preset Manager shows: swatches, gradients, styles,
//! patterns (each with its pixels as a base64 `.pat`, and the panel's folders), contours, the
//! Shapes panel's library and the adjustment presets. Upstream's three kinds keep upstream's
//! code and rules (a brush, custom shape or tool preset of the same name is replaced); the new
//! kinds:
//!
//! - **export** only what the user made or changed, unless `includeBuiltins` (a built-in preset
//!   as shipped is in every library already);
//! - **import** by appending to the group of the same name (made when missing) and skipping a
//!   preset that is already there: same kind, same data, and the same name or the name an
//!   earlier import of it got (`Name 2`). Importing a file twice adds nothing. A preset whose
//!   name is taken by a different one gets the next free number, as the kind's own imports do.
//!
//! Everything is read and checked before any library changes ([`Staged`]): a damaged entry
//! refuses the whole file.

use craft::color_ui::palette::{SwatchEntry, SwatchGroup, default_swatches};
use photocraft_doc::{Contour, Pattern};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::preset_manager::Row;
use super::{PresetFile, Result, Session, bad};
use crate::presets::adjustments::{self, BUILTIN_GROUP, USER_GROUP};
use crate::presets::gradients::GradientPreset;
use crate::presets::shapes::{CUSTOM_GROUP, ShapePreset};
use crate::presets::styles::StylePreset;
use crate::presets::{Group, Named, group_index, unique_name_by};

/// The kinds `edit.presets.exportImportPresets` takes, in the Preset Manager's order.
pub const KINDS: [&str; 9] = super::preset_manager::PRESET_KINDS;
/// The kinds an export or import covers when `kinds` is absent (upstream's three).
pub const DEFAULT_KINDS: [&str; 3] = ["brushes", "customShapes", "tools"];
/// Most presets of one kind a file may carry (swatches have their own, larger, limit).
pub const MAX_ENTRIES: usize = 10_000;
/// Longest preset or group name kept, in characters.
const MAX_NAME: usize = 255;

/// A pattern in a preset file: its id and name (for people reading the file) and the pattern
/// itself, pixels included, as a base64 Photoshop `.pat`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PatternEntry {
    pub id: String,
    pub name: String,
    pub data: String,
}

/// An adjustment preset in a preset file: the adjustment kind (`curves`, `levels`…), the group
/// it was in, its name and its command's params.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AdjustmentEntry {
    pub kind: String,
    #[serde(default)]
    pub group: String,
    pub name: String,
    pub params: Value,
}

impl Named for SwatchEntry {
    fn name(&self) -> &str {
        &self.name
    }
    fn set_name(&mut self, n: String) {
        self.name = n;
    }
}

/// The `kinds` param: the ids asked (upstream's three when absent).
pub fn kinds_param(p: &Value, cmd: &str) -> Result<Vec<String>> {
    let Some(v) = p.get("kinds").filter(|v| !v.is_null()) else { return Ok(DEFAULT_KINDS.iter().map(ToString::to_string).collect()) };
    let list = v.as_array().ok_or_else(|| bad(cmd, format!("`kinds` must be a list of preset kinds ({})", KINDS.join("|"))))?;
    let mut out = Vec::new();
    for k in list {
        let k = k.as_str().filter(|k| KINDS.contains(k)).ok_or_else(|| bad(cmd, format!("unknown preset kind {k} ({})", KINDS.join("|"))))?;
        if !out.iter().any(|x| x == k) {
            out.push(k.to_string());
        }
    }
    Ok(out)
}

/// Which presets of a kind go into a file.
pub enum Pick<'a> {
    /// The whole library: the user's presets, and the built-ins as shipped when `builtins`.
    All { builtins: bool },
    /// The Preset Manager's selection (its rows of the kind).
    Rows(&'a [Row]),
}

impl Pick<'_> {
    /// Whether a preset of `group` named `name` (`key` for patterns and adjustment kinds) goes.
    fn keeps(&self, group: &str, name: &str, key: &str, builtin: bool) -> bool {
        match self {
            Pick::All { builtins } => *builtins || !builtin,
            Pick::Rows(rows) => rows.iter().any(|r| r.group == group && r.name == name && r.key == key),
        }
    }
}

fn clip(s: &str) -> String {
    s.trim().chars().take(MAX_NAME).collect()
}

/// `groups`, keeping only the presets `keep(group, item)` takes and the groups left with any.
fn filter_groups<T: Clone>(groups: &[Group<T>], keep: impl Fn(&str, &T) -> bool) -> Vec<Group<T>> {
    groups
        .iter()
        .map(|g| Group::new(&g.name, g.items.iter().filter(|i| keep(&g.name, i)).cloned().collect()))
        .filter(|g| !g.items.is_empty())
        .collect()
}

/// Whether `item` of `group` is in `builtin` as shipped.
fn is_builtin<T: PartialEq>(builtin: &[Group<T>], group: &str, item: &T) -> bool {
    builtin.iter().any(|g| g.name == group && g.items.contains(item))
}

fn swatch_groups(lib: &[SwatchGroup]) -> Vec<Group<SwatchEntry>> {
    lib.iter().map(|g| Group::new(&g.name, g.entries.clone())).collect()
}

fn from_swatch_groups(groups: Vec<Group<SwatchEntry>>) -> Vec<SwatchGroup> {
    groups.into_iter().map(|g| SwatchGroup { name: g.name, entries: g.items }).collect()
}

/// Fills `file` with the presets of `kind` that `pick` takes; returns how many. Upstream's
/// brushes and tools are written by `export_import` itself; custom shapes here cover both the
/// Define Custom Shape results (`customShapes`, upstream's field) and the Shapes panel's groups
/// (`shapes`).
pub fn export_kind(s: &mut Session, file: &mut PresetFile, kind: &str, pick: &Pick, cmd: &str) -> Result<usize> {
    Ok(match kind {
        "swatches" => {
            let builtin = swatch_groups(&default_swatches());
            let groups = filter_groups(&swatch_groups(&s.presets.swatches), |g, i| pick.keeps(g, &i.name, &i.name, is_builtin(&builtin, g, i)));
            let n = groups.iter().map(|g| g.items.len()).sum();
            file.swatches = from_swatch_groups(groups);
            n
        }
        "gradients" => {
            let builtin = crate::presets::gradients::builtin();
            file.gradients = filter_groups(&s.presets.gradients, |g, i| pick.keeps(g, &i.name, &i.name, is_builtin(&builtin, g, i)));
            file.gradients.iter().map(|g| g.items.len()).sum()
        }
        "styles" => {
            let builtin = crate::presets::styles::builtin();
            file.styles = filter_groups(&s.presets.styles, |g, i| pick.keeps(g, &i.name, &i.name, is_builtin(&builtin, g, i)));
            file.styles.iter().map(|g| g.items.len()).sum()
        }
        "customShapes" => {
            let builtin = crate::presets::shapes::builtin();
            file.shapes = filter_groups(&s.presets.shapes, |g, i| pick.keeps(g, &i.name, &i.name, is_builtin(&builtin, g, i)));
            file.custom_shapes = match pick {
                // Upstream exports every Define Custom Shape result.
                Pick::All { .. } => s.edit_state.custom_shapes.clone(),
                Pick::Rows(_) => s.edit_state.custom_shapes.iter().filter(|c| pick.keeps(CUSTOM_GROUP, &c.name, &c.name, false)).cloned().collect(),
            };
            file.shapes.iter().map(|g| g.items.len()).sum::<usize>() + file.custom_shapes.len()
        }
        "patterns" => export_patterns(s, file, pick, cmd)?,
        "contours" => {
            file.contours = s
                .presets
                .contours
                .iter()
                .filter(|c| matches!(c, Contour::Custom { name, .. } if pick.keeps("", name, name, false)))
                .map(crate::layer_style::contour_param)
                .collect();
            file.contours.len()
        }
        "adjustments" => {
            file.adjustments.clear();
            for kind in adjustments::KINDS {
                let label = super::preset_manager::adjustment_label(kind);
                for e in s.presets.adjustments.list(kind) {
                    // The manager lists an adjustment preset under its kind's name.
                    let keep = match pick {
                        Pick::All { builtins } => *builtins || !e.builtin,
                        Pick::Rows(_) => pick.keeps(&label, &e.preset.name, kind, e.builtin),
                    };
                    if keep {
                        file.adjustments.push(AdjustmentEntry { kind: kind.to_string(), group: e.group, name: e.preset.name, params: e.preset.params });
                    }
                }
            }
            file.adjustments.len()
        }
        _ => 0,
    })
}

fn export_patterns(s: &mut Session, file: &mut PresetFile, pick: &Pick, cmd: &str) -> Result<usize> {
    crate::presets::patterns::sync(s);
    let builtins = crate::pattern_cmds::builtin();
    let mut groups: Vec<Group<String>> = Vec::new();
    let mut entries: Vec<PatternEntry> = Vec::new();
    for g in &s.presets.pattern_groups {
        let mut ids = Vec::new();
        for id in &g.items {
            let Some(p) = s.patterns.items.iter().find(|p| &p.id == id) else { continue };
            if entries.iter().any(|e| &e.id == id) || !pick.keeps(&g.name, p.display_name(), &p.id, crate::pattern_cmds::is_pristine_builtin(p, &builtins)) {
                continue;
            }
            let full = crate::pattern_cmds::full(s, p).map_err(|e| bad(cmd, e))?;
            let bytes = photocraft_io::pattern_map::write_pat(std::slice::from_ref(&full)).map_err(|e| bad(cmd, format!("pattern \"{}\": {e}", p.display_name())))?;
            entries.push(PatternEntry { id: p.id.clone(), name: p.name.clone(), data: photocraft_paint::tile::b64_encode(&bytes) });
            ids.push(p.id.clone());
        }
        if !ids.is_empty() {
            groups.push(Group::new(&g.name, ids));
        }
    }
    let n = entries.len();
    file.patterns = entries;
    file.pattern_groups = groups;
    Ok(n)
}

/// The counts of the six kinds Pigment adds, for the export's reply.
pub fn export_counts(file: &PresetFile, kinds: &[String], reply: &mut Value) {
    for k in kinds {
        let n = match k.as_str() {
            "swatches" => file.swatches.iter().map(|g| g.entries.len()).sum(),
            "gradients" => file.gradients.iter().map(|g| g.items.len()).sum(),
            "styles" => file.styles.iter().map(|g| g.items.len()).sum(),
            "patterns" => file.patterns.len(),
            "contours" => file.contours.len(),
            "adjustments" => file.adjustments.len(),
            "customShapes" => file.custom_shapes.len() + file.shapes.iter().map(|g| g.items.len()).sum::<usize>(),
            _ => continue,
        };
        reply[k.as_str()] = json!(n);
    }
}

// ------------------------------------------------------------------ import

/// The import's `data`: a JSON object, or its text. Upgrades swatches saved in the shape before
/// craft-color's model (`items`) and refuses a Pigment 0.1–0.4 bundle (P4 reads those).
pub fn read_data(cmd: &str, data: Value) -> Result<Value> {
    let mut v = match data {
        Value::String(text) => {
            if is_bundle(&text) {
                // P4 (Migrate Presets) maps a bundle's kinds: it calls its `import_bundle` here.
                return Err(bad(cmd, "this is a Pigment 0.1–0.4 preset bundle (.pigment-bundle): use Edit › Presets › Migrate Presets"));
            }
            serde_json::from_str(&text).map_err(|e| bad(cmd, format!("not a preset file: {e}")))?
        }
        v => v,
    };
    if let Some(sw) = v.get_mut("swatches") {
        crate::presets::swatches::upgrade_saved(sw);
    }
    Ok(v)
}

/// Whether `text` is a ZIP (a `.pigment-bundle`), as text or as base64.
fn is_bundle(text: &str) -> bool {
    const ZIP: &[u8] = b"PK\x03\x04";
    let t = text.trim_start();
    t.as_bytes().starts_with(ZIP) || (t.starts_with("UEsDB") && photocraft_paint::tile::b64_decode(t.trim()).is_some_and(|b| b.starts_with(ZIP)))
}

/// What an import adds, read and checked before anything changes.
#[derive(Default)]
pub struct Staged {
    swatches: Option<Vec<SwatchGroup>>,
    gradients: Option<Vec<Group<GradientPreset>>>,
    styles: Option<Vec<Group<StylePreset>>>,
    shapes: Option<Vec<Group<ShapePreset>>>,
    /// Shapes the file keeps in the `Custom Shapes` group: Define Custom Shape results.
    custom: Vec<super::CustomShape>,
    patterns: Vec<Pattern>,
    pattern_groups: Vec<Group<String>>,
    contours: Option<Vec<Contour>>,
    adjustments: Option<adjustments::AdjustmentPresets>,
    added: Map<String, Value>,
    skipped: Map<String, Value>,
}

/// Whether `have` is `want`'s name or the name an import gave it (`want 2`, `want 3`…).
fn same_name(have: &str, want: &str) -> bool {
    have == want || have.strip_prefix(want).and_then(|r| r.strip_prefix(' ')).is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// Whether `have` is `want` under its own or an import's name.
fn same<T: Named + Clone + PartialEq>(have: &T, want: &T) -> bool {
    if !same_name(have.name(), want.name()) {
        return false;
    }
    let mut w = want.clone();
    w.set_name(have.name().to_string());
    *have == w
}

/// Merges `incoming` into `lib` (see the module docs); names stay unique across `lib` and
/// `also_taken`. Returns (added, skipped).
fn merge<T: Named + Clone + PartialEq>(lib: &mut Vec<Group<T>>, incoming: Vec<Group<T>>, also_taken: &dyn Fn(&str) -> bool, kind: &str, cmd: &str) -> Result<(usize, usize)> {
    let (mut added, mut skipped) = (0, 0);
    if incoming.iter().map(|g| g.items.len()).sum::<usize>() > MAX_ENTRIES {
        return Err(bad(cmd, format!("too many {kind} (a preset file holds at most {MAX_ENTRIES})")));
    }
    for g in incoming {
        let group = Some(clip(&g.name)).filter(|n| !n.is_empty()).unwrap_or_else(|| "Imported".into());
        for mut item in g.items {
            let name = Some(clip(item.name())).filter(|n| !n.is_empty()).unwrap_or_else(|| "Untitled".into());
            item.set_name(name.clone());
            if lib.iter().any(|g| g.items.iter().any(|have| same(have, &item))) {
                skipped += 1;
                continue;
            }
            let unique = unique_name_by(&name, |n| also_taken(n) || lib.iter().any(|g| g.items.iter().any(|i| i.name() == n)));
            item.set_name(unique);
            let gi = group_index(lib, Some(&group));
            lib[gi].items.push(item);
            added += 1;
        }
    }
    Ok((added, skipped))
}

impl Staged {
    /// Reads the six kinds Pigment adds out of `file` (those of `kinds`) and merges them into
    /// copies of the libraries.
    pub fn read(s: &mut Session, file: &mut PresetFile, kinds: &[String], cmd: &str) -> Result<Staged> {
        let want = |k: &str| kinds.iter().any(|x| x == k);
        let mut st = Staged::default();
        let none = |_: &str| false;
        if want("swatches") {
            let mut lib = swatch_groups(&s.presets.swatches);
            let incoming = swatch_groups(&std::mem::take(&mut file.swatches));
            let n = st.count(&mut lib, incoming, &none, "swatches", cmd)?;
            let total: usize = lib.iter().map(|g| g.items.len()).sum();
            if n > 0 && (total > crate::swatch_cmds::MAX_SWATCHES || lib.len() > crate::swatch_cmds::MAX_GROUPS) {
                return Err(bad(cmd, format!("too many swatches: the panel holds at most {} in {} groups", crate::swatch_cmds::MAX_SWATCHES, crate::swatch_cmds::MAX_GROUPS)));
            }
            st.swatches = Some(from_swatch_groups(lib));
        }
        if want("gradients") {
            let mut lib = s.presets.gradients.clone();
            let mut incoming = std::mem::take(&mut file.gradients);
            for g in &mut incoming {
                for item in &mut g.items {
                    tidy_gradient(item);
                }
            }
            st.count(&mut lib, incoming, &none, "gradients", cmd)?;
            st.gradients = Some(lib);
        }
        if want("styles") {
            let mut lib = s.presets.styles.clone();
            st.count(&mut lib, std::mem::take(&mut file.styles), &none, "styles", cmd)?;
            st.styles = Some(lib);
        }
        if want("customShapes") {
            let mut lib = s.presets.shapes.clone();
            let mut incoming = std::mem::take(&mut file.shapes);
            // A file that keeps the Define Custom Shape results as a group of the Shapes library.
            if let Some(i) = incoming.iter().position(|g| g.name == CUSTOM_GROUP) {
                st.custom = incoming.remove(i).items.into_iter().map(|p| super::CustomShape { name: clip(&p.name), path: p.path }).collect();
            }
            let custom: Vec<String> = s.edit_state.custom_shapes.iter().map(|c| c.name.clone()).chain(file.custom_shapes.iter().map(|c| c.name.clone())).collect();
            st.count(&mut lib, incoming, &|n| custom.iter().any(|c| c == n), "shapes", cmd)?;
            st.shapes = Some(lib);
        }
        if want("patterns") {
            st.read_patterns(s, file, cmd)?;
        }
        if want("contours") {
            st.read_contours(s, file, cmd)?;
        }
        if want("adjustments") {
            st.read_adjustments(s, file, cmd)?;
        }
        Ok(st)
    }

    fn count<T: Named + Clone + PartialEq>(
        &mut self,
        lib: &mut Vec<Group<T>>,
        incoming: Vec<Group<T>>,
        also_taken: &dyn Fn(&str) -> bool,
        kind: &str,
        cmd: &str,
    ) -> Result<usize> {
        let (a, k) = merge(lib, incoming, also_taken, kind, cmd)?;
        self.tally(kind, a, k);
        Ok(a)
    }

    fn tally(&mut self, kind: &str, added: usize, skipped: usize) {
        let bump = |m: &mut Map<String, Value>, n: usize| {
            let e = m.entry(kind.to_string()).or_insert(json!(0));
            *e = json!(e.as_u64().unwrap_or(0) + n as u64);
        };
        bump(&mut self.added, added);
        bump(&mut self.skipped, skipped);
    }

    fn read_patterns(&mut self, s: &Session, file: &mut PresetFile, cmd: &str) -> Result<()> {
        let entries = std::mem::take(&mut file.patterns);
        if entries.len() > MAX_ENTRIES {
            return Err(bad(cmd, format!("too many patterns (a preset file holds at most {MAX_ENTRIES})")));
        }
        let (mut added, mut skipped) = (0, 0);
        for e in &entries {
            let bytes = photocraft_paint::tile::b64_decode(&e.data).ok_or_else(|| bad(cmd, format!("pattern \"{}\": `data` is not base64", e.name)))?;
            let pats = photocraft_io::pattern_map::read_pat(&bytes).map_err(|err| bad(cmd, format!("pattern \"{}\": {err}", e.name)))?;
            for pat in pats {
                let have = s.patterns.items.iter().find(|q| q.id == pat.id).map(|q| crate::pattern_cmds::full(s, q));
                let here = matches!(&have, Some(Ok(q)) if q.name == pat.name && (q.width, q.height) == (pat.width, pat.height) && q.surface == pat.surface);
                if here || self.patterns.iter().any(|q| q.id == pat.id) {
                    skipped += 1;
                } else {
                    self.patterns.push(pat);
                    added += 1;
                }
            }
        }
        // The folders hold ids the file or the library has.
        for g in std::mem::take(&mut file.pattern_groups) {
            let ids: Vec<String> =
                g.items.into_iter().filter(|id| self.patterns.iter().any(|p| &p.id == id) || s.patterns.items.iter().any(|p| &p.id == id)).collect();
            if !ids.is_empty() {
                self.pattern_groups.push(Group::new(&clip(&g.name), ids));
            }
        }
        self.tally("patterns", added, skipped);
        Ok(())
    }

    fn read_contours(&mut self, s: &Session, file: &mut PresetFile, cmd: &str) -> Result<()> {
        let incoming = std::mem::take(&mut file.contours);
        if incoming.len() > MAX_ENTRIES {
            return Err(bad(cmd, format!("too many contours (a preset file holds at most {MAX_ENTRIES})")));
        }
        let mut lib = s.presets.contours.clone();
        let (mut added, mut skipped) = (0, 0);
        for v in &incoming {
            let Some(Contour::Custom { name, points, corners }) = v.is_object().then(|| crate::layer_style::contour_from_param(v)).flatten() else {
                return Err(bad(cmd, "a contour must be a named curve ({name, points})"));
            };
            let name = Some(clip(&name)).filter(|n| !n.is_empty()).unwrap_or_else(|| "Contour".into());
            if lib.iter().any(|c| matches!(c, Contour::Custom { name: n, points: p, corners: k } if same_name(n, &name) && *p == points && *k == corners)) {
                skipped += 1;
                continue;
            }
            if lib.len() >= crate::contour_lib_cmds::MAX_USER_CONTOURS {
                return Err(bad(cmd, format!("the contour library holds at most {} contours", crate::contour_lib_cmds::MAX_USER_CONTOURS)));
            }
            // A user contour never shadows a standard contour's name.
            let unique = unique_name_by(&name, |n| {
                crate::layer_style::builtin_contour(n).is_some() || lib.iter().any(|c| matches!(c, Contour::Custom { name, .. } if name == n))
            });
            lib.push(Contour::Custom { name: unique, points, corners });
            added += 1;
        }
        self.tally("contours", added, skipped);
        self.contours = Some(lib);
        Ok(())
    }

    fn read_adjustments(&mut self, s: &Session, file: &mut PresetFile, cmd: &str) -> Result<()> {
        let incoming = std::mem::take(&mut file.adjustments);
        if incoming.len() > MAX_ENTRIES {
            return Err(bad(cmd, format!("too many adjustment presets (a preset file holds at most {MAX_ENTRIES})")));
        }
        let mut lib = s.presets.adjustments.clone();
        let (mut added, mut skipped, mut unknown) = (0, 0, 0);
        for e in incoming {
            if !adjustments::KINDS.contains(&e.kind.as_str()) {
                // A newer build's kind: left out, the rest loads.
                unknown += 1;
                continue;
            }
            let name = adjustments::clean_name(&e.name).ok_or_else(|| bad(cmd, format!("an adjustment preset's name must be 1..{} characters", adjustments::MAX_NAME_CHARS)))?;
            let params = crate::cmd::adjust_preset_cmds::preset_params(&e.kind, &e.params, cmd)?;
            if lib.list(&e.kind).iter().any(|have| same_name(&have.preset.name, &name) && have.preset.params == params) {
                skipped += 1;
                continue;
            }
            let group = adjustments::clean_name(&e.group).filter(|g| g != BUILTIN_GROUP).unwrap_or_else(|| USER_GROUP.into());
            let unique = lib.unique_name(&e.kind, &name);
            lib.save(&e.kind, &unique, params, Some(&group)).map_err(|err| bad(cmd, err))?;
            added += 1;
        }
        self.tally("adjustments", added, skipped);
        if unknown > 0 {
            self.skipped.insert("adjustmentKindsUnknown".into(), json!(unknown));
        }
        self.adjustments = Some(lib);
        Ok(())
    }

    /// Puts the staged libraries in place; `reply` gets the counts (`<kind>` added, `skipped`).
    pub fn apply(self, s: &mut Session, reply: &mut Value) {
        let changed = self.added.values().any(|v| v.as_u64().unwrap_or(0) > 0);
        if let Some(v) = self.swatches {
            s.presets.swatches = v;
        }
        if let Some(v) = self.gradients {
            s.presets.gradients = v;
        }
        if let Some(v) = self.styles {
            s.presets.styles = v;
        }
        if let Some(v) = self.shapes {
            s.presets.shapes = v;
        }
        for c in self.custom {
            // Upstream's rule for Define Custom Shape results: the same name is replaced.
            match s.edit_state.custom_shapes.iter_mut().find(|x| x.name == c.name) {
                Some(x) => *x = c,
                None => s.edit_state.custom_shapes.push(c),
            }
        }
        for p in self.patterns {
            s.patterns.upsert(p);
        }
        for g in self.pattern_groups {
            let lib = &mut s.presets.pattern_groups;
            let gi = group_index(lib, Some(&g.name));
            for id in g.items {
                if !lib.iter().any(|g| g.items.contains(&id)) {
                    lib[gi].items.push(id);
                }
            }
        }
        crate::presets::patterns::sync(s);
        if let Some(v) = self.contours {
            s.presets.contours = v;
        }
        if let Some(v) = self.adjustments {
            s.presets.adjustments = v;
        }
        for (k, v) in self.added {
            // `customShapes` adds to upstream's count of Define Custom Shape results.
            let key = if k == "shapes" { "customShapes".to_string() } else { k };
            let before = reply.get(&key).and_then(Value::as_u64).unwrap_or(0);
            reply[key.as_str()] = json!(before + v.as_u64().unwrap_or(0));
        }
        reply["skipped"] = Value::Object(self.skipped);
        if changed {
            s.presets_changed();
        }
    }
}

/// A gradient read from a file: stops within 0..1, in order (the panel and the renderer expect
/// both).
fn tidy_gradient(g: &mut GradientPreset) {
    for (at, _) in &mut g.stops {
        *at = at.clamp(0.0, 1.0);
    }
    g.stops.sort_by(|a, b| a.0.total_cmp(&b.0));
    for (at, o) in &mut g.opacity {
        *at = at.clamp(0.0, 1.0);
        *o = o.clamp(0.0, 1.0);
    }
    g.opacity.sort_by(|a, b| a.0.total_cmp(&b.0));
}


#[cfg(test)]
#[path = "preset_file_tests.rs"]
mod tests;
