//! Pigment (U1): the Info panel's readout modes and deep values: the values, the options, the panel menu, Panel
//! Options… and the grid the panel draws.

use craft::ui::patterns::form_dialogs::HostedParamDialog;
use photocraft_engine::prefs::SavedPrefs;

use super::*;

fn rgb8() -> Space {
    Space::rgb(SampleType::U8)
}

fn values(mode: Mode, rgba: [f32; 4], space: &Space) -> Vec<String> {
    readout(mode, rgba, space).into_iter().map(|(_, v)| v).collect()
}

fn names(mode: Mode, space: &Space) -> Vec<Name> {
    readout(mode, [0.5; 4], space).into_iter().map(|(n, _)| n).collect()
}

#[test]
fn sixteen_bit_mid_grey_reads_16384_or_32768() {
    assert_eq!(deep(0.5, SampleType::U16, SixteenBit::Half), "16384");
    assert_eq!(deep(0.5, SampleType::U16, SixteenBit::Full), "32768");
    assert_eq!(deep(1.0, SampleType::U16, SixteenBit::Half), "32768");
    assert_eq!(deep(1.0, SampleType::U16, SixteenBit::Full), "65535");
    assert_eq!(deep(0.5, SampleType::U8, SixteenBit::Full), "128", "8 bits ignore the 16-bit range");
    let mut space = Space::rgb(SampleType::U16);
    assert_eq!(values(Mode::Rgb, [0.5, 0.25, 1.0, 1.0], &space), ["16384", "8192", "32768"]);
    space.sixteen = SixteenBit::Full;
    assert_eq!(values(Mode::Actual, [0.5, 0.25, 1.0, 1.0], &space), ["32768", "16384", "65535"]);
}

#[test]
fn thirty_two_bit_values_are_floats_and_not_clamped() {
    assert_eq!(deep(1.5, SampleType::F32, SixteenBit::Half), "1.5000");
    assert_eq!(deep(-0.25, SampleType::F32, SixteenBit::Half), "-0.2500");
    assert_eq!(deep(f32::NAN, SampleType::F32, SixteenBit::Half), "0.0000");
    assert_eq!(values(Mode::Rgb, [1.5, 0.5, 0.0, 1.0], &Space::rgb(SampleType::F32)), ["1.5000", "0.5000", "0.0000"]);
    assert_eq!(values(Mode::Rgb, [1.5, 0.5, 0.0, 1.0], &rgb8()), ["255", "128", "0"], "8 bits clamp");
}

#[test]
fn hsb_of_red_web_hex_lab_gray_and_opacity() {
    let s = rgb8();
    assert_eq!(values(Mode::Hsb, [1.0, 0.0, 0.0, 1.0], &s), ["0°", "100%", "100%"]);
    assert_eq!(values(Mode::Hsb, [0.0, 0.0, 1.0, 1.0], &s), ["240°", "100%", "100%"]);
    assert_eq!(names(Mode::Hsb, &s), [Name::Hue, Name::Saturation, Name::Brightness]);
    assert_eq!(values(Mode::Web, [1.0, 0.5, 0.0, 1.0], &s), ["FF8000"]);
    assert_eq!(values(Mode::Lab, [1.0, 1.0, 1.0, 1.0], &s), ["100", "0", "0"]);
    assert_eq!(names(Mode::Lab, &s), [Name::L, Name::LabA, Name::LabB]);
    assert_eq!(values(Mode::Gray, [0.5, 0.5, 0.5, 1.0], &s), ["50"]);
    assert_eq!(values(Mode::Gray, [1.0, 1.0, 1.0, 1.0], &s), ["0"]);
    assert_eq!(values(Mode::Opacity, [0.0, 0.0, 0.0, 0.25], &s), ["25%"]);
}

/// Review FU: an OpenEXR's linear composite was read as sRGB-encoded, so its mid grey showed as
/// 363636, B 21% and L 22 instead of what the canvas shows.
#[test]
fn a_linear_composite_reads_through_the_srgb_curve_except_rgb() {
    let linear = Space { linear: true, ..Space::rgb(SampleType::F32) };
    let grey = photocraft_color::convert::srgb_to_linear(128.0 / 255.0);
    let px = [grey, grey, grey, 1.0];
    assert_eq!(values(Mode::Web, px, &linear), ["808080"]);
    assert_eq!(values(Mode::Hsb, px, &linear)[2], "50%");
    assert_eq!(values(Mode::Lab, px, &linear)[0], "54");
    assert_eq!(values(Mode::Gray, px, &linear), ["50"]);
    assert_eq!(values(Mode::Cmyk, px, &linear), values(Mode::Cmyk, [0.5, 0.5, 0.5, 1.0], &Space::rgb(SampleType::F32)));
    assert_eq!(values(Mode::Rgb, px, &linear), [format!("{grey:.4}"), format!("{grey:.4}"), format!("{grey:.4}")], "RGB is the stored value");
    // The app sees a linear profile as linear.
    let mut app = app_with("rgb", 32);
    assert!(!space(&app, &InfoOptions::default()).unwrap().linear);
    let lin = craft::cms::Builtin::LinearSrgb.profile().to_bytes();
    std::sync::Arc::make_mut(&mut app.session.active_mut().unwrap().doc).icc_profile = Some(lin);
    assert!(space(&app, &InfoOptions::default()).unwrap().linear);
}

