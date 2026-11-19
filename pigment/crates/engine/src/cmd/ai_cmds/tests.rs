//! Tests of the generative commands, with the scripted backend: no network anywhere.

use std::sync::Arc;
use std::time::Duration;

use photocraft_doc::{LayerId, LayerMask};
use photocraft_geom::Rect;
use photocraft_raster::{Rgba8Image, Surface};
use serde_json::{Value, json};

use super::{COMMANDS, NO_BACKEND, may_send, unrecorded};
use crate::generative::mock::{MockAnswer, MockBackend};
use crate::generative::{BackendStatus, GenerativeBackend, ProviderId, ProviderStatus, kind};
use crate::jobs::{JobCtx, Started};
use crate::{EngineError, Session};

/// A `w` × `h` document in `mode` at `depth` whose Background holds a varied pattern.
fn session(w: u32, h: u32, mode: &str, depth: u64) -> Session {
    let mut s = Session::new();
    s.execute("file.new", json!({"width": w, "height": h, "mode": mode, "depth": depth})).unwrap();
    s.edit("paint", |doc, active| {
        let surf = doc.layer_mut(active.unwrap()).unwrap().surface_mut().unwrap();
        let (n, alpha) = (surf.channels(), surf.format().alpha);
        for y in 0..h {
            for x in 0..w {
                let px: Vec<f32> =
                    (0..n).map(|c| if alpha && c == n - 1 { 1.0 } else { 0.1 + 0.8 * (((x * 7 + y * 3 + c as u32 * 50) % 97) as f32 / 97.0) }).collect();
                surf.write_pixel(x as i32, y as i32, &px);
            }
        }
        Ok(())
    })
    .unwrap();
    s
}

fn rgb(w: u32, h: u32) -> Session {
    session(w, h, "rgb", 8)
}

fn install(s: &mut Session, mock: MockBackend) -> Arc<MockBackend> {
    let m = Arc::new(mock);
    s.set_generative(Some(m.clone()));
    m
}

fn composite(s: &Session) -> Vec<[f32; 4]> {
    let d = &s.active().unwrap().doc;
    photocraft_compose::render(d, d.bounds()).into_px()
}

fn steps(s: &Session) -> usize {
    s.active().unwrap().history.past_len()
}

fn undo_label(s: &Session) -> Option<String> {
    s.active().unwrap().history.undo_label().map(str::to_string)
}

fn revision(s: &Session) -> u64 {
    s.active().unwrap().revision
}

fn layer_count(s: &Session) -> usize {
    s.active().unwrap().doc.walk().len()
}

fn top(s: &Session) -> &photocraft_doc::Layer {
    s.active().unwrap().doc.layers.last().unwrap()
}

fn select(s: &mut Session, x: i32, y: i32, w: u32, h: u32) {
    s.execute("select.rect", json!({"x": x, "y": y, "width": w, "height": h})).unwrap();
}

fn kind_of(e: &EngineError) -> &'static str {
    match e {
        EngineError::Generative { kind, .. } => kind,
        _ => "",
    }
}

fn alpha_at(l: &photocraft_doc::Layer, x: i32, y: i32) -> f32 {
    l.surface().unwrap().rgba(x, y)[3]
}

/// Every pixel of `a` and `b` equal outside `keep_out`.
fn assert_same_outside(a: &[[f32; 4]], b: &[[f32; 4]], w: u32, keep_out: Rect, what: &str) {
    for (i, (p, q)) in a.iter().zip(b).enumerate() {
        let (x, y) = ((i as u32 % w) as i32, (i as u32 / w) as i32);
        if !keep_out.contains(x, y) {
            assert_eq!(p, q, "{what}: pixel ({x}, {y}) changed outside the mask");
        }
    }
}

#[test]
fn the_commands_are_registered_and_listed_with_their_needs() {
    for id in COMMANDS {
        assert!(crate::commands::find(id).is_some(), "{id}");
    }
    let s = Session::new();
    let entry = |s: &Session, id: &str| crate::commands::list_entry(s, crate::commands::find(id).unwrap(), s.disabled_reason(id));
    for id in ["ai.generativeFill", "ai.generativeExpand", "ai.replaceBackground", "ai.replaceSky", "ai.describe", "ai.removeBackground"] {
        assert_eq!(entry(&s, id)["needsDocument"], json!(true), "{id}");
    }
    // Generate Image makes a new document without one; it only needs a backend.
    assert_eq!(entry(&s, "ai.generateImage")["needsDocument"], json!(false));
    assert_eq!(entry(&s, "ai.generateImage")["disabledReason"], json!(NO_BACKEND));
    assert_eq!(entry(&s, "ai.status")["enabled"], json!(true));
    // Queries are not journaled; edits are.
    for (id, journal) in [("ai.describe", false), ("ai.status", false), ("ai.testConnection", false), ("ai.generativeFill", true)] {
        assert_eq!(crate::commands::find(id).unwrap().journal, journal, "{id}");
    }
}

#[test]
fn without_a_backend_the_provider_commands_are_disabled_and_status_says_so() {
    let mut s = rgb(32, 24);
    select(&mut s, 4, 4, 8, 8);
    for id in ["ai.generativeFill", "ai.generativeExpand", "ai.generateImage", "ai.replaceBackground", "ai.replaceSky", "ai.describe", "ai.testConnection"] {
        assert_eq!(s.disabled_reason(id).as_deref(), Some(NO_BACKEND), "{id}");
        assert!(s.execute(id, json!({"prompt": "x"})).is_err(), "{id}");
    }
    // The local Remove Background needs none.
    assert!(s.is_enabled("ai.removeBackground"));
    let st = s.execute("ai.status", json!({})).unwrap();
    assert_eq!(st["installed"], json!(false));
    assert_eq!(st["providers"], json!([]));
}

#[test]
fn generative_fill_lands_one_layer_inside_the_selection_in_one_step() {
    let mut s = rgb(48, 32);
    let mock = install(&mut s, MockBackend::connected());
    select(&mut s, 10, 8, 20, 12);
    let before = composite(&s);
    let (layers, past) = (layer_count(&s), steps(&s));
    let r = s.execute("ai.generativeFill", json!({"prompt": "  a red box  "})).unwrap();
    assert_eq!(layer_count(&s), layers + 1);
    assert_eq!(steps(&s), past + 1, "one undo step");
    assert_eq!(undo_label(&s).as_deref(), Some("Generative Fill"));
    let l = top(&s);
    assert_eq!(l.name, "Generative Fill");
    assert_eq!(r["layers"], json!([l.id.0]));
    assert_eq!(s.active().unwrap().active_layer, Some(l.id), "the new layer is active");
    assert!(s.active().unwrap().doc.selection.is_some(), "the selection stays");
    // The request: the prompt trimmed, the region around the selection, a mask inside it.
    let calls = mock.calls();
    assert_eq!(calls.len(), 1);
    let c = &calls[0];
    assert_eq!((c.op, c.prompt.as_str(), c.provider), ("edit", "a red box", Some(ProviderId::OpenAi)));
    assert_eq!((c.width, c.height), (30, 30), "the selection padded by 25 % and squared");
    let cov = c.mask_coverage.unwrap();
    assert!(cov > 0.2 && cov < 0.35, "mask coverage {cov}");
    // Inside: the answer. Outside the feathered selection: exactly the original.
    let after = composite(&s);
    assert_eq!(after[(14 * 48 + 20) as usize], [1.0, 0.0, 0.0, 1.0]);
    assert_same_outside(&before, &after, 48, Rect::from_xywh(10, 8, 20, 12).inflate(3), "fill");
    assert!(alpha_at(l, 2, 2) == 0.0 && alpha_at(l, 20, 14) == 1.0);
    // Undo restores it exactly; Redo replays it.
    s.execute("edit.undo", json!({})).unwrap();
    assert_eq!(composite(&s), before);
    assert_eq!(layer_count(&s), layers);
    s.execute("edit.redo", json!({})).unwrap();
    assert_eq!(composite(&s), after);
}

