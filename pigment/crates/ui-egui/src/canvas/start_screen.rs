//! The Home screen: the framework start page with PhotoCraft's recent files, links and drop hint, and the Home rule
//! the options bar's button, the rail's Home link and `window.home` share.

use craft::behavior::IconId;
use craft::ui::contract::Bind;
use craft::ui::runtime::env::Label;
use craft::ui::shell::{StartAction, StartLink, StartScreen};

use super::PhotocraftApp;

/// Recent files listed on the Home screen.
const HOME_RECENT: usize = 11;

/// The Home screen in the document area. The recent list is empty on the web, which has no paths to reopen, and with
/// Show Home Recent Files off.
pub(super) fn start_screen(app: &mut PhotocraftApp, ui: &mut egui::Ui) {
    let ctx = ui.ctx().clone();
    let show_recent = !cfg!(target_arch = "wasm32") && app.session.prefs().interface.show_home_recent_files;
    let recent = if show_recent { crate::home_recent_ui::recent_files(app, HOME_RECENT) } else { Vec::new() };
    let thumbs = crate::home_recent_ui::thumbnails(&ctx);
    // The source reads the app, so the page binds copies of the view and the sort and they are written back after.
    let (mut view, mut sort) = (app.ui.chrome.home_recent_view, app.ui.chrome.home_recent_sort);
    let links = links();
    let actions = {
        let source = crate::home_recent_ui::source(app, &ctx);
        StartScreen::new(Bind::bound(&mut view), Bind::bound(&mut sort), &recent)
            .thumbnails(&thumbs, &source)
            .links(&links[..])
            .max_recent(HOME_RECENT)
            .drop_hint(Label::from(tl!("Drop an image or PSD anywhere to open it.")))
            .show(ui)
            .actions
    };
    app.ui.chrome.home_recent_view = view;
    app.ui.chrome.home_recent_sort = sort;
    for action in actions {
        // The recent list's own actions and Open; New is the New Document dialog's, Show in Folder the platform's.
        if let StartAction::RevealRecent(path) = &action {
            reveal(app, path);
            continue;
        }
        if crate::home_recent_ui::act(app, &action) {
            continue;
        }
        if action == StartAction::New {
            crate::new_doc_ui::open(app);
        }
    }
<<<<<<< ours

    // 5. Bottom pinned community links
    let bottom_h = 100.0;
    let avail_h = ui.available_height();
    let spacer = (avail_h - bottom_h - 20.0).max(24.0);
    ui.add_space(spacer);

    let (b_sep_rect, _) = ui.allocate_exact_size(egui::vec2(sep_w, 1.0), Sense::hover());
    ui.painter().line_segment([b_sep_rect.min, egui::pos2(b_sep_rect.max.x, b_sep_rect.min.y)], egui::Stroke::new(1.0, t.separator));

    ui.add_space(8.0);

    render_rail_link(app, ui, rail_w, tl!("Releases"), "link", crate::links::RELEASES);
    render_rail_link(app, ui, rail_w, tl!("Report an Issue"), "message-square", crate::links::ISSUES);
    render_rail_link(app, ui, rail_w, tl!("GitHub"), "link-2", crate::links::GITHUB);
=======
>>>>>>> theirs
}

/// Shows a recent file selected in the system file manager; a failure goes to the status line, as the other open
/// errors do. The start screen offers Show in Folder only where the platform can reveal a file.
fn reveal(app: &mut PhotocraftApp, path: &std::path::Path) {
    #[cfg(not(target_arch = "wasm32"))]
    if let Err(e) = craft::platform::open::reveal(path) {
        app.ui.status = e;
        app.ui.status_error = true;
    }
    #[cfg(target_arch = "wasm32")]
    let _ = (app, path);
}

<<<<<<< ours
fn render_start_content(app: &mut PhotocraftApp, ui: &mut egui::Ui, recent: &[String], content_w: f32) {
    let t = crate::theme::Tokens::get(ui.ctx());
    ui.add_space(8.0);

    // Top Row: [01] PhotoCraft
    ui.horizontal(|ui| {
        let badge_size = egui::vec2(24.0, 19.0);
        let (badge_rect, _) = ui.allocate_exact_size(badge_size, Sense::hover());
        ui.painter().rect_filled(badge_rect, 3.0, egui::Color32::from_rgb(26, 115, 232));
        ui.painter().text(badge_rect.center(), egui::Align2::CENTER_CENTER, "01", crate::theme::semibold(10.5), egui::Color32::WHITE);

        ui.add_space(10.0);

        let title_galley = ui.painter().layout_no_wrap(tl!("Pigment").into(), crate::theme::semibold(20.0), t.text);
        let (title_r, _) = ui.allocate_exact_size(title_galley.size(), Sense::hover());
        ui.painter().galley(title_r.min, title_galley, t.text);
    });

    ui.add_space(18.0);

    // Hairline separator under header
    let (sep_r, _) = ui.allocate_exact_size(egui::vec2(content_w, 1.0), Sense::hover());
    ui.painter().line_segment([sep_r.min, egui::pos2(sep_r.max.x, sep_r.min.y)], egui::Stroke::new(1.0, t.separator));

    ui.add_space(24.0);

    if recent.is_empty() {
        render_first_run_content(app, ui, content_w);
    } else {
        crate::home_recent_ui::show_home_recent(app, ui, recent, content_w);
    }

    ui.add_space(24.0);
=======
/// The links of the Home rail: Home, which leaves Home for the open documents, then Learn and the community pages.
fn links() -> [StartLink; 5] {
    [
        StartLink::command(tl!("Home"), Some(IconId::new("home")), "window.home"),
        StartLink::url(tl!("Learn"), Some(IconId::new("sparkles")), crate::links::TUTORIALS),
        StartLink::url(tl!("Website"), Some(IconId::new("link")), crate::links::APP_PAGE),
        StartLink::url(tl!("Discord"), Some(IconId::new("globe")), crate::links::DISCORD),
        StartLink::url(tl!("GitHub"), Some(IconId::new("globe")), crate::links::GITHUB),
    ]
>>>>>>> theirs
}

/// Shows Home over the open documents, or leaves it for them: the rule of the options bar's Home button, the Home
/// rail's Home link and `window.home`. With no document open there is nothing behind Home, so it does nothing.
pub(crate) fn toggle_home(app: &mut PhotocraftApp) {
    let documents = app.session.documents().len();
    if documents == 0 {
        return;
    }
    let auto = app.session.prefs().general.auto_show_home_screen;
    let up = app.ui.chrome.shows_home(documents, auto);
    app.ui.chrome.home = if up { None } else { Some(documents) };
}
