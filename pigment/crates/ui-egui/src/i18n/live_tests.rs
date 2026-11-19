//! Behavioural checks for switching languages in a running shell.

use super::*;
use crate::prefs_ui::{apply_window, open_preferences, set_draft, window_open};
use crate::{PhotocraftApp, Services};
use craft::settings::testing::MemoryFiles;
use craft::settings::{Location, OpenOptions, SettingsStore};
use craft::ui::patterns::preferences::PrefValue;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;

/// The folder of the scratch settings store; its file lives in memory.
const DIR: &str = "/memory/photocraft";

/// Services whose preferences store reads and writes `files`. A zero debounce makes the first frame after a
/// change write it.
fn services_on(files: &Arc<MemoryFiles>) -> Services {
    let options = OpenOptions::new(Location::Dir(DIR.into())).debounce(Duration::ZERO).files(files.clone());
    Services { settings: Some(SettingsStore::<photocraft_engine::prefs::SavedPrefs>::open_with(options)), ..Default::default() }
}

/// The saved `interface.language`.
fn saved_language(files: &MemoryFiles) -> Value {
    let text = files.text(&std::path::Path::new(DIR).join("config.toml")).expect("the shell saved preferences");
    toml::from_str::<Value>(&text).expect("saved TOML")["interface"]["language"].clone()
}

/// The File menu's title as the menu bar draws it in `lang`: the translation, plus the English access key where it
/// has no Latin letter of its own ("文件(F)", #5863). Read from the drawn bar, whose rule spans all its titles.
fn file_title(lang: Lang) -> String {
    use egui::accesskit::Role;
    use egui_kittest::kittest::{NodeT, Queryable};
    with_language(lang, || {
        let app = PhotocraftApp::new(photocraft_engine::Session::new(), Services::default());
        let mut h = egui_kittest::Harness::builder()
            .with_size(egui::vec2(1200.0, 80.0))
            .with_context(app.ctx().clone())
            .build_ui_state(|ui, app: &mut Box<PhotocraftApp>| crate::menus::menu_bar(app, ui), app);
        h.run_steps(2);
        h.query_all_by_role(Role::MenuItem).next().and_then(|node| node.accesskit_node().label()).expect("the bar's first title")
    })
}

fn lang(code: &str) -> Lang {
    Lang::from_code(code).expect("registered language")
}

/// Regional locale tags (`fr-CA`, `ko-KR`, `bs-BA` …) resolve to their registered catalog, as
/// a preference and as a system tag.
#[test]
fn requested_languages_resolve_regional_preferences() {
    if !needs_catalogs() {
        return;
    }
    for (tag, code) in [
        ("en-US", "en"),
        ("zh-CN", "zh-hans"),
        ("ja-JP", "ja"),
        ("ko-KR", "ko"),
        ("ru-RU", "ru"),
        ("uk-UA", "uk"),
        ("fr-CA", "fr"),
        ("id-ID", "id"),
        ("vi-VN", "vi"),
        ("sr-RS", "sr-latn"),
        ("az-Latn-AZ", "az"),
        ("bs-BA", "bs"),
    ] {
        assert_eq!(Lang::from_pref(tag), lang(code), "{tag}");
    }
    assert_eq!(lang_from_tag("ko_KR.UTF-8"), Some(lang("ko")));
    assert_eq!(lang_from_tag("FR-fr"), Some(lang("fr")));
    assert_eq!(lang_from_tag("ko"), Some(lang("ko")));
}

/// Switching redraws the menu and persists through the settings store on restart.
#[test]
fn azerbaijani_draw_after_switching_and_restore_after_restart() {
    if !needs_catalogs() {
        return;
    }
    let code = "az";
    let file = "Fayl";
    with_language(Lang::EN, || {
        let files = Arc::new(MemoryFiles::new());
        let mut h = harness_with_services(services_on(&files));
        h.state_mut().run("prefs.set", json!({"path": "interface.language", "value": code})).expect("choose language");
        h.run_steps(4);
        assert_eq!(current(), lang(code));
        assert_eq!(tr(current(), "File"), file);
        assert!(drawn_text(&h).iter().any(|text| *text == file_title(lang(code))));
        assert_eq!(saved_language(&files), code);
        h.state_mut().run("prefs.set", json!({"path": "interface.language", "value": "en"})).expect("switch back");
        h.run_steps(4);
        assert_eq!(current(), Lang::EN);
        assert_eq!(saved_language(&files), "en");
        h.state_mut().run("prefs.set", json!({"path": "interface.language", "value": code})).expect("choose language again");
        h.run_steps(4);
        assert_eq!(saved_language(&files), code);
        drop(h);
        // The restarted shell, not the old one's drawing language, must bring Azerbaijani back.
        set_current(Lang::EN);
        let restarted = harness_with_services(services_on(&files));
        assert_eq!(restarted.state().session.prefs().interface.language, code);
        assert_eq!(current(), lang(code));
        assert!(drawn_text(&restarted).iter().any(|text| *text == file_title(lang(code))));
    });
}

