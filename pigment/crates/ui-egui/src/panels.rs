//! Chrome around the canvas: title bar, options bar, toolbar, status bar, dock cards, Properties.

use craft::ui::patterns::blend_keys::{BlendKeyEntry, BlendShortcut};
#[cfg(test)]
use egui::Rect;
use egui::vec2;
use photocraft_color::BlendMode;
use photocraft_doc::LayerId;
use photocraft_engine::history_source_cmds::HistorySource;
use serde_json::{Value, json};

use crate::state::Tool;
#[cfg(test)]
use crate::theme;
use crate::{PhotocraftApp, icons};

pub mod actions;
pub mod adjust_ui;
pub mod apply_color;
pub(crate) mod blend_preview;
#[cfg(test)]
mod blend_rows_tests;
pub(super) mod brand;
pub mod brush_panel;
pub mod brush_preview;
pub mod brush_sections;
mod brush_settings;
mod brush_settings_events;
pub mod channels_panel;
pub mod chrome_ui;
pub mod clip_line_ui;
pub(crate) mod color;
pub mod color_hud;
pub mod color_panel_ui;
pub mod comps_ui;
pub mod doc_props_ui;
pub mod histogram_panel;
pub(crate) mod history;
pub mod history_menu_ui;
pub(crate) mod info;
pub mod layer_filter_ui;
pub mod layer_menu_ui;
pub mod layer_props_ui;
pub(super) mod layer_reveal;
pub mod layer_row_ui;
pub(super) mod layer_transfer;
mod layers;
pub(crate) mod layers_events;
pub mod layers_panel_ui;
pub(crate) mod layers_tree;
pub(super) mod mask_props_ui;
pub mod mask_thumbs_ui;
mod navigator;
pub(crate) mod options_bar;
pub(super) mod panel_docking;
pub(crate) mod preset_browser;
pub mod preset_panels;
mod properties;
pub(crate) mod region_versions;
pub(crate) mod registry;
pub mod smart_ui;
mod status_bar;
pub mod swatches_ui;
pub(super) mod timeline_ui;
pub(crate) mod title_bar;
pub(crate) mod tool_commands;
pub(crate) mod toolbar;
pub mod type_panels_ui;
pub(super) mod variables_ui;

#[cfg(test)]
pub(crate) use history::select_snapshot;
pub(crate) use history::selected_snapshot;
pub(crate) use info::{SamplerReadouts, sampler_readouts};
pub(crate) use layers::blend_options;
pub(crate) use layers_tree::listed_filter;
pub use options_bar::options_bar;
<<<<<<< ours
#[cfg(test)]
use options_bar::options_bar_height;
pub(crate) use options_bar::{FIXED_SIZE_MAX_PX, opt_label};
pub use panel_state::{migrate_panel_state, panel_state_id, remember_panel_state};
pub use properties::properties_window;
pub(crate) use properties::selection_mode_buttons;
#[cfg(test)]
use properties::{adjustments_grid, properties_body};
pub use status_bar::{status_bar, status_bar_heights};
#[cfg(test)]
use title_bar::title_x;
pub use title_bar::{sync_window_title, system_title_bar, title_bar, window_title};
#[cfg(test)]
use toolbar::{
    STUDIO_CHIP, TOOL_SECTIONS, chips_height, color_chips, next_slot_tool, slot_tool, tool_flyout_drag_open, tool_flyout_release, toolbar_icon_size,
    visible_sections,
};
pub use toolbar::{paint_toolbar_flyout_indicator, toolbar};

fn c32(c: [f32; 4]) -> Color32 {
    Color32::from_rgba_unmultiplied((c[0] * 255.0) as u8, (c[1] * 255.0) as u8, (c[2] * 255.0) as u8, (c[3] * 255.0) as u8)
}

#[cfg(test)]
mod title_tests {
    use super::{system_title_bar, title_x, window_title};

