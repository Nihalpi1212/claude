//! The engine backend: provider-specific pixel steps (scaling, padding to the provider's frame,
//! mask conventions, keying, resampling back), model choice, who may send, consent, status, and
//! the `ai.*` commands end to end against the mock server.

use std::sync::{Arc, Mutex};

use photocraft_engine::Session;
use photocraft_engine::generative::{Choice, Describe, GenerativeBackend, ImageEdit, ImageGen, ProviderId};
use pigment_genai::{AiAccounts, Caller, GenAiBackend};
use serde_json::{Value, json};

use crate::common::{
    GEMINI_KEY, MockServer, OPENAI_KEY, Reply, accounts, backend, gemini_image, gemini_models, gemini_text, image, inline_image, openai_image, openai_models,
    openai_text, png, px, solid,
};

fn choice(p: ProviderId) -> Choice {
    Choice { provider: Some(p), model: None }
}

const GREEN: [u8; 4] = [0, 200, 0, 255];
const RED: [u8; 4] = [255, 0, 0, 255];

/// OpenAI: a 2000 × 1000 region is scaled to 1536 × 768, padded (transparent) to 1536 × 1024,
/// sent as the 1536x1024 size with the mask inverted; the answer's padding is cropped off and the
/// rest scaled back to exactly 2000 × 1000.
#[test]
fn openai_edits_are_scaled_padded_and_cropped_back() {
    // The answer: red in the padding bands (128 px top and bottom of 1024), green inside.
    let answer = image(1536, 1024, |_, y| if (128..896).contains(&y) { GREEN } else { RED });
    let server = MockServer::replies(vec![Reply::ok(openai_image(&answer))]);
    let b = backend(accounts(&server), Caller::Person);
    let mask = image(2000, 1000, |x, _| [255, 255, 255, if x < 1000 { 255 } else { 0 }]);
    let req = ImageEdit {
        choice: choice(ProviderId::OpenAi),
        prompt: "a lake".into(),
        image: solid(2000, 1000, [9, 9, 9, 255]),
        mask: Some(mask),
        transparent: false,
    };
    let out = b.edit_image(&req, &|| false).unwrap();
    assert_eq!((out.width, out.height), (2000, 1000));
    for (x, y) in [(0, 0), (1999, 0), (1000, 500), (0, 999), (1999, 999)] {
        assert_eq!(px(&out, x, y), GREEN, "({x}, {y}): the padding is cropped off");
    }
    let r = &server.requests()[0];
    assert_eq!(r.part("size").unwrap(), b"1536x1024");
    assert_eq!(r.part("model").unwrap(), b"gpt-image-1");
    assert_eq!(r.part("background").unwrap(), b"auto");
    let sent = png(&r.part("image[]").unwrap());
    assert_eq!((sent.width, sent.height), (1536, 1024));
    assert_eq!(px(&sent, 10, 10)[3], 0, "transparent padding");
    assert_eq!(px(&sent, 10, 500), [9, 9, 9, 255]);
    let m = png(&r.part("mask").unwrap());
    assert_eq!((m.width, m.height), (1536, 1024));
    assert_eq!(px(&m, 10, 500), [0, 0, 0, 0], "may change: alpha 0");
    assert_eq!(px(&m, 1500, 500), [0, 0, 0, 255], "keep");
    assert_eq!(px(&m, 10, 10), [0, 0, 0, 255], "the padding is kept");
}

/// Gemini: the nearest ratio (3:2 for 1000 × 700), white padding, the white-on-black mask and the
/// instruction; gemini-3 models get an image size; any answer size is scaled back.
#[test]
fn gemini_edits_use_its_ratio_white_padding_and_mask() {
    let server = MockServer::replies(vec![Reply::ok(gemini_image(&solid(300, 200, GREEN)))]);
    let mut a = accounts(&server);
    a.set_models(ProviderId::Gemini, None, Some("gemini-3-pro-image-preview")).unwrap();
    let b = backend(a, Caller::Person);
    let mask = solid(1000, 700, [255, 255, 255, 255]);
    let req = ImageEdit {
        choice: choice(ProviderId::Gemini),
        prompt: "a lake".into(),
        image: solid(1000, 700, [9, 9, 9, 255]),
        mask: Some(mask),
        transparent: false,
    };
    let out = b.edit_image(&req, &|| false).unwrap();
    assert_eq!((out.width, out.height), (1000, 700));
    assert_eq!(px(&out, 500, 350), GREEN);
    let body = server.requests()[0].json();
    assert_eq!(server.requests()[0].path, "/v1/models/gemini-3-pro-image-preview:generateContent");
    assert_eq!(body["generationConfig"], json!({"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": "3:2", "imageSize": "2K"}}));
    let parts = body["contents"][0]["parts"].as_array().unwrap();
    assert!(parts[0]["text"].as_str().unwrap().contains("The second image is a mask"));
    let sent = inline_image(&parts[1]);
    assert_eq!((sent.width, sent.height), (1050, 700));
    assert_eq!(px(&sent, 2, 300), [255, 255, 255, 255], "white padding");
    assert_eq!(px(&sent, 500, 300), [9, 9, 9, 255]);
    let m = inline_image(&parts[2]);
    assert_eq!((px(&m, 2, 300), px(&m, 500, 300)), ([0, 0, 0, 255], [255, 255, 255, 255]), "the padding is kept (black)");
}