#[test]
fn total_ink_of_black_is_the_sum_of_its_inks() {
    let s = rgb8();
    let inks: i32 = values(Mode::Cmyk, [0.0, 0.0, 0.0, 1.0], &s).iter().map(|v| v.parse::<i32>().unwrap()).sum();
    assert!(inks > 100, "rich black in the built-in coated CMYK: {inks}");
    assert_eq!(values(Mode::TotalInk, [0.0, 0.0, 0.0, 1.0], &s), [format!("{inks}%")]);
    assert_eq!(values(Mode::TotalInk, [1.0, 1.0, 1.0, 1.0], &s), ["0%"]);
    assert_eq!(values(Mode::Cmyk, [1.0, 1.0, 1.0, 1.0], &s), ["0", "0", "0", "0"]);
}

#[test]
fn actual_color_is_the_document_s_own_channels() {
    let space = |mode| Space { mode, ..rgb8() };
    assert_eq!(names(Mode::Actual, &space(ColorMode::Rgb)), [Name::R, Name::G, Name::B]);
    assert_eq!(names(Mode::Actual, &space(ColorMode::Grayscale)), [Name::K]);
    assert_eq!(names(Mode::Actual, &space(ColorMode::Cmyk)), [Name::C, Name::M, Name::Y, Name::K]);
    assert_eq!(names(Mode::Actual, &space(ColorMode::Lab)), [Name::L, Name::LabA, Name::LabB]);
    assert_eq!(names(Mode::Actual, &space(ColorMode::Indexed)), [Name::R, Name::G, Name::B]);
}

#[test]
fn options_round_trip_without_nulls_and_survive_bad_values() {
    let o = InfoOptions { first: Mode::Hsb, second: Mode::Lab, sixteen: SixteenBit::Full, samplers: vec![None, Some(Mode::Web)] };
    let v = o.to_value();
    assert_eq!(v, json!({"first": "hsb", "second": "lab", "sixteenBit": "65535", "samplers": ["", "web"]}));
    assert_eq!(InfoOptions::from_value(&v), o);
    assert_eq!(InfoOptions::from_value(&json!({"first": "nope", "second": 3, "sixteenBit": true, "samplers": "x"})), InfoOptions::default());
    let trailing = InfoOptions::from_value(&json!({"samplers": ["web", "", ""]}));
    assert_eq!(trailing.samplers, [Some(Mode::Web)], "samplers without a mode at the end are dropped");
    assert_eq!(InfoOptions::from_value(&json!({"sixteenBit": 65535})).sixteen, SixteenBit::Full);
}

// ---------------------------------------------------------------------------------------------
// The app

fn app_with(mode: &str, depth: u32) -> Box<PhotocraftApp> {
    let mut app = PhotocraftApp::new(photocraft_engine::Session::new(), crate::Services::default());
    app.run("file.new", json!({"width": 40, "height": 30, "mode": mode, "depth": depth, "background": "white"})).unwrap();
    app.run("prefs.set", json!({"path": "unitsAndRulers.rulers", "value": "pixels"})).unwrap();
    app
}

fn fire(app: &mut PhotocraftApp, command: InfoPanelCommand) {
    let ctx = app.ctx().clone();
    assert!(run_fired(app, &ctx, &CommandRef::from(command)));
}

/// The grid's first line names, left and right.
fn first_names(panel: &Panel) -> Vec<[String; 2]> {
    let name = |cell: &Cell| cell.as_ref().map(|(n, _)| n.clone()).unwrap_or_default();
    panel.lines.iter().map(|[a, b]| [name(a), name(b)]).collect()
}

fn cell_value(cell: &Cell) -> Option<String> {
    cell.as_ref().and_then(|(_, v)| v.clone())
}

#[test]
fn the_default_8_bit_rgb_document_keeps_the_framework_panel() {
    let mut app = app_with("rgb", 8);
    assert_eq!(custom(&app), None);
    assert_eq!(lines(&mut app), None);
    // RGB Color as the first readout is the framework's look too.
    fire(&mut app, InfoPanelCommand::FirstRgb);
    assert_eq!(custom(&app), None);
    // A 16-bit document, a Grayscale one (Actual is K) or another second readout draw Pigment's grid.
    assert!(custom(&app_with("rgb", 16)).is_some());
    assert!(custom(&app_with("grayscale", 8)).is_some());
    fire(&mut app, InfoPanelCommand::SecondHsb);
    assert!(custom(&app).is_some());
    let empty = PhotocraftApp::new(photocraft_engine::Session::new(), crate::Services::default());
    assert_eq!(custom(&empty), None, "no document: the framework's notice");
}

