//! A scripted [`GenerativeBackend`] for tests: no network, answers queued in advance, every call
//! recorded. Compiled for the engine's tests and, with the `testgen` feature, for other crates'
//! (the interface's kittests, the CLI's).
//!
//! An empty script answers each request with a default: a solid image of [`MockBackend::FILL`]
//! at the size asked, the text "A mock description.", an empty chat turn, two models.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use photocraft_raster::Rgba8Image;
use serde_json::Value;

use super::{BackendStatus, ChatRequest, ChatTurn, Describe, GenError, GenerativeBackend, ImageEdit, ImageGen, ModelEntry, ProviderId, ProviderStatus};

/// One scripted answer, taken by the next call.
#[derive(Clone, Debug)]
pub enum MockAnswer {
    /// This image, whatever size was asked (to test a wrong-size answer).
    Image(Rgba8Image),
    /// A solid colour at the size asked.
    Solid([u8; 4]),
    /// An image of the size asked, each pixel from its position (x, y) in it.
    Pattern(fn(u32, u32) -> [u8; 4]),
    /// The request's own image, unchanged (an edit) or `Solid` black (a generation).
    Echo,
    Text(String),
    Turn(ChatTurn),
    Models(Vec<ModelEntry>),
    Error {
        kind: &'static str,
        message: String,
    },
}

/// What a call asked for.
#[derive(Clone, Debug, PartialEq)]
pub struct MockCall {
    /// `edit`, `generate`, `describe`, `chat` or `models`.
    pub op: &'static str,
    pub provider: Option<ProviderId>,
    pub model: Option<String>,
    pub prompt: String,
    /// The image sent (edit, describe) or asked for (generate).
    pub width: u32,
    pub height: u32,
    /// Mean of the mask's alpha (0..1), when a mask was sent.
    pub mask_coverage: Option<f32>,
    pub transparent: bool,
    /// Chat: how many history entries and tools were sent.
    pub messages: usize,
    pub tools: usize,
}

struct State {
    status: BackendStatus,
    script: VecDeque<MockAnswer>,
    calls: Vec<MockCall>,
    delay: Duration,
    hook: Option<Arc<dyn Fn() + Send + Sync>>,
    /// Refuse automated callers in [`GenerativeBackend::admit`].
    refuse_automated: bool,
    /// What each [`GenerativeBackend::admit`] was asked, oldest first.
    admitted: Vec<bool>,
}

/// The scripted backend. Cheap to share: wrap it in an `Arc` and keep a clone to inspect.
pub struct MockBackend {
    state: Mutex<State>,
}

impl MockBackend {
    /// The default image answer's colour (opaque red).
    pub const FILL: [u8; 4] = [255, 0, 0, 255];
    /// What the mock's status says about the stored key; tests check it never leaks.
    pub const SECRET: &'static str = "sk-mock-0123456789abcdef";

    /// Both providers connected with API keys, OpenAI preferred, consent given.
    pub fn connected() -> Self {
        let key = |id: ProviderId, image: &str, chat: &str| ProviderStatus {
            connected: true,
            hint: Some("…cdef".into()),
            store: Some("a test store".into()),
            image_capable: true,
            chat_capable: true,
            image_model: Some(image.into()),
            chat_model: Some(chat.into()),
            ..ProviderStatus::disconnected(id)
        };
        Self::with_status(BackendStatus {
            providers: vec![key(ProviderId::OpenAi, "gpt-image-1", "gpt-5"), key(ProviderId::Gemini, "gemini-2.5-flash-image", "gemini-2.5-flash")],
            default_provider: Some(ProviderId::OpenAi),
            consented: true,
        })
    }

    /// No key stored anywhere (consent given).
    pub fn disconnected() -> Self {
        Self::with_status(BackendStatus {
            providers: ProviderId::ALL.into_iter().map(ProviderStatus::disconnected).collect(),
            default_provider: None,
            consented: true,
        })
    }

