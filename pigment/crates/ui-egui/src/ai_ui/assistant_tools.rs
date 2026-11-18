//! The Assistant's tools: what the chat model may do to the document, and the checks on what it
//! asks for (`docs/generative-ai.md` › The Assistant).
//!
//! The tools are JavaScript Pigment's fourteen, aimed at the engine's commands, plus
//! `list_commands`, which stands in for the command list the JavaScript app put in its
//! instructions (this registry is far too large for that):
//!
//! | Tool | Runs |
//! |---|---|
//! | `get_document` | reads the active document |
//! | `set_active_layer` | `layer.select` |
//! | `apply_adjustment` | `image.adjustments.<kind>` |
//! | `apply_filter` | `filter.<kind>` |
//! | `list_commands` | reads the command registry |
//! | `run_command` | any command the Assistant may run ([`blocked`]), as the command palette would |
//! | `new_layer`, `set_layer_props` | `layer.new.layer`, `layer.setProps` |
//! | `select` | `select.all`, `select.deselect`, `select.inverse`, `select.rect` |
//! | `crop`, `resize_image`, `canvas_size` | `image.crop`, `image.imageSize`, `image.canvasSize` |
//! | `fill_selection` | `edit.fill`, or `edit.clear` for a transparent colour |
//! | `add_text` | `type.create` |
//! | `generative_fill` | `ai.generativeFill`, the one command of the Assistant's that sends |
//!
//! Every tool goes through [`PhotocraftApp::run`] (or the menus' `invoke` for `run_command`), so
//! each is an ordinary command: one undo step, recorded and gated like the person's own. A model
//! is not trusted with more than that: ids must exist, numbers are clamped to the command's own
//! documented ranges, rectangles are cut to the canvas, objects that arrive as JSON text are
//! parsed, and a failure goes back to the model as `{"error": …}`.

use std::collections::{HashMap, HashSet};

use photocraft_doc::{Layer, LayerContent, LayerId};
use photocraft_engine::commands::CommandSpec;
use photocraft_engine::generative::ToolSpec;
use photocraft_engine::jobs::JobId;
use serde_json::{Map, Value, json};

use super::FILL;
use crate::PhotocraftApp;
use crate::filter_dialog::{Kind, parse_spec};

/// Tool rounds per turn (JS `MAX_ROUNDS`).
pub const MAX_ROUNDS: usize = 12;
/// Messages kept per document (JS `MAX_TURNS`).
pub const MAX_MESSAGES: usize = 40;
/// The longest side of the attached composite (JS `IMAGE_EDGE`).
pub const IMAGE_EDGE: u32 = 1024;
/// Commands `list_commands` answers with at most.
const LIST_LIMIT: usize = 30;
/// Layers `get_document` lists at most.
const MAX_LAYERS: usize = 400;
/// The longest tool result sent back to the model, in characters.
const RESULT_LIMIT: usize = 12_000;
/// A filter's params spec longer than this is left out of the instructions (the model asks
/// `list_commands` for it). The adjustments, far fewer, are all spelt out.
const INLINE_SPEC: usize = 160;

const ADJUSTMENTS: &str = "image.adjustments.";
const FILTERS: &str = "filter.";
/// Commands under [`ADJUSTMENTS`] and [`FILTERS`] that are not an adjustment or a filter to apply.
const NOT_A_KIND: &[&str] =
    &["image.adjustments.blackWhite.auto", "image.adjustments.colorLookup.list", "filter.lastFilter", "filter.convertForSmartFilters", "filter.filterGallery"];

/// What the dialog said once the person finished a dialog a command opened.
pub const DIALOG_CLOSED: &str = "The command opened a dialog; the user has closed it (completed or cancelled). Call get_document to see the current state.";

/// A tool's result once the job it started has ended (the job's own result goes in).
pub type Then = Box<dyn FnOnce(&PhotocraftApp, Value) -> Result<Value, String> + Send>;

/// What running a tool came to.
pub enum Outcome {
    /// Its result, for the model.
    Done(Value),
    /// The command runs as a background job: the result is `then` of the job's.
    Job { job: JobId, then: Then },
    /// The command opened a dialog: the turn waits until the person has finished it (until no
    /// more than `open_before` dialogs are open).
    Dialog { open_before: usize, result: Value },
}

/// The tools, as the chat model is told about them. One JSON schema for both providers (the
/// backend converts it for Gemini).
pub fn tools() -> Vec<ToolSpec> {
    let rect = json!({"type": "object", "properties": {"x": {"type": "number"}, "y": {"type": "number"}, "width": {"type": "number"}, "height": {"type": "number"}}, "required": ["x", "y", "width", "height"]});
    let open = json!({"type": "object", "properties": {}});
    let tool = |name: &str, description: &str, properties: Value, required: &[&str]| {
        let mut parameters = json!({"type": "object", "properties": properties});
        if !required.is_empty() {
            parameters["required"] = json!(required);
        }
        ToolSpec { name: name.into(), description: description.into(), parameters }
    };
    vec![
        tool(
            "get_document",
            "Current document: size, layers (id, name, type, visible, opacity, blend, active) and the selection bounds. Call it before acting when unsure of ids.",
            json!({}),
            &[],
        ),
        tool("set_active_layer", "Makes a layer active (the target of adjustments, filters and fills).", json!({"id": {"type": "integer"}}), &["id"]),
        tool(
            "apply_adjustment",
            "Applies an image adjustment to the active layer pixels (destructive, undoable). kind is one of the adjustment kinds; params uses the listed parameter names.",
            json!({"kind": {"type": "string"}, "params": open}),
            &["kind"],
        ),
        tool(
            "apply_filter",
            "Applies a filter to the active layer pixels. kind is one of the filter kinds; params uses the listed parameter names.",
            json!({"kind": {"type": "string"}, "params": open}),
            &["kind"],
        ),
        tool(
            "list_commands",
            "Lists the Pigment commands whose id or name contains the filter words, each with its params and whether it can run now. Use it to find a command for run_command, or the params of a filter.",
            json!({"filter": {"type": "string"}}),
            &["filter"],
        ),
        tool(
            "run_command",
            "Runs a Pigment command by id with a params object (see list_commands). Without params, a command that has a dialog opens it and waits for the user.",
            json!({"id": {"type": "string"}, "params": {"description": "The command's params: an object (may be given as a JSON string)"}}),
            &["id"],
        ),
        tool("new_layer", "Adds an empty pixel layer above the active one and makes it active. Returns its id.", json!({"name": {"type": "string"}}), &[]),
        tool(
            "set_layer_props",
            "Changes layer properties: opacity (0-100), blend mode, visible, name.",
            json!({"id": {"type": "integer"}, "opacity": {"type": "number"}, "blend": {"type": "string"}, "visible": {"type": "boolean"}, "name": {"type": "string"}}),
            &["id"],
        ),
        tool(
            "select",
            "Changes the selection: kind 'all', 'none', 'inverse' or 'rect' (with rect in pixels).",
            json!({"kind": {"type": "string", "enum": ["all", "none", "inverse", "rect"]}, "rect": rect}),
            &["kind"],
        ),
        tool("crop", "Crops the document to a rectangle (pixels).", json!({"rect": rect}), &["rect"]),
        tool(
            "resize_image",
            "Resamples the whole image to width × height pixels.",
            json!({"width": {"type": "number"}, "height": {"type": "number"}}),
            &["width", "height"],
        ),
        tool(
            "canvas_size",
            "Changes the canvas size without scaling; anchor is one of nw, n, ne, w, c, e, sw, s, se (where the existing image stays).",
            json!({"width": {"type": "number"}, "height": {"type": "number"}, "anchor": {"type": "string"}}),
            &["width", "height"],
        ),
        tool(
            "fill_selection",
            "Fills the selection (or the whole active layer when nothing is selected) with a colour (hex such as #ff8800 or a CSS colour name).",
            json!({"color": {"type": "string"}}),
            &["color"],
        ),
        tool(
            "add_text",
            "Adds a text layer at (x, y) in pixels with a font size and colour.",
            json!({"text": {"type": "string"}, "x": {"type": "number"}, "y": {"type": "number"}, "size": {"type": "number"}, "color": {"type": "string"}}),
            &["text"],
        ),
        tool(
            "generative_fill",
            "Fills the current selection with generated content from a prompt (needs a selection and an image model).",
            json!({"prompt": {"type": "string"}}),
            &["prompt"],
        ),
    ]
}

/// The adjustments or filters `apply_adjustment` and `apply_filter` take: (kind, command).
fn kinds(prefix: &str) -> Vec<(&'static str, &'static CommandSpec)> {
    photocraft_engine::command_specs().iter().filter(|c| !NOT_A_KIND.contains(&c.id)).filter_map(|c| Some((c.id.strip_prefix(prefix)?, c))).collect()
}

/// Letters and digits of `s`, lower-cased: `Brightness/Contrast…`, `brightness-contrast` and
/// `brightnessContrast` are one kind.
fn plain(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// The command of adjustment or filter `kind`: its kind as listed, its last part when no other
/// kind ends the same (`gaussianBlur` for `blur.gaussianBlur`), or its menu name; however it is
/// spelt ([`plain`]).
fn find_kind(prefix: &str, kind: &str) -> Option<&'static CommandSpec> {
    let want = plain(kind.strip_prefix(prefix).unwrap_or(kind));
    if want.is_empty() {
        return None;
    }
    let all = kinds(prefix);
    if let Some((_, c)) = all.iter().find(|(k, _)| plain(k) == want) {
        return Some(c);
    }
    let last = |k: &str| plain(k.rsplit('.').next().unwrap_or(k));
    let mut by_tail = all.iter().filter(|(k, c)| last(k) == want || plain(c.label) == want);
    let first = by_tail.next()?;
    by_tail.next().is_none().then_some(first.1)
}

