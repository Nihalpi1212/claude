//! Pigment: generative AI on the command line, against a mock provider on 127.0.0.1 (no real
//! provider is ever called): `pigment-cli ai` (keys from standard input, never from argv, never
//! printed; consent; agents; models) and `run --allow-ai` end to end.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

const KEY: &str = "sk-test-0123456789abcdefWXYZ";

/// A provider stand-in: records each request's method and path (and the multipart prompt) and
/// answers OpenAI's catalog, image and Responses calls. `reject` answers every call with 401.
struct Mock {
    base: String,
    got: Arc<Mutex<Vec<String>>>,
}

fn mock(reject: bool) -> Mock {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let got = Arc::new(Mutex::new(Vec::new()));
    let log = got.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let log = log.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let mut len = 0usize;
                loop {
                    let mut h = String::new();
                    if reader.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
                        break;
                    }
                    if let Some((k, v)) = h.trim_end().split_once(':')
                        && k.eq_ignore_ascii_case("content-length")
                    {
                        len = v.trim().parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0; len];
                let _ = reader.read_exact(&mut body);
                let path = line.split_whitespace().nth(1).unwrap_or_default().to_string();
                log.lock().unwrap().push(path.clone());
                let (status, reply) = if reject {
                    (401, json!({"error": {"message": format!("Incorrect API key provided: {KEY}"), "code": "invalid_api_key"}}))
                } else if path == "/v1/models" {
                    (200, json!({"data": [{"id": "gpt-5.1"}, {"id": "gpt-image-1"}]}))
                } else if path.starts_with("/v1/images/") {
                    (200, json!({"data": [{"b64_json": GREEN_PNG}]}))
                } else {
                    (404, json!({"error": {"message": "no route"}}))
                };
                let body = reply.to_string();
                let mut out = stream;
                let _ =
                    write!(out, "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            });
        }
    });
    Mock { base, got }
}

/// A 4 × 4 opaque green PNG.
const GREEN_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEUlEQVR4nGNgOMHwHwWTLgAAtakccbEBmDcAAAAASUVORK5CYII=";