    #[test]
    fn title_never_overlaps_menus_or_controls() {
        // Wide window: centred.
        assert_eq!(title_x(800.0, 420.0, 1300.0, 60.0), Some(770.0));
        // Centre would hit the menus: slid right into the gap.
        assert_eq!(title_x(400.0, 420.0, 1300.0, 60.0), Some(436.0));
        // Centre would hit the controls: slid left.
        assert_eq!(title_x(1280.0, 420.0, 1300.0, 60.0), Some(1224.0));
        // No room for the whole title: the caller elides or drops it.
        assert_eq!(title_x(400.0, 420.0, 480.0, 60.0), None);
        assert_eq!(title_x(f32::NAN, 420.0, 1300.0, 60.0), Some(436.0));
        assert_eq!(title_x(400.0, f32::INFINITY, 1300.0, 60.0), None);
    }

    fn app(custom_titlebar: bool) -> crate::PhotocraftApp {
        let mut app = crate::PhotocraftApp::new(photocraft_engine::Session::new(), crate::Services::default());
        app.custom_titlebar = custom_titlebar;
        // The preference that makes the shell launch without its own title bar.
        app.session.edit_prefs(|p| p.interface.system_title_bar = !custom_titlebar);
        app
    }

    #[test]
    fn without_the_preference_the_mark_stays() {
        // The default (e.g. the web build or snapshot example): the integrated title bar.
        let app = crate::PhotocraftApp::new(photocraft_engine::Session::new(), crate::Services::default());
        assert!(!system_title_bar(&app));
    }

    fn open_named(app: &mut crate::PhotocraftApp, name: &str) {
        app.session.add_document(
            photocraft_doc::Document::new(name, photocraft_doc::Size::new(4, 4), photocraft_doc::ColorMode::Rgb, photocraft_doc::SampleType::U8),
            None,
        );
    }

    #[test]
    fn window_title_with_no_document_is_the_app_name() {
        assert_eq!(window_title(&app(true)), "Pigment");
    }

    #[test]
    fn window_title_follows_the_active_file() {
        let mut app = app(true);
        open_named(&mut app, "foo.psd");
        assert_eq!(window_title(&app), "foo.psd \u{2014} Pigment");
        // Unsaved changes gain a `*` prefix, like the `•` in the app-drawn title.
        if let Some(st) = app.session.active_mut() {
            st.revision += 1;
        }
        assert_eq!(window_title(&app), "*foo.psd \u{2014} Pigment");
    }

    #[test]
    fn hiding_the_file_name_keeps_the_app_name_and_the_dirty_mark() {
        let mut app = app(true);
        open_named(&mut app, "foo.psd");
        app.session.prefs.edit(|p| p.interface.show_file_name_in_title = false);
        assert_eq!(window_title(&app), "Pigment");
        if let Some(st) = app.session.active_mut() {
            st.revision += 1;
        }
        assert_eq!(window_title(&app), "*Pigment");
    }

    #[test]
    fn hidden_file_name_leaves_the_app_name_in_the_drawn_title() {
        let mut app = app(true);
        open_named(&mut app, "foo.psd");
        let texts = |app: &mut crate::PhotocraftApp| {
            let ctx = egui::Context::default();
            crate::PhotocraftApp::setup_context(&ctx, crate::theme::ThemeKind::ALL[0]);
            let mut out = ctx.run_ui(egui::RawInput::default(), |ui| super::title_bar(app, ui));
            out.textures_delta.clear();
            let mut texts = Vec::new();
            for shape in &out.shapes {
                collect_text(&shape.shape, &mut texts);
            }
            texts
        };
        assert!(texts(&mut app).iter().any(|t| t.contains("foo.psd")), "shown by default");
        app.session.prefs.edit(|p| p.interface.show_file_name_in_title = false);
        let hidden = texts(&mut app);
        assert!(!hidden.iter().any(|t| t.contains("foo.psd")), "file name hidden: {hidden:?}");
        assert!(hidden.iter().any(|t| t.contains("Pigment")), "app name kept: {hidden:?}");
    }

