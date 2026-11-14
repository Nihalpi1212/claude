//! Request building, answer parsing and error translation for both providers, and HTTP behaviour
//! (headers, timeouts, cancellation, the size cap) against the local mock server.

use std::time::Duration;

use nib_genai::provider::{EditRequest, ImageRequest, InputImage, ModelKind, TextRequest, gemini, openai, translate_error};
use nib_genai::{CancelToken, ErrorKind, ProviderKind};
use serde_json::json;

use crate::common::{GEMINI_KEY, MockServer, OPENAI_KEY, Reply, gemini_image, gemini_text, openai_image, openai_text, png, provider};

fn text_req(json: bool) -> TextRequest {
    TextRequest {
        instructions: "Be brief.".into(),
        prompt: "Say hi".into(),
        images: vec![InputImage::png(vec![1, 2, 3])],
        json,
        max_output_tokens: Some(100),
    }
}

#[test]
fn openai_text_body() {
    let b = openai::text_body("gpt-5.1", &text_req(true));
    assert_eq!(b["model"], "gpt-5.1");
    assert_eq!(b["store"], false);
    assert_eq!(b["instructions"], "Be brief.");
    assert_eq!(b["text"]["format"]["type"], "json_object");
    assert_eq!(b["max_output_tokens"], 100);
    let content = &b["input"][0]["content"];
    assert_eq!(content[0], json!({"type": "input_text", "text": "Say hi"}));
    assert_eq!(content[1]["type"], "input_image");
    assert_eq!(content[1]["image_url"], "data:image/png;base64,AQID");
    assert!(openai::text_body("m", &text_req(false)).get("text").is_none());
}