#[test]
fn a_fill_keeps_every_pixel_outside_the_mask_in_every_mode_and_depth() {
    for mode in ["rgb", "gray", "cmyk", "lab"] {
        for depth in [8, 16, 32] {
            let what = format!("{mode} {depth}-bit");
            let mut s = session(40, 28, mode, depth);
            install(&mut s, MockBackend::connected());
            select(&mut s, 12, 6, 14, 10);
            let before = composite(&s);
            let background = s.active().unwrap().doc.layers[0].surface().unwrap().read_region(Rect::new(0, 0, 40, 28));
            s.execute("ai.generativeFill", json!({"prompt": "fill"})).unwrap_or_else(|e| panic!("{what}: {e}"));
            let after = composite(&s);
            assert_same_outside(&before, &after, 40, Rect::from_xywh(12, 6, 14, 10).inflate(3), &what);
            assert_ne!(before[(10 * 40 + 18) as usize], after[(10 * 40 + 18) as usize], "{what}: the inside changed");
            let doc = &s.active().unwrap().doc;
            assert_eq!(doc.layers[0].surface().unwrap().read_region(Rect::new(0, 0, 40, 28)), background, "{what}: the document's own pixels");
            assert_eq!(top(&s).surface().unwrap().format(), super::layer_format(doc), "{what}: the layer is in the document's format");
            s.execute("edit.undo", json!({})).unwrap();
            assert_eq!(composite(&s), before, "{what}: undo");
        }
    }
}

#[test]
fn variations_make_one_layer_each_in_order_with_the_last_active() {
    let mut s = rgb(40, 30);
    let mock = install(&mut s, MockBackend::connected());
    for c in [[0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 0, 255]] {
        mock.push(MockAnswer::Solid(c));
    }
    select(&mut s, 10, 10, 10, 10);
    let past = steps(&s);
    let r = s.execute("ai.generativeFill", json!({"prompt": "x", "variations": 3})).unwrap();
    assert_eq!(steps(&s), past + 1);
    let doc = &s.active().unwrap().doc;
    let names: Vec<&str> = doc.layers.iter().skip(1).map(|l| l.name.as_str()).collect();
    assert_eq!(names, ["Generative Fill 1", "Generative Fill 2", "Generative Fill 3"]);
    let ids: Vec<u64> = doc.layers.iter().skip(1).map(|l| l.id.0).collect();
    assert_eq!(r["layers"], json!(ids));
    for (l, c) in doc.layers.iter().skip(1).zip([[0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 1.0, 0.0]]) {
        assert_eq!(l.surface().unwrap().rgba(15, 15), [c[0], c[1], c[2], 1.0], "{}", l.name);
    }
    assert_eq!(s.active().unwrap().active_layer, Some(LayerId(*ids.last().unwrap())));
    assert_eq!(mock.calls().len(), 3);
    // Out of range is clamped as in Pigment 0.4; not a number is refused.
    assert!(s.execute("ai.generativeFill", json!({"prompt": "x", "variations": "two"})).is_err());
    s.execute("ai.generativeFill", json!({"prompt": "x", "variations": 9})).unwrap();
    assert_eq!(mock.calls().len(), 6);
}

#[test]
fn the_new_layers_go_above_the_named_layer() {
    let mut s = rgb(30, 20);
    install(&mut s, MockBackend::connected());
    s.execute("layer.new.layer", json!({"name": "A"})).unwrap();
    s.execute("layer.new.layer", json!({"name": "B"})).unwrap();
    let a = s.active().unwrap().doc.layers[1].id;
    select(&mut s, 2, 2, 6, 6);
    s.execute("ai.generativeFill", json!({"prompt": "x", "layer": a.0})).unwrap();
    let names: Vec<&str> = s.active().unwrap().doc.layers.iter().map(|l| l.name.as_str()).collect();
    assert_eq!(names, ["Background", "A", "Generative Fill", "B"]);
}

#[test]
fn a_large_region_is_sent_scaled_down_and_lands_at_full_size() {
    let mut s = rgb(3000, 60);
    let mock = install(&mut s, MockBackend::connected());
    select(&mut s, 0, 0, 3000, 60);
    s.execute("ai.generativeFill", json!({"prompt": "x"})).unwrap();
    let c = &mock.calls()[0];
    assert_eq!((c.width, c.height), (2048, 41));
    let l = top(&s);
    assert_eq!(l.surface().unwrap().rgba(2999, 59), [1.0, 0.0, 0.0, 1.0]);
    assert_eq!(l.surface().unwrap().rgba(0, 0), [1.0, 0.0, 0.0, 1.0]);
}

#[test]
fn refusals_send_nothing_and_change_nothing() {
    let mut s = rgb(32, 24);
    let mock = install(&mut s, MockBackend::connected());
    // No selection.
    let rev = revision(&s);
    let e = s.execute("ai.generativeFill", json!({"prompt": "x"})).unwrap_err();
    assert!(e.to_string().contains("make a selection"), "{e}");
    select(&mut s, 4, 4, 8, 8);
    let rev = rev.max(revision(&s));
    let cases: Vec<(&str, Value, &str)> = vec![
        ("ai.generativeFill", json!({}), kind::BAD_REQUEST),
        ("ai.generativeFill", json!({"prompt": "   "}), kind::BAD_REQUEST),
        ("ai.replaceSky", json!({}), kind::BAD_REQUEST),
        ("ai.generateImage", json!({"prompt": ""}), kind::BAD_REQUEST),
        ("ai.generativeFill", json!({"promt": "x"}), ""),
        ("ai.generativeFill", json!({"prompt": "x", "provider": "openia"}), ""),
        ("ai.generativeExpand", json!({"width": 10}), ""),
        ("ai.generateImage", json!({"prompt": "x", "width": 100}), ""),
        ("ai.removeBackground", json!({"method": "cloud"}), ""),
    ];
    for (id, p, want) in &cases {
        let e = s.execute(id, p.clone()).unwrap_err();
        assert_eq!(kind_of(&e), *want, "{id} {p}: {e}");
    }
    // No consent: nothing is sent, whatever the feature.
    mock.set_consented(false);
    for (id, p) in [
        ("ai.generativeFill", json!({"prompt": "x"})),
        ("ai.generativeExpand", json!({"width": 40})),
        ("ai.generateImage", json!({"prompt": "x"})),
        ("ai.replaceSky", json!({"prompt": "x"})),
        ("ai.replaceBackground", json!({"prompt": "x"})),
        ("ai.removeBackground", json!({"method": "provider"})),
        ("ai.describe", json!({})),
    ] {
        let e = s.execute(id, p).unwrap_err();
        assert_eq!(kind_of(&e), kind::NEEDS_CONSENT, "{id}: {e}");
    }
    // No key.
    let none = MockBackend::disconnected();
    mock.set_status(none.status());
    let e = s.execute("ai.generativeFill", json!({"prompt": "x"})).unwrap_err();
    assert_eq!(kind_of(&e), kind::MISSING_KEY, "{e}");
    assert!(e.to_string().contains("AI Accounts"), "{e}");
    assert!(mock.calls().is_empty(), "nothing was sent: {:?}", mock.calls());
    assert_eq!(revision(&s), rev, "nothing changed");
}