    #[test]
    fn system_mode_hides_the_mark_and_the_centred_title() {
        for custom in [true, false] {
            let mut app = app(custom);
            open_named(&mut app, "foo.psd");
            let ctx = egui::Context::default();
            crate::PhotocraftApp::setup_context(&ctx, crate::theme::ThemeKind::ALL[0]);
            let out = ctx.run_ui(egui::RawInput::default(), |ui| super::title_bar(&mut app, ui));
            let mut out = out;
            out.textures_delta.clear();
            let mut texts = Vec::new();
            for shape in &out.shapes {
                collect_text(&shape.shape, &mut texts);
            }
            let system = system_title_bar(&app);
            assert_eq!(system, !custom && !cfg!(target_os = "macos"));
            assert_eq!(crate::brand::mark_rect(&ctx).is_some(), !system, "mark in system mode (custom={custom})");
            assert_eq!(texts.iter().any(|t| t.contains("foo.psd")), !system, "centred title in system mode (custom={custom}): {texts:?}");
        }
    }

    fn collect_text(shape: &egui::Shape, out: &mut Vec<String>) {
        match shape {
            egui::Shape::Text(t) => out.push(t.galley.text().to_string()),
            egui::Shape::Vec(shapes) => shapes.iter().for_each(|s| collect_text(s, out)),
            _ => {}
        }
    }

    #[test]
    fn sync_window_title_sends_only_on_change() {
        let mut app = app(true);
        let ctx = egui::Context::default();
        crate::PhotocraftApp::setup_context(&ctx, crate::theme::ThemeKind::ALL[0]);
        super::sync_window_title(&mut app, &ctx);
        assert_eq!(app.last_window_title, "Pigment");
        let mut out = ctx.run_ui(egui::RawInput::default(), |_| {});
        out.textures_delta.clear();
        let cmds = out.viewport_output.remove(&egui::ViewportId::ROOT).map(|v| v.commands).unwrap_or_default();
        assert!(cmds.iter().any(|c| matches!(c, egui::ViewportCommand::Title(t) if t == "Pigment")), "{cmds:?}");
        // Same document state again: the cached title stops a repeat command.
        super::sync_window_title(&mut app, &ctx);
        let mut out = ctx.run_ui(egui::RawInput::default(), |_| {});
        out.textures_delta.clear();
        let cmds = out.viewport_output.remove(&egui::ViewportId::ROOT).map(|v| v.commands).unwrap_or_default();
        assert!(!cmds.iter().any(|c| matches!(c, egui::ViewportCommand::Title(_))), "repeat Title: {cmds:?}");
        open_named(&mut app, "foo.psd");
        super::sync_window_title(&mut app, &ctx);
        assert_eq!(app.last_window_title, "foo.psd \u{2014} Pigment");
    }
}

/// Whether blend mode `m` starts one of the groups Photoshop's blend mode lists draw a line above:
/// Normal, Dissolve (and Pass Through, Clear) | darken | lighten | contrast | difference | colour
/// (#5532). The first mode of a list never gets a line.
pub(crate) fn starts_blend_group(m: BlendMode) -> bool {
    matches!(m, BlendMode::Darken | BlendMode::Lighten | BlendMode::Overlay | BlendMode::Difference | BlendMode::Hue)
}

fn label(ui: &mut egui::Ui, s: &str) {
    let t = Tokens::get(ui.ctx());
    ui.label(RichText::new(s).color(t.text_dim));
}

#[cfg(test)]
mod navigator_wheel_tests {
    use super::*;
    use egui::{Event, Modifiers, MouseWheelUnit, RawInput, TouchPhase};