fn dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("pigment-cli-ai-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// The CLI with its settings in `settings` and OpenAI's address replaced by `base`.
fn cli(settings: &Path, base: &str) -> Command {
    let mut c = super::command();
    c.env("PIGMENT_CONFIG_DIR", settings).env("PIGMENT_AI_BASE_URL_OPENAI", base).env_remove("PIGMENT_AI_BASE_URL_GEMINI");
    c
}

fn run(mut c: Command, stdin: &str) -> Output {
    let mut child = c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    child.stdin.take().unwrap().write_all(stdin.as_bytes()).unwrap();
    child.wait_with_output().unwrap()
}

fn text(o: &Output) -> (String, String) {
    (String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned())
}

#[test]
fn keys_come_from_standard_input_and_are_never_shown() {
    let d = dir("keys");
    let good = mock(false);
    // On the command line: refused, nothing stored, nothing sent.
    let o = run(
        {
            let mut c = cli(&d, &good.base);
            c.args(["ai", "set-key", "openai", KEY]);
            c
        },
        "",
    );
    let (out, err) = text(&o);
    assert_eq!(o.status.code(), Some(1), "{out}{err}");
    assert!(err.contains("standard input") && !err.contains(KEY), "{err}");
    assert!(!d.join("ai-keys.json").exists());
    // A key the provider refuses is not stored, and the error doesn't repeat it.
    let bad = mock(true);
    let o = run(
        {
            let mut c = cli(&d, &bad.base);
            c.args(["ai", "set-key", "openai"]);
            c
        },
        &format!("{KEY}\n"),
    );
    let (out, err) = text(&o);
    assert_eq!(o.status.code(), Some(1), "{out}{err}");
    assert!(err.contains("rejected the API key") && !err.contains(KEY) && !out.contains(KEY), "{err}");
    assert!(!d.join("ai-keys.json").exists());
    // Piped in and checked with the provider: stored, owner-only.
    let o = run(
        {
            let mut c = cli(&d, &good.base);
            c.args(["ai", "set-key", "openai"]);
            c
        },
        &format!("  {KEY}\n"),
    );
    let (out, err) = text(&o);
    assert_eq!(o.status.code(), Some(0), "{out}{err}");
    assert!(out.contains("OpenAI connected") && out.contains("gpt-image-1") && !out.contains(KEY), "{out}");
    assert_eq!(good.got.lock().unwrap().as_slice(), ["/v1/models"]);
    let file = std::fs::read_to_string(d.join("ai-keys.json")).unwrap();
    assert!(file.contains(KEY));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(d.join("ai-keys.json")).unwrap().permissions().mode() & 0o777, 0o600);
    }
    // Status shows the hint, never the key.
    for args in [&["ai", "status"][..], &["ai", "status", "--json"]] {
        let o = run(
            {
                let mut c = cli(&d, &good.base);
                c.args(args);
                c
            },
            "",
        );
        let (out, err) = text(&o);
        assert_eq!(o.status.code(), Some(0), "{err}");
        assert!(out.contains("WXYZ") && !out.contains(KEY), "{out}");
    }
    let o = run(
        {
            let mut c = cli(&d, &good.base);
            c.args(["ai", "test", "--json"]);
            c
        },
        "",
    );
    let v: Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!(v["models"], json!([{"id": "gpt-5.1", "kind": "text"}, {"id": "gpt-image-1", "kind": "image"}]));
    let o = run(
        {
            let mut c = cli(&d, &good.base);
            c.args(["ai", "clear-key", "openai"]);
            c
        },
        "",
    );
    assert_eq!(o.status.code(), Some(0));
    assert!(!d.join("ai-keys.json").exists(), "the file goes with the last key");
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn consent_agents_and_models_are_saved_without_keys() {
    let d = dir("settings");
    let m = mock(false);
    for args in [&["ai", "consent"][..], &["ai", "agents", "on"], &["ai", "use", "gemini", "--image-model", "gemini-3-pro-image-preview", "--chat-model", ""]] {
        let o = run(
            {
                let mut c = cli(&d, &m.base);
                c.args(args);
                c
            },
            "",
        );
        assert_eq!(o.status.code(), Some(0), "{args:?}: {}", text(&o).1);
    }
    let s: Value = serde_json::from_str(&std::fs::read_to_string(d.join("ai.json")).unwrap()).unwrap();
    assert_eq!((s["consented"].clone(), s["allowAgents"].clone()), (json!(true), json!(true)));
    assert_eq!(s["defaultProvider"], "gemini");
    assert_eq!(s["gemini"], json!({"chatModel": null, "imageModel": "gemini-3-pro-image-preview"}));
    let o = run(
        {
            let mut c = cli(&d, &m.base);
            c.args(["ai", "agents", "maybe"]);
            c
        },
        "",
    );
    assert_eq!(o.status.code(), Some(2), "a usage error");
    assert!(m.got.lock().unwrap().is_empty(), "settings send nothing");
    let _ = std::fs::remove_dir_all(&d);
}

