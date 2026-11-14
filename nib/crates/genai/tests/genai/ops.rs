//! Each feature end to end against the mock server: the request sent, the document change, one
//! undo step, and Undo restoring the document. Plus jobs: cancel, consent, missing keys.

use std::time::Duration;

use nib_genai::ops::{ExpandSpec, PatternSpec, RecolorSpec, RewriteSpec, ShapeFillSpec, TextToVectorSpec, VectorMethod};
use nib_genai::prompts::{Detail, Tone, VectorKind};
use nib_genai::{ErrorKind, FeatureRequest, ProviderKind};
use serde_json::{Value, json};
use vectorcraft_doc::{Node, NodeId, NodeKind};
use vectorcraft_engine::Session;

use crate::common::{
    MockServer, Reply, SVG, exec, gemini_image, gemini_text, genai, generate_and_apply, openai_image, openai_text, png, select, session, snapshot,
    undo_steps,
};

fn walk<'a>(n: &'a Node, out: &mut Vec<&'a Node>) {
    out.push(n);
    if let Some(children) = n.children() {
        for c in children {
            walk(c, out);
        }
    }
}

fn count(s: &Session, f: impl Fn(&NodeKind) -> bool) -> usize {
    let st = s.doc().unwrap();
    let mut all = vec![];
    for l in &st.doc.layers {
        walk(l, &mut all);
    }
    all.into_iter().filter(|n| f(&n.kind)).count()
}

fn node(s: &Session, id: u64) -> Node {
    s.doc().unwrap().doc.node(NodeId(id)).unwrap().clone()
}

fn bounds(s: &Session, id: u64) -> vectorcraft_geom::Rect {
    node(s, id).geometric_bounds().unwrap()
}

/// Applying took one undo step, and Undo gives back `before`.
fn undoes_to(s: &mut Session, before: &Value, steps_before: usize) {
    assert_eq!(undo_steps(s), steps_before + 1, "one undo step");
    exec(s, "edit.undo", json!({}));
    assert_eq!(&snapshot(s), before, "Undo restores the document");
}

fn rect(s: &mut Session, x: f64, y: f64, w: f64, h: f64, color: &str) -> u64 {
    let id = exec(s, "shape.rectangle", json!({"x": x, "y": y, "width": w, "height": h}))["id"].as_u64().unwrap();
    exec(s, "paint.setFill", json!({"ids": [id], "color": color}));
    id
}

fn fenced(svg: &str) -> String {
    format!("Here is your art:\n```svg\n{svg}\n```")
}

#[test]
fn text_to_vector_svg() {
    let server = MockServer::replies(vec![Reply::ok(openai_text(&fenced(SVG)))]);
    let mut g = genai(&server);
    let mut s = session();
    // The person's clipboard survives the paste the placement makes.
    let keep = rect(&mut s, 0.0, 0.0, 10.0, 10.0, "#00ff00");
    select(&mut s, &[keep]);
    exec(&mut s, "edit.copy", json!({}));
    let clipboard = s.clipboard.clone();
    exec(&mut s, "select.set", json!({"ids": []}));
    let (before, steps) = (snapshot(&s), undo_steps(&s));
    let spec = TextToVectorSpec { prompt: "a fox at dusk".into(), kind: VectorKind::Subject, variations: 2, ..Default::default() };
    let applied = generate_and_apply(&mut g, &mut s, &FeatureRequest::TextToVector(spec), ProviderKind::OpenAi);
    let got = server.requests();
    assert_eq!(got.len(), 2, "one request per variation");
    let body = got[0].json();
    assert_eq!(got[0].path, "/v1/responses");
    assert!(body["instructions"].as_str().unwrap().contains("standalone SVG"));
    assert!(body["input"][0]["content"][0]["text"].as_str().unwrap().contains("a fox at dusk"));
    let [id] = applied.ids.as_slice() else { panic!("{applied:?}") };
    assert!(matches!(node(&s, *id).kind, NodeKind::Group { clip: false, .. }));
    // Fitted into the artboard with a margin (400 × 300 less 10% of 300 on each side).
    let b = bounds(&s, *id);
    assert!(b.x0 >= 29.9 && b.x1 <= 370.1 && b.y0 >= 29.9 && b.y1 <= 270.1, "{b:?}");
    assert!((b.width() - 340.0).abs() < 0.5, "the width fills the area: {b:?}");
    assert_eq!(s.doc().unwrap().selection.objects, vec![NodeId(*id)]);
    assert_eq!(s.clipboard, clipboard);
    let label = s.doc().unwrap().history.undo.last().unwrap().label.clone();
    assert_eq!(label, "Text to Vector Graphic");
    undoes_to(&mut s, &before, steps);
    assert!(g.jobs.running().is_empty());
}