    /// The painted viewport follows the camera visible on the canvas, including preference changes.
    #[test]
    fn navigator_viewport_follows_the_displayed_camera_during_animation() {
        let mut app = PhotocraftApp::new(photocraft_engine::Session::new(), crate::Services::default());
        app.run("file.new", json!({"width": 200, "height": 100})).unwrap();
        app.sync_views();
        app.last_canvas_rect = Rect::from_min_size(Pos2::ZERO, vec2(80.0, 60.0));
        let ctx = egui::Context::default();
        PhotocraftApp::setup_context(&ctx, crate::theme::ThemeKind::ALL[0]);
        for _ in 0..3 {
            frame(&mut app, &ctx, pos2(5.0, 5.0), 0.0);
        }
        for (animating, enabled, displayed) in [
            (true, true, Some((2.0, [70.0, 40.0]))),
            (true, true, Some((3.0, [110.0, 50.0]))),
            (false, true, Some((2.0, [70.0, 40.0]))),
            (true, false, Some((2.0, [70.0, 40.0]))),
            (true, true, None),
        ] {
            app.run("prefs.set", json!({"values": {"general.animatedZoom": enabled}})).unwrap();
            let v = &mut app.ui.views[0];
            v.zoom = 4.0;
            v.center = [140.0, 60.0];
            v.zoom_animating = animating;
            v.display_camera = displayed;
            let mut out = ctx.run_ui(RawInput { screen_rect: Some(Rect::from_min_size(Pos2::ZERO, vec2(430.0, 460.0))), ..Default::default() }, |ui| {
                navigator(&mut app, ui)
            });
            let painted = out
                .shapes
                .iter()
                .find_map(|s| match &s.shape {
                    egui::Shape::Rect(r) if r.stroke.color == Color32::from_rgb(255, 84, 84) => Some(r.rect),
                    _ => None,
                })
                .expect("Navigator viewport outline");
            let (zoom, center) = if animating && enabled { displayed.unwrap_or((4.0, [140.0, 60.0])) } else { (4.0, [140.0, 60.0]) };
            let preview = last_navigator_preview(&ctx).unwrap();
            let scale = preview.width() / 200.0;
            let expected_center = preview.min + vec2(center[0], center[1]) * scale;
            let expected_size = vec2(80.0 / app.ui.view.display_aspect(), 60.0) * (app.canvas_ppp() / zoom * scale);
            assert!((painted.center() - expected_center).length() < 0.01, "{animating}/{enabled}/{displayed:?}: {painted:?}");
            assert!((painted.size() - expected_size).length() < 0.01, "{animating}/{enabled}/{displayed:?}: {painted:?}");
            out.textures_delta.clear();
        }
    }

    fn frame(app: &mut PhotocraftApp, ctx: &egui::Context, pointer: Pos2, wheel: f32) {
        let mut events = vec![Event::PointerMoved(pointer)];
        if wheel != 0.0 {
            events.push(Event::MouseWheel {
                source: egui::MouseWheelSource::Unknown,
                unit: MouseWheelUnit::Line,
                delta: vec2(0.0, wheel),
                phase: TouchPhase::Move,
                modifiers: Modifiers::NONE,
            });
        }
        let mut out = ctx
            .run_ui(RawInput { screen_rect: Some(Rect::from_min_size(Pos2::ZERO, vec2(430.0, 460.0))), events, ..Default::default() }, |ui| navigator(app, ui));
        out.textures_delta.clear();
    }

    #[test]
    fn navigator_wheel_changes_zoom_only_when_over_preview() {
        let mut app = PhotocraftApp::new(photocraft_engine::Session::new(), crate::Services::default());
        app.run("file.new", json!({"width": 200, "height": 100})).unwrap();
        app.sync_views();
        app.ui.views[0].zoom = 1.0;
        app.ui.views[0].fit_pending = false;
        // Animated Zoom off: a notch is one instant step, so one frame shows the whole ×1.1.
        app.session.edit_prefs(|p| p.general.animated_zoom = false);
        let ctx = egui::Context::default();
        PhotocraftApp::setup_context(&ctx, crate::theme::ThemeKind::ALL[0]);
        crate::wheel_nav::configure(&ctx);
        frame(&mut app, &ctx, pos2(50.0, 55.0), 0.0);
        let center = app.ui.views[0].center;
        frame(&mut app, &ctx, pos2(50.0, 55.0), 1.0);
        assert!((app.ui.views[0].zoom - 1.1).abs() < 1e-4, "one wheel notch zooms once");
        assert_eq!(app.ui.views[0].center, center, "Navigator wheel must not pan");
        frame(&mut app, &ctx, pos2(50.0, 55.0), -1.0);
        assert!((app.ui.views[0].zoom - 1.0).abs() < 1e-4);
        // Below the preview (it now fills the group, #2726): over the zoom controls.
        let below = last_navigator_controls(&ctx).map_or(pos2(50.0, 455.0), |r| pos2(r.left() + 4.0, r.bottom() - 2.0));
        frame(&mut app, &ctx, below, 1.0);
        assert!((app.ui.views[0].zoom - 1.0).abs() < 1e-4, "wheel outside preview leaves zoom unchanged");
    }