/// The brief's end-to-end run: Generative Fill from the command line, with a key file and
/// settings in a temporary config folder and OpenAI's address on 127.0.0.1.
#[test]
fn run_sends_only_with_allow_ai() {
    let d = dir("run");
    let m = mock(false);
    std::fs::write(d.join("ai-keys.json"), format!("{{\"openai\":\"{KEY}\"}}")).unwrap();
    std::fs::write(d.join("ai.json"), r#"{"consented":true,"openai":{"imageModel":"gpt-image-1"}}"#).unwrap();
    let out = d.join("filled.pigment");
    let args = |allow: bool| {
        let mut c = cli(&d, &m.base);
        c.args([
            "run",
            "--new",
            r#"{"width":64,"height":32,"background":"white"}"#,
            "--cmd",
            "select.rect",
            "--params",
            r#"{"x":8,"y":8,"width":16,"height":8}"#,
        ]);
        c.args(["--cmd", "ai.generativeFill", "--params", r#"{"prompt":"a green box"}"#, "--out"]).arg(&out);
        if allow {
            c.arg("--allow-ai");
        }
        c
    };
    let o = run(args(false), "");
    let (stdout, err) = text(&o);
    assert_eq!(o.status.code(), Some(1), "{stdout}{err}");
    assert!(err.contains("--allow-ai") && err.contains("ai.generativeFill"), "{err}");
    assert!(!out.exists() && stdout.is_empty(), "refused before any work");
    assert!(m.got.lock().unwrap().is_empty());
    let o = run(args(true), "");
    let (stdout, err) = text(&o);
    assert_eq!(o.status.code(), Some(0), "{stdout}{err}");
    let fill: Value = serde_json::from_str(stdout.lines().nth(1).unwrap()).unwrap();
    assert_eq!(fill["command"], "ai.generativeFill");
    assert_eq!(fill["result"]["layers"].as_array().map(Vec::len), Some(1), "{fill}");
    assert_eq!(m.got.lock().unwrap().as_slice(), ["/v1/images/edits"]);
    let o = run(
        {
            let mut c = cli(&d, &m.base);
            c.args(["info", "--compact"]).arg(&out);
            c
        },
        "",
    );
    let info: Value = serde_json::from_slice(&o.stdout).unwrap();
    let names: Vec<&str> = info["layers"].as_array().unwrap().iter().filter_map(|l| l["name"].as_str()).collect();
    assert!(names.contains(&"Generative Fill"), "{names:?}");
    // An `ai.*` step inside an action list (batch, droplets) can't send: there is no --allow-ai.
    let (input, results) = (d.join("in"), d.join("out"));
    std::fs::create_dir_all(&input).unwrap();
    let o = run(
        {
            let mut c = cli(&d, &m.base);
            c.args(["run", "--new", r#"{"width":8,"height":8}"#, "--out"]).arg(input.join("a.png"));
            c
        },
        "",
    );
    assert_eq!(o.status.code(), Some(0), "{}", text(&o).1);
    let actions = d.join("actions.json");
    std::fs::write(&actions, r#"[["ai.generateImage", {"prompt": "x"}]]"#).unwrap();
    let o = run(
        {
            let mut c = cli(&d, &m.base);
            c.arg("batch").arg("--actions").arg(&actions).arg("--in").arg(&input).arg("--out").arg(&results);
            c
        },
        "",
    );
    let (stdout, err) = text(&o);
    assert_eq!(o.status.code(), Some(1), "{stdout}{err}");
    assert!(err.contains("--allow-ai"), "{err}");
    assert_eq!(m.got.lock().unwrap().len(), 1, "nothing more was sent: {stdout}{err}");
    let _ = std::fs::remove_dir_all(&d);
}

/// The engine words a missing agreement or key for the app ("… in Edit › AI Accounts…"). On the
/// command line the error also names `pigment-cli ai`'s way to give it, and nothing is sent.
#[test]
fn a_refused_run_names_the_command_lines_way_to_agree_and_to_connect() {
    let d = dir("hint");
    let m = mock(false);
    let args = || {
        let mut c = cli(&d, &m.base);
        c.args(["run", "--new", r#"{"width":16,"height":16}"#, "--cmd", "select.all"]);
        c.args(["--cmd", "ai.generativeFill", "--params", r#"{"prompt":"a green box"}"#, "--allow-ai"]);
        c
    };
    // No agreement yet.
    std::fs::write(d.join("ai-keys.json"), format!("{{\"openai\":\"{KEY}\"}}")).unwrap();
    let o = run(args(), "");
    let (stdout, err) = text(&o);
    assert_eq!(o.status.code(), Some(1), "{stdout}{err}");
    assert!(err.contains("AI Accounts") && err.contains("`pigment-cli ai consent`"), "{err}");
    // Agreed, and no key.
    std::fs::write(d.join("ai.json"), r#"{"consented":true}"#).unwrap();
    std::fs::remove_file(d.join("ai-keys.json")).unwrap();
    let o = run(args(), "");
    let (stdout, err) = text(&o);
    assert_eq!(o.status.code(), Some(1), "{stdout}{err}");
    assert!(err.contains("AI Accounts") && err.contains("`pigment-cli ai set-key <openai|gemini>`"), "{err}");
    assert!(m.got.lock().unwrap().is_empty(), "neither refusal sent anything");
    // An error that is not about the accounts (no selection here) gets no such line.
    std::fs::write(d.join("ai-keys.json"), format!("{{\"openai\":\"{KEY}\"}}")).unwrap();
    let o = run(
        {
            let mut c = cli(&d, &m.base);
            c.args(["run", "--new", r#"{"width":16,"height":16}"#, "--cmd", "ai.generativeFill", "--params", r#"{"prompt":"x"}"#, "--allow-ai"]);
            c
        },
        "",
    );
    let (stdout, err) = text(&o);
    assert_eq!(o.status.code(), Some(1), "{stdout}{err}");
    assert!(!err.contains("On the command line"), "{err}");
    let _ = std::fs::remove_dir_all(&d);
}

// ---- Sign in with ChatGPT (experimental) ----------------------------------------------------

/// The sign-in server and the plan route's catalog on 127.0.0.1. The ID token carries `nonce`,
/// which the test sets once it has read the attempt's address. Returns the server's root.
fn plan_mock(nonce: &Arc<Mutex<String>>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let root = format!("http://{}", listener.local_addr().unwrap());
    let nonce = Arc::clone(nonce);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let nonce = Arc::clone(&nonce);
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let mut len = 0usize;
                loop {
                    let mut h = String::new();
                    if reader.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
                        break;
                    }
                    if let Some((k, v)) = h.trim_end().split_once(':')
                        && k.eq_ignore_ascii_case("content-length")
                    {
                        len = v.trim().parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0; len];
                let _ = reader.read_exact(&mut body);
                let part = |v: &Value| pigment_genai::chatgpt::base64url(v.to_string().as_bytes());
                let reply = if line.contains("/oauth/token") {
                    let claims = json!({"iss": "https://auth.openai.com", "aud": "oaiapp_42", "exp": 4_000_000_000_i64, "nonce": *nonce.lock().unwrap(), "email": "me@example.com"});
                    json!({"access_token": "access-token-ONE", "refresh_token": "refresh-token-ONE", "expires_in": 3600, "scope": "openid chatgpt.tokens.use.direct",
                        "id_token": format!("{}.{}.sig", part(&json!({"alg": "RS256"})), part(&claims))})
                } else {
                    json!({"models": [{"slug": "gpt-5.1"}, {"slug": "gpt-5-codex"}]})
                }
                .to_string();
                let mut out = stream;
                let _ = write!(out, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len());
            });
        }
    });
    root
}

/// A query parameter of `url`, percent-decoded.
fn param(url: &str, name: &str) -> String {
    let raw = url.split_once('?').unwrap().1.split('&').find_map(|kv| kv.strip_prefix(&format!("{name}="))).unwrap();
    let (bytes, mut out, mut i) = (raw.as_bytes(), vec![], 0);
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                out.push(u8::from_str_radix(&raw[i + 1..i + 3], 16).unwrap());
                i += 2;
            }
            b'+' => out.push(b' '),
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8(out).unwrap()
}

/// `ai sign-in` in `settings`, until it has printed the address to open: the running command,
/// the rest of its output to read, and the address.
fn start_sign_in(settings: &Path, root: &str) -> (std::process::Child, BufReader<std::process::ChildStdout>, String) {
    let mut c = cli(settings, &format!("{root}/v1"));
    c.env("PIGMENT_AI_AUTH_URL_CHATGPT", root).args(["ai", "sign-in", "--port", "0"]);
    let mut child = c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let mut out = BufReader::new(child.stdout.take().unwrap());
    let mut url = String::new();
    while !url.contains("/api/accounts/authorize?") {
        url.clear();
        assert!(out.read_line(&mut url).unwrap() > 0, "sign-in ended before printing its address");
    }
    (child, out, url.trim().to_string())
}

/// `pigment-cli ai sign-in`: the address is printed, the browser's callback (or the pasted
/// address) finishes it, the status names the account and never a token, `ai test` lists the
/// plan's models, and `ai sign-out` removes it.
#[test]
fn sign_in_with_chatgpt_from_the_terminal() {
    if !pigment_genai::chatgpt::ENABLED {
        return;
    }
    let d = dir("chatgpt");
    let nonce = Arc::new(Mutex::new(String::new()));
    let root = plan_mock(&nonce);
    let status = |d: &Path, json: bool| {
        let mut c = cli(d, &format!("{root}/v1"));
        c.env("PIGMENT_AI_AUTH_URL_CHATGPT", &root).args(if json { &["ai", "status", "--json"][..] } else { &["ai", "status"][..] });
        text(&run(c, "")).0
    };
    let sub = |d: &Path, args: &[&str]| {
        let mut c = cli(d, &format!("{root}/v1"));
        c.env("PIGMENT_AI_AUTH_URL_CHATGPT", &root).args(args);
        text(&run(c, ""))
    };
    // The browser lands on the loopback callback.
    let (mut child, mut rest, url) = start_sign_in(&d, &root);
    assert_eq!(param(&url, "client_id"), "dynamic_agent_client");
    *nonce.lock().unwrap() = param(&url, "nonce");
    let redirect = param(&url, "redirect_uri");
    let (host, path) = redirect.strip_prefix("http://").unwrap().split_once('/').unwrap();
    let mut browser = std::net::TcpStream::connect(host).unwrap();
    write!(browser, "GET /{path}?code=the-code&state={}&client_id=oaiapp_42 HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n", param(&url, "state"))
        .unwrap();
    let mut page = String::new();
    browser.read_to_string(&mut page).unwrap();
    assert!(page.contains("You can return to Pigment"), "{page}");
    let mut out = String::new();
    rest.read_to_string(&mut out).unwrap();
    assert_eq!(child.wait().unwrap().code(), Some(0), "{out}");
    assert!(out.contains("Signed in with ChatGPT as me@example.com") && out.contains("pigment-cli ai consent"), "{out}");
    let (plain, json) = (status(&d, false), status(&d, true));
    assert!(plain.contains("OpenAI: signed in with ChatGPT as me@example.com (experimental; chat models only"), "{plain}");
    assert!(json.contains("\"method\": \"chatgpt\"") && json.contains("\"email\": \"me@example.com\""), "{json}");
    let key_file = std::fs::read_to_string(d.join("ai-keys.json")).unwrap();
    assert!(key_file.contains("openai-chatgpt") && key_file.contains("access-token-ONE"), "the tokens are in the private key file");
    for secret in ["access-token-ONE", "refresh-token-ONE", "the-code"] {
        assert!(!out.contains(secret) && !plain.contains(secret) && !json.contains(secret), "{secret}");
        assert!(!std::fs::read_to_string(d.join("ai.json")).unwrap().contains(secret), "{secret} in ai.json");
    }
    let (tested, err) = sub(&d, &["ai", "test"]);
    assert!(tested.contains("the ChatGPT sign-in works (2 models)") && tested.contains("gpt-5.1"), "{tested}{err}");
    assert!(sub(&d, &["ai", "clear-key", "openai"]).0.contains("still signed in with ChatGPT"), "removing a key leaves the sign-in");
    assert!(sub(&d, &["ai", "sign-out"]).0.contains("Signed out of ChatGPT."));
    assert!(status(&d, false).contains("OpenAI: not connected"));
    assert!(!d.join("ai-keys.json").exists(), "the file goes with the sign-in");
    assert!(sub(&d, &["ai", "sign-out"]).0.contains("Not signed in with ChatGPT."));
    // A browser on another computer: the address it lands on, pasted at the prompt. One that
    // belongs to another attempt is refused and the command goes on waiting.
    let (mut child, mut rest, url) = start_sign_in(&d, &root);
    *nonce.lock().unwrap() = param(&url, "nonce");
    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, "code=c&state=someone-elses").unwrap();
    writeln!(stdin, "{}?code=the-code&state={}&client_id=oaiapp_42", param(&url, "redirect_uri"), param(&url, "state")).unwrap();
    let mut out = String::new();
    rest.read_to_string(&mut out).unwrap();
    let mut err = String::new();
    child.stderr.take().unwrap().read_to_string(&mut err).unwrap();
    assert_eq!(child.wait().unwrap().code(), Some(0), "{out}{err}");
    assert!(out.contains("Signed in with ChatGPT as me@example.com"), "{out}");
    assert!(err.contains("another sign-in attempt"), "{err}");
    assert!(status(&d, false).contains("signed in with ChatGPT"));
}

/// `ai sign-out` removes the stored ChatGPT tokens whatever hides them: Sign in with ChatGPT
/// turned off (`"chatgptSignIn": false`, or the feature switched off in the build), or an OpenAI
/// key stored next to them. Before, it said "Not signed in with ChatGPT." and left both tokens in
/// the key store, to come back when the feature was on again.
#[test]
fn sign_out_removes_tokens_the_feature_does_not_show() {
    let record = json!({"clientId": "oaiapp_42", "accessToken": "access-token-LEFT", "refreshToken": "refresh-token-LEFT", "expiresAt": 4.0e9}).to_string();
    let sign_out = |d: &Path| {
        let mut c = cli(d, "http://127.0.0.1:9/v1");
        c.args(["ai", "sign-out"]);
        let o = run(c, "");
        assert!(o.status.success(), "{o:?}");
        text(&o).0
    };
    let keys = |d: &Path| std::fs::read_to_string(d.join("ai-keys.json")).unwrap_or_default();

    let d = dir("sign-out-off");
    std::fs::write(d.join("ai-keys.json"), json!({"openai-chatgpt": record}).to_string()).unwrap();
    std::fs::write(d.join("ai.json"), r#"{"chatgptSignIn": false}"#).unwrap();
    let out = sign_out(&d);
    assert!(out.contains("Signed out of ChatGPT."), "{out}");
    assert!(!keys(&d).contains("openai-chatgpt") && !keys(&d).contains("refresh-token-LEFT"), "{}", keys(&d));
    assert!(sign_out(&d).contains("Not signed in with ChatGPT."), "nothing left to remove");

    let d = dir("sign-out-key");
    std::fs::write(d.join("ai-keys.json"), json!({"openai": KEY, "openai-chatgpt": record}).to_string()).unwrap();
    let out = sign_out(&d);
    assert!(out.contains("Signed out of ChatGPT."), "{out}");
    let left = keys(&d);
    assert!(!left.contains("openai-chatgpt") && !left.contains("access-token-LEFT"), "{left}");
    assert!(left.contains(KEY), "the API key stays");
}

/// A sign-in replaces a stored OpenAI key (they exclude each other). AI Accounts does not offer
/// the sign-in while a key is connected; the command line says so before the person signs in,
/// and a sign-in that is not finished leaves the key where it was.
#[test]
fn sign_in_says_when_it_would_replace_a_stored_key() {
    if !pigment_genai::chatgpt::ENABLED {
        return;
    }
    let d = dir("chatgpt-key");
    let nonce = Arc::new(Mutex::new(String::new()));
    let root = plan_mock(&nonce);
    let mut c = cli(&d, &format!("{root}/v1"));
    c.args(["ai", "set-key", "openai", "--no-check"]);
    assert!(run(c, &format!("{KEY}\n")).status.success());
    let (mut child, mut rest, _url) = start_sign_in(&d, &root);
    let mut said = String::new();
    for _ in 0..3 {
        rest.read_line(&mut said).unwrap();
    }
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(said.contains("signing in replaces it") && said.contains("Ctrl+C"), "{said}");
    assert!(!said.contains(KEY), "{said}");
    let mut c = cli(&d, &format!("{root}/v1"));
    c.args(["ai", "status"]);
    assert!(text(&run(c, "")).0.contains("OpenAI: connected"), "the key is still there");
}

/// `ai set-key`'s prompt at a terminal: the key isn't echoed, Backspace works, and the
/// terminal's echo is back the moment the CLI ends, whether the person pressed Enter or Ctrl+C.
/// (Ctrl+C used to kill the CLI by its signal with echo still off.) The CLI runs with the pty as
/// its controlling terminal (`setsid --ctty`), so Ctrl+C is the keystroke a person types.
#[cfg(target_os = "linux")]
#[test]
fn set_key_prompt_gives_the_terminal_its_echo_back() {
    use rustix::pty::{OpenptFlags, grantpt, openpt, ptsname, unlockpt};
    use rustix::termios::{LocalModes, tcgetattr};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    /// A terminal: what it has shown so far, its keyboard, and the device the CLI gets.
    struct Pty {
        shown: Arc<Mutex<Vec<u8>>>,
        keyboard: std::fs::File,
        device: std::fs::File,
    }
    impl Pty {
        fn new() -> Pty {
            let master = openpt(OpenptFlags::RDWR | OpenptFlags::NOCTTY).unwrap();
            grantpt(&master).unwrap();
            unlockpt(&master).unwrap();
            let name = ptsname(&master, Vec::new()).unwrap();
            let device = std::fs::OpenOptions::new().read(true).write(true).open(name.to_str().unwrap()).unwrap();
            let master = std::fs::File::from(master);
            let shown = Arc::new(Mutex::new(Vec::new()));
            let (log, mut screen) = (shown.clone(), master.try_clone().unwrap());
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                while let Ok(n @ 1..) = screen.read(&mut buf) {
                    log.lock().unwrap().extend_from_slice(&buf[..n]);
                }
            });
            Pty { shown, keyboard: master, device }
        }
        fn echo(&self) -> bool {
            tcgetattr(&self.device).unwrap().local_modes.contains(LocalModes::ECHO)
        }
        fn shown(&self) -> String {
            String::from_utf8_lossy(&self.shown.lock().unwrap()).into_owned()
        }
        /// What the terminal has shown once it shows `text`, or after 10 s: the CLI's last line
        /// can still be in the terminal, not yet read by the screen thread, when the CLI exits.
        fn shown_with(&self, text: &str) -> String {
            let end = Instant::now() + Duration::from_secs(10);
            while !self.shown().contains(text) && Instant::now() < end {
                std::thread::sleep(Duration::from_millis(20));
            }
            self.shown()
        }
        fn type_keys(&self, keys: &str) {
            (&self.keyboard).write_all(keys.as_bytes()).unwrap();
        }
        /// `ai set-key openai` at this terminal, once its prompt shows; its exit status arrives
        /// on the receiver.
        fn set_key(&self, d: &Path) -> mpsc::Receiver<std::process::ExitStatus> {
            let inner = cli(d, "http://127.0.0.1:9/v1");
            let mut c = Command::new("setsid");
            c.arg("--ctty").arg(inner.get_program()).args(["ai", "set-key", "openai", "--no-check"]);
            for (k, v) in inner.get_envs() {
                match v {
                    Some(v) => c.env(k, v),
                    None => c.env_remove(k),
                };
            }
            let io = || Stdio::from(self.device.try_clone().unwrap());
            let mut child = c.stdin(io()).stdout(io()).stderr(io()).spawn().unwrap();
            let (done, exited) = mpsc::channel();
            std::thread::spawn(move || done.send(child.wait().unwrap()).unwrap());
            let end = Instant::now() + Duration::from_secs(20);
            while !self.shown().contains("API key and press Enter: ") && Instant::now() < end {
                std::thread::sleep(Duration::from_millis(20));
            }
            assert!(self.shown().contains("API key and press Enter: "), "no prompt: {}", self.shown());
            assert!(!self.echo(), "echo is off while the key is typed");
            exited
        }
    }
    let wait = |exited: mpsc::Receiver<std::process::ExitStatus>| exited.recv_timeout(Duration::from_secs(20)).unwrap();

    // Enter: stored as typed (after the Backspace), never shown, echo back on.
    let d = dir("pty");
    let t = Pty::new();
    assert!(t.echo());
    let exited = t.set_key(&d);
    t.type_keys(&format!("{KEY}x\x7f\r"));
    let status = wait(exited);
    assert!(t.echo(), "echo is back after Enter");
    let shown = t.shown_with("OpenAI key stored");
    assert!(status.success(), "{status:?}: {shown}");
    assert!(shown.contains("OpenAI key stored") && !shown.contains(KEY), "{shown}");
    let file = std::fs::read_to_string(d.join("ai-keys.json")).unwrap();
    assert!(file.contains(&format!("\"{KEY}\"")), "{file}");

    // Ctrl+C, halfway through the key: nothing stored, and echo is back on as the CLI ends.
    let d = dir("pty-interrupt");
    let t = Pty::new();
    let exited = t.set_key(&d);
    t.type_keys("sk-te\x03");
    let status = wait(exited);
    assert!(t.echo(), "the terminal's echo is still off after Ctrl+C ({status:?})");
    let shown = t.shown_with("interrupted");
    assert_eq!(status.code(), Some(1), "{shown}");
    assert!(shown.contains("interrupted") && !shown.contains("sk-te"), "{shown}");
    assert!(!d.join("ai-keys.json").exists());
}
