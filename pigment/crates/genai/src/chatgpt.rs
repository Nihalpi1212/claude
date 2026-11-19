//! Sign in with ChatGPT (experimental): the person's ChatGPT Plus or Pro plan for **chat models
//! only** (the Assistant, Describe Image). Image models always need an API key. Ported from the
//! JavaScript Pigment's `src/main/ai.js`.
//!
//! The flow is OpenAI's open "Sign in with ChatGPT" token-sharing flow for third-party apps: a
//! public PKCE client (there is no client secret anywhere), registered on the first sign-in as a
//! dynamic agent client. It is not documented as a stable API and **was never verified against
//! the live service** (neither here nor in the JavaScript app, whose tests also drove a fake token
//! endpoint), so AI Accounts marks it experimental, and it is isolated: [`ENABLED`] (or
//! `"chatgptSignIn": false` in `ai.json`) turns it off, and nothing an API key uses goes through
//! this module.
//!
//! * **Sign-in** ([`ChatGpt::start`]): a listener on 127.0.0.1 (the first free port of
//!   [`PORTS`]) waits for the browser's callback; the authorize URL is handed to the caller, who
//!   opens it. With every port taken the attempt goes on without a listener and the person pastes
//!   the address the browser landed on ([`ChatGpt::complete_manual`]), which also serves a
//!   browser on another computer. The callback's `state` is checked before anything else; the
//!   code is exchanged for tokens (PKCE S256), the ID token's issuer, audience, expiry and nonce
//!   are checked (not its signature: it came over TLS from the token endpoint and is never used
//!   as a credential), and the tokens are stored. One attempt at a time, five minutes each.
//! * **Tokens** live in the key store under [`ACCOUNT`] as JSON, never in `ai.json`, a document,
//!   a log or a message: every error built here has the code, the verifier and the tokens taken
//!   out. An OpenAI API key and a sign-in exclude each other, as in the JavaScript app.
//! * **Requests** ([`ChatGpt::access_token`]): the stored access token until five minutes before
//!   it expires (never refreshed before `earliest_refresh_at`), then a refresh with rotation, one
//!   at a time. A refresh the server refuses for good ([`FATAL_TOKEN_ERRORS`]) clears the
//!   sign-in; one that lands after the sign-in was replaced (Sign Out, a new key) is dropped. The
//!   provider sends chat requests to the same API root with the access token, reshaped
//!   ([`reshape_for_plan_route`]) and streamed ([`aggregate_sse`]); a 401 refreshes once.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::cancel::Cancelled;
use crate::http::{Body, Http, Request};
use crate::keys::SecretStore;
use crate::provider::{self, clip, is_loopback};
use crate::{AiError, ErrorKind, ProviderId, Result};

/// The switch: `false` builds Pigment without Sign in with ChatGPT. AI Accounts then has no such
/// row, a stored sign-in is ignored (not deleted), and API keys work as before.
pub const ENABLED: bool = true;

/// The key store account the tokens are kept under.
pub const ACCOUNT: &str = "openai-chatgpt";

pub const AUTHORIZE_URL: &str = "https://auth.openai.com/api/accounts/authorize";
pub const TOKEN_URL: &str = "https://auth.openai.com/api/accounts/oauth/token";
pub const ISSUER: &str = "https://auth.openai.com";
/// Sent on authorize, the code exchange and every refresh.
pub const RESOURCE: &str = "https://api.openai.com/v1";
pub const SCOPE: &str = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
/// Granted: the plan may be used from this app.
pub const PLAN_SCOPE: &str = "chatgpt.tokens.use.direct";
/// The client id of the first sign-in; the callback then carries the issued one (`oaiapp_…`).
pub const DYNAMIC_CLIENT_ID: &str = "dynamic_agent_client";
pub const AGENT_NAME_HINT: &str = "Pigment";
pub const CALLBACK_PATH: &str = "/auth/callback";
/// The loopback ports tried in order (127.0.0.1 only).
pub const PORTS: [u16; 6] = [1455, 1456, 1457, 1458, 1459, 1460];
pub const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// A token is refreshed this long before it expires.
pub const REFRESH_LEAD_SECS: f64 = 5.0 * 60.0;
/// Token requests (the code exchange, a refresh).
pub const TOKEN_TIMEOUT: Duration = Duration::from_secs(30);

/// `PIGMENT_AI_AUTH_URL_CHATGPT`: a loopback address standing in for `https://auth.openai.com`
/// (the tests' mock, a manual check against a local one). Anything else is ignored.
pub const AUTH_URL_ENV: &str = "PIGMENT_AI_AUTH_URL_CHATGPT";

/// Token errors after which the stored sign-in can never work again.
pub const FATAL_TOKEN_ERRORS: [&str; 7] =
    ["invalid_grant", "invalid_client", "invalid_refresh_token", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused", "token_expired"];

/// Request parameters the ChatGPT plan route refuses on `POST /responses`.
pub const PLAN_ROUTE_DROPPED_PARAMS: [&str; 18] = [
    "background",
    "conversation",
    "max_output_tokens",
    "max_tool_calls",
    "metadata",
    "moderation",
    "multi_agent",
    "prompt",
    "prompt_cache_key",
    "prompt_cache_options",
    "prompt_cache_retention",
    "safety_identifier",
    "service_tier",
    "temperature",
    "top_logprobs",
    "top_p",
    "truncation",
    "user",
];
/// Hosted tools the plan route refuses (function tools and `web_search` stay).
pub const PLAN_ROUTE_DROPPED_TOOLS: [&str; 5] = ["code_interpreter", "file_search", "image_generation", "mcp", "tool_search"];

/// Longest token, callback address and token answer taken.
const MAX_TOKEN_LEN: usize = 24 * 1024;
const MAX_CALLBACK_LEN: usize = 8 * 1024;
const MAX_TOKEN_ANSWER: usize = 1024 * 1024;
/// Most callback connections served at once (the browser makes one or two).
const MAX_CONNECTIONS: usize = 8;

// ---- PKCE and the authorization URL ---------------------------------------------------------

/// Base64 with the URL-safe alphabet and no padding.
pub fn base64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// The S256 code challenge of a verifier.
pub fn pkce_challenge(verifier: &str) -> String {
    base64url(&Sha256::digest(verifier.as_bytes()))
}

/// A PKCE verifier and its challenge.
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
    pub method: &'static str,
}

fn random_bytes(n: usize) -> Result<Vec<u8>> {
    let mut bytes = vec![0u8; n];
    getrandom::fill(&mut bytes).map_err(|e| AiError::new(ErrorKind::KeyStore, format!("Pigment could not get random bytes for the sign-in: {e}.")))?;
    Ok(bytes)
}

/// `bytes` random bytes as URL-safe text (the `state`, the `nonce`).
pub fn random_token(bytes: usize) -> Result<String> {
    Ok(base64url(&random_bytes(bytes)?))
}