#[test]
fn text_to_vector_into_the_selection_area_with_a_style_reference() {
    let server = MockServer::replies(vec![Reply::ok(openai_text(SVG))]);
    let mut g = genai(&server);
    let mut s = session();
    let r = rect(&mut s, 50.0, 50.0, 100.0, 100.0, "#336699");
    select(&mut s, &[r]);
    let spec = TextToVectorSpec {
        prompt: "an owl".into(),
        kind: VectorKind::Icon,
        style_reference: true,
        palette: vec!["#ABCDEF".into(), "junk".into()],
        ..Default::default()
    };
    let applied = generate_and_apply(&mut g, &mut s, &FeatureRequest::TextToVector(spec), ProviderKind::OpenAi);
    let body = server.requests()[0].json();
    let content = &body["input"][0]["content"];
    assert_eq!(content[1]["type"], "input_image", "the selection goes as a style reference");
    let prompt = content[0]["text"].as_str().unwrap();
    assert!(prompt.contains("#abcdef") && !prompt.contains("junk"), "{prompt}");
    let b = bounds(&s, applied.ids[0]);
    assert!(b.x0 >= 49.9 && b.x1 <= 150.1 && (b.width() - 100.0).abs() < 0.5, "into the selection's area: {b:?}");
}

/// A 64 × 64 PNG: white with a red square in the middle.
fn red_square() -> Vec<u8> {
    png(64, 64, |x, y| if (16..48).contains(&x) && (16..48).contains(&y) { [220, 30, 30, 255] } else { [255, 255, 255, 255] })
}

#[test]
fn text_to_vector_image_and_trace() {
    let server = MockServer::replies(vec![Reply::ok(gemini_image(&red_square()))]);
    let mut g = genai(&server);
    let mut s = session();
    let (before, steps) = (snapshot(&s), undo_steps(&s));
    let spec = TextToVectorSpec {
        prompt: "a red box".into(),
        kind: VectorKind::Icon,
        detail: Detail::Low,
        method: VectorMethod::ImageTrace,
        ..Default::default()
    };
    let applied = generate_and_apply(&mut g, &mut s, &FeatureRequest::TextToVector(spec), ProviderKind::Gemini);
    let r = &server.requests()[0];
    assert_eq!(r.path, "/v1/models/gemini-2.5-flash-image:generateContent");
    // The artboard less its margin is 340 × 240: nearest 3:2.
    assert_eq!(r.json()["generationConfig"]["imageConfig"]["aspectRatio"], "3:2");
    assert_eq!(count(&s, |k| matches!(k, NodeKind::Image(_))), 0, "the traced image is expanded into paths");
    assert!(count(&s, |k| matches!(k, NodeKind::Path { .. })) >= 1);
    assert!(!applied.ids.is_empty());
    undoes_to(&mut s, &before, steps);
}

fn colors(s: &mut Session, ids: &[u64]) -> Vec<String> {
    let v = exec(s, "recolor.colors", json!({"ids": ids}));
    // The rectangles' default black stroke is left as it is (Recolor keeps black by default).
    let mut c: Vec<String> =
        v["colors"].as_array().unwrap().iter().map(|c| c["hex"].as_str().unwrap().to_lowercase()).filter(|h| h != "#000000").collect();
    c.sort();
    c
}

