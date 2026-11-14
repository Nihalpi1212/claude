//! Test helpers: a local mock HTTP server (std `TcpListener`, no real provider is ever called),
//! providers pointed at it, and documents to work on.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use nib_genai::keys::ApiKey;
use nib_genai::{Provider, ProviderConfig, ProviderKind};
use serde_json::{Value, json};
use vectorcraft_engine::Session;

/// A request the server got.
#[derive(Clone, Debug)]
pub struct Got {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Got {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }

    pub fn body_text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// An answer: status, body, and how long to wait before sending it.
#[derive(Clone, Debug)]
pub struct Reply {
    pub status: u16,
    pub body: Vec<u8>,
    pub delay: Duration,
}

impl Reply {
    pub fn json(status: u16, v: Value) -> Self {
        Self { status, body: serde_json::to_vec(&v).unwrap(), delay: Duration::ZERO }
    }

    pub fn ok(v: Value) -> Self {
        Self::json(200, v)
    }

    pub fn after(mut self, d: Duration) -> Self {
        self.delay = d;
        self
    }
}

type Handler = Arc<dyn Fn(&Got) -> Reply + Send + Sync>;

pub struct MockServer {
    pub url: String,
    pub got: Arc<Mutex<Vec<Got>>>,
}

impl MockServer {
    /// A server answering every request with `handler`, on its own thread, until the test ends.
    pub fn start(handler: impl Fn(&Got) -> Reply + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let got = Arc::new(Mutex::new(vec![]));
        let handler: Handler = Arc::new(handler);
        let log = got.clone();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let (handler, log) = (handler.clone(), log.clone());
                thread::spawn(move || serve(stream, &handler, &log));
            }
        });
        Self { url, got }
    }

    /// Answers in order (the last one repeats).
    pub fn replies(replies: Vec<Reply>) -> Self {
        let n = Arc::new(Mutex::new(0usize));
        Self::start(move |_| {
            let mut i = n.lock().unwrap();
            let r = replies.get(*i).or(replies.last()).cloned().unwrap();
            *i += 1;
            r
        })
    }

    pub fn requests(&self) -> Vec<Got> {
        self.got.lock().unwrap().clone()
    }

    /// The base URL as a provider root (`…/v1`).
    pub fn base(&self) -> String {
        format!("{}/v1", self.url)
    }
}

fn serve(stream: TcpStream, handler: &Handler, log: &Mutex<Vec<Got>>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut line = String::new();
    if reader.read_line(&mut line).unwrap_or(0) == 0 {
        return;
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    let mut headers = vec![];
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
            break;
        }
        if let Some((k, v)) = h.trim_end().split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    let len = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("content-length")).and_then(|(_, v)| v.parse::<usize>().ok()).unwrap_or(0);
    let mut body = vec![0u8; len];
    let _ = reader.read_exact(&mut body);
    let got = Got { method, path, headers, body };
    log.lock().unwrap().push(got.clone());
    let reply = handler(&got);
    thread::sleep(reply.delay);
    let mut out = stream;
    let head =
        format!("HTTP/1.1 {} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", reply.status, reply.body.len());
    let _ = out.write_all(head.as_bytes());
    let _ = out.write_all(&reply.body);
    let _ = out.flush();
}

pub const OPENAI_KEY: &str = "sk-test-0123456789abcdefWXYZ";
pub const GEMINI_KEY: &str = "AIzaTest0123456789abcdefQRST";

pub fn config(kind: ProviderKind, base: &str) -> ProviderConfig {
    let mut c = ProviderConfig::new(kind);
    c.base_url = base.to_string();
    c.timeout = Duration::from_secs(20);
    c
}

pub fn provider(kind: ProviderKind, base: &str) -> Arc<dyn Provider> {
    let key = match kind {
        ProviderKind::OpenAi => OPENAI_KEY,
        ProviderKind::Gemini => GEMINI_KEY,
    };
    nib_genai::provider::build(config(kind, base), ApiKey::new(key).unwrap()).unwrap()
}