pub fn create_pkce() -> Result<Pkce> {
    let verifier = random_token(48)?;
    Ok(Pkce { challenge: pkce_challenge(&verifier), verifier, method: "S256" })
}

/// A new installation id (`urn:uuid:` and a random version-4 UUID). It tells the sign-in server
/// that later sign-ins come from the same installation.
pub fn new_host_id() -> Result<String> {
    let mut b = random_bytes(16)?;
    if let Some(x) = b.get_mut(6) {
        *x = (*x & 0x0f) | 0x40;
    }
    if let Some(x) = b.get_mut(8) {
        *x = (*x & 0x3f) | 0x80;
    }
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    let part = |a: usize, z: usize| hex.get(a..z).unwrap_or_default();
    Ok(format!("urn:uuid:{}-{}-{}-{}-{}", part(0, 8), part(8, 12), part(12, 16), part(16, 20), part(20, 32)))
}

/// `application/x-www-form-urlencoded` text for one name or value (a space is `+`).
fn form_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => out.push(char::from(b)),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn form_encode(pairs: &[(&str, &str)]) -> String {
    pairs.iter().map(|(k, v)| format!("{}={}", form_escape(k), form_escape(v))).collect::<Vec<_>>().join("&")
}

fn form_unescape(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let hex = |b: Option<&u8>| b.and_then(|b| char::from(*b).to_digit(16));
    let mut i = 0;
    while let Some(&b) = bytes.get(i) {
        match b {
            b'+' => out.push(b' '),
            b'%' => match (hex(bytes.get(i + 1)), hex(bytes.get(i + 2))) {
                (Some(hi), Some(lo)) => {
                    out.push(u8::try_from(hi * 16 + lo).unwrap_or(b'?'));
                    i += 2;
                }
                _ => out.push(b'%'),
            },
            _ => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// What the authorize URL carries.
pub struct AuthorizeParams<'a> {
    /// `None`: the dynamic client, which registers this installation.
    pub client_id: Option<&'a str>,
    pub redirect_uri: &'a str,
    pub state: &'a str,
    pub nonce: &'a str,
    pub code_challenge: &'a str,
    pub host_id: Option<&'a str>,
}

/// The authorize URL of the sign-in flow. The dynamic client carries the registration hints (the
/// app's name and the installation id); an issued client id needs none.
pub fn build_authorize_url(p: &AuthorizeParams<'_>) -> Result<String> {
    authorize_url_at(AUTHORIZE_URL, p)
}

fn authorize_url_at(base: &str, p: &AuthorizeParams<'_>) -> Result<String> {
    if p.redirect_uri.is_empty() || p.state.is_empty() || p.nonce.is_empty() || p.code_challenge.is_empty() {
        return Err(AiError::bad_request("Incomplete sign-in parameters."));
    }
    let client_id = p.client_id.unwrap_or(DYNAMIC_CLIENT_ID);
    let mut pairs = vec![
        ("response_type", "code"),
        ("client_id", client_id),
        ("redirect_uri", p.redirect_uri),
        ("scope", SCOPE),
        ("resource", RESOURCE),
        ("state", p.state),
        ("nonce", p.nonce),
        ("code_challenge", p.code_challenge),
        ("code_challenge_method", "S256"),
    ];
    if client_id == DYNAMIC_CLIENT_ID {
        pairs.push(("agent_name_hint", AGENT_NAME_HINT));
        if let Some(host) = p.host_id.filter(|h| !h.is_empty()) {
            pairs.push(("ext_agent_host_id", host));
        }
    }
    Ok(format!("{base}?{}", form_encode(&pairs)))
}

pub fn redirect_uri_for(port: u16) -> String {
    format!("http://127.0.0.1:{port}{CALLBACK_PATH}")
}

/// What the browser was sent back with.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Callback {
    pub code: Option<String>,
    pub state: Option<String>,
    /// The client id issued to this installation (`oaiapp_…`), when the callback carries one.
    pub client_id: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

fn bad_callback(message: &str) -> AiError {
    AiError::bad_request(message)
}

/// Whether `text` starts like a URL with a scheme (`http://…`).
fn has_scheme(text: &str) -> bool {
    let Some((scheme, _)) = text.split_once("://") else { return false };
    let mut chars = scheme.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic()) && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
}

/// Parses the callback the browser was sent to: a full URL, a path with a query, or a bare query
/// string (the pasted address).
pub fn parse_callback(input: &str) -> Result<Callback> {
    let text = input.trim();
    if text.is_empty() {
        return Err(bad_callback("Paste the full address of the page the browser landed on."));
    }
    let unreadable = || bad_callback("That does not look like a callback address.");
    if text.len() > MAX_CALLBACK_LEN || text.chars().any(char::is_control) {
        return Err(unreadable());
    }
    let query = if has_scheme(text) {
        let rest = text.split_once("://").map(|(_, r)| r).unwrap_or_default();
        let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
        if authority.is_empty() || text.contains(char::is_whitespace) {
            return Err(unreadable());
        }
        text.split_once('?').map(|(_, q)| q).unwrap_or_default()
    } else if text.starts_with('/') {
        text.split_once('?').map(|(_, q)| q).unwrap_or_default()
    } else {
        text.strip_prefix('?').unwrap_or(text)
    };
    let query = query.split('#').next().unwrap_or_default();
    let get = |name: &str| {
        query
            .split('&')
            .filter_map(|pair| {
                let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
                (form_unescape(k) == name).then(|| form_unescape(v))
            })
            .next()
            .filter(|v| !v.is_empty())
    };
    let out =
        Callback { code: get("code"), state: get("state"), client_id: get("client_id"), error: get("error"), error_description: get("error_description") };
    if out.code.is_none() && out.error.is_none() {
        return Err(bad_callback("The callback address carries no authorization code."));
    }
    Ok(out)
}

// ---- JWT helpers and ID token checks ---------------------------------------------------------

/// The claims of a JWT, unverified; `None` when it is not one.
pub fn decode_jwt(token: &str) -> Option<Map<String, Value>> {
    if token.len() > MAX_TOKEN_LEN {
        return None;
    }
    let payload = token.split('.').nth(1)?;
    let clean: String = payload
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '=')
        .map(|c| {
            if c == '+' {
                '-'
            } else if c == '/' {
                '_'
            } else {
                c
            }
        })
        .collect();
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(clean.as_bytes()).ok()?;
    if provider::json_value_bound(&bytes) > 10_000 {
        return None;
    }
    match serde_json::from_slice(&bytes).ok()? {
        Value::Object(claims) => Some(claims),
        _ => None,
    }
}

fn invalid_id_token(message: &str) -> AiError {
    AiError::bad_response(message)
}