#[test]
fn a_failed_or_wrong_sized_answer_changes_nothing() {
    let mut s = rgb(32, 24);
    let mock = install(&mut s, MockBackend::connected());
    select(&mut s, 4, 4, 8, 8);
    let (rev, layers) = (revision(&s), layer_count(&s));
    mock.push(MockAnswer::Image(Rgba8Image::new(5, 5)));
    let e = s.execute("ai.generativeFill", json!({"prompt": "x"})).unwrap_err();
    assert_eq!(kind_of(&e), kind::BAD_RESPONSE, "{e}");
    assert!(e.to_string().contains("wrong size"), "{e}");
    mock.push(MockAnswer::Error { kind: kind::BAD_RESPONSE, message: "The model returned an image that could not be decoded".into() });
    let e = s.execute("ai.generativeFill", json!({"prompt": "x"})).unwrap_err();
    assert_eq!(e.to_string(), "The model returned an image that could not be decoded");
    mock.push(MockAnswer::Error { kind: "quota", message: "Your OpenAI quota is used up.".into() });
    let e = s.execute("ai.generateImage", json!({"prompt": "x"})).unwrap_err();
    assert_eq!(kind_of(&e), "quota");
    assert_eq!((revision(&s), layer_count(&s)), (rev, layers));
    // A second variation failing keeps the first, which was billed.
    mock.push(MockAnswer::Solid([0, 255, 0, 255]));
    mock.push(MockAnswer::Image(Rgba8Image::new(1, 1)));
    let r = s.execute("ai.generativeFill", json!({"prompt": "x", "variations": 2})).unwrap();
    assert_eq!(r["layers"].as_array().map(Vec::len), Some(1));
    assert_eq!(r["failed"]["kind"], json!(kind::BAD_RESPONSE));
    assert!(r["failed"]["message"].as_str().unwrap_or_default().contains("wrong size"), "{r}");
    assert_eq!(layer_count(&s), layers + 1);
}

#[test]
fn cancel_during_the_request_drops_the_answer() {
    let mut s = rgb(32, 24);
    let mock = install(&mut s, MockBackend::connected());
    select(&mut s, 4, 4, 8, 8);
    let (rev, layers) = (revision(&s), layer_count(&s));
    // Inline: the job's cancel arrives while the backend answers.
    let ctx = JobCtx::new();
    s.set_inline_job_ctx(Some(ctx.clone()));
    let c = ctx.clone();
    mock.set_hook(Some(Arc::new(move || c.cancel())));
    assert!(matches!(s.execute("ai.generativeFill", json!({"prompt": "x"})), Err(EngineError::Cancelled)));
    assert_eq!(mock.calls().len(), 1, "the request went out");
    assert_eq!((revision(&s), layer_count(&s)), (rev, layers), "its answer was dropped");
    mock.set_hook(None);
    s.set_inline_job_ctx(None);

    // In the background: Cancel while the request waits.
    mock.set_delay(Duration::from_millis(2000));
    let Started::Job(id) = s.start("ai.generativeFill", json!({"prompt": "x"})).unwrap() else { panic!("expected a job") };
    // The document is locked while it runs.
    assert!(s.disabled_reason("layer.new.layer").is_some());
    assert!(s.cancel_job(id));
    assert!(matches!(s.wait_job(id), Err(EngineError::Cancelled)));
    assert_eq!((revision(&s), layer_count(&s)), (rev, layers));
}

#[test]
fn in_the_background_the_result_lands_as_one_step() {
    let mut s = rgb(32, 24);
    let mock = install(&mut s, MockBackend::connected());
    mock.set_delay(Duration::from_millis(30));
    select(&mut s, 4, 4, 8, 8);
    let past = steps(&s);
    let Started::Job(id) = s.start("ai.generativeFill", json!({"prompt": "x"})).unwrap() else { panic!("expected a job") };
    let r = s.wait_job(id).unwrap();
    assert_eq!(r["layers"].as_array().map(Vec::len), Some(1));
    assert_eq!(steps(&s), past + 1);
    assert_eq!(undo_label(&s).as_deref(), Some("Generative Fill"));
}

#[test]
fn expand_grows_the_canvas_and_fills_the_new_band_in_one_step() {
    let mut s = rgb(40, 30);
    let mock = install(&mut s, MockBackend::connected());
    let before = composite(&s);
    let past = steps(&s);
    let r = s.execute("ai.generativeExpand", json!({"width": 60, "anchor": "left"})).unwrap();
    let d = s.active().unwrap();
    assert_eq!((d.doc.size.width, d.doc.size.height), (60, 30));
    assert_eq!(r["offset"], json!([0, 0]));
    assert_eq!(steps(&s), past + 1, "Canvas Size and the fill are one step");
    assert_eq!(undo_label(&s).as_deref(), Some("Generative Expand"));
    assert_eq!(top(&s).name, "Generative Expand");
    let c = &mock.calls()[0];
    assert_eq!((c.width, c.height), (60, 30));
    assert_eq!(c.prompt, super::expand::DEFAULT_PROMPT);
    let cov = c.mask_coverage.unwrap();
    assert!((cov - 1.0 / 3.0).abs() < 0.02, "the band: {cov}");
    let after = composite(&s);
    for y in 0..30 {
        for x in 0..60 {
            let p = after[y * 60 + x];
            if x < 40 {
                assert_eq!(p, before[y * 40 + x], "({x}, {y}) of the old canvas");
            } else {
                assert_eq!(p, [1.0, 0.0, 0.0, 1.0], "({x}, {y}) of the band");
            }
        }
    }
    s.execute("edit.undo", json!({})).unwrap();
    assert_eq!(s.active().unwrap().doc.size.width, 40);
    assert_eq!(composite(&s), before);
    s.execute("edit.redo", json!({})).unwrap();
    assert_eq!(composite(&s), after);

    // A centred expansion moves the old canvas.
    let mut s = rgb(40, 30);
    install(&mut s, MockBackend::connected());
    let r = s.execute("ai.generativeExpand", json!({"width": 50, "height": 40, "prompt": "more sky"})).unwrap();
    assert_eq!(r["offset"], json!([5, 5]));
    assert_eq!(composite(&s)[(5 * 50 + 5) as usize], before[0]);
}

#[test]
fn expand_without_a_larger_size_fills_the_transparency_or_says_there_is_none() {
    let mut s = rgb(30, 20);
    let mock = install(&mut s, MockBackend::connected());
    let rev = revision(&s);
    let e = s.execute("ai.generativeExpand", json!({})).unwrap_err();
    assert!(e.to_string().starts_with("Nothing to expand"), "{e}");
    assert!(mock.calls().is_empty());
    assert_eq!(revision(&s), rev);

    // A transparent document with a painted left half: the right half is filled.
    let mut s = Session::new();
    s.execute("file.new", json!({"width": 30, "height": 20, "background": "transparent"})).unwrap();
    let mock = install(&mut s, MockBackend::connected());
    select(&mut s, 0, 0, 15, 20);
    s.execute("edit.fill", json!({"contents": "color", "color": "#0000ff"})).unwrap();
    s.execute("select.deselect", json!({})).unwrap();
    s.execute("ai.generativeExpand", json!({})).unwrap();
    let c = &mock.calls()[0];
    assert!((c.mask_coverage.unwrap() - 0.5).abs() < 0.02);
    let after = composite(&s);
    assert_eq!(after[5 * 30 + 25], [1.0, 0.0, 0.0, 1.0]);
    assert_eq!(after[5 * 30 + 5], [0.0, 0.0, 1.0, 1.0]);
}

