use craft::ui::contract::Show as _;
use craft::ui::shell::{Title, TitleBar};

use super::{PhotocraftApp, brand};

// ----------------------------------------------------------------------------- title bar

/// The app's top bar, in the shell's title slot: brand mark, menus and the document title. Nothing else sits at its
/// far end, as in the reference application: the workspace switcher, command search and appearance mode live in
/// Window › Workspace, Edit › Search and Window › Appearance (#13577).
/// The framework `TitleBar` follows the window's frame: with the app's own frame (Windows and Linux) it is also the
/// window's title bar and the caption buttons take its ends; with the system's frame it shows the content and no title.
pub fn title_bar(app: &mut PhotocraftApp, ui: &mut egui::Ui) {
<<<<<<< ours
    let t = Tokens::get(ui.ctx());
    let custom = app.custom_titlebar;
    let system = system_title_bar(app);
    // The caption buttons' room at each end (`titlebar`); a side with buttons has no margin.
    let (caption_left, caption_right) = crate::titlebar::reserved(app, ui.ctx());
    let left = if cfg!(target_os = "macos") && app.integrated_titlebar {
        78
    } else if caption_left > 0.0 {
        0
    } else {
        10
    };
    let right = if caption_right > 0.0 { 0 } else { 10 };
    let bar = egui::Panel::top("title_bar")
        .exact_size(crate::titlebar::bar_height(app, ui.ctx(), if t.pro { 32.0 } else { 38.0 }))
        .frame(egui::Frame::NONE.fill(t.chrome).inner_margin(egui::Margin { left, right, top: 0, bottom: 0 }))
        .show(ui, |ui| {
            let full = ui.max_rect();
            // Only the free gap between the menus and the far-end controls drags the window: a
            // press on a menu title must open the menu, never move the window. The gap is last
            // frame's, as the menus are laid out after this.
            let span_id = ui.scope_id().with("titledrag-span");
            let (gap_l, gap_r) = ui.ctx().data(|d| d.get_temp::<(f32, f32)>(span_id)).unwrap_or((full.right(), full.right()));
            let gap = egui::Rect::from_x_y_ranges(gap_l.max(full.left())..=gap_r.min(full.right()).max(gap_l), full.y_range());
            ui.ctx().data_mut(|d| d.insert_temp(crate::titlebar::modal_drag_area_id(), gap));
            let drag = ui.interact(gap, ui.scope_id().with("titledrag"), Sense::click_and_drag());
            crate::titlebar::follow_pen_drag(ui.ctx());
            if drag.drag_started_by(egui::PointerButton::Primary) {
                crate::titlebar::start_os_move(ui.ctx());
            }
            if drag.double_clicked() {
                let max = ui.ctx().input(|i| i.viewport().maximized.unwrap_or(false));
                ui.ctx().send_viewport_cmd(egui::ViewportCommand::Maximized(!max));
            }
            // Preferences › Interface › Show File Name In Title: with it off the bar keeps the
            // app name and the unsaved dot, since the tabs already name the file (#5037).
            let show_name = app.session.prefs().interface.show_file_name_in_title;
            let title = app
                .session
                .active()
                .map(|d| format!("{}{}", if show_name { d.doc.name.as_str() } else { "Pigment" }, if d.is_dirty() { "  •" } else { "" }))
                .unwrap_or_else(|| "Pigment".into());
            // The menus and the far-end controls are laid out first; the title is centred in
            // whatever room is left between them (`free`, left to right: menus then controls, or
            // controls then menus in a right-to-left UI), shortened or dropped rather than drawn
            // over them.
            let rtl = crate::direction::is_rtl();
            let mut free = (full.left(), full.right());
            crate::direction::horizontal_centered(ui, |ui| {
                // The menus start beside the caption buttons at their end, if it has any.
                let lead = if rtl { caption_right } else { caption_left };
                if lead > 0.0 {
                    ui.add_space(lead + 4.0);
                }
                if !system {
                    let side = if t.pro { 18.0 } else { 20.0 };
                    let (mark, _) = ui.allocate_exact_size(vec2(side, side), Sense::hover());
                    crate::brand::paint_mark(ui, mark);
                    ui.add_space(6.0);
                }
                // With the macOS menu bar the menus are at the top of the screen instead. Either way
                // this is the menus' inner edge, facing the title.
                let menus_end = if app.services.native_menu.is_some() {
                    if rtl { ui.cursor().right() } else { ui.cursor().left() }
                } else {
                    crate::menus::menu_bar(app, ui)
                };
                // The menu bar takes the whole row, so the far-end group gets its own rect: from
                // the menus to the bar's end, or to the caption buttons.
                let group = if rtl {
                    let left_edge = if caption_left > 0.0 { full.left() + caption_left + 4.0 } else { full.left() };
                    egui::Rect::from_min_max(egui::pos2(left_edge, full.top()), egui::pos2((menus_end - TITLE_GAP).max(left_edge), full.bottom()))
                } else {
                    let right_edge = if caption_right > 0.0 { full.right() - caption_right - 4.0 } else { full.right() };
                    egui::Rect::from_min_max(egui::pos2((menus_end + TITLE_GAP).min(right_edge), full.top()), egui::pos2(right_edge, full.bottom()))
                };
                let mut group_ui = ui.new_child(egui::UiBuilder::new().max_rect(group).layout(crate::direction::trailing()));
                let controls_end = {
                    let ui = &mut group_ui;
                    ui.spacing_mut().item_spacing.x = 6.0;
                    let mut ws = app.ui.workspace.clone();
                    let options = crate::workspace_ui::switcher_options(app);
                    let opts: Vec<(String, &str)> = options.iter().map(|(k, l)| (k.clone(), l.as_str())).collect();
                    // A narrow bar drops what is also in a menu, the theme toggle first
                    // (Preferences), then search (Edit › Search), and narrows the switcher
                    // (Window › Workspace) before anything runs over.
                    let room = ui.available_width();
                    let icons_shown: u8 = if room >= WORKSPACE_MIN + 2.0 * ICON_SLOT {
                        2
                    } else if room >= WORKSPACE_MIN + ICON_SLOT {
                        1
                    } else {
                        0
                    };
                    let ws_width = (room - f32::from(icons_shown) * ICON_SLOT - 6.0).clamp(WORKSPACE_MIN, 130.0);
                    if room >= WORKSPACE_MIN && widgets::dropdown(ui, "workspace", tl!("Workspace"), &mut ws, &opts, ws_width) {
                        app.ui.workspace = ws;
                        crate::menus::apply_workspace(app);
                    }
                    if icons_shown >= 1
                        && icons::button(ui, "search", 28.0, app.ui.palette_open, &crate::shortcuts::tip_label(app, "Search commands", "edit.search")).clicked()
                    {
                        app.ui.palette_open = !app.ui.palette_open;
                    }
                    let (theme_icon, appearance_label) = match app.session.prefs().interface.appearance_mode {
                        photocraft_engine::prefs::AppearanceMode::Auto => ("monitor", tl!("Auto")),
                        photocraft_engine::prefs::AppearanceMode::Dark => ("moon", tl!("Dark")),
                        photocraft_engine::prefs::AppearanceMode::Light => ("sun", tl!("Light")),
                    };
                    let appearance_tip = format!("{}: {}", tl!("Appearance Mode"), appearance_label);
                    if icons_shown >= 2 {
                        let button = icons::button(ui, theme_icon, 28.0, false, &appearance_tip);
                        if button.clicked() {
                            crate::prefs_ui::cycle_appearance(app, ui.ctx());
                        }
                        button.context_menu(|ui| crate::prefs_ui::appearance_context_menu(app, ui));
                    }
                    if rtl { ui.min_rect().right() } else { ui.min_rect().left() }
                };
                free = if rtl { (controls_end, menus_end) } else { (menus_end, controls_end) };
            });
            ui.ctx().data_mut(|d| d.insert_temp(span_id, free));
            if system {
                return;
            }
            let font = theme::medium(13.0);
            let galley = ui.painter().layout_job(title_job(&title, font.clone(), t.text_dim));
            if let Some(x) = title_x(full.center().x, free.0, free.1, galley.size().x) {
                ui.painter().galley(egui::pos2(x, full.center().y - galley.size().y / 2.0), galley, t.text_dim);
            } else if free.1 - free.0 > 80.0 {
                // Too narrow for the whole name: show the start of it, elided, in the free gap
                // next to the menus.
                let avail = free.1 - free.0 - 2.0 * TITLE_GAP;
                let mut job = title_job(&title, font, t.text_dim);
                job.wrap = egui::text::TextWrapping::truncate_at_width(avail);
                let g = ui.painter().layout_job(job);
                let x = if rtl { free.1 - TITLE_GAP - g.size().x } else { free.0 + TITLE_GAP };
                ui.painter().galley(egui::pos2(x, full.center().y - g.size().y / 2.0), g, t.text_dim);
=======
    let title = title_text(app);
    let out = TitleBar::new().show_titled(
        ui,
        Title::new(title),
        |ui, _| {
            brand::mark().show(ui);
            // With the macOS menu bar the menus are at the top of the screen instead.
            if app.services.native_menu.is_none() {
                crate::menus::menu_bar(app, ui);
>>>>>>> theirs
            }
        },
        |_, _| {},
    );
    // The bar never closes the window: File › Exit asks about unsaved work first.
    if out.close_requested {
        let _ = crate::menus::invoke(app, ui.ctx(), "file.exit", serde_json::json!({}));
    }
}

/// The title the bar shows: the active document's name with a dot when it has unsaved changes, or the app name with
/// no document open. With Preferences › Interface › Show File Name In Title off, the file name drops out and the app
/// name (and the dot) remains, since the tabs already name the file (#5037).
pub(crate) fn title_text(app: &PhotocraftApp) -> String {
    let show_name = app.session.prefs().interface.show_file_name_in_title;
    app.session
        .active()
        .map(|d| format!("{}{}", if show_name { d.doc.name.as_str() } else { "PhotoCraft" }, if d.is_dirty() { "  •" } else { "" }))
        .unwrap_or_else(|| "PhotoCraft".into())
}

/// The OS window title: the active document's name suffixed with the app name (a `*` prefix
/// marks unsaved changes, like the `•` in the app-drawn title), or just the app name with no
/// document open. With Preferences › Interface › Show File Name In Title off, the file name
/// drops out and only the app name (and the `*`) remains (#5037).
pub fn window_title(app: &PhotocraftApp) -> String {
    if !app.session.prefs().interface.show_file_name_in_title {
        return format!("{}Pigment", if app.session.active().is_some_and(|d| d.is_dirty()) { "*" } else { "" });
    }
    app.session.active().map(|d| format!("{}{} \u{2014} Pigment", if d.is_dirty() { "*" } else { "" }, d.doc.name)).unwrap_or_else(|| "Pigment".into())
}

#[cfg(test)]
mod tests;