<<<<<<< ours
/// Preferences draw the catalog terms verbatim and the bundled UI font covers their letters.
#[test]
fn azerbaijani_preferences_draw_terms_and_glyphs() {
    if !needs_catalogs() {
        return;
    }
    let code = "az";
    let interface = "İnterfeys";
    let light = "Açıq mövzu";
    with_language(Lang::EN, || {
        let mut h = harness();
        h.state_mut().run("prefs.set", json!({"path": "interface.language", "value": code})).expect("choose language");
        crate::prefs_ui::open_preferences(h.state_mut(), "interface");
        h.run_steps(4);
        let text = drawn_text(&h);
        for expected in [interface, light, tr(lang(code), "UI font size"), tr(lang(code), "UI scale")] {
            assert!(text.iter().any(|text| text == expected), "{code}: missing {expected:?}");
            h.ctx.fonts_mut(|fonts| {
                for c in expected.chars().chain("ƏəĞğIıİiÖöŞşÜüÇç".chars()).filter(|c| c.is_alphabetic()) {
                    assert!(fonts.has_glyph(&egui::FontId::proportional(12.0), c), "{code}: missing glyph {c}");
                }
            });
        }
    });
}

#[test]
fn ukrainian_native_app_menu_keeps_product_and_language_names() {
    if !needs_catalogs() {
        return;
    }
    with_language(Lang::EN, || {
        let h = harness();
        let layout = crate::native_menu::photocraft_layout(&crate::menus::menu_items(h.state()), lang("uk"), "uk");
        for (id, template) in [("help.about", "About {app}"), (crate::native_menu::HIDE, "Hide {app}"), ("file.exit", "Quit {app}")] {
            let label = fmt(tr(lang("uk"), template), &[("app", "Pigment")]);
            assert!(label.contains("Pigment"), "{id}: {label}");
            assert_eq!(layout.bar.find(id).map(|item| item.label.as_str()), Some(label.as_str()), "{id}");
        }
        assert_eq!(layout.bar.find("app.language.uk").map(|item| (item.label.as_str(), item.checked)), Some(("Українська", Some(true))));
    });
}

#[test]
fn ukrainian_color_picker_titles_draw_in_the_selected_language() {
    if !needs_catalogs() {
        return;
    }
    with_language(Lang::EN, || {
        for (target, title) in [("foreground", "Color Picker (Foreground Color)"), ("background", "Color Picker (Background Color)")] {
            let mut h = harness();
            h.state_mut().run("prefs.set", json!({"path": "interface.language", "value": "uk"})).unwrap();
            crate::color_picker_ui::open(h.state_mut(), target);
            h.run_steps(4);
            let expected = tr(lang("uk"), title);
            assert!(drawn_text(&h).iter().any(|text| text == expected), "missing title {expected}");
        }
    });
}

#[test]
fn ukrainian_rasterize_prompt_draws_in_the_selected_language() {
    if !needs_catalogs() {
        return;
    }
    use crate::rasterize_prompt::Kind;

    with_language(Lang::EN, || {
        let mut h = harness();
        h.state_mut().run("prefs.set", json!({"path": "interface.language", "value": "uk"})).unwrap();
        h.state_mut().run("type.create", json!({"text": "Editable text"})).unwrap();
        let layer = h.state().session.active().unwrap().active_layer.unwrap();
        crate::rasterize_prompt::open(h.state_mut(), Kind::Type, layer, crate::state::Tool::Brush, [10.0, 10.0, 1.0]);
        h.run_steps(4);
        let expected = tr(lang("uk"), Kind::Type.message());
        let text = drawn_text(&h);
        assert!(text.iter().any(|text| text == expected), "the actual dialog draws the Ukrainian warning");
    });
}

