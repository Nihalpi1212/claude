use super::*;
use crate::new_doc_remember_tests::{app, fields, harness, open, press_create};
use egui_kittest::kittest::Queryable;

/// The default settings with `edit` applied.
fn options(edit: impl FnOnce(&mut DocumentOptions)) -> DocumentOptions {
    let mut options = DocumentOptions::default();
    edit(&mut options);
    options
}

/// #321: New Document offers the working space and the other profiles of the mode's space.
#[test]
fn color_profile_menu_lists_the_profiles_of_the_modes_space() {
    use craft::cms::Builtin;
    let app = app();
    let lists = profiles(&app);
    let of = |mode: DialogMode| lists.iter().find(|p| p.mode == mode).unwrap_or_else(|| panic!("{mode:?} has a list"));
    let rgb = of(DialogMode::Rgb);
    assert_eq!(rgb.working, app.session.color.working(photocraft_color::ColorMode::Rgb).description);
    assert!(rgb.others.contains(&Builtin::AdobeRgbCompat.id().to_string()));
    assert!(!rgb.others.contains(&Builtin::CoatedCmyk.id().to_string()));
    let cmyk = of(DialogMode::Cmyk);
    assert!(cmyk.others.contains(&Builtin::CoatedCmyk.id().to_string()) && !cmyk.others.contains(&Builtin::Srgb.id().to_string()));
    // Every built-in entry is one `file.new` takes for that mode; an installed one is a path.
    for list in &lists {
        let mode = create_params(&options(|o| o.color_mode = list.mode))["mode"].clone();
        for profile in list.others.iter().filter(|p| !p.ends_with(".icc")) {
            let mut s = photocraft_engine::Session::new();
            s.execute("file.new", json!({"width": 2, "height": 2, "mode": mode, "profile": profile})).unwrap_or_else(|e| panic!("{mode} {profile}: {e}"));
        }
    }
}

/// Our format at the engine boundary: what `file.new` takes for each setting, and nothing of the dialog's own.
#[test]
fn preset_sets_size_resolution_and_create_params_drop_ui_keys() {
    let table = [
        (
            options(|o| {
                o.name = "A4".into();
                o.size = PixelSize::new(2480, 3508);
                o.pixels_per_inch = 300.0;
                o.unit = UnitKind::Inches;
                o.resolution_unit = UnitKind::PixelsPerCentimetre;
            }),
            json!({"name": "A4", "width": 2480, "height": 3508, "resolution": 300.0, "mode": "rgb", "depth": 8, "background": "white", "artboard": false}),
        ),
        (
            options(|o| {
                o.color_mode = DialogMode::Cmyk;
                o.depth = BitDepth::Sixteen;
                o.background = BackgroundContents::Transparent;
                o.profile = Some("coated-cmyk".into());
                o.artboard = true;
            }),
            json!({"name": "", "width": 2100, "height": 1500, "resolution": 300.0, "mode": "cmyk", "depth": 16, "background": "transparent", "artboard": true, "profile": "coated-cmyk"}),
        ),
        (
            options(|o| {
                o.color_mode = DialogMode::Grayscale;
                o.depth = BitDepth::ThirtyTwo;
                o.background = BackgroundContents::Custom([1.0, 0.0, 0.0]);
            }),
            json!({"name": "", "width": 2100, "height": 1500, "resolution": 300.0, "mode": "gray", "depth": 32, "background": "#ff0000", "artboard": false}),
        ),
        (
            options(|o| {
                o.color_mode = DialogMode::Lab;
                o.background = BackgroundContents::BackgroundColor;
            }),
            json!({"name": "", "width": 2100, "height": 1500, "resolution": 300.0, "mode": "lab", "depth": 8, "background": "backgroundColor", "artboard": false}),
        ),
        (
            options(|o| o.background = BackgroundContents::Black),
            json!({"name": "", "width": 2100, "height": 1500, "resolution": 300.0, "mode": "rgb", "depth": 8, "background": "black", "artboard": false}),
        ),
    ];
    for (settings, expected) in table {
        let params = create_params(&settings);
        assert_eq!(params, expected);
        let mut s = photocraft_engine::Session::new();
        s.execute("file.new", params).unwrap_or_else(|e| panic!("{expected}: {e}"));
        let d = &s.active().unwrap().doc;
        assert_eq!((d.size.width, d.size.height, d.resolution_dpi), (settings.size.width, settings.size.height, settings.pixels_per_inch as f32));
        assert_eq!(d.artboards().len(), usize::from(settings.artboard));
    }
    // The stored form adds the display units, drops the name and the artboard, and reads back as the same document.
    let settings = options(|o| {
        o.size = PixelSize::new(1600, 800);
        o.pixels_per_inch = 254.0;
        o.unit = UnitKind::Millimetres;
        o.resolution_unit = UnitKind::PixelsPerCentimetre;
        o.color_mode = DialogMode::Cmyk;
        o.background = BackgroundContents::Custom([0.0, 1.0, 0.0]);
    });
    let stored = to_settings(&settings);
    assert_eq!((&stored["unit"], &stored["resolutionUnit"]), (&json!("mm"), &json!("cm")));
    assert!(stored.get("name").is_none() && stored.get("artboard").is_none());
    let read: DocumentSettings = serde_json::from_value(stored).unwrap();
    assert_eq!(to_options(&read), settings);
    // A Background Color stored with its captured colour (a preset saved before the port) keeps that colour; one without follows the toolbox.
    let captured = DocumentSettings { background: "backgroundColor".into(), background_color: Some([0.1, 0.2, 0.3]), ..read.clone() };
    assert_eq!(to_options(&captured).background, BackgroundContents::Custom([0.1, 0.2, 0.3]));
    let following = DocumentSettings { background: "backgroundColor".into(), background_color: None, ..read };
    assert_eq!(to_options(&following).background, BackgroundContents::BackgroundColor);
}

