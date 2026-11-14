//! Rewrite Text: the selected type object's text rewritten in a tone. With several styled runs,
//! the model is asked for the same number of segments, each keeping its run's style; when it
//! answers with another count, the text takes the first run's style.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use vectorcraft_doc::NodeKind;
use vectorcraft_engine::Session;

use super::{Applied, Feature, Inputs, Prepared, exec};
use crate::palette::extract_json;
use crate::prompts::Tone;
use crate::provider::TextRequest;
use crate::{AiError, CancelToken, Provider, Result};

/// Longest text rewritten (characters).
pub const MAX_TEXT: usize = 20_000;
/// Most styled runs kept apart; more are rewritten as one.
pub const MAX_SEGMENTS: usize = 64;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RewriteSpec {
    pub tone: Tone,
    /// 1–4.
    pub variations: u8,
}

#[derive(Clone, Debug)]
pub(crate) struct RewriteJob {
    id: u64,
    original: String,
    /// The runs' texts and styles (`text.getRange`).
    runs: Vec<(String, Value)>,
    request: TextRequest,
    variations: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RewriteResult {
    pub doc_uid: u64,
    /// The type object.
    pub id: u64,
    /// Its text when the job started (a text changed since isn't overwritten).
    pub original: String,
    /// Per variation: the new runs, each a text and its style.
    pub variations: Vec<Vec<(String, Value)>>,
}

pub(crate) fn prepare(s: &mut Session, spec: &RewriteSpec) -> Result<Prepared> {
    if let Tone::Custom(t) = &spec.tone
        && t.trim().is_empty()
    {
        return Err(AiError::bad_request("Say how to rewrite the text."));
    }
    let ids = super::selection(s)?;
    let [id] = ids.as_slice() else {
        return Err(AiError::document("Select one type object to rewrite."));
    };
    if !matches!(super::kind_of(s, *id), Some(NodeKind::Text(_))) {
        return Err(AiError::document("Select one type object to rewrite."));
    }
    let got = exec(s, "text.getRange", json!({ "id": id.0 }))?;
    let original = got.get("text").and_then(Value::as_str).unwrap_or_default().to_string();
    if original.trim().is_empty() {
        return Err(AiError::document("The selected type object has no text."));
    }
    if original.chars().count() > MAX_TEXT {
        return Err(AiError::document(format!("The text is too long to rewrite (over {MAX_TEXT} characters).")));
    }
    let runs: Vec<(String, Value)> = got
        .get("runs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|r| (r.get("text").and_then(Value::as_str).unwrap_or_default().to_string(), r.get("style").cloned().unwrap_or(Value::Null)))
        .filter(|(t, _)| !t.is_empty())
        .collect();
    let segments: Vec<String> =
        if runs.len() > 1 && runs.len() <= MAX_SEGMENTS { runs.iter().map(|(t, _)| t.clone()).collect() } else { vec![original.clone()] };
    let request = TextRequest {
        instructions: crate::prompts::REWRITE_INSTRUCTIONS.into(),
        prompt: crate::prompts::rewrite_prompt(&spec.tone, &segments),
        images: vec![],
        json: true,
        max_output_tokens: Some(8_000),
    };
    let job = RewriteJob { id: id.0, original, runs, request, variations: super::clamp_variations(spec.variations) };
    Ok(Prepared { feature: Feature::Rewrite, doc_uid: super::active_uid(s)?, inputs: Inputs::Rewrite(job) })
}

/// The rewritten runs in a model's answer.
pub fn parse_rewrite(text: &str, runs: &[(String, Value)]) -> Result<Vec<(String, Value)>> {
    let json = extract_json(text).ok_or_else(|| AiError::bad_response("The model's answer has no JSON in it."))?;
    let v: Value = serde_json::from_str(json).map_err(|_| AiError::bad_response("The model's JSON is not valid."))?;
    let first_style = runs.first().map(|(_, s)| s.clone()).unwrap_or(Value::Null);
    let segments: Option<Vec<String>> =
        v.get("segments").and_then(Value::as_array).map(|a| a.iter().map(|x| x.as_str().unwrap_or_default().to_string()).collect());
    let out = match segments {
        Some(seg) if seg.len() == runs.len() && runs.len() > 1 => {
            seg.into_iter().zip(runs).map(|(t, (_, style))| (t, style.clone())).filter(|(t, _)| !t.is_empty()).collect()
        }
        Some(seg) => vec![(seg.concat(), first_style)],
        None => {
            let t = v.get("text").and_then(Value::as_str).ok_or_else(|| AiError::bad_response("The model's JSON has no rewritten text."))?;
            vec![(t.to_string(), first_style)]
        }
    };
    let total: String = out.iter().map(|(t, _): &(String, Value)| t.as_str()).collect();
    if total.trim().is_empty() {
        return Err(AiError::bad_response("The model returned empty text."));
    }
    if total.chars().count() > MAX_TEXT * 4 {
        return Err(AiError::bad_response("The model's text is far too long."));
    }
    Ok(out)
}

pub(crate) fn run(p: &Prepared, job: &RewriteJob, provider: &dyn Provider, cancel: &CancelToken) -> Result<RewriteResult> {
    let mut variations = vec![];
    for _ in 0..job.variations {
        cancel.check()?;
        let text = provider.generate_text(&job.request, cancel)?;
        let runs = parse_rewrite(&text, &job.runs)?;
        if !variations.contains(&runs) {
            variations.push(runs);
        }
    }
    Ok(RewriteResult { doc_uid: p.doc_uid, id: job.id, original: job.original.clone(), variations })
}

pub(crate) fn apply(s: &mut Session, r: &RewriteResult, i: usize) -> Result<Applied> {
    let runs = r.variations.get(i).ok_or_else(|| AiError::bad_request("No such variation."))?;
    let now = exec(s, "text.getRange", json!({ "id": r.id })).map_err(|_| AiError::document("The type object to rewrite is gone."))?;
    if now.get("text").and_then(Value::as_str) != Some(r.original.as_str()) {
        return Err(AiError::document("The text changed while it was being rewritten. Run Rewrite Text again."));
    }
    let runs: Vec<Value> = runs.iter().map(|(t, style)| json!({ "text": t, "style": style })).collect();
    exec(s, "text.editRange", json!({ "id": r.id, "start": 0, "end": r.original.len(), "runs": runs }))?;
    exec(s, "select.set", json!({ "ids": [r.id] }))?;
    Ok(Applied { ids: vec![r.id], swatch: None })
}
