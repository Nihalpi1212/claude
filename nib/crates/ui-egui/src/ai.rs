//! Nib's generative AI commands in the egui front end, on top of `nib-genai`
//! (docs/generative-ai.md): the **Generate** window (Text to Vector Graphic, Generative Shape Fill,
//! Generative Pattern, Generative Expand, Generative Recolor, Rewrite Text) and the **AI Accounts**
//! dialog.
//!
//! * Commands (`ai.*`, [`crate::menus::UI_COMMANDS`]) open the Generate window on a feature; the
//!   menus, the command palette and the Contextual Task Bar run them. Each is enabled when the
//!   selection suits its feature, and says why not ([`unsuitable`]).
//! * Nothing goes to a provider before the person presses **Generate** (or runs `ai.panel.generate`):
//!   opening a window, typing a prompt or saving a key sends nothing. The request runs on a worker
//!   thread ([`nib_genai::Jobs`]); the window shows a spinner, the elapsed time and **Stop**, and
//!   the app keeps drawing and editing meanwhile ([`poll`] once per frame).
//! * A result is placed when the person clicks one of its variations (`ai.panel.place`): one undo step
//!   named after the feature.
//! * Keys are typed only into AI Accounts' masked field, which is kept here, never in
//!   [`crate::UiState`] (saved as the preferences and read by `ui.inspect`) nor in a dialog's
//!   fields (which `ui.dialog.get` reads), and is cleared as soon as the key is stored.
//!
//! Native only: the browser build has no AI commands (`lib.rs` leaves this module out).

pub(crate) mod accounts;
pub(crate) mod generate;

use std::path::Path;

pub use nib_genai;
use nib_genai::jobs::JobKind;
use nib_genai::{AccountStatus, AiAccounts, AiError, ErrorKind, Feature, GenAi, JobEvent, ProviderKind};
use serde_json::{Value, json};
use vectorcraft_doc::NodeKind;

use crate::VectorcraftApp;

/// Object › Generative › Text to Vector Graphic….
pub const TEXT_TO_VECTOR: &str = "ai.textToVector";
/// Object › Generative › Generative Shape Fill….
pub const SHAPE_FILL: &str = "ai.shapeFill";
/// Object › Generative › Generative Pattern….
pub const PATTERN: &str = "ai.pattern";
/// Object › Generative › Generative Expand….
pub const EXPAND: &str = "ai.expand";
/// Edit › Edit Colors › Generative Recolor….
pub const RECOLOR: &str = "ai.recolor";
/// Type › Rewrite Text….
pub const REWRITE: &str = "ai.rewrite";
/// Window › Generate: the Generate window on Text to Vector Graphic.
pub const PANEL: &str = "ai.generatePanel";
/// Edit › AI Accounts… (also Preferences' AI Accounts… button).
pub const ACCOUNTS: &str = "ai.accounts";
/// The Generate window's Generate button.
pub const GENERATE: &str = "ai.panel.generate";
/// The Generate window's Stop button.
pub const CANCEL: &str = "ai.panel.stop";
/// A click on one of the Generate window's results.
pub const PLACE: &str = "ai.panel.place";

/// The command that opens the Generate window on `feature`.
pub fn command_of(feature: Feature) -> &'static str {
    match feature {
        Feature::TextToVector => TEXT_TO_VECTOR,
        Feature::ShapeFill => SHAPE_FILL,
        Feature::Pattern => PATTERN,
        Feature::Expand => EXPAND,
        Feature::Recolor => RECOLOR,
        Feature::Rewrite => REWRITE,
    }
}

fn feature_of(id: &str) -> Option<Feature> {
    Feature::ALL.into_iter().find(|f| command_of(*f) == id)
}

/// Where AI Accounts can be found, as error messages name it.
pub const ACCOUNTS_PATH: &str = "Edit › AI Accounts";

/// What the app holds for the AI commands.
pub struct AiUi {
    /// Accounts, running jobs and results waiting to be placed.
    pub genai: GenAi,
    /// The accounts as last read ([`Self::refresh`]): reading a key may touch the disk or the
    /// OS credential store, which the menus, asked every frame, should not.
    status: Vec<AccountStatus>,
    /// AI Accounts while it is open.
    pub(crate) accounts: Option<accounts::Form>,
    /// The Generate window.
    pub(crate) generate: generate::Panel,
    /// The jobs wake the app's context when they end.
    waker_set: bool,
}

impl Default for AiUi {
    /// Keys in memory and settings for this session only: what tests and runs without
    /// preferences get. The desktop app calls [`use_config_dir`].
    fn default() -> Self {
        Self::new(GenAi::new(AiAccounts::in_memory()))
    }
}

impl AiUi {
    pub fn new(genai: GenAi) -> Self {
        let mut ai = Self { genai, status: vec![], accounts: None, generate: generate::Panel::default(), waker_set: false };
        ai.refresh();
        ai
    }

    /// Read the accounts' status again (after a key or a setting changed).
    pub fn refresh(&mut self) {
        self.status = self.genai.accounts.status();
    }