#[test]
fn generate_image_makes_a_layer_or_a_new_document() {
    let mut s = rgb(40, 30);
    let mock = install(&mut s, MockBackend::connected());
    let past = steps(&s);
    let r = s.execute("ai.generateImage", json!({"prompt": "a cat"})).unwrap();
    assert_eq!(steps(&s), past + 1);
    assert_eq!(undo_label(&s).as_deref(), Some("Generate Image"));
    let l = top(&s);
    assert_eq!(l.name, "Generated 1");
    assert_eq!(r["layer"], json!(l.id.0));
    assert_eq!(l.surface().unwrap().content_bounds(), Rect::new(0, 0, 40, 30));
    let c = &mock.calls()[0];
    assert_eq!((c.op, c.width, c.height, c.transparent), ("generate", 40, 30, false));

    // A new document of the size asked, scaled from what was asked of the provider.
    let docs = s.documents().len();
    s.execute(
        "ai.generateImage",
        json!({"prompt": "a very wide panorama of a mountain range at dawn", "target": "document", "width": 4096, "height": 1024, "transparent": true}),
    )
    .unwrap();
    assert_eq!(s.documents().len(), docs + 1);
    let c = &mock.calls()[1];
    assert_eq!((c.width, c.height, c.transparent), (2048, 512, true));
    let d = s.active().unwrap();
    assert_eq!((d.doc.size.width, d.doc.size.height), (4096, 1024));
    assert_eq!(d.doc.layers.len(), 1);
    assert_eq!(d.doc.layers[0].name, "Generated");
    assert_eq!(d.doc.layers[0].surface().unwrap().rgba(4095, 1023), [1.0, 0.0, 0.0, 1.0]);
    assert_eq!(d.doc.name, "a very wide panorama of a mountain range");
    assert_eq!(undo_label(&s).as_deref(), Some("Generate Image"));
    let info = s.execute("file.fileInfo", json!({})).unwrap();
    assert_eq!(info["description"], json!("a very wide panorama of a mountain range at dawn"));
    // Undo leaves the empty new document.
    s.execute("edit.undo", json!({})).unwrap();
    assert!(s.active().unwrap().doc.layers[0].surface().unwrap().content_bounds().is_empty());

    // Without a document it makes one, 1024 px square by default.
    let mut s = Session::new();
    let mock = install(&mut s, MockBackend::connected());
    assert!(s.is_enabled("ai.generateImage"));
    s.execute("ai.generateImage", json!({"prompt": "x"})).unwrap();
    assert_eq!(s.documents().len(), 1);
    assert_eq!((mock.calls()[0].width, mock.calls()[0].height), (1024, 1024));
    assert!(Session::new().execute("ai.generateImage", json!({"prompt": "x", "target": "layer"})).is_err());
}

/// A textured disc on a noisy background, as `layer.removeBackground`'s tests use.
fn disc() -> Session {
    let mut rng = photocraft_algo::segment::Rng::new(2);
    let nz: Vec<f32> = (0..200 * 160).map(|_| rng.normal()).collect();
    let mut s = Session::new();
    s.execute("file.new", json!({"width": 200, "height": 160})).unwrap();
    s.edit("paint", |doc, _| {
        let bg = doc.layers[0].surface_mut().unwrap();
        let alpha = bg.format().alpha;
        let mut data = Vec::new();
        for y in 0..160u32 {
            for x in 0..200u32 {
                let n = 0.05 * nz[(y * 200 + x) as usize];
                let (dx, dy) = (x as f32 + 0.5 - 100.0, y as f32 + 0.5 - 80.0);
                let c = if dx * dx + dy * dy <= 45.0 * 45.0 {
                    let t = ((x + y) as f32 * 0.35).sin() * 0.5 + 0.5;
                    [0.85 + 0.05 * t + n, 0.2 + 0.3 * t + n, 0.15 + n]
                } else {
                    [0.25 + n, 0.45 + n, 0.7 + n]
                };
                data.extend(c.map(|v| v.clamp(0.0, 1.0)));
                if alpha {
                    data.push(1.0);
                }
            }
        }
        bg.write_region(Rect::new(0, 0, 200, 160), &data);
        Ok(())
    })
    .unwrap();
    s
}

#[test]
fn remove_background_local_masks_the_layer_in_place_and_sends_nothing() {
    let mut s = disc();
    let mock = install(&mut s, MockBackend::connected());
    let id = s.active().unwrap().active_layer.unwrap();
    let past = steps(&s);
    let r = s.execute("ai.removeBackground", json!({})).unwrap();
    assert_eq!((r["layer"].clone(), r["method"].clone()), (json!(id.0), json!("local")));
    assert_eq!(steps(&s), past + 1);
    assert_eq!(undo_label(&s).as_deref(), Some("Remove Background"));
    let l = s.active().unwrap().doc.layer(id).unwrap();
    let m = l.mask.as_ref().unwrap();
    assert!(m.value(100, 80) > 0.8 && m.value(2, 2) < 0.2);
    assert_eq!(layer_count(&s), 1, "in place, no copy");
    assert!(mock.calls().is_empty());
    // It needs no backend at all.
    let mut s = disc();
    s.execute("ai.removeBackground", json!({"method": "local"})).unwrap();
    assert!(s.active().unwrap().doc.layers[0].mask.is_some());
    // A flat layer has no subject: the same refusal as Layer › Remove Background.
    let mut s = rgb(32, 32);
    s.edit("flat", |doc, _| {
        doc.layers[0].surface_mut().unwrap().fill_rect(Rect::new(0, 0, 32, 32), &[0.5, 0.5, 0.5, 1.0]);
        Ok(())
    })
    .unwrap();
    let rev = revision(&s);
    assert!(s.execute("ai.removeBackground", json!({})).is_err());
    assert_eq!(revision(&s), rev);
}