/// Remove Background's request: no mask, transparency asked. gpt-image-1 gets `background:
/// transparent`; Gemini is asked for white (the engine keys it).
#[test]
fn transparent_edits_ask_each_model_its_way() {
    let server = MockServer::start(|got| {
        if got.path.contains(":generateContent") { Reply::ok(gemini_image(&solid(64, 64, GREEN))) } else { Reply::ok(openai_image(&solid(64, 64, GREEN))) }
    });
    let b = backend(accounts(&server), Caller::Person);
    for p in ProviderId::ALL {
        let req = ImageEdit { choice: choice(p), prompt: "Remove the background.".into(), image: solid(64, 64, RED), mask: None, transparent: true };
        b.edit_image(&req, &|| false).unwrap();
    }
    let got = server.requests();
    assert_eq!(got[0].part("background").unwrap(), b"transparent");
    assert_eq!(String::from_utf8(got[0].part("prompt").unwrap()).unwrap(), "Remove the background.");
    assert!(got[0].part("mask").is_none());
    let text = got[1].json()["contents"][0]["parts"][0]["text"].as_str().unwrap().to_string();
    assert!(text.starts_with("Remove the background.\n\nRender the subject alone on a plain, pure white"), "{text}");
}

/// New images cover the size asked, cropped, never stretched; Gemini's transparency is asked as
/// white and keyed out.
#[test]
fn generated_images_cover_the_size_and_key_white() {
    // OpenAI answers 1536 × 1024: covering 300 × 100 crops the top and bottom.
    let tall = image(1536, 1024, |_, y| if (256..768).contains(&y) { GREEN } else { RED });
    let server = MockServer::start(move |got| {
        if got.path.contains(":generateContent") {
            // A subject on white: keyed to transparent around it.
            Reply::ok(gemini_image(&image(100, 100, |x, y| if (40..60).contains(&x) && (40..60).contains(&y) { RED } else { [255, 255, 255, 255] })))
        } else {
            Reply::ok(openai_image(&tall))
        }
    });
    let b = backend(accounts(&server), Caller::Person);
    let req = ImageGen { choice: choice(ProviderId::OpenAi), prompt: "a fox".into(), width: 300, height: 100, transparent: true };
    let out = b.generate_image(&req, &|| false).unwrap();
    assert_eq!((out.width, out.height), (300, 100));
    assert_eq!((px(&out, 0, 0), px(&out, 299, 99)), (GREEN, GREEN), "cropped to the middle band, not squashed");
    let o = server.requests()[0].json();
    assert_eq!((o["size"].as_str(), o["background"].as_str(), o["prompt"].as_str()), (Some("1536x1024"), Some("transparent"), Some("a fox")));
    let req = ImageGen { choice: choice(ProviderId::Gemini), prompt: "a fox".into(), width: 200, height: 200, transparent: true };
    let out = b.generate_image(&req, &|| false).unwrap();
    assert_eq!((out.width, out.height), (200, 200));
    assert_eq!(px(&out, 0, 0)[3], 0, "the white border is keyed out");
    assert_eq!(px(&out, 100, 100), RED);
    let g = server.requests()[1].json();
    assert!(g["contents"][0]["parts"][0]["text"].as_str().unwrap().contains("pure white (#ffffff)"));
    assert_eq!(g["generationConfig"]["imageConfig"]["aspectRatio"], "1:1");
}