/// #4789: the swatch beside Background Contents opens the Color Picker; its colour becomes the new document's
/// background.
#[test]
fn a_custom_background_color_is_picked_and_used() {
    let mut h = harness(app());
    let id = open(&mut h);
    h.get_by_label("Custom background color").click();
    h.run_steps(3);
    let opened = h.state().framework.dialogs.open_dialogs();
    let picker = opened.iter().find(|d| d.id != id).map(|d| d.id).expect("the Color Picker opens over the dialog");
    assert_eq!(opened.len(), 2);
    let ctx = h.ctx.clone();
    h.state_mut().framework.dialogs.set_json_field(&ctx, picker, "color", json!("#336699")).unwrap();
    crate::dialogs::confirm(h.state_mut(), &ctx, picker).expect("OK is enabled");
    h.run_steps(3);
    assert!(matches!(crate::new_doc_remember_tests::options(h.state(), id).background, BackgroundContents::Custom(_)), "{}", fields(h.state(), id));
    assert!(press_create(&mut h, id));
    let doc = &h.state().session.active().unwrap().doc;
    let px = photocraft_compose::flatten(doc).px[0];
    assert!((px[0] * 255.0 - 51.0).abs() < 1.0 && (px[1] * 255.0 - 102.0).abs() < 1.0 && (px[2] * 255.0 - 153.0).abs() < 1.0, "{px:?}");
}

/// Saving and deleting a preset in the dialog reach the engine's store, which keeps them across a restart and
/// gives them back in the next dialog's Saved tab.
#[test]
fn save_restart_select_create_and_delete_through_the_dialog() {
    let mut h = harness(app());
    let id = open(&mut h);
    // The icon beside Name opens the naming pane with its proposed name selected, so typing replaces it.
    h.get_by_label("Save Document Preset").click();
    h.run_steps(3);
    h.event(egui::Event::Text("Wide".into()));
    h.run_steps(1);
    h.get_by_label("Save Preset").click();
    h.run_steps(3);
    let stored = h.state().session.presets.documents.clone();
    assert_eq!(stored.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["Wide"]);
    let size = (stored[0].settings.width, stored[0].settings.height);
    assert_eq!(size, (1920, 1080), "the dialog's settings are stored");

    // A restart: the preset comes back from the preferences into the next dialog's library.
    let mut restarted = photocraft_engine::Session::new();
    restarted.load_prefs_json(&h.state().session.prefs_to_json()).unwrap();
    let mut h2 = harness(PhotocraftApp::new(restarted, crate::Services::default()));
    let id2 = open(&mut h2);
    let library = h2
        .state()
        .framework
        .dialogs
        .get_by_id::<HostedNewDocument>(id2)
        .expect("the dialog is open")
        .saved_presets()
        .items()
        .into_iter()
        .map(|i| i.name.clone())
        .collect::<Vec<_>>();
    assert_eq!(library, ["Wide"]);
    assert_eq!(fields(h2.state(), id2)["preset"], "Wide", "the dialog opens on the saved preset's card");

    // Delete it in the first dialog: the engine drops it too.

    assert_eq!(fields(h.state(), id)["tab"], "saved", "a saved preset opens the Saved tab");
    h.get_by_label("Delete").click();
    h.run_steps(3);
    assert!(h.state().session.presets.documents.is_empty());
}

/// Opens New Document, applies `edit` to the settings it shows and presses Create.
fn create_with(h: &mut crate::new_doc_remember_tests::AppHarness, edit: impl FnOnce(&mut DocumentOptions)) {
    let id = open(h);
    let mut shown = crate::new_doc_remember_tests::options(h.state(), id);
    edit(&mut shown);
    crate::new_doc_remember_tests::set_options(h, id, &shown);
    assert!(press_create(h, id), "Create is enabled");
}

/// #14030: Create with Bitmap makes a 1-bit Bitmap document, and the created settings become the first Recent card.
#[test]
fn create_makes_a_bitmap_document() {
    let mut h = harness(app());
    create_with(&mut h, |o| {
        o.size = PixelSize::new(32, 24);
        o.color_mode = DialogMode::Bitmap;
        o.depth = BitDepth::One;
        o.background = BackgroundContents::Black;
    });
<<<<<<< ours
    out.textures_delta.clear();
}

#[test]
fn recent_category_lists_clipboard_then_created_documents_then_uncovered_defaults() {
    let settings = |w, h, ppi| DocumentSettings {
        width: w,
        height: h,
        resolution: ppi,
        mode: "rgb".into(),
        depth: 8,
        background: "white".into(),
        background_color: None,
        profile: None,
        unit: "px".into(),
        resolution_unit: "in".into(),
    };
    let mut f = Map::new();
    set_clipboard(&mut f, 20, 30);
    let cards = recent_cards(&f, &[settings(800, 600, 72.0), settings(1920, 1080, 72.0)], &UnitsAndRulers::default());
    let titles: Vec<(&str, String)> = cards.iter().map(|c| (c.title(), c.size_line(&UnitsAndRulers::default(), &f))).collect();
    assert_eq!(
        titles,
        [
            (CLIPBOARD, "20 x 30 px @ 72 ppi".to_string()),
            ("Custom", "800 x 600 px @ 72 ppi".to_string()),
            ("HDTV 1080p", "1920 x 1080 px @ 72 ppi".to_string()),
            ("Default Pigment Size", "7 x 5 in @ 300 ppi".to_string()),
        ]
    );
    assert!(holds(&f, &settings(20, 30, 72.0)) && !holds(&f, &settings(800, 600, 72.0)));
}