#[test]
fn generative_recolor() {
    let palettes = json!({"palettes": [
        {"name": "Ember", "colors": ["#330000", "#ffcc99"]},
        {"name": "Moss", "colors": ["#ccffcc", "#003300"]}
    ]});
    let server = MockServer::replies(vec![Reply::ok(openai_text(&palettes.to_string()))]);
    let mut g = genai(&server);
    let mut s = session();
    let a = rect(&mut s, 0.0, 0.0, 50.0, 50.0, "#ff0000");
    let b = rect(&mut s, 60.0, 0.0, 50.0, 50.0, "#0000ff");
    select(&mut s, &[a, b]);
    let (before, steps) = (snapshot(&s), undo_steps(&s));
    let spec = RecolorSpec { prompt: "a forest".into(), samples: vec!["calm".into()], variations: 2 };
    let id = g.start(&mut s, &FeatureRequest::Recolor(spec), Some(ProviderKind::OpenAi)).unwrap();
    let e = g.wait(id, Duration::from_secs(30)).unwrap();
    assert!(e.result.is_ok(), "{:?}", e.result);
    let body = server.requests()[0].json();
    assert_eq!(body["text"]["format"]["type"], "json_object");
    let prompt = body["input"][0]["content"][0]["text"].as_str().unwrap();
    assert!(prompt.contains("a forest") && prompt.contains("exactly 2") && prompt.contains("calm"), "{prompt}");
    let result = g.result(id).unwrap();
    assert_eq!(result.variations(), 2);
    assert!(result.summary()["previews"][1]["name"] == "Moss", "{}", result.summary());
    g.apply(&mut s, id, 1).unwrap();
    assert_eq!(colors(&mut s, &[a, b]), vec!["#003300", "#ccffcc"]);
    // Blue is the darker row: it takes the darker colour.
    assert_eq!(colors(&mut s, &[b]), vec!["#003300"]);
    undoes_to(&mut s, &before, steps);
    assert_eq!(colors(&mut s, &[a, b]), vec!["#0000ff", "#ff0000"]);
    // Variation 0 after the undo.
    g.apply(&mut s, id, 0).unwrap();
    assert_eq!(colors(&mut s, &[a, b]), vec!["#330000", "#ffcc99"]);
    assert_eq!(g.apply(&mut s, id, 7).unwrap_err().kind, ErrorKind::BadRequest);
}

#[test]
fn generative_shape_fill() {
    let server = MockServer::replies(vec![Reply::ok(openai_text(SVG))]);
    let mut g = genai(&server);
    let mut s = session();
    let shape = rect(&mut s, 100.0, 80.0, 120.0, 60.0, "#884422");
    exec(&mut s, "shape.rectangle", json!({"x": 300, "y": 10, "width": 10, "height": 10}));
    select(&mut s, &[shape]);
    let (before, steps) = (snapshot(&s), undo_steps(&s));
    let spec = ShapeFillSpec { prompt: "autumn leaves".into(), use_shape_colors: true, ..Default::default() };
    let applied = generate_and_apply(&mut g, &mut s, &FeatureRequest::ShapeFill(spec), ProviderKind::OpenAi);
    let prompt = server.requests()[0].json()["input"][0]["content"][0]["text"].as_str().unwrap().to_string();
    assert!(prompt.contains("edge to edge") && prompt.contains("landscape"), "{prompt}");
    let [group] = applied.ids.as_slice() else { panic!("{applied:?}") };
    let n = node(&s, *group);
    let NodeKind::Group { clip: true, children } = &n.kind else { panic!("a clip group: {:?}", n.kind_label()) };
    assert_eq!(children.len(), 2, "the shape clips the art");
    let b = n.geometric_bounds().unwrap();
    assert!((b.x0 - 100.0).abs() < 0.5 && (b.x1 - 220.0).abs() < 0.5 && (b.y0 - 80.0).abs() < 0.5 && (b.y1 - 140.0).abs() < 0.5, "{b:?}");
    undoes_to(&mut s, &before, steps);
}

#[test]
fn shape_fill_needs_one_closed_path() {
    let server = MockServer::replies(vec![Reply::ok(openai_text(SVG))]);
    let mut g = genai(&server);
    let mut s = session();
    let req = FeatureRequest::ShapeFill(ShapeFillSpec { prompt: "x".into(), ..Default::default() });
    assert_eq!(g.start(&mut s, &req, None).unwrap_err().kind, ErrorKind::Document);
    let a = rect(&mut s, 0.0, 0.0, 10.0, 10.0, "#000000");
    let b = rect(&mut s, 20.0, 0.0, 10.0, 10.0, "#000000");
    select(&mut s, &[a, b]);
    assert_eq!(g.start(&mut s, &req, None).unwrap_err().kind, ErrorKind::Document);
    let t = exec(&mut s, "text.create", json!({"x": 10, "y": 100, "text": "Hi"}))["id"].as_u64().unwrap();
    select(&mut s, &[t]);
    assert_eq!(g.start(&mut s, &req, None).unwrap_err().kind, ErrorKind::Document);
    assert!(server.requests().is_empty(), "nothing is sent for a selection that doesn't suit");
}