    pub fn with_status(status: BackendStatus) -> Self {
        Self {
            state: Mutex::new(State {
                status,
                script: VecDeque::new(),
                calls: Vec::new(),
                delay: Duration::ZERO,
                hook: None,
                refuse_automated: false,
                admitted: Vec::new(),
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Replace the status (consent, keys).
    pub fn set_status(&self, status: BackendStatus) {
        self.lock().status = status;
    }

    /// Withdraw (or give) consent.
    pub fn set_consented(&self, consented: bool) {
        self.lock().status.consented = consented;
    }

    /// Queue an answer for the next call.
    pub fn push(&self, answer: MockAnswer) {
        self.lock().script.push_back(answer);
    }

    /// Each call waits this long before answering, polling `cancelled` every few milliseconds.
    pub fn set_delay(&self, delay: Duration) {
        self.lock().delay = delay;
    }

    /// Runs inside every call, after it is recorded and before it answers (a test cancels its
    /// job from here).
    pub fn set_hook(&self, hook: Option<Arc<dyn Fn() + Send + Sync>>) {
        self.lock().hook = hook;
    }

    /// Refuse (or admit again) callers that run under an automation gate, as an agent gate
    /// does without "Allow agents to run AI commands".
    pub fn set_refuse_automated(&self, refuse: bool) {
        self.lock().refuse_automated = refuse;
    }

    /// The `automated` flag of every admission asked so far, oldest first.
    pub fn admitted(&self) -> Vec<bool> {
        self.lock().admitted.clone()
    }

    /// Every call so far, oldest first.
    pub fn calls(&self) -> Vec<MockCall> {
        self.lock().calls.clone()
    }

    /// Record `call`, wait, run the hook and take the next answer.
    fn begin(&self, call: MockCall, cancelled: &dyn Fn() -> bool) -> Result<Option<MockAnswer>, GenError> {
        let (delay, hook) = {
            let mut st = self.lock();
            st.calls.push(call);
            (st.delay, st.hook.clone())
        };
        if cancelled() {
            return Err(GenError::cancelled());
        }
        let step = Duration::from_millis(5);
        let mut waited = Duration::ZERO;
        while waited < delay {
            std::thread::sleep(step);
            waited += step;
            if cancelled() {
                return Err(GenError::cancelled());
            }
        }
        if let Some(hook) = hook {
            hook();
        }
        let answer = self.lock().script.pop_front();
        if let Some(MockAnswer::Error { kind, message }) = answer {
            return Err(GenError::new(kind, message));
        }
        Ok(answer)
    }
}

fn solid(w: u32, h: u32, px: [u8; 4]) -> Rgba8Image {
    Rgba8Image { width: w, height: h, pixels: px.repeat(w as usize * h as usize) }
}

fn pattern(w: u32, h: u32, f: fn(u32, u32) -> [u8; 4]) -> Rgba8Image {
    let mut img = Rgba8Image::new(w, h);
    for (i, px) in img.pixels.chunks_exact_mut(4).enumerate() {
        let i = i as u32;
        px.copy_from_slice(&f(i % w.max(1), i / w.max(1)));
    }
    img
}

fn image_answer(answer: Option<MockAnswer>, w: u32, h: u32, echo: Option<&Rgba8Image>) -> Result<Rgba8Image, GenError> {
    Ok(match answer {
        None => solid(w, h, MockBackend::FILL),
        Some(MockAnswer::Image(img)) => img,
        Some(MockAnswer::Solid(px)) => solid(w, h, px),
        Some(MockAnswer::Pattern(f)) => pattern(w, h, f),
        Some(MockAnswer::Echo) => echo.cloned().unwrap_or_else(|| solid(w, h, [0, 0, 0, 255])),
        Some(other) => return Err(GenError::bad_response(format!("the mock was scripted with {other:?} for an image request"))),
    })
}

fn coverage(mask: &Rgba8Image) -> f32 {
    let n = (mask.width as usize * mask.height as usize).max(1);
    mask.pixels.chunks_exact(4).map(|p| f32::from(p[3]) / 255.0).sum::<f32>() / n as f32
}

fn call(op: &'static str, choice: &super::Choice, prompt: &str) -> MockCall {
    MockCall {
        op,
        provider: choice.provider,
        model: choice.model.clone(),
        prompt: prompt.to_string(),
        width: 0,
        height: 0,
        mask_coverage: None,
        transparent: false,
        messages: 0,
        tools: 0,
    }
}

impl GenerativeBackend for MockBackend {
    fn status(&self) -> BackendStatus {
        self.lock().status.clone()
    }

    fn admit(&self, automated: bool) -> Result<(), GenError> {
        let mut st = self.lock();
        st.admitted.push(automated);
        if automated && st.refuse_automated {
            return Err(GenError::new(super::kind::NOT_ALLOWED, "Agents may not run AI commands (mock)."));
        }
        Ok(())
    }

    fn edit_image(&self, req: &ImageEdit, cancelled: &dyn Fn() -> bool) -> Result<Rgba8Image, GenError> {
        let c = MockCall {
            width: req.image.width,
            height: req.image.height,
            mask_coverage: req.mask.as_ref().map(coverage),
            transparent: req.transparent,
            ..call("edit", &req.choice, &req.prompt)
        };
        let answer = self.begin(c, cancelled)?;
        image_answer(answer, req.image.width, req.image.height, Some(&req.image))
    }

    fn generate_image(&self, req: &ImageGen, cancelled: &dyn Fn() -> bool) -> Result<Rgba8Image, GenError> {
        let c = MockCall { width: req.width, height: req.height, transparent: req.transparent, ..call("generate", &req.choice, &req.prompt) };
        let answer = self.begin(c, cancelled)?;
        image_answer(answer, req.width, req.height, None)
    }

    fn describe(&self, req: &Describe, cancelled: &dyn Fn() -> bool) -> Result<String, GenError> {
        let c = MockCall { width: req.image.width, height: req.image.height, ..call("describe", &req.choice, req.prompt.as_deref().unwrap_or("")) };
        match self.begin(c, cancelled)? {
            None => Ok("A mock description.".into()),
            Some(MockAnswer::Text(t)) => Ok(t),
            Some(other) => Err(GenError::bad_response(format!("the mock was scripted with {other:?} for a description"))),
        }
    }

    fn chat(&self, req: &ChatRequest, cancelled: &dyn Fn() -> bool) -> Result<ChatTurn, GenError> {
        let c = MockCall { messages: req.messages.len(), tools: req.tools.len(), ..call("chat", &req.choice, &req.instructions) };
        match self.begin(c, cancelled)? {
            None => Ok(ChatTurn { text: String::new(), tool_calls: Vec::new(), provider_state: Value::Null }),
            Some(MockAnswer::Turn(t)) => Ok(t),
            Some(MockAnswer::Text(text)) => Ok(ChatTurn { text, ..ChatTurn::default() }),
            Some(other) => Err(GenError::bad_response(format!("the mock was scripted with {other:?} for a chat turn"))),
        }
    }

    fn list_models(&self, provider: ProviderId, cancelled: &dyn Fn() -> bool) -> Result<Vec<ModelEntry>, GenError> {
        let c = MockCall { provider: Some(provider), ..call("models", &super::Choice::default(), "") };
        match self.begin(c, cancelled)? {
            None => Ok(vec![("mock-chat".into(), "text"), ("mock-image".into(), "image")]),
            Some(MockAnswer::Models(m)) => Ok(m),
            Some(other) => Err(GenError::bad_response(format!("the mock was scripted with {other:?} for a model list"))),
        }
    }
}
