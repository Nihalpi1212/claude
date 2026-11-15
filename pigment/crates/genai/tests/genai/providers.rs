//! Request building, answer parsing and error translation for both providers, and HTTP behaviour
//! (headers, timeouts, cancellation, the size cap) against the local mock server.

use std::time::Duration;

use photocraft_engine::generative::{ChatMessage, ChatRequest, Choice};
use pigment_genai::cancel::never;
use pigment_genai::image_util::{base64_decode, decode};
use pigment_genai::provider::{EditRequest, ImageRequest, ModelInfo, ModelKind, gemini, openai, pick_model, translate_error};
use pigment_genai::{CancelToken, ErrorKind, ProviderId};
use serde_json::json;

use crate::common::{
    GEMINI_KEY, MockServer, OPENAI_KEY, Reply, gemini_image, gemini_text, image, inline_image, openai_image, openai_text, png, provider, px, solid,
};

fn hello() -> ChatRequest {
    ChatRequest {
        choice: Choice::default(),
        instructions: "Be brief.".into(),
        messages: vec![ChatMessage::User { text: "Say hi".into(), images: vec![] }],
        tools: vec![],
    }
}

#[test]
fn openai_generation_bodies_and_sizes() {
    let req = ImageRequest { prompt: "a fox".into(), width: 1600, height: 1000, transparent: true };
    let b = openai::generation_body("gpt-image-1", &req);
    assert_eq!(
        b,
        json!({"model": "gpt-image-1", "prompt": "a fox", "n": 1, "size": "1536x1024", "quality": "auto", "output_format": "png", "background": "transparent"})
    );
    // gpt-image-2 takes no `background`; DALL·E answers base64 only when asked.
    let g2 = openai::generation_body("gpt-image-2", &req);
    assert!(g2.get("background").is_none() && g2["output_format"] == "png");
    let d = openai::generation_body("dall-e-3", &req);
    assert_eq!((d["size"].as_str(), d["response_format"].as_str()), (Some("1792x1024"), Some("b64_json")));
    assert!(d.get("quality").is_none());
    assert_eq!(openai::image_size("gpt-image-1", 500, 1000), "1024x1536");
    assert_eq!(openai::image_size("gpt-image-1", 100, 100), "1024x1024");
    // DALL·E 2's squares: the smallest that holds the long edge, else the largest (JS).
    assert_eq!(openai::image_size("dall-e-2", 200, 180), "256x256");
    assert_eq!(openai::image_size("dall-e-2", 300, 300), "512x512");
    assert_eq!(openai::image_size("dall-e-2", 4000, 3000), "1024x1024");
    assert!(openai::is_gpt_image_1("gpt-image-1") && openai::is_gpt_image_1("gpt-image-1.5") && openai::is_gpt_image_1("gpt-image-1-mini"));
    assert!(!openai::is_gpt_image_1("gpt-image-10") && !openai::is_gpt_image_1("gpt-image-2"));
}

#[test]
fn openai_image_parsing() {
    let img = solid(2, 2, [1, 2, 3, 255]);
    assert_eq!(openai::parse_image(&openai_image(&img)).unwrap(), img);
    let url = json!({"data": [{"url": "https://example.invalid/x.png"}]});
    assert!(openai::parse_image(&url).unwrap_err().message.contains("link instead of image data"));
    assert_eq!(openai::parse_image(&json!({"data": []})).unwrap_err().kind, ErrorKind::BadResponse);
    assert_eq!(openai::parse_image(&json!({"data": [{"b64_json": "@@@"}]})).unwrap_err().kind, ErrorKind::BadResponse);
    let not_an_image = json!({"data": [{"b64_json": "aGVsbG8="}]});
    assert!(openai::parse_image(&not_an_image).unwrap_err().message.contains("could not be decoded"));
}