=======
>>>>>>> theirs
#[test]
fn scoped_preview_restores_language_even_after_a_panic() {
    if !needs_catalogs() {
        return;
    }
    with_language(Lang::EN, || {
        with_language(lang("fr"), || {
            assert_eq!(current(), lang("fr"));
            assert_eq!(t("Layer"), tr(lang("fr"), "Layer"));
            with_language(lang("ko"), || assert_eq!(current(), lang("ko")));
            assert_eq!(current(), lang("fr"));
        });
        let result = std::panic::catch_unwind(|| with_language(lang("ja"), || panic!("test unwind")));
        assert!(result.is_err());
        assert_eq!(current(), Lang::EN);
    });
}

#[test]
fn drawing_languages_are_isolated_between_threads() {
    if !needs_catalogs() {
        return;
    }
    with_language(lang("fr"), || {
        let thread = std::thread::spawn(|| {
            assert_eq!(current(), Lang::EN);
            with_language(lang("ko"), || assert_eq!(t("Layer"), tr(lang("ko"), "Layer")));
        });
        thread.join().expect("language thread");
        assert_eq!(current(), lang("fr"));
    });
}

#[test]
fn cjk_font_order_follows_the_selected_language() {
    if !needs_catalogs() {
        return;
    }
    for (code, han) in [("zh-hans", "Simplified"), ("ja", "Japanese"), ("ko", "Korean")] {
        with_language(lang(code), || {
            // The font stack takes the Han preference from the UI language, whatever the OS locale.
            let preferred = craft::ui::fonts::han_for_locale(crate::i18n::current().code(), crate::cjk_fonts::os_locale());
            assert_eq!(format!("{preferred:?}"), format!("Some({han})"), "{code}");
        });
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn korean_glyphs_remain_available_after_repeated_language_switches() {
    if !needs_catalogs() {
        return;
    }
    use photocraft_text::cjk::{self, CjkChar, CjkScript};
    #[cfg(target_os = "linux")]
    assert!(crate::cjk_fonts::wait_for_fontconfig_cjk_scan(), "Fontconfig CJK lookup did not finish within 10 seconds");
    if !cjk::font_files(CjkScript::Korean).iter().any(|font| font.path.is_file()) {
        eprintln!("skipping: no installed Korean font");
        return;
    }
    with_language(Lang::EN, || {
        let mut h = harness();
        let glyphs: std::collections::BTreeSet<_> =
            lang("ko").catalog_texts().flat_map(str::chars).filter(|c| cjk::classify(*c) == Some(CjkChar::Hangul)).collect();
        for code in ["zh-hans", "ja", "ko", "fr", "ko"] {
            h.state_mut().run("prefs.set", json!({"path": "interface.language", "value": code})).expect("language");
            h.run_steps(12);
            if code == "ko" {
                h.ctx.fonts_mut(|fonts| {
                    for family in [egui::FontFamily::Proportional, egui::FontFamily::Name("medium".into()), egui::FontFamily::Name("semibold".into())] {
                        let font = egui::FontId::new(12.0, family);
                        for c in &glyphs {
                            assert!(fonts.has_glyph(&font, *c), "missing Korean glyph {c} after a hot language change");
                        }
                    }
                });
            }
        }
    });
}

fn harness() -> egui_kittest::Harness<'static, Box<PhotocraftApp>> {
    harness_with_services(Services::default())
}

fn harness_with_services(services: Services) -> egui_kittest::Harness<'static, Box<PhotocraftApp>> {
    let mut harness = egui_kittest::Harness::builder().with_size(egui::vec2(1200.0, 800.0)).with_max_steps(64).build_eframe(move |cc| {
        PhotocraftApp::setup_context(&cc.egui_ctx, Default::default());
        let mut app = PhotocraftApp::with_context(cc.egui_ctx.clone(), photocraft_engine::Session::new(), services);
        app.run("file.new", json!({"name": "User layer name", "width": 64, "height": 64})).expect("new document");
        app
    });
    harness.run_steps(4);
    harness
}