    /// The accounts as last read: provider, connected, the key's last four characters, models.
    pub fn status(&self) -> &[AccountStatus] {
        &self.status
    }

    /// A provider has a key.
    pub fn has_key(&self) -> bool {
        self.status.iter().any(|s| s.connected)
    }

    /// `kind` has a key.
    pub fn connected(&self, kind: ProviderKind) -> bool {
        self.status.iter().any(|s| s.provider == kind && s.connected)
    }

    /// The provider the AI commands use, as AI Accounts chose it.
    pub fn default_provider(&self) -> Option<ProviderKind> {
        self.status.iter().find(|s| s.is_default).map(|s| s.provider)
    }

    /// The person agreed that prompts and artwork go to their provider.
    pub fn consented(&self) -> bool {
        self.genai.accounts.settings.consented
    }

    /// The Generate window is open.
    pub fn generate_open(&self) -> bool {
        self.generate.open
    }

    /// The feature the Generate window shows.
    pub fn generate_feature(&self) -> Feature {
        self.generate.feature
    }

    /// AI Accounts is open.
    pub fn accounts_open(&self) -> bool {
        self.accounts.is_some()
    }

    /// AI Accounts' Test Connection is running.
    pub fn testing(&self) -> bool {
        self.accounts.as_ref().is_some_and(|f| f.test.is_some())
    }
}

/// Keep AI keys and settings in Nib's config folder `dir` (the desktop app, at start-up): keys in
/// the OS credential store, or the 0600 `ai-keys.json` there; settings in `ai.json`.
pub fn use_config_dir(app: &mut VectorcraftApp, dir: &Path) {
    app.ai.genai.jobs.cancel_all();
    app.ai = AiUi::new(GenAi::new(AiAccounts::new(dir)));
}

/// Why the command opening `feature` can't run now, or `None` when the selection suits it. The
/// menus grey the item out and show this as its tooltip; the Generate window disables Generate
/// with it. A key is not needed to open the window: it says how to add one.
pub fn unsuitable(app: &VectorcraftApp, feature: Feature) -> Option<&'static str> {
    let Some(st) = app.session.active() else { return Some(tl!("Open or create a document first.")) };
    let selected: Vec<_> = st.selection.objects.iter().filter_map(|id| st.doc.node(*id)).collect();
    let one = match selected.as_slice() {
        [one] => Some(&one.kind),
        _ => None,
    };
    match feature {
        Feature::TextToVector | Feature::Pattern => None,
        Feature::ShapeFill => match one {
            Some(NodeKind::Path { path, .. }) if !path.subpaths.is_empty() && path.subpaths.iter().all(|sp| sp.closed) => None,
            Some(NodeKind::Compound { .. }) => None,
            Some(NodeKind::Path { .. }) => Some(tl!("The selected path is open. Close it to fill it.")),
            _ => Some(tl!("Select one closed path (a shape) to fill.")),
        },
        Feature::Expand => match one {
            Some(NodeKind::Image(_)) => None,
            _ => Some(tl!("Select one placed image to expand.")),
        },
        Feature::Recolor => {
            (selected.is_empty() || !crate::canvas::has_colors(&st.doc, &st.selection.objects)).then(|| tl!("Select the artwork to recolor."))
        }
        Feature::Rewrite => match one {
            Some(NodeKind::Text(_)) => None,
            _ => Some(tl!("Select one type object to rewrite.")),
        },
    }
}

/// Whether menu item `id` (an `ai.*` command) is enabled; `None` for other commands.
pub fn enabled(app: &VectorcraftApp, id: &str) -> Option<bool> {
    if let Some(f) = feature_of(id) {
        return Some(unsuitable(app, f).is_none());
    }
    Some(match id {
        PANEL | ACCOUNTS => true,
        GENERATE => generate::blocked(app).is_none(),
        CANCEL => app.ai.generate.job.is_some(),
        PLACE => app.ai.generate.result.is_some(),
        _ => return None,
    })
}

/// Why menu item `id` is dimmed, for the AI commands.
pub fn disabled_hint(app: &VectorcraftApp, id: &str) -> Option<&'static str> {
    if let Some(f) = feature_of(id) {
        return unsuitable(app, f);
    }
    match id {
        GENERATE => generate::blocked(app),
        _ => None,
    }
}

/// The checked state of Window › Generate.
pub fn checked(app: &VectorcraftApp, id: &str) -> Option<bool> {
    (id == PANEL).then_some(app.ai.generate.open)
}