/// A JPEG answer decodes like a PNG one (Gemini answers JPEG for some models).
#[test]
fn jpeg_answers_decode() {
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::RgbImage::from_pixel(8, 4, image::Rgb([10, 200, 30])).write_to(&mut bytes, image::ImageFormat::Jpeg).unwrap();
    let b64 = pigment_genai::image_util::base64_encode(&bytes.into_inner());
    let v = json!({"candidates": [{"content": {"parts": [{"inlineData": {"mimeType": "image/jpeg", "data": b64}}]}, "finishReason": "STOP"}]});
    let img = gemini::parse_image(&v).unwrap();
    assert_eq!((img.width, img.height), (8, 4));
    let p = px(&img, 3, 2);
    assert!(p[1] > 180 && p[3] == 255, "{p:?}");
}

#[test]
fn model_catalogs_and_preferred_models() {
    let o = openai::parse_models(
        &json!({"data": [{"id": "gpt-image-1"}, {"id": "gpt-5.1"}, {"id": "whisper-1"}, {"id": "o3"}, {"id": "gpt-5.1"}, {"id": "computer-use-preview"}]}),
    );
    let kinds: Vec<(&str, ModelKind)> = o.iter().map(|m| (m.id.as_str(), m.kind)).collect();
    assert_eq!(
        kinds,
        vec![
            ("computer-use-preview", ModelKind::Other),
            ("gpt-5.1", ModelKind::Chat),
            ("gpt-image-1", ModelKind::Image),
            ("o3", ModelKind::Chat),
            ("whisper-1", ModelKind::Other)
        ]
    );
    assert_eq!(pick_model(ProviderId::OpenAi, &o, ModelKind::Chat).as_deref(), Some("gpt-5.1"));
    assert_eq!(pick_model(ProviderId::OpenAi, &o, ModelKind::Image).as_deref(), Some("gpt-image-1"));
    // The ChatGPT plan route answers slugs.
    let plan = openai::parse_models(&json!({"models": [{"slug": "gpt-5.5"}, {"slug": "gpt-5.1-codex"}]}));
    assert_eq!(pick_model(ProviderId::OpenAi, &plan, ModelKind::Chat).as_deref(), Some("gpt-5.5"));
    // A preferred id that only prefixes a listed one, then the first of the kind.
    let dated = vec![ModelInfo { id: "gpt-4o-2024".into(), kind: ModelKind::Chat }, ModelInfo { id: "gpt-4.1-mini".into(), kind: ModelKind::Chat }];
    assert_eq!(pick_model(ProviderId::OpenAi, &dated, ModelKind::Chat).as_deref(), Some("gpt-4.1-mini"));
    assert_eq!(pick_model(ProviderId::OpenAi, &[ModelInfo { id: "chatgpt-x".into(), kind: ModelKind::Chat }], ModelKind::Chat).as_deref(), Some("chatgpt-x"));
    assert_eq!(pick_model(ProviderId::OpenAi, &[], ModelKind::Image), None);
    let g = gemini::parse_models(&json!({"models": [
        {"name": "models/gemini-2.5-flash", "supportedGenerationMethods": ["generateContent", "countTokens"]},
        {"name": "models/gemini-2.5-flash-image", "supportedGenerationMethods": ["generateContent"]},
        {"name": "models/gemini-3.1-flash-image-preview", "supportedGenerationMethods": ["generateContent"]},
        {"name": "models/text-embedding-004", "supportedGenerationMethods": ["embedContent"]},
        {"name": "models/gemini-2.5-flash-preview-tts", "supportedGenerationMethods": ["generateContent"]}
    ]}));
    let kinds: Vec<(&str, ModelKind)> = g.iter().map(|m| (m.id.as_str(), m.kind)).collect();
    assert_eq!(
        kinds,
        vec![
            ("gemini-2.5-flash", ModelKind::Chat),
            ("gemini-2.5-flash-image", ModelKind::Image),
            ("gemini-2.5-flash-preview-tts", ModelKind::Other),
            ("gemini-3.1-flash-image-preview", ModelKind::Image),
            ("text-embedding-004", ModelKind::Other)
        ]
    );
    assert_eq!(pick_model(ProviderId::Gemini, &g, ModelKind::Image).as_deref(), Some("gemini-3.1-flash-image-preview"));
}

