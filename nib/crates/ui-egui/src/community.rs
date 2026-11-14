//! Project links: the Report an Issue button (About, Home) and the link list (Nib's repository and
//! releases, and the upstream VectorCraft project in About). Icons are Lucide's (ISC). The
//! function names are VectorCraft's (`discord_*`), kept so upstream changes merge; the button now
//! opens Nib's issue tracker (`help.discord`, see docs/FORK.md).

use egui::{Color32, CornerRadius, Sense, Ui, vec2};

use crate::theme::{self, Tokens};
use crate::{VectorcraftApp, icons};

/// The compact button's icon colour: Nib's accent (the icon's aqua).
const DISCORD: Color32 = Color32::from_rgb(0x2a, 0xa8, 0x9a);

/// The Report an Issue button's label, height and width.
fn discord_layout(ui: &Ui, large: bool) -> (std::sync::Arc<egui::Galley>, f32, f32) {
    let (h, font, label) =
        if large { (36.0, theme::semibold(14.0), tl!("Report an issue")) } else { (24.0, egui::FontId::proportional(12.0), tl!("Report an Issue")) };
    let galley = ui.painter().layout_no_wrap(label.to_string(), font, Color32::PLACEHOLDER);
    let w = galley.size().x + h * 0.55 + h * 0.9;
    (galley, h, w)
}

/// The Report an Issue button's width (the app bar drops it when space runs out).
pub fn discord_width(ui: &Ui, large: bool) -> f32 {
    discord_layout(ui, large).2
}

/// The Report an Issue button: compact and quiet for the app bar, large for About / Home.
pub fn discord_button(app: &mut VectorcraftApp, ui: &mut Ui, large: bool) -> egui::Response {
    let (galley, h, w) = discord_layout(ui, large);
    let icon = h * 0.55;
    let (r, resp) = ui.allocate_exact_size(vec2(w, h), Sense::click());
    let at = egui::pos2(0.0, r.center().y - galley.size().y / 2.0);
    let ir = egui::Rect::from_center_size(r.left_center() + vec2(h * 0.35 + icon / 2.0, 0.0), vec2(icon, icon));
    if large {
        // The theme's accent, as the primary buttons use it, so the call to action matches the
        // rest of the window (and PhotoCraft's, #4684); Discord's colour stays on the app-bar icon.
        let t = Tokens::get(ui.ctx());
        let fill = if resp.hovered() { t.accent } else { t.accent_strong };
        ui.painter().rect_filled(r, CornerRadius::same((h / 2.0) as u8), fill);
        icons::paint(ui, "message-circle", ir, Color32::WHITE);
        ui.painter().galley(egui::pos2(ir.right() + h * 0.2, at.y), galley, Color32::WHITE);
    } else {
        // In the app bar it stays quiet: a soft button with the accent on its icon alone.
        let t = Tokens::get(ui.ctx());
        ui.painter().rect_filled(r, CornerRadius::same(6), if resp.hovered() { t.hover } else { t.button });
        icons::paint(ui, "message-circle", ir, DISCORD);
        ui.painter().galley(egui::pos2(ir.right() + h * 0.2, at.y), galley, if resp.hovered() { t.text_strong } else { t.text });
    }
    let resp = resp.on_hover_text(tl!("Report a problem or suggest an idea on Nib's GitHub"));
    if resp.clicked() {
        app.open_link("help.discord");
    }
    resp
}

/// One link row: icon, label, opens the command's URL. `centered` drops the icon so the label
/// alone sits in the middle of the column.
fn link(app: &mut VectorcraftApp, ui: &mut Ui, icon: &str, label: &str, cmd: &str, url: &str, centered: bool) {
    let t = Tokens::get(ui.ctx());
    let button = |ui: &mut Ui| ui.add(egui::Button::new(egui::RichText::new(label).color(t.accent).size(13.0)).frame(false)).on_hover_text(url);
    let r = if centered {
        button(ui)
    } else {
        ui.horizontal(|ui| {
            icons::icon(ui, icon, 16.0, t.icon);
            button(ui)
        })
        .inner
    };
    if r.clicked() {
        app.open_link(cmd);
    }
}

/// The Report an Issue button and the links, with the upstream project (About).
pub fn links(app: &mut VectorcraftApp, ui: &mut Ui) {
    links_in(app, ui, false);
}

/// [`links`] for a centred column (the Home screen's, #4684): the Report an Issue button and Nib's
/// links, each in the middle.
pub fn links_centered(app: &mut VectorcraftApp, ui: &mut Ui) {
    links_in(app, ui, true);
}

fn links_in(app: &mut VectorcraftApp, ui: &mut Ui, centered: bool) {
    discord_button(app, ui, true);
    ui.add_space(8.0);
    let l = app.session.execute("help.links", &serde_json::json!({})).unwrap_or_default();
    let s = |k: &str| l[k].as_str().unwrap_or("").to_string();
    link(app, ui, "git-branch", tl!("Source code on GitHub"), "help.github", &s("github"), centered);
    link(app, ui, "external-link", tl!("Nib Releases"), "help.appPage", &s("appPage"), centered);
    // The upstream project, in About (the Home screen's column is centred).
    if !centered {
        link(app, ui, "globe", tl!("VectorCraft (upstream project)"), "help.website", &s("website"), centered);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_clicks_open_the_right_urls() {
        use std::sync::{Arc, Mutex};
        let opened = Arc::new(Mutex::new(vec![]));
        let o = opened.clone();
        let services = crate::Services { open_url: Some(Box::new(move |u: &str| o.lock().unwrap().push(u.to_string()))), ..Default::default() };
        let mut app = VectorcraftApp::new(vectorcraft_engine::Session::new(), services);
        for id in ["help.discord", "help.website", "help.appPage", "help.github"] {
            crate::menus::invoke(&mut app, id, serde_json::json!({}));
        }
        assert_eq!(
            *opened.lock().unwrap(),
            [
                "https://github.com/Nihalpi1212/claude/issues",
                "https://github.com/storytold/vectorcraft",
                "https://github.com/Nihalpi1212/claude/releases",
                "https://github.com/Nihalpi1212/claude"
            ]
        );
        // The control channel / MCP path returns the URL without opening a browser.
        let v = app.run("help.discord", serde_json::json!({})).unwrap();
        assert_eq!(v["url"], "https://github.com/Nihalpi1212/claude/issues");
        assert_eq!(opened.lock().unwrap().len(), 4);
        let ctx = egui::Context::default();
        theme::install_fonts(&ctx);
        let mut out = ctx.run_ui(egui::RawInput::default(), |ui| links(&mut app, ui));
        out.textures_delta.clear();
    }
}