/// Auto draws the detected system language on first launch while keeping the Auto preference; no or
/// unsupported system languages draw English.
#[test]
fn first_launch_renders_the_system_language_without_overwriting_auto() {
    if !needs_catalogs() {
        return;
    }
    let cases: [(&[&str], &str); 14] = [
        (&["en-US"], "en"),
        (&["zh-CN"], "zh-hans"),
        (&["ja-JP"], "ja"),
        (&["ko-KR"], "ko"),
        (&["ru-RU"], "ru"),
        (&["uk-UA"], "uk"),
        (&["fr-CA"], "fr"),
        (&["sv-SE"], "sv"),
        (&["fi-FI"], "fi"),
        (&["da-DK"], "da"),
        (&["nb-NO"], "nb"),
        (&["az-AZ"], "az"),
        (&[], "en"),
        (&["sw-KE", "is-IS"], "en"),
    ];
    for (tags, code) in cases {
        system::with_system_tags(tags, || {
            with_language(Lang::EN, || {
                let h = harness();
                assert_eq!(h.state().session.prefs().interface.language, "auto");
                assert_eq!(current(), lang(code), "{tags:?}");
                assert!(drawn_text(&h).iter().any(|text| *text == file_title(lang(code))), "first-launch menu: {tags:?}");
            });
        });
    }
}

#[test]
fn an_explicit_language_survives_restart_on_a_different_system_language() {
    if !needs_catalogs() {
        return;
    }
    let files = Arc::new(MemoryFiles::new());
    system::with_system_tags(&["ja-JP"], || {
        with_language(Lang::EN, || {
            let mut h = harness_with_services(services_on(&files));
            assert_eq!(current(), lang("ja"));
            h.state_mut().run("prefs.set", json!({"path":"interface.language","value":"ko"})).expect("choose language");
            h.step();
            assert_eq!(current(), lang("ko"));
            h.step();
            assert_eq!(saved_language(&files), "ko");
        })
    });
    system::with_system_tags(&["fr-FR"], || {
        with_language(Lang::EN, || {
            let h = harness_with_services(services_on(&files));
            assert_eq!(h.state().session.prefs().interface.language, "ko");
            assert_eq!(current(), lang("ko"));
            assert!(drawn_text(&h).iter().any(|text| *text == file_title(lang("ko"))));
        });
    });
}

#[test]
fn a_control_request_changes_the_drawing_language_in_the_same_frame() {
    if !needs_catalogs() {
        return;
    }
    with_language(Lang::EN, || {
        let mut h = harness();
        let document = h.state().session.active().expect("document").doc.clone();
        for code in ["zh-hans", "ja", "ko", "ru", "uk", "fr", "id", "en"] {
            let (tx, rx) = std::sync::mpsc::channel();
            h.state_mut().control = Some(craft::automation::ControlChannel::new(rx));
            let (request, reply) =
                crate::control::ControlRequest::new("engine.execute", json!({"command": "prefs.set", "params": {"path": "interface.language", "value": code}}));
            tx.send(request).expect("request");
            h.step();
            assert_eq!(reply.try_recv().expect("response")["ok"], true);
            assert_eq!(current(), lang(code));
            assert!(drawn_text(&h).iter().any(|text| *text == file_title(lang(code))), "the menu must change in this frame: {code}");
            assert!(std::sync::Arc::ptr_eq(&document, &h.state().session.active().expect("document").doc), "switching language must preserve the document");
        }
        assert!(h.state_mut().run("prefs.set", json!({"path": "interface.language", "value": []})).is_err());
        h.step();
        assert_eq!(current(), Lang::EN);
    });
}