/// The leading `{…}` of a params spec, without the notes after it.
fn spec_object(spec: &str) -> &str {
    let s = spec.trim();
    if !s.starts_with('{') {
        return "";
    }
    let (mut depth, mut in_str) = (0i32, false);
    for (i, ch) in s.char_indices() {
        match ch {
            '"' => in_str = !in_str,
            '[' | '{' if !in_str => depth += 1,
            ']' | '}' if !in_str => {
                depth -= 1;
                if depth == 0 {
                    return s.get(..=i).unwrap_or(s);
                }
            }
            _ => {}
        }
    }
    s
}

/// One line per kind with its params (names, ranges and defaults, as the registry documents
/// them), for the instructions. A spec longer than `inline` characters is left as `{…}`.
fn kind_list(prefix: &str, inline: usize) -> String {
    kinds(prefix)
        .iter()
        .map(|(kind, c)| {
            let spec = spec_object(c.params);
            match spec {
                "" | "{}" => (*kind).to_string(),
                s if s.chars().count() > inline => format!("{kind} {{…}}"),
                s => format!("{kind} {s}"),
            }
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// Commands worth naming in the instructions: the model finds the rest with `list_commands`.
const COMMON_COMMANDS: &[&str] = &[
    "edit.undo",
    "edit.redo",
    "edit.stroke",
    "edit.transform.flipHorizontal",
    "edit.transform.flipVertical",
    "edit.transform.rotate90Cw",
    "edit.contentAwareFill",
    "image.autoTone",
    "image.autoContrast",
    "image.autoColor",
    "image.imageRotation.180",
    "image.imageRotation.90cw",
    "image.imageRotation.flipCanvasHorizontal",
    "image.trim",
    "image.mode.grayscale",
    "image.mode.rgb",
    "layer.duplicate",
    "layer.delete",
    "layer.rasterize.layer",
    "layer.mergeDown",
    "layer.mergeVisible",
    "layer.flattenImage",
    "layer.removeBackground",
    "layer.layerMask.revealSelection",
    "layer.newAdjustmentLayer.curves",
    "select.subject",
    "select.sky",
    "select.colorRange",
    "select.modify.feather",
    "select.modify.expand",
    "select.modify.contract",
    "view.fitOnScreen",
    "view.actualPixels",
    "file.fileInfo",
];

/// The system prompt: who the Assistant is, how to work, and what there is to work with (the
/// adjustment and filter kinds with their params, the blend modes, how to find commands), all
/// read from the engine's own registries.
pub fn instructions() -> String {
    let blends = photocraft_color::BlendMode::LAYER_MODES.iter().map(|m| m.label()).collect::<Vec<_>>().join(", ");
    let common = COMMON_COMMANDS.iter().filter(|id| crate::menus::is_live(id) && !blocked_id(id)).copied().collect::<Vec<_>>().join(", ");
    let total = photocraft_engine::command_specs().iter().filter(|c| !blocked_id(c.id)).count();
    [
        "You are the assistant inside Pigment, a layer-based raster image editor (Photoshop-like). The user is editing the active document; a downscaled copy of its composite may be attached to the message.".to_string(),
        "Help with the image: answer questions about it and perform edits with the tools. Prefer the specific tools (apply_adjustment, apply_filter, select, crop, add_text, ...) over run_command. Every tool changes the document immediately and is undoable; call get_document when you need layer ids or the selection. Act without asking for confirmation unless the request is ambiguous. Keep answers short and say what you changed.".to_string(),
        "Edits apply to the active layer (image adjustments and filters are destructive on it); add a new layer first when the user wants a separate layer. Coordinates are document pixels with the origin at the top left. Layer ids are numbers.".to_string(),
        format!("Adjustment kinds (params as name:range=default): {}.", kind_list(ADJUSTMENTS, usize::MAX)),
        format!("Filter kinds (params as name:range=default; {{…}} means: ask list_commands for them): {}.", kind_list(FILTERS, INLINE_SPEC)),
        "colorLookup's looks are its \"lut\" values. matchColor needs a second open document and is best left to its dialog.".to_string(),
        format!("Blend modes: {blends}."),
        format!(
            "Commands for run_command: Pigment has about {total} commands the assistant may run, each with its own params; find one with list_commands (filter words such as \"rotate\", \"layer mask\" or \"select.\") and read its params there. Some common ones: {common}. Also image.adjustments.<kind> and filter.<kind> (params object), which apply_adjustment and apply_filter wrap."
        ),
    ]
    .join("\n\n")
}

/// Commands the Assistant may run although their family is blocked.
const ALLOWED: &[&str] = &[
    FILL,
    "file.fileInfo",
    "file.scripts.deleteAllEmptyLayers",
    "file.scripts.flattenAllLayerEffects",
    "file.scripts.flattenAllMasks",
    "tools.setColors",
    "tools.defaultColors",
    "tools.swapColors",
    "actions.list",
    "actions.get",
    "jobs.list",
    "prefs.get",
    "document.inspect",
    "document.pixel",
    "document.sampleColor",
    "session.inspect",
    "command.list",
];

/// Families the Assistant may not run (JS `BLOCKED_COMMANDS`, for this registry): they open,
/// save, export, print or close files, quit, change the app's settings, windows or tools, play
/// or record actions and scripts, cancel jobs, install plug-ins, or talk to the AI providers
/// themselves.
const BLOCKED_PREFIXES: &[&str] = &[
    "file.",
    "help.",
    "window.",
    "ai.",
    "tool.",
    "tools.",
    "ui.",
    "edit.preferences",
    "edit.presets.",
    "edit.purge.",
    "prefs.",
    "actions.",
    "jobs.",
    "plugin.",
    "updates.",
    "document.",
    "session.",
    "command.",
];

/// Single commands the Assistant may not run: app-wide settings, what cannot be undone, what
/// reads or writes a file (a smart object's, a video's, the ones a data set names) or shows one
/// in the file manager, and what changes another document.
const BLOCKED_IDS: &[&str] = &[
    "edit.keyboardShortcuts",
    "edit.menus",
    "edit.toolbar",
    "edit.colorSettings",
    "edit.search",
    "history.clear",
    "history.deleteState",
    "history.deleteSnapshot",
    "history.options",
    "image.applyDataSet",
    "layer.copyToDocument",
    "layer.layerStyle.contours.load",
    "layer.layerStyle.contours.save",
    "layer.smartObjects.convertToLinked",
    "layer.smartObjects.relinkToFile",
    "layer.smartObjects.replaceContents",
    "layer.smartObjects.revealInFinder",
    "layer.smartObjects.saveContents",
    "layer.videoLayers.newVideoLayerFromFile",
    "layer.videoLayers.replaceFootage",
];

/// The person's preset libraries (brushes, swatches, patterns, gradients, styles, shapes,
/// contours): they outlive the document and Undo does not bring them back, so the Assistant may
/// read them, use them and add to them, and no more ([`changes_presets`]).
const PRESET_FAMILIES: &[&str] =
    &["brush.presets.", "swatches.", "pattern.", "gradient.presets.", "style.presets.", "shape.presets.", "layer.layerStyle.contours."];

/// Whether `id` deletes, resets, renames, moves or overwrites entries of a preset library.
fn changes_presets(id: &str) -> bool {
    let last = id.rsplit('.').next().unwrap_or(id);
    PRESET_FAMILIES.iter().any(|f| id.starts_with(f)) && ["delete", "reset", "edit", "rename", "move", "update"].iter().any(|verb| last.starts_with(verb))
}

/// Params that name a script or its steps: never the Assistant's, whatever they hold.
const SCRIPT_KEYS: &[&str] = &["script", "steps"];

/// Params that name a file or a folder: the Assistant works on the open document only. Some
/// commands use the same names for something else (an output that is one of a few listed
/// choices, a path that is geometry), which [`names_a_file`] tells apart.
const PATH_KEYS: &[&str] = &["path", "paths", "file", "folder", "directory", "output", "destination", "mapPath"];

/// Whether `id`'s last part says it imports or exports: a preset library or a file, neither of
/// which is the document (`swatches.import`, `layer.exportAs`, `layer.quickExportAsPng`).
fn moves_files(id: &str) -> bool {
    let last = id.rsplit('.').next().unwrap_or(id);
    ["import", "export", "quickExport"].iter().any(|verb| last.starts_with(verb))
}

fn blocked_id(id: &str) -> bool {
    !ALLOWED.contains(&id)
        && (BLOCKED_PREFIXES.iter().any(|p| id.starts_with(p))
            || BLOCKED_IDS.contains(&id)
            || id.starts_with("image.variables.")
            || moves_files(id)
            || changes_presets(id))
}

/// Whether the value of a [`PATH_KEYS`] param names a file: text does, unless it is one of the
/// choices the command lists for that key (`"output":"current|new|duplicate"`); so does a list
/// with text in it. An object or a list of numbers is geometry (its own keys are looked at in
/// turn).
fn names_a_file(key: &str, value: &Value, choices: &HashMap<String, Vec<String>>) -> bool {
    match value {
        Value::String(v) => !choices.get(key).is_some_and(|options| options.iter().any(|o| o == v)),
        Value::Array(a) => a.iter().any(Value::is_string),
        _ => false,
    }
}

/// The first param of `params`, at any depth [`sanitize_params`] keeps, that names a file, a
/// folder or a script.
fn file_param<'a>(params: &'a Value, choices: &HashMap<String, Vec<String>>, depth: usize) -> Option<&'a str> {
    let on_disk = |key: &str, value: &Value| {
        SCRIPT_KEYS.contains(&key)
            || (PATH_KEYS.contains(&key) && names_a_file(key, value, choices))
            // A colour profile is a built-in id, or a file: only the id is the Assistant's.
            || (key == "profile" && value.as_str().is_some_and(|v| v.contains(['/', '\\']) || [".icc", ".icm"].iter().any(|e| v.to_ascii_lowercase().ends_with(e))))
    };
    // The choices are the top level's: a nested param is held to its name alone.
    let nested = HashMap::new();
    match params {
        Value::Object(o) => o.iter().find_map(|(k, v)| {
            if on_disk(k, v) {
                Some(k.as_str())
            } else if depth < 4 {
                file_param(v, &nested, depth + 1)
            } else {
                None
            }
        }),
        Value::Array(a) if depth < 4 => a.iter().find_map(|v| file_param(v, &nested, depth + 1)),
        _ => None,
    }
}

/// The Assistant's command policy, in the shape of the automation gate
/// (`Services::automation_command`): `Err` with what the model is told when `id` with `params`
/// is not the Assistant's to run. Among the `ai.*` commands only Generative Fill passes. Every
/// tool that runs a command by its id asks here: `run_command`, and `apply_adjustment` and
/// `apply_filter` (a LUT's `file`, Displace's `mapPath`).
pub fn blocked(id: &str, params: &Value) -> Result<(), String> {
    if blocked_id(id) {
        return Err(format!("Command \"{id}\" cannot be run by the assistant"));
    }
    // The values the command itself lists for each of its params.
    let choices: HashMap<String, Vec<String>> = photocraft_engine::commands::find(id)
        .map(|spec| parse_spec(spec.params))
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| match p.kind {
            Kind::Choice { options, .. } => Some((p.key, options)),
            _ => None,
        })
        .collect();
    if let Some(key) = file_param(params, &choices, 0) {
        return Err(format!("Command \"{id}\" cannot be run by the assistant with \"{key}\": it works on the open document only, not on files or scripts"));
    }
    Ok(())
}

