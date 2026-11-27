use super::{CustomShape, Deserialize, Document, EngineError, LayerContent, LayerId, Path, Result, Serialize, Session, Value, bad, json};

// ------------------------------------------------------------------ Define Brush / Custom Shape

pub(super) fn define_brush_preset(s: &mut Session, p: &Value) -> Result<Value> {
    let name = match p.get("name").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty()) {
        Some(n) => n.to_string(),
        None => {
            let n = s.tools.presets.iter().filter(|b| b.name.starts_with("Sampled Brush")).count() + 1;
            format!("Sampled Brush {n}")
        }
    };
    s.execute("brush.defineFromSelection", json!({"name": name}))
}

/// The path Define Custom Shape uses: `"work"`, a saved path name, else the work path, the
/// active shape layer, the active layer's vector mask, or the last saved path.
pub(crate) fn current_path(doc: &Document, active: Option<LayerId>, spec: Option<&str>) -> Option<Path> {
    let ok = |p: &Path| !p.subpaths.is_empty();
    match spec {
        Some("work") => return doc.work_path.clone().filter(ok),
        Some(name) => return doc.paths.iter().find(|n| n.name == name).map(|n| n.path.clone()).filter(ok),
        None => {}
    }
    if let Some(p) = doc.work_path.clone().filter(ok) {
        return Some(p);
    }
    if let Some(l) = active.and_then(|id| doc.layer(id)) {
        if let LayerContent::Shape(sh) = &l.content
            && ok(&sh.path)
        {
            return Some(sh.path.clone());
        }
        if let Some(vm) = l.vector_mask.as_ref().filter(|v| ok(&v.path)) {
            return Some(vm.path.clone());
        }
    }
    doc.paths.last().map(|n| n.path.clone()).filter(ok)
}

pub(super) fn can_define_shape(s: &Session) -> std::result::Result<(), String> {
    let d = s.active().ok_or("no document open")?;
    current_path(&d.doc, d.active_layer, None).map(|_| ()).ok_or_else(|| "select a path or shape layer first".into())
}

pub(super) fn define_custom_shape(s: &mut Session, p: &Value) -> Result<Value> {
    let st = s.active().ok_or(EngineError::NoDocument)?;
    let path = current_path(&st.doc, st.active_layer, p.get("path").and_then(Value::as_str)).ok_or_else(|| bad("edit.defineCustomShape", "no such path"))?;
    let name = p
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("Shape {}", s.edit_state.custom_shapes.len() + 1));
    let shapes = &mut s.edit_state.custom_shapes;
    match shapes.iter_mut().find(|c| c.name == name) {
        Some(c) => c.path = path,
        None => shapes.push(CustomShape { name: name.clone(), path }),
    }
    Ok(json!({"name": name, "count": shapes.len()}))
}

// ------------------------------------------------------------------ presets

// Pigment: Preset Manager for every kind (P1a): `edit.presets.presetManager` is in
// `preset_manager.rs`, over nine kinds instead of upstream's three.

/// Exported preset file (`.pcpresets`, JSON).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PresetFile {
    pub format: String,
    pub version: u32,
    pub brushes: Vec<photocraft_paint::BrushPreset>,
    pub custom_shapes: Vec<CustomShape>,
    pub tool_presets: Vec<crate::presets::tools::ToolPreset>,
    // Pigment: Export/Import Presets for every kind (P1b): the other six kinds (`preset_file.rs`).
    // Absent from upstream's three-kind files, and left out when empty.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub swatches: Vec<craft::color_ui::palette::SwatchGroup>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub gradients: Vec<crate::presets::Group<crate::presets::gradients::GradientPreset>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub styles: Vec<crate::presets::Group<crate::presets::styles::StylePreset>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub patterns: Vec<super::preset_file::PatternEntry>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub pattern_groups: Vec<crate::presets::Group<String>>,
    /// The contour library's saved form (`layer.layerStyle.contours.*` curve objects).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub contours: Vec<Value>,
    /// The Shapes panel's groups (Define Custom Shape results stay in `custom_shapes`).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub shapes: Vec<crate::presets::Group<crate::presets::shapes::ShapePreset>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub adjustments: Vec<super::preset_file::AdjustmentEntry>,
}

pub const PRESET_FORMAT: &str = "photocraft-presets";