#[test]
fn describe_sends_the_image_with_the_question() {
    let server = MockServer::start(|got| {
        if got.path.contains(":generateContent") { Reply::ok(gemini_text("  A red square. \n")) } else { Reply::ok(openai_text("A red square.")) }
    });
    let b = backend(accounts(&server), Caller::Person);
    for p in ProviderId::ALL {
        let text = b.describe(&Describe { choice: choice(p), image: solid(32, 16, RED), prompt: None }, &|| false).unwrap();
        assert_eq!(text, "A red square.");
    }
    let got = server.requests();
    let o = got[0].json();
    assert_eq!(o["model"], "gpt-5.1");
    assert!(o["input"][0]["content"][0]["text"].as_str().unwrap().starts_with("Describe this image in detail"));
    assert!(o.get("tools").is_none());
    let g = got[1].json();
    assert_eq!(got[1].path, "/v1/models/gemini-2.5-flash:generateContent");
    assert_eq!(px(&inline_image(&g["contents"][0]["parts"][1]), 0, 0), RED);
}

/// "Automatic" models: the catalog is read once, its preferred model used, and kept for the next
/// request; a model the person chose is used as is, and a request's own model wins.
#[test]
fn automatic_models_come_from_the_catalog_once() {
    let server = MockServer::start(|got| match got.path.as_str() {
        "/v1/models" => Reply::ok(openai_models()),
        "/v1/models?pageSize=200" => Reply::ok(gemini_models()),
        p if p.contains(":generateContent") => Reply::ok(gemini_image(&solid(8, 8, GREEN))),
        _ => Reply::ok(openai_image(&solid(8, 8, GREEN))),
    });
    let mut a = accounts(&server);
    a.set_models(ProviderId::OpenAi, Some(""), Some("")).unwrap();
    a.set_models(ProviderId::Gemini, None, Some("")).unwrap();
    let b = backend(a, Caller::Person);
    let req_gen = |p, model: Option<&str>| ImageGen {
        choice: Choice { provider: Some(p), model: model.map(str::to_string) },
        prompt: "x".into(),
        width: 8,
        height: 8,
        transparent: false,
    };
    b.generate_image(&req_gen(ProviderId::OpenAi, None), &|| false).unwrap();
    b.generate_image(&req_gen(ProviderId::OpenAi, None), &|| false).unwrap();
    b.generate_image(&req_gen(ProviderId::OpenAi, Some("dall-e-3")), &|| false).unwrap();
    b.generate_image(&req_gen(ProviderId::Gemini, None), &|| false).unwrap();
    let paths: Vec<String> = server.requests().iter().map(|g| g.path.clone()).collect();
    assert_eq!(
        paths,
        [
            "/v1/models",
            "/v1/images/generations",
            "/v1/images/generations",
            "/v1/images/generations",
            "/v1/models?pageSize=200",
            "/v1/models/gemini-3-pro-image-preview:generateContent"
        ]
    );
    let models: Vec<Value> = server.requests().iter().filter(|g| g.path == "/v1/images/generations").map(|g| g.json()["model"].clone()).collect();
    assert_eq!(models, [json!("gpt-image-1.5"), json!("gpt-image-1.5"), json!("dall-e-3")]);
    let st = b.status();
    assert_eq!(st.provider(ProviderId::OpenAi).unwrap().image_model.as_deref(), Some("gpt-image-1.5"), "the status shows the catalog's pick");
    // Without a readable catalog, a known model.
    let down = MockServer::start(|got| if got.path == "/v1/models" { Reply::json(500, json!({})) } else { Reply::ok(openai_image(&solid(8, 8, GREEN))) });
    let mut a = accounts(&down);
    a.set_models(ProviderId::OpenAi, None, Some("")).unwrap();
    backend(a, Caller::Person).generate_image(&req_gen(ProviderId::OpenAi, None), &|| false).unwrap();
    assert_eq!(down.requests()[1].json()["model"], "gpt-image-1");
}

