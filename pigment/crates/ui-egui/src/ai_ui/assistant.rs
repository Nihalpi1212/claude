//! Window › Assistant: a chat about the active document that can also edit it
//! (`docs/generative-ai.md` › The Assistant).
//!
//! * **A conversation per document**, in memory only: at most
//!   [`MAX_MESSAGES`](super::assistant_tools::MAX_MESSAGES) messages, dropped when the document
//!   closes or with Clear. Nothing of it is in [`crate::UiState`], the preferences or `ai.json`.
//! * **A turn** ([`send`]) sends the conversation, the instructions and the tools to the chat
//!   model, with a downscaled composite (at most 1024 px a side) on the latest message when
//!   Attach image is on. Each request is a background job (`ai.chat`: the status bar shows it
//!   with Cancel, nothing modal, the document stays editable). The model's tool calls then run
//!   here, on the interface thread, one a frame through
//!   [`assistant_tools::run`](super::assistant_tools::run), each an ordinary undoable command;
//!   their results go back and the model answers again, for at most twelve rounds.
//! * **Stop** ends the turn: a request in flight is dropped (its answer never runs a tool; the
//!   provider may still bill it), tools not yet run never run, and a step that is waiting on a
//!   background job or on a dialog the person has open is let finish first.
//! * **One turn at a time**, app-wide, as in JavaScript Pigment. A tool refuses when its
//!   document is no longer the active one.
//! * **Agents** (a control request, synthetic input) send a message only while "Allow agents to
//!   run AI commands" is on, like every command that sends.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, PoisonError};

use photocraft_doc::DocId;
use photocraft_engine::generative::{ChatMessage, ChatRequest, ChatTurn, Choice, ModelKind, ProviderId, ToolCall, ToolResult, ToolSpec};
use photocraft_engine::jobs::{JobEvent, JobId, JobOutcome, Started};
use photocraft_raster::Rgba8Image;
use serde_json::{Value, json};

use super::assistant_tools::{self as tools, MAX_MESSAGES, MAX_ROUNDS, Outcome, Then};
use super::{account_blocker, fitting, fixed_in_accounts, message, refresh, with_accounts};
use crate::PhotocraftApp;
use crate::theme::Tokens;

/// The command id a chat request's job runs under (a job, not an engine command).
pub const CHAT_JOB: &str = "ai.chat";
/// The window's content width when it first opens.
const WIDTH: f32 = 380.0;
/// The longest side of an attached image as the conversation shows it.
const THUMB_EDGE: u32 = 96;

/// Who wrote a message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
}

/// One tool call of an assistant message, as the panel shows it.
#[derive(Clone, Debug)]
pub struct Call {
    pub name: String,
    pub args: Value,
    /// What the tool answered (`{"error": …}` when it failed); `None` while it runs.
    pub result: Option<Value>,
    /// The command opened a dialog and the turn waits for the person to finish it.
    pub waiting: bool,
}

impl Call {
    pub fn failed(&self) -> bool {
        self.result.as_ref().is_some_and(|r| r.get("error").is_some())
    }
}

/// One message of a conversation.
pub struct Message {
    pub role: Role,
    pub text: String,
    /// The composite sent with a user message (Attach image).
    pub image: Option<Arc<Rgba8Image>>,
    pub calls: Vec<Call>,
    /// The assistant's answer is still being worked on.
    pub pending: bool,
    /// The turn failed: `text` is the failure. Not sent again with later messages.
    pub error: bool,
    /// The failure is fixed in AI Accounts.
    pub needs_accounts: bool,
    pub stopped: bool,
    /// The model wanted more tool rounds than a turn allows.
    pub truncated: bool,
    /// The attached image as drawn in the conversation.
    thumb: Option<egui::TextureHandle>,
}

impl Message {
    fn new(role: Role, text: String) -> Self {
        Self { role, text, image: None, calls: Vec::new(), pending: false, error: false, needs_accounts: false, stopped: false, truncated: false, thumb: None }
    }
}

/// A provider's chat models, as listed on request.
enum ModelList {
    Loading(JobId),
    Ready(Vec<String>),
    Failed(String),
}

/// A tool that hasn't answered yet.
enum Running {
    /// Its command runs as a background job.
    Job { job: JobId, then: Then, index: usize, call: ToolCall },
    /// Its command opened a dialog the person is in.
    Dialog { open_before: usize, result: Value, index: usize, call: ToolCall },
}

/// The turn being worked on.
struct Turn {
    doc: DocId,
    choice: Choice,
    instructions: String,
    tools: Vec<ToolSpec>,
    /// What the next request sends: the conversation, then this turn's model turns and tool
    /// results (the whole history is resent each round).
    history: Vec<ChatMessage>,
    /// Where the request's job leaves the model's answer.
    slot: Arc<Mutex<Option<ChatTurn>>>,
    /// The request in flight.
    job: Option<JobId>,
    /// Tool rounds run so far.
    rounds: usize,
    /// The current round's calls still to run, and the results so far.
    queue: VecDeque<ToolCall>,
    results: Vec<ToolResult>,
    current: Option<Running>,
    /// Stop was pressed while a step was running: the turn ends when it has finished.
    stopping: bool,
}

