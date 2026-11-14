//! The six features, each in three steps:
//!
//! 1. **prepare** (UI thread, `&mut Session`): read what the feature works on (the selection, its
//!    bounds and colours, an image's pixels, a text's styled runs) into a [`Prepared`] that owns its
//!    data. Nothing in the document changes.
//! 2. **run** ([`run`], a worker thread, no `Session`): build the requests, call the provider,
//!    check and sanitize the answers into a [`Generated`] holding 1–4 variations.
//! 3. **apply** ([`apply`], UI thread): place one variation as **one undo step**, made of the
//!    engine's ordinary commands (`clipboard.importSvg` + `edit.pasteInPlace`, `imageTrace.makeAndExpand`,
//!    `object.transform`, `node.move`, `object.clippingMask.make`, `object.pattern.make`,
//!    `recolor.apply`, `text.editRange`…), so it is journaled like any other edit and Undo restores
//!    the document. A failure part-way rolls back what the step did.

pub mod expand;
pub mod recolor;
pub mod rewrite;
pub mod vector;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use vectorcraft_doc::{NodeId, NodeKind};
use vectorcraft_engine::Session;
use vectorcraft_geom::Rect;

use crate::{AiError, CancelToken, Provider, Result};

pub use expand::{ExpandResult, ExpandSpec};
pub use recolor::{RecolorResult, RecolorSpec};
pub use rewrite::{RewriteResult, RewriteSpec};
pub use vector::{PatternSpec, ShapeFillSpec, TextToVectorSpec, VectorArt, VectorMethod, VectorResult};

/// The generative features.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Feature {
    TextToVector,
    Recolor,
    ShapeFill,
    Pattern,
    Expand,
    Rewrite,
}

impl Feature {
    pub const ALL: [Feature; 6] = [Feature::TextToVector, Feature::Recolor, Feature::ShapeFill, Feature::Pattern, Feature::Expand, Feature::Rewrite];

    /// `textToVector`, `recolor`, …: the id in the control protocol, MCP and the journal.
    pub fn id(self) -> &'static str {
        match self {
            Feature::TextToVector => "textToVector",
            Feature::Recolor => "recolor",
            Feature::ShapeFill => "shapeFill",
            Feature::Pattern => "pattern",
            Feature::Expand => "expand",
            Feature::Rewrite => "rewrite",
        }
    }

    /// The menu label, which also names the undo step.
    pub fn label(self) -> &'static str {
        match self {
            Feature::TextToVector => "Text to Vector Graphic",
            Feature::Recolor => "Generative Recolor",
            Feature::ShapeFill => "Generative Shape Fill",
            Feature::Pattern => "Generative Pattern",
            Feature::Expand => "Generative Expand",
            Feature::Rewrite => "Rewrite Text",
        }
    }
}

/// A feature with its settings, as the UI's dialogs, the control protocol and MCP give it:
/// `{"feature": "textToVector", "prompt": …}`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "feature", rename_all = "camelCase")]
pub enum FeatureRequest {
    TextToVector(TextToVectorSpec),
    Recolor(RecolorSpec),
    ShapeFill(ShapeFillSpec),
    Pattern(PatternSpec),
    Expand(ExpandSpec),
    Rewrite(RewriteSpec),
}

impl FeatureRequest {
    pub fn feature(&self) -> Feature {
        match self {
            FeatureRequest::TextToVector(_) => Feature::TextToVector,
            FeatureRequest::Recolor(_) => Feature::Recolor,
            FeatureRequest::ShapeFill(_) => Feature::ShapeFill,
            FeatureRequest::Pattern(_) => Feature::Pattern,
            FeatureRequest::Expand(_) => Feature::Expand,
            FeatureRequest::Rewrite(_) => Feature::Rewrite,
        }
    }
}

/// What a feature works on, read from the document: owns its data, so it can go to a worker.
#[derive(Clone, Debug)]
pub struct Prepared {
    pub feature: Feature,
    /// The document it was read from ([`vectorcraft_engine::DocState::uid`]); results apply there.
    pub doc_uid: u64,
    pub(crate) inputs: Inputs,
}

#[derive(Clone, Debug)]
pub(crate) enum Inputs {
    Vector(vector::VectorJob),
    Recolor(recolor::RecolorJob),
    Expand(expand::ExpandJob),
    Rewrite(rewrite::RewriteJob),
}

/// What the provider made: 1–4 variations to choose from.
#[derive(Clone, Debug, PartialEq)]
pub enum Generated {
    Vector(VectorResult),
    Recolor(RecolorResult),
    Expand(ExpandResult),
    Rewrite(RewriteResult),
}