#[test]
fn remove_background_by_provider_masks_by_the_returned_subject_within_the_old_mask() {
    let mut s = rgb(40, 30);
    let mock = install(&mut s, MockBackend::connected());
    s.execute("layer.new.layerFromBackground", json!({})).unwrap();
    let id = s.active().unwrap().active_layer.unwrap();
    // The layer's own mask already hides x < 15.
    s.edit("mask", |doc, _| {
        let bytes: Vec<u8> = (0..30).flat_map(|_| (0..40).map(|x| if x < 15 { 0 } else { 255 })).collect();
        doc.layer_mut(id).unwrap().mask = Some(LayerMask {
            surface: Surface::from_interleaved(photocraft_color::PixelFormat::GRAY8, Rect::new(0, 0, 40, 30), &bytes),
            ..LayerMask::reveal_all()
        });
        Ok(())
    })
    .unwrap();
    let pixels = s.active().unwrap().doc.layer(id).unwrap().surface().unwrap().read_region(Rect::new(0, 0, 40, 30));
    mock.push(MockAnswer::Pattern(|x, y| if (10..30).contains(&x) && (8..22).contains(&y) { [0, 0, 0, 255] } else { [0, 0, 0, 0] }));
    let past = steps(&s);
    let r = s.execute("ai.removeBackground", json!({"method": "provider"})).unwrap();
    assert_eq!(r["method"], json!("provider"));
    assert_eq!(steps(&s), past + 1);
    assert_eq!(undo_label(&s).as_deref(), Some("Remove Background"));
    let c = &mock.calls()[0];
    assert_eq!((c.op, c.width, c.height, c.transparent, c.mask_coverage), ("edit", 40, 30, true, None));
    assert_eq!(c.prompt, super::background::PROMPT);
    let l = s.active().unwrap().doc.layer(id).unwrap();
    let m = l.mask.as_ref().unwrap();
    assert_eq!(m.value(12, 15), 0.0, "the old mask still hides it");
    assert_eq!(m.value(20, 15), 1.0, "the subject");
    assert_eq!(m.value(35, 15), 0.0, "the background");
    assert_eq!(l.surface().unwrap().read_region(Rect::new(0, 0, 40, 30)), pixels, "the pixels are untouched");
    assert_eq!(layer_count(&s), 1);

    // An opaque answer on white is keyed off its border; the Background becomes a layer.
    let mut s = rgb(40, 30);
    let mock = install(&mut s, MockBackend::connected());
    mock.push(MockAnswer::Pattern(|x, y| if (10..30).contains(&x) && (8..22).contains(&y) { [10, 10, 10, 255] } else { [255, 255, 255, 255] }));
    s.execute("ai.removeBackground", json!({"method": "provider", "provider": "gemini"})).unwrap();
    assert_eq!(mock.calls()[0].provider, Some(ProviderId::Gemini));
    let l = &s.active().unwrap().doc.layers[0];
    assert_eq!(l.name, "Layer 0");
    let m = l.mask.as_ref().unwrap();
    assert_eq!((m.value(20, 15), m.value(2, 2)), (1.0, 0.0));
}

#[test]
fn generate_background_keeps_the_subject_and_fills_around_it() {
    let mut s = Session::new();
    s.execute("file.new", json!({"width": 40, "height": 30, "background": "transparent"})).unwrap();
    let mock = install(&mut s, MockBackend::connected());
    select(&mut s, 10, 8, 20, 14);
    s.execute("edit.fill", json!({"contents": "color", "color": "#00ff00"})).unwrap();
    s.execute("select.deselect", json!({})).unwrap();
    let subject = s.active().unwrap().active_layer.unwrap();
    let before = composite(&s);
    let past = steps(&s);
    s.execute("ai.replaceBackground", json!({"prompt": "a beach"})).unwrap();
    assert_eq!(steps(&s), past + 1);
    assert_eq!(undo_label(&s).as_deref(), Some("Generate Background"));
    let c = &mock.calls()[0];
    let want = 1.0 - (20.0 * 14.0) / (40.0 * 30.0);
    assert!((c.mask_coverage.unwrap() - want).abs() < 0.01, "{:?}", c.mask_coverage);
    let l = top(&s);
    assert_eq!(l.name, "Generate Background");
    assert_eq!((alpha_at(l, 20, 15), alpha_at(l, 2, 2)), (0.0, 1.0));
    // The subject is untouched and still shows.
    let after = composite(&s);
    assert_eq!(after[15 * 40 + 20], before[15 * 40 + 20]);
    assert!(s.active().unwrap().doc.layer(subject).is_some());
}

/// A blue sky over brown ground, as Select › Sky's tests use.
fn landscape(mode: &str, depth: u64) -> Session {
    let mut s = Session::new();
    s.execute("file.new", json!({"width": 160, "height": 100, "mode": mode, "depth": depth})).unwrap();
    s.edit("paint", |doc, active| {
        let surf = doc.layer_mut(active.unwrap()).unwrap().surface_mut().unwrap();
        let fmt = surf.format();
        for y in 0..100 {
            for x in 0..160 {
                let nz = (((x * 7919 + y * 104_729) % 97) as f32 / 97.0 - 0.5) * 0.25;
                let c = if y < 60 {
                    let t = y as f32 / 60.0;
                    [0.25 + 0.4 * t, 0.5 + 0.3 * t, 0.9 + 0.05 * t]
                } else {
                    [0.35 + nz, 0.3 + nz, 0.15]
                };
                surf.write_pixel(x, y, &photocraft_raster::from_rgba(&fmt, [c[0], c[1], c[2], 1.0]));
            }
        }
        Ok(())
    })
    .unwrap();
    s
}

#[test]
fn sky_replacement_fills_the_selection_or_the_sky_it_finds() {
    // With a selection: exactly there.
    let mut s = rgb(48, 32);
    let mock = install(&mut s, MockBackend::connected());
    select(&mut s, 0, 0, 48, 10);
    let before = composite(&s);
    s.execute("ai.replaceSky", json!({"prompt": "storm clouds"})).unwrap();
    assert_eq!(undo_label(&s).as_deref(), Some("Sky Replacement"));
    assert_eq!(top(&s).name, "Sky Replacement");
    let after = composite(&s);
    assert_same_outside(&before, &after, 48, Rect::new(0, 0, 48, 13), "sky");
    assert_eq!(after[2 * 48 + 20], [1.0, 0.0, 0.0, 1.0]);
    assert!((mock.calls()[0].mask_coverage.unwrap() - 10.0 / 32.0).abs() < 0.03);

    // Without one: Select › Sky's sky, in RGB and in CMYK.
    for mode in ["rgb", "cmyk"] {
        let mut s = landscape(mode, 8);
        install(&mut s, MockBackend::connected());
        s.execute("ai.replaceSky", json!({"prompt": "storm clouds"})).unwrap_or_else(|e| panic!("{mode}: {e}"));
        let l = top(&s);
        assert!(alpha_at(l, 10, 10) > 0.9, "{mode}: sky");
        assert!(alpha_at(l, 10, 90) < 0.1, "{mode}: ground");
    }

    // No sky: refused before anything is sent.
    let mut s = Session::new();
    s.execute("file.new", json!({"width": 40, "height": 40, "background": "black"})).unwrap();
    let mock = install(&mut s, MockBackend::connected());
    let rev = revision(&s);
    let e = s.execute("ai.replaceSky", json!({"prompt": "x"})).unwrap_err();
    assert!(e.to_string().contains("No sky"), "{e}");
    assert!(mock.calls().is_empty());
    assert_eq!(revision(&s), rev);
}

#[test]
fn describe_answers_text_and_changes_nothing() {
    let mut s = rgb(40, 30);
    let mock = install(&mut s, MockBackend::connected());
    mock.push(MockAnswer::Text("  A patterned square.\n".into()));
    let rev = revision(&s);
    let journal = s.journal.len();
    let r = s.execute("ai.describe", json!({})).unwrap();
    assert_eq!(r, json!({"text": "A patterned square.", "provider": "openai"}));
    assert_eq!(revision(&s), rev);
    assert_eq!(s.journal.len(), journal, "a query is not journaled");
    let c = &mock.calls()[0];
    assert_eq!((c.op, c.width, c.height, c.prompt.as_str()), ("describe", 40, 30, ""));
    mock.push(MockAnswer::Text("   ".into()));
    assert_eq!(kind_of(&s.execute("ai.describe", json!({"prompt": "What colour is it?"})).unwrap_err()), kind::BAD_RESPONSE);
    assert_eq!(mock.calls()[1].prompt, "What colour is it?");
    // A big document goes out at 1024 px at most.
    let mut s = rgb(3000, 600);
    let mock = install(&mut s, MockBackend::connected());
    s.execute("ai.describe", json!({})).unwrap();
    assert_eq!((mock.calls()[0].width, mock.calls()[0].height), (1024, 205));
}

