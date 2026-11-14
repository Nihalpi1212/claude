//! Generative Recolor: the model proposes palettes as strict JSON; each is a variation, applied
//! through Recolor Artwork (`recolor.apply`) with the artwork's colour rows (`recolor.reduce`)
//! mapped to the palette's colours by lightness.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use vectorcraft_engine::Session;

use super::{Applied, Feature, Inputs, Prepared, exec};
use crate::palette::{Palette, assign_by_lightness, parse_hex, parse_palettes};
use crate::provider::TextRequest;
use crate::{AiError, CancelToken, Provider, Result};

/// Most colour rows recoloured (palettes are asked with this many colours at most).
pub const MAX_ROWS: usize = 8;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RecolorSpec {
    pub prompt: String,
    /// Sample prompts the person picked ("sunset", "pastel"…), added to the prompt.
    pub samples: Vec<String>,
    /// 1–4 palettes.
    pub variations: u8,
}

/// One row of the artwork's colours: the colour keys it holds and its main colour.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Row {
    pub from: Vec<String>,
    pub hex: String,
}

#[derive(Clone, Debug)]
pub(crate) struct RecolorJob {
    request: TextRequest,
    variations: usize,
    rows: Vec<Row>,
    ids: Vec<u64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RecolorResult {
    pub doc_uid: u64,
    pub palettes: Vec<Palette>,
    /// The artwork's colour rows when the job started.
    pub rows: Vec<Row>,
    /// The objects recoloured.
    pub ids: Vec<u64>,
}

pub(crate) fn prepare(s: &mut Session, spec: &RecolorSpec) -> Result<Prepared> {
    if spec.prompt.trim().is_empty() && spec.samples.iter().all(|x| x.trim().is_empty()) {
        return Err(AiError::bad_request("Describe the colours, or pick a sample prompt."));
    }
    let ids: Vec<u64> = super::selection(s)?.iter().map(|n| n.0).collect();
    if ids.is_empty() {
        return Err(AiError::document("Select the artwork to recolor."));
    }
    let colors = super::vector::colors_of(s, Some(&ids))?;
    if colors.is_empty() {
        return Err(AiError::document("The selected artwork has no colours to recolor."));
    }
    let k = colors.len().min(MAX_ROWS);
    let reduced = exec(s, "recolor.reduce", json!({ "colors": k, "ids": ids }))?;
    let rows = rows_of(&reduced, s, &ids)?;
    if rows.is_empty() {
        return Err(AiError::document("The selected artwork has no colours to recolor."));
    }
    let current: Vec<String> = rows.iter().map(|r| r.hex.clone()).collect();
    let variations = super::clamp_variations(spec.variations);
    let request = TextRequest {
        instructions: crate::prompts::PALETTE_INSTRUCTIONS.into(),
        prompt: crate::prompts::palette_prompt(&spec.prompt, &spec.samples, &current, rows.len(), variations),
        images: vec![],
        json: true,
        max_output_tokens: Some(4_000),
    };
    Ok(Prepared { feature: Feature::Recolor, doc_uid: super::active_uid(s)?, inputs: Inputs::Recolor(RecolorJob { request, variations, rows, ids }) })
}

/// The rows of a `recolor.reduce` answer, each with the hex of its first colour.
fn rows_of(reduced: &Value, s: &mut Session, ids: &[u64]) -> Result<Vec<Row>> {
    let listed = exec(s, "recolor.colors", json!({ "ids": ids }))?;
    let hex_of = |key: &str| -> Option<String> {
        listed.get("colors")?.as_array()?.iter().find(|c| c.get("key").and_then(Value::as_str) == Some(key))?.get("hex")?.as_str().map(str::to_string)
    };
    let mut rows = vec![];
    for r in reduced.get("map").and_then(Value::as_array).into_iter().flatten() {
        let from: Vec<String> = r.get("from").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
        let Some(hex) = from.first().and_then(|k| hex_of(k).or_else(|| parse_hex(k).map(crate::palette::to_hex))) else { continue };
        rows.push(Row { from, hex });
    }
    Ok(rows)
}

pub(crate) fn run(p: &Prepared, job: &RecolorJob, provider: &dyn Provider, cancel: &CancelToken) -> Result<RecolorResult> {
    let text = provider.generate_text(&job.request, cancel)?;
    let mut palettes = parse_palettes(&text)?;
    palettes.truncate(job.variations.max(1));
    Ok(RecolorResult { doc_uid: p.doc_uid, palettes, rows: job.rows.clone(), ids: job.ids.clone() })
}

/// The `recolor.apply` parameters of palette `i` (also for a live preview through
/// `Session::preview`).
pub fn recolor_params(r: &RecolorResult, i: usize) -> Option<Value> {
    let palette = r.palettes.get(i)?;
    let from: Vec<[u8; 3]> = r.rows.iter().map(|row| parse_hex(&row.hex).unwrap_or_default()).collect();
    let colors: Vec<[u8; 3]> = palette.colors.iter().filter_map(|c| parse_hex(c)).collect();
    let map: Vec<Value> = assign_by_lightness(&from, &colors)
        .into_iter()
        .filter_map(|(row, c)| r.rows.get(row).map(|row| json!({ "from": row.from, "to": crate::palette::to_hex(c) })))
        .collect();
    (!map.is_empty()).then(|| json!({ "map": map, "method": "preserveTints" }))
}

pub(crate) fn apply(s: &mut Session, r: &RecolorResult, i: usize) -> Result<Applied> {
    let params = recolor_params(r, i).ok_or_else(|| AiError::bad_request("The palette has no colours."))?;
    let live: Vec<u64> = r.ids.iter().copied().filter(|id| super::node_bounds(s, vectorcraft_doc::NodeId(*id)).is_some()).collect();
    if live.is_empty() {
        return Err(AiError::document("The artwork to recolor is gone."));
    }
    exec(s, "select.set", json!({ "ids": live }))?;
    exec(s, "recolor.apply", params)?;
    Ok(Applied { ids: live, swatch: None })
}
