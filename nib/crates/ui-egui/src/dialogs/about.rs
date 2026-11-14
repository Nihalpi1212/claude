//! Help → About VectorCraft.

use crate::VectorcraftApp;
use crate::theme;

/// The About window, while `UiState::about` is set.
pub(super) fn show(app: &mut VectorcraftApp, ctx: &egui::Context) {
    if !app.ui.about {
        return;
    }
    let mut open = true;
    egui::Window::new(tl!("About Nib"))
        .collapsible(false)
        .resizable(false)
        .open(&mut open)
        .pivot(egui::Align2::CENTER_CENTER)
        .default_pos(ctx.content_rect().center())
        .frame(egui::Frame::window(&ctx.global_style()).inner_margin(egui::Margin::same(18)))
        .show(ctx, |ui| {
            // Tabs: About · Contributors · Models (the credits are compiled in, see `credits`).
            let tab_id = egui::Id::unique("about_tab");
            let mut tab = ui.data_mut(|d| d.get_temp::<u8>(tab_id)).unwrap_or(0);
            ui.horizontal(|ui| {
                for (i, label) in [tl!("About"), tl!("Contributors"), tl!("Models")].into_iter().enumerate() {
                    let i = i as u8;
                    if ui.selectable_label(tab == i, label).clicked() {
                        tab = i;
                    }
                }
            });
            ui.data_mut(|d| d.insert_temp(tab_id, tab));
            ui.separator();
            match tab {
                1 => {
                    ui.set_width(820.0);
                    crate::credits::contributors_ui(app, ui);
                }
                2 => {
                    ui.set_width(820.0);
                    crate::credits::models_ui(ui);
                }
                _ => about_tab(app, ui),
            }
        });
    app.ui.about = open;
}

/// The About tab: mark, version, project links, where Nib comes from, licences and the GPU in use.
fn about_tab(app: &mut VectorcraftApp, ui: &mut egui::Ui) {
    ui.set_width(380.0);
    ui.horizontal(|ui| {
        let (r, _) = ui.allocate_exact_size(egui::vec2(44.0, 44.0), egui::Sense::hover());
        crate::brand::paint_mark(ui, r);
        ui.vertical(|ui| {
            ui.label(egui::RichText::new(vectorcraft_format::brand::NAME).font(theme::semibold(22.0)));
            // `Nib 0.1.0 (based on VectorCraft 0.24.1)`, as `--version` prints it.
            ui.label(vectorcraft_format::brand::version_line());
            ui.label(tl!("Open-source vector illustration in pure Rust."));
        });
    });
    ui.add_space(12.0);
    crate::community::links(app, ui);
    ui.add_space(12.0);
    ui.label(tl!("Nib is based on VectorCraft by the ArtCraft team and the VectorCraft contributors (MIT OR Apache-2.0)"));
    ui.add_space(4.0);
    ui.label(egui::RichText::new(tl!("Fonts: Source Sans 3, Inter, JetBrains Mono (OFL). Icons: Lucide (ISC) + VectorCraft.")).size(11.0));
    // The GPU the window renders with, for bug reports (Preferences › Performance picks it).
    if let Some(adapter) = &app.graphics_adapter {
        ui.add_space(6.0);
        ui.label(egui::RichText::new(crate::i18n::fmt(tl!("Graphics: {adapter}"), &[("adapter", adapter.as_str())])).size(11.0));
    }
}
