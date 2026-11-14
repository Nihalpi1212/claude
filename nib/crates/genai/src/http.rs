//! Blocking HTTPS for the providers (ureq on rustls, the OS trust store). Every call runs on a
//! worker thread ([`crate::jobs`]); it is bounded by the timeout, reads at most
//! [`crate::ProviderConfig::max_response_bytes`] and stops between chunks once cancelled.

use std::io::Read;
use std::time::Duration;

use crate::{AiError, CancelToken, ErrorKind, Result};

/// What the providers send.
pub(crate) enum Body {
    None,
    Json(Vec<u8>),
    /// `multipart/form-data; boundary=…` and its bytes.
    Multipart(String, Vec<u8>),
}

pub(crate) struct Request {
    pub post: bool,
    pub url: String,
    /// Header names and values. Values may be secret (an API key): never log a request.
    pub headers: Vec<(&'static str, String)>,
    pub body: Body,
}

pub(crate) struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

/// One agent per provider configuration.
pub(crate) struct Http {
    agent: ureq::Agent,
    max_bytes: usize,
}

/// Whether `url` names this machine (`http://127.0.0.1:…`, `http://localhost:…`, `http://[::1]:…`):
/// the test servers and a local gateway. Those are reached without a proxy and may be plain HTTP;
/// everything else must be HTTPS.
pub fn is_loopback(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://").or_else(|| url.strip_prefix("https://")) else { return false };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = match authority.rsplit_once(':') {
        Some((h, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => h,
        _ => authority,
    };
    matches!(host, "127.0.0.1" | "localhost" | "[::1]")
}

impl Http {
    pub fn new(base_url: &str, timeout: Duration, max_bytes: usize) -> Self {
        let local = is_loopback(base_url);
        let tls = ureq::tls::TlsConfig::builder().root_certs(ureq::tls::RootCerts::PlatformVerifier).build();
        let agent = ureq::Agent::config_builder()
            .tls_config(tls)
            .proxy(if local { None } else { ureq::Proxy::try_from_env() })
            .https_only(!local)
            .timeout_connect(Some(timeout.min(Duration::from_secs(20))))
            .timeout_global(Some(timeout))
            .http_status_as_error(false)
            // An API answers in place; a redirect would carry the key elsewhere.
            .max_redirects(0)
            .max_redirects_will_error(false)
            .user_agent(concat!("Nib/", env!("CARGO_PKG_VERSION")))
            .build()
            .new_agent();
        Self { agent, max_bytes }
    }

    pub fn send(&self, req: Request, cancel: &CancelToken) -> Result<Response> {
        cancel.check()?;
        let sent = if req.post {
            let mut b = self.agent.post(&req.url);
            for (k, v) in &req.headers {
                b = b.header(*k, v.as_str());
            }
            match req.body {
                Body::None => b.send_empty(),
                Body::Json(bytes) => b.content_type("application/json").send(bytes),
                Body::Multipart(ct, bytes) => b.content_type(ct).send(bytes),
            }
        } else {
            let mut b = self.agent.get(&req.url);
            for (k, v) in &req.headers {
                b = b.header(*k, v.as_str());
            }
            b.call()
        };
        let resp = sent.map_err(transport_error)?;
        let status = resp.status().as_u16();
        let body = self.read_body(resp.into_body(), cancel)?;
        Ok(Response { status, body })
    }

    fn read_body(&self, body: ureq::Body, cancel: &CancelToken) -> Result<Vec<u8>> {
        let cap = self.max_bytes;
        let mut reader = body.into_with_config().limit(cap as u64 + 1).reader();
        let mut out = Vec::new();
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            cancel.check()?;
            let n = match reader.read(&mut chunk) {
                Ok(n) => n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(io_error(&e, cap)),
            };
            if n == 0 {
                return Ok(out);
            }
            if out.len().saturating_add(n) > cap {
                return Err(too_large(cap));
            }
            out.extend_from_slice(chunk.get(..n).unwrap_or_default());
        }
    }
}

fn too_large(cap: usize) -> AiError {
    AiError::bad_response(format!("The provider's answer was larger than {} MB, so Nib stopped reading it.", cap / (1024 * 1024)))
}

fn io_error(e: &std::io::Error, cap: usize) -> AiError {
    let text = e.to_string();
    if e.kind() == std::io::ErrorKind::TimedOut || text.contains("timeout") {
        return timeout();
    }
    if text.contains("exceeds limit") || text.contains("BodyExceedsLimit") {
        return too_large(cap);
    }
    AiError::new(ErrorKind::Network, format!("The connection to the provider broke while reading its answer ({text})."))
}

fn timeout() -> AiError {
    AiError::new(ErrorKind::Timeout, "The provider took too long to answer. Try again, or try a smaller request.")
}

fn transport_error(e: ureq::Error) -> AiError {
    match e {
        ureq::Error::Timeout(_) => timeout(),
        ureq::Error::HostNotFound => AiError::new(ErrorKind::Network, "The provider's server could not be found. Check the internet connection."),
        ureq::Error::ConnectionFailed => AiError::new(ErrorKind::Network, "Nib could not connect to the provider. Check the internet connection."),
        ureq::Error::BodyExceedsLimit(n) => too_large(usize::try_from(n).unwrap_or(usize::MAX)),
        ureq::Error::Io(io) if io.kind() == std::io::ErrorKind::TimedOut => timeout(),
        other => AiError::new(ErrorKind::Network, format!("The request to the provider failed: {other}.")),
    }
}

/// A `multipart/form-data` body: text fields, then files.
pub(crate) struct Multipart {
    boundary: String,
    bytes: Vec<u8>,
}

impl Multipart {
    pub fn new() -> Self {
        // Any string that can't occur in the parts; the parts are PNG bytes and short text fields,
        // and the boundary is long and random enough that a PNG holding it is not a concern.
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        Self { boundary: format!("----NibFormBoundary{nanos:032x}"), bytes: Vec::new() }
    }

    pub fn text(&mut self, name: &str, value: &str) {
        self.head(name, None);
        self.bytes.extend_from_slice(value.as_bytes());
        self.bytes.extend_from_slice(b"\r\n");
    }

    pub fn file(&mut self, name: &str, file_name: &str, mime: &str, data: &[u8]) {
        self.head(name, Some((file_name, mime)));
        self.bytes.extend_from_slice(data);
        self.bytes.extend_from_slice(b"\r\n");
    }

    fn head(&mut self, name: &str, file: Option<(&str, &str)>) {
        let name = name.replace(['"', '\r', '\n'], "");
        let mut h = format!("--{}\r\nContent-Disposition: form-data; name=\"{name}\"", self.boundary);
        if let Some((file_name, mime)) = file {
            let file_name = file_name.replace(['"', '\r', '\n'], "");
            h.push_str(&format!("; filename=\"{file_name}\"\r\nContent-Type: {mime}"));
        }
        h.push_str("\r\n\r\n");
        self.bytes.extend_from_slice(h.as_bytes());
    }

    pub fn finish(mut self) -> Body {
        self.bytes.extend_from_slice(format!("--{}--\r\n", self.boundary).as_bytes());
        Body::Multipart(format!("multipart/form-data; boundary={}", self.boundary), self.bytes)
    }
}