/// Checks the ID token claims that matter for the sign-in: the issuer, the audience (it holds
/// the client id), the expiry and, when given, the nonce. Returns the claims. The signature is
/// not checked: the token came over TLS straight from the token endpoint and is never used as a
/// credential.
pub fn validate_id_token(token: &str, client_id: Option<&str>, nonce: Option<&str>, now: f64) -> Result<Map<String, Value>> {
    let claims = decode_jwt(token).ok_or_else(|| invalid_id_token("The sign-in answer carried no readable ID token."))?;
    if claims.get("iss").and_then(Value::as_str) != Some(ISSUER) {
        return Err(invalid_id_token("The ID token was not issued by auth.openai.com."));
    }
    if let Some(id) = client_id.filter(|c| !c.is_empty()) {
        let listed = match claims.get("aud") {
            Some(Value::Array(a)) => a.iter().any(|v| v.as_str() == Some(id)),
            Some(v) => v.as_str() == Some(id),
            None => false,
        };
        if !listed {
            return Err(invalid_id_token("The ID token was issued for another application."));
        }
    }
    if !claims.get("exp").and_then(Value::as_f64).is_some_and(|exp| exp > now) {
        return Err(invalid_id_token("The ID token has already expired."));
    }
    if let Some(n) = nonce.filter(|n| !n.is_empty())
        && claims.get("nonce").and_then(Value::as_str) != Some(n)
    {
        return Err(invalid_id_token("The ID token does not match this sign-in attempt."));
    }
    Ok(claims)
}

/// What a token pair says about the account. Nothing secret: the e-mail address and whether the
/// plan may be used from this app.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AccountInfo {
    pub email: Option<String>,
    /// `None`: the answer names no scopes.
    pub plan: Option<bool>,
}

/// An e-mail address as it is kept and shown: one line, at most 254 characters.
fn tidy_email(s: &str) -> Option<String> {
    let s: String = s.chars().filter(|c| !c.is_control()).take(254).collect();
    let s = s.trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// The account details of a token answer (`id_token`, `access_token`, `scope`).
pub fn account_info(tokens: &Value) -> AccountInfo {
    let claims = |name: &str| tokens.get(name).and_then(Value::as_str).and_then(decode_jwt).unwrap_or_default();
    let (id, access) = (claims("id_token"), claims("access_token"));
    let email = id.get("email").and_then(Value::as_str).or_else(|| access.get("email").and_then(Value::as_str)).and_then(tidy_email);
    let words = |s: &str| s.split_whitespace().map(str::to_string).collect::<Vec<_>>();
    let scopes = match (tokens.get("scope").and_then(Value::as_str), access.get("scp"), access.get("scope").and_then(Value::as_str)) {
        (Some(s), ..) => Some(words(s)),
        (None, Some(Value::Array(a)), _) => Some(a.iter().filter_map(Value::as_str).map(str::to_string).collect()),
        (None, _, Some(s)) => Some(words(s)),
        _ => None,
    };
    AccountInfo { email, plan: scopes.map(|s| s.iter().any(|x| x == PLAN_SCOPE)) }
}

/// `earliest_refresh_at` comes as seconds, milliseconds or an ISO date; epoch seconds (0: none).
pub fn parse_refresh_at(value: &Value) -> f64 {
    let scaled = |n: f64| if n > 1e11 { n / 1000.0 } else { n };
    let secs = match value {
        Value::Number(n) => n.as_f64().map(scaled),
        Value::String(s) if s.trim().is_empty() => None,
        Value::String(s) => match s.trim().parse::<f64>() {
            Ok(n) if n.is_finite() => Some(scaled(n)),
            _ => chrono::DateTime::parse_from_rfc3339(s.trim()).ok().map(|t| t.timestamp_millis() as f64 / 1000.0),
        },
        _ => None,
    };
    secs.filter(|s| s.is_finite() && *s > 0.0).unwrap_or(0.0)
}

// ---- plan-route reshaping --------------------------------------------------------------------

/// The text of a `system` or `developer` input item.
fn item_text(item: &Value) -> String {
    match item.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .map(|c| c.as_str().or_else(|| c.get("text").and_then(Value::as_str)).unwrap_or_default())
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// A `POST /responses` body reshaped for the ChatGPT plan route: not stored, streamed, `system`
/// and `developer` messages moved into `instructions`, the parameters and hosted tools the route
/// refuses dropped, `tool_choice` only as a string.
pub fn reshape_for_plan_route(body: &Value) -> Value {
    let mut out = body.as_object().cloned().unwrap_or_default();
    for k in PLAN_ROUTE_DROPPED_PARAMS {
        out.remove(k);
    }
    out.insert("store".into(), json!(false));
    out.insert("stream".into(), json!(true));
    if let Some(Value::Array(input)) = out.get("input").cloned() {
        let mut system = Vec::new();
        let kept: Vec<Value> = input
            .into_iter()
            .filter(|it| {
                let role = it.get("role").and_then(Value::as_str);
                let ty = it.get("type").and_then(Value::as_str);
                let moved = matches!(role, Some("system" | "developer")) && matches!(ty, Some("message") | None);
                if moved {
                    let t = item_text(it);
                    if !t.is_empty() {
                        system.push(t);
                    }
                }
                !moved
            })
            .collect();
        out.insert("input".into(), Value::Array(kept));
        if !system.is_empty() {
            let own = out.get("instructions").and_then(Value::as_str).unwrap_or_default().to_string();
            let all: Vec<String> = std::iter::once(own).chain(system).filter(|s| !s.is_empty()).collect();
            out.insert("instructions".into(), json!(all.join("\n\n")));
        }
    }
    if let Some(Value::Array(tools)) = out.get("tools").cloned() {
        let kept = tools.into_iter().filter(|t| !t.get("type").and_then(Value::as_str).is_some_and(|ty| PLAN_ROUTE_DROPPED_TOOLS.contains(&ty))).collect();
        out.insert("tools".into(), Value::Array(kept));
    }
    if out.get("tool_choice").is_some_and(Value::is_object) {
        out.remove("tool_choice");
    }
    Value::Object(out)
}

// ---- SSE aggregation -------------------------------------------------------------------------

/// The streamed text of a Responses API call folded into the `response` of its
/// `response.completed` (or `response.incomplete`) event. A `response.failed` or `error` event
/// is the request's failure. Without a final event, the text deltas become the message
/// (`"partial": true`).
pub fn aggregate_sse(text: &str) -> Result<Value> {
    let (mut completed, mut failed, mut delta) = (None, None, String::new());
    for block in text.replace("\r\n", "\n").split("\n\n") {
        let data: Vec<&str> = block.lines().filter_map(|l| l.strip_prefix("data:")).map(str::trim).collect();
        let data = data.join("\n");
        if data.is_empty() || data == "[DONE]" || provider::json_value_bound(data.as_bytes()) > provider::MAX_JSON_VALUES {
            continue;
        }
        let Ok(ev) = serde_json::from_str::<Value>(&data) else { continue };
        match ev.get("type").and_then(Value::as_str) {
            Some("response.completed" | "response.incomplete") => {
                if let Some(r) = ev.get("response").filter(|r| !r.is_null()) {
                    completed = Some(r.clone());
                }
            }
            Some("response.failed") => {
                let e = ev.pointer("/response/error").or_else(|| ev.get("error")).filter(|e| !e.is_null()).cloned();
                failed = Some(e.unwrap_or_else(|| json!({ "message": "The response failed" })));
            }
            Some("error") => failed = Some(ev.get("error").filter(|e| !e.is_null()).cloned().unwrap_or(ev)),
            Some("response.output_text.delta") => delta.push_str(ev.get("delta").and_then(Value::as_str).unwrap_or_default()),
            _ => {}
        }
    }
    if let Some(e) = failed {
        return Err(translate_error(0, &json!({ "error": e })).into_error_from("OpenAI"));
    }
    Ok(completed.unwrap_or_else(|| {
        json!({ "object": "response", "partial": true,
            "output": [{ "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": delta }] }] })
    }))
}

