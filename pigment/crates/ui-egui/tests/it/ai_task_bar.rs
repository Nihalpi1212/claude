//! Pigment: generative AI's task bars (`src/ai_ui/task_bar.rs`): Generative Fill under a
//! selection, Generate Background after Remove Background, Generative Expand in the Crop tool's
//! bar.
//!
//! **Not compiled yet** (merge of PhotoCraft 057297b): the task bars are part 2 of the AI
//! interface's port to the craft framework. These tests are Pigment 0.5.0's, moved out of
//! `ai.rs` as they were; part 2 adds `mod ai_task_bar;` to `main.rs` and brings them onto the
//! framework (`app.ui.crop_rect` is gone: the crop frame is `app.canvas_tools.crop.tool.frame()`,
//! `crop_task_bar::eligible`).

use std::sync::Arc;

use egui_kittest::kittest::{NodeT, Queryable};
use photocraft_engine::generative::mock::{MockAnswer, MockBackend};
use photocraft_ui_egui::ai_ui::{self, generate, task_bar};
use serde_json::json;

use super::ai::{control, harness, layer_names, until_idle, with_mock};

/// The task bars: Generative Fill under a selection and Generative Expand in the Crop tool's bar
/// appear only once a provider has a key; Generate Background follows Remove Background.
#[test]
fn task_bar_items_appear_only_with_a_key() {
    let mock = Arc::new(MockBackend::disconnected());
    let m = Arc::clone(&mock);
    let mut h = harness(move |app| {
        with_mock(app, &m);
        app.ui.panels.context_task_bar = true;
        app.run("select.rect", json!({"x": 20, "y": 20, "width": 40, "height": 40})).unwrap();
    });
    assert_eq!(task_bar::which(h.state()), None, "no key: the bar stays as it was");
    let connected = Arc::new(MockBackend::connected());
    with_mock(h.state_mut(), &connected);
    h.run_steps(4);
    assert_eq!(task_bar::which(h.state()), Some(task_bar::Bar::Selection));
    assert!(h.query_by_label("Generate").is_some(), "the bar's Generate");
    // Generate from the bar with a prompt runs Generative Fill at once.
    h.state_mut().ai.bar_prompt = "a moon".into();
    task_bar::fill_from_bar(h.state_mut());
    h.run_steps(3);
    assert_eq!(connected.calls().len(), 1);
    assert!(layer_names(h.state()).iter().any(|n| n == "Generative Fill"));
    // Remove Background with the provider, then the bar offers Generate Background.
    h.state_mut().run("select.deselect", json!({})).unwrap();
    connected.push(MockAnswer::Pattern(|x, _| if x < 50 { [0, 0, 0, 0] } else { [10, 200, 30, 255] }));
    let r = ai_ui::menu(h.state_mut(), "ai.removeBackgroundWithProvider", &json!({})).unwrap();
    assert!(r.is_ok(), "{r:?}");
    h.run_steps(4);
    assert_eq!(task_bar::which(h.state()), Some(task_bar::Bar::AfterRemove));
    assert!(h.query_by_label("Generate Background…").is_some());
    // The Crop tool's bar: Generative Expand, which takes the frame's size and side.
    control(&mut h, "ui.set", json!({"tool": "crop"}));
    h.state_mut().ui.crop_rect = Some([-50.0, 0.0, 200.0, 160.0]);
    h.run_steps(4);
    assert!(h.query_by_label("Generative Expand").is_some());
    h.get_by_label("Generative Expand").click();
    h.run_steps(3);
    let g = &h.state().ai.generate;
    assert!(g.open && g.feature == "ai.generativeExpand");
    assert_eq!((g.width, g.height, g.anchor), (250, 160, "right"));
    assert!(h.state().ui.crop_rect.is_none(), "the frame is let go");
}


/// Remove Background with AI Provider as a background job, with another tab made active while it
/// runs: Generate Background is offered on the document whose background was removed, not on the
/// tab that happens to be active when the job lands.
#[test]
fn generate_background_follows_the_document_the_job_ran_on() {
    let mock = Arc::new(MockBackend::connected());
    let m = Arc::clone(&mock);
    let mut h = harness(move |app| {
        with_mock(app, &m);
        app.background_jobs = true;
        app.ui.panels.context_task_bar = true;
        app.run("file.new", json!({"width": 120, "height": 90, "background": "white"})).expect("B");
        app.session.set_active(0);
    });
    mock.push(MockAnswer::Pattern(|x, _| if x < 50 { [0, 0, 0, 0] } else { [10, 200, 30, 255] }));
    let a = h.state().session.active().unwrap().doc.id;
    let r = ai_ui::menu(h.state_mut(), "ai.removeBackgroundWithProvider", &json!({})).unwrap();
    assert!(r.is_ok(), "{r:?}");
    h.state_mut().session.set_active(1);
    until_idle(&mut h);
    assert_eq!(mock.calls().len(), 1);
    let rev_a = h.state().session.documents().iter().find(|st| st.doc.id == a).unwrap().revision;
    assert_eq!(h.state().ai.after_remove, Some((a, rev_a)), "the job's document");
    assert_eq!(task_bar::which(h.state()), None, "not on the other tab");
    h.state_mut().session.set_active(0);
    h.run_steps(2);
    assert_eq!(task_bar::which(h.state()), Some(task_bar::Bar::AfterRemove));
}