/// How a turn ended.
enum End {
    Answered,
    Truncated,
    Stopped,
    Failed { kind: Option<&'static str>, message: String },
}

/// The Assistant's state. Nothing here is saved, but the provider, the chat model and Attach
/// image (in `ai.json`, when they are changed).
pub struct State {
    pub open: bool,
    /// The message being typed.
    pub input: String,
    /// Attach image: send a downscaled copy of the image with each message.
    pub attach: bool,
    /// The provider chosen in the window, where there are no saved settings to keep it in;
    /// `None`: the preferred one.
    pub provider: Option<ProviderId>,
    /// The chat model chosen per provider id, likewise; none or empty: automatic.
    models: HashMap<&'static str, String>,
    lists: HashMap<&'static str, ModelList>,
    conversations: HashMap<DocId, Vec<Message>>,
    turn: Option<Turn>,
    /// Requests dropped by Stop, whose end the shell need not report.
    dropped: Vec<JobId>,
    /// Put the keyboard in the message field at the next frame.
    focus: bool,
    /// The saved choices were read.
    loaded: bool,
    /// Why the last Send did nothing.
    pub note: Option<String>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            open: false,
            input: String::new(),
            attach: true,
            provider: None,
            models: HashMap::new(),
            lists: HashMap::new(),
            conversations: HashMap::new(),
            turn: None,
            dropped: Vec::new(),
            focus: false,
            loaded: false,
            note: None,
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Read the saved Attach image once. (The provider and the chat model are read from the saved
/// settings whenever they are needed: AI Accounts changes them too.)
fn load(app: &mut PhotocraftApp) {
    if app.ai.assistant.loaded {
        return;
    }
    let attach = with_accounts(app, |a| {
        a.reload();
        a.settings.assistant_attach
    });
    let s = &mut app.ai.assistant;
    s.loaded = true;
    if let Some(attach) = attach {
        s.attach = attach;
    }
}

/// The chat models already known for the chosen provider (AI Accounts listed them in the last
/// ten minutes), so the list is there without asking the provider again.
fn known_models(app: &mut PhotocraftApp) {
    let Some(p) = provider(app) else { return };
    if app.ai.assistant.lists.contains_key(p.id()) {
        return;
    }
    let cached = with_accounts(app, |a| {
        a.cached_catalog(p).map(|c| c.iter().filter(|m| m.kind == pigment_genai::ModelKind::Chat).map(|m| m.id.clone()).collect::<Vec<_>>())
    })
    .flatten();
    if let Some(models) = cached {
        app.ai.assistant.lists.insert(p.id(), ModelList::Ready(models));
    }
}

/// Window › Assistant: show or hide the window (`{"show": bool}`; without it, toggle).
pub fn toggle(app: &mut PhotocraftApp, params: &Value) -> Result<Value, String> {
    let show = match params.get("show") {
        None | Some(Value::Null) => !app.ai.assistant.open,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err("show must be a boolean".into()),
    };
    if show {
        open(app);
    } else {
        app.ai.assistant.open = false;
    }
    Ok(json!({"visible": show}))
}

/// Open the window with the keyboard in its message field.
pub fn open(app: &mut PhotocraftApp) {
    load(app);
    refresh(app);
    known_models(app);
    let s = &mut app.ai.assistant;
    s.open = true;
    s.focus = true;
}

pub fn is_open(app: &PhotocraftApp) -> bool {
    app.ai.assistant.open
}

/// A turn is being worked on (on any document: one at a time).
pub fn running(app: &PhotocraftApp) -> bool {
    app.ai.assistant.turn.is_some()
}

/// Stop was pressed and the turn waits for its current step.
pub fn stopping(app: &PhotocraftApp) -> bool {
    app.ai.assistant.turn.as_ref().is_some_and(|t| t.stopping)
}

/// The conversation about document `doc`.
pub fn conversation(app: &PhotocraftApp, doc: DocId) -> &[Message] {
    app.ai.assistant.conversations.get(&doc).map_or(&[], Vec::as_slice)
}

/// The conversation about the active document.
pub fn messages(app: &PhotocraftApp) -> &[Message] {
    app.session.active().map_or(&[], |st| conversation(app, st.doc.id))
}

/// The provider a message goes to: the one chosen here while it is connected, else the
/// preferred provider, else the first connected one (JS: `chatProvider`, then the Preferred
/// provider, then the first).
pub fn provider(app: &PhotocraftApp) -> Option<ProviderId> {
    let fits = fitting(app, ModelKind::Chat);
    let preferred = app.ai.status.as_ref().and_then(|s| s.default_provider);
    // As saved (AI Accounts' Preferred provider resets it); without accounts, as chosen here.
    let chosen = with_accounts(app, |a| a.settings.chat_provider).unwrap_or(app.ai.assistant.provider);
    chosen.filter(|p| fits.contains(p)).or(preferred.filter(|p| fits.contains(p))).or(fits.first().copied())
}

/// The chat model chosen for `p`, here or in AI Accounts (the same saved choice); `None`:
/// automatic, the provider's preferred chat model.
pub fn model(app: &PhotocraftApp, p: ProviderId) -> Option<String> {
    let saved = with_accounts(app, |a| a.settings.chosen_model(p, pigment_genai::ModelKind::Chat).map(str::to_string));
    let chosen = saved.unwrap_or_else(|| app.ai.assistant.models.get(p.id()).cloned());
    chosen.map(|m| m.trim().to_string()).filter(|m| !m.is_empty())
}

/// Choose the provider messages go to (saved as `chatProvider`).
pub fn set_provider(app: &mut PhotocraftApp, p: ProviderId) {
    app.ai.assistant.provider = Some(p);
    with_accounts(app, |a| {
        a.settings.chat_provider = Some(p);
        if let Err(e) = a.save() {
            log::warn!("ai: could not save the AI settings: {e}");
        }
    });
    known_models(app);
}

/// Choose `p`'s chat model (saved as its `chatModel`); empty: automatic.
pub fn set_model(app: &mut PhotocraftApp, p: ProviderId, model: &str) {
    let model = model.trim().to_string();
    if let Some(Err(e)) = with_accounts(app, |a| a.set_models(p, Some(&model), None)) {
        app.ai.assistant.note = Some(message(&e.message));
        return;
    }
    app.ai.assistant.models.insert(p.id(), model);
    refresh(app);
}

/// Attach image on or off (saved as `assistantAttach`).
pub fn set_attach(app: &mut PhotocraftApp, on: bool) {
    app.ai.assistant.attach = on;
    with_accounts(app, |a| {
        a.settings.assistant_attach = on;
        if let Err(e) = a.save() {
            log::warn!("ai: could not save the AI settings: {e}");
        }
    });
}

/// Ask the chosen provider for its models (one request with the key, as Test Connection), to
/// fill the Chat model list.
pub fn list_models(app: &mut PhotocraftApp) -> Result<(), String> {
    let p = provider(app).ok_or_else(|| tl!("Connect OpenAI or Google Gemini in AI Accounts first.").to_string())?;
    let r = app.run("ai.testConnection", json!({"provider": p.id()}));
    let list = match r {
        Ok(v) => match v.get("pending").and_then(Value::as_bool).filter(|p| *p).and_then(|_| v.get("job")?.as_u64()) {
            Some(job) => ModelList::Loading(JobId(job)),
            None => ModelList::Ready(chat_models(&v)),
        },
        Err(e) => ModelList::Failed(message(&e)),
    };
    app.ai.assistant.lists.insert(p.id(), list);
    Ok(())
}

/// `p`'s chat models as listed ([`list_models`], or AI Accounts in the last ten minutes); `None`
/// before a list was read, or while one is on its way.
pub fn listed_models(app: &PhotocraftApp, p: ProviderId) -> Option<&[String]> {
    match app.ai.assistant.lists.get(p.id()) {
        Some(ModelList::Ready(models)) => Some(models),
        _ => None,
    }
}

/// The chat models of an `ai.testConnection` answer.
fn chat_models(v: &Value) -> Vec<String> {
    let models = v.get("models").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    models.iter().filter(|m| m.get("kind").and_then(Value::as_str) == Some("text")).filter_map(|m| m.get("id")?.as_str().map(str::to_string)).collect()
}

/// Keep the newest [`MAX_MESSAGES`] messages.
fn trim(convo: &mut Vec<Message>) {
    if convo.len() > MAX_MESSAGES {
        convo.drain(..convo.len() - MAX_MESSAGES);
    }
}

/// The conversation as a request sends it: every message that isn't pending or a failure, as
/// text; only the last one carries its image (earlier images are not sent again).
fn base_history(convo: &[Message]) -> Vec<ChatMessage> {
    let kept: Vec<&Message> = convo.iter().filter(|m| !m.pending && !m.error).collect();
    let last = kept.len().saturating_sub(1);
    kept.iter()
        .enumerate()
        .map(|(i, m)| match m.role {
            Role::User => ChatMessage::User { text: m.text.clone(), images: m.image.iter().filter(|_| i == last).map(|img| Rgba8Image::clone(img)).collect() },
            Role::Assistant => ChatMessage::Assistant { text: m.text.clone() },
        })
        .collect()
}

/// Send `text` about the active document. `Ok(true)`: a turn started. `Ok(false)`: nothing was
/// sent and the text should stay in the field (it was empty, or nothing is connected and AI
/// Accounts opened instead). `Err`: why it can't be sent now.
pub fn send(app: &mut PhotocraftApp, text: &str) -> Result<bool, String> {
    let Some((doc_id, doc)) = app.session.active().map(|st| (st.doc.id, st.doc.clone())) else { return Err(tl!("Open a document first.").to_string()) };
    if running(app) {
        return Err(tl!("The assistant is still working.").to_string());
    }
    let clean: String = text.trim().chars().take(photocraft_engine::ai_cmds::PROMPT_LIMIT).collect();
    if clean.is_empty() {
        return Ok(false);
    }
    // An agent's message is the person's money, as with every command that sends.
    let agent = app.ai.agent || app.automation_input;
    super::set_agent_now(app, agent);
    if agent && !super::agents_allowed(app) {
        return Err(super::AGENTS_REFUSED.to_string());
    }
    load(app);
    refresh(app);
    if let Some(why) = account_blocker(app, ModelKind::Chat) {
        if app.session.generative().is_none() {
            return Err(why.to_string());
        }
        // Nothing connected, or no agreement yet: AI Accounts, and the text stays.
        super::accounts::open(app, Some(why.to_string()));
        return Ok(false);
    }
    let backend = app.session.generative().ok_or_else(|| tl!("Generative AI is available in the desktop app.").to_string())?;
    backend.admit(app.session.authorize.is_some()).map_err(|e| message(&e.message))?;
    let provider = provider(app);
    let choice = Choice { provider, model: provider.and_then(|p| model(app, p)) };
    let image = app.ai.assistant.attach.then(|| Arc::new(photocraft_compose::thumbnail(&doc, tools::IMAGE_EDGE)));
    let s = &mut app.ai.assistant;
    let convo = s.conversations.entry(doc_id).or_default();
    let mut user = Message::new(Role::User, clean);
    user.image = image;
    convo.push(user);
    trim(convo);
    let history = base_history(convo);
    let mut answer = Message::new(Role::Assistant, String::new());
    answer.pending = true;
    convo.push(answer);
    s.note = None;
    s.turn = Some(Turn {
        doc: doc_id,
        choice,
        instructions: tools::instructions(),
        tools: tools::tools(),
        history,
        slot: Arc::default(),
        job: None,
        rounds: 0,
        queue: VecDeque::new(),
        results: Vec::new(),
        current: None,
        stopping: false,
    });
    if let Err(e) = start_round(app) {
        finish(app, End::Failed { kind: None, message: e });
    }
    Ok(true)
}

/// Send the turn's history to the model: one request, as a background job that locks nothing.
fn start_round(app: &mut PhotocraftApp) -> Result<(), String> {
    let backend = app.session.generative().ok_or_else(|| tl!("Generative AI is available in the desktop app.").to_string())?;
    let Some(turn) = app.ai.assistant.turn.as_mut() else { return Ok(()) };
    let req = ChatRequest { choice: turn.choice.clone(), instructions: turn.instructions.clone(), messages: turn.history.clone(), tools: turn.tools.clone() };
    let slot = Arc::clone(&turn.slot);
    let started = app
        .session
        .start_job(
            CHAT_JOB,
            json!({}),
            "Assistant",
            false,
            move |ctx| backend.chat(&req, &|| ctx.cancelled()).map_err(photocraft_engine::EngineError::from),
            move |_, answer: ChatTurn| {
                let calls = answer.tool_calls.len();
                *lock(&slot) = Some(answer);
                Ok(json!({"toolCalls": calls}))
            },
        )
        .map_err(|e| e.to_string())?;
    match started {
        Started::Job(job) => {
            turn.job = Some(job);
            app.ui.status.clear();
            app.ui.status_error = false;
        }
        // Where there are no worker threads the request ran inline.
        Started::Done(_) => answered(app),
    }
    Ok(())
}

/// The message the running turn is answering in.
fn pending_message(s: &mut State) -> Option<&mut Message> {
    let doc = s.turn.as_ref()?.doc;
    s.conversations.get_mut(&doc)?.iter_mut().rev().find(|m| m.pending)
}

/// The request's job left the model's answer: run its tool calls, or end the turn.
fn answered(app: &mut PhotocraftApp) {
    let Some(turn) = app.ai.assistant.turn.as_mut() else { return };
    let Some(answer) = lock(&turn.slot).take() else {
        return finish(app, End::Failed { kind: None, message: tl!("The model request failed.").to_string() });
    };
    let text = answer.text.trim().to_string();
    let (calls, rounds) = (answer.tool_calls.len(), turn.rounds);
    if calls > 0 && rounds < MAX_ROUNDS {
        turn.rounds += 1;
        turn.queue = answer.tool_calls.iter().cloned().collect();
        turn.results.clear();
        turn.history.push(ChatMessage::Turn(answer));
    }
    if let Some(m) = pending_message(&mut app.ai.assistant) {
        m.text = text;
    }
    if calls == 0 {
        finish(app, End::Answered);
    } else if rounds >= MAX_ROUNDS {
        // The model wanted more steps than a turn allows: say so instead of a silent "Done."
        finish(app, End::Truncated);
    }
}

/// End the running turn: the pending message becomes the answer, the note that it stopped, or
/// the failure; a request still in flight is dropped.
fn finish(app: &mut PhotocraftApp, end: End) {
    let s = &mut app.ai.assistant;
    let Some(turn) = s.turn.take() else { return };
    if let Some(convo) = s.conversations.get_mut(&turn.doc) {
        if let Some(m) = convo.iter_mut().rev().find(|m| m.pending) {
            m.pending = false;
            for c in m.calls.iter_mut().filter(|c| c.result.is_none()) {
                c.result = Some(json!({"error": "Stopped by the user"}));
                c.waiting = false;
            }
            match end {
                End::Answered if m.text.is_empty() => m.text = (if m.calls.is_empty() { tl!("(no answer)") } else { tl!("Done.") }).to_string(),
                End::Answered => {}
                End::Truncated => {
                    m.truncated = true;
                    let steps = MAX_ROUNDS.to_string();
                    let note = crate::i18n::fmt(tl!("Stopped after {n} tool steps; say “continue” to go on."), &[("n", &steps)]);
                    m.text = if m.text.is_empty() { note } else { format!("{}\n\n{note}", m.text) };
                }
                End::Stopped => {
                    m.stopped = true;
                    if m.text.is_empty() {
                        m.text = tl!("Stopped.").to_string();
                    }
                }
                End::Failed { kind, message: why } => {
                    m.error = true;
                    m.needs_accounts = fixed_in_accounts(kind, &why);
                    m.text = message(&why);
                }
            }
        }
        trim(convo);
    }
    if let Some(job) = turn.job {
        // Its answer, if one comes, is dropped: no tool of it ever runs.
        s.dropped.push(job);
        crate::jobs_ui::cancel(app, job);
    }
}

/// Stop: end the turn. A request in flight is dropped at once and no further tool runs; a step
/// that is running as a job, or waiting on a dialog, is let finish first.
pub fn stop(app: &mut PhotocraftApp) -> bool {
    let Some(turn) = app.ai.assistant.turn.as_mut() else { return false };
    if turn.current.is_some() {
        turn.stopping = true;
    } else {
        finish(app, End::Stopped);
    }
    true
}

/// Clear the conversation about the active document (a turn running on it is stopped first).
pub fn clear(app: &mut PhotocraftApp) {
    let Some(doc) = app.session.active().map(|st| st.doc.id) else { return };
    if app.ai.assistant.turn.as_ref().is_some_and(|t| t.doc == doc) {
        if let Some(t) = app.ai.assistant.turn.as_mut() {
            // A step still running lands on its own; its result goes nowhere.
            t.current = None;
        }
        finish(app, End::Stopped);
    }
    app.ai.assistant.conversations.remove(&doc);
    app.ai.assistant.note = None;
}

/// Record call `index`'s result: shown in the conversation and sent back with the round's.
fn record(app: &mut PhotocraftApp, index: usize, call: &ToolCall, result: Value) {
    let s = &mut app.ai.assistant;
    if let Some(turn) = s.turn.as_mut() {
        turn.results.push(ToolResult { call_id: call.id.clone(), name: call.name.clone(), output: result.clone() });
    }
    if let Some(c) = pending_message(s).and_then(|m| m.calls.get_mut(index)) {
        c.result = Some(result);
        c.waiting = false;
    }
}

/// Run one of the model's tool calls on the turn's document.
fn run_call(app: &mut PhotocraftApp, ctx: &egui::Context, call: ToolCall) {
    let Some(doc) = app.ai.assistant.turn.as_ref().map(|t| t.doc) else { return };
    let Some(index) = pending_message(&mut app.ai.assistant).map(|m| {
        m.calls.push(Call { name: call.name.clone(), args: call.arguments.clone(), result: None, waiting: false });
        m.calls.len() - 1
    }) else {
        return;
    };
    let outcome = if app.session.active().map(|st| st.doc.id) == Some(doc) {
        tools::run(app, ctx, &call.name, &call.arguments)
    } else {
        Err("The document is no longer active".to_string())
    };
    let running = match outcome {
        Ok(Outcome::Done(v)) => return record(app, index, &call, v),
        Err(e) => return record(app, index, &call, json!({"error": e})),
        Ok(Outcome::Job { job, then }) => Running::Job { job, then, index, call },
        Ok(Outcome::Dialog { open_before, result }) => {
            if let Some(c) = pending_message(&mut app.ai.assistant).and_then(|m| m.calls.get_mut(index)) {
                c.waiting = true;
            }
            Running::Dialog { open_before, result, index, call }
        }
    };
    if let Some(turn) = app.ai.assistant.turn.as_mut() {
        turn.current = Some(running);
    }
}

/// Once a frame: move the running turn on. One tool call a frame, so each step shows as it
/// happens and Stop gets a turn between them.
pub(crate) fn poll(app: &mut PhotocraftApp, ctx: &egui::Context) {
    let s = &app.ai.assistant;
    if s.turn.is_none() && s.conversations.is_empty() {
        return;
    }
    // A closed document takes its conversation with it.
    let open: Vec<DocId> = app.session.documents().iter().map(|d| d.doc.id).collect();
    if s.conversations.keys().any(|d| !open.contains(d)) {
        if s.turn.as_ref().is_some_and(|t| !open.contains(&t.doc)) {
            if let Some(t) = app.ai.assistant.turn.as_mut() {
                t.current = None;
            }
            finish(app, End::Stopped);
        }
        app.ai.assistant.conversations.retain(|d, _| open.contains(d));
    }
    let Some(turn) = app.ai.assistant.turn.as_mut() else { return };
    // The answer of a request, or of a step's job, comes with a later frame.
    ctx.request_repaint_after(std::time::Duration::from_millis(100));
    if turn.job.is_some() {
        return;
    }
    match &turn.current {
        Some(Running::Job { .. }) => return,
        Some(Running::Dialog { open_before, .. }) if app.ui.dialogs.len() > *open_before => return,
        Some(Running::Dialog { .. }) => {
            if let Some(Running::Dialog { result, index, call, .. }) = turn.current.take() {
                record(app, index, &call, tools::capped(tools::dialog_result(result)));
            }
            ctx.request_repaint();
            return;
        }
        None => {}
    }
    if turn.stopping {
        return finish(app, End::Stopped);
    }
    if let Some(call) = turn.queue.pop_front() {
        run_call(app, ctx, call);
        ctx.request_repaint();
        return;
    }
    // The round's tools are done: their results go back and the model answers again.
    let results = std::mem::take(&mut turn.results);
    turn.history.push(ChatMessage::ToolResults(results));
    if let Err(e) = start_round(app) {
        finish(app, End::Failed { kind: None, message: e });
    }
    ctx.request_repaint();
}

/// A background job ended. `true` when it was the Assistant's own (a chat request, a model
/// list): the window shows what came of it. A tool's job is recorded as its result and left to
/// the shell to report, like any command's.
pub(crate) fn on_job_event(app: &mut PhotocraftApp, e: &JobEvent) -> bool {
    let s = &mut app.ai.assistant;
    if let Some(i) = s.dropped.iter().position(|j| *j == e.id) {
        s.dropped.swap_remove(i);
        return true;
    }
    if let Some(list) = s.lists.values_mut().find(|l| matches!(l, ModelList::Loading(j) if *j == e.id)) {
        *list = match &e.outcome {
            JobOutcome::Done(v) => ModelList::Ready(chat_models(v)),
            JobOutcome::Failed(err) => ModelList::Failed(message(err)),
            JobOutcome::Cancelled => ModelList::Failed(tl!("Stopped.").to_string()),
        };
        return true;
    }
    let Some(turn) = s.turn.as_mut() else { return false };
    if turn.job == Some(e.id) {
        turn.job = None;
        match &e.outcome {
            JobOutcome::Done(_) => answered(app),
            JobOutcome::Failed(err) => finish(app, End::Failed { kind: super::error_kind(e), message: err.clone() }),
            // The status bar's Cancel on the request is Stop.
            JobOutcome::Cancelled => finish(app, End::Stopped),
        }
        return true;
    }
    if matches!(&turn.current, Some(Running::Job { job, .. }) if *job == e.id)
        && let Some(Running::Job { then, index, call, .. }) = turn.current.take()
    {
        let result = match &e.outcome {
            JobOutcome::Done(v) => then(app, v.clone()).unwrap_or_else(|why| json!({"error": why})),
            JobOutcome::Failed(err) => json!({"error": message(err)}),
            JobOutcome::Cancelled => json!({"error": "The command was cancelled"}),
        };
        record(app, index, &call, tools::capped(result));
    }
    false
}

/// What a click in the window asked for, done after it is drawn.
enum Act {
    Send,
    Stop,
    Clear,
    Accounts,
    Provider(ProviderId),
    Model(String),
    Attach(bool),
    ListModels,
}

/// Move the turn on and draw the window while it is open.
pub(crate) fn show(app: &mut PhotocraftApp, ctx: &egui::Context) {
    poll(app, ctx);
    if !app.ai.assistant.open {
        return;
    }
    let mut open = true;
    let mut act = None;
    let canvas = app.last_canvas_rect;
    let at = if canvas.is_positive() { canvas.right_top() + egui::vec2(-WIDTH - 60.0, 60.0) } else { egui::pos2(240.0, 120.0) };
    egui::Window::new(tl!("Assistant"))
        .id(egui::Id::unique("pigment-ai-assistant"))
        .open(&mut open)
        .collapsible(false)
        .resizable(true)
        .default_size([WIDTH, 520.0])
        .min_width(300.0)
        .min_height(320.0)
        .default_pos(at)
        .show(ctx, |ui| {
            act = body(app, ui);
        });
    match act {
        Some(Act::Send) => {
            let text = app.ai.assistant.input.clone();
            match send(app, &text) {
                Ok(true) => app.ai.assistant.input.clear(),
                // Nothing was sent: what was typed stays.
                Ok(false) => {}
                Err(e) => app.ai.assistant.note = Some(e),
            }
            app.ai.assistant.focus = true;
        }
        Some(Act::Stop) => {
            stop(app);
        }
        Some(Act::Clear) => clear(app),
        Some(Act::Accounts) => super::accounts::open(app, None),
        Some(Act::Provider(p)) => set_provider(app, p),
        Some(Act::Model(m)) => {
            if let Some(p) = provider(app) {
                set_model(app, p, &m);
            }
        }
        Some(Act::Attach(on)) => set_attach(app, on),
        Some(Act::ListModels) => {
            if let Err(e) = list_models(app) {
                app.ai.assistant.note = Some(e);
            }
        }
        None => {}
    }
    if !open {
        app.ai.assistant.open = false;
    }
}

fn body(app: &mut PhotocraftApp, ui: &mut egui::Ui) -> Option<Act> {
    let t = Tokens::get(ui.ctx());
    let mut act = top_rows(app, ui);
    ui.add_space(4.0);
    crate::widgets::hairline(ui);
    ui.add_space(4.0);
    let doc = app.session.active().map(|st| st.doc.id);
    // The conversation takes what the input, the status row and the note below leave.
    let height = (ui.available_height() - 150.0).max(120.0);
    egui::ScrollArea::vertical().id_salt("pigment-ai-assistant-log").max_height(height).auto_shrink([false, false]).stick_to_bottom(true).show(ui, |ui| {
        ui.set_width(ui.available_width());
        let convo = doc.and_then(|d| app.ai.assistant.conversations.get_mut(&d));
        act = log(ui, &t, doc.is_some(), convo).or(act.take());
    });
    ui.add_space(4.0);
    act = input_rows(app, ui, &t, doc.is_some()).or(act);
    ui.add_space(2.0);
    ui.label(
        egui::RichText::new(tl!(
            "A message sends this conversation, the steps' results and, with Attach image, a downscaled copy of the image to your AI provider. A request already sent may still be billed after Stop."
        ))
        .color(t.text_faint)
        .small(),
    );
    act
}

/// The provider and chat model, Attach image, AI Accounts and Clear.
fn top_rows(app: &mut PhotocraftApp, ui: &mut egui::Ui) -> Option<Act> {
    let t = Tokens::get(ui.ctx());
    let mut act = None;
    let fits = fitting(app, ModelKind::Chat);
    let chosen = provider(app);
    ui.horizontal(|ui| {
        ui.label(tl!("Provider:"));
        if fits.is_empty() {
            ui.label(egui::RichText::new(tl!("Not connected")).color(t.text_dim));
        }
        for id in &fits {
            if ui.selectable_label(chosen == Some(*id), id.label()).clicked() {
                act = Some(Act::Provider(*id));
            }
        }
    });
    ui.horizontal(|ui| {
        let l = ui.label(tl!("Chat model:"));
        let Some(p) = chosen else {
            ui.label(egui::RichText::new(tl!("Add an API key in AI Accounts")).color(t.text_dim));
            return;
        };
        let automatic = app.ai.status.as_ref().and_then(|s| s.provider(p)?.chat_model.clone()).unwrap_or_default();
        let automatic = crate::i18n::fmt(tl!("Automatic ({model})"), &[("model", &automatic)]);
        let current = model(app, p);
        let list = app.ai.assistant.lists.get(p.id());
        let mut listed: Vec<String> = match list {
            Some(ModelList::Ready(models)) => models.clone(),
            _ => Vec::new(),
        };
        if let Some(c) = current.as_ref().filter(|c| !listed.contains(c)) {
            listed.insert(0, c.clone());
        }
        craft_ui::ComboBox::from_id_salt("pigment-ai-chat-model")
            .selected_text(current.clone().unwrap_or_else(|| automatic.clone()))
            .width(190.0)
            .show_ui(ui, |ui| {
                if ui.selectable_label(current.is_none(), automatic.as_str()).clicked() {
                    act = Some(Act::Model(String::new()));
                }
                for m in &listed {
                    if ui.selectable_label(current.as_ref() == Some(m), m.as_str()).clicked() {
                        act = Some(Act::Model(m.clone()));
                    }
                }
            })
            .response
            .labelled_by(l.id);
        match list {
            None => {
                if ui.link(tl!("List models")).on_hover_text(tl!("Ask the provider which chat models your key can use")).clicked() {
                    act = Some(Act::ListModels);
                }
            }
            Some(ModelList::Loading(_)) => {
                ui.label(egui::RichText::new(tl!("Loading…")).color(t.text_dim));
            }
            Some(ModelList::Ready(models)) if models.is_empty() => {
                ui.label(egui::RichText::new(tl!("No chat models")).color(t.text_dim));
            }
            Some(ModelList::Failed(why)) => {
                let text = crate::i18n::fmt(tl!("Could not list models: {message}"), &[("message", why)]);
                ui.label(egui::RichText::new(text).color(ui.visuals().error_fg_color));
            }
            Some(ModelList::Ready(_)) => {}
        }
    });
    ui.horizontal(|ui| {
        let mut attach = app.ai.assistant.attach;
        if ui.checkbox(&mut attach, tl!("Attach image")).on_hover_text(tl!("Send a downscaled copy of the image with each message")).changed() {
            act = Some(Act::Attach(attach));
        }
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if crate::widgets::secondary_button(ui, tl!("Clear"), 0.0).on_hover_text(tl!("Clear the conversation")).clicked() {
                act = Some(Act::Clear);
            }
            if crate::widgets::secondary_button(ui, tl!("AI Accounts…"), 0.0).clicked() {
                act = Some(Act::Accounts);
            }
        });
    });
    act
}

/// A small dot for a finished step: the accent when it worked, the error colour when it failed.
fn dot(ui: &mut egui::Ui, color: egui::Color32) {
    let (r, _) = ui.allocate_exact_size(egui::vec2(10.0, 10.0), egui::Sense::hover());
    ui.painter().circle_filled(r.center(), 3.5, color);
}

/// The conversation, or what to do when there is none.
fn log(ui: &mut egui::Ui, t: &Tokens, has_doc: bool, convo: Option<&mut Vec<Message>>) -> Option<Act> {
    let mut act = None;
    let empty = if has_doc {
        tl!("Ask about the image or describe an edit, for example “make it black and white with more contrast” or “add a title at the top”.")
    } else {
        tl!("Open a document to chat about it.")
    };
    let Some(convo) = convo.filter(|c| !c.is_empty()) else {
        ui.label(egui::RichText::new(empty).color(t.text_dim));
        return None;
    };
    for (i, m) in convo.iter_mut().enumerate() {
        ui.push_id(i, |ui| match m.role {
            Role::User => user_row(ui, t, m),
            Role::Assistant => act = assistant_row(ui, t, m).or(act.take()),
        });
        ui.add_space(6.0);
    }
    act
}

fn user_row(ui: &mut egui::Ui, t: &Tokens, m: &mut Message) {
    egui::Frame::new().fill(t.field).corner_radius(t.radius).inner_margin(6.0).show(ui, |ui| {
        ui.set_width(ui.available_width());
        if let Some(img) = &m.image {
            let thumb = m.thumb.get_or_insert_with(|| {
                let (w, h) = photocraft_engine::ai_cmds::region::fit_within(img.width, img.height, THUMB_EDGE);
                let small = photocraft_engine::ai_cmds::region::resize_rgba8(img, w, h);
                let pixels = egui::ColorImage::from_rgba_unmultiplied([small.width as usize, small.height as usize], &small.pixels);
                ui.ctx().load_texture("pigment-ai-attached", pixels, egui::TextureOptions::LINEAR)
            });
            ui.add(egui::Image::new(&*thumb).alt_text(tl!("Attached image"))).on_hover_text(tl!("The image sent with this message"));
        }
        ui.label(m.text.as_str());
    });
}

fn assistant_row(ui: &mut egui::Ui, t: &Tokens, m: &Message) -> Option<Act> {
    let mut act = None;
    for c in &m.calls {
        let failed = c.failed();
        ui.horizontal(|ui| {
            match &c.result {
                None => {
                    ui.add(egui::Spinner::new().size(10.0).color(t.accent));
                }
                Some(_) if failed => dot(ui, ui.visuals().error_fg_color),
                Some(_) => dot(ui, t.accent),
            }
            let mut label = tools::describe_call(&c.name, &c.args, failed);
            if c.waiting {
                label.push_str(tl!(" — waiting for you to finish the dialog"));
            }
            // The failure, or what the step was asked to do.
            let detail = match c.result.as_ref().and_then(|r| r.get("error")) {
                Some(e) => e.as_str().map_or_else(|| e.to_string(), str::to_string),
                None => c.args.to_string(),
            };
            let detail: String = detail.chars().take(400).collect();
            ui.label(egui::RichText::new(label).color(t.text_dim)).on_hover_text(detail);
        });
    }
    if m.pending && m.text.is_empty() {
        ui.horizontal(|ui| {
            ui.add(egui::Spinner::new().size(12.0).color(t.accent));
            ui.label(egui::RichText::new(tl!("Thinking…")).color(t.text_dim));
        });
    } else if m.error {
        ui.label(egui::RichText::new(m.text.as_str()).color(ui.visuals().error_fg_color));
    } else {
        ui.label(m.text.as_str());
    }
    if m.needs_accounts && ui.link(tl!("Open AI Accounts…")).clicked() {
        act = Some(Act::Accounts);
    }
    act
}

/// The message field, the status line and Send or Stop.
fn input_rows(app: &mut PhotocraftApp, ui: &mut egui::Ui, t: &Tokens, has_doc: bool) -> Option<Act> {
    let mut act = None;
    let busy = running(app);
    let label = ui.label(egui::RichText::new(tl!("Message")).color(t.text_dim).small());
    let field = egui::TextEdit::multiline(&mut app.ai.assistant.input)
        .id(egui::Id::unique("pigment-ai-assistant-input"))
        .desired_rows(2)
        .desired_width(f32::INFINITY)
        .hint_text(tl!("Ask about the image or tell the assistant what to change… (Enter sends, Shift+Enter for a new line)"))
        // Enter sends; Shift+Enter is the new line.
        .return_key(egui::KeyboardShortcut::new(egui::Modifiers::SHIFT, egui::Key::Enter))
        .char_limit(photocraft_engine::ai_cmds::PROMPT_LIMIT);
    let r = egui::ScrollArea::vertical()
        .id_salt("pigment-ai-assistant-input-scroll")
        .max_height(160.0)
        .show(ui, |ui| ui.add_enabled(has_doc, field))
        .inner
        .labelled_by(label.id);
    if std::mem::take(&mut app.ai.assistant.focus) && has_doc {
        r.request_focus();
    }
    let plain_enter =
        |i: &egui::InputState| i.key_pressed(egui::Key::Enter) && !i.modifiers.shift && !i.modifiers.alt && !i.modifiers.ctrl && !i.modifiers.command;
    if r.has_focus() && ui.input(plain_enter) {
        act = Some(Act::Send);
    }
    ui.horizontal(|ui| {
        let status = if stopping(app) {
            Some((false, tl!("Stopping after the current step…").to_string()))
        } else if busy {
            Some((false, tl!("Working…").to_string()))
        } else {
            app.ai.assistant.note.clone().map(|n| (true, n))
        };
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if busy {
                let stop = ui.add_enabled_ui(!stopping(app), |ui| crate::widgets::secondary_button(ui, tl!("Stop"), 72.0)).inner;
                if stop.clicked() {
                    act = Some(Act::Stop);
                }
            } else {
                let ready = has_doc && !app.ai.assistant.input.trim().is_empty();
                let send = ui.add_enabled_ui(ready, |ui| crate::widgets::primary_button(ui, tl!("Send"), 72.0)).inner;
                if send.on_hover_text(tl!("Send (Enter)")).clicked() {
                    act = Some(Act::Send);
                }
            }
            ui.with_layout(egui::Layout::left_to_right(egui::Align::Center).with_main_wrap(true), |ui| {
                if let Some((error, text)) = status {
                    let color = if error { ui.visuals().error_fg_color } else { t.text_dim };
                    ui.label(egui::RichText::new(text).color(color));
                }
            });
        });
    });
    act
}
