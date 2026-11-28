//! Pigment: Select › Similar Layers sits in the Select menu's layer group, right after Deselect
//! Layers, where Photoshop has listed it since CS6 (PORTS-A row 45).

use serde_json::json;

use crate::PhotocraftApp;

#[test]
fn similar_layers_follows_deselect_layers_in_the_select_menu() {
    let mut app = PhotocraftApp::new(photocraft_engine::Session::new(), Default::default());
    app.run("file.new", json!({"width": 20, "height": 20})).unwrap();
    app.run("layer.new.layer", json!({})).unwrap();
    let ctx = app.ctx().clone();
    let rows = &crate::menus::model(&mut app, &ctx).rows;
    let at = |id: &str| rows.iter().position(|r| r.command.id == id).unwrap_or_else(|| panic!("{id} is a menu row"));
    let similar = &rows[at("select.similarLayers")];
    assert_eq!(at("select.similarLayers"), at("select.deselectLayers") + 1);
    assert_eq!(similar.path, rows[at("select.deselectLayers")].path);
    assert_eq!(similar.label, "Similar Layers");
    assert!(similar.enabled, "a layer is selected");
    // Photoshop's pixel Select › Similar stays its own row.
    assert!(at("select.similar") != at("select.similarLayers"));
}
