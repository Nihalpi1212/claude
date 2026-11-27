//! The Gradient Editor panel's noise rows: each change is one command (one history step on a fill layer).

use egui_kittest::Harness;
use egui_kittest::kittest::Queryable;
use photocraft_doc::{Fill, LayerContent, NoiseGradient};

use super::super::editor_tests::editor;
use crate::PhotocraftApp;

fn layer_noise(h: &Harness<Box<PhotocraftApp>>) -> Option<NoiseGradient> {
    let st = h.state().session.active().unwrap();
    match &st.doc.layer(st.active_layer.unwrap()).unwrap().content {
        LayerContent::Fill(Fill::Gradient { noise, .. }) => noise.clone(),
        other => panic!("{}", other.kind_name()),
    }
}

fn history(h: &Harness<Box<PhotocraftApp>>) -> usize {
    h.state().session.active().unwrap().history.past_len()
}

fn press(h: &mut Harness<Box<PhotocraftApp>>, label: &str) {
    h.get_by_label(label).click();
    h.run_steps(4);
}

#[test]
fn switching_a_fill_layer_to_noise_is_one_history_step_and_randomize_changes_the_seed() {
    let mut h = editor(true);
    assert!(layer_noise(&h).is_none());
    assert!(h.query_by_label("Randomize").is_none(), "a solid gradient has no noise rows");
    let before = history(&h);
    press(&mut h, "Noise");
    let n = layer_noise(&h).expect("a noise gradient");
    assert_eq!(history(&h), before + 1, "one history entry");
    assert_eq!(n, NoiseGradient::default());
    press(&mut h, "Randomize");
    let m = layer_noise(&h).expect("still noise");
    assert_eq!(m.seed, super::next_seed(n.seed));
    assert_ne!(m.seed, n.seed);
    assert_eq!(history(&h), before + 2);
    press(&mut h, "Restrict Colors");
    assert!(layer_noise(&h).unwrap().restrict);
    // Undo steps back through each change; Solid makes it a stop gradient again.
    h.state_mut().run("edit.undo", serde_json::json!({})).unwrap();
    h.run_steps(2);
    assert!(!layer_noise(&h).unwrap().restrict);
    press(&mut h, "Solid");
    assert!(layer_noise(&h).is_none());
    assert!(h.query_by_label("Randomize").is_none());
}

#[test]
fn the_tool_gradient_turns_noise_and_hides_its_stop_bar() {
    let mut h = editor(false);
    assert!(h.query_by_label("Gradient stops").is_some(), "the stop bar of a solid gradient");
    press(&mut h, "Noise");
    let n = h.state().session.presets.gradient.noise.clone().expect("the tool gradient is noise");
    assert!(h.query_by_label("Gradient stops").is_none(), "no stop bar for a noise gradient");
    assert!(h.query_all_by_label("Roughness:").next().is_some() && h.query_all_by_label("Add Transparency").next().is_some());
    press(&mut h, "Randomize");
    assert_eq!(h.state().session.presets.gradient.noise.as_ref().map(|m| m.seed), Some(super::next_seed(n.seed)));
    press(&mut h, "Add Transparency");
    assert!(h.state().session.presets.gradient.noise.as_ref().is_some_and(|m| m.transparency));
    assert!(!h.state().session.presets.gradient.opacity.is_empty(), "the bake's transparency");
    press(&mut h, "Solid");
    assert!(h.state().session.presets.gradient.noise.is_none());
    assert!(h.query_by_label("Gradient stops").is_some());
}