    /// #6872: the zoom a Navigator ⌘/Ctrl-drag sets: the rectangle fills the canvas, centred.
    #[test]
    fn navigator_zoom_to_fits_the_rectangle_in_the_canvas() {
        let fresh = || crate::state::View { doc_size: [200, 100], zoom: 1.0, center: [100.0, 50.0], ..Default::default() };
        let canvas = vec2(800.0, 600.0);
        let r = Rect::from_min_max(pos2(50.0, 25.0), pos2(100.0, 50.0));
        // 50 × 25 px on 800 × 600 pt: the width limits it, 16 points per pixel.
        let mut v = fresh();
        navigator_zoom_to(&mut v, r, [200, 100], canvas, 1.0, 1.0);
        assert_eq!((v.zoom, v.center, v.fit_pending), (crate::zoom_levels::clamp(16.0, [200, 100]), [75.0, 37.5], false));
        // Device pixels per point and a 2:1 pixel aspect scale it as the canvas shows pixels.
        let mut v = fresh();
        navigator_zoom_to(&mut v, r, [200, 100], canvas, 2.0, 2.0);
        assert_eq!(v.zoom, crate::zoom_levels::clamp(16.0, [200, 100]), "8 points per pixel across, at 2 device pixels per point");
        // Off the document: only the part on it counts.
        let mut v = fresh();
        navigator_zoom_to(&mut v, Rect::from_min_max(pos2(150.0, 50.0), pos2(400.0, 300.0)), [200, 100], canvas, 1.0, 1.0);
        assert_eq!(v.center, [175.0, 75.0]);
        // Under 2 px across: one step in on its centre.
        let mut v = fresh();
        navigator_zoom_to(&mut v, Rect::from_min_max(pos2(10.0, 10.0), pos2(11.0, 40.0)), [200, 100], canvas, 1.0, 1.0);
        assert_eq!((v.zoom, v.center), (crate::zoom_levels::step(1.0, 1, [200, 100]), [10.5, 25.0]));
        // Not a number, or wholly off the document: nothing changes.
        for bad in [Rect::from_min_max(pos2(f32::NAN, 0.0), pos2(10.0, 10.0)), Rect::from_min_max(pos2(300.0, 300.0), pos2(400.0, 400.0))] {
            let mut v = fresh();
            navigator_zoom_to(&mut v, bad, [200, 100], canvas, 1.0, 1.0);
            assert_eq!((v.zoom, v.center), (1.0, [100.0, 50.0]), "{bad:?}");
        }
    }

    /// One frame of the Navigator with pointer `events` and `modifiers` held.
    fn frame_with(app: &mut PhotocraftApp, ctx: &egui::Context, modifiers: Modifiers, mut events: Vec<Event>) {
        events.insert(0, Event::ModifiersChanged(modifiers));
        let input = RawInput { screen_rect: Some(Rect::from_min_size(Pos2::ZERO, vec2(430.0, 460.0))), events, ..Default::default() };
        ctx.run_ui(input, |ui| navigator(app, ui)).textures_delta.clear();
    }

