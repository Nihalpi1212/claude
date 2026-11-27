//! The Adjustments panel's adjustment presets (Pigment): `layer.adjustmentPreset` adds a preset's
//! layers, `layer.saveAdjustmentPreset` saves the selected adjustment layers as one of "Your
//! Presets" (the model is [`crate::presets::adjustments::panel`]).

use photocraft_doc::{Adjustment, Layer, LayerContent, LayerId, MAX_GROUP_DEPTH};
use serde_json::{Value, json};

use crate::commands::CommandSpec;
use crate::presets::adjustments::panel::{self, MAX_LAYERS, PANEL_KIND, PresetLayer};
use crate::presets::adjustments::{self, MAX_PARAMS_BYTES};
use crate::presets::{always, bad, req_str};
use crate::{EngineError, Result, Session};

/// The adjustment of one preset layer in a document of `mode` (Levels and Curves channels
/// follow the mode, [`panel::for_mode`]).
fn adjustment_of(layer: &PresetLayer, mode: photocraft_color::ColorMode, cmd: &str) -> Result<Adjustment> {
    if layer.kind == "unsupported" || crate::commands::find(&format!("layer.newAdjustmentLayer.{}", layer.kind)).is_none() {
        return Err(bad(cmd, format!("unknown adjustment kind `{}`", layer.kind)));
    }
    crate::adjust_params::from_params(&layer.kind, &panel::for_mode(&layer.kind, &layer.params, mode), None, mode)
        .map_err(|e| bad(cmd, format!("{}: {e}", layer.kind)))
}

/// `base 1`, `base 2`… the first name neither the document nor `made` has.
fn layer_name(doc: &photocraft_doc::Document, made: &[Layer], base: &str) -> String {
    let taken = |n: &str| made.iter().any(|l| l.name == n);
    let first = doc.next_layer_name(base);
    if !taken(&first) {
        return first;
    }
    (1..).map(|n| format!("{base} {n}")).find(|n| !taken(n) && doc.walk().iter().all(|(_, _, l)| l.name != *n)).unwrap_or(first)
}

/// The adjustments a preset adds in a document of `mode`, bottom first, with the names the user
/// gave them, and the preset's name.
type Made = (String, Vec<(Adjustment, Option<String>)>);

fn preset_adjustments(presets: &adjustments::AdjustmentPresets, group: &str, preset: &str, mode: photocraft_color::ColorMode, cmd: &str) -> Result<Made> {
    let (name, layers) = panel::find(presets, group, preset).ok_or_else(|| bad(cmd, format!("no adjustment preset \"{group}/{preset}\"")))?;
    if layers.is_empty() {
        return Err(bad(cmd, format!("the adjustment preset \"{name}\" has no layers")));
    }
    let made = layers.iter().map(|l| Ok((adjustment_of(l, mode, cmd)?, l.name.clone()))).collect::<Result<_>>()?;
    Ok((name, made))
}

/// Adds the preset's layers to `doc` above `active`, as `layer.adjustmentPreset` does: each one
/// masked by the selection (which the last drops), else by a mask that shows everything, and in a
/// group named after the preset when there are several. Returns the new top layer and the
/// adjustment layers, bottom first; `active` becomes the top layer.
fn insert_layers(doc: &mut photocraft_doc::Document, active: &mut Option<LayerId>, (name, made): Made, cmd: &str) -> Result<(LayerId, Vec<LayerId>)> {
    let mut built: Vec<Layer> = Vec::new();
    let selection = doc.selection.clone();
    for (adj, given) in made {
        doc.selection.clone_from(&selection);
        let layer_name = given.unwrap_or_else(|| layer_name(doc, &built, adj.label()));
        let mut l = Layer::new(layer_name, LayerContent::Adjustment(adj));
        crate::cmd::layer_params::mask_new_layer(doc, &mut l, &json!({}), cmd, true)?;
        built.push(l);
    }
    let ids: Vec<LayerId> = built.iter().map(|l| l.id).collect();
    let layer = if built.len() == 1 { built.remove(0) } else { Layer::group(name, built) };
    let top = crate::layer_place::insert_new(doc, *active, layer, crate::layer_place::Place::Auto);
    crate::clip_group::settle(doc, &[top], &Default::default(), false);
    if doc.max_group_depth() > MAX_GROUP_DEPTH {
        return Err(EngineError::Other(format!("groups can be nested at most {MAX_GROUP_DEPTH} deep")));
    }
    *active = Some(top);
    Ok((top, ids))
}