/// The draft language previews inside the Preferences window only; Apply commits it.
#[test]
fn preferences_preview_does_not_commit_until_applied_and_survives_reload() {
    if !needs_catalogs() {
        return;
    }
    use egui_kittest::kittest::Queryable;
    with_language(Lang::EN, || {
        let mut h = harness();
        open_preferences(h.state_mut(), "interface");
        assert!(set_draft(h.state_mut(), "interface.language", PrefValue::Choice("fr".into())), "the window took the draft language");
        h.run_steps(3);
        let text = drawn_text(&h);
        let fr = lang("fr");
        assert!(text.iter().any(|text| text == tr(fr, "Appearance")), "the draft language must translate the visible window");
        assert!(text.iter().any(|text| text == tr(fr, "Cancel")), "the window buttons must preview the language too");
        assert!(text.iter().any(|text| text == tr(fr, "Apply")), "Apply must use the draft language without committing it");
        assert!(text.iter().any(|text| text == "File"), "the main window keeps its committed language");
        assert_eq!(h.state().session.prefs().interface.language, "auto");
        assert_eq!(current(), Lang::EN, "preview must not leak to the main window");
        // Cancel drops the draft and the preview.
        h.get_by_label(tr(fr, "Cancel")).click();
        h.run_steps(3);
        assert!(!window_open(h.state()));
        assert_eq!(h.state().session.prefs().interface.language, "auto");
        assert_eq!(current(), Lang::EN);
        open_preferences(h.state_mut(), "interface");
        assert!(set_draft(h.state_mut(), "interface.language", PrefValue::Choice("ko".into())));
        apply_window(h.state_mut()).expect("apply");
        assert_eq!(h.state().session.prefs().interface.language, "ko", "Apply commits the selected language");
        h.step();
        assert_eq!(current(), lang("ko"));
        let saved = h.state().session.prefs_to_json();
        let mut restored = photocraft_engine::Session::new();
        restored.load_prefs_json(&saved).expect("reload preferences");
        assert_eq!(restored.prefs().interface.language, "ko");
    });
}

fn drawn_text(h: &egui_kittest::Harness<'_, Box<PhotocraftApp>>) -> Vec<String> {
    fn collect(shape: &egui::Shape, text: &mut Vec<String>) {
        match shape {
            egui::Shape::Text(shape) => text.push(shape.galley.job.text.clone()),
            egui::Shape::Vec(shapes) => shapes.iter().for_each(|shape| collect(shape, text)),
            _ => {}
        }
    }
    let mut text = Vec::new();
    for shape in &h.output().shapes {
        collect(&shape.shape, &mut text);
    }
    text
}
<<<<<<< ours

#[test]
fn czech_status_notices_and_navigator_draw_translated_text() {
    if !needs_catalogs() {
        return;
    }
    with_language(Lang::EN, || {
        let mut h = harness();
        h.state_mut().run("prefs.set", json!({"path": "interface.language", "value": "cs"})).expect("language");
        h.state_mut().ui.panels.navigator = true;
        h.run_steps(4);
        with_language(lang("cs"), || {
            h.state_mut().open_failed("English file.psd", "disk full");
            crate::notices::post(
                h.state_mut(),
                "Preferences can't be saved",
                vec!["Pigment keeps retrying; until a save succeeds, preference changes are lost when it closes.".into()],
                true,
                None,
            );
            let info = crate::gpu_canvas::GpuInfo { driver: "Mesa 25.0".into(), ..Default::default() };
            assert!(info.lines().iter().any(|line| *line == fmt(tr(lang("cs"), "Driver: {driver}"), &[("driver", "Mesa 25.0")])));
        });
        h.run_steps(4);
        let text = drawn_text(&h);
        let cs = lang("cs");
        // The Navigator's own text is its tab title now: its zoom row has no label (#4840).
        for want in [
            tr(cs, "Navigator").to_string(),
            fmt(tr(cs, "Couldn't open {name}: {error}"), &[("name", "English file.psd"), ("error", "disk full")]),
            tr(cs, "Preferences can't be saved").to_string(),
        ] {
            assert!(text.contains(&want), "missing {want}: {text:?}");
        }
        // Czech text must be drawable by the bundled fonts, including the new notices.
        let chars: std::collections::BTreeSet<_> = text.iter().flat_map(|s| s.chars()).filter(|c| !c.is_whitespace()).collect();
        h.ctx.fonts_mut(|fonts| {
            let font = egui::FontId::proportional(12.0);
            for c in chars {
                assert!(fonts.has_glyph(&font, c), "missing glyph {c}");
            }
        });
    });
}