    /// A drag over the Navigator's preview between document points `from` and `to`.
    fn drag(app: &mut PhotocraftApp, ctx: &egui::Context, modifiers: Modifiers, from: [f32; 2], to: [f32; 2]) {
        let preview = last_navigator_preview(ctx).expect("the preview");
        let s = preview.width() / 200.0;
        let at = |p: [f32; 2]| preview.min + vec2(p[0], p[1]) * s;
        let (a, b) = (at(from), at(to));
        let button = |pos, pressed| Event::PointerButton { pos, button: egui::PointerButton::Primary, pressed, modifiers };
        frame_with(app, ctx, modifiers, vec![Event::PointerMoved(a), button(a, true)]);
        frame_with(app, ctx, modifiers, vec![Event::PointerMoved(a.lerp(b, 0.5))]);
        frame_with(app, ctx, modifiers, vec![Event::PointerMoved(b)]);
        frame_with(app, ctx, modifiers, vec![button(b, false)]);
        frame_with(app, ctx, Modifiers::NONE, vec![]);
    }

    /// #6872: ⌘/Ctrl-dragging a rectangle over the preview zooms the view to it, as in
    /// Photoshop; a plain drag still only moves the view.
    #[test]
    fn navigator_command_drag_zooms_to_the_rectangle() {
        let mut app = PhotocraftApp::new(photocraft_engine::Session::new(), crate::Services::default());
        app.run("file.new", json!({"width": 200, "height": 100})).unwrap();
        app.sync_views();
        app.ui.views[0].zoom = 1.0;
        app.ui.views[0].fit_pending = false;
        let ctx = egui::Context::default();
        PhotocraftApp::setup_context(&ctx, crate::theme::ThemeKind::ALL[0]);
        // The preview settles once the zoom row under it has been measured.
        for _ in 0..3 {
            frame(&mut app, &ctx, pos2(5.0, 5.0), 0.0);
        }
        // A plain drag pans and keeps the zoom.
        drag(&mut app, &ctx, Modifiers::NONE, [50.0, 25.0], [100.0, 50.0]);
        assert_eq!(app.ui.views[0].zoom, 1.0);
        let c = app.ui.views[0].center;
        assert!((c[0] - 100.0).abs() < 1.0 && (c[1] - 50.0).abs() < 1.0, "the view follows the pointer: {c:?}");
        // Finishing direct navigation during an existing zoom must snap to the new target.
        let v = &mut app.ui.views[0];
        v.zoom = 2.0;
        v.request_zoom_animation(true);
        v.display_camera = Some((1.5, c));
        v.zoom_transition = Some(crate::state::ZoomTransition { from: (1.0, c), target: (v.zoom, c), started: 0.0 });
        v.zoom_anchor = Some(([50.0, 25.0], [200.0, 150.0]));
        // ⌘/Ctrl-drag: the rectangle fills the canvas (`last_canvas_rect`, 800 × 600 pt).
        drag(&mut app, &ctx, Modifiers::COMMAND, [50.0, 25.0], [100.0, 50.0]);
        let mut expected = app.ui.views[0].clone();
        navigator_zoom_to(
            &mut expected,
            Rect::from_min_max(pos2(50.0, 25.0), pos2(100.0, 50.0)),
            [200, 100],
            vec2(800.0, 600.0),
            app.canvas_ppp(),
            app.ui.view.display_aspect(),
        );
        let v = &app.ui.views[0];
        assert!((v.zoom - expected.zoom).abs() / expected.zoom < 0.05, "{} vs {}", v.zoom, expected.zoom);
        assert!(
            (v.center[0] - 75.0).abs() < 1.0 && (v.center[1] - 37.5).abs() < 1.0,
            "centred on the rectangle: {:?} (zoom {}, expected {:?})",
            v.center,
            v.zoom,
            (expected.zoom, expected.center)
        );
        assert!(v.zoom > 1.0 && !v.fit_pending);
        assert!(!v.zoom_animating && v.zoom_transition.is_none() && v.zoom_anchor.is_none(), "direct navigation cancels the old transition");
        assert_eq!(v.display_camera, Some((v.zoom, v.center)), "the selected rectangle is displayed immediately");
        assert!(ctx.data(|d| d.get_temp::<Pos2>(navigator_zoom_drag_id())).is_none(), "the drag is over");
    }