#[test]
fn clipboard_preset_comes_first_and_is_selected() {
    // Nothing on the clipboard: the dialog opens as before.
    let mut app = crate::PhotocraftApp::new(photocraft_engine::Session::new(), crate::Services::default());
    let f = app.new_document_fields();
    assert_eq!(f, crate::state::UiState::new_document_fields());
    assert!(clipboard_preset(&f).is_none());
    // Pixels copied in the app: the Clipboard preset takes their size, at 72 ppi, selected.
    app.run("file.new", json!({"width": 200, "height": 100})).unwrap();
    app.run("select.rect", json!({"x": 10, "y": 20, "width": 123, "height": 45})).unwrap();
    app.run("edit.copy", json!({})).unwrap();
    let f = app.new_document_fields();
    assert_eq!(clipboard_preset(&f), Some((CLIPBOARD, 123, 45, 72.0)));
    assert_eq!((f["width"].as_u64(), f["height"].as_u64(), f["__preset"].as_str()), (Some(123), Some(45), Some(CLIPBOARD)));
    let p = command_params(&f);
    assert!(p.get("__clipboard").is_none(), "file.new never sees the dialog's keys");
    assert_eq!((p["width"].as_u64(), p["height"].as_u64(), p["resolution"].as_f64()), (Some(123), Some(45), Some(72.0)));
=======
    let doc = &h.state().session.active().expect("a document was created").doc;
    assert_eq!((doc.size.width, doc.size.height), (32, 24));
    assert_eq!(doc.mode, ColorMode::Bitmap, "not a silent RGB document");
    let recent = &h.state().session.presets.recent_documents;
    assert_eq!((recent[0].mode.as_str(), recent[0].depth, recent[0].background.as_str()), ("bitmap", 1, "black"));
    assert_eq!(to_options(&recent[0]).color_mode, DialogMode::Bitmap, "the Recent card opens on Bitmap again");
>>>>>>> theirs
}

/// #14034: Create gives View › Pixel Aspect Ratio the picked ratio, a saved custom one included, and Square Pixels
/// resets a ratio picked in the view menu before.
#[test]
<<<<<<< ours
fn preset_sets_size_resolution_and_create_params_drop_ui_keys() {
    let mut f = crate::state::UiState::new_document_fields();
    let a4 = CATEGORIES.iter().find(|c| c.0 == "Print").unwrap().1.iter().find(|p| p.0 == "A4").unwrap();
    apply_preset(&mut f, a4, &Default::default());
    let p = command_params(&f);
    assert_eq!(p["width"], 2480);
    assert_eq!(p["height"], 3508);
    assert_eq!(p["resolution"], 300.0);
    assert!(p.get("__preset").is_none() && p.get("__unit").is_none());
    let mut s = photocraft_engine::Session::new();
    s.execute("file.new", p).unwrap();
    let d = &s.active().unwrap().doc;
    assert_eq!((d.size.width, d.size.height, d.resolution_dpi), (2480, 3508, 300.0));
}

#[test]
fn saved_selection_restores_all_settings_but_keeps_the_document_name() {
    let mut session = photocraft_engine::Session::new();
    session
        .execute(
            "document.presets.save",
            json!({"name":"Print proof","settings":{
                "width":1600,"height":800,"resolution":254.0,"mode":"cmyk","depth":16,
                "background":"backgroundColor","backgroundColor":[0.2,0.3,0.4],"unit":"mm","resolutionUnit":"cm"
            }}),
        )
        .unwrap();
    let preset = session.presets.documents[0].clone();
    let mut f = crate::state::UiState::new_document_fields();
    set_clipboard(&mut f, 20, 30);
    f.insert("name".into(), json!("Catalog cover"));
    apply_saved_preset(&mut f, &preset);
    assert_eq!(f["name"], "Catalog cover");
    assert_eq!(f["__unit"], "mm");
    assert_eq!(f["__resUnit"], "cm");
    assert_eq!(f["__savedPreset"], "Print proof");
    assert!(f.get("__preset").is_none());
    assert_eq!(clipboard_preset(&f), Some((CLIPBOARD, 20, 30, 72.0)));
    let mut expected = preset.settings.command_params();
    expected["name"] = json!("Catalog cover");
    assert_eq!(command_params(&f), expected);
    f.insert("width".into(), json!(42));
    assert_eq!(session.presets.documents[0], preset, "editing the form does not edit the snapshot");
    apply_preset(&mut f, &(CLIPBOARD, 20, 30, 72.0), &Default::default());
    assert!(f.get("__savedPreset").is_none());
    assert_eq!((f["width"].as_u64(), f["height"].as_u64()), (Some(20), Some(30)));
}
/// The real dialog (#254): a typed size must reach `file.new`, however it is confirmed.
mod dialog {
    use super::super::{CATEGORIES, apply_preset};
    use crate::PhotocraftApp;
    use crate::state::{DialogKind, UiState};
    use egui::accesskit::Role;
    use egui_kittest::{Harness, kittest::Queryable};
    use std::sync::{Arc, Mutex};

