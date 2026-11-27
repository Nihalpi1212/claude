//! Pigment: a Solid Color fill layer's colour in the Properties panel, as Photoshop and the JavaScript Pigment 0.4
//! show it (`renderer/lib/properties/fill.js`): a swatch of the fill's colour. A click opens the layer's Color Picker
//! through `layer.layerContentOptions` (`solid_fill_ui::open`), with its live preview, Cancel, and OK as one history
//! step (upstream's "Solid Color", `layer.fill.solidColor.set`).

use craft::behavior::Mixed;
use craft::theme::Srgba;
use craft::ui::choice::Swatch;
use craft::ui::contract::{Props as _, Show as _, ShowContainer as _};
use craft::ui::sections::Section;
use photocraft_doc::{Fill, Layer, LayerContent};
use serde_json::json;

use crate::PhotocraftApp;

/// The Color section of a Solid Color fill layer; nothing for other layers.
pub(crate) fn section(app: &mut PhotocraftApp, ui: &mut egui::Ui, layer: &Layer) {
    let LayerContent::Fill(Fill::Solid(color)) = &layer.content else { return };
    let Some(document) = app.session.active().map(|st| st.doc.id) else { return };
    // While the picker edits this fill, the swatch shows the colour it previews.
    let shown = crate::solid_fill_ui::thumbnail_color(app, document, layer.id, *color);
    let rgb = Srgba::from_rgb_array(shown.to_rgb());
    let mut open = false;
    Section::new(tl!("Color")).show(ui, |ui, _| {
        ui.horizontal(|ui| {
            open = Swatch::new(tl!("Color"), Mixed::Same(rgb)).id_salt("pigment.solidFill.color").show(ui).clicked;
            ui.monospace(rgb.to_hex());
        });
    });
    if open {
        let ctx = ui.ctx().clone();
        if let Err(error) = crate::menus::invoke(app, &ctx, "layer.layerContentOptions", json!({})) {
            app.ui.status = error;
            app.ui.status_error = true;
        }
    }
}

#[cfg(test)]
mod tests;