#[test]
fn second_readout_lab_shows_l_a_b_and_is_saved() {
    let mut app = app_with("rgb", 8);
    fire(&mut app, InfoPanelCommand::SecondLab);
    assert_eq!(options(&app).second, Mode::Lab);
    assert_eq!(app.session.prefs().dialogs[OPTIONS_PREF]["second"], "lab");
    let panel = lines(&mut app).expect("Pigment's grid");
    let names = first_names(&panel);
    assert_eq!(names[..3], [["R".to_owned(), "L".to_owned()], ["G".into(), "a".into()], ["B".into(), "b".into()]]);
    assert_eq!(names[3..], [["X".to_owned(), "W".to_owned()], ["Y".into(), "H".into()]], "then X/Y beside W/H");
    assert_eq!(panel.document, "Doc: 40 x 30");
    // No pointer: dashes.
    assert!(panel.lines[..3].iter().all(|[a, b]| cell_value(a).is_none() && cell_value(b).is_none()));
    // Over white: the values.
    app.hover_doc = Some([10.5, 10.5]);
    let panel = lines(&mut app).unwrap();
    let column = |i: usize| panel.lines[..3].iter().map(|line| cell_value(&line[i]).unwrap()).collect::<Vec<_>>();
    assert_eq!(column(0), ["255", "255", "255"]);
    assert_eq!(column(1), ["100", "0", "0"]);
    assert_eq!(cell_value(&panel.lines[3][0]).as_deref(), Some("10"), "X in pixels");
}

#[test]
fn the_menu_states_check_each_readout_s_mode_and_word_it_alone() {
    let mut app = app_with("rgb", 8);
    fire(&mut app, InfoPanelCommand::FirstHsb);
    let states = command_states(&app);
    let state = |c: InfoPanelCommand| states.iter().find(|(r, _)| *r == CommandRef::from(c)).map(|(_, s)| s.clone()).unwrap();
    assert_eq!(state(InfoPanelCommand::FirstHsb), CommandState::new().checked(true).title("HSB Color"));
    assert_eq!(state(InfoPanelCommand::FirstActual), CommandState::new().checked(false).title("Actual Color"));
    assert_eq!(state(InfoPanelCommand::SecondCmyk), CommandState::new().checked(true).title("CMYK Color"));
    let rows = panel_rows(&app);
    let PanelRow::Submenu(label, first) = &rows[0] else { panic!("the first readout's submenu") };
    assert_eq!(label.as_str(), "First Color Readout");
    assert_eq!(first.len(), 10);
    assert!(matches!(&rows[1], PanelRow::Submenu(label, second) if label.as_str() == "Second Color Readout" && second.len() == 10));
    assert!(rows.iter().any(|r| matches!(r, PanelRow::Command(c) if *c == CommandRef::from(InfoPanelCommand::PanelOptions))));
    assert!(rows.iter().any(|r| matches!(r, PanelRow::Command(c) if c.id == UNITS)));
    assert!(photocraft_engine::commands::find(UNITS).is_some(), "Units & Rulers… is an engine command");
    assert!(!run_fired(&mut app, &egui::Context::default(), &CommandRef::new(UNITS)), "it is not the panel's own");
}

#[test]
fn a_16_bit_document_reads_0_to_32768_and_0_to_65535() {
    let mut app = app_with("rgb", 16);
    app.run("edit.fill", json!({"color": "#808080"})).unwrap();
    app.hover_doc = Some([5.5, 5.5]);
    let panel = lines(&mut app).expect("16 bits draw Pigment's grid");
    let value = |panel: &Panel, line: usize| cell_value(&panel.lines[line][0]).unwrap();
    // 128/255 of 32768 = 16448.
    assert_eq!(value(&panel, 0), "16448");
    let ctx = app.ctx().clone();
    let id = open_options(&mut app);
    app.framework.dialogs.set_json_field(&ctx, id, "sixteenBit", json!("65535")).unwrap();
    crate::dialogs::confirm(&mut app, &ctx, id).unwrap();
    assert_eq!(options(&app).sixteen, SixteenBit::Full);
    assert_eq!(value(&lines(&mut app).unwrap(), 0), "32896");
}

#[test]
fn a_32_bit_document_reads_floats() {
    let mut app = app_with("rgb", 32);
    app.hover_doc = Some([5.5, 5.5]);
    let panel = lines(&mut app).unwrap();
    assert_eq!(cell_value(&panel.lines[0][0]).as_deref(), Some("1.0000"));
}