    /// The real preference services, backed by an in-memory store shared across app restarts.
    fn harness_with_store(store: &Arc<Mutex<Option<String>>>) -> Harness<'static, PhotocraftApp> {
        let (read, write) = (store.clone(), store.clone());
        let services = crate::Services {
            load_prefs: Some(Box::new(move || read.lock().unwrap().clone())),
            save_prefs: Some(Box::new(move |text| {
                *write.lock().unwrap() = Some(text.to_string());
                Ok(())
            })),
            ..Default::default()
        };
        let app = PhotocraftApp::new(photocraft_engine::Session::new(), services);
        let mut h = Harness::builder().with_size(egui::vec2(1400.0, 900.0)).build_ui_state(
            |ui, app| {
                crate::prefs_ui::tick(app, ui.ctx());
                crate::dialogs::show(app, ui.ctx());
            },
            app,
        );
        PhotocraftApp::setup_context(&h.ctx, crate::theme::ThemeKind::ALL[0]);
        h.state_mut().ui.open_dialog(DialogKind::NewDocument, UiState::new_document_fields());
        h.run_steps(3);
        h
    }

    /// #4789: the swatch beside Background Contents (and Custom…) opens the Color Picker; its
    /// colour becomes the new document's background (kept as its "#rrggbb").
    #[test]
    fn a_custom_background_color_is_picked_and_used() {
        let mut h = harness_with_store(&Arc::new(Mutex::new(None)));
        let nd = h.state().ui.dialogs[0].id;
        assert!(h.query_by_label("Custom background color").is_some());
        h.get_by_label("Custom background color").click();
        h.run_steps(3);
        let picker = h
            .state()
            .ui
            .dialogs
            .iter()
            .find(|d| d.fields.get("__dialog").and_then(serde_json::Value::as_u64) == Some(nd))
            .map(|d| d.id)
            .expect("the Color Picker opens over the dialog");
        h.state_mut().ui.dialog_mut(picker).unwrap().fields.insert("color".into(), serde_json::json!("#336699"));
        crate::dialogs::confirm(h.state_mut(), picker).unwrap();
        h.run_steps(3);
        let bg = h.state().ui.dialogs.iter().find(|d| d.id == nd).unwrap().fields["background"].clone();
        assert_eq!(bg, "#336699");
        crate::dialogs::confirm(h.state_mut(), nd).unwrap();
        let doc = &h.state().session.active().unwrap().doc;
        let px = photocraft_compose::flatten(doc).px[0];
        assert!((px[0] * 255.0 - 51.0).abs() < 1.0 && (px[1] * 255.0 - 102.0).abs() < 1.0 && (px[2] * 255.0 - 153.0).abs() < 1.0, "{px:?}");
    }

    /// #4789: the swatch shows what each Background Contents choice paints, Background Color included.
    #[test]
    fn the_swatch_shows_each_background_choice() {
        let mut h = harness_with_store(&Arc::new(Mutex::new(None)));
        h.state_mut().run("tools.setColors", serde_json::json!({"foreground": "#000000", "background": "#336699"})).unwrap();
        let rgb = |bg: &str| super::super::background_rgb(h.state(), serde_json::json!({ "background": bg }).as_object().unwrap());
        assert_eq!(rgb("white"), Some([1.0; 3]));
        assert_eq!(rgb("black"), Some([0.0; 3]));
        assert_eq!(rgb("transparent"), None);
        assert_eq!(rgb("#ff0000"), Some([1.0, 0.0, 0.0]));
        let c = rgb("backgroundColor").expect("Background Color shows the toolbox colour");
        assert!((c[0] * 255.0 - 51.0).abs() < 1.0 && (c[1] * 255.0 - 102.0).abs() < 1.0 && (c[2] * 255.0 - 153.0).abs() < 1.0, "{c:?}");
    }

    fn name_preset(h: &mut Harness<'static, PhotocraftApp>, name: &str) {
        h.get_by_label("Save Preset…").click();
        h.run_steps(2);
        h.get_by_role_and_label(Role::TextInput, "Preset Name").click();
        h.run_steps(1);
        h.event(egui::Event::Text(name.into()));
        h.run_steps(1);
    }

    #[test]
    fn save_restart_select_create_and_delete_through_the_dialog() {
        let store = Arc::new(Mutex::new(None));
        let mut h = harness_with_store(&store);
        type_into(&mut h, 0, "1600");
        type_into(&mut h, 1, "1600");
        let mut f = fields(&h);
        f.insert("background".into(), serde_json::json!("transparent"));
        set_fields(&mut h, f);
        name_preset(&mut h, " Product square ");
        h.get_by_label("Save").click();
        h.run_steps(3);
        assert!(h.state().session.documents().is_empty(), "saving does not create a document");
        assert_eq!(h.state().session.presets.documents[0].name, "Product square");
        type_into(&mut h, 0, "32");
        assert_eq!(h.state().session.presets.documents[0].settings.width, 1600);
        drop(h);

        let mut h = harness_with_store(&store);
        h.get_by_label("Saved").click();
        h.run_steps(2);
        h.get_by_label("Product square").click();
        h.run_steps(2);
        assert!(h.state().session.documents().is_empty(), "selection only populates the form");
        assert_eq!(fields(&h)["name"], "Untitled-1");
        assert_eq!(fields(&h)["background"], "transparent");
        h.get_by_label("Create").click();
        h.run_steps(3);
        assert_eq!(created(&h), (1600, 1600, 72.0));
        let pixel = h.state_mut().session.execute("document.pixel", serde_json::json!({"x":0,"y":0})).unwrap();
        assert_eq!(pixel[3], 0.0);

        h.state_mut().ui.open_dialog(DialogKind::NewDocument, UiState::new_document_fields());
        h.run_steps(2);
        h.get_by_label("Saved").click();
        h.run_steps(2);
        h.get_by_label("Delete").click();
        h.run_steps(3);
        drop(h);
        let mut h = harness_with_store(&store);
        h.get_by_label("Saved").click();
        h.run_steps(2);
        assert!(h.state().session.presets.documents.is_empty());
        assert!(h.query_by_label("No saved presets yet.").is_some());
    }

    #[test]
    fn enter_saves_the_preset_and_bad_names_leave_the_form_open() {
        let mut h = harness();
        name_preset(&mut h, "Enter test");
        enter(&mut h);
        assert_eq!(h.state().session.presets.documents.len(), 1);
        assert!(h.state().session.documents().is_empty(), "Enter must not also press Create");
        assert_eq!(h.state().ui.dialogs.len(), 1);
        name_preset(&mut h, " ENTER TEST ");
        h.get_by_label("Save").click();
        h.run_steps(2);
        assert!(fields(&h).get("__presetError").is_some());
        assert_eq!(h.state().session.presets.documents.len(), 1);
        assert!(h.state().session.documents().is_empty());
        h.get_by_label("Cancel").click();
        h.run_steps(2);
        name_preset(&mut h, "");
        // Cancel keeps the entered name; clear it as an automation edit, then use the button.
        h.state_mut().ui.dialogs[0].fields.insert("__presetName".into(), serde_json::json!("   "));
        h.run_steps(2);
        h.get_by_label("Save").click();
        h.run_steps(2);
        assert!(fields(&h).get("__presetError").is_some());
        assert_eq!(h.state().session.presets.documents.len(), 1);
    }

    fn harness() -> Harness<'static, PhotocraftApp> {
        let app = PhotocraftApp::new(photocraft_engine::Session::new(), crate::Services::default());
        let mut h =
            Harness::builder().with_size(egui::vec2(1400.0, 900.0)).with_step_dt(1.0 / 60.0).build_ui_state(|ui, app| crate::dialogs::show(app, ui.ctx()), app);
        PhotocraftApp::setup_context(&h.ctx, crate::theme::ThemeKind::ALL[0]);
        h.state_mut().ui.open_dialog(DialogKind::NewDocument, UiState::new_document_fields());
        h.run_steps(3);
        h
    }

    fn click_at(h: &mut Harness<'static, PhotocraftApp>, at: egui::Pos2) {
        h.hover_at(at);
        h.run_steps(1);
        h.drag_at(at);
        h.run_steps(1);
        h.drop_at(at);
        h.run_steps(2);
    }

    /// A finger tap at `at`. Events for one phase share a frame (`input_mut`), because `Harness::step` would otherwise run one frame per queued event and drop Touch before the click release (so `second_click` would not see touch).
    fn touch_tap_at(h: &mut Harness<'static, PhotocraftApp>, at: egui::Pos2) {
        let touch = |phase| egui::Event::Touch { device_id: egui::TouchDeviceId(1), id: egui::TouchId(1), phase, pos: at, force: None };
        let button = |pressed| egui::Event::PointerButton { pos: at, button: egui::PointerButton::Primary, pressed, modifiers: egui::Modifiers::NONE };
        h.input_mut().events.extend([egui::Event::PointerMoved(at), touch(egui::TouchPhase::Start), button(true)]);
        h.step();
        h.input_mut().events.extend([touch(egui::TouchPhase::End), button(false)]);
        h.step();
        h.run_steps(1);
    }

    /// The Width (0), Height (1) and Resolution (2) fields.
    fn field(h: &Harness<'static, PhotocraftApp>, i: usize) -> egui::Rect {
        h.query_all_by_role(Role::SpinButton).nth(i).map(|n| n.rect()).expect("a size field")
    }

    /// Click into field `i` (which selects its text) and type `text`, as a user does.
    fn type_into(h: &mut Harness<'static, PhotocraftApp>, i: usize, text: &str) {
        let r = field(h, i);
        click_at(h, r.center());
        for c in text.chars() {
            h.event(egui::Event::Text(c.to_string()));
            h.run_steps(1);
        }
    }

    fn fields(h: &Harness<'static, PhotocraftApp>) -> serde_json::Map<String, serde_json::Value> {
        h.state().ui.dialogs.first().map(|d| d.fields.clone()).expect("the dialog is open")
    }

    fn set_fields(h: &mut Harness<'static, PhotocraftApp>, f: serde_json::Map<String, serde_json::Value>) {
        h.state_mut().ui.dialogs[0].fields = f;
        h.run_steps(2);
    }

    fn enter(h: &mut Harness<'static, PhotocraftApp>) {
        h.key_press(egui::Key::Enter);
        h.run_steps(3);
    }

    fn created(h: &Harness<'static, PhotocraftApp>) -> (u32, u32, f32) {
        assert!(h.state().ui.dialogs.is_empty(), "the dialog closed");
        let d = &h.state().session.active().expect("a new document").doc;
        (d.size.width, d.size.height, d.resolution_dpi)
    }

    /// Preset cards paint their titles directly, without an accessibility label.
    fn preset_title_at(h: &Harness<'static, PhotocraftApp>, title: &str) -> egui::Pos2 {
        fn find(shape: &egui::Shape, title: &str) -> Option<egui::Pos2> {
            match shape {
                egui::Shape::Text(text) if text.galley.job.text == title => Some(text.visual_bounding_rect().center()),
                egui::Shape::Vec(shapes) => shapes.iter().find_map(|shape| find(shape, title)),
                _ => None,
            }
        }
        h.output().shapes.iter().find_map(|shape| find(&shape.shape, title)).expect("visible preset title")
    }

    fn second_click_creates_once(h: &mut Harness<'static, PhotocraftApp>, at: egui::Pos2) {
        assert!(h.state().session.documents().is_empty(), "the first click only selects the preset");
        assert_eq!(h.state().ui.dialogs.len(), 1);
        // Two real pointer press/release pairs within egui's double-click interval.
        click_at(h, at);
        h.run_steps(3);
        assert_eq!(h.state().session.documents().len(), 1, "the second click creates exactly one document");
        assert!(h.state().ui.dialogs.is_empty(), "double-click closes the New Document dialog");
        assert!(h.state().ui.views[0].fit_pending, "the normal Create path fits the new document");
    }

    fn assert_pixel(h: &mut Harness<'static, PhotocraftApp>, expected: [f64; 4]) {
        let pixel = h.state_mut().session.execute("document.pixel", serde_json::json!({"x":0,"y":0})).unwrap();
        for (actual, expected) in pixel.as_array().unwrap().iter().zip(expected) {
            assert!((actual.as_f64().unwrap() - expected).abs() < 0.001, "background pixel: {pixel}");
        }
    }

    fn cursor_over(h: &mut Harness<'static, PhotocraftApp>, at: egui::Pos2) -> egui::CursorIcon {
        h.hover_at(at);
        h.run_steps(2);
        h.output().platform_output.cursor_icon
    }

    /// #8331: headings and field labels keep the arrow; only the text fields show the I-beam.
    #[test]
    fn labels_show_the_arrow_and_only_text_fields_the_text_cursor() {
        use egui_kittest::kittest::NodeT;
        let mut h = harness();
        let label_at = |h: &Harness<'static, PhotocraftApp>, text: &str| {
            h.query_all_by_label(text)
                .find(|n| n.accesskit_node().role() == Role::Label)
                .map(|n| n.rect().center())
                .unwrap_or_else(|| panic!("a {text:?} label"))
        };
        for text in ["PRESET DETAILS", "Width", "Height", "Resolution", "Color Mode", "Background Contents"] {
            let at = label_at(&h, text);
            assert_eq!(cursor_over(&mut h, at), egui::CursorIcon::Default, "over {text:?}");
        }
        // The name field still shows the text cursor, so the check above can tell them apart.
        let name = h.query_all_by_role(Role::TextInput).next().map(|n| n.rect().center()).expect("the name field");
        assert_eq!(cursor_over(&mut h, name), egui::CursorIcon::Text, "over the name field");
        // The Saved tab's labels too.
        h.get_by_label("Saved").click();
        h.run_steps(2);
        let at = label_at(&h, "No saved presets yet.");
        assert_eq!(cursor_over(&mut h, at), egui::CursorIcon::Default, "over the empty Saved list");
    }

    #[test]
    fn double_click_builtin_preset_creates_its_size_and_current_details() {
        let mut h = harness();
        let mut f = fields(&h);
        f.extend(serde_json::json!({"name":"Portrait proof","mode":"cmyk","depth":16,"background":"transparent"}).as_object().unwrap().clone());
        set_fields(&mut h, f);
        h.get_by_label("Photo").click();
        h.run_steps(2);
        let at = preset_title_at(&h, "Portrait, 4 x 6");
        click_at(&mut h, at);
        assert_eq!(fields(&h)["__preset"], "Portrait, 4 x 6");
        assert_eq!(
            super::super::command_params(&fields(&h)),
            serde_json::json!({"name":"Portrait proof","width":1200,"height":1800,"resolution":300.0,
                "mode":"cmyk","depth":16,"background":"transparent"})
        );
        second_click_creates_once(&mut h, at);
        assert_eq!(created(&h), (1200, 1800, 300.0));
        let doc = &h.state().session.active().unwrap().doc;
        assert_eq!(doc.name, "Portrait proof");
        assert_eq!((doc.mode, doc.depth), (photocraft_doc::ColorMode::Cmyk, photocraft_doc::SampleType::U16));
        assert_pixel(&mut h, [0.0; 4]);
    }

    /// Framework-style touch: the second tap lands ~48 px off (past egui's 6 px and the old 32 px touch slop) and still creates.
    #[test]
    fn touch_double_tap_with_jitter_creates_from_builtin_preset() {
        let mut h = harness();
        h.get_by_label("Photo").click();
        h.run_steps(2);
        let at = preset_title_at(&h, "Portrait, 4 x 6");
        touch_tap_at(&mut h, at);
        assert_eq!(fields(&h)["__preset"], "Portrait, 4 x 6");
        assert!(h.state().session.documents().is_empty(), "first tap only selects");
        touch_tap_at(&mut h, egui::pos2(at.x + 48.0, at.y));
        assert_eq!(created(&h), (1200, 1800, 300.0));
    }

    /// Mouse keeps egui's tight distance: 20 px between clicks is two singles, not a create.
    #[test]
    fn mouse_double_click_with_large_jitter_does_not_create() {
        let mut h = harness();
        h.get_by_label("Photo").click();
        h.run_steps(2);
        let at = preset_title_at(&h, "Portrait, 4 x 6");
        click_at(&mut h, at);
        click_at(&mut h, at + egui::vec2(20.0, 0.0));
        assert!(h.state().session.documents().is_empty());
        assert_eq!(h.state().ui.dialogs.len(), 1, "dialog stays open");
    }

    #[test]
    fn double_click_clipboard_preset_creates_its_size_and_current_details() {
        let mut h = harness();
        let mut f = fields(&h);
        super::super::set_clipboard(&mut f, 37, 23);
        apply_preset(&mut f, &("Other size", 100, 200, 300.0), &Default::default());
        f.extend(serde_json::json!({"mode":"gray","depth":8,"background":"white"}).as_object().unwrap().clone());
        set_fields(&mut h, f);
        let at = preset_title_at(&h, super::super::CLIPBOARD);
        click_at(&mut h, at);
        assert_eq!(fields(&h)["__preset"], super::super::CLIPBOARD);
        assert_eq!(
            super::super::command_params(&fields(&h)),
            serde_json::json!({"name":"Untitled-1","width":37,"height":23,"resolution":72.0,
                "mode":"gray","depth":8,"background":"white"})
        );
        second_click_creates_once(&mut h, at);
        assert_eq!(created(&h), (37, 23, 72.0));
        let doc = &h.state().session.active().unwrap().doc;
        assert_eq!((doc.mode, doc.depth), (photocraft_doc::ColorMode::Grayscale, photocraft_doc::SampleType::U8));
        assert_pixel(&mut h, [1.0; 4]);
    }

    #[test]
    fn double_click_saved_preset_restores_all_settings_and_captured_background() {
        let mut h = harness();
        h.state_mut()
            .run(
                "document.presets.save",
                serde_json::json!({"name":"Saved proof","settings":{
                    "width":48,"height":32,"resolution":254.0,"mode":"rgb","depth":32,
                    "background":"backgroundColor","backgroundColor":[0.125,0.375,0.625],"unit":"mm","resolutionUnit":"cm"
                }}),
            )
            .unwrap();
        h.state_mut().session.tools.background = [1.0, 0.0, 1.0, 1.0];
        let mut f = fields(&h);
        f.insert("name".into(), serde_json::json!("Current document name"));
        set_fields(&mut h, f);
        h.get_by_label("Saved").click();
        h.run_steps(2);
        let at = h.get_by_label("Saved proof").rect().center();
        click_at(&mut h, at);
        assert_eq!(fields(&h)["__savedPreset"], "Saved proof");
        assert_eq!(fields(&h)["__unit"], "mm");
        assert_eq!(fields(&h)["__resUnit"], "cm");
        second_click_creates_once(&mut h, at);
        assert_eq!(created(&h), (48, 32, 254.0));
        let doc = &h.state().session.active().unwrap().doc;
        assert_eq!(doc.name, "Current document name");
        assert_eq!((doc.mode, doc.depth), (photocraft_doc::ColorMode::Rgb, photocraft_doc::SampleType::F32));
        assert_pixel(&mut h, [0.125, 0.375, 0.625, 1.0]);
    }

    #[test]
    fn preset_cards_use_the_preset_resolution_preferences() {
        let mut h = harness();
        h.state_mut().run("prefs.set", serde_json::json!({"path": "unitsAndRulers.printResolution", "value": 150.0})).unwrap();
        h.state_mut().run("prefs.set", serde_json::json!({"path": "unitsAndRulers.screenResolution", "value": 96.0})).unwrap();
        h.get_by_label("Photo").click();
        h.run_steps(2);
        let at = preset_title_at(&h, "Landscape, 6 x 4");
        click_at(&mut h, at);
        assert_eq!(fields(&h)["__unit"], "in");
        second_click_creates_once(&mut h, at);
        assert_eq!(created(&h), (900, 600, 150.0), "6 x 4 in at 150 ppi");

        h.state_mut().ui.open_dialog(DialogKind::NewDocument, UiState::new_document_fields());
        h.run_steps(2);
        h.get_by_label("Web").click();
        h.run_steps(2);
        let at = preset_title_at(&h, "Web Minimum");
        click_at(&mut h, at);
        enter(&mut h);
        assert_eq!(created(&h), (1024, 768, 96.0));
    }

    #[test]
    fn arithmetic_dimensions_create_the_evaluated_size() {
        let mut h = harness();
        type_into(&mut h, 0, "1920/2");
        type_into(&mut h, 1, "(100+50)*2");
        enter(&mut h);
        assert_eq!(created(&h), (960, 300, 72.0));
    }

    #[test]
    fn typed_size_then_enter_creates_that_size() {
        let mut h = harness();
        type_into(&mut h, 0, "512");
        type_into(&mut h, 1, "512");
        let f = fields(&h);
        assert_eq!((f["width"].as_u64(), f["height"].as_u64()), (Some(512), Some(512)), "whole pixels: {f:?}");
        enter(&mut h);
        assert_eq!(created(&h), (512, 512, 72.0));
    }

    #[test]
    fn typed_size_then_create_without_leaving_the_field_creates_that_size() {
        let mut h = harness();
        type_into(&mut h, 0, "512");
        type_into(&mut h, 1, "300");
        // Still editing Height: click Create straight away.
        let create = h.get_by_label("Create").rect();
        click_at(&mut h, create.center());
        assert_eq!(created(&h), (512, 300, 72.0));
    }

    #[test]
    fn typing_over_a_preset_wins() {
        let mut h = harness();
        let mut f = fields(&h);
        let web = CATEGORIES.iter().find(|c| c.0 == "Web").unwrap().1.iter().find(|p| p.0 == "Web Minimum").unwrap();
        apply_preset(&mut f, web, &Default::default());
        set_fields(&mut h, f);
        type_into(&mut h, 0, "512");
        type_into(&mut h, 1, "512");
        assert!(fields(&h).get("__preset").is_none(), "typing deselects the preset");
        enter(&mut h);
        assert_eq!(created(&h), (512, 512, 72.0));
    }

    #[test]
    fn the_clipboard_card_is_first_and_creates_the_clipboard_size() {
        let mut h = harness();
        let mut f = fields(&h);
        super::super::set_clipboard(&mut f, 640, 360);
        set_fields(&mut h, f);
        // Recent lists the Clipboard card first: three presets instead of two.
        assert!(h.query_by_label_contains("BLANK DOCUMENT PRESETS (3)").is_some());
        let heading = h.get_by_label_contains("BLANK DOCUMENT PRESETS").rect();
        // Pick the second card, then the first (Clipboard) again.
        click_at(&mut h, heading.left_bottom() + egui::vec2(80.0 + 172.0, 60.0));
        assert_eq!(fields(&h).get("__preset").and_then(|v| v.as_str()), Some("Default Pigment Size"));
        click_at(&mut h, heading.left_bottom() + egui::vec2(80.0, 60.0));
        assert_eq!(fields(&h).get("__preset").and_then(|v| v.as_str()), Some(super::super::CLIPBOARD));
        enter(&mut h);
        assert_eq!(created(&h), (640, 360, 72.0));
    }

    #[test]
    fn clicking_a_preset_card_after_typing_sets_its_size() {
        let mut h = harness();
        type_into(&mut h, 0, "512");
        h.get_by_label("Photo").click();
        h.run_steps(2);
        // The first card ("Landscape, 6 x 4") sits under the presets heading.
        let heading = h.get_by_label_contains("BLANK DOCUMENT PRESETS").rect();
        click_at(&mut h, heading.left_bottom() + egui::vec2(80.0, 60.0));
        assert_eq!(fields(&h).get("__preset").and_then(|v| v.as_str()), Some("Landscape, 6 x 4"));
        enter(&mut h);
        assert_eq!(created(&h), (1800, 1200, 300.0));
    }

    #[test]
    fn typed_size_in_inches_converts_at_the_resolution() {
        let mut h = harness();
        type_into(&mut h, 2, "300");
        let mut f = fields(&h);
        f.insert("__unit".into(), serde_json::json!("in"));
        set_fields(&mut h, f);
        type_into(&mut h, 0, "2");
        type_into(&mut h, 1, "1.5");
        enter(&mut h);
        assert_eq!(created(&h), (600, 450, 300.0));
    }

    /// #1147: typed digit by digit, millimetres used to be rewritten after each keystroke
    /// (`8` became `8.1`), so 841 never arrived.
    #[test]
    fn typed_size_in_millimetres_keeps_every_digit() {
        let mut h = harness();
        let mut f = fields(&h);
        f.insert("__unit".into(), serde_json::json!("mm"));
        set_fields(&mut h, f);
        type_into(&mut h, 0, "841");
        type_into(&mut h, 1, "1189");
        enter(&mut h);
        assert_eq!(created(&h), (2384, 3370, 72.0));
    }

    #[test]
    fn changing_units_keeps_the_typed_pixel_size() {
        let mut h = harness();
        type_into(&mut h, 0, "512");
        type_into(&mut h, 1, "512");
        for unit in ["in", "cm", "mm", "pt", "pica", "px"] {
            let mut f = fields(&h);
            f.insert("__unit".into(), serde_json::json!(unit));
            set_fields(&mut h, f);
        }
        enter(&mut h);
        assert_eq!(created(&h), (512, 512, 72.0));
    }

    #[test]
    fn orientation_swap_keeps_whole_pixels() {
        let mut h = harness();
        type_into(&mut h, 0, "512");
        type_into(&mut h, 1, "256");
        // The Portrait icon button follows the "Orientation" label (icons have tooltips only).
        let label = h.get_by_label("Orientation").rect();
        let gap = h.ctx.global_style().spacing.item_spacing.x;
        click_at(&mut h, egui::pos2(label.right() + gap + 12.0, label.center().y));
        enter(&mut h);
        assert_eq!(created(&h), (256, 512, 72.0));
    }

    /// #4668: once an orientation is picked, the presets turn to it, on the cards and when applied.
    #[test]
    fn picked_orientation_turns_the_presets() {
        let mut h = harness();
        h.get_by_label("Print").click();
        h.run_steps(2);
        // The default 1920 x 1080 is already landscape: Landscape swaps nothing, but is picked.
        let label = h.get_by_label("Orientation").rect();
        let gap = h.ctx.global_style().spacing.item_spacing.x;
        click_at(&mut h, egui::pos2(label.right() + gap + 24.0 + gap + 12.0, label.center().y));
        assert_eq!((fields(&h)["width"].as_u64(), fields(&h)["height"].as_u64()), (Some(1920), Some(1080)));
        let _ = preset_title_at(&h, "11.7 x 8.3 in @ 300 ppi");
        let at = preset_title_at(&h, "A4");
        click_at(&mut h, at);
        enter(&mut h);
        assert_eq!(created(&h), (3508, 2480, 300.0));
    }

    /// #4668: a physical unit picked for Width/Height is the one print presets show and keep.
    #[test]
    fn picked_physical_unit_is_the_print_presets_unit() {
        let mut h = harness();
        let mut f = fields(&h);
        f.insert("__unit".into(), serde_json::json!("mm"));
        set_fields(&mut h, f);
        h.get_by_label("Print").click();
        h.run_steps(2);
        let _ = preset_title_at(&h, "210 x 297 mm @ 300 ppi");
        let at = preset_title_at(&h, "A4");
        click_at(&mut h, at);
        assert_eq!(fields(&h)["__unit"], "mm");
        // Screen presets stay in pixels.
        h.get_by_label("Web").click();
        h.run_steps(2);
        let _ = preset_title_at(&h, "1024 x 768 px @ 72 ppi");
        enter(&mut h);
        assert_eq!(created(&h), (2480, 3508, 300.0));
    }

    #[test]
    fn hovering_preset_tabs_shows_pointing_hand_not_text_cursor() {
        let mut h = harness();
        for tab in ["Recent", "Saved", "Photo", "Print", "Art & Illustration", "Web", "Mobile", "Film & Video"] {
            let rect = h.get_by_label(tab).rect();
            h.hover_at(rect.center());
            h.run_steps(2);
            assert_eq!(
                h.output().platform_output.cursor_icon,
                egui::CursorIcon::PointingHand,
                "hovering preset tab {tab:?} must show PointingHand instead of text caret"
            );
        }
    }