/// Whether `text` starts like an event stream (a `data:`, `event:`, `id:` or `retry:` line in
/// its first 2000 characters).
pub fn looks_like_sse(text: &str) -> bool {
    let head: String = text.chars().take(2000).collect();
    head.lines().any(|l| ["data:", "event:", "id:", "retry:"].iter().any(|p| l.starts_with(p)))
}

// ---- error translation -----------------------------------------------------------------------

/// A provider or token-endpoint error as the JavaScript app read it: the message for the person,
/// the provider's code, the HTTP status.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Translated {
    pub message: String,
    pub code: Option<String>,
    pub status: u16,
}

/// Reads an error body (`{error: {message, code}}`, `{error: "code", error_description}`, a bare
/// object, text, nothing). The plan route's `subscription_sharing_*` codes get their
/// explanation; without a message, the HTTP status gets one.
pub fn translate_error(status: u16, body: &Value) -> Translated {
    let e = body.as_object().map(|o| o.get("error").filter(|e| e.is_object()).unwrap_or(body));
    let text = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
    let mut code = e.and_then(|e| ["code", "error", "type", "status", "reason"].iter().find_map(|k| text(e, k)));
    let raw = e
        .and_then(|e| text(e, "message").or_else(|| text(e, "error_description")))
        .or_else(|| body.as_str().map(str::to_string))
        .or_else(|| text(body, "error_description"))
        .unwrap_or_default();
    let mut message = clip(raw.trim(), 300);
    if let Some(hint) = code.as_deref().and_then(provider::subscription_hint) {
        message = hint.1.to_string();
    } else if message.is_empty() {
        message = match status {
            401 => "The provider rejected the credentials (sign in again or check the API key)".into(),
            403 => "The provider refused this request".into(),
            404 => "The model or endpoint was not found".into(),
            429 => "Too many requests or the quota is exhausted; try again later".into(),
            s if s >= 500 => "The provider is having trouble; try again later".into(),
            0 => "Request failed".into(),
            s => format!("Request failed ({s})"),
        };
    }
    if code.is_none() && status == 429 {
        code = Some("rate_limited".into());
    }
    Translated { message, code, status }
}

impl Translated {
    /// Whether the code is one after which the stored sign-in can never work again.
    pub fn fatal(&self) -> bool {
        self.code.as_deref().is_some_and(|c| FATAL_TOKEN_ERRORS.contains(&c))
    }

    /// The error for the person: the plan route's explanations as they are, anything else as
    /// `who` said it ("OpenAI: …").
    pub fn into_error_from(self, who: &str) -> AiError {
        let hinted = self.code.as_deref().and_then(provider::subscription_hint).is_some();
        let mut e = self.into_error();
        if !hinted {
            e.message = format!("{who}: {}", e.message);
        }
        e
    }

    /// The error with the message as translated, and the kind the interface acts on.
    pub fn into_error(self) -> AiError {
        let code = self.code.as_deref().unwrap_or_default().to_ascii_lowercase();
        let kind = if let Some(hint) = provider::subscription_hint(&code) {
            hint.0
        } else if self.fatal() || matches!(self.status, 401 | 403) {
            ErrorKind::InvalidKey
        } else if self.status == 429 || code.contains("rate_limit") || code.contains("quota") || code == "resource_exhausted" {
            ErrorKind::Quota
        } else if code.contains("content_policy") || code.contains("moderation") || code.contains("safety") {
            ErrorKind::Safety
        } else if self.status >= 500 || code.contains("server_error") {
            ErrorKind::Server
        } else if self.status == 404 {
            ErrorKind::NotFound
        } else if self.status == 0 {
            ErrorKind::BadResponse
        } else {
            ErrorKind::BadRequest
        };
        AiError::new(kind, self.message).with_status(self.status)
    }
}

// ---- callback page ---------------------------------------------------------------------------

fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// The page the browser shows once the callback was taken.
pub fn callback_page(ok: bool, reason: &str) -> String {
    let title = if ok { "Signed in" } else { "Sign-in failed" };
    let reason = reason.trim().trim_end_matches('.');
    let body = if ok {
        "Pigment is now connected to your ChatGPT account.".to_string()
    } else if reason.is_empty() {
        "Pigment could not finish the sign-in.".to_string()
    } else {
        format!("Pigment could not finish the sign-in: {}.", escape_html(reason))
    };
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Pigment — {title}</title><style>body{{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f4f6;color:#1e1e24;display:grid;place-items:center;height:100vh;margin:0}}main{{background:#fff;border:1px solid #d9d9e0;border-radius:12px;padding:32px 40px;max-width:460px;text-align:center}}h1{{font-size:20px;margin:0 0 8px}}p{{margin:6px 0;color:#5f6270}}</style></head><body><main><h1>{title}</h1><p>{body}</p><p><strong>You can return to Pigment.</strong></p></main></body></html>"
    )
}

// ---- the sign-in itself ----------------------------------------------------------------------

/// The account a sign-in belongs to, as AI Accounts shows it. Nothing secret.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct SignedIn {
    pub email: Option<String>,
    /// Whether the plan may be used from this app (`false`: "plan access not granted").
    pub plan: Option<bool>,
}

/// A sign-in attempt as AI Accounts shows it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SignInStatus {
    pub pending: bool,
    /// The address to open in a browser (Copy Link).
    pub url: Option<String>,
    /// Every loopback port is taken: the sign-in ends by pasting the address the browser lands on.
    pub warning: Option<String>,
}

/// What is stored under [`ACCOUNT`]. Never printed: it has no `Debug`.
#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Record {
    client_id: String,
    access_token: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
    /// Epoch seconds.
    expires_at: f64,
    /// Epoch seconds; 0: no limit.
    earliest_refresh_at: f64,
    email: Option<String>,
    plan: Option<bool>,
    signed_in_at: f64,
}

impl Record {
    fn usable(&self) -> bool {
        !self.access_token.is_empty() || self.refresh_token.as_deref().is_some_and(|t| !t.is_empty())
    }