/// `doc` as it would look with the preset `preset` of `group` added above `active`: the
/// Adjustments panel's hover preview, built as the command builds the layers. `None` when the
/// preset is unknown or can't be added.
pub fn preview(
    doc: &photocraft_doc::Document,
    active: Option<LayerId>,
    presets: &adjustments::AdjustmentPresets,
    group: &str,
    preset: &str,
) -> Option<photocraft_doc::Document> {
    let made = preset_adjustments(presets, group, preset, doc.mode, "layer.adjustmentPreset").ok()?;
    let (mut shown, mut active) = (doc.clone(), active);
    insert_layers(&mut shown, &mut active, made, "layer.adjustmentPreset").ok()?;
    Some(shown)
}

fn add_preset(s: &mut Session, p: &Value) -> Result<Value> {
    let cmd = "layer.adjustmentPreset";
    let group = req_str(p, "group", cmd)?;
    let preset = req_str(p, "preset", cmd)?;
    let made = preset_adjustments(&s.presets.adjustments, group, preset, crate::cmd::adjust_params::doc_mode(s), cmd)?;
    let name = made.0.clone();
    let (top, ids) = s.edit(&format!("Adjustment Preset: {name}"), |doc, active| insert_layers(doc, active, made, cmd))?;
    Ok(json!({"layer": top.0, "layers": ids.iter().map(|id| id.0).collect::<Vec<_>>(), "name": name}))
}

fn save_preset(s: &mut Session, p: &Value) -> Result<Value> {
    let cmd = "layer.saveAdjustmentPreset";
    let raw = p.get("name").and_then(Value::as_str).ok_or_else(|| bad(cmd, "missing `name`"))?;
    let name = adjustments::clean_name(raw).ok_or_else(|| bad(cmd, format!("`name` must be 1..{} characters", adjustments::MAX_NAME_CHARS)))?;
    let st = s.active().ok_or(EngineError::NoDocument)?;
    let given: Option<Vec<LayerId>> = match p.get("layers") {
        None | Some(Value::Null) => None,
        Some(Value::Array(a)) => Some(a.iter().map(|v| v.as_u64().map(LayerId).ok_or_else(|| bad(cmd, "`layers` must be layer ids"))).collect::<Result<_>>()?),
        Some(_) => return Err(bad(cmd, "`layers` must be a list of layer ids")),
    };
    // Bottom to top, in document order.
    let order: Vec<LayerId> = st.doc.walk().iter().map(|(_, _, l)| l.id).collect();
    let ids: Vec<LayerId> = match &given {
        Some(ids) => {
            if let Some(missing) = ids.iter().find(|id| !order.contains(id)) {
                return Err(bad(cmd, format!("no layer {}", missing.0)));
            }
            order.iter().copied().filter(|id| ids.contains(id)).collect()
        }
        None => st.selected_layers(),
    };
    let mut layers = Vec::new();
    for id in ids {
        let Some(l) = st.doc.layer(id) else { continue };
        match &l.content {
            LayerContent::Adjustment(adj) if !matches!(adj, Adjustment::Unsupported { .. }) => layers.push(PresetLayer {
                kind: crate::commands::adjustment_kind(adj).to_string(),
                params: layer_params(adj),
                name: adjustments::clean_name(&l.name),
            }),
            // Named layers must all be adjustment layers; a selection keeps the ones that are.
            _ if given.is_some() => return Err(bad(cmd, format!("layer {} is not an adjustment layer this app can edit", id.0))),
            _ => {}
        }
    }
    if layers.is_empty() {
        return Err(bad(cmd, "select one or more adjustment layers"));
    }
    if layers.len() > MAX_LAYERS {
        return Err(bad(cmd, format!("a preset holds at most {MAX_LAYERS} layers")));
    }
    let params = panel::saved_params(&layers);
    if serde_json::to_vec(&params).map_or(usize::MAX, |b| b.len()) > MAX_PARAMS_BYTES {
        return Err(bad(cmd, "the layers' settings are too large for a preset"));
    }
    let count = layers.len();
    let replaced = s.presets.adjustments.save(PANEL_KIND, &name, params, None).map_err(|e| bad(cmd, e))?;
    s.presets_changed();
    Ok(json!({"name": name, "layers": count, "replaced": replaced}))
}