#[test]
fn generative_pattern() {
    let server = MockServer::replies(vec![Reply::ok(openai_text(SVG))]);
    let mut g = genai(&server);
    let mut s = session();
    let target = rect(&mut s, 10.0, 10.0, 200.0, 100.0, "#ffffff");
    select(&mut s, &[target]);
    let nodes = count(&s, |_| true);
    let (before, steps) = (snapshot(&s), undo_steps(&s));
    let spec = PatternSpec { prompt: "tiny lemons on blue".into(), tile_size: Some(50.0), apply_to_selection: true, ..Default::default() };
    let applied = generate_and_apply(&mut g, &mut s, &FeatureRequest::Pattern(spec), ProviderKind::OpenAi);
    let prompt = server.requests()[0].json()["input"][0]["content"][0]["text"].as_str().unwrap().to_string();
    assert!(prompt.contains("seamless") && prompt.contains("tiny lemons on blue"), "{prompt}");
    let name = applied.swatch.clone().unwrap();
    assert_eq!(name, "AI Pattern: tiny lemons on blue");
    let doc = &s.doc().unwrap().doc;
    let pattern = doc.patterns.iter().find(|p| p.name == name).expect("the pattern swatch");
    assert!((pattern.tile.width() - 50.0).abs() < 1e-6, "{:?}", pattern.tile);
    assert_eq!(count(&s, |_| true), nodes, "the tile's art isn't left on the artboard");
    assert!(matches!(node(&s, target).appearance.fill_paint(), vectorcraft_color::Paint::Pattern { .. }), "the selection takes the pattern");
    assert_eq!(applied.ids, vec![target]);
    undoes_to(&mut s, &before, steps);
}

fn place_png(s: &mut Session, data: &[u8]) -> u64 {
    exec(s, "clipboard.importImage", json!({"dataBase64": vectorcraft_format::base64_encode(data), "center": [100, 100]}));
    exec(s, "edit.pasteInPlace", json!({}))["ids"][0].as_u64().unwrap()
}

#[test]
fn generative_expand() {
    let answer = png(1536, 1024, |_, _| [0, 160, 0, 255]);
    let server = MockServer::replies(vec![Reply::ok(openai_image(&answer))]);
    let mut g = genai(&server);
    let mut s = session();
    let below = rect(&mut s, 0.0, 0.0, 5.0, 5.0, "#000000");
    let image = place_png(&mut s, &png(20, 10, |x, _| [x as u8 * 10, 0, 0, 255]));
    let above = rect(&mut s, 300.0, 0.0, 5.0, 5.0, "#000000");
    let old = bounds(&s, image);
    select(&mut s, &[image]);
    let (before, steps) = (snapshot(&s), undo_steps(&s));
    let spec = ExpandSpec { prompt: "more sky".into(), margins: [10.0, 0.0, 10.0, 0.0], fill_artboard: false };
    let applied = generate_and_apply(&mut g, &mut s, &FeatureRequest::Expand(spec), ProviderKind::OpenAi);
    let r = &server.requests()[0];
    assert_eq!(r.path, "/v1/images/edits");
    let form = r.body_text();
    assert!(form.contains("name=\"mask\"") && form.contains("1536x1024") && form.contains("more sky"), "multipart form");
    let [new] = applied.ids.as_slice() else { panic!("{applied:?}") };
    assert!(s.doc().unwrap().doc.node(NodeId(image)).is_none(), "the old image is replaced");
    let NodeKind::Image(img) = node(&s, *new).kind else { panic!("an image") };
    assert_eq!((img.width, img.height), (40, 10));
    let b = bounds(&s, *new);
    assert!((b.x0 - (old.x0 - 10.0)).abs() < 1e-6 && (b.x1 - (old.x1 + 10.0)).abs() < 1e-6, "{b:?} from {old:?}");
    assert!((b.y0 - old.y0).abs() < 1e-6 && (b.y1 - old.y1).abs() < 1e-6, "{b:?} from {old:?}");
    // In the old image's place in the stacking order.
    let doc = &s.doc().unwrap().doc;
    let (pb, ib, _) = doc.position(NodeId(below)).unwrap();
    let (pn, inew, _) = doc.position(NodeId(*new)).unwrap();
    let (_, ia, _) = doc.position(NodeId(above)).unwrap();
    assert!(pb == pn && ib < inew && inew < ia, "{ib} < {inew} < {ia}");
    // The original pixels are kept exactly.
    let blob = &doc.images[&img.key];
    let px = nib_genai::image_util::decode(&blob.bytes).unwrap();
    assert_eq!(px.get_pixel(10 + 7, 3).0, [70, 0, 0, 255]);
    assert_eq!(px.get_pixel(2, 3).0, [0, 160, 0, 255]);
    undoes_to(&mut s, &before, steps);
}