    /// #4840: under the preview, one row as in Photoshop: the zoom in percent, Zoom Out, the
    /// slider and Zoom In. The buttons step the zoom like View › Zoom In / Out.
    #[test]
    fn navigator_zoom_row_is_one_line_and_its_buttons_step_the_zoom() {
        use egui_kittest::kittest::Queryable;
        let mut app = PhotocraftApp::new(photocraft_engine::Session::new(), crate::Services::default());
        app.run("file.new", json!({"width": 200, "height": 100})).unwrap();
        app.sync_views();
        app.ui.views[0].zoom = 1.0;
        app.ui.views[0].fit_pending = false;
        let mut h = egui_kittest::Harness::builder().with_size(vec2(360.0, 300.0)).build_ui_state(|ui, app: &mut PhotocraftApp| navigator(app, ui), app);
        PhotocraftApp::setup_context(&h.ctx, crate::theme::ThemeKind::ALL[0]);
        h.run_steps(4);
        let row = last_navigator_controls(&h.ctx).expect("the zoom row");
        assert!(row.height() <= NAV_ROW_H + 14.0, "one row (with the gap above it): {row:?}");
        let zoom = |h: &egui_kittest::Harness<'_, PhotocraftApp>| h.state().ui.views[0].zoom;
        h.get_by_label("Zoom In").click();
        h.run_steps(2);
        assert!((zoom(&h) - crate::zoom_levels::step(1.0, 1, [200, 100])).abs() < 1e-4, "{}", zoom(&h));
        h.get_by_label("Zoom Out").click();
        h.run_steps(2);
        h.get_by_label("Zoom Out").click();
        h.run_steps(2);
        assert!((zoom(&h) - crate::zoom_levels::step(1.0, -1, [200, 100])).abs() < 1e-4, "{}", zoom(&h));
        assert!(!h.state().ui.views[0].fit_pending);
    }
}

fn empty(ui: &mut egui::Ui, s: &str) {
    let t = Tokens::get(ui.ctx());
    ui.add_space(6.0);
    ui.label(RichText::new(s).color(t.text_faint));
    ui.add_space(6.0);
}

#[cfg(test)]
mod symmetry_theme_tests {
    use super::*;
    use egui_kittest::{Harness, kittest::Queryable};