#[test]
fn gemini_image_bodies() {
    let req = ImageRequest { prompt: "a fox".into(), width: 1920, height: 1080, transparent: false };
    let i = gemini::image_body("gemini-2.5-flash-image", &req);
    assert_eq!(i["contents"][0]["parts"], json!([{"text": "a fox"}]));
    assert_eq!(i["generationConfig"], json!({"responseModalities": ["TEXT", "IMAGE"], "imageConfig": {"aspectRatio": "16:9"}}));
    let g3 = gemini::image_body("gemini-3-pro-image-preview", &req);
    assert_eq!(g3["generationConfig"], json!({"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": "16:9", "imageSize": "2K"}}));
    assert_eq!(gemini::image_size("gemini-3.1-flash-image", 1024), Some("1K"));
    assert_eq!(gemini::image_size("gemini-3.1-flash-image", 4096), Some("4K"));
    assert_eq!(gemini::image_size("gemini-2.5-flash-image", 4096), None);
    assert_eq!(gemini::generate_path("gemini-2.5-flash"), "/models/gemini-2.5-flash:generateContent");
    assert_eq!(gemini::generate_path("a/b"), "/models/a%2Fb:generateContent");
    // An edit sends the instruction, the image, and the mask as white (may change) on black,
    // grey where the mask is partial.
    let mask = image(4, 4, |x, _| [255, 255, 255, [0, 128, 255, 255][x as usize]]);
    let e = gemini::edit_body(
        "gemini-2.5-flash-image",
        &EditRequest { prompt: "grow".into(), image: solid(4, 4, [9, 9, 9, 255]), mask: Some(mask), transparent: false },
    )
    .unwrap();
    let parts = e["contents"][0]["parts"].as_array().unwrap();
    assert_eq!(parts.len(), 3);
    assert!(parts[0]["text"].as_str().unwrap().starts_with("grow\n\nEdit the first image. The second image is a mask"));
    assert_eq!(px(&inline_image(&parts[1]), 0, 0), [9, 9, 9, 255]);
    let m = inline_image(&parts[2]);
    assert_eq!([px(&m, 0, 0), px(&m, 1, 0), px(&m, 3, 0)], [[0, 0, 0, 255], [128, 128, 128, 255], [255, 255, 255, 255]]);
    let plain =
        gemini::edit_body("gemini-2.5-flash-image", &EditRequest { prompt: "x".into(), image: solid(2, 2, [0; 4]), mask: None, transparent: false }).unwrap();
    assert_eq!(plain["contents"][0]["parts"].as_array().unwrap().len(), 2);
    assert_eq!(plain["contents"][0]["parts"][0]["text"], "x");
}

#[test]
fn gemini_parsing() {
    assert_eq!(gemini::parse_turn(&gemini_text("hello")).unwrap().text, "hello");
    let thought = json!({"candidates": [{"content": {"parts": [{"text": "thinking…", "thought": true}, {"text": "answer"}]}}]});
    assert_eq!(gemini::parse_turn(&thought).unwrap().text, "answer");
    let blocked = json!({"promptFeedback": {"blockReason": "SAFETY"}});
    let e = gemini::parse_turn(&blocked).unwrap_err();
    assert_eq!(e.kind, ErrorKind::Safety);
    assert!(e.message.contains("Gemini blocked the request (SAFETY)"), "{e}");
    let stopped = json!({"candidates": [{"finishReason": "IMAGE_SAFETY", "content": {"parts": []}}]});
    assert_eq!(gemini::parse_image(&stopped).unwrap_err().kind, ErrorKind::Safety);
    let img = solid(2, 2, [5, 6, 7, 255]);
    assert_eq!(gemini::parse_image(&gemini_image(&img)).unwrap(), img);
    let words = gemini::parse_image(&gemini_text("I can only describe it.")).unwrap_err();
    assert!(words.message.contains("text instead of an image: I can only describe it."), "{words}");
    let no_image = gemini::parse_image(&json!({"candidates": [{"finishReason": "MAX_TOKENS", "content": {"parts": []}}]})).unwrap_err();
    assert_eq!(no_image.message, "The model returned no image (MAX_TOKENS).");
    assert_eq!(gemini::parse_image(&json!({})).unwrap_err().message, "The model returned no image.");
}