/// One variation as the UI previews it.
#[derive(Clone, Debug, PartialEq)]
pub enum Preview<'a> {
    /// Sanitized SVG.
    Svg(&'a str),
    /// PNG bytes (art to be traced, an expanded image).
    Png(&'a [u8]),
    /// A palette's name and `#rrggbb` colours.
    Palette(&'a str, &'a [String]),
    /// Rewritten text.
    Text(String),
}

impl Generated {
    pub fn feature(&self) -> Feature {
        match self {
            Generated::Vector(v) => v.feature,
            Generated::Recolor(_) => Feature::Recolor,
            Generated::Expand(_) => Feature::Expand,
            Generated::Rewrite(_) => Feature::Rewrite,
        }
    }

    pub fn doc_uid(&self) -> u64 {
        match self {
            Generated::Vector(v) => v.doc_uid,
            Generated::Recolor(r) => r.doc_uid,
            Generated::Expand(e) => e.doc_uid,
            Generated::Rewrite(r) => r.doc_uid,
        }
    }

    pub fn variations(&self) -> usize {
        match self {
            Generated::Vector(v) => v.art.len(),
            Generated::Recolor(r) => r.palettes.len(),
            Generated::Expand(_) => 1,
            Generated::Rewrite(r) => r.variations.len(),
        }
    }

    pub fn preview(&self, i: usize) -> Option<Preview<'_>> {
        match self {
            Generated::Vector(v) => v.art.get(i).map(|a| match a {
                VectorArt::Svg(s) => Preview::Svg(s),
                VectorArt::Image(p) => Preview::Png(p),
            }),
            Generated::Recolor(r) => r.palettes.get(i).map(|p| Preview::Palette(&p.name, &p.colors)),
            Generated::Expand(e) => (i == 0).then_some(Preview::Png(&e.png)),
            Generated::Rewrite(r) => r.variations.get(i).map(|v| Preview::Text(v.iter().map(|(t, _)| t.as_str()).collect())),
        }
    }

    /// `{feature, variations, previews: [...]}` for the control protocol and MCP (PNGs as their
    /// size only; palettes and text in full; SVG as its length).
    pub fn summary(&self) -> Value {
        let previews: Vec<Value> = (0..self.variations())
            .filter_map(|i| self.preview(i))
            .map(|p| match p {
                Preview::Svg(s) => json!({ "svgBytes": s.len() }),
                Preview::Png(b) => json!({ "pngBytes": b.len(), "size": crate::image_util::png_size(b).map(|(w, h)| [w, h]) }),
                Preview::Palette(name, colors) => json!({ "name": name, "colors": colors }),
                Preview::Text(t) => json!({ "text": t }),
            })
            .collect();
        json!({ "feature": self.feature().id(), "variations": self.variations(), "previews": previews })
    }
}

/// What applying a variation did.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    /// The objects made or changed (selected afterwards).
    pub ids: Vec<u64>,
    /// The pattern swatch made (Generative Pattern).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub swatch: Option<String>,
}

/// Read what `request` works on from the active document.
pub fn prepare(s: &mut Session, request: &FeatureRequest) -> Result<Prepared> {
    match request {
        FeatureRequest::TextToVector(spec) => vector::prepare_text_to_vector(s, spec),
        FeatureRequest::ShapeFill(spec) => vector::prepare_shape_fill(s, spec),
        FeatureRequest::Pattern(spec) => vector::prepare_pattern(s, spec),
        FeatureRequest::Recolor(spec) => recolor::prepare(s, spec),
        FeatureRequest::Expand(spec) => expand::prepare(s, spec),
        FeatureRequest::Rewrite(spec) => rewrite::prepare(s, spec),
    }
}

/// Ask the provider. Blocks: call it on a worker thread.
pub fn run(p: &Prepared, provider: &dyn Provider, cancel: &CancelToken) -> Result<Generated> {
    cancel.check()?;
    let g = match &p.inputs {
        Inputs::Vector(job) => Generated::Vector(vector::run(p, job, provider, cancel)?),
        Inputs::Recolor(job) => Generated::Recolor(recolor::run(p, job, provider, cancel)?),
        Inputs::Expand(job) => Generated::Expand(expand::run(p, job, provider, cancel)?),
        Inputs::Rewrite(job) => Generated::Rewrite(rewrite::run(p, job, provider, cancel)?),
    };
    cancel.check()?;
    Ok(g)
}

/// Place variation `i` of `g` in its document as one undo step named after the feature.
pub fn apply(s: &mut Session, g: &Generated, i: usize) -> Result<Applied> {
    if i >= g.variations() {
        return Err(AiError::bad_request(format!("There is no variation {} (there are {}).", i + 1, g.variations())));
    }
    if active_uid(s)? != g.doc_uid() {
        return Err(AiError::document("The result belongs to another document. Switch back to it to place the result."));
    }
    let label = g.feature().label();
    one_step(s, label, |s| match g {
        Generated::Vector(v) => vector::apply(s, v, i),
        Generated::Recolor(r) => recolor::apply(s, r, i),
        Generated::Expand(e) => expand::apply(s, e),
        Generated::Rewrite(r) => rewrite::apply(s, r, i),
    })
}

// ---------- session helpers ----------

