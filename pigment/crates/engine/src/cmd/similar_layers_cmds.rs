//! Pigment: Select › Similar Layers (PORTS-A row 45).
//!
//! Photoshop's Select › Similar Layers selects every layer of the same kind as the selected
//! one(s): pixel, type, shape, adjustment, fill, smart object or group. Adjustment layers of any
//! kind match each other, as do fill layers of any kind ([`LayerContent::kind_name`] already
//! groups them so). The JavaScript Pigment had it as `layer:select-similar`
//! (`renderer/lib/layer-dialogs.js` `selectSimilar`).
//!
//! Like the other layer-selection commands it changes the selection only: no history step.

use photocraft_doc::{LayerContent, LayerId};
use serde_json::{Value, json};

use crate::commands::CommandSpec;
use crate::layer_multi_cmds::{selected, set_selection};
use crate::{EngineError, Result, Session};

pub const ID: &str = "select.similarLayers";

fn has_layer(s: &Session) -> std::result::Result<(), String> {
    if selected(s).is_empty() { Err("no layer selected".into()) } else { Ok(()) }
}

pub fn specs() -> Vec<CommandSpec> {
    vec![CommandSpec {
        id: ID,
        label: "Similar Layers",
        menu: &["Select"],
        shortcut: None,
        params: r##"{} (selects every layer, inside groups too, of the kinds of the selected layers: pixel, type, shape, adjustment (any), fill (any), smart object, group; the Background only when it is selected; keeps the active layer; replies with the number selected)"##,
        enabled: has_layer,
        journal: true,
        run: |s, _| similar_layers(s),
    }]
}

/// The kinds Similar Layers compares: [`LayerContent::kind_name`].
fn kind(content: &LayerContent) -> &'static str {
    content.kind_name()
}

pub fn similar_layers(s: &mut Session) -> Result<Value> {
    let d = s.active().ok_or(EngineError::NoDocument)?;
    let sel = d.selected_layers();
    if sel.is_empty() {
        return Err(EngineError::Other("no layer selected".into()));
    }
    let kinds: Vec<&'static str> = sel.iter().filter_map(|id| d.doc.layer(*id)).map(|l| kind(&l.content)).collect();
    // As Select › All Layers, the Background joins only when it was selected already.
    let ids: Vec<LayerId> = d
        .doc
        .walk()
        .into_iter()
        .filter(|(_, _, l)| kinds.contains(&kind(&l.content)) && (!d.doc.is_background(l.id) || sel.contains(&l.id)))
        .map(|(_, _, l)| l.id)
        .collect();
    let active = d.active_layer.filter(|a| ids.contains(a)).or(ids.last().copied());
    let n = ids.len();
    set_selection(s, ids, active, None)?;
    Ok(json!({"selected": n}))
}

#[cfg(test)]
mod tests;