    #[test]
    fn brush_pencil_and_eraser_expose_symmetry_menu_in_every_theme() {
        for kind in crate::theme::ThemeKind::ALL {
            for tool in [Tool::Brush, Tool::Pencil, Tool::Eraser] {
                let mut app = PhotocraftApp::new(photocraft_engine::Session::new(), crate::Services::default());
                app.run("file.new", json!({"width": 80, "height": 80})).unwrap();
                app.ui.tool = tool;
                let mut h = Harness::builder().with_size(vec2(1600.0, 300.0)).build_ui_state(|ui, app| options_bar(app, ui), app);
                PhotocraftApp::setup_context(&h.ctx, kind);
                h.run_steps(4);
                assert!(h.query_by_label("Set painting symmetry options").is_some(), "missing symmetry menu in {:?} for {:?}", kind, tool);
            }
        }
=======
pub use status_bar::status_bar;
pub use title_bar::{title_bar, window_title};
pub(crate) use toolbar::QUICK_MASK;
#[cfg(test)]
use toolbar::color_chips;
pub use toolbar::toolbar;

/// Photoshop's Shift+Alt letter position of blend mode `m`; `None` for the modes without a letter (Darker Color,
/// Lighter Color, Subtract, Divide) and for PhotoCraft's own extra modes.
pub(crate) fn blend_shortcut(m: BlendMode) -> Option<BlendShortcut> {
    Some(match m {
        BlendMode::Normal => BlendShortcut::Normal,
        BlendMode::Dissolve => BlendShortcut::Dissolve,
        BlendMode::PassThrough => BlendShortcut::PassThrough,
        BlendMode::Darken => BlendShortcut::Darken,
        BlendMode::Multiply => BlendShortcut::Multiply,
        BlendMode::ColorBurn => BlendShortcut::ColorBurn,
        BlendMode::LinearBurn => BlendShortcut::LinearBurn,
        BlendMode::Lighten => BlendShortcut::Lighten,
        BlendMode::Screen => BlendShortcut::Screen,
        BlendMode::ColorDodge => BlendShortcut::ColorDodge,
        BlendMode::LinearDodge => BlendShortcut::LinearDodge,
        BlendMode::Overlay => BlendShortcut::Overlay,
        BlendMode::SoftLight => BlendShortcut::SoftLight,
        BlendMode::HardLight => BlendShortcut::HardLight,
        BlendMode::VividLight => BlendShortcut::VividLight,
        BlendMode::LinearLight => BlendShortcut::LinearLight,
        BlendMode::PinLight => BlendShortcut::PinLight,
        BlendMode::HardMix => BlendShortcut::HardMix,
        BlendMode::Difference => BlendShortcut::Difference,
        BlendMode::Exclusion => BlendShortcut::Exclusion,
        BlendMode::Hue => BlendShortcut::Hue,
        BlendMode::Saturation => BlendShortcut::Saturation,
        BlendMode::Color => BlendShortcut::Color,
        BlendMode::Luminosity => BlendShortcut::Luminosity,
        _ => return None,
    })
}

/// The entry of blend mode `m` under the app's `key`, for every blend list the framework builds.
pub(crate) fn blend_entry<K>(key: K, m: BlendMode) -> BlendKeyEntry<K> {
    match blend_shortcut(m) {
        Some(s) => BlendKeyEntry::new(key, s),
        None => BlendKeyEntry::unlettered(key),
>>>>>>> theirs
    }
}

#[cfg(test)]
mod color_tests;

#[cfg(test)]
mod fx_drag_tests;

#[cfg(test)]
mod unsupported_marker_tests;

#[cfg(test)]
mod swatch_type_tests {
    use super::*;
    use egui_kittest::Harness;

    /// The Color panel only acts on an edit. A colour's round trip through the panel's models isn't
    /// exact for every colour (#D8452E isn't), and writing it back every frame would recolour
    /// selected type the moment it was selected.
    #[test]
    fn idle_color_panel_leaves_the_foreground_and_selected_type_alone() {
        let mut app = PhotocraftApp::new(photocraft_engine::Session::new(), crate::Services::default());
        app.run("file.new", json!({"width": 400, "height": 200})).unwrap();
        let id = app.run("type.create", json!({"text": "Hello world", "size": 40, "x": 20, "y": 100, "color": "#ffffff"})).unwrap()["layer"].as_u64().unwrap();
        app.run("tools.setColors", json!({"foreground": "#d8452e"})).unwrap();
        let fg = app.session.tools.foreground;
        app.ui.tool = Tool::Type;
        app.ui.text_edit = Some(crate::state::TextEdit { layer: id, document: None, caret: 0, anchor: 5, session: "s".into(), created: false, mask: false });
        let mut h = Harness::builder()
            .with_context(app.ctx().clone())
            .with_size(vec2(300.0, 300.0))
            .build_ui_state(|ui, app: &mut Box<PhotocraftApp>| crate::panels::color::panel(app, ui), app);
        h.run_steps(4);
        assert_eq!(h.state().session.tools.foreground, fg);
        let st = h.state().session.active().unwrap();
        let Some(photocraft_doc::LayerContent::Text(t)) = st.doc.layer(photocraft_doc::LayerId(id)).map(|l| &l.content) else { panic!("type layer") };
        assert_eq!(t.char_runs().len(), 1, "still one white run");
    }
}

#[cfg(test)]
mod type_flyout_tests;

#[cfg(test)]
mod clipping_indicator_tests;

#[cfg(test)]
mod mask_properties_tests;

#[cfg(test)]
mod history_panel_select_tests;