#[test]
fn openai_text_parsing() {
    assert_eq!(openai::parse_text(&openai_text("hello")).unwrap(), "hello");
    // The convenience field some answers carry.
    assert_eq!(openai::parse_text(&json!({"output": [], "output_text": "plain"})).unwrap(), "plain");
    let refusal = json!({"output": [{"type": "message", "content": [{"type": "refusal", "refusal": "I can't help with that."}]}]});
    assert_eq!(openai::parse_text(&refusal).unwrap_err().kind, ErrorKind::Safety);
    let filtered = json!({"status": "incomplete", "incomplete_details": {"reason": "content_filter"}, "output": []});
    assert_eq!(openai::parse_text(&filtered).unwrap_err().kind, ErrorKind::Safety);
    let tokens = json!({"status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}, "output": []});
    let e = openai::parse_text(&tokens).unwrap_err();
    assert_eq!(e.kind, ErrorKind::BadResponse);
    assert!(e.message.contains("output tokens"), "{e}");
    assert_eq!(openai::parse_text(&json!({})).unwrap_err().kind, ErrorKind::BadResponse);
}

#[test]
fn openai_image_bodies_and_sizes() {
    let req = ImageRequest { prompt: "a fox".into(), width: 1600, height: 1000, transparent: true, references: vec![] };
    let b = openai::generation_body("gpt-image-1", &req);
    assert_eq!(b["size"], "1536x1024");
    assert_eq!(b["background"], "transparent");
    assert_eq!(b["output_format"], "png");
    assert_eq!(b["n"], 1);
    assert!(b.get("response_format").is_none());
    let d = openai::generation_body("dall-e-3", &req);
    assert_eq!(d["size"], "1792x1024");
    assert_eq!(d["response_format"], "b64_json");
    assert_eq!(openai::image_size("gpt-image-1", 500, 1000), "1024x1536");
    assert_eq!(openai::image_size("gpt-image-1", 100, 100), "1024x1024");
    assert_eq!(openai::image_size("dall-e-2", 100, 900), "1024x1024");
}

#[test]
fn openai_image_parsing() {
    let p = png(2, 2, |_, _| [1, 2, 3, 255]);
    assert_eq!(openai::parse_image(&openai_image(&p)).unwrap().bytes, p);
    let url = json!({"data": [{"url": "https://example.invalid/x.png"}]});
    assert!(openai::parse_image(&url).unwrap_err().message.contains("link"));
    assert_eq!(openai::parse_image(&json!({"data": []})).unwrap_err().kind, ErrorKind::BadResponse);
    assert_eq!(openai::parse_image(&json!({"data": [{"b64_json": "@@@"}]})).unwrap_err().kind, ErrorKind::BadResponse);
}

#[test]
fn model_catalogs() {
    let o = openai::parse_models(&json!({"data": [{"id": "gpt-image-1"}, {"id": "gpt-5.1"}, {"id": "whisper-1"}, {"id": "o3"}, {"id": "gpt-5.1"}]}));
    let kinds: Vec<(&str, ModelKind)> = o.iter().map(|m| (m.id.as_str(), m.kind)).collect();
    assert_eq!(
        kinds,
        vec![("gpt-5.1", ModelKind::Text), ("gpt-image-1", ModelKind::Image), ("o3", ModelKind::Text), ("whisper-1", ModelKind::Other)]
    );
    assert_eq!(nib_genai::provider::pick_model(ProviderKind::OpenAi, &o, ModelKind::Text).as_deref(), Some("gpt-5.1"));
    assert_eq!(nib_genai::provider::pick_model(ProviderKind::OpenAi, &o, ModelKind::Image).as_deref(), Some("gpt-image-1"));
    let g = gemini::parse_models(&json!({"models": [
        {"name": "models/gemini-2.5-flash", "supportedGenerationMethods": ["generateContent", "countTokens"]},
        {"name": "models/gemini-2.5-flash-image", "supportedGenerationMethods": ["generateContent"]},
        {"name": "models/text-embedding-004", "supportedGenerationMethods": ["embedContent"]}
    ]}));
    let kinds: Vec<(&str, ModelKind)> = g.iter().map(|m| (m.id.as_str(), m.kind)).collect();
    assert_eq!(
        kinds,
        vec![("gemini-2.5-flash", ModelKind::Text), ("gemini-2.5-flash-image", ModelKind::Image), ("text-embedding-004", ModelKind::Other)]
    );
}

#[test]
fn gemini_bodies() {
    let b = gemini::text_body(&text_req(true));
    assert_eq!(b["contents"][0]["role"], "user");
    assert_eq!(b["contents"][0]["parts"][0]["text"], "Say hi");
    assert_eq!(b["contents"][0]["parts"][1]["inline_data"], json!({"mime_type": "image/png", "data": "AQID"}));
    assert_eq!(b["systemInstruction"]["parts"][0]["text"], "Be brief.");
    assert_eq!(b["generationConfig"]["responseMimeType"], "application/json");
    let req = ImageRequest { prompt: "a fox".into(), width: 1920, height: 1080, transparent: true, references: vec![] };
    let i = gemini::image_body("gemini-2.5-flash-image", &req);
    assert_eq!(i["generationConfig"]["imageConfig"]["aspectRatio"], "16:9");
    assert_eq!(i["generationConfig"]["responseModalities"], json!(["TEXT", "IMAGE"]));
    assert!(i["contents"][0]["parts"][0]["text"].as_str().unwrap().contains("white"));
    assert_eq!(gemini::image_body("gemini-3-pro-image-preview", &req)["generationConfig"]["responseModalities"], json!(["IMAGE"]));
    assert_eq!(gemini::generate_path("gemini-2.5-flash"), "/models/gemini-2.5-flash:generateContent");
    assert_eq!(gemini::generate_path("a/b"), "/models/a%2Fb:generateContent");
    // An edit sends the image and the mask as white (may change) on black.
    let image = png(4, 4, |_, _| [9, 9, 9, 255]);
    let mask = png(4, 4, |x, _| if x < 2 { [0, 0, 0, 0] } else { [0, 0, 0, 255] });
    let e = gemini::edit_body("gemini-2.5-flash-image", &EditRequest { prompt: "grow".into(), image, mask: Some(mask) }).unwrap();
    let parts = e["contents"][0]["parts"].as_array().unwrap();
    assert_eq!(parts.len(), 3);
    let sent = vectorcraft_format::base64_decode(parts[2]["inline_data"]["data"].as_str().unwrap()).unwrap();
    let m = nib_genai::image_util::decode(&sent).unwrap();
    assert_eq!(m.get_pixel(0, 0).0, [255, 255, 255, 255]);
    assert_eq!(m.get_pixel(3, 0).0, [0, 0, 0, 255]);
}

#[test]
fn gemini_parsing() {
    assert_eq!(gemini::parse_text(&gemini_text("hello")).unwrap(), "hello");
    let thought = json!({"candidates": [{"content": {"parts": [{"text": "thinking…", "thought": true}, {"text": "answer"}]}}]});
    assert_eq!(gemini::parse_text(&thought).unwrap(), "answer");
    let blocked = json!({"promptFeedback": {"blockReason": "SAFETY"}});
    assert_eq!(gemini::parse_text(&blocked).unwrap_err().kind, ErrorKind::Safety);
    let stopped = json!({"candidates": [{"finishReason": "IMAGE_SAFETY", "content": {"parts": []}}]});
    assert_eq!(gemini::parse_image(&stopped).unwrap_err().kind, ErrorKind::Safety);
    let p = png(2, 2, |_, _| [5, 6, 7, 255]);
    assert_eq!(gemini::parse_image(&gemini_image(&p)).unwrap().bytes, p);
    let words = gemini::parse_image(&gemini_text("I can only describe it.")).unwrap_err();
    assert!(words.message.contains("text instead of an image"), "{words}");
}

#[test]
fn error_translation() {
    let t = |kind, status, body: serde_json::Value| translate_error(kind, status, body.to_string().as_bytes());
    let invalid = t(
        ProviderKind::OpenAi,
        401,
        json!({"error": {"message": "Incorrect API key provided: sk-test-0123…WXYZ.", "type": "invalid_request_error", "code": "invalid_api_key"}}),
    );
    assert_eq!(invalid.kind, ErrorKind::InvalidKey);
    assert_eq!(invalid.status, 401);
    // A key error never repeats what the provider said (it quotes the key).
    assert!(!invalid.message.contains("sk-test"), "{invalid}");
    let quota = t(
        ProviderKind::OpenAi,
        429,
        json!({"error": {"message": "You exceeded your current quota.", "type": "insufficient_quota", "code": "insufficient_quota"}}),
    );
    assert_eq!(quota.kind, ErrorKind::Quota);
    assert!(quota.message.contains("no quota left"), "{quota}");
    let rate = t(ProviderKind::OpenAi, 429, json!({"error": {"message": "Rate limit reached", "code": "rate_limit_exceeded"}}));
    assert_eq!(rate.kind, ErrorKind::Quota);
    assert!(rate.kind.retryable());
    let safety =
        t(ProviderKind::OpenAi, 400, json!({"error": {"message": "Your request was rejected by the safety system.", "code": "moderation_blocked"}}));
    assert_eq!(safety.kind, ErrorKind::Safety);
    let g = t(
        ProviderKind::Gemini,
        400,
        json!({"error": {"code": 400, "message": "API key not valid. Please pass a valid API key.", "status": "INVALID_ARGUMENT", "details": [{"reason": "API_KEY_INVALID"}]}}),
    );
    assert_eq!(g.kind, ErrorKind::InvalidKey);
    assert!(g.message.contains("Google Gemini"), "{g}");
    let exhausted =
        t(ProviderKind::Gemini, 429, json!({"error": {"code": 429, "message": "Resource has been exhausted", "status": "RESOURCE_EXHAUSTED"}}));
    assert_eq!(exhausted.kind, ErrorKind::Quota);
    assert_eq!(
        t(ProviderKind::Gemini, 404, json!({"error": {"code": 404, "message": "models/x is not found", "status": "NOT_FOUND"}})).kind,
        ErrorKind::NotFound
    );
    assert_eq!(translate_error(ProviderKind::OpenAi, 503, b"<html>oops</html>").kind, ErrorKind::Server);
    let other = t(ProviderKind::OpenAi, 400, json!({"error": {"message": "Invalid size '7x7'."}}));
    assert_eq!(other.kind, ErrorKind::BadRequest);
    assert!(other.message.contains("Invalid size"), "{other}");
}

#[test]
fn requests_reach_the_api_with_the_key_in_a_header() {
    let server = MockServer::start(|got| match got.path.as_str() {
        "/v1/responses" => Reply::ok(openai_text("hi")),
        "/v1/models" => Reply::ok(json!({"data": [{"id": "gpt-5.1"}]})),
        p if p.ends_with(":generateContent") => Reply::ok(gemini_text("hej")),
        "/v1/models?pageSize=200" => {
            Reply::ok(json!({"models": [{"name": "models/gemini-2.5-flash", "supportedGenerationMethods": ["generateContent"]}]}))
        }
        _ => Reply::json(404, json!({"error": {"message": "no route"}})),
    });
    let cancel = CancelToken::new();
    let o = provider(ProviderKind::OpenAi, &server.base());
    assert_eq!(o.generate_text(&text_req(false), &cancel).unwrap(), "hi");
    assert_eq!(o.list_models(&cancel).unwrap().len(), 1);
    let g = provider(ProviderKind::Gemini, &server.base());
    assert_eq!(g.generate_text(&text_req(false), &cancel).unwrap(), "hej");
    assert_eq!(g.list_models(&cancel).unwrap()[0].id, "gemini-2.5-flash");
    let got = server.requests();
    assert_eq!(got[0].method, "POST");
    assert_eq!(got[0].header("authorization"), Some(format!("Bearer {OPENAI_KEY}").as_str()));
    assert_eq!(got[0].header("content-type"), Some("application/json"));
    assert_eq!(got[0].json()["model"], "gpt-5.1");
    assert_eq!(got[1].method, "GET");
    assert_eq!(got[2].path, "/v1/models/gemini-2.5-flash:generateContent");
    assert_eq!(got[2].header("x-goog-api-key"), Some(GEMINI_KEY));
    // Gemini's key never goes in the URL.
    assert!(got.iter().all(|r| !r.path.contains(GEMINI_KEY) && !r.path.contains("key=")));
    assert!(got[2].header("authorization").is_none());
}

#[test]
fn image_edits_send_a_multipart_form_with_the_mask() {
    let answer = png(8, 8, |_, _| [0, 255, 0, 255]);
    let server = MockServer::replies(vec![Reply::ok(openai_image(&answer))]);
    let o = provider(ProviderKind::OpenAi, &server.base());
    let image = png(1024, 1024, |_, _| [1, 1, 1, 255]);
    let mask = png(1024, 1024, |_, _| [0, 0, 0, 0]);
    let got = o.edit_image(&EditRequest { prompt: "grow".into(), image, mask: Some(mask) }, &CancelToken::new()).unwrap();
    assert_eq!(got.bytes, answer);
    let r = &server.requests()[0];
    assert_eq!(r.path, "/v1/images/edits");
    assert!(r.header("content-type").unwrap().starts_with("multipart/form-data; boundary="));
    let body = r.body_text();
    for part in [
        "name=\"model\"\r\n\r\ngpt-image-1\r\n",
        "name=\"size\"\r\n\r\n1024x1024\r\n",
        "name=\"image[]\"; filename=\"image.png\"",
        "name=\"mask\"; filename=\"mask.png\"",
        "name=\"input_fidelity\"",
    ] {
        assert!(body.contains(part), "missing {part:?}");
    }
}

#[test]
fn provider_errors_come_back_translated_and_redacted() {
    let echo = format!("Incorrect API key provided: {OPENAI_KEY}");
    let server = MockServer::replies(vec![
        Reply::json(401, json!({"error": {"message": echo, "code": "invalid_api_key"}})),
        Reply::json(400, json!({"error": {"message": format!("bad thing near {OPENAI_KEY}")}})),
    ]);
    let o = provider(ProviderKind::OpenAi, &server.base());
    let e = o.generate_text(&text_req(false), &CancelToken::new()).unwrap_err();
    assert_eq!(e.kind, ErrorKind::InvalidKey);
    assert!(!e.message.contains(OPENAI_KEY));
    let e = o.generate_text(&text_req(false), &CancelToken::new()).unwrap_err();
    assert_eq!(e.kind, ErrorKind::BadRequest);
    assert!(!e.message.contains(OPENAI_KEY), "{e}");
    assert!(e.message.contains("[redacted]"), "{e}");
}

#[test]
fn a_slow_provider_times_out() {
    let server = MockServer::replies(vec![Reply::ok(openai_text("late")).after(Duration::from_secs(3))]);
    let mut cfg = crate::common::config(ProviderKind::OpenAi, &server.base());
    cfg.timeout = Duration::from_millis(500);
    let o = nib_genai::provider::build(cfg, nib_genai::keys::ApiKey::new(OPENAI_KEY).unwrap()).unwrap();
    let e = o.generate_text(&text_req(false), &CancelToken::new()).unwrap_err();
    assert_eq!(e.kind, ErrorKind::Timeout, "{e:?}");
}

#[test]
fn a_cancelled_request_is_not_sent() {
    let server = MockServer::replies(vec![Reply::ok(openai_text("x"))]);
    let o = provider(ProviderKind::OpenAi, &server.base());
    let cancel = CancelToken::new();
    cancel.cancel();
    assert_eq!(o.generate_text(&text_req(false), &cancel).unwrap_err().kind, ErrorKind::Cancelled);
    assert!(server.requests().is_empty());
}

#[test]
fn answers_over_the_cap_are_refused() {
    let big = "x".repeat(300_000);
    let server = MockServer::replies(vec![Reply::ok(openai_text(&big))]);
    let mut cfg = crate::common::config(ProviderKind::OpenAi, &server.base());
    cfg.max_response_bytes = 100_000;
    let o = nib_genai::provider::build(cfg, nib_genai::keys::ApiKey::new(OPENAI_KEY).unwrap()).unwrap();
    let e = o.generate_text(&text_req(false), &CancelToken::new()).unwrap_err();
    assert_eq!(e.kind, ErrorKind::BadResponse, "{e:?}");
    assert!(e.message.contains("larger than"), "{e}");
}

#[test]
fn unreachable_provider_is_a_network_error() {
    // A port nothing listens on.
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/v1", l.local_addr().unwrap());
    drop(l);
    let o = provider(ProviderKind::Gemini, &url);
    let e = o.generate_text(&text_req(false), &CancelToken::new()).unwrap_err();
    assert_eq!(e.kind, ErrorKind::Network, "{e:?}");
}

#[test]
fn base_urls_must_be_https_or_loopback() {
    let mut cfg = nib_genai::ProviderConfig::new(ProviderKind::OpenAi);
    assert!(cfg.validate().is_ok());
    cfg.base_url = "http://api.example.com/v1".into();
    assert_eq!(cfg.validate().unwrap_err().kind, ErrorKind::BadRequest);
    cfg.base_url = "http://127.0.0.1:9/v1".into();
    assert!(cfg.validate().is_ok());
    cfg.text_model = "gpt 5; drop".into();
    assert!(cfg.validate().is_err());
    for u in ["http://127.0.0.1:8080/v1", "http://localhost:1/x", "http://[::1]:9/", "http://127.0.0.1"] {
        assert!(nib_genai::provider::is_loopback(u), "{u}");
    }
    for u in ["https://api.openai.com/v1", "http://127.0.0.1.evil.com/", "http://localhost@evil.com/", "ftp://localhost/"] {
        assert!(!nib_genai::provider::is_loopback(u), "{u}");
    }
}