/// Models that can only send strings (Gemini's schemas) send objects as JSON text: parse it when
/// it looks like one (JS `parseMaybeJson`).
pub fn parse_maybe_json(v: &Value) -> Value {
    let Value::String(s) = v else { return v.clone() };
    let t = s.trim();
    if !(t.starts_with('{') || t.starts_with('[')) {
        return v.clone();
    }
    serde_json::from_str(t).unwrap_or_else(|_| v.clone())
}

fn first_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// A params object from the model: an object, or one as JSON text. Nothing is an empty object;
/// text that can't be read is an error the model sees (JS `objectArg`).
pub fn object_arg(v: Option<&Value>, name: &str) -> Result<Map<String, Value>, String> {
    match v.map(parse_maybe_json) {
        None | Some(Value::Null) => Ok(Map::new()),
        Some(Value::String(s)) if s.trim().is_empty() => Ok(Map::new()),
        Some(Value::String(s)) => Err(format!("{name} must be a JSON object such as {{\"radius\": 4}}; could not read: {}", first_chars(&s, 80))),
        Some(Value::Object(o)) => Ok(o),
        Some(_) => Err(format!("{name} must be an object")),
    }
}

/// `run_command`'s params: JSON text is decoded; text that looks like JSON and isn't is an error
/// (JS `valueArg`).
pub fn value_arg(v: Option<&Value>) -> Result<Value, String> {
    let Some(Value::String(s)) = v else { return Ok(v.cloned().unwrap_or(Value::Null)) };
    let t = s.trim();
    let json_like = t.starts_with(['[', '{', '"', '-']) || t.chars().next().is_some_and(|c| c.is_ascii_digit()) || matches!(t, "true" | "false" | "null");
    if !json_like {
        return Ok(Value::String(s.clone()));
    }
    match serde_json::from_str(t) {
        Ok(v) => Ok(v),
        Err(_) if t.starts_with(['[', '{', '"']) => Err(format!("params looks like JSON but could not be read: {}", first_chars(t, 80))),
        Err(_) => Ok(Value::String(s.clone())),
    }
}

/// The numeric ranges a command documents for its params, and the keys that take a number.
struct Ranges {
    range: HashMap<String, (f64, f64)>,
    numeric: HashSet<String>,
}

impl Ranges {
    fn none() -> Self {
        Self { range: HashMap::new(), numeric: HashSet::new() }
    }

    /// From a command's params spec: the same fields its dialog is built from.
    fn of(spec: &str) -> Self {
        let mut r = Self::none();
        for p in parse_spec(spec) {
            match p.kind {
                Kind::Range { min, max, .. } if min <= max => {
                    // Through the decimal text, so 0.1 stays 0.1 (not the f32's 0.100000001, which
                    // a command would refuse as out of range at the upper end).
                    let exact = |x: f32| x.to_string().parse::<f64>().unwrap_or(f64::from(x));
                    r.range.insert(p.key.clone(), (exact(min), exact(max)));
                    r.numeric.insert(p.key);
                }
                Kind::Int { .. } => {
                    r.numeric.insert(p.key);
                }
                _ => {}
            }
        }
        r
    }
}

fn numeric_text(s: &str) -> Option<f64> {
    let t = s.trim();
    let digits = t.strip_prefix('-').unwrap_or(t);
    let plain = !digits.is_empty()
        && digits.chars().all(|c| c.is_ascii_digit() || c == '.')
        && digits.matches('.').count() <= 1
        && !digits.starts_with('.')
        && !digits.ends_with('.');
    if plain { t.parse().ok().filter(|n: &f64| n.is_finite()) } else { None }
}

/// A number as JSON, whole where it is whole (commands that take integers refuse `4.0`).
fn number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.0e15 { json!(n as i64) } else { json!(n) }
}

/// A params value the model sent, made safe to pass on: finite numbers (clamped to the command's
/// range for that key, numeric text converted where the key takes a number), booleans, strings
/// cut to `text` characters, arrays and objects to depth 4. Anything else is dropped (JS
/// `sanitizeParams`).
fn sanitize_value(key: &str, v: &Value, ranges: &Ranges, text: usize, depth: usize) -> Option<Value> {
    match v {
        Value::String(s) if ranges.numeric.contains(key) && numeric_text(s).is_some() => {
            sanitize_value(key, &number(numeric_text(s).unwrap_or(0.0)), ranges, text, depth)
        }
        Value::Number(n) => {
            let x = n.as_f64().filter(|x| x.is_finite())?;
            Some(match ranges.range.get(key) {
                Some(&(lo, hi)) => number(x.clamp(lo, hi)),
                None => v.clone(),
            })
        }
        Value::Bool(_) => Some(v.clone()),
        Value::String(s) => Some(Value::String(first_chars(s, text))),
        Value::Array(a) if depth < 4 => Some(Value::Array(a.iter().take(4096).filter_map(|x| sanitize_value(key, x, ranges, text, depth + 1)).collect())),
        Value::Object(o) if depth < 4 => Some(Value::Object(sanitize_object(o, ranges, text, depth + 1))),
        _ => None,
    }
}

fn sanitize_object(o: &Map<String, Value>, ranges: &Ranges, text: usize, depth: usize) -> Map<String, Value> {
    o.iter().take(256).filter_map(|(k, v)| Some((k.clone(), sanitize_value(k, v, ranges, text, depth)?))).collect()
}

/// [`sanitize_value`] for a command's params, by its params spec.
pub fn sanitize_params(params: &Map<String, Value>, spec: &str, text: usize) -> Value {
    Value::Object(sanitize_object(params, &Ranges::of(spec), text, 0))
}

/// A number argument (a number, or one as text), clamped.
fn num(v: Option<&Value>, name: &str, lo: f64, hi: f64) -> Result<f64, String> {
    let n = match v {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
        _ => None,
    };
    n.filter(|n| n.is_finite()).map(|n| n.clamp(lo, hi)).ok_or_else(|| format!("{name} must be a number"))
}

/// An argument the model left out, or filled with `null` (which means "the default").
fn given<'a>(args: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    args.get(key).filter(|v| !v.is_null())
}

/// The active document's size, resolution and whether it has a Background layer.
fn canvas(app: &PhotocraftApp) -> Result<(u32, u32, f32, bool), String> {
    let st = app.session.active().ok_or("Open a document first")?;
    Ok((st.doc.size.width, st.doc.size.height, st.doc.resolution_dpi, st.doc.background().is_some()))
}

/// A rectangle argument cut to the canvas; an empty intersection or a size that isn't positive
/// is an error, not a 1 px rectangle (JS `rectArg`).
pub fn rect_arg(v: Option<&Value>, width: u32, height: u32) -> Result<[i64; 4], String> {
    let r = v.map(parse_maybe_json);
    let Some(Value::Object(r)) = r else { return Err("rect must be { x, y, width, height }".into()) };
    const BIG: f64 = 1.0e7;
    let (x0, y0) = (num(r.get("x"), "rect.x", -BIG, BIG)?, num(r.get("y"), "rect.y", -BIG, BIG)?);
    let (w0, h0) = (num(r.get("width"), "rect.width", -BIG, BIG)?, num(r.get("height"), "rect.height", -BIG, BIG)?);
    if w0 <= 0.0 || h0 <= 0.0 {
        return Err("rect.width and rect.height must be positive".into());
    }
    let (x1, y1) = ((x0.round() as i64).max(0), (y0.round() as i64).max(0));
    let (x2, y2) = (((x0 + w0).round() as i64).min(i64::from(width)), ((y0 + h0).round() as i64).min(i64::from(height)));
    if x2 <= x1 || y2 <= y1 {
        return Err(format!("rect lies outside the canvas ({width} × {height})"));
    }
    Ok([x1, y1, x2 - x1, y2 - y1])
}