/// Run an `ai.*` command; `None` for other commands.
pub fn command(app: &mut VectorcraftApp, id: &str, p: &Value) -> Option<Result<Value, String>> {
    if let Some(feature) = feature_of(id) {
        return Some(open_feature(app, feature, p));
    }
    Some(match id {
        PANEL => {
            let g = &mut app.ai.generate;
            if g.open && g.feature == Feature::TextToVector {
                g.open = false;
            } else {
                generate::show_feature(app, Feature::TextToVector);
            }
            Ok(json!({ "open": app.ai.generate.open }))
        }
        ACCOUNTS => {
            accounts::open(app);
            Ok(Value::Null)
        }
        GENERATE => generate::start(app),
        CANCEL => Ok(json!({ "cancelled": generate::cancel(app) })),
        PLACE => {
            let i = match crate::menus::opt_index(p, "variation") {
                Ok(i) => i.unwrap_or(0),
                Err(e) => return Some(Err(e)),
            };
            generate::place(app, i)
        }
        _ => return None,
    })
}

/// `ai.textToVector` and the other feature commands: show the Generate window on `feature`, with
/// `prompt` when given. Refused (and the window left as it is) when the selection doesn't suit.
fn open_feature(app: &mut VectorcraftApp, feature: Feature, p: &Value) -> Result<Value, String> {
    if let Some(why) = unsuitable(app, feature) {
        return Err(why.to_string());
    }
    generate::show_feature(app, feature);
    if let Some(prompt) = p.get("prompt").and_then(Value::as_str) {
        app.ai.generate.prompt = prompt.chars().take(generate::MAX_PROMPT).collect();
    }
    Ok(json!({ "feature": feature.id() }))
}

/// Take the jobs that ended (once per frame, on the UI thread): a result goes to the Generate
/// window that asked for it, a connection test to AI Accounts; anything else is dropped.
pub fn poll(app: &mut VectorcraftApp) {
    let events = app.ai.genai.poll();
    for e in events {
        handle(app, e);
    }
}

/// Wait up to `timeout` for the Generate window's request to end and take its result, as [`poll`]
/// would (tests, scripts). `false` when nothing is running or it did not end in time.
pub fn wait(app: &mut VectorcraftApp, timeout: std::time::Duration) -> bool {
    let Some(job) = app.ai.generate.job.map(|(j, _)| j).or_else(|| app.ai.accounts.as_ref().and_then(|f| f.test.map(|(_, j)| j))) else {
        return false;
    };
    match app.ai.genai.wait(job, timeout) {
        Some(e) => {
            handle(app, e);
            true
        }
        None => false,
    }
}

fn handle(app: &mut VectorcraftApp, e: JobEvent) {
    let id = e.info.id;
    match e.info.kind {
        JobKind::TestConnection => accounts::tested(app, id, e.result),
        JobKind::Generate(_) => {
            if app.ai.generate.job.is_some_and(|(j, _)| j == id) {
                generate::finished(app, id, e.result);
            } else {
                app.ai.genai.discard(id);
            }
        }
    }
}

/// Draw the AI windows (after the dialogs, so AI Accounts opened from Preferences is on top).
pub fn show(app: &mut VectorcraftApp, ctx: &egui::Context) {
    if !app.ai.waker_set {
        let c = ctx.clone();
        app.ai.genai.jobs.set_waker(move || c.request_repaint());
        app.ai.waker_set = true;
    }
    generate::show(app, ctx);
    accounts::show(app, ctx);
    // The spinner and the elapsed time move while a request runs.
    if app.ai.generate.job.is_some() || app.ai.accounts.as_ref().is_some_and(|f| f.test.is_some()) {
        ctx.request_repaint_after(std::time::Duration::from_millis(250));
    }
}

/// A message for `e` as the windows show it: the provider's words, with the place of AI Accounts
/// in Nib's menus.
pub(crate) fn message(e: &AiError) -> String {
    e.message.replace("AI › AI Accounts", ACCOUNTS_PATH)
}

/// The errors AI Accounts fixes (a key missing or refused, consent not given yet).
pub(crate) fn fixed_in_accounts(e: &AiError) -> bool {
    matches!(e.kind, ErrorKind::MissingKey | ErrorKind::InvalidKey | ErrorKind::NeedsConsent)
}

/// The errors worth trying again as they are.
pub(crate) fn retryable(e: &AiError) -> bool {
    matches!(e.kind, ErrorKind::Network | ErrorKind::Timeout | ErrorKind::Server | ErrorKind::Quota | ErrorKind::BadResponse)
}

/// Add the Contextual Task Bar's AI actions for the selection to `items` (label, icon, command,
/// params): Generate Vectors on a blank canvas, Generative Expand for one image, Generative Shape
/// Fill for one closed shape. Only once a provider has a key, so the bar stays as it was for people
/// who don't use them.
pub(crate) fn task_bar_items<'a>(app: &VectorcraftApp, items: &mut Vec<(&'a str, &'a str, &'a str, Value)>, blank: bool, image: bool, shape: bool) {
    if !app.ai.has_key() {
        return;
    }
    if blank {
        items.push((tl!("Generate Vectors"), "sparkles", TEXT_TO_VECTOR, json!({})));
    }
    if image {
        items.push((tl!("Generative Expand"), "maximize-2", EXPAND, json!({})));
    }
    if shape && unsuitable(app, Feature::ShapeFill).is_none() {
        items.push((tl!("Generative Shape Fill"), "sparkles", SHAPE_FILL, json!({})));
    }
}
