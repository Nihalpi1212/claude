//! Test helpers: a local mock HTTP server (std `TcpListener`; no real provider is ever called),
//! providers and backends pointed at it, recorded answers, and images.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use photocraft_raster::Rgba8Image;
use pigment_genai::image_util::{base64_decode, base64_encode, decode, encode_png};
use pigment_genai::keys::ApiKey;
use pigment_genai::{AiAccounts, Caller, GenAiBackend, Provider, ProviderConfig, ProviderId};
use serde_json::{Value, json};

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

    /// The parts of a `multipart/form-data` body: (name, bytes).
    pub fn form(&self) -> Vec<(String, Vec<u8>)> {
        let ct = self.header("content-type").unwrap_or_default();
        let boundary = format!("--{}", ct.split("boundary=").nth(1).unwrap_or_default());
        let body = &self.body;
        let mut out = vec![];
        let find = |hay: &[u8], needle: &[u8], from: usize| hay.get(from..).and_then(|h| h.windows(needle.len()).position(|w| w == needle)).map(|i| i + from);
        let mut at = find(body, boundary.as_bytes(), 0);
        while let Some(start) = at {
            let head_start = start + boundary.len() + 2;
            let Some(head_end) = find(body, b"\r\n\r\n", head_start) else { break };
            let head = String::from_utf8_lossy(&body[head_start..head_end]).into_owned();
            let data_start = head_end + 4;
            let next = find(body, format!("\r\n{boundary}").as_bytes(), data_start);
            let Some(end) = next else { break };
            let name = head.split("name=\"").nth(1).and_then(|s| s.split('"').next()).unwrap_or_default().to_string();
            out.push((name, body[data_start..end].to_vec()));
            at = Some(end + 2);
        }
        out
    }

    /// A form part's bytes.
    pub fn part(&self, name: &str) -> Option<Vec<u8>> {
        self.form().into_iter().find(|(n, _)| n == name).map(|(_, b)| b)
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

    /// The requests other than catalog reads.
    pub fn work(&self) -> Vec<Got> {
        self.requests().into_iter().filter(|g| !g.path.starts_with("/v1/models") || g.path.contains(':')).collect()
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

pub fn key(p: ProviderId) -> &'static str {
    match p {
        ProviderId::OpenAi => OPENAI_KEY,
        ProviderId::Gemini => GEMINI_KEY,
    }
}

pub fn config(p: ProviderId, base: &str) -> ProviderConfig {
    let mut c = ProviderConfig::new(p);
    c.base_url = base.to_string();
    c.timeout = Duration::from_secs(20);
    c
}

pub fn provider(p: ProviderId, base: &str) -> Arc<dyn Provider> {
    pigment_genai::provider::build(config(p, base), ApiKey::new(key(p)).unwrap()).unwrap()
}

/// Accounts in memory with consent given, keys for both providers and the models chosen,
/// pointed at `server`.
pub fn accounts(server: &MockServer) -> AiAccounts {
    let mut a = AiAccounts::in_memory();
    for p in ProviderId::ALL {
        a.set_key(p, key(p)).unwrap();
        a.set_base_url(p, &server.base()).unwrap();
    }
    a.set_models(ProviderId::OpenAi, Some("gpt-5.1"), Some("gpt-image-1")).unwrap();
    a.set_models(ProviderId::Gemini, Some("gemini-2.5-flash"), Some("gemini-2.5-flash-image")).unwrap();
    a.settings.consented = true;
    a
}

pub fn backend(a: AiAccounts, caller: Caller) -> GenAiBackend {
    GenAiBackend::new(Arc::new(Mutex::new(a)), caller)
}

/// A recorded OpenAI Responses API answer with `text`.
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

/// A recorded Gemini generateContent answer with `text`.
pub fn gemini_text(text: &str) -> Value {
    json!({
        "candidates": [{"content": {"role": "model", "parts": [{"text": text}]}, "finishReason": "STOP", "index": 0}],
        "usageMetadata": {"promptTokenCount": 5, "candidatesTokenCount": 7, "totalTokenCount": 12},
        "modelVersion": "gemini-2.5-flash"
    })
}

pub fn openai_image(img: &Rgba8Image) -> Value {
    json!({ "created": 1, "data": [{ "b64_json": base64_encode(&encode_png(img).unwrap()) }] })
}

pub fn gemini_image(img: &Rgba8Image) -> Value {
    json!({
        "candidates": [{"content": {"role": "model", "parts": [
            {"text": "Here is the image."},
            {"inlineData": {"mimeType": "image/png", "data": base64_encode(&encode_png(img).unwrap())}}
        ]}, "finishReason": "STOP"}]
    })
}

/// A `w × h` image filled by `f(x, y)`.
pub fn image(w: u32, h: u32, f: impl Fn(u32, u32) -> [u8; 4]) -> Rgba8Image {
    let mut img = Rgba8Image::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let i = ((y * w + x) * 4) as usize;
            img.pixels[i..i + 4].copy_from_slice(&f(x, y));
        }
    }
    img
}

pub fn solid(w: u32, h: u32, c: [u8; 4]) -> Rgba8Image {
    image(w, h, |_, _| c)
}

pub fn px(img: &Rgba8Image, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * img.width + x) * 4) as usize;
    img.pixels[i..i + 4].try_into().unwrap()
}

/// A PNG part or inline image decoded.
pub fn png(bytes: &[u8]) -> Rgba8Image {
    decode(bytes).unwrap()
}

/// The image in a Gemini `inline_data` part.
pub fn inline_image(part: &Value) -> Rgba8Image {
    png(&base64_decode(part["inline_data"]["data"].as_str().unwrap()).unwrap())
}

/// The catalogs the mock servers answer.
pub fn openai_models() -> Value {
    json!({"data": [{"id": "gpt-4.1"}, {"id": "gpt-5.1"}, {"id": "gpt-image-1"}, {"id": "gpt-image-1.5"}, {"id": "whisper-1"}]})
}

pub fn gemini_models() -> Value {
    json!({"models": [
        {"name": "models/gemini-2.5-flash", "supportedGenerationMethods": ["generateContent"]},
        {"name": "models/gemini-2.5-flash-image", "supportedGenerationMethods": ["generateContent"]},
        {"name": "models/gemini-3-pro-image-preview", "supportedGenerationMethods": ["generateContent"]}
    ]})
}

pub fn temp_dir(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("pigment-genai-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}