/// The CSS named colours (CSS Color Module Level 4), as `0xRRGGBB`.
const CSS_COLORS: &[(&str, u32)] = &[
    ("aliceblue", 0xf0f8ff),
    ("antiquewhite", 0xfaebd7),
    ("aqua", 0x00ffff),
    ("aquamarine", 0x7fffd4),
    ("azure", 0xf0ffff),
    ("beige", 0xf5f5dc),
    ("bisque", 0xffe4c4),
    ("black", 0x000000),
    ("blanchedalmond", 0xffebcd),
    ("blue", 0x0000ff),
    ("blueviolet", 0x8a2be2),
    ("brown", 0xa52a2a),
    ("burlywood", 0xdeb887),
    ("cadetblue", 0x5f9ea0),
    ("chartreuse", 0x7fff00),
    ("chocolate", 0xd2691e),
    ("coral", 0xff7f50),
    ("cornflowerblue", 0x6495ed),
    ("cornsilk", 0xfff8dc),
    ("crimson", 0xdc143c),
    ("cyan", 0x00ffff),
    ("darkblue", 0x00008b),
    ("darkcyan", 0x008b8b),
    ("darkgoldenrod", 0xb8860b),
    ("darkgray", 0xa9a9a9),
    ("darkgreen", 0x006400),
    ("darkgrey", 0xa9a9a9),
    ("darkkhaki", 0xbdb76b),
    ("darkmagenta", 0x8b008b),
    ("darkolivegreen", 0x556b2f),
    ("darkorange", 0xff8c00),
    ("darkorchid", 0x9932cc),
    ("darkred", 0x8b0000),
    ("darksalmon", 0xe9967a),
    ("darkseagreen", 0x8fbc8f),
    ("darkslateblue", 0x483d8b),
    ("darkslategray", 0x2f4f4f),
    ("darkslategrey", 0x2f4f4f),
    ("darkturquoise", 0x00ced1),
    ("darkviolet", 0x9400d3),
    ("deeppink", 0xff1493),
    ("deepskyblue", 0x00bfff),
    ("dimgray", 0x696969),
    ("dimgrey", 0x696969),
    ("dodgerblue", 0x1e90ff),
    ("firebrick", 0xb22222),
    ("floralwhite", 0xfffaf0),
    ("forestgreen", 0x228b22),
    ("fuchsia", 0xff00ff),
    ("gainsboro", 0xdcdcdc),
    ("ghostwhite", 0xf8f8ff),
    ("gold", 0xffd700),
    ("goldenrod", 0xdaa520),
    ("gray", 0x808080),
    ("green", 0x008000),
    ("greenyellow", 0xadff2f),
    ("grey", 0x808080),
    ("honeydew", 0xf0fff0),
    ("hotpink", 0xff69b4),
    ("indianred", 0xcd5c5c),
    ("indigo", 0x4b0082),
    ("ivory", 0xfffff0),
    ("khaki", 0xf0e68c),
    ("lavender", 0xe6e6fa),
    ("lavenderblush", 0xfff0f5),
    ("lawngreen", 0x7cfc00),
    ("lemonchiffon", 0xfffacd),
    ("lightblue", 0xadd8e6),
    ("lightcoral", 0xf08080),
    ("lightcyan", 0xe0ffff),
    ("lightgoldenrodyellow", 0xfafad2),
    ("lightgray", 0xd3d3d3),
    ("lightgreen", 0x90ee90),
    ("lightgrey", 0xd3d3d3),
    ("lightpink", 0xffb6c1),
    ("lightsalmon", 0xffa07a),
    ("lightseagreen", 0x20b2aa),
    ("lightskyblue", 0x87cefa),
    ("lightslategray", 0x778899),
    ("lightslategrey", 0x778899),
    ("lightsteelblue", 0xb0c4de),
    ("lightyellow", 0xffffe0),
    ("lime", 0x00ff00),
    ("limegreen", 0x32cd32),
    ("linen", 0xfaf0e6),
    ("magenta", 0xff00ff),
    ("maroon", 0x800000),
    ("mediumaquamarine", 0x66cdaa),
    ("mediumblue", 0x0000cd),
    ("mediumorchid", 0xba55d3),
    ("mediumpurple", 0x9370db),
    ("mediumseagreen", 0x3cb371),
    ("mediumslateblue", 0x7b68ee),
    ("mediumspringgreen", 0x00fa9a),
    ("mediumturquoise", 0x48d1cc),
    ("mediumvioletred", 0xc71585),
    ("midnightblue", 0x191970),
    ("mintcream", 0xf5fffa),
    ("mistyrose", 0xffe4e1),
    ("moccasin", 0xffe4b5),
    ("navajowhite", 0xffdead),
    ("navy", 0x000080),
    ("oldlace", 0xfdf5e6),
    ("olive", 0x808000),
    ("olivedrab", 0x6b8e23),
    ("orange", 0xffa500),
    ("orangered", 0xff4500),
    ("orchid", 0xda70d6),
    ("palegoldenrod", 0xeee8aa),
    ("palegreen", 0x98fb98),
    ("paleturquoise", 0xafeeee),
    ("palevioletred", 0xdb7093),
    ("papayawhip", 0xffefd5),
    ("peachpuff", 0xffdab9),
    ("peru", 0xcd853f),
    ("pink", 0xffc0cb),
    ("plum", 0xdda0dd),
    ("powderblue", 0xb0e0e6),
    ("purple", 0x800080),
    ("rebeccapurple", 0x663399),
    ("red", 0xff0000),
    ("rosybrown", 0xbc8f8f),
    ("royalblue", 0x4169e1),
    ("saddlebrown", 0x8b4513),
    ("salmon", 0xfa8072),
    ("sandybrown", 0xf4a460),
    ("seagreen", 0x2e8b57),
    ("seashell", 0xfff5ee),
    ("sienna", 0xa0522d),
    ("silver", 0xc0c0c0),
    ("skyblue", 0x87ceeb),
    ("slateblue", 0x6a5acd),
    ("slategray", 0x708090),
    ("slategrey", 0x708090),
    ("snow", 0xfffafa),
    ("springgreen", 0x00ff7f),
    ("steelblue", 0x4682b4),
    ("tan", 0xd2b48c),
    ("teal", 0x008080),
    ("thistle", 0xd8bfd8),
    ("tomato", 0xff6347),
    ("turquoise", 0x40e0d0),
    ("violet", 0xee82ee),
    ("wheat", 0xf5deb3),
    ("white", 0xffffff),
    ("whitesmoke", 0xf5f5f5),
    ("yellow", 0xffff00),
    ("yellowgreen", 0x9acd32),
];

/// One `rgb()` channel: a number 0..255 or a percentage.
fn channel(s: &str) -> Option<u8> {
    let s = s.trim();
    let v = match s.strip_suffix('%') {
        Some(p) => p.trim().parse::<f64>().ok()? * 2.55,
        None => s.parse::<f64>().ok()?,
    };
    v.is_finite().then(|| v.round().clamp(0.0, 255.0) as u8)
}

/// An `rgb()` alpha: a number 0..1 or a percentage.
fn alpha_part(s: &str) -> Option<f32> {
    let s = s.trim();
    let v = match s.strip_suffix('%') {
        Some(p) => p.trim().parse::<f32>().ok()? / 100.0,
        None => s.parse::<f32>().ok()?,
    };
    v.is_finite().then(|| v.clamp(0.0, 1.0))
}

/// A colour argument from the model: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`,
/// a CSS colour name or `transparent`, as (`#rrggbb`, alpha 0..1). Nonsense is an error the model
/// sees (JS `colorArg`).
pub fn color_arg(v: Option<&Value>) -> Result<(String, f32), String> {
    let raw = match v {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    };
    let unknown = || format!("Unknown colour \"{}\"", first_chars(&raw, 60));
    let s = raw.to_ascii_lowercase();
    let hex = |rgb: [u8; 3]| format!("#{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2]);
    if s == "transparent" {
        return Ok(("#000000".into(), 0.0));
    }
    if let Some(h) = s.strip_prefix('#') {
        if !h.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(unknown());
        }
        let digits: Vec<u8> = h.chars().filter_map(|c| c.to_digit(16)).map(|d| d as u8).collect();
        let (rgb, a): ([u8; 3], u8) = match digits.as_slice() {
            [r, g, b] => ([r * 17, g * 17, b * 17], 255),
            [r, g, b, a] => ([r * 17, g * 17, b * 17], a * 17),
            [r1, r2, g1, g2, b1, b2] => ([r1 * 16 + r2, g1 * 16 + g2, b1 * 16 + b2], 255),
            [r1, r2, g1, g2, b1, b2, a1, a2] => ([r1 * 16 + r2, g1 * 16 + g2, b1 * 16 + b2], a1 * 16 + a2),
            _ => return Err(unknown()),
        };
        return Ok((hex(rgb), f32::from(a) / 255.0));
    }
    if let Some(body) = s.strip_prefix("rgba(").or_else(|| s.strip_prefix("rgb(")).and_then(|b| b.strip_suffix(')')) {
        let parts: Vec<&str> = body.split([',', '/', ' ']).filter(|p| !p.trim().is_empty()).collect();
        let rgb = match parts.as_slice() {
            [r, g, b] | [r, g, b, _] => [channel(r), channel(g), channel(b)],
            _ => return Err(unknown()),
        };
        let [Some(r), Some(g), Some(b)] = rgb else { return Err(unknown()) };
        let a = match parts.get(3) {
            Some(a) => alpha_part(a).ok_or_else(unknown)?,
            None => 1.0,
        };
        return Ok((hex([r, g, b]), a));
    }
    let name: String = s.chars().filter(|c| !c.is_whitespace() && *c != '-' && *c != '_').collect();
    match CSS_COLORS.iter().find(|(n, _)| *n == name) {
        Some(&(_, c)) => Ok((format!("#{c:06x}"), 1.0)),
        None => Err(unknown()),
    }
}

/// A layer argument: its id (a number, or one as text) or, failing that, the one layer with
/// that name. The layer's id and name (JS `findLayer`).
fn layer_arg(app: &PhotocraftApp, v: Option<&Value>) -> Result<(u64, String), String> {
    let st = app.session.active().ok_or("Open a document first")?;
    let named = |name: &str| -> Option<u64> {
        let mut found = None;
        let mut pending: Vec<&Layer> = st.doc.layers.iter().collect();
        while let Some(l) = pending.pop() {
            if l.name == name {
                if found.is_some() {
                    return None;
                }
                found = Some(l.id.0);
            }
            pending.extend(l.children().unwrap_or_default());
        }
        found
    };
    let id = match v {
        Some(Value::Number(n)) => n.as_u64(),
        Some(Value::String(s)) => s.trim().parse::<u64>().ok().or_else(|| named(s)),
        _ => return Err("id must be a layer id (a number; call get_document for the ids)".into()),
    };
    let shown = v.map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_string)).unwrap_or_default();
    id.and_then(|id| st.doc.layer(LayerId(id)))
        .map(|l| (l.id.0, l.name.clone()))
        .ok_or_else(|| format!("No layer with id \"{}\" (call get_document for the ids)", first_chars(&shown, 60)))
}