#[test]
fn error_translation() {
    let t = |p, status, body: serde_json::Value| translate_error(p, status, body.to_string().as_bytes());
    let invalid = t(
        ProviderId::OpenAi,
        401,
        json!({"error": {"message": "Incorrect API key provided: sk-test-0123…WXYZ.", "type": "invalid_request_error", "code": "invalid_api_key"}}),
    );
    assert_eq!(invalid.kind, ErrorKind::InvalidKey);
    assert_eq!(invalid.status, 401);
    // A key error never repeats what the provider said (it quotes the key).
    assert!(!invalid.message.contains("sk-test"), "{invalid}");
    let quota = t(
        ProviderId::OpenAi,
        429,
        json!({"error": {"message": "You exceeded your current quota.", "type": "insufficient_quota", "code": "insufficient_quota"}}),
    );
    assert_eq!(quota.kind, ErrorKind::Quota);
    assert!(quota.message.contains("no quota left"), "{quota}");
    let rate = t(ProviderId::OpenAi, 429, json!({"error": {"message": "Rate limit reached", "code": "rate_limit_exceeded"}}));
    assert_eq!(rate.kind, ErrorKind::Quota);
    assert!(rate.kind.retryable());
    let safety = t(ProviderId::OpenAi, 400, json!({"error": {"message": "Your request was rejected by the safety system.", "code": "moderation_blocked"}}));
    assert_eq!(safety.kind, ErrorKind::Safety);
    let g = t(
        ProviderId::Gemini,
        400,
        json!({"error": {"code": 400, "message": "API key not valid. Please pass a valid API key.", "status": "INVALID_ARGUMENT", "details": [{"reason": "API_KEY_INVALID"}]}}),
    );
    assert_eq!(g.kind, ErrorKind::InvalidKey);
    assert!(g.message.contains("Google Gemini"), "{g}");
    let exhausted = t(ProviderId::Gemini, 429, json!({"error": {"code": 429, "message": "Resource has been exhausted", "status": "RESOURCE_EXHAUSTED"}}));
    assert_eq!(exhausted.kind, ErrorKind::Quota);
    assert_eq!(
        t(ProviderId::Gemini, 404, json!({"error": {"code": 404, "message": "models/x is not found", "status": "NOT_FOUND"}})).kind,
        ErrorKind::NotFound
    );
    assert_eq!(translate_error(ProviderId::OpenAi, 503, b"<html>oops</html>").kind, ErrorKind::Server);
    let other = t(ProviderId::OpenAi, 400, json!({"error": {"message": "Invalid size '7x7'."}}));
    assert_eq!(other.kind, ErrorKind::BadRequest);
    assert!(other.message.contains("Invalid size"), "{other}");
    // The ChatGPT plan route's codes get JavaScript Pigment's messages.
    let plan = t(ProviderId::OpenAi, 403, json!({"error": {"code": "subscription_sharing_usage_limit_exceeded", "message": "limit"}}));
    assert_eq!(plan.kind, ErrorKind::Quota);
    assert!(plan.message.starts_with("You have reached the usage limit of your ChatGPT plan"), "{plan}");
    assert_eq!(t(ProviderId::OpenAi, 400, json!({"code": "subscription_sharing_route_not_supported"})).kind, ErrorKind::BadRequest);
}