    fn account(&self) -> SignedIn {
        SignedIn { email: self.email.clone(), plan: self.plan }
    }

    fn secrets(&self) -> Vec<String> {
        [Some(self.access_token.clone()), self.refresh_token.clone(), self.id_token.clone()].into_iter().flatten().filter(|s| !s.is_empty()).collect()
    }
}

type Outcome = Result<SignedIn>;

/// One sign-in attempt. Holds the PKCE verifier: no `Debug`.
struct Attempt {
    id: u64,
    state: String,
    nonce: String,
    verifier: String,
    redirect_uri: String,
    url: String,
    warning: Option<String>,
    deadline: Instant,
    ended: AtomicBool,
    /// Held while the code is exchanged: a second callback waits for the first one's result.
    exchanging: Mutex<()>,
    result: Mutex<Option<Outcome>>,
}

struct Inner {
    /// Bumped whenever the OpenAI entry is replaced or removed: a refresh that started before
    /// must not store, and a catalog read before is stale.
    generation: u64,
    attempt: Option<Arc<Attempt>>,
    next_attempt: u64,
    /// How the last attempt ended, until the interface takes it.
    outcome: Option<Outcome>,
    authorize_url: String,
    token_url: String,
    ports: Vec<u16>,
    timeout: Duration,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn cancelled_sign_in() -> AiError {
    AiError::new(ErrorKind::Cancelled, "Sign-in cancelled.")
}

fn no_sign_in() -> AiError {
    AiError::bad_request("No sign-in is in progress.")
}

fn not_connected() -> AiError {
    AiError::new(ErrorKind::MissingKey, "OpenAI is not connected. Sign in with ChatGPT or add an API key in Edit › AI Accounts…")
}

fn turned_off() -> AiError {
    AiError::bad_request("Sign in with ChatGPT is turned off in this copy of Pigment. Use an OpenAI API key.")
}

fn removed_while_refreshing() -> AiError {
    AiError::new(ErrorKind::MissingKey, "The ChatGPT sign-in was removed while its token was being refreshed.")
}

/// `e` with every secret in `secrets` taken out of its message.
pub(crate) fn redact_all(mut e: AiError, secrets: &[&str]) -> AiError {
    for s in secrets {
        e = e.redact(s);
    }
    e
}

/// A failed token request: the error for the person and the token endpoint's code.
struct TokenFail {
    error: AiError,
    fatal: bool,
}

impl From<AiError> for TokenFail {
    fn from(error: AiError) -> Self {
        Self { error, fatal: false }
    }
}

/// The ChatGPT sign-in of one set of AI accounts: the attempt in progress, the stored tokens and
/// their refresh. Shared (`Arc`) by the accounts, the OpenAI provider built for a signed-in
/// account and the interface.
pub struct ChatGpt {
    store: Arc<dyn SecretStore>,
    inner: Mutex<Inner>,
    /// One refresh at a time: refresh tokens rotate, and a reused one ends the sign-in.
    refreshing: Mutex<()>,
    enabled: AtomicBool,
    /// Seconds added to the clock (tests).
    clock_offset: AtomicI64,
}

impl ChatGpt {
    pub fn new(store: Arc<dyn SecretStore>) -> Self {
        Self {
            store,
            inner: Mutex::new(Inner {
                generation: 0,
                attempt: None,
                next_attempt: 1,
                outcome: None,
                authorize_url: AUTHORIZE_URL.into(),
                token_url: TOKEN_URL.into(),
                ports: PORTS.to_vec(),
                timeout: SIGN_IN_TIMEOUT,
            }),
            refreshing: Mutex::new(()),
            enabled: AtomicBool::new(true),
            clock_offset: AtomicI64::new(0),
        }
    }

    /// Whether Sign in with ChatGPT is on: [`ENABLED`], and not turned off in `ai.json`.
    pub fn enabled(&self) -> bool {
        ENABLED && self.enabled.load(Ordering::SeqCst)
    }

    /// Turn the feature off (or back on) for these accounts (`"chatgptSignIn"` in `ai.json`).
    /// Off, an attempt in progress ends and a stored sign-in is ignored, not deleted.
    pub fn set_enabled(&self, on: bool) {
        if self.enabled.swap(on, Ordering::SeqCst) && !on {
            self.cancel();
        }
    }

    /// Send the sign-in to `base` instead of `https://auth.openai.com` (`{base}/api/accounts/…`).
    /// `base` must be a loopback address: the tests' mock server.
    pub fn set_auth_base(&self, base: &str) -> Result<()> {
        if !is_loopback(base) {
            return Err(AiError::bad_request("Only a loopback address can replace the sign-in address."));
        }
        let base = base.trim_end_matches('/');
        let mut inner = lock(&self.inner);
        inner.authorize_url = format!("{base}/api/accounts/authorize");
        inner.token_url = format!("{base}/api/accounts/oauth/token");
        Ok(())
    }

    /// The loopback ports tried, in order, instead of [`PORTS`] (tests: 0 is any free port).
    #[doc(hidden)]
    pub fn set_ports(&self, ports: &[u16]) {
        lock(&self.inner).ports = ports.to_vec();
    }

    /// How long an attempt waits instead of [`SIGN_IN_TIMEOUT`] (tests).
    #[doc(hidden)]
    pub fn set_sign_in_timeout(&self, timeout: Duration) {
        lock(&self.inner).timeout = timeout;
    }

    /// Move the clock the token checks read by `secs` (tests).
    #[doc(hidden)]
    pub fn advance_clock(&self, secs: i64) {
        self.clock_offset.fetch_add(secs, Ordering::SeqCst);
    }

    /// Epoch seconds, as the token checks read them.
    pub fn now(&self) -> f64 {
        let real = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
        real + self.clock_offset.load(Ordering::SeqCst) as f64
    }

    /// Counts the times the OpenAI entry was replaced or removed here (a sign-in, Sign Out, a
    /// new key). A model catalog read under another count belongs to another account.
    pub fn generation(&self) -> u64 {
        lock(&self.inner).generation
    }

    fn load(&self) -> Result<Option<Record>> {
        let Some(text) = self.store.get_secret(ACCOUNT)? else { return Ok(None) };
        Ok(serde_json::from_str::<Record>(&text).ok().filter(Record::usable))
    }

    fn save(&self, rec: &Record) -> Result<()> {
        let text = serde_json::to_string(rec).map_err(|e| AiError::new(ErrorKind::KeyStore, format!("Pigment could not store the ChatGPT sign-in: {e}.")))?;
        self.store.set_secret(ACCOUNT, &text)
    }

    /// The account signed in, if any (and the feature is on). A store that can't be read counts
    /// as not signed in.
    pub fn signed_in(&self) -> Option<SignedIn> {
        if !self.enabled() {
            return None;
        }
        self.load().ok().flatten().map(|r| r.account())
    }