/// The active layer when adjustments, filters and fills can change its pixels: its name, and
/// whether it is a plain pixel layer (JS `needRaster`).
fn need_raster(app: &PhotocraftApp) -> Result<(String, bool), String> {
    let none = "No active pixel layer: call set_active_layer or new_layer first";
    let st = app.session.active().ok_or("Open a document first")?;
    let l = st.active_layer.and_then(|id| st.doc.layer(id)).ok_or(none)?;
    match &l.content {
        LayerContent::Group(_) => return Err(none.into()),
        LayerContent::Adjustment(_) => return Err("The active layer is an adjustment layer; activate a pixel layer".into()),
        LayerContent::Raster(_) | LayerContent::Smart(_) => {}
        other => {
            return Err(format!(
                "The active layer is {} {} layer; run_command layer.rasterize.layer first or activate a pixel layer",
                other.article(),
                other.kind_name().to_lowercase()
            ));
        }
    }
    if l.locks.all || l.locks.pixels {
        return Err(format!("Layer \"{}\" is locked", l.name));
    }
    Ok((l.name.clone(), matches!(l.content, LayerContent::Raster(_))))
}

fn selection_bounds(app: &PhotocraftApp) -> Option<Value> {
    let st = app.session.active()?;
    let r = st.doc.selection.as_ref()?.content_bounds();
    (r.width() > 0 && r.height() > 0).then(|| json!({"x": r.x0, "y": r.y0, "width": r.width(), "height": r.height()}))
}

fn layer_info(l: &Layer, parent: Option<u64>, active: Option<LayerId>, background: bool) -> Value {
    let mut v = json!({
        "id": l.id.0,
        "name": l.name,
        "type": l.content.kind_name().to_lowercase(),
        "visible": l.visible,
        "opacity": (l.opacity * 100.0).round(),
        "blend": l.blend.label(),
        "active": active == Some(l.id),
        "parent": parent,
    });
    if l.mask.is_some() {
        v["mask"] = json!(true);
    }
    if l.locks.all || l.locks.pixels {
        v["locked"] = json!(true);
    }
    if background {
        v["background"] = json!(true);
    }
    if let LayerContent::Text(t) = &l.content {
        v["text"] = json!(first_chars(&t.text, 200));
    }
    v
}

/// `get_document`: the active document as the model needs it (not the whole `document.inspect`).
fn get_document(app: &PhotocraftApp) -> Result<Value, String> {
    let st = app.session.active().ok_or("Open a document first")?;
    let doc = &st.doc;
    let background = doc.background().map(|l| l.id);
    let mut layers = Vec::new();
    let mut more = 0usize;
    // Top to bottom, a group before its layers.
    let mut pending: Vec<(&Layer, Option<u64>)> = doc.layers.iter().map(|l| (l, None)).collect();
    while let Some((l, parent)) = pending.pop() {
        if layers.len() >= MAX_LAYERS {
            more += 1;
        } else {
            layers.push(layer_info(l, parent, st.active_layer, background == Some(l.id)));
        }
        pending.extend(l.children().unwrap_or_default().iter().map(|c| (c, Some(l.id.0))));
    }
    let mut v = json!({
        "name": doc.name,
        "width": doc.size.width,
        "height": doc.size.height,
        "dpi": doc.resolution_dpi,
        "mode": format!("{:?}", doc.mode),
        "depth": doc.depth.bits(),
        "activeLayer": st.active_layer.map(|l| l.0),
        "layers": layers,
        "selection": selection_bounds(app),
    });
    if more > 0 {
        v["moreLayers"] = json!(more);
    }
    let info = photocraft_engine::file_cmds::read_file_info(doc.metadata.xmp.as_deref());
    if let Some(d) = info.get("description").and_then(Value::as_str).filter(|d| !d.trim().is_empty()) {
        v["description"] = json!(first_chars(d, 2000));
    }
    Ok(v)
}

/// `list_commands`: the commands the Assistant may run that match every word of the filter.
fn list_commands(app: &PhotocraftApp, args: &Map<String, Value>) -> Result<Value, String> {
    let filter = args.get("filter").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let specs = photocraft_engine::command_specs().iter().filter(|c| !blocked_id(c.id));
    let words: Vec<&str> = filter.split_whitespace().collect();
    if words.is_empty() {
        let mut groups: std::collections::BTreeMap<&str, usize> = std::collections::BTreeMap::new();
        for c in specs {
            *groups.entry(c.id.split('.').next().unwrap_or(c.id)).or_default() += 1;
        }
        return Ok(json!({"groups": groups, "hint": "Pass filter words, such as \"rotate\", \"layer mask\", \"gaussian\" or \"select.\"."}));
    }
    let mut commands = Vec::new();
    let mut more = 0usize;
    for c in specs {
        let entry = photocraft_engine::commands::list_entry(&app.session, c, None);
        if !words.iter().all(|w| photocraft_engine::commands::list_entry_matches(&entry, w)) {
            continue;
        }
        if commands.len() >= LIST_LIMIT {
            more += 1;
            continue;
        }
        let mut row = json!({"id": c.id, "name": c.label.trim_end_matches('…'), "params": first_chars(c.params, 700)});
        if let Some(why) = app.session.disabled_reason(c.id) {
            row["unavailable"] = json!(why);
        }
        commands.push(row);
    }
    let mut v = json!({"commands": commands});
    if more > 0 {
        v["more"] = json!(more);
        v["hint"] = json!("Narrow the filter to see the rest.");
    }
    Ok(v)
}

/// The job `r` started, when it is a background job's `{"job", "pending"}`.
fn pending_job(r: &Value) -> Option<JobId> {
    r.get("pending").and_then(Value::as_bool).filter(|p| *p).and_then(|_| r.get("job")?.as_u64()).map(JobId)
}

/// A command's result as a tool's: `then` of it now, or of the job's once the command runs in
/// the background.
fn finish(
    app: &PhotocraftApp,
    r: Result<Value, String>,
    then: impl FnOnce(&PhotocraftApp, Value) -> Result<Value, String> + Send + 'static,
) -> Result<Outcome, String> {
    let v = r?;
    match pending_job(&v) {
        Some(job) => Ok(Outcome::Job { job, then: Box::new(then) }),
        None => then(app, v).map(Outcome::Done),
    }
}

fn size_text(app: &PhotocraftApp) -> String {
    canvas(app).map(|(w, h, ..)| format!("{w} × {h}")).unwrap_or_default()
}

fn text_arg(args: &Map<String, Value>, key: &str) -> Option<String> {
    given(args, key).map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_string))
}

fn apply_kind(app: &mut PhotocraftApp, prefix: &str, what: &str, args: &Map<String, Value>) -> Result<Outcome, String> {
    let kind = text_arg(args, "kind").unwrap_or_default();
    let spec = find_kind(prefix, &kind).ok_or_else(|| format!("Unknown {what} \"{}\"", first_chars(&kind, 60)))?;
    let (layer, _) = need_raster(app)?;
    let params = sanitize_params(&object_arg(args.get("params"), "params")?, spec.params, 200);
    // A LUT's file, Displace's map: no more the Assistant's here than through run_command.
    blocked(spec.id, &params)?;
    let name = spec.label.trim_end_matches('…').to_string();
    let r = app.run(spec.id, params);
    finish(app, r, move |_, _| Ok(json!(format!("Applied {name} to \"{layer}\""))))
}

fn set_layer_props(app: &mut PhotocraftApp, args: &Map<String, Value>) -> Result<Outcome, String> {
    let (id, layer) = layer_arg(app, args.get("id"))?;
    let mut patch = Map::new();
    // `null` means "leave unchanged" (models fill unused fields with it), never a value.
    if let Some(o) = given(args, "opacity") {
        patch.insert("opacity".into(), json!(num(Some(o), "opacity", 0.0, 100.0)? / 100.0));
    }
    if let Some(b) = given(args, "blend") {
        patch.insert("blend".into(), json!(b.as_str().map_or_else(|| b.to_string(), str::to_string)));
    }
    if let Some(v) = given(args, "visible") {
        let on = match v {
            Value::String(s) => !matches!(s.trim().to_ascii_lowercase().as_str(), "false" | "0" | "no" | "off"),
            Value::Bool(b) => *b,
            Value::Number(n) => n.as_f64() != Some(0.0),
            _ => true,
        };
        patch.insert("visible".into(), json!(on));
    }
    if let Some(name) = text_arg(args, "name") {
        let name = first_chars(name.trim(), 80);
        if name.is_empty() {
            return Err("name is empty".into());
        }
        patch.insert("name".into(), json!(name));
    }
    if patch.is_empty() {
        return Err("Nothing to change".into());
    }
    let keys = patch.keys().cloned().collect::<Vec<_>>().join(", ");
    patch.insert("layer".into(), json!(id));
    let r = app.run("layer.setProps", Value::Object(patch));
    finish(app, r, move |_, _| Ok(json!(format!("Updated {layer}: {keys}"))))
}

