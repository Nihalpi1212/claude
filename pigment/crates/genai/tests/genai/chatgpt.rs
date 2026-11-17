//! Sign in with ChatGPT: the JavaScript Pigment's `tests/unit/ai.test.mjs` ported test for test
//! (the pure parts first, then the flow against a mock token endpoint and plan route on
//! 127.0.0.1), and what this port adds: the off switch, images refused, tokens that never show,
//! one refresh at a time, the attempt's timeout. Nothing reaches auth.openai.com or
//! api.openai.com.

use std::collections::BTreeMap;
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use photocraft_engine::generative::{ChatMessage, ChatRequest, Choice, GenerativeBackend, ImageGen, ToolResult, ToolSpec};
use pigment_genai::cancel::never;
use pigment_genai::chatgpt::{self, AuthorizeParams, Callback, ChatGpt};
use pigment_genai::keys::{FileStore, KEY_FILE, MemoryStore, SecretStore};
use pigment_genai::provider::{self, ModelInfo, ModelKind, gemini, openai};
use pigment_genai::{AiAccounts, AiSettings, Caller, ErrorKind, GenAiBackend, Method, ProviderId};
use serde_json::{Value, json};

use crate::common::{GEMINI_KEY, Got, MockServer, OPENAI_KEY, Reply, http_get, query, temp_dir};

fn fake_jwt(claims: &Value) -> String {
    let part = |v: &Value| chatgpt::base64url(v.to_string().as_bytes());
    format!("{}.{}.sig", part(&json!({"alg": "RS256", "typ": "JWT"})), part(claims))
}

// ---- the pure parts --------------------------------------------------------------------------