/// Consent, and who may send: a refusal sends nothing at all.
#[test]
fn refusals_send_nothing() {
    let server = MockServer::start(|_| Reply::ok(openai_image(&solid(8, 8, GREEN))));
    let req_gen = ImageGen { choice: Choice::default(), prompt: "x".into(), width: 8, height: 8, transparent: false };
    let mut no_consent = accounts(&server);
    no_consent.settings.consented = false;
    let e = backend(no_consent, Caller::Person).generate_image(&req_gen, &|| false).unwrap_err();
    assert_eq!(e.kind, "needsConsent");
    let e = backend(accounts(&server), Caller::Agent).generate_image(&req_gen, &|| false).unwrap_err();
    assert_eq!(e.kind, "notAllowed");
    assert!(e.message.contains("Allow agents to run AI commands"), "{e}");
    let e = backend(accounts(&server), Caller::Agent).list_models(ProviderId::OpenAi, &|| false).unwrap_err();
    assert_eq!(e.kind, "notAllowed");
    let e = backend(accounts(&server), Caller::CommandLine { allow_ai: false }).generate_image(&req_gen, &|| false).unwrap_err();
    assert_eq!(e.kind, "notAllowed");
    assert!(e.message.contains("--allow-ai"), "{e}");
    let e = backend(accounts(&server), Caller::Person).generate_image(&req_gen, &|| true).unwrap_err();
    assert_eq!(e.kind, "cancelled");
    let mut nothing = AiAccounts::in_memory();
    nothing.settings.consented = true;
    let e = backend(nothing, Caller::Person).generate_image(&req_gen, &|| false).unwrap_err();
    assert_eq!(e.kind, "missingKey");
    assert!(server.requests().is_empty(), "{:?}", server.requests());
    // Allowed agents and `--allow-ai` send.
    let mut agents = accounts(&server);
    agents.settings.allow_agents = true;
    backend(agents, Caller::Agent).generate_image(&req_gen, &|| false).unwrap();
    backend(accounts(&server), Caller::CommandLine { allow_ai: true }).generate_image(&req_gen, &|| false).unwrap();
    assert_eq!(server.requests().len(), 2);
}