#[test]
fn requests_reach_the_api_with_the_key_in_a_header() {
    let server = MockServer::start(|got| match got.path.as_str() {
        "/v1/responses" => Reply::ok(openai_text("hi")),
        "/v1/models" => Reply::ok(json!({"data": [{"id": "gpt-5.1"}]})),
        p if p.ends_with(":generateContent") => Reply::ok(gemini_text("hej")),
        "/v1/models?pageSize=200" => Reply::ok(json!({"models": [{"name": "models/gemini-2.5-flash", "supportedGenerationMethods": ["generateContent"]}]})),
        _ => Reply::json(404, json!({"error": {"message": "no route"}})),
    });
    let o = provider(ProviderId::OpenAi, &server.base());
    assert_eq!(o.chat("gpt-5.1", &hello(), &never).unwrap().text, "hi");
    assert_eq!(o.list_models(&never).unwrap().len(), 1);
    let g = provider(ProviderId::Gemini, &server.base());
    assert_eq!(g.chat("gemini-2.5-flash", &hello(), &never).unwrap().text, "hej");
    assert_eq!(g.list_models(&never).unwrap()[0].id, "gemini-2.5-flash");
    let got = server.requests();
    assert_eq!(got[0].method, "POST");
    assert_eq!(got[0].header("authorization"), Some(format!("Bearer {OPENAI_KEY}").as_str()));
    assert_eq!(got[0].header("content-type"), Some("application/json"));
    assert!(got[0].header("user-agent").unwrap().starts_with("Pigment/"));
    assert_eq!(got[0].json()["model"], "gpt-5.1");
    assert_eq!(got[0].json()["store"], false);
    assert_eq!(got[1].method, "GET");
    assert_eq!(got[2].path, "/v1/models/gemini-2.5-flash:generateContent");
    assert_eq!(got[2].header("x-goog-api-key"), Some(GEMINI_KEY));
    // Gemini's key never goes in the URL, and no key goes to the other provider.
    assert!(got.iter().all(|r| !r.path.contains(GEMINI_KEY) && !r.path.contains("key=")));
    assert!(got[2].header("authorization").is_none());
}

#[test]
fn image_edits_send_a_multipart_form_with_the_mask() {
    let answer = solid(8, 8, [0, 255, 0, 255]);
    let server = MockServer::replies(vec![Reply::ok(openai_image(&answer))]);
    let o = provider(ProviderId::OpenAi, &server.base());
    let mask = image(1024, 1024, |x, _| [255, 255, 255, if x < 512 { 255 } else { 0 }]);
    let req = EditRequest { prompt: "grow".into(), image: solid(1024, 1024, [1, 1, 1, 255]), mask: Some(mask), transparent: true };
    assert_eq!(o.edit_image("gpt-image-1", &req, &never).unwrap(), answer);
    let r = &server.requests()[0];
    assert_eq!(r.path, "/v1/images/edits");
    assert!(r.header("content-type").unwrap().starts_with("multipart/form-data; boundary="));
    let names: Vec<String> = r.form().into_iter().map(|(n, _)| n).collect();
    assert_eq!(names, ["model", "prompt", "n", "size", "output_format", "quality", "input_fidelity", "background", "image[]", "mask"]);
    assert_eq!(r.part("size").unwrap(), b"1024x1024");
    assert_eq!(r.part("background").unwrap(), b"transparent");
    assert_eq!(r.part("input_fidelity").unwrap(), b"high");
    // OpenAI's convention: alpha 0 where the image may change.
    let sent = png(&r.part("mask").unwrap());
    assert_eq!((px(&sent, 0, 0), px(&sent, 1000, 0)), ([0, 0, 0, 0], [0, 0, 0, 255]));
    assert_eq!(px(&png(&r.part("image[]").unwrap()), 5, 5), [1, 1, 1, 255]);
    // DALL·E 2 takes one `image` and base64 answers; DALL·E 3 can't edit.
    let d2 = MockServer::replies(vec![Reply::ok(openai_image(&answer))]);
    provider(ProviderId::OpenAi, &d2.base()).edit_image("dall-e-2", &req, &never).unwrap();
    let names: Vec<String> = d2.requests()[0].form().into_iter().map(|(n, _)| n).collect();
    assert_eq!(names, ["model", "prompt", "n", "size", "response_format", "image", "mask"]);
    let e = o.edit_image("dall-e-3", &req, &never).unwrap_err();
    assert!(e.message.starts_with("dall-e-3 cannot edit images"), "{e}");
    assert_eq!(server.requests().len(), 1, "a refused model sends nothing");
}