    /// A sign-in is stored, whether or not the feature is on or the record is usable: what
    /// Sign out removes. A store that can't be read counts as none.
    pub fn has_stored(&self) -> bool {
        matches!(self.store.get_secret(ACCOUNT), Ok(Some(_)))
    }

    /// The tokens stored now, for taking them out of error messages.
    pub(crate) fn secrets(&self) -> Vec<String> {
        self.load().ok().flatten().map(|r| r.secrets()).unwrap_or_default()
    }

    /// The attempt in progress, ended first when its five minutes are over.
    fn pending(&self) -> Option<Arc<Attempt>> {
        let mut inner = lock(&self.inner);
        Self::expire(&mut inner);
        inner.attempt.clone()
    }

    fn expire(inner: &mut Inner) {
        if inner.attempt.as_ref().is_some_and(|a| Instant::now() >= a.deadline) {
            Self::end(inner, None, Err(AiError::new(ErrorKind::Timeout, "The sign-in timed out after 5 minutes; try again.")));
        }
    }

    /// End the attempt in progress with `result`; with `id`, only when it is that attempt.
    fn end(inner: &mut Inner, id: Option<u64>, result: Outcome) {
        if !inner.attempt.as_ref().is_some_and(|a| id.is_none_or(|id| a.id == id)) {
            return;
        }
        if let Some(a) = inner.attempt.take() {
            a.ended.store(true, Ordering::SeqCst);
            lock(&a.result).get_or_insert_with(|| result.clone());
            inner.outcome = Some(result);
        }
    }

    /// The attempt in progress, as AI Accounts shows it.
    pub fn status(&self) -> SignInStatus {
        match self.pending() {
            Some(a) => SignInStatus { pending: true, url: Some(a.url.clone()), warning: a.warning.clone() },
            None => SignInStatus::default(),
        }
    }

    /// How the last attempt ended, once: `None` while one is in progress or after it was taken.
    pub fn take_outcome(&self) -> Option<Outcome> {
        let mut inner = lock(&self.inner);
        Self::expire(&mut inner);
        if inner.attempt.is_some() {
            return None;
        }
        inner.outcome.take()
    }

    /// End the attempt in progress ("Sign-in cancelled"). An exchange in flight stores nothing.
    pub fn cancel(&self) {
        Self::end(&mut lock(&self.inner), None, Err(cancelled_sign_in()));
    }

    /// Start a sign-in, or return the one in progress (one attempt at a time). Binds the
    /// loopback listener (`port` first when given, then the usual ports) and returns the address
    /// to open in a browser. `host_id` is the installation id ([`new_host_id`]).
    pub fn start(self: &Arc<Self>, port: Option<u16>, host_id: &str) -> Result<SignInStatus> {
        if !self.enabled() {
            return Err(turned_off());
        }
        let mut inner = lock(&self.inner);
        Self::expire(&mut inner);
        if let Some(a) = &inner.attempt {
            return Ok(SignInStatus { pending: true, url: Some(a.url.clone()), warning: a.warning.clone() });
        }
        let ports: Vec<u16> = match port {
            Some(p) => std::iter::once(p).chain(inner.ports.iter().copied().filter(|x| *x != p)).collect(),
            None => inner.ports.clone(),
        };
        let pkce = create_pkce()?;
        let (state, nonce) = (random_token(24)?, random_token(24)?);
        let (listener, bound, warning) = bind(&ports)?;
        let redirect_uri = redirect_uri_for(bound);
        let url = authorize_url_at(
            &inner.authorize_url,
            &AuthorizeParams {
                client_id: None,
                redirect_uri: &redirect_uri,
                state: &state,
                nonce: &nonce,
                code_challenge: &pkce.challenge,
                host_id: Some(host_id),
            },
        )?;
        let id = inner.next_attempt;
        inner.next_attempt += 1;
        let attempt = Arc::new(Attempt {
            id,
            state,
            nonce,
            verifier: pkce.verifier,
            redirect_uri,
            url,
            warning,
            deadline: Instant::now() + inner.timeout,
            ended: AtomicBool::new(false),
            exchanging: Mutex::new(()),
            result: Mutex::new(None),
        });
        inner.attempt = Some(Arc::clone(&attempt));
        inner.outcome = None;
        let status = SignInStatus { pending: true, url: Some(attempt.url.clone()), warning: attempt.warning.clone() };
        if let Some(listener) = listener {
            let (me, a) = (Arc::clone(self), Arc::clone(&attempt));
            let spawned = std::thread::Builder::new().name("pigment-ai-sign-in".into()).spawn(move || me.serve(&a, &listener));
            if let Err(e) = spawned {
                let err = AiError::new(ErrorKind::Network, format!("Could not start the sign-in listener: {e}."));
                Self::end(&mut inner, Some(id), Err(err.clone()));
                return Err(err);
            }
        }
        log::info!("genai: a ChatGPT sign-in started");
        Ok(status)
    }

    /// The listener's loop: callbacks until the attempt ends or its time is over.
    fn serve(self: &Arc<Self>, attempt: &Arc<Attempt>, listener: &TcpListener) {
        let _ = listener.set_nonblocking(true);
        let active = Arc::new(AtomicUsize::new(0));
        while !attempt.ended.load(Ordering::SeqCst) {
            if self.pending().is_none_or(|a| a.id != attempt.id) {
                break;
            }
            let stream = match listener.accept() {
                Ok((stream, _)) => stream,
                Err(_) => {
                    std::thread::sleep(Duration::from_millis(20));
                    continue;
                }
            };
            if active.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
                active.fetch_sub(1, Ordering::SeqCst);
                continue;
            }
            let (me, count) = (Arc::clone(self), Arc::clone(&active));
            let spawned = std::thread::Builder::new().name("pigment-ai-callback".into()).spawn(move || {
                me.answer(stream);
                count.fetch_sub(1, Ordering::SeqCst);
            });
            if spawned.is_err() {
                active.fetch_sub(1, Ordering::SeqCst);
            }
        }
    }

    /// Answer one connection to the listener.
    fn answer(&self, mut stream: TcpStream) {
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
        let Some(target) = read_target(&mut stream) else {
            return respond(&mut stream, 400, "Bad Request", "text/plain", "Bad request");
        };
        if target.split(['?', '#']).next() != Some(CALLBACK_PATH) {
            return respond(&mut stream, 404, "Not Found", "text/plain", "Not found");
        }
        let html = "text/html; charset=utf-8";
        match parse_callback(&target) {
            Err(e) => respond(&mut stream, 400, "Bad Request", html, &callback_page(false, &e.message)),
            Ok(parsed) => match self.complete(&parsed) {
                Ok(_) => respond(&mut stream, 200, "OK", html, &callback_page(true, "")),
                Err(e) => respond(&mut stream, 200, "OK", html, &callback_page(false, &e.message)),
            },
        }
    }