fn select(app: &mut PhotocraftApp, args: &Map<String, Value>) -> Result<Outcome, String> {
    let (w, h, ..) = canvas(app)?;
    let selected = selection_bounds(app).is_some();
    let r = match args.get("kind").and_then(Value::as_str).unwrap_or("") {
        "all" => app.run("select.all", json!({})),
        "none" if selected => app.run("select.deselect", json!({})),
        "none" => Ok(Value::Null),
        // The inverse of nothing selects everything.
        "inverse" if selected => app.run("select.inverse", json!({})),
        "inverse" => app.run("select.all", json!({})),
        "rect" => {
            let [x, y, width, height] = rect_arg(args.get("rect"), w, h)?;
            app.run("select.rect", json!({"x": x, "y": y, "width": width, "height": height}))
        }
        _ => return Err("kind must be 'all', 'none', 'inverse' or 'rect'".into()),
    };
    finish(app, r, |app, _| Ok(selection_bounds(app).map_or_else(|| json!("No selection"), |b| json!({"selection": b}))))
}

fn canvas_size(app: &mut PhotocraftApp, args: &Map<String, Value>) -> Result<Outcome, String> {
    let (.., background) = canvas(app)?;
    let w = num(args.get("width"), "width", 1.0, 30_000.0)?.round() as u32;
    let h = num(args.get("height"), "height", 1.0, 30_000.0)?.round() as u32;
    let anchor = match args.get("anchor").and_then(Value::as_str).unwrap_or("c") {
        "nw" | "topLeft" => "topLeft",
        "n" | "top" => "top",
        "ne" | "topRight" => "topRight",
        "w" | "left" => "left",
        "e" | "right" => "right",
        "sw" | "bottomLeft" => "bottomLeft",
        "s" | "bottom" => "bottom",
        "se" | "bottomRight" => "bottomRight",
        _ => "center",
    };
    // As the Canvas Size dialog does: a Background layer is extended with the background colour.
    let (extension, added) = if background { ("background", "filled with the background colour") } else { ("transparent", "transparent") };
    let r = app.run("image.canvasSize", json!({"width": w, "height": h, "anchor": anchor, "extensionColor": extension}));
    finish(app, r, move |app, _| Ok(json!(format!("Canvas is now {}; the added area is {added}", size_text(app)))))
}

fn fill_selection(app: &mut PhotocraftApp, args: &Map<String, Value>) -> Result<Outcome, String> {
    let (hex, alpha) = color_arg(args.get("color"))?;
    let (layer, pixels) = need_raster(app)?;
    if !pixels {
        return Err("Fill needs a pixel layer".into());
    }
    let place = if selection_bounds(app).is_some() { "the selection" } else { "the layer" };
    if alpha <= 0.0 {
        // A transparent colour clears: Edit › Clear, inside the selection or over the whole layer.
        let locked = app.session.active().and_then(|st| st.active_layer.and_then(|id| st.doc.layer(id))).is_some_and(|l| l.locks.transparency);
        if locked {
            return Err(format!("Layer \"{layer}\" has its transparency locked"));
        }
        let r = app.run("edit.clear", json!({}));
        return finish(app, r, move |_, _| Ok(json!(format!("Cleared {place} to transparent"))));
    }
    let opacity = (alpha * 100.0).round().clamp(1.0, 100.0) as u32;
    let r = app.run("edit.fill", json!({"contents": "color", "color": hex, "opacity": opacity, "mode": "normal", "preserveTransparency": false}));
    finish(app, r, move |_, _| {
        let faint = if opacity < 100 { format!(" at {opacity} % opacity") } else { String::new() };
        Ok(json!(format!("Filled {place} with {hex}{faint}")))
    })
}

fn add_text(app: &mut PhotocraftApp, args: &Map<String, Value>) -> Result<Outcome, String> {
    let (w, h, dpi, _) = canvas(app)?;
    let (w, h) = (f64::from(w), f64::from(h));
    let text = first_chars(&text_arg(args, "text").unwrap_or_default(), 2000);
    if text.trim().is_empty() {
        return Err("text is empty".into());
    }
    // `null` means "use the default", as for the colour.
    let size = match given(args, "size") {
        Some(s) => num(Some(s), "size", 4.0, 2000.0)?.round(),
        None => (h / 12.0).round().max(12.0),
    };
    let x = match given(args, "x") {
        Some(x) => num(Some(x), "x", -w, w * 2.0)?.round(),
        None => (w * 0.1).round(),
    };
    let y = match given(args, "y") {
        Some(y) => num(Some(y), "y", -h, h * 2.0)?.round(),
        None => (h * 0.1 + size).round(),
    };
    // The model gives the size in pixels; the type engine takes points at the document's resolution.
    let dpi = if dpi.is_finite() && dpi > 0.0 { f64::from(dpi) } else { 72.0 };
    let mut params = json!({"x": x, "y": y, "text": text, "size": size * 72.0 / dpi});
    if let Some(c) = given(args, "color") {
        params["color"] = json!(color_arg(Some(c))?.0);
    }
    let r = app.run("type.create", params);
    finish(app, r, |app, v| {
        let id = v.get("layer").and_then(Value::as_u64);
        let name = id.and_then(|id| app.session.active()?.doc.layer(LayerId(id)).map(|l| l.name.clone()));
        Ok(json!({"id": id, "name": name}))
    })
}

fn generative_fill(app: &mut PhotocraftApp, args: &Map<String, Value>) -> Result<Outcome, String> {
    if selection_bounds(app).is_none() {
        return Err("Generative fill needs a selection: call select first".into());
    }
    let prompt = text_arg(args, "prompt").unwrap_or_default().trim().to_string();
    if prompt.is_empty() {
        return Err("prompt is empty".into());
    }
    let prompt = first_chars(&prompt, photocraft_engine::ai_cmds::PROMPT_LIMIT);
    // Without a window, on the preferred provider and one variation, as in JavaScript Pigment.
    let r = app.run(FILL, json!({"prompt": prompt}));
    finish(app, r, |_, v| match v.get("layers").and_then(Value::as_array).filter(|l| !l.is_empty()) {
        Some(layers) => Ok(json!({"layers": layers})),
        None => Err("Generative fill produced no layer (an image model may not be connected)".into()),
    })
}

fn run_command(app: &mut PhotocraftApp, ctx: &egui::Context, args: &Map<String, Value>) -> Result<Outcome, String> {
    let Some(id) = args.get("id").and_then(Value::as_str).map(str::trim) else { return Err("id must be a command id (see list_commands)".into()) };
    let id = first_chars(id, 120);
    let params = match value_arg(args.get("params").or_else(|| args.get("arg")))? {
        Value::Null => Map::new(),
        Value::Object(o) => o,
        Value::String(s) if s.trim().is_empty() => Map::new(),
        _ => return Err("params must be a JSON object such as {\"radius\": 4}".into()),
    };
    blocked(&id, &Value::Object(params.clone()))?;
    if id == FILL {
        return generative_fill(app, &params);
    }
    let spec = photocraft_engine::commands::find(&id);
    let params = sanitize_params(&params, spec.map_or("", |s| s.params), 4000);
    if spec.is_none() && !crate::menus::is_live(&id) {
        return Err(format!("Unknown command \"{id}\" (find one with list_commands)"));
    }
    if spec.is_some() {
        if let Some(why) = app.session.disabled_reason_with(&id, &params) {
            return Err(format!("Command \"{id}\" is not available right now: {why}"));
        }
        app.session.precheck(&id, &params).map_err(|e| e.to_string())?;
    } else if !crate::menus::is_enabled(app, &id) {
        return Err(format!("Command \"{id}\" is not available right now"));
    }
    let open_before = app.ui.dialogs.len();
    let r = crate::menus::invoke(app, ctx, &id, params)?;
    if app.ui.dialogs.len() > open_before {
        return Ok(Outcome::Dialog { open_before, result: r });
    }
    finish(app, Ok(r), |_, v| Ok(plain_result(v)))
}

/// A command's result as the model reads it: `ok` when it has none.
pub fn plain_result(v: Value) -> Value {
    if v.is_null() { json!("ok") } else { v }
}

/// What the model is told once the dialog a command opened is closed: the command's own result
/// when it had one, else [`DIALOG_CLOSED`].
pub fn dialog_result(v: Value) -> Value {
    let only_the_dialog = v.as_object().is_some_and(|o| o.keys().all(|k| k == "dialog"));
    if v.is_null() || v == Value::Bool(false) || only_the_dialog { json!(DIALOG_CLOSED) } else { v }
}

/// A tool result cut to what a model should be sent.
pub fn capped(v: Value) -> Value {
    let text = match &v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    if text.chars().count() <= RESULT_LIMIT { v } else { json!({"truncated": true, "text": first_chars(&text, RESULT_LIMIT)}) }
}