/// Generative Expand from the Crop bar on a document wider than 30,000 px (PhotoCraft allows
/// 300,000 a side): no panic while the canvas is drawn, and the window keeps the size the frame
/// asked for instead of capping it below the document's own.
#[test]
fn expand_from_crop_on_a_very_wide_document() {
    let mock = Arc::new(MockBackend::connected());
    let m = Arc::clone(&mock);
    let mut h = harness(move |app| {
        with_mock(app, &m);
        app.run("file.new", json!({"width": 40_000, "height": 100, "background": "transparent"})).expect("wide");
    });
    control(&mut h, "ui.set", json!({"tool": "crop"}));
    h.state_mut().ui.crop_rect = Some([-100.0, 0.0, 40_000.0, 100.0]);
    task_bar::expand_from_crop(h.state_mut());
    h.run_steps(3);
    let g = &h.state().ai.generate;
    assert!(g.open && g.feature == "ai.generativeExpand");
    assert_eq!((g.width, g.height, g.anchor), (40_100, 100, "right"));
    assert_eq!(generate::params(h.state())["width"], 40_100);
    assert!(mock.calls().is_empty(), "nothing sent before Generate");
}


/// Generative Expand where the document can't take it (Indexed Color): the Crop bar's item is
/// dimmed with the reason, and asking anyway keeps the crop frame and says why in the status bar.
#[test]
fn expand_from_crop_keeps_the_frame_where_expand_is_disabled() {
    let mock = Arc::new(MockBackend::connected());
    let m = Arc::clone(&mock);
    let mut h = harness(move |app| {
        with_mock(app, &m);
        app.ui.panels.context_task_bar = true;
        app.run("image.mode.indexedColor", json!({})).expect("indexed");
    });
    control(&mut h, "ui.set", json!({"tool": "crop"}));
    let frame = [-20.0, 0.0, 200.0, 160.0];
    h.state_mut().ui.crop_rect = Some(frame);
    h.run_steps(3);
    let item = h.get_by_label("Generative Expand");
    assert!(item.accesskit_node().is_disabled(), "the Crop bar's item is dimmed");
    task_bar::expand_from_crop(h.state_mut());
    h.run_steps(3);
    let app = h.state();
    assert!(!app.ai.generate.open);
    assert_eq!(app.ui.crop_rect, Some(frame), "the frame is kept");
    assert!(app.ui.status.contains("Generative AI needs an RGB, CMYK, Lab or Grayscale document"), "{:?}", app.ui.status);
}


/// The selection bar's Generate sends one request, whatever the Generate window was last set to,
/// and a model typed for another feature is not carried over.
#[test]
fn the_bar_generate_sends_one_request() {
    let mock = Arc::new(MockBackend::connected());
    let m = Arc::clone(&mock);
    let mut h = harness(move |app| {
        with_mock(app, &m);
        app.run("select.rect", json!({"x": 20, "y": 20, "width": 40, "height": 40})).unwrap();
    });
    generate::open(h.state_mut(), "ai.generativeFill", None).unwrap();
    h.state_mut().ai.generate.variations = 3;
    generate::close(h.state_mut());
    h.run_steps(2);
    h.state_mut().ai.bar_prompt = "a moon".into();
    task_bar::fill_from_bar(h.state_mut());
    h.run_steps(3);
    assert_eq!(mock.calls().len(), 1, "{:?}", mock.calls());
    assert_eq!(layer_names(h.state()).iter().filter(|n| n.starts_with("Generative Fill")).count(), 1);
    // A model typed for Generate Image stays with it.
    generate::open(h.state_mut(), "ai.generateImage", None).unwrap();
    h.state_mut().ai.generate.model = "image-model-x".into();
    generate::close(h.state_mut());
    generate::open(h.state_mut(), "ai.generativeFill", None).unwrap();
    assert_eq!(h.state().ai.generate.model, "", "another feature's model");
}