#[test]
fn panel_options_sets_both_readouts_and_a_sampler_s_own_mode() {
    let mut app = app_with("rgb", 16);
    app.run("edit.fill", json!({"color": "#ff0000"})).unwrap();
    app.run("view.colorSamplers.add", json!({"x": 2, "y": 2})).unwrap();
    app.run("view.colorSamplers.add", json!({"x": 3, "y": 3})).unwrap();
    let ctx = app.ctx().clone();
    let id = open_options(&mut app);
    let fields = app.framework.dialogs.get_by_id::<HostedParamDialog>(id).unwrap().fields().clone();
    assert_eq!((fields.text("first"), fields.text("second"), fields.text("sixteenBit")), (Some("actual"), Some("cmyk"), Some("32768")));
    assert_eq!((fields.text("sampler0"), fields.text("sampler1")), (Some("panel"), Some("panel")));
    for (key, value) in [("first", "web"), ("second", "opacity"), ("sampler1", "hsb")] {
        app.framework.dialogs.set_json_field(&ctx, id, key, json!(value)).unwrap();
    }
    crate::dialogs::confirm(&mut app, &ctx, id).unwrap();
    let o = options(&app);
    assert_eq!((o.first, o.second, o.samplers.clone()), (Mode::Web, Mode::Opacity, vec![None, Some(Mode::Hsb)]));
    let panel = lines(&mut app).unwrap();
    assert_eq!(panel.samplers.len(), 2);
    let (number, first) = &panel.samplers[0];
    assert_eq!(number, "#1");
    let flat = |lines: &[Line]| lines.iter().flatten().flatten().map(|(n, v)| format!("{n} {}", v.clone().unwrap_or_default())).collect::<Vec<_>>();
    assert_eq!(flat(first), ["X 2", "Y 2", "# FF0000", "Opacity 100%"], "the panel's two readouts");
    assert_eq!(flat(&panel.samplers[1].1), ["X 3", "Y 3", "H 0°", "S 100%", "B 100%"], "its own mode");
}

#[test]
fn a_sampler_reads_its_unrounded_16_bit_value() {
    let mut app = app_with("rgb", 16);
    app.session
        .edit("paint", |doc, _| {
            let surf = doc.layers[0].surface_mut().unwrap();
            let px = photocraft_raster::from_rgba(&surf.format(), [0.3, 0.3, 0.3, 1.0]);
            surf.fill_rect(photocraft_geom::Rect::new(0, 0, 8, 8), &px);
            Ok(())
        })
        .unwrap();
    app.run("view.colorSamplers.add", json!({"x": 4, "y": 4})).unwrap();
    let panel = lines(&mut app).unwrap();
    let red = panel.samplers[0].1[1][0].clone().unwrap();
    // 0.3 stored in 16 bits (19661/65535) reads 9831 of 32768, where the 8-bit readout (77) would read 9894.
    assert_eq!(red, ("R".to_owned(), Some("9831".to_owned())));
}

#[test]
fn proof_color_reads_the_proof_profile_s_inks() {
    let mut app = app_with("rgb", 8);
    fire(&mut app, InfoPanelCommand::FirstProof);
    app.hover_doc = Some([5.5, 5.5]);
    let panel = lines(&mut app).unwrap();
    let names = first_names(&panel);
    assert_eq!(names[..4].iter().map(|[a, _]| a.as_str()).collect::<Vec<_>>(), ["C", "M", "Y", "K"], "Working CMYK by default");
    // White paper takes no ink.
    assert!(panel.lines[..4].iter().all(|l| cell_value(&l[0]).as_deref() == Some("0")), "{:?}", panel.lines);
    // An sRGB proof reads RGB.
    app.run("view.proofSetup", json!({"profile": "srgb"})).unwrap();
    let panel = lines(&mut app).unwrap();
    assert_eq!(first_names(&panel)[..3].iter().map(|[a, _]| a.as_str()).collect::<Vec<_>>(), ["R", "G", "B"]);
    assert_eq!(cell_value(&panel.lines[0][0]).as_deref(), Some("255"));
}

#[test]
fn the_options_survive_saving_the_preferences() {
    let mut app = app_with("rgb", 8);
    let o = InfoOptions { first: Mode::Gray, second: Mode::TotalInk, sixteen: SixteenBit::Full, samplers: vec![Some(Mode::Lab)] };
    set_options(&mut app, o.clone());
    let text = toml::to_string(&app.session.saved_prefs()).unwrap();
    let saved: SavedPrefs = toml::from_str(&text).unwrap();
    let mut again = PhotocraftApp::new(photocraft_engine::Session::new(), crate::Services::default());
    assert!(again.session.set_saved_prefs(saved).is_empty());
    assert_eq!(options(&again), o);
}