/// JS: "PKCE: S256 challenge of the verifier, URL-safe and unpadded".
#[test]
fn pkce_is_the_s256_challenge_of_the_verifier_url_safe_and_unpadded() {
    let p = chatgpt::create_pkce().unwrap();
    assert_eq!(p.method, "S256");
    assert!((43..=128).contains(&p.verifier.len()), "{}", p.verifier.len());
    assert!(p.verifier.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'), "{}", p.verifier);
    assert_eq!(p.challenge, chatgpt::pkce_challenge(&p.verifier));
    // RFC 7636 appendix B, and the SHA-256 of "abc".
    assert_eq!(chatgpt::pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    assert_eq!(chatgpt::pkce_challenge("abc"), "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
    assert_ne!(chatgpt::create_pkce().unwrap().verifier, p.verifier);
    let host = chatgpt::new_host_id().unwrap();
    assert!(host.starts_with("urn:uuid:") && host.len() == 45 && host.as_bytes()[23] == b'4', "{host}");
    assert_ne!(chatgpt::new_host_id().unwrap(), host);
}

/// JS: "authorize URL carries the open flow parameters, the dynamic client and the host id".
#[test]
fn the_authorize_url_carries_the_flow_parameters_the_dynamic_client_and_the_host_id() {
    let redirect = chatgpt::redirect_uri_for(1455);
    let url = chatgpt::build_authorize_url(&AuthorizeParams {
        client_id: None,
        redirect_uri: &redirect,
        state: "st",
        nonce: "nn",
        code_challenge: "ch",
        host_id: Some("urn:uuid:1234"),
    })
    .unwrap();
    assert_eq!(url.split('?').next(), Some(chatgpt::AUTHORIZE_URL));
    assert_eq!(chatgpt::AUTHORIZE_URL, "https://auth.openai.com/api/accounts/authorize");
    let p = query(&url);
    let want = [
        ("response_type", "code"),
        ("client_id", "dynamic_agent_client"),
        ("redirect_uri", "http://127.0.0.1:1455/auth/callback"),
        ("scope", "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"),
        ("resource", "https://api.openai.com/v1"),
        ("state", "st"),
        ("nonce", "nn"),
        ("code_challenge", "ch"),
        ("code_challenge_method", "S256"),
        ("agent_name_hint", "Pigment"),
        ("ext_agent_host_id", "urn:uuid:1234"),
    ];
    assert_eq!(p, want.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<BTreeMap<_, _>>());
    // In this order, as the JavaScript app sent them.
    let names: Vec<&str> = url.split_once('?').unwrap().1.split('&').map(|kv| kv.split('=').next().unwrap()).collect();
    assert_eq!(names, want.iter().map(|(k, _)| *k).collect::<Vec<_>>());
    // An issued client id needs no registration hints.
    let redirect = chatgpt::redirect_uri_for(1456);
    let issued = query(
        &chatgpt::build_authorize_url(&AuthorizeParams {
            client_id: Some("oaiapp_x"),
            redirect_uri: &redirect,
            state: "s",
            nonce: "n",
            code_challenge: "c",
            host_id: Some("urn:uuid:1"),
        })
        .unwrap(),
    );
    assert_eq!(issued["client_id"], "oaiapp_x");
    assert!(!issued.contains_key("agent_name_hint") && !issued.contains_key("ext_agent_host_id"));
    assert_eq!(issued["redirect_uri"], "http://127.0.0.1:1456/auth/callback");
    let incomplete = AuthorizeParams { client_id: None, redirect_uri: "", state: "s", nonce: "n", code_challenge: "c", host_id: None };
    assert_eq!(chatgpt::build_authorize_url(&incomplete).unwrap_err().kind, ErrorKind::BadRequest);
}

/// JS: "callback parsing accepts a URL, a path or a bare query and reads the issued client id".
#[test]
fn callback_parsing_accepts_a_url_a_path_or_a_bare_query_and_reads_the_issued_client_id() {
    let full = chatgpt::parse_callback("http://127.0.0.1:1455/auth/callback?code=abc&state=xyz&client_id=oaiapp_123").unwrap();
    assert_eq!(
        full,
        Callback { code: Some("abc".into()), state: Some("xyz".into()), client_id: Some("oaiapp_123".into()), error: None, error_description: None }
    );
    assert_eq!(chatgpt::parse_callback("/auth/callback?code=c&state=s").unwrap().client_id, None);
    assert_eq!(chatgpt::parse_callback("code=c&state=s").unwrap().code.as_deref(), Some("c"));
    assert_eq!(chatgpt::parse_callback("  ?error=access_denied&error_description=No+thanks%21 ").unwrap().error_description.as_deref(), Some("No thanks!"));
    let message = |input: &str| chatgpt::parse_callback(input).unwrap_err().message;
    assert!(message("http://127.0.0.1:1455/auth/callback").contains("authorization code"));
    assert!(message("").contains("Paste"));
    assert!(message("http://?code=c").contains("does not look like"));
    assert!(message(&format!("code={}", "c".repeat(20_000))).contains("does not look like"));
    // A fragment is not part of the query, and a value never runs past it.
    assert_eq!(chatgpt::parse_callback("https://x.example/cb?code=c&state=s#frag").unwrap().state.as_deref(), Some("s"));
}

/// JS: "ID token claims: issuer, audience, expiry and nonce are checked".
#[test]
fn id_token_claims_issuer_audience_expiry_and_nonce_are_checked() {
    let now = 1_800_000_000.0;
    let good = json!({"iss": "https://auth.openai.com", "aud": ["oaiapp_1", "other"], "exp": now + 600.0, "nonce": "n1", "email": "me@example.com"});
    let with = |k: &str, v: Value| {
        let mut c = good.clone();
        c[k] = v;
        fake_jwt(&c)
    };
    let check = |token: &str, client: &str, nonce: Option<&str>| chatgpt::validate_id_token(token, Some(client), nonce, now);
    assert_eq!(check(&fake_jwt(&good), "oaiapp_1", Some("n1")).unwrap()["email"], "me@example.com");
    assert_eq!(check(&with("aud", json!("oaiapp_1")), "oaiapp_1", None).unwrap()["iss"], "https://auth.openai.com");
    let refused = |token: &str, client: &str, nonce: Option<&str>| check(token, client, nonce).unwrap_err().message;
    assert!(refused(&with("iss", json!("https://evil.example")), "oaiapp_1", Some("n1")).contains("auth.openai.com"));
    assert!(refused(&fake_jwt(&good), "oaiapp_2", Some("n1")).contains("another application"));
    assert!(refused(&with("exp", json!(now - 1.0)), "oaiapp_1", Some("n1")).contains("expired"));
    assert!(refused(&with("exp", json!("soon")), "oaiapp_1", Some("n1")).contains("expired"));
    assert!(refused(&fake_jwt(&good), "oaiapp_1", Some("n2")).contains("match this sign-in"));
    assert!(refused("not-a-jwt", "oaiapp_1", None).contains("ID token"));
    assert!(chatgpt::decode_jwt("a.b").is_none());
}

/// The second half of the same JavaScript test: what a token answer says about the account.
#[test]
fn a_token_answer_names_the_account_the_plan_and_the_earliest_refresh() {
    let good = json!({"iss": "https://auth.openai.com", "aud": "oaiapp_1", "exp": 1_800_000_600, "email": "me@example.com"});
    let info = chatgpt::account_info(&json!({"id_token": fake_jwt(&good), "access_token": "x", "scope": "openid chatgpt.tokens.use.direct"}));
    assert_eq!((info.email.as_deref(), info.plan), (Some("me@example.com"), Some(true)));
    assert_eq!(chatgpt::account_info(&json!({"id_token": fake_jwt(&good), "scope": "openid"})).plan, Some(false));
    assert_eq!(chatgpt::account_info(&json!({"access_token": fake_jwt(&json!({"scp": ["chatgpt.tokens.use.direct"]}))})).plan, Some(true));
    assert_eq!(
        chatgpt::account_info(&json!({"access_token": fake_jwt(&json!({"scope": "openid", "email": "a@b.example"}))})).email.as_deref(),
        Some("a@b.example")
    );
    assert_eq!(chatgpt::account_info(&json!({})), chatgpt::AccountInfo::default());
    assert_eq!(chatgpt::parse_refresh_at(&json!(1_800_000_000)), 1_800_000_000.0);
    assert_eq!(chatgpt::parse_refresh_at(&json!(1_800_000_000_000_i64)), 1_800_000_000.0);
    assert_eq!(chatgpt::parse_refresh_at(&json!("1800000000")), 1_800_000_000.0);
    assert_eq!(chatgpt::parse_refresh_at(&json!("2027-01-01T00:00:00Z")), 1_798_761_600.0);
    for none in [Value::Null, json!(""), json!("soon"), json!(-5), json!([1])] {
        assert_eq!(chatgpt::parse_refresh_at(&none), 0.0, "{none}");
    }
}

/// JS: "plan-route reshaping: store false, stream true, instructions from system messages,
/// dropped params and tools".
#[test]
fn plan_route_reshaping_store_false_stream_true_instructions_dropped_params_and_tools() {
    let body = json!({
        "model": "gpt-5", "temperature": 0.2, "top_p": 0.9, "max_output_tokens": 100, "metadata": {"a": 1}, "user": "u", "store": true,
        "instructions": "Be brief.",
        "input": [
            {"role": "system", "content": "You are Pigment."},
            {"role": "developer", "content": [{"type": "input_text", "text": "Tools are undoable."}]},
            {"role": "user", "content": [{"type": "input_text", "text": "hi"}]}
        ],
        "tools": [{"type": "function", "name": "f"}, {"type": "web_search"}, {"type": "image_generation"}, {"type": "code_interpreter"}, {"type": "mcp"}],
        "tool_choice": {"type": "function", "name": "f"}
    });
    let out = chatgpt::reshape_for_plan_route(&body);
    assert_eq!(out["store"], false);
    assert_eq!(out["stream"], true);
    assert_eq!(out["instructions"], "Be brief.\n\nYou are Pigment.\n\nTools are undoable.");
    assert_eq!(out["input"], json!([{"role": "user", "content": [{"type": "input_text", "text": "hi"}]}]));
    assert_eq!(out["tools"].as_array().unwrap().iter().map(|t| t["type"].as_str().unwrap()).collect::<Vec<_>>(), ["function", "web_search"]);
    for k in ["temperature", "top_p", "max_output_tokens", "metadata", "user", "tool_choice"] {
        assert!(out.get(k).is_none(), "{k}");
    }
    assert_eq!(out["model"], "gpt-5");
    // A string tool_choice and a string input survive; the original body is untouched.
    let plain = chatgpt::reshape_for_plan_route(&json!({"input": "hello", "tool_choice": "auto"}));
    assert_eq!((plain["tool_choice"].as_str(), plain["input"].as_str()), (Some("auto"), Some("hello")));
    assert_eq!(body["store"], true);
    for k in chatgpt::PLAN_ROUTE_DROPPED_PARAMS {
        assert!(chatgpt::reshape_for_plan_route(&json!({ k: 1 })).get(k).is_none(), "{k}");
    }
}

fn sse(events: &[Value]) -> String {
    String::from_utf8(Reply::sse(200, events).body).unwrap()
}

/// JS: "SSE aggregation returns the completed response and raises stream errors".
#[test]
fn sse_aggregation_returns_the_completed_response_and_raises_stream_errors() {
    let text = sse(&[
        json!({"type": "response.created", "response": {"id": "r1"}}),
        json!({"type": "response.output_text.delta", "delta": "Hel"}),
        json!({"type": "response.output_text.delta", "delta": "lo"}),
        json!({"type": "response.completed", "response": {"id": "r1", "output": [{"type": "message", "content": [{"type": "output_text", "text": "Hello"}]}]}}),
    ]);
    assert!(chatgpt::looks_like_sse(&text) && !chatgpt::looks_like_sse("{\"data\": 1}"));
    let res = chatgpt::aggregate_sse(&text).unwrap();
    assert_eq!(res["id"], "r1");
    assert_eq!(res["output"][0]["content"][0]["text"], "Hello");
    assert_eq!(chatgpt::aggregate_sse(&text.replace('\n', "\r\n")).unwrap()["id"], "r1", "CRLF streams fold the same");
    // No completed event: the deltas become the message.
    let partial = chatgpt::aggregate_sse("data: {\"type\":\"response.output_text.delta\",\"delta\":\"part\"}\n\ndata: {oops\n\n").unwrap();
    assert_eq!(partial["output"][0]["content"][0]["text"], "part");
    assert_eq!(partial["partial"], true);
    assert_eq!(openai::parse_turn(&partial).unwrap().text, "part");
    let boom = chatgpt::aggregate_sse("data: {\"type\":\"error\",\"error\":{\"message\":\"boom\",\"code\":\"server_error\"}}\n\n").unwrap_err();
    assert!(boom.message.contains("boom") && boom.kind == ErrorKind::Server, "{boom:?}");
    let limit = chatgpt::aggregate_sse(
        "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"subscription_sharing_usage_limit_exceeded\",\"message\":\"x\"}}}\n\n",
    )
    .unwrap_err();
    assert!(limit.message.contains("usage limit") && limit.kind == ErrorKind::Quota, "{limit:?}");
}

/// JS: "error translation: provider bodies, subscription hints and HTTP fallbacks".
#[test]
fn error_translation_provider_bodies_subscription_hints_and_http_fallbacks() {
    let t = chatgpt::translate_error;
    let bad = t(400, &json!({"error": {"message": "Bad prompt", "type": "invalid_request_error", "code": null}}));
    assert_eq!((bad.message.as_str(), bad.code.as_deref(), bad.status), ("Bad prompt", Some("invalid_request_error"), 400));
    let limit = t(429, &json!({"error": {"code": "subscription_sharing_usage_limit_exceeded", "message": "limit"}}));
    assert_eq!(limit.message, "You have reached the usage limit of your ChatGPT plan. Try again later or use an OpenAI API key.");
    assert_eq!(limit.code.as_deref(), Some("subscription_sharing_usage_limit_exceeded"));
    for code in [
        "subscription_sharing_user_not_eligible",
        "subscription_sharing_usage_unavailable",
        "subscription_sharing_route_not_supported",
        "subscription_sharing_unsupported_capability",
        "subscription_sharing_invalid_user",
    ] {
        let x = t(403, &json!({"error": {"code": code}}));
        assert_eq!(x.code.as_deref(), Some(code));
        assert!(x.message.len() > 20, "{code}");
        // The provider's own translation (what a plan-route request's failure goes through) agrees.
        assert_eq!(provider::translate_error(ProviderId::OpenAi, 403, json!({"error": {"code": code}}).to_string().as_bytes()).message, x.message);
    }
    assert_eq!(
        t(429, &json!({"error": {"code": 429, "message": "Resource exhausted", "status": "RESOURCE_EXHAUSTED"}})).code.as_deref(),
        Some("RESOURCE_EXHAUSTED")
    );
    assert_eq!(t(401, &Value::Null).code, None);
    assert!(t(401, &Value::Null).message.contains("credentials"));
    assert!(t(500, &json!({"raw": ""})).message.contains("trouble"));
    assert_eq!(t(429, &json!({})).code.as_deref(), Some("rate_limited"));
    let grant = t(400, &json!({"error": "invalid_grant", "error_description": "bad code"}));
    assert_eq!((grant.code.as_deref(), grant.message.as_str(), grant.fatal()), (Some("invalid_grant"), "bad code", true));
    assert!(chatgpt::FATAL_TOKEN_ERRORS.contains(&"refresh_token_reused"));
    // The kind is what the interface acts on (the JavaScript app carried the code across IPC).
    assert_eq!(grant.into_error().kind, ErrorKind::InvalidKey);
    assert_eq!(limit.into_error().kind, ErrorKind::Quota);
    assert_eq!(t(418, &json!("teapot")).into_error().message, "teapot");
}

/// JS: "model catalogs: API keys ({ data }), the plan route ({ models[].slug }) and Gemini".
#[test]
fn model_catalogs_api_keys_the_plan_route_and_gemini() {
    let list = |models: Vec<ModelInfo>| models.into_iter().map(|m| (m.id, m.kind)).collect::<Vec<_>>();
    let pair = |id: &str, kind| (id.to_string(), kind);
    let api = openai::parse_models(
        &json!({"data": [{"id": "gpt-4.1"}, {"id": "gpt-image-1"}, {"id": "text-embedding-3-small"}, {"id": "dall-e-3"}, {"id": "whisper-1"}, {"id": "o3"}]}),
    );
    assert_eq!(
        list(api),
        [
            pair("dall-e-3", ModelKind::Image),
            pair("gpt-4.1", ModelKind::Chat),
            pair("gpt-image-1", ModelKind::Image),
            pair("o3", ModelKind::Chat),
            pair("text-embedding-3-small", ModelKind::Other),
            pair("whisper-1", ModelKind::Other)
        ]
    );
    let plan = openai::parse_models(&json!({"models": [{"slug": "gpt-5.1", "title": "GPT-5.1"}, {"slug": "gpt-5-codex"}, {"slug": "gpt-5.1"}]}));
    assert_eq!(list(plan), [pair("gpt-5-codex", ModelKind::Chat), pair("gpt-5.1", ModelKind::Chat)]);
    let gem = gemini::parse_models(&json!({"models": [
        {"name": "models/gemini-2.5-pro", "displayName": "Gemini 2.5 Pro", "supportedGenerationMethods": ["generateContent", "countTokens"]},
        {"name": "models/gemini-2.5-flash-image", "supportedGenerationMethods": ["generateContent"]},
        {"name": "models/imagen-4.0-generate-001", "supportedGenerationMethods": ["predict"]},
        {"name": "models/text-embedding-004", "supportedGenerationMethods": ["embedContent"]},
        {"name": "models/gemini-2.5-flash-preview-tts", "supportedGenerationMethods": ["generateContent"]}
    ]}));
    assert_eq!(
        list(gem),
        [
            pair("gemini-2.5-flash-image", ModelKind::Image),
            pair("gemini-2.5-flash-preview-tts", ModelKind::Other),
            pair("gemini-2.5-pro", ModelKind::Chat),
            pair("imagen-4.0-generate-001", ModelKind::Image),
            pair("text-embedding-004", ModelKind::Other)
        ]
    );
    assert_eq!(openai::model_kind("gpt-4o-realtime-preview"), ModelKind::Other);
    assert!(openai::parse_models(&Value::Null).is_empty());
    assert!(chatgpt::callback_page(true, "").contains("You can return to Pigment"));
    assert!(chatgpt::callback_page(false, "<x>").contains("&lt;x&gt;"));
    assert!(!chatgpt::callback_page(false, "<script>alert(1)</script>").contains("<script>"));
}

// ---- the flow, against a mock token endpoint and plan route ----------------------------------

/// What the mock answers with, set by each test.
#[derive(Clone, Default)]
struct Knobs {
    /// The attempt's nonce, which the first ID token must carry.
    nonce: Option<String>,
    /// The audience of the ID tokens (the client id the callback names).
    aud: String,
    code_delay: Duration,
    /// The code exchange answers without an ID token.
    no_id_token: bool,
    refresh_delay: Duration,
    /// The refresh fails with this OAuth error.
    fail_refresh: Option<&'static str>,
    /// The ID token a refresh answers with (`None`: none).
    refresh_id_token: Option<String>,
    /// `GET /models` refuses this access token (401).
    refuse_token: Option<&'static str>,
    /// Refreshes answered so far.
    refreshes: usize,
}

const FAR: i64 = 4_000_000_000;

fn id_token(aud: &str, nonce: Option<&str>) -> String {
    fake_jwt(&json!({"iss": "https://auth.openai.com", "aud": aud, "exp": FAR, "nonce": nonce, "email": "me@example.com"}))
}

fn bearer(g: &Got) -> String {
    g.header("authorization").unwrap_or_default().trim_start_matches("Bearer ").to_string()
}

/// The sign-in server and the plan route in one: the token endpoint (codes and refreshes, which
/// rotate `access-N`/`refresh-N`), `POST /v1/responses` (a stream answering `ok:token N`) and
/// `GET /v1/models`.
fn plan_server(knobs: &Arc<Mutex<Knobs>>) -> MockServer {
    let knobs = Arc::clone(knobs);
    MockServer::start(move |g| {
        let mut k = knobs.lock().unwrap();
        match g.path.as_str() {
            "/api/accounts/oauth/token" => {
                let form = g.fields();
                if form.get("grant_type").map(String::as_str) == Some("refresh_token") {
                    if let Some(code) = k.fail_refresh {
                        return Reply::json(400, json!({"error": code, "error_description": "gone"})).after(k.refresh_delay);
                    }
                    k.refreshes += 1;
                    let n = k.refreshes + 1;
                    let mut body = json!({"access_token": format!("access-{n}"), "refresh_token": format!("refresh-{n}"), "expires_in": 3600});
                    if let Some(t) = &k.refresh_id_token {
                        body["id_token"] = json!(t);
                    }
                    return Reply::ok(body).after(k.refresh_delay);
                }
                let mut body = json!({"access_token": "access-1", "refresh_token": "refresh-1", "expires_in": 3600, "scope": "openid chatgpt.tokens.use.direct",
                    "earliest_refresh_at": 60});
                if !k.no_id_token {
                    body["id_token"] = json!(id_token(&k.aud, k.nonce.as_deref()));
                }
                Reply::ok(body).after(k.code_delay)
            }
            "/v1/responses" => {
                // Which token asked, by its number (the token itself would come back redacted).
                let text = format!("ok:{}", bearer(g).replace("access-", "token "));
                Reply::sse(
                    200,
                    &[
                        json!({"type": "response.completed", "response": {"id": "r", "output": [{"type": "message", "content": [{"type": "output_text", "text": text}]}]}}),
                    ],
                )
            }
            "/v1/models" if k.refuse_token.is_some_and(|t| t == bearer(g) || t == "*") => {
                Reply::json(401, json!({"error": {"message": format!("expired {}", bearer(g)), "code": "token_expired"}}))
            }
            "/v1/models" if bearer(g).starts_with("sk-") => Reply::ok(json!({"data": [{"id": "gpt-5"}]})),
            "/v1/models" => Reply::ok(json!({"models": [{"slug": "gpt-5.1"}]})),
            other => Reply::json(404, json!({"error": {"message": format!("no route {other}")}})),
        }
    })
}

/// A test's accounts over the key file in a folder of its own, pointed at `server`, with a
/// second handle on the same key file to look at (and plant) what is stored.
struct World {
    dir: std::path::PathBuf,
    knobs: Arc<Mutex<Knobs>>,
    server: MockServer,
    accounts: Arc<Mutex<AiAccounts>>,
    chatgpt: Arc<ChatGpt>,
    file: FileStore,
}

impl World {
    /// `None` when Pigment is built without Sign in with ChatGPT ([`chatgpt::ENABLED`]): the
    /// flow tests then have nothing to test, and pass.
    fn new(name: &str) -> Option<Self> {
        let knobs = Arc::new(Mutex::new(Knobs { aud: "oaiapp_42".into(), ..Knobs::default() }));
        let server = plan_server(&knobs);
        chatgpt::ENABLED.then(|| Self::over(name, server, knobs))
    }

    /// The same over a server of the test's own.
    fn with_server(name: &str, server: MockServer) -> Option<Self> {
        chatgpt::ENABLED.then(|| Self::over(name, server, Arc::default()))
    }

    fn over(name: &str, server: MockServer, knobs: Arc<Mutex<Knobs>>) -> Self {
        let dir = temp_dir(&format!("chatgpt-{name}"));
        let mut a = AiAccounts::with_store(Box::new(FileStore::new(dir.join(KEY_FILE))), AiSettings::default(), Some(dir.clone()));
        a.set_base_url(ProviderId::OpenAi, &server.base()).unwrap();
        a.chatgpt().set_auth_base(&server.url).unwrap();
        a.chatgpt().set_ports(&[0]);
        a.set_models(ProviderId::OpenAi, Some("gpt-5.1"), None).unwrap();
        a.set_consented(true).unwrap();
        let chatgpt = Arc::clone(a.chatgpt());
        Self { file: FileStore::new(dir.join(KEY_FILE)), dir, knobs, server, accounts: Arc::new(Mutex::new(a)), chatgpt }
    }

    fn knob(&self, f: impl FnOnce(&mut Knobs)) {
        f(&mut self.knobs.lock().unwrap());
    }

    fn backend(&self) -> GenAiBackend {
        GenAiBackend::new(Arc::clone(&self.accounts), Caller::Person)
    }

    /// Start a sign-in: the authorize URL's parameters. The mock's first ID token then carries
    /// the attempt's nonce.
    fn start(&self) -> BTreeMap<String, String> {
        let st = self.accounts.lock().unwrap().sign_in(None).unwrap();
        assert!(st.pending);
        let p = query(st.url.as_deref().unwrap());
        self.knob(|k| k.nonce = p.get("nonce").cloned());
        p
    }

    /// Sign in through the loopback callback, as the browser would.
    fn sign_in(&self) {
        let p = self.start();
        let (status, page) = http_get(&format!("{}?code=the-code&state={}&client_id=oaiapp_42", p["redirect_uri"], p["state"]));
        assert_eq!(status, 200);
        assert!(page.contains("You can return to Pigment") && page.contains("now connected"), "{page}");
    }

    /// Plant a sign-in whose access token has expired, as a file from an earlier run holds it.
    fn plant_expired(&self) {
        let now = self.chatgpt.now();
        let rec = json!({"clientId": "oaiapp_42", "accessToken": "access-1", "refreshToken": "refresh-1", "idToken": "id-old",
            "expiresAt": now - 10.0, "earliestRefreshAt": 0, "email": "me@example.com", "plan": true, "signedInAt": now - 5000.0});
        self.file.set_secret(chatgpt::ACCOUNT, &rec.to_string()).unwrap();
    }

    fn stored(&self) -> Option<Value> {
        self.file.get_secret(chatgpt::ACCOUNT).unwrap().map(|t| serde_json::from_str(&t).unwrap())
    }

    fn method(&self) -> Option<Method> {
        self.accounts.lock().unwrap().method(ProviderId::OpenAi)
    }

    fn token_calls(&self) -> Vec<BTreeMap<String, String>> {
        self.server.requests().iter().filter(|g| g.path.ends_with("/oauth/token")).map(Got::fields).collect()
    }

    /// Wait until the token endpoint has been asked `n` times (the request is in flight: the
    /// mock logs it before its delay), so what the test does next lands while it waits.
    fn token_request_in_flight(&self, n: usize) {
        for _ in 0..2000 {
            if self.token_calls().len() >= n {
                return;
            }
            thread::sleep(Duration::from_millis(5));
        }
        panic!("the token endpoint was never asked");
    }

    fn chat(&self, text: &str) -> Result<String, photocraft_engine::generative::GenError> {
        let req = ChatRequest {
            choice: Choice::default(),
            instructions: "sys".into(),
            messages: vec![ChatMessage::User { text: text.into(), images: vec![] }],
            tools: vec![],
        };
        self.backend().chat(&req, &|| false).map(|t| t.text)
    }
}

impl Drop for World {
    fn drop(&mut self) {
        self.chatgpt.cancel();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// JS: "createAi: ChatGPT sign-in through the loopback callback, plan-route reshaping, SSE,
/// refresh rotation and fatal errors", part one: the sign-in.
#[test]
fn sign_in_through_the_loopback_callback() {
    let Some(w) = World::new("loopback") else { return };
    let auth = w.start();
    assert_eq!(auth["client_id"], "dynamic_agent_client");
    let host = w.accounts.lock().unwrap().settings.host_id.clone().unwrap();
    assert!(host.starts_with("urn:uuid:"));
    assert_eq!(auth["ext_agent_host_id"], host);
    assert!(std::fs::read_to_string(w.dir.join("ai.json")).unwrap().contains(&host), "the installation id is kept");
    let redirect = auth["redirect_uri"].clone();
    assert!(redirect.starts_with("http://127.0.0.1:") && redirect.ends_with("/auth/callback"), "{redirect}");
    // Anything but the callback path is not found; a callback without a code is refused.
    assert_eq!(http_get(&redirect.replace("/auth/callback", "/favicon.ico")), (404, "Not found".into()));
    let (status, page) = http_get(&redirect);
    assert!(status == 400 && page.contains("no authorization code"), "{status} {page}");
    // A wrong state is refused and keeps the sign-in open.
    let (_, bad) = http_get(&format!("{redirect}?code=x&state=wrong&client_id=oaiapp_42"));
    assert!(bad.contains("another sign-in attempt"), "{bad}");
    assert!(w.chatgpt.status().pending);
    assert!(w.token_calls().is_empty(), "a stray callback's code is never exchanged");
    // The real callback: the page says to return to Pigment, and the account is signed in.
    let (_, page) = http_get(&format!("{redirect}?code=the-code&state={}&client_id=oaiapp_42", auth["state"]));
    assert!(page.contains("You can return to Pigment"), "{page}");
    let who = w.chatgpt.take_outcome().unwrap().unwrap();
    assert_eq!((who.email.as_deref(), who.plan), (Some("me@example.com"), Some(true)));
    assert!(!w.chatgpt.status().pending && w.chatgpt.take_outcome().is_none());
    let row = w.accounts.lock().unwrap().status().remove(0);
    assert_eq!((row.method, row.email.as_deref(), row.plan, row.hint.as_str()), (Some(Method::Chatgpt), Some("me@example.com"), Some(true), ""));
    // The exchange: the code, the verifier of the challenge sent, the issued client id.
    let call = w.token_calls().remove(0);
    assert_eq!((call["grant_type"].as_str(), call["code"].as_str(), call["client_id"].as_str()), ("authorization_code", "the-code", "oaiapp_42"));
    assert_eq!((call["resource"].as_str(), call["redirect_uri"].as_str()), ("https://api.openai.com/v1", redirect.as_str()));
    assert_eq!(chatgpt::pkce_challenge(&call["code_verifier"]), auth["code_challenge"]);
    assert_eq!(w.stored().unwrap()["clientId"], "oaiapp_42");
}

/// Part two: requests on the plan route, the 401 retry, refresh rotation and a fatal refresh.
#[test]
fn the_plan_route_reshapes_streams_refreshes_and_ends_on_a_fatal_error() {
    let Some(w) = World::new("route") else { return };
    w.sign_in();
    // The plan route reshapes /responses and folds the stream.
    assert_eq!(w.chat("hi").unwrap(), "ok:token 1");
    let sent = w.server.requests().into_iter().rfind(|g| g.path == "/v1/responses").unwrap();
    let body = sent.json();
    assert_eq!((&body["stream"], &body["store"], &body["instructions"], &body["model"]), (&json!(true), &json!(false), &json!("sys"), &json!("gpt-5.1")));
    assert!(sent.header("accept").unwrap().contains("text/event-stream"));
    assert_eq!(w.knobs.lock().unwrap().refreshes, 0);
    // A 401 refreshes once and retries; tokens rotate.
    w.knob(|k| k.refuse_token = Some("access-1"));
    let models = w.backend().list_models(ProviderId::OpenAi, &|| false).unwrap();
    assert_eq!(models, vec![("gpt-5.1".to_string(), "text")]);
    assert_eq!(w.knobs.lock().unwrap().refreshes, 1);
    let refresh = w.token_calls().remove(1);
    assert_eq!((refresh["grant_type"].as_str(), refresh["refresh_token"].as_str()), ("refresh_token", "refresh-1"));
    assert_eq!((refresh["client_id"].as_str(), refresh["resource"].as_str()), ("oaiapp_42", "https://api.openai.com/v1"));
    assert_eq!(w.stored().unwrap()["refreshToken"], "refresh-2");
    // Five minutes before expiry the next request refreshes again.
    w.chatgpt.advance_clock(3600 - 200);
    assert_eq!(w.chat("again").unwrap(), "ok:token 3");
    assert_eq!(w.knobs.lock().unwrap().refreshes, 2);
    // A fatal refresh error clears the sign-in.
    w.chatgpt.advance_clock(3600);
    w.knob(|k| k.fail_refresh = Some("refresh_token_invalidated"));
    let e = w.chat("x").unwrap_err();
    assert!(e.message.contains("Sign in again") && e.kind == "invalidKey", "{e:?}");
    assert_eq!(w.method(), None);
    assert!(w.stored().is_none());
}

/// Part three: the pasted address and Cancel.
#[test]
fn a_pasted_callback_of_another_attempt_is_refused_and_cancel_ends_the_attempt() {
    let Some(w) = World::new("manual") else { return };
    assert!(w.chatgpt.complete_manual("code=c&state=s").unwrap_err().message.contains("Start \"Sign in with ChatGPT\" first"));
    w.start();
    let e = w.chatgpt.complete_manual("http://127.0.0.1:1455/auth/callback?code=c&state=nope").unwrap_err();
    assert!(e.message.contains("another sign-in attempt"), "{e:?}");
    assert!(w.chatgpt.status().pending, "a stray address keeps the attempt");
    assert!(w.chatgpt.complete_manual("   ").unwrap_err().message.contains("Paste"));
    // One attempt at a time: starting again gives the same one.
    let again = w.accounts.lock().unwrap().sign_in(None).unwrap();
    assert_eq!(again.url, w.chatgpt.status().url);
    w.chatgpt.cancel();
    assert_eq!(w.chatgpt.take_outcome().unwrap().unwrap_err().kind, ErrorKind::Cancelled);
    assert!(!w.chatgpt.status().pending);
    assert_eq!(w.method(), None);
}

/// JS: "createAi: API keys are validated, sealed on disk, used for requests and listed in
/// status; errors carry codes" (what of it is this crate's: the request proxy and its path
/// checks have no counterpart here, where only the providers build requests).
#[test]
fn api_keys_are_checked_stored_used_and_listed_beside_a_sign_in() {
    let Some(w) = World::new("keys") else { return };
    let mut a = w.accounts.lock().unwrap();
    assert_eq!((a.method(ProviderId::OpenAi), a.method(ProviderId::Gemini)), (None, None));
    assert_eq!(a.provider(ProviderId::OpenAi).err().unwrap().kind, ErrorKind::MissingKey);
    w.knob(|k| k.refuse_token = Some("*"));
    let refused = a.connect(ProviderId::OpenAi, "sk-bad-0123456789", &never).unwrap_err();
    assert_eq!(refused.kind, ErrorKind::InvalidKey);
    assert!(!refused.message.contains("sk-bad"), "{refused:?}");
    assert!(!a.has_key(ProviderId::OpenAi), "a refused key is not stored");
    w.knob(|k| k.refuse_token = None);
    let models = a.connect(ProviderId::OpenAi, &format!(" {OPENAI_KEY} "), &never).unwrap();
    assert_eq!(models, vec![ModelInfo { id: "gpt-5".into(), kind: ModelKind::Chat }]);
    a.set_key(ProviderId::Gemini, GEMINI_KEY).unwrap();
    assert_eq!((a.method(ProviderId::OpenAi), a.method(ProviderId::Gemini)), (Some(Method::ApiKey), Some(Method::ApiKey)));
    assert!(w.server.requests().iter().all(|g| !g.path.contains("sk-")), "keys never appear in URLs");
    // Removing the OpenAI key leaves Gemini's, and a fresh instance reads the file back.
    a.clear_key(ProviderId::OpenAi).unwrap();
    let again = AiAccounts::with_store(Box::new(FileStore::new(w.dir.join(KEY_FILE))), AiSettings::default(), None);
    assert_eq!((again.method(ProviderId::OpenAi), again.method(ProviderId::Gemini)), (None, Some(Method::ApiKey)));
}

/// JS: "createAi: without safeStorage the status warns and values are stored plain". Here the
/// Linux key file is always plain and private, and AI Accounts says so; the tokens live there
/// beside the keys and nowhere else.
#[test]
fn the_sign_in_is_kept_in_the_private_key_file_and_nowhere_else() {
    let Some(w) = World::new("file") else { return };
    w.sign_in();
    let engine = serde_json::to_string(&w.backend().status()).unwrap();
    let a = w.accounts.lock().unwrap();
    assert_eq!(a.store_backend(), pigment_genai::keys::FILE_BACKEND);
    let path = w.dir.join(KEY_FILE);
    let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert!(on_disk[chatgpt::ACCOUNT].as_str().unwrap().contains("access-1"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }
    let settings = std::fs::read_to_string(w.dir.join("ai.json")).unwrap();
    let status = serde_json::to_string(&a.status()).unwrap();
    for secret in ["access-1", "refresh-1", "the-code", &id_token("oaiapp_42", None)[..40]] {
        assert!(!settings.contains(secret) && !status.contains(secret) && !engine.contains(secret), "{secret}");
    }
    assert!(status.contains("me@example.com") && status.contains("\"method\":\"chatgpt\""), "{status}");
}

// ---- JS "bug hunt 3" -------------------------------------------------------------------------

/// "a refresh that lands after Sign out must not resurrect the account".
#[test]
fn a_refresh_that_lands_after_sign_out_does_not_resurrect_the_account() {
    let Some(w) = World::new("resurrect") else { return };
    w.plant_expired();
    w.knob(|k| k.refresh_delay = Duration::from_millis(800));
    let backend = w.backend();
    let request = thread::spawn(move || backend.list_models(ProviderId::OpenAi, &|| false));
    w.token_request_in_flight(1);
    w.accounts.lock().unwrap().sign_out().unwrap();
    assert_eq!(w.method(), None);
    let e = request.join().unwrap().unwrap_err();
    assert!(e.message.contains("removed") || e.message.contains("not connected"), "{e:?}");
    assert_eq!(w.method(), None);
    assert!(w.stored().is_none());
    assert_eq!(w.knobs.lock().unwrap().refreshes, 1, "the refresh did happen, and its tokens were dropped");
}

/// "the rotated refresh token is kept even when the refreshed ID token does not validate".
#[test]
fn rotated_tokens_are_kept_when_the_refreshed_id_token_does_not_validate() {
    let Some(w) = World::new("rotate") else { return };
    w.plant_expired();
    w.knob(|k| k.refresh_id_token = Some(fake_jwt(&json!({"iss": "https://auth.openai.com", "aud": "oaiapp_42", "exp": 5}))));
    assert_eq!(w.backend().list_models(ProviderId::OpenAi, &|| false).unwrap().len(), 1);
    let rec = w.stored().unwrap();
    assert_eq!((rec["refreshToken"].as_str(), rec["accessToken"].as_str(), rec["idToken"].as_str()), (Some("refresh-2"), Some("access-2"), Some("id-old")));
    assert_eq!((rec["email"].as_str(), rec["plan"].as_bool()), (Some("me@example.com"), Some(true)), "what the answer leaves out stays");
    // A refreshed ID token that does validate replaces the old one.
    let good = id_token("oaiapp_42", None);
    w.knob(|k| k.refresh_id_token = Some(good.clone()));
    w.chatgpt.advance_clock(3600);
    assert_eq!(w.chat("hi").unwrap(), "ok:token 3");
    assert_eq!(w.stored().unwrap()["idToken"], good);
}

/// "every loopback port busy: the attempt stays alive with a warning and the pasted address
/// finishes it".
#[test]
fn with_every_port_busy_the_pasted_address_finishes_the_sign_in() {
    let Some(w) = World::new("busy") else { return };
    let busy: Vec<TcpListener> = (0..3).map(|_| TcpListener::bind("127.0.0.1:0").unwrap()).collect();
    let ports: Vec<u16> = busy.iter().map(|l| l.local_addr().unwrap().port()).collect();
    w.chatgpt.set_ports(&ports[1..]);
    w.knob(|k| k.aud = "dynamic_agent_client".into());
    let st = w.accounts.lock().unwrap().sign_in(Some(ports[0])).unwrap();
    let warning = st.warning.clone().unwrap();
    assert!(warning.contains("all in use") && warning.contains(&ports[0].to_string()), "{warning}");
    let auth = query(st.url.as_deref().unwrap());
    assert_eq!(auth["redirect_uri"], format!("http://127.0.0.1:{}/auth/callback", ports[0]), "the port asked for comes first");
    w.knob(|k| k.nonce = auth.get("nonce").cloned());
    // No client id in the address: the dynamic one is used for the exchange and the audience.
    let who = w.chatgpt.complete_manual(&format!("{}?code=the-code&state={}", auth["redirect_uri"], auth["state"])).unwrap();
    assert_eq!(who.email.as_deref(), Some("me@example.com"));
    assert_eq!(w.method(), Some(Method::Chatgpt));
    assert_eq!(w.token_calls()[0]["client_id"], "dynamic_agent_client");
    assert!(w.chatgpt.take_outcome().unwrap().is_ok());
}

/// "a callback carrying an error but not this attempt's state is a stray request".
#[test]
fn an_error_without_this_attempts_state_is_a_stray_request() {
    let Some(w) = World::new("stray") else { return };
    let auth = w.start();
    let (status, page) = http_get(&format!("{}?error=access_denied&error_description=stray", auth["redirect_uri"]));
    assert!(status == 200 && page.contains("another sign-in attempt"), "{status} {page}");
    assert!(w.chatgpt.status().pending);
    let (_, real) = http_get(&format!("{}?code=the-code&state={}&client_id=oaiapp_42", auth["redirect_uri"], auth["state"]));
    assert!(real.contains("connected"), "{real}");
    assert_eq!(w.method(), Some(Method::Chatgpt));
    // The same error with this attempt's state ends it, with the provider's description.
    w.accounts.lock().unwrap().sign_out().unwrap();
    let auth = w.start();
    let (_, refused) = http_get(&format!("{}?error=access_denied&error_description=No+thanks&state={}", auth["redirect_uri"], auth["state"]));
    assert!(refused.contains("No thanks"), "{refused}");
    assert_eq!(w.chatgpt.take_outcome().unwrap().unwrap_err().message, "No thanks");
    assert_eq!(w.method(), None);
}

/// "cancelled while the code exchange is in flight: nothing is stored".
#[test]
fn cancel_during_the_code_exchange_stores_nothing() {
    let Some(w) = World::new("cancel") else { return };
    w.knob(|k| k.code_delay = Duration::from_millis(800));
    let auth = w.start();
    let (chatgpt, address) = (Arc::clone(&w.chatgpt), format!("{}?code=the-code&state={}&client_id=oaiapp_42", auth["redirect_uri"], auth["state"]));
    let manual = thread::spawn(move || chatgpt.complete_manual(&address));
    w.token_request_in_flight(1);
    w.chatgpt.cancel();
    assert_eq!(w.chatgpt.take_outcome().unwrap().unwrap_err().kind, ErrorKind::Cancelled);
    assert_eq!(manual.join().unwrap().unwrap_err().kind, ErrorKind::Cancelled);
    assert_eq!(w.method(), None);
    assert!(w.stored().is_none());
    assert_eq!(w.token_calls().len(), 1, "the code was sent, and its answer dropped");
}

/// "the first exchange must answer with an ID token".
#[test]
fn the_first_exchange_must_answer_with_an_id_token() {
    let Some(w) = World::new("noid") else { return };
    w.knob(|k| k.no_id_token = true);
    let auth = w.start();
    let e = w.chatgpt.complete_manual(&format!("{}?code=the-code&state={}&client_id=oaiapp_42", auth["redirect_uri"], auth["state"])).unwrap_err();
    assert!(e.message.contains("no ID token"), "{e:?}");
    assert!(w.chatgpt.take_outcome().unwrap().unwrap_err().message.contains("no ID token"));
    assert_eq!(w.method(), None);
    // An ID token for another sign-in attempt (a wrong nonce) is refused the same way.
    w.knob(|k| k.no_id_token = false);
    let auth = w.start();
    w.knob(|k| k.nonce = Some("someone-else".into()));
    let e = w.chatgpt.complete_manual(&format!("code=the-code&state={}&client_id=oaiapp_42", auth["state"])).unwrap_err();
    assert!(e.message.contains("does not match this sign-in attempt"), "{e:?}");
    assert!(w.stored().is_none());
}

// ---- JS "review fixes" -----------------------------------------------------------------------

/// "a fatal refresh after a new API key keeps the key".
#[test]
fn a_fatal_refresh_after_a_new_api_key_keeps_the_key() {
    let Some(w) = World::new("newkey") else { return };
    w.plant_expired();
    w.knob(|k| (k.refresh_delay, k.fail_refresh) = (Duration::from_millis(800), Some("invalid_grant")));
    let backend = w.backend();
    let request = thread::spawn(move || backend.list_models(ProviderId::OpenAi, &|| false));
    w.token_request_in_flight(1);
    w.accounts.lock().unwrap().set_key(ProviderId::OpenAi, OPENAI_KEY).unwrap();
    assert_eq!(w.method(), Some(Method::ApiKey));
    let e = request.join().unwrap().unwrap_err();
    assert!(e.message.contains("removed") || e.message.contains("not connected"), "{e:?}");
    assert_eq!(w.method(), Some(Method::ApiKey), "the key survives the refresh's failure");
    assert!(w.stored().is_none(), "a key replaces the sign-in");
}

/// "a cancelled attempt never ends the next sign-in".
#[test]
fn a_cancelled_attempt_never_ends_the_next_sign_in() {
    let Some(w) = World::new("next") else { return };
    w.knob(|k| k.code_delay = Duration::from_millis(800));
    let a = w.start();
    let (chatgpt, address) = (Arc::clone(&w.chatgpt), format!("code=c&state={}", a["state"]));
    let manual = thread::spawn(move || chatgpt.complete_manual(&address));
    w.token_request_in_flight(1);
    w.chatgpt.cancel();
    assert_eq!(w.chatgpt.take_outcome().unwrap().unwrap_err().kind, ErrorKind::Cancelled);
    // Attempt B starts while A's exchange is still in flight.
    let b = w.start();
    assert_ne!(a["state"], b["state"]);
    assert_eq!(manual.join().unwrap().unwrap_err().kind, ErrorKind::Cancelled);
    let st = w.chatgpt.status();
    assert!(st.pending && query(st.url.as_deref().unwrap())["state"] == b["state"], "attempt B is still waiting for its own callback");
    assert!(w.chatgpt.take_outcome().is_none());
    assert_eq!(w.method(), None);
}

// ---- what this port adds ---------------------------------------------------------------------

/// The switch: off, there is no sign-in to start or to use, a stored one is ignored (not
/// deleted), and an API key works as ever.
#[test]
fn turned_off_a_sign_in_is_neither_offered_nor_used_and_keys_work() {
    let Some(w) = World::new("off") else { return };
    w.sign_in();
    let mut a = w.accounts.lock().unwrap();
    a.settings.chatgpt_sign_in = false;
    a.save().unwrap();
    a.reload();
    assert!(!a.chatgpt().enabled());
    assert_eq!(a.method(ProviderId::OpenAi), None);
    assert!(!a.status()[0].connected);
    assert_eq!(a.provider(ProviderId::OpenAi).err().unwrap().kind, ErrorKind::MissingKey);
    assert!(a.sign_in(None).unwrap_err().message.contains("turned off"));
    assert!(w.chatgpt.access_token(None, &never).unwrap_err().message.contains("turned off"));
    assert!(!w.chatgpt.status().pending);
    assert!(w.stored().is_some(), "the sign-in is ignored, not deleted");
    let before = w.server.requests().len();
    drop(a);
    assert_eq!(w.chat("hi").unwrap_err().kind, "missingKey");
    assert_eq!(w.server.requests().len(), before, "nothing is sent");
    // On again, the sign-in is back.
    let mut a = w.accounts.lock().unwrap();
    a.settings.chatgpt_sign_in = true;
    a.save().unwrap();
    a.reload();
    assert_eq!(a.method(ProviderId::OpenAi), Some(Method::Chatgpt));
    // A settings file written before this setting existed reads as on.
    assert!(serde_json::from_str::<AiSettings>("{\"consented\":true}").unwrap().chatgpt_sign_in);
}

/// A ChatGPT sign-in never runs image models: the status says so, an image request is refused
/// before anything is sent (or goes to a provider with a key), and the provider refuses too.
#[test]
fn a_sign_in_never_runs_image_models() {
    let Some(w) = World::new("images") else { return };
    w.sign_in();
    let backend = w.backend();
    let status = backend.status();
    let o = &status.providers[0];
    assert!(o.connected && o.chat_capable && !o.image_capable && o.hint.is_none(), "{o:?}");
    assert_eq!(status.default_provider, Some(ProviderId::OpenAi));
    let before = w.server.requests().len();
    let req = |provider| ImageGen { choice: Choice { provider, model: None }, prompt: "a cat".into(), width: 64, height: 64, transparent: false };
    for provider in [None, Some(ProviderId::OpenAi)] {
        let e = backend.generate_image(&req(provider), &|| false).unwrap_err();
        assert!(e.kind == "missingKey" && e.message.contains("API key"), "{e:?}");
    }
    let direct = w.accounts.lock().unwrap().provider(ProviderId::OpenAi).unwrap();
    let image = provider::ImageRequest { prompt: "a cat".into(), width: 64, height: 64, transparent: false };
    let e = direct.generate_image("gpt-image-1", &image, &never).unwrap_err();
    assert!(e.kind == ErrorKind::MissingKey && e.message.contains("ChatGPT sign-in covers chat models only"), "{e:?}");
    assert_eq!(w.server.requests().len(), before, "nothing is sent");
    // With a Gemini key beside the sign-in, images go there and chat stays with the preferred OpenAI.
    w.accounts.lock().unwrap().set_key(ProviderId::Gemini, GEMINI_KEY).unwrap();
    let status = backend.status();
    assert_eq!(
        photocraft_engine::generative::resolve_provider(&status, &Choice::default(), photocraft_engine::generative::ModelKind::Image).unwrap(),
        ProviderId::Gemini
    );
    assert_eq!(
        photocraft_engine::generative::resolve_provider(&status, &Choice::default(), photocraft_engine::generative::ModelKind::Chat).unwrap(),
        ProviderId::OpenAi
    );
}

/// A key and a sign-in exclude each other, as in the JavaScript app: each replaces the other.
#[test]
fn a_key_replaces_a_sign_in_and_a_sign_in_replaces_a_key() {
    let Some(w) = World::new("exclusive") else { return };
    w.accounts.lock().unwrap().set_key(ProviderId::OpenAi, OPENAI_KEY).unwrap();
    w.sign_in();
    assert_eq!(w.method(), Some(Method::Chatgpt));
    assert!(!w.accounts.lock().unwrap().has_key(ProviderId::OpenAi), "signing in drops the key");
    // The catalog read with the key is not the sign-in's.
    w.accounts.lock().unwrap().cache_catalog(ProviderId::OpenAi, vec![ModelInfo { id: "gpt-5.1".into(), kind: ModelKind::Chat }]);
    w.accounts.lock().unwrap().set_key(ProviderId::OpenAi, OPENAI_KEY).unwrap();
    assert_eq!(w.method(), Some(Method::ApiKey));
    assert!(w.stored().is_none(), "a key drops the sign-in");
    assert!(w.accounts.lock().unwrap().cached_catalog(ProviderId::OpenAi).is_none());
    // Storing a key ends an attempt in progress.
    w.accounts.lock().unwrap().clear_key(ProviderId::OpenAi).unwrap();
    w.start();
    w.accounts.lock().unwrap().set_key(ProviderId::OpenAi, OPENAI_KEY).unwrap();
    assert!(!w.chatgpt.status().pending);
    assert_eq!(w.chatgpt.take_outcome().unwrap().unwrap_err().kind, ErrorKind::Cancelled);
}

/// A token the provider keeps refusing is refreshed once, then the request gives up, and the
/// message names the sign-in (not an API key) without a token in it.
#[test]
fn a_refused_token_is_refreshed_once_then_the_request_gives_up() {
    let Some(w) = World::new("giveup") else { return };
    w.sign_in();
    w.knob(|k| k.refuse_token = Some("*"));
    let e = w.backend().list_models(ProviderId::OpenAi, &|| false).unwrap_err();
    assert_eq!((e.kind, e.status), ("invalidKey", 401));
    assert!(e.message.contains("ChatGPT sign-in") && e.message.contains("AI Accounts"), "{e:?}");
    assert!(!e.message.contains("access-"), "{e:?}");
    assert_eq!(w.knobs.lock().unwrap().refreshes, 1);
    assert_eq!(w.server.requests().iter().filter(|g| g.path == "/v1/models").count(), 2);
    assert_eq!(w.method(), Some(Method::Chatgpt), "a refused request is not a sign-out");
}

/// Refresh tokens rotate, and one used twice ends the sign-in: requests that find the token
/// stale at the same moment share one refresh.
#[test]
fn requests_at_once_share_one_refresh() {
    let Some(w) = World::new("oneflight") else { return };
    w.plant_expired();
    w.knob(|k| k.refresh_delay = Duration::from_millis(150));
    let workers: Vec<_> = (0..4)
        .map(|_| {
            let chatgpt = Arc::clone(&w.chatgpt);
            thread::spawn(move || chatgpt.access_token(None, &never))
        })
        .collect();
    for worker in workers {
        assert_eq!(worker.join().unwrap().unwrap(), "access-2");
    }
    assert_eq!(w.knobs.lock().unwrap().refreshes, 1);
    // A sign-in without a refresh token can't be refreshed: it is cleared.
    let now = w.chatgpt.now();
    w.file.set_secret(chatgpt::ACCOUNT, &json!({"clientId": "c", "accessToken": "a", "expiresAt": now - 1.0}).to_string()).unwrap();
    let e = w.chatgpt.access_token(None, &never).unwrap_err();
    assert!(e.message.contains("no longer usable"), "{e:?}");
    assert!(w.stored().is_none());
}

/// `earliest_refresh_at`: until then a token near its expiry is still used, not refreshed.
#[test]
fn a_token_is_not_refreshed_before_the_earliest_refresh_time() {
    let Some(w) = World::new("earliest") else { return };
    let now = w.chatgpt.now();
    let rec = json!({"clientId": "c", "accessToken": "access-1", "refreshToken": "refresh-1", "expiresAt": now + 100.0, "earliestRefreshAt": now + 60.0});
    w.file.set_secret(chatgpt::ACCOUNT, &rec.to_string()).unwrap();
    assert_eq!(w.chatgpt.access_token(None, &never).unwrap(), "access-1");
    assert_eq!(w.knobs.lock().unwrap().refreshes, 0);
    w.chatgpt.advance_clock(70);
    assert_eq!(w.chatgpt.access_token(None, &never).unwrap(), "access-2");
}

/// Tokens, the code and the verifier never reach a message, whatever the server echoes.
#[test]
fn what_a_server_echoes_never_puts_a_secret_in_a_message() {
    let server = MockServer::start(|g| {
        let echo = format!("{} {}", String::from_utf8_lossy(&g.body), g.header("authorization").unwrap_or_default());
        Reply::json(400, json!({"error": {"message": echo, "code": "nope"}}))
    });
    let Some(w) = World::with_server("echo", server) else { return };
    // The code exchange: the code and the verifier.
    let auth = w.start();
    let e = w.chatgpt.complete_manual(&format!("code=SECRET-CODE-123&state={}", auth["state"])).unwrap_err();
    assert!(e.message.contains("[redacted]") && !e.message.contains("SECRET-CODE-123"), "{e:?}");
    let verifier = w.token_calls()[0]["code_verifier"].clone();
    assert!(!e.message.contains(&verifier), "{e:?}");
    // A request: the access token. A refresh: the refresh token.
    let now = w.chatgpt.now();
    let rec = |expires: f64| json!({"clientId": "c", "accessToken": "ACCESS-TOKEN-1", "refreshToken": "REFRESH-TOKEN-1", "expiresAt": expires}).to_string();
    w.file.set_secret(chatgpt::ACCOUNT, &rec(now + 3600.0)).unwrap();
    let e = w.chat("hi").unwrap_err();
    assert!(e.message.contains("[redacted]") && !e.message.contains("ACCESS-TOKEN-1"), "{e:?}");
    w.file.set_secret(chatgpt::ACCOUNT, &rec(now - 1.0)).unwrap();
    let e = w.chat("hi").unwrap_err();
    assert!(!e.message.contains("REFRESH-TOKEN-1") && !e.message.contains("ACCESS-TOKEN-1"), "{e:?}");
    assert_eq!(w.method(), Some(Method::Chatgpt), "an error that is not fatal keeps the sign-in");
}

/// The same for an answer that succeeds: a model's text that quotes the token comes back
/// without it (the Assistant shows that text).
#[test]
fn a_token_quoted_in_a_successful_answer_is_taken_out() {
    let server = MockServer::start(|g| {
        let text = format!("Your token is {}.", bearer(g));
        Reply::sse(200, &[json!({"type": "response.output_text.delta", "delta": text})])
    });
    let Some(w) = World::with_server("quoted", server) else { return };
    let now = w.chatgpt.now();
    w.file
        .set_secret(chatgpt::ACCOUNT, &json!({"clientId": "c", "accessToken": "ACCESS-TOKEN-1", "refreshToken": "r", "expiresAt": now + 3600.0}).to_string())
        .unwrap();
    assert_eq!(w.chat("hi").unwrap(), "Your token is [redacted].");
    assert_eq!(w.server.requests()[0].header("authorization"), Some("Bearer ACCESS-TOKEN-1"));
}

/// An attempt nobody finishes ends after its time, and the listener's port is free again.
#[test]
fn an_attempt_ends_after_its_time() {
    let Some(w) = World::new("timeout") else { return };
    w.chatgpt.set_sign_in_timeout(Duration::from_millis(150));
    let auth = w.start();
    thread::sleep(Duration::from_millis(400));
    assert!(!w.chatgpt.status().pending);
    let e = w.chatgpt.take_outcome().unwrap().unwrap_err();
    assert!(e.kind == ErrorKind::Timeout && e.message.contains("timed out after 5 minutes"), "{e:?}");
    assert!(w.chatgpt.complete_manual(&format!("code=c&state={}", auth["state"])).unwrap_err().message.contains("Start \"Sign in with ChatGPT\" first"));
    let port: u16 = auth["redirect_uri"].split(':').nth(2).unwrap().split('/').next().unwrap().parse().unwrap();
    let freed = (0..1000).any(|_| {
        thread::sleep(Duration::from_millis(5));
        TcpListener::bind(("127.0.0.1", port)).is_ok()
    });
    assert!(freed, "the listener is gone");
    // The address that replaces auth.openai.com must be this machine.
    assert!(w.chatgpt.set_auth_base("https://evil.example").is_err());
}

/// The Assistant's rounds on the plan route: the tools go out as function tools with the
/// stream asked for, a streamed function call comes back as a tool call, and its result goes
/// back with the model's own items.
#[test]
fn the_assistants_tool_rounds_work_on_the_plan_route() {
    let call = json!({"type": "response.completed", "response": {"output": [
        {"type": "function_call", "call_id": "call_1", "name": "get_document", "arguments": "{}"}]}});
    let done = json!({"type": "response.completed", "response": {"output": [
        {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "It is 400 × 300."}]}]}});
    let Some(w) = World::with_server("assistant", MockServer::replies(vec![Reply::sse(200, &[call]), Reply::sse(200, &[done])])) else { return };
    let now = w.chatgpt.now();
    w.file
        .set_secret(chatgpt::ACCOUNT, &json!({"clientId": "c", "accessToken": "access-1", "refreshToken": "r", "expiresAt": now + 3600.0}).to_string())
        .unwrap();
    let mut req = ChatRequest {
        choice: Choice::default(),
        instructions: "You edit images.".into(),
        messages: vec![ChatMessage::User { text: "How big is it?".into(), images: vec![] }],
        tools: vec![ToolSpec { name: "get_document".into(), description: "The document".into(), parameters: json!({"type": "object", "properties": {}}) }],
    };
    let backend = w.backend();
    let turn = backend.chat(&req, &|| false).unwrap();
    assert_eq!(turn.tool_calls.len(), 1);
    let call = turn.tool_calls[0].clone();
    req.messages.push(ChatMessage::Turn(turn));
    req.messages.push(ChatMessage::ToolResults(vec![ToolResult { call_id: call.id, name: call.name, output: json!({"width": 400, "height": 300}) }]));
    assert_eq!(backend.chat(&req, &|| false).unwrap().text, "It is 400 × 300.");
    let got = w.server.requests();
    let (first, second) = (got[0].json(), got[1].json());
    assert_eq!((&first["stream"], &first["store"], &first["tool_choice"]), (&json!(true), &json!(false), &json!("auto")));
    assert_eq!(first["tools"][0]["type"], "function");
    assert_eq!(got[0].header("authorization"), Some("Bearer access-1"));
    assert!(second.to_string().contains("function_call_output") && second.to_string().contains("call_1"), "{second}");
}

/// A sign-in is too long for one Windows credential: it is kept in pieces, read back whole,
/// and a shorter one leaves no piece behind.
#[test]
fn a_long_secret_is_kept_in_pieces_where_entries_are_small() {
    use pigment_genai::keys::chunked;
    let entries: Mutex<BTreeMap<String, String>> = Mutex::default();
    let get = |k: &str| Ok(entries.lock().unwrap().get(k).cloned());
    let set = |k: &str, v: &str| {
        assert!(v.encode_utf16().count() * 2 <= 2560, "one credential holds 2560 bytes");
        entries.lock().unwrap().insert(k.to_string(), v.to_string());
        Ok(())
    };
    let del = |k: &str| {
        entries.lock().unwrap().remove(k);
        Ok(())
    };
    let long: String = (0..5000).map(|i| char::from_u32(0x1F600 + (i % 40)).unwrap()).collect();
    chunked::write("a", &long, 600, &get, &set, &del).unwrap();
    assert_eq!(entries.lock().unwrap().len(), 9);
    assert_eq!(chunked::read("a", &get).unwrap().as_deref(), Some(long.as_str()));
    chunked::write("a", "{\"short\":true}", 600, &get, &set, &del).unwrap();
    assert_eq!(entries.lock().unwrap().keys().cloned().collect::<Vec<_>>(), ["a"]);
    assert_eq!(chunked::read("a", &get).unwrap().as_deref(), Some("{\"short\":true}"));
    chunked::write("a", &long, 600, &get, &set, &del).unwrap();
    entries.lock().unwrap().remove("a.3");
    assert_eq!(chunked::read("a", &get).unwrap(), None, "a missing piece is no sign-in, not a damaged one");
    chunked::clear("a", &get, &del).unwrap();
    assert!(entries.lock().unwrap().is_empty());
    entries.lock().unwrap().insert("a".into(), "999999:x".into());
    assert_eq!(chunked::read("a", &get).unwrap(), None);
    // The memory store, which the tests' accounts use, keeps secrets beside the keys.
    let memory = MemoryStore::default();
    memory.set_secret("x", "y").unwrap();
    assert_eq!(memory.get_secret("x").unwrap().as_deref(), Some("y"));
    assert!(memory.set_secret("x", "").is_err() && memory.set_secret("x", &"z".repeat(200_000)).is_err());
    memory.clear_secret("x").unwrap();
    assert_eq!(memory.get_secret("x").unwrap(), None);
}