/// The params that rebuild `adj` as a preset layer. Upstream's `to_params` keeps only a Color Lookup's interpolation
/// and dither, so a preset of it would come back with no look: its table goes in too, as the file it was loaded from or
/// the built-in look's id.
fn layer_params(adj: &Adjustment) -> Value {
    let mut v = crate::adjust_params::to_params(adj);
    if let Adjustment::ColorLookup { name, lut: Some(_), source, .. } = adj {
        if let Some(src) = source {
            let format = match src.format {
                photocraft_doc::adjust::LutFormat::Cube => "cube",
                photocraft_doc::adjust::LutFormat::ThreeDl => "3dl",
                photocraft_doc::adjust::LutFormat::Look => "look",
            };
            v["data"] = json!(photocraft_paint::tile::b64_encode(&src.bytes));
            v["dataEncoding"] = json!("base64");
            v["lutFormat"] = json!(format);
            v["fileName"] = json!(name);
        } else if let Some((id, _)) = crate::adjust_cmds::LOOKS.iter().find(|(id, _)| craft_cms::lutfile::builtin(id).is_some_and(|f| f.title == *name)) {
            v["lut"] = json!(id);
        }
    }
    v
}

fn delete_preset(s: &mut Session, p: &Value) -> Result<Value> {
    let cmd = "layer.deleteAdjustmentPreset";
    let name = req_str(p, "name", cmd)?.to_string();
    let deleted = s.presets.adjustments.delete(PANEL_KIND, &[name]).map_err(|e| bad(cmd, e))?;
    s.presets_changed();
    Ok(json!({"deleted": deleted}))
}

fn has_doc(s: &Session) -> std::result::Result<(), String> {
    s.active().map(|_| ()).ok_or_else(|| "no document open".into())
}

/// The panel presets' commands.
pub fn specs() -> Vec<CommandSpec> {
    vec![
        CommandSpec {
            id: "layer.adjustmentPreset",
            label: "Adjustment Preset",
            menu: &[],
            shortcut: None,
            params: r##"{"group":"portraits|landscape|photo-repair|creative|black-white|cinematic|yours","preset":str (the preset's id; for "yours", its name)} → {layer (the new layer, or the group holding several), layers:[ids, bottom first], name} (the Adjustments panel's presets: adds their adjustment layers above the active layer in one step, grouped and named after the preset when there are several)"##,
            enabled: has_doc,
            run: add_preset,
            journal: true,
        },
        CommandSpec {
            id: "layer.saveAdjustmentPreset",
            label: "Save Adjustment Preset…",
            menu: &[],
            shortcut: None,
            params: r##"{"name":str (1..255 characters; a taken name is replaced),"layers":[layer ids]? (default: the selected layers; those that are adjustment layers are kept)} → {name, layers, replaced} (one of the Adjustments panel's "Your Presets")"##,
            enabled: has_doc,
            run: save_preset,
            journal: false,
        },
        CommandSpec {
            id: "layer.deleteAdjustmentPreset",
            label: "Delete Adjustment Preset",
            menu: &[],
            shortcut: None,
            params: r##"{"name":str (one of the Adjustments panel's "Your Presets")} → {deleted}"##,
            enabled: always,
            run: delete_preset,
            journal: false,
        },
    ]
}

#[cfg(test)]
#[path = "panel_tests.rs"]
mod tests;