#[test]
fn gemini_images_through_the_server() {
    let answer = solid(4, 4, [10, 20, 30, 255]);
    let server = MockServer::replies(vec![Reply::ok(gemini_image(&answer))]);
    let g = provider(ProviderId::Gemini, &server.base());
    let req = ImageRequest { prompt: "a fox".into(), width: 1000, height: 1000, transparent: false };
    assert_eq!(g.generate_image("gemini-2.5-flash-image", &req, &never).unwrap(), answer);
    let r = &server.requests()[0];
    assert_eq!(r.path, "/v1/models/gemini-2.5-flash-image:generateContent");
    assert_eq!(r.json()["generationConfig"]["imageConfig"]["aspectRatio"], "1:1");
    let data = r.json()["contents"][0]["parts"][0]["text"].clone();
    assert_eq!(data, "a fox");
    // Inline data decodes back to what was sent.
    let e =
        gemini::edit_body("gemini-2.5-flash-image", &EditRequest { prompt: "p".into(), image: solid(3, 3, [7, 7, 7, 255]), mask: None, transparent: false })
            .unwrap();
    let sent = base64_decode(e["contents"][0]["parts"][1]["inline_data"]["data"].as_str().unwrap()).unwrap();
    assert_eq!(px(&decode(&sent).unwrap(), 1, 1), [7, 7, 7, 255]);
}

#[test]
fn provider_errors_come_back_translated_and_redacted() {
    let echo = format!("Incorrect API key provided: {OPENAI_KEY}");
    let server = MockServer::replies(vec![
        Reply::json(401, json!({"error": {"message": echo, "code": "invalid_api_key"}})),
        Reply::json(400, json!({"error": {"message": format!("bad thing near {OPENAI_KEY}")}})),
    ]);
    let o = provider(ProviderId::OpenAi, &server.base());
    let e = o.chat("gpt-5.1", &hello(), &never).unwrap_err();
    assert_eq!(e.kind, ErrorKind::InvalidKey);
    assert!(!e.message.contains(OPENAI_KEY));
    let e = o.chat("gpt-5.1", &hello(), &never).unwrap_err();
    assert_eq!(e.kind, ErrorKind::BadRequest);
    assert!(!e.message.contains(OPENAI_KEY), "{e}");
    assert!(e.message.contains("[redacted]"), "{e}");
}

#[test]
fn a_slow_provider_times_out() {
    let server = MockServer::replies(vec![Reply::ok(openai_text("late")).after(Duration::from_secs(3))]);
    let mut cfg = crate::common::config(ProviderId::OpenAi, &server.base());
    cfg.timeout = Duration::from_millis(500);
    let o = pigment_genai::provider::build(cfg, pigment_genai::keys::ApiKey::new(OPENAI_KEY).unwrap()).unwrap();
    let e = o.chat("gpt-5.1", &hello(), &never).unwrap_err();
    assert_eq!(e.kind, ErrorKind::Timeout, "{e:?}");
}