/// Run tool `name` with the model's `args` on the active document. `Err` is what the model is
/// told went wrong (as `{"error": …}`); nothing the engine reports for it stays in the status
/// bar, since the Assistant shows the step itself.
pub fn run(app: &mut PhotocraftApp, ctx: &egui::Context, name: &str, args: &Value) -> Result<Outcome, String> {
    let args = match parse_maybe_json(args) {
        Value::Object(o) => o,
        _ => Map::new(),
    };
    // A Type box being dragged is applied first, as before any command.
    crate::type_box_preview::end_drag(app);
    let r = match name {
        "get_document" => get_document(app).map(Outcome::Done),
        "list_commands" => list_commands(app, &args).map(Outcome::Done),
        "set_active_layer" => layer_arg(app, args.get("id")).and_then(|(id, layer)| {
            let r = app.run("layer.select", json!({"layer": id}));
            finish(app, r, move |_, _| Ok(json!(format!("Active layer: {layer} ({id})"))))
        }),
        "apply_adjustment" => apply_kind(app, ADJUSTMENTS, "adjustment", &args),
        "apply_filter" => apply_kind(app, FILTERS, "filter", &args),
        "run_command" => run_command(app, ctx, &args),
        "new_layer" => {
            let mut params = Map::new();
            if let Some(name) = text_arg(&args, "name").map(|n| first_chars(n.trim(), 80)).filter(|n| !n.is_empty()) {
                params.insert("name".into(), json!(name));
            }
            let r = app.run("layer.new.layer", Value::Object(params));
            finish(app, r, |app, v| {
                let id = v.get("layer").and_then(Value::as_u64);
                let name = id.and_then(|id| app.session.active()?.doc.layer(LayerId(id)).map(|l| l.name.clone()));
                Ok(json!({"id": id, "name": name}))
            })
        }
        "set_layer_props" => set_layer_props(app, &args),
        "select" => select(app, &args),
        "crop" => canvas(app).and_then(|(w, h, ..)| {
            let [x, y, width, height] = rect_arg(args.get("rect"), w, h)?;
            let r = app.run("image.crop", json!({"x": x, "y": y, "width": width, "height": height, "deleteCroppedPixels": true}));
            finish(app, r, |app, _| Ok(json!(format!("Cropped to {}", size_text(app)))))
        }),
        "resize_image" => num(args.get("width"), "width", 1.0, 30_000.0).and_then(|w| {
            let h = num(args.get("height"), "height", 1.0, 30_000.0)?;
            let r = app.run("image.imageSize", json!({"width": w.round(), "height": h.round(), "resample": "bicubic", "scaleStyles": true}));
            finish(app, r, |app, _| Ok(json!(format!("Image is now {}", size_text(app)))))
        }),
        "canvas_size" => canvas_size(app, &args),
        "fill_selection" => fill_selection(app, &args),
        "add_text" => add_text(app, &args),
        "generative_fill" => generative_fill(app, &args),
        other => Err(format!("Unknown tool \"{}\"", first_chars(other, 60))),
    };
    if let Err(e) = &r
        && app.ui.status_error
        && app.ui.status == *e
    {
        app.ui.status.clear();
        app.ui.status_error = false;
    }
    r.map(|o| match o {
        Outcome::Done(v) => Outcome::Done(capped(v)),
        other => other,
    })
}