=======
fn create_gives_the_new_document_the_picked_pixel_aspect() {
    let mut app = app();
    app.ui.shell.custom_pars.push(crate::workspace_ui::CustomPar { name: "Cinema".into(), ratio: 1.25 });
    assert_eq!(custom_pixel_aspects(&app), [("custom:1.25:Cinema".to_owned(), "Cinema".to_owned())], "saved ratios follow the presets");
    let mut h = harness(app);
    create_with(&mut h, |o| o.pixel_aspect = "d1DvNtsc".into());
    assert_eq!(h.state().ui.view.pixel_aspect, "d1DvNtsc");
    create_with(&mut h, |o| o.pixel_aspect = "custom:1.25:Cinema".into());
    assert_eq!(crate::view_cmds::pixel_aspect_ratio(&h.state().ui.view.pixel_aspect), 1.25);
    h.state_mut().ui.view.pixel_aspect = "anamorphic2To1".into();
    create_with(&mut h, |o| o.pixel_aspect = SQUARE_PIXELS.into());
    assert_eq!(h.state().ui.view.pixel_aspect, SQUARE_PIXELS);
    // A custom ratio deleted since the dialog remembered it shows as Square Pixels, and Create gives that.
    h.state_mut().ui.shell.custom_pars.clear();
    create_with(&mut h, |o| o.pixel_aspect = "custom:1.25:Cinema".into());
    assert_eq!(h.state().ui.view.pixel_aspect, SQUARE_PIXELS);
>>>>>>> theirs
}