/// Run `f` as one undo step named `label`; when it fails, its edits are rolled back.
pub(crate) fn one_step<T>(s: &mut Session, label: &str, f: impl FnOnce(&mut Session) -> Result<T>) -> Result<T> {
    let fresh = s.active().is_some_and(|st| st.undo_group.is_none());
    if fresh {
        s.begin_named_undo_group(Some(label.to_string()));
        let r = f(s);
        s.end_undo_group(r.is_err());
        r
    } else {
        // Inside an open undo group (a script, an action): join it.
        let scope = s.begin_undo_scope().ok_or_else(no_document)?;
        let r = f(s);
        s.end_undo_scope(scope, r.is_err());
        r
    }
}

pub(crate) fn no_document() -> AiError {
    AiError::document("Open or create a document first.")
}

pub(crate) fn exec(s: &mut Session, id: &str, params: Value) -> Result<Value> {
    s.execute(id, &params).map_err(AiError::from)
}

pub(crate) fn active_uid(s: &Session) -> Result<u64> {
    s.active().map(|st| st.uid).ok_or_else(no_document)
}

pub(crate) fn selection(s: &Session) -> Result<Vec<NodeId>> {
    Ok(s.doc().map_err(|_| no_document())?.selection.objects.clone())
}

pub(crate) fn node_bounds(s: &Session, id: NodeId) -> Option<Rect> {
    s.doc().ok()?.doc.node(id)?.geometric_bounds().filter(|r| crate::fit::usable(*r))
}

/// The union of the selected objects' bounds.
pub(crate) fn selection_bounds(s: &Session) -> Option<Rect> {
    let ids = selection(s).ok()?;
    ids.iter().filter_map(|id| node_bounds(s, *id)).reduce(|a, b| a.union(b))
}

/// The active artboard's rectangle (else the first artboard's).
pub(crate) fn artboard_rect(s: &Session) -> Option<Rect> {
    let st = s.active()?;
    let boards = &st.doc.artboards;
    st.active_artboard.and_then(|id| boards.iter().find(|a| a.id == id)).or_else(|| boards.first()).map(|a| a.rect)
}

pub(crate) fn ids_of(v: &Value) -> Vec<u64> {
    v.get("ids").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_u64).collect()
}

pub(crate) fn id_of(v: &Value) -> Option<u64> {
    v.get("id").and_then(Value::as_u64)
}

pub(crate) fn kind_of(s: &Session, id: NodeId) -> Option<NodeKind> {
    s.doc().ok()?.doc.node(id).map(|n| n.kind.clone())
}

/// Paste objects that `import` (`clipboard.importSvg` or `clipboard.importImage`) put on the
/// clipboard, where they were centred, and put the person's clipboard back as it was.
pub(crate) fn paste_import(s: &mut Session, import: &str, params: Value) -> Result<Vec<u64>> {
    let kept = s.clipboard.clone();
    let r = exec(s, import, params).and_then(|_| exec(s, "edit.pasteInPlace", json!({})));
    s.clipboard = kept;
    let ids = ids_of(&r?);
    if ids.is_empty() {
        return Err(AiError::bad_response("The generated art had nothing to place."));
    }
    Ok(ids)
}

/// The selected art as a PNG whose long side is at most `max_px` (a style reference), with the
/// person's clipboard put back as it was. `None` when nothing is selected.
pub(crate) fn selection_png(s: &mut Session, max_px: u32) -> Result<Option<Vec<u8>>> {
    let Some(b) = selection_bounds(s) else { return Ok(None) };
    let scale = (f64::from(max_px) / b.width().max(b.height())).clamp(0.01, 4.0);
    let kept = s.clipboard.clone();
    let r = exec(s, "edit.copy", json!({})).and_then(|_| s.clipboard_png(scale).map_err(AiError::from));
    s.clipboard = kept;
    Ok(r?.map(|(png, ..)| png))
}

/// Move `id` to just below `anchor`, in `anchor`'s parent.
pub(crate) fn move_below(s: &mut Session, id: u64, anchor: NodeId) -> Result<()> {
    let (parent, index, _) =
        s.doc().map_err(|_| no_document())?.doc.position(anchor).ok_or_else(|| AiError::document("The target object is gone."))?;
    exec(s, "node.move", json!({ "id": id, "parent": parent.map(|p| p.0), "index": index }))?;
    Ok(())
}

/// Scale and move `id` (uniformly) into `target`.
pub(crate) fn fit_into(s: &mut Session, id: u64, target: Rect, mode: crate::fit::FitMode) -> Result<()> {
    let Some(b) = node_bounds(s, NodeId(id)) else { return Ok(()) };
    if let Some(m) = crate::fit::fit_matrix(b, target, mode) {
        exec(s, "object.transform", json!({ "ids": [id], "matrix": m }))?;
    }
    Ok(())
}

/// How many variations: 1–4.
pub(crate) fn clamp_variations(n: u8) -> usize {
    usize::from(n.clamp(1, 4))
}