/// A short label for a tool call in the panel ("Applied Levels", "Ran filter.blur.gaussianBlur"),
/// prefixed when it failed.
pub fn describe_call(name: &str, args: &Value, failed: bool) -> String {
    let args = parse_maybe_json(args);
    let text = |key: &str| args.get(key).filter(|v| !v.is_null()).map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_string));
    let fmt = |template: &str, value: String| crate::i18n::fmt(template, &[("x", &value)]);
    let kind = |prefix: &str| {
        let kind = text("kind").unwrap_or_default();
        find_kind(prefix, &kind).map_or(kind, |c| c.label.trim_end_matches('…').to_string())
    };
    let size = || format!("{} × {}", text("width").unwrap_or_default(), text("height").unwrap_or_default());
    let label = match name {
        "get_document" => tl!("Read the document").to_string(),
        "list_commands" => fmt(tl!("Looked up commands: {x}"), text("filter").unwrap_or_default()),
        "set_active_layer" => fmt(tl!("Selected layer {x}"), text("id").unwrap_or_default()),
        "apply_adjustment" => fmt(tl!("Applied {x}"), kind(ADJUSTMENTS)),
        "apply_filter" => fmt(tl!("Applied {x}"), kind(FILTERS)),
        "run_command" => fmt(tl!("Ran {x}"), text("id").unwrap_or_default()),
        "new_layer" => match text("name") {
            Some(n) => fmt(tl!("New layer “{x}”"), n),
            None => tl!("New layer").to_string(),
        },
        "set_layer_props" => tl!("Changed layer properties").to_string(),
        "select" => fmt(tl!("Selection: {x}"), text("kind").unwrap_or_default()),
        "crop" => tl!("Cropped").to_string(),
        "resize_image" => fmt(tl!("Resized to {x}"), size()),
        "canvas_size" => fmt(tl!("Canvas size {x}"), size()),
        "fill_selection" => fmt(tl!("Filled with {x}"), text("color").unwrap_or_default()),
        "add_text" => fmt(tl!("Added text “{x}”"), first_chars(&text("text").unwrap_or_default(), 30)),
        "generative_fill" => tl!("Generative fill").to_string(),
        other => first_chars(other, 60),
    };
    if failed { fmt(tl!("Failed: {x}"), label) } else { label }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_blocked_list_keeps_files_settings_windows_and_providers_from_the_assistant() {
        for id in [
            "file.close",
            "file.save",
            "file.saveAs",
            "file.exit",
            "file.new",
            "file.open",
            "file.print",
            "file.revert",
            "file.export.exportAs",
            "file.placeEmbedded",
            "file.scripts.browse",
            "file.automate.batch",
            "edit.preferences.general",
            "edit.keyboardShortcuts",
            "prefs.set",
            "help.about",
            "window.panel.layers",
            "window.panel.aiAssistant",
            "tools.select.move",
            "actions.play",
            "actions.record",
            "jobs.cancel",
            "plugin.run",
            "ai.generateImage",
            "ai.generativeExpand",
            "ai.replaceSky",
            "ai.replaceBackground",
            "ai.removeBackground",
            "ai.describe",
            "ai.testConnection",
            "ai.status",
            "ai.accounts",
            "ai.removeBackgroundWithProvider",
            "document.activate",
            "edit.purge.histories",
            "history.clear",
        ] {
            let e = blocked(id, &json!({})).expect_err(id);
            assert_eq!(e, format!("Command \"{id}\" cannot be run by the assistant"));
        }
        for id in [
            "ai.generativeFill",
            "file.fileInfo",
            "edit.undo",
            "layer.duplicate",
            "filter.blur.gaussianBlur",
            "select.subject",
            "tools.setColors",
            "view.fitOnScreen",
        ] {
            assert_eq!(blocked(id, &json!({"radius": 2})), Ok(()), "{id}");
        }
        // A file or a script in the params is not the Assistant's either.
        let e = blocked("image.adjustments.colorLookup", &json!({"file": "/etc/passwd"})).unwrap_err();
        assert!(e.contains("\"file\"") && e.contains("open document only"), "{e}");
        assert!(blocked("layer.smartObjects.newSmartObjectViaCopy", &json!({"path": "/tmp/x.png"})).is_err());
        assert!(blocked("filter.distort.displace", &json!({"mapPath": "/tmp/map.psd"})).is_err());
        assert!(blocked("image.mode.cmyk", &json!({"profile": "/tmp/press.icc"})).is_err());
        assert_eq!(blocked("image.mode.cmyk", &json!({"profile": "coated-cmyk"})), Ok(()));
        // Nor is importing or exporting, with or without a path.
        for id in [
            "swatches.import",
            "swatches.export",
            "layer.exportAs",
            "layer.quickExportAsPng",
            "pattern.export",
            "brush.presets.importAbr",
            "measurementLog.export",
        ] {
            assert!(blocked(id, &json!({})).is_err(), "{id}");
        }
        assert_eq!(blocked("layer.smartObjects.embedAllLinked", &json!({})), Ok(()));
        // Every `ai.*` command of the engine but Generative Fill is blocked, whatever is added later.
        for id in photocraft_engine::ai_cmds::COMMANDS {
            assert_eq!(blocked(id, &json!({})).is_ok(), *id == FILL, "{id}");
        }
    }

    #[test]
    fn the_blocked_list_keeps_other_files_other_documents_and_the_preset_libraries() {
        // Nor is what shows a file in the file manager, asks for one, reads the ones a data set
        // names, changes another document, forgets history, or changes a preset library beyond
        // adding to it.
        for id in [
            "layer.smartObjects.revealInFinder",
            "layer.videoLayers.newVideoLayerFromFile",
            "layer.videoLayers.replaceFootage",
            "image.variables.define",
            "image.variables.dataSets",
            "image.applyDataSet",
            "layer.copyToDocument",
            "history.deleteState",
            "history.deleteSnapshot",
            "history.options",
            "brush.presets.delete",
            "brush.presets.deleteGroup",
            "brush.presets.rename",
            "brush.presets.move",
            "brush.presets.update",
            "swatches.delete",
            "swatches.reset",
            "swatches.rename",
            "pattern.delete",
            "pattern.presets.edit",
            "gradient.presets.edit",
            "gradient.presets.reset",
            "style.presets.reset",
            "shape.presets.edit",
            "layer.layerStyle.contours.delete",
        ] {
            assert!(photocraft_engine::commands::find(id).is_some(), "{id} is a command");
            assert!(blocked(id, &json!({})).is_err(), "{id}");
        }
        for id in [
            "brush.presets.list",
            "brush.presets.save",
            "brush.presets.setCurrent",
            "swatches.list",
            "swatches.add",
            "swatches.use",
            "pattern.list",
            "gradient.presets.apply",
            "gradient.presets.new",
            "style.presets.apply",
            "shape.presets.place",
            "layer.layerStyle.contours.list",
            "history.newSnapshot",
            "variables.list",
            "edit.definePattern",
        ] {
            assert!(photocraft_engine::commands::find(id).is_some(), "{id} is a command");
            assert_eq!(blocked(id, &json!({})), Ok(()), "{id}");
        }
    }

    #[test]
    fn a_param_names_a_file_at_any_depth_unless_it_is_a_listed_choice_or_geometry() {
        // A file named deeper in the params, a list of files, a profile file without a folder.
        assert!(blocked("image.adjustments.levels", &json!({"options": {"file": "/tmp/x"}})).is_err());
        assert!(blocked("image.adjustments.levels", &json!({"list": [{"mapPath": "/tmp/x"}]})).is_err());
        assert!(blocked("shape.create", &json!({"path": ["/tmp/a.svg"]})).is_err());
        assert!(blocked("edit.assignProfile", &json!({"profile": "Press.ICC"})).is_err());
        assert!(blocked("layer.new.layer", &json!({"steps": 3})).is_err(), "a script's steps, whatever they hold");
        // A param that shares a file param's name and is none: one of the values the command
        // lists for it (not any other text, and not deeper down), or geometry.
        assert_eq!(blocked("edit.contentAwareFill", &json!({"output": "new"})), Ok(()));
        assert_eq!(blocked("select.refineEdge", &json!({"output": "layerMask"})), Ok(()));
        assert!(blocked("edit.contentAwareFill", &json!({"output": "new.png"})).is_err());
        assert!(blocked("edit.contentAwareFill", &json!({"fillEdits": [{"output": "new"}]})).is_err());
        assert!(blocked("image.adjustments.levels", &json!({"output": "new"})).is_err(), "not a value this command lists");
        assert_eq!(blocked("shape.create", &json!({"kind": "path", "path": {"subpaths": [{"knots": [[1, 2], [3, 4], [5, 6]]}]}})), Ok(()));
        assert_eq!(blocked("filter.blurGallery.pathBlur", &json!({"paths": [[[0, 0], [10, 10]]]})), Ok(()));
    }

    #[test]
    fn the_curated_commands_exist_and_the_kind_lists_come_from_the_registry() {
        for id in COMMON_COMMANDS {
            assert!(crate::menus::is_live(id), "{id} is not a command");
            assert!(!blocked_id(id), "{id} is blocked");
        }
        let text = instructions();
        assert!(text.starts_with("You are the assistant inside Pigment"));
        assert!(text.contains("brightnessContrast {\"brightness\":-150..150=0,\"contrast\":-50..100=0,\"legacy\":bool=false}"), "{text}");
        assert!(text.contains("blur.gaussianBlur {\"radius\":0.1..1000=1}"));
        assert!(text.contains("invert;") && text.contains("cameraRaw {…}"));
        assert!(text.contains("hueSaturation {\"hue\":-180..180=0,") && text.contains("selectiveColor {\"method\":"), "every adjustment is spelt out");
        assert!(text.contains("Blend modes: Normal, Dissolve, Darken, Multiply"));
        assert!(!text.contains("lastFilter") && !text.contains("blackWhite.auto"));
        assert!(text.chars().count() < 24_000, "the instructions stay a few thousand tokens: {}", text.chars().count());
        // Fifteen tools: JavaScript Pigment's fourteen and list_commands.
        let names: Vec<String> = tools().into_iter().map(|t| t.name).collect();
        assert_eq!(
            names,
            [
                "get_document",
                "set_active_layer",
                "apply_adjustment",
                "apply_filter",
                "list_commands",
                "run_command",
                "new_layer",
                "set_layer_props",
                "select",
                "crop",
                "resize_image",
                "canvas_size",
                "fill_selection",
                "add_text",
                "generative_fill"
            ]
        );
    }

    #[test]
    fn kinds_are_found_however_they_are_spelt() {
        let id = |prefix, kind| find_kind(prefix, kind).map(|c| c.id);
        assert_eq!(id(ADJUSTMENTS, "brightnessContrast"), Some("image.adjustments.brightnessContrast"));
        assert_eq!(id(ADJUSTMENTS, "brightness-contrast"), Some("image.adjustments.brightnessContrast"));
        assert_eq!(id(ADJUSTMENTS, "Hue/Saturation"), Some("image.adjustments.hueSaturation"));
        assert_eq!(id(ADJUSTMENTS, "image.adjustments.levels"), Some("image.adjustments.levels"));
        assert_eq!(id(ADJUSTMENTS, "blackWhite.auto"), None);
        assert_eq!(id(FILTERS, "blur.gaussianBlur"), Some("filter.blur.gaussianBlur"));
        assert_eq!(id(FILTERS, "gaussian-blur"), Some("filter.blur.gaussianBlur"));
        assert_eq!(id(FILTERS, "Gaussian Blur"), Some("filter.blur.gaussianBlur"));
        assert_eq!(id(FILTERS, "filter.sharpen.unsharpMask"), Some("filter.sharpen.unsharpMask"));
        assert_eq!(id(FILTERS, "lastFilter"), None);
        assert_eq!(id(FILTERS, "no-such-filter"), None);
        assert_eq!(id(FILTERS, ""), None);
    }

    #[test]
    fn arguments_are_parsed_clamped_and_cut() {
        // Objects as JSON text (Gemini), unreadable text, arrays.
        assert_eq!(object_arg(Some(&json!("{\"radius\": 4}")), "params").unwrap().get("radius"), Some(&json!(4)));
        assert!(object_arg(None, "params").unwrap().is_empty());
        assert!(object_arg(Some(&json!("  ")), "params").unwrap().is_empty());
        let e = object_arg(Some(&json!("{radius: 4")), "params").unwrap_err();
        assert!(e.starts_with("params must be a JSON object such as {\"radius\": 4}; could not read: {radius: 4"), "{e}");
        assert_eq!(object_arg(Some(&json!([1, 2])), "params").unwrap_err(), "params must be an object");
        // run_command's params: JSON scalars are decoded, plain text stays text.
        assert_eq!(value_arg(Some(&json!("{\"a\":1}"))).unwrap(), json!({"a": 1}));
        assert_eq!(value_arg(Some(&json!("12"))).unwrap(), json!(12));
        assert_eq!(value_arg(Some(&json!("true"))).unwrap(), json!(true));
        assert_eq!(value_arg(Some(&json!("hello"))).unwrap(), json!("hello"));
        assert!(value_arg(Some(&json!("{\"a\":"))).unwrap_err().contains("looks like JSON"));
        assert_eq!(value_arg(None).unwrap(), Value::Null);
        // Numbers are clamped to the command's own ranges, numeric text is converted where the key
        // takes a number, NaN and null are dropped, strings cut, nesting bounded.
        let spec = r##"{"radius":0.1..1000=1,"amount":1..500=50,"seed":u32=0,"mode":"a|b"} (notes, "radius":5..6)"##;
        let p = json!({"radius": 99999, "amount": "-3", "seed": "7", "mode": "x".repeat(500), "extra": null, "deep": {"a": {"b": {"c": {"d": {"e": 1}}}}}, "radii": {"radius": -4}});
        let s = sanitize_params(p.as_object().unwrap(), spec, 200);
        assert_eq!(s["radius"], json!(1000));
        assert_eq!(s["amount"], json!(1));
        assert_eq!(s["seed"], json!(7));
        assert_eq!(s["mode"].as_str().unwrap().len(), 200);
        assert!(s.get("extra").is_none());
        assert_eq!(s["radii"]["radius"], json!(0.1));
        assert_eq!(s["deep"]["a"]["b"]["c"], json!({}), "nesting stops at depth 4");
        // Rectangles are cut to the canvas; an empty intersection is an error, not a 1 px crop.
        assert_eq!(rect_arg(Some(&json!({"x": -10, "y": 5.4, "width": 50, "height": 500})), 200, 160), Ok([0, 5, 40, 155]));
        assert_eq!(rect_arg(Some(&json!("{\"x\":0,\"y\":0,\"width\":10,\"height\":10}")), 200, 160), Ok([0, 0, 10, 10]));
        assert_eq!(rect_arg(Some(&json!({"x": 300, "y": 0, "width": 10, "height": 10})), 200, 160).unwrap_err(), "rect lies outside the canvas (200 × 160)");
        assert_eq!(rect_arg(Some(&json!({"x": 0, "y": 0, "width": 0, "height": 10})), 200, 160).unwrap_err(), "rect.width and rect.height must be positive");
        assert_eq!(rect_arg(Some(&json!({"x": "a", "y": 0, "width": 1, "height": 1})), 200, 160).unwrap_err(), "rect.x must be a number");
        assert_eq!(rect_arg(Some(&json!(5)), 200, 160).unwrap_err(), "rect must be { x, y, width, height }");
    }

    #[test]
    fn colours_are_hex_rgb_or_css_names() {
        assert_eq!(color_arg(Some(&json!("#ff8800"))), Ok(("#ff8800".into(), 1.0)));
        assert_eq!(color_arg(Some(&json!("#F80"))), Ok(("#ff8800".into(), 1.0)));
        assert_eq!(color_arg(Some(&json!("#ff880080"))).map(|(h, a)| (h, (a * 100.0).round())), Ok(("#ff8800".into(), 50.0)));
        assert_eq!(color_arg(Some(&json!("rgb(255, 136, 0)"))), Ok(("#ff8800".into(), 1.0)));
        assert_eq!(color_arg(Some(&json!("rgba(0,0,255,0.5)"))), Ok(("#0000ff".into(), 0.5)));
        assert_eq!(color_arg(Some(&json!("rgb(100% 0% 0% / 25%)"))), Ok(("#ff0000".into(), 0.25)));
        assert_eq!(color_arg(Some(&json!("RebeccaPurple"))), Ok(("#663399".into(), 1.0)));
        assert_eq!(color_arg(Some(&json!("cornflower blue"))), Ok(("#6495ed".into(), 1.0)));
        assert_eq!(color_arg(Some(&json!("transparent"))), Ok(("#000000".into(), 0.0)));
        assert_eq!(color_arg(Some(&json!("blurple"))).unwrap_err(), "Unknown colour \"blurple\"");
        assert_eq!(color_arg(Some(&json!("#12"))).unwrap_err(), "Unknown colour \"#12\"");
        assert!(color_arg(None).is_err());
        // The table is the CSS one: 148 names, sorted, no duplicates.
        assert_eq!(CSS_COLORS.len(), 148);
        assert!(CSS_COLORS.windows(2).all(|w| w[0].0 < w[1].0));
    }

    #[test]
    fn results_are_capped_and_dialog_answers_explained() {
        assert_eq!(capped(json!("ok")), json!("ok"));
        let long = capped(json!("x".repeat(RESULT_LIMIT + 5)));
        assert_eq!(long["truncated"], true);
        assert_eq!(long["text"].as_str().unwrap().len(), RESULT_LIMIT);
        assert_eq!(dialog_result(Value::Null), json!(DIALOG_CLOSED));
        assert_eq!(dialog_result(json!({"dialog": 3})), json!(DIALOG_CLOSED));
        assert_eq!(dialog_result(json!({"layer": 3})), json!({"layer": 3}));
        assert_eq!(plain_result(Value::Null), json!("ok"));
    }
}