/// An OpenAI Responses API answer with `text`.
pub fn openai_text(text: &str) -> Value {
    json!({
        "id": "resp_1", "object": "response", "status": "completed",
        "output": [
            {"type": "reasoning", "id": "rs_1", "summary": []},
            {"type": "message", "id": "msg_1", "role": "assistant", "status": "completed",
             "content": [{"type": "output_text", "text": text, "annotations": []}]}
        ],
        "usage": {"input_tokens": 10, "output_tokens": 20, "total_tokens": 30}
    })
}

/// A Gemini generateContent answer with `text`.
pub fn gemini_text(text: &str) -> Value {
    json!({
        "candidates": [{"content": {"role": "model", "parts": [{"text": text}]}, "finishReason": "STOP", "index": 0}],
        "usageMetadata": {"promptTokenCount": 5, "candidatesTokenCount": 7, "totalTokenCount": 12},
        "modelVersion": "gemini-2.5-flash"
    })
}

pub fn openai_image(png: &[u8]) -> Value {
    json!({ "created": 1, "data": [{ "b64_json": vectorcraft_format::base64_encode(png) }] })
}

pub fn gemini_image(png: &[u8]) -> Value {
    json!({
        "candidates": [{"content": {"role": "model", "parts": [
            {"text": "Here is the image."},
            {"inlineData": {"mimeType": "image/png", "data": vectorcraft_format::base64_encode(png)}}
        ]}, "finishReason": "STOP"}]
    })
}

/// A PNG of `w × h` filled by `f(x, y)`.
pub fn png(w: u32, h: u32, f: impl Fn(u32, u32) -> [u8; 4]) -> Vec<u8> {
    let img = image::RgbaImage::from_fn(w, h, |x, y| image::Rgba(f(x, y)));
    nib_genai::image_util::encode_png(&img).unwrap()
}

/// A session with a 400 × 300 document.
pub fn session() -> Session {
    let mut s = Session::new();
    s.execute("file.new", &json!({"width": 400, "height": 300})).unwrap();
    s
}

pub fn exec(s: &mut Session, id: &str, p: Value) -> Value {
    s.execute(id, &p).unwrap_or_else(|e| panic!("{id}: {e}"))
}

pub fn select(s: &mut Session, ids: &[u64]) {
    exec(s, "select.set", json!({ "ids": ids }));
}

/// The document as JSON (to compare before and after Undo).
pub fn snapshot(s: &Session) -> Value {
    serde_json::to_value(&*s.doc().unwrap().doc).unwrap()
}

pub fn undo_steps(s: &Session) -> usize {
    s.doc().unwrap().history.undo.len()
}

/// Accounts in memory with consent given and keys for both providers, pointed at `server`.
pub fn genai(server: &MockServer) -> nib_genai::GenAi {
    let mut a = nib_genai::AiAccounts::in_memory();
    a.set_key(ProviderKind::OpenAi, OPENAI_KEY).unwrap();
    a.set_key(ProviderKind::Gemini, GEMINI_KEY).unwrap();
    a.set_base_url(ProviderKind::OpenAi, &server.base()).unwrap();
    a.set_base_url(ProviderKind::Gemini, &server.base()).unwrap();
    a.settings.consented = true;
    nib_genai::GenAi::new(a)
}

/// Run `request` through GenAi end to end and apply variation 0.
pub fn generate_and_apply(g: &mut nib_genai::GenAi, s: &mut Session, request: &nib_genai::FeatureRequest, kind: ProviderKind) -> nib_genai::Applied {
    let id = g.start(s, request, Some(kind)).unwrap();
    let e = g.wait(id, Duration::from_secs(60)).expect("the job ends");
    if let Err(err) = &e.result {
        panic!("job failed: {err:?}");
    }
    g.apply(s, id, 0).unwrap()
}

pub const SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" width="100" height="50"><rect x="0" y="0" width="100" height="50" fill="#204060"/><circle cx="50" cy="25" r="20" fill="#e0a030"/></svg>"##;