#[test]
fn a_cancelled_request_is_not_sent() {
    let server = MockServer::replies(vec![Reply::ok(openai_text("x"))]);
    let o = provider(ProviderId::OpenAi, &server.base());
    let cancel = CancelToken::new();
    cancel.cancel();
    assert_eq!(o.chat("gpt-5.1", &hello(), &|| cancel.is_cancelled()).unwrap_err().kind, ErrorKind::Cancelled);
    assert!(cancel.check().is_err());
    assert!(server.requests().is_empty());
}

#[test]
fn answers_over_the_cap_are_refused() {
    let big = "x".repeat(300_000);
    let server = MockServer::replies(vec![Reply::ok(openai_text(&big))]);
    let mut cfg = crate::common::config(ProviderId::OpenAi, &server.base());
    cfg.max_response_bytes = 100_000;
    let o = pigment_genai::provider::build(cfg, pigment_genai::keys::ApiKey::new(OPENAI_KEY).unwrap()).unwrap();
    let e = o.chat("gpt-5.1", &hello(), &never).unwrap_err();
    assert_eq!(e.kind, ErrorKind::BadResponse, "{e:?}");
    assert!(e.message.contains("larger than"), "{e}");
}

#[test]
fn unreachable_provider_is_a_network_error() {
    // A port nothing listens on.
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/v1", l.local_addr().unwrap());
    drop(l);
    let g = provider(ProviderId::Gemini, &url);
    let e = g.chat("gemini-2.5-flash", &hello(), &never).unwrap_err();
    assert_eq!(e.kind, ErrorKind::Network, "{e:?}");
}

#[test]
fn base_urls_must_be_https_or_loopback() {
    let mut cfg = pigment_genai::ProviderConfig::new(ProviderId::OpenAi);
    assert!(cfg.validate().is_ok());
    cfg.base_url = "http://api.example.com/v1".into();
    assert_eq!(cfg.validate().unwrap_err().kind, ErrorKind::BadRequest);
    cfg.base_url = "http://127.0.0.1:9/v1".into();
    assert!(cfg.validate().is_ok());
    assert!(pigment_genai::provider::check_model_id("gpt 5; drop").is_err());
    assert!(pigment_genai::provider::check_model_id("gemini-3-pro-image-preview").is_ok());
    for u in ["http://127.0.0.1:8080/v1", "http://localhost:1/x", "http://[::1]:9/", "http://127.0.0.1"] {
        assert!(pigment_genai::provider::is_loopback(u), "{u}");
    }
    for u in ["https://api.openai.com/v1", "http://127.0.0.1.evil.com/", "http://localhost@evil.com/", "ftp://localhost/"] {
        assert!(!pigment_genai::provider::is_loopback(u), "{u}");
    }
}

/// A huge array of tiny values is refused before it is parsed: its size, not its byte count, is
/// what would exhaust memory.
#[test]
fn an_answer_with_millions_of_values_is_refused_unparsed() {
    use pigment_genai::provider::{MAX_JSON_VALUES, json_value_bound};
    assert_eq!(json_value_bound(br#"{"a":[1,2,{"b":"x,[{"}],"c":"\",["}"#), 7, "commas and brackets inside strings don't count");
    let mut body = b"[0".to_vec();
    body.extend(std::iter::repeat_n(&b",0"[..], MAX_JSON_VALUES).flatten());
    body.push(b']');
    let server = MockServer::start(move |_| Reply { status: 200, body: body.clone(), delay: Duration::ZERO });
    let e = provider(ProviderId::OpenAi, &server.base()).list_models(&never).unwrap_err();
    assert_eq!(e.kind, ErrorKind::BadResponse);
    assert!(e.message.contains("too many values"), "{e}");
    // An image answer, one long string, is not affected.
    assert_eq!(json_value_bound(format!("{{\"data\":[{{\"b64_json\":\"{}\"}}]}}", "A,".repeat(1_000_000)).as_bytes()), 4);
}