    /// Finish the attempt with the pasted address of the page the browser landed on (a browser
    /// on another computer, or every loopback port taken). Blocks for the code exchange.
    pub fn complete_manual(&self, callback_url: &str) -> Result<SignedIn> {
        if self.pending().is_none() {
            return Err(AiError::bad_request("Start \"Sign in with ChatGPT\" first, then paste the address the browser landed on."));
        }
        self.complete(&parse_callback(callback_url)?)
    }

    /// Exchange the code of a callback (the listener's or a pasted one) and store the sign-in.
    /// A callback without this attempt's `state` is a stray request whatever else it carries: it
    /// is refused and the attempt goes on. Any other failure ends the attempt.
    pub fn complete(&self, parsed: &Callback) -> Result<SignedIn> {
        let attempt = self.pending().ok_or_else(no_sign_in)?;
        if parsed.state.as_deref() != Some(attempt.state.as_str()) {
            return Err(AiError::bad_request("The callback belongs to another sign-in attempt; start again."));
        }
        let fail = |e: AiError| {
            Self::end(&mut lock(&self.inner), Some(attempt.id), Err(e.clone()));
            Err(e)
        };
        if let Some(code) = &parsed.error {
            let described = parsed.error_description.as_deref().map(|d| clip(d.trim(), 300)).filter(|d| !d.is_empty());
            return fail(AiError::bad_request(described.unwrap_or_else(|| format!("Sign-in refused ({}).", clip(code, 80)))));
        }
        let Some(code) = parsed.code.as_deref() else { return fail(bad_callback("The callback address carries no authorization code.")) };
        let _exchanging = lock(&attempt.exchanging);
        if let Some(r) = lock(&attempt.result).clone() {
            return r;
        }
        let r = self.exchange(&attempt, code, parsed.client_id.as_deref());
        if r.is_err() {
            Self::end(&mut lock(&self.inner), Some(attempt.id), r.clone());
        }
        // Cancelled (or timed out) while the exchange was in flight: that is how it ended.
        lock(&attempt.result).clone().unwrap_or(r)
    }

    fn exchange(&self, attempt: &Attempt, code: &str, client_id: Option<&str>) -> Result<SignedIn> {
        let client_id = client_id.unwrap_or(DYNAMIC_CLIENT_ID);
        if client_id.len() > 200 || !client_id.bytes().all(|b| b.is_ascii_graphic()) {
            return Err(bad_callback("That does not look like a callback address."));
        }
        let token_url = lock(&self.inner).token_url.clone();
        let stop = || attempt.ended.load(Ordering::SeqCst);
        let form = [
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", attempt.verifier.as_str()),
            ("redirect_uri", attempt.redirect_uri.as_str()),
            ("client_id", client_id),
            ("resource", RESOURCE),
        ];
        let tokens = match token_request(&token_url, &form, &stop) {
            Ok(t) => t,
            Err(_) if stop() => return Err(cancelled_sign_in()),
            Err(f) => return Err(redact_all(f.error, &[code, &attempt.verifier])),
        };
        // Check and store under the lock, so a Cancel can't land in between.
        let mut inner = lock(&self.inner);
        if !inner.attempt.as_ref().is_some_and(|a| a.id == attempt.id) {
            return Err(cancelled_sign_in());
        }
        let rec = record_from(None, &tokens, client_id, Some(&attempt.nonce), self.now(), false)?;
        self.save(&rec)?;
        // A sign-in replaces an OpenAI API key, as in the JavaScript app.
        if let Err(e) = self.store.clear(ProviderId::OpenAi) {
            let _ = self.store.clear_secret(ACCOUNT);
            return Err(e);
        }
        inner.generation += 1;
        Self::end(&mut inner, Some(attempt.id), Ok(rec.account()));
        log::info!("genai: signed in with ChatGPT");
        Ok(rec.account())
    }

    /// Forget the sign-in: Sign Out, and what an OpenAI API key being stored or removed does to
    /// it. Ends an attempt in progress. There is no server-side revocation, as in the JavaScript
    /// app.
    pub fn sign_out(&self) -> Result<()> {
        let mut inner = lock(&self.inner);
        Self::end(&mut inner, None, Err(cancelled_sign_in()));
        inner.generation += 1;
        self.store.clear_secret(ACCOUNT)
    }

    /// A usable access token. `stale` is a token the provider just refused (a 401): it is
    /// refreshed whatever its expiry says, unless another request already did.
    pub fn access_token(&self, stale: Option<&str>, cancelled: Cancelled<'_>) -> Result<String> {
        if !self.enabled() {
            return Err(turned_off());
        }
        let rec = self.load()?.ok_or_else(not_connected)?;
        if self.current(&rec, stale) {
            return Ok(rec.access_token);
        }
        self.refresh(stale, cancelled)
    }

    /// Whether `rec`'s access token can be used as it is.
    fn current(&self, rec: &Record, stale: Option<&str>) -> bool {
        if rec.access_token.is_empty() || stale == Some(rec.access_token.as_str()) {
            return false;
        }
        if stale.is_some() {
            // Another request refreshed while this one was refused.
            return true;
        }
        let now = self.now();
        // Not before `earliest_refresh_at`: until then the token works as long as it has not expired.
        now < rec.expires_at - REFRESH_LEAD_SECS || (now < rec.earliest_refresh_at && now < rec.expires_at)
    }

    fn refresh(&self, stale: Option<&str>, cancelled: Cancelled<'_>) -> Result<String> {
        let _one = lock(&self.refreshing);
        // Another request may have refreshed while this one waited.
        let rec = self.load()?.ok_or_else(not_connected)?;
        if self.current(&rec, stale) {
            return Ok(rec.access_token);
        }
        let (generation, token_url) = {
            let inner = lock(&self.inner);
            (inner.generation, inner.token_url.clone())
        };
        let Some(refresh_token) = rec.refresh_token.clone().filter(|t| !t.is_empty()) else {
            self.clear_if_same(generation, &rec);
            return Err(AiError::new(ErrorKind::InvalidKey, "Your ChatGPT sign-in is no longer usable. Sign in again in Edit › AI Accounts…"));
        };
        let form = [("grant_type", "refresh_token"), ("refresh_token", refresh_token.as_str()), ("client_id", rec.client_id.as_str()), ("resource", RESOURCE)];
        let tokens = match token_request(&token_url, &form, cancelled) {
            Ok(t) => t,
            Err(f) => {
                // Replaced (Sign Out, an API key, a new sign-in) while the refresh was in flight:
                // the new entry must survive.
                if !self.same(generation, &rec) {
                    return Err(removed_while_refreshing());
                }
                if f.fatal {
                    self.clear_if_same(generation, &rec);
                    return Err(AiError::new(ErrorKind::InvalidKey, "Your ChatGPT sign-in has expired. Sign in again in Edit › AI Accounts…")
                        .with_status(f.error.status));
                }
                return Err(redact_all(f.error, &[&refresh_token, &rec.access_token]));
            }
        };
        // The server has rotated the refresh token by now, so a refreshed ID token that does
        // not validate is dropped (the previous one is kept) rather than costing the sign-in.
        let next = record_from(Some(&rec), &tokens, &rec.client_id, None, self.now(), true)?;
        let inner = lock(&self.inner);
        if inner.generation != generation || self.load().ok().flatten().as_ref() != Some(&rec) {
            return Err(removed_while_refreshing());
        }
        self.save(&next)?;
        drop(inner);
        Ok(next.access_token)
    }