/// However long the provider's answer, Describe returns at most 20,000 characters, cut at a
/// character and ending in an ellipsis, so the window, the CLI, MCP and the XMP all get a text of
/// a sensible size.
#[test]
fn describe_bounds_the_answer() {
    let mut s = rgb(40, 30);
    let mock = install(&mut s, MockBackend::connected());
    mock.push(MockAnswer::Text("é".repeat(1_000_000)));
    let r = s.execute("ai.describe", json!({})).unwrap();
    let text = r["text"].as_str().unwrap();
    assert_eq!(text.chars().count(), 20_000);
    assert!(text.ends_with('…') && text.starts_with("éé"));
    // An answer within the limit is untouched.
    let fits = "é".repeat(20_000);
    mock.push(MockAnswer::Text(fits.clone()));
    assert_eq!(s.execute("ai.describe", json!({})).unwrap()["text"], fits);
    // Control characters (no place in XMP) go; line breaks and tabs stay.
    mock.push(MockAnswer::Text("A\u{0}B\u{1b}[2J\r\nC\tD".into()));
    assert_eq!(s.execute("ai.describe", json!({})).unwrap()["text"], "AB[2J\nC\tD");
}

#[test]
fn status_never_returns_a_key() {
    let mut s = Session::new();
    let mock = install(&mut s, MockBackend::connected());
    // Even a backend that put the whole key in its hint shows only the last four characters.
    let mut st = mock.status();
    st.providers[0].hint = Some(MockBackend::SECRET.into());
    mock.set_status(st);
    let r = s.execute("ai.status", json!({})).unwrap();
    let text = r.to_string();
    assert!(!text.contains(MockBackend::SECRET) && !text.contains("0123456789"), "{text}");
    assert_eq!(r["installed"], json!(true));
    assert_eq!(r["consented"], json!(true));
    assert_eq!(r["defaultProvider"], json!("openai"));
    let p = &r["providers"][0];
    assert_eq!(p["hint"], json!("…cdef"));
    assert_eq!(p["id"], json!("openai"));
    assert_eq!(p["imageModel"], json!("gpt-image-1"));
    let keys: Vec<&String> = p.as_object().unwrap().keys().collect();
    assert_eq!(keys.len(), 9, "{keys:?}");
}

#[test]
fn test_connection_lists_models_without_consent_but_needs_a_key() {
    let mut s = Session::new();
    let mock = install(&mut s, MockBackend::connected());
    mock.set_consented(false);
    let r = s.execute("ai.testConnection", json!({"provider": "gemini"})).unwrap();
    assert_eq!(r["provider"], json!("gemini"));
    assert_eq!(r["models"], json!([{"id": "mock-chat", "kind": "text"}, {"id": "mock-image", "kind": "image"}]));
    assert_eq!(mock.calls()[0].op, "models");
    mock.set_status(MockBackend::disconnected().status());
    assert_eq!(kind_of(&s.execute("ai.testConnection", json!({})).unwrap_err()), kind::MISSING_KEY);
}

#[test]
fn a_chat_only_sign_in_never_runs_image_models() {
    let mut s = rgb(30, 20);
    let mock = install(&mut s, MockBackend::connected());
    let chat_only = |id| ProviderStatus { connected: true, image_capable: false, chat_capable: true, ..ProviderStatus::disconnected(id) };
    mock.set_status(BackendStatus {
        providers: vec![chat_only(ProviderId::OpenAi), ProviderStatus::disconnected(ProviderId::Gemini)],
        default_provider: None,
        consented: true,
    });
    select(&mut s, 2, 2, 5, 5);
    assert_eq!(kind_of(&s.execute("ai.generativeFill", json!({"prompt": "x"})).unwrap_err()), kind::MISSING_KEY);
    s.execute("ai.describe", json!({})).unwrap();
    assert_eq!(mock.calls().len(), 1);
}

#[test]
fn ai_commands_are_not_recorded_into_actions() {
    let mut s = rgb(30, 20);
    install(&mut s, MockBackend::connected());
    select(&mut s, 2, 2, 5, 5);
    s.execute("actions.record", json!({"name": "A"})).unwrap();
    s.execute("ai.generativeFill", json!({"prompt": "x"})).unwrap();
    s.execute("image.adjustments.invert", json!({})).unwrap();
    s.execute("ai.removeBackground", json!({"method": "provider"})).unwrap_or_default();
    s.execute("actions.stop", json!({})).unwrap();
    let a = s.actions.list.actions().iter().find(|a| a.name == "A").unwrap();
    let ids: Vec<&str> = a.steps.iter().map(|step| step.command.as_str()).collect();
    assert_eq!(ids, ["image.adjustments.invert"]);
    assert!(unrecorded("ai.generativeFill", &json!({})) && !unrecorded("layer.removeBackground", &json!({})));
}

/// The local Remove Background sends nothing, so it is recorded like PhotoCraft's own
/// `layer.removeBackground`, and plays (locally) from the action.
#[test]
fn the_local_remove_background_is_recorded_and_plays() {
    let mut s = disc();
    let mock = install(&mut s, MockBackend::connected());
    s.execute("actions.record", json!({"name": "Cut out"})).unwrap();
    s.execute("ai.removeBackground", json!({"method": "local"})).unwrap();
    s.execute("actions.stop", json!({})).unwrap();
    let a = s.actions.list.actions().iter().find(|a| a.name == "Cut out").unwrap();
    assert_eq!(a.steps, vec![crate::actions_cmds::ActionStep::new("ai.removeBackground", json!({"method": "local"}))]);
    assert!(!unrecorded("ai.removeBackground", &json!({})) && unrecorded("ai.removeBackground", &json!({"method": "provider"})));
    s.execute("edit.undo", json!({})).unwrap();
    assert!(s.active().unwrap().doc.layers[0].mask.is_none());
    let played = s.execute("actions.play", json!({"action": "Cut out"})).unwrap();
    assert!(played.get("failed").is_none(), "{played}");
    assert!(s.active().unwrap().doc.layers[0].mask.is_some());
    assert!(mock.calls().is_empty());
}

#[test]
fn which_calls_may_be_billed() {
    assert!(may_send("ai.generativeFill", &json!({})));
    assert!(may_send("ai.describe", &json!({})));
    assert!(may_send("ai.removeBackground", &json!({"method": "provider"})));
    assert!(!may_send("ai.removeBackground", &json!({})));
    assert!(!may_send("ai.status", &json!({})));
    assert!(!may_send("layer.removeBackground", &json!({})));
}