/// "Allow agents" switched on in AI Accounts while a server runs: the next request sees it.
#[test]
fn settings_are_reread_before_each_request() {
    let dir = crate::common::temp_dir("reread");
    let server = MockServer::start(|_| Reply::ok(openai_image(&solid(8, 8, GREEN))));
    let mut a = AiAccounts::with_store(Box::new(pigment_genai::keys::MemoryStore::default()), pigment_genai::AiSettings::default(), Some(dir.clone()));
    a.set_key(ProviderId::OpenAi, OPENAI_KEY).unwrap();
    a.set_base_url(ProviderId::OpenAi, &server.base()).unwrap();
    a.set_models(ProviderId::OpenAi, None, Some("gpt-image-1")).unwrap();
    a.set_consented(true).unwrap();
    let b = GenAiBackend::new(Arc::new(Mutex::new(a)), Caller::Agent);
    let req_gen = ImageGen { choice: Choice::default(), prompt: "x".into(), width: 8, height: 8, transparent: false };
    assert_eq!(b.generate_image(&req_gen, &|| false).unwrap_err().kind, "notAllowed");
    let mut s = pigment_genai::AiSettings::load(&dir);
    s.allow_agents = true;
    s.save(&dir).unwrap();
    b.generate_image(&req_gen, &|| false).unwrap();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn status_never_carries_a_key() {
    let server = MockServer::start(|_| Reply::ok(json!({})));
    let mut a = accounts(&server);
    a.clear_key(ProviderId::Gemini).unwrap();
    a.settings.default_provider = Some(ProviderId::Gemini);
    let st = backend(a, Caller::Person).status();
    let text = format!("{st:?}");
    assert!(!text.contains(OPENAI_KEY) && !text.contains(GEMINI_KEY), "{text}");
    let o = st.provider(ProviderId::OpenAi).unwrap();
    assert!(o.connected && o.image_capable && o.chat_capable);
    assert_eq!(o.hint.as_deref(), Some("…WXYZ"));
    assert_eq!(o.store.as_deref(), Some("memory"));
    assert_eq!((o.chat_model.as_deref(), o.image_model.as_deref()), (Some("gpt-5.1"), Some("gpt-image-1")));
    assert!(!st.provider(ProviderId::Gemini).unwrap().connected);
    assert_eq!(st.default_provider, Some(ProviderId::OpenAi), "the preferred provider without a key gives way");
    assert!(st.consented);
}

/// Connect checks a key with the provider before storing it (JS `setApiKey`).
#[test]
fn connect_stores_only_a_key_the_provider_accepts() {
    let server =
        MockServer::replies(vec![Reply::json(401, json!({"error": {"message": "Incorrect API key", "code": "invalid_api_key"}})), Reply::ok(openai_models())]);
    let mut a = AiAccounts::in_memory();
    a.set_base_url(ProviderId::OpenAi, &server.base()).unwrap();
    let e = a.connect(ProviderId::OpenAi, OPENAI_KEY, &|| false).unwrap_err();
    assert_eq!(e.kind, pigment_genai::ErrorKind::InvalidKey);
    assert!(!a.has_key(ProviderId::OpenAi));
    let models = a.connect(ProviderId::OpenAi, OPENAI_KEY, &|| false).unwrap();
    assert_eq!(models.len(), 5);
    assert!(a.has_key(ProviderId::OpenAi));
    assert!(a.cached_catalog(ProviderId::OpenAi).is_some());
    assert_eq!(server.requests()[1].header("authorization"), Some(format!("Bearer {OPENAI_KEY}").as_str()));
}

fn session_with_backend(server: &MockServer) -> Session {
    let mut s = Session::new();
    s.execute("file.new", json!({"width": 200, "height": 100, "background": "white"})).unwrap();
    s.set_generative(Some(Arc::new(backend(accounts(server), Caller::Person))));
    s
}

/// The engine commands with the real backend, end to end against the mock server: Generative
/// Fill lands one layer holding green inside the selection, the document unchanged outside;
/// Generate Image and Describe; `ai.status` and `ai.testConnection`.
#[test]
fn the_engine_commands_run_through_the_backend() {
    let server = MockServer::start(|got| match got.path.as_str() {
        "/v1/models" => Reply::ok(openai_models()),
        "/v1/responses" => Reply::ok(openai_text("A white rectangle.")),
        p if p.starts_with("/v1/images/") => {
            let size =
                if p.ends_with("edits") { got.part("size").map(|s| String::from_utf8(s).unwrap()) } else { got.json()["size"].as_str().map(str::to_string) };
            let (w, h) = pigment_genai::image_util::parse_size(&size.unwrap_or_default()).unwrap_or((64, 64));
            Reply::ok(openai_image(&solid(w, h, GREEN)))
        }
        _ => Reply::json(404, json!({})),
    });
    let mut s = session_with_backend(&server);
    s.execute("select.rect", json!({"x": 50, "y": 20, "width": 60, "height": 40})).unwrap();
    let r = s.execute("ai.generativeFill", json!({"prompt": "a green box"})).unwrap();
    assert_eq!(r["layers"].as_array().unwrap().len(), 1, "{r}");
    let doc = &s.active().unwrap().doc;
    let px = photocraft_compose::render(doc, doc.bounds()).to_rgba8();
    let at = |x: u32, y: u32| -> [u8; 4] { px.pixels[((y * 200 + x) * 4) as usize..][..4].try_into().unwrap() };
    assert_eq!(at(80, 40), GREEN, "inside the selection");
    assert_eq!(at(5, 5), [255, 255, 255, 255], "outside stays white");
    let edit = server.requests().into_iter().find(|g| g.path == "/v1/images/edits").unwrap();
    assert_eq!(String::from_utf8(edit.part("prompt").unwrap()).unwrap(), "a green box");
    assert_eq!(edit.part("model").unwrap(), b"gpt-image-1");

    let r = s.execute("ai.generateImage", json!({"prompt": "a meadow", "target": "layer"})).unwrap();
    assert!(r["layer"].is_number(), "{r}");
    let r = s.execute("ai.describe", json!({})).unwrap();
    assert_eq!(r["text"], "A white rectangle.");
    let st = s.execute("ai.status", json!({})).unwrap();
    assert_eq!(st["installed"], true);
    assert_eq!(st["providers"][0]["hint"], "…WXYZ");
    assert!(!st.to_string().contains(OPENAI_KEY));
    let t = s.execute("ai.testConnection", json!({"provider": "openai"})).unwrap();
    assert!(t["models"].as_array().unwrap().iter().any(|m| m == &json!({"id": "gpt-image-1.5", "kind": "image"})), "{t}");
    // A provider failure is the typed engine error and changes nothing.
    let failing = MockServer::start(|_| Reply::json(429, json!({"error": {"message": "slow down", "code": "rate_limit_exceeded"}})));
    let mut s = session_with_backend(&failing);
    s.execute("select.rect", json!({"x": 0, "y": 0, "width": 10, "height": 10})).unwrap();
    let before = s.active().unwrap().doc.walk().len();
    let e = s.execute("ai.generativeFill", json!({"prompt": "x"})).unwrap_err();
    assert!(matches!(&e, photocraft_engine::EngineError::Generative { kind: "quota", .. }), "{e:?}");
    assert_eq!(s.active().unwrap().doc.walk().len(), before);
}