    /// Whether the stored sign-in is still `rec`, untouched since `generation`.
    fn same(&self, generation: u64, rec: &Record) -> bool {
        lock(&self.inner).generation == generation && self.load().ok().flatten().as_ref() == Some(rec)
    }

    fn clear_if_same(&self, generation: u64, rec: &Record) {
        let mut inner = lock(&self.inner);
        if inner.generation == generation && self.load().ok().flatten().as_ref() == Some(rec) {
            inner.generation += 1;
            let _ = self.store.clear_secret(ACCOUNT);
        }
    }
}

/// The record a token answer makes. `prev` is the record being refreshed (its refresh token, ID
/// token, e-mail and plan stay where the answer has none); `nonce` is the attempt's on the first
/// exchange, which must carry an ID token. `lenient`: an ID token that does not validate is
/// dropped instead of failing.
fn record_from(prev: Option<&Record>, tokens: &Value, client_id: &str, nonce: Option<&str>, now: f64, lenient: bool) -> Result<Record> {
    let token = |name: &str| tokens.get(name).and_then(Value::as_str).filter(|t| !t.is_empty());
    let access = token("access_token").ok_or_else(|| AiError::bad_response("The token endpoint answered without an access token."))?;
    if [Some(access), token("refresh_token"), token("id_token")].into_iter().flatten().any(|t| t.len() > MAX_TOKEN_LEN) {
        return Err(AiError::bad_response("The token endpoint answered with a token too long to keep."));
    }
    // The first exchange (a nonce was sent) must answer with an ID token, or the claims are never checked.
    let mut id_token = token("id_token");
    if nonce.is_some() && id_token.is_none() {
        return Err(invalid_id_token("The sign-in answer carried no ID token."));
    }
    let mut tokens = tokens.clone();
    if let Some(t) = id_token
        && let Err(e) = validate_id_token(t, Some(client_id), nonce, now)
    {
        if !lenient {
            return Err(e);
        }
        log::warn!("genai: the refreshed ID token did not validate; keeping the previous one");
        id_token = None;
        if let Some(o) = tokens.as_object_mut() {
            o.remove("id_token");
        }
    }
    let info = account_info(&tokens);
    let expires_in = match tokens.get("expires_in") {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
    .filter(|s| s.is_finite() && *s > 0.0)
    .map_or(3600.0, |s| s.min(366.0 * 86400.0));
    Ok(Record {
        client_id: client_id.to_string(),
        access_token: access.to_string(),
        refresh_token: token("refresh_token").map(str::to_string).or_else(|| prev.and_then(|p| p.refresh_token.clone())),
        id_token: id_token.map(str::to_string).or_else(|| prev.and_then(|p| p.id_token.clone())),
        expires_at: now + expires_in,
        earliest_refresh_at: parse_refresh_at(tokens.get("earliest_refresh_at").unwrap_or(&Value::Null)),
        email: info.email.or_else(|| prev.and_then(|p| p.email.clone())),
        plan: info.plan.or_else(|| prev.and_then(|p| p.plan)),
        signed_in_at: prev.map_or(now, |p| p.signed_in_at),
    })
}

/// One form POST to the token endpoint: the token answer, or why not.
fn token_request(token_url: &str, form: &[(&str, &str)], cancelled: Cancelled<'_>) -> std::result::Result<Value, TokenFail> {
    let http = Http::new(token_url, TOKEN_TIMEOUT, MAX_TOKEN_ANSWER);
    let req = Request { url: token_url.to_string(), headers: vec![("Accept", "application/json".into())], body: Body::Form(form_encode(form)) };
    let resp = http.send(req, cancelled)?;
    // What was sent in confidence is taken out of the answer before anything reads it.
    let sent: Vec<&str> = form.iter().filter(|(k, _)| matches!(*k, "code" | "code_verifier" | "refresh_token")).map(|(_, v)| *v).collect();
    let text = provider::scrub(resp.body, &sent);
    let body: Value = if provider::json_value_bound(&text) > 10_000 { Value::Null } else { serde_json::from_slice(&text).unwrap_or(Value::Null) };
    if !(200..300).contains(&resp.status) {
        let t = translate_error(resp.status, &body);
        return Err(TokenFail { fatal: t.fatal(), error: t.into_error_from("The ChatGPT sign-in server") });
    }
    if !body.get("access_token").is_some_and(|t| t.as_str().is_some_and(|s| !s.is_empty())) {
        return Err(AiError::bad_response("The token endpoint answered without an access token.").with_status(resp.status).into());
    }
    Ok(body)
}

/// The listener for the callback: the first of `ports` that is free on 127.0.0.1. With every one
/// taken there is none; the redirect names the first port and the warning says to paste.
fn bind(ports: &[u16]) -> Result<(Option<TcpListener>, u16, Option<String>)> {
    let (Some(first), Some(last)) = (ports.first().copied(), ports.last().copied()) else {
        return Err(AiError::bad_request("No port to listen on for the sign-in."));
    };
    for port in ports {
        match TcpListener::bind((Ipv4Addr::LOCALHOST, *port)) {
            Ok(l) => {
                let bound = l.local_addr().map(|a| a.port()).unwrap_or(*port);
                return Ok((Some(l), bound, None));
            }
            Err(e) if matches!(e.kind(), std::io::ErrorKind::AddrInUse | std::io::ErrorKind::PermissionDenied) => {}
            Err(e) => return Err(AiError::new(ErrorKind::Network, format!("Could not start the sign-in listener: {e}."))),
        }
    }
    let warning =
        format!("Ports {first}–{last} are all in use; close the program using them, or finish the sign-in by pasting the address the browser lands on.");
    Ok((None, first, Some(warning)))
}

/// The request target (`/auth/callback?code=…`) of the HTTP request on `stream`.
fn read_target(stream: &mut TcpStream) -> Option<String> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 2048];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") && buf.len() <= 2 * MAX_CALLBACK_LEN {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => buf.extend_from_slice(chunk.get(..n).unwrap_or_default()),
        }
    }
    let head = String::from_utf8_lossy(&buf);
    let mut parts = head.lines().next()?.split(' ');
    let (_method, target) = (parts.next()?, parts.next()?);
    target.starts_with('/').then(|| target.to_string())
}

fn respond(stream: &mut TcpStream, status: u16, reason: &str, content_type: &str, body: &str) {
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
    let _ = stream.shutdown(std::net::Shutdown::Write);
}