#[test]
fn czech_shortcut_conflicts_keep_warning_state_and_shortcut_codes() {
    if !needs_catalogs() {
        return;
    }
    with_language(Lang::EN, || {
        let mut h = harness();
        h.state_mut().run("prefs.set", json!({"path": "interface.language", "value": "cs"})).expect("language");
        let ctx = h.ctx.clone();
        let result = crate::menus::invoke(h.state_mut(), &ctx, "edit.keyboardShortcuts", json!({})).expect("shortcut dialog");
        let id = result["dialog"].as_u64().expect("dialog id");
        h.run_steps(4);
        let fields = &mut h.state_mut().ui.dialogs.iter_mut().find(|d| d.id == id).expect("dialog").fields;
        fields.insert("selected".into(), json!("file.new"));
        fields.insert("capture".into(), json!(true));
        let mods = egui::Modifiers { ctrl: true, command: true, ..Default::default() };
        h.event(egui::Event::Key { key: egui::Key::O, physical_key: None, pressed: true, repeat: false, modifiers: mods });
        h.event(egui::Event::Key { key: egui::Key::O, physical_key: None, pressed: false, repeat: false, modifiers: mods });
        h.run_steps(4);
        let fields = &h.state().ui.dialogs.iter().find(|d| d.id == id).expect("dialog").fields;
        assert_eq!(fields["messageWarning"], json!(true));
        let message = fields["message"].as_str().expect("message");
        let template = tr(lang("cs"), "{shortcut} is already in use by {commands} and will be removed from it when you click OK.");
        // The message is the conflict template, filled in: its fixed text appears around the shortcut and commands.
        for piece in template.split('{').map(|piece| piece.split_once('}').map_or(piece, |(_, rest)| rest)).filter(|piece| !piece.trim().is_empty()) {
            assert!(message.contains(piece), "{message:?} lacks {piece:?}");
        }
        assert_eq!(fields["overrides"]["file.new"], json!("Cmd+O"));
    });
}

/// The catalog stays in logical order: egui puts a right-to-left label into display order itself,
/// so the first word of an Arabic label lands to the right of its last, and a Latin brand name at
/// the end of the sentence lands at the left.
#[test]
fn arabic_labels_are_laid_out_right_to_left() {
    if !needs_catalogs() {
        return;
    }
    with_language(Lang::EN, || {
        let mut h = harness();
        h.state_mut().run("prefs.set", json!({"path": "interface.language", "value": "ar"})).unwrap();
        h.run_steps(4);
        let x_of = |text: &str, c: char| {
            let galley = h.ctx.fonts_mut(|f| f.layout_no_wrap(text.to_string(), egui::FontId::proportional(13.0), egui::Color32::WHITE));
            galley.rows.iter().flat_map(|r| r.glyphs.iter()).find(|g| g.chr == c).map(|g| g.pos.x).expect("glyph")
        };
        let label = tr(lang("ar"), "No properties");
        assert_eq!(label, "لا توجد خصائص");
        assert!(x_of(label, 'ل') > x_of(label, 'ص'), "{label}: first word at the right");
        let join = tr(lang("ar"), "Join us on Discord");
        assert!(x_of(join, 'D') < x_of(join, 'ن'), "{join}: Discord at the left");
    });
}

/// #5159 on egui 0.37: user names are handed to egui as typed, and egui orders the words. An
/// Arabic layer name reads from the right; the title line keeps "— PhotoCraft" at the right of a
/// right-to-left document name.
#[test]
fn arabic_names_are_laid_out_right_to_left() {
    with_language(Lang::EN, || {
        let h = harness();
        let font = egui::FontId::proportional(13.0);
        let x_in = |galley: &egui::Galley, c: char| galley.rows.iter().flat_map(|r| r.glyphs.iter()).find(|g| g.chr == c).map(|g| g.pos.x).expect("glyph");
        let name = "لاشي مكتوب هنا";
        let galley = h.ctx.fonts_mut(|f| f.layout_no_wrap(name.to_string(), font.clone(), egui::Color32::WHITE));
        assert!(x_in(&galley, 'ل') > x_in(&galley, 'ه'), "{name}: first word at the right");
        let title = "لاشي مكتوب.png — Pigment";
        let job = crate::panels::title_bar::title_job(title, font, egui::Color32::WHITE);
        let galley = h.ctx.fonts_mut(|f| f.layout_job(job));
        assert!(x_in(&galley, 'ل') > x_in(&galley, 'م'), "{title}: the name's first word right of its second");
        assert!(x_in(&galley, 'P') > x_in(&galley, 'ل'), "{title}: Pigment stays at the right");
    });
}
=======
>>>>>>> theirs