#[test]
fn expand_to_the_artboard() {
    let server = MockServer::replies(vec![Reply::ok(gemini_image(&png(1024, 768, |_, _| [9, 9, 9, 255])))]);
    let mut g = genai(&server);
    let mut s = session();
    let image = place_png(&mut s, &png(100, 50, |_, _| [200, 200, 200, 255]));
    select(&mut s, &[image]);
    let spec = ExpandSpec { fill_artboard: true, ..Default::default() };
    let applied = generate_and_apply(&mut g, &mut s, &FeatureRequest::Expand(spec), ProviderKind::Gemini);
    let b = bounds(&s, applied.ids[0]);
    assert!(b.x0 <= 0.0 + 1e-6 && b.y0 <= 1e-6 && b.x1 >= 400.0 - 1e-6 && b.y1 >= 300.0 - 1e-6, "covers the artboard: {b:?}");
    let parts = server.requests()[0].json()["contents"][0]["parts"].as_array().unwrap().len();
    assert_eq!(parts, 3, "prompt, image and mask");
}

fn text_of(s: &Session, id: u64) -> (String, Vec<(String, f64)>) {
    let NodeKind::Text(t) = node(s, id).kind else { panic!("type") };
    (t.plain_text(), t.runs.iter().map(|r| (r.text.clone(), r.style.size)).collect())
}

#[test]
fn rewrite_text_keeps_run_styles() {
    let answer = json!({"segments": ["Huge", " deals now"]}).to_string();
    let server = MockServer::replies(vec![Reply::ok(gemini_text(&answer))]);
    let mut g = genai(&server);
    let mut s = session();
    let id = exec(&mut s, "text.create", json!({"x": 20, "y": 100, "text": "Big sale today", "size": 12}))["id"].as_u64().unwrap();
    exec(&mut s, "text.setRangeStyle", json!({"id": id, "start": 0, "end": 3, "size": 40}));
    select(&mut s, &[id]);
    let (before, steps) = (snapshot(&s), undo_steps(&s));
    let spec = RewriteSpec { tone: Tone::Shorter, variations: 1 };
    generate_and_apply(&mut g, &mut s, &FeatureRequest::Rewrite(spec), ProviderKind::Gemini);
    let body = server.requests()[0].json();
    assert_eq!(body["generationConfig"]["responseMimeType"], "application/json");
    assert!(body["contents"][0]["parts"][0]["text"].as_str().unwrap().contains("[\"Big\",\" sale today\"]"));
    let (text, runs) = text_of(&s, id);
    assert_eq!(text, "Huge deals now");
    assert_eq!(runs[0], ("Huge".to_string(), 40.0));
    assert_eq!(runs[1].1, 12.0);
    undoes_to(&mut s, &before, steps);
    assert_eq!(text_of(&s, id).0, "Big sale today");
}

#[test]
fn rewrite_text_with_another_segment_count_takes_the_first_style() {
    let server = MockServer::replies(vec![Reply::ok(openai_text(&json!({"segments": ["One", "Two", "Three"]}).to_string()))]);
    let mut g = genai(&server);
    let mut s = session();
    let id = exec(&mut s, "text.create", json!({"x": 20, "y": 100, "text": "Hello world", "size": 12}))["id"].as_u64().unwrap();
    exec(&mut s, "text.setRangeStyle", json!({"id": id, "start": 0, "end": 5, "size": 30}));
    select(&mut s, &[id]);
    generate_and_apply(&mut g, &mut s, &FeatureRequest::Rewrite(RewriteSpec { tone: Tone::Formal, variations: 1 }), ProviderKind::OpenAi);
    let (text, runs) = text_of(&s, id);
    assert_eq!(text, "OneTwoThree");
    assert!(runs.iter().all(|(_, size)| *size == 30.0), "{runs:?}");
    // A text edited while the job ran isn't overwritten.
    let server = MockServer::replies(vec![Reply::ok(openai_text("{\"text\": \"Greetings\"}"))]);
    let mut g = genai(&server);
    select(&mut s, &[id]);
    let job = g.start(&mut s, &FeatureRequest::Rewrite(RewriteSpec::default()), Some(ProviderKind::OpenAi)).unwrap();
    g.wait(job, Duration::from_secs(30)).unwrap().result.unwrap();
    exec(&mut s, "text.setText", json!({"id": id, "text": "Edited meanwhile"}));
    assert_eq!(g.apply(&mut s, job, 0).unwrap_err().kind, ErrorKind::Document);
    assert_eq!(text_of(&s, id).0, "Edited meanwhile");
}