/// The backend admits each caller before anything is sent, asked on the calling thread with
/// whether an automation gate is installed: an agent's own request, and a step of a script an
/// agent runs (which no interface gate sees), are refused when the backend says so, and send
/// nothing; the person running the same script is admitted.
#[test]
fn an_automated_caller_is_admitted_by_the_backend_before_anything_is_sent() {
    fn allow_all(_: &str, _: &Value) -> crate::Result<()> {
        Ok(())
    }
    let mut s = rgb(32, 24);
    let mock = install(&mut s, MockBackend::connected());
    mock.set_refuse_automated(true);
    select(&mut s, 4, 4, 8, 8);
    let (rev, layers) = (revision(&s), layer_count(&s));
    let script = json!({"steps": [{"command": "ai.generativeFill", "params": {"prompt": "x"}}]});

    // An agent's request.
    s.authorize = Some(allow_all);
    let e = s.execute("ai.generativeFill", json!({"prompt": "x"})).unwrap_err();
    assert_eq!(kind_of(&e), kind::NOT_ALLOWED, "{e}");
    let e = s.execute("ai.testConnection", json!({})).unwrap_err();
    assert_eq!(kind_of(&e), kind::NOT_ALLOWED, "{e}");
    // A step of a script the agent runs.
    let ran = s.execute("file.scripts.browse", script.clone()).unwrap();
    assert_eq!(ran["ok"], false, "{ran}");
    assert!(ran.to_string().contains("may not run AI commands"), "{ran}");
    assert!(mock.calls().is_empty(), "nothing was sent: {:?}", mock.calls());
    assert_eq!((revision(&s), layer_count(&s)), (rev, layers), "nothing changed");

    // The person running it: admitted, and the step runs.
    s.authorize = None;
    let ran = s.execute("file.scripts.browse", script).unwrap();
    assert_eq!(ran["ok"], true, "{ran}");
    assert_eq!(mock.calls().len(), 1);
    assert_eq!(mock.admitted(), vec![true, true, true, false], "asked for every call, with who asks");
}

/// Playing an action never spends money: a step that sends is refused inside an action, whoever
/// plays it (a hand-built or loaded action can hold one; recording never stores one), and inside
/// a script an event runs. The backend is not even asked, nothing is sent and nothing changes.
#[test]
fn a_step_that_sends_never_runs_from_an_action_or_an_event_script() {
    let mut s = rgb(32, 24);
    let mock = install(&mut s, MockBackend::connected());
    select(&mut s, 4, 4, 8, 8);
    let (rev, layers) = (revision(&s), layer_count(&s));
    let action = |name: &str, id: &str, p: Value| crate::actions_cmds::Action::new(name, vec![crate::actions_cmds::ActionStep::new(id, p)]);
    s.actions.list.push(action("Fill", "ai.generativeFill", json!({"prompt": "x"}))).unwrap();
    s.actions.list.push(action("Describe", "ai.describe", json!({}))).unwrap();
    s.actions.list.push(action("Cut out", "ai.removeBackground", json!({"method": "provider"}))).unwrap();
    s.actions.list.push(action("Models", "ai.testConnection", json!({}))).unwrap();
    for name in ["Fill", "Describe", "Cut out", "Models"] {
        let played = s.execute("actions.play", json!({"action": name})).unwrap();
        assert!(played["failed"]["error"].as_str().is_some_and(|m| m == super::NOT_FROM_ACTIONS), "{name}: {played}");
    }
    // An action that plays another one, and a script that plays an action.
    s.actions.list.push(action("Outer", "actions.play", json!({"action": "Fill"}))).unwrap();
    let played = s.execute("actions.play", json!({"action": "Outer"})).unwrap();
    assert!(played.to_string().contains("do not run from an action"), "{played}");
    let ran = s.execute("file.scripts.browse", json!({"steps": [["actions.play", {"action": "Fill"}]]})).unwrap();
    assert!(ran.to_string().contains("do not run from an action"), "{ran}");
    // A script bound to an event: New Document fires it.
    s.execute(
        "file.scripts.scriptEventsManager",
        json!({"enabled": true, "add": {"event": "newDocument", "name": "Greeter", "steps": [["ai.generateImage", {"prompt": "x", "target": "document"}]]}}),
    )
    .unwrap();
    let docs = s.documents().len();
    s.execute("file.new", json!({"width": 8, "height": 8})).unwrap();
    assert_eq!(s.documents().len(), docs + 1, "only the document asked for");
    let log = s.file_menu.event_log.last().cloned().unwrap_or_default();
    assert!(log.to_string().contains("do not run from an action"), "{log}");
    s.execute("file.close", json!({"save": false})).ok();

    assert!(mock.calls().is_empty(), "nothing was sent: {:?}", mock.calls());
    assert!(mock.admitted().is_empty(), "refused before the backend is asked");
    assert_eq!(s.actions.playing, 0);
    // Outside an action the same command runs.
    s.execute("ai.generativeFill", json!({"prompt": "x"})).unwrap();
    assert_eq!(mock.calls().len(), 1);
    let _ = (rev, layers);
}

/// AIE-1: a new document from Generate Image takes a resolution `file.new` accepts, whatever the
/// open document holds (imported files can hold 0, NaN or more than 30,000 ppi); the request is
/// not sent only to be thrown away by the apply step.
#[test]
fn generate_image_into_a_new_document_survives_any_resolution_of_the_open_one() {
    for (dpi, want) in [(40_000.0, 30_000.0), (0.0, 72.0), (f32::NAN, 72.0), (-5.0, 72.0), (f32::INFINITY, 72.0), (300.0, 300.0)] {
        let mut s = rgb(32, 32);
        s.edit("dpi", |doc, _| {
            doc.resolution_dpi = dpi;
            Ok(())
        })
        .unwrap();
        let mock = install(&mut s, MockBackend::connected());
        mock.push(MockAnswer::Solid([255, 0, 255, 255]));
        let docs = s.documents().len();
        let r = s.execute("ai.generateImage", json!({"prompt": "a magenta box", "target": "document", "width": 64, "height": 64}));
        assert!(r.is_ok(), "{dpi} ppi: {r:?}");
        assert_eq!(mock.calls().len(), 1, "{dpi} ppi");
        assert_eq!(s.documents().len(), docs + 1, "{dpi} ppi");
        assert_eq!(s.active().unwrap().doc.resolution_dpi, want, "{dpi} ppi");
    }
}

/// AIE-2: while an AI request runs on a document, the `view.*` commands that edit the Document
/// (guides, slices, the ruler origin) are refused as any other edit is, so the paid answer is not
/// discarded as "the document changed while it ran".
#[test]
fn guides_and_slices_wait_for_a_running_request() {
    let mut s = rgb(64, 64);
    s.execute("view.newGuide", json!({"orientation": "horizontal", "position": 5})).unwrap();
    s.execute("slice.new", json!({"x": 0, "y": 0, "width": 16, "height": 16})).unwrap();
    let mock = install(&mut s, MockBackend::connected());
    mock.set_delay(Duration::from_millis(300));
    select(&mut s, 8, 8, 20, 20);
    let past = steps(&s);
    let Started::Job(id) = s.start("ai.generativeFill", json!({"prompt": "x"})).unwrap() else { panic!("expected a job") };
    let e = s.execute("view.newGuide", json!({"orientation": "vertical", "position": 10})).unwrap_err();
    assert!(matches!(e, EngineError::Disabled(..)), "{e:?}");
    assert!(e.to_string().contains("still running"), "{e}");
    let r = s.wait_job(id).unwrap();
    assert_eq!(r["layers"].as_array().map(Vec::len), Some(1));
    assert_eq!(steps(&s), past + 1);
    assert_eq!(mock.calls().len(), 1);
}