#[test]
fn results_apply_only_to_their_document() {
    let server = MockServer::replies(vec![Reply::ok(openai_text(SVG))]);
    let mut g = genai(&server);
    let mut s = session();
    let job = g.start(&mut s, &FeatureRequest::TextToVector(TextToVectorSpec { prompt: "x".into(), ..Default::default() }), None).unwrap();
    g.wait(job, Duration::from_secs(30)).unwrap().result.unwrap();
    exec(&mut s, "file.new", json!({"width": 100, "height": 100}));
    let steps = undo_steps(&s);
    assert_eq!(g.apply(&mut s, job, 0).unwrap_err().kind, ErrorKind::Document);
    assert_eq!(undo_steps(&s), steps);
}

#[test]
fn a_bad_answer_changes_nothing() {
    let server = MockServer::replies(vec![Reply::ok(openai_text("I'd rather describe it in words."))]);
    let mut g = genai(&server);
    let mut s = session();
    let before = snapshot(&s);
    let job = g.start(&mut s, &FeatureRequest::TextToVector(TextToVectorSpec { prompt: "x".into(), ..Default::default() }), None).unwrap();
    let e = g.wait(job, Duration::from_secs(30)).unwrap();
    assert_eq!(e.result.unwrap_err().kind, ErrorKind::BadResponse);
    assert!(g.result(job).is_none());
    assert_eq!(snapshot(&s), before);
}

#[test]
fn jobs_cancel_at_once_and_drop_late_results() {
    let server = MockServer::replies(vec![Reply::ok(openai_text(SVG)).after(Duration::from_secs(2))]);
    let mut g = genai(&server);
    let mut s = session();
    let job = g.start(&mut s, &FeatureRequest::TextToVector(TextToVectorSpec { prompt: "x".into(), ..Default::default() }), None).unwrap();
    assert!(g.jobs.is_running(job));
    assert_eq!(g.jobs.running().len(), 1);
    assert!(g.cancel(job));
    assert!(!g.cancel(job), "only once");
    let events = g.poll();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].result.as_ref().unwrap_err().kind, ErrorKind::Cancelled);
    std::thread::sleep(Duration::from_millis(2500));
    assert!(g.poll().is_empty(), "the late answer is dropped");
    assert!(g.result(job).is_none());
}

#[test]
fn nothing_is_sent_without_consent_or_a_key() {
    let server = MockServer::replies(vec![Reply::ok(openai_text(SVG))]);
    let mut g = genai(&server);
    g.accounts.settings.consented = false;
    let mut s = session();
    let req = FeatureRequest::TextToVector(TextToVectorSpec { prompt: "x".into(), ..Default::default() });
    assert_eq!(g.start(&mut s, &req, None).unwrap_err().kind, ErrorKind::NeedsConsent);
    let mut accounts = nib_genai::AiAccounts::in_memory();
    accounts.settings.consented = true;
    let mut bare = nib_genai::GenAi::new(accounts);
    let e = bare.start(&mut s, &req, None).unwrap_err();
    assert_eq!(e.kind, ErrorKind::MissingKey);
    assert!(e.message.contains("AI Accounts"), "{e}");
    assert!(server.requests().is_empty());
}

#[test]
fn test_connection_lists_models() {
    let server = MockServer::start(|got| {
        if got.path.starts_with("/v1/models") {
            Reply::ok(json!({"data": [{"id": "gpt-5.1"}, {"id": "gpt-image-1"}]}))
        } else {
            Reply::json(404, json!({}))
        }
    });
    let mut g = genai(&server);
    let job = g.test_connection(ProviderKind::OpenAi).unwrap();
    let e = g.wait(job, Duration::from_secs(30)).unwrap();
    let Ok(nib_genai::jobs::Outcome::Models(models)) = e.result else { panic!("{:?}", e.result) };
    assert_eq!(models.len(), 2);
    assert_eq!(e.info.kind, nib_genai::jobs::JobKind::TestConnection);
    // A rejected key.
    let server = MockServer::replies(vec![Reply::json(401, json!({"error": {"message": "bad key", "code": "invalid_api_key"}}))]);
    let mut g = genai(&server);
    let job = g.test_connection(ProviderKind::OpenAi).unwrap();
    assert_eq!(g.wait(job, Duration::from_secs(30)).unwrap().result.unwrap_err().kind, ErrorKind::InvalidKey);
}