/// AIE-2's guard: no journaled `view.*` command that a running job lets through changes the
/// document it locks.
#[test]
fn every_view_command_a_running_job_allows_leaves_its_document_alone() {
    let mut s = rgb(64, 64);
    s.execute("view.newGuide", json!({"orientation": "horizontal", "position": 5})).unwrap();
    s.execute("view.newGuide", json!({"orientation": "vertical", "position": 7})).unwrap();
    s.execute("slice.new", json!({"x": 0, "y": 0, "width": 16, "height": 16})).unwrap();
    let mock = install(&mut s, MockBackend::connected());
    mock.set_delay(Duration::from_millis(3000));
    select(&mut s, 8, 8, 20, 20);
    let Started::Job(id) = s.start("ai.generativeFill", json!({"prompt": "x"})).unwrap() else { panic!("expected a job") };
    let tries = [
        json!({}),
        json!({"orientation": "vertical", "position": 10}),
        json!({"orientation": "horizontal", "index": 0, "position": 12}),
        json!({"orientation": "vertical", "index": 0}),
        json!({"x": 3, "y": 4}),
        json!({"on": true}),
        json!({"on": false}),
        json!({"columns": 2, "rows": 2}),
        json!({"x": 3, "y": 4, "index": 0}),
    ];
    let mut allowed = Vec::new();
    for spec in crate::commands::command_specs().iter().filter(|c| c.id.starts_with("view.") && c.journal) {
        for p in &tries {
            let before = Arc::downgrade(&s.active().unwrap().doc);
            let r = s.execute(spec.id, p.clone());
            if let Err(e) = &r
                && e.to_string().contains("still running")
            {
                continue;
            }
            allowed.push(spec.id);
            assert!(before.upgrade().is_some_and(|b| Arc::ptr_eq(&b, &s.active().unwrap().doc)), "{} {p} changed the locked document: {r:?}", spec.id);
        }
    }
    assert!(!allowed.is_empty());
    assert!(s.cancel_job(id));
    let _ = s.wait_job(id);
}

/// AIE-3: a later variation failing keeps the variations already received (and billed); they land
/// as one step and the result says what failed. Cancel still drops everything.
#[test]
fn a_failed_variation_keeps_the_ones_received() {
    let mut s = rgb(40, 30);
    let mock = install(&mut s, MockBackend::connected());
    mock.push(MockAnswer::Solid([0, 255, 0, 255]));
    mock.push(MockAnswer::Solid([0, 0, 255, 255]));
    mock.push(MockAnswer::Error { kind: "quota", message: "Your OpenAI quota is used up.".into() });
    select(&mut s, 10, 10, 10, 10);
    let (layers, past) = (layer_count(&s), steps(&s));
    let r = s.execute("ai.generativeFill", json!({"prompt": "x", "variations": 3})).unwrap();
    assert_eq!(mock.calls().len(), 3);
    assert_eq!(layer_count(&s), layers + 2);
    assert_eq!(steps(&s), past + 1);
    assert_eq!(undo_label(&s).as_deref(), Some("Generative Fill"));
    assert_eq!(r["layers"].as_array().map(Vec::len), Some(2));
    assert_eq!(r["failed"], json!({"kind": "quota", "message": "Your OpenAI quota is used up."}));
    let names: Vec<&str> = s.active().unwrap().doc.layers.iter().skip(1).map(|l| l.name.as_str()).collect();
    assert_eq!(names, ["Generative Fill 1", "Generative Fill 2"]);

    // The first failing still fails the whole request, and stops asking.
    let (layers, rev) = (layer_count(&s), revision(&s));
    mock.push(MockAnswer::Error { kind: "quota", message: "Your OpenAI quota is used up.".into() });
    let e = s.execute("ai.generativeFill", json!({"prompt": "x", "variations": 3})).unwrap_err();
    assert_eq!(kind_of(&e), "quota");
    assert_eq!(mock.calls().len(), 4);
    assert_eq!((layer_count(&s), revision(&s)), (layers, rev));

    // A cancel after one answer drops it.
    let ctx = JobCtx::new();
    s.set_inline_job_ctx(Some(ctx.clone()));
    let c = ctx.clone();
    let n = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let k = n.clone();
    mock.set_hook(Some(Arc::new(move || {
        if k.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1 {
            c.cancel();
        }
    })));
    assert!(matches!(s.execute("ai.generativeFill", json!({"prompt": "x", "variations": 3})), Err(EngineError::Cancelled)));
    assert_eq!((layer_count(&s), revision(&s)), (layers, rev));
    mock.set_hook(None);
    s.set_inline_job_ctx(None);
}

/// A pixel layer whose unlinked mask hides x < 32 with a 16 px feather.
fn feathered() -> (Session, LayerId) {
    let mut s = rgb(64, 32);
    s.execute("layer.new.layerFromBackground", json!({})).unwrap();
    let id = s.active().unwrap().active_layer.unwrap();
    s.edit("mask", |doc, _| {
        let bytes: Vec<u8> = (0..32).flat_map(|_| (0..64).map(|x| if x < 32 { 0 } else { 255 })).collect();
        doc.layer_mut(id).unwrap().mask = Some(LayerMask {
            surface: Surface::from_interleaved(photocraft_color::PixelFormat::GRAY8, Rect::new(0, 0, 64, 32), &bytes),
            feather: 16.0,
            linked: false,
            ..LayerMask::reveal_all()
        });
        Ok(())
    })
    .unwrap();
    (s, id)
}

/// AIE-4: Remove Background with AI Provider keeps a feathered mask's soft edge and the mask's
/// link.
#[test]
fn remove_background_by_provider_keeps_the_old_masks_feather_and_link() {
    let (mut s, id) = feathered();
    let alpha_row = |s: &Session| -> Vec<f32> { composite(s)[16 * 64..17 * 64].iter().map(|p| p[3]).collect() };
    let before = alpha_row(&s);
    assert!(before[31] > 0.1 && before[32] < 0.9, "the edge is soft: {:?}", &before[24..40]);
    let mock = install(&mut s, MockBackend::connected());
    mock.push(MockAnswer::Solid([10, 10, 10, 255]));
    s.execute("ai.removeBackground", json!({"method": "provider"})).unwrap();
    let after = alpha_row(&s);
    for x in 0..64 {
        assert!((after[x] - before[x]).abs() < 0.02, "x = {x}: {} before, {} after", before[x], after[x]);
    }
    let m = s.active().unwrap().doc.layer(id).unwrap().mask.clone().unwrap();
    assert!(!m.linked, "the mask stays unlinked");
}

/// AIE-4: Generate Background's subject is what the layer shows, its mask's feather included.
#[test]
fn generate_background_reads_the_subject_through_the_masks_feather() {
    let (mut s, _) = feathered();
    let mock = install(&mut s, MockBackend::connected());
    s.execute("ai.replaceBackground", json!({"prompt": "a beach"})).unwrap();
    assert_eq!(mock.calls().len(), 1);
    // The new layer fills what the subject leaves: across the old edge it fades as the
    // feathered mask does, not in one column.
    let l = top(&s);
    assert_eq!(l.name, "Generate Background");
    let (a, b) = (alpha_at(l, 31, 16), alpha_at(l, 32, 16));
    assert!(a < 0.9 && b > 0.1, "a hard edge: {a} at x = 31, {b} at x = 32");
    // Far from the edge the feather leaves a few per cent, as the composite shows.
    assert!(alpha_at(l, 2, 16) > 0.95 && alpha_at(l, 62, 16) < 0.05);
}
